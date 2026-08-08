#!/usr/bin/env node
/**
 * End-to-end smoke test — pharmaceutical manufacturing QC.
 *
 * Drives the real workflow (goods receipt → sampling → results → verify →
 * authorise → batch disposition → issue) and asserts the compliance controls
 * actually FIRE, rather than assuming they do:
 *
 *   - a QC analyst CANNOT authorise a result, nor release the batch they tested
 *   - authorisation without a valid signature is refused
 *   - a signature bound to stale content is refused
 *   - quarantined material cannot reach production
 *   - state transitions are enforced, not merely suggested
 *   - the audit trail carries no secrets and its hash chain verifies
 *
 * pharma-verify.mjs covers the stores/QA lifecycle in breadth. This suite is
 * the controls-and-integrity pass over the same spine.
 *
 * Usage: node scripts/smoke-test.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://localhost:4000';
const TENANT = 'VANTAGE';
const PASSWORD = 'LabSetu@2026';

let passed = 0;
let failed = 0;
const failures = [];

const ok = (l, d = '') => {
  passed++;
  console.log(`  \x1b[32mPASS\x1b[0m  ${l}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};
const bad = (l, d = '') => {
  failed++;
  failures.push(`${l}${d ? ` — ${d}` : ''}`);
  console.log(`  \x1b[31mFAIL\x1b[0m  ${l}${d ? `  \x1b[2m${d}\x1b[0m` : ''}`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { token, body } = {}, attempt = 0) {
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  // Completing every criterion on a batch legitimately exceeds 120/min. A
  // well-behaved client backs off rather than the server relaxing its guard.
  if (res.status === 429 && attempt < 3) {
    await sleep(21_000);
    return api(method, path, { token, body }, attempt + 1);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function login(email) {
  const res = await api('POST', '/auth/login', {
    body: { tenantCode: TENANT, email, password: PASSWORD },
  });
  if (res.status !== 200 || res.body?.status !== 'OK') {
    throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

const uniq = () => `${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;

async function main() {
  console.log(`\n\x1b[1mLabSetu smoke test — pharma QC\x1b[0m  →  ${BASE}\n`);

  section('Infrastructure');
  const health = await fetch(`${BASE}/v1/ready`).then((r) => r.json());
  health.checks?.database === 'up'
    ? ok('database reachable', `region ${health.region}`)
    : bad('database reachable', JSON.stringify(health));

  // ------------------------------------------------------------------ auth
  section('Authentication & authorisation');

  const unauth = await api('GET', '/catalog/tests');
  unauth.status === 401
    ? ok('unauthenticated request rejected', '401')
    : bad('unauthenticated request rejected', `got ${unauth.status}`);

  const badPass = await api('POST', '/auth/login', {
    body: { tenantCode: TENANT, email: 'admin@vantage.test', password: 'wrong-password' },
  });
  badPass.status === 401
    ? ok('wrong password rejected', '401')
    : bad('wrong password rejected', `got ${badPass.status}`);

  const badTenant = await api('POST', '/auth/login', {
    body: { tenantCode: 'NOSUCHTENANT', email: 'admin@vantage.test', password: PASSWORD },
  });
  badTenant.status === 401
    ? ok('unknown tenant rejected', '401')
    : bad('unknown tenant rejected', `got ${badTenant.status}`);

  const admin = await login('admin@vantage.test');
  const qa = await login('qa@vantage.test');
  const qc = await login('qc@vantage.test');
  const stores = await login('stores@vantage.test');
  const auditor = await login('auditor@vantage.test');
  ok('all plant roles signed in', 'admin · QA · QC · stores · auditor');

  // The separation that matters in a GMP lab: whoever produces a result must
  // not be the person who releases it.
  qc.user.permissions.includes('result:authorize')
    ? bad('QC analyst must NOT hold result:authorize')
    : ok('QC analyst lacks result:authorize', 'approval is a QA act');

  qa.user.permissions.includes('result:authorize')
    ? ok('QA holds result:authorize')
    : bad('QA holds result:authorize');

  qc.user.permissions.includes('batch:disposition')
    ? bad('QC analyst must NOT be able to disposition a batch')
    : ok('QC analyst cannot disposition a batch', 'that is QA');

  stores.user.permissions.includes('stores:manage')
    ? ok('stores officer can receive consignments')
    : bad('stores can receive');

  // --------------------------------------------------------------- catalog
  section('Catalog & specifications');

  const tests = await api('GET', '/catalog/tests', { token: qc.accessToken });
  tests.status === 200 && tests.body.length >= 10
    ? ok('QC test catalog loaded', `${tests.body.length} tests`)
    : bad('test catalog loaded', JSON.stringify(tests.body).slice(0, 120));

  const assayTest = (tests.body ?? []).find((t) => t.code === 'TASSAY');
  assayTest?.department === 'INSTRUMENTATION'
    ? ok('tests carry pharma departments', 'Assay by HPLC → instrumentation')
    : bad('pharma departments', `assay department = ${assayTest?.department}`);

  const specs = await api('GET', '/specifications', { token: qc.accessToken });
  const inForce = (specs.body ?? []).filter((s) => s.inForce);
  inForce.length >= 5
    ? ok('approved specifications in force', `${inForce.length}`)
    : bad('specifications in force', `${inForce.length}`);

  // ------------------------------------------------------- receive a batch
  section('Goods receipt & sampling');

  const materials = await api('GET', '/stores/materials', { token: stores.accessToken });
  const pcm = (materials.body ?? []).find((m) => m.code === 'API-PCM');
  pcm ? ok('material master available', pcm.name) : bad('material master', 'API-PCM missing');

  const labId = admin.user.labs[0].id;
  const batchNumber = `SMK-${uniq()}`;

  const receipt = await api('POST', '/stores/receive', {
    token: stores.accessToken,
    body: {
      labId,
      supplierName: 'Smoke Test Supplier Pvt Ltd',
      batches: [
        {
          materialId: pcm.id,
          batchNumber,
          quantity: 120,
          containerCount: 6,
          manufacturedAt: new Date(Date.now() - 15 * 864e5).toISOString().slice(0, 10),
          expiryDate: new Date(Date.now() + 600 * 864e5).toISOString().slice(0, 10),
        },
      ],
    },
  });
  const batchId = receipt.body?.batches?.[0]?.id;
  batchId
    ? ok('consignment received into quarantine', batchNumber)
    : bad('consignment received', `${receipt.status} ${JSON.stringify(receipt.body).slice(0, 160)}`);

  // Quarantined material must not reach production.
  const prematureIssue = await api('POST', `/stores/batches/${batchId}/issue`, {
    token: stores.accessToken,
    body: { quantity: 10, reference: 'SMOKE-PREMATURE' },
  });
  prematureIssue.status === 400
    ? ok('quarantined material cannot be issued', 'only QA-released stock leaves the store')
    : bad('quarantine gate', `got ${prematureIssue.status}`);

  const request = await api('POST', '/stores/sampling-requests', {
    token: stores.accessToken,
    body: { batchId, reason: 'RELEASE_TESTING' },
  });
  request.body?.id
    ? ok('stores requests QC sampling', request.body.requestNumber)
    : bad('sampling requested', JSON.stringify(request.body).slice(0, 140));

  const storesSelfSample = await api(
    'POST',
    `/stores/sampling-requests/${request.body.id}/sample`,
    { token: stores.accessToken, body: { labId, containersSampled: 3 } },
  );
  storesSelfSample.status === 403
    ? ok('stores cannot sample its own consignment', '403 — that is QC')
    : bad('sampling separation', `got ${storesSelfSample.status}`);

  const sampled = await api('POST', `/stores/sampling-requests/${request.body.id}/sample`, {
    token: qc.accessToken,
    body: { labId, containersSampled: 3 },
  });
  const accession = sampled.body?.accessionNumber;
  accession
    ? ok('QC draws the sample', `AR ${accession}`)
    : bad('sampling performed', JSON.stringify(sampled.body).slice(0, 140));

  const sample = await api('GET', `/samples/by-accession/${accession}`, { token: qc.accessToken });
  const sampleTests = sample.body?.tests ?? [];
  sampleTests.length >= 5
    ? ok('specification produced the test set', `${sampleTests.length} tests booked`)
    : bad('tests booked from spec', `${sampleTests.length}`);

  // -------------------------------------------------------------- results
  section('Result entry against the specification');

  const pcmSpec = inForce.find((s) => s.material.code === 'API-PCM');
  const specDetail = await api('GET', `/specifications/${pcmSpec.id}`, { token: qc.accessToken });
  const limits = new Map((specDetail.body?.limits ?? []).map((l) => [l.analyte.code, l]));

  // Mid-range for a two-sided limit, comfortably inside a one-sided one.
  const passingValue = (code) => {
    const l = limits.get(code);
    if (l?.minValue != null && l?.maxValue != null) return String((l.minValue + l.maxValue) / 2);
    if (l?.maxValue != null) return String(l.maxValue / 2);
    if (l?.minValue != null) return String(l.minValue);
    return 'Complies';
  };

  let entered = 0;
  let assayTestId = null;
  for (const t of sampleTests) {
    const detail = await api('GET', `/tests/${t.id}`, { token: qc.accessToken });
    const analytes = detail.body?.testDefinition?.analytes ?? [];
    if (analytes.some((a) => a.analyte.code === 'ASSAY')) assayTestId = t.id;

    const res = await api('POST', `/tests/${t.id}/results`, {
      token: qc.accessToken,
      body: {
        results: analytes.map((a) => ({
          analyteId: a.analyte.id,
          value: passingValue(a.analyte.code),
        })),
      },
    });
    if (res.status === 200 || res.status === 201) entered++;
  }
  entered === sampleTests.length
    ? ok('results entered for every criterion', `${entered} tests`)
    : bad('results entered', `${entered} of ${sampleTests.length}`);

  assayTestId ? ok('assay test located on the sample') : bad('assay test present');

  const afterEntry = await api('GET', `/tests/${assayTestId}`, { token: qc.accessToken });
  afterEntry.body?.status === 'RESULT_ENTERED'
    ? ok('test moves to RESULT_ENTERED', 'never auto-approved')
    : bad('status after entry', afterEntry.body?.status);

  // --------------------------------------------- verification & signatures
  section('Verification, four-eyes and signatures');

  const verified = await api('POST', `/tests/${assayTestId}/verify`, {
    token: qc.accessToken,
    body: {},
  });
  verified.body?.status === 'TECH_VERIFIED'
    ? ok('QC technically verifies the result')
    : bad('technically verified', JSON.stringify(verified.body).slice(0, 140));

  const qcAuth = await api('POST', `/tests/${assayTestId}/authorize`, {
    token: qc.accessToken,
    body: { signingToken: 'fake', meaning: 'AUTHORIZED' },
  });
  qcAuth.status === 403
    ? ok('QC analyst blocked from authorising', '403 — RBAC')
    : bad('QC blocked from authorising', `got ${qcAuth.status}`);

  const noSig = await api('POST', `/tests/${assayTestId}/authorize`, {
    token: qa.accessToken,
    body: { signingToken: 'not-a-real-token', meaning: 'AUTHORIZED' },
  });
  [401, 403].includes(noSig.status)
    ? ok('authorisation refused without a valid signature', `${noSig.status}`)
    : bad('signature required', `got ${noSig.status}`);

  const hashRes = await api('GET', `/tests/${assayTestId}/content-hash`, { token: qa.accessToken });
  const contentHash = hashRes.body?.contentHash;
  /^[a-f0-9]{64}$/.test(contentHash ?? '')
    ? ok('content hash computed', `${contentHash.slice(0, 16)}…`)
    : bad('content hash', JSON.stringify(hashRes.body).slice(0, 120));

  const staleToken = await api('POST', '/auth/signing-token', {
    token: qa.accessToken,
    body: {
      password: PASSWORD,
      entityType: 'SampleTest',
      entityId: assayTestId,
      meaning: 'AUTHORIZED',
      contentHash: 'a'.repeat(64),
    },
  });
  const staleAuth = await api('POST', `/tests/${assayTestId}/authorize`, {
    token: qa.accessToken,
    body: { signingToken: staleToken.body?.signingToken, meaning: 'AUTHORIZED' },
  });
  staleAuth.status === 403
    ? ok('signature bound to stale content refused', 'the record changed since signing')
    : bad('stale-content signature refused', `got ${staleAuth.status}`);

  const wrongPw = await api('POST', '/auth/signing-token', {
    token: qa.accessToken,
    body: {
      password: 'not-my-password',
      entityType: 'SampleTest',
      entityId: assayTestId,
      meaning: 'AUTHORIZED',
      contentHash,
    },
  });
  wrongPw.status === 401
    ? ok('signing requires re-authentication', '401 on wrong password')
    : bad('re-authentication required', `got ${wrongPw.status}`);

  // Complete the batch: every criterion verified and signed.
  let authorised = 0;
  for (const t of sampleTests) {
    await api('POST', `/tests/${t.id}/verify`, { token: qc.accessToken, body: {} });
    const h = await api('GET', `/tests/${t.id}/content-hash`, { token: qa.accessToken });
    const tok = await api('POST', '/auth/signing-token', {
      token: qa.accessToken,
      body: {
        password: PASSWORD,
        entityType: 'SampleTest',
        entityId: t.id,
        meaning: 'AUTHORIZED',
        contentHash: h.body?.contentHash,
      },
    });
    const r = await api('POST', `/tests/${t.id}/authorize`, {
      token: qa.accessToken,
      body: { signingToken: tok.body?.signingToken, meaning: 'AUTHORIZED' },
    });
    if (r.status === 200 || r.status === 201) authorised++;
  }
  authorised === sampleTests.length
    ? ok('QA authorises every result with a signature', `${authorised} tests signed`)
    : bad('QA authorised', `${authorised} of ${sampleTests.length}`);

  // ------------------------------------------------------- QA disposition
  section('Batch disposition & release');

  const qcDisposition = await api('POST', `/qa/batches/${batchId}/disposition`, {
    token: qc.accessToken,
    body: { decision: 'APPROVED', rationale: 'QC attempting to release its own testing.' },
  });
  qcDisposition.status === 403
    ? ok('QC cannot release the batch it tested', '403 — separation of duties')
    : bad('disposition permissioned', `got ${qcDisposition.status}`);

  const batchHash = await api('GET', `/qa/batches/${batchId}/content-hash`, {
    token: qa.accessToken,
  });
  const batchTok = await api('POST', '/auth/signing-token', {
    token: qa.accessToken,
    body: {
      password: PASSWORD,
      entityType: 'MaterialBatch',
      entityId: batchId,
      meaning: 'APPROVED',
      contentHash: batchHash.body?.contentHash,
    },
  });
  const released = await api('POST', `/qa/batches/${batchId}/disposition`, {
    token: qa.accessToken,
    body: {
      decision: 'APPROVED',
      rationale:
        'All acceptance criteria met against the specification in force. Reviewed against the ' +
        'supplier certificate and in-house testing. Released for manufacturing use.',
      signingToken: batchTok.body?.signingToken,
    },
  });
  released.body?.status === 'APPROVED'
    ? ok('QA releases the batch, signed', batchNumber)
    : bad('batch released', `${released.status} ${JSON.stringify(released.body).slice(0, 160)}`);

  const issued = await api('POST', `/stores/batches/${batchId}/issue`, {
    token: stores.accessToken,
    body: { quantity: 20, reference: 'BMR/SMOKE/001' },
  });
  issued.status === 200 || issued.status === 201
    ? ok('and only now can stores issue it to production', '20 kg')
    : bad('material issued after release', JSON.stringify(issued.body).slice(0, 140));

  // ------------------------------------------------------------------ audit
  section('Audit trail & chain integrity');

  const history = await api('GET', `/compliance/audit/SampleTest/${assayTestId}`, {
    token: auditor.accessToken,
  });
  const actions = (history.body ?? []).map((h) => h.action);
  actions.includes('VERIFY') && actions.includes('AUTHORIZE')
    ? ok('full history recorded for the test', [...new Set(actions)].join(' → '))
    : bad('history recorded', JSON.stringify(actions));

  const authEntry = (history.body ?? []).find((h) => h.action === 'AUTHORIZE');
  authEntry?.actor && authEntry?.actorRole
    ? ok('audit entry is attributable', `${authEntry.actor} (${authEntry.actorRole})`)
    : bad('attributable', JSON.stringify(authEntry ?? {}).slice(0, 120));

  const chain = await api('GET', '/compliance/audit-chain/verify', { token: auditor.accessToken });
  chain.body?.status === 'PASSED'
    ? ok('audit chain verified', `${chain.body.entriesChecked} entries`)
    : bad('chain verified', JSON.stringify(chain.body).slice(0, 160));

  const search = await api('GET', '/compliance/audit?limit=200', { token: auditor.accessToken });
  const leaks = JSON.stringify(search.body).match(/LabSetu@2026|not-my-password/g);
  leaks
    ? bad('audit trail leaks secrets', [...new Set(leaks)].join(','))
    : ok('audit trail contains no secrets');

  const loginFailures = (search.body.items ?? []).filter((e) => e.action === 'LOGIN_FAILURE');
  loginFailures.length >= 1
    ? ok('failed sign-ins recorded', `${loginFailures.length} entries`)
    : bad('failed sign-ins recorded', 'expected at least one');

  const auditorWrite = await api('POST', '/stores/sampling-requests', {
    token: auditor.accessToken,
    body: { batchId, reason: 'RELEASE_TESTING' },
  });
  auditorWrite.status === 403
    ? ok('auditor is read-only', '403 on write')
    : bad('auditor read-only', `got ${auditorWrite.status}`);

  // ----------------------------------------------- state machine enforcement
  section('State machine enforcement');

  const reVerify = await api('POST', `/tests/${assayTestId}/verify`, {
    token: qc.accessToken,
    body: {},
  });
  reVerify.status === 400
    ? ok('invalid state transition rejected', 'AUTHORIZED → TECH_VERIFIED refused')
    : bad('invalid transition rejected', `got ${reVerify.status}`);

  const reDisposition = await api('POST', `/qa/batches/${batchId}/disposition`, {
    token: qa.accessToken,
    body: {
      decision: 'REJECTED',
      rationale: 'Attempting to re-disposition an already released batch without a signature.',
    },
  });
  // 422 is the correct refusal here: the request carries no signing token, and
  // reversing a release is exactly the act that must be signed. Accepting only
  // 400/403/409 was the assertion being narrower than the guard.
  [400, 403, 409, 422].includes(reDisposition.status)
    ? ok(
        'a released batch cannot be re-dispositioned without a signature',
        `${reDisposition.status}`,
      )
    : bad('re-disposition guarded', `got ${reDisposition.status}`);

  console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`);
  if (failures.length) {
    console.log('\x1b[31mFailures:\x1b[0m');
    for (const f of failures) console.log(`  - ${f}`);
    console.log();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n\x1b[31mSmoke test aborted:\x1b[0m', err.message);
  process.exit(1);
});
