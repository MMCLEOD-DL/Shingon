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

## The full council on client builds

At the end of `conductor build`, the full council reviews the **whole app** (everything since
the foundation release) against the approved brief and its data policy. It has five members:

- **Security**: as before, plus the **role-crossing tests**: can any role reach data it should not?
- **Legal and data**: the licences (including the app's own `licence-exceptions.json`, with its
  reasons), where the app sends data (checked against the outside services the policy allows),
  personal data, and how long records are kept.
- **Correctness**: the foundation's own checks, plus every worked example in the brief must have
  a passing test whose name carries its id, such as `[mileage-claims#2]`.
- **Design**: every page at desktop and phone width, sideways scrolling, buttons too small to
  tap, and accessibility.
- **Reliability**: the app is deployed on a test machine, backed up, restored, stopped and
  restarted, the alert is sent and cleared, and a broken update undoes itself.

**What blocks and what only warns:**

- Blocks: a page that does not load, scrolls sideways, has buttons too small to tap or has script
  errors; a failed foundation check (install, lint, types, licences, tests, build); a worked
  example with no test, or whose test fails or is skipped; a failed user journey; a failed
  role-crossing test; a failed step in the reliability test; the app reaching an outside service
  the policy does not allow (unless the reviewer sets it aside, with a reason).
- Only warns: accessibility problems (serious ones are warnings, minor ones notes), house style,
  money sums done in floating point, personal data and retention, and anything that could not be
  checked ("not proven", below).

**What it needs:**

- what `conductor build` already needs: `TEST_DATABASE_URL` and the Playwright browsers;
- a test machine (`factory.machines`; `static` uses CT 111) with Docker and Node 22, reachable by
  SSH;
- optionally **axe-core**, for the accessibility scan. Install it on the Conductor side only:
  run `npm pack axe-core@4` in an empty folder, unpack it, and put `package/axe.min.js` at
  `~/.local/share/conductor/axe-core/axe.min.js` (or set `councilTools.axe` to the file's path;
  `false` turns the scan off). It is under the Mozilla Public License, and Conductor checks
  the licence line at the top of the file before it uses it. Conductor uses axe as a checking tool and
  injects it into the browser while it runs; it is **never** added to the client's app, its
  `package.json` or its lockfile. `conductor doctor` shows whether it was found.

**"Not proven".** Without a test machine, the Playwright browsers, the test database or axe-core,
the council still runs. It does not guess: anything it could not check is a warning at the top
of the report ("Reliability was not proven: ...", "The pages were not checked ...",
"Accessibility was not proven ..."), and the "What was checked" section says which checks ran
and whether they came from the build's own checks or the council's. A "not proven" warning
never blocks, but it also never counts as a pass: read it before you approve.

**Time.** About 15 to 25 minutes per council round. The build's own checks are reused for the
same version of the app, so the council adds only the accessibility scan (a few minutes) and the
reliability test on the machine (10 to 20 minutes). If a problem blocks, it goes back as a
council fix and the council runs again, up to three fix rounds (so at most four council rounds;
`factory.build.councilFixRounds`); after that Conductor asks you. `options.councilGatesTimeoutMs` and `options.councilSmokeTimeoutMs`
(40 minutes each by default) cap the council's own local checks and the machine test.

**Where the report is.** `<project>/builds/<run>/council-report.md` (and `.json`), with the page
screenshots under `<project>/builds/<run>/council/round-<n>/screenshots/`. The approval summary
at the gate names the file.

The Efficiency reviewer from the design is not in this version. Ordinary repositories with
`--council` are unchanged: they still get Security, Legal and Correctness only.

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
  `conductor change`).
- **Quote run requests.** A run request that begins with the word `build`, `preview` or
  `machines` is read as one of these commands. Put the request in quotes, for example
  `conductor "build a login page"`, or word it differently (the same goes for `brief` and
  `project`).

## Shipping client apps

### What it does

