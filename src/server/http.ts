import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { getDocumentAccess, type AccessOptions, type DocumentAccess, type SessionUser } from "@/server/documents";
import { resolveApiToken, looksLikeApiToken, scopeSatisfies } from "@/server/tokens";
import type { Role, TokenScope } from "@/server/db/schema";
import { UnrenderableDocumentError } from "@/editor/markdown/renderable";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Extra JSON fields merged into the error body (e.g. sync `status`, `remoteContent`). */
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
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
      const actor = await resolveApiToken(token);
      if (!actor) throw new HttpError(401, "Invalid or revoked API token");
      return { id: actor.id, login: actor.login, name: actor.name, image: actor.image, agent: actor.agent, tokenId: actor.tokenId, scope: actor.scope, documentIds: actor.documentIds };
    }
  }
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    login: session.user.login ?? null,
    name: session.user.name ?? null,
    image: session.user.image ?? null,
  };
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

/** True when the token may see this document (no restriction, or the id is on its list). Sessions see everything. */
export function tokenAllowsDocument(user: Actor | null | undefined, docId: string): boolean {
  if (!user?.documentIds?.length) return true;
  return user.documentIds.includes(docId);
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

/** Wrap a route handler: maps HttpError/zod errors to JSON responses. */
export function handler<T extends unknown[]>(fn: (...args: T) => Promise<Response>) {
  return async (...args: T): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
      if (err instanceof UnrenderableDocumentError) return json({ error: err.message, reason: err.reason }, { status: 422 });
      if (err && typeof err === "object" && "issues" in err) {
        return json({ error: "Invalid request", issues: (err as { issues: unknown }).issues }, { status: 400 });
      }
      console.error(err);
      const message = err instanceof Error ? err.message : "Unexpected error";
      return json({ error: message }, { status: 500 });
    }
  };
}

export async function readJson<T>(req: Request, parse: (data: unknown) => T): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  return parse(body);
}
