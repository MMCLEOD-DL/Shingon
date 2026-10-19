// src/cli/runs.js
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { defaultBaseDir } from '../workspace.js';

const UNFINISHED = new Set(['running', 'failed', 'paused']);
const META = '.conductor';

export function listRuns({ baseDir = defaultBaseDir(), repoDir = null } = {}) {
  let names;
  try {
    names = readdirSync(baseDir);
  } catch {
    return [];
  }
  const want = repoDir ? path.resolve(repoDir) : null;
  const runs = [];
  for (const name of names) {
    if (!name.endsWith(META)) continue;
    const statePath = path.join(baseDir, name, 'state.json');
    let s;
    let mtime;
    try {
      s = JSON.parse(readFileSync(statePath, 'utf8'));
      mtime = statSync(statePath).mtimeMs;
    } catch {
      continue;
    }
    if (!s || !UNFINISHED.has(s.status) || (want && s.repoDir !== want)) continue;
    const workspaceDir = path.join(baseDir, name.slice(0, -META.length));
    if (!existsSync(workspaceDir)) continue;
    runs.push({
      workspaceDir, request: s.request ?? '', status: s.status, phase: s.phase ?? null,
      done: Array.isArray(s.chunkShas) ? s.chunkShas.length : 0, total: s.plan?.chunks?.length ?? null,
      updatedAt: mtime, reason: s.reason ?? null,
    });
  }
  return runs.sort((a, b) => b.updatedAt - a.updatedAt);
}
