'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * A progress bar across the top of the screen while a navigation is in flight.
 *
 * Server components stream, so between a tap and the new screen appearing there
 * is a window where nothing on the page changes. On a fast connection that is
 * imperceptible; on a plant floor over 4G it is long enough for someone to tap
 * again, and a second tap on "Sign & authorise" is not a harmless mistake.
 *
 * This exists rather than a loading.tsx per route because a loading.tsx creates
 * a Suspense boundary, which flushes the HTML shell and the HTTP status with it.
 * Any route that calls notFound() would then answer 200 for a missing record.
 * Thirteen detail routes in this app call notFound(), so they cannot have one —
 * and they are exactly the screens reached by tapping a row in a list.
 *
 * Driven by real navigation events rather than a router hook: it arms on a click
 * of a same-origin link or a GET form submit, and disarms when the pathname or
 * query actually changes. That way it reflects what the router did, not what a
 * component thinks it asked for.
 */
export function NavigationProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [active, setActive] = useState(false);

  // The route settled — whatever we were waiting for has arrived.
  useEffect(() => {
    setActive(false);
  }, [pathname, searchParams]);

  useEffect(() => {
    const isModified = (e: MouseEvent) =>
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey;

    function onClick(e: MouseEvent) {
      if (isModified(e)) return;

      const anchor = (e.target as Element | null)?.closest?.('a');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;

      const href = anchor.getAttribute('href');
      // Anchors without an href, and in-page jumps, are not navigations.
      if (!href || href.startsWith('#')) return;

      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      // Downloads (the CSV exports) leave the SPA entirely and never resolve
      // into a pathname change, so the bar would hang.
      if (url.origin !== window.location.origin) return;
      if (url.pathname.startsWith('/api/')) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }

      setActive(true);
    }

    // The filter forms on the list screens are GET forms: they navigate too.
    // Server-action forms are excluded — those have their own button-level
    // pending state, and showing both reads as two things happening.
    function onSubmit(e: SubmitEvent) {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      if ((form.method || 'get').toLowerCase() !== 'get') return;
      setActive(true);
    }

    // Back/forward resolve through the same pathname effect, but arming here
    // means the bar appears immediately rather than after the round trip.
    function onPopState() {
      setActive(true);
    }

    document.addEventListener('click', onClick, true);
    document.addEventListener('submit', onSubmit, true);
    window.addEventListener('popstate', onPopState);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('submit', onSubmit, true);
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  // A navigation that never resolves — a download that slipped through, or a
  // request that failed — must not leave the bar running forever. A stuck
  // progress bar is worse than none: it says the system is still trying.
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => setActive(false), 15_000);
    return () => window.clearTimeout(timer);
  }, [active]);

  if (!active) return null;

  return (
    <div
      className="no-print pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden bg-brand-100"
      role="progressbar"
      aria-label="Loading page"
      // Indeterminate: we know something is in flight, not how far along it is,
      // and inventing a percentage would be a lie the user can feel.
      aria-valuetext="Loading"
    >
      <div className="nav-progress-bar h-full w-2/5 bg-brand-600" />
    </div>
  );
}
