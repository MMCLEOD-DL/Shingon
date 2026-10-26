import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AuthProvider } from '../src/auth.js';
import { theme } from '../src/theme.js';
import { routeObjects } from '../src/routes.js';

export { setMobile } from './setup.js';
export const user = userEvent.setup();

export const ALICE = { id: 'u1', email: 'alice@hf.test', name: 'Alice', role: 'member', teamId: 't1', teamName: 'North' };
export const MANAGER = { id: 'u2', email: 'mo@hf.test', name: 'Mo', role: 'manager', teamId: 't1', teamName: 'North' };
export const ADMIN = { id: 'u3', email: 'ada@hf.test', name: 'Ada', role: 'admin', teamId: null, teamName: null };
export const USER_ALICE = { id: 'u1', email: 'alice@hf.test', name: 'Alice', role: 'member', teamId: 't1', teamName: 'North', disabled: false, activated: true };
export const FILE = { id: 'f1', name: 'r.jpg', contentType: 'image/jpeg', size: 3, createdAt: '2026-10-01T10:00:00.000Z', ownerId: 'u1' };
export const NOTE = {
  id: 'n1', title: 'Taxi to client', body: 'Receipt attached.', ownerId: 'u1', ownerName: 'Alice', teamId: 't1', attachment: null,
  createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', canEdit: true,
};
export const ENTRY = (n: number) => ({
  id: n, at: '2026-10-01T10:00:00.000Z', actorLabel: `Ada ${String(n)}`, action: 'user.updated', targetType: 'user', targetId: 'u1', details: {}, ip: null,
});

type Reply = [number, unknown];
export function mockFetch(replies: Record<string, Reply>) {
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
export function lastBody(f: ReturnType<typeof mockFetch>, url: string): unknown {
  const calls = f.mock.calls.filter((c) => c[0] === url && typeof c[1]?.body === 'string');
  const body = calls[calls.length - 1]?.[1]?.body;
  return typeof body === 'string' ? JSON.parse(body) : undefined;
}

export function Wrap({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MantineProvider theme={theme} env="test">
      <Notifications />
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </MantineProvider>
  );
}

export function renderAt(path: string, hash = '') {
  window.history.replaceState(null, '', '/' + hash);
  const router = createMemoryRouter(routeObjects, { initialEntries: [path] });
  render(<Wrap><AuthProvider><RouterProvider router={router} /></AuthProvider></Wrap>);
  return { router };
}

/** Opens a Mantine Select by its label and picks an option. */
export async function chooseOption(label: string, option: string) {
  const input = screen.getAllByLabelText(label).find((el) => el.tagName === 'INPUT');
  if (!input) throw new Error(`No select labelled ${label}`);
  await user.click(input);
  await user.click(await screen.findByRole('option', { name: option }));
}
