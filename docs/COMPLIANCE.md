# LabSetu — Compliance Design

> **Scope note.** This document describes how the *software* is designed to support a lab's
> compliance obligations. Software cannot make a lab compliant — accreditation assesses
> people, procedures, competence and equipment as well as records. Nothing here is legal or
> regulatory advice, and none of it substitutes for review by a qualified regulatory
> professional. Engaging one as a co-architect is the single highest-value risk reduction
> available and is treated as a hiring dependency, not an optional extra.

---

## 1. Which frameworks apply, and when

| Framework | Applies to | Phase | What it demands of us |
|---|---|---|---|
| **CDSCO revised Schedule M** | Pharma manufacturing QC | **v1 — shipped vertical** | Computerised system validation, PQS, QRM, Product Quality Review, raw-material control, batch release |
| **US FDA 21 CFR Part 11 / EU Annex 11** | Indian pharma *exporters* | **v1 — shipped** | Audit trails, e-signatures, system validation. Relevant because export customers audit against it |
| **DPDP Act, 2023** | Any organisation handling personal data | **v1 — mandatory** | Consent, purpose limitation, retention limits, breach notification, data-principal rights, security safeguards. Applies to staff records even where no patient data exists |
| **NABL 112 / ISO 15189** | Medical (diagnostic) labs | Built, not the shipped vertical | Sample identification & traceability, competency of personnel, QC, TAT monitoring, result verification/authorisation, amended-report handling, records retention |
| **NABL 113 / ISO 17025** | Testing & calibration labs | Adjacent | Same spine, method validation and measurement-uncertainty emphasis |

**v1 ships as pharmaceutical manufacturing QC**, so Part 11 / Annex 11 and revised Schedule M
are the governing frameworks: the audit trail, electronic signature, four-eyes authorisation
and batch-release gate all exist to satisfy them.

The diagnostics controls in this document are not aspirational — they are built and tested,
and the platform was developed against ISO 15189 first. They remain in the codebase behind
`APP_VERTICAL`, which is why sections below still discuss patients and reports. On a pharma
deployment those surfaces are not provisioned: the tenant is created with manufacturing roles
only, and patient registration, billing and the clinical report register are absent from the
product a plant sees.

---

## 2. The differentiating claim, stated precisely

Report §11.1 documented staff at accredited labs describing backdating of QC logs before
inspections. Our claim is narrow and defensible:

> **In LabSetu, the time a record was created is assigned by the server, is part of a
> tamper-evident hash chain, and cannot be set, edited, or deleted by any user — including a
> tenant administrator.**

What that does *not* claim: that a lab cannot delay entering data, or run a sample twice and
report the better result. Those need QC gating (§6) and complete instrument capture (§5) to
address, and even then only reduce rather than eliminate the behaviour. Overclaiming here
would be the fastest way to lose credibility with a Quality Head who knows the domain better
than we do.

---

## 3. Audit trail design

### 3.1 Guarantees

