import { test, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AuthProvider } from '../src/auth.js';
import { Shell } from '../src/Shell.js';
import { theme } from '../src/theme.js';

afterEach(() => vi.unstubAllGlobals());

test('the menu button says what it will do next', async () => {
  const me = { id: 'u1', email: 'a@x.test', name: 'Alice', role: 'member', teamId: null };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user: me }), { status: 200, headers: { 'content-type': 'application/json' } })));
  const router = createMemoryRouter([{ path: '/', element: <Shell /> }]);
  render(<MantineProvider theme={theme}><AuthProvider><RouterProvider router={router} /></AuthProvider></MantineProvider>);
  const burger = await screen.findByRole('button', { name: 'Open the menu' });
  await userEvent.click(burger);
  expect(await screen.findByRole('button', { name: 'Close the menu' })).toBeInTheDocument();
});
