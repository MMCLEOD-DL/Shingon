#!/usr/bin/env node
// Offline preparation for a later operator-run, supported Codex login.
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

async function main() {
  const { values } = parseArgs({ options: {
    config: {type: 'string', default: path.join(homedir(), '.config', 'conductor', 'config.json')},
    participant: {type: 'string', default: 'codex'},
  }});
  const { byName } = loadConfig(values.config);
  const participant = byName.get(values.participant);
  if (participant?.adapter.kind !== 'codex') {
    throw new Error('A configured frontier Codex participant is required');
  }
  const adapter = participant.adapter;
  const home = await adapter.prepareHome({cwd: process.cwd()});
  // No credentials, raw configuration or authentication diagnostics in output.
  console.log(JSON.stringify({home, bin: adapter.bin}));
}

main().catch(() => {
  console.error('Could not prepare the frontier Codex home. Check --config, --participant, settings-folder access and other active calls.');
  process.exitCode = 2;
});
