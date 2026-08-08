/**
 * Seeds a realistic mid-size Indian diagnostic lab.
 *
 * Not a toy fixture: the catalog, reference ranges, QC lots and analyzer channel
 * mappings mirror what a real NABL-accredited pathology lab runs, so the system
 * is demo-able to a lab owner on day one — and so performance work has
 * representative shapes to measure against.
 *
 * Everything runs inside ONE transaction with app.tenant_id set, because RLS is
 * active for the seed too (ADR 0002). There is no privileged back door.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import {
  generateKey,
  wrapKey,
  encrypt,
  blindIndex,
  masterKeyFromBase64,
  hashPassword,
  AUDIT_GENESIS_HASH,
} from '@labsetu/crypto';
import { DEFAULT_ROLES } from '@labsetu/contracts';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();

const TENANT_ID = '0195c0de-0000-7000-8000-000000000001';
const DEMO_PASSWORD = 'LabSetu@2026';

const masterKey = masterKeyFromBase64(requireEnv('ENCRYPTION_MASTER_KEY'));
const blindIndexKey = masterKeyFromBase64(requireEnv('BLIND_INDEX_KEY'));

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.startsWith('CHANGE_ME')) {
    throw new Error(
      `${name} is missing or still a placeholder. Run: node scripts/setup-env.mjs`,
    );
  }
  return v;
}

async function main() {
  console.log('\n  Seeding LabSetu demo tenant...\n');

  // The seed deliberately refuses to overwrite an existing tenant.
  //
  // It CANNOT clean up after itself, because audit_log is append-only at the
  // database level — labsetu_app has no DELETE grant on it (ADR 0003). Wiping
  // and re-seeding would leave orphaned audit entries and a reset chain head,
  // i.e. a broken chain. That the seed cannot work around this is the guarantee
  // working as designed, so the honest path is a full reset via the owner role.
  const existing = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM tenant WHERE id = ${TENANT_ID}::uuid
  `;
  if ((existing[0]?.count ?? 0n) > 0n) {
    console.error(
      '  The demo tenant already exists.\n\n' +
        '  The audit trail is append-only, so the seed cannot delete it and start over.\n' +
        '  To rebuild the database from scratch:\n\n' +
        '      npm run db:reset\n',
    );
    process.exit(1);
  }

  await prisma.$transaction(
    async (tx) => {
      // RLS applies to the seed as well; without this every insert is rejected
      // by the WITH CHECK clause. That is the correct behaviour.
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${TENANT_ID}, true)`;

      // -----------------------------------------------------------------------
      // Tenant
      // -----------------------------------------------------------------------
      const tenantDek = generateKey();

      const tenant = await tx.tenant.create({
        data: {
          id: TENANT_ID,
          code: 'SUNRISE',
          name: 'Sunrise Diagnostics',
          legalName: 'Sunrise Diagnostics Pvt Ltd',
          gstin: '36AABCS1429B1ZX',
          pan: 'AABCS1429B',
          addressLine1: 'Plot 42, Jubilee Hills',
          city: 'Hyderabad',
          state: 'Telangana',
          stateCode: '36',
          pincode: '500033',
          phone: '+914023551234',
          email: 'info@sunrisediagnostics.example',
          nablCertNo: 'MC-4821',
          nablValidTill: new Date('2029-03-31'),
          dataKeyEnc: wrapKey(tenantDek, masterKey),
        },
      });
      console.log(`    tenant       ${tenant.name} (${tenant.code})`);

      await tx.auditChainHead.create({
        data: { tenantId: TENANT_ID, seq: 0n, headHash: AUDIT_GENESIS_HASH },
      });

      await tx.tenantPolicy.createMany({
        data: [
          // Four-eyes: the authoriser may not be the person who entered the
          // result. Small labs can turn this off, but doing so is itself audited.
          { tenantId: TENANT_ID, key: 'result.fourEyesRequired', value: true },
          // QC gating: a failed or overdue QC blocks authorisation on that
          // analyzer+analyte (COMPLIANCE.md §6).
          { tenantId: TENANT_ID, key: 'qc.blockAuthorizationOnFailure', value: true },
          { tenantId: TENANT_ID, key: 'result.deltaCheckPercent', value: 30 },
          { tenantId: TENANT_ID, key: 'report.autoReleaseEnabled', value: false },
          { tenantId: TENANT_ID, key: 'retention.clinicalRecordYears', value: 5 },
          { tenantId: TENANT_ID, key: 'mfa.requiredForPrivilegedRoles', value: true },
        ],
      });

      // -----------------------------------------------------------------------
      // Labs (branches)
      // -----------------------------------------------------------------------
      const mainLab = await tx.lab.create({
        data: {
          tenantId: TENANT_ID,
          code: 'HYD',
          name: 'Sunrise Diagnostics — Jubilee Hills (Main)',
          addressLine1: 'Plot 42, Jubilee Hills',
          city: 'Hyderabad',
          state: 'Telangana',
          pincode: '500033',
          phone: '+914023551234',
        },
      });

      const branchLab = await tx.lab.create({
        data: {
          tenantId: TENANT_ID,
          code: 'KUK',
          name: 'Sunrise Diagnostics — Kukatpally',
          addressLine1: 'Road No 5, KPHB Colony',
          city: 'Hyderabad',
          state: 'Telangana',
          pincode: '500072',
          phone: '+914023551235',
        },
      });
      console.log(`    labs         ${mainLab.code}, ${branchLab.code}`);

      // -----------------------------------------------------------------------
      // Roles
      // -----------------------------------------------------------------------
      const roles: Record<string, string> = {};
      for (const [code, def] of Object.entries(DEFAULT_ROLES)) {
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

      // -----------------------------------------------------------------------
      // Users
      // -----------------------------------------------------------------------
      const passwordHash = await hashPassword(DEMO_PASSWORD);

      const mkUser = async (
        email: string,
        fullName: string,
        roleCode: string,
        extra: Record<string, unknown> = {},
      ) => {
        const user = await tx.user.create({
          data: {
            tenantId: TENANT_ID,
            email,
            passwordHash,
            fullName,
            ...extra,
          },
        });
        await tx.userRole.create({
          data: { tenantId: TENANT_ID, userId: user.id, roleId: roles[roleCode]! },
        });
        return user;
      };

      const admin = await mkUser('admin@sunrise.test', 'Anita Rao', 'LAB_ADMIN');
      const pathologist = await mkUser(
        'pathologist@sunrise.test',
        'Dr. Suresh Menon',
        'PATHOLOGIST',
        { qualification: 'MD (Pathology)', registrationNo: 'TSMC/12345/2011' },
      );
      const pathologist2 = await mkUser(
        'consultant@sunrise.test',
        'Dr. Kavita Reddy',
        'PATHOLOGIST',
        { qualification: 'MD (Biochemistry)', registrationNo: 'TSMC/23456/2014' },
      );
      const technician = await mkUser(
        'tech@sunrise.test',
        'Ravi Teja',
        'LAB_TECHNICIAN',
        { qualification: 'DMLT' },
      );
      const reception = await mkUser('front@sunrise.test', 'Priya Sharma', 'RECEPTIONIST');
      const phlebotomist = await mkUser(
        'phlebo@sunrise.test',
        'Sunil Kumar',
        'PHLEBOTOMIST',
        { qualification: 'DMLT (Phlebotomy)' },
      );
      const auditor = await mkUser('auditor@sunrise.test', 'M. Krishnan', 'AUDITOR');
      console.log(`    users        7 (password: ${DEMO_PASSWORD})`);
      void phlebotomist;
      void auditor;

      // -----------------------------------------------------------------------
      // Reference data
      // -----------------------------------------------------------------------
      const specimens = await createMany(tx.specimenType, TENANT_ID, [
        { code: 'SER', name: 'Serum' },
        { code: 'EDTA', name: 'Whole Blood (EDTA)' },
        { code: 'FLU', name: 'Plasma (Sodium Fluoride)' },
        { code: 'CIT', name: 'Plasma (Citrate)' },
        { code: 'URN', name: 'Urine' },
        { code: 'STL', name: 'Stool' },
      ]);

      const containers = await createMany(tx.containerType, TENANT_ID, [
        { code: 'RED', name: 'Plain / Clot Activator', colour: 'Red', additive: 'None' },
        { code: 'LAV', name: 'EDTA Tube', colour: 'Lavender', additive: 'K2EDTA' },
        { code: 'GREY', name: 'Fluoride Tube', colour: 'Grey', additive: 'NaF/K-Ox' },
        { code: 'BLUE', name: 'Citrate Tube', colour: 'Blue', additive: 'Na-Citrate 3.2%' },
        { code: 'YEL', name: 'SST Gel Tube', colour: 'Yellow', additive: 'Gel + Clot Activator' },
        { code: 'UCON', name: 'Urine Container', colour: 'White', additive: 'None' },
      ]);

      // Controlled list — rejection rate by reason is an NABL quality indicator
      // and must be aggregatable, so this can never be free text.
      await createMany(tx.rejectionReason, TENANT_ID, [
        { code: 'HAEM', name: 'Haemolysed sample', category: 'PRE_ANALYTICAL' },
        { code: 'QNS', name: 'Quantity not sufficient', category: 'PRE_ANALYTICAL' },
        { code: 'CLOT', name: 'Clotted sample', category: 'PRE_ANALYTICAL' },
        { code: 'WRCON', name: 'Wrong container / additive', category: 'PRE_ANALYTICAL' },
        { code: 'UNLBL', name: 'Unlabelled or mislabelled', category: 'IDENTIFICATION' },
        { code: 'LEAK', name: 'Leaked in transit', category: 'TRANSPORT' },
        { code: 'DELAY', name: 'Delayed beyond stability', category: 'TRANSPORT' },
        { code: 'LIPE', name: 'Lipaemic sample', category: 'PRE_ANALYTICAL' },
      ]);

      const methods = await createMany(tx.method, TENANT_ID, [
        { code: 'PHOTO', name: 'Photometry', principle: 'Spectrophotometric absorbance' },
        { code: 'IMPD', name: 'Electrical Impedance', principle: 'Coulter principle' },
        { code: 'CLIA', name: 'Chemiluminescent Immunoassay', principle: 'CLIA' },
        { code: 'ISE', name: 'Ion Selective Electrode', principle: 'Potentiometry' },
        { code: 'HPLC', name: 'HPLC', principle: 'Cation-exchange chromatography' },
        { code: 'MICRO', name: 'Microscopy', principle: 'Light microscopy' },
      ]);
      console.log(
        `    reference    ${specimens.size} specimens, ${containers.size} containers, ${methods.size} methods`,
      );

      // -----------------------------------------------------------------------
      // Analytes
      // -----------------------------------------------------------------------
      const analytes = await createMany(tx.analyte, TENANT_ID, [
        // Haematology
        { code: 'HB', name: 'Haemoglobin', defaultUnit: 'g/dL', precision: 1, loincCode: '718-7' },
        { code: 'RBC', name: 'RBC Count', defaultUnit: 'mil/µL', precision: 2, loincCode: '789-8' },
        { code: 'WBC', name: 'Total WBC Count', defaultUnit: '/µL', precision: 0, loincCode: '6690-2' },
        { code: 'PLT', name: 'Platelet Count', defaultUnit: '/µL', precision: 0, loincCode: '777-3' },
        { code: 'HCT', name: 'Haematocrit (PCV)', defaultUnit: '%', precision: 1, loincCode: '4544-3' },
        { code: 'MCV', name: 'MCV', defaultUnit: 'fL', precision: 1, loincCode: '787-2' },
        { code: 'MCH', name: 'MCH', defaultUnit: 'pg', precision: 1, loincCode: '785-6' },
        { code: 'MCHC', name: 'MCHC', defaultUnit: 'g/dL', precision: 1, loincCode: '786-4' },
        { code: 'NEUT', name: 'Neutrophils', defaultUnit: '%', precision: 0, loincCode: '770-8' },
        { code: 'LYMP', name: 'Lymphocytes', defaultUnit: '%', precision: 0, loincCode: '736-9' },
        { code: 'EOSI', name: 'Eosinophils', defaultUnit: '%', precision: 0, loincCode: '713-8' },
        { code: 'MONO', name: 'Monocytes', defaultUnit: '%', precision: 0, loincCode: '5905-5' },

        // Biochemistry
        { code: 'GLUF', name: 'Glucose, Fasting', defaultUnit: 'mg/dL', precision: 0, loincCode: '1558-6' },
        { code: 'GLUPP', name: 'Glucose, Post Prandial', defaultUnit: 'mg/dL', precision: 0 },
        { code: 'UREA', name: 'Blood Urea', defaultUnit: 'mg/dL', precision: 0, loincCode: '3094-0' },
        { code: 'CREA', name: 'Serum Creatinine', defaultUnit: 'mg/dL', precision: 2, loincCode: '2160-0' },
        { code: 'UA', name: 'Uric Acid', defaultUnit: 'mg/dL', precision: 1, loincCode: '3084-1' },
        { code: 'NA', name: 'Sodium', defaultUnit: 'mmol/L', precision: 0, loincCode: '2951-2' },
        { code: 'K', name: 'Potassium', defaultUnit: 'mmol/L', precision: 1, loincCode: '2823-3' },
        { code: 'CL', name: 'Chloride', defaultUnit: 'mmol/L', precision: 0, loincCode: '2075-0' },

        // Lipids — LDL is calculated, not measured
        { code: 'CHOL', name: 'Total Cholesterol', defaultUnit: 'mg/dL', precision: 0, loincCode: '2093-3' },
        { code: 'TRIG', name: 'Triglycerides', defaultUnit: 'mg/dL', precision: 0, loincCode: '2571-8' },
        { code: 'HDL', name: 'HDL Cholesterol', defaultUnit: 'mg/dL', precision: 0, loincCode: '2085-9' },
        { code: 'LDL', name: 'LDL Cholesterol (calc.)', defaultUnit: 'mg/dL', precision: 0, loincCode: '13457-7' },

        // Liver
        { code: 'TBIL', name: 'Total Bilirubin', defaultUnit: 'mg/dL', precision: 2, loincCode: '1975-2' },
        { code: 'DBIL', name: 'Direct Bilirubin', defaultUnit: 'mg/dL', precision: 2, loincCode: '1968-7' },
        { code: 'SGPT', name: 'SGPT / ALT', defaultUnit: 'U/L', precision: 0, loincCode: '1742-6' },
        { code: 'SGOT', name: 'SGOT / AST', defaultUnit: 'U/L', precision: 0, loincCode: '1920-8' },
        { code: 'ALP', name: 'Alkaline Phosphatase', defaultUnit: 'U/L', precision: 0, loincCode: '6768-6' },
        { code: 'TPROT', name: 'Total Protein', defaultUnit: 'g/dL', precision: 1, loincCode: '2885-2' },
        { code: 'ALB', name: 'Albumin', defaultUnit: 'g/dL', precision: 1, loincCode: '1751-7' },

        // Endocrine
        { code: 'TSH', name: 'TSH', defaultUnit: 'µIU/mL', precision: 3, loincCode: '3016-3' },
        { code: 'T3', name: 'Total T3', defaultUnit: 'ng/dL', precision: 1, loincCode: '3053-6' },
        { code: 'T4', name: 'Total T4', defaultUnit: 'µg/dL', precision: 2, loincCode: '3026-2' },
        { code: 'HBA1C', name: 'HbA1c', defaultUnit: '%', precision: 1, loincCode: '4548-4' },

        // Qualitative / text
        {
          code: 'URCOL',
          name: 'Urine Colour',
          valueType: 'QUALITATIVE' as const,
          allowedValues: ['Pale Yellow', 'Yellow', 'Dark Yellow', 'Amber', 'Red', 'Colourless'],
        },
        {
          code: 'URPRO',
          name: 'Urine Protein',
          valueType: 'QUALITATIVE' as const,
          allowedValues: ['Absent', 'Trace', '1+', '2+', '3+', '4+'],
        },
        {
          code: 'URGLU',
          name: 'Urine Glucose',
          valueType: 'QUALITATIVE' as const,
          allowedValues: ['Absent', 'Trace', '1+', '2+', '3+', '4+'],
        },
        {
          code: 'URDEP',
          name: 'Urine Deposits',
          valueType: 'TEXT' as const,
        },
        {
          code: 'BLDGRP',
          name: 'ABO Blood Group',
          valueType: 'QUALITATIVE' as const,
          allowedValues: ['A', 'B', 'AB', 'O'],
        },
      ]);
      console.log(`    analytes     ${analytes.size}`);

      // -----------------------------------------------------------------------
      // Reference ranges
      //
      // Superseded ranges are closed with effectiveTo rather than edited, so a
      // historical report still renders with the range in force at the time.
      // -----------------------------------------------------------------------
      const rr = (
        analyteCode: string,
        low: number | null,
        high: number | null,
        opts: {
          sex?: 'MALE' | 'FEMALE';
          minAgeDays?: number;
          maxAgeDays?: number;
          criticalLow?: number;
          criticalHigh?: number;
          unit?: string;
          displayText?: string;
        } = {},
      ) => ({
        tenantId: TENANT_ID,
        analyteId: analytes.get(analyteCode)!,
        sex: opts.sex ?? null,
        minAgeDays: opts.minAgeDays ?? null,
        maxAgeDays: opts.maxAgeDays ?? null,
        lowValue: low !== null ? new Prisma.Decimal(low) : null,
        highValue: high !== null ? new Prisma.Decimal(high) : null,
        criticalLow: opts.criticalLow !== undefined ? new Prisma.Decimal(opts.criticalLow) : null,
        criticalHigh: opts.criticalHigh !== undefined ? new Prisma.Decimal(opts.criticalHigh) : null,
        unit: opts.unit ?? null,
        displayText: opts.displayText ?? null,
      });

      await tx.referenceRange.createMany({
        data: [
          // Sex-specific — the reason reference ranges cannot be a single number
          rr('HB', 13.0, 17.0, { sex: 'MALE', unit: 'g/dL', criticalLow: 7.0, criticalHigh: 20.0 }),
          rr('HB', 12.0, 15.0, { sex: 'FEMALE', unit: 'g/dL', criticalLow: 7.0, criticalHigh: 20.0 }),
          rr('HCT', 40, 50, { sex: 'MALE', unit: '%' }),
          rr('HCT', 36, 46, { sex: 'FEMALE', unit: '%' }),
          rr('RBC', 4.5, 5.9, { sex: 'MALE', unit: 'mil/µL' }),
          rr('RBC', 4.1, 5.1, { sex: 'FEMALE', unit: 'mil/µL' }),
          rr('CREA', 0.7, 1.3, { sex: 'MALE', unit: 'mg/dL', criticalHigh: 6.0 }),
          rr('CREA', 0.6, 1.1, { sex: 'FEMALE', unit: 'mg/dL', criticalHigh: 6.0 }),
          rr('UA', 3.5, 7.2, { sex: 'MALE', unit: 'mg/dL' }),
          rr('UA', 2.6, 6.0, { sex: 'FEMALE', unit: 'mg/dL' }),

          // Sex-independent
          rr('WBC', 4000, 11000, { unit: '/µL', criticalLow: 1500, criticalHigh: 30000 }),
          rr('PLT', 150000, 450000, { unit: '/µL', criticalLow: 30000, criticalHigh: 1000000 }),
          rr('MCV', 80, 100, { unit: 'fL' }),
          rr('MCH', 27, 33, { unit: 'pg' }),
          rr('MCHC', 32, 36, { unit: 'g/dL' }),
          rr('NEUT', 40, 75, { unit: '%' }),
          rr('LYMP', 20, 45, { unit: '%' }),
          rr('EOSI', 1, 6, { unit: '%' }),
          rr('MONO', 2, 10, { unit: '%' }),

          rr('GLUF', 70, 100, { unit: 'mg/dL', criticalLow: 45, criticalHigh: 400 }),
          rr('GLUPP', 70, 140, { unit: 'mg/dL', criticalLow: 45, criticalHigh: 400 }),
          rr('UREA', 15, 40, { unit: 'mg/dL' }),
          rr('NA', 136, 145, { unit: 'mmol/L', criticalLow: 120, criticalHigh: 160 }),
          rr('K', 3.5, 5.1, { unit: 'mmol/L', criticalLow: 2.5, criticalHigh: 6.5 }),
          rr('CL', 98, 107, { unit: 'mmol/L' }),

          rr('CHOL', null, 200, { unit: 'mg/dL', displayText: 'Desirable: < 200' }),
          rr('TRIG', null, 150, { unit: 'mg/dL', displayText: 'Normal: < 150' }),
          rr('HDL', 40, null, { unit: 'mg/dL', displayText: 'Desirable: > 40' }),
          rr('LDL', null, 100, { unit: 'mg/dL', displayText: 'Optimal: < 100' }),

          rr('TBIL', 0.2, 1.2, { unit: 'mg/dL', criticalHigh: 15 }),
          rr('DBIL', 0.0, 0.3, { unit: 'mg/dL' }),
          rr('SGPT', 0, 45, { unit: 'U/L' }),
          rr('SGOT', 0, 40, { unit: 'U/L' }),
          rr('ALP', 40, 130, { unit: 'U/L' }),
          rr('TPROT', 6.4, 8.3, { unit: 'g/dL' }),
          rr('ALB', 3.5, 5.2, { unit: 'g/dL' }),

          rr('TSH', 0.4, 4.0, { unit: 'µIU/mL' }),
          rr('T3', 80, 200, { unit: 'ng/dL' }),
          rr('T4', 4.5, 12.0, { unit: 'µg/dL' }),
          rr('HBA1C', null, 5.7, {
            unit: '%',
            displayText: 'Normal < 5.7 | Prediabetes 5.7-6.4 | Diabetes ≥ 6.5',
          }),
        ],
      });

      // -----------------------------------------------------------------------
      // Tests
      // -----------------------------------------------------------------------
      const tests = new Map<string, string>();

      const mkTest = async (
        code: string,
        name: string,
        department: string,
        analyteCodes: { code: string; formula?: string }[],
        opts: {
          specimen: string;
          container: string;
          method?: string;
          price: number;
          tatMinutes: number;
          instructions?: string;
        },
      ) => {
        const t = await tx.testDefinition.create({
          data: {
            tenantId: TENANT_ID,
            code,
            name,
            department: department as never,
            methodId: opts.method ? methods.get(opts.method)! : null,
            specimenTypeId: specimens.get(opts.specimen)!,
            containerTypeId: containers.get(opts.container)!,
            price: new Prisma.Decimal(opts.price),
            tatMinutes: opts.tatMinutes,
            sacCode: '999316', // human health services
            instructions: opts.instructions,
          },
        });
        tests.set(code, t.id);
        await tx.testAnalyte.createMany({
          data: analyteCodes.map((a, i) => ({
            tenantId: TENANT_ID,
            testDefinitionId: t.id,
            analyteId: analytes.get(a.code)!,
            sortOrder: i,
            formula: a.formula ?? null,
          })),
        });
        return t;
      };

      await mkTest(
        'CBC',
        'Complete Blood Count (CBC)',
        'HAEMATOLOGY',
        ['HB', 'RBC', 'WBC', 'PLT', 'HCT', 'MCV', 'MCH', 'MCHC', 'NEUT', 'LYMP', 'EOSI', 'MONO'].map(
          (code) => ({ code }),
        ),
        { specimen: 'EDTA', container: 'LAV', method: 'IMPD', price: 350, tatMinutes: 120 },
      );

      await mkTest(
        'LIPID',
        'Lipid Profile',
        'BIOCHEMISTRY',
        [
          { code: 'CHOL' },
          { code: 'TRIG' },
          { code: 'HDL' },
          // Friedewald: LDL = Total Cholesterol - HDL - (Triglycerides / 5)
          { code: 'LDL', formula: 'CHOL - HDL - (TRIG / 5)' },
        ],
        {
          specimen: 'SER',
          container: 'YEL',
          method: 'PHOTO',
          price: 800,
          tatMinutes: 240,
          instructions: '12 hours fasting required. Water is permitted.',
        },
      );

      await mkTest(
        'LFT',
        'Liver Function Test',
        'BIOCHEMISTRY',
        ['TBIL', 'DBIL', 'SGPT', 'SGOT', 'ALP', 'TPROT', 'ALB'].map((code) => ({ code })),
        { specimen: 'SER', container: 'YEL', method: 'PHOTO', price: 900, tatMinutes: 240 },
      );

      await mkTest(
        'KFT',
        'Kidney Function Test',
        'BIOCHEMISTRY',
        ['UREA', 'CREA', 'UA', 'NA', 'K', 'CL'].map((code) => ({ code })),
        { specimen: 'SER', container: 'YEL', method: 'PHOTO', price: 850, tatMinutes: 240 },
      );

      await mkTest('GLUF', 'Glucose — Fasting', 'BIOCHEMISTRY', [{ code: 'GLUF' }], {
        specimen: 'FLU',
        container: 'GREY',
        method: 'PHOTO',
        price: 120,
        tatMinutes: 90,
        instructions: '8-12 hours overnight fasting.',
      });

      await mkTest('HBA1C', 'HbA1c (Glycated Haemoglobin)', 'BIOCHEMISTRY', [{ code: 'HBA1C' }], {
        specimen: 'EDTA',
        container: 'LAV',
        method: 'HPLC',
        price: 600,
        tatMinutes: 360,
      });

      await mkTest(
        'THYRO',
        'Thyroid Profile (T3, T4, TSH)',
        'IMMUNOLOGY',
        ['T3', 'T4', 'TSH'].map((code) => ({ code })),
        { specimen: 'SER', container: 'YEL', method: 'CLIA', price: 700, tatMinutes: 480 },
      );

      await mkTest(
        'URINE',
        'Urine Routine Examination',
        'CLINICAL_PATHOLOGY',
        ['URCOL', 'URPRO', 'URGLU', 'URDEP'].map((code) => ({ code })),
        {
          specimen: 'URN',
          container: 'UCON',
          method: 'MICRO',
          price: 200,
          tatMinutes: 120,
          instructions: 'Midstream clean-catch sample preferred.',
        },
      );
      console.log(`    tests        ${tests.size}`);

      // -----------------------------------------------------------------------
      // Panels
      // -----------------------------------------------------------------------
      const mkPanel = async (code: string, name: string, price: number, testCodes: string[]) => {
        const p = await tx.panel.create({
          data: { tenantId: TENANT_ID, code, name, price: new Prisma.Decimal(price), sacCode: '999316' },
        });
        await tx.panelItem.createMany({
          data: testCodes.map((tc, i) => ({
            tenantId: TENANT_ID,
            panelId: p.id,
            testDefinitionId: tests.get(tc)!,
            sortOrder: i,
          })),
        });
        return p;
      };

      // Bundled below the sum of parts — how these are actually sold.
      await mkPanel('MHC-BASIC', 'Master Health Checkup — Basic', 1999, [
        'CBC',
        'GLUF',
        'LIPID',
        'LFT',
        'KFT',
        'URINE',
      ]);
      await mkPanel('DIAB', 'Diabetes Screening Package', 899, ['GLUF', 'HBA1C']);
      await mkPanel('THY-FULL', 'Thyroid + CBC Package', 950, ['THYRO', 'CBC']);
      console.log(`    panels       3`);

      // -----------------------------------------------------------------------
      // Competency  —  ISO 15189: only authorised personnel may perform/verify.
      // Enforced at authorisation time, not merely recorded.
      // -----------------------------------------------------------------------
      const competencyRows: Prisma.UserCompetencyCreateManyInput[] = [];
      for (const testId of tests.values()) {
        for (const [userId, level] of [
          [technician.id, 'PERFORM'],
          [technician.id, 'VERIFY'],
          [pathologist.id, 'AUTHORIZE'],
          [pathologist.id, 'VERIFY'],
          [pathologist2.id, 'AUTHORIZE'],
        ] as const) {
          competencyRows.push({
            tenantId: TENANT_ID,
            userId,
            testDefinitionId: testId,
            level: level as never,
            validFrom: new Date('2026-01-01'),
            validUntil: new Date('2027-12-31'),
            grantedBy: admin.id,
            evidenceNote: 'Initial competency assessment on induction',
          });
        }
      }
      await tx.userCompetency.createMany({ data: competencyRows });
      console.log(`    competency   ${competencyRows.length} records`);

      // -----------------------------------------------------------------------
      // Referring doctors
      // -----------------------------------------------------------------------
      const org = await tx.referringOrganization.create({
        data: {
          tenantId: TENANT_ID,
          code: 'APOLLO-JH',
          name: 'Apollo Clinic, Jubilee Hills',
          type: 'clinic',
          city: 'Hyderabad',
          state: 'Telangana',
          stateCode: '36',
        },
      });

      const doctors = await createMany(tx.referringDoctor, TENANT_ID, [
        {
          code: 'DR001',
          name: 'Dr. Anand Krishnan',
          qualification: 'MBBS, MD (Medicine)',
          speciality: 'General Medicine',
          organizationId: org.id,
        },
        {
          code: 'DR002',
          name: 'Dr. Meera Iyer',
          qualification: 'MBBS, DGO',
          speciality: 'Obstetrics & Gynaecology',
        },
        { code: 'SELF', name: 'Self / Walk-in', speciality: 'N/A' },
      ]);

      // -----------------------------------------------------------------------
      // QC materials — the gate that makes "run QC afterwards" impossible
      // -----------------------------------------------------------------------
      const qcMat = await tx.qcMaterial.create({
        data: {
          tenantId: TENANT_ID,
          code: 'BIO-N',
          name: 'Biochemistry Control — Normal',
          manufacturer: 'Bio-Rad',
          level: 'LEVEL_1',
        },
      });
      const qcMatHigh = await tx.qcMaterial.create({
        data: {
          tenantId: TENANT_ID,
          code: 'BIO-P',
          name: 'Biochemistry Control — Pathological',
          manufacturer: 'Bio-Rad',
          level: 'LEVEL_2',
        },
      });

      const qcLot = await tx.qcLot.create({
        data: {
          tenantId: TENANT_ID,
          qcMaterialId: qcMat.id,
          lotNumber: '26071-N',
          expiryDate: new Date('2027-06-30'),
          openedAt: new Date('2026-07-01'),
        },
      });
      const qcLotHigh = await tx.qcLot.create({
        data: {
          tenantId: TENANT_ID,
          qcMaterialId: qcMatHigh.id,
          lotNumber: '26071-P',
          expiryDate: new Date('2027-06-30'),
          openedAt: new Date('2026-07-01'),
        },
      });

      await tx.qcLotAnalyte.createMany({
        data: [
          { lot: qcLot.id, a: 'GLUF', mean: 95, sd: 3.2, unit: 'mg/dL' },
          { lot: qcLot.id, a: 'CREA', mean: 1.0, sd: 0.06, unit: 'mg/dL' },
          { lot: qcLot.id, a: 'UREA', mean: 28, sd: 1.8, unit: 'mg/dL' },
          { lot: qcLot.id, a: 'CHOL', mean: 175, sd: 6.5, unit: 'mg/dL' },
          { lot: qcLotHigh.id, a: 'GLUF', mean: 265, sd: 8.4, unit: 'mg/dL' },
          { lot: qcLotHigh.id, a: 'CREA', mean: 4.2, sd: 0.21, unit: 'mg/dL' },
          { lot: qcLotHigh.id, a: 'UREA', mean: 78, sd: 3.9, unit: 'mg/dL' },
          { lot: qcLotHigh.id, a: 'CHOL', mean: 285, sd: 9.1, unit: 'mg/dL' },
        ].map((r) => ({
          tenantId: TENANT_ID,
          qcLotId: r.lot,
          analyteId: analytes.get(r.a)!,
          targetMean: new Prisma.Decimal(r.mean),
          targetSd: new Prisma.Decimal(r.sd),
          unit: r.unit,
        })),
      });
      console.log(`    qc           2 materials, 2 lots, 8 analyte targets`);

      // -----------------------------------------------------------------------
      // Analyzers
      //
      // Devices start in SHADOW MODE: they capture and parse but write nothing,
      // so a new analyzer can be validated against manual entries before it is
      // trusted (INSTRUMENT_INTEGRATION.md §7).
      // -----------------------------------------------------------------------
      const haem = await tx.device.create({
        data: {
          tenantId: TENANT_ID,
          labId: mainLab.id,
          code: 'HAEM-01',
          name: '5-Part Haematology Analyzer',
          manufacturer: 'Sysmex',
          model: 'XN-1000',
          serialNumber: 'SN-XN-88421',
          department: 'HAEMATOLOGY',
          protocol: 'ASTM_E1394',
          location: 'Haematology Bench 1',
          status: 'ACTIVE',
          isShadowMode: false,
          enrolmentCode: 'DEMO-HAEM-0001',
          enrolmentCodeExpiresAt: new Date(Date.now() + 365 * 864e5),
          lastCalibratedAt: new Date('2026-07-01'),
          calibrationDueAt: new Date('2027-01-01'),
        },
      });

      const chem = await tx.device.create({
        data: {
          tenantId: TENANT_ID,
          labId: mainLab.id,
          code: 'CHEM-01',
          name: 'Clinical Chemistry Autoanalyzer',
          manufacturer: 'Beckman Coulter',
          model: 'AU480',
          serialNumber: 'SN-AU-33915',
          department: 'BIOCHEMISTRY',
          protocol: 'HL7_V2',
          location: 'Biochemistry Bench 2',
          status: 'ACTIVE',
          isShadowMode: false,
          enrolmentCode: 'DEMO-CHEM-0001',
          enrolmentCodeExpiresAt: new Date(Date.now() + 365 * 864e5),
          lastCalibratedAt: new Date('2026-07-05'),
          calibrationDueAt: new Date('2027-01-05'),
        },
      });

      const immuno = await tx.device.create({
        data: {
          tenantId: TENANT_ID,
          labId: mainLab.id,
          code: 'IMM-01',
          name: 'CLIA Immunoassay Analyzer',
          manufacturer: 'Roche',
          model: 'cobas e411',
          serialNumber: 'SN-CB-70233',
          department: 'IMMUNOLOGY',
          protocol: 'ASTM_E1394',
          location: 'Immunoassay Bench',
          status: 'ENROLLED',
          // Still in shadow mode: newest analyzer, not yet verified against
          // manual results. This is the safe default.
          isShadowMode: true,
          enrolmentCode: 'DEMO-IMM-0001',
          enrolmentCodeExpiresAt: new Date(Date.now() + 365 * 864e5),
        },
      });

      // Channel mappings — instrument's own code -> our analyte.
      // Adding an analyzer is mostly filling in rows here.
      const channel = (deviceId: string, instrumentCode: string, analyteCode: string) => ({
        tenantId: TENANT_ID,
        deviceId,
        instrumentCode,
        analyteId: analytes.get(analyteCode)!,
      });

      await tx.deviceChannel.createMany({
        data: [
          channel(haem.id, 'WBC', 'WBC'),
          channel(haem.id, 'RBC', 'RBC'),
          channel(haem.id, 'HGB', 'HB'),
          channel(haem.id, 'HCT', 'HCT'),
          channel(haem.id, 'MCV', 'MCV'),
          channel(haem.id, 'MCH', 'MCH'),
          channel(haem.id, 'MCHC', 'MCHC'),
          channel(haem.id, 'PLT', 'PLT'),
          channel(haem.id, 'NEUT%', 'NEUT'),
          channel(haem.id, 'LYMPH%', 'LYMP'),
          channel(haem.id, 'EO%', 'EOSI'),
          channel(haem.id, 'MONO%', 'MONO'),

          channel(chem.id, 'GLU', 'GLUF'),
          channel(chem.id, 'BUN', 'UREA'),
          channel(chem.id, 'CRE', 'CREA'),
          channel(chem.id, 'UA', 'UA'),
          channel(chem.id, 'NA', 'NA'),
          channel(chem.id, 'K', 'K'),
          channel(chem.id, 'CL', 'CL'),
          channel(chem.id, 'CHOL', 'CHOL'),
          channel(chem.id, 'TG', 'TRIG'),
          channel(chem.id, 'HDLC', 'HDL'),
          channel(chem.id, 'TBIL', 'TBIL'),
          channel(chem.id, 'DBIL', 'DBIL'),
          channel(chem.id, 'ALT', 'SGPT'),
          channel(chem.id, 'AST', 'SGOT'),
          channel(chem.id, 'ALP', 'ALP'),
          channel(chem.id, 'TP', 'TPROT'),
          channel(chem.id, 'ALB', 'ALB'),

          channel(immuno.id, 'TSH', 'TSH'),
          channel(immuno.id, 'T3', 'T3'),
          channel(immuno.id, 'T4', 'T4'),
        ],
      });
      console.log(`    devices      3 analyzers, 32 channel mappings`);


      // -----------------------------------------------------------------------
      // Inventory
      //
      // Deliberately seeded with a realistic mix INCLUDING one already-expired
      // lot and one below its reorder level, so the alerts and the expired-lot
      // gate are demonstrable without anyone having to wait for stock to age.
      // -----------------------------------------------------------------------
      const day = 864e5;
      const inDays = (n: number) => new Date(Date.now() + n * day);

      const invItems = await createMany(tx.inventoryItem, TENANT_ID, [
        {
          code: 'RGT-GLU',
          name: 'Glucose (GOD-POD) Reagent',
          category: 'REAGENT' as const,
          unit: 'tests',
          manufacturer: 'Erba Mannheim',
          catalogNumber: 'BLT00016',
          reorderLevel: new Prisma.Decimal(200),
          storageCondition: '2-8°C',
        },
        {
          code: 'RGT-CREA',
          name: 'Creatinine (Jaffe) Reagent',
          category: 'REAGENT' as const,
          unit: 'tests',
          manufacturer: 'Erba Mannheim',
          reorderLevel: new Prisma.Decimal(150),
          storageCondition: '2-8°C',
        },
        {
          code: 'RGT-LIPID',
          name: 'Lipid Panel Reagent Set',
          category: 'REAGENT' as const,
          unit: 'tests',
          manufacturer: 'Beckman Coulter',
          reorderLevel: new Prisma.Decimal(100),
          storageCondition: '2-8°C',
        },
        {
          code: 'CAL-CHEM',
          name: 'Chemistry Multi-Calibrator',
          category: 'CALIBRATOR' as const,
          unit: 'vials',
          manufacturer: 'Bio-Rad',
          reorderLevel: new Prisma.Decimal(2),
          storageCondition: '-20°C',
        },
        {
          code: 'CON-EDTA',
          name: 'EDTA Vacutainer 2mL',
          category: 'CONSUMABLE' as const,
          unit: 'pieces',
          manufacturer: 'BD',
          reorderLevel: new Prisma.Decimal(500),
          storageCondition: 'Room temperature',
        },
        {
          code: 'CON-TIP',
          name: 'Pipette Tips 1000µL',
          category: 'CONSUMABLE' as const,
          unit: 'pieces',
          manufacturer: 'Tarsons',
          reorderLevel: new Prisma.Decimal(1000),
          storageCondition: 'Room temperature',
        },
      ]);

      const lots: {
        item: string;
        lotNumber: string;
        qty: number;
        expiryDays: number | null;
        supplier: string;
      }[] = [
        // Healthy stock
        { item: 'RGT-GLU', lotNumber: 'GL-26041', qty: 800, expiryDays: 240, supplier: 'Medisys Hyderabad' },
        { item: 'RGT-CREA', lotNumber: 'CR-26019', qty: 600, expiryDays: 180, supplier: 'Medisys Hyderabad' },
        { item: 'CON-EDTA', lotNumber: 'BD-2609', qty: 2400, expiryDays: 500, supplier: 'BD India' },
        { item: 'CON-TIP', lotNumber: 'TR-88120', qty: 4800, expiryDays: null, supplier: 'Tarsons' },
        // Expiring soon — drives the amber alert
        { item: 'RGT-LIPID', lotNumber: 'LP-25330', qty: 220, expiryDays: 18, supplier: 'Beckman India' },
        // Below reorder level
        { item: 'CAL-CHEM', lotNumber: 'CAL-2611', qty: 1, expiryDays: 120, supplier: 'Bio-Rad India' },
        // ALREADY EXPIRED — consuming from this is refused by the gate
        { item: 'RGT-GLU', lotNumber: 'GL-25008', qty: 150, expiryDays: -12, supplier: 'Medisys Hyderabad' },
      ];

      for (const l of lots) {
        const qty = new Prisma.Decimal(l.qty);
        const lot = await tx.inventoryLot.create({
          data: {
            tenantId: TENANT_ID,
            itemId: invItems.get(l.item)!,
            lotNumber: l.lotNumber,
            expiryDate: l.expiryDays === null ? null : inDays(l.expiryDays),
            quantityReceived: qty,
            quantityRemaining: qty,
            supplier: l.supplier,
            receivedBy: admin.id,
            status: 'AVAILABLE',
          },
        });
        await tx.stockTransaction.create({
          data: {
            tenantId: TENANT_ID,
            lotId: lot.id,
            type: 'RECEIPT',
            quantity: qty,
            balanceAfter: qty,
            reason: 'Opening stock',
            performedBy: admin.id,
          },
        });
      }

      // How much of each item one run of a test consumes. This is what makes
      // stock decrement automatically when results are entered.
      await tx.testReagentUsage.createMany({
        data: [
          { test: 'GLUF', item: 'RGT-GLU', qty: 1 },
          { test: 'KFT', item: 'RGT-CREA', qty: 1 },
          { test: 'LIPID', item: 'RGT-LIPID', qty: 1 },
          { test: 'CBC', item: 'CON-EDTA', qty: 1 },
        ].map((u) => ({
          tenantId: TENANT_ID,
          testDefinitionId: tests.get(u.test)!,
          inventoryItemId: invItems.get(u.item)!,
          quantityPerTest: new Prisma.Decimal(u.qty),
        })),
      });

      console.log(
        `    inventory    ${invItems.size} items, ${lots.length} lots (1 expired, 1 expiring, 1 low), 4 usage rules`,
      );

      // -----------------------------------------------------------------------
      // Demo patients + orders
      // -----------------------------------------------------------------------
      const mkPatient = async (
        code: string,
        name: string,
        sex: 'MALE' | 'FEMALE',
        ageYears: number,
        phone: string,
      ) => {
        const patientKey = generateKey();
        return tx.patient.create({
          data: {
            tenantId: TENANT_ID,
            patientCode: code,
            nameEnc: encrypt(name, patientKey),
            nameIdx: blindIndex(name, blindIndexKey, 'patient.name'),
            phoneEnc: encrypt(phone, patientKey),
            phoneIdx: blindIndex(phone, blindIndexKey, 'patient.phone'),
            dataKeyEnc: wrapKey(patientKey, tenantDek),
            sex,
            ageYears,
          },
        });
      };

      const patients = await Promise.all([
        mkPatient('SUN000001', 'Ramesh Kumar', 'MALE', 52, '+919848012345'),
        mkPatient('SUN000002', 'Lakshmi Devi', 'FEMALE', 38, '+919848012346'),
        mkPatient('SUN000003', 'Imran Sheikh', 'MALE', 29, '+919848012347'),
        mkPatient('SUN000004', 'Sunita Patel', 'FEMALE', 45, '+919848012348'),
      ]);
      console.log(`    patients     ${patients.length} (identifiers encrypted per patient)`);

      // A few orders in different workflow states, so every screen has content.
      const today = new Date();
      const yy = String(today.getFullYear()).slice(2);
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      const datePart = `${yy}${mm}${dd}`;

      let accessionSeq = 0;
      const nextAccession = () => `HYD${datePart}${String(++accessionSeq).padStart(5, '0')}`;

      const mkOrder = async (
        patientIndex: number,
        testCodes: string[],
        sampleStatus: 'RECEIVED' | 'IN_PROGRESS' | 'COMPLETED',
        testStatus: 'PENDING' | 'IN_PROGRESS' | 'RESULT_ENTERED' | 'TECH_VERIFIED',
        orderSeq: number,
      ) => {
        const patient = patients[patientIndex]!;
        const order = await tx.labOrder.create({
          data: {
            tenantId: TENANT_ID,
            labId: mainLab.id,
            orderNumber: `ORD${datePart}${String(orderSeq).padStart(4, '0')}`,
            patientId: patient.id,
            referringDoctorId: doctors.get('DR001')!,
            priority: 'ROUTINE',
            createdBy: reception.id,
          },
        });

        let total = new Prisma.Decimal(0);
        const orderItems = [];
        for (const tc of testCodes) {
          const td = await tx.testDefinition.findFirstOrThrow({ where: { id: tests.get(tc)! } });
          const item = await tx.orderItem.create({
            data: {
              tenantId: TENANT_ID,
              orderId: order.id,
              testDefinitionId: td.id,
              unitPrice: td.price,
              netAmount: td.price,
            },
          });
          orderItems.push({ item, td });
          total = total.add(td.price);
        }

        const sample = await tx.sample.create({
          data: {
            tenantId: TENANT_ID,
            labId: mainLab.id,
            orderId: order.id,
            accessionNumber: nextAccession(),
            barcode: nextBarcode(),
            patientId: patient.id,
            specimenTypeId: specimens.get('SER')!,
            containerTypeId: containers.get('YEL')!,
            status: sampleStatus,
            collectedAt: new Date(Date.now() - 3 * 3600e3),
            collectedBy: reception.id,
            receivedAt: new Date(Date.now() - 2.5 * 3600e3),
            receivedBy: technician.id,
            createdBy: reception.id,
          },
        });

        for (const { item, td } of orderItems) {
          await tx.sampleTest.create({
            data: {
              tenantId: TENANT_ID,
              sampleId: sample.id,
              orderItemId: item.id,
              testDefinitionId: td.id,
              testVersion: td.version,
              status: testStatus,
              deviceId: td.department === 'HAEMATOLOGY' ? haem.id : chem.id,
              startedAt: testStatus === 'PENDING' ? null : new Date(Date.now() - 2 * 3600e3),
              dueAt: new Date(Date.now() + (td.tatMinutes ?? 240) * 60e3 - 2 * 3600e3),
            },
          });
        }

        // GST: diagnostic services are largely exempt, hence 0% here. The
        // machinery exists because non-clinical services are not exempt.
        await tx.invoice.create({
          data: {
            tenantId: TENANT_ID,
            labId: mainLab.id,
            orderId: order.id,
            invoiceNumber: `INV${datePart}${String(orderSeq).padStart(4, '0')}`,
            customerType: 'B2C',
            customerName: 'Walk-in Patient',
            placeOfSupply: '36',
            subTotal: total,
            taxableAmount: total,
            totalAmount: total,
            status: 'UNPAID',
            createdBy: reception.id,
          },
        });

        return { order, sample };
      };

      await mkOrder(0, ['CBC', 'LIPID'], 'IN_PROGRESS', 'IN_PROGRESS', 1);
      await mkOrder(1, ['THYRO'], 'RECEIVED', 'PENDING', 2);
      await mkOrder(2, ['KFT', 'LFT'], 'IN_PROGRESS', 'RESULT_ENTERED', 3);
      await mkOrder(3, ['CBC', 'GLUF', 'HBA1C'], 'IN_PROGRESS', 'TECH_VERIFIED', 4);

      // Counters MUST reflect what the seed already created, or the API's first
      // generated identifier collides with a seeded one. Every sequence the
      // seed consumed by hand is handed back here.
      await tx.accessionCounter.createMany({
        data: [
          {
            tenantId: TENANT_ID,
            labId: mainLab.id,
            scope: `SAMPLE:${today.toISOString().slice(0, 10)}`,
            counter: accessionSeq,
          },
          {
            tenantId: TENANT_ID,
            labId: mainLab.id,
            scope: 'PATIENT',
            counter: patients.length,
          },
          {
            tenantId: TENANT_ID,
            labId: mainLab.id,
            scope: `ORDER:${today.toISOString().slice(0, 10)}`,
            counter: 4,
          },
          {
            tenantId: TENANT_ID,
            labId: mainLab.id,
            scope: `INVOICE:${financialYear(today)}`,
            counter: 4,
          },
        ],
      });

      console.log(`    orders       4 across different workflow states\n`);
    },
    { timeout: 180_000, maxWait: 20_000 },
  );

  console.log('  Seed complete.\n');
  console.log('  Sign in at http://localhost:3100');
  console.log('    Tenant code : SUNRISE');
  console.log(`    Password    : ${DEMO_PASSWORD}   (all demo users)\n`);
  console.log('    admin@sunrise.test        Lab Administrator');
  console.log('    pathologist@sunrise.test  Pathologist  — can authorise');
  console.log('    tech@sunrise.test         Technician   — can enter/verify, NOT authorise');
  console.log('    front@sunrise.test        Front desk   — registration & billing');
  console.log('    auditor@sunrise.test      Auditor      — read-only + audit trail\n');
}

/** Bulk-create rows that all share the tenant, returning a code -> id map. */
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

let barcodeCounter = 100000;
const nextBarcode = () => `BC${++barcodeCounter}`;

/** India's financial year starts 1 April. Must match AccessionService. */
function financialYear(d: Date): string {
  const year = d.getFullYear();
  const startYear = d.getMonth() >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

main()
  .catch((e) => {
    console.error('\n  Seed failed:\n');
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
