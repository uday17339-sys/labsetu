import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Prisma } from '@labsetu/db';
import { z } from 'zod';
import { PERMISSIONS, reasonSchema } from '@labsetu/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import { RequestContextStore } from '../../common/context/request-context';
import { evaluateWestgard, zScore } from './westgard';

const recordQcSchema = z.object({
  qcLotId: z.string().uuid(),
  analyteId: z.string().uuid(),
  deviceId: z.string().uuid().optional(),
  value: z.coerce.number().finite(),
  runAt: z.coerce.date().optional(),
});

const acceptQcSchema = z.object({
  actionTaken: reasonSchema,
});

const createMaterialSchema = z.object({
  code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(2).max(150),
  manufacturer: z.string().trim().max(120).optional(),
  level: z.enum(['LEVEL_1', 'LEVEL_2', 'LEVEL_3']),
});

const createLotSchema = z.object({
  qcMaterialId: z.string().uuid(),
  lotNumber: z.string().trim().min(1).max(60),
  expiryDate: z.coerce.date().optional(),
  openedAt: z.coerce.date().optional(),
  /// Target mean and SD per analyte. Without these no z-score can be computed
  /// and the Westgard rules have nothing to evaluate against.
  analytes: z
    .array(
      z.object({
        analyteId: z.string().uuid(),
        targetMean: z.coerce.number().finite(),
        targetSd: z.coerce.number().positive('SD must be greater than zero'),
        unit: z.string().trim().max(30).optional(),
      }),
    )
    .min(1),
});

/**
 * Quality control.
 *
 * This closes a loop that was otherwise open: ResultsService.assertQcPassing
 * blocks authorisation when QC has failed, but without a way to RECORD a QC run
 * that gate could never fire. A documented compliance control that cannot be
 * exercised is worse than one that does not exist, because it reads as working.
 */
