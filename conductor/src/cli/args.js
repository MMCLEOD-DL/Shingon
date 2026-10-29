// src/cli/args.js
import { parseArgs } from 'node:util';
import { SLUG_RE } from '../factory/ids.js';

export const USAGE = `Usage:
  conductor "<what you want done>"   start a new task in this repository
  conductor resume [<workspace>]     continue the latest unfinished run here (or the one given)
  conductor runs                     list unfinished runs for this repository
  conductor doctor                   check which AI models are available
  conductor project new "<client>"   make a folder for a new client app (--slug <name> picks its folder name)
  conductor project list             list your client projects
  conductor project show <slug>      show one project and its brief
  conductor brief <slug> --notes <file>            draft a brief from your meeting notes: questions, then your approval
  conductor brief <slug>                           carry on with an unfinished brief
  conductor brief <slug> --revise --notes <file>   make a new version of an approved brief
  conductor brief <slug> --discard-draft           throw away an unfinished brief (your notes are kept)
  conductor build <project>          build a client's app from its approved brief (carries on an unfinished build)
  conductor preview <project>        run the app with demo data on a factory machine and show its address
  conductor preview <project> --stop stop that preview
  conductor machines [list|sweep]    show the factory's machines, or clear ones left over from crashes
  conductor ship <project> --to <deployment>   ship the approved release to a box (the first time, it sets the box up)
  conductor deployments [status] [<project>]   list deployments; with status, check every box over SSH
  conductor change <slug> --notes <file>          change brief → build → full council → gate → ship as an update
  conductor change <slug> --resume                continue the project's unfinished change or upgrade
  conductor change <slug> --abandon               drop it
  conductor foundation-upgrade <slug> --to <tag>  bring a newer foundation release into the app, then the same path
  conductor foundation-upgrade <slug> --resume | --abandon
  conductor foundation-upgrade --check            which projects and deployments are behind on security fixes
Options:
  --config <file>        config file (default: ./conductor.json, then ~/.config/conductor/config.json)
  --test "<command>"     the command that runs this project's tests, e.g. "npm test"
  --approve-plan         show you the plan and ask before any step runs
  --approve-each-chunk   ask you before moving on after each step
  --watch-diffs          print each step's changes as it finishes
  --council              have specialist reviewers check security, licences and correctness before you approve
  --keep-workspace       keep Conductor's working copy after the run
  --new                  with build: start a fresh build instead of carrying on an unfinished one
  --stop                 with preview: stop the running preview
  --to <deployment>      with ship: the deployment (box) to ship to
  --to <tag>             with foundation-upgrade: the foundation release to bring in
  --resume               with change or foundation-upgrade: continue the unfinished one
  --abandon              with change or foundation-upgrade: drop the unfinished one
  --check                with foundation-upgrade: list what is behind on security fixes
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
  notes: { type: 'string' },
  revise: { type: 'boolean' },
  slug: { type: 'string' },
  'discard-draft': { type: 'boolean' },
  stop: { type: 'boolean' },
  new: { type: 'boolean' },
  to: { type: 'string' },
  resume: { type: 'boolean' },
  abandon: { type: 'boolean' },
  check: { type: 'boolean' },
};
const SUBCOMMANDS = new Set(['resume', 'runs', 'doctor']);
const CHANGE_USAGE = 'change needs a project name and one of --notes <file>, --resume or --abandon';
const UPGRADE_USAGE = 'foundation-upgrade needs a project name and one of --to <tag>, --resume or --abandon, or --check on its own';

// `change` and `foundation-upgrade` are commands only with a change flag or at most one word after them;
// otherwise the words are an ordinary request ("conductor change the button colour").
function changeCommand(first, rest, v, flags) {
  const hasFlag = v.notes !== undefined || v.to !== undefined || v.resume || v.abandon || v.check;
  if (!hasFlag && rest.length > 1) return null;
  const resume = v.resume === true;
  const abandon = v.abandon === true;
  if (first === 'change') {
    if (rest.length > 1) return { error: 'change needs one project name, e.g. conductor change acme --resume' };
    const modes = [v.notes !== undefined, resume, abandon].filter(Boolean).length;
    if (rest.length !== 1 || modes !== 1 || v.to !== undefined || v.check || v.notes === '') return { error: CHANGE_USAGE };
    return { command: 'change', slug: rest[0], notesFile: v.notes ?? null, resume, abandon, flags };
  }
  if (rest.length > 1) return { error: 'foundation-upgrade needs one project name, e.g. conductor foundation-upgrade acme --to v0.1.1' };
  const check = v.check === true;
  if (v.notes !== undefined) return { error: UPGRADE_USAGE };
  if (check) {
    if (rest.length || v.to !== undefined || resume || abandon) return { error: UPGRADE_USAGE };
    return { command: 'foundation-upgrade', slug: null, toTag: null, resume, abandon, check, flags };
  }
  const modes = [v.to !== undefined, resume, abandon].filter(Boolean).length;
  if (rest.length !== 1 || modes !== 1 || v.to === '') return { error: UPGRADE_USAGE };
  return { command: 'foundation-upgrade', slug: rest[0], toTag: v.to ?? null, resume, abandon, check, flags };
}

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
    stop: v.stop === true,
    newBuild: v.new === true,
  };
  if (v.help) return { command: 'help', flags };
  if (v.version) return { command: 'version', flags };
  if (!positionals.length) return { command: 'help', flags };
  const [first, ...rest] = positionals;
  const isBrief = first === 'brief';
  const isProjectNew = first === 'project' && rest[0] === 'new';
  const change = first === 'change' || first === 'foundation-upgrade' ? changeCommand(first, rest, v, flags) : null;
  if (change) {
    if (v.revise || v['discard-draft']) return { error: '--revise and --discard-draft only go with conductor brief' };
    if (v.slug !== undefined) return { error: '--slug only goes with conductor project new' };
    if (v.stop) return { error: '--stop only goes with conductor preview' };
    if (v.new) return { error: '--new only goes with conductor build' };
    return change;
  }
  if (v.resume || v.abandon || v.check) return { error: '--resume, --abandon and --check only go with conductor change or conductor foundation-upgrade' };
  if ((v.notes !== undefined || v.revise || v['discard-draft']) && !isBrief) {
    return { error: '--notes, --revise and --discard-draft only go with conductor brief' };
  }
  if (v.slug !== undefined && !isProjectNew) return { error: '--slug only goes with conductor project new' };
  if (v.stop && first !== 'preview') return { error: '--stop only goes with conductor preview' };
  if (v.new && first !== 'build') return { error: '--new only goes with conductor build' };
  if (v.to !== undefined && first !== 'ship') return { error: '--to only goes with conductor ship' };
  if (first === 'ship') {
    if (rest.length !== 1 || typeof v.to !== 'string' || v.to === '') {
      return { error: 'ship needs a project and a deployment: conductor ship <project> --to <deployment>' };
    }
    return { command: 'ship', slug: rest[0], to: v.to, flags };
  }
  if (first === 'deployments') {
    const status = rest[0] === 'status';
    const args = status ? rest.slice(1) : rest;
    if (args.length > 1) return { error: 'deployments takes [status] [<project>], e.g. conductor deployments status acme' };
    return { command: 'deployments', status, slug: args[0] ?? null, flags };
  }
  if (first === 'build' || first === 'preview') {
    if (!rest.length) return { error: `${first} needs the project's short name, for example: conductor ${first} acme-ltd (see "conductor project list")` };
    const arg = rest.join(' ');
    if (rest.length !== 1 || !SLUG_RE.test(arg)) return { error: `"${arg}" is not a project's short name (see "conductor project list")` };
    return { command: first, slug: arg, flags };
  }
  if (first === 'machines') {
    if (rest.length > 1 || (rest.length && !['list', 'sweep'].includes(rest[0]))) return { error: 'machines takes "list" or "sweep"' };
    return { command: 'machines', action: rest[0] ?? 'list', flags };
  }
  if (first === 'project') {
    const [sub, ...args] = rest;
    if (sub === 'new') {
      const client = args.join(' ').trim();
      if (!client) return { error: "project new needs the client's name, e.g. conductor project new \"Acme Ltd\"" };
      return { command: 'project-new', client, slug: v.slug ?? null, flags };
    }
    if (sub === 'list') {
      if (args.length) return { error: 'project list takes no arguments' };
      return { command: 'project-list', flags };
    }
    if (sub === 'show') {
      if (args.length !== 1) return { error: 'project show needs one project name, e.g. conductor project show acme' };
      return { command: 'project-show', slug: args[0], flags };
    }
    return { error: 'project needs new, list or show' };
  }
  if (isBrief) {
    if (rest.length !== 1) return { error: 'brief needs one project name, e.g. conductor brief acme --notes meeting.md' };
    const revise = v.revise === true;
    const discardDraft = v['discard-draft'] === true;
    if (discardDraft && (v.notes !== undefined || revise)) return { error: '--discard-draft cannot be combined with --notes or --revise' };
    if (revise && v.notes === undefined) return { error: 'brief --revise needs --notes <file>: the notes that say what changes' };
    return { command: 'brief', slug: rest[0], notes: v.notes ?? null, revise, discardDraft, flags };
  }
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
