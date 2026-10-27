// src/cli/factoryBuild.js — `conductor build`, `conductor preview`, `conductor machines`, and `conductor resume`
// inside a project folder (Contract 5, Contract 7 §7.3, §7.8, §7.11). FACTORY_COMMANDS handlers: (cli, ctx) -> exit code,
// or null from resumeBuildCommand for "not a build here", so main() carries on with an ordinary resume.
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { EXIT } from './main.js';
import { prepareTeam } from './prepareRun.js';
import { loadConfig } from '../config.js';
import { readProject, projectDir as projectDirOf } from '../factory/projects.js';
import { lockProject } from '../factory/projectLock.js';
import { runBuild } from '../factory/build.js';
import { latestBuild } from '../factory/buildState.js';
import { startPreview, stopPreview, previewRuns } from '../factory/preview.js';
import { getMachineProvider, whenText } from '../factory/machines/index.js';
import { createSsh } from '../factory/ssh.js';
import { SLUG_RE } from '../factory/ids.js';
import { createTerminal } from '../ui/terminal.js';
import { defaultBaseDir } from '../workspace.js';
import { redact } from '../secrets.js';
import { terminalText } from '../factory/brief.js';

export const NO_TTY_BUILD_START = 'conductor build needs a terminal: it asks for your decisions and for your approval of the finished app. Nothing was built or sent to any AI model. Run it in a terminal.';
export const BUILD_EXIT = Object.freeze({ ready: 0, rejected: 1, stopped: 1, failed: 2, paused: 3 });
const SETUP_PROBLEM = 2;
const FINISHED = new Set(['ready', 'rejected']);

const plain = (e) => redact(String(e?.message ?? e));
const printer = (ctx) => (s) => ctx.stdout.write(`${redact(String(s))}\n`);

function readConfig(ctx) {
  if (ctx.config) return ctx.config;
  if (!ctx.configPath) throw new Error('no config file was found (give one with --config <file>).');
  return loadConfig(ctx.configPath);
}

// The project whose folder (or app/, or anything under it) cwd is in, or null.
export function projectSlugFor(cwd, projectsRoot) {
  let rel;
  try { rel = path.relative(realpathSync(projectsRoot), realpathSync(cwd)); } catch { return null; }
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const slug = rel.split(path.sep)[0];
  if (!SLUG_RE.test(slug)) return null;
  return existsSync(path.join(projectsRoot, slug, 'project.json')) ? slug : null;
}

export function buildOutcomeText(out, { slug, client, appDir }) {
  if (out.status === 'ready') {
    return `Done. ${client}'s app is approved and ready. Its code is on the main branch of ${appDir}.\nSee it running: conductor preview ${slug}`;
  }
  const reason = out.reason ?? `The build ended: ${out.status}.`;
  if (out.status === 'rejected') return reason;
  const lines = [reason];
  // A refusal before any build started (no build folder) has nothing to carry on.
  if (out.buildDir && !reason.includes(`conductor build ${slug}`)) lines.push(`To carry on: conductor build ${slug}`);
  if (out.buildDir) lines.push(`Build log: ${path.join(out.buildDir, 'build-log.jsonl')}`);
  return lines.join('\n');
}

export function previewText(result, { slug, client }) {
  const what = result.from === 'build' ? 'the build in progress' : 'the approved app';
  const lines = [
    result.status === 'already'
      ? `The preview is already running (${what}): ${result.url}`
      : `The preview of ${client}'s app is running (${what}): ${result.url}`,
    'Open it on a computer or phone on your own network.',
    // Ruling Q34: a reused preview has no seeder text of its own.
    result.seedText ?? 'The demo sign-ins are as shown when the preview was first started.',
    `Stop it with: conductor preview ${slug} --stop`,
  ];
  return lines.join('\n');
}

const STOP_TEXT = {
  stopped: (slug) => `Stopped the preview of ${slug}.`,
  none: (slug) => `There is no preview running for ${slug}.`,
  gone: () => "The preview's machine was already gone; Conductor cleared its record.",
};

export async function runPreviewCommand({ factory, slug, stop, print, deps = {} }) {
  try {
    if (stop) {
      const r = await stopPreview({ factory, slug, deps });
      print((STOP_TEXT[r.status] ?? STOP_TEXT.stopped)(slug));
      return 0;
    }
    const { project } = readProject(factory.projectsRoot, slug);
    const r = await startPreview({ factory, slug, deps });
    print(previewText(r, { slug, client: project.client }));
    return 0;
  } catch (e) {
    print(plain(e));
    return SETUP_PROBLEM;
  }
}

const machineName = (m) => (Number.isInteger(m.vmid) ? `CT ${m.vmid}` : m.name);

