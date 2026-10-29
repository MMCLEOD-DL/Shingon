// Plan 11, Task 11: `conductor change` and `conductor foundation-upgrade` on the command line.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { PassThrough, Writable, Readable } from 'node:stream';
import { parseCli } from '../src/cli/args.js';
import { main, EXIT } from '../src/cli/main.js';
import { FACTORY_COMMANDS, runFactoryCommand } from '../src/cli/factory.js';
import { runChangeCommand, runUpgradeCommand, NO_TTY_CHANGE, INTERRUPTED_CHANGE } from '../src/cli/change.js';
import { lockProject } from '../src/factory/projectLock.js';
import { loadDeployment } from '../src/factory/deployments/store.js';
import { makeFoundation, makeProject, stubDeps, writeBriefVersion } from './helpers/changeFixtures.js';
import { writeStubCli } from './helpers/stubCli.js';

const cleanup = [];
after(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = mkdtempSync(path.join(tmpdir(), p)); cleanup.push(d); return d; };
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
const g = (dir, args) => execFileSync('git', ['-C', dir, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

function out() { let text = ''; return { stream: new Writable({ write(c, e, cb) { text += c; cb(); } }), text: () => text }; }

// A terminal that types each answer once its prompt is on screen.
function scripted(answers = []) {
  const input = new PassThrough();
  const queue = [...answers];
  let text = '';
  const stream = new Writable({ write(c, e, cb) {
    const s = c.toString();
    text += s;
    if (s.endsWith('> ') || s.endsWith('(one line): ')) setImmediate(() => (queue.length ? input.write(`${queue.shift()}\n`) : input.end()));
    cb();
  } });
  return { input, stream, text: () => text };
}

const pkg = (name, v) => `${JSON.stringify({ name, private: true, version: v }, null, 2)}\n`;
const NEW_FEATURE = { id: 'mileage-claims', title: 'Mileage claims', story: 'Staff claim their mileage.', roles: ['Staff'], data: ['Claim'],
  acceptance: [{ id: 'mileage-claims#1', given: 'Alice is signed in as Staff', when: 'she claims 10 miles on 3 March 2026', then: 'her claims list shows Mileage £4.50 dated 3 March 2026' }] };

// A shipped project on foundation v0.1.0 with its own 0.2.0 release and two deployments, plus a config and notes.
async function setup({ participants = [], routing = null } = {}) {
  const f = await makeFoundation();
  cleanup.push(f.dir);
  const p = await makeProject({ foundation: f, deployments: [{ name: 'acme-cloud', host: 'c', currentVersion: '0.2.0' }, { name: 'acme-office', host: 'o', currentVersion: '0.2.0' }] });
  cleanup.push(p.projectsRoot);
  writeFileSync(path.join(p.appDir, 'package.json'), pkg('acme-app', '0.2.0'));
  writeFileSync(path.join(p.appDir, 'package-lock.json'), `${JSON.stringify({ name: 'acme-app', version: '0.2.0', lockfileVersion: 3, packages: { '': { name: 'acme-app', version: '0.2.0' } } }, null, 2)}\n`);
  writeFileSync(path.join(p.appDir, 'foundation.json'), `${JSON.stringify({ name: 'highland-foundation', version: '0.2.0', commit: 'v0.1.0' }, null, 2)}\n`);
  writeFileSync(path.join(p.appDir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-10-20\n- The app.\n');
  g(p.appDir, ['add', '-A']);
  g(p.appDir, ['commit', '-q', '-m', 'release: v0.2.0']);
  g(p.appDir, ['tag', '-a', 'v0.2.0', '-m', 'v0.2.0']);
  const project = readJson(path.join(p.projectDir, 'project.json'));
  project.approved.sha = g(p.appDir, ['rev-parse', 'refs/heads/main']);
  writeFileSync(path.join(p.projectDir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  const cwd = tmp('cwd-');   // not a git repository
  writeFileSync(path.join(cwd, 'notes.md'), 'Acme want mileage claims.\n');
  const cfg = path.join(tmp('cfg-'), 'conductor.json');
  writeFileSync(cfg, JSON.stringify({ participants, ...(routing ? { routing } : {}), factory: { projectsRoot: p.projectsRoot } }));
  const env = { HOME: tmp('home-'), CONDUCTOR_BASE_DIR: tmp('base-'), XDG_CONFIG_HOME: tmp('xdg-'), XDG_CACHE_HOME: tmp('xdgc-'), PATH: process.env.PATH };
  return { ...p, f, cwd, cfg, env, notes: path.join(cwd, 'notes.md') };
}

// The stubs a whole change needs: brief v2 adds one feature, the build commits and asks the real gate, release, update.
function changeDeps(p, over = {}) {
  return stubDeps({
    reviseBrief: async ({ projectDir }) => {
      const v1 = readJson(path.join(projectDir, 'brief', 'brief-v1.json'));
      writeBriefVersion(projectDir, 2, { revisedFrom: 1, features: [...v1.features, NEW_FEATURE], exampleSeq: { ...v1.exampleSeq, 'mileage-claims': 1 } });
      return { status: 'approved', version: 2 };
    },
    runBuild: async ({ hooks, options }) => {
      const { runId, baseRef } = options.change;
      const branch = `build/${runId}`;
      g(p.appDir, ['checkout', '-q', '-b', branch, `refs/heads/${baseRef}`]);
      writeFileSync(path.join(p.appDir, 'mileage.ts'), 'export const mileage = 1;\n');
      g(p.appDir, ['add', '-A']);
      g(p.appDir, ['commit', '-q', '-m', 'mileage claims']);
      const sha = g(p.appDir, ['rev-parse', 'HEAD']);
      writeFileSync(path.join(p.projectDir, 'builds', runId, 'council-report.json'), JSON.stringify({ runId, sha, verdict: 'approved', round: 1 }));
      g(p.appDir, ['checkout', '-q', 'main']);
      const answer = await hooks.approveBuild({ summary: 'The change is built.', sha, branch, runId, council: { status: 'approved', sha }, checks: { sha } });
      if (answer === true) return { status: 'approved', runId, sha, branch };
      return { status: 'rejected', runId, reason: 'You did not approve the build.' };
    },
    releaseApp: async () => {
      const a = p.appDir;
      for (const file of ['package.json', 'package-lock.json', 'foundation.json']) {
        const j = readJson(path.join(a, file));
        j.version = '0.3.0';
        if (j.packages?.['']) j.packages[''].version = '0.3.0';
        writeFileSync(path.join(a, file), `${JSON.stringify(j, null, 2)}\n`);
      }
      writeFileSync(path.join(a, 'CHANGELOG.md'), readFileSync(path.join(a, 'CHANGELOG.md'), 'utf8').replace('## [Unreleased]\n', '## [Unreleased]\n\n## [0.3.0] - 2026-10-28\n'));
      g(a, ['add', '-A']);
      g(a, ['commit', '-q', '-m', 'release: v0.3.0']);
      g(a, ['tag', '-a', 'v0.3.0', '-m', 'v0.3.0']);
      return { ok: true, version: '0.3.0', sha: g(a, ['rev-parse', 'refs/heads/main']), tag: 'v0.3.0' };
    },
    updateDeployment: async () => ({ outcome: 'updated', message: 'Updated.' }),
    runProjectCouncil: async () => ({ status: 'approved', text: 'ok' }),
    ...over,
  });
}

const fakeTeam = (seen = []) => async (a) => { seen.push(a); return { built: { team: { author: {}, reviewer: {}, local: {} }, warnings: [] }, hooks: {}, overrides: {}, remember: () => {} }; };
const fakeAuthor = async () => ({ ok: true, seat: { name: 'claude' }, warnings: [] });

function run(argv, p, { isTTY = true, deps = {}, stdin = Readable.from([]), stdout, onSignal = () => {}, exit = () => {} } = {}) {
  return runFactoryCommand(parseCli([...argv, '--config', p.cfg, '--no-bell']), { cwd: p.cwd, env: p.env, stdin, stdout, isTTY, onSignal, exit, deps });
}

// Real stub CLIs for prepareTeam and the brief seat: claude and codex answer --version, the local model answers on 127.0.0.1.
async function realModels() {
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[]}'); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const bins = tmp('bins-');
  const claude = writeStubCli(bins, 'claude', "if (args[0] === '--version') { console.log('2.1.0 (Claude Code)'); process.exit(0); } process.exit(1);");
  const codex = writeStubCli(bins, 'codex', "if (args[0] === '--version') { console.log('codex-cli 0.163.0'); process.exit(0); } process.exit(1);");
  const participants = [
    { name: 'claude', adapter: 'claude-code', bin: claude, roles: ['author', 'reviewer'], capabilities: { is_agentic: true, can_edit_files: true } },
    { name: 'codex', adapter: 'codex', bin: codex, roles: ['author', 'reviewer'], capabilities: { is_agentic: true, can_edit_files: true } },
    { name: 'local', adapter: 'local-agent', bin: codex, model: 'm', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, roles: ['grunt'], capabilities: { is_agentic: true, can_edit_files: true } },
  ];
  return { participants, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

test('change and foundation-upgrade are FACTORY_COMMANDS handlers', () => {
  assert.equal(FACTORY_COMMANDS.change, runChangeCommand);
  assert.equal(FACTORY_COMMANDS['foundation-upgrade'], runUpgradeCommand);
});

test('no terminal: change refuses before checking models or touching the project', async () => {
  const p = await setup();
  const deps = changeDeps(p);
  const seen = [];
  for (const argv of [['change', 'acme', '--notes', p.notes], ['change', 'acme', '--resume'], ['foundation-upgrade', 'acme', '--to', 'v0.1.1'], ['foundation-upgrade', 'acme', '--resume']]) {
    const o = out();
    const code = await run(argv, p, { isTTY: false, stdout: o.stream, deps: { change: deps, prepareTeam: fakeTeam(seen) } });
    assert.equal(code, EXIT.stopped, argv.join(' '));
    assert.match(o.text(), new RegExp(escape(NO_TTY_CHANGE)));
  }
  assert.equal(readdirSync(path.join(p.projectDir, 'builds')).length, 0);
  assert.equal(seen.length, 0, 'no model was checked');
  assert.equal(deps.calls.length, 0);
  assert.equal(existsSync(path.join(p.projectDir, '.conductor.lock')), false, 'the lock was released');
});

test('--check works without a terminal and outside any git repository', async () => {
  const p = await setup();
  const o = out();
  const code = await main(['foundation-upgrade', '--check', '--config', p.cfg], { cwd: p.cwd, env: p.env, stdout: o.stream, isTTY: false });
  assert.equal(code, 0, o.text());
  assert.match(o.text(), /Newest foundation release: v0\.1\.1\./);
  assert.match(o.text(), /acme\n {2}code: on v0\.1\.0, missing 1 security fix/);
  assert.match(o.text(), / {2}acme-cloud: on v0\.1\.0, missing 1 security fix/);
});

test('--check: a row that could not be checked exits 1; a listing that throws is a plain message', async () => {
  const p = await setup();
  const project = readJson(path.join(p.projectDir, 'project.json'));
  project.foundation.repo = path.join(p.cwd, 'no-such-repo');
  writeFileSync(path.join(p.projectDir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  const o = out();
  assert.equal(await run(['foundation-upgrade', '--check'], p, { isTTY: false, stdout: o.stream, deps: { change: changeDeps(p) } }), 1);
  assert.match(o.text(), /could not check/);
  const notADir = path.join(p.cwd, 'notes.md');
  writeFileSync(p.cfg, JSON.stringify({ participants: [], factory: { projectsRoot: notADir } }));
  const t = out();
  assert.equal(await run(['foundation-upgrade', '--check'], p, { isTTY: false, stdout: t.stream, deps: { change: changeDeps(p) } }), EXIT.failed);
  assert.match(t.text(), /Conductor could not check the projects in .*notes\.md: ENOTDIR/);
  assert.doesNotMatch(t.text(), /at .*\.js:\d+/, 'no stack trace');
});

test('the handler takes the project lock: a running build makes change refuse plainly, before any model is checked (Contract 7 §7.11)', async () => {
  const p = await setup();
  const deps = changeDeps(p);
  const seen = [];
  const release = lockProject(p.projectDir, 'build');
  try {
    for (const argv of [['change', 'acme', '--notes', p.notes], ['foundation-upgrade', 'acme', '--abandon']]) {
      const o = out();
      assert.equal(await run(argv, p, { stdout: o.stream, deps: { change: deps, prepareTeam: fakeTeam(seen) } }), 1);
      assert.match(o.text(), /This project is busy: a build is running/);
    }
  } finally { release(); }
  assert.equal(seen.length, 0);
  assert.equal(deps.calls.length, 0);
  assert.equal(readdirSync(path.join(p.projectDir, 'builds')).length, 0);
});

test('a missing dep is reported plainly and nothing starts', async () => {
  const p = await setup();
  const deps = changeDeps(p);
  delete deps.releaseApp;
  const o = out();
  assert.equal(await run(['change', 'acme', '--notes', p.notes], p, { stdout: o.stream, deps: { change: deps, prepareTeam: fakeTeam() } }), 2);
  assert.match(o.text(), /missing parts it needs for changes \(releaseApp\)/);
  assert.equal(readdirSync(path.join(p.projectDir, 'builds')).length, 0);
});

test('an unknown project is a plain usage error', async () => {
  const p = await setup();
  const o = out();
  assert.equal(await run(['change', 'nobody', '--resume'], p, { stdout: o.stream, deps: { change: changeDeps(p) } }), EXIT.usage);
  assert.match(o.text(), /nobody/);
  assert.doesNotMatch(o.text(), /at .*\.js:\d+/);
});

test('an unreadable notes file is a plain usage error before any model is checked', async () => {
  const p = await setup();
  const seen = [];
  const o = out();
  assert.equal(await run(['change', 'acme', '--notes', 'missing.md'], p, { stdout: o.stream, deps: { change: changeDeps(p), prepareTeam: fakeTeam(seen) } }), EXIT.usage);
  assert.match(o.text(), /The notes file missing\.md could not be read\./);
  assert.equal(seen.length, 0);
  assert.equal(existsSync(path.join(p.projectDir, '.conductor.lock')), false);
});

test('change end to end with stubs and a scripted terminal: exit 0, the report printed', async () => {
  const models = await realModels();
  try {
    const p = await setup({ participants: models.participants });
    const deps = changeDeps(p);
    const t = scripted(['a']);
    const code = await run(['change', 'acme', '--notes', 'notes.md'], p, { stdin: t.input, stdout: t.stream, deps: { change: deps } });
    assert.equal(code, 0, t.text());
    assert.match(t.text(), /Checking which AI models are available/, 'Plan 8\'s prepareTeam ran');
    assert.match(t.text(), /\[a\] approve → add to the app and update 2 deployments · /);
    assert.match(t.text(), /The app is now version 0\.3\.0\./);
    const revise = deps.calls.find((c) => c.name === 'reviseBrief').args[0];
    assert.equal(revise.author.name, 'claude', 'the brief seat is Plan 7\'s frontier author');
    assert.equal(revise.notesFile, path.join(p.cwd, 'notes.md'), 'the notes are read from the folder the command ran in');
    assert.equal(typeof revise.io.ask, 'function');
    assert.equal(typeof revise.io.approve, 'function');
    assert.deepEqual(deps.calls.filter((c) => c.name === 'updateDeployment').map((c) => c.args[0].name), ['acme-cloud', 'acme-office']);
    assert.equal(readJson(path.join(p.projectDir, 'project.json')).builtFromBrief, 2);
    assert.equal(existsSync(path.join(p.projectDir, '.conductor.lock')), false);
  } finally { await models.close(); }
});

test('Ctrl-C while an update runs calls Plan 10\'s interruptShip with the shared ship state', async () => {
  const models = await realModels();
  try {
    const p = await setup({ participants: models.participants });
    const handlers = [];
    const exits = [];
    let lockAtExit = null;
    const deps = changeDeps(p, {
      updateDeployment: async ({ projectDir, name, version, foundation, runId }, { state }) => {
        if (!handlers.length || exits.length) return { outcome: 'updated', message: 'Updated.' };
        Object.assign(state, { phase: 'updating', projectDir, name, version, foundation, runId, dep: loadDeployment(projectDir, name) });
        handlers.at(-1)();
        return { outcome: 'updated', message: 'Updated.' };
      },
    });
    const t = scripted(['a']);
    await run(['change', 'acme', '--notes', p.notes], p, {
      stdin: t.input, stdout: t.stream, deps: { change: deps },
      onSignal: (h) => handlers.push(h),
      exit: (code) => { exits.push(code); lockAtExit = existsSync(path.join(p.projectDir, '.conductor.lock')); },
    });
    assert.equal(handlers.length, 1, 'one Ctrl-C handler for the whole command (prepareTeam\'s)');
    assert.deepEqual(exits, [130]);
    assert.equal(lockAtExit, false, 'the project lock is freed before the process exits');
    const text = t.text();
    const watching = text.indexOf('Stopped watching. The update carries on by itself on the box.');
    const stopped = text.indexOf(INTERRUPTED_CHANGE('acme', 'change'));
    assert.ok(watching >= 0 && stopped > watching, text);
    assert.equal(loadDeployment(p.projectDir, 'acme-cloud').pendingCheck.why, 'interrupted');
  } finally { await models.close(); }
});

test('Ctrl-C before the change starts says nothing was changed and frees the lock', async () => {
  const p = await setup();
  const exits = [];
  const o = out();
  const prepare = async ({ exit }) => { exit(EXIT.interrupted); return { code: EXIT.interrupted }; }; // as prepareTeam's handler does mid-check
  const code = await run(['change', 'acme', '--notes', p.notes], p, { stdout: o.stream, deps: { change: changeDeps(p), prepareTeam: prepare }, exit: (c) => exits.push(c) });
  assert.equal(code, EXIT.interrupted);
  assert.deepEqual(exits, [130]);
  assert.match(o.text(), /Stopped before anything started\. Nothing was changed\./);
  assert.equal(existsSync(path.join(p.projectDir, '.conductor.lock')), false);
});

test('--abandon works without a terminal and says what it left', async () => {
  const p = await setup();
  const deps = changeDeps(p, { reviseBrief: async () => ({ status: 'paused', reason: 'The brief is waiting for your answers.' }) });
  assert.equal(await run(['change', 'acme', '--notes', p.notes], p, { stdout: out().stream, deps: { change: deps, prepareTeam: fakeTeam(), buildAuthor: fakeAuthor } }), EXIT.paused);
  const o = out();
  assert.equal(await run(['change', 'acme', '--abandon'], p, { isTTY: false, stdout: o.stream, deps: { change: deps } }), 0);
  assert.match(o.text(), /You dropped the change \d{8}-\d{6}-[0-9a-f]{4}\. Nothing reached the app's main line\./);
  const again = out();
  assert.equal(await run(['foundation-upgrade', 'acme', '--abandon'], p, { isTTY: false, stdout: again.stream, deps: { change: deps } }), EXIT.stopped);
  assert.match(again.text(), /There is no unfinished change for this project\./);
});

test('the outcome maps to the exit code: rejected 1, stopped 1, failed 2, paused 3', async () => {
  const cases = [
    ['rejected', { runBuild: async ({ options }) => ({ status: 'rejected', runId: options.change.runId, reason: 'You did not approve the build.' }) }, EXIT.rejected, /You did not approve the change/],
    ['stopped', { reviseBrief: async () => ({ status: 'stopped', reason: 'You stopped the brief.' }) }, EXIT.stopped, /You stopped the brief\./],
    ['failed', { reviseBrief: async () => ({ status: 'failed', reason: 'The brief failed.' }) }, EXIT.failed, /The brief failed\./],
    ['paused', { reviseBrief: async () => ({ status: 'paused', reason: 'The brief paused.' }) }, EXIT.paused, /The brief paused\./],
  ];
  for (const [name, over, code, re] of cases) {
    const p = await setup();
    const o = out();
    const got = await run(['change', 'acme', '--notes', p.notes], p, { stdout: o.stream, deps: { change: changeDeps(p, over), prepareTeam: fakeTeam(), buildAuthor: fakeAuthor } });
    assert.equal(got, code, `${name}: ${o.text()}`);
    assert.match(o.text(), re, name);
  }
});

test('the team is prepared as Plan 8 builds it, and its hooks, options and usage memory reach the pipeline', async () => {
  const p = await setup();
  let remembered = 0;
  const seenPrepare = [];
  const deps = changeDeps(p, { runBuild: async ({ options, hooks }) => ({ status: 'paused', runId: options.change.runId, reason: `opts ${options.approvePlan} ${options.planRounds} ${typeof hooks.extra}` }) });
  const prepare = async (a) => {
    seenPrepare.push(a);
    return { built: { team: { author: { name: 'x' } }, warnings: ['w'] }, hooks: { extra: () => {} }, overrides: { approvePlan: true }, remember: () => { remembered += 1; } };
  };
  writeFileSync(p.cfg, JSON.stringify({ participants: [], options: { planRounds: 4 }, factory: { projectsRoot: p.projectsRoot } }));
  const o = out();
  const code = await run(['change', 'acme', '--notes', p.notes], p, { stdout: o.stream, deps: { change: deps, prepareTeam: prepare, buildAuthor: fakeAuthor } });
  assert.equal(code, EXIT.paused, o.text());
  assert.match(o.text(), /opts true 4 function/);
  assert.equal(remembered, 1);
  assert.equal(seenPrepare[0].env, p.env);
  assert.equal(typeof seenPrepare[0].term.say, 'function', 'the real terminal is handed to prepareTeam');
  assert.equal(deps.calls.find((c) => c.name === 'runBuild').args[0].team.author.name, 'x');
});

test('a foundation upgrade from the command line reaches the pipeline with its tag', async () => {
  const p = await setup();
  const deps = changeDeps(p, { runBuild: async ({ options }) => ({ status: 'paused', runId: options.change.runId, reason: 'Paused at the build.' }) });
  const o = out();
  const code = await run(['foundation-upgrade', 'acme', '--to', 'v0.1.1'], p, { stdout: o.stream, deps: { change: deps, prepareTeam: fakeTeam(), buildAuthor: async () => { throw new Error('no brief seat for an upgrade'); } } });
  assert.equal(code, EXIT.paused, o.text());
  assert.match(o.text(), /Paused at the build\./);
  const runs = readdirSync(path.join(p.projectDir, 'builds'));
  assert.equal(runs.length, 1);
  assert.equal(readJson(path.join(p.projectDir, 'builds', runs[0], 'change.json')).kind, 'foundation-upgrade');
});
