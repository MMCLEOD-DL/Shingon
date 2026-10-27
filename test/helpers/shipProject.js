// test/helpers/shipProject.js
// A project folder shaped like one ready to ship (Contract 7 §7.5), with a real app repo (released or fresh),
// and a stub machine provider (Contract 7 §7.8). Local git runs for real on temporary repos; nothing remote is touched.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeJsonAtomic } from '../../src/factory/fsAtomic.js';
import { projectDir as projectDirOf } from '../../src/factory/projects.js';
import { writeStubCli } from './stubCli.js';

export const RUN_ID = '20261027-100000-a1b2';

export const TEST_BRIEF = {
  client: 'Acme Ltd',
  policy: {
    hosting: 'client-box', outbound: ['cloudflare-tunnel'], residency: 'uk',
    retention: { text: '6 years', days: 2190 },
    backupDestination: { kind: 'client-owned', detail: "A NAS in the client's office" },
    operatorAccess: true,
  },
};

const GIT_ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function writeFiles(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
}

function commit(dir, files, message) {
  writeFiles(dir, files);
  git(dir, ['add', '-A']);
  git(dir, [...GIT_ID, 'commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

const pkg = (name, version) => JSON.stringify({ name, version, private: true, scripts: { images: 'true', bundle: 'true' } }, null, 2) + '\n';
const foundationJson = (version) => JSON.stringify({ name: 'highland-foundation', version, commit: 'v0.1.0' }, null, 2) + '\n';
const FOUNDATION_CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-26\n- First foundation release.\n';

// released: false → a fresh app as Plan 8's createApp leaves it (approved.sha = "Name the app");
// released: true → feature work (approved.sha) followed by the release commit and its annotated tag, as releaseApp leaves it.
export function makeShipProject(root, { slug = 'acme', version = '0.1.3', approve = true, released = true } = {}) {
  const projectDir = projectDirOf(root, slug);
  const appDir = path.join(projectDir, 'app');
  mkdirSync(appDir, { recursive: true });
  git(appDir, ['init', '-q', '-b', 'main']);
  // The foundation commit, without its v0.1.0 tag (Plan 8's createApp deletes inherited tags, Contract 7 §7.11).
  const foundationCommit = commit(appDir, {
    'package.json': pkg('highland-foundation', '0.1.0'),
    'foundation.json': foundationJson('0.1.0'),
    'apps/web/src/brand.ts': "export const BRAND = { appName: 'Highland App', shortName: 'HA' } as const;\n",
    'CHANGELOG.md': FOUNDATION_CHANGELOG,
  }, 'foundation');
  let sha = commit(appDir, { 'apps/web/src/brand.ts': "export const BRAND = { appName: 'Acme Ltd', shortName: 'AL' } as const;\n" }, 'Name the app: Acme Ltd');
  if (released) {
    sha = commit(appDir, { 'package.json': pkg(slug, version), 'apps/web/src/feature.ts': 'export const feature = true;\n' }, 'Feature work');
    commit(appDir, {
      'foundation.json': foundationJson(version),
      'CHANGELOG.md': FOUNDATION_CHANGELOG.replace('## [Unreleased]\n', `## [Unreleased]\n\n## [${version}] - 2026-10-27\n- Feature work.\n`),
    }, `release: v${version}`);
    git(appDir, [...GIT_ID, 'tag', '-a', `v${version}`, '-m', `v${version}`]);
  }

  writeJsonAtomic(path.join(projectDir, 'project.json'), {
    schema: 1, slug, client: 'Acme Ltd', createdAt: '2026-10-27T09:00:00.000Z', status: 'ready', builtFromBrief: 1,
    foundation: { repo: '/f', tag: 'v0.1.0', commit: foundationCommit },
    approved: approve ? { sha, at: '2026-10-27T10:00:00.000Z', runId: RUN_ID, briefVersion: 1 } : null,
  });
  return { projectsRoot: root, projectDir, appDir, sha };
}

// Sets project.json's approved.sha (Plan 7's writeJsonAtomic), keeping the rest of the approval.
export function approve(p, sha) {
  const file = path.join(p.projectDir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8'));
  project.approved = { at: '2026-10-27T11:00:00.000Z', runId: RUN_ID, briefVersion: 1, ...project.approved, sha };
  writeJsonAtomic(file, project);
  p.sha = sha;
}

// A stub `npm` modelled on the foundation's scripts/release.ts (v0.1.0): `ci` succeeds; `run release -- <bump>` refuses
// as the foundation does (dirty tree, no v* tags, empty Unreleased, clashing tag), otherwise raises the version, moves
// the Unreleased lines under a dated section, stamps package.json and foundation.json, commits "release: v<x>" and adds
// an annotated tag. With mainBump set, it first commits to that repo's main (main moving during the release).
export function fakeNpm(dir, { mainBump = null } = {}) {
  const binDir = path.join(dir, 'fake-npm-bin');
  const callsFile = path.join(dir, 'npm-calls.jsonl');
  writeStubCli(binDir, 'npm', String.raw`
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\n');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const refuse = (m) => { console.error(m); process.exit(1); };
if (args[0] === 'ci') process.exit(0);
if (args[0] !== 'run' || args[1] !== 'release' || args[2] !== '--') refuse('fake npm: unexpected ' + args.join(' '));
const bump = args[3];
if (!['major', 'minor', 'patch'].includes(bump)) refuse('Say which kind of release this is: first (only once, for the very first release), patch, minor or major. For example: npm run release -- minor');
const mainBump = ${JSON.stringify(mainBump)};
if (mainBump) execFileSync('git', ['-C', mainBump, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'moved']);
console.log('> highland-foundation@0.1.0 release\n> tsx scripts/release.ts ' + bump + '\n');
if (git('status', '--porcelain').trim() !== '') refuse('Commit or stash your changes first.');
if (git('tag', '--list', 'v*').trim() === '') refuse('No release has been made yet. Make the first one with: npm run release -- first');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const found = JSON.parse(fs.readFileSync('foundation.json', 'utf8'));
if (found.version !== pkg.version) refuse('foundation.json says ' + found.version + ' but package.json says ' + pkg.version + '. They must match before a release; fix whichever is wrong.');
const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
const parts = changelog.split(/^(?=## \[)/m);
const at = parts.findIndex((p) => /^## \[Unreleased\]/.test(p));
const body = at < 0 ? '' : parts[at].split('\n').slice(1).join('\n').trim();
if (body === '') refuse('There is nothing under "Unreleased" in CHANGELOG.md, so there is nothing to release.');
let [ma, mi, pa] = pkg.version.split('.').map(Number);
if (bump === 'major') { ma += 1; mi = 0; pa = 0; } else if (bump === 'minor') { mi += 1; pa = 0; } else pa += 1;
const v = ma + '.' + mi + '.' + pa;
if (git('tag', '--list', 'v' + v).trim() !== '') refuse('The tag v' + v + ' already exists, so this release would overwrite it. Remove the tag if it is a mistake, or choose a different kind of release.');
const after = parts.slice(at + 1).join('');
fs.writeFileSync('CHANGELOG.md', parts.slice(0, at).join('') + '## [Unreleased]\n\n## [' + v + '] - 2026-10-27\n' + body + '\n' + (after === '' ? '' : '\n' + after));
fs.writeFileSync('package.json', JSON.stringify({ ...pkg, version: v }, null, 2) + '\n');
fs.writeFileSync('foundation.json', JSON.stringify({ ...found, version: v, commit: 'v' + v }, null, 2) + '\n');
git('commit', '-qam', 'release: v' + v);
git('tag', '-a', 'v' + v, '-m', 'v' + v);
console.log('Released v' + v + ' on this machine. Nothing has been pushed: when you are happy, run "git push --follow-tags".');
`);
  return {
    binDir,
    env: (base = process.env) => ({ ...base, PATH: `${binDir}${path.delimiter}${base.PATH ?? ''}` }),
    calls: () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

export function fakeProvider({ host = 'hf-build', user = 'hf' } = {}) {
  let released = 0;
  const acquired = [];
  return {
    async acquire(args) {
      acquired.push(args);
      const { purpose, projectSlug: slug, runId } = args;
      return {
        id: 'm1', host,
        ssh: { user, keyPath: null, knownHostsFile: null, hostKeyPolicy: 'yes' },
        labels: { factory: 'hf', project: slug, run: runId, purpose, createdAt: '2026-10-27T10:00:00.000Z' },
        provider: 'static',
        runDir: `/srv/hf/runs/hf-${slug}-${runId}`,
        composeProject: `hf-${slug}-${runId}`,
        previewPort: null,
        release: async () => { released += 1; },
      };
    },
    released: () => released,
    acquired: () => acquired,
  };
}
