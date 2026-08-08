import Link from 'next/link';
import { notFound } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, StatusPill } from '@/components/ui';
import { money, date, dateTime } from '@/lib/format';
import { PaymentForm, CancelInvoiceForm, PrintButton } from './forms';

export const dynamic = 'force-dynamic';

interface Invoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  status: string;
  customerType: string;
  customerName: string | null;
  customerGstin: string | null;
  placeOfSupply: string | null;
  patientCode: string | null;
  orderNumber: string | null;
  referredBy: string;
  lab: { name: string; address: string | null; city: string | null; phone: string | null };
  supplier: {
    legalName: string;
    gstin: string | null;
    pan: string | null;
    stateCode: string | null;
  };
  lines: {
    description: string;
    sacCode: string | null;
    quantity: number;
    unitPrice: number;
    discountPct: number;
    gstRate: number;
    lineTotal: number;
  }[];
  subTotal: number;
  discountAmount: number;
  taxableAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  roundOff: number;
  totalAmount: number;
  paidAmount: number;
  balance: number;
  payments: {
    id: string;
    amount: number;
    mode: string;
    reference: string | null;
    paidAt: string;
  }[];
  cancelledAt: string | null;
  cancelReason: string | null;
}

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();

  const invoice = await apiFetch<Invoice>(`/billing/invoices/${id}`).catch((e) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  });
  if (!invoice) notFound();

  async function recordPayment(formData: FormData): Promise<void> {
    'use server';
    await apiFetch(`/billing/invoices/${id}/payments`, {
      method: 'POST',
      body: {
        amount: String(formData.get('amount') ?? ''),
        mode: String(formData.get('mode') ?? 'CASH'),
        reference: String(formData.get('reference') ?? '').trim() || undefined,
      },
    });
    revalidatePath(`/billing/${id}`);
    revalidatePath('/billing');
  }

  async function cancelInvoice(formData: FormData): Promise<void> {
    'use server';
    await apiFetch(`/billing/invoices/${id}/cancel`, {
      method: 'POST',
      body: { reason: String(formData.get('reason') ?? '').trim() },
    });
    revalidatePath(`/billing/${id}`);
    revalidatePath('/billing');
  }

  const settled = invoice.balance <= 0 || invoice.status === 'CANCELLED';
  const hasGst = invoice.cgstAmount + invoice.sgstAmount + invoice.igstAmount > 0;

  return (
    <div className="space-y-5">
      <div className="no-print flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/billing" className="-ml-2 inline-flex min-h-11 items-center px-2 text-sm text-brand-600 hover:underline">
            ← Billing
          </Link>
          <h1 className="numeric mt-1 break-words text-xl font-semibold text-ink-900">
            {invoice.invoiceNumber}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-500">
            <StatusPill status={invoice.status} />
            <span>{date(invoice.invoiceDate)}</span>
            {invoice.orderNumber && (
              <span className="numeric">· order {invoice.orderNumber}</span>
            )}
          </div>
        </div>
        <PrintButton />
      </div>

      {invoice.status === 'CANCELLED' && (
        <div className="rounded-lg border-2 border-ink-300 bg-ink-50 px-4 py-3">
          <p className="text-sm font-bold text-ink-700">
            Cancelled {date(invoice.cancelledAt)}
          </p>
          {invoice.cancelReason && (
            <p className="mt-0.5 text-xs text-ink-600">{invoice.cancelReason}</p>
          )}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        {/* The printable document. */}
        <Card className="lg:col-span-2" title="Tax invoice">
          <div className="space-y-4 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                  From
                </div>
                <div className="mt-1 text-sm font-medium text-ink-900">
                  {invoice.supplier.legalName}
                </div>
                <div className="text-xs text-ink-600">
                  {invoice.lab.name}
                  {invoice.lab.address && <> · {invoice.lab.address}</>}
                  {invoice.lab.city && <>, {invoice.lab.city}</>}
                </div>
                {invoice.lab.phone && (
                  <div className="numeric text-xs text-ink-600">{invoice.lab.phone}</div>
                )}
                {invoice.supplier.gstin && (
                  <div className="numeric mt-1 text-xs text-ink-600">
                    GSTIN {invoice.supplier.gstin}
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Billed to
                </div>
                <div className="mt-1 text-sm font-medium text-ink-900">
                  {invoice.customerName ?? '—'}
                </div>
                {invoice.patientCode && (
                  <div className="numeric text-xs text-ink-600">{invoice.patientCode}</div>
                )}
                <div className="text-xs text-ink-600">Referred by {invoice.referredBy}</div>
                {invoice.customerGstin && (
                  <div className="numeric mt-1 text-xs text-ink-600">
                    GSTIN {invoice.customerGstin}
                  </div>
                )}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <tr>
                    <th className="py-2 pr-2 font-medium">Description</th>
                    <th className="px-2 py-2 font-medium">SAC</th>
                    <th className="px-2 py-2 text-right font-medium">Qty</th>
                    <th className="px-2 py-2 text-right font-medium">Rate</th>
                    <th className="px-2 py-2 text-right font-medium">Disc</th>
                    <th className="py-2 pl-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {invoice.lines.map((l, idx) => (
                    <tr key={idx}>
                      <td className="py-2 pr-2 text-ink-900">{l.description}</td>
                      <td className="numeric px-2 py-2 text-xs text-ink-500">
                        {l.sacCode ?? '—'}
                      </td>
                      <td className="numeric px-2 py-2 text-right">{l.quantity}</td>
                      <td className="numeric px-2 py-2 text-right">{money(l.unitPrice)}</td>
                      <td className="numeric px-2 py-2 text-right text-ink-500">
                        {l.discountPct ? `${l.discountPct}%` : '—'}
                      </td>
                      <td className="numeric py-2 pl-2 text-right font-medium">
                        {money(l.lineTotal)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="ml-auto w-full max-w-xs space-y-1 border-t border-ink-200 pt-3 text-sm">
              <Row label="Sub-total" value={money(invoice.subTotal)} />
              {invoice.discountAmount > 0 && (
                <Row label="Discount" value={`− ${money(invoice.discountAmount)}`} />
              )}
              {hasGst && (
                <>
                  <Row label="Taxable value" value={money(invoice.taxableAmount)} />
                  {invoice.cgstAmount > 0 && (
                    <Row label="CGST" value={money(invoice.cgstAmount)} />
                  )}
                  {invoice.sgstAmount > 0 && (
                    <Row label="SGST" value={money(invoice.sgstAmount)} />
                  )}
                  {invoice.igstAmount > 0 && (
                    <Row label="IGST" value={money(invoice.igstAmount)} />
                  )}
                </>
              )}
              {invoice.roundOff !== 0 && (
                <Row label="Round off" value={money(invoice.roundOff)} />
              )}
              <div className="flex justify-between border-t border-ink-300 pt-2 text-base font-semibold text-ink-900">
                <span>Total</span>
                <span className="numeric">{money(invoice.totalAmount)}</span>
              </div>
              <Row label="Paid" value={money(invoice.paidAmount)} />
              <div
                className={`flex justify-between font-semibold ${
                  settled ? 'text-[var(--color-normal)]' : 'text-[var(--color-high)]'
                }`}
              >
                <span>{settled ? 'Settled' : 'Balance due'}</span>
                <span className="numeric">
                  {invoice.status === 'CANCELLED' ? '—' : money(Math.max(invoice.balance, 0))}
                </span>
              </div>
            </div>

            {!hasGst && (
              <p className="border-t border-ink-100 pt-2 text-xs text-ink-400">
                Diagnostic services by an authorised clinical establishment are exempt from GST
                under Notification 12/2017 (Sl. 74). No tax is charged on this invoice.
              </p>
            )}
          </div>
        </Card>

        <div className="space-y-5">
          {can(user, 'payment:record') && !settled && (
            <Card title="Take payment">
              <PaymentForm action={recordPayment} balance={invoice.balance} />
            </Card>
          )}

          <Card title={`Payments (${invoice.payments.length})`}>
            {invoice.payments.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-400">
                Nothing collected yet.
              </p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {invoice.payments.map((p) => (
                  <li key={p.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <div className="text-sm text-ink-900">
                        {p.mode.replace(/_/g, ' ').toLowerCase()}
                      </div>
                      <div className="numeric truncate text-xs text-ink-500">
                        {dateTime(p.paidAt)}
                        {p.reference && ` · ${p.reference}`}
                      </div>
                    </div>
                    <span className="numeric shrink-0 text-sm font-semibold text-ink-900">
                      {money(p.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {can(user, 'invoice:cancel') &&
            invoice.status !== 'CANCELLED' &&
            invoice.payments.length === 0 && (
              <Card title="Cancel">
                <CancelInvoiceForm action={cancelInvoice} />
              </Card>
            )}

          {can(user, 'invoice:cancel') && invoice.payments.length > 0 && invoice.status !== 'CANCELLED' && (
            <p className="text-xs text-ink-400">
              This invoice has payments against it, so it cannot be cancelled. Refund them first
              — otherwise the collections figure would disagree with the cash drawer.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-ink-600">
      <span>{label}</span>
      <span className="numeric">{value}</span>
    </div>
  );
}
