"use client";
import { Avatar, Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger, Tip } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { api, apiErrorText } from "@/lib/api";
import type { Layout } from "@/lib/viewport";

import { cn, shortcut } from "@/lib/utils";
import { jsonEqual, useOpenSettled, useSessionValue } from "./use-session";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import type { NotificationDto } from "@/lib/api";
import { pendingRequests, useAgentRequests } from "./agent-requests";
import { AgentBusyBadge, ConnectAgentButton, PresenceActivity, PresenceRequests, WaitingPlaceholder, busyAgentNames, isRecentActivity, pendingWorker, presenceAgentName, presenceNameOf, useAgentActivity, waitingLabel } from "./presence-agents";
import { signOutSafely } from "@/lib/sign-out";
import { Logo } from "@/components/ui/logo";
import { useEverTrue, useHydrated } from "@/lib/hooks";
import { lazyOnFirstUse } from "./lazy-on-first-use";
import { HEADER_BOX } from "./chrome-classes";
import { useEnterOnRelease, usePlaceHold } from "./press-once";

// On demand (#1150): the dialog, with its setup steps and copy blocks behind it, is fetched on its first
// open and then stays mounted (mount-once gate below), so Radix's close handling and focus return are unchanged.
const AgentDialog = lazyOnFirstUse(() => import("@/components/agents/agent-dialog"), (m) => m.AgentDialog);

type ManualSaveState =
  | { readonly session: CollabSession; readonly status: "pending" }
  | { readonly session: CollabSession; readonly status: "failed"; readonly message: string };

function saveStateVisual(state: SaveState): { className: string; icon: React.ReactNode } {
  switch (state) {
    case "saved":
      return { className: "text-success", icon: <Check size={16} strokeWidth={2.5} /> };
    case "pending":
      return { className: "text-ink-3", icon: <CloudOff size={16} /> };
    case "saving":
    case "connecting":
      return { className: "text-ink-3", icon: <Loader2 size={16} className="animate-spin" /> };
    case "reconnecting":
      return { className: "text-warning", icon: <Loader2 size={16} className="animate-spin" /> };
    case "offline":
      return { className: "text-warning", icon: <CloudOff size={16} /> };
    case "error":
      return { className: "text-danger", icon: <AlertTriangle size={16} /> };
  }
}

export function SaveIndicator({ session, compact }: { session: CollabSession; compact?: boolean }) {
  const liveState = useSessionValue(session, (s) => s.saveState);
  const liveUnsyncedChanges = useSessionValue(session, (s) => s.unsyncedChanges);
  const liveDirty = useSessionValue(session, (s) => s.dirty);
  const liveRecovered = useSessionValue(session, (s) => s.recovered);
  const liveProlonged = useSessionValue(session, (s) => s.prolongedOffline);
  const saveError = useSessionValue(session, (s) => s.saveError);
  // Pending and failure belong to the session they were started on, so a replaced session starts clean.
  const [manualSave, setManualSave] = useState<ManualSaveState | null>(null);
  // Blocks a second click that lands before React re-renders the button as disabled.
  const savingRef = useRef<CollabSession | null>(null);
  const current = manualSave?.session === session ? manualSave : null;
  const manualPending = current?.status === "pending";
  const manualError = current?.status === "failed" ? current.message : null;
  const canEdit = session.canEdit;

  // Same path as Ctrl+S (#2217): flush the session directly on every click or Enter/Space.
  const onSave = () => {
    if (!session.canEdit || savingRef.current === session) return;
    const saving = session;
    savingRef.current = saving;
    setManualSave({ session: saving, status: "pending" });
    saving.flushSave().then(
      () => {
        setManualSave((s) => (s?.session === saving ? null : s));
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "Save failed";
        setManualSave((s) => (s?.session === saving ? { session: saving, status: "failed", message } : s));
      },
    ).finally(() => {
      if (savingRef.current === saving) savingRef.current = null;
    });
  };

  // The server renders a fresh session ("Connecting…"); an offline client may already have
  // failed to connect by the time React hydrates. Match the server markup first, then switch.
  const hydrated = useHydrated();
  const state: SaveState = hydrated ? liveState : "connecting";
  const unsynced = hydrated ? Math.max(liveUnsyncedChanges, liveDirty ? 1 : 0) : 0;
  const recovered = hydrated && liveRecovered;
  const prolonged = hydrated && liveProlonged;
  const label = state === "error" && saveError
    ? "Save failed — retry"
    : saveStateLabel(state, unsynced, recovered, prolonged);
  const visual = saveStateVisual(state);
  const flash = state === "saved" && recovered;
  return (
    <span
      className={cn(
        // Never wraps: the title gives up its room first, then the label shortens with "…" (the icon stays).
        // The cap leaves the title a share of the row next to a long label.
        "inline-flex min-w-6 max-w-[60%] items-center gap-1.5 rounded-md text-sm font-medium transition-colors",
        visual.className,
        flash && "save-state-recovered",
      )}
      data-testid="save-state"
      data-state={state}
      data-live-state={state}
      data-unsynced={unsynced}
      data-recovered={flash || undefined}
      data-prolonged={prolonged || undefined}
      role="status"
      title={manualError ?? saveError ?? (compact ? label : undefined)}
    >
      <button
        type="button"
        className="header-save-button tap-target relative inline-flex min-h-6 min-w-6 items-center justify-center gap-1.5 [&>svg]:shrink-0"
        disabled={!canEdit || manualPending}
        aria-busy={manualPending || undefined}
        aria-label="Save document"
        // On the button, which the tap-target overlay makes the hover target: a shortened label keeps its full text
        // on hover. Errors and phones leave it to the chip's own tooltip.
        title={compact || manualError || saveError ? undefined : label}
        onClick={onSave}
      >
        {visual.icon}
        {/* Phones show the icon only; the server markup uses the same responsive label. */}
        <span className={cn(compact ? "sr-only" : "min-w-0 truncate max-md:sr-only")}>{manualError ?? label}</span>
      </button>
    </span>
  );
}

interface TitleEditState {
  readonly generation: object;
  readonly session: CollabSession;
  readonly draft: string;
}

