import { handler, json, requireAccess, requireCanCreateDocuments, HttpError } from "@/server/http";
import { duplicateDocument, getVersion } from "@/server/documents";

type Params = { params: Promise<{ id: string; vid: string }> };

/**
 * "Copy version as new document": like `POST /api/documents/:id/duplicate`, but the new document
 * holds this version's text and is titled "Copy of <title> (v<n>)". Anyone who can view may copy;
 * a token needs full scope and no document restriction, as for duplicate.
 */
export const POST = handler(async (_req: Request, { params }: Params) => {
  const { id, vid } = await params;
  const { user } = await requireAccess(id, "view");
  if (!user) throw new HttpError(401, "Sign in required");
  requireCanCreateDocuments(user, "copy documents");
  const version = await getVersion(id, vid);
  if (!version) throw new HttpError(404, "Version not found");
  const doc = await duplicateDocument(id, user.id, {
    content: version.content,
    titleSuffix: ` (v${version.number})`,
    versionTitle: version.title ? `Copied from v${version.number} “${version.title}”` : `Copied from v${version.number}`,
  });
  return json({ id: doc.id, title: doc.title }, { status: 201 });
});
