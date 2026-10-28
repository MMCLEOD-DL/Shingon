import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCli, USAGE } from '../src/cli/args.js';
import { findConfig } from '../src/cli/config.js';
import { listRuns } from '../src/cli/runs.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'cli-'));

test('parseCli: a request, subcommands and flags', () => {
  assert.deepEqual(parseCli(['add', 'a', 'CSV', 'export']).request, 'add a CSV export');
  assert.equal(parseCli(['resume the login work']).command, 'run', 'only a bare "resume" is the subcommand');
  assert.deepEqual(parseCli(['resume']), { command: 'resume', workspaceDir: null, flags: parseCli(['resume']).flags });
  assert.equal(parseCli(['resume', '/w/x']).workspaceDir, '/w/x');
  assert.equal(parseCli(['runs']).command, 'runs');
  assert.equal(parseCli(['doctor']).command, 'doctor');
  assert.equal(parseCli([]).command, 'help');
  assert.equal(parseCli(['--version']).command, 'version');
  const f = parseCli(['fix it', '--config', 'c.json', '--test', 'npm test', '--approve-plan', '--approve-each-chunk', '--watch-diffs', '--keep-workspace', '--no-bell', '--council']).flags;
  assert.deepEqual(f, { config: 'c.json', testCommand: 'npm test', approvePlan: true, approveEachChunk: true, watchDiffs: true, keepWorkspace: true, bell: false, council: true, stop: false, newBuild: false });
  assert.deepEqual(parseCli(['x']).flags, { config: null, testCommand: null, approvePlan: false, approveEachChunk: false, watchDiffs: false, keepWorkspace: false, bell: true, council: false, stop: false, newBuild: false });
});

test('parseCli: bad usage is an error, never a run', () => {
  assert.ok(parseCli(['x', '--bogus']).error);
  assert.ok(parseCli(['runs', 'extra']).error);
  assert.ok(parseCli(['resume', 'a', 'b']).error);
  assert.ok(parseCli(['   ']).error);
});

test('findConfig: flag, then ./conductor.json, then XDG, then ~/.config', () => {
  const cwd = tmp();
  const home = tmp();
  const xdg = tmp();
  assert.throws(() => findConfig({ cwd, env: {}, home }), (e) => e.message.includes(path.join(cwd, 'conductor.json')) && e.message.includes(path.join(home, '.config', 'conductor', 'config.json')));
  mkdirSync(path.join(home, '.config', 'conductor'), { recursive: true });
  writeFileSync(path.join(home, '.config', 'conductor', 'config.json'), '{}');
  assert.equal(findConfig({ cwd, env: {}, home }), path.join(home, '.config', 'conductor', 'config.json'));
  mkdirSync(path.join(xdg, 'conductor'));
  writeFileSync(path.join(xdg, 'conductor', 'config.json'), '{}');
  assert.equal(findConfig({ cwd, env: { XDG_CONFIG_HOME: xdg }, home }), path.join(xdg, 'conductor', 'config.json'));
  writeFileSync(path.join(cwd, 'conductor.json'), '{}');
  assert.equal(findConfig({ cwd, env: { XDG_CONFIG_HOME: xdg }, home }), path.join(cwd, 'conductor.json'));
  writeFileSync(path.join(cwd, 'mine.json'), '{}');
  assert.equal(findConfig({ flag: 'mine.json', cwd, env: {}, home }), path.join(cwd, 'mine.json'));
  assert.throws(() => findConfig({ flag: 'missing.json', cwd, env: {}, home }), /No config file at .*missing\.json/);
});

