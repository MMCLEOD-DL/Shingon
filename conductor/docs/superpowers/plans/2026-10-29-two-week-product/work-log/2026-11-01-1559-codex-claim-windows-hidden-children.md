# Codex claim: P08 F5 hidden child consoles

Owner Codex; independent reviewer Claude pending. IN_PROGRESS.
Branch codex/windows-hidden-children; baseline630598d (PR72 merged with green CI).
PR66 assigns F5 to Codex: runCommand/spawnTracked detach children without
windowsHide. Scope src/exec.js, focused launch/cancellation tests and setup/ledger
documentation. Keep tracked PIDs, pipes, detached process groups and taskkill
tree cleanup. Ordinary console windows only; no hiding or automating UAC prompts.
No model/subscription, credential, worker/policy or deployment operation.

Backlog audit for F3/F4: official authentication documentation plus pinned
openai/codex rust-v0.163.0 login/src/auth/storage.rs show file auth at
CODEX_HOME/auth.json and keyring compute_store_key hashes canonical CODEX_HOME.
config/src/loader/local.rs loads user config from that same home. Thus changing
home does not transparently preserve existing sign-in, even with keyring mode.
No credential reads/copies/symlinks or invented auth override. Next auth task
needs dedicated persistent frontier home plus supported user-initiated sign-in
preparation and acceptance; personal config/system-managed policy distinction
must be documented. F5 is independent and can advance while that larger migration
is designed. F1/F2 real model/UAC checks remain separate operator acceptance.
