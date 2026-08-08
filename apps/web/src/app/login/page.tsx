import { redirect } from 'next/navigation';
import { apiLogin } from '@/lib/api';
import { setSession, type SessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

async function signIn(formData: FormData): Promise<void> {
  'use server';

  const tenantCode = String(formData.get('tenantCode') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const totpCode = String(formData.get('totpCode') ?? '').trim() || undefined;
  // Where the middleware bounced them from, so they land back on the screen
  // they were actually trying to reach.
  const next = String(formData.get('next') ?? '').trim();

  let result: { status: string; accessToken?: string; refreshToken?: string; user?: SessionUser };
  try {
    result = (await apiLogin({ tenantCode, email, password, totpCode })) as typeof result;
  } catch {
    // Uniform message: distinguishing "no such user" from "wrong password"
    // hands an attacker a user-enumeration oracle.
    redirect('/login?error=1');
  }

  if (result.status === 'MFA_REQUIRED') {
    redirect(
      `/login?mfa=1&tenantCode=${encodeURIComponent(tenantCode)}&email=${encodeURIComponent(email)}` +
        (next ? `&next=${encodeURIComponent(next)}` : ''),
    );
  }

  await setSession(result.accessToken!, result.refreshToken!, result.user!);
  // Only same-origin paths: an open redirect on a login form is a phishing
  // primitive, so anything not starting with a single '/' is discarded.
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    mfa?: string;
    tenantCode?: string;
    email?: string;
    reason?: string;
    next?: string;
  }>;
}) {
  const params = await searchParams;
  const mfaStep = params.mfa === '1';
  const expired = params.reason === 'expired';

  return (
    <div className="flex min-h-screen">
      {/* Left: the pitch. This is the first thing a lab owner sees in a demo. */}
      <div className="hidden lg:flex lg:w-1/2 flex-col justify-between bg-ink-950 p-12 text-white">
        <div>
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-brand-500 font-bold">
              LS
            </div>
            <span className="text-xl font-semibold tracking-tight">LabSetu</span>
          </div>
        </div>

        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-tight">
            The record cannot be changed after the fact.
          </h1>
          <p className="mt-4 text-ink-300 leading-relaxed">
            Every entry is timestamped by the server and linked into a
            tamper-evident chain. Not because it is a nice feature — because
            &ldquo;prove this result is real&rdquo; is the question your
            accreditation depends on.
          </p>
          <dl className="mt-8 space-y-3 text-sm">
            {[
              ['NABL / ISO 15189', 'Competency, QC gating, quality indicators'],
              ['DPDP Act, 2023', 'Consent, encryption, India-only residency'],
              ['Analyzer integration', 'ASTM and HL7 normalised at the edge'],
            ].map(([term, desc]) => (
              <div key={term} className="flex gap-3">
                <dt className="w-40 shrink-0 font-medium text-brand-100">{term}</dt>
                <dd className="text-ink-400">{desc}</dd>
              </div>
            ))}
          </dl>
        </div>

        <p className="text-xs text-ink-500">
          Hosted in ap-south-1 (Mumbai) · Data never leaves India
        </p>
      </div>

      {/* Right: the form */}
      <div className="flex w-full lg:w-1/2 items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="lg:hidden mb-8 flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-brand-500 font-bold text-white">
              LS
            </div>
            <span className="text-xl font-semibold">LabSetu</span>
          </div>

          <h2 className="text-2xl font-semibold text-ink-900">
            {mfaStep ? 'Two-factor authentication' : 'Sign in'}
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            {mfaStep
              ? 'Enter the 6-digit code from your authenticator app.'
              : 'Use the credentials issued by your lab administrator.'}
          </p>

          {params.error && (
            <div
              role="alert"
              className="mt-5 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            >
              Invalid credentials. Check your tenant code, email and password.
            </div>
          )}

          {expired && !params.error && (
            <div
              role="status"
              className="mt-5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            >
              Your session ended. Sign in again to continue where you left off.
            </div>
          )}

          <form action={signIn} className="mt-6 space-y-4">
            <input type="hidden" name="next" value={params.next ?? ''} />
            <Field
              label="Tenant code"
              name="tenantCode"
              defaultValue={params.tenantCode ?? 'SUNRISE'}
              autoComplete="organization"
              required
              hint="Your lab's short code"
            />
            <Field
              label="Email"
              name="email"
              type="email"
              defaultValue={params.email ?? ''}
              autoComplete="username"
              required
            />
            <Field label="Password" name="password" type="password" autoComplete="current-password" required />

            {mfaStep && (
              <Field
                label="Authentication code"
                name="totpCode"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                autoComplete="one-time-code"
                required
                autoFocus
              />
            )}

            <button
              type="submit"
              className="min-h-11 w-full rounded-md bg-brand-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
            >
              {mfaStep ? 'Verify' : 'Sign in'}
            </button>
          </form>

          <details className="mt-8 rounded-md border border-ink-200 bg-white p-3 text-sm">
            <summary className="cursor-pointer font-medium text-ink-700">
              Demo accounts
            </summary>
            <p className="mt-2 text-xs text-ink-500">
              Tenant <code className="rounded bg-ink-100 px-1">SUNRISE</code>, password{' '}
              <code className="rounded bg-ink-100 px-1">LabSetu@2026</code>
            </p>
            <ul className="mt-2 space-y-1 text-xs text-ink-600">
              <li>
                <code>pathologist@sunrise.test</code> — can authorise results
              </li>
              <li>
                <code>tech@sunrise.test</code> — enters and verifies, cannot authorise
              </li>
              <li>
                <code>front@sunrise.test</code> — registration and billing
              </li>
              <li>
                <code>auditor@sunrise.test</code> — read-only + audit trail
              </li>
            </ul>
          </details>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-700">{label}</span>
      <input
        {...props}
        className="h-11 w-full rounded-md border border-ink-300 bg-white px-3 text-base text-ink-900 shadow-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100 sm:text-sm"
      />
      {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
    </label>
  );
}
