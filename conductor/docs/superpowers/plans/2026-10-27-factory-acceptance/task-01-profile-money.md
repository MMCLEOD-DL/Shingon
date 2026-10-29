# Task 1: Module workspaces, app profile and money helpers

**Repo: `/root/highland-foundation`, branch `plan12-modules` (create it from `main` at `v0.1.0`).**

This task lays the plumbing every module needs and nothing module-specific:
- the `modules/*` workspaces;
- `app-profile.json`, the one committed file that says which modules are on and what the data policy allows (Ruling 7). Conductor writes it from the approved brief: Plan 8's `nameApp` at the first build (in the BRAND-line commit, Contract 7.11), Plan 11 on a change that alters `modules` or `policy` (Contract 7.5). Its shape is this task's `AppProfileSchema`;
- the money helpers of Ruling 3, which Tasks 2, 7 and 8 build on;
- a licence pre-flight of every package this plan will install, before any of them touch the foundation's lockfile.

**Files:**
- Create: `app-profile.json`, `packages/shared/src/modules.ts`, `packages/shared/src/money.ts`, `apps/server/src/appProfile.ts`
- Create: `modules/ocr/`, `modules/pdf-export/`, `modules/xlsx-export/`, each with `package.json` (`@hf/ocr`, `@hf/pdf-export`, `@hf/xlsx-export`, version `0.1.0`, `"license": "UNLICENSED"`, `"type": "module"`, `exports` like `@hf/shared`), `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `src/index.ts` (empty export for now)
- Modify: `package.json` (workspaces add `"modules/*"`; `typecheck` adds `modules/ocr modules/pdf-export modules/xlsx-export`), `vitest.config.ts` (projects add the three), `packages/shared/src/index.ts`, `apps/server/src/config.ts`, `apps/web/vite.config.ts`, `apps/web/src/vite-env.d.ts` (or the existing ambient types file), `CHANGELOG.md` (Unreleased)
- Test: `packages/shared/test/money.test.ts`, `packages/shared/test/modules.test.ts`, `apps/server/test/app-profile.test.ts`

**Interfaces:**
- Consumes: `ConfigError` and `loadConfig` (Plan 6 Task 2).
- Produces: `MODULES`, `ModuleName`, `RESIDENCIES`, `Residency`, `AppProfileSchema`, `AppProfile`, `DEFAULT_PROFILE`, `loadAppProfile`, `moduleOn`, `Config.profile`, `Config.ocr`, `__HF_MODULES__`, and the money helpers. Exact signatures are in the index's Shared Interfaces.

- [ ] **Step 1: Licence pre-flight (nothing is installed in the foundation yet)**

In a throwaway folder outside the repo:

```bash
d=$(mktemp -d) && cd "$d" && echo '{"name":"preflight","version":"1.0.0"}' > package.json
npm i --ignore-scripts --no-audit --no-fund --package-lock-only \
  tesseract.js@7.0.0 @tesseract.js-data/eng@1.0.0 pdfjs-dist@6.4.299 \
  write-excel-file@4.1.1 read-excel-file@9.3.12 pdfkit@0.20.2
```

Then check every `packages` entry in that `package-lock.json` with the foundation's own `isAllowed` (import it from `/root/highland-foundation/scripts/check-licences.ts` with `npx tsx`).
Expected: exactly one problem, `node_modules/png-js` 2.0.0 with no licence (Operator question 1). Anything else that fails means a registry change since 2026-10-27: **stop and tell the operator**. Delete the folder.

- [ ] **Step 2: Write the failing tests**

`packages/shared/test/money.test.ts`:

```ts
import { test, expect } from 'vitest';
import { toPence, formatPounds, sumPence, vatFromGross, MoneyError } from '../src/money.js';

test('toPence reads pounds exactly', () => {
  expect(toPence('12.40')).toBe(1240);
  expect(toPence('£1,234.56')).toBe(123456);
  expect(toPence('0.1')).toBe(10);
  expect(toPence('7')).toBe(700);
  expect(toPence('-5.00')).toBe(-500);
});
test('toPence refuses what is not money', () => {
  for (const bad of ['12.345', '', 'abc', '1,23.00', '£', '1e3', '90071992547409.92']) expect(() => toPence(bad)).toThrow(MoneyError);
});
test('formatPounds', () => {
  expect(formatPounds(1240)).toBe('£12.40');
  expect(formatPounds(123456)).toBe('£1,234.56');
  expect(formatPounds(0)).toBe('£0.00');
  expect(formatPounds(-500)).toBe('−£5.00');
  expect(formatPounds(24691200)).toBe('£246,912.00');
});
test('sumPence never drifts: 10p + 20p is 30p', () => {
  expect(sumPence([10, 20])).toBe(30);
  expect(sumPence([])).toBe(0);
  expect(() => sumPence([10, 0.5])).toThrow(MoneyError);
});
test('vatFromGross: half up, integers only (spec example £12.40 -> £2.07)', () => {
  expect(vatFromGross(1240, 2000)).toBe(207);
  expect(vatFromGross(4500, 2000)).toBe(750);
  expect(vatFromGross(875, 2000)).toBe(146);
  expect(vatFromGross(2399, 2000)).toBe(400);
  expect(vatFromGross(3, 2000)).toBe(1);     // 0.5p rounds up
  expect(vatFromGross(9, 2000)).toBe(2);     // 1.5p rounds up
  expect(vatFromGross(1050, 500)).toBe(50);  // 5% rate
  expect(vatFromGross(1240, 0)).toBe(0);
});
```

`packages/shared/test/modules.test.ts`:

```ts
import { test, expect } from 'vitest';
import { AppProfileSchema, DEFAULT_PROFILE, MODULES } from '../src/modules.js';

