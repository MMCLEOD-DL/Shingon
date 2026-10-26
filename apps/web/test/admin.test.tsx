import { test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { ADMIN, ALICE, ENTRY, MANAGER, USER_ALICE, chooseOption, lastBody, mockFetch, renderAt, user } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

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
  await waitFor(() => { expect(lastBody(f, '/api/users/invite')).toEqual({ email: 'new@hf.test', name: 'Newt', role: 'member', teamId: 't1' }); });
});

test('the drawer changes a role and shows the server refusal text', async () => {
  const f = mockFetch({ 'GET /api/me': [200, { user: ADMIN }], 'GET /api/teams': [200, { teams: [{ id: 't1', name: 'North' }] }],
    'GET /api/users': [200, { users: [{ ...USER_ALICE, activated: false }] }],
    'PATCH /api/users/u1': [400, { error: 'Managers and members must belong to a team.' }],
    'POST /api/users/u1/resend-invite': [204, null] });
  renderAt('/admin/users');
  expect(await screen.findByText('Invite sent')).toBeInTheDocument();
  await user.click(screen.getByText('Alice'));
  await chooseOption('Role', 'Manager');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText('Managers and members must belong to a team.')).toBeInTheDocument();
  expect(lastBody(f, '/api/users/u1')).toEqual({ role: 'manager' });
  await user.click(screen.getByRole('button', { name: 'Send invite again' }));
  await waitFor(() => { expect(f).toHaveBeenCalledWith('/api/users/u1/resend-invite', expect.objectContaining({ method: 'POST' })); });
});

test('your own row cannot change your own role or switch you off', async () => {
  mockFetch({ 'GET /api/me': [200, { user: ADMIN }], 'GET /api/teams': [200, { teams: [] }],
    'GET /api/users': [200, { users: [{ ...USER_ALICE, id: ADMIN.id, name: 'Ada', email: 'ada@hf.test', role: 'admin', teamId: null, teamName: null }] }] });
  renderAt('/admin/users');
  await user.click(await screen.findByText('ada@hf.test'));
  expect(await screen.findByText("You can't change your own role or disable your own account.")).toBeInTheDocument();
  expect(screen.queryByLabelText('Role')).toBeNull();
  expect(screen.queryByLabelText('Account active')).toBeNull();
});

test('an admin adds a team', async () => {
  const f = mockFetch({ 'GET /api/me': [200, { user: ADMIN }], 'GET /api/teams': [200, { teams: [] }], 'POST /api/teams': [201, { team: { id: 't2', name: 'South' } }] });
  renderAt('/admin/teams');
  expect(await screen.findByText('No teams yet')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Add team' }));
  await user.type(screen.getByLabelText('Team name'), 'South');
  await user.click(screen.getByRole('button', { name: 'Save team' }));
  await waitFor(() => { expect(lastBody(f, '/api/teams')).toEqual({ name: 'South' }); });
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
  await waitFor(() => { expect(f).toHaveBeenCalledWith('/api/audit?limit=50&before=2', expect.anything()); });
  expect(await screen.findByText('Ada 1')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
});

test('an empty activity log says so', async () => {
  mockFetch({ 'GET /api/me': [200, { user: ADMIN }], 'GET /api/audit?limit=50': [200, { entries: [], nextBefore: null }] });
  renderAt('/admin/audit');
  expect(await screen.findByText('Nothing recorded yet')).toBeInTheDocument();
});