@Injectable()
export class QcService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Active lots with their per-analyte targets — what the QC screen renders. */
  async listLots() {
    return this.prisma.tx.qcLot.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
      include: {
        material: { select: { code: true, name: true, level: true, manufacturer: true } },
        analytes: {
          include: { analyte: { select: { id: true, code: true, name: true, defaultUnit: true } } },
        },
      },
    });
  }

  /**
   * Records a QC run and evaluates it against Westgard multi-rules.
   *
   * The evaluation uses the preceding runs for the SAME lot + analyte +
   * instrument. Mixing instruments would make a sequential rule meaningless —
   * drift on one analyzer is not drift on another.
   */
  async record(input: z.infer<typeof recordQcSchema>) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const target = await tx.qcLotAnalyte.findFirst({
      where: { qcLotId: input.qcLotId, analyteId: input.analyteId },
      include: {
        analyte: { select: { code: true, name: true } },
        qcLot: { include: { material: { select: { code: true, name: true } } } },
      },
    });

    if (!target) {
      throw new BadRequestException(
        'This lot has no target mean/SD for that analyte. Set one before recording QC.',
      );
    }

    if (target.qcLot.expiryDate && target.qcLot.expiryDate < new Date()) {
      throw new BadRequestException(
        `QC lot ${target.qcLot.lotNumber} expired on ${target.qcLot.expiryDate.toISOString().slice(0, 10)}. ` +
          `Results from an expired control are not evidence of anything.`,
      );
    }

    const mean = target.targetMean.toNumber();
    const sd = target.targetSd.toNumber();
    const z = zScore(input.value, mean, sd);

    if (z === null) {
      throw new BadRequestException(
        `QC lot ${target.qcLot.lotNumber} has a zero SD for ${target.analyte.code}; ` +
          `evaluation is impossible until a real SD is established.`,
      );
    }

    // Preceding runs, oldest first, scoped to this lot + analyte + instrument.
    const history = await tx.qcResult.findMany({
      where: {
        qcLotId: input.qcLotId,
        analyteId: input.analyteId,
        ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      },
      orderBy: { runAt: 'desc' },
      take: 12,
      select: { zScore: true },
    });

    const points = [
      ...history
        .reverse()
        .map((h) => ({ z: h.zScore?.toNumber() ?? 0 })),
      { z },
    ];

    const outcome = evaluateWestgard(points);

    const created = await tx.qcResult.create({
      data: {
        tenantId: ctx.tenantId!,
        qcLotId: input.qcLotId,
        analyteId: input.analyteId,
        deviceId: input.deviceId ?? null,
        value: new Prisma.Decimal(input.value),
        zScore: new Prisma.Decimal(z.toFixed(4)),
        status: outcome.status,
        violatedRules: outcome.violated,
        runAt: input.runAt ?? new Date(),
        enteredBy: ctx.userId,
        source: 'MANUAL',
      },
    });

    await this.audit.record(tx, {
      action: outcome.status === 'REJECT' ? 'REJECT' : 'CREATE',
      entityType: 'QcResult',
      entityId: created.id,
      after: {
        lot: target.qcLot.lotNumber,
        material: target.qcLot.material.code,
        analyte: target.analyte.code,
        value: input.value,
        zScore: Number(z.toFixed(2)),
        status: outcome.status,
        violatedRules: outcome.violated,
      },
    });

    return {
      id: created.id,
      analyte: target.analyte.code,
      value: input.value,
      zScore: Number(z.toFixed(2)),
      status: outcome.status,
      violatedRules: outcome.violated,
      explanation: outcome.explanation,
      // Spelled out because this is the consequence a technician needs to know
      // immediately, not discover when authorisation is refused later.
      blocksAuthorization: outcome.status === 'REJECT',
      target: { mean, sd, unit: target.unit },
    };
  }

  /** Recent runs — the Levey-Jennings series. */
  async listResults(q: { analyteId?: string; deviceId?: string; status?: string; limit: number }) {
    const rows = await this.prisma.tx.qcResult.findMany({
      where: {
        ...(q.analyteId ? { analyteId: q.analyteId } : {}),
        ...(q.deviceId ? { deviceId: q.deviceId } : {}),
        ...(q.status ? { status: q.status as never } : {}),
      },
      orderBy: { runAt: 'desc' },
      take: q.limit,
      include: {
        analyte: { select: { code: true, name: true, defaultUnit: true } },
        device: { select: { code: true, name: true } },
        qcLot: {
          select: {
            lotNumber: true,
            material: { select: { code: true, name: true, level: true } },
          },
        },
      },
    });

    return rows.map((r) => ({
      id: r.id,
      analyteCode: r.analyte.code,
      analyteName: r.analyte.name,
      unit: r.analyte.defaultUnit,
      device: r.device?.code ?? null,
      lot: r.qcLot.lotNumber,
      material: r.qcLot.material.name,
      level: r.qcLot.material.level,
      value: r.value.toString(),
      zScore: r.zScore?.toNumber() ?? null,
      status: r.status,
      violatedRules: r.violatedRules,
      actionTaken: r.actionTaken,
      accepted: r.acceptedAt !== null,
      runAt: r.runAt.toISOString(),
    }));
  }

  /**
   * Clears a failed QC run with a documented corrective action.
   *
   * Requires qc:override. Until this is done the failure keeps blocking
   * authorisation on that instrument+analyte — which is the point. A report of
   * overrides is exactly what an assessor samples.
   */
  async accept(id: string, actionTaken: string) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const existing = await tx.qcResult.findUnique({
      where: { id },
      include: { analyte: { select: { code: true } } },
    });
    if (!existing) throw new NotFoundException('QC result not found');
    if (existing.acceptedAt) {
      throw new BadRequestException('This QC result has already been resolved');
    }

    const updated = await tx.qcResult.update({
      where: { id },
      data: { actionTaken, acceptedBy: ctx.userId, acceptedAt: new Date() },
    });

    await this.audit.record(tx, {
      action: 'QC_OVERRIDE',
      entityType: 'QcResult',
      entityId: id,
      reason: actionTaken,
      before: { status: existing.status, accepted: false },
      after: {
        analyte: existing.analyte.code,
        status: existing.status,
        accepted: true,
        violatedRules: existing.violatedRules,
      },
    });

    return updated;
  }

  /** Open failures — what blocks authorisation right now. */
  async openFailures() {
    const rows = await this.prisma.tx.qcResult.findMany({
      where: { status: 'REJECT', acceptedAt: null },
      orderBy: { runAt: 'desc' },
      include: {
        analyte: { select: { code: true, name: true } },
        device: { select: { code: true, name: true } },
        qcLot: { select: { lotNumber: true } },
      },
    });

    return rows.map((r) => ({
      id: r.id,
      analyte: r.analyte.code,
      analyteName: r.analyte.name,
      device: r.device?.code ?? null,
      lot: r.qcLot.lotNumber,
      value: r.value.toString(),
      zScore: r.zScore?.toNumber() ?? null,
      violatedRules: r.violatedRules,
      runAt: r.runAt.toISOString(),
    }));
  }

  // --- lot administration ---------------------------------------------------

  async listMaterials() {
    const rows = await this.prisma.tx.qcMaterial.findMany({
      where: { isActive: true },
      orderBy: [{ name: 'asc' }, { level: 'asc' }],
      include: { _count: { select: { lots: true } } },
    });
    return rows.map((m) => ({
      id: m.id,
      code: m.code,
      name: m.name,
      manufacturer: m.manufacturer,
      level: m.level,
      lotCount: m._count.lots,
    }));
  }

  async createMaterial(input: {
    code: string;
    name: string;
    manufacturer?: string;
    level: string;
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;
    const code = input.code.trim().toUpperCase();

    if (await tx.qcMaterial.findFirst({ where: { code } })) {
      throw new BadRequestException(`QC material code ${code} already exists`);
    }

    const material = await tx.qcMaterial.create({
      data: {
        tenantId: ctx.tenantId!,
        code,
        name: input.name.trim(),
        manufacturer: input.manufacturer?.trim() || null,
        level: input.level as never,
      },
    });

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'QcMaterial',
      entityId: material.id,
      after: { code: material.code, name: material.name, level: material.level },
    });

    return { id: material.id, code: material.code, name: material.name, level: material.level };
  }

  /**
   * Registers a new control lot with its target values.
   *
   * A lot with no targets is worse than no lot at all: QC would appear to be
   * running while every rule silently had nothing to test against. That is why
   * `analytes` is mandatory and the SD must be positive — a zero SD makes every
   * z-score infinite and would reject every run.
   */
  async createLot(input: {
    qcMaterialId: string;
    lotNumber: string;
    expiryDate?: Date;
    openedAt?: Date;
    analytes: { analyteId: string; targetMean: number; targetSd: number; unit?: string }[];
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const material = await tx.qcMaterial.findUnique({ where: { id: input.qcMaterialId } });
    if (!material) throw new NotFoundException('QC material not found');

    const lotNumber = input.lotNumber.trim();
    const clash = await tx.qcLot.findFirst({
      where: { qcMaterialId: input.qcMaterialId, lotNumber },
    });
    if (clash) {
      throw new BadRequestException(
        `Lot ${lotNumber} of ${material.name} is already registered`,
      );
    }

    if (input.expiryDate && input.expiryDate <= new Date()) {
      throw new BadRequestException(
        'That control lot has already expired. Running QC against expired material does not ' +
          'demonstrate anything about the assay.',
      );
    }

    const analyteIds = input.analytes.map((a) => a.analyteId);
    const found = await tx.analyte.findMany({ where: { id: { in: analyteIds } } });
    if (found.length !== new Set(analyteIds).size) {
      throw new BadRequestException('One or more analytes do not exist');
    }

    // A target mean and SD only mean something for a measured quantity. Setting
    // them on a qualitative analyte — blood group, a Positive/Negative — would
    // produce a z-score over values that have no distance between them, and the
    // Westgard rules would then evaluate nonsense while appearing to run.
    const nonNumeric = found.filter(
      (a) => a.valueType !== 'NUMERIC' && a.valueType !== 'NUMERIC_BOUNDED',
    );
    if (nonNumeric.length > 0) {
      throw new BadRequestException(
        `${nonNumeric.map((a) => a.code).join(', ')} ${nonNumeric.length > 1 ? 'are' : 'is'} ` +
          `not a measured quantity, so a target mean and SD do not apply. Quantitative control ` +
          `runs only — qualitative controls are recorded as expected-value checks instead.`,
      );
    }

    const lot = await tx.qcLot.create({
      data: {
        tenantId: ctx.tenantId!,
        qcMaterialId: input.qcMaterialId,
        lotNumber,
        expiryDate: input.expiryDate ?? null,
        openedAt: input.openedAt ?? new Date(),
        analytes: {
          create: input.analytes.map((a) => ({
            tenantId: ctx.tenantId!,
            analyteId: a.analyteId,
            targetMean: new Prisma.Decimal(a.targetMean),
            targetSd: new Prisma.Decimal(a.targetSd),
            unit: a.unit?.trim() || null,
          })),
        },
      },
      include: { analytes: true },
    });

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'QcLot',
      entityId: lot.id,
      after: {
        material: material.code,
        level: material.level,
        lotNumber,
        expiryDate: input.expiryDate?.toISOString() ?? null,
        analyteCount: lot.analytes.length,
        targets: input.analytes.map((a) => ({
          analyteId: a.analyteId,
          mean: a.targetMean,
          sd: a.targetSd,
        })),
      },
    });

    return {
      id: lot.id,
      lotNumber,
      material: material.name,
      level: material.level,
      analyteCount: lot.analytes.length,
    };
  }
}

