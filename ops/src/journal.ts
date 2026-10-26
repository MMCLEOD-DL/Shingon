import { readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { ROLLBACK_FAILED_MARK } from '@hf/server/db/schema';
import { durableWrite, plainFsError, realFs, type DurableFs } from './durable.js';

/** Where an update had got to. Written before each step, so a crash leaves the step it was in. */
export type UpdateStep = 'stopping' | 'backing-up' | 'switching' | 'migrating' | 'starting' | 'undoing' | 'finishing';

export interface UpdateRecord {
  from: string;
  to: string;
  startedAt: string;     // ISO time
  updatedAt: string;     // ISO time of the last write
  step: UpdateStep;
  snapshot?: string;     // the pre-update backup, once taken
  pid: number;
  host: string;
}

export interface UpdateJournal {
  read(): Promise<UpdateRecord | null>;
  write(r: Omit<UpdateRecord, 'updatedAt' | 'pid' | 'host'>): Promise<void>;
  clear(): Promise<void>;
}

/** The update record's file name in /state. */
export const UPDATE_RECORD = 'update-in-progress.json';

/** What the box may look like when an update stopped during each step. */
export function stepText(r: Pick<UpdateRecord, 'step' | 'from' | 'to'>): string {
  switch (r.step) {
    case 'stopping': return 'stopping the app and the monitor (nothing else had changed, but they may be stopped)';
    case 'backing-up': return 'taking the backup before the update (nothing had changed yet, but the app and the monitor are stopped)';
    case 'switching': return `switching .env from ${r.from} to ${r.to} (the database had not been changed)`;
    case 'migrating': return `updating the database for ${r.to} (the database may be partly updated, and .env names ${r.to})`;
    case 'starting': return `starting ${r.to} and checking its health (the database was updated, and .env names ${r.to})`;
    case 'undoing': return `undoing the update (putting the backup and ${r.from} back), so the database, the uploads and .env may each be either version`;
    case 'finishing': return 'finishing (starting the monitor and recording the outcome)';
  }
}

/** The body shared by the URGENT alert and the monitor's check: "<to> (from <from>, started …) stopped part-way while …". */
function leftoverBody(r: UpdateRecord, when: (d: Date) => string): string {
  const backup = r.snapshot !== undefined ? ` Backup ${r.snapshot.slice(0, 8)} holds the data from before the update.` : ' No backup had been taken yet.';
  return `${r.to} (from ${r.from}, started ${when(new Date(r.startedAt))}) stopped part-way while ${stepText(r)}, and was never finished or undone.${backup} `
    + 'No further update will run until this is sorted out. See the runbook, section "Recovering from a failed update"; when it is sorted out, run: docker compose run --rm updater update --mark-recovered';
}

/** The plain-English URGENT alert for an update that stopped part-way. It carries ROLLBACK_FAILED_MARK, so once recorded the monitor and the backup pause see it. */
export function leftoverMessage(client: string, r: UpdateRecord, when: (d: Date) => string): string {
  return `[${client}] ${ROLLBACK_FAILED_MARK} ${leftoverBody(r, when)}`;
}

/** The same, as the monitor's check detail (the monitor adds the client and "Critical problem"). */
export function leftoverDetail(r: UpdateRecord, when: (d: Date) => string): string {
  return `The update to ${leftoverBody(r, when)}`;
}

/** A record the monitor and the backup pause should treat as left behind: anything but the last few minutes of a finishing update. */
export const FINISHING_GRACE_MS = 10 * 60e3;
export function isLeftover(r: UpdateRecord, now: Date): boolean {
  return r.step !== 'finishing' || now.getTime() - new Date(r.updatedAt).getTime() > FINISHING_GRACE_MS;
}

/** Parses a record file; anything unreadable counts as a record of an unknown update, never as "no record". */
export function parseRecord(text: string): UpdateRecord {
  try {
    const r = JSON.parse(text) as Partial<UpdateRecord>;
    if (typeof r.from === 'string' && typeof r.to === 'string' && typeof r.step === 'string' && typeof r.startedAt === 'string') {
      return { updatedAt: r.startedAt, pid: 0, host: '', ...r } as UpdateRecord;
    }
  } catch { /* fall through */ }
  return { from: 'unknown', to: 'unknown', step: 'undoing', startedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), pid: 0, host: '' };
}

/** Reads the record at `path`, or null when there is none. */
export async function readRecord(path: string): Promise<UpdateRecord | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    text = '';
  }
  return parseRecord(text);
}

/**
 * The update record in /state, written atomically and flushed to disk at each step (durableWrite). Readable by everyone in
 * the container (it holds no secret) and owned by `owner` (uid 1000, the ops daemon) so the monitor can read it.
 */
export function fileJournal(path: string, o: { now?: () => Date; owner?: { uid: number; gid: number }; fs?: DurableFs } = {}): UpdateJournal {
  const now = o.now ?? (() => new Date());
  return {
    read: () => readRecord(path),
    async write(r) {
      const full: UpdateRecord = { ...r, updatedAt: now().toISOString(), pid: process.pid, host: hostname() };
      try {
        await durableWrite(path, JSON.stringify(full, null, 2) + '\n', { mode: 0o644, ...(o.owner !== undefined ? { owner: o.owner } : {}) }, o.fs ?? realFs);
      } catch (e) {
        throw new Error(plainFsError(e));   // a plain reason, never a bare code or a path
      }
    },
    async clear() {
      await rm(path, { force: true });
    },
  };
}
