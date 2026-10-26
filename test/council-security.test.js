import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lockPackages, hasLicenceData, readLock, lockDelta } from '../src/council/lockfile.js';
import { parseSemgrep, parseGitleaks, parseNpmAudit, settingsTouched, suppressionsAdded, unquoteGitPath, addedLines, isIntroduced, SECURITY } from '../src/council/security.js';
import { DEFAULT_OPTIONS } from '../src/options.js';
import { git } from '../src/workspace.js';
import { makeRepo } from './helpers/gitRepo.js';
import { councilStubs, printJson, SEMGREP_EVAL, GITLEAKS_AKIA } from './helpers/councilStubs.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'csec-'));
const LOCK_V3 = { lockfileVersion: 3, packages: {
  '': { name: 'app' },
  'node_modules/left-pad': { version: '1.3.0', license: 'MIT' },
  'node_modules/a/node_modules/left-pad': { version: '1.1.0', license: 'MIT' },
  'node_modules/gpl-thing': { version: '2.0.0', license: 'GPL-3.0-only', dev: true },
  'node_modules/@scope/pkg': { version: '0.1.0' },
  'node_modules/my-lib': { resolved: 'packages/my-lib', link: true },
  'packages/my-lib': { name: 'my-lib', version: '1.0.0' },
  'node_modules/opt-dev': { version: '1.0.0', license: 'MIT', devOptional: true },
} };

test('lockPackages reads v3 (nested, scoped, dev; links and workspace packages skipped; devOptional ships) and v1; anything else is empty', () => {
  assert.deepEqual(lockPackages(LOCK_V3), [
    { name: 'left-pad', version: '1.3.0', license: 'MIT', dev: false },
    { name: 'left-pad', version: '1.1.0', license: 'MIT', dev: false },
    { name: 'gpl-thing', version: '2.0.0', license: 'GPL-3.0-only', dev: true },
    { name: '@scope/pkg', version: '0.1.0', license: null, dev: false },
    { name: 'opt-dev', version: '1.0.0', license: 'MIT', dev: false },
  ]);
  assert.equal(hasLicenceData(LOCK_V3), true);
  const v1 = { lockfileVersion: 1, dependencies: { x: { version: '1.0.0', dependencies: { y: { version: '2.0.0', dev: true } } } } };
  assert.deepEqual(lockPackages(v1), [
    { name: 'x', version: '1.0.0', license: null, dev: false },
    { name: 'y', version: '2.0.0', license: null, dev: true },
  ]);
  assert.equal(hasLicenceData(v1), false, 'a v1 lockfile records no licences');
  assert.deepEqual(lockPackages(null), []);
  assert.deepEqual(lockPackages({ packages: 'nope' }), []);
  assert.equal(hasLicenceData(null), false);
});

test('addedLines reads git diff -U0, including quoted and spaced paths; isIntroduced works per line', () => {
  const u0 = [
    'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js',
    '@@ -3,0 +4,2 @@ fn', '+x', '+y', '@@ -10 +12 @@', '-old', '+new', '@@ -20,2 +21,0 @@', '-gone', '-gone',
    'diff --git a/my file.js b/my file.js', 'new file mode 100644', '--- /dev/null', '+++ b/my file.js\t', '@@ -0,0 +1 @@', '+z',
    'diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"', '--- "a/caf\\303\\251.js"', '+++ "b/caf\\303\\251.js"', '@@ -1 +1 @@', '-a', '+b',
    'diff --git a/del.js b/del.js', 'deleted file mode 100644', '--- a/del.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-q',
  ].join('\n');
  const added = addedLines(u0);
  assert.deepEqual([...added.keys()], ['src/a.js', 'my file.js', 'café.js']);
  assert.deepEqual([...added.get('src/a.js')], [4, 5, 12]);
  assert.deepEqual([...added.get('my file.js')], [1]);
  assert.equal(unquoteGitPath('"b/x\\"y\\\\z"'), 'b/x"y\\z');
  assert.equal(unquoteGitPath('plain'), 'plain');
  const ctx = { changed: new Set(['src/a.js']), added };
  assert.equal(isIntroduced(ctx, 'src/a.js', 5), true);
  assert.equal(isIntroduced(ctx, 'src/a.js', 1, 3), false, 'an old line in a touched file');
  assert.equal(isIntroduced(ctx, 'src/a.js', 1, 4), true, 'a multi-line result that reaches an added line');
  assert.equal(isIntroduced(ctx, 'old.js', 1), false);
  assert.equal(isIntroduced({ changed: new Set(['old.js']), added: null }, 'old.js', 1), true, 'no line information: the whole changed file counts');
  const whole = { changed: new Set(['new.bin', 'src/a.js']), added, wholeFiles: new Set(['new.bin']) };
  assert.equal(isIntroduced(whole, 'new.bin', 1), true, 'an added or renamed file with no added text lines is fully introduced');
  assert.equal(isIntroduced(whole, 'src/a.js', 1, 3), false, 'wholeFiles does not widen other files');
});

