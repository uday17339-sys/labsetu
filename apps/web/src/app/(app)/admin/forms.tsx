'use client';

import { useState } from 'react';
import { Submit, Field, TextArea } from '@/components/forms';

interface Role {
  id: string;
  code: string;
  name: string;
  description: string | null;
  permissionCount: number;
}

/**
 * Onboarding a staff member.
 *
 * Role is a single select rather than a checkbox list: in a lab, one person
 * holds one job. Multi-role is possible through the API for the rare case, but
 * offering it here invites a receptionist being made a pathologist by accident.
 */
export function CreateUserForm({
  action,
  roles,
  labs,
}: {
  action: (fd: FormData) => Promise<void>;
  roles: Role[];
  labs: { id: string; code: string; name: string }[];
}) {
  const [roleId, setRoleId] = useState(
    roles.find((r) => r.code === 'LAB_TECHNICIAN')?.id ?? roles[0]?.id ?? '',
  );
  const selected = roles.find((r) => r.id === roleId);
  const clinical = selected && ['PATHOLOGIST', 'LAB_ADMIN'].includes(selected.code);

  return (
    <form action={action} className="space-y-3 p-4">
      <Field label="Full name" name="fullName" required placeholder="Dr Meera Nair" />
      <Field
        label="Email"
        name="email"
        type="email"
        inputMode="email"
        required
        hint="This is the sign-in username."
      />

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">
          Role<span className="ml-0.5 text-red-600">*</span>
        </span>
        <select
          name="roleId"
          value={roleId}
          onChange={(e) => setRoleId(e.target.value)}
          className="h-11 w-full rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
        >
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        {selected?.description && (
          <span className="mt-1 block text-xs text-ink-400">{selected.description}</span>
        )}
      </label>

      {labs.length > 1 && (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">Branch</span>
          <select
            name="labId"
            className="h-11 w-full rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
          >
            <option value="">All branches</option>
            {labs.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <Field label="Phone" name="phone" inputMode="tel" numeric />

      {/* Qualification and registration number print next to the signature on
          every authorised report, so they matter for anyone who signs. */}
      {clinical && (
        <div className="space-y-3 rounded-md border border-ink-200 bg-ink-50 p-3">
          <p className="text-xs text-ink-600">
            These print beside the signature on every report this person authorises.
          </p>
          <Field label="Qualification" name="qualification" placeholder="MD (Pathology)" />
          <Field
            label="Medical council registration"
            name="registrationNo"
            numeric
            placeholder="KMC/12345/2015"
          />
        </div>
      )}

      <Submit label="Create user" />
      <p className="text-xs text-ink-400">
        A temporary password is generated and shown once. The user must change it at first
        sign-in.
      </p>
    </form>
  );
}

export function GrantCompetencyForm({
  action,
  tests,
}: {
  action: (fd: FormData) => Promise<void>;
  tests: { id: string; code: string; name: string; department: string }[];
}) {
  const [level, setLevel] = useState('PERFORM');
  const [department, setDepartment] = useState('');

  const departments = [...new Set(tests.map((t) => t.department))].sort();
  const shown = department ? tests.filter((t) => t.department === department) : tests;

  // One year is the usual re-assessment interval under NABL 112.
  const defaultExpiry = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);

  return (
    <form action={action} className="space-y-3 p-4">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">
          Level<span className="ml-0.5 text-red-600">*</span>
        </span>
        <select
          name="level"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="h-11 w-full rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
        >
          <option value="PERFORM">Perform — may enter results</option>
          <option value="VERIFY">Verify — may technically verify</option>
          <option value="AUTHORIZE">Authorise — may medically release</option>
        </select>
        <span className="mt-1 block text-xs text-ink-400">
          {level === 'AUTHORIZE'
            ? 'Without this, this person cannot authorise any report — the system refuses.'
            : 'Levels are independent; grant each one that applies.'}
        </span>
      </label>

      {departments.length > 1 && (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink-700">Filter by department</span>
          <select
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            className="h-11 w-full rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
          >
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d} value={d}>
                {d.replace(/_/g, ' ').toLowerCase()}
              </option>
            ))}
          </select>
        </label>
      )}

      <fieldset>
        <legend className="mb-1 text-sm font-medium text-ink-700">
          Tests<span className="ml-0.5 text-red-600">*</span>
        </legend>
        <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-ink-300 p-2">
          {shown.map((t) => (
            <label
              key={t.id}
              className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-ink-50"
            >
              <input
                type="checkbox"
                name="testDefinitionIds"
                value={t.id}
                className="h-4 w-4 shrink-0"
              />
              <span className="numeric text-xs text-ink-500">{t.code}</span>
              <span className="truncate text-ink-900">{t.name}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Valid from" name="validFrom" type="date" />
        <Field label="Valid until" name="validUntil" type="date" defaultValue={defaultExpiry} />
      </div>

      <TextArea
        label="Assessment evidence"
        name="evidenceNote"
        rows={2}
        required
        minLength={10}
        placeholder="e.g. Direct observation 12 Jul 2026, 20 parallel runs vs Dr Rao, record COMP-2026-014"
        hint="Name the evidence. An assessor will ask to see the record you cite here."
      />

      <Submit label="Record assessment" />
    </form>
  );
}

export function RevokeCompetencyForm({ action }: { action: (fd: FormData) => Promise<void> }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="-mr-2 inline-flex min-h-11 items-center px-2 text-xs font-medium text-red-700 hover:underline"
      >
        Revoke
      </button>
    );
  }

  return (
    <form action={action} className="mt-2 space-y-2 border-t border-red-100 pt-2">
      <input
        name="reason"
        required
        minLength={5}
        placeholder="Reason — e.g. reassignment to microbiology"
        className="w-full rounded-md border border-ink-300 px-2 py-1.5 text-xs"
      />
      <div className="flex gap-2">
        <Submit label="Confirm revoke" tone="danger" full={false} />
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="min-h-11 rounded-md px-3 text-sm text-ink-500 hover:bg-ink-100"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ResetPasswordForm({ action }: { action: (fd: FormData) => Promise<void> }) {
  return (
    <form action={action} className="space-y-2 p-4">
      <TextArea
        label="Reason"
        name="reason"
        rows={2}
        required
        minLength={5}
        placeholder="e.g. Staff member forgot password, identity confirmed in person"
      />
      <Submit label="Reset password" tone="danger" />
      <p className="text-xs text-ink-400">
        Issues a new temporary password and signs the user out of every device.
      </p>
    </form>
  );
}

export function SetStatusForm({
  action,
  current,
}: {
  action: (fd: FormData) => Promise<void>;
  current: string;
}) {
  const target = current === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
  return (
    <form action={action} className="p-4">
      <input type="hidden" name="status" value={target} />
      <Submit
        label={target === 'ACTIVE' ? 'Reactivate account' : 'Deactivate account'}
        tone={target === 'ACTIVE' ? 'primary' : 'danger'}
      />
      <p className="mt-2 text-xs text-ink-400">
        Users are deactivated, never deleted — a signature must stay attributable to a real
        person forever.
      </p>
    </form>
  );
}
