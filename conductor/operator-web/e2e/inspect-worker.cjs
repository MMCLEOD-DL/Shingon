// Deterministic worker for the journey's recovery steps (UI-owned; no models). Like Codex's slow-land
// worker, it writes the branch after approval and then dies before reporting, so the service cannot
// know whether the result landed. Unlike it, it works in a real engine workspace (Workspace.create, so
// the service's own evidence checks run unchanged), which recovery requires. On resume (the service
// passes the saved workspace back) it reconciles as the engine would: an existing branch is reported
// as landed and never written a second time.
//
// The journey sets JOURNEY_CONDUCTOR_DIR so this uses the same Conductor checkout as the service.
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const BRANCH = 'conductor/inspected';
const branchExists = (repo) => {
  try { execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`], { stdio: 'ignore' }); return true; } catch { return false; }
};
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

async function ask(ws) {
  const commit = await ws.head();
  process.send({ type: 'question', id: `inspect-result-${process.pid}`, kind: 'result',
    payload: { summary: 'Synthetic result for the recovery journey', diff: await ws.diffRange(ws.baseSha, commit), tests: { ran: true, passed: true, code: 0 } },
    evidence: { commit, diffId: 'inspect', testReportIds: [] } });
}

if (process.argv.includes('--operator-worker')) {
  let repo, ws;
  process.on('message', async (msg) => {
    if (msg.type === 'start') {
      repo = msg.repoDir;
      const { Workspace } = await import(pathToFileURL(path.join(process.env.JOURNEY_CONDUCTOR_DIR, 'src', 'workspace.js')).href);
      if (msg.workspaceDir) {
        ws = await Workspace.open(msg.workspaceDir);
        process.send({ type: 'event', event: { type: 'resume', message: 'Checking whether the approved result already reached the repository.' }, workspaceDir: msg.workspaceDir });
        if (branchExists(repo)) {
          process.send({ type: 'finished', outcome: { status: 'landed', branch: BRANCH } });
          process.disconnect();
          return;
        }
      } else {
        ws = await Workspace.create({ repoDir: repo, baseDir: msg.baseDir, taskId: 'inspect' });
        writeFileSync(path.join(ws.dir, 'inspected.txt'), 'synthetic change\n');
        git(ws.dir, 'add', 'inspected.txt');
        git(ws.dir, '-c', 'user.name=Journey', '-c', 'user.email=journey@example.invalid', 'commit', '-qm', 'synthetic change');
        process.send({ type: 'event', event: { type: 'start', message: 'Workspace ready.' }, workspaceDir: ws.dir });
      }
      await ask(ws);
    }
    if (msg.type === 'answer' && msg.value === true) {
      git(repo, 'fetch', '-q', ws.dir, `HEAD:refs/heads/${BRANCH}`);
      process.exit(1); // lost after the source write, before any outcome
    }
  });
  process.on('disconnect', () => process.exit(0));
}
