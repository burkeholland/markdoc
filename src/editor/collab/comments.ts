import * as Y from "yjs";
import { createAnchor, newId, resolveAnchor, type CollabUser, type TextAnchor } from "./shared";
import { parseMentions } from "./mentions";

export interface CommentReply {
  id: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string | null;
  /** GitHub login of the author, when known. */
  authorLogin?: string | null;
  body: string;
  createdAt: number;
  /** Set when the body was changed after creation. */
  editedAt?: number | null;
  /** Logins mentioned with `@login` in the body (lower-cased). */
  mentions: string[];
  /** Emoji → ids of the users who reacted with it. */
  reactions: Reactions;
}

/** Emoji → ids of the users who reacted with it. */
export type Reactions = Record<string, string[]>;

/** Emoji offered by the quick picker, and the order reactions are shown in. */
export const QUICK_REACTIONS = ["👍", "❤️", "🎉", "👀", "😄", "🚀"];

export interface CommentThread {
  id: string;
  anchor: TextAnchor;
  /** Text that was selected when the comment was created. */
  quote: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string | null;
  /** GitHub login of the author, when known. */
  authorLogin?: string | null;
  body: string;
  createdAt: number;
  /** Set when the body was changed after creation. */
  editedAt?: number | null;
  resolved: boolean;
  resolvedBy?: string | null;
  resolvedAt?: number | null;
  /** Logins mentioned with `@login` in the body (lower-cased). */
  mentions: string[];
  /** Emoji → ids of the users who reacted with it (on the thread's own body). */
  reactions: Reactions;
  /** Display names of everyone who reacted anywhere in the thread, by user id. */
  reactorNames: Record<string, string>;
  replies: CommentReply[];
  /** Current absolute range in the text, or null when the anchored text no longer exists. */
  range: { from: number; to: number } | null;
}

export const COMMENTS_ORIGIN = { name: "comments" };

type ThreadMap = Y.Map<unknown>;

/** Reply as stored in the Y.Array; older entries may lack `mentions`. Reactions live in the thread's `reactions` map. */
type StoredReply = Omit<CommentReply, "mentions" | "reactions"> & { mentions?: unknown };

/**
 * Reactions are one flat Y.Map per thread keyed by `<replyId or "">␟<emoji>␟<userId>` → user name.
 * Every toggle touches exactly one key, so concurrent reactions from different users (or on
 * different emoji) never conflict, and a reply stays a plain object in its Y.Array.
 */
const REACTION_SEP = "\u001f";
type ReactionsMap = Y.Map<string>;

export function reactionKey(replyId: string | null, emoji: string, userId: string): string {
  return `${replyId ?? ""}${REACTION_SEP}${emoji}${REACTION_SEP}${userId}`;
}

function sortEmoji(a: string, b: string): number {
  const ia = QUICK_REACTIONS.indexOf(a);
  const ib = QUICK_REACTIONS.indexOf(b);
  return (ia === -1 ? QUICK_REACTIONS.length : ia) - (ib === -1 ? QUICK_REACTIONS.length : ib) || a.localeCompare(b);
}

/** Group the flat reaction map by target (thread root = "") then emoji, in a stable order. */
export function readReactions(map: ReactionsMap | undefined): { byTarget: Map<string, Reactions>; names: Record<string, string> } {
  const byTarget = new Map<string, Reactions>();
  const names: Record<string, string> = {};
  if (!map) return { byTarget, names };
  const keys = Array.from(map.keys()).sort();
  for (const key of keys) {
    const [target, emoji, userId] = key.split(REACTION_SEP);
    if (emoji === undefined || userId === undefined) continue;
    let r = byTarget.get(target);
    if (!r) byTarget.set(target, (r = {}));
    (r[emoji] ??= []).push(userId);
    names[userId] = map.get(key) ?? userId;
  }
  for (const r of byTarget.values()) {
    const sorted = Object.keys(r).sort(sortEmoji);
    const copy = { ...r };
    for (const k of Object.keys(r)) delete r[k];
    for (const k of sorted) r[k] = copy[k];
  }
  return { byTarget, names };
}

