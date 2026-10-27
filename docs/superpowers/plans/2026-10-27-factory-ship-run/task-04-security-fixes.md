# Task 4: Foundation security fixes

`conductor deployments status` lists apps that are behind on foundation security fixes. The foundation marks them in its `CHANGELOG.md` with `- **[security]** …` lines, and its `scripts/changelog.ts` already answers "which released versions newer than X carry a security fix". That file is TypeScript and needs the `semver` package, so Conductor (zero dependencies) carries a faithful port: **the same two regular expressions, the same fail-closed rule on headings it does not understand**, and plain `x.y.z` versions only (the foundation releases nothing else; anything else is "not understood", never "up to date").

The newest foundation release is read from the operator's local foundation checkout (`factory.foundationDir`, default `~/highland-foundation`): the highest `v<x.y.z>` tag, and `CHANGELOG.md` **at that tag** (`git show <tag>:CHANGELOG.md`), so work in progress on a branch never counts.

**Files:**
- Create: `src/factory/ship/securityFixes.js`
- Test: `test/factory-security-fixes.test.js`

**Interfaces:**
- Consumes: `runCommand` (`src/exec.js`), `strictChildEnv`.
- Produces: `isVersion`, `compareVersions`, `parseChangelog`, `securityFixesSince`, `latestFoundation` (index, Task 4).

```js
// The foundation's patterns, verbatim (scripts/changelog.ts at v0.1.0):
const HEADING = /^## \[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$/;
const SECURITY = /^\s*[-*+]\s*\*\*\[\s*security\s*\]\*\*\s*/i;
```

- [ ] **Step 1: Write the failing tests**

```js
// test/factory-security-fixes.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isVersion, compareVersions, parseChangelog, securityFixesSince, latestFoundation } from '../src/factory/ship/securityFixes.js';

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

test('versions are strict x.y.z and compare numerically', () => {
  assert.equal(isVersion('0.10.2'), true);
  for (const v of ['1.0', 'v1.0.0', '1.0.0-rc.1', '01.0.0', '']) assert.equal(isVersion(v), false, v);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3', '1.10.0'), -1);
});

test('securityFixesSince matches the foundation: newer released versions with security lines, newest first, marker removed', () => {
  assert.deepEqual(securityFixesSince(CL, '1.0.0'), [
    { version: '1.1.1', lines: ['Reset links could be reused. Fixed.'] },
    { version: '1.1.0', lines: ['Session cookie lacked SameSite.'] },
  ]);
  assert.deepEqual(securityFixesSince(CL, '1.1.1'), []);
  assert.throws(() => securityFixesSince(CL, 'banana'), /is not a version number/);
});

test('a heading it does not understand stops the check (fail closed)', () => {
  assert.throws(() => parseChangelog('## [1.2.0] - 27/01/2027\n- **[security]** hidden\n'), /not in the expected form/);
  assert.throws(() => parseChangelog('## [1.2.0-beta] - 2027-01-27\n'), /not a version number/);
  assert.equal(parseChangelog(CL)[0].version, 'Unreleased');
});

test('latestFoundation reads CHANGELOG.md at the highest v-tag, not the working tree', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fnd-'));
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
  git('init', '-q');
  writeFileSync(path.join(dir, 'CHANGELOG.md'), '## [0.1.0] - 2026-10-26\n- First.\n'); git('add', '.'); git('commit', '-qm', 'a'); git('tag', 'v0.1.0');
  writeFileSync(path.join(dir, 'CHANGELOG.md'), `## [0.1.1] - 2026-11-02\n- **[security]** Fixed X.\n\n## [0.1.0] - 2026-10-26\n- First.\n`); git('commit', '-qam', 'b'); git('tag', 'v0.1.1');
  writeFileSync(path.join(dir, 'CHANGELOG.md'), '## [9.9.9] - 2026-12-01\n- wip\n'); git('commit', '-qam', 'c');
  git('tag', 'v0.1.10-rc'); // not a release tag: ignored
  const r = await latestFoundation(dir);
  assert.equal(r.ok, true);
  assert.equal(r.version, '0.1.1');
  assert.deepEqual(securityFixesSince(r.changelog, '0.1.0'), [{ version: '0.1.1', lines: ['Fixed X.'] }]);
  const missing = await latestFoundation(path.join(dir, 'nope'));
  assert.equal(missing.ok, false);
  assert.match(missing.problem, /foundation checkout .* could not be read/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/factory-security-fixes.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/factory/ship/securityFixes.js`**

- `isVersion`: `/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/`.
- `parseChangelog` and `securityFixesSince`: line-for-line port of the foundation's functions, with the same error texts, `isVersion` in place of `semver.valid` and `compareVersions` in place of `semver.gt`/`rcompare`.
- `latestFoundation(dir, { env })`: `git -C <dir> tag --list v*`, keep tags whose rest `isVersion`, take the highest by `compareVersions`, then `git -C <dir> show <tag>:CHANGELOG.md`. Any failure → `{ ok: false, problem: 'The foundation checkout at <dir> could not be read, so Conductor cannot tell which security fixes the apps are missing. Set factory.foundationDir in the config to your copy of the foundation.' }`. No tags → `{ ok: false, problem: 'The foundation checkout at <dir> has no release tags …' }`. Expand a leading `~/` with `os.homedir()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/factory-security-fixes.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/ship/securityFixes.js test/factory-security-fixes.test.js
git commit -m "feat(ship): read foundation security fixes from the CHANGELOG at the newest release tag"
```
