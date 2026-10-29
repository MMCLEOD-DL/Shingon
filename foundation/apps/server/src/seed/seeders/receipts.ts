import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { correctedFields, moduleOn, type ConfirmedReceipt, type ReceiptProposal } from '@hf/shared';
import { audit } from '../../audit/audit.js';
import { files, receiptReadings, teams, users } from '../../db/schema/index.js';
import { attachFile } from '../../files/repo.js';
import { READING_PARENT_TYPE } from '../../modules/ocr/repo.js';
import { registerSeeder } from '../registry.js';

const DAY = 24 * 60 * 60 * 1000;
// Fictional receipts rendered from Task 3's templates. The path works from src/seed/seeders and from dist/seed/seeders alike.
const photo = (name: string): Buffer => readFileSync(new URL(`../../../src/seed/receipts/${name}`, import.meta.url));

const CAFE: ReceiptProposal = {
  amountPence: { value: 875, confidence: 0.95 },
  vatPence: { value: 146, confidence: 0.9 },
  date: { value: '2026-03-05', confidence: 0.95 },
  merchant: { value: 'Corner Café', confidence: 0.8 },
  currency: 'GBP',
  warnings: [],
};
const CAFE_CONFIRMED: ConfirmedReceipt = { amountPence: 875, vatPence: 146, date: '2026-03-05', merchant: 'Corner Café' };
// The VAT is below the confidence line, so the form shows "Please check" on it.
const TAXI: ReceiptProposal = {
  amountPence: { value: 1240, confidence: 0.95 },
  vatPence: { value: 207, confidence: 0.6 },
  date: { value: '2026-03-12', confidence: 0.95 },
  merchant: { value: 'Northside Taxis', confidence: 0.8 },
  currency: 'GBP',
  warnings: [],
};

/** Receipt readings for the OCR pages: only when the ocr module is on. The first Operations member gets one confirmed and one waiting to be checked. */
registerSeeder({
  name: 'receipts',
  order: 60,
  async run(ctx) {
    if (!moduleOn(ctx, 'ocr')) return;
    const { tx, now, storage } = ctx;
    const [person] = await tx.select({ id: users.id, email: users.email, name: users.name, role: users.role, teamId: users.teamId })
      .from(users).innerJoin(teams, eq(teams.id, users.teamId))
      .where(and(eq(teams.name, 'Operations'), eq(users.role, 'member'), isNotNull(users.passwordHash))).orderBy(asc(users.email)).limit(1);
    if (!person) throw new Error('No Operations member was seeded for the demo receipts.');
    const actor = { id: person.id, email: person.email, name: person.name, role: person.role, teamId: person.teamId };

    const receipts = [
      { file: 'cafe.jpg', proposal: CAFE, confirmed: CAFE_CONFIRMED, at: new Date(now.getTime() - 3 * DAY) },
      { file: 'taxi.jpg', proposal: TAXI, confirmed: null, at: new Date(now.getTime() - DAY) },
    ];
    for (const r of receipts) {
      const key = randomBytes(16).toString('hex');
      const put = await storage.put(key, Readable.from([photo(r.file)]));
      ctx.writtenKeys.push(key);
      const [file] = await tx.insert(files).values({
        ownerId: person.id, teamId: person.teamId, storageKey: key, originalName: r.file, contentType: 'image/jpeg', size: put.size, sha256: put.sha256, createdAt: r.at,
      }).returning({ id: files.id });
      if (!file) throw new Error('A demo receipt file was not created.');
      await audit(tx, { actor }, { action: 'file.uploaded', targetType: 'file', targetId: file.id, details: { name: r.file, size: put.size, contentType: 'image/jpeg' } });
      const corrected = r.confirmed ? correctedFields(r.proposal, r.confirmed) : [];
      const [reading] = await tx.insert(receiptReadings).values({
        fileId: file.id, ownerId: person.id, teamId: person.teamId, status: r.confirmed ? 'confirmed' : 'read', engine: 'local-tesseract',
        proposal: r.proposal, confirmed: r.confirmed, corrected, createdAt: r.at, updatedAt: r.at, readAt: r.at, confirmedAt: r.confirmed ? r.at : null,
      }).returning({ id: receiptReadings.id });
      if (!reading) throw new Error('A demo receipt reading was not created.');
      await attachFile(tx, actor, file.id, { type: READING_PARENT_TYPE, id: reading.id });
      await audit(tx, { actor }, { action: 'reading.requested', targetType: 'file', targetId: file.id, details: { readingId: reading.id } });
      if (r.confirmed) await audit(tx, { actor }, { action: 'reading.confirmed', targetType: 'reading', targetId: reading.id, details: { corrected } });
    }
    ctx.counts['receipts'] = receipts.length;
  },
});
