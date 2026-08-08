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
