// src/cli/factory.js — factory commands (Contract 7 §7.3, §7.11): they run outside a git repository.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { EXIT } from './main.js';
import { findConfig } from './config.js';
import { loadConfig } from '../config.js';
import { factoryConfig } from '../factory/config.js';
import { validateSlug, createProject, readProject, listProjects } from '../factory/projects.js';
import { currentBriefInfo, briefPaths, ukDate, loadBrief, terminalText } from '../factory/brief.js';
import { loadSession, readNotesFile, importNotes, newSession, saveSession, discardSession } from '../factory/briefSession.js';
import { briefDraftPrompt } from '../factory/briefPrompts.js';
import { lockProject } from '../factory/projectLock.js';
import { runBriefSession } from '../factory/briefRun.js';
import { briefAuthorSeat } from '../factory/briefTeam.js';
import { buildCommand, previewCommand, machinesCommand, resumeBuildCommand } from './factoryBuild.js';
import { shipCommand, deploymentsCommand } from './factoryShip.js';
import { runChangeCommand, runUpgradeCommand } from './change.js';
import { createTerminal } from '../ui/terminal.js';
import { RunLog } from '../runlog.js';
import { killAllChildren } from '../exec.js';
import { redact } from '../secrets.js';

const firstSentence = (s) => (/^.*?[.!?](?=\s|$)/s.exec(s)?.[0] ?? s);

function briefLine(dir, slug) {
  const info = currentBriefInfo(dir);
  let session = null;
  let unreadable = false;
  try { session = loadSession(dir, slug); } catch { unreadable = true; }
  const unfinished = session !== null || unreadable;
  if (info === null) return unfinished ? `brief unfinished (run: conductor brief ${slug})` : 'no brief yet';
  if (info.broken) return `brief damaged: ${firstSentence(info.broken)}`;
  return `brief v${info.version} approved ${ukDate(info.approvedAt)}${unfinished ? '; a new version is unfinished' : ''}`;
}

async function projectNew(cli, ctx) {
  try {
    const { dir, project } = createProject(ctx.factory.projectsRoot, { client: cli.client, slug: cli.slug ?? undefined });
    const slug = project.slug;
    ctx.print(`Made project ${slug} for "${cli.client}" in ${dir}`);
    ctx.print(`Next: conductor brief ${slug} --notes <your meeting notes>`);
    return 0;
  } catch (e) {
    ctx.print(e.message);
    return EXIT.stopped;
  }
}

async function projectList(cli, ctx) {
  const root = ctx.factory.projectsRoot;
  let listed;
  try { listed = listProjects(root); } catch (e) { ctx.print(`Conductor could not read ${root}: ${e.message}`); return EXIT.stopped; }
  const { projects, skipped } = listed;
  if (!projects.length) ctx.print('No projects yet. Make one with: conductor project new "<client name>"');
  const w = (k) => Math.max(...projects.map((p) => p[k].length));
  if (projects.length) {
    const [ws, wc, wt] = [w('slug'), w('client'), w('status')];
    for (const p of projects) ctx.print(`${p.slug.padEnd(ws)}  ${p.client.padEnd(wc)}  ${p.status.padEnd(wt)}  ${briefLine(p.dir, p.slug)}`);
  }
  if (skipped > 0) ctx.print(`(${skipped} folder(s) in ${root} are not projects and were left out.)`);
  return 0;
}

function stageText(s) {
  if (s.stage === 'draft') return s.draft ? 'waiting for the AI to update the draft' : 'waiting at the first draft';
  if (s.stage === 'questions') return `${s.pending.length} question(s) waiting for your answer`;
  return 'ready for your approval';
}

async function projectShow(cli, ctx) {
  let found;
  try { found = readProject(ctx.factory.projectsRoot, cli.slug); } catch (e) { ctx.print(e.message); return EXIT.stopped; }
  const { dir, project: p } = found;
  ctx.print(`${p.client} (${p.slug})`);
  ctx.print(`Folder: ${dir}`);
  ctx.print(`Status: ${p.status}`);
  ctx.print(`Created: ${ukDate(p.createdAt)}`);
  ctx.print(`Foundation: ${p.foundation.repo ? `${p.foundation.repo} at ${p.foundation.tag}` : 'not chosen yet (set when the app is first built)'}`);
  ctx.print(`Approved build: ${p.approved ? `${p.approved.sha.slice(0, 12)} on ${ukDate(p.approved.at)}, built from brief v${p.approved.briefVersion}` : 'none yet'}`);
  const info = currentBriefInfo(dir);
  if (info === null) ctx.print(`Brief: none yet. Make one with: conductor brief ${p.slug} --notes <file>`);
  else if (info.broken) ctx.print(`Brief: damaged: ${info.broken}`);
  else {
    ctx.print(`Brief: version ${info.version}, approved by ${info.approvedBy} on ${ukDate(info.approvedAt)}`);
    ctx.print(`  Read it: ${briefPaths(dir).md(info.version)}`);
  }
  try {
    const s = loadSession(dir, p.slug);
    if (s) ctx.print(`Unfinished brief: ${stageText(s)}. Carry on with: conductor brief ${p.slug}`);
  } catch {
    ctx.print(`Unfinished brief: could not be read (run conductor brief ${p.slug} --discard-draft)`);
  }
  return 0;
}

