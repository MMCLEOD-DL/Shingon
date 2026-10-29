import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { generateEnv } from '../src/init.js';
import { BACKEND_ENV_KEYS } from '../src/config.js';

const opts = { client: 'Acme Ltd', origin: 'https://expenses.acme.co.uk', siteAddress: 'expenses.acme.co.uk', bundleDir: '/opt/highland/acme', mode: 'production' as const };

test('secrets are strong, distinct and present; the operator is told to save the backup key off the box', () => {
  const { env, checklist } = generateEnv(opts);
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1];
  for (const k of ['DB_PASSWORD', 'HEALTH_TOKEN', 'BACKUP_PASSWORD']) expect(get(k)!.length, k).toBeGreaterThanOrEqual(43);
  expect(new Set(['DB_PASSWORD', 'HEALTH_TOKEN', 'BACKUP_PASSWORD'].map(get)).size).toBe(3);
  expect(get('APP_ORIGIN')).toBe('https://expenses.acme.co.uk');
  expect(get('HF_BUNDLE_DIR')).toBe('/opt/highland/acme');
  expect(get('INSTANCE_MODE')).toBe('production');
  expect(get('CLIENT_LABEL')).toBe('Acme Ltd');
  expect(checklist).toContain('Save BACKUP_PASSWORD in your password manager now. Without it the backups cannot be read, and it must not live only on this box.');
});

test('every variable in .env.example appears in a generated file', () => {
  const example = [...readFileSync(new URL('../../deploy/.env.example', import.meta.url), 'utf8').matchAll(/^#?\s*([A-Z0-9_]+)=/gm)].map((m) => m[1]!);
  const { env } = generateEnv(opts);
  expect(example.filter((k) => !new RegExp(`^#?\\s*${k}=`, 'm').test(env))).toEqual([]);
});

test('the same secrets are never produced twice, and the demo mode is recorded', () => {
  const a = generateEnv({ ...opts, mode: 'demo' });
  const b = generateEnv({ ...opts, mode: 'demo' });
  expect(/^INSTANCE_MODE=(.*)$/m.exec(a.env)?.[1]).toBe('demo');
  expect(/^DB_PASSWORD=(.*)$/m.exec(a.env)?.[1]).not.toBe(/^DB_PASSWORD=(.*)$/m.exec(b.env)?.[1]);
});

test('the checklist is a numbered plain-English list covering mail, backups, alerts and the tunnel', () => {
  const { checklist } = generateEnv(opts);
  for (const n of [1, 2, 3, 4, 5]) expect(checklist).toMatch(new RegExp(`^${String(n)}\\. `, 'm'));
  for (const w of ['SMTP_URL', 'EMAIL_FROM', 'BACKUP_REPOSITORY', 'MATRIX_', 'TUNNEL_TOKEN', '--profile tunnel']) expect(checklist).toContain(w);
});

test('odd characters in the client name cannot break the file or inject a setting', () => {
  expect(() => generateEnv({ ...opts, client: 'Bad\nINSTANCE_MODE=demo' })).toThrow(/one line/);
  const { env } = generateEnv({ ...opts, client: `O'Brien & Sons "Ltd" $5 #1` });
  expect(env.match(/^INSTANCE_MODE=/gm)).toHaveLength(1);
});

test('every backup-destination setting ops reads reaches it: compose passes it to ops and the updater, and .env.example and ops init list it', () => {
  const compose = readFileSync(new URL('../../deploy/compose.yaml', import.meta.url), 'utf8');
  const example = readFileSync(new URL('../../deploy/.env.example', import.meta.url), 'utf8');
  const { env } = generateEnv(opts);
  expect(BACKEND_ENV_KEYS).toContain('AWS_DEFAULT_REGION');
  for (const k of BACKEND_ENV_KEYS) {
    expect(compose, k).toContain(`\n  ${k}: \${${k}:-}\n`);   // in x-ops-env, shared by ops and the updater
    expect(example, k).toMatch(new RegExp(`^# ${k}=$`, 'm'));
    expect(env, k).toMatch(new RegExp(`^# ${k}=$`, 'm'));
  }
});

test('local OCR is on by default with one reading at a time; cloud OCR stays commented out with the data-policy note', () => {
  const { env } = generateEnv(opts);
  expect(env).toMatch(/^OCR_ENGINE=local$/m);
  expect(env).toMatch(/^OCR_CONCURRENCY=1$/m);
  for (const k of ['OCR_AZURE_ENDPOINT', 'OCR_AZURE_REGION', 'OCR_AZURE_KEY']) expect(env, k).toMatch(new RegExp(`^# ${k}=$`, 'm'));
  expect(env).toMatch(/data policy allows azure-document-intelligence/);
});
