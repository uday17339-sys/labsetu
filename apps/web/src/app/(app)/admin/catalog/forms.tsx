'use client';

import { useState } from 'react';
import { Submit, Field, TextArea } from '@/components/forms';
import { money } from '@/lib/format';

const DEPARTMENTS = [
  'BIOCHEMISTRY',
  'HAEMATOLOGY',
  'MICROBIOLOGY',
  'SEROLOGY',
  'IMMUNOLOGY',
  'HISTOPATHOLOGY',
  'CYTOLOGY',
  'MOLECULAR',
  'CLINICAL_PATHOLOGY',
  'RADIOLOGY',
];

interface Analyte {
  id: string;
  code: string;
  name: string;
  defaultUnit: string | null;
  valueType: string;
}

/**
 * Adding a test to the menu.
 *
 * Analyte selection is the part that trips people up: a test with no analytes
 * can be ordered and billed but never resulted, so the sample strands at the
 * bench. The form refuses to submit without at least one, and says why.
 */
export function CreateTestForm({
  action,
  analytes,
  specimenTypes,
  containerTypes,
}: {
  action: (fd: FormData) => Promise<void>;
  analytes: Analyte[];
  specimenTypes: { id: string; code: string; name: string }[];
  containerTypes: { id: string; code: string; name: string; colour: string | null }[];
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState('');

  const shown = filter
    ? analytes.filter(
        (a) =>
          a.name.toLowerCase().includes(filter.toLowerCase()) ||
          a.code.toLowerCase().includes(filter.toLowerCase()),
      )
    : analytes;

  function toggle(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  return (
    <form action={action} className="space-y-3 p-4">
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Code"
          name="code"
          required
          numeric
          placeholder="VITD"
          hint="Prints on reports."
        />
        <Field label="Price (₹)" name="price" inputMode="decimal" required numeric />
      </div>

      <Field label="Name" name="name" required placeholder="Vitamin D (25-OH)" />

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">
            Department<span className="ml-0.5 text-red-600">*</span>
          </span>
          <select
            name="department"
            required
            className="h-11 w-full rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
          >
            {DEPARTMENTS.map((d) => (
              <option key={d} value={d}>
                {d.replace(/_/g, ' ').toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="Turnaround (min)"
          name="tatMinutes"
          inputMode="numeric"
          numeric
          hint="Drives breach reporting."
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">Specimen</span>
          <select
            name="specimenTypeId"
            className="h-11 w-full rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
          >
            <option value="">—</option>
            {specimenTypes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">Container</span>
          <select
            name="containerTypeId"
            className="h-11 w-full rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
          >
            <option value="">—</option>
            {containerTypes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.colour ? ` (${c.colour})` : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <TextArea
        label="Patient instructions"
        name="instructions"
        rows={2}
        placeholder="e.g. 10-12 hours fasting required"
        hint="Printed on the requisition."
      />

      <fieldset>
        <legend className="mb-1 text-sm font-medium text-ink-700">
          Analytes<span className="ml-0.5 text-red-600">*</span>
        </legend>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter analytes"
          className="mb-1.5 h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
        />
        <div className="max-h-52 space-y-0.5 overflow-y-auto rounded-md border border-ink-300 p-2">
          {shown.length === 0 ? (
            <p className="px-1 py-3 text-center text-xs text-ink-400">No analytes match.</p>
          ) : (
            shown.map((a) => (
              <label
                key={a.id}
                className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-ink-50"
              >
                <input
                  type="checkbox"
                  name="analyteIds"
                  value={a.id}
                  checked={picked.includes(a.id)}
                  onChange={() => toggle(a.id)}
                  className="h-4 w-4 shrink-0"
                />
                <span className="numeric text-xs text-ink-500">{a.code}</span>
                <span className="truncate text-ink-900">{a.name}</span>
                {a.defaultUnit && (
                  <span className="numeric ml-auto shrink-0 text-xs text-ink-400">
                    {a.defaultUnit}
                  </span>
                )}
              </label>
            ))
          )}
        </div>
        <p
          className={`mt-1 text-xs ${picked.length === 0 ? 'text-[var(--color-high)]' : 'text-ink-400'}`}
        >
          {picked.length === 0
            ? 'Pick at least one — a test with no analytes can be ordered but never resulted.'
            : `${picked.length} selected. They print in this order.`}
        </p>
      </fieldset>

      <Submit label="Add to catalog" />
    </form>
  );
}

/** Price changes are the single most common catalog edit in a running lab. */
export function PriceForm({
  action,
  current,
  name,
}: {
  action: (fd: FormData) => Promise<void>;
  current: number;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState(String(current));

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        // inline-flex + min-h-11 keeps the tap target at the 44px floor while
        // the text itself stays small enough to sit under the price.
        className="-mr-2 inline-flex min-h-11 items-center px-2 text-xs font-medium text-brand-600 hover:underline"
      >
        Change price
      </button>
    );
  }

  const parsed = Number(price);
  const delta = Number.isFinite(parsed) ? parsed - current : 0;

  return (
    <form action={action} className="mt-1 flex flex-wrap items-end gap-2">
      <label className="block">
        <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-ink-500">
          New price for {name}
        </span>
        <input
          name="price"
          inputMode="decimal"
          required
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          className="numeric h-11 w-28 rounded-md border border-ink-300 px-2 text-base sm:text-sm"
        />
      </label>
      <Submit label="Save" full={false} />
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="min-h-11 rounded-md px-2 text-sm text-ink-500 hover:bg-ink-100"
      >
        Cancel
      </button>
      {delta !== 0 && (
        <span className="numeric self-center text-xs text-ink-500">
          {delta > 0 ? '+' : '−'}
          {money(Math.abs(delta))} vs {money(current)}
        </span>
      )}
    </form>
  );
}

export function CreateDoctorForm({ action }: { action: (fd: FormData) => Promise<void> }) {
  return (
    <form action={action} className="space-y-3 p-4">
      <Field label="Name" name="name" required placeholder="Dr Anil Kumar" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Speciality" name="speciality" placeholder="Cardiology" />
        <Field label="Phone" name="phone" inputMode="tel" numeric />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Qualification" name="qualification" placeholder="MBBS, MD" />
        <Field label="Registration no." name="registrationNo" numeric />
      </div>
      <Field
        label="Referral code"
        name="code"
        numeric
        hint="Leave blank and one is generated."
      />
      <Submit label="Add referring doctor" />
    </form>
  );
}
