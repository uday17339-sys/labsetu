#!/usr/bin/env node
/**
 * Manufacturing QC: stores, specifications, QC testing, QA disposition.
 *
 * The controls this suite exists to prove actually fire:
 *
 *   - quarantined material cannot be issued, whatever stores wants
 *   - a batch with no approved specification cannot be sampled at all
 *   - QC cannot release; QA cannot generate the result it releases
 *   - an out-of-spec value opens an OOS investigation with nobody choosing to
 *   - an open OOS blocks disposition
 *   - a critical excursion cannot be dispositioned around
 *   - a certificate of analysis cannot be issued for unreleased material
 *
 * Usage: node scripts/pharma-verify.mjs [apiBase]
 */
const API = process.argv[2] ?? 'http://localhost:4000';
const TENANT = 'VANTAGE';
const PASSWORD = 'LabSetu@2026';

let passed = 0;
const failures = [];

const ok = (name, detail = '') => {
  passed++;
  console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
};
const bad = (name, detail = '') => {
  failures.push({ name, detail });
  console.log(`  \x1b[31mFAIL\x1b[0m  ${name}  \x1b[2m${detail}\x1b[0m`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { token, body } = {}, attempt = 0) {
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
  return { status: res.status, body: json };
}

const login = (email) =>
  api('POST', '/auth/login', { body: { tenantCode: TENANT, email, password: PASSWORD } }).then(
    (r) => r.body,
  );

const uniq = () => Date.now().toString().slice(-6) + Math.floor(Math.random() * 90 + 10);

// ---------------------------------------------------------------------------

const admin = await login('admin@vantage.test');
const stores = await login('stores@vantage.test');
const qc = await login('qc@vantage.test');
const qa = await login('qa@vantage.test');

if (!stores?.accessToken || !qc?.accessToken || !qa?.accessToken) {
  console.error(
    'Manufacturing staff are not seeded. Run: npm run db:sync-roles && npm run db:seed-pharma',
  );
  process.exit(1);
}

// ===========================================================================
section('Role separation — the reason QA exists apart from QC');

const perms = {
  stores: stores.user.permissions,
  qc: qc.user.permissions,
  qa: qa.user.permissions,
};

!perms.stores.includes('batch:disposition')
  ? ok('stores CANNOT release material', 'it segregates quarantine, it does not judge it')
  : bad('stores separation', 'stores holds batch:disposition');

!perms.qc.includes('batch:disposition')
  ? ok('QC CANNOT release material', 'produces the result, not its consequence')
  : bad('QC separation', 'QC holds batch:disposition');

!perms.qc.includes('result:authorize')
  ? ok('QC CANNOT authorise its own result', 'four eyes, same as diagnostics')
  : bad('QC authorise separation', 'QC holds result:authorize');

!perms.qa.includes('result:enter')
  ? ok('QA CANNOT enter a result', 'it must not generate the number it releases')
  : bad('QA separation', 'QA holds result:enter');

perms.qa.includes('batch:disposition') && perms.qa.includes('spec:approve')
  ? ok('QA holds disposition and specification approval')
  : bad('QA permissions', 'missing disposition or spec approval');

!perms.qc.includes('spec:approve')
  ? ok('QC cannot approve the criteria it tests against')
  : bad('spec approval separation', 'QC holds spec:approve');

// ===========================================================================
section('Stores — goods receipt and the quarantine gate');

const materials = await api('GET', '/stores/materials', { token: stores.accessToken });
materials.status === 200 && materials.body.length > 0
  ? ok('the material master is readable', `${materials.body.length} materials`)
  : bad('materials listed', `${materials.status}`);

const api_pcm = materials.body.find((m) => m.code === 'API-PCM') ?? materials.body[0];

const refData = await api('GET', '/catalog/reference-data', { token: stores.accessToken });
const labId = refData.body?.labs?.[0]?.id;

const batchNumber = `VER-${uniq()}`;
const received = await api('POST', '/stores/receive', {
  token: stores.accessToken,
  body: {
    labId,
    supplierName: 'Verification Supplier Pvt Ltd',
    invoiceRef: `INV/${uniq()}`,
    receiptCheckNote: 'Seals intact, containers undamaged.',
    batches: [
      {
        materialId: api_pcm.id,
        batchNumber,
        manufacturerLot: `LOT/${uniq()}`,
        quantity: 100,
        containerCount: 4,
        manufacturedAt: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10),
        expiryDate: new Date(Date.now() + 700 * 864e5).toISOString().slice(0, 10),
      },
    ],
  },
});
received.status === 201
  ? ok('a consignment can be booked in', `${received.body.grnNumber}`)
  : bad('goods received', `${received.status} ${JSON.stringify(received.body).slice(0, 110)}`);

