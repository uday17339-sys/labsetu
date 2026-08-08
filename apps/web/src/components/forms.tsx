'use client';

import { useFormStatus } from 'react-dom';

/**
 * Shared form primitives.
 *
 * Extracted once the admin, billing and catalog screens landed and started
 * repeating the same input styling five times. Two rules are encoded here
 * rather than left to each caller:
 *
 *   - Every control is at least 44px tall (`h-11`). That is the accessibility
 *     floor for something tapped with a gloved hand at a bench.
 *   - Text inputs are `text-base` on mobile and `text-sm` above `sm`. Anything
 *     under 16px makes iOS Safari zoom on focus, which throws the layout every
 *     time a technician taps a field.
 */

export function Submit({
  label,
  pendingLabel = 'Saving…',
  tone = 'primary',
  full = true,
}: {
  label: string;
  pendingLabel?: string;
  tone?: 'primary' | 'danger' | 'quiet';
  full?: boolean;
}) {
  const { pending } = useFormStatus();
  const tones = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700',
    danger: 'border border-red-300 bg-white text-red-800 hover:bg-red-50',
    quiet: 'border border-ink-300 bg-white text-ink-700 hover:bg-ink-100',
  } as const;

  return (
    <button
      type="submit"
      disabled={pending}
      className={`min-h-11 rounded-md px-4 py-2 text-sm font-medium transition disabled:opacity-60 ${
        full ? 'w-full' : ''
      } ${tones[tone]}`}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

export function Field({
  label,
  name,
  type = 'text',
  required,
  hint,
  defaultValue,
  placeholder,
  inputMode,
  min,
  max,
  step,
  numeric,
  autoComplete = 'off',
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  hint?: string;
  defaultValue?: string | number;
  placeholder?: string;
  inputMode?: 'text' | 'decimal' | 'numeric' | 'tel' | 'email';
  min?: string | number;
  max?: string | number;
  step?: string;
  numeric?: boolean;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-700">
        {label}
        {required && <span className="ml-0.5 text-red-600">*</span>}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        inputMode={inputMode}
        min={min}
        max={max}
        step={step}
        autoComplete={autoComplete}
        className={`h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm ${
          numeric ? 'numeric' : ''
        }`}
      />
      {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
    </label>
  );
}

export function Select({
  label,
  name,
  options,
  required,
  hint,
  defaultValue,
  onChange,
  value,
}: {
  label: string;
  name: string;
  options: { value: string; label: string }[];
  required?: boolean;
  hint?: string;
  defaultValue?: string;
  onChange?: (v: string) => void;
  value?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-700">
        {label}
        {required && <span className="ml-0.5 text-red-600">*</span>}
      </span>
      <select
        name={name}
        required={required}
        defaultValue={onChange ? undefined : defaultValue}
        value={value}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        className="h-11 w-full rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
    </label>
  );
}

export function TextArea({
  label,
  name,
  rows = 3,
  required,
  minLength,
  hint,
  placeholder,
  defaultValue,
}: {
  label: string;
  name: string;
  rows?: number;
  required?: boolean;
  minLength?: number;
  hint?: string;
  placeholder?: string;
  defaultValue?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-700">
        {label}
        {required && <span className="ml-0.5 text-red-600">*</span>}
      </span>
      <textarea
        name={name}
        rows={rows}
        required={required}
        minLength={minLength}
        placeholder={placeholder}
        defaultValue={defaultValue}
        className="w-full rounded-md border border-ink-300 px-2 py-1.5 text-base sm:text-sm"
      />
      {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
    </label>
  );
}
