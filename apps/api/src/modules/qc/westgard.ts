/**
 * Westgard multi-rule evaluation.
 *
 * The rules are a fixed, published set — implemented here rather than pulled in
 * as a dependency because they are short, must be auditable line by line, and an
 * assessor may ask to see exactly which rule fired and why.
 *
 * Convention: `points` is ordered OLDEST → NEWEST, and the newest point is the
 * one being evaluated. Getting that order backwards silently inverts every
 * sequential rule, which is the classic implementation bug here.
 */

export type WestgardRule = '1-2s' | '1-3s' | '2-2s' | 'R-4s' | '4-1s' | '10-x';

export interface QcPoint {
  /** Standard deviations from the lot's target mean. */
  z: number;
}

export interface WestgardOutcome {
  status: 'PASS' | 'WARNING' | 'REJECT';
  violated: WestgardRule[];
  /** Plain-language explanation, shown to the technician and stored on the run. */
  explanation: string | null;
}

const EXPLANATIONS: Record<WestgardRule, string> = {
  '1-2s': 'One control exceeded 2SD — a warning, not a rejection. Inspect the run.',
  '1-3s': 'One control exceeded 3SD — random error. Reject the run.',
  '2-2s': 'Two consecutive controls exceeded 2SD on the same side — systematic error.',
  'R-4s': 'Two consecutive controls spanned more than 4SD — random error.',
  '4-1s': 'Four consecutive controls exceeded 1SD on the same side — systematic bias.',
  '10-x': 'Ten consecutive controls fell on the same side of the mean — drift.',
};

export function evaluateWestgard(points: QcPoint[]): WestgardOutcome {
  const violated: WestgardRule[] = [];

  if (points.length === 0) {
    return { status: 'PASS', violated, explanation: null };
  }

  // Newest first is easier to reason about for "the last N runs".
  const recent = [...points].reverse();
  const latest = recent[0]!.z;

  // 1-3s — random error, on the current point alone.
  if (Math.abs(latest) > 3) violated.push('1-3s');

  // 2-2s — two consecutive on the SAME side beyond 2SD.
  if (recent.length >= 2) {
    const [a, b] = [recent[0]!.z, recent[1]!.z];
    if (Math.abs(a) > 2 && Math.abs(b) > 2 && Math.sign(a) === Math.sign(b)) {
      violated.push('2-2s');
    }
  }

  // R-4s — range across two consecutive exceeds 4SD. Note this is the SPAN, so
  // it fires on +2.1/-2.1 even though neither point breaches 3SD alone.
  if (recent.length >= 2) {
    const span = Math.abs(recent[0]!.z - recent[1]!.z);
    if (span > 4) violated.push('R-4s');
  }

  // 4-1s — four consecutive on the same side beyond 1SD.
  if (recent.length >= 4) {
    const last4 = recent.slice(0, 4).map((p) => p.z);
    const sameSide = last4.every((z) => Math.sign(z) === Math.sign(last4[0]!));
    if (sameSide && last4.every((z) => Math.abs(z) > 1)) violated.push('4-1s');
  }

  // 10-x — ten consecutive on the same side of the mean, however small.
  if (recent.length >= 10) {
    const last10 = recent.slice(0, 10).map((p) => p.z);
    const sameSide = last10.every((z) => Math.sign(z) === Math.sign(last10[0]!) && z !== 0);
    if (sameSide) violated.push('10-x');
  }

  // 1-2s is a WARNING only, and only when nothing else fired. Treating it as a
  // rejection is the single most common misapplication of these rules and
  // causes labs to discard good runs.
  if (violated.length === 0 && Math.abs(latest) > 2) {
    return {
      status: 'WARNING',
      violated: ['1-2s'],
      explanation: EXPLANATIONS['1-2s'],
    };
  }

  if (violated.length === 0) {
    return { status: 'PASS', violated, explanation: null };
  }

  return {
    status: 'REJECT',
    violated,
    explanation: violated.map((r) => EXPLANATIONS[r]).join(' '),
  };
}

/** Standard deviations from target. Guards a zero SD, which would divide by zero. */
export function zScore(value: number, mean: number, sd: number): number | null {
  if (!Number.isFinite(sd) || sd === 0) return null;
  return (value - mean) / sd;
}
