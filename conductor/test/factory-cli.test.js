import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { saveApprovedBrief } from '../src/factory/brief.js';
import { FACTORY_COMMANDS } from '../src/cli/factory.js';
import { newSession, saveSession } from '../src/factory/briefSession.js';
import { approvedBrief } from './helpers/briefFixtures.js';

import { tmp, runMain, envFor } from './helpers/factoryCli.js';

// Plans 8, 10 and 11 add entries, so this checks Plan 7's four by name, never the whole table.
test('FACTORY_COMMANDS holds the Plan 7 handlers', () => {
  for (const k of ['project-new', 'project-list', 'project-show', 'brief']) assert.equal(typeof FACTORY_COMMANDS[k], 'function', k);
  assert.equal(Object.hasOwn(FACTORY_COMMANDS, 'run'), false, 'ordinary runs still go through the git-repo path');
});

test('a handler that returns null falls through to the ordinary path (Contract 7 §7.11)', async () => {
  FACTORY_COMMANDS.runs = async () => null;            // stand-in for Plan 8's resume handler
  try {
    const r = await runMain(['runs'], { env: envFor(tmp()) });
    assert.equal(r.code, 64);
    assert.match(r.out, /git repository/, 'main carried on to its usual "inside a git repository" check');
  } finally { delete FACTORY_COMMANDS.runs; }
});

test('ctx.config is the loaded config when it has participants, else null (Contract 7 §7.11)', async () => {
  const seen = [];
  const orig = FACTORY_COMMANDS['project-list'];
  FACTORY_COMMANDS['project-list'] = async (cli, ctx) => { seen.push(ctx); return orig(cli, ctx); };
  try {
    const cfg = path.join(tmp(), 'c.json');
    writeFileSync(cfg, JSON.stringify({ factory: { operatorName: 'Malcolm' } }));
    await runMain(['project', 'list', '--config', cfg], { env: envFor(tmp()) });
    writeFileSync(cfg, JSON.stringify({ participants: [], factory: { operatorName: 'Malcolm' } }));
    await runMain(['project', 'list', '--config', cfg], { env: envFor(tmp()) });
  } finally { FACTORY_COMMANDS['project-list'] = orig; }
  assert.equal(seen[0].config, null);
  assert.deepEqual(seen[1].config.participants, []);
  assert.equal(seen[1].factory.operatorName, 'Malcolm');
  for (const k of ['cwd', 'env', 'stdin', 'stdout', 'isTTY', 'onSignal', 'exit', 'factory', 'config', 'deps']) assert.ok(k in seen[1], k);
});

test('project new / list / show work outside a git repository, without a config', async () => {
  const root = path.join(tmp(), 'projects');
  const env = envFor(root);
  const none = await runMain(['project', 'list'], { env });
  assert.equal(none.code, 0);
  assert.match(none.out, /No projects yet\. Make one with: conductor project new "<client name>"/);

  const made = await runMain(['project', 'new', 'Thistle Joinery Ltd', '--slug', 'thistle'], { env });
  assert.equal(made.code, 0, made.out);
  assert.match(made.out, /Made project thistle for "Thistle Joinery Ltd" in .*projects\/thistle\nNext: conductor brief thistle --notes <your meeting notes>/);
  const dup = await runMain(['project', 'new', 'Thistle', '--slug', 'thistle'], { env });
  assert.equal(dup.code, 1);
  assert.match(dup.out, /A project called thistle already exists/);

  await runMain(['project', 'new', 'Acme'], { env });
  const dir = path.join(root, 'thistle');
  saveSession(dir, newSession({ slug: 'thistle', mode: 'new', notes: [], now: new Date('2026-10-27T10:00:00Z') }));
  let list = await runMain(['project', 'list'], { env });
  assert.match(list.out, /acme +Acme +briefing +no brief yet/);
  assert.match(list.out, /thistle +Thistle Joinery Ltd +briefing +brief unfinished \(run: conductor brief thistle\)/);

  saveApprovedBrief(dir, approvedBrief());
  list = await runMain(['project', 'list'], { env });
  assert.match(list.out, /thistle +Thistle Joinery Ltd +briefing +brief v1 approved 27 October 2026; a new version is unfinished/);

  const show = await runMain(['project', 'show', 'thistle'], { env });
  assert.equal(show.code, 0);
  for (const re of [/^Thistle Joinery Ltd \(thistle\)$/m, /^Folder: .*projects\/thistle$/m, /^Status: briefing$/m, /^Created: \d{1,2} [A-Z][a-z]+ \d{4}$/m,
    /^Foundation: not chosen yet \(set when the app is first built\)$/m, /^Approved build: none yet$/m, /^Brief: version 1, approved by Malcolm on 27 October 2026$/m,
    /^ {2}Read it: .*brief-v1\.md$/m, /^Unfinished brief: waiting at the first draft\. Carry on with: conductor brief thistle$/m]) assert.match(show.out, re);
  const missing = await runMain(['project', 'show', 'nope'], { env });
  assert.equal(missing.code, 1);
  assert.match(missing.out, /There is no project called "nope"/);
  const bad = await runMain(['project', 'show', '../etc'], { env });
  assert.equal(bad.code, 64);
  assert.match(bad.out, /is not a usable folder name/);
});

