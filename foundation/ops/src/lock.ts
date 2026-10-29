import { open, readFile, rm, stat, utimes } from 'node:fs/promises';
import { hostname } from 'node:os';
import { plainFsError } from './durable.js';

/** A lock file whose holder cannot be read is replaced after this. Generous: an update with a large backup takes hours. */
export const STALE_LOCK_MS = 4 * 3600e3;

/** While an update runs, its lock file's time is refreshed this often, so others without the Docker socket can see it is alive. */
export const HEARTBEAT_MS = 20_000;
/** A lock refreshed within this is held by a running update. */
export const ALIVE_WITHIN_MS = 90_000;

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
  opts: { isAlive?: (h: LockHolder) => Promise<boolean>; maxAgeMs?: number; heartbeatMs?: number } = {},
): { acquire(): Promise<boolean>; release(): Promise<void> } {
  let held = false;
  let beat: NodeJS.Timeout | undefined;
  const maxAge = opts.maxAgeMs ?? STALE_LOCK_MS;
  const stale = async (): Promise<boolean> => {
    const st = await stat(path).catch(() => null);
    if (st === null) return true;   // gone meanwhile
    const old = now().getTime() - st.mtime.getTime() > maxAge;
    let holder: LockHolder | undefined;
    try {
      const h = JSON.parse(await readFile(path, 'utf8')) as Partial<LockHolder>;
      if (typeof h.pid === 'number' && typeof h.host === 'string') holder = { pid: h.pid, host: h.host, at: h.at ?? '' };
    } catch { /* unreadable */ }
    // The age limit applies only when the holder cannot be read (or cannot be checked at all): a readable holder that is
    // still running keeps its lock however long its update takes. Any doubt about the holder keeps the lock.
    if (holder === undefined || opts.isAlive === undefined) return old;
    return !(await opts.isAlive(holder).catch(() => true));
  };
  return {
    async acquire() {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // Readable by the ops daemon (uid 1000): it holds only a process id, a container id and a time.
          const fh = await open(path, 'wx', 0o644);
          try {
            const me: LockHolder = { pid: process.pid, host: hostname(), at: now().toISOString() };
            await fh.writeFile(JSON.stringify(me) + '\n');
          } finally {
            await fh.close();
          }
          held = true;
          // The heartbeat: the monitor and the backup pause read "refreshed lately" as "the update is still running".
          beat = setInterval(() => { const t = now(); void utimes(path, t, t).catch(() => undefined); }, opts.heartbeatMs ?? HEARTBEAT_MS);
          beat.unref();
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
      clearInterval(beat);
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

/**
 * Reads `docker inspect` of a lock holder's container: gone only when Docker says there is no such container (or it exists
 * but has stopped). Any other error or a time-out counts as alive, so the lock is kept.
 */
export function holderFromInspect(r: { code: number; stdout: string; stderr: string; timedOut?: boolean }): boolean {
  if (r.timedOut === true) return true;
  if (r.code === 0) return r.stdout.trim() !== 'false';
  return !/no such (object|container)/i.test(r.stderr);
}

/**
 * Whether an update is running, as seen from a container without the Docker socket (the ops daemon): the update lock exists,
 * names its holder, and was refreshed within ALIVE_WITHIN_MS (the holder's heartbeat). false when there is no lock or it has
 * gone quiet (a crashed updater stops refreshing it); undefined when the lock is there but cannot be read.
 */
export async function updateLockAlive(path: string, now: Date): Promise<boolean | undefined> {
  const st = await stat(path).catch((e: unknown) => ((e as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined));
  if (st === null) return false;
  if (st === undefined) return undefined;
  try {
    const h = JSON.parse(await readFile(path, 'utf8')) as Partial<LockHolder>;
    if (typeof h.pid !== 'number' || typeof h.host !== 'string') return undefined;
  } catch {
    return undefined;
  }
  return now.getTime() - st.mtime.getTime() <= ALIVE_WITHIN_MS;
}
