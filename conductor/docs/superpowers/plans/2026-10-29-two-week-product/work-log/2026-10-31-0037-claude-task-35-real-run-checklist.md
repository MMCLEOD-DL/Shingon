# Claude task 35: first real-run checklist (toward P08)

```
Packet/subpacket: P08 preparation (live acceptance is Codex's; Claude is its independent reviewer). Malcolm asked
  for this on 31 October 2026: a script for his first run with real models on Windows.
Owner and reviewer: Claude; reviewer Codex (P08 owner).
Status: IN_REVIEW.
Baseline SHA: main after PR 64.
Owned files: conductor/docs/operator-app/real-run-checklist.md (new); this entry. setup.md and acceptance.md
  (Codex's) are linked, not edited.
What it is: twelve steps for Malcolm on the Windows host: build; native .exe discovery (the app's shell-free
  launcher is not known to work with npm .cmd shims); local model reachability; a throwaway repository; a minimal
  config (the local model set on disk, because the browser only accepts https or localhost endpoints); start and
  bootstrap; the nine participant checks; approve, reject, stop, app stop/restart/resume and local-model-down
  tasks; evidence to keep and what never to collect; a results table that becomes P08 evidence.
Checks: every UI label it names was found in operator-web/src (Check installation/sign-in/it can code, Add
  repository, Approve: create a branch, Branch created, If you reject, Rejected — no branch created, Interrupted,
  Resume, Stop run…, Who did the work, Connection lost, The local model is unavailable, Pause, Use subscriptions).
  Commands come from setup.md and the code. git diff --check clean. Docs only: no tests apply.
Not here: no run of it (it needs Malcolm's machine, sign-ins and GPU); the vendors' native Windows install steps
  are named, not scripted; the windowsHide fault is Codex's and is only flagged for observation.
```
