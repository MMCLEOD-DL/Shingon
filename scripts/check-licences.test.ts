import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isAllowed, collectLicences, collectLockfile, checkLicences, renderMarkdown } from './check-licences.js';

function fakeRepo(pkgs: Record<string, object>, workspaces: string[] = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'lic-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root', workspaces }));
  for (const [name, pj] of Object.entries(pkgs)) {
    const dir = path.join(root, 'node_modules', ...name.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...pj }));
  }
  return root;
}

test('permissive SPDX ids and expressions pass', () => {
  for (const e of ['MIT', 'MIT-0', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Unlicense',
    'CC0-1.0', 'BlueOak-1.0.0', 'CC-BY-4.0', 'Python-2.0', '(MIT OR Apache-2.0)', 'MIT AND ISC', '(MIT OR GPL-3.0)'])
    expect(isAllowed(e), e).toBe(true);
});

test('copyleft, unknown and missing fail', () => {
  for (const e of ['GPL-3.0', 'AGPL-3.0-only', 'LGPL-2.1', 'MPL-2.0', 'EPL-2.0', 'SSPL-1.0', 'UNLICENSED',
    'SEE LICENSE IN LICENSE.md', '(MIT AND GPL-2.0)', 'WTFPL-ish', '', undefined])
    expect(isAllowed(e), String(e)).toBe(false);
});

test('collectLicences reads nested, scoped and legacy fields', async () => {
  const root = fakeRepo({
    a: { license: 'MIT' },
    '@s/b': { license: { type: 'ISC' } },
    c: { licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] },
    'a/node_modules/d': { license: 'BSD-3-Clause' },
  });
  const found = await collectLicences(root);
  const byName = Object.fromEntries(found.map((p) => [p.name, p.licence]));
  expect(byName).toMatchObject({ a: 'MIT', '@s/b': 'ISC', c: '(MIT OR Apache-2.0)', d: 'BSD-3-Clause' });
});

test('checkLicences explains each problem in plain English and honours exceptions', async () => {
  const root = fakeRepo({ good: { license: 'MIT' }, bad: { license: 'GPL-3.0' }, none: {} });
  const r = await checkLicences(root, {});
  expect(r.ok).toBe(false);
  expect(r.problems).toEqual([
    'bad@1.0.0 uses GPL-3.0, which is not on the permissive list (spec §5a). Replace it, or ask the operator to accept it in licence-exceptions.json.',
    'none@1.0.0 has no licence declared. Unknown licences block shipping (spec §5a).',
  ]);
  const ok = await checkLicences(root, { 'bad@1.0.0': 'operator accepted 2026-11-01 for X', 'none@1.0.0': 'checked LICENSE file: MIT' });
  expect(ok).toEqual({ ok: true, problems: [] });
});

test('scans workspace-local node_modules', async () => {
  const root = fakeRepo({ good: { license: 'MIT' } }, ['apps/*']);
  const dir = path.join(root, 'apps', 'x', 'node_modules', 'pkg');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pkg', version: '2.0.0', license: 'GPL-3.0' }));
  const r = await checkLicences(root, {});
  expect(r.ok).toBe(false);
  expect(r.problems[0]).toContain('pkg@2.0.0 uses GPL-3.0');
});

test('an empty or missing node_modules fails', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lic-'));
  const r = await checkLicences(root, {});
  expect(r.ok).toBe(false);
  expect(r.problems[0]).toContain('npm ci');
});

test('an exception needs a non-blank reason', async () => {
  const root = fakeRepo({ bad: { license: 'GPL-3.0' } });
  for (const reason of ['', '   ', 5 as unknown as string]) {
    const r = await checkLicences(root, { 'bad@1.0.0': reason });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain('no reason');
  }
});

test('a malformed package.json is reported with its path', async () => {
  const root = fakeRepo({ good: { license: 'MIT' } });
  const dir = path.join(root, 'node_modules', 'broken');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'package.json'), '{ nope');
  const r = await checkLicences(root, {});
  expect(r.ok).toBe(false);
  expect(r.problems.join('\n')).toContain(path.join(dir, 'package.json'));
});

