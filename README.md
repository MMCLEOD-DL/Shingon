# Conductor

Conductor gets AI models to build a change in your project **and check each other's work**
before anything reaches your code.

- Two rival AI models (Claude and Codex, on your own subscriptions) plan the work and review
  every step. They come from different companies, so each one checks the other.
- A model running on your own machine does the routine coding, which saves your subscription
  for planning and reviewing.
- Nothing touches your project until you approve the result. Even then, it arrives as a **new
  branch** that you merge when you are ready.

## What you need

- Node.js 20 or newer, and `git`.
- The `claude` (Claude Code) and `codex` (Codex) command-line programs, both signed in.
- Optionally, a local model server that speaks the OpenAI API (LocalAI, Ollama, LM Studio),
  driven through `codex`.

## Set up

1. Copy `config.example.json` to `~/.config/conductor/config.json` (or to `conductor.json`
   inside a project) and edit it to point at your models.
2. Check that everything is reachable:

       node /path/to/conductor/bin/conductor.js doctor

   You will see a ✓ or ✗ for each model, and which one will plan, review and code. For
   `claude` and `codex` a ✓ only means the program is **installed** (it answers
   `--version`); whether it is signed in is found out the first time Conductor uses it. The
   local model gets a real test request, so its ✓ means it answered.

(If you make `bin/conductor.js` available as `conductor` on your PATH, the commands below work
as written.)

## Use it

Inside your project folder:

    conductor "add a CSV export button to the reports page" --test "npm test"

You will see a live status. Conductor stops to ask you only when it needs you:

- **A disagreement it cannot settle safely:** you get a short written recommendation and
  choose approve or reject.
- **The end:** a plain-English summary of what changed. Type `v` to see the actual changes,
  `a` to approve (the result becomes a new branch), `r` to reject, or `n` to reject with a note.

Other commands:

| Command | What it does |
|---|---|
| `conductor resume` | carry on with the latest unfinished run in this project |
| `conductor runs` | list the unfinished runs in this project |
| `conductor doctor` | check which models are installed (subscriptions) or answering (local model) |
| `conductor project new "<client>"` | make a client project folder (`--slug <name>` picks the folder name) |
| `conductor project list` | list projects and where each brief stands |
| `conductor project show <project>` | details of one project and its brief |
| `conductor brief <project> --notes <file>` | draft, question and approve a brief |
| `conductor brief <project>` | carry on with an unfinished brief |
| `conductor brief <project> --revise --notes <file>` | make a new version of the approved brief |
| `conductor brief <project> --discard-draft` | throw away an unfinished brief (your notes are kept) |

A request whose first word is `project` or `brief` is read as one of these commands, so put the
whole request in quotes (`conductor "brief the new starter on the rota page"`) or start it with
another word.

Add `--approve-plan` to see the plan and say yes before any work starts.

Add `--council` to have three specialist reviewers check the finished work first (see
**The council**).

Press **Ctrl-C** at any time to stop. Your project is untouched, and `conductor resume`
carries on from the last finished step.

## When a model is unavailable

- If one subscription is signed out, out of its usage limit or rate-limited, Conductor
  switches to the other one. A signed-out model stays out for the rest of the run; one that
  is rate-limited or briefly unreachable is tried again after `cooldownMs`.
- If only one company's models are left, the run carries on, and the summary tells you the
  cross-checking was weaker.
- Before every run (and in `conductor doctor`) Conductor checks the local model and tries to
  wake it if you have set that up (see **Waking the local model**). If it still is not
  answering, Conductor tells you what is wrong and **asks** before Claude or Codex do its
  steps, because that uses your subscription. You can try again, go ahead, or stop. Without a
  terminal to ask you, Conductor stops and nothing is spent.
- If the local model stops answering **during** a run, Conductor asks once. If you say no,
  the run pauses; start the local model and run `conductor resume`.
- If no model is left, the run **pauses**. Run `conductor resume` when one is back.
- Paid API keys are used **only** if you set `"allowApi": true` under `routing` in the config.
  The run tells you the moment it starts using one, and the summary says how much it cost.

## The council (optional extra checks)

Add `--council` to have three specialist reviewers check the finished work before you see it:

- **Security**: scans the code for common security holes, leaked passwords or keys, and
  dependencies with known security problems.
- **Legal**: checks that every dependency the change adds uses a licence you can hand to a
  client (MIT, Apache, BSD, ISC and similar). Copyleft licences (GPL, AGPL, LGPL, MPL) and
  missing or unknown licences block the change. Dependencies used only while developing are
  listed as warnings. It reads licences from `package-lock.json`; an old-format lockfile
  (version 1) has none, so the check is skipped until you update it with npm 7 or later.
