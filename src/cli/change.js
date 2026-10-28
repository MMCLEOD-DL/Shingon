// src/cli/change.js — `conductor change` and `conductor foundation-upgrade` (Plan 11, Task 11; Contract 5, Contract 7
// §7.3, §7.11). FACTORY_COMMANDS handlers: (cli, ctx) -> exit code. They hold the project lock around the whole run;
// the pipeline (src/factory/change/pipeline.js) never takes it.
import { statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { EXIT } from './main.js';
import { prepareTeam } from './prepareRun.js';
import { loadConfig } from '../config.js';
import { readProject } from '../factory/projects.js';
import { lockProject } from '../factory/projectLock.js';
import { briefAuthorSeat } from '../factory/briefTeam.js';
import { terminalText } from '../factory/brief.js';
import { interruptShip } from '../factory/ship/index.js';
import { realDeps, missingSeams } from '../factory/change/seams.js';
import { runChange, runFoundationUpgrade, resumeChange, abandonChange, MISSING_SEAMS } from '../factory/change/pipeline.js';
import { findUnfinishedRun } from '../factory/change/run.js';
import { securityBehind, behindText } from '../factory/change/behind.js';
import { createTerminal } from '../ui/terminal.js';
import { defaultBaseDir } from '../workspace.js';
import { redact } from '../secrets.js';

export const NO_TTY_CHANGE = 'There is no terminal to ask you, so Conductor did not start. A change needs your answers and your approval: run it in a terminal.';
export const INTERRUPTED_CHANGE = (slug, cmd) => `Stopped. Nothing was shipped beyond what the report above says. To continue, run:  conductor ${cmd} ${slug} --resume`;
export const NOTES_UNREADABLE = (file) => `The notes file ${file} could not be read.`;
const INTERRUPTED_BEFORE_START = 'Stopped before anything started. Nothing was changed.';
// Ruling C12: resume hints name `conductor change`, which carries on a change or an upgrade alike.
const RESUME_CMD = 'change';

// The operator is told the outcome's status (Task 9); done is the one success.
// (EXIT is read at call time: main.js imports this module through factory.js.)
const OUTCOMES = new Set(['done', 'rejected', 'stopped', 'failed', 'paused']);
const exitFor = (status) => (status === 'done' ? 0 : OUTCOMES.has(status) ? EXIT[status] : EXIT.failed);

// The last hop: model, box and adapter text reaches the terminal, so escape characters go first, then secrets.
const clean = (s) => redact(terminalText(String(s ?? '')));
const plain = (e) => clean(String(e?.message ?? e)).trim();

function readConfig(ctx) {
  if (ctx.config) return ctx.config;
  if (!ctx.configPath) throw new Error('no config file was found (give one with --config <file>).');
  return loadConfig(ctx.configPath);
}

function notesReadable(file) {
  try {
    if (!statSync(file).isFile()) return false;
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

function outcomeCode(outcome, print) {
  const text = outcome?.report ?? outcome?.reason;
  if (text) print(text);
  return exitFor(outcome?.status);
}

async function securityCheck(ctx, deps, print) {
  let rows;
  try {
    rows = await securityBehind({ projectsRoot: ctx.factory.projectsRoot, deps });
  } catch (e) {
    print(`Conductor could not check the projects in ${ctx.factory.projectsRoot}: ${plain(e)}`);
    return EXIT.failed;
  }
  print(behindText(rows));
  return rows.some((r) => r.problem) ? 1 : 0;
}

// The shared handler. mode: 'notes' | 'to' | 'resume' | 'abandon' | 'check'.
async function changeHandler(cli, ctx, mode) {
  const print = (s) => ctx.stdout.write(`${clean(s)}\n`);
  const { factory, env } = ctx;
  const deps = ctx.deps?.change ?? realDeps();
  const missing = missingSeams(deps);
  if (missing.length) { print(MISSING_SEAMS(missing)); return EXIT.failed; }
  if (mode === 'check') return securityCheck(ctx, deps, print);

  const { slug } = cli;
  let projectDir;
  try { projectDir = readProject(factory.projectsRoot, slug).dir; } catch (e) { print(plain(e)); return EXIT.usage; }
  // The handler holds the project lock around the whole command (Contract 7 §7.11); nothing it calls takes it again.
  let release;
  try {
    release = lockProject(projectDir, 'change', ctx.deps?.isAlive ? { isAlive: ctx.deps.isAlive } : {});
  } catch (e) { print(plain(e)); return EXIT.stopped; }

  let term = null;
  try {
    const base = { factory, slug, deps, env, cwd: ctx.cwd };
    if (mode === 'abandon') {
      const out = await abandonChange(base);
      // A dropped run is what was asked for; a refusal (nothing to drop) is not.
      return out?.status === 'stopped' && out.runId ? (print(out.reason), 0) : outcomeCode(out, print);
    }

    // Questions, the gate and retries need someone to answer: refuse before anything is spent.
    if (!ctx.isTTY) { print(NO_TTY_CHANGE); return EXIT.stopped; }
    if (mode === 'notes' && !notesReadable(path.resolve(ctx.cwd, cli.notesFile))) { print(NOTES_UNREADABLE(cli.notesFile)); return EXIT.usage; }
    let config;
    try { config = readConfig(ctx); } catch (e) { print(`Conductor could not read its config: ${plain(e)}`); return EXIT.usage; }

    term = createTerminal({ input: ctx.stdin, output: ctx.stdout, isTTY: ctx.isTTY, bell: cli.flags.bell });
    const say = (s) => term.say(clean(s));
    const baseDir = env.CONDUCTOR_BASE_DIR || defaultBaseDir(env);
    const shipState = {};
    let started = false;
    // Ruling C9: prepareTeam owns the one Ctrl-C handler; its exit runs this, which frees what the run holds.
    const exit = (code) => {
      if (shipState.phase) print(interruptShip(shipState)); // records the unconfirmed update, frees the deployment lock
      print(started ? INTERRUPTED_CHANGE(slug, RESUME_CMD) : INTERRUPTED_BEFORE_START);
      release();
      ctx.exit(code);
    };
    const p = await (ctx.deps?.prepareTeam ?? prepareTeam)({
      cli, config, term, env, baseDir, onSignal: ctx.onSignal, exit, interruptedText: '',
    });
    if ('code' in p) return p.code;

    // The brief's author seat (Plan 7): only a change still at its brief step needs one.
    let author = null;
    let needsAuthor = mode === 'notes';
    if (mode === 'resume') {
      try { needsAuthor = findUnfinishedRun(projectDir)?.stage === 'brief'; } catch { needsAuthor = false; } // resume says why
    }
    if (needsAuthor) {
      const buildAuthor = ctx.deps?.buildAuthor ?? ((c, e) => briefAuthorSeat(c.participants, { routing: c.routing, env: e }));
      let seat;
      try { seat = await buildAuthor(config, env); } catch (e) { seat = { ok: false, error: `Conductor could not check the AI models: ${plain(e)}` }; }
      if (!seat.ok) { p.remember(); say(seat.error); return EXIT.failed; }
      for (const w of seat.warnings ?? []) say(`Note: ${w}`);
      author = seat.seat;
    }

    const changeTerm = {
      say,
      onEvent: p.hooks.onEvent ?? term.onEvent, // prepareTeam's records who served calls, then draws
      // Fail closed: without a terminal every question is "no" (the refusal above makes this belt and braces).
      escalate: (esc) => (ctx.isTTY ? term.escalate({ ...esc, title: clean(esc?.title ?? ''), message: clean(esc?.message ?? '') }) : 'reject'),
      approveBuild: (a) => (ctx.isTTY ? term.approveBuild({ ...a, summary: clean(a?.summary ?? '') }) : false),
      briefIo: { say, ask: term.askBriefQuestion, approve: term.approveBrief },
    };
    const args = {
      ...base, team: p.built.team, author, term: changeTerm, options: { ...config.options, ...p.overrides },
      baseDir, warnings: p.built.warnings, hooks: { ...p.hooks }, shipState,
    };
    started = true;
    let outcome;
    try {
      outcome = mode === 'notes' ? await runChange({ ...args, notesFile: cli.notesFile })
        : mode === 'to' ? await runFoundationUpgrade({ ...args, toTag: cli.toTag })
          : await resumeChange(args);
    } catch (e) {
      p.remember();
      say(`Conductor could not carry on with the change: ${plain(e)}`);
      return EXIT.failed;
    }
    p.remember();
    say('');
    return outcomeCode(outcome, say);
  } finally {
    term?.close();
    release();
  }
}

export function runChangeCommand(cli, ctx) {
  return changeHandler(cli, ctx, cli.abandon ? 'abandon' : cli.resume ? 'resume' : 'notes');
}

export function runUpgradeCommand(cli, ctx) {
  return changeHandler(cli, ctx, cli.check ? 'check' : cli.abandon ? 'abandon' : cli.resume ? 'resume' : 'to');
}
