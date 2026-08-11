# LabSetu — Road to a complete GMP LIMS

> **Status of this document.** It is the working plan for closing the distance
> between what LabSetu does today and what a pharmaceutical manufacturing unit
> needs from a LIMS. It is kept current as work lands: every item carries a
> state, and the state is changed only when the work is built **and verified**,
> never when it is merely started.
>
> Last updated: see git history for this file.

---

## 1. Honest assessment of where we start

LabSetu today is a **correct QC core, pre-validation**. The controls that exist
are real and demonstrably fire — that is unusual and it is the hard half. What
is missing is breadth: the quality-system modules that surround the laboratory,
and the validation evidence that makes any of it usable in a regulated plant.

Scored as a compliance lead would score it: **68/100**.

| Area | Score | Why |
|---|---|---|
| Data integrity / ALCOA+ | 18/20 | Hash-chained append-only audit, server-assigned time, RLS failing closed, `UPDATE`/`DELETE` refused by database grant rather than by application code |
| Access control & segregation of duties | 16/20 | QC cannot release, QA cannot enter results, four-eyes on authorisation, competency enforced as a gate. Missing: password aging, reuse history, periodic access review |
| Core QC workflow | 15/20 | Receipt → quarantine → sampling → AR → result → verify → authorise → disposition → CoA, correctly gated. Auto-OOS blocks release; critical excursions cannot be dispositioned around |
| Functional GMP coverage | 12/25 | The laboratory is built. The quality system around it is not — see §3 |
| Computer System Validation | 0/15 | No URS, no risk assessment, no IQ/OQ/PQ, no traceability matrix. This is the first thing an inspector asks for |

**Both P0 defects that would have cost most in a demo are now closed** — the
certificate manifests its signature, and calibration is enforced rather than
recorded. The score above is the starting position, not the current one; it is
re-scored when P0 and P1 are complete.

---

## 2. What already exists

Not aspiration — these are built, wired to screens, and covered by the
verification suites (899 checks across 12 suites at the time of writing).

- **Tenancy & security** — Postgres RLS forced on every tenant table, app role
  `NOBYPASSRLS`, session tenant set inside the transaction, fails closed
- **Audit trail** — hash-chained, append-only by grant, server-assigned
  timestamps, chain verification endpoint
- **Electronic signatures** — re-authentication, bound to a content hash so a
  signature cannot survive an edit of what it signed
- **RBAC + competency** — permissions per role; competency enforced per method
  and level (perform / verify / authorise) with evidence and expiry
- **Materials & stores** — material master, goods receipt, GRN numbering,
  quarantine on arrival, issue to production, stock movements, expiry/retest
- **Specifications** — versioned, approved, with per-analyte limits and critical
  flags; a batch cannot be sampled against an unapproved spec
- **Sampling** — sampling requests, AR numbering, stores/QC segregation
- **Testing** — result entry, verification, authorisation, re-run, amendment
- **OOS** — opens automatically on an out-of-specification result, Phase I/II,
  blocks batch release until closed
- **QA disposition** — approve / reject / approve-with-deviation under signature
- **Certificate of Analysis** — issued only for released batches, versioned,
  content-hashed, with a register
- **Quality control** — Westgard multi-rules, QC lots and targets, a failing
  control blocks authorisation on that analyzer until documented resolution
- **Instruments** — device enrolment, HMAC-signed ingest, ASTM/HL7/CSV
  normalisation at the edge, unmatched results held rather than guessed
- **Consumables** — reagent/standard inventory, lots, FEFO allocation, expired
  lot gate, automatic consumption per run traced to the test
- **Compliance tooling** — audit export, CSV exports (permissioned, audited,
  formula-injection safe), quality indicators

---

## 3. The gap to a complete system

Ordered by what a plant and an inspector actually need, not by what is easy.

### P0 — Defects in what we already claim (do first)

