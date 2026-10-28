import { vi, type Mock } from 'vitest';
import { screen } from '@testing-library/react';
import type { ReadingView, ReceiptProposal } from '@hf/shared';

type Pair<T> = [T, number];

/** A `read` reading whose proposal is built from [value, confidence] pairs; a field left out was not found. */
export function readWith(fields: { amount?: Pair<number>; vat?: Pair<number | null>; date?: Pair<string>; merchant?: Pair<string> }, over: Partial<ReadingView> = {}): ReadingView {
  const scored = <T,>(p: Pair<T> | undefined) => (p ? { value: p[0], confidence: p[1] } : null);
  const proposal: ReceiptProposal = {
    amountPence: scored(fields.amount),
    vatPence: scored(fields.vat),
    date: scored(fields.date),
    merchant: scored(fields.merchant),
    currency: 'GBP',
    warnings: [],
  };
  return {
    id: 'r1', fileId: 'f1', status: 'read', engine: 'fake', proposal, problem: null, confirmed: null, corrected: [],
    ownerId: 'u1', createdAt: '2026-10-01T10:00:00.000Z', confirmedAt: null, ...over,
  };
}

export function pendingView(over: Partial<ReadingView> = {}): ReadingView {
  return { ...readWith({}), status: 'pending', engine: null, proposal: null, ...over };
}

export function confirmedView(over: Partial<ReadingView> = {}): ReadingView {
  return {
    ...readWith({ amount: [1240, 0.97], vat: [270, 0.5], date: ['2026-03-12', 0.95], merchant: ['Northside Taxis', 0.6] }),
    status: 'confirmed',
    confirmed: { amountPence: 1240, vatPence: 207, date: '2026-03-12', merchant: 'Northside Taxis' },
    corrected: ['vat'],
    confirmedAt: '2026-10-01T10:05:00.000Z',
    ...over,
  };
}

/** A reply the server could give instead of a reading: its status and plain sentence. */
export class Refusal {
  constructor(readonly status: number, readonly error: string) {}
}

type Handler = Mock<(id: string, body?: unknown) => ReadingView | Refusal>;
const ROUTES = {
  requestReading: { method: 'POST', re: /^\/api\/files\/([^/]+)\/reading$/, status: 202 },
  getReading: { method: 'GET', re: /^\/api\/readings\/([^/]+)$/, status: 200 },
  confirmReading: { method: 'POST', re: /^\/api\/readings\/([^/]+)\/confirm$/, status: 200 },
} as const;
const handlers = new Map<keyof typeof ROUTES, Handler>();
const extra = new Map<string, [number, unknown]>();

/**
 * Answers one of the reading calls through a stubbed fetch, so the real api.ts code runs. Returns a spy called with
 * (id, body) for every call; `mockReturnValueOnce` on it gives a sequence of answers.
 */
export function mockApi(name: keyof typeof ROUTES, result: ReadingView | Refusal): Handler {
  const spy: Handler = vi.fn(() => result);
  handlers.set(name, spy);
  stub();
  return spy;
}

/** Any other call (GET /api/me, GET /api/files/f1) answered with a fixed reply. */
export function mockReply(key: string, status: number, body: unknown): void {
  extra.set(key, [status, body]);
  stub();
}

export function resetApi(): void {
  handlers.clear();
  extra.clear();
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const fixed = extra.get(`${method} ${url}`);
    if (fixed) return json(fixed[0], fixed[1]);
    for (const [name, route] of Object.entries(ROUTES) as [keyof typeof ROUTES, (typeof ROUTES)[keyof typeof ROUTES]][]) {
      const m = route.re.exec(url);
      const spy = handlers.get(name);
      if (route.method !== method || !m || !spy) continue;
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const r = spy(decodeURIComponent(m[1]!), body);
      return r instanceof Refusal ? json(r.status, { error: r.error }) : json(route.status, { reading: r });
    }
    return json(500, { error: `unmocked ${method} ${url}` });
  }));
}

/** The wrapper of the form field with this label: its input, its badge and its message. */
export function fieldOf(label: string): HTMLElement {
  const input = screen.getByLabelText(label);
  const field = input.closest<HTMLElement>('[data-field]');
  if (!field) throw new Error(`The ${label} input is not inside a [data-field] wrapper.`);
  return field;
}
