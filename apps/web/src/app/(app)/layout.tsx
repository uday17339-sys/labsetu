import Link from 'next/link';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getSessionUser, clearSession, can } from '@/lib/session';
import { NavLink, BottomNavLink, MoreMenu, MoreTab, type NavItem } from '@/components/nav';
import { isPharma } from '@/lib/vertical';
import { NavigationProgress } from '@/components/navigation-progress';
import { PendingButton } from '@/components/pending-button';

export const dynamic = 'force-dynamic';

async function signOut(): Promise<void> {
  'use server';
  await clearSession();
  redirect('/login');
}

/**
 * Navigation.
 *
 * Desktop gets a top bar. Mobile gets a bottom tab bar, because lab staff use
 * this one-handed while holding a sample tube — the bottom of the screen is the
 * only comfortably thumb-reachable area on a modern phone.
 *
 * PRIMARY is what someone touches every shift and is always visible. SECONDARY
 * is real work but occasional — billing runs at the counter, staff and catalog
 * changes happen monthly — so it sits behind an overflow menu rather than
 * shrinking eleven tabs until none of them can be hit.
 *
 * Both lists are permission-filtered, so a phlebotomist sees four tabs and no
 * overflow at all rather than a menu full of things they cannot open.
 */
const PRIMARY = [
  { href: '/', label: 'Dashboard', short: 'Home', icon: 'home', permission: null },
  { href: '/worklist', label: 'Worklist', short: 'Work', icon: 'list', permission: 'result:read' },
  // Pharma: the stores bench and QA release desk are daily screens. Patient
  // registration is not a thing that happens in a plant.
  { href: '/stores', label: 'Stores', short: 'Stores', icon: 'box', permission: 'stores:read' },
  { href: '/samples', label: 'Samples', short: 'Scan', icon: 'scan', permission: 'sample:read' },
  {
    href: '/qa',
    label: 'QA release',
    short: 'QA',
    icon: 'shield',
    permission: 'batch:disposition',
  },
] as const;

/** Screens that only make sense for a diagnostics deployment. */
const DIAGNOSTICS_ONLY = new Set([
  '/register',
  '/patients',
  '/critical',
  '/billing',
  '/analytics',
  // The patient report register. A plant issues certificates of analysis
  // instead, and /reports would render an permanently empty list beside them.
  '/reports',
]);

/** Screens that only make sense for a pharma manufacturing deployment. */
const PHARMA_ONLY = new Set(['/coa', '/specifications', '/quality']);

