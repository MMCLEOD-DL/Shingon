# Task 4: Foundation changelog reader (`src/factory/foundationLog.js`)

`conductor deployments status` lists apps that are behind on foundation security fixes. The foundation marks them in its `CHANGELOG.md` with `- **[security]** …` lines, and its `scripts/changelog.ts` already answers "which released versions newer than X carry a security fix". That file is TypeScript and needs the `semver` package, so Conductor (zero dependencies) carries a faithful port: **the same two regular expressions, the same error messages, the same fail-closed rule on headings it does not understand**.

Contract 7 §7.1 makes this module shared: **Plan 10 owns `src/factory/foundationLog.js`** with exactly `parseVersion`, `compareVersions`, `parseChangelog` and `securityFixesSince`. Plan 11 later adds `changesBetween`, `releaseTags` and `readChangelogAt` to the same file and must not redefine these four. So this task builds them to the shape Plan 11 relies on: `parseVersion` returns the parts (with pre-release identifiers) and `compareVersions` follows semver precedence, including pre-releases, and throws on anything that is not a version.

Reading the newest foundation release from the foundation repo (`latestFoundation`) is **not** here: it is git work, it belongs to `deployments status`, and it lives in Task 11's `src/factory/ship/status.js`.

**Files:**
- Create: `src/factory/foundationLog.js`
- Test: `test/factory-foundation-log.test.js`

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces (index, Task 4; Contract 7 §7.1):

```js
parseVersion(s) -> { major, minor, patch, pre: Array<string|number> } | null   // strict x.y.z[-pre][+build]; no leading 'v'
compareVersions(a, b) -> -1 | 0 | 1          // semver precedence (build metadata ignored); throws on an invalid version
parseChangelog(text) -> [{ version, date: string|null, lines: string[] }]      // 'Unreleased' kept as a version name; throws the foundation's messages
securityFixesSince(text, version) -> [{ version, lines }]                       // released versions newer than `version`, newest first, marker removed
```

```js
// The foundation's patterns, verbatim (scripts/changelog.ts at v0.1.0):
const HEADING = /^## \[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$/;
const SECURITY = /^\s*[-*+]\s*\*\*\[\s*security\s*\]\*\*\s*/i;
// Version grammar (semver 2.0.0, strict: no leading 'v', no leading zeros in numeric parts):
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
```

Where the port is stricter than `semver.valid` (which also accepts a leading `v` or `=`), it fails closed: a heading such as `## [v1.2.0]` throws instead of being read.

- [ ] **Step 1: Write the failing tests**

```js
// test/factory-foundation-log.test.js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/factory-foundation-log.test.js`
Expected: FAIL, `Cannot find module '../src/factory/foundationLog.js'`.

- [ ] **Step 3: Implement `src/factory/foundationLog.js`**

- `parseVersion`: `VERSION.exec(String(s ?? ''))`; `pre` splits group 4 on `.`, turning all-digit identifiers into numbers. Non-strings → `null`.
- `compareVersions(a, b)`: parse both (an invalid one throws `"<s>" is not a version number such as 1.2.3.`); compare major, minor, patch numerically; then pre-release per semver §11 (no `pre` ranks higher than any `pre`; identifiers compared left to right, numbers below strings, numbers numerically, strings by code unit; a shorter list that is a prefix ranks lower).
- `parseChangelog`, `securityFixesSince`: line-for-line ports of the foundation's functions (split on `/^(?=## \[)/m`, skip the chunk before the first heading, the same two error texts, lines `trimEnd`ed and blank lines dropped), with `parseVersion(v) !== null` for `semver.valid`, `compareVersions(x, v) > 0` for `semver.gt` and `-compareVersions` for `semver.rcompare`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/factory-foundation-log.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/foundationLog.js test/factory-foundation-log.test.js
git commit -m "feat(factory): foundation changelog reader, a port of securityFixesSince

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
