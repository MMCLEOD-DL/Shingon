# First real run on Windows: checklist

For Malcolm, at the Windows machine, with both subscriptions signed in and the local model reachable. It is the first time the app calls real models. It turns P08's live checks and the "acceptance still required" list in [setup.md](setup.md#acceptance-still-required) into steps.

**Allow about two hours.** The tasks are tiny, so the subscription use is a handful of small requests and the local model does most of the work. Nothing here merges, pushes, deploys or touches a client repository.

**Stop at the first surprise.** Write down what you saw, take a screenshot and go on to the next section only if the surprise does not affect it. Do not work around a fault: don't edit `service-state.json`, delete branches or restart a task to make a problem go away. A fault found here is the point of the exercise.

Record each result in the [results table](#results-table) at the end as you go.

**First run: 31 October 2026.** Every step passed after the set-up snags now written into the steps below (marked *Learned 31 Oct*). Results and findings: the work-log entry `2026-10-31-*-claude-task-36-first-live-run.md` in the two-week plan's `work-log/` folder.

**Use one PowerShell window from step 3 onwards and keep it open.** The local model's key (step 3) and the Codex search-tool path (step 6) live only in that window, and the app must be started from it.

## 0. Before you start

- [ ] The desktop PC with LocalAI is on, and its worker is started. *Learned 31 Oct:* it does not start by itself. Check `curl.exe -s -o NUL -w "%{http_code}" -m 5 http://192.168.1.109:50050/readyz` prints `200`; if it prints `000`, run `& E:\SHINGON\desktop_worker\Start-LocalAI-Worker.ps1` and check again. If that script stops with "WSL forwarding configuration needs to be updated", stop and ask: it needs an administrator network change.
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
- [ ] *Learned 31 Oct:* Codex installed with npm shows only `codex` and `codex.cmd`, but the npm package holds the real program. Find it with `Get-ChildItem "$env:APPDATA\npm\node_modules\@openai" -Recurse -Filter "*.exe" | ForEach-Object FullName` and use the one ending `\bin\codex.exe`. Its folder changes when Codex is updated: look again after every update.
- [ ] Run each with `--version` using its full path (in PowerShell, `& "<path>" --version`), and note the versions. **Codex must be 0.163 or later**, the version Conductor's local-model path was built on; *learned 31 Oct:* 0.122 was installed. Update with `npm install -g @openai/codex@0.163.0`, then find the `.exe` again.
- [ ] Sign-in: run `claude`, then `codex login`, in this terminal, the normal way, if not already signed in. Then prove Claude's sign-in still works: `& "<claude.exe path>" -p "Reply with exactly OK"` must reply `OK`. *Learned 31 Oct:* an expired sign-in shows "OAuth access token is invalid"; run `claude`, then `/login`.

## 3. Check the local model answers

LocalAI needs its key (*learned 31 Oct*: without it the answer is `401 An authentication key is required`). The key is `LOCALAI_API_KEY` in `/opt/shingon-localai/.env` on CT 110. To read it without the container's own password, open the Proxmox web page, click the host itself (not container 110), then **Shell**:

```bash
pct exec 110 -- grep '^LOCALAI_API_KEY=' /opt/shingon-localai/.env | cut -d= -f2-
```

Copy the value, then type `clear` in that shell. In your PowerShell window, enter it at a hidden prompt (it never appears on screen or in PowerShell's history):

```powershell
$s = Read-Host "LocalAI key" -AsSecureString; $env:LOCALAI_API_KEY = [System.Net.NetworkCredential]::new("", $s).Password
curl.exe -s -H "Authorization: Bearer $env:LOCALAI_API_KEY" http://192.168.1.110:8081/v1/models
```

Use your own address if it differs (it is the `baseUrl` in your current Conductor config). Never paste the key into notes or chat.

- [ ] The list includes the model your config names (for example `shingon-qwen3.8-27b-q4`).
- [ ] The model really answers. The list above appears even when the desktop worker is down (*learned 31 Oct*), so ask it something:

```powershell
Set-Content -Encoding ascii C:\conductor-trial\ask.json '{"model":"shingon-qwen3.8-27b-q4","messages":[{"role":"user","content":"Reply with OK"}],"max_tokens":200}'
curl.exe -s -m 300 -H "Authorization: Bearer $env:LOCALAI_API_KEY" -H "Content-Type: application/json" -d "@C:\conductor-trial\ask.json" http://192.168.1.110:8081/v1/chat/completions
```

The first answer can take a minute or two while the model loads onto the graphics card. "no healthy nodes available" means the desktop worker is not running: go back to step 0.

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

Create `C:\conductor-trial\config.json`, using the `.exe` paths from step 2. In JSON every backslash is doubled: `C:\\Users\\...`. Save it as plain ASCII or UTF-8 **without a byte-order mark**: in Windows PowerShell 5.1 write it with `Set-Content -Encoding ascii`, because `-Encoding utf8` adds a mark that the app cannot read.

```json
{
  "participants": [
    { "name": "claude", "adapter": "claude-code", "bin": "<claude.exe path>",
      "roles": ["author", "reviewer"], "capabilities": { "is_agentic": true, "can_edit_files": true } },
    { "name": "codex", "adapter": "codex", "bin": "<codex.exe path>",
      "roles": ["author", "reviewer"], "capabilities": { "is_agentic": true, "can_edit_files": true } },
    { "name": "local", "adapter": "local-agent", "bin": "<codex.exe path>", "model": "<your local model>",
      "baseUrl": "http://192.168.1.110:8081/v1", "contextWindow": 32768,
      "extraConfig": ["windows.sandbox=elevated"],
      "roles": ["grunt"], "capabilities": { "is_agentic": true, "can_edit_files": true } }
  ],
  "routing": { "allowApi": false, "localDown": "ask" },
  "options": { "testCommand": "node --test" }
}
```

Set the local model here, not in the browser: the browser's settings page accepts only `https` or `localhost` model addresses, and LocalAI is on another machine over plain `http`. That is a deliberate guard, not a fault.

*Learned 31 Oct:* the `extraConfig` line is a **workaround for a Conductor defect** (Codex is fixing it). Conductor runs the local model's Codex with a private settings folder, which lacks the Windows sandbox setting your own Codex saved (`[windows] sandbox = "elevated"` in `%USERPROFILE%\.codex\config.toml`). Without it, every command the local model tries is refused as read-only, so it cannot write files. Use whatever value your own `config.toml` has.

## 6. Start the app

In the same PowerShell window as step 3 (it holds the key). First tell Codex where its search tool is (*learned 31 Oct*: the app starts `codex.exe` directly, skipping the npm launcher that normally does this). Use the `codex-path` folder beside the `bin` folder from step 2:

```powershell
$env:Path = "<folder holding bin\codex.exe, one level up>\codex-path;" + $env:Path
[bool]$env:LOCALAI_API_KEY        # must print True; if False, repeat the hidden prompt in step 3
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

*Learned 31 Oct:* the page gives only a one-word reason (`unauthorized`, `timeout`, `unavailable`). To see the whole error, run the participant by hand in a second window. The first Codex **Check it can code** may fail once on a new machine while Codex sets up its Windows sandbox; one manual run in a throwaway folder sets it up:

```powershell
mkdir C:\conductor-trial\probe; cd C:\conductor-trial\probe; git init -q
& "<codex.exe path>" exec "Create a file called hello.txt containing the word hi. Reply OK." -o out.txt --sandbox workspace-write
```

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

Stop the LocalAI worker on the desktop PC. *Learned 31 Oct:* the worker's compose file needs the address its start script supplies, so stop it the same way:

```powershell
$network = Get-Content E:\SHINGON\desktop_worker\local\localai-network.json -Raw | ConvertFrom-Json
wsl -d Shingon-LocalAI -u root --exec env "SHINGON_WSL_BIND=$($network.wslAddress)" docker compose -f /mnt/e/SHINGON/desktop_worker/localai-worker.compose.yaml stop
curl.exe -s -o NUL -w "%{http_code}" -m 5 http://192.168.1.109:50050/readyz    # 000 = down
```

Then start *Add a divide(a, b) function with a test*.

- [ ] The app stops and asks: **The local model is unavailable**, with **Pause** or **Use subscriptions**. Choose **Pause**. Neither choice may switch to paid API keys.
- [ ] Start LocalAI again afterwards: `& E:\SHINGON\desktop_worker\Start-LocalAI-Worker.ps1`.

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
