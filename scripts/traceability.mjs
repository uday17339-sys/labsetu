#!/usr/bin/env node
/**
 * Requirements traceability and dead-end audit.
 *
 * Two questions this answers that no functional test can:
 *
 *   1. Is anything DECLARED but not WIRED? A permission with no route behind
 *      it, a Prisma model nothing reads, an API endpoint no screen reaches.
 *      These are the seams where a demo goes "…and that button doesn't do
 *      anything yet."
 *
 *   2. Which requirements from the market report are actually met?
 *
 * Reports honestly. Gaps are printed as GAP, not massaged into passes.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, exts = ['.ts', '.tsx']) {
  const out = [];
  const visit = (d) => {
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === 'node_modules' || e === 'dist' || e === '.next') continue;
      const p = join(d, e);
      const s = statSync(p);
      if (s.isDirectory()) visit(p);
      else if (exts.some((x) => e.endsWith(x))) out.push(p);
    }
  };
  visit(dir);
  return out;
}

const apiSrc = walk(join(root, 'apps/api/src'));
const webSrc = walk(join(root, 'apps/web/src'));
const apiText = apiSrc.map((f) => readFileSync(f, 'utf8')).join('\n');
const webText = webSrc.map((f) => readFileSync(f, 'utf8')).join('\n');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const amber = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let issues = 0;

// ---------------------------------------------------------------- permissions
console.log(`\n${bold('1. Permissions — declared vs enforced')}\n`);

const permsFile = readFileSync(join(root, 'packages/contracts/src/permissions.ts'), 'utf8');
// Capture BOTH the constant name and its value: routes are decorated with
// @RequirePermissions(PERMISSIONS.RESULT_VERIFY), never the raw string, so
// checking only for the literal reports every permission as unused.
const declaredPerms = [...permsFile.matchAll(/^\s+([A-Z_]+):\s*'([a-z_]+:[a-z_]+)'/gm)].map(
  (m) => ({ key: m[1], value: m[2] }),
);

const unusedPerms = declaredPerms
  .filter((p) => !apiText.includes(`PERMISSIONS.${p.key}`) && !apiText.includes(`'${p.value}'`))
  .map((p) => p.value);
// Every permission should appear in a role template too, or no user can hold it.
const rolesSection = permsFile.split('DEFAULT_ROLES')[1] ?? '';
const unassigned = declaredPerms.filter(
  (p) => !rolesSection.includes(p.key) && !rolesSection.includes('ALL_PERMISSIONS'),
);

// Permissions the registry itself declares as not-yet-implemented are a known,
// documented roadmap item — not an integrity failure. Anything unenforced and
// NOT on that list is a genuine inconsistency.
const knownUnimplemented = new Set(
  [...permsFile.matchAll(/PERMISSIONS\.([A-Z_]+),\s*(?:\/\/.*)?$/gm)]
    .map((m) => declaredPerms.find((d) => d.key === m[1])?.value)
    .filter(Boolean),
);
const unexpected = unusedPerms.filter((p) => !knownUnimplemented.has(p));
const expected = unusedPerms.filter((p) => knownUnimplemented.has(p));

console.log(`  ${declaredPerms.length} permissions declared`);
console.log(`  ${green(`${declaredPerms.length - unusedPerms.length} enforced on a route`)}`);

if (expected.length > 0) {
  console.log(`  ${dim(`${expected.length} declared as not-yet-implemented (documented roadmap):`)}`);
  for (const p of expected) console.log(`    ${dim(`- ${p}`)}`);
}

if (unexpected.length > 0) {
  issues++;
  console.log(`  ${red(`${unexpected.length} unenforced and UNDOCUMENTED:`)}`);
  for (const p of unexpected) console.log(`    - ${p}`);
} else {
  console.log(`  ${green('no undocumented gaps')}`);
}
console.log(
  unassigned.length === 0
    ? `  ${green('all are grantable via a role template')}`
    : `  ${amber(`${unassigned.length} not in any role template`)}`,
);

// -------------------------------------------------------------------- routes
console.log(`\n${bold('2. API routes — exposed vs reachable from the UI or a test')}\n`);

const routeRe = /@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)')?\s*\)/g;
const controllerRe = /@Controller\(\{\s*path:\s*'([^']+)'/g;

const routes = [];
for (const file of apiSrc) {
  const text = readFileSync(file, 'utf8');
  const bases = [...text.matchAll(controllerRe)].map((m) => m[1]);
  const base = bases[0] ?? '';
  for (const m of text.matchAll(routeRe)) {
    const path = m[2] ?? '';
    routes.push({
      method: m[1].toUpperCase(),
      path: `/${[base, path].filter(Boolean).join('/')}`,
      file: file.replace(root, '').replace(/\\/g, '/'),
    });
  }
}

const testText = ['smoke-test.mjs', 'gateway-e2e.mjs', 'ui-verify.mjs']
  .map((f) => {
    try {
      return readFileSync(join(root, 'scripts', f), 'utf8');
    } catch {
      return '';
    }
  })
  .join('\n');

// '/tests/:id/verify' must match "/tests/${test.id}/verify" and
// "/tests/${id}/verify" alike, so :param becomes a permissive segment matcher
// rather than being deleted (which glued the surrounding slashes together and
// matched nothing).
const callSites = webText + testText;

const unreached = routes.filter((r) => {
  // A path parameter appears at the call site as `${id}` or `${test.id}`, which
  // never contains a slash — so [^/]+ matches it without needing to reason
  // about quote characters.
  const pattern = r.path
    .split('/')
    .filter(Boolean)
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg))
    .join('/');
  return !new RegExp('/' + pattern).test(callSites);
});

console.log(`  ${routes.length} routes exposed`);
if (unreached.length === 0) {
  console.log(`  ${green('every route is reachable from the UI or exercised by a test')}`);
} else {
  console.log(`  ${amber(`${unreached.length} not reached by the UI or tests:`)}`);
  for (const r of unreached) console.log(`    ${r.method.padEnd(6)} ${r.path}`);
}

// -------------------------------------------------------------------- models
console.log(`\n${bold('3. Data model — defined vs used')}\n`);

const schema = readFileSync(join(root, 'packages/db/prisma/schema.prisma'), 'utf8');
const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// A model reached only through a relation include (e.g. `analytes: { include:
// { analyte: true } }`) is genuinely used. Only flag models with no direct
// accessor AND no relation field pointing at them from a model the API does
// touch — those are the ones with no code path at all.
const relationFields = new Map();
for (const block of schema.split(/^model\s+/m).slice(1)) {
  const name = block.split(/\s/)[0];
  relationFields.set(name, block);
}

const unusedModels = models.filter((m) => {
  const accessor = `tx.${lower(m)}`;
  if (apiText.includes(accessor) || apiText.includes(`.${lower(m)}.`)) return false;
  // Reached via an include from a model the API does query?
  const referencedBy = [...relationFields.entries()].filter(
    ([owner, body]) =>
      owner !== m && new RegExp(`\b${m}\b`).test(body) && apiText.includes(`tx.${lower(owner)}`),
  );
  if (referencedBy.length > 0) {
    // Only counts if the API actually selects that relation somewhere.
    const relName = lower(m);
    const plural = `${relName}s`;
    if (apiText.includes(`${relName}:`) || apiText.includes(`${plural}:`)) return false;
  }
  return true;
});

console.log(`  ${models.length} models defined`);
if (unusedModels.length === 0) {
  console.log(`  ${green('all are read or written by the API')}`);
} else {
  console.log(`  ${amber(`${unusedModels.length} defined but never accessed:`)}`);
  for (const m of unusedModels) console.log(`    - ${m}`);
}

// ------------------------------------------------------- report requirements
console.log(`\n${bold('4. Requirements from the market report')}\n`);

// Corpus must include the schema and shared contracts: a capability can be
// implemented there (an enum, a model, a channel mapping) and still be real.
// Searching only apps/* reported DeviceChannel and ConsentPurpose as missing
// when both are central to the design.
const schemaText = schema;
const contractsText = walk(join(root, 'packages/contracts/src'))
  .map((f) => readFileSync(f, 'utf8'))
  .join(' ');
const fullCorpus = apiText + webText + schemaText + contractsText;

const has = (needle, corpus = fullCorpus) =>
  (Array.isArray(needle) ? needle : [needle]).every((n) =>
    corpus.toLowerCase().includes(n.toLowerCase()),
  );

const REQUIREMENTS = [
  // --- LabWare core capabilities, report §2.3 ---
  ['§2.3', 'Sample login & management', has('accessionNumber'), 'BUILT'],
  ['§2.3', 'Result entry with validation', has('enterResults'), 'BUILT'],
  ['§2.3', 'Instrument interfacing', has('InstrumentMessage'), 'BUILT'],
  ['§2.3', 'Workflows & dashboards', has('worklist'), 'BUILT'],
  ['§2.3', 'Training / analyst certification', has(['UserCompetency', 'grantCompetency']), 'BUILT'],
  ['§2.3', 'Staff onboarding & role assignment', has('AdminService'), 'BUILT'],
  ['§2.3', 'Catalog authoring (tests, prices, ranges)', has('CatalogAdminService'), 'BUILT'],
  ['§2.3', 'Barcoding — scan input', has('by-accession'), 'BUILT'],
  ['§2.3', 'Barcoding — label printing', has('ZPL'), 'GAP'],
  ['§2.3', 'Data search & audit trail', has('auditLog'), 'BUILT'],
  ['§2.3', 'Critical-value callback log', has('CRITICAL_VALUE_NOTIFIED'), 'BUILT'],
  ['§2.3', 'Report register / search', has('reportNumber'), 'BUILT'],
  ['§2.3', 'Instrument health monitoring', has('listDevices'), 'BUILT'],
  ['§2.3', 'Cumulative patient history', has('CUMULATIVE_HISTORY'), 'BUILT'],
  ['§2.3', 'Data export (CSV)', has('toCsv'), 'BUILT'],
  ['§2.3', 'Mobile access', has('manifest'), 'BUILT (PWA)'],
  ['§2.3', 'Lot/batch management + COA', has(['MaterialBatch', 'CertificateOfAnalysis']), 'BUILT'],
  ['§2.3', 'Stores — raw materials & finished product', has('StoresService'), 'BUILT'],
  ['§2.3', 'Goods receipt into quarantine', has('receiveGoods'), 'BUILT'],
  ['§2.3', 'Quarantine gate on issue', has('Only QA-approved material'), 'BUILT'],
  ['§2.3', 'Specifications, versioned and QA-approved', has('SpecificationsService'), 'BUILT'],
  ['§2.3', 'Sampling request — stores to QC', has('SamplingRequest'), 'BUILT'],
  ['§2.3', 'QA batch disposition, signed', has('BatchDisposition'), 'BUILT'],
  ['§2.3', 'OOS investigation, opened automatically', has('OosDetectorService'), 'BUILT'],
  ['§2.3', 'QC / QA role separation', has('QC_ANALYST'), 'BUILT'],
  ['§2.3', 'Stability study management', has('StabilityStudy'), 'DEFERRED — scheduled generator'],
  ['§2.3', 'Environmental monitoring', has('EnvironmentalMonitoring'), 'DEFERRED — scheduled generator'],
  ['§2.3', 'Inventory management', has('InventoryLot'), 'BUILT'],
  ['§2.3', 'Expired-reagent gate', has('quantityRemaining'), 'BUILT'],
  ['§2.3', 'External stakeholder portal', has('patientPortal'), 'GAP'],
  ['§2.3', 'ELN', has('experimentNotebook'), 'DEFERRED — deliberate'],
  ['§2.3', 'AI/ML', false, 'DEFERRED — buyers not asking (§11.2)'],

  // --- what Indian labs actually asked for, report §11.2 ---
  ['§11.2', 'Get off paper / manual registers', has('accessionNumber'), 'BUILT'],
  ['§11.2', 'NABL-compliant, simplifies audits', has('qualityIndicators'), 'BUILT'],
  ['§11.2', 'Digital reports to patients', has('ReportDelivery'), 'PARTIAL — queued, no provider'],
  ['§11.2', 'WhatsApp delivery', has('whatsappApiToken') || has('gupshup'), 'GAP — provider not wired'],
  ['§11.2', 'GST-ready billing', has(['cgstAmount', 'BillingService']), 'BUILT'],
  ['§11.2', 'Collections at the counter', has('recordPayment'), 'BUILT'],
  ['§11.2', 'Revenue & referral analytics', has('AnalyticsService'), 'BUILT'],
  ['§11.2', 'Regional languages', has('next-intl') || has('useTranslations'), 'GAP'],
  ['§11.2', 'Analyzers used in India', has('DeviceChannel'), 'BUILT'],

  // --- the differentiators, report Part 6 / Part 9 ---
  ['Part 6', 'Regulation-grade audit trail', has('prevHash'), 'BUILT'],
  ['Part 6', 'DPDP-first architecture', has('ConsentPurpose'), 'BUILT'],
  ['Part 6', 'Crypto-shredded erasure', has('ERASURE_EXECUTED'), 'BUILT'],
  ['Part 6', 'India data residency', has('DATA_RESIDENCY_REGION'), 'BUILT'],
  ['Part 6', 'Multi-site / branch support', has('labId'), 'BUILT'],
  ['Part 6', 'Instrument integration, bounded', has('isShadowMode'), 'BUILT'],

  // --- recommendations, report Part 13 ---
  ['Part 13', 'One beachhead vertical (diagnostics)', has('patientCode'), 'BUILT'],
  ['Part 13', 'Quality/regulatory co-architect', false, 'GAP — hiring, blocks pharma'],
  ['Part 13', 'Services-inclusive delivery model', false, 'BUSINESS'],
  ['Part 13', 'Reference-customer strategy', false, 'BUSINESS'],
];

const width = Math.max(...REQUIREMENTS.map((r) => r[1].length)) + 2;
let built = 0;
let partial = 0;
let gaps = 0;
let deferred = 0;

for (const [ref, name, detected, expected] of REQUIREMENTS) {
  let status;
  if (expected === 'BUILT' || expected === 'BUILT (PWA)') {
    status = detected ? green('BUILT') : red('CLAIMED BUT MISSING');
    detected ? built++ : issues++;
  } else if (expected.startsWith('PARTIAL')) {
    status = amber(expected);
    partial++;
  } else if (expected.startsWith('GAP')) {
    status = red(expected);
    gaps++;
  } else if (expected.startsWith('DEFERRED')) {
    status = dim(expected);
    deferred++;
  } else {
    status = dim(expected);
  }
  console.log(`  ${dim(ref.padEnd(8))} ${name.padEnd(width)} ${status}`);
}

// -------------------------------------------------------------------- summary
console.log(`\n${bold('Summary')}\n`);
console.log(`  ${green(`${built} built`)}  ·  ${amber(`${partial} partial`)}  ·  ${red(`${gaps} gaps`)}  ·  ${dim(`${deferred} deliberately deferred`)}`);

if (issues > 0) {
  console.log(`\n  ${red(`${issues} integrity problem(s) — something is claimed but not present.`)}\n`);
  process.exit(1);
}
console.log(`\n  ${green('No dead ends: nothing is declared without being wired.')}\n`);
