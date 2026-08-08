export * from '@prisma/client';
export { PrismaClient, Prisma } from '@prisma/client';

/**
 * Tables that carry a `tenant_id` and are protected by PostgreSQL Row Level
 * Security. Kept here (rather than only in SQL) so tests can assert that every
 * tenant-scoped Prisma model actually has a policy — a missing policy is a
 * silent cross-tenant leak, so it is verified rather than assumed.
 *
 * Must stay in sync with packages/db/sql/security.sql.
 */
export const TENANT_SCOPED_TABLES = [
  'lab',
  'user',
  'role',
  'user_role',
  'user_competency',
  'refresh_token',
  'tenant_policy',
  'audit_log',
  'audit_chain_head',
  'audit_verification',
  'signature',
  'attachment',
  'consent_record',
  'analyte',
  'method',
  'test_definition',
  'test_analyte',
  'panel',
  'panel_item',
  'reference_range',
  'specimen_type',
  'container_type',
  'rejection_reason',
  'patient',
  'referring_doctor',
  'referring_organization',
  'lab_order',
  'order_item',
  'sample',
  'sample_test',
  'result',
  'report',
  'report_item',
  'report_delivery',
  'invoice',
  'invoice_item',
  'payment',
  'qc_material',
  'qc_lot',
  'qc_lot_analyte',
  'qc_result',
  'device',
  'device_channel',
  'instrument_message',
  'ingest_exception',
  'accession_counter',
  'inventory_item',
  'inventory_lot',
  'stock_transaction',
  'test_reagent_usage',
] as const;

export type TenantScopedTable = (typeof TENANT_SCOPED_TABLES)[number];
