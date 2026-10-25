# Task 10: Docs & operator council smoke

This task finishes Plan 5 with two pieces:

- **README and example config.** They explain the council in plain English: what it checks, what it needs installed, how to turn it on, and how to accept a licence for one project.
- **An operator-run smoke of `--council`.** It uses the real CLIs, the real local model and the real optional tools on a throwaway repo. The repo is seeded with an old `eval` and an old GPL dependency, which should show as "already there" warnings. The request asks for an `eval`-based calculator, which should block, bounce back as a fix step and come back approved.

**The implementer writes the files and checks syntax only. The implementer does NOT run the smoke.** Malcolm runs it with `!`, because it needs the live LocalAI key, both frontier subscriptions, the council tools installed and a human at the gate.

**Files:**
- Modify: `README.md`, `config.example.json`
- Create: `spikes/council-smoke/run-council-smoke.sh`, `spikes/council-smoke/RESULT.md`

**Interfaces:**
- Consumes:
  - `--council` and doctor's council section (Task 9);
  - the council options (Task 1);
  - the tunnel and key handling of `spikes/cli-smoke/run-cli-smoke.sh`.
- Produces: the operator command `bash spikes/council-smoke/run-council-smoke.sh`, and the docs.

- [ ] **Step 1: Update `config.example.json`**

Replace `"options": {}` with:

```json
  "options": {
    "council": false,
    "councilFixRounds": 3,
    "councilAcceptLicences": [],
    "councilTools": {}
  }
```

Run: `npm test`. The config tests and the smoke scripts read this file.
Expected: PASS.

- [ ] **Step 2: Add a "Council" section to `README.md`**

Insert it after "When a model is unavailable", and add `--council` to the "Use it" text and the `options` list under "Settings".

```markdown
## The council (optional extra checks)

Add `--council` to have three specialist reviewers check the finished work before you see it:

- **Security**: scans the code for common security holes, leaked passwords or keys, and
  dependencies with known security problems.
- **Legal**: checks that every dependency the change adds uses a licence you can hand to a
  client (MIT, Apache, BSD, ISC and similar). Copyleft licences (GPL, AGPL, LGPL, MPL) and
  missing or unknown licences block the change. Dependencies used only while developing are
  listed as warnings. It reads licences from `package-lock.json`; an old-format lockfile
  (version 1) has none, so the check is skipped until you update it with npm 7 or later.
- **Correctness**: checks that the tests pass and that the change really does what you asked.

Each reviewer runs real checking tools first. An AI from the other company then reads the
results, sets aside false alarms and explains the real problems in plain English. The AI on
its own can only warn you, never block, and it cannot turn a tool's warning into a block.

If a reviewer finds a problem that must be fixed, Conductor fixes it as an extra step and
runs all the checks again, up to 3 times. If something is still wrong after that, it asks
you. When it is done, the summary you approve includes a **council report**: what was fixed,
what is still worth knowing, and which checks could not run.

Problems that were already in your project before this change are listed as warnings and
never block it: code lines this change did not add (even in a file it edited), dependencies it
did not add or update, and tests that were already failing before it started (Conductor runs
the tests once on the starting point to check). A line the change moved or re-indented counts
as new.

If the secret scanner finds a password or key that the change added, it blocks. Once the fix
removes it, Conductor combines the run's steps into one commit before you approve, so the key
is not left in your repository's history either. (Gitleaks checks the finished files, so a key
added and removed between two steps before the council runs is not caught.)

**Tools it uses (all free, all optional; run `conductor doctor` to see which you have):**

| Check | Tool | Install |
|---|---|---|
| Code scan | Semgrep | `pipx install semgrep` |
| Leaked secrets | Gitleaks | release binary from github.com/gitleaks/gitleaks |
| Dependency security | npm audit | comes with Node.js |
| Copied licensed code | ScanCode | `pipx install scancode-toolkit` |

A missing tool is listed under "Checks that did not run". It never stops a run.

**Settings** (under `options` in `config.json` or a project's `conductor.json`):

- `council`: `true` turns it on for every run;
- `councilFixRounds`: how many times problems go back to be fixed (default 3);
- `councilAcceptLicences`: licences you accept for **this** project, for example
  `["LGPL-3.0-only"]`, or one exact package as `name@version`, for example
  `["some-lib@1.2.0"]` (the only way to accept a package with no licence);
- `councilTools`: a tool's path if it is not on your PATH, or `false` to turn a check off;
- `councilSemgrepConfig`: Semgrep rules (default `p/default`, downloaded from Semgrep's
  registry; point it at a local rules file to work fully offline).
```

