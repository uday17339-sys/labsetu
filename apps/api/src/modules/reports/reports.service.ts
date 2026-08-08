import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { sha256Json } from '@labsetu/crypto';
import { REPORT_TRANSITIONS, canTransition, type ReportStatus } from '@labsetu/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { TenantKeyService } from '../../common/crypto/tenant-key.service';
import { AccessionService } from '../workflow/accession.service';
import { RequestContextStore } from '../../common/context/request-context';

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly crypto: CryptoService,
    private readonly tenantKeys: TenantKeyService,
    private readonly accession: AccessionService,
  ) {}

  /**
   * Composes a report from the authorised tests on an order.
   *
   * Only AUTHORIZED tests are included — a report is a statement the lab stands
   * behind, and an unauthorised result has not yet been stood behind by anyone.
   * Partial reports exist because labs routinely release the fast tests without
   * waiting for the slow one.
   */
  async generate(orderId: string, isPartial: boolean, sampleTestIds?: string[]) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const order = await tx.labOrder.findUnique({
      where: { id: orderId },
      include: { samples: { include: { tests: true } }, lab: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    // A patient report and a certificate of analysis are different documents
    // with different regulators behind them. An order whose subject is a
    // material batch gets a CoA, issued by QA after disposition — generating a
    // nameless patient report for it would produce a document that looks
    // clinical and certifies nothing.
    if (order.batchId) {
      throw new BadRequestException(
        'This order is manufacturing QC on a material batch, not a patient episode. Its ' +
          'certifying document is a certificate of analysis, issued by QA from the batch ' +
          'once it has been dispositioned.',
      );
    }
    if (!order.patientId) {
      throw new BadRequestException('This order has no subject and cannot be reported');
    }

    const allTests = order.samples.flatMap((s) => s.tests);
    const eligible = allTests.filter(
      (t) =>
        t.status === 'AUTHORIZED' &&
        (!sampleTestIds || sampleTestIds.includes(t.id)),
    );

    if (eligible.length === 0) {
      throw new BadRequestException(
        'No authorised tests to report. Results must be verified and authorised first.',
      );
    }

    const outstanding = allTests.filter(
      (t) => !['AUTHORIZED', 'REPORTED', 'CANCELLED'].includes(t.status),
    ).length;

    if (outstanding > 0 && !isPartial) {
      throw new BadRequestException(
        `${outstanding} test(s) are still pending. Mark this as a partial report to release the completed ones now.`,
      );
    }

    // Idempotent: an unreleased DRAFT already covering exactly these tests is
    // returned rather than duplicated.
    //
    // Without this a double-click produces two report numbers for the same
    // results, and an assessor's first question is which one is the real
    // record. A DRAFT has been signed by nobody and delivered to nobody, so
    // reusing it loses nothing.
    const eligibleIds = [...eligible.map((t) => t.id)].sort();
    const existingDrafts = await tx.report.findMany({
      where: { orderId, status: 'DRAFT' },
      include: { items: { select: { sampleTestId: true } } },
    });

    const duplicate = existingDrafts.find((d) => {
      const ids = d.items.map((i) => i.sampleTestId).sort();
      return ids.length === eligibleIds.length && ids.every((id, i) => id === eligibleIds[i]);
    });

    if (duplicate) return this.findOne(duplicate.id);

    const reportNumber = await this.accession.nextReportNumber(tx, ctx.tenantId!, order.labId);

    const report = await tx.report.create({
      data: {
        tenantId: ctx.tenantId!,
        orderId,
        reportNumber,
        version: 1,
        status: 'DRAFT',
        isPartial: isPartial || outstanding > 0,
      },
    });

    await tx.reportItem.createMany({
      data: eligible.map((t, i) => ({
        tenantId: ctx.tenantId!,
        reportId: report.id,
        sampleTestId: t.id,
        sortOrder: i,
      })),
    });

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'Report',
      entityId: report.id,
      after: {
        reportNumber,
        orderNumber: order.orderNumber,
        testCount: eligible.length,
        isPartial: report.isPartial,
        outstandingTests: outstanding,
      },
    });

    return this.findOne(report.id);
  }

  /**
   * Releases a report to the patient. Requires an electronic signature bound to
   * the report's exact content — once released, this is the artifact the patient
   * and their clinician act on.
   */
  async release(reportId: string, signingToken: string, deliverTo: { channel: string; destination?: string }[]) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const report = await tx.report.findUnique({
      where: { id: reportId },
      include: { items: true, order: { include: { patient: true } } },
    });
    if (!report) throw new NotFoundException('Report not found');

    if (!canTransition(REPORT_TRANSITIONS, report.status as ReportStatus, 'RELEASED')) {
      // DRAFT -> RELEASED goes via AUTHORIZED; we collapse the two here because
      // every included test already carries its own authorisation signature.
      if (report.status !== 'DRAFT' && report.status !== 'AUTHORIZED') {
        throw new BadRequestException(`A report in status ${report.status} cannot be released`);
      }
    }

    const contentHash = await this.contentHash(reportId);
    const signature = await this.auth.consumeSigningToken(signingToken, {
      entityType: 'Report',
      entityId: reportId,
      contentHash,
    });

    await tx.report.update({
      where: { id: reportId },
      data: {
        status: 'RELEASED',
        authorizedAt: new Date(),
        authorizedBy: ctx.userId,
        releasedAt: new Date(),
        releasedBy: ctx.userId,
      },
    });

    await tx.sampleTest.updateMany({
      where: { id: { in: report.items.map((i) => i.sampleTestId) } },
      data: { status: 'REPORTED', reportedAt: new Date() },
    });

    const auditId = await this.audit.record(tx, {
      action: 'RELEASE',
      entityType: 'Report',
      entityId: reportId,
      before: { status: report.status },
      after: { status: 'RELEASED', reportNumber: report.reportNumber, contentHash },
    });

    await tx.signature.create({
      data: {
        tenantId: ctx.tenantId!,
        userId: signature.userId,
        entityType: 'Report',
        entityId: reportId,
        meaning: 'AUTHORIZED',
        contentHash,
        method: 'PASSWORD_TOTP',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        auditLogId: auditId,
      },
    });

    // Delivery is queued, and gated on DPDP consent for the purpose.
    // Non-null by construction: `generate` refuses to create a report for a
    // batch order, so every report that exists has a patient behind it.
    const deliveries = await this.queueDeliveries(reportId, report.order.patientId!, deliverTo);

    const order = await tx.labOrder.findUniqueOrThrow({
      where: { id: report.orderId },
      include: { samples: { include: { tests: true } } },
    });
    const remaining = order.samples
      .flatMap((s) => s.tests)
      .filter((t) => !['REPORTED', 'CANCELLED'].includes(t.status)).length;

    await tx.labOrder.update({
      where: { id: report.orderId },
      data: {
        status: remaining === 0 ? 'COMPLETED' : 'PARTIALLY_REPORTED',
        completedAt: remaining === 0 ? new Date() : null,
      },
    });

    return { ...(await this.findOne(reportId)), deliveries };
  }

  /**
   * Amendment creates version n+1 with a mandatory reason. The previous version
   * is retained and remains retrievable forever — a patient may already be
   * holding it, so it is part of the record, not a draft to overwrite.
   */
  async amend(reportId: string, signingToken: string, reason: string) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const original = await tx.report.findUnique({
      where: { id: reportId },
      include: { items: true },
    });
    if (!original) throw new NotFoundException('Report not found');
    if (original.status !== 'RELEASED') {
      throw new BadRequestException('Only a released report can be amended');
    }

    const contentHash = await this.contentHash(reportId);
    const signature = await this.auth.consumeSigningToken(signingToken, {
      entityType: 'Report',
      entityId: reportId,
      contentHash,
    });

    await tx.report.update({ where: { id: reportId }, data: { status: 'AMENDED' } });

    const amended = await tx.report.create({
      data: {
        tenantId: ctx.tenantId!,
        orderId: original.orderId,
        reportNumber: original.reportNumber,
        version: original.version + 1,
        status: 'DRAFT',
        isPartial: original.isPartial,
        amendedFromId: original.id,
        amendmentReason: reason,
      },
    });

    await tx.reportItem.createMany({
      data: original.items.map((i) => ({
        tenantId: ctx.tenantId!,
        reportId: amended.id,
        sampleTestId: i.sampleTestId,
        sortOrder: i.sortOrder,
      })),
    });

    const auditId = await this.audit.record(tx, {
      action: 'AMEND',
      entityType: 'Report',
      entityId: amended.id,
      reason,
      before: { reportId: original.id, version: original.version, status: 'RELEASED' },
      after: { reportId: amended.id, version: amended.version, status: 'DRAFT' },
    });

    await tx.signature.create({
      data: {
        tenantId: ctx.tenantId!,
        userId: signature.userId,
        entityType: 'Report',
        entityId: amended.id,
        meaning: 'AMENDED',
        contentHash,
        reason,
        auditLogId: auditId,
      },
    });

    return this.findOne(amended.id);
  }

  /** The full report payload — what the PDF renderer and the UI both consume. */
  /**
   * Report register.
   *
   * The gap this closes is navigational but real: to reach a report you
   * previously had to remember the patient, find the order, then find the
   * report. A lab receptionist handed a printed slip has the report number and
   * nothing else. This is the screen they need.
   */
  async list(q: {
    status?: string;
    from?: Date;
    to?: Date;
    search?: string;
    limit: number;
    cursor?: string;
  }) {
    const tx = this.prisma.tx;

    const search = q.search?.trim().toUpperCase();
    const rows = await tx.report.findMany({
      where: {
        ...(q.status ? { status: q.status as never } : {}),
        ...(q.from || q.to
          ? {
              createdAt: {
                ...(q.from ? { gte: q.from } : {}),
                ...(q.to ? { lte: q.to } : {}),
              },
            }
          : {}),
        // One box searches report number, order number and accession number —
        // whichever identifier happens to be on the slip in front of the desk.
        ...(search
          ? {
              OR: [
                { reportNumber: { contains: search } },
                { order: { orderNumber: { contains: search } } },
                { order: { patient: { patientCode: { contains: search } } } },
                { order: { samples: { some: { accessionNumber: { contains: search } } } } },
              ],
            }
          : {}),
      },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: {
        order: {
          select: {
            orderNumber: true,
            patient: { select: { id: true, patientCode: true, sex: true, ageYears: true } },
            referringDoctor: { select: { name: true } },
          },
        },
        _count: { select: { items: true, deliveries: true } },
      },
    });

    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;

    return {
      items: items.map((r) => ({
        id: r.id,
        reportNumber: r.reportNumber,
        version: r.version,
        status: r.status,
        isPartial: r.isPartial,
        isAmendment: r.amendedFromId !== null,
        orderNumber: r.order.orderNumber,
        patientId: r.order.patient?.id ?? null,
        patientCode: r.order.patient?.patientCode ?? null,
        sex: r.order.patient?.sex ?? null,
        ageYears: r.order.patient?.ageYears ?? null,
        referredBy: r.order.referringDoctor?.name ?? 'Self',
        testCount: r._count.items,
        deliveryCount: r._count.deliveries,
        createdAt: r.createdAt.toISOString(),
        releasedAt: r.releasedAt?.toISOString() ?? null,
      })),
      nextCursor: hasMore ? items[items.length - 1]!.id : null,
    };
  }

  async findOne(reportId: string) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const report = await tx.report.findUnique({
      where: { id: reportId },
      include: {
        order: {
          include: {
            patient: true,
            referringDoctor: { select: { name: true, qualification: true } },
            lab: true,
          },
        },
        items: {
          orderBy: { sortOrder: 'asc' },
          include: {
            sampleTest: {
              include: {
                testDefinition: {
                  select: { code: true, name: true, department: true, method: { select: { name: true } } },
                },
                sample: { select: { accessionNumber: true, collectedAt: true, receivedAt: true } },
                results: {
                  where: { isCurrent: true },
                  include: { analyte: { select: { code: true, name: true, precision: true } } },
                },
              },
            },
          },
        },
      },
    });
    if (!report) throw new NotFoundException('Report not found');

    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId! } });

    // Every report has a patient: `generate` refuses batch orders outright.
    // Asserted once here rather than null-checked at each of the six places the
    // patient is read below.
    const patient = report.order.patient;
    if (!patient) {
      throw new BadRequestException(
        'This report belongs to a manufacturing QC order. Open its certificate of analysis ' +
          'instead.',
      );
    }

    // Decrypt the patient's name only for the report itself — this is the one
    // place identifiers legitimately belong, and the read is audited.
    const patientKey = patient.erasedAt
      ? null
      : this.crypto.unwrapSubjectKey(
          patient.dataKeyEnc,
          await this.tenantKeys.get(ctx.tenantId!),
        );

    const signatures = await tx.signature.findMany({
      where: {
        OR: [
          { entityType: 'Report', entityId: reportId },
          {
            entityType: 'SampleTest',
            entityId: { in: report.items.map((i) => i.sampleTestId) },
          },
        ],
      },
      include: {
        user: { select: { fullName: true, qualification: true, registrationNo: true } },
      },
      orderBy: { signedAt: 'asc' },
    });

    return {
      id: report.id,
      reportNumber: report.reportNumber,
      version: report.version,
      status: report.status,
      isPartial: report.isPartial,
      amendmentReason: report.amendmentReason,
      releasedAt: report.releasedAt?.toISOString() ?? null,
      lab: {
        name: report.order.lab.name,
        address: report.order.lab.addressLine1,
        city: report.order.lab.city,
        phone: report.order.lab.phone,
        nablCertNo: tenant.nablCertNo,
      },
      patient: {
        code: patient.patientCode,
        name: this.crypto.decryptField(patient.nameEnc, patientKey) ?? '[erased]',
        sex: patient.sex,
        ageYears: patient.ageYears,
      },
      referredBy: report.order.referringDoctor?.name ?? 'Self',
      orderNumber: report.order.orderNumber,
      tests: report.items.map((item) => ({
        code: item.sampleTest.testDefinition.code,
        name: item.sampleTest.testDefinition.name,
        department: item.sampleTest.testDefinition.department,
        method: item.sampleTest.testDefinition.method?.name ?? null,
        accessionNumber: item.sampleTest.sample.accessionNumber,
        collectedAt: item.sampleTest.sample.collectedAt?.toISOString() ?? null,
        interpretation: item.sampleTest.interpretation,
        results: item.sampleTest.results.map((r) => ({
          analyteCode: r.analyte.code,
          analyteName: r.analyte.name,
          value: r.value,
          unit: r.unit,
          referenceRange: r.refDisplay,
          flag: r.flag,
          isCritical: r.isCritical,
          source: r.source,
          version: r.version,
        })),
      })),
      signatures: signatures.map((s) => ({
        meaning: s.meaning,
        signedAt: s.signedAt.toISOString(),
        by: s.user.fullName,
        qualification: s.user.qualification,
        registrationNo: s.user.registrationNo,
      })),
    };
  }

  async contentHash(reportId: string): Promise<string> {
    const items = await this.prisma.tx.reportItem.findMany({
      where: { reportId },
      orderBy: { sortOrder: 'asc' },
      include: {
        sampleTest: {
          select: {
            id: true,
            testVersion: true,
            interpretation: true,
            results: {
              where: { isCurrent: true },
              orderBy: { analyteId: 'asc' },
              select: { analyteId: true, value: true, unit: true, flag: true, version: true },
            },
          },
        },
      },
    });
    return sha256Json({ reportId, items: items.map((i) => i.sampleTest) });
  }

  /**
   * Queues delivery, checking DPDP consent for REPORT_DELIVERY first. Sending a
   * result to a channel the patient did not consent to is a purpose-limitation
   * breach, so a missing consent blocks rather than warns.
   */
  private async queueDeliveries(
    reportId: string,
    patientId: string,
    deliverTo: { channel: string; destination?: string }[],
  ) {
    if (deliverTo.length === 0) return [];

    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const consent = await tx.consentRecord.findFirst({
      where: { patientId, purpose: 'REPORT_DELIVERY', granted: true, withdrawnAt: null },
    });

    const tenantKey = await this.tenantKeys.get(ctx.tenantId!);
    const patient = await tx.patient.findUniqueOrThrow({ where: { id: patientId } });
    const patientKey = patient.erasedAt
      ? null
      : this.crypto.unwrapSubjectKey(patient.dataKeyEnc, tenantKey);

    const out = [];
    for (const d of deliverTo) {
      const isElectronic = ['WHATSAPP', 'EMAIL', 'SMS'].includes(d.channel);
      const blocked = isElectronic && !consent;

      const destination =
        d.destination ??
        (d.channel === 'EMAIL'
          ? this.crypto.decryptField(patient.emailEnc, patientKey)
          : this.crypto.decryptField(patient.phoneEnc, patientKey)) ??
        '';

      const delivery = await tx.reportDelivery.create({
        data: {
          tenantId: ctx.tenantId!,
          reportId,
          channel: d.channel as never,
          destinationEnc: destination
            ? this.crypto.encryptField(destination, tenantKey)
            : '',
          status: blocked ? 'BLOCKED_NO_CONSENT' : 'QUEUED',
          consentId: consent?.id ?? null,
          failureReason: blocked
            ? 'No valid consent on record for REPORT_DELIVERY'
            : null,
        },
      });

      out.push({ id: delivery.id, channel: d.channel, status: delivery.status });
    }

    return out;
  }
}
