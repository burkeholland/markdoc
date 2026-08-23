import { z } from "zod";
import { handler, json, readJson, requireAccess } from "@/server/http";
import { publishDocument } from "@/server/publish";
import { publicDocument } from "@/server/dto";
import { getDocumentAccess } from "@/server/documents";
import { activityActor, recordActivity } from "@/server/activity";

type Params = { params: Promise<{ id: string }> };

const schema = z.object({ message: z.string().trim().max(500).optional(), force: z.boolean().optional() });

/**
 * Publish the clean text. `409 { status: "remote-ahead" | "diverged", remote, ... }` when GitHub
 * moved since the last sync; `?force=1` (or `{ force: true }`) overwrites anyway.
 */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc, user } = await requireAccess(id, "edit");
  const body = await readJson(req, (d) => schema.parse(d ?? {}));
  const force = body.force === true || new URL(req.url).searchParams.get("force") === "1";
  const result = await publishDocument(doc, user!, { message: body.message, force });
  if (!result.skipped) {
    await recordActivity(id, activityActor(user!), "publish", { storage: doc.storage, commitSha: result.commitSha, message: body.message ?? null, force: force || undefined });
  }
  const fresh = await getDocumentAccess(id, user);
  return json({ result, document: fresh ? publicDocument(fresh.doc) : null });
});