`conductor ship <project> --to <deployment>` finds the release of the approved build (it makes the app's first release, 1.0.0, the first time), builds it on a factory machine and puts it on the box. The first time, it sets the box up with the foundation's own tools and asks you a few questions. Later ships use the box's safe update, which takes a backup first and undoes itself if the new version fails.

`conductor deployments` lists your deployments. `conductor deployments status [<project>]` checks every box over SSH: version, health, last backup and restore test, and foundation security fixes the app is missing.

No AI model is used and no subscription is spent. `ship` needs a terminal and refuses without one.

### Before the first ship (once per box)

1. **Prepare the box.** x86-64 Linux with Docker Engine, the Compose plugin and `setsid` (util-linux), and a deploy user in the `docker` group. Create the folder for the deployment:
   `sudo mkdir -p /opt/highland/<name> && sudo chown <user> /opt/highland/<name>`
2. **Let Conductor log in.** From the machine running Conductor: `ssh-copy-id <user>@<box>`.
3. **Trust the box's host key.** Conductor never accepts a new key by itself. Run `ssh-keyscan -t ed25519 <box> >> ~/.ssh/known_hosts`, then compare the fingerprint (`ssh-keygen -lf ~/.ssh/known_hosts`) with the one the box shows (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the box). Remove the line if they differ.
4. **Give the box an alias** in `~/.ssh/config` and use the alias as the deployment's address. For a box behind the Cloudflare tunnel, route an SSH hostname to `ssh://host.docker.internal:22` in the tunnel dashboard, install `cloudflared` on the machine running Conductor and add:
   ```
   Host acme-box
     HostName ssh.acme.example.org
     User highland
     ProxyCommand cloudflared access ssh --hostname %h
   ```
   Do the first ship on the LAN or VPN; afterwards only the alias changes. A client's own box is reached through the Cloudflare tunnel or Tailscale only: nothing is opened inbound on their network. This is about how you reach the box from outside; Conductor's own SSH connection may go over the LAN, a VPN or the tunnel alias.
5. **Matrix.** Make a bot account and an alerts room, invite the bot and let it join. Keep the bot's access token to paste at the first ship. Put the homeserver and room id in `factory.alerts.matrix` in `config.json` (they become the suggested answers).
6. **Uptime Kuma.** Add one push monitor per deployment, set to alert after 5 minutes of silence. Keep its push address to paste at the first ship.
7. **Cloudflare tunnel** (if you use it). One tunnel per client box. Keep its token to paste at the first ship, and add the routes in the dashboard (the staff address to `http://proxy:80`). The tunnel is refused unless the brief's data policy allows Cloudflare, because Cloudflare sees the traffic. It has not been tried on a real box yet.
8. **Backup destination and password manager.** Set up the client's backup destination as their data policy says (for `sftp:`, authorise the box's own SSH key there) and make a password manager entry per client for the backup password.
9. **Build machine** (CT 111 `hf-build` with the `static` provider): Node 22, npm with internet access, Docker and git. For a registry, run `docker login <registry>` once on it. The machine running Conductor also cuts the release, so it needs Node 22, npm with internet access and git.

### What you will be asked

In plain words: the box's address or SSH alias, the login user, the SSH port, the folder on the box, how you will reach the box from outside, the web address staff will type, how the images get there (a file copied over SSH, or your private registry, with its address, folder, user and password), the mail server address and sender address, the backup destination (and its sign-in details for S3, Backblaze or a REST server), where alerts go (Matrix with its bot token, and optionally a webhook), the Uptime Kuma push address (or `skip`, which leaves a standing warning in `deployments status`), the tunnel token if you use the tunnel, and whether to create the first admin account.

Conductor checks your answers against the brief's data policy before it touches the box. It refuses, for example, a backup destination on the box itself.

Typed a wrong address, user or folder at the first ship? If nothing was set up on a box yet (`conductor deployments` shows `first-time setup not finished (stopped after: new)`), delete `<project>/deployments/<name>.json`, or correct the address in it, and run the ship again; delete the file to be asked every question afresh.

The backup password is shown **once**. Save it in your password manager, then type `saved`. Clear your terminal's scrollback afterwards. If you stop before typing `saved`, it is shown again next time.

### What Conductor keeps, and what it never keeps

Kept, in `<project>/deployments/<name>.json` and `<project>/deployments/logs/`: the box's address, user, folder and web address, how it is reached, the Matrix room, versions, and the history of ships. Every log line is redacted.

Never kept anywhere by Conductor: the database and backup passwords, the health token, and the mail, Matrix, tunnel, backup and registry passwords and tokens, or the heartbeat address. They live only in the box's `.env`. What you type is sent to the box over SSH on standard input, never on a command line.

### Outcomes and what to do

