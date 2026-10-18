// test/helpers/gitRepo.js
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../../src/workspace.js';

// Creates a git repo on branch main with one commit containing `files`.
export async function makeRepo(files = { 'README.md': 'hello\n' }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'repo-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

// Every ref and the object it points at; used to prove a repo was not touched.
export async function refsOf(dir) {
  return (await git(dir, ['for-each-ref', '--format=%(refname) %(objectname)'])).stdout;
}
