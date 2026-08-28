import { decode, encode, getToken } from "next-auth/jwt";

/**
 * Detect an Auth.js session cookie the current AUTH_SECRET cannot read — left behind by a secret
 * rotation (every rebuild regenerates `.env.local`) or simply garbage — so the proxy can clear it
 * once instead of letting Auth.js log `JWTSessionError` on every request for as long as the browser
 * keeps the cookie. Pure: no Next.js imports, so it is unit-testable and usable from `proxy.ts`.
 */

export const SESSION_COOKIE = "authjs.session-token";
export const SECURE_SESSION_COOKIE = `__Secure-${SESSION_COOKIE}`;
export const EMBED_SESSION_COOKIE = "markdoc.embed-session";
export const SECURE_EMBED_SESSION_COOKIE = `__Secure-${EMBED_SESSION_COOKIE}`;

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

export const EMBED_SESSION_MAX_AGE_S = 5 * 60;

/** The user fields Auth.js's `jwt` callback puts in the session token (see `src/auth.ts`). */
export interface SessionCookieUser {
  id: string;
  login: string | null;
  name: string | null;
  email?: string | null;
  image: string | null;
  /** Present only for a token-backed embed session. */
  embedTokenId?: string;
  /** The only document that token-backed session may access. */
  embedDocumentId?: string;
  /** The loopback canvas origin allowed to frame this session. */
  embedParentOrigin?: string;
}

export interface EmbedSessionClaims {
  userId: string;
  login: string | null;
  name: string | null;
  image: string | null;
  tokenId: string;
  documentId: string;
  parentOrigin: string;
}

/**
 * Mint a short-lived JWE in a dedicated cookie that Auth.js does not treat as the user's primary
 * session. The API layer decodes it explicitly and reapplies the backing token's live restrictions.
 */
export async function mintSessionCookie(user: SessionCookieUser, secure: boolean, secrets: string[] = sessionSecrets(), maxAge = EMBED_SESSION_MAX_AGE_S) {
  if (secrets.length === 0) throw new Error("AUTH_SECRET is not configured");
  if (!user.embedTokenId || !user.embedDocumentId || !user.embedParentOrigin) throw new Error("Embed session claims are required");
  const name = secure ? SECURE_EMBED_SESSION_COOKIE : EMBED_SESSION_COOKIE;
  const value = await encode({
    token: {
      sub: user.id,
      login: user.login,
      name: user.name,
      email: user.email ?? null,
      picture: user.image,
      embedTokenId: user.embedTokenId,
      embedDocumentId: user.embedDocumentId,
      embedParentOrigin: user.embedParentOrigin,
    },
    secret: secrets,
    salt: name,
    maxAge,
  });
  return { name, value, path: "/", maxAge, httpOnly: true, sameSite: secure ? ("none" as const) : ("lax" as const), secure, partitioned: secure };
}

/** Decode the dedicated canvas cookie without exposing it to Auth.js as the user's primary session. */
export async function decodeEmbedSession(cookieHeader: string | null | undefined, secrets: string[] = sessionSecrets()): Promise<EmbedSessionClaims | null> {
  if (!cookieHeader || secrets.length === 0) return null;
  for (const [name, secure] of [
    [SECURE_EMBED_SESSION_COOKIE, true],
    [EMBED_SESSION_COOKIE, false],
  ] as const) {
    const raw = await getToken({ req: { headers: { cookie: cookieHeader } }, cookieName: name, secureCookie: secure, salt: name, secret: secrets, raw: true });
    if (!raw) continue;
    try {
      const payload = await decode({ token: raw, secret: secrets, salt: name });
      if (
        !payload
        || typeof payload.sub !== "string"
        || typeof payload.embedTokenId !== "string"
        || typeof payload.embedDocumentId !== "string"
        || typeof payload.embedParentOrigin !== "string"
        || typeof payload.exp !== "number"
        || payload.exp <= Math.floor(Date.now() / 1000)
      ) {
        continue;
      }
      return {
        userId: payload.sub,
        login: typeof payload.login === "string" ? payload.login : null,
        name: typeof payload.name === "string" ? payload.name : null,
        image: typeof payload.picture === "string" ? payload.picture : null,
        tokenId: payload.embedTokenId,
        documentId: payload.embedDocumentId,
        parentOrigin: payload.embedParentOrigin,
      };
    } catch {
      continue;
    }
  }
  return null;
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
