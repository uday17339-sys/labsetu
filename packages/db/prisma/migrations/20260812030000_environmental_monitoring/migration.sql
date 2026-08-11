-- Environmental monitoring: two-tier limits (alert = trend signal, action =
-- breach). Verdicts are stored, not recomputed -- a reading within limit when
-- taken must not become an excursion because a limit was tightened later.

-- CreateEnum
CREATE TYPE "EmMonitoringType" AS ENUM ('VIABLE_AIR', 'NON_VIABLE_PARTICLE', 'SURFACE', 'PERSONNEL', 'UTILITY_WATER', 'COMPRESSED_GAS', 'TEMPERATURE_HUMIDITY', 'DIFFERENTIAL_PRESSURE');

-- CreateEnum
CREATE TYPE "EmVerdict" AS ENUM ('IN_LIMIT', 'ALERT', 'ACTION');

-- CreateTable
CREATE TABLE "em_location" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "roomRef" TEXT,
    "monitoringType" "EmMonitoringType" NOT NULL,
    "alertLimit" DECIMAL(12,3),
    "actionLimit" DECIMAL(12,3),
    "unit" TEXT NOT NULL,
    "frequencyDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "em_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "em_reading" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL,
    "value" DECIMAL(12,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "verdict" "EmVerdict" NOT NULL,
    "shift" TEXT,
    "performedBy" UUID NOT NULL,
    "note" TEXT,
    "deviationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "em_reading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "em_location_tenantId_grade_idx" ON "em_location"("tenantId", "grade");

-- CreateIndex
CREATE UNIQUE INDEX "em_location_tenantId_code_key" ON "em_location"("tenantId", "code");

-- CreateIndex
CREATE INDEX "em_reading_tenantId_locationId_sampledAt_idx" ON "em_reading"("tenantId", "locationId", "sampledAt");

-- CreateIndex
CREATE INDEX "em_reading_tenantId_verdict_sampledAt_idx" ON "em_reading"("tenantId", "verdict", "sampledAt");

-- AddForeignKey
ALTER TABLE "em_reading" ADD CONSTRAINT "em_reading_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "em_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

