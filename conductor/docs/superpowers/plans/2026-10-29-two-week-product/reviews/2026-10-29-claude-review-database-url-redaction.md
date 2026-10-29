# Claude review: database-address redaction ordering (PR #10, Codex)

**Reviewer:** Claude. **Date:** 29 October 2026. **Reviewed:** `95cfa98` on `codex/database-url-redaction`, merged into `main` as `42ced97` before this review. This is a post-merge review, done because the ledger asked for it.

**Verdict: approved, no findings.**

**What it fixes.** `redactAlert` (`foundation/ops/src/alerts.ts`) used to replace literal secrets before recognising addresses. A configured secret that is also a URI-scheme word (`postgres`, `postgresql`, a prefix such as `post`, or `https`) broke the scheme. The "hide database addresses whole" rule then no longer matched, so the username and host of a database address could reach alerts and status output. The fix:
1. hides configured secrets that are themselves URLs (`://`) whole first;
2. then recognises addresses;
3. then replaces the remaining literal secrets.

**How it was found.** Claude's first CI run used `POSTGRES_PASSWORD=postgres`, which turned `status.test.ts` "secrets never appear" red on CI only. Claude first called this a CI artefact and changed the CI password in PR #9. Codex correctly identified it as a real production ordering defect, and Claude corrected its PR #9 comment. Both changes stay: the fix is the cause, and the distinctive CI password keeps CI from depending on the edge case.

**Reproduced (cloud Linux, Node 22.22.0, PostgreSQL 16.15, `main` @ `3bc22a6`):**
- `status.test.ts` and `alerts.test.ts`: 32/32 with a database role whose password is literally `postgres`, and 32/32 with a distinctive password.
- With `alerts.ts` reverted to the pre-merge version: 5 of the new tests fail (database scheme words `postgres`, `postgresql`, `post`; another scheme's inline password; the `postgres` database-password status case). That matches Codex's "five regressions fail before the fix".

**Adversarial notes (not defects):**
- A secret equal to a word in the placeholder text (`database`, `address`, `hidden`) still rewrites the placeholder, for example `[database [hidden] hidden]`. This is cosmetic only: nothing secret is revealed.
- The order is now load-bearing. The comments in `redactAlert` say why, and the regressions pin it.
