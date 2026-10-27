# Task 12: Docs and operator ship smoke

This task finishes Plan 10 with:

- **README "Shipping client apps"**: what `ship` and `deployments` do, the operator's one-off setup (the follow-ups from the index, as steps), what each outcome means and what to do, the exit codes, and how secrets are handled.
- **`config.example.json`**: the `factory` block.
- **An operator-run smoke** against a real throwaway box: first ship, status, a later ship, and Ctrl-C while an update is running.

**The implementer writes the files and checks syntax only (`bash -n`, `npm test`). The implementer does NOT run the smoke.** Malcolm runs it with `!`: it needs a real box, the build machine, a Matrix room, an Uptime Kuma monitor and a human to save the backup password.

**Files:**
- Modify: `README.md`, `config.example.json`
- Create: `spikes/ship-smoke/run-ship-smoke.sh`, `spikes/ship-smoke/RESULT.md`
- Test: `test/config.test.js` (append)

**Interfaces:**
- Consumes: `conductor ship`, `conductor deployments [status]` (Tasks 10, 11); `factoryConfig` with Plan 10's `alerts`/`ship` sections (Task 10).
- Produces: the operator command `bash spikes/ship-smoke/run-ship-smoke.sh <project> <deployment>` and the docs.

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.js`:

```js
import { factoryConfig } from '../src/factory/config.js';

test('config.example.json has a factory block that factoryConfig accepts, with the ship and alerts sections', () => {
  const c = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  const f = factoryConfig(c, { env: {}, home: '/home/op' });
  assert.equal(f.ship.updateTimeoutMs, 2700000);
  assert.equal(f.alerts.matrix.roomId, '!alerts:example.org');
  assert.match(f.projectsRoot, /highland-projects$/);
});
```

Run: `node --test test/config.test.js`
Expected: FAIL (`config.example.json` has no `factory.alerts`, so `f.alerts.matrix` is null).

- [ ] **Step 2: Add Plan 10's two sections to the `factory` block of `config.example.json`** (Plans 7 and 8 own `projectsRoot`, `foundation`, `build` and `machines`; keep theirs exactly and add only these keys):

```json
    "alerts": { "matrix": { "homeserver": "https://matrix.example.org", "roomId": "!alerts:example.org" } },
    "ship": { "updateTimeoutMs": 2700000, "pollMs": 5000, "startTimeoutMs": 300000, "buildTimeoutMs": 3600000 }
