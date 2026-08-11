import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@labsetu/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * Environmental monitoring (Schedule M, EU GMP Annex 1).
 *
 * The design decision that matters is the two-tier limit. An ALERT is a trend
 * signal — nothing has failed, but the room is drifting and somebody should
 * look before it does. An ACTION is a breach requiring an investigation. A
 * system that collapses these into one threshold throws away the early warning,
 * which is the only part of the programme that prevents anything rather than
 * documenting it afterwards.
 *
 * The second decision: a verdict is computed at entry against the limits in
 * force at that moment, then stored. Recomputing on read would rewrite history
 * — a reading that was within limit when taken must not become an excursion
 * because somebody tightened the limit six months later.
 */
@Injectable()
export class EnvironmentalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createLocation(input: {
    code: string;
    name: string;
    grade: string;
    monitoringType: string;
    unit: string;
    alertLimit?: number;
    actionLimit?: number;
    roomRef?: string;
    frequencyDays?: number;
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    if (input.alertLimit != null && input.actionLimit != null) {
      if (input.alertLimit >= input.actionLimit) {
        throw new BadRequestException(
          'The alert limit must be below the action limit. An alert that fires at the same ' +
            'point as an action is not an early warning.',
        );
      }
    }
    if (input.alertLimit == null && input.actionLimit == null) {
      throw new BadRequestException(
        'A monitoring point with no limits records numbers nobody can act on.',
      );
    }

    const location = await tx.emLocation.create({
      data: {
        tenantId: ctx.tenantId!,
        code: input.code.trim(),
        name: input.name.trim(),
        grade: input.grade.trim(),
        monitoringType: input.monitoringType as never,
        unit: input.unit.trim(),
        alertLimit: input.alertLimit != null ? new Prisma.Decimal(input.alertLimit) : null,
        actionLimit: input.actionLimit != null ? new Prisma.Decimal(input.actionLimit) : null,
        roomRef: input.roomRef?.trim() || null,
        frequencyDays: input.frequencyDays ?? null,
      },
    });

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'EmLocation',
      entityId: location.id,
      after: {
        code: location.code,
        grade: location.grade,
        type: location.monitoringType,
        alertLimit: input.alertLimit ?? null,
        actionLimit: input.actionLimit ?? null,
      },
    });

    return location;
  }

  async listLocations() {
    const tx = this.prisma.tx;
    const now = Date.now();

    const rows = await tx.emLocation.findMany({
      where: { isActive: true },
      orderBy: [{ grade: 'asc' }, { code: 'asc' }],
      include: {
        readings: {
          orderBy: { sampledAt: 'desc' },
          take: 1,
          select: { sampledAt: true, value: true, verdict: true },
        },
      },
    });

    return rows.map((l) => {
      const last = l.readings[0] ?? null;
      const daysSince = last
        ? Math.floor((now - last.sampledAt.getTime()) / 864e5)
        : null;

      return {
        id: l.id,
        code: l.code,
        name: l.name,
        grade: l.grade,
        monitoringType: l.monitoringType,
        unit: l.unit,
        alertLimit: l.alertLimit?.toNumber() ?? null,
        actionLimit: l.actionLimit?.toNumber() ?? null,
        roomRef: l.roomRef,
        frequencyDays: l.frequencyDays,
        lastSampledAt: last?.sampledAt.toISOString() ?? null,
        lastValue: last?.value.toNumber() ?? null,
        lastVerdict: last?.verdict ?? null,
        daysSinceLastReading: daysSince,
        /// A point that has fallen behind its own frequency. The programme
        /// drifting is itself a finding, separate from any single result.
        isOverdue:
          l.frequencyDays != null && (daysSince == null || daysSince > l.frequencyDays),
      };
    });
  }

  /**
   * Records a reading and classifies it.
   *
   * An ACTION breach raises a deviation automatically, in the same transaction.
   * Leaving that to a person is how an excursion ends up recorded in the EM log
   * and nowhere else — and the EM log is not where anybody looks when a batch is
   * queried six months later.
   */
  async recordReading(input: {
    locationId: string;
    value: number;
    sampledAt: Date;
    shift?: string;
    note?: string;
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const location = await tx.emLocation.findUnique({ where: { id: input.locationId } });
    if (!location) throw new NotFoundException('Monitoring location not found');
    if (!location.isActive) {
      throw new BadRequestException(`${location.code} is no longer an active monitoring point.`);
    }
    if (input.sampledAt > new Date()) {
      throw new BadRequestException('A reading cannot be taken in the future.');
    }

    const action = location.actionLimit?.toNumber() ?? null;
    const alert = location.alertLimit?.toNumber() ?? null;

    const verdict: 'IN_LIMIT' | 'ALERT' | 'ACTION' =
      action != null && input.value > action
        ? 'ACTION'
        : alert != null && input.value > alert
          ? 'ALERT'
          : 'IN_LIMIT';

    const reading = await tx.emReading.create({
      data: {
        tenantId: ctx.tenantId!,
        locationId: input.locationId,
        sampledAt: input.sampledAt,
        value: new Prisma.Decimal(input.value),
        unit: location.unit,
        verdict,
        shift: input.shift?.trim() || null,
        performedBy: ctx.userId!,
        note: input.note?.trim() || null,
      },
    });

    let deviationNumber: string | null = null;

    if (verdict === 'ACTION') {
      // Raised here rather than left to somebody's memory. An excursion that
      // lives only in the EM log is invisible to the person investigating a
      // batch, which is the one place it needs to be visible.
      const year = new Date().getFullYear() % 100;
      const stem = `DEV/${year}/`;
      const highest = await tx.deviation.findFirst({
        where: { deviationNumber: { startsWith: stem } },
        orderBy: { deviationNumber: 'desc' },
        select: { deviationNumber: true },
      });
      const next = highest ? Number(highest.deviationNumber.slice(stem.length)) + 1 : 1;
      deviationNumber = `${stem}${String(next).padStart(4, '0')}`;

      const deviation = await tx.deviation.create({
        data: {
          tenantId: ctx.tenantId!,
          deviationNumber,
          title: `Action limit exceeded at ${location.code} (${location.name})`,
          description:
            `Environmental monitoring at ${location.code} returned ${input.value} ${location.unit} ` +
            `against an action limit of ${action} ${location.unit}. ` +
            `Grade ${location.grade}, ${location.monitoringType.replace(/_/g, ' ').toLowerCase()}. ` +
            `Raised automatically when the reading was recorded. Identify which batches were ` +
            `exposed during the affected window as part of the impact assessment.`,
          category: 'ENVIRONMENTAL',
          occurredAt: input.sampledAt,
          detectedAt: new Date(),
          reportedBy: ctx.userId!,
        },
      });

      await tx.emReading.update({
        where: { id: reading.id },
        data: { deviationId: deviation.id },
      });

      await this.audit.record(tx, {
        action: 'DEVIATION_RAISED',
        entityType: 'Deviation',
        entityId: deviation.id,
        after: {
          deviationNumber,
          category: 'ENVIRONMENTAL',
          source: 'EM_ACTION_LIMIT',
          location: location.code,
          value: input.value,
          actionLimit: action,
        },
        reason: `Action limit exceeded at ${location.code}`,
      });
    }

    await this.audit.record(tx, {
      action: 'EM_READING_RECORDED',
      entityType: 'EmReading',
      entityId: reading.id,
      after: {
        location: location.code,
        grade: location.grade,
        value: input.value,
        unit: location.unit,
        verdict,
        alertLimit: alert,
        actionLimit: action,
        deviationNumber,
      },
      reason: input.note?.trim(),
    });

    return {
      id: reading.id,
      location: location.code,
      value: input.value,
      unit: location.unit,
      verdict,
      alertLimit: alert,
      actionLimit: action,
      sampledAt: reading.sampledAt.toISOString(),
      deviationNumber,
    };
  }

  async listReadings(params: { locationId?: string; verdict?: string; days?: number } = {}) {
    const tx = this.prisma.tx;
    const since = new Date(Date.now() - (params.days ?? 90) * 864e5);

    const rows = await tx.emReading.findMany({
      where: {
        sampledAt: { gte: since },
        ...(params.locationId ? { locationId: params.locationId } : {}),
        ...(params.verdict ? { verdict: params.verdict as never } : {}),
      },
      orderBy: { sampledAt: 'desc' },
      take: 500,
      include: {
        location: { select: { code: true, name: true, grade: true, monitoringType: true } },
      },
    });

    return rows.map((r) => ({
      id: r.id,
      sampledAt: r.sampledAt.toISOString(),
      value: r.value.toNumber(),
      unit: r.unit,
      verdict: r.verdict,
      shift: r.shift,
      note: r.note,
      deviationId: r.deviationId,
      location: {
        code: r.location.code,
        name: r.location.name,
        grade: r.location.grade,
        type: r.location.monitoringType,
      },
    }));
  }

  /**
   * The trend view an inspector asks for: excursion rate by grade, over a
   * window. A single ACTION is a deviation; a rising ALERT rate across a grade
   * is the thing that predicts one, and no single reading shows it.
   */
  async summary(days = 90) {
    const tx = this.prisma.tx;
    const since = new Date(Date.now() - days * 864e5);

    const rows = await tx.emReading.findMany({
      where: { sampledAt: { gte: since } },
      select: { verdict: true, location: { select: { grade: true, code: true } } },
    });

    const byGrade = new Map<string, { total: number; alert: number; action: number }>();
    for (const r of rows) {
      const g = r.location.grade;
      const bucket = byGrade.get(g) ?? { total: 0, alert: 0, action: 0 };
      bucket.total++;
      if (r.verdict === 'ALERT') bucket.alert++;
      if (r.verdict === 'ACTION') bucket.action++;
      byGrade.set(g, bucket);
    }

    return {
      windowDays: days,
      totalReadings: rows.length,
      alerts: rows.filter((r) => r.verdict === 'ALERT').length,
      actions: rows.filter((r) => r.verdict === 'ACTION').length,
      byGrade: [...byGrade.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([grade, b]) => ({
          grade,
          readings: b.total,
          alerts: b.alert,
          actions: b.action,
          excursionRatePct: b.total > 0 ? Number((((b.alert + b.action) / b.total) * 100).toFixed(1)) : 0,
        })),
    };
  }
}