| Outcome | What it means | What to do |
|---|---|---|
| updated | The box is on the new version; a backup was taken first. | Nothing. Read any "Note from the box". |
| rolled back | The new version did not work and the box undid it. The old version and its data are as before. | Find out why the new version failed before shipping again. |
| cancelled | The box refused before changing anything. | Fix the reason it gives, then ship again. |
| busy | The box was running another update, backup or restore. | Try again in a few minutes. |
| already on | The box already has that version. | Nothing. |
| urgent | The box may be down or on the wrong data. | On the box, follow RUNBOOK.md, "Recovering from a failed update", then run `docker compose run --rm updater update --mark-recovered` there, then run `conductor deployments status`. |
| lost contact | Conductor could not tell how the update ended; it may still be running or may have finished. | Run `conductor deployments status`. |

An interrupted or lost-contact ship always needs `conductor deployments status` before the next ship. Status clears the block only when it can show the update is finished (the box runs the new version, or the update's result was read). If it says an update may still be running, wait and run status again.

Press Ctrl-C during a later ship and Conductor stops watching, but the update carries on by itself on the box, so it is never killed half-way.

A release may change only the release files (`CHANGELOG.md`, `package.json`, `package-lock.json`, `foundation.json`). If the app's release script changes anything else, Conductor refuses and leaves `main` untouched.

### Exit codes

`conductor ship`:

- `0` shipped or updated
- `1` not done and nothing changed (refused, cancelled, rolled back, already on, busy)
- `2` stopped part-way through first-time setup, or lost contact (run `ship` again, or `deployments status`)
- `3` urgent: the box may be down
- `64` usage
- `130` interrupted

`conductor deployments status` exits `0` when every box is healthy and current, `1` otherwise.

### Keeping apps patched

Run `conductor deployments status` at least monthly, and whenever a `[security]` entry appears in the foundation's CHANGELOG. It lists apps that are behind on foundation security fixes. Operating-system updates on a box are still done by hand over SSH, in a quiet hour, after `docker compose run --rm ops backup` (the box's RUNBOOK.md, "Keeping a deployment patched").

### Limits

- Tailscale is set up by hand; Conductor only records it.
- Conductor cannot send a test alert yet: foundation v0.1.0 has no such command (v0.2.0 adds `ops test-alert`, and using it is a follow-up once apps are on v0.2.0). Until then the first real alert proves the channel.
- Updates are watched by polling. If Conductor loses contact, the update still finishes on the box.
- The images file is copied through the machine running Conductor, so a slow link there slows the ship.
- The operator smoke is `bash spikes/ship-smoke/run-ship-smoke.sh <project> <deployment>`. It uses a real box and works on a copy of the project in a throwaway folder; its first phase ships the app for the first time. Later updates through `conductor change` are tried by the change smoke (see "Changing a live app").

## Changing a live app

Once an app is built and shipped, every later change goes through Conductor, so the same checks happen every time: a written change, a build, a review of the whole app by the council, your approval, and then a safe update to each place the app is running.

### Making a change

    conductor change <project> --notes <file>

The notes file is plain text: what the client asked for (meeting notes are fine). Conductor first asks you the brief questions about the change, as it did when the app was first planned, and you approve the new version of the brief. It then builds only the difference, has the council review the **whole** app (not only the new part, so a change cannot quietly break something that worked), and stops at the gate.

The gate shows what the council found and, under "If you approve", what happens next. If you approve:

- the app's main line moves on to the approved work, with the change listed in its changelog;
- a new version of the app is made;
- every deployment of the project is updated, one at a time. Each box takes a backup first and undoes the update by itself if the new version does not start properly.

Nothing ships unless the council passed, or you chose to ship anyway after reading every problem it reported. If you say no, nothing is released and the app stays as it was; the new version of the brief you approved is kept, and the next change builds on it.

Two things are not changes. A feature you remove from the brief is taken out of the app but **keeps its data**: deleting client data is always a separate, manual decision. And moving the app to different hosting is not a change either; Conductor refuses it before building anything, so use `conductor ship` for a new box.

`conductor change` on its own, or with one word after it (`conductor change acme`), is now this command and prints how to use it, rather than being sent to the AI team as an ordinary request; a longer request such as `conductor change the button colour` still is one. The same goes for `conductor foundation-upgrade`.

You need a terminal for `--notes`, `--to` and `--resume`, because Conductor asks you questions and waits for your approval; without one it refuses to start. `--abandon` and `--check` need no terminal.

### Taking a foundation fix

    conductor foundation-upgrade <project> --to <tag>

