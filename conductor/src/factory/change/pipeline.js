// src/factory/change/pipeline.js — the change and foundation-upgrade pipelines (Plan 11, Task 9).
// A run is a stage machine saved in builds/<runId>/change.json after every step, so a crash or Ctrl-C anywhere
// resumes without asking the gate again once the approval is saved, without a second release, and without updating
// a box twice:
//
//   change:   brief ─┐
//                    ├─▶ build ─▶ approved ─▶ merged ─▶ released ─▶ shipping ─▶ done
//   upgrade:  prepare┘
//
// No lock is taken here: the CLI handler holds lockProject(projectDir, 'change') around every call (Contract 7 §7.11),
// and nothing called from here (reviseBrief, runBuild) takes it either. The deps functions arrive through `deps`.
// A run's status is what resume needs (running, paused, failed = unfinished; stopped, done = finished); the outcome's
// status is what the operator is told. They differ where the brief says so: a gate refusal or a box that did not
// update stops what the operator sees ('stopped') but leaves the run resumable ('paused').
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git as workspaceGit } from '../../workspace.js';
import { redact } from '../../secrets.js';
import { RunLog } from '../../runlog.js';
import { readProject, loadProject, saveProject } from '../projects.js';
import { briefPaths, loadBrief, currentBriefInfo } from '../brief.js';
import { readNotesFile, loadSession, discardSession } from '../briefSession.js';
import { briefDraftPrompt } from '../briefPrompts.js';
import { appProfileOf } from '../app.js';
import { MAX_INSTRUCTIONS } from '../split.js';
import { releaseTags, readChangelogAt, changesBetween, securityFixesSince, compareVersions } from '../foundationLog.js';
import { missingSeams, loadBriefVersion, currentBriefVersion } from './seams.js';
import { STAGES, createChangeRun, saveChangeRun, findUnfinishedRun } from './run.js';
import { briefDelta, deltaProblem, buildUnits, profileChanged, deltaText, changeChangelogLines } from './delta.js';
import { makeChangeGate, conflictMarkers, MARKERS_LEFT, NOT_APPROVED_COMMIT, NO_APPROVAL, CHECK_FAILED } from './gate.js';
import { nextVersion, appMain, appCheckoutProblem, appVersionAt, commitChangelog, advanceMain, releaseProblem, releaseContentProblem, MAIN_MOVED, RELEASE_FILES } from './mainline.js';
import { upgradeTargetProblem, prepareUpgradeMerge, upgradeUnit, upgradeChangelogLines, MAX_CONFLICT_FILES } from './upgradeMerge.js';
import { CLEAN_GIT_ENV, SHA_RE, isObject } from './gitSafe.js';
import { shipUpdate, shipReport, projectDeployments, NO_DEPLOYMENTS } from './ship.js';

export const NOT_BUILT_YET = 'This project has not been built and approved yet, so there is nothing to change. Build it first with "conductor build <slug>".';
export const NO_BUILT_FROM = 'This project does not record which brief version the app was built from, so Conductor cannot tell what a change would add. Nothing was changed.';
export const UNFINISHED = (runId, kind) => `An earlier ${kind === 'change' ? 'change' : 'foundation upgrade'} (${runId}) is not finished. Continue it with --resume, or drop it with --abandon, before starting another.`;
export const NOTHING_TO_RESUME = 'There is no unfinished change for this project.';
export const BRIEF_CHANGED_WHILE_PAUSED = ({ kind, slug, current, built }) => `The approved brief changed while this ${kind === 'change' ? 'change' : 'foundation upgrade'} was paused (it is now version ${current}; the ${kind === 'change' ? 'change' : 'upgrade'} was being built for version ${built}), so nothing was built. Drop this ${kind === 'change' ? 'change' : 'foundation upgrade'} with "conductor change ${slug} --abandon", then start it again.`;
export const RELEASE_STILL_TO_MAKE = (slug, what = 'change', firstRelease = false) => (firstRelease
  ? `The ${what} is already on the app's main line, so it cannot be dropped. Resume it to finish (conductor change ${slug} --resume); this app has not had its first release yet, so after that ship it with "conductor ship ${slug} --to <deployment>".`
  : `The ${what} is already on the app's main line, so it cannot be dropped. Resume it to make the release and update the deployments (conductor change ${slug} --resume); nothing more ships until you do.`);
export const TOO_MANY_CONFLICTS = (n, files) => ({
  title: 'the foundation upgrade',
  message: `Merging the foundation release left ${n} files with both versions side by side (${files.slice(0, 10).join(', ')}${n > 10 ? ', …' : ''}). Conductor can try to resolve them, which uses your subscription, or you can stop and merge by hand. Approve to let Conductor try.`,
});
export const MISSING_SEAMS = (names) => `This Conductor is missing parts it needs for changes (${names.join(', ')}). Update Conductor; nothing was changed.`;

