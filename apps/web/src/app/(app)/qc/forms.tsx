'use client';

import { useState } from 'react';
import { useFormStatus } from 'react-dom';

interface QcLot {
  id: string;
  lotNumber: string;
  material: { code: string; name: string; level: string };
  analytes: {
    targetMean: string;
    targetSd: string;
    unit: string | null;
    analyte: { id: string; code: string; name: string; defaultUnit: string | null };
  }[];
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-11 w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? 'Recording…' : label}
    </button>
  );
}

export function QcEntryForm({
  action,
  lots,
  devices,
}: {
  action: (fd: FormData) => Promise<void>;
  lots: QcLot[];
  devices: { id: string; code: string; name: string }[];
}) {
  // One flat option list of lot+analyte pairs: a technician thinks "I am running
  // glucose on the normal control", not "first pick a lot, then pick an analyte".
  const options = lots.flatMap((lot) =>
    lot.analytes.map((la) => ({
      value: `${lot.id}|${la.analyte.id}`,
      label: `${la.analyte.code} — ${lot.material.name} (L${lot.material.level.replace('LEVEL_', '')})`,
      mean: Number(la.targetMean),
      sd: Number(la.targetSd),
      unit: la.unit ?? la.analyte.defaultUnit,
      lotNumber: lot.lotNumber,
    })),
  );

  const [selected, setSelected] = useState(options[0]?.value ?? '');
  const [value, setValue] = useState('');

  const target = options.find((o) => o.value === selected);
  // Live SD feedback while typing: the technician sees the run failing before
  // they submit it, which is the whole point of showing target and SD together.
  const z =
    target && value !== '' && Number.isFinite(Number(value)) && target.sd !== 0
      ? (Number(value) - target.mean) / target.sd
      : null;

  return (
    <form action={action} className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">Control &amp; analyte</span>
        <select
          name="target"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="h-11 w-full rounded-md border border-ink-300 px-2 text-sm"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      {target && (
        <div className="rounded-md border border-ink-200 bg-ink-50 px-3 py-2 text-xs text-ink-600">
          Lot <span className="numeric">{target.lotNumber}</span> · target{' '}
          <span className="numeric font-medium">{target.mean}</span> ± {target.sd}{' '}
          {target.unit ?? ''}
          <div className="mt-0.5 text-ink-500">
            2SD range{' '}
            <span className="numeric">
              {(target.mean - 2 * target.sd).toFixed(2)} –{' '}
              {(target.mean + 2 * target.sd).toFixed(2)}
            </span>
          </div>
        </div>
      )}

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">Measured value</span>
        <input
          name="value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode="decimal"
          required
          autoComplete="off"
          className="numeric h-11 w-full rounded-md border border-ink-300 px-3 text-base focus:border-brand-500 focus:ring-2 focus:ring-brand-100 sm:text-sm"
        />
      </label>

      {z !== null && (
        <div
          className={`rounded-md px-3 py-2 text-sm ${
            Math.abs(z) > 3
              ? 'bg-[var(--color-critical-bg)] text-[var(--color-critical)] ring-1 ring-red-300'
              : Math.abs(z) > 2
                ? 'bg-amber-50 text-amber-800 ring-1 ring-amber-200'
                : 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200'
          }`}
        >
          <span className="numeric font-semibold">
            {z > 0 ? '+' : ''}
            {z.toFixed(2)} SD
          </span>{' '}
          {Math.abs(z) > 3
            ? '— beyond 3SD, this will reject the run'
            : Math.abs(z) > 2
              ? '— beyond 2SD, this will raise a warning'
              : '— within 2SD'}
        </div>
      )}

      {devices.length > 0 && (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">
            Analyzer <span className="font-normal text-ink-400">(optional)</span>
          </span>
          <select
            name="deviceId"
            className="h-11 w-full rounded-md border border-ink-300 px-2 text-sm"
          >
            <option value="">Not specified</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code} — {d.name}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-ink-400">
            Sequential rules are evaluated per analyzer.
          </span>
        </label>
      )}

      <Submit label="Record QC run" />
    </form>
  );
}

export function AcceptFailureForm({ action }: { action: (fd: FormData) => Promise<void> }) {
  return (
    <form action={action} className="mt-2 space-y-2 border-t border-red-100 pt-2">
      <textarea
        name="actionTaken"
        rows={2}
        required
        minLength={10}
        placeholder="Corrective action taken — e.g. recalibrated, new control vial opened, re-run within limits"
        className="w-full rounded-md border border-ink-300 px-2 py-1.5 text-xs"
      />
      <button
        type="submit"
        className="min-h-10 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-50"
      >
        Resolve &amp; unblock
      </button>
      <p className="text-[10px] text-ink-500">
        Recorded as a QC_OVERRIDE in the audit trail. Assessors sample these.
      </p>
    </form>
  );
}
