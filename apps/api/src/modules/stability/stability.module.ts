import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@labsetu/contracts';
import { StabilityService } from './stability.service';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';

const protocolSchema = z.object({
  code: z.string().trim().min(3).max(40),
  name: z.string().trim().min(5).max(200),
  /// Free text on purpose: conditions are written as the monograph states them
  /// ("25 °C / 60 % RH", "5 °C ± 3 °C"), and an enum would fight the source.
  storageCondition: z.string().trim().min(3).max(80),
  studyType: z.enum(['LONG_TERM', 'ACCELERATED', 'INTERMEDIATE', 'STRESS', 'ONGOING']),
  timepointsMonths: z.array(z.coerce.number().int().min(0).max(120)).min(1),
  testCodes: z.array(z.string().trim().min(1)).min(1),
  orientation: z.string().trim().max(60).optional(),
});

const startStudySchema = z.object({
  protocolId: z.string().uuid(),
  batchId: z.string().uuid(),
  startedAt: z.string().min(8),
  chamber: z.string().trim().max(80).optional(),
});

const recordPullSchema = z.object({
  sampleId: z.string().uuid().optional(),
  note: z.string().trim().max(500).optional(),
});

const missedSchema = z.object({
  note: z
    .string()
    .trim()
    .min(15, 'A missed timepoint needs a reason — it is a gap in the shelf-life evidence'),
});

@Controller({ path: 'stability', version: '1' })
export class StabilityController {
  constructor(private readonly stability: StabilityService) {}

  @RequirePermissions(PERMISSIONS.STABILITY_READ)
  @Get('protocols')
  listProtocols() {
    return this.stability.listProtocols();
  }

  @RequirePermissions(PERMISSIONS.STABILITY_MANAGE)
  @Post('protocols')
  createProtocol(@Body(zodPipe(protocolSchema)) body: z.infer<typeof protocolSchema>) {
    return this.stability.createProtocol(body);
  }

  @RequirePermissions(PERMISSIONS.STABILITY_READ)
  @Get('studies')
  listStudies(@Query('status') status?: string) {
    return this.stability.listStudies({ status });
  }

  @RequirePermissions(PERMISSIONS.STABILITY_READ)
  @Get('studies/:id')
  getStudy(@Param('id', ParseUUIDPipe) id: string) {
    return this.stability.getStudy(id);
  }

  @RequirePermissions(PERMISSIONS.STABILITY_MANAGE)
  @Post('studies')
  startStudy(@Body(zodPipe(startStudySchema)) body: z.infer<typeof startStudySchema>) {
    return this.stability.startStudy({
      ...body,
      startedAt: new Date(body.startedAt),
    });
  }

  /**
   * The queue an analyst opens on a Monday: what falls due, and what has
   * already slipped.
   */
  @RequirePermissions(PERMISSIONS.STABILITY_READ)
  @Get('pulls')
  listPulls(@Query('status') status?: string, @Query('withinDays') withinDays?: string) {
    return this.stability.listPulls({
      status,
      withinDays: withinDays ? Number(withinDays) : undefined,
    });
  }

  @RequirePermissions(PERMISSIONS.STABILITY_MANAGE)
  @Post('pulls/:id/record')
  recordPull(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(recordPullSchema)) body: z.infer<typeof recordPullSchema>,
  ) {
    return this.stability.recordPull(id, body);
  }

  @RequirePermissions(PERMISSIONS.STABILITY_MANAGE)
  @Post('pulls/:id/missed')
  markMissed(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(missedSchema)) body: z.infer<typeof missedSchema>,
  ) {
    return this.stability.markMissed(id, body);
  }
}

@Module({
  controllers: [StabilityController],
  providers: [StabilityService],
  exports: [StabilityService],
})
export class StabilityModule {}
