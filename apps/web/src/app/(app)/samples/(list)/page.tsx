import Link from 'next/link';
import { redirect } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { Card, StatusPill, EmptyState } from '@/components/ui';
import { FilterSubmit } from '@/components/filter-submit';

export const dynamic = 'force-dynamic';

interface SampleRow {
  id: string;
  accessionNumber: string;
  barcode: string | null;
  status: string;
  priority: string;
  createdAt: string;
  lab: { code: string };
  patient: { patientCode: string; sex: string; ageYears: number | null } | null;
  specimenType: { code: string; name: string } | null;
  containerType: { name: string; colour: string | null } | null;
  tests: { id: string; status: string; testDefinition: { code: string } }[];
}

async function scan(formData: FormData): Promise<void> {
  'use server';
  const q = String(formData.get('q') ?? '').trim();
  if (!q) redirect('/samples');
  // Barcode scanners type the accession number and press Enter, so this route
  // takes the user straight to the sample rather than to a filtered list.
  redirect(`/samples?accessionNumber=${encodeURIComponent(q.toUpperCase())}`);
}

export default async function SamplesPage({
  searchParams,
}: {
  searchParams: Promise<{ accessionNumber?: string; status?: string }>;
}) {
  const params = await searchParams;

  const query = new URLSearchParams({ limit: '100' });
  if (params.accessionNumber) query.set('accessionNumber', params.accessionNumber);
  if (params.status) query.set('status', params.status);

  const { items } = await apiFetch<{ items: SampleRow[] }>(`/samples?${query}`).catch(() => ({
    items: [] as SampleRow[],
  }));

  // A scan that matches exactly one sample goes straight there.
  if (params.accessionNumber && items.length === 1) {
    redirect(`/samples/${items[0]!.id}`);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Samples</h1>
          <p className="mt-0.5 text-sm text-ink-500">{items.length} shown</p>
        </div>

        <form action={scan} className="flex gap-2">
          <input
            name="q"
            autoFocus
            defaultValue={params.accessionNumber ?? ''}
            placeholder="Scan or type accession number"
            autoComplete="off"
            className="numeric w-72 rounded-md border border-ink-300 px-3 py-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          <FilterSubmit label="Find" />
        </form>
      </div>

      {params.accessionNumber && items.length === 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          No sample found for <span className="numeric font-medium">{params.accessionNumber}</span>.
          Check the barcode, or the sample may belong to another branch.
        </div>
      )}

      <Card>
        {items.length === 0 ? (
          <EmptyState title="No samples" hint="Register an order to create one." />
        ) : (
          <>
            {/* Mobile: cards. Scanning a barcode at the receiving bench is a
                phone-first task. */}
            <ul className="divide-y divide-ink-100 md:hidden">
              {items.map((s) => (
                <li key={s.id}>
                  <Link href={`/samples/${s.id}`} className="block px-4 py-3 active:bg-ink-100">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="numeric font-semibold text-brand-600">
                          {s.accessionNumber}
                        </div>
                        <div className="mt-0.5 text-sm text-ink-700">
                          {s.patient
                            ? `${s.patient.patientCode} · ${s.patient.sex[0]}/${s.patient.ageYears ?? '?'}`
                            : '—'}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-ink-500">
                          {s.specimenType?.name ?? '—'}
                          {s.tests.length > 0 && ` · ${s.tests.map((t) => t.testDefinition.code).join(', ')}`}
                        </div>
                      </div>
                      <StatusPill status={s.status} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Accession</th>
                  <th className="px-4 py-2 font-medium">Patient</th>
                  <th className="px-4 py-2 font-medium">Specimen</th>
                  <th className="px-4 py-2 font-medium">Tests</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Registered</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {items.map((s) => (
                  <tr key={s.id} className="hover:bg-ink-50">
                    <td className="whitespace-nowrap px-4 py-2">
                      <Link
                        href={`/samples/${s.id}`}
                        className="numeric font-medium text-brand-600 hover:underline"
                      >
                        {s.accessionNumber}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-ink-600">
                      {s.patient
                        ? `${s.patient.patientCode} · ${s.patient.sex[0]}/${s.patient.ageYears ?? '?'}`
                        : '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-ink-600">
                      {s.specimenType?.name ?? '—'}
                      {s.containerType?.colour && (
                        <span className="ml-2 text-xs text-ink-400">({s.containerType.colour})</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-600">
                      {s.tests.map((t) => t.testDefinition.code).join(', ')}
                    </td>
                    <td className="px-4 py-2">
                      <StatusPill status={s.status} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-500">
                      {new Date(s.createdAt).toLocaleString('en-IN', {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
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
