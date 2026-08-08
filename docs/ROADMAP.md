# LabSetu — Roadmap

Sequenced against the report's recommendations: one beachhead vertical, a short instrument
list, services-inclusive delivery, and pilots as the trust asset.

---

## Phase 0 — Foundation ✅ *(this scaffold)*

Everything that is expensive to retrofit and cheap to build first.

- [x] Monorepo, Docker infrastructure, environment contract
- [x] Architecture, data model, compliance, security documentation
- [x] Postgres schema with RLS tenancy
- [x] Hash-chained, append-only audit trail
- [x] AuthN/AuthZ: Argon2id, JWT rotation, TOTP, RBAC
- [x] E-signature with re-authentication
- [x] Field-level PII encryption with crypto-shredding support
- [x] Canonical instrument envelope + ASTM/HL7 parsers + gateway skeleton
- [x] Core diagnostics workflow: accession → test → result → verify → authorize → report
- [x] Seed data for a realistic demo

## Phase 1 — Pilot-ready (≈ 8–10 weeks)

Goal: **one real lab running real samples**, with a signed pilot agreement.

- [ ] Report PDF rendering: NABL-format layout, lab letterhead, QR verification, digital signature
- [ ] Barcode: label printing (Zebra/TSC ZPL) and scanner input on every screen
- [ ] Full QC module: Levey-Jennings charts, Westgard evaluation, QC gating in the UI
- [ ] Delivery: WhatsApp Business API, email, SMS + delivery receipts and consent checks
- [ ] GST invoicing: CGST/SGST/IGST, HSN/SAC, e-invoice-ready schema, payment tracking
- [ ] i18n: English, Hindi, Telugu at the UI and patient-report level
- [ ] Two real analyzers integrated at the pilot lab (shadow mode → live)
- [ ] TAT dashboard and NABL quality indicators (rejection rate, TAT breach, amendment rate)
- [ ] Data migration toolkit: import from Excel/CSV, the near-universal incumbent
- [ ] Backup + restore rehearsed and documented

**Exit criterion:** the pilot lab runs a full day on LabSetu without falling back to paper.

## Phase 2 — Second lab & hardening (≈ 6–8 weeks)

Goal: prove it is a **product**, not a bespoke build for one customer.

- [ ] Onboarding self-service: tenant provisioning, catalog import, user setup
- [ ] Multi-branch: inter-branch sample referral, consolidated reporting
- [ ] Outsourced/referral test handling (labs subcontract; this is universal and usually missing)
- [ ] Doctor/client portal (report access for referring physicians)
- [ ] Patient portal + report download with OTP
- [ ] Independent penetration test; findings closed
- [ ] Validation pack v1: IQ/OQ templates, traceability matrix, release records
- [ ] Analyzers 3–6 integrated
- [ ] Performance: 10k samples/day per tenant, verified by load test

**Exit criterion:** a second lab onboarded in under two weeks, mostly by an implementation
engineer rather than an engineer who wrote the product.

## Phase 3 — Commercial scale (≈ 3–4 months)

- [ ] Terraform + CI/CD to ap-south-1 with ap-south-2 DR
- [ ] Self-hosted edition packaging (the enterprise/government objection-handler)
- [ ] HIS/EMR integration: HL7 v2 outbound, FHIR R4 read API, ABDM/ABHA linkage
- [ ] Home-collection / phlebotomist mobile PWA with offline capture
- [ ] Analytics: revenue, test mix, doctor referral performance, analyzer utilisation
- [ ] Enterprise SSO (OIDC/SAML)
- [ ] SOC-2-style control documentation for enterprise procurement
- [ ] Reference customer case studies (the actual moat — report §8.9)

## Phase 4 — Pharma QC vertical (evaluate at ~15–20 diagnostics customers)

Only after diagnostics is self-sustaining. The report is explicit that this is the larger
prize and the harder, slower sale.

- [ ] Batch/lot genealogy; `Sample.subject` becomes polymorphic
- [ ] Specifications & spec limits (generalising reference ranges)
- [ ] OOS/OOT investigation workflow
- [ ] Stability study management with scheduled timepoint generation
- [ ] Environmental monitoring plans
- [ ] COA generation
- [ ] Chromatography data system integration (Empower/OpenLab/Chromeleon)
- [ ] Full CSV pack for revised Schedule M and 21 CFR Part 11 audits
- [ ] Regulatory/QA specialist on the team — **blocking dependency, not a nice-to-have**

---

## Parallel non-engineering track

These gate revenue as hard as any feature, and the report is emphatic that engineering-only
sequencing fails in this category:

| When | Action |
|---|---|
| Now | DPIIT/Startup India recognition (free, ~7–14 days) |
| Now | Recruit a practising lab quality manager as advisor or co-founder — **report Recommendation 2, the highest-value risk reduction available** |
| Now | AWS Activate credits ($10k–$100k) |
| Phase 1 | BIRAC BIG grant application — ₹50 lakh non-dilutive, "Devices & Diagnostics" is an explicit focus area |
| Phase 1 | Design-partner agreement with the pilot lab (written scope, not a handshake) |
| Phase 2 | NABL assessor engaged for an informal readiness review |
| Phase 2 | Legal review of DPDP notices, consent wording, and the customer DPA |
| Phase 3 | Case studies and reference calls set up |

---

## What would make us stop

Worth writing down while the decision is still cheap:

- **No pilot lab signed within 3 months of Phase 1 starting.** The report warns of 6–18 month
  sales cycles; no design partner at all is a different and worse signal.
- **Pilot lab reverts to paper after go-live.** That is a product-fit failure, not a training
  failure, and no amount of features fixes it.
- **No quality/regulatory advisor recruited by end of Phase 1.** Building compliance software
  without domain authority is how you ship something that looks compliant and fails an audit
  — the report's §8.1 warning, and the worst possible outcome for a trust-based product.
