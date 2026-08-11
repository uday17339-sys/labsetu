import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@labsetu/db';
import { sha256Json } from '@labsetu/crypto';
import {
  SAMPLE_TEST_TRANSITIONS,
  canTransition,
  type SampleTestStatus,
  type EnterResultsInput,
} from '@labsetu/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { CatalogService } from '../catalog/catalog.service';
import { AuthService } from '../auth/auth.service';
import { InventoryService } from '../inventory/inventory.service';
import { OosDetectorService } from '../stores/oos-detector.service';
import { RequestContextStore } from '../../common/context/request-context';
import { ageInDays } from '../patients/patients.service';

@Injectable()
export class ResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
    private readonly auth: AuthService,
    private readonly inventory: InventoryService,
    private readonly oos: OosDetectorService,
  ) {}

  // ---------------------------------------------------------------------------
  // Entry
  // ---------------------------------------------------------------------------

  /**
   * Records analyte values for one test.
   *
   * Never updates a result row in place. A changed value creates version n+1 and
   * marks the previous one `isCurrent = false`, so the original is retained
   * forever — that is the whole basis of the integrity claim, and the reason a
   * change to already-authorised data additionally requires a reason.
   */
  async enterResults(sampleTestId: string, input: EnterResultsInput) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const test = await this.loadTest(sampleTestId);

    // PENDING means the specimen has not been received into the lab yet.
    // Accepting results at that point would let a value be recorded against a
    // sample nobody has confirmed physically arrived — and it would leave the
    // test stuck in PENDING, because PENDING -> RESULT_ENTERED is not a legal
    // transition. Reject with an actionable message instead.
    if (test.status === 'PENDING') {
      throw new BadRequestException(
        `Sample ${test.sample.accessionNumber} has not been received into the lab yet. ` +
          `Receive the sample before entering results.`,
      );
    }

    if (!['IN_PROGRESS', 'RESULT_ENTERED', 'TECH_VERIFIED', 'AUTHORIZED'].includes(test.status)) {
      throw new BadRequestException(
        `Results cannot be entered for a test in status ${test.status}`,
      );
    }

    await this.assertCompetency(ctx.userId!, test.testDefinitionId, 'PERFORM');

    const patient = test.sample.patient;
    const patientAgeDays = patient ? ageInDays(patient) : null;
    const patientSex = patient?.sex ?? 'UNKNOWN';

    const written: { analyteCode: string; value: string; flag: string; version: number }[] = [];

    for (const entry of input.results) {
      const analyte = test.testDefinition.analytes.find((a) => a.analyte.id === entry.analyteId);
      if (!analyte) {
        throw new BadRequestException(
          `Analyte ${entry.analyteId} is not part of test ${test.testDefinition.code}`,
        );
      }

      const previous = await tx.result.findFirst({
        where: { sampleTestId, analyteId: entry.analyteId, isCurrent: true },
      });

      // Changing an already-authorised value is a correction, not an edit, and
      // regulators expect a documented reason for it.
      if (previous && test.status === 'AUTHORIZED' && !entry.changeReason) {
        throw new BadRequestException(
          'This result has already been authorised. A reason for change is required.',
        );
      }

      const parsed = this.parseValue(entry.value, analyte.analyte);

      const range = await this.catalog.resolveReferenceRange(
        tx,
        entry.analyteId,
        patientSex,
        patientAgeDays,
      );

      const { flag, isCritical } = this.evaluate(parsed.numeric, range);
      const delta = await this.deltaCheck(entry.analyteId, patient?.id, parsed.numeric);

      if (previous) {
        await tx.result.update({ where: { id: previous.id }, data: { isCurrent: false } });
      }

      const created = await tx.result.create({
        data: {
          tenantId: ctx.tenantId!,
          sampleTestId,
          analyteId: entry.analyteId,
          version: (previous?.version ?? 0) + 1,
          isCurrent: true,
          value: entry.value,
          numericValue: parsed.numeric,
          unit: entry.unit ?? analyte.analyte.defaultUnit,
          // Snapshot the range: a reprint must reproduce exactly what the
          // patient originally received, even after the catalog is revised.
          refRangeId: range?.id ?? null,
          refLow: range?.lowValue ?? null,
          refHigh: range?.highValue ?? null,
          refDisplay: range ? this.formatRange(range) : null,
          flag,
          isCritical,
          source: 'MANUAL',
          deltaFlag: delta.flagged,
          deltaPct: delta.pct,
          comment: entry.comment ?? null,
          changeReason: entry.changeReason ?? null,
          enteredBy: ctx.userId,
        },
      });

      written.push({
        analyteCode: analyte.analyte.code,
        value: entry.value,
        flag,
        version: created.version,
      });
    }

    // Derived analytes (e.g. LDL by Friedewald) are computed after their inputs
    // land, and are marked CALCULATED so their provenance is visible.
    await this.computeDerived(sampleTestId, test);

    // Decrement reagent stock for this run. Only on the FIRST entry — a
    // correction re-saves the same run and must not consume twice.
    //
    // Deliberately non-blocking: a stock shortfall never prevents a clinical
    // result that has already been produced from being recorded. The shortfall
    // surfaces on the inventory screen instead.
    if (test.status === 'IN_PROGRESS') {
      await this.inventory.consumeForTest(sampleTestId, test.testDefinitionId);
    }

    // Manufacturing QC: a value outside the specification opens an OOS
    // investigation immediately, without anyone choosing to raise one. Returns
    // straight away for patient samples, which have no batch and no
    // specification — reference-range flagging above already handled those.
    const oos = await this.oos.evaluate(sampleTestId);

    const nextStatus: SampleTestStatus = 'RESULT_ENTERED';
    if (canTransition(SAMPLE_TEST_TRANSITIONS, test.status as SampleTestStatus, nextStatus)) {
      await tx.sampleTest.update({
        where: { id: sampleTestId },
        data: {
          status: nextStatus,
          resultAt: new Date(),
          enteredBy: ctx.userId,
          interpretation: input.interpretation ?? test.interpretation,
        },
      });
    }

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'SampleTest',
      entityId: sampleTestId,
      reason: input.results.find((r) => r.changeReason)?.changeReason ?? null,
      before: { status: test.status },
      after: {
        status: nextStatus,
        accessionNumber: test.sample.accessionNumber,
        test: test.testDefinition.code,
        results: written,
        source: 'MANUAL',
        ...(oos.opened.length > 0 ? { oosInvestigationsOpened: oos.opened } : {}),
      },
    });

    const loaded = await this.loadTest(sampleTestId);
    // Surfaced on the response so the bench sees the investigation number the
    // moment it is raised, rather than discovering it on another screen.
    return oos.opened.length > 0
      ? { ...loaded, oosInvestigationsOpened: oos.opened }
      : loaded;
  }

  // ---------------------------------------------------------------------------
  // Technical verification
  // ---------------------------------------------------------------------------

  async verify(sampleTestId: string, note?: string) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const test = await this.loadTest(sampleTestId);
    this.assertTransition(test.status as SampleTestStatus, 'TECH_VERIFIED');
    await this.assertCompetency(ctx.userId!, test.testDefinitionId, 'VERIFY');

    const results = await tx.result.findMany({ where: { sampleTestId, isCurrent: true } });
    if (results.length === 0) {
      throw new BadRequestException('There are no results to verify');
    }

    const missing = test.testDefinition.analytes
      .filter((a) => a.isMandatory && !results.some((r) => r.analyteId === a.analyte.id))
      .map((a) => a.analyte.code);
    if (missing.length > 0) {
      throw new BadRequestException(`Missing mandatory results: ${missing.join(', ')}`);
    }

    await tx.sampleTest.update({
      where: { id: sampleTestId },
      data: { status: 'TECH_VERIFIED', verifiedAt: new Date(), verifiedBy: ctx.userId },
    });

    await this.audit.record(tx, {
      action: 'VERIFY',
      entityType: 'SampleTest',
      entityId: sampleTestId,
      reason: note ?? null,
      before: { status: test.status },
      after: {
        status: 'TECH_VERIFIED',
        accessionNumber: test.sample.accessionNumber,
        test: test.testDefinition.code,
      },
    });

    return this.loadTest(sampleTestId);
  }

  // ---------------------------------------------------------------------------
  // Medical authorisation  —  the signature gate
  // ---------------------------------------------------------------------------

  /**
   * Authorises a test for release. Four independent gates must pass:
   *
   *   1. Competency — is this user authorised for THIS test, right now?
   *   2. Four-eyes  — the authoriser is not the person who entered the result.
   *   3. QC         — the analyzer's QC for these analytes is passing.
   *   4. Signature  — a re-authenticated, content-bound electronic signature.
   *
   * Each exists because a real lab failure mode maps to it. Together they are
   * what makes an authorised LabSetu result defensible in an audit.
   */
  async authorize(sampleTestId: string, signingToken: string, meaning: string, note?: string) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const test = await this.loadTest(sampleTestId);
    this.assertTransition(test.status as SampleTestStatus, 'AUTHORIZED');

    // 1 — competency
    await this.assertCompetency(ctx.userId!, test.testDefinitionId, 'AUTHORIZE');

    // 2 — four-eyes
    const fourEyes = await this.policy('result.fourEyesRequired', true);
    if (fourEyes && test.enteredBy && test.enteredBy === ctx.userId) {
      throw new ForbiddenException(
        'You entered these results, so you cannot also authorise them. ' +
          'Another authorised user must review and authorise.',
      );
    }

    // 3 — QC gate
    await this.assertQcPassing(test);

    // 4 — the instrument was in calibration when the work was done
    await this.assertInstrumentCalibrated(test);

    // 5 — signature over the exact content being authorised
    const contentHash = await this.contentHash(sampleTestId);
    const signature = await this.auth.consumeSigningToken(signingToken, {
      entityType: 'SampleTest',
      entityId: sampleTestId,
      contentHash,
    });

    await tx.sampleTest.update({
      where: { id: sampleTestId },
      data: { status: 'AUTHORIZED', authorizedAt: new Date(), authorizedBy: ctx.userId },
    });

    const auditId = await this.audit.record(tx, {
      action: 'AUTHORIZE',
      entityType: 'SampleTest',
      entityId: sampleTestId,
      reason: note ?? null,
      before: { status: test.status },
      after: {
        status: 'AUTHORIZED',
        accessionNumber: test.sample.accessionNumber,
        test: test.testDefinition.code,
        contentHash,
        meaning,
      },
    });

    await tx.signature.create({
      data: {
        tenantId: ctx.tenantId!,
        userId: signature.userId,
        entityType: 'SampleTest',
        entityId: sampleTestId,
        meaning: meaning as never,
        contentHash,
        method: 'PASSWORD_TOTP',
        reason: note ?? null,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        auditLogId: auditId,
      },
    });

    // Close the sample once nothing is outstanding on it.
    const outstanding = await tx.sampleTest.count({
      where: {
        sampleId: test.sampleId,
        status: { notIn: ['AUTHORIZED', 'REPORTED', 'CANCELLED'] },
      },
    });
    if (outstanding === 0) {
      await tx.sample.update({ where: { id: test.sampleId }, data: { status: 'COMPLETED' } });
    }

    return this.loadTest(sampleTestId);
  }

  async rerun(sampleTestId: string, reason: string) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const test = await this.loadTest(sampleTestId);
    this.assertTransition(test.status as SampleTestStatus, 'RERUN');

    await tx.sampleTest.update({
      where: { id: sampleTestId },
      data: {
        status: 'IN_PROGRESS',
        rerunCount: { increment: 1 },
        rerunReason: reason,
        resultAt: null,
        verifiedAt: null,
        verifiedBy: null,
      },
    });

    // Previous values are superseded, never deleted — a re-run is part of the
    // record, and hiding it would be exactly the behaviour this system exists
    // to make impossible.
    await tx.result.updateMany({ where: { sampleTestId, isCurrent: true }, data: { isCurrent: false } });

    await this.audit.record(tx, {
      action: 'RERUN',
      entityType: 'SampleTest',
      entityId: sampleTestId,
      reason,
      before: { status: test.status, rerunCount: test.rerunCount },
      after: {
        status: 'IN_PROGRESS',
        rerunCount: test.rerunCount + 1,
        accessionNumber: test.sample.accessionNumber,
      },
    });

    return this.loadTest(sampleTestId);
  }

  /**
   * Hash of exactly what is being signed.
   *
   * Computed from the current values, so if anything changes between requesting
   * the signature and applying it, the hashes diverge and the signature is
   * refused. Without this, a signature would attest only that a button was
   * pressed at some point.
   */
  async contentHash(sampleTestId: string): Promise<string> {
    const results = await this.prisma.tx.result.findMany({
      where: { sampleTestId, isCurrent: true },
      orderBy: { analyteId: 'asc' },
      select: {
        analyteId: true,
        value: true,
        unit: true,
        flag: true,
        version: true,
        refDisplay: true,
      },
    });

    const test = await this.prisma.tx.sampleTest.findUniqueOrThrow({
      where: { id: sampleTestId },
      select: { id: true, testDefinitionId: true, testVersion: true, interpretation: true },
    });

    return sha256Json({ test, results });
  }

  /**
   * Test detail, enriched with the reference range that WILL apply to each
   * analyte — including ones with no result yet.
   *
   * The bench needs to see the expected range while typing, not after saving:
   * a value that looks wrong against its range is the cheapest transcription
   * check there is. Without this the range column is blank on exactly the
   * screen where it matters most.
   */
  async getTest(sampleTestId: string) {
    const test = await this.loadTest(sampleTestId);
    const patient = test.sample.patient;
    const ageDays = patient ? ageInDays(patient) : null;
    const sex = patient?.sex ?? 'UNKNOWN';

    const applicableRanges: Record<string, string | null> = {};
    for (const ta of test.testDefinition.analytes) {
      const range = await this.catalog.resolveReferenceRange(
        this.prisma.tx,
        ta.analyte.id,
        sex,
        ageDays,
      );
      applicableRanges[ta.analyte.id] = range ? this.formatRange(range) : null;
    }

    return { ...test, applicableRanges };
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private async loadTest(id: string) {
    const test = await this.prisma.tx.sampleTest.findUnique({
      where: { id },
      include: {
        testDefinition: {
          include: { analytes: { include: { analyte: true }, orderBy: { sortOrder: 'asc' } } },
        },
        device: { select: { id: true, code: true, name: true } },
        sample: {
          select: {
            id: true,
            accessionNumber: true,
            status: true,
            labId: true,
            patient: {
              select: {
                id: true,
                patientCode: true,
                sex: true,
                dateOfBirth: true,
                ageYears: true,
                ageMonths: true,
                ageDays: true,
              },
            },
          },
        },
        results: {
          where: { isCurrent: true },
          include: { analyte: true },
          orderBy: { analyteId: 'asc' },
        },
      },
    });
    if (!test) throw new NotFoundException('Test not found');
    return test;
  }

  private assertTransition(from: SampleTestStatus, to: SampleTestStatus): void {
    if (!canTransition(SAMPLE_TEST_TRANSITIONS, from, to)) {
      throw new BadRequestException(
        `Cannot move this test from ${from} to ${to}. ` +
          `Allowed from ${from}: ${SAMPLE_TEST_TRANSITIONS[from].join(', ') || 'none (terminal state)'}`,
      );
    }
  }

  /**
   * ISO 15189 / NABL: only personnel authorised for a given test may perform or
   * verify it, and the authorisation must be current. Expired competency is a
   * finding an assessor will look for specifically.
   */
  private async assertCompetency(
    userId: string,
    testDefinitionId: string,
    level: 'PERFORM' | 'VERIFY' | 'AUTHORIZE',
  ): Promise<void> {
    const now = new Date();
    const competency = await this.prisma.tx.userCompetency.findFirst({
      where: {
        userId,
        testDefinitionId,
        level,
        revokedAt: null,
        validFrom: { lte: now },
        OR: [{ validUntil: null }, { validUntil: { gte: now } }],
      },
    });

    if (!competency) {
      const test = await this.prisma.tx.testDefinition.findUnique({
        where: { id: testDefinitionId },
        select: { code: true, name: true },
      });
      throw new ForbiddenException(
        `You do not hold current ${level} competency for ${test?.code ?? 'this test'}. ` +
          `Ask a lab administrator to record your competency assessment.`,
      );
    }
  }

  /**
   * Blocks authorisation when QC for the analyzer + analyte is failing.
   *
   * This is what makes "run the QC afterwards" impossible rather than merely
   * discouraged (COMPLIANCE.md §6). Overriding is possible but is a separate,
   * signed, audited action.
   */
  private async assertQcPassing(test: { deviceId: string | null; testDefinition: { analytes: { analyte: { id: string; code: string } }[] } }): Promise<void> {
    const enabled = await this.policy('qc.blockAuthorizationOnFailure', true);
    if (!enabled || !test.deviceId) return;

    const analyteIds = test.testDefinition.analytes.map((a) => a.analyte.id);
    if (analyteIds.length === 0) return;

    const failing = await this.prisma.tx.qcResult.findMany({
      where: {
        deviceId: test.deviceId,
        analyteId: { in: analyteIds },
        status: 'REJECT',
        acceptedAt: null,
      },
      include: { analyte: { select: { code: true } } },
      orderBy: { runAt: 'desc' },
      take: 5,
    });

    if (failing.length > 0) {
      const codes = [...new Set(failing.map((f) => f.analyte.code))].join(', ');
      throw new ForbiddenException(
        `Quality control has failed for ${codes} on this analyzer and has not been resolved. ` +
          `Resolve the QC failure, or record a documented override, before authorising patient results.`,
      );
    }
  }

  /**
   * Refuses to authorise a result produced on an instrument that is out of
   * calibration.
   *
   * The due date has been on the device record since the beginning and was read
   * by nothing, which is worse than not having it: the field looks like a
   * control and behaves like a comment. Data generated on uncalibrated
   * equipment is not defensible — an inspector who finds an assay authorised
   * three weeks after the HPLC's calibration lapsed will discard the batch
   * record, and rightly.
   *
   * Checked at AUTHORISATION rather than at result entry on purpose. Entry is
   * the bench recording what happened; authorisation is the assertion that the
   * result can be relied upon, and that is the claim calibration underwrites.
   * Blocking entry would also strand results that were legitimately generated
   * before the due date passed.
   *
   * Governed by a policy key so a site can stage the control while it gets its
   * calibration records into the system, but it defaults ON: a plant that has
   * not configured anything gets the safe behaviour.
   */
  private async assertInstrumentCalibrated(test: {
    deviceId: string | null;
  }): Promise<void> {
    const enabled = await this.policy('instrument.blockAuthorizationWhenOutOfCalibration', true);
    if (!enabled || !test.deviceId) return;

    const device = await this.prisma.tx.device.findUnique({
      where: { id: test.deviceId },
      select: { code: true, name: true, calibrationDueAt: true },
    });
    if (!device?.calibrationDueAt) return;

    if (device.calibrationDueAt < new Date()) {
      const due = device.calibrationDueAt.toISOString().slice(0, 10);
      throw new ForbiddenException(
        `${device.code} was out of calibration on ${due}. Results produced on it cannot be ` +
          `authorised until the instrument is recalibrated and the due date updated. ` +
          `If the calibration was performed, record it against the instrument first.`,
      );
    }
  }

  private async policy<T>(key: string, fallback: T): Promise<T> {
    const row = await this.prisma.tx.tenantPolicy.findFirst({ where: { key } });
    return row ? (row.value as T) : fallback;
  }

  /**
   * Parses a raw value against the analyte's declared type.
   *
   * The raw string is always kept. "<0.01" and ">1000" are legitimate,
   * reportable results — coercing them to a number would report 0.01 and 1000,
   * which are clinically different claims from what the instrument said.
   */
  private parseValue(
    raw: string,
    analyte: { valueType: string; allowedValues: string[]; code: string; precision: number },
  ): { numeric: Prisma.Decimal | null } {
    const trimmed = raw.trim();

    switch (analyte.valueType) {
      case 'NUMERIC': {
        const n = Number(trimmed);
        if (!Number.isFinite(n)) {
          throw new BadRequestException(
            `${analyte.code} expects a number, but received "${raw}"`,
          );
        }
        return { numeric: new Prisma.Decimal(trimmed) };
      }

      case 'NUMERIC_BOUNDED': {
        // Keep the operator in `value`; extract the bound for trending only.
        const m = /^([<>]=?)?\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.exec(trimmed);
        if (!m) {
          const asNum = Number(trimmed);
          if (Number.isFinite(asNum)) return { numeric: new Prisma.Decimal(trimmed) };
          throw new BadRequestException(
            `${analyte.code} expects a number, optionally prefixed with < or > (e.g. "<0.01")`,
          );
        }
        return { numeric: new Prisma.Decimal(m[2]!) };
      }

      case 'QUALITATIVE': {
        if (analyte.allowedValues.length > 0 && !analyte.allowedValues.includes(trimmed)) {
          throw new BadRequestException(
            `${analyte.code} must be one of: ${analyte.allowedValues.join(', ')}`,
          );
        }
        return { numeric: null };
      }

      case 'TITRE':
      case 'TEXT':
      default:
        return { numeric: null };
    }
  }

  private evaluate(
    numeric: Prisma.Decimal | null,
    range: {
      lowValue: Prisma.Decimal | null;
      highValue: Prisma.Decimal | null;
      criticalLow: Prisma.Decimal | null;
      criticalHigh: Prisma.Decimal | null;
    } | null,
  ): { flag: 'NORMAL' | 'LOW' | 'HIGH' | 'CRITICAL_LOW' | 'CRITICAL_HIGH'; isCritical: boolean } {
    if (!numeric || !range) return { flag: 'NORMAL', isCritical: false };

    // Critical is checked before high/low: a critically low value is not merely
    // low, and the distinction drives whether a clinician must be phoned.
    if (range.criticalLow && numeric.lessThan(range.criticalLow)) {
      return { flag: 'CRITICAL_LOW', isCritical: true };
    }
    if (range.criticalHigh && numeric.greaterThan(range.criticalHigh)) {
      return { flag: 'CRITICAL_HIGH', isCritical: true };
    }
    if (range.lowValue && numeric.lessThan(range.lowValue)) {
      return { flag: 'LOW', isCritical: false };
    }
    if (range.highValue && numeric.greaterThan(range.highValue)) {
      return { flag: 'HIGH', isCritical: false };
    }
    return { flag: 'NORMAL', isCritical: false };
  }

  /**
   * Compares against the patient's previous result for the same analyte.
   *
   * A large unexplained swing usually means a mix-up or a pre-analytical
   * problem rather than a real physiological change, which is why it is
   * surfaced to the verifier rather than silently accepted.
   */
  private async deltaCheck(
    analyteId: string,
    patientId: string | undefined,
    numeric: Prisma.Decimal | null,
  ): Promise<{ flagged: boolean; pct: Prisma.Decimal | null }> {
    if (!patientId || !numeric) return { flagged: false, pct: null };

    const threshold = await this.policy('result.deltaCheckPercent', 30);

    const previous = await this.prisma.tx.result.findFirst({
      where: {
        analyteId,
        isCurrent: true,
        numericValue: { not: null },
        sampleTest: { sample: { patientId } },
      },
      orderBy: { enteredAt: 'desc' },
      select: { numericValue: true },
    });

    if (!previous?.numericValue || previous.numericValue.isZero()) {
      return { flagged: false, pct: null };
    }

    const pct = numeric
      .minus(previous.numericValue)
      .dividedBy(previous.numericValue)
      .times(100);

    return { flagged: pct.abs().greaterThan(threshold), pct };
  }

  /**
   * Evaluates calculated analytes such as LDL by Friedewald.
   *
   * The evaluator accepts only analyte codes, numbers, parentheses and the four
   * arithmetic operators — no identifiers, no function calls. Formulas come from
   * the tenant's own catalog, but "trusted input" is not a reason to hand a
   * string to an expression evaluator that can reach anything else.
   */
  private async computeDerived(
    sampleTestId: string,
    test: { testDefinition: { analytes: { formula: string | null; analyte: { id: string; code: string; defaultUnit: string | null } }[] } },
  ): Promise<void> {
    const derived = test.testDefinition.analytes.filter((a) => a.formula);
    if (derived.length === 0) return;

    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const current = await tx.result.findMany({
      where: { sampleTestId, isCurrent: true },
      include: { analyte: { select: { code: true } } },
    });

    const values = new Map<string, number>();
    for (const r of current) {
      if (r.numericValue) values.set(r.analyte.code, r.numericValue.toNumber());
    }

    for (const d of derived) {
      const value = safeEvaluate(d.formula!, values);
      if (value === null || !Number.isFinite(value)) continue;

      const rounded = Math.round(value * 100) / 100;

      const previous = await tx.result.findFirst({
        where: { sampleTestId, analyteId: d.analyte.id, isCurrent: true },
      });
      if (previous) {
        await tx.result.update({ where: { id: previous.id }, data: { isCurrent: false } });
      }

      const range = await this.catalog.resolveReferenceRange(
        tx,
        d.analyte.id,
        'UNKNOWN',
        null,
      );
      const { flag, isCritical } = this.evaluate(new Prisma.Decimal(rounded), range);

      await tx.result.create({
        data: {
          tenantId: ctx.tenantId!,
          sampleTestId,
          analyteId: d.analyte.id,
          version: (previous?.version ?? 0) + 1,
          isCurrent: true,
          value: String(rounded),
          numericValue: new Prisma.Decimal(rounded),
          unit: d.analyte.defaultUnit,
          refRangeId: range?.id ?? null,
          refLow: range?.lowValue ?? null,
          refHigh: range?.highValue ?? null,
          refDisplay: range ? this.formatRange(range) : null,
          flag,
          isCritical,
          // Provenance is visible: nobody typed this, it was derived.
          source: 'CALCULATED',
          comment: `Calculated: ${d.formula}`,
          enteredBy: ctx.userId,
        },
      });
    }
  }

  private formatRange(r: {
    displayText: string | null;
    lowValue: Prisma.Decimal | null;
    highValue: Prisma.Decimal | null;
  }): string {
    if (r.displayText) return r.displayText;
    if (r.lowValue && r.highValue) return `${r.lowValue} - ${r.highValue}`;
    if (r.highValue) return `< ${r.highValue}`;
    if (r.lowValue) return `> ${r.lowValue}`;
    return '';
  }
}

