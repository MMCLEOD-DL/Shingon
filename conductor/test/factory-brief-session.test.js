import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importNotes, readNotes, newSession, loadSession, saveSession, discardSession, NOTES_FILE_MAX } from '../src/factory/briefSession.js';
import { briefPaths } from '../src/factory/brief.js';
import { validBrief } from './helpers/briefFixtures.js';

const NOW = new Date('2026-10-27T10:00:00Z');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'sess-'));
const project = () => { const d = tmp(); for (const s of ['brief', 'notes']) mkdirSync(path.join(d, s)); return d; };

test('importNotes copies the notes verbatim, privately, under a stamped name', () => {
  const p = project();
  const src = path.join(tmp(), 'Meeting with Jo (Thistle).md');
  const text = 'Met Jo.\r\n45 staff — receipts on phones. £12.40 example.\n';
  writeFileSync(src, text);
  const r = importNotes(p, src, { now: NOW });
  assert.deepEqual(r, { name: 'notes/2026-10-27T10-00-00Z-Meeting-with-Jo-Thistle-.md', bytes: Buffer.byteLength(text) });
  assert.equal(readFileSync(path.join(p, r.name), 'utf8'), text);
  assert.equal(statSync(path.join(p, r.name)).mode & 0o777, 0o600);
  assert.equal(importNotes(p, src, { now: NOW }).name, 'notes/2026-10-27T10-00-00Z-2-Meeting-with-Jo-Thistle-.md', 'same second: a new name, never an overwrite');
  assert.deepEqual(readNotes(p, [r.name]), [{ name: r.name, text }]);
  assert.throws(() => readNotes(p, ['../project.json']), /not one of this project's notes files/);
});

test('importNotes refuses folders, missing, empty, binary, non-UTF-8 and oversize files', () => {
  const p = project();
  const d = tmp();
  const f = (name, data) => { const x = path.join(d, name); writeFileSync(x, data); return x; };
  assert.throws(() => importNotes(p, d), /is a folder, not a notes file/);
  assert.throws(() => importNotes(p, path.join(d, 'nope.txt')), /There is no notes file at .*nope\.txt/);
  assert.throws(() => importNotes(p, f('empty.txt', ' \n\t\n')), /The notes file is empty/);
  assert.throws(() => importNotes(p, f('bin.txt', Buffer.from([0x48, 0x00, 0x49]))), /does not look like text/);
  assert.throws(() => importNotes(p, f('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]))), /is not UTF-8 text/);
  assert.throws(() => importNotes(p, f('big.txt', 'x'.repeat(NOTES_FILE_MAX + 1))), /The notes file is too big \(98 KB; the limit is 97 KB\)\. Split it or trim it\./);
  assert.deepEqual(readdirSync(path.join(p, 'notes')), [], 'nothing copied on refusal');
});

test('sessions save atomically with a readable draft, load back, and refuse corruption', () => {
  const p = project();
  assert.equal(loadSession(p, 'thistle'), null);
  const s = newSession({ slug: 'thistle', mode: 'new', notes: ['notes/a.md'], now: NOW });
  assert.equal(s.stage, 'draft');
  saveSession(p, s, { now: NOW });
  assert.equal(existsSync(briefPaths(p).draftMd), false, 'no draft yet, no draft.md');
  s.draft = validBrief();
  s.answers.push({ id: 'q1', question: 'Backups?', answer: 'USB disk', at: NOW.toISOString() });
  saveSession(p, s, { now: new Date('2026-10-27T10:05:00Z') });
  const back = loadSession(p, 'thistle');
  assert.deepEqual(back, { ...s, updatedAt: '2026-10-27T10:05:00.000Z' });
  assert.match(readFileSync(briefPaths(p).draftMd, 'utf8'), /^# Brief: Thistle Joinery Ltd/);
  assert.throws(() => loadSession(p, 'other'), /The unfinished brief for other could not be read \(it belongs to thistle\)\. Run conductor brief other --discard-draft to start again\./);
  writeFileSync(briefPaths(p).session, '{"schema":1,"slug":"thistle","stage":"dancing"}');
  assert.throws(() => loadSession(p, 'thistle'), /could not be read \(.*stage.*\)/);
  writeFileSync(briefPaths(p).session, '{oops');
  assert.throws(() => loadSession(p, 'thistle'), /could not be read/);
  discardSession(p);
  assert.equal(loadSession(p, 'thistle'), null);
  assert.equal(existsSync(briefPaths(p).draftMd), false);
});

test('notes with dots in the name import and read back; bare dot components are refused', () => {
  const p = project();
  const src = path.join(tmp(), 'a..b.md');
  writeFileSync(src, 'hello\n');
  const r = importNotes(p, src, { now: NOW });
  assert.deepEqual(readNotes(p, [r.name]), [{ name: r.name, text: 'hello\n' }]);
  assert.throws(() => readNotes(p, ['notes/..']), /not one of this project's notes files/);
  assert.throws(() => readNotes(p, ['notes/.']), /not one of this project's notes files/);
});
