import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyLicence, licenceFindings, splitAccept, parseScancode, LEGAL } from '../src/council/licences.js';
import { DEFAULT_OPTIONS } from '../src/options.js';
import { git } from '../src/workspace.js';
import { makeRepo } from './helpers/gitRepo.js';
import { councilStubs, SCANCODE_GPL } from './helpers/councilStubs.js';

test('classifyLicence: SPDX expressions under the permissive-only rule (spec §5a)', () => {
  const table = {
    MIT: 'permissive', mit: 'permissive', 'Apache-2.0': 'permissive', ISC: 'permissive', 'BSD-3-Clause': 'permissive', '0BSD': 'permissive',
    '(MIT OR GPL-3.0-only)': 'permissive', 'MIT AND GPL-2.0': 'copyleft', '(MIT OR Apache-2.0) AND BSD-3-Clause': 'permissive',
    'GPL-2.0-or-later': 'copyleft', 'GPL-2.0+': 'copyleft', 'LGPL-3.0': 'copyleft', 'MPL-2.0': 'copyleft', 'AGPL-3.0-only': 'copyleft',
    'Apache-2.0 WITH LLVM-exception': 'permissive', 'GPL-2.0-only WITH Classpath-exception-2.0': 'copyleft',
    'GPL-3.0-only OR WeirdLicense': 'unknown', 'Proprietary-Foo': 'unknown', UNLICENSED: 'unknown',
    'SEE LICENSE IN LICENSE.md': 'unknown', '(MIT': 'unknown', '': 'unknown',
  };
  for (const [expr, want] of Object.entries(table)) assert.equal(classifyLicence(expr), want, expr);
  assert.equal(classifyLicence(null), 'unknown');
  assert.equal(classifyLicence('LGPL-3.0-only', { accept: ['lgpl-3.0-only'] }), 'permissive', 'the operator accepted it for this project');
});

test('licenceFindings: only an introduced, shipped, non-permissive dependency blocks (locked)', () => {
  const pkgs = [
    { name: 'gpl-lib', version: '1.0.0', license: 'GPL-3.0-only', dev: false },
    { name: 'gpl-dev', version: '1.0.0', license: 'GPL-3.0-only', dev: true },
    { name: 'old-gpl', version: '2.0.0', license: 'AGPL-3.0-only', dev: false },
    { name: 'nolicence', version: '0.1.0', license: null, dev: false },
    { name: 'odd', version: '0.1.0', license: 'Custom-1.0', dev: false },
    { name: 'lgpl-ok', version: '1.0.0', license: 'LGPL-3.0-only', dev: false },
    { name: 'mit', version: '1.0.0', license: 'MIT', dev: false },
    { name: 'gpl-lib', version: '1.0.0', license: 'GPL-3.0-only', dev: false },
  ];
  const f = licenceFindings(pkgs, { introduced: new Set(['gpl-lib', 'gpl-dev', 'nolicence', 'odd', 'lgpl-ok', 'mit']), accept: ['LGPL-3.0-only'] });
  assert.deepEqual(f.map((x) => [x.title, x.grade, x.locked, x.preExisting]), [
    ['gpl-lib 1.0.0 uses GPL-3.0-only, a copyleft licence', 'blocking', true, false],
    ['gpl-dev 1.0.0 uses GPL-3.0-only, a copyleft licence', 'warning', false, false],
    ['old-gpl 2.0.0 uses AGPL-3.0-only, a copyleft licence', 'warning', false, true],
    ['nolicence 0.1.0 has no licence', 'blocking', true, false],
    ['odd 0.1.0 has a licence Conductor does not recognise (Custom-1.0)', 'blocking', true, false],
  ]);
  assert.equal(f[0].tool, 'licences');
  assert.equal(f[0].file, 'package-lock.json');
  assert.match(f[0].detail, /councilAcceptLicences/);
  assert.match(f[0].detail, /name@version/);
  assert.equal(f[1].maxGrade, 'warning', 'a dev-only licence can never be raised to blocking (Ruling 6)');
});

