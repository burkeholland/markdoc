import { z } from "zod";
import { handler, json, readJson, requireAccess, HttpError } from "@/server/http";
import { addCollaborator, getCollaboratorRole, listCollaborators, removeCollaborator, getUserById, getUserByLogin, type AddCollaboratorResult } from "@/server/documents";
import { activityActor, recordActivity } from "@/server/activity";
import { notifyShare } from "@/server/notifications";
import { listMentionableAgents } from "@/server/agents";
import { changeCollaboratorAccess } from "@/server/collab/authorization";
import { warnTail } from "@/server/warnings";
import { GITHUB_LOGIN_MAX_LENGTH, GITHUB_LOGIN_RE } from "@/lib/github-login";

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
  // One leading `@` is dropped before the handle is measured, so `@` + 39 characters is a 39-character
  // handle (#2252 item 2). The Share dialog's `isValidLogin` applies the same steps in the same order.
  login: z
    .string()
    .trim()
    .transform((value) => value.replace(/^@/, ""))
    // No min(1): the pattern already needs one character, so an empty handle and a lone `@` get the same one message.
    .pipe(z.string().max(GITHUB_LOGIN_MAX_LENGTH).regex(GITHUB_LOGIN_RE, "Enter a GitHub handle")),
  role: z.enum(["editor", "commenter", "viewer"]),
  /** "I mean to set this role even if the person already has another one." Only a real boolean counts. */
  change: z.boolean().optional(),
});

/** `409`: the person keeps `role`; nothing was written, recorded or sent. `code` is stable for callers. */
function alreadyCollaborator(login: string, role: string): HttpError {
  return new HttpError(409, `${login} already has access as ${role}. Send change: true to change the role.`, { code: "already-collaborator", login, role });
}

/**
 * Add a person by GitHub handle. The handle is stored as given; when nobody with that login has signed in
 * yet the answer is `202 { pending: true }` (access applies on their first sign-in) so callers can tell a
 * typo from a real share.
 *
 * An add never changes a role (#2252). For a login that already has access:
 * - the same role answers as a first add would and writes nothing (no activity row, no notification);
 * - another role is `409 { error, code: "already-collaborator", login, role }` (`role` is the one they keep)
 *   and nothing changes: no row, no activity, no notification, live connections untouched;
 * - `change: true` sets the role whether or not the person had access (what this route always did before).
 */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc, user } = await requireAccess(id, "own");
  const body = await readJson(req, (d) => addSchema.parse(d));
  const owner = await getUserById(doc.ownerId);
  const login = body.login.toLowerCase();
  if (owner?.login?.toLowerCase() === login) throw new HttpError(400, "That is the owner");
  const known = await getUserByLogin(login);
  const added = { ok: true, login, role: body.role, pending: !known };
  const status = known ? 200 : 202;

  // Decided before `changeCollaboratorAccess`, which pauses the person's live connections while it runs: a
  // request that changes nothing must not touch them. This read is only a shortcut; the statement inside
  // `addCollaborator` decides again, atomically, so a request racing this one cannot slip a role change through.
  const current = await getCollaboratorRole(id, login);
  if (current === body.role) return json(added, { status });
  if (current && !body.change) throw alreadyCollaborator(login, current);

  let write!: AddCollaboratorResult;
  await changeCollaboratorAccess(id, login, body.role, async () => {
    write = await addCollaborator(id, login, body.role, user!.id, { change: body.change });
    // Lost a race to another add of the same login: thrown here so the transition restores the connections it paused.
    if (write.outcome === "refused") throw alreadyCollaborator(login, write.role);
  });
  // The statement found the role already in place (another request wrote it first): nothing to record or send.
  if (write.outcome !== "written") return json(added, { status });
  // The access is granted (the row is written and live connections re-resolved, irrevocable): an activity row or
  // share notification that fails here is logged and reported as a warning code on the 2xx — never a non-2xx that
  // would claim nothing changed (the owner's UI showed an error for a share that had happened).
  const { tail, answer } = warnTail("collaborators");
  await tail("activity-not-recorded", () => recordActivity(id, activityActor(user!), "share.add", { login, role: body.role }));
  await tail("notification-not-sent", () => notifyShare(id, login, body.role, { login: user!.login ?? null, name: user!.name ?? user!.login ?? null }));
  return json(answer(added), { status });
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
  const { tail, answer } = warnTail("collaborators");
  await tail("activity-not-recorded", () => recordActivity(id, activityActor(user!), "share.remove", { login }));
  return json(answer({ ok: true }));
});