const newBatchId = received.body?.batches?.[0]?.id;
received.body?.batches?.[0]?.status === 'QUARANTINE'
  ? ok('everything received lands in QUARANTINE', 'the status is not a parameter')
  : bad('quarantine on receipt', `${received.body?.batches?.[0]?.status}`);

// THE CONTROL: quarantined material cannot reach the factory floor.
const issueQuarantined = await api('POST', `/stores/batches/${newBatchId}/issue`, {
  token: stores.accessToken,
  body: { quantity: 10, reference: 'BMR/VERIFY/001' },
});
issueQuarantined.status === 400 && /quarantined|approved/i.test(issueQuarantined.body?.detail ?? '')
  ? ok('issuing QUARANTINED material REFUSED', issueQuarantined.body.detail.slice(0, 62))
  : bad('quarantine gate', `${issueQuarantined.status} ${JSON.stringify(issueQuarantined.body).slice(0, 90)}`);

const expiredReceipt = await api('POST', '/stores/receive', {
  token: stores.accessToken,
  body: {
    labId,
    supplierName: 'Verification Supplier Pvt Ltd',
    batches: [
      {
        materialId: api_pcm.id,
        batchNumber: `EXP-${uniq()}`,
        quantity: 10,
        expiryDate: '2020-01-01',
      },
    ],
  },
});
expiredReceipt.status === 400
  ? ok('receiving already-expired material REFUSED', 'reject it at the gate')
  : bad('expired receipt refused', `${expiredReceipt.status}`);

const dupe = await api('POST', '/stores/receive', {
  token: stores.accessToken,
  body: {
    labId,
    supplierName: 'Verification Supplier Pvt Ltd',
    batches: [{ materialId: api_pcm.id, batchNumber, quantity: 10 }],
  },
});
dupe.status === 400
  ? ok('a duplicate batch number is refused', 'it appears on every recall notice')
  : bad('duplicate batch refused', `${dupe.status}`);

// ===========================================================================
section('Specifications — the controlled document');

const specs = await api('GET', '/specifications', { token: qa.accessToken });
specs.status === 200 && specs.body.length > 0
  ? ok('specifications are readable', `${specs.body.length} on file`)
  : bad('specifications listed', `${specs.status}`);

const inForce = specs.body.filter((s) => s.inForce);
inForce.length > 0
  ? ok('at least one specification is in force', inForce.map((s) => s.code).join(', '))
  : bad('specification in force', 'none');

const analytes = await api('GET', '/catalog/analytes', { token: qa.accessToken });
const someAnalyte = analytes.body?.find((a) => a.valueType === 'NUMERIC') ?? analytes.body?.[0];

// A throwaway material for the specification-lifecycle checks.
//
// An earlier version drafted these against API-PCM and then approved one —
// which SUPERSEDED the real seven-criterion specification, leaving every batch
// of paracetamol judged against a single made-up limit. The product did exactly
// what it should; the test was writing over the thing it was testing.
const specMaterial = await api('POST', '/stores/materials', {
  token: admin.accessToken,
  body: {
    code: `SPECMAT${uniq()}`,
    name: 'Specification Lifecycle Test Material',
    type: 'RAW_MATERIAL',
    unit: 'kg',
  },
});

