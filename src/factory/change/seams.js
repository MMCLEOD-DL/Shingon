// src/factory/change/seams.js — the only file in Plan 11 that imports the deps functions from Plans 7–10.
// Everything that spends money, asks the operator or touches a machine reaches the other change modules through `deps`.
//
// Contract 7 mapping, checked against the merged code (Task 1 Step 0):
//   reviseBrief        wrapper below over Plan 7 briefSession.js importNotes(projectDir, notesFile, { now }) -> { name, bytes },
//                      newSession({ slug, mode, baseVersion, notes, now }), loadSession(projectDir, slug), saveSession(projectDir, session, { now }),
//                      and briefRun.js runBriefSession({ projectDir, session, author, io, log, operatorName, cwd, ... }).
//                      runBriefSession and the session functions take NO lock (the handler holds lockProject(dir, 'change')).
//   runBuild           Plan 8 build.js runBuild({ factory, slug, team, hooks, options, baseDir, warnings, env, deps })
//   runProjectCouncil  Plan 9 council/projectCouncil.js runProjectCouncil(args, { options, deps })
//   releaseApp         Plan 10 ship/release.js releaseApp({ projectDir, bump, runId, expectedMain }, { env, run })
//   updateDeployment   Plan 10 ship/index.js updateDeployment({ projectDir, name, version, foundation, runId }, { factory, say, state, ... })
//   listDeployments    Plan 10 deployments/store.js listDeployments(root, { slug }) -> [{ slug, projectDir, name, deployment, problem }]
//   loadBriefVersion / currentBriefVersion: thin helpers below over Plan 7 brief.js briefPaths, validateBrief, currentBriefInfo.
// Imported directly elsewhere (not seams): fsAtomic, projects, projectLock, brief, acceptance, ids, split, app, foundationLog.
import { readFileSync } from 'node:fs';
import { briefPaths, validateBrief, currentBriefInfo } from '../brief.js';
import { importNotes, newSession, loadSession, saveSession } from '../briefSession.js';
import { runBriefSession } from '../briefRun.js';
import { runBuild } from '../build.js';
import { runProjectCouncil } from '../../council/projectCouncil.js';
import { releaseApp } from '../ship/release.js';
import { updateDeployment } from '../ship/index.js';
import { listDeployments } from '../deployments/store.js';

export const DEP_NAMES = Object.freeze(['reviseBrief', 'runBuild', 'runProjectCouncil', 'releaseApp', 'updateDeployment', 'listDeployments']);
// Plan 10 outcomes after which a ship may carry on to the next box; anything else stops it.
export const CONTINUE_OUTCOMES = Object.freeze(['updated', 'already-on']);

export const NO_BRIEF_VERSION = (n) => `Brief version ${n} could not be read, so Conductor cannot tell what the app was built from. Nothing was changed.`;
export const NO_APPROVED_BRIEF = 'This project has no approved brief, so there is nothing to change. Approve a brief first with "conductor brief <slug>".';
const NOT_A_REVISION = 'An unfinished brief draft that is not a revision is waiting for this project. Finish or discard it with "conductor brief <slug>" first.';
const REVISION_OPEN = 'A brief revision for this project is already open. Carry it on with "conductor change <slug> --resume" instead of starting another.';
const NO_REVISION = 'There is no unfinished brief revision to continue.';

export function loadBriefVersion(projectDir, n) {
  try {
    const brief = JSON.parse(readFileSync(briefPaths(projectDir).json(n), 'utf8'));
    if (!validateBrief(brief, { stage: 'approved' }).ok) throw new Error('invalid');
    return brief;
  } catch {
    throw new Error(NO_BRIEF_VERSION(n));
  }
}

export function currentBriefVersion(projectDir) {
  const info = currentBriefInfo(projectDir);
  if (info === null) throw new Error(NO_APPROVED_BRIEF);
  if (info.broken) throw new Error(info.broken);
  return info.version;
}

export function makeReviseBrief({ importNotes: importFn, newSession: newFn, loadSession: loadFn, saveSession: saveFn, runBriefSession: runFn }) {
  return async function reviseBrief({ projectDir, slug, notesFile, author, io, log, operatorName, cwd }) {
    let session;
    try {
      const saved = loadFn(projectDir, slug);
      if (saved && saved.mode !== 'revise') return { status: 'stopped', reason: NOT_A_REVISION };
      if (notesFile) {
        if (saved) return { status: 'stopped', reason: REVISION_OPEN };
        const baseVersion = currentBriefVersion(projectDir); // before importing, so a project with no brief keeps no stray notes
        const imported = importFn(projectDir, notesFile);
        session = newFn({ slug, mode: 'revise', baseVersion, notes: [imported.name] });
        saveFn(projectDir, session);
      } else {
        if (!saved) return { status: 'stopped', reason: NO_REVISION };
        session = saved;
      }
    } catch (e) {
      return { status: 'stopped', reason: e.message };
    }
    return runFn({ projectDir, session, author, io, log, operatorName, cwd });
  };
}

export function realDeps() {
  return {
    reviseBrief: makeReviseBrief({ importNotes, newSession, loadSession, saveSession, runBriefSession }),
    runBuild, runProjectCouncil, releaseApp, updateDeployment, listDeployments,
    now: () => new Date(),
  };
}

export function missingSeams(deps) {
  return DEP_NAMES.filter((n) => typeof deps?.[n] !== 'function').sort();
}