export function TitleEditor({ session, fallback, compact }: { session: CollabSession; fallback: string; compact?: boolean }) {
  const { title, canEdit } = useSessionValue(
    session,
    (current) => ({ title: current.title || fallback, canEdit: current.canWrite }),
    jsonEqual,
  );
  const [storedEdit, setStoredEdit] = useState<TitleEditState | null>(null);
  let edit = storedEdit;
  if (edit && (edit.session !== session || !canEdit)) {
    edit = null;
    setStoredEdit(null);
  }
  // The edit that has already been committed or cancelled; a later blur of the same input must not commit again.
  const finished = useRef<object | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const focusedGeneration = useRef<object | null>(null);

  useEffect(() => {
    document.title = `${title} · Markdoc`;
  }, [title]);

  useLayoutEffect(() => {
    if (!edit || focusedGeneration.current === edit.generation || !input.current) return;
    focusedGeneration.current = edit.generation;
    input.current.focus();
    input.current.select();
  });

  const finish = (commit: boolean) => {
    if (!edit || finished.current === edit.generation) return;
    finished.current = edit.generation;
    if (commit) {
      const next = edit.draft.trim();
      if (next && next !== title) session.setTitle(next);
    }
    const generation = edit.generation;
    setStoredEdit((current) => (current?.generation === generation ? null : current));
  };

  const inputClassName = "h-9 max-md:h-11 min-w-[12rem] max-w-[28rem] rounded-lg border border-accent bg-surface px-2 text-[22px] font-semibold text-ink outline-none ring-2 ring-accent/20";
  if (edit) {
    const generation = edit.generation;
    return (
      <input
        ref={input}
        value={edit.draft}
        onChange={(event) => {
          const nextDraft = event.target.value;
          setStoredEdit((current) => (current?.generation === generation ? { ...current, draft: nextDraft } : current));
        }}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== "Escape") return;
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat || event.nativeEvent.isComposing) return;
          finish(event.key === "Enter");
        }}
        className={inputClassName}
        aria-label="Document title"
        data-testid="title-input"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={(event) => {
        if (!canEdit || event.button !== 0) return;
        setStoredEdit((current) => current ?? { generation: {}, session, draft: title });
      }}
      className={cn("group editor-header-title flex min-w-0 shrink-[100000] items-center gap-2 rounded-lg px-2 py-1 text-left max-md:px-0.5", canEdit && "hover:bg-surface-3")}
      title={canEdit ? "Rename" : title}
      data-testid="title"
    >
      {/* Phones render `compact` only after hydration; the `max-md:` rules make the server markup match its size and
          set of controls so the header does not shift when the breakpoint flips (#1470). */}
      {/* Phones: the right-hand controls leave ~80 px, so the title wraps to two smaller lines instead of "Long …" (#2415). */}
      <span
        className={cn(
          "doc-title truncate font-semibold leading-8 text-ink max-md:line-clamp-2 max-md:whitespace-normal max-md:wrap-break-word max-md:text-[15px] max-md:leading-[18px]",
          compact ? "text-lg" : "text-lg md:text-[22px]",
        )}
        data-testid="title-text"
      >
        {title}
      </span>
      {canEdit && !compact && <Pencil size={15} className="shrink-0 text-ink-4 opacity-0 transition-opacity group-hover:opacity-100 max-md:hidden" />}
    </button>
  );
}

/**
 * Personal star for the open document. Stars live on the dashboard, so the header asks the API for
 * the current state once the open has settled (the editor does not need it to become editable) and
 * stays hidden for anonymous visitors (who cannot star).
 */
type HeaderStarError = {
  action: "load" | "star" | "unstar";
  message: string;
};

type HeaderStarAuthority = {
  mount: symbol;
  docId: string;
};

type HeaderStarOperation = {
  authority: HeaderStarAuthority;
  operation: number;
  retry: boolean;
} & (
  | { action: "load"; confirmed: null }
  | { action: "star" | "unstar"; confirmed: boolean }
);

interface HeaderStarState {
  docId: string;
  confirmed: boolean | null;
  starred: boolean | null;
  pending: "load" | "toggle" | null;
  error: HeaderStarError | null;
}

const emptyHeaderStarState = (docId: string): HeaderStarState => ({
  docId,
  confirmed: null,
  starred: null,
  pending: null,
  error: null,
});

