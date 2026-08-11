/**
 * Interpreting a date-only bound the way a person means it.
 *
 * "From 1 August to 12 August" means the whole of the 12th. Parsed literally,
 * `new Date('2026-08-12')` is midnight at the START of that day, so a review or
 * a report bounded by it silently excludes everything that happened today —
 * which is usually the part the reader most wants to see.
 *
 * This was a real defect rather than a hypothetical: an audit review requested
 * for the last thirty days returned zero entries, because every entry had been
 * written on the day the review was run.
 *
 * Only date-only strings are adjusted. A caller who supplies a full timestamp
 * has said exactly what they mean and is left alone.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function endOfDay(input: string | undefined, fallback: Date = new Date()): Date {
  if (!input) return fallback;
  if (DATE_ONLY.test(input)) return new Date(`${input}T23:59:59.999Z`);
  return new Date(input);
}

export function startOfDay(input: string | undefined, fallback: Date): Date {
  if (!input) return fallback;
  if (DATE_ONLY.test(input)) return new Date(`${input}T00:00:00.000Z`);
  return new Date(input);
}
