import { z } from 'zod';
import {
  PRIORITY,
  SAMPLE_STATUS,
  SAMPLE_TEST_STATUS,
  RESULT_FLAG,
  RESULT_SOURCE,
  SIGNATURE_MEANING,
} from './enums';
import { reasonSchema } from './common';

// -----------------------------------------------------------------------------
// Orders
// -----------------------------------------------------------------------------

export const createOrderSchema = z.object({
  labId: z.string().uuid(),
  patientId: z.string().uuid(),
  referringDoctorId: z.string().uuid().optional(),
  referringOrgId: z.string().uuid().optional(),
  priority: z.enum(PRIORITY).default('ROUTINE'),
  clinicalNotes: z.string().trim().max(2000).optional(),
  provisionalDiagnosis: z.string().trim().max(500).optional(),
  items: z
    .array(
      z
        .object({
          testDefinitionId: z.string().uuid().optional(),
          panelId: z.string().uuid().optional(),
          quantity: z.number().int().min(1).default(1),
          discountPct: z.number().min(0).max(100).default(0),
        })
        .refine((i) => (i.testDefinitionId ? 1 : 0) + (i.panelId ? 1 : 0) === 1, {
          message: 'An order line is either a single test or a panel, not both',
        }),
    )
    .min(1, 'An order needs at least one test'),
  /** Create the sample(s) in the same call — the common front-desk flow. */
  createSample: z.boolean().default(true),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

// -----------------------------------------------------------------------------
// Samples
// -----------------------------------------------------------------------------

export const collectSampleSchema = z.object({
  collectedAt: z.coerce.date().optional(),
  collectionSite: z.string().trim().max(200).optional(),
  volumeMl: z.number().positive().max(999).optional(),
  containerTypeId: z.string().uuid().optional(),
});

export const receiveSampleSchema = z.object({
  receivedAt: z.coerce.date().optional(),
  storageLocation: z.string().trim().max(100).optional(),
});

export const rejectSampleSchema = z.object({
  rejectionReasonId: z.string().uuid(),
  note: z.string().trim().max(1000).optional(),
});

export const sampleQuerySchema = z.object({
  labId: z.string().uuid().optional(),
  status: z.enum(SAMPLE_STATUS).optional(),
  accessionNumber: z.string().trim().optional(),
  barcode: z.string().trim().optional(),
  patientId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// -----------------------------------------------------------------------------
// Worklist
// -----------------------------------------------------------------------------

export const worklistQuerySchema = z.object({
  labId: z.string().uuid().optional(),
  department: z.string().optional(),
  status: z.array(z.enum(SAMPLE_TEST_STATUS)).optional(),
  deviceId: z.string().uuid().optional(),
  /** Only tests past their TAT deadline — what a lab manager actually opens. */
  overdueOnly: z.coerce.boolean().default(false),
  priority: z.enum(PRIORITY).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// -----------------------------------------------------------------------------
// Results
// -----------------------------------------------------------------------------

/**
 * `value` is a string, matching how it is stored. Analyzers emit "<0.01",
 * "NEGATIVE", ">1000"; typing happens server-side against the analyte's declared
 * value type, where the rules are known and versioned.
 */
export const enterResultSchema = z.object({
  analyteId: z.string().uuid(),
  value: z.string().trim().max(2000),
  unit: z.string().trim().max(50).optional(),
  comment: z.string().trim().max(2000).optional(),
  /** Mandatory when correcting a value that was already authorised. */
  changeReason: z.string().trim().max(1000).optional(),
});

export const enterResultsSchema = z.object({
  results: z.array(enterResultSchema).min(1),
  interpretation: z.string().trim().max(5000).optional(),
});
export type EnterResultsInput = z.infer<typeof enterResultsSchema>;

export const verifyTestSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

/**
 * Authorisation requires a signing token obtained by re-authentication, bound to
 * this exact test and content hash.
 */
export const authorizeTestSchema = z.object({
  signingToken: z.string().min(1),
  meaning: z.enum(SIGNATURE_MEANING).default('AUTHORIZED'),
  note: z.string().trim().max(1000).optional(),
});

export const rerunTestSchema = z.object({
  reason: reasonSchema,
});

export const amendResultSchema = z.object({
  signingToken: z.string().min(1),
  reason: reasonSchema,
  results: z.array(enterResultSchema).min(1),
});

export const resultViewSchema = z.object({
  id: z.string().uuid(),
  analyteId: z.string().uuid(),
  analyteCode: z.string(),
  analyteName: z.string(),
  value: z.string().nullable(),
  numericValue: z.number().nullable(),
  unit: z.string().nullable(),
  refDisplay: z.string().nullable(),
  flag: z.enum(RESULT_FLAG),
  isCritical: z.boolean(),
  source: z.enum(RESULT_SOURCE),
  version: z.number().int(),
  deltaFlag: z.boolean(),
  comment: z.string().nullable(),
  enteredAt: z.string(),
});

// -----------------------------------------------------------------------------
// Reports
// -----------------------------------------------------------------------------

export const generateReportSchema = z.object({
  orderId: z.string().uuid(),
  /** Release completed tests without waiting for the slowest — labs do this constantly. */
  isPartial: z.boolean().default(false),
  sampleTestIds: z.array(z.string().uuid()).optional(),
});

export const releaseReportSchema = z.object({
  signingToken: z.string().min(1),
  deliverTo: z
    .array(
      z.object({
        channel: z.enum(['WHATSAPP', 'EMAIL', 'SMS', 'PORTAL', 'PRINT']),
        destination: z.string().trim().optional(),
      }),
    )
    .default([]),
});

export const amendReportSchema = z.object({
  signingToken: z.string().min(1),
  reason: reasonSchema,
});

// -----------------------------------------------------------------------------
// Critical values
// -----------------------------------------------------------------------------

/**
 * Recording that a critical value was telephoned to the clinician.
 *
 * NABL 112 and ISO 15189 §7.4.1 want evidence of the call, not the intent to
 * call: who was told, how, and what they repeated back. Read-back is required
 * because it is the control that catches a value or a patient being misheard —
 * a callback log without it does not demonstrate the notification succeeded.
 */
export const criticalCallbackSchema = z.object({
  /** The person told — name them. "The ward" is not evidence. */
  notifiedTo: z
    .string()
    .trim()
    .min(3, 'Name the person notified — an assessor will ask who was told')
    .max(150),
  method: z.enum(['PHONE', 'IN_PERSON', 'SECURE_MESSAGE', 'EMAIL']).default('PHONE'),
  readBack: z
    .string()
    .trim()
    .min(3, 'Record what was read back — this is the control that catches a misheard value')
    .max(300),
  note: z.string().trim().max(500).optional(),
});
export type CriticalCallbackInput = z.infer<typeof criticalCallbackSchema>;
