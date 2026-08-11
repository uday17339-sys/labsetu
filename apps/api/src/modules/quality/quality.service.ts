import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * Deviations and CAPA.
 *
 * The thread an inspector follows is always the same: something departed from
 * what was supposed to happen, somebody investigated it, an action was taken,
 * and somebody later checked the action worked. Before this the system could
 * describe the problem — an OOS opens itself and blocks release — but the
 * thread stopped at a free-text field on a disposition, which is precisely
 * where findings get written.
 *
 * Two decisions worth stating, because both are the kind that get argued about:
 *
 *   - Severity is assigned at CLOSURE, not at raising. A severity guessed
 *     before the investigation is a guess, and an early guess is the one that
 *     sticks; classifying at the end means the classification reflects what was
 *     actually found.
 *   - A CAPA is not complete when the action is done. It is complete when
 *     somebody has verified the action worked, on a separate date, because
 *     checking effectiveness on the day of the fix proves nothing. "Done" with
 *     no verification is a promise, and repeat deviations are how an inspector
 *     proves the promise was empty.
 */
@Injectable()
export class QualityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- numbering

  /**
   * Continues a per-year series rather than counting rows.
   *
   * Counting breaks the moment a record is cancelled or seeded sparsely: the
   * count returns a number already taken, and the unique constraint turns that
   * into a failure at the worst moment — when somebody is trying to raise a
   * deviation about something that has just gone wrong.
   */
  private async nextNumber(
    kind: 'deviation' | 'capa_action' | 'change_control',
    prefix: string,
  ): Promise<string> {
    const tx = this.prisma.tx;
    const year = new Date().getFullYear() % 100;
    const stem = `${prefix}/${year}/`;

    const column =
      kind === 'deviation'
        ? 'deviationNumber'
        : kind === 'capa_action'
          ? 'capaNumber'
          : 'changeNumber';

    const rows = await tx.$queryRawUnsafe<{ n: string }[]>(
      `SELECT "${column}" AS n FROM "${kind}" WHERE "${column}" LIKE $1 ORDER BY "${column}" DESC LIMIT 1`,
      `${stem}%`,
    );

    const next = rows.length > 0 ? Number(rows[0]!.n.slice(stem.length)) + 1 : 1;
    return `${stem}${String(next).padStart(4, '0')}`;
  }

  // --------------------------------------------------------------- deviations

  async raiseDeviation(input: {
    title: string;
    description: string;
    category: string;
    occurredAt: Date;
    detectedAt: Date;
    batchId?: string;
    deviceId?: string;
    labId?: string;
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    if (input.detectedAt < input.occurredAt) {
      throw new BadRequestException(
        'A deviation cannot be detected before it occurred. Check the dates.',
      );
    }
    if (input.occurredAt > new Date()) {
      throw new BadRequestException('A deviation cannot have occurred in the future.');
    }

    if (input.batchId) {
      const batch = await tx.materialBatch.findUnique({ where: { id: input.batchId } });
      if (!batch) throw new NotFoundException('Batch not found');
    }

    const deviationNumber = await this.nextNumber('deviation', 'DEV');

    const deviation = await tx.deviation.create({
      data: {
        tenantId: ctx.tenantId!,
        deviationNumber,
        title: input.title.trim(),
        description: input.description.trim(),
        category: input.category as never,
        occurredAt: input.occurredAt,
        detectedAt: input.detectedAt,
        batchId: input.batchId ?? null,
        deviceId: input.deviceId ?? null,
        labId: input.labId ?? null,
        reportedBy: ctx.userId!,
      },
    });

    await this.audit.record(tx, {
      action: 'DEVIATION_RAISED',
      entityType: 'Deviation',
      entityId: deviation.id,
      after: {
        deviationNumber,
        category: input.category,
        occurredAt: input.occurredAt.toISOString(),
        detectedAt: input.detectedAt.toISOString(),
        /// The gap between the two is itself a finding: a month between an event
        /// and anyone noticing says something about the system that caught it.
        detectionLagHours: Math.round(
          (input.detectedAt.getTime() - input.occurredAt.getTime()) / 36e5,
        ),
        batchId: input.batchId ?? null,
      },
      reason: input.title.trim(),
    });

    return this.deviationView(deviation.id);
  }

  async investigateDeviation(
    id: string,
    input: { investigation: string; rootCause?: string; impactAssessment?: string },
  ) {
    const tx = this.prisma.tx;
    const deviation = await tx.deviation.findUnique({ where: { id } });
    if (!deviation) throw new NotFoundException('Deviation not found');
    if (deviation.status === 'CLOSED' || deviation.status === 'CANCELLED') {
      throw new BadRequestException(
        `${deviation.deviationNumber} is ${deviation.status.toLowerCase()} and cannot be investigated further. ` +
          `Raise a new deviation if something else has come to light.`,
      );
    }

    const updated = await tx.deviation.update({
      where: { id },
      data: {
        investigation: input.investigation.trim(),
        rootCause: input.rootCause?.trim() || deviation.rootCause,
        impactAssessment: input.impactAssessment?.trim() || deviation.impactAssessment,
        status: 'UNDER_INVESTIGATION',
      },
    });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'Deviation',
      entityId: id,
      before: { status: deviation.status },
      after: { status: updated.status, rootCauseRecorded: !!updated.rootCause },
      reason: input.investigation.trim().slice(0, 500),
    });

    return this.deviationView(id);
  }

  /**
   * Closing a deviation.
   *
   * Requires a root cause, a product-impact judgement and a severity. Any of
   * the three missing makes the record unusable to the next person: a closed
   * deviation with no root cause tells a reader only that somebody stopped
   * looking.
   *
   * A deviation with product impact CONFIRMED or POTENTIAL cannot close without
   * at least one CAPA against it. That is the rule that turns this from a log
   * into a quality system.
   */
  async closeDeviation(
    id: string,
    input: { rootCause: string; severity: string; productImpact: string; impactAssessment?: string },
  ) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const deviation = await tx.deviation.findUnique({
      where: { id },
      include: { capas: true },
    });
    if (!deviation) throw new NotFoundException('Deviation not found');
    if (deviation.status === 'CLOSED') {
      throw new BadRequestException(`${deviation.deviationNumber} is already closed.`);
    }

    if (!deviation.investigation) {
      throw new BadRequestException(
        `${deviation.deviationNumber} has no investigation recorded. Record what was looked at ` +
          `before closing it.`,
      );
    }

    const needsCapa = input.productImpact === 'CONFIRMED' || input.productImpact === 'POTENTIAL';
    const openCapas = deviation.capas.filter((c) => c.status !== 'CANCELLED');
    if (needsCapa && openCapas.length === 0) {
      throw new BadRequestException(
        `${deviation.deviationNumber} assesses product impact as ${input.productImpact.toLowerCase()}, ` +
          `so it cannot be closed without a corrective action. Raise a CAPA against it first.`,
      );
    }

    const updated = await tx.deviation.update({
      where: { id },
      data: {
        rootCause: input.rootCause.trim(),
        severity: input.severity as never,
        productImpact: input.productImpact as never,
        impactAssessment: input.impactAssessment?.trim() || deviation.impactAssessment,
        status: 'CLOSED',
        closedBy: ctx.userId!,
        closedAt: new Date(),
      },
    });

    await this.audit.record(tx, {
      action: 'DEVIATION_CLOSED',
      entityType: 'Deviation',
      entityId: id,
      before: { status: deviation.status, severity: deviation.severity },
      after: {
        deviationNumber: updated.deviationNumber,
        severity: updated.severity,
        productImpact: updated.productImpact,
        capaCount: openCapas.length,
      },
      reason: input.rootCause.trim().slice(0, 500),
    });

    return this.deviationView(id);
  }

  async listDeviations(params: { status?: string; batchId?: string } = {}) {
    const tx = this.prisma.tx;

    const rows = await tx.deviation.findMany({
      where: {
        ...(params.status ? { status: params.status as never } : {}),
        ...(params.batchId ? { batchId: params.batchId } : {}),
      },
      orderBy: [{ occurredAt: 'desc' }],
      take: 200,
      include: {
        batch: { select: { batchNumber: true, material: { select: { code: true } } } },
        capas: { select: { id: true, status: true, dueAt: true } },
      },
    });

    const now = Date.now();
    return rows.map((d) => ({
      id: d.id,
      deviationNumber: d.deviationNumber,
      title: d.title,
      category: d.category,
      severity: d.severity,
      status: d.status,
      productImpact: d.productImpact,
      occurredAt: d.occurredAt.toISOString(),
      detectedAt: d.detectedAt.toISOString(),
      /// Ageing is what makes a queue actionable. A regulator expects a
      /// deviation closed inside 30 days; the number of days open is the first
      /// column anyone sorts by.
      openDays: Math.floor((now - d.occurredAt.getTime()) / 864e5),
      batch: d.batch
        ? { batchNumber: d.batch.batchNumber, material: d.batch.material.code }
        : null,
      capaCount: d.capas.filter((c) => c.status !== 'CANCELLED').length,
      overdueCapas: d.capas.filter(
        (c) => c.status !== 'VERIFIED' && c.status !== 'CANCELLED' && c.dueAt.getTime() < now,
      ).length,
    }));
  }

  /** The detail view, public so the screen can open one record. */
  async getDeviation(id: string) {
    return this.deviationView(id);
  }

  private async deviationView(id: string) {
    const tx = this.prisma.tx;
    const d = await tx.deviation.findUniqueOrThrow({
      where: { id },
      include: {
        batch: { select: { id: true, batchNumber: true, material: { select: { code: true, name: true } } } },
        device: { select: { code: true, name: true } },
        capas: { orderBy: { createdAt: 'asc' } },
      },
    });

    const now = Date.now();
    return {
      id: d.id,
      deviationNumber: d.deviationNumber,
      title: d.title,
      description: d.description,
      category: d.category,
      severity: d.severity,
      status: d.status,
      productImpact: d.productImpact,
      occurredAt: d.occurredAt.toISOString(),
      detectedAt: d.detectedAt.toISOString(),
      detectionLagHours: Math.round((d.detectedAt.getTime() - d.occurredAt.getTime()) / 36e5),
      openDays: Math.floor((now - d.occurredAt.getTime()) / 864e5),
      investigation: d.investigation,
      rootCause: d.rootCause,
      impactAssessment: d.impactAssessment,
      closedAt: d.closedAt?.toISOString() ?? null,
      batch: d.batch
        ? {
            id: d.batch.id,
            batchNumber: d.batch.batchNumber,
            material: `${d.batch.material.code} — ${d.batch.material.name}`,
          }
        : null,
      device: d.device ? { code: d.device.code, name: d.device.name } : null,
      capas: d.capas.map((c) => ({
        id: c.id,
        capaNumber: c.capaNumber,
        title: c.title,
        kind: c.kind,
        status: c.status,
        dueAt: c.dueAt.toISOString(),
        isOverdue:
          c.status !== 'VERIFIED' && c.status !== 'CANCELLED' && c.dueAt.getTime() < now,
        effectivenessVerdict: c.effectivenessVerdict,
      })),
    };
  }

  // --------------------------------------------------------------------- CAPA

  async raiseCapa(input: {
    title: string;
    description: string;
    kind: string;
    ownerId: string;
    dueAt: Date;
    deviationId?: string;
    oosId?: string;
    changeControlId?: string;
    effectivenessDueAt?: Date;
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    if (!input.deviationId && !input.oosId && !input.changeControlId) {
      throw new BadRequestException(
        'A CAPA must arise from something — name the deviation, OOS investigation or change ' +
          'control it addresses.',
      );
    }

    const owner = await tx.user.findUnique({ where: { id: input.ownerId } });
    if (!owner) throw new NotFoundException('Owner not found');
    if (owner.status !== 'ACTIVE') {
      throw new BadRequestException(
        `${owner.fullName} is not an active user. An action owned by a deactivated account is ` +
          `an action nobody is doing.`,
      );
    }

    if (input.deviationId) {
      const dev = await tx.deviation.findUnique({ where: { id: input.deviationId } });
      if (!dev) throw new NotFoundException('Deviation not found');
    }

    const capaNumber = await this.nextNumber('capa_action', 'CAPA');

    const capa = await tx.capaAction.create({
      data: {
        tenantId: ctx.tenantId!,
        capaNumber,
        title: input.title.trim(),
        description: input.description.trim(),
        kind: input.kind as never,
        ownerId: input.ownerId,
        dueAt: input.dueAt,
        deviationId: input.deviationId ?? null,
        oosId: input.oosId ?? null,
        changeControlId: input.changeControlId ?? null,
        effectivenessDueAt: input.effectivenessDueAt ?? null,
        createdBy: ctx.userId!,
      },
    });

    await this.audit.record(tx, {
      action: 'CAPA_RAISED',
      entityType: 'CapaAction',
      entityId: capa.id,
      after: {
        capaNumber,
        kind: input.kind,
        owner: owner.fullName,
        dueAt: input.dueAt.toISOString(),
        source: input.deviationId
          ? 'DEVIATION'
          : input.oosId
            ? 'OOS'
            : 'CHANGE_CONTROL',
      },
      reason: input.title.trim(),
    });

    return this.capaView(capa.id);
  }

  async completeCapa(id: string, input: { completionNote: string; effectivenessDueAt?: Date }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const capa = await tx.capaAction.findUnique({ where: { id } });
    if (!capa) throw new NotFoundException('CAPA not found');
    if (capa.status === 'VERIFIED') {
      throw new BadRequestException(`${capa.capaNumber} is already verified and closed.`);
    }
    if (capa.status === 'CANCELLED') {
      throw new BadRequestException(`${capa.capaNumber} was cancelled.`);
    }

    const updated = await tx.capaAction.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        completedBy: ctx.userId!,
        completedAt: new Date(),
        completionNote: input.completionNote.trim(),
        effectivenessDueAt: input.effectivenessDueAt ?? capa.effectivenessDueAt,
      },
    });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'CapaAction',
      entityId: id,
      before: { status: capa.status },
      after: {
        capaNumber: updated.capaNumber,
        status: updated.status,
        effectivenessDueAt: updated.effectivenessDueAt?.toISOString() ?? null,
      },
      reason: input.completionNote.trim().slice(0, 500),
    });

    return this.capaView(id);
  }

  /**
   * The effectiveness check — the half that gets dropped.
   *
   * Refused on the same day the action was completed. Effectiveness means the
   * problem stopped recurring, and nothing has had time to recur in an hour;
   * a same-day check is a signature, not evidence.
   *
   * A verdict of NOT_EFFECTIVE does not close the CAPA. It reopens it, because
   * an ineffective action is an open problem wearing a closed label.
   */
  async checkCapaEffectiveness(
    id: string,
    input: { verdict: string; note: string },
  ) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const capa = await tx.capaAction.findUnique({ where: { id } });
    if (!capa) throw new NotFoundException('CAPA not found');
    if (!capa.completedAt) {
      throw new BadRequestException(
        `${capa.capaNumber} has not been completed yet. There is nothing to check the ` +
          `effectiveness of.`,
      );
    }

    const sameDay =
      new Date().toISOString().slice(0, 10) === capa.completedAt.toISOString().slice(0, 10);
    if (sameDay && input.verdict === 'EFFECTIVE') {
      throw new BadRequestException(
        `${capa.capaNumber} was completed today. Effectiveness means the problem stopped ` +
          `recurring, and nothing has had time to recur — schedule the check for the ` +
          `effectiveness due date.`,
      );
    }

    const effective = input.verdict === 'EFFECTIVE';

    const updated = await tx.capaAction.update({
      where: { id },
      data: {
        effectivenessCheckedBy: ctx.userId!,
        effectivenessCheckedAt: new Date(),
        effectivenessVerdict: input.verdict as never,
        effectivenessNote: input.note.trim(),
        // Only an effective action closes. Anything else goes back on the queue.
        status: effective ? 'VERIFIED' : 'IN_PROGRESS',
      },
    });

    await this.audit.record(tx, {
      action: 'CAPA_VERIFIED',
      entityType: 'CapaAction',
      entityId: id,
      before: { status: capa.status },
      after: {
        capaNumber: updated.capaNumber,
        verdict: input.verdict,
        status: updated.status,
      },
      reason: input.note.trim().slice(0, 500),
    });

    return this.capaView(id);
  }

  async listCapas(params: { status?: string; overdueOnly?: boolean } = {}) {
    const tx = this.prisma.tx;
    const now = Date.now();

    const rows = await tx.capaAction.findMany({
      where: params.status ? { status: params.status as never } : {},
      orderBy: [{ dueAt: 'asc' }],
      take: 200,
      include: { deviation: { select: { deviationNumber: true, title: true } } },
    });

    const owners = await tx.user.findMany({
      where: { id: { in: rows.map((r) => r.ownerId) } },
      select: { id: true, fullName: true },
    });
    const nameById = new Map(owners.map((u) => [u.id, u.fullName]));

    const mapped = rows.map((c) => ({
      id: c.id,
      capaNumber: c.capaNumber,
      title: c.title,
      kind: c.kind,
      status: c.status,
      owner: nameById.get(c.ownerId) ?? 'Unknown',
      dueAt: c.dueAt.toISOString(),
      isOverdue: c.status !== 'VERIFIED' && c.status !== 'CANCELLED' && c.dueAt.getTime() < now,
      daysToDue: Math.ceil((c.dueAt.getTime() - now) / 864e5),
      effectivenessDueAt: c.effectivenessDueAt?.toISOString() ?? null,
      /// Completed but never verified is its own kind of overdue, and the one
      /// that hides: the action looks done on every report.
      awaitingEffectivenessCheck:
        c.status === 'COMPLETED' &&
        !!c.effectivenessDueAt &&
        c.effectivenessDueAt.getTime() < now,
      effectivenessVerdict: c.effectivenessVerdict,
      source: c.deviation
        ? { kind: 'DEVIATION', ref: c.deviation.deviationNumber, title: c.deviation.title }
        : c.oosId
          ? { kind: 'OOS', ref: null, title: null }
          : { kind: 'CHANGE_CONTROL', ref: null, title: null },
    }));

    return params.overdueOnly
      ? mapped.filter((c) => c.isOverdue || c.awaitingEffectivenessCheck)
      : mapped;
  }

  private async capaView(id: string) {
    const tx = this.prisma.tx;
    const c = await tx.capaAction.findUniqueOrThrow({
      where: { id },
      include: { deviation: { select: { id: true, deviationNumber: true, title: true } } },
    });
    const owner = await tx.user.findUnique({
      where: { id: c.ownerId },
      select: { fullName: true },
    });

    const now = Date.now();
    return {
      id: c.id,
      capaNumber: c.capaNumber,
      title: c.title,
      description: c.description,
      kind: c.kind,
      status: c.status,
      owner: owner?.fullName ?? 'Unknown',
      dueAt: c.dueAt.toISOString(),
      isOverdue: c.status !== 'VERIFIED' && c.status !== 'CANCELLED' && c.dueAt.getTime() < now,
      completedAt: c.completedAt?.toISOString() ?? null,
      completionNote: c.completionNote,
      effectivenessDueAt: c.effectivenessDueAt?.toISOString() ?? null,
      effectivenessCheckedAt: c.effectivenessCheckedAt?.toISOString() ?? null,
      effectivenessVerdict: c.effectivenessVerdict,
      effectivenessNote: c.effectivenessNote,
      deviation: c.deviation
        ? { id: c.deviation.id, number: c.deviation.deviationNumber, title: c.deviation.title }
        : null,
    };
  }

  // ----------------------------------------------------------- change control

  /**
   * A proposed change to anything under control.
   *
   * The record answers the question asked when a batch made after a change
   * behaves differently from one made before it: who approved this, on what
   * assessment, and what happened afterwards. A change with no impact
   * assessment is the finding.
   */
  async requestChange(input: {
    title: string;
    description: string;
    changeType: string;
    justification: string;
    classification?: string;
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const changeNumber = await this.nextNumber('change_control', 'CC');

    const change = await tx.changeControl.create({
      data: {
        tenantId: ctx.tenantId!,
        changeNumber,
        title: input.title.trim(),
        description: input.description.trim(),
        changeType: input.changeType as never,
        classification: (input.classification ?? 'UNCLASSIFIED') as never,
        justification: input.justification.trim(),
        status: 'DRAFT',
        requestedBy: ctx.userId!,
      },
    });

    await this.audit.record(tx, {
      action: 'CHANGE_REQUESTED',
      entityType: 'ChangeControl',
      entityId: change.id,
      after: { changeNumber, changeType: input.changeType },
      reason: input.title.trim(),
    });

    return this.changeView(change.id);
  }

  /**
   * The impact assessment, recorded before anyone can approve.
   *
   * Separated from approval deliberately. Assessing and approving in one action
   * lets the approver write the assessment that justifies the decision they had
   * already made — which is exactly the sequence a reviewer looks for.
   */
  async assessChange(id: string, input: { impactAssessment: string; prerequisites?: string; classification?: string }) {
    const tx = this.prisma.tx;
    const change = await tx.changeControl.findUnique({ where: { id } });
    if (!change) throw new NotFoundException('Change control not found');
    if (change.status !== 'DRAFT' && change.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `${change.changeNumber} is ${change.status.toLowerCase().replace(/_/g, ' ')} and its ` +
          `assessment can no longer be edited. Raise a new change control.`,
      );
    }

    const updated = await tx.changeControl.update({
      where: { id },
      data: {
        impactAssessment: input.impactAssessment.trim(),
        prerequisites: input.prerequisites?.trim() || change.prerequisites,
        classification: (input.classification ?? change.classification) as never,
        status: 'PENDING_APPROVAL',
      },
    });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'ChangeControl',
      entityId: id,
      before: { status: change.status },
      after: { status: updated.status, classification: updated.classification },
      reason: input.impactAssessment.trim().slice(0, 500),
    });

    return this.changeView(id);
  }

  /**
   * Approval, or refusal.
   *
   * Refuses to approve a change the requester raised themselves. Four-eyes on a
   * change to a specification matters for the same reason it matters on a
   * result: the person proposing it is the last person who should be judging
   * whether it is safe.
   */
  async decideChange(id: string, input: { approve: boolean; note: string }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const change = await tx.changeControl.findUnique({ where: { id } });
    if (!change) throw new NotFoundException('Change control not found');
    if (change.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `${change.changeNumber} is ${change.status.toLowerCase().replace(/_/g, ' ')}. Only a ` +
          `change with a recorded impact assessment can be approved.`,
      );
    }
    if (change.requestedBy === ctx.userId) {
      throw new ForbiddenException(
        'You raised this change, so you cannot also approve it. Another approver must review it.',
      );
    }

    const updated = await tx.changeControl.update({
      where: { id },
      data: input.approve
        ? {
            status: 'APPROVED',
            approvedBy: ctx.userId!,
            approvedAt: new Date(),
            approvalNote: input.note.trim(),
          }
        : { status: 'REJECTED', rejectedReason: input.note.trim() },
    });

    await this.audit.record(tx, {
      action: 'CHANGE_APPROVED',
      entityType: 'ChangeControl',
      entityId: id,
      before: { status: change.status },
      after: { changeNumber: updated.changeNumber, status: updated.status },
      reason: input.note.trim().slice(0, 500),
    });

    return this.changeView(id);
  }

  async implementChange(id: string, input: { implementationNote: string }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const change = await tx.changeControl.findUnique({ where: { id } });
    if (!change) throw new NotFoundException('Change control not found');
    if (change.status !== 'APPROVED') {
      throw new BadRequestException(
        `${change.changeNumber} has not been approved. An unapproved change cannot be ` +
          `implemented — that is the whole point of the record.`,
      );
    }

    const updated = await tx.changeControl.update({
      where: { id },
      data: {
        status: 'IMPLEMENTED',
        implementedBy: ctx.userId!,
        implementedAt: new Date(),
        implementationNote: input.implementationNote.trim(),
      },
    });

    await this.audit.record(tx, {
      action: 'CHANGE_IMPLEMENTED',
      entityType: 'ChangeControl',
      entityId: id,
      before: { status: change.status },
      after: { changeNumber: updated.changeNumber, status: updated.status },
      reason: input.implementationNote.trim().slice(0, 500),
    });

    return this.changeView(id);
  }

  /**
   * Post-implementation review — did the change do what it claimed, without
   * doing anything it did not claim? This is the step that gets skipped, and
   * skipping it is how a change that quietly broke something stays undiscovered
   * until a batch fails.
   */
  async reviewChange(id: string, input: { reviewNote: string }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const change = await tx.changeControl.findUnique({ where: { id } });
    if (!change) throw new NotFoundException('Change control not found');
    if (change.status !== 'IMPLEMENTED') {
      throw new BadRequestException(
        `${change.changeNumber} has not been implemented, so there is nothing to review.`,
      );
    }

    const updated = await tx.changeControl.update({
      where: { id },
      data: {
        status: 'CLOSED',
        reviewedBy: ctx.userId!,
        reviewedAt: new Date(),
        reviewNote: input.reviewNote.trim(),
      },
    });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'ChangeControl',
      entityId: id,
      before: { status: change.status },
      after: { changeNumber: updated.changeNumber, status: 'CLOSED' },
      reason: input.reviewNote.trim().slice(0, 500),
    });

    return this.changeView(id);
  }

  async listChanges(params: { status?: string } = {}) {
    const tx = this.prisma.tx;
    const rows = await tx.changeControl.findMany({
      where: params.status ? { status: params.status as never } : {},
      orderBy: [{ requestedAt: 'desc' }],
      take: 200,
      include: { capas: { select: { id: true, status: true } } },
    });

    const now = Date.now();
    return rows.map((c) => ({
      id: c.id,
      changeNumber: c.changeNumber,
      title: c.title,
      changeType: c.changeType,
      classification: c.classification,
      status: c.status,
      requestedAt: c.requestedAt.toISOString(),
      approvedAt: c.approvedAt?.toISOString() ?? null,
      implementedAt: c.implementedAt?.toISOString() ?? null,
      openDays: Math.floor((now - c.requestedAt.getTime()) / 864e5),
      /// Implemented but never reviewed is the state that hides: it reads as
      /// finished on every summary while the post-implementation check is
      /// outstanding.
      awaitingReview: c.status === 'IMPLEMENTED',
      capaCount: c.capas.filter((x) => x.status !== 'CANCELLED').length,
    }));
  }

  private async changeView(id: string) {
    const tx = this.prisma.tx;
    const c = await tx.changeControl.findUniqueOrThrow({
      where: { id },
      include: { capas: { select: { id: true, capaNumber: true, status: true, title: true } } },
    });

    const ids = [c.requestedBy, c.approvedBy, c.implementedBy, c.reviewedBy].filter(
      (x): x is string => !!x,
    );
    const people = await tx.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true },
    });
    const name = (id: string | null) =>
      id ? (people.find((p) => p.id === id)?.fullName ?? null) : null;

    return {
      id: c.id,
      changeNumber: c.changeNumber,
      title: c.title,
      description: c.description,
      changeType: c.changeType,
      classification: c.classification,
      status: c.status,
      justification: c.justification,
      impactAssessment: c.impactAssessment,
      prerequisites: c.prerequisites,
      requestedBy: name(c.requestedBy),
      requestedAt: c.requestedAt.toISOString(),
      approvedBy: name(c.approvedBy),
      approvedAt: c.approvedAt?.toISOString() ?? null,
      approvalNote: c.approvalNote,
      implementedBy: name(c.implementedBy),
      implementedAt: c.implementedAt?.toISOString() ?? null,
      implementationNote: c.implementationNote,
      reviewedBy: name(c.reviewedBy),
      reviewedAt: c.reviewedAt?.toISOString() ?? null,
      reviewNote: c.reviewNote,
      rejectedReason: c.rejectedReason,
      capas: c.capas,
    };
  }

}
