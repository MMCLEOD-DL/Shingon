# Work log entries

One file per entry, so the two lanes never edit the same file and a merge cannot drop another lane's entry. Packet
statuses stay in [`../04-work-log.md`](../04-work-log.md), as one-line row changes. Entries up to 30 October 2026 are
archived in that file.

## Naming

`YYYY-MM-DD-HHMM-<lane>-<slug>.md`:
- the date and time are UTC, when the entry is written, so sorting by name puts entries in time order and the newest
  is last;
- `<lane>` is `claude`, `codex` or `malcolm`;
- `<slug>` is a few lower-case words, such as `task-26-work-log-files`.

Codex's submission entries use the slug `submitted-<task>`, so `*-codex-submitted-*.md` finds them (AGENTS.md, step 1).

## Content

Start with a level-1 heading naming the entry, for example `# Claude task 26: work log as one file per entry`, or
`# Codex task submitted — <task>`. Then use the handoff template in [`../03-parallel-working.md`](../03-parallel-working.md):
owner, exact SHAs, evidence (live, fake, skipped and unrun kept apart), reviewer and next action.

## Rules

- Add a new file for every claim, handoff, submission or correction. Never edit or delete another lane's file; to
  correct one, add a new file that names it.
- Never copy credentials, private data or full logs into an entry.
- A status change also updates that packet's row in `../04-work-log.md`.