export const NO_TTY_BRIEF_START = 'conductor brief needs a terminal: it asks you questions and needs your approval. Nothing was read or sent to any AI model. Run it in a terminal.';
const NOTES_ONLY_FRONTIER = 'Your meeting notes go only to the frontier models (Claude or Codex), never to the local model.';

// `conductor brief` (Plan 7, Task 10). Refusals first; fails closed without a terminal; the author seat is
// built before any notes are imported, so an unavailable author leaves nothing behind.
async function briefCommand(cli, ctx) {
  const { slug } = cli;
  const deps = ctx.deps ?? {};
  let found;
  try { found = readProject(ctx.factory.projectsRoot, slug); } catch (e) { ctx.print(e.message); return EXIT.stopped; }
  const { dir, project } = found;
  if (!ctx.isTTY) { ctx.print(NO_TTY_BRIEF_START); return EXIT.stopped; }

  const term = createTerminal({ input: ctx.stdin, output: ctx.stdout, isTTY: ctx.isTTY, bell: cli.flags.bell });
  // The last hop: model and adapter text can reach these messages, so no escape character gets through.
  const say = (s) => term.say(terminalText(s));
  let release = null;
  let session = null;
  let interrupted = false;
  let cwdDir = null;
  // Ctrl-C: every save happened before the prompt that was interrupted, so nothing more needs writing.
  ctx.onSignal(() => {
    interrupted = true;
    killAllChildren();
    release?.();
    release = null;
    if (cwdDir) rmSync(cwdDir, { recursive: true, force: true }); // exit() skips the finally below
    say(session
      ? `\nStopped. Your answers so far are saved. To carry on, run: conductor brief ${slug}`
      : '\nStopped before anything started. Nothing was sent to any AI model.');
    term.close();
    ctx.exit(EXIT.interrupted);
  });

  try {
    try {
      release = lockProject(dir, 'brief', deps.isAlive ? { isAlive: deps.isAlive } : {});
    } catch (e) { say(e.message); return EXIT.stopped; }

    let unreadable = null;
    try { session = loadSession(dir, slug); } catch (e) { unreadable = e; }
    if (cli.discardDraft) {
      // An unreadable session can still be thrown away: its own message says to run --discard-draft.
      if (!session && !unreadable) { say(`There is no unfinished brief for ${slug}.`); return EXIT.stopped; }
      if (!(await term.confirmDiscard({ slug }))) { say('Nothing was thrown away.'); return EXIT.stopped; }
      try { discardSession(dir); } catch (e) {
        say(`Conductor could not throw away the unfinished brief for ${slug}: ${e.message}`);
        return EXIT.failed;
      }
      session = null;
      say(`The unfinished brief for ${slug} was thrown away. Your notes are kept in ${path.join(dir, 'notes')}`);
      return 0;
    }
    if (unreadable) { say(unreadable.message); return EXIT.stopped; }

    let info = null;
    if (session && cli.notes) {
      say(`There is an unfinished brief for ${slug} (started ${ukDate(session.startedAt)}). Run conductor brief ${slug} to carry on with it, or conductor brief ${slug} --discard-draft to start again.`);
      return EXIT.stopped;
    }
    if (session) say(`Carrying on with the unfinished brief for ${slug}.`);
    else if (!cli.notes) {
      say(`There is no unfinished brief for ${slug}. To start one, run: conductor brief ${slug} --notes <file>`);
      return EXIT.stopped;
    } else {
      info = currentBriefInfo(dir);
      if (info?.broken) { say(info.broken); return EXIT.stopped; }
      if (info && !cli.revise) {
        say(`${slug} already has an approved brief (version ${info.version}, approved ${ukDate(info.approvedAt)}). To change it, run: conductor brief ${slug} --revise --notes <file>`);
        return EXIT.stopped;
      }
      if (cli.revise && !info) { say(`${slug} has no approved brief to revise yet. Run: conductor brief ${slug} --notes <file>`); return EXIT.stopped; }
    }

    let config = ctx.config;
    try {
      if (!config) {
        if (!ctx.configPath) findConfig({ cwd: ctx.cwd, env: ctx.env, home: ctx.home }); // throws its own plain message
        config = loadConfig(ctx.configPath);
      }
    } catch (e) {
      say(`Conductor could not read its config: ${e.message}`);
      return EXIT.usage;
    }
    const buildAuthor = deps.buildAuthor ?? ((c, e) => briefAuthorSeat(c.participants, { routing: c.routing, env: e }));
    let built;
    try { built = await buildAuthor(config, ctx.env); } catch (e) { built = { ok: false, error: `Conductor could not check the AI models: ${redact(String(e?.message ?? e))}` }; }
    if (interrupted) return EXIT.interrupted;
    if (!built.ok) { say(built.error); return EXIT.failed; }
    for (const w of built.warnings ?? []) say(`Note: ${w}`);
    say(NOTES_ONLY_FRONTIER);

    if (!session) {
      // A dry run of the first request: notes too long to send are refused before anything is saved.
      const notesFile = path.resolve(ctx.cwd, cli.notes);
      try {
        const { text } = readNotesFile(notesFile);
        briefDraftPrompt({ notes: [{ name: `notes/${path.basename(notesFile)}`, text }], baseBrief: cli.revise ? loadBrief(dir) : null });
      } catch (e) { say(e.message); return EXIT.stopped; }
      const now = deps.now?.() ?? new Date();
      let imported;
      try { imported = importNotes(dir, notesFile, { now }); } catch (e) { say(e.message); return EXIT.stopped; }
      const s = newSession({ slug, mode: cli.revise ? 'revise' : 'new', baseVersion: cli.revise ? info.version : null, notes: [imported.name], now });
      saveSession(dir, s, { now });
      session = s;
    }

    cwdDir = mkdtempSync(path.join(tmpdir(), 'conductor-brief-'));
    let out;
    try {
      out = await runBriefSession({
        projectDir: dir, session, author: built.seat,
        io: { say, ask: term.askBriefQuestion, approve: term.approveBrief },
        log: new RunLog(briefPaths(dir).logs), operatorName: ctx.factory.operatorName, cwd: cwdDir, now: deps.now,
      });
    } catch (e) {
      if (interrupted) return EXIT.interrupted;
      say(`Conductor could not write the brief: ${redact(String(e?.message ?? e))}`);
      return EXIT.failed;
    }
    if (interrupted) return EXIT.interrupted;
    let code;
    if (out.status === 'approved') {
      say(`Approved. Brief version ${out.version} for ${project.client} is saved:\n  ${out.mdPath} (to read)\n  ${out.jsonPath} (what the factory builds from)`);
      code = 0;
    } else {
      say(out.reason);
      code = out.status === 'failed' ? EXIT.failed : out.status === 'paused' ? EXIT.paused : EXIT.stopped;
    }
    if (out.costUsd > 0) say(`Frontier cost reported by the AI tools this sitting: $${out.costUsd.toFixed(2)}`);
    return code;
  } finally {
    release?.();
    if (cwdDir) rmSync(cwdDir, { recursive: true, force: true });
    term.close();
  }
}

