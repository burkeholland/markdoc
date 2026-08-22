import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getDocumentAccess, type DocumentAccess, type SessionUser } from "@/server/documents";
import type { Role } from "@/server/db/schema";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function currentUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    login: session.user.login ?? null,
    name: session.user.name ?? null,
    image: session.user.image ?? null,
  };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "Sign in required");
  return user;
}

export async function requireAccess(docId: string, minimum: "view" | "comment" | "edit" | "own" = "view"): Promise<DocumentAccess & { user: SessionUser | null }> {
  const user = await currentUser();
  const access = await getDocumentAccess(docId, user);
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
      if (err instanceof HttpError) return json({ error: err.message }, { status: err.status });
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
