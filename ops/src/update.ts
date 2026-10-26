import type { AlertChannel } from './alerts.js';
import { notATag, TAG, type Compose } from './compose.js';
import { OpsBusyError } from './opsLock.js';

export type { Compose } from './compose.js';

export interface UpdateDeps {
  compose: Compose;
  backup(kind: 'pre-update'): Promise<{ snapshotId: string }>;
  /** Puts the database and uploaded files from that backup back. Called only while the app and ops are stopped. */
  restoreDb(snapshotId: string): Promise<void>;
  waitReady(version: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }>;
  alert: AlertChannel;
  /** Called once with the final outcome. `busy`: the update did not start because another run held a lock (Task 19). */
  record(ok: boolean, detail: string, opts?: { busy?: boolean }): Promise<void>;
  client: string;
  images: { app: string; ops: string };   // repo names, e.g. 'highland/app'
  lock: { acquire(): Promise<boolean>; release(): Promise<void> };
  timeoutMs?: number;                     // default 180000
  /**
   * Task 18's ops lock (withOpsLock), held around everything after the update lock, so no scheduled backup, restore test or
   * restore can interleave. Throws OpsBusyError when another run keeps it.
   */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** After a successful update: the edge check and the front door. Returns a plain warning or undefined; never fails the update. */
  frontDoor?: () => Promise<string | undefined>;
  /** Progress lines for the operator watching the update. */
  log?: (line: string) => void;
}

export type UpdateOutcome = { outcome: 'updated' | 'cancelled' | 'rolled-back' | 'rollback-failed'; message: string };

interface Result extends UpdateOutcome { alert: boolean; busy?: boolean }

export const DEFAULT_UPDATE_TIMEOUT_MS = 180_000;
export const ANOTHER_UPDATE = 'Another update is already running.';
const MONITOR_NOTE = ' (The monitor did not restart; run: docker compose up -d ops)';

/** An error's message as a clause: no trailing full stop, never a stack trace. */
const clause = (e: unknown): string => (e instanceof Error && e.message.trim() !== '' ? (e.message.trim().split('\n')[0] ?? '').replace(/\.+$/, '') : 'unknown problem');
/** An error's message as a sentence ending in a full stop. */
const sentence = (e: unknown): string => `${clause(e)}.`;

const minutes = (ms: number): string => {
  const n = Math.max(1, Math.round(ms / 60e3));
  return `${String(n)} ${n === 1 ? 'minute' : 'minutes'}`;
};

/**
 * `ops update --to <version>`: stop the app and the monitor, take an encrypted backup, switch the image tag, migrate, start,
 * and wait for the new version to be healthy. Any failure after the backup puts the backup and the previous version back.
 * Every outcome except "already running"/"already on" reaches the operator as a plain-English alert, and is recorded once.
 */
export async function runUpdate(deps: UpdateDeps, opts: { to: string }): Promise<UpdateOutcome> {
  if (!(await deps.lock.acquire())) {
    await deps.record(false, ANOTHER_UPDATE, { busy: true }).catch(() => undefined);
    return { outcome: 'cancelled', message: ANOTHER_UPDATE };
  }
  try {
    const { to } = opts;
    let result: Result;
    if (!TAG.test(to)) {
      result = { outcome: 'cancelled', message: notATag(to), alert: false };
    } else if (deps.exclusive !== undefined) {
      try {
        result = await deps.exclusive(() => updateLocked(deps, to));
      } catch (e) {
        if (!(e instanceof OpsBusyError)) throw e;
        result = e.unreachable
          ? { outcome: 'cancelled', message: `[${deps.client}] Update to ${to} cancelled: ${sentence(e)} Nothing was changed.`, alert: true }
          : { outcome: 'cancelled', message: `A backup or restore is still running, so the update to ${to} did not start. Nothing was changed. Try again when it has finished.`, alert: false, busy: true };
      }
    } else {
      result = await updateLocked(deps, to);
    }
    await deps.record(result.outcome === 'updated', result.message, ...(result.busy === true ? [{ busy: true }] : [])).catch(() => undefined);
    if (result.alert) {
      await deps.alert.send(result.message).catch((e: unknown) => { deps.log?.(`The alert could not be sent: ${sentence(e)}`); });
    }
    return { outcome: result.outcome, message: result.message };
  } finally {
    await deps.lock.release();
  }
}

