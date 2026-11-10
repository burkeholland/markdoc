import { z } from "zod";
import { handler, HttpError, json, readJson, requireUser, currentUser } from "@/server/http";
import { deleteFolder, FOLDER_NAME_MAX, getFolderAccess, getFolderForOwner, listDocumentsInFolder, renameFolder, setFolderLinkAccess } from "@/server/folders";
import { folderDto } from "@/server/dto";

type Params = { params: Promise<{ id: string }> };

const body = z.object({ name: z.string().trim().min(1).max(FOLDER_NAME_MAX).optional(), linkAccess: z.enum(["private", "view", "comment", "edit"]).optional() })
  .refine((value) => (value.name !== undefined) !== (value.linkAccess !== undefined), "Choose either a name or link access");

/** A read-scoped API token may look at folders but not change them, as with documents. */
function requireFullScope(scope: string | undefined): void {
  if (scope && scope !== "full") throw new HttpError(403, "This token may not change folders");
}

/** Rename a folder. `404` for a folder the caller does not own, `409` for a name they already use. */
export const PATCH = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  requireFullScope(user.scope);
  if (user.documentIds?.length) throw new HttpError(403, "This token is restricted to other documents");
  const { name, linkAccess } = await readJson(req, (d) => body.parse(d));
  if (linkAccess !== undefined) {
    if (!(await getFolderForOwner(id, user.id))) throw new HttpError(404, "No such folder");
    const folder = await setFolderLinkAccess(id, user.id, linkAccess);
    if (!folder) throw new HttpError(404, "No such folder");
    return json({ folder: folderDto({ ...folder, documentCount: 0 }) });
  }
  if (name === undefined) throw new HttpError(400, "A folder needs a name");
  const result = await renameFolder(id, user.id, name);
  if (result.outcome === "empty-name") throw new HttpError(400, "A folder needs a name");
  if (result.outcome === "duplicate-name") throw new HttpError(409, "You already have a folder with that name");
  if (result.outcome === "not-found") throw new HttpError(404, "No such folder");
  return json({ folder: folderDto({ ...result.folder, documentCount: 0 }) });
});

/**
 * Delete a folder. Its documents go to the trash, where they are purged after 30 days exactly as a
 * document deleted on its own is — nothing is destroyed here (#2377). `200 { trashed }` says how many
 * moved, so the dashboard can name the number.
 */
export const DELETE = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  requireFullScope(user.scope);
  if (user.documentIds?.length) throw new HttpError(403, "This token is restricted to other documents");
  const trashed = await deleteFolder(id, user.id);
  if (trashed === null) throw new HttpError(404, "No such folder");
  return json({ ok: true, trashed });
});

/** One owned or shared folder, for a deep link to it. */
export const GET = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const user = await currentUser();
  if (user?.documentIds?.length) throw new HttpError(403, "This token is restricted to other documents");
  const access = await getFolderAccess(id, user);
  if (!access) throw new HttpError(404, "No such folder");
  const documents = await listDocumentsInFolder(id, user);
  return json({ folder: folderDto(access.folder), documents: documents.map((document) => ({ ...document, updatedAt: document.updatedAt.toISOString() })) });
});
