// The git side of a foundation upgrade (Plan 11, Task 6; index Ruling 5 as amended by Rulings C1 and C8).
// The merge happens in a scratch clone of the app, never in the app folder. The foundation repo is only read
// (a fetch *from* it). The app gains exactly refs/foundation/<toTag> at the release's commit (if it is missing,
// recorded first) and a new upgrade branch (landed create-only by the core's land()). The app's main is never touched.
// The scratch folder is always <projectDir>/builds/<runId>/merge, derived here and never taken from a caller.
import { mkdirSync, readFileSync, writeFileSync, rmSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { git, Workspace } from '../../workspace.js';
import { compareVersions } from '../foundationLog.js';
import { MAX_INSTRUCTIONS } from '../split.js';
import { RUN_ID_RE } from '../ids.js';

export const MAX_CONFLICT_FILES = 20;

export const NOT_FROM_FOUNDATION = 'This app does not share any history with the foundation, so the foundation release cannot be merged into it. It may not have been cloned from a foundation release tag (see docs/BUILDING-ON.md).';
export const UNRESOLVABLE = (list) => `The foundation release cannot be merged automatically. ${list} A person needs to decide each of these, so nothing was changed in the app.`;
const NOT_LANDED = (error) => `Conductor could not add the foundation merge to the app: ${error}. Nothing else was changed.`;

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ZERO_SHA = '0'.repeat(40);
// Never follow a GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE left in Conductor's own environment.
const CLEAN_GIT_ENV = { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined };
const FETCH_TIMEOUT_MS = 15 * 60_000;
// Pinned so the markers are always the two-sided form the loop, the gate and resolveVersionHunks expect.
const MERGE_FLAGS = ['-c', 'merge.conflictStyle=merge', '-c', 'merge.renames=true', '-c', 'rerere.enabled=false'];

// Operator text never carries git's own output (no jargon, no stderr).
const NOT_PREPARED = 'Conductor could not prepare the foundation merge in its scratch copy of the app, so it stopped. Nothing was changed in the app.';
const NO_SCRATCH = 'Conductor could not set up its scratch folder for the foundation merge (the project folder or its builds folder is missing or is a link to somewhere else), so it stopped. Nothing was changed in the app.';
const RECORD_FAILED = (toTag) => `Conductor could not record the foundation release ${toTag} with the app, so it stopped. Nothing was changed in the app.`;
const RECORD_MOVED = (toTag) => `The app records the foundation's ${toTag} as a different commit than the foundation now has, so Conductor stopped. Nothing was changed in the app.`;

class Stop extends Error {}

async function run(cwd, args, opts = {}) {
  const r = await git(cwd, args, { env: CLEAN_GIT_ENV, ...opts });
  if (r.code !== 0) throw new Stop(NOT_PREPARED);
  return r.stdout;
}

// <projectDir>/builds/<runId>/merge, or null when the project folder is unusable or builds/ or builds/<runId>
// is a link (or resolves elsewhere), so the delete below can never reach outside the project.
function scratchFolder(projectDir, runId) {
  if (typeof projectDir !== 'string' || projectDir.trim() === '') return null;
  let root;
  try { root = realpathSync(path.resolve(projectDir)); } catch { return null; }
  if (!lstatSync(root).isDirectory()) return null;
  for (const dir of [path.join(root, 'builds'), path.join(root, 'builds', runId)]) {
    if (!existsSync(dir) && !isLink(dir)) continue;
    if (isLink(dir) || !lstatSync(dir).isDirectory()) return null;
    let real;
    try { real = realpathSync(dir); } catch { return null; }
    if (real !== dir) return null;
  }
  return path.join(root, 'builds', runId, 'merge');
}
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** Why `toTag` cannot be the upgrade target, in plain English, or null when it is a newer foundation release. */
export function upgradeTargetProblem({ fromTag, toTag, tags }) {
  if (typeof toTag !== 'string' || !RELEASE_TAG.test(toTag)) return `${toTag} is not a foundation release name. Use the form v1.2.3.`;
  if (!tags.includes(toTag)) return `The foundation has no release called ${toTag}. Releases available: ${tags.join(', ')}.`;
  const c = compareVersions(toTag.slice(1), String(fromTag).replace(/^v/, ''));
  if (c === 0) return `This app is already on the foundation's ${fromTag}.`;
  if (c < 0) return `${toTag} is older than the foundation release this app is on (${fromTag}). Conductor does not move apps back to older foundation releases.`;
  return null;
}

const OPEN = /^<{7}(?: |\r?$)/;
const BASE = /^\|{7}(?: |\r?$)/;
const MID = /^={7}\r?$/;
const CLOSE = /^>{7}(?: |\r?$)/;
const VERSION_LINE = /^"version":\s*"[^"]*",?$/;

