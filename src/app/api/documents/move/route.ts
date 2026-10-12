import { z } from "zod";
import { handler, HttpError, json, readJson, requireUser } from "@/server/http";
import { moveDocumentsToFolder } from "@/server/folders";

/**
 * `folderId: null` moves the documents back to the top level. One route for one document and for a
 * multi-select, so the dashboard has a single call to make either way (#2377).
 *
 * This static segment shadows `/api/documents/[id]` for the literal path `/api/documents/move`,
 * which costs nothing: a document id is 12 characters from `nanoid` (see `documents.ts`), so no
 * document can ever be named `move`.
 */
const body = z.object({
  documentIds: z.array(z.string().trim().min(1)).min(1).max(200),
  folderId: z.string().trim().min(1).nullable(),
});

/**
 * `200 { moved }` lists the ids that actually moved. An id the caller does not own, one already in
 * that folder, or one in the trash is skipped rather than refused, so a mixed selection is not
 * all-or-nothing — the dashboard reconciles against `moved`.
 */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  if (user.scope && user.scope !== "full") throw new HttpError(403, "This token may not move documents");
  const { documentIds, folderId } = await readJson(req, (d) => body.parse(d));
  // A token restricted to some documents may not file the rest of the user's library.
  if (user.documentIds) {
    const allowed = new Set(user.documentIds);
    if (documentIds.some((id) => !allowed.has(id))) throw new HttpError(403, "This token is restricted to other documents");
  }
  const result = await moveDocumentsToFolder(documentIds, folderId, user.id);
  if (result.outcome === "no-folder") throw new HttpError(404, "No such folder");
  return json({ moved: result.moved });
});
