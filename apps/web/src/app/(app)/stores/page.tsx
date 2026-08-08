import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, EmptyState, Stat, StatusPill } from '@/components/ui';
import { date } from '@/lib/format';
import { ReceiveGoodsForm, RequestSamplingForm } from './forms';

export const dynamic = 'force-dynamic';

interface Material {
  id: string;
  code: string;
  name: string;
  type: string;
  unit: string;
  manufacturer: string | null;
  pharmacopoeia: string | null;
  storageCondition: string | null;
  batchCount: number;
  specificationCount: number;
  approvedQuantity: number;
  quarantinedQuantity: number;
}

interface Batch {
  id: string;
  batchNumber: string;
  manufacturerLot: string | null;
  material: { code: string; name: string; type: string; pharmacopoeia: string | null };
  grnNumber: string | null;
  supplier: string | null;
  quantityReceived: number;
  quantityAvailable: number;
  unit: string;
  containerCount: number | null;
  status: string;
  location: string | null;
  expiryDate: string | null;
  retestDate: string | null;
  isExpired: boolean;
  isRetestDue: boolean;
  openInvestigations: number;
  isIssuable: boolean;
}

interface Alerts {
  expired: { batchId: string; material: string; batchNumber: string; expiryDate: string | null }[];
  expiringSoon: { batchId: string; material: string; batchNumber: string; expiryDate: string | null }[];
  retestDue: { batchId: string; material: string; batchNumber: string; retestDate: string | null }[];
  awaitingSampling: {
    batchId: string;
    material: string;
    batchNumber: string;
    quantity: number;
    unit: string;
  }[];
  counts: { quarantined: number; underTest: number; approved: number; retestDue: number };
}

