import { test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { ALICE, FILE, MANAGER, NOTE, lastBody, mockFetch, renderAt, user } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

test('the empty notes page invites you to create one', async () => {
  mockFetch({ 'GET /api/me': [200, { user: ALICE }], 'GET /api/notes?limit=20': [200, { notes: [], nextCursor: null }] });
  renderAt('/notes');
  expect(await screen.findByText('No notes yet')).toBeInTheDocument();
  expect(screen.getByText('Notes you create will appear here.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'New note' })).toHaveAttribute('href', '/notes/new');
});

test('the notes list loads more with the cursor', async () => {
  const f = mockFetch({ 'GET /api/me': [200, { user: ALICE }],
    'GET /api/notes?limit=20': [200, { notes: [NOTE], nextCursor: 'c1' }],
    'GET /api/notes?limit=20&cursor=c1': [200, { notes: [{ ...NOTE, id: 'n2', title: 'Hotel' }], nextCursor: null }] });
  renderAt('/notes');
  await user.click(await screen.findByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('Hotel')).toBeInTheDocument();
  expect(f).toHaveBeenCalledWith('/api/notes?limit=20&cursor=c1', expect.anything());
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
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
  await waitFor(() => { expect(lastBody(f, '/api/notes')).toEqual({ title: 'Taxi to client', body: '', attachmentId: FILE.id }); });
  await waitFor(() => { expect(router.state.location.pathname).toBe('/notes/n9'); });
});

test('editing sends only what changed, and deleting asks first', async () => {
  const f = mockFetch({ 'GET /api/me': [200, { user: ALICE }], 'GET /api/notes/n1': [200, { note: NOTE }],
    'PATCH /api/notes/n1': [200, { note: { ...NOTE, title: 'Taxi home' } }], 'DELETE /api/notes/n1': [204, null],
    'GET /api/notes?limit=20': [200, { notes: [], nextCursor: null }] });
  const { router } = renderAt('/notes/n1');
  await user.click(await screen.findByRole('button', { name: 'Edit' }));
  const title = screen.getByLabelText('Title');
  await user.clear(title);
  await user.type(title, 'Taxi home');
  await user.click(screen.getByRole('button', { name: 'Save note' }));
  await waitFor(() => { expect(lastBody(f, '/api/notes/n1')).toEqual({ title: 'Taxi home' }); });
  await user.click(await screen.findByRole('button', { name: 'Delete' }));
  expect(await screen.findByText('Delete this note?')).toBeInTheDocument();
  expect(screen.getByText("This can't be undone.")).toBeInTheDocument();
  const buttons = screen.getAllByRole('button', { name: 'Delete' });
  await user.click(buttons[buttons.length - 1]!);
  await waitFor(() => { expect(router.state.location.pathname).toBe('/notes'); });
});

test('the server refusal is shown as it is written', async () => {
  mockFetch({ 'GET /api/me': [200, { user: ALICE }], 'GET /api/notes/zz': [404, { error: "We couldn't find that." }] });
  renderAt('/notes/zz');
  expect(await screen.findByText("We couldn't find that.")).toBeInTheDocument();
});
