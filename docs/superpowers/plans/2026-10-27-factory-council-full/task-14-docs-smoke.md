# Task 14: Docs and operator smoke

This task finishes Plan 9 with docs and two operator-run smokes. **The implementer writes the files and checks syntax only (`bash -n`, `node --check`). The implementer does NOT run the smokes.** Malcolm runs them with `!`. They need:
- a real test machine (CT 111 `hf-build` through Plan 8's `static` provider) with Docker, Node 22 and Conductor's SSH key;
- `TEST_DATABASE_URL` and the Playwright browsers on this machine;
- for the second smoke, both frontier subscriptions and a human at the gate.

1. **`evidence-only.mjs`**: no models, no spend. It proves the gates and the smoke on real tools:
   - it clones `/root/highland-foundation` at `v0.1.0` into a temp folder as the "app" (it has `apps/web/e2e`, `deploy/smoke/run-smoke.sh` and the notes example), with a branch `build/smoke` holding one empty commit;
   - it makes a throwaway project folder `~/highland-projects/council-smoke-<date>/` with `project.json` (`foundation: { repo, tag: 'v0.1.0', commit }`) and an in-memory brief: one feature `notes` with one worked example, which the foundation's tests do **not** tag (so coverage shows `0 of 1`, as expected);
   - it opens the council workspace (Task 3), runs `collectEvidence` (Task 6) and then each project member's `collect` (no interpreter), and prints `buildReport(...).text`.

   Expected:
   - every gate step `0`;
   - the page gate with no blocking finding;
   - with axe installed, accessibility results;
   - the smoke passed, and Reliability's "Deployed on a fresh test machine…" note;
   - `Worked example notes#1 has no test`;
   - the machine released, and `docker ps -a` on CT 111 showing nothing named `hfsmoke` or `hf-smoke-rest`.
2. **`run-council-full-smoke.sh`**: the whole path through `conductor build <slug>` (Plan 8) on a small approved brief (`brief-fixture.json`: one feature "Mileage claims" with two worked examples using whole pence, `policy.outbound: []`). It expects the council's progress lines, a council report at the gate naming `builds/<run>/council-report.md`, and, if anything blocks, a council fix feature and a second round.

**Files:**
- Modify: `README.md`, `config.example.json`
- Create: `spikes/council-full-smoke/evidence-only.mjs`, `spikes/council-full-smoke/run-council-full-smoke.sh`, `spikes/council-full-smoke/brief-fixture.json`, `spikes/council-full-smoke/RESULT.md`

**Interfaces:**
- Consumes: `openCouncilWorkspace`, `openCouncilLog` (Task 3); `collectEvidence` (Task 6); `DESIGN`, `RELIABILITY`, `CORRECTNESS`, `LEGAL`, `SECURITY`; `buildReport` (Task 12); Plan 8's `getMachineProvider`, `createSsh` and `conductor build`.
- Produces: the operator commands `node spikes/council-full-smoke/evidence-only.mjs` and `bash spikes/council-full-smoke/run-council-full-smoke.sh`, and the docs.

- [ ] **Step 1: `config.example.json`**

Add `"councilGatesTimeoutMs": 2400000` and `"councilSmokeTimeoutMs": 2400000` to `options`. Leave `councilTools` as `{}`. The README explains `axe`.

Run: `npm test` (the config tests read this file).
Expected: PASS.

- [ ] **Step 2: README: "The full council on client builds"**

Add it after "The council (optional extra checks)". Plain UK English, no jargon. It must say:
- At the end of `conductor build`, the full council reviews the **whole app** against the approved brief and data policy, with five members:
  - **Security** as before;
  - **Legal and data**: licences, plus where the app sends data (checked against the policy), personal data, and how long records are kept;
  - **Correctness**: the foundation's checks, plus every worked example in the brief has a passing test whose name carries `[feature-id#n]`;
  - **Design**: every page at desktop and phone width, sideways scrolling, buttons too small to tap, accessibility;
  - **Reliability**: deploy on a test machine, back up, restore, stop and restart, alerts, and a broken update undoing itself.
- What blocks and what only warns (one short list, from index Ruling 6).
- **What it needs:**
  - what `conductor build` already needs (`TEST_DATABASE_URL`, the Playwright browsers);
  - a test machine (`factory.machines`; `static` uses CT 111) with Docker and Node 22, reachable by SSH;
  - optionally axe-core: `npm pack axe-core@4`, then put `package/axe.min.js` at `~/.local/share/conductor/axe-core/axe.min.js` or set `councilTools.axe`. It is under the Mozilla Public License. Conductor uses it as a checking tool and never adds it to client apps.
- **Without a machine or the browsers**, the council still runs, and the report says at the top what was **not proven**.
- **Time:** about 20–30 minutes per council round.
- **Where the report is:** `<project>/builds/<run>/council-report.md`, with the screenshots under `council/round-<n>/screenshots/`.
- Ordinary repos with `--council` are unchanged.

- [ ] **Step 3: Write `evidence-only.mjs`, `run-council-full-smoke.sh`, `brief-fixture.json`**

- `evidence-only.mjs` loads the operator config the way `src/cli/main.js` does. It refuses to run unless `factory.machines.provider` is `static` (`This smoke only runs against the static test machine list. Set factory.machines in your config.`). It prints each `council-evidence` event as a progress line (`councilProgressLine`). It exits 0 only when every gate step is `0`, the smoke passed, and the page gate has no blocking finding.
- `run-council-full-smoke.sh` follows `spikes/council-smoke/run-council-smoke.sh` for the tunnel and keys. It runs `conductor project new "Council Smoke Ltd"`, imports `brief-fixture.json` as the approved brief (through Plan 7's command if it accepts a fixture, otherwise by writing `brief/brief-v1.json`, `brief-v1.md` and `current.json` as Contract 2 describes), then `conductor build council-smoke-ltd`.

Run: `bash -n spikes/council-full-smoke/run-council-full-smoke.sh && node --check spikes/council-full-smoke/evidence-only.mjs`
Expected: no output.

- [ ] **Step 4: `RESULT.md`**

**Status:** NOT YET RUN. Sections:
- **Run:** date, machine, minutes for the gates and for the smoke, rounds used.
- **Observations:**
  - Did `.council/playwright.config.ts` and the axe spec load under the real Playwright (index Ruling 5's `.ts` import)?
  - Did axe find anything sensible?
  - Did the smoke pass first time?
  - Was everything named `hfsmoke` or `hf-smoke-rest` gone afterwards?
  - Did the report read like a consultant's note?
  - Did the Design reviewer open the screenshots, and which CLI was it?
- **Operator follow-ups (outside the code):**
  - Conductor's SSH key on CT 111;
  - Docker and Node 22 on CT 111;
  - CT 111 holds no `highland/app` or `highland/ops` images between runs, or the smoke refuses (Plan 8's previews must remove theirs, see index Contract gap 7);
  - the axe-core file;
  - the decisions in the index's "Operator Questions" and "Contract gaps".

- [ ] **Step 5: Commit**

```bash
git add README.md config.example.json spikes/council-full-smoke/
git commit -m "docs(council): full council on client builds, plus operator smokes (evidence only, and end to end)"
```
