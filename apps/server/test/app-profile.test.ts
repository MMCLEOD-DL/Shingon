import { test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROFILE } from '@hf/shared';
import { loadAppProfile, moduleOn } from '../src/appProfile.js';
import { ConfigError, loadConfig } from '../src/config.js';

const base = {
  APP_ORIGIN: 'https://app.example.co.uk', DATABASE_URL: 'postgres://u:p@localhost/db',
  UPLOAD_DIR: '/data/uploads', EMAIL_FROM: 'App <app@example.co.uk>', SMTP_URL: 'smtp://localhost:1025',
};

let dir = '';
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'hf-profile-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

const write = async (name: string, text: string): Promise<string> => {
  const file = join(dir, name);
  await writeFile(file, text);
  return file;
};
const problemsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).problems;
  }
  throw new Error('expected a ConfigError');
};

test('a missing file gives the default profile', () => {
  expect(loadAppProfile(join(dir, 'none.json'))).toEqual(DEFAULT_PROFILE);
});

test('a bad file stops start-up with plain sentences', async () => {
  const notJson = await write('bad.json', '{ "schema": 1, ');
  expect(problemsOf(() => loadAppProfile(notJson))[0]).toBe('app-profile.json could not be read as JSON. Check the file for a typing mistake.');

  const odd = await write('odd.json', '{ "schema": 1, "modules": ["ocr","ocr"], "policy": { "outbound": [], "residency": "mars" } }');
  const p = problemsOf(() => loadAppProfile(odd));
  expect(p).toContain('app-profile.json lists the module "ocr" twice.');
  expect(p).toContain('app-profile.json has an unknown residency "mars". Use uk, uk-eu or any.');

  const other = await write('other.json', JSON.stringify({ schema: 2, modules: ['payments'], policy: { outbound: ['Azure OCR'], residency: 'uk' }, extra: 1 }));
  const q = problemsOf(() => loadAppProfile(other));
  expect(q).toContain('app-profile.json lists an unknown module "payments". Use ocr, pdf-export, xlsx-export or scheduled-jobs.');
  expect(q).toContain('app-profile.json has an unknown setting "extra".');
  expect(q).toContain('app-profile.json must say "schema": 1.');
  expect(q).toContain('app-profile.json has an outbound service "Azure OCR" that is not a valid name. Use lower-case letters, digits and dashes, like azure-document-intelligence.');
  // Zod's own wording never reaches the operator.
  for (const line of [...p, ...q]) expect(line).toMatch(/^app-profile\.json /);
});

test('loadConfig carries the profile and OCR settings', async () => {
  const withOcr = await write('ocr.json', JSON.stringify({ schema: 1, modules: ['ocr'], policy: { outbound: [], residency: 'uk' } }));
  const c = loadConfig({ ...base, APP_PROFILE: withOcr });
  expect(c.profile.modules).toEqual(['ocr']);
  expect(c.ocr).toEqual({ engine: 'local', concurrency: 1, timeoutMs: 60000 });
  expect(moduleOn(c, 'ocr')).toBe(true);
  expect(moduleOn(c, 'pdf-export')).toBe(false);

  expect(problemsOf(() => loadConfig({ ...base, APP_PROFILE: withOcr, OCR_CONCURRENCY: '9' })))
    .toEqual(['OCR_CONCURRENCY must be a whole number from 1 to 4.']);

  const secret = 'sk-very-secret-azure-key-value';
  const azure = problemsOf(() => loadConfig({ ...base, APP_PROFILE: withOcr, OCR_ENGINE: 'azure' }));
  expect(azure).toEqual([
    'OCR_AZURE_ENDPOINT is needed when OCR_ENGINE is azure.',
    'OCR_AZURE_KEY is needed when OCR_ENGINE is azure.',
    'OCR_AZURE_REGION is needed when OCR_ENGINE is azure.',
  ]);
  const badEndpoint = problemsOf(() => loadConfig({ ...base, APP_PROFILE: withOcr, OCR_ENGINE: 'azure', OCR_AZURE_KEY: secret, OCR_AZURE_ENDPOINT: `http://x.example/${secret}`, OCR_AZURE_REGION: 'uksouth' }));
  expect(badEndpoint).toEqual(['OCR_AZURE_ENDPOINT must be a web address starting with https:// (the value is hidden here for safety).']);
  for (const line of [...azure, ...badEndpoint]) expect(line).not.toContain(secret);

  const ok = loadConfig({ ...base, APP_PROFILE: withOcr, OCR_ENGINE: 'azure', OCR_AZURE_KEY: secret, OCR_AZURE_ENDPOINT: 'https://hf.cognitiveservices.azure.com/', OCR_AZURE_REGION: 'uksouth', OCR_CONCURRENCY: '2', OCR_TIMEOUT_MS: '30000' });
  expect(ok.ocr).toEqual({ engine: 'azure', concurrency: 2, timeoutMs: 30000, azure: { endpoint: 'https://hf.cognitiveservices.azure.com/', key: secret, region: 'uksouth' } });

  // A loopback stub is allowed only in test mode.
  const loopback = { ...base, APP_PROFILE: withOcr, OCR_ENGINE: 'azure', OCR_AZURE_KEY: secret, OCR_AZURE_ENDPOINT: 'http://127.0.0.1:4555', OCR_AZURE_REGION: 'uksouth' };
  expect(loadConfig({ ...loopback, INSTANCE_MODE: 'test' }).ocr.azure?.endpoint).toBe('http://127.0.0.1:4555');
  expect(problemsOf(() => loadConfig(loopback))).toEqual(['OCR_AZURE_ENDPOINT must be a web address starting with https:// (the value is hidden here for safety).']);

  // A bad profile is listed with every other settings problem.
  const bad = await write('bad-in-config.json', '[');
  expect(problemsOf(() => loadConfig({ ...base, APP_PROFILE: bad, OCR_CONCURRENCY: '0' }))).toEqual([
    'app-profile.json could not be read as JSON. Check the file for a typing mistake.',
    'OCR_CONCURRENCY must be a whole number from 1 to 4.',
  ]);
});

test('the committed app-profile.json is the default', () => {
  const file = fileURLToPath(new URL('../../../app-profile.json', import.meta.url));
  expect(loadAppProfile(file)).toEqual(DEFAULT_PROFILE);
  expect(loadConfig(base).profile).toEqual(DEFAULT_PROFILE);
});