| # | Item | Why it matters | State |
|---|---|---|---|
| 0.1 | **Signature manifestation on the CoA** | 21 CFR §11.50 requires the printed name of the signer, the date and time of signing, and the meaning to appear on the signed record | ✅ **Done** — certificate now shows signer, qualification, registration number, signing time and meaning; a release without a signature says so explicitly rather than leaving a blank. Five assertions in `pharma-verify` |
| 0.2 | **Enforce instrument calibration** | Data produced on uncalibrated equipment is not defensible | ✅ **Done** — authorisation refused for a result produced on an instrument past its calibration date; `POST /ingest/devices/:id/calibration` records a calibration against a mandatory certificate reference and is audited as `CALIBRATION_RECORDED`; due date and days-remaining exposed on the instrument list. Nine assertions in `qc-verify`, including that the gate reopens on evidence rather than on a switch |
| 0.3 | **Password aging, reuse history, access review** | §11.300 expects periodic password change, reuse prevention, and periodic review of who holds what | ☐ To do |

### P1 — The quality system the laboratory hangs off

Without these, an inspector cannot follow the thread from a problem to its
resolution, which is the thread they always pull.

| # | Item | Why it matters | State |
|---|---|---|---|
| 1.1 | **Deviation management** | Today a deviation is a free-text reference on a disposition. It needs to be a record: raised, classified, investigated, impact-assessed, closed, and linked to the batches it touched | ☐ To do |
| 1.2 | **CAPA** | Corrective and preventive actions, owners, due dates, effectiveness checks, and links back to the deviation or OOS that caused them. OOS currently closes into a text field and stops | ☐ To do |
| 1.3 | **Change control** | Any change to a specification, method, instrument or system needs a request, impact assessment, approval and implementation record. Schedule M and Annex 11 both require it | ☐ To do |

### P2 — Manufacturing QC breadth

| # | Item | Why it matters | State |
|---|---|---|---|
| 2.1 | **Stability studies** | Protocols, storage conditions, timepoints, pull scheduling, and trending across pulls. A formulations plant lives on this | ☐ To do |
| 2.2 | **Environmental monitoring** | Sampling locations, grades, alert/action limits, trending, excursion handling for cleanrooms and water systems | ☐ To do |
| 2.3 | **Product Quality Review (PQR/APR)** | Annual review per product: batches made, rejected, deviations, OOS, changes, trends. Explicitly required by Schedule M | ☐ To do |

### P3 — Completeness and evidence

| # | Item | Why it matters | State |
|---|---|---|---|
| 3.1 | **Audit-trail review workflow** | The trail is viewable; regulators expect *periodic review* with a record that it was reviewed and by whom | ☐ To do |
| 3.2 | **Retention samples** | Register, storage location, quantity, retention period, disposal record | ☐ To do |
| 3.3 | **Vendor qualification** | Approved vendor list, qualification status and expiry, and a gate on receiving from an unapproved source | ☐ To do |
| 3.4 | **Method validation records** | Validation status per method, parameters, and revalidation triggers | ☐ To do |
| 3.5 | **CSV validation package** | URS, functional risk assessment, IQ/OQ/PQ protocols, requirements traceability matrix, validation summary. The 899 automated checks are strong OQ evidence but are **not** a validation package | ☐ To do |

### Deferred with reasons

- **eBMR / batch manufacturing records** — this is an MES boundary, not a LIMS
  one. Integration point, not a module.
- **LIMS-wide workflow designer** — LabWare's configurability is its moat and
  thirty years of work. Configuration over code is the right long-term answer;
  it is not the right next thing.
- **Regional languages, WhatsApp delivery** — real differentiators from the
  market report, but they serve the diagnostics vertical.

---

## 4. Honest note on "LabWare parity"

LabWare is a thirty-year-old product with hundreds of person-years in it. Full
parity is not a sprint and claiming otherwise would be the kind of statement
this document exists to avoid.

What is achievable, and what this plan targets, is **functional sufficiency for
a mid-size Indian formulations plant**: every record an inspector asks for
exists, is linked to the records around it, and cannot be altered after the
fact. That is the product being sold. Configurability, multi-site rollups and
the long tail of instrument drivers come after a first plant is live.

---

## 5. Working method

- One item at a time, each landing as its own commit on `gmp-completeness`
- Every item ships with verification — a suite check that asserts the control
  **fires**, not that the happy path returns 200
- This document is updated in the same commit as the work it describes
- `npm run verify https://localhost` stays green throughout; a red suite blocks
  the next item
