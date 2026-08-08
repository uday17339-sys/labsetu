import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, EmptyState } from '@/components/ui';
import { ReceiveStockForm, DisposeLotForm } from './forms';

export const dynamic = 'force-dynamic';

interface Lot {
  id: string;
  lotNumber: string;
  quantityRemaining: number;
  expiryDate: string | null;
  isExpired: boolean;
  status: string;
  supplier: string | null;
}

interface Item {
  id: string;
  code: string;
  name: string;
  category: string;
  unit: string;
  manufacturer: string | null;
  storageCondition: string | null;
  reorderLevel: number;
  quantityOnHand: number;
  isBelowReorder: boolean;
  isOutOfStock: boolean;
  expiredLots: number;
  expiringSoonLots: number;
  nextExpiry: string | null;
  lots: Lot[];
}

interface Alerts {
  expired: {
    lotId: string;
    item: string;
    code: string;
    lotNumber: string;
    expiryDate: string | null;
    quantityRemaining: number;
    unit: string;
  }[];
  expiringSoon: {
    lotId: string;
    item: string;
    lotNumber: string;
    daysLeft: number | null;
    quantityRemaining: number;
    unit: string;
  }[];
  belowReorder: {
    itemId: string;
    code: string;
    name: string;
    quantityOnHand: number;
    reorderLevel: number;
    unit: string;
    isOutOfStock: boolean;
  }[];
}

async function receiveStock(formData: FormData): Promise<void> {
  'use server';
  const expiry = String(formData.get('expiryDate') ?? '').trim();
  try {
    await apiFetch('/inventory/receive', {
      method: 'POST',
      body: {
        itemId: String(formData.get('itemId') ?? ''),
        lotNumber: String(formData.get('lotNumber') ?? '').trim(),
        quantity: String(formData.get('quantity') ?? ''),
        expiryDate: expiry || undefined,
        supplier: String(formData.get('supplier') ?? '').trim() || undefined,
        invoiceRef: String(formData.get('invoiceRef') ?? '').trim() || undefined,
      },
    });
  } catch (err) {
    revalidatePath('/inventory');
    throw new Error(err instanceof ApiError ? err.message : 'Could not receive stock.');
  }
  revalidatePath('/inventory');
}

async function disposeLot(lotId: string, formData: FormData): Promise<void> {
  'use server';
  await apiFetch(`/inventory/lots/${lotId}/dispose`, {
    method: 'POST',
    body: { reason: String(formData.get('reason') ?? '').trim() },
  });
  revalidatePath('/inventory');
}