export const FACTORY_COMMANDS = {
  'project-new': projectNew,
  'project-list': projectList,
  'project-show': projectShow,
  brief: briefCommand,
  build: buildCommand,
  preview: previewCommand,
  machines: machinesCommand,
  resume: resumeBuildCommand,
  ship: shipCommand,
  deployments: deploymentsCommand,
  change: runChangeCommand,
  'foundation-upgrade': runUpgradeCommand,
};

export async function runFactoryCommand(cli, { cwd, env, stdin, stdout, isTTY, onSignal, exit, deps = {} }) {
  const print = (s) => stdout.write(`${s}\n`);
  const home = env.HOME || homedir();
  let configPath = null;
  if (cli.flags.config) {
    try { configPath = findConfig({ flag: cli.flags.config, cwd, env, home }); } catch (e) { print(e.message); return EXIT.usage; }
  } else {
    try { configPath = findConfig({ cwd, env, home }); } catch { configPath = null; }
  }
  let factory;
  let config = null;
  let parsed = {};
  if (configPath) {
    try { parsed = JSON.parse(readFileSync(configPath, 'utf8')); } catch (e) {
      print(`Conductor could not read its config file ${configPath}: ${e.message}`);
      return EXIT.usage;
    }
  }
  try {
    factory = factoryConfig({ factory: parsed?.factory }, { env, home });
    if (Array.isArray(parsed?.participants)) {
      try { config = loadConfig(configPath); } catch { config = null; }
    }
  } catch (e) {
    print(`Conductor could not read its config: ${e.message}`);
    return EXIT.usage;
  }
  if (cli.slug) {
    const bad = validateSlug(cli.slug);
    if (bad) { print(bad); return EXIT.usage; }
  }
  const ctx = { cwd, env, stdin, stdout, isTTY, onSignal, exit, factory, config, deps, home, print, configPath };
  return FACTORY_COMMANDS[cli.command](cli, ctx);
}
