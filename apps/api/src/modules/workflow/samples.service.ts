import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import type { SampleStatus } from '@labsetu/contracts';
import { SAMPLE_TRANSITIONS, canTransition } from '@labsetu/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { RequestContextStore } from '../../common/context/request-context';

@Injectable()
export class SamplesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findByAccession(accessionNumber: string) {
    const sample = await this.prisma.tx.sample.findFirst({
      where: { accessionNumber: accessionNumber.trim().toUpperCase() },
      include: this.detailInclude(),
    });
    if (!sample) throw new NotFoundException(`No sample with accession ${accessionNumber}`);
    return sample;
  }

  async findOne(id: string) {
    const sample = await this.prisma.tx.sample.findUnique({
      where: { id },
      include: this.detailInclude(),
    });
    if (!sample) throw new NotFoundException('Sample not found');
    return sample;
  }

  async list(q: {
    labId?: string;
    status?: SampleStatus;
    accessionNumber?: string;
    barcode?: string;
    patientId?: string;
    from?: Date;
    to?: Date;
    limit: number;
    cursor?: string;
  }) {
    const rows = await this.prisma.tx.sample.findMany({
      where: {
        ...(q.labId ? { labId: q.labId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.accessionNumber ? { accessionNumber: q.accessionNumber.toUpperCase() } : {}),
        ...(q.barcode ? { barcode: q.barcode } : {}),
        ...(q.patientId ? { patientId: q.patientId } : {}),
        ...(q.from || q.to
          ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
          : {}),
      },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: {
        patient: { select: { id: true, patientCode: true, sex: true, ageYears: true } },
        lab: { select: { code: true } },
        specimenType: { select: { code: true, name: true } },
        containerType: { select: { code: true, name: true, colour: true } },
        tests: {
          select: {
            id: true,
            status: true,
            dueAt: true,
            testDefinition: { select: { code: true, name: true, department: true } },
          },
        },
      },
    });

    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  }

  async collect(id: string, input: { collectedAt?: Date; collectionSite?: string; volumeMl?: number; containerTypeId?: string }) {
    return this.transition(id, 'COLLECTED', {
      collectedAt: input.collectedAt ?? new Date(),
      collectedBy: RequestContextStore.require().userId,
      collectionSite: input.collectionSite ?? null,
      volumeMl: input.volumeMl ?? null,
      ...(input.containerTypeId ? { containerTypeId: input.containerTypeId } : {}),
    });
  }

  /**
   * Receipt into the lab starts the turnaround clock and moves every pending
   * test to IN_PROGRESS — the bench can now work on it.
   */
  async receive(id: string, input: { receivedAt?: Date; storageLocation?: string }) {
    const ctx = RequestContextStore.require();
    const sample = await this.transition(id, 'RECEIVED', {
      receivedAt: input.receivedAt ?? new Date(),
      receivedBy: ctx.userId,
      storageLocation: input.storageLocation ?? null,
    });

    await this.prisma.tx.sampleTest.updateMany({
      where: { sampleId: id, status: 'PENDING' },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
    });

    await this.prisma.tx.sample.update({
      where: { id },
      data: { status: 'IN_PROGRESS' },
    });

    return { ...sample, status: 'IN_PROGRESS' };
  }

  /**
   * Rejection needs a coded reason, not free text: rejection rate by reason is
   * an NABL quality indicator and has to be aggregatable.
   */
  async reject(id: string, rejectionReasonId: string, note?: string) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const reason = await tx.rejectionReason.findUnique({ where: { id: rejectionReasonId } });
    if (!reason) throw new BadRequestException('Unknown rejection reason');

    const sample = await this.transition(
      id,
      'REJECTED',
      {
        rejectedAt: new Date(),
        rejectedBy: ctx.userId,
        rejectionReasonId,
        rejectionNote: note ?? null,
      },
      `${reason.code}: ${reason.name}${note ? ` — ${note}` : ''}`,
    );

    // Cancel outstanding tests: there is no specimen to run them on.
    await tx.sampleTest.updateMany({
      where: { sampleId: id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: ctx.userId,
        rejectionReasonId,
        cancellationNote: `Sample rejected: ${reason.name}`,
      },
    });

    return sample;
  }

  /**
   * The bench worklist. Defaults to work that is actually actionable rather than
   * everything ever created — a technician opening a list of 40,000 completed
   * tests is a screen nobody uses.
   */
  async worklist(q: {
    labId?: string;
    department?: string;
    status?: string[];
    deviceId?: string;
    overdueOnly: boolean;
    priority?: string;
    limit: number;
    cursor?: string;
  }) {
    const statuses = q.status ?? ['IN_PROGRESS', 'RESULT_ENTERED', 'TECH_VERIFIED'];

    const rows = await this.prisma.tx.sampleTest.findMany({
      where: {
        status: { in: statuses as never },
        ...(q.deviceId ? { deviceId: q.deviceId } : {}),
        ...(q.priority ? { priority: q.priority as never } : {}),
        ...(q.overdueOnly ? { dueAt: { lt: new Date() } } : {}),
        ...(q.department ? { testDefinition: { department: q.department as never } } : {}),
        ...(q.labId ? { sample: { labId: q.labId } } : {}),
      },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      // STAT first, then oldest deadline. This is the order a bench actually
      // works in, so it is the default rather than something to configure.
      orderBy: [{ priority: 'desc' }, { dueAt: 'asc' }],
      include: {
        testDefinition: { select: { code: true, name: true, department: true, tatMinutes: true } },
        device: { select: { code: true, name: true } },
        sample: {
          select: {
            id: true,
            accessionNumber: true,
            barcode: true,
            status: true,
            receivedAt: true,
            patient: { select: { id: true, patientCode: true, sex: true, ageYears: true } },
          },
        },
        _count: { select: { results: true } },
      },
    });

    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;

    return {
      items: items.map((t) => ({
        ...t,
        isOverdue: t.dueAt ? t.dueAt < new Date() : false,
      })),
      nextCursor: hasMore ? items[items.length - 1]!.id : null,
    };
  }

  // ---------------------------------------------------------------------------

  /**
   * Applies a status change against the explicit transition table.
   *
   * An invalid transition throws rather than silently no-opping. Silently
   * ignoring an impossible transition is how a sample ends up in a state nobody
   * can explain later — and "we don't know how it got there" is the worst
   * possible answer during an inspection.
   */
  private async transition(
    id: string,
    to: SampleStatus,
    data: Record<string, unknown>,
    reason?: string,
  ) {
    const tx = this.prisma.tx;

    const current = await tx.sample.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Sample not found');

    if (!canTransition(SAMPLE_TRANSITIONS, current.status as SampleStatus, to)) {
      throw new BadRequestException(
        `Cannot move sample ${current.accessionNumber} from ${current.status} to ${to}. ` +
          `Allowed from ${current.status}: ${SAMPLE_TRANSITIONS[current.status as SampleStatus].join(', ') || 'none (terminal state)'}`,
      );
    }

    const updated = await tx.sample.update({
      where: { id },
      data: { status: to, ...data },
    });

    await this.audit.record(tx, {
      action: to === 'REJECTED' ? 'REJECT' : 'UPDATE',
      entityType: 'Sample',
      entityId: id,
      reason: reason ?? null,
      before: { status: current.status },
      after: { status: to, accessionNumber: current.accessionNumber, ...data },
    });

    return updated;
  }

  private detailInclude() {
    return {
      patient: {
        select: { id: true, patientCode: true, sex: true, ageYears: true, dateOfBirth: true },
      },
      lab: { select: { code: true, name: true } },
      order: { select: { id: true, orderNumber: true, priority: true, clinicalNotes: true } },
      specimenType: { select: { code: true, name: true } },
      containerType: { select: { code: true, name: true, colour: true } },
      rejectionReason: { select: { code: true, name: true } },
      tests: {
        include: {
          testDefinition: {
            select: {
              id: true,
              code: true,
              name: true,
              department: true,
              requiresVerification: true,
              analytes: {
                orderBy: { sortOrder: 'asc' as const },
                select: {
                  sortOrder: true,
                  formula: true,
                  analyte: {
                    select: {
                      id: true,
                      code: true,
                      name: true,
                      valueType: true,
                      defaultUnit: true,
                      precision: true,
                      allowedValues: true,
                    },
                  },
                },
              },
            },
          },
          results: {
            where: { isCurrent: true },
            include: { analyte: { select: { code: true, name: true } } },
          },
        },
      },
    };
  }
}
