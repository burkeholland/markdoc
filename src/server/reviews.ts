import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/editor/collab/shared";
import { CommentsModel, type CommentReply, type CommentThread } from "@/editor/collab/comments";
import { hasSuggestionBlock } from "@/editor/collab/suggestion-block";
import { TEXT_KEY } from "@/server/collab/hocuspocus";
import { mutateLiveDoc } from "@/server/livedoc";
import { collabIdentity, recordAgentActivity } from "@/server/agents";
import { HttpError, type Actor } from "@/server/http";
import { activityActor, clip, recordActivity, type ActivityActor } from "@/server/activity";
import { loginForUserId, notify, recordMentions } from "@/server/notifications";
import type { Review, ReviewVerdict, Role } from "@/server/db/schema";

export interface ReviewCommentInput {
  quote: string;
  body: string;
}

export interface ReviewInput {
  summary: string;
  verdict: ReviewVerdict;
  comments: ReviewCommentInput[];
}

export interface ReviewDto {
  id: string;
  documentId: string;
  authorId: string;
  authorName: string;
  /** Collab identity of the author (matches thread `authorId`), so the UI can tell agents apart. */
  collabAuthorId: string;
  agent: string | null;
  verdict: ReviewVerdict;
  summary: string;
  threadIds: string[];
  createdAt: string;
}

export function toReviewDto(r: Review): ReviewDto {
  return {
    id: r.id,
    documentId: r.documentId,
    authorId: r.userId,
    authorName: r.authorName,
    collabAuthorId: r.agentTokenId ? `agent:${r.userId}:${r.authorName}` : r.userId,
    agent: r.agentTokenId ? r.authorName : null,
    verdict: r.verdict,
    summary: r.summary,
    threadIds: r.threadIds,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Post a review: every `quote` must anchor (first occurrence in the current text) or nothing is
 * created — the 400 lists the quotes that failed. Threads are created in one shared-document
 * transaction, then the review row, activity and the owner's notification are written.
 */
export async function createReview(docId: string, user: Actor, role: Role, input: ReviewInput): Promise<ReviewDto> {
  const author = collabIdentity(user);
  const threadIds: string[] = [];
  await mutateLiveDoc(docId, { userId: user.id, docId, role, name: author.name, login: user.login, avatar: user.image ?? null }, (doc) => {
    const ytext = doc.getText(TEXT_KEY);
    const text = ytext.toString();
    const ranges: { from: number; to: number }[] = [];
    const missing: string[] = [];
    for (const c of input.comments) {
      const idx = text.indexOf(c.quote);
      if (idx === -1) missing.push(c.quote.slice(0, 80));
      else ranges.push({ from: idx, to: idx + c.quote.length });
    }
    if (missing.length) throw new HttpError(400, `Text not found for ${missing.length} comment(s); nothing was created`, { notFound: missing });
    const model = new CommentsModel(doc, ytext);
    try {
      doc.transact(() => {
        input.comments.forEach((c, i) => {
          threadIds.push(model.add({ ...ranges[i], body: c.body, author }));
        });
      });
    } finally {
      model.destroy();
    }
    recordAgentActivity(doc, user, "commented", ranges[0]);
  });

  const db = await getDb();
  const row: Review = {
    id: newId(),
    documentId: docId,
    userId: user.id,
    agentTokenId: user.tokenId ?? null,
    authorName: user.agent ?? user.name ?? user.login ?? "User",
    verdict: input.verdict,
    summary: input.summary,
    threadIds,
    createdAt: new Date(),
  };
  await db.insert(schema.reviews).values(row);

  for (let i = 0; i < threadIds.length; i++) await recordMentions(docId, threadIds[i], user.login, input.comments[i].body, author.name);
  const suggestions = input.comments.filter((c) => hasSuggestionBlock(c.body)).length;
  await recordActivity(docId, activityActor(user), "review.create", { reviewId: row.id, verdict: input.verdict, comments: threadIds.length, suggestions, threadIds, quote: clip(input.summary) });

  const [doc] = await db.select({ ownerId: schema.documents.ownerId }).from(schema.documents).where(eq(schema.documents.id, docId));
  const ownerLogin = doc ? await loginForUserId(doc.ownerId) : null;
  if (ownerLogin && user.login) {
    await notify({ userLogin: ownerLogin, documentId: docId, kind: "review", actorLogin: user.login, actorName: row.authorName, refId: row.id, snippet: `${verdictPhrase(input.verdict)}: ${input.summary}` });
  }
  return toReviewDto(row);
}

function verdictPhrase(verdict: ReviewVerdict): string {
  return verdict === "approve" ? "Approved" : verdict === "request_changes" ? "Requested changes" : "Reviewed";
}

export async function listReviews(docId: string): Promise<ReviewDto[]> {
  const db = await getDb();
  const rows = await db.select().from(schema.reviews).where(eq(schema.reviews.documentId, docId)).orderBy(desc(schema.reviews.createdAt)).limit(50);
  return rows.map(toReviewDto);
}

/**
 * Activity + notification for a decision on a comment's suggestion block. The comment's author
 * hears about an acceptance (kind `suggestion.accepted`) unless they accepted it themselves.
 */
export async function recordSuggestionDecision(
  docId: string,
  thread: Pick<CommentThread, "id" | "authorId" | "authorName" | "body" | "quote">,
  accepted: boolean,
  actor: ActivityActor & { login: string | null },
  reply?: Pick<CommentReply, "id" | "authorId" | "authorName"> | null,
): Promise<void> {
  const target = reply ?? thread;
  await recordActivity(docId, actor, accepted ? "comment.suggestion.accepted" : "comment.suggestion.rejected", {
    threadId: thread.id,
    ...(reply ? { replyId: reply.id } : {}),
    author: target.authorName,
    quote: clip(thread.quote),
  });
  if (!accepted || !actor.login) return;
  const login = await loginForUserId(target.authorId.startsWith("agent:") ? target.authorId.split(":")[1] : target.authorId);
  if (!login || login === actor.login.toLowerCase()) return;
  await notify({ userLogin: login, documentId: docId, kind: "suggestion.accepted", actorLogin: actor.login, actorName: actor.name, refId: target.id, snippet: thread.quote });
}
