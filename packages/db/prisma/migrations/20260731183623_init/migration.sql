-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'LOCKED');

-- CreateEnum
CREATE TYPE "CompetencyLevel" AS ENUM ('PERFORM', 'VERIFY', 'AUTHORIZE');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('RUNNING', 'PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "SignatureMeaning" AS ENUM ('REVIEWED', 'APPROVED', 'AUTHORIZED', 'REJECTED', 'AMENDED', 'QC_OVERRIDE');

-- CreateEnum
CREATE TYPE "SignatureMethod" AS ENUM ('PASSWORD_TOTP', 'PASSWORD_ONLY');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('DIAGNOSTIC_SERVICE', 'REPORT_DELIVERY', 'BILLING', 'STATUTORY_REPORTING', 'RESEARCH_ANONYMISED', 'MARKETING');

-- CreateEnum
CREATE TYPE "AnalyteValueType" AS ENUM ('NUMERIC', 'TEXT', 'QUALITATIVE', 'TITRE', 'NUMERIC_BOUNDED');

-- CreateEnum
CREATE TYPE "LabDepartment" AS ENUM ('BIOCHEMISTRY', 'HAEMATOLOGY', 'MICROBIOLOGY', 'SEROLOGY', 'IMMUNOLOGY', 'CLINICAL_PATHOLOGY', 'HISTOPATHOLOGY', 'CYTOLOGY', 'MOLECULAR', 'RADIOLOGY', 'OTHER');

-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('ROUTINE', 'URGENT', 'STAT');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'PARTIALLY_REPORTED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SampleStatus" AS ENUM ('REGISTERED', 'COLLECTED', 'IN_TRANSIT', 'RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SampleTestStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'RESULT_ENTERED', 'TECH_VERIFIED', 'AUTHORIZED', 'REPORTED', 'RERUN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ResultFlag" AS ENUM ('NORMAL', 'LOW', 'HIGH', 'CRITICAL_LOW', 'CRITICAL_HIGH', 'ABNORMAL');

-- CreateEnum
CREATE TYPE "ResultSource" AS ENUM ('MANUAL', 'INSTRUMENT', 'CALCULATED', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('DRAFT', 'AUTHORIZED', 'RELEASED', 'AMENDED');

-- CreateEnum
CREATE TYPE "DeliveryChannel" AS ENUM ('WHATSAPP', 'EMAIL', 'SMS', 'PORTAL', 'PRINT');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'BLOCKED_NO_CONSENT');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('CASH', 'UPI', 'CARD', 'NETBANKING', 'CHEQUE', 'CREDIT', 'INSURANCE');

-- CreateEnum
CREATE TYPE "QcLevel" AS ENUM ('LEVEL_1', 'LEVEL_2', 'LEVEL_3');

-- CreateEnum
CREATE TYPE "QcStatus" AS ENUM ('PASS', 'WARNING', 'REJECT');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('PENDING_ENROLMENT', 'ENROLLED', 'ACTIVE', 'DISABLED', 'REVOKED');

-- CreateEnum
CREATE TYPE "InstrumentProtocol" AS ENUM ('ASTM_E1394', 'HL7_V2', 'FILE_CSV', 'FILE_XML', 'JSON_HTTP');

-- CreateEnum
CREATE TYPE "IngestStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "IngestExceptionReason" AS ENUM ('UNKNOWN_SPECIMEN', 'UNMAPPED_CHANNEL', 'TEST_NOT_ORDERED', 'INVALID_VALUE', 'DUPLICATE_RESULT', 'TEST_ALREADY_AUTHORIZED', 'DEVICE_IN_SHADOW_MODE', 'QC_FAILURE_BLOCK');

-- CreateEnum
CREATE TYPE "ExceptionStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "gstin" TEXT,
    "pan" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "stateCode" TEXT,
    "pincode" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "logoKey" TEXT,
    "nablCertNo" TEXT,
    "nablValidTill" TIMESTAMP(3),
    "locale" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "dataKeyEnc" TEXT,
    "dataKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_policy" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "tenant_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "addressLine1" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lab_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "qualification" TEXT,
    "registrationNo" TEXT,
    "phone" TEXT,
    "signatureKey" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "isMfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecretEnc" TEXT,
    "mfaRecoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" UUID,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_role" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "labId" UUID,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedBy" UUID,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_competency" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "testDefinitionId" UUID NOT NULL,
    "level" "CompetencyLevel" NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3),
    "grantedBy" UUID NOT NULL,
    "evidenceNote" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_competency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" UUID NOT NULL,
    "parentId" UUID,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" UUID,
    "actorDisplay" TEXT,
    "actorRole" TEXT,
    "actorIp" TEXT,
    "actorUserAgent" TEXT,
    "requestId" TEXT,
    "actorDeviceId" UUID,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    "changedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_chain_head" (
    "tenantId" UUID NOT NULL,
    "seq" BIGINT NOT NULL DEFAULT 0,
    "headHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_chain_head_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "audit_verification" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "fromSeq" BIGINT NOT NULL,
    "toSeq" BIGINT NOT NULL,
    "entriesChecked" BIGINT NOT NULL DEFAULT 0,
    "status" "VerificationStatus" NOT NULL DEFAULT 'RUNNING',
    "failureDetail" TEXT,
    "anchorKey" TEXT,

    CONSTRAINT "audit_verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "meaning" "SignatureMeaning" NOT NULL,
    "contentHash" TEXT NOT NULL,
    "method" "SignatureMethod" NOT NULL DEFAULT 'PASSWORD_TOTP',
    "reason" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    "auditLogId" UUID,

    CONSTRAINT "signature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "uploadedBy" UUID,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_record" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "noticeLocale" TEXT NOT NULL DEFAULT 'en',
    "channel" TEXT,
    "grantedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analyte" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "loincCode" TEXT,
    "valueType" "AnalyteValueType" NOT NULL DEFAULT 'NUMERIC',
    "defaultUnit" TEXT,
    "precision" INTEGER NOT NULL DEFAULT 2,
    "allowedValues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analyte_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "method" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "principle" TEXT,
    "sopRef" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "method_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specimen_type" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "specimen_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "container_type" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "colour" TEXT,
    "additive" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "container_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rejection_reason" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "rejection_reason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_definition" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "department" "LabDepartment" NOT NULL DEFAULT 'BIOCHEMISTRY',
    "version" INTEGER NOT NULL DEFAULT 1,
    "methodId" UUID,
    "specimenTypeId" UUID,
    "containerTypeId" UUID,
    "minVolumeMl" DECIMAL(6,2),
    "tatMinutes" INTEGER,
    "price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "sacCode" TEXT,
    "requiresVerification" BOOLEAN NOT NULL DEFAULT true,
    "instructions" TEXT,
    "isOutsourced" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_analyte" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "testDefinitionId" UUID NOT NULL,
    "analyteId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "formula" TEXT,
    "isMandatory" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "test_analyte_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "panel" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "sacCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "panel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "panel_item" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "panelId" UUID NOT NULL,
    "testDefinitionId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "panel_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_range" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "analyteId" UUID NOT NULL,
    "sex" "Sex",
    "minAgeDays" INTEGER,
    "maxAgeDays" INTEGER,
    "condition" TEXT,
    "lowValue" DECIMAL(18,6),
    "highValue" DECIMAL(18,6),
    "displayText" TEXT,
    "unit" TEXT,
    "criticalLow" DECIMAL(18,6),
    "criticalHigh" DECIMAL(18,6),
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_range_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientCode" TEXT NOT NULL,
    "nameEnc" TEXT NOT NULL,
    "nameIdx" TEXT,
    "phoneEnc" TEXT,
    "phoneIdx" TEXT,
    "emailEnc" TEXT,
    "emailIdx" TEXT,
    "addressEnc" TEXT,
    "govIdEnc" TEXT,
    "govIdIdx" TEXT,
    "dataKeyEnc" TEXT NOT NULL,
    "dataKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "sex" "Sex" NOT NULL DEFAULT 'UNKNOWN',
    "dateOfBirth" DATE,
    "ageYears" INTEGER,
    "ageMonths" INTEGER,
    "ageDays" INTEGER,
    "bloodGroup" TEXT,
    "erasedAt" TIMESTAMP(3),
    "erasureRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" UUID,

    CONSTRAINT "patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referring_doctor" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qualification" TEXT,
    "registrationNo" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "speciality" TEXT,
    "organizationId" UUID,
    "commissionPct" DECIMAL(5,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referring_doctor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referring_organization" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "gstin" TEXT,
    "addressLine1" TEXT,
    "city" TEXT,
    "state" TEXT,
    "stateCode" TEXT,
    "pincode" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "priceListId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referring_organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_order" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "labId" UUID NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "patientId" UUID NOT NULL,
    "referringDoctorId" UUID,
    "referringOrgId" UUID,
    "priority" "Priority" NOT NULL DEFAULT 'ROUTINE',
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "clinicalNotes" TEXT,
    "provisionalDiagnosis" TEXT,
    "orderedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lab_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "testDefinitionId" UUID,
    "panelId" UUID,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "labId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "accessionNumber" TEXT NOT NULL,
    "barcode" TEXT,
    "patientId" UUID,
    "specimenTypeId" UUID,
    "containerTypeId" UUID,
    "volumeMl" DECIMAL(6,2),
    "status" "SampleStatus" NOT NULL DEFAULT 'REGISTERED',
    "priority" "Priority" NOT NULL DEFAULT 'ROUTINE',
    "collectedAt" TIMESTAMP(3),
    "collectedBy" UUID,
    "collectionSite" TEXT,
    "receivedAt" TIMESTAMP(3),
    "receivedBy" UUID,
    "rejectedAt" TIMESTAMP(3),
    "rejectedBy" UUID,
    "rejectionReasonId" UUID,
    "rejectionNote" TEXT,
    "storageLocation" TEXT,
    "disposedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" UUID,

    CONSTRAINT "sample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_test" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sampleId" UUID NOT NULL,
    "orderItemId" UUID,
    "testDefinitionId" UUID NOT NULL,
    "testVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "SampleTestStatus" NOT NULL DEFAULT 'PENDING',
    "priority" "Priority" NOT NULL DEFAULT 'ROUTINE',
    "deviceId" UUID,
    "startedAt" TIMESTAMP(3),
    "resultAt" TIMESTAMP(3),
    "enteredBy" UUID,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" UUID,
    "authorizedAt" TIMESTAMP(3),
    "authorizedBy" UUID,
    "reportedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "rerunCount" INTEGER NOT NULL DEFAULT 0,
    "rerunReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" UUID,
    "rejectionReasonId" UUID,
    "cancellationNote" TEXT,
    "interpretation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sample_test_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sampleTestId" UUID NOT NULL,
    "analyteId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "value" TEXT,
    "numericValue" DECIMAL(18,6),
    "unit" TEXT,
    "refRangeId" UUID,
    "refLow" DECIMAL(18,6),
    "refHigh" DECIMAL(18,6),
    "refDisplay" TEXT,
    "flag" "ResultFlag" NOT NULL DEFAULT 'NORMAL',
    "isCritical" BOOLEAN NOT NULL DEFAULT false,
    "criticalNotifiedAt" TIMESTAMP(3),
    "criticalNotifiedBy" UUID,
    "criticalNotifiedTo" TEXT,
    "source" "ResultSource" NOT NULL DEFAULT 'MANUAL',
    "deviceId" UUID,
    "instrumentMessageId" UUID,
    "deltaFlag" BOOLEAN NOT NULL DEFAULT false,
    "deltaPct" DECIMAL(10,2),
    "comment" TEXT,
    "changeReason" TEXT,
    "enteredBy" UUID,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "reportNumber" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "ReportStatus" NOT NULL DEFAULT 'DRAFT',
    "isPartial" BOOLEAN NOT NULL DEFAULT false,
    "pdfKey" TEXT,
    "pdfChecksum" TEXT,
    "authorizedAt" TIMESTAMP(3),
    "authorizedBy" UUID,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" UUID,
    "amendedFromId" UUID,
    "amendmentReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_item" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "sampleTestId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "report_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_delivery" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "channel" "DeliveryChannel" NOT NULL,
    "destinationEnc" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "providerRef" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "consentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "labId" UUID NOT NULL,
    "orderId" UUID,
    "invoiceNumber" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerType" TEXT NOT NULL DEFAULT 'B2C',
    "customerName" TEXT NOT NULL,
    "customerGstin" TEXT,
    "placeOfSupply" TEXT,
    "subTotal" DECIMAL(12,2) NOT NULL,
    "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxableAmount" DECIMAL(12,2) NOT NULL,
    "cgstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'UNPAID',
    "irn" TEXT,
    "irnQrPayload" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_item" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "sacCode" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxableAmount" DECIMAL(12,2) NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cgstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "invoice_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "reference" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_material" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "manufacturer" TEXT,
    "level" "QcLevel" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qc_material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_lot" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "qcMaterialId" UUID NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qc_lot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_lot_analyte" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "qcLotId" UUID NOT NULL,
    "analyteId" UUID NOT NULL,
    "targetMean" DECIMAL(18,6) NOT NULL,
    "targetSd" DECIMAL(18,6) NOT NULL,
    "observedMean" DECIMAL(18,6),
    "observedSd" DECIMAL(18,6),
    "unit" TEXT,

    CONSTRAINT "qc_lot_analyte_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_result" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "qcLotId" UUID NOT NULL,
    "analyteId" UUID NOT NULL,
    "deviceId" UUID,
    "value" DECIMAL(18,6) NOT NULL,
    "zScore" DECIMAL(10,4),
    "status" "QcStatus" NOT NULL DEFAULT 'PASS',
    "violatedRules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "actionTaken" TEXT,
    "acceptedBy" UUID,
    "acceptedAt" TIMESTAMP(3),
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enteredBy" UUID,
    "source" "ResultSource" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qc_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "labId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "department" "LabDepartment" NOT NULL DEFAULT 'BIOCHEMISTRY',
    "protocol" "InstrumentProtocol" NOT NULL,
    "location" TEXT,
    "status" "DeviceStatus" NOT NULL DEFAULT 'PENDING_ENROLMENT',
    "isShadowMode" BOOLEAN NOT NULL DEFAULT true,
    "deviceKeyHash" TEXT,
    "deviceSecretEnc" TEXT,
    "enrolmentCode" TEXT,
    "enrolmentCodeExpiresAt" TIMESTAMP(3),
    "enrolledAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3),
    "heartbeatIntervalSeconds" INTEGER NOT NULL DEFAULT 60,
    "lastCalibratedAt" TIMESTAMP(3),
    "calibrationDueAt" TIMESTAMP(3),
    "lastServicedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_channel" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "instrumentCode" TEXT NOT NULL,
    "testDefinitionId" UUID,
    "analyteId" UUID NOT NULL,
    "unitConversionFactor" DECIMAL(18,8),
    "instrumentUnit" TEXT,
    "targetUnit" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instrument_message" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "messageId" TEXT NOT NULL,
    "protocol" "InstrumentProtocol" NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawStorageKey" TEXT,
    "rawChecksum" TEXT NOT NULL,
    "rawPreview" TEXT,
    "observationCount" INTEGER NOT NULL DEFAULT 0,
    "status" "IngestStatus" NOT NULL DEFAULT 'RECEIVED',
    "processedAt" TIMESTAMP(3),
    "errorDetail" TEXT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "instrument_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingest_exception" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "messageRowId" UUID NOT NULL,
    "reason" "IngestExceptionReason" NOT NULL,
    "detail" TEXT,
    "specimenRef" TEXT,
    "instrumentCode" TEXT,
    "rawObservation" JSONB NOT NULL,
    "status" "ExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" UUID,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingest_exception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accession_counter" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "labId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accession_counter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_code_key" ON "tenant"("code");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_policy_tenantId_key_key" ON "tenant_policy"("tenantId", "key");

-- CreateIndex
CREATE INDEX "lab_tenantId_idx" ON "lab"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "lab_tenantId_code_key" ON "lab"("tenantId", "code");

-- CreateIndex
CREATE INDEX "user_tenantId_idx" ON "user"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "user_tenantId_email_key" ON "user"("tenantId", "email");

-- CreateIndex
CREATE INDEX "role_tenantId_idx" ON "role"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenantId_code_key" ON "role"("tenantId", "code");

-- CreateIndex
CREATE INDEX "user_role_tenantId_idx" ON "user_role"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_userId_roleId_labId_key" ON "user_role"("userId", "roleId", "labId");

-- CreateIndex
CREATE INDEX "user_competency_tenantId_userId_idx" ON "user_competency"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "user_competency_tenantId_testDefinitionId_idx" ON "user_competency"("tenantId", "testDefinitionId");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_tokenHash_key" ON "refresh_token"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_token_tenantId_userId_idx" ON "refresh_token"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "refresh_token_familyId_idx" ON "refresh_token"("familyId");

-- CreateIndex
CREATE INDEX "audit_log_tenantId_entityType_entityId_occurredAt_idx" ON "audit_log"("tenantId", "entityType", "entityId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "audit_log_tenantId_occurredAt_idx" ON "audit_log"("tenantId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "audit_log_tenantId_actorUserId_occurredAt_idx" ON "audit_log"("tenantId", "actorUserId", "occurredAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_tenantId_seq_key" ON "audit_log"("tenantId", "seq");

-- CreateIndex
CREATE INDEX "audit_verification_tenantId_startedAt_idx" ON "audit_verification"("tenantId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "signature_tenantId_entityType_entityId_idx" ON "signature"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "signature_tenantId_userId_idx" ON "signature"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "attachment_tenantId_entityType_entityId_idx" ON "attachment"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "consent_record_tenantId_patientId_idx" ON "consent_record"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "analyte_tenantId_idx" ON "analyte"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "analyte_tenantId_code_key" ON "analyte"("tenantId", "code");

-- CreateIndex
CREATE INDEX "method_tenantId_idx" ON "method"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "method_tenantId_code_key" ON "method"("tenantId", "code");

-- CreateIndex
CREATE INDEX "specimen_type_tenantId_idx" ON "specimen_type"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "specimen_type_tenantId_code_key" ON "specimen_type"("tenantId", "code");

-- CreateIndex
CREATE INDEX "container_type_tenantId_idx" ON "container_type"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "container_type_tenantId_code_key" ON "container_type"("tenantId", "code");

-- CreateIndex
CREATE INDEX "rejection_reason_tenantId_idx" ON "rejection_reason"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "rejection_reason_tenantId_code_key" ON "rejection_reason"("tenantId", "code");

-- CreateIndex
CREATE INDEX "test_definition_tenantId_department_idx" ON "test_definition"("tenantId", "department");

-- CreateIndex
CREATE UNIQUE INDEX "test_definition_tenantId_code_key" ON "test_definition"("tenantId", "code");

-- CreateIndex
CREATE INDEX "test_analyte_tenantId_idx" ON "test_analyte"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "test_analyte_testDefinitionId_analyteId_key" ON "test_analyte"("testDefinitionId", "analyteId");

-- CreateIndex
CREATE INDEX "panel_tenantId_idx" ON "panel"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "panel_tenantId_code_key" ON "panel"("tenantId", "code");

-- CreateIndex
CREATE INDEX "panel_item_tenantId_idx" ON "panel_item"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "panel_item_panelId_testDefinitionId_key" ON "panel_item"("panelId", "testDefinitionId");

-- CreateIndex
CREATE INDEX "reference_range_tenantId_analyteId_effectiveFrom_idx" ON "reference_range"("tenantId", "analyteId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "patient_tenantId_nameIdx_idx" ON "patient"("tenantId", "nameIdx");

-- CreateIndex
CREATE INDEX "patient_tenantId_phoneIdx_idx" ON "patient"("tenantId", "phoneIdx");

-- CreateIndex
CREATE INDEX "patient_tenantId_govIdIdx_idx" ON "patient"("tenantId", "govIdIdx");

-- CreateIndex
CREATE UNIQUE INDEX "patient_tenantId_patientCode_key" ON "patient"("tenantId", "patientCode");

-- CreateIndex
CREATE INDEX "referring_doctor_tenantId_idx" ON "referring_doctor"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "referring_doctor_tenantId_code_key" ON "referring_doctor"("tenantId", "code");

-- CreateIndex
CREATE INDEX "referring_organization_tenantId_idx" ON "referring_organization"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "referring_organization_tenantId_code_key" ON "referring_organization"("tenantId", "code");

-- CreateIndex
CREATE INDEX "lab_order_tenantId_labId_status_idx" ON "lab_order"("tenantId", "labId", "status");

-- CreateIndex
CREATE INDEX "lab_order_tenantId_patientId_idx" ON "lab_order"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "lab_order_tenantId_orderedAt_idx" ON "lab_order"("tenantId", "orderedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "lab_order_tenantId_orderNumber_key" ON "lab_order"("tenantId", "orderNumber");

-- CreateIndex
CREATE INDEX "order_item_tenantId_orderId_idx" ON "order_item"("tenantId", "orderId");

-- CreateIndex
CREATE INDEX "sample_tenantId_labId_status_idx" ON "sample"("tenantId", "labId", "status");

-- CreateIndex
CREATE INDEX "sample_tenantId_orderId_idx" ON "sample"("tenantId", "orderId");

-- CreateIndex
CREATE INDEX "sample_tenantId_barcode_idx" ON "sample"("tenantId", "barcode");

-- CreateIndex
CREATE INDEX "sample_tenantId_createdAt_idx" ON "sample"("tenantId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "sample_tenantId_accessionNumber_key" ON "sample"("tenantId", "accessionNumber");

-- CreateIndex
CREATE INDEX "sample_test_tenantId_status_idx" ON "sample_test"("tenantId", "status");

-- CreateIndex
CREATE INDEX "sample_test_tenantId_sampleId_idx" ON "sample_test"("tenantId", "sampleId");

-- CreateIndex
CREATE INDEX "sample_test_tenantId_status_dueAt_idx" ON "sample_test"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "sample_test_tenantId_testDefinitionId_status_idx" ON "sample_test"("tenantId", "testDefinitionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sample_test_sampleId_testDefinitionId_rerunCount_key" ON "sample_test"("sampleId", "testDefinitionId", "rerunCount");

-- CreateIndex
CREATE INDEX "result_tenantId_sampleTestId_idx" ON "result"("tenantId", "sampleTestId");

-- CreateIndex
CREATE INDEX "result_tenantId_analyteId_enteredAt_idx" ON "result"("tenantId", "analyteId", "enteredAt" DESC);

-- CreateIndex
CREATE INDEX "result_tenantId_isCritical_criticalNotifiedAt_idx" ON "result"("tenantId", "isCritical", "criticalNotifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX "result_sampleTestId_analyteId_version_key" ON "result"("sampleTestId", "analyteId", "version");

-- CreateIndex
CREATE INDEX "report_tenantId_orderId_idx" ON "report"("tenantId", "orderId");

-- CreateIndex
CREATE INDEX "report_tenantId_status_idx" ON "report"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "report_tenantId_reportNumber_version_key" ON "report"("tenantId", "reportNumber", "version");

-- CreateIndex
CREATE INDEX "report_item_tenantId_idx" ON "report_item"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "report_item_reportId_sampleTestId_key" ON "report_item"("reportId", "sampleTestId");

-- CreateIndex
CREATE INDEX "report_delivery_tenantId_reportId_idx" ON "report_delivery"("tenantId", "reportId");

-- CreateIndex
CREATE INDEX "report_delivery_tenantId_status_idx" ON "report_delivery"("tenantId", "status");

-- CreateIndex
CREATE INDEX "invoice_tenantId_labId_invoiceDate_idx" ON "invoice"("tenantId", "labId", "invoiceDate" DESC);

-- CreateIndex
CREATE INDEX "invoice_tenantId_status_idx" ON "invoice"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_tenantId_invoiceNumber_key" ON "invoice"("tenantId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "invoice_item_tenantId_invoiceId_idx" ON "invoice_item"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "payment_tenantId_invoiceId_idx" ON "payment"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "qc_material_tenantId_idx" ON "qc_material"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "qc_material_tenantId_code_key" ON "qc_material"("tenantId", "code");

-- CreateIndex
CREATE INDEX "qc_lot_tenantId_idx" ON "qc_lot"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "qc_lot_tenantId_qcMaterialId_lotNumber_key" ON "qc_lot"("tenantId", "qcMaterialId", "lotNumber");

-- CreateIndex
CREATE INDEX "qc_lot_analyte_tenantId_idx" ON "qc_lot_analyte"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "qc_lot_analyte_qcLotId_analyteId_key" ON "qc_lot_analyte"("qcLotId", "analyteId");

-- CreateIndex
CREATE INDEX "qc_result_tenantId_analyteId_deviceId_runAt_idx" ON "qc_result"("tenantId", "analyteId", "deviceId", "runAt" DESC);

-- CreateIndex
CREATE INDEX "qc_result_tenantId_status_idx" ON "qc_result"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "device_deviceKeyHash_key" ON "device"("deviceKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "device_enrolmentCode_key" ON "device"("enrolmentCode");

-- CreateIndex
CREATE INDEX "device_tenantId_labId_idx" ON "device"("tenantId", "labId");

-- CreateIndex
CREATE UNIQUE INDEX "device_tenantId_code_key" ON "device"("tenantId", "code");

-- CreateIndex
CREATE INDEX "device_channel_tenantId_deviceId_idx" ON "device_channel"("tenantId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "device_channel_deviceId_instrumentCode_key" ON "device_channel"("deviceId", "instrumentCode");

-- CreateIndex
CREATE INDEX "instrument_message_tenantId_deviceId_receivedAt_idx" ON "instrument_message"("tenantId", "deviceId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "instrument_message_tenantId_status_idx" ON "instrument_message"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "instrument_message_tenantId_messageId_key" ON "instrument_message"("tenantId", "messageId");

-- CreateIndex
CREATE INDEX "ingest_exception_tenantId_status_idx" ON "ingest_exception"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "accession_counter_tenantId_labId_scope_key" ON "accession_counter"("tenantId", "labId", "scope");

-- AddForeignKey
ALTER TABLE "tenant_policy" ADD CONSTRAINT "tenant_policy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab" ADD CONSTRAINT "lab_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_labId_fkey" FOREIGN KEY ("labId") REFERENCES "lab"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_competency" ADD CONSTRAINT "user_competency_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_competency" ADD CONSTRAINT "user_competency_testDefinitionId_fkey" FOREIGN KEY ("testDefinitionId") REFERENCES "test_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature" ADD CONSTRAINT "signature_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature" ADD CONSTRAINT "signature_auditLogId_fkey" FOREIGN KEY ("auditLogId") REFERENCES "audit_log"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_definition" ADD CONSTRAINT "test_definition_methodId_fkey" FOREIGN KEY ("methodId") REFERENCES "method"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_definition" ADD CONSTRAINT "test_definition_specimenTypeId_fkey" FOREIGN KEY ("specimenTypeId") REFERENCES "specimen_type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_definition" ADD CONSTRAINT "test_definition_containerTypeId_fkey" FOREIGN KEY ("containerTypeId") REFERENCES "container_type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_analyte" ADD CONSTRAINT "test_analyte_testDefinitionId_fkey" FOREIGN KEY ("testDefinitionId") REFERENCES "test_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_analyte" ADD CONSTRAINT "test_analyte_analyteId_fkey" FOREIGN KEY ("analyteId") REFERENCES "analyte"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_item" ADD CONSTRAINT "panel_item_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "panel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "panel_item" ADD CONSTRAINT "panel_item_testDefinitionId_fkey" FOREIGN KEY ("testDefinitionId") REFERENCES "test_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_range" ADD CONSTRAINT "reference_range_analyteId_fkey" FOREIGN KEY ("analyteId") REFERENCES "analyte"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referring_doctor" ADD CONSTRAINT "referring_doctor_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "referring_organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order" ADD CONSTRAINT "lab_order_labId_fkey" FOREIGN KEY ("labId") REFERENCES "lab"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order" ADD CONSTRAINT "lab_order_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order" ADD CONSTRAINT "lab_order_referringDoctorId_fkey" FOREIGN KEY ("referringDoctorId") REFERENCES "referring_doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order" ADD CONSTRAINT "lab_order_referringOrgId_fkey" FOREIGN KEY ("referringOrgId") REFERENCES "referring_organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "lab_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_testDefinitionId_fkey" FOREIGN KEY ("testDefinitionId") REFERENCES "test_definition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "panel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample" ADD CONSTRAINT "sample_labId_fkey" FOREIGN KEY ("labId") REFERENCES "lab"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample" ADD CONSTRAINT "sample_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "lab_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample" ADD CONSTRAINT "sample_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample" ADD CONSTRAINT "sample_specimenTypeId_fkey" FOREIGN KEY ("specimenTypeId") REFERENCES "specimen_type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample" ADD CONSTRAINT "sample_containerTypeId_fkey" FOREIGN KEY ("containerTypeId") REFERENCES "container_type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample" ADD CONSTRAINT "sample_rejectionReasonId_fkey" FOREIGN KEY ("rejectionReasonId") REFERENCES "rejection_reason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_test" ADD CONSTRAINT "sample_test_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "sample"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_test" ADD CONSTRAINT "sample_test_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_test" ADD CONSTRAINT "sample_test_testDefinitionId_fkey" FOREIGN KEY ("testDefinitionId") REFERENCES "test_definition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_test" ADD CONSTRAINT "sample_test_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_test" ADD CONSTRAINT "sample_test_rejectionReasonId_fkey" FOREIGN KEY ("rejectionReasonId") REFERENCES "rejection_reason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result" ADD CONSTRAINT "result_sampleTestId_fkey" FOREIGN KEY ("sampleTestId") REFERENCES "sample_test"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result" ADD CONSTRAINT "result_analyteId_fkey" FOREIGN KEY ("analyteId") REFERENCES "analyte"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result" ADD CONSTRAINT "result_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result" ADD CONSTRAINT "result_instrumentMessageId_fkey" FOREIGN KEY ("instrumentMessageId") REFERENCES "instrument_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "lab_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_amendedFromId_fkey" FOREIGN KEY ("amendedFromId") REFERENCES "report"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_item" ADD CONSTRAINT "report_item_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_item" ADD CONSTRAINT "report_item_sampleTestId_fkey" FOREIGN KEY ("sampleTestId") REFERENCES "sample_test"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_delivery" ADD CONSTRAINT "report_delivery_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_labId_fkey" FOREIGN KEY ("labId") REFERENCES "lab"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "lab_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_item" ADD CONSTRAINT "invoice_item_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_lot" ADD CONSTRAINT "qc_lot_qcMaterialId_fkey" FOREIGN KEY ("qcMaterialId") REFERENCES "qc_material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_lot_analyte" ADD CONSTRAINT "qc_lot_analyte_qcLotId_fkey" FOREIGN KEY ("qcLotId") REFERENCES "qc_lot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_lot_analyte" ADD CONSTRAINT "qc_lot_analyte_analyteId_fkey" FOREIGN KEY ("analyteId") REFERENCES "analyte"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_result" ADD CONSTRAINT "qc_result_qcLotId_fkey" FOREIGN KEY ("qcLotId") REFERENCES "qc_lot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_result" ADD CONSTRAINT "qc_result_analyteId_fkey" FOREIGN KEY ("analyteId") REFERENCES "analyte"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_result" ADD CONSTRAINT "qc_result_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device" ADD CONSTRAINT "device_labId_fkey" FOREIGN KEY ("labId") REFERENCES "lab"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_channel" ADD CONSTRAINT "device_channel_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_channel" ADD CONSTRAINT "device_channel_testDefinitionId_fkey" FOREIGN KEY ("testDefinitionId") REFERENCES "test_definition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_channel" ADD CONSTRAINT "device_channel_analyteId_fkey" FOREIGN KEY ("analyteId") REFERENCES "analyte"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instrument_message" ADD CONSTRAINT "instrument_message_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingest_exception" ADD CONSTRAINT "ingest_exception_messageRowId_fkey" FOREIGN KEY ("messageRowId") REFERENCES "instrument_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accession_counter" ADD CONSTRAINT "accession_counter_labId_fkey" FOREIGN KEY ("labId") REFERENCES "lab"("id") ON DELETE CASCADE ON UPDATE CASCADE;
