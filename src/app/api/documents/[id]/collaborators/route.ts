import { z } from "zod";
import { handler, json, readJson, requireAccess, HttpError } from "@/server/http";
import { listCollaborators, removeCollaborator, upsertCollaborator, getUserById } from "@/server/documents";

type Params = { params: Promise<{ id: string }> };

export const GET = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc } = await requireAccess(id, "view");
  const owner = await getUserById(doc.ownerId);
  const collaborators = await listCollaborators(id);
  return json({
    owner: owner ? { login: owner.login, name: owner.name, image: owner.image } : null,
    linkAccess: doc.linkAccess,
    collaborators: collaborators.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
  });
});

const addSchema = z.object({
  login: z
    .string()
    .trim()
    .min(1)
    .max(39)
    .regex(/^@?[a-zA-Z0-9-]+$/, "Enter a GitHub handle"),
  role: z.enum(["editor", "commenter", "viewer"]),
});

export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc, user } = await requireAccess(id, "own");
  const body = await readJson(req, (d) => addSchema.parse(d));
  const owner = await getUserById(doc.ownerId);
  const login = body.login.replace(/^@/, "").toLowerCase();
  if (owner?.login?.toLowerCase() === login) throw new HttpError(400, "That is the owner");
  await upsertCollaborator(id, login, body.role, user!.id);
  return json({ ok: true, login });
});

const removeSchema = z.object({ login: z.string().trim().min(1) });

export const DELETE = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  await requireAccess(id, "own");
  const body = await readJson(req, (d) => removeSchema.parse(d));
  await removeCollaborator(id, body.login.replace(/^@/, ""));
  return json({ ok: true });
});
