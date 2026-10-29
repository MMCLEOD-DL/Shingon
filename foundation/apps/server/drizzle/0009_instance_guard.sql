-- The instance record is the database's memory. It may only move forward: a live database never goes back to demo,
-- a database that held demo data never goes live, the "seeded" mark is never cleared, and the row is never removed.
CREATE OR REPLACE FUNCTION instance_settings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.mode = 'production' AND NEW.mode <> 'production' THEN
      RAISE EXCEPTION 'instance_settings: a production database cannot change mode';
    END IF;
    IF OLD.seeded_at IS NOT NULL AND NEW.seeded_at IS NULL THEN
      RAISE EXCEPTION 'instance_settings: the demo-data mark cannot be cleared';
    END IF;
    IF NEW.mode = 'production' AND NEW.seeded_at IS NOT NULL THEN
      RAISE EXCEPTION 'instance_settings: a database that held demo data cannot go live';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'instance_settings: the instance record cannot be removed';
END $$;
--> statement-breakpoint
CREATE TRIGGER instance_settings_no_regress BEFORE UPDATE OR DELETE ON instance_settings
  FOR EACH ROW EXECUTE FUNCTION instance_settings_guard();
--> statement-breakpoint
CREATE TRIGGER instance_settings_no_truncate BEFORE TRUNCATE ON instance_settings
  FOR EACH STATEMENT EXECUTE FUNCTION instance_settings_guard();
