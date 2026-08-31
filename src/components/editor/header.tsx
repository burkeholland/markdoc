"use client";
import { Avatar, Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger, Tip } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Check,
  ChevronDown,
  CloudOff,
  Loader2,
  MessageSquare,
  MoreVertical,
  Pencil,
  Share2,
  UserPlus,
  History,
  Download,
  FileCode2,
  FileText,
  Copy,
  Files,
  Trash2,
  Keyboard,
  Command,
  ExternalLink,
  AlertTriangle,
  Eye,
  PenLine,
  MessageSquarePlus,
  LogOut,
  ArrowLeft,
  RefreshCw,
  UploadCloud,
  Link2,
  Star,
  BookOpen,
  PanelLeft,
  Code2,
  GitMerge,
  Bot,
} from "lucide-react";
import type { CollabSession, EditMode, PresenceUser, SaveState } from "@/editor/collab/session";
import type { SyncStatusDto } from "@/lib/api";
import { GITHUB_NOT_CONFIGURED, SYNC_LABELS } from "./labels";
import { isIdle } from "@/editor/collab/follow";
import { saveStateLabel } from "@/editor/collab/offline";
import type { DocumentDto } from "@/server/dto";
import { api } from "@/lib/api";
import type { Layout } from "@/lib/viewport";

import { cn, shortcut } from "@/lib/utils";
import { jsonEqual, useOpenSettled, useSessionValue, useSettledSaveState } from "./use-session";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import type { NotificationDto } from "@/lib/api";
import { pendingRequests, useAgentRequests } from "./agent-requests";
import { AgentBusyBadge, KeepAgentHereButton, PresenceActivity, PresenceRequests, WaitingPlaceholder, busyAgentNames, isRecentActivity, pendingWorker, useAgentActivity, waitingLabel } from "./presence-agents";
import { signOutSafely } from "@/lib/sign-out";
import { Logo } from "@/components/ui/logo";
import { useEverTrue, useHydrated } from "@/lib/hooks";
import { lazyOnFirstUse } from "./lazy-on-first-use";

// On demand (#1150): the dialog, with the agent-connect card and copy blocks behind it, is fetched on its first
// open and then stays mounted (mount-once gate below), so Radix's close handling and focus return are unchanged.
const KeepAgentHereDialog = lazyOnFirstUse(() => import("./keep-agent-here"), (m) => m.KeepAgentHereDialog);

export function SaveIndicator({ session, compact }: { session: CollabSession; compact?: boolean }) {
  const liveState = useSessionValue(session, (s) => s.saveState);
  const liveUnsynced = useSessionValue(session, (s) => s.unsyncedChanges);
  const liveRecovered = useSessionValue(session, (s) => s.recovered);
  const liveProlonged = useSessionValue(session, (s) => s.prolongedOffline);
  // The server renders a fresh session ("Connecting…"); an offline client may already have
  // failed to connect by the time React hydrates. Match the server markup first, then switch.
  const hydrated = useHydrated();
  const raw: SaveState = hydrated ? liveState : "connecting";
  // The sync still runs per keystroke (`data-live-state`); the chip itself settles about a second
  // after the last ack instead of flashing Saving…/Saved on every key (#1282).
  const state = useSettledSaveState(raw);
  const unsynced = hydrated ? liveUnsynced : 0;
  const recovered = hydrated && liveRecovered;
  const prolonged = hydrated && liveProlonged;
  const label = saveStateLabel(state, unsynced, recovered, prolonged);
  const map: Record<SaveState, { icon: React.ReactNode; className: string }> = {
    saved: { icon: <Check size={16} strokeWidth={2.5} />, className: "text-success" },
    saving: { icon: <Loader2 size={16} className="animate-spin" />, className: "text-ink-3" },
    connecting: { icon: <Loader2 size={16} className="animate-spin" />, className: "text-ink-3" },
    reconnecting: { icon: <Loader2 size={16} className="animate-spin" />, className: "text-warning" },
    offline: { icon: <CloudOff size={16} />, className: "text-warning" },
    error: { icon: <AlertTriangle size={16} />, className: "text-danger" },
  };
  const m = map[state];
  const flash = state === "saved" && recovered;
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-md text-sm font-medium transition-colors", m.className, flash && "save-state-recovered")}
      data-testid="save-state"
      data-state={state}
      data-live-state={raw}
      data-unsynced={unsynced}
      data-recovered={flash || undefined}
      data-prolonged={prolonged || undefined}
      role="status"
      title={compact ? label : undefined}
    >
      {m.icon}
      <span className={cn(compact && "sr-only")}>{label}</span>
    </span>
  );
}

