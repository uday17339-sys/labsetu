'use client';

import { useMemo, useState } from 'react';
import { useFormStatus } from 'react-dom';

interface TestOption {
  id: string;
  code: string;
  name: string;
  department: string;
  price: string;
  tatMinutes: number | null;
  instructions: string | null;
}

interface PanelOption {
  id: string;
  code: string;
  name: string;
  price: string;
  items: { testDefinition: { code: string; name: string } }[];
}

function Submit({ total }: { total: number }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-brand-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? 'Registering…' : `Register & order · ₹${total.toLocaleString('en-IN')}`}
    </button>
  );
}

export function RegisterForm({
  action,
  labs,
  tests,
  panels,
}: {
  action: (fd: FormData) => Promise<void>;
  labs: { id: string; code: string; name: string }[];
  tests: TestOption[];
  panels: PanelOption[];
}) {
  const [selectedTests, setSelectedTests] = useState<Set<string>>(new Set());
  const [selectedPanels, setSelectedPanels] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  const total = useMemo(() => {
    let sum = 0;
    for (const t of tests) if (selectedTests.has(t.id)) sum += Number(t.price);
    for (const p of panels) if (selectedPanels.has(p.id)) sum += Number(p.price);
    return sum;
  }, [selectedTests, selectedPanels, tests, panels]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tests;
    return tests.filter(
      (t) => t.code.toLowerCase().includes(q) || t.name.toLowerCase().includes(q),
    );
  }, [search, tests]);

  // Fasting and prep instructions must be visible at the counter — telling the
  // patient after the draw is too late.
  const instructions = useMemo(() => {
    const notes = new Set<string>();
    for (const t of tests) {
      if (selectedTests.has(t.id) && t.instructions) notes.add(t.instructions);
    }
    return [...notes];
  }, [selectedTests, tests]);

  const toggle = (set: Set<string>, id: string, update: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    update(next);
  };

  return (
    <form action={action} className="divide-y divide-ink-200">
      <div className="grid gap-6 p-5 lg:grid-cols-2">
        {/* Patient */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Patient</h3>

          <Field label="Full name" name="fullName" required autoFocus autoComplete="off" />

          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink-700">Sex</span>
              <select
                name="sex"
                defaultValue="MALE"
                className="w-full rounded-md border border-ink-300 px-3 py-2 text-sm"
              >
                <option value="MALE">Male</option>
                <option value="FEMALE">Female</option>
                <option value="OTHER">Other</option>
                <option value="UNKNOWN">Not stated</option>
              </select>
            </label>
            <Field
              label="Age (years)"
              name="ageYears"
              type="number"
              min={0}
              max={150}
              required
              hint="Reference ranges depend on this"
            />
          </div>

          <Field
            label="Mobile"
            name="phone"
            inputMode="tel"
            placeholder="9848012345"
            hint="Used for report delivery"
          />
          <Field label="Email" name="email" type="email" />

          <label className="flex items-start gap-2 rounded-md border border-ink-200 bg-ink-50 px-3 py-2">
            <input
              type="checkbox"
              name="consentDelivery"
              defaultChecked
              className="mt-0.5 rounded border-ink-300"
            />
            <span className="text-xs leading-relaxed text-ink-600">
              Patient consents to receiving their report by WhatsApp, SMS or email.
              <span className="block text-ink-400">
                Without this, electronic delivery is blocked automatically (DPDP purpose
                limitation).
              </span>
            </span>
          </label>
        </div>

        {/* Order */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Order</h3>

          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink-700">Branch</span>
              <select
                name="labId"
                required
                className="w-full rounded-md border border-ink-300 px-3 py-2 text-sm"
              >
                {labs.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code} — {l.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink-700">Priority</span>
              <select
                name="priority"
                defaultValue="ROUTINE"
                className="w-full rounded-md border border-ink-300 px-3 py-2 text-sm"
              >
                <option value="ROUTINE">Routine</option>
                <option value="URGENT">Urgent</option>
                <option value="STAT">STAT</option>
              </select>
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink-700">
              Clinical notes <span className="font-normal text-ink-400">(optional)</span>
            </span>
            <textarea
              name="clinicalNotes"
              rows={2}
              className="w-full rounded-md border border-ink-300 px-3 py-2 text-sm"
              placeholder="Provisional diagnosis, relevant history"
            />
          </label>

          {instructions.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
              <p className="text-xs font-medium text-amber-900">Tell the patient:</p>
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-amber-800">
                {instructions.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Test selection */}
      <div className="p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Tests &amp; packages
          </h3>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tests…"
            className="w-56 rounded-md border border-ink-300 px-3 py-1.5 text-sm"
          />
        </div>

        {panels.length > 0 && !search && (
          <div className="mb-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-400">
              Packages
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {panels.map((p) => (
                <label
                  key={p.id}
                  className={`cursor-pointer rounded-md border px-3 py-2 transition ${
                    selectedPanels.has(p.id)
                      ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500'
                      : 'border-ink-200 hover:border-ink-300'
                  }`}
                >
                  <input
                    type="checkbox"
                    name="panelId"
                    value={p.id}
                    checked={selectedPanels.has(p.id)}
                    onChange={() => toggle(selectedPanels, p.id, setSelectedPanels)}
                    className="sr-only"
                  />
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-ink-900">{p.name}</span>
                    <span className="numeric text-sm text-ink-700">₹{Number(p.price)}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-500">
                    {p.items.map((i) => i.testDefinition.code).join(' · ')}
                  </p>
                </label>
              ))}
            </div>
          </div>
        )}

        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-400">
          Individual tests
        </p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((t) => (
            <label
              key={t.id}
              className={`cursor-pointer rounded-md border px-3 py-2 transition ${
                selectedTests.has(t.id)
                  ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500'
                  : 'border-ink-200 hover:border-ink-300'
              }`}
            >
              <input
                type="checkbox"
                name="testId"
                value={t.id}
                checked={selectedTests.has(t.id)}
                onChange={() => toggle(selectedTests, t.id, setSelectedTests)}
                className="sr-only"
              />
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-ink-900">{t.code}</span>
                <span className="numeric text-sm text-ink-700">₹{Number(t.price)}</span>
              </div>
              <p className="mt-0.5 truncate text-xs text-ink-500" title={t.name}>
                {t.name}
              </p>
              {t.tatMinutes && (
                <p className="text-[10px] text-ink-400">
                  TAT {t.tatMinutes < 60 ? `${t.tatMinutes}m` : `${Math.round(t.tatMinutes / 60)}h`}
                </p>
              )}
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 bg-ink-50 p-5">
        <div className="text-sm text-ink-600">
          {selectedTests.size + selectedPanels.size} item
          {selectedTests.size + selectedPanels.size === 1 ? '' : 's'} selected
        </div>
        <Submit total={total} />
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-700">{label}</span>
      <input
        {...props}
        className="w-full rounded-md border border-ink-300 px-3 py-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
      />
      {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
    </label>
  );
}
