// src/cli/factory.js — factory commands (Contract 7 §7.3, §7.11): they run outside a git repository.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { EXIT } from './main.js';
import { findConfig } from './config.js';
import { loadConfig } from '../config.js';
import { factoryConfig } from '../factory/config.js';
import { validateSlug, createProject, readProject, listProjects } from '../factory/projects.js';
import { currentBriefInfo, briefPaths, ukDate } from '../factory/brief.js';
import { loadSession } from '../factory/briefSession.js';

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

// Task 10 replaces this placeholder with the real brief conversation.
async function briefCommand(cli, ctx) {
  ctx.print('conductor brief is not ready yet.');
  return EXIT.usage;
}

export const FACTORY_COMMANDS = {
  'project-new': projectNew,
  'project-list': projectList,
  'project-show': projectShow,
  brief: briefCommand,
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
  try {
    const parsed = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
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
