import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface Storage {
  put(key: string, data: Readable): Promise<{ size: number; sha256: string }>;
  get(key: string): Readable;
  delete(key: string): Promise<void>;
  check(): Promise<void>;
  /** Every stored object (`tmp: false`) and leftover partial upload (`tmp: true`). `key` is what `delete` takes. */
  list(): AsyncIterable<{ key: string; mtime: Date; tmp: boolean }>;
}

const KEY_SHAPE = /^[a-f0-9]{6,64}$/;
const TMP_SHAPE = /^[a-f0-9]{6,64}\.[a-f0-9]{12}\.tmp$/;
const SHARD_SHAPE = /^[a-f0-9]{2}$/;

/** Files on a private folder, sharded by the first two characters of the key. Keys are never built from user input. */
export class LocalDiskStorage implements Storage {
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    if (typeof key !== 'string' || (!KEY_SHAPE.test(key) && !TMP_SHAPE.test(key))) throw new Error('invalid storage key');
    return path.join(this.root, key.slice(0, 2), key);
  }

  async put(key: string, data: Readable): Promise<{ size: number; sha256: string }> {
    const target = this.pathFor(key);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) { size += chunk.length; hash.update(chunk); cb(null, chunk); },
    });
    try {
      await pipeline(data, meter, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      await rename(tmp, target);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
    return { size, sha256: hash.digest('hex') };
  }

  get(key: string): Readable {
    return createReadStream(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }

  /** Only shard folders and plain files with the expected names are yielded; symlinks are never followed and nothing outside the root is read. */
  async *list(): AsyncGenerator<{ key: string; mtime: Date; tmp: boolean }> {
    let shards;
    try { shards = await readdir(this.root, { withFileTypes: true }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    for (const shard of shards) {
      if (!shard.isDirectory() || !SHARD_SHAPE.test(shard.name)) continue;
      for (const f of await readdir(path.join(this.root, shard.name), { withFileTypes: true })) {
        const tmp = TMP_SHAPE.test(f.name);
        if (!f.isFile() || !(tmp || KEY_SHAPE.test(f.name)) || !f.name.startsWith(shard.name)) continue;
        const st = await lstat(path.join(this.root, shard.name, f.name));
        if (st.isFile()) yield { key: f.name, mtime: st.mtime, tmp };
      }
    }
  }

  async check(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const probe = path.join(this.root, `.probe-${randomBytes(6).toString('hex')}`);
    await writeFile(probe, 'ok');
    await unlink(probe);
  }
}
