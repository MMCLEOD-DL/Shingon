#!/usr/bin/env node
// Rare-language harness: Stage 0 (tooling) and Stage 1 (measure today's model). See README.md.
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAdapter } from './src/adapters.js';
import { loadTasks } from './src/tasks.js';
import { checkTooling, measure, EXPECTED } from './src/loop.js';
import { chatClient, replayClient } from './src/model.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = `Usage:
  node harness.js tooling --lang <node | adapter.json> [--tasks <folder>] [--out <folder>]
  node harness.js measure --lang <node | adapter.json> [--tasks <folder>] [--out <folder>] [--attempts 10]
                          (--model-url <http://host:port> --model <name> [--key-env <VAR>] | --replay <file.json>)`;

const pct = (v) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      lang: { type: 'string' }, tasks: { type: 'string' }, out: { type: 'string' }, attempts: { type: 'string' },
      'model-url': { type: 'string' }, model: { type: 'string' }, 'key-env': { type: 'string' }, replay: { type: 'string' },
      temperature: { type: 'string' },
    },
  });
  const [command] = positionals;
  if (!['tooling', 'measure'].includes(command) || !values.lang) { console.error(USAGE); return 2; }
  const adapter = loadAdapter(values.lang);
  const tasks = loadTasks(values.tasks ?? path.join(HERE, 'tasks', adapter.name), adapter);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(values.out ?? path.join(HERE, 'runs', `${command}-${adapter.name}-${stamp}`));
  const log = (line) => console.log(line);

  if (command === 'tooling') {
    const r = await checkTooling({ tasks, adapter, workRoot: path.join(outDir, 'work'), log });
    console.log(`\nStage 0, ${adapter.name}: ${r.ok ? 'OK' : 'NOT OK'}. ${r.withReference} of ${r.tasks} tasks checked; median check ${r.medianCheckMs ?? 'n/a'} ms.`);
    for (const row of r.rows.filter((x) => !x.ok)) {
      const want = Object.entries(EXPECTED).map(([probe, status]) => `${probe} ${row[probe]} (want ${status})`).join(', ');
      console.log(`  ${row.task}: ${want}`);
      for (const probe of Object.keys(EXPECTED)) {
        const out = row[`${probe}Output`];
        if (out) console.log(`    ${probe}: ${out.trim().split('\n').slice(-5).join('\n    ')}`);
      }
    }
    return r.ok ? 0 : 1;
  }

  const attempts = values.attempts === undefined ? 10 : Number(values.attempts);
  let client;
  if (values.replay) client = replayClient(values.replay);
  else {
    const temperature = values.temperature === undefined ? undefined : Number(values.temperature);
    client = chatClient({ baseUrl: values['model-url'], model: values.model, apiKeyEnv: values['key-env'] ?? null, ...(temperature === undefined ? {} : { temperature }) });
  }
  const s = await measure({ tasks, adapter, client, attempts, outDir, log });
  console.log(`\nStage 1, ${adapter.name}: ${s.tasks} tasks x ${attempts} attempts (${s.errors} checker or model errors, not counted).`);
  console.log(`  compiles ${pct(s.compileRate)}; pass@1 ${pct(s.passAt[1])}; pass@${attempts} ${pct(s.passAt[attempts])}; solved at least once ${s.solvedAtLeastOnce} of ${s.tasks}.`);
  if (s.passAtExcluded[attempts] > 0) {
    console.log(`  pass@${attempts} leaves out ${s.passAtExcluded[attempts]} task(s) with fewer than ${attempts} counted attempts; see summary.json.`);
  }
  console.log(`  Records: ${path.join(outDir, 'attempts.jsonl')}`);
  return 0;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 2; });
