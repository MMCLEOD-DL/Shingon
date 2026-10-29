# Task 13: Admin & notes pages

This task adds the remaining pages of the foundation:
- the admin's people, teams and audit pages;
- the notes example (list, new, view/edit), with a phone-friendly photo upload.

They use only the house components from Task 11, which proves the visual system covers real pages. The UI follows the permission model, hiding what a role cannot do, but the server stays the authority (Ruling 4).

**Files:**
- Create: `apps/web/src/pages/admin/{Users,UserDrawer,InviteModal,Teams,Audit}.tsx`
- Create: `apps/web/src/pages/notes/{NotesList,NoteNew,NoteView,NoteForm}.tsx`
- Create: `apps/web/src/ui/FileDropzone.tsx`, `apps/web/src/ui/format.ts` (if not already created), `apps/web/src/queries.ts`
- Modify: `apps/web/src/routes.tsx`, `apps/web/src/ui/index.tsx`
- Test: `apps/web/test/{notes,admin,FileDropzone}.test.tsx`

**Interfaces:**
- Consumes: `api`, `uploadFile`, `useAuth`, `RequirePermission`, the house components (Task 11); the endpoints from Tasks 4, 5, 7, 9 and 10.
- Produces:
  - `queries.ts`: TanStack Query keys and hooks: `useNotes()` (infinite, by `nextCursor`), `useNote(id)`, `useUsers()`, `useTeams()`, `useAudit(filters)` (infinite, by `nextBefore`). Mutations invalidate the matching keys.
  - Routes added to `APP_PATHS` (signed in):
    - `/notes`, `/notes/new`, `/notes/:id`;
    - `/admin/users` (`users:list`), `/admin/teams` (`teams:manage`), `/admin/audit` (`audit:read`).
  - `/` redirects to `/notes`.
  - `FileDropzone({ onUploaded(file: FileView), maxBytes = 15 * 1024 * 1024 })`:
    - Mantine `Dropzone` with `accept = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']`;
    - on a phone, a full-width `Button` labelled `Take or choose a photo` that opens `<input type="file" accept="image/*,application/pdf" capture="environment">`;
    - client-side refusals show the same plain-English texts as the server;
    - it shows upload progress, then a thumbnail (raster images) or the file name.

Page copy (exact):

| Page | Title | Empty state | Primary action |
|---|---|---|---|
| Notes list | `Notes` | `No notes yet` / `Notes you create will appear here.` | `New note` |
| New note | `New note` | n/a | `Save note` |
| Note view | the note title | n/a | `Edit` and `Delete` (only when `canEdit`); delete confirm `Delete this note?` / `This can't be undone.` |
| People | `People` | `No one here yet` | `Invite someone` (only with `users:manage`) |
| Teams | `Teams` | `No teams yet` | `Add team` |
| Audit | `Activity log` | `Nothing recorded yet` | `Load more` (when `nextBefore` is not null) |

- On a phone, the user drawer (`UserDrawer`) is full screen; on desktop it opens from the right.
- The drawer edits name, role, team and an `Account active` switch.
- The admin's own row hides the role and active controls and shows `You can't change your own role or disable your own account.`
- A user who is not yet activated shows the badge `Invite sent` and a `Send invite again` button.

- [ ] **Step 1: Write the failing tests**

Reuse the `mockFetch`, `renderAt` and `setMobile` helpers from Task 12. Move them into `apps/web/test/helpers.tsx`.

`apps/web/test/notes.test.tsx`:

```tsx
test('the empty notes page invites you to create one', async () => {
  mockFetch({ 'GET /api/me': [200, { user: ALICE }], 'GET /api/notes?limit=20': [200, { notes: [], nextCursor: null }] });
  renderAt('/notes');
  expect(await screen.findByText('No notes yet')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'New note' })).toHaveAttribute('href', '/notes/new');
});

