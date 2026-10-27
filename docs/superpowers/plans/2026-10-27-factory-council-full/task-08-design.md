# Task 8: Design member

Design checks spec §2 item 3 ("it must look professional"). Its tools are the foundation's browser gate, run by the council's gates in Task 4, plus axe-core and a house-style check. The LLM judges the screenshots against the house visual system (prompt in Task 7). Design blocks **only** for broken or unusable layouts proven by the page gate (index Ruling 6).

Its four ToolRuns, in order:

1. **`page-gate`** reads `input.evidence.gates.browser`: the cases from `responsive.spec.ts` that are neither ok nor skipped. There is one **locked blocking** finding per page and project, named from the assertion message the foundation writes:

   | Message contains | Title |
   |---|---|
   | `the page scrolls sideways` | `The <page> page scrolls sideways on <width>` |
   | `buttons and fields too small to tap` | `The <page> page has buttons or fields too small to tap on <width>` |
   | `script errors on the page` | `The <page> page has script errors on <width>` |
   | anything else | `The <page> page does not load properly on <width>` |

   `<page>` comes from the test title `<page> works at this width`. `<width>` is `desktop` for `desktop-chromium`, `a phone (Chrome)` for `mobile-chromium` and `a phone (Safari)` for `mobile-webkit`. The detail is the assertion message. `context` = `Pages checked: <n> pages × <projects>. <k> failed.`. `attach` = every screenshot file.
