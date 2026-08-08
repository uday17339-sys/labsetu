import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  generateReportSchema,
  releaseReportSchema,
  amendReportSchema,
  PERMISSIONS,
} from '@labsetu/contracts';
import { ReportsService } from './reports.service';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import { WorkflowModule } from '../workflow/workflow.module';

@Controller({ path: 'reports', version: '1' })
class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RequirePermissions(PERMISSIONS.REPORT_GENERATE)
  @Post()
  generate(@Body(zodPipe(generateReportSchema)) body: { orderId: string; isPartial: boolean; sampleTestIds?: string[] }) {
    return this.reports.generate(body.orderId, body.isPartial, body.sampleTestIds);
  }

  /** The register. Declared before :id so 'search' is never read as a UUID. */
  @RequirePermissions(PERMISSIONS.REPORT_READ)
  @Get()
  list(
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const end = to ? new Date(to) : undefined;
    if (end && /^\d{4}-\d{2}-\d{2}$/.test(to!)) end.setUTCHours(23, 59, 59, 999);
    return this.reports.list({
      status,
      search,
      from: from ? new Date(from) : undefined,
      to: end,
      limit: Math.min(Number(limit) || 25, 100),
      cursor,
    });
  }

  @RequirePermissions(PERMISSIONS.REPORT_READ)
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.reports.findOne(id);
  }

  /** Hash to bind a signature to — fetch this, then request a signing token. */
  @RequirePermissions(PERMISSIONS.REPORT_READ)
  @Get(':id/content-hash')
  async contentHash(@Param('id', ParseUUIDPipe) id: string) {
    return { contentHash: await this.reports.contentHash(id) };
  }

  @RequirePermissions(PERMISSIONS.REPORT_RELEASE)
  @Post(':id/release')
  release(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(releaseReportSchema)) body: { signingToken: string; deliverTo: { channel: string; destination?: string }[] },
  ) {
    return this.reports.release(id, body.signingToken, body.deliverTo);
  }

  @RequirePermissions(PERMISSIONS.REPORT_AMEND)
  @Post(':id/amend')
  amend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(amendReportSchema)) body: { signingToken: string; reason: string },
  ) {
    return this.reports.amend(id, body.signingToken, body.reason);
  }
}

@Module({
  imports: [WorkflowModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
