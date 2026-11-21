// Tests for the rare-language harness, run by the conductor suite (node --test from conductor).
// Synthetic only: the Node stand-in, a fake command checker and a local fake model server. No live model or Urbit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { passAtK, summarize } from '../src/metrics.js';
import { extractCode, chatClient, replayClient, buildPrompt } from '../src/model.js';
import { nodeAdapter, commandAdapter, loadAdapter } from '../src/adapters.js';
import { loadTasks } from '../src/tasks.js';
import { checkTooling, measure, GARBAGE } from '../src/loop.js';
import { checkerEnv } from '../src/process.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'rare-lang-'));

test('passAtK matches the unbiased estimate', () => {
  assert.equal(passAtK(10, 0, 1), 0);
  assert.equal(passAtK(10, 10, 10), 1);
  assert.equal(passAtK(10, 3, 1), 0.3); // k = 1 is the pass rate
  assert.equal(passAtK(10, 1, 10), 1); // solved once in 10 means pass@10 = 1
  assert.ok(Math.abs(passAtK(10, 1, 5) - 0.5) < 1e-12); // 1 - C(9,5)/C(10,5)
  assert.equal(passAtK(3, 1, 10), null); // not measurable from 3 attempts
  assert.throws(() => passAtK(5, 6, 1));
});

test('summarize leaves checker errors out of every rate', () => {
  const s = summarize([
    { task: 'a', status: 'pass' }, { task: 'a', status: 'test-fail' }, { task: 'a', status: 'error' },
    { task: 'b', status: 'compile-fail' }, { task: 'b', status: 'compile-fail' },
  ], [1, 2]);
  assert.equal(s.attempts, 4);
  assert.equal(s.errors, 1);
  assert.equal(s.compileRate, 0.5);
  assert.equal(s.passAt[1], 0.25); // a: 1/2, b: 0
  assert.equal(s.passAt[2], 0.5); // a solved, b not
  assert.equal(s.solvedAtLeastOnce, 1);
  assert.deepEqual(s.passAtExcluded, { 1: 0, 2: 0 });
});

test('one error among n attempts leaves that task out of pass@n, and only that task', () => {
  const recs = [];
  for (let i = 0; i < 10; i += 1) recs.push({ task: 'a', status: i === 0 ? 'pass' : 'test-fail' });
  for (let i = 0; i < 10; i += 1) recs.push({ task: 'b', status: i === 3 ? 'error' : i === 4 ? 'pass' : 'test-fail' });
  const s = summarize(recs, [1, 10]);
  assert.equal(s.passAt[10], 1, 'a is solved; b has only 9 counted attempts, so it is left out of pass@10');
  assert.deepEqual(s.passAtExcluded, { 1: 0, 10: 1 });
  assert.equal(s.passAt[1], (1 / 10 + 1 / 9) / 2, 'pass@1 still uses both tasks');
});

test('extractCode takes the first fenced block, or the whole reply', () => {
  assert.equal(extractCode('Here:\n```hoon\n|%\n--\n```\nmore\n```x\nno\n```'), '|%\n--\n');
  assert.equal(extractCode('(add 1 2)'), '(add 1 2)\n');
  assert.equal(extractCode(''), '\n');
});

test('every starter task loads for both languages, with the same task ids', () => {
  const node = loadTasks(path.join(ROOT, 'tasks', 'node'), nodeAdapter());
  const hoon = loadTasks(path.join(ROOT, 'tasks', 'hoon'), loadAdapter(path.join(ROOT, 'adapters', 'hoon.example.json')));
  assert.deepEqual(node.map((t) => t.id), hoon.map((t) => t.id));
  assert.equal(node.length, 5);
  for (const t of [...node, ...hoon]) {
    assert.ok(t.reference, `${t.id} has a reference solution`);
    assert.ok(t.wrong, `${t.id} has a wrong solution`);
    assert.notEqual(t.wrong, t.reference);
  }
  for (const t of hoon) assert.match(t.tests, /\/\+ {2}\*test, \*task/);
});

