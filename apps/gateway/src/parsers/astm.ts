import type { InstrumentObservation } from '@labsetu/contracts';

/**
 * ASTM E1381 (framing) / E1394 (content) parser.
 *
 * Still the workhorse in Indian labs: many analyzers support only this, and many
 * that also speak HL7 are configured for ASTM anyway.
 *
 * The one rule that matters most: delimiters are DECLARED IN THE HEADER RECORD
 * and must be read from it. `|`, `\`, `^`, `&` are conventional but not
 * guaranteed, and hardcoding them is a classic source of silently corrupted
 * results — the parse "succeeds" and produces wrong values.
 */

// --- E1381 control characters -----------------------------------------------
export const STX = 0x02;
export const ETX = 0x03;
export const EOT = 0x04;
export const ENQ = 0x05;
export const ACK = 0x06;
export const NAK = 0x15;
export const ETB = 0x17;
export const CR = 0x0d;
export const LF = 0x0a;

export interface AstmDelimiters {
  field: string;
  repeat: string;
  component: string;
  escape: string;
}

const DEFAULT_DELIMITERS: AstmDelimiters = {
  field: '|',
  repeat: '\\',
  component: '^',
  escape: '&',
};

/**
 * Checksum for an E1381 frame: sum of every byte between STX (exclusive) and
 * ETX/ETB (inclusive), modulo 256, as two uppercase hex digits.
 */
export function astmChecksum(frameBody: string): string {
  let sum = 0;
  for (let i = 0; i < frameBody.length; i++) {
    sum = (sum + frameBody.charCodeAt(i)) % 256;
  }
  return sum.toString(16).toUpperCase().padStart(2, '0');
}

export function buildFrame(frameNumber: number, text: string, isLast = true): Buffer {
  const body = `${frameNumber % 8}${text}${isLast ? String.fromCharCode(ETX) : String.fromCharCode(ETB)}`;
  return Buffer.from(
    `${String.fromCharCode(STX)}${body}${astmChecksum(body)}${String.fromCharCode(CR, LF)}`,
    'latin1',
  );
}

export interface ParsedFrame {
  frameNumber: number;
  text: string;
  checksumValid: boolean;
  isLast: boolean;
}

/** Extracts and validates one E1381 frame. */
export function parseFrame(raw: Buffer | string): ParsedFrame | null {
  const s = typeof raw === 'string' ? raw : raw.toString('latin1');
  const stx = s.indexOf(String.fromCharCode(STX));
  if (stx === -1) return null;

  const etxIdx = s.indexOf(String.fromCharCode(ETX), stx);
  const etbIdx = s.indexOf(String.fromCharCode(ETB), stx);
  const terminator = etxIdx !== -1 ? etxIdx : etbIdx;
  if (terminator === -1) return null;

  const body = s.slice(stx + 1, terminator + 1);
  const declared = s.slice(terminator + 1, terminator + 3).toUpperCase();
  const frameNumber = Number(body[0]);

  return {
    frameNumber: Number.isFinite(frameNumber) ? frameNumber : -1,
    text: body.slice(1, -1),
    checksumValid: declared === astmChecksum(body),
    isLast: etxIdx !== -1,
  };
}

export interface AstmRecord {
  type: string;
  fields: string[];
}

/**
 * Splits a complete ASTM message into typed records, using the delimiters the
 * header declares.
 */
export function parseRecords(message: string): {
  records: AstmRecord[];
  delimiters: AstmDelimiters;
} {
  const lines = message
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  let delimiters = DEFAULT_DELIMITERS;

  // H record, field 1: the delimiter definition itself. H is followed
  // immediately by the field delimiter, then repeat/component/escape.
  const header = lines.find((l) => l.startsWith('H'));
  if (header && header.length >= 5) {
    delimiters = {
      field: header[1]!,
      repeat: header[2]!,
      component: header[3]!,
      escape: header[4]!,
    };
  }

  const records: AstmRecord[] = lines.map((line) => ({
    type: line[0]!.toUpperCase(),
    fields: line.split(delimiters.field),
  }));

  return { records, delimiters };
}

