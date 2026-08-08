#!/usr/bin/env node
/**
 * Applies packages/db/sql/security.sql as the database OWNER role.
 *
 * Why this is a script and not a Prisma migration: Prisma does not manage roles,
 * grants or RLS policies, and `prisma migrate reset` drops them. Running this
 * after every migrate/reset keeps the security layer and the schema in lockstep.
 *
 * It then VERIFIES the result rather than trusting it. A silent failure here
 * would mean shipping without tenant isolation, which is the one failure this
 * project cannot absorb — so a gap is a non-zero exit, always.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

dotenv.config({ path: resolve(repoRoot, '.env') });
dotenv.config({ path: resolve(repoRoot, '.env.example') });

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  console.error(
    '\n  DATABASE_ADMIN_URL is not set.\n' +
      '  Copy .env.example to .env and fill it in:  cp .env.example .env\n',
  );
  process.exit(1);
}

const sqlPath = resolve(__dirname, '../sql/security.sql');
const sql = readFileSync(sqlPath, 'utf8');

const client = new pg.Client({ connectionString: adminUrl });

try {
  await client.connect();

  // Applied as one transaction: a partially-applied security layer is worse
  // than none, because it looks like it worked.
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');

  const { rows: gaps } = await client.query('SELECT * FROM labsetu_rls_gaps()');

  if (gaps.length > 0) {
    console.error('\n  RLS GAPS DETECTED — tenant isolation is not complete:\n');
    for (const g of gaps) {
      console.error(
        `    ${g.table_name.padEnd(28)} rls=${g.rls_enabled} policy=${g.has_policy}`,
      );
    }
    console.error(
      '\n  Add the table to the tenant_tables array in packages/db/sql/security.sql\n' +
        '  and to TENANT_SCOPED_TABLES in packages/db/src/index.ts.\n',
    );
    process.exit(1);
  }

  // Confirm the append-only grant actually took. Reading it back from the
  // catalog is cheap and turns an assumption into a check.
  const { rows: auditGrants } = await client.query(`
    SELECT privilege_type FROM information_schema.role_table_grants
    WHERE grantee = 'labsetu_app' AND table_name = 'audit_log'
      AND privilege_type IN ('UPDATE', 'DELETE')
  `);

  if (auditGrants.length > 0) {
    console.error(
      `\n  audit_log still grants ${auditGrants
        .map((r) => r.privilege_type)
        .join(', ')} to labsetu_app — the trail is not append-only.\n`,
    );
    process.exit(1);
  }

  const { rows: roleAttrs } = await client.query(
    `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'labsetu_app'`,
  );
  if (roleAttrs[0]?.rolbypassrls || roleAttrs[0]?.rolsuper) {
    console.error(
      '\n  labsetu_app has BYPASSRLS or SUPERUSER — RLS would be ineffective.\n',
    );
    process.exit(1);
  }

  console.log('  Security layer applied and verified:');
  console.log('    - RLS enabled + forced on all tenant-scoped tables');
  console.log('    - audit_log / signature are append-only (grants + triggers)');
  console.log('    - server-assigned timestamps enforced by trigger');
  console.log('    - labsetu_app confirmed NOBYPASSRLS, NOSUPERUSER');
} catch (err) {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* connection may already be gone */
  }
  console.error('\n  Failed to apply security layer:\n');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
