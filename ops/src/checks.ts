import { statfs as fsStatfs } from 'node:fs/promises';
import path from 'node:path';
import type { OpsConfig } from './config.js';
import type { Check } from './monitor.js';

export type { Check } from './monitor.js';

export interface MonitorCheckDeps {
  cfg: Pick<OpsConfig, 'appInternalUrl' | 'healthToken' | 'uploadsDir' | 'workDir' | 'backup' | 'tunnelEnabled' | 'warnings'>;
  fetchImpl?: typeof fetch;
  statfs?: (p: string) => Promise<{ bsize: number; blocks: number; bavail: number }>;
  /** cloudflared's readiness address. Ops reaches the tunnel over the small internal `tunnelmon` network (compose.yaml). */
  tunnelUrl?: string;
  /** How long a disk may take to report its free space (default 5 s); a hung mount is reported, not waited on. */
  diskTimeoutMs?: number;
}

export const APP_TIMEOUT_MS = 5000;
const TUNNEL_TIMEOUT_MS = 5000;
const MIN_FREE_BYTES = 2 * 1024 ** 3;
const MIN_FREE_FRACTION = 0.1;
export const DISK_TIMEOUT_MS = 5000;

export const LOCAL_BACKUP_PROBLEM = 'Backups are being kept on this box only. This is a development setting and must be changed before real use.';
const APP_DOWN = 'The app is not answering.';
const TUNNEL_DOWN = 'The remote-access tunnel is down, so the operator cannot reach this box.';

/** The app's /readyz, asked with the health token: `app` itself plus each of the app's checks as `app:<name>`. */
async function appChecks(deps: MonitorCheckDeps): Promise<Check[]> {
  const { cfg } = deps;
  let body: { status?: unknown; checks?: unknown };
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${cfg.appInternalUrl}/readyz`, {
      headers: cfg.healthToken !== undefined ? { 'x-health-token': cfg.healthToken } : {},
      signal: AbortSignal.timeout(APP_TIMEOUT_MS),
    });
    body = (await res.json()) as typeof body;
  } catch {
    return [{ name: 'app', ok: false, detail: APP_DOWN }];
  }
  if (Array.isArray(body.checks)) {
    const own = (body.checks as unknown[])
      .filter((c): c is { name: string; ok: boolean; detail: unknown } => typeof c === 'object' && c !== null && typeof (c as { name?: unknown }).name === 'string' && typeof (c as { ok?: unknown }).ok === 'boolean')
      .map((c) => ({ name: `app:${c.name}`, ok: c.ok, detail: c.ok ? '' : typeof c.detail === 'string' ? c.detail : 'The app reports a problem.' }));
    return [{ name: 'app', ok: true, detail: '' }, ...own];
  }
  // Without the token the app gives only its status.
  if (body.status === 'ok') return [{ name: 'app', ok: true, detail: '' }];
  if (body.status === 'down') return [{ name: 'app', ok: false, detail: 'The app says it is down (its database is not answering).' }];
  if (body.status === 'degraded') return [{ name: 'app', ok: false, detail: 'The app reports a problem, but ops cannot see which: HEALTH_TOKEN is not set for ops or does not match the app.' }];
  return [{ name: 'app', ok: false, detail: APP_DOWN }];
}

async function diskCheck(deps: MonitorCheckDeps, folder: string): Promise<Check> {
  const name = `disk:${folder}`;
  try {
    const timeoutMs = deps.diskTimeoutMs ?? DISK_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const s = await Promise.race([
      (deps.statfs ?? fsStatfs)(folder),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('timeout')); }, timeoutMs); }),
    ]).finally(() => { clearTimeout(timer); });
    const free = s.bavail * s.bsize;
    const fraction = s.blocks > 0 ? s.bavail / s.blocks : 0;
    if (free >= MIN_FREE_BYTES && fraction >= MIN_FREE_FRACTION) return { name, ok: true, detail: '' };
    const gb = free / 1e9;
    const shown = gb >= 10 ? String(Math.round(gb)) : (Math.round(gb * 10) / 10).toFixed(1);
    return { name, ok: false, detail: `Disk space is low on ${folder}: ${shown} GB free (${String(Math.round(fraction * 100))}%).` };
  } catch (e) {
    return { name, ok: false, detail: (e as Error).message === 'timeout'
      ? `The free disk space on ${folder} could not be checked: the disk did not answer in time.`
      : `The free disk space on ${folder} could not be checked.` };
  }
}

async function tunnelCheck(deps: MonitorCheckDeps): Promise<Check> {
  try {
    const res = await (deps.fetchImpl ?? fetch)(deps.tunnelUrl ?? 'http://tunnel:2000/ready', { signal: AbortSignal.timeout(TUNNEL_TIMEOUT_MS) });
    await res.body?.cancel().catch(() => undefined);
    return res.ok ? { name: 'tunnel', ok: true, detail: '' } : { name: 'tunnel', ok: false, detail: TUNNEL_DOWN };
  } catch {
    return { name: 'tunnel', ok: false, detail: TUNNEL_DOWN };
  }
}

/**
 * What the ops monitor checks beyond the app's own readiness: whether the app answers at all, free disk space, the tunnel,
 * and the standing settings problems (backups kept on this box, and every warning loadOpsConfig recorded, such as a
 * TUNNEL_IP outside EDGE_SUBNET). Takes the settings only: it never needs the database or the ops lock, so a backup or
 * restore that is waiting or running long never holds it up. Never throws.
 */
export async function monitorChecks(deps: MonitorCheckDeps): Promise<Check[]> {
  const { cfg } = deps;
  const stateDir = path.dirname(cfg.workDir);
  const [app, uploads, state, tunnel] = await Promise.all([
    appChecks(deps),
    diskCheck(deps, cfg.uploadsDir),
    diskCheck(deps, stateDir),
    cfg.tunnelEnabled ? tunnelCheck(deps) : Promise.resolve(undefined),
  ]);
  const out: Check[] = [...app, uploads, state];
  if (tunnel !== undefined) out.push(tunnel);
  out.push(cfg.backup.allowLocal
    ? { name: 'backup-location', ok: false, detail: LOCAL_BACKUP_PROBLEM, critical: true }
    : { name: 'backup-location', ok: true, detail: '' });
  cfg.warnings.forEach((w, i) => {
    const tunnelPair = /^(TUNNEL_IP|EDGE_SUBNET)\b/.test(w);
    out.push({ name: `settings:${String(i + 1)}`, ok: false, critical: true, detail: tunnelPair ? `${w} The front door stays down until this is fixed.` : w });
  });
  return out;
}

/** `ops check` output: `✓ name` or `✗ name: detail`, one line per check, and whether all passed. */
export function formatChecks(checks: Check[]): { lines: string[]; ok: boolean } {
  return { lines: checks.map((c) => (c.ok ? `✓ ${c.name}` : `✗ ${c.name}: ${c.detail}`)), ok: checks.every((c) => c.ok) };
}
