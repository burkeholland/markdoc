import { z } from "zod";
import { handler, json, readJson, requireAccess, actorName, HttpError } from "@/server/http";
import { boundTitle, deleteDocument, DOCUMENT_TITLE_MAX, purgeDocument, updateDocument } from "@/server/documents";
import { changeLinkAccess } from "@/server/collab/authorization";
import { META_KEY, type CollabContext } from "@/server/collab/hocuspocus";
import { mutateLiveDoc, readLiveDoc } from "@/server/livedoc";
import { activityActor, clip, recordActivity } from "@/server/activity";
import { warnTail } from "@/server/warnings";
import type { Document } from "@/server/db/schema";
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

/**
 * Rename the live document. `meta.title` is authoritative: the editor writes it, `GET /content` reads it and
 * every store copies it over the `title` column (collab/hocuspocus.ts onStoreDocument), so a column-only
 * rename would be undone by the next keystroke or API write. Returns false when the live title already is
 * `title`: then no transaction runs and nothing is stored (a direct connection stores on disconnect even
 * when its transaction changed nothing, hence the read before the write; the re-read inside the callback
 * covers a concurrent rename to the same title).
 */
async function renameLiveDocument(id: string, ctx: CollabContext, title: string): Promise<boolean> {
  if ((await readLiveDoc(id, (doc) => doc.getMap(META_KEY).get("title"))) === title) return false;
  let renamed = false;
  await mutateLiveDoc(id, ctx, (doc) => {
    const meta = doc.getMap(META_KEY);
    if (meta.get("title") === title) return;
    meta.set("title", title);
    renamed = true;
  });
  return renamed;
}

export const PATCH = handler(async (req: Request, { params }: Params) => {
  const warn = warnTail("documents");
  const { id } = await params;
  const body = await readJson(req, (d) => patchSchema.parse(d));
  const { doc: current, role, user } = await requireAccess(id, body.linkAccess !== undefined ? "own" : "edit");
  if (!user) throw new HttpError(401, "Sign in required");
  const patch: Partial<Document> = {};
  if (body.linkAccess !== undefined) patch.linkAccess = body.linkAccess;
  if (body.title !== undefined) {
    // Live document first, column second: if the column write fails, the next store heals it from meta.title.
    const title = boundTitle(body.title);
    const renamed = await renameLiveDocument(id, { userId: user.id, docId: id, role, name: actorName(user) ?? "User", login: user.login, avatar: user.image ?? null }, title);
    // The live watcher attributes WebSocket transactions only (activity.ts actorFromOrigin); REST routes record their own rows.
    // The rename has landed in the live document by now, so a failed row is `warnings: ["activity-not-recorded"]`, never a 5xx.
    if (renamed) await warn.tail("activity-not-recorded", () => recordActivity(id, activityActor(user), "title.change", { title: clip(title) }));
    if (renamed || current.title !== title) patch.title = title;
  }
  if (Object.keys(patch).length === 0) return json(warn.answer({ document: publicDocument(current) }));
  let doc: Document | null = null;
  if (patch.linkAccess !== undefined) {
    // Authoritative for live sockets: visitors admitted by the link are re-resolved (read-only or
    // disconnected) once the change commits, like a collaborator change.
    await changeLinkAccess(id, patch.linkAccess, async () => {
      doc = await updateDocument(id, patch);
    });
  } else {
    doc = await updateDocument(id, patch);
  }
  if (!doc) throw new HttpError(404, "Document not found");
  return json(warn.answer({ document: publicDocument(doc) }));
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
