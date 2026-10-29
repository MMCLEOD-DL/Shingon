// src/workerMemory.js
// Which participants served calls in earlier runs (factory spec §4.2), so readiness checks them first.
// A convenience only: a missing, corrupt or unwritable file never stops or breaks a run.
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const empty = () => ({ version: 1, workers: {} });
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
// A JSON key "__proto__" would set the prototype of a plain object: never store it.
const usableName = (n) => typeof n === 'string' && n !== '' && n !== '__proto__';

export function memoryFileFor(baseDir) {
  return path.join(baseDir, '.workers.json');
}

export function readWorkerMemory(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return empty();
  }
  if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.workers)) return empty();
  const out = empty();
  for (const [name, w] of Object.entries(parsed.workers)) {
    if (!usableName(name) || !isObject(w) || !Number.isFinite(w.lastUsedAt)) continue;
    out.workers[name] = {
      kind: typeof w.kind === 'string' ? w.kind : '',
      lastUsedAt: w.lastUsedAt,
      runs: Number.isInteger(w.runs) && w.runs > 0 ? w.runs : 1,
    };
  }
  return out;
}

export function rememberWorkers(file, used, { now = Date.now } = {}) {
  if (!Array.isArray(used) || used.length === 0) return true;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const memory = readWorkerMemory(file);
    const at = now();
    const seen = new Set();
    for (const u of used) {
      if (!usableName(u?.name) || seen.has(u.name)) continue;
      seen.add(u.name);
      const prev = memory.workers[u.name];
      memory.workers[u.name] = { kind: String(u.kind ?? prev?.kind ?? ''), lastUsedAt: at, runs: (prev?.runs ?? 0) + 1 };
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(memory, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch {}
    return false;
  }
}

// Configured participants only (Review Focus 3), the most recently used first.
export function recallWorkers(memory, participants) {
  const byName = new Map(participants.map((p) => [p.name, p]));
  return Object.entries(memory?.workers ?? {})
    .filter(([name]) => byName.has(name))
    .map(([name, w]) => ({ participant: byName.get(name), lastUsedAt: w.lastUsedAt }))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

// Collects, from the run's events, who really served a successful call (a Seat's servedBy).
export function createUsageTracker(byName) {
  const names = [];
  return {
    onEvent(e) {
      if (e?.type !== 'result' || e.ok !== true) return;
      const name = e.servedBy ?? e.participant;
      if (byName.has(name) && !names.includes(name)) names.push(name);
    },
    used: () => names.map((name) => ({ name, kind: byName.get(name).adapter.kind })),
  };
}
