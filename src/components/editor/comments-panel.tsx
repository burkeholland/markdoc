"use client";

import { cloneElement, createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { markRefsRead, useUnreadRefs } from "@/lib/notifications-store";
import { ArrowRight, Bot, Check, CheckCheck, ChevronDown, ChevronRight, MessageSquare, MoreHorizontal, Reply, RotateCcw, SmilePlus, Trash2, X, Pencil, Sparkles, ThumbsDown, ThumbsUp, Wand2 } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { QUICK_REACTIONS, type CommentReply, type CommentThread, type Reactions } from "@/editor/collab/comments";
import type { ResolvedSuggestion } from "@/editor/collab/suggestions";
import { agentMentionLogin, mentionTriggerAt } from "@/editor/collab/mentions";
import { renderCommentBody, wrapLink, wrapSelection } from "@/editor/collab/comment-markdown";
import { isSuggestionOutdated, parseSuggestionBlock, reviewSummaryLabel, reviewVerdictLabel, suggestionBlockFor, type SuggestionBlock } from "@/editor/collab/suggestion-block";
import { wordDiff } from "@/editor/diff";
import type { ReviewDto } from "@/server/reviews";
import { Avatar, EmptyState, Menu, MenuContent, MenuItem, MenuTrigger, Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";
import { jsonEqual, useSessionValue } from "./use-session";
import "./comments.css";

type Tab = "open" | "resolved" | "suggestions";

/** Someone who can be @mentioned: present in the document, a collaborator, or an agent (present or recently active). */
export interface MentionCandidate {
  /** What follows `@` when picked; for agents `<ownerLogin>/<slug>`. */
  login: string;
  name: string;
  image: string | null;
  /** Set for agents (API tokens): the login of the user the token acts for. */
  agent?: { ownerLogin: string } | null;
}

/** Candidates matching a picker query: login or name prefix; agents also by their slug. Humans first, then agents. */
export function filterMentionCandidates(candidates: MentionCandidate[], query: string, max: number): MentionCandidate[] {
  const q = query.toLowerCase();
  const hit = (c: MentionCandidate) => {
    if (c.login.toLowerCase().startsWith(q) || c.name.toLowerCase().startsWith(q)) return true;
    if (!c.agent) return false;
    const slug = c.login.slice(c.login.indexOf("/") + 1).toLowerCase();
    return slug.startsWith(q) || slug.replace(/-/g, " ").startsWith(q);
  };
  const humans = candidates.filter((c) => !c.agent && hit(c));
  const agents = candidates.filter((c) => c.agent && hit(c));
  return [...humans, ...agents].slice(0, max);
}

/** Renders a comment body: inline Markdown plus `@login` chips. A ```suggestion block is lifted out (see SuggestionBox). */
export function MentionBody({ body, className }: { body: string; className?: string }) {
  const content = useMemo(() => renderCommentBody(parseSuggestionBlock(body)?.prose ?? body), [body]);
  if (content === null) return null;
  return (
    <div className={cn("comment-body", className)} data-testid="comment-body">
      {content}
    </div>
  );
}

/** Compact word-level diff of the quoted text → the proposed text (same renderer as version compare). */
export function SuggestionDiff({ from, to }: { from: string; to: string }) {
  const parts = useMemo(() => wordDiff(from, to), [from, to]);
  return (
    <div className="suggestion-diff" data-testid="suggestion-diff">
      {parts.map((c, i) => (c.added ? <ins key={i}>{c.value}</ins> : c.removed ? <del key={i}>{c.value}</del> : <span key={i}>{c.value}</span>))}
      {to === "" && from !== "" && <span className="ml-1 text-xs italic text-ink-4">(deletes the text)</span>}
    </div>
  );
}

type CommentSuggestionState = "pending" | "accepted" | "rejected" | "outdated";

interface CommentSuggestionTarget {
  thread: CommentThread;
  reply: CommentReply | null;
  block: SuggestionBlock;
  state: CommentSuggestionState;
}

function commentSuggestionState(thread: CommentThread, stored: CommentReply["suggestionState"] | CommentThread["suggestionState"], text: string): CommentSuggestionState {
  return stored ?? (isSuggestionOutdated(thread, text) ? "outdated" : "pending");
}

function commentSuggestionSource(
  thread: CommentThread,
  target: Pick<CommentThread, "suggestionState" | "suggestionQuote"> | Pick<CommentReply, "suggestionState" | "suggestionQuote">,
): string {
  return target.suggestionState ? (target.suggestionQuote ?? thread.quote) : thread.quote;
}

/** Root and reply suggestion blocks in display order, with each reply retaining its own decision. */
function commentSuggestionTargets(threads: CommentThread[], text: string): CommentSuggestionTarget[] {
  return threads.flatMap((thread) => {
    const targets: CommentSuggestionTarget[] = [];
    const root = parseSuggestionBlock(thread.body);
    if (root) targets.push({ thread, reply: null, block: root, state: commentSuggestionState(thread, thread.suggestionState, text) });
    for (const reply of thread.replies) {
      const block = parseSuggestionBlock(reply.body);
      if (block) targets.push({ thread, reply, block, state: commentSuggestionState(thread, reply.suggestionState, text) });
    }
    return targets;
  });
}

function SuggestionActions({
  state,
  canAccept,
  canReject,
  onAccept,
  onReject,
}: {
  state: CommentSuggestionState;
  canAccept: boolean;
  canReject: boolean;
  onAccept: () => void | Promise<void>;
  onReject: () => void | Promise<unknown>;
}) {
  if ((state !== "pending" && state !== "outdated") || (!canAccept && !canReject)) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" onClick={(event) => event.stopPropagation()} data-testid="suggestion-actions">
      {canAccept && (
        <button
          type="button"
          className="btn btn-sm btn-primary shrink-0 gap-1.5 whitespace-nowrap"
          disabled={state === "outdated"}
          onClick={() => void onAccept()}
          data-testid="suggestion-accept-comment"
        >
          <Check size={13} /> Accept suggestion
        </button>
      )}
      {canReject && (
        <button type="button" className="btn btn-sm btn-outline shrink-0 gap-1.5 whitespace-nowrap" onClick={() => void onReject()} data-testid="suggestion-reject-comment">
          <X size={13} /> Reject
        </button>
      )}
    </div>
  );
}

/** Review card author label: token name for agents, display name for humans. */
function verdictTone(verdict: ReviewDto["verdict"]): string {
  return verdict === "approve" ? "text-success" : verdict === "request_changes" ? "text-amber-700 dark:text-amber-300" : "text-ink-2";
}

/** "(edited)" with the edit time as a tooltip. */
function EditedMarker({ at }: { at?: number | null }) {
  if (!at) return null;
  return (
    <span className="shrink-0 text-xs italic text-ink-4" title={`Edited ${new Date(at).toLocaleString()}`} data-testid="comment-edited">
      (edited)
    </span>
  );
}

/**
 * Mounts a Radix Popover/DropdownMenu root only once the user reaches for its trigger. A Radix root is
 * ~20 fibers (Popper, Presence, DismissableLayer, FocusScope…) even while closed; the comments panel has
 * one menu and one reaction picker per thread and per reply — 150 roots for Burke's 15 threads, which
 * was most of the panel-open time (task #487). Until armed, `trigger` is rendered as a plain button
 * that arms on hover and arms-and-opens on pointer down / Enter / Space / ArrowDown, so the first
 * interaction behaves exactly like the Radix trigger. Once armed it stays mounted (focus return, etc.).
 */
function useLazyTrigger() {
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  const plainProps = useMemo(
    () => ({
      "aria-haspopup": "menu" as const,
      "aria-expanded": false,
      onPointerEnter: () => setArmed(true),
      onPointerDown: (e: React.PointerEvent) => {
        if (e.button !== 0 || e.ctrlKey) return;
        setArmed(true);
        setOpen(true);
      },
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key !== "Enter" && e.key !== " " && e.key !== "ArrowDown") return;
        e.preventDefault();
        setArmed(true);
        setOpen(true);
      },
    }),
    [],
  );
  return { armed, open, setOpen, plainProps };
}

