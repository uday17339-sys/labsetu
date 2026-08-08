import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, EmptyState } from '@/components/ui';
import { dateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface PatientRow {
  id: string;
  patientCode: string;
  sex: string;
  ageDisplay: string;
  createdAt: string;
  isErased: boolean;
}

export default async function PatientsPage({
  searchParams,
}: {
  searchParams: Promise<{
    phone?: string;
    patientCode?: string;
    name?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const sp = await searchParams;
  const user = await getSessionUser();

  const today = new Date().toISOString().slice(0, 10);
  const hasIdentifier = !!(sp.phone || sp.patientCode || sp.name);
  const hasWindow = !!(sp.from || sp.to);

  // With nothing specified, show today's registrations. That is what the front
  // desk actually wants on opening the screen, and it is answerable without
  // weakening the blind-index design — createdAt is not encrypted.
  const from = sp.from ?? (hasIdentifier ? undefined : today);
  const to = sp.to ?? (hasIdentifier ? undefined : today);

  const qs = new URLSearchParams();
  if (sp.phone) qs.set('phone', sp.phone);
  if (sp.patientCode) qs.set('patientCode', sp.patientCode);
  if (sp.name) qs.set('name', sp.name);
  if (from) qs.set('registeredFrom', `${from}T00:00:00.000Z`);
  if (to) qs.set('registeredTo', `${to}T23:59:59.999Z`);
  qs.set('limit', '100');

  const patients = await apiFetch<PatientRow[]>(`/patients?${qs.toString()}`).catch(
    () => [] as PatientRow[],
  );

  const heading = hasIdentifier
    ? 'Search results'
    : hasWindow
      ? `Registered ${from === to ? from : `${from} to ${to}`}`
      : "Today's registrations";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-ink-900">Patients</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Identifiers are encrypted, so lookup is by exact phone, patient code or full name —
            or browse by registration date.
          </p>
        </div>
        {can(user, 'patient:create') && (
          <Link
            href="/register"
            className="min-h-11 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Register patient
          </Link>
        )}
      </div>

      <Card>
        <form className="grid gap-2 border-b border-ink-100 px-4 py-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
          <label>
            <span className="mb-1 block text-xs font-medium text-ink-600">Phone</span>
            <input
              name="phone"
              inputMode="tel"
              defaultValue={sp.phone ?? ''}
              placeholder="9876543210"
              className="numeric h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
            />
          </label>
          <label>
            <span className="mb-1 block text-xs font-medium text-ink-600">Patient code</span>
            <input
              name="patientCode"
              defaultValue={sp.patientCode ?? ''}
              placeholder="SUN000012"
              className="numeric h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
            />
          </label>
          <label>
            <span className="mb-1 block text-xs font-medium text-ink-600">
              Full name (exact)
            </span>
            <input
              name="name"
              defaultValue={sp.name ?? ''}
              placeholder="Lakshmi Rao"
              className="h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
            />
          </label>
          <label>
            <span className="mb-1 block text-xs font-medium text-ink-600">Registered from</span>
            <input
              type="date"
              name="from"
              defaultValue={sp.from ?? ''}
              className="h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
            />
          </label>
          <div className="flex gap-2">
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-xs font-medium text-ink-600">To</span>
              <input
                type="date"
                name="to"
                defaultValue={sp.to ?? ''}
                className="h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
              />
            </label>
            <button
              type="submit"
              className="mt-auto min-h-11 shrink-0 rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
            >
              Search
            </button>
          </div>
        </form>

        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink-100 px-4 py-2">
          <h2 className="text-sm font-semibold text-ink-900">{heading}</h2>
          <span className="numeric text-xs text-ink-500">
            {patients.length} patient{patients.length === 1 ? '' : 's'}
          </span>
        </div>

        {patients.length === 0 ? (
          <EmptyState
            title={hasIdentifier ? 'No match' : 'Nobody registered in this window'}
            hint={
              hasIdentifier
                ? 'Name search is exact — a partial name will not match. Try the phone number or patient code.'
                : 'Widen the date range, or register a patient.'
            }
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {patients.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/patients/${p.id}/history`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-ink-50 active:bg-ink-50"
                >
                  <div className="min-w-0">
                    <div className="numeric text-sm font-medium text-ink-900">
                      {p.patientCode}
                      {p.isErased && (
                        <span className="ml-2 rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-500">
                          erased
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-ink-500">
                      {p.sex.toLowerCase()} · {p.ageDisplay}
                    </div>
                  </div>
                  <span className="numeric shrink-0 text-xs text-ink-400">
                    {dateTime(p.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-400">
          Names and phone numbers are never shown in a list. Opening a record decrypts them,
          requires the stronger permission, and is written to the audit trail as a PHI access.
        </p>
      </Card>
    </div>
  );
}
