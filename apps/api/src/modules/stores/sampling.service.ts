import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@labsetu/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AccessionService } from '../workflow/accession.service';
import { SpecificationsService } from './specifications.service';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * Sampling: the handover from stores to QC.
 *
 * Two separate acts by two separate departments, and modelled that way because
 * an inspector asks about both. Stores or QA REQUESTS sampling; QC PERFORMS it
 * and, in doing so, raises the order that carries the batch through the same
 * spine a patient sample uses — accessioning, result entry, competency
 * enforcement, the analyser QC gate, e-signatures, the audit chain. None of
 * that needed changing: only the subject of the order differs.
 */
@Injectable()
export class SamplingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accession: AccessionService,
    private readonly specs: SpecificationsService,
  ) {}

  async listRequests(status?: string) {
    const rows = await this.prisma.tx.samplingRequest.findMany({
      where: status ? { status: status as never } : {},
      orderBy: [{ status: 'asc' }, { requestedAt: 'asc' }],
      take: 200,
      include: {
        batch: {
          include: { material: { select: { code: true, name: true, type: true, unit: true } } },
        },
      },
    });

    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      requestNumber: r.requestNumber,
      reason: r.reason,
      status: r.status,
      note: r.note,
      requestedAt: r.requestedAt.toISOString(),
      /// A quarantined batch is money standing still, so the queue is aged.
      waitingHours: Math.round((now - r.requestedAt.getTime()) / 3_600_000),
      sampledAt: r.sampledAt?.toISOString() ?? null,
      orderId: r.orderId,
      batch: {
        id: r.batch.id,
        batchNumber: r.batch.batchNumber,
        status: r.batch.status,
        quantity: r.batch.quantityAvailable.toNumber(),
        unit: r.batch.unit,
        containerCount: r.batch.containerCount,
        location: r.batch.location,
        material: r.batch.material,
      },
    }));
  }

  /** Stores or QA asks QC to sample a batch. */
  async request(input: { batchId: string; reason: string; note?: string }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const batch = await tx.materialBatch.findUnique({
      where: { id: input.batchId },
      include: { material: { select: { id: true, code: true, name: true } } },
    });
    if (!batch) throw new NotFoundException('Batch not found');

    if (batch.status === 'REJECTED' || batch.status === 'CONSUMED') {
      throw new BadRequestException(
        `Batch ${batch.batchNumber} is ${batch.status.toLowerCase()}. There is nothing left to test.`,
      );
    }

    const open = await tx.samplingRequest.findFirst({
      where: { batchId: input.batchId, status: 'PENDING' },
    });
    if (open) {
      throw new BadRequestException(
        `Sampling request ${open.requestNumber} is already pending for this batch. ` +
          `A second request would send QC to draw the same material twice.`,
      );
    }

    // Testing against nothing is worse than not testing: results would be
    // recorded with no criteria to judge them by, and the batch would look
    // tested. Refuse at the request, which is the earliest honest point.
    const spec = await this.specs.inForce(batch.materialId);
    if (!spec) {
      throw new BadRequestException(
        `No approved specification is in force for ${batch.material.name}. QC would have ` +
          `nothing to test against — have QA approve a specification first.`,
      );
    }

    const count = await tx.samplingRequest.count();
    const requestNumber = `SR${new Date().toISOString().slice(2, 10).replace(/-/g, '')}${String(
      count + 1,
    ).padStart(4, '0')}`;

    const req = await tx.samplingRequest.create({
      data: {
        tenantId: ctx.tenantId!,
        batchId: input.batchId,
        requestNumber,
        reason: input.reason as never,
        note: input.note?.trim() || null,
        requestedBy: ctx.userId,
      },
    });

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'SamplingRequest',
      entityId: req.id,
      after: {
        requestNumber,
        material: batch.material.code,
        batchNumber: batch.batchNumber,
        reason: input.reason,
        specification: `${spec.code} v${spec.version}`,
        note: input.note?.trim() ?? null,
      },
    });

    return {
      id: req.id,
      requestNumber,
      batchNumber: batch.batchNumber,
      material: batch.material.name,
      specification: `${spec.code} v${spec.version}`,
      criteriaCount: spec.limits.length,
    };
  }

  /**
   * QC draws the sample and books the tests.
   *
   * This is where a batch enters the analytical spine: an order whose subject is
   * the batch, a sample with an accession number, and one test per specification
   * criterion that names a test. From here the bench screens, competency checks
   * and QC gate behave exactly as they do for a patient sample.
   */
  async perform(
    requestId: string,
    input: { labId: string; containersSampled?: number; quantitySampled?: number; note?: string },
  ) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const req = await tx.samplingRequest.findUnique({
      where: { id: requestId },
      include: { batch: { include: { material: true } } },
    });
    if (!req) throw new NotFoundException('Sampling request not found');
    if (req.status !== 'PENDING') {
      throw new BadRequestException(
        `This request is already ${req.status.toLowerCase()}.`,
      );
    }

    const lab = await tx.lab.findUnique({ where: { id: input.labId } });
    if (!lab) throw new NotFoundException('Site not found');

    const spec = await this.specs.inForce(req.batch.materialId);
    if (!spec) {
      throw new BadRequestException(
        `No approved specification is in force for ${req.batch.material.name}.`,
      );
    }

    const testIds = [
      ...new Set(spec.limits.map((l) => l.testDefinitionId).filter((x): x is string => !!x)),
    ];
    if (testIds.length === 0) {
      throw new BadRequestException(
        `Specification ${spec.code} v${spec.version} names no tests, so there is nothing for ` +
          `QC to book. Attach a test to each criterion.`,
      );
    }

    const tests = await tx.testDefinition.findMany({ where: { id: { in: testIds } } });

    const now = new Date();
    const orderNumber = await this.accession.nextOrderNumber(tx, ctx.tenantId!, lab.id, now);
    const accessionNumber = await this.accession.nextSampleAccession(
      tx,
      ctx.tenantId!,
      lab.id,
      lab.code,
      now,
    );

    const order = await tx.labOrder.create({
      data: {
        tenantId: ctx.tenantId!,
        labId: lab.id,
        orderNumber,
        // The polymorphic subject: a batch, not a patient. The CHECK constraint
        // on lab_order enforces exactly one of the two.
        batchId: req.batchId,
        patientId: null,
        priority: 'ROUTINE',
        clinicalNotes:
          `Release testing against ${spec.code} v${spec.version}` +
          (input.note ? ` — ${input.note.trim()}` : ''),
        createdBy: ctx.userId,
        items: {
          create: tests.map((t) => ({
            tenantId: ctx.tenantId!,
            testDefinitionId: t.id,
            quantity: 1,
            unitPrice: new Prisma.Decimal(0),
            discountPct: new Prisma.Decimal(0),
            netAmount: new Prisma.Decimal(0),
          })),
        },
        samples: {
          create: {
            tenantId: ctx.tenantId!,
            labId: lab.id,
            accessionNumber,
            patientId: null,
            // QC drew it themselves, so it is collected and received at once —
            // there is no phlebotomy step and no transit to account for.
            status: 'IN_PROGRESS',
            collectedAt: now,
            collectedBy: ctx.userId,
            collectionSite: req.batch.location,
            receivedAt: now,
            receivedBy: ctx.userId,
            createdBy: ctx.userId,
            tests: {
              create: tests.map((t) => ({
                tenantId: ctx.tenantId!,
                testDefinitionId: t.id,
                testVersion: t.version,
                // IN_PROGRESS, not PENDING: PENDING means "the specimen has not
                // physically arrived", and QC is holding it. Leaving the tests
                // pending while the sample said RECEIVED made the two disagree,
                // and result entry correctly refused a sample it was told had
                // not turned up.
                status: 'IN_PROGRESS' as const,
                startedAt: now,
              })),
            },
          },
        },
      },
      include: { samples: { include: { tests: true } } },
    });

    await tx.samplingRequest.update({
      where: { id: requestId },
      data: {
        status: 'SAMPLED',
        sampledBy: ctx.userId,
        sampledAt: now,
        orderId: order.id,
        containersSampled: input.containersSampled ?? null,
        quantitySampled:
          input.quantitySampled != null ? new Prisma.Decimal(input.quantitySampled) : null,
      },
    });

    // The batch moves out of quarantine into UNDER_TEST. It is still not
    // issuable — only QA approval does that — but the store now knows why it
    // cannot touch it.
    await tx.materialBatch.update({
      where: { id: req.batchId },
      data: { status: 'UNDER_TEST' },
    });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'SamplingRequest',
      entityId: requestId,
      after: {
        event: 'SAMPLED',
        requestNumber: req.requestNumber,
        material: req.batch.material.code,
        batchNumber: req.batch.batchNumber,
        orderNumber,
        accessionNumber,
        specification: `${spec.code} v${spec.version}`,
        testsBooked: tests.map((t) => t.code),
        containersSampled: input.containersSampled ?? null,
        quantitySampled: input.quantitySampled ?? null,
        batchStatus: 'UNDER_TEST',
      },
    });

    return {
      requestId,
      orderId: order.id,
      orderNumber,
      accessionNumber,
      sampleId: order.samples[0]!.id,
      batchNumber: req.batch.batchNumber,
      material: req.batch.material.name,
      specification: `${spec.code} v${spec.version}`,
      tests: tests.map((t) => ({ code: t.code, name: t.name })),
      batchStatus: 'UNDER_TEST',
    };
  }

  async cancel(requestId: string, reason: string) {
    const tx = this.prisma.tx;
    const req = await tx.samplingRequest.findUnique({
      where: { id: requestId },
      include: { batch: { select: { batchNumber: true } } },
    });
    if (!req) throw new NotFoundException('Sampling request not found');
    if (req.status !== 'PENDING') {
      throw new BadRequestException(
        `This request is ${req.status.toLowerCase()} and can no longer be cancelled.`,
      );
    }

    await tx.samplingRequest.update({
      where: { id: requestId },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason },
    });

    await this.audit.record(tx, {
      action: 'CANCEL',
      entityType: 'SamplingRequest',
      entityId: requestId,
      reason,
      before: { status: 'PENDING' },
      after: { status: 'CANCELLED', requestNumber: req.requestNumber, batch: req.batch.batchNumber },
    });

    return { requestId, requestNumber: req.requestNumber, status: 'CANCELLED' };
  }
}
