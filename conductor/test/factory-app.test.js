import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createApp, nameApp, initialsOf, appProfileOf } from '../src/factory/app.js';
import { git } from '../src/workspace.js';
import { makeFoundationRepo, makeProject, sampleBrief } from './helpers/factoryFixtures.js';

const out = async (dir, args) => (await git(dir, args)).stdout.trim();

test('clones the tag onto a new main, keeps the foundation as a remote, records the commit', async () => {
  const repo = await makeFoundationRepo();
  const { projectDir } = makeProject();
  const r = await createApp({ projectDir, foundation: { repo, tag: 'v0.1.0' } });
  assert.equal(r.created, true);
  assert.equal(r.appDir, path.join(projectDir, 'app'));
  assert.equal(await out(r.appDir, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.equal(await out(r.appDir, ['rev-parse', 'HEAD']), r.commit);
  assert.equal(r.commit, await out(repo, ['rev-parse', 'v0.1.0^{commit}']));
  assert.equal(await out(r.appDir, ['remote']), 'foundation');
  assert.equal(await out(r.appDir, ['tag', '--list']), '', 'no foundation tag is kept as refs/tags/* (Contract 7 §7.11)');
  assert.equal(await out(r.appDir, ['config', '--get', 'remote.foundation.tagOpt']), '--no-tags');
  assert.equal(await out(r.appDir, ['rev-parse', 'refs/foundation/v0.1.0^{commit}']), r.commit);
  assert.deepEqual(readdirSync(projectDir).filter((n) => n.startsWith('app.partial')), [], 'no half-made clone left');
});

test('a second call reuses the app; a moved tag is refused', async () => {
  const repo = await makeFoundationRepo();
  const { projectDir } = makeProject();
  const first = await createApp({ projectDir, foundation: { repo, tag: 'v0.1.0' } });
  const again = await createApp({ projectDir, foundation: { repo, tag: 'v0.1.0' }, expectCommit: first.commit });
  assert.deepEqual([again.created, again.commit], [false, first.commit]);
  await assert.rejects(createApp({ projectDir, foundation: { repo, tag: 'v0.1.0' }, expectCommit: 'f'.repeat(40) }),
    /The foundation's tag v0\.1\.0 now points at a different commit than when this app was made/);
});

test('refuses a missing tag and a foundation.json that does not match the tag, leaving nothing behind', async () => {
  const repo = await makeFoundationRepo();
  const { projectDir } = makeProject();
  await assert.rejects(createApp({ projectDir, foundation: { repo, tag: 'v9.9.9' } }), /The foundation has no release v9\.9\.9/);
  const bad = await makeFoundationRepo({ extra: { 'foundation.json': '{"name":"highland-foundation","version":"0.0.9","commit":"v0.0.9"}' } });
  await assert.rejects(createApp({ projectDir, foundation: { repo: bad, tag: 'v0.1.0' } }), /foundation\.json says v0\.0\.9, not v0\.1\.0/);
  assert.equal(existsSync(path.join(projectDir, 'app')), false);
});

test('an https foundation is cloned with https allowed for that command only; ssh is never enabled', async () => {
  const calls = [];
  const fake = async (cwd, args) => { calls.push(args); return { code: 128, stdout: '', stderr: 'fatal: unable to access' }; };
  const { projectDir } = makeProject();
  await assert.rejects(createApp({ projectDir, foundation: { repo: 'https://git.example/hf.git', tag: 'v0.1.0' }, git: fake }),
    /Conductor could not copy the foundation from https:\/\/git\.example\/hf\.git/);
  const clone = calls.find((a) => a.includes('clone'));
  assert.deepEqual(clone.slice(0, 3), ['-c', 'protocol.https.allow=always', 'clone']);
  assert.equal(calls.flat().some((a) => /protocol\.ssh/.test(a)), false);
});

test('nameApp rewrites the BRAND line and writes app-profile.json in one commit, once', async () => {
  const repo = await makeFoundationRepo();
  const { projectDir } = makeProject();
  const { appDir } = await createApp({ projectDir, foundation: { repo, tag: 'v0.1.0' } });
  const brief = sampleBrief({ client: 'Acme "Office" Ltd', policy: { ...sampleBrief().policy, outbound: ['cloudflare-tunnel'] } });
  const sha = await nameApp({ appDir, brief });
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(readFileSync(path.join(appDir, 'apps/web/src/brand.ts'), 'utf8').split('\n')[1],
    'export const BRAND = { appName: "Acme \\"Office\\" Ltd", shortName: "AO" } as const;');
  assert.deepEqual(JSON.parse(readFileSync(path.join(appDir, 'app-profile.json'), 'utf8')),
    { schema: 1, modules: [], policy: { outbound: ['cloudflare-tunnel'], residency: 'uk' } });
  assert.equal(await out(appDir, ['log', '-1', '--format=%s']), 'Name the app: Acme "Office" Ltd');
  assert.deepEqual((await out(appDir, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort(), ['app-profile.json', 'apps/web/src/brand.ts']);
  assert.equal(await nameApp({ appDir, brief }), null);
});

test('appProfileOf copies only modules, outbound ids and residency from the brief', () => {
  assert.deepEqual(appProfileOf(sampleBrief()), { schema: 1, modules: [], policy: { outbound: [], residency: 'uk' } });
});

test('nameApp refuses a brand.ts without the expected line', async () => {
  const repo = await makeFoundationRepo({ extra: { 'apps/web/src/brand.ts': 'export default {};\n' } });
  const { projectDir } = makeProject();
  const { appDir } = await createApp({ projectDir, foundation: { repo, tag: 'v0.1.0' } });
  await assert.rejects(nameApp({ appDir, brief: sampleBrief() }), /does not have the expected BRAND line/);
  assert.equal(await out(appDir, ['status', '--porcelain']), '');
});

test('initials skip company suffixes', () => {
  assert.equal(initialsOf('Highland Automations Ltd'), 'HA');
  assert.equal(initialsOf('acme limited'), 'A');
  assert.equal(initialsOf('Smith, Jones & Brown LLP'), 'SJB');
  assert.equal(initialsOf('Ltd'), 'App');
});
