import { z } from "zod";
import { handler, json, readJson, requireAccess, actorName, HttpError } from "@/server/http";
import { readLiveDoc, mutateLiveDoc } from "@/server/livedoc";
import { SuggestionsModel, SuggestionConflictError } from "@/editor/collab/suggestions";
import { recordAgentActivity } from "@/server/agents";
import { activityActor, recordActivity } from "@/server/activity";
import { TEXT_KEY } from "@/server/collab/hocuspocus";
import { notifySuggestionDecision } from "@/server/notifications";
import type { SuggestionGroup } from "@/editor/collab/suggestions";
import { warnTail } from "@/server/warnings";

type Params = { params: Promise<{ id: string }> };

/** Pending suggestions (tracked changes) with their current text ranges. */
export const GET = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  await requireAccess(id, "view");
  const suggestions = await readLiveDoc(id, (doc) => {
    const model = new SuggestionsModel(doc, doc.getText(TEXT_KEY));
    try {
      const text = doc.getText(TEXT_KEY).toString();
      return model.groups().map((s) => ({
        id: s.id,
        type: s.type,
        from: s.from,
        to: s.to,
        text: s.text,
        ...(s.groupId ? { before: s.before, after: s.after, outdated: s.outdated } : {}),
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

/**
 * Accept or reject suggestions. `accept` / `reject` decide exactly one suggestion and need its `id`
 * (400 without one, 404 when no pending suggestion has it); `acceptAll` / `rejectAll` decide every
 * pending one. Answers `{ ok, decided }` — and `id` for a single decision — so callers can check
 * that something actually happened.
 */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { user } = await requireAccess(id, "edit");
  const body = await readJson(req, (d) => actionSchema.parse(d));
  const single = body.action === "accept" || body.action === "reject";
  if (single && !body.id) throw new HttpError(400, "`id` is required for accept/reject");
  let count = 0;
  let decided: SuggestionGroup[] = [];
  await mutateLiveDoc(id, { userId: user!.id, docId: id, role: "editor", name: actorName(user) ?? "User", login: user!.login, avatar: user!.image ?? null }, (doc) => {
    const model = new SuggestionsModel(doc, doc.getText(TEXT_KEY));
    try {
      const pending = model.groups();
      const before = pending.length;
      decided = single ? pending.filter((s) => s.id === body.id || s.members.some((member) => member.id === body.id)) : pending;
      // Unknown or already-decided id: leave the document untouched and tell the caller.
      if (single && decided.length === 0) throw new HttpError(404, "Suggestion not found");
      switch (body.action) {
        case "accept":
          model.accept(body.id!);
          break;
        case "reject":
          model.reject(body.id!);
          break;
        case "acceptAll":
          model.acceptAll();
          break;
        case "rejectAll":
          model.rejectAll();
          break;
      }
      count = Math.max(0, before - model.groups().length);
    } catch (error) {
      if (error instanceof SuggestionConflictError) throw new HttpError(409, error.message);
      throw error;
    } finally {
      model.destroy();
    }
    recordAgentActivity(doc, user!, "reviewed");
  });
  const accepted = body.action.startsWith("accept");
  // The decision is in the shared document (text changed or suggestions cleared, broadcast to every editor,
  // irrevocable): an activity row or an author's notification that fails here is logged and reported as a warning
  // code on the 200 — never a 500 whose retry would answer `404 Suggestion not found` or `decided: 0`.
  const { tail, answer } = warnTail("suggestions");
  if (count > 0) {
    await tail("activity-not-recorded", () => recordActivity(id, activityActor(user!), accepted ? "suggestion.accept" : "suggestion.reject", { count }));
    const actor = { login: user!.login ?? null, name: actorName(user) ?? null };
    // One tail per author: a failure for one never skips the rest, and the code is reported once.
    for (const s of decided) await tail("notification-not-sent", () => notifySuggestionDecision(id, { ...s.members[0], id: s.id, text: s.text }, accepted, actor));
  }
  return json(answer({ ok: true, decided: count, ...(single ? { id: body.id } : {}) }));
});