/**
 * Tokenising evaluator for catalog formulas. Supports + - * / and parentheses
 * over analyte codes and numeric literals. Anything else is rejected.
 *
 * Deliberately not `eval`, `Function`, or a general expression library: a
 * formula is tenant-editable data, and the blast radius of an evaluator that
 * can reach the runtime is unbounded.
 */
export function safeEvaluate(formula: string, values: Map<string, number>): number | null {
  const tokens = formula.match(/[A-Za-z][A-Za-z0-9_]*|\d+(?:\.\d+)?|[()+\-*/]/g);
  if (!tokens || tokens.join('').length !== formula.replace(/\s+/g, '').length) return null;

  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const parseExpression = (): number | null => {
    let left = parseTerm();
    if (left === null) return null;
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const right = parseTerm();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };

  const parseTerm = (): number | null => {
    let left = parseFactor();
    if (left === null) return null;
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const right = parseFactor();
      if (right === null) return null;
      if (op === '/' && right === 0) return null;
      left = op === '*' ? left * right : left / right;
    }
    return left;
  };

  const parseFactor = (): number | null => {
    const token = next();
    if (token === undefined) return null;

    if (token === '(') {
      const value = parseExpression();
      if (next() !== ')') return null;
      return value;
    }
    if (token === '-') {
      const value = parseFactor();
      return value === null ? null : -value;
    }
    if (/^\d/.test(token)) return Number(token);
    if (/^[A-Za-z]/.test(token)) {
      // A missing input analyte means the formula cannot be evaluated yet —
      // not an error, just "not ready".
      return values.has(token) ? values.get(token)! : null;
    }
    return null;
  };

  const result = parseExpression();
  return pos === tokens.length ? result : null;
}
