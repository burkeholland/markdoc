import type { NextRequest } from "next/server";
import { NextRequest as NextRequestCtor, NextResponse } from "next/server";
import { handlers } from "@/auth";
import {
  clearingCookie,
  EMBED_SESSION_COOKIE,
  SECURE_EMBED_SESSION_COOKIE,
} from "@/server/session-cookie";

/**
 * Auth.js builds every absolute URL it emits (provider signinUrl/callbackUrl, the post-login and
 * sign-out redirects, the OAuth redirect_uri check) from `request.url`. Behind the custom server
 * Next fills that in from the configured hostname, not from what the client typed, so a phone on the
 * LAN was sent to http://localhost:<port>/ (or 0.0.0.0) after signing in. Rebuild the request on the
 * origin the client actually used — the `x-forwarded-*` headers Next derives from the Host header —
 * so localhost, the LAN IP and the machine name all work against one server. AUTH_URL, when set,
 * still wins: next-auth applies it after this.
 */
function withRequestOrigin(req: NextRequest): NextRequest {
  const host = first(req.headers.get("x-forwarded-host") ?? req.headers.get("host"));
  if (!host) return req;
  const proto = first(req.headers.get("x-forwarded-proto")) || "http";
  const url = new URL(req.url);
  const origin = `${proto}://${host}`;
  if (url.origin === origin) return req;
  return new NextRequestCtor(origin + url.pathname + url.search, req);
}

/** First entry of a comma-separated proxy header. */
function first(value: string | null): string {
  return (value ?? "").split(",")[0].trim();
}

export const GET = (req: NextRequest) => handlers.GET(withRequestOrigin(req));
export const POST = async (req: NextRequest) => {
  const response = await handlers.POST(withRequestOrigin(req));
  if (!new URL(req.url).pathname.endsWith("/signout")) return response;
  const cleared = new NextResponse(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
  cleared.cookies.set(clearingCookie(EMBED_SESSION_COOKIE, false));
  cleared.cookies.set(clearingCookie(SECURE_EMBED_SESSION_COOKIE, true));
  return cleared;
};