test('loadTasks refuses a task whose id does not match its folder', () => {
  const dir = tmp();
  const t = path.join(dir, 'one');
  mkdirSync(t);
  writeFileSync(path.join(t, 'task.json'), JSON.stringify({ id: 'two', prompt: 'p' }));
  writeFileSync(path.join(t, 'check.cjs'), '');
  assert.throws(() => loadTasks(dir, nodeAdapter()), /must match the folder name/);
});

test('Stage 0 with the Node stand-in: reference passes, wrong fails its tests, garbage fails to compile', async () => {
  const tasks = loadTasks(path.join(ROOT, 'tasks', 'node'), nodeAdapter());
  const r = await checkTooling({ tasks, adapter: nodeAdapter(), workRoot: tmp() });
  assert.equal(r.ok, true, JSON.stringify(r.rows));
  assert.equal(r.withReference, 5);
  assert.ok(r.rows.every((row) => row.reference === 'pass' && row.wrong === 'test-fail' && row.garbage === 'compile-fail'));
  assert.ok(Number.isFinite(r.medianCheckMs));
});

test('Stage 0 is not OK for a bad reference, a missing wrong solution, or a checker that does not test', async () => {
  const tasks = loadTasks(path.join(ROOT, 'tasks', 'node'), nodeAdapter()).slice(0, 1);
  const broken = [{ ...tasks[0], reference: 'module.exports.addTwo = (n) => n + 3;\n' }];
  assert.equal((await checkTooling({ tasks: broken, adapter: nodeAdapter(), workRoot: tmp() })).ok, false);
  const noWrong = [{ ...tasks[0], wrong: null }];
  const missing = await checkTooling({ tasks: noWrong, adapter: nodeAdapter(), workRoot: tmp() });
  assert.equal(missing.ok, false, 'without a wrong solution nothing proves the tests ran');
  assert.equal(missing.rows[0].wrong, 'missing');
  const yesMan = { name: 'yes', solutionFile: 's', check: async () => ({ status: 'pass', ms: 1, output: '' }) };
  assert.equal((await checkTooling({ tasks, adapter: yesMan, workRoot: tmp() })).ok, false, 'a checker that passes everything is caught');
  // Builds the code and never runs the tests: it gets the reference and the garbage right, and only the wrong
  // solution shows it up.
  const buildOnly = {
    ...nodeAdapter(),
    async check(args) {
      const r = await nodeAdapter().check({ ...args, tests: '' });
      return r.status === 'test-fail' ? { ...r, status: 'pass' } : r;
    },
  };
  const b = await checkTooling({ tasks, adapter: buildOnly, workRoot: tmp() });
  assert.equal(b.rows[0].reference, 'pass');
  assert.equal(b.rows[0].garbage, 'compile-fail');
  assert.equal(b.rows[0].wrong, 'pass');
  assert.equal(b.ok, false, 'a checker that only builds is caught');
});

test('tasks and model replies are read with LF line endings', () => {
  const dir = tmp();
  const t = path.join(dir, 'crlf');
  mkdirSync(t);
  writeFileSync(path.join(t, 'task.json'), JSON.stringify({ id: 'crlf', prompt: 'p' }));
  writeFileSync(path.join(t, 'check.cjs'), 'a\r\nb\r\n');
  writeFileSync(path.join(t, 'solution.cjs'), 'x\r\ny\r\n');
  writeFileSync(path.join(t, 'wrong.cjs'), 'w\r\n');
  const [task] = loadTasks(dir, nodeAdapter());
  assert.equal(task.tests, 'a\nb\n');
  assert.equal(task.reference, 'x\ny\n');
  assert.equal(task.wrong, 'w\n');
  assert.equal(extractCode('```hoon\r\n|%\r\n--\r\n```\r\n'), '|%\n--\n');
});

