# Task 6: Session store, notes intake, lock

A brief takes a conversation, and a conversation can be interrupted. This task gives the brief loop (Task 7) three things:

- **durable state:** `brief/session.json`, saved atomically after every step;
- **verbatim notes:** the operator's notes file, copied into `notes/` and checked first;
- **a per-project lock:** two `conductor brief` processes can never write the same session.

**Files:**
- Create: `src/factory/briefSession.js`
- Test: `test/factory-brief-session.test.js`

**Interfaces:**
- Consumes: `writeJsonAtomic`, `writeFileAtomic`, `createFileExclusive` (Task 1); `briefPaths` and `renderBrief` (Task 4); `validBrief` fixture.
- Produces: the Task 6 block of Shared Interfaces. `newSession` returns:

```
{ schema: 1, slug, mode, baseVersion, notes, stage: 'draft', draft: null, pending: [], answers: [],
  changeRequests: [], problems: [], attempts: 0, rounds: 0, costUsd: 0, approving: null,
  startedAt: now.toISOString(), updatedAt: now.toISOString() }
```

- [ ] **Step 1: Write the failing tests** in `test/factory-brief-session.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importNotes, readNotes, newSession, loadSession, saveSession, discardSession, acquireBriefLock, NOTES_FILE_MAX } from '../src/factory/briefSession.js';
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

test('the lock: one sitting per project; a dead holder is replaced; release is idempotent', () => {
  const p = project();
  const release = acquireBriefLock(p, { pid: 111, isAlive: () => true });
  assert.throws(() => acquireBriefLock(p, { pid: 222, isAlive: (pid) => pid === 111 }), /Another conductor brief is already running for this project \(process 111\)\. Finish or stop that one first\./);
  const r2 = acquireBriefLock(p, { pid: 222, isAlive: () => false }); // 111 died without releasing
  release(); // the old holder's release must not remove 222's lock
  assert.ok(existsSync(briefPaths(p).lock));
  r2();
  r2();
  assert.equal(existsSync(briefPaths(p).lock), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-brief-session.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `src/factory/briefSession.js`**

- `NOTES_FILE_MAX = 100_000`.
- `importNotes(projectDir, notesFile, { now })`:
  1. Check the path in this order, each with the message in the test:
     - `statSync` fails → "no notes file at ${abs}";
     - it is a folder → "${abs} is a folder, not a notes file";
     - it is not a regular file → the same "not a notes file" message;
     - size > `NOTES_FILE_MAX` → "too big", with KB as `Math.ceil(bytes / 1024)` and the limit as `Math.floor(NOTES_FILE_MAX / 1024)`.
  2. Read the bytes. A NUL byte → `${abs} does not look like text (it has binary data in it).`
  3. `new TextDecoder('utf-8', { fatal: true })` throws → `${abs} is not UTF-8 text. Save it as UTF-8 and try again.`
  4. Blank once trimmed → `The notes file is empty.`
  5. Work out the target name. The stamp is `now.toISOString()` with the milliseconds dropped and `:` replaced by `-` (`2026-10-27T10-00-00Z`). The base is `path.basename` with runs outside `[A-Za-z0-9._-]` replaced by `-`, at most 60 characters, falling back to `notes.txt`. On `EEXIST`, try `${stamp}-2-${base}` up to `-9`.
  6. Write with `createFileExclusive(…, bytes, { mode: 0o600 })`. The **original bytes** are written, so the copy is verbatim.
- `readNotes(projectDir, names)`:
  - each name must match `/^notes\/[A-Za-z0-9._-]+$/`, else `"${name}" is not one of this project's notes files.`;
  - returns `{ name, text }`, with the text read as UTF-8.
- `loadSession(projectDir, slug)`:
  - `null` when the file is absent;
  - otherwise parse and check, reporting the first failure as `(${why})` inside the message in the test:
    - `schema === 1`;
    - `slug === slug` (why: `it belongs to ${s.slug}`);
    - `stage` is `draft`, `questions` or `approve` (why: `unknown stage "${stage}"`);
    - `mode` is `new` or `revise`;
    - `notes`, `pending`, `answers`, `changeRequests` and `problems` are arrays;
    - `attempts`, `rounds` and `costUsd` are finite numbers;
    - `draft` is null or an object;
    - `approving` is null or `{ version: integer }`.
- `saveSession(projectDir, session, { now })`:
  - sets `session.updatedAt = now.toISOString()`;
  - `writeJsonAtomic(briefPaths(p).session, session)`;
  - when `session.draft` is set, `writeFileAtomic(draftMd, renderBrief(session.draft))`.
- `discardSession(projectDir)` removes `session.json` and `draft.md` with `rmSync(…, { force: true })`. Notes and logs stay.
- `acquireBriefLock(projectDir, { pid, isAlive = pidAlive })`:
  - `openSync(lock, 'wx', 0o600)` and write `{"pid":…,"at":…}`;
  - on `EEXIST`, read the holder's pid. An unreadable lock file counts as dead. If the holder is alive, throw the message in the test. Otherwise `rmSync` it and retry once;
  - the returned `release()` deletes the lock only if the file still holds **this** pid, and never throws;
  - `pidAlive(pid)` is `try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/factory-brief-session.test.js && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/briefSession.js test/factory-brief-session.test.js
git commit -m "feat(factory): resumable brief sessions, verbatim notes intake and a per-project lock"
```
