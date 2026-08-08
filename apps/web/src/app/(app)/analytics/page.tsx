import { apiFetch } from '@/lib/api';
import { Card, EmptyState, Stat } from '@/components/ui';
import { money, moneyShort } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface Overview {
  period: { from: string; to: string };
  revenue: {
    invoiced: number;
    collected: number;
    outstanding: number;
    invoiceCount: number;
    averageValue: number;
  };
  byDay: { date: string; invoiced: number; collected: number; count: number }[];
  topTests: {
    code: string;
    name: string;
    department: string;
    count: number;
    revenue: number;
    revenueShare: number;
  }[];
  byDepartment: { department: string; count: number; revenue: number }[];
  topReferrers: {
    code: string;
    name: string;
    speciality: string | null;
    orders: number;
    revenue: number;
  }[];
  totalTests: number;
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const sp = await searchParams;

  const now = new Date();
  const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  const defaultTo = now.toISOString().slice(0, 10);

  const qs = new URLSearchParams({ from: sp.from ?? defaultFrom, to: sp.to ?? defaultTo });
  const data = await apiFetch<Overview>(`/analytics/overview?${qs.toString()}`).catch(() => null);

  if (!data) {
    return (
      <EmptyState
        title="Analytics unavailable"
        hint="Your role does not include business reporting access."
      />
    );
  }

  const collectionRate = data.revenue.invoiced
    ? (data.revenue.collected / data.revenue.invoiced) * 100
    : 0;
  const peakDay = Math.max(1, ...data.byDay.map((d) => d.invoiced));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-ink-900">Revenue &amp; analytics</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Business performance. Cancelled invoices are excluded throughout.
          </p>
        </div>
        <form className="flex flex-wrap items-end gap-2">
          <label>
            <span className="mb-1 block text-xs font-medium text-ink-600">From</span>
            <input
              type="date"
              name="from"
              defaultValue={sp.from ?? defaultFrom}
              className="h-11 rounded-md border border-ink-300 px-2 text-base sm:text-sm"
            />
          </label>
          <label>
            <span className="mb-1 block text-xs font-medium text-ink-600">To</span>
            <input
              type="date"
              name="to"
              defaultValue={sp.to ?? defaultTo}
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
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Invoiced" value={moneyShort(data.revenue.invoiced)} />
        <Stat label="Collected" value={moneyShort(data.revenue.collected)} tone="good" />
        <Stat
          label="Outstanding"
          value={moneyShort(data.revenue.outstanding)}
          tone={data.revenue.outstanding > 0 ? 'warn' : 'default'}
        />
        <Stat label="Invoices" value={data.revenue.invoiceCount} />
        <Stat label="Average bill" value={moneyShort(data.revenue.averageValue)} />
      </div>

      <Card title="Collection rate">
        <div className="p-4">
          <div className="flex items-baseline justify-between">
            <span className="numeric text-2xl font-semibold text-ink-900">
              {collectionRate.toFixed(1)}%
            </span>
            <span className="text-sm text-ink-500">
              {money(data.revenue.collected)} of {money(data.revenue.invoiced)}
            </span>
          </div>
          <div
            className="mt-2 h-2 overflow-hidden rounded-full bg-ink-100"
            role="img"
            aria-label={`Collection rate ${collectionRate.toFixed(1)} percent`}
          >
            <div
              className="h-full rounded-full bg-[var(--color-normal)]"
              style={{ width: `${Math.min(collectionRate, 100)}%` }}
            />
          </div>
        </div>
      </Card>

      {/* A CSS bar chart rather than a charting library: one fewer dependency,
          no client JS, and it prints. */}
      <Card title="Daily revenue">
        {data.byDay.length === 0 ? (
          <EmptyState title="No invoices in this period" />
        ) : (
          <div className="overflow-x-auto px-4 py-4">
            <div className="flex min-w-max items-end gap-1" style={{ height: 160 }}>
              {data.byDay.map((d) => (
                <div key={d.date} className="flex w-9 flex-col items-center gap-1">
                  <span className="numeric text-[10px] text-ink-500">
                    {d.invoiced >= 1000 ? `${Math.round(d.invoiced / 1000)}k` : Math.round(d.invoiced)}
                  </span>
                  <div className="flex h-full w-full items-end">
                    <div
                      className="w-full rounded-t bg-brand-600"
                      style={{ height: `${Math.max((d.invoiced / peakDay) * 100, 2)}%` }}
                      title={`${d.date}: ${money(d.invoiced)} invoiced, ${money(d.collected)} collected, ${d.count} invoice(s)`}
                    />
                  </div>
                  <span className="numeric text-[10px] text-ink-400">
                    {d.date.slice(8)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={`Top tests by revenue (${data.totalTests} tests run)`}>
          {data.topTests.length === 0 ? (
            <EmptyState title="No tests in this period" />
          ) : (
            <ul className="divide-y divide-ink-100">
              {data.topTests.map((t) => (
                <li key={t.code} className="px-4 py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm text-ink-900">{t.name}</div>
                      <div className="numeric text-xs text-ink-500">
                        {t.code} · {t.count} run{t.count > 1 ? 's' : ''}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="numeric text-sm font-semibold text-ink-900">
                        {money(t.revenue)}
                      </div>
                      <div className="numeric text-xs text-ink-400">{t.revenueShare}%</div>
                    </div>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink-100">
                    <div
                      className="h-full rounded-full bg-brand-600"
                      style={{ width: `${t.revenueShare}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-5">
          <Card title="By department">
            {data.byDepartment.length === 0 ? (
              <EmptyState title="No data" />
            ) : (
              <ul className="divide-y divide-ink-100">
                {data.byDepartment
                  .slice()
                  .sort((a, b) => b.revenue - a.revenue)
                  .map((d) => (
                    <li
                      key={d.department}
                      className="flex items-baseline justify-between gap-3 px-4 py-2.5"
                    >
                      <span className="text-sm text-ink-900">
                        {d.department.replace(/_/g, ' ').toLowerCase()}
                      </span>
                      <span className="text-right">
                        <span className="numeric text-sm font-semibold text-ink-900">
                          {money(d.revenue)}
                        </span>
                        <span className="numeric ml-2 text-xs text-ink-400">{d.count}</span>
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          </Card>

          <Card title="Top referrers">
            {data.topReferrers.length === 0 ? (
              <EmptyState title="No referrals in this period" />
            ) : (
              <ul className="divide-y divide-ink-100">
                {data.topReferrers.map((r) => (
                  <li
                    key={r.code}
                    className="flex items-start justify-between gap-3 px-4 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm text-ink-900">{r.name}</div>
                      <div className="truncate text-xs text-ink-500">
                        {r.speciality ?? 'General'} · {r.orders} order{r.orders > 1 ? 's' : ''}
                      </div>
                    </div>
                    <span className="numeric shrink-0 text-sm font-semibold text-ink-900">
                      {money(r.revenue)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