test('an alias shows both names but exceptions use the folder name', async () => {
  const root = fakeRepo({ alias: { name: 'real-name', license: 'GPL-3.0' } });
  const r = await checkLicences(root, {});
  expect(r.problems[0]).toContain('alias (real-name)@1.0.0');
  expect((await checkLicences(root, { 'alias@1.0.0': 'ok' })).ok).toBe(true);
});

test('the licence document lists packages and the fixed image section', async () => {
  const root = fakeRepo({ b: { license: 'ISC' }, a: { license: 'MIT' } });
  const md = renderMarkdown(await collectLicences(root));
  expect(md).toContain('| Package | Version | Licence |');
  expect(md.indexOf('| a | 1.0.0 | MIT |')).toBeLessThan(md.indexOf('| b | 1.0.0 | ISC |'));
  expect(md).toContain('## Container images');
  expect(md).toContain('| restic | BSD-2-Clause |');
});

/** A lockfile beside the fake repo's node_modules. Keys are lockfile paths, as npm writes them. */
function withLockfile(root: string, packages: Record<string, object>): string {
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'root', lockfileVersion: 3, packages: { '': { name: 'root' }, ...packages } }));
  return root;
}

test('the lockfile lists every package, including platform-specific ones, but not the root, workspaces or links', async () => {
  const root = withLockfile(fakeRepo({ a: { license: 'MIT' } }), {
    'node_modules/a': { version: '1.0.0', license: 'MIT' },
    'node_modules/@esbuild/darwin-arm64': { version: '0.25.0', license: 'MIT', os: ['darwin'], cpu: ['arm64'], optional: true },
    'node_modules/a/node_modules/b': { version: '2.0.0', license: 'ISC' },
    'apps/web': { name: '@hf/web', license: 'UNLICENSED' },
    'node_modules/@hf/web': { resolved: 'apps/web', link: true },
    'apps/web/node_modules/c': { version: '3.0.0', license: { type: 'Apache-2.0' } },
  });
  const found = await collectLockfile(root);
  expect(found?.map((p) => `${p.name}@${p.version}:${String(p.licence)}`).sort()).toEqual([
    '@esbuild/darwin-arm64@0.25.0:MIT', 'a@1.0.0:MIT', 'b@2.0.0:ISC', 'c@3.0.0:Apache-2.0',
  ]);
  expect(await collectLockfile(fakeRepo({}))).toBeNull();
});

test('the gate checks lockfile entries this machine did not install (another OS or CPU)', async () => {
  const root = withLockfile(fakeRepo({ a: { license: 'MIT' } }), {
    'node_modules/a': { version: '1.0.0', license: 'MIT' },
    'node_modules/@x/win32-x64': { version: '1.2.3', license: 'GPL-3.0', os: ['win32'], cpu: ['x64'], optional: true },
    'node_modules/@x/linux-arm64': { version: '1.2.3', os: ['linux'], cpu: ['arm64'], optional: true },
  });
  const r = await checkLicences(root, {});
  expect(r.ok).toBe(false);
  expect(r.problems).toEqual([
    '@x/linux-arm64@1.2.3 has no licence declared. Unknown licences block shipping (spec §5a).',
    '@x/win32-x64@1.2.3 uses GPL-3.0, which is not on the permissive list (spec §5a). Replace it, or ask the operator to accept it in licence-exceptions.json.',
  ]);
  expect((await checkLicences(root, { '@x/win32-x64@1.2.3': 'operator accepted', '@x/linux-arm64@1.2.3': 'checked: MIT' })).ok).toBe(true);
});

test('the licence document made from the lockfile includes every platform build, in name order', async () => {
  const root = withLockfile(fakeRepo({}), {
    'node_modules/zed': { version: '1.0.0', license: 'MIT' },
    'node_modules/@esbuild/win32-x64': { version: '0.25.0', license: 'MIT', os: ['win32'], cpu: ['x64'] },
    'node_modules/@esbuild/linux-x64': { version: '0.25.0', license: 'MIT', os: ['linux'], cpu: ['x64'] },
  });
  const md = renderMarkdown((await collectLockfile(root)) ?? []);
  const rows = md.split('\n').filter((l) => /^\| (@|zed)/.test(l));
  expect(rows).toEqual(['| @esbuild/linux-x64 | 0.25.0 | MIT |', '| @esbuild/win32-x64 | 0.25.0 | MIT |', '| zed | 1.0.0 | MIT |']);
});
