"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { markRefsRead, useUnreadRefs } from "@/lib/notifications-store";
import { Bot, Check, CheckCheck, MessageSquare, MoreHorizontal, Reply, RotateCcw, SmilePlus, Trash2, X, Pencil, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { QUICK_REACTIONS, type CommentThread, type Reactions } from "@/editor/collab/comments";
import type { ResolvedSuggestion } from "@/editor/collab/suggestions";
import { mentionTriggerAt } from "@/editor/collab/mentions";
import { renderCommentBody, wrapLink, wrapSelection } from "@/editor/collab/comment-markdown";
import { Avatar, EmptyState, Menu, MenuContent, MenuItem, MenuTrigger, Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";
import { jsonEqual, useSessionValue } from "./use-session";
import "./comments.css";

type Tab = "open" | "resolved" | "suggestions";

/** Someone who can be @mentioned: present in the document or a collaborator. */
export interface MentionCandidate {
  login: string;
  name: string;
  image: string | null;
}

/** Renders a comment body: inline Markdown plus `@login` chips. */
export function MentionBody({ body, className }: { body: string; className?: string }) {
  const content = useMemo(() => renderCommentBody(body), [body]);
  return (
    <div className={cn("comment-body", className)} data-testid="comment-body">
      {content}
    </div>
  );
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
  const [open, setOpen] = useState(false);
  const entries = Object.entries(reactions).filter(([, ids]) => ids.length > 0);
  if (entries.length === 0 && !canReact) return null;
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
      {canReact && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="reaction-add" aria-label="Add reaction" title="Add reaction" data-testid="reaction-add">
              <SmilePlus size={14} />
            </button>
          </PopoverTrigger>
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
      )}
    </div>
  );
}

/** Collaborators of the document, fetched once while the panel is open, merged with who is present. */
function useMentionCandidates(session: CollabSession): MentionCandidate[] {
  const [collaborators, setCollaborators] = useState<MentionCandidate[]>([]);
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
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session.docId]);
  const present = useSessionValue(
    session,
    (s) => s.presence().filter((u) => !u.isLocal && u.login).map((u) => ({ login: u.login!, name: u.name, image: u.avatar ?? null })),
    jsonEqual,
  );
  return useMemo(() => {
    const seen = new Set<string>();
    const out: MentionCandidate[] = [];
    const me = session.user.login?.toLowerCase();
    for (const c of [...present, ...collaborators]) {
      const key = c.login.toLowerCase();
      if (key === me || seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  }, [present, collaborators, session.user.login]);
}

const MAX_SUGGESTIONS = 6;

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
  candidates = [],
}: {
  placeholder: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => void | Promise<unknown>;
  onCancel?: () => void;
  submitLabel?: string;
  initial?: string;
  candidates?: MentionCandidate[];
}) {
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

  const matches = useMemo(() => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    return candidates.filter((c) => c.login.toLowerCase().startsWith(q) || c.name.toLowerCase().startsWith(q)).slice(0, MAX_SUGGESTIONS);
  }, [trigger, candidates]);
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
    <div className="flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
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
              >
                <Avatar name={c.name} src={c.image} size={20} />
                <span className="min-w-0 flex-1 truncate text-[13px]">{c.name}</span>
                <span className="truncate text-xs text-ink-3">@{c.login}</span>
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
      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="btn btn-primary btn-sm" disabled={!value.trim() || busy} onClick={() => void submit()} data-testid="comment-submit">
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