- **Correctness**: checks that the tests pass and that the change really does what you asked.
  A failing test command shows up as a finding titled "The tests fail", whose detail starts
  with the exit code (or says the test command timed out).

Each reviewer runs real checking tools first. An AI from the other company then reads the
results, sets aside false alarms and explains the real problems in plain English. The AI on
its own can only warn you, never block, and it cannot turn a tool's warning into a block.
A reason made only of blank space never sets a finding aside, and if the AI contradicts
itself, Conductor keeps the finding.

If a reviewer finds a problem that must be fixed, Conductor fixes it as an extra step and
runs all the checks again, up to 3 times. If something is still wrong after that, it asks
you. These fix steps are never paused for your approval, even with `approveEachChunk` on. When
it is done, the summary you approve includes a **council report**: what was fixed, what is
still worth knowing, and which checks could not run. "Fixed during the review" lists only
problems whose check ran again and no longer reports them. A finding the AI set aside as a
false alarm is not counted as fixed.

Problems that were already in your project before this change are listed as warnings and
never block it: code lines this change did not add (even in a file it edited), dependencies it
did not add or update, and tests that were already failing before it started (Conductor runs
the tests once on the starting point to check). A file the change adds or renames counts as
fully new. A line the change moved or re-indented counts as new. The ScanCode licence scanner
is judged line by line too, when it reports line numbers.

If the secret scanner finds a password or key that the change added, it blocks. Once the fix
removes it, Conductor combines the run's steps into one commit before you approve, so the key
is not left in your repository's history either. (Gitleaks checks the finished files, so a key
added and removed between two steps before the council runs is not caught.)
Treat any key the council found as exposed and replace it, even after the fix removed it:
the reviewing AIs and the run log may already have seen it. The limits, plainly: Gitleaks only
knows common key formats, so it can miss one, and the combined commit cleans only this run's
history, not anything a person, an AI or a log has already seen.

Editing a scanner's settings or ignore files, or adding a comment that tells a scanner to skip
a line (`nosemgrep`, `nosec`, `gitleaks:allow`), shows as a Security warning the AI cannot set
aside.

**Tools it uses (all free, all optional; run `conductor doctor` to see which you have, even
when it cannot reach your models):**

| Check | Tool | Install |
|---|---|---|
| Code scan | Semgrep | `pipx install semgrep` |
| Leaked secrets | Gitleaks | release binary from github.com/gitleaks/gitleaks |
| Dependency security | npm audit | comes with Node.js |
| Copied licensed code | ScanCode | `pipx install scancode-toolkit` |

A missing tool is listed under "Checks that did not run". It never stops a run.

**Settings** (under `options` in `config.json` or a project's `conductor.json`):

- `council`: `true` turns it on for every run;
- `councilFixRounds`: how many times problems go back to be fixed (default 3);
- `councilAcceptLicences`: licences you accept for **this** project, for example
  `["LGPL-3.0-only"]`, or one exact package as `name@version`, for example
  `["some-lib@1.2.0"]` (the only way to accept a package with no licence);
- `councilTools`: a tool's path if it is not on your PATH, or `false` to turn a check off;
- `councilSemgrepConfig`: Semgrep rules (default `p/default`, downloaded from Semgrep's
  registry; point it at a local rules file to work fully offline).

## Client projects and briefs

The factory builds a web app for a client from an approved **brief**. Each client gets a
project folder (by default under `~/highland-projects`; change it with `factory.projectsRoot`).
The commands in the table above work from any folder, not only a git project.

    conductor project new "Thistle Joinery Ltd"      # makes ~/highland-projects/thistle-joinery-ltd
    conductor brief thistle-joinery-ltd --notes ~/meetings/thistle-2026-10-27.md

Conductor gives your meeting notes to Claude (or Codex), which drafts the brief: who uses the
app and what each role may see, what it stores, each feature with **worked examples** (real
figures, such as "a £12.40 receipt with £2.07 VAT appears in March's report under Travel"),
reports, outside systems, and the client's **data policy** (where it is hosted, where data may
go, how long it is kept, where backups go, and that the client accepts your remote access).

Anything the notes don't settle comes back to you as a plain question, **one at a time**.
Type your answer, `skip` if you don't know yet, or `stop` to finish for now. When nothing is
left to ask, you see the whole brief and choose `a` approve, `c` ask for changes, or `s` stop.

- **Your notes stay private.** They are copied into the project's `notes/` folder and sent only
  to the frontier model writing the brief, never to the local model.
- **Split long notes.** If the notes are too long to send in one go, Conductor says so and sends
  nothing: split them and run the brief in parts, or shorten them.