export default async function StoresPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; type?: string; search?: string }>;
}) {
  const sp = await searchParams;
  const user = await getSessionUser();

  const qs = new URLSearchParams();
  if (sp.status) qs.set('status', sp.status);
  if (sp.type) qs.set('type', sp.type);
  if (sp.search) qs.set('search', sp.search);

  const [materials, batches, alerts, refData] = await Promise.all([
    apiFetch<Material[]>('/stores/materials').catch(() => [] as Material[]),
    apiFetch<Batch[]>(`/stores/batches?${qs.toString()}`).catch(() => [] as Batch[]),
    apiFetch<Alerts>('/stores/alerts').catch(() => null),
    apiFetch<{ labs: { id: string; code: string; name: string }[] }>(
      '/catalog/reference-data',
    ).catch(() => ({ labs: [] })),
  ]);

  async function receiveGoods(formData: FormData): Promise<void> {
    'use server';
    await apiFetch('/stores/receive', {
      method: 'POST',
      body: {
        labId: String(formData.get('labId') ?? ''),
        supplierName: String(formData.get('supplierName') ?? '').trim(),
        invoiceRef: String(formData.get('invoiceRef') ?? '').trim() || undefined,
        poReference: String(formData.get('poReference') ?? '').trim() || undefined,
        receiptCheckNote: String(formData.get('receiptCheckNote') ?? '').trim() || undefined,
        batches: [
          {
            materialId: String(formData.get('materialId') ?? ''),
            batchNumber: String(formData.get('batchNumber') ?? '').trim(),
            manufacturerLot: String(formData.get('manufacturerLot') ?? '').trim() || undefined,
            quantity: String(formData.get('quantity') ?? ''),
            containerCount: String(formData.get('containerCount') ?? '').trim() || undefined,
            manufacturedAt: String(formData.get('manufacturedAt') ?? '').trim() || undefined,
            expiryDate: String(formData.get('expiryDate') ?? '').trim() || undefined,
          },
        ],
      },
    });
    revalidatePath('/stores');
  }

  async function requestSampling(batchId: string, formData: FormData): Promise<void> {
    'use server';
    await apiFetch('/stores/sampling-requests', {
      method: 'POST',
      body: {
        batchId,
        reason: String(formData.get('reason') ?? 'RELEASE_TESTING'),
        note: String(formData.get('note') ?? '').trim() || undefined,
      },
    });
    revalidatePath('/stores');
  }

  const canReceive = can(user, 'stores:manage');
  const canRequest = can(user, 'sampling:request');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-ink-900">Stores</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Raw materials in, finished product out. Everything received is quarantined until QA
            releases it.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can(user, 'spec:read') && (
            <Link
              href="/specifications"
              className="min-h-11 rounded-md border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-100"
            >
              Specifications
            </Link>
          )}
          {can(user, 'batch:disposition') && (
            <Link
              href="/qa"
              className="min-h-11 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              QA release queue
            </Link>
          )}
        </div>
      </div>

      {alerts && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Quarantined"
            value={alerts.counts.quarantined}
            tone={alerts.counts.quarantined > 0 ? 'warn' : 'default'}
            href="/stores?status=QUARANTINE"
          />
          <Stat label="Under test" value={alerts.counts.underTest} href="/stores?status=UNDER_TEST" />
          <Stat
            label="Approved"
            value={alerts.counts.approved}
            tone="good"
            href="/stores?status=APPROVED"
          />
          <Stat
            label="Retest due"
            value={alerts.counts.retestDue}
            tone={alerts.counts.retestDue > 0 ? 'critical' : 'default'}
          />
        </div>
      )}

      {alerts && alerts.expired.length > 0 && (
        <div className="rounded-lg border-2 border-[var(--color-critical)] bg-[var(--color-critical-bg)] px-4 py-3">
          <p className="text-sm font-bold text-[var(--color-critical)]">
            {alerts.expired.length} expired batch{alerts.expired.length > 1 ? 'es' : ''} in stock
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-critical)] opacity-90">
            Approval does not survive expiry. These cannot be issued.
          </p>
          <ul className="mt-1.5 space-y-0.5 text-xs text-[var(--color-critical)]">
            {alerts.expired.slice(0, 6).map((e) => (
              <li key={e.batchId}>
                {e.material} · batch {e.batchNumber} — expired {date(e.expiryDate)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {alerts && alerts.retestDue.length > 0 && (
          <div className="rounded-lg border border-orange-300 bg-orange-50 px-4 py-3">
            <p className="text-sm font-medium text-orange-900">
              {alerts.retestDue.length} batch{alerts.retestDue.length > 1 ? 'es' : ''} past retest
              date
            </p>
            <ul className="mt-1.5 space-y-0.5 text-xs text-orange-800">
              {alerts.retestDue.slice(0, 5).map((r) => (
                <li key={r.batchId}>
                  {r.material} · {r.batchNumber} — due {date(r.retestDate)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {alerts && alerts.expiringSoon.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
            <p className="text-sm font-medium text-amber-900">
              {alerts.expiringSoon.length} batch{alerts.expiringSoon.length > 1 ? 'es' : ''}{' '}
              expiring within 30 days
            </p>
            <ul className="mt-1.5 space-y-0.5 text-xs text-amber-800">
              {alerts.expiringSoon.slice(0, 5).map((e) => (
                <li key={e.batchId}>
                  {e.material} · {e.batchNumber} — {date(e.expiryDate)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-3">
        {canReceive && materials.length > 0 && (
          <Card title="Receive a consignment">
            <ReceiveGoodsForm
              action={receiveGoods}
              materials={materials}
              labs={refData.labs}
            />
          </Card>
        )}

        <Card
          className={canReceive && materials.length > 0 ? 'lg:col-span-2' : 'lg:col-span-3'}
          title={`Batches (${batches.length})`}
        >
          <form className="flex flex-wrap items-end gap-2 border-b border-ink-100 px-4 py-3">
            <label className="min-w-0 flex-1 sm:max-w-xs">
              <span className="mb-1 block text-xs font-medium text-ink-600">Search</span>
              <input
                name="search"
                defaultValue={sp.search ?? ''}
                placeholder="Batch, lot or material"
                className="h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
              />
            </label>
            <label>
              <span className="mb-1 block text-xs font-medium text-ink-600">Status</span>
              <select
                name="status"
                defaultValue={sp.status ?? ''}
                className="h-11 rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
              >
                <option value="">All</option>
                <option value="QUARANTINE">Quarantine</option>
                <option value="UNDER_TEST">Under test</option>
                <option value="APPROVED">Approved</option>
                <option value="REJECTED">Rejected</option>
                <option value="RETEST_DUE">Retest due</option>
              </select>
            </label>
            <label>
              <span className="mb-1 block text-xs font-medium text-ink-600">Type</span>
              <select
                name="type"
                defaultValue={sp.type ?? ''}
                className="h-11 rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
              >
                <option value="">All</option>
                <option value="API">API</option>
                <option value="RAW_MATERIAL">Raw material</option>
                <option value="PACKAGING">Packaging</option>
                <option value="INTERMEDIATE">Intermediate</option>
                <option value="BULK">Bulk</option>
                <option value="FINISHED_PRODUCT">Finished product</option>
              </select>
            </label>
            <button
              type="submit"
              className="min-h-11 rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
            >
              Apply
            </button>
          </form>

          {batches.length === 0 ? (
            <EmptyState
              title="No batches match"
              hint="Receive a consignment to create one."
            />
          ) : (
            <ul className="divide-y divide-ink-100">
              {batches.map((b) => (
                <li key={b.id} className={b.isExpired ? 'bg-red-50/40' : ''}>
                  <div className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link
                          href={`/stores/${b.id}`}
                          className="text-sm font-medium text-brand-600 hover:underline"
                        >
                          {b.material.name}
                        </Link>
                        <div className="numeric mt-0.5 text-xs text-ink-500">
                          {b.material.code} · batch {b.batchNumber}
                          {b.manufacturerLot && ` · supplier lot ${b.manufacturerLot}`}
                        </div>
                        <div className="mt-0.5 text-xs text-ink-500">
                          {b.material.type.replace(/_/g, ' ').toLowerCase()}
                          {b.supplier && ` · ${b.supplier}`}
                          {b.location && ` · ${b.location}`}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="numeric text-sm font-semibold text-ink-900">
                          {b.quantityAvailable} {b.unit}
                        </div>
                        <div className="mt-0.5">
                          <StatusPill status={b.status} />
                        </div>
                        {b.isIssuable ? (
                          <div className="mt-0.5 text-[10px] font-medium text-[var(--color-normal)]">
                            issuable
                          </div>
                        ) : (
                          <div className="mt-0.5 text-[10px] text-ink-400">not issuable</div>
                        )}
                      </div>
                    </div>

                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-500">
                      {b.expiryDate && (
                        <span className={b.isExpired ? 'font-medium text-[var(--color-critical)]' : ''}>
                          Expiry {date(b.expiryDate)}
                        </span>
                      )}
                      {b.retestDate && (
                        <span className={b.isRetestDue ? 'font-medium text-orange-700' : ''}>
                          Retest {date(b.retestDate)}
                        </span>
                      )}
                      {b.containerCount != null && <span>{b.containerCount} containers</span>}
                      {b.openInvestigations > 0 && (
                        <span className="font-medium text-[var(--color-critical)]">
                          {b.openInvestigations} open OOS
                        </span>
                      )}
                    </div>

                    {canRequest && b.status === 'QUARANTINE' && (
                      <RequestSamplingForm action={requestSampling.bind(null, b.id)} />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title={`Material master (${materials.length})`}>
        {materials.length === 0 ? (
          <EmptyState title="No materials defined" hint="An administrator configures these." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Material</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Pharmacopoeia</th>
                  <th className="px-4 py-2 text-right font-medium">Approved</th>
                  <th className="px-4 py-2 text-right font-medium">Quarantined</th>
                  <th className="px-4 py-2 text-right font-medium">Specs</th>
                  <th className="px-4 py-2 font-medium">Storage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {materials.map((m) => (
                  <tr key={m.id}>
                    <td className="px-4 py-2">
                      <div className="font-medium text-ink-900">{m.name}</div>
                      <div className="numeric text-xs text-ink-400">
                        {m.code}
                        {m.manufacturer && ` · ${m.manufacturer}`}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-500">
                      {m.type.replace(/_/g, ' ').toLowerCase()}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-500">
                      {m.pharmacopoeia ?? '—'}
                    </td>
                    <td className="numeric whitespace-nowrap px-4 py-2 text-right font-medium text-[var(--color-normal)]">
                      {m.approvedQuantity} {m.unit}
                    </td>
                    <td className="numeric whitespace-nowrap px-4 py-2 text-right text-[var(--color-high)]">
                      {m.quarantinedQuantity} {m.unit}
                    </td>
                    <td
                      className={`numeric px-4 py-2 text-right ${
                        m.specificationCount === 0 ? 'font-medium text-[var(--color-critical)]' : 'text-ink-600'
                      }`}
                    >
                      {m.specificationCount}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-500">
                      {m.storageCondition ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-400">
          Approved and quarantined quantities are never added together — only QA-released material
          may be issued to production. A material with no specification cannot be sampled.
        </p>
      </Card>
    </div>
  );
}
