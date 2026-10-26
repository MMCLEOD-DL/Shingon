import { test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { createTestApp, signInAs } from './helpers/testApp.js';
import { makeTeam, makeUser } from './helpers/factories.js';
import { files } from '../src/db/schema/index.js';

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
  expect(body(r).error).toBe('That file is too large. The limit is 0 MB.');
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
