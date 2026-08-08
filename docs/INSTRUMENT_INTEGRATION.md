# LabSetu — Instrument Integration

> The report calls instrument integration "the single most-cited pain point across the entire
> industry, for every vendor, at every price point" (§8.2) and "a permanent tax on your
> engineering time." This document describes how we bound that tax.

---

## 1. The strategy in one sentence

**Normalise at the edge, once.** Every analyzer — whatever it speaks — is translated into a
single canonical envelope by the on-prem gateway. The cloud API has exactly one ingest
contract and never learns that ASTM, HL7, or RS-232 exist.

The consequence: adding an analyzer is a **configuration** change (a connector entry plus a
channel-mapping row), not a code change to the API. The work moves from "senior engineer
writes a bespoke integration" to "implementation engineer fills in a mapping" — which is what
makes it delegable, and therefore what stops it consuming the roadmap.

---

## 2. Why a separate on-prem gateway

| Reason | Detail |
|---|---|
| Analyzers are not internet devices | RS-232 serial and raw TCP sockets. Many run embedded OSes that will never be patched. They must stay on the lab LAN. |
| Lab internet is unreliable | The gateway's store-and-forward outbox persists results locally and replays them when connectivity returns. **A result is never lost because the link was down.** |
| Blast radius | A compromised gateway holds device-scoped credentials that can only *append* messages. It cannot read patient data, and cannot mutate an existing result. |
| Sales reality | "Nothing leaves your LAN unless we say so" is a much easier conversation with a quality/IT committee than "point your analyzer at our cloud." |

---

## 3. Connector types

| Connector | Transport | Typical source |
|---|---|---|
| `serial` | RS-232 / USB-serial | Older haematology and biochemistry analyzers |
| `tcp-astm` | TCP socket, ASTM E1381 framing | Most mid-range clinical analyzers (LIS2-A2) |
| `hl7-mllp` | TCP, MLLP framing | Modern analyzers and middleware, hospital HIS |
| `file-watch` | Watched directory | Chromatography data systems (Empower, OpenLab, Chromeleon) and analyzer CSV/XML exports |
| `poll-http` | HTTP polling | Newer analyzers with a local REST/JSON API |

All five reduce to the same pipeline:

```
raw bytes ──▶ framing ──▶ parser ──▶ normaliser ──▶ envelope ──▶ outbox ──▶ API
     │                                                              │
     └────────── raw archived verbatim ─────────────────────────────┘
```

**The raw payload is archived before parsing, always.** If the parser is wrong, the original
is still there to reprocess — and an auditor can be shown precisely what the instrument
emitted. This is an ALCOA+ "original record" requirement, not just engineering hygiene.

---

## 4. Protocols

### 4.1 ASTM E1381 (framing) / E1394 (content)

Still the workhorse in Indian labs — many analyzers support only this, and many that support
HL7 are configured for ASTM anyway.

**Framing (E1381):** `<STX> FN text <ETX> C1 C2 <CR><LF>`, checksum = sum of bytes mod 256,
hex, uppercase. Frames > 240 chars are split with `<ETB>`. Link layer is
`ENQ → ACK → frames → EOT`, with `NAK` triggering retransmission (max 6 attempts).

**Content (E1394):** pipe-delimited records, one per line, typed by first character:

| Rec | Meaning | Fields we consume |
|---|---|---|
| `H` | Header | delimiters, sender id, version, timestamp |
| `P` | Patient | patient id, name, DOB, sex |
| `O` | Order | specimen id (**our accession number**), universal test id, priority, action code |
| `R` | Result | test id, value, units, reference range, abnormal flags, status, completion timestamp, operator, instrument |
| `C` | Comment | free text attached to the preceding record |
| `Q` | Query | host-query mode — analyzer asks "what tests for this barcode?" |
| `L` | Terminator | end of message |

Delimiters are declared in the `H` record and **must be read from it**, not hardcoded. `|`,
`\`, `^`, `&` are conventional but not guaranteed, and assuming them is a classic source of
silent corruption.

**Host-query mode** matters commercially: the analyzer reads the barcode and asks the LIMS
which tests to run. Supporting it removes manual worklist programming at the analyzer — a
visible, demo-able time saving for the lab.

### 4.2 HL7 v2.x

We consume `ORU^R01` (observation result) and respond with `ACK`. Segments used:
`MSH`, `PID`, `PV1`, `OBR`, `OBX`, `NTE`, `SPM`.

The value lives in `OBX-5`, units in `OBX-6`, reference range in `OBX-7`, abnormal flags in
`OBX-8`, result status in `OBX-11`, observation time in `OBX-14`.

MLLP framing: `<VT> message <FS><CR>`.

Encoding characters come from `MSH-2` — same rule as ASTM, read them, don't assume them.
HL7 v2 in practice is a family of dialects; the parser is written to be liberal in what it
accepts and to surface unmapped segments rather than discard them silently.

### 4.3 File-based

Watch a directory, wait for the file to stop growing (analyzers write incrementally, and
reading a half-written file is the most common integration bug in this space), parse per a
per-instrument profile (CSV column map, XML XPath), then move to `processed/` or `failed/`
with a sidecar reason file. Idempotency is by content hash, so a file reappearing does not
double-post results.

---

## 5. The canonical envelope

Defined in [`packages/contracts/src/instrument.ts`](../packages/contracts/src/instrument.ts):

```ts
InstrumentMessageEnvelope {
  messageId        // UUID from gateway — the idempotency key
  deviceId         // registered device
  protocol         // ASTM_E1394 | HL7_V2 | FILE_CSV | FILE_XML | JSON_HTTP
  capturedAt       // gateway clock (advisory)
  rawChecksum      // SHA-256 of the raw payload
  rawStorageKey    // where the verbatim original lives
  observations: [{
    specimenRef      // accession number as the analyzer knows it
    testCode         // instrument's own code — mapped, not assumed
    value            // string; never coerced at the edge
    units
    referenceRange   // as reported by the instrument, informational only
    abnormalFlags
    resultStatus     // FINAL | PRELIMINARY | CORRECTED | ERROR
    observedAt
    operator
    rerunCount
    dilutionFactor
    rawFields        // everything unmapped, retained
  }]
}
```

Two deliberate decisions:

**`value` stays a string.** Analyzers emit `"<0.01"`, `"NEGATIVE"`, `"1.2E3"`, `"TNP"`,
`">1000"`. Coercing to a number at the edge destroys information and throws away results the
lab needs. Typing happens later, in the cloud, against the analyte's declared value type,
where the rules are known and versioned.

**The instrument's `referenceRange` is informational.** The authoritative range is ours, from
the versioned catalog, selected by patient age and sex. Analyzers are frequently configured
with stale ranges, and trusting them would import someone else's data-entry error into a
clinical report.

---

## 6. Cloud-side pipeline

```
POST /v1/ingest/messages   (mTLS + device key + HMAC body signature + nonce)
  │
  ├─▶ verify device, signature, timestamp skew (±5 min), nonce not seen
  ├─▶ archive raw payload → S3 (WORM bucket)
  ├─▶ INSERT instrument_message (status = RECEIVED)   ← idempotent on messageId
  ├─▶ enqueue BullMQ `ingest.map`
  └─▶ 202 Accepted   (fast ack; the gateway can clear its outbox)

