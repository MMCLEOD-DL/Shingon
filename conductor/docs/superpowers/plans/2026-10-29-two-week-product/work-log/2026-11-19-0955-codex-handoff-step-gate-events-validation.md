# Codex handoff — step gate service event validation

- Packet/subpacket: P09 G4 service projection and supporting P07 validation. Owner Codex; Claude owns richer UI rendering. Engine review is recorded in `reviews/2026-11-19-codex-review-g4-service-handoff.md`.
- Source branch `codex/step-gate-service-events`, baseline `f3033a865692d4ae07893e224d1b66b1038c4589`, code head `80b90be846b35455d2329ce61dbd01e433f02689`. [PR128](https://github.com/MMCLEOD-DL/Shingon/pull/128) merged while validation was running, integration `22284b2c7b4d5581d6281cb3cc46acc3d8781eee`; exact code ancestry verified.
- This documentation-only follow-up branch `codex/step-gate-events-validation` starts at that merge and records the completed evidence. No code was pushed to the merged PR.

## Result and consumer handoff

The service now preserves allowlisted `gate`, `scope-flag` and `protected-path` metadata through authenticated progress, persistence and SSE replay. Activity messages summarize the outcome. Gate stage names are capped at 256 characters, excerpts at 3,000. Path lists have counts and explicit truncation, with at most 100 entries, 512 characters per entry and 8,000 combined characters. Strings use existing redaction and terminal-control stripping before clipping. Invalid typed fields and unselected worker fields are omitted.

Claude: consume the additive fields documented in `docs/operator-app/interface.md` for richer UI rendering. `index` is zero-based; list counts describe supplied string entries, and `truncated:true` means the display is incomplete. Gate/scope/protected activity does not change approval or outcome rules. Cross-review of this service projection remains requested; it is not represented as completed. No engine or UI source changes were made.

## Validation at code head80b90be

Native Windows, Node24.12.0, existing Playwright1.63.0. Synthetic model participants and fixture servers only; no real model/subscription calls, worker restarts or policy changes.

- Reproduction: new G4 transport regression **FAIL** before implementation: only generic engineType/participant/role/ok metadata survived. After implementation, focused transport plus real-engine service journey **2/2 PASS**, exit0. Transport checks include malformed fields, oversized lists/output, clipping-boundary redaction, persisted state, unauthenticated401 and exact authenticated SSE replay. The real engine executes an actual `node --version` gate with stand-in model CLIs.
- Existing supplied G4 behavior suite: `node --test test/step-gate.test.js`, **12/12 PASS**, exit0. Gate order/reviewer suppression, scope flags and factory-only protected-path checks reproduced. Stubbed command outcomes remain distinct from live model validation.
- Full native `node --test --test-concurrency=4`: **1,728 total; 1,526 pass / 201 fail / 1 skip**, exit1, 425seconds. Private log `%TEMP%/shingon-step-gate-events-full.log`. This matches the prior recorded201 remaining Windows failure count; failures have not all been reclassified. Native suite is **not green**. The G4 transport and real-engine gate controls pass in this run.
- `operator-web/`: `npm test` **86/86 PASS**, 3files; `npm run build` PASS. With existing global Playwright on NODE_PATH, `node e2e/journey.mjs`: fixture/browser **22/22**, real-engine with stand-in CLIs **6/6**, restart/Resume/fallback **4/4**, exit0. These do not establish live-model acceptance or richer G4 UI rendering.
- [Linux CI run44499866374](https://github.com/MMCLEOD-DL/Shingon/actions/runs/44499866374): Conductor **1,725 pass / 0 fail / 3 skip**, 1,728total; **all four jobs PASS** (Conductor, knowledge, operator-web, Foundation). Risk-gate approval was separately handled by Malcolm's merge.
- `git diff --check` PASS. Existing untracked Windows acceptance report untouched and excluded. No test assertions or approval gates weakened.

## Next action

Merge this evidence-only follow-up through ordinary checks; no protected paths are changed. P07/P08 and P09 remain IN_PROGRESS. Claude's UI rendering is separate. After the latest submission is merged, inspect the current ledger before taking the next Codex task; the outstanding P09 backlog review is an authorized candidate. Broader native/live acceptance requires its applicable host/sign-in/scope and cannot be inferred from these synthetic checks. Legacy h2/j4 reservation, held native promotion, spent bindings and immutable archives remain unchanged.
