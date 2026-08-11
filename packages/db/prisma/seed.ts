/**
 * Seeds a realistic mid-size Indian pharmaceutical manufacturer.
 *
 * Not a toy fixture. The materials, specifications, batches and QC tests mirror
 * what a formulations plant working to revised Schedule M actually runs, so the
 * system is demo-able to a Head of Quality on day one — and so the QA screens
 * have something real to show rather than an empty state.
 *
 * The data deliberately includes the awkward cases, because those are what a
 * knowledgeable visitor asks about:
 *
 *   - a batch sitting in QUARANTINE awaiting sampling
 *   - a batch UNDER_TEST with results part-entered
 *   - a batch APPROVED with a released Certificate of Analysis
 *   - a batch REJECTED off the back of a closed OOS investigation
 *   - a batch APPROVED_WITH_DEVIATION, where a non-critical limit was exceeded
 *     and QA accepted it with a written rationale
 *
 * Everything runs inside ONE transaction with app.tenant_id set, because RLS is
 * active for the seed too (ADR 0002). There is no privileged back door.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import {
  generateKey,
  wrapKey,
  masterKeyFromBase64,
  hashPassword,
  AUDIT_GENESIS_HASH,
} from '@labsetu/crypto';
import { DEFAULT_ROLES, PHARMA_ROLE_CODES } from '@labsetu/contracts';

const prisma = new PrismaClient();

/**
 * Overridable so this seed can add a manufacturing tenant to a database that
 * already carries one from an earlier run, instead of refusing because the
 * fixed id is taken. Two tenants side by side is also the honest way to show
 * row-level isolation: sign into each and the other's data does not exist.
 */
const TENANT_ID = process.env.SEED_TENANT_ID ?? '0195c0de-0000-7000-8000-000000000001';
const DEMO_PASSWORD = 'LabSetu@2026';

const masterKey = masterKeyFromBase64(requireEnv('ENCRYPTION_MASTER_KEY'));

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.startsWith('CHANGE_ME')) {
    throw new Error(`${name} is missing or still a placeholder. Run: node scripts/setup-env.mjs`);
  }
  return v;
}

const d = (v: number | string) => new Prisma.Decimal(v);
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5);
const daysAhead = (n: number) => new Date(Date.now() + n * 864e5);

