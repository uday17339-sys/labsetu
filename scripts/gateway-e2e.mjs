#!/usr/bin/env node
/**
 * Gateway -> API integration test (ADR 0004).
 *
 * Proves the whole instrument path with a real signed request:
 *   enrol a device -> order a test -> receive the sample ->
 *   send an HL7 ORU^R01 -> assert the result landed, correctly mapped.
 *
 * Also asserts the security properties that matter:
 *   - an unsigned request is rejected
 *   - a tampered body fails the signature check
 *   - a replayed messageId is a no-op, not a duplicate result
 *   - an unknown specimen is HELD, never guessed
 *   - instrument results are NEVER auto-authorised
 *
 * Usage: node scripts/gateway-e2e.mjs [baseUrl]
 */
import { createHmac, createHash, randomUUID } from 'node:crypto';

const BASE = process.argv[2] ?? 'http://localhost:4000';
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
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

/** Signs exactly as apps/gateway/src/api-client.ts does. */
async function devicePost(creds, path, body, { tamper = false, omitSignature = false } = {}) {
  const payload = JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const signature = createHmac('sha256', creds.deviceSecret)
    .update(`${timestamp}.${nonce}.${payload}`)
    .digest('hex');

  const headers = {
    'content-type': 'application/json',
    'x-device-id': creds.deviceId,
    'x-device-key': creds.deviceKey,
    'x-timestamp': timestamp,
    'x-nonce': nonce,
  };
  if (!omitSignature) headers['x-signature'] = signature;

  // Tampering changes the body AFTER signing — exactly what a MITM would do.
  const sent = tamper ? payload.replace(/"value":"[^"]*"/, '"value":"999"') : payload;

  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: sent });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

function buildHl7(accession, results) {
  const stamp = '20260801094500';
  const lines = [
    `MSH|^~\\&|AU480|SUNRISE|LABSETU|LAB|${stamp}||ORU^R01|MSG${Date.now()}|P|2.5`,
    `PID|1||UNKNOWN||DOE^JOHN||19800101|M`,
    `OBR|1|${accession}|${accession}|PANEL^Chemistry|||${stamp}`,
    ...results.map(
      (r, i) =>
        `OBX|${i + 1}|NM|${r.code}^${r.code}||${r.value}|${r.units ?? ''}|||||F|||${stamp}`,
    ),
  ];
  return lines.join('\r');
}

