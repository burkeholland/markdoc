import { z } from "zod";
import { handler, json, readJson, requireAccess, HttpError } from "@/server/http";
import { mutateLiveDoc, readLiveDoc } from "@/server/livedoc";
import { CommentsModel } from "@/editor/collab/comments";
import { collabIdentity, recordAgentActivity } from "@/server/agents";
import { TEXT_KEY } from "@/server/collab/hocuspocus";
import { notifyReply, notifyResolved, readThread, recordMentions } from "@/server/notifications";
import { activityActor, clip, recordActivity } from "@/server/activity";

type Params = { params: Promise<{ id: string }> };

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    from: z.number().int().min(0).optional(),
    to: z.number().int().min(0).optional(),
    /** Alternative to from/to: anchor the comment on the first occurrence of this text. */
    quote: z.string().min(1).max(2000).optional(),
    body: z.string().trim().min(1).max(5000),
  }),
  z.object({ action: z.literal("reply"), threadId: z.string().min(1), body: z.string().trim().min(1).max(5000) }),
  z.object({ action: z.literal("resolve"), threadId: z.string().min(1), resolved: z.boolean() }),
  z.object({ action: z.literal("edit"), threadId: z.string().min(1), replyId: z.string().optional(), body: z.string().trim().min(1).max(5000) }),
  z.object({ action: z.literal("delete"), threadId: z.string().min(1), replyId: z.string().optional() }),
]);

/**
 * Comment operations for users who may comment but not edit. Editors apply
 * these directly through the shared document; this endpoint performs the same
 * change server-side so it is broadcast to everyone connected.
 */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { user, role } = await requireAccess(id, "comment");
  if (!user) throw new HttpError(401, "Sign in required");
  const body = await readJson(req, (d) => schema.parse(d));
  const author = collabIdentity(user);
  const actor = { login: user.login ?? null, name: author.name };
  let result: unknown = { ok: true };
  // Side effects the live-document watcher only performs for WebSocket transactions; collected inside the mutation, run after it.
  const after: (() => Promise<unknown>)[] = [];

  await mutateLiveDoc(id, { userId: user.id, docId: id, role, name: author.name, login: user.login, avatar: user.image ?? null }, (doc) => {
    const model = new CommentsModel(doc, doc.getText(TEXT_KEY));
    try {
      switch (body.action) {
        case "add": {
          const text = doc.getText(TEXT_KEY).toString();
          let from: number;
          let to: number;
          if (body.quote !== undefined) {
            const idx = text.indexOf(body.quote);
            if (idx === -1) throw new HttpError(400, `Text not found: ${JSON.stringify(body.quote.slice(0, 80))}`);
            from = idx;
            to = idx + body.quote.length;
          } else {
            from = Math.min(body.from ?? 0, text.length);
            to = Math.min(Math.max(body.to ?? from, from), text.length);
          }
          result = { id: model.add({ from, to, body: body.body, author }) };
          break;
        }
        case "reply": {
          const replyId = model.reply(body.threadId, body.body, author);
          result = { id: replyId };
          const map = model.ymap.get(body.threadId);
          const thread = map ? readThread(map) : null;
          const reply = thread?.replies.find((r) => r.id === replyId);
          if (thread && reply) after.push(() => notifyReply(id, thread, reply));
          break;
        }
        case "resolve": {
          const map = model.ymap.get(body.threadId);
          const thread = map ? readThread(map) : null;
          if (!thread) throw new HttpError(404, "Comment not found");
          const was = map!.get("resolved") === true;
          model.setResolved(body.threadId, body.resolved, author);
          if (was !== body.resolved) after.push(() => notifyResolved(id, thread, body.resolved, actor));
          break;
        }
        case "edit": {
          const thread = model.get(body.threadId);
          if (!thread) throw new HttpError(404, "Comment not found");
          const ownerId = body.replyId ? thread.replies.find((r) => r.id === body.replyId)?.authorId : thread.authorId;
          if (ownerId !== user.id && role !== "owner") throw new HttpError(403, "You can only edit your own comments");
          model.editBody(body.threadId, body.body, body.replyId);
          break;
        }
        case "delete": {
          const thread = model.get(body.threadId);
          if (!thread) throw new HttpError(404, "Comment not found");
          const ownerId = body.replyId ? thread.replies.find((r) => r.id === body.replyId)?.authorId : thread.authorId;
          if (ownerId !== user.id && role !== "owner") throw new HttpError(403, "You can only delete your own comments");
          if (body.replyId) model.deleteReply(body.threadId, body.replyId);
          else model.remove(body.threadId);
          break;
        }
      }
    } finally {
      model.destroy();
    }
    recordAgentActivity(doc, user, "commented");
  });
  // Editors' comments are picked up by the live-document watcher; this covers the no-collab path too (idempotent).
  if (body.action === "add" || body.action === "reply" || body.action === "edit") {
    const created = result as { id?: string | null };
    const target = body.action === "edit" ? body.replyId ?? body.threadId : created.id;
    if (target) await recordMentions(id, target, user.login, body.body, author.name);
  }
  for (const fn of after) await fn();
  if (body.action === "add") {
    await recordActivity(id, activityActor(user), "comment.add", { threadId: (result as { id?: string }).id ?? null, quote: clip(body.body) });
  } else if (body.action === "resolve" && body.resolved) {
    await recordActivity(id, activityActor(user), "comment.resolve", { threadId: body.threadId });
  }
  return json(result);
});

/** All comment threads with their current text ranges (agents use this to read feedback). */
export const GET = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  await requireAccess(id, "view");
  const threads = await readLiveDoc(id, (doc) => {
    const model = new CommentsModel(doc, doc.getText(TEXT_KEY));
    try {
      const text = doc.getText(TEXT_KEY).toString();
      return model.list().map((t) => ({
        id: t.id,
        body: t.body,
        mentions: t.mentions,
        author: t.authorName,
        authorId: t.authorId,
        createdAt: new Date(t.createdAt).toISOString(),
        resolved: t.resolved,
        quote: t.quote,
        range: t.range,
        currentText: t.range ? text.slice(t.range.from, t.range.to) : null,
        replies: t.replies.map((r) => ({ id: r.id, body: r.body, mentions: r.mentions, author: r.authorName, authorId: r.authorId, createdAt: new Date(r.createdAt).toISOString() })),
      }));
    } finally {
      model.destroy();
    }
  });
  return json({ comments: threads });
});

