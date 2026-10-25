# Task 11: Web scaffold, visual system & layout shell

Spec §2.3 says: "one consistent, polished visual system. Every page works well on a phone." This task sets up the single Mantine theme, the layout shell (side nav on desktop, burger drawer on a phone) and a small set of **house components**. Every page, and every page the factory writes later, is built from these, so a client app looks professional by construction.

It also gives the web app a typed API client, and lets the server serve the built app.

**Files:**
- Create: `apps/web/{package.json,tsconfig.json,vite.config.ts,vitest.config.ts,index.html,postcss.config.cjs}`
- Create: `apps/web/src/{main.tsx,theme.ts,brand.ts,api.ts,auth.tsx,nav.ts,routes.tsx,Shell.tsx}`
- Create: `apps/web/src/ui/{PageHeader,ResponsiveList,EmptyState,ConfirmAction,ErrorNotice,FormCard,index}.tsx`, `apps/web/src/ui/notify.ts`
- Create: `apps/web/test/setup.ts`
- Modify: `apps/server/src/app.ts` (serve the SPA when `webDistDir` is set)
- Test: `apps/web/test/{api,nav,ResponsiveList,RequireAuth}.test.tsx`, `apps/server/test/spa.test.ts`

**Interfaces:**
- Consumes: `@hf/shared` (`can`, `Role`, schemas and views), every `/api` route so far.
- Produces:
  - `api.ts`:
    - `api<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T>`, with `credentials: 'same-origin'`; 204 → `undefined`.
    - `class ApiError extends Error { status: number; issues?: { path: string; message: string }[] }`. Its `message` is the server's `error` string, or `Couldn't reach the server. Check your connection and try again.` on a network failure.
    - `uploadFile(file: File): Promise<FileView>`.
  - `auth.tsx`:
    - `<AuthProvider>`
    - `useAuth(): { user: Actor | null; loading: boolean; refresh(): Promise<void>; signOut(): Promise<void> }`
    - `<RequireAuth>`, which redirects to `/sign-in?next=<path>` when signed out
    - `<RequirePermission perm>`, which renders `<EmptyState title="You don't have access to this page" … />`
    - A 401 from any `api()` call clears the user. `onUnauthorized` is registered by the provider.
  - `nav.ts`:
    - `NAV: { label: string; to: string; icon: TablerIcon; permission?: Permission }[]`
    - `navFor(role: Role): typeof NAV`
  - `routes.tsx`:
    - `APP_PATHS: { path: string; auth: 'public' | 'signed-in'; permission?: Permission }[]`, the single list Task 14's page registry is checked against.
    - `router = createBrowserRouter(...)`.
  - House components: `PageHeader({ title, description?, actions? })`, `ResponsiveList<T>({ items, columns, cardTitle, empty, onOpen? })`, `EmptyState({ title, body?, action? })`, `ConfirmAction({ label, confirmTitle, confirmBody, color?, onConfirm })`, `ErrorNotice({ error })`, `FormCard({ title, children })`, `notifySaved(msg?)`, `notifyError(err)`.

**Visual system (the decided values):**
- `brand.ts`: `export const BRAND = { appName: 'Highland App', shortName: 'HA' } as const`. A client build edits this file and the palette, and nothing else.
- Palette `highland`: `['#e6f7f5', '#cdeee9', '#9ddcd3', '#69c9bb', '#40b9a8', '#27af9c', '#15a995', '#039381', '#008373', '#007163']`.
- `createTheme`:
  - `primaryColor: 'highland'`, `primaryShade: { light: 7, dark: 5 }`;
  - `fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'`;
  - `defaultRadius: 'md'`, `headings.fontWeight: '650'`;
  - component defaults `size: 'md'` for `Button`, `TextInput`, `PasswordInput`, `Textarea` and `Select`, so touch targets are at least 42 px.
- Colour scheme: follow the system (`defaultColorScheme="auto"`).
- `Shell.tsx`:
  - `AppShell` with `header.height = 56` and `navbar = { width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }`;
  - the header has a `Burger` (`hiddenFrom="sm"`), `BRAND.appName` and a user `Menu` (Profile, Sign out);
  - the navbar renders `navFor(user.role)` as `NavLink`s; the drawer closes on navigation;
  - the main area has `Container size="lg"` and `padding="md"`.
