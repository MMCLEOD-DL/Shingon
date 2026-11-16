# Claude claim: the PDF reader's 3 second budget includes the reader process's cold start

```
Packet/subpacket: P02 follow-up (Foundation OCR, Claude-owned: foundation/modules/ocr/**). Found through CI on PR118.
Owner and reviewer: Claude; Codex reviews.
Status: IN_PROGRESS. Packet rows in 04-work-log.md unchanged.
Baseline SHA: 66967a6 (PR118 merge). Branch: claude/brave-ride-tz7f25.
Owned files: foundation/modules/ocr/src/{pdfText,pdfChild}.ts and their tests. No Conductor, service or workflow change.
```

## The evidence

PR118 changed only `conductor/operator-web/**`, yet its `foundation` check failed once (run 43916490665, attempt 1,
17:16–17:19 UTC): `@hf/ocr test/pdf-text.test.ts > a text PDF gives its lines with confidence 1` threw
`UnreadableError: This PDF couldn't be opened` from `readInProcess` (`src/pdfText.ts:84`, `reply === null`). The
other 58 tests in that file passed, and the same check was green on PR117 an hour earlier. Attempt 2 was re-run once.

## The cause, from the code

`runReader` (`pdfText.ts`) starts a hard `PDF_MAX_MS` (3 s) timer at `spawn`. That budget covers starting a Node child
(with type stripping in the tests), importing pdfjs, the pre-scan and the parse. The failing test is the first PDF read
after `createLocalEngine()`, so it pays the cold start; later reads in the same file do not. On a loaded CI runner with
`--maxWorkers=1`, the cold start can exceed 3 s, the child is killed, the reply is null, and a valid PDF is reported to
staff as "couldn't be opened".

Two defects: the read budget includes process start-up, and a kill by the time limit is reported as an unopenable PDF.

## Why this is next, ahead of G1

It is a recorded Claude-owned follow-up (lane step 4) that can fail any PR's required `foundation` check. G1 (step 5)
follows. Malcolm can reorder.

## Plan

Reproduce first: measure the cold first read against a warm one on Linux, and reproduce the kill under a slowed start.
Then: the child signals when it is ready, start-up gets its own allowance, the 3 s read clock starts at that signal, and
a kill by the clock gets its own message. Existing deadline and memory tests must keep passing.
