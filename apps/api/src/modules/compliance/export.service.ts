import { Injectable, ForbiddenException } from '@nestjs/common';
import { PERMISSIONS } from '@labsetu/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * CSV export.
 *
 * Two rules, both non-obvious:
 *
 *   1. Bulk export of clinical data is a SECURITY EVENT, not a convenience.
 *      Every export is recorded with the row count and the filters used —
 *      "who took the data, and how much" is the question after an incident.
 *
 *   2. Patient identifiers are included only if the caller holds
 *      patient:read_pii. Otherwise the export carries the lab-assigned patient
 *      code alone. An export is the easiest way for PHI to leave a building.
 */
@Injectable()
export class ExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async worklist(filters: { status?: string; labId?: string }) {
    const rows = await this.prisma.tx.sampleTest.findMany({
      where: {
        ...(filters.status ? { status: filters.status as never } : {}),
        ...(filters.labId ? { sample: { labId: filters.labId } } : {}),
      },
      orderBy: [{ priority: 'desc' }, { dueAt: 'asc' }],
      take: 5000,
      include: {
        testDefinition: { select: { code: true, name: true, department: true } },
        device: { select: { code: true } },
        sample: {
          select: {
            accessionNumber: true,
            receivedAt: true,
            patient: { select: { patientCode: true, sex: true, ageYears: true } },
          },
        },
      },
    });

    const data = rows.map((t) => ({
      Accession: t.sample.accessionNumber,
      Patient: t.sample.patient?.patientCode ?? '',
      Sex: t.sample.patient?.sex ?? '',
      Age: t.sample.patient?.ageYears ?? '',
      TestCode: t.testDefinition.code,
      TestName: t.testDefinition.name,
      Department: t.testDefinition.department,
      Analyzer: t.device?.code ?? '',
      Status: t.status,
      Priority: t.priority,
      Received: iso(t.sample.receivedAt),
      Due: iso(t.dueAt),
      Overdue: t.dueAt && t.dueAt < new Date() ? 'YES' : '',
      Reruns: t.rerunCount,
    }));

