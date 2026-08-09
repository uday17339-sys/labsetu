/**
 * Loading skeleton for Certificates.
 *
 * On a list route only. A loading.tsx opens a Suspense boundary, which flushes
 * the HTML shell — and the HTTP status with it — before the body resolves, so a
 * route that can call notFound() must not have one or a missing record would
 * answer 200. This route always renders a list, empty or not.
 *
 * The shape matches the real screen so the page does not jump when data lands.
 */
export default function Loading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading certificates">
      <div className="space-y-2">
        <div className="h-6 w-48 animate-pulse rounded bg-ink-200" />
        <div className="h-4 w-80 max-w-full animate-pulse rounded bg-ink-100" />
      </div>

      <div className="rounded-lg border border-ink-200 bg-white">
        <div className="flex flex-wrap gap-2 border-b border-ink-100 px-4 py-3">
          <div className="h-11 w-64 max-w-full animate-pulse rounded-md bg-ink-100" />
          <div className="h-11 w-24 animate-pulse rounded-md bg-ink-100" />
        </div>
        <div className="divide-y divide-ink-100">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <div className="h-4 w-32 shrink-0 animate-pulse rounded bg-ink-100" />
              <div className="h-4 flex-1 animate-pulse rounded bg-ink-100" />
              <div className="hidden h-4 w-24 animate-pulse rounded bg-ink-100 sm:block" />
              <div className="h-6 w-20 shrink-0 animate-pulse rounded-full bg-ink-100" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
