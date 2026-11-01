# Windows retest after the first live run

Use this for the corrected build containing PR76 (`4c1d504`) or a later descendant.
It prepares the next P08 acceptance session; every live result below is **NOT RUN**.
The 31 October run at `b15a156` remains historical operator-reported evidence in
[Claude's first-run record](../superpowers/plans/2026-10-29-two-week-product/work-log/2026-10-31-1427-claude-task-36-first-live-run.md).
Its successful workarounds do not establish acceptance of this build.

Codex owns this retest handoff. Claude's [first-run checklist](real-run-checklist.md)
and original results are preserved. For current setup, use this page and
[setup.md](setup.md); the old checklist's personal Codex login, manual PATH prefix
and manual diagnostic model call do not test the new private-home path.

## 1. Prepare without model requests

Use the native Windows service host, the existing trusted config, native CLI
executables and configured local-provider environment. Record the full Git SHA,
Windows/Node/CLI versions and local model name. Do not publish credential values,
bootstrap links or raw CLI traces. Run `--version` with each configured executable;
that proves installation only. The first live run used Codex 0.163.0; record the
actual version and any change rather than assuming all later versions were tested.
For local-agent Connections checks, stable 0.163.0 is now the supported minimum.
Older, unrecognized or prerelease version output stops that check with upgrade/path
guidance before a model request. A found executable alone is insufficient.

Stop the foreground Conductor app before updating its checkout. Preserve unrelated
Git edits; update/build with the normal checkout procedure. From `conductor/operator-web`,
run `npm ci` and `npm run build`, then return to `conductor`. Verify the running app
will use this checkout and the recorded config. An old service process keeps its
loaded code until restarted.

Check the trusted on-disk config locally:

Use UTF-8, including PowerShell 5.1 `Set-Content -Encoding utf8` if writing it there.
The participant config readers accept its leading byte-order mark, preserving
Unicode text. Do not use Windows PowerShell 5.1's default UTF-16 `Out-File` encoding or fall
back to ASCII for non-ASCII paths/model names (first-run S5).

- Both Codex participants name the actual native executable. Recheck after CLI updates.
- The local participant keeps its chosen `windowsSandbox`; Windows defaults to
  `elevated`. Remove the obsolete `extraConfig` sandbox workaround if present,
  because CLI overrides take precedence. Do not switch modes to hide a failure.
- `routing.allowApi` stays false and `routing.localDown` stays `ask`.
- The local-provider key remains in its existing environment binding; note presence
  only. If unavailable, stop and record the dependency. This retest does not require
  extracting a key from another machine or restarting a shared worker.
- Start the app without the first run's manual `codex-path` PATH prefix. Use a fresh
  terminal with the normal host PATH and the existing authorized local-provider
  environment. Do not change machine-wide PATH. For a supported native `bin/codex.exe`
  layout with adjacent `codex-path/rg.exe`, Conductor supplies the child prefix.

Prepare the frontier home using the exact service config and participant name:

```powershell
node bin/conductor-codex-home.js --config '<absolute-config.json>' --participant codex
```

This prints home/bin JSON without executing Codex or inspecting credentials. It
does not establish sign-in. Complete the [dedicated-home sign-in procedure](setup.md#dedicated-frontier-codex-sign-in)
when the operator is ready; restore the terminal's previous `CODEX_HOME` afterwards
as shown there. Personal CLI sign-in and keyring entries are separate. Do not copy
auth files. Stop at any preparation/login failure; no retry may silently use the
personal home or a paid API key.

## 2. Run the connection checks when authorized

The following steps use real models/subscription allowance. Preparation, merge or
CI success does not authorize an agent to run them. Malcolm operates them or gives
the applicable live permission. Use a fresh disposable synthetic repository and
app data directory, with no client files. Keep the original trial/evidence intact.

Start from `conductor` in the prepared terminal:

```powershell
node bin/conductor-app.js --config '<absolute-config.json>' --data '<fresh-absolute-local-data-directory>'
```

Open its private bootstrap link locally. On Connections, for each participant run
installation, sign-in and coding checks explicitly, one at a time. Record each
status and the safe **What to do** explanation. Stop on failure; do not run a manual
Codex request outside Conductor to make a check appear fixed. Do not share raw
stderr, model output or home files. Report the selected participant and safe UI
message instead.

For local and frontier Codex separately, record UAC prompts for the first coding
check and a second explicit coding check with the same config/bin/cache. Distinguish
administrator consent from ordinary console flashes. A first setup prompt may
still be necessary; state retention alone does not prove reduced prompts. Record
whether normal console windows appear and when. Do not close a background child
window to dismiss it.

For F3/F4, note locally whether Conductor added personal project-trust settings or
started home-scoped personal MCP/plugins/hooks. Share only the observation, never
the personal config or authentication contents. System/managed/repository settings
and separately discovered skills can still apply. Report uncertain attribution as
unknown rather than declaring the whole tool environment isolated.

## 3. Exercise coding and recovery

On a new synthetic repository, repeat the [approve, reject and interruption steps](real-run-checklist.md#8-task-1-approve)
(sections 8–10 of the old checklist), using the current config/start command above.
Substitute your fresh trial/repository path wherever those sections name
`C:\conductor-trial`; do not reuse or clear the previous trial.
Do not repeat its older setup/diagnostic workarounds. Record actual vendor participation,
test results, reviewed diff, created branches and preserved source HEAD/index/files.
Keep a before/after branch list; existing branches do not count as a new result.

Repeat one coding check after an orderly Conductor stop/start, keeping the same
config/bin/cache. Count UAC prompts separately. The original Ctrl-C/Resume scenario
is an orderly interruption; it does not prove abrupt process death or power-loss
recovery. A controlled abrupt crash/resume remains a separate explicitly authorized
session with exact owned-process identification; do not kill unrelated Node/CLI
processes or stop the shared local worker for this checklist.

F8 is already covered by deterministic offline regressions in
`test/chunkPhase.test.js` and `test/keyleak.test.js` (PR71/72). If an executed test
fails during the live task, record the retry/block/escalation behavior: that attempt
must not receive automatic step approval. An explicit human override remains a
separate decision. A session in which all tests passed leaves this live observation
NOT RUN; do not manufacture a failure by weakening checks or changing shared policy.

## 4. Record results for this exact build

Use PASS / FAIL / NOT RUN / UNKNOWN, plus sanitized observations. Do not promote
the historical first-run results or offline stand-ins into these live rows.

| Check | Result | Notes |
|---|---|---|
| Build and native executables | NOT RUN | Full SHA, Windows/Node/CLI versions, model name |
| Dedicated frontier home preparation and operator login | NOT RUN | Success/failure only; no auth data |
| All nine Connections checks | NOT RUN | Participant, check, safe message |
| F1 local write with chosen sandbox | NOT RUN | Actual nonce/code write |
| F2 UAC first/repeated/after service restart | NOT RUN | Counts and config/bin/cache changes, if any |
| F3 personal trust settings unchanged by Conductor | NOT RUN | Local yes/no/unknown observation |
| F4 personal home-scoped add-ons absent | NOT RUN | Observation; policy/skill exceptions distinguished |
| F5 console presentation | NOT RUN | Ordinary consoles separate from UAC |
| F6 child search without manual terminal prefix | NOT RUN | Actual search behavior or NOT RUN if unused |
| F7 safe actionable failure guidance | NOT RUN | Safe message or NOT RUN if no failure |
| Approve/reject/Stop/orderly restart + Resume | NOT RUN | Diff/tests/vendor evidence, branch and source preservation |
| F8 executed failure blocks automatic step approval | NOT RUN | Only if actually encountered; offline evidence separate |
| Abrupt crash/resume and power-loss durability | NOT RUN | Separate authorization/evidence required |

Send the filled table and sanitized notes for review. Preserve private local state;
do not upload an entire data directory or delete evidence to make a check pass.
Any new defect becomes a bounded reproduction/fix. No deployment or client task
is part of this session.
