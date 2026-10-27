import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions, parseChangelog, securityFixesSince } from '../src/factory/foundationLog.js';

const CL = `# Changelog

## [Unreleased]
- **[security]** Not released yet.

## [1.1.1] - 2027-02-01
- **[security]** Reset links could be reused. Fixed.
- Faster lists.

## [1.1.0] - 2027-01-10
* **[ Security ]** Session cookie lacked SameSite.

## [1.0.0] - 2026-12-01
- First.
`;

test('parseVersion is strict semver without a leading v', () => {
  assert.deepEqual(parseVersion('0.10.2'), { major: 0, minor: 10, patch: 2, pre: [] });
  assert.deepEqual(parseVersion('1.0.0-rc.1+build.5'), { major: 1, minor: 0, patch: 0, pre: ['rc', 1] });
  for (const v of ['1.0', 'v1.0.0', '01.0.0', '1.0.0-01', '', null]) assert.equal(parseVersion(v), null, String(v));
});

test('compareVersions follows semver precedence, including pre-releases, and throws on nonsense', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3+other'), 0);
  assert.equal(compareVersions('1.2.3', '1.10.0'), -1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  assert.throws(() => compareVersions('1.0', '1.0.0'), /"1\.0" is not a version number such as 1\.2\.3\./);
});

test('securityFixesSince matches the foundation: newer released versions with security lines, newest first, marker removed', () => {
  assert.deepEqual(securityFixesSince(CL, '1.0.0'), [
    { version: '1.1.1', lines: ['Reset links could be reused. Fixed.'] },
    { version: '1.1.0', lines: ['Session cookie lacked SameSite.'] },
  ]);
  assert.deepEqual(securityFixesSince(CL, '1.1.1'), []);
  assert.ok(!securityFixesSince(CL, '0.0.1').some((s) => s.version === 'Unreleased'));
  assert.throws(() => securityFixesSince(CL, 'v1.0.0'), { message: '"v1.0.0" is not a version number such as 1.2.3.' });
});

test('a heading it does not understand stops the check with the foundation\'s own message (fail closed)', () => {
  assert.throws(() => parseChangelog('## [1.2.0] - 27/01/2027\n- **[security]** hidden\n'),
    { message: 'CHANGELOG.md has a heading that is not in the expected form: "## [1.2.0] - 27/01/2027". Use "## [1.2.3] - 2026-01-31" (a two-digit month and day) or "## [Unreleased]".' });
  assert.throws(() => parseChangelog('## [banana] - 2027-01-27\n'),
    { message: 'CHANGELOG.md has a heading with a version that is not a version number: "## [banana] - 2027-01-27".' });
  assert.throws(() => parseChangelog('## [v1.2.0] - 2027-01-27\n'), /not a version number/);
  assert.deepEqual(parseChangelog(CL).map((s) => s.version), ['Unreleased', '1.1.1', '1.1.0', '1.0.0']);
  assert.equal(parseChangelog(CL)[1].date, '2027-02-01');
});

// Parity with the foundation's own scripts/changelog.test.ts examples.
const FCL = `# Changelog

## [Unreleased]
- **[security]** Not released yet.

## [1.2.0] - 2027-02-01
- Added scheduled jobs.

## [1.1.1] - 2027-01-10
- **[security]** Reset links could be reused. Fixed.
- Tidied the profile page.

## [1.1.0] - 2026-12-01
- **[security]** Old fix.
`;

test('foundation parity: versions, dates, security fixes newer than an app version', () => {
  assert.deepEqual(parseChangelog(FCL).map((s) => [s.version, s.date]),
    [['Unreleased', null], ['1.2.0', '2027-02-01'], ['1.1.1', '2027-01-10'], ['1.1.0', '2026-12-01']]);
  assert.deepEqual(securityFixesSince(FCL, '1.1.0'), [{ version: '1.1.1', lines: ['Reset links could be reused. Fixed.'] }]);
  assert.deepEqual(securityFixesSince(FCL, '1.1.1'), []);
  assert.deepEqual(securityFixesSince(FCL, '1.0.0').map((s) => s.version), ['1.1.1', '1.1.0']);
  assert.ok(!securityFixesSince(FCL, '0.0.1').some((s) => s.version === 'Unreleased'));
  assert.throws(() => securityFixesSince(FCL, 'banana'), /is not a version number/);
});

test('foundation parity: headings it does not understand fail closed, quoting the line', () => {
  for (const h of ['## [1.1.1] - 2027-01-10 (yanked)', '## [1.1.1] - 2027-1-5', '## [1.1.1](https://example.test/compare)', '## [banana] - 2027-01-10', '## [1.1.1]- 2027-01-10x']) {
    assert.throws(() => securityFixesSince(`# Changelog\n\n## [Unreleased]\n\n${h}\n- **[security]** Hidden fix.\n`, '1.0.0'), (e) => e.message.includes(`"${h}"`), h);
    assert.throws(() => parseChangelog(`${h}\n`), (e) => e.message.includes(`"${h}"`), h);
  }
});

test('foundation parity: the security marker is case-insensitive and accepts any bullet, spacing and indentation', () => {
  const lines = ['- **[security]** A.', '* **[Security]** B.', '+ **[SECURITY]**C.', '-   **[security]**   D.', '  - **[security]** E.', '\t* **[Security]** F.'];
  const r = securityFixesSince(`## [1.1.0] - 2027-01-10\n${lines.join('\n')}\n- Not a security line. [security]\n- **Security** nope\n`, '1.0.0');
  assert.deepEqual(r, [{ version: '1.1.0', lines: ['A.', 'B.', 'C.', 'D.', 'E.', 'F.'] }]);
});

test('newest first is semver order, not file order, and pre-releases sort below their release', () => {
  const t = '## [1.0.0-rc.1] - 2027-01-01\n- **[security]** a\n## [1.0.0] - 2027-01-02\n- **[security]** b\n## [0.10.0] - 2026-01-01\n- **[security]** c\n';
  assert.deepEqual(securityFixesSince(t, '0.9.0').map((s) => s.version), ['1.0.0', '1.0.0-rc.1', '0.10.0']);
});
