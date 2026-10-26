import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

/** A file-system error code in plain English, for messages the operator reads (never a bare code such as EACCES). */
export function plainFsError(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case 'EACCES':
    case 'EPERM': return 'permission was refused';
    case 'ENOENT': return 'the file or folder does not exist';
    case 'ENOSPC': return 'the disk is full';
    case 'EDQUOT': return 'the disk quota is used up';
    case 'EROFS': return 'the disk is read-only';
    case 'EEXIST': return 'a file of that name is already there';
    case 'EISDIR': return 'a folder is in the way';
    case 'EIO': return 'the disk reported a read or write error';
    default: return 'an unexpected file-system problem';
  }
}

/** The file-system calls a durable write makes, so tests can check their order. */
export interface DurableFs {
  open(p: string, flags: string, mode?: number): Promise<{ writeFile(data: string): Promise<void>; sync(): Promise<void>; close(): Promise<void> }>;
  chmod(p: string, mode: number): Promise<void>;
  chown(p: string, uid: number, gid: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(p: string): Promise<void>;
}

export const realFs: DurableFs = {
  open: (p, flags, mode) => fsp.open(p, flags, mode),
  chmod: (p, mode) => fsp.chmod(p, mode),
  chown: (p, uid, gid) => fsp.chown(p, uid, gid),
  rename: (a, b) => fsp.rename(a, b),
  rm: (p) => fsp.rm(p, { force: true }),
};

/**
 * Replaces `file` so that a crash or power cut leaves either the old or the new content, never a mix or nothing: a temp file
 * in the same folder is written and flushed to disk, renamed over the file, and then the folder itself is flushed so the
 * rename survives. `owner` is applied when given (the root updater keeps .env's owner; the update record goes to uid 1000).
 */
export async function durableWrite(file: string, data: string, opts: { mode: number; owner?: { uid: number; gid: number } }, fs: DurableFs = realFs): Promise<void> {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file).replace(/^\./, '')}.tmp-${randomBytes(4).toString('hex')}`);
  try {
    const fh = await fs.open(tmp, 'wx', opts.mode);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.chmod(tmp, opts.mode);
    if (opts.owner !== undefined) await fs.chown(tmp, opts.owner.uid, opts.owner.gid).catch(() => undefined);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp).catch(() => undefined);
    throw e;
  }
  const d = await fs.open(dir, 'r');
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
