import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PERMISSIONS, reasonSchema } from '@labsetu/contracts';
import { BillingService } from './billing.service';
import { AnalyticsService } from './analytics.service';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';

const paymentSchema = z.object({
  amount: z.coerce.number().positive().max(10_000_000),
  // These MUST mirror the PaymentMode enum in schema.prisma exactly. A value
  // that passes validation here and then fails at the database turns a typo
  // into a 500 at the counter, with a patient waiting.
  mode: z.enum(['CASH', 'UPI', 'CARD', 'NETBANKING', 'CHEQUE', 'CREDIT', 'INSURANCE']),
  reference: z.string().trim().max(120).optional(),
});

const cancelSchema = z.object({ reason: reasonSchema });

/**
 * Defaults to the current month. An owner opening "revenue" without choosing
 * dates should see something useful, not an empty screen.
 */
function period(from?: string, to?: string) {
  const now = new Date();
  const start = from
    ? new Date(from)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = to ? new Date(to) : now;
  // An inclusive end date: "to=2026-08-02" must include everything on the 2nd.
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}

@Controller({ path: 'billing', version: '1' })
class BillingController {
  constructor(private readonly billing: BillingService) {}

  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  @Get('invoices')
  list(
    @Query('status') status?: string,
    @Query('labId') labId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const range = from || to ? period(from, to) : null;
    return this.billing.list({
      status,
      labId,
      search,
      from: range?.start,
      to: range?.end,
      limit: Math.min(Number(limit) || 25, 100),
      cursor,
    });
  }

  /** Today's takings and what is still owed. Placed before :id so it resolves. */
  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  @Get('summary')
  summary(@Query('from') from?: string, @Query('to') to?: string) {
    const { start, end } = period(from, to);
    return this.billing.summary(start, end);
  }

  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  @Get('invoices/:id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.billing.findOne(id);
  }

  @RequirePermissions(PERMISSIONS.PAYMENT_RECORD)
  @Post('invoices/:id/payments')
  pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(paymentSchema)) body: z.infer<typeof paymentSchema>,
  ) {
    return this.billing.recordPayment(id, body);
  }

  @RequirePermissions(PERMISSIONS.INVOICE_CANCEL)
  @Post('invoices/:id/cancel')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(cancelSchema)) body: { reason: string },
  ) {
    return this.billing.cancel(id, body.reason);
  }
}

@Controller({ path: 'analytics', version: '1' })
class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @RequirePermissions(PERMISSIONS.ANALYTICS_READ)
  @Get('overview')
  overview(@Query('from') from?: string, @Query('to') to?: string) {
    const { start, end } = period(from, to);
    return this.analytics.overview(start, end);
  }

  @RequirePermissions(PERMISSIONS.ANALYTICS_READ)
  @Get('revenue')
  revenue(@Query('from') from?: string, @Query('to') to?: string) {
    const { start, end } = period(from, to);
    return this.analytics.revenue(start, end);
  }

  @RequirePermissions(PERMISSIONS.ANALYTICS_READ)
  @Get('test-mix')
  testMix(@Query('from') from?: string, @Query('to') to?: string) {
    const { start, end } = period(from, to);
    return this.analytics.testMix(start, end);
  }

  @RequirePermissions(PERMISSIONS.ANALYTICS_READ)
  @Get('referrals')
  referrals(@Query('from') from?: string, @Query('to') to?: string) {
    const { start, end } = period(from, to);
    return this.analytics.referrals(start, end);
  }
}

@Module({
  controllers: [BillingController, AnalyticsController],
  providers: [BillingService, AnalyticsService],
  exports: [BillingService],
})
export class BillingModule {}
