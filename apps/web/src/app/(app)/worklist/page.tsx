import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, StatusPill, EmptyState } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface WorklistItem {
  id: string;
  status: string;
  priority: string;
  dueAt: string | null;
  isOverdue: boolean;
  rerunCount: number;
  testDefinition: { code: string; name: string; department: string; tatMinutes: number | null };
  device: { code: string; name: string } | null;
  sample: {
    id: string;
    accessionNumber: string;
    receivedAt: string | null;
    patient: { patientCode: string; sex: string; ageYears: number | null } | null;
  };
  _count: { results: number };
}

const STATUS_FILTERS = [
  { value: '', label: 'Active' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'RESULT_ENTERED', label: 'Awaiting verification' },
  { value: 'TECH_VERIFIED', label: 'Awaiting authorisation' },
  { value: 'AUTHORIZED', label: 'Authorised' },
];

export default async function WorklistPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; overdue?: string; department?: string }>;
}) {
  const params = await searchParams;
  const user = await getSessionUser();

  const query = new URLSearchParams({ limit: '200' });
  if (params.status) query.set('status', params.status);
  if (params.overdue === '1') query.set('overdueOnly', 'true');
  if (params.department) query.set('department', params.department);

  const { items } = await apiFetch<{ items: WorklistItem[] }>(`/worklist?${query}`).catch(() => ({
    items: [] as WorklistItem[],
  }));

  // STAT first, then oldest deadline — the order a bench actually works in.
  const sorted = [...items].sort((a, b) => {
    if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
    if ((a.priority === 'STAT') !== (b.priority === 'STAT')) return a.priority === 'STAT' ? -1 : 1;
    return (a.dueAt ?? '').localeCompare(b.dueAt ?? '');
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Worklist</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            {sorted.length} test{sorted.length === 1 ? '' : 's'}
            {params.overdue === '1' && ' · overdue only'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {can(user, 'compliance:export') && (
            <a
              href={`/api/v1/export/worklist.csv${params.status ? `?status=${params.status}` : ''}`}
              className="mr-2 min-h-11 rounded-md border border-ink-300 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-100"
            >
              Export CSV
            </a>
          )}
          {STATUS_FILTERS.map((f) => {
            const active = (params.status ?? '') === f.value && params.overdue !== '1';
            return (
              <Link
                key={f.value || 'all'}
                href={f.value ? `/worklist?status=${f.value}` : '/worklist'}
                className={`inline-flex min-h-10 items-center rounded-md px-3 py-2 text-sm font-medium transition ${
                  active
                    ? 'bg-ink-900 text-white'
                    : 'border border-ink-300 text-ink-700 hover:bg-ink-100'
                }`}
              >
                {f.label}
              </Link>
            );
          })}
          <Link
            href="/worklist?overdue=1"
            className={`inline-flex min-h-10 items-center rounded-md px-3 py-2 text-sm font-medium transition ${
              params.overdue === '1'
                ? 'bg-[var(--color-critical)] text-white'
                : 'border border-ink-300 text-ink-700 hover:bg-ink-100'
            }`}
          >
            Overdue
          </Link>
        </div>
      </div>

      <Card>
        {sorted.length === 0 ? (
          <EmptyState
            title="Nothing here"
            hint="Tests appear once their sample has been received into the lab."
          />
        ) : (
          <>
            {/* Mobile: cards. A horizontally-scrolling table is unusable on a
                phone, and this screen is used standing at a bench. */}
            <ul className="divide-y divide-ink-100 md:hidden">
              {sorted.map((item) => (
                <li key={item.id}>
                  <Link
                    href={`/tests/${item.id}`}
                    className={`block px-4 py-3 active:bg-ink-100 ${
                      item.isOverdue ? 'bg-red-50/50' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="numeric font-semibold text-brand-600">
                            {item.sample.accessionNumber}
                          </span>
                          {item.priority === 'STAT' && (
                            <span className="rounded bg-[var(--color-critical)] px-1.5 py-0.5 text-[10px] font-bold text-white">
                              STAT
                            </span>
                          )}
                          {item.rerunCount > 0 && (
                            <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-800">
                              R{item.rerunCount}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-sm text-ink-900">
                          <span className="font-medium">{item.testDefinition.code}</span>
                          <span className="text-ink-500"> · {item.testDefinition.name}</span>
                        </div>
                        <div className="mt-0.5 text-xs text-ink-500">
                          {item.sample.patient
                            ? `${item.sample.patient.patientCode} · ${item.sample.patient.sex[0]}/${
                                item.sample.patient.ageYears ?? '?'
                              }`
                            : '—'}
                          {item.device && ` · ${item.device.code}`}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <StatusPill status={item.status} />
                        <div className="mt-1 text-xs">
                          {item.isOverdue ? (
                            <span className="font-medium text-[var(--color-critical)]">
                              Overdue
                            </span>
                          ) : (
                            <span className="text-ink-500">{formatDue(item.dueAt)}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 text-xs font-medium text-brand-600">
                      {nextAction(item.status)} →
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
                  <th className="px-4 py-2 font-medium">Test</th>
                  <th className="px-4 py-2 font-medium">Dept</th>
                  <th className="px-4 py-2 font-medium">Patient</th>
                  <th className="px-4 py-2 font-medium">Analyzer</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Due</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {sorted.map((item) => (
                  <tr
                    key={item.id}
                    className={`hover:bg-ink-50 ${item.isOverdue ? 'bg-red-50/40' : ''}`}
                  >
                    <td className="whitespace-nowrap px-4 py-2">
                      <Link
                        href={`/tests/${item.id}`}
                        className="numeric font-medium text-brand-600 hover:underline"
                      >
                        {item.sample.accessionNumber}
                      </Link>
                      {item.priority === 'STAT' && (
                        <span className="ml-2 rounded bg-[var(--color-critical)] px-1.5 py-0.5 text-[10px] font-bold text-white">
                          STAT
                        </span>
                      )}
                      {item.rerunCount > 0 && (
                        <span
                          title={`Re-run ${item.rerunCount}`}
                          className="ml-2 rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-800"
                        >
                          R{item.rerunCount}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <span className="font-medium text-ink-900">{item.testDefinition.code}</span>
                      <span className="ml-2 text-ink-500">{item.testDefinition.name}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-500">
                      {item.testDefinition.department.replace(/_/g, ' ').toLowerCase()}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-ink-600">
                      {item.sample.patient
                        ? `${item.sample.patient.patientCode} · ${item.sample.patient.sex[0]}/${
                            item.sample.patient.ageYears ?? '?'
                          }`
                        : '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-500">
                      {item.device?.code ?? '—'}
                    </td>
                    <td className="px-4 py-2">
                      <StatusPill status={item.status} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      {item.isOverdue ? (
                        <span className="font-medium text-[var(--color-critical)]">Overdue</span>
                      ) : (
                        <span className="text-ink-500">{formatDue(item.dueAt)}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right">
                      <Link
                        href={`/tests/${item.id}`}
                        className="rounded-md border border-ink-300 px-2.5 py-1 text-xs font-medium text-ink-700 hover:bg-ink-100"
                      >
                        {nextAction(item.status)}
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
    </div>
  );
}

/** The label tells the user what this row wants from them next. */
function nextAction(status: string): string {
  switch (status) {
    case 'IN_PROGRESS':
      return 'Enter results';
    case 'RESULT_ENTERED':
      return 'Verify';
    case 'TECH_VERIFIED':
      return 'Authorise';
    default:
      return 'Open';
  }
}

function formatDue(due: string | null): string {
  if (!due) return '—';
  const mins = Math.round((new Date(due).getTime() - Date.now()) / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}