// A stand-in "compiler" for the command adapter: exit 0, 1 or 2 by the solution's text, or hang.
function fakeChecker(dir) {
  const file = path.join(dir, 'fake-checker.cjs');
  writeFileSync(file, `const fs = require('fs'), path = require('path');
    const dir = process.argv[2];
    const code = fs.readFileSync(path.join(dir, 'answer.txt'), 'utf8');
    if (!fs.existsSync(path.join(dir, 'spec.txt'))) process.exit(9);
    if (process.env.FAKE_SECRET_FOR_TEST) process.exit(7);
    if (code.includes('HANG')) setTimeout(() => {}, 60000);
    else process.exit(code.includes('PASS') ? 0 : code.includes('WRONG') ? 1 : code.includes('CRASH') ? 5 : 2);\n`);
  return file;
}

test('the command adapter maps exit codes, fills placeholders, runs without a shell and drops secrets', async () => {
  const dir = tmp();
  const adapter = commandAdapter({
    name: 'fake', language: 'Fake', solutionFile: 'answer.txt', testsFile: 'spec.txt',
    command: [process.execPath, fakeChecker(dir), '{dir}'], timeoutMs: 2000,
  });
  process.env.FAKE_SECRET_FOR_TEST = 'sk-test-not-real-0123456789';
  try {
    const run = (code, n) => adapter.check({ code, tests: 'spec', workDir: path.join(dir, `w${n}`) });
    assert.equal((await run('PASS', 1)).status, 'pass');
    assert.equal((await run('WRONG', 2)).status, 'test-fail');
    assert.equal((await run('nonsense', 3)).status, 'compile-fail');
    assert.equal((await run('CRASH', 4)).status, 'error', 'an unexpected exit code is the checker failing');
    assert.equal((await run('HANG', 5)).status, 'error', 'a timeout is the checker failing');
  } finally { delete process.env.FAKE_SECRET_FOR_TEST; }
  assert.equal(checkerEnv({ PATH: 'p', LOCALAI_API_KEY: 'k', GH_TOKEN: 't' }).LOCALAI_API_KEY, undefined);
  assert.deepEqual(Object.keys(checkerEnv({ Path: 'p', LOCALAI_API_KEY: 'k', GH_TOKEN: 't' })), ['Path']);
});

test('the command adapter refuses an unsafe or incomplete configuration', () => {
  const ok = { name: 'n', language: 'L', solutionFile: 'a.x', testsFile: 'b.x', command: ['x'] };
  assert.doesNotThrow(() => commandAdapter(ok));
  assert.throws(() => commandAdapter({ ...ok, command: 'sh -c x' }), /list of strings/);
  assert.throws(() => commandAdapter({ ...ok, solutionFile: '../a.x' }), /plain file name/);
  assert.throws(() => commandAdapter({ ...ok, language: '' }), /language/);
  assert.throws(() => commandAdapter({ ...ok, timeoutMs: 0 }), /timeoutMs/);
});

