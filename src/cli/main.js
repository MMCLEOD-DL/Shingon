// src/cli/main.js
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCli, USAGE } from './args.js';
import { findConfig } from './config.js';
import { listRuns } from './runs.js';
import { loadConfig } from '../config.js';
import { buildTeam, LOCAL_DOWN_WARNING } from '../team.js';
import { LOCAL_PAUSE_SETTING_REASON } from '../chunkPhase.js';
import { memoryFileFor, readWorkerMemory, recallWorkers, rememberWorkers, createUsageTracker } from '../workerMemory.js';
import { workersToCheck, ensureWorkers, cachedHealth, progressText, downMessage, workerLine } from '../readiness.js';
import { councilToolStatus } from '../council/index.js';
import { DEFAULT_OPTIONS } from '../options.js';
import { runTask, resume } from '../conductor.js';
import { createTerminal } from '../ui/terminal.js';
import { RunLog } from '../runlog.js';
import { metaDirOf, defaultBaseDir } from '../workspace.js';
import { runCommand, killAllChildren } from '../exec.js';
import { REASON_TEXT } from '../router.js';
import { redact } from '../secrets.js';
import { isSubscriptionKind } from '../vendors.js';

export const EXIT = Object.freeze({ landed: 0, rejected: 1, stopped: 1, failed: 2, paused: 3, usage: 64, interrupted: 130 });
const NOT_A_REPO = 'Run conductor inside a git repository: the folder of the project you want changed.';
const INTERRUPTED = 'Stopped. Your repository is unchanged. To continue later, run:  conductor resume';
const INTERRUPTED_BEFORE_START = 'Stopped before anything started. Your repository is unchanged.';
export const STOPPED_BEFORE_START = 'Conductor did not start, so none of your subscription was used. Start the local model, then run the same command again (or run "conductor doctor" to check it).';

async function repoRoot(cwd) {
  const r = await runCommand({ cmd: 'git', args: ['rev-parse', '--show-toplevel'], cwd, timeoutMs: 15000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

function version() {
  const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
  return JSON.parse(readFileSync(pkg, 'utf8')).version;
}

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

function outcomeText(out) {
  const lines = [];
  if (out.status === 'landed') {
    lines.push(`Done. The result is on a new branch in your repository: ${out.branch}`,
      `See what changed:  git log --stat ${out.branch}`, `Merge it when you are happy:  git merge ${out.branch}`);
  } else if (out.status === 'rejected') {
    lines.push(`Not approved. Your repository is unchanged.${out.note ? ' Your note was saved with the run log.' : ''}`);
  } else {
    lines.push(out.reason ?? `The run ended: ${out.status}.`);
    if ((out.status === 'failed' || out.status === 'paused') && out.workspaceDir) lines.push('To continue from where it stopped, run:  conductor resume');
  }
  const log = out.transcript ?? (out.workspaceDir ? path.join(metaDirOf(out.workspaceDir), 'transcript.jsonl') : null);
  if (log) lines.push(`Full log: ${log}`);
  return lines.join('\n');
}

export async function main(argv, {
  cwd = process.cwd(), env = process.env, stdin = process.stdin, stdout = process.stdout,
  isTTY = Boolean(stdin.isTTY && stdout.isTTY),
  onSignal = (handler) => process.once('SIGINT', handler), exit = (code) => process.exit(code),
  wakeDeps = {},
} = {}) {
  const print = (s) => stdout.write(`${s}\n`);
  const cli = parseCli(argv);
  if (cli.error) { print(`${cli.error}\n\n${USAGE}`); return EXIT.usage; }
  if (cli.command === 'help') { print(USAGE); return 0; }
  if (cli.command === 'version') { print(version()); return 0; }

  const repoDir = await repoRoot(cwd);
  if (!repoDir) { print(NOT_A_REPO); return EXIT.usage; }
  // One location for listing, resuming and new runs (the library default unless the env overrides it).
  const baseDir = env.CONDUCTOR_BASE_DIR || defaultBaseDir(env);

  if (cli.command === 'runs') {
    const runs = listRuns({ baseDir, repoDir });
    if (!runs.length) { print('No unfinished runs for this repository.'); return 0; }
    for (const r of runs) print(`${r.status.padEnd(7)} ${r.done}/${r.total ?? '?'} steps  ${r.request}  (${r.workspaceDir})`);
    return 0;
  }

  let config;
  try {
    config = loadConfig(findConfig({ flag: cli.flags.config, cwd, env }));
  } catch (e) {
    print(`Conductor could not read its config: ${e.message}`);
    return EXIT.usage;
  }

  let workspaceDir = null;
  let seed = null;
  if (cli.command === 'resume') {
    workspaceDir = cli.workspaceDir ? path.resolve(cwd, cli.workspaceDir) : listRuns({ baseDir, repoDir })[0]?.workspaceDir ?? null;
    if (!workspaceDir) { print('There is no unfinished Conductor run for this repository.'); return 1; }
    try {
      const s = JSON.parse(readFileSync(path.join(metaDirOf(workspaceDir), 'state.json'), 'utf8'));
      if (s.plan?.chunks) seed = { chunks: s.plan.chunks.map((c) => c.title), done: s.chunkShas?.length ?? 0 };
    } catch {
      // resume() itself explains an unusable state
    }
  }

  const term = createTerminal({ input: stdin, output: stdout, isTTY, bell: cli.flags.bell });
  if (seed) term.model.seed(seed);
  // Ctrl-C (Ruling 5). One handler for the whole command; what it does changes once the run starts.
  // Until then (checking, waking, asking) there is no run state: stop any wake program and leave.
  let onInterrupt = () => {
    killAllChildren();
    term.say(`\n${cli.command === 'resume' ? INTERRUPTED : INTERRUPTED_BEFORE_START}`);
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
    return EXIT.failed;
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
    term.close();
    return EXIT.failed;
  };
  if (!built.ok) return notBuilt();
  if (cli.command === 'doctor') {
    // Ruling 5: doctor checks and wakes like a run, but never asks: it spends nothing.
    term.say(reportLines(built.report, statuses, lastUsed).join('\n'));
    term.say(`Author: ${built.team.author.name} · Reviewer: ${built.team.reviewer.name} · Local: ${built.team.local.name}`);
    for (const w of built.warnings) term.say(`Note: ${w}`);
    downNotes();
    term.say(['Council checks (used with --council):',
      ...councilToolStatus({ options: { ...DEFAULT_OPTIONS, ...config.options }, env })
        .map((t) => `  ${t.ok ? '✓' : '✗'} ${t.label}${t.ok ? '' : `: ${t.why}`}`)].join('\n'));
    term.close();
    return 0;
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
      return EXIT.stopped;
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
    term.say(`\n${INTERRUPTED}`);
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
  let out;
  try {
    out = cli.command === 'resume'
      ? await resume({ workspaceDir, repoDir, team: built.team, hooks, options: overrides, warnings: built.warnings })
      : await runTask({ repoDir, request: cli.request, team: built.team, hooks, options: { ...config.options, ...overrides }, baseDir, warnings: built.warnings });
  } catch (e) {
    remember();
    term.say(`Conductor could not start: ${redact(String(e?.message ?? e))}`);
    term.close();
    return EXIT.usage;
  }
  remember();
  term.say(`\n${outcomeText(out)}`);
  term.close();
  return EXIT[out.status] ?? EXIT.failed;
}
