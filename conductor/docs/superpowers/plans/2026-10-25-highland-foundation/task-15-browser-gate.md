# Task 15: Browser flows & responsive screenshot gate

This task proves the quality bar in a real browser:
- the main journeys work end to end, including mail links;
- **every page** works at desktop and phone widths (spec §2.3), with no sideways scrolling, no script errors and finger-sized buttons.

It writes a screenshot of every page at every width, plus a manifest. That is exactly the evidence the Design council member will judge in Phase 6. A new page that is not in the page registry fails the gate.

**Files:**
- Create: `apps/server/src/e2e-server.ts`
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/{global-setup,pages,mail,fixtures}.ts`, `apps/web/e2e/{responsive,flows,registry}.spec.ts`
- Modify:
  - `apps/server/src/config.ts`: add `EMAIL_POLL_MS` [`5000`] → `Config.email.pollMs`;
  - `apps/server/src/app.ts`: the worker uses `pollMs`;
  - root `package.json`: add the scripts `test:e2e` and `verify:full`.

**Interfaces:**
- Consumes: `APP_PATHS` (Task 11), every page (Tasks 12–13), `seedDemo` and its `signIns` (Task 14), the file mail transport (Task 6).
- Produces:
  - `node --import tsx apps/server/src/e2e-server.ts`:
    - creates `hf_e2e_<hex>` from `TEST_DATABASE_URL`, migrates it and seeds it with `now = 2026-11-01T12:00:00Z`;
    - then adds the **flow accounts**, which only `flows.spec.ts` uses: for each project that runs flows (`desktop-chromium`, `mobile-chromium`), an activated Operations member `flow.<project>@demo.test` (name `Flow <Project>`) with the demo password. They are added after `seedDemo`, so they are not in its `signIns`, and global-setup never picks them;
    - serves `apps/web/dist` on `http://localhost:4319` with `EMAIL_TRANSPORT=file`, `EMAIL_FILE_DIR=$HF_E2E_MAIL_DIR` and `EMAIL_POLL_MS=300`;
    - drops the database on SIGTERM or SIGINT.
  - `apps/web/e2e/pages.ts`: `PAGES: { name: string; path: string | ((fx: Fixtures) => string); as: 'anon' | 'admin' | 'manager' | 'member'; ready: string }[]`. `ready` is the accessible heading text to wait for.
  - `apps/web/e2e/mail.ts`: `latestMailTo(email: string, opts?: { after?: number; timeoutMs?: number }): Promise<{ subject: string; text: string }>`, which polls `HF_E2E_MAIL_DIR`.
  - Reports:
    - `reports/screenshots/<page>-<project>.png`
    - `reports/screenshots/manifest.json` as `[{ page, path, project, width, height, file }]`
  - Root scripts:
    - `"test:e2e": "npm -w @hf/web run build && playwright test -c apps/web/playwright.config.ts"`
    - `"verify:full": "npm run verify && npm run test:e2e"`

Playwright projects:
- `desktop-chromium`: 1280×800
- `mobile-chromium`: 390×844, `isMobile: true`, `hasTouch: true`
- `mobile-webkit`: 390×844, `isMobile: true`, `hasTouch: true`; WebKit, the closest to iPhone Safari

`webServer` is the e2e server command, with `url: 'http://localhost:4319/sign-in'` and `reuseExistingServer: false`. (`/healthz` does not exist until Task 17; `/sign-in` is a real page the SPA fallback serves with 200.) `global-setup.ts` signs in once per role through `POST /api/auth/sign-in`, using the demo `signIns` (the admin, `ops.manager@demo.test` and the first Operations member), and saves `e2e/.auth/<role>.json` storage states. These are git-ignored.

- [ ] **Step 1: Install**

```bash
npm i -D @playwright/test@1.64.1
npx playwright install chromium webkit        # browsers only: no root needed, but needs internet
```

`npx playwright install --with-deps chromium webkit` additionally installs the browsers' system libraries with `apt`, which needs **root and internet**. Run that form once on the build machine (index, Operator follow-ups), not on the Claude VM. If the plain install leaves WebKit unable to start for missing libraries, stop and ask the operator to run the `--with-deps` form there.

- [ ] **Step 2: Write the page registry and its gate**

`apps/web/e2e/pages.ts`. Each entry names the `APP_PATHS` route it covers, and `path`/`ready` may be functions of the fixtures:

```ts
export const PAGES = [
  { name: 'sign-in', route: '/sign-in', path: '/sign-in', as: 'anon', ready: 'Sign in' },
  { name: 'forgot-password', route: '/forgot-password', path: '/forgot-password', as: 'anon', ready: 'Reset your password' },
  { name: 'reset-password', route: '/reset-password', path: '/reset-password#example', as: 'anon', ready: 'Choose a new password' },
  { name: 'accept-invite', route: '/accept-invite', path: '/accept-invite#example', as: 'anon', ready: 'Set your password' },
  { name: 'notes', route: '/notes', path: '/notes', as: 'member', ready: 'Notes' },
  { name: 'note-new', route: '/notes/new', path: '/notes/new', as: 'member', ready: 'New note' },
  { name: 'note-view', route: '/notes/:id', path: (fx) => `/notes/${fx.memberNoteWithPhoto}`, as: 'member', ready: (fx) => fx.memberNoteTitle },
  { name: 'note-view-manager', route: '/notes/:id', path: (fx) => `/notes/${fx.memberNoteWithPhoto}`, as: 'manager', ready: (fx) => fx.memberNoteTitle },
  { name: 'profile', route: '/profile', path: '/profile', as: 'member', ready: 'Your profile' },
  { name: 'people', route: '/admin/users', path: '/admin/users', as: 'admin', ready: 'People' },
  { name: 'people-manager', route: '/admin/users', path: '/admin/users', as: 'manager', ready: 'People' },
  { name: 'teams', route: '/admin/teams', path: '/admin/teams', as: 'admin', ready: 'Teams' },
  { name: 'activity', route: '/admin/audit', path: '/admin/audit', as: 'admin', ready: 'Activity log' },
] as const satisfies readonly PageEntry[];
```

