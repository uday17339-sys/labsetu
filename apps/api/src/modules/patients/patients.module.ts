import { Module } from '@nestjs/common';
import { PatientsService } from './patients.service';
import { PatientHistoryService } from './history.service';
import { PatientsController } from './patients.controller';

@Module({
  controllers: [PatientsController],
  providers: [PatientsService, PatientHistoryService],
  exports: [PatientsService, PatientHistoryService],
})
export class PatientsModule {}
