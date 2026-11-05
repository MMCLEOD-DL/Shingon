# Claude review: PR76, dedicated Codex home for frontier (subscription) calls

- **Reviewed:** [PR76](https://github.com/MMCLEOD-DL/Shingon/pull/76), merged as `4c1d504` (code commit `0066c34`). Requested in `work-log/2026-11-01-1716-codex-submitted-frontier-codex-home.md`. This is a post-merge review of credential-adjacent code.
- **Scope:**
  - `conductor/src/adapters/{codex,privateCodexHome}.js`
  - `conductor/bin/conductor-codex-home.js`
  - `conductor/src/service/{probe-guidance,probe-worker,runs}.js`
  - `docs/operator-app/setup.md`
  - the new and changed tests
- **Disposition:** sound, and it fails closed. **No blocking findings.** One low-to-medium operational finding (R1) and two low notes.

## What holds (verified)

- **Personal Codex settings and sign-in are never read or copied.** The frontier home gets only the generated `config.toml`. On Windows, any `CODEX_HOME` spelling is removed from the child environment before the dedicated one is set.
- **The home always sits outside the agent workspace:** `openPrivateCodexHome` refuses a `cwd` that contains it. The generated config is never written through a planted link or hard link (`lstat`, `nlink === 1`). The base folder and home are created mode 0700 on POSIX.
- **Separate frontier and local homes.** Frontier and local identities differ (`['frontier', bin]` versus `[bin, extraConfig]`). Parallel health probes therefore cannot collide on a lease.
- **No credential is involved in preparation.** `bin/conductor-codex-home.js` runs no CLI, prints only `{home, bin}`, and its error message carries no detail.
- **Probe guidance** for an unauthorized Codex points to the dedicated-home sign-in, and still interpolates no CLI output.
- **Tests:** on main at `40b8388` (cloud Linux, Node 22.23.4), PR76's focused command passes, `node --test --test-concurrency=4 test/frontier-codex-home.test.js test/private-codex-home.test.js test/config.test.js test/local-windows-sandbox.test.js test/codex-search-path.test.js test/service/probe-guidance.test.js test/service/probe.test.js test/service/platform.test.js test/service/server.test.js`: 81 pass, 0 fail, 0 skip. This is synthetic: no real Codex, no sign-in.

## R1 (low-medium, operational): a Codex update that moves `codex.exe` silently signs Conductor out and leaves the old sign-in behind

- **Trigger:** the configured `bin` path changes. Task 36 recorded S2: the npm Codex `.exe` moved from `…\vendor\…\codex\codex.exe` to `…\bin\codex.exe` on update. F6 means the app is configured with that direct path.
- **Cause:** the frontier home's key hashes the cache base, the generated config text and `['frontier', bin]`. This is deliberate and documented ("A different executable path or cache location needs its own sign-in").
- **Consequence:** after such an update, the next call uses a new, signed-out home. The operator sees "Codex rejected its sign-in…" and has to repeat the dedicated sign-in. The old home keeps Codex's stored sign-in (file credentials, if file storage is used) in the cache indefinitely, and nothing removes it. The same happens if Conductor ever changes `frontierCodexConfig()`, because the config text is part of the key.
- **Reproduction:** [`fixtures/pr76-frontier-home-identity.mjs`](fixtures/pr76-frontier-home-identity.mjs) is offline: synthetic `auth.json`, and Codex is never run. On main:
  - same `bin`, different model: same home, still signed in;
  - same `bin`, `extraConfig` added: same home, still signed in;
  - `bin` moved as in S2: **new home, not signed in**; 2 homes left in the cache, and the old sign-in file is still present.
- **Proposed correction (Codex's call):** key the frontier home on something stable across updates, such as `['frontier', participant name]` or the realpath's file name, plus the cache base. Leave the config text out of the key, because it is rewritten on every call anyway. If the per-executable separation is meant to keep different Codex installs apart, then at least name the old home in the unauthorized guidance, or document how to remove it.

## Notes (low)

- **N1:** the busy-lease message says "Private local Codex home is busy" for frontier calls too. That can happen, for example, when the CLI `conductor` runs a Codex call while the app is mid-run. Wording only.
- **N2:** on macOS/BSD the lease is a fixed loopback port (49152 + hash). Another local process holding that port makes every frontier call "busy" until it is released. It fails closed, and Darwin is not an acceptance target. No change asked for.

## Not verified here

Real Codex loading, keyring namespacing, ChatGPT sign-in and Windows sandbox setup in the dedicated home. Those are live or native checks that need Malcolm's permission (P08).
