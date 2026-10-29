#!/usr/bin/env node
// bin/conductor-probe.js
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';

function parse() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: 'config.json' },
      participant: { type: 'string' },
      role: { type: 'string' },
      task: { type: 'string' },
      'task-file': { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  return values;
}

async function main() {
  const v = parse();
  if (!v.participant || !v.role || (!v.task && !v['task-file'])) {
    console.error('usage: conductor-probe --config <p> --participant <name> --role <role> --task "<text>" | --task-file <path> [--json]');
    process.exit(2);
  }
  const task = v['task-file'] ? readFileSync(v['task-file'], 'utf8') : v.task;

  const { byName } = loadConfig(v.config);
  const p = byName.get(v.participant);
  if (!p) {
    console.error(`no participant named "${v.participant}" in ${v.config}`);
    process.exit(2);
  }

  const result = await p.run(v.role, task);

  if (v.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`participant : ${p.name} (${p.adapter.kind})`);
    console.log(`role        : ${v.role}`);
    console.log(`ok          : ${result.ok}`);
    if (result.verdict) console.log(`verdict     : ${result.verdict.decision}${result.verdict.reason ? ' — ' + result.verdict.reason : ''}`);
    console.log(`cost (usd)  : ${result.usage.costUsd ?? 'n/a'}`);
    console.log(`diff        : ${result.diff ? 'yes' : 'no'}`);
    if (result.error) console.log(`error       : ${result.error}`);
    console.log('--- text ---');
    console.log(result.text);
  }
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => { console.error(err.message); process.exit(2); });