function TitleEditor({ session, fallback, compact }: { session: CollabSession; fallback: string; compact?: boolean }) {
  const title = useSessionValue(session, (s) => s.title || fallback);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  const canEdit = session.role === "owner" || session.role === "editor";

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);
  useEffect(() => {
    document.title = `${title} · Markdoc`;
  }, [title]);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== title) session.setTitle(next);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={input}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="h-9 min-w-[12rem] max-w-[28rem] rounded-lg border border-accent bg-surface px-2 text-[22px] font-semibold text-ink outline-none ring-2 ring-accent/20"
        aria-label="Document title"
        data-testid="title-input"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => canEdit && setEditing(true)}
      className={cn("group flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left", canEdit && "hover:bg-surface-3")}
      title={canEdit ? "Rename" : title}
      data-testid="title"
    >
      <span className={cn("doc-title truncate font-semibold leading-8 text-ink", compact ? "text-lg" : "text-[22px]")}>{title}</span>
      {canEdit && !compact && <Pencil size={15} className="shrink-0 text-ink-4 opacity-0 transition-opacity group-hover:opacity-100" />}
    </button>
  );
}

/**
 * Personal star for the open document. Stars live on the dashboard, so the header asks the API for
 * the current state once the open has settled (the editor does not need it to become editable) and
 * stays hidden for anonymous visitors (who cannot star).
 */
function HeaderStar({ docId, ready }: { docId: string; ready: boolean }) {
  const [starred, setStarred] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    setStarred(null);
    if (!ready) return;
    api.documents
      .starred(docId)
      .then((r) => !cancelled && setStarred(r.starred))
      .catch(() => !cancelled && setStarred(null));
    return () => {
      cancelled = true;
    };
  }, [docId, ready]);
  if (starred === null) return null;
  const toggle = () => {
    const next = !starred;
    setStarred(next);
    (next ? api.documents.star(docId) : api.documents.unstar(docId)).catch((err: unknown) => {
      console.error(err);
      setStarred(!next);
    });
  };
  return (
    <Tip label={starred ? "Unstar" : "Star"}>
      <button
        type="button"
        onClick={toggle}
        className={cn("icon-btn h-8 w-8 shrink-0", starred ? "text-amber-500" : "text-ink-4")}
        aria-pressed={starred}
        aria-label={starred ? "Unstar document" : "Star document"}
        data-testid="header-star"
        data-starred={starred}
      >
        <Star size={17} fill={starred ? "currentColor" : "none"} />
      </button>
    </Tip>
  );
}

/** Bot avatar for agents in the presence list (same badge style as agent comments in the comments panel). */
function AgentAvatar({ name, color, size }: { name: string; color: string; size: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700 ring-2 ring-surface dark:bg-violet-950 dark:text-violet-300"
      style={{ width: size, height: size, boxShadow: `0 0 0 2px ${color}` }}
      aria-label={`${name} (agent)`}
      role="img"
    >
      <Bot size={Math.round(size * 0.55)} aria-hidden="true" />
    </span>
  );
}

/** How long an optimistically cancelled request stays hidden before it may come back (the server refused). */
const CANCEL_GRACE_MS = 8_000;

export interface PresenceStackProps {
  session: CollabSession;
  onJump?: (user: PresenceUser) => void;
  /** Cancel an open request from the popover's Requests section; without it the rows show but not Cancel (embed / read-only). */
  onCancelRequest?: (requestId: string) => void;
  /** Opens the "Keep an agent here" dialog; the popover offers it while no agent is present. */
  onKeepAgent?: () => void;
}

/**
 * Everyone in the document, agents included: agents are bot avatars with a spinner badge while they work,
 * and the popover carries their status, the open requests and the way to put an agent here (task #981).
 */
