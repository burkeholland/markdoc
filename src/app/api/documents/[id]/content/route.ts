import { z } from "zod";
import { handler, json, readJson, requireAccess, actorName } from "@/server/http";
import { readLiveText, mutateLiveDoc } from "@/server/livedoc";
import { addVersion } from "@/server/documents";
import { diffOps, applyOps } from "@/editor/sync/text-diff";
import { recordAgentActivity } from "@/server/agents";
import { activityActor, recordEdit } from "@/server/activity";
import { TEXT_KEY } from "@/server/collab/hocuspocus";
import { contentHash } from "@/server/export/html";

type Params = { params: Promise<{ id: string }> };

/** Current Markdown of the document (with and without pending suggestions), for agents and scripts. */
export const GET = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  await requireAccess(id, "view");
  const live = await readLiveText(id);
  return json({
    content: live.text,
    clean: live.clean,
    title: live.title,
    /** SHA-256 of `clean`; the reader view polls this to detect changes cheaply. */
    contentHash: contentHash(live.clean),
    pendingSuggestions: live.pendingSuggestions,
    openComments: live.openComments,
  });
});

const putSchema = z.object({
  content: z.string().max(2_000_000),
  /** Optional version title recorded with the change. */
  message: z.string().trim().max(200).optional(),
});

/**
 * Replace the whole document with new Markdown. The change is applied to the live
 * document as a minimal diff, so collaborators see it as a normal edit and keep their
 * carets and comments.
 */
export const PUT = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { user } = await requireAccess(id, "edit");
  const body = await readJson(req, (d) => putSchema.parse(d));
  let changed = false;
  let chars = 0;
  await mutateLiveDoc(id, { userId: user!.id, docId: id, role: "editor", name: actorName(user) ?? "User", login: user!.login, avatar: user!.image ?? null }, (doc) => {
    const ytext = doc.getText(TEXT_KEY);
    const ops = diffOps(ytext.toString(), body.content, 0);
    if (ops.length) {
      applyOps(ytext, ops);
      changed = true;
      chars = ops.reduce((n, op) => n + op.deleteCount + (op.insert?.length ?? 0), 0);
    }
    recordAgentActivity(doc, user!, "edited");
  });
  if (changed) void recordEdit(id, activityActor(user!), chars).catch((err) => console.error("[activity] edit failed", err));
  if (changed && (body.message || user!.agent)) {
    await addVersion({
      documentId: id,
      content: body.content,
      kind: body.message ? "named" : "auto",
      title: body.message ?? (user!.agent ? `Edited by ${user!.agent}` : null),
      createdBy: user!.id,
      createdByName: actorName(user),
    });
  }
  return json({ ok: true, changed });
});

const patchSchema = z.object({
  /** Text to append at the end of the document (a blank line is inserted before it when needed). */
  append: z.string().max(500_000),
});

/** Append Markdown to the end of the document. */
export const PATCH = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { user } = await requireAccess(id, "edit");
  const body = await readJson(req, (d) => patchSchema.parse(d));
  await mutateLiveDoc(id, { userId: user!.id, docId: id, role: "editor", name: actorName(user) ?? "User", login: user!.login, avatar: user!.image ?? null }, (doc) => {
    const ytext = doc.getText(TEXT_KEY);
    const current = ytext.toString();
    const separator = current.length === 0 ? "" : current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    ytext.insert(ytext.length, separator + body.append);
    recordAgentActivity(doc, user!, "edited");
  });
  void recordEdit(id, activityActor(user!), body.append.length).catch((err) => console.error("[activity] edit failed", err));
  return json({ ok: true });
});
