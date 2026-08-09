'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * The submit button on a list screen's filter form.
 *
 * These forms are plain GET navigations, not server actions, so useFormStatus
 * reports nothing about them — which is why every search button in the app sat
 * inert while the query ran. On a register with thousands of rows behind a
 * search that is several seconds of a screen that looks like it ignored you.
 *
 * State clears when the route settles, which for a GET filter means the query
 * string changing. Re-submitting the same filters produces no change for that
 * to observe, so a timeout releases the button rather than leaving it disabled
 * on a screen whose data is already correct.
 */
export function FilterSubmit({ label = 'Search' }: { label?: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, setPending] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setPending(false);
  }, [pathname, searchParams]);

  // Listen on the FORM, not for a click on this button. Typing a batch number
  // and hitting Enter is how a search box is actually used, and that submits
  // the form without the button ever being clicked — so an onClick handler
  // leaves the commonest path with no feedback at all.
  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const onSubmit = () => setPending(true);
    form.addEventListener('submit', onSubmit);
    return () => form.removeEventListener('submit', onSubmit);
  }, []);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setPending(false), 8000);
    return () => window.clearTimeout(timer);
  }, [pending]);

  return (
    <button
      ref={ref}
      type="submit"
      disabled={pending}
      className="flex min-h-11 items-center justify-center gap-2 rounded-md bg-brand-600 px-4 text-sm font-medium text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-70"
    >
      {pending && (
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
          <path
            d="M22 12a10 10 0 0 1-10 10"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      )}
      {pending ? 'Searching…' : label}
    </button>
  );
}
