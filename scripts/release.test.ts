import { test, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync as readReal } from 'node:fs';
import { judgeAudit, planRelease, runRelease, AUDIT_UNAVAILABLE, type ReleaseDeps } from './release.js';

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

function setup(over: Partial<ReleaseDeps> = {}): { deps: ReleaseDeps; calls: string[]; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'hf-release-'));
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
