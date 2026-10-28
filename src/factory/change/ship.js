// src/factory/change/ship.js — shipping a checked release as an update to every deployment of the project
// (Plan 11 Task 8; spec §4.8, Contracts 4 and 7.6).
//
// Every update goes through Plan 10's updateDeployment (reached through deps): Plan 10 runs the foundation's own
// updater on the box, records the outcome in deployments/<name>.json and owns those files. What this module adds is
// the order and the stop rules: one at a time, in name order; the ship guard again before each box; only
// CONTINUE_OUTCOMES carry on, and anything else (including an outcome Conductor does not know) stops the rest, so a
// version that failed on one box is never pushed to the next. Each result is saved before the next box is touched.
import path from 'node:path';
import { CONTINUE_OUTCOMES } from './seams.js';
import { shipProblem } from './gate.js';
import { isObject } from './gitSafe.js';
import { compareVersions } from '../foundationLog.js';
import { redact } from '../../secrets.js';
import { clip } from '../../text.js';

export const NO_DEPLOYMENTS = 'This project has no deployments yet, so nothing was updated. When you are ready, ship it with "conductor ship <slug> --to <deployment>".';

const CHECK_NEXT = (name) => `Check it with "conductor deployments status ${name}" before trying again.`;
const NEWER_NEXT = (name) => `This release is older than what the box runs, so there is nothing to ship there; check it with "conductor deployments status ${name}".`;

// Plan 10's pendingCheck: never shown calmer than Plan 10 left it (ruling S13).
function pendingSentence(name, r) {
  const v = r?.pendingVersion ?? 'an unknown version';
  if (r?.pendingWhy === 'urgent') {
    return `${name}: URGENT. An earlier update there (${v}) failed and its automatic undo also failed, so nothing was done there. Follow "Recovering from a failed update" in the foundation runbook now, then check it with "conductor deployments status ${name}".`;
  }
  return `${name}: Conductor did not see how an earlier update there (${v}) ended, so nothing was done there. ${CHECK_NEXT(name)}`;
}

// Outcomes this module records itself that are looked at again on resume without asking (nothing reached the box).
// A Plan 10 pendingCheck is read again from the record each time, so it is re-checked too.
const RECHECK = new Set(['not-set-up', 'newer', 'pending-check']);
const MESSAGE_MAX = 1000;
const OUTCOME_MAX = 60;

// What happened on one deployment, as one sentence. r is the saved result; version is the release being shipped.
function outcomeSentence(name, r, { version, slug = '<slug>' } = {}) {
  const message = typeof r?.message === 'string' ? r.message : '';
  const from = r?.from ?? 'its previous version';
  switch (r?.outcome) {
    case 'updated': return `${name}: updated to ${version}, with a backup taken first.`;
    case 'already-on': return `${name}: already on ${version}.`;
    case 'cancelled': return `${name}: the update was cancelled and nothing was changed there: ${message}`;
    case 'rolled-back': return `${name}: the new version failed its health check, so the box undid the update by itself. It is back on ${from} with its data as before.`;
    case 'busy': return `${name}: something else was already running on the box, so nothing was changed there: ${message}`;
    case 'settings-error': return `${name}: the box's settings are not right, so the update did not start: ${message}`;
    case 'urgent': return `${name}: URGENT. The update failed and the automatic undo also failed. Follow "Recovering from a failed update" in the foundation runbook now. ${message}`;
    case 'lost-contact': return `${name}: Conductor lost contact with the box during the update, so it does not know how it ended. Check it with "conductor deployments status" before trying again. ${message}`;
    // Not "nothing was changed" (Ruling Task 8): after an interrupt Plan 10's message may describe an earlier attempt.
    case 'refused': return `${name}: Conductor did not start the update there: ${message}`;
    case 'not-set-up': return `${name}: not set up yet, so it was not updated. Finish it with "conductor ship ${slug} --to ${name}".`;
    case 'newer': return `${name}: on ${from}, newer than ${version}, so it was left alone. ${NEWER_NEXT(name)}`;
    case 'started': return `${name}: Conductor did not see how the last attempt ended, so it may have stopped part-way. ${CHECK_NEXT(name)}`;
    case 'pending-check': return pendingSentence(name, r);
    case 'error': return `${name}: the update stopped with a problem Conductor did not expect, so it is treated as failed: ${message}`;
    default: return `${name}: the update ended in a way Conductor does not recognise (${r?.outcome}), so it is treated as failed.`;
  }
}

