# LabSetu

An India-first, audit-grade Laboratory Information Management System.

Built against the market analysis in [`LabWare_LIMS_India_Report (2).md`](<./LabWare_LIMS_India_Report (2).md>),
which identified a **"missing middle"**: mid-sized Indian labs that have outgrown
spreadsheets but are priced out of LabWare/Thermo/LabVantage, and underserved by
diagnostics-only Indian tools that lack regulation-grade depth.

**Beachhead vertical:** diagnostics / pathology. **Phase two:** mid-size pharma QC.

---

## What this actually is

Not "digitisation." The report (§11.1) documented staff at NABL-accredited labs
describing backdating of QC logs before inspections. The product being sold is:

> **The time a record was created is assigned by the server, is part of a
> tamper-evident hash chain, and cannot be set, edited, or deleted by any user —
> including a tenant administrator.**

Everything below exists to make that claim true and demonstrable.

---

## Quick start

Requires **Node 22+** and **Docker**.

### Hosted (recommended — this is how it should be demoed)

The whole system, containerised, behind TLS, in one command:

```bash
node scripts/setup-prod-env.mjs localhost    # or your real domain
npm run prod:up
```

Then seed a demo lab:

```bash
set -a && . ./.env.production && set +a
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm \
  -e ENCRYPTION_MASTER_KEY -e BLIND_INDEX_KEY \
  migrate sh -c "npx tsx packages/db/prisma/seed.ts"
```

Open **https://localhost**. With a real domain in `PUBLIC_HOST`, Caddy issues a
Let's Encrypt certificate automatically on first boot. Full detail in
[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).

Only ports 80 and 443 are exposed — Postgres, Redis, MinIO and both app
containers are reachable only on the internal Docker network, and the app
containers run unprivileged with read-only root filesystems.

### Local development

```bash
node scripts/setup-env.mjs   # generates .env with real dev secrets
npm install
npm run infra:up             # Postgres, Redis, MinIO, Mailpit
npm run db:generate
npm run db:migrate           # migrations + RLS security layer
npm run db:seed              # a realistic demo lab
npm run build
npm run dev                  # API :4000, web :3100
```

### Sign in

Tenant `SUNRISE`, password `LabSetu@2026`:

| Account | Role | Can do |
|---|---|---|
| `pathologist@sunrise.test` | Pathologist | Authorise and release reports |
| `tech@sunrise.test` | Technician | Enter and verify — **cannot** authorise |
| `front@sunrise.test` | Front desk | Registration, ordering, billing |
| `auditor@sunrise.test` | Auditor | Read-only, full audit trail |

> Ports 55432 (Postgres) and 3100 (web) are deliberately non-default so a
> locally-installed Postgres on 5432 and a dev server on 3000 keep working.

---

## Deploying

**Testing / demo — free tier:**
[**docs/DEPLOY_VERCEL_TESTING.md**](./docs/DEPLOY_VERCEL_TESTING.md) — Vercel (web + API) and
Neon Postgres, about 20 minutes, no card. `npm run setup:neon "<url>"` does the database in
one command. Section 7 states plainly what makes it unsuitable for real patients.

**Production:**
[**docs/DEPLOYMENT_GUIDE.md**](./docs/DEPLOYMENT_GUIDE.md) — three paths (single VM,
Vercel + managed services, full cloud), a pre-flight checklist, and a direct answer to
"can this go on Vercel alone?" (no: the instrument gateway opens TCP listeners on the lab
LAN, which no cloud function can do).

---

## Verification

**405 checks across 10 suites**, one command, runnable against any deployment:

```bash
npm run verify https://localhost     # the hosted stack
npm run verify                       # local dev
```

