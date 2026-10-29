import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { createTestApp, call, signInAs, type TestApp } from './helpers/testApp.js';
import { LocalDiskStorage } from '../src/files/storage.js';
import { sweepStrayObjects } from '../src/files/repo.js';
import { makeTeam, makeUser } from './helpers/factories.js';
import { cleanName } from '../src/files/routes.js';
import { files, auditLog } from '../src/db/schema/index.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
let alice: { id: string }, carol: { id: string }, northId: string, auth: { cookie: string };
const body = (r: { json(): unknown }) => r.json() as { file: { id: string; name: string }; error: string };
const fx = (n: string) => readFileSync(new URL(`./fixtures/files/${n}`, import.meta.url));
beforeAll(async () => {
  t = await createTestApp({ uploadMaxBytes: 1024 });
  const N = await makeTeam(t.db, 'N'); northId = N.id; const S = await makeTeam(t.db, 'S');
  alice = await makeUser(t.db, { role: 'member', teamId: N.id });
  carol = await makeUser(t.db, { role: 'member', teamId: S.id });
  auth = await signInAs(t, alice);
});
afterAll(async () => { await t.close(); });

function upload(cookie: string, name: string, body: Buffer) {
  const boundary = 'hfboundary';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/jpeg\r\n\r\n`),
    body, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return t.app.inject({ method: 'POST', url: '/api/files', payload,
    headers: { cookie, origin: 'http://hf.test', 'content-type': `multipart/form-data; boundary=${boundary}` } });
}

test('a phone photo uploads and downloads with safe headers', async () => {
  const r = await upload(auth.cookie, 'IMG_0001.HEIC', fx('tiny.heic'));
  expect(r.statusCode).toBe(201);
  const file = body(r).file;
  expect(file).toMatchObject({ name: 'IMG_0001.HEIC', contentType: 'image/heic', size: fx('tiny.heic').length });
  const d = await t.app.inject({ method: 'GET', url: `/api/files/${file.id}/content`, headers: { cookie: auth.cookie } });
  expect(d.statusCode).toBe(200);
  expect(d.headers['x-content-type-options']).toBe('nosniff');
  expect(d.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  expect(d.headers['cache-control']).toBe('private, no-store');
  expect(d.headers['content-type']).toBe('image/heic');
  expect(d.headers['content-disposition']).toBe("attachment; filename*=UTF-8''IMG_0001.HEIC");
  expect(d.rawPayload.equals(fx('tiny.heic'))).toBe(true);
});

test('a raster image is shown inline, a PDF is a download, and odd file names are encoded and stripped', async () => {
  const png = body(await upload(auth.cookie, '../../etc/we irdé (1).png', fx('tiny.png'))).file;
  expect(png.name).toBe('we irdé (1).png');
  const d = await t.app.inject({ method: 'GET', url: `/api/files/${png.id}/content`, headers: { cookie: auth.cookie } });
  expect(d.headers['content-disposition']).toBe("inline; filename*=UTF-8''we%20ird%C3%A9%20%281%29.png");
  expect(d.headers['content-type']).toBe('image/png');
  const pdf = body(await upload(auth.cookie, 'bill.pdf', fx('tiny.pdf'))).file;
  const p = await t.app.inject({ method: 'GET', url: `/api/files/${pdf.id}/content`, headers: { cookie: auth.cookie } });
  expect(p.headers['content-disposition']).toMatch(/^attachment; /);
  expect(p.headers['content-type']).toBe('application/pdf');
  const [row] = await t.db.select().from(files).where(eq(files.id, png.id));
  expect(row!.storageKey).toMatch(/^[a-f0-9]{32}$/);
  expect(row!.teamId).toBe(northId);
});

test('a disguised SVG/HTML, an empty file and an oversized file are refused', async () => {
  const before = readdirCount(t.storageDir);
  for (const n of ['evil.svg', 'evil.html']) {
    const r = await upload(auth.cookie, 'receipt.jpg', fx(n));
    expect(r.statusCode).toBe(400);
    expect(body(r).error).toBe("That kind of file isn't accepted. Use a photo (JPEG, PNG, WebP, HEIC) or a PDF.");
  }
  const empty = await upload(auth.cookie, 'empty.jpg', Buffer.alloc(0));
  expect(empty.statusCode).toBe(400);
  expect(body(empty).error).toBe('That file is empty.');
  const exact = Buffer.concat([fx('tiny.jpg'), Buffer.alloc(1024 - fx('tiny.jpg').length)]);
  expect((await upload(auth.cookie, 'exact.jpg', exact)).statusCode).toBe(201);
  const big = Buffer.concat([fx('tiny.jpg'), Buffer.alloc(1025 - fx('tiny.jpg').length)]);
  const r = await upload(auth.cookie, 'big.jpg', big);
  expect(r.statusCode).toBe(413);
  expect(body(r).error).toBe('That file is too large. The limit is 1 KB.');
  expect(readdirCount(t.storageDir)).toBe(before + 1); // only the exact-size file; nothing partial left behind
});

test('the file is removed from disk when the database insert fails', async () => {
  const before = readdirCount(t.storageDir);
  // A constraint nothing can satisfy makes the insert fail after the bytes are already stored.
  await t.db.execute(sql`alter table files add constraint files_test_fail check (false) not valid`);
  try {
    const r = await upload(auth.cookie, 'a.png', fx('tiny.png'));
    expect(r.statusCode).toBe(500);
  } finally {
    await t.db.execute(sql`alter table files drop constraint files_test_fail`);
  }
  expect(readdirCount(t.storageDir)).toBe(before);
});

test('another team\'s member gets 404 for the file and its content, and cannot delete it', async () => {
  const r = await upload(auth.cookie, 'a.png', fx('tiny.png'));
  const id = body(r).file.id;
  const c = await signInAs(t, carol);
  for (const url of [`/api/files/${id}`, `/api/files/${id}/content`])
    expect((await t.app.inject({ method: 'GET', url, headers: { cookie: c.cookie } })).statusCode).toBe(404);
  expect((await t.app.inject({ method: 'DELETE', url: `/api/files/${id}`, headers: { cookie: c.cookie, origin: 'http://hf.test' } })).statusCode).toBe(404);
});

test('an extra field, or a field after the file, is refused and nothing is kept', async () => {
  const before = readdirCount(t.storageDir);
  const b = 'hfb2';
  const filePart = `--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n\r\n`;
  const field = `--${b}\r\nContent-Disposition: form-data; name="ownerId"\r\n\r\nsomeone\r\n`;
  const end = `\r\n--${b}--\r\n`;
  for (const payload of [Buffer.concat([Buffer.from(field + filePart), fx('tiny.png'), Buffer.from(end)]),
                         Buffer.concat([Buffer.from(filePart), fx('tiny.png'), Buffer.from(`\r\n${field}--${b}--\r\n`)])]) {
    const r = await t.app.inject({ method: 'POST', url: '/api/files', payload,
      headers: { cookie: auth.cookie, origin: 'http://hf.test', 'content-type': `multipart/form-data; boundary=${b}` } });
    expect(r.statusCode).toBe(400);
  }
  expect(readdirCount(t.storageDir)).toBe(before);
});

test('a missing stored object gives a plain 404 with no download headers', async () => {
  const id = body(await upload(auth.cookie, 'lost.png', fx('tiny.png'))).file.id;
  const [row] = await t.db.select().from(files).where(eq(files.id, id));
  rmSync(path.join(t.storageDir, row!.storageKey.slice(0, 2), row!.storageKey));
  const d = await t.app.inject({ method: 'GET', url: `/api/files/${id}/content`, headers: { cookie: auth.cookie } });
  expect(d.statusCode).toBe(404);
  expect(d.json()).toEqual({ error: 'We could not find that file.' });
  expect(d.headers['content-disposition']).toBeUndefined();
  expect(d.headers['cache-control']).toBe('no-store');
});

test('malformed and non-multipart uploads are a plain 400', async () => {
  const h = { cookie: auth.cookie, origin: 'http://hf.test' };
  const cases: [string, string | Buffer][] = [
    ['application/json', '{}'],
    ['multipart/form-data', 'whatever'],
    ['multipart/form-data; boundary=zz', '--zz\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n\r\nabc'],
    ['multipart/form-data; boundary=zz', ''],
  ];
  for (const [type, payload] of cases) {
    const r = await t.app.inject({ method: 'POST', url: '/api/files', payload, headers: { ...h, 'content-type': type } });
    expect(r.statusCode, type).toBe(400);
    expect(typeof body(r).error).toBe('string');
  }
});

test('file names lose control characters and bidi overrides; long non-ASCII names are accepted', async () => {
  expect(cleanName('a\u0085b\u202ec\u2066d\u0007.png')).toBe('abcd.png');
  expect(cleanName('///')).toBe('file');
  const long = '\u00e9'.repeat(150) + '.png';
  const r = await upload(auth.cookie, long, fx('tiny.png'));
  expect(r.statusCode).toBe(201);
  expect(body(r).file.name).toBe(long);
});

test('HEAD on the content route does not write a download audit row; GET does', async () => {
  const id = body(await upload(auth.cookie, 'h.png', fx('tiny.png'))).file.id;
  const count = async () => (await t.db.select().from(auditLog).where(eq(auditLog.action, 'file.downloaded'))).length;
  const n = await count();
  await t.app.inject({ method: 'HEAD', url: `/api/files/${id}/content`, headers: { cookie: auth.cookie } });
  expect(await count()).toBe(n);
  await t.app.inject({ method: 'GET', url: `/api/files/${id}/content`, headers: { cookie: auth.cookie } });
  expect(await count()).toBe(n + 1);
});

test('delete refuses a query string', async () => {
  const id = body(await upload(auth.cookie, 'q.png', fx('tiny.png'))).file.id;
  const r = await t.app.inject({ method: 'DELETE', url: `/api/files/${id}?x=1`, headers: { cookie: auth.cookie, origin: 'http://hf.test' } });
  expect(r.statusCode).toBe(400);
});

test('uploads are limited to 60 per 15 minutes per user', async () => {
  const u = await makeUser(t.db, { role: 'member', teamId: northId });
  const a = await signInAs(t, u);
  let last = 0;
  for (let i = 0; i < 61; i++) last = (await upload(a.cookie, 'r.png', fx('tiny.png'))).statusCode;
  expect(last).toBe(429);
  // Another user is not affected.
  expect((await upload(auth.cookie, 'ok.png', fx('tiny.png'))).statusCode).toBe(201);
});

test('the owner can delete a file, which removes the bytes too', async () => {
  const id = body(await upload(auth.cookie, 'gone.png', fx('tiny.png'))).file.id;
  const before = readdirCount(t.storageDir);
  const d = await t.app.inject({ method: 'DELETE', url: `/api/files/${id}`, headers: { cookie: auth.cookie, origin: 'http://hf.test' } });
  expect(d.statusCode).toBe(204);
  expect(readdirCount(t.storageDir)).toBe(before - 1);
  expect((await t.app.inject({ method: 'GET', url: `/api/files/${id}`, headers: { cookie: auth.cookie } })).statusCode).toBe(404);
});

const readdirCount = (dir: string) => countFiles(dir); // stored objects, ignoring in-flight .tmp files
function countFiles(d: string): number { return readdirSync(d).reduce((n, e) => { const p = path.join(d, e); return n + (statSync(p).isDirectory() ? countFiles(p) : e.endsWith('.tmp') ? 0 : 1); }, 0); }

describe('deleting a file: the row goes first, then the object', () => {
  const send = (a: TestApp, cookie: string, name: string, bytes: Buffer) => {
    const boundary = 'hfboundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return a.app.inject({ method: 'POST', url: '/api/files', payload, headers: { cookie, origin: 'http://hf.test', 'content-type': `multipart/form-data; boundary=${boundary}` } });
  };

  test("a file shown on a note: the note's photo is cleared in the same change, and that is audited on the note", async () => {
    const a = await createTestApp();
    try {
      const T = await makeTeam(a.db, 'T');
      const owner = await makeUser(a.db, { role: 'member', teamId: T.id });
      const c = await signInAs(a, owner);
      const fileId = body(await send(a, c.cookie, 'photo.png', fx('tiny.png'))).file.id;
      const note = await call(a, c, 'POST', '/api/notes', { title: 'With a photo', body: '', attachmentId: fileId });
      expect(note.status).toBe(201);
      const noteId = (note.json as { note: { id: string } }).note.id;
      expect((await call(a, c, 'DELETE', `/api/files/${fileId}`)).status).toBe(204);
      const after = await call(a, c, 'GET', `/api/notes/${noteId}`);
      expect(after.status).toBe(200);
      expect((after.json as { note: { attachment: unknown; updatedAt: string; createdAt: string } }).note.attachment).toBeNull();
      const rows = await a.db.select().from(auditLog).orderBy(auditLog.id);
      expect(rows.slice(-2).map((r) => [r.action, r.targetId, r.details])).toEqual([
        ['note.updated', noteId, { fields: ['attachmentId'], fileDeleted: fileId }],
        ['file.deleted', fileId, { name: 'photo.png' }],
      ]);
      expect(await a.db.select().from(files)).toEqual([]);
    } finally {
      await a.close();
    }
  });

  test('when the stored object cannot be removed, the file is still gone for everyone and the sweep collects the object later', async () => {
    const a = await createTestApp({
      storage: (dir) => Object.assign(Object.create(new LocalDiskStorage(dir)) as LocalDiskStorage, {
        delete: () => Promise.reject(Object.assign(new Error('/secret/disk/path denied'), { code: 'EACCES' })),
      }),
    });
    try {
      const T = await makeTeam(a.db, 'T');
      const owner = await makeUser(a.db, { role: 'member', teamId: T.id });
      const c = await signInAs(a, owner);
      const fileId = body(await send(a, c.cookie, 'stuck.png', fx('tiny.png'))).file.id;
      expect((await call(a, c, 'DELETE', `/api/files/${fileId}`)).status).toBe(204);
      expect((await call(a, c, 'GET', `/api/files/${fileId}`)).status).toBe(404);
      expect(await a.db.select().from(files)).toEqual([]);
      // the object outlived its row: the disk-side sweep removes it
      const disk = new LocalDiskStorage(a.storageDir);
      expect(countFiles(a.storageDir)).toBe(1);
      expect(await sweepStrayObjects(a.db, disk, new Date(Date.now() + 60e3))).toBe(1);
      expect(countFiles(a.storageDir)).toBe(0);
    } finally {
      await a.close();
    }
  });
});
