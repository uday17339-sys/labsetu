#!/usr/bin/env node
/**
 * Runs every verification suite in sequence.
 *
 * Paces itself between suites because each signs in several times and the auth
 * endpoint is rate-limited to 10 attempts per minute per IP. Running them
 * back-to-back trips the limiter — which is the limiter working correctly, but
 * makes the results unreadable.
 *
 * Usage:
 *   node scripts/verify-all.mjs                          # local dev
 *   node scripts/verify-all.mjs https://localhost        # production stack
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const base = process.argv[2] ?? '';
const isProd = base.startsWith('https');

const WEB = base || 'http://localhost:3100';
const API = base ? `${base}/api` : 'http://localhost:4000';

// Local production runs use Caddy's self-signed certificate for `localhost`.
const env = { ...process.env };
if (isProd && WEB.includes('localhost')) env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SUITES = [
  { name: 'Batch workflow + compliance', cmd: ['node', 'scripts/smoke-test.mjs', API], signsIn: true },
  { name: 'Gateway → API (instruments)', cmd: ['node', 'scripts/gateway-e2e.mjs', API], signsIn: true },
  { name: 'ASTM / HL7 parsers', cmd: ['npx', 'tsx', 'apps/gateway/src/parsers/parsers.verify.ts'], signsIn: false },
  { name: 'Quality control + the QC gate', cmd: ['node', 'scripts/qc-verify.mjs', API], signsIn: true },
  { name: 'Consumables, lot traceability, CSV export', cmd: ['node', 'scripts/features-verify.mjs', API], signsIn: true },
  { name: 'Stores control, admin, competency, OOS', cmd: ['node', 'scripts/admin-verify.mjs', API], signsIn: true },
  { name: 'Manufacturing QC — stores, spec, QA release', cmd: ['node', 'scripts/pharma-verify.mjs', API], signsIn: true },
  { name: 'QA Manager walkthrough', cmd: ['node', 'scripts/owner-walkthrough.mjs', API, WEB], signsIn: true },
  { name: 'Web UI, session, PWA, headers', cmd: ['node', 'scripts/ui-verify.mjs', WEB, API], signsIn: true },
  { name: 'Visual — real Chromium, 4 viewports', cmd: ['node', 'scripts/visual-verify.mjs', WEB, API], signsIn: true },
  { name: 'Responsive — 320px, landscape, 200% zoom, print', cmd: ['node', 'scripts/responsive-audit.mjs', WEB, API], signsIn: true },
];

const RATE_LIMIT_PAUSE_MS = 65_000;

function run(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { env, shell: process.platform === 'win32' });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => resolve({ code, output }));
  });
}

const results = [];

console.log(`\n\x1b[1mLabSetu — full verification\x1b[0m`);
console.log(`  web ${WEB}`);
console.log(`  api ${API}\n`);

for (const [i, suite] of SUITES.entries()) {
  process.stdout.write(`  ${String(i + 1).padStart(2)}. ${suite.name.padEnd(38)}`);

  const { code, output } = await run(suite.cmd);
  const tally = output.match(/(\d+) passed, (\d+) failed/g)?.pop() ?? 'no result';
  const rateLimited = output.includes('Too Many Requests');

  if (rateLimited) {
    process.stdout.write(`\x1b[33mrate limited — retrying\x1b[0m\n`);
    await sleep(RATE_LIMIT_PAUSE_MS);
    process.stdout.write(`      ${suite.name.padEnd(38)}`);
    const retry = await run(suite.cmd);
    const retryTally = retry.output.match(/(\d+) passed, (\d+) failed/g)?.pop() ?? 'no result';
    results.push({ name: suite.name, code: retry.code, tally: retryTally, output: retry.output });
    process.stdout.write(
      retry.code === 0 ? `\x1b[32m${retryTally}\x1b[0m\n` : `\x1b[31m${retryTally}\x1b[0m\n`,
    );
  } else {
    results.push({ name: suite.name, code, tally, output });
    process.stdout.write(code === 0 ? `\x1b[32m${tally}\x1b[0m\n` : `\x1b[31m${tally}\x1b[0m\n`);
  }

  // Let the auth rate-limit window drain before the next suite signs in.
  if (suite.signsIn && i < SUITES.length - 1) {
    await sleep(RATE_LIMIT_PAUSE_MS);
  }
}

const failed = results.filter((r) => r.code !== 0);
const total = results.reduce((sum, r) => {
  const m = /(\d+) passed/.exec(r.tally);
  return sum + (m ? Number(m[1]) : 0);
}, 0);

console.log(`\n  \x1b[1m${total} checks passed across ${SUITES.length} suites\x1b[0m`);

if (failed.length > 0) {
  console.log(`\n\x1b[31m  ${failed.length} suite(s) failed:\x1b[0m\n`);
  for (const f of failed) {
    console.log(`  ── ${f.name} ──`);
    console.log(
      f.output
        .split('\n')
        .filter((l) => l.includes('FAIL') || l.includes('Aborted'))
        .slice(0, 8)
        .join('\n'),
    );
    console.log();
  }
  process.exit(1);
}

console.log();
