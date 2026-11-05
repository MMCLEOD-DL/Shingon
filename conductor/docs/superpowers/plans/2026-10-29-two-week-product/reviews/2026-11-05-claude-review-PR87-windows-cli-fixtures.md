# Claude review: PR87, native Windows CLI test fixtures

- **Reviewed:** [PR87](https://github.com/MMCLEOD-DL/Shingon/pull/87) at `6d792d4` (code commit `c4a7629`), base `820501b`. Requested in Codex's handoff `work-log/2026-11-05-1417-codex-handoff-windows-cli-fixtures.md`, with emphasis on argument/stream forwarding and cancellation.
- **Scope:** `conductor/test/helpers/{nativeStubLauncher.cs, stubCli.js}`, `conductor/test/stub-cli.test.js`, the `05-validation.md` note. Test-only; no `src/**` change.
- **Disposition: no blocking findings.** Malcolm merged PR87 as `4c8b2fb` while this review was in progress, so this is a post-merge review: it asks for no change to that merge.

## What I verified, and how

| Claim | Evidence (cloud Linux, Node 22.23.4) | Kind |
|---|---|---|
| Launcher quoting returns the exact arguments to `node.exe` (empty, spaces, tabs, `"`, trailing and pre-quote backslashes, newline, Unicode, `& % ^`) | [`fixtures/pr87-launcher-quoting.mjs`](fixtures/pr87-launcher-quoting.mjs) ports `Quote()` and parses with the Windows C-runtime argv rules: 200,002 argument lists round-trip, including the PR's own eight. Controls: not doubling trailing backslashes (`--mutate=tail`) or pre-quote backslashes (`--mutate=inner`) each fail. | Synthetic model of the parser, not native execution |
| No shell is involved | `ProcessStartInfo(node, args)` with `UseShellExecute=false`; the `& echo NOT_A_SHELL` argument is passed literally by `runCommand` (`spawn` without `shell`). | Code reading |
| Streams and exit status | Raw `BaseStream` copies for stdout/stderr, awaited after `WaitForExit`, so no output is lost or re-encoded; stdin copied, then the child's stdin closed on EOF. `runCommand` always ends stdin, so EOF always arrives. Exit status returned unchanged; launcher failure is 127 with a message. | Code reading |
| Cancellation | `stopChild` on Windows runs `taskkill /PID <launcher> /T /F`, which covers the launcher's Node child. Codex's native timeout test asserts the child PID is gone. | Code reading + Codex's native run (not re-run here) |
| POSIX path unchanged | At `6d792d4`: `node --test --test-concurrency=4 test/stub-cli.test.js test/service/engine.test.js test/frontier-codex-home.test.js test/local-windows-sandbox.test.js` → 17 tests, 16 pass, 0 fail, 1 skipped (the Windows-only timeout test). All five required CI checks green on the head. | Synthetic fixtures, Linux |

## Notes (none blocking)

- **N1, low: fallback cancellation path.** If `taskkill` itself fails, `stopChild` falls back to `child.kill()`, which ends only the launcher. Its Node child would be orphaned, which the POSIX shebang fixture does not have. Output pipes still close, because the child writes to the launcher, so `runCommand` cannot hang. Real Windows CLIs that spawn helpers have the same shape, so no change is asked for here.
- **N2, low: fidelity of the stand-in executable.** The fixtures are `.exe` files. They cannot show a regression in how real CLIs are found on Windows, for example an npm `.cmd` shim, which Node refuses to spawn without a shell. That remains covered only by native live checks (P08). Recording it so a green fixture run is not read as proof of CLI resolution.
- **N3, low: timeout-test timing.** On a very slow host, the 2-second timeout could fire before Node writes `child.pid`. The test would then fail on `started-marker`, a false failure rather than a false pass. Acceptable.

## Not verified here

- Native execution of the launcher, including .NET Framework's parsing of the launcher's own command line (libuv → CLR) and stdin behaviour under a UTF-8 console code page. That rests on Codex's native run: 17 pass, 0 fail, 0 skip, plus the separate 63/1 result with the unchanged mode-0700 observation.
- The mode-0700 observation itself: out of scope, and correctly left unrelaxed.
