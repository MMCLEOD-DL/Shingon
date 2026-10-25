# Task 16: Versioning & release

Spec §5 [call]: "The foundation is versioned. Each client app records the version it was built on. … The factory tells the operator which live apps are behind on a security fix."

This task gives the foundation:
- a semantic version;
- a changelog where security fixes are machine-findable;
- a `foundation.json` stamp that every client app inherits and keeps;
- a `/api/version` endpoint that the monitor and the safe-update check read (Tasks 19–20).

**Files:**
- Create: `foundation.json`, `CHANGELOG.md`, `scripts/{changelog,release,stamp-foundation}.ts`, `apps/server/src/version.ts`, `apps/server/src/http/healthToken.ts`
- Modify: `apps/server/src/app.ts` (route), `apps/server/test/crossing/cases.ts` (nothing needed for a public route; confirm the public-leak test covers it)
- Test: `scripts/changelog.test.ts`, `scripts/release.test.ts`, `apps/server/test/version.test.ts`

**Interfaces:**
- Consumes: `defineRoute` (Task 3), `Config.appVersion` and `Config.commit` (Task 2).
- Produces:
  - `foundation.json`: `{ "name": "highland-foundation", "version": "0.1.0", "commit": "<sha or 'unreleased'>" }`.
    - In the foundation repo, `version` always equals the root `package.json` version.
    - In a client app, the file is left exactly as inherited. It records the foundation release the app was built from.
  - `getVersionInfo(cfg): { app: string; foundation: string; commit: string }`. `foundation` is read once from `foundation.json`, located by walking up from the module's directory, so it works from both `src` and `dist` and inside the image.
  - `GET /api/version` (public: "version check; details only with the health token"):
    - without a valid `x-health-token` header → `{ app }` only. An anonymous visitor must not learn the exact foundation version and commit, which would tell an attacker which `[security]` fixes a box is missing (index Ruling 8);
    - with `x-health-token` equal to `HEALTH_TOKEN` → the full `getVersionInfo` (`{ app, foundation, commit }`). The monitor, the backup manifest (Task 18) and the updater all hold the token.
  - `apps/server/src/http/healthToken.ts`: `hasHealthToken(req, cfg): boolean`. False when `cfg.healthToken` is unset or the header is missing; otherwise compares SHA-256 digests of both values with `timingSafeEqual` (equal lengths, so no length leak). Task 19's `/readyz` reuses it.
  - `scripts/changelog.ts`:
    - `parseChangelog(text): { version: string; date: string | null; lines: string[] }[]`. `Unreleased` appears as `version: 'Unreleased'`.
    - `securityFixesSince(text, version): { version: string; lines: string[] }[]`: released versions semver-greater than `version` that have at least one line starting `- **[security]**`. Newest first; the lines have the marker stripped.
  - `scripts/release.ts`:
    - `planRelease(changelog: string, current: string, bump: 'patch' | 'minor' | 'major', today: string): { version: string; changelog: string }`. It throws `There is nothing under "Unreleased" in CHANGELOG.md, so there is nothing to release.` when that section is empty.
    - CLI `npx tsx scripts/release.ts <bump>`:
      1. requires a clean git tree, otherwise `Commit or stash your changes first.`;
      2. runs `npm audit --omit=dev --audit-level=high --json` and refuses while any high or critical advisory affects a shipped (non-dev) package: `<n> shipped packages have known high-severity security problems (<names>). Update them, or record why each does not apply in CHANGELOG.md, before releasing.` If the audit cannot run (no network), it prints `Could not check for known security problems (npm audit did not run). Check again before shipping.` and continues. This is the release-time half of spec §4.6's "dependency security updates"; the live-deployment half is deferred (index Ruling 9);
      3. writes the changelog, the `package.json` version and `foundation.json`. In `foundation.json`, `commit` is set to the tag name `v<version>`, because the release commit's own sha cannot be known before that commit exists;
      4. commits `release: v<version>` and creates the annotated tag `v<version>`;
      5. **does not push**.
  - `scripts/stamp-foundation.ts`: used by a client app's build (Phase 5). It prints `Built on highland-foundation <version>` and fails if `foundation.json` is missing or malformed.

Changelog format (Keep a Changelog). Security fixes must use the marker:

```markdown
# Changelog

## [Unreleased]

## [0.1.0] - 2026-11-15
- First foundation release: accounts, roles, role-crossing harness, files, email, audit, visual system, backups, monitoring, safe update.
```

Example of a later security entry: `- **[security]** Password reset links could be reused within the same second. Fixed.`

- [ ] **Step 1: Install**

```bash
npm i -D semver@7.8.5 @types/semver
```

- [ ] **Step 2: Write the failing tests**

`scripts/changelog.test.ts`:

```ts
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
```

`scripts/release.test.ts`:

```ts
import { test, expect } from 'vitest';
import { planRelease } from './release.js';

test('moves Unreleased under the new version and leaves an empty Unreleased', () => {
  const r = planRelease('# Changelog\n\n## [Unreleased]\n- Added X.\n\n## [0.1.0] - 2026-11-15\n- First.\n', '0.1.0', 'minor', '2026-12-01');
  expect(r.version).toBe('0.2.0');
  expect(r.changelog).toBe('# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-12-01\n- Added X.\n\n## [0.1.0] - 2026-11-15\n- First.\n');
});
test('refuses an empty release', () => {
  expect(() => planRelease('# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-11-15\n- First.\n', '0.1.0', 'patch', '2026-12-01'))
    .toThrow('There is nothing under "Unreleased" in CHANGELOG.md, so there is nothing to release.');
});
```

`apps/server/test/version.test.ts`:

```ts
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestApp } from './helpers/testApp.js';

const TOKEN = 'v'.repeat(32);
const root = (f: string) => JSON.parse(readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8'));

test('/api/version tells a stranger only the app version', async () => {
  const t = await createTestApp({ appVersion: '3.4.5', commit: 'abc1234', healthToken: TOKEN });
  expect((await t.app.inject({ method: 'GET', url: '/api/version' })).json()).toEqual({ app: '3.4.5' });
  expect((await t.app.inject({ method: 'GET', url: '/api/version', headers: { 'x-health-token': 'nope' } })).json()).toEqual({ app: '3.4.5' });
  await t.close();
});

test('with the health token it adds foundation and commit; foundation.json matches package.json', async () => {
  const t = await createTestApp({ appVersion: '3.4.5', commit: 'abc1234', healthToken: TOKEN });
  const r = await t.app.inject({ method: 'GET', url: '/api/version', headers: { 'x-health-token': TOKEN } });
  expect(r.json()).toEqual({ app: '3.4.5', foundation: root('foundation.json').version, commit: 'abc1234' });
  expect(root('foundation.json').version).toBe(root('package.json').version);
  await t.close();
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run --project scripts --project apps/server test/version.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

Implement the modules exactly as specified in Interfaces. `parseChangelog` splits on `^## \[`.

- [ ] **Step 5: Verify**

Run: `npm run verify`
Expected: all tests PASS (6 new). The crossing suite's public-route leak test now covers `/api/version` too.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: foundation versioning — foundation.json, changelog with security markers, release script, /api/version

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