const emptyCriterion = await api('POST', '/specifications', {
  token: qa.accessToken,
  body: {
    materialId: specMaterial.body.id,
    code: `SPEC/VER/${uniq()}`,
    limits: [{ analyteId: someAnalyte.id }],
  },
});
emptyCriterion.status === 400
  ? ok('a criterion with no limit and no text REFUSED', 'it would print blank on the CoA')
  : bad('empty criterion refused', `${emptyCriterion.status}`);

const draft = await api('POST', '/specifications', {
  token: qa.accessToken,
  body: {
    materialId: specMaterial.body.id,
    code: `SPEC/VER/${uniq()}`,
    basis: 'Verification run',
    limits: [{ analyteId: someAnalyte.id, minValue: 99, maxValue: 101, isCritical: true }],
  },
});
draft.status === 201 && draft.body.status === 'DRAFT'
  ? ok('a new specification starts as a DRAFT', 'it governs nothing yet')
  : bad('spec created as draft', `${draft.status} ${JSON.stringify(draft.body).slice(0, 100)}`);

// THE CONTROL: the author cannot be the sole approver.
const selfApprove = await api('POST', `/specifications/${draft.body.id}/approve`, {
  token: qa.accessToken,
  body: { note: 'Attempting to approve my own draft' },
});
selfApprove.status === 400 && /authored/i.test(selfApprove.body?.detail ?? '')
  ? ok('approving your OWN specification REFUSED', 'acceptance criteria need a second pair of eyes')
  : bad('self-approval refused', `${selfApprove.status} ${JSON.stringify(selfApprove.body).slice(0, 90)}`);

const qcApprove = await api('POST', `/specifications/${draft.body.id}/approve`, {
  token: qc.accessToken,
  body: { note: 'QC attempting to approve the criteria it tests against' },
});
qcApprove.status === 403
  ? ok('QC cannot approve a specification', '403')
  : bad('spec approve permissioned', `${qcApprove.status}`);

const adminApprove = await api('POST', `/specifications/${draft.body.id}/approve`, {
  token: admin.accessToken,
  body: { note: 'Reviewed against the IP monograph and the registered dossier.' },
});
adminApprove.status === 201 || adminApprove.status === 200
  ? ok('a second approver can approve it', `superseded ${adminApprove.body.superseded?.length ?? 0}`)
  : bad('spec approved', `${adminApprove.status} ${JSON.stringify(adminApprove.body).slice(0, 100)}`);

// ===========================================================================
section('Sampling — the handover from stores to QC');

const noSpecMaterial = await api('POST', '/stores/materials', {
  token: admin.accessToken,
  body: {
    code: `NOSPEC${uniq()}`,
    name: 'Material With No Specification',
    type: 'RAW_MATERIAL',
    unit: 'kg',
  },
});
const noSpecReceipt = await api('POST', '/stores/receive', {
  token: stores.accessToken,
  body: {
    labId,
    supplierName: 'Verification Supplier Pvt Ltd',
    batches: [
      { materialId: noSpecMaterial.body.id, batchNumber: `NS-${uniq()}`, quantity: 5 },
    ],
  },
});

// THE CONTROL: testing against nothing looks like testing.
const noSpecBatchId = noSpecReceipt.body?.batches?.[0]?.id;
if (noSpecBatchId) {
  const sampleWithoutSpec = await api('POST', '/stores/sampling-requests', {
    token: stores.accessToken,
    body: { batchId: noSpecBatchId, reason: 'RELEASE_TESTING' },
  });
  sampleWithoutSpec.status === 400 && /specification/i.test(sampleWithoutSpec.body?.detail ?? '')
    ? ok('sampling with NO approved specification REFUSED', 'QC would have nothing to judge against')
    : bad('spec-required gate', `${sampleWithoutSpec.status} ${JSON.stringify(sampleWithoutSpec.body).slice(0, 90)}`);
} else {
  bad('spec-required gate', `could not receive the no-spec batch: ${JSON.stringify(noSpecReceipt.body).slice(0, 110)}`);
}

