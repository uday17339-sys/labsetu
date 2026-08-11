/**
 * Domain enums mirrored from the Prisma schema.
 *
 * Duplicated deliberately: the web app and the gateway must not depend on
 * @prisma/client (it pulls a native query engine and a database connection into
 * a browser bundle / an on-prem agent). A compile-time test in the API asserts
 * these stay in sync with Prisma — see apps/api/test/enum-parity.spec.ts.
 */

export const SEX = ['MALE', 'FEMALE', 'OTHER', 'UNKNOWN'] as const;
export type Sex = (typeof SEX)[number];

export const PRIORITY = ['ROUTINE', 'URGENT', 'STAT'] as const;
export type Priority = (typeof PRIORITY)[number];

export const SAMPLE_STATUS = [
  'REGISTERED',
  'COLLECTED',
  'IN_TRANSIT',
  'RECEIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'REJECTED',
] as const;
export type SampleStatus = (typeof SAMPLE_STATUS)[number];

export const SAMPLE_TEST_STATUS = [
  'PENDING',
  'IN_PROGRESS',
  'RESULT_ENTERED',
  'TECH_VERIFIED',
  'AUTHORIZED',
  'REPORTED',
  'RERUN',
  'CANCELLED',
] as const;
export type SampleTestStatus = (typeof SAMPLE_TEST_STATUS)[number];

export const ORDER_STATUS = [
  'OPEN',
  'PARTIALLY_REPORTED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

export const REPORT_STATUS = ['DRAFT', 'AUTHORIZED', 'RELEASED', 'AMENDED'] as const;
export type ReportStatus = (typeof REPORT_STATUS)[number];

export const RESULT_FLAG = [
  'NORMAL',
  'LOW',
  'HIGH',
  'CRITICAL_LOW',
  'CRITICAL_HIGH',
  'ABNORMAL',
] as const;
export type ResultFlag = (typeof RESULT_FLAG)[number];

export const RESULT_SOURCE = ['MANUAL', 'INSTRUMENT', 'CALCULATED', 'EXTERNAL'] as const;
export type ResultSource = (typeof RESULT_SOURCE)[number];

export const ANALYTE_VALUE_TYPE = [
  'NUMERIC',
  'TEXT',
  'QUALITATIVE',
  'TITRE',
  'NUMERIC_BOUNDED',
] as const;
export type AnalyteValueType = (typeof ANALYTE_VALUE_TYPE)[number];

export const LAB_DEPARTMENT = [
  'BIOCHEMISTRY',
  'HAEMATOLOGY',
  'MICROBIOLOGY',
  'SEROLOGY',
  'IMMUNOLOGY',
  'CLINICAL_PATHOLOGY',
  'HISTOPATHOLOGY',
  'CYTOLOGY',
  'MOLECULAR',
  'RADIOLOGY',
  'OTHER',
] as const;
export type LabDepartment = (typeof LAB_DEPARTMENT)[number];

export const INSTRUMENT_PROTOCOL = [
  'ASTM_E1394',
  'HL7_V2',
  'FILE_CSV',
  'FILE_XML',
  'JSON_HTTP',
] as const;
export type InstrumentProtocol = (typeof INSTRUMENT_PROTOCOL)[number];

export const SIGNATURE_MEANING = [
  'REVIEWED',
  'APPROVED',
  'AUTHORIZED',
  'REJECTED',
  'AMENDED',
  'QC_OVERRIDE',
] as const;
export type SignatureMeaning = (typeof SIGNATURE_MEANING)[number];

export const COMPETENCY_LEVEL = ['PERFORM', 'VERIFY', 'AUTHORIZE'] as const;
export type CompetencyLevel = (typeof COMPETENCY_LEVEL)[number];

export const QC_STATUS = ['PASS', 'WARNING', 'REJECT'] as const;
export type QcStatus = (typeof QC_STATUS)[number];

export const CONSENT_PURPOSE = [
  'DIAGNOSTIC_SERVICE',
  'REPORT_DELIVERY',
  'BILLING',
  'STATUTORY_REPORTING',
  'RESEARCH_ANONYMISED',
  'MARKETING',
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSE)[number];

export const DELIVERY_CHANNEL = ['WHATSAPP', 'EMAIL', 'SMS', 'PORTAL', 'PRINT'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNEL)[number];

/**
 * Audit actions. A closed set rather than free strings, so audit reports can be
 * aggregated and an assessor can be shown the complete vocabulary of things the
 * system records.
 */
export const AUDIT_ACTION = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'READ_SENSITIVE',
  'EXPORT',
  'LOGIN_SUCCESS',
  'LOGIN_FAILURE',
  'LOGOUT',
  'PASSWORD_CHANGE',
  'MFA_ENABLED',
  'MFA_DISABLED',
  'TOKEN_REUSE_DETECTED',
  'PERMISSION_DENIED',
  'SIGN',
  'VERIFY',
  'AUTHORIZE',
  'RELEASE',
  'AMEND',
  'REJECT',
  'CANCEL',
  'RERUN',
  /// The clinician was telephoned about a critical value. Its own verb rather
  /// than an UPDATE, because an assessor searches the trail for exactly this.
  'CRITICAL_VALUE_NOTIFIED',
  'QC_OVERRIDE',
  'CONSENT_GRANTED',
  'CONSENT_WITHDRAWN',
  'ERASURE_REQUESTED',
  'ERASURE_EXECUTED',
  'DEVICE_ENROLLED',
  'DEVICE_REVOKED',
  /// A calibration due date moved. Its own verb because "who extended this, and
  /// on what certificate" is the first question asked when a batch produced on
  /// that instrument is queried.
  'CALIBRATION_RECORDED',
  /// A password aged past its maximum life and the holder was forced to change
  /// it. Recorded so the control is visibly operating, not merely configured.
  'PASSWORD_EXPIRED',
  'ACCESS_REVIEWED',
  /// The quality-system thread: raised, closed, actioned, verified. Each is its
  /// own verb because an assessor searches the trail for exactly these.
  'DEVIATION_RAISED',
  'DEVIATION_CLOSED',
  'CAPA_RAISED',
  'CAPA_VERIFIED',
  'CHANGE_REQUESTED',
  'CHANGE_APPROVED',
  'CHANGE_IMPLEMENTED',
  /// A stability study starting, a pull taken, a pull missed. The missed one
  /// matters most: it is a hole in the evidence behind an expiry date.
  'STABILITY_STUDY_STARTED',
  'STABILITY_PULL_RECORDED',
  'STABILITY_PULL_MISSED',
  'EM_READING_RECORDED',
  'PQR_GENERATED',
  'INGEST_RECEIVED',
  'POLICY_CHANGED',
] as const;
export type AuditAction = (typeof AUDIT_ACTION)[number];
