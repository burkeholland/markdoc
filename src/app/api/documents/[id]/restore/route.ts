import { handler, json, requireAccess, HttpError } from "@/server/http";
import { restoreDocument } from "@/server/documents";
import { publicDocument } from "@/server/dto";

type Params = { params: Promise<{ id: string }> };

/** Take a document out of the trash (owner only). `409` when it is not in the trash. */
export const POST = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc: current } = await requireAccess(id, "own", { allowDeleted: true });
  if (!current.deletedAt) throw new HttpError(409, "Document is not in the trash");
  const doc = await restoreDocument(id);
  if (!doc) throw new HttpError(404, "Document not found");
  return json({ ok: true, document: publicDocument(doc) });
});