test('listRuns: unfinished runs of this repo only, newest first', () => {
  const baseDir = tmp();
  const mk = (name, state, mtime) => {
    mkdirSync(path.join(baseDir, name));
    mkdirSync(path.join(baseDir, `${name}.conductor`));
    const f = path.join(baseDir, `${name}.conductor`, 'state.json');
    writeFileSync(f, JSON.stringify({ version: 1, ...state }));
    utimesSync(f, mtime, mtime);
  };
  const plan = { chunks: [{ title: 'a' }, { title: 'b' }] };
  mk('ws-old', { status: 'failed', repoDir: '/repo', request: 'old', phase: 'chunks', chunkShas: ['s1'], plan }, 1000);
  mk('ws-new', { status: 'paused', repoDir: '/repo', request: 'new', phase: 'plan', chunkShas: [], plan: null }, 2000);
  mk('ws-done', { status: 'landed', repoDir: '/repo', request: 'done', phase: 'done', chunkShas: [] }, 3000);
  mk('ws-other', { status: 'running', repoDir: '/elsewhere', request: 'other', phase: 'plan', chunkShas: [] }, 4000);
  mkdirSync(path.join(baseDir, 'ws-gone.conductor'));
  writeFileSync(path.join(baseDir, 'ws-gone.conductor', 'state.json'), JSON.stringify({ status: 'running', repoDir: '/repo' }));
  mkdirSync(path.join(baseDir, 'ws-broken.conductor'));
  mkdirSync(path.join(baseDir, 'ws-broken'));
  writeFileSync(path.join(baseDir, 'ws-broken.conductor', 'state.json'), '{not json');
  const runs = listRuns({ baseDir, repoDir: '/repo' });
  assert.deepEqual(runs.map((r) => r.request), ['new', 'old']);
  assert.deepEqual({ done: runs[1].done, total: runs[1].total, status: runs[1].status }, { done: 1, total: 2, status: 'failed' });
  assert.equal(runs[0].workspaceDir, path.join(baseDir, 'ws-new'));
  assert.equal(listRuns({ baseDir, repoDir: null }).length, 3);
  assert.deepEqual(listRuns({ baseDir: path.join(baseDir, 'nope') }), []);
});

test('the usage text explains --council in plain words', () => {
  assert.match(USAGE, /--council +have specialist reviewers check security, licences and correctness before you approve/);
});