function readMentions(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Normalize a stored reply so consumers always see `mentions` and `reactions` (old replies read as []/{}). */
export function readReply(r: StoredReply, reactions: Reactions = {}): CommentReply {
  return { ...r, authorLogin: r.authorLogin ?? null, editedAt: r.editedAt ?? null, mentions: readMentions(r.mentions), reactions };
}

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
    const replies = map.get("replies") as Y.Array<StoredReply> | undefined;
    const anchor = map.get("anchor") as TextAnchor;
    const { byTarget, names } = readReactions(map.get("reactions") as ReactionsMap | undefined);
    return {
      id: map.get("id") as string,
      anchor,
      quote: (map.get("quote") as string) ?? "",
      authorId: map.get("authorId") as string,
      authorName: map.get("authorName") as string,
      authorAvatar: (map.get("authorAvatar") as string | null) ?? null,
      authorLogin: (map.get("authorLogin") as string | null) ?? null,
      body: map.get("body") as string,
      createdAt: map.get("createdAt") as number,
      editedAt: (map.get("editedAt") as number | null) ?? null,
      resolved: !!map.get("resolved"),
      resolvedBy: (map.get("resolvedBy") as string | null) ?? null,
      resolvedAt: (map.get("resolvedAt") as number | null) ?? null,
      mentions: readMentions(map.get("mentions")),
      reactions: byTarget.get("") ?? {},
      reactorNames: names,
      replies: replies ? replies.toArray().map((r) => readReply(r, byTarget.get(r.id) ?? {})) : [],
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
      map.set("authorLogin", input.author.login ?? null);
      map.set("body", input.body);
      map.set("mentions", parseMentions(input.body));
      map.set("createdAt", Date.now());
      map.set("resolved", false);
      map.set("replies", new Y.Array<StoredReply>());
      map.set("reactions", new Y.Map<string>());
      this.ymap.set(id, map);
    }, COMMENTS_ORIGIN);
    return id;
  }

  reply(id: string, body: string, author: CollabUser): string | null {
    const map = this.ymap.get(id);
    if (!map) return null;
    const replyId = newId();
    this.ydoc.transact(() => {
      let replies = map.get("replies") as Y.Array<StoredReply> | undefined;
      if (!replies) {
        replies = new Y.Array<StoredReply>();
        map.set("replies", replies);
      }
      replies.push([
        {
          id: replyId,
          authorId: author.id,
          authorName: author.name,
          authorAvatar: author.avatar ?? null,
          authorLogin: author.login ?? null,
          body,
          createdAt: Date.now(),
          mentions: parseMentions(body),
        },
      ]);
    }, COMMENTS_ORIGIN);
    return replyId;
  }

  editBody(id: string, body: string, replyId?: string) {
    const map = this.ymap.get(id);
    if (!map) return;
    this.ydoc.transact(() => {
      if (!replyId) {
        if (map.get("body") !== body) map.set("editedAt", Date.now());
        map.set("body", body);
        map.set("mentions", parseMentions(body));
        return;
      }
      const replies = map.get("replies") as Y.Array<StoredReply> | undefined;
      if (!replies) return;
      const idx = replies.toArray().findIndex((r) => r.id === replyId);
      if (idx === -1) return;
      const current = replies.get(idx);
      const reply: StoredReply = { ...current, body, mentions: parseMentions(body), editedAt: current.body !== body ? Date.now() : current.editedAt ?? null };
      replies.delete(idx, 1);
      replies.insert(idx, [reply]);
    }, COMMENTS_ORIGIN);
  }

  deleteReply(id: string, replyId: string) {
    const map = this.ymap.get(id);
    if (!map) return;
    this.ydoc.transact(() => {
      const replies = map.get("replies") as Y.Array<StoredReply> | undefined;
      if (!replies) return;
      const idx = replies.toArray().findIndex((r) => r.id === replyId);
      if (idx !== -1) replies.delete(idx, 1);
      const reactions = map.get("reactions") as ReactionsMap | undefined;
      if (reactions) {
        for (const key of Array.from(reactions.keys())) {
          if (key.startsWith(replyId + REACTION_SEP)) reactions.delete(key);
        }
      }
    }, COMMENTS_ORIGIN);
  }

  /**
   * Add the user's reaction when missing, remove it when present. `replyId` null targets
   * the thread's own body. Returns the new state, or null when the target does not exist.
   */
  toggleReaction(id: string, replyId: string | null, emoji: string, user: CollabUser): boolean | null {
    const map = this.ymap.get(id);
    if (!map) return null;
    if (replyId) {
      const replies = map.get("replies") as Y.Array<StoredReply> | undefined;
      if (!replies || !replies.toArray().some((r) => r.id === replyId)) return null;
    }
    const key = reactionKey(replyId, emoji, user.id);
    let reacted = false;
    this.ydoc.transact(() => {
      let reactions = map.get("reactions") as ReactionsMap | undefined;
      if (!reactions) {
        reactions = new Y.Map<string>();
        map.set("reactions", reactions);
      }
      if (reactions.has(key)) {
        reactions.delete(key);
      } else {
        reactions.set(key, user.name);
        reacted = true;
      }
    }, COMMENTS_ORIGIN);
    return reacted;
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
