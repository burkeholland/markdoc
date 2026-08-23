import { z } from "zod";
import { handler, json, readJson, requireAccess, actorName, HttpError } from "@/server/http";
import { mutateLiveDoc } from "@/server/livedoc";
import { diffOpsWords } from "@/editor/sync/text-diff";
import { SuggestionsModel, SUGGESTIONS_ORIGIN } from "@/editor/collab/suggestions";
import { collabIdentity, recordAgentActivity } from "@/server/agents";
import { activityActor, recordActivity } from "@/server/activity";
import { TEXT_KEY } from "@/server/collab/hocuspocus";

type Params = { params: Promise<{ id: string }> };

const schema = z.union([
  z.object({
    /** The full proposed text. Differences from the current text become suggestions. */
    content: z.string().max(2_000_000),
  }),
  z.object({
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
  }),
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
  const author = collabIdentity(user!);
  let count = 0;

  await mutateLiveDoc(id, { userId: user!.id, docId: id, role: "editor", name: actorName(user) ?? "User", login: user!.login, avatar: user!.image ?? null }, (doc) => {
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
    try {
      doc.transact(() => {
        let shift = 0;
        for (const op of ops) {
          const idx = op.index + shift;
          if (op.deleteCount > 0) {
            const kept = model.markDeleted(idx, idx + op.deleteCount, author);
            shift += kept;
            count++;
          }
          if (op.insert) {
            ytext.insert(idx, op.insert);
            model.recordInserted(idx, op.insert.length, author);
            count++;
          }
        }
      }, SUGGESTIONS_ORIGIN);
    } finally {
      model.destroy();
    }
    recordAgentActivity(doc, user!, "suggested");
  });

  if (count > 0) await recordActivity(id, activityActor(user!), "suggestion.add", { count });
  return json({ ok: true, suggestions: count });
});

