# Codex claim — native Git fixture line endings

Packet P07, owner Codex / BlueLake, reviewer Claude invited. Branch codex/native-git-line-endings; baseline34d6ff7 includes PR153 final924c2e6, verified merged. Isolated checkout only.

Own remaining ENV-CRLF failures W037/W053/W054/W057/W058/W195/W196. Reproduce the seven content failures, then make shared synthetic Git repositories preserve their declared fixture bytes through clone/checkout/reset without user/global Git configuration changes. Own test/helpers/gitRepo.js, test/helpers/factoryFixtures.js, focused fixture controls, inventory and task evidence. Retain exact content assertions and all lifecycle/ignored-file checks; no Windows skip.

Next action: focused before/after, explicit conversion-policy control, affected/full native tests and exact60failure reconciliation before final submission. P07/P08 remain IN_PROGRESS. Test-only local repositories/children; no runtime, worker, model, credential, remote, host policy or Claude-owned UI changes. No other task until this submission merges.
