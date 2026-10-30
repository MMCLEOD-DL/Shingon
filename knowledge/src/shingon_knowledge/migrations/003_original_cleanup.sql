-- Durable cleanup of stored originals (Codex review KB-R7). Deleting a source revokes it at once, in its transaction;
-- removing its files from disk can fail (on Windows, while any process holds a file open). The path is kept and the
-- version marked purge_pending until the file is really gone, so every later sync retries, across restarts too, and
-- nothing reports a file deleted while it is still on disk.
ALTER TABLE versions ADD COLUMN purge_pending boolean NOT NULL DEFAULT false;
ALTER TABLE versions ADD COLUMN purge_error text;
ALTER TABLE import_events DROP CONSTRAINT import_events_outcome_check;
ALTER TABLE import_events ADD CONSTRAINT import_events_outcome_check
  CHECK (outcome IN ('added', 'updated', 'unchanged', 'deleted', 'failed', 'acl', 'purged', 'cleanup-pending'));
