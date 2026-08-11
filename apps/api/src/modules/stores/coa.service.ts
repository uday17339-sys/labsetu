import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { QaService } from './qa.service';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * The certificate of analysis.
 *
 * What leaves the site with the material: the specification, the result against
 * each criterion, and a statement that the batch was released. It can only be
 * issued for a batch QA has actually approved — a CoA for quarantined or
 * rejected material is a document that should not exist, and the commonest way
 * one gets created is a well-meaning shortcut on a Friday afternoon.
 *
 * Certificates are append-only at the database grant level. A correction is a
 * new version; the original is never rewritten, because a customer already has
 * a copy of it.
 */
@Injectable()
export class CoaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly qa: QaService,
  ) {}

  async issue(batchId: string) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const batch = await tx.materialBatch.findUnique({
      where: { id: batchId },
      include: { material: true, goodsReceipt: true },
    });
    if (!batch) throw new NotFoundException('Batch not found');

    if (batch.status !== 'APPROVED') {
      throw new BadRequestException(
        `A certificate of analysis can only be issued for a released batch. ` +
          `Batch ${batch.batchNumber} is ${batch.status.toLowerCase().replace(/_/g, ' ')}.`,
      );
    }

    const review = await this.qa.reviewBatch(batchId);
    if (!review.specification) {
      throw new BadRequestException(
        'No specification governs this batch, so there is nothing to certify against.',
      );
    }

    const existing = await tx.certificateOfAnalysis.findFirst({
      where: { batchId },
      orderBy: { version: 'desc' },
    });
    const version = existing ? existing.version + 1 : 1;

    // COA/YY/NNNN, matching the house format on every certificate already
    // issued. A reissue keeps the original number and only bumps the version —
    // the customer holds a copy quoting that number.
    // Continues the series rather than counting rows: certificate numbers in a
    // real register are sparse, and counting would eventually reissue a number
    // that a customer already holds a document for.
    const year = new Date().getFullYear() % 100;
    const prefix = `COA/${year}/`;
    const highest = await tx.certificateOfAnalysis.findFirst({
      where: { coaNumber: { startsWith: prefix } },
      orderBy: { coaNumber: 'desc' },
      select: { coaNumber: true },
    });
    const next = highest ? Number(highest.coaNumber.slice(prefix.length)) + 1 : 1;
    const coaNumber = existing ? existing.coaNumber : `${prefix}${String(next).padStart(4, '0')}`;

    // The hash covers exactly what the certificate asserts, so a reissue that
    // changes nothing is detectable as such.
    const contentHash = createHash('sha256')
      .update(
        JSON.stringify({
          batchNumber: batch.batchNumber,
          material: batch.material.code,
          specification: `${review.specification.code}v${review.specification.version}`,
          results: review.assessment.map((a) => `${a.analyte.code}=${a.value ?? ''}:${a.verdict}`),
        }),
      )
      .digest('hex');

    const coa = await tx.certificateOfAnalysis.create({
      data: {
        tenantId: ctx.tenantId!,
        batchId,
        coaNumber,
        version,
        specificationId: review.specification.id,
        issuedBy: ctx.userId!,
        contentHash,
      },
    });

    await this.audit.record(tx, {
      action: 'RELEASE',
      entityType: 'CertificateOfAnalysis',
      entityId: coa.id,
      after: {
        coaNumber,
        version,
        material: batch.material.code,
        batchNumber: batch.batchNumber,
        specification: `${review.specification.code} v${review.specification.version}`,
        criteria: review.summary.criteria,
        passed: review.summary.passed,
        contentHash,
      },
    });

    return {
      id: coa.id,
      coaNumber,
      version,
      batchNumber: batch.batchNumber,
      material: batch.material.name,
      issuedAt: coa.issuedAt.toISOString(),
      contentHash,
    };
  }

  /**
   * The certificate register.
   *
   * A customer rings up quoting a batch number, or an auditor asks to see every
   * certificate issued this quarter. Both need to start from a list rather than
   * from the batch record, which is why this exists separately from the batch
   * screen. Only the current version of each certificate is listed — superseded
   * versions are reachable from the certificate itself, and showing all of them
   * here would make a single reissued CoA look like two different documents.
   */
  async list(params: { search?: string; limit?: number } = {}) {
    const tx = this.prisma.tx;
    const limit = Math.min(params.limit ?? 50, 100);
    const search = params.search?.trim();

    const rows = await tx.certificateOfAnalysis.findMany({
      where: search
        ? {
            OR: [
              { coaNumber: { contains: search, mode: 'insensitive' } },
              { batch: { batchNumber: { contains: search, mode: 'insensitive' } } },
              { batch: { material: { code: { contains: search, mode: 'insensitive' } } } },
              { batch: { material: { name: { contains: search, mode: 'insensitive' } } } },
            ],
          }
        : undefined,
      include: {
        batch: { include: { material: true } },
        specification: { select: { code: true, version: true } },
      },
      orderBy: [{ issuedAt: 'desc' }],
      // Over-fetch so that collapsing versions still fills a page. A batch that
      // has been recertified several times could otherwise return a short page;
      // with 2x headroom that needs every certificate on the page to be a
      // reissue, and the register is a lookup tool rather than a paged feed.
      take: limit * 2,
    });

    // Collapse to the latest version per certificate number.
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const held = latest.get(r.coaNumber);
      if (!held || r.version > held.version) latest.set(r.coaNumber, r);
    }

    return {
      items: [...latest.values()].slice(0, limit).map((c) => ({
        id: c.id,
        coaNumber: c.coaNumber,
        version: c.version,
        issuedAt: c.issuedAt.toISOString(),
        batchNumber: c.batch.batchNumber,
        material: { code: c.batch.material.code, name: c.batch.material.name },
        specification: `${c.specification.code} v${c.specification.version}`,
        batchStatus: c.batch.status,
      })),
    };
  }

  /** The printable certificate. */
  async findOne(id: string) {
    const tx = this.prisma.tx;

    const coa = await tx.certificateOfAnalysis.findUnique({
      where: { id },
      include: {
        batch: { include: { material: true, goodsReceipt: true } },
        specification: true,
      },
    });
    if (!coa) throw new NotFoundException('Certificate not found');

    const ctx = RequestContextStore.require();
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId! } });
    const review = await this.qa.reviewBatch(coa.batchId);
    const disposition = await tx.batchDisposition.findFirst({
      where: { batchId: coa.batchId },
      orderBy: { decidedAt: 'desc' },
    });

    // decidedBy is a plain column rather than a relation, so the decider is
    // fetched directly. Adding a foreign key purely to render a name would be a
    // migration on a table the database refuses to UPDATE or DELETE.
    const decider = disposition
      ? await tx.user.findUnique({
          where: { id: disposition.decidedBy },
          select: { fullName: true, qualification: true, registrationNo: true },
        })
      : null;

    // 21 CFR 11.50: a signed electronic record must DISPLAY the printed name of
    // the signer, the date and time of signing, and the meaning of the
    // signature. The certificate previously asserted "released under electronic
    // signature" and showed none of the three — the signature existed and was
    // sound, it simply was not manifested on the document that leaves the site,
    // which is the only place an auditor or a customer ever looks.
    const releaseSignature = await tx.signature.findFirst({
      where: { entityType: 'MaterialBatch', entityId: coa.batchId },
      orderBy: { signedAt: 'desc' },
      include: {
        user: { select: { fullName: true, qualification: true, registrationNo: true } },
      },
    });

    return {
      id: coa.id,
      coaNumber: coa.coaNumber,
      version: coa.version,
      issuedAt: coa.issuedAt.toISOString(),
      contentHash: coa.contentHash,
      issuer: {
        legalName: tenant.legalName ?? tenant.name,
        gstin: tenant.gstin,
      },
      material: {
        code: coa.batch.material.code,
        name: coa.batch.material.name,
        type: coa.batch.material.type,
        pharmacopoeia: coa.batch.material.pharmacopoeia,
      },
      batch: {
        batchNumber: coa.batch.batchNumber,
        manufacturerLot: coa.batch.manufacturerLot,
        quantityReceived: coa.batch.quantityReceived.toNumber(),
        unit: coa.batch.unit,
        manufacturedAt: coa.batch.manufacturedAt?.toISOString().slice(0, 10) ?? null,
        expiryDate: coa.batch.expiryDate?.toISOString().slice(0, 10) ?? null,
        retestDate: coa.batch.retestDate?.toISOString().slice(0, 10) ?? null,
        supplier: coa.batch.goodsReceipt?.supplierName ?? null,
      },
      specification: {
        code: coa.specification.code,
        version: coa.specification.version,
        basis: coa.specification.basis,
      },
      results: review.assessment.map((a) => ({
        parameter: a.analyte.name,
        code: a.analyte.code,
        criterion: a.criterion,
        result: a.value ?? '—',
        unit: 'unit' in a ? (a.unit ?? null) : null,
        verdict: a.verdict,
        isCritical: a.isCritical,
      })),
      disposition: disposition
        ? {
            decision: disposition.decision,
            rationale: disposition.rationale,
            deviationRef: disposition.deviationRef,
            decidedAt: disposition.decidedAt.toISOString(),
            decidedBy: decider?.fullName ?? null,
          }
        : null,
      /**
       * The signature manifestation, or null when the batch was released before
       * signatures were captured. Null is rendered as an explicit statement on
       * the certificate rather than an empty space — a certificate that is
       * silent about its own signature invites the reader to assume the best.
       */
      signature: releaseSignature
        ? {
            signedBy: releaseSignature.user.fullName,
            qualification: releaseSignature.user.qualification,
            registrationNo: releaseSignature.user.registrationNo,
            meaning: releaseSignature.meaning,
            signedAt: releaseSignature.signedAt.toISOString(),
            method: releaseSignature.method,
          }
        : null,
      conclusion:
        review.summary.failed === 0
          ? 'The batch complies with the specification stated above.'
          : 'The batch was released against a documented deviation. See the disposition below.',
    };
  }
}
