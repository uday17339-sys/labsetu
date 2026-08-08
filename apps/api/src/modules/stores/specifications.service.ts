import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@labsetu/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * Specifications: the acceptance criteria a batch is judged against.
 *
 * The pharma generalisation of a reference range, with one difference that
 * matters: a reference range is clinical knowledge, a specification is a
 * controlled document. It is authored as a DRAFT, approved by QA, and only then
 * governs anything. The person who writes it must not be the only person who
 * decides it applies — which is why SPEC_MANAGE and SPEC_APPROVE are separate
 * permissions and QC holds neither.
 *
 * Versioning is by supersession, never edit-in-place: a result from March must
 * remain explicable against the specification that was in force in March.
 */
@Injectable()
export class SpecificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(materialId?: string, status?: string) {
    const rows = await this.prisma.tx.specification.findMany({
      where: {
        ...(materialId ? { materialId } : {}),
        ...(status ? { status: status as never } : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      include: {
        material: { select: { code: true, name: true, type: true } },
        _count: { select: { limits: true } },
      },
    });

    const now = new Date();
    return rows.map((s) => ({
      id: s.id,
      code: s.code,
      version: s.version,
      status: s.status,
      basis: s.basis,
      material: s.material,
      limitCount: s._count.limits,
      effectiveFrom: s.effectiveFrom?.toISOString() ?? null,
      effectiveTo: s.effectiveTo?.toISOString() ?? null,
      approvedAt: s.approvedAt?.toISOString() ?? null,
      inForce:
        s.status === 'APPROVED' &&
        !!s.effectiveFrom &&
        s.effectiveFrom <= now &&
        (!s.effectiveTo || s.effectiveTo > now),
    }));
  }

  async findOne(id: string) {
    const spec = await this.prisma.tx.specification.findUnique({
      where: { id },
      include: {
        material: true,
        limits: {
          orderBy: { sortOrder: 'asc' },
          include: {
            analyte: { select: { id: true, code: true, name: true, defaultUnit: true } },
            testDefinition: { select: { id: true, code: true, name: true } },
          },
        },
      },
    });
    if (!spec) throw new NotFoundException('Specification not found');

    const now = new Date();
    return {
      id: spec.id,
      code: spec.code,
      version: spec.version,
      status: spec.status,
      basis: spec.basis,
      material: {
        id: spec.material.id,
        code: spec.material.code,
        name: spec.material.name,
        type: spec.material.type,
        pharmacopoeia: spec.material.pharmacopoeia,
      },
      effectiveFrom: spec.effectiveFrom?.toISOString() ?? null,
      effectiveTo: spec.effectiveTo?.toISOString() ?? null,
      approvedAt: spec.approvedAt?.toISOString() ?? null,
      inForce:
        spec.status === 'APPROVED' &&
        !!spec.effectiveFrom &&
        spec.effectiveFrom <= now &&
        (!spec.effectiveTo || spec.effectiveTo > now),
      limits: spec.limits.map((l) => ({
        id: l.id,
        analyte: l.analyte,
        test: l.testDefinition,
        minValue: l.minValue?.toNumber() ?? null,
        maxValue: l.maxValue?.toNumber() ?? null,
        textCriteria: l.textCriteria,
        unit: l.unit ?? l.analyte.defaultUnit,
        isCritical: l.isCritical,
        /// Rendered exactly as it will print on the certificate of analysis.
        display: renderCriterion(
          l.minValue?.toNumber() ?? null,
          l.maxValue?.toNumber() ?? null,
          l.textCriteria,
          l.unit ?? l.analyte.defaultUnit,
        ),
      })),
    };
  }

  async create(input: {
    materialId: string;
    code: string;
    basis?: string;
    limits: {
      analyteId: string;
      testDefinitionId?: string;
      minValue?: number;
      maxValue?: number;
      textCriteria?: string;
      unit?: string;
      isCritical?: boolean;
    }[];
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const material = await tx.material.findUnique({ where: { id: input.materialId } });
    if (!material) throw new NotFoundException('Material not found');

    if (input.limits.length === 0) {
      throw new BadRequestException(
        'A specification needs at least one acceptance criterion. One with none would ' +
          'approve every batch it was applied to.',
      );
    }

    for (const l of input.limits) {
      if (l.minValue == null && l.maxValue == null && !l.textCriteria?.trim()) {
        throw new BadRequestException(
          'Every criterion needs a numeric limit or text criteria — otherwise it prints as a ' +
            'blank acceptance criterion on the certificate of analysis.',
        );
      }
      if (l.minValue != null && l.maxValue != null && l.minValue > l.maxValue) {
        throw new BadRequestException('A minimum cannot exceed its maximum');
      }
    }

    const code = input.code.trim().toUpperCase();
    // A new version of an existing code rather than a clash: specifications are
    // revised, and the revision keeps the code and takes the next version.
    const latest = await tx.specification.findFirst({
      where: { code },
      orderBy: { version: 'desc' },
    });
    const version = latest ? latest.version + 1 : 1;

    const spec = await tx.specification.create({
      data: {
        tenantId: ctx.tenantId!,
        materialId: input.materialId,
        code,
        version,
        // Not a parameter. Everything starts as a draft and is approved
        // separately, by someone else.
        status: 'DRAFT',
        basis: input.basis?.trim() || material.pharmacopoeia || null,
        createdBy: ctx.userId,
        limits: {
          create: input.limits.map((l, i) => ({
            tenantId: ctx.tenantId!,
            analyteId: l.analyteId,
            testDefinitionId: l.testDefinitionId ?? null,
            sortOrder: i,
            minValue: l.minValue != null ? new Prisma.Decimal(l.minValue) : null,
            maxValue: l.maxValue != null ? new Prisma.Decimal(l.maxValue) : null,
            textCriteria: l.textCriteria?.trim() || null,
            unit: l.unit?.trim() || null,
            isCritical: l.isCritical ?? true,
          })),
        },
      },
      include: { limits: true },
    });

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'Specification',
      entityId: spec.id,
      after: {
        code,
        version,
        material: material.code,
        status: 'DRAFT',
        basis: spec.basis,
        criteriaCount: spec.limits.length,
        criticalCount: spec.limits.filter((l) => l.isCritical).length,
      },
    });

    return {
      id: spec.id,
      code,
      version,
      status: spec.status,
      material: material.name,
      limitCount: spec.limits.length,
      note: 'Draft. QA approval is required before it governs any testing.',
    };
  }

