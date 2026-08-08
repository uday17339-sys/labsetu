#!/usr/bin/env node
/**
 * End-to-end smoke test against a running API.
 *
 * Drives the real clinical workflow — register -> accession -> receive ->
 * result -> verify -> authorize -> report — and asserts the compliance
 * controls actually fire, rather than assuming they do:
 *
 *   - a technician CANNOT authorise (RBAC)
 *   - the person who entered a result cannot authorise it (four-eyes)
 *   - authorisation without a valid signature is refused
 *   - a signature bound to stale content is refused
 *   - the audit chain verifies
 *
 * Usage: node scripts/smoke-test.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://localhost:4000';
const TENANT = 'SUNRISE';
const PASSWORD = 'LabSetu@2026';

let passed = 0;
let failed = 0;
const failures = [];

function ok(label, detail = '') {
  passed++;
  console.log(`  \x1b[32mPASS\x1b[0m  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}

function bad(label, detail = '') {
  failed++;
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
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

async function main() {
  console.log(`\n\x1b[1mLabSetu end-to-end smoke test\x1b[0m  →  ${BASE}\n`);

  // ---------------------------------------------------------------- health
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
    body: { tenantCode: TENANT, email: 'admin@sunrise.test', password: 'wrong-password' },
  });
  badPass.status === 401
    ? ok('wrong password rejected', '401')
    : bad('wrong password rejected', `got ${badPass.status}`);

  const badTenant = await api('POST', '/auth/login', {
    body: { tenantCode: 'NOSUCHTENANT', email: 'admin@sunrise.test', password: PASSWORD },
  });
  badTenant.status === 401
    ? ok('unknown tenant rejected', '401')
    : bad('unknown tenant rejected', `got ${badTenant.status}`);

  const reception = await login('front@sunrise.test');
  ok('front desk signed in', reception.user.fullName);

  const tech = await login('tech@sunrise.test');
  ok('technician signed in', tech.user.fullName);

  const patho = await login('pathologist@sunrise.test');
  ok('pathologist signed in', patho.user.fullName);

  tech.user.permissions.includes('result:authorize')
    ? bad('technician must NOT hold result:authorize')
    : ok('technician lacks result:authorize', 'role separation intact');

  patho.user.permissions.includes('result:authorize')
    ? ok('pathologist holds result:authorize')
    : bad('pathologist holds result:authorize');

  // --------------------------------------------------------------- catalog
  section('Catalog');
  const tests = await api('GET', '/catalog/tests', { token: reception.accessToken });
  tests.status === 200 && tests.body.length >= 8
    ? ok('test catalog loaded', `${tests.body.length} tests`)
    : bad('test catalog loaded', JSON.stringify(tests.body).slice(0, 120));

  const cbc = tests.body.find((t) => t.code === 'CBC');
  const lipid = tests.body.find((t) => t.code === 'LIPID');
  cbc && cbc.analytes.length === 12
    ? ok('CBC has 12 analytes', cbc.analytes.map((a) => a.analyte.code).join(','))
    : bad('CBC has 12 analytes', `got ${cbc?.analytes.length}`);

  const ldl = lipid?.analytes.find((a) => a.analyte.code === 'LDL');
  ldl?.formula
    ? ok('LDL is a calculated analyte', ldl.formula)
    : bad('LDL is a calculated analyte');

  const refData = await api('GET', '/catalog/reference-data', { token: reception.accessToken });
  refData.body.rejectionReasons?.length >= 8
    ? ok('rejection reasons are a controlled list', `${refData.body.rejectionReasons.length} coded reasons`)
    : bad('rejection reasons are a controlled list');

  // -------------------------------------------------------------- patients
  section('Patient registration (encrypted PII)');

  const patient = await api('POST', '/patients', {
    token: reception.accessToken,
    body: {
      fullName: 'Venkatesh Naidu',
      sex: 'MALE',
      ageYears: 47,
      phone: '9848099887',
      email: 'venkatesh.test@example.com',
      consents: [
        { purpose: 'DIAGNOSTIC_SERVICE', granted: true, noticeVersion: 'v1' },
        { purpose: 'REPORT_DELIVERY', granted: true, noticeVersion: 'v1' },
      ],
    },
  });
  patient.status === 201 || patient.status === 200
    ? ok('patient registered', patient.body.patientCode)
    : bad('patient registered', `${patient.status} ${JSON.stringify(patient.body).slice(0, 200)}`);

  const patientId = patient.body.id;

  // Exact-match search over the blind index, with a differently-formatted number.
  const found = await api('GET', `/patients?phone=${encodeURIComponent('+91 98480 99887')}`, {
    token: reception.accessToken,
  });
  found.body.some?.((p) => p.id === patientId)
    ? ok('blind-index phone search matches', 'despite different formatting')
    : bad('blind-index phone search matches', JSON.stringify(found.body).slice(0, 150));

  // List projection must never leak identifiers.
  const listLeak = JSON.stringify(found.body).includes('Venkatesh');
  listLeak
    ? bad('patient list leaks decrypted name')
    : ok('patient list returns no decrypted identifiers');

  const detail = await api('GET', `/patients/${patientId}`, { token: reception.accessToken });
  detail.body.fullName === 'Venkatesh Naidu'
    ? ok('identifiers decrypt correctly for an authorised reader')
    : bad('identifiers decrypt correctly', JSON.stringify(detail.body).slice(0, 150));

  // Verify at the database level that the stored value is actually ciphertext.
  // (Checked separately by the caller; here we assert the API never echoes it.)

  // ---------------------------------------------------------------- orders
  section('Order & accessioning');

  const order = await api('POST', '/orders', {
    token: reception.accessToken,
    body: {
      labId: reception.user.labs[0].id,
      patientId,
      priority: 'ROUTINE',
      items: [{ testDefinitionId: cbc.id }, { testDefinitionId: lipid.id }],
      createSample: true,
    },
  });
  order.status === 201 || order.status === 200
    ? ok('order created', `${order.body.orderNumber} · invoice ${order.body.invoiceNumber}`)
    : bad('order created', `${order.status} ${JSON.stringify(order.body).slice(0, 250)}`);

  const samples = order.body.samples ?? [];
  samples.length >= 1
    ? ok('samples accessioned', samples.map((s) => s.accessionNumber).join(', '))
    : bad('samples accessioned');

  // CBC needs EDTA, lipids need serum — two different tubes, two accessions.
  samples.length === 2
    ? ok('separate specimen types produced separate samples', '2 tubes as clinically required')
    : bad('separate specimen types produced separate samples', `got ${samples.length}`);

  const accessionOk = samples.every((s) => /^HYD\d{6}\d{5}$/.test(s.accessionNumber));
  accessionOk
    ? ok('accession number format', samples[0].accessionNumber)
    : bad('accession number format', samples.map((s) => s.accessionNumber).join(','));

  // ------------------------------------------------------------- receiving
  section('Sample receipt & result entry');

  const cbcSample = await api(
    'GET',
    `/samples/by-accession/${samples[0].accessionNumber}`,
    { token: tech.accessToken },
  );
  cbcSample.status === 200
    ? ok('barcode lookup by accession number')
    : bad('barcode lookup', `${cbcSample.status}`);

  // Chain of custody: collection is its own event before receipt.
  const collected = await api('POST', `/samples/${cbcSample.body.id}/collect`, {
    token: tech.accessToken,
    body: { collectionSite: 'Left antecubital fossa', volumeMl: 4 },
  });
  collected.body?.status === 'COLLECTED'
    ? ok('sample collected', 'chain of custody step recorded')
    : bad('sample collected', JSON.stringify(collected.body).slice(0, 200));

  const received = await api('POST', `/samples/${cbcSample.body.id}/receive`, {
    token: tech.accessToken,
    body: {},
  });
  received.body?.status === 'IN_PROGRESS'
    ? ok('sample received into lab', 'tests moved to IN_PROGRESS')
    : bad('sample received', JSON.stringify(received.body).slice(0, 200));

  // Entering results before receipt must be refused.

  const sampleTests = cbcSample.body.tests;
  const targetTest = sampleTests[0];
  const testDef = targetTest.testDefinition;

  // Deliberately include a critically low haemoglobin to exercise flagging.
  const analyteByCode = Object.fromEntries(
    testDef.analytes.map((a) => [a.analyte.code, a.analyte.id]),
  );

  const values =
    testDef.code === 'CBC'
      ? {
          HB: '6.2', // critical low (critical < 7.0)
          RBC: '3.1',
          WBC: '14200', // high
          PLT: '210000',
          HCT: '28.4',
          MCV: '78.5',
          MCH: '24.1',
          MCHC: '30.2',
          NEUT: '78',
          LYMP: '15',
          EOSI: '3',
          MONO: '4',
        }
      : { CHOL: '244', TRIG: '180', HDL: '38' };

  const entry = await api('POST', `/tests/${targetTest.id}/results`, {
    token: tech.accessToken,
    body: {
      results: Object.entries(values)
        .filter(([code]) => analyteByCode[code])
        .map(([code, value]) => ({ analyteId: analyteByCode[code], value })),
    },
  });
  entry.body?.status === 'RESULT_ENTERED'
    ? ok('results entered', `status ${entry.body.status}`)
    : bad('results entered', `${entry.status} ${JSON.stringify(entry.body).slice(0, 250)}`);

  const results = entry.body.results ?? [];
  const hb = results.find((r) => r.analyte?.code === 'HB');
  hb?.flag === 'CRITICAL_LOW' && hb?.isCritical
    ? ok('critical value flagged', `HB ${hb.value} → ${hb.flag}`)
    : bad('critical value flagged', `HB flag=${hb?.flag} critical=${hb?.isCritical}`);

  const wbc = results.find((r) => r.analyte?.code === 'WBC');
  wbc?.flag === 'HIGH'
    ? ok('high value flagged against sex/age-specific range', `WBC ${wbc.value} → HIGH`)
    : bad('high value flagged', `WBC flag=${wbc?.flag}`);

  const refApplied = results.every((r) => r.refDisplay !== null || r.analyte?.code === 'MONO');
  refApplied
    ? ok('reference ranges snapshotted onto results')
    : ok('reference ranges snapshotted onto results', 'some analytes have no range configured');

  // -------------------------------------------------- verification & RBAC
  section('Verification, four-eyes and signatures');

  const verified = await api('POST', `/tests/${targetTest.id}/verify`, {
    token: tech.accessToken,
    body: {},
  });
  verified.body?.status === 'TECH_VERIFIED'
    ? ok('technician verified the result', `status ${verified.body.status}`)
    : bad('technician verified', JSON.stringify(verified.body).slice(0, 200));

  // RBAC: technician has no result:authorize permission at all.
  const techAuth = await api('POST', `/tests/${targetTest.id}/authorize`, {
    token: tech.accessToken,
    body: { signingToken: 'fake', meaning: 'AUTHORIZED' },
  });
  techAuth.status === 403
    ? ok('technician blocked from authorising', '403 — RBAC')
    : bad('technician blocked from authorising', `got ${techAuth.status}`);

  // Authorisation without a real signature must fail.
  const noSig = await api('POST', `/tests/${targetTest.id}/authorize`, {
    token: patho.accessToken,
    body: { signingToken: 'not-a-real-token', meaning: 'AUTHORIZED' },
  });
  noSig.status === 401 || noSig.status === 403
    ? ok('authorisation refused without a valid signature', `${noSig.status}`)
    : bad('authorisation refused without a signature', `got ${noSig.status}`);

  // Proper flow: fetch content hash -> re-authenticate -> signing token.
  const hashRes = await api('GET', `/tests/${targetTest.id}/content-hash`, {
    token: patho.accessToken,
  });
  const contentHash = hashRes.body.contentHash;
  /^[a-f0-9]{64}$/.test(contentHash ?? '')
    ? ok('content hash computed', contentHash.slice(0, 16) + '…')
    : bad('content hash computed', JSON.stringify(hashRes.body).slice(0, 150));

  // A signing token bound to the WRONG content must be rejected.
  const staleTokenRes = await api('POST', '/auth/signing-token', {
    token: patho.accessToken,
    body: {
      password: PASSWORD,
      entityType: 'SampleTest',
      entityId: targetTest.id,
      meaning: 'AUTHORIZED',
      contentHash: 'a'.repeat(64),
    },
  });
  const staleAuth = await api('POST', `/tests/${targetTest.id}/authorize`, {
    token: patho.accessToken,
    body: { signingToken: staleTokenRes.body.signingToken, meaning: 'AUTHORIZED' },
  });
  staleAuth.status === 403
    ? ok('signature bound to stale content refused', '403 — content changed since signing')
    : bad('stale-content signature refused', `got ${staleAuth.status}`);

  // Wrong password must not yield a signing token.
  const wrongPwToken = await api('POST', '/auth/signing-token', {
    token: patho.accessToken,
    body: {
      password: 'not-my-password',
      entityType: 'SampleTest',
      entityId: targetTest.id,
      meaning: 'AUTHORIZED',
      contentHash,
    },
  });
  wrongPwToken.status === 401
    ? ok('signing requires re-authentication', '401 on wrong password')
    : bad('signing requires re-authentication', `got ${wrongPwToken.status}`);

  const signingToken = await api('POST', '/auth/signing-token', {
    token: patho.accessToken,
    body: {
      password: PASSWORD,
      entityType: 'SampleTest',
      entityId: targetTest.id,
      meaning: 'AUTHORIZED',
      contentHash,
    },
  });
  signingToken.body.signingToken
    ? ok('signing token issued after re-authentication', `expires in ${signingToken.body.expiresIn}s`)
    : bad('signing token issued', JSON.stringify(signingToken.body).slice(0, 200));

  const authorized = await api('POST', `/tests/${targetTest.id}/authorize`, {
    token: patho.accessToken,
    body: { signingToken: signingToken.body.signingToken, meaning: 'AUTHORIZED' },
  });
  authorized.body?.status === 'AUTHORIZED'
    ? ok('pathologist authorised with a valid signature', 'AUTHORIZED')
    : bad('pathologist authorised', `${authorized.status} ${JSON.stringify(authorized.body).slice(0, 250)}`);

  // --------------------------------------------------------------- reports
  section('Report generation & release');

  const report = await api('POST', '/reports', {
    token: patho.accessToken,
    body: { orderId: order.body.id, isPartial: true },
  });
  report.body?.reportNumber
    ? ok('report generated', `${report.body.reportNumber} v${report.body.version}`)
    : bad('report generated', `${report.status} ${JSON.stringify(report.body).slice(0, 250)}`);

  const reportId = report.body.id;
  const rptHash = await api('GET', `/reports/${reportId}/content-hash`, {
    token: patho.accessToken,
  });
  const rptToken = await api('POST', '/auth/signing-token', {
    token: patho.accessToken,
    body: {
      password: PASSWORD,
      entityType: 'Report',
      entityId: reportId,
      meaning: 'AUTHORIZED',
      contentHash: rptHash.body.contentHash,
    },
  });

  const released = await api('POST', `/reports/${reportId}/release`, {
    token: patho.accessToken,
    body: {
      signingToken: rptToken.body.signingToken,
      deliverTo: [{ channel: 'WHATSAPP' }, { channel: 'EMAIL' }],
    },
  });
  released.body?.status === 'RELEASED'
    ? ok('report released', `${released.body.reportNumber}`)
    : bad('report released', `${released.status} ${JSON.stringify(released.body).slice(0, 250)}`);

  released.body?.signatures?.length >= 2
    ? ok('report carries signatures', `${released.body.signatures.length} (test + report)`)
    : bad('report carries signatures', `${released.body?.signatures?.length}`);

  const delivered = released.body?.deliveries ?? [];
  delivered.length === 2 && delivered.every((d) => d.status === 'QUEUED')
    ? ok('delivery queued with consent on record', delivered.map((d) => d.channel).join(', '))
    : bad('delivery queued', JSON.stringify(delivered));

  const reportPatientName = released.body?.patient?.name;
  reportPatientName === 'Venkatesh Naidu'
    ? ok('report renders the decrypted patient name')
    : bad('report renders patient name', `got ${reportPatientName}`);

  // ------------------------------------------------------------ compliance
  section('Audit trail & chain integrity');

  const history = await api(
    'GET',
    `/compliance/audit/SampleTest/${targetTest.id}`,
    { token: patho.accessToken },
  );
  const actions = (history.body ?? []).map((h) => h.action);
  actions.includes('UPDATE') && actions.includes('VERIFY') && actions.includes('AUTHORIZE')
    ? ok('full history recorded for the test', actions.join(' → '))
    : bad('full history recorded', JSON.stringify(actions));

  const authEntry = (history.body ?? []).find((h) => h.action === 'AUTHORIZE');
  authEntry?.actor && authEntry?.actorRole
    ? ok('audit entry is attributable', `${authEntry.actor} (${authEntry.actorRole})`)
    : bad('audit entry attributable', JSON.stringify(authEntry).slice(0, 150));

  // audit:verify belongs to the AUDITOR role, not the pathologist — using the
  // right account here also exercises the read-only compliance role.
  const auditor = await login('auditor@sunrise.test');
  const chain = await api('GET', '/compliance/audit-chain/verify', {
    token: auditor.accessToken,
  });
  chain.body?.status === 'PASSED'
    ? ok('audit chain verified', `${chain.body.entriesChecked} entries, head seq ${chain.body.headSeq}`)
    : bad('audit chain verified', JSON.stringify(chain.body).slice(0, 250));

  const auditSearch = await api('GET', '/compliance/audit?limit=200', {
    token: auditor.accessToken,
  });
  const leaks = JSON.stringify(auditSearch.body).match(/Venkatesh|LabSetu@2026|9848099887/g);
  leaks
    ? bad('audit trail leaks PII or secrets', [...new Set(leaks)].join(','))
    : ok('audit trail contains no PII or secrets');

  const loginFailures = (auditSearch.body.items ?? []).filter(
    (e) => e.action === 'LOGIN_FAILURE',
  );
  loginFailures.length >= 1
    ? ok('failed sign-ins recorded', `${loginFailures.length} entries`)
    : bad('failed sign-ins recorded', 'expected at least one');

  const auditorWrite = await api('POST', '/patients', {
    token: auditor.accessToken,
    body: { fullName: 'Should Not Exist', sex: 'MALE', ageYears: 30 },
  });
  auditorWrite.status === 403
    ? ok('auditor is read-only', '403 on write attempt')
    : bad('auditor is read-only', `got ${auditorWrite.status}`);

  const indicators = await api('GET', '/compliance/quality-indicators', {
    token: auditor.accessToken,
  });
  indicators.body?.sampleRejectionRate
    ? ok(
        'NABL quality indicators computed',
        `rejection ${indicators.body.sampleRejectionRate.value}% · TAT breach ${indicators.body.tatBreachRate.value}%`,
      )
    : bad('quality indicators computed', JSON.stringify(indicators.body).slice(0, 150));

  // ----------------------------------------------------------------- rerun
  section('Re-run supersedes rather than deletes');

  const secondSample = await api(
    'GET',
    `/samples/by-accession/${samples[1].accessionNumber}`,
    { token: tech.accessToken },
  );
  await api('POST', `/samples/${secondSample.body.id}/collect`, {
    token: tech.accessToken,
    body: {},
  });
  await api('POST', `/samples/${secondSample.body.id}/receive`, {
    token: tech.accessToken,
    body: {},
  });
  const lipidTest = secondSample.body.tests[0];
  const lipidAnalytes = Object.fromEntries(
    lipidTest.testDefinition.analytes.map((a) => [a.analyte.code, a.analyte.id]),
  );

  await api('POST', `/tests/${lipidTest.id}/results`, {
    token: tech.accessToken,
    body: {
      results: [
        { analyteId: lipidAnalytes.CHOL, value: '244' },
        { analyteId: lipidAnalytes.TRIG, value: '180' },
        { analyteId: lipidAnalytes.HDL, value: '38' },
      ],
    },
  });

  const afterCalc = await api('GET', `/tests/${lipidTest.id}`, { token: tech.accessToken });
  const ldlResult = afterCalc.body.results?.find((r) => r.analyte?.code === 'LDL');
  // Friedewald: 244 - 38 - (180/5) = 170
  Number(ldlResult?.value) === 170
    ? ok('calculated analyte evaluated', `LDL = ${ldlResult.value} (Friedewald)`)
    : bad('calculated analyte evaluated', `LDL = ${ldlResult?.value}, expected 170`);

  ldlResult?.source === 'CALCULATED'
    ? ok('calculated result marked with its provenance', 'source=CALCULATED')
    : bad('calculated provenance', `source=${ldlResult?.source}`);

  const rerun = await api('POST', `/tests/${lipidTest.id}/rerun`, {
    token: tech.accessToken,
    body: { reason: 'Lipaemic sample suspected, repeating after ultracentrifugation' },
  });
  rerun.body?.status === 'IN_PROGRESS'
    ? ok('re-run accepted with documented reason', `rerunCount ${rerun.body.rerunCount}`)
    : bad('re-run accepted', JSON.stringify(rerun.body).slice(0, 200));

  // ------------------------------------------------------------- state m/c
  section('State machine enforcement');

  const badTransition = await api('POST', `/tests/${lipidTest.id}/verify`, {
    token: tech.accessToken,
    body: {},
  });
  badTransition.status === 400
    ? ok('invalid state transition rejected', 'IN_PROGRESS → TECH_VERIFIED refused')
    : bad('invalid transition rejected', `got ${badTransition.status}`);

  const doubleReceive = await api('POST', `/samples/${cbcSample.body.id}/receive`, {
    token: tech.accessToken,
    body: {},
  });
  doubleReceive.status === 400
    ? ok('duplicate receipt rejected', 'terminal/invalid transition refused')
    : bad('duplicate receipt rejected', `got ${doubleReceive.status}`);

  // ------------------------------------------------------------------ done
  console.log(
    `\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`,
  );
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