test('councilAcceptLicences: name@version clears one specific package, even with no licence', () => {
  assert.deepEqual(splitAccept(['MIT-like', 'NoLicence@0.1.0', '@scope/pkg@2.0.0']), { ids: ['MIT-like'], packages: new Set(['nolicence@0.1.0', '@scope/pkg@2.0.0']) });
  const pkgs = [
    { name: 'nolicence', version: '0.1.0', license: null, dev: false },
    { name: 'nolicence', version: '0.2.0', license: null, dev: false },
    { name: '@scope/pkg', version: '2.0.0', license: 'GPL-3.0-only', dev: false },
  ];
  const f = licenceFindings(pkgs, { introduced: new Set(['nolicence', '@scope/pkg']), accept: ['nolicence@0.1.0', '@scope/pkg@2.0.0'] });
  assert.deepEqual(f.map((x) => x.title), ['nolicence 0.2.0 has no licence'], 'only the exact version is accepted');
});

test('parseScancode: a copyleft match in a changed file blocks; unrecognised warns; the rest is ignored', () => {
  const text = JSON.stringify({ files: [
    { path: 'src/copied.js', type: 'file', detected_license_expression_spdx: 'GPL-3.0-or-later' },
    { path: 'src/ok.js', type: 'file', detected_license_expression_spdx: 'MIT' },
    { path: 'src', type: 'directory' },
    { path: 'src/odd.js', type: 'file', detected_license_expression_spdx: 'LicenseRef-scancode-unknown' },
    { path: 'src/none.js', type: 'file', detected_license_expression_spdx: null },
  ] });
  const f = parseScancode(text, { accept: [] });
  assert.deepEqual(f.map((x) => [x.file, x.grade, x.locked, x.tool]), [
    ['src/copied.js', 'blocking', false, 'scancode'],
    ['src/odd.js', 'warning', false, 'scancode'],
  ]);
  assert.equal(f[0].title, 'src/copied.js contains text matching GPL-3.0-or-later');
  assert.throws(() => parseScancode('{}', { accept: [] }), /no file list/);
});

async function legalInput(repo, files, options = {}) {
  const baseSha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  return { dir: repo, files, changed: new Set(files), baseSha, tests: null, request: 'r', plan: null, diff: '', env: process.env, options: { ...DEFAULT_OPTIONS, ...options } };
}

test('LEGAL.collect: lockfile delta plus ScanCode on changed files only (never lockfiles or package.json)', async () => {
  const lock = (pkgs) => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...pkgs } });
  const repo = await makeRepo({ 'package-lock.json': lock({ 'node_modules/left-pad': { version: '1.3.0', license: 'MIT' } }), 'package.json': '{}' });
  writeFileSync(path.join(repo, 'package-lock.json'), lock({ 'node_modules/left-pad': { version: '1.3.0', license: 'MIT' }, 'node_modules/gpl-lib': { version: '1.0.0', license: 'GPL-3.0-only' } }));
  writeFileSync(path.join(repo, 'package.json'), '{ "description": "GNU General Public License" }');
  writeFileSync(path.join(repo, 'copied.js'), '// This program is free software under the GNU General Public License\n');
  const files = ['package-lock.json', 'package.json', 'copied.js', 'deleted.js'];
  const tools = councilStubs(mkdtempSync(path.join(tmpdir(), 'cleg-')), { scancode: SCANCODE_GPL });
  const runs = await LEGAL.collect(await legalInput(repo, files, { councilTools: tools }));
  assert.deepEqual(runs.map((r) => [r.tool, r.status]), [['licences', 'ran'], ['scancode', 'ran']]);
  assert.deepEqual(runs.flatMap((r) => r.findings).map((f) => [f.tool, f.file, f.grade]), [
    ['licences', 'package-lock.json', 'blocking'],
    ['scancode', 'copied.js', 'blocking'],
  ]);
  const accepted = await LEGAL.collect(await legalInput(repo, files, { councilTools: tools, councilAcceptLicences: ['GPL-3.0-only'] }));
  assert.equal(accepted[0].findings.length, 0);
});

