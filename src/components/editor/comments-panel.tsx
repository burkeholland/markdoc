"use client";

import { cloneElement, createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { markRefsRead, useUnreadRefs } from "@/lib/notifications-store";
import { ArrowRight, Bot, Check, CheckCheck, ChevronDown, ChevronRight, ExternalLink, FileText, Hourglass, Loader2, MessageSquare, MessageSquarePlus, MoreHorizontal, Reply, RotateCcw, SmilePlus, Trash2, X, Pencil, Sparkles, ThumbsDown, ThumbsUp, Wand2 } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { QUICK_REACTIONS, isDocumentRange, type CommentReply, type CommentThread, type Reactions } from "@/editor/collab/comments";
import type { ResolvedSuggestion } from "@/editor/collab/suggestions";
import { agentMentionLogin, mentionTriggerAt, parseAgentMentions, splitMentions } from "@/editor/collab/mentions";
import { renderCommentBody, wrapLink, wrapSelection } from "@/editor/collab/comment-markdown";
import { isSuggestionOutdated, parseSuggestionBlock, reviewSummaryLabel, reviewVerdictLabel, suggestionBlockFor, type SuggestionBlock } from "@/editor/collab/suggestion-block";
import type { ReviewDto } from "@/server/reviews";
import { Avatar, EmptyState, Menu, MenuContent, MenuItem, MenuTrigger, Popover, PopoverAnchor, PopoverContent, PopoverTrigger, Tip } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { AGENT_CONNECT_DISMISSED_KEY, AGENT_DOCS_URL } from "@/lib/mcp";
import { rovingIndex } from "@/lib/a11y";
import { cn, isMac, relativeTime } from "@/lib/utils";
import { jsonEqual, useSessionValue } from "./use-session";
import { describeResult, QUICK_INSTRUCTIONS, REQUEST_QUOTE_MAX, requestInstruction, useThreadRequests, waitForSynced, type AgentRequestMirror, type AgentRequestMode } from "./agent-requests";
import "./comments.css";

type Tab = "open" | "resolved" | "suggestions";

/** The anchored text above a comment: a soft rounded highlight, never a coloured bar (docs/agents.md, UI conventions). */
const QUOTE_CLASS = "mb-2 truncate rounded-md bg-amber-50 px-2 py-0.5 text-xs text-ink-3 dark:bg-amber-950/40";

/** Controls inside a comment card: clicks on them act on the control, not on the card. */
const CARD_CONTROLS = "a, button, input, textarea, select, [role='menu'], [role='menuitem'], [role='listbox']";

/** Someone who can be @mentioned: present in the document, a collaborator, or an agent (present or recently active). */
export interface MentionCandidate {
  /** What follows `@` when picked; for agents `<ownerLogin>/<slug>`. */
  login: string;
  name: string;
  image: string | null;
  /** Set for agents (API tokens): the login of the user the token acts for. */
  agent?: { ownerLogin: string } | null;
  /** One of the current user's own tokens that has not been in this document yet (listed so it can still be asked). */
  own?: boolean;
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

/** The agents a body mentions that the picker knows (`@owner/slug` matched case-insensitively), in order of first mention. */
export function mentionedAgents(body: string, candidates: MentionCandidate[]): MentionCandidate[] {
  const agents = candidates.filter((c) => c.agent);
  if (agents.length === 0) return [];
  const out: MentionCandidate[] = [];
  for (const m of parseAgentMentions(body)) {
    const login = `${m.login}/${m.agent}`.toLowerCase();
    const hit = agents.find((c) => c.login.toLowerCase() === login);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** Offset just past the last `@owner/agent` mention in a body, or -1 when there is none. */
function lastAgentMentionEnd(body: string): number {
  let offset = 0;
  let end = -1;
  for (const part of splitMentions(body)) {
    const length = part.type === "mention" ? 1 + part.value.length + (part.agent ? 1 + part.agent.length : 0) : part.value.length;
    offset += length;
    if (part.type === "mention" && part.agent) end = offset;
  }
  return end;
}

/** Renders a comment body: inline Markdown plus `@login` chips. A ```suggestion block is lifted out (see SuggestionBox). */
export function MentionBody({ body, className }: { body: string; className?: string }) {
  const content = useMemo(() => renderCommentBody(parseSuggestionBlock(body)?.prose ?? body), [body]);
  if (content === null) return null;
  return (
    <div className={cn("comment-body min-w-0 break-words", className)} data-testid="comment-body">
      {content}
    </div>
  );
}

/** The proposed replacement as plain text: the passage it applies to is already highlighted in the document, so no diff. */
export function SuggestionText({ text }: { text: string }) {
  return (
    <div className="suggestion-text" data-testid="suggestion-text">
      {text === "" ? (
        <span className="italic text-ink-4" data-testid="suggestion-deletes">
          Deletes the highlighted text
        </span>
      ) : (
        text
      )}
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

/**
 * Collaborators and recently active agents of the document, fetched once while the panel is open, merged with who
 * is present. With `withOwnTokens` (set the first time a composer's `@` picker opens) the user's own API tokens join
 * the list too, so an agent that has never been in this document can still be asked; one already known through
 * presence or activity is listed once, as that entry. `tokenCount` is how many tokens that fetch returned — null
 * until it has, or when it failed — so the picker can offer "Connect an agent" to a user who has none (#1025).
 */
function useMentionCandidates(session: CollabSession, withOwnTokens: boolean): { candidates: MentionCandidate[]; tokenCount: number | null } {
  const [collaborators, setCollaborators] = useState<MentionCandidate[]>([]);
  const [knownAgents, setKnownAgents] = useState<MentionCandidate[]>([]);
  const [ownTokens, setOwnTokens] = useState<MentionCandidate[] | null>(null);
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
  const ownerLogin = session.user.login ?? null;
  useEffect(() => {
    if (!withOwnTokens || !ownerLogin) return;
    let cancelled = false;
    api.tokens
      .list()
      .then((res) => {
        if (cancelled) return;
        setOwnTokens(res.tokens.map((t) => ({ login: agentMentionLogin(ownerLogin, t.name), name: t.name, image: null, agent: { ownerLogin }, own: true })));
      })
      .catch((err: unknown) => {
        // Agents' sessions cannot list tokens (403); the picker simply offers what the document knows.
        if (!cancelled) console.debug("[comments] own tokens not listed for the mention picker", err);
      });
    return () => {
      cancelled = true;
    };
  }, [withOwnTokens, ownerLogin]);
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
    // Own tokens come last so one that is present or recently active keeps its ordinary entry.
    for (const c of [...present, ...collaborators, ...knownAgents, ...(ownTokens ?? [])]) {
      const key = c.login.toLowerCase();
      if (key === me || seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return { candidates: out, tokenCount: ownTokens ? ownTokens.length : null };
  }, [present, collaborators, knownAgents, ownTokens, session.user.login]);
}

const MAX_SUGGESTIONS = 6;

/** The "Connect an agent" row under the `@` picker, for a user whose token list came back empty (#1025). */
interface MentionConnectValue {
  /** Show the row: the user has no API token and has not dismissed the row on this browser. */
  due: boolean;
  /** Settings → tokens (the row's button is hidden without it). */
  onCreateToken?: () => void;
  onDismiss: () => void;
}

interface MentionCandidatesValue {
  candidates: MentionCandidate[];
  /** A composer's `@` picker opened: the panel fetches the user's own tokens once (see useMentionCandidates). */
  onPickerOpen: () => void;
  connect: MentionConnectValue;
}

/**
 * Mention candidates reach the composers through context rather than as a ThreadCard prop: the list
 * arrives a moment after the panel opens (collaborators fetch) and would otherwise re-render every
 * memoised card for a value only an open composer reads.
 */
const MentionCandidatesContext = createContext<MentionCandidatesValue>({ candidates: [], onPickerOpen: () => {}, connect: { due: false, onDismiss: () => {} } });

/** The picker's "Connect an agent" row shares the settings card's `localStorage` flag: dismissed once, gone everywhere. */
function readConnectDismissed(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(AGENT_CONNECT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

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
  /** Switch to a tab from outside; bump `nonce` to switch again to the same tab. */
  focusTab?: { tab: "open" | "resolved" | "suggestions"; nonce: number } | null;
  /**
   * Open a composer on the whole document (a zero-width thread at {0,0}, #1025); bump `nonce` to do it again.
   * With `mention` the composer starts with `@` typed, so the agent picker is up at once.
   */
  documentComposer?: { mention: boolean; nonce: number } | null;
  /** Settings → API tokens, for the picker's "Connect an agent" row (a user with no token); the button is hidden without it. */
  onCreateToken?: () => void;
  /** Move focus to the selected tab when this panel mounts. */
  focusOnMount?: boolean;
  /** Shell toast (Accept suggestion offers Undo). */
  onToast?: (message: string, kind?: "info" | "success" | "error", action?: { label: string; onClick?: () => void }) => void;
  /** Cancels an open or claimed agent request (the × on a thread card's request chip); the × is hidden when omitted. */
  onCancelRequest?: (requestId: string) => void;
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

/** Tallest the composer grows before it scrolls inside: about 16 lines, or 40 % of a short viewport. */
const COMPOSER_MAX_HEIGHT = 320;

/** Nearest ancestor that scrolls vertically (the comments list). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === "auto" || overflowY === "scroll") return p;
  }
  return null;
}

/** The answer modes an agent can be asked for, in the order the composer row shows them. */
const REQUEST_MODES: { id: AgentRequestMode; label: string }[] = [
  { id: "suggest", label: "Tracked changes" },
  { id: "comment", label: "Comment only" },
  { id: "rewrite", label: "Rewrite directly" },
];

/** What a composer that can turn a mention into an agent request needs to know (new-comment and reply composers; not edit). */
export interface ComposerRequestOptions {
  /** `session.canEdit`: without it only "Comment only" can be chosen (the server refuses the other modes too). */
  canEdit: boolean;
  /** Preselected mode: the thread's latest request mode for a reply, else tracked changes. */
  defaultMode: AgentRequestMode;
}

/** A submitted body that mentions a known agent becomes a request in this mode. */
export interface ComposerRequest {
  mode: AgentRequestMode;
  agents: MentionCandidate[];
}

function Composer({
  placeholder,
  autoFocus,
  onSubmit,
  onCancel,
  submitLabel = "Comment",
  initial = "",
  quote,
  editing = false,
  request,
}: {
  placeholder: string;
  autoFocus?: boolean;
  /** `request` is set when the body mentions an agent the picker knows and this composer offers the mode row. */
  onSubmit: (body: string, request: ComposerRequest | null) => void | Promise<unknown>;
  onCancel?: () => void;
  submitLabel?: string;
  initial?: string;
  /** Anchored text; when set, "Suggest a change" (Ctrl+Shift+S) inserts a ```suggestion block pre-filled with it. */
  quote?: string;
  /** Replacing an existing comment's body (Enter saves, Esc cancels) rather than writing a new one. */
  editing?: boolean;
  /** Offer the "How should the agent answer?" row when an agent is mentioned; absent on the edit composer. */
  request?: ComposerRequestOptions;
}) {
  const { candidates, onPickerOpen, connect } = useContext(MentionCandidatesContext);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [mode, setMode] = useState<AgentRequestMode>(request?.defaultMode ?? "suggest");
  const ref = useRef<HTMLTextAreaElement>(null);
  /** Re-evaluate whether the caret is in an `@` token. */
  const syncTrigger = useCallback((el: HTMLTextAreaElement) => {
    setHighlight(0);
    if (el.selectionStart !== el.selectionEnd) {
      setTrigger(null);
      return;
    }
    setTrigger(mentionTriggerAt(el.value, el.selectionStart));
  }, []);
  useEffect(() => {
    if (!autoFocus) return;
    // A frame later: a closing menu (Edit…) hands focus back to its trigger first.
    const raf = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      // A seeded new comment ("@" from the empty state or the hint bar, #1025) starts with the caret after the seed, so
      // the `@` picker is open before the user types; an edit keeps the browser's caret placement.
      if (initial && !editing) {
        el.setSelectionRange(initial.length, initial.length);
        syncTrigger(el);
      }
    });
    return () => cancelAnimationFrame(raf);
    // `initial` is read once, on mount, like useState(initial) above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);
  // The user's own tokens join the picker the first time an `@` is typed in any composer (not on panel mount);
  // a pasted `@login/agent` counts too, so the row can appear for an agent the document has not seen yet.
  const namesAgent = request !== undefined && parseAgentMentions(value).length > 0;
  useEffect(() => {
    if (trigger || namesAgent) onPickerOpen();
  }, [trigger, namesAgent, onPickerOpen]);

  // The box follows its content: from 3 lines (min-h-[64px]) up to the cap, beyond which it scrolls. Measured
  // from height:auto so it shrinks too, before paint so nothing flashes; the list's scroll position is pinned
  // because the momentary collapse would otherwise let the scroller clamp it. (`field-sizing: content` would do
  // this in CSS alone, but Firefox and Safari lack it.)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = scrollParent(el);
    const scrollTop = scroller?.scrollTop ?? 0;
    const cap = Math.min(COMPOSER_MAX_HEIGHT, window.innerHeight * 0.4);
    el.style.height = "auto";
    // scrollHeight leaves out the borders that the border-box height includes; add them so the text fits exactly.
    const borders = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + borders, cap)}px`;
    if (scroller) scroller.scrollTop = scrollTop;
  }, [value]);

  // The keyboard reference lives in the Save / send button's tooltip (and its accessible description), not under the box.
  // Each item is held together with no-break spaces so the wrapped tooltip breaks between shortcuts, never inside one.
  const mod = isMac ? "⌘" : "Ctrl";
  const shortcuts = [
    editing ? "Enter saves" : "Enter sends",
    "Shift+Enter newline",
    ...(editing ? ["Esc cancels"] : []),
    `${mod}+B bold`,
    `${mod}+I italic`,
    `${mod}+E code`,
    `${mod}+K link`,
    "@ mentions",
  ]
    .map((item) => item.replaceAll(" ", "\u00a0"))
    .join(" · ");

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
  // The popover also opens with no match for a user who has no agent yet: the "Connect an agent" row is the answer to
  // an `@` that finds nothing (#1025). It never opens for an edit, which cannot become a request.
  const connectDue = connect.due && request !== undefined;
  const open = trigger !== null && (matches.length > 0 || connectDue);

  // The mode row: only while the body names an agent the picker knows, and only on composers that can post a request.
  const agents = useMemo(() => (request ? mentionedAgents(value, candidates) : []), [request, value, candidates]);
  const showRow = request !== undefined && agents.length > 0;
  const effectiveMode: AgentRequestMode = request && !request.canEdit ? "comment" : mode;
  const modeDisabled = (id: AgentRequestMode) => id !== "comment" && request !== undefined && !request.canEdit;
  const rowLabel = agents.length === 1 ? `How should ${agents[0].name} answer?` : "How should the agents answer?";

  /** A quick instruction goes right after the mention; once the body has text past it, at the caret instead. Focus stays in the box. */
  const insertInstruction = (text: string) => {
    const el = ref.current;
    if (!el) return;
    const mentionEnd = lastAgentMentionEnd(value);
    let next: string;
    let pos: number;
    if (mentionEnd >= 0 && value.slice(mentionEnd).trim() === "") {
      const head = value.slice(0, mentionEnd).replace(/\s+$/, "");
      next = `${head} ${text}`;
      pos = next.length;
    } else {
      const caret = el.selectionStart ?? value.length;
      const before = value.slice(0, caret);
      const after = value.slice(caret);
      const lead = before && !/\s$/.test(before) ? " " : "";
      const trail = after && !/^\s/.test(after) ? " " : "";
      next = before + lead + text + trail + after;
      pos = (before + lead + text).length;
    }
    setValue(next);
    setTrigger(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  /** Arrow keys move through the modes; a disabled mode takes focus (so its tooltip can say why) without being chosen. */
  const onModeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key === "ArrowUp" ? "ArrowLeft" : event.key === "ArrowDown" ? "ArrowRight" : event.key;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = rovingIndex(key, current, items.length, { orientation: "horizontal", wrap: true });
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
    const id = REQUEST_MODES[next]?.id;
    if (id && !modeDisabled(id)) setMode(id);
  };

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
      await onSubmit(body, showRow ? { mode: effectiveMode, agents } : null);
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
            onBlur={() => setTimeout(() => setTrigger(null), 120)}
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
                if (matches.length > 0) {
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
                return;
              }
              // Esc cancels (an edit restores the original body); with the mention popover open it only closed that, above.
              if (e.key === "Escape" && onCancel) {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
              }
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
          {matches.length > 0 && (
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
                  data-own={c.own ? "" : undefined}
                >
                  {c.agent ? <AuthorAvatar id="agent:" name={c.name} size={20} /> : <Avatar name={c.name} src={c.image} size={20} />}
                  <span className="min-w-0 flex-1 truncate text-[13px]">{c.name}</span>
                  {c.agent ? (
                    <span className="truncate text-xs text-ink-4" title={c.own ? "One of your API tokens; it has not been in this document yet" : `Agent of @${c.agent.ownerLogin}`}>
                      {c.own ? "your agent · not here yet" : "agent"}
                    </span>
                  ) : (
                    <span className="truncate text-xs text-ink-3">@{c.login}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {/* No agent to mention yet: a footer that leads to Settings → API tokens, once per browser (#1025). Pointer
              actions keep the caret in the box (mousedown is swallowed) so the picker does not close under the click. */}
          {connectDue && (
            <div className={cn("mention-connect-row", matches.length > 0 && "mention-connect-row-under")} data-testid="mention-connect-row">
              <Bot size={14} className="shrink-0 text-ink-4" aria-hidden />
              <span className="min-w-0 flex-1 text-xs text-ink-3">
                No agent connected yet —{" "}
                {connect.onCreateToken && (
                  <button type="button" className="font-medium text-accent hover:underline" onMouseDown={(e) => e.preventDefault()} onClick={connect.onCreateToken} data-testid="mention-connect-agent">
                    Connect an agent
                  </button>
                )}
                {connect.onCreateToken && " · "}
                <a href={AGENT_DOCS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-accent hover:underline" onMouseDown={(e) => e.preventDefault()} data-testid="mention-connect-docs">
                  Agent docs
                  <ExternalLink size={11} aria-hidden />
                </a>
              </span>
              <button type="button" className="icon-btn h-5 w-5 shrink-0 text-ink-4 hover:text-ink" onMouseDown={(e) => e.preventDefault()} onClick={connect.onDismiss} aria-label="Dismiss" data-testid="mention-connect-dismiss">
                <X size={12} />
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {/* Mentioning an agent turns the comment into a request: this row chooses how it answers. Controls only — no
          hint text under the box (Burke); the question is the group's accessible name. It appears and goes with the
          mention and never takes focus: typing carries on in the box. */}
      {showRow && (
        <div className="composer-agent-row" data-testid="composer-agent-row">
          <div className="composer-modes" role="radiogroup" aria-label={rowLabel} onKeyDown={onModeKeyDown}>
            {REQUEST_MODES.map((m) => {
              const disabled = modeDisabled(m.id);
              const checked = effectiveMode === m.id;
              const radio = (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-disabled={disabled || undefined}
                  tabIndex={checked ? 0 : -1}
                  className="composer-mode"
                  // Choosing a mode with the pointer must not pull focus out of the textarea (Enter still posts).
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (!disabled) setMode(m.id);
                  }}
                  data-testid={`composer-mode-${m.id}`}
                >
                  {m.label}
                </button>
              );
              return disabled ? (
                <Tip key={m.id} label="Needs edit access" side="top">
                  {radio}
                </Tip>
              ) : (
                radio
              );
            })}
          </div>
          <div className="composer-chips" role="group" aria-label="Quick instructions">
            {QUICK_INSTRUCTIONS.map((q) => (
              <button key={q} type="button" className="composer-chip" onMouseDown={(e) => e.preventDefault()} onClick={() => insertInstruction(q)} data-testid="composer-chip">
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
      {/* Nothing sits between the box and its buttons (Burke, #4138): the shortcuts are in the Save / send button's tooltip.
          One row, single-line labels: below ~21rem of composer width (the 340 px panel) "Suggest a change"
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
        <Tip label={shortcuts} side="top" wrap testId="composer-shortcuts">
          {/* aria-description is ARIA 1.3: Chrome, Firefox 119+, Safari 16.4+ and axe-core know it, jsx-a11y's ARIA 1.2 table does not yet. */}
          {/* eslint-disable-next-line jsx-a11y/role-supports-aria-props */}
          <button
            type="button"
            className="btn btn-primary btn-sm whitespace-nowrap"
            disabled={!value.trim() || busy}
            onClick={() => void submit()}
            // Read after the button's name by screen readers, so keyboard users get the shortcuts without hovering.
            // (Not aria-label, which would replace "Save"; not title, which would add a second, native tooltip.)
            aria-description={shortcuts}
            data-testid="comment-submit"
          >
            {submitLabel}
          </button>
        </Tip>
      </div>
    </div>
  );
}

/** How long a "Done: 2 suggestions" chip keeps its detail before collapsing to a plain Done check. */
const DONE_DETAIL_MS = 60_000;

/** How long an optimistically cancelled request stays hidden before it may come back (the server refused), as the header does (#981). */
const CANCEL_GRACE_MS = 8_000;

/**
 * The request a thread carries, as a soft pill in the card header: Waiting for an agent → <agent> is working… →
 * Done: 2 suggestions (then a plain Done once the detail is a minute old). A cancelled request shows nothing.
 * The × cancels for the requester or the document owner; it hides at once and comes back only if the server refuses.
 */
function RequestChip({ request, canCancel, onCancel }: { request: AgentRequestMirror; canCancel: boolean; onCancel?: (requestId: string) => void }) {
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pending = request.status === "open" || request.status === "claimed";
  useEffect(() => {
    if (!cancelling) return;
    if (!pending) {
      setCancelling(false);
      return;
    }
    const t = setTimeout(() => setCancelling(false), CANCEL_GRACE_MS);
    return () => clearTimeout(t);
  }, [cancelling, pending]);
  const detailUntil = request.updatedAt + DONE_DETAIL_MS;
  const showDetail = request.status === "done" && now < detailUntil;
  useEffect(() => {
    if (!showDetail) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, detailUntil - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [showDetail, detailUntil]);
  if (request.status === "cancelled" || cancelling) return null;
  const label =
    request.status === "open"
      ? "Waiting for an agent"
      : request.status === "claimed"
        ? `${request.claimedBy ?? "An agent"} is working…`
        : showDetail
          ? `Done: ${describeResult(request.result)}`
          : "Done";
  return (
    <span className="request-chip" data-testid="comment-request-chip" data-status={request.status} data-request-id={request.id} onClick={(e) => e.stopPropagation()}>
      {request.status === "open" ? (
        <Hourglass size={11} aria-hidden="true" className="shrink-0" />
      ) : request.status === "claimed" ? (
        <Loader2 size={11} aria-hidden="true" className="shrink-0 animate-spin" />
      ) : (
        <Check size={11} aria-hidden="true" className="shrink-0" />
      )}
      <span className="request-chip-label">{label}</span>
      {pending && canCancel && onCancel && (
        <button
          type="button"
          className="request-chip-cancel"
          aria-label="Cancel request"
          title="Cancel request"
          onClick={() => {
            setCancelling(true);
            onCancel(request.id);
          }}
          data-testid="comment-request-cancel"
        >
          <X size={11} aria-hidden="true" />
        </button>
      )}
    </span>
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
  request,
  canRequestEdits,
  onCancelRequest,
  onRequest,
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
  /** The latest agent request made from this thread, if any (see useThreadRequests). */
  request?: AgentRequestMirror | null;
  /** `session.canEdit`: whether a reply that mentions an agent may ask for tracked changes / a rewrite. */
  canRequestEdits: boolean;
  onCancelRequest?: (requestId: string) => void;
  /** Posts an agent request for a reply that mentioned one (after the reply itself landed). */
  onRequest?: (threadId: string, body: string, mode: AgentRequestMode) => void;
}) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); // "root" or reply id
  const me = session.user.id;
  const canModerate = session.role === "owner";
  const canComment = session.canComment;
  const canEdit = session.role === "owner" || session.role === "editor";
  // Same rule as the header's Requests section (#981): the requester or the document owner may cancel.
  const canCancelRequest = !!onCancelRequest && !!request && (request.userId === me || canModerate);
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
  const editingRoot = editing === "root" && !thread.suggestionState;
  // A comment on the whole document (#1025): "Whole document" where the quote would be, no Accept on its
  // suggestions (there is no anchored text to replace; the model refuses too), no "Suggest a change" in its replies.
  const isDocument = isDocumentRange(thread.range);
  const canAcceptHere = canEdit && !isDocument;

  const accept = async (block: SuggestionBlock, reply: CommentReply | null = null) => {
    const ok = await ops.acceptSuggestion(thread.id, block.text, reply?.id);
    if (!ok) {
      onToast?.("The quoted text changed — this suggestion is outdated.", "error");
      return;
    }
    onToast?.(`Accepted suggestion from ${reply?.authorName ?? thread.authorName}.`, "success", { label: "Undo", onClick: () => session.undo() });
  };

  // The card itself is the "show me the text" control; a thread whose text is gone still becomes
  // active and says why the document did not move, instead of silently doing nothing.
  const reveal = () => {
    session.setActiveComment(thread.id);
    if (thread.range) onReveal(thread.range.from);
    else onToast?.("The text this comment referred to was removed.", "info");
  };
  const onCardClick = (event: MouseEvent<HTMLDivElement>) => {
    const control = (event.target as HTMLElement).closest(CARD_CONTROLS);
    if (control && event.currentTarget.contains(control)) return;
    reveal();
  };
  const onCardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    reveal();
  };

  return (
    <div
      ref={ref}
      className={cn(
        "relative rounded-xl border p-3 transition-shadow",
        thread.resolved ? "bg-surface/80" : "bg-surface",
        active ? "border-accent shadow-md shadow-accent/10" : "border-line hover:border-line-2",
      )}
      data-unread={unread || undefined}
      data-suggestion={suggestionState ?? undefined}
      role="article"
      aria-label={`Comment by ${thread.authorName}`}
      tabIndex={0}
      onClick={onCardClick}
      onKeyDown={onCardKeyDown}
      data-testid="comment-thread"
      data-thread-id={thread.id}
    >
      {unread && <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-accent" aria-label="Unread activity" data-testid="thread-unread-dot" />}
      {isDocument ? (
        <div className="comment-quote-document" title="A comment on the whole document" data-testid="comment-quote-document">
          <FileText size={12} aria-hidden />
          Whole document
        </div>
      ) : (
        thread.quote && (
          <div className={QUOTE_CLASS} title={thread.quote} data-testid="comment-quote">
            {thread.range ? thread.quote : <span className="italic">(original text removed) </span>}
          </div>
        )
      )}
      <div className="flex items-start gap-2.5">
        <AuthorAvatar id={thread.authorId} name={thread.authorName} src={thread.authorAvatar} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="truncate text-[13px] font-semibold text-ink">{thread.authorName}</span>
            <span className="shrink-0 text-xs text-ink-4" data-testid="comment-timestamp">
              {relativeTime(thread.createdAt)}
            </span>
            <EditedMarker at={thread.editedAt} />
            {request && <RequestChip request={request} canCancel={canCancelRequest} onCancel={onCancelRequest} />}
          </div>
          {/* While editing, the composer takes the full card width below this row (see after the row). */}
          {!editingRoot && (
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
                  <SuggestionText text={suggestion.text} />
                  <SuggestionActions
                    state={suggestionState}
                    canAccept={canAcceptHere}
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
      {editingRoot && (
        <div className="mt-1" data-testid="comment-edit">
          <Composer
            placeholder="Edit comment"
            initial={thread.body}
            autoFocus
            editing
            submitLabel="Save"
            onSubmit={async (body) => {
              await ops.edit(thread.id, body);
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}

      {thread.replies.length > 0 && (
        <div className="mt-3 flex flex-col gap-3 border-l border-line pl-3">
          {thread.replies.map((r) => {
            const block = parseSuggestionBlock(r.body);
            const state = block ? commentSuggestionState(thread, r.suggestionState, text) : null;
            const editingReply = editing === r.id && !r.suggestionState;
            return (
              <div key={r.id} data-testid="comment-reply" data-reply-id={r.id} data-state={state ?? undefined}>
                <div className="flex items-start gap-2.5">
                  <AuthorAvatar id={r.authorId} name={r.authorName} src={r.authorAvatar} size={24} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-[13px] font-semibold text-ink">{r.authorName}</span>
                      <span className="shrink-0 text-xs text-ink-4" data-testid="comment-timestamp">
                        {relativeTime(r.createdAt)}
                      </span>
                      <EditedMarker at={r.editedAt} />
                    </div>
                    {!editingReply && (
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
                            <SuggestionText text={block.text} />
                            <SuggestionActions
                              state={state}
                              canAccept={canAcceptHere}
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
                {editingReply && (
                  <div className="mt-1" data-testid="comment-edit">
                    <Composer
                      placeholder="Edit reply"
                      initial={r.body}
                      autoFocus
                      editing
                      submitLabel="Save"
                      onSubmit={async (body) => {
                        await ops.edit(thread.id, body, r.id);
                        setEditing(null);
                      }}
                      onCancel={() => setEditing(null)}
                    />
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
              quote={thread.range && !isDocument ? thread.quote : undefined}
              request={onRequest ? { canEdit: canRequestEdits, defaultMode: request?.mode ?? "suggest" } : undefined}
              onSubmit={async (body, req) => {
                await ops.reply(thread.id, body);
                setReplying(false);
                if (req && onRequest) onRequest(thread.id, body, req.mode);
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
        <div className="mt-2 inline-flex items-center gap-1 text-xs text-success" data-testid="comment-resolved-state">
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
            <span className="shrink-0 text-xs text-ink-4" data-testid="comment-timestamp">
              {relativeTime(s.createdAt)}
            </span>
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

/** Threads of a review that still exist in the document (a deleted thread simply drops out). */
function reviewThreads(review: ReviewDto, threads: CommentThread[]): CommentThread[] {
  return threads.filter((t) => review.threadIds.includes(t.id));
}

/**
 * A review is open while one of its threads is unresolved or still carries a pending (or outdated)
 * suggestion. Once every suggestion is decided and every thread resolved — or all of its threads were
 * deleted — it is resolved and lists at the top of the Resolved tab instead of Open (Burke, task #994).
 */
export function isReviewOpen(review: ReviewDto, threads: CommentThread[], text: string): boolean {
  const mine = reviewThreads(review, threads);
  if (mine.some((t) => !t.resolved)) return true;
  return commentSuggestionTargets(mine, text).some((target) => target.state === "pending" || target.state === "outdated");
}

/** One agent/human review: verdict + summary, expandable to its threads, Accept all / Reject all on the pending suggestions. */
function ReviewCard({ review, threads, session, text, ops, onToast }: { review: ReviewDto; threads: CommentThread[]; session: CollabSession; text: string; ops: ReturnType<typeof useCommentOps>; onToast?: CommentsPanelProps["onToast"] }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const canEdit = session.role === "owner" || session.role === "editor";
  const canComment = session.canComment;
  const mine = reviewThreads(review, threads);
  const withSuggestion = commentSuggestionTargets(mine, text);
  const pending = withSuggestion.filter((target) => target.state === "pending" || target.state === "outdated");
  const applicable = pending.filter((target) => target.state === "pending");
  const unresolved = mine.filter((t) => !t.resolved);

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

  /** Resolves every open thread of the review so a fully decided review can leave the Open tab (it lists under Resolved). */
  const resolveAll = async () => {
    setBusy(true);
    let done = 0;
    try {
      for (const t of unresolved) {
        try {
          await ops.resolve(t.id, true);
          done++;
        } catch {
          // Another collaborator may have resolved or deleted it while this batch was running.
        }
      }
    } finally {
      setBusy(false);
    }
    onToast?.(`Resolved ${done} comment${done === 1 ? "" : "s"} from ${review.authorName}.`, "success");
  };

  const partial = applicable.length !== pending.length;
  const acceptTitle = partial ? `Accept all suggestions (${applicable.length} of ${pending.length}; outdated ones are skipped)` : "Accept all suggestions";

  return (
    <div className="review-card" data-testid="review-card" data-review-id={review.id} data-verdict={review.verdict}>
      <div className="flex items-start gap-2.5">
        <AuthorAvatar id={review.collabAuthorId} name={review.authorName} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className={cn("text-[13px] font-semibold", verdictTone(review.verdict))} data-testid="review-verdict">
              {reviewVerdictLabel(review.authorName, review.verdict)}
            </span>
            <span className="text-xs text-ink-4" data-testid="comment-timestamp">
              {relativeTime(new Date(review.createdAt).getTime())}
            </span>
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
      {/* Two equal columns, single-line labels at every panel width (280–720 px). The "(n of m)" count only
          shows once the row is wide enough for it; the tooltip always carries the full wording. */}
      {canEdit && pending.length > 0 && (
        <div className="@container mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            className="btn btn-sm btn-primary min-w-0 gap-1.5 whitespace-nowrap px-2"
            disabled={busy || applicable.length === 0}
            onClick={() => void decideAll(true)}
            title={acceptTitle}
            aria-label={acceptTitle}
            data-testid="review-accept-all"
          >
            <CheckCheck size={13} aria-hidden /> Accept all
            {partial && <span className="hidden text-[11px] opacity-80 @min-[18rem]:inline">({applicable.length} of {pending.length})</span>}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline min-w-0 gap-1.5 whitespace-nowrap px-2"
            disabled={busy}
            onClick={() => void decideAll(false)}
            title="Reject all suggestions"
            aria-label="Reject all suggestions"
            data-testid="review-reject-all"
          >
            <X size={13} aria-hidden /> Reject all
          </button>
        </div>
      )}
      {/* Every suggestion decided but comments still open: one click clears the review from Open. */}
      {canComment && pending.length === 0 && unresolved.length > 0 && (
        <div className="mt-2 flex">
          <button
            type="button"
            className="btn btn-sm btn-outline gap-1.5 whitespace-nowrap"
            disabled={busy}
            onClick={() => void resolveAll()}
            title={`Resolve the ${unresolved.length === 1 ? "open comment" : `${unresolved.length} open comments`} of this review`}
            data-testid="review-resolve-all"
          >
            <Check size={13} aria-hidden /> Resolve all
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

export function CommentsPanel({
  session,
  onClose,
  onReveal,
  onPendingDone,
  onCancelRequest,
  onCreateToken,
  focusTab,
  documentComposer,
  focusOnMount = false,
  onToast,
}: CommentsPanelProps) {
  // Threads are selected on their own so a change elsewhere (active thread, reveal, pending composer)
  // keeps the same thread objects and the memoised cards skip their render.
  const threads = useSessionValue(session, (s) => s.comments.list(), jsonEqual);
  const text = useSessionValue(session, (s) => s.ytext.toString());
  const { suggestions, activeCommentId, activeSuggestionId, revealSeq, pending, mode, canEdit } = useSessionValue(
    session,
    (s) => ({
      suggestions: s.suggestions.list(),
      activeCommentId: s.activeCommentId,
      activeSuggestionId: s.activeSuggestionId,
      revealSeq: s.revealSeq,
      pending: s.pendingComment,
      mode: s.mode,
      canEdit: s.canEdit,
    }),
    jsonEqual,
  );
  const ops = useCommentOps(session);
  // The user's own tokens join the picker once a picker has opened; most panels never mention anyone.
  const [withOwnTokens, setWithOwnTokens] = useState(false);
  const { candidates, tokenCount } = useMentionCandidates(session, withOwnTokens);
  // "Connect an agent" under the picker for a user whose token list came back empty, until dismissed (#1025).
  const [connectDismissed, setConnectDismissed] = useState(readConnectDismissed);
  const dismissConnect = useCallback(() => {
    setConnectDismissed(true);
    try {
      window.localStorage.setItem(AGENT_CONNECT_DISMISSED_KEY, "1");
    } catch {
      // Storage unavailable: the row still goes away for this panel.
    }
  }, []);
  const mentionValue = useMemo<MentionCandidatesValue>(
    () => ({
      candidates,
      onPickerOpen: () => setWithOwnTokens(true),
      connect: { due: tokenCount === 0 && !connectDismissed, onCreateToken, onDismiss: dismissConnect },
    }),
    [candidates, tokenCount, connectDismissed, onCreateToken, dismissConnect],
  );
  const requests = useThreadRequests(session);
  /**
   * A comment that mentions an agent is also a request. The comment goes through the shared doc as usual and the
   * request follows over REST, after the server has that thread: `createRequest` checks `threadId` against the live
   * doc and answers 404 otherwise, so this waits for the sync ack and retries briefly. A failed request never loses
   * the comment; the toast says to mention the agent again.
   */
  const postAgentRequest = useCallback(
    async (threadId: string, body: string, mode: AgentRequestMode, selection: { from: number; to: number; quote: string } | null) => {
      await waitForSynced(session);
      const payload = {
        mode,
        instruction: requestInstruction(body),
        selection: selection ? { ...selection, quote: selection.quote.slice(0, REQUEST_QUOTE_MAX) } : null,
        threadId,
      };
      const delays = [0, 250, 500, 1000];
      for (let i = 0; i < delays.length; i++) {
        if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
        try {
          await api.documents.createRequest(session.docId, payload);
          return;
        } catch (err) {
          const status = (err as { status?: unknown }).status;
          if (status === 404 && i < delays.length - 1) continue;
          console.debug("[comments] agent request not posted", err);
          // 400 (unknown agent) and 403 (the owner has not opened the agent to others) carry a message worth showing as is.
          const message = (status === 400 || status === 403) && err instanceof Error && err.message ? err.message : null;
          onToast?.(message ? `The comment is posted, but the request was refused: ${message}` : "The comment is posted, but the request did not reach the agent — mention them again.", "error");
          return;
        }
      }
    },
    [session, onToast],
  );
  const requestFromThread = useCallback(
    (threadId: string, body: string, mode: AgentRequestMode) => {
      const thread = session.comments.list().find((t) => t.id === threadId);
      // A document thread asks about the whole document: selection: null, like the pending composer below.
      const selection = thread?.range && !isDocumentRange(thread.range) ? { from: thread.range.from, to: thread.range.to, quote: thread.quote } : null;
      void postAgentRequest(threadId, body, mode, selection);
    },
    [session, postAgentRequest],
  );
  const reviews = useReviews(session);
  const unreadRefs = useUnreadRefs(session.docId);
  const hasUnread = (t: CommentThread) => unreadRefs.has(t.id) || t.replies.some((r) => unreadRefs.has(r.id));
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);
  // Decided reviews leave Open: a card sits in Open while a thread of its is unresolved or a suggestion is pending.
  const openReviews = reviews.filter((r) => isReviewOpen(r, threads, text));
  const resolvedReviews = reviews.filter((r) => !isReviewOpen(r, threads, text));
  const commentSuggestions = useMemo(
    () => commentSuggestionTargets(threads, text).filter((target) => target.state === "pending" || target.state === "outdated"),
    [threads, text],
  );
  const commentSuggestionThreads = threads.filter((thread) => commentSuggestions.some((target) => target.thread.id === thread.id));
  const suggestionCount = suggestions.length + commentSuggestions.length;
  // Preserve the tab for current work; otherwise land on Suggestions when suggesting or when it is the only populated tab (#117).
  const [tab, setTab] = useState<Tab>(() => {
    if (focusTab) return focusTab.tab;
    if (pending) return "open";
    if (activeSuggestionId) return "suggestions";
    if (activeCommentId) {
      const activeThread = threads.find((thread) => thread.id === activeCommentId);
      if (activeThread) return activeThread.resolved ? "resolved" : "open";
    }
    return mode === "suggesting" || (open.length === 0 && suggestionCount > 0) ? "suggestions" : "open";
  });
  const [bulkBusy, setBulkBusy] = useState(false);
  const canAct = session.role === "owner" || session.role === "editor";
  const tablistRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusOnMount) return;
    const timer = window.setTimeout(() => {
      tablistRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
    });
    return () => window.clearTimeout(timer);
  }, [focusOnMount]);

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

  // A comment on the whole document (#1025): the pending composer at {0,0}, seeded with `@` when the caller wants
  // the agent picker up at once. The seed is keyed so the composer remounts and reads it; it is cleared when the
  // composer goes (posted or cancelled) so a later plain "comment" starts empty.
  const [seed, setSeed] = useState<{ initial: string; nonce: number } | null>(null);
  const startDocumentComment = useCallback(
    (opts: { mention: boolean; nonce: number }) => {
      if (!session.canComment) return;
      setSeed({ initial: opts.mention ? "@" : "", nonce: opts.nonce });
      session.setPendingComment({ from: 0, to: 0 });
      setTab("open");
    },
    [session],
  );
  useEffect(() => {
    if (documentComposer) startDocumentComment(documentComposer);
  }, [documentComposer, startDocumentComment]);
  // Cleared when a pending composer goes, not on mount: the panel may open with `documentComposer` already set (the
  // hint bar), and the seed and the pending range land in the same commit.
  const hadPending = useRef(false);
  useEffect(() => {
    if (pending) hadPending.current = true;
    else if (hadPending.current) {
      hadPending.current = false;
      setSeed(null);
    }
  }, [pending]);
  // The panel's own entry points: the header button and the empty state (the shell's nonce space is not reused).
  const localNonce = useRef(0);
  const commentOnDocument = useCallback((mention: boolean) => startDocumentComment({ mention, nonce: -++localNonce.current }), [startDocumentComment]);

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "open", label: "Open", count: open.length },
    { id: "resolved", label: "Resolved", count: resolved.length },
    { id: "suggestions", label: "Suggestions", count: suggestionCount },
  ];

  const onTablistKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = rovingIndex(event.key, current, items.length, { orientation: "horizontal", wrap: true });
    if (next < 0) return;
    event.preventDefault();
    setTab(tabs[next].id);
    items[next]?.focus();
  };

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
    <MentionCandidatesContext.Provider value={mentionValue}>
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface-2" data-testid="comments-panel">
      <div className="flex h-12 items-center justify-between border-b border-line pl-4 pr-2">
        <span className="pane-label">Comments</span>
        <button type="button" className="icon-btn h-8 w-8" onClick={onClose} aria-label="Close comments">
          <X size={16} />
        </button>
      </div>
      <div className="flex items-center gap-1 border-b border-line px-3 py-2">
        <div ref={tablistRef} className="flex min-w-0 flex-1 gap-1" role="tablist" aria-label="Comment lists" aria-orientation="horizontal" onKeyDown={onTablistKeyDown}>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`comments-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="comments-tabpanel"
              tabIndex={tab === t.id ? 0 : -1}
              className={cn("rounded-md px-2.5 py-1 text-xs font-medium", tab === t.id ? "bg-surface text-ink shadow-sm ring-1 ring-line" : "text-ink-3 hover:text-ink")}
              onClick={() => setTab(t.id)}
              onFocus={() => setTab(t.id)}
              data-testid={`comments-tab-${t.id}`}
            >
              {t.label}
              {t.count > 0 && <span className="ml-1 text-ink-4">{t.count}</span>}
            </button>
          ))}
        </div>
        {/* Outside the tablist (which holds only tabs): a comment on the whole document, no selection needed (#1025). */}
        {session.canComment && (
          <button type="button" className="icon-btn h-7 w-7 shrink-0" title="Comment on the document" aria-label="Comment on the document" onClick={() => commentOnDocument(false)} data-testid="comment-document">
            <MessageSquarePlus size={15} />
          </button>
        )}
      </div>
      <div className="scrollbar-thin flex flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto p-3" role="tabpanel" id="comments-tabpanel" aria-labelledby={`comments-tab-${tab}`}>
        {tab === "open" && openReviews.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="review-cards">
            {openReviews.map((r) => (
              <ReviewCard key={r.id} review={r} threads={threads} session={session} text={text} ops={ops} onToast={onToast} />
            ))}
          </div>
        )}
        {pending && tab === "open" && (
          <div className="rounded-xl border border-accent bg-surface p-3 shadow-md shadow-accent/10" data-testid="pending-comment">
            {isDocumentRange(pending) ? (
              <div className="comment-quote-document" data-testid="comment-quote-document">
                <FileText size={12} aria-hidden />
                Whole document
              </div>
            ) : (
              <div className={QUOTE_CLASS} data-testid="comment-quote">
                {session.ytext.toString().slice(pending.from, pending.to) || "Selected text"}
              </div>
            )}
            <Composer
              key={seed ? `seed-${seed.nonce}` : "pending"}
              placeholder="Add a comment… (⌘/Ctrl+Enter to post)"
              autoFocus
              initial={seed?.initial ?? ""}
              quote={pending.to > pending.from ? session.ytext.toString().slice(pending.from, pending.to) : undefined}
              request={{ canEdit, defaultMode: "suggest" }}
              onSubmit={async (body, req) => {
                const quote = session.ytext.toString().slice(pending.from, pending.to);
                const id = await ops.add(pending.from, pending.to, body);
                session.setPendingComment(null);
                if (typeof id === "string") session.setActiveComment(id);
                onPendingDone?.();
                // A document comment asks about the whole document: the request carries selection: null (#1025).
                const selection = isDocumentRange(pending) ? null : { from: pending.from, to: pending.to, quote };
                if (req && typeof id === "string") void postAgentRequest(id, body, req.mode, selection);
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
              {session.canComment && (
                <span className="mt-3 flex flex-wrap items-center justify-center gap-1.5 text-ink-3" data-testid="comments-empty-agent-line">
                  Agents can review this document too —
                  <button type="button" className="inline-flex items-center gap-1 font-medium text-accent hover:underline" onClick={() => commentOnDocument(true)} data-testid="comments-empty-agent">
                    <Bot size={13} /> Comment and mention an agent
                  </button>
                </span>
              )}
            </EmptyState>
          ) : (
            open.map((t) => (
              <ThreadCard
                key={t.id}
                thread={t}
                session={session}
                text={text}
                active={t.id === activeCommentId}
                unread={hasUnread(t)}
                onReveal={onReveal}
                ops={ops}
                onToast={onToast}
                request={requests[t.id] ?? null}
                canRequestEdits={canEdit}
                onCancelRequest={onCancelRequest}
                onRequest={requestFromThread}
              />
            ))
          ))}
        {tab === "resolved" && resolvedReviews.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="review-cards">
            {resolvedReviews.map((r) => (
              <ReviewCard key={r.id} review={r} threads={threads} session={session} text={text} ops={ops} onToast={onToast} />
            ))}
          </div>
        )}
        {tab === "resolved" &&
          (resolved.length === 0 && resolvedReviews.length === 0 ? (
            <EmptyState title="Nothing resolved yet" />
          ) : (
            resolved.map((t) => (
              <ThreadCard
                key={t.id}
                thread={t}
                session={session}
                text={text}
                active={t.id === activeCommentId}
                unread={hasUnread(t)}
                onReveal={onReveal}
                ops={ops}
                onToast={onToast}
                request={requests[t.id] ?? null}
                canRequestEdits={canEdit}
                onCancelRequest={onCancelRequest}
                onRequest={requestFromThread}
              />
            ))
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
                  request={requests[thread.id] ?? null}
                  canRequestEdits={canEdit}
                  onCancelRequest={onCancelRequest}
                  onRequest={requestFromThread}
                />
              ))}
            </>
          ))}
      </div>
    </aside>
    </MentionCandidatesContext.Provider>
  );
}
