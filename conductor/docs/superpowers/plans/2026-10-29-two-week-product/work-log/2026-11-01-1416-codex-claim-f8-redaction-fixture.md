# Codex claim: land the F8 CI redaction-fixture correction

Owner Codex; reviewer Claude pending. IN_PROGRESS.
Branch codex/f8-redaction-fixture, fresh from current main 2fac5a3.
PR71 merged at old head 1e98a1f while its CI fixture correction was in progress;
verified by GitHub merged metadata and actual origin/main tree. The later df8ffb3
and f5d542f were not included. Do not treat them as already delivered or wait on
the now-closed PR. Merge their existing branch history into this fresh branch
without rewriting it. Only product-adjacent change is test/keyleak.test.js, plus
ledger/status entries. No engine/UI/credential/workflow change. Original CI failure
was 1588pass/1fail due to absent failed-step review call, not a demonstrated leak.
All original no-leak checks remain; added redacted producer retry/final-review
coverage follows F8's new behavior. Open a dedicated small follow-up PR and watch
its new-head CI before proceeding with another task.
