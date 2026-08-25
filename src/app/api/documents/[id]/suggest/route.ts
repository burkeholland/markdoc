import { z } from "zod";
import { handler, json, readJson, requireAccess, actorName, HttpError } from "@/server/http";
import { mutateLiveDoc, cleanTextOf, expectedContentHash, assertContentUnchanged, ifContentHashSchema } from "@/server/livedoc";
import { diffOpsWords } from "@/editor/sync/text-diff";
import { SuggestionsModel, SUGGESTIONS_ORIGIN } from "@/editor/collab/suggestions";
import { collabIdentity, recordAgentActivity } from "@/server/agents";
import { activityActor, recordActivity } from "@/server/activity";
import { attachWork } from "@/server/agent-requests";
import { TEXT_KEY } from "@/server/collab/hocuspocus";
import { contentHash } from "@/server/export/html";

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
/** Link the suggestions to an "Ask an agent" request so its pill shows progress. */
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
  const { user } = await requireAccess(id, "edit");
  const body = await readJson(req, (d) => schema.parse(d));
  const expected = expectedContentHash(req, body.ifContentHash);
  const author = collabIdentity(user!);
  let count = 0;
  const created: string[] = [];
  let hashAfter = "";

  await mutateLiveDoc(id, { userId: user!.id, docId: id, role: "editor", name: actorName(user) ?? "User", login: user!.login, avatar: user!.image ?? null }, (doc) => {
    hashAfter = assertContentUnchanged(id, doc, expected);
    const ytext = doc.getText(TEXT_KEY);
    const current = ytext.toString();
    let proposed: string;
    if ("content" in body) {
      proposed = body.content;
    } else {
      proposed = current;
      for (const edit of body.edits) {
        const occurrences = proposed.split(edit.find).length - 1;
        if (occurrences === 0) throw new HttpError(400, `Text not found: ${JSON.stringify(edit.find.slice(0, 80))}`);
        if (occurrences > 1 && !edit.all) throw new HttpError(400, `Text occurs ${occurrences} times; add "all": true or make it unique: ${JSON.stringify(edit.find.slice(0, 80))}`);
        proposed = edit.all ? proposed.split(edit.find).join(edit.replace) : proposed.replace(edit.find, edit.replace);
      }
    }
    const ops = diffOpsWords(current, proposed, 0);
    if (ops.length === 0) return;
    const model = new SuggestionsModel(doc, ytext);
    const before = new Set(model.ymap.keys());
    // Where the first edit ends once applied (insert + kept deletion), so the agent's caret lands there.
    let firstEnd: number | null = null;
    try {
      doc.transact(() => {
        let shift = 0;
        for (const op of ops) {
          const idx = op.index + shift;
          let kept = 0;
          if (op.deleteCount > 0) {
            kept = model.markDeleted(idx, idx + op.deleteCount, author);
            shift += kept;
            count++;
          }
          if (op.insert) {
            ytext.insert(idx, op.insert);
            model.recordInserted(idx, op.insert.length, author);
            count++;
          }
          if (firstEnd === null) firstEnd = idx + (op.insert?.length ?? 0) + kept;
        }
      }, SUGGESTIONS_ORIGIN);
      for (const key of model.ymap.keys()) if (!before.has(key)) created.push(key);
    } finally {
      model.destroy();
    }
    recordAgentActivity(doc, user!, "suggested", firstEnd === null ? undefined : { from: firstEnd, to: firstEnd });
    hashAfter = contentHash(cleanTextOf(doc));
  });

  if (count > 0) await recordActivity(id, activityActor(user!), "suggestion.add", { count, ...(body.requestId ? { requestId: body.requestId } : {}) });
  if (body.requestId) await attachWork(id, body.requestId, user!, { suggestions: count, suggestionIds: created });
  return json({ ok: true, suggestions: count, suggestionIds: created, contentHash: hashAfter });
});

