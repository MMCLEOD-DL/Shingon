// src/factory/build.js — `conductor build <slug>`: one build of one client app (spec §4.2).
// Phases setup → split → features → final, each re-entrant: build.json is saved after every step that
// matters, so running the command again carries on from the last saved point (Review Focus 1).
// runBuild never takes the project lock: its caller (the build/resume handler) holds it (Contract 7 §7.11).
import { readdirSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { runTask as realRunTask, resume as realResume } from '../conductor.js';
import { DEFAULT_OPTIONS } from '../options.js';
import { RunLog } from '../runlog.js';
import { git, defaultBaseDir } from '../workspace.js';
import { FEATURE_COUNCIL } from '../council/index.js';
import { readProject, saveProject } from './projects.js';
import { loadBrief as realLoadBrief, renderBrief as realRenderBrief, currentBriefInfo as realCurrentBriefInfo } from './brief.js';
import { createApp, nameApp } from './app.js';
import { featureRequest, acceptanceStep } from './featureRequest.js';
import { runSplit, briefProblems } from './split.js';
import { runAppChecks as realRunAppChecks, testDatabaseProblem, VERIFY_COMMAND } from './checks.js';
import {
  buildDirOf, loadBuild, saveBuild, newBuild, hashBrief, appendBuildLog, readRunState, archiveFeatureRun,
  mergeFeature as realMergeFeature,
} from './buildState.js';
import { newRunId } from './ids.js';

const UNFINISHED = new Set(['running', 'paused', 'failed', 'stopped']);
const RESUMABLE_RUN = new Set(['running', 'failed', 'paused']);
const DIRTY = 'The app folder has changes Conductor did not make, so it stopped. Nothing was changed.';
const notWhereLeft = (branch) => `The build branch ${branch} is not where Conductor left it, so it stopped rather than guess. Nothing was changed.`;

// A problem whose message is already plain English for the operator (not an internal fault).
class PlainError extends Error {}

const defaultDeps = () => ({
  runTask: realRunTask, resume: realResume, runAppChecks: realRunAppChecks,
  loadBrief: realLoadBrief, renderBrief: realRenderBrief, currentBriefInfo: realCurrentBriefInfo,
  mergeFeature: realMergeFeature,
  runFinal: (bctx) => import('./buildFinal.js').then((m) => m.runFinal(bctx)),
  now: () => new Date(),
});

// The newest build record (not a change). Unlike latestBuild, a damaged newest record is reported, not skipped
// (ruling Q27 d): skipping it would quietly start a second build beside the one the operator expects to resume.
function newestBuild(projectDir) {
  let names;
  try { names = readdirSync(path.join(projectDir, 'builds')).sort().reverse(); } catch { return null; }
  for (const n of names) {
    const b = loadBuild(buildDirOf(projectDir, n));   // throws a plain message when unreadable
    if (b && b.kind !== 'change') return b;
  }
  return null;
}

async function gitOut(cwd, args) {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || '').trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

export async function runBuild({ factory, slug, team, hooks, options = {}, baseDir, warnings = [], env = process.env, deps = {} }) {
  const d = { ...defaultDeps(), ...deps };
  baseDir ??= defaultBaseDir(env);   // ruling Q4
  const refuse = (reason) => ({ status: 'failed', runId: null, buildDir: null, reason });

  // Refusals before anything is spent (index Ruling 10), in this order.
  let projectDir;
  let project;
  try { ({ dir: projectDir, project } = readProject(factory.projectsRoot, slug)); } catch (e) { return refuse(e.message); }
  if (project.status === 'ready' || project.status === 'shipped') {
    return refuse(`${project.client} is already built and approved. Changes to a finished app will go through "conductor change", which is not available yet.`);
  }
  let brief;
  try { brief = d.loadBrief(projectDir); } catch (e) { return refuse(e.message); }
  const problems = briefProblems(brief);
  if (problems.length) return refuse(problems.join(' '));
  const dbProblem = testDatabaseProblem({ testCommand: factory.build.testCommand, env });
  if (dbProblem) return refuse(dbProblem);

  // Which build: carry on with an unfinished one, or start a new one.
  let latest;
  try { latest = newestBuild(projectDir); } catch (e) {
    if (!options.newBuild) return refuse(e.message);
    latest = null;   // --new: the damaged record is left as it is
  }
  const briefHash = hashBrief(brief);
  const unfinished = latest && UNFINISHED.has(latest.status) ? latest : null;
  let build;
  let resumed = false;
  if (unfinished && !options.newBuild) {
    if (unfinished.briefHash !== briefHash) {
      return refuse(`The brief has changed since build ${unfinished.runId} started, so Conductor will not mix the two. Run "conductor build ${slug} --new" to start a fresh build from the current brief.`);
    }
    build = unfinished;
    resumed = true;
  } else {
    const now = d.now();
    const runId = newRunId(now);
    if (unfinished) {
      unfinished.status = 'stopped';
      unfinished.reason = `Replaced by build ${runId}.`;
      saveBuild(buildDirOf(projectDir, unfinished.runId), unfinished);
    }
    const foundation = project.foundation?.tag ? { ...project.foundation } : null;
    // Ruling Q14: the version of the brief actually loaded, not a second read.
    build = newBuild({ runId, slug, client: brief.client, briefHash, briefVersion: brief.version ?? null, foundation, now });
  }

  const buildDir = buildDirOf(projectDir, build.runId);
  const appDir = path.join(projectDir, 'app');
  const save = () => saveBuild(buildDir, build);
  const emit = (type, data = {}) => {
    try { appendBuildLog(buildDir, type, data); } catch { /* the log is best effort; build.json is the record */ }
    try { hooks.onEvent?.({ type, ...data }); } catch { /* a display hook never stops a build */ }
  };
  const progress = (text) => { try { hooks.onProgress?.(text); } catch { /* display only */ } };
  const finish = (status, reason) => {
    build.status = status;
    build.reason = reason ?? null;
    save();
    emit('build-finish', { status, reason: reason ?? null });
    return { status, runId: build.runId, buildDir, ...(reason ? { reason } : {}) };
  };

  // Options for the feature runs and the split: runBuild's own keys never reach runTask (Contract 7 §7.7),
  // and the operator approves the whole build at the gate, not every feature's plan (ruling Q16).
  const { newBuild: _newBuild, change: _change, approvePlan: _approvePlan, ...runOptions } = options;
  let localFallbackOk = false;

  const bctx = {
    factory, slug, projectDir, appDir, buildDir, project, brief, build, team, hooks, options, baseDir, warnings, env, deps: d,
    save, emit, progress, finish, runFeatures: () => featuresPhase(),
  };

  // ---- setup ---------------------------------------------------------------------------------------------
  async function setupPhase() {
    const pinned = bctx.project.foundation?.tag ? bctx.project.foundation : null;
    // Ruling Q27 a: a first build uses factory.foundation, which factoryConfig validated.
    const foundation = pinned ? { repo: pinned.repo, tag: pinned.tag } : { repo: factory.foundation.repo, tag: factory.foundation.tag };
    let commit;
    try {
      ({ commit } = await createApp({ projectDir, foundation, expectCommit: pinned?.commit ?? null }));
    } catch (e) { throw new PlainError(e.message); }
    const recorded = { repo: foundation.repo, tag: foundation.tag, commit };
    if (!pinned || bctx.project.status !== 'building') {
      bctx.project = { ...bctx.project, foundation: pinned ? bctx.project.foundation : recorded, status: 'building' };
      saveProject(projectDir, bctx.project);
    }
    build.foundation = recorded;
    save();

    if (!build.baseline) {
      const sha = await gitOut(appDir, ['rev-parse', '--verify', 'refs/heads/main^{commit}']);
      progress('Checking that the foundation passes its own checks');
      const c = await d.runAppChecks({
        appDir, sha, workDir: path.join(buildDir, 'check'), reportsDir: path.join(buildDir, 'baseline'),
        testCommand: factory.build.testCommand, browser: false, env,
      });
      // The output goes to the build log only.
      try { appendBuildLog(buildDir, 'baseline', { sha, status: c.verify.status, summary: c.verify.summary, output: c.verify.output ?? '' }); } catch { /* best effort */ }
      if (c.verify.status !== 'passed') {
        return finish('failed', `The foundation does not pass its own checks on this computer, so building on it would hide problems. ${c.verify.summary} The output is in ${path.join(buildDir, 'build-log.jsonl')}.`);
      }
      build.baseline = { status: c.verify.status, summary: c.verify.summary };
      save();
    }

    await assertClean();
    const exists = (await git(appDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${build.branch}`])).code === 0;
    if ((await currentBranch()) !== build.branch) {
      await gitOut(appDir, exists ? ['checkout', '-q', build.branch] : ['checkout', '-q', '-b', build.branch, 'main']);
    }
    try { await nameApp({ appDir, brief }); } catch (e) { throw new PlainError(e.message); }
    build.baseSha = await gitOut(appDir, ['rev-parse', 'HEAD']);
    build.phase = 'split';
    save();
    return null;
  }

  async function currentBranch() {
    const r = await git(appDir, ['symbolic-ref', '-q', '--short', 'HEAD']);
    return r.code === 0 ? r.stdout.trim() : null;
  }
  async function assertClean() {
    const st = await git(appDir, ['status', '--porcelain']);
    if (st.code !== 0 || st.stdout.trim()) throw new PlainError(DIRTY);
  }

  // ---- split ---------------------------------------------------------------------------------------------
  async function splitPhase() {
    progress('Splitting the brief into features');
    // A scratch clone of the app, outside the project folder (Ruling 8): the author reads the code, not notes/.
    mkdirSync(baseDir, { recursive: true });
    const cwd = path.join(baseDir, `split-${build.runId}`);
    rmSync(cwd, { recursive: true, force: true });
    let r;
    try {
      await gitOut(baseDir, ['clone', '--quiet', '--no-hardlinks', appDir, cwd]);
      const log = new RunLog(path.join(buildDir, 'split'), { onEvent: hooks.onEvent });
      r = await runSplit({ team, hooks, log, cwd, options: { ...DEFAULT_OPTIONS, ...runOptions }, usage: build.usage, renderBrief: d.renderBrief }, brief);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    save();   // usage
    if (r.status !== 'ok') return finish(r.status, r.reason);
    build.units = r.units;
    build.features = r.units.map((u) => ({
      id: u.id, title: u.title, status: 'pending', attempts: 0, workspaceDir: null, branch: null, landedSha: null,
      baseSha: null, mergedSha: null, transcript: null, notes: [], councilText: null, gateReason: null,
    }));
    if (r.note && !build.notes.includes(r.note)) build.notes.push(r.note);
    save();
    emit('build-split', { units: r.units.map((u) => ({ id: u.id, title: u.title })) });
    if (options.approvePlan) {
      let ok;
      try { ok = await hooks.approvePlan({ summary: 'Features to build, in order:', steps: r.units.map((u) => u.title) }); } catch { ok = false; }
      if (ok !== true) return finish('stopped', 'You did not approve the list of features, so nothing was built.');
    }
    build.phase = 'features';
    save();
    return null;
  }

  // ---- features ------------------------------------------------------------------------------------------
  async function featuresPhase() {
    for (let i = 0; i < build.features.length; i++) {
      const f = build.features[i];
      if (f.status === 'merged') {
        // Merged before a crash that came before its workspace was archived.
        if (f.workspaceDir && !f.transcript) {
          f.transcript = archiveFeatureRun({ workspaceDir: f.workspaceDir, buildDir, index: i, id: f.id });
          f.workspaceDir = null;
          save();
        }
        continue;
      }
      progress(`Feature ${i + 1} of ${build.features.length}: ${f.title}`);
      const r = await runFeature(i);
      if (r) return r;
    }
    return null;
  }

  async function runFeature(i) {
    const f = build.features[i];
    const unit = build.units[i];
    const total = build.units.length;
    if ((await currentBranch()) !== build.branch) {
      await assertClean();
      await gitOut(appDir, ['checkout', '-q', build.branch]);
    }
    // Landed and recorded before a crash: only the merge is left. This comes before the clean check:
    // a crash inside mergeFeature after the branch moved leaves the checkout at the old base (it looks dirty),
    // and mergeFeature itself repairs that, with its own position and dirty checks (buildState.js).
    if (f.status === 'landed' && f.landedSha && f.branch && f.baseSha) return mergeLanded(i);
    await assertClean();
    const head = await gitOut(appDir, ['rev-parse', '--verify', `refs/heads/${build.branch}^{commit}`]);
    if (f.baseSha && f.baseSha !== head) throw new PlainError(notWhereLeft(build.branch));

    const runOpts = {
      ...runOptions,
      testCommand: factory.build.testCommand ?? VERIFY_COMMAND,
      keepWorkspace: true,
      council: true,
      councilMembers: [...FEATURE_COUNCIL],
      factoryFeature: { id: unit.id, tags: [...(unit.acceptance ?? [])] },   // the member gets ws.baseSha from the run (ruling Q27 b)
      firstChunk: acceptanceStep({ brief, unit }),
    };
    const featureHooks = featureHooksFor(i);
    const state = f.workspaceDir ? readRunState(f.workspaceDir) : null;
    let out;
    if (state?.status === 'landed' && state.branch && state.landing?.sha) {
      out = { status: 'landed', branch: state.branch, workspaceDir: f.workspaceDir };   // landed before a crash
    } else if (RESUMABLE_RUN.has(state?.status)) {
      emit('build-feature', { index: i, total, id: f.id, title: f.title, attempt: f.attempts });
      f.status = 'running';
      save();
      out = await d.resume({ workspaceDir: f.workspaceDir, repoDir: appDir, team, hooks: featureHooks, options: runOpts, warnings });
    } else {
      if (f.workspaceDir) archiveFeatureRun({ workspaceDir: f.workspaceDir, buildDir, index: i, id: f.id });
      Object.assign(f, { workspaceDir: null, branch: null, landedSha: null, mergedSha: null, gateReason: null, councilText: null, status: 'running', baseSha: head });
      f.attempts += 1;
      save();
      emit('build-feature', { index: i, total, id: f.id, title: f.title, attempt: f.attempts });
      out = await d.runTask({
        repoDir: appDir, request: featureRequest({ brief, units: build.units, index: i }), team, hooks: featureHooks, options: runOpts, baseDir, warnings,
      });
    }
    save();   // usage from the run's result events

    if (out.status === 'landed') {
      const st = readRunState(out.workspaceDir ?? f.workspaceDir);
      const landedSha = st?.landing?.sha;
      if (!landedSha || !out.branch) throw new Error(`feature ${f.id} landed but its run state has no landing commit`);
      f.workspaceDir = out.workspaceDir ?? f.workspaceDir;
      f.status = 'landed';
      f.branch = out.branch;
      f.landedSha = landedSha;
      f.notes = Array.isArray(st.notes) ? [...st.notes] : [];
      for (const w of st.warnings ?? []) if (!build.warnings.includes(w)) build.warnings.push(w);
      save();   // landedSha and expectedBase are on disk before the merge (ruling Q27 c)
      return mergeLanded(i);
    }
    if (out.status === 'paused' || out.status === 'failed') {
      f.status = out.status;
      return finish(out.status, out.reason);
    }
    f.status = 'stopped';
    return finish('stopped', `Feature ${i + 1} (${f.title}) was not accepted: ${f.gateReason ?? out.reason} Fix the cause, then run "conductor build ${slug}" to try that feature again.`);
  }

  async function mergeLanded(i) {
    const f = build.features[i];
    const unit = build.units[i];
    const k = i + 1;
    const n = build.units.length;
    const message = unit.kind === 'fix' ? `Fix ${k}/${n}: ${f.title}` : `Feature ${k}/${n}: ${f.title} (${f.id})`;
    const sha = await d.mergeFeature({ appDir, buildBranch: build.branch, landedBranch: f.branch, landedSha: f.landedSha, expectedBase: f.baseSha, message });
    f.mergedSha = sha;
    f.status = 'merged';
    save();
    if (f.workspaceDir) {
      f.transcript = archiveFeatureRun({ workspaceDir: f.workspaceDir, buildDir, index: i, id: f.id });
      f.workspaceDir = null;
      save();
    }
    emit('build-feature-done', { index: i, id: f.id, status: 'merged', sha });
    return null;
  }

  function featureHooksFor(i) {
    const f = build.features[i];
    const total = build.units.length;
    const what = `feature ${i + 1} of ${total} (${f.title})`;
    const fh = {
      ...hooks,
      onEvent: (e) => {
        if (e?.type === 'start' && typeof e.workspace === 'string') { f.workspaceDir = e.workspace; save(); }
        if (e?.type === 'result' && typeof e.costUsd === 'number' && Number.isFinite(e.costUsd)) build.usage.costUsd += e.costUsd;
        try { hooks.onEvent?.(e); } catch { /* a display hook never stops a build */ }
      },
      // The feature's gate, answered here, fail closed (Ruling 7).
      approveResult: async ({ tests, council, finalReview } = {}) => {
        f.councilText = council?.text ?? null;
        const decide = (ok, reason = null) => { f.gateReason = reason; save(); return ok; };
        if (tests?.passed !== true) return decide(false, 'its checks (npm run verify) still fail.');
        if (council?.verdict === 'blocked' && !council.overridden) return decide(false, 'the feature council still found problems.');
        if (finalReview?.decision === 'BLOCK') {
          const message = `Conductor needs your decision on: ${what}\n\nWhat happened: The final review of this feature raised a concern, although its checks pass.\n\nThe concern: ${finalReview.reason}\n\nApprove to add the feature to the build, or reject to stop the build here (you can carry on later).`;
          let answer;
          try { answer = await hooks.escalate({ kind: 'feature', title: what, options: ['approve', 'reject'], message }); } catch { answer = null; }
          if (answer === 'approve') return decide(true);
          return decide(false, "you did not accept the reviewer's concern.");
        }
        return decide(true);
      },
    };
    delete fh.confirmLocalFallback;
    if (typeof hooks.confirmLocalFallback === 'function') {
      // Asked once per process; a yes is remembered for the rest of the build.
      fh.confirmLocalFallback = async (arg) => {
        if (localFallbackOk) return true;
        const ok = await hooks.confirmLocalFallback(arg);
        if (ok === true) localFallbackOk = true;
        return ok;
      };
    }
    return fh;
  }

  // ---- the build -----------------------------------------------------------------------------------------
  try {
    if (resumed) { build.status = 'running'; build.reason = null; }
    save();
    emit('build-start', { runId: build.runId, slug, resumed });
    for (;;) {
      if (build.phase === 'setup') { const r = await setupPhase(); if (r) return r; }
      if (build.phase === 'split') { const r = await splitPhase(); if (r) return r; }
      if (build.phase === 'features') {
        const r = await featuresPhase();
        if (r) return r;
        build.phase = 'final';
        save();
      }
      if (build.phase === 'final' || build.phase === 'gate') {   // ruling Q8
        const r = await d.runFinal(bctx);
        if (r?.next === 'features') { build.phase = 'features'; save(); continue; }
        return r;
      }
      throw new Error(`build ${build.runId} is in an unknown phase (${build.phase})`);
    }
  } catch (e) {
    const detail = String(e?.message ?? e);
    emit('build-error', { detail });
    const reason = e instanceof PlainError
      ? `${detail} Run "conductor build ${slug}" to carry on once it is sorted.`
      : `Conductor hit an internal problem and stopped. The build so far is kept; run "conductor build ${slug}" to carry on. Details are in ${path.join(buildDir, 'build-log.jsonl')}.`;
    try { return finish('failed', reason); } catch { return { status: 'failed', runId: build.runId, buildDir, reason }; }
  }
}
