// src/factory/ship/release.js
// Cutting app releases (Contract 7 §7.6, §7.11). releaseApp runs the app's own `npm run release -- <bump>` in a scratch
// clone of main, then moves the app repo's main by compare-and-swap and adds the tag. approvedRelease finds the release
// for project.json's approved build, or cuts the app's first one. Every v* tag in an app repo is an app release
// (foundation releases live at refs/foundation/vX.Y.Z). Never trusts foundation.json for the foundation's version:
// v0.1.0's release script stamps the app's version into it.
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProject } from '../projects.js';
import { RUN_ID_RE } from '../ids.js';
import { parseVersion, compareVersions } from '../foundationLog.js';
import { runCommand } from '../../exec.js';
import { childEnv, strictChildEnv, redact } from '../../secrets.js';
import { findBin } from '../../council/tools.js';
import { RELEASE_FILES } from './releaseContent.js';

// Ruling S20's set of release files, exported for Plan 11 (src/factory/change/mainline.js).
export { RELEASE_FILES };

export const RELEASE_BUMPS = Object.freeze(['first', 'minor', 'patch']);
// Contract 7 §7.11: the app's first release is 1.0.0, made with the foundation's `major` (its `first` would only re-tag 0.1.0).
export const FIRST_RELEASE_NPM_BUMP = 'major';

const UNRELEASED_NAME = 'highland-foundation';
const NPM_CI_TIMEOUT_MS = 15 * 60 * 1000;
const NPM_RELEASE_TIMEOUT_MS = 10 * 60 * 1000;
const SHA_RE = /^[0-9a-f]{40}$/;
const GIT_LOCATION_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];
const DEFAULT_IDENTITY = { name: 'Conductor', email: 'conductor@localhost' };

const NOT_EXPECTED = 'The app\'s release script did not leave the release Conductor expected, so nothing was added.';
const NO_APP = 'The project has no app yet, so there is nothing to release.';

const short = (sha) => String(sha).slice(0, 7);

// A plain x.y.z (no pre-release, no build metadata), or null.
function plainVersion(s) {
  const v = parseVersion(s);
  return v && s === `${v.major}.${v.minor}.${v.patch}` ? s : null;
}

function gitRunner(run, gitBin, env) {
  const genv = childEnv({ env });
  for (const k of GIT_LOCATION_ENV) delete genv[k]; // git must work on the repo named by -C, never one the caller's env points at
  const git = (dir, args, opts = {}) => run({ cmd: gitBin, args: ['-C', dir, ...args], env: genv, ...opts });
  const out = async (dir, args) => {
    const r = await git(dir, args);
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const ok = async (dir, args) => (await git(dir, args)).code === 0;
  return { git, out, ok };
}

async function readPackageAt(g, dir, rev) {
  const text = await g.out(dir, ['show', `${rev}:package.json`]);
  if (text === null) return null;
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}

// The last line a tool said, preferring stderr and skipping npm's own "npm error"/"npm warn" lines.
function lastLine(r) {
  const pick = (s) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !/^npm (error|ERR!|warn|WARN|notice)\b/.test(l)).pop();
  const line = pick(r.stderr) ?? pick(r.stdout);
  if (line) return String(redact(line)).replace(/\.+$/, '');
  return r.timedOut ? 'it took too long and was stopped' : 'it gave no reason';
}

export async function findRelease(appDir, sha, { env = process.env, run = runCommand } = {}) {
  const gitBin = findBin('git', { env });
  if (!gitBin) return null;
  const g = gitRunner(run, gitBin, env);
  const listed = await g.out(appDir, ['tag', '--list', 'v*', '--format=%(refname:short) %(objectname) %(*objectname)']);
  if (!listed) return null;
  let best = null;
  for (const line of listed.split('\n')) {
    const [tag, object, peeled] = line.trim().split(/\s+/);
    if (!tag || !tag.startsWith('v')) continue;
    const version = plainVersion(tag.slice(1));
    if (!version) continue;
    const commit = peeled || object;
    if (!SHA_RE.test(commit ?? '')) continue;
    if (!(await g.ok(appDir, ['merge-base', '--is-ancestor', sha, commit]))) continue;
    if (!(await g.ok(appDir, ['merge-base', '--is-ancestor', commit, 'refs/heads/main']))) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { sha: commit, version, tag };
  }
  return best;
}

async function identityOf(g, appDir) {
  const name = await g.out(appDir, ['config', 'user.name']);
  const email = await g.out(appDir, ['config', 'user.email']);
  return name && email ? { name, email } : DEFAULT_IDENTITY;
}

