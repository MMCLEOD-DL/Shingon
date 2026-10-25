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
  assert.deepEqual(f, { config: 'c.json', testCommand: 'npm test', approvePlan: true, approveEachChunk: true, watchDiffs: true, keepWorkspace: true, bell: false, council: true });
  assert.deepEqual(parseCli(['x']).flags, { config: null, testCommand: null, approvePlan: false, approveEachChunk: false, watchDiffs: false, keepWorkspace: false, bell: true, council: false });
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
