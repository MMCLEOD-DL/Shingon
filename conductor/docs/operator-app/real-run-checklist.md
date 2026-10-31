# First real run on Windows: checklist

For Malcolm, at the Windows machine, with both subscriptions signed in and the local model reachable. It is the first time the app calls real models. It turns P08's live checks and the "acceptance still required" list in [setup.md](setup.md#acceptance-still-required) into steps.

**Allow about two hours.** The tasks are tiny, so the subscription use is a handful of small requests and the local model does most of the work. Nothing here merges, pushes, deploys or touches a client repository.

**Stop at the first surprise.** Write down what you saw, take a screenshot and go on to the next section only if the surprise does not affect it. Do not work around a fault: don't edit `service-state.json`, delete branches or restart a task to make a problem go away. A fault found here is the point of the exercise.

Record each result in the [results table](#results-table) at the end as you go.

## 0. Before you start

- [ ] The desktop PC with LocalAI is on, and its worker is started.
- [ ] No other Conductor app is running (check Task Manager for a `node` process started from `conductor-app.js`).
- [ ] You have a terminal: PowerShell, not WSL. Everything here is native Windows.
- [ ] Have a notes file open. **Never paste the bootstrap link** (the `#bootstrap=` address) or anything from `%USERPROFILE%\.claude` or `%USERPROFILE%\.codex` into notes, chat or a commit.

## 1. Get the build

```powershell
cd <your Shingon checkout>
git checkout main
git pull
node --version              # must be 22.13 or later
cd conductor\operator-web
npm ci
npm run build
cd ..
```

- [ ] `npm run build` ends without errors and `conductor\operator-web\dist\index.html` exists.
- [ ] Note the commit: `git rev-parse --short HEAD`.

## 2. Find the real model tools

The app starts the CLIs directly, without a shell, so it needs the real executables. Command shims made by npm (`claude.cmd`, `codex.cmd`) are **not known to work** (setup.md).

```powershell
where.exe claude
where.exe codex
```

- [ ] Each shows a path ending in `.exe`. Copy the full paths into your notes.
- [ ] If only `.cmd` files appear, record it, then install the vendor's native build (Claude Code's native installer; Codex's Windows release) and look again. If there is no `.exe`, stop here: this is the first thing to fix.
- [ ] Run each with `--version` using its full path, and note the versions.
- [ ] Sign-in: run `claude`, then `codex login`, in this terminal, the normal way, if not already signed in.

## 3. Check the local model answers

```powershell
curl.exe -s http://192.168.1.110:8081/v1/models
```

Use your own address if it differs (it is the `baseUrl` in your current Conductor config).

- [ ] The list includes the model your config names (for example `shingon-qwen3.8-27b-q4`).

## 4. Make a throwaway repository

Never use a real project for this.

```powershell
mkdir C:\conductor-trial\repo
cd C:\conductor-trial\repo
git init -b main
git config user.name "Conductor trial"
git config user.email "trial@example.invalid"
Set-Content math.js "exports.add = (a, b) => a + b;"
Set-Content math.test.js "const test = require('node:test'); const assert = require('node:assert/strict'); const { add } = require('./math.js'); test('add', () => assert.equal(add(2, 3), 5));"
node --test
git add .
git commit -m "start"
```

- [ ] `node --test` passes before the commit.

## 5. Write the app's configuration

Create `C:\conductor-trial\config.json`, using the `.exe` paths from step 2. In JSON every backslash is doubled: `C:\\Users\\...`.

```json
{
  "participants": [
    { "name": "claude", "adapter": "claude-code", "bin": "<claude.exe path>",
      "roles": ["author", "reviewer"], "capabilities": { "is_agentic": true, "can_edit_files": true } },
    { "name": "codex", "adapter": "codex", "bin": "<codex.exe path>",
      "roles": ["author", "reviewer"], "capabilities": { "is_agentic": true, "can_edit_files": true } },
    { "name": "local", "adapter": "local-agent", "bin": "<codex.exe path>", "model": "<your local model>",
      "baseUrl": "http://192.168.1.110:8081/v1", "contextWindow": 32768,
      "roles": ["grunt"], "capabilities": { "is_agentic": true, "can_edit_files": true } }
  ],
  "routing": { "allowApi": false, "localDown": "ask" },
  "options": { "testCommand": "node --test" }
}
```

Set the local model here, not in the browser: the browser's settings page accepts only `https` or `localhost` model addresses, and LocalAI is on another machine over plain `http`. That is a deliberate guard, not a fault.

## 6. Start the app

```powershell
cd <your Shingon checkout>\conductor
node bin\conductor-app.js --config C:\conductor-trial\config.json --data C:\conductor-trial\data
```

- [ ] It prints a local address with `#bootstrap=`. Open that link in your browser on this machine.
- [ ] The page shows **New coding task**, and the `#bootstrap=` part has gone from the address bar.
- [ ] Note whether any console windows flash up during this run and later ones. A known Windows fault (Codex's to fix) can show them. **Don't close them**: closing one can kill the work it belongs to. Just note when they appear.

## 7. Check each participant

On **Connections**, for **claude**, **codex** and **local** in turn, press the three checks in order, waiting for each:

1. **Check installation** (no model is contacted);
2. **Check sign-in** (one tiny request);
3. **Check it can code** (writes one file in a throwaway folder).

- [ ] All nine pass. Note any that fail, with the message shown. A failure in 2 or 3 is the most useful thing this session can find: stop and record it before going on.

Then register the repository: **New task**, enter `C:\conductor-trial\repo`, **Continue**, read what it may do, **Add repository**.

## 8. Task 1: approve

Describe the change: *Add a multiply(a, b) function to math.js, export it, and add a test for it in math.test.js.* Press **Start**.

- [ ] Progress appears while it works. Note the time it started and how long it takes to reach the review.
- [ ] If it asks **Approve the plan**, **Approve the next coding step** or **The models disagree: your call** on the way, read the question, answer it as you see fit and note that it asked. The stand-in tests never reach these, so how they read with real models is worth recording.
- [ ] **Review the finished work** shows a diff that adds `multiply` and a test, and **Tests passed**.
- [ ] **Who did the work** names the local model as used, and Claude and Codex as the subscription models that completed calls. Note exactly what it says.
- [ ] Read the diff as you would a colleague's. Is it what you asked for, and nothing else?
- [ ] Press **Approve: create a branch**. Wait for **Branch created**.

Check in a terminal:

```powershell
cd C:\conductor-trial\repo
git status --short                 # nothing: your checkout is untouched
git branch --list "conductor/*"    # one new branch
git log --oneline main             # still only "start": nothing was merged
git diff main conductor/<branch>   # the change you approved
git checkout conductor/<branch>
node --test                        # passes on the branch
git checkout main
```

- [ ] All five are as described.

## 9. Task 2: reject

Start: *Rename add to sum everywhere.* At the review, type a reason in **If you reject**, then press **Reject**.

- [ ] It shows **Rejected — no branch created**, and `git branch --list "conductor/*"` still shows only the first branch.

## 10. Task 3: stop part-way, then stop the app part-way

**a. Stop a task.** Start *Add a subtract(a, b) function with a test*. While it is working (before the review), press **Stop run…** and confirm.

- [ ] It shows **Interrupted**.
- [ ] In Task Manager, no `claude`, `codex` or extra `node` processes from this task are left behind after a minute. Note any that are, with their names. This is the Windows process-tree check.

**b. Stop the app.** Press **Resume** on that run, and while it is working press **Ctrl-C** in the app's terminal.

- [ ] The browser shows that the connection was lost.
- [ ] Start the app again with the same command as in step 6, and open the **new** bootstrap link (the old one no longer works).
- [ ] The run shows as interrupted, and any question it was asking has been withdrawn, not answered.
- [ ] Press **Resume**. It asks again on fresh evidence and reaches a review without redoing finished steps. Approve, and check there is exactly one new branch for it.

## 11. Task 4: the local model is down

Stop the LocalAI worker on the desktop PC, then start *Add a divide(a, b) function with a test*.

- [ ] The app stops and asks: **The local model is unavailable**, with **Pause** or **Use subscriptions**. Choose **Pause**. Neither choice may switch to paid API keys.
- [ ] Start LocalAI again afterwards.

## 12. Save the evidence

- [ ] Screenshots: the Connections checks, task 1's review (diff, tests, **Who did the work**), task 1's **Branch created**, and anything that went wrong.
- [ ] In your notes: the commit from step 1, the Node, `claude` and `codex` versions, the local model name, and the timings.
- [ ] Do **not** collect the bootstrap link, anything from your sign-in folders, or `C:\conductor-trial\data` wholesale. If a fault needs the app's records, Codex or Claude will say which file and what to remove from it first.
- [ ] Afterwards you can delete `C:\conductor-trial` entirely.

Paste the results table, with notes, into a chat with either assistant. It becomes the P08 live-acceptance evidence, recorded with exactly what was live and what was not.

## Results table

| Step | Check | Result (pass / fail / not run) | Notes (messages, timings, versions) |
|---|---|---|---|
| 1 | Build and UI build | | commit: |
| 2 | Native `.exe` for claude and codex; versions; signed in | | |
| 3 | Local model listed | | |
| 6 | App starts; bootstrap link signs in; console windows seen? | | |
| 7 | Nine participant checks | | |
| 8 | Approve: diff, tests, who did the work, branch, main untouched | | time to review: |
| 9 | Reject: no branch | | |
| 10a | Stop: Interrupted; no processes left behind | | |
| 10b | App stopped and restarted; question withdrawn; Resume; one branch | | |
| 11 | Local model down: asks, never uses API keys | | |
