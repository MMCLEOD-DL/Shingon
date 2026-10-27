// src/factory/fsAtomic.js — crash-safe file writes for everything under a project folder (Contract 1).
import { openSync, writeSync, fsyncSync, closeSync, renameSync, chmodSync, rmSync, linkSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

function tempName(file) {
  return `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

// Some filesystems refuse to fsync a folder; that is not worth failing a write for.
function fsyncDir(dir) {
  try {
    const fd = openSync(dir, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* best effort */ }
}

function writeTemp(tmp, data, mode) {
  const fd = openSync(tmp, 'wx', mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, mode); // the umask must not widen (or narrow) the mode
}

export function writeFileAtomic(file, data, { mode = 0o600 } = {}) {
  const tmp = tempName(file);
  try {
    writeTemp(tmp, data, mode);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  fsyncDir(path.dirname(file));
}

export function writeJsonAtomic(file, obj, opts) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n', opts);
}

// Creates `file` only if it does not exist; throws EEXIST otherwise (linkSync is atomic).
export function createFileExclusive(file, data, { mode = 0o600 } = {}) {
  const tmp = tempName(file);
  try {
    writeTemp(tmp, data, mode);
    linkSync(tmp, file);
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
  fsyncDir(path.dirname(file));
}
