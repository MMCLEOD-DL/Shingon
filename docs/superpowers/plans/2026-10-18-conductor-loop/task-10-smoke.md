# Task 10: Real-CLI smoke spike (operator-run)

This proves the whole loop works against the real CLIs: Claude Code and Codex (frontier) plus Codex→LocalAI (local). The test project is a tiny throwaway repo. Unit tests can't show this, because they use fakes.

**The implementer writes the files and checks their syntax only. The implementer does NOT run the smoke.** Malcolm runs it with `!`, because it uses a live LocalAI key and both frontier subscriptions.

**Files:**
- Create: `spikes/loop-smoke/smoke.js`, `spikes/loop-smoke/run-smoke.sh`, `spikes/loop-smoke/RESULT.md`

**Interfaces:**
- Consumes:
  - `loadConfig` (Plan 1), which returns `{ byName }`.
  - `runTask` (Task 9).
  - `git` (Task 2).
  - `config.example.json`, with participants `claude`, `codex` and `local`.
- Produces: an operator command, `bash spikes/loop-smoke/run-smoke.sh`.
  - Exits 0 when the run lands.
  - Prints the event stream, any escalation, the summary, the outcome and the landed commits.

**Behaviour:**
- **Test repo.** A throwaway repo holds `math.js` (`add`) and `test.js`. The request is to add `multiply` plus a test. `testCommand` is `node test.js`.
- **Hooks.** Escalations auto-reject and are printed. The final gate auto-approves, but it only lands into the throwaway repo.
- **Credentials.** Key handling matches `spikes/localai-codex/run-spike-tunnel.sh`:
  - The SSH tunnel runs `127.0.0.1:8091` → CT110 loopback `8081`.
  - The key goes only into the `LOCALAI_API_KEY` environment variable. It is never printed and never written to a file.
  - The temp config contains only the tunnel `base_url` override, never the key.

- [ ] **Step 1: Write `spikes/loop-smoke/smoke.js`**

```js
#!/usr/bin/env node
// spikes/loop-smoke/smoke.js — operator-run end-to-end smoke of the Plan 2 loop against real CLIs.
// Usage: node spikes/loop-smoke/smoke.js <config.json>
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const SHOW = new Set(['phase', 'chunk', 'chunk-fallback', 'deadlock', 'result', 'hook-error', 'finish']);

const out = await runTask({
  repoDir: repo,
  request: 'Add a multiply(a, b) function to math.js and a test for it in test.js.',
  team,
  options: { testCommand: 'node test.js', maxChunks: 3, agentTimeoutMs: 900000 },
  hooks: {
    onEvent: (e) => {
      if (!SHOW.has(e.type)) return;
      const who = e.participant ?? e.name ?? e.title ?? e.status ?? '';
      const what = e.verdict?.decision ?? (e.ok === false ? `FAILED: ${e.error}` : e.action ?? '');
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
```

- [ ] **Step 2: Write `spikes/loop-smoke/run-smoke.sh`**

```bash
#!/usr/bin/env bash
# Plan 2 loop smoke (operator-run via `!`). Tunnel + key handling as in
# spikes/localai-codex/run-spike-tunnel.sh: the LocalAI key lives only in an
# env var for this process — never printed, never written to the temp config.
set -u
cd "$(dirname "$0")/../.." || exit 2
LPORT=8091

cleanup() { pkill -f "${LPORT}:127.0.0.1:8081" 2>/dev/null; }
cleanup; sleep 1

echo "== tunnel =="
ssh -f -N -o ExitOnForwardFailure=yes -o ConnectTimeout=6 \
    -L 127.0.0.1:${LPORT}:127.0.0.1:8081 root@192.168.1.110 \
    && echo "tunnel up (127.0.0.1:${LPORT} -> CT110:8081)" || { echo "TUNNEL FAILED"; exit 1; }

export LOCALAI_API_KEY="$(ssh -o ConnectTimeout=6 root@192.168.1.110 \
    'grep -E "^LOCALAI_API_KEY=" /opt/shingon-localai/.env | cut -d= -f2-')"
[ -n "${LOCALAI_API_KEY:-}" ] && echo "key loaded" || { echo "NO KEY"; cleanup; exit 1; }

CFG="$(mktemp --suffix=.json)"
node -e '
  const fs = require("fs");
  const [src, dst, url] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(src, "utf8"));
  for (const p of c.participants) {
    if (p.adapter === "local-agent") p.extraConfig = [...(p.extraConfig || []), `model_providers.localai.base_url=${url}`];
  }
  fs.writeFileSync(dst, JSON.stringify(c, null, 2));
' config.example.json "$CFG" "http://127.0.0.1:${LPORT}/v1"

echo "== conductor loop smoke (several minutes) =="
node spikes/loop-smoke/smoke.js "$CFG"
rc=$?

rm -f "$CFG"
cleanup && echo "tunnel closed"
echo "smoke exit: $rc"
exit $rc
```

- [ ] **Step 3: Write `spikes/loop-smoke/RESULT.md`**

```markdown
# Loop smoke — result

**Status:** NOT YET RUN (operator runs `! bash spikes/loop-smoke/run-smoke.sh`)

## Run
- Date:
- Outcome (`status` / branch):
- Elapsed:
- Chunks planned:
- Chunks done by local / by frontier fallback:
- Escalations:

## Observations
- Plan JSON parsed first time? 
- Did the local model edit files via the Codex harness inside the workspace?
- Reviewer verdict lines present every time?
- Any adapter failures (classifyFailure reason)?

## Follow-ups for Plan 3
-
```

- [ ] **Step 4: Check syntax only. Do not run the smoke.**

Run:
```bash
chmod +x spikes/loop-smoke/run-smoke.sh spikes/loop-smoke/smoke.js
node --check spikes/loop-smoke/smoke.js && bash -n spikes/loop-smoke/run-smoke.sh && echo SYNTAX-OK
npm test
```
Expected: `SYNTAX-OK`, and the full suite PASSES.

- [ ] **Step 5: Commit**

```bash
git add spikes/loop-smoke
git commit -m "spike: operator-run real-CLI smoke of the adversarial loop"
```

- [ ] **Step 6: Hand off to the operator**

Stop and tell Malcolm: "Run `! bash spikes/loop-smoke/run-smoke.sh`. It needs the CT110 stack and the .109 worker up, and it uses both frontier subscriptions for a few minutes." Once the output is back, fill in `RESULT.md` and commit it with the message `docs: loop smoke result`.
