import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, EmptyState, Stat, FlagBadge } from '@/components/ui';
import { dateTime, duration } from '@/lib/format';
import { CallbackForm } from './forms';

export const dynamic = 'force-dynamic';

interface CriticalRow {
  resultId: string;
  sampleTestId: string;
  accessionNumber: string;
  orderNumber: string | null;
  patientCode: string | null;
  patientName: string | null;
  sex: string | null;
  ageYears: number | null;
  test: string;
  testName: string;
  analyte: string;
  analyteName: string;
  value: string | null;
  unit: string | null;
  flag: string;
  refLow: number | null;
  refHigh: number | null;
  enteredAt: string;
  waitingMinutes: number;
  referringDoctor: string | null;
  referringDoctorPhone: string | null;
  notifiedAt: string | null;
  notifiedTo: string | null;
}

interface Performance {
  criticalResults: number;
  notified: number;
  outstanding: number;
  notificationRatePct: number;
  medianMinutesToCall: number | null;
  within60MinutesPct: number | null;
}

export default async function CriticalValuesPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const sp = await searchParams;
  const showAll = sp.all === 'true';
  const user = await getSessionUser();

  const [list, perf] = await Promise.all([
    apiFetch<{ items: CriticalRow[]; count: number }>(
      `/critical-values?includeNotified=${showAll}`,
    ).catch(() => ({ items: [], count: 0 })),
    apiFetch<Performance>('/critical-values/performance').catch(() => null),
  ]);

  async function recordCallback(resultId: string, formData: FormData): Promise<void> {
    'use server';
    await apiFetch(`/results/${resultId}/callback`, {
      method: 'POST',
      body: {
        notifiedTo: String(formData.get('notifiedTo') ?? '').trim(),
        method: String(formData.get('method') ?? 'PHONE'),
        readBack: String(formData.get('readBack') ?? '').trim(),
        note: String(formData.get('note') ?? '').trim() || undefined,
      },
    });
    revalidatePath('/critical');
    revalidatePath('/');
  }

  const canCall = can(user, 'result:callback');
  const outstanding = list.items.filter((r) => !r.notifiedAt);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-ink-900">Critical values</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Results that require the clinician to be told immediately, and the record that they
            were.
          </p>
        </div>
        <Link
          href={showAll ? '/critical' : '/critical?all=true'}
          className="min-h-11 rounded-md border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-100"
        >
          {showAll ? 'Show outstanding only' : 'Include completed calls'}
        </Link>
      </div>

      {perf && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Outstanding now"
            value={outstanding.length}
            tone={outstanding.length > 0 ? 'critical' : 'good'}
          />
          <Stat label="Critical results this month" value={perf.criticalResults} />
          <Stat
            label="Notification rate"
            value={`${perf.notificationRatePct}%`}
            tone={perf.notificationRatePct >= 100 ? 'good' : 'warn'}
          />
          <Stat
            label="Median time to call"
            value={perf.medianMinutesToCall != null ? duration(Math.round(perf.medianMinutesToCall)) : '—'}
            tone={
              perf.medianMinutesToCall != null && perf.medianMinutesToCall > 60 ? 'warn' : 'default'
            }
          />
        </div>
      )}

      {outstanding.length === 0 && !showAll ? (
        <Card>
          <EmptyState
            title="No outstanding critical values"
            hint="Every flagged result has been called through to the requesting clinician."
          />
        </Card>
      ) : (
        <ul className="space-y-3">
          {list.items.map((r) => {
            const done = !!r.notifiedAt;
            const overdue = !done && r.waitingMinutes > 60;

            return (
              <li
                key={r.resultId}
                className={`rounded-lg border-2 px-4 py-3 ${
                  done
                    ? 'border-ink-200 bg-white'
                    : overdue
                      ? 'border-[var(--color-critical)] bg-[var(--color-critical-bg)]'
                      : 'border-amber-300 bg-amber-50'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-base font-semibold text-ink-900">
                        {r.patientName ?? r.patientCode ?? 'Unknown patient'}
                      </span>
                      <span className="numeric text-xs text-ink-500">
                        {r.patientCode}
                        {r.sex && r.ageYears != null && ` · ${r.sex[0]}/${r.ageYears}`}
                      </span>
                    </div>
                    <div className="numeric mt-0.5 text-xs text-ink-500">
                      {r.accessionNumber}
                      {r.orderNumber && ` · ${r.orderNumber}`} · {r.testName}
                    </div>
                  </div>

                  <div className="shrink-0 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <span className="numeric text-xl font-bold text-[var(--color-critical)]">
                        {r.value}
                        {r.unit && (
                          <span className="ml-1 text-sm font-normal text-ink-500">{r.unit}</span>
                        )}
                      </span>
                      <FlagBadge flag={r.flag} />
                    </div>
                    <div className="numeric mt-0.5 text-xs text-ink-500">
                      {r.analyteName}
                      {r.refLow != null && r.refHigh != null && (
                        <> · ref {r.refLow}–{r.refHigh}</>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-black/5 pt-2">
                  <div className="text-xs text-ink-600">
                    {done ? (
                      <>
                        <span className="font-medium text-[var(--color-normal)]">
                          Called through
                        </span>{' '}
                        to {r.notifiedTo} · {dateTime(r.notifiedAt)}
                      </>
                    ) : (
                      <>
                        <span
                          className={
                            overdue
                              ? 'font-bold text-[var(--color-critical)]'
                              : 'font-medium text-amber-800'
                          }
                        >
                          Waiting {duration(r.waitingMinutes)}
                        </span>
                        {overdue && ' — past the 60-minute policy'}
                        {r.referringDoctor && (
                          <>
                            {' · '}
                            {r.referringDoctor}
                            {r.referringDoctorPhone && (
                              <>
                                {' '}
                                <a
                                  href={`tel:${r.referringDoctorPhone}`}
                                  className="numeric font-medium text-brand-600 underline"
                                >
                                  {r.referringDoctorPhone}
                                </a>
                              </>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </div>
                  <Link
                    href={`/tests/${r.sampleTestId}`}
                    className="-mr-2 inline-flex min-h-11 items-center px-2 text-xs font-medium text-brand-600 hover:underline"
                  >
                    Open result
                  </Link>
                </div>

                {!done && canCall && (
                  <CallbackForm
                    action={recordCallback.bind(null, r.resultId)}
                    defaultRecipient={r.referringDoctor}
                    suggestion={`${r.analyteName} ${r.value}${r.unit ? ` ${r.unit}` : ''} for ${
                      r.patientName ?? r.patientCode
                    } (${r.accessionNumber}) repeated back correctly`}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-ink-400">
        NABL 112 and ISO 15189 §7.4.1 require evidence that the requesting clinician was
        notified — who was told, when, and what they read back. Every entry here is written to the
        audit trail as a CRITICAL_VALUE_NOTIFIED event.
      </p>
    </div>
  );
}