```

The foundation repository whose security fixes `deployments status` checks is Plan 8's `factory.foundation.repo`; Plan 10 adds no setting for it.

Run: `node --test test/config.test.js && npm test`
Expected: PASS.

- [ ] **Step 3: Add "Shipping client apps" to `README.md`**, after the factory sections Plans 7–9 add (or after "The council" if they are not there yet). Plain UK English, short sentences. It must contain these sub-sections, in this order, with this content:

1. **What it does.** `conductor ship <project> --to <deployment>` finds the release of the approved build (making the app's first release, 1.0.0, the first time), builds it on a factory machine and puts it on the box. The first time, it sets the box up with the foundation's own tools and asks you a few questions; later, it uses the box's safe update, which takes a backup first and undoes itself if the new version fails. `conductor deployments` lists your deployments; `conductor deployments status` checks every box. No AI model is used and no subscription is spent.
2. **Before the first ship (once per box).** The eight operator follow-ups from `00-index.md`, as numbered steps with the exact commands (`sudo mkdir -p /opt/highland/<name> && sudo chown <user> /opt/highland/<name>`; `ssh-copy-id`; checking and adding the host key with `ssh-keyscan` **and comparing the fingerprint with the one the box shows**; the `~/.ssh/config` alias, with the Cloudflare `ProxyCommand cloudflared access ssh --hostname %h` variant; the Matrix bot and room; the Uptime Kuma push monitor; the tunnel token and routes; the backup destination; the build machine's Node, npm, Docker and git, and `docker login` there for a registry).
3. **What you will be asked.** The question list from Task 7 in plain words, and: the backup password is shown **once**; type `saved` once it is in your password manager; clear your terminal's scrollback afterwards.
4. **What Conductor keeps, and what it never keeps.** Kept (in `<project>/deployments/<name>.json` and `deployments/logs/`): the box's address, user, folder, web address, how it is reached, the Matrix room, versions and the history of ships. Never kept anywhere by Conductor: database and backup passwords, the health token, mail, Matrix, tunnel, backup or registry passwords and tokens, the heartbeat address. They live only in the box's `.env`. What you type is sent to the box over SSH on standard input, never on a command line.
5. **Outcomes and what to do** — a table with the outcome texts from Task 3 and the next step for each (`updated` nothing; `rolled-back` find out why before shipping again; `cancelled`/`busy` fix the reason or try again; `urgent` the runbook's "Recovering from a failed update" on the box, then `update --mark-recovered` there, then `conductor deployments status`; `lost-contact` run `conductor deployments status`).
6. **Exit codes** (Ruling 10).
7. **Keeping apps patched.** Run `conductor deployments status` at least monthly and whenever a `[security]` entry appears in the foundation's CHANGELOG; it lists apps behind on foundation security fixes. Operating-system updates on a box are still done by hand over SSH, in a quiet hour, after `docker compose run --rm ops backup` (box RUNBOOK.md, "Keeping a deployment patched").
8. **Limits.** Tailscale is set up by hand (Conductor only records it). Conductor cannot send a test alert yet: foundation v0.1.0 has no such command (v0.2.0 adds `ops test-alert`, and using it is a follow-up once apps are on v0.2.0); until then the first real alert proves the channel. Updates are watched by polling; if Conductor loses contact the update still finishes on the box. The images file is copied through the machine running Conductor, so a slow link there slows the ship.

- [ ] **Step 4: Write `spikes/ship-smoke/run-ship-smoke.sh`**

A guided `bash` script (`set -euo pipefail`), arguments `<project> <deployment>`, that:
1. checks `conductor`, `ssh` and `git` are on `PATH`, and that `~/.ssh/config` or `known_hosts` mentions the deployment's host (prints how to add it if not);
2. **Phase 1, first ship:** `conductor ship "$1" --to "$2"`; then `conductor deployments status "$1"`; expects exit 0 from both; prints what to check by hand on the box (`docker compose ps`, `docker compose run --rm ops check` all ✓, the Matrix room got nothing alarming, Uptime Kuma shows the push arriving);
3. **Phase 2, later ship (an update through `updateDeployment`):** pauses with `Make a change and let it ship: conductor change <project> --notes <file> (it releases the change and updates this box through the same safe update conductor ship uses). Press Enter when it has finished`; then runs `conductor deployments status "$1"` (expects exit 0 and the new version) and `conductor ship "$1" --to "$2"` (expects exit 1 and `There is nothing new to ship`);
4. **Phase 3, Ctrl-C while updating:** pauses for another change; tells Malcolm to run it and press Ctrl-C when `box: Taking a backup` appears (expects exit 130 and `The update carries on by itself on the box`); then waits for Enter, runs `conductor deployments status "$1"`, expects `The last update's result is now known` and exit 0. This phase relies on Plan 11's change command handling Ctrl-C with `interruptShip` (index, "Still open" 3);
5. writes the date, versions and pass/fail of each phase to `spikes/ship-smoke/RESULT.md`.

`RESULT.md` starts as a template: a heading, "Not run yet.", and the three phases with empty result lines.

Run: `bash -n spikes/ship-smoke/run-ship-smoke.sh && npm test`
Expected: no syntax errors; PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md config.example.json spikes/ship-smoke/run-ship-smoke.sh spikes/ship-smoke/RESULT.md test/config.test.js
git commit -m "docs(ship): shipping client apps, operator setup, and an operator-run ship smoke

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
