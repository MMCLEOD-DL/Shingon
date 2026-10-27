import { ROLLBACK_FAILED_MARK } from '@hf/server/db/schema';
import type { AlertChannel } from './alerts.js';
import { isDockerHub, isQualified, notATag, TAG, type Compose } from './compose.js';
import { leftoverMessage, type UpdateJournal, type UpdateRecord, type UpdateStep } from './journal.js';
import { OpsBusyError } from './opsLock.js';
import { ukDate } from './time.js';

export type { Compose } from './compose.js';

/** What the rollback's restore reports as it goes, so a failed undo can say exactly what was put back. */
export type RestoreProgress = (done: 'database' | 'uploads') => void;

export interface UpdateDeps {
  compose: Compose;
  backup(kind: 'pre-update'): Promise<{ snapshotId: string }>;
  /** Puts the database and uploaded files from that backup back. Called only while the app and ops are stopped. */
  restoreDb(snapshotId: string, progress?: RestoreProgress): Promise<void>;
  waitReady(version: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }>;
  alert: AlertChannel;
  /**
   * Called once with the final outcome. `busy`: the update did not start because another run held a lock (Task 19).
   * Resolves false when the outcome could not be stored, so the update record is kept.
   */
  record(ok: boolean, detail: string, opts?: { busy?: boolean; snapshotId?: string }): Promise<unknown>;
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
  /** The durable record of an update in progress (/state/update-in-progress.json). */
  journal?: UpdateJournal;
  /** An earlier update whose undo failed and that has not been marked as recovered: refuse to update over it. */
  outstanding?: () => Promise<{ snapshotId?: string } | null>;
  /** Loads the new images from a file before anything else (update --image-file). */
  loadImages?: () => Promise<{ ok: boolean; message: string }>;
  /** Run before every start of the monitor: hands /state back to uid 1000. */
  beforeStartOps?: () => Promise<void>;
  /** How dates are shown in messages (Europe/London). */
  when?: (d: Date) => string;
  /** Progress lines for the operator watching the update. */
  log?: (line: string) => void;
}

/** `urgent`: refused because an earlier update stopped part-way (the CLI exits 3, as for rollback-failed). */
export type UpdateOutcome = { outcome: 'updated' | 'cancelled' | 'rolled-back' | 'rollback-failed'; message: string; urgent?: true };

interface Result extends UpdateOutcome { alert: boolean; busy?: boolean; snapshotId?: string }


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
    const result = await decide(deps, to);
    const stored = await deps.record(result.outcome === 'updated', result.message, {
      ...(result.busy === true ? { busy: true } : {}),
      ...(result.snapshotId !== undefined ? { snapshotId: result.snapshotId } : {}),
    }).catch(() => false);
    // The record of the update in progress goes only once its outcome is safely written down.
    if (stored !== false && deps.journal !== undefined && result.clearJournal) await deps.journal.clear().catch(() => undefined);
    if (result.alert) {
      await deps.alert.send(result.message).catch((e: unknown) => { deps.log?.(`The alert could not be sent: ${sentence(e)}`); });
    }
    return { outcome: result.outcome, message: result.message, ...(result.urgent === true ? { urgent: true as const } : {}) };
  } finally {
    await deps.lock.release();
  }
}

