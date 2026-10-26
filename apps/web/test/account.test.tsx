import { test, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AuthProvider } from '../src/auth.js';
import { theme } from '../src/theme.js';
import { routeObjects } from '../src/routes.js';

const ALICE = { id: 'u1', email: 'alice@hf.test', name: 'Alice', role: 'member', teamId: 't1' };
const user = userEvent.setup();

type Reply = [number, unknown];
function mockFetch(replies: Record<string, Reply>) {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const r = replies[key];
    if (!r) return new Response(JSON.stringify({ error: `unmocked ${key}` }), { status: 500 });
    const [status, body] = r;
    return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', f);
  return f;
}
function lastBody(f: ReturnType<typeof mockFetch>, url: string): unknown {
  const calls = f.mock.calls.filter((c) => c[0] === url);
  const body = calls[calls.length - 1]?.[1]?.body;
  return typeof body === 'string' ? JSON.parse(body) : undefined;
}

function renderAt(path: string, hash = '') {
  window.history.replaceState(null, '', '/' + hash);
  const router = createMemoryRouter(routeObjects, { initialEntries: [path] });
  render(
    <MantineProvider theme={theme}>
      <Notifications />
      <AuthProvider><RouterProvider router={router} /></AuthProvider>
    </MantineProvider>,
  );
  return { router };
}
async function signIn() {
  await user.type(screen.getByLabelText('Email'), 'alice@hf.test');
  await user.type(screen.getByLabelText('Password'), 'a good long password');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

beforeEach(() => { window.history.replaceState(null, '', '/'); });
afterEach(() => vi.unstubAllGlobals());

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
  await waitFor(() => { expect(router.state.location.pathname).toBe('/notes'); });
});

test('sign-in goes to a same-site next page', async () => {
  mockFetch({ 'GET /api/me': [401, {}], 'POST /api/auth/sign-in': [200, { user: ALICE }] });
  const { router } = renderAt('/sign-in?next=%2Fprofile%3Ftab%3D2');
  await signIn();
  await waitFor(() => { expect(router.state.location.pathname).toBe('/profile'); });
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
  await waitFor(() => { expect(lastBody(f, '/api/auth/reset-password')).toEqual({ token: 'tok_abc', password: 'a good long password' }); });
});

test('a successful reset goes to sign-in with a notice', async () => {
  mockFetch({ 'GET /api/me': [401, {}], 'POST /api/auth/reset-password': [204, null] });
  const { router } = renderAt('/reset-password', '#tok_abc');
  await user.type(screen.getByLabelText('New password'), 'a good long password');
  await user.click(screen.getByRole('button', { name: 'Set new password' }));
  await waitFor(() => { expect(router.state.location.pathname).toBe('/sign-in'); });
  expect((await screen.findAllByText('Your password has been changed. Please sign in.')).length).toBeGreaterThan(0);
});

test('accept-invite signs the person straight in', async () => {
  const f = mockFetch({ 'GET /api/me': [401, {}], 'POST /api/auth/accept-invite': [200, { user: ALICE }] });
  const { router } = renderAt('/accept-invite', '#token=inv_123');
  expect(window.location.hash).toBe('');
  await user.type(screen.getByLabelText('New password'), 'a good long password');
  await user.click(screen.getByRole('button', { name: 'Set new password' }));
  await waitFor(() => { expect(router.state.location.pathname).toBe('/notes'); });
  expect(lastBody(f, '/api/auth/accept-invite')).toEqual({ token: 'inv_123', password: 'a good long password' });
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

test('profile saves the name and changes the password', async () => {
  const f = mockFetch({
    'GET /api/me': [200, { user: { ...ALICE, teamName: 'North' } }],
    'PATCH /api/me': [200, { user: { ...ALICE, name: 'Alice B', teamName: 'North' } }],
    'POST /api/me/password': [204, null],
  });
  renderAt('/profile');
  const name = await screen.findByLabelText('Your name');
  await user.clear(name);
  await user.type(name, 'Alice B');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => { expect(lastBody(f, '/api/me')).toEqual({ name: 'Alice B' }); });
  await user.type(screen.getByLabelText('Current password'), 'old password here');
  await user.type(screen.getByLabelText('New password'), 'a new long password');
  await user.click(screen.getByRole('button', { name: 'Change password' }));
  await waitFor(() => { expect(lastBody(f, '/api/me/password')).toEqual({ currentPassword: 'old password here', newPassword: 'a new long password' }); });
});
