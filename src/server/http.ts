import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { getDocumentAccess, type AccessOptions, type DocumentAccess, type SessionUser } from "@/server/documents";
import { resolveApiToken, resolveApiTokenById, looksLikeApiToken, scopeSatisfies } from "@/server/tokens";
import type { Role, TokenScope } from "@/server/db/schema";
import { UnrenderableDocumentError } from "@/editor/markdown/renderable";
import { failedAuthAllowed, rateLimitingEnabled, recordFailedAuth, takeApiRequest, withRateLimitHeaders, type TakeResult } from "@/server/rate-limit";
import { decodeEmbedSession } from "@/server/session-cookie";
import { mcpPublicOrigin } from "@/server/mcp-origin";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Extra JSON fields merged into the error body (e.g. sync `status`, `remoteContent`). */
    public details?: Record<string, unknown>,
    /** Extra response headers (e.g. `Retry-After`). */
    public headers?: Record<string, string>,
  ) {
    super(message);
  }
}

/** `429 { error, retryAfter }` with `Retry-After`; thrown by the limiter in `handler()` and by failed-token lockout. */
export class RateLimitError extends HttpError {
  constructor(what: string, result: TakeResult) {
    super(429, `${what} Retry in ${result.retryAfter} s.`, { retryAfter: result.retryAfter }, {
      "Retry-After": String(result.retryAfter),
      "X-RateLimit-Limit": String(result.limit),
      "X-RateLimit-Remaining": "0",
    });
  }
}

/**
 * Resolve a bearer token, counting misses per IP: after too many wrong tokens from one address the
 * lookup is refused with `429` before touching the database.
 */
export async function resolveBearer(token: string, h: Headers) {
  if (rateLimitingEnabled()) {
    const budget = failedAuthAllowed(h);
    if (!budget.ok) throw new RateLimitError("Too many failed authentication attempts.", budget);
  }
  const actor = await resolveApiToken(token);
  if (!actor && rateLimitingEnabled()) recordFailedAuth(h);
  return actor;
}

/** The caller: a signed-in user, or a user acting through an API token (then `agent` is set). */
export interface Actor extends SessionUser {
  agent?: string;
  /** Id of the API token when acting as an agent. */
  tokenId?: string;
  /** The token's scope when acting as an agent; a browser session has none (full access). */
  scope?: TokenScope;
  /** Documents the token is restricted to; null/undefined = all of the user's documents. */
  documentIds?: string[] | null;
  /** Set only for a token-backed canvas cookie. */
  embedDocumentId?: string;
  /** Exact canvas-shell origin allowed to frame and renew this embedded session. */
  embedParentOrigin?: string;
  /** Browser-session expiry in epoch milliseconds; the embedded editor renews before this time. */
  embedSessionExpiresAt?: number;
  /** API-token expiry, retained so collaboration sockets cannot outlive it. */
  tokenExpiresAt?: Date | null;
  /** The token's owner switch (other users may address requests to it); only set when acting as an agent. */
  collaboratorsMayAsk?: boolean;
}

/**
 * Resolve the caller from an `Authorization: Bearer mdk_…` token first, then from the
 * session cookie. Tokens let agents and scripts act on a user's behalf.
 */
export async function currentUser(): Promise<Actor | null> {
  const h = await headers();
  const authorization = h.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice(7).trim();
    if (looksLikeApiToken(token)) {
      const actor = await resolveBearer(token, h);
      if (!actor) throw new HttpError(401, "Invalid or revoked API token");
      return { id: actor.id, login: actor.login, name: actor.name, image: actor.image, agent: actor.agent, tokenId: actor.tokenId, scope: actor.scope, documentIds: actor.documentIds, tokenExpiresAt: actor.expiresAt, collaboratorsMayAsk: actor.collaboratorsMayAsk };
    }
  }
  const session = await auth();
  const normalSession = session?.user?.id ? session.user : null;
  if (normalSession) {
    return {
      id: normalSession.id,
      login: normalSession.login ?? null,
      name: normalSession.name ?? null,
      image: normalSession.image ?? null,
    };
  }
  const embed = await decodeEmbedSession(h.get("cookie"));
  if (embed) {
    const actor = await resolveApiTokenById(embed.tokenId);
    if (!actor || actor.id !== embed.userId || !tokenAllowsDocument(actor, embed.documentId)) return null;
    return {
      ...actor,
      documentIds: [embed.documentId],
      embedDocumentId: embed.documentId,
      embedParentOrigin: embed.parentOrigin,
      embedSessionExpiresAt: embed.expiresAt,
      tokenExpiresAt: actor.expiresAt,
    };
  }
  return null;
}

