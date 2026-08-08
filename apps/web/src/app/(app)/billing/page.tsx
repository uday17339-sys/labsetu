import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, EmptyState, Stat, StatusPill } from '@/components/ui';
import { money } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  lab: string;
  orderNumber: string | null;
  patientCode: string | null;
  customerName: string | null;
  totalAmount: number;
  paidAmount: number;
  balance: number;
  status: string;
  paymentCount: number;
}

interface Summary {
  invoiced: { count: number; amount: number };
  collected: { amount: number; byMode: { mode: string; amount: number; count: number }[] };
  outstanding: { amount: number; invoiceCount: number; overdue30Days: number };
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; search?: string; from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const user = await getSessionUser();

  const today = new Date().toISOString().slice(0, 10);
  const qs = new URLSearchParams();
  if (sp.status) qs.set('status', sp.status);
  if (sp.search) qs.set('search', sp.search);
  if (sp.from) qs.set('from', sp.from);
  if (sp.to) qs.set('to', sp.to);
  qs.set('limit', '50');

  // The summary defaults to today, because "what did we take today" is the
  // question at 8pm when the counter closes. The list is unfiltered by date so
  // an unpaid invoice from last week is still reachable.
  const summaryQs = new URLSearchParams({ from: sp.from ?? today, to: sp.to ?? today });

  const [list, summary] = await Promise.all([
    apiFetch<{ items: InvoiceRow[]; nextCursor: string | null }>(
      `/billing/invoices?${qs.toString()}`,
    ).catch(() => ({ items: [], nextCursor: null })),
    apiFetch<Summary>(`/billing/summary?${summaryQs.toString()}`).catch(() => null),
  ]);

  const filters = [
    { value: '', label: 'All' },
    { value: 'UNPAID', label: 'Unpaid' },
    { value: 'PARTIALLY_PAID', label: 'Part paid' },
    { value: 'PAID', label: 'Paid' },
    { value: 'CANCELLED', label: 'Cancelled' },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-ink-900">Billing</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Invoices are raised automatically with every order. Collect against them here.
          </p>
        </div>
        {can(user, 'analytics:read') && (
          <Link
            href="/analytics"
            className="min-h-11 rounded-md border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-100"
          >
            Revenue &amp; analytics
          </Link>
        )}
      </div>

      {summary && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label={sp.from || sp.to ? 'Invoiced (period)' : 'Invoiced today'}
            value={money(summary.invoiced.amount)}
          />
          <Stat
            label={sp.from || sp.to ? 'Collected (period)' : 'Collected today'}
            value={money(summary.collected.amount)}
            tone="good"
          />
          <Stat
            label="Outstanding (all time)"
            value={money(summary.outstanding.amount)}
            tone={summary.outstanding.amount > 0 ? 'warn' : 'default'}
          />
          <Stat
            label="Overdue 30+ days"
            value={money(summary.outstanding.overdue30Days)}
            tone={summary.outstanding.overdue30Days > 0 ? 'critical' : 'default'}
          />
        </div>
      )}