export function HeaderStar({ docId, ready }: { docId: string; ready: boolean }) {
  const [state, setState] = useState<HeaderStarState>(() => emptyHeaderStarState(docId));
  const [mount] = useState(() => Symbol("header-star"));
  const authority = useRef<HeaderStarAuthority | null>(null);
  const owner = useRef<HeaderStarOperation | null>(null);
  const nextOperation = useRef(0);

  const owns = useCallback(
    (operation: HeaderStarOperation) => authority.current === operation.authority && owner.current === operation,
    [],
  );

  useLayoutEffect(() => {
    const currentAuthority: HeaderStarAuthority | null = ready ? { mount, docId } : null;
    authority.current = currentAuthority;
    owner.current = null;
    setState((current) => {
      if (current.docId === docId && current.confirmed === null && current.starred === null && current.pending === null && current.error === null) return current;
      return emptyHeaderStarState(docId);
    });
    return () => {
      if (authority.current === currentAuthority) authority.current = null;
      if (owner.current?.authority === currentAuthority) owner.current = null;
    };
  }, [docId, mount, ready]);

  const start = useCallback(
    (request: { action: "load"; confirmed: null; retry: boolean } | { action: "star" | "unstar"; confirmed: boolean; retry: boolean }) => {
      const currentAuthority = authority.current;
      if (!ready || !currentAuthority || currentAuthority.mount !== mount || currentAuthority.docId !== docId || owner.current) return;
      const operation: HeaderStarOperation = {
        authority: currentAuthority,
        operation: ++nextOperation.current,
        ...request,
      };
      owner.current = operation;

      if (operation.action === "load") {
        setState((previous) => ({
          docId: operation.authority.docId,
          confirmed: null,
          starred: null,
          pending: "load",
          error: operation.retry && previous.docId === operation.authority.docId && previous.error?.action === "load" ? previous.error : null,
        }));
      } else {
        setState({
          docId: operation.authority.docId,
          confirmed: operation.confirmed,
          starred: operation.action === "star",
          pending: "toggle",
          error: null,
        });
      }

      void (async () => {
        try {
          const result = operation.action === "load"
            ? await api.documents.starred(operation.authority.docId)
            : operation.action === "star"
              ? await api.documents.star(operation.authority.docId)
              : await api.documents.unstar(operation.authority.docId);
          if (!owns(operation)) return;
          setState({
            docId: operation.authority.docId,
            confirmed: result.starred,
            starred: result.starred,
            pending: null,
            error: null,
          });
        } catch (error: unknown) {
          if (!owns(operation)) return;
          setState({
            docId: operation.authority.docId,
            confirmed: operation.confirmed,
            starred: operation.confirmed,
            pending: null,
            error: {
              action: operation.action,
              message: apiErrorText(
                error,
                operation.action === "load"
                  ? "Could not load star status"
                  : operation.action === "star"
                    ? "Could not star document"
                    : "Could not unstar document",
              ),
            },
          });
        } finally {
          if (authority.current === operation.authority && owner.current === operation) owner.current = null;
        }
      })();
    },
    [docId, mount, owns, ready],
  );

  useEffect(() => {
    if (ready) start({ action: "load", confirmed: null, retry: false });
  }, [ready, start]);

  // An empty box of the button's size until the answer is in: the save status beside it used to jump
  // 48 px to the right when the star arrived a moment after the header.
  const slot = <span className="h-8 w-8 shrink-0 max-md:hidden" aria-hidden="true" data-testid="header-star-slot" />;
  if (!ready) return slot;
  const current = state.docId === docId ? state : emptyHeaderStarState(docId);
  if (current.starred === null) {
    if (current.error?.action !== "load") return slot;
    const retrying = current.pending === "load";
    return (
      <>
        <span className="sr-only" role="alert" aria-atomic="true">
          {current.error.message}. Retry star status.
        </span>
        <Tip label={retrying ? "Retrying star status…" : `${current.error.message}. Retry.`}>
          <button
            type="button"
            onClick={() => start({ action: "load", confirmed: null, retry: true })}
            disabled={retrying}
            className="icon-btn h-8 w-8 shrink-0 text-danger max-md:hidden"
            aria-label={retrying ? "Retrying star status" : "Retry star status"}
            aria-busy={retrying || undefined}
            data-testid="header-star"
            data-state={retrying ? "retrying" : "error"}
          >
            <RefreshCw size={17} className={retrying ? "animate-spin" : undefined} />
          </button>
        </Tip>
      </>
    );
  }

  const toggle = () => {
    if (current.confirmed === null) return;
    start({
      action: current.starred ? "unstar" : "star",
      confirmed: current.confirmed,
      retry: retryAction !== null,
    });
  };

  const retryAction = current.error?.action === "star" || current.error?.action === "unstar" ? current.error.action : null;
  const label = current.pending === "toggle"
    ? current.starred ? "Starring document…" : "Unstarring document…"
    : retryAction
      ? retryAction === "star" ? "Retry star document" : "Retry unstar document"
      : current.starred ? "Unstar document" : "Star document";

  return (
    <>
      {current.error && (
        <span className="sr-only" role="alert" aria-atomic="true">
          {current.error.message}. {label}.
        </span>
      )}
      <Tip label={label}>
        <button
          type="button"
          onClick={toggle}
          disabled={current.pending === "toggle"}
          className={cn("icon-btn h-8 w-8 shrink-0 max-md:hidden", current.error ? "text-danger" : current.starred ? "text-amber-500" : "text-ink-4")}
          aria-pressed={current.starred}
          aria-label={label}
          aria-busy={current.pending === "toggle" || undefined}
          data-testid="header-star"
          data-starred={current.starred}
          data-state={current.pending ?? (current.error ? "error" : "ready")}
        >
          <Star size={17} fill={current.starred ? "currentColor" : "none"} />
        </button>
      </Tip>
    </>
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
  /** Opens the "Connect an AI agent" dialog; the popover offers it while no agent is present. */
  onConnectAgent?: () => void;
}

interface PresenceVisit {
  session: CollabSession;
  onJump: PresenceStackProps["onJump"];
  onCancelRequest: PresenceStackProps["onCancelRequest"];
  onConnectAgent: PresenceStackProps["onConnectAgent"];
}

interface PresenceVisitState {
  visit: PresenceVisit;
  open: boolean;
  cancelling: ReadonlySet<string>;
  now: number;
}

interface CancellationGraceOwner {
  visit: PresenceVisit;
  requestId: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface FreshnessOwner {
  visit: PresenceVisit;
  timer: ReturnType<typeof setInterval> | null;
}

interface PendingRequestsOwner {
  visit: PresenceVisit;
  ids: ReadonlySet<string>;
}

/**
 * Everyone in the document, agents included: agents are bot avatars with a spinner badge while they work,
 * and the popover carries their status, the open requests and the way to put an agent here (task #981).
 */
export function PresenceStack({ session, onJump, onCancelRequest, onConnectAgent }: PresenceStackProps) {
  const visit = useMemo<PresenceVisit>(
    () => ({ session, onJump, onCancelRequest, onConnectAgent }),
    [session, onJump, onCancelRequest, onConnectAgent],
  );
  const users = useSessionValue(session, (s) => s.presence(), jsonEqual);
  const followUserId = useSessionValue(session, (s) => s.followUserId);
  const requests = useAgentRequests(session);
  const activity = useAgentActivity(session);
  const initialState = useMemo<PresenceVisitState>(
    () => ({ visit, open: false, cancelling: new Set(), now: 0 }),
    [visit],
  );
  const [storedState, setStoredState] = useState<PresenceVisitState>(
    () => ({ ...initialState, now: Date.now() }),
  );
  const state = storedState.visit === visit ? storedState : initialState;
  const activeVisit = useRef<PresenceVisit | null>(null);
  const cancellationGrace = useRef(new Map<string, CancellationGraceOwner>());
  const freshnessOwner = useRef<FreshnessOwner | null>(null);
  const pendingRequestsOwner = useRef<PendingRequestsOwner | null>(null);
  const ownsVisit = useCallback((owner: PresenceVisit) => activeVisit.current === owner, []);
  const retireVisit = useCallback((owner: PresenceVisit) => {
    if (activeVisit.current !== owner) return;
    activeVisit.current = null;
    if (pendingRequestsOwner.current?.visit === owner) pendingRequestsOwner.current = null;
    for (const [requestId, grace] of cancellationGrace.current) {
      if (grace.visit !== owner) continue;
      if (grace.timer !== null) clearTimeout(grace.timer);
      if (cancellationGrace.current.get(requestId) === grace) cancellationGrace.current.delete(requestId);
    }
    const freshness = freshnessOwner.current;
    if (freshness?.visit === owner) {
      freshnessOwner.current = null;
      if (freshness.timer !== null) clearInterval(freshness.timer);
    }
  }, []);
  const updateState = useCallback(
    (update: (current: PresenceVisitState) => PresenceVisitState) => {
      if (!ownsVisit(visit)) return;
      setStoredState((current) => {
        if (!ownsVisit(visit) || current.visit !== visit) return current;
        return update(current);
      });
    },
    [ownsVisit, visit],
  );
  const finishCancellation = useCallback(
    (grace: CancellationGraceOwner) => {
      if (!ownsVisit(grace.visit) || cancellationGrace.current.get(grace.requestId) !== grace) return;
      cancellationGrace.current.delete(grace.requestId);
      if (grace.timer !== null) {
        clearTimeout(grace.timer);
        grace.timer = null;
      }
      setStoredState((current) => {
        if (!ownsVisit(grace.visit) || current.visit !== grace.visit || !current.cancelling.has(grace.requestId)) return current;
        const cancelling = new Set(current.cancelling);
        cancelling.delete(grace.requestId);
        return { ...current, cancelling };
      });
    },
    [ownsVisit],
  );
  useLayoutEffect(() => {
    activeVisit.current = visit;
    setStoredState((current) => (current.visit === visit ? current : { ...initialState, now: Date.now() }));
    return () => retireVisit(visit);
  }, [initialState, retireVisit, visit]);

  // Cancel is optimistic: the row and the placeholder go at once; the mirror catches up a moment later. If the
  // server refuses (editor-shell toasts the error) the request is still pending after the grace period and returns.
  const pending = pendingRequests(requests).filter((r) => !state.cancelling.has(r.id));
  useLayoutEffect(() => {
    if (!ownsVisit(visit)) return;
    const owner: PendingRequestsOwner = {
      visit,
      ids: new Set(pendingRequests(requests).map((request) => request.id)),
    };
    pendingRequestsOwner.current = owner;
    for (const grace of cancellationGrace.current.values()) {
      if (grace.visit === visit && !owner.ids.has(grace.requestId)) finishCancellation(grace);
    }
    return () => {
      if (pendingRequestsOwner.current === owner) pendingRequestsOwner.current = null;
    };
  }, [finishCancellation, ownsVisit, requests, visit]);
  const cancelRequest = (id: string) => {
    const currentPending = pendingRequestsOwner.current;
    if (!ownsVisit(visit) || !visit.onCancelRequest || currentPending?.visit !== visit || !currentPending.ids.has(id)) return;
    const existing = cancellationGrace.current.get(id);
    if (existing?.visit === visit) return;
    const grace: CancellationGraceOwner = { visit, requestId: id, timer: null };
    cancellationGrace.current.set(id, grace);
    grace.timer = setTimeout(() => finishCancellation(grace), CANCEL_GRACE_MS);
    updateState((current) => {
      if (current.cancelling.has(id)) return current;
      const cancelling = new Set(current.cancelling);
      cancelling.add(id);
      return { ...current, cancelling };
    });
    visit.onCancelRequest(id);
  };
  // Idle dimming is time-based; re-evaluate it every 15 s while the stack is mounted. A fresh agent
  // activity ("proposed changes · 12 s ago") ticks every 5 s for the 45 s it shows.
  const now = state.now;
  const activityFresh = isRecentActivity(activity, now);
  useLayoutEffect(() => {
    if (!ownsVisit(visit)) return;
    const owner: FreshnessOwner = { visit, timer: null };
    freshnessOwner.current = owner;
    const currentNow = Date.now();
    const tick = () => {
      if (!ownsVisit(visit) || freshnessOwner.current !== owner) return;
      updateState((current) => {
        const nextNow = Date.now();
        return current.now === nextNow ? current : { ...current, now: nextNow };
      });
    };
    tick();
    owner.timer = setInterval(tick, isRecentActivity(activity, currentNow) ? 5_000 : 15_000);
    return () => {
      if (freshnessOwner.current !== owner) return;
      freshnessOwner.current = null;
      if (owner.timer !== null) clearInterval(owner.timer);
    };
  }, [activity, activityFresh, ownsVisit, updateState, visit]);
  const shown = users.slice(0, 3);
  const extra = users.length - shown.length;
  const others = users.filter((u) => !u.isLocal);
  const agents = users.filter((u) => u.isAgent);
  const busy = busyAgentNames(requests, activity, now);
  // Someone else's agent reads "Burke's Copilot CLI" everywhere (docs/agents.md, UI conventions); your own keeps its plain name.
  const viewer = session.user.login ?? null;
  const ownerNameOf = (login: string) => presenceNameOf(users, login);
  const agentName = (u: PresenceUser) => presenceAgentName(u, viewer);
  // No agent in presence but requests pending: the stack shows a dashed placeholder. It reads "waiting" until an
  // agent claims one (agents may claim over REST/MCP before they ever announce themselves), then "working".
  const noAgent = agents.length === 0 && pending.length > 0;
  const unseenWorker = noAgent ? pendingWorker(pending, viewer, ownerNameOf) : null;
  const waiting = noAgent && !unseenWorker;
  const nameOf = (userId: string) => users.find((u) => !u.isAgent && u.id === userId)?.name ?? null;
  const jump = (u: PresenceUser) => {
    if (!ownsVisit(visit) || u.cursor === null) return;
    visit.onJump?.(u);
    updateState((current) => (current.open ? { ...current, open: false } : current));
  };
  const follow = (u: PresenceUser) => {
    if (!ownsVisit(visit)) return;
    visit.session.follow(followUserId === u.id ? null : u.id);
    updateState((current) => (current.open ? { ...current, open: false } : current));
  };
  const connectAgent = () => {
    if (!ownsVisit(visit)) return;
    updateState((current) => (current.open ? { ...current, open: false } : current));
    visit.onConnectAgent?.();
  };
  const changeOpen = (open: boolean) => {
    updateState((current) => (current.open === open ? current : { ...current, open }));
  };
  const roleLabel: Record<string, string> = { owner: "Owner", editor: "Editor", commenter: "Commenter", viewer: "Viewer" };
  const label = (u: PresenceUser) => (u.isLocal ? `${u.name} (you)` : u.isAgent ? `${agentName(u)} (agent${u.status ? `: ${u.status}` : ""})` : u.name);
  return (
    <Popover open={state.open} onOpenChange={changeOpen}>
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
                {u.isAgent && busy.has(u.name) && <AgentBusyBadge name={agentName(u)} />}
              </span>
            </Tip>
          ))}
          {extra > 0 && (
            <Tip label={users.slice(3).map((u) => (u.isAgent ? agentName(u) : u.name)).join(", ")}>
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
            const humanLocation = u.isAgent
              ? undefined
              : `${idle ? "Idle · " : ""}${u.cursor === null ? "no cursor" : u.section ? `in ‘${u.section}’` : "at the top"}`;
            return (
              <li key={u.id} className={cn("flex items-center gap-2.5 rounded-lg px-2 py-1.5", idle && !working && "opacity-60")} data-testid="presence-row" data-user-id={u.id} data-agent={u.isAgent ? "" : undefined}>
                <span className="relative inline-flex shrink-0">
                  {u.isAgent ? <AgentAvatar name={u.name} color={u.color} size={28} /> : <Avatar name={u.name} src={u.avatar} color={u.color} size={28} />}
                  {working && <AgentBusyBadge name={agentName(u)} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-ink">
                    <span className="truncate" title={u.isLocal ? `${u.name} (you)` : u.isAgent ? agentName(u) : u.name}>{u.isLocal ? `${u.name} (you)` : u.isAgent ? agentName(u) : u.name}</span>
                    {u.isAgent && <span className="rounded-md bg-violet-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-950 dark:text-violet-300">Agent</span>}
                    {u.role && <span className="rounded-md bg-surface-2 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-ink-3">{roleLabel[u.role] ?? u.role}</span>}
                  </div>
                  <div className="truncate text-xs text-ink-3" data-testid="presence-section" title={humanLocation}>
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
                      humanLocation
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
        {pending.length > 0 && <PresenceRequests session={session} pending={pending} nameOf={nameOf} ownerNameOf={ownerNameOf} onCancel={onCancelRequest ? cancelRequest : undefined} />}
        {waiting && (
          <p className="px-2 pb-1 pt-1.5 text-xs text-ink-3" data-testid="presence-waiting-note">
            {waitingLabel(pending.length)} — none is sitting in this document.
          </p>
        )}
        {agents.length === 0 && onConnectAgent && (
          <div className={cn("px-1 pb-1", waiting ? "pt-1" : "pt-1.5")}>
            <ConnectAgentButton onClick={connectAgent} primary={waiting} />
          </div>
        )}
        {others.length === 0 && pending.length === 0 && <div className="px-2 pb-1 pt-1.5 text-xs text-ink-3">Share the document to work on it together.</div>}
      </PopoverContent>
    </Popover>
  );
}

const MODE_ICONS: Record<EditMode, React.ReactNode> = {
  editing: <PenLine size={15} />,
  suggesting: <MessageSquarePlus size={15} />,
  viewing: <Eye size={15} />,
};
const MODE_LABELS: Record<EditMode, string> = { editing: "Editing", suggesting: "Suggesting", viewing: "Viewing" };

export function ModeSwitcher({ session }: { session: CollabSession }) {
  const mode = useSessionValue(session, (s) => s.mode);
  const editable = session.role === "owner" || session.role === "editor";
  const [open, setOpen] = useState(false);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        asChild
        // Radix's trigger opens on Enter, Space and ArrowDown; ArrowUp opens it too, and Radix then focuses the first enabled row.
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" || open) return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <button
          type="button"
          className={cn(
            "btn btn-sm gap-1.5 border",
            mode === "suggesting" ? "border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300" : "border-line-2 bg-surface text-ink-2 hover:bg-surface-2",
          )}
          data-testid="mode-switcher"
        >
          {MODE_ICONS[mode]}
          <span>{MODE_LABELS[mode]}</span>
          <ChevronDown size={14} className="text-ink-4" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="w-64">
        <MenuRadioGroup value={mode} onValueChange={(value) => session.setMode(value as EditMode)}>
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
        <MenuItem
          icon={<BookOpen size={15} />}
          onSelect={() => window.open(`/p/${session.docId}`, "_blank", "noopener")}
          data-testid="mode-reader"
        >
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
  documentMutation: "delete" | "duplicate" | null;
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
  /** Bumped by Share's agent row, the command palette and the `/agent` slash item: opens the "Connect an AI agent" dialog. */
  connectAgentNonce?: number;
  /** Canvas mode: hide navigation, sharing, publishing, and account menus. */
  embed?: boolean;
}

type LayoutSegmentPane = Extract<Layout, "rich" | "code">;

const LAYOUT_SEGMENT_OPTIONS = [
  { value: "rich", label: "Preview", Icon: Eye },
  { value: "code", label: "Markdown", Icon: Code2 },
] as const satisfies readonly { value: LayoutSegmentPane; label: string; Icon: typeof Eye }[];

function layoutSegmentDestination(key: string, current: number, count: number): number | null {
  if (count < 2 || current < 0 || current >= count) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + count) % count;
  if (key === "Home") return current === 0 ? null : 0;
  if (key === "End") return current === count - 1 ? null : count - 1;
  return null;
}

export function LayoutSegment({ layout, onLayout }: { layout: Layout; onLayout: (l: Layout) => void }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const destination = layoutSegmentDestination(event.key, index, LAYOUT_SEGMENT_OPTIONS.length);
    if (destination === null) return;
    event.preventDefault();
    buttons.current[destination]?.focus({ preventScroll: true });
    onLayout(LAYOUT_SEGMENT_OPTIONS[destination].value);
  };

  return (
    <div className="layout-segment inline-flex h-9 shrink-0 rounded-lg border border-line-2 bg-surface p-0.5 md:hidden" role="radiogroup" aria-label="Pane" data-testid="layout-segment">
      {LAYOUT_SEGMENT_OPTIONS.map((option, index) => {
        const checked = option.value === layout;
        return (
          <button
            ref={(element) => {
              buttons.current[index] = element;
            }}
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.label}
            title={option.label}
            tabIndex={checked ? 0 : -1}
            className={cn("layout-segment-option tap-target relative inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors", checked ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink")}
            onClick={() => onLayout(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            data-testid={`layout-segment-${option.value}`}
          >
            <option.Icon size={17} />
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

/** Marks the plain Publish button that stands in the status chip's place until the first status arrives. */
const STATUS_CHIP_PLACE = "data-status-chip-place";

/** What one press on the status chip does, per sync status. */
function statusChipAction(status: SyncStatusDto["status"]): "publish" | "pull" | "sync" {
  if (status === "remote-ahead") return "pull";
  if (status === "diverged" || status === "remote-unreadable") return "sync";
  return "publish";
}

const STATUS_CHIP_LABELS: Record<SyncStatusDto["status"], string> = {
  "in-sync": "Up to date",
  "local-ahead": "Publish",
  "remote-ahead": "Pull",
  diverged: "Both changed",
  "remote-unreadable": SYNC_LABELS["remote-unreadable"],
};

/**
 * The status chip of a document linked to GitHub. It stands where the Publish button is otherwise, says
 * how the document and its GitHub file compare, and one press does what that calls for: commit (or
 * update the gist), pull, or open Sync.
 *
 * A plain button. A press runs the action of the status in this render, which is the label on screen
 * when it lands. A status that has gone stale by then is caught by the server: it refuses the publish or
 * the pull, and the editor opens Sync on its own, with its choices off.
 *
 * While a publish or a pull runs the chip is `aria-disabled`, not `disabled`: a disabled button drops
 * focus to the page under the key that pressed it. A press on a chip that is off does nothing.
 */
export function PublishStatusButton({
  sync,
  publishing,
  onPublishNow,
  onPull,
  onSync,
}: Pick<HeaderProps, "sync" | "publishing" | "onPublishNow" | "onPull" | "onSync"> & { sync: SyncStatusDto }) {
  const action = statusChipAction(sync.status);
  // A held Enter is one press: without this its repeats would press the chip again as soon as the request has ended.
  const enterOnRelease = useEnterOnRelease();
  // A press can put a dialog over the chip, and a click on the page behind a dialog closes it. So the chip's
  // place is kept for the rest of the pointer gesture; the box goes when focus is back on the chip.
  const hold = usePlaceHold(true);
  // The chip takes the place of the plain Publish button when the first status arrives. That button opens
  // the Publish menu, and focus that was on it would fall to the page with it. It goes to the arrow beside
  // the chip instead, which opens the same menu: a key aimed at Publish must not press the chip, whose
  // press pulls or publishes. Focus anywhere else is left alone. Read while this render is pending: once
  // React commits, the button is gone and focus is on <body>.
  const [replacesFocused] = useState(() => typeof document !== "undefined" && !!document.activeElement?.hasAttribute(STATUS_CHIP_PLACE));
  const button = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const beside = button.current?.nextElementSibling;
    // An arrow that is disabled does not take focus: it then stays where the browser left it.
    if (replacesFocused && document.activeElement === document.body && beside instanceof HTMLElement) beside.focus({ preventScroll: true });
  }, [replacesFocused]);

  const onClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    // The second click of a double-click, or of a double tap, is not a second press.
    if (publishing || event.detail > 1) return;
    hold.arm(event, event.currentTarget);
    if (action === "pull") onPull();
    else if (action === "sync") onSync();
    else onPublishNow();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className="btn btn-primary gap-1.5 rounded-r-none pl-3 pr-3 aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-accent"
        aria-disabled={publishing || undefined}
        data-testid="publish-button"
        title={SYNC_LABELS[sync.status]}
        onClick={onClick}
        onFocus={hold.disarm}
        onKeyDown={enterOnRelease.onKeyDown}
        onKeyUp={enterOnRelease.onKeyUp}
        onBlur={enterOnRelease.onBlur}
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
          {STATUS_CHIP_LABELS[sync.status]}
        </span>
      </button>
      {hold.shield}
    </>
  );
}

// The arrow shares Radix's trigger ref with the Publish button beside it. When the status chip takes that
// button's place its unmount clears the shared ref, and the menu can no longer hand focus back to the arrow on
// close. A ref whose identity follows the swap makes the arrow register again in the same commit (#2215).
const ARROW_BESIDE_PUBLISH = () => undefined;
const ARROW_BESIDE_STATUS = () => undefined;

function PublishMenu({ props }: { props: HeaderProps }) {
  const { doc, session, githubConfigured } = props;
  const linked = doc.storage !== "local";
  const canEdit = useSessionValue(session, (current) => current.canWrite);
  // The sync status the chip shows; null while the plain Publish button stands in its place.
  const chipSync = linked && canEdit ? props.sync : null;
  const [openFor, setOpenFor] = useState<{ session: CollabSession; doc: DocumentDto } | null>(null);
  const open = openFor !== null && openFor.session === session && openFor.doc.id === doc.id;
  // ArrowUp opens on the last enabled row, ArrowDown on the first; other openings keep Radix's own focus.
  const arrowFocus = useRef<"first" | "last" | null>(null);
  const onOpenChange = (next: boolean) => {
    if (!next) arrowFocus.current = null;
    setOpenFor(next ? { session, doc } : null);
  };
  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    arrowFocus.current = event.key === "ArrowUp" ? "last" : "first";
    if (!open) setOpenFor({ session, doc });
  };
  const onOpenAutoFocus = (event: Event) => {
    const edge = arrowFocus.current;
    arrowFocus.current = null;
    if (!edge) return;
    const content = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const items = Array.from(content?.querySelectorAll<HTMLElement>("[role^='menuitem']:not([data-disabled])") ?? []);
    const target = edge === "last" ? items.at(-1) : items[0];
    if (!target) return;
    event.preventDefault();
    target.focus({ preventScroll: true });
  };

  return (
  <Menu open={open} onOpenChange={onOpenChange}>
      <div className="flex items-stretch max-md:hidden" data-sync-status={linked ? (props.sync?.status ?? "unknown") : undefined}>
        {chipSync ? (
          <PublishStatusButton sync={chipSync} publishing={props.publishing} onPublishNow={props.onPublishNow} onPull={props.onPull} onSync={props.onSync} />
        ) : (
          <MenuTrigger asChild>
            <button type="button" className="btn btn-primary gap-1.5 rounded-r-none pl-4 pr-3" disabled={props.publishing} data-testid="publish-button" {...{ [STATUS_CHIP_PLACE]: "" }}>
              {props.publishing ? <Loader2 size={16} className="animate-spin" /> : null}
              Publish
            </button>
          </MenuTrigger>
        )}
        <MenuTrigger asChild ref={chipSync ? ARROW_BESIDE_STATUS : ARROW_BESIDE_PUBLISH}>
          <button
            type="button"
            className="btn btn-primary rounded-l-none border-l border-white/20 px-1.5"
            disabled={props.publishing}
            aria-label="Publish options"
            data-testid="publish-menu"
            onKeyDown={onTriggerKeyDown}
          >
            <ChevronDown size={16} className="opacity-80" />
          </button>
        </MenuTrigger>
      </div>
      {open && (
        <MenuContent
          align="end"
          className="w-72"
          {...{ onOpenAutoFocus }}
        >
          {linked ? (
            <>
            <MenuLabel>
              {doc.storage === "gist" ? "Gist" : `${doc.repoOwner}/${doc.repoName} · ${doc.repoBranch}`}
              {props.sync && <span className="ml-1 font-normal text-ink-3">· {SYNC_LABELS[props.sync.status]}</span>}
            </MenuLabel>
            <MenuItem icon={<UploadCloud size={15} />} onSelect={() => props.onPublishNow()} disabled={!canEdit}>
              {doc.storage === "gist" ? "Update gist" : "Commit to GitHub…"}
            </MenuItem>
            <MenuItem icon={<RefreshCw size={15} />} onSelect={() => props.onPull()} disabled={!canEdit || props.sync?.status === "remote-unreadable"}>
              Pull latest from GitHub
            </MenuItem>
            <MenuItem icon={<GitMerge size={15} />} onSelect={() => props.onSync()} disabled={!canEdit} data-testid="menu-sync">
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
                <MenuItem icon={<Link2 size={15} />} onSelect={() => props.onPublish()}>
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
              onSelect={() => props.onPublish()}
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
            <MenuItem icon={<Share2 size={15} />} onSelect={() => props.onShare()}>
              Share link…
            </MenuItem>
            </>
          )}
        </MenuContent>
      )}
    </Menu>
  );
}


export const Header = memo(function Header(props: HeaderProps) {
  const { session, doc, compact, githubConfigured, embed = false, connectAgentNonce = 0 } = props;
  const openComments = useSessionValue(session, (s) => s.comments.list().filter((c) => !c.resolved).length);
  const linked = doc.storage !== "local";
  const canEdit = useSessionValue(session, (current) => current.canWrite);
  const [moreOpenFor, setMoreOpenFor] = useState<{ session: CollabSession; docId: string } | null>(null);
  const moreOpen = moreOpenFor !== null && moreOpenFor.session === session && moreOpenFor.docId === doc.id;
  const onMoreMenuOpenChange = (open: boolean) => {
    setMoreOpenFor(open ? { session, docId: doc.id } : null);
    if (open && !moreOpen) props.onMoreMenuOpen?.();
  };
  const openUrl = (url: string) => () => window.open(url, "_blank", "noopener");
  // Star state and the notifications poll wait for the first sync: the socket handshake and the
  // collab-token call get the server to themselves on open (#118).
  const settled = useOpenSettled(session);
  // "Connect an AI agent": one dialog, opened from Share, the presence popover, the command palette and the slash menu.
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  useEffect(() => {
    if (connectAgentNonce > 0) setAgentDialogOpen(true);
  }, [connectAgentNonce]);
  const agentDialogEverOpened = useEverTrue(agentDialogOpen);
  const liveTitle = useSessionValue(session, (s) => s.title || doc.title);
  const openAgentDialog = useCallback(() => setAgentDialogOpen(true), []);
  // Phones can paint the header while the HTML is still being parsed (a 4× slower CPU: `readyState` was "loading" at the
  // first frame in 2 of 3 runs), and then the right group is laid out with only its first children — 70 px, or 110 px
  // with the bell — and grows to 190 px once the comments toggle and ⋮ have arrived, pushing the title and the save chip
  // left (#1562: {x 268, w 110} → {x 188, w 190}, 0.0033–0.0050). Every child is already in the server markup, so the
  // group reserves its final phone width from the first byte: the 70 px pane segment plus 36 px icon buttons with 4 px
  // gaps — comments always, the bell when signed in, ⋮ outside embeds (the desktop-only children are `hidden`/
  // `max-md:hidden` below `md` and add nothing). In rem like the utilities it mirrors; from `md` the class is inert.
  const phoneRightMinWidth = embed
    ? "max-md:min-w-[calc(6.75rem+2px)]" // segment + comments: 110 px
    : session.user.login
      ? "max-md:min-w-[calc(11.75rem+2px)]" // segment + bell + comments + ⋮: 190 px
      : "max-md:min-w-[calc(9.25rem+2px)]"; // segment + comments + ⋮: 150 px
  const phoneActions = embed ? "embed" : session.user.login ? "signed-in" : "anonymous";

  return (
    <header className={cn(HEADER_BOX, "editor-header-layout")} data-testid="header" data-embed={embed || undefined}>
      {compact ? (
        <button type="button" className="icon-btn h-9 w-9 shrink-0 tap-target relative" onClick={props.onOutline} aria-label="Outline" title="Outline" data-testid="outline-button">
          <PanelLeft size={20} />
        </button>
      ) : embed ? (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center md:h-10 md:w-10" aria-label="Markdoc" data-testid="embed-logo">
          <Logo className="h-8 w-8" />
        </span>
      ) : (
        // Below `md` the same 36 px box as the outline button that replaces it after hydration (#1470).
        <Link href="/" className="icon-btn h-9 w-9 shrink-0 md:h-10 md:w-10 tap-target relative" aria-label="Back to documents" title="All documents">
          <Logo className="h-8 w-8" />
        </Link>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-4">
        <TitleEditor session={session} fallback={doc.title} compact={compact} />
        {!embed && !compact && <HeaderStar docId={doc.id} ready={settled} />}
        <SaveIndicator session={session} compact={compact} />
      </div>
      <div className={cn("editor-header-right flex shrink-0 items-center gap-1 md:gap-3", phoneRightMinWidth)} data-testid="header-right" data-phone-actions={phoneActions}>
        <LayoutSegment layout={props.layout} onLayout={props.onLayout} />
        <div className="hidden items-center gap-3 md:flex">
          <ModeSwitcher session={session} />
          <PresenceStack session={session} onJump={props.onJumpToUser} onCancelRequest={props.onCancelRequest} onConnectAgent={openAgentDialog} />
        </div>
        {agentDialogEverOpened && <AgentDialog doc={{ id: doc.id, title: liveTitle }} open={agentDialogOpen} onOpenChange={setAgentDialogOpen} />}
        {!embed && session.user.login && <NotificationsBell currentDocId={doc.id} onOpen={props.onOpenNotification} ready={settled} />}
        {!embed && !compact && (
          <button type="button" className="btn btn-outline max-md:hidden" onClick={props.onShare} data-testid="share-button">
            <UserPlus size={17} />
            Share
          </button>
        )}
        <Tip label={props.commentsOpen ? "Hide comments" : "Show comments"} shortcut={shortcut("Mod-Alt-M")}>
          <button
            type="button"
            className="icon-btn relative tap-target editor-header-action"
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
        {!embed && <Menu open={moreOpen} onOpenChange={onMoreMenuOpenChange}>
          <MenuTrigger asChild>
            <button
              type="button"
              className="icon-btn relative tap-target editor-header-action"
              aria-label="More"
              data-testid="more-menu"
            >
              <MoreVertical size={20} />
            </button>
          </MenuTrigger>
          <MenuContent
            align="end"
            className="w-64"
          >
            {compact && (
              <>
                <MenuItem icon={<UserPlus size={15} />} onSelect={() => props.onShare()} data-testid="menu-share">
                  Share…
                </MenuItem>
                <MenuItem
                  icon={linked ? <UploadCloud size={15} /> : <GitHubIcon size={15} />}
                  onSelect={() => (linked ? props.onPublishNow() : props.onPublish())}
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
            <MenuItem icon={<History size={15} />} onSelect={() => props.onHistory()} data-testid="menu-history">
              Version history
            </MenuItem>
            <MenuItem icon={<Activity size={15} />} onSelect={() => props.onActivity()} data-testid="menu-activity">
              Activity
            </MenuItem>
            {canEdit && (
              <MenuItem icon={<Pencil size={15} />} onSelect={() => props.onNameVersion()}>
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
            <MenuItem icon={<Copy size={15} />} onSelect={() => props.onCopyMarkdown()}>
              Copy Markdown
            </MenuItem>
            <MenuItem
              icon={props.documentMutation === "duplicate" ? <Loader2 size={15} className="animate-spin" /> : <Files size={15} />}
              onSelect={() => props.onDuplicate()}
              disabled={props.documentMutation !== null}
              aria-busy={props.documentMutation === "duplicate" || undefined}
              data-testid="menu-duplicate"
            >
              {props.documentMutation === "duplicate" ? "Making a copy…" : "Make a copy"}
            </MenuItem>
            <MenuItem icon={<BookOpen size={15} />} onSelect={openUrl(`/p/${doc.id}`)} data-testid="menu-reader">
              Open reader view
            </MenuItem>
            <MenuSeparator />
            {linked && doc.githubUrl && (
              <MenuItem icon={<ExternalLink size={15} />} onSelect={openUrl(doc.githubUrl)}>
                Open on GitHub
              </MenuItem>
            )}
            {props.isOwner && (
              <MenuItem
                icon={<GitHubIcon size={15} />}
                onSelect={() => props.onPublish()}
                disabled={!linked && !githubConfigured}
                title={!linked && !githubConfigured ? GITHUB_NOT_CONFIGURED : undefined}
                data-testid="menu-github"
              >
                {linked ? "GitHub connection…" : <GitHubEntryLabel configured={githubConfigured}>Connect to GitHub…</GitHubEntryLabel>}
              </MenuItem>
            )}
            {props.onCommandPalette && (
              <MenuItem icon={<Command size={15} />} onSelect={() => props.onCommandPalette?.()} shortcut={shortcut("Mod-K")} data-testid="menu-command-palette">
                Search commands
              </MenuItem>
            )}
            <MenuItem icon={<Keyboard size={15} />} onSelect={() => props.onShortcuts()}>
              Keyboard shortcuts
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<ArrowLeft size={15} />} onSelect={() => props.onHome()}>
              All documents
            </MenuItem>
            <MenuItem icon={<LogOut size={15} />} onSelect={() => void signOutSafely()}>
              Sign out
            </MenuItem>
            {props.isOwner && (
              <>
                <MenuSeparator />
                <MenuItem
                  icon={props.documentMutation === "delete" ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                  className="text-danger"
                  onSelect={() => props.onDelete()}
                  disabled={props.documentMutation !== null}
                  aria-busy={props.documentMutation === "delete" || undefined}
                  data-testid="menu-delete"
                >
                  {props.documentMutation === "delete" ? "Moving to trash…" : "Move to trash"}
                </MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>}
        {!embed && !compact && <PublishMenu props={props} />}
      </div>
    </header>
  );
});
