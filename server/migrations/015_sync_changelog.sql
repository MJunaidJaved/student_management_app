-- 015_sync_changelog.sql
--
-- Local-first operation with a cloud mirror.
--
-- The app runs against a local Postgres (fast, and unaffected by the slow,
-- flaky link to the cloud database). Every row change is captured here, in the
-- same transaction as the change itself, and a background worker
-- (src/core/sync/cloud-sync.ts) replays the captured changes onto the cloud
-- database in order. Because capture is transactional, nothing that commits
-- locally can be missed, and nothing that rolls back is ever sent.
--
-- Capture stores whole row images rather than diffs, so replaying a change is
-- an idempotent upsert/delete: a batch that is applied twice (a crash between
-- the cloud commit and the local cleanup) leaves the cloud unchanged.
--
-- `txid` lets the worker take only rows from transactions that have finished
-- (txid < xmin of its snapshot). Taking rows by id alone would skip a change
-- from a long transaction that commits after a later-numbered one was sent.
--
-- The worker replays with session_replication_role = replica, so neither these
-- capture triggers nor the audit/updated_at triggers fire on the cloud copy:
-- the cloud receives exactly the rows the local database holds.
--
-- New tables added by later migrations must call `SELECT sync_install_triggers();`
-- at the end; the worker refuses to run if any table is missing capture.

-- Up Migration

CREATE TABLE sync_changelog (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  txid       xid8        NOT NULL DEFAULT pg_current_xact_id(),
  table_name text        NOT NULL,
  op         char(1)     NOT NULL,
  row_data   jsonb,
  old_data   jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_changelog_op_check CHECK (op IN ('I', 'U', 'D', 'T'))
);

CREATE INDEX sync_changelog_txid_idx ON sync_changelog (txid, id);

COMMENT ON TABLE sync_changelog IS
  'Row changes awaiting replication to the cloud mirror. Drained by src/core/sync/cloud-sync.ts.';

CREATE OR REPLACE FUNCTION sync_capture() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO sync_changelog (table_name, op, row_data) VALUES (TG_TABLE_NAME, 'I', to_jsonb(NEW));
  ELSIF TG_OP = 'UPDATE' THEN
    -- A no-op update has nothing to replicate.
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    INSERT INTO sync_changelog (table_name, op, row_data, old_data) VALUES (TG_TABLE_NAME, 'U', to_jsonb(NEW), to_jsonb(OLD));
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO sync_changelog (table_name, op, old_data) VALUES (TG_TABLE_NAME, 'D', to_jsonb(OLD));
  ELSIF TG_OP = 'TRUNCATE' THEN
    INSERT INTO sync_changelog (table_name, op) VALUES (TG_TABLE_NAME, 'T');
  END IF;
  RETURN NULL;
END;
$$;

-- (Re)installs capture on every public table. Idempotent; later migrations call it.
CREATE OR REPLACE FUNCTION sync_install_triggers() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname NOT IN ('sync_changelog', 'pgmigrations')
  LOOP
    -- "zz_" so it runs after the other AFTER triggers on the table.
    EXECUTE format('DROP TRIGGER IF EXISTS zz_sync_capture_row ON public.%I', r.relname);
    EXECUTE format(
      'CREATE TRIGGER zz_sync_capture_row AFTER INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION sync_capture()', r.relname);
    EXECUTE format('DROP TRIGGER IF EXISTS zz_sync_capture_truncate ON public.%I', r.relname);
    EXECUTE format(
      'CREATE TRIGGER zz_sync_capture_truncate AFTER TRUNCATE ON public.%I
         FOR EACH STATEMENT EXECUTE FUNCTION sync_capture()', r.relname);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

SELECT sync_install_triggers();

-- Down Migration

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS zz_sync_capture_row ON public.%I', r.relname);
    EXECUTE format('DROP TRIGGER IF EXISTS zz_sync_capture_truncate ON public.%I', r.relname);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS sync_install_triggers();
DROP FUNCTION IF EXISTS sync_capture();
DROP TABLE IF EXISTS sync_changelog;
