import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';

/**
 * Product Quality Review (Schedule M; the EU calls it a PQR, the FDA an APR).
 *
 * Unlike everything else in this system, this is a REPORT rather than a
 * register. Nothing is entered here — it assembles what the other modules
 * recorded across a period and presents it per product, which is the only view
 * in which trends are visible.
 *
 * Computed on demand rather than stored. A PQR snapshotted at generation goes
 * stale the moment a deviation from the period is closed, and the commonest
 * complaint about the exercise is that it takes six weeks to compile and is out
 * of date on arrival. Reading live means the reviewer's judgement is the only
 * thing that has to be written down.
 *
 * What is deliberately NOT here: a verdict. The regulation asks the
 * manufacturer to review and conclude, and a system that concluded on their
 * behalf would be inviting somebody to sign a page they had not read.
 */
@Injectable()
export class PqrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async generate(materialId: string, from: Date, to: Date) {
    const tx = this.prisma.tx;

    const material = await tx.material.findUnique({ where: { id: materialId } });
    if (!material) throw new NotFoundException('Material not found');

    const window = { gte: from, lte: to };

    // ---------------------------------------------------------------- batches
    const batches = await tx.materialBatch.findMany({
      // createdAt is when the batch was booked in, which is the receipt date
      // for review purposes. The GRN carries its own receivedAt, but a batch
      // can exist without one and a review must not silently drop those.
      where: { materialId, createdAt: window },
      include: {
        dispositions: { orderBy: { decidedAt: 'desc' }, take: 1 },
        goodsReceipt: { select: { supplierName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const batchIds = batches.map((b) => b.id);

    const dispositionCounts = { APPROVED: 0, REJECTED: 0, APPROVED_WITH_DEVIATION: 0, PENDING: 0 };
    for (const b of batches) {
      const decision = b.dispositions[0]?.decision;
      if (decision === 'APPROVED') dispositionCounts.APPROVED++;
      else if (decision === 'REJECTED') dispositionCounts.REJECTED++;
      else if (decision === 'APPROVED_WITH_DEVIATION') dispositionCounts.APPROVED_WITH_DEVIATION++;
      else dispositionCounts.PENDING++;
    }

    // ------------------------------------------------------------ suppliers
    // Named because a rejection rate concentrated in one supplier is the single
    // most actionable thing a PQR surfaces, and it is invisible batch by batch.
    const bySupplier = new Map<string, { received: number; rejected: number }>();
    for (const b of batches) {
      const name = b.goodsReceipt?.supplierName ?? 'Unknown';
      const bucket = bySupplier.get(name) ?? { received: 0, rejected: 0 };
      bucket.received++;
      if (b.dispositions[0]?.decision === 'REJECTED') bucket.rejected++;
      bySupplier.set(name, bucket);
    }

    // ------------------------------------------------------------------- OOS
    const oos = await tx.oosInvestigation.findMany({
      where: { batchId: { in: batchIds } },
      select: {
        investigationNumber: true,
        analyteCode: true,
        observedValue: true,
        status: true,
        conclusion: true,
        openedAt: true,
      },
      orderBy: { openedAt: 'asc' },
    });

    // ------------------------------------------------------------ deviations
    const deviations = await tx.deviation.findMany({
      where: { OR: [{ batchId: { in: batchIds } }, { occurredAt: window }] },
      select: {
        deviationNumber: true,
        title: true,
        category: true,
        severity: true,
        status: true,
        productImpact: true,
        occurredAt: true,
        batchId: true,
      },
      orderBy: { occurredAt: 'asc' },
    });

    // ------------------------------------------------------------------ CAPA
    const capas = await tx.capaAction.findMany({
      where: { createdAt: window },
      select: {
        capaNumber: true,
        title: true,
        status: true,
        dueAt: true,
        effectivenessVerdict: true,
      },
      orderBy: { dueAt: 'asc' },
    });

    // -------------------------------------------------------------- changes
    const changes = await tx.changeControl.findMany({
      where: { requestedAt: window },
      select: {
        changeNumber: true,
        title: true,
        changeType: true,
        classification: true,
        status: true,
        requestedAt: true,
      },
      orderBy: { requestedAt: 'asc' },
    });

    // ------------------------------------------------------------- stability
    const stability = await tx.stabilityStudy.findMany({
      where: { batchId: { in: batchIds } },
      include: {
        protocol: { select: { code: true, storageCondition: true } },
        pulls: { select: { status: true } },
      },
    });

    // --------------------------------------------------------- test results
    // Trend per analyte across the period. The number a reviewer looks for is
    // not the mean, it is whether the spread has moved.
    const results = await tx.result.findMany({
      where: {
        isCurrent: true,
        numericValue: { not: null },
        // A sample reaches its batch through the order: LabOrder carries either
        // a patientId or a batchId, never both, enforced by a CHECK constraint.
        sampleTest: { sample: { order: { batchId: { in: batchIds } } } },
      },
      select: {
        numericValue: true,
        analyte: { select: { code: true, name: true } },
        unit: true,
      },
    });

    const byAnalyte = new Map<string, { name: string; unit: string | null; values: number[] }>();
    for (const r of results) {
      const key = r.analyte.code;
      const bucket = byAnalyte.get(key) ?? { name: r.analyte.name, unit: r.unit, values: [] };
      bucket.values.push(Number(r.numericValue));
      byAnalyte.set(key, bucket);
    }

    // Analytes with a single result are reported too, with sd and rsd null.
    // Omitting them would read as "not tested" when the truth is "tested once,
    // which is not yet a trend".
    const trends = [...byAnalyte.entries()]
      .map(([code, b]) => {
        const n = b.values.length;
        const mean = b.values.reduce((s, v) => s + v, 0) / n;
        const sd =
          n < 2 ? null : Math.sqrt(b.values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
        return {
          analyte: code,
          name: b.name,
          unit: b.unit,
          n,
          mean: Number(mean.toFixed(3)),
          sd: sd === null ? null : Number(sd.toFixed(4)),
          min: Number(Math.min(...b.values).toFixed(3)),
          max: Number(Math.max(...b.values).toFixed(3)),
          /// Relative standard deviation is the number that shows drift when a
          /// mean sitting comfortably mid-specification hides it.
          rsdPct: sd !== null && mean !== 0 ? Number(((sd / mean) * 100).toFixed(2)) : null,
        };
      })
      .sort((a, b) => a.analyte.localeCompare(b.analyte));

    await this.audit.record(tx, {
      action: 'PQR_GENERATED',
      entityType: 'Material',
      entityId: materialId,
      after: {
        material: material.code,
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        batches: batches.length,
        rejected: dispositionCounts.REJECTED,
        oos: oos.length,
        deviations: deviations.length,
      },
    });

    return {
      material: {
        code: material.code,
        name: material.name,
        type: material.type,
        pharmacopoeia: material.pharmacopoeia,
      },
      period: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      generatedAt: new Date().toISOString(),

      batches: {
        total: batches.length,
        ...dispositionCounts,
        rejectionRatePct:
          batches.length > 0
            ? Number(((dispositionCounts.REJECTED / batches.length) * 100).toFixed(1))
            : 0,
        list: batches.map((b) => ({
          batchNumber: b.batchNumber,
          receivedAt: b.createdAt.toISOString().slice(0, 10),
          supplier: b.goodsReceipt?.supplierName ?? null,
          status: b.status,
          disposition: b.dispositions[0]?.decision ?? null,
        })),
      },

      suppliers: [...bySupplier.entries()]
        .map(([name, b]) => ({
          name,
          received: b.received,
          rejected: b.rejected,
          rejectionRatePct: Number(((b.rejected / b.received) * 100).toFixed(1)),
        }))
        .sort((a, b) => b.rejectionRatePct - a.rejectionRatePct),

      oos: {
        total: oos.length,
        open: oos.filter((o) => o.status !== 'CLOSED').length,
        list: oos.map((o) => ({
          number: o.investigationNumber,
          analyte: o.analyteCode,
          observed: o.observedValue,
          status: o.status,
          conclusion: o.conclusion,
          openedAt: o.openedAt.toISOString().slice(0, 10),
        })),
      },

      deviations: {
        total: deviations.length,
        open: deviations.filter((d) => d.status !== 'CLOSED' && d.status !== 'CANCELLED').length,
        critical: deviations.filter((d) => d.severity === 'CRITICAL').length,
        withProductImpact: deviations.filter(
          (d) => d.productImpact === 'CONFIRMED' || d.productImpact === 'POTENTIAL',
        ).length,
        list: deviations.map((d) => ({
          number: d.deviationNumber,
          title: d.title,
          category: d.category,
          severity: d.severity,
          status: d.status,
          productImpact: d.productImpact,
          occurredAt: d.occurredAt.toISOString().slice(0, 10),
        })),
      },

      capa: {
        total: capas.length,
        open: capas.filter((c) => c.status !== 'VERIFIED' && c.status !== 'CANCELLED').length,
        overdue: capas.filter(
          (c) =>
            c.status !== 'VERIFIED' && c.status !== 'CANCELLED' && c.dueAt.getTime() < Date.now(),
        ).length,
        ineffective: capas.filter((c) => c.effectivenessVerdict === 'NOT_EFFECTIVE').length,
        list: capas.map((c) => ({
          number: c.capaNumber,
          title: c.title,
          status: c.status,
          dueAt: c.dueAt.toISOString().slice(0, 10),
          effectiveness: c.effectivenessVerdict,
        })),
      },

      changes: {
        total: changes.length,
        list: changes.map((c) => ({
          number: c.changeNumber,
          title: c.title,
          type: c.changeType,
          classification: c.classification,
          status: c.status,
          requestedAt: c.requestedAt.toISOString().slice(0, 10),
        })),
      },

      stability: stability.map((s) => ({
        studyNumber: s.studyNumber,
        protocol: s.protocol.code,
        condition: s.protocol.storageCondition,
        status: s.status,
        pullsComplete: s.pulls.filter((p) => p.status === 'COMPLETE').length,
        pullsTotal: s.pulls.length,
        pullsMissed: s.pulls.filter((p) => p.status === 'MISSED').length,
      })),

      trends,

      /**
       * Stated rather than computed. The regulation asks the manufacturer to
       * review and conclude; a system that wrote the conclusion would be
       * inviting somebody to sign a page they had not read.
       */
      conclusion: null,
    };
  }
}
