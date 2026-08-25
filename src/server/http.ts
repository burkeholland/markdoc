import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { getDocumentAccess, type AccessOptions, type DocumentAccess, type SessionUser } from "@/server/documents";
import { resolveApiToken, looksLikeApiToken } from "@/server/tokens";
import type { Role } from "@/server/db/schema";
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
      return { id: actor.id, login: actor.login, name: actor.name, image: actor.image, agent: actor.agent, tokenId: actor.tokenId };
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

export async function requireAccess(
  docId: string,
  minimum: "view" | "comment" | "edit" | "own" = "view",
  options: AccessOptions = {},
): Promise<DocumentAccess & { user: Actor | null }> {
  const user = await currentUser();
  const access = await getDocumentAccess(docId, user, options);
  if (!access) throw new HttpError(user ? 404 : 401, user ? "Document not found" : "Sign in required");
  if (!roleSatisfies(access.role, minimum)) throw new HttpError(403, "You do not have permission to do that");
  return { ...access, user };
}

export function roleSatisfies(role: Role, minimum: "view" | "comment" | "edit" | "own"): boolean {
  const rank: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };
  const need = { view: 0, comment: 1, edit: 2, own: 3 }[minimum];
  return rank[role] >= need;
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
