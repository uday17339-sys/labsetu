import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, Stat, StatusPill, EmptyState } from '@/components/ui';
import { money } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** UTC date the registration window is keyed on. */
const today = () => new Date().toISOString().slice(0, 10);

interface WorklistItem {
  id: string;
  status: string;
  priority: string;
  dueAt: string | null;
  isOverdue: boolean;
  testDefinition: { code: string; name: string; department: string };
  sample: {
    accessionNumber: string;
    patient: { patientCode: string; sex: string; ageYears: number | null } | null;
  };
}

interface CounterSummary {
  collected: { amount: number };
  outstanding: { amount: number; invoiceCount: number };
}

interface StoresAlerts {
  expired: { batchId: string; material: string; batchNumber: string }[];
  expiringSoon: { batchId: string }[];
  retestDue: { batchId: string }[];
  counts: { quarantined: number; underTest: number; approved: number; retestDue: number };
}

interface Indicators {
  sampleRejectionRate: { value: number; numerator: number; denominator: number };
  tatBreachRate: { value: number; numerator: number; denominator: number };
  amendedReportRate: { value: number; numerator: number };
}

export default async function DashboardPage() {
  const user = await getSessionUser();

  // A storekeeper does not have a clinical worklist, and showing them one that
  // reads "0 tests in progress" is worse than showing nothing — it tells them
  // the system is not about their job. Whether the clinical half loads at all
  // is decided by permission, not attempted and swallowed.
  const seesClinical = can(user, 'result:read');
  const seesStores = can(user, 'stores:read');
  // The front desk holds neither: their day is registrations and collections.
  const seesCounter = !seesClinical && !seesStores && can(user, 'invoice:read');

  const [worklist, indicators, exceptions, storesAlerts, samplingQueue, counter, registeredToday] =
    await Promise.all([
    seesClinical
      ? apiFetch<{ items: WorklistItem[] }>('/worklist?limit=100').catch(() => ({ items: [] }))
      : Promise.resolve({ items: [] as WorklistItem[] }),
    can(user, 'audit:read')
      ? apiFetch<Indicators>('/compliance/quality-indicators').catch(() => null)
      : Promise.resolve(null),
    can(user, 'ingest:resolve')
      ? apiFetch<unknown[]>('/ingest/exceptions?status=OPEN&limit=50').catch(() => [])
      : Promise.resolve([]),
    seesStores
      ? apiFetch<StoresAlerts>('/stores/alerts').catch(() => null)
      : Promise.resolve(null),
    seesStores
      ? apiFetch<{ id: string; requestNumber: string; waitingHours: number }[]>(
          '/stores/sampling-requests?status=PENDING',
        ).catch(() => [])
      : Promise.resolve([]),
    seesCounter
      ? apiFetch<CounterSummary>('/billing/summary').catch(() => null)
      : Promise.resolve(null),
    seesCounter
      ? apiFetch<{ id: string }[]>(
          `/patients?registeredFrom=${today()}T00:00:00.000Z&registeredTo=${today()}T23:59:59.999Z&limit=100`,
        ).catch(() => [])
      : Promise.resolve([]),
  ]);

  const items = worklist.items ?? [];
  const overdue = items.filter((i) => i.isOverdue);
  const awaitingVerify = items.filter((i) => i.status === 'RESULT_ENTERED');
  const awaitingAuth = items.filter((i) => i.status === 'TECH_VERIFIED');
  const stat = items.filter((i) => i.priority === 'STAT');

  // What this person's day is actually made of, in one line.
  const summary = seesClinical
    ? `${items.length} test${items.length === 1 ? '' : 's'} in progress across the lab`
    : storesAlerts
      ? `${storesAlerts.counts.quarantined} batch${storesAlerts.counts.quarantined === 1 ? '' : 'es'} in quarantine · ` +
        `${storesAlerts.counts.underTest} under test · ${storesAlerts.counts.approved} released`
      : counter
        ? `${registeredToday.length} patient${registeredToday.length === 1 ? '' : 's'} registered today · ` +
          `${money(counter.collected.amount)} collected`
        : 'Nothing assigned to you yet';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">
          Good {timeOfDay()}, {firstName(user?.fullName)}
        </h1>
        <p className="mt-0.5 text-sm text-ink-500">{summary}</p>
      </div>

      {/* The counter's own numbers, for a role with no worklist and no store. */}
      {counter && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Registered today" value={registeredToday.length} href="/patients" />
          <Stat
            label="Collected today"
            value={money(counter.collected.amount)}
            tone="good"
            href="/billing"
          />
          <Stat
            label="Unpaid invoices"
            value={counter.outstanding.invoiceCount}
            tone={counter.outstanding.invoiceCount ? 'warn' : 'good'}
            href="/billing?status=UNPAID"
          />
          <Stat
            label="Outstanding"
            value={money(counter.outstanding.amount)}
            tone={counter.outstanding.amount > 0 ? 'warn' : 'default'}
            href="/billing?status=UNPAID"
          />
        </div>
      )}

      {/* Manufacturing QC leads for the roles whose job it is. */}
      {storesAlerts && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="In quarantine"
            value={storesAlerts.counts.quarantined}
            tone={storesAlerts.counts.quarantined ? 'warn' : 'good'}
            href="/stores?status=QUARANTINE"
          />
          <Stat
            label="Under test"
            value={storesAlerts.counts.underTest}
            href="/stores?status=UNDER_TEST"
          />
          <Stat
            label="Released"
            value={storesAlerts.counts.approved}
            tone="good"
            href="/stores?status=APPROVED"
          />
          <Stat
            label="Retest due"
            value={storesAlerts.counts.retestDue}
            tone={storesAlerts.counts.retestDue ? 'critical' : 'default'}
            href="/stores"
          />
        </div>
      )}

      {storesAlerts && storesAlerts.expired.length > 0 && (
        <div className="rounded-lg border-2 border-[var(--color-critical)] bg-[var(--color-critical-bg)] px-4 py-3">
          <p className="text-sm font-bold text-[var(--color-critical)]">
            {storesAlerts.expired.length} expired batch
            {storesAlerts.expired.length > 1 ? 'es' : ''} still in the store
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-critical)] opacity-90">
            Approval does not survive expiry. These cannot be issued.
          </p>
          <Link
            href="/stores"
            className="mt-1.5 inline-flex min-h-11 items-center text-xs font-medium text-[var(--color-critical)] underline"
          >
            Open stores
          </Link>
        </div>
      )}

      {samplingQueue.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-900">
            {samplingQueue.length} batch{samplingQueue.length > 1 ? 'es' : ''} awaiting QC sampling
          </p>
          <p className="mt-0.5 text-xs text-amber-800">
            Quarantined material is capital standing still — the longest has been waiting{' '}
            {Math.max(...samplingQueue.map((r) => r.waitingHours))} hours.
          </p>
        </div>
      )}

      {/* The four numbers a lab manager actually opens the system to see. */}
      {seesClinical && (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Overdue" value={overdue.length} tone={overdue.length ? 'critical' : 'good'} href="/worklist?overdue=1" />
        <Stat label="STAT priority" value={stat.length} tone={stat.length ? 'warn' : 'default'} href="/worklist" />
        <Stat label="Awaiting verification" value={awaitingVerify.length} href="/worklist?status=RESULT_ENTERED" />
        <Stat label="Awaiting authorisation" value={awaitingAuth.length} href="/worklist?status=TECH_VERIFIED" />
      </div>
      )}

      {Array.isArray(exceptions) && exceptions.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-amber-900">
                {exceptions.length} analyzer result{exceptions.length === 1 ? '' : 's'} held for review
              </p>
              <p className="mt-0.5 text-xs text-amber-800">
                These could not be matched to an ordered test. They are held rather than
                guessed — a mis-matched result is a patient-safety event.
              </p>
            </div>
            <Link
              href="/worklist"
              className="inline-flex min-h-11 shrink-0 items-center rounded-md border border-amber-400 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-100"
            >
              Review
            </Link>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title="Needs attention"
          action={
            <Link
              href="/worklist"
              className="-mr-2 inline-flex min-h-11 items-center px-2 text-sm font-medium text-brand-600 hover:underline"
            >
              Full worklist →
            </Link>
          }
        >
          {items.length === 0 ? (
            <EmptyState
              title="Nothing in progress"
              hint="Registered samples appear here once they are received into the lab."
            />
          ) : (
            <>
            <ul className="divide-y divide-ink-100 md:hidden">
              {[...overdue, ...awaitingAuth, ...awaitingVerify, ...items]
                .filter((v, i, arr) => arr.findIndex((x) => x.id === v.id) === i)
                .slice(0, 8)
                .map((item) => (
                  <li key={item.id}>
                    <Link href={`/tests/${item.id}`} className="block px-4 py-3 active:bg-ink-100">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="numeric font-semibold text-brand-600">
                            {item.sample.accessionNumber}
                          </div>
                          <div className="mt-0.5 truncate text-sm text-ink-700">
                            {item.testDefinition.code} · {item.testDefinition.name}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <StatusPill status={item.status} />
                          <div className="mt-1 text-xs">
                            {item.isOverdue ? (
                              <span className="font-medium text-[var(--color-critical)]">Overdue</span>
                            ) : (
                              <span className="text-ink-500">{formatDue(item.dueAt)}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
            </ul>

            <div className="hidden md:block">
            <table className="w-full text-sm">
              <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Accession</th>
                  <th className="px-4 py-2 font-medium">Test</th>
                  <th className="px-4 py-2 font-medium">Patient</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {[...overdue, ...awaitingAuth, ...awaitingVerify, ...items]
                  .filter((v, i, arr) => arr.findIndex((x) => x.id === v.id) === i)
                  .slice(0, 12)
                  .map((item) => (
                    <tr key={item.id} className="hover:bg-ink-50">
                      <td className="px-4 py-2">
                        <Link
                          href={`/tests/${item.id}`}
                          className="numeric font-medium text-brand-600 hover:underline"
                        >
                          {item.sample.accessionNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-2">
                        <span className="font-medium text-ink-900">{item.testDefinition.code}</span>
                        <span className="ml-2 text-ink-500">{item.testDefinition.name}</span>
                      </td>
                      <td className="px-4 py-2 text-ink-600">
                        {item.sample.patient?.patientCode ?? '—'}
                      </td>
                      <td className="px-4 py-2">
                        <StatusPill status={item.status} />
                      </td>
                      <td className="px-4 py-2">
                        {item.isOverdue ? (
                          <span className="font-medium text-[var(--color-critical)]">Overdue</span>
                        ) : (
                          <span className="text-ink-500">{formatDue(item.dueAt)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            </div>
            </>
          )}
        </Card>

        <div className="space-y-6">
          {indicators && (
            <Card title="NABL quality indicators">
              <div className="divide-y divide-ink-100">
                <IndicatorRow
                  label="Sample rejection rate"
                  value={`${indicators.sampleRejectionRate.value}%`}
                  detail={`${indicators.sampleRejectionRate.numerator} of ${indicators.sampleRejectionRate.denominator} samples`}
                />
                <IndicatorRow
                  label="TAT breach rate"
                  value={`${indicators.tatBreachRate.value}%`}
                  detail={`${indicators.tatBreachRate.numerator} of ${indicators.tatBreachRate.denominator} tests`}
                />
                <IndicatorRow
                  label="Amended reports"
                  value={`${indicators.amendedReportRate.value}%`}
                  detail={`${indicators.amendedReportRate.numerator} amendments`}
                />
              </div>
              <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-400">
                Last 30 days. These are the indicators an assessor samples.
              </p>
            </Card>
          )}

          <Card title="Quick actions">
            <div className="divide-y divide-ink-100">
              {can(user, 'order:create') && (
                <QuickLink href="/register" label="Register a patient & order tests" />
              )}
              {can(user, 'sample:read') && (
                <QuickLink href="/samples" label="Find a sample by accession or barcode" />
              )}
              {can(user, 'audit:read') && (
                <QuickLink href="/audit" label="Search the audit trail" />
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function IndicatorRow({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="flex items-baseline justify-between px-4 py-2.5">
      <div>
        <div className="text-sm text-ink-700">{label}</div>
        <div className="text-xs text-ink-400">{detail}</div>
      </div>
      <div className="numeric text-lg font-semibold text-ink-900">{value}</div>
    </div>
  );
}

function QuickLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="block px-4 py-2.5 text-sm text-brand-600 hover:bg-ink-50">
      {label} →
    </Link>
  );
}

/**
 * First name, skipping honorifics.
 *
 * "Dr. Suresh Menon" must greet "Suresh", not "Dr." — clinicians' names carry
 * titles far more often than not in this domain.
 */
function firstName(fullName: string | undefined): string {
  if (!fullName) return 'there';
  const HONORIFICS = new Set(['dr', 'dr.', 'mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.', 'prof', 'prof.']);
  const parts = fullName.trim().split(/\s+/);
  const first = parts.find((p) => !HONORIFICS.has(p.toLowerCase()));
  return first ?? parts[0] ?? 'there';
}

function timeOfDay(): string {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

function formatDue(due: string | null): string {
  if (!due) return '—';
  const mins = Math.round((new Date(due).getTime() - Date.now()) / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}
