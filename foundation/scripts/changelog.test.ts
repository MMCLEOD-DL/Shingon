import { test, expect } from 'vitest';
import { parseChangelog, securityFixesSince } from './changelog.js';

const CL = `# Changelog

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

test('parses versions, dates and lines', () => {
  const p = parseChangelog(CL);
  expect(p.map((s) => [s.version, s.date])).toEqual([['Unreleased', null], ['1.2.0', '2027-02-01'], ['1.1.1', '2027-01-10'], ['1.1.0', '2026-12-01']]);
});

test('finds released security fixes newer than an app\'s foundation version', () => {
  expect(securityFixesSince(CL, '1.1.0')).toEqual([{ version: '1.1.1', lines: ['Reset links could be reused. Fixed.'] }]);
  expect(securityFixesSince(CL, '1.1.1')).toEqual([]);
  expect(securityFixesSince(CL, '1.0.0').map((s) => s.version)).toEqual(['1.1.1', '1.1.0']);
});

test('an unreleased fix is never reported, and a bad version is explained', () => {
  expect(securityFixesSince(CL, '0.0.1').map((s) => s.version)).not.toContain('Unreleased');
  expect(() => securityFixesSince(CL, 'banana')).toThrow('is not a version number');
});

test('fails closed on a heading it does not understand, quoting the line', () => {
  for (const h of ['## [1.1.1] - 2027-01-10 (yanked)', '## [1.1.1] - 2027-1-5', '## [1.1.1](https://example.test/compare)', '## [banana] - 2027-01-10', '## [1.1.1]- 2027-01-10x']) {
    expect(() => securityFixesSince(`# Changelog\n\n## [Unreleased]\n\n${h}\n- **[security]** Hidden fix.\n`, '1.0.0'), h).toThrow(`"${h}"`);
    expect(() => parseChangelog(`${h}\n`)).toThrow(`"${h}"`);
  }
});
test('the security marker is case-insensitive and accepts any bullet, spacing and indentation', () => {
  const lines = ['- **[security]** A.', '* **[Security]** B.', '+ **[SECURITY]**C.', '-   **[security]**   D.', '  - **[security]** E.', '\t* **[Security]** F.'];
  const r = securityFixesSince(`## [1.1.0] - 2027-01-10\n${lines.join('\n')}\n- Not a security line. [security]\n- **Security** nope\n`, '1.0.0');
  expect(r).toEqual([{ version: '1.1.0', lines: ['A.', 'B.', 'C.', 'D.', 'E.', 'F.'] }]);
});
