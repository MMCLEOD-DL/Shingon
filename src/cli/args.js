// src/cli/args.js
import { parseArgs } from 'node:util';

export const USAGE = `Usage:
  conductor "<what you want done>"   start a new task in this repository
  conductor resume [<workspace>]     continue the latest unfinished run here (or the one given)
  conductor runs                     list unfinished runs for this repository
  conductor doctor                   check which AI models are available
Options:
  --config <file>        config file (default: ./conductor.json, then ~/.config/conductor/config.json)
  --test "<command>"     the command that runs this project's tests, e.g. "npm test"
  --approve-plan         show you the plan and ask before any step runs
  --approve-each-chunk   ask you before moving on after each step
  --watch-diffs          print each step's changes as it finishes
  --council              have specialist reviewers check security, licences and correctness before you approve
  --keep-workspace       keep Conductor's working copy after the run
  --no-bell              do not ring the terminal bell when Conductor needs you
  -h, --help             show this help
  --version              show the version`;

const OPTIONS = {
  config: { type: 'string' },
  test: { type: 'string' },
  'approve-plan': { type: 'boolean' },
  'approve-each-chunk': { type: 'boolean' },
  'watch-diffs': { type: 'boolean' },
  council: { type: 'boolean' },
  'keep-workspace': { type: 'boolean' },
  'no-bell': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
};
const SUBCOMMANDS = new Set(['resume', 'runs', 'doctor']);

export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    return { error: e.message };
  }
  const { values: v, positionals } = parsed;
  const flags = {
    config: v.config ?? null,
    testCommand: v.test ?? null,
    approvePlan: v['approve-plan'] === true,
    approveEachChunk: v['approve-each-chunk'] === true,
    watchDiffs: v['watch-diffs'] === true,
    keepWorkspace: v['keep-workspace'] === true,
    bell: v['no-bell'] !== true,
    council: v.council === true,
  };
  if (v.help) return { command: 'help', flags };
  if (v.version) return { command: 'version', flags };
  if (!positionals.length) return { command: 'help', flags };
  const [first, ...rest] = positionals;
  if (SUBCOMMANDS.has(first)) {
    if (first === 'resume') {
      if (rest.length > 1) return { error: 'resume takes at most one workspace path' };
      return { command: 'resume', workspaceDir: rest[0] ?? null, flags };
    }
    if (rest.length) return { error: `${first} takes no arguments` };
    return { command: first, flags };
  }
  const request = positionals.join(' ').trim();
  if (!request) return { error: 'the request is empty: say what you want done' };
  return { command: 'run', request, flags };
}
