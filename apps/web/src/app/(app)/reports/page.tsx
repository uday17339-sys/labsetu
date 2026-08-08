import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Card, EmptyState, StatusPill } from '@/components/ui';
import { dateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface ReportRow {
  id: string;
  reportNumber: string;
  version: number;
  status: string;
  isPartial: boolean;
  isAmendment: boolean;
  orderNumber: string;
  patientId: string | null;
  patientCode: string | null;
  sex: string | null;
  ageYears: number | null;
  referredBy: string;
  testCount: number;
  deliveryCount: number;
  createdAt: string;
  releasedAt: string | null;
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; search?: string; from?: string; to?: string }>;
}) {
  const sp = await searchParams;

  const qs = new URLSearchParams();
  if (sp.status) qs.set('status', sp.status);
  if (sp.search) qs.set('search', sp.search);
  if (sp.from) qs.set('from', sp.from);
  if (sp.to) qs.set('to', sp.to);
  qs.set('limit', '50');

  const list = await apiFetch<{ items: ReportRow[]; nextCursor: string | null }>(
    `/reports?${qs.toString()}`,
  ).catch(() => ({ items: [], nextCursor: null }));

  return (
    <div className="space-y-5">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-ink-900">Reports</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          Every report the lab has produced. Search by report, order, patient or accession number
          — whichever is on the slip in front of you.
        </p>
      </div>

      <Card>
        <form className="flex flex-wrap items-end gap-2 border-b border-ink-100 px-4 py-3">
          <label className="min-w-0 flex-1 sm:max-w-sm">
            <span className="mb-1 block text-xs font-medium text-ink-600">Search</span>
            <input
              name="search"
              defaultValue={sp.search ?? ''}
              placeholder="RPT-… / ORD-… / ACC-… / P-…"
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
              <option value="">All</option>
              <option value="DRAFT">Draft</option>
              <option value="RELEASED">Released</option>
              <option value="AMENDED">Amended</option>
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
            Search
          </button>
        </form>

        {list.items.length === 0 ? (
          <EmptyState
            title="No reports match"
            hint="Reports are created from an order once its tests are authorised."
          />
        ) : (
          <>
            <ul className="divide-y divide-ink-100 md:hidden">
              {list.items.map((r) => (
                <li key={r.id}>
                  <Link href={`/reports/${r.id}`} className="block px-4 py-3 active:bg-ink-50">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="numeric text-sm font-medium text-ink-900">
                          {r.reportNumber}
                          {r.version > 1 && (
                            <span className="ml-1 text-xs text-ink-500">v{r.version}</span>
                          )}
                        </div>
                        <div className="numeric mt-0.5 truncate text-xs text-ink-500">
                          {r.patientCode ?? '—'} · {r.orderNumber} · {r.testCount} test
                          {r.testCount === 1 ? '' : 's'}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <StatusPill status={r.status} />
                        <div className="mt-0.5 flex justify-end gap-1">
                          {r.isPartial && <Tag>partial</Tag>}
                          {r.isAmendment && <Tag tone="warn">amended</Tag>}
                        </div>
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Report</th>
                    <th className="px-4 py-2 font-medium">Patient</th>
                    <th className="px-4 py-2 font-medium">Order</th>
                    <th className="px-4 py-2 font-medium">Referred by</th>
                    <th className="px-4 py-2 text-right font-medium">Tests</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Released</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {list.items.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-2">
                        <Link
                          href={`/reports/${r.id}`}
                          className="numeric font-medium text-brand-600 hover:underline"
                        >
                          {r.reportNumber}
                        </Link>
                        {r.version > 1 && (
                          <span className="numeric ml-1 text-xs text-ink-400">v{r.version}</span>
                        )}
                        <div className="mt-0.5 flex gap-1">
                          {r.isPartial && <Tag>partial</Tag>}
                          {r.isAmendment && <Tag tone="warn">amended</Tag>}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        {r.patientId ? (
                          <Link
                            href={`/patients/${r.patientId}/history`}
                            className="numeric text-xs text-brand-600 hover:underline"
                          >
                            {r.patientCode}
                          </Link>
                        ) : (
                          <span className="numeric text-xs text-ink-500">
                            {r.patientCode ?? '—'}
                          </span>
                        )}
                        {r.sex && r.ageYears != null && (
                          <span className="numeric ml-1 text-xs text-ink-400">
                            {r.sex[0]}/{r.ageYears}
                          </span>
                        )}
                      </td>
                      <td className="numeric px-4 py-2 text-xs text-ink-600">{r.orderNumber}</td>
                      <td className="px-4 py-2 text-xs text-ink-600">{r.referredBy}</td>
                      <td className="numeric px-4 py-2 text-right text-ink-600">{r.testCount}</td>
                      <td className="px-4 py-2">
                        <StatusPill status={r.status} />
                      </td>
                      <td className="numeric whitespace-nowrap px-4 py-2 text-xs text-ink-500">
                        {r.releasedAt ? dateTime(r.releasedAt) : '—'}
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

function Tag({ children, tone }: { children: React.ReactNode; tone?: 'warn' }) {
  return (
    <span
      className={`inline-flex rounded px-1 py-0.5 text-[10px] font-medium ${
        tone === 'warn'
          ? 'bg-orange-50 text-orange-800 ring-1 ring-orange-200'
          : 'bg-ink-100 text-ink-500'
      }`}
    >
      {children}
    </span>
  );
}
