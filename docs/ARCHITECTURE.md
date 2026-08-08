# LabSetu — System Architecture

**Status:** Foundation (v0.1)
**Beachhead vertical:** Diagnostics / pathology labs
**Phase-two vertical:** Mid-size pharma QC (revised Schedule M)

---

## 1. What we are actually building

Per the market report, the product being sold is not "lab software with more features."
It is **"trust our results without re-checking them."** Every architectural decision below
serves one of three properties:

| Property | Why it exists | Where it lives |
|---|---|---|
| **The record cannot be gamed** | Report §11.1 — staff at accredited labs described backdating QC logs. Our differentiator is that backdating is *physically impossible*, not discouraged. | Server-authoritative timestamps + hash-chained append-only audit log (§6) |
| **The lab's data is isolated and resident in India** | DPDP Act, and incumbents are only "DPDP-achievable", not DPDP-native | Postgres RLS tenancy (§4) + ap-south-1/2 pinning (§9) |
| **Results arrive from instruments, not keyboards** | The #1 industry cost sink; solve once as middleware, not per customer | Instrument Gateway + canonical envelope (§7) |

Everything else is table stakes.

---

## 2. Topology

```
                        ┌─────────────────────────────────────────────┐
   LAB PREMISES         │              AWS ap-south-1 / ap-south-2    │
 ┌──────────────────┐   │                                             │
 │  Analyzers       │   │   ┌────────────┐        ┌────────────────┐  │
 │  ├ RS-232/ASTM   │   │   │  web       │        │  api           │  │
 │  ├ TCP/LIS2-A2   │   │   │  Next.js15 │──────▶ │  NestJS 11     │  │
 │  ├ HL7 v2 MLLP   │   │   │  (RSC/SSR) │  REST  │  modular       │  │
 │  └ File drop     │   │   └────────────┘        │  monolith      │  │
 │        │         │   │                         └───┬────┬───┬───┘  │
 │        ▼         │   │                             │    │   │      │
 │ ┌──────────────┐ │   │   ┌─────────────────────┐   │    │   │      │
 │ │  GATEWAY     │ │mTLS│  │ Postgres 16         │◀──┘    │   │      │
 │ │  (on-prem)   │─┼───┼──▶│ + Row Level Security│        │   │      │
 │ │  store &     │ │   │   │ + partitioned audit │        │   │      │
 │ │  forward     │ │   │   └─────────────────────┘        │   │      │
 │ └──────────────┘ │   │   ┌─────────────────────┐        │   │      │
 └──────────────────┘   │   │ Redis + BullMQ      │◀───────┘   │      │
                        │   │ (workers)           │            │      │
                        │   └─────────────────────┘            │      │
                        │   ┌─────────────────────┐            │      │
                        │   │ S3 (Object Lock/WORM)│◀──────────┘      │
                        │   │ raw · reports · docs │                  │
                        │   └─────────────────────┘                  │
                        └─────────────────────────────────────────────┘
```

---

## 3. Stack and the reasoning behind each choice

| Layer | Choice | Why this and not the obvious alternative |
|---|---|---|
| Language | TypeScript everywhere | One language across web/API/gateway. The report flags talent scarcity (§8.10) — a single-language stack widens your hiring pool and lets one engineer move between the analyzer parser and the result-entry screen. |
| API | **NestJS 11** | Not Express-with-structure. The compliance requirements are *cross-cutting concerns*: every write needs an audit entry, every query needs a tenant filter, every sensitive read needs PHI access logging. Nest's interceptor/guard model makes these impossible to forget, because they are wired once at the module level rather than remembered at each endpoint. That is the entire argument. |
| Frontend | **Next.js 15** (App Router, RSC) | You already run this on Campus Track. Server components keep PHI off the client where possible; server actions are avoided in favour of a typed REST client so the same API serves the mobile app and enterprise integrations later. |
| Database | **PostgreSQL 16** | RLS gives tenant isolation the application layer cannot bypass. Partitioning handles audit-log growth. `pgcrypto` for field-level PII encryption. Deterministic `C` collation so ordering in a validated report is reproducible. |
| ORM | **Prisma 6** | Familiar to you. Its weakness with RLS (connection-level session vars) is handled explicitly in §4 — this is a known, solved tradeoff, documented rather than discovered later. |
| Jobs | **BullMQ on Redis** | Instrument message mapping, report PDF rendering, WhatsApp/email delivery, QC rule evaluation, audit-chain verification, retention sweeps. All need retry + dead-letter, none should block a request. |
| Objects | **S3 (MinIO locally)** | Raw instrument output must be retained unaltered. S3 Object Lock in compliance mode gives you WORM retention that survives a compromised admin credential — which is exactly the property an auditor asks about. |
| Gateway | **Node service, on-prem** | Analyzers speak serial and raw TCP. Those are not internet protocols and never should be. The gateway is the airgap-friendly translation layer, and its store-and-forward outbox means a lab's internet outage never loses a result. |

