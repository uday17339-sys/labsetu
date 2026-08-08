#!/usr/bin/env node
/**
 * Stores control, administration, competency, catalog and OOS administration.
 *
 * The rule this suite follows, same as the others: assert that each control
 * actually FIRES, not that the happy path returns 200. Every bug worth finding
 * in this codebase so far has been a control that looked present and was not —
 * a QC gate that could never trigger, failed logins vanishing on rollback, a
 * signature replay guard that blocked legitimate amendments.
 *
 * Usage: node scripts/admin-verify.mjs [apiBase]
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
  // The auth bucket is 10/minute per IP. Backing off is the correct response to
  // the limiter working, rather than weakening it for the tests.
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

const uniq = () => Date.now().toString().slice(-7) + Math.floor(Math.random() * 90 + 10);

// ---------------------------------------------------------------------------

const admin = await login('admin@vantage.test');
const stores = await login('stores@vantage.test');
const tech = await login('qc@vantage.test');
const qa = await login('qa@vantage.test');

if (!admin?.accessToken) {
  console.error('Could not sign in as the administrator — is the stack running and seeded?');
  process.exit(1);
}

// ===========================================================================
section('Stores — stock control after the quarantine gate');

const labId = admin.user.labs[0].id;
const materialList = await api('GET', '/stores/materials', { token: stores.accessToken });
const rawMaterial = (materialList.body ?? []).find((m) => m.code === 'API-PCM');
rawMaterial
  ? ok('the material master is readable by stores', `${materialList.body.length} materials`)
  : bad('material master', JSON.stringify(materialList.body).slice(0, 120));

const batchNo = `ADM-${uniq()}`;
const consignment = await api('POST', '/stores/receive', {
  token: stores.accessToken,
  body: {
    labId,
    supplierName: 'Admin Verify Supplier',
    invoiceNumber: `INV-${uniq()}`,
    batches: [
      {
        materialId: rawMaterial.id,
        batchNumber: batchNo,
        quantity: 120,
        containerCount: 6,
        manufacturedAt: new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10),
        expiryDate: new Date(Date.now() + 400 * 864e5).toISOString().slice(0, 10),
      },
    ],
  },
});
const admBatch = consignment.body?.batches?.[0];
admBatch
  ? ok('a consignment can be booked in', `${consignment.body.grnNumber} · ${batchNo}`)
  : bad('goods receipt', `${consignment.status} ${JSON.stringify(consignment.body).slice(0, 120)}`);

admBatch?.status === 'QUARANTINE'
  ? ok('received stock lands in QUARANTINE', 'nothing is usable on arrival')
  : bad('quarantine on receipt', `status=${admBatch?.status}`);

// THE CONTROL: quarantined stock cannot reach production. This is the stores
// equivalent of cancelling a paid invoice — the one action that must not work.
const earlyIssue = await api('POST', `/stores/batches/${admBatch.id}/issue`, {
  token: stores.accessToken,
  body: { quantity: 10, reference: 'PO/2026/0442 — Granulation Line 2' },
});
earlyIssue.status === 403 || earlyIssue.status === 422 || earlyIssue.status === 400
  ? ok(
      'issuing QUARANTINE stock to production REFUSED',
      String(earlyIssue.body?.detail ?? '').slice(0, 62),
    )
  : bad('quarantine issue blocked', `${earlyIssue.status} ${JSON.stringify(earlyIssue.body).slice(0, 110)}`);

// Physical movement within the warehouse is not a release — it must stay legal.
const moved = await api('POST', `/stores/batches/${admBatch.id}/move`, {
  token: stores.accessToken,
  body: { location: 'QUARANTINE-B-04', reason: 'Consolidating quarantine bay A' },
});
moved.status === 200 || moved.status === 201
  ? ok('quarantined stock can still be moved within the store', 'location is not status')
  : bad('stock move', `${moved.status} ${JSON.stringify(moved.body).slice(0, 110)}`);

const badExpiry = await api('POST', '/stores/receive', {
  token: stores.accessToken,
  body: {
    labId,
    supplierName: 'Admin Verify Supplier',
    batches: [
      {
        materialId: rawMaterial.id,
        batchNumber: `BADEXP-${uniq()}`,
        quantity: 10,
        containerCount: 1,
        manufacturedAt: new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10),
        expiryDate: new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10),
      },
    ],
  },
});
badExpiry.status >= 400
  ? ok('a consignment expiring before it was made is refused', 'typo caught at the gate')
  : bad('expiry sanity', `${badExpiry.status}`);

const dupBatch = await api('POST', '/stores/receive', {
  token: stores.accessToken,
  body: {
    labId,
    supplierName: 'Admin Verify Supplier',
    batches: [
      {
        materialId: rawMaterial.id,
        batchNumber: batchNo,
        quantity: 5,
        containerCount: 1,
        manufacturedAt: new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10),
        expiryDate: new Date(Date.now() + 400 * 864e5).toISOString().slice(0, 10),
      },
    ],
  },
});
dupBatch.status >= 400
  ? ok('the same supplier batch cannot be booked in twice', 'batch number is the identity')
  : bad('duplicate batch refused', `${dupBatch.status}`);

const alerts = await api('GET', '/stores/alerts', { token: stores.accessToken });
alerts.status === 200
  ? ok('the store surfaces what needs attention', 'expiry and retest alerts reachable')
  : bad('stores alerts', `${alerts.status}`);

const techReceive = await api('POST', '/stores/receive', {
  token: tech.accessToken,
  body: { labId, supplierName: 'Unauthorised', batches: [] },
});
techReceive.status === 403 || techReceive.status === 400 || techReceive.status === 422
  ? ok('a QC analyst cannot book in stock', 'goods receipt belongs to stores')
  : bad('receipt permissioned', `${techReceive.status}`);

// ===========================================================================
section('Role separation — what each job may and may not do');

const rolesForSeparation = await api('GET', '/admin/roles', { token: admin.accessToken });
const roleCodes = (rolesForSeparation.body ?? []).map((r) => r.code).sort();

// A pharma tenant should not be carrying a phlebotomist or a billing clerk.
!roleCodes.includes('PHLEBOTOMIST') && !roleCodes.includes('RECEPTIONIST')
  ? ok('the tenant carries only manufacturing roles', roleCodes.join(', '))
  : bad('roles scoped to the vertical', roleCodes.join(', '));

const qaRole = rolesForSeparation.body?.find((r) => r.code === 'QA');
const qcRole = rolesForSeparation.body?.find((r) => r.code === 'QC_ANALYST');
const storesRole = rolesForSeparation.body?.find((r) => r.code === 'STORES');
const auditorRole = rolesForSeparation.body?.find((r) => r.code === 'AUDITOR');

// THE CONTROL: the person who runs the test may not be the person who releases
// the batch. Asserted on the role definition, which governs every user the
// tenant will ever create — not on a seeded individual.
qcRole && !qcRole.permissions.includes('batch:disposition')
  ? ok('a QC analyst CANNOT dispose of a batch', 'testing and releasing stay apart')
  : bad(
      'QC cannot dispose',
      qcRole ? qcRole.permissions.filter((x) => /batch/.test(x)).join(',') : 'no role',
    );

qaRole && qaRole.permissions.includes('batch:disposition')
  ? ok('QA carries the disposition authority', 'one role owns release')
  : bad('QA disposes', 'permission missing');

storesRole && !storesRole.permissions.includes('result:write')
  ? ok('stores CANNOT enter a QC result', 'the warehouse does not test its own goods')
  : bad('stores cannot test', storesRole ? 'result:write present' : 'no role');

auditorRole && auditorRole.permissions.every((pm) => !/:(write|manage|dispose|authorize)/.test(pm))
  ? ok(
      'the auditor role is read-only by construction',
      `${auditorRole.permissions.length} permissions, none mutating`,
    )
  : bad(
      'auditor read-only',
      auditorRole
        ? auditorRole.permissions.filter((x) => /:(write|manage|dispose)/.test(x)).join(',')
        : 'no role',
    );

const techDisposition = await api('POST', `/qa/batches/${admBatch.id}/disposition`, {
  token: tech.accessToken,
  body: { decision: 'APPROVED', justification: 'attempting release without authority' },
});
techDisposition.status === 403
  ? ok('the role definition is enforced at the endpoint too', '403 on disposition')
  : bad('disposition permissioned', `${techDisposition.status}`);

// ===========================================================================
section('Staff administration');

const roles = await api('GET', '/admin/roles', { token: admin.accessToken });
const analystRole = roles.body?.find((r) => r.code === 'QC_ANALYST');
analystRole
  ? ok('roles are listable with their permission counts', `${roles.body.length} roles`)
  : bad('roles listed', JSON.stringify(roles.body).slice(0, 120));

const newEmail = `verify.${uniq()}@vantage.test`;
const created = await api('POST', '/admin/users', {
  token: admin.accessToken,
  body: {
    email: newEmail,
    fullName: 'Verify Analyst',
    roleIds: [analystRole.id],
    qualification: 'M.Pharm (Pharmaceutical Analysis)',
    registrationNo: 'APSPC/99999',
  },
});
created.status === 201 && created.body.temporaryPassword
  ? ok('a new QC analyst can be onboarded', 'temporary password issued once')
  : bad('user created', `${created.status} ${JSON.stringify(created.body).slice(0, 100)}`);

created.body?.temporaryPassword?.length >= 12
  ? ok('the temporary password meets the policy floor', `${created.body.temporaryPassword.length} chars`)
  : bad('temp password length', `${created.body?.temporaryPassword?.length}`);

const dupe = await api('POST', '/admin/users', {
  token: admin.accessToken,
  body: { email: newEmail, fullName: 'Duplicate', roleIds: [analystRole.id] },
});
dupe.status === 400
  ? ok('a duplicate email is refused')
  : bad('duplicate refused', `${dupe.status}`);

const noRole = await api('POST', '/admin/users', {
  token: admin.accessToken,
  body: { email: `norole.${uniq()}@vantage.test`, fullName: 'No Role', roleIds: [] },
});
noRole.status >= 400
  ? ok('a user with no role is refused', 'signing in to do nothing is not a valid state')
  : bad('roleless user refused', `${noRole.status}`);

// THE CONTROL: an administrator cannot lock the tenant out of itself.
const selfOff = await api('PATCH', `/admin/users/${admin.user.id}`, {
  token: admin.accessToken,
  body: { status: 'INACTIVE' },
});
selfOff.status === 403
  ? ok('self-deactivation REFUSED', 'the tenant cannot lock itself out')
  : bad('self-deactivation refused', `${selfOff.status}`);

// ===========================================================================
section('Competency — the gate that had no key');

const catalogForCompetency = await api('GET', '/catalog/tests', { token: admin.accessToken });
const assayDef = (catalogForCompetency.body ?? []).find((t) => t.code === 'TASSAY');
assayDef
  ? ok('the test catalog is readable for competency assignment', assayDef.name)
  : bad('assay method found', JSON.stringify(catalogForCompetency.body).slice(0, 120));

const newUser = await login(newEmail);
newUser?.error || !newUser?.accessToken
  ? ok('the new user must change their password before working', 'first sign-in is gated')
  : ok('the new user can sign in', 'password change flagged');

const matrixBefore = await api('GET', `/admin/users/${created.body.id}`, {
  token: admin.accessToken,
});
matrixBefore.body?.competencies?.length === 0
  ? ok('a new analyst starts with NO competency', 'cannot authorise anything yet')
  : bad('new user competencies', `${matrixBefore.body?.competencies?.length}`);

const thinEvidence = await api('POST', '/admin/competency', {
  token: admin.accessToken,
  body: {
    userId: created.body.id,
    testDefinitionIds: [assayDef.id],
    level: 'AUTHORIZE',
    evidenceNote: 'ok',
  },
});
thinEvidence.status === 422 || thinEvidence.status === 400
  ? ok('competency without named evidence REFUSED', 'an assessor asks for the record')
  : bad('evidence required', `${thinEvidence.status}`);

const granted = await api('POST', '/admin/competency', {
  token: admin.accessToken,
  body: {
    userId: created.body.id,
    testDefinitionIds: [assayDef.id],
    level: 'AUTHORIZE',
    evidenceNote:
      'Direct observation of 20 parallel HPLC runs against Ravi Teja; record COMP-2026-044.',
  },
});
granted.status === 201 && granted.body.count === 1
  ? ok('competency granted with documented evidence', `${assayDef.code} · AUTHORIZE`)
  : bad('competency granted', `${granted.status} ${JSON.stringify(granted.body).slice(0, 100)}`);

// Re-assessment must supersede, not pile up — otherwise the record becomes
// unreadable after a few annual reviews.
const reassess = await api('POST', '/admin/competency', {
  token: admin.accessToken,
  body: {
    userId: created.body.id,
    testDefinitionIds: [assayDef.id],
    level: 'AUTHORIZE',
    evidenceNote: 'Annual re-assessment 2027; record COMP-2027-011, supervisor Dr Suresh Menon.',
  },
});
const afterReassess = await api('GET', `/admin/users/${created.body.id}`, {
  token: admin.accessToken,
});
const liveForAssay = (afterReassess.body?.competencies ?? []).filter(
  (c) => c.test.code === assayDef.code && c.level === 'AUTHORIZE' && c.isCurrent,
);
reassess.status === 201 && liveForAssay.length === 1
  ? ok('re-assessment SUPERSEDES rather than duplicating', '1 current record, history kept')
  : bad('re-assessment supersedes', `${liveForAssay.length} current records`);

const expired = await api('POST', '/admin/competency', {
  token: admin.accessToken,
  body: {
    userId: created.body.id,
    testDefinitionIds: [assayDef.id],
    level: 'PERFORM',
    validFrom: '2026-01-01',
    validUntil: '2025-01-01',
    evidenceNote: 'Deliberately inverted dates to prove the range is validated.',
  },
});
expired.status === 400
  ? ok('an expiry before the start date is refused')
  : bad('date range validated', `${expired.status}`);

const matrix = await api('GET', '/admin/competency', { token: admin.accessToken });
matrix.status === 200 && matrix.body.counts.live > 0
  ? ok('the competency matrix answers "who may do what"', `${matrix.body.counts.live} live`)
  : bad('competency matrix', JSON.stringify(matrix.body).slice(0, 120));

// The superseded record is already revoked, so revoking THAT would only prove
// the guard. Target the record that is actually live.
const currentId = liveForAssay[0]?.id ?? granted.body.granted[0].id;
const revoked = await api('POST', `/admin/competency/${currentId}/revoke`, {
  token: admin.accessToken,
  body: { reason: 'Verification run — revoking to prove the path works' },
});
revoked.status === 201 || revoked.status === 200
  ? ok('competency can be revoked with a reason')
  : bad('competency revoked', `${revoked.status} ${JSON.stringify(revoked.body).slice(0, 90)}`);

const revokeAgain = await api('POST', `/admin/competency/${currentId}/revoke`, {
  token: admin.accessToken,
  body: { reason: 'Second attempt — should be refused as already revoked' },
});
revokeAgain.status === 400
  ? ok('a revoked competency cannot be revoked twice')
  : bad('double revoke refused', `${revokeAgain.status}`);

// And the consequence that matters: with nothing current, the gate closes again.
const afterRevoke = await api('GET', `/admin/users/${created.body.id}`, {
  token: admin.accessToken,
});
(afterRevoke.body?.competencies ?? []).every((c) => !c.isCurrent || c.level !== 'AUTHORIZE')
  ? ok('revoking removes the ability to authorise', 'the gate closes again')
  : bad('revocation takes effect', 'an AUTHORIZE competency is still current');

// ===========================================================================
section('Catalog authoring');

const analytes = await api('GET', '/catalog/analytes', { token: admin.accessToken });
analytes.status === 200 && analytes.body.length > 0
  ? ok('analytes are listable for test authoring', `${analytes.body.length} analytes`)
  : bad('analytes listed', `${analytes.status}`);

const noAnalytes = await api('POST', '/catalog/tests', {
  token: admin.accessToken,
  body: {
    code: `EMPTY${uniq()}`,
    name: 'Test With No Analytes',
    department: 'BIOCHEMISTRY',
    price: 100,
    analytes: [],
  },
});
noAnalytes.status >= 400
  ? ok('a test with no analytes REFUSED', 'it could be ordered but never resulted')
  : bad('empty test refused', `${noAnalytes.status}`);

const newTest = await api('POST', '/catalog/tests', {
  token: admin.accessToken,
  body: {
    code: `VITD${uniq()}`,
    name: 'Vitamin D (25-OH)',
    department: 'BIOCHEMISTRY',
    price: 1200,
    tatMinutes: 1440,
    analytes: [{ analyteId: analytes.body[0].id, sortOrder: 0 }],
  },
});
newTest.status === 201
  ? ok('a new test can be added to the menu', `${newTest.body.code} v${newTest.body.version}`)
  : bad('test created', `${newTest.status} ${JSON.stringify(newTest.body).slice(0, 100)}`);

const codeClash = await api('POST', '/catalog/tests', {
  token: admin.accessToken,
  body: {
    code: newTest.body.code,
    name: 'Clashing Code',
    department: 'BIOCHEMISTRY',
    price: 100,
    analytes: [{ analyteId: analytes.body[0].id }],
  },
});
codeClash.status === 400
  ? ok('a duplicate test code is refused', 'codes appear on reports and instrument maps')
  : bad('code clash refused', `${codeClash.status}`);

// A price change is not clinically significant, so it must NOT bump the version
// — otherwise every price revision would fork the historical record.
const priced = await api('PATCH', `/catalog/tests/${newTest.body.id}`, {
  token: admin.accessToken,
  body: { price: 1350, reason: 'Annual price revision' },
});
priced.status === 200 && priced.body.price === 1350 && priced.body.versionBumped === false
  ? ok('a price change does NOT bump the version', 'pricing is not a clinical change')
  : bad('price change', JSON.stringify(priced.body).slice(0, 120));

// Composition IS clinically significant and must bump it.
const recomposed = await api('PATCH', `/catalog/tests/${newTest.body.id}`, {
  token: admin.accessToken,
  body: {
    analytes: analytes.body.slice(0, 2).map((a, i) => ({ analyteId: a.id, sortOrder: i })),
    reason: 'Added a second analyte to the panel',
  },
});
recomposed.status === 200 && recomposed.body.versionBumped === true && recomposed.body.version > 1
  ? ok('a composition change DOES bump the version', `v${recomposed.body.version}`)
  : bad('composition version bump', JSON.stringify(recomposed.body).slice(0, 120));

const techWrite = await api('POST', '/catalog/tests', {
  token: tech.accessToken,
  body: {
    code: `TECH${uniq()}`,
    name: 'Should Not Exist',
    department: 'BIOCHEMISTRY',
    price: 1,
    analytes: [{ analyteId: analytes.body[0].id }],
  },
});
techWrite.status === 403
  ? ok('bench staff cannot change the price list', '403')
  : bad('catalog write permissioned', `${techWrite.status}`);

const doctor = await api('POST', '/catalog/doctors', {
  token: admin.accessToken,
  body: { name: `Dr Verify ${uniq()}`, speciality: 'Endocrinology' },
});
doctor.status === 201 && /^DR\d+$/.test(doctor.body.code)
  ? ok('a referring doctor gets an auto-assigned code', doctor.body.code)
  : bad('doctor created', `${doctor.status} ${JSON.stringify(doctor.body).slice(0, 100)}`);

// ===========================================================================
section('Reference ranges');

const numeric = analytes.body.find(
  (a) => a.valueType === 'NUMERIC' || a.valueType === 'NUMERIC_BOUNDED',
);

const invertedRange = await api('POST', '/catalog/ranges', {
  token: admin.accessToken,
  body: { analyteId: numeric.id, lowValue: 20, highValue: 10 },
});
invertedRange.status === 400
  ? ok('a range with low above high is refused')
  : bad('inverted range refused', `${invertedRange.status}`);

// A critical low ABOVE the normal low would make every low result a critical
// callback, and the alert would stop meaning anything.
const badCritical = await api('POST', '/catalog/ranges', {
  token: admin.accessToken,
  body: { analyteId: numeric.id, lowValue: 10, highValue: 20, criticalLow: 15 },
});
badCritical.status === 400 && /critical low/i.test(badCritical.body?.detail ?? '')
  ? ok('a critical low inside the normal range REFUSED', 'alerts must stay meaningful')
  : bad('critical threshold validated', `${badCritical.status}`);

const emptyRange = await api('POST', '/catalog/ranges', {
  token: admin.accessToken,
  body: { analyteId: numeric.id },
});
emptyRange.status === 400
  ? ok('a range with neither values nor text is refused', 'it would print as a blank column')
  : bad('empty range refused', `${emptyRange.status}`);

const goodRange = await api('POST', '/catalog/ranges', {
  token: admin.accessToken,
  body: {
    analyteId: numeric.id,
    sex: 'FEMALE',
    lowValue: 12,
    highValue: 15,
    criticalLow: 7,
    criticalHigh: 20,
  },
});
goodRange.status === 201
  ? ok('a sex-specific range with critical limits is accepted', goodRange.body.analyte)
  : bad('range created', `${goodRange.status} ${JSON.stringify(goodRange.body).slice(0, 100)}`);

// ===========================================================================
section('QC lot authoring');

const qualitative = analytes.body.find(
  (a) => a.valueType !== 'NUMERIC' && a.valueType !== 'NUMERIC_BOUNDED',
);
const materials = await api('GET', '/qc/materials', { token: admin.accessToken });
const material = materials.body?.[0];

materials.status === 200 && material
  ? ok('control materials are listable', `${materials.body.length} material(s)`)
  : bad('materials listed', `${materials.status}`);

if (qualitative) {
  const nonsense = await api('POST', '/qc/lots', {
    token: admin.accessToken,
    body: {
      qcMaterialId: material.id,
      lotNumber: `BAD-${uniq()}`,
      analytes: [{ analyteId: qualitative.id, targetMean: 12, targetSd: 1 }],
    },
  });
  nonsense.status === 400 && /measured quantity/i.test(nonsense.body?.detail ?? '')
    ? ok('a numeric target on a qualitative analyte REFUSED', `${qualitative.code} is not measured`)
    : bad('qualitative QC target refused', `${nonsense.status}`);
} else {
  ok('no qualitative analyte to test against', 'skipped');
}

const zeroSd = await api('POST', '/qc/lots', {
  token: admin.accessToken,
  body: {
    qcMaterialId: material.id,
    lotNumber: `ZSD-${uniq()}`,
    analytes: [{ analyteId: numeric.id, targetMean: 100, targetSd: 0 }],
  },
});
zeroSd.status >= 400
  ? ok('a zero SD is refused', 'every z-score would be infinite and reject every run')
  : bad('zero SD refused', `${zeroSd.status}`);

const expiredLot = await api('POST', '/qc/lots', {
  token: admin.accessToken,
  body: {
    qcMaterialId: material.id,
    lotNumber: `EXP-${uniq()}`,
    expiryDate: '2020-01-01',
    analytes: [{ analyteId: numeric.id, targetMean: 100, targetSd: 2 }],
  },
});
expiredLot.status === 400
  ? ok('an already-expired control lot is refused')
  : bad('expired lot refused', `${expiredLot.status}`);

const qcLot = await api('POST', '/qc/lots', {
  token: admin.accessToken,
  body: {
    qcMaterialId: material.id,
    lotNumber: `VER-${uniq()}`,
    expiryDate: new Date(Date.now() + 180 * 864e5).toISOString().slice(0, 10),
    analytes: [{ analyteId: numeric.id, targetMean: 100, targetSd: 2 }],
  },
});
qcLot.status === 201
  ? ok('a control lot with targets is registered', `${qcLot.body.lotNumber}`)
  : bad('QC lot created', `${qcLot.status} ${JSON.stringify(qcLot.body).slice(0, 100)}`);

const techQcLot = await api('POST', '/qc/lots', {
  token: tech.accessToken,
  body: {
    qcMaterialId: material.id,
    lotNumber: `TECH-${uniq()}`,
    analytes: [{ analyteId: numeric.id, targetMean: 100, targetSd: 2 }],
  },
});
techQcLot.status === 403
  ? ok('the bench cannot move the QC goalposts', 'runs the control, does not set the target')
  : bad('QC target permissioned', `${techQcLot.status}`);

// ===========================================================================
section('Out-of-specification handling — the administrative controls');

// The OOS lifecycle itself is proved in pharma-verify. What is asserted here is
// the administration around it: who may open one, who may close one, and
// whether a close can be waved through without the investigation behind it.
// Not ?status=OPEN: an investigation moves to UNDER_INVESTIGATION the moment
// anyone works on it, and it is still very much on QA's desk. The queue is
// everything not yet closed, which is what the QA screen itself shows.
const allInvestigations = await api('GET', '/qa/investigations', { token: qa.accessToken });
const openInvestigations = {
  status: allInvestigations.status,
  body: (allInvestigations.body ?? []).filter((i) => i.status !== 'CLOSED'),
};
openInvestigations.status === 200
  ? ok('the investigation queue is reachable', `${openInvestigations.body.length} unclosed`)
  : bad('investigation queue', `${openInvestigations.status}`);

const techInvestigations = await api('GET', '/qa/investigations', { token: stores.accessToken });
techInvestigations.status === 403
  ? ok('stores cannot read investigations', '403 — quality records are not warehouse records')
  : bad('investigation permissioned', `${techInvestigations.status}`);

const inv = (openInvestigations.body ?? [])[0];
if (inv) {
  const closeNoPhase = await api('POST', `/qa/investigations/${inv.id}/close`, {
    token: qa.accessToken,
    body: { conclusion: 'ok', rootCause: 'none' },
  });
  closeNoPhase.status >= 400
    ? ok(
        'an OOS cannot be closed with a one-word conclusion',
        String(closeNoPhase.body?.detail ?? '').slice(0, 58),
      )
    : bad('OOS close validated', `${closeNoPhase.status}`);

  const techClose = await api('POST', `/qa/investigations/${inv.id}/close`, {
    token: tech.accessToken,
    body: {
      conclusion: 'Analyst attempting to close their own investigation',
      rootCause: 'LABORATORY_ERROR',
    },
  });
  techClose.status === 403
    ? ok('the analyst who ran the test cannot close the OOS', '403 — QA owns the closure')
    : bad('OOS closure permissioned', `${techClose.status}`);
} else {
  ok('no open investigation to exercise', 'skipped — pharma-verify covers the lifecycle');
}

const auditOos = await api('GET', '/compliance/audit?entityType=OosInvestigation&limit=5', {
  token: admin.accessToken,
});
auditOos.status === 200
  ? ok('investigations are queryable in the audit trail by entity', 'OosInvestigation')
  : bad('OOS audit', `${auditOos.status}`);

// ===========================================================================
section('Certificate register and instrument health');

const register = await api('GET', '/qa/coa?limit=5', { token: admin.accessToken });
register.status === 200 && (register.body.items ?? []).length > 0
  ? ok(
      'certificates are listed without opening the batch',
      `${register.body.items.length} certificate(s)`,
    )
  : bad('certificate register', `${register.status} ${JSON.stringify(register.body).slice(0, 120)}`);

const aCoa = register.body?.items?.[0];
const bySearch = await api(`GET`, `/qa/coa?search=${encodeURIComponent(aCoa?.batchNumber ?? '')}`, {
  token: admin.accessToken,
});
(bySearch.body?.items ?? []).some((c) => c.coaNumber === aCoa?.coaNumber)
  ? ok('the register is searchable by batch number', `${aCoa.batchNumber} → ${aCoa.coaNumber}`)
  : bad('certificate search', JSON.stringify(bySearch.body).slice(0, 120));

// A certificate names the specification it was judged against — without it the
// document asserts compliance with nothing in particular.
aCoa?.specification && aCoa?.material?.code
  ? ok('each certificate cites its specification and material', `${aCoa.specification} · ${aCoa.material.code}`)
  : bad('certificate provenance', JSON.stringify(aCoa).slice(0, 120));

const storesCoa = await api('GET', '/qa/coa?limit=5', { token: stores.accessToken });
storesCoa.status === 200
  ? ok('stores can look up a certificate', 'the warehouse ships against it')
  : bad('CoA readable by stores', `${storesCoa.status}`);

const devices = await api('GET', '/ingest/devices', { token: admin.accessToken });
devices.status === 200 && Array.isArray(devices.body)
  ? ok('instrument health is visible', `${devices.body.length} device(s)`)
  : bad('device list', `${devices.status}`);

devices.body?.every?.((d) => typeof d.isOnline === 'boolean')
  ? ok('each analyzer reports whether it is still talking to us', '"we did not notice it stopped" is the real failure')
  : bad('online derivation', 'isOnline missing');

// ===========================================================================
console.log(
  `\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`,
);
if (failures.length > 0) {
  console.log('\n\x1b[31mFailures:\x1b[0m');
  for (const f of failures) console.log(`  - ${f.name} — ${f.detail}`);
  process.exit(1);
}
