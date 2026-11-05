// PR81 review (Claude, 5 Nov 2026; mutation control: replace the realpath comparison in src/workspace.js with `sameDirectory = true` in a scratch copy): does guardGitDir's git-common-dir comparison catch a broken workspace .git that
// makes Git fall through to an enclosing repository? Synthetic repos only.
//   node pr81-parent-repo.mjs <conductor dir>
import { mkdtempSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const dir = path.resolve(process.argv[2] ?? '.');
const { Workspace } = await import(pathToFileURL(path.join(dir, 'src/workspace.js')).href);
const { makeRepo } = await import(pathToFileURL(path.join(dir, 'test/helpers/gitRepo.js')).href);
const outer = mkdtempSync(path.join(tmpdir(), 'pr81-outer-'));
execFileSync('git', ['-C', outer, 'init', '-q']); // the workspace base sits inside another repository
for (const a of [['config', 'user.name', 'x'], ['config', 'user.email', 'x@example.invalid'], ['commit', '-q', '--allow-empty', '-m', 'outer']]) execFileSync('git', ['-C', outer, ...a]);
const outerHead = execFileSync('git', ['-C', outer, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const repo = await makeRepo();
const ws = await Workspace.create({ repoDir: repo, baseDir: path.join(outer, 'workspaces'), taskId: 'fallthrough' });
unlinkSync(path.join(ws.dir, '.git', 'HEAD')); // an agent breaks the workspace's own Git directory
let outcome;
try { await ws.guardGitDir(); outcome = 'NOT DETECTED: guardGitDir accepted it'; }
catch (e) { outcome = `detected: ${String(e.message).split(':').slice(0, 1).join('')}`; }
const head = await ws.head().then((h) => `head() returned ${String(h).slice(0, 10)} (Git ran against the enclosing repository)`, (e) => `head() refused: ${String(e.message).slice(0, 60)}`);
console.log(outcome); console.log(head); console.log('enclosing repository HEAD is', outerHead.slice(0, 10));
rmSync(outer, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true });