const STAGE_WORDS = {
  brief: 'brief step', prepare: 'foundation merge', build: 'build', approved: 'step that adds the change to the app',
  merged: 'release', released: 'shipping', shipping: 'shipping',
};
const NO_NOTES = 'A change needs a notes file saying what the client wants changed. Nothing was changed.';
const GATE_UNANSWERED = 'Conductor could not ask you to approve the change, so nothing was added to the app. Resume the change to be asked again.';
const BRIEF_AHEAD = (current, built) => `Brief version ${current} is approved, but the app is still built from brief version ${built}. Finish or drop that change first, then upgrade the foundation. Nothing was changed.`;
const STALE_REVISION = (slug) => `An older revision of the brief is still open and no longer matches the approved brief. Run "conductor brief ${slug} --discard-draft", then resume the change. Nothing else was changed.`;
const DRAFT_OPEN = (slug) => `An unfinished brief draft is waiting for this project. Finish it or throw it away with "conductor brief ${slug}" first, then start the change. Nothing was changed.`;
const MAIN_MOVED_IN_PREPARE = 'The app changed while the foundation merge was being prepared, so nothing was built. Start the foundation upgrade again.';
const MAIN_MOVED_SINCE_ADDED = 'The app\'s main line moved after the change was added to it, so no release was made and nothing was shipped. Check the app\'s main line before shipping by hand.';
const NO_BRIEF_RECORD = 'This project does not record which brief version the app was built from, so Conductor cannot record the upgrade against it. Nothing was changed.';
const RECORD_DIFFERS = (toTag) => `The app records a different version of the foundation's ${toTag} than the foundation now has, so Conductor stopped. Nothing was built.`;
const CHANGELOG_NOT_ON_APPROVED = 'The saved changelog commit does not sit directly on the work you approved, so Conductor stopped rather than add something else to the app.';
const CHANGELOG_NOT_ONLY = 'The saved changelog commit changes more than the changelog, so Conductor stopped rather than add something else to the app.';
const UNRELEASED_NAME = 'highland-foundation';
const MARKER_GREP = ['grep', '-l', '-I', '-E', '-e', '^(<{7}|>{7})( |$)'];

// Every git call here runs without the caller's GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE.
const git = (dir, args, opts = {}) => workspaceGit(dir, args, { ...opts, env: { ...CLEAN_GIT_ENV, ...(opts.env ?? {}) } });
const plainMessage = (e) => String(redact(String(e?.message ?? e ?? 'no reason given'))).trim().replace(/\.+$/, '');

// ---- the operator's yes/no --------------------------------------------------------------------------------

/** Asks a yes/no question through the terminal; true only for exactly 'approve' (no terminal, a throw: false). */
export async function askOperator(term, { title, message }) {
  try {
    const answer = await term.escalate({ kind: 'change', title, message, options: ['approve', 'reject'] });
    return answer === 'approve';
  } catch {
    return false;
  }
}

// ---- entry points -----------------------------------------------------------------------------------------

const refuse = (status, reason) => ({ status, runId: null, reason });

// The checks every entry point makes first: the deps, the project, and the unfinished run.
function open({ factory, slug, deps }) {
  const missing = missingSeams(deps);
  if (missing.length) return { refusal: refuse('failed', MISSING_SEAMS(missing)) };
  let found;
  try { found = readProject(factory.projectsRoot, slug); } catch (e) { return { refusal: refuse('stopped', e.message) }; }
  let unfinished;
  try { unfinished = findUnfinishedRun(found.dir); } catch (e) { return { refusal: refuse('stopped', e.message) }; }
  return { projectDir: found.dir, project: found.project, unfinished };
}

function context(args, projectDir) {
  return {
    factory: args.factory, slug: args.slug, projectDir, appDir: path.join(projectDir, 'app'),
    team: args.team, author: args.author, term: args.term ?? {}, options: args.options ?? {}, baseDir: args.baseDir,
    deps: args.deps, warnings: args.warnings ?? [], env: args.env ?? process.env, cwd: args.cwd ?? process.cwd(),
    hooks: args.hooks ?? {}, shipState: args.shipState ?? {},
  };
}

function newRunProblem(project) {
  if ((project.status !== 'ready' && project.status !== 'shipped') || !project.approved) return NOT_BUILT_YET;
  return null;
}

async function startRun(ctx, fields) {
  const problem = await appCheckoutProblem(ctx.appDir);
  if (problem) return { refusal: refuse('stopped', problem) };
  let mainAtStart;
  try { mainAtStart = await appMain(ctx.appDir); } catch (e) { return { refusal: refuse('stopped', e.message) }; }
  const run = createChangeRun(ctx.projectDir, { slug: ctx.slug, mainAtStart, baseRef: 'main', ...fields }, { now: now(ctx) });
  return { run };
}

const now = (ctx) => (typeof ctx.deps?.now === 'function' ? ctx.deps.now() : new Date());

