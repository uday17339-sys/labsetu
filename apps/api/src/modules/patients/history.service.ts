import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';

/**
 * Cumulative patient history.
 *
 * Clinically the most-requested view in any diagnostic lab: the same analyte
 * across time, side by side. A single haemoglobin of 9.1 means one thing; 9.1
 * following 13.2 and 11.4 over six weeks means something else entirely, and no
 * single-report view can show that.
 *
 * The data already existed — delta checking has always compared against previous
 * results internally. This exposes it.
 */
@Injectable()
export class PatientHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * A matrix of analyte × date for one patient.
   *
   * Only AUTHORIZED and REPORTED results are included. Showing an unverified
   * value next to a released one, in a view designed for clinical comparison,
   * would invite exactly the wrong conclusion.
   */
  async cumulative(patientId: string, opts: { analyteIds?: string[]; limit?: number } = {}) {
    const tx = this.prisma.tx;

    const patient = await tx.patient.findUnique({
      where: { id: patientId },
      select: { id: true, patientCode: true, sex: true, ageYears: true, erasedAt: true },
    });
    if (!patient) throw new NotFoundException('Patient not found');

    const results = await tx.result.findMany({
      where: {
        isCurrent: true,
        sampleTest: {
          sample: { patientId },
          status: { in: ['AUTHORIZED', 'REPORTED'] },
        },
        ...(opts.analyteIds?.length ? { analyteId: { in: opts.analyteIds } } : {}),
      },
      orderBy: { enteredAt: 'desc' },
      take: opts.limit ?? 500,
      include: {
        analyte: { select: { id: true, code: true, name: true, defaultUnit: true } },
        sampleTest: {
          select: {
            id: true,
            authorizedAt: true,
            testDefinition: { select: { code: true, name: true, department: true } },
            sample: { select: { accessionNumber: true, collectedAt: true } },
          },
        },
      },
    });

    // Reading a patient's clinical history is a PHI access — logged, like any
    // other read of identifiable data.
    await this.audit.record(tx, {
      action: 'READ_SENSITIVE',
      entityType: 'Patient',
      entityId: patientId,
      after: {
        patientCode: patient.patientCode,
        view: 'CUMULATIVE_HISTORY',
        resultCount: results.length,
      },
    });

    // Columns are the distinct collection dates, newest first — the direction a
    // clinician reads a trend.
    const columnMap = new Map<
      string,
      { key: string; accessionNumber: string; date: string; testCodes: Set<string> }
    >();

    for (const r of results) {
      const when =
        r.sampleTest.sample.collectedAt ?? r.sampleTest.authorizedAt ?? r.enteredAt;
      const key = r.sampleTest.sample.accessionNumber;
      if (!columnMap.has(key)) {
        columnMap.set(key, {
          key,
          accessionNumber: key,
          date: when.toISOString(),
          testCodes: new Set(),
        });
      }
      columnMap.get(key)!.testCodes.add(r.sampleTest.testDefinition.code);
    }

    const columns = [...columnMap.values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((c) => ({ ...c, testCodes: [...c.testCodes] }));

    // Rows are analytes, grouped by department so a reader sees a coherent panel
    // rather than an alphabetical jumble.
    const rowMap = new Map<
      string,
      {
        analyteId: string;
        code: string;
        name: string;
        unit: string | null;
        department: string;
        values: Record<string, { value: string | null; flag: string; isCritical: boolean }>;
      }
    >();

    for (const r of results) {
      if (!rowMap.has(r.analyteId)) {
        rowMap.set(r.analyteId, {
          analyteId: r.analyteId,
          code: r.analyte.code,
          name: r.analyte.name,
          unit: r.unit ?? r.analyte.defaultUnit,
          department: r.sampleTest.testDefinition.department,
          values: {},
        });
      }
      rowMap.get(r.analyteId)!.values[r.sampleTest.sample.accessionNumber] = {
        value: r.value,
        flag: r.flag,
        isCritical: r.isCritical,
      };
    }

    const rows = [...rowMap.values()].sort(
      (a, b) => a.department.localeCompare(b.department) || a.code.localeCompare(b.code),
    );

    return {
      patient: {
        id: patient.id,
        code: patient.patientCode,
        sex: patient.sex,
        ageYears: patient.ageYears,
        isErased: patient.erasedAt !== null,
      },
      columns,
      rows,
      totalResults: results.length,
    };
  }

  /**
   * Previous authorised values for one analyte, newest first.
   *
   * Rendered next to the input during result entry so a technician sees the
   * trend at the moment of typing — which is when an implausible value is
   * cheapest to catch.
   */
  async previousValues(patientId: string, analyteIds: string[], limit = 5) {
    if (analyteIds.length === 0) return {};

    const rows = await this.prisma.tx.result.findMany({
      where: {
        analyteId: { in: analyteIds },
        isCurrent: true,
        numericValue: { not: null },
        sampleTest: {
          sample: { patientId },
          status: { in: ['AUTHORIZED', 'REPORTED'] },
        },
      },
      orderBy: { enteredAt: 'desc' },
      take: limit * analyteIds.length,
      select: {
        analyteId: true,
        value: true,
        unit: true,
        flag: true,
        enteredAt: true,
        sampleTest: { select: { sample: { select: { accessionNumber: true, collectedAt: true } } } },
      },
    });

    const byAnalyte: Record<
      string,
      { value: string | null; unit: string | null; flag: string; date: string; accession: string }[]
    > = {};

    for (const r of rows) {
      const list = (byAnalyte[r.analyteId] ??= []);
      if (list.length >= limit) continue;
      list.push({
        value: r.value,
        unit: r.unit,
        flag: r.flag,
        date: (r.sampleTest.sample.collectedAt ?? r.enteredAt).toISOString(),
        accession: r.sampleTest.sample.accessionNumber,
      });
    }

    return byAnalyte;
  }
}
