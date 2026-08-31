import { z } from "zod";
import { handler, json, readJson, requireAccess, HttpError } from "@/server/http";
import { mutateLiveDoc, readLiveDoc } from "@/server/livedoc";
import { CommentsModel, DecidedSuggestionEditError, isEmoji, type CommentReply, type CommentThread } from "@/editor/collab/comments";
import { isSuggestionOutdated, parseSuggestionBlock } from "@/editor/collab/suggestion-block";
import { collabIdentity, recordAgentActivity } from "@/server/agents";
import { TEXT_KEY } from "@/server/collab/hocuspocus";
import { notifyReply, notifyResolved, readThread, recordMentions } from "@/server/notifications";
import { activityActor, clip, recordActivity } from "@/server/activity";
import { recordSuggestionDecision } from "@/server/reviews";
import { attachWork, requireAttachableRequest } from "@/server/agent-requests";

type Params = { params: Promise<{ id: string }> };

/** Post-write side effects that can fail without taking the comment back: reported as `warnings` on the 2xx (see docs/agents.md). */
type Warning = "mentions-not-recorded" | "notification-not-sent" | "request-not-attached" | "activity-not-recorded";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    from: z.number().int().min(0).optional(),
    to: z.number().int().min(0).optional(),
    /** Alternative to from/to: anchor the comment on the first occurrence of this text. */
    quote: z.string().min(1).max(2000).optional(),
    body: z.string().trim().min(1).max(5000),
    /**
     * Link the comment to an agent request (it counts against the request). Fold rule: when that request
     * was made from a comment thread (`threadId` on the request), the comment is stored as a reply on that
     * thread instead of a twin thread — `quote` / `from` / `to` are ignored and the response is
     * `{ id: <replyId>, threadId, folded: true }`. Otherwise a new thread as usual: `{ id: <threadId> }`.
     */
    requestId: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("reply"),
    threadId: z.string().min(1),
    body: z.string().trim().min(1).max(5000),
    /** Link the reply to an agent request: counted against it like `add`; the thread's participants get no `reply` notification (the requester gets `request.done`). */
    requestId: z.string().min(1).optional(),
  }),
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
  // A linked request must exist and be open/claimed before anything is written (404/409 with nothing to undo,
  // exactly as `suggest` does). For `add`, a request made from a comment thread folds the new comment into that
  // thread (see the schema); `requestThread` is that thread.
  const requestId = body.action === "add" || body.action === "reply" ? body.requestId : undefined;
  const requestThread = requestId ? ((await requireAttachableRequest(id, requestId)).threadId ?? null) : null;
  let folded: string | null = null;

  await mutateLiveDoc(id, { userId: user.id, docId: id, role, name: author.name, login: user.login, avatar: user.image ?? null }, (doc) => {
    const model = new CommentsModel(doc, doc.getText(TEXT_KEY));
    try {
      switch (body.action) {
        case "add": {
          // Fold rule; when the thread has since been deleted, fall back to a new thread exactly as without `threadId`.
          const replyId = body.requestId && requestThread ? model.reply(requestThread, body.body, author, { requestId: body.requestId }) : null;
          if (replyId && requestThread) {
            folded = requestThread;
            result = { id: replyId, threadId: requestThread, folded: true };
            at = model.get(requestThread)?.range ?? undefined;
            break;
          }
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
          const replyId = model.reply(body.threadId, body.body, author, { requestId: body.requestId });
          if (!replyId) throw new HttpError(404, "Comment not found");
          result = { id: replyId };
          at = model.get(body.threadId)?.range ?? undefined;
          const map = model.ymap.get(body.threadId);
          const thread = map ? readThread(map) : null;
          const reply = thread?.replies.find((r) => r.id === replyId);
          // A request-linked reply notifies nobody (`notifyReply` enforces this for the live watcher too): the requester gets `request.done`.
          if (thread && reply && !body.requestId) after.push(() => notifyReply(id, thread, reply));
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
          try {
            model.editBody(body.threadId, body.body, body.replyId);
          } catch (error) {
            if (error instanceof DecidedSuggestionEditError) throw new HttpError(409, error.message);
            throw error;
          }
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
  // The thread/reply is already in the shared document (broadcast to every editor, irrevocable), so a mention,
  // notification, request link or activity row that fails here is logged and reported as a warning code on the
  // 2xx — never a non-2xx that would claim nothing changed, never a silent gap.
  const warnings = await afterMutation();
  return json(warnings.length ? { ...(result as Record<string, unknown>), warnings } : result);

  async function afterMutation(): Promise<Warning[]> {
    const failed: Warning[] = [];
    const tail = async (code: Warning, fn: () => Promise<unknown>): Promise<boolean> => {
      try {
        await fn();
        return true;
      } catch (err) {
        console.error(`[comments] ${code}`, err);
        failed.push(code);
        return false;
      }
    };
    const createdId = (result as { id?: string | null }).id ?? null;
    if (body.action === "add" || body.action === "reply" || body.action === "edit") {
      const target = body.action === "edit" ? body.replyId ?? body.threadId : createdId;
      if (target) await tail("mentions-not-recorded", () => recordMentions(id, target, user.login, body.body, author.name));
    }
    for (const fn of after) await tail("notification-not-sent", fn);
    if (body.action === "add" || body.action === "reply") {
      // The request link before the activity row: `attachWork` still validates the request (one completed or
      // cancelled between the pre-check and the write is the residual race), and a row must not claim work for
      // a request that refused to count it — so the row is written after, and without `requestId`, when it did.
      const linkedRequest = body.requestId;
      const attached = linkedRequest ? await tail("request-not-attached", () => attachWork(id, linkedRequest, user, { comments: 1, commentIds: createdId ? [createdId] : [] })) : false;
      const link = attached ? { requestId: linkedRequest } : {};
      const quote = clip(body.body);
      // A reply, or an `add` folded into the request's thread, is a reply in every respect (activity, work count).
      const repliedTo = body.action === "reply" ? body.threadId : folded;
      if (repliedTo) await tail("activity-not-recorded", () => recordActivity(id, activityActor(user), "comment.reply", { threadId: repliedTo, replyId: createdId, quote, ...link }));
      else await tail("activity-not-recorded", () => recordActivity(id, activityActor(user), "comment.add", { threadId: createdId, quote, ...link }));
    } else if (body.action === "resolve" && body.resolved) {
      await tail("activity-not-recorded", () => recordActivity(id, activityActor(user), "comment.resolve", { threadId: body.threadId }));
    } else if (body.action === "suggestion") {
      const d = decided as { thread: CommentThread; reply: CommentReply | null; accepted: boolean } | null;
      if (d) await tail("activity-not-recorded", () => recordSuggestionDecision(id, d.thread, d.accepted, { ...activityActor(user), login: user.login ?? null }, d.reply));
    }
    return failed;
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
