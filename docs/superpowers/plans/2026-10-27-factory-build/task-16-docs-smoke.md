# Task 16: Docs, operator smoke and follow-ups

This task finishes Plan 8:
- **README and example config.** A plain-English "Building a client's app" section and the `factory` block in `config.example.json`.
- **An operator-run smoke** of the whole phase on the real setup: a tiny brief through `conductor build`, a Ctrl-C and carry-on, a preview on CT 111 opened on a phone, approval, stop, sweep.
- **The operator follow-ups** (below), which the live `proxmox` provider and the smoke depend on.

**The implementer writes the files and checks syntax only, and does NOT run the smoke.** Malcolm runs it, because it needs the live models, both subscriptions, CT 111, the local PostgreSQL role and a human at the gate.

**Files:**
- Modify: `README.md`, `config.example.json`
- Create: `spikes/factory-build-smoke/run-build-smoke.sh`, `spikes/factory-build-smoke/notes.md`, `spikes/factory-build-smoke/RESULT.md`

**Interfaces:**
- Consumes: every command from Task 15; Plan 7's `conductor project new` and `conductor brief`.
- Produces: the operator command `bash spikes/factory-build-smoke/run-build-smoke.sh`, the docs.

- [ ] **Step 1: `config.example.json` gains a `factory` block**

```json
  "factory": {
    "projectsRoot": "~/highland-projects",
    "foundation": { "repo": "/root/highland-foundation", "tag": "v0.1.0" },
    "build": { "browserGate": true, "fixRounds": 2 },
    "machines": {
      "provider": "static",
      "static": { "hosts": [ { "id": "ct111", "name": "hf-build", "host": "192.168.1.111", "user": "root",
                               "keyPath": "~/.ssh/id_ed25519", "previewPort": 8080, "workRoot": "/srv/hf-factory" } ] },
      "proxmox": null
    }
  }
```

Run: `npm test` (the config tests read this file; `factoryConfig` must accept it).
Expected: PASS. Add `test('config.example.json has a valid factory block', …)` to `test/factory-config.test.js` (`factoryConfig(JSON.parse(readFileSync('config.example.json')), { env: {}, home: '/h' })` does not throw) if no existing test reads the example's `factory` block.

- [ ] **Step 2: README section "Building a client's app"**