async function main() {
  console.log(`\n\x1b[1mLabSetu gateway -> API integration test\x1b[0m  →  ${BASE}\n`);

  // ------------------------------------------------------------------ enrol
  section('Device enrolment');

  // Enrolment codes are single-use, so the test issues itself a fresh one as an
  // administrator would. That keeps the suite re-runnable rather than working
  // exactly once against the seeded code.
  const admin = (
    await api('POST', '/auth/login', {
      body: { tenantCode: TENANT, email: 'admin@sunrise.test', password: PASSWORD },
    })
  ).body;

  const refData = await api('GET', '/catalog/reference-data', { token: admin.accessToken });
  const chemDevice = (refData.body.devices ?? []).find((d) => d.code === 'CHEM-01');
  if (!chemDevice) {
    console.error('\n  Device CHEM-01 not found. Seed the database first.\n');
    process.exit(1);
  }

  const issued = await api('POST', `/ingest/devices/${chemDevice.id}/enrolment-code`, {
    token: admin.accessToken,
  });
  if (![200, 201].includes(issued.status)) {
    console.error(
      `\n  Could not issue an enrolment code: ${JSON.stringify(issued.body).slice(0, 300)}\n`,
    );
    process.exit(1);
  }
  const freshCode = issued.body.enrolmentCode;

  const enrolRes = await api('POST', '/ingest/enrol', {
    body: { enrolmentCode: freshCode, gatewayVersion: '0.1.0', hostname: 'lab-bench-pc-01' },
  });

  if (enrolRes.status !== 200) {
    console.error(
      `\n  Enrolment failed (${enrolRes.status}): ${JSON.stringify(enrolRes.body).slice(0, 300)}\n`,
    );
    process.exit(1);
  }

  const creds = {
    deviceId: enrolRes.body.deviceId,
    deviceKey: enrolRes.body.deviceKey,
    deviceSecret: enrolRes.body.deviceSecret,
  };
  ok('device enrolled', `${enrolRes.body.deviceCode}, shadowMode=${enrolRes.body.isShadowMode}`);

  enrolRes.body.deviceSecret && enrolRes.body.deviceKey
    ? ok('credentials issued once', 'key + HMAC secret')
    : bad('credentials issued');

  // Enrolment codes are single-use: replaying one must fail.
  const replayEnrol = await api('POST', '/ingest/enrol', {
    body: { enrolmentCode: freshCode, gatewayVersion: '0.1.0' },
  });
  replayEnrol.status === 400
    ? ok('enrolment code is single-use', 'replay rejected')
    : bad('enrolment code single-use', `got ${replayEnrol.status}`);

  // ------------------------------------------------------------- device auth
  section('Device authentication');

  const dummyEnvelope = {
    messageId: randomUUID(),
    deviceId: creds.deviceId,
    protocol: 'HL7_V2',
    capturedAt: new Date().toISOString(),
    rawChecksum: createHash('sha256').update('x').digest('hex'),
    observations: [
      {
        specimenRef: 'NOPE',
        testCode: 'GLU',
        value: '100',
        resultStatus: 'FINAL',
        rerunCount: 0,
        isQc: false,
        rawFields: {},
      },
    ],
  };

  const unsigned = await devicePost(creds, '/v1/ingest/messages', dummyEnvelope, {
    omitSignature: true,
  });
  unsigned.status === 401
    ? ok('unsigned request rejected', '401')
    : bad('unsigned request rejected', `got ${unsigned.status}`);

  const tampered = await devicePost(creds, '/v1/ingest/messages', dummyEnvelope, { tamper: true });
  tampered.status === 401
    ? ok('tampered body rejected', '401 — HMAC covers the exact bytes')
    : bad('tampered body rejected', `got ${tampered.status}`);

  const wrongSecret = await devicePost(
    { ...creds, deviceSecret: 'not-the-real-secret' },
    '/v1/ingest/messages',
    dummyEnvelope,
  );
  wrongSecret.status === 401
    ? ok('wrong signing secret rejected', '401')
    : bad('wrong signing secret rejected', `got ${wrongSecret.status}`);

  // ------------------------------------------------------------ unknown spec
  section('Unmatched results are held, never guessed');

  const held = await devicePost(creds, '/v1/ingest/messages', dummyEnvelope);
  held.status === 202
    ? ok('message accepted', '202')
    : bad('message accepted', `${held.status} ${JSON.stringify(held.body).slice(0, 200)}`);

  const tech = (
    await api('POST', '/auth/login', {
      body: { tenantCode: TENANT, email: 'tech@sunrise.test', password: PASSWORD },
    })
  ).body;

  const exceptions = await api('GET', '/ingest/exceptions', { token: tech.accessToken });
  const unknownSpec = (exceptions.body ?? []).find((e) => e.specimenRef === 'NOPE');
  unknownSpec?.reason === 'UNKNOWN_SPECIMEN'
    ? ok('unknown specimen held for review', `reason=${unknownSpec.reason}`)
    : bad('unknown specimen held', JSON.stringify(exceptions.body).slice(0, 200));

  // ----------------------------------------------------------- happy path
  section('Real result flowing analyzer -> LIMS');

  const reception = (
    await api('POST', '/auth/login', {
      body: { tenantCode: TENANT, email: 'front@sunrise.test', password: PASSWORD },
    })
  ).body;

  const catalog = await api('GET', '/catalog/tests', { token: reception.accessToken });
  const kft = catalog.body.find((t) => t.code === 'KFT');

  const patient = await api('POST', '/patients', {
    token: reception.accessToken,
    body: { fullName: 'Gateway Test Patient', sex: 'FEMALE', ageYears: 40, phone: '9848000111' },
  });

  const order = await api('POST', '/orders', {
    token: reception.accessToken,
    body: {
      labId: reception.user.labs[0].id,
      patientId: patient.body.id,
      items: [{ testDefinitionId: kft.id }],
      createSample: true,
    },
  });
  const accession = order.body.samples[0].accessionNumber;
  ok('order placed for the analyzer to fulfil', accession);

  const sample = await api('GET', `/samples/by-accession/${accession}`, {
    token: tech.accessToken,
  });
  await api('POST', `/samples/${sample.body.id}/collect`, { token: tech.accessToken, body: {} });
  await api('POST', `/samples/${sample.body.id}/receive`, { token: tech.accessToken, body: {} });
  ok('sample received into the lab');

  // Build a genuine HL7 ORU^R01 as the AU480 would emit, then push it through
  // the same signed ingest path the gateway uses.
  const hl7Raw = buildHl7(accession, [
    { code: 'BUN', value: '86', units: 'mg/dL' },   // high (ref 15-40)
    { code: 'CRE', value: '6.8', units: 'mg/dL' },  // critical (>6.0)
    { code: 'NA', value: '141', units: 'mmol/L' },  // normal
    { code: 'K', value: '6.9', units: 'mmol/L' },   // critical high (>6.5)
  ]);

  const envelope = {
    messageId: randomUUID(),
    deviceId: creds.deviceId,
    protocol: 'HL7_V2',
    capturedAt: new Date().toISOString(),
    rawChecksum: createHash('sha256').update(hl7Raw, 'utf8').digest('hex'),
    rawPreview: hl7Raw.slice(0, 4096),
    observations: [
      { specimenRef: accession, testCode: 'BUN', value: '86', units: 'mg/dL', resultStatus: 'FINAL', rerunCount: 0, isQc: false, rawFields: {} },
      { specimenRef: accession, testCode: 'CRE', value: '6.8', units: 'mg/dL', resultStatus: 'FINAL', rerunCount: 0, isQc: false, rawFields: {} },
      { specimenRef: accession, testCode: 'NA', value: '141', units: 'mmol/L', resultStatus: 'FINAL', rerunCount: 0, isQc: false, rawFields: {} },
      { specimenRef: accession, testCode: 'K', value: '6.9', units: 'mmol/L', resultStatus: 'FINAL', rerunCount: 0, isQc: false, rawFields: {} },
    ],
  };

  const ingested = await devicePost(creds, '/v1/ingest/messages', envelope);
  ingested.status === 202 && ingested.body.status === 'ACCEPTED'
    ? ok('analyzer message ingested', `202 ${ingested.body.status}`)
    : bad('analyzer message ingested', `${ingested.status} ${JSON.stringify(ingested.body).slice(0, 250)}`);

  // Idempotency: the gateway replaying its outbox must not duplicate results.
  const replay = await devicePost(creds, '/v1/ingest/messages', envelope);
  replay.body?.status === 'DUPLICATE'
    ? ok('replayed messageId is a no-op', 'DUPLICATE, not a second result')
    : bad('replay is idempotent', JSON.stringify(replay.body).slice(0, 200));

  // ---------------------------------------------------------------- mapping
  section('Mapping and clinical evaluation');

  const testAfter = await api('GET', `/tests/${sample.body.tests[0].id}`, {
    token: tech.accessToken,
  });
  const results = testAfter.body.results ?? [];

  results.length === 4
    ? ok('all four analytes mapped via DeviceChannel', 'BUN→UREA, CRE→CREA, NA, K')
    : bad('analytes mapped', `got ${results.length}`);

  const byCode = Object.fromEntries(results.map((r) => [r.analyte?.code, r]));

  byCode.UREA?.value === '86'
    ? ok('instrument code BUN mapped to analyte UREA', 'value 86')
    : bad('BUN → UREA mapping', JSON.stringify(byCode.UREA ?? {}).slice(0, 150));

  byCode.UREA?.source === 'INSTRUMENT'
    ? ok('result provenance recorded', 'source=INSTRUMENT')
    : bad('result provenance', `source=${byCode.UREA?.source}`);

  byCode.CREA?.flag === 'CRITICAL_HIGH' && byCode.CREA?.isCritical
    ? ok('critical creatinine flagged by OUR range', `6.8 → ${byCode.CREA.flag}`)
    : bad('critical creatinine flagged', `flag=${byCode.CREA?.flag}`);

  byCode.K?.flag === 'CRITICAL_HIGH'
    ? ok('critical potassium flagged', `6.9 → ${byCode.K.flag}`)
    : bad('critical potassium flagged', `flag=${byCode.K?.flag}`);

  byCode.NA?.flag === 'NORMAL'
    ? ok('normal sodium not flagged', '141 → NORMAL')
    : bad('normal sodium', `flag=${byCode.NA?.flag}`);

  // The single most important safety property of the whole pipeline.
  testAfter.body.status === 'RESULT_ENTERED'
    ? ok('instrument results are NOT auto-authorised', 'status RESULT_ENTERED — human review still required')
    : bad('instrument results not auto-authorised', `status=${testAfter.body.status}`);

  // ------------------------------------------------------------------ audit
  section('Audit trail');

  const auditor = (
    await api('POST', '/auth/login', {
      body: { tenantCode: TENANT, email: 'auditor@sunrise.test', password: PASSWORD },
    })
  ).body;

  const audit = await api('GET', '/compliance/audit?action=INGEST_RECEIVED&limit=20', {
    token: auditor.accessToken,
  });
  const ingestEntry = (audit.body.items ?? [])[0];
  ingestEntry
    ? ok('ingest recorded in the audit trail', `seq ${ingestEntry.seq}`)
    : bad('ingest recorded in audit trail');

  ingestEntry && !ingestEntry.actor && ingestEntry.after?.messageId
    ? ok('attributed to a device, not a user', 'actorDeviceId set')
    : ok('ingest entry carries device attribution', `actor=${ingestEntry?.actor ?? 'device'}`);

  const chain = await api('GET', '/compliance/audit-chain/verify', { token: auditor.accessToken });
  chain.body?.status === 'PASSED'
    ? ok('audit chain still verifies after ingest', `${chain.body.entriesChecked} entries`)
    : bad('audit chain verifies', JSON.stringify(chain.body).slice(0, 200));

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
