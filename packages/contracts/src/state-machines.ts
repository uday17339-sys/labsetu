import type { SampleStatus, SampleTestStatus, ReportStatus } from './enums';

/**
 * Explicit transition tables.
 *
 * Kept as data rather than scattered `if` statements for three reasons: the
 * allowed lifecycle is reviewable in one place by a non-engineer (a quality
 * manager can read this), invalid transitions throw rather than silently
 * no-op, and the tables are directly testable.
 */

export const SAMPLE_TRANSITIONS: Record<SampleStatus, readonly SampleStatus[]> = {
  REGISTERED: ['COLLECTED', 'REJECTED'],
  COLLECTED: ['IN_TRANSIT', 'RECEIVED', 'REJECTED'],
  IN_TRANSIT: ['RECEIVED', 'REJECTED'],
  RECEIVED: ['IN_PROGRESS', 'REJECTED'],
  IN_PROGRESS: ['COMPLETED', 'REJECTED'],
  // Terminal states. A completed or rejected sample is a closed record; a
  // repeat is a new sample with its own accession number, never a reopened one.
  COMPLETED: [],
  REJECTED: [],
};

export const SAMPLE_TEST_TRANSITIONS: Record<
  SampleTestStatus,
  readonly SampleTestStatus[]
> = {
  PENDING: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['RESULT_ENTERED', 'RERUN', 'CANCELLED'],
  RESULT_ENTERED: ['TECH_VERIFIED', 'RERUN', 'CANCELLED'],
  TECH_VERIFIED: ['AUTHORIZED', 'RERUN', 'CANCELLED'],
  // Authorised results can still be amended, but only by creating a new result
  // version with a documented reason — never by editing in place.
  AUTHORIZED: ['REPORTED', 'RERUN'],
  REPORTED: ['RERUN'],
  RERUN: ['IN_PROGRESS'],
  CANCELLED: [],
};

export const REPORT_TRANSITIONS: Record<ReportStatus, readonly ReportStatus[]> = {
  DRAFT: ['AUTHORIZED'],
  AUTHORIZED: ['RELEASED'],
  RELEASED: ['AMENDED'],
  // An amended report is superseded, not deleted. Both versions stay retrievable.
  AMENDED: [],
};

export function canTransition<S extends string>(
  table: Record<S, readonly S[]>,
  from: S,
  to: S,
): boolean {
  return (table[from] ?? []).includes(to);
}

/** Statuses that require an electronic signature to enter. */
export const SIGNATURE_REQUIRED_TRANSITIONS = {
  sampleTest: ['AUTHORIZED'] as const,
  report: ['RELEASED', 'AMENDED'] as const,
};

/** Statuses that require a documented reason to enter. */
export const REASON_REQUIRED_TRANSITIONS = {
  sample: ['REJECTED'] as const,
  sampleTest: ['RERUN', 'CANCELLED'] as const,
  report: ['AMENDED'] as const,
};