async function main() {
  console.log('\n  Seeding LabSetu — pharmaceutical manufacturing\n');

  // The seed deliberately refuses to overwrite an existing tenant: audit_log is
  // append-only at the database level (ADR 0003), so it cannot clean up after
  // itself. That the seed cannot work around this is the guarantee working.
  const existing = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM tenant WHERE id = ${TENANT_ID}::uuid
  `;
  if ((existing[0]?.count ?? 0n) > 0n) {
    console.error(
      '  The demo tenant already exists.\n\n' +
        '  The audit trail is append-only, so the seed cannot delete it and start over.\n' +
        '  To rebuild from scratch:  npm run db:reset\n',
    );
    process.exit(1);
  }

  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${TENANT_ID}, true)`;

      // ---------------------------------------------------------------- tenant
      const tenantDek = generateKey();

      const tenant = await tx.tenant.create({
        data: {
          id: TENANT_ID,
          code: 'VANTAGE',
          name: 'Vantage Pharmaceuticals',
          legalName: 'Vantage Pharmaceuticals Pvt Ltd',
          gstin: '36AABCV7391K1ZP',
          pan: 'AABCV7391K',
          addressLine1: 'Plot 27, Genome Valley, Shamirpet',
          city: 'Hyderabad',
          state: 'Telangana',
          stateCode: '36',
          pincode: '500078',
          phone: '+914027150900',
          email: 'quality@vantagepharma.example',
          // A manufacturing licence rather than a NABL certificate — this is a
          // CDSCO-regulated plant, not an accredited diagnostic lab.
          nablCertNo: 'MFG/TS/2021/000418',
          nablValidTill: new Date('2029-12-31'),
          // The tenant's data-encryption key, wrapped by the master key
          // (ADR 0005). Without it every field-level encrypt/decrypt fails —
          // device enrolment secrets and TOTP seeds both live behind it — and
          // the failure only surfaces the first time one is needed.
          dataKeyEnc: wrapKey(tenantDek, masterKey),
        },
      });
      console.log(`    tenant       ${tenant.name} (${tenant.code})`);

      await tx.auditChainHead.create({
        data: { tenantId: TENANT_ID, seq: 0n, headHash: AUDIT_GENESIS_HASH },
      });

      await tx.tenantPolicy.createMany({
        data: [
          { tenantId: TENANT_ID, key: 'tenant.vertical', value: 'PHARMA_MANUFACTURING' },
          // Four-eyes: the analyst who generated a result may not approve it.
          { tenantId: TENANT_ID, key: 'result.fourEyesRequired', value: true },
          { tenantId: TENANT_ID, key: 'qc.blockAuthorizationOnFailure', value: true },
          { tenantId: TENANT_ID, key: 'result.deltaCheckPercent', value: 30 },
          // A batch may not be dispositioned until every test on it is approved.
          { tenantId: TENANT_ID, key: 'batch.requireAllTestsApproved', value: true },
          // Schedule M / Part 11: retention of manufacturing records.
          { tenantId: TENANT_ID, key: 'retention.batchRecordYears', value: 6 },
          { tenantId: TENANT_ID, key: 'mfa.requiredForPrivilegedRoles', value: true },
        ],
      });

      // ------------------------------------------------------------ plant sites
      const unit1 = await tx.lab.create({
        data: {
          tenantId: TENANT_ID,
          code: 'U1',
          name: 'Unit I — Oral Solid Dosage (Shamirpet)',
          addressLine1: 'Plot 27, Genome Valley, Shamirpet',
          city: 'Hyderabad',
          state: 'Telangana',
          pincode: '500078',
          phone: '+914027150900',
        },
      });

      const unit2 = await tx.lab.create({
        data: {
          tenantId: TENANT_ID,
          code: 'U2',
          name: 'Unit II — API (Jeedimetla)',
          addressLine1: 'Survey 118, IDA Jeedimetla',
          city: 'Hyderabad',
          state: 'Telangana',
          pincode: '500055',
          phone: '+914027150950',
        },
      });
      console.log(`    sites        ${unit1.code}, ${unit2.code}`);

      // ----------------------------------------------------------------- roles
      const roles: Record<string, string> = {};
      // Only the roles a manufacturing site actually staffs. Seeding the full
      // template set would put "Phlebotomist" in this tenant's user form.
      for (const code of PHARMA_ROLE_CODES) {
        const def = DEFAULT_ROLES[code];
        const role = await tx.role.create({
          data: {
            tenantId: TENANT_ID,
            code,
            name: def.name,
            description: def.description,
            permissions: def.permissions,
            isSystem: true,
          },
        });
        roles[code] = role.id;
      }
      console.log(`    roles        ${Object.keys(roles).length} seeded`);

      // ----------------------------------------------------------------- users
      const passwordHash = await hashPassword(DEMO_PASSWORD);

      const mkUser = async (
        email: string,
        fullName: string,
        roleCode: string,
        extra: Record<string, unknown> = {},
      ) => {
        const user = await tx.user.create({
          data: { tenantId: TENANT_ID, email, passwordHash, fullName, ...extra },
        });
        await tx.userRole.create({
          data: { tenantId: TENANT_ID, userId: user.id, roleId: roles[roleCode]! },
        });
        return user;
      };

      const admin = await mkUser('admin@vantage.test', 'Anita Rao', 'LAB_ADMIN', {
        qualification: 'M.Pharm · Head of Quality',
      });
      const qa = await mkUser('qa@vantage.test', 'Dr. Suresh Menon', 'QA', {
        qualification: 'M.Pharm, PhD · QA Manager',
        registrationNo: 'TSPC/QA/4471',
      });
      const qa2 = await mkUser('qa2@vantage.test', 'Kavita Reddy', 'QA', {
        qualification: 'M.Pharm · Deputy Manager QA',
        registrationNo: 'TSPC/QA/5518',
      });
      const analyst = await mkUser('qc@vantage.test', 'Ravi Teja', 'QC_ANALYST', {
        qualification: 'M.Sc Analytical Chemistry',
      });
      const analyst2 = await mkUser('qc2@vantage.test', 'Priya Sharma', 'QC_ANALYST', {
        qualification: 'M.Sc Chemistry',
      });
      const stores = await mkUser('stores@vantage.test', 'Sunil Kumar', 'STORES', {
        qualification: 'B.Sc · Stores Officer',
      });
      const auditor = await mkUser('auditor@vantage.test', 'M. Krishnan', 'AUDITOR', {
        qualification: 'Corporate Quality Audit',
      });
      console.log(`    users        7 (password: ${DEMO_PASSWORD})`);

      // -------------------------------------------------------- reference data
      const specimens = await createMany(tx.specimenType, TENANT_ID, [
        { code: 'POWD', name: 'Powder' },
        { code: 'TAB', name: 'Tablet' },
        { code: 'GRAN', name: 'Granules' },
        { code: 'LIQ', name: 'Liquid' },
        { code: 'FOIL', name: 'Packaging Foil' },
      ]);

      const containers = await createMany(tx.containerType, TENANT_ID, [
        { code: 'AMB', name: 'Amber Glass Bottle', colour: 'Amber' },
        { code: 'POLY', name: 'LDPE Poly Bag (double-lined)', colour: 'Clear' },
        { code: 'HDPE', name: 'HDPE Container', colour: 'White' },
        { code: 'ALFO', name: 'Aluminium Foil Pouch', colour: 'Silver' },
      ]);

      // Rejection reasons for a manufacturing sample, not a clinical specimen.
      await createMany(tx.rejectionReason, TENANT_ID, [
        { code: 'INSUF', name: 'Insufficient quantity drawn', category: 'SAMPLING' },
        { code: 'CONTAM', name: 'Sample contaminated during handling', category: 'SAMPLING' },
        { code: 'MISLBL', name: 'Sample container mislabelled', category: 'IDENTIFICATION' },
        { code: 'SEAL', name: 'Container seal compromised', category: 'INTEGRITY' },
        { code: 'TEMP', name: 'Storage temperature excursion', category: 'INTEGRITY' },
        { code: 'WRSAMP', name: 'Wrong batch sampled', category: 'IDENTIFICATION' },
      ]);

      const methods = await createMany(tx.method, TENANT_ID, [
        { code: 'HPLC', name: 'HPLC', principle: 'Reverse-phase chromatography', sopRef: 'SOP/QC/012' },
        { code: 'UV', name: 'UV-Vis Spectrophotometry', principle: 'Absorbance', sopRef: 'SOP/QC/008' },
        { code: 'IR', name: 'FTIR Spectroscopy', principle: 'Infrared absorption', sopRef: 'SOP/QC/009' },
        { code: 'KF', name: 'Karl Fischer Titration', principle: 'Coulometric', sopRef: 'SOP/QC/015' },
        { code: 'GRAV', name: 'Gravimetry', principle: 'Loss on drying', sopRef: 'SOP/QC/004' },
        { code: 'VIS', name: 'Visual Inspection', principle: 'Organoleptic', sopRef: 'SOP/QC/001' },
        { code: 'DISS', name: 'Dissolution (USP Apparatus II)', principle: 'Paddle', sopRef: 'SOP/QC/021' },
        { code: 'MLT', name: 'Microbial Limit Test', principle: 'Plate count', sopRef: 'SOP/MB/003' },
      ]);
      console.log(
        `    reference    ${specimens.size} specimen types, ${containers.size} containers, ${methods.size} methods`,
      );

      // -------------------------------------------------------------- analytes
      const analytes = await createMany(tx.analyte, TENANT_ID, [
        {
          code: 'DESC',
          name: 'Description',
          valueType: 'QUALITATIVE' as const,
          // "Complies" is a legitimate entry against a textual criterion — an
          // analyst records conformance to the written description rather than
          // re-typing it. Omitting it makes the field reject the normal answer.
          allowedValues: [
            'Complies',
            'White to off-white crystalline powder',
            'White crystalline powder',
            'White capsule-shaped uncoated tablets',
            'White to off-white powder',
            'Off-white powder',
            'Does not comply',
          ],
        },
        {
          code: 'IDEN',
          name: 'Identification (IR)',
          valueType: 'QUALITATIVE' as const,
          allowedValues: ['Complies', 'Does not comply'],
        },
        { code: 'ASSAY', name: 'Assay (on dried basis)', defaultUnit: '%', precision: 2 },
        { code: 'LOD', name: 'Loss on Drying', defaultUnit: '%', precision: 2 },
        { code: 'WATER', name: 'Water Content (KF)', defaultUnit: '%', precision: 2 },
        { code: 'SASH', name: 'Sulphated Ash', defaultUnit: '%', precision: 2 },
        { code: 'HMET', name: 'Heavy Metals', defaultUnit: 'ppm', precision: 1, valueType: 'NUMERIC_BOUNDED' as const },
        { code: 'RSUB', name: 'Related Substances (total)', defaultUnit: '%', precision: 3 },
        { code: 'RSING', name: 'Single Max Impurity', defaultUnit: '%', precision: 3 },
        { code: 'RESSOL', name: 'Residual Solvents', defaultUnit: 'ppm', precision: 0, valueType: 'NUMERIC_BOUNDED' as const },
        { code: 'PH', name: 'pH (5% solution)', defaultUnit: '', precision: 2 },
        { code: 'BDEN', name: 'Bulk Density', defaultUnit: 'g/mL', precision: 3 },
        { code: 'PSIZE', name: 'Particle Size (D90)', defaultUnit: 'µm', precision: 1 },
        { code: 'DISS', name: 'Dissolution (30 min)', defaultUnit: '%', precision: 1 },
        { code: 'UWT', name: 'Uniformity of Weight', defaultUnit: '%', precision: 2 },
        { code: 'DISINT', name: 'Disintegration Time', defaultUnit: 'min', precision: 1 },
        { code: 'HARD', name: 'Hardness', defaultUnit: 'N', precision: 0 },
        { code: 'FRIA', name: 'Friability', defaultUnit: '%', precision: 2 },
        { code: 'TAMC', name: 'Total Aerobic Microbial Count', defaultUnit: 'cfu/g', precision: 0 },
        { code: 'TYMC', name: 'Total Yeast & Mould Count', defaultUnit: 'cfu/g', precision: 0 },
        {
          code: 'ECOLI',
          name: 'E. coli',
          valueType: 'QUALITATIVE' as const,
          allowedValues: ['Absent', 'Present'],
        },
        { code: 'GSM', name: 'Grammage', defaultUnit: 'g/m²', precision: 1 },
        { code: 'THICK', name: 'Thickness', defaultUnit: 'µm', precision: 1 },
      ]);
      console.log(`    analytes     ${analytes.size}`);

      // ----------------------------------------------------------------- tests
      const tests = new Map<string, string>();

      const mkTest = async (
        code: string,
        name: string,
        department: string,
        analyteCodes: string[],
        opts: { method: string; specimen: string; container: string; tatMinutes: number; sop?: string },
      ) => {
        const t = await tx.testDefinition.create({
          data: {
            tenantId: TENANT_ID,
            code,
            name,
            department: department as never,
            methodId: methods.get(opts.method)!,
            specimenTypeId: specimens.get(opts.specimen)!,
            containerTypeId: containers.get(opts.container)!,
            price: d(0), // internal QC: no price, this is not a service lab
            tatMinutes: opts.tatMinutes,
            instructions: opts.sop ? `Per ${opts.sop}` : null,
          },
        });
        tests.set(code, t.id);
        await tx.testAnalyte.createMany({
          data: analyteCodes.map((c, i) => ({
            tenantId: TENANT_ID,
            testDefinitionId: t.id,
            analyteId: analytes.get(c)!,
            sortOrder: i,
          })),
        });
        return t;
      };

      await mkTest('TDESC', 'Description', 'CHEMICAL', ['DESC'], {
        method: 'VIS',
        specimen: 'POWD',
        container: 'POLY',
        tatMinutes: 30,
        sop: 'SOP/QC/001',
      });
      await mkTest('TIDEN', 'Identification by IR', 'INSTRUMENTATION', ['IDEN'], {
        method: 'IR',
        specimen: 'POWD',
        container: 'POLY',
        tatMinutes: 120,
        sop: 'SOP/QC/009',
      });
      await mkTest('TASSAY', 'Assay by HPLC', 'INSTRUMENTATION', ['ASSAY'], {
        method: 'HPLC',
        specimen: 'POWD',
        container: 'AMB',
        tatMinutes: 480,
        sop: 'SOP/QC/012',
      });
      await mkTest('TLOD', 'Loss on Drying', 'CHEMICAL', ['LOD'], {
        method: 'GRAV',
        specimen: 'POWD',
        container: 'POLY',
        tatMinutes: 240,
        sop: 'SOP/QC/004',
      });
      await mkTest('TWATER', 'Water Content by KF', 'INSTRUMENTATION', ['WATER'], {
        method: 'KF',
        specimen: 'POWD',
        container: 'AMB',
        tatMinutes: 120,
        sop: 'SOP/QC/015',
      });
      await mkTest('TSASH', 'Sulphated Ash', 'CHEMICAL', ['SASH'], {
        method: 'GRAV',
        specimen: 'POWD',
        container: 'POLY',
        tatMinutes: 360,
        sop: 'SOP/QC/006',
      });
      await mkTest('TRSUB', 'Related Substances by HPLC', 'INSTRUMENTATION', ['RSUB', 'RSING'], {
        method: 'HPLC',
        specimen: 'POWD',
        container: 'AMB',
        tatMinutes: 600,
        sop: 'SOP/QC/013',
      });
      await mkTest('THMET', 'Heavy Metals', 'CHEMICAL', ['HMET'], {
        method: 'UV',
        specimen: 'POWD',
        container: 'AMB',
        tatMinutes: 300,
        sop: 'SOP/QC/018',
      });
      await mkTest('TPHYS', 'Physical Parameters', 'CHEMICAL', ['PH', 'BDEN', 'PSIZE'], {
        method: 'UV',
        specimen: 'POWD',
        container: 'POLY',
        tatMinutes: 180,
        sop: 'SOP/QC/003',
      });
      await mkTest('TDISS', 'Dissolution', 'INSTRUMENTATION', ['DISS'], {
        method: 'DISS',
        specimen: 'TAB',
        container: 'HDPE',
        tatMinutes: 300,
        sop: 'SOP/QC/021',
      });
      await mkTest(
        'TTAB',
        'Tablet Physical Tests',
        'CHEMICAL',
        ['UWT', 'DISINT', 'HARD', 'FRIA'],
        { method: 'VIS', specimen: 'TAB', container: 'HDPE', tatMinutes: 240, sop: 'SOP/QC/022' },
      );
      await mkTest('TMLT', 'Microbial Limit Test', 'MICROBIOLOGY', ['TAMC', 'TYMC', 'ECOLI'], {
        method: 'MLT',
        specimen: 'POWD',
        container: 'POLY',
        tatMinutes: 7200, // 5 days incubation
        sop: 'SOP/MB/003',
      });
      await mkTest('TPACK', 'Packaging Material Tests', 'PACKAGING_DEVELOPMENT', ['GSM', 'THICK'], {
        method: 'VIS',
        specimen: 'FOIL',
        container: 'ALFO',
        tatMinutes: 180,
        sop: 'SOP/QC/031',
      });
      console.log(`    tests        ${tests.size}`);

      // ------------------------------------------------------------ competency
      //
      // Deliberately NOT a uniform block. A real competency matrix has holes in
      // it, and the holes are the point: they are what the authorisation gate
      // enforces. Priya joined this year and is signed off on the physical and
      // wet-chemistry methods but not yet on microbiology or dissolution, so
      // the matrix screen shows a genuine gap rather than a wall of green.
      //
      // Assessment dates are staggered too. Everyone qualifying on the same day
      // and expiring on the same day is the signature of a bulk import, and it
      // is the first thing an assessor asks to see the records behind.
      const MICRO_AND_SPECIALIST = new Set(['TMLT', 'TDISS']);

      const competency: Prisma.UserCompetencyCreateManyInput[] = [];
      for (const [code, testId] of tests.entries()) {
        const junior = !MICRO_AND_SPECIALIST.has(code);

        const grants: [string, string, string, string][] = [
          // [userId, level, validFrom, validUntil]
          [analyst.id, 'PERFORM', '2024-04-15', '2027-04-14'],
          [analyst.id, 'VERIFY', '2025-06-02', '2027-06-01'],
          [qa.id, 'VERIFY', '2023-11-20', '2027-11-19'],
          [qa.id, 'AUTHORIZE', '2023-11-20', '2027-11-19'],
          [qa2.id, 'AUTHORIZE', '2025-02-10', '2027-02-09'],
        ];
        if (junior) grants.push([analyst2.id, 'PERFORM', '2026-03-01', '2028-02-29']);

        for (const [userId, level, from, until] of grants) {
          competency.push({
            tenantId: TENANT_ID,
            userId,
            testDefinitionId: testId,
            level: level as never,
            validFrom: new Date(from),
            validUntil: new Date(until),
            grantedBy: admin.id,
            evidenceNote:
              userId === analyst2.id
                ? 'Initial qualification: 20 parallel determinations against Ravi Teja, ' +
                  'reviewed by QA. Record COMP/26/0031, SOP/HR/007.'
                : 'Annual re-assessment per SOP/HR/007; direct observation plus review of ' +
                  'twenty consecutive results against the qualified analyst.',
          });
        }
      }
      await tx.userCompetency.createMany({ data: competency });
      console.log(
        `    competency   ${competency.length} records (Priya not yet qualified on microbiology/dissolution)`,
      );

      // ------------------------------------------------------------- materials
      const materials = new Map<string, string>();
      // Retest period per material, so a seeded batch derives its retest date
      // the same way the goods-receipt endpoint does rather than by a constant.
      const materialRetest = new Map<string, number | null>();
      const mkMaterial = async (data: {
        code: string;
        name: string;
        type: string;
        unit: string;
        manufacturer?: string;
        pharmacopoeia?: string;
        storageCondition?: string;
        retestPeriodDays?: number;
        handlingNotes?: string;
      }) => {
        const m = await tx.material.create({
          data: { tenantId: TENANT_ID, ...data, type: data.type as never },
        });
        materials.set(m.code, m.id);
        materialRetest.set(m.code, data.retestPeriodDays ?? null);
        return m;
      };

      await mkMaterial({
        code: 'API-PCM',
        name: 'Paracetamol IP',
        type: 'API',
        unit: 'kg',
        manufacturer: 'Sri Krishna Pharmaceuticals',
        pharmacopoeia: 'IP 2022',
        storageCondition: 'Below 30 °C, protected from light and moisture',
        retestPeriodDays: 1095,
      });
      await mkMaterial({
        code: 'API-MET',
        name: 'Metformin Hydrochloride IP',
        type: 'API',
        unit: 'kg',
        manufacturer: 'Harman Finochem',
        pharmacopoeia: 'IP 2022',
        storageCondition: 'Below 30 °C, in tightly closed containers',
        retestPeriodDays: 1095,
      });
      await mkMaterial({
        code: 'RM-MCC',
        name: 'Microcrystalline Cellulose PH-102',
        type: 'RAW_MATERIAL',
        unit: 'kg',
        manufacturer: 'Signet Chemical',
        pharmacopoeia: 'IP/BP/USP-NF',
        storageCondition: 'Below 30 °C, dry',
        retestPeriodDays: 730,
      });
      await mkMaterial({
        code: 'RM-MGST',
        name: 'Magnesium Stearate IP',
        type: 'RAW_MATERIAL',
        unit: 'kg',
        manufacturer: 'Nitika Pharmaceutical',
        pharmacopoeia: 'IP 2022',
        storageCondition: 'Below 30 °C, dry',
        retestPeriodDays: 730,
        handlingNotes: 'Lubricant — over-blending reduces dissolution. Handle per SOP/PR/019.',
      });
      await mkMaterial({
        code: 'RM-PVP',
        name: 'Povidone K-30 IP',
        type: 'RAW_MATERIAL',
        unit: 'kg',
        manufacturer: 'Boai NKY',
        pharmacopoeia: 'IP 2022',
        storageCondition: 'Below 25 °C, protected from moisture — hygroscopic',
        retestPeriodDays: 730,
        handlingNotes: 'Hygroscopic. Reseal immediately after dispensing.',
      });
      await mkMaterial({
        code: 'PM-ALU',
        name: 'Alu-Alu Blister Foil 45 µm',
        type: 'PACKAGING',
        unit: 'kg',
        manufacturer: 'Bilcare',
        storageCondition: 'Below 30 °C, dry, flat storage',
      });
      await mkMaterial({
        code: 'FP-PCM500',
        name: 'Paracetamol Tablets IP 500 mg',
        type: 'FINISHED_PRODUCT',
        unit: 'nos',
        pharmacopoeia: 'IP 2022',
        storageCondition: 'Store below 30 °C, protected from light and moisture',
      });
      console.log(`    materials    ${materials.size}`);

      // -------------------------------------------------------- specifications
      const specs = new Map<string, string>();

      const mkSpec = async (
        materialCode: string,
        code: string,
        basis: string,
        limits: {
          analyte: string;
          test?: string;
          min?: number;
          max?: number;
          text?: string;
          unit?: string;
          critical?: boolean;
        }[],
      ) => {
        const spec = await tx.specification.create({
          data: {
            tenantId: TENANT_ID,
            materialId: materials.get(materialCode)!,
            code,
            version: 1,
            status: 'APPROVED',
            basis,
            effectiveFrom: daysAgo(200),
            approvedBy: qa.id,
            approvedAt: daysAgo(200),
            createdBy: admin.id,
          },
        });
        specs.set(code, spec.id);

        await tx.specLimit.createMany({
          data: limits.map((l, i) => ({
            tenantId: TENANT_ID,
            specificationId: spec.id,
            analyteId: analytes.get(l.analyte)!,
            testDefinitionId: l.test ? tests.get(l.test)! : null,
            sortOrder: i,
            minValue: l.min !== undefined ? d(l.min) : null,
            maxValue: l.max !== undefined ? d(l.max) : null,
            textCriteria: l.text ?? null,
            unit: l.unit ?? null,
            isCritical: l.critical ?? true,
          })),
        });
        return spec;
      };

      await mkSpec('API-PCM', 'SPEC/API-PCM/01', 'IP 2022 monograph — Paracetamol', [
        { analyte: 'DESC', test: 'TDESC', text: 'White crystalline powder' },
        { analyte: 'IDEN', test: 'TIDEN', text: 'Complies by IR' },
        // IP is 99.0-101.0 % on the dried basis. 98.0-102.0 is the USP range,
        // and citing one pharmacopoeia while using another's limits is the first
        // thing a QC head checks on a specification.
        { analyte: 'ASSAY', test: 'TASSAY', min: 99.0, max: 101.0, unit: '%' },
        { analyte: 'LOD', test: 'TLOD', max: 0.5, unit: '%' },
        { analyte: 'SASH', test: 'TSASH', max: 0.1, unit: '%', critical: false },
        { analyte: 'RSUB', test: 'TRSUB', max: 0.5, unit: '%' },
        { analyte: 'RSING', test: 'TRSUB', max: 0.1, unit: '%' },
        { analyte: 'HMET', test: 'THMET', max: 20, unit: 'ppm' },
      ]);

      await mkSpec('API-MET', 'SPEC/API-MET/01', 'IP 2022 monograph — Metformin HCl', [
        { analyte: 'DESC', test: 'TDESC', text: 'White crystalline powder' },
        { analyte: 'IDEN', test: 'TIDEN', text: 'Complies by IR' },
        { analyte: 'ASSAY', test: 'TASSAY', min: 98.5, max: 101.0, unit: '%' },
        { analyte: 'WATER', test: 'TWATER', max: 0.5, unit: '%' },
        { analyte: 'RSUB', test: 'TRSUB', max: 0.3, unit: '%' },
      ]);

      await mkSpec('RM-MCC', 'SPEC/RM-MCC/01', 'IP/USP-NF — Microcrystalline Cellulose', [
        { analyte: 'DESC', test: 'TDESC', text: 'White to off-white powder' },
        { analyte: 'LOD', test: 'TLOD', max: 5.0, unit: '%' },
        { analyte: 'PH', test: 'TPHYS', min: 5.0, max: 7.5, critical: false },
        { analyte: 'BDEN', test: 'TPHYS', min: 0.28, max: 0.38, unit: 'g/mL', critical: false },
        { analyte: 'TAMC', test: 'TMLT', max: 1000, unit: 'cfu/g' },
        { analyte: 'ECOLI', test: 'TMLT', text: 'Absent' },
      ]);

      await mkSpec('RM-MGST', 'SPEC/RM-MGST/01', 'IP 2022 — Magnesium Stearate', [
        { analyte: 'DESC', test: 'TDESC', text: 'White to off-white powder' },
        { analyte: 'ASSAY', test: 'TASSAY', min: 4.0, max: 5.0, unit: '%' },
        { analyte: 'LOD', test: 'TLOD', max: 6.0, unit: '%' },
      ]);

      await mkSpec('PM-ALU', 'SPEC/PM-ALU/01', 'Internal standard — Alu-Alu foil', [
        { analyte: 'GSM', test: 'TPACK', min: 118, max: 132, unit: 'g/m²' },
        { analyte: 'THICK', test: 'TPACK', min: 42, max: 48, unit: 'µm' },
      ]);

      await mkSpec('FP-PCM500', 'SPEC/FP-PCM500/01', 'IP 2022 — Paracetamol Tablets', [
        { analyte: 'DESC', test: 'TDESC', text: 'White capsule-shaped uncoated tablets' },
        { analyte: 'ASSAY', test: 'TASSAY', min: 95.0, max: 105.0, unit: '%' },
        { analyte: 'DISS', test: 'TDISS', min: 80.0, unit: '%' },
        { analyte: 'UWT', test: 'TTAB', max: 5.0, unit: '%' },
        { analyte: 'DISINT', test: 'TTAB', max: 15, unit: 'min' },
        { analyte: 'HARD', test: 'TTAB', min: 40, max: 90, unit: 'N', critical: false },
        { analyte: 'FRIA', test: 'TTAB', max: 1.0, unit: '%', critical: false },
      ]);
      console.log(`    specs        ${specs.size} approved specifications`);

      // -------------------------------------------------------- goods receipts
      let grnSeq = 0;
      const mkGrn = async (supplier: string, opts: { po: string; invoice: string; ago: number; note?: string }) => {
        grnSeq++;
        return tx.goodsReceipt.create({
          data: {
            tenantId: TENANT_ID,
            grnNumber: `GRN/26/${String(grnSeq).padStart(4, '0')}`,
            supplierName: supplier,
            poReference: opts.po,
            invoiceRef: opts.invoice,
            receivedAt: daysAgo(opts.ago),
            receivedBy: stores.id,
            receiptCheckNote: opts.note ?? 'Containers intact, seals verified, no damage on visual check.',
          },
        });
      };

      const grn1 = await mkGrn('Sri Krishna Pharmaceuticals', { po: 'PO/26/0311', invoice: 'SKP/8842', ago: 26 });
      const grn2 = await mkGrn('Harman Finochem Ltd', { po: 'PO/26/0318', invoice: 'HF/2291', ago: 19 });
      const grn3 = await mkGrn('Signet Chemical Corp', { po: 'PO/26/0324', invoice: 'SC/5517', ago: 12 });
      const grn4 = await mkGrn('Nitika Pharmaceutical', { po: 'PO/26/0330', invoice: 'NP/1104', ago: 6 });
      const grn5 = await mkGrn('Bilcare Ltd', {
        po: 'PO/26/0333',
        invoice: 'BC/7730',
        ago: 3,
        note: 'One pallet showed minor corner crush; affected reels segregated and noted.',
      });

      // -------------------------------------------------------------- batches
      const batches = new Map<string, { id: string; number: string }>();

      const mkBatch = async (
        key: string,
        materialCode: string,
        grnId: string | null,
        data: {
          batchNumber: string;
          manufacturerLot?: string;
          qty: number;
          unit: string;
          containers: number;
          mfgAgo: number;
          expiryIn: number;
          status: string;
          location: string;
          dispositionedAgo?: number;
        },
      ) => {
        const b = await tx.materialBatch.create({
          data: {
            tenantId: TENANT_ID,
            materialId: materials.get(materialCode)!,
            goodsReceiptId: grnId,
            batchNumber: data.batchNumber,
            manufacturerLot: data.manufacturerLot ?? null,
            quantityReceived: d(data.qty),
            quantityAvailable: d(data.qty),
            unit: data.unit,
            containerCount: data.containers,
            manufacturedAt: daysAgo(data.mfgAgo),
            expiryDate: daysAhead(data.expiryIn),
            // Only materials that carry a retest period get a retest date, and
            // never past expiry. A finished product and a reel of blister foil
            // have an expiry and nothing to retest — showing "retest due" against
            // a pack of tablets is the kind of detail a Head of Quality reads as
            // "these people have not worked in a plant".
            retestDate: (() => {
              const period = materialRetest.get(materialCode) ?? null;
              if (period === null) return null;
              return daysAhead(Math.min(period - data.mfgAgo, data.expiryIn));
            })(),
            status: data.status as never,
            location: data.location,
            dispositionedAt: data.dispositionedAgo ? daysAgo(data.dispositionedAgo) : null,
            dispositionedBy: data.dispositionedAgo ? qa.id : null,
            createdBy: stores.id,
          },
        });
        batches.set(key, { id: b.id, number: b.batchNumber });
        return b;
      };

      // Approved — has a released COA.
      await mkBatch('pcm-approved', 'API-PCM', grn1.id, {
        batchNumber: 'PCM/26/0141',
        manufacturerLot: 'SKP-24118',
        qty: 500,
        unit: 'kg',
        containers: 20,
        mfgAgo: 90,
        // 4-year shelf life against a 3-year retest period: the retest falls due
        // roughly nine months before expiry, which is what puts the batch on the
        // stores retest queue while there is still time to act on it.
        expiryIn: 1370,
        status: 'APPROVED',
        location: 'Approved Store — Rack A3',
        dispositionedAgo: 18,
      });

      // Rejected — off the back of a closed OOS.
      await mkBatch('met-rejected', 'API-MET', grn2.id, {
        batchNumber: 'MET/26/0087',
        manufacturerLot: 'HF-9921',
        qty: 250,
        unit: 'kg',
        containers: 10,
        mfgAgo: 60,
        expiryIn: 1400,
        status: 'REJECTED',
        location: 'Rejected Store — Cage R1 (locked)',
        dispositionedAgo: 9,
      });

      // Approved with deviation — a non-critical limit exceeded, accepted.
      await mkBatch('mcc-deviation', 'RM-MCC', grn3.id, {
        batchNumber: 'MCC/26/0233',
        manufacturerLot: 'SG-4471',
        qty: 800,
        unit: 'kg',
        containers: 32,
        mfgAgo: 40,
        expiryIn: 1050,
        status: 'APPROVED',
        location: 'Approved Store — Rack B1',
        dispositionedAgo: 5,
      });

      // Under test — results part-entered, awaiting approval.
      await mkBatch('mgst-undertest', 'RM-MGST', grn4.id, {
        batchNumber: 'MGST/26/0119',
        manufacturerLot: 'NP-3318',
        qty: 100,
        unit: 'kg',
        containers: 4,
        mfgAgo: 20,
        expiryIn: 1050,
        status: 'UNDER_TEST',
        location: 'Quarantine Store — Rack Q2',
      });

      // Quarantine — awaiting sampling. The stores screen's action item.
      await mkBatch('alu-quarantine', 'PM-ALU', grn5.id, {
        batchNumber: 'ALU/26/0402',
        manufacturerLot: 'BC-11207',
        qty: 350,
        unit: 'kg',
        containers: 7,
        mfgAgo: 10,
        expiryIn: 1400,
        status: 'QUARANTINE',
        location: 'Quarantine Store — Rack Q1',
      });

      // In-house finished product batch — no GRN, we made it.
      await mkBatch('fp-undertest', 'FP-PCM500', null, {
        batchNumber: 'PT/26/0455',
        qty: 480000,
        unit: 'nos',
        containers: 12,
        mfgAgo: 8,
        expiryIn: 730,
        status: 'UNDER_TEST',
        location: 'FG Quarantine — Bay 4',
      });

      // ------------------------------------------------------------ analyzers
      // A pharma QC lab runs chromatography and titration, not haematology
      // analyzers. Instrument codes below are the labels those systems emit.
      const mkDevice = async (data: {
        code: string;
        name: string;
        manufacturer: string;
        model: string;
        serial: string;
        department: string;
        protocol: string;
        location: string;
        shadow?: boolean;
        /// Days until calibration falls due. Every instrument in a GMP lab has
        /// one; authorisation is refused on an instrument past it.
        calibrationDueIn?: number;
        channels: [string, string][];
      }) => {
        const dev = await tx.device.create({
          data: {
            tenantId: TENANT_ID,
            labId: unit1.id,
            code: data.code,
            name: data.name,
            manufacturer: data.manufacturer,
            model: data.model,
            serialNumber: data.serial,
            department: data.department as never,
            protocol: data.protocol as never,
            location: data.location,
            calibrationDueAt:
              data.calibrationDueIn === undefined ? null : daysAhead(data.calibrationDueIn),
            status: data.shadow ? 'ENROLLED' : 'ACTIVE',
            isShadowMode: data.shadow ?? false,
            enrolmentCode: `DEMO-${data.code}-0001`,
            enrolmentCodeExpiresAt: daysAhead(365),
            lastCalibratedAt: daysAgo(45),
            calibrationDueAt: daysAhead(320),
          },
        });
        await tx.deviceChannel.createMany({
          data: data.channels.map(([instrumentCode, analyteCode]) => ({
            tenantId: TENANT_ID,
            deviceId: dev.id,
            instrumentCode,
            analyteId: analytes.get(analyteCode)!,
          })),
        });
        return dev;
      };

      await mkDevice({
        code: 'CHEM-01',
        name: 'HPLC — Assay & Related Substances',
        manufacturer: 'Agilent',
        model: '1260 Infinity II',
        serial: 'DEAB-70412',
        department: 'INSTRUMENTATION',
        // An HPLC does not speak HL7 — that is a clinical protocol. Results
        // reach the LIMS as a signed result export from the chromatography data
        // system (OpenLab/Empower), which the gateway watches and normalises.
        // Labelling this HL7 is the kind of detail that tells a QC head the
        // vendor has never stood in an instrument room.
        protocol: 'FILE_CSV',
        location: 'Instrument Room 1',
        // Comfortably in date. The demo should open on a lab that is in order.
        calibrationDueIn: 128,
        channels: [
          ['ASSAY', 'ASSAY'],
          ['RS_TOTAL', 'RSUB'],
          ['RS_MAX', 'RSING'],
          ['GLU', 'ASSAY'],
        ],
      });
      await mkDevice({
        code: 'KF-01',
        name: 'Karl Fischer Titrator',
        manufacturer: 'Metrohm',
        model: '899 Coulometer',
        serial: 'MT-33418',
        department: 'INSTRUMENTATION',
        protocol: 'ASTM_E1394',
        location: 'Instrument Room 1',
        channels: [
          ['WATER', 'WATER'],
          ['KF', 'WATER'],
        ],
      });
      await mkDevice({
        code: 'DISS-01',
        name: 'Dissolution Apparatus (USP II)',
        manufacturer: 'Electrolab',
        model: 'TDT-08L',
        serial: 'EL-90277',
        department: 'INSTRUMENTATION',
        protocol: 'FILE_CSV',
        location: 'Dissolution Lab',
        // Due in three weeks: the stores screen shows something worth acting on
        // without anything being wrong yet.
        calibrationDueIn: 21,
        channels: [['DISS', 'DISS']],
      });
      await mkDevice({
        code: 'GC-01',
        name: 'GC — Residual Solvents',
        manufacturer: 'Shimadzu',
        model: 'Nexis GC-2030',
        serial: 'SH-55190',
        department: 'INSTRUMENTATION',
        protocol: 'ASTM_E1394',
        location: 'Instrument Room 2',
        // Newest instrument, still being verified against manual results.
        shadow: true,
        channels: [['RESSOL', 'RESSOL']],
      });
      console.log(`    instruments  4 analyzers with channel mappings`);

      // ------------------------------------------------------- QC / standards
      // In a pharma QC lab the control is a working standard assayed against a
      // reference standard, not a purchased clinical control serum.
      const wsPcm = await tx.qcMaterial.create({
        data: {
          tenantId: TENANT_ID,
          code: 'WS-PCM',
          name: 'Paracetamol Working Standard',
          manufacturer: 'In-house, against IP RS',
          level: 'LEVEL_1',
        },
      });
      const wsMet = await tx.qcMaterial.create({
        data: {
          tenantId: TENANT_ID,
          code: 'WS-MET',
          name: 'Metformin HCl Working Standard',
          manufacturer: 'In-house, against IP RS',
          level: 'LEVEL_1',
        },
      });

      const lotPcm = await tx.qcLot.create({
        data: {
          tenantId: TENANT_ID,
          qcMaterialId: wsPcm.id,
          lotNumber: 'WS/PCM/26/03',
          expiryDate: daysAhead(300),
          openedAt: daysAgo(60),
        },
      });
      const lotMet = await tx.qcLot.create({
        data: {
          tenantId: TENANT_ID,
          qcMaterialId: wsMet.id,
          lotNumber: 'WS/MET/26/02',
          expiryDate: daysAhead(260),
          openedAt: daysAgo(45),
        },
      });

      await tx.qcLotAnalyte.createMany({
        data: [
          { lot: lotPcm.id, a: 'ASSAY', mean: 99.8, sd: 0.45, unit: '%' },
          { lot: lotPcm.id, a: 'RSUB', mean: 0.08, sd: 0.012, unit: '%' },
          { lot: lotPcm.id, a: 'WATER', mean: 0.22, sd: 0.03, unit: '%' },
          { lot: lotMet.id, a: 'ASSAY', mean: 99.5, sd: 0.38, unit: '%' },
          { lot: lotMet.id, a: 'WATER', mean: 0.31, sd: 0.04, unit: '%' },
        ].map((r) => ({
          tenantId: TENANT_ID,
          qcLotId: r.lot,
          analyteId: analytes.get(r.a)!,
          targetMean: d(r.mean),
          targetSd: d(r.sd),
          unit: r.unit,
        })),
      });
      console.log(`    qc standards 2 working standards, 2 lots, 5 analyte targets`);

      // ------------------------------------------------- laboratory consumables
      //
      // A QC lab runs on columns, solvents, volumetric solutions and reference
      // standards, every one of which has a lot number and an expiry that
      // invalidates the result if it is missed. This is the same control the
      // stores side applies to material batches, applied to the lab's own
      // reagents — and it is what makes "which column was that assay run on?"
      // answerable a year later.
      const consumables = await createMany(tx.inventoryItem as never, TENANT_ID, [
        {
          code: 'COL-C18',
          name: 'HPLC column, C18 250 × 4.6 mm, 5 µm',
          category: 'CONSUMABLE',
          unit: 'injections',
          manufacturer: 'Waters',
          catalogNumber: 'WAT054275',
          reorderLevel: d(200),
          storageCondition: 'Room temperature, capped in solvent',
        },
        {
          code: 'RGT-ACN',
          name: 'Acetonitrile, HPLC grade',
          category: 'REAGENT',
          unit: 'mL',
          manufacturer: 'Merck',
          catalogNumber: '1.00030',
          reorderLevel: d(2000),
          storageCondition: 'Flammables cabinet, room temperature',
        },
        {
          code: 'RGT-KF',
          name: 'Karl Fischer reagent, 5 mg/mL',
          category: 'REAGENT',
          unit: 'mL',
          manufacturer: 'Merck',
          catalogNumber: '1.09241',
          reorderLevel: d(500),
          storageCondition: 'Room temperature, protect from moisture',
        },
        {
          code: 'RGT-BUF68',
          name: 'Phosphate buffer pH 6.8, dissolution medium',
          category: 'REAGENT',
          unit: 'mL',
          manufacturer: 'In-house preparation',
          reorderLevel: d(5000),
          storageCondition: 'Room temperature, use within 7 days of preparation',
        },
        {
          code: 'STD-PCM-RS',
          name: 'Paracetamol reference standard, IP',
          category: 'CALIBRATOR',
          unit: 'mg',
          manufacturer: 'Indian Pharmacopoeia Commission',
          catalogNumber: 'IPRS-0142',
          reorderLevel: d(200),
          storageCondition: '2–8 °C, desiccated',
        },
        {
          code: 'CON-FILT',
          name: 'Syringe filter, 0.45 µm PVDF',
          category: 'CONSUMABLE',
          unit: 'pieces',
          manufacturer: 'Pall',
          catalogNumber: 'PN4560',
          reorderLevel: d(100),
          storageCondition: 'Room temperature',
        },
      ] as never);

      // Lots, including the two awkward states a stock screen must show: one
      // below its reorder level, and one already expired that the system has to
      // refuse rather than merely flag.
      const lotRows: {
        item: string;
        lot: string;
        received: number;
        remaining: number;
        expiry: Date;
        supplier: string;
        status?: string;
        opened?: Date;
      }[] = [
        {
          item: 'COL-C18',
          lot: 'C18/0224/117',
          received: 1500,
          remaining: 862,
          expiry: daysAhead(410),
          supplier: 'Waters India Pvt Ltd',
          opened: daysAgo(120),
        },
        {
          item: 'RGT-ACN',
          lot: 'ACN/26/K441',
          received: 20000,
          remaining: 13400,
          expiry: daysAhead(300),
          supplier: 'Merck Life Science',
          opened: daysAgo(40),
        },
        {
          item: 'RGT-KF',
          lot: 'KF/26/0087',
          received: 4000,
          remaining: 380,
          expiry: daysAhead(95),
          supplier: 'Merck Life Science',
          opened: daysAgo(30),
        },
        {
          item: 'RGT-BUF68',
          lot: 'BUF/26/0311',
          received: 20000,
          remaining: 11200,
          expiry: daysAhead(4),
          supplier: 'In-house, QC prep room',
          opened: daysAgo(3),
        },
        {
          item: 'STD-PCM-RS',
          lot: 'IPRS/PCM/0142/C',
          received: 500,
          remaining: 318,
          expiry: daysAhead(220),
          supplier: 'IPC Ghaziabad',
          opened: daysAgo(75),
        },
        {
          // Deliberately expired, and deliberately still AVAILABLE: the vial is
          // physically on the shelf because nobody has swept it yet. That is the
          // state the gate has to catch. Marking it EXPIRED here would remove it
          // from stock and quietly prove nothing.
          item: 'STD-PCM-RS',
          lot: 'IPRS/PCM/0138/B',
          received: 500,
          remaining: 96,
          expiry: daysAgo(35),
          supplier: 'IPC Ghaziabad',
          opened: daysAgo(300),
        },
        {
          item: 'CON-FILT',
          lot: 'PVDF/25/8842',
          received: 1000,
          remaining: 640,
          expiry: daysAhead(500),
          supplier: 'Pall India',
        },
      ];

      for (const r of lotRows) {
        await tx.inventoryLot.create({
          data: {
            tenantId: TENANT_ID,
            itemId: consumables.get(r.item)!,
            lotNumber: r.lot,
            expiryDate: r.expiry,
            quantityReceived: d(r.received),
            quantityRemaining: d(r.remaining),
            supplier: r.supplier,
            receivedAt: daysAgo(130),
            receivedBy: analyst.id,
            openedAt: r.opened ?? null,
            status: (r.status ?? 'AVAILABLE') as never,
          },
        });
      }

      // What each method consumes per run. This is what makes stock fall by
      // itself when a result is entered, instead of by someone remembering to
      // write it in a register.
      const usageRows: [string, string, number][] = [
        ['TASSAY', 'COL-C18', 1],
        ['TASSAY', 'RGT-ACN', 45],
        ['TASSAY', 'STD-PCM-RS', 25],
        ['TASSAY', 'CON-FILT', 2],
        ['TWATER', 'RGT-KF', 12],
        ['TDISS', 'RGT-BUF68', 900],
        ['TDISS', 'CON-FILT', 6],
        ['TRSUB', 'COL-C18', 1],
        ['TRSUB', 'RGT-ACN', 60],
      ];
      for (const [testCode, itemCode, qty] of usageRows) {
        const testId = tests.get(testCode);
        const itemId = consumables.get(itemCode);
        if (!testId || !itemId) continue;
        await tx.testReagentUsage.create({
          data: {
            tenantId: TENANT_ID,
            testDefinitionId: testId,
            inventoryItemId: itemId,
            quantityPerTest: d(qty),
          },
        });
      }
      console.log(
        `    consumables  ${consumables.size} items, ${lotRows.length} lots (1 expired), ${usageRows.length} method links`,
      );

      console.log(`    batches      ${batches.size} across quarantine / under test / approved / rejected`);

      console.log('');
      return {
        unit1,
        admin,
        qa,
        qa2,
        analyst,
        analyst2,
        stores,
        auditor,
        tests,
        analytes,
        specs,
        materials,
        batches,
        specimens,
        containers,
      };
    },
    { timeout: 240_000, maxWait: 20_000 },
  );

  // Stage two runs in its own transaction: the first is already long, and the
  // workflow data below depends on everything above being committed.
  await seedWorkflow();

  console.log('\n  Seed complete.\n');
  console.log('  Sign in at https://localhost');
  console.log('    Tenant code : VANTAGE');
  console.log(`    Password    : ${DEMO_PASSWORD}   (all demo users)\n`);
  console.log('    admin@vantage.test      Head of Quality — full access');
  console.log('    qa@vantage.test         QA Manager — approves results, dispositions batches, issues COA');
  console.log('    qc@vantage.test    QC Analyst — enters and verifies results, cannot approve');
  console.log('    stores@vantage.test     Stores Officer — goods receipt, quarantine, issue');
  console.log('    auditor@vantage.test    Auditor — read-only + full audit trail\n');
}

