#!/usr/bin/env node
/**
 * Creates .env from .env.example, replacing every CHANGE_ME placeholder with a
 * freshly generated 32-byte secret.
 *
 * Existing .env files are left alone — regenerating ENCRYPTION_MASTER_KEY or
 * BLIND_INDEX_KEY would make every encrypted patient record permanently
 * unreadable and every blind index unmatchable. That is a one-way door, so it
 * requires deleting .env deliberately rather than happening as a side effect.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const examplePath = resolve(repoRoot, '.env.example');
const envPath = resolve(repoRoot, '.env');

if (existsSync(envPath)) {
  const current = readFileSync(envPath, 'utf8');
  const placeholders = [...current.matchAll(/^(\w+)=CHANGE_ME\S*/gm)].map((m) => m[1]);

  if (placeholders.length === 0) {
    console.log('  .env already exists and has no placeholders — leaving it untouched.');
    process.exit(0);
  }

  let patched = current;
  for (const key of placeholders) {
    patched = patched.replace(
      new RegExp(`^${key}=CHANGE_ME\\S*`, 'm'),
      `${key}=${randomBytes(32).toString('base64')}`,
    );
  }
  writeFileSync(envPath, patched);
  console.log(`  Filled ${placeholders.length} placeholder secret(s) in the existing .env:`);
  for (const k of placeholders) console.log(`    - ${k}`);
  process.exit(0);
}

const template = readFileSync(examplePath, 'utf8');
const generated = [];
const output = template.replace(/^(\w+)=CHANGE_ME\S*/gm, (_m, key) => {
  generated.push(key);
  return `${key}=${randomBytes(32).toString('base64')}`;
});

writeFileSync(envPath, output);
console.log('  Created .env with generated development secrets:');
for (const k of generated) console.log(`    - ${k}`);
console.log(
  '\n  These are DEVELOPMENT secrets. Production uses AWS Secrets Manager and KMS;\n' +
    '  see docs/SECURITY.md §8.\n',
);
