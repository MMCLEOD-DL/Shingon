# Task 12: Account pages

These are the pages every user meets first: sign in, forgot password, reset password, accept invite and profile. They must be calm, plain English and work one-handed on a phone. Every form uses the same shared Zod schema as the server, so the browser and the server agree on what is valid.

**Files:**
- Create: `apps/web/src/pages/account/{SignIn,ForgotPassword,ResetPassword,AcceptInvite,Profile}.tsx`, `apps/web/src/pages/account/AuthCard.tsx`
- Modify: `apps/web/src/routes.tsx`, `packages/shared/src/schemas.ts` (add `SignInInput`, `ForgotInput`, `SetPasswordInput = z.strictObject({ password: z.string().min(10, 'Use at least 10 characters.').max(200, 'Use at most 200 characters.') })`, `ChangePasswordInput`)
- Modify: `apps/server/src/auth/routes.ts`. The server switches to these shared schemas, with no behaviour change; the Task 3 and Task 7 tests prove that.
- Test: `apps/web/test/account.test.tsx`

**Interfaces:**
- Consumes: `api`, `ApiError`, `useAuth`, `FormCard`, `notifySaved`, `ErrorNotice` (Task 11); the endpoints from Tasks 3 and 7.
- Produces these routes in `APP_PATHS` (public): `/sign-in`, `/forgot-password`, `/reset-password`, `/accept-invite`; and (signed in) `/profile`.
  - `AuthCard({ title, children, footer? })`: a centred card, max width 420 px, full width on a phone, with `BRAND.appName` above it.
  - Sign-in:
    - on success, navigates to `next` (only if it starts with `/` and not `//`), otherwise to `/notes`;
    - the server's error is shown in an `Alert` above the form;
    - it has a "Forgot your password?" link.
  - Forgot: after submitting it always shows the server's message, replacing the form.
  - Reset and accept-invite:
    - read the token from `location.hash.slice(1)`, then remove the hash with `history.replaceState` so the token does not linger in the address bar;
    - with no token they show `This link is incomplete. Open the link from your email again.`;
    - on success, reset goes to `/sign-in` with a notification `Your password has been changed. Please sign in.`, and accept-invite goes straight to `/notes`, already signed in.
  - Profile:
    - a name form (`PATCH /api/me`) and a change-password form (`POST /api/me/password`);
    - a read-only line showing role and team: `You are a member of North.` / `You are a manager of North.` / `You are an admin.`

- [ ] **Step 1: Write the failing tests**

`apps/web/test/account.test.tsx`. Use a helper `renderAt(path, hash?)` that wraps the page in `MantineProvider`, a memory router and `AuthProvider`, with `fetch` routed through a `vi.fn` map keyed by `METHOD url`.

```tsx
test('sign-in shows the server message and keeps the email', async () => {
  mockFetch({ 'GET /api/me': [401, { error: 'Please sign in.' }],
              'POST /api/auth/sign-in': [401, { error: "That email and password don't match an account." }] });
  renderAt('/sign-in');
  await user.type(screen.getByLabelText('Email'), 'alice@hf.test');
  await user.type(screen.getByLabelText('Password'), 'wrong password');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText("That email and password don't match an account.")).toBeInTheDocument();
  expect(screen.getByLabelText('Email')).toHaveValue('alice@hf.test');
});

test('sign-in refuses to bounce to another site', async () => {
  mockFetch({ 'GET /api/me': [401, {}], 'POST /api/auth/sign-in': [200, { user: ALICE }] });
  const { router } = renderAt('/sign-in?next=//evil.example');
  await signIn();
  await waitFor(() => expect(router.state.location.pathname).toBe('/notes'));
});

test('forgot password shows the same message whatever happens', async () => {
  mockFetch({ 'GET /api/me': [401, {}], 'POST /api/auth/forgot-password': [202, { message: "If that email has an account, we've sent a link to reset the password." }] });
  renderAt('/forgot-password');
  await user.type(screen.getByLabelText('Email'), 'ghost@hf.test');
  await user.click(screen.getByRole('button', { name: 'Send reset link' }));
  expect(await screen.findByText("If that email has an account, we've sent a link to reset the password.")).toBeInTheDocument();
  expect(screen.queryByLabelText('Email')).toBeNull();
});

test('reset reads the token from the link, hides it, and checks length before sending', async () => {
  const f = mockFetch({ 'GET /api/me': [401, {}], 'POST /api/auth/reset-password': [204, null] });
  renderAt('/reset-password', '#tok_abc');
  expect(window.location.hash).toBe('');
  await user.type(screen.getByLabelText('New password'), 'short');
  await user.click(screen.getByRole('button', { name: 'Set new password' }));
  expect(await screen.findByText('Use at least 10 characters.')).toBeInTheDocument();
  expect(f).not.toHaveBeenCalledWith('/api/auth/reset-password', expect.anything());
  await user.clear(screen.getByLabelText('New password'));
  await user.type(screen.getByLabelText('New password'), 'a good long password');
  await user.click(screen.getByRole('button', { name: 'Set new password' }));
  await waitFor(() => expect(lastBody(f, '/api/auth/reset-password')).toEqual({ token: 'tok_abc', password: 'a good long password' }));
});

test('a link with no token explains itself', () => {
  mockFetch({ 'GET /api/me': [401, {}] });
  renderAt('/accept-invite');
  expect(screen.getByText('This link is incomplete. Open the link from your email again.')).toBeInTheDocument();
});

test('profile states role and team in words', async () => {
  mockFetch({ 'GET /api/me': [200, { user: { ...ALICE, teamName: 'North' } }] });
  renderAt('/profile');
  expect(await screen.findByText('You are a member of North.')).toBeInTheDocument();
});
```

`ALICE = { id: 'u1', email: 'alice@hf.test', name: 'Alice', role: 'member', teamId: 't1' }`. `signIn()` types into the two fields and submits. `lastBody(f, url)` parses the JSON body of the last call to `url`. Write these helpers once at the top of the file. `GET /api/me` must therefore return `teamName`: extend `Actor` in `/api/me` responses to `MeView = Actor & { teamName: string | null }` (server change in `auth/routes.ts`, with a one-line assertion added to the Task 3 test).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project apps/web test/account.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Forms use `@mantine/form` with `schemaResolver(SharedSchema)` from Mantine's Zod integration. If Mantine 9 lacks a built-in Zod 4 resolver, write a 10-line `zodResolver(schema)` in `apps/web/src/ui/zodResolver.ts` that maps `issues` to `{ [path]: message }`.
- Labels are exactly `Email`, `Password`, `New password` and `Your name`. Buttons are exactly `Sign in`, `Send reset link`, `Set new password`, `Save` and `Change password`.
- `autoComplete` attributes:
  - sign-in: `email` / `current-password`;
  - reset and invite: `new-password`;
  - profile: `current-password` / `new-password`.
- Pressing Enter submits.

- [ ] **Step 4: Verify**

Run: `npm run verify`
Expected: all tests PASS (6 new).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: account pages — sign in, forgot/reset, accept invite, profile

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