---

## 4. Multi-tenancy — shared database, enforced isolation

**Model:** shared schema, `tenant_id` on every tenant-owned table, PostgreSQL Row Level
Security as the enforcement boundary.

The application connects as `labsetu_app`, a role with **no** `BYPASSRLS` privilege. Every
tenant-scoped table carries:

```sql
ALTER TABLE "patient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

If `app.tenant_id` is unset, `current_setting(..., true)` returns NULL, the predicate is
NULL, and **zero rows** are visible. The failure mode is an empty result set, never a
cross-tenant leak. That directionality is the whole point.

### How the session variable gets set

Prisma pools connections, so `SET app.tenant_id` outside a transaction would leak across
requests. We therefore run **each request inside one interactive transaction**:

```ts
prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
  //                                                       ^^^^ true = LOCAL to this tx
  return runHandler(tx);
});
```

Implemented in `TenantContextInterceptor` + `PrismaTenantService`, with the transaction
client carried through `AsyncLocalStorage` so domain services never pass `tx` by hand.

**The tradeoff, stated plainly:** a request holds a DB connection for its whole lifetime.
This bounds concurrency to the pool size and makes slow endpoints expensive. We accept it
because it buys two things worth more at this stage: airtight tenant isolation, and
*atomicity between a data change and its audit entry* — they commit together or not at all.
An audit trail that can silently miss an entry is not an audit trail.

Revisit when p99 latency or pool saturation demands it; the escape hatch is a Prisma client
extension that scopes `set_config` per-operation, trading audit atomicity back.

---

## 5. Module structure — modular monolith, service-ready

One deployable, hard internal seams. Domain modules never import each other's Prisma
models; they talk through exported services and domain events.

```
apps/api/src/
├── main.ts                     bootstrap, helmet, CORS allowlist, versioned routes
├── common/
│   ├── prisma/                 tenant-scoped client, RLS session wiring
│   ├── tenancy/                AsyncLocalStorage request context
│   ├── audit/                  hash-chained append-only writer + interceptor
│   ├── crypto/                 AES-256-GCM field encryption, hashing, HMAC
│   ├── rbac/                   permission registry, guards, decorators
│   └── errors/                 problem+json exception filter
├── modules/
│   ├── auth/                   login, refresh rotation, TOTP, e-signature re-auth
│   ├── tenants/                tenant + lab/branch provisioning
│   ├── users/                  users, roles, competency/certification records
│   ├── patients/               demographics, encrypted PII, consent (DPDP)
│   ├── catalog/                tests, analytes, panels, methods, reference ranges
│   ├── orders/                 requisitions, referring doctors/organisations
│   ├── samples/                accessioning, barcodes, chain of custody, rejection
│   ├── results/                entry, delta/critical checks, verify → authorize
│   ├── qc/                     QC lots, Westgard rules, Levey-Jennings data
│   ├── reports/                composition, versioning, amendment, release
│   ├── instruments/            device registry, gateway enrolment, channel mapping
│   ├── ingest/                 raw message intake, mapping worker
│   ├── billing/                GST-compliant invoicing (CGST/SGST/IGST, HSN/SAC)
│   ├── notifications/          WhatsApp / email / SMS delivery + receipts
│   └── compliance/             audit search, chain verification, DPDP subject requests
└── workers/                    BullMQ processors
```

**Extraction path (when, not if):** `ingest` and `reports` are the first two to leave —
they are CPU-spiky and independently scalable. Both already communicate only via queue
messages and the shared DB, so extraction is a deployment change, not a rewrite.

---

## 6. The audit trail — the product's spine

This is the single most important subsystem. Design goals, in priority order:

1. **Append-only.** The application role holds `INSERT` and `SELECT` on `audit_log`. No
   `UPDATE`, no `DELETE`, enforced by grant, not by convention.
2. **Server-authoritative time.** `occurred_at` defaults to the database's `now()`.
   Client-supplied timestamps are rejected outright. This is what makes backdating
   impossible rather than merely discouraged.
3. **Tamper-evident.** Each entry stores `prev_hash` and a `hash` over its own canonical
   content plus `prev_hash`, forming a per-tenant chain. Altering or removing any historical
   entry breaks every subsequent link. A scheduled worker walks the chain and alarms on
   breakage.
4. **Complete.** Written by an interceptor over every mutating route plus explicit calls for
   sensitive reads (PHI access), authentication events, and signatures.
5. **Attributable.** Actor identity, role at time of action, IP, user agent, request ID.
6. **Explained.** Any change to data that has already been *released* requires a
   `reason` — the "reason for change" expectation regulators have.

Detail and threat model in [COMPLIANCE.md](./COMPLIANCE.md).

---

## 7. Instrument connectivity

Full protocol detail in [INSTRUMENT_INTEGRATION.md](./INSTRUMENT_INTEGRATION.md). The
architectural commitment is:

> Every analyzer, regardless of protocol, is normalised into **one canonical
> `InstrumentObservation` envelope** at the edge. The cloud never learns that ASTM exists.

Adding an analyzer is a gateway **configuration** change plus a channel mapping row — not a
change to the API. That converts the report's "permanent tax on engineering time" (§8.2)
into a bounded, delegable task.

Raw payloads are archived byte-for-byte in S3 before parsing. If a parser has a bug, the
original data is still there to re-process — and an auditor can be shown exactly what the
instrument emitted.

---

## 8. Request lifecycle

```
Request
  └─▶ Helmet / CORS / rate limit
      └─▶ RequestContext (request-id, IP, UA → AsyncLocalStorage)
          └─▶ JwtAuthGuard          identity, token version, session validity
              └─▶ TenantGuard        tenant claim ↔ route ↔ user membership
                  └─▶ PermissionGuard  @RequirePermissions('result:verify')
                      └─▶ TenantTransactionInterceptor
                          │   BEGIN; set_config('app.tenant_id', …, true)
                          └─▶ Handler (domain service)
                          │   AuditInterceptor captures before/after
                          │   audit_log INSERT (same tx, hash-chained)
                          └─▶ COMMIT
