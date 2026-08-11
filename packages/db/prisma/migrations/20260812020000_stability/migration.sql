-- Stability studies (ICH Q1A): protocols, per-batch studies, and a scheduled
-- pull per timepoint. A missed pull is kept rather than deleted -- it is
-- evidence about the study, and removing it hides the gap.

-- CreateEnum
CREATE TYPE "StabilityStudyType" AS ENUM ('LONG_TERM', 'ACCELERATED', 'INTERMEDIATE', 'STRESS', 'ONGOING');

-- CreateEnum
CREATE TYPE "StabilityStatus" AS ENUM ('ONGOING', 'COMPLETED', 'DISCONTINUED');

-- CreateEnum
CREATE TYPE "PullStatus" AS ENUM ('SCHEDULED', 'PULLED', 'COMPLETE', 'MISSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "stability_protocol" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storageCondition" TEXT NOT NULL,
    "studyType" "StabilityStudyType" NOT NULL DEFAULT 'LONG_TERM',
    "orientation" TEXT,
    "timepointsMonths" INTEGER[],
    "testCodes" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stability_protocol_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stability_study" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "protocolId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "studyNumber" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "chamber" TEXT,
    "status" "StabilityStatus" NOT NULL DEFAULT 'ONGOING',
    "closedReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stability_study_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stability_pull" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "studyId" UUID NOT NULL,
    "timepointMonths" INTEGER NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "PullStatus" NOT NULL DEFAULT 'SCHEDULED',
    "pulledAt" TIMESTAMP(3),
    "pulledBy" UUID,
    "sampleId" UUID,
    "note" TEXT,

    CONSTRAINT "stability_pull_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stability_protocol_tenantId_code_key" ON "stability_protocol"("tenantId", "code");

-- CreateIndex
CREATE INDEX "stability_study_tenantId_status_idx" ON "stability_study"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stability_study_tenantId_studyNumber_key" ON "stability_study"("tenantId", "studyNumber");

-- CreateIndex
CREATE UNIQUE INDEX "stability_pull_sampleId_key" ON "stability_pull"("sampleId");

-- CreateIndex
CREATE INDEX "stability_pull_tenantId_status_dueAt_idx" ON "stability_pull"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "stability_pull_studyId_timepointMonths_key" ON "stability_pull"("studyId", "timepointMonths");

-- AddForeignKey
ALTER TABLE "stability_study" ADD CONSTRAINT "stability_study_protocolId_fkey" FOREIGN KEY ("protocolId") REFERENCES "stability_protocol"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stability_study" ADD CONSTRAINT "stability_study_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "material_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stability_pull" ADD CONSTRAINT "stability_pull_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "stability_study"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stability_pull" ADD CONSTRAINT "stability_pull_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "sample"("id") ON DELETE SET NULL ON UPDATE CASCADE;

