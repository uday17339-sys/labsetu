import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, EmptyState, ErrorBanner } from '@/components/ui';
import { QcEntryForm, AcceptFailureForm } from './forms';

export const dynamic = 'force-dynamic';

interface QcLot {
  id: string;
  lotNumber: string;
  expiryDate: string | null;
  material: { code: string; name: string; level: string; manufacturer: string | null };
  analytes: {
    id: string;
    targetMean: string;
    targetSd: string;
    unit: string | null;
    analyte: { id: string; code: string; name: string; defaultUnit: string | null };
  }[];
}

interface QcResultRow {
  id: string;
  analyteCode: string;
  analyteName: string;
  unit: string | null;
  device: string | null;
  lot: string;
  material: string;
  level: string;
  value: string;
  zScore: number | null;
  status: string;
  violatedRules: string[];
  actionTaken: string | null;
  accepted: boolean;
  runAt: string;
}

interface Failure {
  id: string;
  analyte: string;
  analyteName: string;
  device: string | null;
  lot: string;
  value: string;
  zScore: number | null;
  violatedRules: string[];
  runAt: string;
}

async function recordQc(formData: FormData): Promise<void> {
  'use server';
  const [qcLotId, analyteId] = String(formData.get('target') ?? '').split('|');
  const value = String(formData.get('value') ?? '').trim();
  const deviceId = String(formData.get('deviceId') ?? '').trim() || undefined;

  if (!qcLotId || !analyteId || !value) return;

  try {
    await apiFetch('/qc/results', {
      method: 'POST',
      body: { qcLotId, analyteId, value, deviceId },
    });
  } catch (err) {
    const message = err instanceof ApiError ? err.message : 'Could not record the QC run.';
    revalidatePath('/qc');
    throw new Error(message);
  }
  revalidatePath('/qc');
}

async function acceptFailure(id: string, formData: FormData): Promise<void> {
  'use server';
  const actionTaken = String(formData.get('actionTaken') ?? '').trim();
  await apiFetch(`/qc/results/${id}/accept`, { method: 'POST', body: { actionTaken } });
  revalidatePath('/qc');
}