    await this.record('worklist', data.length, filters);
    return toCsv(data);
  }

  async results(filters: { from?: Date; to?: Date }) {
    const canSeePii = RequestContextStore.require().permissions.has(
      PERMISSIONS.PATIENT_READ_PII,
    );

    const rows = await this.prisma.tx.result.findMany({
      where: {
        isCurrent: true,
        ...(filters.from || filters.to
          ? {
              enteredAt: {
                ...(filters.from ? { gte: filters.from } : {}),
                ...(filters.to ? { lte: filters.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { enteredAt: 'desc' },
      take: 10000,
      include: {
        analyte: { select: { code: true, name: true } },
        sampleTest: {
          select: {
            status: true,
            authorizedAt: true,
            testDefinition: { select: { code: true, department: true } },
            sample: {
              select: {
                accessionNumber: true,
                collectedAt: true,
                patient: { select: { patientCode: true, sex: true, ageYears: true } },
              },
            },
          },
        },
      },
    });

    const data = rows.map((r) => ({
      Accession: r.sampleTest.sample.accessionNumber,
      PatientCode: r.sampleTest.sample.patient?.patientCode ?? '',
      Sex: r.sampleTest.sample.patient?.sex ?? '',
      Age: r.sampleTest.sample.patient?.ageYears ?? '',
      Test: r.sampleTest.testDefinition.code,
      Department: r.sampleTest.testDefinition.department,
      Analyte: r.analyte.code,
      AnalyteName: r.analyte.name,
      Value: r.value ?? '',
      Unit: r.unit ?? '',
      Reference: r.refDisplay ?? '',
      Flag: r.flag,
      Critical: r.isCritical ? 'YES' : '',
      Source: r.source,
      Version: r.version,
      Collected: iso(r.sampleTest.sample.collectedAt),
      Authorized: iso(r.sampleTest.authorizedAt),
      Status: r.sampleTest.status,
    }));

    await this.record('results', data.length, { ...filters, piiIncluded: canSeePii });
    return toCsv(data);
  }

  async qc(filters: { from?: Date; to?: Date }) {
    const rows = await this.prisma.tx.qcResult.findMany({
      where:
        filters.from || filters.to
          ? {
              runAt: {
                ...(filters.from ? { gte: filters.from } : {}),
                ...(filters.to ? { lte: filters.to } : {}),
              },
            }
          : {},
      orderBy: { runAt: 'desc' },
      take: 10000,
      include: {
        analyte: { select: { code: true, name: true } },
        device: { select: { code: true } },
        qcLot: { select: { lotNumber: true, material: { select: { name: true, level: true } } } },
      },
    });

    const data = rows.map((q) => ({
      RunAt: iso(q.runAt),
      Analyte: q.analyte.code,
      AnalyteName: q.analyte.name,
      Material: q.qcLot.material.name,
      Level: q.qcLot.material.level,
      Lot: q.qcLot.lotNumber,
      Analyzer: q.device?.code ?? '',
      Value: q.value.toString(),
      SD: q.zScore?.toString() ?? '',
      Status: q.status,
      ViolatedRules: q.violatedRules.join(' '),
      ActionTaken: q.actionTaken ?? '',
      Resolved: q.acceptedAt ? 'YES' : '',
    }));

    await this.record('qc', data.length, filters);
    return toCsv(data);
  }

  async auditTrail(filters: { from?: Date; to?: Date; action?: string }) {
    const rows = await this.prisma.tx.auditLog.findMany({
      where: {
        ...(filters.action ? { action: filters.action } : {}),
        ...(filters.from || filters.to
          ? {
              occurredAt: {
                ...(filters.from ? { gte: filters.from } : {}),
                ...(filters.to ? { lte: filters.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { seq: 'desc' },
      take: 20000,
    });

    const data = rows.map((a) => ({
      Seq: a.seq.toString(),
      OccurredAt: iso(a.occurredAt),
      Actor: a.actorDisplay ?? '',
      Role: a.actorRole ?? '',
      IP: a.actorIp ?? '',
      Action: a.action,
      EntityType: a.entityType,
      EntityId: a.entityId ?? '',
      Reason: a.reason ?? '',
      ChangedFields: a.changedFields.join(' '),
      // The hashes are what make an exported trail verifiable outside the
      // system — without them a CSV is just a list of claims.
      Hash: a.hash,
      PrevHash: a.prevHash,
    }));

    await this.record('audit', data.length, filters);
    return toCsv(data);
  }

  async inventory() {
    const rows = await this.prisma.tx.inventoryLot.findMany({
      orderBy: [{ status: 'asc' }, { expiryDate: 'asc' }],
      take: 5000,
      include: { item: { select: { code: true, name: true, category: true, unit: true } } },
    });

    const now = new Date();
    const data = rows.map((l) => ({
      ItemCode: l.item.code,
      ItemName: l.item.name,
      Category: l.item.category,
      Lot: l.lotNumber,
      Expiry: l.expiryDate ? l.expiryDate.toISOString().slice(0, 10) : '',
      Expired: l.expiryDate && l.expiryDate <= now ? 'YES' : '',
      Received: l.quantityReceived.toString(),
      Remaining: l.quantityRemaining.toString(),
      Unit: l.item.unit,
      Status: l.status,
      Supplier: l.supplier ?? '',
      ReceivedAt: iso(l.receivedAt),
    }));

    await this.record('inventory', data.length, {});
    return toCsv(data);
  }

  /**
   * Records the export itself. Deliberately captures the row count: "someone
   * exported 12 rows" and "someone exported 40,000 rows" are different events.
   */
  private async record(dataset: string, rowCount: number, filters: unknown) {
    await this.audit.record(this.prisma.tx, {
      action: 'EXPORT',
      entityType: 'Export',
      entityId: null,
      after: { dataset, format: 'csv', rowCount, filters },
    });
  }
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : '');

/**
 * RFC 4180 CSV.
 *
 * The leading apostrophe on values starting with = + - @ is deliberate: without
 * it Excel executes them as formulas, which is a real and well-documented
 * injection route out of an exported spreadsheet.
 */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';

  const headers = Object.keys(rows[0]!);

  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ];

  // BOM so Excel opens UTF-8 correctly — without it Indian names with
  // diacritics render as mojibake, which looks like data corruption.
  return '﻿' + lines.join('\r\n');
}
