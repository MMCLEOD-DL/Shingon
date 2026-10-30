# Two-week delivery plan: a usable local Conductor app

**Planning baseline:** Shingon `8c712e906d66c50bfc7a58faa984f5eb411bd602`, 29 October 2026. This document is a new plan, not evidence that its tasks have been implemented or approved individually.

**Window:** Friday 30 October–Thursday 12 November 2026, ten weekdays. Dates use Europe/London. These are effort/scope targets, not autonomous schedules or promises. If work starts later, preserve the dependency order and move the dates.

**Working arrangement:** two implementation lanes, provisionally Codex and Claude, with reciprocal review. Either assistant can take either lane. One integration owner at a time. The user asked for a plan that supports parallel work; no agents, installations, model calls or deployment jobs are started by this document.

## 1. Outcome to aim for

A personal, local browser app where Malcolm can connect his existing local model and the Claude Code/Codex subscription CLIs, select a repository, describe a coding task, watch understandable progress, answer disagreements, inspect actual changes and tests, approve or reject, and resume interrupted work.

By the end, demonstrate one real synthetic coding task using the local model and both vendors. Keep the terminal interface working. Approval lands a new branch; it does not merge or ship a client app.

In parallel, deliver a source-backed knowledge-base recommendation, integration contract and a small synthetic retrieval experiment if capacity permits. The first fortnight does not promise a production company knowledge base or migration of Library of Babel.

### Must deliver

- Both newly reproduced Foundation defects fixed with regression tests and independent review.
- Local Conductor service over the existing engine, with persistent run visibility and safe browser decisions.
- Browser workflow for setup, task creation, progress, decisions, changes/tests, approval and history/resume.
- Repeatable setup/start instructions for a designated acceptance host; clear limitations elsewhere.
- Automated end-to-end checks with fake providers, plus separately recorded live checks with actual models where credentials/network allow.
- Knowledge-base inventory/access report, cited comparison, recommended architecture, read-only access contract and staged implementation/migration backlog.
- Honest acceptance report listing failed, skipped, mocked and blocked checks separately.

### Explicitly outside the fortnight

- Public distribution, signed installers, an Electron/Tauri wrapper, hosted multi-user control plane or remote browser access.
- A second orchestration engine, screen-scraping subscription websites or a new foundation for generated apps.
- Production company ingestion, live drive/email connectors, enterprise SSO and accounting connectors.
- Full expense approval/export features, unrestricted long-running research sessions, automatic self-modifying skills.
- Client-box deployment from the new UI. Existing factory commands remain CLI-only during this milestone.

## 2. What exists and what remains uncertain

Conductor is a Node ESM CLI, with no declared third-party runtime dependencies in its current package manifest. `src/conductor.js` exports `runTask` and `resume`; hooks include `onEvent`, `escalate`, `approveResult` and optional plan/chunk/fallback decisions. `src/runlog.js` writes transcripts and state outside agent workspaces. The app should adapt these seams, not scrape terminal output or recreate the pipeline.

Foundation has a separate React/Mantine web app. Reuse visual conventions and experience, not its account system or client-data store for operating the harness. Put the operator UI under Conductor. The target stack is Node ESM service plus React/Vite UI; choose and pin only the necessary dependencies in P03/P04, recording a licence and compatibility check. Do not extend Foundation's npm workspace to absorb Conductor.

Cloud setup verified Foundation build/lint/types/licences and 1,093 tests (6 skipped). The adversarial review's focused rerun passed 397 Foundation and 172 Conductor tests. These are baseline observations, not substitutes for checks after changes. Existing tests did not catch the two reproduced defects. Subscription sign-in, current local-model connectivity and a clean install on Malcolm's actual machine are unverified.

Known deferrals to read before reporting new issues:
- `../2026-10-27-factory-acceptance/FOLLOW-UPS.md`
- `../../../../spikes/*/RESULT.md` (from this folder, resolve to `conductor/spikes/`)

The old Windows project and this two-folder checkout have different histories/layouts. Do not copy old automation state or assume its approvals, addresses or file paths apply here.

## 3. Work split and critical path

