/**
 * Which vertical this deployment serves.
 *
 * The schema supports both — `Sample` reaches either a patient or a material
 * batch, and a CHECK constraint enforces exactly one. But a single deployment
 * serves one kind of customer, and showing a pharma plant a "Register patient"
 * button (or a diagnostic lab a goods-receipt screen) makes the product look
 * like it was built for somebody else.
 *
 * Deployment-level rather than permission-level on purpose: an administrator
 * legitimately holds every permission, so permission-gating alone would still
 * show them every screen from both worlds.
 */
export type Vertical = 'PHARMA' | 'DIAGNOSTICS';

export const VERTICAL: Vertical =
  (process.env.APP_VERTICAL as Vertical | undefined) ?? 'PHARMA';

export const isPharma = VERTICAL === 'PHARMA';
export const isDiagnostics = VERTICAL === 'DIAGNOSTICS';

/**
 * Language differs between the two, and using the wrong word is the fastest way
 * to look like a diagnostics tool with a pharma skin bolted on.
 *
 * A pharma QC lab books an AR (Analytical Request) number against a batch; a
 * diagnostic lab accessions a specimen from a patient.
 */
export const TERMS = isPharma
  ? {
      subject: 'batch',
      subjectPlural: 'batches',
      accession: 'AR number',
      order: 'analytical request',
      orderPlural: 'analytical requests',
      lab: 'QC',
      report: 'Certificate of Analysis',
      indicators: 'GMP quality indicators',
      indicatorsNote: 'Last 30 days. These are the indicators a Schedule M inspector samples.',
    }
  : {
      subject: 'patient',
      subjectPlural: 'patients',
      accession: 'accession number',
      order: 'order',
      orderPlural: 'orders',
      lab: 'the lab',
      report: 'report',
      indicators: 'NABL quality indicators',
      indicatorsNote: 'Last 30 days. These are the indicators an assessor samples.',
    };

/**
 * The accounts offered on the sign-in screen.
 *
 * A demo where the visitor has to be told the password out loud, or where the
 * panel lists logins from a previous vertical that no longer exist, is a demo
 * that starts with an apology. These are the seeded accounts, in the order a
 * batch actually moves through the plant.
 *
 * Set `SHOW_DEMO_ACCOUNTS=false` on any deployment holding real data — the
 * panel is for a seeded demo tenant and nothing else.
 */
export const SHOW_DEMO_ACCOUNTS = process.env.SHOW_DEMO_ACCOUNTS !== 'false';

export const DEMO = isPharma
  ? {
      tenantCode: 'VANTAGE',
      tenantName: 'Vantage Pharmaceuticals',
      password: 'LabSetu@2026',
      accounts: [
        { email: 'stores@vantage.test', role: 'Stores', can: 'books in consignments, quarantines, issues to production' },
        { email: 'qc@vantage.test', role: 'QC Analyst', can: 'samples, tests and verifies — cannot release a batch' },
        { email: 'qa@vantage.test', role: 'Quality Assurance', can: 'releases batches, closes investigations, signs the CoA' },
        { email: 'admin@vantage.test', role: 'Administrator', can: 'staff, competency, specifications, catalogue' },
        { email: 'auditor@vantage.test', role: 'Auditor', can: 'read-only, full audit trail' },
      ],
    }
  : {
      tenantCode: 'SUNRISE',
      tenantName: 'Sunrise Diagnostics',
      password: 'LabSetu@2026',
      accounts: [
        { email: 'front@sunrise.test', role: 'Front desk', can: 'registration, ordering, billing' },
        { email: 'tech@sunrise.test', role: 'Technician', can: 'enters and verifies — cannot authorise' },
        { email: 'pathologist@sunrise.test', role: 'Pathologist', can: 'authorises and releases reports' },
        { email: 'auditor@sunrise.test', role: 'Auditor', can: 'read-only, full audit trail' },
      ],
    };

/**
 * The three claims on the sign-in screen.
 *
 * The first thing a visitor reads should name the regime they are audited
 * against. Leading a Head of Quality with "NABL / ISO 15189" tells them
 * immediately that this was built for somebody else's industry.
 */
export const PITCH: [string, string][] = isPharma
  ? [
      ['Schedule M · Part 11', 'Audit trail, e-signature, four-eyes batch release'],
      ['Specification-driven', 'Every result judged against the approved spec, versioned'],
      ['Instrument integration', 'HPLC, Karl Fischer and dissolution normalised at the edge'],
    ]
  : [
      ['NABL / ISO 15189', 'Competency, QC gating, quality indicators'],
      ['DPDP Act, 2023', 'Consent, encryption, India-only residency'],
      ['Analyzer integration', 'ASTM and HL7 normalised at the edge'],
    ];