test('LEGAL.collect: a committed symlink to a file outside the repo is never copied for ScanCode', async () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'cleg-out-'));
  writeFileSync(path.join(outside, 'secret.txt'), 'GNU General Public License, outside the workspace\n');
  const repo = await makeRepo();
  symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'link.js'));
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'add a symlink']);
  // The stub lists every file it was given: the symlink must not be among them.
  const listAll = `const fs = require('fs'), path = require('path'); const root = args[args.length - 1];
    const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(root, p)); } };
    walk(root); fs.writeFileSync(args[args.indexOf('--json-pp') + 1], JSON.stringify({ files: out.map((p) => ({ path: p, type: 'file', detected_license_expression_spdx: 'GPL-3.0-only' })) }));`;
  writeFileSync(path.join(repo, 'real.js'), 'ok\n');
  const tools = councilStubs(mkdtempSync(path.join(tmpdir(), 'cleg-')), { scancode: listAll });
  const runs = await LEGAL.collect(await legalInput(repo, ['link.js', 'real.js'], { councilTools: tools }));
  assert.deepEqual(runs[1].findings.map((f) => f.file), ['real.js']);
  const onlyLink = await LEGAL.collect(await legalInput(repo, ['link.js'], { councilTools: tools }));
  assert.equal(onlyLink[1].status, 'skipped');
});

test('LEGAL.collect: a v1 lockfile has no licence data, so the licence check is skipped, not failed', async () => {
  const v1 = (deps) => JSON.stringify({ lockfileVersion: 1, dependencies: deps });
  const repo = await makeRepo({ 'package-lock.json': v1({ a: { version: '1.0.0' } }) });
  writeFileSync(path.join(repo, 'package-lock.json'), v1({ a: { version: '1.0.0' }, b: { version: '2.0.0' } }));
  const runs = await LEGAL.collect(await legalInput(repo, ['package-lock.json'], { councilTools: councilStubs(mkdtempSync(path.join(tmpdir(), 'cleg-')), {}) }));
  assert.deepEqual([runs[0].status, runs[0].findings.length, runs[0].note], ['skipped', 0,
    'package-lock.json is in the old format (lockfileVersion 1), which does not record licences, so dependency licences were not checked. Updating it with npm 7 or later (run npm install) lets the council check them.']);
});

test('LEGAL.collect: no lockfile and nothing to scan are skipped with reasons', async () => {
  const runs = await LEGAL.collect(await legalInput(await makeRepo(), [], { councilTools: councilStubs(mkdtempSync(path.join(tmpdir(), 'cleg-')), { scancode: SCANCODE_GPL }) }));
  assert.deepEqual(runs.map((r) => [r.status, r.note]), [
    ['skipped', 'There is no package-lock.json, so dependency licences were not checked (only Node projects are checked in this version).'],
    ['skipped', 'No changed files to scan for copied licensed code.'],
  ]);
});

test('parseScancode: a failed scan never looks clean (empty, garbage or no files with a failure exit code)', () => {
  assert.throws(() => parseScancode('', { accept: [], code: 2 }));
  assert.throws(() => parseScancode('Traceback (most recent call last)', { accept: [], code: 1 }));
  assert.throws(() => parseScancode('{"files":[]}', { accept: [], code: 2 }), /failed with no scanned files/);
  assert.deepEqual(parseScancode('{"files":[]}', { accept: [], code: 0 }), []);
});