Insert after the council section. Plain UK English; it must cover, in this order:
1. **What `conductor build <project>` does:** makes the app from the foundation release named in the config (recorded in the project, never moved silently); splits the approved brief into small features and shows the list; builds each feature in turn with the usual plan, local model and cross-checking, writing the brief's worked examples as tests **first**; checks the foundation's rules on every feature; keeps `npm run verify` passing; at the end runs every check plus the browser checks, then asks for your approval. Approving puts the build on the app's `main` branch and marks the project ready; sending feedback turns it into one more feature; rejecting leaves `main` alone.
2. **Before the first build:** `TEST_DATABASE_URL` (a PostgreSQL role that may create databases, for example the local one on this VM); Playwright's browsers (`npx playwright install chromium webkit`) for the browser checks, or they are reported as not run.
3. **Stopping and carrying on:** Ctrl-C at any time; `conductor build <project>` (or `conductor resume` inside the project's folder) carries on where it stopped; `--new` starts again from the current brief (needed after the brief changes).
4. **Previews:** `conductor preview <project>` shows the build in progress (or the approved app) with made-up data on a factory machine, at an address on your own network only, with the demo sign-ins printed (password `demo-password-1`, which is why a preview can never become a live box). `--stop` ends it. Only one preview per project; one use per CT 111 at a time.
5. **Machines:** `conductor machines` lists what is in use; `conductor machines sweep` clears machines left over from crashes (older than 6 hours, never a running preview). The `static` provider uses machines you already run; the `proxmox` provider makes and destroys its own containers, only inside the pool, number range and limits you set up for it, and only ones it labelled itself.
6. **What it will not do yet:** briefs that need optional modules (OCR, PDF or spreadsheet export, scheduled jobs); rebuilding an app that is already approved (that will be `conductor change`); the full council (design, reliability) is the next plan.

- [ ] **Step 3: Write `spikes/factory-build-smoke/notes.md`**

A tiny client, chosen so one or two features cover it:

```markdown
# Meeting notes: Harbour Café (smoke test, made up)

- 8 staff, one manager (Priya). Wants a simple tips log instead of the paper sheet behind the till.
- Staff record their tips at the end of each shift: date, shift (morning/evening), amount in pounds.
- Staff see only their own entries. Priya sees everyone's, and a weekly total per person (Monday to Sunday).
- Example: Sam logs £3.50 on Monday morning and £1.50 on Monday evening; Priya's weekly view shows Sam: £5.00.
- Example: an amount of £0 or less is refused with a clear message.
- Hosted on the café's own little box; nothing goes to outside services; UK only; keep entries 2 years; backups to the owner's NAS.
- The owner accepts that Highland can log in remotely to support it.
```

- [ ] **Step 4: Write `spikes/factory-build-smoke/run-build-smoke.sh`**

An interactive checklist script (`set -euo pipefail`), each step printed, run, then confirmed with `read -r -p "…OK? [y/N] "` (anything but `y` stops with `SMOKE STOPPED at step N`):
0. **Pre-flight (refuses to start otherwise):** `TEST_DATABASE_URL` set; `psql "$TEST_DATABASE_URL" -c 'select 1'` works; `ssh -o BatchMode=yes root@192.168.1.111 'docker compose version && mkdir -p /srv/hf-factory && test -w /srv/hf-factory'` works; `conductor doctor` exits 0; the config has a `factory` block; `~/highland-projects/harbour-cafe` does not exist yet.
1. `conductor project new "Harbour Café"` → slug `harbour-cafe`.
2. `conductor brief harbour-cafe --notes spikes/factory-build-smoke/notes.md` → answer the questions, approve.
3. `conductor build harbour-cafe`. **Press Ctrl-C once** while the first feature's second step is running; confirm the message says the build is kept.
4. `conductor build harbour-cafe` again: confirm it says it is carrying on, and that the first feature's finished steps are not redone.
5. At the approval question, **before answering**, in a second terminal: `conductor preview harbour-cafe`. Open the printed address on a phone on the home Wi-Fi; sign in as the printed admin (`demo-password-1`); check the tips page exists and the demo data shows; sign in as a member and check they see only their own entries.
6. Back at the approval question: type `f`, feedback `Show the weekly totals in bold.`; confirm one more feature runs and the question comes back. Approve.
7. `git -C ~/highland-projects/harbour-cafe/app log --oneline main | head -8`: one commit per feature, `Name the app: Harbour Café`, then the foundation's history. `cat ~/highland-projects/harbour-cafe/project.json`: `status: ready`, `foundation.tag: v0.1.0`.
8. `conductor preview harbour-cafe`: says it replaced the earlier preview (new commit). Open it again.
9. `conductor preview harbour-cafe --stop`; `conductor machines` → none in use; `ssh root@192.168.1.111 'docker ps -a --format "{{.Names}}" | grep -c "^hf-" || true; ls /srv/hf-factory/runs; docker images "hf-preview/*" -q | wc -l'` → 0, empty, 0.
10. `conductor machines sweep` → `Nothing was left over.`
11. Print where the evidence is: the build folder, `reports/crossing.md`, `reports/screenshots/`, and ask Malcolm to fill in `RESULT.md`.

Run: `bash -n spikes/factory-build-smoke/run-build-smoke.sh`
Expected: no output (syntax OK).

- [ ] **Step 5: Write `spikes/factory-build-smoke/RESULT.md`**

A template with one line per step (`- [ ] Step N: … — result: …`), plus "Frontier cost reported at the gate", "How long the build took", "Anything that read badly" and "Follow-ups".

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add README.md config.example.json spikes/factory-build-smoke test/factory-config.test.js
git commit -m "docs(factory): building a client's app, previews and machines; operator smoke"
```

## Operator follow-ups (Malcolm; none is needed for the tests)

**For the static provider and the smoke (CT 111):**
1. Put this VM's SSH public key in `root@192.168.1.111:~/.ssh/authorized_keys` and connect once by hand (`ssh root@192.168.1.111 true`), so CT 111's host key is in this VM's `known_hosts`. Conductor uses `StrictHostKeyChecking=yes` and will not connect otherwise.
2. On CT 111: `mkdir -p /srv/hf-factory` (writable by the SSH user); Docker Engine and Compose v2 are already there from the foundation smoke; check `curl` and `base64` exist. CT 111 needs outbound internet for image builds (npm, Docker Hub).
3. Decide whether the preview port (8080) may be reached from the whole home LAN (the intended use) and that nothing else on CT 111 uses it.
4. On this VM: create a PostgreSQL role for the foundation's tests (`CREATE ROLE hf_test LOGIN CREATEDB PASSWORD '…'`) and export `TEST_DATABASE_URL` in the shell that runs Conductor. Playwright's browsers are already installed here.
5. Add the `factory` block to the real config (Step 1's example).

**For the proxmox provider (spec §4.7; until done, `static` with CT 111 is used):**
1. **Pool:** create the pool `hf-factory` (Datacenter → Permissions → Pools).
2. **VMID range:** pick a free range, for example 9100–9149, and keep it free of anything else; put it in `factory.machines.proxmox.vmidRange`.
3. **Template:** a Debian 12 LXC, **unprivileged, with `features: nesting=1,keyctl=1`** (Docker needs them, and only `root@pam` can set them, so they must be on the template), Docker Engine and Compose v2 installed, `openssh-server` enabled, `curl` present, DHCP on `vmbr0`, this VM's factory public key in `/root/.ssh/authorized_keys`, `/srv/hf-factory` created. Convert it to a template (for example VMID 9099, outside the range) and **add it to the `hf-factory` pool**. Storage that supports linked clones (LVM-thin or ZFS), or set `fullClone: true`.
4. **Role:** a custom role (for example `HFFactory`) with `VM.Allocate`, `VM.Clone`, `VM.Config.CPU`, `VM.Config.Memory`, `VM.Config.Options`, `VM.Config.Disk`, `VM.Config.Network`, `VM.PowerMgmt`, `VM.Audit`, `Datastore.AllocateSpace`, `Datastore.Audit`, `Pool.Audit`, and on Proxmox 8 `SDN.Use`.
5. **User and token:** user `conductor@pve` with no other rights; API token `conductor@pve!factory` **with privilege separation**; grant the role to the token on `/pool/hf-factory`, on the template's storage (`/storage/<name>`) and on the bridge (`/sdn/zones/localnetwork/vmbr0` on Proxmox 8). Nothing on `/` and nothing on the operator's own containers.
6. **Secret:** put the token secret in the environment variable `CONDUCTOR_PROXMOX_TOKEN` of the shell that runs Conductor (never in the config file).
7. **CA:** copy `/etc/pve/pve-root-ca.pem` from the Proxmox host to this VM and set `factory.machines.proxmox.caFile` to it.
8. **Limits:** confirm `maxContainers` (default 3), `cores` (2), `memoryMb` (4096) and `maxMemoryMb` (12288) suit the MS-01 alongside the existing containers.
9. Then set `"provider": "proxmox"`, run `conductor machines` (lists nothing), and repeat smoke steps 5, 8 and 9 to see a container made, labelled and destroyed in the pool.
