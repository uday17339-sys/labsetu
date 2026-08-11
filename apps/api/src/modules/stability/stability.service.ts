import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * Stability studies (ICH Q1A).
 *
 * A shelf life is a claim; a stability study is the evidence for it. The shape
 * is a protocol saying what will be tested under which condition at which
 * intervals, a study putting one batch on that protocol, and a pull per
 * timepoint that becomes an ordinary QC sample once drawn.
 *
 * Two things this gets right that a spreadsheet does not:
 *
 *   - Pulls are scheduled when the study starts, so an approaching timepoint is
 *     visible weeks ahead rather than discovered afterwards. A timepoint that
 *     slips unnoticed is not a missed task; it is a hole in the evidence
 *     supporting an expiry date already printed on cartons in the market.
 *   - A missed pull is recorded, never deleted. Removing it makes the study look
 *     complete, which is the opposite of what the record is for.
 */
@Injectable()
export class StabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ protocol

  async createProtocol(input: {
    code: string;
    name: string;
    storageCondition: string;
    studyType: string;
    timepointsMonths: number[];
    testCodes: string[];
    orientation?: string;
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const sorted = [...new Set(input.timepointsMonths)].sort((a, b) => a - b);
    if (sorted.length === 0) {
      throw new BadRequestException('A protocol with no timepoints tests nothing.');
    }
    if (sorted.some((m) => m < 0)) {
      throw new BadRequestException('Timepoints are months from study start and cannot be negative.');
    }

    // The tests must exist, or the schedule points at nothing when a pull is
    // drawn and somebody has to work out what to run.
    const found = await tx.testDefinition.findMany({
      where: { code: { in: input.testCodes } },
      select: { code: true },
    });
    const missing = input.testCodes.filter((c) => !found.some((f) => f.code === c));
    if (missing.length > 0) {
      throw new BadRequestException(
        `No such test: ${missing.join(', ')}. A protocol can only schedule tests the laboratory has.`,
      );
    }

    const protocol = await tx.stabilityProtocol.create({
      data: {
        tenantId: ctx.tenantId!,
        code: input.code.trim(),
        name: input.name.trim(),
        storageCondition: input.storageCondition.trim(),
        studyType: input.studyType as never,
        orientation: input.orientation?.trim() || null,
        timepointsMonths: sorted,
        testCodes: input.testCodes,
      },
    });

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'StabilityProtocol',
      entityId: protocol.id,
      after: {
        code: protocol.code,
        storageCondition: protocol.storageCondition,
        timepoints: sorted,
        tests: input.testCodes,
      },
    });

    return protocol;
  }

  async listProtocols() {
    const rows = await this.prisma.tx.stabilityProtocol.findMany({
      where: { isActive: true },
      orderBy: { code: 'asc' },
      include: { _count: { select: { studies: true } } },
    });

    return rows.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      storageCondition: p.storageCondition,
      studyType: p.studyType,
      orientation: p.orientation,
      timepointsMonths: p.timepointsMonths,
      testCodes: p.testCodes,
      studyCount: p._count.studies,
    }));
  }

  // --------------------------------------------------------------------- study

  /**
   * Puts a batch on a protocol and schedules every pull up front.
   *
   * Scheduling at start rather than as-you-go is the whole point: the queue can
   * then show what falls due next month, and a timepoint cannot quietly not
   * happen.
   */
  async startStudy(input: { protocolId: string; batchId: string; startedAt: Date; chamber?: string }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const protocol = await tx.stabilityProtocol.findUnique({ where: { id: input.protocolId } });
    if (!protocol) throw new NotFoundException('Protocol not found');

    const batch = await tx.materialBatch.findUnique({
      where: { id: input.batchId },
      include: { material: true },
    });
    if (!batch) throw new NotFoundException('Batch not found');

    const existing = await tx.stabilityStudy.findFirst({
      where: { protocolId: input.protocolId, batchId: input.batchId, status: 'ONGOING' },
    });
    if (existing) {
      throw new BadRequestException(
        `${batch.batchNumber} is already on ${protocol.code} under study ${existing.studyNumber}.`,
      );
    }

    const year = new Date().getFullYear() % 100;
    const stem = `STB/${year}/`;
    const highest = await tx.stabilityStudy.findFirst({
      where: { studyNumber: { startsWith: stem } },
      orderBy: { studyNumber: 'desc' },
      select: { studyNumber: true },
    });
    const next = highest ? Number(highest.studyNumber.slice(stem.length)) + 1 : 1;
    const studyNumber = `${stem}${String(next).padStart(4, '0')}`;

    const study = await tx.stabilityStudy.create({
      data: {
        tenantId: ctx.tenantId!,
        protocolId: input.protocolId,
        batchId: input.batchId,
        studyNumber,
        startedAt: input.startedAt,
        chamber: input.chamber?.trim() || null,
        createdBy: ctx.userId!,
      },
    });

    // Every timepoint, scheduled now.
    await tx.stabilityPull.createMany({
      data: protocol.timepointsMonths.map((months) => ({
        tenantId: ctx.tenantId!,
        studyId: study.id,
        timepointMonths: months,
        dueAt: addMonths(input.startedAt, months),
      })),
    });

    await this.audit.record(tx, {
      action: 'STABILITY_STUDY_STARTED',
      entityType: 'StabilityStudy',
      entityId: study.id,
      after: {
        studyNumber,
        protocol: protocol.code,
        batchNumber: batch.batchNumber,
        material: batch.material.code,
        condition: protocol.storageCondition,
        pullsScheduled: protocol.timepointsMonths.length,
      },
    });

    return this.studyView(study.id);
  }

  /**
   * The pull queue.
   *
   * Overdue is computed rather than stored, and a scheduled pull whose date has
   * passed reads as overdue immediately — it does not wait for somebody to run
   * a job that marks it. A queue that depends on a nightly task to tell the
   * truth is a queue that lies whenever the task fails.
   */
  async listPulls(params: { status?: string; withinDays?: number } = {}) {
    const tx = this.prisma.tx;
    const now = Date.now();

    const rows = await tx.stabilityPull.findMany({
      where: {
        ...(params.status ? { status: params.status as never } : {}),
        ...(params.withinDays
          ? { dueAt: { lte: new Date(now + params.withinDays * 864e5) } }
          : {}),
      },
      orderBy: { dueAt: 'asc' },
      take: 300,
      include: {
        study: {
          include: {
            protocol: { select: { code: true, storageCondition: true, testCodes: true } },
            batch: { select: { batchNumber: true, material: { select: { code: true } } } },
          },
        },
      },
    });

    return rows.map((p) => ({
      id: p.id,
      studyNumber: p.study.studyNumber,
      timepointMonths: p.timepointMonths,
      dueAt: p.dueAt.toISOString(),
      status: p.status,
      daysToDue: Math.ceil((p.dueAt.getTime() - now) / 864e5),
      isOverdue: p.status === 'SCHEDULED' && p.dueAt.getTime() < now,
      condition: p.study.protocol.storageCondition,
      protocol: p.study.protocol.code,
      tests: p.study.protocol.testCodes,
      batchNumber: p.study.batch.batchNumber,
      material: p.study.batch.material.code,
      sampleId: p.sampleId,
    }));
  }

  /**
   * Records that a pull was drawn.
   *
   * Deliberately does not create the sample itself. Sampling has its own path —
   * accession numbering, container counts, the stores/QC handover — and a
   * second way of creating samples would be a second set of rules to keep in
   * step. The pull points at the sample once it exists.
   */
  async recordPull(id: string, input: { sampleId?: string; note?: string }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const pull = await tx.stabilityPull.findUnique({
      where: { id },
      include: { study: { select: { studyNumber: true, status: true } } },
    });
    if (!pull) throw new NotFoundException('Pull not found');
    if (pull.status !== 'SCHEDULED') {
      throw new BadRequestException(
        `This timepoint is already ${pull.status.toLowerCase()}. A pull is recorded once.`,
      );
    }
    if (pull.study.status !== 'ONGOING') {
      throw new BadRequestException(
        `${pull.study.studyNumber} is ${pull.study.status.toLowerCase()} and has no further pulls.`,
      );
    }

    if (input.sampleId) {
      const sample = await tx.sample.findUnique({ where: { id: input.sampleId } });
      if (!sample) throw new NotFoundException('Sample not found');
    }

    const updated = await tx.stabilityPull.update({
      where: { id },
      data: {
        status: 'PULLED',
        pulledAt: new Date(),
        pulledBy: ctx.userId!,
        sampleId: input.sampleId ?? null,
        note: input.note?.trim() || null,
      },
    });

    await this.audit.record(tx, {
      action: 'STABILITY_PULL_RECORDED',
      entityType: 'StabilityPull',
      entityId: id,
      after: {
        studyNumber: pull.study.studyNumber,
        timepointMonths: pull.timepointMonths,
        onTimeDays: Math.round((Date.now() - pull.dueAt.getTime()) / 864e5),
        sampleId: input.sampleId ?? null,
      },
      reason: input.note?.trim(),
    });

    return updated;
  }

  /**
   * Marks a timepoint as missed, with a reason.
   *
   * Kept rather than deleted. A study whose missed pulls have been tidied away
   * looks complete, and "complete" is precisely the claim the record exists to
   * support or refute.
   */
  async markMissed(id: string, input: { note: string }) {
    const tx = this.prisma.tx;

    const pull = await tx.stabilityPull.findUnique({
      where: { id },
      include: { study: { select: { studyNumber: true } } },
    });
    if (!pull) throw new NotFoundException('Pull not found');
    if (pull.status !== 'SCHEDULED') {
      throw new BadRequestException(`This timepoint is already ${pull.status.toLowerCase()}.`);
    }

    const updated = await tx.stabilityPull.update({
      where: { id },
      data: { status: 'MISSED', note: input.note.trim() },
    });

    await this.audit.record(tx, {
      action: 'STABILITY_PULL_MISSED',
      entityType: 'StabilityPull',
      entityId: id,
      after: {
        studyNumber: pull.study.studyNumber,
        timepointMonths: pull.timepointMonths,
        dueAt: pull.dueAt.toISOString(),
      },
      reason: input.note.trim(),
    });

    return updated;
  }

  async listStudies(params: { status?: string } = {}) {
    const tx = this.prisma.tx;
    const now = Date.now();

    const rows = await tx.stabilityStudy.findMany({
      where: params.status ? { status: params.status as never } : {},
      orderBy: { startedAt: 'desc' },
      take: 200,
      include: {
        protocol: { select: { code: true, storageCondition: true, studyType: true } },
        batch: { select: { batchNumber: true, material: { select: { code: true, name: true } } } },
        pulls: { select: { status: true, dueAt: true } },
      },
    });

    return rows.map((s) => ({
      id: s.id,
      studyNumber: s.studyNumber,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      chamber: s.chamber,
      protocol: s.protocol.code,
      condition: s.protocol.storageCondition,
      studyType: s.protocol.studyType,
      batchNumber: s.batch.batchNumber,
      material: `${s.batch.material.code} — ${s.batch.material.name}`,
      pullsTotal: s.pulls.length,
      pullsDone: s.pulls.filter((p) => p.status === 'PULLED' || p.status === 'COMPLETE').length,
      pullsOverdue: s.pulls.filter((p) => p.status === 'SCHEDULED' && p.dueAt.getTime() < now)
        .length,
      pullsMissed: s.pulls.filter((p) => p.status === 'MISSED').length,
    }));
  }

  async getStudy(id: string) {
    return this.studyView(id);
  }

  private async studyView(id: string) {
    const tx = this.prisma.tx;
    const s = await tx.stabilityStudy.findUniqueOrThrow({
      where: { id },
      include: {
        protocol: true,
        batch: { select: { id: true, batchNumber: true, material: { select: { code: true, name: true } } } },
        pulls: { orderBy: { timepointMonths: 'asc' } },
      },
    });

    const now = Date.now();
    return {
      id: s.id,
      studyNumber: s.studyNumber,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      chamber: s.chamber,
      closedReason: s.closedReason,
      protocol: {
        code: s.protocol.code,
        name: s.protocol.name,
        storageCondition: s.protocol.storageCondition,
        studyType: s.protocol.studyType,
        orientation: s.protocol.orientation,
        testCodes: s.protocol.testCodes,
      },
      batch: {
        id: s.batch.id,
        batchNumber: s.batch.batchNumber,
        material: `${s.batch.material.code} — ${s.batch.material.name}`,
      },
      pulls: s.pulls.map((p) => ({
        id: p.id,
        timepointMonths: p.timepointMonths,
        dueAt: p.dueAt.toISOString(),
        status: p.status,
        isOverdue: p.status === 'SCHEDULED' && p.dueAt.getTime() < now,
        daysToDue: Math.ceil((p.dueAt.getTime() - now) / 864e5),
        pulledAt: p.pulledAt?.toISOString() ?? null,
        sampleId: p.sampleId,
        note: p.note,
      })),
    };
  }
}

/**
 * Month arithmetic that does not drift.
 *
 * A 6-month timepoint on 31 January is 31 July, not "182 days later" — adding
 * days accumulates error across a 36-month study and lands the final pull on
 * the wrong side of a month boundary. Clamped to the last day where the target
 * month is shorter, so 31 January plus one month is 28 February rather than
 * rolling into March.
 */
function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  const targetDay = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months, 1);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(targetDay, lastDay));
  return d;
}