/** Everything once the update lock is held: the refusals that need no ops lock, then the update proper under it. */
async function decide(deps: UpdateDeps, to: string): Promise<Result & { clearJournal: boolean }> {
  const { client } = deps;
  // A record left by an update that stopped part-way (a crash, a kill, a power cut). Checked before anything else,
  // including "already on": the box is in an unknown state until the operator has looked.
  let left: UpdateRecord | null = null;
  try {
    left = (await deps.journal?.read()) ?? null;
  } catch { /* unreadable is handled by read() itself */ }
  if (left !== null) {
    return { outcome: 'cancelled', message: leftoverMessage(client, left, deps.when ?? ukDate), alert: true, urgent: true, ...(left.snapshot !== undefined ? { snapshotId: left.snapshot } : {}), clearJournal: false };
  }
  let urgent: { snapshotId?: string } | null = null;
  try {
    urgent = (await deps.outstanding?.()) ?? null;
  } catch {
    // Fail closed: an earlier failed update cannot be ruled out.
    return { outcome: 'cancelled', message: `[${client}] Update to ${to} cancelled: the ops log in the database could not be read to check for an earlier update that could not be undone, so nothing was changed. Check that the database is running, then try again.`, alert: true, clearJournal: false };
  }
  if (urgent !== null) {
    const id = urgent.snapshotId !== undefined ? ` (backup ${urgent.snapshotId.slice(0, 8)} holds the data from before it)` : '';
    return {
      outcome: 'cancelled',
      message: `[${client}] Update to ${to} cancelled: an earlier update could not be undone and has not been marked as recovered${id}. Nothing was changed. Recover the box first (see the runbook, section "Recovering from a failed update"), then run: docker compose run --rm updater update --mark-recovered`,
      alert: true,
      clearJournal: false,
    };
  }
  if (!TAG.test(to)) return { outcome: 'cancelled', message: notATag(to), alert: false, clearJournal: false };
  if (deps.exclusive === undefined) return { ...(await updateLocked(deps, to)), clearJournal: true };
  try {
    return { ...(await deps.exclusive(() => updateLocked(deps, to))), clearJournal: true };
  } catch (e) {
    if (!(e instanceof OpsBusyError)) throw e;
    return e.unreachable
      ? { outcome: 'cancelled', message: `[${client}] Update to ${to} cancelled: ${sentence(e)} Nothing was changed.`, alert: true, clearJournal: false }
      : { outcome: 'cancelled', message: `A backup or restore is still running, so the update to ${to} did not start. Nothing was changed. Try again when it has finished.`, alert: false, busy: true, clearJournal: false };
  }
}

