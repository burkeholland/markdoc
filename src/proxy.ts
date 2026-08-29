import { NextResponse, type NextRequest } from "next/server";
import { clearingCookie, decodeEmbedSession, findStaleSessionCookie, hasSessionCookie, STALE_SESSION_MESSAGE, stripCookies } from "@/server/session-cookie";

export const CANONICAL_HOST_ENV = "MARKDOC_CANONICAL_HOST";

/** Last raw value seen, so a misconfiguration is warned about once rather than on every request. */
let canonicalHostCache: { raw: string; host: string | null } | null = null;

/**
 * Hostname (lowercase, no scheme/port/path) the site should be reached on, or `null` when unset or
 * invalid. An invalid value is warned about once and then ignored: a typo in an env var must never
 * take the site down.
 */
export function canonicalHost(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[CANONICAL_HOST_ENV] ?? "";
  if (canonicalHostCache?.raw === raw) return canonicalHostCache.host;
  const host = parseCanonicalHost(raw);
  if (host === null && raw.trim() !== "") {
    console.warn(`[proxy][warn] ${CANONICAL_HOST_ENV} is not a bare hostname (no scheme, port or path); canonical-host redirect disabled`);
  }
  canonicalHostCache = { raw, host };
  return host;
}

function parseCanonicalHost(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (/[\s/:@?#\\]/.test(value)) return null;
  try {
    // `new URL` normalises IDNs and rejects garbage; requiring hostname round-trip catches the rest.
    return new URL(`https://${value}`).hostname === value ? value : null;
  } catch {
    return null;
  }
}

/** Host the client asked for: first `x-forwarded-host` else `host`, lowercased, without a `:port`. */
export function requestHost(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
  const raw = forwarded || headers.get("host")?.trim();
  if (!raw) return null;
  const withoutPort = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.split(":", 1)[0];
  return withoutPort.toLowerCase();
}

/**
 * `308` to the canonical host for a top-level `GET`/`HEAD` that arrived on another host (after a
 * custom-domain cutover the Container App keeps answering on its `*.azurecontainerapps.io` name, and
 * signing in there would fail: the OAuth app has one callback URL). `/api/*` (health probes, MCP
 * agents on the old URL, Auth.js), WebSocket upgrades, writes and host-less requests pass through.
 */
export function canonicalRedirect(request: NextRequest, canonical: string | null = canonicalHost()): NextResponse | null {
  if (!canonical) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (request.nextUrl.pathname.startsWith("/api/")) return null;
  if (request.headers.get("upgrade")?.toLowerCase().includes("websocket")) return null;
  const host = requestHost(request.headers);
  if (!host || host === canonical) return null;
  const location = new URL(`https://${canonical}`);
  location.pathname = request.nextUrl.pathname;
  location.search = request.nextUrl.search;
  return NextResponse.redirect(location, 308);
}

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
  const redirect = canonicalRedirect(request);
  if (redirect) return redirect;

  const cookieHeader = request.headers.get("cookie");
  const embed = await decodeEmbedSession(cookieHeader);
  const isEmbeddedDocument = embed
    && request.nextUrl.pathname === `/d/${embed.documentId}`
    && request.nextUrl.searchParams.get("embed") === "1";
  const withFramePolicy = (response: NextResponse) => {
    if (isEmbeddedDocument) response.headers.set("Content-Security-Policy", `frame-ancestors ${embed.parentOrigin}`);
    return response;
  };
  if (!hasSessionCookie(cookieHeader)) return withFramePolicy(NextResponse.next());
  const stale = await findStaleSessionCookie(cookieHeader);
  if (!stale) return withFramePolicy(NextResponse.next());

  console.warn(`[auth][warn] ${STALE_SESSION_MESSAGE} (${stale.reason})`);
  const headers = new Headers(request.headers);
  headers.set("cookie", stripCookies(cookieHeader as string, stale.names));
  const response = NextResponse.next({ request: { headers } });
  for (const name of stale.names) response.cookies.set(clearingCookie(name, stale.secure));
  return withFramePolicy(response);
}

export const config = {
  // Auth.js's own routes clear the cookie themselves (and set new ones on sign-in); static assets never carry a session.
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon\\.ico).*)"],
};
