import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@labsetu/contracts';
import { CatalogService } from './catalog.service';
import { CatalogAdminService } from './catalog-admin.service';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';

const DEPARTMENTS = [
  'BIOCHEMISTRY',
  'HAEMATOLOGY',
  'MICROBIOLOGY',
  'SEROLOGY',
  'IMMUNOLOGY',
  'HISTOPATHOLOGY',
  'CYTOLOGY',
  'MOLECULAR',
  'CLINICAL_PATHOLOGY',
  'RADIOLOGY',
] as const;

const analyteLinkSchema = z.object({
  analyteId: z.string().uuid(),
  sortOrder: z.coerce.number().int().min(0).optional(),
  formula: z.string().trim().max(300).optional(),
  isMandatory: z.boolean().optional(),
});

const createTestSchema = z.object({
  code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only'),
  name: z.string().trim().min(2).max(200),
  shortName: z.string().trim().max(60).optional(),
  department: z.enum(DEPARTMENTS),
  price: z.coerce.number().nonnegative().max(1_000_000),
  tatMinutes: z.coerce.number().int().positive().max(100_000).optional(),
  sacCode: z.string().trim().max(12).optional(),
  specimenTypeId: z.string().uuid().optional(),
  containerTypeId: z.string().uuid().optional(),
  methodId: z.string().uuid().optional(),
  minVolumeMl: z.coerce.number().positive().optional(),
  instructions: z.string().trim().max(1000).optional(),
  requiresVerification: z.boolean().optional(),
  isOutsourced: z.boolean().optional(),
  analytes: z.array(analyteLinkSchema).min(1),
});

const updateTestSchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  shortName: z.string().trim().max(60).nullable().optional(),
  price: z.coerce.number().nonnegative().max(1_000_000).optional(),
  tatMinutes: z.coerce.number().int().positive().max(100_000).nullable().optional(),
  instructions: z.string().trim().max(1000).nullable().optional(),
  requiresVerification: z.boolean().optional(),
  isActive: z.boolean().optional(),
  analytes: z.array(analyteLinkSchema).min(1).optional(),
  reason: z.string().trim().max(300).optional(),
});

const createAnalyteSchema = z.object({
  code: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(2).max(200),
  valueType: z.enum(['NUMERIC', 'TEXT', 'QUALITATIVE', 'TITRE', 'NUMERIC_BOUNDED']),
  defaultUnit: z.string().trim().max(30).optional(),
  precision: z.coerce.number().int().min(0).max(6).optional(),
  allowedValues: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  loincCode: z.string().trim().max(20).optional(),
});

const createRangeSchema = z.object({
  analyteId: z.string().uuid(),
  sex: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNKNOWN']).optional(),
  minAgeDays: z.coerce.number().int().min(0).optional(),
  maxAgeDays: z.coerce.number().int().min(0).optional(),
  condition: z.string().trim().max(60).optional(),
  lowValue: z.coerce.number().optional(),
  highValue: z.coerce.number().optional(),
  criticalLow: z.coerce.number().optional(),
  criticalHigh: z.coerce.number().optional(),
  displayText: z.string().trim().max(200).optional(),
  unit: z.string().trim().max(30).optional(),
  effectiveFrom: z.coerce.date().optional(),
  supersedesId: z.string().uuid().optional(),
});

const createPanelSchema = z.object({
  code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(2).max(200),
  price: z.coerce.number().nonnegative().max(1_000_000),
  testDefinitionIds: z.array(z.string().uuid()).min(2),
});

const updatePanelSchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  price: z.coerce.number().nonnegative().max(1_000_000).optional(),
  isActive: z.boolean().optional(),
});

const createDoctorSchema = z.object({
  code: z.string().trim().max(30).optional(),
  name: z.string().trim().min(2).max(150),
  qualification: z.string().trim().max(120).optional(),
  registrationNo: z.string().trim().max(60).optional(),
  speciality: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().email().max(150).optional(),
  commissionPct: z.coerce.number().min(0).max(100).optional(),
});

