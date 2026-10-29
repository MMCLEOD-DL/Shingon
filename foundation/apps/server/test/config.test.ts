import { test, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';
import { startFailure } from '../src/startup.js';

const base = {
  APP_ORIGIN: 'https://app.example.co.uk', DATABASE_URL: 'postgres://u:p@localhost/db',
  UPLOAD_DIR: '/data/uploads', EMAIL_FROM: 'App <app@example.co.uk>', SMTP_URL: 'smtp://localhost:1025',
};

test('defaults are applied', () => {
  const c = loadConfig(base);
  expect(c).toMatchObject({ instanceMode: 'demo', appName: 'Highland App', port: 3000, cookieSecure: true,
    uploadMaxBytes: 15728640, email: { transport: 'smtp', smtpUrl: 'smtp://localhost:1025', from: 'App <app@example.co.uk>', pollMs: 5000 },
    appVersion: '0.0.0-dev', commit: 'unknown' });
});

test('http origin turns secure cookies off by default', () => {
  expect(loadConfig({ ...base, APP_ORIGIN: 'http://192.168.1.20:8080' }).cookieSecure).toBe(false);
});

test('every problem is listed in plain English at once', () => {
  try {
    loadConfig({ APP_ORIGIN: 'not a url', PORT: '99999', EMAIL_TRANSPORT: 'smtp' });
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    const p = (e as ConfigError).problems;
    expect(p).toContain('APP_ORIGIN must be a web address like https://app.example.co.uk (got "not a url").');
    expect(p).toContain('PORT must be a whole number between 1 and 65535 (got "99999").');
    expect(p).toContain('DATABASE_URL is missing.');
    expect(p).toContain('UPLOAD_DIR is missing.');
    expect(p).toContain('EMAIL_FROM is missing.');
    expect(p).toContain('SMTP_URL is missing (needed because EMAIL_TRANSPORT is smtp).');
    expect((e as Error).message).toMatch(/^The app cannot start because of 6 settings problems:/);
  }
});

test('production refuses test-only mail transports and short health tokens', () => {
  expect(() => loadConfig({ ...base, INSTANCE_MODE: 'production', EMAIL_TRANSPORT: 'file', EMAIL_FILE_DIR: '/tmp/m' }))
    .toThrow(/EMAIL_TRANSPORT file is only for testing/);
  expect(() => loadConfig({ ...base, HEALTH_TOKEN: 'short' })).toThrow(/HEALTH_TOKEN must be at least 24 characters/);
});

test('a single problem is worded in the singular', () => {
  expect(() => loadConfig({ ...base, PORT: '0' })).toThrow(/^The app cannot start because of 1 settings problem:/);
});

test('APP_ORIGIN with a username or password is refused and never echoed', () => {
  for (const origin of ['https://admin:s3cret@app.example.co.uk', 'https://s3cret@app.example.co.uk', 'https//s3cret@x']) {
    try {
      loadConfig({ ...base, APP_ORIGIN: origin });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).not.toContain('s3cret');
    }
  }
  expect(() => loadConfig({ ...base, APP_ORIGIN: 'https://u:p@app.example.co.uk' }))
    .toThrow('APP_ORIGIN must not contain a username or password');
});

test('the mail check interval defaults to 5 seconds and can be set', () => {
  expect(loadConfig(base).email.pollMs).toBe(5000);
  expect(loadConfig({ ...base, EMAIL_POLL_MS: '300' }).email.pollMs).toBe(300);
  expect(() => loadConfig({ ...base, EMAIL_POLL_MS: 'soon' })).toThrow(/EMAIL_POLL_MS must be a whole number/);
});

test('a start-up failure gives advice that fits it: a port in use, a forbidden port, or the database', () => {
  expect(startFailure({ listen: 3000 }, Object.assign(new Error('listen EADDRINUSE: address already in use 0.0.0.0:3000'), { code: 'EADDRINUSE' })))
    .toBe('The app could not start: port 3000 is already in use by another program. Stop that program, or set PORT to a free port.');
  expect(startFailure({ listen: 80 }, { code: 'EACCES' })).toBe('The app could not start: it is not allowed to listen on port 80. Use a port above 1024 (set PORT), or run it the way the bundle does.');
  expect(startFailure({ listen: 3000 }, { code: 'EADDRNOTAVAIL' })).toBe('The app could not start: it could not listen on port 3000 (EADDRNOTAVAIL). Check that PORT is a free port on this machine.');
  const db = startFailure({ setup: true }, Object.assign(new Error('password authentication failed for user "app" at db:5432'), { code: '28P01' }));
  expect(db).toBe('The app could not start: it could not set up the database or the web server (28P01). Check the database address and that the database is running.');
  // never the database's own text, which can hold connection details
  expect(db).not.toContain('password authentication');
  // a port problem is never blamed on the database
  expect(startFailure({ listen: 3000 }, { code: 'EADDRINUSE' })).not.toContain('database');
});
