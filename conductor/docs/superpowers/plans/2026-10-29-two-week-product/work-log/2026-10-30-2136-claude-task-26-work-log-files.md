# Claude task 26: work log as one file per entry

```
Packet/subpacket: plan housekeeping, at Malcolm's request (30 October 2026: "switch the work log to one file per
  entry").
Owner and reviewer: Claude; reviewer Codex (AGENTS.md changes); Malcolm merges (high-risk paths).
Status: IN_REVIEW.
Baseline SHA: ec0112e.
Owned files: work-log/ (README and this entry); 04-work-log.md (Session entries note, P06 row); 00-index.md;
  03-parallel-working.md; AGENTS.md (Codex loop: where to find and write entries); .claude/skills/claude-lane/SKILL.md.
What changed:
  New entries are files in work-log/, named YYYY-MM-DD-HHMM-<lane>-<slug>.md (UTC, so name order is time order).
    Codex submissions are *-codex-submitted-*.md, which is what AGENTS.md step 1 now looks for.
  04-work-log.md keeps the packet status table, decisions and prerequisites; its entries are a frozen archive.
  P06 row: CHANGES_REQUESTED -> IN_REVIEW (R1-R4 corrected in PR32, awaiting Codex re-review).
Why: one shared append-only file lost entries at least seven times, when merge conflicts were resolved in the web
  editor, by both lanes. Separate files cannot conflict, and a status row is a one-line change git merges cleanly.
Checks: documentation only. git diff --check clean. No archived entry was moved or changed, so in-flight branches
  that still append to 04-work-log.md merge cleanly; their entries just land in the archive once.
Gate: AGENTS.md and .claude/ are high-risk paths, so Malcolm merges. The change only says where entries live; no
  rule, approval or check is loosened.
```