export function PresenceStack({ session, onJump, onCancelRequest, onKeepAgent }: PresenceStackProps) {
  const users = useSessionValue(session, (s) => s.presence(), jsonEqual);
  const followUserId = useSessionValue(session, (s) => s.followUserId);
  const requests = useAgentRequests(session);
  const activity = useAgentActivity(session);
  const [open, setOpen] = useState(false);
  // Cancel is optimistic: the row and the placeholder go at once; the mirror catches up a moment later. If the
  // server refuses (editor-shell toasts the error) the request is still pending after the grace period and returns.
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(() => new Set());
  const pending = pendingRequests(requests).filter((r) => !cancelling.has(r.id));
  useEffect(() => {
    if (cancelling.size === 0) return;
    const stillPending = new Set(pendingRequests(requests).map((r) => r.id));
    if ([...cancelling].every((id) => stillPending.has(id))) return;
    setCancelling(new Set([...cancelling].filter((id) => stillPending.has(id))));
  }, [requests, cancelling]);
  const cancelRequest = (id: string) => {
    setCancelling((prev) => new Set(prev).add(id));
    onCancelRequest?.(id);
    setTimeout(() => setCancelling((prev) => (prev.has(id) ? new Set([...prev].filter((x) => x !== id)) : prev)), CANCEL_GRACE_MS);
  };
  // Idle dimming is time-based; re-evaluate it every 15 s while the stack is mounted. A fresh agent
  // activity ("proposed changes · 12 s ago") ticks every 5 s for the 45 s it shows.
  const [now, setNow] = useState(() => Date.now());
  const activityFresh = isRecentActivity(activity, now);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), activityFresh ? 5_000 : 15_000);
    return () => clearInterval(t);
  }, [activityFresh, activity]);
  const shown = users.slice(0, 3);
  const extra = users.length - shown.length;
  const others = users.filter((u) => !u.isLocal);
  const agents = users.filter((u) => u.isAgent);
  const busy = busyAgentNames(requests, activity, now);
  // No agent in presence but requests pending: the stack shows a dashed placeholder. It reads "waiting" until an
  // agent claims one (agents may claim over REST/MCP before they ever announce themselves), then "working".
  const noAgent = agents.length === 0 && pending.length > 0;
  const unseenWorker = noAgent ? pendingWorker(pending) : null;
  const waiting = noAgent && !unseenWorker;
  const nameOf = (userId: string) => users.find((u) => !u.isAgent && u.id === userId)?.name ?? null;
  const jump = (u: PresenceUser) => {
    if (u.cursor === null) return;
    onJump?.(u);
    setOpen(false);
  };
  const follow = (u: PresenceUser) => {
    session.follow(followUserId === u.id ? null : u.id);
    setOpen(false);
  };
  const keepAgent = () => {
    setOpen(false);
    onKeepAgent?.();
  };
  const roleLabel: Record<string, string> = { owner: "Owner", editor: "Editor", commenter: "Commenter", viewer: "Viewer" };
  const label = (u: PresenceUser) => (u.isLocal ? `${u.name} (you)` : u.isAgent ? `${u.name} (agent${u.status ? `: ${u.status}` : ""})` : u.name);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center -space-x-2 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="presence"
          aria-label={`${users.length} ${users.length === 1 ? "person" : "people"} here: ${users.map(label).join(", ")}${waiting ? `; ${waitingLabel(pending.length)}` : ""}`}
        >
          {shown.map((u) => (
            <Tip key={u.id} label={u.isAgent && busy.has(u.name) ? `${label(u)} — working` : label(u)}>
              <span
                className={cn("relative inline-flex transition-opacity", !u.isLocal && isIdle(u.idleSince, now) && "opacity-40")}
                data-testid="presence-avatar"
                data-user-id={u.id}
                data-idle={!u.isLocal && isIdle(u.idleSince, now) ? "" : undefined}
                data-agent={u.isAgent ? "" : undefined}
                data-busy={u.isAgent && busy.has(u.name) ? "" : undefined}
              >
                {u.isAgent ? <AgentAvatar name={u.name} color={u.color} size={36} /> : <Avatar name={u.name} src={u.avatar} color={u.color} size={36} />}
                {u.isAgent && busy.has(u.name) && <AgentBusyBadge name={u.name} />}
              </span>
            </Tip>
          ))}
          {extra > 0 && (
            <Tip label={users.slice(3).map((u) => u.name).join(", ")}>
              <span className="avatar text-[13px]">+{extra}</span>
            </Tip>
          )}
          {noAgent && (
            <Tip label={unseenWorker ? `${unseenWorker} (agent) — working` : waitingLabel(pending.length)}>
              <span className="relative inline-flex">
                <WaitingPlaceholder count={pending.length} workingBy={unseenWorker} size={36} />
              </span>
            </Tip>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2" data-testid="presence-popover">
        <div className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          {users.length === 1 ? "Only you are here" : `${users.length} people here`}
        </div>
        <ul className="flex flex-col gap-0.5">
          {users.map((u) => {
            const idle = !u.isLocal && isIdle(u.idleSince, now);
            const following = followUserId === u.id;
            const working = u.isAgent && busy.has(u.name);
            return (
              <li key={u.id} className={cn("flex items-center gap-2.5 rounded-lg px-2 py-1.5", idle && !working && "opacity-60")} data-testid="presence-row" data-user-id={u.id} data-agent={u.isAgent ? "" : undefined}>
                <span className="relative inline-flex shrink-0">
                  {u.isAgent ? <AgentAvatar name={u.name} color={u.color} size={28} /> : <Avatar name={u.name} src={u.avatar} color={u.color} size={28} />}
                  {working && <AgentBusyBadge name={u.name} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-ink">
                    <span className="truncate">{u.isLocal ? `${u.name} (you)` : u.name}</span>
                    {u.isAgent && <span className="rounded-md bg-violet-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-950 dark:text-violet-300">Agent</span>}
                    {u.role && <span className="rounded-md bg-surface-2 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-ink-3">{roleLabel[u.role] ?? u.role}</span>}
                  </div>
                  <div className="truncate text-xs text-ink-3" data-testid="presence-section">
                    {u.isAgent ? (
                      <>
                        <span data-testid="presence-status">{idle && !working ? "Idle" : u.status ?? "working"}</span>
                        {activityFresh && activity.name === u.name && (
                          <>
                            {" · "}
                            <PresenceActivity activity={activity} now={now} />
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        {idle ? "Idle · " : ""}
                        {u.cursor === null ? "no cursor" : u.section ? `in ‘${u.section}’` : "at the top"}
                      </>
                    )}
                  </div>
                </div>
                {!u.isLocal && !u.isAgent && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button type="button" className="btn btn-sm btn-outline h-7 px-2 text-xs" onClick={() => jump(u)} disabled={u.cursor === null} data-testid="presence-jump">
                      Jump
                    </button>
                    <button
                      type="button"
                      className={cn("btn btn-sm h-7 px-2 text-xs", following ? "btn-primary" : "btn-outline")}
                      onClick={() => follow(u)}
                      aria-pressed={following}
                      data-testid="presence-follow"
                    >
                      {following ? "Following" : "Follow"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {pending.length > 0 && <PresenceRequests session={session} pending={pending} nameOf={nameOf} onCancel={onCancelRequest ? cancelRequest : undefined} />}
        {waiting && (
          <p className="px-2 pb-1 pt-1.5 text-xs text-ink-3" data-testid="presence-waiting-note">
            {waitingLabel(pending.length)} — none is sitting in this document.
          </p>
        )}
        {agents.length === 0 && onKeepAgent && (
          <div className={cn("px-1 pb-1", waiting ? "pt-1" : "pt-1.5")}>
            <KeepAgentHereButton onClick={keepAgent} primary={waiting} />
          </div>
        )}
        {others.length === 0 && pending.length === 0 && <div className="px-2 pb-1 pt-1.5 text-xs text-ink-3">Share the document to work on it together.</div>}
      </PopoverContent>
    </Popover>
  );
}

export function ModeSwitcher({ session }: { session: CollabSession }) {
  const mode = useSessionValue(session, (s) => s.mode);
  const editable = session.role === "owner" || session.role === "editor";
  const icons: Record<EditMode, React.ReactNode> = {
    editing: <PenLine size={15} />,
    suggesting: <MessageSquarePlus size={15} />,
    viewing: <Eye size={15} />,
  };
  const labels: Record<EditMode, string> = { editing: "Editing", suggesting: "Suggesting", viewing: "Viewing" };
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "btn btn-sm gap-1.5 border",
            mode === "suggesting" ? "border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300" : "border-line-2 bg-surface text-ink-2 hover:bg-surface-2",
          )}
          data-testid="mode-switcher"
        >
          {icons[mode]}
          <span>{labels[mode]}</span>
          <ChevronDown size={14} className="text-ink-4" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="w-64">
        <MenuRadioGroup value={mode} onValueChange={(v) => session.setMode(v as EditMode)}>
          <MenuRadioItem value="editing" disabled={!editable} description="Edit the document directly">
            Editing
          </MenuRadioItem>
          <MenuRadioItem value="suggesting" disabled={!editable} description="Edits become suggestions others can accept">
            Suggesting
          </MenuRadioItem>
          <MenuRadioItem value="viewing" description="Read or print the final document">
            Viewing
          </MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem icon={<BookOpen size={15} />} onSelect={() => window.open(`/p/${session.docId}`, "_blank", "noopener")} data-testid="mode-reader">
          Open reader view
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export type ExportFormat = "md" | "html" | "pdf";

/** Editing / Suggesting / Viewing as menu rows — the phone header has no room for the ModeSwitcher pill. */
function ModeItems({ session }: { session: CollabSession }) {
  const mode = useSessionValue(session, (s) => s.mode);
  const editable = session.role === "owner" || session.role === "editor";
  return (
    <>
      <MenuLabel>Mode</MenuLabel>
      <MenuRadioGroup value={mode} onValueChange={(v) => session.setMode(v as EditMode)}>
        <MenuRadioItem value="editing" disabled={!editable}>
          Editing
        </MenuRadioItem>
        <MenuRadioItem value="suggesting" disabled={!editable}>
          Suggesting
        </MenuRadioItem>
        <MenuRadioItem value="viewing">Viewing</MenuRadioItem>
      </MenuRadioGroup>
    </>
  );
}

export interface HeaderProps {
  session: CollabSession;
  doc: DocumentDto;
  commentsOpen: boolean;
  onToggleComments: (focusPanel?: boolean) => void;
  /** Open the thread/suggestion/document a notification points at (the item is already marked read). */
  onOpenNotification: (n: NotificationDto) => void;
  onShare: () => void;
  onPublish: () => void;
  onPublishNow: () => void;
  onPull: () => void;
  /** Opens the Sync dialog (both sides changed). */
  onSync: () => void;
  /** Three-way status against the linked GitHub file; null while unknown or when not linked. */
  sync: SyncStatusDto | null;
  onHistory: () => void;
  /** The ⋯ menu opened; the shell warms what its items need (the version list, task #487). */
  onMoreMenuOpen?: () => void;
  onActivity: () => void;
  onShortcuts: () => void;
  onCommandPalette?: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onDownload: (format: ExportFormat, withSuggestions: boolean) => void;
  onCopyMarkdown: () => void;
  onNameVersion: () => void;
  publishing: boolean;
  isOwner: boolean;
  /** The server has a GitHub OAuth app; without it the GitHub entries are disabled and say why (#162). */
  githubConfigured: boolean;
  onHome: () => void;
  /** Pane layout shown by the segmented control on phones. */
  layout: Layout;
  onLayout: (layout: Layout) => void;
  /** Opens the outline drawer (phones only). */
  onOutline: () => void;
  /** Phone layout: icon-only save state, segmented pane control, secondary actions folded into the menu. */
  compact: boolean;
  /** "Jump" in the presence popover: scroll both panes to a collaborator's cursor. */
  onJumpToUser?: (user: PresenceUser) => void;
  /** Cancel an open request from the presence popover's Requests section; the Cancel buttons are hidden when omitted. */
  onCancelRequest?: (requestId: string) => void;
  /** Where "Keep an agent here" sends people without a token (defaults to /settings#tokens). */
  onCreateToken?: () => void;
  /** Bumped by the command palette's "Keep an agent here" (and the `/agent` slash item): opens the Keep-an-agent dialog. */
  keepAgentNonce?: number;
  /** Canvas mode: hide navigation, sharing, publishing, and account menus. */
  embed?: boolean;
}

/** Preview | Markdown switch shown in the header below `md`; the status-bar menu covers wider windows. */
function LayoutSegment({ layout, onLayout }: { layout: Layout; onLayout: (l: Layout) => void }) {
  const options: { value: Layout; label: string; icon: React.ReactNode }[] = [
    { value: "rich", label: "Preview", icon: <Eye size={17} /> },
    { value: "code", label: "Markdown", icon: <Code2 size={17} /> },
  ];
  return (
    <div className="inline-flex h-9 shrink-0 rounded-lg border border-line-2 bg-surface p-0.5 md:hidden" role="radiogroup" aria-label="Pane" data-testid="layout-segment">
      {options.map((o) => {
        const active = layout === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={o.label}
            title={o.label}
            className={cn("inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors", active ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink")}
            onClick={() => onLayout(o.value)}
            data-testid={`layout-segment-${o.value}`}
          >
            {o.icon}
          </button>
        );
      })}
    </div>
  );
}

/** Menu entry text for a GitHub action; says why it is disabled when the server has no GitHub OAuth app (#162). */
function GitHubEntryLabel({ configured, children }: { configured: boolean; children: React.ReactNode }) {
  if (configured) return <>{children}</>;
  return (
    <span className="flex flex-col">
      <span>{children}</span>
      <span className="text-xs text-ink-3">{GITHUB_NOT_CONFIGURED}</span>
    </span>
  );
}

export function PublishStatusButton({
  sync,
  publishing,
  onPublishNow,
  onPull,
  onSync,
}: Pick<HeaderProps, "sync" | "publishing" | "onPublishNow" | "onPull" | "onSync"> & { sync: SyncStatusDto }) {
  const opensSyncDialog = sync.status === "diverged" || sync.status === "remote-unreadable";
  const label =
    sync.status === "remote-ahead"
      ? "Pull"
      : sync.status === "diverged"
        ? "Both changed"
        : sync.status === "remote-unreadable"
          ? SYNC_LABELS[sync.status]
          : sync.status === "in-sync"
            ? "Up to date"
            : "Publish";

  return (
    <button
      type="button"
      className="btn btn-primary gap-1.5 rounded-r-none pl-3 pr-3"
      disabled={publishing}
      data-testid="publish-button"
      onClick={sync.status === "remote-ahead" ? onPull : opensSyncDialog ? onSync : onPublishNow}
      title={SYNC_LABELS[sync.status]}
    >
      {publishing ? (
        <Loader2 size={16} className="animate-spin" />
      ) : sync.status === "remote-ahead" ? (
        <RefreshCw size={15} />
      ) : sync.status === "diverged" ? (
        <GitMerge size={15} />
      ) : sync.status === "remote-unreadable" ? (
        <AlertTriangle size={15} className="text-amber-200" />
      ) : (
        <span aria-hidden className={cn("inline-block h-2 w-2 rounded-full", sync.status === "in-sync" ? "bg-emerald-300" : "bg-amber-300")} />
      )}
      <span data-testid="publish-status" data-status={sync.status}>
        {label}
      </span>
    </button>
  );
}

export const Header = memo(function Header(props: HeaderProps) {
  const { session, doc, compact, githubConfigured, embed = false, keepAgentNonce = 0 } = props;
  const openComments = useSessionValue(session, (s) => s.comments.list().filter((c) => !c.resolved).length);
  const linked = doc.storage !== "local";
  const canEdit = session.role === "owner" || session.role === "editor";
  // Star state and the notifications poll wait for the first sync: the socket handshake and the
  // collab-token call get the server to themselves on open (#118).
  const settled = useOpenSettled(session);
  // "Keep an agent here": one dialog, opened from the presence popover, the command palette and the slash menu.
  const [keepAgentOpen, setKeepAgentOpen] = useState(false);
  useEffect(() => {
    if (keepAgentNonce > 0) setKeepAgentOpen(true);
  }, [keepAgentNonce]);
  const keepAgentEverOpened = useEverTrue(keepAgentOpen);
  const liveTitle = useSessionValue(session, (s) => s.title || doc.title);
  const openKeepAgent = useCallback(() => setKeepAgentOpen(true), []);

  return (
    <header className="app-header safe-top safe-x box-content flex h-14 shrink-0 items-center gap-2 border-b border-line md:h-16 md:gap-3 md:[--safe-pad:1rem]" data-testid="header" data-embed={embed || undefined}>
      {compact ? (
        <button type="button" className="icon-btn h-9 w-9 shrink-0" onClick={props.onOutline} aria-label="Outline" title="Outline" data-testid="outline-button">
          <PanelLeft size={20} />
        </button>
      ) : embed ? (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center" aria-label="Markdoc" data-testid="embed-logo">
          <Logo className="h-8 w-8" />
        </span>
      ) : (
        <Link href="/" className="icon-btn h-10 w-10 shrink-0" aria-label="Back to documents" title="All documents">
          <Logo className="h-8 w-8" />
        </Link>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-4">
        <TitleEditor session={session} fallback={doc.title} compact={compact} />
        {!embed && !compact && <HeaderStar docId={doc.id} ready={settled} />}
        <SaveIndicator session={session} compact={compact} />
      </div>
      <div className="flex shrink-0 items-center gap-1 md:gap-3" data-testid="header-right">
        <LayoutSegment layout={props.layout} onLayout={props.onLayout} />
        <div className="hidden items-center gap-3 md:flex">
          <ModeSwitcher session={session} />
          <PresenceStack session={session} onJump={props.onJumpToUser} onCancelRequest={props.onCancelRequest} onKeepAgent={openKeepAgent} />
        </div>
        {keepAgentEverOpened && <KeepAgentHereDialog doc={{ id: doc.id, title: liveTitle }} open={keepAgentOpen} onOpenChange={setKeepAgentOpen} onCreateToken={props.onCreateToken} />}
        {!embed && session.user.login && <NotificationsBell currentDocId={doc.id} onOpen={props.onOpenNotification} ready={settled} />}
        {!embed && !compact && (
          <button type="button" className="btn btn-outline" onClick={props.onShare} data-testid="share-button">
            <UserPlus size={17} />
            Share
          </button>
        )}
        <Tip label={props.commentsOpen ? "Hide comments" : "Show comments"} shortcut={shortcut("Mod-Alt-M")}>
          <button
            type="button"
            className="icon-btn relative"
            onClick={(event) => props.onToggleComments(event.detail === 0)}
            data-active={props.commentsOpen}
            aria-label="Comments"
            data-testid="comments-toggle"
          >
            <MessageSquare size={20} />
            {openComments > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-on-accent" data-testid="comments-badge">
                {openComments}
              </span>
            )}
          </button>
        </Tip>
        {!embed && <Menu onOpenChange={(o) => o && props.onMoreMenuOpen?.()}>
          <MenuTrigger asChild>
            <button type="button" className="icon-btn" aria-label="More" data-testid="more-menu">
              <MoreVertical size={20} />
            </button>
          </MenuTrigger>
          <MenuContent align="end" className="w-64">
            {compact && (
              <>
                <MenuItem icon={<UserPlus size={15} />} onSelect={props.onShare} data-testid="menu-share">
                  Share…
                </MenuItem>
                <MenuItem
                  icon={linked ? <UploadCloud size={15} /> : <GitHubIcon size={15} />}
                  onSelect={linked ? props.onPublishNow : props.onPublish}
                  disabled={props.publishing || (linked ? !canEdit : !props.isOwner || !githubConfigured)}
                  title={!linked && !githubConfigured ? GITHUB_NOT_CONFIGURED : undefined}
                  data-testid="menu-publish"
                >
                  {linked ? (doc.storage === "gist" ? "Update gist" : "Commit to GitHub…") : <GitHubEntryLabel configured={githubConfigured}>Publish to GitHub…</GitHubEntryLabel>}
                </MenuItem>
                <MenuSeparator />
                <ModeItems session={session} />
                <MenuSeparator />
              </>
            )}
            <MenuItem icon={<History size={15} />} onSelect={props.onHistory} data-testid="menu-history">
              Version history
            </MenuItem>
            <MenuItem icon={<Activity size={15} />} onSelect={props.onActivity} data-testid="menu-activity">
              Activity
            </MenuItem>
            {canEdit && (
              <MenuItem icon={<Pencil size={15} />} onSelect={props.onNameVersion}>
                Name current version
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem icon={<Download size={15} />} onSelect={() => props.onDownload("md", false)} data-testid="download-md">
              Download Markdown
            </MenuItem>
            <MenuItem icon={<FileCode2 size={15} />} onSelect={() => props.onDownload("html", false)} data-testid="download-html">
              Download HTML
            </MenuItem>
            <MenuItem icon={<FileText size={15} />} onSelect={() => props.onDownload("pdf", false)} data-testid="download-pdf">
              Download PDF
            </MenuItem>
            <MenuItem icon={<Copy size={15} />} onSelect={props.onCopyMarkdown}>
              Copy Markdown
            </MenuItem>
            <MenuItem icon={<Files size={15} />} onSelect={props.onDuplicate} data-testid="menu-duplicate">
              Make a copy
            </MenuItem>
            <MenuItem icon={<BookOpen size={15} />} onSelect={() => window.open(`/p/${doc.id}`, "_blank", "noopener")} data-testid="menu-reader">
              Open reader view
            </MenuItem>
            <MenuSeparator />
            {linked && doc.githubUrl && (
              <MenuItem icon={<ExternalLink size={15} />} onSelect={() => window.open(doc.githubUrl!, "_blank", "noopener")}>
                Open on GitHub
              </MenuItem>
            )}
            {props.isOwner && (
              <MenuItem
                icon={<GitHubIcon size={15} />}
                onSelect={props.onPublish}
                disabled={!linked && !githubConfigured}
                title={!linked && !githubConfigured ? GITHUB_NOT_CONFIGURED : undefined}
                data-testid="menu-github"
              >
                {linked ? "GitHub connection…" : <GitHubEntryLabel configured={githubConfigured}>Connect to GitHub…</GitHubEntryLabel>}
              </MenuItem>
            )}
            {props.onCommandPalette && (
              <MenuItem icon={<Command size={15} />} onSelect={props.onCommandPalette} shortcut={shortcut("Mod-K")} data-testid="menu-command-palette">
                Search commands
              </MenuItem>
            )}
            <MenuItem icon={<Keyboard size={15} />} onSelect={props.onShortcuts}>
              Keyboard shortcuts
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<ArrowLeft size={15} />} onSelect={props.onHome}>
              All documents
            </MenuItem>
            <MenuItem icon={<LogOut size={15} />} onSelect={() => void signOutSafely()}>
              Sign out
            </MenuItem>
            {props.isOwner && (
              <>
                <MenuSeparator />
                <MenuItem icon={<Trash2 size={15} />} className="text-danger" onSelect={props.onDelete} data-testid="menu-delete">
                  Move to trash
                </MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>}
        {!embed && !compact && (
          <Menu>
            <div className="flex items-stretch" data-sync-status={linked ? (props.sync?.status ?? "unknown") : undefined}>
              {linked && canEdit && props.sync ? (
                <PublishStatusButton sync={props.sync} publishing={props.publishing} onPublishNow={props.onPublishNow} onPull={props.onPull} onSync={props.onSync} />
              ) : (
                <MenuTrigger asChild>
                  <button type="button" className="btn btn-primary gap-1.5 rounded-r-none pl-4 pr-3" disabled={props.publishing} data-testid="publish-button">
                    {props.publishing ? <Loader2 size={16} className="animate-spin" /> : null}
                    Publish
                  </button>
                </MenuTrigger>
              )}
              <MenuTrigger asChild>
                <button type="button" className="btn btn-primary rounded-l-none border-l border-white/20 px-1.5" disabled={props.publishing} aria-label="Publish options" data-testid="publish-menu">
                  <ChevronDown size={16} className="opacity-80" />
                </button>
              </MenuTrigger>
            </div>
            <MenuContent align="end" className="w-72">
              {linked ? (
                <>
                  <MenuLabel>
                    {doc.storage === "gist" ? "Gist" : `${doc.repoOwner}/${doc.repoName} · ${doc.repoBranch}`}
                    {props.sync && <span className="ml-1 font-normal text-ink-3">· {SYNC_LABELS[props.sync.status]}</span>}
                  </MenuLabel>
                  <MenuItem icon={<UploadCloud size={15} />} onSelect={props.onPublishNow} disabled={!canEdit}>
                    {doc.storage === "gist" ? "Update gist" : "Commit to GitHub…"}
                  </MenuItem>
                  <MenuItem icon={<RefreshCw size={15} />} onSelect={props.onPull} disabled={!canEdit || props.sync?.status === "remote-unreadable"}>
                    Pull latest from GitHub
                  </MenuItem>
                  <MenuItem icon={<GitMerge size={15} />} onSelect={props.onSync} disabled={!canEdit} data-testid="menu-sync">
                    Sync…
                  </MenuItem>
                  {doc.githubUrl && (
                    <MenuItem icon={<ExternalLink size={15} />} onSelect={() => window.open(doc.githubUrl!, "_blank", "noopener")}>
                      Open on GitHub
                    </MenuItem>
                  )}
                  {props.isOwner && (
                    <>
                      <MenuSeparator />
                      <MenuItem icon={<Link2 size={15} />} onSelect={props.onPublish}>
                        Change connection…
                      </MenuItem>
                    </>
                  )}
                </>
              ) : (
                <>
                  <MenuLabel>Publish to GitHub</MenuLabel>
                  <MenuItem
                    icon={<GitHubIcon size={15} />}
                    onSelect={props.onPublish}
                    disabled={!props.isOwner || !githubConfigured}
                    title={!githubConfigured ? GITHUB_NOT_CONFIGURED : undefined}
                    data-testid="menu-publish-github"
                  >
                    <GitHubEntryLabel configured={githubConfigured}>Gist or repository…</GitHubEntryLabel>
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem icon={<Download size={15} />} onSelect={() => props.onDownload("md", false)}>
                    Download Markdown
                  </MenuItem>
                  <MenuItem icon={<Share2 size={15} />} onSelect={props.onShare}>
                    Share link…
                  </MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
        )}
      </div>
    </header>
  );
});
