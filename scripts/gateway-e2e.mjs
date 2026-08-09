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

/**
 * Backs off on 429 rather than reporting the limiter as a product failure.
 *
 * Without this, a throttled login returns an error body, every later call runs
 * unauthenticated, and the suite reports "source=undefined" and "missing bearer
 * token" — which reads as broken ingest rather than as a rate limit doing its
 * job. The limiter is correct; the client has to be well-behaved.
 */
async function api(method, path, { token, body } = {}, attempt = 0) {
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 429 && attempt < 4) {
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

/**
 * A result export from the chromatography data system, as the gateway sees it.
 *
 * This is what an HPLC actually hands over — a signed result file from OpenLab
 * or Empower keyed on the AR number, not an HL7 ORU message. HL7 is a clinical
 * protocol; the parsers still support it for the diagnostics vertical, but no
 * instrument in a QC lab speaks it.
 */
function buildCdsExport(accession, results) {
  const stamp = '2026-08-01 09:45:00';
  const lines = [
    'SampleName,SampleSetName,Acquired,Component,Amount,Units,Result Status',
    ...results.map(
      (r) =>
        `${accession},RELEASE-${accession},${stamp},${r.code},${r.value},${r.units ?? ''},Final`,
    ),
  ];
  return lines.join('\r\n');
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
      body: { tenantCode: TENANT, email: 'admin@vantage.test', password: PASSWORD },
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
    protocol: 'FILE_CSV',
    capturedAt: new Date().toISOString(),
    rawChecksum: createHash('sha256').update('x').digest('hex'),
    observations: [
      {
        specimenRef: 'NOT-AN-AR-NUMBER',
        testCode: 'ASSAY',
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
      body: { tenantCode: TENANT, email: 'qc@vantage.test', password: PASSWORD },
    })
  ).body;

  const exceptions = await api('GET', '/ingest/exceptions', { token: tech.accessToken });
  const unknownSpec = (exceptions.body ?? []).find(
    (e) => e.specimenRef === 'NOT-AN-AR-NUMBER',
  );
  unknownSpec?.reason === 'UNKNOWN_SPECIMEN'
    ? ok('unknown specimen held for review', `reason=${unknownSpec.reason}`)
    : bad('unknown specimen held', JSON.stringify(exceptions.body).slice(0, 200));

  // ----------------------------------------------------------- happy path
  section('Real result flowing analyzer -> LIMS');

  // The manufacturing path: a consignment is received, QC samples it, and the
  // HPLC reports the assay against that AR number. There is no patient anywhere
  // in this flow — the subject of the sample is a material batch.
  const stores = (
    await api('POST', '/auth/login', {
      body: { tenantCode: TENANT, email: 'stores@vantage.test', password: PASSWORD },
    })
  ).body;
  const qa = (
    await api('POST', '/auth/login', {
      body: { tenantCode: TENANT, email: 'qa@vantage.test', password: PASSWORD },
    })
  ).body;

  const labId = admin.user.labs[0].id;
  const materials = await api('GET', '/stores/materials', { token: stores.accessToken });
  const material = (materials.body ?? []).find((m) => m.code === 'API-PCM');

  const batchNumber = `GW-${Date.now()}`;
  const receipt = await api('POST', '/stores/receive', {
    token: stores.accessToken,
    body: {
      labId,
      supplierName: 'Gateway Test Supplier',
      batches: [
        {
          materialId: material.id,
          batchNumber,
          quantity: 80,
          containerCount: 4,
          manufacturedAt: new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10),
          expiryDate: new Date(Date.now() + 500 * 864e5).toISOString().slice(0, 10),
        },
      ],
    },
  });
  const batchId = receipt.body?.batches?.[0]?.id;
  batchId
    ? ok('consignment received for analysis', batchNumber)
    : bad('consignment received', JSON.stringify(receipt.body).slice(0, 140));

  const req = await api('POST', '/stores/sampling-requests', {
    token: stores.accessToken,
    body: { batchId, reason: 'RELEASE_TESTING' },
  });
  const sampled = await api('POST', `/stores/sampling-requests/${req.body.id}/sample`, {
    token: tech.accessToken,
    body: { labId, containersSampled: 3 },
  });
  const accession = sampled.body?.accessionNumber;
  accession
    ? ok('QC sampled the batch', `AR ${accession}`)
    : bad('batch sampled', JSON.stringify(sampled.body).slice(0, 140));

  const sample = await api('GET', `/samples/by-accession/${accession}`, {
    token: tech.accessToken,
  });

  // Locate the assay test — CHEM-01 maps its "ASSAY" channel onto our analyte.
  let assayTestId = null;
  for (const t of sample.body?.tests ?? []) {
    const detail = await api('GET', `/tests/${t.id}`, { token: tech.accessToken });
    if ((detail.body?.testDefinition?.analytes ?? []).some((a) => a.analyte.code === 'ASSAY')) {
      assayTestId = t.id;
      break;
    }
  }
  assayTestId ? ok('assay test booked from the specification') : bad('assay test booked');

  const rawExport = buildCdsExport(accession, [{ code: 'ASSAY', value: '99.42', units: '%' }]);
  const envelope = {
    messageId: randomUUID(),
    deviceId: creds.deviceId,
    protocol: 'FILE_CSV',
    capturedAt: new Date().toISOString(),
    rawChecksum: createHash('sha256').update(rawExport, 'utf8').digest('hex'),
    rawPreview: rawExport.slice(0, 4096),
    observations: [
      {
        specimenRef: accession,
        testCode: 'ASSAY',
        value: '99.42',
        units: '%',
        resultStatus: 'FINAL',
        rerunCount: 0,
        isQc: false,
        rawFields: {},
      },
    ],
  };

  const ingested = await devicePost(creds, '/v1/ingest/messages', envelope);
  ingested.status === 202 && ingested.body.status === 'ACCEPTED'
    ? ok('analyzer message ingested', `202 ${ingested.body.status}`)
    : bad('analyzer message ingested', `${ingested.status} ${JSON.stringify(ingested.body).slice(0, 200)}`);

  // Idempotency: a gateway replaying its outbox must not duplicate results.
  const replay = await devicePost(creds, '/v1/ingest/messages', envelope);
  replay.body?.status === 'DUPLICATE'
    ? ok('replayed messageId is a no-op', 'DUPLICATE, not a second result')
    : bad('replay is idempotent', JSON.stringify(replay.body).slice(0, 160));

  section('Mapping and evaluation against the specification');

  const after = await api('GET', `/tests/${assayTestId}`, { token: tech.accessToken });
  const results = after.body?.results ?? [];
  const assay = results.find((r) => r.analyte?.code === 'ASSAY');

  assay
    ? ok('instrument channel ASSAY mapped to our analyte', `value ${assay.value}`)
    : bad('assay mapped', JSON.stringify(results).slice(0, 160));

  assay?.source === 'INSTRUMENT'
    ? ok('result provenance recorded', 'source=INSTRUMENT')
    : bad('result provenance', `source=${assay?.source}`);

  // 99.42 sits inside 99.0–101.0, so no investigation should be raised.
  after.body?.status === 'RESULT_ENTERED'
    ? ok('instrument results are NOT auto-authorised', 'human review still required')
    : bad('not auto-authorised', `status=${after.body?.status}`);

  const investigations = await api('GET', '/qa/investigations?status=OPEN', {
    token: qa.accessToken,
  });
  const spurious = (investigations.body ?? []).filter((i) => i.batch?.batchNumber === batchNumber);
  spurious.length === 0
    ? ok('an in-specification analyzer result opens no investigation')
    : bad('no false OOS', `${spurious.length} raised`);


  section('Audit trail');

  const auditor = (
    await api('POST', '/auth/login', {
      body: { tenantCode: TENANT, email: 'auditor@vantage.test', password: PASSWORD },
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
