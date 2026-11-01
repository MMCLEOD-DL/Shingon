# Codex task submitted — P08 F6 adjacent search tools

Owner Codex; independent reviewer Claude pending. IN_REVIEW (draft pending CI).
Branch codex/codex-search-path; baselinebacb098061b8c27af6f3992b242ce1dc9fa2a9ee.
Last code commit3c525bcbfffa2e1990b64d7ba9b319e1cd668779.
PR https://github.com/MMCLEOD-DL/Shingon/pull/74
Prior PR73 merged at exact submission head1e5a6d2 with all required checks green.

CodexAdapter constructs its child env with a verified adjacent codex-path helper
directory for absolute native Codex binaries under bin/ or legacy codex/. Both
frontier and local-agent use this adapter. Missing rg file/unsupported layout,
bare/relative/non-Codex/shim paths leave env unchanged. No cwd lookup or package
scan. Parent PATH unchanged, unrelated env values/order preserved; helper entries
deduplicated and Windows PATH key spelling handled as Node's spawn handles it.
Generated/private homes and existing credential filtering stay unchanged.

Native Windows Node24.12.0:
- Pre-fix native child regression fails: child selects globally installed real rg
  rather than the adjacent synthetic stand-in. This proves missing adjacent
  preference, not universal tool absence on this host.
- node --test test/codex-search-path.test.js test/config.test.js test/exec.test.js
  test/hidden-children.test.js test/local-windows-sandbox.test.js
  test/private-codex-home.test.js:43 PASS/0 FAIL/0 SKIP, exit0,1.561seconds.
- Known copied Node executables stand in for native Codex/rg. Child discovers
  adjacent rg via PATH and returns Node version for both adapters. No real Codex,
  model or ripgrep tool operation. Cross-platform pure cases cover spaces, order,
  key casing/deduplication, delimiters and unsupported/missing helpers. Existing
  cancellation, private-home and generated Windows config checks pass.
- Whitespace PASS. Broad native suite retains known unrelated shebang limits;
  full Linux CI pending on final head. Do not claim green CI or real-model search.

Source: https://github.com/openai/codex/blob/rust-v0.163.0/codex-cli/bin/codex.js
Inspected wrapper resolves native vendor/<target>/bin/codex and sets package-manager
metadata; it does not currently prepend codex-path. This change intentionally
supports PR66's reported adjacent layout, not full npm-launcher parity. No native
CLI/version installation, executable discovery, download or package update.

No live model/subscription/credential/UAC/worker/policy/deployment operation,
no Claude UI/checklist edits and no high-risk paths. Keep DRAFT until all required
latest-head checks pass; watcher then marks ready and notifies Malcolm for review
and manual merge. Auto-merge disabled. Next: F7 safe diagnostics or dedicated
frontier sign-in preparation/isolation (F3/F4); F1/F2 live acceptance stays open.
