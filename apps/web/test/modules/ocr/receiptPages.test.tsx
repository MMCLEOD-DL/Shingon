import { test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import type { RouteObject } from 'react-router';
import { ADMIN, ALICE, FILE, MANAGER, renderAt, user } from '../../helpers.js';
import { appPathsFor } from '../../../src/appPaths.js';
import { navFor } from '../../../src/nav.js';
import { routeObjectsFor } from '../../../src/routes.js';
import { mockApi, mockReply, pendingView, readWith, resetApi } from './testHelpers.js';

afterEach(() => { vi.unstubAllGlobals(); resetApi(); });

const TAXI = readWith({ amount: [1240, 0.97], vat: [207, 0.6], date: ['2026-03-12', 0.95], merchant: ['Northside Taxis', 0.9] });
const PDF = { ...FILE, id: 'f1', name: 'e-ticket.pdf', contentType: 'application/pdf' };

test('Read a receipt: a chosen file is uploaded, a reading is asked for (with an empty body) and its page opens', async () => {
  mockReply('GET /api/me', 200, { user: ALICE });
  mockReply('POST /api/files', 201, { file: PDF });
  const ask = mockApi('requestReading', pendingView());
  mockApi('getReading', TAXI);
  mockReply('GET /api/files/f1', 200, { file: PDF });
  const { router } = renderAt('/receipts/new');
  expect(await screen.findByRole('heading', { name: 'Read a receipt' })).toBeVisible();
  await user.upload(screen.getByTestId('file-input'), new File(['%PDF-1.4'], 'e-ticket.pdf', { type: 'application/pdf' }));
  await waitFor(() => { expect(router.state.location.pathname).toBe('/receipts/r1'); });
  expect(ask).toHaveBeenCalledWith('f1', {});
  expect(await screen.findByRole('heading', { name: 'Check the details' })).toBeVisible();
});

test('Check the details: while the receipt is read the page says so', async () => {
  mockReply('GET /api/me', 200, { user: ALICE });
  mockApi('getReading', pendingView());
  mockReply('GET /api/files/f1', 200, { file: FILE });
  renderAt('/receipts/r1');
  expect(await screen.findByText('Reading your receipt…')).toBeVisible();
  expect(screen.queryByLabelText('Total')).toBeNull();
});

test('Check the details: the owner sees the photo, the fields and Confirm', async () => {
  mockReply('GET /api/me', 200, { user: ALICE });
  mockApi('getReading', TAXI);
  mockReply('GET /api/files/f1', 200, { file: FILE });
  renderAt('/receipts/r1');
  expect(await screen.findByRole('heading', { name: 'Check the details' })).toBeVisible();
  expect(await screen.findByLabelText('Total')).toHaveValue('12.40');
  expect(await screen.findByText('r.jpg')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeVisible();
});

test('Check the details: a manager looking at a team member\'s receipt cannot confirm it', async () => {
  mockReply('GET /api/me', 200, { user: MANAGER });
  mockApi('getReading', TAXI);
  mockReply('GET /api/files/f1', 200, { file: FILE });
  renderAt('/receipts/r1');
  expect(await screen.findByText('Only the person who uploaded this receipt can confirm it.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
});

test('Check the details: an admin may confirm someone else\'s receipt', async () => {
  mockReply('GET /api/me', 200, { user: ADMIN });
  mockApi('getReading', TAXI);
  mockReply('GET /api/files/f1', 200, { file: FILE });
  renderAt('/receipts/r1');
  expect(await screen.findByRole('button', { name: 'Confirm' })).toBeVisible();
});

test('Check the details: a reading that cannot be seen shows the server\'s sentence', async () => {
  mockReply('GET /api/me', 200, { user: ALICE });
  mockReply('GET /api/readings/r9', 404, { error: "We couldn't find that." });
  renderAt('/receipts/r9');
  expect(await screen.findByText("We couldn't find that.")).toBeVisible();
});

const paths = (routes: RouteObject[]): string[] => routes.flatMap((r) => [...(r.path ? [r.path] : []), ...paths(r.children ?? [])]);

test('the receipt pages, their paths and the Receipts menu entry exist only when the ocr module is built in', () => {
  expect(paths(routeObjectsFor(['ocr']))).toEqual(expect.arrayContaining(['/receipts/new', '/receipts/:id']));
  expect(paths(routeObjectsFor([])).filter((p) => p.startsWith('/receipts'))).toEqual([]);
  expect(appPathsFor(['ocr']).filter((p) => p.module === 'ocr')).toEqual([
    { path: '/receipts/new', auth: 'signed-in', module: 'ocr' },
    { path: '/receipts/:id', auth: 'signed-in', module: 'ocr' },
  ]);
  expect(appPathsFor(['pdf-export']).filter((p) => p.path.startsWith('/receipts'))).toEqual([]);
  expect(navFor('member', ['ocr']).map((n) => n.label)).toContain('Receipts');
  expect(navFor('member', []).map((n) => n.label)).not.toContain('Receipts');
});