function ThreadCard({
  thread,
  session,
  active,
  onReveal,
  ops,
  candidates,
  unread,
}: {
  thread: CommentThread;
  session: CollabSession;
  active: boolean;
  onReveal: (offset: number) => void;
  ops: ReturnType<typeof useCommentOps>;
  candidates: MentionCandidate[];
  /** The current user has unread notifications about this thread. */
  unread?: boolean;
}) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); // "root" or reply id
  const me = session.user.id;
  const canModerate = session.role === "owner";
  const canComment = session.canComment;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);
  // Opening the thread reads every notification about it (the thread itself and its replies).
  const replyIds = thread.replies.map((r) => r.id).join(",");
  useEffect(() => {
    if (active && unread) void markRefsRead(session.docId, [thread.id, ...replyIds.split(",").filter(Boolean)]);
  }, [active, unread, session.docId, thread.id, replyIds]);

  return (
    <div
      ref={ref}
      className={cn(
        "relative rounded-xl border bg-surface p-3 transition-shadow",
        active ? "border-accent shadow-md shadow-accent/10" : "border-line hover:border-line-2",
        thread.resolved && "opacity-80",
      )}
      data-unread={unread || undefined}
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
          {editing === "root" ? (
            <div className="mt-1">
              <Composer
                placeholder="Edit comment"
                initial={thread.body}
                autoFocus
                submitLabel="Save"
                candidates={candidates}
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
            <Menu>
              <MenuTrigger asChild>
                <button type="button" className="icon-btn h-7 w-7" aria-label="Comment actions">
                  <MoreHorizontal size={16} />
                </button>
              </MenuTrigger>
              <MenuContent align="end" className="w-40">
                {thread.authorId === me && (
                  <MenuItem icon={<Pencil size={14} />} onSelect={() => setEditing("root")}>
                    Edit
                  </MenuItem>
                )}
                <MenuItem icon={<Trash2 size={14} />} className="text-danger" onSelect={() => void ops.remove(thread.id)}>
                  Delete thread
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
        </div>
      </div>

      {thread.replies.length > 0 && (
        <div className="mt-3 flex flex-col gap-3 border-l border-line pl-3">
          {thread.replies.map((r) => (
            <div key={r.id} className="flex items-start gap-2.5" data-testid="comment-reply" data-reply-id={r.id}>
              <AuthorAvatar id={r.authorId} name={r.authorName} src={r.authorAvatar} size={24} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-[13px] font-semibold text-ink">{r.authorName}</span>
                  <span className="shrink-0 text-xs text-ink-4">{relativeTime(r.createdAt)}</span>
                  <EditedMarker at={r.editedAt} />
                </div>
                {editing === r.id ? (
                  <div className="mt-1">
                    <Composer
                      placeholder="Edit reply"
                      initial={r.body}
                      autoFocus
                      submitLabel="Save"
                      candidates={candidates}
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
                    <ReactionRow reactions={r.reactions} names={thread.reactorNames} me={me} canReact={canComment} onToggle={(emoji) => void ops.react(thread.id, r.id, emoji)} />
                  </>
                )}
              </div>
              {(r.authorId === me || canModerate) && (
                <div onClick={(e) => e.stopPropagation()}>
                  <Menu>
                    <MenuTrigger asChild>
                      <button type="button" className="icon-btn h-6 w-6" aria-label="Reply actions">
                        <MoreHorizontal size={14} />
                      </button>
                    </MenuTrigger>
                    <MenuContent align="end" className="w-36">
                      {r.authorId === me && (
                        <MenuItem icon={<Pencil size={14} />} onSelect={() => setEditing(r.id)}>
                          Edit
                        </MenuItem>
                      )}
                      <MenuItem icon={<Trash2 size={14} />} className="text-danger" onSelect={() => void ops.remove(thread.id, r.id)}>
                        Delete
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {canComment && !thread.resolved && (
        <div className="mt-3" onClick={(e) => e.stopPropagation()}>
          {replying ? (
            <Composer
              placeholder="Reply…"
              autoFocus
              submitLabel="Reply"
              candidates={candidates}
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
}

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

export function CommentsPanel({ session, onClose, onReveal, onPendingDone }: CommentsPanelProps) {
  const { threads, suggestions, activeCommentId, activeSuggestionId, revealSeq, pending } = useSessionValue(
    session,
    (s) => ({
      threads: s.comments.list(),
      suggestions: s.suggestions.list(),
      activeCommentId: s.activeCommentId,
      activeSuggestionId: s.activeSuggestionId,
      revealSeq: s.revealSeq,
      pending: s.pendingComment,
    }),
    jsonEqual,
  );
  const ops = useCommentOps(session);
  const candidates = useMentionCandidates(session);
  const unreadRefs = useUnreadRefs(session.docId);
  const hasUnread = (t: CommentThread) => unreadRefs.has(t.id) || t.replies.some((r) => unreadRefs.has(r.id));
  const [tab, setTab] = useState<Tab>("open");
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);
  const canAct = session.role === "owner" || session.role === "editor";

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

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "open", label: "Open", count: open.length },
    { id: "resolved", label: "Resolved", count: resolved.length },
    { id: "suggestions", label: "Suggestions", count: suggestions.length },
  ];

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface-2" data-testid="comments-panel">
      <div className="flex h-12 items-center justify-between border-b border-line pl-4 pr-2">
        <span className="pane-label">Comments</span>
        <button type="button" className="icon-btn h-8 w-8" onClick={onClose} aria-label="Close comments">
          <X size={16} />
        </button>
      </div>
      <div className="flex gap-1 border-b border-line px-3 py-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={cn("rounded-md px-2.5 py-1 text-xs font-medium", tab === t.id ? "bg-surface text-ink shadow-sm ring-1 ring-line" : "text-ink-3 hover:text-ink")}
            onClick={() => setTab(t.id)}
            data-testid={`comments-tab-${t.id}`}
          >
            {t.label}
            {t.count > 0 && <span className="ml-1 text-ink-4">{t.count}</span>}
          </button>
        ))}
      </div>
      <div className="scrollbar-thin flex flex-1 flex-col gap-3 overflow-y-auto p-3">
        {pending && tab === "open" && (
          <div className="rounded-xl border border-accent bg-surface p-3 shadow-md shadow-accent/10" data-testid="pending-comment">
            <div className="mb-2 truncate border-l-2 border-amber-400 pl-2 text-xs text-ink-3">
              {session.ytext.toString().slice(pending.from, pending.to) || "Selected text"}
            </div>
            <Composer
              placeholder="Add a comment… (⌘/Ctrl+Enter to post)"
              autoFocus
              candidates={candidates}
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
              Select some text and press <kbd className="kbd">⌘/Ctrl</kbd>+<kbd className="kbd">Alt</kbd>+<kbd className="kbd">M</kbd> or use the Comment button.
            </EmptyState>
          ) : (
            open.map((t) => <ThreadCard key={t.id} thread={t} session={session} active={t.id === activeCommentId} unread={hasUnread(t)} onReveal={onReveal} ops={ops} candidates={candidates} />)
          ))}
        {tab === "resolved" &&
          (resolved.length === 0 ? (
            <EmptyState title="Nothing resolved yet" />
          ) : (
            resolved.map((t) => <ThreadCard key={t.id} thread={t} session={session} active={t.id === activeCommentId} unread={hasUnread(t)} onReveal={onReveal} ops={ops} candidates={candidates} />)
          ))}
        {tab === "suggestions" &&
          (suggestions.length === 0 ? (
            <EmptyState icon={<Sparkles size={28} />} title="No pending suggestions">
              Switch to <strong>Suggesting</strong> mode to propose edits that others can accept or reject.
            </EmptyState>
          ) : (
            <>
              {canAct && (
                <div className="flex items-center justify-end gap-2 text-xs">
                  <button type="button" className="btn btn-sm btn-ghost text-success" onClick={() => session.suggestions.acceptAll()} data-testid="accept-all">
                    Accept all
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost text-danger" onClick={() => session.suggestions.rejectAll()} data-testid="reject-all">
                    Reject all
                  </button>
                </div>
              )}
              {suggestions.map((s) => (
                <SuggestionCard key={s.id} s={s} session={session} active={s.id === activeSuggestionId} onReveal={onReveal} />
              ))}
            </>
          ))}
      </div>
    </aside>
  );
}