const updateDoctorSchema = z.object({
  name: z.string().trim().min(2).max(150).optional(),
  qualification: z.string().trim().max(120).nullable().optional(),
  registrationNo: z.string().trim().max(60).nullable().optional(),
  speciality: z.string().trim().max(80).nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  email: z.string().trim().email().max(150).nullable().optional(),
  commissionPct: z.coerce.number().min(0).max(100).nullable().optional(),
  isActive: z.boolean().optional(),
});

@Controller({ path: 'catalog', version: '1' })
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly admin: CatalogAdminService,
  ) {}

  // --- read -----------------------------------------------------------------

  @RequirePermissions(PERMISSIONS.CATALOG_READ)
  @Get('tests')
  tests(@Query('department') department?: string) {
    return this.catalog.listTests(department);
  }

  @RequirePermissions(PERMISSIONS.CATALOG_READ)
  @Get('panels')
  panels() {
    return this.catalog.listPanels();
  }

  /** Everything the front desk and bench screens need to render dropdowns. */
  @RequirePermissions(PERMISSIONS.CATALOG_READ)
  @Get('reference-data')
  referenceData() {
    return this.catalog.referenceData();
  }

  @RequirePermissions(PERMISSIONS.CATALOG_READ)
  @Get('analytes')
  analytes() {
    return this.admin.listAnalytes();
  }

  @RequirePermissions(PERMISSIONS.CATALOG_READ)
  @Get('doctors')
  doctors(@Query('includeInactive') includeInactive?: string) {
    return this.admin.listDoctors(includeInactive === 'true');
  }

  @RequirePermissions(PERMISSIONS.CATALOG_READ)
  @Get('analytes/:id/ranges')
  ranges(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.listRanges(id);
  }

  // --- write ----------------------------------------------------------------

  @RequirePermissions(PERMISSIONS.CATALOG_MANAGE)
  @Post('tests')
  createTest(@Body(zodPipe(createTestSchema)) body: z.infer<typeof createTestSchema>) {
    return this.admin.createTest(body);
  }

  @RequirePermissions(PERMISSIONS.CATALOG_MANAGE)
  @Patch('tests/:id')
  updateTest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(updateTestSchema)) body: z.infer<typeof updateTestSchema>,
  ) {
    const { reason, ...rest } = body;
    return this.admin.updateTest(id, rest, reason);
  }

  @RequirePermissions(PERMISSIONS.CATALOG_MANAGE)
  @Post('analytes')
  createAnalyte(@Body(zodPipe(createAnalyteSchema)) body: z.infer<typeof createAnalyteSchema>) {
    return this.admin.createAnalyte(body);
  }

  @RequirePermissions(PERMISSIONS.CATALOG_MANAGE)
  @Post('ranges')
  createRange(@Body(zodPipe(createRangeSchema)) body: z.infer<typeof createRangeSchema>) {
    return this.admin.createRange(body);
  }

  @RequirePermissions(PERMISSIONS.CATALOG_MANAGE)
  @Post('panels')
  createPanel(@Body(zodPipe(createPanelSchema)) body: z.infer<typeof createPanelSchema>) {
    return this.admin.createPanel(body);
  }

  @RequirePermissions(PERMISSIONS.CATALOG_MANAGE)
  @Patch('panels/:id')
  updatePanel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(updatePanelSchema)) body: z.infer<typeof updatePanelSchema>,
  ) {
    return this.admin.updatePanel(id, body);
  }

  @RequirePermissions(PERMISSIONS.CATALOG_MANAGE)
  @Post('doctors')
  createDoctor(@Body(zodPipe(createDoctorSchema)) body: z.infer<typeof createDoctorSchema>) {
    return this.admin.createDoctor(body);
  }

  @RequirePermissions(PERMISSIONS.CATALOG_MANAGE)
  @Patch('doctors/:id')
  updateDoctor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(updateDoctorSchema)) body: z.infer<typeof updateDoctorSchema>,
  ) {
    return this.admin.updateDoctor(id, body);
  }
}
