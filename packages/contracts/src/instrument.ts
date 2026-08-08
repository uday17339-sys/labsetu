import { z } from 'zod';
import { INSTRUMENT_PROTOCOL } from './enums';

/**
 * The canonical instrument envelope — the single contract between every analyzer
 * and the cloud (ADR 0004).
 *
 * The gateway translates ASTM, HL7, CSV and XML into exactly this. The API never
 * learns that those protocols exist, which is what turns "add an analyzer" from
 * an engineering project into a configuration task.
 */

export const observationSchema = z.object({
  /** Accession number as the analyzer knows it — usually read from the barcode. */
  specimenRef: z.string().trim().min(1).max(100),

  /** The instrument's own test code. Mapped via DeviceChannel, never assumed. */
  testCode: z.string().trim().min(1).max(100),

  /**
   * Deliberately a string. Analyzers emit "<0.01", "NEGATIVE", "1.2E3", "TNP",
   * ">1000". Coercing to a number at the edge would discard results the lab
   * legitimately needs to report.
   */
  value: z.string().max(2000),

  units: z.string().trim().max(50).optional(),

  /**
   * As reported by the instrument — INFORMATIONAL ONLY. The authoritative range
   * is ours, from the versioned catalog, selected by patient age and sex.
   * Analyzers are frequently configured with stale ranges.
   */
  referenceRange: z.string().max(100).optional(),

  abnormalFlags: z.string().max(20).optional(),
  resultStatus: z.enum(['FINAL', 'PRELIMINARY', 'CORRECTED', 'ERROR']).default('FINAL'),
  observedAt: z.string().datetime({ offset: true }).optional(),
  operator: z.string().max(100).optional(),
  rerunCount: z.number().int().min(0).default(0),
  dilutionFactor: z.number().positive().optional(),

  /** Whether the analyzer flagged this as a QC run rather than a patient sample. */
  isQc: z.boolean().default(false),
  qcLotRef: z.string().max(100).optional(),

  /** Everything the parser did not map. Retained rather than discarded. */
  rawFields: z.record(z.string()).default({}),
});
export type InstrumentObservation = z.infer<typeof observationSchema>;

export const instrumentEnvelopeSchema = z.object({
  /** Gateway-generated UUID — the idempotency key. A replay is a no-op. */
  messageId: z.string().uuid(),
  deviceId: z.string().uuid(),
  protocol: z.enum(INSTRUMENT_PROTOCOL),
  /** Gateway clock. Advisory only — server time is authoritative. */
  capturedAt: z.string().datetime({ offset: true }),
  /** SHA-256 of the raw payload, so tampering in transit is detectable. */
  rawChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  /** First 4 KB of the original, for troubleshooting without an S3 round trip. */
  rawPreview: z.string().max(4096).optional(),
  observations: z.array(observationSchema).min(1).max(500),
});
export type InstrumentMessageEnvelope = z.infer<typeof instrumentEnvelopeSchema>;

export const ingestAckSchema = z.object({
  messageId: z.string().uuid(),
  status: z.enum(['ACCEPTED', 'DUPLICATE']),
  receivedAt: z.string(),
});

export const heartbeatSchema = z.object({
  deviceId: z.string().uuid(),
  gatewayVersion: z.string(),
  outboxDepth: z.number().int().min(0),
  lastMessageAt: z.string().datetime({ offset: true }).nullable(),
  connectors: z.array(
    z.object({
      name: z.string(),
      protocol: z.enum(INSTRUMENT_PROTOCOL),
      status: z.enum(['UP', 'DOWN', 'DEGRADED']),
      detail: z.string().optional(),
    }),
  ),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;

export const enrolDeviceSchema = z.object({
  enrolmentCode: z.string().trim().min(6).max(64),
  gatewayVersion: z.string(),
  hostname: z.string().max(200).optional(),
});

export const enrolDeviceResponseSchema = z.object({
  deviceId: z.string().uuid(),
  deviceKey: z.string(),
  /** HMAC key for request signing. Shown exactly once, never retrievable. */
  deviceSecret: z.string(),
  tenantId: z.string().uuid(),
  labId: z.string().uuid(),
  deviceCode: z.string(),
  isShadowMode: z.boolean(),
});
