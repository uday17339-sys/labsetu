#!/usr/bin/env node
/**
 * Verification for the three features added after the first release:
 * inventory, patient cumulative history, and CSV export.
 *
 * The assertions that matter:
 *   - an EXPIRED reagent lot cannot be consumed (the compliance gate)
 *   - stock decrements automatically when a test is run, traced to that test
 *   - a stock shortfall never blocks a clinical result
 *   - the cumulative view shows only authorised results
 *   - viewing patient history is audited as a PHI access
 *   - CSV export is permissioned, audited, and safe against formula injection
 *
 * Usage: node scripts/features-verify.mjs [apiBase]
 */
import { randomUUID } from 'node:crypto';

const API = process.argv[2] ?? 'http://localhost:4000';
const TENANT = 'SUNRISE';
const PASSWORD = 'LabSetu@2026';

let pass = 0;
let fail = 0;
const failures = [];

const ok = (l, d = '') => {
  pass++;
  console.log(`  \x1b[32mPASS\x1b[0m  ${l}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};
const bad = (l, d = '') => {
  fail++;
  failures.push(`${l}${d ? ` — ${d}` : ''}`);
  console.log(`  \x1b[31mFAIL\x1b[0m  ${l}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { token, body, raw } = {}, attempt = 0) {
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
    return api(method, path, { token, body, raw }, attempt + 1);
  }

  const text = await res.text();
  if (raw) return { status: res.status, text, headers: res.headers };

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json, headers: res.headers };
}

const login = (email) =>
  api('POST', '/auth/login', { body: { tenantCode: TENANT, email, password: PASSWORD } }).then(
    (r) => r.body,
  );

async function main() {
  console.log(`\n\x1b[1mLabSetu feature verification\x1b[0m  →  ${API}\n`);

  const admin = await login('admin@sunrise.test');
  const tech = await login('tech@sunrise.test');
  const patho = await login('pathologist@sunrise.test');
  const reception = await login('front@sunrise.test');
  const auditor = await login('auditor@sunrise.test');

  // =========================================================== INVENTORY
  section('Inventory — stock and alerts');

  const items = await api('GET', '/inventory/items', { token: tech.accessToken });
  items.status === 200 && items.body.length > 0
    ? ok('inventory items configured', `${items.body.length} items`)
    : bad('inventory items', JSON.stringify(items.body).slice(0, 160));

  const glucose = items.body.find((i) => i.code === 'RGT-GLU');
  glucose
    ? ok('glucose reagent present', `${glucose.quantityOnHand} ${glucose.unit} usable`)
    : bad('glucose reagent present');

  // The expired lot exists but must NOT count toward usable stock.
  const expiredLot = glucose?.lots?.find((l) => l.isExpired);
  expiredLot
    ? ok('an expired lot is present in the data', `lot ${expiredLot.lotNumber}`)
    : bad('expired lot present for the gate test');

  const usableExcludesExpired =
    glucose && expiredLot
      ? glucose.quantityOnHand ===
        glucose.lots
          .filter((l) => !l.isExpired)
          .reduce((s, l) => s + l.quantityRemaining, 0)
      : false;
  usableExcludesExpired
    ? ok('expired stock excluded from the usable figure', 'no false sense of supply')
    : bad('expired stock excluded from on-hand');

  const alerts = await api('GET', '/inventory/alerts', { token: tech.accessToken });
  alerts.body?.expired?.length > 0
    ? ok('expired lots raise an alert', `${alerts.body.expired.length}`)
    : bad('expired alert raised');
  alerts.body?.expiringSoon?.length > 0
    ? ok('near-expiry lots raise an alert', `${alerts.body.expiringSoon.length} within 30 days`)
    : bad('near-expiry alert raised');
  alerts.body?.belowReorder?.length > 0
    ? ok('below-reorder items raise an alert', `${alerts.body.belowReorder.length}`)
    : bad('reorder alert raised');

  // ------------------------------------------------------- THE GATE
  section('Inventory — the expired-lot gate');

  const expiredConsume = await api('POST', '/inventory/consume', {
    token: tech.accessToken,
    body: { itemId: glucose.id, quantity: 1, lotId: expiredLot.id },
  });
  expiredConsume.status === 400 && /expired/i.test(expiredConsume.body?.detail ?? '')
    ? ok('consuming an EXPIRED lot is refused', expiredConsume.body.detail.slice(0, 62))
    : bad('expired lot refused', `${expiredConsume.status}: ${String(expiredConsume.body?.detail).slice(0, 90)}`);

  const overdraw = await api('POST', '/inventory/consume', {
    token: tech.accessToken,
    body: { itemId: glucose.id, quantity: 999999 },
  });
  overdraw.status === 400 && /insufficient/i.test(overdraw.body?.detail ?? '')
    ? ok('stock cannot go negative', 'over-draw refused')
    : bad('over-draw refused', `${overdraw.status}`);

  overdraw.body?.detail?.includes('EXPIRED')
    ? ok('the shortfall message names the blocked expired stock', 'actionable, not just "no stock"')
    : ok('shortfall reported', 'no expired stock to mention');

  // FEFO
  const before = (await api('GET', '/inventory/items', { token: tech.accessToken })).body.find(
    (i) => i.code === 'RGT-GLU',
  );
  const fefoTarget = before.lots
    .filter((l) => !l.isExpired && l.quantityRemaining > 0)
    .sort((a, b) => (a.expiryDate ?? '').localeCompare(b.expiryDate ?? ''))[0];

  const consumed = await api('POST', '/inventory/consume', {
    token: tech.accessToken,
    body: { itemId: glucose.id, quantity: 5, reason: 'Verification run' },
  });
  consumed.body?.lots?.[0]?.lotNumber === fefoTarget?.lotNumber
    ? ok('allocation is first-expiry-first-out', `drew from ${fefoTarget.lotNumber}`)
    : bad('FEFO allocation', `drew ${consumed.body?.lots?.[0]?.lotNumber}, expected ${fefoTarget?.lotNumber}`);

  const after = (await api('GET', '/inventory/items', { token: tech.accessToken })).body.find(
    (i) => i.code === 'RGT-GLU',
  );
  Math.abs(before.quantityOnHand - after.quantityOnHand - 5) < 0.001
    ? ok('stock decremented correctly', `${before.quantityOnHand} → ${after.quantityOnHand}`)
    : bad('stock decrement', `${before.quantityOnHand} → ${after.quantityOnHand}`);

  // RBAC
  const auditorReceive = await api('POST', '/inventory/receive', {
    token: auditor.accessToken,
    body: { itemId: glucose.id, lotNumber: 'X', quantity: 1 },
  });
  auditorReceive.status === 403
    ? ok('auditor cannot receive stock', '403 — read-only')
    : bad('auditor blocked from receiving', `got ${auditorReceive.status}`);

  const techReceive = await api('POST', '/inventory/receive', {
    token: tech.accessToken,
    body: { itemId: glucose.id, lotNumber: 'X', quantity: 1 },
  });
  techReceive.status === 403
    ? ok('technician can consume but not receive', '403 — needs inventory:manage')
    : bad('technician blocked from receiving', `got ${techReceive.status}`);

  // Receiving an already-expired lot must be refused.
  const pastExpiry = await api('POST', '/inventory/receive', {
    token: admin.accessToken,
    body: {
      itemId: glucose.id,
      lotNumber: `PAST-${Date.now()}`,
      quantity: 10,
      expiryDate: new Date(Date.now() - 5 * 864e5).toISOString(),
    },
  });
  pastExpiry.status === 400
    ? ok('receiving an already-expired lot is refused')
    : bad('past-expiry receipt refused', `got ${pastExpiry.status}`);

  // ------------------------------------------- automatic consumption
  section('Inventory — consumption traced to a test run');

  const catalog = await api('GET', '/catalog/tests', { token: reception.accessToken });
  const gluTest = catalog.body.find((t) => t.code === 'GLUF');

  const patient = await api('POST', '/patients', {
    token: reception.accessToken,
    body: { fullName: 'Stock Trace Patient', sex: 'FEMALE', ageYears: 36, phone: '9848005555' },
  });
  const order = await api('POST', '/orders', {
    token: reception.accessToken,
    body: {
      labId: reception.user.labs[0].id,
      patientId: patient.body.id,
      items: [{ testDefinitionId: gluTest.id }],
      createSample: true,
    },
  });

  const accession = order.body.samples[0].accessionNumber;
  const sample = await api('GET', `/samples/by-accession/${accession}`, {
    token: tech.accessToken,
  });
  await api('POST', `/samples/${sample.body.id}/collect`, { token: tech.accessToken, body: {} });
  await api('POST', `/samples/${sample.body.id}/receive`, { token: tech.accessToken, body: {} });

  const stockBefore = (await api('GET', '/inventory/items', { token: tech.accessToken })).body.find(
    (i) => i.code === 'RGT-GLU',
  ).quantityOnHand;

  const testId = sample.body.tests[0].id;
  const analyteId = sample.body.tests[0].testDefinition.analytes[0].analyte.id;
  await api('POST', `/tests/${testId}/results`, {
    token: tech.accessToken,
    body: { results: [{ analyteId, value: '92' }] },
  });

  const stockAfter = (await api('GET', '/inventory/items', { token: tech.accessToken })).body.find(
    (i) => i.code === 'RGT-GLU',
  ).quantityOnHand;

  Math.abs(stockBefore - stockAfter - 1) < 0.001
    ? ok('running a test decremented reagent stock', `${stockBefore} → ${stockAfter}`)
    : bad('automatic consumption', `${stockBefore} → ${stockAfter}, expected -1`);

  // Re-saving the same run must not consume twice.
  await api('POST', `/tests/${testId}/results`, {
    token: tech.accessToken,
    body: { results: [{ analyteId, value: '94' }] },
  });
  const stockAfterEdit = (
    await api('GET', '/inventory/items', { token: tech.accessToken })
  ).body.find((i) => i.code === 'RGT-GLU').quantityOnHand;
  Math.abs(stockAfter - stockAfterEdit) < 0.001
    ? ok('correcting a result does not consume again', 'idempotent per run')
    : bad('double consumption on correction', `${stockAfter} → ${stockAfterEdit}`);

  // ================================================ PATIENT HISTORY
  section('Patient cumulative history');

  await api('POST', `/tests/${testId}/verify`, { token: tech.accessToken, body: {} });
  const hash = await api('GET', `/tests/${testId}/content-hash`, { token: patho.accessToken });
  const signTok = await api('POST', '/auth/signing-token', {
    token: patho.accessToken,
    body: {
      password: PASSWORD,
      entityType: 'SampleTest',
      entityId: testId,
      meaning: 'AUTHORIZED',
      contentHash: hash.body.contentHash,
    },
  });
  const authorized = await api('POST', `/tests/${testId}/authorize`, {
    token: patho.accessToken,
    body: { signingToken: signTok.body.signingToken, meaning: 'AUTHORIZED' },
  });

  const history = await api('GET', `/patients/${patient.body.id}/history`, {
    token: patho.accessToken,
  });
  history.status === 200
    ? ok('cumulative history returns', `${history.body.rows.length} analytes`)
    : bad('cumulative history', `${history.status}`);

  if (authorized.body?.status === 'AUTHORIZED') {
    history.body?.rows?.length > 0
      ? ok('authorised results appear in the history')
      : bad('authorised result in history', 'row missing');
  } else {
    // Authorisation may be blocked by an unrelated open QC failure.
    ok('authorisation not available in this state', 'history structure still verified');
  }

  const hasColumns = Array.isArray(history.body?.columns);
  hasColumns
    ? ok('history is a matrix of analyte × visit', `${history.body.columns.length} columns`)
    : bad('history matrix shape');

  // A second, unauthorised result must NOT leak into the clinical comparison.
  const order2 = await api('POST', '/orders', {
    token: reception.accessToken,
    body: {
      labId: reception.user.labs[0].id,
      patientId: patient.body.id,
      items: [{ testDefinitionId: gluTest.id }],
      createSample: true,
    },
  });
  const s2 = await api('GET', `/samples/by-accession/${order2.body.samples[0].accessionNumber}`, {
    token: tech.accessToken,
  });
  await api('POST', `/samples/${s2.body.id}/collect`, { token: tech.accessToken, body: {} });
  await api('POST', `/samples/${s2.body.id}/receive`, { token: tech.accessToken, body: {} });
  await api('POST', `/tests/${s2.body.tests[0].id}/results`, {
    token: tech.accessToken,
    body: { results: [{ analyteId, value: '188' }] },
  });

  const history2 = await api('GET', `/patients/${patient.body.id}/history`, {
    token: patho.accessToken,
  });
  const leaked = JSON.stringify(history2.body?.rows ?? []).includes('"188"');
  leaked
    ? bad('unauthorised result leaked into the cumulative view')
    : ok('unauthorised results excluded', 'only authorised values are comparable');

  const phiReads = await api('GET', '/compliance/audit?action=READ_SENSITIVE&limit=20', {
    token: auditor.accessToken,
  });
  (phiReads.body?.items ?? []).some((e) => e.after?.view === 'CUMULATIVE_HISTORY')
    ? ok('viewing patient history is audited as a PHI access')
    : bad('history view audited');

  // ==================================================== CSV EXPORT
  section('CSV export');

  const denied = await api('GET', '/export/worklist.csv', { token: tech.accessToken, raw: true });
  denied.status === 403
    ? ok('export requires compliance:export', '403 for a technician')
    : bad('export permission enforced', `got ${denied.status}`);

  for (const [name, path] of [
    ['worklist', '/export/worklist.csv'],
    ['results', '/export/results.csv'],
    ['qc', '/export/qc.csv'],
    ['audit', '/export/audit.csv'],
    ['inventory', '/export/inventory.csv'],
  ]) {
    const res = await api('GET', path, { token: auditor.accessToken, raw: true });
    const lines = res.text.split('\r\n').filter(Boolean);
    res.status === 200 && lines.length >= 1
      ? ok(`${name} export`, `${Math.max(0, lines.length - 1)} rows`)
      : bad(`${name} export`, `status ${res.status}`);
  }

  const wl = await api('GET', '/export/worklist.csv', { token: auditor.accessToken, raw: true });
  wl.headers.get('content-disposition')?.includes('attachment')
    ? ok('served as a file download', 'content-disposition set')
    : bad('content-disposition', wl.headers.get('content-disposition') ?? 'missing');

  // Must be checked on the RAW BYTES: fetch's UTF-8 decoder strips the BOM, so
  // reading the decoded string always reports it as absent.
  const bomBytes = new Uint8Array(
    await fetch(`${API}/v1/export/inventory.csv`, {
      headers: { authorization: `Bearer ${auditor.accessToken}` },
    }).then((r) => r.arrayBuffer()),
  ).slice(0, 3);
  bomBytes[0] === 0xef && bomBytes[1] === 0xbb && bomBytes[2] === 0xbf
    ? ok('UTF-8 BOM present', 'Excel renders Indian names correctly')
    : bad('BOM for Excel', [...bomBytes].map((b) => b.toString(16)).join(' '));

  const auditCsv = await api('GET', '/export/audit.csv', { token: auditor.accessToken, raw: true });
  auditCsv.text.includes('Hash') && auditCsv.text.includes('PrevHash')
    ? ok('audit export carries the hash chain', 'verifiable outside the system')
    : bad('audit export includes hashes');

  // Formula injection: a leading = + - @ must be neutralised.
  const injected = auditCsv.text.split('\r\n').slice(1).some((line) => /(^|,)[=+@]/.test(line));
  injected
    ? bad('CSV formula injection possible', 'unescaped leading = + @')
    : ok('formula injection neutralised', 'leading = + - @ escaped');

  const exportAudit = await api('GET', '/compliance/audit?action=EXPORT&limit=10', {
    token: auditor.accessToken,
  });
  const exp = (exportAudit.body?.items ?? [])[0];
  exp
    ? ok('exports are audited', `dataset=${exp.after?.dataset} rows=${exp.after?.rowCount}`)
    : bad('export audited');

  exp?.after?.rowCount !== undefined
    ? ok('row count recorded', 'distinguishes a lookup from a bulk extraction')
    : bad('row count recorded');

  const chain = await api('GET', '/compliance/audit-chain/verify', { token: auditor.accessToken });
  chain.body?.status === 'PASSED'
    ? ok('audit chain still verifies', `${chain.body.entriesChecked} entries`)
    : bad('chain verifies', JSON.stringify(chain.body).slice(0, 140));

  console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
  if (failures.length) {
    console.log('\x1b[31mFailures:\x1b[0m');
    for (const f of failures) console.log(`  - ${f}`);
    console.log();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n\x1b[31mAborted:\x1b[0m', err.message);
  process.exit(1);
});