/** Settles conflict hunks whose two sides are each only a `"version"` line by keeping the app's (ours) side. */
export function resolveVersionHunks(text) {
  const lines = String(text).split('\n');
  const out = [];
  let remaining = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!OPEN.test(lines[i])) { out.push(lines[i]); continue; }
    let j = i + 1;
    const ours = [];
    const theirs = [];
    while (j < lines.length && !BASE.test(lines[j]) && !MID.test(lines[j])) ours.push(lines[j++]);
    if (j < lines.length && BASE.test(lines[j])) while (j < lines.length && !MID.test(lines[j])) j++;
    if (j >= lines.length) { out.push(...lines.slice(i)); remaining++; break; } // unterminated: left as it is
    j++;
    while (j < lines.length && !CLOSE.test(lines[j])) theirs.push(lines[j++]);
    if (j >= lines.length) { out.push(...lines.slice(i)); remaining++; break; }
    const onlyVersion = ours.length === 1 && theirs.length === 1 && VERSION_LINE.test(ours[0].trim()) && VERSION_LINE.test(theirs[0].trim());
    if (onlyVersion) out.push(ours[0]);
    else { out.push(...lines.slice(i, j + 1)); remaining++; }
    i = j;
  }
  return { text: out.join('\n'), remaining };
}

// Unmerged paths -> { stages: Set, special }, from `git ls-files -u -z` ("<mode> <sha> <stage>\t<path>\0").
// `special`: some side is a symlink (120000) or a submodule (160000), which has no text to resolve.
async function unmergedPaths(dir) {
  const byPath = new Map();
  for (const entry of (await run(dir, ['ls-files', '-u', '-z'])).split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, , stage] = entry.slice(0, tab).split(' ');
    const file = entry.slice(tab + 1);
    if (!byPath.has(file)) byPath.set(file, { stages: new Set(), special: false });
    const u = byPath.get(file);
    u.stages.add(stage);
    if (mode === '120000' || mode === '160000') u.special = true;
  }
  return byPath;
}

const hasMarkers = (file) => {
  try { return readFileSync(file, 'utf8').split('\n').some((l) => OPEN.test(l)); } catch { return false; }
};

/**
 * Merges foundation release `toTag` into the app in a scratch clone at <projectDir>/builds/<runId>/merge, records
 * the release as refs/foundation/<toTag> in the app if missing, and lands the merge as a new branch in the app.
 * @param {{ projectDir: string, appDir: string, foundationRepo: string, fromTag: string, toTag: string, runId: string }} options
 * @returns {Promise<{ status: 'ready', mergeSha, tagSha, branch, mainAtStart, conflicts: string[], autoResolved: string[] }
 *                  | { status: 'stopped', reason: string }>}
 */
