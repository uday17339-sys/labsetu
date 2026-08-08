import { NextResponse, type NextRequest } from 'next/server';

/**
 * Session middleware: keeps a signed-in user signed in.
 *
 * Access tokens live 15 minutes. Without this, a demo or a clinic shift silently
 * breaks a quarter of an hour in — every server component would get a 401 and
 * render an error page. The middleware refreshes the token BEFORE the page
 * renders, so the user never sees it happen.
 *
 * Two subtleties this handles that a naive implementation misses:
 *
 *   1. The rotated token is written back onto the REQUEST headers, not just the
 *      response. Server components read cookies from the request, so setting
 *      only the response cookie would refresh successfully and still render the
 *      page with the old, expired token.
 *
 *   2. It refreshes slightly BEFORE expiry (60s skew). Refreshing exactly at
 *      expiry loses the race against clock drift and request latency.
 */

const ACCESS_COOKIE = 'labsetu_at';
const REFRESH_COOKIE = 'labsetu_rt';
const USER_COOKIE = 'labsetu_user';

/** Paths reachable without a session. */
const PUBLIC_PATHS = ['/login', '/_next', '/favicon', '/manifest', '/icon', '/apple-icon', '/robots.txt'];

const REFRESH_SKEW_SECONDS = 60;

export async function middleware(req: NextRequest) {
  // Middleware runs on EVERY request, so an unhandled throw here takes down the
  // entire application rather than one page. Any unexpected failure falls
  // through to the normal request path, where the page's own error handling can
  // deal with it.
  try {
    return await handleSession(req);
  } catch {
    return NextResponse.next();
  }
}

async function handleSession(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const accessToken = req.cookies.get(ACCESS_COOKIE)?.value;
  const refreshToken = req.cookies.get(REFRESH_COOKIE)?.value;

  // No refresh token at all — never signed in, or fully signed out.
  if (!refreshToken) {
    return redirectToLogin(req);
  }

  if (accessToken && !needsRefresh(accessToken)) {
    return NextResponse.next();
  }

  // --- rotate -----------------------------------------------------------------
  // Runtime value; see lib/api.ts for why NEXT_PUBLIC_* is only a fallback.
  const apiUrl =
    process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

  interface RefreshedTokens {
    accessToken: string;
    refreshToken: string;
  }

  let tokens: RefreshedTokens | null = null;
  try {
    const res = await fetch(`${apiUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    });
    if (res.ok) tokens = (await res.json()) as RefreshedTokens;
  } catch {
    // API unreachable. Falling through to sign-out would log the whole lab out
    // during a brief blip, so let the request proceed and let the page surface
    // the real error instead.
    return NextResponse.next();
  }

  if (!tokens) {
    // The refresh token was rejected — expired, revoked, or reuse was detected
    // (which revokes the whole family). Signing out is the correct response.
    const response = redirectToLogin(req, 'expired');
    for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, USER_COOKIE]) {
      response.cookies.delete(name);
    }
    return response;
  }

  // Rewrite the request's cookie header so THIS render sees the new token.
  //
  // Built from the RAW header string, not from req.cookies.getAll(). The parsed
  // API returns percent-DECODED values, and the user cookie holds JSON with the
  // lab's display name — "Sunrise Diagnostics — Jubilee Hills" contains an
  // em-dash (U+2014). Re-serialising that decoded value produces a header with
  // a character above U+00FF, which is not a valid ByteString, and the
  // middleware throws — turning every page in the app into a 500.
  //
  // Slicing the original header leaves every other cookie byte-for-byte as the
  // browser sent it. The two tokens we substitute are JWT/base64url, so always
  // ASCII-safe.
  const rawCookieHeader = req.headers.get('cookie') ?? '';
  const preserved = rawCookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(
      (part) =>
        part &&
        !part.startsWith(`${ACCESS_COOKIE}=`) &&
        !part.startsWith(`${REFRESH_COOKIE}=`),
    );

  const cookieHeader = [
    ...preserved,
    `${ACCESS_COOKIE}=${tokens.accessToken}`,
    `${REFRESH_COOKIE}=${tokens.refreshToken}`,
  ].join('; ');

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('cookie', cookieHeader);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  const secure = process.env.NODE_ENV === 'production';
  response.cookies.set(ACCESS_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 15 * 60,
  });
  response.cookies.set(REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 3600,
  });

  return response;
}

/**
 * Reads `exp` from the JWT payload without verifying the signature.
 *
 * Verification is the API's job — here we only need to know whether it is worth
 * attempting a refresh. A forged token simply fails at the API, and a malformed
 * one is treated as needing refresh, which fails closed.
 */
function needsRefresh(token: string): boolean {
  try {
    const payload = token.split('.')[1];
    if (!payload) return true;
    const decoded = JSON.parse(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
    ) as { exp?: number };
    if (!decoded.exp) return true;
    return decoded.exp - REFRESH_SKEW_SECONDS <= Math.floor(Date.now() / 1000);
  } catch {
    return true;
  }
}

function redirectToLogin(req: NextRequest, reason?: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  if (reason) url.searchParams.set('reason', reason);
  // Come back to where they were once they sign in again.
  if (req.nextUrl.pathname !== '/') {
    url.searchParams.set('next', req.nextUrl.pathname + req.nextUrl.search);
  }
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    // Everything except static assets and image optimisation.
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
