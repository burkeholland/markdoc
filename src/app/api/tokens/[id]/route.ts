import { z } from "zod";
import { handler, json, readJson, requireUser, HttpError } from "@/server/http";
import { revokeApiToken, setCollaboratorsMayAsk } from "@/server/tokens";

type Params = { params: Promise<{ id: string }> };

export const DELETE = handler(async (_req: Request, { params }: Params) => {
  const user = await requireUser();
  if (user.agent) throw new HttpError(403, "API tokens can only be revoked from a signed-in browser session");
  const { id } = await params;
  const ok = await revokeApiToken(user.id, id);
  if (!ok) throw new HttpError(404, "Token not found");
  return json({ ok: true });
});

const patchSchema = z.object({
  /** Owner switch: let other users address requests to this agent (`@you/slug`). Off = only you can ask it. */
  collaboratorsMayAsk: z.boolean(),
});

/** Flip the owner switch on one of your tokens. Sessions only: a token cannot widen who may task it. */
export const PATCH = handler(async (req: Request, { params }: Params) => {
  const user = await requireUser();
  if (user.agent) throw new HttpError(403, "API tokens can only be changed from a signed-in browser session");
  const { id } = await params;
  const body = await readJson(req, (d) => patchSchema.parse(d));
  const token = await setCollaboratorsMayAsk(user.id, id, body.collaboratorsMayAsk);
  if (!token) throw new HttpError(404, "Token not found");
  return json({
    token: {
      ...token,
      createdAt: token.createdAt.toISOString(),
      lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
      lastMcpSeenAt: token.lastMcpSeenAt?.toISOString() ?? null,
      lastMcpCallAt: token.lastMcpCallAt?.toISOString() ?? null,
      expiresAt: token.expiresAt?.toISOString() ?? null,
    },
  });
});