test('lockDelta: new names and changed versions only', () => {
  const basePkgs = [{ name: 'a', version: '1.0.0' }, { name: 'b', version: '1.0.0' }];
  const headPkgs = [{ name: 'a', version: '1.0.0' }, { name: 'b', version: '1.1.0' }, { name: 'c', version: '0.1.0' }];
  assert.deepEqual([...lockDelta(basePkgs, headPkgs)].sort(), ['b', 'c']);
});

test('readLock: from the working tree or from a commit; missing is null', async () => {
  const repo = await makeRepo({ 'package-lock.json': JSON.stringify(LOCK_V3) });
  const sha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  writeFileSync(path.join(repo, 'package-lock.json'), '{ broken');
  assert.equal((await readLock(repo, sha)).lockfileVersion, 3);
  assert.equal(await readLock(repo), null);
  assert.equal(await readLock(await makeRepo(), sha), null);
});

const SEMGREP_OUT = { results: [
  { check_id: 'r.eval', path: 'src/a.js', start: { line: 4 }, extra: { message: 'eval of input\nmore', severity: 'ERROR' } },
  { check_id: 'r.weak', path: 'src/a.js', start: { line: 9 }, extra: { message: 'weak hash', severity: 'WARNING' } },
  { check_id: 'r.info', path: 'src/a.js', start: { line: 1 }, extra: { message: 'fyi', severity: 'INFO' } },
  { check_id: 'r.eval', path: 'old.js', start: { line: 2 }, extra: { message: 'eval of input', severity: 'ERROR' } },
] };

test('parseSemgrep: severity → grade; an untouched file is "already there" (Review Focus 2)', () => {
  const f = parseSemgrep(JSON.stringify(SEMGREP_OUT), { changed: new Set(['src/a.js']) });
  assert.deepEqual(f.map((x) => [x.grade, x.title, x.file, x.line, x.preExisting]), [
    ['blocking', 'eval of input', 'src/a.js', 4, false],
    ['warning', 'weak hash', 'src/a.js', 9, false],
    ['note', 'fyi', 'src/a.js', 1, false],
    ['warning', 'eval of input', 'old.js', 2, true],
  ]);
  assert.equal(f[0].tool, 'semgrep');
  assert.match(f[0].detail, /rule r\.eval/);
  assert.throws(() => parseSemgrep('Login required', { changed: new Set() }));
  assert.throws(() => parseSemgrep('{"errors":[]}', { changed: new Set() }), /no results/);
});

test('parseSemgrep and parseGitleaks: an old line in a file this run touched is still "already there" (Ruling 5)', () => {
  const ctx = { changed: new Set(['src/a.js', 'cfg.js']), added: new Map([['src/a.js', new Set([9])], ['cfg.js', new Set([7])]]) };
  const sem = parseSemgrep(JSON.stringify(SEMGREP_OUT), ctx);
  assert.deepEqual(sem.map((x) => [x.line, x.grade, x.preExisting]), [[4, 'warning', true], [9, 'warning', false], [1, 'note', true], [2, 'warning', true]]);
  const multi = parseSemgrep(JSON.stringify({ results: [{ check_id: 'r', path: 'src/a.js', start: { line: 7 }, end: { line: 10 }, extra: { message: 'm', severity: 'ERROR' } }] }), ctx);
  assert.equal(multi[0].grade, 'blocking', 'its lines 7-10 include the added line 9');
  const leaks = parseGitleaks(JSON.stringify([
    { RuleID: 'aws-access-token', Description: 'AWS Access Key', File: 'cfg.js', StartLine: 3, EndLine: 3 },
    { RuleID: 'aws-access-token', Description: 'AWS Access Key', File: 'cfg.js', StartLine: 7, EndLine: 7 },
  ]), ctx);
  assert.deepEqual(leaks.map((x) => [x.line, x.grade, x.preExisting]), [[3, 'warning', true], [7, 'blocking', false]]);
});

