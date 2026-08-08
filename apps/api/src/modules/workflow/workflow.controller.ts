import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  createOrderSchema,
  collectSampleSchema,
  receiveSampleSchema,
  rejectSampleSchema,
  sampleQuerySchema,
  worklistQuerySchema,
  enterResultsSchema,
  verifyTestSchema,
  authorizeTestSchema,
  rerunTestSchema,
  criticalCallbackSchema,
  PERMISSIONS,
  type CriticalCallbackInput,
} from '@labsetu/contracts';
import { OrdersService } from './orders.service';
import { SamplesService } from './samples.service';
import { ResultsService } from './results.service';
import { CriticalValuesService } from './critical-values.service';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';

@Controller({ version: '1' })
export class WorkflowController {
  constructor(
    private readonly orders: OrdersService,
    private readonly samples: SamplesService,
    private readonly results: ResultsService,
    private readonly critical: CriticalValuesService,
  ) {}

  // --- orders ---------------------------------------------------------------

  @RequirePermissions(PERMISSIONS.ORDER_CREATE)
  @Post('orders')
  createOrder(@Body(zodPipe(createOrderSchema)) body: unknown) {
    return this.orders.create(body as never);
  }

  @RequirePermissions(PERMISSIONS.ORDER_READ)
  @Get('orders')
  listOrders(
    @Query('labId') labId?: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit = '50',
  ) {
    return this.orders.list({ labId, status, cursor, limit: Math.min(Number(limit) || 50, 200) });
  }

  @RequirePermissions(PERMISSIONS.ORDER_READ)
  @Get('orders/:id')
  getOrder(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.findOne(id);
  }

  // --- samples --------------------------------------------------------------

  @RequirePermissions(PERMISSIONS.SAMPLE_READ)
  @Get('samples')
  listSamples(@Query(zodPipe(sampleQuerySchema)) q: never) {
    return this.samples.list(q);
  }

  /**
   * Barcode scan lands here. Separate from :id so a scanner can be pointed at
   * this route directly without the UI resolving an id first.
   */
  @RequirePermissions(PERMISSIONS.SAMPLE_READ)
  @Get('samples/by-accession/:accessionNumber')
  byAccession(@Param('accessionNumber') accessionNumber: string) {
    return this.samples.findByAccession(accessionNumber);
  }

  @RequirePermissions(PERMISSIONS.SAMPLE_READ)
  @Get('samples/:id')
  getSample(@Param('id', ParseUUIDPipe) id: string) {
    return this.samples.findOne(id);
  }

  @RequirePermissions(PERMISSIONS.SAMPLE_COLLECT)
  @Post('samples/:id/collect')
  collect(@Param('id', ParseUUIDPipe) id: string, @Body(zodPipe(collectSampleSchema)) body: never) {
    return this.samples.collect(id, body);
  }

  @RequirePermissions(PERMISSIONS.SAMPLE_RECEIVE)
  @Post('samples/:id/receive')
  receive(@Param('id', ParseUUIDPipe) id: string, @Body(zodPipe(receiveSampleSchema)) body: never) {
    return this.samples.receive(id, body);
  }

  @RequirePermissions(PERMISSIONS.SAMPLE_REJECT)
  @Post('samples/:id/reject')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(rejectSampleSchema)) body: { rejectionReasonId: string; note?: string },
  ) {
    return this.samples.reject(id, body.rejectionReasonId, body.note);
  }

  // --- worklist & results ---------------------------------------------------

  @RequirePermissions(PERMISSIONS.RESULT_READ)
  @Get('worklist')
  worklist(@Query(zodPipe(worklistQuerySchema)) q: never) {
    return this.samples.worklist(q);
  }

  @RequirePermissions(PERMISSIONS.RESULT_READ)
  @Get('tests/:id')
  getTest(@Param('id', ParseUUIDPipe) id: string) {
    return this.results.getTest(id);
  }

  /**
   * The hash the client must present when requesting a signing token. Exposed so
   * the UI can bind a signature to exactly the content the user is looking at.
   */
  @RequirePermissions(PERMISSIONS.RESULT_READ)
  @Get('tests/:id/content-hash')
  async contentHash(@Param('id', ParseUUIDPipe) id: string) {
    return { contentHash: await this.results.contentHash(id) };
  }

  @RequirePermissions(PERMISSIONS.RESULT_ENTER)
  @Post('tests/:id/results')
  enterResults(@Param('id', ParseUUIDPipe) id: string, @Body(zodPipe(enterResultsSchema)) body: never) {
    return this.results.enterResults(id, body);
  }

  @RequirePermissions(PERMISSIONS.RESULT_VERIFY)
  @Post('tests/:id/verify')
  verify(@Param('id', ParseUUIDPipe) id: string, @Body(zodPipe(verifyTestSchema)) body: { note?: string }) {
    return this.results.verify(id, body.note);
  }

  /** Requires a signing token from POST /v1/auth/signing-token. */
  @RequirePermissions(PERMISSIONS.RESULT_AUTHORIZE)
  @Post('tests/:id/authorize')
  authorize(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(authorizeTestSchema)) body: { signingToken: string; meaning: string; note?: string },
  ) {
    return this.results.authorize(id, body.signingToken, body.meaning, body.note);
  }

  @RequirePermissions(PERMISSIONS.RESULT_RERUN)
  @Post('tests/:id/rerun')
  rerun(@Param('id', ParseUUIDPipe) id: string, @Body(zodPipe(rerunTestSchema)) body: { reason: string }) {
    return this.results.rerun(id, body.reason);
  }

  // --- critical values ------------------------------------------------------

  /** The callback worklist: flagged, current, and nobody has phoned yet. */
  @RequirePermissions(PERMISSIONS.RESULT_READ)
  @Get('critical-values')
  criticalValues(@Query('includeNotified') includeNotified?: string) {
    return this.critical.pending(includeNotified === 'true');
  }

  @RequirePermissions(PERMISSIONS.RESULT_READ)
  @Get('critical-values/performance')
  criticalPerformance(@Query('from') from?: string, @Query('to') to?: string) {
    const now = new Date();
    return this.critical.performance(
      from ? new Date(from) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      to ? new Date(to) : now,
    );
  }

  /** Records the phone call. Read-back is mandatory — see the service. */
  @RequirePermissions(PERMISSIONS.RESULT_CALLBACK)
  @Post('results/:id/callback')
  recordCallback(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(criticalCallbackSchema)) body: CriticalCallbackInput,
  ) {
    return this.critical.recordCallback(id, body);
  }
}