/** Bound editor path for an embed-only browser; a primary Auth.js session always keeps precedence. */
export async function embeddedDocumentPath(primaryUserId: string | null | undefined): Promise<string | null> {
  if (primaryUserId) return null;
  const user = await currentUser();
  return user?.embedDocumentId ? `/d/${user.embedDocumentId}?embed=1` : null;
}

export async function requireUser(): Promise<Actor> {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "Sign in required");
  return user;
}

/** Display name for attribution: "Burke" or "Burke via GitHub Copilot CLI". */
export function actorName(actor: Actor | null | undefined): string | null {
  if (!actor) return null;
  const base = actor.name ?? actor.login ?? "User";
  return actor.agent ? `${base} via ${actor.agent}` : base;
}

type AccessLevel = "view" | "comment" | "edit" | "own";

/** The narrowest token scope that may ask for each access level. */
const SCOPE_FOR_LEVEL: Record<AccessLevel, TokenScope> = { view: "read", comment: "comment", edit: "full", own: "full" };
/** What a token's scope caps the user's role at (`full` does not cap). */
const ROLE_CAP: Record<TokenScope, Role | null> = { read: "viewer", comment: "commenter", full: null };

const SCOPE_VERB: Record<TokenScope, string> = { read: "read documents", comment: "comment and suggest", full: "do everything you can" };

/** The 403 an out-of-scope token gets: says what the token is and where to mint a wider one. */
export function scopeError(scope: TokenScope, needed: TokenScope, action?: string): HttpError {
  const what = action ?? (needed === "full" ? "rewrite documents" : SCOPE_VERB[needed]);
  const wider = needed === "full" ? "full-access" : `${needed} or full-access`;
  return new HttpError(403, `This token is ${scope}-scoped; create a ${wider} token at /settings to ${what}`, { scope, requiredScope: needed });
}

/**
 * Refuse when the caller is a token below `minimum`. Browser sessions always pass. For routes that
 * are not about one document (create, import, GitHub); document routes go through `requireAccess`.
 */
export function requireScope(user: Actor, minimum: TokenScope, action?: string): void {
  if (!user.scope) return;
  if (!scopeSatisfies(user.scope, minimum)) throw scopeError(user.scope, minimum, action);
}

/**
 * Refuse when the caller is a token that may not mint documents: below `full` scope, or restricted to
 * a document list (a new document would sit outside it). Create, import, duplicate and copy-version go through here.
 */
export function requireCanCreateDocuments(user: Actor, action = "create documents"): void {
  requireScope(user, "full", action);
  if (user.documentIds?.length) throw new HttpError(403, `This token is restricted to specific documents; create an unrestricted token at /settings to ${action}`);
}

/** True when the token may see this document (no restriction, or the id is on its list). Sessions see everything. */
export function tokenAllowsDocument(user: Actor | null | undefined, docId: string): boolean {
  if (!user?.documentIds?.length) return true;
  return user.documentIds.includes(docId);
}

/** Access as an embedded token actually experiences it, including document and role caps. */
export async function getEffectiveDocumentAccess(docId: string, user: Actor | null, options: AccessOptions = {}): Promise<DocumentAccess | null> {
  if (user && !tokenAllowsDocument(user, docId)) return null;
  const access = await getDocumentAccess(docId, user, options);
  if (!access || !user?.scope) return access;
  const cap = ROLE_CAP[user.scope];
  return cap && roleRank(cap) < roleRank(access.role) ? { ...access, role: cap } : access;
}

export interface RequireAccessOptions extends AccessOptions {
  /**
   * The scope a token needs for this action when it is narrower than what `minimum` implies: e.g.
   * `suggest` needs an `edit` role from the user but a `comment`-scoped token may propose suggestions.
   */
  tokenScope?: TokenScope;
}

/**
 * Resolve the caller's access to a document. A token narrows what its user could do: documents
 * outside its `documentIds` answer 404 as if they did not exist, and a `read` / `comment` scope
 * lowers the effective role to viewer / commenter (403 with a pointer to /settings when the route
 * asks for more). Browser sessions are untouched.
 */
