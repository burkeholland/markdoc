import { z } from "zod";
import { handler, json, readJson, requireUser, HttpError } from "@/server/http";
import { AgentMentionConflictError, revokeApiToken, serializeApiTokenMetadata, updateApiToken } from "@/server/tokens";
import { noStore } from "../no-store";

type Params = { params: Promise<{ id: string }> };

export const DELETE = noStore(handler(async (_req: Request, { params }: Params) => {
  const user = await requireUser();
  if (user.agent) throw new HttpError(403, "API tokens can only be revoked from a signed-in browser session");
  const { id } = await params;
  const ok = await revokeApiToken(user.id, id);
  if (!ok) throw new HttpError(404, "Token not found");
  return json({ ok: true });
}));

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  /** Owner switch: let other users address requests to this agent (`@you/slug`). Off = only you can ask it. */
  collaboratorsMayAsk: z.boolean().optional(),
}).strict().refine((body) => body.name !== undefined || body.collaboratorsMayAsk !== undefined, {
  message: "Provide a token name or collaboratorsMayAsk",
});

/** Rename or flip the owner switch. Sessions only: a token cannot widen who may task it. */
export const PATCH = noStore(handler(async (req: Request, { params }: Params) => {
  const user = await requireUser();
  if (user.agent) throw new HttpError(403, "API tokens can only be changed from a signed-in browser session");
  const { id } = await params;
  const body = await readJson(req, (d) => patchSchema.parse(d));
  let token;
  try {
    token = await updateApiToken(user.id, id, body);
  } catch (error) {
    if (error instanceof AgentMentionConflictError) throw new HttpError(409, `${error.message}; choose a distinct token name`);
    throw error;
  }
  if (!token) throw new HttpError(404, "Token not found");
  return json({ token: serializeApiTokenMetadata(token) });
}));
