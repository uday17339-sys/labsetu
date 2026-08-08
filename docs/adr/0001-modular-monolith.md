# ADR 0001 — Modular monolith over microservices

**Status:** Accepted · **Date:** 2026-07-31

## Context

A LIMS spans a dozen bounded contexts (accessioning, catalog, results, QC, reporting,
billing, ingest). The instinct is to split them into services. The team is small, the sales
cycle is 6–18 months, and the first year is about reaching one working pilot lab.

## Decision

Build **one deployable NestJS application** with hard internal module boundaries. Domain
modules communicate through exported services and domain events, never by reaching into each
other's Prisma models.

## Rationale

- A distributed system multiplies operational surface at exactly the stage where there is no
  operations team.
- Regulated software must produce a coherent audit trail. Keeping the data change and its
  audit entry in **one database transaction** is trivial in a monolith and genuinely hard
  across service boundaries.
- Transactional consistency across accession → test → result is a correctness requirement,
  not a convenience. Eventual consistency in a clinical result pipeline is a patient-safety
  liability.
- Module boundaries — not process boundaries — are what actually preserve the option to split
  later.

## Consequences

- Everything scales together; a heavy PDF render competes with an accessioning request.
  Mitigated by moving CPU-heavy work to BullMQ workers, which are already separate processes.
- Discipline is required: a lint rule forbids cross-module Prisma model imports, because the
  boundary is only real if it is enforced mechanically.
- **Extraction path:** `ingest` and `reports` leave first — both already communicate only via
  queue messages and the database. Extraction becomes a deployment change.

## Revisit when

A module's scaling profile diverges sharply from the rest (ingest volume is the likely first
candidate), or team size passes roughly 10 engineers and merge contention becomes real.