const request = await api('POST', '/stores/sampling-requests', {
  token: stores.accessToken,
  body: { batchId: newBatchId, reason: 'RELEASE_TESTING', note: 'Verification run' },
});
request.status === 201
  ? ok('stores can request QC sampling', `${request.body.requestNumber}`)
  : bad('sampling requested', `${request.status} ${JSON.stringify(request.body).slice(0, 110)}`);

const dupeRequest = await api('POST', '/stores/sampling-requests', {
  token: stores.accessToken,
  body: { batchId: newBatchId, reason: 'RELEASE_TESTING' },
});
dupeRequest.status === 400
  ? ok('a second pending request is refused', 'QC would draw the same material twice')
  : bad('duplicate request refused', `${dupeRequest.status}`);

const storesSamples = await api('POST', `/stores/sampling-requests/${request.body.id}/sample`, {
  token: stores.accessToken,
  body: { labId },
});
storesSamples.status === 403
  ? ok('stores cannot perform the sampling itself', '403 — that is QC')
  : bad('sampling permissioned', `${storesSamples.status}`);

const sampled = await api('POST', `/stores/sampling-requests/${request.body.id}/sample`, {
  token: qc.accessToken,
  body: { labId, containersSampled: 3, quantitySampled: 0.3, note: 'Verification' },
});
sampled.status === 201
  ? ok('QC samples and raises the test order', `${sampled.body.accessionNumber}`)
  : bad('sampling performed', `${sampled.status} ${JSON.stringify(sampled.body).slice(0, 110)}`);

sampled.body?.batchStatus === 'UNDER_TEST'
  ? ok('the batch moves to UNDER_TEST', 'still not issuable, but the store knows why')
  : bad('batch under test', `${sampled.body?.batchStatus}`);

// The batch travels the SAME spine as a patient sample.
const sample = await api('GET', `/samples/by-accession/${sampled.body.accessionNumber}`, {
  token: qc.accessToken,
});
sample.status === 200 && sample.body.tests.length > 0
  ? ok('the batch enters the ordinary sample spine', `${sample.body.tests.length} test(s) booked`)
  : bad('sample reachable', `${sample.status}`);

// ===========================================================================
section('QC testing and the automatic OOS');

// Sampling creates one sample test per test in the specification, so tests[0]
// is whichever sorts first — Description, whose only analyte is DESC. Driving
// ASSAY out of specification requires the test that actually MEASURES assay.
// Taking [0] silently entered a description and then reported the OOS engine as
// broken when nothing out of specification had been entered at all.
let testId = null;
let testAnalytes = [];
for (const candidate of sample.body?.tests ?? []) {
  const detail = await api('GET', `/tests/${candidate.id}`, { token: qc.accessToken });
  const analytes = detail.body?.testDefinition?.analytes ?? [];
  if (analytes.some((a) => a.analyte.code === 'ASSAY')) {
    testId = candidate.id;
    testAnalytes = analytes;
    break;
  }
}

testId
  ? ok('found the assay test on the sample', `${testAnalytes.length} parameters`)
  : bad('assay test present', 'the specification produced no test measuring ASSAY');

// The spec in force for the BATCH's material. The approval section above
// deliberately creates a spec against a scratch material so it can exercise
// self-approval refusal without disturbing the real one.
const freshSpecs = await api('GET', '/specifications', { token: qa.accessToken });
const specForMaterial = (freshSpecs.body ?? specs.body).find(
  (s) => s.material.code === api_pcm.code && s.inForce,
);
const specDetail = specForMaterial
  ? await api('GET', `/specifications/${specForMaterial.id}`, { token: qc.accessToken })
  : { body: { limits: [] } };
const limitByCode = new Map(
  (specDetail.body.limits ?? []).map((l) => [l.analyte.code, l]),
);