| Suite | Checks | Covers |
|---|---|---|
| Clinical workflow | 53 | register → accession → result → verify → authorise → report |
| Gateway → API | 22 | device auth, HMAC, idempotency, channel mapping, held queue |
| ASTM / HL7 parsers | 35 | real analyzer messages, odd delimiters, hostile input |
| Quality control | 26 | Westgard rules, drift detection, **the QC gate blocking and unblocking authorisation** |
| Inventory, history, export | 35 | **the expired-reagent gate**, FEFO, auto-consumption, cumulative history, CSV safety |
| Billing, admin, competency | 72 | **over-payment refused**, **cancel-with-payments refused**, **competency without evidence refused**, catalog versioning, **callback read-back required**, **every payment mode round-tripped against the database enum** |
| Manufacturing QC | 50 | **quarantined material cannot be issued**, **sampling without an approved spec refused**, **OOS opens automatically and blocks release**, **critical excursion cannot be dispositioned around**, QC/QA separation |
| Web UI | 38 | session refresh, PWA, RBAC in the UI, edge headers |
| Visual (real Chromium) | 45 | 4 viewports — overflow, touch targets, legibility, console errors |
| Responsive edge cases | 29 | 320px, landscape, 200% zoom, form error states, print stylesheet |

A separate static audit checks that nothing is *declared* without being *wired* —
a permission with no route, a model nothing reads, an endpoint no screen reaches:

```bash
npm run audit:trace
```

The visual suite drives an actual browser at iPhone SE, iPhone 14 Pro, iPad mini
and desktop sizes, and writes screenshots to `.playwright/`. Asserting that a
`md:hidden` class exists is not the same as knowing the page fits a phone.

These assert the controls actually fire, rather than assuming they do:

- a technician cannot authorise (RBAC), and the person who entered a result cannot authorise it (four-eyes)
- authorisation without a valid signature is refused, and a signature bound to stale content is refused
- an unsigned or tampered analyzer message is rejected; a replayed one is a no-op
- an unmatched analyzer result is **held**, never guessed
- instrument results are **never** auto-authorised
- the audit trail contains no PII or secrets, and the chain verifies
- `UPDATE audit_log` is denied by the database itself
- an expired access token is refreshed transparently mid-session
- a revoked refresh token signs out cleanly rather than erroring
- no screen overflows horizontally on a 375px phone

---

## Two kinds of laboratory

The same system serves both, sharing one spine and diverging only at the subject of an order.

| | Diagnostics | Manufacturing QC |
|---|---|---|
| Subject of an order | A patient | A material batch |
| Acceptance criteria | Reference range, by age and sex | Specification, approved by QA and versioned by effective date |
| Who decides | Pathologist authorises the report | QC produces the result, **QA disposes of the batch** |
| Out of range | Flagged; critical values telephoned with read-back | **Opens an OOS investigation automatically**, which blocks release |
| The document | Patient report | Certificate of analysis |
| Roles | Pathologist, technician, phlebotomist, front desk, accounts | **Stores, QC analyst, QA** |

Everything between those two columns — accessioning, result entry, competency enforcement,
the analyser QC gate, e-signatures, the hash-chained audit trail — is one implementation.
Roles are permission-gated, so a diagnostic lab never sees a stores tab and a pharma site
never sees phlebotomy.

The separation that matters most in the right-hand column: **a QC analyst can test all day
and cannot release a gram of material; QA can release and cannot enter a result.** Collapsing
those into one "quality" role is the most common finding in a GMP inspection, so the software
does not offer it.

---

## Requirements coverage

Traced against the market report. `npm run audit:trace` regenerates this.

**Built and verified (39)** — including the whole manufacturing QC chain: stores with a
quarantine gate, versioned QA-approved specifications, sampling requests, automatic OOS
investigations, signed batch disposition and certificates of analysis. Plus, on the
diagnostics side: sample login and accessioning, result entry with
validation, instrument interfacing and **instrument health monitoring**, worklists
and dashboards, **staff onboarding and role assignment**, **competency assessment**
(granted, superseded on re-assessment, and enforced at authorisation), barcode scan
input, audit trail and search, **the critical-value callback log**, **the report
register**, mobile access, QC with Westgard rules and authorisation gating,
**QC lot authoring with target values**, **inventory with an expired-reagent gate**,
**catalog authoring — tests, prices, panels, reference ranges, referring doctors**,
**GST billing with collections at the counter**, **revenue, test-mix and referral
analytics**, cumulative patient history, CSV export, hash-chained audit, DPDP consent
and crypto-shredded erasure, India residency, multi-branch, shadow-mode analyzer
onboarding, the diagnostics beachhead.

