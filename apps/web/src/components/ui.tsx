import Link from 'next/link';

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  // min-w-0 is load-bearing. A grid/flex child defaults to min-width:auto, so it
  // refuses to shrink below its content's intrinsic width — which silently
  // defeats every `truncate` inside and pushes the page wider than the viewport.
  // This was a real 16px horizontal overflow on a 375px screen.
  return (
    <section className={`min-w-0 rounded-lg border border-ink-200 bg-white ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between border-b border-ink-200 px-4 py-3">
          {title && <h2 className="text-sm font-semibold text-ink-900">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  tone = 'default',
  href,
}: {
  label: string;
  value: string | number;
  tone?: 'default' | 'critical' | 'warn' | 'good';
  href?: string;
}) {
  const tones = {
    default: 'text-ink-900',
    critical: 'text-[var(--color-critical)]',
    warn: 'text-[var(--color-high)]',
    good: 'text-[var(--color-normal)]',
  } as const;

  const body = (
    <div className="rounded-lg border border-ink-200 bg-white px-4 py-3 transition hover:border-ink-300">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold numeric ${tones[tone]}`}>{value}</div>
    </div>
  );

  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

/**
 * Result flag badge.
 *
 * Critical is visually the loudest thing on the screen, by design — it is the
 * one state that requires a person to pick up a phone.
 */
export function FlagBadge({ flag }: { flag: string }) {
  const styles: Record<string, string> = {
    NORMAL: 'bg-ink-100 text-ink-600',
    LOW: 'bg-blue-50 text-[var(--color-low)] ring-1 ring-blue-200',
    HIGH: 'bg-orange-50 text-[var(--color-high)] ring-1 ring-orange-200',
    CRITICAL_LOW: 'bg-[var(--color-critical-bg)] text-[var(--color-critical)] ring-1 ring-red-300 font-bold',
    CRITICAL_HIGH: 'bg-[var(--color-critical-bg)] text-[var(--color-critical)] ring-1 ring-red-300 font-bold',
    ABNORMAL: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  };

  const labels: Record<string, string> = {
    NORMAL: '—',
    LOW: 'L',
    HIGH: 'H',
    CRITICAL_LOW: 'CRITICAL LOW',
    CRITICAL_HIGH: 'CRITICAL HIGH',
    ABNORMAL: 'ABN',
  };

  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs ${styles[flag] ?? styles.NORMAL}`}
    >
      {labels[flag] ?? flag}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    PENDING: 'bg-ink-100 text-ink-600',
    IN_PROGRESS: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
    RESULT_ENTERED: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
    TECH_VERIFIED: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
    AUTHORIZED: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
    REPORTED: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300',
    RERUN: 'bg-orange-50 text-orange-800 ring-1 ring-orange-200',
    CANCELLED: 'bg-ink-100 text-ink-400 line-through',
    REGISTERED: 'bg-ink-100 text-ink-600',
    COLLECTED: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
    RECEIVED: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
    COMPLETED: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
    REJECTED: 'bg-red-50 text-red-700 ring-1 ring-red-200',
    RELEASED: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300',
    DRAFT: 'bg-ink-100 text-ink-600',
    AMENDED: 'bg-orange-50 text-orange-800 ring-1 ring-orange-200',
    // Billing. Unpaid is amber rather than red: money owed is a task, not a
    // safety problem, and red is reserved here for clinical urgency.
    UNPAID: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
    PARTIALLY_PAID: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
    PAID: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
    REFUNDED: 'bg-ink-100 text-ink-600',
    // Users and devices.
    ACTIVE: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
    INACTIVE: 'bg-ink-100 text-ink-500',
    LOCKED: 'bg-red-50 text-red-700 ring-1 ring-red-200',
    ENROLLED: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
    PENDING_ENROLMENT: 'bg-ink-100 text-ink-600',
    DISABLED: 'bg-ink-100 text-ink-400',
    REVOKED: 'bg-red-50 text-red-700 ring-1 ring-red-200',
  };

  return (
    <span
      className={`inline-flex whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${
        styles[status] ?? 'bg-ink-100 text-ink-600'
      }`}
    >
      {status.replace(/_/g, ' ').toLowerCase()}
    </span>
  );
}

export function SourceTag({ source }: { source: string }) {
  // Provenance is always visible: a value someone typed and a value an analyzer
  // produced are different kinds of evidence, and the reader should know which.
  const map: Record<string, { label: string; className: string; title: string }> = {
    MANUAL: {
      label: 'typed',
      className: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
      title: 'Entered by hand',
    },
    INSTRUMENT: {
      label: 'analyzer',
      className: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
      title: 'Captured directly from the analyzer',
    },
    CALCULATED: {
      label: 'calc',
      className: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
      title: 'Derived from other analytes',
    },
    EXTERNAL: {
      label: 'referral',
      className: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
      title: 'Received from an outsourced lab',
    },
  };
  const s = map[source] ?? map.MANUAL!;
  return (
    <span title={s.title} className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${s.className}`}>
      {s.label}
    </span>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-4 py-12 text-center">
      <p className="text-sm font-medium text-ink-600">{title}</p>
      {hint && <p className="mt-1 text-sm text-ink-400">{hint}</p>}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
    >
      {message}
    </div>
  );
}
