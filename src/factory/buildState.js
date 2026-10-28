// src/factory/buildState.js — a build's saved state and the crash-safe squash-merge of a landed feature.
// The project lock is NOT taken here: the build/resume CLI handlers hold it (Contract 7 section 7.1).
import { readFileSync, readdirSync, mkdirSync, appendFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { writeJsonAtomic } from './fsAtomic.js';
import { git as gitFn, metaDirOf } from '../workspace.js';
import { redact } from '../secrets.js';

export const buildDirOf = (projectDir, runId) => path.join(projectDir, 'builds', runId);
const buildFile = (buildDir) => path.join(buildDir, 'build.json');

export function newBuild({ runId, slug, client, briefHash, briefVersion, foundation, now = new Date(), kind = 'build' }) {
  return {
    schema: 1, kind, runId, slug, client, startedAt: now.toISOString(), briefHash, briefVersion, foundation,
    branch: `build/${runId}`, baseSha: null, phase: 'setup', status: 'running',
    units: [], features: [], fixRounds: 0, councilFixRounds: 0, secretSeen: false, squashedSha: null,
    usage: { costUsd: 0, apiCostUsd: 0, apiCalls: 0 },
    checks: null, council: null, notes: [], warnings: [], reason: null,
  };
}

export function saveBuild(buildDir, build) {
  mkdirSync(buildDir, { recursive: true });
  writeJsonAtomic(buildFile(buildDir), redact(build));
}

export function loadBuild(buildDir) {
  const file = buildFile(buildDir);
  if (!existsSync(file)) return null;
  const runId = path.basename(buildDir);
  const fail = (why) => new Error(`The saved state of build ${runId} cannot be read (${why}). It is kept in ${file}; start a new build with "conductor build <slug> --new".`);
  let build;
  try { build = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { throw fail(err.message); }
  if (!build || typeof build !== 'object' || build.schema !== 1) throw fail('unknown format');
  return build;
}

// Run ids sort by time, so the greatest id is the newest. Unreadable or non-build records are skipped.
export function latestBuild(projectDir) {
  let names;
  try { names = readdirSync(path.join(projectDir, 'builds')).sort().reverse(); } catch { return null; }
  for (const n of names) {
    try {
      const b = loadBuild(buildDirOf(projectDir, n));
      if (b && b.kind !== 'change') return b;
    } catch { /* skip */ }
  }
  return null;
}

export function appendBuildLog(buildDir, type, data = {}) {
  mkdirSync(buildDir, { recursive: true });
  appendFileSync(path.join(buildDir, 'build-log.jsonl'), JSON.stringify(redact({ at: new Date().toISOString(), type, ...data })) + '\n');
}

const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
};
export const hashBrief = (brief) => createHash('sha256').update(JSON.stringify(sortKeys(brief))).digest('hex');

// Puts a landed feature on the build branch as ONE commit. Safe to call again after a crash at any point:
//  - crash before the branch moved: nothing happened, the call does it all;
//  - crash after the branch moved (checkout stale, feature branch maybe still there): the call finishes
//    the checkout and the cleanup and returns the same commit, never a second one.
export async function mergeFeature({ appDir, buildBranch, landedBranch, landedSha, expectedBase, message, git = gitFn }) {
  const rev = async (ref) => {
    const r = await git(appDir, ['rev-parse', '--verify', '--quiet', ref]);
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const must = async (args, what) => {
    const r = await git(appDir, args);
    if (r.code !== 0) throw new Error(`${what} failed: ${(r.stderr || '').trim() || `exit ${r.code}`}. Nothing more was changed.`);
    return r.stdout.trim();
  };
  const mustCheckout = async (sha) => {
    const r = await git(appDir, ['reset', '-q', '--hard', sha]);
    if (r.code !== 0) throw new Error(`The build branch ${buildBranch} was updated but the app folder was not (${(r.stderr || '').trim() || `exit ${r.code}`}). Run "conductor build" with the project's short name to finish.`);
  };
  const onBuildBranch = async () => (await git(appDir, ['symbolic-ref', '-q', 'HEAD'])).stdout.trim() === `refs/heads/${buildBranch}`;
  const dropLanded = async () => { if (await rev(`refs/heads/${landedBranch}`) === landedSha) await git(appDir, ['update-ref', '-d', `refs/heads/${landedBranch}`, landedSha]); };

  const head = await rev(`refs/heads/${buildBranch}`);
  if (head !== expectedBase) {
    const parent = head ? await rev(`${head}^`) : null;
    const done = parent === expectedBase && await rev(`${head}^{tree}`) === await rev(`${landedSha}^{tree}`);
    if (!done) throw new Error(`The build branch ${buildBranch} is not where Conductor left it, so it stopped rather than guess. Nothing was changed.`);
    // Already merged. If the crash came before the checkout followed, the app folder still matches the old base.
    // Only then, and only with no untracked files (reset --hard would overwrite one at a path the feature adds), is it safe to update it;
    // otherwise it stays stale and the next merge stops on "changes Conductor did not make".
    if (await onBuildBranch() && (await git(appDir, ['diff', '--quiet', expectedBase])).code === 0
        && !(await git(appDir, ['ls-files', '--others', '--exclude-standard'])).stdout.trim()) await mustCheckout(head);
    await dropLanded();
    return head;
  }

  const based = await git(appDir, ['merge-base', '--is-ancestor', expectedBase, landedSha]);
  if (based.code !== 0 || await rev(`refs/heads/${landedBranch}`) !== landedSha) {
    throw new Error('The finished feature is not based on the build branch, so it was not added. Nothing was changed.');
  }
  const status = await git(appDir, ['status', '--porcelain']);
  if (status.code !== 0 || status.stdout.trim()) throw new Error('The app folder has changes Conductor did not make, so it stopped. Nothing was changed.');

  const next = await must(['commit-tree', `${landedSha}^{tree}`, '-p', expectedBase, '-m', message], 'Writing the feature commit');
  await must(['update-ref', `refs/heads/${buildBranch}`, next, expectedBase], 'Moving the build branch');
  if (await onBuildBranch()) await mustCheckout(next);
  await dropLanded();
  return next;
}

export function readRunState(workspaceDir) {
  try { return JSON.parse(readFileSync(path.join(metaDirOf(workspaceDir), 'state.json'), 'utf8')); } catch { return null; }
}

export function archiveFeatureRun({ workspaceDir, buildDir, index, id }) {
  const transcript = path.join(metaDirOf(workspaceDir), 'transcript.jsonl');
  let kept = null;
  if (existsSync(transcript)) {
    const dir = path.join(buildDir, 'features');
    mkdirSync(dir, { recursive: true });
    const nn = String(index + 1).padStart(2, '0');
    let target = path.join(dir, `${nn}-${id}.jsonl`);
    for (let n = 2; existsSync(target); n++) target = path.join(dir, `${nn}-${id}-${n}.jsonl`);
    copyFileSync(transcript, target);
    kept = target;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(metaDirOf(workspaceDir), { recursive: true, force: true });
  return kept;
}
