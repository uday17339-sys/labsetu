'use client';

import { useState } from 'react';
import { useFormStatus } from 'react-dom';

interface Item {
  id: string;
  code: string;
  name: string;
  unit: string;
  storageCondition: string | null;
}

function Submit({ label, tone = 'primary' }: { label: string; tone?: 'primary' | 'danger' }) {
  const { pending } = useFormStatus();
  const cls =
    tone === 'danger'
      ? 'border border-red-300 bg-white text-red-800 hover:bg-red-50'
      : 'bg-brand-600 text-white hover:bg-brand-700';
  return (
    <button
      type="submit"
      disabled={pending}
      className={`min-h-11 w-full rounded-md px-4 py-2 text-sm font-medium transition disabled:opacity-60 ${cls}`}
    >
      {pending ? 'Saving…' : label}
    </button>
  );
}

export function ReceiveStockForm({
  action,
  items,
}: {
  action: (fd: FormData) => Promise<void>;
  items: Item[];
}) {
  const [itemId, setItemId] = useState(items[0]?.id ?? '');
  const selected = items.find((i) => i.id === itemId);

  // Today, so the browser refuses a past expiry before the request is even made.
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form action={action} className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">Item</span>
        <select
          name="itemId"
          value={itemId}
          onChange={(e) => setItemId(e.target.value)}
          className="h-11 w-full rounded-md border border-ink-300 px-2 text-sm"
        >
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.code} — {i.name}
            </option>
          ))}
        </select>
        {selected?.storageCondition && (
          <span className="mt-1 block text-xs text-ink-400">
            Store at {selected.storageCondition}
          </span>
        )}
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">Lot number</span>
          <input
            name="lotNumber"
            required
            autoComplete="off"
            className="numeric h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">
            Quantity{selected ? ` (${selected.unit})` : ''}
          </span>
          <input
            name="quantity"
            inputMode="decimal"
            required
            className="numeric h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
          />
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">Expiry date</span>
        <input
          name="expiryDate"
          type="date"
          // An already-expired lot cannot be received into usable stock; the API
          // refuses it too, but blocking here saves a round trip.
          min={today}
          className="h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
        />
        <span className="mt-1 block text-xs text-ink-400">
          Leave blank only for items with no expiry, such as tips.
        </span>
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">Supplier</span>
          <input
            name="supplier"
            autoComplete="off"
            className="h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">Invoice ref</span>
          <input
            name="invoiceRef"
            autoComplete="off"
            className="h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
          />
        </label>
      </div>

      <Submit label="Receive into stock" />
    </form>
  );
}

export function DisposeLotForm({ action }: { action: (fd: FormData) => Promise<void> }) {
  return (
    <form action={action} className="mt-2 space-y-2 border-t border-red-100 pt-2">
      <textarea
        name="reason"
        rows={2}
        required
        minLength={10}
        placeholder="Reason for write-off — e.g. expired on 20 Jul, discarded per SOP-WM-04"
        className="w-full rounded-md border border-ink-300 px-2 py-1.5 text-xs"
      />
      <Submit label="Dispose &amp; write off" tone="danger" />
      <p className="text-[10px] text-ink-500">
        Recorded in the audit trail and the stock ledger. The quantity is written to zero.
      </p>
    </form>
  );
}