/** A change request: brief revision from the notes file → delta → change build → gate → main → release → ship. */
export async function runChange(args) {
  const o = open(args);
  if (o.refusal) return o.refusal;
  if (o.unfinished) return refuse('stopped', UNFINISHED(o.unfinished.runId, o.unfinished.kind));
  const notBuilt = newRunProblem(o.project);
  if (notBuilt) return refuse('stopped', notBuilt);
  if (!Number.isInteger(o.project.builtFromBrief)) return refuse('stopped', NO_BUILT_FROM);
  const ctx = context(args, o.projectDir);
  if (typeof args.notesFile !== 'string' || args.notesFile.trim() === '') return refuse('stopped', NO_NOTES);

  // As Plan 7's handler: an absolute notes file, and a dry run of the first request, so notes too long to send are
  // refused before anything is saved (Ruling C13).
  const notesFile = path.resolve(ctx.cwd, args.notesFile);
  let briefAtStart;
  try {
    // A brief session already open is someone else's draft: the change does not take it over.
    if (loadSession(ctx.projectDir, args.slug)) return refuse('stopped', DRAFT_OPEN(args.slug));
    briefAtStart = currentBriefVersion(ctx.projectDir);
    const { text } = readNotesFile(notesFile);
    briefDraftPrompt({ notes: [{ name: `notes/${path.basename(notesFile)}`, text }], baseBrief: loadBrief(ctx.projectDir) });
  } catch (e) {
    return refuse('stopped', e.message);
  }
  const s = await startRun(ctx, { kind: 'change', brief: { from: o.project.builtFromBrief, to: null }, briefAtStart, notesFile });
  if (s.refusal) return s.refusal;
  return drive(ctx, s.run);
}

/** A foundation upgrade to `toTag`: merge on its own branch → change build → gate → main → patch release → ship. */
export async function runFoundationUpgrade(args) {
  const o = open(args);
  if (o.refusal) return o.refusal;
  if (o.unfinished) return refuse('stopped', UNFINISHED(o.unfinished.runId, o.unfinished.kind));
  const notBuilt = newRunProblem(o.project);
  if (notBuilt) return refuse('stopped', notBuilt);
  const { repo, tag: fromTag } = o.project.foundation ?? {};
  if (!repo || !fromTag) return refuse('stopped', NOT_BUILT_YET);
  const builtFrom = Number.isInteger(o.project.builtFromBrief) ? o.project.builtFromBrief : o.project.approved.briefVersion;
  if (!Number.isInteger(builtFrom)) return refuse('stopped', NO_BRIEF_RECORD);
  const ctx = context(args, o.projectDir);
  try {
    // Ruling C11: an approved brief the app does not have yet would be silently stamped as built.
    const current = currentBriefVersion(ctx.projectDir);
    if (current > builtFrom) return refuse('stopped', BRIEF_AHEAD(current, builtFrom));
    // The foundation is read from its own repository, never from the app folder.
    const problem = upgradeTargetProblem({ fromTag, toTag: args.toTag, tags: await releaseTags(repo) });
    if (problem) return refuse('stopped', problem);
  } catch (e) {
    return refuse('stopped', e.message);
  }
  const s = await startRun(ctx, { kind: 'foundation-upgrade', fromTag, toTag: args.toTag, briefVersion: builtFrom });
  if (s.refusal) return s.refusal;
  return drive(ctx, s.run);
}

/** Carries on the project's unfinished change or upgrade from the stage it reached. */
export async function resumeChange(args) {
  const o = open(args);
  if (o.refusal) return o.refusal;
  if (!o.unfinished) return refuse('stopped', NOTHING_TO_RESUME);
  return drive(context(args, o.projectDir), o.unfinished);
}

/** Drops the unfinished change or upgrade and says what it left behind. */
export async function abandonChange(args) {
  const o = open(args);
  if (o.refusal) return o.refusal;
  const run = o.unfinished;
  if (!run) return refuse('stopped', NOTHING_TO_RESUME);
  const appDir = path.join(o.projectDir, 'app');
  if (run.stage === 'brief') {
    // Ruling C10: the open revision belongs to this change. A plain 'new' brief session is not touched.
    let session = null;
    let unreadable = false;
    try { session = loadSession(o.projectDir, args.slug); } catch { unreadable = true; }
    if (unreadable || session?.mode === 'revise') { try { discardSession(o.projectDir); } catch { /* the drop still stands */ } }
  }
  let reached = STAGES.indexOf(run.stage) >= STAGES.indexOf('merged');
  if (!reached && typeof run.changelogSha === 'string' && SHA_RE.test(run.changelogSha)) {
    reached = (await git(appDir, ['merge-base', '--is-ancestor', run.changelogSha, 'refs/heads/main'])).code === 0;
  }
  // Main has the change but the release is not made yet: a drop here would leave no way forward (the next change
  // would start from a main nobody released), so only resume can carry it on.
  if (reached && (run.stage === 'approved' || run.stage === 'merged')) return refuse('stopped', RELEASE_STILL_TO_MAKE(args.slug,
    run.kind === 'change' ? 'change' : 'foundation upgrade', !run.approval?.expectedVersion));
  run.status = 'stopped';
  run.reason = 'You dropped this change.';
  saveChangeRun(o.projectDir, run);
  const what = run.kind === 'change' ? 'change' : 'foundation upgrade';
  const left = reached
    ? 'The app\'s main line already has this change; the deployments not yet updated stay on their current version.'
    : 'Nothing reached the app\'s main line.';
  return { status: 'stopped', runId: run.runId, reason: `You dropped the ${what} ${run.runId}. ${left}` };
}

// ---- the stage machine ------------------------------------------------------------------------------------

function save(ctx, run) { saveChangeRun(ctx.projectDir, run); }

