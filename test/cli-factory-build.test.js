import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable, Readable } from 'node:stream';
import { parseCli } from '../src/cli/args.js';
import { main } from '../src/cli/main.js';
import { FACTORY_COMMANDS } from '../src/cli/factory.js';
import { projectSlugFor, buildOutcomeText, resumeBuildCommand, NO_TTY_BUILD_START } from '../src/cli/factoryBuild.js';
import { git } from '../src/workspace.js';
import { writeStubCli } from './helpers/stubCli.js';
import { stubDockerPath, stubCurl } from './helpers/stubDocker.js';
import { makeFoundationRepo, makeProject } from './helpers/factoryFixtures.js';
import { factoryConfig } from '../src/factory/config.js';
import { lockProject } from '../src/factory/projectLock.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));

test('the handlers are registered in Plan 7\'s factory command table', () => {
  for (const c of ['build', 'preview', 'machines', 'resume']) assert.equal(typeof FACTORY_COMMANDS[c], 'function', c);
});

test('parsing the factory commands', () => {
  assert.deepEqual(parseCli(['build', 'acme-ltd']).command, 'build');
  assert.equal(parseCli(['build', 'acme-ltd', '--new']).flags.newBuild, true);
  assert.equal(parseCli(['preview', 'acme-ltd', '--stop']).flags.stop, true);
  assert.deepEqual([parseCli(['machines']).action, parseCli(['machines', 'sweep']).action], ['list', 'sweep']);
  assert.match(parseCli(['build']).error, /build needs the project's short name, for example: conductor build acme-ltd/);
  assert.match(parseCli(['build', 'Acme Ltd']).error, /"Acme Ltd" is not a project's short name/);
  assert.match(parseCli(['machines', 'nuke']).error, /machines takes "list" or "sweep"/);
  assert.match(parseCli(['x', '--stop']).error, /--stop only goes with conductor preview/);
});

test('resume inside a project folder finds the project; elsewhere it is not a build', async () => {
  const root = tmp('pr-');
  mkdirSync(path.join(root, 'acme-ltd', 'app', 'apps'), { recursive: true });
  writeFileSync(path.join(root, 'acme-ltd', 'project.json'), '{}');
  assert.equal(projectSlugFor(path.join(root, 'acme-ltd', 'app', 'apps'), root), 'acme-ltd');
  assert.equal(projectSlugFor(root, root), null);
  assert.equal(projectSlugFor(tmp('else-'), root), null);
  const config = path.join(tmp('cfg-'), 'conductor.json');
  writeFileSync(config, JSON.stringify({ participants: [], factory: { projectsRoot: root } }));
  const ctx = { cwd: tmp('else-'), env: {}, stdout: new Writable({ write(c, e, cb) { cb(); } }), isTTY: false,
    factory: factoryConfig({ factory: { projectsRoot: root } }, { env: {} }), config: null, configPath: config, deps: {} };
  assert.equal(await resumeBuildCommand(parseCli(['resume', '--config', config]), ctx), null, 'main carries on with an ordinary resume');
  assert.equal(await resumeBuildCommand(parseCli(['resume', '/w/x', '--config', config]), ctx), null, 'a workspace path is never a build');
});

test('build outcome text', () => {
  assert.match(buildOutcomeText({ status: 'ready', buildDir: '/p/builds/r' }, { slug: 'acme-ltd', client: 'Acme Ltd', appDir: '/p/app' }),
    /Done\. Acme Ltd's app is approved and ready\. Its code is on the main branch of \/p\/app\.\nSee it running: conductor preview acme-ltd/);
  assert.match(buildOutcomeText({ status: 'paused', reason: 'Conductor paused: x.', buildDir: '/p/builds/r' }, { slug: 'acme-ltd' }),
    /Conductor paused: x\.\nTo carry on: conductor build acme-ltd\nBuild log: \/p\/builds\/r\/build-log\.jsonl/);
});

// A fully local preview: "ssh" runs the script under bash with stub docker and curl; "scp" copies the file.
async function localFactory() {
  const bin = tmp('bin-');
  stubDockerPath(bin, { seed: 'Demo data added: 2 teams.\nSign in with any of these (password: demo-password-1):\n  admin@demo.test (admin)' });
  stubCurl(bin);
  const ssh = writeStubCli(tmp('ssh-'), 'ssh', `
    const { spawnSync } = require('child_process');
    const r = spawnSync('bash', ['-s'], { input: require('fs').readFileSync(0), env: { ...process.env, PATH: ${JSON.stringify(bin)} + ':' + process.env.PATH } });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status ?? 1);`);
  const scp = writeStubCli(tmp('scp-'), 'scp', `require('fs').copyFileSync(args.at(-2), args.at(-1).split(':').slice(1).join(':'));`);
  const repo = await makeFoundationRepo({ extra: { 'deploy/compose.yaml': 'name: x\n', 'deploy/Caddyfile': ':80\n', 'deploy/Dockerfile': 'FROM x\n', 'deploy/ops.Dockerfile': 'FROM x\n' } });
  const { projectsRoot, projectDir, slug } = makeProject();
  await git(projectDir, ['clone', '-q', repo, 'app']);
  const workRoot = tmp('work-');
  const config = path.join(tmp('cfg-'), 'conductor.json');
  writeFileSync(config, JSON.stringify({ participants: [], factory: { projectsRoot, machines: { sshBin: ssh, scpBin: scp,
    static: { hosts: [{ id: 'ct111', name: 'hf-build', host: '127.0.0.1', workRoot }] } } } }));
  return { config, projectDir, slug, workRoot };
}
function out() { let text = ''; return { stream: new Writable({ write(c, e, cb) { text += c; cb(); } }), text: () => text }; }

test('conductor preview, then machines list, then preview --stop, all against stubbed machines', async () => {
  const f = await localFactory();
  const cwd = tmp('cwd-');   // not a git repository: these commands do not need one
  const o = out();
  assert.equal(await main(['preview', f.slug, '--config', f.config], { cwd, stdout: o.stream, isTTY: false }), 0);
  assert.match(o.text(), /The preview of Acme Ltd's app is running \(the approved app\): http:\/\/127\.0\.0\.1:8080\//);
  assert.match(o.text(), /admin@demo\.test/);
  assert.match(o.text(), /Stop it with: conductor preview acme-ltd --stop/);
  assert.ok(existsSync(path.join(f.projectDir, 'preview.json')));
  const l = out();
  assert.equal(await main(['machines', '--config', f.config], { cwd, stdout: l.stream, isTTY: false }), 0);
  assert.match(l.text(), /ct111 hf-build 127\.0\.0\.1: preview for acme-ltd since \d\d:\d\d \d+ \w{3}/);
  const s = out();
  assert.equal(await main(['preview', f.slug, '--stop', '--config', f.config], { cwd, stdout: s.stream, isTTY: false }), 0);
  assert.match(s.text(), /Stopped the preview of acme-ltd\./);
  assert.equal(existsSync(path.join(f.projectDir, 'preview.json')), false);
  assert.equal(existsSync(path.join(f.workRoot, 'lock')), false);
});

test('a machine problem is a plain message and exit 2', async () => {
  const f = await localFactory();
  const busy = path.join(f.workRoot, 'lock');
  mkdirSync(busy, { recursive: true });
  writeFileSync(path.join(busy, 'owner.json'), JSON.stringify({ factory: 'hf', project: 'bobs-bikes', run: '20261027-100000-aaaa', purpose: 'council', createdAt: new Date().toISOString() }));
  const o = out();
  assert.equal(await main(['preview', f.slug, '--config', f.config], { cwd: tmp('cwd-'), stdout: o.stream, isTTY: false }), 2);
  assert.match(o.text(), /Every factory machine is in use: hf-build is running a council for bobs-bikes/);
  assert.doesNotMatch(o.text(), /at .*\.js:\d+/, 'no stack trace');
});

test('build hands the prepared team, hooks and options to runBuild and maps the outcome to an exit code', async () => {
  const { projectsRoot, projectDir, slug } = makeProject();
  const config = path.join(tmp('cfg-'), 'conductor.json');
  writeFileSync(config, JSON.stringify({ participants: [], factory: { projectsRoot } }));
  const seen = [];
  const deps = {
    prepareTeam: async () => ({ built: { team: { author: {}, reviewer: {}, local: {} }, warnings: [] }, hooks: { escalate: async () => 'reject' }, overrides: { approvePlan: true }, remember: () => {} }),
    runBuild: async (a) => { seen.push(a); return { status: 'paused', runId: 'r', buildDir: '/b', reason: 'Conductor paused: the local model stopped.' }; },
  };
  const o = out();
  const ctx = { cwd: tmp('cwd-'), env: {}, stdin: Readable.from([]), stdout: o.stream, isTTY: true, onSignal: () => {}, exit: () => {}, deps,
    factory: factoryConfig({ factory: { projectsRoot } }, { env: {} }), config: { participants: [], byName: new Map(), routing: {}, options: {}, factory: {} }, configPath: config };
  const code = await FACTORY_COMMANDS.build(parseCli(['build', slug, '--new', '--config', config]), ctx);
  assert.equal(code, 3);
  assert.equal(seen[0].slug, slug);
  assert.deepEqual([seen[0].options.approvePlan, seen[0].options.newBuild], [true, true]);
  assert.equal(typeof seen[0].hooks.approveBuild, 'function');
  assert.match(o.text(), /To carry on: conductor build acme-ltd/);
  // the handler takes the project lock (Contract 7 §7.11): busy → plain message, nothing prepared, nothing built
  const release = lockProject(projectDir, 'change');
  try {
    const b = out();
    assert.equal(await FACTORY_COMMANDS.build(parseCli(['build', slug, '--config', config]), { ...ctx, stdout: b.stream }), 1);
    assert.match(b.text(), /This project is busy: a change is running/);
    assert.equal(seen.length, 1, 'runBuild was not called again');
  } finally { release(); }
});

test('resume inside a project with an unfinished build carries on that build; a finished one is not a build', async () => {
  const { newBuild, saveBuild, buildDirOf } = await import('../src/factory/buildState.js');
  const { projectsRoot, projectDir, slug } = makeProject();
  mkdirSync(path.join(projectDir, 'app'), { recursive: true });
  const b = { ...newBuild({ runId: '20261027-100000-abcd', slug, client: 'Acme Ltd', briefHash: 'h', briefVersion: 1, foundation: {} }), status: 'paused' };
  saveBuild(buildDirOf(projectDir, b.runId), b);
  const seen = [];
  const deps = {
    prepareTeam: async () => ({ built: { team: {}, warnings: [] }, hooks: {}, overrides: {}, remember: () => {} }),
    runBuild: async (a) => { seen.push(a); return { status: 'ready', runId: b.runId, buildDir: '/b' }; },
  };
  const o = out();
  const ctx = { cwd: path.join(projectDir, 'app'), env: {}, stdin: Readable.from([]), stdout: o.stream, isTTY: true, onSignal: () => {}, exit: () => {}, deps,
    factory: factoryConfig({ factory: { projectsRoot } }, { env: {} }), config: { participants: [], options: {} }, configPath: null };
  assert.equal(await resumeBuildCommand(parseCli(['resume']), ctx), 0);
  assert.equal(seen[0].slug, slug);
  assert.match(o.text(), /Done\. Acme Ltd's app is approved and ready/);
  saveBuild(buildDirOf(projectDir, b.runId), { ...b, status: 'ready' });
  assert.equal(await resumeBuildCommand(parseCli(['resume']), ctx), null);
  assert.equal(seen.length, 1);
});

test('machines sweep spares live previews and shows the provider\'s notes; a Proxmox machine is named by its CT number', async () => {
  const { runMachinesCommand } = await import('../src/cli/factoryBuild.js');
  const { projectsRoot, projectDir } = makeProject();
  writeFileSync(path.join(projectDir, 'preview.json'), JSON.stringify({ schema: 1, runId: '20261027-100000-abcd' }));
  const factory = factoryConfig({ factory: { projectsRoot } }, { env: {} });
  let asked = null;
  const provider = { kind: 'proxmox', notes: ['Container 9001 has no factory label, so it was left alone.'],
    sweep: async (a) => { asked = a; return 2; },
    list: async () => [{ id: '9100', vmid: 9100, name: 'hf-acme-ltd-9100', host: null, labels: { project: 'acme-ltd', purpose: 'council', createdAt: '2026-10-27T09:00:00Z' } }] };
  const lines = [];
  assert.equal(await runMachinesCommand({ factory, action: 'sweep', print: (s) => lines.push(s), deps: { provider } }), 0);
  assert.deepEqual(asked, { olderThanMs: factory.machines.sweepAfterMs, keep: ['20261027-100000-abcd'] });
  assert.deepEqual(lines, ['Cleared 2 leftover machines.', 'Note: Container 9001 has no factory label, so it was left alone.']);
  lines.length = 0;
  assert.equal(await runMachinesCommand({ factory, action: 'list', print: (s) => lines.push(s), deps: { provider } }), 0);
  assert.match(lines.join('\n'), /Factory machines \(proxmox\):\n  9100 CT 9100 \(no address yet\): council for acme-ltd since 09:00 27 Oct/);
  const failing = { notes: [], list: async () => { throw new Error('Conductor could not reach Proxmox.'); } };
  assert.equal(await runMachinesCommand({ factory, action: 'list', print: (s) => lines.push(s), deps: { provider: failing } }), 2);
});

test('a reused preview says where its demo sign-ins were shown (Ruling Q34)', async () => {
  const { previewText } = await import('../src/cli/factoryBuild.js');
  const t = previewText({ status: 'already', url: 'http://h:8080/', seedText: null, from: 'build' }, { slug: 'acme-ltd', client: 'Acme Ltd' });
  assert.match(t, /^The preview is already running \(the build in progress\): http:\/\/h:8080\/\n.*\nThe demo sign-ins are as shown when the preview was first started\.\nStop it with: conductor preview acme-ltd --stop$/);
});

function buildCtx({ isTTY = true, deps, onSignal = () => {}, exit = () => {} } = {}) {
  const { projectsRoot, projectDir, slug } = makeProject();
  const config = path.join(tmp('cfg-'), 'conductor.json');
  writeFileSync(config, JSON.stringify({ participants: [], factory: { projectsRoot } }));
  const o = out();
  const ctx = { cwd: tmp('cwd-'), env: {}, stdin: Readable.from([]), stdout: o.stream, isTTY, onSignal, exit, deps,
    factory: factoryConfig({ factory: { projectsRoot } }, { env: {} }), config: { participants: [], byName: new Map(), routing: {}, options: {}, factory: {} }, configPath: config };
  return { ctx, o, slug, projectDir, config };
}

test('final-fix 7: conductor build without a terminal refuses before anything is prepared or spent', async () => {
  const calls = [];
  const deps = { prepareTeam: async () => { calls.push('prepare'); return { code: 0 }; }, runBuild: async () => { calls.push('build'); return { status: 'ready' }; } };
  const { ctx, o, slug, projectDir, config } = buildCtx({ isTTY: false, deps });
  assert.equal(await FACTORY_COMMANDS.build(parseCli(['build', slug, '--config', config]), ctx), 1);
  assert.deepEqual(calls, []);
  assert.ok(o.text().includes(NO_TTY_BUILD_START), o.text());
  assert.match(NO_TTY_BUILD_START, /conductor build needs a terminal/);
  assert.equal(existsSync(path.join(projectDir, '.conductor.lock')), false, 'the lock was never taken');
});

test('final-fix 9: progress, escalations and the gate reach the terminal without escape characters or secrets', async () => {
  const seen = [];
  const SECRET = 'sk-test-terminal-0123456789';
  const deps = {
    prepareTeam: async () => ({ built: { team: {}, warnings: [] }, hooks: { escalate: async (a) => { seen.push(a); return 'reject'; } }, overrides: {}, remember: () => {} }),
    runBuild: async ({ hooks }) => {
      hooks.onProgress(`Building \x1b]0;evil\x07step \x1b[31mred\x1b[0m with ${SECRET}`);
      await hooks.escalate({ kind: 'council', title: 'the \x1b[2Jcouncil', options: ['approve', 'reject'], message: `Council said \x1b]8;;http://x\x07click\x1b]8;;\x07 ${SECRET}` });
      const gate = await hooks.approveBuild({ summary: 'What was built:\n  1. \x1b[1mBold\x1b[0m title' });
      return { status: 'stopped', runId: 'r', buildDir: '/b', reason: `Stopped \x1b[5mblink\x1b[0m ${JSON.stringify(gate)}` };
    },
  };
  const { ctx, o, slug, config } = buildCtx({ deps });
  ctx.env = { X_TEST_API_KEY: SECRET };
  const before = process.env.X_TEST_API_KEY;
  process.env.X_TEST_API_KEY = SECRET;
  try {
    assert.equal(await FACTORY_COMMANDS.build(parseCli(['build', slug, '--config', config]), ctx), 1);
  } finally {
    if (before === undefined) delete process.env.X_TEST_API_KEY; else process.env.X_TEST_API_KEY = before;
  }
  // the bell before a question and the status redraw (\x1b[J, \x1b[<n>F) are the terminal's own
  const text = o.text().replaceAll('\x07', '').replaceAll('\x1b[J', '').replace(/\x1b\[\d+F/g, '');
  assert.doesNotMatch(text, /\x1b/, JSON.stringify(text));
  assert.ok(!text.includes(SECRET));
  assert.match(text, /Building step red with \[redacted\]/);
  assert.match(text, /1\. Bold title/);
  assert.match(text, /Stopped blink \{"stop":true\}/);
  assert.equal(seen[0].title, 'the council');
  assert.doesNotMatch(seen[0].message, /\x1b|\x07/);
  assert.ok(!seen[0].message.includes(SECRET));
});

test('final-fix 10: Ctrl-C during a build frees the project lock before Conductor exits', async () => {
  let lockAtExit = null;
  let projectDir;
  const deps = {
    prepareTeam: async ({ exit }) => { exit(130); return { code: 130 }; },   // what prepareTeam's Ctrl-C handler does
    runBuild: async () => ({ status: 'ready' }),
  };
  const c = buildCtx({ deps, exit: () => { lockAtExit = existsSync(path.join(projectDir, '.conductor.lock')); } });
  projectDir = c.projectDir;
  assert.equal(await FACTORY_COMMANDS.build(parseCli(['build', c.slug, '--config', c.config]), c.ctx), 130);
  assert.equal(lockAtExit, false, 'the lock was gone when exit ran');
});
