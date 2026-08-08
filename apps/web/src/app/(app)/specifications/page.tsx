import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, EmptyState, Stat, StatusPill } from '@/components/ui';
import { date } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface Spec {
  id: string;
  code: string;
  version: number;
  status: string;
  basis: string | null;
  material: { code: string; name: string; type: string };
  limitCount: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  approvedAt: string | null;
  inForce: boolean;
}

export default async function SpecificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const sp = await searchParams;
  const user = await getSessionUser();

  const qs = new URLSearchParams();
  if (sp.status) qs.set('status', sp.status);

  const specs = await apiFetch<Spec[]>(`/specifications?${qs.toString()}`).catch(() => [] as Spec[]);

  const drafts = specs.filter((s) => s.status === 'DRAFT');
  const inForce = specs.filter((s) => s.inForce);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-ink-900">Specifications</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            The acceptance criteria a batch is judged against. Authored as a draft, approved by QA,
            and never edited in place.
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
        <Stat label="In force" value={inForce.length} tone="good" />
        <Stat
          label="Awaiting approval"
          value={drafts.length}
          tone={drafts.length > 0 ? 'warn' : 'default'}
        />
        <Stat label="Superseded" value={specs.filter((s) => s.status === 'SUPERSEDED').length} />
        <Stat label="Total" value={specs.length} />
      </div>

      {drafts.length > 0 && can(user, 'spec:approve') && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-900">
            {drafts.length} draft{drafts.length > 1 ? 's' : ''} awaiting QA approval
          </p>
          <p className="mt-0.5 text-xs text-amber-800">
            A draft governs nothing. Material of a type with no approved specification cannot be
            sampled at all.
          </p>
        </div>
      )}

      <Card title={`Specifications (${specs.length})`}>
        <form className="flex flex-wrap items-end gap-2 border-b border-ink-100 px-4 py-3">
          <label>
            <span className="mb-1 block text-xs font-medium text-ink-600">Status</span>
            <select
              name="status"
              defaultValue={sp.status ?? ''}
              className="h-11 rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
            >
              <option value="">All</option>
              <option value="DRAFT">Draft</option>
              <option value="APPROVED">Approved</option>
              <option value="SUPERSEDED">Superseded</option>
              <option value="RETIRED">Retired</option>
            </select>
          </label>
          <button
            type="submit"
            className="min-h-11 rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
          >
            Apply
          </button>
        </form>

        {specs.length === 0 ? (
          <EmptyState
            title="No specifications"
            hint="Each material needs one before its batches can be sampled."
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {specs.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/specifications/${s.id}`}
                  className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-ink-50 active:bg-ink-50"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="numeric text-sm font-medium text-brand-600">
                        {s.code}
                      </span>
                      <span className="numeric rounded bg-ink-100 px-1.5 py-0.5 text-[10px] text-ink-500">
                        v{s.version}
                      </span>
                      <StatusPill status={s.status} />
                      {s.inForce && (
                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200">
                          in force
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-600">{s.material.name}</div>
                    <div className="numeric mt-0.5 text-xs text-ink-500">
                      {s.material.code} · {s.limitCount} criteri
                      {s.limitCount === 1 ? 'on' : 'a'}
                      {s.basis && ` · ${s.basis}`}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    {s.effectiveFrom ? (
                      <div className="numeric text-xs text-ink-500">
                        from {date(s.effectiveFrom)}
                      </div>
                    ) : (
                      <div className="text-xs text-ink-400">not yet effective</div>
                    )}
                    {s.effectiveTo && (
                      <div className="numeric text-[10px] text-ink-400">
                        to {date(s.effectiveTo)}
                      </div>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-400">
          A result is judged against the specification in force when it was produced, not the one
          in force today. Superseded versions are retained so old certificates stay explicable.
        </p>
      </Card>
    </div>
  );
}