/** The update proper, once both locks are held. Never throws: every failure becomes an outcome. */
async function updateLocked(deps: UpdateDeps, to: string): Promise<Result> {
  const { compose, client } = deps;
  const log = (l: string): void => { deps.log?.(l); };
  const timeoutMs = deps.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
  const startOps = async (): Promise<void> => {
    await deps.beforeStartOps?.().catch(() => undefined);
    await compose.up('ops');
  };

  // 1. Where we are.
  let from: string;
  try {
    from = await compose.readTag();
  } catch (e) {
    return { outcome: 'cancelled', message: `[${client}] Update to ${to} cancelled: ${sentence(e)} Nothing was changed.`, alert: true };
  }
  if (to === from) return { outcome: 'cancelled', message: `Already on ${to}.`, alert: false };
  log(`Updating ${client} from ${from} to ${to}.`);
  const cancel = (why: string): Result => ({ outcome: 'cancelled', message: `[${client}] Update to ${to} cancelled: ${why} Nothing was changed.`, alert: true });

  // Highland images never come from Docker Hub, whatever the name says.
  if (isDockerHub(deps.images.app) || isDockerHub(deps.images.ops)) {
    return cancel('APP_IMAGE or OPS_IMAGE in .env points at Docker Hub (docker.io), which Highland images never come from. Use your own registry (such as registry.example.com/highland/app) or load the images from a file with --image-file.');
  }
  // 2. The new images: loaded from a file if one was given, then present (or pulled from a named registry).
  if (deps.loadImages !== undefined) {
    const loaded = await deps.loadImages().catch((e: unknown) => ({ ok: false, message: sentence(e) }));
    if (!loaded.ok) return cancel(loaded.message);
    log(loaded.message);
  }
  let have = false;
  try {
    have = (await compose.imageAvailable(`${deps.images.app}:${to}`)) && (await compose.imageAvailable(`${deps.images.ops}:${to}`));
  } catch { /* counted as missing */ }
  if (!have) {
    if (isQualified(deps.images.app) && isQualified(deps.images.ops)) return cancel('the new version is not on this box yet.');
    return cancel(`the new version is not on this box yet. These images are never downloaded from Docker Hub; load them from a file made with docker save, kept in the bundle folder: docker compose run --rm updater update --to ${to} --image-file <file>`);
  }
  // The current version's images must still be here, or a rollback would have nothing to go back to.
  if (compose.hasLocalImage !== undefined) {
    let old = false;
    try {
      old = (await compose.hasLocalImage(`${deps.images.app}:${from}`)) && (await compose.hasLocalImage(`${deps.images.ops}:${from}`));
    } catch { /* counted as missing */ }
    if (!old) return cancel(`the images of the current version (${from}) are no longer on this box, so the update could not be undone if it failed. Load them again (from the file made with docker save, or from the registry) before updating.`);
  }

  // The durable record, before anything changes. If it cannot be written, nothing is touched.
  const startedAt = new Date().toISOString();
  let snapshotId: string | undefined;
  let markProblem: string | undefined;
  /** Writes the step; false (with the reason in markProblem) when the record could not be written. */
  const mark = async (step: UpdateStep): Promise<boolean> => {
    try {
      await deps.journal?.write({ from, to, startedAt, step, ...(snapshotId !== undefined ? { snapshot: snapshotId } : {}) });
      return true;
    } catch (e) {
      markProblem = clause(e);
      log(`Warning: the update record could not be written (${markProblem}).`);
      return false;
    }
  };
  /**
   * After the first change (.env switched), a step that could not be written leaves an out-of-date record: it is marked
   * 'uncertain' if at all possible, so a later reader never trusts a step that is no longer true.
   */
  const markAfterChange = async (step: UpdateStep): Promise<void> => {
    if (!(await mark(step))) await mark('uncertain');
  };
  if (deps.journal !== undefined) {
    try {
      await deps.journal.write({ from, to, startedAt, step: 'stopping' });
    } catch (e) {
      return cancel(`the update record could not be written (${clause(e)}).`);
    }
  }

  /** Before anything has changed: bring the old app and the monitor back, and say so truthfully. */
  const cancelAndRestart = async (reason: string): Promise<Result> => {
    await mark('finishing');
    let appBack = true;
    try { await compose.up('app'); } catch { appBack = false; }
    try { await startOps(); } catch { appBack = false; }
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

  // 4. The pre-update backup. If it fails, nothing has changed. Before any change, a record that cannot be kept up to date
  //    stops the update (the old version is started again).
  if (!(await mark('backing-up'))) return cancelAndRestart(`the update record could not be kept up to date (${markProblem ?? 'unknown problem'}).`);
  log('Taking a backup first.');
  try {
    snapshotId = (await deps.backup('pre-update')).snapshotId;
  } catch (e) {
    return cancelAndRestart(sentence(e));
  }
  const snap = snapshotId;
  const id = snap.slice(0, 8);
  log(`Backup ${id} saved.`);

  /** After the backup: put the backup and the previous version back. */
  const rollback = async (reason: string): Promise<Result> => {
    await markAfterChange('undoing');
    log(`The update did not work (${reason}). Undoing it: putting back backup ${id} and version ${from}.`);
    const done = { database: false, uploads: false, tag: false };
    try {
      await compose.stop('app');
      await deps.restoreDb(snap, (d) => { done[d] = true; });
      done.database = true;
      done.uploads = true;
      await compose.writeTag(from);
      done.tag = true;
      await compose.up('app');
      const r = await deps.waitReady(from, timeoutMs);
      if (!r.ok) throw new Error(`${from} did not become healthy again: ${r.detail}`);
    } catch (e) {
      // The record keeps saying the undo failed (no grace), in case the URGENT row cannot be stored. Then, best effort,
      // the monitor, so it watches the box while the operator responds.
      await markAfterChange('undo-failed');
      try { await startOps(); } catch { /* ignored */ }
      const restored = done.database && done.uploads ? 'The database and the uploaded files were put back from it'
        : done.database ? 'The database was put back from it, but the uploaded files were not'
          : 'The database and the uploaded files were not put back from it';
      return {
        outcome: 'rollback-failed',
        message: `[${client}] ${ROLLBACK_FAILED_MARK} ${to} failed (${reason}) and the automatic undo also failed (${clause(e)}). The app may be down. Backup ${id} holds the data from before the update. `
          // Exactly where the undo stopped, so the operator knows where to start.
          + `${restored}, and .env ${done.tag ? `names ${from} again` : `still names ${to}`}. `
          + 'See the runbook, section "Recovering from a failed update".',
        alert: true,
        snapshotId: snap,
      };
    }
    await markAfterChange('finishing');
    let message = `[${client}] Update to ${to} failed (${reason}), so it was undone automatically. The app is back on ${from} with its data exactly as it was before the update.`;
    try { await startOps(); } catch { message += MONITOR_NOTE; }
    return { outcome: 'rolled-back', message, alert: true, snapshotId: snap };
  };

  // 5. Switch the tag and migrate.
  if (!(await mark('switching'))) return cancelAndRestart(`the update record could not be kept up to date (${markProblem ?? 'unknown problem'}). Backup ${id} was taken.`);
  log(`Switching to ${to} and updating the database.`);
  try {
    await compose.writeTag(to);
  } catch (e) {
    // The rename is atomic: the settings still name the old version and the database is untouched.
    return cancelAndRestart(sentence(e));
  }
  await markAfterChange('migrating');
  let migrated = false;
  try { migrated = (await compose.runOnce('migrate')).ok; } catch { /* counted as failed */ }
  if (!migrated) return rollback('the database update failed');

  // 6. Start and wait for health: judged by the app's own version and readiness, never by the front door.
  await markAfterChange('starting');
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
  await markAfterChange('finishing');
  let message = `[${client}] Updated from ${from} to ${to}. A backup (${id}) was taken first.`;
  try { await startOps(); } catch { message += MONITOR_NOTE; }
  if (deps.frontDoor !== undefined) {
    const warning = await deps.frontDoor().catch(() => 'Warning: the front door (web access) could not be checked. Run: docker compose up -d');
    if (warning !== undefined) message += ` ${warning}`;
  }
  // 8. Done.
  return { outcome: 'updated', message, alert: true, snapshotId: snap };
}

/**
 * `ops update --mark-recovered`: after the operator has recovered by hand from an update whose undo failed (or that stopped
 * part-way), clears the standing alert and the backup pause. Refuses unless there is something to clear and the box is
 * healthy on the version .env names.
 */
export async function markRecovered(d: {
  lock: UpdateDeps['lock'];
  journal: UpdateJournal;
  outstanding: () => Promise<{ snapshotId?: string } | null>;
  readTag: () => Promise<string>;
  waitReady: UpdateDeps['waitReady'];
  record: (ok: boolean, detail: string) => Promise<unknown>;
  timeoutMs?: number;
}): Promise<{ ok: boolean; message: string }> {
  if (!(await d.lock.acquire())) return { ok: false, message: 'An update is running right now, so nothing was marked. Try again when it has finished.' };
  try {
    const left = await d.journal.read();
    const urgent = await d.outstanding();
    if (left === null && urgent === null) return { ok: false, message: 'There is no failed update to mark as recovered. Nothing was changed.' };
    let tag: string;
    try {
      tag = await d.readTag();
    } catch (e) {
      return { ok: false, message: `Nothing was marked: ${sentence(e)}` };
    }
    const r = await d.waitReady(tag, d.timeoutMs ?? 15_000);
    if (!r.ok) {
      return { ok: false, message: `The box does not look recovered yet, so nothing was marked (${r.detail}). Check that the app is running the version in .env (APP_TAG=${tag}) and that its database is up to date.` };
    }
    const message = `The operator marked the failed update as recovered: the app is healthy on ${tag}.`;
    if ((await d.record(true, message)) === false) return { ok: false, message: 'Nothing was marked: the ops log in the database could not be written. Check that the database is running.' };
    await d.journal.clear();
    return { ok: true, message };
  } finally {
    await d.lock.release();
  }
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
  const headers: Record<string, string> = o.healthToken !== '' ? { 'x-health-token': o.healthToken } : {};
  const getJson = async (path: string): Promise<Record<string, unknown> | undefined> => {
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
    const r = await getJson('/readyz');
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
