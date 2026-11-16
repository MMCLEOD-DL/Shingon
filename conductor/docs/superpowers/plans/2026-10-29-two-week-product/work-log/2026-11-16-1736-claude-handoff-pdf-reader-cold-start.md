# Claude handoff: PDF reader start-up timed apart from the read

```
Packet/subpacket: P02 follow-up (Foundation OCR, Claude-owned). Follows work-log/2026-11-16-17*-claude-claim-pdf-reader-cold-start.md.
Owner and reviewer: Claude; Codex reviews.
Status: IN_REVIEW. Packet rows in 04-work-log.md unchanged.
Baseline SHA: 66967a6 (PR118 merge). Branch: claude/brave-ride-tz7f25. Code commit: 6cada59.
Owned files changed: foundation/modules/ocr/src/{pdfChild,pdfText,pdfWorker}.ts, test/pdf-text.test.ts, test/slowStartChild.ts (new).
Contract version: none. The reader process protocol gained one leading "ready" line and one argument; both sides ship together in dist/.
```

## Reproduced first (cloud Linux, 4 CPUs, Node 22.23.4, at 66967a6)

Fresh process each run, reading `test/fixtures/receipts/pdf/e-ticket.pdf` through `readPdf`:

| Load | First read | Second read | Result |
|---|---|---|---|
| idle (3 runs) | 392–425 ms | 401–430 ms | ok |
| 6 busy loops | 649–742 ms | 732–943 ms | ok |
| 40 busy loops (3 runs) | 3094–3115 ms | same | **every read killed, "This PDF couldn't be opened"** |

So the budget problem is not only a cold first read: under enough load every read fails, and the kill is misreported as
an unopenable PDF. The child alone (fed on stdin) took 379–417 ms idle and 787–1024 ms under 6 loops; the cost is the
pdfjs import, which lives in the worker thread.

## The change

- `pdfWorker.ts` loads pdfjs when the thread starts and posts `ready`; the PDF arrives in a second message.
- `pdfChild.ts` starts the worker at once, writes one line `ready` when the worker is, and only then reads stdin. Its
  own read deadline is armed at that point; before it, a start-up self-kill applies, so it still never outlives a dead
  parent. A fifth argument carries the start-up deadline.
- `pdfText.ts`: new exported `PDF_STARTUP_MS` (15 s) and `SLOW_PDF`. The parent arms the start-up allowance at spawn and
  the 3 s read clock on the ready line; bytes before the first newline are the marker, the rest the reply, and
  `MAX_REPLY_BYTES` still counts all of it. `runReader` answers `'slow'` only when its own timer killed the child, and
  `readInProcess` throws `UnreadableError(SLOW_PDF)` for that. Memory, oversize and non-zero exits still give
  `UNOPENABLE_PDF`, as the existing tests pin. Test knobs `childFile` and `startupMs` were added to `PdfReadOptions`.

One posture change, recorded: pdfjs (code, never the PDF) is now loaded before the pre-scan runs, so the process carries
pdfjs's memory while scanning. The 320 MB ceilings are unchanged and the memory-bomb tests pass. One behavioural change:
a read may now take up to `PDF_STARTUP_MS` plus 3 s, which can exceed a very short engine `timeoutMs`; the engine's own
timeout (`local.ts`) still bounds the reading and retires it.

## Checks (from `foundation/`, after `npm ci`)

- New tests in `pdf-text.test.ts`, "start-up and the read are timed apart", each shown failing on the old code first:
  slow start (3.5 s) with a quick read succeeds; read clock exceeded gives `SLOW_PDF`; start-up allowance exceeded
  gives `SLOW_PDF` and the process is gone; a junk PDF is still "couldn't be opened" (control, passed before and after).
- `npx vitest run --project @hf/ocr pdf-text.test.ts extract.test.ts read-receipt.test.ts local.test.ts --maxWorkers=1`:
  **295 passed** (63 in pdf-text: 59 + 4), exit 0. Re-run of pdf-text alone by the orchestrator: 63 passed.
- `npm run lint`: exit 0. `npm run typecheck`: exit 0. `tsc -b modules/ocr`: `dist/pdfChild.js` and `dist/pdfWorker.js`
  carry the ready line.
- Same 40-loop load after the fix: first reads 4.7–4.9 s, all succeed with 6 lines.

## Live / fake / skipped / unrun

Synthetic fixtures only. Not run: the full Foundation `npm test` (needs Postgres; CI runs it), `npm run test:ocr`,
native Windows, a test that splits the ready marker across stdout chunks (the parser handles it).

## External blocker and exact owner/action

None. No high-risk path. Needs Malcolm's merge (auto-merge is off on the repository).

## Next packet unblocked

G1 (per-step report from run logs).
