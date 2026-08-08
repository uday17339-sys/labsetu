import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Card, EmptyState, StatusPill } from '@/components/ui';
import { dateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface CoaRow {
  id: string;
  coaNumber: string;
  version: number;
  issuedAt: string;
  batchNumber: string;
  material: { code: string; name: string };
  specification: string;
  batchStatus: string;
}

/**
 * The certificate register.
 *
 * The document that leaves the site with the material, findable without going
 * through the batch first: a customer quotes a CoA number, an auditor asks for
 * everything issued in a quarter, and neither of them knows the batch record.
 */
export default async function CoaRegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const sp = await searchParams;

  const qs = new URLSearchParams();
  if (sp.search) qs.set('search', sp.search);
  qs.set('limit', '50');

  const list = await apiFetch<{ items: CoaRow[] }>(`/qa/coa?${qs.toString()}`).catch(() => ({
    items: [],
  }));

  return (
    <div className="space-y-5">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-ink-900">Certificates of analysis</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          Every certificate this site has issued. Search by certificate number, batch number or
          material — whichever the caller has quoted.
        </p>
      </div>

      <Card>
        <form className="flex flex-wrap items-end gap-2 border-b border-ink-100 px-4 py-3">
          <label className="min-w-0 flex-1 sm:max-w-sm">
            <span className="mb-1 block text-xs font-medium text-ink-600">Search</span>
            <input
              name="search"
              defaultValue={sp.search ?? ''}
              placeholder="COA… / batch number / material"
              className="numeric h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
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
            title="No certificates match"
            hint="A certificate is issued from the batch record once QA has released the batch."
          />
        ) : (
          <>
            {/* Cards on a phone, a table from md up — the same pattern the rest
                of the registers use. */}
            <ul className="divide-y divide-ink-100 md:hidden">
              {list.items.map((c) => (
                <li key={c.id}>
                  <Link href={`/coa/${c.id}`} className="block px-4 py-3 active:bg-ink-50">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="numeric text-sm font-medium text-ink-900">
                          {c.coaNumber}
                          {c.version > 1 && (
                            <span className="ml-1 text-xs text-ink-500">v{c.version}</span>
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-ink-500">
                          {c.material.name}
                        </div>
                        <div className="numeric mt-0.5 truncate text-xs text-ink-400">
                          {c.batchNumber} · {c.specification}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <StatusPill status={c.batchStatus} />
                        <div className="numeric mt-1 text-xs text-ink-400">
                          {dateTime(c.issuedAt)}
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
                    <th className="px-4 py-2 font-medium">Certificate</th>
                    <th className="px-4 py-2 font-medium">Material</th>
                    <th className="px-4 py-2 font-medium">Batch</th>
                    <th className="px-4 py-2 font-medium">Specification</th>
                    <th className="px-4 py-2 font-medium">Batch status</th>
                    <th className="px-4 py-2 font-medium">Issued</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {list.items.map((c) => (
                    <tr key={c.id}>
                      <td className="px-4 py-2">
                        <Link
                          href={`/coa/${c.id}`}
                          className="numeric font-medium text-brand-600 hover:underline"
                        >
                          {c.coaNumber}
                        </Link>
                        {c.version > 1 && (
                          <span className="numeric ml-1 text-xs text-ink-400">v{c.version}</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <span className="numeric text-xs text-ink-500">{c.material.code}</span>
                        <div className="text-ink-900">{c.material.name}</div>
                      </td>
                      <td className="numeric px-4 py-2 text-xs text-ink-600">{c.batchNumber}</td>
                      <td className="numeric px-4 py-2 text-xs text-ink-600">
                        {c.specification}
                      </td>
                      <td className="px-4 py-2">
                        <StatusPill status={c.batchStatus} />
                      </td>
                      <td className="numeric whitespace-nowrap px-4 py-2 text-xs text-ink-500">
                        {dateTime(c.issuedAt)}
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
