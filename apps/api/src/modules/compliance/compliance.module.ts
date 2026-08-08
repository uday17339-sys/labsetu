import {
  Controller,
  Get,
  Header,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { PERMISSIONS } from '@labsetu/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { RequestContextStore } from '../../common/context/request-context';
import { ExportService } from './export.service';

@Injectable()
class ComplianceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Audit search. The query an assessor always asks first is "show me everything
   * that happened to sample X", so entity filtering is the primary index.
   */
  async searchAudit(q: {
    entityType?: string;
    entityId?: string;
    actorUserId?: string;
    action?: string;
    from?: Date;
    to?: Date;
    limit: number;
    cursor?: string;
  }) {
    const rows = await this.prisma.tx.auditLog.findMany({
      where: {
        ...(q.entityType ? { entityType: q.entityType } : {}),
        ...(q.entityId ? { entityId: q.entityId } : {}),
        ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}),
        ...(q.action ? { action: q.action } : {}),
        ...(q.from || q.to
          ? { occurredAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
          : {}),
      },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      orderBy: { seq: 'desc' },
    });

    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;

    return {
      items: items.map((r) => ({
        id: r.id,
        seq: r.seq.toString(),
        occurredAt: r.occurredAt.toISOString(),
        actor: r.actorDisplay,
        actorRole: r.actorRole,
        actorIp: r.actorIp,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        reason: r.reason,
        changedFields: r.changedFields,
        before: r.before,
        after: r.after,
        hash: r.hash,
        prevHash: r.prevHash,
      })),
      nextCursor: hasMore ? items[items.length - 1]!.id : null,
    };
  }

  /** Everything that ever happened to one record, oldest first. */
  async entityHistory(entityType: string, entityId: string) {
    const rows = await this.prisma.tx.auditLog.findMany({
      where: { entityType, entityId },
      orderBy: { seq: 'asc' },
    });
    return rows.map((r) => ({
      seq: r.seq.toString(),
      occurredAt: r.occurredAt.toISOString(),
      actor: r.actorDisplay,
      actorRole: r.actorRole,
      action: r.action,
      reason: r.reason,
      changedFields: r.changedFields,
      before: r.before,
      after: r.after,
    }));
  }

  /**
   * On-demand chain verification.
   *
   * The result is the evidence a lab shows an assessor — arguably worth more at
   * an inspection than the chain itself, because it demonstrates the integrity
   * was actually being checked rather than merely claimed.
   */
  async verifyChain() {
    const ctx = RequestContextStore.require();
    const started = new Date();
    const result = await this.audit.verifyChain(this.prisma.tx, ctx.tenantId!);

    const head = await this.prisma.tx.auditChainHead.findUnique({
      where: { tenantId: ctx.tenantId! },
    });

    await this.prisma.tx.auditVerification.create({
      data: {
        tenantId: ctx.tenantId!,
        startedAt: started,
        completedAt: new Date(),
        fromSeq: 0n,
        toSeq: head?.seq ?? 0n,
        entriesChecked: BigInt(result.checked),
        status: result.ok ? 'PASSED' : 'FAILED',
        failureDetail: result.detail ?? null,
      },
    });

    return {
      status: result.ok ? 'PASSED' : 'FAILED',
      entriesChecked: result.checked,
      headSeq: head?.seq.toString() ?? '0',
      headHash: head?.headHash ?? null,
      verifiedAt: new Date().toISOString(),
      ...(result.ok ? {} : { failedAtSeq: result.failedAtSeq?.toString(), detail: result.detail }),
    };
  }

  /** NABL quality indicators: rejection rate, TAT breach rate, amendment rate. */
  async qualityIndicators(from: Date, to: Date) {
    const tx = this.prisma.tx;

    const [totalSamples, rejectedSamples, rejectionByReason, totalTests, overdueTests, amendments] =
      await Promise.all([
        tx.sample.count({ where: { createdAt: { gte: from, lte: to } } }),
        tx.sample.count({ where: { createdAt: { gte: from, lte: to }, status: 'REJECTED' } }),
        tx.sample.groupBy({
          by: ['rejectionReasonId'],
          where: { createdAt: { gte: from, lte: to }, status: 'REJECTED' },
          _count: true,
        }),
        tx.sampleTest.count({ where: { createdAt: { gte: from, lte: to } } }),
        tx.sampleTest.count({
          where: {
            createdAt: { gte: from, lte: to },
            dueAt: { not: null },
            OR: [
              { reportedAt: null, dueAt: { lt: new Date() } },
              { reportedAt: { not: null }, dueAt: { lt: new Date() } },
            ],
          },
        }),
        tx.report.count({ where: { createdAt: { gte: from, lte: to }, version: { gt: 1 } } }),
      ]);

    const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 10000) / 100);

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      sampleRejectionRate: {
        value: pct(rejectedSamples, totalSamples),
        unit: '%',
        numerator: rejectedSamples,
        denominator: totalSamples,
        byReason: rejectionByReason,
      },
      tatBreachRate: {
        value: pct(overdueTests, totalTests),
        unit: '%',
        numerator: overdueTests,
        denominator: totalTests,
      },
      amendedReportRate: {
        value: pct(amendments, totalTests),
        unit: '%',
        numerator: amendments,
      },
    };
  }
}