- [ ] **Step 3: Write `spikes/council-smoke/run-council-smoke.sh`**

```bash
#!/usr/bin/env bash
# Plan 5 smoke (operator-run via `!`): the real `conductor --council`, real CLIs, real local model,
# real council tools, and YOU at the final gate. Key handling as in spikes/cli-smoke/run-cli-smoke.sh.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)" || exit 2
LPORT=8092

CFG=""
REPO=""
cleanup() { pkill -f "${LPORT}:127.0.0.1:8081" 2>/dev/null; }
cleanup_all() {
  [ -n "$CFG" ] && rm -f "$CFG"
  cleanup && echo "tunnel closed"
  [ -n "$REPO" ] && echo "throwaway repo kept for inspection: $REPO"
}
trap cleanup_all EXIT
trap 'exit 130' INT TERM
cleanup; sleep 1

echo "== tunnel =="
ssh -f -N -o ExitOnForwardFailure=yes -o ConnectTimeout=6 \
    -L 127.0.0.1:${LPORT}:127.0.0.1:8081 root@192.168.1.110 \
    && echo "tunnel up (127.0.0.1:${LPORT} -> CT110:8081)" || { echo "TUNNEL FAILED"; exit 1; }

export LOCALAI_API_KEY="$(ssh -o ConnectTimeout=6 root@192.168.1.110 \
    'grep -E "^LOCALAI_API_KEY=" /opt/shingon-localai/.env | cut -d= -f2-')"
[ -n "${LOCALAI_API_KEY:-}" ] && echo "key loaded" || { echo "NO KEY"; exit 1; }

CFG="$(mktemp --suffix=.json)" || { echo "CONFIG BUILD FAILED"; exit 1; }
node -e '
  const fs = require("fs");
  const [src, dst, url] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(src, "utf8"));
  for (const p of c.participants) if (p.adapter === "local-agent") p.baseUrl = url;
  c.options = { ...(c.options || {}), council: true };
  fs.writeFileSync(dst, JSON.stringify(c, null, 2));
' "$ROOT/config.example.json" "$CFG" "http://127.0.0.1:${LPORT}/v1" || { echo "CONFIG BUILD FAILED"; exit 1; }

# Seeded with problems that were ALREADY there: an old eval() and an old GPL dependency.
# Both must show as warnings ("already there before this change") and must not bounce.
REPO="$(mktemp -d -t council-smoke-repo-XXXXXX)" || exit 1
cd "$REPO" || exit 1
printf '{ "name": "smoke", "version": "1.0.0", "private": true, "type": "module", "license": "MIT" }\n' > package.json
printf '%s\n' '{ "name": "smoke", "version": "1.0.0", "lockfileVersion": 3, "requires": true, "packages": {' \
  '  "": { "name": "smoke", "version": "1.0.0", "license": "MIT" },' \
  '  "node_modules/old-gpl-lib": { "version": "1.0.0", "license": "GPL-3.0-only" } } }' > package-lock.json
printf 'export function legacy(s) { return eval(s); }\n' > old.js
printf "import assert from 'node:assert/strict';\nassert.ok(true);\nconsole.log('tests ok');\n" > test.js
git init -q -b main && git add -A && git -c user.name=smoke -c user.email=smoke@local commit -qm init

export CONDUCTOR_BASE_DIR="$HOME/.conductor/smoke-workspaces"
echo "== conductor doctor (look at the council checks section) =="
node "$ROOT/bin/conductor.js" doctor --config "$CFG" || { echo "DOCTOR FAILED"; exit 1; }

echo "== conductor --council (expect: Security blocks the eval, a 'Council fixes, round 1' step, then approval) =="
node "$ROOT/bin/conductor.js" \
  "Add calc.js exporting calculate(expr), which evaluates an arithmetic expression string such as '2+3*4' (the simplest way, with eval, is acceptable), and add tests for it in test.js." \
  --config "$CFG" --test "node test.js" --council
rc=$?
echo "conductor exit: $rc"
[ $rc -eq 0 ] && git --no-pager log --oneline --all
exit $rc
```

