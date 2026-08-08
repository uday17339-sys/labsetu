#!/usr/bin/env node
/**
 * Prepares a Neon database for a LabSetu test deployment, and prints the
 * environment variables to paste into Vercel.
 *
 * What it does, in order:
 *   1. creates the runtime role `labsetu_app` with NOBYPASSRLS
 *   2. applies migrations (needs the DIRECT, unpooled endpoint)
 *   3. applies RLS policies and the append-only grants
 *   4. seeds the tenant, catalog, inventory and — optionally — pharma data
 *   5. prints the exact env vars for the API and web Vercel projects
 *
 * Usage:
 *   node scripts/setup-neon.mjs "postgresql://neondb_owner:...@ep-xxx.aws.neon.tech/neondb"
 *   node scripts/setup-neon.mjs "<url>" --with-pharma
 *   node scripts/setup-neon.mjs "<url>" --skip-seed
 *
 * Pass the DIRECT connection string, not the pooled one. Migrations create
 * types and run DDL, which PgBouncer in transaction mode cannot carry.
 */
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';

const ADMIN_URL = process.argv[2];
const WITH_PHARMA = process.argv.includes('--with-pharma');
const SKIP_SEED = process.argv.includes('--skip-seed');

if (!ADMIN_URL || !ADMIN_URL.startsWith('postgres')) {
  console.error(`
Usage: node scripts/setup-neon.mjs "<neon-direct-connection-string>" [--with-pharma] [--skip-seed]

Get the string from the Neon console → Connection Details → choose "Direct
connection" (NOT "Pooled connection"). It looks like:

  postgresql://neondb_owner:npg_xxxx@ep-cool-name-123456.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
`);
  process.exit(1);
}

if (ADMIN_URL.includes('-pooler.')) {
  console.error(
    '\nThat is the POOLED endpoint. Migrations need the direct one — remove "-pooler" from the host.\n',
  );
  process.exit(1);
}

const step = (n, msg) => console.log(`\n\x1b[1m${n}. ${msg}\x1b[0m`);
const ok = (msg) => console.log(`   \x1b[32m✓\x1b[0m ${msg}`);
const warn = (msg) => console.log(`   \x1b[33m!\x1b[0m ${msg}`);

/** base64 is fine for a secret; it never goes into a URL. */
const secret = (bytes = 32) => randomBytes(bytes).toString('base64');

// A password that survives being embedded in a connection string: no +, / or =
// to percent-encode, and nothing a shell will treat as special.
const urlSafePassword = () => randomBytes(24).toString('base64url');

const APP_PASSWORD = urlSafePassword();

const url = new URL(ADMIN_URL);
const directHost = url.hostname;
const pooledHost = directHost.replace(/^(ep-[^.]+)\./, '$1-pooler.');
const dbName = url.pathname.replace(/^\//, '') || 'neondb';

const appDirect = `postgresql://labsetu_app:${APP_PASSWORD}@${directHost}/${dbName}?sslmode=require`;
const appPooled =
  `postgresql://labsetu_app:${APP_PASSWORD}@${pooledHost}/${dbName}` +
  `?sslmode=require&pgbouncer=true&connection_limit=1`;

// ---------------------------------------------------------------------------

console.log('\n\x1b[1mLabSetu — Neon setup\x1b[0m');
console.log(`   host      ${directHost}`);
console.log(`   database  ${dbName}`);

if (!/ap-south|ap-southeast/.test(directHost)) {
  warn(
    'This Neon project is not in an Asia-Pacific region. Fine for testing with synthetic\n' +
      '     data; NOT compliant for real Indian patient data (DPDP residency).',
  );
}

step(1, 'Creating the runtime role');

const client = new pg.Client({ connectionString: ADMIN_URL });
await client.connect();

try {
  const { rows } = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'labsetu_app'`);
  if (rows.length > 0) {
    await client.query(`ALTER ROLE labsetu_app WITH PASSWORD '${APP_PASSWORD}'`);
    ok('labsetu_app already existed — password rotated');
  } else {
    // NOBYPASSRLS is the whole point. apply-security.mjs asserts it and refuses
    // to continue otherwise: a role that can bypass RLS makes tenant isolation
    // decorative rather than enforced.
    await client.query(
      `CREATE ROLE labsetu_app WITH LOGIN PASSWORD '${APP_PASSWORD}' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
    ok('labsetu_app created (NOBYPASSRLS, NOSUPERUSER)');
  }

  await client.query(`GRANT CONNECT ON DATABASE "${dbName}" TO labsetu_app`);
  await client.query(`GRANT USAGE ON SCHEMA public TO labsetu_app`);
  ok('connect and schema usage granted');
} finally {
  await client.end();
}

// ---------------------------------------------------------------------------
step(2, 'Applying migrations');

const env = {
  ...process.env,
  DATABASE_URL: appDirect,
  DATABASE_ADMIN_URL: ADMIN_URL,
};

const run = (cmd, extraEnv = {}) =>
  execSync(cmd, { stdio: 'inherit', env: { ...env, ...extraEnv }, cwd: process.cwd() });