| # | Guarantee | Mechanism |
|---|---|---|
| 1 | Cannot be edited or deleted | `GRANT INSERT, SELECT` only. No `UPDATE`/`DELETE` to `labsetu_app`. Enforced at the database, not in code. |
| 2 | Time is server-authoritative | `occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Column is not writable by the application layer; any client-supplied value is ignored. |
| 3 | Tampering is detectable | Per-tenant hash chain: `hash = SHA256(prev_hash ‖ canonical_json(entry))` |
| 4 | Gaps are detectable | Per-tenant monotonic `seq` with a unique constraint. A missing ordinal is visible. |
| 5 | Attributable | Actor id, display name, **role at time of action** (roles change; the record must not), IP, user agent, request id |
| 6 | Explained | `reason` mandatory for any change to released/authorised data |
| 7 | Complete | Interceptor over all mutations + explicit logging of reads of PHI, logins, failed logins, exports, and signatures |

### 3.2 Canonicalisation

The hash is computed over a **deterministic** serialisation: keys sorted, no insignificant
whitespace, timestamps as ISO-8601 UTC with fixed precision, `null` distinguished from
absent. Without this, an identical record could hash two ways and the chain would verify
inconsistently across environments. Implementation: `common/crypto/canonical-json.ts`.

### 3.3 Chain verification

A scheduled worker (`workers/audit-verify.worker.ts`) walks each tenant's chain nightly and
on demand, recomputing every hash. On mismatch it raises a **critical, non-suppressible**
alert. The verification result is itself recorded, so a lab can produce evidence to an
auditor that the chain was continuously verified — that evidence is worth more at an
inspection than the chain itself.

### 3.4 Threat model — what this does and does not stop

| Threat | Result |
|---|---|
| Lab user edits a past result | **Stopped.** Change creates a new audit entry; the original value is preserved in `before`. |
| Lab admin deletes an inconvenient entry | **Detected.** Chain breaks at that point; nightly verification alarms. |
| Lab admin backdates an entry | **Stopped.** Timestamp is not application-writable. |
| Tenant admin colludes with a rogue *our-side* DBA with superuser access | **Not stopped by the chain alone.** Mitigated by (a) anchoring: the daily chain head is written to WORM S3 with Object Lock and optionally emailed to the lab's own quality manager, so a rewritten chain no longer matches an externally-held anchor; (b) separation of duties on production DB access; (c) `pgaudit` on the superuser role. Stated honestly because an auditor *will* ask. |
| Someone never enters the data at all | **Not a records problem.** Addressed by direct instrument capture (§5) and TAT monitoring, not by the audit log. |

The anchoring mechanism in row 4 is what upgrades the chain from "tamper-evident to us" to
"tamper-evident to a third party," and is the reason `AUDIT_ANCHOR_ENABLED` exists in config.

---

## 4. Electronic signatures

Modelled on 21 CFR Part 11 subpart C, because Indian pharma exporters are audited against it
and diagnostics buyers benefit from the same rigour.

| Requirement | Implementation |
|---|---|
| Unique to one individual, never reused | Signature binds `userId`; users are never hard-deleted, only deactivated |
| Two distinct identification components | Password **and** TOTP, both re-entered at the point of signing |
| Re-authentication per signing session | Signing token is single-use, scoped to one entity, and expires in 5 minutes |
| Signature manifests meaning | `meaning` enum is mandatory and rendered on the report as "Authorized by …" |
| Signed content is fixed | `contentHash` over the exact payload; a later edit invalidates the linkage and is surfaced in the UI |
| Signature is linked to its record | FK to entity + `auditLogId`; both immutable |
| Non-repudiation | Signature rows are insert-only, hash-chained via the audit log |

Handwritten-signature equivalence and the formal certification letter a regulator may request
are **procedural** steps for the customer lab, not software features. We provide the template
in the validation pack (§8); the lab files it.

---

## 5. Data integrity — ALCOA+

| Principle | How the system delivers it |
|---|---|
| **A**ttributable | Every row carries created/updated by; audit records actor and role at the time |
| **L**egible | Structured storage; PDFs rendered from data, never scanned images |
| **C**ontemporaneous | Server timestamps; instrument results land within seconds of the run |
| **O**riginal | Raw instrument payload archived byte-for-byte in WORM S3 before parsing |
| **A**ccurate | Instrument capture removes transcription; delta checks, critical-value flags, range validation on manual entry |
| **C**omplete | Re-runs, rejections and amendments are retained, never overwritten |
| **C**onsistent | Single canonical time source (UTC in storage, IST in presentation), enforced state machines |
| **E**nduring | Retention policy (§7) with WORM storage |
| **A**vailable | Full history retrievable through the audit search API for the retention period |

Manual result entry remains supported — most Indian labs have at least one offline analyzer
— but it is visibly marked `source = MANUAL` on screen and in the audit trail. Making the
provenance of every value visible is itself a quality control.

---

## 6. QC gating

Per-tenant policy, default **on** for accredited labs:

1. Each analyzer + analyte pair has a QC schedule.
2. QC results are evaluated with Westgard multi-rules on entry.
3. If the most recent QC for that analyzer/analyte is **failed or overdue**, authorisation of
   patient results from that instrument is blocked.
4. Override is possible, requires a documented reason and a signature, and is audited as
   `QC_OVERRIDE` — a report of overrides is exactly what an assessor will sample.

---

## 7. DPDP Act readiness

| Obligation | Implementation |
|---|---|
| Lawful basis / consent | `ConsentRecord` per patient per purpose, with the notice version shown, in English and the patient's chosen language |
| Purpose limitation | Purposes enumerated in code (`DIAGNOSTIC_SERVICE`, `REPORT_DELIVERY`, `BILLING`, `STATUTORY_REPORTING`); delivery checks consent before sending |
| Notice in regional languages | i18n from day one — English, Hindi, Telugu, Tamil at launch |
| Data minimisation | Patient PII columns are an explicit, reviewed list; adding one requires a schema change and shows up in review |
| Security safeguards | [SECURITY.md](./SECURITY.md) |
| Retention limits | Per-tenant policy; a sweep worker crypto-shreds identifiers past retention while preserving de-identified clinical records and the audit chain |
| Right to access / correction | Data-principal request API producing a complete machine-readable export; corrections create new versions, never silent overwrites |
| Right to erasure | Crypto-shredding of the patient's data key. Audit and clinical records survive de-identified — the lab's own retention duty and the erasure right are reconciled, not traded off |
| Breach notification | Security events feed an incident log with the fields a Board notification requires |
| Data residency | ap-south-1 / ap-south-2 only; asserted at boot |

Retention defaults ship conservative and per-tenant configurable, because the governing
period differs by lab type and state, and the lab's own accreditation body is the authority
on it — not us.

---

## 8. Software validation (CSV) — the vendor's half

Regulated buyers ask for evidence that *our software* was built under control. We generate it
from the pipeline rather than writing it by hand at sale time:

| Artifact | How it is produced |
|---|---|
| Requirements traceability matrix | Requirements tagged in code and tests (`@covers REQ-AUD-001`); CI emits the matrix |
| Design specification | These docs, version-controlled, tagged per release |
| IQ — installation qualification | Scripted deploy + automated post-deploy verification with signed output |
| OQ — operational qualification | The automated test suite, run against the released build, results archived per release |
| PQ — performance qualification | Executed **with the customer** on their data during pilot; template provided |
| Release record | Signed build provenance: commit SHA, SBOM, test results, approver |
| Change control | Every change is a PR with a linked requirement and reviewer approval; the git history *is* the change-control record |

Doing this from the first commit costs little. Reconstructing it 18 months in, from a repo
that was never built for it, is where teams lose quarters. This is the report's §8.3 warning
answered structurally.

---

## 9. Open compliance items

Tracked honestly rather than assumed solved:

- [ ] Regulatory/QA specialist engaged as co-architect **(hiring dependency — blocks pharma phase)**
- [ ] Retention defaults confirmed against current NABL 112 guidance
- [ ] DPDP notice and consent wording reviewed by counsel
- [ ] Independent security assessment before first production PHI
- [ ] Anchoring recipient workflow agreed with pilot lab's quality manager
- [ ] Validation pack templates drafted and reviewed
