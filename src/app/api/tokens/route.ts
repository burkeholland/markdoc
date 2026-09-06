import { z } from "zod";
import type { TokenScope } from "@/server/db/schema";
import { handler, json, readJson, requireUser, HttpError } from "@/server/http";
import { AgentMentionConflictError, createApiToken, isAgentMentionUnique, listApiTokens, serializeApiTokenMetadata, TOKEN_SCOPES } from "@/server/tokens";
import { getDocumentAccess } from "@/server/documents";
import { noStore } from "./no-store";

/** List your API tokens. Sessions only: a leaked token must not be able to enumerate its siblings. */
export const GET = noStore(handler(async (req: Request) => {
  const user = await requireUser();
  if (user.agent) throw new HttpError(403, "API tokens can only be listed from a signed-in browser session");
  const includeRevoked = new URL(req.url).searchParams.get("includeRevoked") === "true";
  const tokens = await listApiTokens(user.id, includeRevoked);
  return json({ tokens: tokens.map(serializeApiTokenMetadata) });
}));

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  /** `read` (GET, watch, presence), `comment` (+ comments, suggestions, reviews, requests) or `full` (everything you can do). Omitted = `full`, today's behaviour; the Settings dialog defaults to `comment`. */
  scope: z.enum(TOKEN_SCOPES as [string, ...string[]]).optional(),
  /** Restrict the token to these documents (ids you can see); null or omitted = all. */
  documentIds: z.array(z.string().trim().min(1).max(64)).min(1, "Select at least one document when restricting a token").max(200).nullable().optional(),
});

/** Create a personal access token. The secret is returned once. Sessions only (a token cannot mint tokens). */
export const POST = noStore(handler(async (req: Request) => {
  const user = await requireUser();
  if (user.agent) throw new HttpError(403, "API tokens can only be created from a signed-in browser session");
  const body = await readJson(req, (d) => createSchema.parse(d));
  const documentIds = body.documentIds == null ? null : Array.from(new Set(body.documentIds));
  // Only documents the user can actually see: a restriction is not a way to name documents you do not have.
  for (const id of documentIds ?? []) {
    if (!(await getDocumentAccess(id, user))) throw new HttpError(404, `Document not found: ${id}`);
  }
  if (!(await isAgentMentionUnique(user.id, null, body.name))) {
    throw new HttpError(409, "Another active token has the same @mention name; choose a distinct token name");
  }
  let created;
  try {
    created = await createApiToken(user.id, body.name, { expiresInDays: body.expiresInDays ?? null, scope: (body.scope as TokenScope | undefined) ?? "full", documentIds });
  } catch (error) {
    if (error instanceof AgentMentionConflictError) throw new HttpError(409, `${error.message}; choose a distinct token name`);
    throw error;
  }
  return json(
    { token: { ...created, createdAt: created.createdAt.toISOString(), expiresAt: created.expiresAt?.toISOString() ?? null, revokedAt: created.revokedAt?.toISOString() ?? null } },
    { status: 201 },
  );
}));