export async function requireAccess(
  docId: string,
  minimum: AccessLevel = "view",
  options: RequireAccessOptions = {},
): Promise<DocumentAccess & { user: Actor | null }> {
  const { tokenScope, ...accessOptions } = options;
  const user = await currentUser();
  if (user && !tokenAllowsDocument(user, docId)) throw new HttpError(404, "Document not found");
  const access = await getDocumentAccess(docId, user, accessOptions);
  if (!access) throw new HttpError(user ? 404 : 401, user ? "Document not found" : "Sign in required");
  if (user?.scope) {
    const needed = tokenScope ?? SCOPE_FOR_LEVEL[minimum];
    if (!scopeSatisfies(user.scope, needed)) throw scopeError(user.scope, needed);
  }
  if (!roleSatisfies(access.role, minimum)) throw new HttpError(403, "You do not have permission to do that");
  const cap = user?.scope ? ROLE_CAP[user.scope] : null;
  const role = cap && roleRank(cap) < roleRank(access.role) ? cap : access.role;
  return { ...access, role, user };
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };
const roleRank = (role: Role) => ROLE_RANK[role];

export function roleSatisfies(role: Role, minimum: AccessLevel): boolean {
  const need = { view: 0, comment: 1, edit: 2, own: 3 }[minimum];
  return ROLE_RANK[role] >= need;
}

export function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

/**
 * Wrap a route handler: maps HttpError/zod errors to JSON responses, and spends one request from
 * the caller's rate-limit bucket first (`429 { error, retryAfter }` when it is empty; every response
 * carries `X-RateLimit-Limit` / `X-RateLimit-Remaining`).
 */
export function handler<T extends unknown[]>(fn: (...args: T) => Promise<Response>) {
  return async (...args: T): Promise<Response> => {
    const req = args[0] instanceof Request ? args[0] : null;
    const budget = req && rateLimitingEnabled() ? takeApiRequest(req) : null;
    const res = await run(fn, args, budget);
    return budget ? withRateLimitHeaders(res, budget) : res;
  };
}

async function run<T extends unknown[]>(fn: (...args: T) => Promise<Response>, args: T, budget: TakeResult | null): Promise<Response> {
  try {
    const req = args[0] instanceof Request ? args[0] : null;
    if (req) requireSameOriginMutation(req);
    if (budget && !budget.ok) throw new RateLimitError("Rate limit exceeded.", budget);
    return await fn(...args);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message, ...(err.details ?? {}) }, { status: err.status, headers: err.headers });
    if (err instanceof UnrenderableDocumentError) return json({ error: err.message, reason: err.reason }, { status: 422 });
    if (err && typeof err === "object" && "issues" in err) {
      return json({ error: "Invalid request", issues: (err as { issues: unknown }).issues }, { status: 400 });
    }
    // Anything else is a bug or an infrastructure failure: a driver's message carries the SQL statement
    // and its bound parameters, so it goes to the log only.
    console.error(err);
    return json({ error: "Unexpected error" }, { status: 500 });
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** `SameSite=None` canvas cookies must not authorize writes initiated by another site. */
export function requireSameOriginMutation(req: Request): void {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return;
  if (req.headers.get("authorization")?.toLowerCase().startsWith("bearer ")) return;
  const fetchSite = req.headers.get("sec-fetch-site")?.toLowerCase();
  const origin = req.headers.get("origin");
  if (fetchSite === "cross-site" || origin === "null" || (origin && origin !== mcpPublicOrigin(req))) {
    throw new HttpError(403, "Cross-site browser mutations are not allowed");
  }
}

export const NUL_MESSAGE = "Text may not contain NUL characters";

/** True when `s` can be stored in a Postgres `text` column (no U+0000). For zod `.refine()` on query strings. */
export const nulFree = (s: string) => !s.includes("\0");

/** A zod-shaped validation failure (`handler()` answers `400 { error: "Invalid request", issues }`). */
export class ValidationError extends Error {
  constructor(public issues: { path: (string | number)[]; message: string; code?: string }[]) {
    super(issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
}

/** Paths of every string in `value` that contains a NUL character, depth-first. */
export function nulPaths(value: unknown, path: (string | number)[] = [], out: (string | number)[][] = []): (string | number)[][] {
  if (typeof value === "string") {
    if (!nulFree(value)) out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => nulPaths(v, [...path, i], out));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) nulPaths(v, [...path, k], out);
  }
  return out;
}

/**
 * Parse a JSON body. Any string anywhere in it that contains U+0000 is refused up front as
 * `400 { issues: [{ path, message }] }`: Postgres `text` columns cannot hold NUL, so letting one
 * through would fail the insert after earlier steps (the live document, a comment thread) had already
 * been written, and the driver's error would carry the statement and its parameters.
 */
export async function readJson<T>(req: Request, parse: (data: unknown) => T): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  const nuls = nulPaths(body);
  if (nuls.length) throw new ValidationError(nuls.map((path) => ({ code: "custom", path, message: NUL_MESSAGE })));
  return parse(body);
}
