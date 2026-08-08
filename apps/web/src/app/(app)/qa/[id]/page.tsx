import Link from 'next/link';
import { notFound } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, EmptyState, StatusPill } from '@/components/ui';
import { date, dateTime } from '@/lib/format';
import { DispositionForm, IssueCoaForm } from './forms';

export const dynamic = 'force-dynamic';

interface Assessment {
  analyte: { id: string; code: string; name: string; defaultUnit: string | null };
  criterion: string;
  isCritical: boolean;
  value: string | null;
  numericValue?: number | null;
  unit?: string | null;
  testCode?: string;
  accessionNumber?: string;
  testStatus?: string;
  verdict: 'PASS' | 'FAIL' | 'NOT_TESTED' | 'NOT_ASSESSABLE';
}

interface Review {
  batch: {
    id: string;
    batchNumber: string;
    manufacturerLot: string | null;
    status: string;
    quantityAvailable: number;
    unit: string;
    expiryDate: string | null;
    material: { id: string; code: string; name: string; type: string; pharmacopoeia: string | null };
  };
  specification: { id: string; code: string; version: number; basis: string | null } | null;
  assessment: Assessment[];
  summary: {
    criteria: number;
    passed: number;
    failed: number;
    criticalFailures: number;
    notTested: number;
    notAssessable: number;
  };
  blockers: string[];
  lastDisposition: { decision: string; rationale: string; decidedAt: string } | null;
}

