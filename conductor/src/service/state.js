// Service metadata is separate from the engine's agent-writable working copy.
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class ServiceError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function requireValue(ok, message, code = 'invalid-request', status = 400) {
  if (!ok) throw new ServiceError(status, code, message);
}
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const opaqueId = (v) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v);

export function atomicJson(file, data) {
  const encoded = JSON.stringify(data) + '\n';
  requireValue(Buffer.byteLength(encoded) <= 16 * 1024 * 1024, 'Service metadata reached its size limit. Preserve and archive old state before continuing.', 'storage-limit', 503);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${id()}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, encoded);
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(tmp, file);
    // Windows does not consistently expose directory fsync. File flush + rename
    // is retained; power-loss durability must be validated on the acceptance host.
    if (process.platform !== 'win32') {
      const dir = openSync(path.dirname(file), 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
  }
}

export class StateStore {
  constructor(dir) {
    this.file = path.join(dir, 'service-state.json');
    this.poisoned = false;
    this.data = { schema: 1, repositories: [], runs: [] };
    if (existsSync(this.file)) {
      try {
        const data = JSON.parse(readFileSync(this.file, 'utf8'));
        requireValue(data.schema === 1 && Array.isArray(data.repositories) && Array.isArray(data.runs), 'Invalid state');
        requireValue(data.repositories.every(r => opaqueId(r.id) && typeof r.path === 'string'), 'Invalid repositories');
        requireValue(data.runs.every(r => opaqueId(r.id) && Array.isArray(r.events) && r.events.length <= 5000
          && r.events.every((e, n) => e.seq === n + 1 && e.runId === r.id) && typeof r.status === 'string'
          && data.repositories.some(repo => repo.id === r.repositoryId)), 'Invalid runs');
        this.data = data;
      } catch { throw new Error('Conductor app state cannot be read. Preserve service-state.json and repair or restore it before restarting.'); }
    }
    for (const run of this.data.runs) {
      if (['running', 'awaiting-decision', 'queued', 'cancelling'].includes(run.status)) {
        run.status = 'interrupted'; run.updatedAt = now();
        run.recoveryRequired = Boolean(run.landingPending);
        run.resumable = !run.recoveryRequired && Boolean(run.workspaceDir);
        if (run.decision?.status === 'pending') run.decision.status = 'invalidated';
        run.activeDecisionId = null;
      }
    }
    this.save();
  }
  save() {
    requireValue(!this.poisoned, 'State storage needs recovery; restart after checking the disk.', 'storage-unavailable', 503);
    try { atomicJson(this.file, this.data); }
    catch { this.poisoned = true; throw new ServiceError(503, 'storage-unavailable', 'Run state could not be saved. Work has stopped; check the disk before restarting.'); }
  }
}
