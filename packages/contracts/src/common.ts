import { z } from 'zod';

export const uuidSchema = z.string().uuid();

/** Cursor pagination. Offset pagination degrades badly on the worklist tables. */
export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const paginatedResult = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().optional(),
  });

/**
 * Canonical form for an Indian mobile number: +91XXXXXXXXXX.
 *
 * THE SINGLE DEFINITION. Storage, blind-index generation and search must all
 * call this — a blind index built over inconsistently-formatted input silently
 * fails to match, and the symptom is "patient not found" rather than anything
 * that looks like a bug.
 *
 * Strips every non-digit and keeps the last 10, so it survives "+91 98480
 * 99887", "098480-99887", "9848099887", and a query string where `+` has
 * decoded to a space.
 */
export function normaliseIndianPhone(value: string): string {
  const last10 = value.replace(/\D/g, '').slice(-10);
  return `+91${last10}`;
}

export const indianPhoneSchema = z
  .string()
  .trim()
  .refine(
    (v) => /^[6-9]\d{9}$/.test(v.replace(/\D/g, '').slice(-10)),
    'Enter a valid 10-digit Indian mobile number',
  )
  .transform(normaliseIndianPhone);

export const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}Z[A-Z\d]{1}$/,
    'Enter a valid 15-character GSTIN',
  );

export const pincodeSchema = z.string().trim().regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code');

/**
 * A reason string that regulators expect to be meaningful. Rejecting "asdf" is
 * not possible, but rejecting "" and "ok" removes the laziest cases — and the
 * field being mandatory at all is the substantive control.
 */
export const reasonSchema = z
  .string()
  .trim()
  .min(10, 'Give a reason of at least 10 characters — this is recorded in the audit trail')
  .max(1000);

export const problemDetailSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  errors: z.record(z.array(z.string())).optional(),
});
export type ProblemDetail = z.infer<typeof problemDetailSchema>;

export const sortDirection = z.enum(['asc', 'desc']).default('desc');
