// src/cli/main.js
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCli, USAGE } from './args.js';
import { findConfig } from './config.js';
import { listRuns } from './runs.js';
import { FACTORY_COMMANDS, runFactoryCommand } from './factory.js';
import { loadConfig } from '../config.js';
import { refuseKnowledge } from '../knowledge/run.js';
import { runTask, resume } from '../conductor.js';
import { createTerminal } from '../ui/terminal.js';
import { prepareTeam } from './prepareRun.js';
import { metaDirOf, defaultBaseDir } from '../workspace.js';
import { killAllChildren, runCommand } from '../exec.js';
import { redact } from '../secrets.js';

export const EXIT = Object.freeze({ landed: 0, rejected: 1, stopped: 1, failed: 2, paused: 3, usage: 64, interrupted: 130 });
const NOT_A_REPO = 'Run conductor inside a git repository: the folder of the project you want changed.';
export const STOPPED_BEFORE_START = 'Conductor did not start, so none of your subscription was used. Start the local model, then run the same command again (or run "conductor doctor" to check it).';

async function repoRoot(cwd) {
  const r = await runCommand({ cmd: 'git', args: ['rev-parse', '--show-toplevel'], cwd, timeoutMs: 15000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

function version() {
  const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
  return JSON.parse(readFileSync(pkg, 'utf8')).version;
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
  wakeDeps = {}, factoryDeps = {},
} = {}) {
  const print = (s) => stdout.write(`${s}\n`);
  const cli = parseCli(argv);
  if (cli.error) { print(`${cli.error}\n\n${USAGE}`); return EXIT.usage; }
  if (cli.command === 'help') { print(USAGE); return 0; }
  if (cli.command === 'version') { print(version()); return 0; }

  if (Object.hasOwn(FACTORY_COMMANDS, cli.command)) {
    const code = await runFactoryCommand(cli, { cwd, env, stdin, stdout, isTTY, onSignal, exit, deps: factoryDeps });
    if (code !== null) return code;           // null = "not mine": carry on with the ordinary path (Contract 7 §7.11)
  }

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
    if (cli.flags.council) refuseKnowledge(config.options, 'the council (--council)');
  } catch (e) {
    print(`Conductor could not read its config: ${e.message}`);
    return EXIT.usage;
  }

  let workspaceDir = null;
  let seed = null;
  let baselinePending = false;
  if (cli.command === 'resume') {
    workspaceDir = cli.workspaceDir ? path.resolve(cwd, cli.workspaceDir) : listRuns({ baseDir, repoDir })[0]?.workspaceDir ?? null;
    if (!workspaceDir) { print('There is no unfinished Conductor run for this repository.'); return 1; }
    try {
      const s = JSON.parse(readFileSync(path.join(metaDirOf(workspaceDir), 'state.json'), 'utf8'));
      baselinePending = s.baselinePending === true;
      if (s.plan?.chunks) seed = { chunks: s.plan.chunks.map((c) => c.title), done: s.chunkShas?.length ?? 0 };
    } catch {
      // resume() itself explains an unusable state
    }
  }

  const term = createTerminal({ input: stdin, output: stdout, isTTY, bell: cli.flags.bell });
  if (seed) term.model.seed(seed);
  const testCommand = cli.flags.testCommand ?? config.options.testCommand;
  const resuming = cli.command === 'resume';
  const checkBaselineFirst = resuming ? baselinePending : cli.command !== 'doctor' && Boolean(testCommand);
  let prepared;
  let out;
  try {
    const prepareFor = (dir, registerSignal) => prepareTeam({
      cli, config, term, env, baseDir, workspaceDir: dir, wakeDeps, onSignal: registerSignal, exit,
    });
    let args;
    if (checkBaselineFirst) {
      let interrupt = () => {
        killAllChildren();
        term.say('\nStopped. Your repository is unchanged.');
        term.close();
        exit(EXIT.interrupted);
      };
      onSignal(() => interrupt());
      args = {
        options: resuming ? (cli.flags.testCommand ? { testCommand } : {}) : { ...config.options, testCommand },
        prepare: async (dir) => {
          prepared = await prepareFor(dir, handler => { interrupt = handler; });
          if ('code' in prepared) return { outcome: { status: prepared.code === EXIT.stopped ? 'stopped' : 'failed' } };
          const { built, hooks, overrides } = prepared;
          return { team: built.team, hooks, options: overrides, warnings: built.warnings };
        },
      };
    } else {
      prepared = await prepareFor(workspaceDir, onSignal);
      if ('code' in prepared) return prepared.code;
      const { built, hooks, overrides } = prepared;
      args = { team: built.team, hooks, options: resuming ? overrides : { ...config.options, ...overrides }, warnings: built.warnings };
    }
    out = resuming
      ? await resume({ ...args, workspaceDir, repoDir })
      : await runTask({ ...args, repoDir, request: cli.request, baseDir });
  } catch (e) {
    prepared?.remember?.();
    term.say(`Conductor could not start: ${redact(String(e?.message ?? e))}`);
    term.close();
    return EXIT.usage;
  }
  if (prepared && 'code' in prepared) return prepared.code;
  prepared?.remember();
  term.say(`\n${outcomeText(out)}`);
  term.close();
  return EXIT[out.status] ?? EXIT.failed;
}