/**
 * Orders, samples, results, dispositions, OOS and the COA.
 *
 * Separated from the setup transaction because it reads back what that
 * committed, and because a single 300-line transaction holding a connection is
 * exactly the pattern ADR 0002 warns about.
 */
async function seedWorkflow(): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${TENANT_ID}, true)`;

      const unit = await tx.lab.findFirstOrThrow({ where: { code: 'U1', tenantId: TENANT_ID } });
      const qa = await tx.user.findFirstOrThrow({
        where: { email: 'qa@vantage.test', tenantId: TENANT_ID },
      });
      const analyst = await tx.user.findFirstOrThrow({
        where: { email: 'qc@vantage.test', tenantId: TENANT_ID },
      });
      // The deputies. The quality records deliberately spread across more than
      // one person: a register where every entry names the same individual
      // reads as one person doing the paperwork rather than a system running.
      const qa2 = await tx.user.findFirstOrThrow({
        where: { email: 'qa2@vantage.test', tenantId: TENANT_ID },
      });
      const analyst2 = await tx.user.findFirstOrThrow({
        where: { email: 'qc2@vantage.test', tenantId: TENANT_ID },
      });
      const stores = await tx.user.findFirstOrThrow({
        where: { email: 'stores@vantage.test', tenantId: TENANT_ID },
      });

      const batchByNumber = async (n: string) =>
        tx.materialBatch.findFirstOrThrow({
          where: { batchNumber: n, tenantId: TENANT_ID },
          include: { material: true },
        });

      const testByCode = async (c: string) =>
        tx.testDefinition.findFirstOrThrow({
          where: { tenantId: TENANT_ID, code: c },
          include: { analytes: { include: { analyte: true }, orderBy: { sortOrder: 'asc' } } },
        });

      /**
       * Scoped to the tenant being seeded, explicitly.
       *
       * Leaving the tenant out relies on row-level security to disambiguate,
       * and the seed is the one caller that cannot rely on it: it runs as a
       * privileged role that bypasses RLS, and on a database that already holds
       * another tenant it silently bound results to THAT tenant's analyte with
       * the same code. The rows looked fine; every read then failed, because
       * RLS correctly hid the foreign analyte and Prisma found a required
       * relation missing. Analyte codes are unique per tenant, not globally.
       */
      const analyteByCode = async (c: string) =>
        tx.analyte.findFirstOrThrow({ where: { code: c, tenantId: TENANT_ID } });

      let orderSeq = 0;
      let arSeq = 0;
      let reqSeq = 0;

      /**
       * Raises a sampling request, the order QC works to, and the sample drawn
       * against a batch — the manufacturing equivalent of registering a patient
       * and accessioning their specimen.
       */
      const bookBatch = async (
        batchNumber: string,
        testCodes: string[],
        opts: {
          status: 'PENDING' | 'SAMPLED';
          testStatus: 'PENDING' | 'IN_PROGRESS' | 'RESULT_ENTERED' | 'TECH_VERIFIED' | 'AUTHORIZED';
          ago: number;
        },
      ) => {
        const batch = await batchByNumber(batchNumber);
        reqSeq++;

        const stamp = daysAgo(opts.ago);
        const yymmdd = `${String(stamp.getFullYear()).slice(2)}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}`;

        if (opts.status === 'PENDING') {
          // Awaiting sampling — no order yet. This is the stores/QC action item.
          await tx.samplingRequest.create({
            data: {
              tenantId: TENANT_ID,
              batchId: batch.id,
              requestNumber: `SR/26/${String(reqSeq).padStart(4, '0')}`,
              reason: 'RELEASE_TESTING',
              status: 'PENDING',
              requestedBy: stores.id,
              requestedAt: stamp,
              note: `Awaiting QC sampling — ${batch.containerCount} containers in quarantine.`,
            },
          });
          return null;
        }

        orderSeq++;
        const order = await tx.labOrder.create({
          data: {
            tenantId: TENANT_ID,
            labId: unit.id,
            orderNumber: `AR/26/${String(orderSeq).padStart(4, '0')}`,
            batchId: batch.id,
            priority: 'ROUTINE',
            clinicalNotes: `Release testing — ${batch.material.name}, batch ${batch.batchNumber}`,
            orderedAt: stamp,
            createdBy: stores.id,
          },
        });

        await tx.samplingRequest.create({
          data: {
            tenantId: TENANT_ID,
            batchId: batch.id,
            requestNumber: `SR/26/${String(reqSeq).padStart(4, '0')}`,
            reason: 'RELEASE_TESTING',
            status: 'SAMPLED',
            requestedBy: stores.id,
            requestedAt: stamp,
            orderId: order.id,
            sampledBy: analyst.id,
            sampledAt: stamp,
            // √n + 1 is the standard sampling plan for identification.
            containersSampled: Math.max(1, Math.ceil(Math.sqrt(batch.containerCount ?? 1)) + 1),
            quantitySampled: d(0.25),
          },
        });

        arSeq++;
        const sample = await tx.sample.create({
          data: {
            tenantId: TENANT_ID,
            labId: unit.id,
            orderId: order.id,
            accessionNumber: `U1${yymmdd}${String(arSeq).padStart(5, '0')}`,
            barcode: `U1${yymmdd}${String(arSeq).padStart(5, '0')}`,
            status: opts.testStatus === 'PENDING' ? 'RECEIVED' : 'IN_PROGRESS',
            collectedAt: stamp,
            collectedBy: analyst.id,
            collectionSite: batch.location,
            receivedAt: stamp,
            receivedBy: analyst.id,
            createdBy: analyst.id,
          },
        });

        const sampleTests = [];
        for (const code of testCodes) {
          const td = await testByCode(code);
          const st = await tx.sampleTest.create({
            data: {
              tenantId: TENANT_ID,
              sampleId: sample.id,
              testDefinitionId: td.id,
              testVersion: td.version,
              status: opts.testStatus,
              startedAt: opts.testStatus === 'PENDING' ? null : stamp,
              resultAt: ['RESULT_ENTERED', 'TECH_VERIFIED', 'AUTHORIZED'].includes(opts.testStatus)
                ? stamp
                : null,
              enteredBy: ['RESULT_ENTERED', 'TECH_VERIFIED', 'AUTHORIZED'].includes(opts.testStatus)
                ? analyst.id
                : null,
              verifiedAt: ['TECH_VERIFIED', 'AUTHORIZED'].includes(opts.testStatus) ? stamp : null,
              verifiedBy: ['TECH_VERIFIED', 'AUTHORIZED'].includes(opts.testStatus) ? analyst.id : null,
              authorizedAt: opts.testStatus === 'AUTHORIZED' ? stamp : null,
              authorizedBy: opts.testStatus === 'AUTHORIZED' ? qa.id : null,
              dueAt: new Date(stamp.getTime() + (td.tatMinutes ?? 480) * 60_000),
            },
          });
          sampleTests.push({ st, td });
        }

        return { batch, order, sample, sampleTests, stamp };
      };

      /** Writes a result with its spec limit snapshotted onto the row. */
      const putResult = async (
        sampleTestId: string,
        analyteCode: string,
        value: string,
        opts: { numeric?: number; flag?: string; critical?: boolean; when: Date; unit?: string; ref?: string },
      ) => {
        const analyte = await analyteByCode(analyteCode);
        await tx.result.create({
          data: {
            tenantId: TENANT_ID,
            sampleTestId,
            analyteId: analyte.id,
            version: 1,
            isCurrent: true,
            value,
            numericValue: opts.numeric !== undefined ? d(opts.numeric) : null,
            unit: opts.unit ?? analyte.defaultUnit,
            refDisplay: opts.ref ?? null,
            flag: (opts.flag ?? 'NORMAL') as never,
            isCritical: opts.critical ?? false,
            source: 'MANUAL',
            enteredBy: analyst.id,
            enteredAt: opts.when,
          },
        });
      };

      // ------------------------------------------------- 1. approved batch + COA
      const approved = await bookBatch('PCM/26/0141', ['TDESC', 'TIDEN', 'TASSAY', 'TLOD', 'TRSUB'], {
        status: 'SAMPLED',
        testStatus: 'AUTHORIZED',
        ago: 22,
      });

      if (approved) {
        const w = approved.stamp;
        const byCode = Object.fromEntries(approved.sampleTests.map((x) => [x.td.code, x.st.id]));
        await putResult(byCode.TDESC!, 'DESC', 'White crystalline powder', { when: w, ref: 'White crystalline powder' });
        await putResult(byCode.TIDEN!, 'IDEN', 'Complies', { when: w, ref: 'Complies by IR' });
        await putResult(byCode.TASSAY!, 'ASSAY', '99.62', { numeric: 99.62, when: w, unit: '%', ref: '99.0 – 101.0' });
        await putResult(byCode.TLOD!, 'LOD', '0.21', { numeric: 0.21, when: w, unit: '%', ref: 'NMT 0.5' });
        await putResult(byCode.TRSUB!, 'RSUB', '0.114', { numeric: 0.114, when: w, unit: '%', ref: 'NMT 0.5' });
        await putResult(byCode.TRSUB!, 'RSING', '0.041', { numeric: 0.041, when: w, unit: '%', ref: 'NMT 0.1' });

        await tx.batchDisposition.create({
          data: {
            tenantId: TENANT_ID,
            batchId: approved.batch.id,
            decision: 'APPROVED',
            rationale:
              'All tests comply with SPEC/API-PCM/01 v1. Assay 99.62% (99.0–101.0), total related substances ' +
              '0.114% (NMT 0.5%). Supplier COA cross-checked and consistent. Released for manufacturing use.',
            decidedBy: qa.id,
            decidedAt: daysAgo(18),
          },
        });

        const spec = await tx.specification.findFirstOrThrow({
          where: { code: 'SPEC/API-PCM/01', tenantId: TENANT_ID },
        });
        await tx.certificateOfAnalysis.create({
          data: {
            tenantId: TENANT_ID,
            batchId: approved.batch.id,
            coaNumber: 'COA/26/0141',
            version: 1,
            specificationId: spec.id,
            issuedBy: qa.id,
            issuedAt: daysAgo(18),
          },
        });
      }

      // ------------------------------------------- 2. rejected batch + closed OOS
      const rejected = await bookBatch('MET/26/0087', ['TDESC', 'TIDEN', 'TASSAY', 'TWATER'], {
        status: 'SAMPLED',
        testStatus: 'AUTHORIZED',
        ago: 14,
      });

      if (rejected) {
        const w = rejected.stamp;
        const byCode = Object.fromEntries(rejected.sampleTests.map((x) => [x.td.code, x.st.id]));
        await putResult(byCode.TDESC!, 'DESC', 'White crystalline powder', { when: w, ref: 'White crystalline powder' });
        await putResult(byCode.TIDEN!, 'IDEN', 'Complies', { when: w, ref: 'Complies by IR' });
        // The failure: assay below the lower limit.
        await putResult(byCode.TASSAY!, 'ASSAY', '96.80', {
          numeric: 96.8,
          when: w,
          unit: '%',
          ref: '98.5 – 101.0',
          flag: 'LOW',
          critical: true,
        });
        await putResult(byCode.TWATER!, 'WATER', '0.34', { numeric: 0.34, when: w, unit: '%', ref: 'NMT 0.5' });

        const failing = await tx.result.findFirstOrThrow({
          where: { sampleTestId: byCode.TASSAY!, analyte: { code: 'ASSAY' } },
        });

        await tx.oosInvestigation.create({
          data: {
            tenantId: TENANT_ID,
            batchId: rejected.batch.id,
            resultId: failing.id,
            investigationNumber: 'OOS/26/0007',
            observedValue: '96.80 %',
            limitBreached: 'Assay 98.5 – 101.0 %',
            analyteCode: 'ASSAY',
            phase: 'PHASE_II',
            status: 'CLOSED',
            labInvestigationNote:
              'Phase I: analyst interview, calculation re-check, standard and sample preparation reviewed. ' +
              'System suitability within limits; column and mobile phase in date. No laboratory error identified.',
            manufacturingNote:
              'Phase II: supplier contacted. Their retained sample assayed 97.1% against our 96.8%, confirming ' +
              'the result reflects the material rather than our method.',
            rootCause:
              'Material does not meet the registered specification. Supplier attributes it to a drying-stage ' +
              'deviation at their plant (their deviation ref HF/DEV/26/044).',
            conclusion: 'MANUFACTURING_CONFIRMED',
            correctiveAction:
              'Batch rejected and quarantined in the locked rejected store pending return to supplier. ' +
              'Supplier placed under enhanced incoming scrutiny for the next three consignments. ' +
              'Vendor qualification review raised as CAPA/26/0031.',
            openedBy: analyst.id,
            openedAt: daysAgo(13),
            closedBy: qa.id,
            closedAt: daysAgo(10),
          },
        });

        await tx.batchDisposition.create({
          data: {
            tenantId: TENANT_ID,
            batchId: rejected.batch.id,
            decision: 'REJECTED',
            rationale:
              'Assay 96.80% against a specification of 98.5–101.0%. OOS/26/0007 closed with cause confirmed as ' +
              'manufacturing, not laboratory. Batch rejected in full; return to supplier initiated.',
            deviationRef: 'OOS/26/0007',
            decidedBy: qa.id,
            decidedAt: daysAgo(9),
          },
        });
      }

      // --------------------------------------- 3. approved with deviation (MCC)
      const deviation = await bookBatch('MCC/26/0233', ['TDESC', 'TLOD', 'TPHYS', 'TMLT'], {
        status: 'SAMPLED',
        testStatus: 'AUTHORIZED',
        ago: 8,
      });

      if (deviation) {
        const w = deviation.stamp;
        const byCode = Object.fromEntries(deviation.sampleTests.map((x) => [x.td.code, x.st.id]));
        await putResult(byCode.TDESC!, 'DESC', 'White to off-white powder', { when: w, ref: 'White to off-white powder' });
        await putResult(byCode.TLOD!, 'LOD', '3.94', { numeric: 3.94, when: w, unit: '%', ref: 'NMT 5.0' });
        await putResult(byCode.TPHYS!, 'PH', '6.42', { numeric: 6.42, when: w, ref: '5.0 – 7.5' });
        // Non-critical excursion: bulk density marginally low.
        await putResult(byCode.TPHYS!, 'BDEN', '0.271', {
          numeric: 0.271,
          when: w,
          unit: 'g/mL',
          ref: '0.28 – 0.38',
          flag: 'LOW',
        });
        await putResult(byCode.TPHYS!, 'PSIZE', '118.4', { numeric: 118.4, when: w, unit: 'µm' });
        await putResult(byCode.TMLT!, 'TAMC', '40', { numeric: 40, when: w, unit: 'cfu/g', ref: 'NMT 1000' });
        await putResult(byCode.TMLT!, 'TYMC', '10', { numeric: 10, when: w, unit: 'cfu/g' });
        await putResult(byCode.TMLT!, 'ECOLI', 'Absent', { when: w, ref: 'Absent' });

        await tx.batchDisposition.create({
          data: {
            tenantId: TENANT_ID,
            batchId: deviation.batch.id,
            decision: 'APPROVED_WITH_DEVIATION',
            rationale:
              'Bulk density 0.271 g/mL against 0.28–0.38 g/mL — a NON-CRITICAL parameter. All critical parameters ' +
              'comply. Formulation development confirmed (memo FD/26/118) that the granulation for PT/26 is ' +
              'insensitive to bulk density in this range. Released restricted to wet-granulation products only; ' +
              'NOT to be used for direct compression.',
            deviationRef: 'DEV/26/0088',
            decidedBy: qa.id,
            decidedAt: daysAgo(5),
          },
        });
      }

      // ----------------------------------------- 4. under test, awaiting approval
      const underTest = await bookBatch('MGST/26/0119', ['TDESC', 'TASSAY', 'TLOD'], {
        status: 'SAMPLED',
        testStatus: 'TECH_VERIFIED',
        ago: 3,
      });

      if (underTest) {
        const w = underTest.stamp;
        const byCode = Object.fromEntries(underTest.sampleTests.map((x) => [x.td.code, x.st.id]));
        await putResult(byCode.TDESC!, 'DESC', 'White to off-white powder', { when: w, ref: 'White to off-white powder' });
        await putResult(byCode.TASSAY!, 'ASSAY', '4.42', { numeric: 4.42, when: w, unit: '%', ref: '4.0 – 5.0' });
        await putResult(byCode.TLOD!, 'LOD', '3.11', { numeric: 3.11, when: w, unit: '%', ref: 'NMT 6.0' });
      }

      // ---------------------------- 5. finished product in progress (partial data)
      const fp = await bookBatch('PT/26/0455', ['TDESC', 'TASSAY', 'TDISS', 'TTAB'], {
        status: 'SAMPLED',
        testStatus: 'RESULT_ENTERED',
        ago: 2,
      });

      if (fp) {
        const w = fp.stamp;
        const byCode = Object.fromEntries(fp.sampleTests.map((x) => [x.td.code, x.st.id]));
        await putResult(byCode.TDESC!, 'DESC', 'White capsule-shaped uncoated tablets', {
          when: w,
          ref: 'White capsule-shaped uncoated tablets',
        });
        await putResult(byCode.TASSAY!, 'ASSAY', '99.10', { numeric: 99.1, when: w, unit: '%', ref: '95.0 – 105.0' });
        // Dissolution below the limit. This is the one investigation left OPEN:
        // a QA desk always has live work, and an empty investigation queue makes
        // the release gate look decorative rather than load-bearing.
        await putResult(byCode.TDISS!, 'DISS', '76.5', {
          numeric: 76.5,
          when: w,
          unit: '%',
          ref: 'NLT 80',
          flag: 'LOW',
          critical: true,
        });
        // Tablet physicals still on the bench — deliberately left for the demo.

        const failingDiss = await tx.result.findFirstOrThrow({
          where: { sampleTestId: byCode.TDISS!, analyte: { code: 'DISS' } },
        });

        await tx.oosInvestigation.create({
          data: {
            tenantId: TENANT_ID,
            batchId: fp.batch.id,
            resultId: failingDiss.id,
            investigationNumber: 'OOS/26/0012',
            observedValue: '76.5 %',
            limitBreached: 'Dissolution NLT 80 % in 30 min',
            analyteCode: 'DISS',
            phase: 'PHASE_I',
            status: 'OPEN',
            labInvestigationNote:
              'Phase I in progress: analyst interview complete, no calculation error found. Medium ' +
              'preparation and de-aeration records under review; paddle height and rotation speed to be ' +
              're-verified against the calibration record for DISS-01 before any re-test is authorised.',
            openedBy: analyst.id,
            openedAt: daysAgo(1),
          },
        });
      }

      // ------------------------------- 6. quarantine, awaiting sampling (no order)
      await bookBatch('ALU/26/0402', [], { status: 'PENDING', testStatus: 'PENDING', ago: 2 });

      // ------------------------------------------------- quality system
      //
      // A plant always has quality work in flight. An empty deviation register
      // says either that nothing ever goes wrong — which no inspector believes
      // — or that nobody is writing it down, which is worse. The demo opens on
      // a site that is on top of its work but not pretending to be perfect:
      // one deviation closed properly, one still being investigated, and a CAPA
      // completed but not yet due for its effectiveness check.
      const devClosed = await tx.deviation.create({
        data: {
          tenantId: TENANT_ID,
          deviationNumber: 'DEV/26/0031',
          title: 'Dissolution bath temperature excursion during PT/26/0455 testing',
          description:
            'The water bath on DISS-01 was found at 38.4 °C against a set point of 37.0 ± 0.5 °C ' +
            'at the 30-minute pull. The excursion was noticed by the analyst on the second ' +
            'vessel check. Testing was stopped and the run abandoned.',
          category: 'EQUIPMENT',
          severity: 'MAJOR',
          status: 'CLOSED',
          productImpact: 'POTENTIAL',
          occurredAt: daysAgo(12),
          detectedAt: daysAgo(12),
          reportedBy: analyst.id,
          reportedAt: daysAgo(12),
          investigation:
            'Bath thermostat calibration verified against a reference thermometer: reading 1.4 °C ' +
            'low. Service history reviewed — the unit was last serviced 14 months ago against a ' +
            '12-month interval. No other runs were in progress during the excursion window.',
          rootCause:
            'Thermostat drift on DISS-01, undetected because the annual service had slipped by ' +
            'two months and daily bath temperature was recorded from the unit display rather ' +
            'than an independent thermometer.',
          impactAssessment:
            'Only the abandoned PT/26/0455 dissolution run was affected; it was repeated after ' +
            'correction and complies. No released batch was tested during the excursion window.',
          closedBy: qa.id,
          closedAt: daysAgo(4),
        },
      });

      const devOpen = await tx.deviation.create({
        data: {
          tenantId: TENANT_ID,
          deviationNumber: 'DEV/26/0034',
          title: 'Balance printout missing from raw data pack for AR U126080500004',
          description:
            'During review of the assay raw data pack the analytical balance printout for the ' +
            'standard weighing was found to be absent. The weight is recorded in the worksheet ' +
            'and the sequence is complete, but the printed slip is not attached.',
          category: 'DOCUMENTATION',
          status: 'UNDER_INVESTIGATION',
          occurredAt: daysAgo(3),
          detectedAt: daysAgo(1),
          reportedBy: qa2.id,
          reportedAt: daysAgo(1),
          investigation:
            'Analyst interviewed; balance printer roll was found empty on the day. Checking ' +
            'whether the audit trail on the balance can supply the weighing record, and ' +
            'reviewing whether other packs from the same week are affected.',
        },
      });

      await tx.capaAction.createMany({
        data: [
          {
            tenantId: TENANT_ID,
            capaNumber: 'CAPA/26/0018',
            title: 'Restore DISS-01 to its 12-month service interval and verify bath temperature',
            description:
              'Recalibrate the DISS-01 thermostat, return the unit to a 12-month service ' +
              'schedule, and add an independent thermometer check to the daily bath log so a ' +
              'drift is caught by something other than the instrument reporting on itself.',
            kind: 'CORRECTIVE',
            status: 'COMPLETED',
            deviationId: devClosed.id,
            ownerId: analyst.id,
            dueAt: daysAgo(6),
            completedBy: analyst.id,
            completedAt: daysAgo(5),
            completionNote:
              'Thermostat recalibrated by the service engineer (certificate CAL/2026/DISS-01/007). ' +
              'Daily log revised to record an independent thermometer reading alongside the ' +
              'display. Service scheduled to the 12-month interval.',
            // Deliberately still ahead of us: the demo shows a CAPA that is done
            // but not yet proven, which is the state most of them live in.
            effectivenessDueAt: daysAhead(25),
            createdBy: qa.id,
            createdAt: daysAgo(11),
          },
          {
            tenantId: TENANT_ID,
            capaNumber: 'CAPA/26/0019',
            title: 'Second-person check that raw data packs are complete before QA review',
            description:
              'Add a completeness check to the analyst-to-QA handover so a missing printout is ' +
              'caught at the bench rather than during review, and stock a spare printer roll at ' +
              'each balance.',
            kind: 'PREVENTIVE',
            status: 'IN_PROGRESS',
            deviationId: devOpen.id,
            ownerId: analyst2.id,
            dueAt: daysAhead(12),
            effectivenessDueAt: daysAhead(75),
            createdBy: qa2.id,
            createdAt: daysAgo(1),
          },
        ],
      });

      const changeApproved = await tx.changeControl.create({
        data: {
          tenantId: TENANT_ID,
          changeNumber: 'CC/26/0009',
          title: 'Tighten the in-house assay limit for Paracetamol API to 99.0–101.0 %',
          description:
            'Align the in-house release limit for API-PCM assay with the IP monograph range ' +
            'following the specification review.',
          changeType: 'SPECIFICATION',
          classification: 'MAJOR',
          status: 'IMPLEMENTED',
          justification:
            'The in-house limit had been carried over from a USP-based specification. Aligning ' +
            'with IP removes the discrepancy between the cited pharmacopoeia and the applied ' +
            'limit, which an auditor would raise.',
          impactAssessment:
            'Reviewed the last 24 months of API-PCM assay results: all released batches fall ' +
            'within the tighter range, so no historical batch would have been rejected under it. ' +
            'No method change is required; the analytical procedure is unchanged.',
          prerequisites:
            'Specification reissued at the next version. QC analysts briefed at the shift ' +
            'handover. No revalidation required as the method is unchanged.',
          requestedBy: qa2.id,
          requestedAt: daysAgo(30),
          approvedBy: qa.id,
          approvedAt: daysAgo(24),
          approvalNote:
            'Approved. The tighter limit is the registered one and the retrospective review ' +
            'shows no impact on supply.',
          implementedBy: qa2.id,
          implementedAt: daysAgo(20),
          implementationNote: 'Specification SPEC/API-PCM/01 reissued with the IP range.',
        },
      });

      console.log(
        `    quality      2 deviations (1 closed, 1 open) · 2 CAPAs · ${changeApproved.changeNumber} implemented`,
      );

      console.log(`    workflow     ${orderSeq} AR numbers, ${reqSeq} sampling requests`);
      console.log('    dispositions 1 approved · 1 rejected (OOS) · 1 approved-with-deviation');
      console.log('    oos          OOS/26/0007 closed · OOS/26/0012 OPEN (dissolution, Phase I)');
      console.log('    coa          COA/26/0141 issued for PCM/26/0141');
    },
    { timeout: 240_000, maxWait: 20_000 },
  );
}

/** Bulk-creates rows sharing the tenant, returning a code -> id map. */
async function createMany<T extends { code: string }>(
  model: { create: (args: { data: unknown }) => Promise<{ id: string; code: string }> },
  tenantId: string,
  rows: T[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const created = await model.create({ data: { tenantId, ...row } });
    map.set(created.code, created.id);
  }
  return map;
}

main()
  .catch((e) => {
    console.error('\n  Seed failed:\n');
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