      {summary && summary.collected.byMode.length > 0 && (
        <Card title="Collected by mode">
          <ul className="flex flex-wrap gap-x-6 gap-y-2 px-4 py-3">
            {summary.collected.byMode.map((m) => (
              <li key={m.mode} className="text-sm">
                <span className="text-ink-500">{m.mode.replace(/_/g, ' ').toLowerCase()}</span>{' '}
                <span className="numeric font-semibold text-ink-900">{money(m.amount)}</span>{' '}
                <span className="text-xs text-ink-400">({m.count})</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Invoices">
        <form className="flex flex-wrap items-end gap-2 border-b border-ink-100 px-4 py-3">
          <label className="min-w-0 flex-1 sm:max-w-xs">
            <span className="mb-1 block text-xs font-medium text-ink-600">Search</span>
            <input
              name="search"
              defaultValue={sp.search ?? ''}
              placeholder="Invoice number"
              className="numeric h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
            />
          </label>
          <label>
            <span className="mb-1 block text-xs font-medium text-ink-600">Status</span>
            <select
              name="status"
              defaultValue={sp.status ?? ''}
              className="h-11 rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
            >
              {filters.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-xs font-medium text-ink-600">From</span>
            <input
              type="date"
              name="from"
              defaultValue={sp.from ?? ''}
              className="h-11 rounded-md border border-ink-300 px-2 text-base sm:text-sm"
            />
          </label>
          <label>
            <span className="mb-1 block text-xs font-medium text-ink-600">To</span>
            <input
              type="date"
              name="to"
              defaultValue={sp.to ?? ''}
              className="h-11 rounded-md border border-ink-300 px-2 text-base sm:text-sm"
            />
          </label>
          <button
            type="submit"
            className="min-h-11 rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
          >
            Apply
          </button>
        </form>

        {list.items.length === 0 ? (
          <EmptyState
            title="No invoices match"
            hint="Invoices appear as soon as an order is registered."
          />
        ) : (
          <>
            {/* Mobile: cards. A table at 375px is unreadable. */}
            <ul className="divide-y divide-ink-100 md:hidden">
              {list.items.map((i) => (
                <li key={i.id}>
                  <Link href={`/billing/${i.id}`} className="block px-4 py-3 active:bg-ink-50">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="numeric text-sm font-medium text-ink-900">
                          {i.invoiceNumber}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-ink-500">
                          {i.patientCode ?? '—'} · {i.orderNumber ?? '—'}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="numeric text-sm font-semibold text-ink-900">
                          {money(i.totalAmount)}
                        </div>
                        <div className="mt-0.5">
                          <StatusPill status={i.status} />
                        </div>
                      </div>
                    </div>
                    {i.balance > 0 && i.status !== 'CANCELLED' && (
                      <div className="numeric mt-1 text-xs font-medium text-[var(--color-high)]">
                        {money(i.balance)} due
                      </div>
                    )}
                  </Link>
                </li>
              ))}
            </ul>

            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Invoice</th>
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Patient</th>
                    <th className="px-4 py-2 font-medium">Order</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                    <th className="px-4 py-2 text-right font-medium">Paid</th>
                    <th className="px-4 py-2 text-right font-medium">Balance</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {list.items.map((i) => (
                    <tr key={i.id} className={i.balance > 0 && i.status !== 'CANCELLED' ? 'bg-amber-50/40' : ''}>
                      <td className="px-4 py-2">
                        <Link
                          href={`/billing/${i.id}`}
                          className="numeric font-medium text-brand-600 hover:underline"
                        >
                          {i.invoiceNumber}
                        </Link>
                      </td>
                      <td className="numeric whitespace-nowrap px-4 py-2 text-xs text-ink-500">
                        {new Date(i.invoiceDate).toLocaleDateString('en-IN')}
                      </td>
                      <td className="numeric px-4 py-2 text-xs text-ink-600">
                        {i.patientCode ?? '—'}
                      </td>
                      <td className="numeric px-4 py-2 text-xs text-ink-600">
                        {i.orderNumber ?? '—'}
                      </td>
                      <td className="numeric whitespace-nowrap px-4 py-2 text-right">
                        {money(i.totalAmount)}
                      </td>
                      <td className="numeric whitespace-nowrap px-4 py-2 text-right text-ink-600">
                        {money(i.paidAmount)}
                      </td>
                      <td
                        className={`numeric whitespace-nowrap px-4 py-2 text-right font-medium ${
                          i.balance > 0 && i.status !== 'CANCELLED'
                            ? 'text-[var(--color-high)]'
                            : 'text-ink-400'
                        }`}
                      >
                        {i.status === 'CANCELLED' ? '—' : money(i.balance)}
                      </td>
                      <td className="px-4 py-2">
                        <StatusPill status={i.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
