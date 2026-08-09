'use client';

import { useFormStatus } from 'react-dom';

/**
 * A submit button for a server-action form whose markup is not a plain label —
 * an icon button, or one whose contents are laid out by the caller.
 *
 * The forms across the app already have pending states through their own local
 * Submit components; this exists for the handful rendered inside server
 * components, which cannot call useFormStatus themselves. Sign-out is the one
 * that matters: it is a single tap that clears a session, and on a slow link a
 * second tap while the first is in flight is a confusing round trip through the
 * login screen.
 */
export function PendingButton({
  children,
  pendingChildren,
  className,
  ...rest
}: {
  children: React.ReactNode;
  pendingChildren?: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();

  return (
    <button
      {...rest}
      type="submit"
      disabled={pending}
      aria-busy={pending || undefined}
      className={`${className ?? ''} transition disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {pending && pendingChildren ? pendingChildren : children}
    </button>
  );
}
