import { afterAll, describe, test, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync as readReal } from 'node:fs';
import { judgeAudit, planRelease, runFirstRelease, runRelease, AUDIT_UNAVAILABLE, FIRST_RELEASE_HINT, type ReleaseDeps } from './release.js';

test('moves Unreleased under the new version and leaves an empty Unreleased', () => {
  const r = planRelease('# Changelog\n\n## [Unreleased]\n- Added X.\n\n## [0.1.0] - 2026-11-15\n- First.\n', '0.1.0', 'minor', '2026-12-01');
  expect(r.version).toBe('0.2.0');
  expect(r.changelog).toBe('# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-12-01\n- Added X.\n\n## [0.1.0] - 2026-11-15\n- First.\n');
});
test('refuses an empty release', () => {
  expect(() => planRelease('# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-11-15\n- First.\n', '0.1.0', 'patch', '2026-12-01'))
    .toThrow('There is nothing under "Unreleased" in CHANGELOG.md, so there is nothing to release.');
});

const audit = (vulns: Record<string, string>) => ({ code: Object.keys(vulns).length ? 1 : 0, stdout: JSON.stringify({ vulnerabilities: Object.fromEntries(Object.entries(vulns).map(([k, v]) => [k, { severity: v }])) }) });

test('the audit check passes a clean audit and low or moderate findings', () => {
  expect(judgeAudit(audit({}))).toEqual({ ok: true });
  expect(judgeAudit(audit({ a: 'low', b: 'moderate' }))).toEqual({ ok: true });
});
test('the audit check names high and critical packages in plain English', () => {
  const r = judgeAudit(audit({ zed: 'high', amy: 'critical', mid: 'moderate' }));
  expect(r).toEqual({ ok: false, reason: 'vulnerable', message: '2 shipped packages have known high-severity security problems (amy, zed). Update them, or record why each does not apply in CHANGELOG.md, before releasing.' });
});
test('the audit check fails closed when the audit could not run', () => {
  for (const stdout of ['', 'not json', '{"error":{"code":"ENOTFOUND","summary":"request failed"}}', '{}']) {
    expect(judgeAudit({ code: 1, stdout })).toEqual({ ok: false, reason: 'unavailable', message: AUDIT_UNAVAILABLE });
  }
  expect(AUDIT_UNAVAILABLE).not.toMatch(/at .*:\d+/);
});

// Every temporary release folder is removed after the file's tests.
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function setup(over: Partial<ReleaseDeps> = {}): { deps: ReleaseDeps; calls: string[]; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'hf-release-'));
  roots.push(root);
  writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n- **[security]** Fixed a thing.\n\n## [0.1.0] - 2026-11-15\n- First.\n');
  writeFileSync(path.join(root, 'package.json'), '{\n  "name": "x",\n  "version": "0.1.0"\n}\n');
  writeFileSync(path.join(root, 'foundation.json'), '{\n  "name": "highland-foundation",\n  "version": "0.1.0",\n  "commit": "unreleased"\n}\n');
  const calls: string[] = [];
  const deps: ReleaseDeps = {
    root, today: '2026-12-01',
    isClean: () => { calls.push('clean'); return true; },
    audit: () => { calls.push('audit'); return audit({}); },
    hasGitIdentity: () => true,
    tagExists: () => false,
    versionTags: () => ['v0.1.0'],
    commitAndTag: (v) => { calls.push(`commit+tag v${v}`); },
    ...over,
  };
  return { deps, calls, root };
}

