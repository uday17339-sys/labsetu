'use client';

/**
 * Last-resort boundary: catches failures in the root layout itself, where the
 * normal error boundary cannot run. It must render its own <html> and <body>
 * and cannot rely on any app CSS having loaded, so the styles are inline.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
          background: '#f6f7f9',
          color: '#323947',
        }}
      >
        <div style={{ maxWidth: 420, padding: 24, textAlign: 'center' }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 8px' }}>
            LabSetu could not start
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: '#647591', margin: '0 0 16px' }}>
            A fault occurred before the application could load. No data was changed.
          </p>
          {error.digest && (
            <p style={{ fontSize: 12, color: '#8493ab', margin: '0 0 16px' }}>
              Reference {error.digest}
            </p>
          )}
          <button
            onClick={reset}
            style={{
              background: '#1f63c9',
              color: 'white',
              border: 0,
              borderRadius: 6,
              padding: '9px 16px',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
