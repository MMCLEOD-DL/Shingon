# Claude task 36: first live run on Windows, results and handoff to Codex

```
Packet/subpacket: P08 live acceptance, first run (Codex owns P08; Claude independent reviewer). Run by Malcolm on
  31 October 2026 on his Windows 11 desktop (RTX 4090), guided step by step by Claude from the cloud lane using
  conductor/docs/operator-app/real-run-checklist.md. Claude could not reach the machine: every result below is what
  Malcolm ran and reported (pasted output and screenshots), not an independent Claude observation.
Owner and reviewer: Claude (record and checklist); Codex (P08 owner) reviews and owns the runtime fixes below.
Status: IN_REVIEW.
Baseline SHA: b15a156 (main; the commit Malcolm built and ran).
Owned files: conductor/docs/operator-app/real-run-checklist.md ("Learned 31 Oct" corrections); this entry.
Host and versions: Windows 11, native PowerShell (no WSL for the app), Node 24, Claude Code 2.1.304 (native
  claude.exe), Codex CLI 0.163.0 (npm package's native bin\codex.exe; 0.122.0 was installed and was updated),
  local model shingon-qwen3.8-27b-q4 via LocalAI on CT 110 with the desktop GPU worker.
```

## Results (live: real Claude and Codex subscriptions and the real local model)

