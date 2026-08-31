import { handler, json, requireAccess } from "@/server/http";
import { pullDocument, withWarnings } from "@/server/publish";
import { publicDocument } from "@/server/dto";
import { getDocumentAccess } from "@/server/documents";

type Params = { params: Promise<{ id: string }> };

/**
 * Pull GitHub's copy. Refuses with `409 { status: "local-ahead" | "diverged", remoteContent }` when
 * local edits would be lost; `?merge=1` three-way merges a diverged document (conflicts → `409
 * { status: "conflict", merged, conflicts }`); `?force=1` replaces the local text regardless.
 *
 * `200 { result, document, warnings? }`: `warnings: ["version-not-saved"]` when the text was replaced
 * and the base recorded but the version row could not be written; absent otherwise.
 */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc, user } = await requireAccess(id, "edit");
  const q = new URL(req.url).searchParams;
  const { warnings, ...result } = await pullDocument(doc, user!, { force: q.get("force") === "1", merge: q.get("merge") === "1" });
  const fresh = await getDocumentAccess(id, user);
  return json({ result, document: fresh ? publicDocument(fresh.doc) : null, ...withWarnings(warnings) });
});