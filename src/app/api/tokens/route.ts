import { z } from "zod";
import { handler, json, readJson, requireUser, HttpError } from "@/server/http";
import { createApiToken, listApiTokens } from "@/server/tokens";

export const GET = handler(async () => {
  const user = await requireUser();
  const tokens = await listApiTokens(user.id);
  return json({
    tokens: tokens.map((t) => ({
      ...t,
      createdAt: t.createdAt.toISOString(),
      lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      lastMcpSeenAt: t.lastMcpSeenAt?.toISOString() ?? null,
      lastMcpCallAt: t.lastMcpCallAt?.toISOString() ?? null,
      expiresAt: t.expiresAt?.toISOString() ?? null,
    })),
  });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
});

/** Create a personal access token. The secret is returned once. Sessions only (a token cannot mint tokens). */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  if (user.agent) throw new HttpError(403, "API tokens can only be created from a signed-in browser session");
  const body = await readJson(req, (d) => createSchema.parse(d));
  const created = await createApiToken(user.id, body.name, body.expiresInDays ?? null);
  return json(
    { token: { ...created, createdAt: created.createdAt.toISOString(), expiresAt: created.expiresAt?.toISOString() ?? null } },
    { status: 201 },
  );
});
