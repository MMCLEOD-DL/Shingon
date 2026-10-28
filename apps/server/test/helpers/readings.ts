import { existsSync, readFileSync } from 'node:fs';
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../../src/db/client.js';
import { auditLog } from '../../src/db/schema/index.js';
import { call, signInAs, type TestApp } from './testApp.js';

const RECEIPT_PHOTOS = new URL('../../../../modules/ocr/test/fixtures/receipts/rendered/', import.meta.url);
const SERVER_FILES = new URL('../fixtures/files/', import.meta.url);

/** The bytes of a fixture: Task 3's receipt photos first, then the server's tiny sample files. */
export function fixtureBytes(name: string): Buffer {
  const photo = new URL(name, RECEIPT_PHOTOS);
  return readFileSync(existsSync(photo) ? photo : new URL(name, SERVER_FILES));
}

/** Uploads a fixture through POST /api/files as `user` and returns the new file. */
export async function upload(t: TestApp, user: { id: string }, fixture: string): Promise<{ id: string; contentType: string }> {
  const { cookie } = await signInAs(t, user);
  const res = await t.app.inject({
    method: 'POST', url: '/api/files',
    headers: { cookie, origin: t.config.appOrigin, 'content-type': 'multipart/form-data; boundary=b' },
    payload: Buffer.concat([
      Buffer.from(`--b\r\nContent-Disposition: form-data; name="file"; filename="${fixture}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      fixtureBytes(fixture),
      Buffer.from('\r\n--b--\r\n'),
    ]),
  });
  if (res.statusCode !== 201) throw new Error(`The upload of ${fixture} was refused with ${String(res.statusCode)}: ${res.body}`);
  return res.json<{ file: { id: string; contentType: string } }>().file;
}

/** Uploads the taxi photo, asks for a reading with the fake engine answering `textFixture`, waits for it and returns the reading id. */
export async function readingFor(t: TestApp, user: { id: string }, textFixture: string): Promise<string> {
  const f = await upload(t, user, 'taxi-photo.jpg');
  t.fakeOcr.next(textFixture);
  const r = await call(t, await signInAs(t, user), 'POST', `/api/files/${f.id}/reading`, {});
  if (r.status !== 202) throw new Error(`The reading was refused with ${String(r.status)}: ${r.text}`);
  await t.readings.idle();
  return r.json.reading.id as string;
}

/** The newest audit row with this action. */
export async function lastAudit(db: Db, action: string): Promise<typeof auditLog.$inferSelect> {
  const [row] = await db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.id)).limit(1);
  if (!row) throw new Error(`No audit row for ${action}.`);
  return row;
}
