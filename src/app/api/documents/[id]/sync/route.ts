import { handler, json, requireAccess } from "@/server/http";
import { syncStatus } from "@/server/publish";

type Params = { params: Promise<{ id: string }> };

/** Three-way sync status against the linked GitHub file; the remote read is cached for 30 s per document. */
export const GET = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc, user } = await requireAccess(id, "view");
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  const status = await syncStatus(doc, user!, { fresh });
  return json(status);
});
