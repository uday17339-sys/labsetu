-- =============================================================================
-- LabSetu — database security layer
--
-- Applied by scripts/apply-security.mjs after every migration, as the OWNER
-- role. Idempotent: safe to run repeatedly.
--
-- Prisma does not manage grants, roles or RLS policies, and `prisma migrate
-- reset` drops them. Keeping them in one reviewable file — rather than scattered
-- through generated migrations — is also what lets a regulatory assessor read
-- the isolation model in a single sitting.
--
-- Three things happen here:
--   1. The runtime role gets least-privilege grants.
--   2. audit_log becomes append-only at the database level (ADR 0003).
--   3. Row Level Security is enabled and forced on every tenant-owned table
--      (ADR 0002).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Role
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labsetu_app') THEN
    CREATE ROLE labsetu_app WITH LOGIN PASSWORD 'labsetu_app_dev_password'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- Defence in depth: if someone later grants this role elevated attributes by
-- mistake, strip them here on every apply.
--
-- Conditional, and tolerant of a permission error, because managed Postgres
-- does not give you a superuser. On Neon, RDS or Cloud SQL the admin role holds
-- CREATEROLE but not BYPASSRLS, and PostgreSQL 16+ refuses to let a role alter
-- an attribute it does not itself have — so an unconditional ALTER fails with
-- "permission denied to alter role" even though nothing is wrong.
--
-- This is safe to skip precisely because it is belt-and-braces: the real
-- control is the assertion in apply-security.mjs, which reads pg_roles after
-- this file has run and REFUSES to continue if labsetu_app can bypass RLS.
-- Weakening the fix-up does not weaken the guarantee.
DO $$
DECLARE
  needs_fixing boolean;
BEGIN
  SELECT rolbypassrls OR rolsuper OR rolcreatedb OR rolcreaterole
    INTO needs_fixing
    FROM pg_roles WHERE rolname = 'labsetu_app';

  IF needs_fixing THEN
    BEGIN
      ALTER ROLE labsetu_app NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
      RAISE NOTICE 'labsetu_app had elevated attributes; stripped them';
    EXCEPTION WHEN insufficient_privilege THEN
      -- Cannot fix it from here. Do not pretend otherwise — the assertion that
      -- follows will stop the deploy if it actually matters.
      RAISE WARNING
        'labsetu_app has elevated attributes and this connection cannot strip them. '
        'Fix it with a superuser, or recreate the role: '
        'ALTER ROLE labsetu_app NOBYPASSRLS NOSUPERUSER;';
    END;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO labsetu_app;

-- -----------------------------------------------------------------------------
-- 1. Baseline grants
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO labsetu_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO labsetu_app;

-- Future tables created by later migrations inherit the same grants, so a new
-- table is never accidentally unreachable (or, worse, ungoverned).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO labsetu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO labsetu_app;

