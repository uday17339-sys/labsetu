'use client';

/** Opens the browser print dialog against the print stylesheet. */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="no-print min-h-11 rounded-md border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-100"
    >
      Print certificate
    </button>
  );
}
