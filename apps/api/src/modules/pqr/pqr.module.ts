import { Controller, Get, Module, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { PERMISSIONS } from '@labsetu/contracts';
import { PqrService } from './pqr.service';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { endOfDay, startOfDay } from '../../common/dates/range';

@Controller({ path: 'pqr', version: '1' })
export class PqrController {
  constructor(private readonly pqr: PqrService) {}

  /**
   * The annual review for one product.
   *
   * A GET rather than a POST: nothing is created. The review is assembled from
   * what the other modules already recorded, so it is always current — a PQR
   * snapshotted at generation is out of date the moment a deviation from the
   * period closes, which is the commonest complaint about the exercise.
   *
   * Defaults to the last twelve months, which is what "annual" means in
   * practice and saves the caller computing it.
   */
  @RequirePermissions(PERMISSIONS.PQR_READ)
  @Get('materials/:id')
  generate(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    // A date-only bound means the whole of that day; see common/dates/range.
    const toDate = endOfDay(to);
    const fromDate = startOfDay(from, new Date(toDate.getTime() - 365 * 864e5));

    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new BadRequestException('from and to must be dates.');
    }
    if (fromDate >= toDate) {
      throw new BadRequestException('The review period must start before it ends.');
    }

    return this.pqr.generate(id, fromDate, toDate);
  }
}

@Module({
  controllers: [PqrController],
  providers: [PqrService],
  exports: [PqrService],
})
export class PqrModule {}