/**
 * Maps ASTM records onto canonical observations.
 *
 * O records carry the specimen id, R records carry the values; an R applies to
 * the most recent O, so order is significant and the records are walked in
 * sequence rather than filtered by type.
 */
export function toObservations(message: string): InstrumentObservation[] {
  const { records, delimiters } = parseRecords(message);
  const observations: InstrumentObservation[] = [];

  let currentSpecimen = '';
  let currentOperator: string | undefined;
  let isQcRun = false;

  for (const record of records) {
    switch (record.type) {
      case 'O': {
        // O|seq|specimenId|instrumentSpecimenId|universalTestId|priority|...
        const specimenField = record.fields[2] ?? '';
        currentSpecimen = specimenField.split(delimiters.component)[0] ?? '';
        // Action code Q marks a QC specimen on most analyzers.
        isQcRun = (record.fields[11] ?? '').toUpperCase() === 'Q';
        break;
      }

      case 'P': {
        // Patient record. Deliberately IGNORED for identity: the analyzer's copy
        // of patient demographics is not authoritative and is often stale. The
        // specimen id is the only link we trust.
        break;
      }

      case 'R': {
        // R|seq|^^^testCode|value|units|refRange|flags|...|status|...|completedAt|operator|instrument
        const testIdField = record.fields[2] ?? '';
        const parts = testIdField.split(delimiters.component);
        // Universal Test ID is componentised; the code is usually the 4th
        // component, but analyzers vary — take the last non-empty one.
        const testCode = [...parts].reverse().find((p) => p.trim() !== '') ?? '';

        const value = (record.fields[3] ?? '').trim();
        if (!testCode || value === '') break;

        observations.push({
          specimenRef: currentSpecimen,
          testCode: testCode.trim(),
          // Stays a string: "<0.01", "NEGATIVE" and ">1000" are all legitimate.
          value,
          units: emptyToUndefined(record.fields[4]),
          referenceRange: emptyToUndefined(record.fields[5]),
          abnormalFlags: emptyToUndefined(record.fields[6]),
          resultStatus: mapResultStatus(record.fields[8]),
          observedAt: parseAstmTimestamp(record.fields[12]),
          operator: emptyToUndefined(record.fields[10]) ?? currentOperator,
          rerunCount: 0,
          isQc: isQcRun,
          rawFields: Object.fromEntries(
            record.fields.map((f, i) => [`R${i}`, f]).filter(([, v]) => v !== ''),
          ),
        });
        break;
      }

      case 'C': {
        // Comment attaches to the preceding record. Kept rather than discarded —
        // analyzers put flag explanations here.
        const last = observations[observations.length - 1];
        if (last) last.rawFields.comment = record.fields[3] ?? '';
        break;
      }

      case 'L':
      default:
        break;
    }
  }

  return observations;
}

function emptyToUndefined(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function mapResultStatus(v: string | undefined): 'FINAL' | 'PRELIMINARY' | 'CORRECTED' | 'ERROR' {
  switch ((v ?? '').trim().toUpperCase()) {
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
 * ASTM timestamps are YYYYMMDDHHMMSS in the analyzer's LOCAL time with no zone.
 * Interpreted as IST, because that is where the analyzer physically is. Treating
 * it as UTC would shift every result by 5.5 hours — and this is advisory anyway;
 * the server assigns the authoritative time.
 */
export function parseAstmTimestamp(v: string | undefined): string | undefined {
  const t = v?.trim();
  if (!t || t.length < 8) return undefined;

  const year = Number(t.slice(0, 4));
  const month = Number(t.slice(4, 6));
  const day = Number(t.slice(6, 8));
  const hour = Number(t.slice(8, 10) || '0');
  const minute = Number(t.slice(10, 12) || '0');
  const second = Number(t.slice(12, 14) || '0');

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return undefined;
  }

  // Build the instant as UTC then subtract the IST offset (+05:30).
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - 5.5 * 3600 * 1000;
  const d = new Date(utcMs);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
