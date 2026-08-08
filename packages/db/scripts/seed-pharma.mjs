#!/usr/bin/env node
/**
 * Seeds the manufacturing QC side: materials, specifications, staff and a
 * consignment in quarantine.
 *
 * Idempotent — safe to re-run. Creates a realistic Indian formulations picture:
 * a paracetamol API from a domestic supplier, its excipients, and a finished
 * product, each with an IP-based specification.
 *
 * Deliberately leaves the demo mid-flow: one batch quarantined awaiting
 * sampling, one under test. An empty stores screen demonstrates nothing.
 *
 * Usage: node packages/db/scripts/seed-pharma.mjs
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '@labsetu/crypto';

const prisma = new PrismaClient();

/** Analytes a QC lab actually measures. Reused where they already exist. */
const ANALYTES = [
  { code: 'DESC', name: 'Description', valueType: 'TEXT', unit: null, precision: 0 },
  { code: 'IDENT', name: 'Identification (IR)', valueType: 'QUALITATIVE', unit: null, precision: 0,
    allowedValues: ['Complies', 'Does not comply'] },
  { code: 'ASSAY', name: 'Assay (HPLC)', valueType: 'NUMERIC', unit: '%', precision: 2 },
  { code: 'LOD', name: 'Loss on drying', valueType: 'NUMERIC', unit: '%', precision: 2 },
  { code: 'SULPH', name: 'Sulphated ash', valueType: 'NUMERIC', unit: '%', precision: 2 },
  { code: 'HMET', name: 'Heavy metals', valueType: 'NUMERIC', unit: 'ppm', precision: 1 },
  { code: 'RELSUB', name: 'Related substances (total)', valueType: 'NUMERIC', unit: '%', precision: 3 },
  { code: 'PH', name: 'pH', valueType: 'NUMERIC', unit: null, precision: 2 },
  { code: 'DISS', name: 'Dissolution', valueType: 'NUMERIC', unit: '%', precision: 1 },
  { code: 'UNIFORM', name: 'Uniformity of dosage units', valueType: 'NUMERIC', unit: '%', precision: 1 },
  { code: 'MICROB', name: 'Total aerobic microbial count', valueType: 'NUMERIC', unit: 'cfu/g', precision: 0 },
];

const MATERIALS = [
  {
    code: 'API-PCM', name: 'Paracetamol IP', type: 'API', unit: 'kg',
    manufacturer: 'Sri Krishna Pharmaceuticals', pharmacopoeia: 'IP 2022',
    storageCondition: 'Below 25 C, protected from light and moisture',
    retestPeriodDays: 730, handlingNotes: 'Dust mask required when dispensing.',
  },
  {
    code: 'RM-MCC', name: 'Microcrystalline Cellulose PH 102', type: 'RAW_MATERIAL', unit: 'kg',
    manufacturer: 'Sigachi Industries', pharmacopoeia: 'IP 2022',
    storageCondition: 'Below 30 C, dry', retestPeriodDays: 1095,
  },
  {
    code: 'RM-STA', name: 'Maize Starch IP', type: 'RAW_MATERIAL', unit: 'kg',
    manufacturer: 'Roquette India', pharmacopoeia: 'IP 2022',
    storageCondition: 'Below 30 C, dry', retestPeriodDays: 730,
  },
  {
    code: 'PKG-BLS', name: 'PVC/Alu Blister Foil 250mm', type: 'PACKAGING', unit: 'kg',
    manufacturer: 'Bilcare Ltd', storageCondition: 'Below 30 C',
  },
  {
    code: 'FP-PCM500', name: 'Paracetamol Tablets IP 500 mg', type: 'FINISHED_PRODUCT', unit: 'tablets',
    pharmacopoeia: 'IP 2022', storageCondition: 'Below 30 C, protected from light',
    retestPeriodDays: 1095,
  },
];

