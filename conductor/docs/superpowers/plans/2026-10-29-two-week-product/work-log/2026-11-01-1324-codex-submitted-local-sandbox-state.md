# Codex task submitted — P08 F2 local sandbox state

Owner Codex; independent reviewer Claude (pending). Status IN_REVIEW.
Branch codex/local-sandbox-state. Baseline d2a2e70b9621fa6eaba43aa393960a4d9f09117e.
Last code commit 5724a34db5317424167b04436e50eb9bed3aa71b.
PR: https://github.com/MMCLEOD-DL/Shingon/pull/70

Windows local-agent now retains a private home keyed by generated config,
executable and CLI overrides. Refresh generated config before each call; preserve
Codex-managed setup state in place. An OS-owned named-pipe lease excludes other
processes using that home and is released on process death, without stale PID
reclamation. Linux test reuse uses an abstract Unix socket. Normal non-Windows
local calls remain ephemeral; frontier personal-home behavior is unchanged.
Home/config links and non-regular config files refuse; generated homes must be
outside the agent workspace. Setup documentation records retained private state.
PR69 R2 addressed: explicit win32/linux/darwin config branches tested on every host.
No switch to unelevated and no claim of measured UAC reduction.

Source basis: pinned openai/codex rust-v0.163.0,
codex-rs/windows-sandbox-rs/src/setup.rs: sandbox_dir, setup_marker_path and
sandbox_users_path locate setup state below CODEX_HOME; elevated_impl.rs supplies
that home to setup. This supports preserving the home rather than copying private
setup artifacts or modifying their ACLs. The actual native setup outcome remains
for live acceptance.

Native Windows, Node 24.12.0:
- State-retention regression failed before the change (retained home absent).
- node --test test/private-codex-home.test.js test/local-windows-sandbox.test.js
  test/config.test.js: 28 PASS, 0 FAIL, 0 SKIP.
- Native stand-ins establish retained synthetic setup marker across separate
  adapter instances, regenerated config, config/executable identity separation,
  concurrent and separate-process exclusion, recovery after killed owner process,
  nonzero child exit and timeout recovery, link/junction refusal, ephemeral cleanup,
  and unchanged write/read-only arguments and credential exclusion.
- git diff --check PASS.
- Full native suite not rerun: PR68 independently demonstrated the unchanged
  shebang-fixture/platform limitation. No full native pass claimed.
- Current-head Linux CI started; risk-gate PASS, other jobs in progress at this
  entry. No full Linux pass claim yet. CI/merge heartbeat watches final head and
  must address attributable failures on this branch. Auto-merge is disabled by
  repository settings; manual merge remains required after checks/review.

No model/subscription/network-provider probe, personal credential read, actual
UAC/sandbox setup, worker restart, remote host, policy/ACL or deployment operation.
Tests use only local native stand-ins, synthetic state and local IPC leases.
No Claude-owned UI/checklist file touched. No high-risk path changed.

Merge accepts state retention and reviewed lifecycle behavior; it does not close
actual repeated-UAC acceptance. Malcolm's live check: corrected pinned build,
real local-agent file write, repeated calls and app crash/restart; record prompt
counts and successful edits. Persistent cache is private and not auto-purged.
Remaining queued tasks: frontier settings isolation F3/F4, launch/search-path and
diagnostics F5-F7, approved F8 failed-test rule; preserve ownership and live gates.
