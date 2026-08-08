# ADR 0005 — Crypto-shredding to reconcile DPDP erasure with records retention

**Status:** Accepted · **Date:** 2026-07-31

## Context

Two obligations point in opposite directions:

- **DPDP Act, 2023** gives a data principal the right to erasure of their personal data.
- **NABL / ISO 15189** require the lab to retain clinical records and their audit trail for a
  defined period, and our audit chain is broken by any deletion.

Hard-deleting a patient row would break the hash chain and destroy records the lab is
required to keep. Refusing erasure ignores a statutory right. Neither is acceptable.

## Decision

**Encrypt patient identifiers under a per-patient data key; erase by destroying the key.**

```
KMS master key
  └── Tenant DEK (wrapped by master)
        └── Patient data key (wrapped by tenant DEK)
              └── AES-256-GCM ciphertext per identifying field
```

An erasure request destroys the patient's data key. The ciphertext remains in place but is
permanently unrecoverable. The clinical record, the sample history, and the audit chain
survive — de-identified.

## Rationale

- The chain stays intact: no rows are deleted, no hashes change.
- The personal data is genuinely irrecoverable — this is deletion in substance, which is what
  the right protects.
- Clinical and statistical value is retained for the lab's own retention duty and quality
  indicators.
- Restoring an old backup does **not** resurrect the identifiers, because the key is gone from
  the key store. Row deletion has the opposite property, and that gap is one auditors probe.
- The same mechanism implements retention expiry: the sweep worker shreds keys past the
  retention window without touching any row.

## Consequences

- Key management becomes critical infrastructure. Losing a tenant DEK destroys that tenant's
  PII irrecoverably — so tenant DEKs live in KMS with its own durability guarantees, never in
  our database.
- Every identifier read costs a decrypt. Mitigated by caching unwrapped tenant DEKs in memory
  with a short TTL, and by keeping the encrypted-column list deliberately small.
- Search on encrypted fields requires **blind indexes** (keyed HMAC of the normalised value).
  Exact match works; substring search does not, and is deliberately not offered.
- Non-identifying fields (`sex`, `dateOfBirth`) stay plaintext — reference-range selection
  needs them at query time, and they are not identifying on their own.
- Erasure must be recorded in the audit log **as an event**, with the patient referenced by
  internal id only.

## Alternatives rejected

- **Row deletion with cascade.** Breaks the chain, breaks retention, and is undone by a backup
  restore.
- **Tombstone + overwrite with `REDACTED`.** Reversible from backups, and mutating rows in a
  supposedly immutable record set undermines the integrity story we are selling.
- **Whole-database encryption only.** Provides no per-subject granularity, so it cannot
  implement erasure at all.