@Controller({ path: 'compliance', version: '1' })
class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @RequirePermissions(PERMISSIONS.AUDIT_READ)
  @Get('audit')
  search(
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('actorUserId') actorUserId?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit = '50',
  ) {
    return this.compliance.searchAudit({
      entityType,
      entityId,
      actorUserId,
      action,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      cursor,
      limit: Math.min(Number(limit) || 50, 200),
    });
  }

  @RequirePermissions(PERMISSIONS.AUDIT_READ)
  @Get('audit/:entityType/:entityId')
  history(
    @Param('entityType') entityType: string,
    @Param('entityId', ParseUUIDPipe) entityId: string,
  ) {
    return this.compliance.entityHistory(entityType, entityId);
  }

  @RequirePermissions(PERMISSIONS.AUDIT_VERIFY)
  @Get('audit-chain/verify')
  verify() {
    return this.compliance.verifyChain();
  }

  @RequirePermissions(PERMISSIONS.AUDIT_READ)
  @Get('quality-indicators')
  indicators(@Query('from') from?: string, @Query('to') to?: string) {
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 864e5);
    return this.compliance.qualityIndicators(fromDate, toDate);
  }
}

/**
 * CSV export.
 *
 * Streams with a Content-Disposition so the browser saves a file rather than
 * rendering it. Every download is audited as an EXPORT event — see
 * ExportService for why bulk export is treated as a security event.
 */
@Controller({ path: 'export', version: '1' })
class ExportController {
  constructor(private readonly exporter: ExportService) {}

  @RequirePermissions(PERMISSIONS.COMPLIANCE_EXPORT)
  @Get('worklist.csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  async worklist(
    @Res({ passthrough: true }) res: Response,
    @Query('status') status?: string,
    @Query('labId') labId?: string,
  ) {
    res.setHeader('content-disposition', attachment('worklist'));
    return this.exporter.worklist({ status, labId });
  }

  @RequirePermissions(PERMISSIONS.COMPLIANCE_EXPORT)
  @Get('results.csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  async results(
    @Res({ passthrough: true }) res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    res.setHeader('content-disposition', attachment('results'));
    return this.exporter.results({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  @RequirePermissions(PERMISSIONS.COMPLIANCE_EXPORT)
  @Get('qc.csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  async qc(
    @Res({ passthrough: true }) res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    res.setHeader('content-disposition', attachment('qc'));
    return this.exporter.qc({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  @RequirePermissions(PERMISSIONS.COMPLIANCE_EXPORT)
  @Get('audit.csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  async audit(
    @Res({ passthrough: true }) res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('action') action?: string,
  ) {
    res.setHeader('content-disposition', attachment('audit'));
    return this.exporter.auditTrail({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      action,
    });
  }

  @RequirePermissions(PERMISSIONS.COMPLIANCE_EXPORT)
  @Get('inventory.csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  async inventory(@Res({ passthrough: true }) res: Response) {
    res.setHeader('content-disposition', attachment('inventory'));
    return this.exporter.inventory();
  }
}

const attachment = (name: string) =>
  `attachment; filename="labsetu-${name}-${new Date().toISOString().slice(0, 10)}.csv"`;

@Module({
  controllers: [ComplianceController, ExportController],
  providers: [ComplianceService, ExportService],
})
export class ComplianceModule {}