// Ends this sitting: the run's own status (for resume) and the outcome the operator is told.
function end(ctx, run, runStatus, outcomeStatus, reason, extra = {}) {
  run.status = runStatus;
  run.reason = reason == null ? null : redact(reason);
  save(ctx, run);
  return { status: outcomeStatus, runId: run.runId, ...(reason == null ? {} : { reason }), ...extra };
}

async function drive(ctx, run) {
  const steps = {
    brief: stepBrief, prepare: stepPrepare, build: stepBuild, approved: stepMerge, merged: stepRelease, released: stepShip, shipping: stepShip,
  };
  try {
    run.status = 'running';
    run.reason = null;
    save(ctx, run);
    for (;;) {
      const step = steps[run.stage];
      if (!step) throw new Error(`the change is at a stage Conductor does not know (${run.stage})`);
      const r = await step(ctx, run);
      if (r) return r;
    }
  } catch (e) {
    const reason = `Conductor hit a problem during the ${STAGE_WORDS[run.stage] ?? 'change'} and stopped: ${plainMessage(e)}. You can resume.`;
    try {
      run.status = 'failed';
      run.reason = redact(String(e?.message ?? e));
      save(ctx, run);
    } catch { /* the outcome below still says what happened */ }
    return { status: 'failed', runId: run.runId, reason };
  }
}

// ---- brief ------------------------------------------------------------------------------------------------

function approvedAfterStart(projectDir, run) {
  const info = currentBriefInfo(projectDir);
  const at = Date.parse(info?.approvedAt);
  return Number.isFinite(at) && at >= Date.parse(run.createdAt);
}

