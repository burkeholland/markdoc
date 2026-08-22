import { handler, json, requireAccess } from "@/server/http";
import { pullDocument } from "@/server/publish";
import { publicDocument } from "@/server/dto";
import { getDocumentAccess } from "@/server/documents";

type Params = { params: Promise<{ id: string }> };

export const POST = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc, user } = await requireAccess(id, "edit");
  const result = await pullDocument(doc, user!);
  const fresh = await getDocumentAccess(id, user);
  return json({ result, document: fresh ? publicDocument(fresh.doc) : null });
});
