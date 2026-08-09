import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * Opens an out-of-specification investigation the moment a result breaches a
 * limit.
 *
 * Automatic and not optional, which is the whole point. An OOS that someone has
 * to remember to raise is an OOS that gets raised when it is convenient — and
 * the gap between the failing result and the paperwork is exactly what an
 * inspector looks for. Here the investigation exists before the analyst has
 * finished saving, and its existence blocks the batch from release.
 *
 * Deliberately a separate, narrow service rather than a method on QaService:
 * ResultsService needs to call it, QaService depends on AuthService, and a
 * cycle between them would be resolved with a forwardRef nobody can reason
 * about later.
 */
@Injectable()
export class OosDetectorService {
  private readonly logger = new Logger(OosDetectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Called after results are written for a sample test.
   *
   * Returns quietly for diagnostics work — a patient sample has no batch and no
   * specification, and the reference-range flagging already handled it.
   */
  async evaluate(sampleTestId: string): Promise<{ opened: string[] }> {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;
    const opened: string[] = [];

    const test = await tx.sampleTest.findUnique({
      where: { id: sampleTestId },
      select: {
        id: true,
        sample: {
          select: {
            accessionNumber: true,
            order: { select: { batchId: true, orderedAt: true } },
          },
        },
        results: {
          where: { isCurrent: true },
          select: {
            id: true,
            value: true,
            numericValue: true,
            analyteId: true,
            analyte: { select: { code: true, name: true, defaultUnit: true } },
          },
        },
      },
    });

    const batchId = test?.sample.order.batchId;
    if (!test || !batchId) return { opened };

    const batch = await tx.materialBatch.findUnique({
      where: { id: batchId },
      select: { id: true, batchNumber: true, materialId: true, material: { select: { code: true } } },
    });
    if (!batch) return { opened };

    // The specification in force when the sample was ordered, not today's —
    // a batch is judged by the criteria that applied when it was tested.
    const at = test.sample.order.orderedAt;
    const spec = await tx.specification.findFirst({
      where: {
        materialId: batch.materialId,
        status: { in: ['APPROVED', 'SUPERSEDED'] },
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: { effectiveFrom: 'desc' },
      include: { limits: true },
    });
    if (!spec) {
      this.logger.warn(
        `No specification in force for material ${batch.material.code} at ${at.toISOString()}; ` +
          `results on batch ${batch.batchNumber} cannot be assessed`,
      );
      return { opened };
    }

    const limitByAnalyte = new Map(spec.limits.map((l) => [l.analyteId, l]));

    for (const result of test.results) {
      const limit = limitByAnalyte.get(result.analyteId);
      if (!limit) continue;

      const min = limit.minValue?.toNumber() ?? null;
      const max = limit.maxValue?.toNumber() ?? null;
      // Only numeric criteria are judged automatically. A textual criterion is
      // assessed by the analyst; claiming to compare prose would be worse than
      // leaving it to a person.
      if (min == null && max == null) continue;
      if (result.numericValue == null) continue;

      const value = result.numericValue.toNumber();
      const breached = (min != null && value < min) || (max != null && value > max);
      if (!breached) continue;

      // One open investigation per result. A re-save of the same failing value
      // must not stack duplicates on the queue.
      const existing = await tx.oosInvestigation.findFirst({
        where: { resultId: result.id, status: { not: 'CLOSED' } },
      });
      if (existing) continue;

      // OOS/YY/NNNN — the house format Indian plants use for quality records,
      // and the format every investigation already in the register carries.
      // A system-generated number that looks different from the ones in the
      // binder is the first thing an auditor asks about.
      // Continue the series rather than counting rows. Numbering in a real
      // register is sparse — investigations get raised in other systems, or a
      // number is reserved and never used — so counting would eventually hand
      // out a number that already exists, and the unique constraint would turn
      // that into a failed result entry at the bench.
      const year = new Date().getFullYear() % 100;
      const prefix = `OOS/${year}/`;
      const highest = await tx.oosInvestigation.findFirst({
        where: { investigationNumber: { startsWith: prefix } },
        orderBy: { investigationNumber: 'desc' },
        select: { investigationNumber: true },
      });
      const next = highest ? Number(highest.investigationNumber.slice(prefix.length)) + 1 : 1;
      const investigationNumber = `${prefix}${String(next).padStart(4, '0')}`;

      const unit = limit.unit ?? result.analyte.defaultUnit ?? '';
      const limitText =
        min != null && max != null
          ? `${min} to ${max}${unit ? ` ${unit}` : ''}`
          : min != null
            ? `Not less than ${min}${unit ? ` ${unit}` : ''}`
            : `Not more than ${max}${unit ? ` ${unit}` : ''}`;

      const inv = await tx.oosInvestigation.create({
        data: {
          tenantId: ctx.tenantId!,
          batchId,
          resultId: result.id,
          investigationNumber,
          observedValue: `${result.value ?? value}${unit ? ` ${unit}` : ''}`,
          limitBreached: limitText,
          analyteCode: result.analyte.code,
          phase: 'PHASE_I',
          status: 'OPEN',
          openedBy: ctx.userId,
        },
      });

      opened.push(investigationNumber);

      await this.audit.record(tx, {
        action: 'CREATE',
        entityType: 'OosInvestigation',
        entityId: inv.id,
        after: {
          event: 'OOS_OPENED_AUTOMATICALLY',
          investigationNumber,
          material: batch.material.code,
          batchNumber: batch.batchNumber,
          accessionNumber: test.sample.accessionNumber,
          analyte: result.analyte.code,
          observedValue: inv.observedValue,
          limitBreached: limitText,
          isCritical: limit.isCritical,
          specification: `${spec.code} v${spec.version}`,
        },
      });
    }

    if (opened.length > 0) {
      // The batch cannot be released while this is open; say so on the batch
      // record rather than only in the investigation queue.
      await tx.materialBatch.update({
        where: { id: batchId },
        data: { status: 'UNDER_TEST' },
      });
    }

    return { opened };
  }
}
