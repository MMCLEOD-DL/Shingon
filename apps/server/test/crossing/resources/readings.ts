import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReceiptProposal } from '@hf/shared';
import { LocalDiskStorage } from '../../../src/files/storage.js';
import { files, receiptReadings } from '../../../src/db/schema/index.js';
import type { TestApp } from '../../helpers/testApp.js';
import type { IDS, WorldResource } from '../world.js';

const TINY_PNG = readFileSync(new URL('../../fixtures/files/tiny.png', import.meta.url));

type UserKey = Exclude<keyof (typeof IDS)['users'], 'pendingPat' | 'disabledPenny'>;
// One `read` reading for each actor who can sign in or hold a session (Dave included), on a receipt photo of their own
// (a file of its own, attached to the reading, as the app does). The canary is the proposed merchant.
const OWNERS: { key: UserKey; team: 'north' | 'south' | null }[] = [
  { key: 'admin', team: null },
  { key: 'northManager', team: 'north' },
  { key: 'northAlice', team: 'north' },
  { key: 'northBob', team: 'north' },
  { key: 'southManager', team: 'south' },
  { key: 'southCarol', team: 'south' },
  { key: 'disabledDave', team: 'north' },
];

const proposal = (merchant: string): ReceiptProposal => ({
  amountPence: { value: 1240, confidence: 0.95 },
  vatPence: { value: 207, confidence: 0.9 },
  date: { value: '2026-03-12', confidence: 0.95 },
  merchant: { value: merchant, confidence: 0.8 },
  currency: 'GBP',
  warnings: [],
});

export async function seedReadings(t: TestApp, ids: typeof IDS): Promise<WorldResource[]> {
  const storage = new LocalDiskStorage(t.config.uploadDir);
  const out: WorldResource[] = [];
  let n = 0;
  for (const o of OWNERS) {
    n++;
    const canary = `CANARY-reading-${o.key}`;
    const id = `d1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const fileId = `f2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const storageKey = `e${String(n).padStart(31, '0')}`;
    const ownerId = ids.users[o.key];
    const teamId = o.team === null ? null : ids.teams[o.team];
    const { size, sha256 } = await storage.put(storageKey, Readable.from([TINY_PNG]));
    await t.db.insert(files).values({
      id: fileId, ownerId, teamId, storageKey, originalName: 'receipt.png', contentType: 'image/png', size, sha256, attachedType: 'receipt-reading', attachedId: id,
    });
    await t.db.insert(receiptReadings).values({
      id, fileId, ownerId, teamId, status: 'read', engine: 'fake', proposal: proposal(canary), readAt: new Date(),
    });
    out.push({ type: 'reading', key: o.key, id, ownerId, teamId, canary, table: 'receipt_readings' });
  }
  return out;
}