The foundation is the base every app is built on. When it releases a fix, you choose when an app takes it. Use this whenever the foundation's `CHANGELOG.md` has a `[security]` entry newer than the version the app is on. Conductor brings the foundation release into a copy of the app and then follows the same path as a change: build, whole-app council, gate, then an update to every deployment.

Sometimes the merge reports conflicts. That means both the foundation and the app changed the same lines. Up to 20 clashing text files go to the AI team to resolve without a question; the council then reviews the result as usual, and your only question is the final gate. If more than 20 files clash, Conductor asks you first and carries on only if you say yes. If one side deleted a file the other edited, or a binary file, a link or a sub-project clashes, Conductor stops without asking: a person has to merge by hand on the branch it names, or you drop the upgrade with `--abandon`.

### Seeing who is behind

    conductor foundation-upgrade --check

This changes nothing. It lists every project and every deployment and says whether each has all the `[security]` fixes in the newest foundation release. There are two kinds of line for a project:

- **code**: the app's own source is behind. Run the upgrade it suggests.
- **a deployment name**: a box is behind. If the code line says up to date but a deployment is behind, the fix is already in the code and just has not reached the box yet. Finish or resume the change that ships it: `conductor change <project> --resume`.

A line that says "could not check" is not good news. Fix the reason it gives and run it again.

### When a ship stops part-way

A change or upgrade can stop after the gate, while it is updating the boxes. Conductor prints one line per deployment saying what happened to it, and it stops at the first box that did not update, so later boxes are untouched.

1. Read the deployment lines. "The box undid the update by itself" means the box is back on the old version and its data is as before. Find out why the new version failed before trying again.
2. If a line starts with **URGENT**, the box may be down or on the wrong data. Before anything else, follow "Recovering from a failed update" in the foundation's runbook (`RUNBOOK.md` in the box's bundle folder), then run `docker compose run --rm updater update --mark-recovered` on the box and `conductor deployments status`.
3. Then carry on with `conductor change <project> --resume`. It carries on from where it stopped and asks you before trying a deployment that already started again. The same command carries on an upgrade.

### `--resume`, `--abandon` and one change at a time

Only one change or upgrade runs per project at a time. If you try to start another while one is unfinished, Conductor says so. Either carry on:

    conductor change <project> --resume

or drop it (nothing the unfinished run already released is undone, but nothing more happens):

    conductor change <project> --abandon

`foundation-upgrade <project> --resume` and `--abandon` do the same. Ctrl-C at any point is safe; Conductor tells you the command to carry on.

The operator smoke for all of this is `bash spikes/change-smoke/run-change-smoke.sh <project> <deployment>`. It uses a disposable test deployment, a throwaway copy of the project (point `SOURCE_PROJECTS_ROOT` at the folder Plan 10's ship smoke left under `/var/tmp`), and a scratch copy of the foundation.

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
  - the council: `council`, `councilFixRounds`, `councilAcceptLicences`, `councilTools`
    (including `axe`), `councilSemgrepConfig`, `councilGatesTimeoutMs`, `councilSmokeTimeoutMs`
    (see **The council** and **The full council on client builds**).

- `factory` (client projects and briefs):
  - `projectsRoot`: where project folders go (default `~/highland-projects`). It must start with
    `/` or `~`, and the `CONDUCTOR_PROJECTS_ROOT` environment variable overrides it;
  - `operatorName`: the name recorded on approved briefs (default: your computer login name);
  - `foundation`: `repo` (the foundation's folder or address, default `/root/highland-foundation`)
    and `tag` (the release to build from, default `v0.1.0`);
  - `build`: `browserGate` (default `true`), `fixRounds` (default 2), `councilFixRounds`
    (default 3) and `testCommand` (replaces `npm run verify`);
  - `machines`: `provider` (`static` or `proxmox`), `static.hosts` (each with `id`, `host`, `user`,
    `keyPath`, `previewPort`, `workRoot`), `proxmox` (`null` until set up; see the operator
    follow-ups in `spikes/factory-build-smoke/RESULT.md`), and `sweepAfterMs`;
  - `alerts.matrix`: `homeserver` and `roomId`, the suggested answers when `ship` asks where alerts go;
  - `ship`: `updateTimeoutMs` (default 2700000), `pollMs` (5000), `startTimeoutMs` (300000) and
    `buildTimeoutMs` (3600000), all in milliseconds (see **Shipping client apps**).

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
