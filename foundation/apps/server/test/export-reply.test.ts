import { test, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import { defineRoute } from '../src/http/route.js';
import { oneExportAtATime, sendReport } from '../src/modules/exports/reply.js';
import { DEFAULT_PROFILE, buildMoneyReport, type ModuleName } from '@hf/shared';
import { createTestApp, call, signInAs, type TestApp } from './helpers/testApp.js';
import { makeUser } from './helpers/factories.js';
import { W1_MARCH } from '../../../packages/shared/test/worked-examples.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({
    beforeReady(app) {
      // Test-only routes: a real route would read its rows through visibleTo before building the report.
      defineRoute(app, {
        method: 'GET',
        url: '/api/test/report.xlsx',
        access: { permission: 'self:manage' },
        schema: { query: z.strictObject({ name: z.string().optional() }) },
        async handler(req, reply) {
          await sendReport(reply, t.config, buildMoneyReport(W1_MARCH), 'xlsx', req.query.name ?? 'March 2026 expenses');
        },
      });
      defineRoute(app, {
        method: 'GET',
        url: '/api/test/report.pdf',
        access: { permission: 'self:manage' },
        schema: { query: z.strictObject({}) },
        async handler(_req, reply) {
          await sendReport(reply, t.config, buildMoneyReport(W1_MARCH), 'pdf', 'March 2026 expenses');
        },
      });
    },
  });
});
afterAll(async () => { await t.close(); });

test('a spreadsheet download has the right headers and a ZIP body', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const res = await t.app.inject({ method: 'GET', url: '/api/test/report.xlsx', headers: { cookie: (await signInAs(t, u)).cookie, origin: t.config.appOrigin } });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  expect(res.headers['content-disposition']).toBe("attachment; filename*=UTF-8''March%202026%20expenses.xlsx");
  expect(res.headers['cache-control']).toBe('private, no-store');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(Number(res.headers['content-length'])).toBe(res.rawPayload.length);
  expect(res.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
});

test('the file name keeps its letters but loses path separators and control characters', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const name = encodeURIComponent('Łódź: March/April\u202e\u0007 (draft)');
  const r = await call(t, await signInAs(t, u), 'GET', `/api/test/report.xlsx?name=${name}`);
  expect(r.status).toBe(200);
  expect(r.headers['content-disposition']).toBe("attachment; filename*=UTF-8''%C5%81%C3%B3d%C5%BA%3A%20March%20April%20%28draft%29.xlsx");
});

test('a stranger gets 401 and no file', async () => {
  const r = await call(t, null, 'GET', '/api/test/report.xlsx');
  expect(r.status).toBe(401);
  expect(r.headers['content-disposition']).toBeUndefined();
});

test('a PDF download has the right headers and a PDF body', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const res = await t.app.inject({ method: 'GET', url: '/api/test/report.pdf', headers: { cookie: (await signInAs(t, u)).cookie, origin: t.config.appOrigin } });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('application/pdf');
  expect(res.headers['content-disposition']).toBe("attachment; filename*=UTF-8''March%202026%20expenses.pdf");
  expect(res.headers['cache-control']).toBe('private, no-store');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(Number(res.headers['content-length'])).toBe(res.rawPayload.length);
  expect(res.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
});

test('a long file name is cut to 120 characters, keeping the extension', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const r = await call(t, await signInAs(t, u), 'GET', `/api/test/report.xlsx?name=${encodeURIComponent('Ł'.repeat(300))}`);
  expect(r.status).toBe(200);
  const name = decodeURIComponent(/filename\*=UTF-8''(.*)$/.exec(String(r.headers['content-disposition']))![1]!);
  expect(name).toBe(`${'Ł'.repeat(115)}.xlsx`);
  expect(Array.from(name)).toHaveLength(120);
});

test('sendReport answers 404 when the module for the asked-for format is off, and makes no file', async () => {
  for (const [modules, xlsx, pdf] of [
    [['xlsx-export'], 200, 404],
    [['pdf-export'], 404, 200],
    [[], 404, 404],
  ] as [ModuleName[], number, number][]) {
    const off = await createTestApp({
      profile: { ...structuredClone(DEFAULT_PROFILE), modules },
      beforeReady(app) {
        // Registered by mistake, outside moduleOn: sendReport still refuses.
        defineRoute(app, {
          method: 'GET', url: '/api/test/r.:ext', access: { permission: 'self:manage' },
          schema: { params: z.strictObject({ ext: z.enum(['pdf', 'xlsx']) }) },
          async handler(req, reply) { await sendReport(reply, off.config, buildMoneyReport(W1_MARCH), req.params.ext, 'March'); },
        });
      },
    });
    try {
      const auth = await signInAs(off, await makeUser(off.db, { role: 'member' }));
      const x = await call(off, auth, 'GET', '/api/test/r.xlsx');
      const p = await call(off, auth, 'GET', '/api/test/r.pdf');
      expect([x.status, p.status]).toEqual([xlsx, pdf]);
      for (const r of [x, p]) if (r.status === 404) expect(r.headers['content-disposition']).toBeUndefined();
    } finally {
      await off.close();
    }
  }
});

test('exports are made one at a time; a failed one does not hold up the next', async () => {
  let inFlight = 0;
  let max = 0;
  const job = (ms: number, fail = false) => () => new Promise<number>((resolve, reject) => {
    inFlight++;
    max = Math.max(max, inFlight);
    setTimeout(() => { inFlight--; if (fail) reject(new Error('render failed')); else resolve(ms); }, ms);
  });
  const results = await Promise.allSettled([oneExportAtATime(job(20)), oneExportAtATime(job(5, true)), oneExportAtATime(job(10)), oneExportAtATime(job(1))]);
  expect(max).toBe(1);
  expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
});