- **Vague examples are refused.** "It works correctly" can't become a test, so Conductor sends it
  back to the AI before you ever see it.
- **Each example gets a tag** such as `[upload-receipt#1]` when you approve. The factory's tests
  carry the same tag, so you can see which example each test proves. A revised brief keeps the
  tag of every example whose words did not change; a new or reworded example gets a new number,
  and an old number is never reused.
- **Outside services come from a fixed list.** The data policy names the services data may go
  to by id (today `cloudflare-tunnel` and `azure-document-intelligence`). Anything else is
  refused until it has been added to Conductor's list, so a brief can never quietly allow a
  service nobody has checked.
- **Nothing is lost if you stop.** Run `conductor brief <project>` later to carry on where you
  left off. `conductor brief <project> --discard-draft` throws an unfinished brief away (your
  notes are kept).
- **Briefs are versioned.** Approving writes `brief/brief-v1.md` (for you to read and send) and
  `brief/brief-v1.json` (what the factory builds from). To change an approved brief, run
  `conductor brief <project> --revise --notes <new notes>`: you get version 2, and version 1
  is kept. If Conductor crashes after writing a version's files but before recording it, the
  next approval takes the next number and the unused file stays behind: harmless, and never
  overwritten.
- **It needs a terminal.** Without one, Conductor does nothing and sends nothing.

## Building a client's app

Once a client's brief is approved, Conductor can build the app.

    conductor build harbour-cafe

- **What it does.** It makes the app from the foundation release named in the config (the
  release is recorded in the project and never moved silently). It splits the approved brief
  into small features and shows you the list. Each feature is built in turn with the usual
  plan, local model and cross-checking, and the brief's worked examples are written as tests
  **first**. The foundation's rules are checked on every feature and `npm run verify` is kept
  passing. At the end Conductor runs every check plus the browser checks, then asks for your
  approval. Approving puts the build on the app's `main` branch, records the approval in
  `project.json` and marks the project ready. It does not make a release: that happens when
  the app is first shipped (`conductor ship`). Sending feedback turns it into one more feature;
  rejecting leaves `main` alone. The app's `app-profile.json` (its modules and data policy) is
  written from the brief in the build's first commit. Reports from the final checks are kept in
  the build folder under `reports/`.
- **Before the first build.** Set `TEST_DATABASE_URL` to a PostgreSQL role that may create
  databases (for example the local one on this VM). Install Playwright's browsers with
  `npx playwright install chromium webkit` for the browser checks; without them the checks are
  reported as not run.
