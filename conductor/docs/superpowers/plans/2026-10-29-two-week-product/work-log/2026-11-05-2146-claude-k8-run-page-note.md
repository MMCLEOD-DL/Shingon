# Claude: the run page names what the knowledge base did (K8 slice 4, UI)

```
Packet/subpacket: next-phase K8, slice 4 (Claude's UI part), on Codex's service forwarding (PR110).
Owner and reviewer: Claude; reviewer Codex.
Status: IN_REVIEW.
Baseline SHA: 0288411 (PR110 merge), plus the PR110 review PR. Branch: claude/sharp-hypatia-kte0or.
Files: conductor/operator-web/src/components/Knowledge.jsx (new), src/views/RunView.jsx (two lines),
  tests/views.spec.jsx, e2e/journey.mjs. No service, engine or fixture change.
```

## What changed

A **Knowledge base** section on the run page, under "Who did the work". It appears only when the run has
`evidence-*` events, and is built from the fields the service forwards (`docs/operator-app/interface.md`):

- **Used:** how many passages the models were given, and whether the knowledge base rated the evidence weak.
- **Withheld:** one line per collection. It names the collection and who it was kept from, and gives the allowed
  destinations in plain words ("the local model", "Claude (subscription)", "Codex (subscription)", a Foundation app).
  It also says what to do: run the task with only those participants. The document IDs are under "Which documents".
  A count-only event says the collection allows no destination the run can use.
- **Unavailable:** the reason code in plain words (unreachable, timeout, redirect, settings or token, and so on).
- **Dropped:** the run carried on without evidence, with the engine's reason. This separates a failed record save from
  a policy change, as Codex suggested.
- **Stopped:** why, and what to do (resume once the service is back and its policy is unchanged, or start a fresh run).

It never shows a passage; the service never receives one. Every value is rendered as text.

## Checks

Cloud Linux, Node 22.23.4, Playwright Chromium. All synthetic: the fixture worker's K8 events (PR110) and deterministic
workers, no models and no knowledge service.

- `npx vitest run`: 78 passed. Four new view tests:
  - no events, no note;
  - collections grouped, with plain destinations and no raw codes;
  - stop, drop and unavailable wording;
  - hostile collection and document names stay text.

  Three of them fail with the note removed from the page. The fourth, "no note", passes either way.
- `npm run build`: ok.
- `node e2e/journey.mjs`: 22 + 6 + 4 passed, exit 0. The new journey step starts a task with the fixture worker's K8
  events through the real service and checks the note, live and again after a reload (replay). It also checks that
  no private field or raw destination code reaches it.

## Not run

Native Windows, a real K6 service and live models. Slice 5 (acceptance against a real K6 service) remains.
