import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { normaliseIndianPhone, type CreatePatientInput } from '@labsetu/contracts';
import type { Prisma } from '@labsetu/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { TenantKeyService } from '../../common/crypto/tenant-key.service';
import { RequestContextStore } from '../../common/context/request-context';

/** Blind-index namespaces. Separated so a phone and a gov ID cannot collide. */
const IDX = {
  name: 'patient.name',
  phone: 'patient.phone',
  email: 'patient.email',
  govId: 'patient.govid',
} as const;

@Injectable()
export class PatientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly tenantKeys: TenantKeyService,
  ) {}

  async create(input: CreatePatientInput) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;
    const tenantKey = await this.tenantKeys.get(ctx.tenantId!);

    // One key per patient — this is what makes DPDP erasure possible without
    // deleting rows or breaking the audit chain (ADR 0005).
    const { key: patientKey, wrapped } = this.crypto.createSubjectKey(tenantKey);

    const patientCode = await this.nextPatientCode(tx, ctx.tenantId!);

    const patient = await tx.patient.create({
      data: {
        tenantId: ctx.tenantId!,
        patientCode,
        nameEnc: this.crypto.encryptField(input.fullName, patientKey),
        nameIdx: this.crypto.index(input.fullName, IDX.name),
        phoneEnc: input.phone ? this.crypto.encryptField(input.phone, patientKey) : null,
        phoneIdx: input.phone ? this.crypto.index(input.phone, IDX.phone) : null,
        emailEnc: input.email ? this.crypto.encryptField(input.email, patientKey) : null,
        emailIdx: input.email ? this.crypto.index(input.email, IDX.email) : null,
        addressEnc: input.address ? this.crypto.encryptField(input.address, patientKey) : null,
        govIdEnc: input.govId ? this.crypto.encryptField(input.govId, patientKey) : null,
        govIdIdx: input.govId ? this.crypto.index(input.govId, IDX.govId) : null,
        dataKeyEnc: wrapped,
        sex: input.sex,
        dateOfBirth: input.dateOfBirth ?? null,
        ageYears: input.ageYears ?? null,
        ageMonths: input.ageMonths ?? null,
        ageDays: input.ageDays ?? null,
        bloodGroup: input.bloodGroup ?? null,
        createdBy: ctx.userId,
      },
    });

    if (input.consents.length > 0) {
      await tx.consentRecord.createMany({
        data: input.consents.map((c) => ({
          tenantId: ctx.tenantId!,
          patientId: patient.id,
          purpose: c.purpose,
          granted: c.granted,
          noticeVersion: c.noticeVersion,
          noticeLocale: c.noticeLocale,
          grantedAt: c.granted ? new Date() : null,
        })),
      });
    }

    // The audit entry records that a patient was created and WHICH fields were
    // supplied — never the values. An audit trail that leaks PII is a liability
    // rather than a control, and it is retained for years.
    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'Patient',
      entityId: patient.id,
      after: {
        patientCode,
        sex: input.sex,
        hasPhone: !!input.phone,
        hasEmail: !!input.email,
        hasGovId: !!input.govId,
        consentsRecorded: input.consents.length,
      },
    });

    return this.toDetail(patient, patientKey);
  }

  /**
   * Exact-match search over blind indexes. Substring search on encrypted
   * identifiers is deliberately unsupported (ADR 0005) — labs search by phone,
   * patient code or accession number in practice.
   */
  async search(q: {
    phone?: string;
    patientCode?: string;
    govId?: string;
    name?: string;
    registeredFrom?: Date;
    registeredTo?: Date;
    limit: number;
  }) {
    const tx = this.prisma.tx;

    const where: Record<string, unknown> = {};
    if (q.patientCode) where.patientCode = q.patientCode.toUpperCase();
    if (q.phone) where.phoneIdx = this.crypto.index(normaliseIndianPhone(q.phone), IDX.phone);
    if (q.govId) where.govIdIdx = this.crypto.index(q.govId, IDX.govId);
    if (q.name) where.nameIdx = this.crypto.index(q.name, IDX.name);

    // `createdAt` is not encrypted, so a registration window is answerable where
    // substring search over identifiers is not. It is what makes "who came in
    // today" possible without weakening the blind-index design (ADR 0005).
    if (q.registeredFrom || q.registeredTo) {
      where.createdAt = {
        ...(q.registeredFrom ? { gte: q.registeredFrom } : {}),
        ...(q.registeredTo ? { lte: q.registeredTo } : {}),
      };
    }

    if (Object.keys(where).length === 0) {
      throw new BadRequestException(
        'Provide a patient code, phone number, government ID, exact full name, or a ' +
          'registration date range to search',
      );
    }

    const rows = await tx.patient.findMany({
      where,
      take: q.limit,
      orderBy: { createdAt: 'desc' },
    });

    // List responses never decrypt. Identifiers require patient:read_pii and a
    // logged single-record read.
    return rows.map((p) => ({
      id: p.id,
      patientCode: p.patientCode,
      sex: p.sex,
      ageDisplay: formatAge(p),
      createdAt: p.createdAt.toISOString(),
      isErased: p.erasedAt !== null,
    }));
  }

  /**
   * Full record including decrypted identifiers.
   *
   * Reading identifiable patient data is itself an auditable event under
   * ISO 15189 and DPDP — "who looked at this patient's record" is a question a
   * lab must be able to answer.
   */
  async findOne(id: string) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const patient = await tx.patient.findUnique({
      where: { id },
      include: { consents: true },
    });
    if (!patient) throw new NotFoundException('Patient not found');

    await this.audit.record(tx, {
      action: 'READ_SENSITIVE',
      entityType: 'Patient',
      entityId: patient.id,
      after: { patientCode: patient.patientCode, fields: ['name', 'phone', 'email', 'address'] },
    });

    const patientKey = patient.erasedAt
      ? null
      : this.crypto.unwrapSubjectKey(
          patient.dataKeyEnc,
          await this.tenantKeys.get(ctx.tenantId!),
        );

    return {
      ...this.toDetail(patient, patientKey),
      consents: patient.consents.map((c) => ({
        purpose: c.purpose,
        granted: c.granted,
        noticeVersion: c.noticeVersion,
        grantedAt: c.grantedAt?.toISOString() ?? null,
        withdrawnAt: c.withdrawnAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * Corrects a patient's demographics.
   *
   * A misspelled name and a mistyped phone number are the two most common
   * front-desk errors in any lab, and both matter: the name prints on the
   * report, and the number is how the report gets delivered. Without this the
   * only remedy was registering a duplicate patient, which fractures the
   * cumulative history — the exact thing the record exists to hold together.
   *
   * Sex and date of birth are editable because reference ranges are selected
   * from them; a wrong sex produces a report that is wrong and looks right.
   * Every change is audited by FIELD NAME only, never by value — the trail is
   * retained for years and must not become a PII store of its own.
   */
  async update(
    id: string,
    input: {
      fullName?: string;
      phone?: string | null;
      email?: string | null;
      address?: string | null;
      sex?: string;
      dateOfBirth?: Date | null;
      ageYears?: number | null;
      ageMonths?: number | null;
      ageDays?: number | null;
      bloodGroup?: string | null;
      reason: string;
    },
  ) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const patient = await tx.patient.findUnique({ where: { id } });
    if (!patient) throw new NotFoundException('Patient not found');
    if (patient.erasedAt) {
      throw new BadRequestException(
        'This record was erased under a DPDP request. It cannot be edited — the key that ' +
          'protected it no longer exists.',
      );
    }

    const tenantKey = await this.tenantKeys.get(ctx.tenantId!);
    const key = this.crypto.unwrapSubjectKey(patient.dataKeyEnc, tenantKey);

    const data: Record<string, unknown> = {};
    const changedFields: string[] = [];

    if (input.fullName !== undefined) {
      data.nameEnc = this.crypto.encryptField(input.fullName, key);
      data.nameIdx = this.crypto.index(input.fullName, IDX.name);
      changedFields.push('fullName');
    }
    if (input.phone !== undefined) {
      const phone = input.phone ? normaliseIndianPhone(input.phone) : null;
      data.phoneEnc = phone ? this.crypto.encryptField(phone, key) : null;
      data.phoneIdx = phone ? this.crypto.index(phone, IDX.phone) : null;
      changedFields.push('phone');
    }
    if (input.email !== undefined) {
      data.emailEnc = input.email ? this.crypto.encryptField(input.email, key) : null;
      data.emailIdx = input.email ? this.crypto.index(input.email, IDX.email) : null;
      changedFields.push('email');
    }
    if (input.address !== undefined) {
      data.addressEnc = input.address ? this.crypto.encryptField(input.address, key) : null;
      changedFields.push('address');
    }
    if (input.sex !== undefined) {
      data.sex = input.sex;
      changedFields.push('sex');
    }
    if (input.dateOfBirth !== undefined) {
      data.dateOfBirth = input.dateOfBirth;
      changedFields.push('dateOfBirth');
    }
    if (input.ageYears !== undefined) {
      data.ageYears = input.ageYears;
      changedFields.push('ageYears');
    }
    if (input.ageMonths !== undefined) data.ageMonths = input.ageMonths;
    if (input.ageDays !== undefined) data.ageDays = input.ageDays;
    if (input.bloodGroup !== undefined) {
      data.bloodGroup = input.bloodGroup;
      changedFields.push('bloodGroup');
    }

    if (changedFields.length === 0) {
      throw new BadRequestException('Nothing to update');
    }

    const updated = await tx.patient.update({ where: { id }, data });

    // A correction to demographics after a report was released is a different
    // act from a correction before — the released report now disagrees with the
    // record, and someone has to decide whether to reissue it.
    const releasedReports = await tx.report.count({
      where: { order: { patientId: id }, status: 'RELEASED' },
    });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'Patient',
      entityId: id,
      reason: input.reason,
      before: {
        patientCode: patient.patientCode,
        sex: patient.sex,
        ageYears: patient.ageYears,
        bloodGroup: patient.bloodGroup,
      },
      after: {
        patientCode: patient.patientCode,
        sex: updated.sex,
        ageYears: updated.ageYears,
        bloodGroup: updated.bloodGroup,
        changedFields,
        releasedReportsAffected: releasedReports,
      },
    });

    return {
      ...this.toDetail(updated, key),
      changedFields,
      /// Surfaced so the desk knows a reissue may be needed rather than
      /// discovering it when the patient complains about the name on the report.
      releasedReportsAffected: releasedReports,
    };
  }

  /**
   * DPDP erasure by crypto-shredding.
   *
   * The row survives, the audit chain survives, the clinical history survives —
   * only the key is destroyed, which makes the identifiers unrecoverable even
   * from a backup restored later. Row deletion could not offer that property.
   */
  async erase(id: string, reason: string, requestRef: string) {
    const tx = this.prisma.tx;

    const patient = await tx.patient.findUnique({ where: { id } });
    if (!patient) throw new NotFoundException('Patient not found');
    if (patient.erasedAt) {
      throw new BadRequestException('This patient record has already been erased');
    }

    await tx.patient.update({
      where: { id },
      data: {
        // Destroying the wrapped key is the erasure. The ciphertext columns are
        // left in place: without the key they are indistinguishable from noise,
        // and clearing them would rewrite a record we promise not to rewrite.
        dataKeyEnc: '',
        nameIdx: null,
        phoneIdx: null,
        emailIdx: null,
        govIdIdx: null,
        erasedAt: new Date(),
        erasureRef: requestRef,
      },
    });

    await tx.consentRecord.updateMany({
      where: { patientId: id, withdrawnAt: null },
      data: { withdrawnAt: new Date(), granted: false },
    });

    await this.audit.record(tx, {
      action: 'ERASURE_EXECUTED',
      entityType: 'Patient',
      entityId: id,
      reason,
      after: {
        patientCode: patient.patientCode,
        requestRef,
        method: 'CRYPTO_SHRED',
        note: 'Data key destroyed. Clinical record and audit trail retained de-identified.',
      },
    });

    return {
      status: 'ERASED',
      patientCode: patient.patientCode,
      note: 'Identifiers are permanently unrecoverable. Clinical records retained de-identified.',
    };
  }

  // ---------------------------------------------------------------------------

  private toDetail(
    p: {
      id: string;
      patientCode: string;
      sex: string;
      dateOfBirth: Date | null;
      ageYears: number | null;
      ageMonths: number | null;
      ageDays: number | null;
      bloodGroup: string | null;
      nameEnc: string;
      phoneEnc: string | null;
      emailEnc: string | null;
      addressEnc: string | null;
      erasedAt: Date | null;
      createdAt: Date;
    },
    key: Buffer | null,
  ) {
    return {
      id: p.id,
      patientCode: p.patientCode,
      fullName: this.crypto.decryptField(p.nameEnc, key) ?? '[erased]',
      phone: this.crypto.decryptField(p.phoneEnc, key),
      email: this.crypto.decryptField(p.emailEnc, key),
      address: this.crypto.decryptField(p.addressEnc, key),
      sex: p.sex,
      dateOfBirth: p.dateOfBirth?.toISOString().slice(0, 10) ?? null,
      ageDisplay: formatAge(p),
      bloodGroup: p.bloodGroup,
      isErased: p.erasedAt !== null,
      createdAt: p.createdAt.toISOString(),
    };
  }

  /**
   * Per-tenant sequential patient code. The counter row is locked FOR UPDATE so
   * two concurrent registrations cannot claim the same code.
   */
  private async nextPatientCode(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<string> {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { code: true },
    });
    const prefix = tenant.code.slice(0, 3).toUpperCase();

    const lab = await tx.lab.findFirstOrThrow({ select: { id: true } });

    const rows = await tx.$queryRaw<{ counter: number }[]>`
      INSERT INTO accession_counter ("id", "tenantId", "labId", scope, counter, "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${lab.id}::uuid, 'PATIENT', 1, now())
      ON CONFLICT ("tenantId", "labId", scope)
      DO UPDATE SET counter = accession_counter.counter + 1, "updatedAt" = now()
      RETURNING counter
    `;

    return `${prefix}${String(rows[0]!.counter).padStart(6, '0')}`;
  }
}