  /**
   * QA approves a draft, superseding whatever it replaces.
   *
   * Approval is what makes a specification real. The previous in-force version
   * is closed at the same instant the new one opens, so there is never a gap in
   * which a batch could be tested against nothing, and never an overlap in
   * which two versions both claim to apply.
   */
  async approve(id: string, effectiveFrom: Date | undefined, note: string) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const spec = await tx.specification.findUnique({
      where: { id },
      include: { material: { select: { code: true, name: true } }, limits: true },
    });
    if (!spec) throw new NotFoundException('Specification not found');

    if (spec.status !== 'DRAFT') {
      throw new BadRequestException(
        `This specification is ${spec.status.toLowerCase()}, not a draft. Author a new version ` +
          `to change the acceptance criteria.`,
      );
    }
    if (spec.limits.length === 0) {
      throw new BadRequestException('A specification with no criteria cannot be approved');
    }
    if (spec.createdBy && spec.createdBy === ctx.userId) {
      throw new BadRequestException(
        'You authored this specification, so you cannot also approve it. Acceptance criteria ' +
          'need a second pair of eyes — that separation is the point of the approval step.',
      );
    }

    const from = effectiveFrom ?? new Date();

    const superseded = await tx.specification.findMany({
      where: {
        materialId: spec.materialId,
        status: 'APPROVED',
        id: { not: id },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: from } }],
      },
      select: { id: true, code: true, version: true },
    });

    for (const old of superseded) {
      await tx.specification.update({
        where: { id: old.id },
        data: { status: 'SUPERSEDED', effectiveTo: from },
      });
    }

    const approved = await tx.specification.update({
      where: { id },
      data: {
        status: 'APPROVED',
        effectiveFrom: from,
        approvedBy: ctx.userId,
        approvedAt: new Date(),
      },
    });

    await this.audit.record(tx, {
      action: 'AUTHORIZE',
      entityType: 'Specification',
      entityId: id,
      reason: note,
      before: { status: 'DRAFT' },
      after: {
        status: 'APPROVED',
        code: spec.code,
        version: spec.version,
        material: spec.material.code,
        effectiveFrom: from.toISOString(),
        criteriaCount: spec.limits.length,
        supersedes: superseded.map((o) => `${o.code} v${o.version}`),
      },
    });

    return {
      id,
      code: spec.code,
      version: spec.version,
      status: approved.status,
      effectiveFrom: from.toISOString(),
      superseded: superseded.map((o) => `${o.code} v${o.version}`),
    };
  }

  /**
   * The specification in force for a material at a given moment.
   *
   * Resolved by effective date rather than "the newest approved one", because a
   * result produced last month must be judged by last month's criteria.
   */
  async inForce(materialId: string, at: Date = new Date()) {
    return this.prisma.tx.specification.findFirst({
      where: {
        materialId,
        status: { in: ['APPROVED', 'SUPERSEDED'] },
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: { effectiveFrom: 'desc' },
      include: {
        limits: {
          orderBy: { sortOrder: 'asc' },
          include: { analyte: { select: { id: true, code: true, name: true, defaultUnit: true } } },
        },
      },
    });
  }
}

/** How a criterion prints on a certificate of analysis. */
export function renderCriterion(
  min: number | null,
  max: number | null,
  text: string | null,
  unit: string | null | undefined,
): string {
  if (text) return text;
  const u = unit ? ` ${unit}` : '';
  if (min != null && max != null) return `${min} to ${max}${u}`;
  if (min != null) return `Not less than ${min}${u}`;
  if (max != null) return `Not more than ${max}${u}`;
  return '—';
}
