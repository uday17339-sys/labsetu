# LabSetu — Security Design

---

## 1. Threat model

Assets, in order of what an attacker actually wants:

1. **Patient health data** — regulated, saleable, and the thing whose loss ends the company.
2. **Result integrity** — a silently altered result is worse than a stolen one: it can cause
   clinical harm and it destroys the product's only real value proposition.
3. **The audit trail** — the evidence layer. Compromising it compromises everything above.
4. **Credentials & tenant isolation** — the route to all three.

| Adversary | Capability | Primary controls |
|---|---|---|
| External attacker | Internet-facing surface only | TLS 1.2+, WAF, rate limiting, strict input validation, no PHI in URLs/logs, dependency scanning |
| Credential thief | Valid stolen password | MFA, refresh-token rotation with reuse detection, session binding, anomalous-login alerting |
| Malicious insider at customer lab | Valid privileged session | RLS, least-privilege RBAC, four-eyes on authorisation, immutable audit, competency enforcement |
| Malicious/compromised insider at *us* | Infrastructure access | Separation of duties, no standing prod access (break-glass with approval + audit), field-level encryption with KMS-held keys, WORM audit anchoring |
| Cross-tenant leakage via app bug | An ORM query missing a filter | **Postgres RLS** — the app is not trusted to filter correctly |
| Compromised lab gateway | Foothold inside a customer network | Device-scoped credentials, mTLS, ingest is append-only and cannot mutate existing results, per-device rate limits |

Row 5 is the one worth dwelling on: application-layer tenant filtering fails eventually,
because it depends on every developer remembering it on every query forever. RLS moves that
from a discipline problem to a database guarantee.

---

## 2. Authentication

- **Passwords:** Argon2id (memory 64 MiB, time 3, parallelism 4). Never logged, never in
  error messages. Minimum-length + breach-list check on set; no forced periodic rotation
  (rotation drives password reuse — current NIST guidance, and the right call).
- **MFA:** TOTP (RFC 6238), mandatory for any role that can verify, authorize or administer.
  Encrypted secrets; single-use recovery codes stored hashed.
- **Sessions:** short-lived JWT access token (15 min) + opaque refresh token (30 days,
  rotated on every use). Refresh tokens are stored **hashed**; presenting a
  previously-rotated token is treated as theft and revokes the whole family.
- **Token versioning:** `User.tokenVersion` increments on password change, role change, or
  admin revocation — invalidating outstanding access tokens without a blocklist.
- **Lockout:** progressive delay then temporary lock, counted per account *and* per IP.
  Both are audited.
- **Enterprise SSO:** OIDC/SAML federation is an interface in `auth` from the start, unwired
  in v1. Large customers will require it; making it a plug rather than a rewrite is nearly
  free now.

### Signing re-authentication

Authorising a result or releasing a report requires a **signing token**: obtained by
re-entering password + TOTP, valid 5 minutes, single-use, and cryptographically bound to the
specific entity and content hash being signed. It cannot be replayed against a different
record.

---

## 3. Authorization

Two independent layers, both required:

1. **RBAC** — `@RequirePermissions('result:authorize')` on the route. Permissions are
   explicit strings in a central registry; a route with no declared permission is denied by
   default rather than open by default.
2. **RLS** — tenant isolation in Postgres, independent of application logic.

Plus **contextual checks** in the domain services that RBAC cannot express:

- Competency: is this user authorised for *this test* right now? (`UserCompetency`)
- Four-eyes: is the authoriser different from the entering user?
- QC gate: has QC passed for this instrument+analyte?
- Lab scope: does the user belong to the branch owning this sample?

---

## 4. Transport & network

- TLS 1.2+ everywhere; HSTS with preload on web.
- Gateway → API uses **mTLS** with per-device client certificates, plus a device API key and
  an HMAC-SHA256 signature over the request body with a timestamp and nonce (replay
  protection). Belt and braces, because the gateway sits in a network we do not control.
- CORS: explicit origin allowlist, no wildcard.
- Security headers via Helmet; CSP on the web app with no `unsafe-inline` in production.
- Private subnets for DB/Redis; no public ingress to either.

---

## 5. Encryption

