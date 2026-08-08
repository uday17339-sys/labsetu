-- Reconciles seeded SYSTEM roles with the current DEFAULT_ROLES registry.
-- Generated from packages/contracts. Custom (non-system) roles are untouched.
WITH target(code, permissions) AS (VALUES
  ('LAB_ADMIN', ARRAY['patient:read','patient:create','patient:update','patient:read_pii','patient:erase','order:read','order:create','order:update','order:cancel','sample:read','sample:create','sample:collect','sample:receive','sample:reject','result:read','result:enter','result:verify','result:authorize','result:amend','result:rerun','result:callback','report:read','report:generate','report:release','report:amend','report:deliver','catalog:read','catalog:manage','qc:read','qc:enter','qc:override','qc:manage','device:read','device:manage','device:enrol','ingest:resolve','inventory:read','inventory:manage','inventory:consume','invoice:read','invoice:create','invoice:cancel','payment:record','user:read','user:manage','role:manage','competency:manage','lab:manage','policy:manage','analytics:read','audit:read','audit:verify','compliance:export']::text[]),
  ('PATHOLOGIST', ARRAY['patient:read','patient:read_pii','order:read','sample:read','result:read','result:enter','result:verify','result:authorize','result:amend','result:rerun','result:callback','report:read','report:generate','report:release','report:amend','report:deliver','catalog:read','qc:read','qc:enter','qc:override','qc:manage','device:read','audit:read','inventory:read','competency:manage','user:read','catalog:manage']::text[]),
  ('LAB_TECHNICIAN', ARRAY['patient:read','order:read','sample:read','sample:collect','sample:receive','sample:reject','result:read','result:enter','result:verify','result:rerun','result:callback','catalog:read','qc:read','qc:enter','device:read','ingest:resolve','report:read','inventory:read','inventory:consume']::text[]),
  ('PHLEBOTOMIST', ARRAY['patient:read','patient:read_pii','order:read','sample:read','sample:create','sample:collect','catalog:read']::text[]),
  ('RECEPTIONIST', ARRAY['patient:read','patient:read_pii','patient:create','patient:update','order:read','order:create','order:update','sample:read','sample:create','catalog:read','invoice:read','invoice:create','payment:record','report:read','report:deliver']::text[]),
  ('ACCOUNTANT', ARRAY['patient:read','order:read','invoice:read','invoice:create','invoice:cancel','payment:record','catalog:read','analytics:read']::text[]),
  ('AUDITOR', ARRAY['patient:read','order:read','sample:read','result:read','report:read','catalog:read','qc:read','device:read','invoice:read','user:read','inventory:read','analytics:read','audit:read','audit:verify','compliance:export']::text[])
)
UPDATE role r
SET permissions = t.permissions, "updatedAt" = now()
FROM target t
WHERE r.code = t.code
  AND r."isSystem" = true
  AND r.permissions IS DISTINCT FROM t.permissions
RETURNING r."tenantId", r.code, cardinality(r.permissions) AS permission_count;
