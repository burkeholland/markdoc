import * as Y from "yjs";
import { createAnchor, newId, resolveAnchor, type CollabUser, type TextAnchor } from "./shared";
import { parseMentions } from "./mentions";
import { applyOps, diffOps } from "../sync/text-diff";
import { parseSuggestionBlock } from "./suggestion-block";

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
  /** Decision on the body's ```suggestion block, if one was made. */
  suggestionState?: "accepted" | "rejected" | null;
  suggestionBy?: string | null;
  suggestionAt?: number | null;
  /** Anchored text at decision time, so decided diffs remain stable after the thread advances. */
  suggestionQuote?: string | null;
}

/** Durable per-reply decision. The containing Y.Map key is the reply id. */
export interface ReplySuggestionDecision {
  suggestionState: "accepted" | "rejected";
  suggestionBy: string;
  suggestionAt: number;
  quote: string;
}

export function readReplySuggestionDecision(replyId: string, value: unknown): (ReplySuggestionDecision & { replyId: string }) | null {
  if (!value || typeof value !== "object") return null;
  const decision = value as Partial<ReplySuggestionDecision>;
  if (
    (decision.suggestionState !== "accepted" && decision.suggestionState !== "rejected") ||
    typeof decision.suggestionBy !== "string" ||
    typeof decision.suggestionAt !== "number" ||
    typeof decision.quote !== "string"
  )
    return null;
  return { ...(decision as ReplySuggestionDecision), replyId };
}

/** Emoji → ids of the users who reacted with it. */
export type Reactions = Record<string, string[]>;

/** Emoji offered by the quick picker, and the order reactions are shown in. */
export const QUICK_REACTIONS = ["👍", "❤️", "🎉", "👀", "😄", "🚀"];

/**
 * Exactly one emoji: a pictograph (with optional variation selector, skin tone and ZWJ-joined
 * parts, e.g. 👍🏽 or 👨‍👩‍👧), a keycap (1️⃣), a flag (🇫🇷) or a tag-sequence flag (🏴󠁧󠁢󠁳󠁣󠁴󠁿). Words and
 * punctuation are not reactions.
 */
const PICTOGRAPH = "\\p{Extended_Pictographic}\\uFE0F?\\p{Emoji_Modifier}?";
export const EMOJI_RE = new RegExp(`^(?:\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?\\u20E3|${PICTOGRAPH}(?:\\u200D${PICTOGRAPH})*[\\u{E0020}-\\u{E007F}]*)$`, "u");

export function isEmoji(value: string): boolean {
  return EMOJI_RE.test(value);
}

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
  /** Decision on the body's ```suggestion block, if one was made (see suggestion-block.ts). */
  suggestionState?: "accepted" | "rejected" | null;
  suggestionBy?: string | null;
  suggestionAt?: number | null;
  /** Anchored text at decision time, so decided diffs remain stable after the thread advances. */
  suggestionQuote?: string | null;
}

export class DecidedSuggestionEditError extends Error {
  constructor(public readonly state: "accepted" | "rejected") {
    super(`Cannot edit a suggestion that was already ${state}`);
    this.name = "DecidedSuggestionEditError";
  }
}

export const COMMENTS_ORIGIN = { name: "comments" };

type ThreadMap = Y.Map<unknown>;