/** The update proper, once both locks are held. Never throws: every failure becomes an outcome. */
async function updateLocked(deps: UpdateDeps, to: string): Promise<Result> {
  const { compose, client } = deps;
  const log = (l: string): void => { deps.log?.(l); };
  const timeoutMs = deps.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;

  // 1. Where we are.
  let from: string;
  try {
    from = await compose.readTag();
  } catch (e) {
    return { outcome: 'cancelled', message: `[${client}] Update to ${to} cancelled: ${sentence(e)} Nothing was changed.`, alert: true };
  }
  if (to === from) return { outcome: 'cancelled', message: `Already on ${to}.`, alert: false };
  log(`Updating ${client} from ${from} to ${to}.`);

  // 2. Both images must be here (or pullable) before anything is stopped.
  let have = false;
  try {
    have = (await compose.imageAvailable(`${deps.images.app}:${to}`)) && (await compose.imageAvailable(`${deps.images.ops}:${to}`));
  } catch { /* counted as missing */ }
  if (!have) return { outcome: 'cancelled', message: `[${client}] Update to ${to} cancelled: the new version is not on this box yet. Nothing was changed.`, alert: true };

  /** Before anything has changed: bring the old app and the monitor back, and say so truthfully. */
  const cancelAndRestart = async (reason: string): Promise<Result> => {
    let appBack = true;
    try { await compose.up('app'); } catch { appBack = false; }
    try { await compose.up('ops'); } catch { appBack = false; }
    return {
      outcome: 'cancelled',
      message: appBack
        ? `[${client}] Update to ${to} cancelled: ${reason} Nothing was changed; the app is running ${from} again.`
        : `[${client}] Update to ${to} cancelled: ${reason} Nothing was changed, but the app could not be started again: run docker compose up -d app ops`,
      alert: true,
    };
  };

  // 3. Stop the app (no write can be lost, Ruling 6) and the monitor (no false "not answering" page, no restic lock).
  log('Stopping the app and the monitor.');
  try {
    await compose.stop('app');
    await compose.stop('ops');
  } catch (e) {
    return cancelAndRestart(sentence(e));
  }

  // 4. The pre-update backup. If it fails, nothing has changed.
  log('Taking a backup first.');
  let snapshotId: string;
  try {
    snapshotId = (await deps.backup('pre-update')).snapshotId;
  } catch (e) {
    return cancelAndRestart(sentence(e));
  }
  const id = snapshotId.slice(0, 8);
  log(`Backup ${id} saved.`);

  /** After the backup: put the backup and the previous version back. */
  const rollback = async (reason: string): Promise<Result> => {
    log(`The update did not work (${reason}). Undoing it: putting back backup ${id} and version ${from}.`);
    let restored = false;
    let tagBack = false;
    try {
      await compose.stop('app');
      await deps.restoreDb(snapshotId);
      restored = true;
      await compose.writeTag(from);
      tagBack = true;
      await compose.up('app');
      const r = await deps.waitReady(from, timeoutMs);
      if (!r.ok) throw new Error(`${from} did not become healthy again: ${r.detail}`);
    } catch (e) {
      // Best effort, so the monitor watches the box while the operator responds.
      try { await compose.up('ops'); } catch { /* ignored */ }
      return {
        outcome: 'rollback-failed',
        message: `[${client}] URGENT: update to ${to} failed (${reason}) and the automatic undo also failed (${clause(e)}). The app may be down. Backup ${id} holds the data from before the update. `
          // Where the undo stopped, so the operator knows where to start.
          + `${restored ? `The database and uploaded files were put back from it` : 'The database and uploaded files were not put back from it'}, and .env ${tagBack ? `names ${from} again` : `still names ${to}`}. `
          + 'See the runbook, section "Recovering from a failed update".',
        alert: true,
      };
    }
    let message = `[${client}] Update to ${to} failed (${reason}), so it was undone automatically. The app is back on ${from} with its data exactly as it was before the update.`;
    try { await compose.up('ops'); } catch { message += MONITOR_NOTE; }
    return { outcome: 'rolled-back', message, alert: true };
  };

  // 5. Switch the tag and migrate.
  log(`Switching to ${to} and updating the database.`);
  try {
    await compose.writeTag(to);
  } catch (e) {
    // The rename is atomic: the settings still name the old version and the database is untouched.
    return cancelAndRestart(sentence(e));
  }
  let migrated = false;
  try { migrated = (await compose.runOnce('migrate')).ok; } catch { /* counted as failed */ }
  if (!migrated) return rollback('the database update failed');

  // 6. Start and wait for health: judged by the app's own version and readiness, never by the front door.
  log(`Starting ${to}.`);
  try {
    await compose.up('app');
  } catch {
    return rollback('the new version could not be started');
  }
  log(`Waiting for ${to} to be healthy (up to ${minutes(timeoutMs)}).`);
  let ready: { ok: boolean; detail: string };
  try {
    ready = await deps.waitReady(to, timeoutMs);
  } catch {
    ready = { ok: false, detail: `version ${to} could not be checked` };
  }
  if (!ready.ok) return rollback(ready.detail);

  // 7. The monitor back, then the front door (a settings mismatch there is a warning, not a failed update).
  let message = `[${client}] Updated from ${from} to ${to}. A backup (${id}) was taken first.`;
  try { await compose.up('ops'); } catch { message += MONITOR_NOTE; }
  if (deps.frontDoor !== undefined) {
    const warning = await deps.frontDoor().catch(() => 'Warning: the front door (web access) could not be checked. Run: docker compose up -d');
    if (warning !== undefined) message += ` ${warning}`;
  }
  // 8. Done.
  return { outcome: 'updated', message, alert: true };
}

