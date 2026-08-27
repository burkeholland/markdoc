import { z } from "zod";
import { handler, json, readJson, requireAccess, HttpError } from "@/server/http";
import { deleteDocument, DOCUMENT_TITLE_MAX, purgeDocument, updateDocument } from "@/server/documents";
import { publicDocument } from "@/server/dto";

type Params = { params: Promise<{ id: string }> };

export const GET = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc, role } = await requireAccess(id, "view");
  return json({ document: publicDocument(doc), role });
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(DOCUMENT_TITLE_MAX).optional(),
  linkAccess: z.enum(["private", "view", "comment", "edit"]).optional(),
});

export const PATCH = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const body = await readJson(req, (d) => patchSchema.parse(d));
  await requireAccess(id, body.linkAccess !== undefined ? "own" : "edit");
  const doc = await updateDocument(id, body);
  if (!doc) throw new HttpError(404, "Document not found");
  return json({ document: publicDocument(doc) });
});

/**
 * Move the document to the trash (owner only). `?permanent=1` removes it for good instead —
 * also for documents already in the trash ("Delete forever").
 */
export const DELETE = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const permanent = /^(1|true)$/.test(new URL(req.url).searchParams.get("permanent") ?? "");
  if (permanent) {
    await requireAccess(id, "own", { allowDeleted: true });
    await purgeDocument(id);
    return json({ ok: true, permanent: true });
  }
  await requireAccess(id, "own");
  await deleteDocument(id);
  return json({ ok: true, permanent: false });
});
