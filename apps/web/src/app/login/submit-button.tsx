'use client';

import { useFormStatus } from 'react-dom';

/**
 * The sign-in button, with the state it was missing.
 *
 * Authentication is the slowest thing this form does — Argon2id is deliberately
 * expensive to verify, which is the point of it — so the gap between tapping and
 * landing on a dashboard is the longest unexplained pause in the product, and
 * it is the first thing anyone sees. Without feedback the natural response is a
 * second tap, which lands on a rate limiter and gets told the password is wrong.
 *
 * Its own file because useFormStatus must run in a client component and read
 * the status of the enclosing form — the login page itself stays a server
 * component so the server action can live beside it.
 */
export function SignInButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-brand-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70"
    >
      {pending && (
        <svg
          className="h-4 w-4 animate-spin"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
          <path
            d="M22 12a10 10 0 0 1-10 10"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      )}
      {pending ? pendingLabel : label}
    </button>
  );
}
