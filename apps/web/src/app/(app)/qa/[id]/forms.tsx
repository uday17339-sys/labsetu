'use client';

import { useState } from 'react';
import { useFormStatus } from 'react-dom';

function Submit({ label, tone }: { label: string; tone: 'release' | 'reject' }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`min-h-11 w-full rounded-md px-4 py-2 text-sm font-medium text-white transition disabled:opacity-60 ${
        tone === 'release'
          ? 'bg-emerald-600 hover:bg-emerald-700'
          : 'bg-[var(--color-critical)] hover:opacity-90'
      }`}
    >
      {pending ? 'Signing…' : label}
    </button>
  );
}

/**
 * The QA disposition.
 *
 * The decision drives what the form asks for, because the four decisions have
 * genuinely different requirements: a clean approval needs only a rationale, a
 * release against a deviation needs the deviation named, and a rejection needs
 * to be as easy to record as an approval — a form that makes rejecting harder
 * than approving biases the decision.
 */
export function DispositionForm({
  action,
  blockers,
  failedCount,
  mfaEnabled,
}: {
  action: (fd: FormData) => Promise<void>;
  blockers: string[];
  failedCount: number;
  mfaEnabled: boolean;
}) {
  const [decision, setDecision] = useState(
    failedCount > 0 ? 'APPROVED_WITH_DEVIATION' : 'APPROVED',
  );

  const releasing = decision === 'APPROVED' || decision === 'APPROVED_WITH_DEVIATION';
  const blocked = releasing && blockers.length > 0;

  return (
    <form action={action} className="space-y-3 p-4">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">Decision</span>
        <select
          name="decision"
          value={decision}
          onChange={(e) => setDecision(e.target.value)}
          className="h-11 w-full rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
        >
          <option value="APPROVED">Approve — release for use</option>
          <option value="APPROVED_WITH_DEVIATION">Approve against a documented deviation</option>
          <option value="REJECTED">Reject</option>
          <option value="RETEST_REQUIRED">Send back for retest</option>
        </select>
      </label>

      {blocked && (
        <div
          role="alert"
          className="rounded-md border-2 border-[var(--color-critical)] bg-[var(--color-critical-bg)] px-3 py-2"
        >
          <p className="text-xs font-bold text-[var(--color-critical)]">
            Release is blocked
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-[var(--color-critical)]">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      {decision === 'APPROVED' && failedCount > 0 && (
        <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
          {failedCount} non-critical parameter{failedCount > 1 ? 's are' : ' is'} out of
          specification. A clean approval will be refused — record this as a release against a
          documented deviation instead.
        </p>
      )}

      {decision === 'APPROVED_WITH_DEVIATION' && (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">
            Deviation reference<span className="ml-0.5 text-red-600">*</span>
          </span>
          <input
            name="deviationRef"
            required
            placeholder="DEV/2026/0087"
            className="numeric h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
          />
          <span className="mt-1 block text-xs text-ink-400">
            Releasing against an unnamed deviation is not a documented decision.
          </span>
        </label>
      )}

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">
          Rationale<span className="ml-0.5 text-red-600">*</span>
        </span>
        <textarea
          name="rationale"
          rows={3}
          required
          minLength={10}
          placeholder={
            decision === 'REJECTED'
              ? 'e.g. Assay 96.2% against a limit of not less than 98.0%. Root cause established as supplier process drift; consignment returned.'
              : 'e.g. All critical parameters within specification against SPEC/PCM/API v3. Reviewed against COA from supplier and in-house testing.'
          }
          className="w-full rounded-md border border-ink-300 px-2 py-1.5 text-base sm:text-sm"
        />
        <span className="mt-1 block text-xs text-ink-400">
          The first thing an inspector reads. &ldquo;Approved&rdquo; with no basis is a rubber
          stamp, not a disposition.
        </span>
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">Password</span>
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="h-11 w-full rounded-md border border-ink-300 px-3 text-base sm:text-sm"
        />
      </label>

      {mfaEnabled && (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">Authentication code</span>
          <input
            name="totpCode"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            required
            className="numeric h-11 w-32 rounded-md border border-ink-300 px-3 text-base sm:text-sm"
          />
        </label>
      )}

      <Submit
        label={
          decision === 'REJECTED'
            ? 'Sign & reject'
            : decision === 'RETEST_REQUIRED'
              ? 'Sign & send for retest'
              : 'Sign & release'
        }
        tone={decision === 'REJECTED' ? 'reject' : 'release'}
      />
      <p className="text-xs text-ink-400">
        Signed under 21 CFR 11 and bound to the results as they stand now. Dispositions are
        append-only — a reversal is recorded as a new decision, never as an edit.
      </p>
    </form>
  );
}

export function IssueCoaForm({ action }: { action: () => Promise<void> }) {
  return (
    <form action={action} className="p-4">
      <button
        type="submit"
        className="min-h-11 w-full rounded-md border border-ink-300 bg-white px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-100"
      >
        Issue certificate of analysis
      </button>
      <p className="mt-2 text-xs text-ink-400">
        Only for a released batch. Reissuing creates a new version; the original is never
        rewritten.
      </p>
    </form>
  );
}
