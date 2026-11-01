# Local operator service: setup and current limits

This is a backend candidate for Claude's operator UI, not the finished graphical app or a Windows Service Control Manager installer. Keep the existing terminal workflow available.

After the first live run, use the [corrected-build Windows retest](windows-retest.md)
for the current setup sequence and a fresh evidence table. It supersedes the old
checklist's personal Codex login and manual search-path/diagnostic workarounds.

## Requirements

- Node 22.13+ and Git, installed natively on the service host.
- Claude Code and Codex CLI, signed in through their supported local account flows when live runs are desired.
- An existing reachable local model endpoint with Codex Responses API agentic support (such as the tested LocalAI/Qwen path). A chat-only endpoint is insufficient.
- A local, writable data directory outside client repositories. Do not use network/shared storage.

The target selected by Malcolm is **Windows browser + native Windows service process**. Linux engineering tests have run; native Windows sign-in, process-tree cancellation, filesystem behaviour and installation are unverified. No WSL dependency is intended: configured tests use cmd.exe on Windows and sh on POSIX. Cancellation uses taskkill by owned PID/tree on Windows. Use vendor-supported native CLI executables; npm .cmd shims are not established as compatible with this shell-free subprocess launcher. Do not report Windows support as accepted until the checks below pass.

### Native Codex search tools

When a configured absolute native Codex executable is under `bin/` (or the older
`codex/` folder), Conductor checks for the installation's adjacent
`codex-path/rg.exe` on Windows (`codex-path/rg` on POSIX). If that file exists, its
directory is prepended only to that Codex child's PATH. This applies to both the
frontier Codex adapter and the local-agent adapter. The app/terminal PATH is not
changed, and missing helpers, bare commands and other layouts retain their current
environment. No package search, download or cwd-relative helper lookup occurs.

This covers PR66 F6's reported layout without the manual terminal PATH prefix.
It does not resolve npm `.cmd` shims or select/update a CLI installation; continue
to configure the actual native binary. Recheck the configured path after an update.
The native stand-in test proves child lookup, not real-model tool execution.

### Local-agent Windows sandbox