- [ ] **Step 4: Write `spikes/council-smoke/RESULT.md`**

```markdown
# Council smoke — result

**Status:** NOT YET RUN (operator runs `! bash spikes/council-smoke/run-council-smoke.sh`)

## Run
- Date:
- `doctor` council section (✓/✗ per tool):
- Outcome (exit code / branch):
- Council rounds used / fix steps:
- Elapsed, and frontier cost shown:

## Observations
- Did Security block the new eval(), and did the fix step remove it? (If the model or the step reviewer avoided eval in the first place, note that: the council then had nothing to block.)
- Did the old eval() in old.js and the old GPL dependency show as "already there" warnings, with no fix step for them?
- If the model also edited old.js, did its old eval() line still show as "already there"?
- Did the council report at the gate read like a consultant's note, not a scanner dump?
- Was the status line clear while the council ran (which member, which round)?
- Any "Checks that did not run"? Were the reasons clear?

## Operator follow-ups (outside the code)
- Install the council tools on the machine that runs Conductor: `pipx install semgrep`; the Gitleaks
  release binary; optionally `pipx install scancode-toolkit` (slow; changed files only). npm is already there.
- Semgrep `p/default` downloads its rules from semgrep.dev on each run. No code is uploaded, and metrics
  are off. To run fully offline, save the rules to a local file and set `councilSemgrepConfig`.
- `npm audit` sends package names and versions (not code) to registry.npmjs.org.
- Gitleaks 8.19+ prefers `gitleaks dir`. Check that the installed version still accepts
  `detect --no-git --source .` (the smoke's doctor plus a run shows it).
- Licence rule (spec §5a): check it with a solicitor before the first contract. Decide per client
  project which licences, if any, go in `councilAcceptLicences`.
- Answer the index's Operator Questions: Ruling 5 (problems that were already there, including an
  old GPL or unlicensed dependency, only warn); the permissive/copyleft licence list; and whether a
  package with no licence may be accepted per project with `name@version`.
- Cost: each council round adds one reviewer call for Correctness, plus one each for Security
  and Legal when their tools found something. That is at most 4 rounds.
- Packaging for others is still out of scope: **notify the operator before going live as a product**.
```

- [ ] **Step 5: Check syntax only. Do not run the smoke.**

Run:
```bash
chmod +x spikes/council-smoke/run-council-smoke.sh
bash -n spikes/council-smoke/run-council-smoke.sh && node -e 'JSON.parse(require("fs").readFileSync("config.example.json"))' && echo SYNTAX-OK
npm test
```
Expected: `SYNTAX-OK`, and the full suite PASSES.

- [ ] **Step 6: Commit**

```bash
git add README.md config.example.json spikes/council-smoke
git commit -m "docs: council in the README and an operator-run council smoke"
```

- [ ] **Step 7: Hand off to the operator**

Stop and tell Malcolm:

> Install Semgrep and Gitleaks (optionally ScanCode) on this machine first. Then run `! bash spikes/council-smoke/run-council-smoke.sh`. It needs the CT110 stack and the .109 worker up, and it uses both frontier subscriptions for a few minutes. At the end you answer the gate yourself: read the council report, `v` to look, then `a` to approve.

Once the output is back, fill in `RESULT.md` and commit it with the message `docs: council smoke result`.
