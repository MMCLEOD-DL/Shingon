import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findBin, resolveTool, runTool, skipped } from '../src/council/tools.js';
import { makeFinding } from '../src/council/findings.js';
import { DEFAULT_OPTIONS } from '../src/options.js';
import { writeStubCli } from './helpers/stubCli.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'ctool-'));
const opts = (over = {}) => ({ ...DEFAULT_OPTIONS, ...over });
const parseList = (text) => JSON.parse(text).map((t) => makeFinding({ member: 'security', tool: 'semgrep', grade: 'warning', title: t }));
const base = { member: 'security', name: 'semgrep', label: 'Semgrep (code scanner)', bin: 'semgrep', args: [], install: 'Install: pipx install semgrep' };

test('findBin: a bare name on PATH, executable regular files only', () => {
  const dir = tmp();
  const stub = writeStubCli(dir, 'semgrep', 'console.log(1)');
  writeFileSync(path.join(dir, 'gitleaks'), 'not executable');
  assert.equal(findBin('semgrep', { env: { PATH: `/nonexistent:${dir}` } }), stub);
  assert.equal(findBin('gitleaks', { env: { PATH: dir } }), null);
  assert.equal(findBin('semgrep', { env: { PATH: '' } }), null);
  assert.equal(findBin('../semgrep', { env: { PATH: dir } }), null, 'a name, never a path');
});

test('resolveTool: false turns it off; a configured path wins over PATH', () => {
  const stub = writeStubCli(tmp(), 'my-semgrep', '');
  const env = { PATH: '' };
  assert.deepEqual(resolveTool('semgrep', 'semgrep', { options: opts({ councilTools: { semgrep: false } }), env }), { path: null, off: true });
  assert.deepEqual(resolveTool('semgrep', 'semgrep', { options: opts({ councilTools: { semgrep: stub } }), env }), { path: stub, off: false });
  assert.deepEqual(resolveTool('semgrep', 'semgrep', { options: opts({ councilTools: { semgrep: '/nope/semgrep' } }), env }), { path: null, off: false });
  assert.deepEqual(resolveTool('semgrep', 'semgrep', { options: opts(), env }), { path: null, off: false });
});

test('runTool: not installed and turned off are notes, never failures', async () => {
  const missing = await runTool({ ...base, cwd: tmp(), options: opts({ councilTools: { semgrep: '/nope/semgrep' } }), parse: parseList });
  assert.deepEqual(missing, { tool: 'semgrep', label: 'Semgrep (code scanner)', status: 'missing', findings: [],
    note: 'Semgrep (code scanner) is not installed, so this check did not run. Install: pipx install semgrep' });
  const off = await runTool({ ...base, cwd: tmp(), options: opts({ councilTools: { semgrep: false } }), parse: parseList });
  assert.equal(off.status, 'off');
  assert.equal(off.note, 'Semgrep (code scanner) is turned off in the config.');
  assert.deepEqual(skipped('legal', 'scancode', 'ScanCode (licence scanner)', 'No files changed.'),
    { tool: 'scancode', label: 'ScanCode (licence scanner)', status: 'skipped', findings: [], note: 'No files changed.' });
});

test('runTool: stdout or a {report} file is parsed; the tool gets no credentials', async () => {
  const dir = tmp();
  const out = writeStubCli(dir, 'semgrep', `console.log(JSON.stringify([process.env.MY_SECRET_TOKEN ? 'leaked' : 'clean', process.cwd()]));`);
  const cwd = tmp();
  const env = { ...process.env, MY_SECRET_TOKEN: 'tok-1234567890' };
  const r = await runTool({ ...base, cwd, env, options: opts({ councilTools: { semgrep: out } }), parse: parseList });
  assert.equal(r.status, 'ran');
  assert.equal(r.note, null);
  assert.deepEqual(r.findings.map((f) => f.title), ['clean', cwd]);

  const file = writeStubCli(dir, 'gl', `require('fs').writeFileSync(args[args.indexOf('--report-path') + 1], JSON.stringify(['from-file'])); console.log('banner, not json');`);
  const r2 = await runTool({ ...base, args: ['--report-path', '{report}'], cwd, options: opts({ councilTools: { semgrep: file } }), parse: parseList });
  assert.deepEqual(r2.findings.map((f) => f.title), ['from-file']);
});

test('runTool: garbage output or a hang is a warning, not a crash (Review Focus 1)', async () => {
  const dir = tmp();
  const junk = writeStubCli(dir, 'junk', `console.log('Semgrep 1.2 — please log in'); process.exit(2);`);
  const r = await runTool({ ...base, cwd: tmp(), options: opts({ councilTools: { semgrep: junk } }), parse: parseList });
  assert.equal(r.status, 'error');
  assert.match(r.note, /^Semgrep \(code scanner\) did not finish \(.+\), so this check gave no answer\.$/);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].grade, 'warning');
  assert.equal(r.findings[0].title, 'Semgrep (code scanner) could not run');

  const hang = writeStubCli(dir, 'hang', 'setInterval(() => {}, 1000);');
  const h = await runTool({ ...base, cwd: tmp(), options: opts({ councilTools: { semgrep: hang }, councilToolTimeoutMs: 300 }), parse: parseList });
  assert.equal(h.status, 'error');
  assert.match(h.note, /took longer than the time allowed/);
});
