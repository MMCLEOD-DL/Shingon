export type InstanceMode = 'demo' | 'production' | 'test';

export interface Config {
  instanceMode: InstanceMode;
  appName: string;
  appOrigin: string;
  port: number;
  databaseUrl: string;
  cookieSecure: boolean;
  uploadDir: string;
  uploadMaxBytes: number;
  email: { transport: 'smtp' | 'file' | 'memory'; smtpUrl?: string; fileDir?: string; from: string };
  healthToken?: string;
  appVersion: string;
  commit: string;
  webDistDir?: string;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`The app cannot start because of ${String(problems.length)} settings problems:\n- ${problems.join('\n- ')}`);
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
    try {
      const u = new URL(rawOrigin);
      ok = (u.protocol === 'http:' || u.protocol === 'https:') && u.pathname === '/' && !u.search && !u.hash && !u.username
        && /^https?:\/\/[^/]+\/?$/.test(rawOrigin);
      if (ok) appOrigin = u.origin;
    } catch {
      ok = false;
    }
    if (!ok) problems.push(`APP_ORIGIN must be a web address like https://app.example.co.uk (got "${rawOrigin}").`);
  }

  const port = int('PORT', 1, 65535, 3000, 'between 1 and 65535');

  let databaseUrl = get('DATABASE_URL') ?? '';
  if (!databaseUrl) problems.push('DATABASE_URL is missing.');
  else if (!/^postgres(ql)?:\/\/.+/.test(databaseUrl)) {
    problems.push('DATABASE_URL must be a database address starting with postgres:// (the value is hidden here for safety).');
    databaseUrl = '';
  }

  const cookieSecure = bool('COOKIE_SECURE', !(rawOrigin ?? '').startsWith('http://'));
  const uploadDirRaw = required('UPLOAD_DIR');
  if (uploadDirRaw && !uploadDirRaw.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(uploadDirRaw)) {
    problems.push(`UPLOAD_DIR must be a full folder path starting with / (got "${uploadDirRaw}").`);
  }
  const uploadMaxBytes = int('UPLOAD_MAX_BYTES', 1, Number.MAX_SAFE_INTEGER, 15 * 1024 * 1024, 'of bytes, 1 or more');

  const transport = oneOf<'smtp' | 'file' | 'memory'>('EMAIL_TRANSPORT', ['smtp', 'file', 'memory'], 'smtp');
  if (instanceMode === 'production' && (transport === 'file' || transport === 'memory')) {
    problems.push(`EMAIL_TRANSPORT ${transport} is only for testing and cannot be used when INSTANCE_MODE is production.`);
  }
  const email: Config['email'] = { transport, from: '' };
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

  if (problems.length > 0) throw new ConfigError(problems);

  const cfg: Config = {
    instanceMode, appName, appOrigin, port, databaseUrl, cookieSecure,
    uploadDir: uploadDirRaw, uploadMaxBytes, email,
    appVersion: get('APP_VERSION') ?? '0.0.0-dev', commit: get('GIT_COMMIT') ?? 'unknown',
  };
  if (healthToken !== undefined) cfg.healthToken = healthToken;
  const web = get('WEB_DIST_DIR');
  if (web !== undefined) cfg.webDistDir = web;
  return cfg;
}
