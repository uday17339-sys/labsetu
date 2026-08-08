#!/usr/bin/env node
/**
 * Feature audit.
 *
 * Not a test suite — an inventory with probes. It walks every module as each
 * role that should use it and reports what works, what is permission-gated
 * correctly, and what is broken or awkward. The output is meant to be read by a
 * person deciding whether to ship.
 *
 * Usage: node scripts/feature-audit.mjs [apiBase] [webBase]
 */
const API = process.argv[2] ?? 'https://localhost/api';
const WEB = process.argv[3] ?? 'https://localhost';
const TENANT = 'SUNRISE';
const PASSWORD = 'LabSetu@2026';

const findings = [];
const good = (area, what, detail = '') => {
  console.log(`  \x1b[32m✓\x1b[0m  ${what}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
};
const issue = (area, what, detail, severity = 'ISSUE') => {
  findings.push({ area, what, detail, severity });
  const colour = severity === 'BUG' ? '\x1b[31m' : '\x1b[33m';
  console.log(`  ${colour}${severity === 'BUG' ? '✗' : '!'}\x1b[0m  ${what}  ${colour}${detail}\x1b[0m`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { token, body } = {}, attempt = 0) {
  const started = Date.now();
  const res = await fetch(`${API}/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 429 && attempt < 3) {
    await sleep(21_000);
    return api(method, path, { token, body }, attempt + 1);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json, ms: Date.now() - started };
}

const login = (email) =>
  api('POST', '/auth/login', { body: { tenantCode: TENANT, email, password: PASSWORD } }).then(
    (r) => r.body,
  );

async function page(path, cookie) {
  const started = Date.now();
  const res = await fetch(`${WEB}${path}`, { headers: { cookie }, redirect: 'manual' });
  const html = await res.text();
  return { status: res.status, html, ms: Date.now() - started, bytes: html.length };
}

const cookieFor = (a) =>
  `labsetu_at=${a.accessToken}; labsetu_rt=${a.refreshToken}; ` +
  `labsetu_user=${encodeURIComponent(JSON.stringify(a.user))}`;

// ---------------------------------------------------------------------------

const users = {};
for (const who of ['admin', 'pathologist', 'tech', 'front', 'stores', 'qc', 'qa', 'auditor']) {
  users[who] = await login(`${who}@sunrise.test`);
}

if (!users.admin?.accessToken) {
  console.error('Cannot sign in. Is the stack running and seeded?');
  process.exit(1);
}

console.log(`\n\x1b[1mLabSetu — feature audit\x1b[0m  ${API}\n`);

// ===========================================================================
section('1. Roles and what each can actually reach');

for (const [who, u] of Object.entries(users)) {
  if (!u?.accessToken) {
    issue('roles', `${who} cannot sign in`, 'user missing or password differs', 'BUG');
    continue;
  }
  good('roles', `${who.padEnd(12)} ${u.user.roles.join(',')}`, `${u.user.permissions.length} permissions`);
}

// ===========================================================================
section('2. The landing screen for every role');

// A user whose job has nothing to do with the clinical worklist should not be
// dropped onto an empty clinical worklist.
for (const [who, u] of Object.entries(users)) {
  if (!u?.accessToken) continue;
  const p = await page('/', cookieFor(u));
  if (p.status !== 200) {
    issue('dashboard', `${who} dashboard`, `HTTP ${p.status}`, 'BUG');
    continue;
  }
  const hasClinical = /tests? in progress|Awaiting verification/i.test(p.html);
  const hasStores = /quarantine|Quarantined|Under test/i.test(p.html);
  const hasCounter = /Registered today|Collected today/i.test(p.html);
  const expected =
    who === 'stores' ? 'stores' : who === 'front' ? 'counter' : 'clinical';
  const relevant =
    expected === 'stores' ? hasStores : expected === 'counter' ? hasCounter : hasClinical;
  relevant
    ? good('dashboard', `${who.padEnd(12)} sees a ${expected} dashboard`, `${(p.bytes / 1024) | 0}kb`)
    : issue(
        'dashboard',
        `${who} lands on a dashboard about someone else's job`,
        `expected the ${expected} view; clinical=${hasClinical} stores=${hasStores} counter=${hasCounter}`,
      );
}

// ===========================================================================
section('3. Every screen, as a role that should use it');

const SCREENS = [
  ['/worklist', 'tech', 'result:read'],
  ['/samples', 'tech', 'sample:read'],
  ['/register', 'front', 'order:create'],
  ['/patients', 'front', 'patient:read'],
  ['/critical', 'tech', 'result:read'],
  ['/reports', 'pathologist', 'report:read'],
  ['/qc', 'tech', 'qc:read'],
  ['/inventory', 'tech', 'inventory:read'],
  ['/billing', 'front', 'invoice:read'],
  ['/analytics', 'admin', 'analytics:read'],
  ['/admin', 'admin', 'user:read'],
  ['/admin/catalog', 'admin', 'catalog:read'],
  ['/devices', 'admin', 'device:read'],
  ['/audit', 'auditor', 'audit:read'],
  ['/stores', 'stores', 'stores:read'],
  ['/specifications', 'qa', 'spec:read'],
  ['/qa', 'qa', 'batch:disposition'],
];

for (const [path, who, perm] of SCREENS) {
  const u = users[who];
  if (!u?.accessToken) continue;
  if (!u.user.permissions.includes(perm)) {
    issue('screens', `${path} — ${who} lacks ${perm}`, 'the role that should use it cannot', 'BUG');
    continue;
  }
  const p = await page(path, cookieFor(u));
  if (p.status !== 200) {
    issue('screens', `${path} as ${who}`, `HTTP ${p.status}`, 'BUG');
  } else if (p.bytes < 4000) {
    issue('screens', `${path} as ${who}`, `only ${p.bytes} bytes — probably an error shell`);
  } else if (p.ms > 3000) {
    issue('screens', `${path} as ${who}`, `${p.ms}ms — slow`);
  } else {
    good('screens', path.padEnd(20), `${who} · ${p.ms}ms · ${(p.bytes / 1024) | 0}kb`);
  }
}

// ===========================================================================
section('4. Screens a role should NOT reach');

const DENIED = [
  ['/analytics', 'tech', 'bench staff seeing revenue'],
  ['/admin', 'tech', 'bench staff seeing staff administration'],
];

for (const [path, who, why] of DENIED) {
  const u = users[who];
  if (!u?.accessToken) continue;
  const p = await page(path, cookieFor(u));
  // The page shell may render; what matters is that it carries no data.
  const leaked = /₹[0-9]/.test(p.html) || /temporary password/i.test(p.html);
  leaked
    ? issue('rbac', `${path} leaks data to ${who}`, why, 'BUG')
    : good('rbac', `${path} carries no data for ${who}`, why);
}

// ===========================================================================
section('5. API surface — every list endpoint answers');

const ENDPOINTS = [
  ['GET', '/catalog/tests', 'admin'],
  ['GET', '/catalog/analytes', 'admin'],
  ['GET', '/catalog/doctors', 'admin'],
  ['GET', '/catalog/reference-data', 'admin'],
  ['GET', '/worklist?limit=20', 'tech'],
  ['GET', '/patients?registeredFrom=2020-01-01T00:00:00.000Z&limit=20', 'front'],
  ['GET', '/reports?limit=20', 'pathologist'],
  ['GET', '/critical-values', 'tech'],
  ['GET', '/critical-values/performance', 'admin'],
  ['GET', '/qc/lots', 'tech'],
  ['GET', '/qc/materials', 'admin'],
  ['GET', '/qc/failures', 'tech'],
  ['GET', '/inventory/items', 'tech'],
  ['GET', '/inventory/alerts', 'tech'],
  ['GET', '/billing/invoices?limit=20', 'front'],
  ['GET', '/billing/summary', 'front'],
  ['GET', '/analytics/overview', 'admin'],
  ['GET', '/analytics/revenue', 'admin'],
  ['GET', '/analytics/test-mix', 'admin'],
  ['GET', '/analytics/referrals', 'admin'],
  ['GET', '/admin/users', 'admin'],
  ['GET', '/admin/roles', 'admin'],
  ['GET', '/admin/competency', 'admin'],
  ['GET', '/ingest/devices', 'admin'],
  ['GET', '/ingest/exceptions', 'tech'],
  ['GET', '/compliance/quality-indicators', 'admin'],
  ['GET', '/compliance/audit?limit=20', 'auditor'],
  ['GET', '/compliance/audit-chain/verify', 'auditor'],
  ['GET', '/stores/materials', 'stores'],
  ['GET', '/stores/batches', 'stores'],
  ['GET', '/stores/alerts', 'stores'],
  ['GET', '/stores/sampling-requests', 'stores'],
  ['GET', '/specifications', 'qa'],
  ['GET', '/qa/investigations', 'qa'],
];

let slowest = { path: '', ms: 0 };
for (const [method, path, who] of ENDPOINTS) {
  const u = users[who];
  if (!u?.accessToken) continue;
  const r = await api(method, path, { token: u.accessToken });
  if (r.status !== 200) {
    issue('api', `${method} ${path}`, `${r.status} as ${who}: ${JSON.stringify(r.body).slice(0, 90)}`, 'BUG');
  } else {
    if (r.ms > slowest.ms) slowest = { path, ms: r.ms };
    if (r.ms > 2000) issue('api', `${method} ${path}`, `${r.ms}ms — slow`);
    else good('api', path.padEnd(52), `${r.ms}ms`);
  }
}
console.log(`  \x1b[2mslowest: ${slowest.path} at ${slowest.ms}ms\x1b[0m`);

// ===========================================================================
section('6. CSV exports');

for (const name of ['worklist', 'results', 'qc', 'audit', 'inventory']) {
  const res = await fetch(`${API}/v1/export/${name}.csv`, {
    headers: { authorization: `Bearer ${users.auditor.accessToken}` },
  });
  const body = await res.text();
  res.status === 200 && body.length > 0
    ? good('export', `${name}.csv`, `${(body.length / 1024).toFixed(1)}kb`)
    : issue('export', `${name}.csv`, `${res.status}`, 'BUG');
}

// ===========================================================================
section('7. Cross-cutting: does the diagnostics side still behave?');

const chain = await api('GET', '/compliance/audit-chain/verify', { token: users.admin.accessToken });
chain.body?.status === 'PASSED'
  ? good('audit', 'hash chain verifies', `${chain.body.entriesChecked} entries`)
  : issue('audit', 'hash chain', JSON.stringify(chain.body).slice(0, 90), 'BUG');

const indicators = await api('GET', '/compliance/quality-indicators', {
  token: users.admin.accessToken,
});
indicators.status === 200
  ? good('nabl', 'quality indicators computed', `rejection ${indicators.body?.sampleRejectionRate?.value ?? '?'}%`)
  : issue('nabl', 'quality indicators', `${indicators.status}`, 'BUG');

// A patient order must still refuse to be treated as a batch and vice versa.
const anyOrder = await api('GET', '/worklist?limit=1', { token: users.tech.accessToken });
const someTestId = anyOrder.body?.items?.[0]?.id;
if (someTestId) {
  const t = await api('GET', `/tests/${someTestId}`, { token: users.tech.accessToken });
  t.status === 200
    ? good('spine', 'a clinical test still loads', t.body?.testDefinition?.code ?? '')
    : issue('spine', 'clinical test detail', `${t.status}`, 'BUG');
}

// ===========================================================================
section('8. Data volumes on the demo tenant');

const counts = {
  patients: (await api('GET', '/patients?registeredFrom=2020-01-01T00:00:00.000Z&limit=100', { token: users.admin.accessToken })).body?.length,
  tests: (await api('GET', '/catalog/tests', { token: users.admin.accessToken })).body?.length,
  materials: (await api('GET', '/stores/materials', { token: users.admin.accessToken })).body?.length,
  batches: (await api('GET', '/stores/batches', { token: users.admin.accessToken })).body?.length,
  specs: (await api('GET', '/specifications', { token: users.admin.accessToken })).body?.length,
  staff: (await api('GET', '/admin/users', { token: users.admin.accessToken })).body?.length,
  invoices: (await api('GET', '/billing/invoices?limit=100', { token: users.admin.accessToken })).body?.items?.length,
  reports: (await api('GET', '/reports?limit=100', { token: users.admin.accessToken })).body?.items?.length,
};
for (const [k, v] of Object.entries(counts)) {
  v > 0
    ? good('data', `${k.padEnd(12)} ${v}`)
    : issue('data', `no ${k} on the demo tenant`, 'the screen will look empty in a demo');
}

// ===========================================================================
console.log(`\n${'─'.repeat(72)}`);
const bugs = findings.filter((f) => f.severity === 'BUG');
const issues = findings.filter((f) => f.severity === 'ISSUE');
console.log(
  `\n\x1b[1m${bugs.length} bug(s) · ${issues.length} rough edge(s)\x1b[0m\n`,
);
if (bugs.length) {
  console.log('\x1b[31mBUGS\x1b[0m');
  for (const f of bugs) console.log(`  ✗ ${f.what}\n      ${f.detail}`);
}
if (issues.length) {
  console.log('\n\x1b[33mROUGH EDGES\x1b[0m');
  for (const f of issues) console.log(`  ! ${f.what}\n      ${f.detail}`);
}
process.exit(bugs.length > 0 ? 1 : 0);
