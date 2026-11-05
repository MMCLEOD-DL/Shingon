# Codex UAC follow-up — 5 November 2026

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

Next acceptance dependency: independently observe the configured local participant
with its own retained home, using the applicable live permission and the existing
LocalAI key through a hidden local prompt if it is unavailable in the test process.
The earlier isolated service is stopped and its key was not persisted. Do not read
another process's credentials or silently start/reconfigure the shared worker.
Full browser presentation, abrupt/power-loss recovery and live failed-step gating
remain separate from these nonce-writing checks.
