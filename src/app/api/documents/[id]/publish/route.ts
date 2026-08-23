import { z } from "zod";
import { handler, json, readJson, requireAccess } from "@/server/http";
import { publishDocument } from "@/server/publish";
import { publicDocument } from "@/server/dto";
import { getDocumentAccess } from "@/server/documents";
import { activityActor, recordActivity } from "@/server/activity";

type Params = { params: Promise<{ id: string }> };

const schema = z.object({ message: z.string().trim().max(500).optional() });

export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc, user } = await requireAccess(id, "edit");
  const body = await readJson(req, (d) => schema.parse(d ?? {}));
  const result = await publishDocument(doc, user!, body.message);
  if (!result.skipped) {
    await recordActivity(id, activityActor(user!), "publish", { storage: doc.storage, commitSha: result.commitSha, message: body.message ?? null });
  }
  const fresh = await getDocumentAccess(id, user);
  return json({ result, document: fresh ? publicDocument(fresh.doc) : null });
});