2. **`registry`**: a failure of `registry.spec.ts` is one **locked blocking** finding, `A page has no screenshot check, so it was never looked at on a phone`, with the message (which names the missing paths) as detail.
3. **`axe`** reads `input.evidence.gates.a11y`. There is one finding per axe rule id across all pages: **warning** when any occurrence is `critical` or `serious`, otherwise **note**. Title: `Accessibility: <help> (<n> page|pages)`. Detail: up to 10 `page on project: <nodes> places, e.g. <target>`. When axe did not run, the ToolRun is `missing` / `off` / `error` from `gates.axe` (Task 4's `detectAxe` result, carried in `GatesResult.axe`). For `error` it adds the warning `axe-core could not be used`.
4. **`house-style`** scans `input.files` under `apps/web/src/` (`.ts`, `.tsx`, `.css`; not `apps/web/src/theme.ts`). There is one finding per file and kind:
   - a hex colour in a string → warning `<file> sets colours by hand instead of using the theme`;
   - `fonts.googleapis`, `fonts.gstatic`, `@font-face` or `@import url(` → warning `<file> loads a web font, which the house style avoids (it can also need a licence and sends visitors' addresses to the font host)`;
   - `style={{` → note `<file> styles elements inline instead of using the house components`.

When the gates did not run, or ran without a browser report, `page-gate` is `skipped` with the note `The page check did not run (<gatesNote>), so no page was looked at on desktop or phone.` It adds the **locked warning** `The pages were not checked at desktop and phone width` (index Ruling 7). `registry` is skipped with no finding.

**Files:**
- Create: `src/council/design.js`
- Test: `test/council-design.test.js` (new)

**Interfaces:**
- Consumes: `makeFinding`, `TOOL_LABEL`, `skipped` (Plan 5); `Evidence`, `GatesResult` (Tasks 4 and 6); the fixtures in `test/fixtures/council-full/gates-out/` (parsed with Task 4's parsers); `applyInterpretation` (Plan 5).
- Produces:
  - `WIDTH = { 'desktop-chromium': 'desktop', 'mobile-chromium': 'a phone (Chrome)', 'mobile-webkit': 'a phone (Safari)' }` (Task 9 uses it);
  - `pageGateFindings(browser) -> Finding[]`, `registryFindings(browser) -> Finding[]`, `a11yFindings(a11y) -> Finding[]`, `houseStyleFindings({ dir, files }) -> Finding[]`;
  - `DESIGN = { member: 'design', label: 'Design', alwaysInterpret: true, collect(input) }`, returning ToolRuns in the order `page-gate`, `registry`, `axe`, `house-style`.

- [ ] **Step 1: Write the failing tests**

Create `test/council-design.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parsePlaywrightJson, parseA11yLines } from '../src/council/gates.js';
import { pageGateFindings, registryFindings, a11yFindings, houseStyleFindings, DESIGN } from '../src/council/design.js';
import { applyInterpretation } from '../src/council/interpret.js';

const fx = (f) => readFileSync(new URL(`./fixtures/council-full/gates-out/${f}`, import.meta.url), 'utf8');
const browser = parsePlaywrightJson(fx('playwright.json'));
const a11y = parseA11yLines(fx('a11y.jsonl'));

test('a page that scrolls sideways on a phone is a locked block; journeys are not Design\'s', () => {
  const f = pageGateFindings(browser);
  assert.deepEqual(f.map((x) => [x.title, x.grade, x.locked, x.tool]), [['The notes page scrolls sideways on a phone (Safari)', 'blocking', true, 'page-gate']]);
  assert.match(f[0].detail, /the page scrolls sideways/);
  assert.deepEqual(registryFindings(browser), []);
});

test('each gate message gets its own plain title', () => {
  const mk = (message, project = 'mobile-chromium') => ({ file: '/work/apps/web/e2e/responsive.spec.ts', title: 'people works at this width', project, ok: false, skipped: false, message });
  assert.equal(pageGateFindings([mk('buttons and fields too small to tap')])[0].title, 'The people page has buttons or fields too small to tap on a phone (Chrome)');
  assert.equal(pageGateFindings([mk('script errors on the page', 'desktop-chromium')])[0].title, 'The people page has script errors on desktop');
  assert.equal(pageGateFindings([mk('Timed out 10000ms waiting for getByRole(\'heading\')')])[0].title, 'The people page does not load properly on a phone (Chrome)');
  assert.deepEqual(pageGateFindings([{ ...mk('x'), skipped: true }]), []);
  const reg = registryFindings([{ file: '/work/apps/web/e2e/registry.spec.ts', title: 'every app path has at least one page in the screenshot registry', project: 'desktop-chromium', ok: false, skipped: false, message: 'Add these pages to apps/web/e2e/pages.ts: ["/claims"]' }]);
  assert.deepEqual(reg.map((x) => [x.grade, x.locked]), [['blocking', true]]);
});

test('axe: serious is a warning, never a block; minor is a note', () => {
  const f = a11yFindings(a11y);
  assert.deepEqual(f.map((x) => [x.tool, x.grade, x.maxGrade]), [['axe', 'warning', 'warning']]);
  assert.match(f[0].title, /^Accessibility: .+ \(1 page\)$/);
  assert.match(f[0].detail, /notes on council-a11y-phone: 3 places, e\.g\. \.mantine-Button-root/);
  const minor = a11yFindings([{ page: 'p', project: 'x', violations: [{ id: 'region', impact: 'minor', help: 'Content in landmarks', nodes: 1, target: 'div' }] }]);
  assert.equal(minor[0].grade, 'note');
});

test('house style: hand-typed colours and web fonts warn; inline styles are a note; the theme file is allowed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hs-'));
  const put = (f, s) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), s); };
  put('apps/web/src/pages/claims/List.tsx', 'const c = "#ff0000";\n<div style={{ margin: 3 }} />\n');
  put('apps/web/src/index.css', '@import url(https://fonts.googleapis.com/css2?family=Inter);\n');
  put('apps/web/src/theme.ts', 'const a = "#123456";\n');
  const f = houseStyleFindings({ dir, files: ['apps/web/src/pages/claims/List.tsx', 'apps/web/src/index.css', 'apps/web/src/theme.ts', 'apps/server/src/x.ts'] });
  assert.deepEqual(f.map((x) => [x.file, x.grade]), [
    ['apps/web/src/pages/claims/List.tsx', 'warning'], ['apps/web/src/pages/claims/List.tsx', 'note'], ['apps/web/src/index.css', 'warning']]);
});

test('DESIGN.collect: four checks; screenshots attached; nothing proven → a locked "not checked" warning', async () => {
  const shots = [{ page: 'notes', project: 'mobile-chromium', file: 'reports/screenshots/notes-mobile-chromium.png' }];
  const runs = await DESIGN.collect({ brief: {}, dir: '/nope', files: [], evidence: { gates: { browser, a11y, screenshots: shots, axe: { status: 'ok', version: '4.10.3' } }, gatesNote: null } });
  assert.deepEqual(runs.map((r) => [r.tool, r.status]), [['page-gate', 'ran'], ['registry', 'ran'], ['axe', 'ran'], ['house-style', 'ran']]);
  assert.deepEqual(runs[0].attach, ['reports/screenshots/notes-mobile-chromium.png']);
  assert.match(runs[0].context, /^Pages checked: \d+ pages × /);
  const none = await DESIGN.collect({ brief: {}, dir: '/nope', files: [], evidence: { gates: null, gatesNote: 'TEST_DATABASE_URL is not set' } });
  assert.equal(none[0].status, 'skipped');
  assert.deepEqual(none[0].findings.map((x) => [x.title, x.grade, x.locked]), [['The pages were not checked at desktop and phone width', 'warning', true]]);
  assert.equal(none[2].status, 'skipped');
});

test('the interpreter cannot clear a page-gate block, raise axe, or block on a screenshot alone', () => {
  const findings = [...pageGateFindings(browser), ...a11yFindings(a11y)];
  const out = applyInterpretation(findings, ['D1', 'D2'], {
    findings: [{ id: 'D1', decision: 'dismiss', grade: 'note', why: 'looks fine to me' }, { id: 'D2', decision: 'keep', grade: 'blocking', why: 'contrast' }],
    extra: [{ title: 'The claims list looks cramped', grade: 'blocking', why: 'ugly' }],
  }, { member: 'design' });
  assert.deepEqual(out.map((f) => [f.grade, f.dismissed]), [['blocking', false], ['warning', false], ['warning', false]]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/council-design.test.js`
Expected: FAIL with `Cannot find module '../src/council/design.js'`.

- [ ] **Step 3: Implement `src/council/design.js`** to the table and rules above. Use `path.basename(c.file)` to pick the spec file. Cap `house-style` at 20 findings and `axe` at 15 rules (most severe first). Every finding goes through `makeFinding` with `member: 'design'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/council-design.test.js && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/council/design.js test/council-design.test.js
git commit -m "feat(council): Design member (page gate blocks, axe and house style warn, screenshots for the reviewer)"
```
