#!/usr/bin/env node
/**
 * Generates .env.production with strong, unique secrets.
 *
 * Never regenerates an existing file: rotating ENCRYPTION_MASTER_KEY or
 * BLIND_INDEX_KEY on a live database makes every encrypted patient identifier
 * permanently unreadable and every blind index unmatchable. That is a one-way
 * door, so it requires deleting the file deliberately.
 *
 * Usage:
 *   node scripts/setup-prod-env.mjs [publicHost]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(repoRoot, '.env.production');
const publicHost = process.argv[2] ?? 'localhost';

if (existsSync(target)) {
  console.error(
    '\n  .env.production already exists — refusing to overwrite.\n\n' +
      '  Regenerating the encryption keys would permanently destroy access to every\n' +
      '  encrypted patient identifier already in the database. If you are certain\n' +
      '  this deployment has no data worth keeping, delete the file first.\n',
  );
  process.exit(1);
}

/** URL-safe: these end up inside connection strings. */
const secret = (bytes = 32) =>
  randomBytes(bytes).toString('base64').replace(/[+/=]/g, '').slice(0, Math.ceil(bytes * 1.3));

/** Base64, exactly 32 bytes — required by AES-256 and the HMAC index key. */
const key = () => randomBytes(32).toString('base64');

const values = {
  PUBLIC_HOST: publicHost,
  LOG_LEVEL: 'info',
  DATA_RESIDENCY_REGION: 'ap-south-1',
  ALLOWED_RESIDENCY_REGIONS: 'ap-south-1,ap-south-2',

  POSTGRES_USER: 'labsetu',
  POSTGRES_DB: 'labsetu',
  POSTGRES_PASSWORD: secret(),

  REDIS_PASSWORD: secret(),

  S3_ACCESS_KEY_ID: 'labsetu',
  S3_SECRET_ACCESS_KEY: secret(),

  JWT_SECRET: key(),
  BLIND_INDEX_KEY: key(),

  ENCRYPTION_PROVIDER: 'local',
  ENCRYPTION_MASTER_KEY: key(),
  ENCRYPTION_LOCAL_ACK: 'i-understand-the-master-key-is-in-the-environment',
  KMS_KEY_ID: '',

  RATE_LIMIT_MAX: '120',
  AUTH_RATE_LIMIT_MAX: '10',
};

// The app role's password is fixed by packages/db/docker/init/01-create-app-role.sql,
// which runs on first database initialisation.
const APP_ROLE_PASSWORD = 'labsetu_app_dev_password';

values.DATABASE_URL =
  `postgresql://labsetu_app:${APP_ROLE_PASSWORD}@postgres:5432/${values.POSTGRES_DB}` +
  `?schema=public&connection_limit=20&pool_timeout=20`;
values.DATABASE_ADMIN_URL =
  `postgresql://${values.POSTGRES_USER}:${values.POSTGRES_PASSWORD}@postgres:5432/${values.POSTGRES_DB}?schema=public`;

const header = `# =============================================================================
# LabSetu production environment — GENERATED ${new Date().toISOString()}
#
# Contains live secrets. Never commit. Restrict file permissions.
#
# Deploy:
#   docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
# =============================================================================\n\n`;

writeFileSync(
  target,
  header + Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n',
  { mode: 0o600 },
);

console.log(`\n  Created .env.production (mode 0600)\n`);
console.log(`    PUBLIC_HOST        ${publicHost}`);
console.log(`    secrets generated  7 unique values\n`);
console.log('  Next:');
console.log('    docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build\n');
console.log('  Before real patient data:');
console.log('    - switch ENCRYPTION_PROVIDER to kms and set KMS_KEY_ID');
console.log('    - point PUBLIC_HOST at a real domain so Caddy issues TLS');
console.log('    - change the labsetu_app database password from its default\n');
