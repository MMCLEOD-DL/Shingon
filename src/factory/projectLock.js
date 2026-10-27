// src/factory/projectLock.js — one job per project (Contract 7 §7.1, §7.11).
// brief, build and change share .conductor.lock; a preview has its own .preview.lock.
// Only CLI handlers take the shared lock; library entry points run under their caller's lock.
import { openSync, writeSync, closeSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const LOCK_KINDS = ['brief', 'build', 'change', 'preview'];

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Ruling P8: this formats its own date; the shared ukDate helper arrives in Task 4.
function whenText(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return 'an unknown time';
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  return `${date} ${time} UTC`;
}

function readHolder(lock) {
  try {
    const h = JSON.parse(readFileSync(lock, 'utf8'));
    return h && typeof h === 'object' ? h : null;
  } catch { return null; } // unreadable counts as dead
}

export function lockProject(projectDir, kind, { pid = process.pid, isAlive = pidAlive, now = () => new Date() } = {}) {
  if (!LOCK_KINDS.includes(kind)) throw new Error('lockProject: kind must be brief, build, change or preview');
  const lock = path.join(projectDir, kind === 'preview' ? '.preview.lock' : '.conductor.lock');
  const body = JSON.stringify({ pid, kind, at: now().toISOString() });
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try { writeSync(fd, body); } finally { closeSync(fd); }
      break;
    } catch (err) {
      if (err.code !== 'EEXIST' || attempt > 0) throw err;
      const holder = readHolder(lock);
      if (holder && isAlive(holder.pid)) {
        throw new Error(`This project is busy: a ${holder.kind} is running (pid ${holder.pid}, since ${whenText(holder.at)}). Wait for it to finish or stop it, then try again.`);
      }
      rmSync(lock, { force: true });
    }
  }
  return function release() {
    try {
      if (readHolder(lock)?.pid === pid) rmSync(lock, { force: true });
    } catch { /* never throws */ }
  };
}
