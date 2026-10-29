// test/helpers/changeFixtures.js — what every Plan 11 test needs: a foundation repo with release tags, a project whose
// app/ was cloned from it (as Plan 8's createApp leaves it), and recording stub deps. Never touches /root/highland-foundation.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { git } from '../../src/workspace.js';
import { makeRepo } from './gitRepo.js';
import { approvedBrief } from './briefFixtures.js';
import { writeJsonAtomic, writeFileAtomic } from '../../src/factory/fsAtomic.js';
import { briefPaths, currentBriefInfo, renderBrief } from '../../src/factory/brief.js';
import { newDeployment, saveDeployment, listDeployments as realListDeployments } from '../../src/factory/deployments/store.js';
import { DEP_NAMES } from '../../src/factory/change/seams.js';

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
const sync = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const SECURITY_LINES = { '0.1.1': ['- **[security]** Sessions now expire after 12 hours.', '- Tidier audit page.'] };

function changelogUpTo(versions) {
  const sections = versions.map((v) => `## [${v}] - 2026-10-${String(10 + versions.indexOf(v)).padStart(2, '0')}\n${(SECURITY_LINES[v] ?? [`- Release ${v}.`]).join('\n')}\n`);
  return `# Changelog\n\n## [Unreleased]\n\n${sections.reverse().join('\n')}`;
}

// A git repo with one annotated tag v<version> per version, oldest first.
export async function makeFoundation({ versions = ['0.1.0', '0.1.1'] } = {}) {
  const dir = await makeRepo({ 'README.md': 'foundation\n' });
  const done = [];
  for (const v of versions) {
    done.push(v);
    writeFileSync(path.join(dir, 'foundation.json'), JSON.stringify({ name: 'highland-foundation', version: v, commit: `v${v}` }, null, 2) + '\n');
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'highland-foundation', version: v, private: true }, null, 2) + '\n');
    writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'highland-foundation', version: v, lockfileVersion: 3, packages: { '': { name: 'highland-foundation', version: v } } }, null, 2) + '\n');
    writeFileSync(path.join(dir, 'CHANGELOG.md'), changelogUpTo(done));
    await git(dir, ['add', '-A']);
    await git(dir, [...ID, 'commit', '-q', '-m', `release: v${v}`]);
    await git(dir, [...ID, 'tag', '-a', `v${v}`, '-m', `v${v}`]);
  }
  return { dir, tagSha: (tag) => sync(dir, ['rev-parse', `${tag}^{commit}`]) };
}

// Writes brief-v<n>.json and points current.json at it in the format saveApprovedBrief writes.
export function writeBriefVersion(projectDir, n, brief = {}) {
  const p = briefPaths(projectDir);
  mkdirSync(p.dir, { recursive: true });
  const full = approvedBrief({ slug: path.basename(projectDir), client: 'Acme Ltd', revisedFrom: n > 1 ? n - 1 : null, ...brief, version: n });
  const text = `${JSON.stringify(full, null, 2)}\n`;
  writeFileAtomic(p.json(n), text);
  writeFileAtomic(p.md(n), renderBrief(full));
  writeJsonAtomic(p.current, {
    schema: 1, version: n, json: `brief-v${n}.json`, md: `brief-v${n}.md`,
    sha256: createHash('sha256').update(Buffer.from(text)).digest('hex'), approvedAt: full.approvedAt, approvedBy: full.approvedBy,
  });
  assert.equal(currentBriefInfo(projectDir).version, n, 'the brief fixture does not match the format Plan 7 reads');
  return full;
}

const DEPLOYMENT_BASE = {
  project: 'acme', host: 'acme-box', ssh: { user: 'highland', port: null, keyPath: null }, bundleDir: '/opt/highland/acme',
  hosting: 'client-box', imageDelivery: 'tar', registry: null, access: 'cloudflare-tunnel', origin: 'https://staff.acme.co.uk', site: ':80',
  alerts: { matrix: null, webhook: true, heartbeat: true },
};

