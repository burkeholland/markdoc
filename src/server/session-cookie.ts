import { decode, getToken } from "next-auth/jwt";

/**
 * Detect an Auth.js session cookie the current AUTH_SECRET cannot read — left behind by a secret
 * rotation (every rebuild regenerates `.env.local`) or simply garbage — so the proxy can clear it
 * once instead of letting Auth.js log `JWTSessionError` on every request for as long as the browser
 * keeps the cookie. Pure: no Next.js imports, so it is unit-testable and usable from `proxy.ts`.
 */

export const SESSION_COOKIE = "authjs.session-token";
export const SECURE_SESSION_COOKIE = `__Secure-${SESSION_COOKIE}`;

/** The one line logged for a stale cookie; no stack trace — it is the browser's state, not a server fault. */
export const STALE_SESSION_MESSAGE = "session cookie signed with an old secret — cleared";

export interface StaleSessionCookie {
  /** Cookie names to clear: the token and any `.N` chunks Auth.js split it into. */
  names: string[];
  /** True for the `__Secure-` variant (the clearing Set-Cookie must carry `Secure` or browsers drop it). */
  secure: boolean;
  /** Why the token was rejected, e.g. `no matching decryption secret`. */
  reason: string;
}

/** Secrets Auth.js accepts: `AUTH_SECRET` plus `AUTH_SECRET_1..3` for rotation, mirroring `@auth/core`'s env defaults. */
export function sessionSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const secrets: string[] = [];
  if (env.AUTH_SECRET) secrets.push(env.AUTH_SECRET);
  for (const i of [1, 2, 3]) {
    const secret = env[`AUTH_SECRET_${i}`];
    if (secret) secrets.unshift(secret);
  }
  return secrets;
}

const SESSION_COOKIE_RE = /(?:^|;\s*)(__Secure-)?authjs\.session-token(?:\.\d+)?=/;

/** Cheap pre-check so the proxy does no crypto on requests without a session cookie. */
export function hasSessionCookie(cookieHeader: string | null | undefined): boolean {
  return !!cookieHeader && SESSION_COOKIE_RE.test(cookieHeader);
}

/** Cookie names in the header that belong to `name`: the cookie itself and its `name.N` chunks. */
export function sessionCookieNames(cookieHeader: string, name: string): string[] {
  const names: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name || (key.startsWith(`${name}.`) && /^\d+$/.test(key.slice(name.length + 1)))) names.push(key);
  }
  return names;
}

/** The Cookie header without the named cookies, so the route behind the proxy never sees the stale token. */
export function stripCookies(cookieHeader: string, names: string[]): string {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      const eq = part.indexOf("=");
      return !names.includes((eq < 0 ? part : part.slice(0, eq)).trim());
    })
    .join("; ");
}

/**
 * Find a session cookie Auth.js would reject. Returns what to clear, or null when there is no session
 * cookie, the secret is not configured, or the token decodes with one of the current secrets (a valid
 * session is never touched). Both the plain and the `__Secure-` cookie are checked, with the cookie
 * name as salt exactly like Auth.js does.
 */
export async function findStaleSessionCookie(cookieHeader: string | null | undefined, secrets: string[] = sessionSecrets()): Promise<StaleSessionCookie | null> {
  if (!hasSessionCookie(cookieHeader) || secrets.length === 0) return null;
  const header = cookieHeader as string;
  for (const [name, secure] of [
    [SESSION_COOKIE, false],
    [SECURE_SESSION_COOKIE, true],
  ] as const) {
    // Only the Cookie header goes in: `getToken` would otherwise fall back to `Authorization: Bearer`, which here is an API token.
    const token = await getToken({ req: { headers: { cookie: header } }, cookieName: name, secureCookie: secure, salt: name, secret: secrets, raw: true });
    if (!token) continue;
    try {
      const payload = await decode({ token, secret: secrets, salt: name });
      if (payload) continue;
      return { names: sessionCookieNames(header, name), secure, reason: "empty payload" };
    } catch (err) {
      return { names: sessionCookieNames(header, name), secure, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return null;
}

/** Set-Cookie attributes that expire a session cookie; mirrors Auth.js's own cookie options so the browser matches it. */
export function clearingCookie(name: string, secure: boolean) {
  return { name, value: "", path: "/", maxAge: 0, expires: new Date(0), httpOnly: true, sameSite: "lax" as const, secure };
}

/**
 * Auth.js `logger.error`: a session token the current secret cannot read is one quiet warn line
 * (the proxy clears the cookie; this only fires on a path the proxy does not cover, e.g. `/api/auth/*`).
 * Every other error keeps the default `[auth][error]` format with its cause and stack. Auth.js
 * errors carry their class name in `type` (`AuthError`); duck-typed so this module stays free of
 * `next-auth` imports (which need `next/server`) for the proxy and for tests.
 */
export function logAuthError(error: Error): void {
  const type = (error as { type?: string }).type;
  if (type === "JWTSessionError") {
    console.warn(`[auth][warn] ${STALE_SESSION_MESSAGE}`);
    return;
  }
  console.error(`[auth][error] ${type ?? error.name}: ${error.message}`);
  const cause = error.cause;
  if (cause && typeof cause === "object" && "err" in cause && cause.err instanceof Error) {
    const { err, ...data } = cause as { err: Error } & Record<string, unknown>;
    console.error("[auth][cause]:", err.stack);
    console.error("[auth][details]:", JSON.stringify(data, null, 2));
  } else if (error.stack) {
    console.error(error.stack.replace(/.*/, "").substring(1));
  }
}