- `ResponsiveList`: below the `sm` breakpoint (`useMediaQuery('(max-width: 48em)')`) it renders a `Stack` of `Card`s with the `cardTitle` plus label/value rows. At `sm` and above it renders a `Table` with `highlightOnHover`. Rows open via `onOpen` from either form. `empty` is shown when there are no items.
- Dates are shown with `Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' })` through `formatDateTime(iso)` in `ui/format.ts`.

- [ ] **Step 1: Install**

```bash
npm -w @hf/web i react@19.3.1 react-dom@19.3.1 react-router@8.5.0 @tanstack/react-query@5.104.5 \
  @mantine/core@9.7.4 @mantine/hooks@9.7.4 @mantine/form@9.7.4 @mantine/notifications@9.7.4 @mantine/dropzone@9.7.4 \
  @tabler/icons-react@3.49.0 @hf/shared@*
npm -w @hf/web i -D vite@7.3.7 @vitejs/plugin-react@5.2.0 postcss@8.5.31 postcss-preset-mantine@1.18.0 \
  jsdom@30.1.3 @testing-library/react@16.3.3 @testing-library/user-event@14.6.8 @testing-library/jest-dom@7.0.1 @types/react@19.3.0 @types/react-dom
npm -w @hf/server i @fastify/static@10.1.7
npm run licences
```

Stay on **Vite 7**, the version Task 1 pinned: Vite 8 depends on `lightningcss` (MPL-2.0), which the licence gate refuses. `@vitejs/plugin-react` 6.x peers on Vite 8 only, so use 5.2.0 (peer range `^4.2.0 || … || ^7.0.0 || ^8.0.0`). A throwaway install of these build tools on 2026-10-25 added no copyleft package. Before committing, run `npm ls lightningcss` (expected `(empty)`) and `npm run licences`.

Web scripts: `"dev": "vite"`, `"build": "tsc -p . --noEmit && vite build"`, `"typecheck": "tsc -p . --noEmit"`. `vite.config.ts` proxies `/api` to `http://localhost:3000` in dev, and sets the same `resolve.alias` for `@hf/shared` → `../../packages/shared/src/index.ts` as the Vitest configs (Task 1), so the browser build and dev server always see the current shared source. Before writing components, check the installed Mantine 9 and React Router 8 docs for any API that differs from the shapes above. Keep the shapes above as the house interface.

- [ ] **Step 2: Write the failing tests**

`apps/web/test/setup.ts` imports `@testing-library/jest-dom/vitest` and stubs `window.matchMedia` with a controllable `setMobile(boolean)` helper exported from the same file.

`apps/web/test/api.test.tsx`:

```ts
import { test, expect, vi, afterEach } from 'vitest';
import { api, ApiError } from '../src/api.js';

afterEach(() => vi.unstubAllGlobals());
test('server errors arrive as plain-English ApiError', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: "You don't have permission to do that." }), { status: 403, headers: { 'content-type': 'application/json' } })));
  await expect(api('GET', '/api/users')).rejects.toMatchObject({ status: 403, message: "You don't have permission to do that." });
});
test('a network failure says so plainly', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
  const e = await api('GET', '/api/me').catch((x) => x);
  expect(e).toBeInstanceOf(ApiError);
  expect(e.message).toBe("Couldn't reach the server. Check your connection and try again.");
});
test('204 resolves to undefined and JSON bodies are sent as JSON', async () => {
  const f = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', f);
  expect(await api('POST', '/api/auth/sign-out', { a: 1 })).toBeUndefined();
  expect(f.mock.calls[0]![1]).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"a":1}' });
});
```

`apps/web/test/nav.test.tsx`:

```ts
import { test, expect } from 'vitest';
import { navFor } from '../src/nav.js';

test('members see only their own areas; admins see admin pages', () => {
  expect(navFor('member').map((n) => n.to)).toEqual(['/notes', '/profile']);
  expect(navFor('manager').map((n) => n.to)).toEqual(['/notes', '/admin/users', '/profile']);
  expect(navFor('admin').map((n) => n.to)).toEqual(['/notes', '/admin/users', '/admin/teams', '/admin/audit', '/profile']);
});
```

`apps/web/test/ResponsiveList.test.tsx`:

