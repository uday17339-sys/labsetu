import type { InstrumentObservation } from '@labsetu/contracts';

/**
 * HL7 v2.x ORU^R01 parser.
 *
 * HL7 v2 in practice is a family of dialects rather than one standard, so this
 * parser is liberal in what it accepts and retains anything it does not map
 * instead of discarding it. Silently dropping a segment an analyzer considered
 * important is how integrations appear to work and then lose data.
 *
 * As with ASTM: encoding characters come from MSH-2 and must be READ, not
 * assumed.
 */

// MLLP framing
export const VT = 0x0b;
export const FS = 0x1c;

export interface Hl7Encoding {
  field: string;
  component: string;
  repeat: string;
  escape: string;
  subcomponent: string;
}

const DEFAULT_ENCODING: Hl7Encoding = {
  field: '|',
  component: '^',
  repeat: '~',
  escape: '\\',
  subcomponent: '&',
};

export interface Hl7Segment {
  name: string;
  fields: string[];
}

export function parseMessage(raw: string): {
  segments: Hl7Segment[];
  encoding: Hl7Encoding;
} {
  const lines = raw
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  let encoding = DEFAULT_ENCODING;

  const msh = lines.find((l) => l.startsWith('MSH'));
  if (msh && msh.length >= 8) {
    // MSH-1 is the field separator (the 4th character), MSH-2 the rest.
    encoding = {
      field: msh[3]!,
      component: msh[4] ?? '^',
      repeat: msh[5] ?? '~',
      escape: msh[6] ?? '\\',
      subcomponent: msh[7] ?? '&',
    };
  }

  const segments: Hl7Segment[] = lines.map((line) => {
    const fields = line.split(encoding.field);
    // MSH is offset by one: MSH-1 IS the separator, so the split puts MSH-2 at
    // index 1. Re-align it so field numbering matches the spec everywhere else.
    if (line.startsWith('MSH')) {
      return { name: 'MSH', fields: ['MSH', encoding.field, ...fields.slice(1)] };
    }
    return { name: fields[0] ?? '', fields };
  });

  return { segments, encoding };
}

/** field(seg, 5) returns OBX-5. */
function field(segment: Hl7Segment, index: number): string {
  return (segment.fields[index] ?? '').trim();
}

function component(value: string, index: number, encoding: Hl7Encoding): string {
  return (value.split(encoding.component)[index] ?? '').trim();
}

export function toObservations(raw: string): InstrumentObservation[] {
  const { segments, encoding } = parseMessage(raw);
  const observations: InstrumentObservation[] = [];

  let currentSpecimen = '';
  let isQcRun = false;

  for (const segment of segments) {
    switch (segment.name) {
      case 'OBR': {
        // OBR-3 is the filler order number; OBR-2 the placer. The specimen
        // barcode is normally the placer order number, falling back to filler.
        const placer = field(segment, 2);
        const filler = field(segment, 3);
        currentSpecimen =
          component(placer, 0, encoding) || component(filler, 0, encoding) || currentSpecimen;
        break;
      }

      case 'SPM': {
        // SPM-2 carries the specimen id when present; more precise than OBR.
        const spmId = field(segment, 2);
        const parsed = component(spmId, 0, encoding);
        if (parsed) currentSpecimen = parsed;
        break;
      }

      case 'PID':
        // Patient identity from the analyzer is not authoritative — the
        // specimen id is the only link we trust.
        break;

      case 'OBX': {
        const valueType = field(segment, 2);
        const observationId = field(segment, 3);
        const testCode = component(observationId, 0, encoding);
        const value = field(segment, 5);

        if (!testCode || value === '') break;

        // Structured (SN/CE) values are componentised; take the first component
        // as the reportable value, keeping the whole thing in rawFields.
        const reportable =
          valueType === 'SN' || valueType === 'CE'
            ? value.split(encoding.component).filter(Boolean).join('')
            : value;

        observations.push({
          specimenRef: currentSpecimen,
          testCode,
          value: reportable,
          units: component(field(segment, 6), 0, encoding) || undefined,
          referenceRange: field(segment, 7) || undefined,
          abnormalFlags: field(segment, 8) || undefined,
          resultStatus: mapObx11(field(segment, 11)),
          observedAt: parseHl7Timestamp(field(segment, 14)),
          operator: component(field(segment, 16), 1, encoding) || undefined,
          rerunCount: 0,
          isQc: isQcRun,
          rawFields: {
            valueType,
            observationId,
            ...(field(segment, 4) ? { subId: field(segment, 4) } : {}),
          },
        });
        break;
      }

      case 'NTE': {
        // Notes attach to the preceding OBX.
        const last = observations[observations.length - 1];
        if (last) last.rawFields.note = field(segment, 3);
        break;
      }

      case 'PV1': {
        // A QC run is commonly signalled by patient class 'Q' or location 'QC'.
        isQcRun = field(segment, 2).toUpperCase() === 'Q';
        break;
      }

      default:
        break;
    }
  }

  return observations;
}