export default async function QcPage() {
  const user = await getSessionUser();

  const [lots, results, failures, refData] = await Promise.all([
    apiFetch<QcLot[]>('/qc/lots').catch(() => []),
    apiFetch<QcResultRow[]>('/qc/results?limit=60').catch(() => []),
    apiFetch<Failure[]>('/qc/failures').catch(() => []),
    apiFetch<{ devices: { id: string; code: string; name: string }[] }>(
      '/catalog/reference-data',
    ).catch(() => ({ devices: [] })),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Quality control</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Runs are evaluated against Westgard multi-rules on entry. A failure blocks
            authorisation of patient results on that analyzer until it is resolved.
          </p>
        </div>
        {can(user, 'compliance:export') && (
          <a
            href="/api/v1/export/qc.csv"
            className="min-h-11 rounded-md border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-100"
          >
            Export CSV
          </a>
        )}
      </div>

      {/* Open failures are the loudest thing here: each one is actively blocking
          patient results from being released. */}
      {failures.length > 0 && (
        <div className="rounded-lg border-2 border-[var(--color-critical)] bg-[var(--color-critical-bg)] px-4 py-3">
          <p className="text-sm font-bold text-[var(--color-critical)]">
            {failures.length} unresolved QC failure{failures.length > 1 ? 's' : ''} — patient
            results are blocked
          </p>
          <ul className="mt-2 space-y-2">
            {failures.map((f) => (
              <li key={f.id} className="rounded border border-red-200 bg-white px-3 py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-ink-900">
                    {f.analyteName} ({f.analyte})
                    {f.device && <span className="text-ink-500"> · {f.device}</span>}
                  </span>
                  <span className="numeric text-sm text-[var(--color-critical)]">
                    {f.value} · {f.zScore?.toFixed(2)} SD
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-ink-600">
                  Lot {f.lot} · rules {f.violatedRules.join(', ') || '—'} ·{' '}
                  {new Date(f.runAt).toLocaleString('en-IN')}
                </div>
                {can(user, 'qc:override') && (
                  <AcceptFailureForm action={acceptFailure.bind(null, f.id)} />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        {can(user, 'qc:enter') && (
          <Card title="Record a QC run">
            <div className="p-4">
              {lots.length === 0 ? (
                <ErrorBanner message="No active QC lots. An administrator must configure a lot with target mean and SD first." />
              ) : (
                <QcEntryForm action={recordQc} lots={lots} devices={refData.devices ?? []} />
              )}
            </div>
          </Card>
        )}

        <Card className="lg:col-span-2" title="Recent runs">
          {results.length === 0 ? (
            <EmptyState
              title="No QC recorded yet"
              hint="Record a run to see the Levey-Jennings series build."
            />
          ) : (
            <>
              {/* Mobile: cards */}
              <ul className="divide-y divide-ink-100 md:hidden">
                {results.map((r) => (
                  <li key={r.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-ink-900">
                          {r.analyteCode}
                          <span className="ml-2 font-normal text-ink-500">
                            {r.material} L{r.level.replace('LEVEL_', '')}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs text-ink-500">
                          Lot {r.lot}
                          {r.device && ` · ${r.device}`} ·{' '}
                          {new Date(r.runAt).toLocaleString('en-IN', {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="numeric text-sm font-semibold text-ink-900">
                          {r.value} {r.unit}
                        </div>
                        <QcStatusBadge status={r.status} accepted={r.accepted} />
                      </div>
                    </div>
                    <ZBar z={r.zScore} />
                  </li>
                ))}
              </ul>

              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                    <tr>
                      <th className="px-4 py-2 font-medium">Analyte</th>
                      <th className="px-4 py-2 font-medium">Lot / level</th>
                      <th className="px-4 py-2 font-medium">Analyzer</th>
                      <th className="px-4 py-2 font-medium">Value</th>
                      <th className="px-4 py-2 font-medium">SD</th>
                      <th className="px-4 py-2 font-medium">Levey-Jennings</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Run at</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {results.map((r) => (
                      <tr
                        key={r.id}
                        className={r.status === 'REJECT' && !r.accepted ? 'bg-red-50/50' : ''}
                      >
                        <td className="px-4 py-2">
                          <div className="font-medium text-ink-900">{r.analyteCode}</div>
                          <div className="text-xs text-ink-400">{r.analyteName}</div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-600">
                          {r.lot} · L{r.level.replace('LEVEL_', '')}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-500">
                          {r.device ?? '—'}
                        </td>
                        <td className="numeric whitespace-nowrap px-4 py-2 font-medium text-ink-900">
                          {r.value} <span className="font-normal text-ink-500">{r.unit}</span>
                        </td>
                        <td className="numeric px-4 py-2 text-ink-700">
                          {r.zScore !== null ? `${r.zScore > 0 ? '+' : ''}${r.zScore.toFixed(2)}` : '—'}
                        </td>
                        <td className="px-4 py-2">
                          <ZBar z={r.zScore} />
                        </td>
                        <td className="px-4 py-2">
                          <QcStatusBadge status={r.status} accepted={r.accepted} />
                          {r.violatedRules.length > 0 && (
                            <div className="mt-0.5 text-[10px] text-ink-500">
                              {r.violatedRules.join(', ')}
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-500">
                          {new Date(r.runAt).toLocaleString('en-IN', {
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
          <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-400">
            Rules applied: 1-3s, 2-2s, R-4s, 4-1s, 10-x (rejection) and 1-2s (warning only).
            Evaluated per lot, analyte and analyzer — drift on one instrument is not drift on
            another.
          </p>
        </Card>
      </div>
    </div>
  );
}

function QcStatusBadge({ status, accepted }: { status: string; accepted: boolean }) {
  if (status === 'PASS') {
    return (
      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
        pass
      </span>
    );
  }
  if (status === 'WARNING') {
    return (
      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200">
        warning
      </span>
    );
  }
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-bold ring-1 ${
        accepted
          ? 'bg-ink-100 text-ink-600 ring-ink-200'
          : 'bg-[var(--color-critical-bg)] text-[var(--color-critical)] ring-red-300'
      }`}
    >
      {accepted ? 'reject · resolved' : 'reject'}
    </span>
  );
}

/**
 * Miniature Levey-Jennings position marker: where this point sits between
 * −3SD and +3SD. A sparkline conveys drift faster than a number, and the
 * technician is scanning a column, not reading one row.
 */
function ZBar({ z }: { z: number | null }) {
  if (z === null) return <span className="text-xs text-ink-400">—</span>;
  const clamped = Math.max(-3.5, Math.min(3.5, z));
  const pct = ((clamped + 3.5) / 7) * 100;
  const tone =
    Math.abs(z) > 3
      ? 'bg-[var(--color-critical)]'
      : Math.abs(z) > 2
        ? 'bg-[var(--color-high)]'
        : 'bg-emerald-500';

  return (
    <div className="relative h-4 w-28 rounded bg-ink-100" title={`${z.toFixed(2)} SD from target`}>
      {/* ±2SD guides */}
      <div className="absolute inset-y-0 left-[21.4%] w-px bg-ink-300" />
      <div className="absolute inset-y-0 left-[78.6%] w-px bg-ink-300" />
      {/* mean */}
      <div className="absolute inset-y-0 left-1/2 w-px bg-ink-400" />
      <div
        className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${tone}`}
        style={{ left: `${pct}%` }}
      />
    </div>
  );
}
