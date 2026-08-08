import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  createPatientSchema,
  updatePatientSchema,
  patientSearchSchema,
  erasePatientSchema,
  PERMISSIONS,
  type UpdatePatientInput,
} from '@labsetu/contracts';
import { PatientsService } from './patients.service';
import { PatientHistoryService } from './history.service';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';

@Controller({ path: 'patients', version: '1' })
export class PatientsController {
  constructor(
    private readonly patients: PatientsService,
    private readonly history: PatientHistoryService,
  ) {}

  /**
   * Cumulative view: the same analyte across time, side by side.
   *
   * Declared BEFORE :id so 'history' is never captured as a UUID param.
   */
  @RequirePermissions(PERMISSIONS.RESULT_READ)
  @Get(':id/history')
  cumulative(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('analyteIds') analyteIds?: string,
  ) {
    return this.history.cumulative(id, {
      analyteIds: analyteIds ? analyteIds.split(',').filter(Boolean) : undefined,
    });
  }

  @RequirePermissions(PERMISSIONS.PATIENT_CREATE)
  @Post()
  create(@Body(zodPipe(createPatientSchema)) body: unknown) {
    return this.patients.create(body as never);
  }

  /** Returns non-identifying summaries only — no decryption, no PII permission. */
  @RequirePermissions(PERMISSIONS.PATIENT_READ)
  @Get()
  search(@Query(zodPipe(patientSearchSchema)) query: never) {
    return this.patients.search(query);
  }

  /** Decrypts identifiers, so it needs the stronger permission and is audited. */
  @RequirePermissions(PERMISSIONS.PATIENT_READ_PII)
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.patients.findOne(id);
  }

  /** Corrects demographics. Audited by field name, never by value. */
  @RequirePermissions(PERMISSIONS.PATIENT_UPDATE)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(updatePatientSchema)) body: UpdatePatientInput,
  ) {
    return this.patients.update(id, body as never);
  }

  /** DPDP right to erasure — crypto-shredding, irreversible. */
  @RequirePermissions(PERMISSIONS.PATIENT_ERASE)
  @Post(':id/erase')
  erase(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(erasePatientSchema)) body: { reason: string; requestRef: string },
  ) {
    return this.patients.erase(id, body.reason, body.requestRef);
  }
}
