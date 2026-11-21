// Stage 0 (does the tooling work, and how long does a check take?) and Stage 1 (how good is today's model?).
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { buildPrompt, extractCode } from './model.js';
import { summarize } from './metrics.js';

// Something no language accepts as a correct solution. A checker that passes it would report false greens.
export const GARBAGE = 'this is not a program )(\n';

const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// Three probes per task, each with an expected answer:
//   the reference solution   must pass;
//   the wrong solution       compiles but is wrong, so it must come back test-fail. This catches a checker that
//                            only builds the code and never runs the tests, which would make pass@k equal the
//                            compile rate;
//   a garbage attempt        must come back compile-fail.
// ok is true only when every task has a reference and a wrong solution and all three answers are right.
export const EXPECTED = { reference: 'pass', wrong: 'test-fail', garbage: 'compile-fail' };

export async function checkTooling({ tasks, adapter, workRoot, log = () => {} }) {
  const rows = [];
  for (const task of tasks) {
    const row = { task: task.id };
    for (const [probe, code] of [['reference', task.reference], ['wrong', task.wrong], ['garbage', GARBAGE]]) {
      if (code === null) { row[probe] = 'missing'; continue; }
      const r = await adapter.check({ code, tests: task.tests, workDir: path.join(workRoot, task.id, probe) });
      row[probe] = r.status;
      if (probe === 'reference') row.ms = r.ms;
      if (r.status !== EXPECTED[probe]) row[`${probe}Output`] = r.output;
    }
    row.ok = Object.entries(EXPECTED).every(([probe, want]) => row[probe] === want);
    rows.push(row);
    log(`${task.id}: reference ${row.reference}${row.ms === undefined ? '' : ` in ${row.ms} ms`}; wrong ${row.wrong}; garbage ${row.garbage}`);
  }
  const checked = rows.filter((r) => r.reference !== 'missing');
  return {
    ok: rows.length > 0 && rows.every((r) => r.ok),
    tasks: rows.length,
    withReference: checked.length,
    medianCheckMs: median(checked.map((r) => r.ms)),
    rows,
  };
}

// attempts.jsonl gets one line per attempt as it finishes, so a long run that stops part-way keeps what it did.
// Each attempt's code is kept beside it for later stages. Nothing here is meant for the repository.
export async function measure({ tasks, adapter, client, attempts = 10, outDir, log = () => {} }) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('--attempts must be a whole number of at least 1.');
  mkdirSync(outDir, { recursive: true });
  const recordsFile = path.join(outDir, 'attempts.jsonl');
  writeFileSync(recordsFile, '');
  const records = [];
  for (const task of tasks) {
    const prompt = buildPrompt(task, adapter);
    for (let i = 1; i <= attempts; i += 1) {
      let record;
      try {
        const reply = await client.generate(prompt, task);
        const code = extractCode(reply);
        const codeDir = path.join(outDir, 'code', task.id);
        mkdirSync(codeDir, { recursive: true });
        writeFileSync(path.join(codeDir, `${i}-${adapter.solutionFile}`), code);
        const r = await adapter.check({ code, tests: task.tests, workDir: path.join(outDir, 'work', task.id, String(i)) });
        record = { task: task.id, attempt: i, status: r.status, ms: r.ms, output: r.status === 'pass' ? '' : r.output };
      } catch (e) {
        record = { task: task.id, attempt: i, status: 'error', ms: 0, output: `generation failed: ${e.message}` };
      }
      records.push(record);
      appendFileSync(recordsFile, `${JSON.stringify(record)}\n`);
      log(`${task.id} #${i}: ${record.status}`);
    }
  }
  const summary = { adapter: adapter.name, model: client.describe(), attemptsPerTask: attempts, ...summarize(records, [1, attempts]) };
  writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}
