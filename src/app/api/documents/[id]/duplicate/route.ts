import { handler, json, requireAccess, HttpError } from "@/server/http";
import { duplicateDocument } from "@/server/documents";

type Params = { params: Promise<{ id: string }> };

/**
 * "Make a copy": a new document owned by the caller with the current clean text. Anyone who can
 * view the document may copy it; the copy is always a Markdoc document (GitHub links are not carried over).
 */
export const POST = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const { user } = await requireAccess(id, "view");
  if (!user) throw new HttpError(401, "Sign in required");
  const doc = await duplicateDocument(id, user.id);
  return json({ id: doc.id, title: doc.title }, { status: 201 });
});