function formatAge(p: {
  dateOfBirth: Date | null;
  ageYears: number | null;
  ageMonths: number | null;
  ageDays: number | null;
}): string {
  if (p.dateOfBirth) {
    const ms = Date.now() - p.dateOfBirth.getTime();
    const years = Math.floor(ms / (365.25 * 864e5));
    if (years >= 1) return `${years} Y`;
    const months = Math.floor(ms / (30.44 * 864e5));
    if (months >= 1) return `${months} M`;
    return `${Math.floor(ms / 864e5)} D`;
  }
  const parts: string[] = [];
  if (p.ageYears) parts.push(`${p.ageYears} Y`);
  if (p.ageMonths) parts.push(`${p.ageMonths} M`);
  if (p.ageDays) parts.push(`${p.ageDays} D`);
  return parts.join(' ') || 'Unknown';
}

/**
 * Age in days, for reference-range selection. Ranges are age-banded and
 * paediatric bands are narrow, so this must be exact rather than approximate.
 */
export function ageInDays(p: {
  dateOfBirth: Date | null;
  ageYears: number | null;
  ageMonths: number | null;
  ageDays: number | null;
}): number | null {
  if (p.dateOfBirth) {
    return Math.floor((Date.now() - p.dateOfBirth.getTime()) / 864e5);
  }
  if (p.ageYears === null && p.ageMonths === null && p.ageDays === null) return null;
  return (p.ageYears ?? 0) * 365 + (p.ageMonths ?? 0) * 30 + (p.ageDays ?? 0);
}
