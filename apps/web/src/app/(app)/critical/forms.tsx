'use client';

import { useState } from 'react';
import { Submit } from '@/components/forms';

/**
 * Logging the callback.
 *
 * The read-back field is the whole point. Repeating the value and the patient's
 * name back to the lab is the control that catches a misheard number, and NABL
 * asks for evidence of it. The suggested text is pre-filled with the actual
 * value so the person on the phone reads the right thing — but it stays
 * editable, because what the clinician actually said is what must be recorded.
 */
export function CallbackForm({
  action,
  suggestion,
  defaultRecipient,
}: {
  action: (fd: FormData) => Promise<void>;
  suggestion: string;
  defaultRecipient: string | null;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-11 rounded-md bg-[var(--color-critical)] px-3 py-2 text-sm font-medium text-white hover:opacity-90"
      >
        Log callback
      </button>
    );
  }

  return (
    <form action={action} className="mt-3 space-y-3 rounded-md border border-red-200 bg-white p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">
            Person notified<span className="ml-0.5 text-red-600">*</span>
          </span>
          <input
            name="notifiedTo"
            required
            minLength={3}
            defaultValue={defaultRecipient ?? ''}
            placeholder="Dr Anil Kumar"
            className="h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
          />
          <span className="mt-1 block text-xs text-ink-400">
            Name them. &ldquo;The ward&rdquo; is not evidence.
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">How</span>
          <select
            name="method"
            className="h-11 w-full rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
          >
            <option value="PHONE">Telephone</option>
            <option value="IN_PERSON">In person</option>
            <option value="SECURE_MESSAGE">Secure message</option>
            <option value="EMAIL">Email</option>
          </select>
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">
          Read-back confirmation<span className="ml-0.5 text-red-600">*</span>
        </span>
        <textarea
          name="readBack"
          rows={2}
          required
          minLength={3}
          defaultValue={suggestion}
          className="w-full rounded-md border border-ink-300 px-2 py-1.5 text-base sm:text-sm"
        />
        <span className="mt-1 block text-xs text-ink-400">
          What the clinician repeated back. Edit if they said something different.
        </span>
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">Note</span>
        <input
          name="note"
          placeholder="e.g. Patient recalled for repeat sample"
          className="h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
        />
      </label>

      <div className="flex gap-2">
        <Submit label="Record the call" full={false} />
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