### At rest

| Layer | Mechanism |
|---|---|
| Disk | AWS RDS/EBS encryption (AES-256) with KMS-managed keys |
| Object storage | SSE-KMS; raw-data bucket additionally under Object Lock (WORM) |
| Backups | Encrypted, restore-tested quarterly — an untested backup is a hope, not a control |
| **Field level** | AES-256-GCM on patient identifiers, TOTP secrets, device secrets, gateway credentials |

### Field-level envelope encryption

```
KMS master key (never leaves KMS)
  └── Tenant DEK (per tenant, wrapped by master, cached in memory with TTL)
        └── Patient data key (per patient, wrapped by tenant DEK)
              └── AES-256-GCM ciphertext per field
```

Per-patient keys exist for one concrete reason: **crypto-shredding**. A DPDP erasure request
destroys one patient's key, rendering their identifiers unrecoverable, while leaving every
other record and the audit chain intact. Deleting rows could not achieve that without
breaking the chain.

Each ciphertext stores its key version, so rotation is a background re-wrap rather than a
downtime event.

### Blind indexes

Searching encrypted fields uses `HMAC-SHA256(normalise(value), tenant_index_key)` stored
alongside. Exact match works; the index reveals nothing without the key. Substring search on
encrypted PII is deliberately **not** supported — supporting it would require leaking
structure, and "search patient by partial name" is not worth that. Search by phone, patient
ID, or accession number instead.

---

## 6. Input handling

- Every request body, query and param is validated by a **Zod** schema from
  `@labsetu/contracts` — one schema shared by API and web, so they cannot drift.
- Prisma parameterises queries; raw SQL is confined to a reviewed set of files and always uses
  tagged-template parameters.
- Uploads: type sniffing by content, size caps, stored in S3 (never on the app filesystem),
  served through signed short-lived URLs, and never rendered inline from a user-controlled
  content type.
- Instrument payloads are treated as **untrusted input** — parsers are fuzz-tested and run
  with hard size/time limits. An analyzer is an old embedded device on a lab network; assume
  its output can be malformed or hostile.

---

## 7. Logging & observability

- **No PHI in logs, ever.** Patient identifiers are referenced by id only. A redaction layer
  in the logger strips known-sensitive keys as a second line of defence.
- Structured JSON logs with a request id propagated end to end.
- OpenTelemetry traces; metrics on auth failures, cross-tenant denials, ingest lag, QC
  failures, audit-chain verification.
- **Alerting on security signals:** repeated auth failures, refresh-token reuse, RLS denial
  spikes, audit-chain mismatch, unusual bulk export.
- Application logs are separate from the audit trail and have shorter retention. They serve
  different purposes and conflating them corrupts both.

---

## 8. Secrets

- Never in the repo. `.env` is gitignored; `.env.example` documents keys with placeholder
  values only.
- Production secrets in AWS Secrets Manager, injected at runtime, rotated on a schedule.
- Gateway device credentials are issued per device, revocable individually, and displayed
  exactly once at enrolment.
- CI has no production credentials; deploys use short-lived OIDC-federated roles.

---

## 9. Dependencies & supply chain

- `npm audit` + Dependabot in CI; builds fail on high/critical.
- SBOM generated per release and archived with the release record (it is also a validation
  artifact — see [COMPLIANCE.md](./COMPLIANCE.md) §8).
- Lockfile committed; CI installs with `npm ci` only.
- New runtime dependencies need a reviewer's explicit sign-off. In a regulated product every
  dependency is something you may have to justify to an assessor.

---

## 10. Pre-production checklist

Before the first real patient record enters the system:

- [ ] Independent penetration test completed and findings closed
- [ ] All default/seed credentials removed from the production path
- [ ] MFA enforced for every privileged role
- [ ] Backup **restore** verified end to end, not just backup success
- [ ] RLS verified by automated cross-tenant access tests in CI
- [ ] Audit chain verification job running and alerting
- [ ] Incident response runbook written, with named owners and contact paths
- [ ] DPDP breach-notification workflow rehearsed once
- [ ] Log redaction verified against a PHI-shaped payload
- [ ] Rate limits tuned against realistic load, not guessed