| Packet | Deliverable | Primary owner | Reviewer | Depends on |
|---|---|---|---|---|
| P00 | Baseline, host matrix, frozen v1 contracts | Codex | Claude | — |
| P01 | Updater post-rename uncertainty fix | Codex | Claude | P00 baseline |
| P02 | Incomplete PDF confidence fix | Claude | Codex | P00 baseline |
| P03 | Engine service, state, decisions, transport | Codex | Claude | P00 contract |
| P04 | Operator UI against contract fixtures | Claude | Codex | P00 contract; can use mocks before P03 |
| P05 | Model setup, authenticated probes, install/start | Codex | Claude | P03 setup contract |
| P06 | KB inventory, research, recommendation, experiment | Claude | Codex | Research brief; access only for actual inventory |
| P07 | UI/service integration and adversarial tests | Codex | Claude | P03–P05; both fix only their owned files |
| P08 | Live three-model acceptance, recovery, handover | Codex coordinates | Claude independently reviews | P01–P07 |
| P09 | Next-phase backlog from earlier notes | Claude | Codex | P06 + observed product gaps |

UI critical path: **P00 → P03 + P04 → P05/P07 → P08**. P01/P02 run early and must not disappear behind UI work. P06 research is independent of UI integration until recommendations are accepted. A KB implementation must not become a hidden dependency of the coding app.

Read [task packets](01-task-packets.md), [interface contract](02-interface-contract.md), and [parallel working/handoff rules](03-parallel-working.md). Use [the work log](04-work-log.md) for packet statuses and [its entries](work-log/), one file each, as the current task ledger and [the validation runbook](05-validation.md) for commands and evidence rules.

## 4. Daily plan

Reserve roughly a quarter of capacity for reciprocal review, integration and failed checks. Each row is a focus, not a requirement to occupy every hour. Do not run both heavy suites simultaneously on the four-CPU cloud instance.

| Day | Date | Codex lane | Claude lane | Exit evidence |
|---|---|---|---|---|
| 1 | Fri 30 Oct | P00 inspect baseline/engine seams; propose contract; start P01 | Review contract; P02; start P06 source/inventory questions | Contract v1 frozen; both defects reproduced; host/access gaps named |
| 2 | Mon 2 Nov | Finish P01; review P02; P03 run/decision state | Review P01; finish P02; P06 options research | Safety fixes reviewed; regression checks pass; KB shortlist has sources |
| 3 | Tue 3 Nov | P03 service and event replay | P04 setup/task/progress screens using fixtures | Fake run visible; fixture and real API shapes agree |
| 4 | Wed 4 Nov | P03 decisions/recovery; start P05 model probes | P04 review/diff/approval/history | Browser decision round trip; duplicate/stale answers refused |
| 5 | Thu 5 Nov | Integrate first fake full journey; setup command | P04 usability pass; P06 draft recommendation | Week-one demo: fake task to branch approval; no shell required in normal UI flow |
| 6 | Fri 6 Nov | P05 acceptance-host install and real model connection checks | UI failures/reconnect; independent service review | Three connections distinguished from mere CLI installation; clean setup evidence |
| 7 | Mon 9 Nov | P07 boundary/recovery tests; fix backend defects | P06 finish recommendation and optional retrieval experiment | Connection loss/server restart recover safely; KB decision document ready |
| 8 | Tue 10 Nov | P08 live local+Claude+Codex synthetic task | Observe usability; challenge evidence/cross-vendor review; P09 backlog | Live evidence or precise credential/network blocker; no simulated success label |
| 9 | Wed 11 Nov | Failure scenarios, regression checks, release-candidate fixes | Independent acceptance review; instructions and interface polish | No open blocking defect; failures reproducible and understood |
| 10 | Thu 12 Nov | Rehearse clean start/restart; assemble handover | Verify handover from instructions; publish research results as local docs | Acceptance matrix complete; user can run candidate; remaining work prioritised |

### Cut lines and checkpoints

- **End of day 2:** if the contract is not stable, finish it before building incompatible UI/service implementations.
- **End of day 5:** if a fake end-to-end journey does not work, stop KB prototyping and visual extras. Keep the research recommendation. Scope the UI to the five core screens and one active run.
- **End of day 7:** freeze features. Fix correctness/recovery/setup issues only. Preserve a usable CLI if the UI misses its bar.
- **End of day 8:** if live access is blocked, complete fake-provider failure tests and documentation; report a partially validated candidate, not a verified three-model product. The user supplies sign-in/access through the appropriate local mechanism.
- **End of day 10:** ship a clearly labelled personal-use candidate if acceptance passes. Public distribution and knowledge migration remain separate releases.

