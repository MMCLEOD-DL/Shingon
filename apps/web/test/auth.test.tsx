import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { AuthProvider, useAuth } from '../src/auth.js';
import { ALICE, user } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

function Probe() {
  const { user: u, loading, refresh } = useAuth();
  if (loading) return <p>loading</p>;
  return (<><p>{u ? `in:${u.name}` : 'out'}</p><button onClick={() => { void refresh(); }}>again</button></>);
}
const ui = () => render(<MantineProvider><AuthProvider><Probe /></AuthProvider></MantineProvider>);

test('a network blip on refresh keeps the person signed in; only a 401 signs them out', async () => {
  let mode: 'ok' | 'down' | 'gone' | 'boom' = 'ok';
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (mode === 'down') throw new TypeError('network');
    if (mode === 'boom') return new Response(JSON.stringify({ error: 'Something broke.' }), { status: 500 });
    if (mode === 'gone') return new Response(JSON.stringify({ error: 'Please sign in.' }), { status: 401 });
    return new Response(JSON.stringify({ user: ALICE }), { status: 200 });
  }));
  ui();
  expect(await screen.findByText('in:Alice')).toBeInTheDocument();
  mode = 'down';
  await user.click(screen.getByRole('button', { name: 'again' }));
  await waitFor(() => { expect(fetch).toHaveBeenCalledTimes(2); });
  expect(screen.getByText('in:Alice')).toBeInTheDocument();
  mode = 'boom';
  await user.click(screen.getByRole('button', { name: 'again' }));
  await waitFor(() => { expect(fetch).toHaveBeenCalledTimes(3); });
  expect(screen.getByText('in:Alice')).toBeInTheDocument();
  mode = 'gone';
  await user.click(screen.getByRole('button', { name: 'again' }));
  expect(await screen.findByText('out')).toBeInTheDocument();
});
