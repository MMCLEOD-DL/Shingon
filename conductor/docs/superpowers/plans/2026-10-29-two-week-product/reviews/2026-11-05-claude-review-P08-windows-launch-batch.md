# Claude review: seven P08 Windows launch follow-ups (PR68, 70, 73, 74, 75, 78, 79)

- **Reviewed (all merged; post-merge review):**

  | PR | Merge | Change |
  |---|---|---|
  | [68](https://github.com/MMCLEOD-DL/Shingon/pull/68) | `5627443` | Local private home sets the Windows sandbox (`elevated` default, `windowsSandbox` option) |
  | [70](https://github.com/MMCLEOD-DL/Shingon/pull/70) | `3950535` | Retained local Codex home on Windows, with an OS-owned lease (`privateCodexHome.js`) |
  | [73](https://github.com/MMCLEOD-DL/Shingon/pull/73) | `bacb098` | `windowsHide: true` on `runCommand` and `spawnTracked` |
  | [74](https://github.com/MMCLEOD-DL/Shingon/pull/74) | `76a0579` | Adds the installation's `codex-path` (rg) to the Codex child's PATH |
  | [75](https://github.com/MMCLEOD-DL/Shingon/pull/75) | `2988702` | Fixed, bounded probe guidance; probe-worker failure evidence |
  | [78](https://github.com/MMCLEOD-DL/Shingon/pull/78) | `5bddac3` | Config files with a UTF-8 BOM (PowerShell 5.1) load |
  | [79](https://github.com/MMCLEOD-DL/Shingon/pull/79) | `07fc9d5` | Local-agent probe refuses Codex older than 0.163.0 |

  Requested in Codex's 1 November submissions ("independent reviewer Claude pending"). PR76 is reviewed separately (`2026-11-05-claude-review-PR76-frontier-codex-home.md`).
- **Disposition: no blocking findings.** Three low notes.

## What I checked

- **Hidden windows cover every launch (PR73).** I searched `src/` and `bin/` for `spawn`, `spawnSync`, `fork` and `execFile*`. Every process launch sets `windowsHide: true`: `runCommand`, `spawnTracked`, `taskkill`, and the service's worker and probe forks. Nothing launches outside them.
- **Private homes (PR68, PR70):**
  - the local home config validates `windowsSandbox` and never reads personal config;
  - a retained home is used only with a lease;
  - the generated config refuses symbolic links and hard links;
  - the home must be outside the agent workspace;
  - a non-retained home is removed in `finally`, including when setup fails.
  - The lease is a named pipe on Windows and an abstract socket on Linux, so a crash releases it.
- **PATH addition (PR74).** The helper folder is accepted only next to an absolute `codex`/`codex.exe` path under `bin` or `codex`, only when it really contains `rg`, and never if it contains a PATH delimiter. Duplicate Windows `Path`/`PATH` keys collapse to the one Node would use. Nothing found by walking the disk or relative to the cwd.
- **Probe guidance (PR75).** Guidance text is fixed, and no CLI output is ever put into it. A thrown adapter error, for example the busy lease, becomes a classified failure rather than a crash. File evidence separates missing, mismatched and unreadable.
- **BOM (PR78).** Exactly one leading `U+FEFF` is removed; JSON validation is unchanged.
- **Version guard (PR79).** [`fixtures/p08-batch-version-guard.mjs`](fixtures/p08-batch-version-guard.mjs) runs `performProbe` with a stubbed `--version`:
  - **Accepted:** `codex-cli 0.163.0`, the same with a trailing newline, `codex-cli 1.0.0`, `OpenAI Codex v0.170.1`, `codex 0.163.0+build.7`.
  - **Refused:** `0.162.9`, `0.122.0`, the pre-release `0.163.0-alpha.2`, `0.0163.0` (leading zero), and a version preceded by another stdout line.

## Checks (cloud Linux, Node 22.23.4, main at `7b9d186` (code unchanged since `40b8388`))

`node --test --test-concurrency=4` over the batch's own test files, with `XDG_CACHE_HOME` outside the temp directory: 66 pass, 0 fail, 0 skip. The files are:
- `codex-search-path`, `config-bom`, `exec`, `hidden-children`, `local-windows-sandbox`, `localAgent`, `private-codex-home`;
- `service/{local-codex-version, probe-guidance, probe}`.

**Environment trap, not a defect.** With `XDG_CACHE_HOME` under `/tmp`, `localAgent.test.js` "runs codex with a private CODEX_HOME holding generated config" fails ("home … is under the temp dir"). That is the intended guard: Codex refuses helper shims under `/tmp`, and the workspace-write sandbox can write there. `05-validation.md` already says to keep `XDG_CACHE_HOME` out of the temp directory.

## Notes (low)

- **N1 (PR79):** if a Codex build ever prints anything else to stdout before its version line, a supported version is refused with the "version" guidance. I don't know of a release that does this; matching the last non-empty line would be more tolerant.
- **N2 (PR79):** the version guard applies to connection checks only. A run started from the CLI with an older Codex is not stopped by it. This matches the submission ("cannot prove model compatibility"), so I'm recording the boundary, not asking for a change.
- **N3 (PR70/76):** the busy-lease message names a "local" home for frontier calls too. This is the same as N1 in the PR76 review.

## Not verified here

Native Windows: hidden consoles, the elevated sandbox, `rg` lookup through `codex-path`, PowerShell-written config. Codex's native runs are the evidence for those. No live models.
