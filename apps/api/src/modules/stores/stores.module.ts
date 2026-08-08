import {
  Body,
  Controller,
  Get,
  Global,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS, reasonSchema } from '@labsetu/contracts';
import { StoresService } from './stores.service';
import { SpecificationsService } from './specifications.service';
import { SamplingService } from './sampling.service';
import { QaService } from './qa.service';
import { OosDetectorService } from './oos-detector.service';
import { CoaService } from './coa.service';
import { WorkflowModule } from '../workflow/workflow.module';
import { AuthModule } from '../auth/auth.module';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';

const MATERIAL_TYPES = [
  'API',
  'RAW_MATERIAL',
  'PACKAGING',
  'INTERMEDIATE',
  'BULK',
  'FINISHED_PRODUCT',
] as const;

const createMaterialSchema = z.object({
  code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(2).max(200),
  type: z.enum(MATERIAL_TYPES),
  unit: z.string().trim().min(1).max(20),
  manufacturer: z.string().trim().max(150).optional(),
  pharmacopoeia: z.string().trim().max(60).optional(),
  storageCondition: z.string().trim().max(120).optional(),
  retestPeriodDays: z.coerce.number().int().positive().max(3650).optional(),
  handlingNotes: z.string().trim().max(500).optional(),
});

const receiveSchema = z.object({
  labId: z.string().uuid(),
  supplierName: z.string().trim().min(2).max(150),
  invoiceRef: z.string().trim().max(60).optional(),
  poReference: z.string().trim().max(60).optional(),
  supplierBatchRef: z.string().trim().max(60).optional(),
  receiptCheckNote: z.string().trim().max(500).optional(),
  batches: z
    .array(
      z.object({
        materialId: z.string().uuid(),
        batchNumber: z.string().trim().min(1).max(60),
        manufacturerLot: z.string().trim().max(60).optional(),
        quantity: z.coerce.number().positive(),
        unit: z.string().trim().max(20).optional(),
        containerCount: z.coerce.number().int().positive().optional(),
        manufacturedAt: z.coerce.date().optional(),
        expiryDate: z.coerce.date().optional(),
        location: z.string().trim().max(60).optional(),
      }),
    )
    .min(1),
});

const issueSchema = z.object({
  quantity: z.coerce.number().positive(),
  reference: z
    .string()
    .trim()
    .min(3, 'Name the production order or batch sheet this is issued against')
    .max(120),
});

const moveSchema = z.object({
  location: z.string().trim().min(1).max(60),
  reason: reasonSchema,
});

const specLimitSchema = z.object({
  analyteId: z.string().uuid(),
  testDefinitionId: z.string().uuid().optional(),
  minValue: z.coerce.number().optional(),
  maxValue: z.coerce.number().optional(),
  textCriteria: z.string().trim().max(200).optional(),
  unit: z.string().trim().max(30).optional(),
  isCritical: z.boolean().optional(),
});

const createSpecSchema = z.object({
  materialId: z.string().uuid(),
  code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_/-]+$/),
  basis: z.string().trim().max(120).optional(),
  limits: z.array(specLimitSchema).min(1),
});

const approveSpecSchema = z.object({
  effectiveFrom: z.coerce.date().optional(),
  note: z
    .string()
    .trim()
    .min(5, 'Record the basis for approval — an inspector reads this')
    .max(300),
});

const samplingRequestSchema = z.object({
  batchId: z.string().uuid(),
  reason: z
    .enum(['RELEASE_TESTING', 'RETEST', 'OOS_RESAMPLE', 'STABILITY', 'COMPLAINT_INVESTIGATION'])
    .default('RELEASE_TESTING'),
  note: z.string().trim().max(300).optional(),
});

const performSamplingSchema = z.object({
  labId: z.string().uuid(),
  containersSampled: z.coerce.number().int().positive().optional(),
  quantitySampled: z.coerce.number().positive().optional(),
  note: z.string().trim().max(300).optional(),
});

const dispositionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED', 'APPROVED_WITH_DEVIATION', 'RETEST_REQUIRED']),
  rationale: z
    .string()
    .trim()
    .min(10, 'A disposition without a stated basis is a rubber stamp')
    .max(1000),
  deviationRef: z.string().trim().max(60).optional(),
  signingToken: z.string().min(1),
});

const progressOosSchema = z.object({
  phase: z.enum(['PHASE_I', 'PHASE_II']).optional(),
  labInvestigationNote: z.string().trim().max(1000).optional(),
  manufacturingNote: z.string().trim().max(1000).optional(),
  rootCause: z.string().trim().max(500).optional(),
});

const closeOosSchema = z.object({
  conclusion: z.enum([
    'LAB_ERROR_CONFIRMED',
    'MANUFACTURING_CONFIRMED',
    'NO_ASSIGNABLE_CAUSE',
    'INVALIDATED_RESAMPLED',
  ]),
  rootCause: z.string().trim().min(10, 'State the root cause').max(500),
  correctiveAction: z
    .string()
    .trim()
    .min(10, 'State the corrective action — a closed investigation with none is not closed')
    .max(500),
});

@Controller({ path: 'stores', version: '1' })
class StoresController {
  constructor(
    private readonly stores: StoresService,
    private readonly sampling: SamplingService,
  ) {}

  @RequirePermissions(PERMISSIONS.STORES_READ)
  @Get('materials')
  materials(@Query('type') type?: string) {
    return this.stores.listMaterials(type);
  }

  @RequirePermissions(PERMISSIONS.MATERIAL_MANAGE)
  @Post('materials')
  createMaterial(@Body(zodPipe(createMaterialSchema)) body: z.infer<typeof createMaterialSchema>) {
    return this.stores.createMaterial(body);
  }

  /** What needs attention today. Declared before :id routes. */
  @RequirePermissions(PERMISSIONS.STORES_READ)
  @Get('alerts')
  alerts() {
    return this.stores.alerts();
  }

  @RequirePermissions(PERMISSIONS.STORES_READ)
  @Get('batches')
  batches(
    @Query('status') status?: string,
    @Query('materialId') materialId?: string,
    @Query('type') type?: string,
    @Query('search') search?: string,
  ) {
    return this.stores.listBatches({ status, materialId, type, search });
  }

  @RequirePermissions(PERMISSIONS.STORES_READ)
  @Get('batches/:id')
  batch(@Param('id', ParseUUIDPipe) id: string) {
    return this.stores.getBatch(id);
  }

  @RequirePermissions(PERMISSIONS.STORES_MANAGE)
  @Post('receive')
  receive(@Body(zodPipe(receiveSchema)) body: z.infer<typeof receiveSchema>) {
    return this.stores.receiveGoods(body);
  }

  /** Refused unless the batch is QA-approved. */
  @RequirePermissions(PERMISSIONS.STORES_MANAGE)
  @Post('batches/:id/issue')
  issue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(issueSchema)) body: z.infer<typeof issueSchema>,
  ) {
    return this.stores.issue(id, body.quantity, body.reference);
  }

  @RequirePermissions(PERMISSIONS.STORES_MANAGE)
  @Post('batches/:id/move')
  move(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(moveSchema)) body: { location: string; reason: string },
  ) {
    return this.stores.move(id, body.location, body.reason);
  }

  // --- sampling -------------------------------------------------------------

  @RequirePermissions(PERMISSIONS.STORES_READ)
  @Get('sampling-requests')
  samplingRequests(@Query('status') status?: string) {
    return this.sampling.listRequests(status);
  }

  @RequirePermissions(PERMISSIONS.SAMPLING_REQUEST)
  @Post('sampling-requests')
  requestSampling(
    @Body(zodPipe(samplingRequestSchema)) body: z.infer<typeof samplingRequestSchema>,
  ) {
    return this.sampling.request(body);
  }

  /** QC draws the sample and books the tests against the specification. */
  @RequirePermissions(PERMISSIONS.SAMPLING_PERFORM)
  @Post('sampling-requests/:id/sample')
  performSampling(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(performSamplingSchema)) body: z.infer<typeof performSamplingSchema>,
  ) {
    return this.sampling.perform(id, body);
  }

  @RequirePermissions(PERMISSIONS.SAMPLING_REQUEST)
  @Post('sampling-requests/:id/cancel')
  cancelSampling(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(z.object({ reason: reasonSchema }))) body: { reason: string },
  ) {
    return this.sampling.cancel(id, body.reason);
  }
}