| Step | Result | Notes |
|---|---|---|
| Build (`npm ci`, `npm run build`) | Pass | commit b15a156 |
| Native executables | Pass after set-up | claude.exe native; Codex only as npm shims until the package's own `bin\codex.exe` was used |
| Local model | Pass after set-up | needed the key from CT 110 and the desktop worker started by hand |
| Nine participant checks | Pass after fixes | Claude sign-in had expired; first Codex "can code" failed once (most likely first-run Windows sandbox set-up, not proven); local needed the sandbox workaround (finding F1) |
| Task 1: approve (multiply) | Pass | correct diff (multiply plus three-case test; also reflowed the one-line test file); `node --test` 2/2 on the branch; one `conductor/...` branch; main still `start`; checkout clean |
| Task 2: reject (rename add to sum) | Pass | diff correct (dropped the files' final newline); rejected; no new branch |
| Task 3a: Stop run | Pass | Interrupted; Malcolm reports nothing left in Task Manager |
| Task 3b: Ctrl-C mid-run, restart, Resume | Pass | log shows the stop, resume redid only the unfinished step 1, then step 2; approved; exactly two branches in total |
| Task 4: local worker stopped | Pass | "The local model is unavailable" with Pause / Use subscriptions within about 2 s; Pause chosen |

Engine behaviour seen in the Task 3 activity log: Claude authored the plan and Codex reviewed it; the local model
did both coding steps; step 1 was reviewed by Codex and step 2 by Claude; Codex gave the final review. Start to
landed, including two interruptions: about four minutes. Timings for Task 1 were not recorded.

## Findings

Runtime, for Codex (Conductor engine/adapter and service code):

- **F1 (blocking on Windows): the local model cannot write files.** `LocalAgentAdapter` gives Codex a fresh private
  `CODEX_HOME` per run (`src/adapters/localAgent.js` `localCodexConfig`, `src/adapters/codex.js` home creation). On
  Windows, Codex's workspace-write sandbox depends on `[windows] sandbox` in that folder's config; without it every
  command the local model ran was refused as read-only (the model said so in its reply; no file written). Workaround
  used: participant `"extraConfig": ["windows.sandbox=elevated"]` (passed as `-c`), after which the agentic check
  wrote the file in 28 s. Suggested fix: carry the operator's chosen `windows.sandbox` value into the private config
  (an explicit config field, not a copy of `~/.codex`), and add a Windows-shaped unit test of the generated config.
- **F2 (Windows, operator burden): UAC "Do you want to allow this app to make changes?" prompts on local-model runs.**
  With `elevated`, the prompts recur. Likely cause (not proven): the elevated sandbox's one-off administrator set-up
  is recorded per `CODEX_HOME`, and the local agent's folder is new every run. Suggested fix: one persistent private
  `CODEX_HOME` for the local agent (still isolated from `~/.codex`), so the set-up happens once. Malcolm is testing
  `windows.sandbox=unelevated` as an interim setting; record its result before relying on it.
- **F3: probes and runs write into the operator's personal Codex config.** `%USERPROFILE%\.codex\config.toml` gained
  about eight `[projects.'c:\users\...\appdata\local\temp\conductor-probe-...']` trust entries (plus diag and probe
  folders). Conductor should not change the operator's own settings; the frontier Codex participant could run with
  its own `CODEX_HOME` too, or the trust prompt could be avoided another way.
- **F4: the frontier Codex participant loads all the operator's personal Codex add-ons.** Malcolm's `~/.codex`
  includes MCP servers (Library of Babel, agent_mail, node_repl), a notify hook and plugins such as computer use and
  browser. A sandboxed reviewer gets those tools, and their start-up errors (`rmcp ... AuthRequired`, unreachable
  192.168.1.109:8765) slow every call. The local agent is already protected from this; the frontier one is not.
- **F5 (known, Codex's): console windows.** `src/exec.js` detached launches without `windowsHide`; not separately
  confirmed on this run (Malcolm's prompts were UAC, F2).
- **F6: the app starts `codex.exe` directly, so Codex's npm launcher no longer puts its `codex-path` folder (rg.exe)
  on PATH.** Worked round by prefixing PATH in the app's window. Either document it in setup.md or let the config name
  the Codex install folder and add it for the child.
- **F7: probe results hide the cause.** The Connections page shows only `unavailable`/`unauthorized`; diagnosing F1
  needed a hand-written script calling the adapter. A sanitised one-line error summary in the probe result would have
  saved most of an hour.

Set-up (recorded in the checklist, owner noted):

- S1: Codex 0.122 installed; Conductor's local-model path needs 0.163+ (`wire_api = "responses"`). setup.md (Codex)
  should state the minimum version, and the app could refuse older versions at "Check installation".
- S2: the npm Codex `.exe` path changes on update (`...\vendor\...\codex\codex.exe` became `...\bin\codex.exe`).
- S3: the LocalAI key is `LOCALAI_API_KEY` in CT 110 `/opt/shingon-localai/.env`; read through `pct exec` from the
  Proxmox host shell.
- S4: the desktop worker does not start on its own; `E:\SHINGON\desktop_worker\Start-LocalAI-Worker.ps1` starts it,
  and stopping needs `SHINGON_WSL_BIND` from `local\localai-network.json`. `/v1/models` lists the model even with the
  worker down, so a real request is the only proof it is up (Conductor's local-agent liveness check already does this).
- S5: Windows PowerShell 5.1 `Set-Content -Encoding utf8` writes a byte-order mark that `JSON.parse` rejects; write
  config with `-Encoding ascii`.

UI, for Claude (next PR, operator-web):

- U1: the activity log and status line show internal event names (`start`, `phase`, `chunk`, `plan-agreed`,
  `approve`, `finish`, `landed`, "checking") instead of plain words.
- U2: on "The local model is unavailable", **Use subscriptions** is the filled primary button and **Pause** the
  secondary one; the free, safer choice should not look like the lesser option.

## Live, fake, skipped, unrun

Live: everything in the results table. Not run: Task 1 timing; screenshots other than Task 4's fallback screen are
with Malcolm, not in the repository. Not tested: `windows.sandbox=unelevated` (in progress), Windows reboot recovery,
the Windows Service installer (none exists). No client data, no merge, push or release.

## Handoff

Codex: F1–F7 and S1 are yours (runtime and setup.md). F1 is the only one that stopped work; F2 is the one Malcolm
feels on every run. Please reproduce on the Windows host before changing code, and reply in reviews/ or a work-log
file. Claude: U1 and U2 next, then re-run the checklist steps they touch.
