import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@labsetu/contracts';
import { QualityService } from './quality.service';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';

/**
 * Free text that has to earn its place.
 *
 * Minimum lengths are not padding: a deviation described as "spill" or an
 * investigation recorded as "checked" is a record that fails the person reading
 * it a year later, which is the only person it exists for.
 */
const raiseDeviationSchema = z.object({
  title: z.string().trim().min(8).max(200),
  description: z
    .string()
    .trim()
    .min(30, 'Describe what happened — the reader was not there'),
  category: z.enum([
    'PROCESS',
    'EQUIPMENT',
    'DOCUMENTATION',
    'UTILITY',
    'MATERIAL',
    'PERSONNEL',
    'ENVIRONMENTAL',
    'OTHER',
  ]),
  occurredAt: z.string().min(8),
  detectedAt: z.string().min(8),
  batchId: z.string().uuid().optional(),
  deviceId: z.string().uuid().optional(),
  labId: z.string().uuid().optional(),
});

const investigateSchema = z.object({
  investigation: z
    .string()
    .trim()
    .min(30, 'Record what was actually looked at, not that looking happened'),
  rootCause: z.string().trim().max(2000).optional(),
  impactAssessment: z.string().trim().max(2000).optional(),
});

const closeDeviationSchema = z.object({
  rootCause: z
    .string()
    .trim()
    .min(20, 'A closed deviation with no root cause says only that somebody stopped looking'),
  severity: z.enum(['MINOR', 'MAJOR', 'CRITICAL']),
  productImpact: z.enum(['NONE', 'POTENTIAL', 'CONFIRMED']),
  impactAssessment: z.string().trim().max(2000).optional(),
});

const raiseCapaSchema = z.object({
  title: z.string().trim().min(8).max(200),
  description: z.string().trim().min(20),
  kind: z.enum(['CORRECTION', 'CORRECTIVE', 'PREVENTIVE']),
  ownerId: z.string().uuid(),
  dueAt: z.string().min(8),
  deviationId: z.string().uuid().optional(),
  oosId: z.string().uuid().optional(),
  changeControlId: z.string().uuid().optional(),
  effectivenessDueAt: z.string().min(8).optional(),
});

const completeCapaSchema = z.object({
  completionNote: z.string().trim().min(20, 'Say what was done, not that it was done'),
  effectivenessDueAt: z.string().min(8).optional(),
});

const effectivenessSchema = z.object({
  verdict: z.enum(['EFFECTIVE', 'NOT_EFFECTIVE', 'TOO_EARLY_TO_TELL']),
  note: z.string().trim().min(20, 'Record the evidence the verdict rests on'),
});

@Controller({ path: 'quality', version: '1' })
export class QualityController {
  constructor(private readonly quality: QualityService) {}

  // ------------------------------------------------------------- deviations

  @RequirePermissions(PERMISSIONS.DEVIATION_READ)
  @Get('deviations')
  listDeviations(@Query('status') status?: string, @Query('batchId') batchId?: string) {
    return this.quality.listDeviations({ status, batchId });
  }

  /**
   * Anyone who works on the floor can RAISE one. Deliberately a wide grant: a
   * deviation nobody felt able to report is the most expensive kind, and the
   * control that matters is on closing it, not on noticing it.
   */
  @RequirePermissions(PERMISSIONS.DEVIATION_RAISE)
  @Post('deviations')
  raiseDeviation(@Body(zodPipe(raiseDeviationSchema)) body: z.infer<typeof raiseDeviationSchema>) {
    return this.quality.raiseDeviation({
      ...body,
      occurredAt: new Date(body.occurredAt),
      detectedAt: new Date(body.detectedAt),
    });
  }

  @RequirePermissions(PERMISSIONS.DEVIATION_MANAGE)
  @Post('deviations/:id/investigate')
  investigate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(investigateSchema)) body: z.infer<typeof investigateSchema>,
  ) {
    return this.quality.investigateDeviation(id, body);
  }

  @RequirePermissions(PERMISSIONS.DEVIATION_CLOSE)
  @Post('deviations/:id/close')
  closeDeviation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(closeDeviationSchema)) body: z.infer<typeof closeDeviationSchema>,
  ) {
    return this.quality.closeDeviation(id, body);
  }

  // -------------------------------------------------------------------- CAPA

  @RequirePermissions(PERMISSIONS.CAPA_READ)
  @Get('capa')
  listCapas(@Query('status') status?: string, @Query('overdue') overdue?: string) {
    return this.quality.listCapas({ status, overdueOnly: overdue === 'true' });
  }

  @RequirePermissions(PERMISSIONS.CAPA_MANAGE)
  @Post('capa')
  raiseCapa(@Body(zodPipe(raiseCapaSchema)) body: z.infer<typeof raiseCapaSchema>) {
    return this.quality.raiseCapa({
      ...body,
      dueAt: new Date(body.dueAt),
      effectivenessDueAt: body.effectivenessDueAt
        ? new Date(body.effectivenessDueAt)
        : undefined,
    });
  }

  @RequirePermissions(PERMISSIONS.CAPA_MANAGE)
  @Post('capa/:id/complete')
  completeCapa(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(completeCapaSchema)) body: z.infer<typeof completeCapaSchema>,
  ) {
    return this.quality.completeCapa(id, {
      completionNote: body.completionNote,
      effectivenessDueAt: body.effectivenessDueAt
        ? new Date(body.effectivenessDueAt)
        : undefined,
    });
  }

  /**
   * Verifying effectiveness sits behind CAPA_VERIFY rather than CAPA_MANAGE.
   * The person who did the work should not be the one certifying it worked —
   * the same reasoning as four-eyes on a result.
   */
  @RequirePermissions(PERMISSIONS.CAPA_VERIFY)
  @Post('capa/:id/effectiveness')
  checkEffectiveness(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(effectivenessSchema)) body: z.infer<typeof effectivenessSchema>,
  ) {
    return this.quality.checkCapaEffectiveness(id, body);
  }
}

@Module({
  controllers: [QualityController],
  providers: [QualityService],
  exports: [QualityService],
})
export class QualityModule {}
