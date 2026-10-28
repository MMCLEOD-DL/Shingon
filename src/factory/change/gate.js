// src/factory/change/gate.js — the change gate and the ship guard (Plan 11 Task 5, index Ruling 7):
// a change never ships without a passing council or an explicit operator override.
//
// makeChangeGate builds the hooks.approveBuild Plan 8's runBuild calls after the council in change mode. It checks
// the council (and its saved report, Contract 7.5) and the pipeline's own check before it asks; a failed check is
// never asked about: onRefused(reason) and false (never { note }, which Plan 8 turns into a fix unit).
// shipProblem runs again before each deployment is touched, from the saved approval record alone.
// Everything here fails closed: anything not understood counts as "not approved".
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { git as workspaceGit } from '../../workspace.js';
import { RUN_ID_RE } from '../ids.js';
import { CLEAN_GIT_ENV, isSha, isObject } from './gitSafe.js';

export const COUNCIL_MISSING = 'The full council did not review this change, so it cannot be shipped. Nothing was added to the app. Check that the council is set up (conductor doctor) and run the change again.';
export const COUNCIL_NOT_PASSED = 'The council still found problems that must be fixed, and you did not choose to ship anyway, so this change cannot be shipped. Nothing was added to the app.';
export const COUNCIL_OLDER_COMMIT = 'The council reviewed an earlier version of this change, not the one waiting for approval, so it cannot be shipped. Nothing was added to the app. Resume the change so the council reviews the final version.';
export const MARKERS_LEFT = (files) => `The foundation merge is not finished: these files still contain both versions side by side: ${files.join(', ')}. Nothing was added to the app.`;
export const NOT_APPROVED_COMMIT = 'What reached the app is not exactly what you approved, so nothing was shipped. The approved work is still on its own branch in the app.';
export const NO_APPROVAL = 'There is no record that you approved this change, so nothing was shipped.';
export const APPROVAL_NOT_SAVED = 'Conductor could not record your approval, so the change was not added to the app. Resume the change to try again.';
export const CHECK_FAILED = 'Conductor could not finish checking this change before asking you, so nothing was added to the app. Resume the change to try again.';

const OVERRIDE_NOTE = 'You chose to ship although the council still found problems.';
// Every git call here runs without the caller's GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE.
const gitFn = (dir, args, opts = {}) => workspaceGit(dir, args, { ...opts, env: { ...CLEAN_GIT_ENV, ...(opts.env ?? {}) } });
const PASSING = new Set(['approved', 'approved-with-warnings']);
// A conflict marker line: seven < or >, then a space, or the end of the line (CRLF files included).
const MARKER_RE = /^(<{7}|>{7})( |\r?$)/m;

