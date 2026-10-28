import { fileURLToPath } from 'node:url';
import { Cron } from 'croner';
import { DEFAULT_PROFILE, type AppProfile } from '@hf/shared';
import { readAppProfile } from '@hf/shared/app-profile-file';

/** app-profile.json at the repo root (/app/app-profile.json in the image), as the server reads it; APP_PROFILE overrides it. */
const DEFAULT_PROFILE_FILE = fileURLToPath(new URL('../../app-profile.json', import.meta.url));

export type InstanceMode = 'demo' | 'production' | 'test';

export interface OpsConfig {
  instanceMode: InstanceMode;
  databaseUrl: string;
  appInternalUrl: string;
  client: string;
  healthToken?: string;
  composeProject: string;
  backup: {
    repository: string;
    password: string;
    allowLocal: boolean;
    schedule: string;
    restoreTestSchedule: string;
    keep: string[];
    backendEnv: Record<string, string>;
  };
  auditRetentionDays: number;
  workDir: string;
  uploadsDir: string;
  tunnelEnabled: boolean;
  /** Where alerts go (Task 19). Every configured channel is used, in every mode. */
  alerts: { matrix?: { homeserver: string; accessToken: string; roomId: string }; webhookUrl?: string };
  /** Pinged on every monitor tick (Uptime Kuma push format), so an outside watcher notices when the whole box goes silent. */
  heartbeatUrl?: string;
  /**
   * Settings that are wrong but must not stop backups, such as a TUNNEL_IP that does not match EDGE_SUBNET (the front door
   * is held back by the edge-check service instead). Logged at start-up; Task 19 raises them as a standing alert.
   */
  warnings: string[];
  /** The app profile: which optional modules are on. Ops runs the app's scheduled jobs only with "scheduled-jobs" (Ruling 8). */
  profile: AppProfile;
}

export class OpsConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Ops cannot start because of ${String(problems.length)} settings ${problems.length === 1 ? 'problem' : 'problems'}:\n- ${problems.join('\n- ')}`);
    this.name = 'OpsConfigError';
  }
}

/** Sign-in details restic reads from its environment for each kind of destination. Passed on only when set. */
export const BACKEND_ENV_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_DEFAULT_REGION', 'B2_ACCOUNT_ID', 'B2_ACCOUNT_KEY', 'RESTIC_REST_USERNAME', 'RESTIC_REST_PASSWORD'] as const;

const REMOTE = /^(sftp|rest|s3|b2|azure|gs|swift|rclone):/;
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i;

/** The host a remote repository string points at, or undefined when there is none to find. */
function repoHost(repo: string): string | undefined {
  const body = repo.replace(REMOTE, '');
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/]+)/i.exec(body);
  if (url) return url[1];
  if (repo.startsWith('sftp:')) {
    const m = /^(?:[^@]*@)?([^:/]+)/.exec(body);
    return m?.[1];
  }
  return undefined;
}

/** Throws a plain-English error when the backup destination is on this same machine and that has not been explicitly allowed. */
export function assertOffBox(repo: string, allowLocal: boolean): void {
  if (allowLocal) return;
  const host = repoHost(repo);
  if (REMOTE.test(repo) && (host === undefined || !LOOPBACK.test(host))) return;
  throw new Error(
    `BACKUP_REPOSITORY points at this box (${describeRepo(repo)}). Backups must also be kept somewhere else, such as sftp:backup@host:/path, rest:https://host:8000/repo, s3:… or b2:…. `
    + 'For development only, BACKUP_ALLOW_LOCAL=true allows a folder on this machine.',
  );
}

/**
 * The password inside a repository address, if there is one: everything between the user name and the LAST "@" of the
 * address part, so a password containing "@", ":" or "/" is still found whole.
 */
export function repoPassword(repo: string): string | undefined {
  const i = repo.indexOf('://');
  const rest = i >= 0 ? repo.slice(i + 3) : repo.replace(/^sftp:/, '');
  const at = rest.lastIndexOf('@');
  if (at < 0) return undefined;
  const userinfo = rest.slice(0, at);
  const colon = userinfo.indexOf(':');
  return colon >= 0 && colon < userinfo.length - 1 ? userinfo.slice(colon + 1) : undefined;
}

/**
 * The destination with any sign-in details removed, safe to put in messages, logs and alerts. When the part before the
 * last "@" holds a ":" (so it may hold a password), everything before that "@" goes. A user name alone (sftp:backup@host)
 * is kept.
 */
export function describeRepo(repo: string): string {
  const i = repo.indexOf('://');
  if (i >= 0) {
    const head = repo.slice(0, i + 3);
    const rest = repo.slice(i + 3);
    const at = rest.lastIndexOf('@');
    if (at >= 0 && rest.slice(0, at).includes(':')) return head + rest.slice(at + 1);
    return repo;
  }
  if (repo.startsWith('sftp:')) {
    const body = repo.slice(5);
    const at = body.lastIndexOf('@');
    if (at >= 0 && body.slice(0, at).includes(':')) return `sftp:${body.slice(at + 1)}`;
  }
  return repo;
}

