/**
 * Display formatting.
 *
 * Rupees use the Indian digit grouping (1,00,000 — not 100,000). Getting that
 * wrong is immediately visible to every Indian user and reads as software
 * written for somewhere else.
 */
export function money(n: number): string {
  return `₹${n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Compact form for dashboard tiles, where two decimals are noise. */
export function moneyShort(n: number): string {
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

export function date(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString('en-IN') : '—';
}

export function dateTime(iso: string | null | undefined): string {
  return iso
    ? new Date(iso).toLocaleString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
}

/** "2 h 15 m" — how long something has been waiting. */
export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} m` : `${h} h`;
}