test('LEGAL.collect: a crashed ScanCode is status error with a warning, not a clean run', async () => {
  const repo = await makeRepo({ 'a.js': 'x\n' });
  writeFileSync(path.join(repo, 'a.js'), 'y\n');
  const tools = councilStubs(mkdtempSync(path.join(tmpdir(), 'cleg-')), { scancode: 'process.stderr.write("boom"); process.exit(2);' });
  const runs = await LEGAL.collect(await legalInput(repo, ['a.js'], { councilTools: tools }));
  assert.equal(runs[1].status, 'error');
  assert.equal(runs[1].findings[0].grade, 'warning');
  const empty = councilStubs(mkdtempSync(path.join(tmpdir(), 'cleg-')), { scancode: 'require("fs").writeFileSync(args[args.indexOf("--json-pp") + 1], ""); process.exit(2);' });
  assert.equal((await LEGAL.collect(await legalInput(repo, ['a.js'], { councilTools: empty })))[1].status, 'error');
});

test('LEGAL.collect: a missing base lockfile fails closed (every package counts as introduced)', async () => {
  const repo = await makeRepo({ 'README.md': 'x\n' });
  writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/gpl-lib': { version: '1.0.0', license: 'GPL-3.0-only' } } }));
  const runs = await LEGAL.collect(await legalInput(repo, ['package-lock.json'], { councilTools: councilStubs(mkdtempSync(path.join(tmpdir(), 'cleg-')), {}) }));
  assert.deepEqual(runs[0].findings.map((f) => [f.grade, f.locked, f.preExisting]), [['blocking', true, false]]);
});


test('licenceFindings: a dev copy listed first cannot mask a shipped copy of the same name@version', () => {
  const pkgs = [
    { name: 'gpl-lib', version: '1.0.0', license: 'GPL-3.0-only', dev: true },
    { name: 'gpl-lib', version: '1.0.0', license: 'GPL-3.0-only', dev: false },
  ];
  const f = licenceFindings(pkgs, { introduced: new Set(['gpl-lib']), accept: [] });
  assert.deepEqual(f.map((x) => [x.grade, x.locked]), [['blocking', true]]);
});

test('parseScancode: matches respect which lines this run added', () => {
  const det = (path, s, e) => ({ path, type: 'file', detected_license_expression_spdx: 'GPL-3.0-or-later',
    license_detections: s ? [{ matches: [{ start_line: s, end_line: e }] }] : [] });
  const text = JSON.stringify({ files: [det('new.js', 5, 8), det('old.js', 1, 3), det('nolines.js', 0, 0)] });
  const input = { changed: new Set(['new.js', 'old.js', 'nolines.js']), added: new Map([['new.js', new Set([6, 7])], ['old.js', new Set([40])], ['nolines.js', new Set([1])]]) };
  const f = parseScancode(text, { accept: [], input });
  assert.deepEqual(f.map((x) => [x.file, x.grade, x.preExisting]), [
    ['new.js', 'blocking', false], ['old.js', 'warning', true], ['nolines.js', 'blocking', false]]);
});

// ---- Task 10: Legal/data for client apps ----
const lock10 = (pkgs) => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...pkgs } });
const quiet10 = () => ({ councilTools: councilStubs(mkdtempSync(path.join(tmpdir(), 'cleg-')), {}) });
async function project10(extra = {}, brief = { policy: { outbound: [] } }) {
  const repo = await makeRepo({ 'package-lock.json': lock10({}), 'package.json': '{}' });
  writeFileSync(path.join(repo, 'package-lock.json'), lock10({ 'node_modules/left-pad': { version: '1.3.0', license: 'WTFPL' } }));
  for (const [f, s] of Object.entries(extra)) { mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); writeFileSync(path.join(repo, f), s); }
  const input = await legalInput(repo, ['package-lock.json', ...Object.keys(extra).filter((f) => f !== 'licence-exceptions.json')], quiet10());
  return { ...input, brief };
}
const titles10 = (runs, tool) => runs.find((r) => r.tool === tool).findings.map((f) => [f.grade, f.title]);

