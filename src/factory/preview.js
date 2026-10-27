// src/factory/preview.js — `conductor preview`: one demo copy of a project's app on a factory machine, on the
// operator's own network (index Ruling 12). One preview per project; a preview of a new commit replaces the old one.
// The preview has its own lock (.preview.lock), so it never conflicts with a running build.
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { readProject } from './projects.js';
import { lockProject } from './projectLock.js';
import { writeJsonAtomic } from './fsAtomic.js';
import { latestBuild } from './buildState.js';
import { newRunId, RUN_ID_RE } from './ids.js';
import { getMachineProvider } from './machines/index.js';
import { createSsh } from './ssh.js';
import { bringUpDemo as bringUpDemoFn } from './deploy.js';
import { git } from '../workspace.js';

const PREVIEWABLE = ['running', 'paused', 'failed', 'stopped'];
const recordFile = (projectDir) => path.join(projectDir, 'preview.json');

function resolveDeps(factory, deps) {
  const ssh = deps.ssh ?? createSsh(factory.machines);
  return {
    ssh,
    provider: deps.provider ?? getMachineProvider(factory, { ssh }),
    bringUpDemo: deps.bringUpDemo ?? bringUpDemoFn,
    now: deps.now ?? (() => new Date()),
  };
}

function readRecord(projectDir) {
  const file = recordFile(projectDir);
  if (!existsSync(file)) return null;
  let rec;
  try { rec = JSON.parse(readFileSync(file, 'utf8')); } catch { rec = null; }
  if (!rec || rec.schema !== 1 || typeof rec.runId !== 'string' || !RUN_ID_RE.test(rec.runId)) {
    throw new Error(`The preview record ${file} cannot be read. Check "conductor machines list" for its machine, then remove the file and try again.`);
  }
  return rec;
}

async function tipOf(appDir, branch) {
  const r = await git(appDir, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

// The build in progress (if its branch exists), else main.
async function chooseCommit(projectDir, appDir, slug) {
  const b = latestBuild(projectDir);
  if (b && PREVIEWABLE.includes(b.status) && typeof b.branch === 'string') {
    const sha = await tipOf(appDir, b.branch);
    if (sha) return { sha, from: 'build' };
  }
  const sha = await tipOf(appDir, 'main');
  if (!sha) throw new Error(`The app for ${slug} has no main branch to preview. Run "conductor build ${slug}" first.`);
  return { sha, from: 'main' };
}

// Stops a recorded preview. The caller holds the preview lock.
async function stopRecorded(projectDir, record, provider) {
  const machine = (await provider.list()).find((m) => m.labels?.run === record.runId);
  if (!machine) {
    rmSync(recordFile(projectDir), { force: true });
    return { status: 'gone' };
  }
  await machine.release(); // a throw keeps the record, so the operator can retry
  rmSync(recordFile(projectDir), { force: true });
  return { status: 'stopped' };
}

export async function startPreview({ factory, slug, deps = {} }) {
  const { dir: projectDir, project } = readProject(factory.projectsRoot, slug);
  const appDir = path.join(projectDir, 'app');
  if (!existsSync(appDir)) throw new Error(`There is no app for ${slug} yet. Run "conductor build ${slug}" first.`);
  const d = resolveDeps(factory, deps);
  const release = lockProject(projectDir, 'preview');
  try {
    const { sha, from } = await chooseCommit(projectDir, appDir, slug);
    const record = readRecord(projectDir);
    if (record) {
      if (record.sha === sha) {
        const alive = (await d.provider.list()).some((m) => m.labels?.run === record.runId);
        if (alive) return { status: 'already', url: record.url, seedText: null, sha, from: record.from ?? from };
        rmSync(recordFile(projectDir), { force: true });
      } else {
        await stopRecorded(projectDir, record, d.provider);
      }
    }

    const runId = newRunId(d.now());
    try {
      await d.provider.sweep({ olderThanMs: factory.machines.sweepAfterMs, keep: previewRuns(factory.projectsRoot) });
    } catch (e) {
      d.provider.notes?.push(`Clearing old factory machines failed (${e.message}); carrying on.`);
    }

    const machine = await d.provider.acquire({ purpose: 'preview', projectSlug: slug, runId });
    let up;
    try {
      up = await d.bringUpDemo({ machine, appDir, sha, slug, runId, client: project.client, ssh: d.ssh });
      writeJsonAtomic(recordFile(projectDir), {
        schema: 1, runId, machineId: machine.id, provider: d.provider.kind ?? d.provider.provider, host: machine.host,
        url: up.url, sha, from, startedAt: d.now().toISOString(),
      });
    } catch (err) {
      try { await machine.release(); } catch (re) { err.message = `${err.message} Releasing the machine also failed: ${re.message}`; }
      throw err;
    }
    return { status: 'started', url: up.url, seedText: up.seedText, sha, from };
  } finally {
    release();
  }
}

export async function stopPreview({ factory, slug, deps = {} }) {
  const { dir: projectDir } = readProject(factory.projectsRoot, slug);
  const release = lockProject(projectDir, 'preview');
  try {
    const record = readRecord(projectDir);
    if (!record) return { status: 'none' };
    return await stopRecorded(projectDir, record, resolveDeps(factory, deps).provider);
  } finally {
    release();
  }
}

// The run ids of every project's live preview record: what a sweep must spare.
export function previewRuns(projectsRoot) {
  let names;
  try { names = readdirSync(projectsRoot); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    try {
      const rec = JSON.parse(readFileSync(path.join(projectsRoot, name, 'preview.json'), 'utf8'));
      if (typeof rec?.runId === 'string' && RUN_ID_RE.test(rec.runId)) out.push(rec.runId);
    } catch { /* no record */ }
  }
  return out;
}
