'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/**
 * Active-state navigation. Client components because they need the current
 * pathname; the layout that renders them stays a server component.
 */

/**
 * `/` matches only itself; everything else matches its own subtree.
 *
 * The subtree check is on a path SEGMENT boundary, not a bare prefix. A prefix
 * check lights up "Reports" while you are on /reports-archive, and once
 * /critical existed alongside /critical-values the bug would have been visible.
 */
function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = isActive(pathname, href);

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition ${
        active ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
      }`}
    >
      {label}
    </Link>
  );
}

const ICONS: Record<string, React.ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5" />,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  plus: <path d="M12 5v14M5 12h14" />,
  scan: (
    <>
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
      <path d="M7 12h10" />
    </>
  ),
  shield: <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z" />,
  chart: <path d="M3 3v18h18M7 15l4-4 3 3 5-6" />,
  box: <path d="M21 8v8a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8ZM3.3 7 12 12l8.7-5M12 22V12" />,
  rupee: <path d="M6 4h12M6 9h12M15 4c0 5-3.5 6-9 6M7 10l9 10" />,
  doc: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  alert: (
    <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
  ),
  people: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    </>
  ),
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </>
  ),
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
};

function Icon({ name }: { name: string }) {
  return (
    <svg
      // shrink-0: once the tab is allowed to shrink (min-w-0), the icon would
      // otherwise be squashed before the text truncates.
      className="h-5 w-5 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name] ?? ICONS.home}
    </svg>
  );
}

export function BottomNavLink({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: string;
}) {
  const pathname = usePathname();
  const active = isActive(pathname, href);

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      // min-h-14 keeps the touch target comfortable vertically.
      //
      // min-w-0 is what lets flex-1 actually shrink. A flex item defaults to
      // min-width:auto, so it will not go narrower than its content — six tabs
      // held themselves at ~83px each and pushed the whole document 175px wide
      // on a 320px phone. With min-w-0 they divide the space they have, and the
      // label truncates rather than the page scrolling sideways.
      className={`flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 py-2 text-[11px] font-medium transition ${
        active ? 'text-brand-600' : 'text-ink-500'
      }`}
    >
      <Icon name={icon} />
      <span className="w-full truncate text-center">{label}</span>
    </Link>
  );
}

export interface NavItem {
  href: string;
  label: string;
  short: string;
  icon: string;
}

/**
 * Overflow navigation.
 *
 * The app outgrew a single row of tabs once billing, analytics, staff, reports,
 * critical values and instruments landed. Eleven tabs in a phone's bottom bar
 * makes every one of them too small to hit reliably, and a desktop bar that
 * wraps to two lines reads as broken. The five daily destinations stay visible;
 * the rest live behind this.
 */
export function MoreMenu({ items, label = 'More' }: { items: NavItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  // A route change closes the menu; otherwise it hangs open over the new page.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent | TouchEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (items.length === 0) return null;

  const anyActive = items.some((i) => isActive(pathname, i.href));

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition ${
          anyActive ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
        }`}
      >
        {label} ▾
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-40 mt-1 min-w-52 overflow-hidden rounded-lg border border-ink-200 bg-white py-1 shadow-lg"
        >
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              role="menuitem"
              aria-current={isActive(pathname, item.href) ? 'page' : undefined}
              className={`flex min-h-11 items-center gap-2.5 px-3 py-2 text-sm transition ${
                isActive(pathname, item.href)
                  ? 'bg-ink-100 font-medium text-ink-900'
                  : 'text-ink-700 hover:bg-ink-50'
              }`}
            >
              <Icon name={item.icon} />
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** The same overflow list, as a bottom sheet for the mobile tab bar. */
export function MoreTab({ items }: { items: NavItem[] }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => setOpen(false), [pathname]);

  if (items.length === 0) return null;

  const anyActive = items.some((i) => isActive(pathname, i.href));

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        className={`flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium transition ${
          anyActive ? 'text-brand-600' : 'text-ink-500'
        }`}
      >
        <Icon name="more" />
        More
      </button>

      {open && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-label="More sections">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/30"
          />
          <div className="absolute inset-x-0 bottom-0 rounded-t-xl border-t border-ink-200 bg-white pb-[env(safe-area-inset-bottom)]">
            <div className="mx-auto my-2 h-1 w-10 rounded-full bg-ink-200" aria-hidden="true" />
            <ul className="max-h-[60vh] divide-y divide-ink-100 overflow-y-auto pb-2">
              {items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={isActive(pathname, item.href) ? 'page' : undefined}
                    className={`flex min-h-14 items-center gap-3 px-5 py-3 text-sm ${
                      isActive(pathname, item.href)
                        ? 'font-medium text-brand-600'
                        : 'text-ink-800'
                    }`}
                  >
                    <Icon name={item.icon} />
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
