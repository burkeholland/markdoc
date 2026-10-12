import { z } from "zod";
import { handler, HttpError, json, readJson, requireUser } from "@/server/http";
import { createFolder, FOLDER_NAME_MAX, listFoldersForUser } from "@/server/folders";
import { folderDto } from "@/server/dto";

const body = z.object({ name: z.string().trim().min(1).max(FOLDER_NAME_MAX) });

/**
 * Folders are personal: a folder belongs to one user and carries no access of its own, so these
 * routes need only a signed-in caller — never a document access check. Sharing is #2380.
 *
 * A read-scoped API token may list folders but not change them, matching the document routes.
 */
function requireFullScope(scope: string | undefined): void {
  if (scope && scope !== "full") throw new HttpError(403, "This token may not change folders");
}

/** Every folder of the caller, by name, each with how many live documents it holds. */
export const GET = handler(async () => {
  const user = await requireUser();
  return json({ folders: (await listFoldersForUser(user.id)).map(folderDto) });
});

/** `201 { folder }`, or `409` when the caller already has a folder of that name. */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  requireFullScope(user.scope);
  const { name } = await readJson(req, (d) => body.parse(d));
  const result = await createFolder(user.id, name);
  if (result.outcome === "empty-name") throw new HttpError(400, "A folder needs a name");
  if (result.outcome === "duplicate-name") throw new HttpError(409, "You already have a folder with that name");
  return json({ folder: folderDto({ ...result.folder, documentCount: 0 }) }, { status: 201 });
});
