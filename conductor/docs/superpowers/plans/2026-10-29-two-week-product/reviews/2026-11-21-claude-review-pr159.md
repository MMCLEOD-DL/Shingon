# Claude review: PR159, sanitized lease listen diagnostics

- **Reviewed:** Codex's PR159 (`codex/service-lease-diagnostics`), with its code at `39b3845`, merged as `d29ba1a`. I reviewed it on `main` at `d29ba1a`.
- **Requested by:** PR159's description ("Claude review invited"). Malcolm merged it before this review, so this is a post-merge review.
- **Host:** native Windows 11 Home 10.0.26300, Node v24.12.0. I used only loopback listeners and temp folders.
- **Disposition: no defect.** There is one low copy note (L1).

## What changed

When the lease listener fails, `src/service/lease.js` now keeps the OS error code if it is one of nine known listen
codes. Any other code becomes `UNKNOWN`. The error carries that code as `listenCode`, and the existing message gains
`[listen: <code>]`. The status (409), the error code (`data-in-use`) and the message's opening text are unchanged. The
OS message, the address, the port and the cause are not copied. There are three new tests in
`test/service/lease.test.js`.

## Checks

- `node --test test/service/lease.test.js` from `conductor`: **3/3 pass**.
- **Other uses of the message:** the only one is `test/service/server.test.js:152`, which matches `/already in use/`.
  That text is unchanged.
- **Mutations:** I applied each one to `src/service/lease.js` in place, ran the file, then restored it with
  `git checkout`. `git status` was clean afterwards.

| Mutation | Result | What caught it |
|---|---|---|
| M1 any `error.code` is passed through (no allowlist) | 2 pass / 1 fail | the malformed and unknown-code test |
| M2 the OS message is appended to the error text | 1 / 2 | both sensitive-field tests |
| M3 the listener's error is dropped (`leaseListenError(null)`) | 2 / 1 | the real duplicate-lease test (`EADDRINUSE` expected) |

The duplicate-lease test uses a real second `acquireLease` on the same folder. It also checks that the lease can be
taken again after release, so the change does not leak a listener.

## L1 (low, copy, Claude-owned when it surfaces)

The tag `[listen: EADDRINUSE]` now ends the sentence an operator may see when a second copy of the app starts. It
helps with diagnosis, but it is not plain English. The Windows acceptance notes already plan to map `data-in-use` to
launcher text. When that is built, I suggest keeping `listenCode` in logs and evidence, and showing operators a plain
sentence. For example, "Another copy of Shingon is already using this data folder" for `EADDRINUSE`, and the current
sentence for other codes. No change is needed now.

## Not covered here

- I did not rerun the full native suite for this review. Codex's PR says its full native run was still in progress
  at submission.
- Linux: at merge, `conductor`, `foundation`, `knowledge` and `operator-web` were green. `risk-gate` failed by design,
  because `src/service/` is on the high-risk list. Malcolm's merge is the approval.