// Deliberately drive ASSAY out of specification: the point is to prove the
// investigation opens by itself, not that a good batch passes.
const values = testAnalytes.map((a) => {
  const code = a.analyte.code;
  const limit = limitByCode.get(code);
  if (code === 'ASSAY') return { analyteId: a.analyte.id, value: '96.20' };
  if (limit?.minValue != null && limit?.maxValue != null) {
    return { analyteId: a.analyte.id, value: String((limit.minValue + limit.maxValue) / 2) };
  }
  if (limit?.maxValue != null) return { analyteId: a.analyte.id, value: String(limit.maxValue / 2) };
  if (limit?.minValue != null) return { analyteId: a.analyte.id, value: String(limit.minValue) };
  return { analyteId: a.analyte.id, value: 'Complies' };
});

const entered = await api('POST', `/tests/${testId}/results`, {
  token: qc.accessToken,
  body: { results: values },
});
entered.status === 201 || entered.status === 200
  ? ok('QC enters results against the specification', `${values.length} parameters`)
  : bad('results entered', `${entered.status} ${JSON.stringify(entered.body).slice(0, 110)}`);

// THE CONTROL: nobody chose to raise this.
const oosOpened = entered.body?.oosInvestigationsOpened ?? [];
oosOpened.length > 0
  ? ok('an out-of-spec value opens an OOS AUTOMATICALLY', oosOpened.join(', '))
  : bad('OOS auto-opened', 'no investigation was raised for an assay of 96.20 against 99-101');

const investigations = await api('GET', '/qa/investigations?status=OPEN', { token: qa.accessToken });
const ourOos = (investigations.body ?? []).find((i) => oosOpened.includes(i.investigationNumber));
ourOos
  ? ok('it appears on the QA investigation queue', `${ourOos.analyteCode} ${ourOos.observedValue}`)
  : bad('OOS on the queue', JSON.stringify(investigations.body).slice(0, 110));

const qcCloseOos = ourOos
  ? await api('POST', `/qa/investigations/${ourOos.id}/close`, {
      token: qc.accessToken,
      body: {
        conclusion: 'LAB_ERROR_CONFIRMED',
        rootCause: 'QC attempting to close its own investigation',
        correctiveAction: 'Should be refused',
      },
    })
  : { status: 0 };
qcCloseOos.status === 403
  ? ok('QC cannot close its own OOS investigation', '403')
  : bad('OOS permissioned', `${qcCloseOos.status}`);

// ===========================================================================
section('QA disposition — the gate to the factory floor');

const review = await api('GET', `/qa/batches/${newBatchId}/review`, { token: qa.accessToken });
review.status === 200
  ? ok(
      'QA sees every result judged against the specification',
      `${review.body.summary.passed}/${review.body.summary.criteria} pass, ${review.body.summary.failed} fail`,
    )
  : bad('QA review', `${review.status}`);

review.body?.blockers?.length > 0
  ? ok('the blockers are stated up front', review.body.blockers[0].slice(0, 58))
  : bad('blockers surfaced', 'none listed despite an open OOS');

async function signAndDispose(token, decision, rationale, extra = {}) {
  const hash = await api('GET', `/qa/batches/${newBatchId}/content-hash`, { token });
  const tok = await api('POST', '/auth/signing-token', {
    token,
    body: {
      password: PASSWORD,
      entityType: 'MaterialBatch',
      entityId: newBatchId,
      meaning: decision === 'REJECTED' ? 'REJECTED' : 'APPROVED',
      contentHash: hash.body?.contentHash,
    },
  });
  return api('POST', `/qa/batches/${newBatchId}/disposition`, {
    token,
    body: { decision, rationale, signingToken: tok.body?.signingToken, ...extra },
  });
}

const qcDispose = await signAndDispose(
  qc.accessToken,
  'APPROVED',
  'QC attempting to release the batch it tested',
);
qcDispose.status === 403
  ? ok('QC cannot disposition a batch', '403 — the whole point of a separate QA')
  : bad('disposition permissioned', `${qcDispose.status}`);

