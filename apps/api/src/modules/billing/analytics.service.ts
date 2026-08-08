import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * The numbers a lab owner opens the system to see.
 *
 * Not clinical reporting — business reporting. "What did we earn this month,
 * which tests actually make money, and which doctor is sending me work" are the
 * questions that decide whether a lab renews its software.
 *
 * Every figure excludes cancelled invoices; a cancelled bill is not revenue.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async revenue(from: Date, to: Date) {
    const tx = this.prisma.tx;

    const invoices = await tx.invoice.findMany({
      where: { invoiceDate: { gte: from, lte: to }, status: { not: 'CANCELLED' } },
      select: { invoiceDate: true, totalAmount: true, paidAmount: true, labId: true },
    });

    // Daily series — the shape an owner scans for a bad week.
    const byDay = new Map<string, { invoiced: number; collected: number; count: number }>();
    for (const i of invoices) {
      const key = i.invoiceDate.toISOString().slice(0, 10);
      const row = byDay.get(key) ?? { invoiced: 0, collected: 0, count: 0 };
      row.invoiced += i.totalAmount.toNumber();
      row.collected += i.paidAmount.toNumber();
      row.count += 1;
      byDay.set(key, row);
    }

    const labs = await tx.lab.findMany({ select: { id: true, code: true, name: true } });
    const byLab = labs.map((l) => {
      const rows = invoices.filter((i) => i.labId === l.id);
      return {
        labCode: l.code,
        labName: l.name,
        invoiced: Number(rows.reduce((s, i) => s + i.totalAmount.toNumber(), 0).toFixed(2)),
        collected: Number(rows.reduce((s, i) => s + i.paidAmount.toNumber(), 0).toFixed(2)),
        count: rows.length,
      };
    });

    const invoiced = invoices.reduce((s, i) => s + i.totalAmount.toNumber(), 0);
    const collected = invoices.reduce((s, i) => s + i.paidAmount.toNumber(), 0);

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      totals: {
        invoiced: Number(invoiced.toFixed(2)),
        collected: Number(collected.toFixed(2)),
        outstanding: Number((invoiced - collected).toFixed(2)),
        invoiceCount: invoices.length,
        averageValue: invoices.length ? Number((invoiced / invoices.length).toFixed(2)) : 0,
      },
      byDay: [...byDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, v]) => ({
          date,
          invoiced: Number(v.invoiced.toFixed(2)),
          collected: Number(v.collected.toFixed(2)),
          count: v.count,
        })),
      byLab: byLab.filter((l) => l.count > 0),
    };
  }

  /**
   * Which tests are actually being run, and what they earn.
   *
   * Volume alone is misleading — a lab can be busy with cheap tests. Revenue
   * per test is what tells an owner where the business really is.
   */
  async testMix(from: Date, to: Date) {
    const tx = this.prisma.tx;

    const tests = await tx.sampleTest.findMany({
      where: {
        createdAt: { gte: from, lte: to },
        status: { notIn: ['CANCELLED'] },
      },
      select: {
        status: true,
        testDefinition: { select: { id: true, code: true, name: true, department: true, price: true } },
      },
    });

    const byTest = new Map<
      string,
      { code: string; name: string; department: string; count: number; revenue: number }
    >();

    for (const t of tests) {
      const d = t.testDefinition;
      const row =
        byTest.get(d.id) ??
        { code: d.code, name: d.name, department: d.department, count: 0, revenue: 0 };
      row.count += 1;
      row.revenue += d.price.toNumber();
      byTest.set(d.id, row);
    }

    const rows = [...byTest.values()].sort((a, b) => b.revenue - a.revenue);
    const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      totalTests: tests.length,
      totalRevenue: Number(totalRevenue.toFixed(2)),
      tests: rows.map((r) => ({
        ...r,
        revenue: Number(r.revenue.toFixed(2)),
        revenueShare: totalRevenue ? Number(((r.revenue / totalRevenue) * 100).toFixed(1)) : 0,
      })),
      byDepartment: [...new Set(rows.map((r) => r.department))].map((dept) => {
        const d = rows.filter((r) => r.department === dept);
        return {
          department: dept,
          count: d.reduce((s, r) => s + r.count, 0),
          revenue: Number(d.reduce((s, r) => s + r.revenue, 0).toFixed(2)),
        };
      }),
    };
  }

  /**
   * Referral performance.
   *
   * In Indian diagnostics the referring doctor relationship IS the business.
   * Knowing who has stopped sending work is more valuable than knowing who
   * sends most.
   */
  async referrals(from: Date, to: Date) {
    const tx = this.prisma.tx;

    const orders = await tx.labOrder.findMany({
      where: { orderedAt: { gte: from, lte: to }, status: { not: 'CANCELLED' } },
      select: {
        referringDoctorId: true,
        referringDoctor: { select: { code: true, name: true, speciality: true } },
        invoices: { select: { totalAmount: true, status: true } },
      },
    });

    const byDoctor = new Map<
      string,
      { code: string; name: string; speciality: string | null; orders: number; revenue: number }
    >();

    for (const o of orders) {
      const key = o.referringDoctorId ?? 'SELF';
      const row =
        byDoctor.get(key) ??
        {
          code: o.referringDoctor?.code ?? 'SELF',
          name: o.referringDoctor?.name ?? 'Self / walk-in',
          speciality: o.referringDoctor?.speciality ?? null,
          orders: 0,
          revenue: 0,
        };
      row.orders += 1;
      row.revenue += o.invoices
        .filter((i) => i.status !== 'CANCELLED')
        .reduce((s, i) => s + i.totalAmount.toNumber(), 0);
      byDoctor.set(key, row);
    }

    const rows = [...byDoctor.values()].sort((a, b) => b.revenue - a.revenue);

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      totalOrders: orders.length,
      doctors: rows.map((r) => ({ ...r, revenue: Number(r.revenue.toFixed(2)) })),
    };
  }

  /** Everything on one call, for the dashboard. */
  async overview(from: Date, to: Date) {
    const [revenue, mix, refs] = await Promise.all([
      this.revenue(from, to),
      this.testMix(from, to),
      this.referrals(from, to),
    ]);

    return {
      period: revenue.period,
      revenue: revenue.totals,
      byDay: revenue.byDay,
      topTests: mix.tests.slice(0, 8),
      byDepartment: mix.byDepartment,
      topReferrers: refs.doctors.slice(0, 8),
      totalTests: mix.totalTests,
    };
  }
}
