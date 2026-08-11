#!/usr/bin/env node
/**
 * Quality control verification.
 *
 * Proves the compliance claim in COMPLIANCE.md §6 end to end: a failed QC run
 * actually BLOCKS authorisation of batch results on that analyzer, and the
 * block clears only with a documented, audited corrective action.
 *
 * That claim was previously unverifiable — the gate existed but nothing could
 * record a QC run to trigger it.
 *
 * Usage: node scripts/qc-verify.mjs [apiBase]
 */
import { createHmac, createHash, randomUUID } from 'node:crypto';

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

/**
 * Retries on 429.
 *
 * This suite records enough QC runs to exercise the sequential rules — 10-x
 * needs ten consecutive points by definition — which is a legitimate burst that
 * exceeds the 120/min limit. The limiter is correct; a well-behaved client backs
 * off rather than the server loosening its guard for a test.
 */
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
    // The throttler window is 60s; wait it out rather than hammering.
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

/** Signs a gateway request exactly as apps/gateway/src/api-client.ts does. */
/**
 * Retries a throttled device post.
 *
 * The ingest bucket is per-device, and a suite that enrols and immediately
 * streams results can trip it. A 429 here used to cascade: no result landed, so
 * the test never acquired an analyzer, so the QC gate had nothing to gate and
 * reported itself broken. Four failures, one rate limit, zero product defects.
 *
 * The signature covers the timestamp and nonce, so a retry has to re-sign
 * rather than replay the original headers.
 */
