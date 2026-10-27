// test/helpers/shipProject.js
// A project folder shaped like one ready to ship (Contract 7 §7.5), with a real app repo carrying a release tag,
// and a stub machine provider (Contract 7 §7.8). Local git runs for real on temporary repos; nothing remote is touched.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeJsonAtomic } from '../../src/factory/fsAtomic.js';
import { projectDir as projectDirOf } from '../../src/factory/projects.js';

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

export function makeShipProject(root, { slug = 'acme', version = '0.1.3', approve = true } = {}) {
  const projectDir = projectDirOf(root, slug);
  const appDir = path.join(projectDir, 'app');
  mkdirSync(appDir, { recursive: true });
  git(appDir, ['init', '-q', '-b', 'main']);
  // The foundation commit, without its v0.1.0 tag (Plan 8's createApp deletes inherited tags, Contract 7 §7.11).
  const foundationCommit = commit(appDir, {
    'package.json': pkg('highland-foundation', '0.1.0'),
    'apps/web/src/brand.ts': "export const BRAND = { appName: 'Highland App', shortName: 'HA' } as const;\n",
    'CHANGELOG.md': '# Changelog\n\n## 0.1.0 - 2026-10-01\n\n- First release.\n',
  }, 'foundation');
  commit(appDir, { 'apps/web/src/brand.ts': "export const BRAND = { appName: 'Acme Ltd', shortName: 'AL' } as const;\n" }, 'Name the app');
  const sha = commit(appDir, { 'package.json': pkg(slug, '0.1.0'), 'apps/web/src/feature.ts': 'export const feature = true;\n' }, 'Feature work');
  commit(appDir, { 'package.json': pkg(slug, version) }, `release: v${version}`);
  git(appDir, [...GIT_ID, 'tag', '-a', `v${version}`, '-m', `v${version}`]);

  writeJsonAtomic(path.join(projectDir, 'project.json'), {
    schema: 1, slug, client: 'Acme Ltd', createdAt: '2026-10-27T09:00:00.000Z', status: 'ready', builtFromBrief: 1,
    foundation: { repo: '/f', tag: 'v0.1.0', commit: foundationCommit },
    approved: approve ? { sha, at: '2026-10-27T10:00:00.000Z', runId: RUN_ID, briefVersion: 1 } : null,
  });
  return { projectsRoot: root, projectDir, appDir, sha };
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