- **Stopping and carrying on.** Press Ctrl-C at any time. `conductor build <project>` (or
  `conductor resume` inside the project's folder) carries on where it stopped. `--new` starts
  again from the current brief; you need it after the brief changes.
- **Previews.** `conductor preview <project>` shows the build in progress (or the approved
  app) with made-up data on a factory machine, at an address on your own network only (the
  machine's private LAN address, never `0.0.0.0`), and prints the demo sign-ins (password
  `demo-password-1`, which is why a preview can never become a live box). `--stop` ends it.
  There is one preview per project, and one use per CT 111 at a time.
- **Machines.** `conductor machines` lists what is in use. `conductor machines sweep` clears
  machines left over from crashes (older than 6 hours, never a running preview). The same
  machines also run the council's deploy tests and build release images for shipping. The
  `static` provider uses machines you already run. The `proxmox` provider makes and destroys its
  own containers, only inside the pool, number range and limits you set up for it, and only ones
  it labelled itself. Keep that number range free of any other container, and if a container
  was made but left without its label (a crash half way), remove it by hand in Proxmox.
- **What it will not do yet.** Briefs that need optional modules (OCR, PDF or spreadsheet
  export, scheduled jobs); rebuilding an app that is already approved (that will be
  `conductor change`); the full council (design, reliability) is the next plan.
- **Quote run requests.** A run request that begins with the word `build`, `preview` or
  `machines` is read as one of these commands. Put the request in quotes, for example
  `conductor "build a login page"`, or word it differently (the same goes for `brief` and
  `project`).

## Waking the local model

Conductor remembers which models your earlier runs used, and checks them before each run. Each
participant in the config can say how to wake it with a `wake` block:

- `"method": "warn"` (the default): just check it, and if it is down show your `hint`, the
  words that tell you what to start by hand.
- `"method": "wol"`: send a Wake-on-LAN signal to its `mac` address (optional `broadcast`,
  default `255.255.255.255`, and `port`, default `9`). The machine must have Wake-on-LAN
  switched on, and Conductor must run on the same network. Leave out `broadcast` and `port`
  unless your network needs them.
- `"method": "command"`: run a program you choose, for example a restricted `ssh` that starts
  the model server: `"cmd"`, `"args"`, and `"env"` (the names of environment variables the
  program may see; it sees no other secrets). It is stopped after `timeoutMs` (default 60 s).
  Only that program gets those variables: Claude Code, Codex, the local agent and your tests
  never do. Their values are hidden from anything Conductor prints or records when they are
  at least 8 characters long (shorter ones are hidden only in what the wake program prints).
  Put passwords and keys in `env`, never in `args`: the words in `args` are not hidden.

After waking, Conductor waits up to `waitMs` (default 180 s), checking every `pollMs`
(default 5 s).

```json
"wake": { "method": "wol", "mac": "aa:bb:cc:dd:ee:ff", "broadcast": "192.168.1.255",
          "hint": "Turn on the desktop PC and start its LocalAI worker." }
```

How this behaves:

- Conductor only wakes a model it cannot reach. If the model answers but something else is
  wrong (its key is refused, or the model is not installed), Conductor says so straight away.
- If the model is still down after waking, Conductor asks (see above) unless `localDown` is
  `"frontier"` (go ahead without asking) or `"pause"` (never cover for it).
- If you say "go ahead" before the run, that covers the whole run: you are not asked again
  if the local model stops answering later.
- With no terminal to ask you, a stop before the run starts exits with code 1, and a stop
  during the run pauses it with exit code 3. With `localDown` set to `"pause"`, a stop before
  the run starts exits with code 2.
- `conductor doctor` wakes your models but never asks anything.
- `conductor resume` asks again. Your earlier answer does not carry over to a resumed run.

What Conductor remembers is kept in `.workers.json` in its workspaces folder. Deleting it is
safe.

## Settings (`config.json`)

- `participants`: your models. Each one has an `adapter`: `claude-code`, `codex`,
  `local-agent`, `anthropic-api` or `openai-api`.
- `routing`:
  - `allowApi` (default `false`; must be `true` or `false`, not `"true"`);
  - `preferTwoVendors` (default `false`; `true` or `false`): use a paid API for the second
    opinion instead of letting one company review its own work. It has no effect unless
    `allowApi` is `true`;
  - `localDown`: `"ask"` (default: ask you first), `"frontier"` (let Claude/Codex cover without asking) or `"pause"` (never cover; stop or pause instead).
    Any other value stops Conductor with an error when it reads the config (older versions
    quietly treated it as `"frontier"`);
  - `cooldownMs`: how long a rate-limited or unreachable model rests before it is tried
    again; `maxWaitMs`: the longest Conductor waits when every model is resting;
  - `author`, `reviewer`, `local`: which participant to prefer for each job.
- `options`:
  - `testCommand`;
  - `approveEachChunk`;
  - `maxChunks`;
  - round limits: `planRounds`, `localRounds`, `frontierRounds`;
  - timeouts: `agentTimeoutMs`, `localTimeoutMs`, `testTimeoutMs`;
  - `keepWorkspace`;
  - `watchDiffs`;
  - the council: `council`, `councilFixRounds`, `councilAcceptLicences`, `councilTools`,
    `councilSemgrepConfig` (see **The council**).

- `factory` (client projects and briefs):
  - `projectsRoot`: where project folders go (default `~/highland-projects`). It must start with
    `/` or `~`, and the `CONDUCTOR_PROJECTS_ROOT` environment variable overrides it;
  - `operatorName`: the name recorded on approved briefs (default: your computer login name).

  - `foundation`: `repo` (the foundation's folder or address, default `/root/highland-foundation`)
    and `tag` (the release to build from, default `v0.1.0`);
  - `build`: `browserGate` (default `true`), `fixRounds` (default 2), `councilFixRounds`
    (default 3) and `testCommand` (replaces `npm run verify`);
  - `machines`: `provider` (`static` or `proxmox`), `static.hosts` (each with `id`, `host`, `user`,
    `keyPath`, `previewPort`, `workRoot`), `proxmox` (`null` until set up; see the operator
    follow-ups in `spikes/factory-build-smoke/RESULT.md`), and `sweepAfterMs`.

  Later factory plans add their own keys to this same section.

## Safety

- All work happens in a separate copy of your project, under `~/.conductor/workspaces`. Your
  project gets only a new branch, and only after you approve.
- Keys are never written to logs or shown on screen. Your local model's key goes only to your
  local model.
- Without a terminal (for example in a script), Conductor answers every question "reject", so
  nothing can land unattended.
- The full record of every run is kept as a log file. Its path is printed at the end of
  each run.
