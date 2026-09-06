import { z } from "zod";
import { handler, json, readJson, requireAccess, actorName, HttpError } from "@/server/http";
import { mutateLiveDoc, cleanTextOf, readPrecondition, assertContentUnchanged, ifContentHashSchema } from "@/server/livedoc";
import { diffSuggestionEdits, targetedSuggestionEdits, SuggestionPlanError } from "@/editor/sync/suggestion-diff";
import { SuggestionsModel, SuggestionConflictError } from "@/editor/collab/suggestions";
import { collabIdentity, recordAgentActivity } from "@/server/agents";
import { activityActor, recordActivity } from "@/server/activity";
import { attachWork, requireAttachableRequest } from "@/server/agent-requests";
import { TEXT_KEY } from "@/server/collab/hocuspocus";
import { contentHash } from "@/server/export/html";
import { warnTail } from "@/server/warnings";

type Params = { params: Promise<{ id: string }> };

const targeted = z.object({
  /** Targeted replacements. Each `find` must occur exactly once unless `all` is set. */
  edits: z
    .array(
      z.object({
        find: z.string().min(1),
        replace: z.string(),
        all: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(200),
});
/** Link the suggestions to an "Ask an agent" request so the editor shows its progress. */
const linked = z.object({
  requestId: z.string().min(1).optional(),
  /** `contentHash` from `GET /content`; refused with 409 when the document moved since (also as `If-Match`). */
  ifContentHash: ifContentHashSchema,
});

const schema = z.union([
  z
    .object({
      /** The full proposed text. Differences from the current text become suggestions. */
      content: z.string().max(2_000_000),
    })
    .merge(linked),
  targeted.merge(linked),
]);

/**
 * Propose changes as tracked suggestions instead of editing directly. Humans see green
 * insertions and struck deletions in both panes and accept or reject each one. This is
 * the recommended way for agents to revise a document someone else owns.
 */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  // A comment-scoped token may propose suggestions (humans accept them); the user still needs edit access.
  const { user } = await requireAccess(id, "edit", { tokenScope: "comment" });
  const body = await readJson(req, (d) => schema.parse(d));
  const expected = readPrecondition(req, body);
  const author = collabIdentity(user!);
  let count = 0;
  const created: string[] = [];
  let hashAfter = "";
  // A linked request must exist, be addressed to this caller and be open/claimed before anything is written (404/403/409 with nothing to undo).
  if (body.requestId) await requireAttachableRequest(id, body.requestId, user!);

  await mutateLiveDoc(id, { userId: user!.id, docId: id, role: "editor", name: actorName(user) ?? "User", login: user!.login, avatar: user!.image ?? null }, (doc) => {
    hashAfter = assertContentUnchanged(id, doc, expected);
    const ytext = doc.getText(TEXT_KEY);
    const current = ytext.toString();
    let edits;
    try {
      edits = "content" in body ? diffSuggestionEdits(current, body.content) : targetedSuggestionEdits(current, body.edits);
    } catch (error) {
      if (error instanceof SuggestionPlanError) throw new HttpError(error.status, error.message);
      throw error;
    }
    if (edits.length === 0) return;
    const model = new SuggestionsModel(doc, ytext);
    const first = edits.reduce((left, edit) => edit.from < left.from ? edit : left);
    const firstEnd = first.to + first.insert.length;
    try {
      created.push(...model.proposeEdits(edits, author));
      count = created.length;
    } catch (error) {
      if (error instanceof SuggestionConflictError) throw new HttpError(409, "Replacement overlaps a pending suggestion; review it before proposing another edit");
      throw error;
    } finally {
      model.destroy();
    }
    recordAgentActivity(doc, user!, "suggested", { from: firstEnd, to: firstEnd });
    hashAfter = contentHash(cleanTextOf(doc));
  });

  // The suggestions are in the shared document (broadcast to every editor, irrevocable): an activity row or request
  // link that fails here is logged and reported as a warning code on the 200, never as a non-2xx claiming nothing
  // changed. `attachWork` still validates the request — one cancelled/completed between the pre-check and the write
  // is the residual race and surfaces as `request-not-attached` with the suggestions kept. It runs before the
  // activity row so that a row never claims work for a request that refused to count it (same order as comments).
  const { tail, answer } = warnTail("suggest");
  const linkedRequest = body.requestId;
  const attached = linkedRequest ? await tail("request-not-attached", () => attachWork(id, linkedRequest, user!, { suggestions: count, suggestionIds: created })) : false;
  if (count > 0) await tail("activity-not-recorded", () => recordActivity(id, activityActor(user!), "suggestion.add", { count, ...(attached ? { requestId: linkedRequest } : {}) }));
  return json(answer({ ok: true, suggestions: count, suggestionIds: created, contentHash: hashAfter }));
});
