# Task 1: Repo scaffold & licence gate

Every later task assumes one workspace layout, one toolchain and one `npm run verify`. The licence rule in spec §5a ("GPL, AGPL and other copyleft … blocking; unknown or missing licences are also blocking") is enforced here, from the first commit. Every dependency added afterwards then passes through it.

**Files:**
- Create: `/root/highland-foundation/{package.json,.npmrc,.gitignore,tsconfig.base.json,eslint.config.js,vitest.config.ts,licence-exceptions.json}`
- Create: `packages/shared/{package.json,tsconfig.json,src/index.ts}`, `apps/server/{package.json,tsconfig.json,src/index.ts}`, `apps/web/package.json`, `ops/{package.json,tsconfig.json,src/index.ts}`
- Create: `scripts/check-licences.ts`, `scripts/tsconfig.json`
- Test: `scripts/check-licences.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Workspaces `@hf/shared` (`packages/shared`), `@hf/server` (`apps/server`), `@hf/web` (`apps/web`), `@hf/ops` (`ops`).
  - Root scripts:
    - `lint` = `eslint .`
    - `typecheck` = `tsc -b packages/shared apps/server ops scripts && npm -w @hf/web run typecheck --if-present`
    - `licences` = `tsx scripts/check-licences.ts`
    - `test` = `vitest run`
    - `verify` = `npm run lint && npm run typecheck && npm run licences && npm test`
  - `scripts/check-licences.ts` exports:
    - `ALLOWED: ReadonlySet<string>`
    - `isAllowed(expr: string | undefined, allowed?: ReadonlySet<string>): boolean`
    - `collectLicences(rootDir: string): Promise<{ name: string; version: string; licence: string | undefined; path: string }[]>`
    - `checkLicences(rootDir: string, exceptions: Record<string, string>): Promise<{ ok: boolean; problems: string[] }>`
  - Running the file directly prints one plain-English line per problem and exits 1, or prints `All N packages have permissive licences.` and exits 0.

- [ ] **Step 1: Create the repo and the root files**

```bash
mkdir -p /root/highland-foundation && cd /root/highland-foundation && git init -b main
```

`package.json`:

```json
{
  "name": "highland-foundation",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "UNLICENSED",
  "engines": { "node": ">=22.12" },
  "workspaces": ["packages/*", "apps/*", "ops"],
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc -b packages/shared apps/server ops scripts && npm -w @hf/web run typecheck --if-present",
    "licences": "tsx scripts/check-licences.ts",
    "test": "vitest run",
    "verify": "npm run lint && npm run typecheck && npm run licences && npm test"
  }
}
```

(`"license": "UNLICENSED"` is correct for the root: the foundation is Highland's background IP. The licence gate skips the root and workspace packages, because it checks third-party packages only.)

`.npmrc`: `save-exact=true` and `engine-strict=true`. `.gitignore`: `node_modules/`, `dist/`, `reports/`, `test-results/`, `playwright-report/`, `.env`, `*.tsbuildinfo`.

`tsconfig.base.json`: `"target": "ES2023"`, `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": false`, `"declaration": true`, `"composite": true`, `"skipLibCheck": true`, `"verbatimModuleSyntax": true`. Each workspace `tsconfig.json` extends it, with `rootDir: src` and `outDir: dist`. The server and ops reference `packages/shared`.

`vitest.config.ts`: `test.projects = ['packages/shared', 'apps/server', 'apps/web', 'ops', 'scripts']`. Each workspace that has tests gets its own `vitest.config.ts`. The server's config sets `pool: 'forks'`, `testTimeout: 20000` and `include: ['test/**/*.test.ts']`.

`licence-exceptions.json`: `{}`. It maps `"<name>@<version>"` to the operator's reason. It starts empty and must stay empty unless the operator explicitly accepts a licence (spec §5a).

- [ ] **Step 2: Pre-flight the dependency tree, then install the toolchain**

Vitest 5 declares Vite as a **required** peer (`peerDependenciesMeta.vite.optional = false`), so `npm i -D vitest` alone pulls in the newest Vite. Vite 8 depends on `lightningcss`, which is MPL-2.0, so the licence gate would fail at this very commit. Vite 7.3.7 depends only on rollup, esbuild, postcss, fdir, picomatch and tinyglobby (all MIT); `lightningcss` is an optional peer there and is not installed. So pin Vite 7 explicitly, here at the root, and Task 11 uses the same version.

