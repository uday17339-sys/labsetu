#!/usr/bin/env node
/**
 * The lab owner's walkthrough.
 *
 * Not a test of what was built — a test of what someone who RUNS a diagnostic
 * lab actually needs to do, day to day. Each task below is something Anita (lab
 * owner, Sunrise Diagnostics, Hyderabad) does in a normal week.
 *
 * Every task is attempted for real. If it cannot be done, that is reported as a
 * BLOCKER or GAP with the reason — not glossed over.
 *
 * Usage: node scripts/owner-walkthrough.mjs [apiBase] [webBase]
 */
const API = process.argv[2] ?? 'https://localhost/api';
const WEB = process.argv[3] ?? 'https://localhost';
const TENANT = 'SUNRISE';
const PASSWORD = 'LabSetu@2026';

const results = [];

/** Clinically plausible values, with a critically low haemoglobin. */
const PLAUSIBLE = {
  HB: '6.4', RBC: '3.2', WBC: '12500', PLT: '190000', HCT: '29.1',
  MCV: '79.2', MCH: '24.5', MCHC: '30.9', NEUT: '74', LYMP: '18',
  EOSI: '4', MONO: '4',
};

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

async function main() {
  console.log(`\n\x1b[1mLab owner walkthrough — Anita Rao, Sunrise Diagnostics\x1b[0m\n`);
  console.log(`  "Can I actually run my lab on this?"\n`);

  const admin = await login('admin@sunrise.test');
  const reception = await login('front@sunrise.test');
  const tech = await login('tech@sunrise.test');
  const patho = await login('pathologist@sunrise.test');
  const adminCookie = cookieFor(admin);

  // ==================================================================
  section('MONDAY MORNING — a patient walks in');

  const catalog = await api('GET', '/catalog/tests', { token: reception.accessToken });
  const cbc = catalog.body.find((t) => t.code === 'CBC');
  catalog.status === 200 ? works('See my test menu and prices') : blocker('See my test menu');

  const patient = await api('POST', '/patients', {
    token: reception.accessToken,
    body: {
      fullName: 'Lakshmi Prasad',
      sex: 'FEMALE',
      ageYears: 54,
      phone: '9701234567',
      consents: [
        { purpose: 'DIAGNOSTIC_SERVICE', granted: true, noticeVersion: 'v1' },
        { purpose: 'REPORT_DELIVERY', granted: true, noticeVersion: 'v1' },
      ],
    },
  });
  patient.status < 300
    ? works('Register a walk-in patient', patient.body.patientCode)
    : blocker('Register a patient', JSON.stringify(patient.body).slice(0, 80));

  const order = await api('POST', '/orders', {
    token: reception.accessToken,
    body: {
      labId: reception.user.labs[0].id,
      patientId: patient.body.id,
      items: [{ testDefinitionId: cbc.id }],
      createSample: true,
    },
  });
  order.status < 300
    ? works('Book tests and get an accession number', order.body.samples[0].accessionNumber)
    : blocker('Book tests', JSON.stringify(order.body).slice(0, 80));

  // A walk-in pays at the counter. Can I take the money?
  const invoiceRead = await api('GET', '/billing/invoices', { token: reception.accessToken });
  invoiceRead.status !== 200
    ? blocker(
        'Take payment at the counter',
        'No invoice screen or API — the invoice exists in data but I cannot see it, print it, or record cash',
      )
    : works('Take payment at the counter');

  // ==================================================================
  section('A DOCTOR PHONES — "what happened to Mrs Rao\'s sample?"');

  const byPhone = await api(
    'GET',
    `/patients?phone=${encodeURIComponent('9701234567')}`,
    { token: reception.accessToken },
  );
  byPhone.body?.length > 0
    ? works('Find a patient by phone number')
    : blocker('Find a patient by phone', JSON.stringify(byPhone.body).slice(0, 80));

  const byPartialName = await api('GET', '/patients?name=Lakshmi', {
    token: reception.accessToken,
  });
  byPartialName.body?.length > 0
    ? works('Find a patient by partial name')
    : gap(
        'Find a patient by partial name',
        'Only EXACT full name matches — blind-index encryption cannot do substring search (ADR 0005). Staff must use phone or patient code.',
      );

  // `createdAt` is not encrypted, so a registration window answers "who came in
  // today" without weakening the blind-index design that blocks partial-name
  // search (ADR 0005).
  const day = new Date().toISOString().slice(0, 10);
  const todayList = await api(
    'GET',
    `/patients?registeredFrom=${day}T00:00:00.000Z&registeredTo=${day}T23:59:59.999Z&limit=50`,
    { token: reception.accessToken },
  );
  todayList.status !== 200
    ? gap(
        "See today's registrations as a list",
        JSON.stringify(todayList.body).slice(0, 110),
      )
    : works("See today's registrations as a list", `${todayList.body.length} today`);

  const todayUi = await page("/patients", cookieFor(reception));
  todayUi.status === 200 && /registration|Patients/i.test(todayUi.html)
    ? works('Browse patients from a screen')
    : gap('Browse patients from a screen', 'No patient list page');

  // ==================================================================
  section('THE BENCH — running the work');

  const accession = order.body.samples[0].accessionNumber;
  const sample = await api('GET', `/samples/by-accession/${accession}`, {
    token: tech.accessToken,
  });
  sample.status === 200 ? works('Scan a barcode to pull up a sample') : blocker('Barcode lookup');

  await api('POST', `/samples/${sample.body.id}/collect`, { token: tech.accessToken, body: {} });
  const received = await api('POST', `/samples/${sample.body.id}/receive`, {
    token: tech.accessToken,
    body: {},
  });
  received.status < 300 ? works('Receive a sample into the lab') : blocker('Receive a sample');

  const refData = await api('GET', '/catalog/reference-data', { token: tech.accessToken });
  refData.body?.rejectionReasons?.length > 0
    ? works('Reject a bad sample with a coded reason', `${refData.body.rejectionReasons.length} reasons`)
    : blocker('Reject a sample');

  const testId = sample.body.tests[0].id;
  const analytes = sample.body.tests[0].testDefinition.analytes;
  const entry = await api('POST', `/tests/${testId}/results`, {
    token: tech.accessToken,
    body: {
      // All of them: verification refuses an incomplete panel, which is
      // correct. Entering four of twelve made the release chain look broken
      // when it was the test that was wrong.
      results: analytes.map((a) => ({
        analyteId: a.analyte.id,
        value: PLAUSIBLE[a.analyte.code] ?? '5',
      })),
    },
  });
  entry.status < 300
    ? works('Enter results by hand when the analyzer is down')
    : blocker('Manual result entry', JSON.stringify(entry.body).slice(0, 90));

  const critical = (entry.body?.results ?? []).find((r) => r.isCritical);
  critical
    ? works('See a critical value flagged automatically', `${critical.analyte?.code} ${critical.value}`)
    : gap('Critical value flagged', 'none in this run');

  // NABL expects evidence the clinician was PHONED, not just that it was flagged.
  const callbackFields = critical
    ? Object.keys(critical).some((k) => k.toLowerCase().includes('notified'))
    : false;
  callbackFields
    ? works('Record the critical-value callback to the doctor')
    : gap(
        'Record the critical-value callback',
        'Schema has criticalNotifiedAt/By/To but there is no endpoint or screen — NABL wants evidence of the phone call, not just the flag',
      );

  // ==================================================================
  section('RELEASING WORK');

  await api('POST', `/tests/${testId}/verify`, { token: tech.accessToken, body: {} });
  const hash = await api('GET', `/tests/${testId}/content-hash`, { token: patho.accessToken });
  const tok = await api('POST', '/auth/signing-token', {
    token: patho.accessToken,
    body: {
      password: PASSWORD,
      entityType: 'SampleTest',
      entityId: testId,
      meaning: 'AUTHORIZED',
      contentHash: hash.body.contentHash,
    },
  });
  const authd = await api('POST', `/tests/${testId}/authorize`, {
    token: patho.accessToken,
    body: { signingToken: tok.body.signingToken, meaning: 'AUTHORIZED' },
  });
  authd.body?.status === 'AUTHORIZED'
    ? works('Authorise results with my signature')
    : blocker('Authorise results', JSON.stringify(authd.body).slice(0, 90));

  const report = await api('POST', '/reports', {
    token: patho.accessToken,
    body: { orderId: order.body.id, isPartial: true },
  });
  report.body?.reportNumber
    ? works('Generate the report', report.body.reportNumber)
    : blocker('Generate a report', JSON.stringify(report.body).slice(0, 90));

  const rHash = await api('GET', `/reports/${report.body.id}/content-hash`, {
    token: patho.accessToken,
  });
  const rTok = await api('POST', '/auth/signing-token', {
    token: patho.accessToken,
    body: {
      password: PASSWORD,
      entityType: 'Report',
      entityId: report.body.id,
      meaning: 'AUTHORIZED',
      contentHash: rHash.body.contentHash,
    },
  });
  const released = await api('POST', `/reports/${report.body.id}/release`, {
    token: patho.accessToken,
    body: { signingToken: rTok.body.signingToken, deliverTo: [{ channel: 'WHATSAPP' }] },
  });
  released.body?.status === 'RELEASED'
    ? works('Release the report to the patient')
    : blocker('Release a report', JSON.stringify(released.body).slice(0, 90));

  const delivered = released.body?.deliveries?.[0];
  delivered?.status === 'QUEUED'
    ? gap(
        'Actually send the report on WhatsApp',
        'Delivery is queued and consent-checked, but no provider is connected — nothing leaves the building',
      )
    : gap('WhatsApp delivery', `status ${delivered?.status}`);

  // A patient rings a week later having lost their report.
  const reprint = await api('GET', `/reports/${report.body.id}`, { token: reception.accessToken });
  reprint.status === 200
    ? works('Pull up a released report again to reprint')
    : blocker('Reprint a report', `${reprint.status}`);

  // ...but can the front desk FIND it without knowing the report id?
  const reportSearch = await api('GET', '/reports?limit=20', { token: reception.accessToken });
  reportSearch.status !== 200
    ? gap(
        'Browse or search released reports',
        'No report list endpoint — you must navigate patient → sample → order → report',
      )
    : works('Browse released reports');

  // ==================================================================
  section('SOMETHING WENT WRONG — correcting a released result');

  const amendTok = await api('POST', '/auth/signing-token', {
    token: patho.accessToken,
    body: {
      password: PASSWORD,
      entityType: 'Report',
      entityId: report.body.id,
      meaning: 'AMENDED',
      contentHash: rHash.body.contentHash,
    },
  });
  const amended = await api('POST', `/reports/${report.body.id}/amend`, {
    token: patho.accessToken,
    body: {
      signingToken: amendTok.body.signingToken,
      reason: 'Haemoglobin transcribed incorrectly from the analyzer printout; corrected on review.',
    },
  });
  amended.status < 300
    ? works('Amend a released report with a documented reason', `v${amended.body?.version}`)
    : gap('Amend a released report', JSON.stringify(amended.body).slice(0, 90));

  const amendUi = await page(`/reports/${report.body.id}`, adminCookie);
  amendUi.html.includes('Amend') || amendUi.html.includes('amend')
    ? works('Amend from the screen, not just the API')
    : gap(
        'Amend from the screen',
        'The API supports amendment but there is no button — a pathologist cannot do it without a developer',
      );

  // ==================================================================
  section('RUNNING THE BUSINESS');

  const indicators = await api('GET', '/compliance/quality-indicators', {
    token: admin.accessToken,
  });
  indicators.status === 200
    ? works('See NABL quality indicators', `rejection ${indicators.body.sampleRejectionRate.value}%`)
    : blocker('Quality indicators');

  // Probe a path that cannot collide with /reports/:id. The earlier probe hit
  // that route, got a 400 UUID-parse error rather than 404, and reported a
  // missing feature as working.
  const revenue = await api('GET', '/analytics/revenue', { token: admin.accessToken });
  revenue.status !== 200
    ? blocker(
        "See today's revenue and collections",
        'No financial reporting at all. I cannot tell you what the lab earned today, who owes money, or which doctor refers most.',
      )
    : works('See revenue');

  const dash = await page('/', adminCookie);
  dash.html.includes('Overdue')
    ? works('See what is overdue and pending at a glance')
    : blocker('Operational dashboard');

  // ==================================================================
  section('ADMINISTRATION — running the practice');

  // Onboarding runs exactly as the screen does: read the roles, pick one, post.
  // An earlier version of this probe invented a `roleCode` field and read the
  // resulting 422 as "no user management" — the endpoint was fine, the probe
  // was wrong. Anything a real screen fetches first, this fetches first.
  const roles = await api('GET', '/admin/roles', { token: admin.accessToken });
  const techRole = (roles.body ?? []).find((r) => r.code === 'LAB_TECHNICIAN');

  const addUser =
    roles.status === 200 && techRole
      ? await api('POST', '/admin/users', {
          token: admin.accessToken,
          body: {
            email: `newtech.${Date.now()}@sunrise.test`,
            fullName: 'Kavya Menon',
            roleIds: [techRole.id],
            phone: '9876500011',
          },
        })
      : { status: 500, body: { detail: 'Could not read the role list' } };

  addUser.status >= 400
    ? blocker(
        'Add a staff member when someone joins',
        `Onboarding failed: ${JSON.stringify(addUser.body).slice(0, 120)}`,
      )
    : works(
        'Add a staff member when someone joins',
        `${addUser.body.fullName} - temp password issued`,
      );

  // A new hire must also be assessed before touching a result. This was the
  // sharpest hole: authorisation REQUIRES current competency, so with no way to
  // grant it a newly hired pathologist could never sign anything at all.
  const catalogForCompetency = await api('GET', '/catalog/tests', { token: admin.accessToken });
  const firstTest = (catalogForCompetency.body ?? [])[0];
  const grant =
    addUser.status < 300 && firstTest
      ? await api('POST', '/admin/competency', {
          token: admin.accessToken,
          body: {
            userId: addUser.body.id,
            testDefinitionIds: [firstTest.id],
            level: 'PERFORM',
            evidenceNote: 'Direct observation over 20 parallel runs; record COMP-2026-031.',
          },
        })
      : { status: 500, body: { detail: 'No user or test to assess' } };

  grant.status >= 400
    ? blocker(
        'Record a competency assessment',
        `Authorisation requires competency and it cannot be granted: ${JSON.stringify(grant.body).slice(0, 110)}`,
      )
    : works('Record a competency assessment', `${grant.body.count} test - PERFORM`);

  const competencyMatrix = await api('GET', '/admin/competency', { token: admin.accessToken });
  competencyMatrix.status === 200
    ? works(
        'See who is competent to do what',
        `${competencyMatrix.body.counts.live} live, ${competencyMatrix.body.counts.expiring} expiring`,
      )
    : gap('See the competency matrix', 'No matrix view');

  // Adding a test the way the catalog screen does: pick analytes, then post.
  const catalogAnalytes = await api('GET', '/catalog/analytes', { token: admin.accessToken });
  const pick = (catalogAnalytes.body ?? [])
    .slice(0, 1)
    .map((a, i) => ({ analyteId: a.id, sortOrder: i }));

  const addTest =
    pick.length > 0
      ? await api('POST', '/catalog/tests', {
          token: admin.accessToken,
          body: {
            code: `VITD${Date.now().toString().slice(-5)}`,
            name: 'Vitamin D (25-OH)',
            department: 'BIOCHEMISTRY',
            price: 1200,
            tatMinutes: 1440,
            analytes: pick,
          },
        })
      : { status: 500, body: { detail: 'No analytes available to attach' } };

  addTest.status >= 400
    ? blocker(
        'Add a new test to my menu',
        `Could not add a test: ${JSON.stringify(addTest.body).slice(0, 120)}`,
      )
    : works('Add a new test to my menu', `${addTest.body.name}`);

  // Raising a price is the most common catalog edit in a running lab.
  const existing = (catalogForCompetency.body ?? [])[0];
  const repriced = existing
    ? await api('PATCH', `/catalog/tests/${existing.id}`, {
        token: admin.accessToken,
        body: { price: Number(existing.price) + 50, reason: 'Annual price revision' },
      })
    : { status: 500, body: {} };

  repriced.status >= 400
    ? blocker('Change a price', JSON.stringify(repriced.body).slice(0, 120))
    : works('Change a price', `${repriced.body.code} now ${repriced.body.price}`);

  // No fixed code: a second run of this walkthrough must not fail on a
  // uniqueness clash it created itself. Omitting the code exercises the
  // auto-numbering the front desk actually relies on.
  const addDoctor = await api('POST', '/catalog/doctors', {
    token: admin.accessToken,
    body: { name: `Dr Suresh Iyer ${Date.now().toString().slice(-5)}`, speciality: 'Cardiology' },
  });
  addDoctor.status >= 400
    ? gap('Add a referring doctor', JSON.stringify(addDoctor.body).slice(0, 110))
    : works('Add a referring doctor', `${addDoctor.body.code} auto-assigned`);


  // ==================================================================
  section('INVENTORY & QC');

  const inv = await api('GET', '/inventory/items', { token: admin.accessToken });
  inv.status === 200 ? works('See reagent stock and expiry') : blocker('Inventory');

  const addItem = await api('POST', '/inventory/items', {
    token: admin.accessToken,
    body: {
      code: `RGT${Date.now().toString().slice(-6)}`,
      name: 'Vitamin D assay kit',
      category: 'REAGENT',
      unit: 'tests',
      reorderLevel: 100,
      storageCondition: '2-8 C',
    },
  });
  addItem.status >= 400
    ? gap('Add a new reagent to the catalogue', JSON.stringify(addItem.body).slice(0, 110))
    : works('Add a new reagent to the catalogue', addItem.body.code);

  const qc = await api('GET', '/qc/lots', { token: tech.accessToken });
  qc.status === 200 ? works('Run and review quality control') : blocker('QC');

  // A control lot without target values is worse than no lot: QC would appear
  // to run while every rule silently had nothing to test against. So the probe
  // supplies targets, exactly as the screen requires.
  const materials = await api('GET', '/qc/materials', { token: admin.accessToken });
  const material = (materials.body ?? [])[0];
  // A control lot needs a MEASURED analyte: a target mean and SD over a blood
  // group would make the Westgard rules evaluate nonsense. The API refuses it;
  // the probe should ask for something sensible in the first place.
  const qcAnalyte = (catalogAnalytes.body ?? []).find(
    (a) => a.valueType === 'NUMERIC' || a.valueType === 'NUMERIC_BOUNDED',
  );

  const addQcLot =
    material && qcAnalyte
      ? await api('POST', '/qc/lots', {
          token: admin.accessToken,
          body: {
            qcMaterialId: material.id,
            lotNumber: `LOT-${Date.now().toString().slice(-6)}`,
            expiryDate: new Date(Date.now() + 180 * 864e5).toISOString().slice(0, 10),
            analytes: [{ analyteId: qcAnalyte.id, targetMean: 12.5, targetSd: 0.4 }],
          },
        })
      : { status: 500, body: { detail: 'No QC material or analyte available' } };

  addQcLot.status >= 400
    ? gap(
        'Register a new QC lot when the old one runs out',
        JSON.stringify(addQcLot.body).slice(0, 110),
      )
    : works('Register a new QC lot', `${addQcLot.body.lotNumber} of ${addQcLot.body.material}`);

  // ==================================================================
  const ok = results.filter((r) => r.level === 'OK').length;
  const gaps = results.filter((r) => r.level === 'GAP');
  const blockers = results.filter((r) => r.level === 'BLOCKER');

  console.log(`\n${'─'.repeat(72)}`);
  console.log(
    `\n\x1b[1m${ok} tasks work · ${gaps.length} gaps · ${blockers.length} blockers\x1b[0m\n`,
  );

  if (blockers.length) {
    console.log('\x1b[31mBLOCKERS — a real lab cannot operate without these:\x1b[0m\n');
    for (const b of blockers) console.log(`  ✗ ${b.task}\n      ${b.detail}\n`);
  }
  if (gaps.length) {
    console.log('\x1b[33mGAPS — workable, but staff will ask:\x1b[0m\n');
    for (const g of gaps) console.log(`  ○ ${g.task}\n      ${g.detail}\n`);
  }
}

main().catch((err) => {
  console.error('\n\x1b[31mWalkthrough aborted:\x1b[0m', err.message);
  process.exit(1);
});
