import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { SpecificationsService, renderCriterion } from './specifications.service';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * Quality assurance: the decision, and the investigation that must precede it.
 *
 * QC produces numbers. QA decides what those numbers mean for the batch, and is
 * the only role that can move material out of quarantine. Three controls make
 * that more than an org chart:
 *
 *   1. Disposition requires a signature — a re-authenticated, content-bound
 *      e-signature, the same mechanism a pathologist uses to authorise a report.
 *   2. Disposition is refused while an OOS investigation is open. A batch
 *      cannot be released while the question of why a result failed is unanswered.
 *   3. A critical parameter out of specification cannot be approved at all. A
 *      non-critical one can, but only with a named deviation reference.
 *
 * Dispositions are append-only at the database grant level. Changing your mind
 * means recording a NEW disposition, so a reversal is visible rather than
 * concealed.
 */
@Injectable()
export class QaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly specs: SpecificationsService,
  ) {}

  /**
   * Every result for a batch, judged against the specification in force.
   *
   * This is the QA review screen: the numbers, the criteria, and which of them
   * the material actually met. Computed rather than stored, because the
   * judgement must follow the specification version, not a flag someone set.
   */
  async reviewBatch(batchId: string) {
    const tx = this.prisma.tx;

    const batch = await tx.materialBatch.findUnique({
      where: { id: batchId },
      include: {
        material: true,
        investigations: { where: { status: { not: 'CLOSED' } } },
        dispositions: { orderBy: { decidedAt: 'desc' }, take: 1 },
        orders: {
          orderBy: { orderedAt: 'desc' },
          include: {
            samples: {
              include: {
                tests: {
                  include: {
                    testDefinition: { select: { code: true, name: true } },
                    results: {
                      where: { isCurrent: true },
                      include: {
                        analyte: { select: { id: true, code: true, name: true, defaultUnit: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!batch) throw new NotFoundException('Batch not found');

    const spec = await this.specs.inForce(batch.materialId);

    // Flatten every current result across every order raised on this batch.
    const results = batch.orders.flatMap((o) =>
      o.samples.flatMap((s) =>
        s.tests.flatMap((t) =>
          t.results.map((r) => ({
            resultId: r.id,
            analyteId: r.analyteId,
            analyte: r.analyte,
            value: r.value,
            numericValue: r.numericValue?.toNumber() ?? null,
            unit: r.unit ?? r.analyte.defaultUnit,
            testCode: t.testDefinition.code,
            testName: t.testDefinition.name,
            testStatus: t.status,
            accessionNumber: s.accessionNumber,
            enteredAt: r.enteredAt.toISOString(),
          })),
        ),
      ),
    );

    const byAnalyte = new Map(results.map((r) => [r.analyteId, r]));

    const assessment = (spec?.limits ?? []).map((l) => {
      const result = byAnalyte.get(l.analyteId);
      const min = l.minValue?.toNumber() ?? null;
      const max = l.maxValue?.toNumber() ?? null;
      const criterion = renderCriterion(min, max, l.textCriteria, l.unit ?? l.analyte.defaultUnit);

      if (!result) {
        return {
          analyte: l.analyte,
          criterion,
          isCritical: l.isCritical,
          value: null,
          verdict: 'NOT_TESTED' as const,
        };
      }

      let verdict: 'PASS' | 'FAIL' | 'NOT_ASSESSABLE' = 'PASS';
      if (min != null || max != null) {
        if (result.numericValue == null) {
          // A textual value against a numeric limit cannot be judged
          // automatically. Saying so is safer than guessing PASS.
          verdict = 'NOT_ASSESSABLE';
        } else if (
          (min != null && result.numericValue < min) ||
          (max != null && result.numericValue > max)
        ) {
          verdict = 'FAIL';
        }
      } else if (l.textCriteria) {
        // Textual criteria are judged by the analyst and confirmed by QA;
        // the system reports the pair rather than pretending to compare prose.
        verdict = 'NOT_ASSESSABLE';
      }

      return {
        analyte: l.analyte,
        criterion,
        isCritical: l.isCritical,
        value: result.value,
        numericValue: result.numericValue,
        unit: result.unit,
        testCode: result.testCode,
        accessionNumber: result.accessionNumber,
        testStatus: result.testStatus,
        resultId: result.resultId,
        verdict,
      };
    });

    const failures = assessment.filter((a) => a.verdict === 'FAIL');
    const criticalFailures = failures.filter((a) => a.isCritical);
    const untested = assessment.filter((a) => a.verdict === 'NOT_TESTED');
    const unauthorised = results.filter(
      (r) => r.testStatus !== 'AUTHORIZED' && r.testStatus !== 'REPORTED',
    );

    return {
      batch: {
        id: batch.id,
        batchNumber: batch.batchNumber,
        manufacturerLot: batch.manufacturerLot,
        status: batch.status,
        quantityAvailable: batch.quantityAvailable.toNumber(),
        unit: batch.unit,
        expiryDate: batch.expiryDate?.toISOString().slice(0, 10) ?? null,
        material: {
          id: batch.material.id,
          code: batch.material.code,
          name: batch.material.name,
          type: batch.material.type,
          pharmacopoeia: batch.material.pharmacopoeia,
        },
      },
      specification: spec
        ? { id: spec.id, code: spec.code, version: spec.version, basis: spec.basis }
        : null,
      assessment,
      summary: {
        criteria: assessment.length,
        passed: assessment.filter((a) => a.verdict === 'PASS').length,
        failed: failures.length,
        criticalFailures: criticalFailures.length,
        notTested: untested.length,
        notAssessable: assessment.filter((a) => a.verdict === 'NOT_ASSESSABLE').length,
      },
      /// Everything standing between this batch and a disposition, stated up
      /// front so QA is not told "no" only after filling in a form.
      blockers: [
        ...(batch.investigations.length > 0
          ? [`${batch.investigations.length} open OOS investigation(s)`]
          : []),
        ...(criticalFailures.length > 0
          ? [
              `${criticalFailures.length} critical parameter(s) out of specification: ` +
                criticalFailures.map((f) => f.analyte.code).join(', '),
            ]
          : []),
        ...(untested.length > 0 ? [`${untested.length} criterion/criteria not yet tested`] : []),
        ...(unauthorised.length > 0
          ? [`${unauthorised.length} result(s) not yet authorised`]
          : []),
      ],
      lastDisposition: batch.dispositions[0]
        ? {
            decision: batch.dispositions[0].decision,
            rationale: batch.dispositions[0].rationale,
            decidedAt: batch.dispositions[0].decidedAt.toISOString(),
          }
        : null,
    };
  }

  /**
   * The disposition. Requires a signing token from POST /v1/auth/signing-token.
   */
  async dispose(
    batchId: string,
    input: {
      decision: 'APPROVED' | 'REJECTED' | 'APPROVED_WITH_DEVIATION' | 'RETEST_REQUIRED';
      rationale: string;
      deviationRef?: string;
      signingToken: string;
    },
  ) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const review = await this.reviewBatch(batchId);
    const batch = await tx.materialBatch.findUniqueOrThrow({ where: { id: batchId } });

    if (batch.status === 'CONSUMED') {
      throw new BadRequestException('This batch has been fully issued; there is nothing to release');
    }

    const releasing = input.decision === 'APPROVED' || input.decision === 'APPROVED_WITH_DEVIATION';

    if (releasing) {
      const openOos = await tx.oosInvestigation.count({
        where: { batchId, status: { not: 'CLOSED' } },
      });
      if (openOos > 0) {
        throw new BadRequestException(
          `${openOos} out-of-specification investigation(s) are still open on this batch. ` +
            `Material cannot be released while the question of why a result failed is ` +
            `unanswered — close the investigation first.`,
        );
      }

      if (review.summary.criticalFailures > 0) {
        throw new BadRequestException(
          `${review.summary.criticalFailures} critical parameter(s) are out of specification. ` +
            `A critical excursion fails the batch outright and cannot be dispositioned around.`,
        );
      }

      if (review.summary.notTested > 0) {
        throw new BadRequestException(
          `${review.summary.notTested} acceptance criterion/criteria have no result. ` +
            `Releasing an incompletely tested batch is releasing an untested one.`,
        );
      }

      if (input.decision === 'APPROVED' && review.summary.failed > 0) {
        throw new BadRequestException(
          `${review.summary.failed} non-critical parameter(s) are out of specification. ` +
            `Release is still possible, but it must be recorded as APPROVED_WITH_DEVIATION ` +
            `with a deviation reference — not as a clean approval.`,
        );
      }

      if (input.decision === 'APPROVED_WITH_DEVIATION' && !input.deviationRef?.trim()) {
        throw new BadRequestException(
          'Name the deviation reference. Releasing against an unnamed deviation is not a ' +
            'documented decision.',
        );
      }
    }

    // The signature binds to the assessment as it stands right now. If a result
    // changes between review and signing, the hash moves and the signature is
    // refused — the same guarantee report release has.
    const contentHash = await this.dispositionHash(batchId);
    const signature = await this.auth.consumeSigningToken(input.signingToken, {
      entityType: 'MaterialBatch',
      entityId: batchId,
      contentHash,
    });

    const nextStatus =
      input.decision === 'REJECTED'
        ? ('REJECTED' as const)
        : input.decision === 'RETEST_REQUIRED'
          ? ('RETEST_DUE' as const)
          : ('APPROVED' as const);

    const now = new Date();

    // ORDER MATTERS, and for a reason worth stating: batch_disposition is
    // append-only at the grant level, so the signature id must be present when
    // the row is CREATED. An earlier version wrote the disposition first and
    // then UPDATEd it with the signature, wrapped in a catch because "the grant
    // refuses it anyway". That was wrong twice over — a failed statement aborts
    // the whole Postgres transaction, so the catch swallowed the error while
    // the batch update, the audit entry and the disposition all silently rolled
    // back and the request still answered 200. Audit first, then signature,
    // then the disposition that references it.
    const auditId = await this.audit.record(tx, {
      action: input.decision === 'REJECTED' ? 'REJECT' : 'AUTHORIZE',
      entityType: 'MaterialBatch',
      entityId: batchId,
      reason: input.rationale.trim(),
      before: { status: batch.status },
      after: {
        event: 'QA_DISPOSITION',
        decision: input.decision,
        status: nextStatus,
        material: review.batch.material.code,
        batchNumber: batch.batchNumber,
        specification: review.specification
          ? `${review.specification.code} v${review.specification.version}`
          : null,
        criteriaAssessed: review.summary.criteria,
        passed: review.summary.passed,
        failed: review.summary.failed,
        deviationRef: input.deviationRef?.trim() ?? null,
        contentHash,
      },
    });

    const sig = await tx.signature.create({
      data: {
        tenantId: ctx.tenantId!,
        userId: signature.userId,
        entityType: 'MaterialBatch',
        entityId: batchId,
        meaning: (input.decision === 'REJECTED' ? 'REJECTED' : 'APPROVED') as never,
        contentHash,
        method: 'PASSWORD_TOTP',
        reason: input.rationale.trim(),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        auditLogId: auditId,
      },
    });

    const disposition = await tx.batchDisposition.create({
      data: {
        tenantId: ctx.tenantId!,
        batchId,
        decision: input.decision as never,
        rationale: input.rationale.trim(),
        deviationRef: input.deviationRef?.trim() || null,
        decidedBy: ctx.userId!,
        decidedAt: now,
        signatureId: sig.id,
      },
    });

    await tx.materialBatch.update({
      where: { id: batchId },
      data: {
        status: nextStatus,
        dispositionedAt: now,
        dispositionedBy: ctx.userId,
        location:
          nextStatus === 'APPROVED'
            ? 'APPROVED STORE'
            : nextStatus === 'REJECTED'
              ? 'REJECTED STORE'
              : batch.location,
      },
    });

    return {
      batchId,
      batchNumber: batch.batchNumber,
      decision: input.decision,
      status: nextStatus,
      dispositionId: disposition.id,
      signatureId: sig.id,
      decidedAt: now.toISOString(),
      isIssuable: nextStatus === 'APPROVED',
    };
  }

  /**
   * The content hash a disposition signs.
   *
   * Covers the batch identity and every current result judged against it, so a
   * result changed after QA reviewed it invalidates the pending signature.
   */
  async dispositionHash(batchId: string): Promise<string> {
    const review = await this.reviewBatch(batchId);
    const canonical = JSON.stringify({
      batchId,
      batchNumber: review.batch.batchNumber,
      material: review.batch.material.code,
      specification: review.specification
        ? `${review.specification.code}v${review.specification.version}`
        : null,
      results: review.assessment
        .map((a) => `${a.analyte.code}=${a.value ?? ''}:${a.verdict}`)
        .sort(),
    });
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(canonical).digest('hex');
  }

  // --- out-of-specification investigations ----------------------------------

  async listInvestigations(status?: string) {
    const rows = await this.prisma.tx.oosInvestigation.findMany({
      where: status ? { status: status as never } : {},
      orderBy: [{ status: 'asc' }, { openedAt: 'asc' }],
      take: 200,
      include: {
        batch: {
          include: { material: { select: { code: true, name: true } } },
        },
      },
    });

    const now = Date.now();
    return rows.map((i) => ({
      id: i.id,
      investigationNumber: i.investigationNumber,
      analyteCode: i.analyteCode,
      observedValue: i.observedValue,
      limitBreached: i.limitBreached,
      phase: i.phase,
      status: i.status,
      conclusion: i.conclusion,
      rootCause: i.rootCause,
      openedAt: i.openedAt.toISOString(),
      closedAt: i.closedAt?.toISOString() ?? null,
      /// Regulators expect Phase I inside 24 hours and the whole thing inside
      /// 30 days. Ageing the queue is the only way that gets noticed.
      openDays: Math.floor((now - i.openedAt.getTime()) / 864e5),
      batch: {
        id: i.batch.id,
        batchNumber: i.batch.batchNumber,
        status: i.batch.status,
        material: i.batch.material,
      },
    }));
  }

  async progressInvestigation(
    id: string,
    input: {
      phase?: 'PHASE_I' | 'PHASE_II';
      labInvestigationNote?: string;
      manufacturingNote?: string;
      rootCause?: string;
    },
  ) {
    const tx = this.prisma.tx;
    const inv = await tx.oosInvestigation.findUnique({ where: { id } });
    if (!inv) throw new NotFoundException('Investigation not found');
    if (inv.status === 'CLOSED') {
      throw new BadRequestException('This investigation is closed. Open a new one if more is found.');
    }

    const updated = await tx.oosInvestigation.update({
      where: { id },
      data: {
        status: 'UNDER_INVESTIGATION',
        ...(input.phase ? { phase: input.phase } : {}),
        ...(input.labInvestigationNote !== undefined
          ? { labInvestigationNote: input.labInvestigationNote.trim() }
          : {}),
        ...(input.manufacturingNote !== undefined
          ? { manufacturingNote: input.manufacturingNote.trim() }
          : {}),
        ...(input.rootCause !== undefined ? { rootCause: input.rootCause.trim() } : {}),
      },
    });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'OosInvestigation',
      entityId: id,
      after: {
        investigationNumber: inv.investigationNumber,
        phase: updated.phase,
        status: updated.status,
        labInvestigationNote: updated.labInvestigationNote,
        manufacturingNote: updated.manufacturingNote,
        rootCause: updated.rootCause,
      },
    });

    return { id, phase: updated.phase, status: updated.status };
  }

  async closeInvestigation(
    id: string,
    input: { conclusion: string; rootCause: string; correctiveAction: string },
  ) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const inv = await tx.oosInvestigation.findUnique({
      where: { id },
      include: { batch: { include: { material: { select: { code: true } } } } },
    });
    if (!inv) throw new NotFoundException('Investigation not found');
    if (inv.status === 'CLOSED') {
      throw new BadRequestException('This investigation is already closed');
    }

    // "No assignable cause" is the conclusion regulators scrutinise hardest,
    // so it demands the most, not the least: a Phase II must have happened.
    if (input.conclusion === 'NO_ASSIGNABLE_CAUSE' && inv.phase !== 'PHASE_II') {
      throw new BadRequestException(
        'A conclusion of "no assignable cause" cannot be reached from Phase I alone. Escalate ' +
          'to a Phase II manufacturing investigation first — this is the conclusion an ' +
          'inspector examines most closely.',
      );
    }

    const closed = await tx.oosInvestigation.update({
      where: { id },
      data: {
        status: 'CLOSED',
        conclusion: input.conclusion as never,
        rootCause: input.rootCause.trim(),
        correctiveAction: input.correctiveAction.trim(),
        closedBy: ctx.userId,
        closedAt: new Date(),
      },
    });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'OosInvestigation',
      entityId: id,
      reason: input.rootCause.trim(),
      before: { status: inv.status, phase: inv.phase },
      after: {
        event: 'OOS_CLOSED',
        investigationNumber: inv.investigationNumber,
        material: inv.batch.material.code,
        batchNumber: inv.batch.batchNumber,
        analyte: inv.analyteCode,
        observedValue: inv.observedValue,
        limitBreached: inv.limitBreached,
        conclusion: input.conclusion,
        rootCause: input.rootCause.trim(),
        correctiveAction: input.correctiveAction.trim(),
      },
    });

    return {
      id,
      investigationNumber: inv.investigationNumber,
      status: closed.status,
      conclusion: closed.conclusion,
      note: 'The batch can now be dispositioned.',
    };
  }
}
