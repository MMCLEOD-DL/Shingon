# Claude task 32: K9, backups and the restore drill

```
Packet/subpacket: K9 (backups + restore drill automation; migration-plan.md, depends on K2). Malcolm chose it on
  30 October 2026 as the next unblocked knowledge task: no hosting choice, no models.
Owner and reviewer: Claude; reviewer Codex.
Status: IN_REVIEW.
Baseline SHA: 27bbbf9 (K7 merged).
Owned files: knowledge/src/shingon_knowledge/{backup.py (new), __main__.py (backup, restore, drill commands),
  service.py (an audit switch on the internal search only)}; knowledge/tests/test_backup.py (new);
  knowledge/README.md; this entry.
What now works:
  backup: pg_dump (custom format) from an exported snapshot; the manifest (migrations, row counts, original hashes,
    fingerprints) read in that same snapshot; originals copied and each checked against the sha256 recorded at
    import; written as kb-<time>.partial and renamed only when complete; owner-only folder on POSIX; password via
    PGPASSWORD, never argv; check questions run unaudited in a read-only transaction.
  restore: verifies every hash first; refuses a non-empty database or folder; pg_restore in one transaction;
    rewrites every stored path (pending removals too) to the new folder; removes what it copied if it fails.
  drill: scratch database (KB_DRILL_DATABASE_URL) and temporary folder; checks migrations, row counts, originals,
    every principal's and project token's viewRevision, and the check questions' results; drops both; JSON
    report with the restore time; exit 0 only on pass.
Checks (cloud Linux, Python 3.13, PostgreSQL 16.15 server and client tools, throwaway), from knowledge/:
  python3 -m unittest discover -s tests: 81 passed (10 new), none skipped. The drill passes on the synthetic corpus
    with all 25 labelled questions; a manifest altered for one caller and one question fails exactly those two;
    a changed dump or original restores nothing; a missing or altered original fails the backup and leaves only
    .partial; a restored service serves the same bytes from its own folder and its purge never touches the source
    deployment's file; tokens still authenticate after a restore; a backup writes no audit rows.
  git diff --check: clean.
Not here: monthly scheduling (operator's scheduler; documented, no OS task created); pgBackRest/PITR, encryption
  and off-box copies (wait on D4 hosting); retention (nothing deletes old backups). No run on Windows or against a
  real deployment. CI needs pg_dump/pg_restore on the ubuntu-24.04 runner; not yet observed there.
Open for Malcolm/Codex: K6-A1, K6-H1 and K6-H2 (Codex reviews of PRs 58/60) are Claude's next task after this merges.
