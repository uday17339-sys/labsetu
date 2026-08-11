import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Card, EmptyState, StatusPill } from '@/components/ui';
import { date } from '@/lib/format';
import { FilterSubmit } from '@/components/filter-submit';

export const dynamic = 'force-dynamic';

interface DeviationRow {
  id: string;
  deviationNumber: string;
  title: string;
  category: string;
  severity: string;
  status: string;
  productImpact: string;
  occurredAt: string;
  openDays: number;
  batch: { batchNumber: string; material: string } | null;
  capaCount: number;
  overdueCapas: number;
}

interface CapaRow {
  id: string;
  capaNumber: string;
  title: string;
  kind: string;
  status: string;
  owner: string;
  dueAt: string;
  isOverdue: boolean;
  daysToDue: number;
  awaitingEffectivenessCheck: boolean;
  effectivenessVerdict: string | null;
  source: { kind: string; ref: string | null };
}

interface ChangeRow {
  id: string;
  changeNumber: string;
  title: string;
  changeType: string;
  classification: string;
  status: string;
  requestedAt: string;
  openDays: number;
  awaitingReview: boolean;
}

/**
 * The quality system on one screen.
 *
 * Deviations, CAPA and change control are three registers a QA manager works
 * across in a single morning, and separating them into three destinations makes
 * the one question that matters — what is overdue — take three clicks. The
 * counters at the top are the answer to that question; the tabs below are where
 * you go once you know.
 */
export default async function QualityPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; status?: string }>;
}) {
  const sp = await searchParams;
  const tab = sp.tab ?? 'deviations';

  const [deviations, capas, changes] = await Promise.all([
    apiFetch<DeviationRow[]>('/quality/deviations').catch(() => [] as DeviationRow[]),
    apiFetch<CapaRow[]>('/quality/capa').catch(() => [] as CapaRow[]),
    apiFetch<ChangeRow[]>('/quality/changes').catch(() => [] as ChangeRow[]),
  ]);

  const openDeviations = deviations.filter((d) => d.status !== 'CLOSED' && d.status !== 'CANCELLED');
  const overdueCapas = capas.filter((c) => c.isOverdue);
  const awaitingCheck = capas.filter((c) => c.awaitingEffectivenessCheck);
  const awaitingReview = changes.filter((c) => c.awaitingReview);

  return (
    <div className="space-y-5">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-ink-900">Quality system</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          Deviations, corrective actions and change control. The thread an inspector follows:
          what went wrong, what was done, and who checked it worked.
        </p>
      </div>

      {/* What is outstanding, before what exists. */}
      <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">
        <Counter label="Open deviations" value={openDeviations.length} />
        <Counter label="Overdue actions" value={overdueCapas.length} tone={overdueCapas.length > 0 ? 'alert' : 'plain'} />
        <Counter
          label="Awaiting effectiveness"
          value={awaitingCheck.length}
          tone={awaitingCheck.length > 0 ? 'warn' : 'plain'}
        />
        <Counter
          label="Changes to review"
          value={awaitingReview.length}
          tone={awaitingReview.length > 0 ? 'warn' : 'plain'}
        />
      </div>

      <div className="flex flex-wrap gap-1">
        {[
          ['deviations', `Deviations (${deviations.length})`],
          ['capa', `CAPA (${capas.length})`],
          ['changes', `Change control (${changes.length})`],
        ].map(([value, label]) => (
          <Link
            key={value}
            href={`/quality?tab=${value}`}
            aria-current={tab === value ? 'page' : undefined}
            className={`inline-flex min-h-10 items-center rounded-md px-3 py-2 text-sm font-medium transition ${
              tab === value
                ? 'bg-ink-900 text-white'
                : 'border border-ink-300 text-ink-700 hover:bg-ink-100'
            }`}
          >
            {label}
          </Link>
        ))}
      </div>

      {tab === 'deviations' && <Deviations rows={deviations} />}
      {tab === 'capa' && <Capas rows={capas} />}
      {tab === 'changes' && <Changes rows={changes} />}
    </div>
  );
}

