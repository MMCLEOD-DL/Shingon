// src/council/projectCouncil.js
// The full council on a client app: Plan 8's hooks.council (Contract 7 §7.7, index A1).
//   args = { projectDir, appDir, sha, brief, policy, runId, slug, team, factory, onEvent, checks }
//   -> { status: 'approved'|'approved-with-warnings'|'blocked'|'paused', text, fix?: { title, instructions }, reason?, secretSeen? }
// One round per call, in a throwaway workspace whose base is the foundation commit (so the whole app is reviewed).
// Rounds, history and cached evidence persist in builds/<runId>/council/state.json. Plan 8 owns the fix loop and
// its cap; this hook never counts fix rounds. It never throws: Plan 8 would treat a throw as a crash.
import { DEFAULT_OPTIONS } from '../options.js';
import { redact } from '../secrets.js';
import { clip } from '../text.js';
import { renderBrief } from '../factory/brief.js';
import { projectContext } from './project.js';
import { openCouncilWorkspace, openCouncilLog } from './councilWorkspace.js';
import { runCouncilRound, membersFor, validateCouncilOptions, PROJECT_COUNCIL } from './index.js';
import { fixChunk } from './report.js';
import { markCouncilReportStale } from './reportFile.js';

// Everything handed back to Plan 8 (text, fix, reason) goes through redact() once more on the way out:
// Plan 8 stores it in the build state.
// Plan 8 clips a council fix's instructions to 3000 characters (Ruling R16).
const FIX_MAX = 3000;

// A pause on a new commit must not leave an older commit's report looking current. Best effort: never throws.
function staleOnPause(project, reason) {
  if (!project?.buildDir || !/^[0-9a-f]{7,64}$/.test(String(project.sha))) return;
  try { markCouncilReportStale(project.buildDir, { sha: project.sha, runId: project.runId, reason }); } catch { /* best effort */ }
}

const plain = (e) => clip(redact(String(e?.message ?? e ?? '')).replace(/\s*\n\s*/g, ' ').trim(), 300) || 'an unknown error';

export async function runProjectCouncil(args, { options = {}, deps = {} } = {}) {
  let opened = null;
  let state = null;
  let project = null;
  const sticky = () => (state?.council?.secretSeen === true ? { secretSeen: true } : {});
  try {
    // Ruling R19: an unsafe run id or slug, an unreadable project file or a missing pin pauses (caught below).
    project = await projectContext(args, { loadProject: deps.loadProject, ids: deps.ids });
    project.factory = args.factory ?? {};
    project.deps = deps;

    const opened_log = openCouncilLog(project.buildDir, { onEvent: args.onEvent });
    const { log } = opened_log;
    state = opened_log.state;
    state.request ??= `Build the client app for ${project.client} described in the approved brief.`;

    const ctxOptions = { ...DEFAULT_OPTIONS, ...options, council: true };
    validateCouncilOptions(ctxOptions);

    opened = await openCouncilWorkspace({ appDir: project.appDir, sha: project.sha, foundation: project.foundation, runId: project.runId, baseDir: deps.baseDir });
    project.problem = opened.problem;
    const { ws } = opened;
    const ctx = { ws, log, state, team: args.team, options: ctxOptions };
    project.briefText = (deps.renderBrief ?? renderBrief)(args.brief);

    const files = await ws.filesRange(ws.baseSha, project.sha);
    const diff = await ws.diffRange(ws.baseSha, project.sha);
    const r = await runCouncilRound(ctx, { files, tests: null, diff, members: membersFor(PROJECT_COUNCIL), project });

    if (r.status === 'paused') {
      const reason = redact(String(r.reason ?? ''));
      staleOnPause(project, reason);
      return { status: 'paused', reason, ...sticky() };
    }
    const { report } = r;
    const out = { status: report.verdict, text: redact(String(report.text ?? '')), secretSeen: state.council.secretSeen === true };
    if (report.verdict === 'blocked') {
      const { title, instructions } = fixChunk(report, state.council.round, FIX_MAX);
      out.fix = { title: redact(String(title)), instructions: redact(String(instructions)).slice(0, FIX_MAX) };
    }
    return out;
  } catch (e) {
    const reason = redact(`The council hit a problem it could not get past (${plain(e)}), so the build paused. Run "conductor build ${args?.slug}" to try again.`);
    staleOnPause(project, reason);
    return { status: 'paused', reason, ...sticky() };
  } finally {
    try { opened?.remove(); } catch { /* best effort */ }
  }
}