// The status alone: approved / approved-with-warnings, or blocked with an operator override (exactly true).
function councilStatusPasses(c) {
  if (!isObject(c)) return null;
  if (PASSING.has(c.status)) return { overridden: false };
  if (c.status === 'blocked' && c.overridden === true) return { overridden: true };
  return null;
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

// Plan 9's builds/<runId>/council-report.json, only when it is this run's finished report (Ruling C3): a matching
// runId, not the stale-marked { sha, runId, status: 'paused', reason } shape, and a verdict. Anything else: null.
export function readCouncilReport(projectDir, runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return null;
  const report = readJson(path.join(projectDir, 'builds', runId, 'council-report.json'));
  if (!isObject(report) || report.runId !== runId || report.status === 'paused') return null;
  if (typeof report.verdict !== 'string' || !report.verdict) return null;
  return report;
}

// After a secret squash Plan 8 re-points only build.council.sha (Ruling C3): the saved build record says so.
function squashedShaOf(projectDir, runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return null;
  const build = readJson(path.join(projectDir, 'builds', runId, 'build.json'));
  return isObject(build) && build.runId === runId && isSha(build.squashedSha) ? build.squashedSha : null;
}

// council = build.council; report = readCouncilReport's answer; sha = the commit waiting for approval.
// runId is required (Ruling C3): a call without it refuses.
export function councilPassed(council, { sha, runId, report, squashedSha = null } = {}) {
  if (!isObject(council) || !isObject(report)) return { ok: false, reason: COUNCIL_MISSING };
  // The report must be this run's finished one, with the same verdict the council hook gave.
  if (typeof runId !== 'string' || report.runId !== runId || report.status === 'paused'
    || typeof report.verdict !== 'string' || report.verdict !== council.status) {
    return { ok: false, reason: COUNCIL_MISSING };
  }
  if (!isSha(sha) || council.sha !== sha) return { ok: false, reason: COUNCIL_OLDER_COMMIT };
  // The report names the commit it reviewed; after a secret squash that is the pre-squash commit.
  if (report.sha !== council.sha && !(isSha(squashedSha) && squashedSha === council.sha)) {
    return { ok: false, reason: COUNCIL_OLDER_COMMIT };
  }
  const passes = councilStatusPasses(council);
  return passes ? { ok: true, overridden: passes.overridden } : { ok: false, reason: COUNCIL_NOT_PASSED };
}

export function makeChangeGate({ projectDir, approveBuild, extraText, check, onApproved, onRefused, now = () => new Date() }) {
  const refuse = (reason) => {
    try { onRefused(reason); } catch { /* the refusal still stands */ }
    return false;
  };
  return async (arg) => {
    const report = readCouncilReport(projectDir, arg?.runId);
    const verdict = councilPassed(arg?.council, { sha: arg?.sha, runId: arg?.runId, report, squashedSha: squashedShaOf(projectDir, arg?.runId) });
    if (!verdict.ok) return refuse(verdict.reason);

    // A check or text that throws is never asked about: the change is refused with a plain reason.
    let summary;
    try {
      const problem = await check(arg);
      if (problem) return refuse(problem);
      summary = `${arg.summary}\n\nIf you approve:\n  ${String(extraText(arg)).split('\n').join('\n  ')}`;
    } catch {
      return refuse(CHECK_FAILED);
    }
    if (verdict.overridden) summary += `\n${OVERRIDE_NOTE}`;

    const answer = await approveBuild({ ...arg, summary });
    if (answer !== true) return answer;

    // Saved before true is returned, so a crash straight after still knows what was approved.
    try {
      await onApproved({
        sha: arg.sha, branch: arg.branch, at: now().toISOString(),
        council: { status: arg.council.status, overridden: verdict.overridden, verdict: report.verdict, round: report.round },
      });
    } catch {
      return refuse(APPROVAL_NOT_SAVED);
    }
    return true;
  };
}

// The files (of `files`) that still hold a conflict marker line at commit `sha`. A file missing at that commit is
// skipped; a commit that cannot be read throws, so it is never taken for "no markers".
export async function conflictMarkers(dir, sha, files, { git = gitFn } = {}) {
  if (!isSha(sha) || (await git(dir, ['cat-file', '-e', `${sha}^{commit}`])).code !== 0) {
    throw new Error(`Conductor could not read commit ${String(sha)} in the app.`);
  }
  const marked = [];
  for (const file of files) {
    const shown = await git(dir, ['show', `${sha}:${file}`]);
    if (shown.code !== 0) continue;
    if (MARKER_RE.test(shown.stdout)) marked.push(file);
  }
  return marked;
}

// Before each deployment is touched: the saved approval, its council, and the released commit containing exactly
// the approved work. Returns the reason not to ship, or null.
export async function shipProblem(run, { appDir, git = gitFn } = {}) {
  const approval = run?.approval;
  if (!isObject(approval) || typeof approval.sha !== 'string' || !approval.sha) return NO_APPROVAL;
  if (!councilStatusPasses(approval.council)) return COUNCIL_NOT_PASSED;
  const released = run?.release?.sha;
  if (!isSha(approval.sha) || !isSha(released)) return NOT_APPROVED_COMMIT;
  const r = await git(appDir, ['merge-base', '--is-ancestor', approval.sha, released]);
  return r.code === 0 ? null : NOT_APPROVED_COMMIT;
}