test('parseGitleaks: blocking, and the secret value is never read (Review Focus 5)', () => {
  const text = JSON.stringify([
    { RuleID: 'aws-access-token', Description: 'AWS Access Key', File: './cfg.js', StartLine: 3, Secret: 'AKIAABCDEFGHIJKLMNOP', Match: 'k=AKIAABCDEFGHIJKLMNOP' },
    { RuleID: 'generic-api-key', Description: '', File: 'old/x.env', StartLine: 1, Secret: 'zzzzzzzzzzzz', Match: 'zzzzzzzzzzzz' },
  ]);
  const f = parseGitleaks(text, { changed: new Set(['cfg.js']) });
  assert.doesNotMatch(JSON.stringify(f), /AKIAABCDEFGHIJKLMNOP|zzzzzzzzzzzz/);
  assert.deepEqual(f.map((x) => [x.grade, x.title, x.file, x.line, x.preExisting]), [
    ['blocking', 'Possible secret (AWS Access Key)', 'cfg.js', 3, false],
    ['warning', 'Possible secret (generic-api-key)', 'old/x.env', 1, true],
  ]);
  assert.deepEqual(parseGitleaks('', { changed: new Set() }), []);
});

test('parseNpmAudit: high/critical block when introduced; via-only entries are skipped; errors throw', () => {
  const text = JSON.stringify({ vulnerabilities: {
    lodash: { name: 'lodash', severity: 'high', via: [{ title: 'Prototype Pollution', url: 'u' }], fixAvailable: true },
    minimist: { name: 'minimist', severity: 'critical', via: [{ title: 'Prototype Pollution in minimist' }], fixAvailable: false },
    debug: { name: 'debug', severity: 'moderate', via: [{ title: 'ReDoS' }] },
    ms: { name: 'ms', severity: 'low', via: [{ title: 'tiny' }] },
    express: { name: 'express', severity: 'high', via: ['lodash'] },
  } });
  const f = parseNpmAudit(text, { introduced: new Set(['lodash', 'debug', 'ms']) });
  assert.deepEqual(f.map((x) => [x.title, x.grade, x.preExisting]), [
    ['lodash: Prototype Pollution (high)', 'blocking', false],
    ['minimist: Prototype Pollution in minimist (critical)', 'warning', true],
    ['debug: ReDoS (moderate)', 'warning', false],
    ['ms: tiny (low)', 'note', false],
  ]);
  assert.throws(() => parseNpmAudit(JSON.stringify({ error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' } }), { introduced: new Set() }), /requires an existing lockfile/);
});

test('settingsTouched: a changed scanner-settings file is a locked warning', () => {
  const f = settingsTouched(['src/a.js', '.gitleaks.toml', 'sub/.semgrepignore']);
  assert.deepEqual(f.map((x) => [x.file, x.grade, x.locked, x.tool]), [
    ['.gitleaks.toml', 'warning', true, 'settings'],
    ['sub/.semgrepignore', 'warning', true, 'settings'],
  ]);
  assert.deepEqual(settingsTouched(['src/a.js', '.npmrc.bak']), []);
});

test('suppressionsAdded: a skip-this-line comment on an added line is a locked warning; an old one is ignored', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'a.js'), 'eval(x) // nosemgrep\nconst k = 1; // gitleaks:allow\nrun(); // nosemgrep\n');
  writeFileSync(path.join(dir, 'b.py'), 'x = 1  # nosec\n');
  writeFileSync(path.join(dir, 'c.js'), 'ok();\n// nosecurity is not a marker\n');
  // a.js: only line 2 was added (lines 1 and 3 carry old suppressions); b.py is a new file (all added).
  const added = new Map([['a.js', new Set([2])], ['b.py', new Set()], ['c.js', new Set([1, 2])]]);
  const f = suppressionsAdded({ dir, files: ['a.js', 'b.py', 'c.js', 'gone.js'], changed: new Set(['a.js', 'b.py', 'c.js', 'gone.js']), added, wholeFiles: new Set(['b.py']) });
  assert.deepEqual(f.map((x) => [x.file, x.line, x.grade, x.locked, x.tool, x.member]), [
    ['a.js', 2, 'warning', true, 'settings', 'security'],
    ['b.py', 1, 'warning', true, 'settings', 'security'],
  ]);
  assert.equal(f[0].title, 'This change adds a comment that tells a scanner to skip a line');
  assert.match(f[0].detail, /gitleaks:allow/);
  assert.deepEqual(suppressionsAdded({ dir, files: ['a.js'], changed: new Set(['a.js']), added: new Map([['a.js', new Set()]]) }), []);
});

test('SECURITY.collect: an added suppression comment shows in the settings check', async () => {
  const repo = await makeRepo({ 'old.js': 'eval(x) // nosemgrep\n' });
  writeFileSync(path.join(repo, 'new.js'), 'eval(y) // nosemgrep\n');
  const runs = await SECURITY.collect({ ...(await input(repo, { files: ['new.js'], options: { councilTools: councilStubs(tmp(), {}) } })), added: new Map([['new.js', new Set([1])]]) });
  const settings = runs.find((r) => r.tool === 'settings');
  assert.deepEqual(settings.findings.map((x) => [x.file, x.line, x.grade, x.locked]), [['new.js', 1, 'warning', true]]);
});

async function input(repo, over = {}) {
  const baseSha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  const files = over.files ?? [];
  // added: null = no line information, so a whole changed file counts as introduced (the files here are not committed).
  return { dir: repo, files, changed: new Set(files), added: over.added ?? null, baseSha, tests: null, baseTests: null, request: 'r', plan: null, diff: '', env: process.env, options: { ...DEFAULT_OPTIONS, ...over.options } };
}

test('SECURITY.collect: four checks in order, with exact tool arguments', async () => {
  const repo = await makeRepo({ 'old.js': 'eval(x)\n', 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.20' } } }) });
  writeFileSync(path.join(repo, 'new.js'), 'eval(y)\nconst k = "AKIAABCDEFGHIJKLMNOP";\n');
  writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.20' }, 'node_modules/minimist': { version: '0.0.8' } } }));
  const echoArgs = `console.log(JSON.stringify({ results: [{ check_id: 'x', path: 'zz.js', start: { line: 1 }, extra: { message: args.join(' '), severity: 'INFO' } }] }));`;
  const tools = councilStubs(tmp(), {
    semgrep: SEMGREP_EVAL, gitleaks: GITLEAKS_AKIA,
    'npm-audit': printJson({ vulnerabilities: { minimist: { severity: 'critical', via: [{ title: 'Prototype Pollution' }] }, lodash: { severity: 'high', via: [{ title: 'Prototype Pollution' }] } } }),
  });
  const runs = await SECURITY.collect(await input(repo, { files: ['new.js', 'package-lock.json'], options: { councilTools: tools } }));
  assert.deepEqual(runs.map((r) => [r.tool, r.status]), [['semgrep', 'ran'], ['gitleaks', 'ran'], ['npm-audit', 'ran'], ['settings', 'ran']]);
  const blocking = runs.flatMap((r) => r.findings).filter((f) => f.grade === 'blocking').map((f) => f.title).sort();
  assert.deepEqual(blocking, ['Possible secret (AWS Access Key)', 'Untrusted input reaches eval()', 'minimist: Prototype Pollution (critical)']);
  assert.ok(runs[0].findings.some((f) => f.file === 'old.js' && f.preExisting && f.grade === 'warning'));
  assert.ok(runs[2].findings.some((f) => f.title.startsWith('lodash') && f.preExisting));

  const args = await SECURITY.collect(await input(repo, { options: { councilTools: councilStubs(tmp(), { semgrep: echoArgs }) } }));
  assert.equal(args[0].findings[0].title, 'scan --config p/default --json --quiet --metrics=off --disable-version-check --disable-nosem .');
});

test('SECURITY.collect: no lockfile → the dependency check is skipped with a reason', async () => {
  const runs = await SECURITY.collect(await input(await makeRepo(), { options: { councilTools: councilStubs(tmp(), { 'npm-audit': printJson({}) }) } }));
  assert.equal(runs[2].status, 'skipped');
  assert.equal(runs[2].note, 'There is no package-lock.json, so dependencies were not checked for known security holes (only Node projects are checked in this version).');
  assert.equal(runs[0].status, 'off');
});

test('a crashed scanner is an error, never a clean run', async () => {
  assert.throws(() => parseSemgrep('', { changed: new Set() }));
  assert.throws(() => parseNpmAudit('', { introduced: new Set() }));
  assert.throws(() => parseGitleaks('', { changed: new Set() }, { code: 2 }), /no report/);
  assert.deepEqual(parseGitleaks('  ', { changed: new Set() }, { code: 0 }), []);
  const repo = await makeRepo({ 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }) });
  const crash = 'process.stderr.write("boom"); process.exit(2);';
  const runs = await SECURITY.collect(await input(repo, { options: { councilTools: councilStubs(tmp(), { semgrep: crash, gitleaks: crash, 'npm-audit': crash }) } }));
  assert.deepEqual(runs.map((r) => r.status), ['error', 'error', 'error', 'ran']);
  assert.ok(runs.slice(0, 3).every((r) => r.findings.length === 1 && r.findings[0].grade === 'warning'));
});

test('fix round 1: failed Semgrep, header-like added lines, missing line, gitleaks args', async () => {
  const failed = { results: [], errors: [{ level: 'error', type: 'Fatal error', message: 'Failed to download p/default' }] };
  assert.throws(() => parseSemgrep(JSON.stringify(failed), { changed: new Set() }), /Failed to download/);
  assert.throws(() => parseSemgrep('{"results":[],"errors":[]}', { changed: new Set() }, { code: 2 }), /exit code 2/);
  assert.deepEqual(parseSemgrep('{"results":[],"errors":[{"level":"warn"}]}', { changed: new Set() }, { code: 0 }), []);
  const repo = await makeRepo();
  const bad = `console.log(${JSON.stringify(JSON.stringify(failed))}); process.exit(2);`;
  const runs = await SECURITY.collect(await input(repo, { options: { councilTools: councilStubs(tmp(), { semgrep: bad }) } }));
  assert.equal(runs[0].status, 'error');

  const u0 = ['diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -2 +2 @@', '--- x', '+++ counter',
    '@@ -9,0 +10,2 @@', '+one', '++ two', '\\ No newline at end of file',
    'diff --git a/b.js b/b.js', '--- a/b.js', '+++ b/b.js', '@@ -1,0 +1 @@', '+y'].join('\n');
  const added = addedLines(u0);
  assert.deepEqual([...added.keys()], ['a.js', 'b.js']);
  assert.deepEqual([...added.get('a.js')], [2, 10, 11]);
  assert.deepEqual([...added.get('b.js')], [1]);

  const noLine = JSON.stringify({ results: [{ check_id: 'r', path: 'a.js', extra: { message: 'm', severity: 'ERROR' } }] });
  assert.equal(parseSemgrep(noLine, { changed: new Set(['a.js']), added })[0].grade, 'blocking');
  assert.equal(parseSemgrep(noLine, { changed: new Set(['z.js']), added })[0].preExisting, true);

  const echo = `console.log(JSON.stringify(args)); require('fs').writeFileSync(args[args.indexOf('--report-path') + 1], '[]');`;
  const g = await SECURITY.collect(await input(repo, { options: { councilTools: councilStubs(tmp(), { gitleaks: echo }) } }));
  assert.equal(g[1].status, 'ran');
  // the stub prints its args on stdout; the report is what gets parsed, so check them via a second stub
  const probe = `require('fs').writeFileSync(args[args.indexOf('--report-path') + 1], JSON.stringify([{ RuleID: 'r', Description: args.join(' '), File: 'a.js', StartLine: 1 }]));`;
  const g2 = await SECURITY.collect(await input(repo, { files: ['a.js'], options: { councilTools: councilStubs(tmp(), { gitleaks: probe }) } }));
  assert.equal(g2[1].findings[0].title, 'Possible secret (detect --no-git --source . --report-format json --report-path ' + g2[1].findings[0].title.split('--report-path ')[1]);
  assert.match(g2[1].findings[0].title, /--no-git .*--redact --no-banner --exit-code 0\)$/);
});
