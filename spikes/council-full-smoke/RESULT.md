# Plan 9 full council smoke: result

**Status: NOT YET RUN.**

Two operator-run smokes, both in a real terminal on this machine, both against the static test machine (CT 111):

1. `node spikes/council-full-smoke/evidence-only.mjs`: no models, no spend. It clones the foundation at its tag into a throwaway folder under `/var/tmp`, runs the council's own gates and the reliability smoke on CT 111, and prints the report. It exits 0 only when every gate step is `0`, the smoke passed and the page gate has no blocking finding. Everything it makes is removed afterwards (`KEEP=1` keeps it).
2. `bash spikes/council-full-smoke/run-council-full-smoke.sh`: the whole path through `conductor build council-smoke-ltd` on `brief-fixture.json`, with real models and you at the gate. The projects folder is a throwaway under `/var/tmp/hf-council-full-smoke.*`, **kept** afterwards as evidence; the real `~/highland-projects` is never touched.

Neither is run by the test suite.

## Run

- Date / operator:
- Machine (CT 111 host, Node and Docker versions):
- Evidence-only: minutes for the gates; minutes for the smoke; exit code:
- End to end: minutes for the build; council rounds used (of 3); frontier cost shown at the gate:

## Expected in the evidence-only report

- [ ] every gate step `0` (npm-ci, lint, typecheck, licences, vitest, build, browser);
- [ ] the page gate has no blocking finding;
- [ ] Security's note `The role-crossing tests passed: ...`;
- [ ] accessibility results, if axe is installed;
- [ ] the smoke passed, with Reliability's `Deployed on a fresh test machine ...` note;
- [ ] `Worked example notes#1 has no test` (expected: the foundation's tests do not tag it, so coverage shows `0 of 1`);
- [ ] no machines in use afterwards, and nothing named `hfsmoke` or `hf-smoke-rest` on CT 111.

## Expected in the end-to-end run

- [ ] progress lines: `Council round 1: ...`, `Council: using the build's own checks for this version.`, `Council: starting a test machine...`, `Council: deploying on test machine ...`, a verdict line, `Council report saved: ...`;
- [ ] `builds/<run>/council-report.md` and `council-report.json` exist, and the gate summary names the report;
- [ ] if something blocked: a council fix feature, then a second round (at most 3);
- [ ] `mileage-claims#1` and `mileage-claims#2` are each listed as proven or missing, by name;
- [ ] step 5 shows nothing left on CT 111.

## Observations

- Did `.council/playwright.config.ts` (with its `.ts` import of the app's Playwright config) and the axe spec load under the real Playwright (index Ruling 5)?
- Did axe find anything sensible? Was the Mozilla Public License banner accepted?
- Did the smoke pass first time?
- Was everything named `hfsmoke` or `hf-smoke-rest` gone afterwards (and `/tmp/hf-smoke`)?
- Did the report read like a consultant's note?
- Did the Design reviewer open the screenshots, and which CLI was it?
- Were the build's own checks reused (the `reuse` event in `builds/<run>/council/transcript.jsonl`)?
- Anything that read badly:

## Operator follow-ups (outside the code)

- Conductor's SSH key in `root@192.168.1.111:~/.ssh/authorized_keys`, and CT 111's host key in `known_hosts` (connect once by hand).
- Docker (with Compose v2) and Node 22 on CT 111; `/srv/hf-factory` writable.
- CT 111 must hold no `highland/app` or `highland/ops` images between runs, or the v0.1.0 smoke refuses (Contract 7.8: Plan 10's `cleanupBuild` removes the ones it builds, and previews use `hf-preview/*`; see the index's Contract gap 1).
- Move the smoke to foundation v0.2.0's `HF_SMOKE_PROJECT`/`HF_SMOKE_DIR` and hard-kill step once apps are on v0.2.0 (Plan 12, Contract 7.9).
- The axe-core file: `npm pack axe-core@4`, then put `package/axe.min.js` at `~/.local/share/conductor/axe-core/axe.min.js` (or set `options.councilTools.axe`). Conductor side only; never in a client app.
- `TEST_DATABASE_URL` set and the Playwright browsers installed on this machine (as for Plan 8).
- The decisions in the index's "Operator Questions" and "Contract gaps" (`docs/superpowers/plans/2026-10-27-factory-council-full/00-index.md`).