// Why a deployment did not update last time, for the retry question (the first part of its sentence only).
function lastTimeReason(r) {
  switch (r?.outcome) {
    case 'cancelled': return 'the update was cancelled';
    case 'rolled-back': return 'the new version failed its health check, so the box undid the update by itself';
    case 'busy': return 'something else was already running on the box';
    case 'settings-error': return "the box's settings are not right";
    case 'urgent': return 'the update failed and the automatic undo also failed';
    case 'lost-contact': return 'Conductor lost contact with the box during the update';
    case 'refused': return 'Conductor did not start the update there';
    case 'started': return 'Conductor started an update there but did not see how it ended';
    case 'error': return 'the update stopped with a problem Conductor did not expect';
    default: return `it ended in a way Conductor does not recognise (${r?.outcome})`;
  }
}

// A deployment added after the operator approved was never shown at the gate, so it is not shipped (final review
// item 6). Runs approved before the gate named its deployments (no list) ship to every deployment, as before.
const ADDED_AFTER_APPROVAL = (name, slug) => `${name}: not shipped: added after you approved; ship it with "conductor ship ${slug} --to ${name}".`;
function approvedAtGate(run, name) {
  const named = run?.approval?.deployments;
  return !Array.isArray(named) || named.includes(name);
}

// This project's deployments from Plan 10's listDeployments, sorted by name. An unreadable record of this project is
// a problem: Plan 10's own sentence already names the file and says what to do (Ruling C12), so it is passed through.
export function projectDeployments(deps, { projectsRoot, slug }) {
  let entries;
  try {
    entries = deps.listDeployments(projectsRoot, { slug });
    if (!Array.isArray(entries)) throw new Error('no list came back');
  } catch (e) {
    return { list: [], problem: `Conductor could not read this project's deployments (${redact(String(e?.message ?? e))}), so nothing was updated.` };
  }
  const mine = entries.filter((e) => isObject(e) && e.slug === slug && typeof e.name === 'string')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const resume = `No deployment was updated. When it is fixed, carry on with "conductor change ${slug} --resume".`;
  for (const e of mine) {
    if (e.problem || !isObject(e.deployment)) {
      const said = typeof e.problem === 'string' && e.problem ? redact(e.problem) : `The deployment record ${e.name} could not be read.`;
      return { list: [], problem: `${said} ${resume}` };
    }
  }
  return { list: mine.map((e) => ({ name: e.name, deployment: e.deployment })), problem: null };
}

