import { z } from "zod";
import { handler, json, readJson, requireAccess, actorName } from "@/server/http";
import { readLiveDoc, mutateLiveDoc } from "@/server/livedoc";
import { SuggestionsModel } from "@/editor/collab/suggestions";
import { recordAgentActivity } from "@/server/agents";
import { TEXT_KEY } from "@/server/collab/hocuspocus";

type Params = { params: Promise<{ id: string }> };

/** Pending suggestions (tracked changes) with their current text ranges. */
export const GET = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  await requireAccess(id, "view");
  const suggestions = await readLiveDoc(id, (doc) => {
    const model = new SuggestionsModel(doc, doc.getText(TEXT_KEY));
    try {
      const text = doc.getText(TEXT_KEY).toString();
      return model.list().map((s) => ({
        id: s.id,
        type: s.type,
        from: s.from,
        to: s.to,
        text: text.slice(s.from, s.to),
        author: s.authorName,
        authorId: s.authorId,
        createdAt: new Date(s.createdAt).toISOString(),
        context: text.slice(Math.max(0, s.from - 40), Math.min(text.length, s.to + 40)),
      }));
    } finally {
      model.destroy();
    }
  });
  return json({ suggestions });
});

const actionSchema = z.object({
  action: z.enum(["accept", "reject", "acceptAll", "rejectAll"]),
  id: z.string().optional(),
});

/** Accept or reject suggestions. */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { user } = await requireAccess(id, "edit");
  const body = await readJson(req, (d) => actionSchema.parse(d));
  await mutateLiveDoc(id, { userId: user!.id, docId: id, role: "editor", name: actorName(user) ?? "User", login: user!.login, avatar: user!.image ?? null }, (doc) => {
    const model = new SuggestionsModel(doc, doc.getText(TEXT_KEY));
    try {
      switch (body.action) {
        case "accept":
          if (body.id) model.accept(body.id);
          break;
        case "reject":
          if (body.id) model.reject(body.id);
          break;
        case "acceptAll":
          model.acceptAll();
          break;
        case "rejectAll":
          model.rejectAll();
          break;
      }
    } finally {
      model.destroy();
    }
    recordAgentActivity(doc, user!, "reviewed");
  });
  return json({ ok: true });
});