test('a release refuses a dirty tree before auditing or writing anything', () => {
  const { deps, calls, root } = setup({ isClean: () => false });
  expect(() => runRelease('minor', deps)).toThrow('Commit or stash your changes first.');
  expect(calls).toEqual([]);
  expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toContain('0.1.0');
});
test('a release refuses on a failed or missing audit and writes nothing', () => {
  for (const stdout of [JSON.stringify({ vulnerabilities: { bad: { severity: 'high' } } }), '']) {
    const { deps, calls, root } = setup({ audit: () => ({ code: 1, stdout }) });
    expect(() => runRelease('minor', deps)).toThrow(/known high-severity|did not run/);
    expect(calls).not.toContain('commit+tag v0.2.0');
    expect(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')).toContain('## [Unreleased]\n- **[security]**');
  }
});
test('a clean release writes the three files, stamps the tag name and commits and tags', () => {
  const { deps, calls, root } = setup();
  expect(runRelease('minor', deps)).toBe('0.2.0');
  const read = (f: string) => readFileSync(path.join(root, f), 'utf8');
  expect(JSON.parse(read('package.json')).version).toBe('0.2.0');
  expect(JSON.parse(read('foundation.json'))).toEqual({ name: 'highland-foundation', version: '0.2.0', commit: 'v0.2.0' });
  expect(read('CHANGELOG.md')).toContain('## [Unreleased]\n\n## [0.2.0] - 2026-12-01\n- **[security]** Fixed a thing.');
  expect(calls).toEqual(['clean', 'audit', 'commit+tag v0.2.0']);
});

test('refuses before writing anything when the tag exists, git has no identity, or the versions disagree', () => {
  const unchanged = (root: string) => { expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toContain('"0.1.0"'); };
  let s = setup({ tagExists: (t) => t === 'v0.2.0' });
  expect(() => runRelease('minor', s.deps)).toThrow('The tag v0.2.0 already exists');
  unchanged(s.root);
  s = setup({ hasGitIdentity: () => false });
  expect(() => runRelease('minor', s.deps)).toThrow('Git does not know who you are');
  unchanged(s.root);
  s = setup();
  writeFileSync(path.join(s.root, 'foundation.json'), '{"name":"highland-foundation","version":"0.0.9","commit":"unreleased"}');
  expect(() => runRelease('minor', s.deps)).toThrow('foundation.json says 0.0.9 but package.json says 0.1.0');
  expect(s.calls).not.toContain('commit+tag v0.2.0');
});
test('refuses when the changelog already has the new version', () => {
  const s = setup();
  writeFileSync(path.join(s.root, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n- X.\n\n## [0.2.0] - 2026-11-01\n- Y.\n\n## [0.1.0] - 2026-10-26\n- First.\n');
  expect(() => runRelease('minor', s.deps)).toThrow('already has a section for 0.2.0');
});
test('a lock file that is present but unreadable is reported, not skipped', () => {
  const s = setup();
  writeFileSync(path.join(s.root, 'package-lock.json'), '{broken');
  expect(() => runRelease('minor', s.deps)).toThrow();
});

const REAL = readReal(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
test('the real changelog has a dated 0.1.0 under an empty Unreleased, which refuses an empty release', () => {
  expect(REAL).toMatch(/^## \[Unreleased\]\n\n## \[0\.1\.0\] - \d{4}-\d{2}-\d{2}\n- First foundation release/m);
  expect(() => planRelease(REAL, '0.1.0', 'patch', '2026-12-01')).toThrow('There is nothing under "Unreleased"');
});
test('the next release from 0.1.0 is 0.1.1 or 0.2.0 and 0.1.0 stays as released', () => {
  const withEntry = REAL.replace('## [Unreleased]\n', '## [Unreleased]\n- Added Z.\n');
  const patch = planRelease(withEntry, '0.1.0', 'patch', '2026-12-01');
  const minor = planRelease(withEntry, '0.1.0', 'minor', '2026-12-01');
  expect([patch.version, minor.version]).toEqual(['0.1.1', '0.2.0']);
  const released = REAL.slice(REAL.indexOf('## [0.1.0]'));
  expect(patch.changelog.endsWith(released)).toBe(true);
  expect(patch.changelog).toContain('## [Unreleased]\n\n## [0.1.1] - 2026-12-01\n- Added Z.\n\n## [0.1.0]');
});

test('a patch, minor or major release before any release refuses and points at the first release', () => {
  const s = setup({ versionTags: () => [] });
  expect(() => runRelease('patch', s.deps)).toThrow(FIRST_RELEASE_HINT);
  expect(FIRST_RELEASE_HINT).toBe('No release has been made yet. Make the first one with: npm run release -- first');
  expect(s.calls).toEqual(['clean']);
  expect(readFileSync(path.join(s.root, 'package.json'), 'utf8')).toContain('"0.1.0"');
});

describe('the first release (npm run release -- first)', () => {
  const FIRST = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-26\n- First foundation release.\n';
  function first(over: Partial<ReleaseDeps> = {}) {
    const s = setup({ versionTags: () => [], ...over });
    writeFileSync(path.join(s.root, 'CHANGELOG.md'), FIRST);
    return s;
  }
  const read = (root: string, f: string) => readFileSync(path.join(root, f), 'utf8');
  const untouched = (root: string) => {
    expect(JSON.parse(read(root, 'foundation.json'))).toEqual({ name: 'highland-foundation', version: '0.1.0', commit: 'unreleased' });
    expect(read(root, 'CHANGELOG.md')).toBe(FIRST);
  };

  test('tags the version already written, stamps the tag name in foundation.json, and changes nothing else', () => {
    const s = first();
    const pkgBefore = read(s.root, 'package.json');
    expect(runFirstRelease(s.deps)).toBe('0.1.0');
    expect(JSON.parse(read(s.root, 'foundation.json'))).toEqual({ name: 'highland-foundation', version: '0.1.0', commit: 'v0.1.0' });
    expect(read(s.root, 'package.json')).toBe(pkgBefore);
    expect(read(s.root, 'CHANGELOG.md')).toBe(FIRST);
    expect(s.calls).toEqual(['clean', 'audit', 'commit+tag v0.1.0']);
  });
  test('refuses once any release tag exists', () => {
    const s = first({ versionTags: () => ['v0.1.0'] });
    expect(() => runFirstRelease(s.deps)).toThrow('A release has already been made (tag v0.1.0), so this is not the first one. Use npm run release -- patch, minor or major instead.');
    untouched(s.root);
    expect(s.calls).toEqual(['clean']);
  });
  test('refuses a dirty tree before anything else', () => {
    const s = first({ isClean: () => false, versionTags: () => { throw new Error('must not be asked'); } });
    expect(() => runFirstRelease(s.deps)).toThrow('Commit or stash your changes first.');
    untouched(s.root);
  });
  test('refuses when the versions disagree or are not version numbers', () => {
    let s = first();
    writeFileSync(path.join(s.root, 'foundation.json'), '{"name":"highland-foundation","version":"0.0.9","commit":"unreleased"}');
    expect(() => runFirstRelease(s.deps)).toThrow('foundation.json says 0.0.9 but package.json says 0.1.0. They must match before a release');
    expect(s.calls).not.toContain('commit+tag v0.1.0');
    s = first();
    writeFileSync(path.join(s.root, 'package.json'), '{"name":"x","version":"one"}');
    expect(() => runFirstRelease(s.deps)).toThrow('package.json\'s version "one" is not a version number such as 0.1.0.');
  });
  test('refuses without a dated changelog section for the version', () => {
    for (const log of ['# Changelog\n\n## [Unreleased]\n- First.\n', '# Changelog\n\n## [Unreleased]\n\n## [0.1.0]\n- First.\n']) {
      const s = first();
      writeFileSync(path.join(s.root, 'CHANGELOG.md'), log);
      expect(() => runFirstRelease(s.deps)).toThrow('CHANGELOG.md has no dated section for 0.1.0. Add one, such as "## [0.1.0] - 2026-12-01"');
      expect(JSON.parse(read(s.root, 'foundation.json')).commit).toBe('unreleased');
    }
  });
  test('refuses on a failed audit or a missing git identity, writing nothing', () => {
    let s = first({ audit: () => ({ code: 1, stdout: '' }) });
    expect(() => runFirstRelease(s.deps)).toThrow(AUDIT_UNAVAILABLE);
    untouched(s.root);
    s = first({ hasGitIdentity: () => false });
    expect(() => runFirstRelease(s.deps)).toThrow('Git does not know who you are');
    untouched(s.root);
  });
  test('the real repository is ready for its first release: versions match and 0.1.0 is dated', () => {
    const pkg = JSON.parse(readReal(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; scripts: Record<string, string> };
    const found = JSON.parse(readReal(new URL('../foundation.json', import.meta.url), 'utf8')) as { version: string };
    expect([pkg.version, found.version]).toEqual(['0.1.0', '0.1.0']);
    expect(REAL).toMatch(/^## \[0\.1\.0\] - \d{4}-\d{2}-\d{2}$/m);
    expect(pkg.scripts['release']).toBe('tsx scripts/release.ts');
  });
});
