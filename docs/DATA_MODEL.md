# LabSetu — Data Model

Canonical source is [`packages/db/prisma/schema.prisma`](../packages/db/prisma/schema.prisma).
This document explains *why* the model is shaped this way and how the lifecycles work.

---

## 1. Layering

```
┌─ Platform ──────────────────────────────────────────────────┐
│  Tenant · Lab · User · Role · Permission · Session           │
│  AuditLog · Signature · Attachment · ConsentRecord           │
├─ Catalog (reference data, versioned) ───────────────────────┤
│  Analyte · TestDefinition · Panel · Method · Instrument      │
│  ReferenceRange · CriticalRange · TestDefinitionVersion      │
├─ Operations (the daily workflow) ───────────────────────────┤
│  Patient · Order · Sample · SampleTest · Result              │
│  QcLot · QcResult · Report · Invoice · Delivery              │
├─ Integration ───────────────────────────────────────────────┤
│  Device · DeviceChannel · InstrumentMessage · IngestMapping  │
└─────────────────────────────────────────────────────────────┘
```

Catalog is **versioned and mostly immutable**; operations reference a specific catalog
*version*. A result reported in March must still render with the reference range that was in
force in March, even after the range is revised in June. Mutating catalog rows in place
would silently rewrite history — so we don't.

---

## 2. Tenancy and sites

- `Tenant` — the paying customer (a lab company).
- `Lab` — a physical site/branch under a tenant. Multi-location diagnostic chains are a
  named target segment, so this exists from day one rather than being retrofitted.
- Every operational row carries **both** `tenantId` (RLS boundary) and `labId` (operational
  scoping, reporting, and per-site accession numbering).

`tenantId` is the security boundary. `labId` is a business dimension. Conflating them —
which is tempting — breaks the moment one customer opens a second branch.

---

## 3. Identity, roles, competency

`User` → `UserRole` → `Role` → `RolePermission` → permission strings (`result:verify`).

Roles shipped by default: `LAB_ADMIN`, `PATHOLOGIST`, `LAB_TECHNICIAN`, `PHLEBOTOMIST`,
`RECEPTIONIST`, `ACCOUNTANT`, `AUDITOR` (read + audit access, no write).

**`UserCompetency`** deserves explicit mention. ISO 15189 and NABL both require that only
personnel authorised for a given test perform or verify it. The table records
`userId × testDefinitionId × validFrom × validUntil × grantedBy`. The result-verification
service checks it and refuses expired competency.

This is a genuine differentiator worth building early: it is a compliance requirement Indian
mid-market tools generally skip, and it is cheap to implement now versus painful to bolt on
after results exist.

---

## 4. Patient and PII

