import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@labsetu/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AccessionService } from '../workflow/accession.service';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * Stores: raw materials in, finished product out.
 *
 * The department that physically holds the material, and the one that must
 * never be able to decide the material is good. Everything a storekeeper does
 * here — receive, move, issue, destroy — is bounded by the batch status, and
 * the batch status is changed by QA, not by stores.
 *
 * The single most important rule in the whole module: material may only be
 * issued from an APPROVED batch. Everything else in a GMP store follows from
 * physically and logically segregating quarantined stock from released stock,
 * and this is where that is enforced rather than trusted.
 */
@Injectable()
export class StoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accession: AccessionService,
  ) {}

  // --- material master ------------------------------------------------------

  async listMaterials(type?: string) {
    const rows = await this.prisma.tx.material.findMany({
      where: { isActive: true, ...(type ? { type: type as never } : {}) },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
      include: {
        _count: { select: { batches: true, specifications: true } },
        batches: {
          where: { status: { in: ['QUARANTINE', 'UNDER_TEST', 'APPROVED', 'RETEST_DUE'] } },
          select: { status: true, quantityAvailable: true },
        },
      },
    });

    return rows.map((m) => {
      // Only APPROVED stock is usable. Reporting quarantined material as
      // "available" is how a factory ends up using something QA has not
      // released, so the two figures are never added together.
      const approved = m.batches
        .filter((b) => b.status === 'APPROVED')
        .reduce((s, b) => s + b.quantityAvailable.toNumber(), 0);
      const quarantined = m.batches
        .filter((b) => b.status === 'QUARANTINE' || b.status === 'UNDER_TEST')
        .reduce((s, b) => s + b.quantityAvailable.toNumber(), 0);

      return {
        id: m.id,
        code: m.code,
        name: m.name,
        type: m.type,
        unit: m.unit,
        manufacturer: m.manufacturer,
        pharmacopoeia: m.pharmacopoeia,
        storageCondition: m.storageCondition,
        retestPeriodDays: m.retestPeriodDays,
        handlingNotes: m.handlingNotes,
        batchCount: m._count.batches,
        specificationCount: m._count.specifications,
        approvedQuantity: Number(approved.toFixed(3)),
        quarantinedQuantity: Number(quarantined.toFixed(3)),
      };
    });
  }

  async createMaterial(input: {
    code: string;
    name: string;
    type: string;
    unit: string;
    manufacturer?: string;
    pharmacopoeia?: string;
    storageCondition?: string;
    retestPeriodDays?: number;
    handlingNotes?: string;
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;
    const code = input.code.trim().toUpperCase();

    const clash = await tx.material.findFirst({ where: { code } });
    if (clash) {
      throw new BadRequestException(
        `Material code ${code} is already used by "${clash.name}". Codes appear on every ` +
          `batch label and certificate, so they cannot be reused.`,
      );
    }

    const material = await tx.material.create({
      data: {
        tenantId: ctx.tenantId!,
        code,
        name: input.name.trim(),
        type: input.type as never,
        unit: input.unit.trim(),
        manufacturer: input.manufacturer?.trim() || null,
        pharmacopoeia: input.pharmacopoeia?.trim() || null,
        storageCondition: input.storageCondition?.trim() || null,
        retestPeriodDays: input.retestPeriodDays ?? null,
        handlingNotes: input.handlingNotes?.trim() || null,
      },
    });

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'Material',
      entityId: material.id,
      after: {
        code: material.code,
        name: material.name,
        type: material.type,
        pharmacopoeia: material.pharmacopoeia,
      },
    });

    return { id: material.id, code: material.code, name: material.name, type: material.type };
  }

  // --- goods receipt --------------------------------------------------------

  /**
   * Books a consignment in.
   *
   * Every batch lands in QUARANTINE and cannot be anywhere else — the status is
   * not a parameter. A receipt that let the storekeeper choose "approved" would
   * make the entire release chain optional, which is the failure this module
   * exists to prevent.
   */
  async receiveGoods(input: {
    supplierName: string;
    invoiceRef?: string;
    poReference?: string;
    supplierBatchRef?: string;
    receiptCheckNote?: string;
    labId: string;
    batches: {
      materialId: string;
      batchNumber: string;
      manufacturerLot?: string;
      quantity: number;
      unit?: string;
      containerCount?: number;
      manufacturedAt?: Date;
      expiryDate?: Date;
      location?: string;
    }[];
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    if (input.batches.length === 0) {
      throw new BadRequestException('A goods receipt needs at least one batch');
    }

    const lab = await tx.lab.findUnique({ where: { id: input.labId } });
    if (!lab) throw new NotFoundException('Site not found');

    const materialIds = [...new Set(input.batches.map((b) => b.materialId))];
    const materials = await tx.material.findMany({ where: { id: { in: materialIds } } });
    if (materials.length !== materialIds.length) {
      throw new BadRequestException('One or more materials do not exist');
    }
    const byId = new Map(materials.map((m) => [m.id, m]));

    const now = new Date();
    for (const b of input.batches) {
      const material = byId.get(b.materialId)!;
      if (b.expiryDate && b.expiryDate <= now) {
        throw new BadRequestException(
          `Batch ${b.batchNumber} of ${material.name} expired on ` +
            `${b.expiryDate.toISOString().slice(0, 10)}. Expired material cannot be received ` +
            `into stock — reject the consignment at the gate.`,
        );
      }
      const dupe = await tx.materialBatch.findFirst({
        where: { materialId: b.materialId, batchNumber: b.batchNumber.trim() },
      });
      if (dupe) {
        throw new BadRequestException(
          `Batch ${b.batchNumber} of ${material.name} is already on record. A batch number ` +
            `identifies material uniquely and appears on every recall notice.`,
        );
      }
    }

    const grnNumber = await this.accession.nextGrnNumber(tx, ctx.tenantId!, lab.id, now);

    const grn = await tx.goodsReceipt.create({
      data: {
        tenantId: ctx.tenantId!,
        grnNumber,
        supplierName: input.supplierName.trim(),
        supplierBatchRef: input.supplierBatchRef?.trim() || null,
        invoiceRef: input.invoiceRef?.trim() || null,
        poReference: input.poReference?.trim() || null,
        receivedBy: ctx.userId,
        receiptCheckNote: input.receiptCheckNote?.trim() || null,
        batches: {
          create: input.batches.map((b) => {
            const material = byId.get(b.materialId)!;
            // Retest date is derived from the material's own period where the
            // supplier has not given one. A batch with neither is flagged on
            // the stores screen rather than silently treated as forever-valid.
            //
            // Capped at expiry, because a retest date beyond it is a date that
            // can never arrive: the material is already unusable. A three-year
            // retest period on a consignment shipped with eighteen months of
            // shelf life left produced exactly that, and the stores screen then
            // showed a retest due a year after the batch had expired.
            const derived =
              material.retestPeriodDays && b.manufacturedAt
                ? new Date(b.manufacturedAt.getTime() + material.retestPeriodDays * 864e5)
                : null;
            const retestDate =
              derived && b.expiryDate && derived > b.expiryDate ? b.expiryDate : derived;

            return {
              tenantId: ctx.tenantId!,
              materialId: b.materialId,
              batchNumber: b.batchNumber.trim(),
              manufacturerLot: b.manufacturerLot?.trim() || null,
              quantityReceived: new Prisma.Decimal(b.quantity),
              quantityAvailable: new Prisma.Decimal(b.quantity),
              unit: b.unit?.trim() || material.unit,
              containerCount: b.containerCount ?? null,
              manufacturedAt: b.manufacturedAt ?? null,
              expiryDate: b.expiryDate ?? null,
              retestDate,
              // Not a parameter. Everything received is quarantined.
              status: 'QUARANTINE' as const,
              location: b.location?.trim() || 'QUARANTINE STORE',
              createdBy: ctx.userId,
            };
          }),
        },
      },
      include: { batches: { include: { material: { select: { code: true, name: true } } } } },
    });

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'GoodsReceipt',
      entityId: grn.id,
      after: {
        grnNumber,
        supplier: grn.supplierName,
        invoiceRef: grn.invoiceRef,
        batches: grn.batches.map((b) => ({
          material: b.material.code,
          batchNumber: b.batchNumber,
          quantity: b.quantityReceived.toNumber(),
          unit: b.unit,
          status: 'QUARANTINE',
        })),
      },
    });

    return {
      id: grn.id,
      grnNumber,
      supplier: grn.supplierName,
      batches: grn.batches.map((b) => ({
        id: b.id,
        material: b.material.name,
        batchNumber: b.batchNumber,
        quantity: b.quantityReceived.toNumber(),
        unit: b.unit,
        status: b.status,
      })),
      note: 'All batches are quarantined. QA release is required before issue.',
    };
  }

  // --- batches --------------------------------------------------------------

  async listBatches(q: { status?: string; materialId?: string; type?: string; search?: string }) {
    const now = new Date();
    const rows = await this.prisma.tx.materialBatch.findMany({
      where: {
        ...(q.status ? { status: q.status as never } : {}),
        ...(q.materialId ? { materialId: q.materialId } : {}),
        ...(q.type ? { material: { type: q.type as never } } : {}),
        ...(q.search
          ? {
              OR: [
                { batchNumber: { contains: q.search, mode: 'insensitive' } },
                { manufacturerLot: { contains: q.search, mode: 'insensitive' } },
                { material: { name: { contains: q.search, mode: 'insensitive' } } },
                { material: { code: { contains: q.search.toUpperCase() } } },
              ],
            }
          : {}),
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 200,
      include: {
        material: { select: { code: true, name: true, type: true, pharmacopoeia: true } },
        goodsReceipt: { select: { grnNumber: true, supplierName: true } },
        _count: { select: { samplingRequests: true, investigations: true } },
        investigations: { where: { status: { not: 'CLOSED' } }, select: { id: true } },
      },
    });

    return rows.map((b) => ({
      id: b.id,
      batchNumber: b.batchNumber,
      manufacturerLot: b.manufacturerLot,
      material: {
        code: b.material.code,
        name: b.material.name,
        type: b.material.type,
        pharmacopoeia: b.material.pharmacopoeia,
      },
      grnNumber: b.goodsReceipt?.grnNumber ?? null,
      supplier: b.goodsReceipt?.supplierName ?? null,
      quantityReceived: b.quantityReceived.toNumber(),
      quantityAvailable: b.quantityAvailable.toNumber(),
      unit: b.unit,
      containerCount: b.containerCount,
      status: b.status,
      location: b.location,
      manufacturedAt: b.manufacturedAt?.toISOString().slice(0, 10) ?? null,
      expiryDate: b.expiryDate?.toISOString().slice(0, 10) ?? null,
      retestDate: b.retestDate?.toISOString().slice(0, 10) ?? null,
      isExpired: !!b.expiryDate && b.expiryDate <= now,
      isRetestDue: !!b.retestDate && b.retestDate <= now,
      samplingRequests: b._count.samplingRequests,
      openInvestigations: b.investigations.length,
      /// The question the stores screen exists to answer.
      isIssuable: b.status === 'APPROVED' && (!b.expiryDate || b.expiryDate > now),
    }));
  }

  async getBatch(id: string) {
    const b = await this.prisma.tx.materialBatch.findUnique({
      where: { id },
      include: {
        material: true,
        goodsReceipt: true,
        samplingRequests: { orderBy: { requestedAt: 'desc' } },
        dispositions: { orderBy: { decidedAt: 'desc' } },
        investigations: { orderBy: { openedAt: 'desc' } },
        certificates: { orderBy: { issuedAt: 'desc' } },
        orders: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            orderedAt: true,
            samples: {
              select: {
                id: true,
                accessionNumber: true,
                status: true,
                tests: {
                  select: {
                    id: true,
                    status: true,
                    testDefinition: { select: { code: true, name: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!b) throw new NotFoundException('Batch not found');

    const now = new Date();
    const openInvestigations = b.investigations.filter((i) => i.status !== 'CLOSED');

    return {
      id: b.id,
      batchNumber: b.batchNumber,
      manufacturerLot: b.manufacturerLot,
      material: {
        id: b.material.id,
        code: b.material.code,
        name: b.material.name,
        type: b.material.type,
        unit: b.material.unit,
        pharmacopoeia: b.material.pharmacopoeia,
        storageCondition: b.material.storageCondition,
        handlingNotes: b.material.handlingNotes,
      },
      goodsReceipt: b.goodsReceipt
        ? {
            grnNumber: b.goodsReceipt.grnNumber,
            supplier: b.goodsReceipt.supplierName,
            invoiceRef: b.goodsReceipt.invoiceRef,
            poReference: b.goodsReceipt.poReference,
            receivedAt: b.goodsReceipt.receivedAt.toISOString(),
            receiptCheckNote: b.goodsReceipt.receiptCheckNote,
          }
        : null,
      quantityReceived: b.quantityReceived.toNumber(),
      quantityAvailable: b.quantityAvailable.toNumber(),
      unit: b.unit,
      containerCount: b.containerCount,
      status: b.status,
      location: b.location,
      manufacturedAt: b.manufacturedAt?.toISOString().slice(0, 10) ?? null,
      expiryDate: b.expiryDate?.toISOString().slice(0, 10) ?? null,
      retestDate: b.retestDate?.toISOString().slice(0, 10) ?? null,
      isExpired: !!b.expiryDate && b.expiryDate <= now,
      isRetestDue: !!b.retestDate && b.retestDate <= now,
      isIssuable: b.status === 'APPROVED' && (!b.expiryDate || b.expiryDate > now),
      /// Surfaced explicitly: QA cannot dispose while an investigation is open,
      /// and the screen should say so rather than let someone try.
      blockedByInvestigation: openInvestigations.length > 0,
      samplingRequests: b.samplingRequests.map((r) => ({
        id: r.id,
        requestNumber: r.requestNumber,
        reason: r.reason,
        status: r.status,
        note: r.note,
        requestedAt: r.requestedAt.toISOString(),
        sampledAt: r.sampledAt?.toISOString() ?? null,
        containersSampled: r.containersSampled,
        quantitySampled: r.quantitySampled?.toNumber() ?? null,
        orderId: r.orderId,
      })),
      orders: b.orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        orderedAt: o.orderedAt.toISOString(),
        samples: o.samples.map((s) => ({
          id: s.id,
          accessionNumber: s.accessionNumber,
          status: s.status,
          tests: s.tests.map((t) => ({
            id: t.id,
            code: t.testDefinition.code,
            name: t.testDefinition.name,
            status: t.status,
          })),
        })),
      })),
      dispositions: b.dispositions.map((d) => ({
        id: d.id,
        decision: d.decision,
        rationale: d.rationale,
        deviationRef: d.deviationRef,
        decidedAt: d.decidedAt.toISOString(),
      })),
      investigations: b.investigations.map((i) => ({
        id: i.id,
        investigationNumber: i.investigationNumber,
        analyteCode: i.analyteCode,
        observedValue: i.observedValue,
        limitBreached: i.limitBreached,
        phase: i.phase,
        status: i.status,
        conclusion: i.conclusion,
        openedAt: i.openedAt.toISOString(),
        closedAt: i.closedAt?.toISOString() ?? null,
      })),
      certificates: b.certificates.map((c) => ({
        id: c.id,
        coaNumber: c.coaNumber,
        version: c.version,
        issuedAt: c.issuedAt.toISOString(),
      })),
    };
  }

  /**
   * Issues material to production.
   *
   * The one place the APPROVED gate is load-bearing. Every other status is
   * refused with the reason, because "why can I not issue this" is the question
   * a storekeeper asks at 6am with a batch sheet in hand.
   */
  async issue(batchId: string, quantity: number, reference: string) {
    const tx = this.prisma.tx;

    const batch = await tx.materialBatch.findUnique({
      where: { id: batchId },
      include: { material: { select: { code: true, name: true } } },
    });
    if (!batch) throw new NotFoundException('Batch not found');

    const label = `${batch.material.name} batch ${batch.batchNumber}`;

    if (batch.status !== 'APPROVED') {
      const why: Record<string, string> = {
        QUARANTINE: 'it is quarantined and has not been sampled yet',
        UNDER_TEST: 'QC testing is still in progress',
        REJECTED: 'QA rejected it',
        RETEST_DUE: 'its retest date has passed and it must go back to QC',
        EXPIRED: 'it has expired',
        CONSUMED: 'it is already fully issued',
      };
      throw new BadRequestException(
        `${label} cannot be issued because ${why[batch.status] ?? 'it is not released'}. ` +
          `Only QA-approved material may leave the store.`,
      );
    }

    const now = new Date();
    if (batch.expiryDate && batch.expiryDate <= now) {
      throw new BadRequestException(
        `${label} expired on ${batch.expiryDate.toISOString().slice(0, 10)}. It was approved, ` +
          `but approval does not survive expiry.`,
      );
    }
    if (batch.retestDate && batch.retestDate <= now) {
      throw new BadRequestException(
        `${label} is past its retest date of ${batch.retestDate.toISOString().slice(0, 10)}. ` +
          `Raise a retest sampling request before issuing it.`,
      );
    }

    const qty = new Prisma.Decimal(quantity);
    if (qty.greaterThan(batch.quantityAvailable)) {
      throw new BadRequestException(
        `Only ${batch.quantityAvailable.toString()} ${batch.unit} of ${label} remains; ` +
          `${quantity} ${batch.unit} was requested.`,
      );
    }

    const remaining = batch.quantityAvailable.sub(qty);
    const updated = await tx.materialBatch.update({
      where: { id: batchId },
      data: {
        quantityAvailable: remaining,
        status: remaining.lessThanOrEqualTo(0) ? 'CONSUMED' : batch.status,
      },
    });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'MaterialBatch',
      entityId: batchId,
      reason: reference,
      before: { quantityAvailable: batch.quantityAvailable.toNumber(), status: batch.status },
      after: {
        event: 'ISSUED_TO_PRODUCTION',
        material: batch.material.code,
        batchNumber: batch.batchNumber,
        quantityIssued: quantity,
        unit: batch.unit,
        quantityAvailable: remaining.toNumber(),
        status: updated.status,
        reference,
      },
    });

    return {
      batchId,
      batchNumber: batch.batchNumber,
      issued: quantity,
      unit: batch.unit,
      remaining: remaining.toNumber(),
      status: updated.status,
    };
  }

  /** Moves a batch between physical locations. Status is untouched. */
  async move(batchId: string, location: string, reason: string) {
    const tx = this.prisma.tx;
    const batch = await tx.materialBatch.findUnique({
      where: { id: batchId },
      include: { material: { select: { code: true } } },
    });
    if (!batch) throw new NotFoundException('Batch not found');

    await tx.materialBatch.update({ where: { id: batchId }, data: { location: location.trim() } });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'MaterialBatch',
      entityId: batchId,
      reason,
      before: { location: batch.location },
      after: {
        event: 'RELOCATED',
        material: batch.material.code,
        batchNumber: batch.batchNumber,
        location: location.trim(),
        status: batch.status,
      },
    });

    return { batchId, location: location.trim(), status: batch.status };
  }

  /**
   * What needs attention in the store today.
   *
   * Expiry and retest are the two dates that turn approved stock into
   * unusable stock without anyone touching it, so they lead.
   */
  async alerts() {
    const tx = this.prisma.tx;
    const now = new Date();
    const soon = new Date(Date.now() + 30 * 864e5);

    const batches = await tx.materialBatch.findMany({
      where: { status: { notIn: ['CONSUMED', 'REJECTED'] } },
      include: { material: { select: { code: true, name: true, type: true } } },
    });

    const shape = (b: (typeof batches)[number]) => ({
      batchId: b.id,
      material: b.material.name,
      code: b.material.code,
      batchNumber: b.batchNumber,
      quantity: b.quantityAvailable.toNumber(),
      unit: b.unit,
      status: b.status,
      expiryDate: b.expiryDate?.toISOString().slice(0, 10) ?? null,
      retestDate: b.retestDate?.toISOString().slice(0, 10) ?? null,
    });

    const quarantined = batches.filter((b) => b.status === 'QUARANTINE');
    const underTest = batches.filter((b) => b.status === 'UNDER_TEST');

    return {
      expired: batches.filter((b) => b.expiryDate && b.expiryDate <= now).map(shape),
      expiringSoon: batches
        .filter((b) => b.expiryDate && b.expiryDate > now && b.expiryDate <= soon)
        .map(shape),
      retestDue: batches.filter((b) => b.retestDate && b.retestDate <= now).map(shape),
      awaitingSampling: quarantined.map(shape),
      underTest: underTest.map(shape),
      counts: {
        quarantined: quarantined.length,
        underTest: underTest.length,
        approved: batches.filter((b) => b.status === 'APPROVED').length,
        retestDue: batches.filter((b) => b.retestDate && b.retestDate <= now).length,
      },
    };
  }
}
