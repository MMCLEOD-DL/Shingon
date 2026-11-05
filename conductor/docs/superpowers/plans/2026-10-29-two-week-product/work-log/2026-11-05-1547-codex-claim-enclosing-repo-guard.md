# Codex claim — enclosing-repository guard regression

- P07/P08, Codex owner, branch `codex/guard-enclosing-repo` from main `3842218` after verified PR92 submission inclusion. Addresses Claude PR93 T1: broken workspace HEAD allows Git to discover an enclosing repository; the existing common-dir guard must reject and poison it.
- Scope: one portable synthetic Git regression and evidence records. No production guard, approval, credential, UI or policy changes. Prove real upward discovery, refusal and poison, unchanged enclosing/source refs; disable only the guard in an isolated source copy to prove test sensitivity.
- Next: native Windows check, mutation control and required CI in one focused PR; then independently review PR96 in a separate task/record. No live calls or worker operation. Preserve Claude ownership and explicit automation pauses.