On native Windows, the local participant's private Codex configuration now sets
`[windows] sandbox = "elevated"` by default. It does not read or copy your personal
Codex settings. Codex may request administrator approval to set up that sandbox.
If you have chosen Codex's unelevated fallback, set `"windowsSandbox": "unelevated"`
on the `local-agent` participant in the on-disk JSON config. The only accepted
values are `elevated` and `unelevated`. Other hosts omit this setting by default.
See the [official Windows sandbox configuration](https://developers.openai.com/codex/config-basic).

Remove the first-run checklist's `extraConfig` sandbox workaround when using this
field: existing `extraConfig` CLI overrides still take precedence over the private
config file. Coding requests still use `workspace-write`; reviews use `read-only`.
The sandbox mode selects the Windows implementation and does not grant full access.

This corrects PR66's missing private-home setting (F1). On native Windows, the
local agent now retains its private home between calls so Codex can retain its
own sandbox setup markers and protected setup state (F2). The home is keyed by
the generated configuration, executable and CLI overrides, under Conductor's
`codex-homes` cache outside the workspace. A changed configuration gets a new home
and may require setup again. Other hosts keep temporary per-call homes.

Only one process may use a particular retained home at a time. A concurrent call
is refused as busy; the operating system releases the lease even if its owner
crashes. Generated `config.toml` is refreshed before every call. Nothing is copied
from your personal Codex home. Frontier Codex has its own retained home as described below.
Codex may retain logs/session metadata and protected sandbox state there; treat
this as private local state and do not share it or delete it routinely. Stop all
calls before deliberately clearing the cache; the next run will need setup again.

The source and stand-in checks establish state retention, not the actual number
of administrator prompts. The corrected build still needs a real local-model
write, repeated-run and crash/restart check on Windows. The elevated default is
unchanged; no automatic switch to the unelevated fallback is made.

### Dedicated frontier Codex sign-in

Frontier `codex` participants now use a retained Conductor home too (PR66 F3/F4).
Conductor generates its `config.toml`; it does not load or modify your personal
Codex user config, project-trust entries, or home-scoped MCP/plugin settings.
It never reads, copies or links existing authentication files. Codex itself owns
authentication and sandbox setup state in the dedicated home. System/managed
policy, repository configuration and separately discovered skills still apply.

**Migration requires a one-time ChatGPT sign-in in the dedicated home.** Signing
in to the ordinary CLI home is insufficient. The supported `CODEX_HOME` variable
selects both settings and authentication: file credentials live there, and the
CLI's OS-keyring key is also derived from that home. See the
[official authentication guide](https://developers.openai.com/codex/auth) and
[pinned keyring implementation](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/login/src/auth/storage.rs).
The generated frontier config selects `forced_login_method = "chatgpt"`; it has
the same elevated Windows sandbox default. Trusted on-disk `extraConfig` overrides
continue to apply to coding calls. Keep any required runtime settings there.

Stop Conductor runs/probes before signing in. From the same checkout, OS account
and cache environment as the service, run this preparation command in PowerShell,
using the service's actual config and frontier participant name:

```powershell
$prepared = node bin/conductor-codex-home.js --config '<absolute-config.json>' --participant codex | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $prepared.home -or -not $prepared.bin) { throw 'Home preparation failed.' }
$previousCodexHome = $env:CODEX_HOME
try {
    $env:CODEX_HOME = $prepared.home
    & $prepared.bin login
} finally {
    if ($null -eq $previousCodexHome) { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue }
    else { $env:CODEX_HOME = $previousCodexHome }
}
```

Preparation only creates/refreshes generated settings and prints the selected
home and configured executable as JSON. It runs no CLI, checks no credentials
and makes no model request; an absent CLI can be prepared but cannot sign in.
The following `login` is an explicit operator action using Codex's normal browser
flow. Choose ChatGPT sign-in, then return to Conductor and explicitly run its
connection checks when ready to use subscription allowance. No credentials go
through Conductor's browser. The terminal's previous home selection is restored.

The home is stable for the cache location, generated config and configured
executable, across model/role/extraConfig changes. A different executable path or
cache location needs its own sign-in. Each call refreshes generated settings;
do not customize the home config directly. State is separate from local-provider
homes and personal settings. Keep it private and persistent; clearing it removes
its sign-in/setup state. Calls sharing a home are refused as busy until the lease
is released. On Windows/Linux the lease uses a named pipe/abstract socket; other
hosts use a loopback port and fail closed on collisions. Native Windows stand-ins
verify these seams. Actual ChatGPT sign-in, Codex policy/plugin loading and
repeated UAC/write behavior still require live acceptance on the corrected build.

## Run from a checkout

Conductor's shared command runners request hidden console windows for background
children on native Windows. Output still travels through the existing pipes, and
Stop/timeout still targets the tracked process and its descendants. This hides
ordinary console windows only; Windows administrator consent (UAC) remains a
separate sandbox-setup prompt. The launcher flag and cancellation are covered by
offline/native tests; real-model desktop presentation remains a live check.

The Conductor root has no third-party runtime dependencies to install. From `conductor/`:

```
node bin/conductor-app.js --config <absolute-path-to-config.json> --data <absolute-local-state-directory>
```

Or `npm run app -- --config <path> --data <path> --port 4318`.

Use a local path appropriate to your OS; do not copy this cloud task's `/workspace` paths onto Windows. Defaults: config at the existing CLI location `~/.config/conductor/config.json`; data under `%LOCALAPPDATA%/conductor/operator-app` on Windows or `$XDG_STATE_HOME/conductor/operator-app` / `~/.local/state/conductor/operator-app` on Linux. Flags override these.

The launcher prints a short-lived private bootstrap URL. Open it locally. Once the UI exists at `operator-web/dist`, it exchanges the URL fragment for a session cookie and clears the fragment. Until the UI is built, the page explicitly reports that the backend is running without a UI. No browser is opened automatically and no credentials/model probes are triggered on start.

For UI integration, build Claude's `operator-web` package using its checked-in lockfile/scripts, then start the service; it serves those assets and API on the same origin. Do not start a permissive public/LAN dev server or paste bootstrap links into shared logs. See [the exact API contract](interface.md).

Initial browser setup accepts a local endpoint/model and creates default Claude/Codex/local participants. Existing configurations are preserved except the selected local/routing settings; API routing stays disabled and local fallback asks. Keep testCommand and executable selection in trusted on-disk configuration for this first version. A project-specific CLI config can be used with `--config` explicitly; the service does not silently select a new config when switching repositories.

## Subscription use and model checks

Failed connection checks keep their short reason code and show a safe explanation
under **What to do**. The explanation distinguishes missing/wrong/unreadable
verification files, an unexpected challenge response, time limits, sign-in and
usage limits, configuration/version problems, and recognized sandbox/access
refusals. Missing file evidence suggests checking workspace-write permission;
it does not prove the sandbox was the cause. Installation timeouts leave executable
status unknown. Unexpected adapter failures receive generic safe guidance.

These explanations come from a fixed catalog. Raw CLI output, model replies,
paths, account details, endpoint URLs and challenge values are not returned to the
browser. Unknown failures remain general rather than echoing potentially private
diagnostics. Successful checks keep their existing verification requirements.

Installation checks only run `--version`. An authenticated probe sends a fresh synthetic challenge through the selected CLI. An agentic probe asks the model to write a fresh nonce file in a disposable directory and verifies the result. The last two can use subscription allowance and must be explicitly chosen. No paid API fallback is provided by the local app. Worker environments remove ANTHROPIC_API_KEY and OPENAI_API_KEY so these do not silently switch the subscription CLIs to API billing. Claude uses its supported host account store; frontier Codex uses the dedicated sign-in above. The actual providers' entitlement/rate limits still apply.

Existing local-provider credentials remain in the host environment using the configured envKey; they are not submitted through the browser or committed to Git. Do not copy raw subscription session files. If headless sign-in is unavailable, sign in using the supported native CLI flow on the service machine. A found executable is never labelled authenticated automatically.

## Stop, restart and recovery

Stop the foreground service with Ctrl-C. Pending decisions are not consent. The service disconnects its one owned worker, which stops its tracked children, and records interruption. Restart with the same config/data arguments, use the new bootstrap link, and explicitly resume a resumable run. Resume generates fresh decision IDs and rechecks repository/workspace evidence. It does not automatically deploy or merge anything.

If the HTTP port is occupied, stop the earlier instance or choose `--port`. If the data directory is in use, do not run another service against it; stop the existing instance. A separate data directory is a separate local app state. The kernel singleton lease is released on process exit, including a crash.

If state persistence fails, the API reports storage-unavailable and stops owned work rather than continuing after an unsaved approval. Preserve the data directory and engine sidecars. Fix disk/permissions, then restart; corrupt service-state.json fails closed and needs explicit repair/restore. Never delete an unknown workspace to make a run disappear. File flush + rename is used on Windows; directory fsync is unavailable there, so power-loss durability requires acceptance-host validation and reliable storage/backups.

### Recover an uncertain approved result

A worker lost after result approval may already have created the source branch. The app therefore disables ordinary Resume while `recoveryRequired` is true. Do not delete the branch, clear service metadata or start the same task again to bypass this guard.

1. Wait until there is no active run or connection probe. Find this run in History and note its run ID. In the registered source repository, inspect the branches and the approved commit with your Git client. These terminal commands are read-only alternatives (substitute the actual local path and approved commit from the run's review):

   ```text
   git -C "<registered-repository>" status --short
   git -C "<registered-repository>" branch --list "conductor/*"
   git -C "<registered-repository>" branch --points-at <approved-commit>
   ```

   Check the branch's diff/history too. A similarly named branch alone is not proof it contains the approved result. Preserve existing staged, unstaged and untracked work.

2. Record that inspection using the authenticated recovery endpoint. Until Claude adds a dedicated recovery control, use the developer console **on the locally opened Conductor page**, with its existing session. The following records the inspection only; run it after doing step 1, using this run's ID:

   ```js
   const runId = '<run-id>';
   const snapshotResponse = await fetch(`/api/v1/runs/${runId}`);
   if (!snapshotResponse.ok) throw new Error('Read the current run before recovery.');
   const snapshot = await snapshotResponse.json();
   const recoveryRequest = {
     clientRequestId: crypto.randomUUID(),
     repositoryInspected: true,
     expectedEventSeq: snapshot.lastEventSeq,
     reviewedCommit: snapshot.workspaceCommit,
   };
   const recoveryResponse = await fetch(`/api/v1/runs/${runId}/recover`, {
     method: 'POST', headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify(recoveryRequest),
   });
   const recoveryResult = await recoveryResponse.json();
   if (!recoveryResponse.ok) throw new Error(recoveryResult.error.message);
   ```

   A stale snapshot returns 409; inspect the current state again. If the response was lost, retry the same `recoveryRequest` (including its request ID) to avoid recording the acknowledgment twice. The service records your attestation; it does not independently prove that a human inspected the repository. No cookie or bootstrap token needs copying.

3. Refresh the run and choose **Resume** separately. This starts the normal engine and may use configured model/subscription access. Its saved landing record reconciles an already-created branch at the approved commit without landing a duplicate or repeating completed coding steps. If nothing landed, it offers a fresh review and requires a new approval before creating a branch. Another loss before reconciliation requires inspection again. A confirmed pre-landing evidence refusal instead says nothing was landed, preserves the workspace and offers Resume for fresh review directly.

If the workspace/state is missing or corrupt, preserve the data directory and repair/restore it first. For an operator-managed CLI recovery, stop the app to prevent concurrent workers, use the exact `workspaceDir` in that run's `service-state.json` record (the sibling `<workspace>.conductor/` holds engine state), and run from the registered source repository:

```text
node "<shingon-checkout>/conductor/bin/conductor.js" resume "<workspaceDir>" --config "<same-config-file>"
```

Use the explicit workspace path: app workspaces are under the service data directory and may not be found by a bare `conductor resume`. The CLI can use models and ask for consent; it does not update the app's history record. Keep that record as interrupted/inspection-required until reconciled through the service. Do not hand-edit it to claim success or run the CLI and app against the workspace together.

## Acceptance still required

During each coding step, an executed failing test run now blocks that attempt
before rival review. The producer receives the test output and retries within
the configured local/frontier round limits. Passing attempts still require rival
review; projects with no configured tests retain the existing review path.
If both producer budgets are exhausted with failing tests, the existing explicit
escalation is shown with a reject recommendation. A deliberate operator override
remains separate from automatic approval. Final result approval is unchanged.

1. Native Windows clean start/second start/stop/restart with actual vendor CLI executables.
2. Signed-in bounded probes for both subscriptions and an actual LocalAI/Qwen agentic probe.
3. One synthetic coding task with real local work, both vendors' review, actual tests and operator branch approval.
4. A process-tree cancellation test on Windows (including a spawned descendant), and service crash/restart/resume.
5. Claude UI integration, browser disconnect/reconnect, keyboard/focus/error states and hostile diff/log rendering.
6. Reciprocal review of approval, bootstrap, storage failure and cancellation boundaries before release.

No client shipping, personal/company data migration, Windows service installation, scheduled task, firewall opening or remote worker start is performed by these instructions.
