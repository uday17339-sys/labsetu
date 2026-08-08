import { z } from 'zod';
import { SEX, CONSENT_PURPOSE } from './enums';
import { indianPhoneSchema, pincodeSchema, reasonSchema } from './common';

/**
 * Age is captured either as a date of birth or as an age at registration.
 * Indian labs routinely receive "45 yrs" with no DOB, and forcing a fabricated
 * date of birth would put invented data into a clinical record — so both are
 * supported and exactly one is required.
 */
export const createPatientSchema = z
  .object({
    fullName: z.string().trim().min(2).max(200),
    sex: z.enum(SEX).default('UNKNOWN'),
    dateOfBirth: z.coerce.date().max(new Date(), 'Date of birth cannot be in the future').optional(),
    ageYears: z.number().int().min(0).max(150).optional(),
    ageMonths: z.number().int().min(0).max(11).optional(),
    ageDays: z.number().int().min(0).max(30).optional(),
    phone: indianPhoneSchema.optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    address: z.string().trim().max(500).optional(),
    pincode: pincodeSchema.optional(),
    /** Aadhaar / ABHA. Encrypted at rest; never returned in list responses. */
    govId: z.string().trim().max(50).optional(),
    bloodGroup: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).optional(),
    consents: z
      .array(
        z.object({
          purpose: z.enum(CONSENT_PURPOSE),
          granted: z.boolean(),
          noticeVersion: z.string().default('v1'),
          noticeLocale: z.string().default('en'),
        }),
      )
      .default([]),
  })
  .refine(
    (d) =>
      d.dateOfBirth !== undefined ||
      d.ageYears !== undefined ||
      d.ageMonths !== undefined ||
      d.ageDays !== undefined,
    {
      message:
        'Provide a date of birth or an age — reference ranges are age-dependent and cannot be applied without one',
      path: ['dateOfBirth'],
    },
  );
export type CreatePatientInput = z.infer<typeof createPatientSchema>;

/**
 * Demographic correction.
 *
 * `reason` is required and `govId` is not editable. A government identifier is
 * the one field where "correcting" it silently would let one patient's record
 * be reassigned to another person — re-register instead, so the change is
 * visible as two records rather than invisible as one edit.
 */
export const updatePatientSchema = createPatientSchema
  .innerType()
  .partial()
  .omit({ consents: true, govId: true })
  .extend({
    reason: z
      .string()
      .trim()
      .min(5, 'Say why the record is being corrected — the trail is read by assessors')
      .max(300),
  })
  .refine((d) => Object.keys(d).length > 1, {
    message: 'Provide at least one field to change',
    path: ['reason'],
  });
export type UpdatePatientInput = z.infer<typeof updatePatientSchema>;

export const patientSearchSchema = z.object({
  /** Exact-match only: blind indexes cannot do substring search (ADR 0005). */
  phone: z.string().trim().optional(),
  patientCode: z.string().trim().optional(),
  govId: z.string().trim().optional(),
  name: z.string().trim().optional(),
  /**
   * Registration window. The front desk's real question is often "who came in
   * today" rather than "find this one person", and the identifier-only search
   * left that unanswerable. The window filters on `createdAt`, which is not
   * encrypted, so it works where blind-index search cannot.
   */
  registeredFrom: z.coerce.date().optional(),
  registeredTo: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** List projection — deliberately excludes decrypted identifiers. */
export const patientSummarySchema = z.object({
  id: z.string().uuid(),
  patientCode: z.string(),
  sex: z.enum(SEX),
  ageDisplay: z.string(),
  createdAt: z.string(),
  isErased: z.boolean(),
});

/** Full projection — requires patient:read_pii and is itself audited. */
export const patientDetailSchema = patientSummarySchema.extend({
  fullName: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  dateOfBirth: z.string().nullable(),
  bloodGroup: z.string().nullable(),
});

export const erasePatientSchema = z.object({
  reason: reasonSchema,
  /** The data-principal request reference this erasure fulfils. */
  requestRef: z.string().trim().min(1).max(100),
  confirm: z.literal(true),
});