export async function prepareUpgradeMerge({ projectDir, appDir, foundationRepo, fromTag, toTag, runId }) {
  if (typeof toTag !== 'string' || !RELEASE_TAG.test(toTag)) return { status: 'stopped', reason: `${toTag} is not a foundation release name. Use the form v1.2.3.` };
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return { status: 'stopped', reason: `"${runId}" is not a valid run id, so Conductor stopped. Nothing was changed in the app.` };
  const branch = `factory/upgrade-${toTag}-${runId}`;
  const foundationRef = `refs/foundation/${toTag}`;
  let scratch = null;
  try {
    scratch = scratchFolder(projectDir, runId);
    if (!scratch) return { status: 'stopped', reason: NO_SCRATCH };
    const app = path.resolve(appDir);
    // A leftover from a run that was killed mid-way: the folder is Conductor's own throwaway copy.
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(path.dirname(scratch), { recursive: true });
    // 1. A scratch clone of the app's committed main.
    await run(path.dirname(scratch), ['clone', '--quiet', '--no-hardlinks', '--no-checkout', app, scratch], { timeoutMs: FETCH_TIMEOUT_MS });
    const main = await git(scratch, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], { env: CLEAN_GIT_ENV });
    if (main.code !== 0) return { status: 'stopped', reason: 'The app has no main line to merge the foundation release into, so nothing was changed.' };
    const mainAtStart = main.stdout.trim();
    await run(scratch, ['checkout', '-q', '-b', branch, mainAtStart]);
    await run(scratch, ['remote', 'remove', 'origin']);

    // 2. The release's commit, fetched from the foundation (read-only).
    const f = await git(scratch, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', path.resolve(foundationRepo), `refs/tags/${toTag}:${foundationRef}`], { env: CLEAN_GIT_ENV, timeoutMs: FETCH_TIMEOUT_MS });
    if (f.code !== 0) return { status: 'stopped', reason: `Conductor could not read the foundation release ${toTag} from ${foundationRepo}, so it stopped. Nothing was changed in the app.` };
    const tagSha = (await run(scratch, ['rev-parse', '--verify', `${foundationRef}^{commit}`])).trim();

    // 3. The app must come from the foundation.
    if ((await git(scratch, ['merge-base', 'HEAD', tagSha], { env: CLEAN_GIT_ENV })).code !== 0) return { status: 'stopped', reason: NOT_FROM_FOUNDATION };

    // 4. The merge itself, not yet committed.
    const message = `foundation: merge ${toTag}`;
    const m = await git(scratch, [...MERGE_FLAGS, 'merge', '--no-ff', '--no-commit', '-m', message, tagSha], { env: CLEAN_GIT_ENV, timeoutMs: FETCH_TIMEOUT_MS });
    const unmerged = await unmergedPaths(scratch);
    if (m.code !== 0 && unmerged.size === 0) {
      return { status: 'stopped', reason: `Conductor could not merge the foundation release ${toTag} into its scratch copy of the app, so it stopped. Nothing was changed in the app.` };
    }

    // 5. Conflicts no text edit can settle stop the run.
    const problems = [];
    for (const [file, { stages, special }] of [...unmerged].sort(([a], [b]) => a.localeCompare(b))) {
      if (!stages.has('2')) problems.push(`${file}: the app deleted it but the foundation changed it.`);
      else if (!stages.has('3')) problems.push(`${file}: the foundation deleted it but the app changed it.`);
      else if (special || !hasMarkers(path.join(scratch, file))) problems.push(`${file}: both changed this file and it is not text.`);
    }
    if (problems.length) return { status: 'stopped', reason: UNRESOLVABLE(problems.join(' ')) };

    // 6. The mechanical rules (Ruling 5 with C1: foundation.json and CHANGELOG.md keep the app's copy).
    const autoResolved = [];
    const conflicts = [];
    for (const file of [...unmerged.keys()].sort()) {
      if (file === 'foundation.json' || file === 'CHANGELOG.md') {
        await run(scratch, ['checkout', '--ours', '--', file]);
        await run(scratch, ['add', '--', file]);
        autoResolved.push(file);
      } else if (file === 'package.json' || file === 'package-lock.json') {
        const abs = path.join(scratch, file);
        const r = resolveVersionHunks(readFileSync(abs, 'utf8'));
        writeFileSync(abs, r.text);
        if (r.remaining === 0) { await run(scratch, ['add', '--', file]); autoResolved.push(file); } else conflicts.push(file);
      } else conflicts.push(file);
    }

    // 7. Commit, markers and all, with both parents.
    await run(scratch, ['add', '-A']);
    const subject = conflicts.length ? `${message} (${conflicts.length} files need their conflicts resolved: ${conflicts.join(', ')})` : message;
    await run(scratch, ['commit', '-q', '--no-verify', '--no-edit', '-m', subject]);
    const mergeSha = (await run(scratch, ['rev-parse', 'HEAD'])).trim();

    // 8. The branch name must be free before the app is written at all.
    if ((await git(app, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { env: CLEAN_GIT_ENV })).code === 0) {
      return { status: 'stopped', reason: NOT_LANDED(`branch ${branch} already exists in the repository`) };
    }

    // 9. Keep the release in the app as refs/foundation/<toTag> at its commit, only if missing (Ruling C8), before
    //    landing, so nothing can fail once the branch is in the app.
    const kept = await keepFoundationRelease({ appDir: app, foundationRepo, toTag, tagSha });
    if (kept) return { status: 'stopped', reason: kept };

    // 10. Land the branch in the app, create-only.
    const landed = await new Workspace(scratch, branch, mainAtStart).land({ repoDir: app, branch, sha: mergeSha });
    if (!landed.ok) {
      // land()'s own wording is plain except where it would pass on git's output.
      const why = /^(fetch failed|could not create the branch):/.test(String(landed.error)) ? 'the app\'s repository would not accept the new branch' : landed.error;
      return { status: 'stopped', reason: NOT_LANDED(why) };
    }

    return { status: 'ready', mergeSha, tagSha, branch, mainAtStart, conflicts, autoResolved };
  } catch (e) {
    return { status: 'stopped', reason: e instanceof Stop ? e.message : NOT_PREPARED };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

// As createApp: a temporary fetch from the foundation, then a create-only update-ref at the peeled commit.
// Returns null when done (or already present at the same commit), or a plain reason for the operator.
async function keepFoundationRelease({ appDir, foundationRepo, toTag, tagSha }) {
  const ref = `refs/foundation/${toTag}`;
  const recorded = () => git(appDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { env: CLEAN_GIT_ENV });
  const exists = async () => (await git(appDir, ['rev-parse', '--verify', '--quiet', ref], { env: CLEAN_GIT_ENV })).code === 0;
  if (await exists()) {
    const r = await recorded();
    return r.code === 0 && r.stdout.trim() === tagSha ? null : RECORD_MOVED(toTag);
  }
  const incoming = `refs/conductor/incoming/${randomBytes(8).toString('hex')}`;
  try {
    const f = await git(appDir, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', path.resolve(foundationRepo), `refs/tags/${toTag}:${incoming}`], { env: CLEAN_GIT_ENV, timeoutMs: FETCH_TIMEOUT_MS });
    if (f.code !== 0) return RECORD_FAILED(toTag);
    const got = await git(appDir, ['rev-parse', '--verify', '--quiet', `${incoming}^{commit}`], { env: CLEAN_GIT_ENV });
    if (got.code !== 0 || got.stdout.trim() !== tagSha) return `The foundation's ${toTag} changed while the merge was being prepared, so Conductor stopped. Nothing was changed in the app.`;
    const u = await git(appDir, ['update-ref', ref, tagSha, ZERO_SHA], { env: CLEAN_GIT_ENV });
    if (u.code !== 0) {
      // Created meanwhile: fine only if it records the same release.
      if (!(await exists())) return RECORD_FAILED(toTag);
      const r = await recorded();
      return r.code === 0 && r.stdout.trim() === tagSha ? null : RECORD_MOVED(toTag);
    }
    return null;
  } finally {
    await git(appDir, ['update-ref', '-d', incoming], { env: CLEAN_GIT_ENV });
  }
}

const bullet = (l) => String(l).replace(/^\s*[-*+]\s+/, '').trim();

/** The single build unit (Plan 8 Unit + change/retire) that tells the author/reviewer loop to finish the upgrade. */
export function upgradeUnit({ fromTag, toTag, conflicts, changes }) {
  const intro = `The foundation release ${toTag} has been merged into the app (it was on ${fromTag}).`;
  const middle = conflicts.length
    ? `These files contain both versions side by side: ${conflicts.join(', ')}; keep both the foundation's fix and the app's own behaviour in each.`
    : 'The merge had no conflicts: check the app still builds and passes its tests.';
  const tail = 'When you are done, npm run verify and the browser tests must pass, and the role-crossing report must show no failures. Do not edit the foundation\'s own files beyond resolving the conflicts.';
  const items = (changes ?? []).flatMap((s) => (s.lines ?? []).map(bullet).filter(Boolean).map((l) => `${l} (${s.version})`));

  const compose = (n) => {
    const listed = items.slice(0, n);
    let what = listed.length ? `What the foundation changed: ${listed.join(' ')}` : '';
    if (n < items.length) what += `${what ? ' ' : 'What the foundation changed: '}(${items.length - n} more in the foundation's CHANGELOG.md.)`;
    return [intro, what, middle, tail].filter(Boolean).join(' ');
  };
  let n = items.length;
  let instructions = compose(n);
  while (instructions.length > MAX_INSTRUCTIONS && n > 0) instructions = compose(--n);
  return {
    id: `foundation-upgrade-${toTag.replace(/\./g, '-')}`,
    title: `Upgrade the foundation to ${toTag}`,
    kind: 'fix', covers: [], acceptance: [], dependsOn: [],
    instructions,
    change: 'foundation-upgrade', retire: [],
  };
}

/** The app changelog lines for an upgrade: one upgrade line plus each foundation security fix it brings in. */
export function upgradeChangelogLines({ fromTag, toTag, security }) {
  return [
    `- Foundation upgraded from ${fromTag} to ${toTag}.`,
    ...(security ?? []).flatMap((s) => (s.lines ?? []).map((l) => `- **[security]** ${bullet(l)} (foundation ${s.version})`)),
  ];
}
