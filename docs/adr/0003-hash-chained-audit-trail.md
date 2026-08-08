# ADR 0003 — Hash-chained, append-only audit trail

**Status:** Accepted · **Date:** 2026-07-31

## Context

The market report (§11.1) records staff at NABL-accredited labs describing fabrication and
backdating of QC logs before inspections, and the study's own participants proposed the fix:
real-time digital recording that makes backdating impossible.

That reframes the product. We are not selling digitisation — we are selling **the removal of
the physical possibility of gaming the record**. The audit trail is therefore not a
supporting feature; it is the thing being sold.

## Decision

A single `audit_log` table with:

1. `INSERT`/`SELECT` grants only — no `UPDATE`, no `DELETE` for the application role.
2. `occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()` — server-assigned, not application-writable.
3. Per-tenant monotonic `seq` with a unique constraint, so gaps are detectable.
4. `hash = SHA256(prev_hash ‖ canonical_json(entry))`, forming a per-tenant chain.
5. Monthly range partitioning on `occurred_at`.
6. Nightly chain verification with critical alerting.
7. Optional daily anchoring of the chain head to WORM storage and to the customer's own
   quality manager.

## Rationale

Each property closes a specific attack:

| Attack | Closed by |
|---|---|
| Edit a past record | Grants (1) |
| Backdate an entry | Server time (2) |
| Delete an entry | Chain (4) + gap detection (3) |
| Rewrite the whole chain with DB superuser | External anchoring (7) |

Point 7 is what makes the guarantee meaningful to a **third party** rather than only to us —
without it, anyone with sufficient database privileges could recompute a consistent chain.
Stating this openly is deliberate: an assessor will ask, and having the answer ready is worth
more than a stronger-sounding claim that does not survive scrutiny.

## Consequences

- Write amplification: every mutation writes a second row. Acceptable — this table is the
  product.
- Canonical JSON serialisation must be deterministic and stable **forever**; changing it
  breaks verification of historical entries. Treated as a frozen interface with its own
  test suite.
- The chain is per-tenant, so tenants can be exported or migrated independently.
- Storage grows steadily and is never pruned inside the retention window. Old partitions move
  to cheaper storage instead.

## Alternatives rejected

- **Postgres triggers writing audit rows.** More robust against a forgetful developer, but
  business context — *why* a change was made, which user intent it belonged to — is not
  available at trigger level, and "reason for change" is a regulatory requirement. Interceptor
  chosen; a trigger-based backstop for direct SQL writes remains an option.
- **Append-only ledger database (QLDB or similar).** Real cryptographic verification, but adds
  a second datastore, loses transactional atomicity with the operational data, and creates a
  vendor dependency that conflicts with the self-hosted edition.
