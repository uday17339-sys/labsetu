/**
 * Loading skeleton for the list screens.
 *
 * Deliberately NOT placed at the (app) segment root. A loading.tsx creates a
 * Suspense boundary, which flushes the HTML shell — and the HTTP status with it
 * — before the page body resolves. Any child route that then calls notFound()
 * can no longer set 404, so a missing record would answer 200 and mislead every
 * uptime monitor and integration reading the status.
 *
 * So: skeletons on the list routes (which never call notFound), correct status
 * codes on the detail routes (which do).
 */
/**
 * Skeleton shown while a server component streams.
 *
 * A worklist query on a busy lab can take a beat; a blank screen reads as
 * "broken" to someone standing at a bench, so the shape appears immediately.
 */
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <div className="space-y-2">
        <div className="h-6 w-56 animate-pulse rounded bg-ink-200" />
        <div className="h-4 w-72 animate-pulse rounded bg-ink-100" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-ink-200 bg-white px-4 py-3">
            <div className="h-3 w-20 animate-pulse rounded bg-ink-100" />
            <div className="mt-2 h-7 w-12 animate-pulse rounded bg-ink-200" />
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-ink-200 bg-white">
        <div className="border-b border-ink-200 px-4 py-3">
          <div className="h-4 w-32 animate-pulse rounded bg-ink-200" />
        </div>
        <div className="divide-y divide-ink-100">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <div className="h-4 w-32 animate-pulse rounded bg-ink-100" />
              <div className="h-4 flex-1 animate-pulse rounded bg-ink-100" />
              <div className="h-4 w-20 animate-pulse rounded bg-ink-100" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