/** Specification criteria per material, IP-style. */
const SPECS = {
  'API-PCM': {
    code: 'SPEC/API-PCM', basis: 'IP 2022 monograph, Paracetamol',
    limits: [
      { analyte: 'DESC', text: 'A white crystalline powder', critical: true },
      { analyte: 'IDENT', text: 'Complies with the IR reference spectrum', critical: true },
      { analyte: 'ASSAY', min: 99.0, max: 101.0, unit: '%', critical: true },
      { analyte: 'LOD', max: 0.5, unit: '%', critical: false },
      { analyte: 'SULPH', max: 0.1, unit: '%', critical: false },
      { analyte: 'HMET', max: 20, unit: 'ppm', critical: true },
      { analyte: 'RELSUB', max: 0.5, unit: '%', critical: true },
    ],
  },
  'RM-MCC': {
    code: 'SPEC/RM-MCC', basis: 'IP 2022 monograph, Cellulose Microcrystalline',
    limits: [
      { analyte: 'DESC', text: 'A white or almost white fine powder', critical: true },
      { analyte: 'IDENT', text: 'Complies', critical: true },
      { analyte: 'LOD', max: 6.0, unit: '%', critical: true },
      { analyte: 'PH', min: 5.0, max: 7.5, critical: false },
      { analyte: 'MICROB', max: 1000, unit: 'cfu/g', critical: true },
    ],
  },
  'RM-STA': {
    code: 'SPEC/RM-STA', basis: 'IP 2022 monograph, Maize Starch',
    limits: [
      { analyte: 'DESC', text: 'A white or almost white fine powder', critical: true },
      { analyte: 'IDENT', text: 'Complies', critical: true },
      { analyte: 'LOD', max: 15.0, unit: '%', critical: true },
      { analyte: 'PH', min: 4.5, max: 7.0, critical: false },
      { analyte: 'SULPH', max: 0.6, unit: '%', critical: false },
    ],
  },
  'FP-PCM500': {
    code: 'SPEC/FP-PCM500', basis: 'IP 2022 monograph, Paracetamol Tablets',
    limits: [
      { analyte: 'DESC', text: 'White, capsule-shaped, uncoated tablets', critical: true },
      { analyte: 'IDENT', text: 'Complies', critical: true },
      { analyte: 'ASSAY', min: 95.0, max: 105.0, unit: '%', critical: true },
      { analyte: 'DISS', min: 80.0, unit: '%', critical: true },
      { analyte: 'UNIFORM', min: 85.0, max: 115.0, unit: '%', critical: true },
      { analyte: 'RELSUB', max: 0.5, unit: '%', critical: false },
    ],
  },
};

const STAFF = [
  { email: 'stores@sunrise.test', name: 'Ramesh Patil', role: 'STORES', qual: null },
  { email: 'qc@sunrise.test', name: 'Deepa Krishnan', role: 'QC_ANALYST', qual: 'M.Sc (Analytical Chemistry)' },
  { email: 'qa@sunrise.test', name: 'Dr Vikram Sethi', role: 'QA', qual: 'Ph.D (Pharmaceutics)' },
];

const PASSWORD = 'LabSetu@2026';

const log = (msg) => console.log(`  ${msg}`);

