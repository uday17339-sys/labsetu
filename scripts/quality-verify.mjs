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

  // =========================================================== change control
  section('Change control');

  const changes = await api('GET', '/quality/changes', { token: qa.accessToken });
  changes.status === 200 && changes.body.length > 0
    ? ok('the change register is populated', `${changes.body.length} changes`)
    : bad('change register', JSON.stringify(changes.body).slice(0, 130));

  const qa2 = await login('qa2@vantage.test');

  const change = await api('POST', '/quality/changes', {
    token: qa2.accessToken,
    body: {
      title: 'Move the dissolution medium preparation to a validated bulk batch',
      description:
        'Prepare phosphate buffer pH 6.8 as a validated 20 L bulk with a seven-day expiry rather ' +
        'than preparing 900 mL per vessel on the day of testing.',
      changeType: 'METHOD',
      justification:
        'Per-vessel preparation is the largest single source of dissolution variability we see, ' +
        'and it consumes analyst time on every run. A bulk preparation with a defined hold time ' +
        'removes the variable without altering the method itself.',
    },
  });
  change.status < 300 && change.body.status === 'DRAFT'
    ? ok('a change is raised as a draft', change.body.changeNumber)
    : bad('raise change', `${change.status} ${JSON.stringify(change.body).slice(0, 120)}`);

  // THE CONTROL: no approval without a recorded impact assessment.
  const approveUnassessed = await api('POST', `/quality/changes/${change.body.id}/decision`, {
    token: qa.accessToken,
    body: { approve: true, note: 'Approving before anyone has assessed the impact.' },
  });
  approveUnassessed.status >= 400
    ? ok(
        'a change cannot be approved before it is assessed',
        String(approveUnassessed.body?.detail ?? '').slice(0, 58),
      )
    : bad('assessment before approval', `${approveUnassessed.status}`);

  const assessed = await api('POST', `/quality/changes/${change.body.id}/assess`, {
    token: qa2.accessToken,
    body: {
      impactAssessment:
        'The method is unchanged; only the preparation scale and hold time differ. Bulk medium ' +
        'requires a validated seven-day hold supported by pH and dissolved-oxygen data. No ' +
        'revalidation of the dissolution method is required. Existing results are unaffected.',
      prerequisites:
        'Hold-time study completed and approved. Analysts briefed. SOP/QC/021 reissued.',
      classification: 'MAJOR',
    },
  });
  assessed.status < 300 && assessed.body.status === 'PENDING_APPROVAL'
    ? ok('an assessed change moves to pending approval', assessed.body.classification)
    : bad('assess change', `${assessed.status} ${JSON.stringify(assessed.body).slice(0, 120)}`);

  // THE CONTROL: four-eyes. The requester cannot approve their own change.
  const selfApprove = await api('POST', `/quality/changes/${change.body.id}/decision`, {
    token: qa2.accessToken,
    body: { approve: true, note: 'Approving the change I raised myself.' },
  });
  selfApprove.status === 403
    ? ok('the requester cannot approve their own change', 'four-eyes on a specification change')
    : bad('four-eyes on change approval', `${selfApprove.status}`);

  const approved = await api('POST', `/quality/changes/${change.body.id}/decision`, {
    token: qa.accessToken,
    body: {
      approve: true,
      note: 'Approved subject to the hold-time study being closed before implementation.',
    },
  });
  approved.status < 300 && approved.body.status === 'APPROVED'
    ? ok('a second approver can approve it', `approved by ${approved.body.approvedBy}`)
    : bad('approve change', `${approved.status} ${JSON.stringify(approved.body).slice(0, 120)}`);

  const implemented = await api('POST', `/quality/changes/${change.body.id}/implement`, {
    token: qa2.accessToken,
    body: { implementationNote: 'SOP/QC/021 reissued at revision 4; analysts briefed 12 Aug.' },
  });
  implemented.status < 300 && implemented.body.status === 'IMPLEMENTED'
    ? ok('an approved change can be implemented')
    : bad('implement change', `${implemented.status}`);

  const listAfter = await api('GET', '/quality/changes', { token: qa.accessToken });
  (listAfter.body ?? []).some((c) => c.awaitingReview)
    ? ok('implemented-but-unreviewed is surfaced', 'reads as finished on a summary otherwise')
    : bad('awaiting review tracked');

  const reviewed = await api('POST', `/quality/changes/${change.body.id}/review`, {
    token: qa.accessToken,
    body: {
      reviewNote:
        'Six dissolution runs completed on bulk medium since implementation. Variability between ' +
        'vessels reduced and no new excursions were seen. The change did what it claimed and ' +
        'nothing it did not claim.',
    },
  });
  reviewed.status < 300 && reviewed.body.status === 'CLOSED'
    ? ok('the post-implementation review closes it out', 'the step that gets skipped')
    : bad('review change', `${reviewed.status} ${JSON.stringify(reviewed.body).slice(0, 120)}`);

  // Implementing without approval is the whole reason the record exists.
  const sneaky = await api('POST', '/quality/changes', {
    token: qa2.accessToken,
    body: {
      title: 'A change somebody tries to implement without approval',
      description:
        'Raised purely to prove that an unapproved change cannot be marked as implemented.',
      changeType: 'DOCUMENT',
      justification:
        'Exists to demonstrate the control refusing, which is the only reason this record exists.',
    },
  });
  const implementUnapproved = await api('POST', `/quality/changes/${sneaky.body.id}/implement`, {
    token: qa2.accessToken,
    body: { implementationNote: 'Implementing without waiting for approval.' },
  });
  implementUnapproved.status >= 400
    ? ok(
        'an unapproved change cannot be implemented',
        String(implementUnapproved.body?.detail ?? '').slice(0, 56),
      )
    : bad('implementation gated on approval', `${implementUnapproved.status}`);

  // =========================================================== stability
  section('Stability studies (ICH Q1A)');

  const protocols = await api('GET', '/stability/protocols', { token: qa.accessToken });
  protocols.status === 200 && protocols.body.length > 0
    ? ok('a stability protocol is configured', protocols.body[0].code)
    : bad('stability protocols', JSON.stringify(protocols.body).slice(0, 120));

  const studies = await api('GET', '/stability/studies', { token: qa.accessToken });
  const study = (studies.body ?? [])[0];
  study
    ? ok('a study is running against a batch', `${study.studyNumber} · ${study.batchNumber}`)
    : bad('stability studies', JSON.stringify(studies.body).slice(0, 120));

  study && study.pullsTotal === 8
    ? ok('every timepoint was scheduled at study start', `${study.pullsTotal} pulls`)
    : bad('pulls scheduled up front', `${study?.pullsTotal} pulls`);

  // A missed timepoint is kept, not tidied away. A study with no gaps is a
  // study nobody has ever run.
  study && study.pullsMissed > 0
    ? ok('a missed timepoint is retained on the record', `${study.pullsMissed} missed`)
    : bad('missed pull retained', `missed=${study?.pullsMissed}`);

  const detail = await api('GET', `/stability/studies/${study.id}`, { token: qa.accessToken });
  const months = (detail.body?.pulls ?? []).map((p) => p.timepointMonths);
  JSON.stringify(months) === JSON.stringify([0, 3, 6, 9, 12, 18, 24, 36])
    ? ok('the schedule follows the protocol', months.join('/') + ' months')
    : bad('timepoint schedule', JSON.stringify(months));

  // Month arithmetic must not drift across a 36-month study: adding days
  // accumulates error and lands the last pull on the wrong side of a month.
  const dueDays = (detail.body?.pulls ?? []).map((p) => Number(p.dueAt.slice(8, 10)));
  new Set(dueDays).size === 1
    ? ok('timepoints land on the same day of the month', `day ${dueDays[0]}, no drift over 36 months`)
    : bad('month arithmetic drifts', dueDays.join(','));

  const scheduled = (detail.body?.pulls ?? []).find((p) => p.status === 'SCHEDULED');
  const missedAgain = await api('POST', `/stability/pulls/${scheduled.id}/missed`, {
    token: qa.accessToken,
    body: { note: 'short' },
  });
  missedAgain.status >= 400
    ? ok('marking a timepoint missed needs a reason', 'it is a gap in shelf-life evidence')
    : bad('missed reason required', `${missedAgain.status}`);

  const recorded = await api('POST', `/stability/pulls/${scheduled.id}/record`, {
    token: qa.accessToken,
    body: { note: 'Drawn from Chamber 2 and submitted to the laboratory.' },
  });
  recorded.status < 300
    ? ok('a pull can be recorded against the timepoint', `${scheduled.timepointMonths} months`)
    : bad('record pull', `${recorded.status} ${JSON.stringify(recorded.body).slice(0, 110)}`);

  const twice = await api('POST', `/stability/pulls/${scheduled.id}/record`, {
    token: qa.accessToken,
    body: { note: 'Recording the same pull a second time.' },
  });
  twice.status >= 400
    ? ok('a timepoint cannot be pulled twice', 'a pull is recorded once')
    : bad('double pull refused', `${twice.status}`);

  const auditorPull = await api('POST', `/stability/pulls/${scheduled.id}/missed`, {
    token: auditor.accessToken,
    body: { note: 'An auditor should not be able to alter the stability record.' },
  });
  auditorPull.status === 403
    ? ok('the auditor cannot alter a stability record', '403 — read-only')
    : bad('stability permissioned', `${auditorPull.status}`);

  // Start a study through the API rather than relying on the seeded one. The
  // seed writes rows directly, so it produces no audit entries — asserting on
  // the seeded study would have been asserting on nothing.
  const stbBatches = await api('GET', '/stores/batches?limit=50', { token: qa.accessToken });
  const freeBatch = (stbBatches.body?.items ?? stbBatches.body ?? []).find(
    (b) => b.batchNumber !== study.batchNumber,
  );

  const newStudy = await api('POST', '/stability/studies', {
    token: qa.accessToken,
    body: {
      protocolId: protocols.body[0].id,
      batchId: freeBatch.id,
      startedAt: new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10),
      chamber: 'Stability Chamber 1 (30 °C / 65 % RH)',
    },
  });
  newStudy.status < 300
    ? ok('a batch can be put on stability through the API', newStudy.body.studyNumber)
    : bad('start study', `${newStudy.status} ${JSON.stringify(newStudy.body).slice(0, 130)}`);

  (newStudy.body?.pulls ?? []).length === 8
    ? ok('starting a study schedules its whole timeline', `${newStudy.body.pulls.length} pulls`)
    : bad('pulls scheduled on start', `${newStudy.body?.pulls?.length}`);

  const dup = await api('POST', '/stability/studies', {
    token: qa.accessToken,
    body: {
      protocolId: protocols.body[0].id,
      batchId: freeBatch.id,
      startedAt: new Date().toISOString().slice(0, 10),
    },
  });
  dup.status >= 400
    ? ok('the same batch cannot run twice on one protocol', 'one study per batch per protocol')
    : bad('duplicate study refused', `${dup.status}`);

  const toMiss = (newStudy.body?.pulls ?? []).find((x) => x.status === 'SCHEDULED' && x.isOverdue);
  if (toMiss) {
    const missed = await api('POST', `/stability/pulls/${toMiss.id}/missed`, {
      token: qa.accessToken,
      body: {
        note:
          'Chamber door seal replaced over the due window and samples were not drawn inside the ' +
          'permitted tolerance. Recorded as missed rather than back-dated.',
      },
    });
    missed.status < 300
      ? ok('an overdue timepoint can be recorded as missed', `${toMiss.timepointMonths} months`)
      : bad('mark missed', `${missed.status} ${JSON.stringify(missed.body).slice(0, 110)}`);
  } else {
    bad('an overdue pull to mark missed', 'the new study produced none');
  }

  for (const [verb, label] of [
    ['STABILITY_STUDY_STARTED', 'starting a study'],
    ['STABILITY_PULL_RECORDED', 'taking a pull'],
    ['STABILITY_PULL_MISSED', 'missing a pull'],
  ]) {
    const entries = await api('GET', `/compliance/audit?action=${verb}&limit=5`, {
      token: admin.accessToken,
    });
    (entries.body?.items ?? []).length > 0
      ? ok(`${label} is its own verb`, verb)
      : bad(`${verb} audited`, JSON.stringify(entries.body).slice(0, 100));
  }

  // ================================================ environmental monitoring
  section('Environmental monitoring');

  const locations = await api('GET', '/environmental/locations', { token: qa.accessToken });
  locations.status === 200 && locations.body.length > 0
    ? ok('the monitoring programme is configured', `${locations.body.length} points`)
    : bad('EM locations', JSON.stringify(locations.body).slice(0, 120));

  const point = (locations.body ?? []).find((l) => l.actionLimit != null && l.alertLimit != null);
  point && point.alertLimit < point.actionLimit
    ? ok('limits are two-tier', `alert ${point.alertLimit} < action ${point.actionLimit} ${point.unit}`)
    : bad('two-tier limits', JSON.stringify(point).slice(0, 120));

  // A single threshold throws away the early warning, so an alert that fires
  // at the action limit is refused at configuration time.
  const badLimits = await api('POST', '/environmental/locations', {
    token: qa.accessToken,
    body: {
      code: `EM/BAD/${Date.now().toString().slice(-6)}`,
      name: 'A point whose alert fires at the action limit',
      grade: 'C',
      monitoringType: 'SURFACE',
      unit: 'cfu/plate',
      alertLimit: 25,
      actionLimit: 25,
    },
  });
  badLimits.status >= 400
    ? ok('an alert at the action limit is REFUSED', 'that is not an early warning')
    : bad('alert below action enforced', `${badLimits.status}`);

  // --- classification ------------------------------------------------------
  const inLimit = await api('POST', '/environmental/readings', {
    token: qc.accessToken,
    body: {
      locationId: point.id,
      value: Math.max(0, point.alertLimit - 10),
      sampledAt: new Date().toISOString().slice(0, 10),
      shift: 'A',
    },
  });
  inLimit.body?.verdict === 'IN_LIMIT'
    ? ok('a normal reading classifies as in limit', `${inLimit.body.value} ${inLimit.body.unit}`)
    : bad('in-limit classification', JSON.stringify(inLimit.body).slice(0, 120));

  const alerting = await api('POST', '/environmental/readings', {
    token: qc.accessToken,
    body: {
      locationId: point.id,
      value: point.alertLimit + 1,
      sampledAt: new Date().toISOString().slice(0, 10),
      shift: 'A',
    },
  });
  alerting.body?.verdict === 'ALERT'
    ? ok('above alert but below action is an ALERT', 'a trend signal, not a breach')
    : bad('alert classification', JSON.stringify(alerting.body).slice(0, 120));

  alerting.body?.deviationNumber == null
    ? ok('an alert does NOT raise a deviation', 'the early warning stays a warning')
    : bad('alert raises no deviation', `raised ${alerting.body.deviationNumber}`);

  // THE CONTROL: an action breach raises the deviation itself.
  const breach = await api('POST', '/environmental/readings', {
    token: qc.accessToken,
    body: {
      locationId: point.id,
      value: point.actionLimit + 25,
      sampledAt: new Date().toISOString().slice(0, 10),
      shift: 'B',
      note: 'Plate read after the door interlock was found taped open.',
    },
  });
  breach.body?.verdict === 'ACTION'
    ? ok('above the action limit is an ACTION breach', `${breach.body.value} ${breach.body.unit}`)
    : bad('action classification', JSON.stringify(breach.body).slice(0, 120));

  breach.body?.deviationNumber
    ? ok('an action breach raises a deviation automatically', breach.body.deviationNumber)
    : bad('automatic deviation on breach', 'no deviation raised');

  // And it lands in the deviation register, where an investigator actually
  // looks — not only in the EM log.
  const devs = await api('GET', '/quality/deviations', { token: qa.accessToken });
  (devs.body ?? []).some((x) => x.deviationNumber === breach.body?.deviationNumber)
    ? ok('the excursion appears in the deviation register', 'not only in the EM log')
    : bad('excursion visible to an investigator', 'not in the register');

  const envDev = (devs.body ?? []).find((x) => x.deviationNumber === breach.body?.deviationNumber);
  envDev?.category === 'ENVIRONMENTAL'
    ? ok('it is categorised as environmental', envDev.category)
    : bad('excursion categorised', `category=${envDev?.category}`);

  // --- trend ---------------------------------------------------------------
  const summary = await api('GET', '/environmental/summary?days=120', { token: qa.accessToken });
  summary.status === 200 && summary.body.totalReadings > 0
    ? ok('excursion rate is reportable by grade', `${summary.body.totalReadings} readings`)
    : bad('EM summary', JSON.stringify(summary.body).slice(0, 120));

  (summary.body?.byGrade ?? []).every((g) => typeof g.excursionRatePct === 'number')
    ? ok('each grade carries its excursion rate', summary.body.byGrade.map((g) => `${g.grade}:${g.excursionRatePct}%`).join(' '))
    : bad('per-grade rate', JSON.stringify(summary.body?.byGrade).slice(0, 120));

  const future = await api('POST', '/environmental/readings', {
    token: qc.accessToken,
    body: {
      locationId: point.id,
      value: 1,
      sampledAt: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10),
    },
  });
  future.status >= 400
    ? ok('a reading dated in the future is REFUSED')
    : bad('future reading refused', `${future.status}`);

  const auditorRecord = await api('POST', '/environmental/readings', {
    token: auditor.accessToken,
    body: {
      locationId: point.id,
      value: 1,
      sampledAt: new Date().toISOString().slice(0, 10),
    },
  });
  auditorRecord.status === 403
    ? ok('the auditor cannot record a reading', '403 — read-only')
    : bad('EM recording permissioned', `${auditorRecord.status}`);

  const emAudit = await api('GET', '/compliance/audit?action=EM_READING_RECORDED&limit=5', {
    token: admin.accessToken,
  });
  (emAudit.body?.items ?? []).length > 0
    ? ok('readings are audited as their own verb', 'EM_READING_RECORDED')
    : bad('EM audited', JSON.stringify(emAudit.body).slice(0, 110));

  // ================================================ product quality review
  section('Product Quality Review (Schedule M)');

  const mats = await api('GET', '/stores/materials', { token: qa.accessToken });
  const pcm = (mats.body ?? []).find((m) => m.code === 'API-PCM');

  const pqr = await api('GET', `/pqr/materials/${pcm.id}`, { token: qa.accessToken });
  pqr.status === 200
    ? ok('a review generates for a product', `${pqr.body.material.code} ${pqr.body.period.from} → ${pqr.body.period.to}`)
    : bad('generate PQR', `${pqr.status} ${JSON.stringify(pqr.body).slice(0, 120)}`);

  pqr.body?.batches?.total > 1
    ? ok('it covers the batches made in the period', `${pqr.body.batches.total} batches`)
    : bad('batches in review', `${pqr.body?.batches?.total}`);

  typeof pqr.body?.batches?.rejectionRatePct === 'number'
    ? ok('it reports a rejection rate', `${pqr.body.batches.rejectionRatePct}%`)
    : bad('rejection rate', 'not computed');

  // Supplier concentration is the single most actionable thing a review
  // surfaces, and it is invisible batch by batch.
  (pqr.body?.suppliers ?? []).length > 1
    ? ok('it breaks results down by supplier', pqr.body.suppliers.map((x) => x.name.split(' ')[0]).join(', '))
    : bad('supplier breakdown', JSON.stringify(pqr.body?.suppliers).slice(0, 110));

  // The trend section is the part a reviewer actually reads.
  const assay = (pqr.body?.trends ?? []).find((t) => t.analyte === 'ASSAY');
  assay && assay.n > 1 && assay.rsdPct != null
    ? ok('assay is trended across the period', `n=${assay.n} mean ${assay.mean} RSD ${assay.rsdPct}%`)
    : bad('assay trend', JSON.stringify(assay).slice(0, 120));

  // An analyte measured once is reported with a null spread rather than
  // omitted — omitting it reads as "not tested".
  const single = (pqr.body?.trends ?? []).find((t) => t.n === 1);
  !single || single.sd === null
    ? ok('a single result reports no standard deviation', 'one point is not a trend')
    : bad('single-result handling', JSON.stringify(single).slice(0, 110));

  pqr.body?.deviations?.total >= 0 && pqr.body?.capa && pqr.body?.changes && pqr.body?.stability
    ? ok(
        'the review pulls the whole quality system together',
        `${pqr.body.deviations.total} deviations · ${pqr.body.capa.total} CAPA · ` +
          `${pqr.body.changes.total} changes · ${pqr.body.stability.length} studies`,
      )
    : bad('review completeness', JSON.stringify(Object.keys(pqr.body ?? {})).slice(0, 120));

  // THE JUDGEMENT: the system assembles, the manufacturer concludes.
  pqr.body?.conclusion === null
    ? ok('the system does NOT write the conclusion', 'the regulation asks the manufacturer to conclude')
    : bad('conclusion left to the reviewer', `got ${JSON.stringify(pqr.body?.conclusion)}`);

  const badPeriod = await api('GET', `/pqr/materials/${pcm.id}?from=2026-01-01&to=2025-01-01`, {
    token: qa.accessToken,
  });
  badPeriod.status >= 400
    ? ok('a period that ends before it starts is REFUSED')
    : bad('period validated', `${badPeriod.status}`);

  const qcPqr = await api('GET', `/pqr/materials/${pcm.id}`, { token: qc.accessToken });
  qcPqr.status === 403
    ? ok('the bench cannot pull a product quality review', '403 — needs pqr:read')
    : bad('PQR permissioned', `${qcPqr.status}`);

  const pqrAudit = await api('GET', '/compliance/audit?action=PQR_GENERATED&limit=5', {
    token: admin.accessToken,
  });
  (pqrAudit.body?.items ?? []).length > 0
    ? ok('generating a review is audited', 'PQR_GENERATED')
    : bad('PQR audited', JSON.stringify(pqrAudit.body).slice(0, 110));

  // =========================================================== audit trail
  section('The thread is in the audit trail');

  for (const [verb, label] of [
    ['DEVIATION_RAISED', 'raising'],
    ['DEVIATION_CLOSED', 'closing'],
    ['CAPA_RAISED', 'the action'],
    ['CAPA_VERIFIED', 'the effectiveness check'],
    ['CHANGE_REQUESTED', 'raising a change'],
    ['CHANGE_APPROVED', 'approving a change'],
    ['CHANGE_IMPLEMENTED', 'implementing a change'],
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
