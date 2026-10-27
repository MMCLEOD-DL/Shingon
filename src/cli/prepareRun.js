// src/cli/prepareRun.js — the team preparation every model-using command shares (Contract 7 §7.11): the Ctrl-C
// handler, checking and waking the workers, buildTeam, the local-down question, usage memory, and the run's
// hooks and overrides. Moved unchanged out of main(); `conductor build` (and later commands) call it too.
import { EXIT, STOPPED_BEFORE_START } from './main.js';
import { buildTeam, LOCAL_DOWN_WARNING } from '../team.js';
import { LOCAL_PAUSE_SETTING_REASON } from '../chunkPhase.js';
import { memoryFileFor, readWorkerMemory, recallWorkers, rememberWorkers, createUsageTracker } from '../workerMemory.js';
import { workersToCheck, ensureWorkers, cachedHealth, progressText, downMessage, workerLine } from '../readiness.js';
import { councilToolStatus } from '../council/index.js';
import { DEFAULT_OPTIONS } from '../options.js';
import { RunLog } from '../runlog.js';
import { metaDirOf } from '../workspace.js';
import { killAllChildren } from '../exec.js';
import { REASON_TEXT } from '../router.js';
import { redact } from '../secrets.js';
import { isSubscriptionKind } from '../vendors.js';

const INTERRUPTED = 'Stopped. Your repository is unchanged. To continue later, run:  conductor resume';
const INTERRUPTED_BEFORE_START = 'Stopped before anything started. Your repository is unchanged.';

// A subscription's ✓ only means its program runs (`--version`): its sign-in is first tested by a real call.
const SUBSCRIPTION_OK = ': installed (sign-in is checked when it is first used)';

function reportLines(report, statuses = [], lastUsed = new Map()) {
  const statusOf = (name) => statuses.find((s) => s.name === name);
  const lines = report.map((x) => {
    const s = statusOf(x.name);
    if (s) return workerLine(s, lastUsed.get(x.name) ?? null);
    return `  ${x.ok ? '✓' : '✗'} ${x.name} (${x.kind})${x.ok ? (isSubscriptionKind(x.kind) ? SUBSCRIPTION_OK : '') : `: ${REASON_TEXT[x.reason] ?? x.reason}${x.detail ? ` (${x.detail})` : ''}`}`;
  });
  // A remembered worker buildTeam does not probe (for example a self-hosted reviewer) is still shown.
  for (const s of statuses) if (!report.some((x) => x.name === s.name)) lines.push(workerLine(s, lastUsed.get(s.name) ?? null));
  return lines;
}

// The optional council tools, shown by `conductor doctor` only.
function councilLines(config, env) {
  return ['Council checks (used with --council):',
    ...councilToolStatus({ options: { ...DEFAULT_OPTIONS, ...config.options }, env })
      .map((t) => `  ${t.ok ? '✓' : '✗'} ${t.label}${t.ok ? '' : `: ${t.why}`}`)].join('\n');
}