// THE CONTROL: an open investigation blocks release.
const blockedByOos = await signAndDispose(
  qa.accessToken,
  'APPROVED',
  'Attempting release while the investigation is still open',
);
blockedByOos.status === 400 && /investigation/i.test(blockedByOos.body?.detail ?? '')
  ? ok('release REFUSED while an OOS is open', blockedByOos.body.detail.slice(0, 62))
  : bad('OOS blocks release', `${blockedByOos.status} ${JSON.stringify(blockedByOos.body).slice(0, 90)}`);

// "No assignable cause" cannot be reached from Phase I alone.
const shortcut = ourOos
  ? await api('POST', `/qa/investigations/${ourOos.id}/close`, {
      token: qa.accessToken,
      body: {
        conclusion: 'NO_ASSIGNABLE_CAUSE',
        rootCause: 'Attempting to close out of Phase I without escalating',
        correctiveAction: 'Should be refused',
      },
    })
  : { status: 0 };
shortcut.status === 400 && /phase ii/i.test(shortcut.body?.detail ?? '')
  ? ok('"no assignable cause" from Phase I REFUSED', 'inspectors examine this conclusion hardest')
  : bad('OOS phase gate', `${shortcut.status} ${JSON.stringify(shortcut.body ?? {}).slice(0, 90)}`);

if (ourOos) {
  await api('POST', `/qa/investigations/${ourOos.id}/progress`, {
    token: qa.accessToken,
    body: {
      phase: 'PHASE_II',
      labInvestigationNote: 'Phase I: chromatography reviewed, standards in date, no lab error found.',
    },
  });
  const closed = await api('POST', `/qa/investigations/${ourOos.id}/close`, {
    token: qa.accessToken,
    body: {
      conclusion: 'MANUFACTURING_CONFIRMED',
      rootCause: 'Supplier process drift confirmed against their retained sample.',
      correctiveAction: 'Consignment returned to supplier; incoming assay tightened for this vendor.',
    },
  });
  closed.status === 201 || closed.status === 200
    ? ok('the investigation can be closed with a root cause and CAPA')
    : bad('OOS closed', `${closed.status} ${JSON.stringify(closed.body).slice(0, 100)}`);
}

// THE CONTROL: a critical excursion cannot be dispositioned around.
const criticalBlock = await signAndDispose(
  qa.accessToken,
  'APPROVED_WITH_DEVIATION',
  'Attempting to release despite a critical parameter out of specification',
  { deviationRef: 'DEV/VERIFY/001' },
);
criticalBlock.status === 400 && /critical/i.test(criticalBlock.body?.detail ?? '')
  ? ok('releasing on a CRITICAL excursion REFUSED', criticalBlock.body.detail.slice(0, 60))
  : bad('critical gate', `${criticalBlock.status} ${JSON.stringify(criticalBlock.body).slice(0, 90)}`);

const rejected = await signAndDispose(
  qa.accessToken,
  'REJECTED',
  'Assay 96.20% against a limit of 99.0 to 101.0%. Root cause confirmed as supplier process drift; consignment returned.',
);
rejected.status === 201 || rejected.status === 200
  ? ok('QA can reject the batch, signed', `status ${rejected.body.status}`)
  : bad('batch rejected', `${rejected.status} ${JSON.stringify(rejected.body).slice(0, 110)}`);

const issueRejected = await api('POST', `/stores/batches/${newBatchId}/issue`, {
  token: stores.accessToken,
  body: { quantity: 1, reference: 'BMR/VERIFY/002' },
});
issueRejected.status === 400 && /rejected/i.test(issueRejected.body?.detail ?? '')
  ? ok('issuing REJECTED material REFUSED', issueRejected.body.detail.slice(0, 56))
  : bad('rejected gate', `${issueRejected.status} ${JSON.stringify(issueRejected.body ?? {}).slice(0, 160)}`);

