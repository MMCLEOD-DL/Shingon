# Windows UAC follow-up — 5 November 2026

Baseline: PR82 merge `b68e3b003828dfb9d0110966eb7a57845941d6c9`, including final
submission `b93b461`; all five required checks pass. This follows the
[native retest](windows-retest-2026-11-05.md), which recorded three administrator
consent prompts without participant attribution.

Malcolm explicitly agreed to observe two small Codex-only subscription checks.
Both used the existing dedicated, signed-in Conductor home, the configured native
Codex0.163.0 executable and one fresh synthetic repository. Each launched a separate
CLI process, requested one nonce file and independently verified its contents.
No LocalAI request/key, worker operation, personal auth inspection/copy, sandbox
policy change or deployment was involved. API-key/OAuth environment alternatives
were removed from the check launcher; the existing dedicated ChatGPT sign-in was
the authentication route. No login/status command was issued.

| Check | Started (UTC) | File verification | Operator-reported UAC prompts |
|---|---|---|---|
| Codex write 1 | 11:29:58 | PASS | 0 |
| Codex write 2, same folder and home | 11:30:28 | PASS | 0 |

Both calls return successful results. Only the two expected nonce files are added
to the disposable repository; result/attempt records remain outside its workspace.
The attempts are spent and are not to be reused.

Read-only inspection of the dedicated home's dated sandbox log finds 30 new log
lines during these checks, with no new setup-success event, missing-marker/version
message or OS error32. Earlier logs in both retained Codex/local homes had repeated
setup events and OS error32. Those earlier events do not establish which displayed
the three prompts. Home identity remains stable; logical/native paths agree. No
sandbox credential/state-secret file contents were read; raw traces remain private.

This demonstrates two repeated Codex writes without UAC in one folder on this
candidate. It does **not** establish that PR82 caused the absence of prompts:
there is no matched counterfactual. It does not close LocalAI's separate home,
different-folder/reboot cases or explain the original three observations.

The [official OpenAI Windows sandbox documentation](https://learn.chatgpt.com/docs/windows/windows-sandbox),
consulted on 5 November, confirms that elevated setup needs administrator approval.
It does not establish the recurrence cause for this installed CLI/version. No
sandbox implementation or policy was changed to suppress consent.

## Local participant follow-up

Malcolm then explicitly requested the LocalAI test. Baseline: PR83 merge
`0dc247cd29b1377070513fe6171cbd4344fa6d44`, including final submission `a7d2002`;
all five final-head checks passed by the end of the local checks. Runtime remains
the PR82 code. Worker readiness was HTTP200; no worker start/restart was needed.

The existing configured local model `shingon-qwen3.8-27b-q4` used native
Codex0.163.0 and its own retained generated home. The process lacked the provider
key, so Malcolm entered it once through a secure hidden-input PowerShell prompt.
A private controller retained it in process environment for both calls, passed
only the local participant its required binding, and removed API/subscription
credential alternatives. No key was written to chat, files, arguments or reports.
No authentication or sandbox-secret file contents were inspected/copied.

Each call requested and verified one nonce file in the same fresh synthetic
repository. Attempts/results stayed outside the model workspace; both attempts
are spent. Each call used a separate native CLI process with the same retained
home. The visible key-entry terminal was expected and was not counted as UAC.

| Check | Started–finished (UTC) | File verification | Operator-reported UAC prompts | New setup-success / missing-marker-version events |
|---|---|---|---|---|
| Local write 1 | 11:38:55–11:39:31 | PASS | 1 | 1 / 1 |
| Local write 2, same folder and home | 11:39:50–11:40:18 | PASS | 0 | 0 / 0 |

Read-only dated sandbox-log comparison finds 43 lines for Check1 and 24 for
Check2, with no OS error32 in either interval. The first observed UAC prompt
coincides with fresh setup; the immediate repeat reuses it without another prompt.
This does not establish why the previously retained home needed setup again, or
whether the marker was absent versus a version mismatch. No marker, credential,
ACL, firewall or sandbox-policy state was manually repaired to suppress consent.

Both actual local writes and immediate reuse pass. The result is **1 then 0**
prompts, not a zero-prompt first-call claim or permanent closure of recurrence.
Different folders, service/host restarts, longer idle periods and the original
three prompts remain outside this pair. No additional model calls were used to
manufacture a broader conclusion.

After both checks the controller removed its key binding and exited; the parent
prompt cleared its environment binding, disposed the secure input and exited.
Both owned processes were verified absent. The shared worker was left running;
the earlier isolated service remains stopped. Only the two expected nonce files
are untracked in the disposable repository; no source/client repository was
modified by these model calls.

Remaining acceptance: explain the retained-home setup invalidation if it recurs,
then separately observe any authorized different-folder/restart/reboot case.
Full browser presentation, ordinary console-flash observation, abrupt/power-loss
recovery and live failed-step gating remain separate. Do not recover credentials
from another process, silently restart/reconfigure the worker, weaken sandbox
policies or launch further checks without applicable permission and readiness.