export default async function QaBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();

  const review = await apiFetch<Review>(`/qa/batches/${id}/review`).catch((e) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  });
  if (!review) notFound();

  async function dispose(formData: FormData): Promise<void> {
    'use server';
    const password = String(formData.get('password') ?? '');
    const totpCode = String(formData.get('totpCode') ?? '').trim() || undefined;

    const { contentHash } = await apiFetch<{ contentHash: string }>(
      `/qa/batches/${id}/content-hash`,
    );

    const { signingToken } = await apiFetch<{ signingToken: string }>('/auth/signing-token', {
      method: 'POST',
      body: {
        password,
        totpCode,
        entityType: 'MaterialBatch',
        entityId: id,
        meaning: String(formData.get('decision')) === 'REJECTED' ? 'REJECTED' : 'APPROVED',
        contentHash,
      },
    });

    await apiFetch(`/qa/batches/${id}/disposition`, {
      method: 'POST',
      body: {
        decision: String(formData.get('decision') ?? 'APPROVED'),
        rationale: String(formData.get('rationale') ?? '').trim(),
        deviationRef: String(formData.get('deviationRef') ?? '').trim() || undefined,
        signingToken,
      },
    });

    revalidatePath(`/qa/${id}`);
    revalidatePath('/qa');
    revalidatePath('/stores');
  }

  async function issueCoa(): Promise<void> {
    'use server';
    await apiFetch(`/qa/batches/${id}/coa`, { method: 'POST' });
    revalidatePath(`/qa/${id}`);
  }

  const canDispose = can(user, 'batch:disposition');
  const decided = review.batch.status === 'APPROVED' || review.batch.status === 'REJECTED';

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/qa"
          className="-ml-2 inline-flex min-h-11 items-center px-2 text-sm text-brand-600 hover:underline"
        >
          ← QA queue
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="break-words text-xl font-semibold text-ink-900">
              {review.batch.material.name}
            </h1>
            <div className="numeric mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-500">
              <StatusPill status={review.batch.status} />
              <span>batch {review.batch.batchNumber}</span>
              <span>· {review.batch.material.code}</span>
              {review.batch.expiryDate && <span>· exp {date(review.batch.expiryDate)}</span>}
            </div>
          </div>
          <Link
            href={`/stores/${review.batch.id}`}
            className="min-h-11 rounded-md border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-100"
          >
            Batch record
          </Link>
        </div>
      </div>

      {review.blockers.length > 0 && !decided && (
        <div className="rounded-lg border-2 border-[var(--color-critical)] bg-[var(--color-critical-bg)] px-4 py-3">
          <p className="text-sm font-bold text-[var(--color-critical)]">
            This batch cannot be released yet
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-[var(--color-critical)]">
            {review.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      {review.lastDisposition && (
        <div
          className={`rounded-lg border-2 px-4 py-3 ${
            review.lastDisposition.decision === 'REJECTED'
              ? 'border-[var(--color-critical)] bg-[var(--color-critical-bg)]'
              : 'border-emerald-300 bg-emerald-50'
          }`}
        >
          <p
            className={`text-sm font-bold ${
              review.lastDisposition.decision === 'REJECTED'
                ? 'text-[var(--color-critical)]'
                : 'text-emerald-800'
            }`}
          >
            {review.lastDisposition.decision.replace(/_/g, ' ').toLowerCase()} ·{' '}
            {dateTime(review.lastDisposition.decidedAt)}
          </p>
          <p className="mt-0.5 text-xs text-ink-700">{review.lastDisposition.rationale}</p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title={
            review.specification
              ? `Results against ${review.specification.code} v${review.specification.version}`
              : 'Results'
          }
        >
          {!review.specification ? (
            <EmptyState
              title="No specification governs this batch"
              hint="QA must approve a specification for this material before the batch can be judged."
            />
          ) : review.assessment.length === 0 ? (
            <EmptyState title="No acceptance criteria" />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                    <tr>
                      <th className="px-4 py-2 font-medium">Parameter</th>
                      <th className="px-4 py-2 font-medium">Acceptance criterion</th>
                      <th className="px-4 py-2 font-medium">Result</th>
                      <th className="px-4 py-2 font-medium">Verdict</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {review.assessment.map((a) => (
                      <tr
                        key={a.analyte.id}
                        className={
                          a.verdict === 'FAIL'
                            ? 'bg-[var(--color-critical-bg)]'
                            : a.verdict === 'NOT_TESTED'
                              ? 'bg-amber-50/60'
                              : ''
                        }
                      >
                        <td className="px-4 py-2">
                          <div className="font-medium text-ink-900">{a.analyte.name}</div>
                          <div className="numeric text-xs text-ink-400">
                            {a.analyte.code}
                            {a.isCritical && (
                              <span className="ml-1.5 rounded bg-ink-900 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
                                critical
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="numeric px-4 py-2 text-ink-600">{a.criterion}</td>
                        <td className="numeric px-4 py-2 font-semibold text-ink-900">
                          {a.value ?? '—'}
                          {a.unit && <span className="ml-1 font-normal text-ink-500">{a.unit}</span>}
                          {a.accessionNumber && (
                            <div className="numeric text-[10px] font-normal text-ink-400">
                              {a.accessionNumber}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <Verdict verdict={a.verdict} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-ink-100 px-4 py-2 text-xs">
                <span className="text-ink-500">
                  {review.summary.criteria} criteria ·{' '}
                  <span className="font-medium text-[var(--color-normal)]">
                    {review.summary.passed} passed
                  </span>
                  {review.summary.failed > 0 && (
                    <>
                      {' · '}
                      <span className="font-medium text-[var(--color-critical)]">
                        {review.summary.failed} failed
                      </span>
                    </>
                  )}
                  {review.summary.notTested > 0 && (
                    <>
                      {' · '}
                      <span className="font-medium text-[var(--color-high)]">
                        {review.summary.notTested} not tested
                      </span>
                    </>
                  )}
                  {review.summary.notAssessable > 0 && (
                    <> · {review.summary.notAssessable} assessed by the analyst</>
                  )}
                </span>
              </div>
            </>
          )}
        </Card>

        <div className="space-y-5">
          {canDispose && !decided && (
            <Card title="Disposition">
              <DispositionForm
                action={dispose}
                blockers={review.blockers}
                failedCount={review.summary.failed}
                mfaEnabled={user?.isMfaEnabled ?? false}
              />
            </Card>
          )}

          {review.batch.status === 'APPROVED' && can(user, 'coa:issue') && (
            <Card title="Certificate of analysis">
              <IssueCoaForm action={issueCoa} />
            </Card>
          )}

          <Card title="Batch">
            <dl className="divide-y divide-ink-100 text-sm">
              <Row label="Material type">
                {review.batch.material.type.replace(/_/g, ' ').toLowerCase()}
              </Row>
              {review.batch.material.pharmacopoeia && (
                <Row label="Pharmacopoeia">{review.batch.material.pharmacopoeia}</Row>
              )}
              {review.batch.manufacturerLot && (
                <Row label="Supplier lot">{review.batch.manufacturerLot}</Row>
              )}
              <Row label="Quantity">
                {review.batch.quantityAvailable} {review.batch.unit}
              </Row>
              {review.specification?.basis && (
                <Row label="Spec basis">{review.specification.basis}</Row>
              )}
            </dl>
          </Card>

          {!canDispose && (
            <p className="text-xs text-ink-400">
              You can review this batch but not release it. Disposition is held by QA alone —
              the analyst who produced a result does not decide its consequence.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Verdict({ verdict }: { verdict: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    PASS: { label: 'Complies', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
    FAIL: {
      label: 'Out of spec',
      cls: 'bg-[var(--color-critical-bg)] text-[var(--color-critical)] ring-red-300 font-bold',
    },
    NOT_TESTED: { label: 'Not tested', cls: 'bg-amber-50 text-amber-800 ring-amber-200' },
    NOT_ASSESSABLE: { label: 'By analyst', cls: 'bg-ink-100 text-ink-600 ring-ink-200' },
  };
  const v = map[verdict] ?? map.NOT_ASSESSABLE!;
  return (
    <span className={`inline-flex whitespace-nowrap rounded px-2 py-0.5 text-xs ring-1 ${v.cls}`}>
      {v.label}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 px-4 py-2">
      <dt className="shrink-0 text-ink-500">{label}</dt>
      <dd className="min-w-0 text-right text-ink-900">{children}</dd>
    </div>
  );
}