First check the tree before anything lands in `package-lock.json`:

```bash
TOOLCHAIN="typescript@6.0.3 tsx@4.23.15 vitest@5.0.5 vite@7.3.7 eslint@10.13.0 typescript-eslint@8.72.0 prettier@3.9.10 @types/node@22"
npm i -D --dry-run $TOOLCHAIN | tee /tmp/hf-dryrun.txt
grep -i lightningcss /tmp/hf-dryrun.txt && echo "STOP: lightningcss (MPL-2.0) would be installed" || echo "no lightningcss"
```

Expected: `no lightningcss`. If it prints `STOP`, do not install. Check which package pulled it in (`npm explain lightningcss` after a scratch install in `/tmp`) and pin that package back, or ask the operator (index, operator questions).

Then install for real:

```bash
npm i -D $TOOLCHAIN
npm ls vite lightningcss
```

Expected: `npm ls` shows `vite@7.3.7` deduped under `vitest`, and `lightningcss` as `(empty)`. (A throwaway install of exactly this list on 2026-10-25 gave 129 packages: MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause and BlueOak-1.0.0 only.)

Each workspace `package.json`: `"type": "module"`, `"private": true`, `"license": "UNLICENSED"`. For `@hf/shared`, add `"exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }` and `"types": "./dist/index.d.ts"`; Node and `tsc -b` use the built files.

Vitest and Vite must **not** read `dist`, because it is missing or stale until `tsc -b` runs. A "run to verify they fail" step would then fail for the wrong reason, and edits to shared code would go unseen. Every workspace `vitest.config.ts` (and, from Task 11, `apps/web/vite.config.ts`) therefore aliases the package to its source:

```ts
// <workspace>/vitest.config.ts (shape; merge with the per-workspace settings)
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: { '@hf/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) } },
  test: { /* per workspace */ },
});
```

(For `ops/vitest.config.ts` the relative path is `../packages/shared/src/index.ts`.)

`eslint.config.js` uses `typescript-eslint`'s `strictTypeChecked` preset, ignores `**/dist/**` and `apps/web/e2e/**/*.png`, and adds `'no-restricted-syntax'` rules banning direct route registration in `apps/server/src/**`, except in `src/http/route.ts`. Every route must go through `defineRoute` (Task 3). Use this selector, which covers the common names a Fastify instance goes by, not only `app`: `CallExpression[callee.object.name=/^(app|fastify|instance|server)$/][callee.property.name=/^(get|post|put|patch|delete|head|options|all|route)$/]`. The lint rule is a convenience; the runtime gate in Task 8 (`uncoveredRoutes`, which checks **every** route Fastify registered) is the backstop for any name the selector misses.

- [ ] **Step 3: Write the failing licence tests**

`scripts/check-licences.test.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify they fail**

Run: `cd /root/highland-foundation && npx vitest run scripts`
Expected: FAIL. The `./check-licences.js` module is not found.

- [ ] **Step 5: Implement `scripts/check-licences.ts`**

- `ALLOWED` = the ids in the first test's single-licence list.
- `isAllowed`:
  - strip the outer parentheses;
  - if the expression contains ` OR `, return true when **any** branch is allowed;
  - if it contains ` AND `, return true only when **every** part is allowed;
  - otherwise look the id up in `ALLOWED` (case-sensitive SPDX).
  - Nested parentheses beyond one level are not needed, because no allowed package uses them; treat any remaining `(` as not allowed.
- `collectLicences`:
  - walks `rootDir/node_modules`, recursing into `@scope` folders and nested `node_modules`;
  - skips symlinks, which are the workspace links, and the `.bin` and `.package-lock.json` entries;
  - normalises `license` (string), `license.type`, and `licenses[]`, which is joined as `(A OR B)`.
- `checkLicences` sorts the problems by package name and produces the two message forms shown in the test.
- When run directly (`import.meta.url === pathToFileURL(process.argv[1]).href`), it loads `licence-exceptions.json` from the repo root, prints the problems or the success line, and sets `process.exitCode`.

- [ ] **Step 6: Verify**

Run: `npx vitest run scripts && npm run licences && npm ls lightningcss; npm run verify`
Expected: 4 tests PASS. `All N packages have permissive licences.` is printed (N is about 130), `npm ls lightningcss` prints `(empty)`, and `verify` exits 0. (Typecheck and lint pass on the near-empty `src/index.ts` stubs: `export {};`.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold workspaces, toolchain and licence gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