`Patient` holds encrypted columns for name, phone, email, address, and government/ABHA
identifiers (see [SECURITY.md](./SECURITY.md) §5). Alongside each encrypted column sits a
**blind index** — a keyed HMAC of the normalised value — so exact-match lookup ("find patient
by phone") works without decrypting the table.

Non-identifying fields (`sex`, `dateOfBirth`, `yearOfBirth`) stay in plaintext because
reference-range selection depends on them at query time.

`ConsentRecord` captures DPDP consent: purpose, granted/withdrawn timestamps, notice version
shown. Report delivery to WhatsApp checks it.

**Erasure** under DPDP is implemented as **pseudonymisation, not deletion**: identifiers are
crypto-shredded (the patient's data key is destroyed), while the clinical record and its
audit trail survive. Deleting the record outright would break the audit chain and violate the
lab's own retention obligations — the two requirements are reconciled here, not chosen
between.

---

## 5. The operational spine

```
Order (requisition)
  └── OrderItem            what was ordered (test or panel), priced
        └── Sample         physical specimen, one accession number
              └── SampleTest   one test on one sample  ← the unit of work
                    └── Result     one analyte value    ← the unit of data
```

`SampleTest` is the workhorse. Worklists, turnaround time, competency checks, QC
association, verification and billing all hang off it. A panel ordered as one line explodes
into several `SampleTest` rows so each analyte can be tracked, re-run, or rejected
independently — which is how labs actually work.

### Accession numbers

Per-lab, per-day, gapless, generated inside the transaction via a Postgres sequence-backed
counter row with `SELECT … FOR UPDATE`. Format: `{labCode}{YYMMDD}{seq:05d}` →
`HYD26073100042`. Gapless matters: auditors read gaps as deleted samples.

---

## 6. State machines

Transitions are enforced in the service layer against an explicit transition table. An
invalid transition throws; it does not silently no-op.

### Sample

```
REGISTERED ──▶ COLLECTED ──▶ IN_TRANSIT ──▶ RECEIVED ──▶ IN_PROGRESS ──▶ COMPLETED
     │              │                            │             │
     └──────────────┴────────────────────────────┴─────────────┴──▶ REJECTED
                                                                     (reason required)
```

`REJECTED` requires a coded reason (haemolysed, insufficient volume, wrong container,
unlabelled, clotted…). Rejection statistics are an NABL quality indicator, so the reason is
a foreign key to a controlled list, not free text.

### SampleTest

```
PENDING ──▶ IN_PROGRESS ──▶ RESULT_ENTERED ──▶ TECH_VERIFIED ──▶ AUTHORIZED ──▶ REPORTED
                 │                │                  │
                 └────────────────┴──────────────────┴──▶ RERUN ──▶ IN_PROGRESS
                                                     └──▶ CANCELLED (reason required)
```

Two-step release — technical verification then medical authorisation — is deliberate.
ISO 15189 expects clinical authorisation by a competent person, and the two steps are
usually different people. **Four-eyes is enforced by default**: the authoriser cannot be the
entering user unless the tenant explicitly enables single-user mode for small labs (a
tenant policy flag, itself an audited setting).

`AUTHORIZED` requires an **electronic signature** (§7).

### Report

```
DRAFT ──▶ AUTHORIZED ──▶ RELEASED ──▶ DELIVERED
                             │
                             └──▶ AMENDED (new version, previous retained forever)
```

Reports are **versioned, never overwritten**. An amended report gets `version = n+1`, a
mandatory amendment reason, and both versions remain retrievable. A released report's PDF is
stored in S3 under Object Lock — the artifact the patient received is preserved exactly.

---

## 7. Signatures

`Signature` rows are immutable and carry:

| Field | Purpose |
|---|---|
| `meaning` | `REVIEWED` / `APPROVED` / `AUTHORIZED` / `REJECTED` / `AMENDED` — the signature manifests *what was meant*, not just that a button was clicked |
| `entityType` + `entityId` | what was signed |
| `contentHash` | SHA-256 of the exact signed payload — proves *what* was signed, so later edits are detectable |
| `method` | `PASSWORD_TOTP` (re-authentication at point of signing) |
| `signedAt` | server clock only |
| `auditLogId` | link into the chain |

Signing always requires **re-authentication**, even with an active session. A signature that
any open browser tab can produce is not a signature.

---

## 8. Quality control

`QcMaterial` → `QcLot` (with target mean/SD per analyte) → `QcResult`.

QC results are evaluated against **Westgard multi-rules** (1-3s, 2-2s, R-4s, 4-1s, 10-x) by a
worker on insert. A rule violation can **block patient result authorisation** on the same
instrument+analyte until it is resolved with a documented action — configurable per tenant,
because that policy differs by lab maturity.

This connects directly to report §11.1: if QC has to pass *before* patient results release,
and QC entries are timestamped by the server, the "run QC after the fact" pattern stops being
possible.

---

## 9. Manufacturing QC — stores, specifications, QA release

**Built.** The spine was chosen to generalise, and it did: a batch replaces a patient as the
subject of an order, and everything downstream — accessioning, result entry, competency
enforcement, the analyser QC gate, e-signatures, the audit chain — applies unchanged.

| Entity | Relationship to the existing model |
|---|---|
| `Material` | The master: API, raw material, packaging, intermediate, bulk, finished product |
| `GoodsReceipt` | One consignment, one or more batches |
| `MaterialBatch` | Subject of a `LabOrder` in place of `Patient` |
| `Specification` / `SpecLimit` | Generalisation of `ReferenceRange`, versioned identically, but **approved by QA** before it governs anything |
| `SamplingRequest` | The stores → QC handover, modelled explicitly because an inspector asks who requested it and when |
| `BatchDisposition` | QA's signed release or rejection. Append-only at the grant level |
| `OosInvestigation` | Opened **automatically** when a result breaches a `SpecLimit` |
| `CertificateOfAnalysis` | What leaves the site with the material |

### The polymorphic subject

`LabOrder.patientId` and `LabOrder.batchId` are both nullable, with a database CHECK:

```sql
CHECK (("patientId" IS NOT NULL) <> ("batchId" IS NOT NULL))
```

Exactly one, never both, never neither. Prisma cannot express this, and leaving it to
application code means the first bug writes a row no screen can render and no report can
resolve.

`ReportsService.generate` refuses a batch order outright: a patient report and a certificate
of analysis are different documents with different regulators behind them.

### The controls that make QA a role and not a job title

1. **Everything received is quarantined.** Status is not a parameter on goods receipt.
2. **Material may only be issued from an APPROVED batch**, and approval does not survive
   expiry or a passed retest date.
3. **A batch with no approved specification cannot be sampled at all** — testing against
   nothing looks exactly like testing.
4. **The author of a specification cannot approve it.**
5. **An out-of-spec result opens an investigation with nobody choosing to**, and an open
   investigation blocks disposition.
6. **A critical excursion cannot be dispositioned around.** A non-critical one can, but only
   as `APPROVED_WITH_DEVIATION` with the deviation named.
7. **Disposition requires an e-signature** bound to the results as they stood at review.
8. **QC cannot release; QA cannot enter a result.** Enforced by the role permission sets, not
   by convention.

Verified by `scripts/pharma-verify.mjs` — 50 checks, each asserting a refusal.

### Still deferred

| Entity | Why |
|---|---|
| `StabilityStudy` / `Protocol` / `TimePoint` | Scheduled generator producing `Sample` rows. Same pattern, not yet built |
| `EnvironmentalMonitoringPlan` | Same generator, location-based |

---

## 10. Audit log storage

```sql
audit_log (
  id, tenant_id, seq, occurred_at, actor_user_id, actor_display, actor_role,
  actor_ip, actor_user_agent, request_id, entity_type, entity_id, action,
  reason, before, after, changed_fields, prev_hash, hash
) PARTITION BY RANGE (occurred_at);
```

- Monthly partitions, created ahead by a scheduled job.
- `(tenant_id, seq)` unique — the per-tenant chain ordinal.
- Indexed on `(tenant_id, entity_type, entity_id, occurred_at DESC)` for "show me everything
  that happened to sample X", the query an auditor always asks for.
- Old partitions move to cheaper storage; they are never dropped inside the retention window
  (see [COMPLIANCE.md](./COMPLIANCE.md) §7).
