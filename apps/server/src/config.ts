import { fileURLToPath } from 'node:url';
import type { AppProfile } from '@hf/shared';
import { readAppProfile } from '@hf/shared/app-profile-file';

export type InstanceMode = 'demo' | 'production' | 'test';

/** app-profile.json at the repo root (/app/app-profile.json in the image); APP_PROFILE overrides it. */
const DEFAULT_PROFILE_FILE = fileURLToPath(new URL('../../../app-profile.json', import.meta.url));

export interface Config {
  instanceMode: InstanceMode;
  appName: string;
  appOrigin: string;
  port: number;
  databaseUrl: string;
  cookieSecure: boolean;
  /** How many reverse proxies sit in front of the app (Caddy = 1, none = 0). Used to find the real client address. */
  trustProxyHops: number;
  uploadDir: string;
  uploadMaxBytes: number;
  email: { transport: 'smtp' | 'file' | 'memory'; smtpUrl?: string; fileDir?: string; from: string; /** How often the outbox is checked, in milliseconds. */ pollMs: number };
  healthToken?: string;
  appVersion: string;
  commit: string;
  webDistDir?: string;
  /** Which optional modules are on and what the data policy allows (app-profile.json). */
  profile: AppProfile;
  /** Receipt reading. The Azure settings are read only when the engine is azure. */
  ocr: {
    engine: 'local' | 'azure';
    concurrency: number;
    timeoutMs: number;
    azure?: { endpoint: string; key: string; region: string };
  };
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`The app cannot start because of ${String(problems.length)} settings ${problems.length === 1 ? 'problem' : 'problems'}:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}


export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const get = (k: string): string | undefined => {
    const v = env[k]?.trim();
    return v === undefined || v === '' ? undefined : v;
  };

  const required = (k: string): string => {
    const v = get(k);
    if (v === undefined) problems.push(`${k} is missing.`);
    return v ?? '';
  };
  const oneOf = <T extends string>(k: string, allowed: readonly T[], def: T): T => {
    const v = get(k);
    if (v === undefined) return def;
    if ((allowed as readonly string[]).includes(v)) return v as T;
    problems.push(`${k} must be one of ${allowed.join(', ')} (got "${v}").`);
    return def;
  };
  const int = (k: string, min: number, max: number, def: number, what: string): number => {
    const v = get(k);
    if (v === undefined) return def;
    const n = Number(v);
    if (!/^\d+$/.test(v) || n < min || n > max) {
      problems.push(`${k} must be a whole number ${what} (got "${v}").`);
      return def;
    }
    return n;
  };
  const bool = (k: string, def: boolean): boolean => {
    const v = get(k);
    if (v === undefined) return def;
    if (v === 'true' || v === 'false') return v === 'true';
    problems.push(`${k} must be true or false (got "${v}").`);
    return def;
  };

  const instanceMode = oneOf<InstanceMode>('INSTANCE_MODE', ['demo', 'production', 'test'], 'demo');
  const appName = get('APP_NAME') ?? 'Highland App';

  let appOrigin = '';
  const rawOrigin = get('APP_ORIGIN');
  if (rawOrigin === undefined) problems.push('APP_ORIGIN is missing.');
  else {
    let ok = false;
    let hasUserinfo = false;
    try {
      const u = new URL(rawOrigin);
      hasUserinfo = u.username !== '' || u.password !== '';
      ok = (u.protocol === 'http:' || u.protocol === 'https:') && u.pathname === '/' && !u.search && !u.hash && !hasUserinfo
        && /^https?:\/\/[^/]+\/?$/.test(rawOrigin);
      if (ok) appOrigin = u.origin;
    } catch {
      ok = false;
    }
    if (hasUserinfo) problems.push('APP_ORIGIN must not contain a username or password.');
    else if (!ok) {
      // A value containing "@" may hold a secret, so it is never repeated back.
      problems.push(rawOrigin.includes('@')
        ? 'APP_ORIGIN must be a web address like https://app.example.co.uk (the value is hidden here for safety).'
        : `APP_ORIGIN must be a web address like https://app.example.co.uk (got "${rawOrigin}").`);
    }
  }

  const port = int('PORT', 1, 65535, 3000, 'between 1 and 65535');

  let databaseUrl = get('DATABASE_URL') ?? '';
  if (!databaseUrl) problems.push('DATABASE_URL is missing.');
  else if (!/^postgres(ql)?:\/\/.+/.test(databaseUrl)) {
    problems.push('DATABASE_URL must be a database address starting with postgres:// (the value is hidden here for safety).');
    databaseUrl = '';
  }

  const cookieSecure = bool('COOKIE_SECURE', !(rawOrigin ?? '').startsWith('http://'));
  const trustProxyHops = int('TRUST_PROXY_HOPS', 0, 10, 1, 'between 0 and 10 (0 means no proxy in front of the app, 1 means one proxy such as Caddy)');
  const uploadDirRaw = required('UPLOAD_DIR');
  if (uploadDirRaw && !uploadDirRaw.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(uploadDirRaw)) {
    problems.push(`UPLOAD_DIR must be a full folder path starting with / (got "${uploadDirRaw}").`);
  }
  const uploadMaxBytes = int('UPLOAD_MAX_BYTES', 1, Number.MAX_SAFE_INTEGER, 15 * 1024 * 1024, 'of bytes, 1 or more');

  const transport = oneOf<'smtp' | 'file' | 'memory'>('EMAIL_TRANSPORT', ['smtp', 'file', 'memory'], 'smtp');
  if (instanceMode === 'production' && (transport === 'file' || transport === 'memory')) {
    problems.push(`EMAIL_TRANSPORT ${transport} is only for testing and cannot be used when INSTANCE_MODE is production.`);
  }
  const email: Config['email'] = { transport, from: '', pollMs: int('EMAIL_POLL_MS', 50, 3600000, 5000, 'of milliseconds, 50 or more') };
  if (transport === 'smtp') {
    const v = get('SMTP_URL');
    if (v === undefined) problems.push('SMTP_URL is missing (needed because EMAIL_TRANSPORT is smtp).');
    else email.smtpUrl = v;
  }
  if (transport === 'file') {
    const v = get('EMAIL_FILE_DIR');
    if (v === undefined) problems.push('EMAIL_FILE_DIR is missing (needed because EMAIL_TRANSPORT is file).');
    else email.fileDir = v;
  }
  email.from = required('EMAIL_FROM');
  if (email.from && !/^([^<>@]+<[^<>\s@]+@[^<>\s@]+>|[^<>\s@]+@[^<>\s@]+)$/.test(email.from)) {
    problems.push(`EMAIL_FROM must look like App <app@example.co.uk> or app@example.co.uk (got "${email.from}").`);
  }

  const healthToken = get('HEALTH_TOKEN');
  if (healthToken !== undefined && healthToken.length < 24) {
    problems.push('HEALTH_TOKEN must be at least 24 characters when it is set.');
  }

  const profileRead = readAppProfile(get('APP_PROFILE') ?? DEFAULT_PROFILE_FILE);
  if (!profileRead.ok) problems.push(...profileRead.problems);

  const ocrEngine = oneOf<'local' | 'azure'>('OCR_ENGINE', ['local', 'azure'], 'local');
  const ocrConcurrencyRaw = get('OCR_CONCURRENCY');
  let ocrConcurrency = 1;
  if (ocrConcurrencyRaw !== undefined) {
    if (/^[1-4]$/.test(ocrConcurrencyRaw)) ocrConcurrency = Number(ocrConcurrencyRaw);
    else problems.push('OCR_CONCURRENCY must be a whole number from 1 to 4.');
  }
  const ocr: Config['ocr'] = {
    engine: ocrEngine, concurrency: ocrConcurrency,
    timeoutMs: int('OCR_TIMEOUT_MS', 1000, 600000, 60000, 'of milliseconds from 1000 to 600000'),
  };
  // The cloud settings matter only when the ocr module is on: with it off no reader is made, so they are neither needed nor kept.
  if (ocrEngine === 'azure' && profileRead.ok && profileRead.profile.modules.includes('ocr')) {
    const needed = (k: string): string => {
      const v = get(k);
      if (v === undefined) problems.push(`${k} is needed when OCR_ENGINE is azure.`);
      return v ?? '';
    };
    const endpoint = needed('OCR_AZURE_ENDPOINT');
    const key = needed('OCR_AZURE_KEY');
    const region = needed('OCR_AZURE_REGION');
    if (endpoint && !azureEndpointOk(endpoint, instanceMode)) {
      // The address may carry a key, so it is never repeated back.
      problems.push('OCR_AZURE_ENDPOINT must be a web address starting with https:// (the value is hidden here for safety).');
    }
    if (region && !/^[a-z0-9]+$/.test(region)) problems.push(`OCR_AZURE_REGION must be an Azure region name like uksouth (got "${region}").`);
    ocr.azure = { endpoint, key, region };
  }

  if (problems.length > 0 || !profileRead.ok) throw new ConfigError(problems);

  const cfg: Config = {
    instanceMode, appName, appOrigin, port, databaseUrl, cookieSecure, trustProxyHops,
    uploadDir: uploadDirRaw, uploadMaxBytes, email, profile: profileRead.profile, ocr,
    appVersion: get('APP_VERSION') ?? '0.0.0-dev', commit: get('GIT_COMMIT') ?? 'unknown',
  };
  if (healthToken !== undefined) cfg.healthToken = healthToken;
  const web = get('WEB_DIST_DIR');
  if (web !== undefined) cfg.webDistDir = web;
  return cfg;
}

/** https:// with no username or password; a plain-http loopback stub is allowed only in test mode. */
function azureEndpointOk(raw: string, mode: InstanceMode): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username !== '' || u.password !== '') return false;
  if (u.protocol === 'https:') return true;
  return mode === 'test' && u.protocol === 'http:' && u.hostname === '127.0.0.1' && /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(raw);
}