/**
 * The front door after an update: the one-shot edge check (TUNNEL_IP inside EDGE_SUBNET) with the new image, then the proxy.
 * A failure here is reported as a warning: the app itself is updated and healthy, so it is never a reason to roll back.
 */
export function frontDoorCheck(compose: Compose): () => Promise<string | undefined> {
  return async () => {
    let check: { ok: boolean; output: string };
    try { check = await compose.runOnce('edge-check'); } catch { check = { ok: false, output: '' }; }
    if (!check.ok) {
      return /tunnel settings do not match/.test(check.output)
        ? 'Warning: TUNNEL_IP and EDGE_SUBNET in .env do not match, so the front door (web access) was not restarted, and it will not start again until they are fixed. The app itself is updated and healthy. Fix both settings together, then run: docker compose up -d'
        : 'Warning: the front door (web access) was not restarted because its settings check did not pass. The app itself is updated and healthy. Run docker compose up -d and read what it says.';
    }
    try {
      await compose.up('proxy');
    } catch {
      return 'Warning: the front door (web access) could not be started. The app itself is updated and healthy. Run: docker compose up -d proxy';
    }
    return undefined;
  };
}

const PROBE_TIMEOUT_MS = 5000;

/**
 * Polls the app until it runs `version` and is ready: GET /api/version gives that version, and GET /readyz (with the health
 * token) is not "down" and its `database` and `migrations` checks pass. Degraded backups or email do not count against it.
 */
export function httpWaitReady(o: { appUrl: string; healthToken: string; fetchImpl?: typeof fetch; pollMs?: number }): UpdateDeps['waitReady'] {
  const doFetch = o.fetchImpl ?? fetch;
  const pollMs = o.pollMs ?? 3000;
  const base = o.appUrl.replace(/\/+$/, '');
  const getJson = async (path: string, headers: Record<string, string> = {}): Promise<Record<string, unknown> | undefined> => {
    try {
      const res = await doFetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const body = (await res.json()) as unknown;
      return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  /** null when ready, otherwise the plain reason it is not. */
  const probe = async (version: string): Promise<string | null> => {
    const v = await getJson('/api/version');
    if (v === undefined) return 'the app was not answering';
    if (v['app'] !== version) return typeof v['app'] === 'string' ? `the app reported version ${v['app'].slice(0, 40)}` : 'the app was not answering';
    const r = await getJson('/readyz', o.healthToken !== '' ? { 'x-health-token': o.healthToken } : {});
    if (r === undefined) return 'the app was not answering';
    if (!Array.isArray(r['checks'])) return 'it gave no detailed health answer (check that HEALTH_TOKEN is the same for the app and ops)';
    const checks = r['checks'] as { name?: unknown; ok?: unknown }[];
    const passes = (name: string): boolean => checks.some((c) => c.name === name && c.ok === true);
    if (r['status'] === 'down' || !passes('database')) return 'its database check failed';
    if (!passes('migrations')) return 'its database updates check failed';
    return null;
  };
  return async (version, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const why = await probe(version);
      if (why === null) return { ok: true, detail: '' };
      const left = deadline - Date.now();
      if (left <= 0) return { ok: false, detail: `version ${version} did not become healthy within ${minutes(timeoutMs)}: ${why}` };
      await new Promise((res) => setTimeout(res, Math.min(pollMs, left)));
    }
  };
}