export default async function InventoryPage() {
  const user = await getSessionUser();

  const [items, alerts] = await Promise.all([
    apiFetch<Item[]>('/inventory/items').catch(() => []),
    apiFetch<Alerts>('/inventory/alerts').catch(() => ({
      expired: [],
      expiringSoon: [],
      belowReorder: [],
    })),
  ]);

  const canManage = can(user, 'inventory:manage');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Inventory</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Reagents, controls and consumables. Stock decrements automatically as tests are run.
          </p>
        </div>
        {can(user, 'compliance:export') && (
          <a
            href="/api/v1/export/inventory.csv"
            className="min-h-11 rounded-md border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-100"
          >
            Export CSV
          </a>
        )}
      </div>

      {/* Expired stock is the loudest thing here: it cannot legitimately be used
          and the system will refuse to consume it. */}
      {alerts.expired.length > 0 && (
        <div className="rounded-lg border-2 border-[var(--color-critical)] bg-[var(--color-critical-bg)] px-4 py-3">
          <p className="text-sm font-bold text-[var(--color-critical)]">
            {alerts.expired.length} expired lot{alerts.expired.length > 1 ? 's' : ''} still in stock
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-critical)] opacity-90">
            These cannot be consumed — a result produced with an expired reagent is not
            defensible. Dispose of them so the stock figure reflects what is usable.
          </p>
          <ul className="mt-2 space-y-2">
            {alerts.expired.map((e) => (
              <li key={e.lotId} className="rounded border border-red-200 bg-white px-3 py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-ink-900">
                    {e.item} <span className="text-ink-500">· lot {e.lotNumber}</span>
                  </span>
                  <span className="numeric text-sm text-[var(--color-critical)]">
                    expired {e.expiryDate ? new Date(e.expiryDate).toLocaleDateString('en-IN') : ''} ·{' '}
                    {e.quantityRemaining} {e.unit} affected
                  </span>
                </div>
                {canManage && <DisposeLotForm action={disposeLot.bind(null, e.lotId)} />}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {alerts.expiringSoon.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
            <p className="text-sm font-medium text-amber-900">
              {alerts.expiringSoon.length} lot{alerts.expiringSoon.length > 1 ? 's' : ''} expiring
              within 30 days
            </p>
            <ul className="mt-1.5 space-y-0.5 text-xs text-amber-800">
              {alerts.expiringSoon.map((e) => (
                <li key={e.lotId}>
                  {e.item} · lot {e.lotNumber} —{' '}
                  <span className="numeric font-medium">{e.daysLeft} days</span> ·{' '}
                  {e.quantityRemaining} {e.unit}
                </li>
              ))}
            </ul>
          </div>
        )}

        {alerts.belowReorder.length > 0 && (
          <div className="rounded-lg border border-orange-300 bg-orange-50 px-4 py-3">
            <p className="text-sm font-medium text-orange-900">
              {alerts.belowReorder.length} item{alerts.belowReorder.length > 1 ? 's' : ''} at or
              below reorder level
            </p>
            <ul className="mt-1.5 space-y-0.5 text-xs text-orange-800">
              {alerts.belowReorder.map((r) => (
                <li key={r.itemId}>
                  {r.name} —{' '}
                  <span className="numeric font-medium">
                    {r.quantityOnHand} / {r.reorderLevel} {r.unit}
                  </span>
                  {r.isOutOfStock && <span className="ml-1 font-bold">OUT OF STOCK</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {canManage && (
          <Card title="Receive stock">
            <div className="p-4">
              {items.length === 0 ? (
                <p className="text-sm text-ink-500">No inventory items configured.</p>
              ) : (
                <ReceiveStockForm action={receiveStock} items={items} />
              )}
            </div>
          </Card>
        )}

        <Card className={canManage ? 'lg:col-span-2' : 'lg:col-span-3'} title="Stock on hand">
          {items.length === 0 ? (
            <EmptyState title="No inventory items" hint="An administrator configures these." />
          ) : (
            <>
              {/* Mobile: cards */}
              <ul className="divide-y divide-ink-100 md:hidden">
                {items.map((i) => (
                  <li key={i.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-ink-900">{i.name}</div>
                        <div className="mt-0.5 text-xs text-ink-500">
                          {i.code} · {i.category.toLowerCase()}
                          {i.storageCondition && ` · ${i.storageCondition}`}
                        </div>
                      </div>
                      <StockBadge item={i} />
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-500">
                      <span>
                        Reorder at <span className="numeric">{i.reorderLevel}</span>
                      </span>
                      {i.nextExpiry && (
                        <span>
                          Next expiry{' '}
                          <span className="numeric">
                            {new Date(i.nextExpiry).toLocaleDateString('en-IN')}
                          </span>
                        </span>
                      )}
                      {i.expiredLots > 0 && (
                        <span className="font-medium text-[var(--color-critical)]">
                          {i.expiredLots} expired lot{i.expiredLots > 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>

              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                    <tr>
                      <th className="px-4 py-2 font-medium">Item</th>
                      <th className="px-4 py-2 font-medium">Category</th>
                      <th className="px-4 py-2 font-medium">On hand</th>
                      <th className="px-4 py-2 font-medium">Reorder at</th>
                      <th className="px-4 py-2 font-medium">Lots</th>
                      <th className="px-4 py-2 font-medium">Next expiry</th>
                      <th className="px-4 py-2 font-medium">Storage</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {items.map((i) => (
                      <tr
                        key={i.id}
                        className={i.isOutOfStock ? 'bg-red-50/50' : i.isBelowReorder ? 'bg-orange-50/40' : ''}
                      >
                        <td className="px-4 py-2">
                          <div className="font-medium text-ink-900">{i.name}</div>
                          <div className="text-xs text-ink-400">
                            {i.code}
                            {i.manufacturer && ` · ${i.manufacturer}`}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-500">
                          {i.category.toLowerCase()}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <StockBadge item={i} />
                        </td>
                        <td className="numeric whitespace-nowrap px-4 py-2 text-ink-600">
                          {i.reorderLevel} {i.unit}
                        </td>
                        <td className="px-4 py-2 text-xs">
                          <span className="text-ink-600">
                            {i.lots.filter((l) => !l.isExpired).length} usable
                          </span>
                          {i.expiredLots > 0 && (
                            <span className="ml-2 font-medium text-[var(--color-critical)]">
                              {i.expiredLots} expired
                            </span>
                          )}
                        </td>
                        <td className="numeric whitespace-nowrap px-4 py-2 text-xs text-ink-500">
                          {i.nextExpiry
                            ? new Date(i.nextExpiry).toLocaleDateString('en-IN')
                            : '—'}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-500">
                          {i.storageCondition ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-400">
            Expired lots are excluded from usable stock and cannot be consumed. Allocation is
            first-expiry-first-out.
          </p>
        </Card>
      </div>
    </div>
  );
}

function StockBadge({ item }: { item: Item }) {
  const tone = item.isOutOfStock
    ? 'bg-[var(--color-critical-bg)] text-[var(--color-critical)] ring-red-300'
    : item.isBelowReorder
      ? 'bg-orange-50 text-orange-800 ring-orange-200'
      : 'bg-emerald-50 text-emerald-700 ring-emerald-200';

  return (
    <span className={`numeric inline-flex rounded px-2 py-0.5 text-sm font-semibold ring-1 ${tone}`}>
      {item.quantityOnHand} {item.unit}
    </span>
  );
}
