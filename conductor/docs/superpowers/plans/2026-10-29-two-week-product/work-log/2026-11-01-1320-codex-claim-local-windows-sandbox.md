# Codex claim: local Windows sandbox (P08 F1)

Owner Codex; reviewer Claude. Status IN_PROGRESS.
Branch codex/local-windows-sandbox; clean baseline 789c6a23327ed722cd50b00236d12362eacee3c6.
Prior submission codex/review-kb-http is merged (PR60).
PR66 assigns F1 to Codex. Shared seams: conductor/src/adapters/localAgent.js and
src/config.js; owned tests and docs/operator-app/setup.md. No Claude UI changes.
Reproduce missing Windows config, add validated windowsSandbox option, default to
elevated on native Windows, preserve existing extraConfig overrides and read-only
reviews. Test pure config and real native child boundary with a stand-in CLI.
No live model/subscription calls, credential reads or sandbox setup operation.
F2 UAC cause remains unproven; no persistent-home change in this task.
Malcolm's 1 November 'go ahead' approves the proposed sequence, including F8's
failing-test rule; record F8 as a separate queued engine task after this PR.