worker ingest.map
  ├─▶ resolve specimenRef  → Sample          (unmatched → HELD, surfaced for review)
  ├─▶ resolve testCode     → DeviceChannel   → TestDefinition + Analyte
  ├─▶ type + validate value against the analyte's value type
  ├─▶ apply our reference range (patient age/sex, catalog version in force)
  ├─▶ delta check vs the patient's previous result
  ├─▶ critical-value detection → notification
  ├─▶ QC gate check for this device+analyte
  └─▶ INSERT Result (status = RESULT_ENTERED, source = INSTRUMENT)
```

**Instrument results are never auto-authorised.** They land at `RESULT_ENTERED` and still
require human verification and authorisation. Auto-release is a feature some labs eventually
want for specific high-volume analytes; it will be a per-analyte, per-tenant policy with its
own audit action — never a default.

Unmatched specimens go to a **held queue** rather than being dropped or guessed. A mis-matched
result is a patient-safety event; an item in a review queue is an inconvenience.

---

## 7. Onboarding a new analyzer

The process this whole design exists to make boring:

1. Register the `Device` (make, model, serial, protocol, lab, location).
2. Add a gateway connector entry (port/host/path + protocol profile).
3. Run in **shadow mode** — capture and parse, but write nothing. Compare against the lab's
   existing manual entries for a few days.
4. Map `DeviceChannel` rows: instrument test code → our `TestDefinition` + `Analyte`, with any
   unit conversion.
5. Verify with the analyzer's QC materials across the reportable range.
6. Record the verification as the device's IQ/OQ evidence.
7. Enable live ingest.

Shadow mode is the step that makes this safe to hand to an implementation engineer, and it is
the step most vendors skip. Target: **two days** for an analyzer whose protocol profile
already exists, **one to two weeks** for a genuinely new protocol.

---

## 8. Target analyzer list for v1

Per report §12.6 and Recommendation 5 — pick a short list, go deep, refuse to promise
universal compatibility.

| # | Category | Rationale |
|---|---|---|
| 1 | 3-part / 5-part haematology analyzer | Highest volume test in any diagnostic lab |
| 2 | Clinical chemistry autoanalyzer | Second highest volume; broad analyte coverage |
| 3 | Electrolyte analyzer (ISE) | Near-universal, simple protocol, quick win |
| 4 | Immunoassay / CLIA analyzer | High-value tests, strong revenue attachment |
| 5 | Urine analyzer | Common, simple, completes the routine panel |
| 6 | Coagulation analyzer | Rounds out routine diagnostics |
| 7 | Generic `file-watch` CSV/XML profile | Covers the long tail without new code |
| 8 | Generic `hl7-mllp` profile | Covers modern analyzers and HIS integration |

Rows 7 and 8 are the leverage: a configurable generic profile absorbs most of the tail that
would otherwise become bespoke work. Exact makes and models get fixed once the pilot lab's
actual inventory is known — committing to specific vendors before that is guessing.

---

## 9. Gateway operations

- **Install:** Windows service or Linux systemd unit; a single Node bundle. Most Indian labs
  will run it on a Windows PC already sitting next to the analyzer.
- **Enrolment:** one-time code from the LIMS admin UI → gateway obtains its device
  certificate and key. Credentials are shown exactly once.
- **Outbox:** durable local queue with exponential backoff. **Sized for 72 hours** of a busy
  lab's output — long enough to cover a weekend outage.
- **Health:** heartbeat every 60s with connector status, outbox depth, last-message time. A
  silent analyzer is an alert on the LIMS dashboard, because "we didn't notice it stopped
  sending" is the failure mode that actually bites labs.
- **Updates:** signed bundles, staged rollout, automatic rollback on failed health check. A
  gateway that bricks itself during an update in a lab 800 km away is an unrecoverable
  support situation, so this is built in rather than added later.
- **Local buffer encryption:** the outbox holds patient results, so it is encrypted at rest
  with a device-held key.
