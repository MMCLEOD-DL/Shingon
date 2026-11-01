# Codex claim: P08 F2 local sandbox state

Owner Codex; reviewer Claude. IN_PROGRESS. Branch codex/local-sandbox-state.
Baseline d2a2e70 (PR68 and independent review/checklist PR69 merged).
Shared seam handoff: PR66 F2 and PR69 R1/R2 explicitly assigned to Codex.
Owned paths: adapters/codex.js, adapters/localAgent.js, new private-home helper,
adapter tests and setup.md; plan status and this ledger. No Claude-owned UI changes.
Implement stable Windows-local CODEX_HOME, with OS-lifetime cross-process exclusion,
configuration refresh and unchanged provider/credential/sandbox choices. Other hosts
and frontier authentication retain existing behavior. Add cross-platform F1 default
test. Reproduce state loss with a native stand-in; test reuse, config separation,
concurrency, failure cleanup and process-death lease release. Real UAC outcome
remains unmeasured: no model/credential/UAC/worker or Windows policy operation.
Source basis: OpenAI codex rust-v0.163.0 windows-sandbox-rs/src/setup.rs stores
.sandbox/setup_marker.json and .sandbox-secrets/sandbox_users.json below CODEX_HOME;
elevated_impl.rs passes that home into setup. Do not copy these files or change
ACLs: retain the home and let Codex manage its own state.