```tsx
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { ResponsiveList } from '../src/ui/index.js';
import { theme } from '../src/theme.js';
import { setMobile } from './setup.js';

const items = [{ id: '1', title: 'Taxi', amount: '£12.40' }];
const ui = () => render(<MantineProvider theme={theme}><ResponsiveList items={items} cardTitle={(i) => i.title}
  columns={[{ key: 'title', label: 'Title', render: (i) => i.title }, { key: 'amount', label: 'Amount', render: (i) => i.amount }]}
  empty={<p>Nothing yet</p>} /></MantineProvider>);

test('a table on desktop', () => { setMobile(false); ui(); expect(screen.getByRole('table')).toBeInTheDocument(); });
test('cards on a phone, with labels', () => {
  setMobile(true); ui();
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.getByText('Amount')).toBeInTheDocument();
  expect(screen.getByText('£12.40')).toBeInTheDocument();
});
test('the empty state shows when there is nothing', () => {
  setMobile(false);
  render(<MantineProvider theme={theme}><ResponsiveList items={[]} cardTitle={() => ''} columns={[]} empty={<p>Nothing yet</p>} /></MantineProvider>);
  expect(screen.getByText('Nothing yet')).toBeInTheDocument();
});
```

`apps/web/test/RequireAuth.test.tsx`: renders a memory router at `/notes` inside `AuthProvider`, with `fetch` stubbed to answer `/api/me` with 401, and asserts that the location becomes `/sign-in?next=%2Fnotes`.

`apps/server/test/spa.test.ts`:

```ts
import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestApp } from './helpers/testApp.js';

test('the server serves the app for page paths and JSON 404 for unknown API paths', async () => {
  const dist = mkdtempSync(path.join(tmpdir(), 'dist-'));
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>HF</title>');
  const t = await createTestApp({ webDistDir: dist });
  const page = await t.app.inject({ method: 'GET', url: '/notes/123' });
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('<title>HF</title>');
  const api = await t.app.inject({ method: 'GET', url: '/api/nope' });
  expect(api.statusCode).toBe(404);
  expect(api.json()).toEqual({ error: "We couldn't find that." });
  // the static file routes are on the crossing gate's allow-list, and nothing else slipped past defineRoute
  const declared = new Set([...t.app.hf.routes, ...t.app.hf.staticRoutes].map((r) => `${r.method} ${r.url}`));
  expect(t.app.hf.allRoutes.filter((r) => r.method !== 'HEAD' && !declared.has(`${r.method} ${r.url}`))).toEqual([]);
  expect(t.app.hf.staticRoutes.map((r) => r.url)).toContain('/index.html');
  await t.close();
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run --project apps/web --project apps/server`
Expected: FAIL. The modules are missing.

- [ ] **Step 4: Implement**

- Build the files listed, using the decided values above.
- `main.tsx`: wraps the router in `MantineProvider` (theme, `defaultColorScheme="auto"`), `Notifications`, `QueryClientProvider` and `AuthProvider`.
- Server, in `app.ts`: when `webDistDir` is set, register `@fastify/static` with `{ root, wildcard: false, index: false }`, and record the routes it creates in `app.hf.staticRoutes` (the crossing gate's allow-list, Task 8). Do it with a flag the existing root `onRoute` hook reads: `staticLoading = true; await app.register(fastifyStatic, opts); staticLoading = false;`, and in the hook, `if (staticLoading) app.hf.staticRoutes.push({ method, url })`. (Awaiting `register` loads the plugin, so its routes arrive while the flag is set. Do not wrap the plugin in its own encapsulated context: `@fastify/static` decorates `reply.sendFile`, which the root not-found handler needs.) That is the only place `staticRoutes` is written. Then `setNotFoundHandler`:
  - `/api/*` → 404 JSON `{ error: "We couldn't find that." }`;
  - GET for anything else → `reply.sendFile('index.html')` with `Cache-Control: no-cache`;
  - hashed assets under `/assets/` get `Cache-Control: public, max-age=31536000, immutable` via `setHeaders`.

- [ ] **Step 5: Verify**

Run: `npm run verify && npm -w @hf/web run build`
Expected: all tests PASS (9 new). Vite writes `apps/web/dist/index.html` and `assets/`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: web shell — Mantine theme, responsive layout, house components, API client, SPA serving

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