test('a bad factory section in the config is a plain usage error', async () => {
  const cfg = path.join(tmp(), 'c.json');
  writeFileSync(cfg, JSON.stringify({ participants: [], factory: { projectsRoot: 'relative' } }));
  const env = { ...process.env, XDG_CONFIG_HOME: tmp(), HOME: tmp() };
  delete env.CONDUCTOR_PROJECTS_ROOT;
  const r = await runMain(['project', 'list', '--config', cfg], { env });
  assert.equal(r.code, 64);
  assert.match(r.out, /Conductor could not read its config: factory\.projectsRoot must be a full path/);
  const gone = await runMain(['project', 'list', '--config', '/nope/c.json'], { env });
  assert.equal(gone.code, 64);
  assert.match(gone.out, /No config file at \/nope\/c\.json/);
});

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { interactive, briefWorld } from './helpers/factoryCli.js';
import { loadBrief, briefPaths } from '../src/factory/brief.js';
import { loadSession } from '../src/factory/briefSession.js';
import { NO_TTY_BRIEF_START } from '../src/cli/factory.js';
import { validBrief } from './helpers/briefFixtures.js';

const MARKER = 'MARKER-NOTES-5150';
const Q = { id: 'q1', question: 'Where should backups go?', why: 'Never only on the same box' };
const FIRST = validBrief({ policy: { ...validBrief().policy, backupDestination: null }, openQuestions: [Q] });

async function briefSetup() {
  const w = await briefWorld({ first: FIRST, second: validBrief() });
  const root = path.join(tmp(), 'projects');
  const env = envFor(root);
  await runMain(['project', 'new', 'Thistle Joinery Ltd', '--slug', 'thistle', '--config', w.cfg], { env });
  const notes = path.join(tmp(), 'meeting.md');
  writeFileSync(notes, `Met Jo. ${MARKER}. 45 staff.`);
  const dir = path.join(root, 'thistle');
  // go(args, answers, { deps, main, onPrompt }) runs `conductor brief thistle …` on a scripted terminal.
  const go = (args, answers, { deps, main, onPrompt } = {}) => {
    const t = interactive(answers, { onPrompt });
    return runMain(['brief', 'thistle', ...args, '--config', w.cfg, '--no-bell'], { env, isTTY: true, stdin: t.stdin, stdout: t.out, deps, main });
  };
  return { w, env, notes, dir, go };
}

