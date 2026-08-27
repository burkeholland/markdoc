import { z } from "zod";
import { handler, json, readJson, requireAccess, HttpError } from "@/server/http";
import { listCollaborators, removeCollaborator, upsertCollaborator, getUserById, getUserByLogin } from "@/server/documents";
import { activityActor, recordActivity } from "@/server/activity";
import { notifyShare } from "@/server/notifications";
import { listMentionableAgents } from "@/server/agents";
import { changeCollaboratorAccess } from "@/server/collab/authorization";

type Params = { params: Promise<{ id: string }> };

/** Owner, collaborators and the agents that can be @-mentioned here (present now or active in the last 30 days). */
export const GET = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc } = await requireAccess(id, "view");
  const [owner, collaborators, agents] = await Promise.all([getUserById(doc.ownerId), listCollaborators(id), listMentionableAgents(id)]);
  return json({
    owner: owner ? { login: owner.login, name: owner.name, image: owner.image } : null,
    linkAccess: doc.linkAccess,
    collaborators: collaborators.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
    agents,
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

/**
 * Add or change a person by GitHub handle. The handle is stored as given; when nobody with that
 * login has signed in yet the answer is `202 { pending: true }` (access applies on their first
 * sign-in) so callers can tell a typo from a real share.
 */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc, user } = await requireAccess(id, "own");
  const body = await readJson(req, (d) => addSchema.parse(d));
  const owner = await getUserById(doc.ownerId);
  const login = body.login.replace(/^@/, "").toLowerCase();
  if (owner?.login?.toLowerCase() === login) throw new HttpError(400, "That is the owner");
  const known = await getUserByLogin(login);
  await changeCollaboratorAccess(id, login, body.role, async () => {
    await upsertCollaborator(id, login, body.role, user!.id);
  });
  await recordActivity(id, activityActor(user!), "share.add", { login, role: body.role });
  await notifyShare(id, login, body.role, { login: user!.login ?? null, name: user!.name ?? user!.login ?? null });
  return json({ ok: true, login, role: body.role, pending: !known }, { status: known ? 200 : 202 });
});

const removeSchema = z.object({ login: z.string().trim().min(1) });

/**
 * Remove a person. Not idempotent on purpose: a login that is not currently a collaborator is
 * `404 { error: "Collaborator not found" }` and records nothing, so a removal that "succeeded"
 * always means a share actually ended.
 */
export const DELETE = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { user } = await requireAccess(id, "own");
  const body = await readJson(req, (d) => removeSchema.parse(d));
  const login = body.login.replace(/^@/, "").toLowerCase();
  let removed = false;
  await changeCollaboratorAccess(id, login, null, async () => {
    removed = await removeCollaborator(id, login);
  });
  if (!removed) throw new HttpError(404, "Collaborator not found");
  await recordActivity(id, activityActor(user!), "share.remove", { login });
  return json({ ok: true });
});
