import { z } from "zod";
import { handler, json, readJson, requireAccess, HttpError } from "@/server/http";
import { mutateLiveDoc, readLiveDoc } from "@/server/livedoc";
import { CommentsModel, isEmoji, type CommentReply, type CommentThread } from "@/editor/collab/comments";
import { isSuggestionOutdated, parseSuggestionBlock } from "@/editor/collab/suggestion-block";
import { collabIdentity, recordAgentActivity } from "@/server/agents";
import { TEXT_KEY } from "@/server/collab/hocuspocus";
import { notifyReply, notifyResolved, readThread, recordMentions } from "@/server/notifications";
import { activityActor, clip, recordActivity } from "@/server/activity";
import { recordSuggestionDecision } from "@/server/reviews";
import { attachWork } from "@/server/agent-requests";

type Params = { params: Promise<{ id: string }> };

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    from: z.number().int().min(0).optional(),
    to: z.number().int().min(0).optional(),
    /** Alternative to from/to: anchor the comment on the first occurrence of this text. */
    quote: z.string().min(1).max(2000).optional(),
    body: z.string().trim().min(1).max(5000),
    /** Link the comment to an "Ask an agent" request. */
    requestId: z.string().min(1).optional(),
  }),
  z.object({ action: z.literal("reply"), threadId: z.string().min(1), body: z.string().trim().min(1).max(5000) }),
  z.object({ action: z.literal("resolve"), threadId: z.string().min(1), resolved: z.boolean() }),
  z.object({ action: z.literal("edit"), threadId: z.string().min(1), replyId: z.string().optional(), body: z.string().trim().min(1).max(5000) }),
  z.object({ action: z.literal("delete"), threadId: z.string().min(1), replyId: z.string().optional() }),
  z.object({
    action: z.literal("react"),
    threadId: z.string().min(1),
    replyId: z.string().optional(),
    emoji: z.string().trim().min(1).max(16).refine(isEmoji, "Must be a single emoji (e.g. 👍)"),
  }),
  /** Decide on a root or reply ```suggestion block: accept applies it to the text (editors only), reject records the decision. */
  z.object({ action: z.literal("suggestion"), threadId: z.string().min(1), replyId: z.string().min(1).optional(), decision: z.enum(["accept", "reject"]) }),
]);

