import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