export async function shipUpdate({ projectDir, projectsRoot, slug, run, version, foundation, deps, factory, say, state, ask, save }) {
  const { list, problem } = projectDeployments(deps, { projectsRoot, slug });
  if (problem) return { status: 'stopped', reason: problem };
  if (list.length === 0) return { status: 'done', reason: NO_DEPLOYMENTS };
  if (!isObject(run.deployments)) run.deployments = {};
  const stopped = (reason) => ({ status: 'stopped', reason });
  const at = () => (typeof deps.now === 'function' ? deps.now() : new Date()).toISOString();
  // Saved before the next box is touched: a result that cannot be saved stops the ship.
  const record = (name, result) => {
    run.deployments[name] = result;
    try {
      save(run);
      return null;
    } catch {
      return `Conductor could not record what happened on ${name}, so it stopped before the next deployment. ${outcomeSentence(name, result, { version, slug })}`;
    }
  };

  for (const [i, { name }] of list.entries()) {
    if (!approvedAtGate(run, name)) {
      try { say?.(ADDED_AFTER_APPROVAL(name, slug)); } catch { /* display only */ }
      continue;
    }
    // Read again before each box (Ruling Task 8): Plan 10 may have changed a record since the last one.
    const fresh = projectDeployments(deps, { projectsRoot, slug });
    // After the first box, earlier ones may already be updated: say only that the rest were not.
    if (fresh.problem) return stopped(i === 0 ? fresh.problem : fresh.problem
      .replace('No deployment was updated.', `${name} and the deployments after it were not updated.`)
      .replace(', so nothing was updated.', `, so ${name} and the deployments after it were not updated.`));
    const d = fresh.list.find((e) => e.name === name)?.deployment;
    if (!d) return stopped(`The deployment ${name} is no longer listed for this project, so it and the deployments after it were not updated.`);

    const before = run.deployments[name];
    if (CONTINUE_OUTCOMES.includes(before?.outcome)) continue;

    // Before the retry question and any version check (final review item 14): a box whose last update was never
    // checked is not "already on" anything, and trying it again is not the operator's next step.
    if (d.pendingCheck) {
      const pc = isObject(d.pendingCheck) ? d.pendingCheck : {};
      const result = {
        outcome: 'pending-check', at: at(), from: d.currentVersion,
        pendingWhy: typeof pc.why === 'string' ? clip(pc.why, OUTCOME_MAX) : 'unknown',
        pendingVersion: typeof pc.version === 'string' ? clip(redact(pc.version), OUTCOME_MAX) : 'an unknown version',
      };
      return stopped(record(name, result) ?? pendingSentence(name, result));
    }

    if (isObject(before) && !RECHECK.has(before.outcome)) {
      let answer = false;
      try { answer = await ask(before.outcome === 'started'
        ? `${name} may not have finished updating last time (${lastTimeReason(before)}). Try it again now?`
        : `${name} did not update last time (${lastTimeReason(before)}). Try it again now?`); } catch { answer = false; }
      if (answer !== true) return stopped(`You chose not to try ${name} again, so it and the deployments after it were not updated.`);
    }

    if (d.setup?.step !== 'done') {
      const unsaved = record(name, { outcome: 'not-set-up', at: at() });
      if (unsaved) return stopped(unsaved);
      continue;
    }

    const guard = await shipProblem(run, { appDir: path.join(projectDir, 'app') });
    if (guard) return stopped(guard);

    let order;
    try { order = compareVersions(d.currentVersion, version); } catch {
      return stopped(`Conductor could not tell which version ${name} is on (${clip(String(d.currentVersion), OUTCOME_MAX)}), so it and the deployments after it were not updated.`);
    }
    if (order === 0) {
      const unsaved = record(name, { outcome: 'already-on', message: '', at: at(), from: d.currentVersion });
      if (unsaved) return stopped(unsaved);
      continue;
    }
    if (order > 0) {
      const unsaved = record(name, { outcome: 'newer', message: '', at: at(), from: d.currentVersion });
      return stopped(unsaved ?? `${name} is on ${d.currentVersion}, newer than ${version}, so it was left alone. ${NEWER_NEXT(name)}`);
    }

    // Saved before the box is touched, so a crash during the update is asked about on resume.
    const marked = record(name, { outcome: 'started', at: at(), from: d.currentVersion });
    if (marked) return stopped(`Conductor could not record that it was starting on ${name}, so nothing was done there.`);

    let outcome, message;
    try {
      const r = await deps.updateDeployment({ projectDir, name, version, foundation, runId: run.runId }, { factory, say, state });
      outcome = r?.outcome;
      message = r?.message;
    } catch (e) {
      outcome = 'error';
      message = e?.message ?? String(e);
    }
    const result = {
      outcome: typeof outcome === 'string' ? clip(redact(outcome), OUTCOME_MAX) : String(outcome),
      message: clip(redact(typeof message === 'string' ? message : String(message ?? '')), MESSAGE_MAX),
      at: at(),
      from: d.currentVersion,
    };
    const unsaved = record(name, result);
    if (unsaved) return stopped(unsaved);
    if (!CONTINUE_OUTCOMES.includes(result.outcome)) return stopped(outcomeSentence(name, result, { version, slug }));
  }
  return { status: 'done', reason: null };
}

// One line per deployment from the saved results; one with no result was not attempted.
export function shipReport(run, list) {
  const version = run?.release?.version;
  const results = isObject(run?.deployments) ? run.deployments : {};
  const lines = list.map(({ name, deployment: d }) => {
    const r = results[name];
    const slug = typeof d?.project === 'string' ? d.project : '<slug>';
    if (!approvedAtGate(run, name)) return ADDED_AFTER_APPROVAL(name, slug);
    if (!isObject(r)) return `${name}: not updated (still on ${d?.currentVersion}), because an earlier deployment did not update.`;
    return outcomeSentence(name, r, { version, slug });
  });
  return ['Deployments:', ...lines.map((l) => `  ${l}`)].join('\n');
}
