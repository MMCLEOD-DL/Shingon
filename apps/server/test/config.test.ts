import { test, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';

const base = {
  APP_ORIGIN: 'https://app.example.co.uk', DATABASE_URL: 'postgres://u:p@localhost/db',
  UPLOAD_DIR: '/data/uploads', EMAIL_FROM: 'App <app@example.co.uk>', SMTP_URL: 'smtp://localhost:1025',
};

test('defaults are applied', () => {
  const c = loadConfig(base);
  expect(c).toMatchObject({ instanceMode: 'demo', appName: 'Highland App', port: 3000, cookieSecure: true,
    uploadMaxBytes: 15728640, email: { transport: 'smtp', smtpUrl: 'smtp://localhost:1025', from: 'App <app@example.co.uk>' },
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