async function devicePost(creds, path, body, attempt = 0) {
  const payload = JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const signature = createHmac('sha256', creds.deviceSecret)
    .update(`${timestamp}.${nonce}.${payload}`)
    .digest('hex');

  const res = await fetch(`${API.replace(/\/v1$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-device-id': creds.deviceId,
      'x-device-key': creds.deviceKey,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signature,
    },
    body: payload,
  });
  if (res.status === 429 && attempt < 4) {
    await sleep(21_000);
    return devicePost(creds, path, body, attempt + 1);
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

const login = (email) =>
  api('POST', '/auth/login', { body: { tenantCode: TENANT, email, password: PASSWORD } }).then(
    (r) => r.body,
  );

async function main() {
  console.log(`\n\x1b[1mLabSetu QC verification\x1b[0m  →  ${API}\n`);

  const tech = await login('qc@vantage.test');
  const patho = await login('qa@vantage.test');
  const admin = await login('admin@vantage.test');
  const auditor = await login('auditor@vantage.test');

  // ------------------------------------------------------------------ setup
  section('QC configuration');

  const lots = await api('GET', '/qc/lots', { token: tech.accessToken });
  lots.status === 200 && lots.body.length > 0
    ? ok('QC lots configured', `${lots.body.length} active lots`)
    : bad('QC lots configured', JSON.stringify(lots.body).slice(0, 150));

  // Pick the lot that actually carries the analyte this suite gates on, rather
  // than whichever sorts first. Taking [0] made the suite depend on lot
  // ordering: once another run added a lot, the failing QC landed on an
  // unrelated analyte and the gate correctly did not fire — which read as a
  // broken gate when the gate was right and the test was wrong.
  const lot =
    lots.body.find((l) => (l.analytes ?? []).some((a) => a.analyte.code === 'ASSAY')) ??
    lots.body[0];
  const targets = lot.analytes ?? [];
  targets.length > 0
    ? ok('lot has per-analyte targets', `${targets.length} analytes with mean ± SD`)
    : bad('lot has analyte targets');

  const refData = await api('GET', '/catalog/reference-data', { token: admin.accessToken });
  const chemDeviceId = (refData.body.devices ?? []).find((d) => d.code === 'CHEM-01')?.id;
  chemDeviceId ? ok('analyzer available for gating', 'CHEM-01') : bad('CHEM-01 not found');

  const target = targets.find((t) => t.analyte.code === 'ASSAY') ?? targets[0];
  const mean = Number(target.targetMean);
  const sd = Number(target.targetSd);
  ok('target loaded', `${target.analyte.code}: ${mean} ± ${sd}`);

  // --------------------------------------------------------------- RBAC
  section('Role separation');

  const auditorWrite = await api('POST', '/qc/results', {
    token: auditor.accessToken,
    body: { qcLotId: lot.id, analyteId: target.analyte.id, value: mean },
  });
  auditorWrite.status === 403
    ? ok('auditor cannot record QC', '403 — read-only role')
    : bad('auditor blocked from QC entry', `got ${auditorWrite.status}`);

  const techOverride = await api('POST', '/qc/results/00000000-0000-0000-0000-000000000000/accept', {
    token: tech.accessToken,
    body: { actionTaken: 'attempting an override without permission' },
  });
  techOverride.status === 403
    ? ok('technician cannot override a QC failure', '403 — needs qc:override')
    : bad('technician blocked from override', `got ${techOverride.status}`);

  // ------------------------------------------------------------ passing run
  section('Westgard evaluation');

  // Rules 4-1s and 10-x are SEQUENTIAL — they look at the preceding runs. Every
  // previous execution of this suite left points on the high side, so without
  // resetting the run first, 10-x fires and masks the rule under test.
  //
  // Alternating around the mean breaks any same-side streak, which is exactly
  // what a lab does after resolving a drift. This is the rule working, not a
  // workaround for a bug.
  for (const offset of [-0.4, 0.3]) {
    await api('POST', '/qc/results', {
      token: tech.accessToken,
      body: { qcLotId: lot.id, analyteId: target.analyte.id, value: mean + sd * offset },
    });
  }
  ok('run history neutralised', 'alternating in-range points break any prior streak');

  const inRange = await api('POST', '/qc/results', {
    token: tech.accessToken,
    body: { qcLotId: lot.id, analyteId: target.analyte.id, value: mean + sd * 0.5 },
  });
  inRange.body?.status === 'PASS'
    ? ok('in-range value passes', `${inRange.body.zScore} SD`)
    : bad('in-range passes', JSON.stringify(inRange.body).slice(0, 200));

  const warn = await api('POST', '/qc/results', {
    token: tech.accessToken,
    body: { qcLotId: lot.id, analyteId: target.analyte.id, value: mean + sd * 2.5 },
  });
  warn.body?.status === 'WARNING' && warn.body?.violatedRules?.includes('1-2s')
    ? ok('2.5 SD raises a warning, not a rejection', '1-2s is advisory')
    : bad('1-2s is a warning only', JSON.stringify(warn.body).slice(0, 200));

  warn.body?.blocksAuthorization === false
    ? ok('a warning does not block authorisation')
    : bad('warning must not block', `blocks=${warn.body?.blocksAuthorization}`);

  const reject = await api('POST', '/qc/results', {
    token: tech.accessToken,
    body: { qcLotId: lot.id, analyteId: target.analyte.id, value: mean + sd * 4 },
  });
  reject.body?.status === 'REJECT' && reject.body?.violatedRules?.includes('1-3s')
    ? ok('4 SD rejects the run', `rules: ${reject.body.violatedRules.join(', ')}`)
    : bad('1-3s rejects', JSON.stringify(reject.body).slice(0, 200));

  reject.body?.blocksAuthorization === true
    ? ok('rejection is flagged as blocking', 'technician told immediately')
    : bad('rejection blocks authorisation', `blocks=${reject.body?.blocksAuthorization}`);

  reject.body?.explanation
    ? ok('failure carries a plain-language explanation', reject.body.explanation.slice(0, 60))
    : bad('failure explained');

  // --- 10-x: drift detection -------------------------------------------------
  // Ten consecutive points on the same side of the mean, none of them
  // individually out of range. This is the rule that catches a slow calibration
  // drift no single point would reveal — and the one that caught out the first
  // version of this very test.
  for (const offset of [-0.5]) {
    await api('POST', '/qc/results', {
      token: tech.accessToken,
      body: { qcLotId: lot.id, analyteId: target.analyte.id, value: mean + sd * offset },
    });
  }
  let drift = null;
  for (let i = 0; i < 10; i++) {
    drift = await api('POST', '/qc/results', {
      token: tech.accessToken,
      // All positive, all comfortably within 1SD — no other rule can fire.
      body: { qcLotId: lot.id, analyteId: target.analyte.id, value: mean + sd * 0.3 },
    });
  }
  drift?.body?.violatedRules?.includes('10-x')
    ? ok('10-x catches drift no single point reveals', '10 consecutive on one side, all within 1SD')
    : bad('10-x drift detection', JSON.stringify(drift?.body).slice(0, 160));

  // ------------------------------------------------------ the actual gate
  section('The gate: does a QC failure block batch results?');

  const failures0 = await api('GET', '/qc/failures', { token: tech.accessToken });
  const open = (failures0.body ?? []).filter((f) => f.analyte === target.analyte.code);
  open.length > 0
    ? ok('failure appears in the open-failures queue', `${open.length} unresolved`)
    : bad('failure queued', JSON.stringify(failures0.body).slice(0, 150));

  // Build the scenario rather than depending on leftover seed state, which
  // earlier suites consume.
  //
  // The gate only applies to a test that HAS an analyzer, and a test acquires
  // one when its result arrives from an instrument. So this walks the real
  // path: goods receipt -> sampling -> analyzer result -> verify -> failing QC
  // on that same analyzer -> attempt to authorise.
  const stores = await login('stores@vantage.test');

  const enrolCode = await api('POST', `/ingest/devices/${chemDeviceId}/enrolment-code`, {
    token: admin.accessToken,
  });
  const creds = (
    await api('POST', '/ingest/enrol', {
      body: { enrolmentCode: enrolCode.body.enrolmentCode, gatewayVersion: '0.1.0' },
    })
  ).body;

  const labId = stores.user.labs[0].id;
  const materials = await api('GET', '/stores/materials', { token: stores.accessToken });
  const material = (materials.body ?? []).find((m) => m.code === 'API-PCM');

  const receipt = await api('POST', '/stores/receive', {
    token: stores.accessToken,
    body: {
      labId,
      supplierName: 'QC Gate Supplier',
      batches: [
        {
          materialId: material.id,
          batchNumber: `QCG-${Date.now()}`,
          quantity: 50,
          containerCount: 2,
          manufacturedAt: new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10),
          expiryDate: new Date(Date.now() + 500 * 864e5).toISOString().slice(0, 10),
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

  // Result from the analyzer — this is what stamps deviceId onto the test.
  const envelope = {
    messageId: randomUUID(),
    deviceId: creds.deviceId,
    protocol: 'HL7_V2',
    capturedAt: new Date().toISOString(),
    rawChecksum: createHash('sha256').update(accession).digest('hex'),
    observations: [
      {
        specimenRef: accession,
        testCode: 'ASSAY',
        // Comfortably inside the 99.0–101.0 % specification, so the ONLY thing
        // that can block authorisation later is the failed control.
        value: '99.60',
        units: '%',
        resultStatus: 'FINAL',
        rerunCount: 0,
        isQc: false,
        rawFields: {},
      },
    ],
  };
  const ingested = await devicePost(creds, '/v1/ingest/messages', envelope);
  ingested.status === 202
    ? ok('analyzer result captured onto the test', 'stamps the analyzer on the record')
    : bad('analyzer result captured', `${ingested.status}`);

  // The specification books several tests against the batch. Only the HPLC
  // assay is bound to CHEM-01, and only that one is gated by this control —
  // taking tests[0] would land on Description and the gate would (correctly)
  // never fire.
  let testId = null;
  for (const t of sample.body.tests ?? []) {
    const d = await api('GET', `/tests/${t.id}`, { token: tech.accessToken });
    if (d.body?.testDefinition?.code === 'TASSAY') {
      testId = t.id;
      break;
    }
  }
  testId ? ok('assay test located on the batch', 'TASSAY') : bad('assay test located');

  await api('POST', `/tests/${testId}/verify`, { token: tech.accessToken, body: {} });

  const withDevice = await api('GET', `/tests/${testId}`, { token: patho.accessToken });
  const deviceId = withDevice.body?.device?.id;
  deviceId
    ? ok('test is bound to the analyzer', withDevice.body.device.code)
    : bad('test bound to analyzer', 'deviceId not set — the gate cannot apply');

  // Failing QC on THAT analyzer.
  const deviceFail = await api('POST', '/qc/results', {
    token: tech.accessToken,
    body: { qcLotId: lot.id, analyteId: target.analyte.id, deviceId, value: mean + sd * 4 },
  });
  deviceFail.body?.status === 'REJECT'
    ? ok('failing QC recorded against that analyzer', `${deviceFail.body.zScore} SD`)
    : bad('failing QC recorded', JSON.stringify(deviceFail.body).slice(0, 150));

  const tryAuth = async () => {
    const h = await api('GET', `/tests/${testId}/content-hash`, { token: patho.accessToken });
    const t = await api('POST', '/auth/signing-token', {
      token: patho.accessToken,
      body: {
        password: PASSWORD,
        entityType: 'SampleTest',
        entityId: testId,
        meaning: 'AUTHORIZED',
        contentHash: h.body.contentHash,
      },
    });
    return api('POST', `/tests/${testId}/authorize`, {
      token: patho.accessToken,
      body: { signingToken: t.body.signingToken, meaning: 'AUTHORIZED' },
    });
  };

  const blockedAttempt = await tryAuth();
  blockedAttempt.status === 403 && /quality control/i.test(blockedAttempt.body?.detail ?? '')
    ? ok('authorisation BLOCKED by the failed QC', blockedAttempt.body.detail.slice(0, 68))
    : bad(
        'QC gate blocks authorisation',
        `${blockedAttempt.status}: ${String(blockedAttempt.body?.detail).slice(0, 90)}`,
      );

  await api('POST', `/qc/results/${deviceFail.body.id}/accept`, {
    token: admin.accessToken,
    body: { actionTaken: 'Recalibrated the analyzer; control re-run within 1SD of target.' },
  });

  const allowedAttempt = await tryAuth();
  allowedAttempt.body?.status === 'AUTHORIZED'
    ? ok('resolving the failure unblocks authorisation', 'the gate opens again')
    : bad(
        'gate reopens after resolution',
        `${allowedAttempt.status} ${JSON.stringify(allowedAttempt.body).slice(0, 110)}`,
      );


  // ------------------------------------------------- calibration gate
  section('The calibration gate');

  // Mirrors the QC gate above and shares its shape: a result produced on an
  // instrument that is out of calibration must not be authorisable. The due
  // date sat on the device record from the beginning and was read by nothing,
  // which is worse than absent — the field looked like a control and behaved
  // like a comment.
  //
  // Reuses the analyzer-bound test already built for the QC gate, so this is
  // testing the calibration check and not a fresh set of plumbing.
  const calBefore = await api('GET', '/ingest/devices', { token: admin.accessToken });
  const chemBefore = (calBefore.body ?? []).find((d) => d.code === 'CHEM-01');
  chemBefore?.calibrationDueAt
    ? ok('the instrument list shows calibration status', `due ${chemBefore.calibrationDueAt}`)
    : bad('calibration surfaced on the device list', 'no due date exposed');

  // Back-date the instrument so it is out of calibration right now.
  const lapse = await api('POST', `/ingest/devices/${chemDeviceId}/calibration`, {
    token: admin.accessToken,
    body: {
      performedAt: new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10),
      nextDueAt: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10),
      certificateRef: 'CAL/VERIFY/LAPSED',
      note: 'Verification run — driving the instrument out of calibration on purpose',
    },
  });
  lapse.status < 300
    ? ok('a calibration can be recorded against the instrument', 'due date moved')
    : bad('record calibration', `${lapse.status} ${JSON.stringify(lapse.body).slice(0, 120)}`);

  const outOfCal = await api('GET', '/ingest/devices', { token: admin.accessToken });
  (outOfCal.body ?? []).find((d) => d.code === 'CHEM-01')?.isOutOfCalibration === true
    ? ok('the instrument reads as out of calibration', 'flagged before anyone runs work on it')
    : bad('out-of-calibration flag', 'not reflected on the device list');

  // A fresh analyzer-bound test. The one built for the QC gate has already been
  // authorised, and a record cannot be authorised twice — reusing it would test
  // the state machine rather than the calibration check.
  const calReceipt = await api('POST', '/stores/receive', {
    token: stores.accessToken,
    body: {
      labId,
      supplierName: 'Calibration Gate Supplier',
      batches: [
        {
          materialId: material.id,
          batchNumber: `CALG-${Date.now()}`,
          quantity: 40,
          containerCount: 2,
          manufacturedAt: new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10),
          expiryDate: new Date(Date.now() + 500 * 864e5).toISOString().slice(0, 10),
        },
      ],
    },
  });
  const calReq = await api('POST', '/stores/sampling-requests', {
    token: stores.accessToken,
    body: { batchId: calReceipt.body.batches[0].id, reason: 'RELEASE_TESTING' },
  });
  const calSampled = await api('POST', `/stores/sampling-requests/${calReq.body.id}/sample`, {
    token: tech.accessToken,
    body: { labId, containersSampled: 2 },
  });
  const calAccession = calSampled.body.accessionNumber;
  const calSample = await api('GET', `/samples/by-accession/${calAccession}`, {
    token: tech.accessToken,
  });

  await devicePost(creds, '/v1/ingest/messages', {
    messageId: randomUUID(),
    deviceId: creds.deviceId,
    protocol: 'FILE_CSV',
    capturedAt: new Date().toISOString(),
    rawChecksum: createHash('sha256').update(calAccession).digest('hex'),
    observations: [
      {
        specimenRef: calAccession,
        testCode: 'ASSAY',
        value: '99.55',
        units: '%',
        resultStatus: 'FINAL',
        rerunCount: 0,
        isQc: false,
        rawFields: {},
      },
    ],
  });

  let calTestId = null;
  for (const t of calSample.body.tests ?? []) {
    const d = await api('GET', `/tests/${t.id}`, { token: tech.accessToken });
    if (d.body?.testDefinition?.code === 'TASSAY') {
      calTestId = t.id;
      break;
    }
  }
  await api('POST', `/tests/${calTestId}/verify`, { token: tech.accessToken, body: {} });

  const calBound = await api('GET', `/tests/${calTestId}`, { token: patho.accessToken });
  calBound.body?.device?.code === 'CHEM-01'
    ? ok('a second assay is bound to the same analyzer', 'ready for the calibration check')
    : bad('analyzer-bound test built', `device=${calBound.body?.device?.code}`);

  const tryCalAuth = async () => {
    const h = await api('GET', `/tests/${calTestId}/content-hash`, { token: patho.accessToken });
    const tok = await api('POST', '/auth/signing-token', {
      token: patho.accessToken,
      body: {
        password: PASSWORD,
        entityType: 'SampleTest',
        entityId: calTestId,
        meaning: 'AUTHORIZED',
        contentHash: h.body.contentHash,
      },
    });
    return api('POST', `/tests/${calTestId}/authorize`, {
      token: patho.accessToken,
      body: { signingToken: tok.body.signingToken, meaning: 'AUTHORIZED' },
    });
  };

  const blockedByCal = await tryCalAuth();
  blockedByCal.status === 403 && /calibration/i.test(blockedByCal.body?.detail ?? '')
    ? ok('authorisation BLOCKED by the lapsed calibration', String(blockedByCal.body.detail).slice(0, 66))
    : bad(
        'calibration gate blocks authorisation',
        `${blockedByCal.status}: ${String(blockedByCal.body?.detail).slice(0, 100)}`,
      );

  // And the way out is recording the calibration, not disabling the check.
  const recalibrated = await api('POST', `/ingest/devices/${chemDeviceId}/calibration`, {
    token: admin.accessToken,
    body: {
      performedAt: new Date().toISOString().slice(0, 10),
      nextDueAt: new Date(Date.now() + 180 * 864e5).toISOString().slice(0, 10),
      certificateRef: 'CAL/2026/CHEM-01/014',
      note: 'Annual calibration by the service engineer; certificate on file.',
    },
  });
  recalibrated.status < 300
    ? ok('recalibration recorded with a certificate reference')
    : bad('recalibrate', `${recalibrated.status}`);

  const allowedAfterCal = await tryCalAuth();
  allowedAfterCal.body?.status === 'AUTHORIZED'
    ? ok('recalibrating unblocks authorisation', 'the gate opens on evidence, not on a switch')
    : bad(
        'gate reopens after recalibration',
        `${allowedAfterCal.status} ${JSON.stringify(allowedAfterCal.body).slice(0, 110)}`,
      );

  const noCert = await api('POST', `/ingest/devices/${chemDeviceId}/calibration`, {
    token: admin.accessToken,
    body: {
      performedAt: new Date().toISOString().slice(0, 10),
      nextDueAt: new Date(Date.now() + 180 * 864e5).toISOString().slice(0, 10),
      certificateRef: '',
    },
  });
  noCert.status >= 400
    ? ok('a calibration without a certificate reference is refused', 'the evidence is the point')
    : bad('certificate reference required', `${noCert.status}`);

  const calAudit = await api('GET', '/compliance/audit?action=CALIBRATION_RECORDED&limit=5', {
    token: admin.accessToken,
  });
  (calAudit.body?.items ?? []).length > 0
    ? ok('calibration changes are audited as their own verb', 'CALIBRATION_RECORDED')
    : bad('calibration audited', JSON.stringify(calAudit.body).slice(0, 120));

  // ----------------------------------------------------- documented override
  section('Resolving a failure');

  const noReason = await api('POST', `/qc/results/${reject.body.id}/accept`, {
    token: admin.accessToken,
    body: { actionTaken: 'ok' },
  });
  noReason.status === 422
    ? ok('override requires a substantive reason', 'rejects "ok"')
    : bad('override requires a reason', `got ${noReason.status}`);

  const resolved = await api('POST', `/qc/results/${reject.body.id}/accept`, {
    token: admin.accessToken,
    body: {
      actionTaken: 'Recalibrated the analyzer and opened a fresh control vial; re-run within 1SD.',
    },
  });
  [200, 201].includes(resolved.status)
    ? ok('failure resolved with a documented action')
    : bad('failure resolved', JSON.stringify(resolved.body).slice(0, 150));

  const twice = await api('POST', `/qc/results/${reject.body.id}/accept`, {
    token: admin.accessToken,
    body: { actionTaken: 'Trying to resolve the same failure a second time.' },
  });
  twice.status === 400
    ? ok('a resolved failure cannot be resolved again')
    : bad('double resolution rejected', `got ${twice.status}`);

  // ------------------------------------------------------------------ audit
  section('Audit trail');

  const overrides = await api('GET', '/compliance/audit?action=QC_OVERRIDE&limit=10', {
    token: auditor.accessToken,
  });
  const entry = (overrides.body?.items ?? [])[0];
  entry
    ? ok('override recorded as QC_OVERRIDE', `seq ${entry.seq}`)
    : bad('QC_OVERRIDE audited');

  entry?.reason
    ? ok('corrective action stored as the reason', entry.reason.slice(0, 55))
    : bad('corrective action in audit reason');

  const chain = await api('GET', '/compliance/audit-chain/verify', { token: auditor.accessToken });
  chain.body?.status === 'PASSED'
    ? ok('audit chain still verifies', `${chain.body.entriesChecked} entries`)
    : bad('chain verifies after QC activity', JSON.stringify(chain.body).slice(0, 150));

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
