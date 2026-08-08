'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionResult } from './actions';

function Submit({ label, tone = 'primary' }: { label: string; tone?: 'primary' | 'danger' | 'ghost' }) {
  const { pending } = useFormStatus();
  const tones = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700',
    danger: 'bg-[var(--color-critical)] text-white hover:brightness-110',
    ghost: 'border border-ink-300 text-ink-700 hover:bg-ink-100',
  } as const;

  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-md px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${tones[tone]}`}
    >
      {pending ? 'Working…' : label}
    </button>
  );
}

function Feedback({ state }: { state: ActionResult | null }) {
  if (!state?.message) return null;
  return (
    <p
      role={state.ok ? 'status' : 'alert'}
      className={`rounded-md px-3 py-2 text-sm ${
        state.ok
          ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200'
          : 'bg-red-50 text-red-800 ring-1 ring-red-200'
      }`}
    >
      {state.message}
    </p>
  );
}

export function ResultEntryForm({
  action,
  analytes,
  existing,
  interpretation,
  readOnly,
}: {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  analytes: {
    id: string;
    code: string;
    name: string;
    valueType: string;
    defaultUnit: string | null;
    allowedValues: string[];
    refDisplay: string | null;
  }[];
  existing: Record<string, string>;
  interpretation: string | null;
  readOnly: boolean;
}) {
  const [state, formAction] = useActionState(action, null);

  return (
    <form action={formAction} className="space-y-4">
      {/*
        A list of responsive rows rather than a table. On a phone each analyte
        stacks with a full-width input; from `sm` up it lays out in columns and
        reads like a worksheet. A real <table> could not do both without
        horizontal scrolling, and this screen is used at the bench.
      */}
      <div className="hidden border-b border-ink-200 px-4 py-2 text-xs uppercase tracking-wide text-ink-500 sm:grid sm:grid-cols-[1fr_11rem_5rem_9rem] sm:gap-3">
        <span className="font-medium">Analyte</span>
        <span className="font-medium">Result</span>
        <span className="font-medium">Unit</span>
        <span className="font-medium">Reference</span>
      </div>

      <ul className="divide-y divide-ink-100">
        {analytes.map((a) => (
          <li
            key={a.id}
            className="min-w-0 px-4 py-3 sm:grid sm:grid-cols-[minmax(0,1fr)_11rem_5rem_9rem] sm:items-center sm:gap-3 sm:py-2"
          >
            <label htmlFor={`value:${a.id}`} className="block min-w-0">
              <span className="block font-medium text-ink-900">{a.name}</span>
              <span className="block text-xs text-ink-400">{a.code}</span>
            </label>

            {/*
              min-w-0 on the wrapper AND the select.

              A <select> takes its intrinsic width from its LONGEST option, and
              min-width:auto stops it shrinking below that. A pharmacopoeial
              description like "White to off-white crystalline powder" made the
              control 449px wide and pushed a 320px page 175px sideways. With
              min-w-0 it fills the column it is given and truncates instead.
            */}
            <div className="mt-1.5 min-w-0 sm:mt-0">
              {a.valueType === 'QUALITATIVE' && a.allowedValues.length > 0 ? (
                <select
                  id={`value:${a.id}`}
                  name={`value:${a.id}`}
                  defaultValue={existing[a.id] ?? ''}
                  disabled={readOnly}
                  // h-11 on mobile: a 44px touch target.
                  className="h-11 w-full min-w-0 rounded-md border border-ink-300 px-2 text-sm disabled:bg-ink-50 sm:h-9"
                >
                  <option value="">—</option>
                  {a.allowedValues.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`value:${a.id}`}
                  name={`value:${a.id}`}
                  defaultValue={existing[a.id] ?? ''}
                  disabled={readOnly}
                  // Not type=number: "<0.01" and "NEGATIVE" are legitimate
                  // results and a numeric input would reject them. inputMode
                  // still brings up the numeric keypad on a phone.
                  inputMode={a.valueType === 'TEXT' ? 'text' : 'decimal'}
                  autoComplete="off"
                  placeholder={a.valueType === 'NUMERIC_BOUNDED' ? 'e.g. <0.01' : ''}
                  className="numeric h-11 w-full rounded-md border border-ink-300 px-2 text-base focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-ink-50 sm:h-9 sm:text-sm"
                />
              )}
            </div>

            <div className="mt-1 text-xs text-ink-500 sm:mt-0 sm:text-sm">
              <span className="sm:hidden">Unit: </span>
              {a.defaultUnit ?? '—'}
            </div>

            <div className="numeric mt-0.5 text-xs text-ink-500 sm:mt-0">
              <span className="sm:hidden">Reference: </span>
              {a.refDisplay ?? '—'}
            </div>
          </li>
        ))}
      </ul>

      {!readOnly && (
        <div className="space-y-3 px-4 pb-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink-700">
              Interpretation <span className="font-normal text-ink-400">(optional)</span>
            </span>
            <textarea
              name="interpretation"
              defaultValue={interpretation ?? ''}
              rows={2}
              className="w-full rounded-md border border-ink-300 px-3 py-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              placeholder="Printed under this test on the report"
            />
          </label>
          <Feedback state={state} />
          <Submit label="Save results" />
        </div>
      )}
    </form>
  );
}

export function VerifyForm({
  action,
}: {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="space-y-3">
      <p className="text-sm text-ink-600">
        Technical verification confirms the values are analytically sound. A second,
        differently-qualified person still has to authorise them for release.
      </p>
      <input
        name="note"
        placeholder="Note (optional)"
        className="w-full rounded-md border border-ink-300 px-3 py-2 text-sm"
      />
      <Feedback state={state} />
      <Submit label="Verify results" />
    </form>
  );
}

export function AuthorizeForm({
  action,
  mfaEnabled,
}: {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  mfaEnabled: boolean;
}) {
  const [state, formAction] = useActionState(action, null);

  return (
    <form action={formAction} className="space-y-3">
      <div className="rounded-md border border-ink-200 bg-ink-50 px-3 py-2 text-xs text-ink-600">
        <p className="font-medium text-ink-800">This is an electronic signature.</p>
        <p className="mt-1 leading-relaxed">
          Re-entering your password signs these exact values. If anything changes
          after you sign, the signature no longer matches and the system will say so.
          Your name, qualification and registration number will appear on the report.
        </p>
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="w-full rounded-md border border-ink-300 px-3 py-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      </label>

      {mfaEnabled && (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">Authentication code</span>
          <input
            name="totpCode"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            required
            autoComplete="one-time-code"
            className="numeric w-32 rounded-md border border-ink-300 px-3 py-2 text-sm"
          />
        </label>
      )}

      <input
        name="note"
        placeholder="Note (optional)"
        className="w-full rounded-md border border-ink-300 px-3 py-2 text-sm"
      />

      <Feedback state={state} />
      <Submit label="Sign & authorise" />
    </form>
  );
}

export function RerunForm({
  action,
}: {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <details className="rounded-lg border border-ink-200 bg-white">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink-700">
        Request a re-run
      </summary>
      <form action={formAction} className="space-y-3 border-t border-ink-200 px-4 py-3">
        <p className="text-xs text-ink-500">
          Previous values are retained in the record, never deleted. The reason is
          recorded in the audit trail.
        </p>
        <textarea
          name="reason"
          rows={2}
          required
          minLength={10}
          placeholder="e.g. Lipaemic sample suspected, repeating after ultracentrifugation"
          className="w-full rounded-md border border-ink-300 px-3 py-2 text-sm"
        />
        <Feedback state={state} />
        <Submit label="Mark for re-run" tone="ghost" />
      </form>
    </details>
  );
}
