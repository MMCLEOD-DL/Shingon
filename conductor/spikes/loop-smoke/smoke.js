#!/usr/bin/env node
// spikes/loop-smoke/smoke.js — operator-run end-to-end smoke of the Plan 2 loop against real CLIs.
// Usage: node spikes/loop-smoke/smoke.js <config.json>
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { runTask } from '../../src/conductor.js';
import { git } from '../../src/workspace.js';

const cfgPath = process.argv[2] ?? 'config.json';
const { byName } = loadConfig(cfgPath);
const pick = (name) => {
  const p = byName.get(name);
  if (!p) { console.error(`config has no participant "${name}"`); process.exit(2); }
  return p;
};
const team = {
  author: pick(process.env.SMOKE_AUTHOR ?? 'claude'),
  reviewer: pick(process.env.SMOKE_REVIEWER ?? 'codex'),
  local: pick(process.env.SMOKE_LOCAL ?? 'local'),
};

const repo = mkdtempSync(path.join(tmpdir(), 'smoke-repo-'));
writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }, null, 2) + '\n');
writeFileSync(path.join(repo, 'math.js'), 'export function add(a, b) { return a + b; }\n');
writeFileSync(path.join(repo, 'test.js'),
  "import assert from 'node:assert/strict';\nimport { add } from './math.js';\nassert.equal(add(2, 3), 5);\nconsole.log('tests ok');\n");
await git(repo, ['init', '-q', '-b', 'main']);
await git(repo, ['add', '-A']);
await git(repo, ['commit', '-q', '-m', 'init']);

const t0 = Date.now();
const secs = () => `${Math.round((Date.now() - t0) / 1000)}s`;
const SHOW = new Set([
  'phase', 'chunk', 'chunk-fallback', 'chunk-done', 'deadlock', 'result', 'hook-error', 'finish',
  // the failure events an operator needs to diagnose a failed smoke
  'chunk-error', 'inspect-failed', 'plan-failed', 'escalation', 'decision', 'run-error', 'land-failed',
  'config-tampered', 'branch-switched', 'final-reset', 'final-drift', 'warning',
]);

const out = await runTask({
  repoDir: repo,
  request: 'Add a multiply(a, b) function to math.js and a test for it in test.js.',
  team,
  // Not under /tmp (N4): Codex workspace-write can write there, which would expose <ws>.conductor/.
  // Kept for inspection, apart from real runs' ~/.conductor/workspaces. The throwaway repo stays in tmp.
  baseDir: path.join(homedir(), '.conductor', 'smoke-workspaces'),
  options: { testCommand: 'node test.js', maxChunks: 3, agentTimeoutMs: 900000, keepWorkspace: true },
  hooks: {
    onEvent: (e) => {
      if (!SHOW.has(e.type)) return;
      const who = e.participant ?? e.name ?? e.title ?? e.status ?? '';
      const what = e.verdict?.decision ?? (e.ok === false ? `FAILED: ${e.error}` : e.action ?? e.decision ?? e.error ?? e.detail ?? e.sha ?? '');
      console.log(`[${secs()}] ${e.type} ${who} ${what}`.trimEnd());
    },
    escalate: async (esc) => {
      console.log(`\n=== ESCALATION ===\n${esc.message}\n(smoke: auto-reject)\n`);
      return 'reject';
    },
    approveResult: async ({ summary }) => {
      console.log(`\n=== SUMMARY ===\n${summary}\n(smoke: auto-approve; lands only into the throwaway repo)\n`);
      return true;
    },
  },
});

console.log('=== RESULT ===');
console.log(JSON.stringify(out, null, 2));
if (out.branch) console.log((await git(repo, ['log', '--oneline', `main..${out.branch}`])).stdout);
console.log(`elapsed ${secs()}; throwaway repo ${repo}`);
process.exit(out.status === 'landed' ? 0 : 1);