// Returns { code } when the command ends here (doctor, nothing to run with, the operator stopped), otherwise
// { built, hooks, overrides, remember }. interruptedText replaces the Ctrl-C messages when given.
export async function prepareTeam({ cli, config, term, env, baseDir, workspaceDir = null, wakeDeps = {}, onSignal, exit, interruptedText }) {
  // Ctrl-C (Ruling 5). One handler for the whole command; what it does changes once the run starts.
  // Until then (checking, waking, asking) there is no run state: stop any wake program and leave.
  let onInterrupt = () => {
    killAllChildren();
    term.say(`\n${interruptedText ?? (cli.command === 'resume' ? INTERRUPTED : INTERRUPTED_BEFORE_START)}`);
    term.close();
    exit(EXIT.interrupted);
  };
  onSignal(() => onInterrupt());
  term.say('Checking which AI models are available…');
  // Factory spec §4.2: check (and wake) the workers before buildTeam, earlier runs' workers first.
  const memoryFile = memoryFileFor(baseDir);
  const recalled = recallWorkers(readWorkerMemory(memoryFile), config.participants);
  const lastUsed = new Map(recalled.map((x) => [x.participant.name, x.lastUsedAt]));
  const workers = workersToCheck(config.participants, recalled, { local: config.routing?.local ?? null });
  const check = (list) => ensureWorkers(list, {
    onProgress: (e) => { const t = progressText(e); if (t) term.say(t); },
    ...wakeDeps,
  });
  let statuses = [];
  // Checked workers answer from their readiness result; matched by name, so a re-checked one counts too.
  const build = () => buildTeam(config.participants, { routing: config.routing, env, health: cachedHealth(statuses, config.participants) });
  const couldNotCheck = (e) => {
    term.say(`Conductor could not check the AI models: ${redact(String(e?.message ?? e))}`);
    term.close();
    return { code: EXIT.failed };
  };
  let built;
  try {
    if (workers.length) {
      term.say('Checking the local workers…');
      statuses = await check(workers);
    }
    built = await build();
  } catch (e) {
    return couldNotCheck(e);
  }
  const downNotes = () => { for (const s of statuses) if (!s.ok) term.say(`Note: ${downMessage(s)}`); };
  const notBuilt = () => {
    term.say(reportLines(built.report, statuses, lastUsed).join('\n'));
    downNotes();
    term.say(built.error);
    if (cli.command === 'doctor') term.say(councilLines(config, env));
    term.close();
    return { code: EXIT.failed };
  };
  if (!built.ok) return notBuilt();
  if (cli.command === 'doctor') {
    // Ruling 5: doctor checks and wakes like a run, but never asks: it spends nothing.
    term.say(reportLines(built.report, statuses, lastUsed).join('\n'));
    term.say(`Author: ${built.team.author.name} · Reviewer: ${built.team.reviewer.name} · Local: ${built.team.local.name}`);
    for (const w of built.warnings) term.say(`Note: ${w}`);
    downNotes();
    term.say(councilLines(config, env));
    term.close();
    return { code: 0 };
  }

  // The local model is down and routing.localDown is "ask": nothing is spent until the operator says so.
  let approvedFallback = false;
  while (built.localDown) {
    const { name } = built.localDown;
    const participant = config.byName.get(name);
    const status = statuses.find((s) => s.name === name) ?? {
      name, kind: participant?.adapter.kind ?? 'local-agent', local: true, ok: false,
      reason: built.localDown.reason, detail: built.localDown.detail, woke: 'not-configured', wakeDetail: '', waitedMs: 0,
      hint: participant?.wake?.hint, method: participant?.wake?.method ?? 'warn',
    };
    const choice = await term.confirmLocalFallback({ message: downMessage(status), method: status.method });
    if (choice === 'frontier') {
      approvedFallback = true;
      built.warnings.push(LOCAL_DOWN_WARNING);
      break;
    }
    if (choice !== 'wait' || !participant) {
      term.say(STOPPED_BEFORE_START);
      term.close();
      return { code: EXIT.stopped };
    }
    try {
      term.say('Checking the local workers…');
      const [fresh] = await check([participant]);
      statuses = [...statuses.filter((s) => s.name !== name), fresh];
      built = await build();
    } catch (e) {
      return couldNotCheck(e);
    }
    if (!built.ok) return notBuilt();
  }
  for (const w of built.warnings) term.say(`Note: ${w}`);

  // Who served calls this run, remembered exactly once however the run ends (sync, never throws).
  const tracker = createUsageTracker(config.byName);
  let remembered = false;
  const remember = () => {
    if (remembered) return;
    remembered = true;
    rememberWorkers(memoryFile, tracker.used());
  };

  // Ctrl-C once the run starts: stop the agents, record it, leave the run resumable, exit 130.
  onInterrupt = () => {
    killAllChildren();
    remember();
    if (workspaceDir) {
      try { new RunLog(metaDirOf(workspaceDir)).event('interrupted', {}); } catch {}
    }
    term.say(`\n${interruptedText ?? INTERRUPTED}`);
    term.close();
    exit(EXIT.interrupted);
  };

  const localDownSetting = config.routing?.localDown ?? 'ask';
  const f = cli.flags;
  const overrides = {
    ...(f.testCommand ? { testCommand: f.testCommand } : {}),
    ...(f.approvePlan ? { approvePlan: true } : {}),
    ...(f.approveEachChunk ? { approveEachChunk: true } : {}),
    ...(f.watchDiffs ? { watchDiffs: true } : {}),
    ...(f.keepWorkspace ? { keepWorkspace: true } : {}),
    ...(f.council ? { council: true } : {}),
    allowSameVendor: built.allowSameVendor,
    // Task 7: ask mid-run, unless covering is the operator's standing choice or he already agreed for this run.
    confirmLocalFallback: localDownSetting !== 'frontier' && !approvedFallback,
  };
  const hooks = {
    onEvent: (e) => { tracker.onEvent(e); if (e.type === 'start' && e.workspace) workspaceDir = e.workspace; term.onEvent(e); },
    escalate: term.escalate, approveResult: term.approveResult, approveChunk: term.approveChunk, approvePlan: term.approvePlan,
    // The hook contract is "exactly true continues"; the terminal answers 'frontier' | 'stop'.
    confirmLocalFallback: localDownSetting === 'pause'
      ? async () => ({ reason: LOCAL_PAUSE_SETTING_REASON })
      : async ({ index, title, reason }) => (await term.confirmLocalFallback({
        message: `The local model stopped answering during step ${index + 1} (${title}): ${reason}`,
        midRun: true,
      })) === 'frontier',
  };
  return { built, hooks, overrides, remember };
}
