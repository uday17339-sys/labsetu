-- Audit-trail review, retention samples and vendor qualification.
--
-- The audit review records the SEQUENCE range examined, not only dates: the
-- trail is hash-chained by sequence, so naming the range makes a review
-- reproducible by a second person.

-- CreateEnum
CREATE TYPE "RetentionStatus" AS ENUM ('HELD', 'WITHDRAWN', 'DESTROYED');

-- CreateEnum
CREATE TYPE "VendorStatus" AS ENUM ('PENDING', 'APPROVED', 'SUSPENDED', 'DISQUALIFIED');

-- CreateTable
CREATE TABLE "audit_review" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "fromSeq" BIGINT NOT NULL,
    "toSeq" BIGINT NOT NULL,
    "entriesReviewed" INTEGER NOT NULL,
    "reviewedBy" UUID NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "findings" TEXT NOT NULL,
    "followUp" TEXT,

    CONSTRAINT "audit_review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_sample" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "retentionNumber" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "containerType" TEXT,
    "location" TEXT NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "collectedBy" UUID NOT NULL,
    "retainUntil" TIMESTAMP(3) NOT NULL,
    "status" "RetentionStatus" NOT NULL DEFAULT 'HELD',
    "destroyedAt" TIMESTAMP(3),
    "destroyedBy" UUID,
    "destructionRef" TEXT,
    "witnessedBy" UUID,
    "withdrawnNote" TEXT,

    CONSTRAINT "retention_sample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "gstin" TEXT,
    "contact" TEXT,
    "status" "VendorStatus" NOT NULL DEFAULT 'PENDING',
    "qualificationBasis" TEXT,
    "qualifiedAt" TIMESTAMP(3),
    "qualifiedBy" UUID,
    "requalifyBy" TIMESTAMP(3),
    "suspendedReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_review_tenantId_reviewedAt_idx" ON "audit_review"("tenantId", "reviewedAt");

-- CreateIndex
CREATE INDEX "retention_sample_tenantId_status_retainUntil_idx" ON "retention_sample"("tenantId", "status", "retainUntil");

-- CreateIndex
CREATE UNIQUE INDEX "retention_sample_tenantId_retentionNumber_key" ON "retention_sample"("tenantId", "retentionNumber");

-- CreateIndex
CREATE INDEX "vendor_tenantId_status_idx" ON "vendor"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_tenantId_code_key" ON "vendor"("tenantId", "code");

-- AddForeignKey
ALTER TABLE "retention_sample" ADD CONSTRAINT "retention_sample_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "material_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

