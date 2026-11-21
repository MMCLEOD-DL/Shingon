// Kernel-owned singleton lease: releases even after an abrupt service crash.
// Metadata must be on a local disk, not shared between different hosts/namespaces.
import net from 'node:net';
import { mkdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ServiceError } from './state.js';
const LISTEN_CODES = new Set(['EADDRINUSE', 'EACCES', 'EPERM', 'EADDRNOTAVAIL', 'EMFILE', 'ENFILE', 'EINVAL', 'ENOBUFS', 'ENOMEM']);

// Keep diagnostics useful without forwarding OS messages, addresses or data paths.
export function leaseListenError(error) {
  const listenCode = LISTEN_CODES.has(error?.code) ? error.code : 'UNKNOWN';
  const failure = new ServiceError(409, 'data-in-use',
    `This data directory is already in use, or its local lease port is occupied. Stop the other app or select a separate --data directory. [listen: ${listenCode}]`);
  failure.listenCode = listenCode;
  return failure;
}

export async function acquireLease(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let canonical = realpathSync(dir);
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const port = 20000 + createHash('sha256').update(canonical).digest().readUInt32BE(0) % 30000;
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(leaseListenError(error)));
    server.listen(port, '127.0.0.1', resolve);
  });
  return () => new Promise(resolve => server.close(resolve));
}
