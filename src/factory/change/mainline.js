// src/factory/change/mainline.js — after the change gate (Plan 11, Task 7; index Ruling 8, Ruling C4).
// 1. commitChangelog: the changelog lines the operator saw at the gate, in one commit on top of the approved commit,
//    touching only CHANGELOG.md. Made in a scratch clone; only the commit's objects reach the app (no ref is left).
// 2. advanceMain: the app's main moves from exactly the commit recorded when the run started to the changelog commit,
//    by compare-and-swap. If main moved, nothing moves.
// 3. releaseProblem: after Plan 10's releaseApp, main is the release commit, its parent is the changelog commit, its tag
//    v<version> points there, the version is the one approved, and it changed only release files.
// Every commit handed to git is a full 40-hex sha checked here first, so nothing reaches git as an option. Operator
// text never carries git's own output.
import { rmSync, mkdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { git } from '../../workspace.js';
import { parseVersion } from '../foundationLog.js';

// Plan 10's private S20 set (src/factory/ship/release.js): the only files a release may change.
export const RELEASE_FILES = Object.freeze(['CHANGELOG.md', 'package.json', 'package-lock.json', 'foundation.json']);
export const RELEASE_BUMPS = Object.freeze(['minor', 'patch']);

export const MAIN_MOVED = 'The app changed while this change was being built (its main line is no longer where it was when the run started), so the change was not added. The approved work is safe on its own branch in the app; start the change again to build it on top of the newer app.';
export const APP_FOLDER_EDITED = 'The app folder has edits that were never committed, so Conductor did not touch it. Commit or remove them, then resume.';
export const NO_MAIN = 'The app has no main line (branch "main"), so Conductor cannot tell what is live. See docs/BUILDING-ON.md.';
export const RELEASE_TOUCHED_CODE = (files) => `The release step changed more than the version and changelog (${files.join(', ')}), so nothing was shipped.`;
export const RELEASE_VERSION_DIFFERS = (expected, got) => `The release came out as version ${got}, but you approved ${expected}, so nothing was shipped.`;
export const RELEASE_NOT_ON_MAIN = 'The release is not on the app\'s main line, so nothing was shipped.';
export const RELEASE_TAG_ELSEWHERE = (version) => `The release tag v${version} is not on the release, so nothing was shipped.`;

const APP_UNREADABLE = 'Conductor could not check the app folder, so it did not touch it.';
const NOT_IN_APP = 'The approved work is not in the app, so the app\'s main line was not moved.';
const FILES_NOT_UPDATED = 'Conductor could not bring the files in the app folder up to date with the approved work, so the app\'s main line was not moved. Nothing was changed.';
const RELEASE_UNCHECKABLE = 'Conductor could not check the release, so nothing was shipped.';
const NO_RELEASE_GIVEN = 'Conductor was not given a release it can check, so nothing was shipped.';
const CHANGELOG_FAILED = 'Conductor could not add the changelog lines to the approved work, so it stopped. The app\'s main line was not moved.';

const SHA_RE = /^[0-9a-f]{40}$/;
const RELEASE_TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAIN = 'refs/heads/main';
const UNRELEASED = /^## \[Unreleased\]\s*$/;
const ANY_HEADING = /^## \[/;
const DIFF_NAMES = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z'];
const CHANGELOG_BRANCH = 'factory/changelog';
// Never follow a GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE left in Conductor's own environment.
const CLEAN_GIT_ENV = { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined };
// The changelog commit is the same commit every time for the same approved commit, lines and message.
const FIXED_IDENTITY = { GIT_AUTHOR_NAME: 'Conductor', GIT_AUTHOR_EMAIL: 'conductor@localhost', GIT_COMMITTER_NAME: 'Conductor', GIT_COMMITTER_EMAIL: 'conductor@localhost' };

const short = (sha) => String(sha).slice(0, 7);
const g = (dir, args, opts = {}) => git(dir, args, { ...opts, env: { ...CLEAN_GIT_ENV, ...(opts.env ?? {}) } });
const isSha = (s) => typeof s === 'string' && SHA_RE.test(s);
const notACommit = (s, what) => `"${String(s).slice(0, 80)}" is not a commit, so ${what}.`;

function plainVersion(s) {
  const v = parseVersion(s);
  return v && s === `${v.major}.${v.minor}.${v.patch}` ? v : null;
}

/** The version a release of kind `bump` ('minor' or 'patch') after `current` will have. Throws plain English. */
export function nextVersion(current, bump) {
  const v = plainVersion(current);
  if (!v) throw new Error(`"${current}" is not a version number Conductor can release from (it needs the form 1.2.3).`);
  if (bump === 'minor') return `${v.major}.${v.minor + 1}.0`;
  if (bump === 'patch') return `${v.major}.${v.minor}.${v.patch + 1}`;
  throw new Error(`"${bump}" is not a kind of release Conductor makes after a change (minor or patch).`);
}

/** The commit the app's main points at. Throws NO_MAIN when there is none. */
export async function appMain(appDir) {
  const r = await g(appDir, ['rev-parse', '--verify', '--quiet', `${MAIN}^{commit}`]);
  const sha = r.stdout.trim();
  if (r.code !== 0 || !SHA_RE.test(sha)) throw new Error(NO_MAIN);
  return sha;
}

// NO_MAIN without a main; APP_FOLDER_EDITED when main is checked out and the folder has uncommitted edits (staged,
// unstaged or untracked). With another branch checked out (for example build/<runId>, left by a rejected or stopped
// build) or a detached HEAD, the files on disk are not main's and advanceMain never touches them, so this is null
// whether or not they have edits.
export async function appCheckoutProblem(appDir) {
  try { await appMain(appDir); } catch { return NO_MAIN; }
  const head = await g(appDir, ['symbolic-ref', '-q', 'HEAD']);
  if (head.code !== 0 && head.code !== 1) return APP_UNREADABLE;
  if (head.code !== 0 || head.stdout.trim() !== MAIN) return null;
  const status = await g(appDir, ['status', '--porcelain', '--untracked-files=all']);
  if (status.code !== 0) return APP_UNREADABLE;
  return status.stdout.trim() === '' ? null : APP_FOLDER_EDITED;
}

/** The version in package.json at commit `sha` of the app. Throws plain English. */
export async function appVersionAt(appDir, sha) {
  if (!isSha(sha)) throw new Error(notACommit(sha, 'Conductor cannot read the app\'s version there'));
  const unreadable = `Conductor could not read the app's package.json at ${short(sha)}, so it cannot tell the app's version.`;
  const r = await g(appDir, ['show', `${sha}:package.json`]);
  if (r.code !== 0) throw new Error(unreadable);
  let pkg;
  try { pkg = JSON.parse(r.stdout); } catch { throw new Error(unreadable); }
  if (!pkg || typeof pkg !== 'object' || typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error(`The app's package.json at ${short(sha)} has no version, so Conductor cannot tell the app's version.`);
  }
  return pkg.version;
}

// Each line not already in the Unreleased section goes directly under its heading, in order. Without the section,
// it is created before the first release heading (or at the end). Unchanged text when nothing is missing.
export function addChangelogLines(text, lines) {
  const all = text.split('\n');
  const h = all.findIndex((l) => UNRELEASED.test(l));
  if (h === -1) {
    const add = [...new Set(lines)];
    if (add.length === 0) return text;
    const section = `## [Unreleased]\n${add.join('\n')}\n`;
    const first = all.findIndex((l) => ANY_HEADING.test(l));
    if (first !== -1) return [...all.slice(0, first), ...`${section}\n`.split('\n').slice(0, -1), ...all.slice(first)].join('\n');
    const body = text.replace(/\n*$/, '');
    return `${body}${body === '' ? '' : '\n\n'}${section}`;
  }
  let end = all.findIndex((l, i) => i > h && ANY_HEADING.test(l));
  if (end === -1) end = all.length;
  const existing = all.slice(h + 1, end);
  const present = new Set(existing.map((l) => l.trimEnd()));
  const add = [];
  for (const l of lines) if (!present.has(l) && !add.includes(l)) add.push(l);
  if (add.length === 0) return text;
  const kept = existing.slice();
  while (kept.length && kept[0].trim() === '') kept.shift();
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const tail = end < all.length ? ['', ...all.slice(end)] : [''];
  return [...all.slice(0, h + 1), ...add, ...kept, ...tail].join('\n');
}

function checkLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('There are no changelog lines to add, so Conductor stopped. The app\'s main line was not moved.');
  for (const l of lines) {
    if (typeof l !== 'string' || l.trim() === '' || /[\r\n\0]/.test(l)) {
      throw new Error('A changelog line is empty or spans more than one line, so Conductor stopped. The app\'s main line was not moved.');
    }
  }
}