test('the default profile turns nothing on and lets nothing out', () => {
  expect(DEFAULT_PROFILE).toEqual({ schema: 1, modules: [], policy: { outbound: [], residency: 'uk' } });
  expect(MODULES).toEqual(['ocr', 'pdf-export', 'xlsx-export', 'scheduled-jobs']);
});
test('unknown modules, keys and odd outbound ids are refused', () => {
  expect(AppProfileSchema.safeParse({ ...DEFAULT_PROFILE, modules: ['payments'] }).success).toBe(false);
  expect(AppProfileSchema.safeParse({ ...DEFAULT_PROFILE, extra: 1 }).success).toBe(false);
  expect(AppProfileSchema.safeParse({ ...DEFAULT_PROFILE, policy: { outbound: ['Azure OCR'], residency: 'uk' } }).success).toBe(false);
  expect(AppProfileSchema.safeParse({ ...DEFAULT_PROFILE, policy: { outbound: ['azure-document-intelligence'], residency: 'uk' } }).success).toBe(true);
});
```

`apps/server/test/app-profile.test.ts`:
- `'a missing file gives the default profile'`: `loadAppProfile(<tmp>/none.json)` equals `DEFAULT_PROFILE`.
- `'a bad file stops start-up with plain sentences'`: invalid JSON → `ConfigError` whose `problems[0]` is `app-profile.json could not be read as JSON. Check the file for a typing mistake.`; `{ "schema": 1, "modules": ["ocr","ocr"], "policy": { "outbound": [], "residency": "mars" } }` → problems contain `app-profile.json lists the module "ocr" twice.` and `app-profile.json has an unknown residency "mars". Use uk, uk-eu or any.`
- `'loadConfig carries the profile and OCR settings'`: with `APP_PROFILE` pointing to a file listing `ocr`, `loadConfig` returns `profile.modules === ['ocr']` and `ocr` equal to `{ engine: 'local', concurrency: 1, timeoutMs: 60000 }`; `OCR_CONCURRENCY=9` → `ConfigError` with `OCR_CONCURRENCY must be a whole number from 1 to 4.`; `OCR_ENGINE=azure` without the three Azure variables → one problem per missing variable, e.g. `OCR_AZURE_KEY is needed when OCR_ENGINE is azure.`, and the key's value is never in any message.
- `'the committed app-profile.json is the default'`: reading the repo root file equals `DEFAULT_PROFILE`.

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run packages/shared/test/money.test.ts packages/shared/test/modules.test.ts apps/server/test/app-profile.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement**

- `packages/shared/src/money.ts` and `modules.ts` exactly as the index's Shared Interfaces. `vatFromGross` uses integer arithmetic only: `n = gross * rate; d = 10000 + rate; return Math.floor((2 * n + d) / (2 * d))` for `gross >= 0`; for a negative gross return `-vatFromGross(-gross, rate)`. Throw `MoneyError` when `gross * rate` is not a safe integer.
- `apps/server/src/appProfile.ts`: `loadAppProfile(file)` reads, parses and validates; Zod issues are turned into the sentences above, never shown raw.
- `config.ts`: add `profile` and `ocr` (env names in the index). `OCR_AZURE_ENDPOINT` must be `https://`, except `http://127.0.0.1:<port>` when `INSTANCE_MODE=test`.
- `app-profile.json` at the repo root: `DEFAULT_PROFILE`, pretty-printed.
- `apps/web/vite.config.ts`: read `../../app-profile.json` with `AppProfileSchema` (fall back to the default when the file is missing) and `define: { __HF_MODULES__: JSON.stringify(profile.modules) }`; declare the constant in the web's ambient types. The e2e build overrides it with every module (env `HF_ALL_MODULES=1`), see Task 6.
- Module workspaces: copy `packages/shared`'s `tsconfig*.json` and `vitest.config.ts` pattern; each `src/index.ts` is `export {};` for now.
- `CHANGELOG.md` Unreleased: `- Optional modules: app-profile.json chooses modules and the data policy; money helpers in whole pence.`

- [ ] **Step 5: Run the tests, then the full gate**

Run: `npx vitest run packages/shared apps/server/test/app-profile.test.ts` → PASS.
Run: `npm run verify` → PASS (lint, typecheck including the three new workspaces, licences unchanged, all tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: module workspaces, app-profile.json and money helpers in whole pence

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