test('a note you cannot edit shows no Edit or Delete', async () => {
  mockFetch({ 'GET /api/me': [200, { user: MANAGER }], 'GET /api/notes/n1': [200, { note: { ...NOTE, canEdit: false } }] });
  renderAt('/notes/n1');
  expect(await screen.findByRole('heading', { name: 'Taxi to client' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
});

test('creating a note with a photo sends the uploaded file id', async () => {
  const f = mockFetch({ 'GET /api/me': [200, { user: ALICE }], 'POST /api/files': [201, { file: FILE }], 'POST /api/notes': [201, { note: { ...NOTE, id: 'n9' } }] });
  const { router } = renderAt('/notes/new');
  await user.type(await screen.findByLabelText('Title'), 'Taxi to client');
  await user.upload(screen.getByTestId('file-input'), new File([new Uint8Array([0xff, 0xd8, 0xff])], 'r.jpg', { type: 'image/jpeg' }));
  await screen.findByText('r.jpg');
  await user.click(screen.getByRole('button', { name: 'Save note' }));
  await waitFor(() => expect(lastBody(f, '/api/notes')).toEqual({ title: 'Taxi to client', body: '', attachmentId: FILE.id }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/notes/n9'));
});
```

`apps/web/test/admin.test.tsx`:

```tsx
test('a manager sees people but cannot invite', async () => {
  mockFetch({ 'GET /api/me': [200, { user: MANAGER }], 'GET /api/users': [200, { users: [USER_ALICE] }] });
  renderAt('/admin/users');
  expect(await screen.findByText('Alice')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Invite someone' })).toBeNull();
});

test('an admin invites someone with role and team', async () => {
  const f = mockFetch({ 'GET /api/me': [200, { user: ADMIN }], 'GET /api/users': [200, { users: [] }], 'GET /api/teams': [200, { teams: [{ id: 't1', name: 'North' }] }],
    'POST /api/users/invite': [201, { user: { ...USER_ALICE, activated: false } }] });
  renderAt('/admin/users');
  await user.click(await screen.findByRole('button', { name: 'Invite someone' }));
  await user.type(screen.getByLabelText('Email'), 'new@hf.test');
  await user.type(screen.getByLabelText('Name'), 'Newt');
  await chooseOption('Role', 'Member');
  await chooseOption('Team', 'North');
  await user.click(screen.getByRole('button', { name: 'Send invite' }));
  await waitFor(() => expect(lastBody(f, '/api/users/invite')).toEqual({ email: 'new@hf.test', name: 'Newt', role: 'member', teamId: 't1' }));
});

test('a member opening an admin page is told they have no access', async () => {
  mockFetch({ 'GET /api/me': [200, { user: ALICE }] });
  renderAt('/admin/audit');
  expect(await screen.findByText("You don't have access to this page")).toBeInTheDocument();
});

test('the activity log loads more with the cursor', async () => {
  const f = mockFetch({ 'GET /api/me': [200, { user: ADMIN }],
    'GET /api/audit?limit=50': [200, { entries: [ENTRY(2)], nextBefore: 2 }],
    'GET /api/audit?limit=50&before=2': [200, { entries: [ENTRY(1)], nextBefore: null }] });
  renderAt('/admin/audit');
  await user.click(await screen.findByRole('button', { name: 'Load more' }));
  await waitFor(() => expect(f).toHaveBeenCalledWith('/api/audit?limit=50&before=2', expect.anything()));
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
});
```

`chooseOption(label, option)` is a helper: click the Mantine `Select` input, then click the option by role. Role options are labelled `Admin`, `Manager` and `Member`. Put `ADMIN`, `MANAGER`, `USER_ALICE`, `NOTE`, `FILE` and `ENTRY(n)` fixtures in `helpers.tsx`.

`apps/web/test/FileDropzone.test.tsx`:

```tsx
test('too-large and wrong-type files are refused in plain English before upload', async () => {
  const f = mockFetch({});
  render(<Wrap><FileDropzone onUploaded={() => {}} maxBytes={10} /></Wrap>);
  await user.upload(screen.getByTestId('file-input'), new File([new Uint8Array(11)], 'big.jpg', { type: 'image/jpeg' }));
  expect(await screen.findByText('That file is too large. The limit is 0 MB.')).toBeInTheDocument();
  expect(f).not.toHaveBeenCalled();
});
test('on a phone the camera button is offered', () => {
  setMobile(true);
  render(<Wrap><FileDropzone onUploaded={() => {}} /></Wrap>);
  expect(screen.getByRole('button', { name: 'Take or choose a photo' })).toBeInTheDocument();
  expect(screen.getByTestId('file-input')).toHaveAttribute('capture', 'environment');
});
```

The limit text rounds to whole MB with `Math.round(maxBytes / 1048576)`, which is why `0 MB` appears in the test. Use the same formatter as the server message in Task 9: `formatLimit(bytes)` in `@hf/shared`, so the two can never drift.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project apps/web`
Expected: FAIL.

- [ ] **Step 3: Implement the pages and `FileDropzone`**

Use the copy above. Every list uses `ResponsiveList`, and every page starts with `PageHeader`. Notes show `ownerName` and `formatDateTime(createdAt)`. The note view shows a raster attachment as an `<Image>` from `/api/files/:id/content`, and HEIC or PDF as a download link.

- [ ] **Step 4: Verify**

Run: `npm run verify && npm -w @hf/web run build`
Expected: all tests PASS (9 new); the build succeeds.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: people, teams, activity log and notes pages; phone-friendly photo upload

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
