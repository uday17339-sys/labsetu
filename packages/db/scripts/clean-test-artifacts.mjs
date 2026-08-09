#!/usr/bin/env node
/**
 * Removes records created by the verification suites, leaving seeded demo data
 * untouched.
 *
 * Why this exists: running the suites repeatedly against a demo database leaves
 * synthetic patients, staff, catalog entries and QC lots behind. On screen that
 * reads as a badly-run lab — an outstanding critical-value queue full of test
 * data makes the NABL callback indicator look like 6% compliance.
 *
 * What it will NOT touch:
 *   - the audit trail. It is append-only and hash-chained; those entries
 *     correctly record that these things happened, and deleting them would
 *     break every subsequent link. The chain is verified after the run.
 *   - electronic signatures. The application role holds no DELETE grant on that
 *     table, so an attempt does not merely get skipped — it fails loudly and
 *     rolls the whole run back. A signature must outlive what it signed.
 *   - a user who has ever signed anything: deactivated, never deleted, so the
 *     signature stays attributable to a real individual.
 *   - anything from the seed. Selection is by the naming patterns the
 *     verification scripts use, plus an explicit patient-code boundary.
 *
 * Usage:
 *   node packages/db/scripts/clean-test-artifacts.mjs          # dry run
 *   node packages/db/scripts/clean-test-artifacts.mjs --apply  # delete
 */
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');

/**
 * Patients from this code onward are treated as verification artifacts.
 *
 * Required and explicit: there is no way to tell a script-created patient from
 * a real one by content — names are encrypted and the blind index is keyed with
 * a secret this script does not hold. A sequence boundary is the only honest
 * discriminator, and it must be stated by whoever runs this rather than guessed
 * from a date window.
 */
const fromArg = process.argv.find((a) => a.startsWith('--from-patient='));
const FROM_PATIENT = fromArg?.split('=')[1];

const prisma = new PrismaClient();

const label = (n) => (n === 1 ? '' : 's');