```

Data change and audit entry share a transaction. There is no window in which one exists
without the other.

---

## 9. Data residency & deployment

- **Primary:** AWS `ap-south-1` (Mumbai). **DR:** `ap-south-2` (Hyderabad).
- No cross-region replication outside India. No third-party sub-processor that egresses
  PHI abroad — this is a procurement checklist item, not just a config setting.
- `DATA_RESIDENCY_REGION` is a first-class config value asserted at boot; the API refuses to
  start if storage endpoints resolve outside the configured region set.
- **Deployment path:** docker-compose (dev) → ECS Fargate or a single right-sized EC2 with
  Compose (first customers, ₹40k–₹1.5L/mo per report §12.3) → EKS when multi-AZ HA is
  contractually required. Terraform from day one so the step from one to the next is a
  plan/apply, not a migration project.
- **Self-hosted edition** is a first-class target, not an afterthought: the same Compose
  bundle plus MinIO runs entirely inside a customer's data centre. Some regulated buyers
  will not accept anything else, and the report notes incumbents all offer this.

---

## 10. What is deliberately not in v1

Scope discipline is the cheapest cost lever (report §12.6). Explicitly deferred:

| Deferred | Until |
|---|---|
| ELN (experiment notebooks) | Pharma phase; different buyer, different product |
| Stability studies, batch genealogy, OOS workflows | Pharma phase two — schema extension path documented in [DATA_MODEL.md](./DATA_MODEL.md) §9 |
| AI/ML features | Buyers are not asking (report §11.2). Revisit after 20 paying labs. |
| Kubernetes | Until HA is contractual |
| Microservices | Until a module's scaling profile actually diverges |
| Mobile native app | Responsive web first; PWA before native |

---

## 11. Related documents

- [DATA_MODEL.md](./DATA_MODEL.md) — entities, lifecycles, state machines
- [COMPLIANCE.md](./COMPLIANCE.md) — NABL/ISO 15189, DPDP, audit & e-signature design
- [SECURITY.md](./SECURITY.md) — threat model, authn/authz, encryption, key management
- [INSTRUMENT_INTEGRATION.md](./INSTRUMENT_INTEGRATION.md) — ASTM/HL7, gateway protocol
- [ROADMAP.md](./ROADMAP.md) — phased delivery plan
- [adr/](./adr/) — architecture decision records
