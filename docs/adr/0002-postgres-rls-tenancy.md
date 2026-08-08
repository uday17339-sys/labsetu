# ADR 0002 — Tenant isolation via PostgreSQL Row Level Security

**Status:** Accepted · **Date:** 2026-07-31

## Context

Multi-tenant SaaS holding patient health data. A cross-tenant leak is an existential event:
DPDP penalties reach ₹250 crore, and in a product whose entire value proposition is trust, it
ends the company. Three options were considered.

| Option | Isolation | Cost |
|---|---|---|
| Database per tenant | Strongest | Migration and connection management become the job; onboarding is slow |
| Schema per tenant | Strong | Prisma support is poor; hundreds of schemas degrade migrations |
| Shared schema + app-level filtering | Weak | One forgotten `where` clause leaks data |
| **Shared schema + RLS** | **Strong, DB-enforced** | Session-variable plumbing |

## Decision

Shared schema with `tenant_id` on every tenant-owned table, **PostgreSQL RLS** as the
enforcement boundary. The application connects as a role without `BYPASSRLS`. Tenant context
is set per request via `set_config('app.tenant_id', …, true)` inside an interactive
transaction.

## Rationale

Application-layer filtering fails eventually, because it depends on every developer
remembering it on every query forever. RLS converts a discipline problem into a database
guarantee.

The failure mode is also correctly directed: if the session variable is unset,
`current_setting(…, true)` returns NULL, the predicate is NULL, and **zero rows** are
returned. The system fails closed — empty results, never a leak.

## Consequences

- Each request holds a database connection for its lifetime. Concurrency is bounded by pool
  size; slow endpoints are expensive. **Accepted** — it also gives atomicity between a data
  change and its audit entry, which is worth more than the throughput.
- Raw SQL must be reviewed for RLS interaction.
- Migrations run as a separate, privileged role.
- CI carries automated cross-tenant access tests. An untested isolation boundary is an
  assumed one.

## Revisit when

p99 latency or pool saturation becomes the binding constraint. The escape hatch is a Prisma
client extension setting the session variable per operation, which trades audit atomicity
back. Very large single tenants may instead be moved to dedicated databases — the schema
supports both without change.
