'use client';

import { useState } from 'react';
import { Submit, Field, TextArea } from '@/components/forms';

interface Material {
  id: string;
  code: string;
  name: string;
  type: string;
  unit: string;
  storageCondition: string | null;
  specificationCount: number;
}

/**
 * Booking a consignment in.
 *
 * There is deliberately no status field. Everything received goes to
 * quarantine — offering the storekeeper a choice would make the entire release
 * chain optional, which is the failure this module exists to prevent. The form
 * says so rather than leaving it to be discovered.
 */
export function ReceiveGoodsForm({
  action,
  materials,
  labs,
}: {
  action: (fd: FormData) => Promise<void>;
  materials: Material[];
  labs: { id: string; code: string; name: string }[];
}) {
  const [materialId, setMaterialId] = useState(materials[0]?.id ?? '');
  const selected = materials.find((m) => m.id === materialId);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form action={action} className="space-y-3 p-4">
      {labs.length > 1 && (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">Site</span>
          <select
            name="labId"
            className="h-11 w-full rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
          >
            {labs.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {labs.length === 1 && <input type="hidden" name="labId" value={labs[0]!.id} />}

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">
          Material<span className="ml-0.5 text-red-600">*</span>
        </span>
        <select
          name="materialId"
          value={materialId}
          onChange={(e) => setMaterialId(e.target.value)}
          className="h-11 w-full rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
        >
          {materials.map((m) => (
            <option key={m.id} value={m.id}>
              {m.code} — {m.name}
            </option>
          ))}
        </select>
        {selected?.storageCondition && (
          <span className="mt-1 block text-xs text-ink-400">
            Store at {selected.storageCondition}
          </span>
        )}
        {selected && selected.specificationCount === 0 && (
          <span className="mt-1 block text-xs font-medium text-[var(--color-high)]">
            No specification exists for this material. It can be received, but QC will have
            nothing to test it against until QA approves one.
          </span>
        )}
      </label>

      <Field label="Supplier" name="supplierName" required placeholder="Divis Laboratories Ltd" />

      <div className="grid grid-cols-2 gap-3">
        <Field label="Batch number" name="batchNumber" required numeric />
        <Field label="Supplier lot" name="manufacturerLot" numeric />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label={`Quantity${selected ? ` (${selected.unit})` : ''}`}
          name="quantity"
          inputMode="decimal"
          required
          numeric
        />
        <Field
          label="Containers"
          name="containerCount"
          inputMode="numeric"
          numeric
          hint="Sampling is per container."
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Manufactured" name="manufacturedAt" type="date" max={today} />
        <Field
          label="Expiry"
          name="expiryDate"
          type="date"
          min={today}
          hint="Expired material is refused."
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Invoice ref" name="invoiceRef" numeric />
        <Field label="PO ref" name="poReference" numeric />
      </div>

      <TextArea
        label="Receipt check"
        name="receiptCheckNote"
        rows={2}
        placeholder="Seals intact, containers undamaged, data logger 2-8 C throughout"
        hint="Vehicle condition, seals, cold-chain reading."
      />

      <Submit label="Receive into quarantine" />
      <p className="text-xs text-ink-400">
        Everything received is quarantined and physically segregated. QA release is required
        before any of it can be issued.
      </p>
    </form>
  );
}

export function RequestSamplingForm({ action }: { action: (fd: FormData) => Promise<void> }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="-ml-2 mt-1 inline-flex min-h-11 items-center px-2 text-xs font-medium text-brand-600 hover:underline"
      >
        Request QC sampling
      </button>
    );
  }

  return (
    <form action={action} className="mt-2 space-y-2 rounded-md border border-ink-200 bg-ink-50 p-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-ink-700">Reason</span>
        <select
          name="reason"
          className="h-11 w-full rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
        >
          <option value="RELEASE_TESTING">Release testing</option>
          <option value="RETEST">Retest</option>
          <option value="OOS_RESAMPLE">Resample after OOS</option>
          <option value="STABILITY">Stability</option>
          <option value="COMPLAINT_INVESTIGATION">Complaint investigation</option>
        </select>
      </label>
      <input
        name="note"
        placeholder="Note for QC (optional)"
        className="h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
      />
      <div className="flex gap-2">
        <Submit label="Send to QC" full={false} />
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="min-h-11 rounded-md px-3 text-sm text-ink-500 hover:bg-ink-100"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function IssueForm({
  action,
  available,
  unit,
}: {
  action: (fd: FormData) => Promise<void>;
  available: number;
  unit: string;
}) {
  return (
    <form action={action} className="space-y-3 p-4">
      <Field
        label={`Quantity to issue (${unit})`}
        name="quantity"
        inputMode="decimal"
        required
        numeric
        max={available}
        hint={`${available} ${unit} available.`}
      />
      <Field
        label="Against"
        name="reference"
        required
        placeholder="BMR/2026/0412 — Paracetamol 500mg batch"
        hint="The production order or batch manufacturing record."
      />
      <Submit label="Issue to production" />
    </form>
  );
}

export function MoveForm({ action }: { action: (fd: FormData) => Promise<void> }) {
  return (
    <form action={action} className="space-y-3 p-4">
      <Field label="New location" name="location" required placeholder="APPROVED STORE - RACK B4" />
      <TextArea label="Reason" name="reason" rows={2} required minLength={10} />
      <Submit label="Move" tone="quiet" />
    </form>
  );
}