test('no terminal: nothing is read, imported or sent', async () => {
  const s = await briefSetup();
  try {
    const r = await runMain(['brief', 'thistle', '--notes', s.notes, '--config', s.w.cfg], { env: s.env, isTTY: false });
    assert.equal(r.code, 1);
    assert.ok(r.out.includes(NO_TTY_BRIEF_START));
    assert.match(NO_TTY_BRIEF_START, /Nothing was read or sent to any AI model/);
    assert.deepEqual(readdirSync(path.join(s.dir, 'notes')), []);
    assert.equal(existsSync(briefPaths(s.dir).session), false);
    assert.equal(existsSync(s.w.promptLog), false);
    assert.equal(existsSync(path.join(s.dir, '.conductor.lock')), false, 'no lock taken without a terminal');
  } finally { await s.w.close(); }
});

test('the whole sitting: one question, approve; notes go only to the author; the local model is never contacted', async () => {
  const s = await briefSetup();
  try {
    const r = await s.go(['--notes', s.notes], ['A USB disk in their safe', 'a']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Your meeting notes go only to the frontier models \(Claude or Codex\), never to the local model\./);
    assert.match(r.out, /Question 1 of 1: Where should backups go\?/);
    assert.match(r.out, /=== The brief, ready for your approval ===\n# Brief: Thistle Joinery Ltd/);
    assert.match(r.out, /Approved\. Brief version 1 for Thistle Joinery Ltd is saved:\n {2}.*brief-v1\.md \(to read\)\n {2}.*brief-v1\.json \(what the factory builds from\)/);
    assert.match(r.out, /Frontier cost reported by the AI tools this sitting: \$0\.04/);
    assert.equal(loadBrief(s.dir).approvedBy, 'Malcolm');
    assert.ok(readFileSync(s.w.promptLog, 'utf8').includes(MARKER), 'the author got the notes');
    assert.deepEqual(s.w.bodies, [], 'the local model was never contacted');
    assert.equal(existsSync(path.join(s.dir, '.conductor.lock')), false);
    const [copy] = readdirSync(path.join(s.dir, 'notes'));
    assert.equal(readFileSync(path.join(s.dir, 'notes', copy), 'utf8'), `Met Jo. ${MARKER}. 45 staff.`);
  } finally { await s.w.close(); }
});

test('stop, refusals, resume, approved-already and revise-without-brief', async () => {
  const s = await briefSetup();
  try {
    const none = await s.go([], []);
    assert.equal(none.code, 1);
    assert.match(none.out, /There is no unfinished brief for thistle\. To start one, run: conductor brief thistle --notes <file>/);
    const rev = await s.go(['--revise', '--notes', s.notes], []);
    assert.equal(rev.code, 1);
    assert.match(rev.out, /thistle has no approved brief to revise yet\. Run: conductor brief thistle --notes <file>/);

    const stop = await s.go(['--notes', s.notes], ['stop']);
    assert.equal(stop.code, 1);
    assert.match(stop.out, /Stopped\. Your answers so far are saved\. To carry on, run: conductor brief thistle/);
    assert.equal(loadSession(s.dir, 'thistle').stage, 'questions');
    const again = await s.go(['--notes', s.notes], []);
    assert.equal(again.code, 1);
    assert.match(again.out, /There is an unfinished brief for thistle \(started \d{1,2} [A-Z][a-z]+ \d{4}\)\. Run conductor brief thistle to carry on with it, or conductor brief thistle --discard-draft to start again\./);

    const resumed = await s.go([], ['USB disk', 'a']);
    assert.equal(resumed.code, 0, resumed.out);
    assert.match(resumed.out, /Carrying on with the unfinished brief for thistle\./);
    const twice = await s.go(['--notes', s.notes], []);
    assert.equal(twice.code, 1);
    assert.match(twice.out, /thistle already has an approved brief \(version 1, approved \d{1,2} [A-Z][a-z]+ \d{4}\)\. To change it, run: conductor brief thistle --revise --notes <file>/);
  } finally { await s.w.close(); }
});

test('the lock, discarding, an unavailable author leaves nothing behind, Ctrl-C', async () => {
  const s = await briefSetup();
  try {
    await s.go(['--notes', s.notes], ['stop']);
    // The project lock is shared with Plan 8's builds and Plan 11's changes (Contract 7 §7.1).
    writeFileSync(path.join(s.dir, '.conductor.lock'), JSON.stringify({ pid: 424242, kind: 'build', at: '2026-10-27T09:00:00.000Z' }));
    const locked = await s.go([], [], { deps: { isAlive: () => true } });
    assert.equal(locked.code, 1);
    assert.match(locked.out, /This project is busy: a build is running \(pid 424242, since 27 October 2026 09:00 UTC\)/);
    const kept = await s.go(['--discard-draft'], ['n'], { deps: { isAlive: () => false } });
    assert.equal(kept.code, 1);
    assert.match(kept.out, /Nothing was thrown away\./);
    assert.ok(loadSession(s.dir, 'thistle'));
    const gone = await s.go(['--discard-draft'], ['y']);
    assert.equal(gone.code, 0);
    assert.match(gone.out, /The unfinished brief for thistle was thrown away\. Your notes are kept in .*notes/);
    assert.equal(loadSession(s.dir, 'thistle'), null);
    assert.equal((await s.go(['--discard-draft'], [])).code, 1);

    const down = await s.go(['--notes', s.notes], [], { deps: { buildAuthor: async () => ({ ok: false, error: 'No AI subscription can write the brief (claude: rate-limited). Sign in to Claude Code or Codex, then run the same command again. Nothing was sent to any AI model.' }) } });
    assert.equal(down.code, 2);
    assert.match(down.out, /No AI subscription can write the brief/);
    assert.equal(readdirSync(path.join(s.dir, 'notes')).length, 1, 'only the first sitting\'s copy: nothing new imported');
    assert.equal(existsSync(briefPaths(s.dir).session), false);
    assert.equal(existsSync(path.join(s.dir, '.conductor.lock')), false);

    let handler = null; let exitCode = null;
    const c = await s.go(['--notes', s.notes], [], {
      onPrompt: () => { const h = handler; handler = null; h?.(); },
      main: { onSignal: (h) => { handler = h; }, exit: (code) => { exitCode = code; } },
    });
    assert.equal(exitCode, 130, c.out);
    assert.match(c.out, /Stopped\. Your answers so far are saved\. To carry on, run: conductor brief thistle/);
    assert.equal(loadSession(s.dir, 'thistle').stage, 'questions');
    assert.equal(existsSync(path.join(s.dir, '.conductor.lock')), false);
  } finally { await s.w.close(); }
});

// ---- final-review fixes ----
import { mkdirSync } from 'node:fs';
import { writeStubCli } from './helpers/stubCli.js';

const ESCAPES = /[\x07\x1b]/;

test('escape characters in the author\'s broken reply never reach the terminal', async () => {
  const bins = tmp();
  // Node 22's JSON.parse quotes the raw reply text around the fault, escape characters and all.
  const hostile = 'Draft.\n```json\n{"client": "Thistle", "kind": tru\x1b]0;pwned\x07}\n```';
  const claude = writeStubCli(bins, 'claude', `
    if (args[0] === '--version') { console.log('2.1.0 (Claude Code)'); process.exit(0); }
    process.stdout.write(JSON.stringify({ result: ${JSON.stringify(hostile)}, is_error: false, total_cost_usd: 0 }));`);
  const cfg = path.join(tmp(), 'conductor.json');
  writeFileSync(cfg, JSON.stringify({ participants: [
    { name: 'claude', adapter: 'claude-code', bin: claude, roles: ['author', 'reviewer'], capabilities: { is_agentic: true, can_edit_files: true } },
  ], routing: { author: 'claude' }, factory: { operatorName: 'Malcolm' } }));
  const root = path.join(tmp(), 'projects');
  const env = envFor(root);
  await runMain(['project', 'new', 'Thistle Joinery Ltd', '--slug', 'thistle', '--config', cfg], { env });
  const notes = path.join(tmp(), 'meeting.md');
  writeFileSync(notes, 'Met Jo. 45 staff.');
  const t = interactive([]);
  const r = await runMain(['brief', 'thistle', '--notes', notes, '--config', cfg, '--no-bell'], { env, isTTY: true, stdin: t.stdin, stdout: t.out });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /Conductor could not get a usable brief from the AI after 3 tries\. The last problems were: the brief block is not valid JSON/);
  assert.equal(ESCAPES.test(r.out), false, JSON.stringify(r.out));
});

