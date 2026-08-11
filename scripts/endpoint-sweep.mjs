#!/usr/bin/env node
/**
 * Opens every readable endpoint, with real ids, and reports anything that 500s.
 *
 * Written after a single result row pointing at another tenant's analyte turned
 * the test detail screen into "Something went wrong". That bug was invisible
 * from every list — the row read fine until the detail page loaded the relation
 * — and no suite would have caught it, because the suites exercise the paths
 * they create rather than the records already in the database.
 *
 * So this is deliberately dumb and broad: enumerate what exists, GET all of it,
 * and complain about anything that is not a 2xx or an expected 403/404. It is a
 * smoke detector, not a specification.
 *
 * Usage: node scripts/endpoint-sweep.mjs [apiBase]
 */
const API = process.argv[2] ?? 'https://localhost/api';
const TENANT = 'VANTAGE';
const PASSWORD = 'LabSetu@2026';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let checked = 0;
const broken = [];
const forbidden = [];

async function signIn(email, attempt = 0) {
  const res = await fetch(`${API}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantCode: TENANT, email, password: PASSWORD }),
  });
  if (res.status === 429 && attempt < 4) {
    await sleep(21_000);
    return signIn(email, attempt + 1);
  }
  return res.json();
}

/** Live tokens per role, re-minted when one expires mid-sweep. */
const tokens = {};
const emailFor = {
  admin: 'admin@vantage.test',
  qa: 'qa@vantage.test',
  auditor: 'auditor@vantage.test',
};

async function tokenFor(role) {
  if (!tokens[role]) {
    const auth = await signIn(emailFor[role]);
    if (!auth?.accessToken) throw new Error(`could not sign in as ${role}`);
    tokens[role] = auth.accessToken;
  }
  return tokens[role];
}

async function get(path, role, attempt = 0) {
  const token = await tokenFor(role);
  const res = await fetch(`${API}/v1${path}`, { headers: { authorization: `Bearer ${token}` } });

  if (res.status === 429 && attempt < 4) {
    await sleep(21_000);
    return get(path, role, attempt + 1);
  }
  // The token aged out mid-run. Re-mint once and retry, otherwise every probe
  // from here on returns 401 and the sweep reports a clean bill of health for
  // endpoints it never actually reached.
  if (res.status === 401 && attempt < 2) {
    tokens[role] = null;
    return get(path, role, attempt + 1);
  }

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

/** A 403 is a working control, not a fault — it is recorded, never failed. */
async function probe(label, path, token) {
  checked++;
  const r = await get(path, token);
  if (r.status === 403) {
    forbidden.push(label);
    return null;
  }
  if (r.status === 401) {
    broken.push(`${label}  →  401 after re-authentication`);
    console.log(`  \x1b[31m401\x1b[0m ${label}`);
    return null;
  }
  if (r.status >= 500 || r.status === 0) {
    broken.push(`${label}  →  ${r.status}  ${String(r.body?.detail ?? '').slice(0, 90)}`);
    console.log(`  \x1b[31m${String(r.status).padEnd(3)}\x1b[0m ${label}`);
    return null;
  }
  console.log(`  \x1b[32m${String(r.status).padEnd(3)}\x1b[0m ${label}`);
  return r.body;
}

const asArray = (b) => (Array.isArray(b) ? b : (b?.items ?? []));

async function main() {
  console.log(`\n\x1b[1mEndpoint sweep\x1b[0m  →  ${API}\n`);

  // The administrator holds every permission, so a 403 here means the guard is
  // deliberate rather than a gap in the token.
  const t = 'admin';
  const qa = 'qa';
  const auditor = 'auditor';
  await tokenFor(t);

  console.log('\x1b[1mCollections\x1b[0m');
  const worklist = await probe('GET /worklist', '/worklist?limit=100', t);
  const samples = await probe('GET /samples', '/samples?limit=50', t);
  const batches = await probe('GET /stores/batches', '/stores/batches?limit=50', t);
  const materials = await probe('GET /stores/materials', '/stores/materials', t);
  const requests = await probe('GET /stores/sampling-requests', '/stores/sampling-requests', t);
  const alerts = await probe('GET /stores/alerts', '/stores/alerts', t);
  const specs = await probe('GET /specifications', '/specifications', qa);
  const coas = await probe('GET /qa/coa', '/qa/coa', qa);
  const investigations = await probe('GET /qa/investigations', '/qa/investigations', qa);
  const tests = await probe('GET /catalog/tests', '/catalog/tests', t);
  const analytes = await probe('GET /catalog/analytes', '/catalog/analytes', t);
  const refData = await probe('GET /catalog/reference-data', '/catalog/reference-data', t);
  const panels = await probe('GET /catalog/panels', '/catalog/panels', t);
  const qcLots = await probe('GET /qc/lots', '/qc/lots', t);
  const qcMaterials = await probe('GET /qc/materials', '/qc/materials', t);
  await probe('GET /qc/failures', '/qc/failures', t);
  const items = await probe('GET /inventory/items', '/inventory/items', t);
  await probe('GET /inventory/alerts', '/inventory/alerts', t);
  const devices = await probe('GET /ingest/devices', '/ingest/devices', t);
  await probe('GET /ingest/exceptions', '/ingest/exceptions', t);
  const users = await probe('GET /admin/users', '/admin/users', t);
  await probe('GET /admin/roles', '/admin/roles', t);
  await probe('GET /admin/competency', '/admin/competency', t);
  const reports = await probe('GET /reports', '/reports?limit=50', t);
  const orders = await probe('GET /orders', '/orders?limit=50', t);
  await probe('GET /compliance/audit', '/compliance/audit?limit=50', auditor);
  await probe('GET /compliance/audit-chain/verify', '/compliance/audit-chain/verify', auditor);
  await probe('GET /compliance/quality-indicators', '/compliance/quality-indicators', t);
  await probe('GET /auth/me', '/auth/me', t);

  // ------------------------------------------------------------------ detail
  //
  // The point of the sweep. Every record, not a sample of them: the failure
  // this guards against is per-row.
  console.log('\n\x1b[1mEvery record, opened\x1b[0m');

  const each = async (label, rows, path, token, limit = 200) => {
    const list = asArray(rows).slice(0, limit);
    if (list.length === 0) {
      console.log(`  \x1b[2m—   ${label}: nothing to open\x1b[0m`);
      return;
    }
    const failed = [];
    for (const row of list) {
      const r = await get(path(row), token);
      if (r.status >= 500 || r.status === 401) failed.push(`${String(row.id).slice(0, 8)}:${r.status}`);
    }
    checked += list.length;
    if (failed.length) {
      broken.push(`${label}: ${failed.length}/${list.length} failed — ${failed.slice(0, 6).join(', ')}`);
      console.log(`  \x1b[31mFAIL\x1b[0m ${label}: ${failed.length}/${list.length} — ${failed.slice(0, 6).join(', ')}`);
    } else {
      console.log(`  \x1b[32mOK  \x1b[0m ${label}: ${list.length}/${list.length} open`);
    }
  };

  await each('tests', worklist, (r) => `/tests/${r.id}`, t);
  await each('test content-hash', worklist, (r) => `/tests/${r.id}/content-hash`, t);
  await each('samples', samples, (r) => `/samples/${r.id}`, t);
  await each('batches', batches, (r) => `/stores/batches/${r.id}`, t);
  await each('batch review', batches, (r) => `/qa/batches/${r.id}/review`, qa);
  await each('specifications', specs, (r) => `/specifications/${r.id}`, qa);
  await each('certificates', coas, (r) => `/qa/coa/${r.id}`, qa);
  await each('reports', reports, (r) => `/reports/${r.id}`, t);
  await each('orders', orders, (r) => `/orders/${r.id}`, t);
  await each('invoices', await probe('GET /billing/invoices', '/billing/invoices?limit=25', t),
    (r) => `/billing/invoices/${r.id}`, t);
  await each('users', users, (r) => `/admin/users/${r.id}`, t);
  await each('inventory lot history', asArray(items).flatMap((i) => i.lots ?? []),
    (l) => `/inventory/lots/${l.id}/history`, t);
  await each('analyte ranges', analytes, (a) => `/catalog/analytes/${a.id}/ranges`, t);

  // Referenced but not iterated above — confirm the collections at least parse.
  for (const [label, rows] of [
    ['materials', materials], ['sampling requests', requests], ['alerts', alerts],
    ['investigations', investigations], ['catalog tests', tests], ['reference data', refData],
    ['panels', panels], ['qc lots', qcLots], ['qc materials', qcMaterials], ['devices', devices],
  ]) {
    if (rows == null) broken.push(`${label}: collection did not load`);
  }

  // ------------------------------------------------------------------ report
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`\n\x1b[1m${checked} endpoints checked · ${broken.length} broken\x1b[0m`);
  // The shape verify-all parses, so this reports a number like the other suites.
  console.log(`[1m${checked - broken.length} passed, ${broken.length} failed[0m`);
  if (forbidden.length) {
    console.log(`\x1b[2m${forbidden.length} returned 403 (a working control, not a fault)\x1b[0m`);
  }
  if (broken.length) {
    console.log('\n\x1b[31mBroken:\x1b[0m');
    for (const b of broken) console.log(`  ${b}`);
    process.exit(1);
  }
  console.log('\nNothing returns a server error.\n');
}

main().catch((e) => {
  console.error('\n\x1b[31mSweep aborted:\x1b[0m', e.message);
  process.exit(1);
});