## 5. Definition of done and acceptance matrix

Record commands, commit, host/OS, relevant tool/model versions, timestamps, results and sanitized artifact paths. A screenshot or successful HTTP response alone does not demonstrate the underlying coding workflow.

| Scenario | Required expected behaviour | Evidence |
|---|---|---|
| Clean start | Documented commands build/start UI and service on acceptance host; saved configuration survives restart | Fresh-directory rehearsal and start log |
| Local connection | Actual model answers a bounded synthetic probe; unavailable/key/model errors distinguished | Sanitized probe outcome; no key in logs |
| Subscription connections | Both CLIs installed AND each completes a bounded authenticated synthetic request | Vendor/adapter/result recorded; no claim based only on `--version` |
| Happy path | Local agent creates code; vendor A/B plan/review roles are visible; tests run; operator approves; only a new branch lands | Transcript + diff + test result + source repo branch/HEAD checks |
| Reject | No branch lands; source checkout/HEAD/index and pre-existing files preserved | Before/after Git checks |
| Local outage | Clear choice to wait/retry/pause or use subscription fallback; no silent paid API use | Fake deterministic test and live outage if safely available |
| Vendor unavailable | Signed-out/limit failures shown; weakened vendor coverage explicitly disclosed | Fake classifications plus live observation when available |
| Browser closes | No implicit answer; worker continues or waits safely; reconnect replays state without restarting steps | Browser disconnect/reconnect test |
| Service crashes | Run visible as interrupted/paused on restart, stale decisions invalidated, explicit resume reconstructs engine state | Kill/restart test; completed edits not repeated |
| Cancel | Only owned run processes stop; outcome and resume options truthful | Descendant-process and repository checks, not exit code alone |
| Conflicting clients | Duplicate/stale decisions and second active run are rejected deterministically | API and two-browser test |
| Browser boundary | Foreign origin, bad Host, missing session, path traversal, unregistered repository and stale approval refused | Negative integration tests |
| Review | Escaped diff/log content, exact reviewed commit, actual tests and weakened checks visible | Render/security checks + approval-race regression |
| Safety fixes | Post-rename fs failure cannot launch new app without migrations; omitted PDF page cannot yield confident wrong total | P01/P02 regression tests |
| Knowledge research | Recommendation cites current sources, separates measured/assumed, defines ACL/deletion/citations and migration | Reviewed report and optional experiment results |

## 6. Decisions and external prerequisites

Make reversible technical choices in the packets; do not stall independent work for preferences. Record significant decisions in a short ADR before expanding scope.

- By day 1, establish the acceptance topology: Windows browser with Windows service, Windows browser with WSL/Linux service, or Linux browser/service. Current cloud Linux validation does not prove Windows packaging. Default engineering validation is Linux; the personal-use milestone requires one demonstrated topology usable by Malcolm. Do not claim native support for untested systems.
- Actual model endpoint/model identifier and subscription authentication are prerequisites only for live checks. Inspect existing configuration by names/status without exposing values. Never ask for tokens in chat, extract CLI session credentials or install accounts automatically.
- The local model's `/responses` agentic compatibility matters; a `/models` list or chat-only response is not proof it can code through Codex. Use the existing LocalAI/Qwen spike as historical evidence and rerun a bounded task on the current installation.
- Remote local-model endpoints should use an already configured secure route. Do not provision tunnels, firewall openings, Windows services or remote-start commands as incidental setup.
- Live synthetic probes use subscription allowance. The implementation must make that visible and user-initiated; paid API fallback remains off. No live probes are authorised merely by writing this plan.
- KB access: inventory the current Library of Babel using read-only access if available. If unavailable, document exactly what is unknown and continue the public-source comparison and synthetic work. No bulk personal/company export is needed to research options.

## 7. End-of-fortnight handover

Provide `acceptance.md`, `setup.md`, `architecture.md`, KB recommendation/migration docs, and a short next-step backlog. Include start/stop/recovery commands, supported host topology, known limitations, exact credentials/configuration still needed, passed/failed/skipped/live-vs-fake checks, and artifact locations. Never call a planned or mocked feature complete.

Suggested next-phase order: resolve remaining acceptance blockers; package the proven local app; add a client expense workflow; introduce persistent collaborative/research sessions; add a validated reusable skill store; implement the selected KB integration. Reprioritise based on the prototype and user feedback.