test('LEGAL.collect on an ordinary repo is Plan 5 exactly, whatever files sit in the folder', async () => {
  const repo = await makeRepo({ 'package-lock.json': lock10({}) });
  writeFileSync(path.join(repo, 'package-lock.json'), lock10({ 'node_modules/left-pad': { version: '1.3.0', license: 'WTFPL' } }));
  writeFileSync(path.join(repo, 'licence-exceptions.json'), JSON.stringify({ 'left-pad@1.3.0': 'ok' }));
  mkdirSync(path.join(repo, 'apps/server/src'), { recursive: true });
  writeFileSync(path.join(repo, 'apps/server/src/ocr.ts'), "fetch('https://vision.googleapis.com')\n");
  const input = await legalInput(repo, ['package-lock.json', 'apps/server/src/ocr.ts'], quiet10());
  const runs = await LEGAL.collect({ ...input, brief: null });
  assert.deepEqual(runs.map((r) => r.tool), ['licences', 'scancode']);
  assert.match(runs[0].findings[0].detail, /councilAcceptLicences/);
  assert.equal(runs[0].findings[0].grade, 'blocking');
});

test('LEGAL.collect on a project: five runs, an unallowed connection blocks, no policy skips', async () => {
  const input = await project10({ 'apps/server/src/ocr.ts': "const u = 'https://vision.googleapis.com/v1';\n" });
  const runs = await LEGAL.collect(input);
  assert.deepEqual(runs.map((r) => r.tool), ['licences', 'scancode', 'licence-exceptions', 'data-flow', 'data-policy']);
  assert.deepEqual(titles10(runs, 'data-flow'), [['blocking', 'The app connects to vision.googleapis.com, which the data policy does not allow']]);
  const none = await LEGAL.collect({ ...input, brief: {} });
  const df = none.find((r) => r.tool === 'data-flow');
  assert.equal(df.status, 'skipped');
  assert.deepEqual(df.findings.map((f) => [f.grade, f.locked, f.title]), [['warning', true, "The brief has no data policy, so the app's outside connections could not be checked"]]);
});

test('licence exceptions: accepted with a reason, refused without, project remedy named', async () => {
  const reason = 'Public-domain-like; the operator accepted it on 2026-10-20.';
  const withFile = await project10({ 'licence-exceptions.json': JSON.stringify({ 'left-pad@1.3.0': reason, 'odd@1.0.0': '' }) });
  const runs = await LEGAL.collect(withFile);
  assert.deepEqual(runs.find((r) => r.tool === 'licences').findings, []);
  assert.deepEqual(titles10(runs, 'licence-exceptions'), [
    ['note', `left-pad@1.3.0 is accepted by the app's licence exceptions: ${reason}`],
    ['warning', 'licence-exceptions.json lists odd@1.0.0 with no reason, so the council did not accept it'],
  ]);
  const without = await LEGAL.collect(await project10());
  const [f] = without.find((r) => r.tool === 'licences').findings;
  assert.equal(f.grade, 'blocking');
  assert.ok(f.detail.endsWith('ask the operator to accept it in licence-exceptions.json with a reason (spec §5a).'));
  assert.deepEqual(without.find((r) => r.tool === 'licence-exceptions').findings, []);
  assert.equal(without.find((r) => r.tool === 'licence-exceptions').status, 'ran');
});

test('licence exceptions: a file that is not an object of strings accepts nothing', async () => {
  for (const bad of ['[1]', '{ "left-pad@1.3.0": 5 }', 'not json']) {
    const runs = await LEGAL.collect(await project10({ 'licence-exceptions.json': bad }));
    assert.deepEqual(titles10(runs, 'licence-exceptions'), [['warning', "The app's licence-exceptions.json could not be read, so no exception was accepted"]], bad);
    assert.equal(runs.find((r) => r.tool === 'licences').findings.length, 1, bad);
  }
});