const coaOnRejected = await api('POST', `/qa/batches/${newBatchId}/coa`, { token: qa.accessToken });
coaOnRejected.status === 400
  ? ok('a CoA for REJECTED material REFUSED', 'that document should not exist')
  : bad('CoA gate', `${coaOnRejected.status}`);

// ===========================================================================
section('A clean batch through to release');

const cleanBatchNumber = `CLEAN-${uniq()}`;
const cleanReceipt = await api('POST', '/stores/receive', {
  token: stores.accessToken,
  body: {
    labId,
    supplierName: 'Verification Supplier Pvt Ltd',
    batches: [
      {
        materialId: api_pcm.id,
        batchNumber: cleanBatchNumber,
        quantity: 200,
        containerCount: 8,
        manufacturedAt: new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10),
        expiryDate: new Date(Date.now() + 700 * 864e5).toISOString().slice(0, 10),
      },
    ],
  },
});
const cleanId = cleanReceipt.body?.batches?.[0]?.id;

const cleanReq = await api('POST', '/stores/sampling-requests', {
  token: stores.accessToken,
  body: { batchId: cleanId, reason: 'RELEASE_TESTING' },
});
const cleanSampled = await api('POST', `/stores/sampling-requests/${cleanReq.body.id}/sample`, {
  token: qc.accessToken,
  body: { labId, containersSampled: 4 },
});
const cleanSample = await api('GET', `/samples/by-accession/${cleanSampled.body.accessionNumber}`, {
  token: qc.accessToken,
});
// A specification produces one test per group of criteria, so releasing a batch
// means completing ALL of them. Filling only tests[0] left 7 criteria untested,
// and the release gate correctly refused — the gate was right and the test was
// filling in one eighth of the work.
const cleanTests = cleanSample.body?.tests ?? [];
const falseOos = [];

for (const t of cleanTests) {
  const detail = await api('GET', `/tests/${t.id}`, { token: qc.accessToken });
  const values = (detail.body?.testDefinition?.analytes ?? []).map((a) => {
    const limit = limitByCode.get(a.analyte.code);
    if (limit?.minValue != null && limit?.maxValue != null) {
      return { analyteId: a.analyte.id, value: String((limit.minValue + limit.maxValue) / 2) };
    }
    if (limit?.maxValue != null) return { analyteId: a.analyte.id, value: String(limit.maxValue / 2) };
    if (limit?.minValue != null) return { analyteId: a.analyte.id, value: String(limit.minValue) };
    return { analyteId: a.analyte.id, value: 'Complies' };
  });
  if (values.length === 0) continue;

  const res = await api('POST', `/tests/${t.id}/results`, {
    token: qc.accessToken,
    body: { results: values },
  });
  falseOos.push(...(res.body?.oosInvestigationsOpened ?? []));

  await api('POST', `/tests/${t.id}/verify`, { token: qc.accessToken, body: {} });
}

falseOos.length === 0
  ? ok('an in-specification batch opens NO investigation', 'the detector is not trigger-happy')
  : bad('no false OOS', falseOos.join(', '));

// Every test needs its own signature: a signing token is bound to one record.
let authorisedCount = 0;
for (const t of cleanTests) {
  const hash = await api('GET', `/tests/${t.id}/content-hash`, { token: qa.accessToken });
  const tok = await api('POST', '/auth/signing-token', {
    token: qa.accessToken,
    body: {
      password: PASSWORD,
      entityType: 'SampleTest',
      entityId: t.id,
      meaning: 'AUTHORIZED',
      contentHash: hash.body?.contentHash,
    },
  });
  const r = await api('POST', `/tests/${t.id}/authorize`, {
    token: qa.accessToken,
    body: { signingToken: tok.body?.signingToken, meaning: 'AUTHORIZED' },
  });
  if (r.status === 200 || r.status === 201) authorisedCount++;
}

authorisedCount === cleanTests.length
  ? ok('QA authorises every analytical result', `${authorisedCount} tests signed`)
  : bad('result authorised', `${authorisedCount} of ${cleanTests.length} authorised`);