@Controller({ path: 'qc', version: '1' })
class QcController {
  constructor(private readonly qc: QcService) {}

  @RequirePermissions(PERMISSIONS.QC_READ)
  @Get('lots')
  lots() {
    return this.qc.listLots();
  }

  @RequirePermissions(PERMISSIONS.QC_READ)
  @Get('results')
  results(
    @Query('analyteId') analyteId?: string,
    @Query('deviceId') deviceId?: string,
    @Query('status') status?: string,
    @Query('limit') limit = '100',
  ) {
    return this.qc.listResults({
      analyteId,
      deviceId,
      status,
      limit: Math.min(Number(limit) || 100, 500),
    });
  }

  @RequirePermissions(PERMISSIONS.QC_READ)
  @Get('failures')
  failures() {
    return this.qc.openFailures();
  }

  @RequirePermissions(PERMISSIONS.QC_ENTER)
  @Post('results')
  record(@Body(zodPipe(recordQcSchema)) body: z.infer<typeof recordQcSchema>) {
    return this.qc.record(body);
  }

  @RequirePermissions(PERMISSIONS.QC_READ)
  @Get('materials')
  materials() {
    return this.qc.listMaterials();
  }

  @RequirePermissions(PERMISSIONS.QC_MANAGE)
  @Post('materials')
  createMaterial(@Body(zodPipe(createMaterialSchema)) body: z.infer<typeof createMaterialSchema>) {
    return this.qc.createMaterial(body);
  }

  @RequirePermissions(PERMISSIONS.QC_MANAGE)
  @Post('lots')
  createLot(@Body(zodPipe(createLotSchema)) body: z.infer<typeof createLotSchema>) {
    return this.qc.createLot(body);
  }

  @RequirePermissions(PERMISSIONS.QC_OVERRIDE)
  @Post('results/:id/accept')
  accept(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(acceptQcSchema)) body: { actionTaken: string },
  ) {
    return this.qc.accept(id, body.actionTaken);
  }
}

@Module({
  controllers: [QcController],
  providers: [QcService],
  exports: [QcService],
})
export class QcModule {}