function LazyMenu({ trigger, children, ...content }: { trigger: React.ReactElement<React.ComponentProps<"button">>; children: React.ReactNode } & Omit<React.ComponentProps<typeof MenuContent>, "children">) {
  const { armed, open, setOpen, plainProps } = useLazyTrigger();
  if (!armed) return cloneElement(trigger, plainProps);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>{trigger}</MenuTrigger>
      <MenuContent {...content}>{children}</MenuContent>
    </Menu>
  );
}

/** Reaction chips plus the quick picker for one thread body or reply. */
function ReactionRow({
  reactions,
  names,
  me,
  canReact,
  onToggle,
}: {
  reactions: Reactions;
  names: Record<string, string>;
  me: string;
  canReact: boolean;
  onToggle: (emoji: string) => void;
}) {
  const { armed, open, setOpen, plainProps } = useLazyTrigger();
  const entries = Object.entries(reactions).filter(([, ids]) => ids.length > 0);
  if (entries.length === 0 && !canReact) return null;
  const addButton = (
    <button type="button" className="reaction-add" aria-label="Add reaction" title="Add reaction" data-testid="reaction-add">
      <SmilePlus size={14} />
    </button>
  );
  return (
    <div className="reaction-row" onClick={(e) => e.stopPropagation()} data-testid="reaction-row">
      {entries.map(([emoji, ids]) => {
        const mine = ids.includes(me);
        return (
          <button
            key={emoji}
            type="button"
            className="reaction-chip"
            data-mine={mine ? "true" : undefined}
            data-emoji={emoji}
            title={ids.map((id) => names[id] ?? id).join(", ")}
            aria-pressed={mine}
            aria-label={`${emoji} ${ids.length}`}
            disabled={!canReact}
            onClick={() => onToggle(emoji)}
            data-testid="reaction-chip"
          >
            <span>{emoji}</span> <span className="reaction-count">{ids.length}</span>
          </button>
        );
      })}
      {canReact &&
        (!armed ? (
          cloneElement(addButton, { ...plainProps, "aria-haspopup": "dialog" })
        ) : (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>{addButton}</PopoverTrigger>
            <PopoverContent side="top" align="start" className="p-1" data-testid="reaction-picker">
              <div className="reaction-picker" role="group" aria-label="Pick a reaction">
                {QUICK_REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    data-mine={reactions[emoji]?.includes(me) ? "true" : undefined}
                    aria-label={`React with ${emoji}`}
                    onClick={() => {
                      onToggle(emoji);
                      setOpen(false);
                    }}
                    data-testid="reaction-option"
                    data-emoji={emoji}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        ))}
    </div>
  );
}

/** Collaborators and recently active agents of the document, fetched once while the panel is open, merged with who is present. */
function useMentionCandidates(session: CollabSession): MentionCandidate[] {
  const [collaborators, setCollaborators] = useState<MentionCandidate[]>([]);
  const [knownAgents, setKnownAgents] = useState<MentionCandidate[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.documents
      .collaborators(session.docId)
      .then((res) => {
        if (cancelled) return;
        const list: MentionCandidate[] = [];
        if (res.owner?.login) list.push({ login: res.owner.login, name: res.owner.name ?? res.owner.login, image: res.owner.image });
        for (const c of res.collaborators) list.push({ login: c.login, name: c.name ?? c.login, image: c.image });
        setCollaborators(list);
        setKnownAgents((res.agents ?? []).map((a) => ({ login: a.login, name: a.name, image: null, agent: { ownerLogin: a.ownerLogin } })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session.docId]);
  const present = useSessionValue(
    session,
    (s) =>
      s
        .presence()
        .filter((u) => !u.isLocal && (u.isAgent ? u.ownerLogin : u.login))
        .map((u): MentionCandidate =>
          u.isAgent
            ? { login: agentMentionLogin(u.ownerLogin!, u.name), name: u.name, image: null, agent: { ownerLogin: u.ownerLogin! } }
            : { login: u.login!, name: u.name, image: u.avatar ?? null },
        ),
    jsonEqual,
  );
  return useMemo(() => {
    const seen = new Set<string>();
    const out: MentionCandidate[] = [];
    const me = session.user.login?.toLowerCase();
    // Your own agent stays in the list even though you are not: it is the agent that needs the mention.
    for (const c of [...present, ...collaborators, ...knownAgents]) {
      const key = c.login.toLowerCase();
      if (key === me || seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  }, [present, collaborators, knownAgents, session.user.login]);
}

const MAX_SUGGESTIONS = 6;

/**
 * Mention candidates reach the composers through context rather than as a ThreadCard prop: the list
 * arrives a moment after the panel opens (collaborators fetch) and would otherwise re-render every
 * memoised card for a value only an open composer reads.
 */
const MentionCandidatesContext = createContext<MentionCandidate[]>([]);

/** Avatar for a comment/suggestion author; agents (API tokens) get a bot badge. */
function AuthorAvatar({ id, name, src, size }: { id: string; name: string; src?: string | null; size: number }) {
  if (id.startsWith("agent:")) {
    return (
      <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700 ring-2 ring-surface dark:bg-violet-950 dark:text-violet-300" style={{ width: size, height: size }} title={`${name} (agent)`}>
        <Bot size={Math.round(size * 0.55)} />
      </span>
    );
  }
  return <Avatar name={name} src={src} size={size} />;
}

export interface CommentsPanelProps {
  session: CollabSession;
  onClose: () => void;
  onReveal: (offset: number) => void;
  /** Called when the pending (new-comment) composer is posted or cancelled, so focus can return to the editor. */
  onPendingDone?: () => void;
  /** Opens the "Ask an agent" dialog (empty-state hint). */
  onAskAgent?: () => void;
  /** Switch to a tab from outside; bump `nonce` to switch again to the same tab. */
  focusTab?: { tab: "open" | "resolved" | "suggestions"; nonce: number } | null;
  /** Shell toast (Accept suggestion offers Undo). */
  onToast?: (message: string, kind?: "info" | "success" | "error", action?: { label: string; onClick?: () => void }) => void;
}

/** Writes comment changes either to the shared doc (editors) or through the API (commenters). */
function useCommentOps(session: CollabSession) {
  const viaApi = session.commentsViaApi;
  const id = session.docId;
  return useMemo(
    () => ({
      async add(from: number, to: number, body: string) {
        if (viaApi) return (await api.documents.comment(id, { action: "add", from, to, body })).id ?? null;
        return session.comments.add({ from, to, body, author: session.user });
      },
      /** Accept the thread's suggestion block. Editors apply it locally (one undo step); returns false when it could not be applied. */
      async acceptSuggestion(threadId: string, proposed: string, replyId?: string): Promise<boolean> {
        if (viaApi) {
          await api.documents.comment(id, { action: "suggestion", threadId, replyId, decision: "accept" });
          return true;
        }
        return session.acceptCommentSuggestion(threadId, proposed, replyId);
      },
      async rejectSuggestion(threadId: string, replyId?: string): Promise<boolean> {
        if (viaApi) {
          await api.documents.comment(id, { action: "suggestion", threadId, replyId, decision: "reject" });
          return true;
        }
        if (replyId) return session.comments.rejectReplySuggestion(threadId, replyId, session.user);
        return session.comments.rejectSuggestion(threadId, session.user);
      },
      async reply(threadId: string, body: string) {
        if (viaApi) return api.documents.comment(id, { action: "reply", threadId, body });
        session.comments.reply(threadId, body, session.user);
      },
      async resolve(threadId: string, resolved: boolean) {
        if (viaApi) return api.documents.comment(id, { action: "resolve", threadId, resolved });
        session.comments.setResolved(threadId, resolved, session.user);
      },
      async edit(threadId: string, body: string, replyId?: string) {
        if (viaApi) return api.documents.comment(id, { action: "edit", threadId, replyId, body });
        session.comments.editBody(threadId, body, replyId);
      },
      async remove(threadId: string, replyId?: string) {
        if (viaApi) return api.documents.comment(id, { action: "delete", threadId, replyId });
        if (replyId) session.comments.deleteReply(threadId, replyId);
        else session.comments.remove(threadId);
      },
      async react(threadId: string, replyId: string | null, emoji: string) {
        if (viaApi) return api.documents.comment(id, { action: "react", threadId, replyId: replyId ?? undefined, emoji });
        session.comments.toggleReaction(threadId, replyId, emoji, session.user);
      },
    }),
    [session, viaApi, id],
  );
}

function Composer({
  placeholder,
  autoFocus,
  onSubmit,
  onCancel,
  submitLabel = "Comment",
  initial = "",
  quote,
}: {
  placeholder: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => void | Promise<unknown>;
  onCancel?: () => void;
  submitLabel?: string;
  initial?: string;
  /** Anchored text; when set, "Suggest a change" (Ctrl+Shift+S) inserts a ```suggestion block pre-filled with it. */
  quote?: string;
}) {
  const candidates = useContext(MentionCandidatesContext);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    // A frame later: a closing menu (Edit…) hands focus back to its trigger first.
    const raf = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [autoFocus]);

  /** Insert a suggestion block for the quoted text and select its contents so typing replaces them. */
  const insertSuggestion = () => {
    const el = ref.current;
    if (quote === undefined || parseSuggestionBlock(value)) return;
    const next = suggestionBlockFor(quote, value);
    setValue(next);
    setTrigger(null);
    const start = next.lastIndexOf(quote);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start, start + quote.length);
    });
  };

  /** Apply a formatting shortcut to the textarea selection and restore the selection afterwards. */
  const applyFormat = (kind: "bold" | "italic" | "code" | "link") => {
    const el = ref.current;
    if (!el) return;
    const { selectionStart, selectionEnd } = el;
    const r =
      kind === "link"
        ? wrapLink(el.value, selectionStart, selectionEnd)
        : wrapSelection(el.value, selectionStart, selectionEnd, kind === "bold" ? "**" : kind === "italic" ? "*" : "`");
    setValue(r.value);
    setTrigger(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(r.selectionStart, r.selectionEnd);
    });
  };

  const matches = useMemo(() => (trigger ? filterMentionCandidates(candidates, trigger.query, MAX_SUGGESTIONS) : []), [trigger, candidates]);
  const open = trigger !== null && matches.length > 0;

  /** Re-evaluate whether the caret is in an `@` token. */
  const syncTrigger = useCallback((el: HTMLTextAreaElement) => {
    setHighlight(0);
    if (el.selectionStart !== el.selectionEnd) {
      setTrigger(null);
      return;
    }
    setTrigger(mentionTriggerAt(el.value, el.selectionStart));
  }, []);

  const pick = (c: MentionCandidate) => {
    const el = ref.current;
    if (!el || !trigger) return;
    const caret = el.selectionStart;
    const insert = `@${c.login} `;
    const next = value.slice(0, trigger.start) + insert + value.slice(caret);
    setValue(next);
    setTrigger(null);
    const pos = trigger.start + insert.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const submit = async () => {
    const body = value.trim();
    if (!body) return;
    setBusy(true);
    try {
      await onSubmit(body);
      setValue("");
      setTrigger(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="@container flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
      <Popover open={open} onOpenChange={(o) => !o && setTrigger(null)}>
        <PopoverAnchor asChild>
          <textarea
            ref={ref}
            className="textarea min-h-[64px] resize-none text-[13px]"
            placeholder={placeholder}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              syncTrigger(e.target);
            }}
            onSelect={(e) => syncTrigger(e.currentTarget)}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              setTimeout(() => setTrigger(null), 120);
            }}
            onKeyDown={(e) => {
              const mod = e.metaKey || e.ctrlKey;
              if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "s" && quote !== undefined) {
                e.preventDefault();
                e.stopPropagation();
                insertSuggestion();
                return;
              }
              // Formatting shortcuts belong to the composer; never let the editor's Ctrl+K / Ctrl+B handlers see them.
              if (mod && !e.altKey && !e.shiftKey) {
                const key = e.key.toLowerCase();
                const kind = key === "b" ? "bold" : key === "i" ? "italic" : key === "e" ? "code" : key === "k" ? "link" : null;
                if (kind) {
                  e.preventDefault();
                  e.stopPropagation();
                  applyFormat(kind);
                  return;
                }
              }
              if (open) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlight((h) => (h + 1) % matches.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlight((h) => (h - 1 + matches.length) % matches.length);
                  return;
                }
                if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
                  e.preventDefault();
                  pick(matches[highlight] ?? matches[0]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setTrigger(null);
                  return;
                }
              }
              // Enter sends, Shift+Enter inserts a newline (Ctrl/⌘+Enter still sends).
              if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
                e.preventDefault();
                e.stopPropagation();
                void submit();
              }
              if (e.key === "Escape" && onCancel) onCancel();
            }}
            data-testid="comment-composer"
          />
        </PopoverAnchor>
        <PopoverContent
          side="bottom"
          align="start"
          className="w-64 p-1.5"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (e.target === ref.current) e.preventDefault();
          }}
          data-testid="mention-suggestions"
        >
          <ul role="listbox" aria-label="Mention someone">
            {matches.map((c, i) => (
              <li
                key={c.login}
                role="option"
                aria-selected={i === highlight}
                className={cn("menu-item py-1.5", i === highlight && "bg-surface-3")}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(c)}
                data-testid="mention-option"
                data-login={c.login}
                data-agent={c.agent ? "" : undefined}
              >
                {c.agent ? <AuthorAvatar id="agent:" name={c.name} size={20} /> : <Avatar name={c.name} src={c.image} size={20} />}
                <span className="min-w-0 flex-1 truncate text-[13px]">{c.name}</span>
                {c.agent ? (
                  <span className="truncate text-xs text-ink-4" title={`Agent of @${c.agent.ownerLogin}`}>
                    agent
                  </span>
                ) : (
                  <span className="truncate text-xs text-ink-3">@{c.login}</span>
                )}
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
      {/* Always laid out, so the buttons do not move while focus leaves the textarea (a moving button swallows the click). */}
      <div className="comment-format-hint" data-visible={focused ? "true" : "false"} aria-hidden data-testid="comment-format-hint">
        <span>
          <kbd>Ctrl/⌘ B</kbd> **bold**
        </span>
        <span>
          <kbd>I</kbd> *italic*
        </span>
        <span>
          <kbd>E</kbd> `code`
        </span>
        <span>
          <kbd>K</kbd> [link](url)
        </span>
        <span>@mention · Enter sends · Shift+Enter newline</span>
      </div>
      {/* One row, single-line labels: below ~21rem of composer width (the 340 px panel) "Suggest a change"
          is icon-only — the tooltip and aria-label carry the name — so the three buttons never wrap. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {quote !== undefined && (
          <button
            type="button"
            className="btn btn-ghost btn-sm mr-auto min-w-8 gap-1.5 whitespace-nowrap px-2 @min-[21rem]:px-3"
            onClick={insertSuggestion}
            disabled={parseSuggestionBlock(value) !== null}
            title="Suggest a change (Ctrl+Shift+S)"
            aria-label="Suggest a change"
            data-testid="comment-suggest-change"
          >
            <Wand2 size={13} /> <span className="hidden @min-[21rem]:inline">Suggest a change</span>
          </button>
        )}
        {onCancel && (
          <button type="button" className="btn btn-ghost btn-sm whitespace-nowrap" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="btn btn-primary btn-sm whitespace-nowrap" disabled={!value.trim() || busy} onClick={() => void submit()} data-testid="comment-submit">
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

const ThreadCard = memo(function ThreadCard({
  thread,
  session,
  text,
  active,
  onReveal,
  ops,
  unread,
  onToast,
}: {
  thread: CommentThread;
  session: CollabSession;
  text: string;
  active: boolean;
  onReveal: (offset: number) => void;
  ops: ReturnType<typeof useCommentOps>;
  /** The current user has unread notifications about this thread. */
  unread?: boolean;
  onToast?: CommentsPanelProps["onToast"];
}) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); // "root" or reply id
  const me = session.user.id;
  const canModerate = session.role === "owner";
  const canComment = session.canComment;
  const canEdit = session.role === "owner" || session.role === "editor";
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);
  // Opening the thread reads every notification about it (the thread itself and its replies).
  const replyIds = thread.replies.map((r) => r.id).join(",");
  useEffect(() => {
    if (active && unread) void markRefsRead(session.docId, [thread.id, ...replyIds.split(",").filter(Boolean)]);
  }, [active, unread, session.docId, thread.id, replyIds]);

  const suggestion = useMemo(() => parseSuggestionBlock(thread.body), [thread.body]);
  const suggestionState = suggestion ? commentSuggestionState(thread, thread.suggestionState, text) : null;

  const accept = async (block: SuggestionBlock, reply: CommentReply | null = null) => {
    const ok = await ops.acceptSuggestion(thread.id, block.text, reply?.id);
    if (!ok) {
      onToast?.("The quoted text changed — this suggestion is outdated.", "error");
      return;
    }
    onToast?.(`Accepted suggestion from ${reply?.authorName ?? thread.authorName}.`, "success", { label: "Undo", onClick: () => session.undo() });
  };

  return (
    <div
      ref={ref}
      className={cn(
        "relative rounded-xl border bg-surface p-3 transition-shadow",
        active ? "border-accent shadow-md shadow-accent/10" : "border-line hover:border-line-2",
        thread.resolved && "opacity-80",
      )}
      data-unread={unread || undefined}
      data-suggestion={suggestionState ?? undefined}
      onClick={() => {
        session.setActiveComment(thread.id);
        if (thread.range) onReveal(thread.range.from);
      }}
      data-testid="comment-thread"
      data-thread-id={thread.id}
    >
      {unread && <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-accent" aria-label="Unread activity" data-testid="thread-unread-dot" />}
      {thread.quote && (
        <div className="mb-2 truncate border-l-2 border-amber-400 pl-2 text-xs text-ink-3" title={thread.quote}>
          {thread.range ? thread.quote : <span className="italic">(original text removed) </span>}
        </div>
      )}
      <div className="flex items-start gap-2.5">
        <AuthorAvatar id={thread.authorId} name={thread.authorName} src={thread.authorAvatar} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-semibold text-ink">{thread.authorName}</span>
            <span className="shrink-0 text-xs text-ink-4">{relativeTime(thread.createdAt)}</span>
            <EditedMarker at={thread.editedAt} />
          </div>
          {editing === "root" && !thread.suggestionState ? (
            <div className="mt-1">
              <Composer
                placeholder="Edit comment"
                initial={thread.body}
                autoFocus
                submitLabel="Save"
                onSubmit={async (body) => {
                  await ops.edit(thread.id, body);
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            </div>
          ) : (
            <>
              <MentionBody body={thread.body} className="mt-0.5 text-[13px] leading-5 text-ink-2" />
              {suggestion && suggestionState && (
                <div className="suggestion-box mt-2" onClick={(e) => e.stopPropagation()} data-testid="suggestion-box" data-state={suggestionState}>
                  <div className="suggestion-box-head">
                    <Wand2 size={12} aria-hidden />
                    <span>Suggested change</span>
                    {suggestionState === "outdated" && (
                      <span className="suggestion-badge" data-testid="suggestion-outdated" title="The quoted text changed since this was suggested">
                        Outdated
                      </span>
                    )}
                    {suggestionState === "accepted" && <span className="suggestion-badge suggestion-badge-ok">Accepted</span>}
                    {suggestionState === "rejected" && <span className="suggestion-badge">Rejected</span>}
                    {suggestion.warning && <span className="ml-auto text-[11px] text-ink-4">{suggestion.warning}</span>}
                  </div>
                  <SuggestionDiff from={commentSuggestionSource(thread, thread)} to={suggestion.text} />
                  <SuggestionActions
                    state={suggestionState}
                    canAccept={canEdit}
                    canReject={canComment}
                    onAccept={() => accept(suggestion)}
                    onReject={() => ops.rejectSuggestion(thread.id)}
                  />
                </div>
              )}
              <ReactionRow reactions={thread.reactions} names={thread.reactorNames} me={me} canReact={canComment} onToggle={(emoji) => void ops.react(thread.id, null, emoji)} />
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          {canComment && (
            <button
              type="button"
              className="icon-btn h-7 w-7"
              title={thread.resolved ? "Re-open" : "Resolve"}
              aria-label={thread.resolved ? "Re-open" : "Resolve"}
              onClick={() => void ops.resolve(thread.id, !thread.resolved)}
              data-testid="comment-resolve"
            >
              {thread.resolved ? <RotateCcw size={15} /> : <Check size={16} />}
            </button>
          )}
          {(thread.authorId === me || canModerate) && (
            <LazyMenu
              align="end"
              className="w-40"
              trigger={
                <button type="button" className="icon-btn h-7 w-7" aria-label="Comment actions">
                  <MoreHorizontal size={16} />
                </button>
              }
            >
              {thread.authorId === me && !thread.suggestionState && (
                <MenuItem icon={<Pencil size={14} />} onSelect={() => setEditing("root")}>
                  Edit
                </MenuItem>
              )}
              <MenuItem icon={<Trash2 size={14} />} className="text-danger" onSelect={() => void ops.remove(thread.id)}>
                Delete thread
              </MenuItem>
            </LazyMenu>
          )}
        </div>
      </div>

      {thread.replies.length > 0 && (
        <div className="mt-3 flex flex-col gap-3 border-l border-line pl-3">
          {thread.replies.map((r) => {
            const block = parseSuggestionBlock(r.body);
            const state = block ? commentSuggestionState(thread, r.suggestionState, text) : null;
            return (
              <div key={r.id} className="flex items-start gap-2.5" data-testid="comment-reply" data-reply-id={r.id} data-state={state ?? undefined}>
                <AuthorAvatar id={r.authorId} name={r.authorName} src={r.authorAvatar} size={24} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[13px] font-semibold text-ink">{r.authorName}</span>
                    <span className="shrink-0 text-xs text-ink-4">{relativeTime(r.createdAt)}</span>
                    <EditedMarker at={r.editedAt} />
                  </div>
                  {editing === r.id && !r.suggestionState ? (
                    <div className="mt-1">
                      <Composer
                        placeholder="Edit reply"
                        initial={r.body}
                        autoFocus
                        submitLabel="Save"
                        onSubmit={async (body) => {
                          await ops.edit(thread.id, body, r.id);
                          setEditing(null);
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    </div>
                  ) : (
                    <>
                      <MentionBody body={r.body} className="mt-0.5 text-[13px] leading-5 text-ink-2" />
                      {block && state && (
                        <div className="suggestion-box mt-1.5" onClick={(event) => event.stopPropagation()} data-testid="suggestion-box" data-state={state}>
                          <div className="suggestion-box-head">
                            <Wand2 size={12} aria-hidden />
                            <span>Suggested change</span>
                            {state === "outdated" && (
                              <span className="suggestion-badge" data-testid="suggestion-outdated" title="The quoted text changed since this was suggested">
                                Outdated
                              </span>
                            )}
                            {state === "accepted" && <span className="suggestion-badge suggestion-badge-ok">Accepted</span>}
                            {state === "rejected" && <span className="suggestion-badge">Rejected</span>}
                            {block.warning && <span className="ml-auto text-[11px] text-ink-4">{block.warning}</span>}
                          </div>
                          <SuggestionDiff from={commentSuggestionSource(thread, r)} to={block.text} />
                          <SuggestionActions
                            state={state}
                            canAccept={canEdit}
                            canReject={canComment}
                            onAccept={() => accept(block, r)}
                            onReject={() => ops.rejectSuggestion(thread.id, r.id)}
                          />
                        </div>
                      )}
                      <ReactionRow reactions={r.reactions} names={thread.reactorNames} me={me} canReact={canComment} onToggle={(emoji) => void ops.react(thread.id, r.id, emoji)} />
                    </>
                  )}
                </div>
                {(r.authorId === me || canModerate) && (
                  <div onClick={(e) => e.stopPropagation()}>
                    <LazyMenu
                      align="end"
                      className="w-36"
                      trigger={
                        <button type="button" className="icon-btn h-6 w-6" aria-label="Reply actions">
                          <MoreHorizontal size={14} />
                        </button>
                      }
                    >
                      {r.authorId === me && !r.suggestionState && (
                        <MenuItem icon={<Pencil size={14} />} onSelect={() => setEditing(r.id)}>
                          Edit
                        </MenuItem>
                      )}
                      <MenuItem icon={<Trash2 size={14} />} className="text-danger" onSelect={() => void ops.remove(thread.id, r.id)}>
                        Delete
                      </MenuItem>
                    </LazyMenu>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {canComment && !thread.resolved && (
        <div className="mt-3" onClick={(e) => e.stopPropagation()}>
          {replying ? (
            <Composer
              placeholder="Reply…"
              autoFocus
              submitLabel="Reply"
              quote={thread.range ? thread.quote : undefined}
              onSubmit={async (body) => {
                await ops.reply(thread.id, body);
                setReplying(false);
              }}
              onCancel={() => setReplying(false)}
            />
          ) : (
            <button type="button" className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-3 hover:text-accent" onClick={() => setReplying(true)} data-testid="comment-reply">
              <Reply size={13} /> Reply
            </button>
          )}
        </div>
      )}
      {thread.resolved && (
        <div className="mt-2 inline-flex items-center gap-1 text-xs text-success">
          <CheckCheck size={13} /> Resolved {thread.resolvedAt ? relativeTime(thread.resolvedAt) : ""}
        </div>
      )}
    </div>
  );
});

function SuggestionCard({ s, session, active, onReveal }: { s: ResolvedSuggestion; session: CollabSession; active: boolean; onReveal: (offset: number) => void }) {
  const canAct = session.role === "owner" || session.role === "editor";
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);
  const text = session.ytext.toString().slice(s.from, s.to);
  return (
    <div
      ref={ref}
      className={cn("rounded-xl border bg-surface p-3", active ? "border-accent shadow-md shadow-accent/10" : "border-line hover:border-line-2")}
      onClick={() => {
        session.setActiveSuggestion(s.id);
        onReveal(s.from);
      }}
      data-testid="suggestion-card"
      data-suggestion-id={s.id}
    >
      <div className="flex items-start gap-2.5">
        <AuthorAvatar id={s.authorId} name={s.authorName} src={s.authorAvatar} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-semibold text-ink">{s.authorName}</span>
            <span className="shrink-0 text-xs text-ink-4">{relativeTime(s.createdAt)}</span>
          </div>
          <p className="mt-0.5 text-[13px] leading-5 text-ink-2">
            <span className="font-medium">{s.type === "insert" ? "Add" : "Delete"}:</span>{" "}
            <span className={cn("rounded px-1", s.type === "insert" ? "bg-green-50 text-green-800 dark:bg-green-950/50 dark:text-green-300" : "bg-red-50 line-through text-red-800 dark:bg-red-950/50 dark:text-red-300")}>
              {text.length > 120 ? text.slice(0, 120) + "…" : text || "(whitespace)"}
            </span>
          </p>
        </div>
      </div>
      {canAct && (
        <div className="mt-2.5 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="btn btn-sm btn-outline gap-1.5 text-success" onClick={() => session.suggestions.accept(s.id)} data-testid="suggestion-accept">
            <ThumbsUp size={14} /> Accept
          </button>
          <button type="button" className="btn btn-sm btn-outline gap-1.5 text-danger" onClick={() => session.suggestions.reject(s.id)} data-testid="suggestion-reject">
            <ThumbsDown size={14} /> Reject
          </button>
        </div>
      )}
    </div>
  );
}

/** One agent/human review: verdict + summary, expandable to its threads, Accept all / Reject all on the pending suggestions. */
function ReviewCard({ review, threads, session, text, ops, onToast }: { review: ReviewDto; threads: CommentThread[]; session: CollabSession; text: string; ops: ReturnType<typeof useCommentOps>; onToast?: CommentsPanelProps["onToast"] }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const canEdit = session.role === "owner" || session.role === "editor";
  const mine = threads.filter((t) => review.threadIds.includes(t.id));
  const withSuggestion = commentSuggestionTargets(mine, text);
  const pending = withSuggestion.filter((target) => target.state === "pending" || target.state === "outdated");
  const applicable = pending.filter((target) => target.state === "pending");

  /** Each suggestion is its own transaction (its own undo step); failures are counted, not fatal. */
  const decideAll = async (accept: boolean) => {
    setBusy(true);
    let done = 0;
    let failed = 0;
    try {
      for (const { thread, reply, block } of accept ? applicable : pending) {
        try {
          const ok = accept ? await ops.acceptSuggestion(thread.id, block.text, reply?.id) : await ops.rejectSuggestion(thread.id, reply?.id);
          if (ok) done++;
          else failed++;
        } catch {
          failed++;
        }
      }
    } finally {
      setBusy(false);
    }
    const skipped = accept ? pending.length - applicable.length : 0;
    const tail = [failed ? `${failed} failed` : "", skipped ? `${skipped} outdated skipped` : ""].filter(Boolean).join(", ");
    onToast?.(`${accept ? "Accepted" : "Rejected"} ${done} suggestion${done === 1 ? "" : "s"} from ${review.authorName}${tail ? ` (${tail})` : ""}.`, failed ? "error" : "success");
  };

  return (
    <div className="review-card" data-testid="review-card" data-review-id={review.id} data-verdict={review.verdict}>
      <div className="flex items-start gap-2.5">
        <AuthorAvatar id={review.collabAuthorId} name={review.authorName} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className={cn("text-[13px] font-semibold", verdictTone(review.verdict))} data-testid="review-verdict">
              {reviewVerdictLabel(review.authorName, review.verdict)}
            </span>
            <span className="text-xs text-ink-4">{relativeTime(new Date(review.createdAt).getTime())}</span>
          </div>
          <div className="text-xs text-ink-3" data-testid="review-counts">
            {reviewSummaryLabel(mine.length, withSuggestion.length)}
            {withSuggestion.length > 0 && pending.length === 0 && <span> · all decided</span>}
          </div>
          {review.summary && <MentionBody body={review.summary} className="mt-1 text-[13px] leading-5 text-ink-2" />}
        </div>
        <button type="button" className="icon-btn h-7 w-7 shrink-0" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? "Collapse review" : "Expand review"} data-testid="review-toggle">
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
      </div>
      {canEdit && pending.length > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <button type="button" className="btn btn-sm btn-primary gap-1.5" disabled={busy || applicable.length === 0} onClick={() => void decideAll(true)} data-testid="review-accept-all">
            <CheckCheck size={13} /> Accept all suggestions
            {applicable.length !== pending.length && <span className="text-[11px] opacity-80">({applicable.length} of {pending.length})</span>}
          </button>
          <button type="button" className="btn btn-sm btn-outline gap-1.5" disabled={busy} onClick={() => void decideAll(false)} data-testid="review-reject-all">
            <X size={13} /> Reject all
          </button>
        </div>
      )}
      {open && (
        <ul className="mt-2 flex flex-col gap-1 border-t border-line pt-2" data-testid="review-threads">
          {mine.map((t) => {
            const targets = withSuggestion.filter((target) => target.thread.id === t.id);
            const pendingTargets = targets.filter((target) => target.state === "pending" || target.state === "outdated");
            const state = targets.length === 1 ? targets[0].state : pendingTargets.length > 0 ? `${pendingTargets.length} pending` : targets.length > 0 ? "all decided" : null;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-surface-2"
                  onClick={() => session.setActiveComment(t.id)}
                  data-testid="review-thread-link"
                  data-thread-id={t.id}
                >
                  {t.resolved ? <CheckCheck size={12} className="shrink-0 text-success" aria-label="Resolved" /> : <MessageSquare size={12} className="shrink-0 text-ink-4" />}
                  <span className="min-w-0 flex-1 truncate text-ink-2" title={t.quote}>
                    {t.quote || "(comment)"}
                  </span>
                  {state && <span className="suggestion-badge shrink-0">{state}</span>}
                </button>
              </li>
            );
          })}
          {mine.length === 0 && <li className="px-1.5 text-xs italic text-ink-4">The comments of this review were deleted.</li>}
        </ul>
      )}
    </div>
  );
}

/** Review cards for the document; re-fetched when a `review.create` shows up in the live activity (cheap: reviews are rare). */
function useReviews(session: CollabSession): ReviewDto[] {
  const [reviews, setReviews] = useState<ReviewDto[]>([]);
  const threadCount = useSessionValue(session, (s) => s.comments.ymap.size);
  useEffect(() => {
    let cancelled = false;
    api.documents
      .reviews(session.docId)
      .then((r) => {
        if (!cancelled) setReviews(r.reviews);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // A review adds threads to the shared doc; a changed thread count is the cue to re-fetch.
  }, [session.docId, threadCount]);
  return reviews;
}

export function CommentsPanel({ session, onClose, onReveal, onPendingDone, onAskAgent, focusTab, onToast }: CommentsPanelProps) {
  // Threads are selected on their own so a change elsewhere (active thread, reveal, pending composer)
  // keeps the same thread objects and the memoised cards skip their render.
  const threads = useSessionValue(session, (s) => s.comments.list(), jsonEqual);
  const text = useSessionValue(session, (s) => s.ytext.toString());
  const { suggestions, activeCommentId, activeSuggestionId, revealSeq, pending, mode } = useSessionValue(
    session,
    (s) => ({
      suggestions: s.suggestions.list(),
      activeCommentId: s.activeCommentId,
      activeSuggestionId: s.activeSuggestionId,
      revealSeq: s.revealSeq,
      pending: s.pendingComment,
      mode: s.mode,
    }),
    jsonEqual,
  );
  const ops = useCommentOps(session);
  const candidates = useMentionCandidates(session);
  const reviews = useReviews(session);
  const unreadRefs = useUnreadRefs(session.docId);
  const hasUnread = (t: CommentThread) => unreadRefs.has(t.id) || t.replies.some((r) => unreadRefs.has(r.id));
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);
  const commentSuggestions = useMemo(
    () => commentSuggestionTargets(threads, text).filter((target) => target.state === "pending" || target.state === "outdated"),
    [threads, text],
  );
  const commentSuggestionThreads = threads.filter((thread) => commentSuggestions.some((target) => target.thread.id === thread.id));
  const suggestionCount = suggestions.length + commentSuggestions.length;
  // Land on Suggestions when the user is suggesting or when that is the only tab with anything to review (#117).
  const [tab, setTab] = useState<Tab>(() => (mode === "suggesting" || (open.length === 0 && suggestionCount > 0) ? "suggestions" : "open"));
  const [bulkBusy, setBulkBusy] = useState(false);
  const canAct = session.role === "owner" || session.role === "editor";

  // The first suggestion that appears while the panel is open switches to the Suggestions tab, once per mount,
  // so a user who switched back is not fought. Skipped while a comment is being composed on the Open tab.
  const autoSwitched = useRef(false);
  const prevSuggestionCount = useRef(suggestionCount);
  useEffect(() => {
    const arrived = prevSuggestionCount.current === 0 && suggestionCount > 0;
    prevSuggestionCount.current = suggestionCount;
    if (!arrived || autoSwitched.current || pending) return;
    if (mode !== "suggesting" && open.length > 0) return;
    autoSwitched.current = true;
    setTab("suggestions");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestionCount]);

  useEffect(() => {
    if (activeSuggestionId) setTab("suggestions");
    else if (activeCommentId) {
      const t = threads.find((x) => x.id === activeCommentId);
      if (t) setTab(t.resolved ? "resolved" : "open");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCommentId, activeSuggestionId, revealSeq]);

  useEffect(() => {
    if (pending) setTab("open");
  }, [pending]);

  useEffect(() => {
    if (focusTab) setTab(focusTab.tab);
  }, [focusTab]);

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "open", label: "Open", count: open.length },
    { id: "resolved", label: "Resolved", count: resolved.length },
    { id: "suggestions", label: "Suggestions", count: suggestionCount },
  ];

  const decideAllSuggestions = async (accept: boolean) => {
    setBulkBusy(true);
    try {
      if (accept) session.suggestions.acceptAll();
      else session.suggestions.rejectAll();
      for (const { thread, reply, block, state } of commentSuggestions) {
        if (accept && state === "outdated") continue;
        try {
          if (accept) await ops.acceptSuggestion(thread.id, block.text, reply?.id);
          else await ops.rejectSuggestion(thread.id, reply?.id);
        } catch {
          // Another collaborator may have decided it while this batch was running.
        }
      }
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <MentionCandidatesContext.Provider value={candidates}>
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface-2" data-testid="comments-panel">
      <div className="flex h-12 items-center justify-between border-b border-line pl-4 pr-2">
        <span className="pane-label">Comments</span>
        <button type="button" className="icon-btn h-8 w-8" onClick={onClose} aria-label="Close comments">
          <X size={16} />
        </button>
      </div>
      <div className="flex gap-1 border-b border-line px-3 py-2" role="tablist" aria-label="Comment lists">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`comments-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="comments-tabpanel"
            className={cn("rounded-md px-2.5 py-1 text-xs font-medium", tab === t.id ? "bg-surface text-ink shadow-sm ring-1 ring-line" : "text-ink-3 hover:text-ink")}
            onClick={() => setTab(t.id)}
            data-testid={`comments-tab-${t.id}`}
          >
            {t.label}
            {t.count > 0 && <span className="ml-1 text-ink-4">{t.count}</span>}
          </button>
        ))}
      </div>
      <div className="scrollbar-thin flex flex-1 flex-col gap-3 overflow-y-auto p-3" role="tabpanel" id="comments-tabpanel" aria-labelledby={`comments-tab-${tab}`}>
        {tab === "open" && reviews.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="review-cards">
            {reviews.map((r) => (
              <ReviewCard key={r.id} review={r} threads={threads} session={session} text={text} ops={ops} onToast={onToast} />
            ))}
          </div>
        )}
        {pending && tab === "open" && (
          <div className="rounded-xl border border-accent bg-surface p-3 shadow-md shadow-accent/10" data-testid="pending-comment">
            <div className="mb-2 truncate border-l-2 border-amber-400 pl-2 text-xs text-ink-3">
              {session.ytext.toString().slice(pending.from, pending.to) || "Selected text"}
            </div>
            <Composer
              placeholder="Add a comment… (⌘/Ctrl+Enter to post)"
              autoFocus
              quote={pending.to > pending.from ? session.ytext.toString().slice(pending.from, pending.to) : undefined}
              onSubmit={async (body) => {
                const id = await ops.add(pending.from, pending.to, body);
                session.setPendingComment(null);
                if (typeof id === "string") session.setActiveComment(id);
                onPendingDone?.();
              }}
              onCancel={() => {
                session.setPendingComment(null);
                onPendingDone?.();
              }}
            />
          </div>
        )}
        {tab === "open" &&
          (open.length === 0 && !pending ? (
            <EmptyState icon={<MessageSquare size={28} />} title="No open comments">
              {suggestionCount > 0 && (
                <span className="mb-3 flex flex-wrap items-center justify-center gap-1 text-ink-3" data-testid="comments-empty-suggestions">
                  <button type="button" className="inline-flex items-center gap-1 font-medium text-accent hover:underline" onClick={() => setTab("suggestions")} data-testid="comments-empty-suggestions-button">
                    <Sparkles size={13} /> {suggestionCount === 1 ? "1 suggestion" : `${suggestionCount} suggestions`} waiting <ArrowRight size={13} />
                  </button>
                </span>
              )}
              Select some text and press <kbd className="kbd">⌘/Ctrl</kbd>+<kbd className="kbd">Alt</kbd>+<kbd className="kbd">M</kbd> or use the Comment button.
              {onAskAgent && session.canComment && (
                <span className="mt-3 flex flex-wrap items-center justify-center gap-1.5 text-ink-3" data-testid="comments-empty-ask-agent">
                  Agents can review this document too —
                  <button type="button" className="inline-flex items-center gap-1 font-medium text-accent hover:underline" onClick={onAskAgent} data-testid="comments-empty-ask-agent-button">
                    <Bot size={13} /> Ask an agent
                  </button>
                </span>
              )}
            </EmptyState>
          ) : (
            open.map((t) => <ThreadCard key={t.id} thread={t} session={session} text={text} active={t.id === activeCommentId} unread={hasUnread(t)} onReveal={onReveal} ops={ops} onToast={onToast} />)
          ))}
        {tab === "resolved" &&
          (resolved.length === 0 ? (
            <EmptyState title="Nothing resolved yet" />
          ) : (
            resolved.map((t) => <ThreadCard key={t.id} thread={t} session={session} text={text} active={t.id === activeCommentId} unread={hasUnread(t)} onReveal={onReveal} ops={ops} onToast={onToast} />)
          ))}
        {tab === "suggestions" &&
          (suggestionCount === 0 ? (
            <EmptyState icon={<Sparkles size={28} />} title="No pending suggestions">
              Switch to <strong>Suggesting</strong> mode to propose edits that others can accept or reject.
            </EmptyState>
          ) : (
            <>
              {canAct && (
                <div className="flex items-center justify-end gap-2 text-xs">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost text-success"
                    disabled={bulkBusy || (suggestions.length === 0 && commentSuggestions.every((target) => target.state === "outdated"))}
                    onClick={() => void decideAllSuggestions(true)}
                    data-testid="accept-all"
                  >
                    Accept all
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost text-danger" disabled={bulkBusy} onClick={() => void decideAllSuggestions(false)} data-testid="reject-all">
                    Reject all
                  </button>
                </div>
              )}
              {suggestions.map((s) => (
                <SuggestionCard key={s.id} s={s} session={session} active={s.id === activeSuggestionId} onReveal={onReveal} />
              ))}
              {commentSuggestionThreads.map((thread) => (
                <ThreadCard
                  key={`suggestion-${thread.id}`}
                  thread={thread}
                  session={session}
                  text={text}
                  active={thread.id === activeCommentId}
                  unread={hasUnread(thread)}
                  onReveal={onReveal}
                  ops={ops}
                  onToast={onToast}
                />
              ))}
            </>
          ))}
      </div>
    </aside>
    </MentionCandidatesContext.Provider>
  );
}
