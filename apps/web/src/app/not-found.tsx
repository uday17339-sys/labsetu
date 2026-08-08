import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-ink-100 text-lg font-semibold text-ink-500">
          ?
        </div>
        <h1 className="mt-4 text-lg font-semibold text-ink-900">Not found</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-600">
          This record does not exist, or it belongs to a different lab. Records are
          isolated per tenant, so a link from one lab will not resolve in another.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link
            href="/samples"
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Find a sample
          </Link>
          <Link
            href="/"
            className="rounded-md border border-ink-300 px-4 py-2 text-sm text-ink-700 hover:bg-ink-100"
          >
            Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
