import { test, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import { buildMoneyReport } from '@hf/shared';
import { defineRoute } from '../src/http/route.js';
import { sendReport } from '../src/modules/exports/reply.js';
import { createTestApp, call, signInAs, type TestApp } from './helpers/testApp.js';
import { makeUser } from './helpers/factories.js';
import { W1_MARCH } from '../../../packages/shared/test/worked-examples.js';

let t: TestApp;
let pdfError: unknown = null;

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
          await sendReport(reply, buildMoneyReport(W1_MARCH), 'xlsx', req.query.name ?? 'March 2026 expenses');
        },
      });
      defineRoute(app, {
        method: 'GET',
        url: '/api/test/report.pdf',
        access: { permission: 'self:manage' },
        schema: { query: z.strictObject({}) },
        async handler(_req, reply) {
          try {
            await sendReport(reply, buildMoneyReport(W1_MARCH), 'pdf', 'March 2026 expenses');
          } catch (e) {
            pdfError = e;
            throw e;
          }
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

test('PDF export is not installed yet: a plain sentence, and no download headers', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const r = await call(t, await signInAs(t, u), 'GET', '/api/test/report.pdf');
  expect(r.status).toBe(500);
  expect(r.headers['content-disposition']).toBeUndefined();
  expect((pdfError as Error).message).toBe('PDF export is not installed in this app.');
});
