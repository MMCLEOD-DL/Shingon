// src/council/councilWorkspace.js
// A project round runs outside `drive`, in its own throwaway workspace (a real
// Workspace, so callAgent's guardGitDir protects it), and keeps its round state
// in <buildDir>/council/state.json.
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Workspace, git, defaultBaseDir, metaDirOf } from '../workspace.js';
import { RunLog } from '../runlog.js';

const HEX = /^[0-9a-f]{4,64}$/i;
const SAFE_REF = /^[A-Za-z0-9._\/-]+$/;
const SAFE_RUN = /^[A-Za-z0-9._-]+$/;

async function ok(cwd, args, what) {
  const r = await git(cwd, args, { timeoutMs: 300000 });
  if (r.code !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return r.stdout.trim();
}

const hasCommit = async (cwd, rev) => (await git(cwd, ['cat-file', '-e', `${rev}^{commit}`])).code === 0;

export async function openCouncilWorkspace({ appDir, sha, foundation, runId, baseDir }) {
  if (!HEX.test(String(sha ?? ''))) throw new Error('The council needs a build commit to review.');
  if (!SAFE_RUN.test(String(runId ?? ''))) throw new Error('The council was given an unusable run id.');
  const root = baseDir ?? defaultBaseDir();
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'conductor-council-'));
  const remove = () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    try { rmSync(metaDirOf(dir), { recursive: true, force: true }); } catch {}
  };
  try {
    await ok(dir, ['clone', '--quiet', '--no-hardlinks', path.resolve(appDir), '.'], 'clone failed');
    const branch = `conductor-council/${runId}`;
    await ok(dir, ['checkout', '-q', '-b', branch, sha], 'checkout failed');
    await ok(dir, ['remote', 'remove', 'origin'], 'remote remove failed');

    let baseSha = null;
    let problem = null;
    const commit = foundation?.commit;
    const tag = foundation?.tag;
    if (typeof commit === 'string' && HEX.test(commit) && await hasCommit(dir, commit)) {
      baseSha = (await ok(dir, ['rev-parse', `${commit}^{commit}`], 'rev-parse failed'));
    }
    if (!baseSha && typeof tag === 'string' && SAFE_REF.test(tag) && !tag.startsWith('-')) {
      // an app repo keeps its foundation release under refs/foundation/<tag>; a clone does not copy it
      const r = await git(appDir, ['rev-parse', '--verify', '--quiet', `refs/foundation/${tag}^{commit}`]);
      const found = r.code === 0 ? r.stdout.trim() : '';
      if (HEX.test(found) && await hasCommit(dir, found)) baseSha = found;
    }
    if (!baseSha) {
      const r = await git(dir, ['merge-base', sha, 'main']);
      const mb = r.code === 0 ? r.stdout.trim() : '';
      if (!HEX.test(mb)) throw new Error('The council could not find where this build started.');
      baseSha = mb;
      problem = `Conductor could not find foundation release ${tag}, so the council reviewed only this build's own changes`;
    }
    const ws = new Workspace(dir, branch, baseSha);
    mkdirSync(ws.metaDir, { recursive: true });
    ws.sealConfig();
    return { ws, baseSha, problem, remove };
  } catch (e) {
    remove();
    throw e;
  }
}

const freshState = () => ({
  version: 1, request: null, plan: null, notes: [], warnings: [],
  council: { round: 0, fixRounds: 0, secretSeen: false, history: [] },
});

export function openCouncilLog(buildDir, { onEvent } = {}) {
  const log = new RunLog(path.join(buildDir, 'council'), { onEvent });
  let state = null;
  let reset = false;
  if (existsSync(log.statePath)) {
    try {
      const s = JSON.parse(readFileSync(log.statePath, 'utf8'));
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('not an object');
      state = s;
    } catch {
      reset = true;
    }
  }
  if (!state) state = freshState();
  state.council ??= freshState().council;
  if (reset) log.event('council-state-reset', {});
  return { log, state };
}
