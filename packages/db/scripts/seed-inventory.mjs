#!/usr/bin/env node
/**
 * Idempotent inventory seed.
 *
 * Separate from the main seed because that one deliberately refuses to run
 * against an existing tenant (the audit trail is append-only, so it cannot
 * clean up after itself). Inventory was added after the demo tenant existed,
 * and a real lab onboarding has exactly the same shape: load a starting
 * catalogue of reagents into a system that is already live.
 *
 * Safe to run repeatedly — existing items and lots are left untouched.
 *
 * Usage: node packages/db/scripts/seed-inventory.mjs
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const ITEMS = [
  {
    code: 'RGT-GLU',
    name: 'Glucose (GOD-POD) Reagent',
    category: 'REAGENT',
    unit: 'tests',
    manufacturer: 'Erba Mannheim',
    catalogNumber: 'BLT00016',
    reorderLevel: 200,
    storageCondition: '2-8°C',
  },
  {
    code: 'RGT-CREA',
    name: 'Creatinine (Jaffe) Reagent',
    category: 'REAGENT',
    unit: 'tests',
    manufacturer: 'Erba Mannheim',
    reorderLevel: 150,
    storageCondition: '2-8°C',
  },
  {
    code: 'RGT-LIPID',
    name: 'Lipid Panel Reagent Set',
    category: 'REAGENT',
    unit: 'tests',
    manufacturer: 'Beckman Coulter',
    reorderLevel: 100,
    storageCondition: '2-8°C',
  },
  {
    code: 'CAL-CHEM',
    name: 'Chemistry Multi-Calibrator',
    category: 'CALIBRATOR',
    unit: 'vials',
    manufacturer: 'Bio-Rad',
    reorderLevel: 2,
    storageCondition: '-20°C',
  },
  {
    code: 'CON-EDTA',
    name: 'EDTA Vacutainer 2mL',
    category: 'CONSUMABLE',
    unit: 'pieces',
    manufacturer: 'BD',
    reorderLevel: 500,
    storageCondition: 'Room temperature',
  },
  {
    code: 'CON-TIP',
    name: 'Pipette Tips 1000µL',
    category: 'CONSUMABLE',
    unit: 'pieces',
    manufacturer: 'Tarsons',
    reorderLevel: 1000,
    storageCondition: 'Room temperature',
  },
];

/**
 * Deliberately includes one ALREADY-EXPIRED lot, one expiring soon and one
 * below its reorder level, so the alerts and the expired-lot gate are
 * demonstrable immediately rather than after waiting for stock to age.
 */
const LOTS = [
  { item: 'RGT-GLU', lot: 'GL-26041', qty: 800, days: 240, supplier: 'Medisys Hyderabad' },
  { item: 'RGT-CREA', lot: 'CR-26019', qty: 600, days: 180, supplier: 'Medisys Hyderabad' },
  { item: 'CON-EDTA', lot: 'BD-2609', qty: 2400, days: 500, supplier: 'BD India' },
  { item: 'CON-TIP', lot: 'TR-88120', qty: 4800, days: null, supplier: 'Tarsons' },
  { item: 'RGT-LIPID', lot: 'LP-25330', qty: 220, days: 18, supplier: 'Beckman India' },
  { item: 'CAL-CHEM', lot: 'CAL-2611', qty: 1, days: 120, supplier: 'Bio-Rad India' },
  { item: 'RGT-GLU', lot: 'GL-25008', qty: 150, days: -12, supplier: 'Medisys Hyderabad' },
];

const USAGE = [
  { test: 'GLUF', item: 'RGT-GLU', qty: 1 },
  { test: 'KFT', item: 'RGT-CREA', qty: 1 },
  { test: 'LIPID', item: 'RGT-LIPID', qty: 1 },
  { test: 'CBC', item: 'CON-EDTA', qty: 1 },
];

try {
  const tenants = await prisma.$queryRaw`SELECT * FROM labsetu_list_tenants()`;
  if (tenants.length === 0) {
    console.error('  No tenants found. Seed the database first.');
    process.exit(1);
  }

  for (const tenant of tenants) {
    let created = 0;
    let skipped = 0;

    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;

        const admin = await tx.user.findFirst({ where: { status: 'ACTIVE' } });
        const itemIds = new Map();

        for (const spec of ITEMS) {
          const existing = await tx.inventoryItem.findFirst({ where: { code: spec.code } });
          if (existing) {
            itemIds.set(spec.code, existing.id);
            skipped++;
            continue;
          }
          const item = await tx.inventoryItem.create({
            data: {
              tenantId: tenant.id,
              code: spec.code,
              name: spec.name,
              category: spec.category,
              unit: spec.unit,
              manufacturer: spec.manufacturer ?? null,
              catalogNumber: spec.catalogNumber ?? null,
              reorderLevel: new Prisma.Decimal(spec.reorderLevel),
              storageCondition: spec.storageCondition,
            },
          });
          itemIds.set(spec.code, item.id);
          created++;
        }

        for (const l of LOTS) {
          const itemId = itemIds.get(l.item);
          if (!itemId) continue;

          const existing = await tx.inventoryLot.findFirst({
            where: { itemId, lotNumber: l.lot },
          });
          if (existing) continue;

          const qty = new Prisma.Decimal(l.qty);
          const lot = await tx.inventoryLot.create({
            data: {
              tenantId: tenant.id,
              itemId,
              lotNumber: l.lot,
              expiryDate: l.days === null ? null : new Date(Date.now() + l.days * 864e5),
              quantityReceived: qty,
              quantityRemaining: qty,
              supplier: l.supplier,
              receivedBy: admin?.id ?? null,
              status: 'AVAILABLE',
            },
          });

          await tx.stockTransaction.create({
            data: {
              tenantId: tenant.id,
              lotId: lot.id,
              type: 'RECEIPT',
              quantity: qty,
              balanceAfter: qty,
              reason: 'Opening stock',
              performedBy: admin?.id ?? null,
            },
          });
        }

        // Per-test consumption rules — what makes stock decrement automatically.
        for (const u of USAGE) {
          const test = await tx.testDefinition.findFirst({ where: { code: u.test } });
          const itemId = itemIds.get(u.item);
          if (!test || !itemId) continue;

          const existing = await tx.testReagentUsage.findFirst({
            where: { testDefinitionId: test.id, inventoryItemId: itemId },
          });
          if (existing) continue;

          await tx.testReagentUsage.create({
            data: {
              tenantId: tenant.id,
              testDefinitionId: test.id,
              inventoryItemId: itemId,
              quantityPerTest: new Prisma.Decimal(u.qty),
            },
          });
        }
      },
      { timeout: 60_000 },
    );

    console.log(
      `  ${tenant.code}: ${created} item(s) created, ${skipped} already present, ` +
        `${LOTS.length} lot(s) and ${USAGE.length} usage rule(s) ensured`,
    );
  }

  console.log('\n  Includes one expired lot, one expiring within 30 days, and one below reorder —');
  console.log('  so the alerts and the expired-lot gate are demonstrable straight away.\n');
} catch (err) {
  console.error('\n  Inventory seed failed:\n');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