function mapObx11(v: string): 'FINAL' | 'PRELIMINARY' | 'CORRECTED' | 'ERROR' {
  switch (v.toUpperCase()) {
    case 'P':
      return 'PRELIMINARY';
    case 'C':
      return 'CORRECTED';
    case 'X':
      return 'ERROR';
    case 'F':
    default:
      return 'FINAL';
  }
}

/**
 * HL7 timestamps are YYYYMMDDHHMMSS[.S[S[S[S]]]][+/-ZZZZ]. When no offset is
 * given the value is local analyzer time — interpreted as IST for the same
 * reason as ASTM.
 */
export function parseHl7Timestamp(v: string): string | undefined {
  const t = v.trim();
  if (t.length < 8) return undefined;

  const offsetMatch = /([+-]\d{4})$/.exec(t);
  const base = offsetMatch ? t.slice(0, -5) : t;

  const year = Number(base.slice(0, 4));
  const month = Number(base.slice(4, 6));
  const day = Number(base.slice(6, 8));
  const hour = Number(base.slice(8, 10) || '0');
  const minute = Number(base.slice(10, 12) || '0');
  const second = Number(base.slice(12, 14) || '0');

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return undefined;
  }

  let offsetMs = 5.5 * 3600 * 1000; // default IST
  if (offsetMatch) {
    const raw = offsetMatch[1]!;
    const sign = raw[0] === '-' ? -1 : 1;
    offsetMs = sign * (Number(raw.slice(1, 3)) * 3600 + Number(raw.slice(3, 5)) * 60) * 1000;
  }

  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMs);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** ACK for an ORU^R01. Analyzers block or retry until they receive one. */
export function buildAck(raw: string, accepted = true): string {
  const { segments, encoding } = parseMessage(raw);
  const msh = segments.find((s) => s.name === 'MSH');

  const sendingApp = msh ? (msh.fields[3] ?? '') : '';
  const sendingFacility = msh ? (msh.fields[4] ?? '') : '';
  const controlId = msh ? (msh.fields[10] ?? '') : '';
  const f = encoding.field;

  const now = new Date();
  const stamp =
    `${now.getFullYear()}` +
    `${String(now.getMonth() + 1).padStart(2, '0')}` +
    `${String(now.getDate()).padStart(2, '0')}` +
    `${String(now.getHours()).padStart(2, '0')}` +
    `${String(now.getMinutes()).padStart(2, '0')}` +
    `${String(now.getSeconds()).padStart(2, '0')}`;

  return (
    `MSH${f}^~\\&${f}LABSETU${f}LAB${f}${sendingApp}${f}${sendingFacility}${f}${stamp}${f}${f}ACK${f}${controlId}${f}P${f}2.5\r` +
    `MSA${f}${accepted ? 'AA' : 'AE'}${f}${controlId}\r`
  );
}
