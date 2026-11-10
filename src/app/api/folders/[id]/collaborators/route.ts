import { z } from "zod";
import { GITHUB_LOGIN_MAX_LENGTH, GITHUB_LOGIN_RE } from "@/lib/github-login";
import { changeFolderCollaboratorAccess } from "@/server/collab/authorization";
import { handler, HttpError, json, readJson, requireUser } from "@/server/http";
import {
  addFolderCollaborator,
  getFolderCollaboratorRole,
  getFolderForOwner,
  listFolderCollaborators,
  removeFolderCollaborator,
  folderAccessExceptions,
} from "@/server/folders";
import { getUserById, getUserByLogin } from "@/server/documents";
import { notifyFolderShare } from "@/server/notifications";
import { warnTail } from "@/server/warnings";

type Params = { params: Promise<{ id: string }> };

function requireUnrestrictedDocumentSet(documentIds: string[] | null | undefined): void {
  if (documentIds?.length) throw new HttpError(403, "This token is restricted to other documents");
}

function requireFullScope(user: { scope?: string; documentIds?: string[] | null }): void {
  if (user.scope && user.scope !== "full") throw new HttpError(403, "This token may not change folder sharing");
  requireUnrestrictedDocumentSet(user.documentIds);
}

const addSchema = z.object({
  login: z
    .string()
    .trim()
    .transform((value) => value.replace(/^@/, ""))
    .pipe(z.string().max(GITHUB_LOGIN_MAX_LENGTH).regex(GITHUB_LOGIN_RE, "Enter a GitHub handle")),
  role: z.enum(["editor", "commenter", "viewer"]),
  change: z.boolean().optional(),
});

const removeSchema = z.object({ login: z.string().trim().min(1) });

function alreadyCollaborator(login: string, role: string): HttpError {
  return new HttpError(409, `${login} already has access as ${role}. Send change: true to change the role.`, {
    code: "already-collaborator",
    login,
    role,
  });
}

export const GET = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  requireUnrestrictedDocumentSet(user.documentIds);
  const folder = await getFolderForOwner(id, user.id);
  if (!folder) throw new HttpError(404, "No such folder");
  const [owner, collaborators] = await Promise.all([getUserById(folder.ownerId), listFolderCollaborators(id)]);
  return json({
    owner: owner ? { login: owner.login, name: owner.name, image: owner.image } : null,
    collaborators: collaborators.map((collaborator) => ({ ...collaborator, createdAt: collaborator.createdAt.toISOString() })),
    linkAccess: folder.linkAccess,
    exceptions: await folderAccessExceptions(folder, collaborators),
  });
});

export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  requireFullScope(user);
  const folder = await getFolderForOwner(id, user.id);
  if (!folder) throw new HttpError(404, "No such folder");
  const body = await readJson(req, (data) => addSchema.parse(data));
  const login = body.login.toLowerCase();
  const owner = await getUserById(folder.ownerId);
  if (owner?.login?.toLowerCase() === login) throw new HttpError(400, "That is the owner");
  const known = await getUserByLogin(login);
  const added = { ok: true, login, role: body.role, pending: !known };
  const status = known ? 200 : 202;
  const current = await getFolderCollaboratorRole(id, login);
  if (current === body.role) return json(added, { status });
  if (current && !body.change) throw alreadyCollaborator(login, current);

  let write!: Awaited<ReturnType<typeof addFolderCollaborator>>;
  await changeFolderCollaboratorAccess(id, login, body.role, async () => {
    write = await addFolderCollaborator(id, login, body.role, user.id, { change: body.change });
    if (write.outcome === "refused") throw alreadyCollaborator(login, write.role);
  });
  if (write.outcome !== "written") return json(added, { status });
  const { tail, answer } = warnTail("folder-collaborators");
  if (!current) await tail("notification-not-sent", () => notifyFolderShare(id, login, body.role, user));
  return json(answer(added), { status });
});

export const DELETE = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  requireFullScope(user);
  const folder = await getFolderForOwner(id, user.id);
  if (!folder) throw new HttpError(404, "No such folder");
  const body = await readJson(req, (data) => removeSchema.parse(data));
  const login = body.login.replace(/^@/, "").toLowerCase();
  let removed = false;
  await changeFolderCollaboratorAccess(id, login, null, async () => {
    removed = await removeFolderCollaborator(id, login);
  });
  if (!removed) throw new HttpError(404, "Folder collaborator not found");
  return json({ ok: true });
});