function Counter({
  label,
  value,
  tone = 'plain',
}: {
  label: string;
  value: number;
  tone?: 'plain' | 'warn' | 'alert';
}) {
  const tones = {
    plain: 'border-ink-200 bg-white text-ink-900',
    warn: 'border-amber-300 bg-amber-50 text-amber-900',
    alert: 'border-red-300 bg-red-50 text-red-900',
  } as const;

  return (
    <div className={`min-w-0 rounded-lg border px-4 py-3 ${tones[tone]}`}>
      <div className="truncate text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className="numeric mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function Deviations({ rows }: { rows: DeviationRow[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No deviations recorded"
          hint="Anyone on the floor can raise one — stores and QC both hold the permission."
        />
      </Card>
    );
  }

  return (
    <Card>
      <ul className="divide-y divide-ink-100 md:hidden">
        {rows.map((d) => (
          <li key={d.id}>
            <Link href={`/quality/deviations/${d.id}`} className="block px-4 py-3 active:bg-ink-50">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="numeric text-sm font-medium text-ink-900">{d.deviationNumber}</div>
                  <div className="mt-0.5 truncate text-xs text-ink-600">{d.title}</div>
                  <div className="mt-0.5 truncate text-xs text-ink-400">
                    {d.category.toLowerCase()} · open {d.openDays}d
                    {d.batch && ` · ${d.batch.batchNumber}`}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <StatusPill status={d.status} />
                  {d.overdueCapas > 0 && (
                    <div className="mt-1 text-xs font-medium text-red-700">
                      {d.overdueCapas} overdue
                    </div>
                  )}
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-2 font-medium">Deviation</th>
              <th className="px-4 py-2 font-medium">Title</th>
              <th className="px-4 py-2 font-medium">Category</th>
              <th className="px-4 py-2 font-medium">Severity</th>
              <th className="px-4 py-2 font-medium">Impact</th>
              <th className="px-4 py-2 text-right font-medium">Open</th>
              <th className="px-4 py-2 text-right font-medium">CAPA</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((d) => (
              <tr key={d.id}>
                <td className="px-4 py-2">
                  <Link
                    href={`/quality/deviations/${d.id}`}
                    className="numeric font-medium text-brand-600 hover:underline"
                  >
                    {d.deviationNumber}
                  </Link>
                </td>
                <td className="max-w-md px-4 py-2">
                  <div className="truncate text-ink-900">{d.title}</div>
                  {d.batch && (
                    <div className="numeric truncate text-xs text-ink-400">
                      {d.batch.material} · {d.batch.batchNumber}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-ink-600">{d.category.toLowerCase()}</td>
                <td className="px-4 py-2 text-xs text-ink-600">
                  {d.severity === 'UNCLASSIFIED' ? '—' : d.severity.toLowerCase()}
                </td>
                <td className="px-4 py-2 text-xs text-ink-600">
                  {d.productImpact === 'NOT_ASSESSED' ? '—' : d.productImpact.toLowerCase()}
                </td>
                <td className="numeric px-4 py-2 text-right text-ink-600">{d.openDays}d</td>
                <td className="numeric px-4 py-2 text-right">
                  {d.capaCount}
                  {d.overdueCapas > 0 && (
                    <span className="ml-1 font-medium text-red-700">({d.overdueCapas})</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <StatusPill status={d.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Capas({ rows }: { rows: CapaRow[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No corrective actions"
          hint="A CAPA is raised against a deviation, an OOS investigation or a change control."
        />
      </Card>
    );
  }

  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-2 font-medium">Action</th>
              <th className="px-4 py-2 font-medium">Title</th>
              <th className="px-4 py-2 font-medium">Owner</th>
              <th className="px-4 py-2 font-medium">Due</th>
              <th className="px-4 py-2 font-medium">Effectiveness</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((c) => (
              <tr key={c.id} className={c.isOverdue ? 'bg-red-50/50' : undefined}>
                <td className="numeric px-4 py-2 font-medium text-ink-900">{c.capaNumber}</td>
                <td className="max-w-md px-4 py-2">
                  <div className="truncate text-ink-900">{c.title}</div>
                  <div className="truncate text-xs text-ink-400">
                    {c.kind.toLowerCase()}
                    {c.source.ref && ` · from ${c.source.ref}`}
                  </div>
                </td>
                <td className="px-4 py-2 text-xs text-ink-600">{c.owner}</td>
                <td className="numeric whitespace-nowrap px-4 py-2 text-xs">
                  <span className={c.isOverdue ? 'font-medium text-red-700' : 'text-ink-600'}>
                    {date(c.dueAt)}
                  </span>
                  {c.isOverdue && <div className="text-[11px] text-red-700">overdue</div>}
                </td>
                <td className="px-4 py-2 text-xs">
                  {c.effectivenessVerdict ? (
                    <span
                      className={
                        c.effectivenessVerdict === 'EFFECTIVE'
                          ? 'text-emerald-700'
                          : 'font-medium text-red-700'
                      }
                    >
                      {c.effectivenessVerdict.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  ) : c.awaitingEffectivenessCheck ? (
                    /* The state that hides: done on every report, unproven. */
                    <span className="font-medium text-amber-800">check due</span>
                  ) : (
                    <span className="text-ink-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <StatusPill status={c.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Changes({ rows }: { rows: ChangeRow[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No change controls"
          hint="Any change to a specification, method, instrument or system is raised here."
        />
      </Card>
    );
  }

  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-4 py-2 font-medium">Change</th>
              <th className="px-4 py-2 font-medium">Title</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Class</th>
              <th className="px-4 py-2 text-right font-medium">Open</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((c) => (
              <tr key={c.id} className={c.awaitingReview ? 'bg-amber-50/50' : undefined}>
                <td className="numeric px-4 py-2 font-medium text-ink-900">{c.changeNumber}</td>
                <td className="max-w-md px-4 py-2">
                  <div className="truncate text-ink-900">{c.title}</div>
                  {c.awaitingReview && (
                    <div className="text-xs font-medium text-amber-800">
                      post-implementation review outstanding
                    </div>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-ink-600">{c.changeType.toLowerCase()}</td>
                <td className="px-4 py-2 text-xs text-ink-600">
                  {c.classification === 'UNCLASSIFIED' ? '—' : c.classification.toLowerCase()}
                </td>
                <td className="numeric px-4 py-2 text-right text-ink-600">{c.openDays}d</td>
                <td className="px-4 py-2">
                  <StatusPill status={c.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
