"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCheck, MessageSquare, MoreHorizontal, Reply, RotateCcw, Trash2, X, Pencil, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { CommentThread } from "@/editor/collab/comments";
import type { ResolvedSuggestion } from "@/editor/collab/suggestions";
import { Avatar, EmptyState, Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";
import { useSessionValue } from "./use-session";

type Tab = "open" | "resolved" | "suggestions";

export interface CommentsPanelProps {
  session: CollabSession;
  onClose: () => void;
  onReveal: (offset: number) => void;
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
}: {
  placeholder: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => void | Promise<unknown>;
  onCancel?: () => void;
  submitLabel?: string;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  const submit = async () => {
    const body = value.trim();
    if (!body) return;
    setBusy(true);
    try {
      await onSubmit(body);
      setValue("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <textarea
        ref={ref}
        className="textarea min-h-[64px] resize-none text-[13px]"
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
          if (e.key === "Escape" && onCancel) onCancel();
        }}
        data-testid="comment-composer"
      />
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
}: {
  thread: CommentThread;
  session: CollabSession;
  active: boolean;
  onReveal: (offset: number) => void;
  ops: ReturnType<typeof useCommentOps>;
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

  return (
    <div
      ref={ref}
      className={cn(
        "rounded-xl border bg-surface p-3 transition-shadow",
        active ? "border-accent shadow-md shadow-accent/10" : "border-line hover:border-line-2",
        thread.resolved && "opacity-80",
      )}
      onClick={() => {
        session.setActiveComment(thread.id);
        if (thread.range) onReveal(thread.range.from);
      }}
      data-testid="comment-thread"
      data-thread-id={thread.id}
    >
      {thread.quote && (
        <div className="mb-2 truncate border-l-2 border-amber-400 pl-2 text-xs text-ink-3" title={thread.quote}>
          {thread.range ? thread.quote : <span className="italic">(original text removed) </span>}
        </div>
      )}
      <div className="flex items-start gap-2.5">
        <Avatar name={thread.authorName} src={thread.authorAvatar} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-semibold text-ink">{thread.authorName}</span>
            <span className="shrink-0 text-xs text-ink-4">{relativeTime(thread.createdAt)}</span>
          </div>
          {editing === "root" ? (
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
            <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-5 text-ink-2">{thread.body}</p>
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
            <div key={r.id} className="flex items-start gap-2.5">
              <Avatar name={r.authorName} src={r.authorAvatar} size={24} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-[13px] font-semibold text-ink">{r.authorName}</span>
                  <span className="shrink-0 text-xs text-ink-4">{relativeTime(r.createdAt)}</span>
                </div>
                {editing === r.id ? (
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
                  <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-5 text-ink-2">{r.body}</p>
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
        <Avatar name={s.authorName} src={s.authorAvatar} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-semibold text-ink">{s.authorName}</span>
            <span className="shrink-0 text-xs text-ink-4">{relativeTime(s.createdAt)}</span>
          </div>
          <p className="mt-0.5 text-[13px] leading-5 text-ink-2">
            <span className="font-medium">{s.type === "insert" ? "Add" : "Delete"}:</span>{" "}
            <span className={cn("rounded px-1", s.type === "insert" ? "bg-green-50 text-green-800" : "bg-red-50 line-through text-red-800")}>
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

export function CommentsPanel({ session, onClose, onReveal }: CommentsPanelProps) {
  const { threads, suggestions, activeCommentId, activeSuggestionId, pending } = useSessionValue(session, (s) => ({
    threads: s.comments.list(),
    suggestions: s.suggestions.list(),
    activeCommentId: s.activeCommentId,
    activeSuggestionId: s.activeSuggestionId,
    pending: s.pendingComment,
  }));
  const ops = useCommentOps(session);
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
  }, [activeCommentId, activeSuggestionId]);

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
              onSubmit={async (body) => {
                const id = await ops.add(pending.from, pending.to, body);
                session.setPendingComment(null);
                if (typeof id === "string") session.setActiveComment(id);
              }}
              onCancel={() => session.setPendingComment(null)}
            />
          </div>
        )}
        {tab === "open" &&
          (open.length === 0 && !pending ? (
            <EmptyState icon={<MessageSquare size={28} />} title="No open comments">
              Select some text and press <kbd className="kbd">⌘/Ctrl</kbd>+<kbd className="kbd">Alt</kbd>+<kbd className="kbd">M</kbd> or use the Comment button.
            </EmptyState>
          ) : (
            open.map((t) => <ThreadCard key={t.id} thread={t} session={session} active={t.id === activeCommentId} onReveal={onReveal} ops={ops} />)
          ))}
        {tab === "resolved" &&
          (resolved.length === 0 ? (
            <EmptyState title="Nothing resolved yet" />
          ) : (
            resolved.map((t) => <ThreadCard key={t.id} thread={t} session={session} active={t.id === activeCommentId} onReveal={onReveal} ops={ops} />)
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
