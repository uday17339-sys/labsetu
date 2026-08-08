import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@labsetu/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * Catalog authoring: adding a test, changing a price, onboarding a referring
 * doctor, setting a reference range.
 *
 * The reason this matters more than it looks: the catalog was seed-only, so a
 * lab could not add Vitamin D to its menu or raise the CBC price without a
 * developer. That is not a missing screen, it is the lab being unable to run
 * its own business.
 *
 * Two rules run through everything here:
 *
 *   - Nothing in the catalog is ever hard-deleted. Tests are deactivated. A
 *     report printed two years ago must still resolve the test that produced it.
 *   - A clinically significant change bumps `version`. Operational rows record
 *     the version in force at the time, so history renders as it was, not as the
 *     catalog is today. Changing a price is not clinically significant; changing
 *     which analytes a test contains is.
 */
@Injectable()
export class CatalogAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // --- tests ----------------------------------------------------------------

  async createTest(input: {
    code: string;
    name: string;
    shortName?: string;
    department: string;
    price: number;
    tatMinutes?: number;
    sacCode?: string;
    specimenTypeId?: string;
    containerTypeId?: string;
    methodId?: string;
    minVolumeMl?: number;
    instructions?: string;
    requiresVerification?: boolean;
    isOutsourced?: boolean;
    analytes: { analyteId: string; sortOrder?: number; formula?: string; isMandatory?: boolean }[];
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;
    const code = input.code.trim().toUpperCase();

    const clash = await tx.testDefinition.findFirst({ where: { code } });
    if (clash) {
      throw new BadRequestException(
        `Test code ${code} is already in use by "${clash.name}"${clash.isActive ? '' : ' (inactive)'}. ` +
          `Codes appear on reports and instrument mappings, so they cannot be reused.`,
      );
    }

    if (input.analytes.length === 0) {
      throw new BadRequestException(
        'A test needs at least one analyte. A test with no analytes can be ordered but ' +
          'never resulted, which strands the sample at the bench.',
      );
    }

    const analyteIds = input.analytes.map((a) => a.analyteId);
    const found = await tx.analyte.findMany({ where: { id: { in: analyteIds } } });
    if (found.length !== new Set(analyteIds).size) {
      throw new BadRequestException('One or more analytes do not exist');
    }

    const test = await tx.testDefinition.create({
      data: {
        tenantId: ctx.tenantId!,
        code,
        name: input.name.trim(),
        shortName: input.shortName?.trim() || null,
        department: input.department as never,
        price: new Prisma.Decimal(input.price.toFixed(2)),
        tatMinutes: input.tatMinutes ?? null,
        sacCode: input.sacCode?.trim() || '999316',
        specimenTypeId: input.specimenTypeId ?? null,
        containerTypeId: input.containerTypeId ?? null,
        methodId: input.methodId ?? null,
        minVolumeMl: input.minVolumeMl != null ? new Prisma.Decimal(input.minVolumeMl) : null,
        instructions: input.instructions?.trim() || null,
        requiresVerification: input.requiresVerification ?? true,
        isOutsourced: input.isOutsourced ?? false,
        analytes: {
          create: input.analytes.map((a, i) => ({
            tenantId: ctx.tenantId!,
            analyteId: a.analyteId,
            sortOrder: a.sortOrder ?? i,
            formula: a.formula?.trim() || null,
            isMandatory: a.isMandatory ?? true,
          })),
        },
      },
      include: { analytes: true },
    });

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'TestDefinition',
      entityId: test.id,
      after: {
        code: test.code,
        name: test.name,
        department: test.department,
        price: test.price.toNumber(),
        analyteCount: test.analytes.length,
        version: test.version,
      },
    });

    return { id: test.id, code: test.code, name: test.name, version: test.version };
  }

  async updateTest(
    id: string,
    input: {
      name?: string;
      shortName?: string | null;
      price?: number;
      tatMinutes?: number | null;
      instructions?: string | null;
      requiresVerification?: boolean;
      isActive?: boolean;
      analytes?: { analyteId: string; sortOrder?: number; formula?: string; isMandatory?: boolean }[];
    },
    reason?: string,
  ) {
    const tx = this.prisma.tx;

    const before = await tx.testDefinition.findUnique({
      where: { id },
      include: { analytes: { select: { analyteId: true, sortOrder: true, formula: true } } },
    });
    if (!before) throw new NotFoundException('Test not found');

    // Composition changes are clinically significant; price and wording are not.
    const compositionChanged = input.analytes !== undefined;

    if (compositionChanged) {
      const inFlight = await tx.sampleTest.count({
        where: {
          testDefinitionId: id,
          status: { notIn: ['REPORTED', 'CANCELLED', 'AUTHORIZED'] },
        },
      });
      if (inFlight > 0) {
        throw new BadRequestException(
          `${inFlight} sample(s) of this test are still in progress. Changing which analytes ` +
            `the test contains now would leave them half-resulted against a definition that no ` +
            `longer matches. Finish or cancel them first.`,
        );
      }
    }

    const data: Prisma.TestDefinitionUpdateInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.shortName !== undefined) data.shortName = input.shortName || null;
    if (input.price !== undefined) data.price = new Prisma.Decimal(input.price.toFixed(2));
    if (input.tatMinutes !== undefined) data.tatMinutes = input.tatMinutes;
    if (input.instructions !== undefined) data.instructions = input.instructions || null;
    if (input.requiresVerification !== undefined) {
      data.requiresVerification = input.requiresVerification;
    }
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (compositionChanged) data.version = { increment: 1 };

    // The whole request already runs inside one tenant-scoped transaction
    // (PrismaService.tx), so these statements commit or roll back together
    // without opening a nested one.
    if (compositionChanged) {
      await tx.testAnalyte.deleteMany({ where: { testDefinitionId: id } });
      await tx.testAnalyte.createMany({
        data: input.analytes!.map((a, i) => ({
          tenantId: before.tenantId,
          testDefinitionId: id,
          analyteId: a.analyteId,
          sortOrder: a.sortOrder ?? i,
          formula: a.formula?.trim() || null,
          isMandatory: a.isMandatory ?? true,
        })),
      });
    }
    const after = await tx.testDefinition.update({ where: { id }, data });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'TestDefinition',
      entityId: id,
      reason,
      before: {
        name: before.name,
        price: before.price.toNumber(),
        tatMinutes: before.tatMinutes,
        isActive: before.isActive,
        version: before.version,
        analyteCount: before.analytes.length,
      },
      after: {
        name: after.name,
        price: after.price.toNumber(),
        tatMinutes: after.tatMinutes,
        isActive: after.isActive,
        version: after.version,
        analyteCount: input.analytes?.length ?? before.analytes.length,
      },
    });

    return {
      id,
      code: after.code,
      name: after.name,
      price: after.price.toNumber(),
      version: after.version,
      isActive: after.isActive,
      versionBumped: compositionChanged,
    };
  }

  // --- analytes -------------------------------------------------------------

  async listAnalytes() {
    const rows = await this.prisma.tx.analyte.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        valueType: true,
        defaultUnit: true,
        precision: true,
        allowedValues: true,
        loincCode: true,
        _count: { select: { testAnalytes: true, referenceRanges: true } },
      },
    });
    return rows.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      valueType: a.valueType,
      defaultUnit: a.defaultUnit,
      precision: a.precision,
      allowedValues: a.allowedValues,
      loincCode: a.loincCode,
      usedInTests: a._count.testAnalytes,
      referenceRangeCount: a._count.referenceRanges,
    }));
  }

  async createAnalyte(input: {
    code: string;
    name: string;
    valueType: string;
    defaultUnit?: string;
    precision?: number;
    allowedValues?: string[];
    loincCode?: string;
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;
    const code = input.code.trim().toUpperCase();

    if (await tx.analyte.findFirst({ where: { code } })) {
      throw new BadRequestException(`Analyte code ${code} already exists`);
    }
    if (
      (input.valueType === 'QUALITATIVE' || input.valueType === 'SELECT') &&
      !input.allowedValues?.length
    ) {
      throw new BadRequestException(
        'A qualitative analyte needs its allowed values — otherwise the bench can type anything ' +
          'and the result is not comparable across visits.',
      );
    }

    const analyte = await tx.analyte.create({
      data: {
        tenantId: ctx.tenantId!,
        code,
        name: input.name.trim(),
        valueType: input.valueType as never,
        defaultUnit: input.defaultUnit?.trim() || null,
        precision: input.precision ?? 2,
        allowedValues: input.allowedValues ?? [],
        loincCode: input.loincCode?.trim() || null,
      },
    });

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'Analyte',
      entityId: analyte.id,
      after: { code: analyte.code, name: analyte.name, valueType: analyte.valueType },
    });

    return { id: analyte.id, code: analyte.code, name: analyte.name };
  }

  // --- reference ranges -----------------------------------------------------

  async listRanges(analyteId: string) {
    const rows = await this.prisma.tx.referenceRange.findMany({
      where: { analyteId },
      orderBy: [{ effectiveFrom: 'desc' }],
    });
    const now = new Date();
    return rows.map((r) => ({
      id: r.id,
      sex: r.sex,
      minAgeDays: r.minAgeDays,
      maxAgeDays: r.maxAgeDays,
      condition: r.condition,
      lowValue: r.lowValue?.toNumber() ?? null,
      highValue: r.highValue?.toNumber() ?? null,
      criticalLow: r.criticalLow?.toNumber() ?? null,
      criticalHigh: r.criticalHigh?.toNumber() ?? null,
      displayText: r.displayText,
      unit: r.unit,
      effectiveFrom: r.effectiveFrom.toISOString(),
      effectiveTo: r.effectiveTo?.toISOString() ?? null,
      inForce: r.effectiveFrom <= now && (!r.effectiveTo || r.effectiveTo > now),
    }));
  }

  /**
   * Reference ranges are versioned by effective date, never edited in place —
   * a result flagged HIGH last March must still be explicable by the range that
   * was in force last March.
   */
  async createRange(input: {
    analyteId: string;
    sex?: string;
    minAgeDays?: number;
    maxAgeDays?: number;
    condition?: string;
    lowValue?: number;
    highValue?: number;
    criticalLow?: number;
    criticalHigh?: number;
    displayText?: string;
    unit?: string;
    effectiveFrom?: Date;
    supersedesId?: string;
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const analyte = await tx.analyte.findUnique({ where: { id: input.analyteId } });
    if (!analyte) throw new NotFoundException('Analyte not found');

    if (input.lowValue != null && input.highValue != null && input.lowValue >= input.highValue) {
      throw new BadRequestException('The low value must be below the high value');
    }
    if (input.criticalLow != null && input.lowValue != null && input.criticalLow > input.lowValue) {
      throw new BadRequestException(
        'The critical low must sit below the normal low, or every low result becomes a ' +
          'critical callback and the alert stops meaning anything.',
      );
    }
    if (
      input.criticalHigh != null &&
      input.highValue != null &&
      input.criticalHigh < input.highValue
    ) {
      throw new BadRequestException('The critical high must sit above the normal high');
    }
    if (
      input.lowValue == null &&
      input.highValue == null &&
      !input.displayText?.trim()
    ) {
      throw new BadRequestException(
        'Give either a numeric interval or display text. A range that says nothing prints as ' +
          'a blank column on the report.',
      );
    }

    const effectiveFrom = input.effectiveFrom ?? new Date();

    // Closing the superseded range rather than deleting it keeps old reports
    // explicable.
    if (input.supersedesId) {
      const old = await tx.referenceRange.findUnique({ where: { id: input.supersedesId } });
      if (!old) throw new NotFoundException('The range being superseded does not exist');
      await tx.referenceRange.update({
        where: { id: input.supersedesId },
        data: { effectiveTo: effectiveFrom },
      });
    }

    const range = await tx.referenceRange.create({
      data: {
        tenantId: ctx.tenantId!,
        analyteId: input.analyteId,
        sex: (input.sex as never) ?? null,
        minAgeDays: input.minAgeDays ?? null,
        maxAgeDays: input.maxAgeDays ?? null,
        condition: input.condition?.trim() || null,
        lowValue: input.lowValue != null ? new Prisma.Decimal(input.lowValue) : null,
        highValue: input.highValue != null ? new Prisma.Decimal(input.highValue) : null,
        criticalLow: input.criticalLow != null ? new Prisma.Decimal(input.criticalLow) : null,
        criticalHigh: input.criticalHigh != null ? new Prisma.Decimal(input.criticalHigh) : null,
        displayText: input.displayText?.trim() || null,
        unit: input.unit?.trim() || analyte.defaultUnit,
        effectiveFrom,
      },
    });

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'ReferenceRange',
      entityId: range.id,
      after: {
        analyte: analyte.code,
        sex: range.sex,
        low: range.lowValue?.toNumber() ?? null,
        high: range.highValue?.toNumber() ?? null,
        criticalLow: range.criticalLow?.toNumber() ?? null,
        criticalHigh: range.criticalHigh?.toNumber() ?? null,
        effectiveFrom: effectiveFrom.toISOString(),
        supersedes: input.supersedesId ?? null,
      },
    });

    return { id: range.id, analyte: analyte.code, effectiveFrom: effectiveFrom.toISOString() };
  }

  // --- panels ---------------------------------------------------------------

  async createPanel(input: {
    code: string;
    name: string;
    price: number;
    testDefinitionIds: string[];
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;
    const code = input.code.trim().toUpperCase();

    if (await tx.panel.findFirst({ where: { code } })) {
      throw new BadRequestException(`Panel code ${code} already exists`);
    }
    if (input.testDefinitionIds.length < 2) {
      throw new BadRequestException('A panel needs at least two tests; otherwise order the test');
    }

    const tests = await tx.testDefinition.findMany({
      where: { id: { in: input.testDefinitionIds }, isActive: true },
    });
    if (tests.length !== new Set(input.testDefinitionIds).size) {
      throw new BadRequestException('One or more tests do not exist or are inactive');
    }

    const panel = await tx.panel.create({
      data: {
        tenantId: ctx.tenantId!,
        code,
        name: input.name.trim(),
        price: new Prisma.Decimal(input.price.toFixed(2)),
        items: {
          create: input.testDefinitionIds.map((testDefinitionId, i) => ({
            tenantId: ctx.tenantId!,
            testDefinitionId,
            sortOrder: i,
          })),
        },
      },
    });

    const listPrice = tests.reduce((s, t) => s + t.price.toNumber(), 0);

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'Panel',
      entityId: panel.id,
      after: {
        code: panel.code,
        name: panel.name,
        price: panel.price.toNumber(),
        tests: tests.map((t) => t.code),
        listPrice,
      },
    });

    return {
      id: panel.id,
      code: panel.code,
      name: panel.name,
      price: panel.price.toNumber(),
      listPrice: Number(listPrice.toFixed(2)),
      savings: Number((listPrice - panel.price.toNumber()).toFixed(2)),
    };
  }

  async updatePanel(id: string, input: { name?: string; price?: number; isActive?: boolean }) {
    const tx = this.prisma.tx;
    const before = await tx.panel.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Panel not found');

    const after = await tx.panel.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.price !== undefined
          ? { price: new Prisma.Decimal(input.price.toFixed(2)) }
          : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'Panel',
      entityId: id,
      before: { name: before.name, price: before.price.toNumber(), isActive: before.isActive },
      after: { name: after.name, price: after.price.toNumber(), isActive: after.isActive },
    });

    return { id, code: after.code, name: after.name, price: after.price.toNumber() };
  }

  // --- referring doctors ----------------------------------------------------

  async listDoctors(includeInactive = false) {
    const rows = await this.prisma.tx.referringDoctor.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
      include: {
        organization: { select: { name: true } },
        _count: { select: { orders: true } },
      },
    });
    return rows.map((d) => ({
      id: d.id,
      code: d.code,
      name: d.name,
      qualification: d.qualification,
      registrationNo: d.registrationNo,
      speciality: d.speciality,
      phone: d.phone,
      email: d.email,
      organization: d.organization?.name ?? null,
      commissionPct: d.commissionPct?.toNumber() ?? null,
      isActive: d.isActive,
      orderCount: d._count.orders,
    }));
  }

  async createDoctor(input: {
    code?: string;
    name: string;
    qualification?: string;
    registrationNo?: string;
    speciality?: string;
    phone?: string;
    email?: string;
    commissionPct?: number;
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    // Auto-code when the desk does not supply one — nobody at a reception
    // counter wants to invent a referral code while a patient waits.
    let code = input.code?.trim().toUpperCase();
    if (!code) {
      const count = await tx.referringDoctor.count();
      code = `DR${String(count + 1).padStart(4, '0')}`;
      // Collisions are possible after deactivations; walk forward.
      let n = count + 1;
      while (await tx.referringDoctor.findFirst({ where: { code } })) {
        n += 1;
        code = `DR${String(n).padStart(4, '0')}`;
      }
    } else if (await tx.referringDoctor.findFirst({ where: { code } })) {
      throw new BadRequestException(`Referral code ${code} is already in use`);
    }

    const doctor = await tx.referringDoctor.create({
      data: {
        tenantId: ctx.tenantId!,
        code,
        name: input.name.trim(),
        qualification: input.qualification?.trim() || null,
        registrationNo: input.registrationNo?.trim() || null,
        speciality: input.speciality?.trim() || null,
        phone: input.phone?.trim() || null,
        email: input.email?.trim().toLowerCase() || null,
        commissionPct:
          input.commissionPct != null ? new Prisma.Decimal(input.commissionPct) : null,
      },
    });

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'ReferringDoctor',
      entityId: doctor.id,
      after: { code: doctor.code, name: doctor.name, speciality: doctor.speciality },
    });

    return { id: doctor.id, code: doctor.code, name: doctor.name };
  }

  async updateDoctor(
    id: string,
    input: {
      name?: string;
      qualification?: string | null;
      registrationNo?: string | null;
      speciality?: string | null;
      phone?: string | null;
      email?: string | null;
      commissionPct?: number | null;
      isActive?: boolean;
    },
  ) {
    const tx = this.prisma.tx;
    const before = await tx.referringDoctor.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Referring doctor not found');

    const after = await tx.referringDoctor.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.qualification !== undefined ? { qualification: input.qualification || null } : {}),
        ...(input.registrationNo !== undefined
          ? { registrationNo: input.registrationNo || null }
          : {}),
        ...(input.speciality !== undefined ? { speciality: input.speciality || null } : {}),
        ...(input.phone !== undefined ? { phone: input.phone || null } : {}),
        ...(input.email !== undefined ? { email: input.email?.toLowerCase() || null } : {}),
        ...(input.commissionPct !== undefined
          ? {
              commissionPct:
                input.commissionPct != null ? new Prisma.Decimal(input.commissionPct) : null,
            }
          : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'ReferringDoctor',
      entityId: id,
      before: { name: before.name, speciality: before.speciality, isActive: before.isActive },
      after: { name: after.name, speciality: after.speciality, isActive: after.isActive },
    });

    return { id, code: after.code, name: after.name, isActive: after.isActive };
  }
}
