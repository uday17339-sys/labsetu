-- CreateEnum
CREATE TYPE "InventoryCategory" AS ENUM ('REAGENT', 'CONTROL', 'CALIBRATOR', 'CONSUMABLE', 'OTHER');

-- CreateEnum
CREATE TYPE "InventoryLotStatus" AS ENUM ('AVAILABLE', 'IN_USE', 'EXHAUSTED', 'EXPIRED', 'QUARANTINED', 'DISPOSED');

-- CreateEnum
CREATE TYPE "StockTransactionType" AS ENUM ('RECEIPT', 'CONSUMPTION', 'ADJUSTMENT', 'DISPOSAL', 'RETURN');

-- CreateTable
CREATE TABLE "inventory_item" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "InventoryCategory" NOT NULL DEFAULT 'REAGENT',
    "unit" TEXT NOT NULL DEFAULT 'tests',
    "manufacturer" TEXT,
    "catalogNumber" TEXT,
    "reorderLevel" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "storageCondition" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_lot" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "expiryDate" DATE,
    "quantityReceived" DECIMAL(12,3) NOT NULL,
    "quantityRemaining" DECIMAL(12,3) NOT NULL,
    "supplier" TEXT,
    "invoiceRef" TEXT,
    "unitCost" DECIMAL(12,2),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedBy" UUID,
    "openedAt" TIMESTAMP(3),
    "openStabilityDays" INTEGER,
    "status" "InventoryLotStatus" NOT NULL DEFAULT 'AVAILABLE',
    "quarantineReason" TEXT,
    "disposedAt" TIMESTAMP(3),
    "disposalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_lot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transaction" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "type" "StockTransactionType" NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "balanceAfter" DECIMAL(12,3) NOT NULL,
    "reason" TEXT,
    "sampleTestId" UUID,
    "performedBy" UUID,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_reagent_usage" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "testDefinitionId" UUID NOT NULL,
    "inventoryItemId" UUID NOT NULL,
    "quantityPerTest" DECIMAL(12,4) NOT NULL,

    CONSTRAINT "test_reagent_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_item_tenantId_category_idx" ON "inventory_item"("tenantId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_item_tenantId_code_key" ON "inventory_item"("tenantId", "code");

-- CreateIndex
CREATE INDEX "inventory_lot_tenantId_status_expiryDate_idx" ON "inventory_lot"("tenantId", "status", "expiryDate");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_lot_tenantId_itemId_lotNumber_key" ON "inventory_lot"("tenantId", "itemId", "lotNumber");

-- CreateIndex
CREATE INDEX "stock_transaction_tenantId_lotId_performedAt_idx" ON "stock_transaction"("tenantId", "lotId", "performedAt" DESC);

-- CreateIndex
CREATE INDEX "stock_transaction_tenantId_sampleTestId_idx" ON "stock_transaction"("tenantId", "sampleTestId");

-- CreateIndex
CREATE INDEX "test_reagent_usage_tenantId_idx" ON "test_reagent_usage"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "test_reagent_usage_testDefinitionId_inventoryItemId_key" ON "test_reagent_usage"("testDefinitionId", "inventoryItemId");

-- AddForeignKey
ALTER TABLE "inventory_lot" ADD CONSTRAINT "inventory_lot_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transaction" ADD CONSTRAINT "stock_transaction_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "inventory_lot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_reagent_usage" ADD CONSTRAINT "test_reagent_usage_testDefinitionId_fkey" FOREIGN KEY ("testDefinitionId") REFERENCES "test_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_reagent_usage" ADD CONSTRAINT "test_reagent_usage_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
