#!/usr/bin/env node
/**
 * The Head of Quality's walkthrough.
 *
 * Not a test of what was built — a test of what someone who is ACCOUNTABLE for
 * a manufacturing site's quality actually has to do, week to week. Each task
 * below is something Dr Suresh Menon (Head of Quality, Vantage Pharmaceuticals,
 * Hyderabad) does in a normal week, and every one of them is attempted for real
 * against the running system.
 *
 * If a task cannot be done, it is reported as a BLOCKER or a GAP with the
 * reason. Nothing is glossed over: a walkthrough that always passes is a
 * brochure, not a check.
 *
 * Usage: node scripts/owner-walkthrough.mjs [apiBase] [webBase]
 */
const API = process.argv[2] ?? 'https://localhost/api';
const WEB = process.argv[3] ?? 'https://localhost';
const TENANT = 'VANTAGE';
const PASSWORD = 'LabSetu@2026';

const results = [];

const works = (task, detail = '') => {
  results.push({ level: 'OK', task, detail });
  console.log(`  \x1b[32m✓\x1b[0m  ${task}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
};
const gap = (task, detail = '') => {
  results.push({ level: 'GAP', task, detail });
  console.log(`  \x1b[33m○\x1b[0m  ${task}  \x1b[33m${detail}\x1b[0m`);
};
const blocker = (task, detail = '') => {
  results.push({ level: 'BLOCKER', task, detail });
  console.log(`  \x1b[31m✗\x1b[0m  ${task}  \x1b[31m${detail}\x1b[0m`);
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

async function page(path, cookie) {
  const res = await fetch(`${WEB}${path}`, { headers: { cookie }, redirect: 'follow' });
  return { status: res.status, html: await res.text() };
}

const login = (email) =>
  api('POST', '/auth/login', { body: { tenantCode: TENANT, email, password: PASSWORD } }).then(
    (r) => r.body,
  );

const cookieFor = (auth) =>
  `labsetu_at=${auth.accessToken}; labsetu_rt=${auth.refreshToken}; ` +
  `labsetu_user=${encodeURIComponent(JSON.stringify(auth.user))}`;

/** Signs and authorises one test, the way the bench and QA actually do it. */
async function authorize(testId, signer) {
  const hash = await api('GET', `/tests/${testId}/content-hash`, { token: signer.accessToken });
  const token = await api('POST', '/auth/signing-token', {
    token: signer.accessToken,
    body: {
      password: PASSWORD,
      entityType: 'SampleTest',
      entityId: testId,
      meaning: 'AUTHORIZED',
      contentHash: hash.body.contentHash,
    },
  });
  return api('POST', `/tests/${testId}/authorize`, {
    token: signer.accessToken,
    body: { signingToken: token.body.signingToken, meaning: 'AUTHORIZED' },
  });
}

async function main() {
  console.log(
    `\n\x1b[1mHead of Quality walkthrough — Dr Suresh Menon, Vantage Pharmaceuticals\x1b[0m\n`,
  );
  console.log(`  "Can I actually run my quality system on this?"\n`);

  const admin = await login('admin@vantage.test');
  const stores = await login('stores@vantage.test');
  const analyst = await login('qc@vantage.test');
  const analyst2 = await login('qc2@vantage.test');
  const qa = await login('qa@vantage.test');
  const auditor = await login('auditor@vantage.test');
  const adminCookie = cookieFor(admin);
  const labId = stores.user.labs[0].id;

  // ==================================================================
  section('MONDAY MORNING — a consignment arrives at the gate');

  const materials = await api('GET', '/stores/materials', { token: stores.accessToken });
  materials.status === 200 && materials.body.length > 0
    ? works('See my approved material list', `${materials.body.length} materials`)
    : blocker('See the material master', JSON.stringify(materials.body).slice(0, 80));

  const api_pcm = materials.body.find((m) => m.code === 'API-PCM');
  const batchNumber = `WT-${Date.now().toString().slice(-8)}`;

  const grn = await api('POST', '/stores/receive', {
    token: stores.accessToken,
    body: {
      labId,
      supplierName: 'Hetero Drugs Ltd',
      invoiceNumber: `HDL/26/${Date.now().toString().slice(-5)}`,
      batches: [
        {
          materialId: api_pcm.id,
          batchNumber,
          quantity: 500,
          containerCount: 20,
          manufacturedAt: new Date(Date.now() - 25 * 864e5).toISOString().slice(0, 10),
          expiryDate: new Date(Date.now() + 700 * 864e5).toISOString().slice(0, 10),
        },
      ],
    },
  });
  const batch = grn.body?.batches?.[0];
  batch
    ? works('Book in a consignment against a GRN', `${grn.body.grnNumber} · ${batchNumber}`)
    : blocker('Book in a consignment', JSON.stringify(grn.body).slice(0, 110));

  batch?.status === 'QUARANTINE'
    ? works('New stock is quarantined automatically', 'nobody has to remember to do it')
    : blocker('Automatic quarantine', `status=${batch?.status}`);

  const earlyIssue = await api('POST', `/stores/batches/${batch.id}/issue`, {
    token: stores.accessToken,
    body: { quantity: 50, reference: 'PO/26/0512 — Granulation' },
  });
  earlyIssue.status >= 400
    ? works('Untested stock CANNOT reach production', String(earlyIssue.body?.detail ?? '').slice(0, 58))
    : blocker('Quarantine actually blocks issue', `issue succeeded with ${earlyIssue.status}`);

  const storesUi = await page('/stores', cookieFor(stores));
  storesUi.status === 200 && storesUi.html.includes(batchNumber)
    ? works('The new batch shows on the stores screen', 'no refresh gymnastics')
    : gap('Stores screen shows the batch', `status ${storesUi.status}`);

  // ==================================================================
  section('SAMPLING — the handover from the warehouse to QC');

  const request = await api('POST', '/stores/sampling-requests', {
    token: stores.accessToken,
    body: { batchId: batch.id, reason: 'RELEASE_TESTING' },
  });
  request.status < 300
    ? works('Raise a sampling request against the batch')
    : blocker('Raise a sampling request', JSON.stringify(request.body).slice(0, 110));

  const storesSamples = await api('POST', `/stores/sampling-requests/${request.body.id}/sample`, {
    token: stores.accessToken,
    body: { labId, containersSampled: 5 },
  });
  storesSamples.status === 403
    ? works('The warehouse cannot sample its own stock', '403 — QC draws the sample')
    : gap('Sampling separated from stores', `got ${storesSamples.status}`);

  const sampled = await api('POST', `/stores/sampling-requests/${request.body.id}/sample`, {
    token: analyst.accessToken,
    body: { labId, containersSampled: 5 },
  });
  const accession = sampled.body?.accessionNumber;
  accession
    ? works('QC draws the sample and gets an AR number', accession)
    : blocker('Sample drawn', JSON.stringify(sampled.body).slice(0, 110));

  const sample = await api('GET', `/samples/by-accession/${accession}`, {
    token: analyst.accessToken,
  });
  (sample.body?.tests ?? []).length > 0
    ? works('The specification books the tests by itself', `${sample.body.tests.length} tests booked`)
    : blocker('Tests booked from the specification', 'no tests on the sample');

  // ==================================================================
  section('THE BENCH — testing against the specification');

  const tests = [];
  for (const t of sample.body.tests ?? []) {
    const detail = await api('GET', `/tests/${t.id}`, { token: analyst.accessToken });
    tests.push(detail.body);
  }

  // Values are derived from the specification rather than hard-coded, so the
  // walkthrough completes whatever criteria the spec actually carries. Hard-
  // coding a list meant that adding a criterion silently left it unfilled, and
  // the release gate then refused for a reason that had nothing to do with the
  // product.
  const specList = await api('GET', '/specifications', { token: qa.accessToken });
  const specForBatch = (specList.body ?? []).find(
    (sp) => sp.material?.code === api_pcm.code && sp.inForce,
  );
  const specDetail = specForBatch
    ? await api('GET', `/specifications/${specForBatch.id}`, { token: analyst.accessToken })
    : { body: { limits: [] } };
  const limitByCode = new Map((specDetail.body.limits ?? []).map((l) => [l.analyte.code, l]));

  const inSpecValue = (a) => {
    const limit = limitByCode.get(a.analyte.code);
    if (limit?.minValue != null && limit?.maxValue != null) {
      return String((Number(limit.minValue) + Number(limit.maxValue)) / 2);
    }
    if (limit?.maxValue != null) return String(Number(limit.maxValue) / 2);
    if (limit?.minValue != null) return String(limit.minValue);
    // A qualitative criterion. The spec's wording is the REQUIREMENT ("Complies
    // by IR"); what an analyst records is one of the analyte's permitted values
    // ("Complies"). The system deliberately does not compare prose, so entering
    // the criterion text as the result is simply the wrong field.
    return a.analyte.allowedValues?.[0] ?? 'Complies';
  };

  let entered = 0;
  for (const t of tests) {
    const rows = (t.testDefinition?.analytes ?? []).map((a) => ({
      analyteId: a.analyte.id,
      value: inSpecValue(a),
    }));
    if (rows.length === 0) continue;
    const saved = await api('POST', `/tests/${t.id}/results`, {
      token: analyst.accessToken,
      body: { results: rows },
    });
    if (saved.status < 300) entered += rows.length;
  }
  entered > 0
    ? works('Enter results against every acceptance criterion', `${entered} values`)
    : blocker('Enter results', 'nothing saved');

  const selfVerify = await api('POST', `/tests/${tests[0].id}/verify`, {
    token: analyst.accessToken,
    body: {},
  });
  // Verification by the same analyst is allowed; it is AUTHORISATION that needs
  // a second person. Confirm the four-eyes rule at the point it actually bites.
  const selfAuth = await authorize(tests[0].id, analyst);
  selfAuth.status === 403 || selfAuth.status === 422
    ? works('I cannot approve my own analyst’s work as that analyst', 'four-eyes enforced')
    : gap('Four-eyes on authorisation', `got ${selfAuth.status}`);

  let authorised = 0;
  for (const t of tests) {
    await api('POST', `/tests/${t.id}/verify`, { token: analyst.accessToken, body: {} });
    const res = await authorize(t.id, qa);
    if (res.body?.status === 'AUTHORIZED') authorised++;
  }
  authorised === tests.length
    ? works('Approve the analytical package as QA', `${authorised}/${tests.length} tests signed`)
    : gap('Authorise every test', `${authorised}/${tests.length}`);

  const worklistUi = await page('/worklist', cookieFor(analyst));
  worklistUi.status === 200
    ? works('The bench worklist opens and shows the day’s work')
    : blocker('Worklist screen', `status ${worklistUi.status}`);

  // ==================================================================
  section('THE DECISION — releasing a batch to the factory');

  const review = await api('GET', `/qa/batches/${batch.id}/review`, { token: qa.accessToken });
  review.status === 200 && (review.body?.assessment ?? []).length > 0
    ? works(
        'See every criterion, its limit and the result on ONE screen',
        `${review.body.summary.passed}/${review.body.summary.criteria} pass`,
      )
    : blocker('Batch review screen', JSON.stringify(review.body).slice(0, 110));

  const analystDisposition = await api('POST', `/qa/batches/${batch.id}/disposition`, {
    token: analyst.accessToken,
    body: { decision: 'APPROVED', rationale: 'Analyst attempting to release their own work' },
  });
  analystDisposition.status === 403
    ? works('An analyst CANNOT release a batch', '403 — only QA disposes')
    : blocker('Disposition restricted to QA', `got ${analystDisposition.status}`);

  const hash = await api('GET', `/qa/batches/${batch.id}/content-hash`, { token: qa.accessToken });
  const signing = await api('POST', '/auth/signing-token', {
    token: qa.accessToken,
    body: {
      password: PASSWORD,
      entityType: 'MaterialBatch',
      entityId: batch.id,
      meaning: 'APPROVED',
      contentHash: hash.body.contentHash,
    },
  });
  const disposition = await api('POST', `/qa/batches/${batch.id}/disposition`, {
    token: qa.accessToken,
    body: {
      decision: 'APPROVED',
      rationale:
        'All acceptance criteria within specification against SPEC/API-PCM/01. Supplier CoA cross-checked ' +
        'against in-house assay and water content. Released for manufacturing use.',
      signingToken: signing.body?.signingToken,
    },
  });
  disposition.status < 300
    ? works('Release the batch under my electronic signature', disposition.body?.decision)
    : blocker('Release the batch', JSON.stringify(disposition.body).slice(0, 130));

  const qaUi = await page('/qa', cookieFor(qa));
  qaUi.status === 200
    ? works('The QA release desk opens with my pending decisions')
    : blocker('QA screen', `status ${qaUi.status}`);

  // ==================================================================
  section('THE PAPERWORK — the certificate that leaves with the material');

  const coa = await api('POST', `/qa/batches/${batch.id}/coa`, { token: qa.accessToken });
  coa.status < 300
    ? works('Issue a Certificate of Analysis', `${coa.body.coaNumber} v${coa.body.version}`)
    : blocker('Issue a CoA', JSON.stringify(coa.body).slice(0, 130));

  const coaDoc = await api('GET', `/qa/coa/${coa.body.id}`, { token: qa.accessToken });
  (coaDoc.body?.results ?? []).length > 0 && coaDoc.body?.specification?.code
    ? works(
        'The certificate carries the spec, every result and the verdict',
        `${coaDoc.body.results.length} parameters vs ${coaDoc.body.specification.code}`,
      )
    : blocker('CoA content', JSON.stringify(coaDoc.body).slice(0, 110));

  const register = await api('GET', `/qa/coa?search=${encodeURIComponent(batchNumber)}`, {
    token: qa.accessToken,
  });
  (register.body?.items ?? []).length > 0
    ? works('Find a certificate months later from the batch number alone')
    : gap('Certificate register searchable', JSON.stringify(register.body).slice(0, 110));

  const coaUi = await page('/coa', adminCookie);
  coaUi.status === 200 && coaUi.html.includes('Certificate')
    ? works('The certificate register opens as a screen, not just an API')
    : gap('Certificate register screen', `status ${coaUi.status}`);

  // ==================================================================
  section('THE FACTORY FLOOR — issuing released material');

  const issue = await api('POST', `/stores/batches/${batch.id}/issue`, {
    token: stores.accessToken,
    body: { quantity: 120, reference: 'PO/26/0512 — Granulation Line 2' },
  });
  issue.status < 300
    ? works('Issue released material to production', `120 kg against PO/26/0512`)
    : blocker('Issue to production', JSON.stringify(issue.body).slice(0, 110));

  const overIssue = await api('POST', `/stores/batches/${batch.id}/issue`, {
    token: stores.accessToken,
    body: { quantity: 100000, reference: 'PO/26/0512 — deliberate over-draw' },
  });
  overIssue.status >= 400
    ? works('Stock cannot go negative', 'an over-draw is refused, not absorbed')
    : blocker('Over-issue refused', `got ${overIssue.status}`);

  // ==================================================================
  section('SOMETHING FAILED — an out-of-specification result');

  const allOos = await api('GET', '/qa/investigations', { token: qa.accessToken });
  const live = (allOos.body ?? []).find((i) => i.status !== 'CLOSED');
  live
    ? works('See every open investigation on my desk', `${live.investigationNumber} · ${live.phase}`)
    : gap('Open investigation queue', 'nothing open to review');

  if (live) {
    const shallow = await api('POST', `/qa/investigations/${live.id}/close`, {
      token: qa.accessToken,
      body: { conclusion: 'fine', rootCause: 'none' },
    });
    shallow.status >= 400
      ? works('An OOS cannot be closed with a shrug', 'the system asks for the investigation')
      : blocker('OOS closure validated', `closed with a one-word conclusion (${shallow.status})`);

    const progressed = await api('POST', `/qa/investigations/${live.id}/progress`, {
      token: qa.accessToken,
      body: {
        phase: 'PHASE_II',
        note:
          'Phase I found no laboratory error: medium preparation, de-aeration and paddle height all verified ' +
          'against the DISS-01 calibration record. Escalating to a manufacturing investigation of the ' +
          'compression stage.',
      },
    });
    progressed.status < 300
      ? works('Escalate an investigation from Phase I to Phase II')
      : gap('Escalate an investigation', JSON.stringify(progressed.body).slice(0, 110));
  }

  // ==================================================================
  section('AN AUDITOR ARRIVES UNANNOUNCED');

  const trail = await api('GET', `/compliance/audit?entityType=MaterialBatch&limit=100`, {
    token: auditor.accessToken,
  });
  const forThisBatch = (trail.body?.items ?? []).filter((e) => e.entityId === batch.id);
  forThisBatch.length > 0
    ? works('Show the full history of one batch', `${forThisBatch.length} entries for ${batchNumber}`)
    : blocker('Batch history', JSON.stringify(trail.body).slice(0, 110));

  const chain = await api('GET', '/compliance/audit-chain/verify', { token: auditor.accessToken });
  chain.body?.status === 'PASSED'
    ? works('Prove the record has not been altered', `${chain.body.entriesChecked} entries verified`)
    : blocker('Audit chain verification', JSON.stringify(chain.body).slice(0, 110));

  const auditorWrite = await api('POST', `/qa/batches/${batch.id}/disposition`, {
    token: auditor.accessToken,
    body: { decision: 'APPROVED', rationale: 'The auditor should not be able to do this' },
  });
  auditorWrite.status === 403
    ? works('The auditor login can read everything and change nothing', '403 on write')
    : blocker('Auditor is read-only', `got ${auditorWrite.status}`);

  const exported = await fetch(`${API}/v1/export/audit.csv`, {
    headers: { authorization: `Bearer ${auditor.accessToken}` },
  });
  exported.status === 200
    ? works('Hand the auditor a CSV they can open in Excel')
    : gap('Audit export', `status ${exported.status}`);

  const auditUi = await page('/audit', cookieFor(auditor));
  auditUi.status === 200
    ? works('The audit screen opens for the auditor’s own login')
    : blocker('Audit screen', `status ${auditUi.status}`);

  // ==================================================================
  section('RUNNING THE DEPARTMENT');

  const dash = await page('/', adminCookie);
  dash.status === 200
    ? works('The dashboard opens with the day’s quality position')
    : blocker('Dashboard', `status ${dash.status}`);

  const roles = await api('GET', '/admin/roles', { token: admin.accessToken });
  const analystRole = (roles.body ?? []).find((r) => r.code === 'QC_ANALYST');
  const hire = await api('POST', '/admin/users', {
    token: admin.accessToken,
    body: {
      email: `walkthrough.${Date.now().toString().slice(-7)}@vantage.test`,
      fullName: 'New QC Analyst',
      roleIds: [analystRole.id],
      qualification: 'M.Pharm (Pharmaceutical Analysis)',
    },
  });
  hire.status < 300
    ? works('Onboard a new analyst myself', 'temporary password issued once')
    : blocker('Onboard staff', JSON.stringify(hire.body).slice(0, 110));

  const matrix = await api('GET', '/admin/competency', { token: admin.accessToken });
  matrix.status === 200
    ? works('Answer "who is qualified to run this method?"', `${matrix.body.counts?.live ?? 0} live records`)
    : blocker('Competency matrix', `status ${matrix.status}`);

  const specs = await api('GET', '/specifications', { token: qa.accessToken });
  specs.status === 200 && (specs.body ?? []).length > 0
    ? works('Review the controlled specifications', `${specs.body.length} in force`)
    : blocker('Specifications', JSON.stringify(specs.body).slice(0, 110));

  const qcLots = await api('GET', '/qc/lots', { token: analyst.accessToken });
  qcLots.status === 200 && qcLots.body.length > 0
    ? works('Check the working standards in use', `${qcLots.body.length} lots`)
    : gap('QC lots', JSON.stringify(qcLots.body).slice(0, 110));

  const failures = await api('GET', '/qc/failures', { token: qa.accessToken });
  failures.status === 200
    ? works('See any control failure that is holding up release', `${(failures.body ?? []).length} open`)
    : gap('QC failure queue', `status ${failures.status}`);

  const stock = await api('GET', '/inventory/alerts', { token: analyst.accessToken });
  stock.status === 200
    ? works(
        'Know what is expiring or running out in the lab',
        `${stock.body.expired?.length ?? 0} expired · ${stock.body.belowReorder?.length ?? 0} to reorder`,
      )
    : gap('Stock alerts', `status ${stock.status}`);

  const devices = await api('GET', '/ingest/devices', { token: admin.accessToken });
  devices.status === 200 && devices.body.length > 0
    ? works('See whether my analyzers are still talking to the system', `${devices.body.length} instruments`)
    : gap('Instrument health', `status ${devices.status}`);

  const secondPair = await api('GET', '/worklist?limit=1', { token: analyst2.accessToken });
  secondPair.status === 200
    ? works('A second analyst can pick up the same worklist', 'the department is not one login')
    : gap('Second analyst access', `status ${secondPair.status}`);

  // ==================================================================
  const okCount = results.filter((r) => r.level === 'OK').length;
  const gaps = results.filter((r) => r.level === 'GAP');
  const blockers = results.filter((r) => r.level === 'BLOCKER');

  console.log(`\n${'─'.repeat(72)}`);
  console.log(
    `\n\x1b[1m${okCount} tasks work · ${gaps.length} gaps · ${blockers.length} blockers\x1b[0m\n`,
  );

  if (blockers.length) {
    console.log('\x1b[31mBLOCKERS — a real plant cannot operate without these:\x1b[0m\n');
    for (const b of blockers) console.log(`  ✗ ${b.task}\n      ${b.detail}\n`);
  }
  if (gaps.length) {
    console.log('\x1b[33mGAPS — workable, but quality staff will ask:\x1b[0m\n');
    for (const g of gaps) console.log(`  ○ ${g.task}\n      ${g.detail}\n`);
  }

  // The same tally in the shape verify-all parses, so this suite reports a
  // number alongside the others instead of "no result".
  console.log(`\x1b[1m${okCount} passed, ${gaps.length + blockers.length} failed\x1b[0m`);

  if (blockers.length) process.exit(1);
}

main().catch((err) => {
  console.error('\n\x1b[31mWalkthrough aborted:\x1b[0m', err.message);
  process.exit(1);
});