// expectedMain (optional): the main commit the caller checked; releaseApp refuses when its own read differs.
export async function releaseApp({ projectDir, bump, runId, expectedMain = null } = {}, { env = process.env, run = runCommand } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (!RELEASE_BUMPS.includes(bump)) return no(`"${bump}" is not a kind of release Conductor makes (first, minor or patch).`);
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return no(`"${runId}" is not a run id.`);
  const gitBin = findBin('git', { env });
  if (!gitBin) return no('Conductor needs git on this machine to make a release, and it is not installed.');
  const npmBin = findBin('npm', { env });
  if (!npmBin) return no('Conductor needs npm on this machine to make a release, and it is not installed.');

  let project;
  try { project = loadProject(projectDir); } catch (e) { return no(e.message); }
  const appDir = path.join(projectDir, 'app');
  if (!existsSync(appDir)) return no(NO_APP);
  const g = gitRunner(run, gitBin, env);
  const main = await g.out(appDir, ['rev-parse', '--verify', '-q', 'refs/heads/main']);
  if (!main || !SHA_RE.test(main)) return no(NO_APP);
  if (expectedMain !== null && main !== expectedMain) {
    return no('The app\'s main branch moved before the release could start, so the release was not made. Run it again.');
  }
  const identity = await identityOf(g, appDir);

  // 3. Adopt a release that already happened: main moved but the tag was never added (a crash). Ruling S5: only when
  // the tag is missing; with the tag present, the ordinary rules below apply.
  const pkgAtMain = await readPackageAt(g, appDir, main);
  if (!pkgAtMain) return no('The app\'s package.json could not be read, so a release cannot be made.');
  const subject = await g.out(appDir, ['log', '-1', '--format=%s', main]);
  const adopted = /^release: v(\d+\.\d+\.\d+)$/.exec(subject ?? '');
  if (adopted && plainVersion(adopted[1]) && pkgAtMain.version === adopted[1]) {
    await tidyAfterCrash(g, appDir, main);
    const version = adopted[1];
    const tag = `v${version}`;
    if (!(await g.ok(appDir, ['rev-parse', '--verify', '-q', `refs/tags/${tag}`]))) {
      const made = await g.git(appDir, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'tag', '-a', tag, '-m', tag, main]);
      if (made.code !== 0) return no(`The release ${tag} is on main but its tag could not be added: ${lastLine(made)}.`);
      return { ok: true, version, sha: main, tag };
    }
  }

  // 4. first ⇔ the package still carries the foundation's name.
  const name = pkgAtMain.name;
  if (bump === 'first' && name !== UNRELEASED_NAME) return no('This app has already had its first release, so it cannot have another first one.');
  if (bump !== 'first' && name === UNRELEASED_NAME) return no('This app has not had its first release yet. Ship it once (conductor ship) to make it.');

  const scratch = mkdtempSync(path.join(os.tmpdir(), 'hf-release-'));
  const tmpRef = `refs/conductor/release-${runId}`;
  try {
    // 5. A scratch clone of main, with every tag (all of them app releases) so the release script refuses a clash.
    const clone = path.join(scratch, 'app');
    const cloned = await g.git(scratch, ['clone', '-q', '--no-hardlinks', '--branch', 'main', appDir, clone]);
    if (cloned.code !== 0) return no(`Conductor could not copy the app to make the release: ${lastLine(cloned)}.`);
    for (const [key, value] of [['user.name', identity.name], ['user.email', identity.email]]) {
      if (!(await g.ok(clone, ['config', key, value]))) return no('Conductor could not set up the copy of the app to make the release.');
    }

    // 6. first only: one preparation commit (the app's own name, a changelog line naming the foundation), and, because
    // Plan 8's createApp removed every tag, a placeholder tag the foundation's release script needs (Ruling S1). The
    // placeholder stays in the scratch clone: step 9 fetches only the new release tag.
    if (bump === 'first') {
      const prepared = prepareFirst(clone, project);
      if (prepared) return no(prepared);
      const files = ['package.json', 'CHANGELOG.md', ...(existsSync(path.join(clone, 'package-lock.json')) ? ['package-lock.json'] : [])];
      if (!(await g.ok(clone, ['add', '--', ...files]))
        || !(await g.ok(clone, ['commit', '-q', '-m', `Start ${project.client}'s own releases`]))) {
        return no('Conductor could not prepare the app\'s first release.');
      }
      const tags = await g.out(clone, ['tag', '--list', 'v*']);
      const current = plainVersion(pkgAtMain.version);
      if (tags === '' && current && !(await g.ok(clone, ['tag', `v${current}`, main]))) {
        return no('Conductor could not prepare the app\'s first release.');
      }
    }

    // 7. The app's own release script.
    const npmEnv = strictChildEnv({ env });
    const ci = await run({ cmd: npmBin, args: ['ci', '--no-audit', '--no-fund', '--loglevel=error'], cwd: clone, env: npmEnv, timeoutMs: NPM_CI_TIMEOUT_MS });
    if (ci.code !== 0) return no(`The app's release script stopped: ${lastLine(ci)}.`);
    const npmBump = bump === 'first' ? FIRST_RELEASE_NPM_BUMP : bump;
    const rel = await run({ cmd: npmBin, args: ['run', 'release', '--', npmBump], cwd: clone, env: npmEnv, timeoutMs: NPM_RELEASE_TIMEOUT_MS });
    if (rel.code !== 0) return no(`The app's release script stopped: ${lastLine(rel)}.`);

    // 8. Check what it left: HEAD carries package.json's version (Ruling S16), tagged v<version>, on top of main.
    const sha = await g.out(clone, ['rev-parse', '--verify', 'HEAD']);
    const version = plainVersion((await readPackageAt(g, clone, 'HEAD'))?.version);
    if (!sha || !SHA_RE.test(sha) || !version) return no(NOT_EXPECTED);
    const tag = `v${version}`;
    if ((await g.out(clone, ['rev-parse', '--verify', '-q', `refs/tags/${tag}^{commit}`])) !== sha) return no(NOT_EXPECTED);
    if (!(await g.ok(clone, ['merge-base', '--is-ancestor', main, sha]))) return no(NOT_EXPECTED);
    // Ruling S20: the release adds only release content, in exactly the commits a release makes.
    const count = await g.out(clone, ['rev-list', '--count', `${main}..${sha}`]);
    if (count !== String(bump === 'first' ? 2 : 1)) return no('The app\'s release script made more commits than a release needs, so nothing was added.');
    // Read untrimmed: a file named " CHANGELOG.md" must not pass as CHANGELOG.md.
    const diff = await g.git(clone, ['diff', '--name-only', '-z', main, sha]);
    if (diff.code !== 0) return no(NOT_EXPECTED);
    const stray = String(diff.stdout).split('\0').filter((f) => f !== '' && !RELEASE_FILES.includes(f));
    if (stray.length > 0) {
      const named = stray.slice(0, 5).join(', ') + (stray.length > 5 ? ` and ${stray.length - 5} more` : '');
      return no(`The app's release script changed files a release should not touch (${named}), so nothing was added.`);
    }

    // 9. Into the app repo: objects first, then main by compare-and-swap, then the tag.
    const fetched = await g.git(appDir, ['fetch', '-q', '--no-tags', clone, `+refs/heads/main:${tmpRef}`]);
    if (fetched.code !== 0) return no(`Conductor could not bring the release into the app: ${lastLine(fetched)}.`);
    const onMain = (await g.out(appDir, ['symbolic-ref', '-q', '--short', 'HEAD'])) === 'main';
    if (onMain && (await g.out(appDir, ['status', '--porcelain'])) !== '') {
      return no('The app folder has changes Conductor did not make, so the release was not added.');
    }
    if (!(await g.ok(appDir, ['update-ref', 'refs/heads/main', sha, main]))) {
      return no('The app\'s main branch moved while the release was being made, so the release was not added. Run it again.');
    }
    const tagged = await g.git(appDir, ['fetch', '-q', '--no-tags', clone, `refs/tags/${tag}:refs/tags/${tag}`]);
    if (tagged.code !== 0) return no(`The release ${tag} is on main but its tag could not be added: ${lastLine(tagged)}. Run it again to add the tag.`);
    if (onMain && !(await g.ok(appDir, ['reset', '-q', '--hard', sha]))) {
      return no(`The release ${tag} was added, but the app folder could not be brought up to date with it. Run git reset --hard in the app folder.`);
    }
    return { ok: true, version, sha, tag };
  } finally {
    await g.git(appDir, ['update-ref', '-d', tmpRef]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

// A crash between moving main and `reset --hard` leaves the app folder (on main) holding the main the release started
// from: main^ for minor/patch, main~2 for a first release (its preparation commit). When the index and the working tree
// match one of those commits exactly, with nothing untracked, bring them up to main (nothing is lost: what they hold
// is already committed); anything else is the operator's and is left alone.
async function tidyAfterCrash(g, appDir, main) {
  if ((await g.out(appDir, ['symbolic-ref', '-q', '--short', 'HEAD'])) !== 'main') return;
  if ((await g.out(appDir, ['status', '--porcelain'])) === '') return;
  if ((await g.out(appDir, ['ls-files', '--others', '--exclude-standard'])) !== '') return;
  for (const base of [`${main}^`, `${main}~2`]) {
    if (!(await g.ok(appDir, ['rev-parse', '--verify', '-q', `${base}^{commit}`]))) return;
    if (await g.ok(appDir, ['diff', '--quiet', base]) && await g.ok(appDir, ['diff', '--cached', '--quiet', base])) {
      await g.git(appDir, ['reset', '-q', '--hard', main]);
      return;
    }
  }
}

// The first release's preparation, in the scratch clone. Returns a refusal, or null.
function prepareFirst(clone, project) {
  const rewrite = (file, edit) => {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    edit(j);
    writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
  };
  try {
    rewrite(path.join(clone, 'package.json'), (j) => { j.name = project.slug; });
  } catch { return 'The app\'s package.json could not be read, so a release cannot be made.'; }
  const lock = path.join(clone, 'package-lock.json');
  if (existsSync(lock)) {
    try {
      rewrite(lock, (j) => {
        j.name = project.slug;
        if (j.packages && j.packages[''] && typeof j.packages[''] === 'object') j.packages[''].name = project.slug;
      });
    } catch { return 'The app\'s package-lock.json could not be read, so a release cannot be made.'; }
  }
  const changelogFile = path.join(clone, 'CHANGELOG.md');
  const noSection = 'The app\'s CHANGELOG.md has no "## [Unreleased]" section, so a release cannot be made.';
  let lines;
  try { lines = readFileSync(changelogFile, 'utf8').split('\n'); } catch { return noSection; }
  const at = lines.findIndex((l) => /^## \[Unreleased\]/.test(l));
  if (at < 0) return noSection;
  lines.splice(at + 1, 0, `- First release of the ${project.client} app, built on highland-foundation ${project.foundation.tag}.`);
  writeFileSync(changelogFile, lines.join('\n'));
  return null;
}

export async function approvedRelease(projectDir, { runId, env = process.env, run = runCommand } = {}) {
  const no = (problem) => ({ ok: false, problem });
  let project;
  try { project = loadProject(projectDir); } catch (e) { return no(e.message); }
  const approved = project.approved?.sha;
  if (typeof approved !== 'string' || !SHA_RE.test(approved)) {
    return no(`This project has no approved build yet. Build it and approve it first (conductor build ${project.slug}).`);
  }
  const gitBin = findBin('git', { env });
  if (!gitBin) return no('Conductor needs git on this machine to make a release, and it is not installed.');
  const g = gitRunner(run, gitBin, env);
  const appDir = path.join(projectDir, 'app');
  if (!existsSync(appDir) || !(await g.ok(appDir, ['cat-file', '-e', `${approved}^{commit}`]))) {
    return no(`The approved build (${short(approved)}) is not in the project's app repository.`);
  }

  const found = await findRelease(appDir, approved, { env, run });
  if (found) {
    // Ruling S16: what is built and tagged must carry the tag's version in package.json.
    const pkgVersion = (await readPackageAt(g, appDir, found.sha))?.version;
    if (pkgVersion !== found.version) return no(`The release tag ${found.tag} does not match the version in package.json (${pkgVersion ?? 'none'}).`);
    return { ok: true, ...found, cut: false };
  }

  const main = await g.out(appDir, ['rev-parse', '--verify', '-q', 'refs/heads/main']);
  if (!main) return no(NO_APP);
  const pkgAtMain = await readPackageAt(g, appDir, main);
  if (!pkgAtMain) return no('The app\'s package.json could not be read, so a release cannot be made.');
  if (pkgAtMain.name !== UNRELEASED_NAME) {
    return no(`The approved change (${short(approved)}) has no release yet. Finish it with: conductor change ${project.slug} --resume`);
  }
  if (main !== approved) {
    return no(`The app's main branch has moved since the build was approved (main is ${short(main)}, the approved build is ${short(approved)}), so Conductor will not release it. Approve the build again.`);
  }
  const r = await releaseApp({ projectDir, bump: 'first', runId, expectedMain: main }, { env, run });
  if (!r.ok) return no(`Conductor could not make the app's first release: ${r.reason}`);
  return { ok: true, sha: r.sha, version: r.version, tag: r.tag, cut: true };
}
