import { NextResponse, type NextRequest } from "next/server";
import { CARD_FRAME_HOSTS } from "@/editor/markdown/link-cards";
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
 * Frame policy for every page that is not the embedded document (task #1224). Nothing but the Copilot
 * canvas frames Markdoc, and that frame is the one `frame-ancestors <parentOrigin>` case below; every
 * other page refuses to be framed. No X-Frame-Options: it cannot name the canvas origin, and every
 * browser that matters honours frame-ancestors. The other baseline headers (nosniff, Referrer-Policy,
 * Permissions-Policy, HSTS over HTTPS) are set for every response in server/index.ts, which also sees
 * the paths the matcher below skips.
 */
export const FRAME_ANCESTORS_NONE = "frame-ancestors 'none'";

/**
 * What a page may put in a frame (#2317). A link card is a frame to the provider's own embed page, and
 * only the editor (`/d/<id>`, the embedded canvas included) and the published page (`/p/<id>`) draw
 * cards: those two may frame the hosts on the card list, generated from it, and nothing else. Every
 * other page has no frame at all. The same directive governs where a frame may be navigated later, so
 * a card's frame cannot be driven to a host that is not on the list.
 */
export const CARD_FRAME_SOURCES = `frame-src ${CARD_FRAME_HOSTS.join(" ")}`;
export const NO_FRAME_SOURCES = "frame-src 'none'";

export function frameSources(pathname: string): string {
  return /^\/[dp]\/[^/]+$/.test(pathname) ? CARD_FRAME_SOURCES : NO_FRAME_SOURCES;
}
/**
 * Only pages get the frame policy. `/api/*` responses keep their own headers — `/api/assets/[id]` sets
 * a sandboxing CSP on SVGs that a header set here would replace — and the handoff route
 * (`/embed/<nonce>`, `src/app/embed/[nonce]/route.ts`) is loaded inside the canvas frame by design: its
 * `302` carries no document and its `403`/`410` bodies are the message the frame shows.
 */
export function framePolicyApplies(pathname: string): boolean {
  return !pathname.startsWith("/api/") && !pathname.startsWith("/embed/");
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
  const pathname = request.nextUrl.pathname;
  const isEmbeddedDocument = embed
    && pathname === `/d/${embed.documentId}`
    && request.nextUrl.searchParams.get("embed") === "1";
  const withFramePolicy = (response: NextResponse) => {
    if (isEmbeddedDocument) response.headers.set("Content-Security-Policy", `frame-ancestors ${embed.parentOrigin}; ${CARD_FRAME_SOURCES}`);
    else if (framePolicyApplies(pathname)) response.headers.set("Content-Security-Policy", `${FRAME_ANCESTORS_NONE}; ${frameSources(pathname)}`);
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
