import { cookies } from 'next/headers';

/**
 * Session handling.
 *
 * Tokens live in httpOnly cookies, never in localStorage. A LIMS runs on shared
 * lab machines and a script-readable token is one XSS away from a full patient
 * database. httpOnly means the browser can send it but no script can read it.
 */

const ACCESS_COOKIE = 'labsetu_at';
const REFRESH_COOKIE = 'labsetu_rt';
const USER_COOKIE = 'labsetu_user';

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  tenantId: string;
  tenantCode: string;
  tenantName: string;
  permissions: string[];
  roles: string[];
  labs: { id: string; code: string; name: string }[];
  isMfaEnabled: boolean;
  mustChangePassword: boolean;
  locale: string;
}

export async function setSession(
  accessToken: string,
  refreshToken: string,
  user: SessionUser,
): Promise<void> {
  const store = await cookies();
  const secure = process.env.NODE_ENV === 'production';

  store.set(ACCESS_COOKIE, accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 15 * 60,
  });
  store.set(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 3600,
  });
  // Non-sensitive display data. Readable by the client so the shell can render
  // the user's name and permission-gate the nav without a round trip.
  store.set(USER_COOKIE, JSON.stringify(user), {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 3600,
  });
}

export async function getAccessToken(): Promise<string | undefined> {
  return (await cookies()).get(ACCESS_COOKIE)?.value;
}

export async function getRefreshToken(): Promise<string | undefined> {
  return (await cookies()).get(REFRESH_COOKIE)?.value;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const raw = (await cookies()).get(USER_COOKIE)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, USER_COOKIE]) {
    store.delete(name);
  }
}

export function can(user: SessionUser | null, permission: string): boolean {
  return user?.permissions.includes(permission) ?? false;
}