test('parseCli: project and brief commands (values outside flags)', () => {
  assert.deepEqual(parseCli(['project', 'new', 'Acme Ltd']), { command: 'project-new', client: 'Acme Ltd', slug: null, flags: parseCli(['x']).flags });
  assert.equal(parseCli(['project', 'new', 'Acme', 'Ltd']).client, 'Acme Ltd');
  assert.equal(parseCli(['project', 'new', 'Acme Ltd', '--slug', 'acme']).slug, 'acme');
  assert.equal(parseCli(['project', 'list']).command, 'project-list');
  assert.deepEqual(parseCli(['project', 'show', 'acme']).slug, 'acme');
  assert.deepEqual(parseCli(['brief', 'acme', '--notes', 'm.md']), { command: 'brief', slug: 'acme', notes: 'm.md', revise: false, discardDraft: false, flags: parseCli(['x']).flags });
  assert.equal(parseCli(['brief', 'acme']).notes, null, 'no --notes: carry on with an unfinished brief');
  assert.equal(parseCli(['brief', 'acme', '--revise', '--notes', 'm.md']).revise, true);
  assert.equal(parseCli(['brief', 'acme', '--discard-draft']).discardDraft, true);
  assert.equal(parseCli(['project brief for acme']).command, 'run', 'only a bare "project"/"brief" is a subcommand');
  for (const [argv, re] of [
    [['project'], /project needs new, list or show/],
    [['project', 'delete', 'x'], /project needs new, list or show/],
    [['project', 'new'], /project new needs the client's name/],
    [['project', 'list', 'x'], /project list takes no arguments/],
    [['project', 'show'], /project show needs one project name/],
    [['brief'], /brief needs one project name/],
    [['brief', 'a', 'b'], /brief needs one project name/],
    [['brief', 'acme', '--revise'], /brief --revise needs --notes <file>: the notes that say what changes/],
    [['brief', 'acme', '--discard-draft', '--notes', 'm.md'], /--discard-draft cannot be combined with --notes or --revise/],
    [['fix it', '--notes', 'm.md'], /--notes, --revise and --discard-draft only go with conductor brief/],
    [['project', 'list', '--slug', 'x'], /--slug only goes with conductor project new/],
  ]) assert.match(parseCli(argv).error ?? '', re, argv.join(' '));
});

test('the usage text lists the project and brief commands', () => {
  for (const s of ['conductor project new "<client>"', 'conductor project list', 'conductor project show <slug>',
    'conductor brief <slug> --notes <file>', 'conductor brief <slug> --revise --notes <file>', 'conductor brief <slug> --discard-draft']) assert.ok(USAGE.includes(s), s);
});

test('parseCli: ship and deployments', () => {
  assert.deepEqual(pick(parseCli(['ship', 'acme', '--to', 'acme-office'])), { command: 'ship', slug: 'acme', to: 'acme-office' });
  assert.match(parseCli(['ship', 'acme']).error, /ship needs a project and a deployment/);
  assert.deepEqual(pick(parseCli(['deployments'])), { command: 'deployments', status: false, slug: null });
  assert.deepEqual(pick(parseCli(['deployments', 'status', 'acme'])), { command: 'deployments', status: true, slug: 'acme' });
});
function pick(c) { const { flags, ...rest } = c; return rest; }

test('parseCli: change and foundation-upgrade', () => {
  assert.deepEqual(pick(parseCli(['change', 'acme', '--notes', 'n.md'])), { command: 'change', slug: 'acme', notesFile: 'n.md', resume: false, abandon: false });
  assert.deepEqual(pick(parseCli(['change', 'acme', '--resume'])), { command: 'change', slug: 'acme', notesFile: null, resume: true, abandon: false });
  assert.deepEqual(pick(parseCli(['change', 'acme', '--abandon'])), { command: 'change', slug: 'acme', notesFile: null, resume: false, abandon: true });
  assert.deepEqual(pick(parseCli(['foundation-upgrade', 'acme', '--to', 'v0.1.1'])), { command: 'foundation-upgrade', slug: 'acme', toTag: 'v0.1.1', resume: false, abandon: false, check: false });
  assert.deepEqual(pick(parseCli(['foundation-upgrade', 'acme', '--resume'])), { command: 'foundation-upgrade', slug: 'acme', toTag: null, resume: true, abandon: false, check: false });
  assert.deepEqual(pick(parseCli(['foundation-upgrade', '--check'])), { command: 'foundation-upgrade', slug: null, toTag: null, resume: false, abandon: false, check: true });
  assert.match(parseCli(['change', 'acme']).error, /change needs a project name and one of --notes/);
  assert.match(parseCli(['change', 'acme', '--notes', 'n', '--resume']).error, /one of/);
  assert.match(parseCli(['change', 'acme', '--to', 'v0.1.1']).error, /one of/);
  assert.match(parseCli(['change']).error, /change needs a project name/);
  assert.match(parseCli(['foundation-upgrade', 'acme', '--check']).error, /--check on its own/);
  assert.match(parseCli(['foundation-upgrade', 'acme']).error, /one of --to <tag>/);
  assert.match(parseCli(['foundation-upgrade', 'acme', '--notes', 'n.md']).error, /one of --to <tag>/);
  assert.match(parseCli(['change', 'a', 'b', '--resume']).error, /one project name/);
  assert.equal(parseCli(['change', 'acme', '--notes', 'n.md', '--no-bell']).flags.bell, false);
});

test('a request that merely starts with the word change is still a normal run when it has more words and no change flags', () => {
  assert.deepEqual(pick(parseCli(['change', 'the', 'button', 'colour'])), { command: 'run', request: 'change the button colour' });
  assert.deepEqual(pick(parseCli(['foundation-upgrade', 'the', 'docs'])), { command: 'run', request: 'foundation-upgrade the docs' });
});

test('the change flags stay where they belong; the old guards still hold for other commands', () => {
  assert.match(parseCli(['fix it', '--notes', 'm.md']).error, /--notes, --revise and --discard-draft only go with conductor brief/);
  assert.match(parseCli(['build', 'acme', '--to', 'x']).error, /--to only goes with conductor ship/);
  assert.match(parseCli(['build', 'acme', '--resume']).error, /--resume, --abandon and --check only go with conductor change or conductor foundation-upgrade/);
  assert.match(parseCli(['change', 'acme', '--notes', 'n.md', '--revise']).error, /--revise and --discard-draft only go with conductor brief/);
  assert.equal(parseCli(['ship', 'acme', '--to', 'box']).command, 'ship');
  assert.equal(parseCli(['brief', 'acme', '--notes', 'n.md']).command, 'brief');
});

test('the usage text lists the change commands', () => {
  for (const s of ['conductor change <slug> --notes <file>', 'conductor change <slug> --resume', 'conductor change <slug> --abandon',
    'conductor foundation-upgrade <slug> --to <tag>', 'conductor foundation-upgrade <slug> --resume | --abandon', 'conductor foundation-upgrade --check']) assert.ok(USAGE.includes(s), s);
});