/** A short name for this box made from the client's name, used as the restic host so each box's backups are grouped together. */
export function slug(label: string): string {
  const s = label.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  return s === '' ? 'highland' : s;
}

function parseIPv4(s: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return undefined;
  return parts.reduce((a, p) => a * 256 + p, 0);
}
const ipText = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/**
 * TUNNEL_IP and EDGE_SUBNET must be changed together. The front door believes a visitor's real address only from TUNNEL_IP;
 * if that address is not a usable host on the edge network (or is its gateway, where traffic from the host arrives), the
 * protection silently fails open. Returns plain-English problems, empty when the pair is sound.
 */
export function checkEdgePair(tunnelIp: string, edgeSubnet: string): string[] {
  const cidr = /^([\d.]+)\/(\d{1,2})$/.exec(edgeSubnet);
  const base = cidr?.[1] !== undefined ? parseIPv4(cidr[1]) : undefined;
  const bits = cidr ? Number(cidr[2]) : NaN;
  if (base === undefined || !(bits >= 0 && bits <= 32)) return [`EDGE_SUBNET must be a network like 172.30.250.0/28 (got "${edgeSubnet}").`];
  if (bits > 29) return [`EDGE_SUBNET (${edgeSubnet}) is too small: use a /29 or larger, such as 172.30.250.0/28.`];
  const ip = parseIPv4(tunnelIp);
  if (ip === undefined) return [`TUNNEL_IP must be an address like 172.30.250.10 (got "${tunnelIp}").`];
  const size = 2 ** (32 - bits);
  const network = Math.floor(base / size) * size;
  const broadcast = network + size - 1;
  const suggestion = ipText(network + Math.min(10, size - 2));
  const net = `${ipText(network)}/${String(bits)}`;
  if (ip < network || ip > broadcast) {
    return [`TUNNEL_IP (${tunnelIp}) is not inside EDGE_SUBNET (${edgeSubnet}). Change both together: TUNNEL_IP must be an address inside EDGE_SUBNET, such as ${suggestion}.`];
  }
  if (ip === network) return [`TUNNEL_IP (${tunnelIp}) is the network's own address on ${net}. Pick another address inside EDGE_SUBNET, such as ${suggestion}.`];
  if (ip === network + 1) return [`TUNNEL_IP (${tunnelIp}) is the gateway address of ${net}, where traffic from the host arrives, so anyone could pretend to be the tunnel. Pick another address inside EDGE_SUBNET, such as ${suggestion}.`];
  if (ip === broadcast) return [`TUNNEL_IP (${tunnelIp}) is the broadcast address of ${net}. Pick another address inside EDGE_SUBNET, such as ${suggestion}.`];
  return [];
}

