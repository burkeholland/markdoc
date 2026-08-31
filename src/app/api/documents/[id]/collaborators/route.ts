import { z } from "zod";
import { handler, json, readJson, requireAccess, HttpError } from "@/server/http";
import { listCollaborators, removeCollaborator, upsertCollaborator, getUserById, getUserByLogin } from "@/server/documents";
import { activityActor, recordActivity } from "@/server/activity";
import { notifyShare } from "@/server/notifications";
import { listMentionableAgents } from "@/server/agents";
import { changeCollaboratorAccess } from "@/server/collab/authorization";

type Params = { params: Promise<{ id: string }> };

/** Post-write side effects that can fail without taking the share change back: reported as `warnings` on the 2xx (see docs/agents.md). */
type Warning = "activity-not-recorded" | "notification-not-sent";

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
  // The access is granted (the row is written and live connections re-resolved, irrevocable): an activity row or
  // share notification that fails here is logged and reported as a warning code on the 2xx — never a non-2xx that
  // would claim nothing changed (the owner's UI showed an error for a share that had happened).
  const failed: Warning[] = [];
  const tail = async (code: Warning, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (err) {
      console.error(`[collaborators] ${code}`, err);
      failed.push(code);
      return false;
    }
  };
  await tail("activity-not-recorded", () => recordActivity(id, activityActor(user!), "share.add", { login, role: body.role }));
  await tail("notification-not-sent", () => notifyShare(id, login, body.role, { login: user!.login ?? null, name: user!.name ?? user!.login ?? null }));
  const result = { ok: true, login, role: body.role, pending: !known };
  return json(failed.length ? { ...result, warnings: failed } : result, { status: known ? 200 : 202 });
});

const removeSchema = z.object({ login: z.string().trim().min(1) });

/**
 * Remove a person. Not idempotent on purpose: a login that is not currently a collaborator is
 * `404 { error: "Collaborator not found" }` and records nothing, so a removal that "succeeded"
 * always means a share actually ended. The 404 is decided before anything is written; once the row
 * is gone the answer is a 2xx, with `warnings: ["activity-not-recorded"]` when the feed row failed
 * (a 500 there made the retry answer 404 for a removal that had happened).
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
  const failed: Warning[] = [];
  const tail = async (code: Warning, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (err) {
      console.error(`[collaborators] ${code}`, err);
      failed.push(code);
      return false;
    }
  };
  await tail("activity-not-recorded", () => recordActivity(id, activityActor(user!), "share.remove", { login }));
  return json(failed.length ? { ok: true, warnings: failed } : { ok: true });
});
