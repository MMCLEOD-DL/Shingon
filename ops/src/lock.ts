import { open, readFile, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { plainFsError } from './durable.js';

/** A lock file older than this is replaced even if its holder cannot be checked. Generous: an update with a large backup takes hours. */
export const STALE_LOCK_MS = 4 * 3600e3;

/** Who holds a lock, as written into the lock file. */
export interface LockHolder { pid: number; host: string; at: string }

/**
 * The update lock: /state/update.lock, created with O_EXCL so only one update runs at a time. The file names its holder
 * (process and host, which in a container is the container's id). A lock is taken over only when `isAlive` says that holder
 * is gone, or when it is older than STALE_LOCK_MS. `release` removes the file only if this lock created it.
 */
export function fileLock(
  path: string,
  now: () => Date = () => new Date(),
  opts: { isAlive?: (h: LockHolder) => Promise<boolean>; maxAgeMs?: number } = {},
): { acquire(): Promise<boolean>; release(): Promise<void> } {
  let held = false;
  const maxAge = opts.maxAgeMs ?? STALE_LOCK_MS;
  const stale = async (): Promise<boolean> => {
    const st = await stat(path).catch(() => null);
    if (st === null) return true;   // gone meanwhile
    if (now().getTime() - st.mtime.getTime() > maxAge) return true;
    if (opts.isAlive === undefined) return false;
    let holder: LockHolder | undefined;
    try {
      const h = JSON.parse(await readFile(path, 'utf8')) as Partial<LockHolder>;
      if (typeof h.pid === 'number' && typeof h.host === 'string') holder = { pid: h.pid, host: h.host, at: h.at ?? '' };
    } catch { /* unreadable: cannot prove the holder is gone */ }
    return holder !== undefined && !(await opts.isAlive(holder).catch(() => true));
  };
  return {
    async acquire() {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const fh = await open(path, 'wx', 0o600);
          try {
            const me: LockHolder = { pid: process.pid, host: hostname(), at: now().toISOString() };
            await fh.writeFile(JSON.stringify(me) + '\n');
          } finally {
            await fh.close();
          }
          held = true;
          return true;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error(`The update lock (${path}) could not be taken: ${plainFsError(e)}.`);
          if (!(await stale())) return false;
          await rm(path, { force: true });
        }
      }
      return false;
    },
    async release() {
      if (!held) return;
      held = false;
      await rm(path, { force: true });
    },
  };
}

/** Whether a process on this host is still running (signal 0 checks without touching it). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
