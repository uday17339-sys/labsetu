import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, EmptyState, Stat, StatusPill } from '@/components/ui';
import { date, dateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface Batch {
  id: string;
  batchNumber: string;
  material: { code: string; name: string; type: string };
  status: string;
  quantityAvailable: number;
  unit: string;
  expiryDate: string | null;
  openInvestigations: number;
  supplier: string | null;
}

interface Investigation {
  id: string;
  investigationNumber: string;
  analyteCode: string;
  observedValue: string;
  limitBreached: string;
  phase: string;
  status: string;
  conclusion: string | null;
  openedAt: string;
  openDays: number;
  batch: { id: string; batchNumber: string; status: string; material: { code: string; name: string } };
}

interface SamplingRequest {
  id: string;
  requestNumber: string;
  reason: string;
  status: string;
  waitingHours: number;
  batch: { id: string; batchNumber: string; material: { code: string; name: string } };
}

export default async function QaPage() {
  const user = await getSessionUser();

  const [underTest, investigations, pending] = await Promise.all([
    apiFetch<Batch[]>('/stores/batches?status=UNDER_TEST').catch(() => [] as Batch[]),
    apiFetch<Investigation[]>('/qa/investigations').catch(() => [] as Investigation[]),
    apiFetch<SamplingRequest[]>('/stores/sampling-requests?status=PENDING').catch(
      () => [] as SamplingRequest[],
    ),
  ]);

  const open = investigations.filter((i) => i.status !== 'CLOSED');
  const overdue = open.filter((i) => i.openDays > 30);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-ink-900">Quality assurance</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Release and rejection. QC produces the result; QA decides what it means for the batch.
          </p>
        </div>
        <Link
          href="/stores"
          className="min-h-11 rounded-md border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-100"
        >
          Stores
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Awaiting disposition" value={underTest.length} tone={underTest.length ? 'warn' : 'good'} />
        <Stat
          label="Open OOS"
          value={open.length}
          tone={open.length > 0 ? 'critical' : 'good'}
        />
        <Stat
          label="OOS over 30 days"
          value={overdue.length}
          tone={overdue.length > 0 ? 'critical' : 'default'}
        />
        <Stat label="Sampling requests pending" value={pending.length} />
      </div>

      {/* An OOS blocks release, so it leads. */}
      {open.length > 0 && (
        <Card title={`Out-of-specification investigations (${open.length})`}>
          <ul className="divide-y divide-ink-100">
            {open.map((i) => (
              <li
                key={i.id}
                className={`px-4 py-3 ${i.openDays > 30 ? 'bg-[var(--color-critical-bg)]' : ''}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="numeric text-sm font-medium text-ink-900">
                        {i.investigationNumber}
                      </span>
                      <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-600">
                        {i.phase.replace('_', ' ')}
                      </span>
                      <StatusPill status={i.status} />
                    </div>
                    <div className="mt-0.5 text-xs text-ink-600">
                      {i.batch.material.name} · batch {i.batch.batchNumber}
                    </div>
                    <div className="numeric mt-0.5 text-xs">
                      <span className="font-semibold text-[var(--color-critical)]">
                        {i.analyteCode} {i.observedValue}
                      </span>
                      <span className="text-ink-500"> against {i.limitBreached}</span>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div
                      className={`numeric text-sm font-semibold ${
                        i.openDays > 30 ? 'text-[var(--color-critical)]' : 'text-ink-600'
                      }`}
                    >
                      {i.openDays} day{i.openDays === 1 ? '' : 's'}
                    </div>
                    <div className="numeric text-[10px] text-ink-400">
                      opened {date(i.openedAt)}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-400">
            A batch cannot be released while an investigation on it is open. Phase I asks whether
            the laboratory erred; Phase II investigates manufacturing.
          </p>
        </Card>
      )}

      <Card title={`Batches awaiting disposition (${underTest.length})`}>
        {underTest.length === 0 ? (
          <EmptyState
            title="Nothing awaiting release"
            hint="Batches appear here once QC has sampled them."
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {underTest.map((b) => (
              <li key={b.id}>
                <Link
                  href={`/qa/${b.id}`}
                  className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-ink-50 active:bg-ink-50"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink-900">{b.material.name}</div>
                    <div className="numeric mt-0.5 text-xs text-ink-500">
                      {b.material.code} · batch {b.batchNumber}
                      {b.supplier && ` · ${b.supplier}`}
                    </div>
                    {b.openInvestigations > 0 && (
                      <div className="mt-0.5 text-xs font-medium text-[var(--color-critical)]">
                        blocked — {b.openInvestigations} open investigation
                        {b.openInvestigations > 1 ? 's' : ''}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="numeric text-sm text-ink-700">
                      {b.quantityAvailable} {b.unit}
                    </div>
                    {b.expiryDate && (
                      <div className="numeric text-[10px] text-ink-400">
                        exp {date(b.expiryDate)}
                      </div>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {pending.length > 0 && (
        <Card title={`Sampling requests awaiting QC (${pending.length})`}>
          <ul className="divide-y divide-ink-100">
            {pending.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <span className="numeric text-sm text-ink-900">{r.requestNumber}</span>
                  <div className="text-xs text-ink-500">
                    {r.batch.material.name} · batch {r.batch.batchNumber} ·{' '}
                    {r.reason.replace(/_/g, ' ').toLowerCase()}
                  </div>
                </div>
                <span
                  className={`numeric shrink-0 text-xs ${
                    r.waitingHours > 48 ? 'font-medium text-[var(--color-high)]' : 'text-ink-400'
                  }`}
                >
                  waiting {r.waitingHours}h
                </span>
              </li>
            ))}
          </ul>
          <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-400">
            Quarantined material is capital standing still. QC draws these from the sampling queue.
          </p>
        </Card>
      )}

      {!can(user, 'batch:disposition') && (
        <p className="text-xs text-ink-400">
          You can see this queue but not release against it — disposition is held by QA alone.
        </p>
      )}
    </div>
  );
}
