import Link from 'next/link';
import { notFound } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, StatusPill } from '@/components/ui';
import { date } from '@/lib/format';
import { Submit, TextArea, Field } from '@/components/forms';

export const dynamic = 'force-dynamic';

interface Spec {
  id: string;
  code: string;
  version: number;
  status: string;
  basis: string | null;
  material: {
    id: string;
    code: string;
    name: string;
    type: string;
    pharmacopoeia: string | null;
  };
  effectiveFrom: string | null;
  effectiveTo: string | null;
  approvedAt: string | null;
  inForce: boolean;
  limits: {
    id: string;
    analyte: { id: string; code: string; name: string; defaultUnit: string | null };
    test: { id: string; code: string; name: string } | null;
    minValue: number | null;
    maxValue: number | null;
    textCriteria: string | null;
    unit: string | null;
    isCritical: boolean;
    display: string;
  }[];
}

export default async function SpecificationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();

  const spec = await apiFetch<Spec>(`/specifications/${id}`).catch((e) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  });
  if (!spec) notFound();

  async function approve(formData: FormData): Promise<void> {
    'use server';
    await apiFetch(`/specifications/${id}/approve`, {
      method: 'POST',
      body: {
        effectiveFrom: String(formData.get('effectiveFrom') ?? '').trim() || undefined,
        note: String(formData.get('note') ?? '').trim(),
      },
    });
    revalidatePath(`/specifications/${id}`);
    revalidatePath('/specifications');
  }

  const canApprove = can(user, 'spec:approve') && spec.status === 'DRAFT';
  const untested = spec.limits.filter((l) => !l.test);

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/specifications"
          className="-ml-2 inline-flex min-h-11 items-center px-2 text-sm text-brand-600 hover:underline"
        >
          ← Specifications
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="numeric break-words text-xl font-semibold text-ink-900">
              {spec.code} <span className="text-base font-normal text-ink-500">v{spec.version}</span>
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-500">
              <StatusPill status={spec.status} />
              <span>{spec.material.name}</span>
              {spec.basis && <span>· {spec.basis}</span>}
            </div>
          </div>
        </div>
      </div>

      {spec.status === 'DRAFT' && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-900">Draft — governs nothing yet</p>
          <p className="mt-0.5 text-xs text-amber-800">
            Batches of {spec.material.name} cannot be sampled until a specification for it is
            approved.
          </p>
        </div>
      )}

      {untested.length > 0 && (
        <div className="rounded-lg border border-orange-300 bg-orange-50 px-4 py-3">
          <p className="text-sm font-medium text-orange-900">
            {untested.length} criteri{untested.length === 1 ? 'on has' : 'a have'} no test attached
          </p>
          <p className="mt-0.5 text-xs text-orange-800">
            QC books tests from this specification. A criterion with no test will never be measured
            and will show as &ldquo;not tested&rdquo; at release, blocking it.
          </p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2" title={`Acceptance criteria (${spec.limits.length})`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Parameter</th>
                  <th className="px-4 py-2 font-medium">Criterion</th>
                  <th className="px-4 py-2 font-medium">Test</th>
                  <th className="px-4 py-2 font-medium">Class</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {spec.limits.map((l) => (
                  <tr key={l.id} className={!l.test ? 'bg-orange-50/50' : ''}>
                    <td className="px-4 py-2">
                      <div className="font-medium text-ink-900">{l.analyte.name}</div>
                      <div className="numeric text-xs text-ink-400">{l.analyte.code}</div>
                    </td>
                    <td className="numeric px-4 py-2 text-ink-700">{l.display}</td>
                    <td className="px-4 py-2 text-xs text-ink-600">
                      {l.test ? (
                        <>
                          <span className="numeric text-ink-500">{l.test.code}</span> {l.test.name}
                        </>
                      ) : (
                        <span className="font-medium text-orange-700">none attached</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {l.isCritical ? (
                        <span className="rounded bg-ink-900 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                          critical
                        </span>
                      ) : (
                        <span className="text-xs text-ink-400">non-critical</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-400">
            A critical parameter out of specification fails the batch outright. A non-critical
            excursion may still be released, but only against a named deviation.
          </p>
        </Card>

        <div className="space-y-5">
          {canApprove && (
            <Card title="Approve">
              <form action={approve} className="space-y-3 p-4">
                <Field
                  label="Effective from"
                  name="effectiveFrom"
                  type="date"
                  hint="Leave blank for immediately."
                />
                <TextArea
                  label="Basis for approval"
                  name="note"
                  rows={3}
                  required
                  minLength={5}
                  placeholder="e.g. Reviewed against IP 2022 monograph and supplier CoA. Limits align with the registered dossier."
                />
                <Submit label="Approve specification" />
                <p className="text-xs text-ink-400">
                  Supersedes the version currently in force for this material at the same instant,
                  so there is never a gap and never an overlap. You cannot approve a specification
                  you authored yourself.
                </p>
              </form>
            </Card>
          )}

          <Card title="Details">
            <dl className="divide-y divide-ink-100 text-sm">
              <Row label="Material">{spec.material.name}</Row>
              <Row label="Code">{spec.material.code}</Row>
              <Row label="Type">{spec.material.type.replace(/_/g, ' ').toLowerCase()}</Row>
              <Row label="Pharmacopoeia">{spec.material.pharmacopoeia ?? '—'}</Row>
              <Row label="Basis">{spec.basis ?? '—'}</Row>
              <Row label="Effective from">{date(spec.effectiveFrom)}</Row>
              <Row label="Effective to">{spec.effectiveTo ? date(spec.effectiveTo) : 'open'}</Row>
              <Row label="Approved">{date(spec.approvedAt)}</Row>
              <Row label="Critical criteria">
                {spec.limits.filter((l) => l.isCritical).length} of {spec.limits.length}
              </Row>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 px-4 py-2">
      <dt className="shrink-0 text-ink-500">{label}</dt>
      <dd className="numeric min-w-0 text-right text-ink-900">{children}</dd>
    </div>
  );
}
