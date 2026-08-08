-- CreateEnum
CREATE TYPE "MaterialType" AS ENUM ('API', 'RAW_MATERIAL', 'PACKAGING', 'INTERMEDIATE', 'BULK', 'FINISHED_PRODUCT');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('QUARANTINE', 'UNDER_TEST', 'APPROVED', 'REJECTED', 'RETEST_DUE', 'EXPIRED', 'CONSUMED');

-- CreateEnum
CREATE TYPE "SpecificationStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED', 'RETIRED');

-- CreateEnum
CREATE TYPE "SamplingReason" AS ENUM ('RELEASE_TESTING', 'RETEST', 'OOS_RESAMPLE', 'STABILITY', 'COMPLAINT_INVESTIGATION');

-- CreateEnum
CREATE TYPE "SamplingRequestStatus" AS ENUM ('PENDING', 'SAMPLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DispositionDecision" AS ENUM ('APPROVED', 'REJECTED', 'APPROVED_WITH_DEVIATION', 'RETEST_REQUIRED');

-- CreateEnum
CREATE TYPE "OosPhase" AS ENUM ('PHASE_I', 'PHASE_II');

-- CreateEnum
CREATE TYPE "OosStatus" AS ENUM ('OPEN', 'UNDER_INVESTIGATION', 'CLOSED');

-- CreateEnum
CREATE TYPE "OosConclusion" AS ENUM ('LAB_ERROR_CONFIRMED', 'MANUFACTURING_CONFIRMED', 'NO_ASSIGNABLE_CAUSE', 'INVALIDATED_RESAMPLED');

-- DropForeignKey
ALTER TABLE "lab_order" DROP CONSTRAINT "lab_order_patientId_fkey";

-- AlterTable
ALTER TABLE "lab_order" ADD COLUMN     "batchId" UUID,
ALTER COLUMN "patientId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "material" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "MaterialType" NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'kg',
    "manufacturer" TEXT,
    "pharmacopoeia" TEXT,
    "storageCondition" TEXT,
    "retestPeriodDays" INTEGER,
    "handlingNotes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "grnNumber" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "supplierBatchRef" TEXT,
    "invoiceRef" TEXT,
    "poReference" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedBy" UUID,
    "receiptCheckNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_batch" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "goodsReceiptId" UUID,
    "batchNumber" TEXT NOT NULL,
    "manufacturerLot" TEXT,
    "quantityReceived" DECIMAL(14,3) NOT NULL,
    "quantityAvailable" DECIMAL(14,3) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'kg',
    "containerCount" INTEGER,
    "manufacturedAt" DATE,
    "expiryDate" DATE,
    "retestDate" DATE,
    "status" "BatchStatus" NOT NULL DEFAULT 'QUARANTINE',
    "location" TEXT,
    "dispositionedAt" TIMESTAMP(3),
    "dispositionedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" UUID,

    CONSTRAINT "material_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specification" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "SpecificationStatus" NOT NULL DEFAULT 'DRAFT',
    "basis" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "approvedBy" UUID,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" UUID,

    CONSTRAINT "specification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spec_limit" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "specificationId" UUID NOT NULL,
    "analyteId" UUID NOT NULL,
    "testDefinitionId" UUID,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "minValue" DECIMAL(18,6),
    "maxValue" DECIMAL(18,6),
    "textCriteria" TEXT,
    "unit" TEXT,
    "isCritical" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "spec_limit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sampling_request" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "reason" "SamplingReason" NOT NULL DEFAULT 'RELEASE_TESTING',
    "note" TEXT,
    "status" "SamplingRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedBy" UUID,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderId" UUID,
    "sampledBy" UUID,
    "sampledAt" TIMESTAMP(3),
    "containersSampled" INTEGER,
    "quantitySampled" DECIMAL(12,3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "sampling_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_disposition" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "decision" "DispositionDecision" NOT NULL,
    "rationale" TEXT NOT NULL,
    "deviationRef" TEXT,
    "decidedBy" UUID NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signatureId" UUID,

    CONSTRAINT "batch_disposition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oos_investigation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "resultId" UUID NOT NULL,
    "investigationNumber" TEXT NOT NULL,
    "observedValue" TEXT NOT NULL,
    "limitBreached" TEXT NOT NULL,
    "analyteCode" TEXT NOT NULL,
    "phase" "OosPhase" NOT NULL DEFAULT 'PHASE_I',
    "status" "OosStatus" NOT NULL DEFAULT 'OPEN',
    "labInvestigationNote" TEXT,
    "manufacturingNote" TEXT,
    "rootCause" TEXT,
    "conclusion" "OosConclusion",
    "correctiveAction" TEXT,
    "openedBy" UUID,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedBy" UUID,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "oos_investigation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_of_analysis" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "coaNumber" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "specificationId" UUID NOT NULL,
    "issuedBy" UUID NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pdfKey" TEXT,
    "contentHash" TEXT,

    CONSTRAINT "certificate_of_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "material_tenantId_type_idx" ON "material"("tenantId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "material_tenantId_code_key" ON "material"("tenantId", "code");

-- CreateIndex
CREATE INDEX "goods_receipt_tenantId_receivedAt_idx" ON "goods_receipt"("tenantId", "receivedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_tenantId_grnNumber_key" ON "goods_receipt"("tenantId", "grnNumber");

-- CreateIndex
CREATE INDEX "material_batch_tenantId_status_idx" ON "material_batch"("tenantId", "status");

-- CreateIndex
CREATE INDEX "material_batch_tenantId_expiryDate_idx" ON "material_batch"("tenantId", "expiryDate");

-- CreateIndex
CREATE UNIQUE INDEX "material_batch_tenantId_materialId_batchNumber_key" ON "material_batch"("tenantId", "materialId", "batchNumber");

-- CreateIndex
CREATE INDEX "specification_tenantId_materialId_status_idx" ON "specification"("tenantId", "materialId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "specification_tenantId_code_version_key" ON "specification"("tenantId", "code", "version");

-- CreateIndex
CREATE INDEX "spec_limit_tenantId_idx" ON "spec_limit"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "spec_limit_specificationId_analyteId_key" ON "spec_limit"("specificationId", "analyteId");

-- CreateIndex
CREATE UNIQUE INDEX "sampling_request_orderId_key" ON "sampling_request"("orderId");

-- CreateIndex
CREATE INDEX "sampling_request_tenantId_status_idx" ON "sampling_request"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sampling_request_tenantId_requestNumber_key" ON "sampling_request"("tenantId", "requestNumber");

-- CreateIndex
CREATE INDEX "batch_disposition_tenantId_batchId_idx" ON "batch_disposition"("tenantId", "batchId");

-- CreateIndex
CREATE INDEX "batch_disposition_tenantId_decidedAt_idx" ON "batch_disposition"("tenantId", "decidedAt" DESC);

-- CreateIndex
CREATE INDEX "oos_investigation_tenantId_status_idx" ON "oos_investigation"("tenantId", "status");

-- CreateIndex
CREATE INDEX "oos_investigation_tenantId_batchId_idx" ON "oos_investigation"("tenantId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "oos_investigation_tenantId_investigationNumber_key" ON "oos_investigation"("tenantId", "investigationNumber");

-- CreateIndex
CREATE INDEX "certificate_of_analysis_tenantId_batchId_idx" ON "certificate_of_analysis"("tenantId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "certificate_of_analysis_tenantId_coaNumber_version_key" ON "certificate_of_analysis"("tenantId", "coaNumber", "version");

-- CreateIndex
CREATE INDEX "lab_order_tenantId_batchId_idx" ON "lab_order"("tenantId", "batchId");

-- AddForeignKey
ALTER TABLE "lab_order" ADD CONSTRAINT "lab_order_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order" ADD CONSTRAINT "lab_order_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "material_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_batch" ADD CONSTRAINT "material_batch_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_batch" ADD CONSTRAINT "material_batch_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "goods_receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specification" ADD CONSTRAINT "specification_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spec_limit" ADD CONSTRAINT "spec_limit_specificationId_fkey" FOREIGN KEY ("specificationId") REFERENCES "specification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spec_limit" ADD CONSTRAINT "spec_limit_analyteId_fkey" FOREIGN KEY ("analyteId") REFERENCES "analyte"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spec_limit" ADD CONSTRAINT "spec_limit_testDefinitionId_fkey" FOREIGN KEY ("testDefinitionId") REFERENCES "test_definition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sampling_request" ADD CONSTRAINT "sampling_request_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "material_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_disposition" ADD CONSTRAINT "batch_disposition_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "material_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oos_investigation" ADD CONSTRAINT "oos_investigation_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "material_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_of_analysis" ADD CONSTRAINT "certificate_of_analysis_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "material_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificate_of_analysis" ADD CONSTRAINT "certificate_of_analysis_specificationId_fkey" FOREIGN KEY ("specificationId") REFERENCES "specification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The polymorphic subject, enforced.
--
-- An order is about EITHER a patient (diagnostics) OR a material batch
-- (manufacturing QC), never both and never neither. Prisma cannot express this,
-- and leaving it to application code means the first bug writes a row that no
-- screen can render and no report can resolve. A CHECK makes it unrepresentable.
ALTER TABLE "lab_order"
  ADD CONSTRAINT "lab_order_exactly_one_subject"
  CHECK (("patientId" IS NOT NULL) <> ("batchId" IS NOT NULL));

-- A batch cannot show more available quantity than was received.
ALTER TABLE "material_batch"
  ADD CONSTRAINT "material_batch_quantity_sane"
  CHECK ("quantityAvailable" >= 0 AND "quantityAvailable" <= "quantityReceived");

-- A spec limit must say something: an interval, or text criteria. A row with
-- neither prints as a blank acceptance criterion on the certificate of analysis.
ALTER TABLE "spec_limit"
  ADD CONSTRAINT "spec_limit_has_criteria"
  CHECK ("minValue" IS NOT NULL OR "maxValue" IS NOT NULL OR "textCriteria" IS NOT NULL);

-- And the interval must be the right way round.
ALTER TABLE "spec_limit"
  ADD CONSTRAINT "spec_limit_interval_ordered"
  CHECK ("minValue" IS NULL OR "maxValue" IS NULL OR "minValue" <= "maxValue");