@Controller({ path: 'specifications', version: '1' })
class SpecificationsController {
  constructor(private readonly specs: SpecificationsService) {}

  @RequirePermissions(PERMISSIONS.SPEC_READ)
  @Get()
  list(@Query('materialId') materialId?: string, @Query('status') status?: string) {
    return this.specs.list(materialId, status);
  }

  @RequirePermissions(PERMISSIONS.SPEC_READ)
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.specs.findOne(id);
  }

  @RequirePermissions(PERMISSIONS.SPEC_MANAGE)
  @Post()
  create(@Body(zodPipe(createSpecSchema)) body: z.infer<typeof createSpecSchema>) {
    return this.specs.create(body);
  }

  /** QA only, and never by the person who authored the draft. */
  @RequirePermissions(PERMISSIONS.SPEC_APPROVE)
  @Post(':id/approve')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(approveSpecSchema)) body: z.infer<typeof approveSpecSchema>,
  ) {
    return this.specs.approve(id, body.effectiveFrom, body.note);
  }
}

@Controller({ path: 'qa', version: '1' })
class QaController {
  constructor(
    private readonly qa: QaService,
    private readonly coa: CoaService,
  ) {}

  /** The review screen: every result judged against the specification. */
  @RequirePermissions(PERMISSIONS.STORES_READ)
  @Get('batches/:id/review')
  review(@Param('id', ParseUUIDPipe) id: string) {
    return this.qa.reviewBatch(id);
  }

  /** The hash a disposition signature binds to. */
  @RequirePermissions(PERMISSIONS.STORES_READ)
  @Get('batches/:id/content-hash')
  async contentHash(@Param('id', ParseUUIDPipe) id: string) {
    return { contentHash: await this.qa.dispositionHash(id) };
  }

  /** Release or reject. Requires a signing token. */
  @RequirePermissions(PERMISSIONS.BATCH_DISPOSITION)
  @Post('batches/:id/disposition')
  dispose(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(dispositionSchema)) body: z.infer<typeof dispositionSchema>,
  ) {
    return this.qa.dispose(id, body);
  }

  @RequirePermissions(PERMISSIONS.OOS_MANAGE)
  @Get('investigations')
  investigations(@Query('status') status?: string) {
    return this.qa.listInvestigations(status);
  }

  @RequirePermissions(PERMISSIONS.OOS_MANAGE)
  @Post('investigations/:id/progress')
  progress(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(progressOosSchema)) body: z.infer<typeof progressOosSchema>,
  ) {
    return this.qa.progressInvestigation(id, body);
  }

  @RequirePermissions(PERMISSIONS.OOS_MANAGE)
  @Post('investigations/:id/close')
  close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(closeOosSchema)) body: z.infer<typeof closeOosSchema>,
  ) {
    return this.qa.closeInvestigation(id, body);
  }

  @RequirePermissions(PERMISSIONS.COA_ISSUE)
  @Post('batches/:id/coa')
  issueCoa(@Param('id', ParseUUIDPipe) id: string) {
    return this.coa.issue(id);
  }

  @RequirePermissions(PERMISSIONS.STORES_READ)
  @Get('coa/:id')
  getCoa(@Param('id', ParseUUIDPipe) id: string) {
    return this.coa.findOne(id);
  }
}

/**
 * Manufacturing QC.
 *
 * Global because OosDetectorService is called from ResultsService: a value that
 * breaches specification must open an investigation wherever the result was
 * entered, including from the instrument ingest path.
 */
@Global()
@Module({
  imports: [WorkflowModule, AuthModule],
  controllers: [StoresController, SpecificationsController, QaController],
  providers: [
    StoresService,
    SpecificationsService,
    SamplingService,
    QaService,
    OosDetectorService,
    CoaService,
  ],
  exports: [OosDetectorService, SpecificationsService],
})
export class StoresModule {}
