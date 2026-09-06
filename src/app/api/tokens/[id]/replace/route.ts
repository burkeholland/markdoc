import { z } from "zod";
import { handler, json, readJson, requireUser, HttpError } from "@/server/http";
import { AgentMentionConflictError, ApiTokenExpiredError, replaceApiToken } from "@/server/tokens";
import { noStore } from "../../no-store";

type Params = { params: Promise<{ id: string }> };
const replaceSchema = z.object({ confirm: z.literal(true) }).strict();

export const POST = noStore(handler(async (req: Request, { params }: Params) => {
  const user = await requireUser();
  if (user.agent) throw new HttpError(403, "API tokens can only be replaced from a signed-in browser session");
  const { id } = await params;
  await readJson(req, (body) => replaceSchema.parse(body));
  let token;
  try {
    token = await replaceApiToken(user.id, id);
  } catch (error) {
    if (error instanceof ApiTokenExpiredError) throw new HttpError(409, error.message);
    if (error instanceof AgentMentionConflictError) throw new HttpError(409, `${error.message}; choose a distinct token name`);
    throw error;
  }
  if (!token) throw new HttpError(404, "Token not found");
  return json({
    token: {
      ...token,
      createdAt: token.createdAt.toISOString(),
      expiresAt: token.expiresAt?.toISOString() ?? null,
      revokedAt: token.revokedAt?.toISOString() ?? null,
    },
  }, { status: 201 });
}));