// The scratch folder, with its parent made and resolved; never a link (the folder is deleted afterwards).
function scratchFolder(scratchDir) {
  const bad = new Error('Conductor needs a scratch folder of its own to add the changelog lines (a full path that is not a link), so it stopped. The app\'s main line was not moved.');
  if (typeof scratchDir !== 'string' || !path.isAbsolute(scratchDir) || path.resolve(scratchDir) === path.parse(scratchDir).root) throw bad;
  const parentWanted = path.dirname(path.resolve(scratchDir));
  try {
    mkdirSync(parentWanted, { recursive: true });
    const scratch = path.join(realpathSync(parentWanted), path.basename(scratchDir));
    let st = null;
    try { st = lstatSync(scratch); } catch { /* not there yet */ }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw bad;
    return scratch;
  } catch { throw bad; }
}

// One commit on top of `sha` adding `lines` to CHANGELOG.md, in the app's object store; returns its sha (or `sha`
// itself when the lines are already there, as after a crash). Throws plain English; the app gains no ref.
export async function commitChangelog({ appDir, sha, lines, scratchDir, message }) {
  if (!isSha(sha)) throw new Error(notACommit(sha, 'Conductor did not add the changelog lines'));
  checkLines(lines);
  if (typeof message !== 'string' || message.trim() === '' || message.includes('\0')) {
    throw new Error('The changelog commit needs a commit message, so Conductor stopped. The app\'s main line was not moved.');
  }
  const scratch = scratchFolder(scratchDir);
  const app = path.resolve(appDir);
  if ((await g(app, ['cat-file', '-e', `${sha}^{commit}`])).code !== 0) {
    throw new Error(`The approved commit ${short(sha)} is not in the app, so Conductor did not add the changelog lines. The app's main line was not moved.`);
  }
  const shown = await g(app, ['show', `${sha}:CHANGELOG.md`]);
  if (shown.code !== 0) throw new Error(`The approved work has no readable CHANGELOG.md, so Conductor could not add the changelog lines. The app's main line was not moved.`);
  const updated = addChangelogLines(shown.stdout, lines);
  if (updated === shown.stdout) return sha;

  const run = async (cwd, args, opts) => {
    const r = await g(cwd, args, opts);
    if (r.code !== 0) throw new Error(CHANGELOG_FAILED);
    return r.stdout.trim();
  };
  const tmpRef = `refs/conductor/changelog-${randomBytes(8).toString('hex')}`;
  let fetched = false;
  try {
    rmSync(scratch, { recursive: true, force: true }); // a leftover from a run that was killed mid-way: Conductor's own copy
    await run(path.dirname(scratch), ['clone', '--quiet', '--no-hardlinks', '--no-checkout', app, scratch]);
    await run(scratch, ['checkout', '-q', '-b', CHANGELOG_BRANCH, sha]);
    writeFileSync(path.join(scratch, 'CHANGELOG.md'), updated);
    await run(scratch, ['add', '--', 'CHANGELOG.md']);
    const when = await run(scratch, ['log', '-1', '--format=%ct', sha]);
    if (!/^\d+$/.test(when)) throw new Error(CHANGELOG_FAILED);
    const date = `@${when} +0000`;
    await run(scratch, ['commit', '-q', '--no-verify', '-m', message], { env: { ...FIXED_IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    const made = await run(scratch, ['rev-parse', 'HEAD']);
    if (!SHA_RE.test(made)) throw new Error(CHANGELOG_FAILED);

    // Only the commit's objects reach the app: fetched under a temporary ref that is deleted again (as land() does).
    fetched = true;
    await run(app, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', scratch, `+refs/heads/${CHANGELOG_BRANCH}:${tmpRef}`]);
    if ((await run(app, ['rev-parse', '--verify', '--quiet', `${tmpRef}^{commit}`])) !== made) throw new Error(CHANGELOG_FAILED);
    const parents = (await run(app, ['rev-list', '--parents', '-n', '1', made])).split(' ');
    if (parents.length !== 2 || parents[1] !== sha) throw new Error(CHANGELOG_FAILED);
    const names = await g(app, [...DIFF_NAMES, sha, made]);
    if (names.code !== 0) throw new Error(CHANGELOG_FAILED);
    const changed = names.stdout.split('\0').filter((f) => f !== '');
    if (changed.length !== 1 || changed[0] !== 'CHANGELOG.md') throw new Error(CHANGELOG_FAILED);
    return made;
  } finally {
    if (fetched) await g(app, ['update-ref', '-d', tmpRef]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Moves the app's main from exactly `from` to `to` (a descendant of it). With main checked out (and clean) the index and
// files follow; otherwise only main moves. Already at `to` is ok (a repeat after a crash).
export async function advanceMain({ appDir, from, to }) {
  const no = (reason) => ({ ok: false, reason });
  if (!isSha(from)) return no(notACommit(from, 'the app\'s main line was not moved'));
  if (!isSha(to)) return no(notACommit(to, 'the app\'s main line was not moved'));
  let now;
  try { now = await appMain(appDir); } catch { return no(NO_MAIN); }
  if (now === to) return { ok: true };
  if (now !== from) return no(MAIN_MOVED);
  const anc = await g(appDir, ['merge-base', '--is-ancestor', from, to]);
  if (anc.code === 1) return no(MAIN_MOVED);
  if (anc.code !== 0) return no(NOT_IN_APP);
  const problem = await appCheckoutProblem(appDir);
  if (problem) return no(problem);

  const head = await g(appDir, ['symbolic-ref', '-q', 'HEAD']);
  const mainCheckedOut = head.code === 0 && head.stdout.trim() === MAIN;
  const reflog = ['-m', 'conductor: add the approved change'];
  if (!mainCheckedOut) {
    return (await g(appDir, ['update-ref', ...reflog, MAIN, to, from])).code === 0 ? { ok: true } : no(MAIN_MOVED);
  }
  // main is checked out and clean: move it by compare-and-swap, then bring the index and files from `from` to `to`
  // (a two-tree read-tree, which refuses to overwrite anything). If the files cannot follow, main goes back.
  // git treats ignored files as expendable; Conductor does not overwrite one the approved work also has.
  const changed = await g(appDir, [...DIFF_NAMES, from, to]);
  if (changed.code !== 0) return no(FILES_NOT_UPDATED);
  const paths = changed.stdout.split('\0').filter((f) => f !== '');
  if (paths.length) {
    const ignored = await g(appDir, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...paths.map((f) => `:(literal)${f}`)]);
    if (ignored.code !== 0 || ignored.stdout !== '') return no(FILES_NOT_UPDATED);
  }
  await g(appDir, ['update-index', '-q', '--refresh']);
  if ((await g(appDir, ['update-ref', ...reflog, MAIN, to, from])).code !== 0) return no(MAIN_MOVED);
  const files = await g(appDir, ['read-tree', '-m', '-u', from, to]);
  if (files.code !== 0) {
    await g(appDir, ['update-ref', '-m', 'conductor: put main back', MAIN, from, to]);
    return no(FILES_NOT_UPDATED);
  }
  return { ok: true };
}

// null when the release Plan 10 made is exactly what was approved (Ruling C4); otherwise the plain reason.
export async function releaseProblem({ appDir, from, release, expectedVersion }) {
  if (!isSha(from) || !release || typeof release !== 'object' || !isSha(release.sha) || !plainVersion(expectedVersion)) return NO_RELEASE_GIVEN;
  let main;
  try { main = await appMain(appDir); } catch { return NO_MAIN; }
  if (main !== release.sha) return RELEASE_NOT_ON_MAIN;
  if ((await g(appDir, ['merge-base', '--is-ancestor', from, release.sha])).code !== 0) return RELEASE_NOT_ON_MAIN;
  // The release commit sits directly on the changelog commit.
  const parents = await g(appDir, ['rev-list', '--parents', '-n', '1', release.sha]);
  if (parents.code !== 0) return RELEASE_UNCHECKABLE;
  const p = parents.stdout.trim().split(' ');
  if (p.length !== 2 || p[1] !== from) return RELEASE_NOT_ON_MAIN;

  if (release.version !== expectedVersion) return RELEASE_VERSION_DIFFERS(expectedVersion, String(release.version));
  let got;
  try { got = await appVersionAt(appDir, release.sha); } catch { return RELEASE_UNCHECKABLE; }
  if (got !== expectedVersion) return RELEASE_VERSION_DIFFERS(expectedVersion, got);

  const tag = `v${release.version}`;
  if (release.tag !== tag || !RELEASE_TAG_RE.test(tag)) return RELEASE_TAG_ELSEWHERE(release.version);
  const tagged = await g(appDir, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
  if (tagged.code !== 0 || tagged.stdout.trim() !== release.sha) return RELEASE_TAG_ELSEWHERE(release.version);

  const names = await g(appDir, [...DIFF_NAMES, from, release.sha]);
  if (names.code !== 0) return RELEASE_UNCHECKABLE;
  const stray = names.stdout.split('\0').filter((f) => f !== '' && !RELEASE_FILES.includes(f));
  return stray.length ? RELEASE_TOUCHED_CODE(stray) : null;
}