**Partial (1)**

| Requirement | State |
|---|---|
| Digital report delivery (§11.2) | Queued with a DPDP consent check and blocked without it. No WhatsApp/SMS/email provider is wired, so nothing actually sends. |

**Gaps (5)** — stated plainly, not buried

| Requirement | Why it matters | Status |
|---|---|---|
| **Regional languages** (§6.4, §11.2) | The report names this repeatedly as a differentiator against the global incumbents. Bench staff may be far more comfortable in Telugu or Hindi than English. | Not built. No i18n framework, no translations. |
| **WhatsApp delivery** (§11.2) | Named directly in what Indian labs say they want. | Provider not wired. |
| Barcode label printing (§2.3) | Scanning works; printing does not. A lab still needs labels. | Phase 1 (ZPL to Zebra/TSC). |
| Patient / doctor portal (§2.3) | Report access without contacting the lab. | Phase 2. |
| **Quality/regulatory co-architect** (Part 13) | The report's own highest-value risk reduction. Blocks the pharma phase. | A hiring dependency, not code. |

**Deliberately deferred (4)** — stability studies and environmental monitoring (both
scheduled-generator patterns on top of what now exists), ELN, and AI/ML. The report's
§11.2 is explicit that buyers are not asking for AI; the extension path for the
pharma entities is in [DATA_MODEL.md](./docs/DATA_MODEL.md) §9.

**9 of 53 permissions are declared but not yet enforced** — tenant-level
configuration (branches, letterheads, TAT policy), post-enrolment instrument
administration, and a few workflow actions that are reachable another way. They
are listed explicitly in `UNIMPLEMENTED_PERMISSIONS` so the vocabulary is stable
when those modules land, and so nobody discovers the gap by clicking into it.
`npm run audit:trace` fails if that list disagrees with what the routes
actually enforce.

### The lab owner's walkthrough

`npm run walkthrough` is a different question from the suites above: not "does
the code work" but "can somebody who RUNS a diagnostic lab get through a normal
week". It attempts 35 real tasks end to end — take payment, onboard a
technician, add a test, raise a price, call a critical value through, amend a
released report — and reports what it could not do.

Current result: **33 tasks work · 2 gaps · 0 blockers.** The two gaps are
partial-name patient search (blocked by the blind-index design, ADR 0005 — phone,
code, exact name and a registration-date window all work) and WhatsApp delivery
(no provider wired).

---

## Layout

```
apps/
  api/          NestJS modular monolith — the whole backend        (ADR 0001)
  web/          Next.js 15, server components, httpOnly sessions
  gateway/      On-premises analyzer agent — ASTM/HL7/file          (ADR 0004)
packages/
  db/           Prisma schema + the RLS security layer              (ADR 0002)
  contracts/    Zod schemas shared by API, web and gateway
  crypto/       Envelope encryption, blind indexes, audit hashing   (ADR 0005)
docs/           Architecture, data model, compliance, security, roadmap, ADRs
scripts/        Env setup and the verification suites
```

---

## The five decisions that shape everything

Full reasoning in [`docs/adr/`](./docs/adr/).

