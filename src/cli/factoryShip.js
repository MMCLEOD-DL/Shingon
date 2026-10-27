// src/cli/factoryShip.js — `conductor ship` and `conductor deployments` (Contract 5, Contract 7 §7.11).
// FACTORY_COMMANDS handlers: (cli, ctx) -> exit code. ship needs no AI participants, so it never reads ctx.config.
import { createAsk } from '../ui/ask.js';
import { shipProject, interruptShip } from '../factory/ship/index.js';
import { SHIP_EXIT } from '../factory/ship/outcomes.js';
import { newRunId } from '../factory/ids.js';
import { terminalText } from '../factory/brief.js';
import { killAllChildren } from '../exec.js';
import { redact } from '../secrets.js';

export async function shipCommand(cli, ctx) {
  const print = (s) => ctx.stdout.write(`${redact(terminalText(s))}\n`);
  const ask = createAsk({ input: ctx.stdin, output: ctx.stdout, isTTY: ctx.isTTY });
  // Progress shows without a terminal too (a later ship needs no questions); createAsk.say is silent then (Ruling S17).
  ask.say = print;
  const state = {};
  const runId = newRunId();
  // Ruling S12: ssh children are detached process groups, so Ctrl-C must end them explicitly.
  ctx.onSignal(() => {
    killAllChildren();
    print(`\n${interruptShip(state)}`);
    ask.close();
    ctx.exit(SHIP_EXIT.interrupted);
  });
  try {
    const r = await shipProject({ factory: ctx.factory, slug: cli.slug, name: cli.to, ask, env: ctx.env, runId, state, deps: ctx.deps?.ship ?? {} });
    print(r.text);
    return r.exit;
  } finally {
    ask.close();
  }
}

export { deploymentsCommand } from '../factory/ship/status.js';
