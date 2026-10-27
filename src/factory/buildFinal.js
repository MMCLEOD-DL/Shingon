// src/factory/buildFinal.js — the end of a build (spec §4.2–§4.4): whole-app checks on the build branch's tip,
// the council hook (Plan 9; Contract 7 §7.7), the squash when a secret was seen (Plan 5 Ruling 10), then the
// operator's gate. Every step is re-entrant: results are saved with the commit they ran on, so a resume does
// not repeat them, and an approval that already moved main is finished without asking again.
// No release is cut here: Plan 10's releaseApp does that when the app is first shipped (Contract 7 §7.6).
import path from 'node:path';
import { git as gitFn } from '../workspace.js';
import { clip } from '../text.js';
import { redact } from '../secrets.js';
import { loadProject, saveProject } from './projects.js';
import { checksLine } from './checks.js';

export const NO_COUNCIL_YET = 'The full council review is not part of this version of Conductor yet, so only the checks above were run.';
const SQUASH_NOTE = "The build's commits were combined into one commit, because the council saw a possible secret in an earlier step.";
const BROWSER_WARNING = 'The browser checks failed and you approved the build anyway.';
const COUNCIL_WARNING = 'The council still found problems and you approved the build anyway.';
const MAIN_MOVED = "The app's main branch is not where Conductor left it, so it stopped rather than guess. Nothing was changed.";
const branchMoved = (branch) => `The build branch ${branch} is not where Conductor left it, so it stopped rather than guess. Nothing was changed.`;

const rounds = (n) => `${n} ${n === 1 ? 'round' : 'rounds'} of fixes`;
const COUNCIL_STATUSES = new Set(['approved', 'approved-with-warnings', 'blocked', 'paused']);
const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

// A fix unit runs like any feature (featureRequest renders it; no worked examples, so no acceptance step).
export function fixUnit({ build, title, instructions, prefix }) {
  const n = build.units.filter((u) => u.id.startsWith(`${prefix}-`)).length + 1;
  const unit = { id: `${prefix}-${n}`, title: clip(String(title), 120), kind: 'fix', covers: [], acceptance: [], dependsOn: [], instructions: String(instructions) };
  build.units.push(unit);
  build.features.push({
    id: unit.id, title: unit.title, status: 'pending', attempts: 0, workspaceDir: null, branch: null, landedSha: null,
    baseSha: null, mergedSha: null, transcript: null, notes: [], councilText: null, gateReason: null,
  });
  return unit;
}

async function rev(appDir, ref, git) {
  const r = await git(appDir, ['rev-parse', '--verify', '--quiet', ref]);
  return r.code === 0 ? r.stdout.trim() : null;
}

// One commit holding sha's tree on parent `onto`; the branch moves from sha by compare-and-swap.
export async function squashBuild({ appDir, branch, sha, onto, message, git = gitFn }) {
  const ref = `refs/heads/${branch}`;
  const tree = await rev(appDir, `${sha}^{tree}`, git);
  if (!tree) throw new Error(`Conductor could not read commit ${sha} to combine the build's commits. Nothing was changed.`);
  const isSquash = async (c) => {
    const parents = (await git(appDir, ['rev-list', '--parents', '-n', '1', c])).stdout.trim().split(/\s+/).slice(1);
    return parents.length === 1 && parents[0] === onto && await rev(appDir, `${c}^{tree}`, git) === tree;
  };
  const head = await rev(appDir, ref, git);
  if (head && await isSquash(head)) return head;   // already done (or a crash after the branch moved)
  if (head !== sha) throw new Error(branchMoved(branch));
  const c = await git(appDir, ['commit-tree', tree, '-p', onto, '-m', message]);
  if (c.code !== 0) throw new Error(`Conductor could not combine the build's commits (${firstLine(c.stderr) || `exit ${c.code}`}). Nothing was changed.`);
  const next = c.stdout.trim();
  if (await rev(appDir, `${next}^{tree}`, git) !== tree) throw new Error("The combined commit does not hold the build's files, so it was not used. Nothing was changed.");
  const u = await git(appDir, ['update-ref', ref, next, sha]);
  if (u.code !== 0) throw new Error(branchMoved(branch));
  return next;
}

