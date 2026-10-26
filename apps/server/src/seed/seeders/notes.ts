import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, asc, eq, isNotNull, ne } from 'drizzle-orm';
import { audit } from '../../audit/audit.js';
import { files, notes, users } from '../../db/schema/index.js';
import { attachFile } from '../../files/repo.js';
import { receiptPng } from '../image.js';
import { registerSeeder } from '../registry.js';

const NOTES_PER_PERSON = 4;
const DAY = 24 * 60 * 60 * 1000;

registerSeeder({
  name: 'notes',
  order: 50,
  async run(ctx) {
    const { tx, faker, now, storage } = ctx;
    // Everyone who has activated an account and is not the admin, in a fixed order so the same seed gives the same notes.
    const people = await tx.select().from(users).where(and(isNotNull(users.passwordHash), ne(users.role, 'admin'))).orderBy(asc(users.email));
    let noteCount = 0;
    let fileCount = 0;
    for (const p of people) {
      const actor = { id: p.id, email: p.email, name: p.name, role: p.role, teamId: p.teamId };
      // Dates fall across the 60 days before `now`, oldest first.
      const dates = Array.from({ length: NOTES_PER_PERSON }, () => faker.date.between({ from: new Date(now.getTime() - 60 * DAY), to: now })).sort((a, b) => a.getTime() - b.getTime());
      for (let i = 0; i < NOTES_PER_PERSON; i++) {
        const at = dates[i] as Date;
        const withPhoto = i % 2 === 1;
        const vendor = faker.company.name();
        const [note] = await tx.insert(notes).values({
          ownerId: p.id,
          teamId: p.teamId,
          title: withPhoto ? `Receipt: ${vendor}`.slice(0, 200) : faker.lorem.sentence({ min: 3, max: 6 }).replace(/\.$/, ''),
          body: faker.lorem.sentences({ min: 1, max: 3 }),
          createdAt: at,
          updatedAt: at,
        }).returning({ id: notes.id });
        if (!note) throw new Error('A demo note was not created.');
        if (withPhoto) {
          const lines = [vendor, ...Array.from({ length: faker.number.int({ min: 6, max: 14 }) }, () => `${faker.commerce.productName()} ${faker.commerce.price()}`), `TOTAL ${faker.commerce.price({ min: 20, max: 200 })}`];
          const png = receiptPng(lines);
          // The same rules as an upload: a server-made random key, a files row, and an owner-checked attach.
          const key = randomBytes(16).toString('hex');
          const put = await storage.put(key, Readable.from([png]));
          ctx.writtenKeys.push(key);
          const [file] = await tx.insert(files).values({
            ownerId: p.id, teamId: p.teamId, storageKey: key, originalName: 'receipt.png', contentType: 'image/png',
            size: put.size, sha256: put.sha256, createdAt: at,
          }).returning({ id: files.id });
          if (!file) throw new Error('A demo file row was not created.');
          await audit(tx, { actor }, { action: 'file.uploaded', targetType: 'file', targetId: file.id, details: { name: 'receipt.png', size: put.size, contentType: 'image/png' } });
          await attachFile(tx, actor, file.id, { type: 'note', id: note.id });
          await tx.update(notes).set({ attachmentFileId: file.id }).where(eq(notes.id, note.id));
          fileCount++;
        }
        await audit(tx, { actor }, { action: 'note.created', targetType: 'note', targetId: note.id });
        noteCount++;
      }
    }
    ctx.counts['notes'] = noteCount;
    ctx.counts['files'] = fileCount;
  },
});