test('Stage 1 end to end with replayed replies: records, saved code and the three numbers', async () => {
  const dir = tmp();
  const tasks = loadTasks(path.join(ROOT, 'tasks', 'node'), nodeAdapter()).filter((t) => ['add-two', 'sum-list'].includes(t.id));
  const replay = path.join(dir, 'replay.json');
  writeFileSync(replay, JSON.stringify({
    'add-two': ['```js\nmodule.exports.addTwo = (n) => n + 2;\n```', 'module.exports.addTwo = (n) => n + 1;', GARBAGE],
    'sum-list': ['```\nmodule.exports.sumList = () => 0;\n```'],
  }));
  const out = path.join(dir, 'run');
  const s = await measure({ tasks, adapter: nodeAdapter(), client: replayClient(replay), attempts: 3, outDir: out });
  assert.equal(s.attempts, 6);
  assert.equal(s.compileRate, 5 / 6); // only the garbage reply fails to compile
  assert.equal(s.passAt[1], (1 / 3 + 0) / 2);
  assert.equal(s.passAt[3], 0.5);
  assert.equal(s.solvedAtLeastOnce, 1);
  const lines = readFileSync(path.join(out, 'attempts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.status), ['pass', 'test-fail', 'compile-fail', 'test-fail', 'test-fail', 'test-fail']);
  assert.ok(existsSync(path.join(out, 'code', 'add-two', '1-solution.cjs')));
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8')).passAt, s.passAt);
});

test('the chat client sends the key only in the header, and a run never records it', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: '```\nmodule.exports.addTwo = (n) => n + 2;\n```' } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const key = 'sk-test-local-0123456789';
  try {
    const client = chatClient({ baseUrl: `http://127.0.0.1:${server.address().port}/`, model: 'qwen-test', apiKeyEnv: 'RL_TEST_KEY', env: { RL_TEST_KEY: key } });
    const tasks = loadTasks(path.join(ROOT, 'tasks', 'node'), nodeAdapter()).filter((t) => t.id === 'add-two');
    const out = path.join(tmp(), 'run');
    const s = await measure({ tasks, adapter: nodeAdapter(), client, attempts: 2, outDir: out });
    assert.equal(s.passAt[1], 1);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].url, '/v1/chat/completions');
    assert.equal(seen[0].auth, `Bearer ${key}`);
    assert.equal(seen[0].body.model, 'qwen-test');
    assert.equal(seen[0].body.messages[0].content, buildPrompt(tasks[0], nodeAdapter()));
    for (const f of ['attempts.jsonl', 'summary.json']) assert.ok(!readFileSync(path.join(out, f), 'utf8').includes(key), `${f} holds no key`);
    await assert.rejects(chatClient({ baseUrl: 'http://127.0.0.1:1', model: 'm', apiKeyEnv: 'MISSING', env: {} }).generate('p'), /MISSING is not set/);
  } finally { server.close(); }
});

test('a model server that fails is recorded as an error, not as a model failure', async () => {
  const failing = { describe: () => ({ kind: 'test' }), generate: async () => { throw new Error('HTTP 503'); } };
  const tasks = loadTasks(path.join(ROOT, 'tasks', 'node'), nodeAdapter()).slice(0, 1);
  const s = await measure({ tasks, adapter: nodeAdapter(), client: failing, attempts: 2, outDir: path.join(tmp(), 'run') });
  assert.equal(s.errors, 2);
  assert.equal(s.attempts, 0);
  assert.equal(s.compileRate, null);
  assert.equal(s.passAt[1], null);
});

test('the command line runs Stage 0 and Stage 1 with the stand-in', () => {
  const dir = tmp();
  const tooling = execFileSync(process.execPath, [path.join(ROOT, 'harness.js'), 'tooling', '--lang', 'node', '--out', path.join(dir, 't')], { encoding: 'utf8' });
  assert.match(tooling, /Stage 0, node: OK\. 5 of 5 tasks checked/);
  const replay = path.join(dir, 'replay.json');
  const reply = (fn, body) => `\`\`\`\nmodule.exports.${fn} = ${body};\n\`\`\``;
  writeFileSync(replay, JSON.stringify({
    'add-two': [reply('addTwo', '(n) => n + 2')], 'count-evens': [reply('countEvens', '() => 0')],
    'fizzbuzz': ['no code here'], 'sum-list': [reply('sumList', '(xs) => xs.reduce((s, x) => s + x, 0)')],
    'word-count': [reply('wordCount', '() => new Map()')],
  }));
  const measured = execFileSync(process.execPath, [path.join(ROOT, 'harness.js'), 'measure', '--lang', 'node', '--replay', replay, '--attempts', '2', '--out', path.join(dir, 'm')], { encoding: 'utf8' });
  assert.match(measured, /5 tasks x 2 attempts \(0 checker or model errors/);
  assert.match(measured, /compiles 80\.0%; pass@1 40\.0%; pass@2 40\.0%; solved at least once 2 of 5/);
});
