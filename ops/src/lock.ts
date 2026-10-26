import { open, rm, stat } from 'node:fs/promises';

/** A lock file older than this is left over from an update that crashed or was killed, and is replaced. */
export const STALE_LOCK_MS = 3600e3;

/**
 * The update lock: /state/update.lock, created with O_EXCL so only one update runs at a time. A lock older than an hour is
 * treated as stale and replaced. `release` removes the file only if this lock created it.
 */
export function fileLock(path: string, now: () => Date = () => new Date()): { acquire(): Promise<boolean>; release(): Promise<void> } {
  let held = false;
  return {
    async acquire() {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const fh = await open(path, 'wx', 0o600);
          try {
            await fh.writeFile(`Update started at ${now().toISOString()} (process ${String(process.pid)}).\n`);
          } finally {
            await fh.close();
          }
          held = true;
          return true;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error(`The update lock (${path}) could not be taken: ${(e as NodeJS.ErrnoException).code ?? 'unknown problem'}.`);
          const st = await stat(path).catch(() => null);
          if (st !== null && now().getTime() - st.mtime.getTime() <= STALE_LOCK_MS) return false;
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
