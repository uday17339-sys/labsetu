import { apiFetch } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, EmptyState } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface AuditEntry {
  id: string;
  seq: string;
  occurredAt: string;
  actor: string | null;
  actorRole: string | null;
  actorIp: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  reason: string | null;
  changedFields: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  hash: string;
  prevHash: string;
}

interface ChainStatus {
  status: string;
  entriesChecked: number;
  headSeq: string;
  headHash: string | null;
  verifiedAt: string;
  detail?: string;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ entityType?: string; entityId?: string; action?: string }>;
}) {
  const params = await searchParams;
  const user = await getSessionUser();

  // The API refuses the data to anyone without audit:read, but the page used to
  // swallow that 403 and render a complete, EMPTY audit trail. To a stores
  // clerk that reads as "the lab has no history" rather than "you may not see
  // it" — and it hides a genuine API failure behind the same empty state.
  if (!can(user, 'audit:read')) {
    return (
      <div className="space-y-5">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-ink-900">Audit trail</h1>
        </div>
        <Card>
          <EmptyState
            title="You do not have access to the audit trail"
            hint="Reading the audit trail requires the audit:read permission, held by the Quality Assurance and Auditor roles. Ask your administrator if you need it."
          />
        </Card>
      </div>
    );
  }

  const query = new URLSearchParams({ limit: '100' });
  if (params.entityType) query.set('entityType', params.entityType);
  if (params.entityId) query.set('entityId', params.entityId);
  if (params.action) query.set('action', params.action);

  const [audit, chain] = await Promise.all([
    apiFetch<{ items: AuditEntry[] }>(`/compliance/audit?${query}`).catch(() => ({
      items: [] as AuditEntry[],
    })),
    apiFetch<ChainStatus>('/compliance/audit-chain/verify').catch(() => null),
  ]);

  const scoped = Boolean(params.entityType && params.entityId);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Audit trail</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            {scoped
              ? `Everything that has happened to this ${params.entityType}.`
              : 'Every action, in order, permanently.'}
          </p>
        </div>
        {can(user, 'compliance:export') && (
          <a
            href={`/api/v1/export/audit.csv${params.action ? `?action=${params.action}` : ''}`}
            className="min-h-11 rounded-md border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-100"
          >
            Export CSV
          </a>
        )}
      </div>

      {/*
        Chain verification recomputes every hash, so it sits behind the separate
        audit:verify permission (the AUDITOR role). Saying so beats rendering
        nothing — a missing integrity banner would otherwise read as a failure.
      */}
      {!chain && (
        <div className="rounded-lg border border-ink-200 bg-white px-4 py-3">
          <p className="text-sm font-medium text-ink-700">
            Chain verification not run
          </p>
          <p className="mt-0.5 text-xs text-ink-500">
            Recomputing the hash chain requires the{' '}
            <code className="rounded bg-ink-100 px-1">audit:verify</code> permission, held by
            the Auditor role. The entries below are still the complete, immutable record.
          </p>
        </div>
      )}

      {/* The chain status is the evidence a lab shows an assessor. */}
      {chain && (
        <div
          className={`rounded-lg border px-4 py-3 ${
            chain.status === 'PASSED'
              ? 'border-emerald-300 bg-emerald-50'
              : 'border-red-300 bg-red-50'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p
                className={`text-sm font-semibold ${
                  chain.status === 'PASSED' ? 'text-emerald-900' : 'text-red-900'
                }`}
              >
                {chain.status === 'PASSED'
                  ? 'Integrity verified — the chain is unbroken'
                  : 'INTEGRITY FAILURE — the chain is broken'}
              </p>
              <p
                className={`mt-0.5 text-xs ${
                  chain.status === 'PASSED' ? 'text-emerald-800' : 'text-red-800'
                }`}
              >
                {chain.entriesChecked.toLocaleString('en-IN')} entries recomputed and matched ·
                head sequence {chain.headSeq}
                {chain.detail && ` · ${chain.detail}`}
              </p>
            </div>
            <code className="numeric hidden max-w-[18rem] truncate rounded bg-white/70 px-2 py-1 text-[10px] text-ink-600 lg:block">
              {chain.headHash}
            </code>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-1">
        {[
          ['', 'All'],
          ['AUTHORIZE', 'Authorisations'],
          ['RELEASE', 'Releases'],
          ['AMEND', 'Amendments'],
          ['RERUN', 'Re-runs'],
          ['LOGIN_FAILURE', 'Failed sign-ins'],
          ['READ_SENSITIVE', 'PHI access'],
          ['ERASURE_EXECUTED', 'Erasures'],
        ].map(([value, label]) => {
          const active = (params.action ?? '') === value;
          const href = value ? `/audit?action=${value}` : '/audit';
          return (
            <a
              key={value || 'all'}
              href={href}
              className={`inline-flex min-h-10 items-center rounded-md px-3 py-2 text-sm font-medium transition ${
                active ? 'bg-ink-900 text-white' : 'border border-ink-300 text-ink-700 hover:bg-ink-100'
              }`}
            >
              {label}
            </a>
          );
        })}
      </div>

      <Card>
        {audit.items.length === 0 ? (
          <EmptyState title="No entries match" />
        ) : (
          <>
            <ul className="divide-y divide-ink-100 md:hidden">
              {audit.items.map((e) => (
                <li key={e.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${actionStyle(e.action)}`}>
                        {e.action.replace(/_/g, ' ').toLowerCase()}
                      </span>
                      <div className="mt-1 text-sm text-ink-900">{e.actor ?? 'System'}</div>
                      <div className="text-xs text-ink-400">
                        {e.entityType}
                        {e.actorRole && ` · ${e.actorRole.replace(/_/g, ' ').toLowerCase()}`}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-xs text-ink-500">
                      <div className="numeric">#{e.seq}</div>
                      <div>
                        {new Date(e.occurredAt).toLocaleString('en-IN', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                    </div>
                  </div>
                  {e.reason && (
                    <div className="mt-1.5 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">
                      <span className="font-medium">Reason: </span>
                      {e.reason}
                    </div>
                  )}
                  <Summary after={e.after} />
                </li>
              ))}
            </ul>

            <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Seq</th>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Who</th>
                  <th className="px-4 py-2 font-medium">Action</th>
                  <th className="px-4 py-2 font-medium">Entity</th>
                  <th className="px-4 py-2 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {audit.items.map((e) => (
                  <tr key={e.id} className="align-top hover:bg-ink-50">
                    <td className="numeric px-4 py-2 text-xs text-ink-400">{e.seq}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-600">
                      {new Date(e.occurredAt).toLocaleString('en-IN', {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <div className="text-ink-900">{e.actor ?? 'System'}</div>
                      <div className="text-xs text-ink-400">
                        {e.actorRole?.replace(/_/g, ' ').toLowerCase() ?? ''}
                        {e.actorIp && ` · ${e.actorIp}`}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs font-medium ${actionStyle(e.action)}`}
                      >
                        {e.action.replace(/_/g, ' ').toLowerCase()}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-600">
                      {e.entityType}
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-600">
                      {e.reason && (
                        <div className="mb-1 rounded bg-amber-50 px-2 py-1 text-amber-900">
                          <span className="font-medium">Reason: </span>
                          {e.reason}
                        </div>
                      )}
                      {e.changedFields.length > 0 && (
                        <div className="text-ink-500">
                          Changed: {e.changedFields.join(', ')}
                        </div>
                      )}
                      <Summary after={e.after} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </>
        )}
        <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-400">
          Entries cannot be edited or deleted — the application role holds INSERT and SELECT
          only. Timestamps are assigned by the database, not the client.
        </p>
      </Card>
    </div>
  );
}

/** Renders a compact, PII-free summary of the recorded payload. */
function Summary({ after }: { after: Record<string, unknown> | null }) {
  if (!after) return null;
  const interesting = ['accessionNumber', 'test', 'status', 'reportNumber', 'patientCode', 'orderNumber', 'messageId', 'code'];
  const parts = interesting
    .filter((k) => after[k] !== undefined && after[k] !== null)
    .map((k) => `${k}=${String(after[k])}`);
  if (parts.length === 0) return null;
  return <div className="numeric mt-0.5 text-[11px] text-ink-500">{parts.join(' · ')}</div>;
}

function actionStyle(action: string): string {
  if (action.startsWith('LOGIN_FAILURE') || action.includes('DENIED') || action.includes('REUSE')) {
    return 'bg-red-50 text-red-700 ring-1 ring-red-200';
  }
  if (['AUTHORIZE', 'RELEASE', 'SIGN', 'VERIFY'].includes(action)) {
    return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200';
  }
  if (['AMEND', 'RERUN', 'REJECT', 'ERASURE_EXECUTED'].includes(action)) {
    return 'bg-amber-50 text-amber-800 ring-1 ring-amber-200';
  }
  return 'bg-ink-100 text-ink-600';
}
