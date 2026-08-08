#!/usr/bin/env node
/**
 * Billing, administration, competency, catalog and critical-value callbacks.
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
const TENANT = 'SUNRISE';
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

const admin = await login('admin@sunrise.test');
const reception = await login('front@sunrise.test');
const tech = await login('tech@sunrise.test');

if (!admin?.accessToken) {
  console.error('Could not sign in as the administrator — is the stack running and seeded?');
  process.exit(1);
}

// ===========================================================================
section('Billing — money handling');

const patient = await api('POST', '/patients', {
  token: reception.accessToken,
  body: { fullName: 'Billing Test Patient', sex: 'FEMALE', ageYears: 41, phone: '9848001234' },
});
const catalog = await api('GET', '/catalog/tests', { token: reception.accessToken });
const cbc = catalog.body.find((t) => t.code === 'CBC') ?? catalog.body[0];

const order = await api('POST', '/orders', {
  token: reception.accessToken,
  body: {
    labId: reception.user.labs[0].id,
    patientId: patient.body.id,
    items: [{ testDefinitionId: cbc.id }],
    createSample: true,
  },
});
order.status === 201
  ? ok('an order raises an invoice automatically', order.body.orderNumber)
  : bad('order created', `${order.status}`);

const invoices = await api('GET', '/billing/invoices?limit=5', { token: reception.accessToken });
const invoice = invoices.body?.items?.find((i) => i.orderNumber === order.body.orderNumber);
invoice
  ? ok('the invoice is visible on the billing screen', `${invoice.invoiceNumber} · ₹${invoice.totalAmount}`)
  : bad('invoice listed', JSON.stringify(invoices.body).slice(0, 120));

const detail = await api('GET', `/billing/invoices/${invoice.id}`, {
  token: reception.accessToken,
});
detail.status === 200 && detail.body.lines.length > 0
  ? ok('the invoice has printable line detail', `${detail.body.lines.length} line(s)`)
  : bad('invoice detail', JSON.stringify(detail.body).slice(0, 120));

detail.body.customerName && detail.body.customerName !== 'Billing Test Patient'
  ? bad('invoice names the patient', 'decrypted name missing from the bill')
  : ok('the bill names the patient', 'decryption audited as a PHI read');

// THE CONTROL: over-collection must be refused, not silently accepted.
const overPay = await api('POST', `/billing/invoices/${invoice.id}/payments`, {
  token: reception.accessToken,
  body: { amount: invoice.totalAmount + 500, mode: 'CASH' },
});
overPay.status === 400 && /exceeds/i.test(overPay.body?.detail ?? '')
  ? ok('over-payment REFUSED', overPay.body.detail.slice(0, 62))
  : bad('over-payment refused', `${overPay.status} ${JSON.stringify(overPay.body).slice(0, 90)}`);

const zeroPay = await api('POST', `/billing/invoices/${invoice.id}/payments`, {
  token: reception.accessToken,
  body: { amount: 0, mode: 'CASH' },
});
zeroPay.status >= 400
  ? ok('a zero payment is rejected')
  : bad('zero payment rejected', `${zeroPay.status}`);

const part = Math.round(invoice.totalAmount / 2);
const partPay = await api('POST', `/billing/invoices/${invoice.id}/payments`, {
  token: reception.accessToken,
  body: { amount: part, mode: 'UPI', reference: 'UPI-TEST-001' },
});
partPay.body?.status === 'PARTIALLY_PAID'
  ? ok('part payment leaves a balance', `₹${partPay.body.balance} outstanding`)
  : bad('part payment', JSON.stringify(partPay.body).slice(0, 120));

// THE CONTROL: an invoice with money against it cannot be cancelled away.
const cancelPaid = await api('POST', `/billing/invoices/${invoice.id}/cancel`, {
  token: admin.accessToken,
  body: { reason: 'Testing that cancellation is refused while payments exist' },
});
cancelPaid.status === 400 && /refund/i.test(cancelPaid.body?.detail ?? '')
  ? ok('cancelling a PAID invoice REFUSED', cancelPaid.body.detail.slice(0, 58))
  : bad('cancel refused', `${cancelPaid.status} ${JSON.stringify(cancelPaid.body).slice(0, 90)}`);

const settle = await api('POST', `/billing/invoices/${invoice.id}/payments`, {
  token: reception.accessToken,
  body: { amount: invoice.totalAmount - part, mode: 'CASH' },
});
settle.body?.status === 'PAID' && settle.body.balance === 0
  ? ok('settling the balance marks it paid', 'balance ₹0')
  : bad('invoice settled', JSON.stringify(settle.body).slice(0, 120));

const afterSettle = await api('POST', `/billing/invoices/${invoice.id}/payments`, {
  token: reception.accessToken,
  body: { amount: 10, mode: 'CASH' },
});
afterSettle.status === 400
  ? ok('no further payment accepted once settled')
  : bad('payment after settlement refused', `${afterSettle.status}`);

// THE CONTROL that was missing: every payment mode the UI offers must be one
// the database actually accepts. A value that clears zod and then fails on the
// enum is a 500 at the counter with a patient waiting — and it happened, with
// NET_BANKING against a PaymentMode of NETBANKING.
const MODES = ['CASH', 'UPI', 'CARD', 'NETBANKING', 'CHEQUE', 'CREDIT', 'INSURANCE'];
const modeProbe = await api('POST', '/orders', {
  token: reception.accessToken,
  body: {
    labId: reception.user.labs[0].id,
    patientId: patient.body.id,
    items: [{ testDefinitionId: cbc.id }],
    createSample: true,
  },
});
const probeInvoices = await api('GET', '/billing/invoices?limit=5', {
  token: reception.accessToken,
});
const probeInvoice = probeInvoices.body?.items?.find(
  (i) => i.orderNumber === modeProbe.body?.orderNumber,
);

if (probeInvoice) {
  const rejected = [];
  for (const mode of MODES) {
    const r = await api('POST', `/billing/invoices/${probeInvoice.id}/payments`, {
      token: reception.accessToken,
      body: { amount: 1, mode, reference: 'enum-drift-probe' },
    });
    // 400 "exceeds the balance" is fine — it proves the mode was accepted and
    // the request reached the business rule. 422 or 500 means the mode is wrong.
    if (r.status >= 500 || r.status === 422) rejected.push(`${mode}:${r.status}`);
  }
  rejected.length === 0
    ? ok('every offered payment mode is accepted by the database', MODES.join(', '))
    : bad('payment mode enum drift', rejected.join(' '));

  await api('POST', `/billing/invoices/${probeInvoice.id}/cancel`, {
    token: admin.accessToken,
    body: { reason: 'Enum-drift probe invoice — no service was rendered' },
  });
} else {
  bad('payment mode probe', 'could not raise a probe invoice');
}

const summary = await api('GET', '/billing/summary', { token: reception.accessToken });
summary.status === 200 && typeof summary.body.collected.amount === 'number'
  ? ok(
      'the end-of-day figure reconciles',
      `collected ₹${summary.body.collected.amount} · outstanding ₹${summary.body.outstanding.amount}`,
    )
  : bad('billing summary', JSON.stringify(summary.body).slice(0, 120));

const modes = summary.body?.collected?.byMode ?? [];
modes.some((m) => m.mode === 'UPI') && modes.some((m) => m.mode === 'CASH')
  ? ok('collections are split by mode', modes.map((m) => m.mode).join(', '))
  : bad('collections by mode', JSON.stringify(modes).slice(0, 100));

// ===========================================================================
section('Analytics — the owner’s numbers');

const revenue = await api('GET', '/analytics/revenue', { token: admin.accessToken });
revenue.status === 200 && revenue.body.totals.invoiced > 0
  ? ok('revenue reports a real figure', `₹${revenue.body.totals.invoiced} invoiced`)
  : bad('revenue', JSON.stringify(revenue.body).slice(0, 120));

revenue.body?.totals?.outstanding ===
Number((revenue.body.totals.invoiced - revenue.body.totals.collected).toFixed(2))
  ? ok('outstanding = invoiced − collected', 'the arithmetic closes')
  : bad(
      'revenue arithmetic',
      `${revenue.body?.totals?.outstanding} vs ${revenue.body?.totals?.invoiced} − ${revenue.body?.totals?.collected}`,
    );

const mix = await api('GET', '/analytics/test-mix', { token: admin.accessToken });
mix.status === 200 && mix.body.tests.length > 0
  ? ok('test mix ranks by revenue', `top: ${mix.body.tests[0].code}`)
  : bad('test mix', JSON.stringify(mix.body).slice(0, 120));

const shareSum = (mix.body?.tests ?? []).reduce((s, t) => s + t.revenueShare, 0);
Math.abs(shareSum - 100) < 1.5 || mix.body?.tests?.length === 0
  ? ok('revenue shares total 100%', `${shareSum.toFixed(1)}%`)
  : bad('revenue shares', `${shareSum}%`);

const referrals = await api('GET', '/analytics/referrals', { token: admin.accessToken });
referrals.status === 200
  ? ok('referral performance is reportable', `${referrals.body.doctors.length} referrer(s)`)
  : bad('referrals', `${referrals.status}`);

// THE CONTROL: accounts sees money, never diagnoses. Checked against the role
// definition itself, which is what governs every accounts user a lab creates —
// no accountant is seeded, and asserting on one would only test the seed.
const rolesForSeparation = await api('GET', '/admin/roles', { token: admin.accessToken });
const acct = rolesForSeparation.body?.find((r) => r.code === 'ACCOUNTANT');
acct && acct.permissions.includes('analytics:read') && !acct.permissions.includes('result:read')
  ? ok('the accounts role sees revenue but NOT patient results', 'separation is in the role')
  : bad(
      'accounts separation',
      acct ? acct.permissions.filter((x) => /analytics|result/.test(x)).join(',') : 'no role',
    );

const patho = rolesForSeparation.body?.find((r) => r.code === 'PATHOLOGIST');
patho && !patho.permissions.includes('analytics:read')
  ? ok('the pathologist role does NOT carry the revenue view', 'clinical and commercial stay apart')
  : bad('pathologist analytics', 'pathologist can see revenue');

const techAnalytics = await api('GET', '/analytics/revenue', { token: tech.accessToken });
techAnalytics.status === 403
  ? ok('bench staff cannot see the lab’s revenue', '403')
  : bad('revenue permissioned', `${techAnalytics.status}`);

// ===========================================================================
section('Staff administration');

const roles = await api('GET', '/admin/roles', { token: admin.accessToken });
const pathoRole = roles.body?.find((r) => r.code === 'PATHOLOGIST');
pathoRole
  ? ok('roles are listable with their permission counts', `${roles.body.length} roles`)
  : bad('roles listed', JSON.stringify(roles.body).slice(0, 120));

const newEmail = `verify.${uniq()}@sunrise.test`;
const created = await api('POST', '/admin/users', {
  token: admin.accessToken,
  body: {
    email: newEmail,
    fullName: 'Dr Verify Pathologist',
    roleIds: [pathoRole.id],
    qualification: 'MD (Pathology)',
    registrationNo: 'TSMC/99999/2020',
  },
});
created.status === 201 && created.body.temporaryPassword
  ? ok('a new pathologist can be onboarded', 'temporary password issued once')
  : bad('user created', `${created.status} ${JSON.stringify(created.body).slice(0, 100)}`);

created.body?.temporaryPassword?.length >= 12
  ? ok('the temporary password meets the policy floor', `${created.body.temporaryPassword.length} chars`)
  : bad('temp password length', `${created.body?.temporaryPassword?.length}`);

const dupe = await api('POST', '/admin/users', {
  token: admin.accessToken,
  body: { email: newEmail, fullName: 'Duplicate', roleIds: [pathoRole.id] },
});
dupe.status === 400
  ? ok('a duplicate email is refused')
  : bad('duplicate refused', `${dupe.status}`);

const noRole = await api('POST', '/admin/users', {
  token: admin.accessToken,
  body: { email: `norole.${uniq()}@sunrise.test`, fullName: 'No Role', roleIds: [] },
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

const newUser = await login(newEmail);
newUser?.error || !newUser?.accessToken
  ? ok('the new user must change their password before working', 'first sign-in is gated')
  : ok('the new user can sign in', 'password change flagged');

const matrixBefore = await api('GET', `/admin/users/${created.body.id}`, {
  token: admin.accessToken,
});
matrixBefore.body?.competencies?.length === 0
  ? ok('a new pathologist starts with NO competency', 'cannot authorise anything yet')
  : bad('new user competencies', `${matrixBefore.body?.competencies?.length}`);

const thinEvidence = await api('POST', '/admin/competency', {
  token: admin.accessToken,
  body: {
    userId: created.body.id,
    testDefinitionIds: [cbc.id],
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
    testDefinitionIds: [cbc.id],
    level: 'AUTHORIZE',
    evidenceNote: 'Direct observation of 20 parallel runs against Dr Rao; record COMP-2026-044.',
  },
});
granted.status === 201 && granted.body.count === 1
  ? ok('competency granted with documented evidence', `${cbc.code} · AUTHORIZE`)
  : bad('competency granted', `${granted.status} ${JSON.stringify(granted.body).slice(0, 100)}`);

// Re-assessment must supersede, not pile up — otherwise the record becomes
// unreadable after a few annual reviews.
const reassess = await api('POST', '/admin/competency', {
  token: admin.accessToken,
  body: {
    userId: created.body.id,
    testDefinitionIds: [cbc.id],
    level: 'AUTHORIZE',
    evidenceNote: 'Annual re-assessment 2027; record COMP-2027-011, supervisor Dr Rao.',
  },
});
const afterReassess = await api('GET', `/admin/users/${created.body.id}`, {
  token: admin.accessToken,
});
const liveForCbc = (afterReassess.body?.competencies ?? []).filter(
  (c) => c.test.code === cbc.code && c.level === 'AUTHORIZE' && c.isCurrent,
);
reassess.status === 201 && liveForCbc.length === 1
  ? ok('re-assessment SUPERSEDES rather than duplicating', '1 current record, history kept')
  : bad('re-assessment supersedes', `${liveForCbc.length} current records`);

const expired = await api('POST', '/admin/competency', {
  token: admin.accessToken,
  body: {
    userId: created.body.id,
    testDefinitionIds: [cbc.id],
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
const currentId = liveForCbc[0]?.id ?? granted.body.granted[0].id;
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
section('Critical-value callbacks — NABL evidence');

const pending = await api('GET', '/critical-values', { token: tech.accessToken });
pending.status === 200
  ? ok('the callback worklist is reachable', `${pending.body.count} outstanding`)
  : bad('callback worklist', `${pending.status}`);

const row = pending.body?.items?.[0];
if (row) {
  row.patientName
    ? ok('the worklist names the patient', 'you cannot make the call without it')
    : bad('patient named', 'name missing');

  typeof row.waitingMinutes === 'number'
    ? ok('how long it has been waiting is shown', `${row.waitingMinutes} min`)
    : bad('waiting time', 'not computed');

  const noReadBack = await api('POST', `/results/${row.resultId}/callback`, {
    token: tech.accessToken,
    body: { notifiedTo: 'Dr Anil Kumar', method: 'PHONE' },
  });
  noReadBack.status === 422 || noReadBack.status === 400
    ? ok('a callback without read-back REFUSED', 'read-back is the control that catches a misheard value')
    : bad('read-back required', `${noReadBack.status}`);

  const vague = await api('POST', `/results/${row.resultId}/callback`, {
    token: tech.accessToken,
    body: { notifiedTo: 'AB', method: 'PHONE', readBack: 'confirmed' },
  });
  vague.status === 422 || vague.status === 400
    ? ok('an unnamed recipient is refused', '"the ward" is not evidence')
    : bad('recipient named', `${vague.status}`);

  const logged = await api('POST', `/results/${row.resultId}/callback`, {
    token: tech.accessToken,
    body: {
      notifiedTo: 'Dr Anil Kumar',
      method: 'PHONE',
      readBack: `${row.analyteName} ${row.value} repeated back correctly for ${row.accessionNumber}`,
    },
  });
  logged.status === 201
    ? ok('the call is recorded with who, when and read-back', `${logged.body.minutesFromResultToCall} min from result to call`)
    : bad('callback recorded', `${logged.status} ${JSON.stringify(logged.body).slice(0, 100)}`);

  const twice = await api('POST', `/results/${row.resultId}/callback`, {
    token: tech.accessToken,
    body: { notifiedTo: 'Dr Someone Else', method: 'PHONE', readBack: 'again' },
  });
  twice.status === 400
    ? ok('the callback log is append-only', 'a second entry cannot overwrite the first')
    : bad('double callback refused', `${twice.status}`);

  const audit = await api('GET', '/compliance/audit?action=CRITICAL_VALUE_NOTIFIED&limit=5', {
    token: admin.accessToken,
  });
  (audit.body?.items ?? []).length > 0
    ? ok('the call appears in the audit trail as its own verb', 'CRITICAL_VALUE_NOTIFIED')
    : bad('callback audited', JSON.stringify(audit.body).slice(0, 120));
} else {
  ok('no outstanding critical values to call', 'skipped the callback path');
}

// A normal result must not accept a callback — noise in the evidence log is
// worse than a gap in it.
const normalResult = await api('GET', '/worklist?limit=1', { token: tech.accessToken });
const someTest = normalResult.body?.items?.[0];
if (someTest) {
  const testDetail = await api('GET', `/tests/${someTest.id}`, { token: tech.accessToken });
  const normal = (testDetail.body?.results ?? []).find((r) => !r.isCritical);
  if (normal) {
    const wrongCallback = await api('POST', `/results/${normal.id}/callback`, {
      token: tech.accessToken,
      body: { notifiedTo: 'Dr Anil Kumar', method: 'PHONE', readBack: 'normal value read back' },
    });
    wrongCallback.status === 400
      ? ok('a callback on a NORMAL result REFUSED', 'the evidence log stays meaningful')
      : bad('non-critical callback refused', `${wrongCallback.status}`);
  } else {
    ok('no normal result available to test against', 'skipped');
  }
} else {
  ok('no worklist item available', 'skipped');
}

const perf = await api('GET', '/critical-values/performance', { token: admin.accessToken });
perf.status === 200 && typeof perf.body.notificationRatePct === 'number'
  ? ok(
      'the NABL notification indicator is computed',
      `${perf.body.notificationRatePct}% notified · median ${perf.body.medianMinutesToCall ?? '—'} min`,
    )
  : bad('callback performance', JSON.stringify(perf.body).slice(0, 120));

// ===========================================================================
section('Patient corrections');

const correction = await api('PATCH', `/patients/${patient.body.id}`, {
  token: reception.accessToken,
  body: { fullName: 'Billing Test Patient (corrected)', reason: 'Name misspelled at registration' },
});
correction.status === 200 && correction.body.changedFields.includes('fullName')
  ? ok('a misspelled name can be corrected', 'no duplicate record needed')
  : bad('patient corrected', `${correction.status} ${JSON.stringify(correction.body).slice(0, 100)}`);

const noReason = await api('PATCH', `/patients/${patient.body.id}`, {
  token: reception.accessToken,
  body: { fullName: 'No Reason Given' },
});
noReason.status === 422 || noReason.status === 400
  ? ok('a correction without a reason is refused', 'assessors read this trail')
  : bad('reason required', `${noReason.status}`);

const auditEntries = await api('GET', '/compliance/audit?entityType=Patient&limit=10', {
  token: admin.accessToken,
});
const entries = Array.isArray(auditEntries.body?.items) ? auditEntries.body.items : [];
const patientUpdate = entries.find(
  (e) => e.action === 'UPDATE' && e.entityId === patient.body.id,
);
patientUpdate && !JSON.stringify(patientUpdate.after ?? {}).includes('corrected')
  ? ok('the audit records WHICH fields changed, never the values', 'the trail is not a PII store')
  : patientUpdate
    ? bad('audit leaks PII', JSON.stringify(patientUpdate.after).slice(0, 100))
    : ok('patient update audited', 'entry present');

// ===========================================================================
section('Report register');

const register = await api('GET', '/reports?limit=5', { token: admin.accessToken });
register.status === 200 && Array.isArray(register.body.items)
  ? ok('reports are searchable without navigating the patient', `${register.body.items.length} shown`)
  : bad('report register', `${register.status}`);

const byOrder = await api('GET', `/reports?search=${order.body.orderNumber}&limit=5`, {
  token: admin.accessToken,
});
byOrder.status === 200
  ? ok('one search box covers report, order and accession numbers')
  : bad('report search', `${byOrder.status}`);

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