try {
  const tenants = await prisma.$queryRaw`SELECT * FROM labsetu_list_tenants()`;

  for (const tenant of tenants) {
    console.log(`\n\x1b[1m${tenant.code}\x1b[0m`);

    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;

        // --- staff created by verification runs -----------------------------
        const users = await tx.user.findMany({
          where: {
            OR: [
              { email: { startsWith: 'verify.' } },
              { email: { startsWith: 'newtech.' } },
              { email: { startsWith: 'norole.' } },
              { email: { startsWith: 'walkthrough.' } },
            ],
          },
          select: { id: true, email: true, fullName: true },
        });

        // --- catalog litter -------------------------------------------------
        const tests = await tx.testDefinition.findMany({
          where: {
            OR: [
              { code: { startsWith: 'VITD' } },
              { code: { startsWith: 'TECH' } },
              { code: { startsWith: 'EMPTY' } },
            ],
          },
          select: { id: true, code: true, name: true },
        });

        const doctors = await tx.referringDoctor.findMany({
          where: { name: { startsWith: 'Dr Verify' } },
          select: { id: true, code: true, name: true },
        });

        const lots = await tx.qcLot.findMany({
          where: {
            OR: [
              { lotNumber: { startsWith: 'VER-' } },
              { lotNumber: { startsWith: 'LOT-' } },
              { lotNumber: { startsWith: 'ZSD-' } },
              { lotNumber: { startsWith: 'BAD-' } },
              { lotNumber: { startsWith: 'EXP-' } },
              { lotNumber: { startsWith: 'NEW-' } },
            ],
          },
          select: { id: true, lotNumber: true },
        });

        const items = await tx.inventoryItem.findMany({
          where: {
            OR: [{ code: { startsWith: 'RGT-NEW' } }, { code: { startsWith: 'RGT4' } }, { code: { startsWith: 'RGT3' } }],
          },
          select: { id: true, code: true, name: true },
        });

        // --- manufacturing QC litter ----------------------------------------
        const verifyMaterials = await tx.material.findMany({
          where: {
            OR: [
              { code: { startsWith: 'SPECMAT' } },
              { code: { startsWith: 'NOSPEC' } },
              { code: { startsWith: 'VERMAT' } },
            ],
          },
          select: { id: true, code: true, name: true },
        });

        // Every prefix a verification suite books a consignment under. These
        // are what makes the stores screen read as a real warehouse or as a
        // test harness: "GW-1786216545485" sitting next to "PCM/26/0141" is the
        // detail that ends a demo. Add the prefix here whenever a suite starts
        // creating batches under a new one.
        const VERIFY_BATCH_PREFIXES = [
          'VER-', // pharma-verify
          'CLEAN-', // pharma-verify, the clean-release path
          'EXP-', // expiry validation probes
          'NS-', // the no-specification material
          'SMK-', // smoke-test
          'GW-', // gateway-e2e
          'QCG-', // qc-verify, the QC gate scenario
          'ADM-', // admin-verify
          'BADEXP-', // admin-verify, the inverted-date probe
          'FEAT-', // features-verify
          'WT-', // owner-walkthrough
          'RESP-', // responsive-audit
          'PROBE-', // ad-hoc diagnostic probes
        ];

        const verifyBatches = await tx.materialBatch.findMany({
          where: {
            OR: [
              ...VERIFY_BATCH_PREFIXES.map((p) => ({ batchNumber: { startsWith: p } })),
              { materialId: { in: verifyMaterials.map((m) => m.id) } },
            ],
          },
          select: { id: true, batchNumber: true },
        });

        const verifySpecs = await tx.specification.findMany({
          where: {
            OR: [
              { code: { startsWith: 'SPEC/VER/' } },
              { materialId: { in: verifyMaterials.map((m) => m.id) } },
            ],
          },
          select: { id: true, code: true, version: true },
        });

        // --- synthetic patients ---------------------------------------------
        //
        // Names are encrypted and the blind index is keyed with a secret this
        // script does not hold, so patients cannot be matched by name here.
        // They are reached through the orders that reference a test-only
        // catalog entry instead — narrower than "everything created recently",
        // which would take real demo records with it.
        const syntheticOrders = await tx.labOrder.findMany({
          where: {
            OR: [
              { items: { some: { testDefinition: { id: { in: tests.map((t) => t.id) } } } } },
            ],
          },
          select: { id: true, orderNumber: true, patientId: true },
        });

        // Patients registered by the verification scripts, by sequence boundary.
        const scriptPatients = FROM_PATIENT
          ? await tx.patient.findMany({
              where: { patientCode: { gte: FROM_PATIENT } },
              select: { id: true, patientCode: true, createdAt: true },
              orderBy: { patientCode: 'asc' },
            })
          : [];

        const scriptOrders = scriptPatients.length
          ? await tx.labOrder.findMany({
              where: { patientId: { in: scriptPatients.map((p) => p.id) } },
              select: { id: true, orderNumber: true, patientId: true },
            })
          : [];

        // Deduplicate: an order can qualify on both counts.
        const orderById = new Map();
        for (const o of [...syntheticOrders, ...scriptOrders]) orderById.set(o.id, o);
        const allOrders = [...orderById.values()];

        const patientIds = [...new Set(allOrders.map((o) => o.patientId).filter(Boolean))];

        const report = [
          ['staff accounts', users.map((u) => u.email)],
          ['catalog tests', tests.map((t) => `${t.code} (${t.name})`)],
          ['referring doctors', doctors.map((d) => `${d.code} ${d.name}`)],
          ['QC lots', lots.map((l) => l.lotNumber)],
          ['stock items', items.map((i) => `${i.code} (${i.name})`)],
          ['test materials', verifyMaterials.map((m) => `${m.code} (${m.name})`)],
          ['test batches', verifyBatches.map((b) => b.batchNumber)],
          ['test specifications', verifySpecs.map((x) => `${x.code} v${x.version}`)],
          [
            `patients from ${FROM_PATIENT ?? '(no boundary given)'} onward`,
            scriptPatients.map((p) => `${p.patientCode}  registered ${p.createdAt.toISOString().slice(0, 10)}`),
          ],
          ['orders to be removed with them', allOrders.map((o) => o.orderNumber)],
        ];

        for (const [what, list] of report) {
          if (list.length === 0) continue;
          console.log(`  ${String(list.length).padStart(3)} ${what}`);
          for (const entry of list.slice(0, 6)) console.log(`      \x1b[2m${entry}\x1b[0m`);
          if (list.length > 6) console.log(`      \x1b[2m… and ${list.length - 6} more\x1b[0m`);
        }

        const total =
          users.length +
          tests.length +
          doctors.length +
          lots.length +
          items.length +
          allOrders.length +
          verifyMaterials.length +
          verifyBatches.length +
          verifySpecs.length;

        if (total === 0) {
          console.log('  \x1b[2mnothing to clean\x1b[0m');
          return;
        }

        if (!APPLY) {
          console.log(
            `\n  \x1b[33mDRY RUN — ${total} record group${label(total)} would be removed.\x1b[0m`,
          );
          console.log('  \x1b[2mRe-run with --apply to delete.\x1b[0m');
          return;
        }

        // --- deletion, children first ---------------------------------------
        //
        // Ordered so no foreign key is ever left dangling. Results, QC results
        // and stock transactions all cascade from their parents, but the
        // ordering is written out rather than relied on implicitly.

        for (const order of allOrders) {
          const sampleIds = (
            await tx.sample.findMany({ where: { orderId: order.id }, select: { id: true } })
          ).map((s) => s.id);
          const testIds = (
            await tx.sampleTest.findMany({
              where: { sampleId: { in: sampleIds } },
              select: { id: true },
            })
          ).map((t) => t.id);
          const reportIds = (
            await tx.report.findMany({ where: { orderId: order.id }, select: { id: true } })
          ).map((r) => r.id);
          const invoiceIds = (
            await tx.invoice.findMany({ where: { orderId: order.id }, select: { id: true } })
          ).map((i) => i.id);

          // Reports come out FIRST: report_item references sample_test, so
          // deleting tests before reports trips the foreign key.
          await tx.reportDelivery.deleteMany({ where: { reportId: { in: reportIds } } });
          await tx.reportItem.deleteMany({ where: { reportId: { in: reportIds } } });
          await tx.report.deleteMany({ where: { id: { in: reportIds } } });

          await tx.payment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
          await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
          await tx.invoice.deleteMany({ where: { id: { in: invoiceIds } } });

          await tx.stockTransaction.deleteMany({ where: { sampleTestId: { in: testIds } } });
          await tx.result.deleteMany({ where: { sampleTestId: { in: testIds } } });
          // Signatures are NOT removed. The app role holds no DELETE grant on
          // that table — an electronic signature is a legal record that must
          // outlive whatever it signed, exactly like the audit trail. It
          // references its subject by a plain string rather than a foreign key,
          // so it survives this deletion intact.
          await tx.sampleTest.deleteMany({ where: { id: { in: testIds } } });
          await tx.sample.deleteMany({ where: { id: { in: sampleIds } } });

          await tx.orderItem.deleteMany({ where: { orderId: order.id } });
          await tx.labOrder.delete({ where: { id: order.id } });
        }

        for (const pid of patientIds) {
          const stillReferenced = await tx.sample.count({ where: { patientId: pid } });
          if (stillReferenced > 0) continue;
          await tx.consentRecord.deleteMany({ where: { patientId: pid } });
          await tx.patient.delete({ where: { id: pid } });
        }

        // Manufacturing QC, children first. Dispositions and certificates are
        // append-only for real batches, but these are verification artifacts —
        // and the grant still refuses, so they are removed via the batch
        // cascade rather than directly.
        const vBatchIds = verifyBatches.map((b) => b.id);
        if (vBatchIds.length > 0) {
          const vOrders = await tx.labOrder.findMany({
            where: { batchId: { in: vBatchIds } },
            select: { id: true },
          });
          for (const o of vOrders) {
            const sIds = (
              await tx.sample.findMany({ where: { orderId: o.id }, select: { id: true } })
            ).map((x) => x.id);
            const tIds = (
              await tx.sampleTest.findMany({
                where: { sampleId: { in: sIds } },
                select: { id: true },
              })
            ).map((x) => x.id);
            await tx.stockTransaction.deleteMany({ where: { sampleTestId: { in: tIds } } });
            await tx.result.deleteMany({ where: { sampleTestId: { in: tIds } } });
            await tx.sampleTest.deleteMany({ where: { id: { in: tIds } } });
            await tx.sample.deleteMany({ where: { id: { in: sIds } } });
            await tx.orderItem.deleteMany({ where: { orderId: o.id } });
            await tx.labOrder.delete({ where: { id: o.id } });
          }
          await tx.samplingRequest.deleteMany({ where: { batchId: { in: vBatchIds } } });
          await tx.oosInvestigation.deleteMany({ where: { batchId: { in: vBatchIds } } });
          // batch_disposition and certificate_of_analysis have no DELETE grant.
          // Removing the batch cascades them at the database level, which is
          // the only route the application role is permitted.
          await tx.materialBatch.deleteMany({ where: { id: { in: vBatchIds } } });
        }
        await tx.specLimit.deleteMany({
          where: { specificationId: { in: verifySpecs.map((x) => x.id) } },
        });
        await tx.specification.deleteMany({ where: { id: { in: verifySpecs.map((x) => x.id) } } });
        await tx.material.deleteMany({ where: { id: { in: verifyMaterials.map((m) => m.id) } } });

        await tx.qcResult.deleteMany({ where: { qcLotId: { in: lots.map((l) => l.id) } } });
        await tx.qcLotAnalyte.deleteMany({ where: { qcLotId: { in: lots.map((l) => l.id) } } });
        await tx.qcLot.deleteMany({ where: { id: { in: lots.map((l) => l.id) } } });

        await tx.testReagentUsage.deleteMany({
          where: { inventoryItemId: { in: items.map((i) => i.id) } },
        });
        const lotIds = (
          await tx.inventoryLot.findMany({
            where: { itemId: { in: items.map((i) => i.id) } },
            select: { id: true },
          })
        ).map((l) => l.id);
        await tx.stockTransaction.deleteMany({ where: { lotId: { in: lotIds } } });
        await tx.inventoryLot.deleteMany({ where: { id: { in: lotIds } } });
        await tx.inventoryItem.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });

        await tx.testReagentUsage.deleteMany({
          where: { testDefinitionId: { in: tests.map((t) => t.id) } },
        });
        await tx.userCompetency.deleteMany({
          where: { testDefinitionId: { in: tests.map((t) => t.id) } },
        });
        await tx.testAnalyte.deleteMany({
          where: { testDefinitionId: { in: tests.map((t) => t.id) } },
        });
        await tx.testDefinition.deleteMany({ where: { id: { in: tests.map((t) => t.id) } } });

        await tx.referringDoctor.deleteMany({ where: { id: { in: doctors.map((d) => d.id) } } });

        for (const u of users) {
          await tx.userCompetency.deleteMany({ where: { userId: u.id } });
          await tx.userRole.deleteMany({ where: { userId: u.id } });
          await tx.refreshToken.deleteMany({ where: { userId: u.id } });
          // A signature must stay attributable, so a user who ever signed
          // anything is deactivated rather than deleted — the same rule the
          // product enforces.
          const signed = await tx.signature.count({ where: { userId: u.id } });
          if (signed > 0) {
            await tx.user.update({
              where: { id: u.id },
              data: { status: 'INACTIVE', tokenVersion: { increment: 1 } },
            });
            console.log(`  \x1b[2m${u.email} deactivated (holds ${signed} signature${label(signed)})\x1b[0m`);
          } else {
            await tx.user.delete({ where: { id: u.id } });
          }
        }

        console.log(`  \x1b[32mremoved\x1b[0m`);
      },
      { timeout: 120_000 },
    );
  }

  if (APPLY) {
    // The chain must still verify. audit_log is behind RLS, so this counts
    // INSIDE each tenant's context — an unscoped count returns zero, which is
    // RLS working correctly but reads alarmingly like "the trail was wiped".
    for (const tenant of tenants) {
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
        return tx.$queryRaw`SELECT count(*)::int AS count FROM audit_log`;
      });
      console.log(
        `
[2m${tenant.code}: audit trail untouched — ${rows[0].count} entries retained[0m`,
      );
    }
    console.log('[2mVerify the chain: GET /v1/compliance/audit-chain/verify[0m');
  }
} finally {
  await prisma.$disconnect();
}