const released = await (async () => {
  const hash = await api('GET', `/qa/batches/${cleanId}/content-hash`, { token: qa.accessToken });
  const tok = await api('POST', '/auth/signing-token', {
    token: qa.accessToken,
    body: {
      password: PASSWORD,
      entityType: 'MaterialBatch',
      entityId: cleanId,
      meaning: 'APPROVED',
      contentHash: hash.body?.contentHash,
    },
  });
  return api('POST', `/qa/batches/${cleanId}/disposition`, {
    token: qa.accessToken,
    body: {
      decision: 'APPROVED',
      rationale:
        'All critical parameters within specification. Reviewed against the supplier CoA and in-house testing.',
      signingToken: tok.body?.signingToken,
    },
  });
})();
released.status === 201 || released.status === 200
  ? ok('QA releases the batch, signed', `status ${released.body.status}`)
  : bad('batch released', `${released.status} ${JSON.stringify(released.body).slice(0, 120)}`);

released.body?.isIssuable
  ? ok('and only now is it issuable')
  : bad('issuable after release', `${released.body?.isIssuable}`);

const issued = await api('POST', `/stores/batches/${cleanId}/issue`, {
  token: stores.accessToken,
  body: { quantity: 50, reference: 'BMR/2026/0412 — Paracetamol 500mg' },
});
issued.status === 201 || issued.status === 200
  ? ok('stores issues APPROVED material to production', `${issued.body.remaining} kg remaining`)
  : bad('material issued', `${issued.status} ${JSON.stringify(issued.body ?? {}).slice(0, 200)}`);

const overIssue = await api('POST', `/stores/batches/${cleanId}/issue`, {
  token: stores.accessToken,
  body: { quantity: 10_000, reference: 'BMR/VERIFY/003' },
});
overIssue.status === 400
  ? ok('issuing more than remains is refused')
  : bad('over-issue refused', `${overIssue.status}`);

const coa = await api('POST', `/qa/batches/${cleanId}/coa`, { token: qa.accessToken });
coa.status === 201 || coa.status === 200
  ? ok('a certificate of analysis is issued for the released batch', coa.body.coaNumber)
  : bad('CoA issued', `${coa.status} ${JSON.stringify(coa.body ?? {}).slice(0, 200)}`);

const coaDoc = await api('GET', `/qa/coa/${coa.body?.id}`, { token: qa.accessToken });
coaDoc.status === 200 && coaDoc.body.results.length > 0
  ? ok('the certificate prints the criteria and the results', `${coaDoc.body.results.length} parameters`)
  : bad('CoA content', `${coaDoc.status}`);

// ===========================================================================
section('The audit trail spans both worlds');

const chain = await api('GET', '/compliance/audit-chain/verify', { token: admin.accessToken });
chain.body?.status === 'PASSED'
  ? ok('the hash chain still verifies', `${chain.body.entriesChecked} entries`)
  : bad('audit chain', JSON.stringify(chain.body).slice(0, 110));

const dispositionAudit = await api(
  'GET',
  `/compliance/audit/MaterialBatch/${cleanId}`,
  { token: admin.accessToken },
);
const entries = Array.isArray(dispositionAudit.body?.items)
  ? dispositionAudit.body.items
  : Array.isArray(dispositionAudit.body)
    ? dispositionAudit.body
    : [];
entries.some((e) => JSON.stringify(e.after ?? {}).includes('QA_DISPOSITION'))
  ? ok('the disposition is in the audit trail', 'with the criteria assessed and the signature')
  : bad('disposition audited', `status ${dispositionAudit.status}, ${entries.length} entries, ${JSON.stringify(dispositionAudit.body ?? {}).slice(0, 140)}`);

// ===========================================================================
console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
if (failures.length > 0) {
  console.log('\n\x1b[31mFailures:\x1b[0m');
  for (const f of failures) console.log(`  - ${f.name} — ${f.detail}`);
  process.exit(1);
}