-- -----------------------------------------------------------------------------
-- 2. Append-only audit trail  (ADR 0003, guarantee #1)
--
-- The application CANNOT update or delete an audit entry. This is a database
-- grant, not a code convention — the distinction is the entire point, and it is
-- the first thing an assessor should be shown.
-- -----------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_log FROM labsetu_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE signature FROM labsetu_app;

-- A QA batch disposition is a signed regulatory act with the same standing as
-- the signature itself: it is what an inspector points at to ask "who released
-- this material, and on what basis". Changing one's mind means recording a NEW
-- disposition, so the history shows the reversal rather than concealing it.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE batch_disposition FROM labsetu_app;

-- Likewise a certificate of analysis: it is issued to a customer. A superseding
-- version is issued; the original is never rewritten.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE certificate_of_analysis FROM labsetu_app;

-- audit_chain_head is intentionally updatable: it is the lock target that
-- serialises chain appends, and holds no historical record itself.

-- Belt and braces — a trigger that refuses the operation even if a future
-- migration re-grants the privilege by accident.
CREATE OR REPLACE FUNCTION labsetu_deny_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only: % is not permitted (LabSetu ADR 0003)',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log;
CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION labsetu_deny_mutation();

DROP TRIGGER IF EXISTS signature_immutable ON signature;
CREATE TRIGGER signature_immutable
  BEFORE UPDATE OR DELETE ON signature
  FOR EACH ROW EXECUTE FUNCTION labsetu_deny_mutation();

-- occurred_at / signed_at are server-assigned and NOT application-writable.
-- This is the mechanism that makes backdating impossible rather than merely
-- discouraged (COMPLIANCE.md §2). A client-supplied value is silently replaced,
-- not trusted.
CREATE OR REPLACE FUNCTION labsetu_force_server_time() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'audit_log' THEN
    NEW."occurredAt" := now();
  ELSIF TG_TABLE_NAME = 'signature' THEN
    NEW."signedAt" := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_log_server_time ON audit_log;
CREATE TRIGGER audit_log_server_time
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION labsetu_force_server_time();

DROP TRIGGER IF EXISTS signature_server_time ON signature;
CREATE TRIGGER signature_server_time
  BEFORE INSERT ON signature
  FOR EACH ROW EXECUTE FUNCTION labsetu_force_server_time();

-- -----------------------------------------------------------------------------
-- 3. Row Level Security  (ADR 0002)
--
-- Failure mode is deliberately directed: with app.tenant_id unset,
-- current_setting(..., true) returns NULL, the predicate is NULL, and ZERO rows
-- are visible. The system fails closed — an empty result set, never a leak.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION labsetu_current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$;

DO $$
DECLARE
  tbl text;
  tenant_tables text[] := ARRAY[
    'lab', 'user', 'role', 'user_role', 'user_competency', 'refresh_token',
    'tenant_policy', 'audit_log', 'audit_chain_head', 'audit_verification',
    'signature', 'attachment', 'consent_record',
    'analyte', 'method', 'test_definition', 'test_analyte', 'panel',
    'panel_item', 'reference_range', 'specimen_type', 'container_type',
    'rejection_reason',
    'patient', 'referring_doctor', 'referring_organization', 'lab_order',
    'order_item', 'sample', 'sample_test', 'result', 'report', 'report_item',
    'report_delivery', 'invoice', 'invoice_item', 'payment',
    'qc_material', 'qc_lot', 'qc_lot_analyte', 'qc_result',
    'device', 'device_channel', 'instrument_message', 'ingest_exception',
    'accession_counter',
    'inventory_item', 'inventory_lot', 'stock_transaction', 'test_reagent_usage',
    -- Manufacturing QC (DATA_MODEL.md §9). A batch record is as
    -- tenant-confidential as a patient record: it names what a competitor
    -- makes, from whom they buy it, and what failed.
    'material', 'goods_receipt', 'material_batch', 'specification', 'spec_limit',
    'sampling_request', 'batch_disposition', 'oos_investigation',
    'certificate_of_analysis',
    -- Part 11 §11.300. Password history holds only hashes and cannot
    -- authenticate anyone, but it still says which accounts exist and how often
    -- they change credentials; access reviews name who audits whom. Both are
    -- tenant-confidential.
    'password_history', 'access_review',
    -- Quality system. A deviation names what went wrong on a named batch and a
    -- CAPA names who is accountable for fixing it; both are as
    -- tenant-confidential as the batch record they hang off.
    'deviation', 'capa_action', 'change_control',
    -- Stability data supports the expiry date printed on cartons already in the
    -- market. It names what a competitor makes and how it behaves over time.
    'stability_protocol', 'stability_study', 'stability_pull',
    -- Environmental monitoring names which rooms a site runs, to what grade,
    -- and how often they fail. Commercially sensitive and inspection-relevant
    -- in equal measure.
    'em_location', 'em_reading',
    -- Audit reviews name who examined what; retention samples and the approved
    -- vendor list are both commercially sensitive and inspection-relevant.
    'audit_review', 'retention_sample', 'vendor'
  ];
  tenant_col text;
BEGIN
  FOREACH tbl IN ARRAY tenant_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      RAISE WARNING 'RLS skipped: table % does not exist', tbl;
      CONTINUE;
    END IF;

    -- audit_chain_head is keyed by tenantId as its primary key.
    tenant_col := '"tenantId"';

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    -- FORCE applies the policy to the table owner too, so a migration-role
    -- connection cannot quietly read across tenants either.
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I
         USING (%s = labsetu_current_tenant())
         WITH CHECK (%s = labsetu_current_tenant())',
      tbl, tenant_col, tenant_col
    );
  END LOOP;
END
$$;

-- The tenant table itself is keyed on `id`, so it needs its own policy.
-- Provisioning a new tenant runs through the admin connection, which bypasses
-- this by setting app.tenant_id to the new tenant's id explicitly.
ALTER TABLE public.tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.tenant;
CREATE POLICY tenant_isolation ON public.tenant
  USING (id = labsetu_current_tenant())
  WITH CHECK (id = labsetu_current_tenant());

-- Prisma's migration bookkeeping must stay readable to the migration role only.
REVOKE ALL ON TABLE "_prisma_migrations" FROM labsetu_app;

