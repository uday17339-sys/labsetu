# ADR 0004 — Normalise instrument data at the edge

**Status:** Accepted · **Date:** 2026-07-31

## Context

Report §8.2: instrument integration is "the single most-cited pain point across the entire
industry, for every vendor, at every price point" and "a permanent tax on your engineering
time." Report §12.2 names the established fix: a middleware normalisation layer.

Analyzers speak ASTM E1394 over serial or TCP, HL7 v2 over MLLP, or drop CSV/XML files. None
of these are safe or sensible to expose to the internet.

## Decision

An **on-premises gateway agent** per lab that terminates every instrument protocol locally and
emits one canonical `InstrumentMessageEnvelope` to the cloud API over mTLS. The cloud has
exactly one ingest contract.

## Rationale

- Adding an analyzer becomes **configuration** (connector entry + channel mapping row) rather
  than API code. That is what makes the work delegable to an implementation engineer — and
  delegable work does not consume the product roadmap.
- Analyzers stay on the lab LAN, where old embedded devices belong.
- The store-and-forward outbox means a lab's internet outage never loses a result — a
  reliability property labs immediately understand and value.
- "Nothing leaves your LAN unless we say so" is a materially easier conversation with a
  quality/IT committee.
- Blast radius: gateway credentials are device-scoped and **append-only**. A compromised
  gateway cannot read patient data or alter an existing result.

## Consequences

- A second deployable to build, ship, update and support in premises we do not control.
  Mitigated by signed auto-update bundles with health-check rollback.
- Labs need a machine to run it on. In practice a Windows PC already sits beside the analyzer.
- Raw payloads are archived verbatim before parsing, so parser bugs are recoverable and the
  ALCOA+ "original record" requirement is satisfied.
- Values cross the boundary as **strings**. Analyzers emit `"<0.01"`, `"NEGATIVE"`, `">1000"`;
  coercing at the edge would destroy information. Typing happens cloud-side against the
  analyte's declared value type.

## Alternatives rejected

- **Direct analyzer → cloud.** Requires exposing lab devices to the internet. Non-starter.
- **Buy commercial middleware (e.g. Data Innovations Instrument Manager).** Mature and
  capable, but per-site licensing destroys the price advantage that is our entire market
  position, and it puts a third party in the critical path of the product's core promise.
- **Cloud-side protocol termination over a VPN.** Shifts the problem to managing a VPN into
  every customer's network — harder to sell and harder to operate than an outbound-only agent.
