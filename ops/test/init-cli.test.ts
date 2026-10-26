import { test, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runHelp, runInit, realIo, USAGE, type InitIo } from '../src/init-cli.js';

const base = ['--client', 'Acme Ltd', '--origin', 'https://app.acme.co.uk', '--site', 'app.acme.co.uk', '--dir', '/opt/highland/acme'];
function fakeIo(tty: boolean): InitIo & { out: string; err: string } {
  const io = { out: '', err: '', stdoutIsTTY: tty, stdout: (t: string) => { io.out += t; }, stderr: (t: string) => { io.err += t; }, writeNew: realIo.writeNew };
  return io;
}
const tmp = (): string => mkdtempSync(path.join(tmpdir(), 'hf-init-'));

test('on a terminal, init refuses to print secrets and says how to save them', () => {
  const io = fakeIo(true);
  expect(runInit(base, io)).toBe(2);
  expect(io.out).toBe('');
  expect(io.err).toContain('--out .env');
  expect(io.err).toContain('chmod 600 .env');
});

test('redirected to a file, init prints the settings and reminds the operator to chmod 600', () => {
  const io = fakeIo(false);
  expect(runInit(base, io)).toBe(0);
  expect(io.out).toContain('DB_PASSWORD=');
  expect(io.err).toContain('chmod 600');
});

test('--out creates the file readable only by its owner, and shows no secrets on screen', () => {
  const d = tmp();
  try {
    const f = path.join(d, '.env');
    const io = fakeIo(true);
    expect(runInit([...base, '--out', f], io)).toBe(0);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const db = /^DB_PASSWORD=(.*)$/m.exec(readFileSync(f, 'utf8'))![1]!;
    expect(io.out + io.err).not.toContain(db);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('--out never overwrites an existing file', () => {
  const d = tmp();
  try {
    const f = path.join(d, '.env');
    writeFileSync(f, 'KEEP=me\n');
    const io = fakeIo(false);
    expect(runInit([...base, '--out', f], io)).toBe(1);
    expect(readFileSync(f, 'utf8')).toBe('KEEP=me\n');
    expect(io.err).toContain('already exists');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a bad --origin or empty --client is refused in plain English, and nothing is written', () => {
  const d = tmp();
  try {
    const f = path.join(d, '.env');
    for (const origin of ['https://app.acme.co.uk/login', 'app.acme.co.uk', 'ftp://x.example', 'https://user:pw@x.example', 'https://x.example/?a=1']) {
      const io = fakeIo(false);
      expect(runInit(['--client', 'Acme', '--origin', origin, '--site', ':80', '--dir', '/x', '--out', f], io), origin).toBe(2);
      expect(io.err).toContain('--origin must be just the web address');
    }
    const io = fakeIo(false);
    expect(runInit(['--client', '   ', '--origin', 'https://x.example', '--site', ':80', '--dir', '/x', '--out', f], io)).toBe(2);
    expect(io.err).toContain('--client needs');
    expect(existsSync(f)).toBe(false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('--tunnel forces SITE_ADDRESS=:80 even when a public name is given, keeps the https origin, and says so', () => {
  const io = fakeIo(false);
  expect(runInit([...base, '--tunnel'], io)).toBe(0);
  expect(/^SITE_ADDRESS=(.*)$/m.exec(io.out)![1]).toBe(':80');
  expect(/^APP_ORIGIN=(.*)$/m.exec(io.out)![1]).toBe('https://app.acme.co.uk');
  expect(/^TUNNEL_ENABLED=(.*)$/m.exec(io.out)![1]).toBe('true');
  expect(io.err).toContain('SITE_ADDRESS has been set to :80');
});

test('ops help prints every command and exits 0; extra words are a usage error', () => {
  let out = '';
  let err = '';
  expect(runHelp([], (t) => { out += t; }, (t) => { err += t; })).toBe(0);
  expect(out).toBe(`${USAGE}\n`);
  expect(err).toBe('');
  for (const cmd of ['help', 'init', 'backup', 'restore-test', 'restore', 'check', 'check-edge', 'update', 'daemon']) expect(out).toContain(`\n  ${cmd}`);
  expect(out).toContain('docker compose run --rm ops <command>');
  expect(runHelp(['now'], () => undefined, (t) => { err += t; })).toBe(2);
  expect(err).toContain('help takes no options');
});
