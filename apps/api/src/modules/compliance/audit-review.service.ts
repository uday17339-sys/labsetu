import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * Periodic review of the audit trail (Annex 11 §9, Part 11).
 *
 * The trail being immutable proves nothing was altered. It does not prove that
 * anybody looked — and looking is the control. A site that keeps a perfect
 * hash-chained trail and never reads it has evidence of integrity and no
 * evidence of oversight, which is the finding an inspector writes.
 *
 * The review records the sequence range examined, not only the dates. The trail
 * is chained by sequence, so naming the range makes the review reproducible: a
 * second person can re-read precisely what the first one read, which a date
 * window cannot guarantee once entries are still arriving.
 */
@Injectable()
export class AuditReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * What a reviewer should look at for a period, before they sign anything.
   *
   * Surfaces the entry classes that matter rather than the whole trail: nobody
   * reads ten thousand rows, and a review that claims to have done so is the
   * least believable kind. Failed logins, overrides, amendments and deletions
   * are where a problem shows up.
   */
  async prepare(from: Date, to: Date) {
    const tx = this.prisma.tx;

    if (from >= to) {
      throw new BadRequestException('The review period must start before it ends.');
    }

    const window = { gte: from, lte: to };

    const entries = await tx.auditLog.findMany({
      where: { occurredAt: window },
      orderBy: { seq: 'asc' },
      select: { seq: true, action: true, actorDisplay: true, occurredAt: true, entityType: true },
    });

    if (entries.length === 0) {
      return {
        period: { from: from.toISOString(), to: to.toISOString() },
        entries: 0,
        fromSeq: null,
        toSeq: null,
        byAction: [],
        attention: [],
      };
    }

    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.action, (counts.get(e.action) ?? 0) + 1);

    /// The classes a reviewer is expected to justify, not merely count.
    const NOTEWORTHY = new Set([
      'LOGIN_FAILURE',
      'QC_OVERRIDE',
      'AMEND',
      'DELETE',
      'ERASURE_EXECUTED',
      'POLICY_CHANGED',
      'PASSWORD_EXPIRED',
      'CALIBRATION_RECORDED',
    ]);

    const attention = entries
      .filter((e) => NOTEWORTHY.has(e.action))
      .map((e) => ({
        seq: e.seq.toString(),
        action: e.action,
        actor: e.actorDisplay,
        entityType: e.entityType,
        occurredAt: e.occurredAt.toISOString(),
      }));

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      entries: entries.length,
      fromSeq: entries[0]!.seq.toString(),
      toSeq: entries[entries.length - 1]!.seq.toString(),
      byAction: [...counts.entries()]
        .sort(([, a], [, b]) => b - a)
        .map(([action, count]) => ({ action, count })),
      attention,
    };
  }

  async record(input: { from: Date; to: Date; findings: string; followUp?: string }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const prepared = await this.prepare(input.from, input.to);
    if (prepared.entries === 0) {
      throw new BadRequestException(
        'There are no audit entries in that period. A review of nothing is not a review.',
      );
    }

    const review = await tx.auditReview.create({
      data: {
        tenantId: ctx.tenantId!,
        periodFrom: input.from,
        periodTo: input.to,
        fromSeq: BigInt(prepared.fromSeq!),
        toSeq: BigInt(prepared.toSeq!),
        entriesReviewed: prepared.entries,
        reviewedBy: ctx.userId!,
        findings: input.findings.trim(),
        followUp: input.followUp?.trim() || null,
      },
    });

    await this.audit.record(tx, {
      action: 'AUDIT_TRAIL_REVIEWED',
      entityType: 'AuditReview',
      entityId: review.id,
      after: {
        periodFrom: input.from.toISOString().slice(0, 10),
        periodTo: input.to.toISOString().slice(0, 10),
        fromSeq: prepared.fromSeq,
        toSeq: prepared.toSeq,
        entriesReviewed: prepared.entries,
        itemsRequiringAttention: prepared.attention.length,
      },
      reason: input.findings.trim().slice(0, 500),
    });

    return {
      id: review.id,
      reviewedAt: review.reviewedAt.toISOString(),
      entriesReviewed: review.entriesReviewed,
      fromSeq: review.fromSeq.toString(),
      toSeq: review.toSeq.toString(),
    };
  }

  /**
   * The review history, and whether one is overdue.
   *
   * Never having reviewed counts as overdue. A system is not compliant by
   * virtue of being new — it is simply un-reviewed, which is the same gap seen
   * from the other side.
   */
  async list() {
    const tx = this.prisma.tx;

    const rows = await tx.auditReview.findMany({
      orderBy: { reviewedAt: 'desc' },
      take: 50,
    });

    const policy = await tx.tenantPolicy.findFirst({
      where: { key: 'audit.reviewIntervalDays' },
    });
    const intervalDays = (policy?.value as number) ?? 30;

    const reviewers = await tx.user.findMany({
      where: { id: { in: rows.map((r) => r.reviewedBy) } },
      select: { id: true, fullName: true },
    });
    const nameById = new Map(reviewers.map((u) => [u.id, u.fullName]));

    const last = rows[0] ?? null;
    const nextDue = last ? new Date(last.reviewedAt.getTime() + intervalDays * 864e5) : null;

    return {
      intervalDays,
      lastReviewedAt: last?.reviewedAt.toISOString() ?? null,
      nextDueAt: nextDue?.toISOString() ?? null,
      isOverdue: !last || nextDue!.getTime() < Date.now(),
      items: rows.map((r) => ({
        id: r.id,
        reviewedAt: r.reviewedAt.toISOString(),
        reviewedBy: nameById.get(r.reviewedBy) ?? 'Unknown',
        periodFrom: r.periodFrom.toISOString().slice(0, 10),
        periodTo: r.periodTo.toISOString().slice(0, 10),
        fromSeq: r.fromSeq.toString(),
        toSeq: r.toSeq.toString(),
        entriesReviewed: r.entriesReviewed,
        findings: r.findings,
        followUp: r.followUp,
      })),
    };
  }
}