try {
  const tenants = await prisma.$queryRaw`SELECT * FROM labsetu_list_tenants()`;

  for (const tenant of tenants) {
    console.log(`\n\x1b[1m${tenant.code}\x1b[0m`);

    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;

        const lab = await tx.lab.findFirst({ orderBy: { createdAt: 'asc' } });
        if (!lab) {
          log('no site configured — skipped');
          return;
        }

        // --- analytes -------------------------------------------------------
        const analyteByCode = new Map();
        for (const a of ANALYTES) {
          const existing = await tx.analyte.findFirst({ where: { code: a.code } });
          if (existing) {
            analyteByCode.set(a.code, existing);
            continue;
          }
          const created = await tx.analyte.create({
            data: {
              tenantId: tenant.id,
              code: a.code,
              name: a.name,
              valueType: a.valueType,
              defaultUnit: a.unit,
              precision: a.precision,
              allowedValues: a.allowedValues ?? [],
            },
          });
          analyteByCode.set(a.code, created);
        }
        log(`${analyteByCode.size} QC analytes`);

        // --- one test definition per specification -------------------------
        //
        // A single "full analysis" test per material, carrying every analyte
        // the specification names. Real sites split these across HPLC, KF and
        // microbiology worklists; one test keeps the demo readable while
        // exercising the identical code path.
        const testByMaterial = new Map();

        // --- materials, specifications, tests -------------------------------
        for (const m of MATERIALS) {
          let material = await tx.material.findFirst({ where: { code: m.code } });
          if (!material) {
            material = await tx.material.create({
              data: {
                tenantId: tenant.id,
                code: m.code,
                name: m.name,
                type: m.type,
                unit: m.unit,
                manufacturer: m.manufacturer ?? null,
                pharmacopoeia: m.pharmacopoeia ?? null,
                storageCondition: m.storageCondition ?? null,
                retestPeriodDays: m.retestPeriodDays ?? null,
                handlingNotes: m.handlingNotes ?? null,
              },
            });
          }

          const specDef = SPECS[m.code];
          if (!specDef) continue;

          const testCode = `QC-${m.code}`;
          let test = await tx.testDefinition.findFirst({ where: { code: testCode } });
          if (!test) {
            test = await tx.testDefinition.create({
              data: {
                tenantId: tenant.id,
                code: testCode,
                name: `${m.name} — full analysis`,
                department: 'BIOCHEMISTRY',
                price: 0,
                requiresVerification: true,
                instructions: `Test against ${specDef.code}. ${specDef.basis}.`,
                analytes: {
                  create: specDef.limits.map((l, i) => ({
                    tenantId: tenant.id,
                    analyteId: analyteByCode.get(l.analyte).id,
                    sortOrder: i,
                    isMandatory: true,
                  })),
                },
              },
            });
          }
          testByMaterial.set(m.code, test);

          const existingSpec = await tx.specification.findFirst({
            where: { code: specDef.code, status: 'APPROVED' },
          });
          if (existingSpec) continue;

          await tx.specification.create({
            data: {
              tenantId: tenant.id,
              materialId: material.id,
              code: specDef.code,
              version: 1,
              status: 'APPROVED',
              basis: specDef.basis,
              effectiveFrom: new Date(Date.now() - 90 * 864e5),
              approvedAt: new Date(Date.now() - 90 * 864e5),
              limits: {
                create: specDef.limits.map((l, i) => ({
                  tenantId: tenant.id,
                  analyteId: analyteByCode.get(l.analyte).id,
                  testDefinitionId: test.id,
                  sortOrder: i,
                  minValue: l.min ?? null,
                  maxValue: l.max ?? null,
                  textCriteria: l.text ?? null,
                  unit: l.unit ?? null,
                  isCritical: l.critical,
                })),
              },
            },
          });
        }
        log(`${MATERIALS.length} materials, ${Object.keys(SPECS).length} approved specifications`);

        // --- staff ----------------------------------------------------------
        let staffCreated = 0;
        for (const s of STAFF) {
          if (await tx.user.findFirst({ where: { email: s.email } })) continue;
          const role = await tx.role.findFirst({ where: { code: s.role } });
          if (!role) continue;
          await tx.user.create({
            data: {
              tenantId: tenant.id,
              email: s.email,
              passwordHash: await hashPassword(PASSWORD),
              fullName: s.name,
              qualification: s.qual,
              // The demo accounts sign straight in; a real onboarding forces a
              // change at first use.
              mustChangePassword: false,
              roles: { create: { tenantId: tenant.id, roleId: role.id } },
            },
          });
          staffCreated++;
        }
        log(`${staffCreated} manufacturing staff created (${STAFF.length} total)`);

        // --- competency for the QC analyst ----------------------------------
        //
        // Without this the analyst cannot enter a single result — the same gate
        // that applies to a diagnostics technician applies here.
        const analyst = await tx.user.findFirst({ where: { email: 'qc@sunrise.test' } });
        const qaUser = await tx.user.findFirst({ where: { email: 'qa@sunrise.test' } });
        if (analyst && qaUser) {
          for (const test of testByMaterial.values()) {
            for (const level of ['PERFORM', 'VERIFY']) {
              const has = await tx.userCompetency.findFirst({
                where: { userId: analyst.id, testDefinitionId: test.id, level, revokedAt: null },
              });
              if (has) continue;
              await tx.userCompetency.create({
                data: {
                  tenantId: tenant.id,
                  userId: analyst.id,
                  testDefinitionId: test.id,
                  level,
                  validFrom: new Date(Date.now() - 180 * 864e5),
                  validUntil: new Date(Date.now() + 185 * 864e5),
                  grantedBy: qaUser.id,
                  evidenceNote:
                    'Direct observation over 20 parallel runs against the reference analyst; record COMP/QC/2026/007.',
                },
              });
            }
            // QA authorises the analytical result before dispositioning on it.
            const hasAuth = await tx.userCompetency.findFirst({
              where: { userId: qaUser.id, testDefinitionId: test.id, level: 'AUTHORIZE', revokedAt: null },
            });
            if (!hasAuth) {
              await tx.userCompetency.create({
                data: {
                  tenantId: tenant.id,
                  userId: qaUser.id,
                  testDefinitionId: test.id,
                  level: 'AUTHORIZE',
                  validFrom: new Date(Date.now() - 180 * 864e5),
                  validUntil: new Date(Date.now() + 185 * 864e5),
                  grantedBy: qaUser.id,
                  evidenceNote: 'Qualified person designation; record COMP/QA/2026/001.',
                },
              });
            }
          }
          log('competency granted to the QC analyst and QA');
        }

        // --- a consignment in quarantine ------------------------------------
        const existingGrn = await tx.goodsReceipt.findFirst();
        if (existingGrn) {
          log('goods already received — batches left as they are');
          return;
        }

        const api = await tx.material.findFirstOrThrow({ where: { code: 'API-PCM' } });
        const mcc = await tx.material.findFirstOrThrow({ where: { code: 'RM-MCC' } });
        const starch = await tx.material.findFirstOrThrow({ where: { code: 'RM-STA' } });

        const mfd = new Date(Date.now() - 60 * 864e5);

        // Claim the number through the same counter the API uses. Writing a
        // literal here is what makes the FIRST real goods receipt collide with
        // the seeded one — the identical trap the patient-code seeding hit.
        const today = new Date();
        const scope = `GRN:${today.toISOString().slice(0, 10)}`;
        // `updatedAt` is Prisma-managed (@updatedAt) with no database default, so
        // a raw INSERT must supply it or the NOT NULL constraint fires. Raw SQL
        // is used here deliberately: the counter must be claimed atomically with
        // ON CONFLICT, which the query builder cannot express.
        const [{ counter }] = await tx.$queryRaw`
          INSERT INTO accession_counter ("id", "tenantId", "labId", "scope", "counter", "updatedAt")
          VALUES (gen_random_uuid(), ${tenant.id}::uuid, ${lab.id}::uuid, ${scope}, 1, now())
          ON CONFLICT ("tenantId", "labId", "scope")
          DO UPDATE SET "counter" = accession_counter."counter" + 1, "updatedAt" = now()
          RETURNING "counter"
        `;
        const yy = String(today.getUTCFullYear()).slice(2);
        const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(today.getUTCDate()).padStart(2, '0');
        const grnNumber = `GRN${yy}${mm}${dd}${String(counter).padStart(4, '0')}`;

        const grn = await tx.goodsReceipt.create({
          data: {
            tenantId: tenant.id,
            grnNumber,
            supplierName: 'Sri Krishna Pharmaceuticals Ltd',
            invoiceRef: 'SKP/26-27/1184',
            poReference: 'PO/2026/0912',
            receivedBy: null,
            receiptCheckNote:
              'Seals intact on all 20 drums. Vehicle clean and dry. No damage observed.',
            batches: {
              create: [
                {
                  tenantId: tenant.id,
                  materialId: api.id,
                  batchNumber: 'PCM-2601',
                  manufacturerLot: 'SKP/PCM/26/0341',
                  quantityReceived: 500,
                  quantityAvailable: 500,
                  unit: 'kg',
                  containerCount: 20,
                  manufacturedAt: mfd,
                  expiryDate: new Date(Date.now() + 670 * 864e5),
                  retestDate: new Date(mfd.getTime() + 730 * 864e5),
                  status: 'QUARANTINE',
                  location: 'QUARANTINE STORE - RACK A1',
                },
                {
                  tenantId: tenant.id,
                  materialId: mcc.id,
                  batchNumber: 'MCC-2618',
                  manufacturerLot: 'SIG/102/26/8871',
                  quantityReceived: 250,
                  quantityAvailable: 250,
                  unit: 'kg',
                  containerCount: 10,
                  manufacturedAt: mfd,
                  expiryDate: new Date(Date.now() + 1000 * 864e5),
                  retestDate: new Date(mfd.getTime() + 1095 * 864e5),
                  status: 'QUARANTINE',
                  location: 'QUARANTINE STORE - RACK A2',
                },
                {
                  tenantId: tenant.id,
                  materialId: starch.id,
                  batchNumber: 'STA-2604',
                  manufacturerLot: 'RQ/MS/26/2210',
                  quantityReceived: 150,
                  quantityAvailable: 150,
                  unit: 'kg',
                  containerCount: 6,
                  manufacturedAt: mfd,
                  expiryDate: new Date(Date.now() + 660 * 864e5),
                  retestDate: new Date(mfd.getTime() + 730 * 864e5),
                  status: 'QUARANTINE',
                  location: 'QUARANTINE STORE - RACK A3',
                },
              ],
            },
          },
          include: { batches: true },
        });

        log(`${grn.grnNumber}: ${grn.batches.length} batches in quarantine`);
      },
      { timeout: 180_000 },
    );
  }

  console.log('\n\x1b[2mSign in as stores@ / qc@ / qa@sunrise.test to walk the release chain.\x1b[0m');
} finally {
  await prisma.$disconnect();
}
