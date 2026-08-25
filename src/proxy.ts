import { NextResponse, type NextRequest } from "next/server";
import { clearingCookie, findStaleSessionCookie, hasSessionCookie, STALE_SESSION_MESSAGE, stripCookies } from "@/server/session-cookie";

/**
 * Clear a session cookie the current AUTH_SECRET cannot read (#1139). Auth.js's own `session` action
 * does answer a broken token with a clearing Set-Cookie, but the React Server Component form of
 * `auth()` only keeps the JSON body — and a page cannot set cookies anyway — so a browser carrying a
 * token from before a secret rotation made Auth.js log `JWTSessionError` on every request, forever.
 * The proxy is the one place that sees the request before the page and may set cookies: it drops the
 * stale cookie from the forwarded request (Auth.js never sees it, so nothing to log downstream),
 * expires it in the response and logs one warn line. Valid sessions pass untouched.
 */
export async function proxy(request: NextRequest) {
  const cookieHeader = request.headers.get("cookie");
  if (!hasSessionCookie(cookieHeader)) return NextResponse.next();
  const stale = await findStaleSessionCookie(cookieHeader);
  if (!stale) return NextResponse.next();

  console.warn(`[auth][warn] ${STALE_SESSION_MESSAGE} (${stale.reason})`);
  const headers = new Headers(request.headers);
  headers.set("cookie", stripCookies(cookieHeader as string, stale.names));
  const response = NextResponse.next({ request: { headers } });
  for (const name of stale.names) response.cookies.set(clearingCookie(name, stale.secure));
  return response;
}

export const config = {
  // Auth.js's own routes clear the cookie themselves (and set new ones on sign-in); static assets never carry a session.
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon\\.ico).*)"],
};