/**
 * Comment operations for users who may comment but not edit. Editors apply
 * these directly through the shared document; this endpoint performs the same
 * change server-side so it is broadcast to everyone connected.
 */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { user: caller, role } = await requireAccess(id, "comment");
  if (!caller) throw new HttpError(401, "Sign in required");
  const user = caller;
  const body = await readJson(req, (d) => schema.parse(d));
  const author = collabIdentity(user);
  const actor = { login: user.login ?? null, name: author.name };
  let result: unknown = { ok: true };
  // Side effects the live-document watcher only performs for WebSocket transactions; collected inside the mutation, run after it.
  const after: (() => Promise<unknown>)[] = [];
  // The text the action concerns (new comment's quote, replied thread's range): an agent's caret moves there.
  let at: { from: number; to: number } | undefined;
  let decided: { thread: CommentThread; reply: CommentReply | null; accepted: boolean } | null = null;

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
          at = { from, to };
          break;
        }
        case "reply": {
          const replyId = model.reply(body.threadId, body.body, author);
          if (!replyId) throw new HttpError(404, "Comment not found");
          result = { id: replyId };
          at = model.get(body.threadId)?.range ?? undefined;
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
        case "react": {
          // Toggle; reactions never notify anyone (see docs/agents.md).
          const reacted = model.toggleReaction(body.threadId, body.replyId ?? null, body.emoji, author);
          if (reacted === null) throw new HttpError(404, "Comment not found");
          result = { ok: true, reacted };
          break;
        }
        case "suggestion": {
          const thread = model.get(body.threadId);
          if (!thread) throw new HttpError(404, "Comment not found");
          const reply = body.replyId ? (thread.replies.find((item) => item.id === body.replyId) ?? null) : null;
          if (body.replyId && !reply) throw new HttpError(404, "Reply not found");
          const block = parseSuggestionBlock(reply?.body ?? thread.body);
          if (!block) throw new HttpError(400, `This ${reply ? "reply" : "comment"} has no suggestion block`);
          const state = reply ? reply.suggestionState : thread.suggestionState;
          if (state) throw new HttpError(409, `Suggestion already ${state}`);
          if (body.decision === "accept") {
            if (role !== "owner" && role !== "editor") throw new HttpError(403, "Only editors can accept suggestions");
            if (isSuggestionOutdated(thread, doc.getText(TEXT_KEY).toString())) throw new HttpError(409, "Suggestion is outdated: the quoted text changed");
            const accepted = reply ? model.acceptReplySuggestion(body.threadId, reply.id, author) : model.acceptSuggestion(body.threadId, block.text, author);
            if (!accepted) throw new HttpError(409, "Could not apply the suggestion");
          } else {
            const rejected = reply ? model.rejectReplySuggestion(body.threadId, reply.id, author) : model.rejectSuggestion(body.threadId, author);
            if (!rejected) throw new HttpError(409, "Could not reject the suggestion");
          }
          decided = { thread, reply, accepted: body.decision === "accept" };
          at = thread.range ?? undefined;
          result = { ok: true, state: body.decision === "accept" ? "accepted" : "rejected", ...(reply ? { replyId: reply.id } : {}) };
          break;
        }
      }
    } finally {
      model.destroy();
    }
    recordAgentActivity(doc, user, body.action === "react" ? "reacted" : "commented", at);
  });
  // Editors' comments are picked up by the live-document watcher; this covers the no-collab path too (idempotent).
  try {
    await afterMutation();
  } catch (err) {
    // The thread/reply is already in the shared document; a failed mention, notification or activity row
    // must not leave it half-written ("a non-2xx status means nothing changed"), so take it back out.
    await undoWrite().catch((undoErr) => console.error("[comments] could not undo after a failed side effect", undoErr));
    throw err;
  }
  return json(result);

  async function afterMutation() {
    if (body.action === "add" || body.action === "reply" || body.action === "edit") {
      const created = result as { id?: string | null };
      const target = body.action === "edit" ? body.replyId ?? body.threadId : created.id;
      if (target) await recordMentions(id, target, user.login, body.body, author.name);
    }
    for (const fn of after) await fn();
    if (body.action === "add") {
      await recordActivity(id, activityActor(user), "comment.add", { threadId: (result as { id?: string }).id ?? null, quote: clip(body.body), ...(body.requestId ? { requestId: body.requestId } : {}) });
      if (body.requestId) {
        const threadId = (result as { id?: string }).id;
        await attachWork(id, body.requestId, user, { comments: 1, commentIds: threadId ? [threadId] : [] });
      }
    } else if (body.action === "reply") {
      await recordActivity(id, activityActor(user), "comment.reply", { threadId: body.threadId, replyId: (result as { id?: string }).id ?? null, quote: clip(body.body) });
    } else if (body.action === "resolve" && body.resolved) {
      await recordActivity(id, activityActor(user), "comment.resolve", { threadId: body.threadId });
    } else if (body.action === "suggestion") {
      const d = decided as { thread: CommentThread; reply: CommentReply | null; accepted: boolean } | null;
      if (d) await recordSuggestionDecision(id, d.thread, d.accepted, { ...activityActor(user), login: user.login ?? null }, d.reply);
    }
  }

  async function undoWrite() {
    const createdId = (result as { id?: string | null }).id;
    if (!createdId || (body.action !== "add" && body.action !== "reply")) return;
    const action = body;
    await mutateLiveDoc(id, { userId: user.id, docId: id, role, name: author.name, login: user.login, avatar: user.image ?? null }, (doc) => {
      const model = new CommentsModel(doc, doc.getText(TEXT_KEY));
      try {
        if (action.action === "add") model.remove(createdId);
        else model.deleteReply(action.threadId, createdId);
      } finally {
        model.destroy();
      }
    });
  }
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
        editedAt: t.editedAt ? new Date(t.editedAt).toISOString() : null,
        resolved: t.resolved,
        quote: t.quote,
        range: t.range,
        currentText: t.range ? text.slice(t.range.from, t.range.to) : null,
        suggestion: (() => {
          const block = parseSuggestionBlock(t.body);
          if (!block) return null;
          return {
            text: block.text,
            source: t.suggestionState ? (t.suggestionQuote ?? t.quote) : t.quote,
            state: t.suggestionState ?? (isSuggestionOutdated(t, text) ? "outdated" : "pending"),
            by: t.suggestionBy ?? null,
            at: t.suggestionAt ? new Date(t.suggestionAt).toISOString() : null,
          };
        })(),
        reactions: t.reactions,
        replies: t.replies.map((r) => ({
          id: r.id,
          body: r.body,
          mentions: r.mentions,
          author: r.authorName,
          authorId: r.authorId,
          createdAt: new Date(r.createdAt).toISOString(),
          editedAt: r.editedAt ? new Date(r.editedAt).toISOString() : null,
          suggestion: (() => {
            const block = parseSuggestionBlock(r.body);
            if (!block) return null;
            return {
              text: block.text,
              source: r.suggestionState ? (r.suggestionQuote ?? t.quote) : t.quote,
              state: r.suggestionState ?? (isSuggestionOutdated(t, text) ? "outdated" : "pending"),
              by: r.suggestionBy ?? null,
              at: r.suggestionAt ? new Date(r.suggestionAt).toISOString() : null,
            };
          })(),
          reactions: r.reactions,
        })),
      }));
    } finally {
      model.destroy();
    }
  });
  return json({ comments: threads });
});
