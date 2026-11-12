# Windows acceptance, round 2: what is still open

For Malcolm at the Windows machine. Codex can drive the commands, as it did on 5 November, with Malcolm's permission for
each live part. It covers only what the earlier sessions left open. It does not repeat what already passed.

**Already passed. Do not redo:**
- The 31 October first run ([checklist](real-run-checklist.md)) and the 5 November native retest
  ([report](windows-retest-2026-11-05.md)): nine connection checks, approve, reject, Stop, orderly restart and Resume,
  stale-approval refusal, and local model down.
- The [UAC follow-up](windows-uac-2026-11-05.md): two Codex writes with 0 prompts; local writes with 1 prompt, then 0.

**Still open, and the part of this runbook that closes each item:**

| Open item | Source | Part |
|---|---|---|
| Browser journeys never run on native Windows | P07, PR86 review | A |
| Browser presentation with real models (the 5 November run used the API) | P08, retest report | C |
| Reload, connection loss and two tabs while a decision is pending | P07 | C |
| Captured test output on Windows (empty before PR82) | retest report, PR82 | C |
| Abrupt service kill (not Ctrl-C), Windows restart mid-task | setup.md item 4, retest report | D |
| Live failing tests: a failing baseline, and a step that breaks a test | F8, PR71 R1 | E |
| UAC prompts in a new folder, after a service restart and after a reboot; console flashes | F2, UAC report | F |

**Rules (same as the first run):**
- **Stop at the first surprise.** Note what you saw, take a screenshot, and go on only if the surprise does not affect
  the next part.
- **Do not work around a fault.** Don't edit `service-state.json`, delete branches or restart a task to make a problem
  go away.
- Never paste the bootstrap link, the LocalAI key or anything from `%USERPROFILE%\.claude`, `%USERPROFILE%\.codex` or
  Conductor's Codex homes into notes, chat or a commit.
- Use a **new** trial folder, `C:\conductor-trial-2`, so the UAC checks start from a folder Codex has not used before.

**Permissions to give up front**, so the session does not stall:
1. Download Playwright's Chromium for Part A (about 150 MB, from Playwright's download server).
2. Start the LocalAI worker if it is down.
3. Enter the LocalAI key at a hidden prompt.
4. About four small coding tasks on the subscriptions, plus up to nine connection checks. Part E is capped at one local
   and one subscription attempt.
5. Optional, for D3 and F3: restart Windows once.

**Time:** about three hours. Part A needs no models and can be done alone first.

**Order:** A, then B, C, D, F. Part E waits until Codex's start-of-run test check (PR71 R1) is merged. Without it, E1
spends the full local and subscription budget before stopping.

---

## A. Browser journeys on native Windows (no models, no sign-in)

Deterministic stand-in workers and model programs only. Nothing calls a model.

```powershell
cd <your Shingon checkout>
git checkout main
git pull
git rev-parse --short HEAD          # note it
node --version                      # note it; 22.13 or later
cd conductor\operator-web
npm ci
npm test
npm run build
npm install -g playwright@1.63.0
npx -y playwright@1.63.0 install chromium
$env:NODE_PATH = (npm root -g)
node e2e\journey.mjs
```

- [ ] `npm test`: note the count (78 on Linux at `038289d`) and whether there were any failures.
- [ ] `npm run build` ends without errors.
- [ ] `node e2e\journey.mjs` runs three groups:
  - the fixture worker;
  - the real engine with stand-in model programs;
  - resume-and-fallback, which **kills the service abruptly** and restarts it.

  On Linux at `038289d` they give 22, 6 and 4 passed, with exit code 0. Note each group's count, any failures with
  their step names, and the exit code (`$LASTEXITCODE`).
- [ ] While the kill-and-restart group runs, watch Task Manager: note any `node` processes left behind after the
  script ends.

