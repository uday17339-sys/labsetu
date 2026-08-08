import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@labsetu/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { TenantKeyService } from '../../common/crypto/tenant-key.service';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * Billing and collections.
 *
 * The front desk takes cash and UPI at the counter all day. Without this the
 * lab literally cannot trade — the invoice existed in the database from the
 * moment an order was placed, but nobody could see it, print it or settle it.
 *
 * Money handling rules that are deliberate:
 *   - Payments are append-only. A mistake is corrected by a refund row, never by
 *     editing or deleting the original — the same reasoning as the audit trail.
 *   - An invoice cannot be over-paid. Silent over-collection is how reconciliation
 *     breaks.
 *   - Cancelling an invoice with payments against it is refused; refund first.
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly tenantKeys: TenantKeyService,
  ) {}

  async list(q: {
    status?: string;
    labId?: string;
    from?: Date;
    to?: Date;
    search?: string;
    limit: number;
    cursor?: string;
  }) {
    const rows = await this.prisma.tx.invoice.findMany({
      where: {
        ...(q.status ? { status: q.status as never } : {}),
        ...(q.labId ? { labId: q.labId } : {}),
        ...(q.search ? { invoiceNumber: { contains: q.search.toUpperCase() } } : {}),
        ...(q.from || q.to
          ? {
              invoiceDate: {
                ...(q.from ? { gte: q.from } : {}),
                ...(q.to ? { lte: q.to } : {}),
              },
            }
          : {}),
      },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      orderBy: { invoiceDate: 'desc' },
      include: {
        lab: { select: { code: true } },
        order: {
          select: {
            orderNumber: true,
            patient: { select: { id: true, patientCode: true, sex: true, ageYears: true } },
          },
        },
        _count: { select: { payments: true } },
      },
    });

    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;

    return {
      items: items.map((i) => ({
        id: i.id,
        invoiceNumber: i.invoiceNumber,
        invoiceDate: i.invoiceDate.toISOString(),
        lab: i.lab.code,
        orderNumber: i.order?.orderNumber ?? null,
        patientCode: i.order?.patient?.patientCode ?? null,
        patientId: i.order?.patient?.id ?? null,
        customerName: i.customerName,
        totalAmount: i.totalAmount.toNumber(),
        paidAmount: i.paidAmount.toNumber(),
        balance: i.totalAmount.sub(i.paidAmount).toNumber(),
        status: i.status,
        paymentCount: i._count.payments,
      })),
      nextCursor: hasMore ? items[items.length - 1]!.id : null,
    };
  }

  async findOne(id: string) {
    const ctx = RequestContextStore.require();
    const invoice = await this.prisma.tx.invoice.findUnique({
      where: { id },
      include: {
        lab: true,
        items: true,
        payments: { orderBy: { paidAt: 'desc' } },
        order: {
          include: {
            patient: true,
            referringDoctor: { select: { name: true } },
            items: {
              include: {
                testDefinition: { select: { code: true, name: true } },
                panel: { select: { code: true, name: true } },
              },
            },
          },
        },
      },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    const tenant = await this.prisma.tx.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId! },
    });

    // The patient's name belongs on their bill. This is one of the few places
    // identifiers are legitimately decrypted, so the read is audited.
    let patientName: string | null = null;
    if (invoice.order?.patient && !invoice.order.patient.erasedAt) {
      const tenantKey = await this.tenantKeys.get(ctx.tenantId!);
      const key = this.crypto.unwrapSubjectKey(invoice.order.patient.dataKeyEnc, tenantKey);
      patientName = this.crypto.decryptField(invoice.order.patient.nameEnc, key);

      await this.audit.record(this.prisma.tx, {
        action: 'READ_SENSITIVE',
        entityType: 'Patient',
        entityId: invoice.order.patient.id,
        after: { patientCode: invoice.order.patient.patientCode, view: 'INVOICE' },
      });
    }

    // Line detail comes from the order when the invoice has no explicit items —
    // invoices raised before line-item capture still need to print correctly.
    const lines =
      invoice.items.length > 0
        ? invoice.items.map((it) => ({
            description: it.description,
            sacCode: it.sacCode,
            quantity: it.quantity,
            unitPrice: it.unitPrice.toNumber(),
            discountPct: it.discountPct.toNumber(),
            gstRate: it.gstRate.toNumber(),
            lineTotal: it.lineTotal.toNumber(),
          }))
        : (invoice.order?.items ?? []).map((oi) => ({
            description: oi.testDefinition?.name ?? oi.panel?.name ?? 'Laboratory service',
            sacCode: '999316',
            quantity: oi.quantity,
            unitPrice: oi.unitPrice.toNumber(),
            discountPct: oi.discountPct.toNumber(),
            gstRate: 0,
            lineTotal: oi.netAmount.toNumber(),
          }));

    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate.toISOString(),
      status: invoice.status,
      customerType: invoice.customerType,
      customerName: patientName ?? invoice.customerName,
      customerGstin: invoice.customerGstin,
      placeOfSupply: invoice.placeOfSupply,
      patientCode: invoice.order?.patient?.patientCode ?? null,
      orderNumber: invoice.order?.orderNumber ?? null,
      referredBy: invoice.order?.referringDoctor?.name ?? 'Self',
      lab: {
        name: invoice.lab.name,
        address: invoice.lab.addressLine1,
        city: invoice.lab.city,
        phone: invoice.lab.phone,
      },
      supplier: {
        legalName: tenant.legalName ?? tenant.name,
        gstin: tenant.gstin,
        pan: tenant.pan,
        stateCode: tenant.stateCode,
      },
      lines,
      subTotal: invoice.subTotal.toNumber(),
      discountAmount: invoice.discountAmount.toNumber(),
      taxableAmount: invoice.taxableAmount.toNumber(),
      cgstAmount: invoice.cgstAmount.toNumber(),
      sgstAmount: invoice.sgstAmount.toNumber(),
      igstAmount: invoice.igstAmount.toNumber(),
      roundOff: invoice.roundOff.toNumber(),
      totalAmount: invoice.totalAmount.toNumber(),
      paidAmount: invoice.paidAmount.toNumber(),
      balance: invoice.totalAmount.sub(invoice.paidAmount).toNumber(),
      payments: invoice.payments.map((p) => ({
        id: p.id,
        amount: p.amount.toNumber(),
        mode: p.mode,
        reference: p.reference,
        paidAt: p.paidAt.toISOString(),
      })),
      cancelledAt: invoice.cancelledAt?.toISOString() ?? null,
      cancelReason: invoice.cancelReason,
    };
  }

  /**
   * Records a payment. Append-only: a mistake becomes a refund row, never an
   * edit — cash handling deserves the same immutability as the clinical record.
   */
  async recordPayment(
    invoiceId: string,
    input: { amount: number; mode: string; reference?: string },
  ) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException('Invoice not found');

    if (invoice.status === 'CANCELLED') {
      throw new BadRequestException('This invoice has been cancelled');
    }
    if (input.amount <= 0) {
      throw new BadRequestException('Payment amount must be greater than zero');
    }

    const balance = invoice.totalAmount.sub(invoice.paidAmount);
    const amount = new Prisma.Decimal(input.amount.toFixed(2));

    if (amount.greaterThan(balance)) {
      throw new BadRequestException(
        `Payment of ₹${input.amount} exceeds the outstanding balance of ₹${balance.toString()}. ` +
          `Silently accepting an over-payment is how reconciliation breaks — collect the balance ` +
          `or raise a separate credit.`,
      );
    }

    const payment = await tx.payment.create({
      data: {
        tenantId: ctx.tenantId!,
        invoiceId,
        amount,
        mode: input.mode as never,
        reference: input.reference ?? null,
        receivedBy: ctx.userId,
      },
    });

    const newPaid = invoice.paidAmount.add(amount);
    const status = newPaid.greaterThanOrEqualTo(invoice.totalAmount)
      ? 'PAID'
      : newPaid.greaterThan(0)
        ? 'PARTIALLY_PAID'
        : 'UNPAID';

    await tx.invoice.update({
      where: { id: invoiceId },
      data: { paidAmount: newPaid, status },
    });

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'Payment',
      entityId: payment.id,
      after: {
        invoiceNumber: invoice.invoiceNumber,
        amount: input.amount,
        mode: input.mode,
        reference: input.reference ?? null,
        balanceAfter: invoice.totalAmount.sub(newPaid).toNumber(),
        invoiceStatus: status,
      },
    });

    return {
      paymentId: payment.id,
      amount: input.amount,
      paidAmount: newPaid.toNumber(),
      balance: invoice.totalAmount.sub(newPaid).toNumber(),
      status,
    };
  }

  async cancel(invoiceId: string, reason: string) {
    const tx = this.prisma.tx;

    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: { _count: { select: { payments: true } } },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status === 'CANCELLED') {
      throw new BadRequestException('This invoice is already cancelled');
    }
    if (invoice._count.payments > 0) {
      throw new BadRequestException(
        'This invoice has payments against it. Refund them before cancelling, so the ' +
          'collections figure never disagrees with the cash drawer.',
      );
    }

    await tx.invoice.update({
      where: { id: invoiceId },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason },
    });

    await this.audit.record(tx, {
      action: 'CANCEL',
      entityType: 'Invoice',
      entityId: invoiceId,
      reason,
      before: { status: invoice.status },
      after: {
        status: 'CANCELLED',
        invoiceNumber: invoice.invoiceNumber,
        amount: invoice.totalAmount.toNumber(),
      },
    });

    return { invoiceNumber: invoice.invoiceNumber, status: 'CANCELLED' };
  }

  /**
   * The end-of-day figure the owner actually wants: what came in, how, and
   * what is still owed.
   */
  async summary(from: Date, to: Date) {
    const tx = this.prisma.tx;

    const [invoices, payments, outstanding] = await Promise.all([
      tx.invoice.aggregate({
        where: { invoiceDate: { gte: from, lte: to }, status: { not: 'CANCELLED' } },
        _sum: { totalAmount: true },
        _count: true,
      }),
      tx.payment.groupBy({
        by: ['mode'],
        where: { paidAt: { gte: from, lte: to } },
        _sum: { amount: true },
        _count: true,
      }),
      tx.invoice.findMany({
        where: { status: { in: ['UNPAID', 'PARTIALLY_PAID'] } },
        select: { totalAmount: true, paidAmount: true, invoiceDate: true },
      }),
    ]);

    const collected = payments.reduce((s, p) => s + (p._sum.amount?.toNumber() ?? 0), 0);
    const outstandingTotal = outstanding.reduce(
      (s, i) => s + i.totalAmount.sub(i.paidAmount).toNumber(),
      0,
    );

    // Ageing: anything past 30 days is what a lab actually chases.
    const cutoff = new Date(Date.now() - 30 * 864e5);
    const overdue = outstanding
      .filter((i) => i.invoiceDate < cutoff)
      .reduce((s, i) => s + i.totalAmount.sub(i.paidAmount).toNumber(), 0);

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      invoiced: {
        count: invoices._count,
        amount: invoices._sum.totalAmount?.toNumber() ?? 0,
      },
      collected: {
        amount: Number(collected.toFixed(2)),
        byMode: payments.map((p) => ({
          mode: p.mode,
          amount: p._sum.amount?.toNumber() ?? 0,
          count: p._count,
        })),
      },
      outstanding: {
        amount: Number(outstandingTotal.toFixed(2)),
        invoiceCount: outstanding.length,
        overdue30Days: Number(overdue.toFixed(2)),
      },
    };
  }
}
