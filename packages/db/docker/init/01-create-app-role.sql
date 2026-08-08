-- =============================================================================
-- Runs once, on first initialisation of the Postgres volume.
--
-- Creates the runtime application role. It deliberately has NO superuser, NO
-- CREATEDB, and critically NO BYPASSRLS — tenant isolation (ADR 0002) depends on
-- the application being unable to see past a row level security policy.
--
-- Table grants and the RLS policies themselves live in sql/security.sql, which
-- is re-applied after every migration (policies do not survive a migrate reset).
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labsetu_app') THEN
    CREATE ROLE labsetu_app WITH LOGIN PASSWORD 'labsetu_app_dev_password'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE labsetu TO labsetu_app;
GRANT USAGE ON SCHEMA public TO labsetu_app;

-- Extensions used by the schema.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";