export function buildSummaryText({ build, project, checks, councilText, slug }) {
  const lines = [];
  const client = build.client ?? project?.client;
  lines.push(`Build ${build.runId} of ${client}'s app, on foundation ${build.foundation?.tag ?? project?.foundation?.tag ?? 'unknown'}`);
  lines.push(`What was built (${build.features.length} features):`);
  build.features.forEach((f, i) => lines.push(`  ${i + 1}. ${f.title}: done${f.attempts > 1 ? ` after ${f.attempts} tries` : ''}`));
  if (checks) {
    lines.push(`Checks: ${checksLine(checks)}`);
    const reports = checks.reports ?? [];
    const crossing = reports.find((p) => path.basename(p) === 'crossing.md');
    if (crossing) lines.push(`Role-crossing report: ${crossing}`);
    const shots = reports.find((p) => path.basename(p) === 'screenshots');
    if (shots) lines.push(`Page screenshots: ${shots}`);
  }
  if (councilText) lines.push(councilText);
  if (build.squashedSha) lines.push(SQUASH_NOTE);
  const usage = build.usage ?? {};
  lines.push(usage.costUsd > 0
    ? `Frontier cost this build: about $${usage.costUsd.toFixed(2)}, as the subscriptions report it.`
    : 'Frontier cost this build: not reported.');
  if (usage.apiCalls > 0) lines.push(`Paid API use this build: ${usage.apiCalls} calls, about $${(usage.apiCostUsd ?? 0).toFixed(2)}.`);
  for (const w of build.warnings ?? []) lines.push(w);
  const notes = [...build.features.flatMap((f) => f.notes ?? []), ...(build.notes ?? [])];
  if (notes.length) lines.push('Notes:', ...notes.map((n) => `  - ${n}`));
  lines.push(`See it running: conductor preview ${slug}`);
  return lines.join('\n');
}