export function loadOpsConfig(env: NodeJS.ProcessEnv = process.env): OpsConfig {
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
  const bool = (k: string, def: boolean): boolean => {
    const v = get(k);
    if (v === undefined) return def;
    if (v === 'true' || v === 'false') return v === 'true';
    problems.push(`${k} must be true or false (got "${v}").`);
    return def;
  };
  const cron = (k: string, def: string): string => {
    const v = get(k) ?? def;
    try {
      new Cron(v, { paused: true, timezone: 'Europe/London' }).stop();
    } catch {
      problems.push(`${k} must be a cron schedule such as 30 2 * * * (got "${v}").`);
    }
    return v;
  };
  const folder = (k: string, def: string): string => {
    const v = get(k) ?? def;
    if (!v.startsWith('/')) problems.push(`${k} must be a full folder path starting with / (got "${v}").`);
    return v.replace(/\/+$/, '');
  };

  const modeRaw = get('INSTANCE_MODE') ?? 'production';
  let instanceMode: InstanceMode = 'production';
  if (modeRaw === 'demo' || modeRaw === 'production' || modeRaw === 'test') instanceMode = modeRaw;
  else problems.push(`INSTANCE_MODE must be one of demo, production, test (got "${modeRaw}").`);

  let databaseUrl = get('DATABASE_URL') ?? '';
  if (!databaseUrl) problems.push('DATABASE_URL is missing.');
  else if (!/^postgres(ql)?:\/\/.+/.test(databaseUrl)) {
    problems.push('DATABASE_URL must be a database address starting with postgres:// (the value is hidden here for safety).');
    databaseUrl = '';
  }

  const appInternalUrl = required('APP_INTERNAL_URL').replace(/\/+$/, '');
  if (appInternalUrl && !/^https?:\/\/[^\s@]+$/.test(appInternalUrl)) problems.push(`APP_INTERNAL_URL must be a web address such as http://app:3000 (got "${appInternalUrl}").`);
  const client = required('CLIENT_LABEL');

  const repository = required('BACKUP_REPOSITORY');
  const password = get('BACKUP_PASSWORD') ?? '';
  if (password === '') problems.push('BACKUP_PASSWORD is missing.');
  else if (password.length < 16) problems.push('BACKUP_PASSWORD must be at least 16 characters.');
  const allowLocal = bool('BACKUP_ALLOW_LOCAL', false);
  if (repository) {
    try {
      assertOffBox(repository, allowLocal);
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  const schedule = cron('BACKUP_SCHEDULE', '30 2 * * *');
  const restoreTestSchedule = cron('RESTORE_TEST_SCHEDULE', '30 4 * * 0');
  const keepRaw = get('BACKUP_KEEP') ?? '--keep-daily 7 --keep-weekly 5 --keep-monthly 12';
  const keep = keepRaw.split(/\s+/);
  // These go on restic's command line, so only its retention options and their values are allowed.
  if (!keep.every((t) => /^--keep-[a-z-]+$/.test(t) || /^[0-9A-Za-z]+$/.test(t)) || !/^--keep-/.test(keep[0] ?? '')) {
    problems.push(`BACKUP_KEEP may only hold restic --keep-… options with their numbers, such as --keep-daily 7 --keep-weekly 5 (got "${keepRaw}").`);
  }
  const backendEnv: Record<string, string> = {};
  for (const k of BACKEND_ENV_KEYS) {
    const v = get(k);
    if (v !== undefined) backendEnv[k] = v;
  }

  let auditRetentionDays = 730;
  const days = get('AUDIT_RETENTION_DAYS');
  if (days !== undefined) {
    if (/^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 36500) auditRetentionDays = Number(days);
    else problems.push(`AUDIT_RETENTION_DAYS must be a whole number of days, 1 or more (got "${days}").`);
  }

  // Same defaults as compose.yaml. A mismatch is a warning here, never a reason to stop backups: the edge-check service
  // keeps the front door from starting, and Task 19 raises the warning as a standing alert.
  const warnings = checkEdgePair(get('TUNNEL_IP') ?? '172.30.250.10', get('EDGE_SUBNET') ?? '172.30.250.0/28');

  // Alerts. Web addresses that may carry a secret (a webhook key, a push token) are never repeated in a message.
  const alerts: OpsConfig['alerts'] = {};
  const webAddress = (v: string): boolean => /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(v);
  const mHome = get('MATRIX_HOMESERVER');
  const mToken = get('MATRIX_ACCESS_TOKEN');
  const mRoom = get('MATRIX_ROOM_ID');
  if (mHome !== undefined || mToken !== undefined || mRoom !== undefined) {
    if (mHome === undefined || mToken === undefined || mRoom === undefined) {
      problems.push('MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN and MATRIX_ROOM_ID must all be set for Matrix alerts (or leave all three empty).');
    } else if (!webAddress(mHome) || mHome.includes('@')) {
      problems.push(`MATRIX_HOMESERVER must be a web address such as https://matrix.example.com (got "${mHome.includes('@') ? 'hidden here for safety' : mHome}").`);
    } else {
      alerts.matrix = { homeserver: mHome.replace(/\/+$/, ''), accessToken: mToken, roomId: mRoom };
    }
  }
  const webhookUrl = get('ALERT_WEBHOOK_URL');
  if (webhookUrl !== undefined) {
    if (webAddress(webhookUrl)) alerts.webhookUrl = webhookUrl;
    else problems.push('ALERT_WEBHOOK_URL must be a web address starting with https:// or http:// (the value is hidden here for safety).');
  }
  const heartbeatUrl = get('HEARTBEAT_URL');
  if (heartbeatUrl !== undefined && !webAddress(heartbeatUrl)) problems.push('HEARTBEAT_URL must be a web address starting with https:// or http:// (the value is hidden here for safety).');
  // A live box must reach the operator. Checked only once the Matrix settings are complete, so one problem is not reported twice.
  const matrixHalfSet = (mHome !== undefined || mToken !== undefined || mRoom !== undefined) && alerts.matrix === undefined;
  if (instanceMode === 'production' && modeRaw === 'production' && alerts.matrix === undefined && webhookUrl === undefined && !matrixHalfSet) {
    problems.push('No alert channel is set. Set MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN and MATRIX_ROOM_ID, or ALERT_WEBHOOK_URL.');
  }

  const profileRead = readAppProfile(get('APP_PROFILE') ?? DEFAULT_PROFILE_FILE);
  if (!profileRead.ok) problems.push(...profileRead.problems);

  const healthToken = get('HEALTH_TOKEN');
  const cfg: OpsConfig = {
    instanceMode,
    databaseUrl,
    appInternalUrl,
    client,
    composeProject: get('COMPOSE_PROJECT_NAME') ?? 'highland',
    backup: { repository, password, allowLocal, schedule, restoreTestSchedule, keep, backendEnv },
    auditRetentionDays,
    workDir: folder('OPS_WORK_DIR', '/state/work'),
    uploadsDir: folder('OPS_UPLOADS_DIR', '/data/uploads'),
    tunnelEnabled: bool('TUNNEL_ENABLED', false),
    alerts,
    warnings,
    profile: profileRead.ok ? profileRead.profile : DEFAULT_PROFILE,
  };
  if (problems.length > 0) throw new OpsConfigError(problems);
  if (healthToken !== undefined) cfg.healthToken = healthToken;
  if (heartbeatUrl !== undefined) cfg.heartbeatUrl = heartbeatUrl;
  return cfg;
}