| # | Decision | Why |
|---|---|---|
| [0001](./docs/adr/0001-modular-monolith.md) | Modular monolith, not microservices | A data change and its audit entry must commit in **one transaction**. Trivial in a monolith, genuinely hard across services. |
| [0002](./docs/adr/0002-postgres-rls-tenancy.md) | Tenant isolation via PostgreSQL RLS | Application-layer filtering fails eventually, because it depends on every developer remembering it forever. RLS makes it a database guarantee, and it **fails closed** — no tenant context returns zero rows, never a leak. |
| [0003](./docs/adr/0003-hash-chained-audit-trail.md) | Append-only, hash-chained audit trail | The app role has `INSERT`/`SELECT` only. Timestamps come from the database. Each entry hashes the previous one. |
| [0004](./docs/adr/0004-edge-normalised-instruments.md) | Normalise instrument data at the edge | Adding an analyzer becomes **configuration**, not API code — which is what stops the industry's biggest cost sink consuming the roadmap. |
| [0005](./docs/adr/0005-crypto-shredding-for-erasure.md) | Crypto-shredding for DPDP erasure | Reconciles the right to erasure with records-retention duty: destroy the patient's key, keep the clinical record and audit chain intact. |

---

## Compliance posture, stated honestly

[`docs/COMPLIANCE.md`](./docs/COMPLIANCE.md) documents what the software does
**and what it does not**. Software cannot make a lab compliant — accreditation
assesses people, procedures and competence too.

What is built:

- **NABL 112 / ISO 15189** — competency enforcement, QC gating, two-step release, coded rejection reasons, quality indicators
- **DPDP Act 2023** — per-purpose consent, field-level encryption, crypto-shredded erasure, India-only residency asserted at boot
- **21 CFR Part 11-style e-signatures** — re-authentication at signing, content-bound, meaning recorded

What is **not** yet done, and is tracked rather than glossed over:

- [ ] **A practising lab quality/regulatory specialist as co-architect.** The report calls this the highest-value risk reduction available, and it blocks the pharma phase. Building compliance software without domain authority is how you ship something that looks compliant and fails an audit.
- [ ] Independent penetration test before any production PHI
- [ ] Retention defaults confirmed against current NABL guidance
- [ ] DPDP notice and consent wording reviewed by counsel
- [ ] Report PDF rendering, barcode printing, WhatsApp delivery (Phase 1)

---

## Known limitations in this foundation

Stated plainly so nothing here is mistaken for production-ready:

| Limitation | Where it bites | Path |
|---|---|---|
| KMS provider unimplemented | `ENCRYPTION_PROVIDER=local` keeps the master key in an env var. Production refuses it unless `ENCRYPTION_LOCAL_ACK` is set deliberately, and the API warns on every boot. **Must** be built before real patient data. | `CryptoService` |
| Default `labsetu_app` DB password | Set in `packages/db/docker/init`. Fine locally, must be changed for a real deployment. | Deployment checklist |
| Instrument mapping runs inline, not queued | Fine at pilot volume; a slow map delays the gateway's ack | `IngestService.processMessage` is already a standalone entry point — moving it behind BullMQ is wiring, not a refactor |
| Device replay nonces held in memory | Replay protection resets on restart and does not span instances | Move to Redis |
| Audit log not yet partitioned | Only matters at scale | Monthly range partitioning, Phase 2 |
| One DB connection held per request | Bounds concurrency to pool size | Accepted deliberately — see ADR 0002 |
| Reports render as HTML, not PDF | No printable artifact yet; the on-screen report is complete and signed | Phase 1 |
| Not-found pages return HTTP 200 | Inside the authenticated shell Next streams the layout before `notFound()` runs, so the status is already committed. The **page renders correctly** and the **API returns a proper 404** — which is what integrations and monitors read. | Next.js streaming behaviour; cosmetic |
| Auth rate limit is 10/min per IP | Correct security posture, but running all verification suites back-to-back trips it | `npm run verify` paces itself |

---

## Roadmap

[`docs/ROADMAP.md`](./docs/ROADMAP.md) has the full plan, including the
**non-engineering track** that gates revenue just as hard: DPIIT recognition,
the BIRAC BIG grant (₹50 lakh non-dilutive, "Devices & Diagnostics" is an
explicit focus area), and recruiting a design-partner lab.

It also records **what would make us stop** — worth writing down while the
decision is still cheap.