// A projects root holding acme/ in the Contract 7.5 shape, with a real app repo cloned from the foundation.
export async function makeProject({ foundation, tag = 'v0.1.0', status = 'shipped', deployments = [], builtFromBrief = 1 } = {}) {
  const projectsRoot = mkdtempSync(path.join(tmpdir(), 'projects-'));
  const projectDir = path.join(projectsRoot, 'acme');
  const appDir = path.join(projectDir, 'app');
  mkdirSync(path.join(projectDir, 'notes'), { recursive: true });
  mkdirSync(path.join(projectDir, 'builds'), { recursive: true });

  // As Plan 8's createApp: clone at the tag, main, remote "foundation" with --no-tags, the release kept as refs/foundation/<tag>, no inherited tags.
  const commit = foundation.tagSha(tag);
  sync(projectDir, ['clone', '-q', '--no-hardlinks', '--branch', tag, foundation.dir, appDir]);
  sync(appDir, ['checkout', '-q', '-b', 'main']);
  sync(appDir, ['remote', 'rename', 'origin', 'foundation']);
  sync(appDir, ['config', 'remote.foundation.tagOpt', '--no-tags']);
  sync(appDir, ['config', 'user.name', 'Test']);
  sync(appDir, ['config', 'user.email', 'test@example.com']);
  sync(appDir, ['update-ref', `refs/foundation/${tag}`, commit]);
  for (const t of sync(appDir, ['for-each-ref', '--format=%(refname)', 'refs/tags']).split('\n').filter(Boolean)) sync(appDir, ['update-ref', '-d', t]);
  writeFileSync(path.join(appDir, 'app-profile.json'), JSON.stringify({ schema: 1, modules: ['ocr', 'xlsx-export'], policy: { outbound: [], residency: 'uk' } }, null, 2) + '\n');
  sync(appDir, ['add', '-A']);
  sync(appDir, ['commit', '-q', '-m', 'Name the app: Acme Ltd']);
  const main = sync(appDir, ['rev-parse', 'refs/heads/main']);

  writeJsonAtomic(path.join(projectDir, 'project.json'), {
    schema: 1, slug: 'acme', client: 'Acme Ltd', createdAt: '2026-10-20T08:00:00.000Z', status,
    foundation: { repo: foundation.dir, tag, commit },
    approved: { sha: main, at: '2026-10-20T09:00:00.000Z', runId: '20261020-090000-0a0b', briefVersion: builtFromBrief },
    builtFromBrief,
  });
  writeBriefVersion(projectDir, builtFromBrief);

  for (const d of deployments) {
    const { currentVersion = '0.1.0', foundation: fv = tag, ...rest } = d;
    const dep = newDeployment({ ...DEPLOYMENT_BASE, ...rest });
    saveDeployment(projectDir, { ...dep, setup: { step: 'done', at: '2026-10-21T09:00:00.000Z' }, currentVersion, foundation: fv, bundleVersion: currentVersion });
  }
  return {
    projectsRoot, projectDir, appDir,
    factory: { projectsRoot, foundation: { repo: foundation.dir, tag } },
  };
}

// Every DEP_NAMES entry as a recording stub, plus calls[] and a fixed clock. Overrides replace the stub (and are recorded too).
export function stubDeps(over = {}) {
  const calls = [];
  const defaults = {
    reviseBrief: async () => ({ status: 'failed', reason: 'stub' }),
    runBuild: async () => ({ status: 'failed', reason: 'stub' }),
    runProjectCouncil: async () => ({ status: 'failed', reason: 'stub' }),
    releaseApp: async () => ({ ok: false, reason: 'stub' }),
    updateDeployment: async () => ({ outcome: 'stub', message: 'stub' }),
    listDeployments: (root, opts) => realListDeployments(root, opts),
  };
  const deps = { calls, now: () => new Date('2026-10-27T14:32:05Z') };
  for (const name of DEP_NAMES) {
    const impl = name in over ? over[name] : defaults[name];
    deps[name] = typeof impl === 'function' ? (...args) => { calls.push({ name, args }); return impl(...args); } : impl;
  }
  for (const [k, v] of Object.entries(over)) if (!DEP_NAMES.includes(k)) deps[k] = v;
  return deps;
}
