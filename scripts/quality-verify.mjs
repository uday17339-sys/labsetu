#!/usr/bin/env node
/**
 * Quality system verification — deviations and CAPA.
 *
 * The thread an inspector follows: something departed from what should have
 * happened, it was investigated, an action was taken, and somebody checked the
 * action worked. Each of those steps has a control on it, and this suite exists
 * to prove the controls FIRE rather than that the happy path returns 200.
 *
 * The three that matter most:
 *   - a deviation cannot close without a root cause
 *   - a deviation with product impact cannot close without a CAPA
 *   - a CAPA cannot be declared effective on the day it was completed
 *
 * Usage: node scripts/quality-verify.mjs [apiBase]
 */
const API = process.argv[2] ?? 'https://localhost/api';
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

const login = (email) =>
  api('POST', '/auth/login', { body: { tenantCode: TENANT, email, password: PASSWORD } }).then(
    (r) => r.body,
  );

const iso = (daysFromNow) =>
  new Date(Date.now() + daysFromNow * 864e5).toISOString().slice(0, 10);

async function main() {
  console.log(`\n\x1b[1mLabSetu quality system verification\x1b[0m  →  ${API}\n`);

  const qa = await login('qa@vantage.test');
  const qc = await login('qc@vantage.test');
  const stores = await login('stores@vantage.test');
  const auditor = await login('auditor@vantage.test');
  const admin = await login('admin@vantage.test');

  if (!qa?.accessToken) {
    console.error('Could not sign in. Is the stack up and seeded?');
    process.exit(1);
  }

  // =========================================================== the register
  section('The deviation register');

  const register = await api('GET', '/quality/deviations', { token: qa.accessToken });
  register.status === 200 && register.body.length > 0
    ? ok('the register is populated', `${register.body.length} deviations`)
    : bad('deviation register', JSON.stringify(register.body).slice(0, 140));

  // A closed deviation must be classified. Severity and product impact are
  // assigned at closure precisely so they reflect the investigation rather than
  // a guess made while the spill was still on the floor.
  const seeded = (register.body ?? []).find((d) => d.status === 'CLOSED');
  seeded && seeded.severity !== 'UNCLASSIFIED' && seeded.productImpact !== 'NOT_ASSESSED'
    ? ok('a closed deviation carries its classification', `${seeded.severity} · ${seeded.productImpact}`)
    : bad('closed deviation classified', JSON.stringify(seeded).slice(0, 120));

  (register.body ?? []).every((d) => typeof d.openDays === 'number')
    ? ok('the queue is aged', 'the first column anyone sorts by')
    : bad('deviation ageing', 'openDays missing');

  // =========================================================== raising
  section('Raising a deviation');

  const thin = await api('POST', '/quality/deviations', {
    token: qc.accessToken,
    body: {
      title: 'Spill',
      description: 'spill',
      category: 'PROCESS',
      occurredAt: iso(-1),
      detectedAt: iso(-1),
    },
  });
  thin.status >= 400
    ? ok('a one-word deviation is REFUSED', 'the reader a year later was not there')
    : bad('description substantive', `${thin.status}`);

  const backwards = await api('POST', '/quality/deviations', {
    token: qc.accessToken,
    body: {
      title: 'Detected before it happened',
      description:
        'A deliberate date inversion to prove the ordering of occurrence and detection is checked.',
      category: 'PROCESS',
      occurredAt: iso(-1),
      detectedAt: iso(-5),
    },
  });
  backwards.status >= 400
    ? ok('a deviation detected before it occurred is REFUSED', 'dates are checked, not stored')
    : bad('date ordering checked', `${backwards.status}`);

  // Stores can raise one. Deliberately wide: the deviation nobody felt able to
  // report is the expensive kind.
  const byStores = await api('POST', '/quality/deviations', {
    token: stores.accessToken,
    body: {
      title: 'Pallet of API-PCM found outside the quarantine cage',
      description:
        'A pallet of paracetamol API was found in the general warehouse aisle rather than inside ' +
        'the quarantine cage during the morning walk-round. Segregation was restored immediately.',
      category: 'MATERIAL',
      occurredAt: iso(-2),
      detectedAt: iso(-2),
    },
  });
  byStores.status < 300
    ? ok('the warehouse can raise a deviation', byStores.body.deviationNumber)
    : bad('stores can raise', `${byStores.status} ${JSON.stringify(byStores.body).slice(0, 110)}`);

  byStores.body?.deviationNumber?.startsWith('DEV/')
    ? ok('it continues the house numbering series', byStores.body.deviationNumber)
    : bad('house numbering', byStores.body?.deviationNumber);

  typeof byStores.body?.detectionLagHours === 'number'
    ? ok('the gap between occurring and being noticed is recorded', `${byStores.body.detectionLagHours}h`)
    : bad('detection lag', 'not computed');

  // =========================================================== closing
  section('Closing a deviation — the controls');

  const devId = byStores.body.id;

  const closeNoInvestigation = await api('POST', `/quality/deviations/${devId}/close`, {
    token: qa.accessToken,
    body: {
      rootCause: 'Somebody put it in the wrong place, we think, probably.',
      severity: 'MINOR',
      productImpact: 'NONE',
    },
  });
  closeNoInvestigation.status >= 400
    ? ok('closing without an investigation is REFUSED', String(closeNoInvestigation.body?.detail ?? '').slice(0, 62))
    : bad('investigation required before close', `${closeNoInvestigation.status}`);

  const investigated = await api('POST', `/quality/deviations/${devId}/investigate`, {
    token: qa.accessToken,
    body: {
      investigation:
        'Reviewed the goods-receipt record and CCTV for the receiving bay. The pallet was booked ' +
        'in correctly and staged in quarantine, then moved during a forklift reshuffle by an ' +
        'operator covering an absence who had not been briefed on the cage boundary.',
    },
  });
  investigated.status < 300 && investigated.body.status === 'UNDER_INVESTIGATION'
    ? ok('an investigation moves it out of OPEN', investigated.body.status)
    : bad('investigate', `${investigated.status} ${JSON.stringify(investigated.body).slice(0, 110)}`);

  // THE CONTROL: product impact means a CAPA is not optional.
  const closeWithImpact = await api('POST', `/quality/deviations/${devId}/close`, {
    token: qa.accessToken,
    body: {
      rootCause:
        'Relief operator was not briefed on quarantine segregation before covering the receiving bay.',
      severity: 'MAJOR',
      productImpact: 'POTENTIAL',
    },
  });
  closeWithImpact.status >= 400 && /corrective action|CAPA/i.test(closeWithImpact.body?.detail ?? '')
    ? ok(
        'a deviation with product impact cannot close without a CAPA',
        String(closeWithImpact.body.detail).slice(0, 62),
      )
    : bad('CAPA required for product impact', `${closeWithImpact.status} ${JSON.stringify(closeWithImpact.body).slice(0, 110)}`);

  // =========================================================== CAPA
  section('CAPA — the half that gets dropped');

  const orphan = await api('POST', '/quality/capa', {
    token: qa.accessToken,
    body: {
      title: 'A CAPA that came from nowhere',
      description: 'Raised against nothing at all, to prove the link is required.',
      kind: 'CORRECTIVE',
      ownerId: qc.user.id,
      dueAt: iso(14),
    },
  });
  orphan.status >= 400
    ? ok('a CAPA must arise from something', 'no orphan actions')
    : bad('CAPA source required', `${orphan.status}`);

  const capa = await api('POST', '/quality/capa', {
    token: qa.accessToken,
    body: {
      title: 'Brief relief operators on quarantine segregation before bay cover',
      description:
        'Add quarantine cage boundaries to the receiving-bay handover briefing, and require the ' +
        'covering operator to sign the briefing before taking the bay.',
      kind: 'PREVENTIVE',
      ownerId: stores.user.id,
      dueAt: iso(21),
      deviationId: devId,
      effectivenessDueAt: iso(90),
    },
  });
  capa.status < 300
    ? ok('a CAPA is raised against the deviation', capa.body.capaNumber)
    : bad('raise CAPA', `${capa.status} ${JSON.stringify(capa.body).slice(0, 130)}`);

  const nowClosable = await api('POST', `/quality/deviations/${devId}/close`, {
    token: qa.accessToken,
    body: {
      rootCause:
        'Relief operator was not briefed on quarantine segregation before covering the receiving bay.',
      severity: 'MAJOR',
      productImpact: 'POTENTIAL',
      impactAssessment:
        'Material remained within the warehouse and was not issued; segregation restored the ' +
        'same morning. No batch was released against it.',
    },
  });
  nowClosable.status < 300 && nowClosable.body.status === 'CLOSED'
    ? ok('with a CAPA in place it closes', `${nowClosable.body.severity} · ${nowClosable.body.productImpact}`)
    : bad('close with CAPA', `${nowClosable.status} ${JSON.stringify(nowClosable.body).slice(0, 120)}`);

  // THE CONTROL: effectiveness cannot be certified the day the work was done.
  const completed = await api('POST', `/quality/capa/${capa.body.id}/complete`, {
    token: qa.accessToken,
    body: {
      completionNote:
        'Briefing sheet revised and issued; covering operators now sign it before taking the bay.',
    },
  });
  completed.status < 300 && completed.body.status === 'COMPLETED'
    ? ok('the action is recorded as completed', completed.body.status)
    : bad('complete CAPA', `${completed.status} ${JSON.stringify(completed.body).slice(0, 110)}`);

  const sameDay = await api('POST', `/quality/capa/${capa.body.id}/effectiveness`, {
    token: qa.accessToken,
    body: {
      verdict: 'EFFECTIVE',
      note: 'Declaring this effective an hour after doing it, which proves nothing at all.',
    },
  });
  sameDay.status >= 400 && /recur|today/i.test(sameDay.body?.detail ?? '')
    ? ok('same-day effectiveness is REFUSED', String(sameDay.body.detail).slice(0, 62))
    : bad('same-day effectiveness refused', `${sameDay.status} ${JSON.stringify(sameDay.body).slice(0, 110)}`);

  // An ineffective verdict reopens rather than closes.
  const notEffective = await api('POST', `/quality/capa/${capa.body.id}/effectiveness`, {
    token: qa.accessToken,
    body: {
      verdict: 'NOT_EFFECTIVE',
      note:
        'A second pallet was found outside the cage after the briefing change, so the action has ' +
        'not held. Reopening to look at the physical cage boundary rather than the briefing.',
    },
  });
  notEffective.body?.status === 'IN_PROGRESS'
    ? ok('an INEFFECTIVE verdict reopens the CAPA', 'a failed action is an open problem')
    : bad('ineffective reopens', `status=${notEffective.body?.status}`);

  const capaList = await api('GET', '/quality/capa', { token: qa.accessToken });
  (capaList.body ?? []).some((c) => typeof c.isOverdue === 'boolean')
    ? ok('the CAPA queue reports overdue state', `${capaList.body.length} actions`)
    : bad('CAPA ageing', JSON.stringify(capaList.body).slice(0, 110));

  (capaList.body ?? []).some((c) => 'awaitingEffectivenessCheck' in c)
    ? ok('completed-but-unverified is tracked separately', 'the state that hides on every report')
    : bad('awaiting-effectiveness tracked');

  // =========================================================== separation
  section('Who may do what');

  const qcClose = await api('POST', `/quality/deviations/${devId}/close`, {
    token: qc.accessToken,
    body: { rootCause: 'An analyst closing a deviation about the warehouse.', severity: 'MINOR', productImpact: 'NONE' },
  });
  qcClose.status === 403
    ? ok('an analyst cannot close a deviation', '403 — closure is QA')
    : bad('closure permissioned', `${qcClose.status}`);

  const auditorRaise = await api('POST', '/quality/deviations', {
    token: auditor.accessToken,
    body: {
      title: 'The auditor should not be able to write anything',
      description: 'A read-only role must not be able to create records in the quality system.',
      category: 'OTHER',
      occurredAt: iso(-1),
      detectedAt: iso(-1),
    },
  });
  auditorRaise.status === 403
    ? ok('the auditor cannot raise records', '403 — read-only by construction')
    : bad('auditor read-only', `${auditorRaise.status}`);

  const auditorRead = await api('GET', '/quality/deviations', { token: auditor.accessToken });
  auditorRead.status === 200
    ? ok('the auditor can read the whole register', `${auditorRead.body.length} deviations`)
    : bad('auditor reads', `${auditorRead.status}`);

  // =========================================================== audit trail
  section('The thread is in the audit trail');

  for (const [verb, label] of [
    ['DEVIATION_RAISED', 'raising'],
    ['DEVIATION_CLOSED', 'closing'],
    ['CAPA_RAISED', 'the action'],
    ['CAPA_VERIFIED', 'the effectiveness check'],
  ]) {
    const entries = await api('GET', `/compliance/audit?action=${verb}&limit=5`, {
      token: admin.accessToken,
    });
    (entries.body?.items ?? []).length > 0
      ? ok(`${label} is its own verb`, verb)
      : bad(`${verb} audited`, JSON.stringify(entries.body).slice(0, 100));
  }

  const chain = await api('GET', '/compliance/audit-chain/verify', { token: auditor.accessToken });
  chain.body?.status === 'PASSED'
    ? ok('the chain still verifies', `${chain.body.entriesChecked} entries`)
    : bad('chain verifies', JSON.stringify(chain.body).slice(0, 120));

  console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
  if (failures.length > 0) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    for (const f of failures) console.log(`  - ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n\x1b[31mAborted:\x1b[0m', e.message);
  process.exit(1);
});