Then the native engine checks, from `conductor\` (as in [05-validation](../superpowers/plans/2026-10-29-two-week-product/05-validation.md)):

```powershell
cd ..
node --test test/stub-cli.test.js test/service/engine.test.js
```

- [ ] Note the pass, fail and skip counts. On Linux at `038289d`: 9 tests, 8 passed, 1 skipped. The skipped one is
  "native Windows fixture timeout ends the launcher and its Node child", which runs only on Windows, so on Windows
  expect all 9 to run.

This is synthetic evidence: it proves the UI and the service on Windows, not the models.

## B. Set up for the live parts

Follow the [first-run checklist](real-run-checklist.md), steps 0 to 7, with these changes:

- Use `C:\conductor-trial-2` everywhere in place of `C:\conductor-trial`. That covers the repository, `config.json`,
  the data folder and `ask.json`.
- **Before step 3,** create the folder: `mkdir C:\conductor-trial-2`. Step 3 writes `ask.json` into it, and the
  folder is otherwise made only in step 4.
- **Step 2, Codex path:** find `codex.exe` again, even if nothing seems to have changed. If its folder moved since the
  last session, note it. A moved `codex.exe` gets a new private Codex home, so Conductor will appear signed out (PR76
  R1). Note whether **Check sign-in** says so clearly.
- **Step 5, config:** add `"localRounds": 1, "frontierRounds": 1` to `"options"`, beside `testCommand`. This caps Part
  E's spend. If the app refuses to start with them, remove them and note the message.
- **Step 6, starting the app:** before the real start, check the app refuses to run twice. Start it in one window,
  then run the same command in a second window.
  - [ ] The second start refuses and exits, most likely saying the port is in use. Note the exact message. The first
    keeps working: its page still loads.
  - Close the second window, then continue with the first.
- **Step 7, connection checks:** these are the first Codex and local-model calls in a new folder. Record UAC prompts
  and console windows for each, in the [Part F table](#f-uac-prompts-and-console-windows).

## C. One task through the browser, with a pending decision handled three ways

One task covers all four checks. Register `C:\conductor-trial-2\repo` (made as in the checklist's step 4), then start:
*Add a multiply(a, b) function to math.js, export it, and add a test for it in math.test.js.*

**C1. The review page with real models**

When **Review the finished work** appears, before answering:
- [ ] The diff adds `multiply` and a test, and nothing else.
- [ ] **Tests passed**, and the test output shown is **not empty**: you can see the test names or the `pass` count.
  It was empty on Windows before PR82.
- [ ] **Who did the work** names the local model, and Claude and Codex as subscription models that completed calls.
  Note the exact wording.
- [ ] Any question asked on the way (plan, next step, models disagree): note its wording and your answer.

**C2. Reload while the question is pending**
- [ ] Press F5. The same question comes back with the same diff, and no "answer saved" note.

**C3. Two tabs**
- [ ] Copy the run page's address (it has no bootstrap part) into a second tab of the same browser. Both tabs show the
  question.

**C4. Connection lost when you answer**
1. In tab 1, open DevTools (F12), then **Network**, and set throttling to **Offline**.
2. Press **Approve: create a branch**.
   - [ ] An error appears saying the answer could not be sent. No **Branch created**.
3. Set throttling back to **No throttling**, then press **Approve** again in tab 1.
   - [ ] **Branch created**, with no "Request ID conflict" or other error.
4. Go to tab 2.
   - [ ] Within a few seconds the question has gone, or the run shows as finished.
   - [ ] If an **Approve** button is still visible, press it: it must be refused (already answered or stale), and must
     never create a second branch.
5. In a terminal:

   ```powershell
   cd C:\conductor-trial-2\repo
   git status --short
   git branch --list "conductor/*"
   git log --oneline main
   ```

   - [ ] Status shows nothing (your checkout is untouched).
   - [ ] Exactly one `conductor/*` branch.
   - [ ] `main` still has only the start commit.

C4 is an answer that never reached the service. The harder case, where the service acted but its reply was lost, can't
be produced by hand. The Part A journeys cover it with stand-ins.

## D. Abrupt stops

**D1. Kill the service while a model is working**

Start *Add a subtract(a, b) function with a test.* While it shows progress (before any question), in a second
PowerShell window:

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'node.exe','codex.exe','claude.exe' } |
  Select-Object ProcessId, ParentProcessId, Name, CreationDate | Format-Table -AutoSize    # snapshot: note it
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*conductor-app.js*' |
  Select-Object ProcessId                                                                # the service
taskkill /PID <service ProcessId> /F
```

This is `/F` without `/T`: Windows ends the service alone, as a crash would. Then:
- [ ] The browser shows that the connection was lost.
- [ ] After one minute, run the first command again. Note every process from the snapshot that is still running, and
  whether it is still using CPU. **This is the main finding of D1.** A worker or model left running after its service
  died could go on editing the workspace.
- [ ] After two minutes, run it again and note the result.
  - If processes from the run are still there, record them, then end them with `taskkill /PID <id> /T /F` before going
    on. Ending them by hand is part of the finding: note that you did.
- [ ] Start the app again with the same command, and open the **new** bootstrap link.
- [ ] The run shows as interrupted. Note the exact message, and whether it offers **Resume** or asks you to check the
  repository first.
- [ ] Press **Resume**. It reaches a review without redoing a step that had finished. Do not answer yet: go to D2.

**D2. Kill the service while the question is pending**
- [ ] With the review question showing, kill the service the same way. Restart it and open the new link.
- [ ] The question has been withdrawn, not answered. **Resume** asks again, on fresh evidence.
- [ ] Approve. There is exactly one new branch for this task: two in total.

**D3 (optional). Windows restarts mid-task**

Only if you are happy to restart this PC now; it also gives the F3 UAC check.
1. Start *Add a divide(a, b) function with a test.* While it shows progress, restart Windows from the Start menu.
2. After logging in, start the LocalAI worker if needed. Repeat the checklist's steps 3 (key) and 6 (start the app).
3. Check:
   - [ ] The run shows as interrupted.
   - [ ] No processes from it are left (use the first command above).
   - [ ] **Resume** reaches a review without redoing finished steps.
   - [ ] **Reject** it, and no branch is created.

A real power cut is not tested. Restarting Windows shuts programs down in order, so it is gentler than a power cut.

## E. Live failing tests

Wait for Codex's start-of-run test check (PR71 R1, decided 5 November) to be merged. Then pull, rebuild (`npm run
build` in `operator-web`) and restart the app.

**E1. Tests already fail before the run**

```powershell
cd C:\conductor-trial-2\repo
git checkout main
Set-Content broken.test.js "require('node:test')('already broken', () => { throw new Error('broken before Conductor'); });"
git add broken.test.js
git commit -m "a test that already fails"
```

Start *Add a negate(a) function with a test.*
- [ ] The run stops **before any model works**. It says the tests already fail and need fixing first.
- [ ] No local or subscription call was made: **Who did the work** shows none, or there is no such section.
- [ ] No question asks you to approve anything.

Then remove the broken test:

```powershell
git rm broken.test.js
git commit -m "remove the broken test"
```

**E2. A step that breaks a test it was told to keep**

Start *Change add so that add(2, 3) returns 6. Do not edit math.test.js.* The existing test expects 5, so a change
that obeys the request fails it.
- [ ] Progress shows that the tests failed, and the same step is tried again: once locally, then once by a
  subscription model, with the rounds capped in Part B.
- [ ] It ends with **The models disagree: your call** (or similar), with a recommendation to reject because the tests
  do not pass. Note the wording.
- [ ] If instead a model edited `math.test.js` and the tests passed, note it. Check that rival review flagged the edit.
- [ ] Reject. No branch is created.

## F. UAC prompts and console windows

Fill this in from Part B onwards. "UAC" means Windows' **Do you want to allow this app to make changes?** box. Count each
one, and note the time on the clock.

| # | When | Participant and action | Folder | UAC prompts | Console windows flashed? |
|---|---|---|---|---|---|
| F1 | B, step 7: first checks in the new folder | codex: Check it can code | `C:\conductor-trial-2` | | |
| F1 | B, step 7 | local: Check it can code | `C:\conductor-trial-2` | | |
| F1 | C: the task | any | | | |
| F2 | After D1's restart: re-run the two "Check it can code" | codex, then local | | | |
| F3 | After D3's Windows restart: the same two checks | codex, then local | | | |
| — | Anything else you saw | | | | |

The earlier sessions had 3 unattributed prompts, then 0 for Codex, then 1 followed by 0 for local. This table shows
whether a new folder, a service restart or a reboot brings them back.

## G. Save the evidence

- The commit from Part A, Node, `claude` and `codex` versions, the local model name, and timings.
- Part A's counts and exit codes.
- Screenshots:
  - C1's review (diff, test output, **Who did the work**);
  - C4's offline error and the second tab;
  - D1's interrupted message;
  - E1's stop and E2's question;
  - anything that went wrong.
- D1's process snapshots, with the process names and IDs only.
- The Part F table.

Do not collect the data folder wholesale; if a fault needs the app's records, Codex or Claude will name the file and what
to remove first. Paste the results table below into a chat with either assistant. Codex records it as P07/P08 evidence,
with what was live, what was synthetic and what was not run kept apart.

## Results table

| Part | Check | Result (pass / fail / not run) | Notes |
|---|---|---|---|
| A | UI tests, build | | count: |
| A | Browser journeys: fixture / real engine / kill-and-resume | | counts, exit code: |
| A | Native engine checks | | counts: |
| A | `node` processes left after the journeys | | |
| B | Codex path moved? Signed-out state reported clearly? | | |
| B | Second start refused | | |
| C1 | Review: diff, non-empty test output, who did the work | | wording: |
| C2 | Reload keeps the question | | |
| C3, C4 | Offline answer fails clearly; retry creates one branch; second tab cannot add one | | |
| D1 | Kill while working: processes left; interrupted message; Resume without redoing work | | |
| D2 | Kill while question pending: withdrawn; Resume asks again; one branch | | |
| D3 | Windows restart mid-task (optional) | | |
| E1 | Failing baseline stops before any model call | | |
| E2 | Broken test blocks the step; capped retries; reject recommendation | | |
| F | UAC and console table filled in | | |