test('the last hop strips escape characters from anything the brief command prints', async () => {
  const s = await briefSetup();
  try {
    const r = await s.go(['--notes', s.notes], [], { deps: { buildAuthor: async () => ({ ok: false, error: 'claude: \x1b[31mbroken\x1b[0m\x07 \x1b]0;pwned\x07done' }) } });
    assert.equal(r.code, 2);
    assert.match(r.out, /claude: broken done/);
    assert.equal(ESCAPES.test(r.out), false, JSON.stringify(r.out));
  } finally { await s.w.close(); }
});

test('notes too long to send: refused before anything is saved, so the next sitting can start', async () => {
  const s = await briefSetup();
  try {
    const long = Array.from({ length: 12 }, (_, i) => `Assumption ${i + 1}: ${'the client keeps paper copies of every receipt. '.repeat(38)}`.trim());
    saveApprovedBrief(s.dir, approvedBrief({ assumptions: long }));
    const big = path.join(tmp(), 'big.md');
    writeFileSync(big, `Long meeting. ${'More detail about receipts and claims. '.repeat(2550)}`);
    const r = await s.go(['--revise', '--notes', big], []);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /These notes are too long to send in one go/);
    assert.deepEqual(readdirSync(path.join(s.dir, 'notes')), [], 'no notes copy was kept');
    assert.equal(existsSync(briefPaths(s.dir).session), false, 'no session was saved');
    assert.equal(existsSync(s.w.promptLog), false, 'nothing was sent');

    const next = await s.go(['--revise', '--notes', s.notes], ['stop']);
    assert.equal(next.code, 1, next.out);
    assert.match(next.out, /Stopped\. Your answers so far are saved\./);
  } finally { await s.w.close(); }
});

