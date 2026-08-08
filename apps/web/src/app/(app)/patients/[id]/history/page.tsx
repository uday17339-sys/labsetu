import Link from 'next/link';
import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, EmptyState, FlagBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface Cumulative {
  patient: {
    id: string;
    code: string;
    sex: string;
    ageYears: number | null;
    isErased: boolean;
  };
  columns: { key: string; accessionNumber: string; date: string; testCodes: string[] }[];
  rows: {
    analyteId: string;
    code: string;
    name: string;
    unit: string | null;
    department: string;
    values: Record<string, { value: string | null; flag: string; isCritical: boolean }>;
  }[];
  totalResults: number;
}

const getHistory = cache(async (id: string): Promise<Cumulative | null> => {
  try {
    return await apiFetch<Cumulative>(`/patients/${id}/history`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const data = await getHistory(id);
  if (!data) notFound();
  return { title: `History — ${data.patient.code}` };
}

export default async function PatientHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSessionUser();
  const data = await getHistory(id);
  if (!data) notFound();

  // Newest first: a clinician reads the latest value, then looks back.
  const columns = data.columns.slice(0, 12);

  // Group rows by department so a reader sees coherent panels rather than an
  // alphabetical jumble across biochemistry and haematology.
  const byDepartment = new Map<string, typeof data.rows>();
  for (const row of data.rows) {
    const list = byDepartment.get(row.department) ?? [];
    list.push(row);
    byDepartment.set(row.department, list);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/samples" className="text-sm text-ink-500 hover:underline">
            ← Samples
          </Link>
          <h1 className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xl font-semibold text-ink-900">
            <span className="numeric">{data.patient.code}</span>
            <span className="text-sm font-normal text-ink-500">
              {data.patient.sex[0]}/{data.patient.ageYears ?? '?'}
            </span>
          </h1>
          <p className="mt-1 text-sm text-ink-500">
            Cumulative history · {data.rows.length} analytes across {data.columns.length} visits
          </p>
        </div>
        {can(user, 'compliance:export') && (
          <a
            href="/api/v1/export/results.csv"
            className="min-h-11 rounded-md border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-100"
          >
            Export results CSV
          </a>
        )}
      </div>

      {data.rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No authorised results yet"
            hint="Only authorised and reported results appear here — an unverified value next to a released one would invite the wrong conclusion."
          />
        </Card>
      ) : (
        [...byDepartment.entries()].map(([department, rows]) => (
          <Card key={department} title={department.replace(/_/g, ' ').toLowerCase()}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <tr>
                    <th className="sticky left-0 bg-white px-4 py-2 font-medium">Analyte</th>
                    {columns.map((c) => (
                      <th key={c.key} className="px-3 py-2 text-right font-medium">
                        <div className="numeric text-ink-700">
                          {new Date(c.date).toLocaleDateString('en-IN', {
                            day: '2-digit',
                            month: 'short',
                          })}
                        </div>
                        <div className="numeric text-[10px] font-normal normal-case text-ink-400">
                          {c.accessionNumber.slice(-5)}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {rows.map((row) => (
                    <tr key={row.analyteId} className="hover:bg-ink-50">
                      <td className="sticky left-0 bg-white px-4 py-2">
                        <div className="font-medium text-ink-900">{row.name}</div>
                        <div className="text-xs text-ink-400">
                          {row.code}
                          {row.unit && ` · ${row.unit}`}
                        </div>
                      </td>
                      {columns.map((c) => {
                        const v = row.values[c.key];
                        return (
                          <td
                            key={c.key}
                            className={`px-3 py-2 text-right ${
                              v?.isCritical ? 'bg-[var(--color-critical-bg)]' : ''
                            }`}
                          >
                            {v ? (
                              <div className="flex items-center justify-end gap-1.5">
                                <span
                                  className={`numeric font-semibold ${
                                    v.isCritical
                                      ? 'text-[var(--color-critical)]'
                                      : v.flag === 'NORMAL'
                                        ? 'text-ink-900'
                                        : 'text-[var(--color-high)]'
                                  }`}
                                >
                                  {v.value}
                                </span>
                                {v.flag !== 'NORMAL' && <FlagBadge flag={v.flag} />}
                              </div>
                            ) : (
                              <span className="text-ink-300">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}

      <p className="text-xs text-ink-400">
        Only authorised and reported results are shown. Viewing this page is recorded in the audit
        trail as a PHI access.
      </p>
    </div>
  );
}
