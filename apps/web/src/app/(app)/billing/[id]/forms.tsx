'use client';

import { useState } from 'react';
import { Submit, Field, TextArea } from '@/components/forms';
import { money } from '@/lib/format';

/** Mirrors the PaymentMode enum in schema.prisma. Keep the two in step. */
const MODES = [
  { value: 'CASH', label: 'Cash' },
  { value: 'UPI', label: 'UPI' },
  { value: 'CARD', label: 'Card' },
  { value: 'NETBANKING', label: 'Net banking' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'INSURANCE', label: 'Insurance / TPA' },
  { value: 'CREDIT', label: 'Credit (corporate)' },
];

/**
 * Taking payment at the counter.
 *
 * The amount defaults to the full balance because that is what happens nine
 * times out of ten, and the reference field appears only for modes that
 * actually have one — asking for a UPI reference against a cash payment is the
 * kind of friction that makes a receptionist stop using the system.
 */
export function PaymentForm({
  action,
  balance,
}: {
  action: (fd: FormData) => Promise<void>;
  balance: number;
}) {
  const [mode, setMode] = useState('CASH');
  const [amount, setAmount] = useState(balance.toFixed(2));

  const needsReference = mode !== 'CASH';
  const parsed = Number(amount);
  const over = Number.isFinite(parsed) && parsed > balance + 0.001;
  const partial = Number.isFinite(parsed) && parsed > 0 && parsed < balance - 0.001;

  return (
    <form action={action} className="space-y-3 p-4">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">Mode</span>
        <select
          name="mode"
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          className="h-11 w-full rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">Amount received</span>
        <input
          name="amount"
          inputMode="decimal"
          required
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="numeric h-11 w-full rounded-md border border-ink-300 px-2 text-base font-semibold sm:text-sm"
        />
        <span className="mt-1 block text-xs text-ink-400">
          Balance due {money(balance)}.
        </span>
      </label>

      {over && (
        <p role="alert" className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800">
          That is more than the balance. Over-collection is refused — take {money(balance)} or
          raise a separate charge.
        </p>
      )}
      {partial && (
        <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          Part payment. {money(balance - parsed)} will remain outstanding.
        </p>
      )}

      {needsReference && (
        <Field
          label="Reference"
          name="reference"
          numeric
          hint="UPI transaction ID, last 4 of the card, or cheque number."
        />
      )}

      <Submit label={`Record ${money(Number.isFinite(parsed) ? parsed : 0)}`} />
      <p className="text-xs text-ink-400">
        Payments are append-only. A mistake is corrected with a refund entry, never by editing
        this one.
      </p>
    </form>
  );
}

export function CancelInvoiceForm({ action }: { action: (fd: FormData) => Promise<void> }) {
  return (
    <form action={action} className="space-y-2 p-4">
      <TextArea
        label="Reason for cancelling"
        name="reason"
        rows={2}
        required
        minLength={10}
        placeholder="e.g. Duplicate registration — patient billed twice for the same visit"
      />
      <Submit label="Cancel invoice" tone="danger" />
    </form>
  );
}

/** Opens the browser print dialog against the print stylesheet. */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="no-print min-h-11 rounded-md border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-100"
    >
      Print invoice
    </button>
  );
}