export async function runFinal(bctx) {
  const { factory, slug, projectDir, appDir, buildDir, brief, build, team, hooks, env, deps, save, emit, progress, finish } = bctx;
  const git = gitFn;
  const now = deps.now ?? (() => new Date());

  // A fix unit saved before a crash that came before the phase changed: build it first.
  if (build.features.some((f) => f.status !== 'merged')) return { next: 'features' };

  let sha = await rev(appDir, `refs/heads/${build.branch}^{commit}`, git);
  if (!sha) throw new Error(`the build branch ${build.branch} is missing`);
  let main = await rev(appDir, 'refs/heads/main^{commit}', git);

  // Approved before a crash: main already moved, so finish the approval without asking again.
  if (build.phase === 'gate' && main === sha) return approve();

  // ---- 1-4: whole-app checks -------------------------------------------------------------------------------
  if (build.checks?.sha !== sha) {
    progress('Running the whole-app checks');
    const result = await deps.runAppChecks({
      appDir, sha, workDir: path.join(buildDir, 'check'), reportsDir: path.join(buildDir, 'reports'),
      testCommand: factory.build.testCommand, browser: factory.build.browserGate, env,
    });
    build.checks = { ...result, sha };
    save();
    emit('build-checks', { verify: result.verify, browser: result.browser });
    progress(checksLine(result));
  }
  const checks = build.checks;
  const verifyRed = checks.verify?.status !== 'passed';
  const browserRed = !verifyRed && checks.browser?.status === 'failed' && !checks.overridden;
  if (verifyRed || browserRed) {
    if (build.fixRounds < factory.build.fixRounds) {
      const failed = verifyRed ? checks.verify : checks.browser;
      build.fixRounds += 1;
      fixUnit({
        build, prefix: 'fix', title: 'Make the whole-app checks pass again',
        instructions: `The whole-app checks fail on the finished build. Make them pass without weakening, skipping or editing any check, and without changing what the app does. What failed:\n${clip(failed.output || failed.summary || '', 1500)}`,
      });
      save();
      return { next: 'features' };
    }
    // A stop drops the cached red result, so a retry runs the checks again: the cause may be outside the code
    // (a database or browsers missing, a flaky runner). fixRounds stays at the cap, so no new fix unit follows.
    const stop = (reason) => { build.checks = null; return finish('stopped', reason); };
    if (verifyRed) {
      return stop( `The whole-app checks still fail after ${rounds(build.fixRounds)}, so the build cannot be approved. ${checksLine(checks).replace(/\.$/, '')}. The build is kept; fix the cause and run "conductor build ${slug}" to try again.`);
    }
    const what = firstLine(checks.browser.output) || checks.browser.summary;
    const message = `Conductor needs your decision on: the browser checks\n\nWhat happened: The browser checks still fail on the finished build after ${rounds(build.fixRounds)}, although the main checks pass.\n\nThe first failure: ${what}\n\nApprove to carry on to the build's approval with a warning, or reject to stop the build here (it is kept).`;
    let answer;
    try { answer = await hooks.escalate({ kind: 'build', title: 'the browser checks', options: ['approve', 'reject'], message }); } catch { answer = null; }
    if (answer !== 'approve') return stop('You stopped the build because the browser checks fail. The build is kept.');
    checks.overridden = true;
    if (!build.warnings.includes(BROWSER_WARNING)) build.warnings.push(BROWSER_WARNING);
    save();
  }

  // The council sends event objects (Plan 9); the build log and hooks.onEvent want a string type.
  const councilEvent = (e) => {
    const { type, ...data } = e && typeof e === 'object' ? e : {};
    emit(type == null || type === '' ? 'council-event' : String(type), data);
  };

  // ---- 5: the council hook ---------------------------------------------------------------------------------
  let councilText = NO_COUNCIL_YET;
  if (typeof hooks.council === 'function') {
    if (build.council?.sha !== sha || build.council.status === 'paused') {
      progress('The council is reviewing the whole app');
      const r = await hooks.council({
        projectDir, appDir, sha, brief, policy: brief.policy, runId: build.runId, slug, team, factory, onEvent: councilEvent, checks: build.checks,
      });
      // Fail closed: an answer that is not one of the four statuses counts as blocked, with nothing to fix.
      const known = r && typeof r === 'object' && COUNCIL_STATUSES.has(r.status);
      build.council = known ? { ...r, sha } : { status: 'blocked', text: 'The council gave no usable answer.', sha };
      build.secretSeen = build.secretSeen || r?.secretSeen === true;
      save();
      emit('build-council', { status: build.council.status });
    }
    const c = build.council;
    councilText = c.text ?? '';
    if (c.status === 'paused') return finish('paused', c.reason ?? 'The council paused.');
    if (c.status === 'blocked' && !c.overridden) {
      // A fix needs both a title and instructions; anything less is treated as no fix.
      const fix = c.fix && typeof c.fix.title === 'string' && c.fix.title.trim() && typeof c.fix.instructions === 'string' && c.fix.instructions.trim() ? c.fix : null;
      if (fix && build.councilFixRounds < factory.build.councilFixRounds) {
        fixUnit({ build, prefix: 'fix', title: fix.title.trim(), instructions: clip(fix.instructions, 3000) });
        build.councilFixRounds += 1;
        save();
        return { next: 'features' };
      }
      const message = `Conductor needs your decision on: the council review\n\nWhat happened: The council still found problems that must be fixed${fix ? `, after ${rounds(build.councilFixRounds)}` : ''}.\n\nThe concern:\n${clip(c.text ?? '', 3000)}\n\nApprove to carry on to the build's approval anyway, or reject to stop the build here (it is kept).`;
      let answer;
      try { answer = await hooks.escalate({ kind: 'council', title: 'the council review', options: ['approve', 'reject'], message }); } catch { answer = null; }
      if (answer !== 'approve') return finish('stopped', 'You stopped the build because the council still found problems that must be fixed. The build is kept.');
      c.overridden = true;
      if (!build.warnings.includes(COUNCIL_WARNING)) build.warnings.push(COUNCIL_WARNING);
      save();
    }
  }

  // ---- 6: a secret was seen: the build branch becomes one commit -------------------------------------------
  if (build.secretSeen && build.squashedSha !== sha) {
    // The squash goes on main's tip; a main that moved off the build's history is never written over.
    if (!main || (await git(appDir, ['merge-base', '--is-ancestor', main, sha])).code !== 0) return finish('failed', MAIN_MOVED);
    const squashed = await squashBuild({
      appDir, branch: build.branch, sha, onto: main, git,
      message: `Build ${build.runId} of ${build.client}'s app (one commit: a possible secret was seen in its history)`,
    });
    // The tree is identical, so the checks and the council still hold for the new commit.
    build.checks.sha = squashed;
    if (build.council) build.council.sha = squashed;
    build.squashedSha = squashed;
    save();
    const expire = await git(appDir, ['reflog', 'expire', '--expire=now', '--all']);
    const gc = expire.code === 0 ? await git(appDir, ['gc', '--prune=now', '--quiet']) : expire;
    if (gc.code !== 0) {
      const note = "Conductor could not clear the build's old commits out of the app's git store; run \"git gc --prune=now\" in the app folder.";
      if (!build.notes.includes(note)) build.notes.push(note);
    }
    save();
    sha = squashed;
  }

  // ---- 7-8: the operator's gate ----------------------------------------------------------------------------
  build.phase = 'gate';
  save();
  const summary = buildSummaryText({ build, project: bctx.project, checks: build.checks, councilText, slug });
  let answer;
  try { answer = await hooks.approveBuild({ summary }); } catch { answer = false; }
  if (answer === true) return approve();
  // { stop: true }: the operator stopped without deciding (end of input at the gate). Not a rejection: the build
  // stays at the gate and "conductor build <slug>" asks again.
  if (answer && typeof answer === 'object' && answer.stop === true) {
    return finish('stopped', `You stopped at the build's approval without deciding. The app's main branch is unchanged; run "conductor build ${slug}" to be asked again.`);
  }
  if (answer && typeof answer === 'object' && typeof answer.note === 'string' && answer.note.trim()) {
    fixUnit({
      build, prefix: 'feedback', title: 'Operator feedback',
      instructions: `The operator looked at the finished build and asked for this change:\n${clip(redact(answer.note.trim()), 2000)}`,
    });
    build.phase = 'features';
    save();
    return { next: 'features' };
  }
  return finish('rejected', `You did not approve the build. The app's main branch is unchanged; the build is kept in ${buildDir}.`);

  // main moves to the build's tip by compare-and-swap, then project.json records the approval (Contract 7 §7.11).
  async function approve() {
    if (main !== sha) {
      const based = main ? await git(appDir, ['merge-base', '--is-ancestor', main, sha]) : { code: 1 };
      if (based.code !== 0) return finish('failed', MAIN_MOVED);
      const u = await git(appDir, ['update-ref', 'refs/heads/main', sha, main]);
      if (u.code !== 0) return finish('failed', MAIN_MOVED);
      main = sha;
    }
    const co = await git(appDir, ['checkout', '-q', 'main']);
    if (co.code !== 0) throw new Error(`git checkout main failed: ${firstLine(co.stderr) || `exit ${co.code}`}`);
    const project = loadProject(projectDir);   // the saved record, not a copy read at the start of the run
    const approved = { sha, at: now().toISOString(), runId: build.runId, briefVersion: build.briefVersion };
    bctx.project = { ...project, status: 'ready', approved, builtFromBrief: build.briefVersion };
    saveProject(projectDir, bctx.project);
    build.phase = 'done';
    return finish('ready', null);
  }
}
