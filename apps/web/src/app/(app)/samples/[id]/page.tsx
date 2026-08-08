import Link from 'next/link';
import { cache } from 'react';
import type { Metadata } from 'next';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, StatusPill, EmptyState } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface OrderReport {
  id: string;
  reportNumber: string;
  version: number;
  status: string;
  isPartial: boolean;
  releasedAt: string | null;
}

interface SampleDetail {
  id: string;
  accessionNumber: string;
  barcode: string | null;
  status: string;
  priority: string;
  collectedAt: string | null;
  receivedAt: string | null;
  createdAt: string;
  lab: { code: string; name: string };
  order: { id: string; orderNumber: string; priority: string; clinicalNotes: string | null };
  patient: { id: string; patientCode: string; sex: string; ageYears: number | null } | null;
  specimenType: { code: string; name: string } | null;
  containerType: { name: string; colour: string | null } | null;
  rejectionReason: { code: string; name: string } | null;
  tests: {
    id: string;
    status: string;
    testDefinition: { id: string; code: string; name: string; department: string };
    results: { id: string }[];
  }[];
}

async function collectSample(id: string): Promise<void> {
  'use server';
  await apiFetch(`/samples/${id}/collect`, { method: 'POST', body: {} });
  revalidatePath(`/samples/${id}`);
}

async function receiveSample(id: string): Promise<void> {
  'use server';
  await apiFetch(`/samples/${id}/receive`, { method: 'POST', body: {} });
  revalidatePath(`/samples/${id}`);
}

async function generateReport(orderId: string): Promise<void> {
  'use server';
  const report = await apiFetch<{ id: string }>('/reports', {
    method: 'POST',
    // Partial by default: labs routinely release the completed tests without
    // waiting for the slowest one.
    body: { orderId, isPartial: true },
  });
  redirect(`/reports/${report.id}`);
}

/**
 * Fetched once per request and shared between generateMetadata and the page.
 *
 * The dedupe is what makes the pattern below free: React's cache() returns the
 * same promise to both callers, so the API is hit once.
 */
