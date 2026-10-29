#!/usr/bin/env node
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { probeParticipant } from '../src/service/probe.js';
import { createAppServer } from '../src/service/server.js';

try {
  const { values } = parseArgs({ options: { config: { type: 'string' }, data: { type: 'string' }, port: { type: 'string' } }, strict: true });
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const dataDir = path.resolve(values.data ?? path.join(process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'conductor', 'operator-app'));
  const configFile = path.resolve(values.config ?? path.join(homedir(), '.config', 'conductor', 'config.json'));
  const app = await createAppServer({ dataDir, configFile, port: Number(values.port ?? 4318), uiDir: path.join(root, 'operator-web', 'dist'), probe: probeParticipant });
  // Fragment is not sent in HTTP requests or Referer headers. The UI exchanges it
  // once via POST /session and immediately removes it from browser history.
  process.stdout.write(`Conductor local app: ${app.origin}/#bootstrap=${app.bootstrapToken}\nThis sign-in link expires in five minutes. Keep it private.\n`);
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; await app.close(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch (e) {
  process.stderr.write(`Conductor app could not start: ${e.code === 'EADDRINUSE' ? 'the port is in use; choose --port or stop the earlier app.' : 'check the configuration, port and writable data directory.'}\n`);
  process.exitCode = 1;
}