const SECONDARY = [
  // Occasional but real work. Entries in DIAGNOSTICS_ONLY are dropped entirely
  // on a pharma deployment rather than merely demoted.
  {
    href: '/register',
    label: 'Register',
    short: 'New',
    icon: 'plus',
    permission: 'order:create',
  },
  {
    href: '/critical',
    label: 'Critical results',
    short: 'Critical',
    icon: 'alert',
    permission: 'result:read',
  },
  {
    href: '/specifications',
    label: 'Specifications',
    short: 'Specs',
    icon: 'doc',
    permission: 'spec:read',
  },
  {
    href: '/patients',
    label: 'Patients',
    short: 'Patients',
    icon: 'people',
    permission: 'patient:read',
  },
  { href: '/reports', label: 'Reports', short: 'Reports', icon: 'doc', permission: 'report:read' },
  {
    href: '/quality',
    label: 'Quality system',
    short: 'Quality',
    icon: 'shield',
    permission: 'deviation:read',
  },
  {
    href: '/coa',
    label: 'Certificates',
    short: 'CoA',
    icon: 'doc',
    permission: 'stores:read',
  },
  { href: '/billing', label: 'Billing', short: 'Billing', icon: 'rupee', permission: 'invoice:read' },
  {
    href: '/analytics',
    label: 'Revenue & analytics',
    short: 'Revenue',
    icon: 'chart',
    permission: 'analytics:read',
  },
  { href: '/qc', label: 'Quality control', short: 'QC', icon: 'chart', permission: 'qc:read' },
  { href: '/inventory', label: 'Stock', short: 'Stock', icon: 'box', permission: 'inventory:read' },
  {
    href: '/devices',
    label: 'Instruments',
    short: 'Devices',
    icon: 'cpu',
    permission: 'device:read',
  },
  {
    href: '/admin',
    label: 'Staff & competency',
    short: 'Staff',
    icon: 'people',
    permission: 'user:read',
  },
  { href: '/audit', label: 'Audit trail', short: 'Audit', icon: 'shield', permission: 'audit:read' },
] as const;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const hidden = isPharma ? DIAGNOSTICS_ONLY : PHARMA_ONLY;

  // Two filters, doing different jobs. Permission answers "may this person open
  // it"; vertical answers "does this screen exist in this product at all". An
  // administrator holds every permission, so without the second filter they
  // would still be shown patient registration on a pharma deployment.
  const visible = (item: { href: string; permission: string | null }) =>
    !hidden.has(item.href) && (!item.permission || can(user, item.permission));

  const primary: NavItem[] = PRIMARY.filter(visible);
  const secondary: NavItem[] = SECONDARY.filter(visible);

  return (
    <div className="min-h-screen">
      {/*
        Suspense because it reads the query string, and useSearchParams opts the
        subtree into client rendering. Without the boundary that would push the
        whole layout — nav, header, every screen — out of static rendering.
      */}
      <Suspense fallback={null}>
        <NavigationProgress />
      </Suspense>

      <header className="no-print sticky top-0 z-30 border-b border-ink-200 bg-white">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-4 px-3 sm:px-4">
          <Link href="/" className="flex min-h-11 shrink-0 items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-md bg-brand-600 text-sm font-bold text-white">
              LS
            </div>
            <span className="hidden font-semibold text-ink-900 sm:inline">LabSetu</span>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden items-center gap-1 md:flex">
            {primary.map((item) => (
              <NavLink key={item.href} href={item.href} label={item.label} />
            ))}
            <MoreMenu items={secondary} />
          </nav>

          <div className="ml-auto flex min-w-0 items-center gap-3">
            <div className="min-w-0 text-right">
              <div className="truncate text-sm font-medium leading-tight text-ink-900">
                {user.fullName}
              </div>
              <div className="truncate text-xs leading-tight text-ink-500">
                {user.roles[0]?.replace(/_/g, ' ').toLowerCase()}
                <span className="hidden sm:inline"> · {user.tenantName}</span>
              </div>
            </div>
            <form action={signOut}>
              <PendingButton
                aria-label="Sign out"
                // 44px minimum touch target — the accessibility floor for a
                // control someone taps with a gloved hand.
                className="grid h-11 w-11 place-items-center rounded-md border border-ink-300 text-ink-700 transition hover:bg-ink-100 sm:h-auto sm:w-auto sm:px-3 sm:py-1.5"
              >
                <span className="hidden sm:inline text-sm">Sign out</span>
                <svg
                  className="h-5 w-5 sm:hidden"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                </svg>
              </PendingButton>
            </form>
          </div>
        </div>
      </header>

      {/*
        Bottom padding must clear the tab bar wherever that bar is visible —
        i.e. everywhere below `md`, which includes a phone in LANDSCAPE at
        ~667px wide.

        `sm:py-6` would reset padding-bottom to 24px at ≥640px, leaving content
        hidden behind a 57px bar on exactly that landscape case. So the vertical
        padding is set per-side: only `md:pb-6` (where the bar is hidden) is
        allowed to shrink it.
      */}
      <main className="mx-auto max-w-[1600px] px-3 pt-5 pb-24 sm:px-4 sm:pt-6 sm:pb-24 md:pb-6">
        {children}
      </main>

      {/* Mobile bottom tab bar */}
      <nav
        className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-ink-200 bg-white md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        aria-label="Main"
      >
        <div className="mx-auto flex max-w-lg">
          {primary.map((item) => (
            <BottomNavLink
              key={item.href}
              href={item.href}
              label={item.short}
              icon={item.icon}
            />
          ))}
          <MoreTab items={secondary} />
        </div>
      </nav>
    </div>
  );
}
