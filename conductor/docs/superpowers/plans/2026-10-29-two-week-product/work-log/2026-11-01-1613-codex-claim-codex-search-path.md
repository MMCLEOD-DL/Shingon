# Codex claim: P08 F6 adjacent Codex search tools

Owner Codex; reviewer Claude pending. IN_PROGRESS.
Branch codex/codex-search-path, clean baseline bacb098 (PR73 merged, checks green).
Scope: Codex child environment helper/adapter, native and cross-platform tests,
setup docs/ledger. PR66 reports direct native execution misses adjacent codex-path
search tools. Only add a verified adjacent helper directory for an absolute native
Codex path; never search the task cwd or change the parent PATH. Preserve existing
PATH order, Windows case handling and credential filtering. No download/install,
version upgrade, auth change, live model/subscription or worker/policy action.
F3/F4 dedicated home/sign-in preparation remains a larger separate task.

Source audit: pinned rust-v0.163.0 npm wrapper resolves vendor/<target>/bin/codex
and passes package-manager metadata, but this inspected wrapper no longer prepends
codex-path. Therefore do not claim exact current-wrapper parity or that all
installations need this change. The reported adjacent-directory layout is handled
conditionally; missing helper or other layouts keep their existing environment.