async function stepBrief(ctx, run) {
  const { projectDir, deps, term, slug } = ctx;
  const from = run.brief.from;
  const atStart = Number.isInteger(run.briefAtStart) ? run.briefAtStart : from;
  const current = currentBriefVersion(projectDir);
  let session = null;
  try { session = loadSession(projectDir, slug); } catch (e) { return end(ctx, run, 'failed', 'failed', e.message); }
  // Ruling C10: a newer brief approved after the run started is this change's revision (its session may have cleared
  // itself after saving the brief, before the run heard).
  const adoptable = current > Math.max(from, atStart) && approvedAfterStart(projectDir, run);
  let to = null;
  if (session && session.mode === 'revise' && !session.approving && session.baseVersion !== current) {
    // Ruling C13 (a): a saved revision that no longer matches the approved brief.
    if (!adoptable) return end(ctx, run, 'failed', 'failed', STALE_REVISION(slug));
    discardSession(projectDir);
    to = current;
  } else if (!session && adoptable) {
    to = current;
  }

  if (to === null) {
    // The notes go in only while nothing has started: no session yet and the brief still where it was.
    const notesFile = !session && current === atStart ? run.notesFile ?? null : null;
    const cwd = mkdtempSync(path.join(tmpdir(), 'conductor-change-brief-'));
    let r;
    try {
      r = await deps.reviseBrief({
        projectDir, slug, notesFile, author: ctx.author, io: term.briefIo, log: new RunLog(briefPaths(projectDir).logs),
        operatorName: ctx.factory.operatorName, cwd,
      });
    } catch (e) {
      return end(ctx, run, 'failed', 'failed', `Conductor could not revise the brief: ${plainMessage(e)}. You can resume.`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    if (r?.status !== 'approved') {
      const status = r?.status === 'paused' || r?.status === 'failed' ? r.status : 'stopped';
      const reason = typeof r?.reason === 'string' && r.reason ? r.reason : 'The brief revision ended without an approved brief, so nothing was built.';
      return end(ctx, run, status, status, reason);
    }
    to = r.version;
  }
  if (!Number.isInteger(to) || to <= from) {
    return end(ctx, run, 'stopped', 'stopped', `The revised brief is not newer than brief version ${from}, which the app is built from, so there is nothing to build.`);
  }

  run.brief = { from, to };
  save(ctx, run);
  const prev = loadBriefVersion(projectDir, from);
  const next = loadBriefVersion(projectDir, to);
  const delta = briefDelta(prev, next);
  const problem = deltaProblem(delta, prev, next);
  if (problem) return end(ctx, run, 'stopped', 'stopped', problem);
  let units;
  try { units = buildUnits(delta, { toVersion: to }); } catch (e) { return end(ctx, run, 'stopped', 'stopped', e.message); }
  run.delta = delta;
  run.units = units;
  run.profile = profileChanged(delta) ? appProfileOf(next) : null;
  run.stage = 'build';
  save(ctx, run);
  return null;
}

// ---- prepare (upgrade) ------------------------------------------------------------------------------------

// On resume: an upgrade branch this run already landed (its parents are main at the start and the release) is used
// as it is. The files still holding both versions are read from the merge commit.
async function landedUpgrade(ctx, run, toTag, repo) {
  const branch = `factory/upgrade-${toTag}-${run.runId}`;
  const merge = await git(ctx.appDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  if (merge.code !== 0) return null;
  const tag = await git(ctx.appDir, ['rev-parse', '--verify', '--quiet', `refs/foundation/${toTag}^{commit}`]);
  if (tag.code !== 0) return null;
  const mergeSha = merge.stdout.trim();
  const tagSha = tag.stdout.trim();
  // The app's record of the release is trusted only when it is the commit the foundation's own tag names.
  const theirs = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/tags/${toTag}^{commit}`]);
  if (theirs.code !== 0 || theirs.stdout.trim() !== tagSha) return { status: 'stopped', reason: RECORD_DIFFERS(toTag) };
  const parents = (await git(ctx.appDir, ['rev-list', '--parents', '-n', '1', mergeSha])).stdout.trim().split(' ');
  if (parents.length !== 3 || parents[1] !== run.mainAtStart || parents[2] !== tagSha) return null;
  const marked = await git(ctx.appDir, [...MARKER_GREP, mergeSha]);
  if (marked.code !== 0 && marked.code !== 1) return null;
  const conflicts = marked.stdout.split('\n').filter(Boolean).map((l) => l.slice(mergeSha.length + 1)).sort();
  return { status: 'ready', mergeSha, tagSha, branch, mainAtStart: run.mainAtStart, conflicts, autoResolved: [] };
}

async function stepPrepare(ctx, run) {
  const { projectDir, appDir } = ctx;
  const { fromTag, toTag } = run;
  if (!isObject(run.upgrade)) {
    const project = loadProject(projectDir);
    const repo = project.foundation?.repo;
    if (!repo) return end(ctx, run, 'stopped', 'stopped', NOT_BUILT_YET);
    // Every foundation read uses the foundation's own repository, never the app folder.
    const problem = upgradeTargetProblem({ fromTag, toTag, tags: await releaseTags(repo) });
    if (problem) return end(ctx, run, 'stopped', 'stopped', problem);
    const changelog = await readChangelogAt(repo, toTag);
    // Plan 10's parseVersion is strict semver: versions without the leading v.
    const fromV = fromTag.slice(1);
    const toV = toTag.slice(1);
    const changes = changesBetween(changelog, fromV, toV);
    const security = securityFixesSince(changelog, fromV).filter((s) => compareVersions(s.version, toV) <= 0);
    let merged = await landedUpgrade(ctx, run, toTag, repo);
    if (merged?.status === 'stopped') return end(ctx, run, 'stopped', 'stopped', merged.reason);
    if (!merged) {
      merged = await prepareUpgradeMerge({ projectDir, appDir, foundationRepo: repo, fromTag, toTag, runId: run.runId });
      if (merged?.status !== 'ready') {
        return end(ctx, run, 'stopped', 'stopped', typeof merged?.reason === 'string' ? merged.reason : 'Conductor could not prepare the foundation merge, so it stopped. Nothing was changed in the app.');
      }
      if (merged.mainAtStart !== run.mainAtStart) return end(ctx, run, 'stopped', 'stopped', MAIN_MOVED_IN_PREPARE);
    }
    run.upgrade = {
      repo, fromTag, toTag, tagSha: merged.tagSha, mergeSha: merged.mergeSha, branch: merged.branch,
      conflicts: merged.conflicts, autoResolved: merged.autoResolved, changes, security,
    };
    run.baseRef = merged.branch;
    save(ctx, run);
  }
  const u = run.upgrade;
  if (u.conflicts.length > MAX_CONFLICT_FILES && run.conflictsApproved !== true) {
    const yes = await askOperator(ctx.term, TOO_MANY_CONFLICTS(u.conflicts.length, u.conflicts));
    if (!yes) {
      return end(ctx, run, 'stopped', 'stopped', `You did not let Conductor resolve the ${u.conflicts.length} files that hold both versions, so nothing was built and nothing was spent. The merged foundation release is on its own branch in the app (${u.branch}) if you want to merge it by hand.`);
    }
    run.conflictsApproved = true;
    save(ctx, run);
  }
  const unit = upgradeUnit({ fromTag, toTag, conflicts: u.conflicts, changes: u.changes });
  if (unit.instructions.length > MAX_INSTRUCTIONS) {
    return end(ctx, run, 'stopped', 'stopped', `The foundation merge left too many files with both versions (${u.conflicts.length}) to describe in one build step, so nothing was built. Merge the foundation release by hand on its branch (${u.branch}).`);
  }
  run.units = [unit];
  run.profile = null;
  run.stage = 'build';
  save(ctx, run);
  return null;
}

// ---- build and the change gate ----------------------------------------------------------------------------

// A 'ready' app that never made its own release still carries the foundation's package name (Ruling C4).
async function firstReleasePending(appDir, sha) {
  const r = await git(appDir, ['show', `${sha}:package.json`]);
  if (r.code !== 0) throw new Error('Conductor could not read the app\'s package.json, so it cannot tell the app\'s version');
  try { return JSON.parse(r.stdout)?.name === UNRELEASED_NAME; } catch { throw new Error('the app\'s package.json could not be read'); }
}

async function stepBuild(ctx, run) {
  const { projectDir, appDir, deps, term, factory, slug } = ctx;
  const isChange = run.kind === 'change';
  // The brief this run builds must still be the approved one: a brief approved while the run was paused would be
  // stamped as built without ever being built (final review item 4).
  const builtFor = isChange ? run.brief.to : run.briefVersion;
  const currentBrief = currentBriefVersion(projectDir);
  if (currentBrief !== builtFor) {
    return end(ctx, run, 'paused', 'stopped', BRIEF_CHANGED_WHILE_PAUSED({ kind: run.kind, slug, current: currentBrief, built: builtFor }));
  }
  const bump = isChange ? 'minor' : 'patch';
  const firstPending = await firstReleasePending(appDir, run.mainAtStart);
  const expectedVersion = firstPending ? null : nextVersion(await appVersionAt(appDir, run.mainAtStart), bump);
  const u = run.upgrade;
  const changelogLines = isChange
    ? changeChangelogLines(run.delta, run.brief.to)
    : upgradeChangelogLines({ fromTag: u.fromTag, toTag: u.toTag, security: u.security });
  const deployments = projectDeployments(deps, { projectsRoot: factory.projectsRoot, slug });
  const n = deployments.list.length;
  const approveLabel = firstPending
    ? 'approve → add to the app (nothing is shipped yet: "conductor ship" makes its first release)'
    : `approve → add to the app and update ${n} deployment${n === 1 ? '' : 's'}`;

  const extraText = () => {
    const lines = [];
    if (isChange) lines.push(deltaText(run.delta));
    else {
      lines.push(`The foundation goes from ${u.fromTag} to ${u.toTag}.`);
      const fixes = u.security.flatMap((s) => s.lines.map((l) => `  - ${l} (${s.version})`));
      if (fixes.length) lines.push('Security fixes this brings in:', ...fixes);
    }
    lines.push(expectedVersion
      ? `The app becomes version ${expectedVersion}.`
      : `The app has not had its first release yet: it gets one when you ship it with "conductor ship ${slug}".`);
    lines.push('These lines are added to its changelog:', ...changelogLines.map((l) => `  ${l}`));
    if (expectedVersion) {
      lines.push(n
        ? `These deployments are then updated one at a time, each with a backup first and an automatic undo if it fails: ${deployments.list.map((d) => `${d.name} (${d.deployment.currentVersion})`).join(', ')}.`
        : NO_DEPLOYMENTS);
    }
    return lines.join('\n');
  };
  const check = async (arg) => {
    if (deployments.problem) return deployments.problem;
    if (isChange) return null;
    // The build branch lives in the app: the files that held both versions must not hold them any more.
    const left = await conflictMarkers(appDir, arg.sha, u.conflicts);
    return left.length ? MARKERS_LEFT(left) : null;
  };
  const refused = (reason) => {
    run.refusal = reason;
    try { save(ctx, run); } catch { /* still refused; the outcome carries the reason */ }
  };
  const ask = async (a) => {
    try { return await term.approveBuild({ ...a, approveLabel }); } catch { refused(GATE_UNANSWERED); return false; }
  };
  const gate = makeChangeGate({
    projectDir, approveBuild: ask, extraText, check, onRefused: refused,
    now: () => now(ctx),
    // Saved before the gate says yes; the run in memory changes only once the record is on disk.
    onApproved: (record) => {
      const next = {
        ...run,
        approval: { ...record, bump, expectedVersion, changelogLines, deployments: deployments.list.map((d) => d.name) },
        build: { branch: record.branch, sha: record.sha },
        stage: 'approved',
      };
      delete next.refusal;
      saveChangeRun(projectDir, next);
      Object.assign(run, next);
      delete run.refusal;
    },
  });
  // Anything thrown inside the gate reaches Plan 8 as a plain refusal, never as a bare false.
  const approveBuild = async (a) => {
    try { return await gate(a); } catch { refused(CHECK_FAILED); return false; }
  };

  delete run.refusal;
  save(ctx, run);
  const hooks = {
    ...ctx.hooks,
    // Change mode: no terminal to ask means no.
    escalate: async (e) => {
      if (typeof term.escalate !== 'function') return 'reject';
      try { return await term.escalate(e); } catch { return null; }
    },
    onEvent: (e) => term.onEvent?.(e),
    onProgress: (t) => term.say?.(t),
    // Plan 9's full council, wired as conductor build wires it (Ruling C2); its answer is passed back unchanged.
    council: (a) => deps.runProjectCouncil(a, { options: ctx.options, deps: { baseDir: ctx.baseDir } }),
    approveBuild,
  };
  const outcome = await deps.runBuild({
    factory, slug, team: ctx.team, baseDir: ctx.baseDir, warnings: ctx.warnings, env: ctx.env, hooks,
    options: {
      ...ctx.options,
      change: {
        runId: run.runId, baseRef: run.baseRef, units: run.units, profile: run.profile ?? null,
        // An upgrade is reviewed and summarised against the foundation release it brings in (final review item 3).
        // Its conflicts are the files prepareUpgradeMerge left with both versions, read from Git (never from a model):
        // the foundation-rules member lets the upgrade unit resolve those foundation files and no others (PR21-R1).
        ...(isChange ? {} : { foundation: { tag: u.toTag, commit: u.tagSha, conflicts: [...u.conflicts] } }),
      },
    },
  });

  const status = outcome?.status;
  if (status === 'approved') {
    if (!isObject(run.approval) || outcome.sha !== run.approval.sha) return end(ctx, run, 'stopped', 'stopped', NOT_APPROVED_COMMIT);
    run.stage = 'approved';
    save(ctx, run);
    return null;
  }
  // Plan 8 and Plan 9 name "conductor build"; a change carries on with conductor change --resume (Ruling C12).
  const resumeHint = `conductor change ${slug} --resume`;
  const said = typeof outcome?.reason === 'string' && outcome.reason ? outcome.reason.replaceAll(`"conductor build ${slug}"`, `"${resumeHint}"`) : null;
  if (status === 'rejected') {
    if (run.refusal) return end(ctx, run, 'paused', 'stopped', run.refusal);
    const reason = isChange
      ? `You did not approve the change. The new brief (v${run.brief.to}) is kept; the app is still built from brief v${run.brief.from}.`
      : `You did not approve the foundation upgrade. The app stays on the foundation's ${u.fromTag}; the merged release is kept on its own branch (${u.branch}).`;
    return end(ctx, run, 'stopped', 'rejected', reason);
  }
  // Ruling C5: a build that stopped (no decision at the gate, a rejected escalation) can be carried on.
  if (status === 'stopped') {
    const why = said ?? 'The build stopped.';
    return end(ctx, run, 'paused', 'paused', why.includes(resumeHint) ? why : `${why} Resume it with "${resumeHint}".`);
  }
  if (status === 'paused' || status === 'failed') return end(ctx, run, status, status, said ?? `The build ${status === 'paused' ? 'paused' : 'failed'}. You can resume.`);
  return end(ctx, run, 'failed', 'failed', 'The build ended in a way Conductor does not recognise, so nothing was added to the app. You can resume.');
}

// ---- approved: changelog, main, project.json --------------------------------------------------------------

async function stepMerge(ctx, run) {
  const { projectDir, appDir } = ctx;
  const a = run.approval;
  if (!isObject(a) || typeof a.sha !== 'string' || typeof a.branch !== 'string') return end(ctx, run, 'stopped', 'stopped', NO_APPROVAL);
  const isChange = run.kind === 'change';
  if (!run.changelogSha) {
    const tip = await git(appDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${a.branch}^{commit}`]);
    if (tip.code !== 0 || tip.stdout.trim() !== a.sha) return end(ctx, run, 'stopped', 'stopped', NOT_APPROVED_COMMIT);
    run.changelogSha = await commitChangelog({
      appDir, sha: a.sha, lines: a.changelogLines, scratchDir: path.join(projectDir, 'builds', run.runId, 'changelog'),
      message: isChange ? `changelog: change from brief v${run.brief.to}` : `changelog: foundation ${run.upgrade.toTag}`,
    });
    save(ctx, run);
  } else {
    const problem = await changelogOnApproved(appDir, run.changelogSha, a.sha);
    if (problem) return end(ctx, run, 'stopped', 'stopped', problem);
  }
  const moved = await advanceMain({ appDir, from: run.mainAtStart, to: run.changelogSha });
  if (!moved?.ok) {
    const why = typeof moved?.reason === 'string' ? moved.reason : 'Conductor could not move the app\'s main line.';
    // Main moved under the run: start again. Anything else (edits in the folder, files that could not follow) says
    // what to fix and is resumable.
    if (why === MAIN_MOVED) return end(ctx, run, 'stopped', 'stopped', `${why} The approved work is on the branch ${a.branch}.`);
    return end(ctx, run, 'paused', 'stopped', why);
  }
  writeProjectRecord(projectDir, run);
  run.stage = 'merged';
  save(ctx, run);
  return null;
}

// The changelog commit is the approved commit itself (the lines were already there) or sits directly on it and
// changes CHANGELOG.md alone. null when it does, otherwise the plain reason.
async function changelogOnApproved(appDir, changelogSha, approvedSha) {
  if (!SHA_RE.test(String(changelogSha))) return CHANGELOG_NOT_ON_APPROVED;
  if (changelogSha === approvedSha) return null;
  const r = await git(appDir, ['rev-list', '--parents', '-n', '1', changelogSha]);
  const p = r.stdout.trim().split(' ');
  if (r.code !== 0 || p.length !== 2 || p[1] !== approvedSha) return CHANGELOG_NOT_ON_APPROVED;
  const names = await git(appDir, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', approvedSha, changelogSha]);
  const changed = names.stdout.split('\0').filter((f) => f !== '');
  return names.code === 0 && changed.length === 1 && changed[0] === 'CHANGELOG.md' ? null : CHANGELOG_NOT_ONLY;
}

// project.json after main has the change: the approval, and what the app is now built from. Idempotent.
function writeProjectRecord(projectDir, run) {
  const a = run.approval;
  const isChange = run.kind === 'change';
  const project = loadProject(projectDir);
  const approved = { sha: run.changelogSha, at: a.at, runId: run.runId, briefVersion: isChange ? run.brief.to : run.briefVersion };
  const next = isChange
    ? { ...project, approved, builtFromBrief: run.brief.to }
    : { ...project, approved, foundation: { repo: run.upgrade.repo, tag: run.upgrade.toTag, commit: run.upgrade.tagSha } };
  saveProject(projectDir, next);
}

// Ruling (Task 9) amending C4: an alternate main is handed to Plan 10 only when it is exactly the release Plan 10
// would have made and then crashed before tagging: the right subject and version, directly on the changelog commit,
// changing only release files. Anything else is never released.
async function isUntaggedRelease(appDir, sha, changelogSha, expectedVersion) {
  const subject = await git(appDir, ['log', '-1', '--format=%s', sha]);
  if (subject.code !== 0 || subject.stdout.trim() !== `release: v${expectedVersion}`) return false;
  try { if ((await appVersionAt(appDir, sha)) !== expectedVersion) return false; } catch { return false; }
  const parents = await git(appDir, ['rev-list', '--parents', '-n', '1', sha]);
  const p = parents.stdout.trim().split(' ');
  if (parents.code !== 0 || p.length !== 2 || p[1] !== changelogSha) return false;
  const names = await git(appDir, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', changelogSha, sha]);
  if (names.code !== 0) return false;
  if (!names.stdout.split('\0').filter((f) => f !== '').every((f) => RELEASE_FILES.includes(f))) return false;
  // And only as a release changes them: version numbers, not scripts, dependencies or file types.
  return (await releaseContentProblem(appDir, changelogSha, sha)) === null;
}

// ---- merged: the release ----------------------------------------------------------------------------------

async function revOf(appDir, ref) {
  const r = await git(appDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function stepRelease(ctx, run) {
  const { projectDir, appDir, deps, slug } = ctx;
  const a = run.approval;
  if (!a.expectedVersion) {
    // Ruling C4: an app that never had its own release cannot take a minor or patch one; conductor ship cuts the first.
    const report = [
      changedText(run), councilLine(a),
      `The change is on the app's main line. This app has not had its first release yet, so nothing was shipped: make its first release by shipping it with "conductor ship ${slug} --to <deployment>".`,
    ].join('\n');
    return end(ctx, run, 'done', 'done', null, { report });
  }
  let release = run.release;
  if (!isObject(release)) {
    const main = await appMain(appDir);
    const tag = `v${a.expectedVersion}`;
    if (main !== run.changelogSha && (await revOf(appDir, `refs/tags/${tag}`)) === main) {
      // The release happened but was never saved: adopted after the same check, not repeated.
      release = { version: a.expectedVersion, sha: main, tag };
    } else {
      let expectedMain = run.changelogSha;
      if (main !== run.changelogSha) {
        // Ruling C4: a release commit left untagged directly on the changelog commit is Plan 10's to adopt.
        if (!(await isUntaggedRelease(appDir, main, run.changelogSha, a.expectedVersion))) {
          return end(ctx, run, 'stopped', 'stopped', MAIN_MOVED_SINCE_ADDED);
        }
        expectedMain = main;
      }
      const r = await deps.releaseApp({ projectDir, bump: a.bump, runId: run.runId, expectedMain });
      if (!r?.ok) {
        return end(ctx, run, 'failed', 'failed', `The release could not be made: ${plainMessage(r?.reason ?? 'no reason given')}. You can resume.`);
      }
      release = { version: r.version, sha: r.sha, tag: r.tag };
    }
  }
  // Always checked from the changelog commit (never from another main): the release sits directly on it.
  const problem = await releaseProblem({ appDir, from: run.changelogSha, release, expectedVersion: a.expectedVersion });
  if (problem) return end(ctx, run, 'stopped', 'stopped', problem);
  run.release = release;
  run.stage = 'released';
  save(ctx, run);
  return null;
}

// ---- released / shipping ----------------------------------------------------------------------------------

function changedText(run) {
  if (run.kind === 'change') return deltaText(run.delta);
  return `The foundation went from ${run.upgrade.fromTag} to ${run.upgrade.toTag}.`;
}

function councilLine(approval) {
  const c = approval?.council;
  if (c?.overridden === true) return 'You chose to ship although the council still found problems.';
  if (c?.status === 'approved-with-warnings') return 'The council approved it with warnings.';
  return 'The council approved it.';
}

function finalReport(ctx, run) {
  const { list, problem } = projectDeployments(ctx.deps, { projectsRoot: ctx.factory.projectsRoot, slug: ctx.slug });
  const ship = problem ?? (list.length ? shipReport(run, list) : NO_DEPLOYMENTS);
  return [changedText(run), councilLine(run.approval), `The app is now version ${run.release.version}.`, ship].join('\n');
}

async function stepShip(ctx, run) {
  const { projectDir, deps, factory, slug, term } = ctx;
  if (run.stage !== 'shipping') {
    run.stage = 'shipping';
    save(ctx, run);
  }
  const project = loadProject(projectDir);
  const r = await shipUpdate({
    projectDir, projectsRoot: factory.projectsRoot, slug, run, version: run.release.version, foundation: project.foundation.tag,
    deps, factory, say: (l) => term.say?.(l), state: ctx.shipState,
    ask: (q) => askOperator(term, { title: 'retry a deployment', message: q }),
    save: (r2) => saveChangeRun(projectDir, r2),
  });
  if (r?.status === 'done') {
    run.stage = 'done';
    return end(ctx, run, 'done', 'done', null, { report: finalReport(ctx, run) });
  }
  // A box that did not update: the run waits at shipping; resume asks before trying it again.
  const reason = typeof r?.reason === 'string' && r.reason ? r.reason : 'The update stopped. You can resume.';
  return end(ctx, run, 'paused', 'stopped', reason, { report: `${finalReport(ctx, run)}\n\n${reason}` });
}