-- -----------------------------------------------------------------------------
-- 3b. Bootstrap lookups  (SECURITY DEFINER)
--
-- RLS creates a genuine chicken-and-egg problem at the edges of the system: to
-- set app.tenant_id you need the tenant id, but at login all you have is a
-- tenant CODE; at token refresh, an opaque token; at gateway ingest, a device
-- key hash. Each must resolve to a tenant before any tenant context can exist.
--
-- These functions are the ONLY sanctioned way across that boundary. Each is
-- deliberately narrow: it takes an opaque credential, returns the minimum
-- needed to establish context, and exposes no patient data whatsoever. They are
-- SECURITY DEFINER (running as the owner, so RLS does not apply) with a pinned
-- search_path so they cannot be hijacked by a shadowed table name.
--
-- Adding a function here is a security decision and should be reviewed as one.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION labsetu_resolve_tenant(p_code text)
RETURNS TABLE(id uuid, code text, name text, status text)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.code, t.name, t.status::text
  FROM tenant t
  WHERE t.code = upper(trim(p_code));
$$;

CREATE OR REPLACE FUNCTION labsetu_resolve_refresh_token(p_token_hash text)
RETURNS TABLE(
  id uuid, tenant_id uuid, user_id uuid, family_id uuid,
  expires_at timestamptz, revoked_at timestamptz
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT r.id, r."tenantId", r."userId", r."familyId", r."expiresAt", r."revokedAt"
  FROM refresh_token r
  WHERE r."tokenHash" = p_token_hash;
$$;

CREATE OR REPLACE FUNCTION labsetu_resolve_device_by_key(p_key_hash text, p_device_id uuid)
RETURNS TABLE(
  id uuid, tenant_id uuid, lab_id uuid, code text,
  status text, is_shadow_mode boolean, device_secret_enc text
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT d.id, d."tenantId", d."labId", d.code, d.status::text,
         d."isShadowMode", d."deviceSecretEnc"
  FROM device d
  WHERE d."deviceKeyHash" = p_key_hash AND d.id = p_device_id;
$$;

CREATE OR REPLACE FUNCTION labsetu_resolve_device_by_enrolment(p_code text)
RETURNS TABLE(
  id uuid, tenant_id uuid, lab_id uuid, code text,
  status text, is_shadow_mode boolean, enrolment_expires_at timestamptz
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT d.id, d."tenantId", d."labId", d.code, d.status::text,
         d."isShadowMode", d."enrolmentCodeExpiresAt"
  FROM device d
  WHERE d."enrolmentCode" = upper(trim(p_code));
$$;

-- Platform operations that legitimately span tenants: role synchronisation
-- after a permission is added, the nightly audit-chain verifier, retention
-- sweeps. Returns ONLY the tenant id and code — no patient data, no
-- configuration, nothing that could be used to read across tenants. The caller
-- still has to set app.tenant_id to touch anything.
CREATE OR REPLACE FUNCTION labsetu_list_tenants()
RETURNS TABLE(id uuid, code text, status text)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.code, t.status::text FROM tenant t ORDER BY t.code;
$$;

-- Revoke the implicit PUBLIC execute grant, then grant only to the app role.
REVOKE ALL ON FUNCTION labsetu_list_tenants() FROM PUBLIC;
REVOKE ALL ON FUNCTION labsetu_resolve_tenant(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION labsetu_resolve_refresh_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION labsetu_resolve_device_by_key(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION labsetu_resolve_device_by_enrolment(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION labsetu_list_tenants() TO labsetu_app;
GRANT EXECUTE ON FUNCTION labsetu_resolve_tenant(text) TO labsetu_app;
GRANT EXECUTE ON FUNCTION labsetu_resolve_refresh_token(text) TO labsetu_app;
GRANT EXECUTE ON FUNCTION labsetu_resolve_device_by_key(text, uuid) TO labsetu_app;
GRANT EXECUTE ON FUNCTION labsetu_resolve_device_by_enrolment(text) TO labsetu_app;

-- -----------------------------------------------------------------------------
-- 4. Verification helper
--
-- Returns any tenant-scoped table that is missing RLS. Used by the automated
-- cross-tenant isolation test in CI — an untested isolation boundary is an
-- assumed one (SECURITY.md §10).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION labsetu_rls_gaps()
RETURNS TABLE(table_name text, rls_enabled boolean, has_policy boolean)
LANGUAGE sql STABLE AS $$
  SELECT c.relname::text,
         c.relrowsecurity,
         EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname <> '_prisma_migrations'
    -- Any table carrying tenant data: it either has a tenantId column, or it is
    -- the tenant table itself.
    AND (
      c.relname = 'tenant'
      OR EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public'
          AND col.table_name = c.relname
          AND col.column_name = 'tenantId'
      )
    )
    AND (c.relrowsecurity = false
         OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid));
$$;

GRANT EXECUTE ON FUNCTION labsetu_current_tenant() TO labsetu_app;
GRANT EXECUTE ON FUNCTION labsetu_rls_gaps() TO labsetu_app;
