import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, lstatSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

function directory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) {
    throw new Error('Private Codex home must be a real directory');
  }
}

// An OS-owned listening handle is the lease: process exit releases it, including
// crashes. No stale PID file can strand a restarted worker or be reclaimed twice.
async function acquireLease(key) {
  const address = process.platform === 'win32'
    ? `\\\\.\\pipe\\conductor-codex-${key}`
    : process.platform === 'linux'
      ? `\0conductor-codex-${key}`
      // Other hosts use an OS-owned loopback port rather than a filesystem socket
      // that could remain after a crash. A hash collision fails closed as busy.
      : { host: '127.0.0.1', port: 49152 + (parseInt(key.slice(0, 8), 16) % 16384), exclusive: true };
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new Error('Private local Codex home is busy or unavailable; retry after the other call finishes')));
    server.listen(address, resolve);
  });
  server.unref();
  return () => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
}

export async function openPrivateCodexHome({ base, config, identity, reuse = false, cwd }) {
  const key = createHash('sha256').update(JSON.stringify([path.resolve(base), config, identity])).digest('hex');
  const homePath = path.join(base, `local-${key}`);
  if (cwd) {
    const relative = path.relative(path.resolve(cwd), homePath);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Private Codex home must be outside the agent workspace');
    }
  }
  directory(base);
  let home;
  let release = async () => {};
  try {
    if (reuse) {
      release = await acquireLease(key);
      home = homePath;
      directory(home);
    } else {
      home = mkdtempSync(path.join(base, 'home-'));
    }
    const configFile = path.join(home, 'config.toml');
    // Do not follow a planted link when refreshing this generated file.
    try {
      const stat = lstatSync(configFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error('Private Codex config must be a regular unlinked file');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    writeFileSync(configFile, config, { mode: 0o600 });
    return { home, close: async () => {
      try { if (!reuse) rmSync(home, { recursive: true, force: true }); }
      finally { await release(); }
    } };
  } catch (err) {
    try { if (home && !reuse) rmSync(home, { recursive: true, force: true }); }
    finally { await release(); }
    throw err;
  }
}