/** Reply as stored in the Y.Array; older entries may lack `mentions`. Reactions live in the thread's `reactions` map. */
type StoredReply = Omit<CommentReply, "mentions" | "reactions"> & { mentions?: unknown };
type ReplySuggestionsMap = Y.Map<ReplySuggestionDecision>;

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
    const replySuggestions = map.get("replySuggestions") as ReplySuggestionsMap | undefined;
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
      replies: replies
        ? replies.toArray().map((r) => {
            const reply = readReply(r, byTarget.get(r.id) ?? {});
            const decision = readReplySuggestionDecision(reply.id, replySuggestions?.get(reply.id));
            return decision
              ? {
                  ...reply,
                  suggestionState: decision.suggestionState,
                  suggestionBy: decision.suggestionBy,
                  suggestionAt: decision.suggestionAt,
                  suggestionQuote: decision.quote,
                }
              : reply;
          })
        : [],
      range: anchor ? resolveAnchor(this.ytext, anchor) : null,
      suggestionState: (map.get("suggestionState") as "accepted" | "rejected" | null) ?? null,
      suggestionBy: (map.get("suggestionBy") as string | null) ?? null,
      suggestionAt: (map.get("suggestionAt") as number | null) ?? null,
      suggestionQuote: (map.get("suggestionQuote") as string | null) ?? null,
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
      map.set("replySuggestions", new Y.Map<ReplySuggestionDecision>());
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
    const suggestionState = replyId ? this.read(map).replies.find((reply) => reply.id === replyId)?.suggestionState : map.get("suggestionState");
    if (suggestionState === "accepted" || suggestionState === "rejected") throw new DecidedSuggestionEditError(suggestionState);
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
      (map.get("replySuggestions") as ReplySuggestionsMap | undefined)?.delete(replyId);
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

  /** Restore or advance a thread's current anchored quote without changing any suggestion decisions. */
  setAnchor(id: string, anchor: TextAnchor, quote: string) {
    const map = this.ymap.get(id);
    if (!map) return;
    this.ydoc.transact(() => {
      map.set("anchor", anchor);
      map.set("quote", quote);
    }, COMMENTS_ORIGIN);
  }

  /**
   * Accept the thread's ```suggestion block: replace the anchored range with `proposed`, record the
   * decision and resolve the thread — all in one transaction (one undo step, one broadcast).
   * Returns false when the thread is missing, already decided, or outdated (anchored text ≠ quote).
   */
  acceptSuggestion(id: string, proposed: string, by: CollabUser, origin: object = COMMENTS_ORIGIN): boolean {
    const map = this.ymap.get(id);
    if (!map) return false;
    const thread = this.read(map);
    if (thread.suggestionState || !thread.range) return false;
    const { from, to } = thread.range;
    if (this.ytext.toString().slice(from, to) !== thread.quote) return false;
    const hasPendingReplySuggestion = thread.replies.some((reply) => !reply.suggestionState && parseSuggestionBlock(reply.body));
    this.ydoc.transact(() => {
      applyOps(this.ytext, diffOps(thread.quote, proposed, from));
      map.set("suggestionState", "accepted");
      map.set("suggestionBy", by.id);
      map.set("suggestionAt", Date.now());
      map.set("suggestionQuote", thread.quote);
      map.set("resolved", true);
      map.set("resolvedBy", by.id);
      map.set("resolvedAt", Date.now());
      if (hasPendingReplySuggestion) {
        map.set("anchor", createAnchor(this.ytext, from, from + proposed.length));
        map.set("quote", proposed);
      }
    }, origin);
    return true;
  }

  /** Reject the thread's suggestion: the text is untouched, the decision recorded. Allowed even when outdated. */
  rejectSuggestion(id: string, by: CollabUser, origin: object = COMMENTS_ORIGIN): boolean {
    const map = this.ymap.get(id);
    if (!map || map.get("suggestionState")) return false;
    this.ydoc.transact(() => {
      map.set("suggestionState", "rejected");
      map.set("suggestionBy", by.id);
      map.set("suggestionAt", Date.now());
      map.set("suggestionQuote", (map.get("quote") as string) ?? "");
    }, origin);
    return true;
  }

  /**
   * Accept a reply's ```suggestion block against its parent thread's anchor. Unlike accepting the
   * root suggestion, this decides only the reply; the thread and its other suggestions stay open.
   */
  acceptReplySuggestion(id: string, replyId: string, by: CollabUser, origin: object = COMMENTS_ORIGIN): boolean {
    const map = this.ymap.get(id);
    if (!map) return false;
    const thread = this.read(map);
    const reply = thread.replies.find((item) => item.id === replyId);
    if (!reply) return false;
    const block = parseSuggestionBlock(reply.body);
    if (!block || reply.suggestionState || !thread.range) return false;
    const { from, to } = thread.range;
    if (this.ytext.toString().slice(from, to) !== thread.quote) return false;
    let replySuggestions = map.get("replySuggestions") as ReplySuggestionsMap | undefined;
    if (!replySuggestions) {
      const created = new Y.Map<ReplySuggestionDecision>();
      this.ydoc.transact(() => map.set("replySuggestions", created), origin);
      replySuggestions = created;
    }
    const decisions = replySuggestions;

    this.ydoc.transact(() => {
      applyOps(this.ytext, diffOps(thread.quote, block.text, from));
      const at = Date.now();
      decisions.set(replyId, { suggestionState: "accepted", suggestionBy: by.id, suggestionAt: at, quote: thread.quote });
      map.set("anchor", createAnchor(this.ytext, from, from + block.text.length));
      map.set("quote", block.text);
    }, origin);
    return true;
  }

  /** Reject a reply's suggestion without changing the text. Allowed even when the anchor is outdated. */
  rejectReplySuggestion(id: string, replyId: string, by: CollabUser, origin: object = COMMENTS_ORIGIN): boolean {
    const map = this.ymap.get(id);
    if (!map) return false;
    const thread = this.read(map);
    const reply = thread.replies.find((item) => item.id === replyId);
    if (!reply) return false;
    if (reply.suggestionState || !parseSuggestionBlock(reply.body)) return false;
    let replySuggestions = map.get("replySuggestions") as ReplySuggestionsMap | undefined;
    if (!replySuggestions) {
      const created = new Y.Map<ReplySuggestionDecision>();
      this.ydoc.transact(() => map.set("replySuggestions", created), origin);
      replySuggestions = created;
    }
    const decisions = replySuggestions;

    this.ydoc.transact(() => {
      const at = Date.now();
      decisions.set(replyId, { suggestionState: "rejected", suggestionBy: by.id, suggestionAt: at, quote: thread.quote });
    }, origin);
    return true;
  }
}
