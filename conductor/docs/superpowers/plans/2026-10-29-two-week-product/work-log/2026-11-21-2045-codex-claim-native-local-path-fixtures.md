# Codex claim — native local path fixtures

Packet P07, owner Codex / BlueLake, reviewer Claude invited. Branch codex/native-local-path-fixtures; baseline3b71c10 includes final913c0d1 PR156, verified merged. Isolated checkout only.

Own seven FIX-LOCALPATH rows W006/W009/W061/W062/W063/W108/W109. Reproduce first, then replace POSIX-only local path literals/expectations with native absolute synthetic paths and exact path-derived assertions in cli-factory-build, cli, factory-cli, factory-config and factory-projects tests. Keep local key-path expansion distinct from remote POSIX workRoot and retain traversal/filter/sorting/message checks. No source/runtime change intended.

Next action focused before/after, full native suite and exact53failure reconciliation, final evidence and required checks. P07/P08 remain IN_PROGRESS. No model, worker, actual credential/key read, SSH/remote, release, host Git/policy or Claude-owned UI operation. No next task until final submission merges.
