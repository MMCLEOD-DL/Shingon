# Plan 8 build and preview smoke: result

Run with `bash spikes/factory-build-smoke/run-build-smoke.sh`. Date: ____  Operator: ____

- [ ] Step 0: pre-flight passed — result:
- [ ] Step 1: project new, slug harbour-cafe — result:
- [ ] Step 2: brief answered and approved — result:
- [ ] Step 3: Ctrl-C kept the build, message said so — result:
- [ ] Step 4: build carried on, finished steps not redone — result:
- [ ] Step 5: preview opened on a phone (private LAN address), admin and member sign-ins behave — result:
- [ ] Step 6: feedback `f` ran one more feature, approved — result:
- [ ] Step 7: git log, no tag on main, project.json (ready, v0.1.0, approved.sha = main tip, builtFromBrief 1) — result:
- [ ] Step 8: second preview replaced the first — result:
- [ ] Step 9: stop, machines empty, CT 111 clean (0 containers, empty runs, 0 images) — result:
- [ ] Step 10: sweep said "Nothing was left over." — result:
- [ ] Step 11: `reports/` holds vitest.json and playwright.json (reporter forwarding works against the real foundation), crossing.md, screenshots/ — result:

Frontier cost reported at the gate:
How long the build took:
Anything that read badly:
Follow-ups:

## Operator follow-ups (none is needed for the tests)

### Static provider and this smoke (CT 111)
1. Put this VM's SSH public key in `root@192.168.1.111:~/.ssh/authorized_keys` and connect once by hand (`ssh root@192.168.1.111 true`) so CT 111's host key is in `known_hosts`. Conductor uses `StrictHostKeyChecking=yes` and will not connect otherwise.
2. On CT 111: `mkdir -p /srv/hf-factory` (writable by the SSH user); Docker Engine and Compose v2 are already there; check `curl` and `base64` exist. CT 111 needs outbound internet for image builds (npm, Docker Hub).
3. Decide that the preview port (8080) may be reached from the whole home LAN (the intended use) and that nothing else on CT 111 uses it. Previews bind to the machine's private LAN address, never 0.0.0.0; if `host` in the config is not an IP address, Conductor looks up the machine's own private address and refuses if it finds none (set `host` to the IP then).
4. On this VM: create a PostgreSQL role for the foundation's tests (`CREATE ROLE hf_test LOGIN CREATEDB PASSWORD '...'`) and export `TEST_DATABASE_URL` in the shell that runs Conductor. Playwright's browsers are already installed here.
5. Add the `factory` machines/foundation/build blocks from `config.example.json` to the real config, keeping `operatorName`.

### Proxmox provider (until done, `static` with CT 111 is used)
1. **Pool:** create the pool `hf-factory` (Datacenter, Permissions, Pools).
2. **VMID range:** pick a free range, for example 9100-9149, and keep it clear of every non-factory container: the API token cannot see containers outside its pool, and a clone is only retried a few times, so a clash makes a build fail. Put the range in `factory.machines.proxmox.vmidRange`.
3. **Template:** a Debian 12 LXC, unprivileged, with `features: nesting=1,keyctl=1` (Docker needs them and only `root@pam` can set them, so they must be on the template), Docker Engine and Compose v2, `openssh-server` enabled, `curl` present, DHCP on `vmbr0`, this VM's factory public key in `/root/.ssh/authorized_keys`, `/srv/hf-factory` created. Convert it to a template (for example VMID 9099, outside the range) and add it to the `hf-factory` pool. Use storage that supports linked clones (LVM-thin or ZFS), or set `fullClone: true`.
4. **Role:** a custom role (for example `HFFactory`) with `VM.Allocate`, `VM.Clone`, `VM.Config.CPU`, `VM.Config.Memory`, `VM.Config.Options`, `VM.Config.Disk`, `VM.Config.Network`, `VM.PowerMgmt`, `VM.Audit`, `Datastore.AllocateSpace`, `Datastore.Audit`, `Pool.Audit`, and on Proxmox 8 `SDN.Use`.
5. **User and token:** user `conductor@pve` with no other rights; API token `conductor@pve!factory` with privilege separation; grant the role to the token on `/pool/hf-factory`, on the template's storage (`/storage/<name>`) and on the bridge (`/sdn/zones/localnetwork/vmbr0` on Proxmox 8). Nothing on `/` and nothing on your own containers.
6. **Secret:** put the token secret in the environment variable `CONDUCTOR_PROXMOX_TOKEN` of the shell that runs Conductor (never in the config file).
7. **CA:** copy `/etc/pve/pve-root-ca.pem` from the Proxmox host to this VM and set `factory.machines.proxmox.caFile` to it.
8. **Limits:** confirm `maxContainers` (default 3), `cores` (2), `memoryMb` (4096) and `maxMemoryMb` (12288) suit the MS-01 alongside the existing containers.
9. **Half-made containers:** if Conductor crashes while making a container, it can be left in the pool without its factory label. Conductor leaves unlabelled containers alone (`conductor machines` prints a note about them), so remove such a container by hand in Proxmox.
10. Then set `"provider": "proxmox"`, run `conductor machines` (lists nothing), and repeat smoke steps 5, 8 and 9 to see a container made, labelled and destroyed in the pool.
