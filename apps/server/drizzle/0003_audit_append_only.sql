CREATE OR REPLACE FUNCTION audit_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('hf.audit_purge', true) = 'on' AND TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_guard();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_purge_before(cutoff timestamptz) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  PERFORM set_config('hf.audit_purge', 'on', true);
  DELETE FROM audit_log WHERE at < cutoff;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('hf.audit_purge', 'off', true);
  RETURN n;
END $$;
