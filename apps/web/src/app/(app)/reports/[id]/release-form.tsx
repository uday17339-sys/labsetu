'use client';

import { useFormStatus } from 'react-dom';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-60"
    >
      {pending ? 'Releasing…' : 'Sign & release'}
    </button>
  );
}

export function ReleaseForm({
  action,
  mfaEnabled,
}: {
  action: (fd: FormData) => Promise<void>;
  mfaEnabled: boolean;
}) {
  return (
    <form action={action} className="space-y-3">
      <div className="rounded-md border border-ink-200 bg-ink-50 px-3 py-2 text-xs leading-relaxed text-ink-600">
        Releasing signs this exact report and sends it to the patient. Delivery is
        blocked automatically on any channel the patient has not consented to.
      </div>

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-ink-700">Deliver via</legend>
        <div className="space-y-1.5">
          {[
            ['WHATSAPP', 'WhatsApp'],
            ['EMAIL', 'Email'],
            ['SMS', 'SMS'],
            ['PORTAL', 'Patient portal only'],
          ].map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm text-ink-700">
              <input
                type="checkbox"
                name="channel"
                value={value}
                defaultChecked={value === 'WHATSAPP'}
                className="rounded border-ink-300"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink-700">Password</span>
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="w-full rounded-md border border-ink-300 px-3 py-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
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
            className="numeric w-32 rounded-md border border-ink-300 px-3 py-2 text-sm"
          />
        </label>
      )}

      <Submit />
    </form>
  );
}