export async function runMachinesCommand({ factory, action, print, deps = {} }) {
  let provider;
  try {
    provider = deps.provider ?? getMachineProvider(factory, { ssh: deps.ssh ?? createSsh(factory.machines) });
    if (action === 'sweep') {
      const n = await provider.sweep({ olderThanMs: factory.machines.sweepAfterMs, keep: previewRuns(factory.projectsRoot) });
      print(n === 0 ? 'Nothing was left over.' : `Cleared ${n} leftover machine${n === 1 ? '' : 's'}.`);
    } else {
      const machines = await provider.list();
      if (!machines.length) print('No factory machines are in use.');
      else {
        print(`Factory machines (${provider.kind ?? provider.provider}):`);
        for (const m of machines) {
          const l = m.labels ?? {};
          print(`  ${m.id} ${machineName(m)} ${m.host ?? '(no address yet)'}: ${l.purpose} for ${l.project} since ${whenText(l.createdAt)}`);
        }
      }
    }
  } catch (e) {
    print(plain(e));
    for (const n of provider?.notes ?? []) print(`Note: ${n}`);
    return SETUP_PROBLEM;
  }
  for (const n of provider.notes ?? []) print(`Note: ${n}`);
  return 0;
}

export function previewCommand(cli, ctx) {
  return runPreviewCommand({ factory: ctx.factory, slug: cli.slug, stop: cli.flags.stop, print: printer(ctx), deps: ctx.deps ?? {} });
}

export function machinesCommand(cli, ctx) {
  return runMachinesCommand({ factory: ctx.factory, action: cli.action, print: printer(ctx), deps: ctx.deps ?? {} });
}

export async function buildCommand(cli, ctx) {
  const print = printer(ctx);
  const { factory, env } = ctx;
  const deps = ctx.deps ?? {};
  const { slug } = cli;
  let config;
  try { config = readConfig(ctx); } catch (e) { print(`Conductor could not read its config: ${e.message}`); return EXIT.usage; }

  let found;
  try { found = readProject(factory.projectsRoot, slug); } catch (e) { print(`Conductor could not start the build: ${plain(e)}`); return EXIT.usage; }
  const { dir, project } = found;
  // Without a terminal nobody can answer the build's questions or approve it: refuse before anything is spent.
  if (!ctx.isTTY) { print(NO_TTY_BUILD_START); return EXIT.stopped; }

  // The handler holds the project lock around the whole build; runBuild never takes it (Contract 7 §7.11).
  let release;
  try { release = lockProject(dir, 'build', deps.isAlive ? { isAlive: deps.isAlive } : {}); } catch (e) { print(plain(e)); return EXIT.stopped; }
  let term = null;
  // The last hop: model-written text (feature titles, council text, reasons) reaches the terminal, so escape
  // characters are stripped first, then secrets redacted (stripping could otherwise rejoin a split secret).
  const clean = (s) => redact(terminalText(s));
  try {
    term = createTerminal({ input: ctx.stdin, output: ctx.stdout, isTTY: ctx.isTTY, bell: cli.flags.bell });
    const baseDir = env.CONDUCTOR_BASE_DIR || defaultBaseDir(env);
    const p = await (deps.prepareTeam ?? prepareTeam)({
      // Ctrl-C exits the process, which skips the finally below: free the project lock first.
      cli, config, term, env, baseDir, onSignal: ctx.onSignal, exit: (code) => { release(); ctx.exit(code); },
      interruptedText: `Stopped. The build so far is kept. To carry on later, run:  conductor build ${slug}`,
    });
    if ('code' in p) return p.code;
    const hooks = {
      ...p.hooks,
      approveBuild: (a) => term.approveBuild({ ...a, summary: clean(a?.summary ?? '') }),
      onProgress: (t) => term.say(clean(String(t))),
    };
    if (typeof p.hooks.escalate === 'function') {
      hooks.escalate = (esc) => p.hooks.escalate({ ...esc, title: clean(esc?.title ?? ''), message: clean(esc?.message ?? '') });
    }
    let out;
    try {
      out = await (deps.runBuild ?? runBuild)({
        factory, slug, team: p.built.team, env, hooks,
        options: { ...config.options, ...p.overrides, ...(cli.flags.newBuild ? { newBuild: true } : {}) },
        baseDir, warnings: p.built.warnings,
      });
    } catch (e) {
      p.remember();
      term.say(`Conductor could not start the build: ${clean(plain(e))}`);
      return EXIT.usage;
    }
    p.remember();
    term.say(clean(`\n${buildOutcomeText(out, { slug, client: project.client, appDir: path.join(dir, 'app') })}`));
    return BUILD_EXIT[out.status] ?? EXIT.failed;
  } finally {
    term?.close();
    release();
  }
}

// `conductor resume` inside <projectsRoot>/<project>/ (or below it) carries on that project's unfinished build.
export async function resumeBuildCommand(cli, ctx) {
  if (cli.workspaceDir) return null;
  const slug = projectSlugFor(ctx.cwd, ctx.factory.projectsRoot);
  if (!slug) return null;
  const b = latestBuild(projectDirOf(ctx.factory.projectsRoot, slug));
  if (!b || FINISHED.has(b.status)) return null;
  try { readConfig(ctx); } catch { return null; }
  return buildCommand({ ...cli, command: 'build', slug }, ctx);
}