const getSample = cache(async (id: string): Promise<SampleDetail | null> => {
  try {
    return await apiFetch<SampleDetail>(`/samples/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
});

/**
 * Next resolves generateMetadata BEFORE it begins streaming the layout, so a
 * notFound() here can still set a real 404 status. Calling it from the page
 * body instead yields a correctly-rendered 404 page with a 200 status, because
 * the shell has already been flushed — which would mislead uptime monitors and
 * any integration reading the status code.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const sample = await getSample(id);
  if (!sample) notFound();
  return { title: `Sample ${sample.accessionNumber}` };
}

export default async function SampleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();

  const sample = await getSample(id);
  if (!sample) notFound();

  const authorizedTests = sample.tests.filter((t) => t.status === 'AUTHORIZED');
  const canGenerate = can(user, 'report:generate') && authorizedTests.length > 0;

  // Existing reports for this order. Showing them is what stops someone
  // generating a second report for results that already have one.
  const order = await apiFetch<{ reports?: OrderReport[] }>(
    `/orders/${sample.order.id}`,
  ).catch(() => ({ reports: [] as OrderReport[] }));
  const reports = order.reports ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/samples" className="text-sm text-ink-500 hover:underline">
            ← Samples
          </Link>
          <h1 className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xl font-semibold text-ink-900">
            <span className="numeric">{sample.accessionNumber}</span>
            <StatusPill status={sample.status} />
          </h1>
          <p className="mt-1 text-sm text-ink-600">
            Order {sample.order.orderNumber} · {sample.lab.code}
            {sample.patient && (
              <>
                {' · '}
                {sample.patient.patientCode} ({sample.patient.sex[0]}/
                {sample.patient.ageYears ?? '?'})
              </>
            )}
          </p>
        </div>

        <div className="flex gap-2">
          {can(user, 'sample:collect') && sample.status === 'REGISTERED' && (
            <form action={collectSample.bind(null, sample.id)}>
              <button className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
                Mark collected
              </button>
            </form>
          )}
          {can(user, 'sample:receive') && ['COLLECTED', 'IN_TRANSIT'].includes(sample.status) && (
            <form action={receiveSample.bind(null, sample.id)}>
              <button className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
                Receive into lab
              </button>
            </form>
          )}
          {canGenerate && (
            <form action={generateReport.bind(null, sample.order.id)}>
              <button className="min-h-11 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
                {reports.some((r) => r.status === 'DRAFT')
                  ? 'Open draft report'
                  : `Generate report (${authorizedTests.length})`}
              </button>
            </form>
          )}
          {sample.patient && can(user, 'result:read') && (
            <Link
              href={`/patients/${sample.patient.id}/history`}
              className="min-h-11 rounded-md border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-100"
            >
              Patient history
            </Link>
          )}
          <Link
            href={`/audit?entityType=Sample&entityId=${sample.id}`}
            className="min-h-11 rounded-md border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-100"
          >
            Audit
          </Link>
        </div>
      </div>

      {sample.status === 'REJECTED' && sample.rejectionReason && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3">
          <p className="text-sm font-medium text-red-900">
            Sample rejected — {sample.rejectionReason.name}
          </p>
          <p className="mt-1 text-xs text-red-800">
            Outstanding tests were cancelled. A repeat needs a fresh specimen with its own
            accession number.
          </p>
        </div>
      )}

      {reports.length > 0 && (
        <Card title="Reports for this order">
          <ul className="divide-y divide-ink-100">
            {reports.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <div>
                  <Link
                    href={`/reports/${r.id}`}
                    className="numeric font-medium text-brand-600 hover:underline"
                  >
                    {r.reportNumber}
                  </Link>
                  <span className="ml-2 text-xs text-ink-500">v{r.version}</span>
                  {r.isPartial && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                      partial
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill status={r.status} />
                  <span className="text-xs text-ink-500">
                    {r.releasedAt ? new Date(r.releasedAt).toLocaleDateString('en-IN') : 'not released'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-3">
        <Card className="min-w-0 lg:col-span-2" title="Tests on this sample">
          {sample.tests.length === 0 ? (
            <EmptyState title="No tests" />
          ) : (
            <>
            {/* Mobile: cards. This table was the last screen still forcing a
                horizontal scroll on a narrow phone. */}
            <ul className="divide-y divide-ink-100 md:hidden">
              {sample.tests.map((t) => (
                <li key={t.id}>
                  <Link href={`/tests/${t.id}`} className="block px-4 py-3 active:bg-ink-100">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-ink-900">
                          {t.testDefinition.code}
                          <span className="ml-2 font-normal text-ink-500">
                            {t.testDefinition.name}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs text-ink-500">
                          {t.testDefinition.department.replace(/_/g, ' ').toLowerCase()} ·{' '}
                          {t.results.length} result{t.results.length === 1 ? '' : 's'}
                        </div>
                      </div>
                      <StatusPill status={t.status} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Test</th>
                  <th className="px-4 py-2 font-medium">Department</th>
                  <th className="px-4 py-2 font-medium">Results</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {sample.tests.map((t) => (
                  <tr key={t.id} className="hover:bg-ink-50">
                    <td className="px-4 py-2">
                      <span className="font-medium text-ink-900">{t.testDefinition.code}</span>
                      <span className="ml-2 text-ink-500">{t.testDefinition.name}</span>
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-500">
                      {t.testDefinition.department.replace(/_/g, ' ').toLowerCase()}
                    </td>
                    <td className="numeric px-4 py-2 text-ink-600">{t.results.length}</td>
                    <td className="px-4 py-2">
                      <StatusPill status={t.status} />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        href={`/tests/${t.id}`}
                        className="rounded-md border border-ink-300 px-2.5 py-1 text-xs font-medium text-ink-700 hover:bg-ink-100"
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            </>
          )}
        </Card>

        <Card title="Chain of custody">
          <dl className="divide-y divide-ink-100 text-sm">
            <Row label="Registered" value={fmt(sample.createdAt)} />
            <Row label="Collected" value={fmt(sample.collectedAt)} />
            <Row label="Received" value={fmt(sample.receivedAt)} />
            <Row label="Specimen" value={sample.specimenType?.name ?? '—'} />
            <Row
              label="Container"
              value={
                sample.containerType
                  ? `${sample.containerType.name}${
                      sample.containerType.colour ? ` (${sample.containerType.colour})` : ''
                    }`
                  : '—'
              }
            />
            <Row label="Barcode" value={sample.barcode ?? '—'} mono />
          </dl>
          {sample.order.clinicalNotes && (
            <div className="border-t border-ink-100 px-4 py-3">
              <div className="text-xs font-medium uppercase tracking-wide text-ink-500">
                Clinical notes
              </div>
              <p className="mt-1 text-sm text-ink-700">{sample.order.clinicalNotes}</p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 px-4 py-2">
      <dt className="text-ink-500">{label}</dt>
      <dd className={`text-right text-ink-900 ${mono ? 'numeric' : ''}`}>{value}</dd>
    </div>
  );
}

function fmt(v: string | null): string {
  if (!v) return '—';
  return new Date(v).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
