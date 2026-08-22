import * as Y from "yjs";
import { createAnchor, newId, resolveAnchor, type CollabUser, type TextAnchor } from "./shared";

export interface CommentReply {
  id: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string | null;
  body: string;
  createdAt: number;
}

export interface CommentThread {
  id: string;
  anchor: TextAnchor;
  /** Text that was selected when the comment was created. */
  quote: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string | null;
  body: string;
  createdAt: number;
  resolved: boolean;
  resolvedBy?: string | null;
  resolvedAt?: number | null;
  replies: CommentReply[];
  /** Current absolute range in the text, or null when the anchored text no longer exists. */
  range: { from: number; to: number } | null;
}

export const COMMENTS_ORIGIN = { name: "comments" };

type ThreadMap = Y.Map<unknown>;

/**
 * Comment threads stored in the shared Y.Doc. Each thread is a Y.Map with
 * scalar fields plus a Y.Array of replies so that concurrent replies from
 * different users never overwrite each other.
 */
export class CommentsModel {
  readonly ymap: Y.Map<ThreadMap>;
  private listeners = new Set<() => void>();

  constructor(
    readonly ydoc: Y.Doc,
    readonly ytext: Y.Text,
  ) {
    this.ymap = ydoc.getMap<ThreadMap>("comments");
    this.ymap.observeDeep(this.notify);
    this.ytext.observe(this.notify);
  }

  destroy() {
    this.ymap.unobserveDeep(this.notify);
    this.ytext.unobserve(this.notify);
    this.listeners.clear();
  }

  private notify = () => {
    for (const l of this.listeners) l();
  };

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private read(map: ThreadMap): CommentThread {
    const replies = map.get("replies") as Y.Array<CommentReply> | undefined;
    const anchor = map.get("anchor") as TextAnchor;
    return {
      id: map.get("id") as string,
      anchor,
      quote: (map.get("quote") as string) ?? "",
      authorId: map.get("authorId") as string,
      authorName: map.get("authorName") as string,
      authorAvatar: (map.get("authorAvatar") as string | null) ?? null,
      body: map.get("body") as string,
      createdAt: map.get("createdAt") as number,
      resolved: !!map.get("resolved"),
      resolvedBy: (map.get("resolvedBy") as string | null) ?? null,
      resolvedAt: (map.get("resolvedAt") as number | null) ?? null,
      replies: replies ? replies.toArray() : [],
      range: anchor ? resolveAnchor(this.ytext, anchor) : null,
    };
  }

  list(): CommentThread[] {
    const out: CommentThread[] = [];
    this.ymap.forEach((map) => out.push(this.read(map)));
    return out.sort((a, b) => {
      const af = a.range?.from ?? Number.MAX_SAFE_INTEGER;
      const bf = b.range?.from ?? Number.MAX_SAFE_INTEGER;
      return af - bf || a.createdAt - b.createdAt;
    });
  }

  get(id: string): CommentThread | null {
    const map = this.ymap.get(id);
    return map ? this.read(map) : null;
  }

  add(input: { from: number; to: number; body: string; author: CollabUser }): string {
    const id = newId();
    const quote = this.ytext.toString().slice(input.from, input.to);
    this.ydoc.transact(() => {
      const map = new Y.Map<unknown>();
      map.set("id", id);
      map.set("anchor", createAnchor(this.ytext, input.from, input.to));
      map.set("quote", quote);
      map.set("authorId", input.author.id);
      map.set("authorName", input.author.name);
      map.set("authorAvatar", input.author.avatar ?? null);
      map.set("body", input.body);
      map.set("createdAt", Date.now());
      map.set("resolved", false);
      map.set("replies", new Y.Array<CommentReply>());
      this.ymap.set(id, map);
    }, COMMENTS_ORIGIN);
    return id;
  }

  reply(id: string, body: string, author: CollabUser): string | null {
    const map = this.ymap.get(id);
    if (!map) return null;
    const replyId = newId();
    this.ydoc.transact(() => {
      let replies = map.get("replies") as Y.Array<CommentReply> | undefined;
      if (!replies) {
        replies = new Y.Array<CommentReply>();
        map.set("replies", replies);
      }
      replies.push([
        { id: replyId, authorId: author.id, authorName: author.name, authorAvatar: author.avatar ?? null, body, createdAt: Date.now() },
      ]);
    }, COMMENTS_ORIGIN);
    return replyId;
  }

  editBody(id: string, body: string, replyId?: string) {
    const map = this.ymap.get(id);
    if (!map) return;
    this.ydoc.transact(() => {
      if (!replyId) {
        map.set("body", body);
        return;
      }
      const replies = map.get("replies") as Y.Array<CommentReply> | undefined;
      if (!replies) return;
      const idx = replies.toArray().findIndex((r) => r.id === replyId);
      if (idx === -1) return;
      const reply = { ...replies.get(idx), body };
      replies.delete(idx, 1);
      replies.insert(idx, [reply]);
    }, COMMENTS_ORIGIN);
  }

  deleteReply(id: string, replyId: string) {
    const map = this.ymap.get(id);
    if (!map) return;
    this.ydoc.transact(() => {
      const replies = map.get("replies") as Y.Array<CommentReply> | undefined;
      if (!replies) return;
      const idx = replies.toArray().findIndex((r) => r.id === replyId);
      if (idx !== -1) replies.delete(idx, 1);
    }, COMMENTS_ORIGIN);
  }

  setResolved(id: string, resolved: boolean, by: CollabUser) {
    const map = this.ymap.get(id);
    if (!map) return;
    this.ydoc.transact(() => {
      map.set("resolved", resolved);
      map.set("resolvedBy", resolved ? by.id : null);
      map.set("resolvedAt", resolved ? Date.now() : null);
    }, COMMENTS_ORIGIN);
  }

  remove(id: string) {
    this.ydoc.transact(() => this.ymap.delete(id), COMMENTS_ORIGIN);
  }
}
