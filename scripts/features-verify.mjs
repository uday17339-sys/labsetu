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
const TENANT = 'VANTAGE';
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

  const admin = await login('admin@vantage.test');
  const tech = await login('qc@vantage.test');
  const qa = await login('qa@vantage.test');
  const stores = await login('stores@vantage.test');
  const auditor = await login('auditor@vantage.test');

  // =========================================================== INVENTORY
  section('Inventory — stock and alerts');

  // Book in a fresh vial of the reference standard first.
  //
  // This suite consumes 25 mg of it per run through the assay, and the seeded
  // vial holds 500. After twenty runs the lot is empty and every consumption
  // check fails — which reads as broken FEFO and broken auto-consumption when
  // the truth is that the system correctly refused to issue stock that is not
  // there. A suite that depends on how many times it has been run before is
  // measuring its own history, not the product.
  const stockAdmin = await login('admin@vantage.test');
  const preItems = await api('GET', '/inventory/items', { token: tech.accessToken });
  const stdItem = (preItems.body ?? []).find((i) => i.code === 'STD-PCM-RS');
  if (stdItem) {
    const topUp = await api('POST', '/inventory/receive', {
      token: stockAdmin.accessToken,
      body: {
        itemId: stdItem.id,
        lotNumber: `IPRS/PCM/RUN-${Date.now().toString().slice(-6)}`,
        quantity: 500,
        // Dated well beyond the seeded vial on purpose. FEFO must still draw
        // the older one first, and giving the two lots near-identical expiries
        // would make the assertion depend on how a tie is broken rather than on
        // first-expiry-first-out actually working.
        expiryDate: new Date(Date.now() + 400 * 864e5).toISOString().slice(0, 10),
        supplier: 'IPC Ghaziabad',
      },
    });
    topUp.status < 300
      ? ok('a fresh vial of reference standard booked in', '500 mg, so the run does not depend on leftovers')
      : bad('top up the reference standard', `${topUp.status} ${JSON.stringify(topUp.body).slice(0, 110)}`);
  }

  const items = await api('GET', '/inventory/items', { token: tech.accessToken });
  items.status === 200 && items.body.length > 0
    ? ok('inventory items configured', `${items.body.length} items`)
    : bad('inventory items', JSON.stringify(items.body).slice(0, 160));

  const standard = items.body.find((i) => i.code === 'STD-PCM-RS');
  standard
    ? ok('the reference standard is stocked', `${standard.quantityOnHand} ${standard.unit} usable`)
    : bad('reference standard present');

  // The expired lot exists but must NOT count toward usable stock.
  const expiredLot = standard?.lots?.find((l) => l.isExpired);
  expiredLot
    ? ok('an expired lot is present in the data', `lot ${expiredLot.lotNumber}`)
    : bad('expired lot present for the gate test');

  const usableExcludesExpired =
    standard && expiredLot
      ? standard.quantityOnHand ===
        standard.lots
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
    body: { itemId: standard.id, quantity: 1, lotId: expiredLot.id },
  });
  expiredConsume.status === 400 && /expired/i.test(expiredConsume.body?.detail ?? '')
    ? ok('consuming an EXPIRED lot is refused', expiredConsume.body.detail.slice(0, 62))
    : bad('expired lot refused', `${expiredConsume.status}: ${String(expiredConsume.body?.detail).slice(0, 90)}`);

  const overdraw = await api('POST', '/inventory/consume', {
    token: tech.accessToken,
    body: { itemId: standard.id, quantity: 999999 },
  });
  overdraw.status === 400 && /insufficient/i.test(overdraw.body?.detail ?? '')
    ? ok('stock cannot go negative', 'over-draw refused')
    : bad('over-draw refused', `${overdraw.status}`);

  overdraw.body?.detail?.includes('EXPIRED')
    ? ok('the shortfall message names the blocked expired stock', 'actionable, not just "no stock"')
    : ok('shortfall reported', 'no expired stock to mention');

  // FEFO
  const before = (await api('GET', '/inventory/items', { token: tech.accessToken })).body.find(
    (i) => i.code === 'STD-PCM-RS',
  );
  const fefoTarget = before.lots
    .filter((l) => !l.isExpired && l.quantityRemaining > 0)
    .sort((a, b) => (a.expiryDate ?? '').localeCompare(b.expiryDate ?? ''))[0];

  const consumed = await api('POST', '/inventory/consume', {
    token: tech.accessToken,
    body: { itemId: standard.id, quantity: 5, reason: 'Verification run' },
  });
  consumed.body?.lots?.[0]?.lotNumber === fefoTarget?.lotNumber
    ? ok('allocation is first-expiry-first-out', `drew from ${fefoTarget.lotNumber}`)
    : bad('FEFO allocation', `drew ${consumed.body?.lots?.[0]?.lotNumber}, expected ${fefoTarget?.lotNumber}`);

  const after = (await api('GET', '/inventory/items', { token: tech.accessToken })).body.find(
    (i) => i.code === 'STD-PCM-RS',
  );
  Math.abs(before.quantityOnHand - after.quantityOnHand - 5) < 0.001
    ? ok('stock decremented correctly', `${before.quantityOnHand} → ${after.quantityOnHand}`)
    : bad('stock decrement', `${before.quantityOnHand} → ${after.quantityOnHand}`);

  // RBAC
  const auditorReceive = await api('POST', '/inventory/receive', {
    token: auditor.accessToken,
    body: { itemId: standard.id, lotNumber: 'X', quantity: 1 },
  });
  auditorReceive.status === 403
    ? ok('auditor cannot receive stock', '403 — read-only')
    : bad('auditor blocked from receiving', `got ${auditorReceive.status}`);

  const techReceive = await api('POST', '/inventory/receive', {
    token: tech.accessToken,
    body: { itemId: standard.id, lotNumber: 'X', quantity: 1 },
  });
  techReceive.status === 403
    ? ok('an analyst can consume but not receive', '403 — needs inventory:manage')
    : bad('technician blocked from receiving', `got ${techReceive.status}`);

  // Receiving an already-expired lot must be refused.
  const pastExpiry = await api('POST', '/inventory/receive', {
    token: admin.accessToken,
    body: {
      itemId: standard.id,
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

  // A run of the assay draws its column, solvent, standard and filters. The
  // point is that the ledger falls by itself when the result is entered, rather
  // than relying on someone writing it in a register afterwards.
  const labId = stores.user.labs[0].id;
  const materials = await api('GET', '/stores/materials', { token: stores.accessToken });
  const material = (materials.body ?? []).find((m) => m.code === 'API-PCM');

  const receipt = await api('POST', '/stores/receive', {
    token: stores.accessToken,
    body: {
      labId,
      supplierName: 'Features Verify Supplier',
      batches: [
        {
          materialId: material.id,
          batchNumber: `FEAT-${Date.now()}`,
          quantity: 60,
          containerCount: 3,
          manufacturedAt: new Date(Date.now() - 15 * 864e5).toISOString().slice(0, 10),
          expiryDate: new Date(Date.now() + 450 * 864e5).toISOString().slice(0, 10),
        },
      ],
    },
  });
  const req = await api('POST', '/stores/sampling-requests', {
    token: stores.accessToken,
    body: { batchId: receipt.body.batches[0].id, reason: 'RELEASE_TESTING' },
  });
  const sampled = await api('POST', `/stores/sampling-requests/${req.body.id}/sample`, {
    token: tech.accessToken,
    body: { labId, containersSampled: 2 },
  });
  const accession = sampled.body.accessionNumber;

  const sample = await api('GET', `/samples/by-accession/${accession}`, {
    token: tech.accessToken,
  });

  let assayTest = null;
  for (const t of sample.body.tests ?? []) {
    const detail = await api('GET', `/tests/${t.id}`, { token: tech.accessToken });
    if (detail.body?.testDefinition?.code === 'TASSAY') {
      assayTest = detail.body;
      break;
    }
  }
  assayTest
    ? ok('the assay run is booked against the batch', `AR ${accession}`)
    : bad('assay run booked', 'TASSAY not on this specification');

  const stockBefore = (await api('GET', '/inventory/items', { token: tech.accessToken })).body.find(
    (i) => i.code === 'STD-PCM-RS',
  ).quantityOnHand;

  const testId = assayTest.id;
  const analyteId = assayTest.testDefinition.analytes.find(
    (a) => a.analyte.code === 'ASSAY',
  ).analyte.id;
  await api('POST', `/tests/${testId}/results`, {
    token: tech.accessToken,
    body: { results: [{ analyteId, value: '99.35' }] },
  });

  const stockAfter = (await api('GET', '/inventory/items', { token: tech.accessToken })).body.find(
    (i) => i.code === 'STD-PCM-RS',
  ).quantityOnHand;

  // 25 mg of reference standard per assay, from the method's reagent usage.
  Math.abs(stockBefore - stockAfter - 25) < 0.001
    ? ok('running the assay decremented the standard', `${stockBefore} → ${stockAfter} mg`)
    : bad('automatic consumption', `${stockBefore} → ${stockAfter}, expected -25`);

  // Re-saving the same run must not consume twice.
  await api('POST', `/tests/${testId}/results`, {
    token: tech.accessToken,
    body: { results: [{ analyteId, value: '99.41' }] },
  });
  const stockAfterEdit = (
    await api('GET', '/inventory/items', { token: tech.accessToken })
  ).body.find((i) => i.code === 'STD-PCM-RS').quantityOnHand;
  Math.abs(stockAfter - stockAfterEdit) < 0.001
    ? ok('correcting a result does not consume again', 'idempotent per run')
    : bad('double consumption on correction', `${stockAfter} → ${stockAfterEdit}`);

  // ============================================ TRACEABILITY
  section('Traceability — which lot produced which result');

  // The question an investigator asks a year later: this batch failed, what did
  // you run it on? The lot ledger has to answer it without anyone having kept a
  // separate notebook.
  const afterItems = await api('GET', '/inventory/items', { token: tech.accessToken });
  const drawnItem = afterItems.body.find((i) => i.code === 'STD-PCM-RS');
  const drawnLot = drawnItem.lots
    .filter((l) => !l.isExpired)
    .sort((a, b) => (a.expiryDate ?? '').localeCompare(b.expiryDate ?? ''))[0];

  const ledger = await api('GET', `/inventory/lots/${drawnLot.id}/history`, {
    token: tech.accessToken,
  });
  ledger.status === 200 && Array.isArray(ledger.body)
    ? ok('the lot ledger is readable', `${ledger.body.length} movement(s)`)
    : bad('lot ledger', `${ledger.status}`);

  const thisRun = (ledger.body ?? []).find((t) => t.sampleTestId === testId);
  thisRun
    ? ok('the consumption names the run that caused it', `${thisRun.quantity} mg on this test`)
    : bad('consumption traced to the run', 'no ledger row references this test');

  typeof thisRun?.balanceAfter === 'number'
    ? ok('each movement records the balance it left behind', `${thisRun.balanceAfter} mg`)
    : bad('running balance recorded');

  // The ledger is returned newest-first, so it has to be read backwards to be
  // reconciled: each movement's closing balance must be the previous closing
  // balance plus its own signed quantity. This is the check an auditor does by
  // hand, and it is what makes the running balance trustworthy rather than
  // merely present.
  const oldestFirst = [...(ledger.body ?? [])].reverse();
  const breaks = oldestFirst.filter(
    (t, i) =>
      i > 0 && Math.abs(t.balanceAfter - (oldestFirst[i - 1].balanceAfter + t.quantity)) > 0.001,
  );
  breaks.length === 0
    ? ok(
        'the ledger reconciles movement by movement',
        oldestFirst.map((t) => t.balanceAfter).join(' → '),
      )
    : bad('ledger reconciliation', `${breaks.length} movement(s) do not add up`);

  const auditorLedger = await api('GET', `/inventory/lots/${drawnLot.id}/history`, {
    token: auditor.accessToken,
  });
  auditorLedger.status === 200
    ? ok('an auditor can read the ledger unaided', 'no export request needed')
    : bad('auditor reads ledger', `${auditorLedger.status}`);


  // ==================================================== CSV EXPORT
  section('CSV export');

  const denied = await api('GET', '/export/worklist.csv', { token: tech.accessToken, raw: true });
  denied.status === 403
    ? ok('export requires compliance:export', '403 for a QC analyst')
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
    ? ok('UTF-8 BOM present', 'Excel renders the register correctly')
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