test('a session that cannot be thrown away is a plain failure, not a crash', async () => {
  const s = await briefSetup();
  try {
    mkdirSync(briefPaths(s.dir).session); // rm without recursive refuses a folder
    const r = await s.go(['--discard-draft'], ['y']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /Conductor could not throw away the unfinished brief for thistle: /);
    assert.doesNotMatch(r.out, /\n\s+at /, 'no stack trace');
    assert.equal(existsSync(path.join(s.dir, '.conductor.lock')), false);
  } finally { await s.w.close(); }
});

test('Ruling P12: a corrupt session is refused plainly until it is discarded', async () => {
  const s = await briefSetup();
  try {
    writeFileSync(briefPaths(s.dir).session, '{this is not json');
    const stuck = await s.go([], []);
    assert.equal(stuck.code, 1);
    assert.match(stuck.out, /The unfinished brief for thistle could not be read \(it is not valid JSON\)\. Run conductor brief thistle --discard-draft to start again\./);
    const withNotes = await s.go(['--notes', s.notes], []);
    assert.equal(withNotes.code, 1);
    assert.match(withNotes.out, /could not be read/);
    const gone = await s.go(['--discard-draft'], ['y']);
    assert.equal(gone.code, 0, gone.out);
    assert.match(gone.out, /The unfinished brief for thistle was thrown away/);
    assert.equal(existsSync(briefPaths(s.dir).session), false);
  } finally { await s.w.close(); }
});

test('a config file that is not valid JSON is named in the message', async () => {
  const cfg = path.join(tmp(), 'broken.json');
  writeFileSync(cfg, '{not json');
  const r = await runMain(['project', 'list', '--config', cfg], { env: envFor(tmp()) });
  assert.equal(r.code, 64);
  assert.ok(r.out.includes(`Conductor could not read its config file ${cfg}: `), r.out);
});
