import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isAllowed, collectLicences, checkLicences } from './check-licences.js';

function fakeRepo(pkgs: Record<string, object>) {
  const root = mkdtempSync(path.join(tmpdir(), 'lic-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root', workspaces: [] }));
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
