import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS } from '@labsetu/contracts';
import { EnvironmentalService } from './environmental.service';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';

const locationSchema = z.object({
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(3).max(200),
  /// Free text: Indian sites run Annex 1 grades, ISO classes and unclassified
  /// utility points on one programme, and an enum would fight that.
  grade: z.string().trim().min(1).max(20),
  monitoringType: z.enum([
    'VIABLE_AIR',
    'NON_VIABLE_PARTICLE',
    'SURFACE',
    'PERSONNEL',
    'UTILITY_WATER',
    'COMPRESSED_GAS',
    'TEMPERATURE_HUMIDITY',
    'DIFFERENTIAL_PRESSURE',
  ]),
  unit: z.string().trim().min(1).max(30),
  alertLimit: z.coerce.number().optional(),
  actionLimit: z.coerce.number().optional(),
  roomRef: z.string().trim().max(80).optional(),
  frequencyDays: z.coerce.number().int().positive().max(365).optional(),
});

const readingSchema = z.object({
  locationId: z.string().uuid(),
  value: z.coerce.number().min(0),
  sampledAt: z.string().min(8),
  shift: z.string().trim().max(40).optional(),
  note: z.string().trim().max(1000).optional(),
});

@Controller({ path: 'environmental', version: '1' })
export class EnvironmentalController {
  constructor(private readonly em: EnvironmentalService) {}

  @RequirePermissions(PERMISSIONS.EM_READ)
  @Get('locations')
  listLocations() {
    return this.em.listLocations();
  }

  @RequirePermissions(PERMISSIONS.EM_MANAGE)
  @Post('locations')
  createLocation(@Body(zodPipe(locationSchema)) body: z.infer<typeof locationSchema>) {
    return this.em.createLocation(body);
  }

  @RequirePermissions(PERMISSIONS.EM_READ)
  @Get('readings')
  listReadings(
    @Query('locationId') locationId?: string,
    @Query('verdict') verdict?: string,
    @Query('days') days?: string,
  ) {
    return this.em.listReadings({
      locationId,
      verdict,
      days: days ? Number(days) : undefined,
    });
  }

  @RequirePermissions(PERMISSIONS.EM_RECORD)
  @Post('readings')
  recordReading(@Body(zodPipe(readingSchema)) body: z.infer<typeof readingSchema>) {
    return this.em.recordReading({ ...body, sampledAt: new Date(body.sampledAt) });
  }

  /**
   * Trend rather than event. A single action breach is a deviation; a rising
   * alert rate across a grade is what predicts one, and no single reading
   * shows it.
   */
  @RequirePermissions(PERMISSIONS.EM_READ)
  @Get('summary')
  summary(@Query('days') days?: string) {
    return this.em.summary(days ? Number(days) : undefined);
  }
}

@Module({
  controllers: [EnvironmentalController],
  providers: [EnvironmentalService],
  exports: [EnvironmentalService],
})
export class EnvironmentalModule {}