run('npx prisma migrate deploy --schema packages/db/prisma/schema.prisma');
ok('schema applied');

// ---------------------------------------------------------------------------
step(3, 'Applying RLS and the append-only grants');

run('node packages/db/scripts/apply-security.mjs');
ok('row-level security enabled and forced on every tenant table');

// ---------------------------------------------------------------------------
const MASTER_KEY = secret(32);
const BLIND_KEY = secret(32);
const JWT = secret(48);

// WRITTEN BEFORE SEEDING, deliberately.
//
// The seed encrypts patient identifiers with MASTER_KEY. If these files were
// written at the end and any later step failed, the keys would exist only in a
// dead process while the encrypted rows sat in the database — unrecoverable,
// with no error message pointing at the cause. Persist first, then use them.
writeEnvFiles();

if (!SKIP_SEED) {
  step(4, 'Seeding');

  const seedEnv = {
    ENCRYPTION_PROVIDER: 'local',
    ENCRYPTION_MASTER_KEY: MASTER_KEY,
    ENCRYPTION_LOCAL_ACK: 'i-understand-the-master-key-is-in-the-environment',
    BLIND_INDEX_KEY: BLIND_KEY,
  };

  try {
    run('npx tsx packages/db/prisma/seed.ts', seedEnv);
    ok('tenant, roles, catalog and demo patients');
  } catch {
    warn('base seed failed — it is first-run-only and errors if the tenant exists. Continuing.');
  }

  run('node packages/db/scripts/sync-roles.mjs', seedEnv);
  ok('roles reconciled with the permission registry');

  try {
    run('node packages/db/scripts/seed-inventory.mjs', seedEnv);
    ok('reagent inventory');
  } catch {
    warn('inventory seed skipped');
  }

  if (WITH_PHARMA) {
    run('node packages/db/scripts/seed-pharma.mjs', seedEnv);
    ok('materials, specifications, manufacturing staff and a quarantined consignment');
  }
} else {
  step(4, 'Seeding skipped (--skip-seed)');
  warn('Keys below are still newly generated. If the database already holds encrypted');
  warn('data, you MUST reuse the original keys instead — these will not decrypt it.');
}

// ---------------------------------------------------------------------------
step(5, 'Environment for Vercel');

ok('wrote .env.vercel.api and .env.vercel.web');

function writeEnvFiles() {
  const apiEnv = `# ---------------------------------------------------------------------------
# LabSetu API  —  Vercel project environment
#
# POOLED url at runtime: every warm function instance opens its own connection,
# and Neon's pooler (PgBouncer, transaction mode) is what stops that exhausting
# max_connections. It suits this codebase exactly — RLS is applied with
# set_config(..., true), scoped to the transaction, so it is discarded when the
# connection returns to the pool.
DATABASE_URL=${appPooled}

# DIRECT url for migrations only. PgBouncer in transaction mode cannot run DDL.
DATABASE_ADMIN_URL=${ADMIN_URL}

NODE_ENV=production
DATA_RESIDENCY_REGION=ap-south-1
ALLOWED_RESIDENCY_REGIONS=ap-south-1,ap-south-2,ap-southeast-1

# Set this to your web deployment's URL once it exists, then redeploy the API.
CORS_ORIGINS=https://CHANGE-ME.vercel.app

JWT_SECRET=${JWT}
BLIND_INDEX_KEY=${BLIND_KEY}

# Test deployment only. Production uses ENCRYPTION_PROVIDER=kms so the master
# key never sits in an environment variable.
ENCRYPTION_PROVIDER=local
ENCRYPTION_MASTER_KEY=${MASTER_KEY}
ENCRYPTION_LOCAL_ACK=i-understand-the-master-key-is-in-the-environment
`;

  const webEnv = `# ---------------------------------------------------------------------------
# LabSetu web  —  Vercel project environment
#
# Read at RUNTIME, deliberately not a NEXT_PUBLIC_* variable: those are inlined
# into the bundle at build time and cannot be changed afterwards. Every API call
# in the web app is server-side, so the browser never sees this host or a token.
API_INTERNAL_URL=https://CHANGE-ME-api.vercel.app
NODE_ENV=production
`;

  writeFileSync('.env.vercel.api', apiEnv);
  writeFileSync('.env.vercel.web', webEnv);
}

console.log(`
\x1b[1mNext\x1b[0m

  1. Create the API project on Vercel with Root Directory = apps/api
     Paste the contents of .env.vercel.api into its environment variables.

  2. Create the web project with Root Directory = apps/web
     Set API_INTERNAL_URL to the API deployment's URL.

  3. Set CORS_ORIGINS on the API to the web deployment's URL, then redeploy it.

  4. Verify:  npm run verify https://<your-web>.vercel.app

\x1b[1m\x1b[33mKeep these two files.\x1b[0m ENCRYPTION_MASTER_KEY and BLIND_INDEX_KEY cannot be
recovered. Lose them and every encrypted patient identifier is unreadable —
a database backup will not help you. Both files are gitignored.

Demo sign-in:  tenant SUNRISE  ·  admin@sunrise.test  ·  LabSetu@2026
`);
