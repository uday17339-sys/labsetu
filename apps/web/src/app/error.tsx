'use client';

import { useEffect } from 'react';

/**
 * Route-level error boundary.
 *
 * Shows a calm, branded page instead of a stack trace. Two rules for a clinical
 * system: never surface internal detail (it can disclose schema or patient
 * data), and always surface the request id so a lab can report a fault without
 * describing what they were doing with a patient.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // In production this goes to Sentry/OTel. The digest correlates to the
    // server-side log entry that holds the real detail.
    console.error('Render error:', error.digest ?? error.message);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-red-50 text-xl text-[var(--color-critical)]">
          !
        </div>
        <h1 className="mt-4 text-lg font-semibold text-ink-900">Something went wrong</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-600">
          The page could not be loaded. No data was changed — LabSetu rolls back any
          incomplete operation.
        </p>
        {error.digest && (
          <p className="mt-3 text-xs text-ink-400">
            Reference <code className="numeric rounded bg-ink-100 px-1.5 py-0.5">{error.digest}</code>
          </p>
        )}
        <div className="mt-6 flex justify-center gap-3">
          <button
            onClick={reset}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Try again
          </button>
          <a
            href="/"
            className="rounded-md border border-ink-300 px-4 py-2 text-sm text-ink-700 hover:bg-ink-100"
          >
            Back to dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
