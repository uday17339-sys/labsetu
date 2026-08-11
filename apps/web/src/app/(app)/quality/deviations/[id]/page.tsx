import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { Card, StatusPill } from '@/components/ui';
import { dateTime, date } from '@/lib/format';
import { getSessionUser, can } from '@/lib/session';

export const dynamic = 'force-dynamic';

interface Deviation {
  id: string;
  deviationNumber: string;
  title: string;
  description: string;
  category: string;
  severity: string;
  status: string;
  productImpact: string;
  occurredAt: string;
  detectedAt: string;
  detectionLagHours: number;
  openDays: number;
  investigation: string | null;
  rootCause: string | null;
  impactAssessment: string | null;
  closedAt: string | null;
  batch: { id: string; batchNumber: string; material: string } | null;
  device: { code: string; name: string } | null;
  capas: {
    id: string;
    capaNumber: string;
    title: string;
    kind: string;
    status: string;
    dueAt: string;
    isOverdue: boolean;
    effectivenessVerdict: string | null;
  }[];
}

/**
 * One deviation, end to end.
 *
 * Laid out in the order the record is built rather than the order the fields
 * sit in the table: what happened, what was found, what is being done about it.
 * A reader coming to this a year later is following a narrative, not auditing a
 * form.
 */
export default async function DeviationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();

  const d = await apiFetch<Deviation>(`/quality/deviations/${id}`).catch(() => null);
  if (!d) notFound();

  const closed = d.status === 'CLOSED';

  return (
    <div className="space-y-5">
      <div className="min-w-0">
        <Link href="/quality" className="text-sm text-brand-600 hover:underline">
          ← Quality system
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="numeric text-xl font-semibold text-ink-900">{d.deviationNumber}</h1>
          <StatusPill status={d.status} />
          {d.severity !== 'UNCLASSIFIED' && (
            <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-700">
              {d.severity.toLowerCase()}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-ink-700">{d.title}</p>
      </div>

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-3">
        <div className="min-w-0 space-y-5 lg:col-span-2">
          <Card title="What happened">
            <div className="space-y-3 px-4 py-3 text-sm">
              <p className="whitespace-pre-wrap text-ink-800">{d.description}</p>
              <dl className="grid grid-cols-2 gap-3 border-t border-ink-100 pt-3 text-xs">
                <Detail label="Occurred" value={dateTime(d.occurredAt)} />
                <Detail label="Detected" value={dateTime(d.detectedAt)} />
                {/* The gap between the two is itself a finding. */}
                <Detail
                  label="Detection lag"
                  value={
                    d.detectionLagHours < 24
                      ? `${d.detectionLagHours} hours`
                      : `${Math.round(d.detectionLagHours / 24)} days`
                  }
                />
                <Detail label="Open" value={`${d.openDays} days`} />
                <Detail label="Category" value={d.category.replace(/_/g, ' ').toLowerCase()} />
                <Detail
                  label="Product impact"
                  value={
                    d.productImpact === 'NOT_ASSESSED'
                      ? 'not yet assessed'
                      : d.productImpact.toLowerCase()
                  }
                />
              </dl>
            </div>
          </Card>

          <Card title="Investigation">
            {d.investigation ? (
              <div className="space-y-3 px-4 py-3 text-sm">
                <p className="whitespace-pre-wrap text-ink-800">{d.investigation}</p>
                {d.rootCause && (
                  <div className="border-t border-ink-100 pt-3">
                    <div className="text-xs uppercase tracking-wide text-ink-500">Root cause</div>
                    <p className="mt-1 whitespace-pre-wrap text-ink-800">{d.rootCause}</p>
                  </div>
                )}
                {d.impactAssessment && (
                  <div className="border-t border-ink-100 pt-3">
                    <div className="text-xs uppercase tracking-wide text-ink-500">
                      Impact assessment
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-ink-800">{d.impactAssessment}</p>
                  </div>
                )}
              </div>
            ) : (
              <p className="px-4 py-3 text-sm text-ink-500">
                Not yet investigated. A deviation cannot be closed until what was looked at is
                recorded.
              </p>
            )}
          </Card>

          <Card title={`Corrective and preventive actions (${d.capas.length})`}>
            {d.capas.length === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-500">
                No actions raised.
                {(d.productImpact === 'POTENTIAL' || d.productImpact === 'CONFIRMED') && (
                  <span className="font-medium text-amber-800">
                    {' '}
                    This deviation assesses product impact, so it cannot be closed without one.
                  </span>
                )}
              </p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {d.capas.map((c) => (
                  <li key={c.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="numeric text-sm font-medium text-ink-900">
                          {c.capaNumber}
                          <span className="ml-2 text-xs font-normal text-ink-500">
                            {c.kind.toLowerCase()}
                          </span>
                        </div>
                        <div className="mt-0.5 text-sm text-ink-700">{c.title}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <StatusPill status={c.status} />
                        <div
                          className={`numeric mt-1 text-xs ${
                            c.isOverdue ? 'font-medium text-red-700' : 'text-ink-500'
                          }`}
                        >
                          due {date(c.dueAt)}
                        </div>
                        {c.effectivenessVerdict && (
                          <div
                            className={`text-xs ${
                              c.effectivenessVerdict === 'EFFECTIVE'
                                ? 'text-emerald-700'
                                : 'font-medium text-red-700'
                            }`}
                          >
                            {c.effectivenessVerdict.replace(/_/g, ' ').toLowerCase()}
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-5">
          <Card title="Linked records">
            <dl className="space-y-3 px-4 py-3 text-sm">
              {d.batch ? (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-ink-500">Batch</dt>
                  <dd className="mt-0.5">
                    <Link
                      href={`/stores/${d.batch.id}`}
                      className="numeric text-brand-600 hover:underline"
                    >
                      {d.batch.batchNumber}
                    </Link>
                    <div className="text-xs text-ink-500">{d.batch.material}</div>
                  </dd>
                </div>
              ) : (
                <p className="text-xs text-ink-500">
                  Not linked to a batch. A deviation can be about a room, a utility or a
                  procedure and touch no material at all.
                </p>
              )}

              {d.device && (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-ink-500">Instrument</dt>
                  <dd className="numeric mt-0.5 text-ink-800">
                    {d.device.code} — {d.device.name}
                  </dd>
                </div>
              )}

              {closed && d.closedAt && (
                <div className="border-t border-ink-100 pt-3">
                  <dt className="text-xs uppercase tracking-wide text-ink-500">Closed</dt>
                  <dd className="numeric mt-0.5 text-ink-800">{dateTime(d.closedAt)}</dd>
                </div>
              )}
            </dl>
          </Card>

          {!closed && can(user, 'deviation:close') && (
            <Card title="Closing this deviation">
              {/*
                Stated rather than enforced only at the API. Someone reading the
                screen should know why the button will refuse them before they
                press it.
              */}
              <ul className="space-y-2 px-4 py-3 text-xs text-ink-600">
                <li className={d.investigation ? 'text-emerald-700' : ''}>
                  {d.investigation ? '✓' : '○'} An investigation is recorded
                </li>
                <li>○ A root cause, severity and product-impact judgement are required</li>
                <li className={d.capas.length > 0 ? 'text-emerald-700' : ''}>
                  {d.capas.length > 0 ? '✓' : '○'} A CAPA exists, if product impact is potential
                  or confirmed
                </li>
              </ul>
            </Card>
          )}

          <Card title="Audit">
            <p className="px-4 py-3 text-xs text-ink-500">
              Every step on this record — raised, investigated, closed — is a separate entry in
              the audit trail.{' '}
              <Link
                href={`/audit?entityType=Deviation&entityId=${d.id}`}
                className="text-brand-600 hover:underline"
              >
                View the trail for this deviation
              </Link>
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-500">{label}</dt>
      <dd className="numeric mt-0.5 truncate text-ink-800">{value}</dd>
    </div>
  );
}
