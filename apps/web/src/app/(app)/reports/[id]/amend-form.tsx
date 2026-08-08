'use client';

import { useState } from 'react';
import { useFormStatus } from 'react-dom';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-11 w-full rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-orange-700 disabled:opacity-60"
    >
      {pending ? 'Amending…' : 'Sign & amend'}
    </button>
  );
}

/**
 * Amending a released report.
 *
 * Deliberately behind a confirmation step rather than sitting open on the page.
 * This is not an edit — the released version is preserved exactly as the patient
 * received it and a superseding version is issued, which means anyone holding
 * the old printout has a document the lab has since corrected. That is a phone
 * call to the clinician, not a click.
 */
export function AmendForm({
  action,
  mfaEnabled,
}: {
  action: (fd: FormData) => Promise<void>;
  mfaEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="p-4">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="min-h-11 w-full rounded-md border border-orange-300 bg-white px-4 py-2 text-sm font-medium text-orange-800 transition hover:bg-orange-50"
        >
          Amend this report
        </button>
        <p className="mt-2 text-xs text-ink-400">
          Issues a corrected version. The released one is kept exactly as the patient received
          it.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3 p-4">
      <div className="rounded-md border border-orange-200 bg-orange-50 px-3 py-2 text-xs leading-relaxed text-orange-900">
        The patient and the referring clinician may already be acting on the released version.
        Amending supersedes it — tell them directly as well as reissuing.
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">
          Reason for amendment<span className="ml-0.5 text-red-600">*</span>
        </span>
        <textarea
          name="reason"
          rows={3}
          required
          minLength={10}
          placeholder="e.g. Haemoglobin transcribed incorrectly from the analyzer printout; corrected on review against the instrument log."
          className="w-full rounded-md border border-ink-300 px-2 py-1.5 text-base sm:text-sm"
        />
        <span className="mt-1 block text-xs text-ink-400">
          Printed on the amended report and written to the audit trail.
        </span>
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">Password</span>
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="h-11 w-full rounded-md border border-ink-300 px-3 text-base sm:text-sm"
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
            className="numeric h-11 w-32 rounded-md border border-ink-300 px-3 text-base sm:text-sm"
          />
        </label>
      )}

      <Submit />
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="min-h-11 w-full rounded-md px-4 py-2 text-sm text-ink-500 hover:bg-ink-100"
      >
        Cancel
      </button>
    </form>
  );
}
