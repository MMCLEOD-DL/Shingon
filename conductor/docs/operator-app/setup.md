# Local operator service: setup and current limits

This is a backend candidate for Claude's operator UI, not the finished graphical app or a Windows Service Control Manager installer. Keep the existing terminal workflow available.

## Requirements

- Node 22.13+ and Git, installed natively on the service host.
- Claude Code and Codex CLI, signed in through their supported local account flows when live runs are desired.
- An existing reachable local model endpoint with Codex Responses API agentic support (such as the tested LocalAI/Qwen path). A chat-only endpoint is insufficient.
- A local, writable data directory outside client repositories. Do not use network/shared storage.

The target selected by Malcolm is **Windows browser + native Windows service process**. Linux engineering tests have run; native Windows sign-in, process-tree cancellation, filesystem behaviour and installation are unverified. No WSL dependency is intended: configured tests use cmd.exe on Windows and sh on POSIX. Cancellation uses taskkill by owned PID/tree on Windows. Use vendor-supported native CLI executables; npm .cmd shims are not established as compatible with this shell-free subprocess launcher. Do not report Windows support as accepted until the checks below pass.

## Run from a checkout

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

Installation checks only run `--version`. An authenticated probe sends a fresh synthetic challenge through the selected CLI. An agentic probe asks the model to write a fresh nonce file in a disposable directory and verifies the result. The last two can use subscription allowance and must be explicitly chosen. No paid API fallback is provided by the local app. Worker environments remove ANTHROPIC_API_KEY and OPENAI_API_KEY so these do not silently switch the subscription CLIs to API billing; normal CLI account stores and supported subscription OAuth remain on the host. The actual providers' entitlement/rate limits still apply.

Existing local-provider credentials remain in the host environment using the configured envKey; they are not submitted through the browser or committed to Git. Do not copy raw subscription session files. If headless sign-in is unavailable, sign in using the supported native CLI flow on the service machine. A found executable is never labelled authenticated automatically.

## Stop, restart and recovery

Stop the foreground service with Ctrl-C. Pending decisions are not consent. The service disconnects its one owned worker, which stops its tracked children, and records interruption. Restart with the same config/data arguments, use the new bootstrap link, and explicitly resume a resumable run. Resume generates fresh decision IDs and rechecks repository/workspace evidence. It does not automatically deploy or merge anything.

If the HTTP port is occupied, stop the earlier instance or choose `--port`. If the data directory is in use, do not run another service against it; stop the existing instance. A separate data directory is a separate local app state. The kernel singleton lease is released on process exit, including a crash.

If state persistence fails, the API reports storage-unavailable and stops owned work rather than continuing after an unsaved approval. Preserve the data directory and engine sidecars. Fix disk/permissions, then restart; corrupt service-state.json fails closed and needs explicit repair/restore. Never delete an unknown workspace to make a run disappear. File flush + rename is used on Windows; directory fsync is unavailable there, so power-loss durability requires acceptance-host validation and reliable storage/backups.

## Acceptance still required

1. Native Windows clean start/second start/stop/restart with actual vendor CLI executables.
2. Signed-in bounded probes for both subscriptions and an actual LocalAI/Qwen agentic probe.
3. One synthetic coding task with real local work, both vendors' review, actual tests and operator branch approval.
4. A process-tree cancellation test on Windows (including a spawned descendant), and service crash/restart/resume.
5. Claude UI integration, browser disconnect/reconnect, keyboard/focus/error states and hostile diff/log rendering.
6. Reciprocal review of approval, bootstrap, storage failure and cancellation boundaries before release.

No client shipping, personal/company data migration, Windows service installation, scheduled task, firewall opening or remote worker start is performed by these instructions.
