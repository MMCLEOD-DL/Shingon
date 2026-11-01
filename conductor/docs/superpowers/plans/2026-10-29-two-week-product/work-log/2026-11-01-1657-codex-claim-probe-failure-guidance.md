# Codex claim: P08 F7 safe probe failure guidance

Owner Codex; reviewer Claude pending. IN_PROGRESS.
Branch codex/probe-failure-guidance; baseline76a0579 (PR74 exact submission merged).
Scope: service/probe-worker.js and a bounded diagnostic helper, service probe tests,
setup docs/ledger. Use existing reason/action fields already rendered in Setup;
no Claude-owned UI or wire-schema changes. Distinguish missing verification file,
wrong contents/reply, timeout, sign-in/limit/version and known sandbox/access errors.
Use fixed summaries only: never send raw CLI/model output, paths, URLs, nonces,
tokens or stacks to the browser. Preserve actual challenge and file verification.
No model/subscription/credential/worker/policy operation; synthetic adapters only.
Service path is high-risk under the existing risk-gate. Do not change the gate or
approval labels. Keep draft pending CI and Malcolm's required approval.
F3/F4 dedicated sign-in/isolation remains a separate authentication migration.
