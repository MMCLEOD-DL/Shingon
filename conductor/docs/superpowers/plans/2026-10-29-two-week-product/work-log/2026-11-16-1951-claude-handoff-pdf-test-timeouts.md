# Claude: the first three PDF tests get the file's 30 second timeout

```
Packet/subpacket: P02 follow-up (Foundation OCR tests, Claude-owned). Follows the PDF reader start-up fix (PR119) and the
  CI failures recorded in PR120's comment.
Owner and reviewer: Claude; Codex reviews.
Status: IN_REVIEW. Packet rows in 04-work-log.md unchanged. Claim and handoff in one entry: the change is three lines.
Baseline SHA: 2779236 (PR120 merge). Branch: claude/brave-ride-tz7f25. Code commit: d988ced.
Owned files: foundation/modules/ocr/test/pdf-text.test.ts only.
```

## The evidence

Two PRs that did not touch Foundation had their required `foundation` check go red on the same test,
`@hf/ocr test/pdf-text.test.ts > a text PDF gives its lines with confidence 1`, and pass on a single re-run:

| Run (attempt 1) | PR | Failure |
|---|---|---|
| 43916490665 | PR118 (operator-web only) | "This PDF couldn't be opened" from the reader's 3 s limit, fixed by PR119 |
| 43926523186 | PR120 (conductor only) | "Test timed out in 5000ms", vitest's default per-test timeout |

The test is the first PDF read after `createLocalEngine()`. On the loaded CI runner (`npm test -- --maxWorkers=1` with a
Postgres container) its cold start, Node child plus the pdfjs import, exceeds 5 s. After PR119 the read itself is no
longer killed; the harness timeout was the remaining limit. The other tests in the file already use 30 s.

## The change

The first three tests (`a text PDF gives its lines`, `a scanned PDF is refused`, `a PDF that is not a PDF inside`) now
pass `30_000` like the rest of the file, with a comment saying why. The reader's own limits (`PDF_STARTUP_MS`, then the
3 s read clock) still apply inside the test; this changes only how long the harness waits for a correct answer.

## Checks (cloud Linux, Node 22.23.4, from `foundation/`)

- `npx vitest run --project @hf/ocr pdf-text.test.ts --maxWorkers=1`: 63 passed, exit 0.
- `npm run lint`: exit 0.
- The CI condition (a loaded runner's cold start over 5 s) cannot be reproduced here on demand; the two CI logs above are
  the failing evidence, and CI on this PR is the passing one.

## Live / fake / skipped / unrun

Synthetic fixtures only. Not run: the full Foundation suite (CI), native Windows.

## Next

Nothing queued in the Claude lane after this. Candidates and what each waits for are in the chat report.
