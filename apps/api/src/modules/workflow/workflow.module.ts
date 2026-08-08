import { Module } from '@nestjs/common';
import { WorkflowController } from './workflow.controller';
import { OrdersService } from './orders.service';
import { SamplesService } from './samples.service';
import { ResultsService } from './results.service';
import { AccessionService } from './accession.service';
import { CriticalValuesService } from './critical-values.service';

/**
 * The operational core: registration -> accessioning -> results -> release.
 *
 * Kept as one module because these entities share one transaction boundary and
 * one lifecycle. Splitting them would create chatty internal calls across a
 * seam that does not exist in the domain.
 */
@Module({
  controllers: [WorkflowController],
  providers: [OrdersService, SamplesService, ResultsService, AccessionService, CriticalValuesService],
  exports: [OrdersService, SamplesService, ResultsService, AccessionService, CriticalValuesService],
})
export class WorkflowModule {}
