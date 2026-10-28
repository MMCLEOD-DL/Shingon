// src/factory/change/run.js — the change run's saved state: <project>/builds/<runId>/change.json (Contract 7 §7.5).
// Run ids are Plan 8's newRunId(); the run's kind lives in the record, not in the id. The project lock is taken by
// the CLI handler (lockProject(projectDir, 'change')), never here.
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, createFileExclusive } from '../fsAtomic.js';
import { newRunId, RUN_ID_RE } from '../ids.js';

export const STAGES = Object.freeze(['brief', 'prepare', 'build', 'approved', 'merged', 'released', 'shipping', 'done']);
export const RUN_KINDS = Object.freeze(['change', 'foundation-upgrade']);
export const RUN_STATUSES = Object.freeze(['running', 'paused', 'failed', 'stopped', 'done']);
const UNFINISHED = ['running', 'paused', 'failed'];
const MAX_ID_TRIES = 5;

export const RUN_UNREADABLE = (runId) => `The record of change ${runId} could not be read, so Conductor stopped rather than guess where it was. Nothing was changed.`;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const changeFile = (projectDir, runId) => path.join(projectDir, 'builds', runId, 'change.json');

export function createChangeRun(projectDir, fields, { now = new Date(), newId = newRunId } = {}) {
  const f = isObj(fields) ? fields : {};
  if (!RUN_KINDS.includes(f.kind)) throw new Error('Conductor could not start the change: the kind of change is missing. Nothing was changed.');
  for (const k of ['slug', 'mainAtStart', 'baseRef']) {
    if (typeof f[k] !== 'string' || f[k] === '') throw new Error(`Conductor could not start the change: ${k} is missing. Nothing was changed.`);
  }
  const at = now.toISOString();
  for (let attempt = 0; attempt < MAX_ID_TRIES; attempt++) {
    const runId = newId(now);
    if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) continue;
    const run = {
      ...f, schema: 1, runId, stage: f.kind === 'change' ? 'brief' : 'prepare', status: 'running', createdAt: at, updatedAt: at,
    };
    mkdirSync(path.join(projectDir, 'builds', runId), { recursive: true });
    try {
      createFileExclusive(changeFile(projectDir, runId), `${JSON.stringify(run, null, 2)}\n`);
      return run;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Conductor could not find a free name for this change after several tries, so it stopped. Nothing was changed. Try again in a moment.');
}

export function loadChangeRun(projectDir, runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new Error(RUN_UNREADABLE(String(runId).slice(0, 60)));
  let run;
  try {
    run = JSON.parse(readFileSync(changeFile(projectDir, runId), 'utf8'));
  } catch {
    throw new Error(RUN_UNREADABLE(runId));
  }
  if (!isObj(run) || run.schema !== 1 || run.runId !== runId || !RUN_KINDS.includes(run.kind)
    || !STAGES.includes(run.stage) || !RUN_STATUSES.includes(run.status)) throw new Error(RUN_UNREADABLE(runId));
  return run;
}

export function saveChangeRun(projectDir, run, { now = new Date() } = {}) {
  run.updatedAt = now.toISOString();
  writeJsonAtomic(changeFile(projectDir, run.runId), run);
}

// The newest change run that is still running, paused or failed. Plan 8 build folders (no change.json) are skipped.
export function findUnfinishedRun(projectDir) {
  let names;
  try { names = readdirSync(path.join(projectDir, 'builds')); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let newest = null;
  for (const name of names.filter((n) => RUN_ID_RE.test(n)).sort()) {
    if (!existsSync(changeFile(projectDir, name))) continue;
    const run = loadChangeRun(projectDir, name);
    if (!UNFINISHED.includes(run.status)) continue;
    if (newest === null || run.createdAt >= newest.createdAt) newest = run;
  }
  return newest;
}
