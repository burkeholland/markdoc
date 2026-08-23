import { handler, json, requireAccess, HttpError } from "@/server/http";
import { restoreDocument } from "@/server/documents";
import { publicDocument } from "@/server/dto";

type Params = { params: Promise<{ id: string }> };

/** Take a document out of the trash (owner only). */
export const POST = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  await requireAccess(id, "own", { allowDeleted: true });
  const doc = await restoreDocument(id);
  if (!doc) throw new HttpError(404, "Document not found");
  return json({ ok: true, document: publicDocument(doc) });
});