- `fixtures.ts` loads `Fixtures` (`{ memberNoteWithPhoto, memberNoteTitle, salesNoteId }`) through the API as the admin, before the specs run.
- The headings `Reset your password`, `Choose a new password`, `Set your password` and `Your profile` are the `AuthCard` and `PageHeader` titles from Task 12. Use exactly these.

`apps/web/e2e/registry.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { APP_PATHS } from '../src/routes.js';
import { PAGES } from './pages.js';

test('every app path has at least one page in the screenshot registry', () => {
  const covered = new Set(PAGES.map((p) => p.route));
  const missing = APP_PATHS.map((p) => p.path).filter((p) => p !== '/' && !covered.has(p));
  expect(missing, 'Add these pages to apps/web/e2e/pages.ts').toEqual([]);
});
```

- [ ] **Step 3: Write the responsive gate**

`apps/web/e2e/responsive.spec.ts`:

```ts
for (const p of PAGES) {
  test(`${p.name} works at this width`, async ({ browser }, info) => {
    const ctx = await browser.newContext({ ...info.project.use, storageState: p.as === 'anon' ? undefined : `e2e/.auth/${p.as}.json` });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(resolvePath(p, fx));
    await expect(page.getByRole('heading', { name: resolveReady(p, fx) }).first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(1);
    if (info.project.use.isMobile) {
      const small = await page.locator('main button:visible, main a[role="button"]:visible, main input:visible').evaluateAll(
        (els) => els.filter((e) => e.getBoundingClientRect().height < 36).map((e) => e.outerHTML.slice(0, 80)));
      expect(small, 'buttons and fields too small to tap').toEqual([]);
    }
    expect(errors, 'script errors on the page').toEqual([]);
    await page.screenshot({ path: `reports/screenshots/${p.name}-${info.project.name}.png`, fullPage: true });
    await ctx.close();
  });
}
```

`test.afterAll` writes `manifest.json` from the files present.

- [ ] **Step 4: Write the journeys**

`apps/web/e2e/flows.spec.ts`. These run in the `desktop-chromium` and `mobile-chromium` projects; WebKit runs only the responsive spec.

Isolation rules, because the two projects run in parallel against one database:
- The file starts with `test.describe.configure({ mode: 'serial' })`, so the flows within one project run in order on one worker.
- **Never change the accounts whose stored sign-ins the responsive spec uses** (the admin, `ops.manager@demo.test` and the first Operations member). A password reset revokes every session of that user, which would invalidate `e2e/.auth/member.json` half-way through the run.
- Every flow that changes an account or creates data uses the per-project flow account `flow.${info.project.name}@demo.test`, and invites use a per-project address `invitee+${info.project.name}@demo.test`. So the two projects never touch the same person, and the second invite cannot get 409.

1. **Member creates a note with a photo:** sign in through the form as the flow account → `New note` → title → `setInputFiles` with `apps/server/test/fixtures/files/tiny.jpg` → `Save note` → the note page shows the title and an `img` whose `src` matches `/api/files/` → `Notes` lists it first → sign out through the user menu → `/sign-in` is shown.
2. **Forgot and reset** (flow account only, after flow 1 in the serial order):
   - request a reset for the flow account, then `latestMailTo(flowAccount)`;
   - its subject is `Reset your Highland App password`, and the link is extracted;
   - open it, set `a fresh long password`, sign in with the new password, and land on `/notes`.
   - No restore step is needed: nothing else uses the flow account.
3. **Invite:** as admin (stored sign-in; inviting does not change the admin's own account), on `People`, use `Invite someone` with `invitee+<project>@demo.test` (Sales, Member) → read the mail → open the link in a **new context** → set a password → land on `/notes` as the new person → the admin's `People` page no longer shows `Invite sent` for them.
4. **Manager limits in the UI:** as manager, open a team member's note: no `Edit` or `Delete`. Open `/notes/<id of a Sales note>` (id from fixtures): the page shows `We couldn't find that.`
5. **Phone navigation** (mobile project only): the burger opens the nav, tapping `Profile` navigates, and the nav closes (the `Profile` link is no longer visible).

- [ ] **Step 5: Run to verify**

Run: `TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run test:e2e`
Expected:
- all specs PASS: 13 pages × 3 projects, plus 1 registry check, plus 5 flows × 2 projects, less 1 because flow 5 runs on mobile only;
- `reports/screenshots/` holds 39 PNGs and `manifest.json`.

Open three screenshots (`notes-mobile-chromium.png`, `people-desktop-chromium.png`, `note-view-mobile-webkit.png`) with the Read tool. Check by eye that they look finished: aligned, no clipped text, consistent spacing. Fix anything that looks amateur before committing (spec §2.3).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: browser journeys and desktop/phone screenshot gate over every page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
