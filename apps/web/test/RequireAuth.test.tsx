import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { createMemoryRouter, useLocation } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AuthProvider, RequireAuth, RequirePermission } from '../src/auth.js';
import { theme } from '../src/theme.js';

afterEach(() => vi.unstubAllGlobals());

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
}

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/notes', element: <RequireAuth><p>Secret notes</p></RequireAuth> },
      { path: '/admin/users', element: <RequireAuth><RequirePermission perm="users:manage"><p>Admin area</p></RequirePermission></RequireAuth> },
      { path: '/sign-in', element: <Where /> },
    ],
    { initialEntries: [path] },
  );
  render(<MantineProvider theme={theme}><AuthProvider><RouterProvider router={router} /></AuthProvider></MantineProvider>);
  return router;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('a signed-out visitor is sent to sign in, remembering where they were going', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: 'Please sign in.' })));
  const router = renderAt('/notes');
  await waitFor(() => { expect(router.state.location.pathname).toBe('/sign-in'); });
  expect(router.state.location.search).toBe('?next=%2Fnotes');
  expect(screen.queryByText('Secret notes')).toBeNull();
});

test('a signed-in member without the permission sees a plain message, not the page', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(200, { user: { id: 'u1', email: 'a@x.test', name: 'Alice', role: 'member', teamId: null } })));
  renderAt('/admin/users');
  expect(await screen.findByText("You don't have access to this page")).toBeInTheDocument();
  expect(screen.queryByText('Admin area')).toBeNull();
});
