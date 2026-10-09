"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from "react";
import { Bot, MessageSquare, X } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { api } from "@/lib/api";
import {
  HINTS,
  HINTS_MIN_WIDTH,
  EMPTY_HINTS_RECORD,
  allHintsDismissed,
  dueHint,
  readHintsRecord,
  withDismissed,
  writeHintsRecord,
  type HintId,
  type HintsRecord,
} from "@/lib/hints";
import { useMediaQuery } from "@/lib/viewport-hooks";
import { shallowEqual, useOpenSettled, useSessionValue } from "./use-session";
import type { EditorActions } from "./actions";

export interface HintBarProps {
  session: CollabSession;
  actions: EditorActions;
  onConnectAgent: () => void;
  /** Hint (b): opens a comment on the whole document with `@` already typed, so the agent picker is up. */
  onComment: () => void;
}

const ICONS: Record<HintId, typeof Bot> = {
  "collab-agent": Bot,
  "mention-copilot": MessageSquare,
};

const noopSubscribe = () => () => {};

/** Quiet retry cadence for the optional collaborator/agent discovery behind hint (a). */
export const COLLAB_HINT_RETRY_MS = 30_000;

interface CollaboratorEvidence {
  collaborators: number;
  agentKnown: boolean;
}

interface DiscoveryKey {
  session: CollabSession;
  documentId: string;
}

interface DiscoverySnapshot {
  authority: DiscoveryAuthority;
  collaborators: CollaboratorEvidence | null;
  tokenUsed: boolean | null;
}

type DiscoverySource = "collaborators" | "tokens";

interface DiscoveryAuthority {
  key: DiscoveryKey;
  collaborators: CollaboratorEvidence | null;
  tokenUsed: boolean | null;
  visible: boolean;
  generation: number;
  retry: DiscoveryRetry | null;
  run: (() => void) | null;
  visibilityListener: (() => void) | null;
  retired: boolean;
}

interface DiscoveryOperation {
  authority: DiscoveryAuthority;
  source: DiscoverySource;
  generation: number;
  operation: number;
}

interface DiscoveryRetry {
  authority: DiscoveryAuthority;
  timer: ReturnType<typeof setTimeout> | null;
}

interface DiscoveryCoordinator {
  authority: DiscoveryAuthority | null;
  collaboratorsOperation: DiscoveryOperation | null;
  tokenOperation: DiscoveryOperation | null;
  nextOperation: number;
}

interface PinnedHint {
  key: DiscoveryKey;
  id: HintId;
}

const HINT_ROOT_CLASS =
  "flex h-9 shrink-0 items-center gap-3 border-b border-line bg-accent-soft px-4 text-[13px] text-ink";
const HINT_ICON_CLASS = "shrink-0 text-accent";
const HINT_TEXT_CLASS = "min-w-0 truncate";
const HINT_ACTION_CLASS =
  "btn btn-sm btn-outline ml-auto h-6 shrink-0 px-2 text-xs";
const HINT_DISMISS_CLASS =
  "icon-btn h-6 w-6 shrink-0 text-ink-3 hover:text-ink";

function PublishedHintBar({
  shown,
  record,
  pinned,
  actions,
  onConnectAgent,
  onComment,
  discovery,
  retireDiscovery,
  setRecord,
  setPinned,
}: {
  shown: HintId;
  record: HintsRecord;
  pinned: PinnedHint;
  actions: EditorActions;
  onConnectAgent: () => void;
  onComment: () => void;
  discovery: DiscoveryAuthority | null;
  retireDiscovery: (authority: DiscoveryAuthority) => void;
  setRecord: Dispatch<SetStateAction<HintsRecord>>;
  setPinned: Dispatch<SetStateAction<PinnedHint | null>>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const copy = HINTS[shown];
  const Icon = ICONS[shown];

  const dismiss = () => {
    const next = withDismissed(record, shown);
    setRecord(next);
    setPinned((value) => (value === pinned ? null : value));
    writeHintsRecord(window.localStorage, next);
    if (discovery) retireDiscovery(discovery);
  };
  const activatePrimary = () => {
    dismiss();
    (shown === "collab-agent" ? onConnectAgent : onComment)();
  };
  const activateDismiss = () => {
    const restoreFocus = !!rootRef.current?.contains(document.activeElement);
    dismiss();
    if (restoreFocus) actions.focus();
  };
  // Keep the editor's focus and selection when the action is pressed with the mouse.
  const preserveActionFocus = (event: ReactMouseEvent<HTMLButtonElement>) => event.preventDefault();
  // Arrow keys, Home and End move between the two buttons.
  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const controls = [actionRef.current, dismissRef.current].filter(
      (el): el is HTMLButtonElement => !!el && !el.disabled,
    );
    const index = controls.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    let target: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        target = index + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        target = index - 1;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = controls.length - 1;
        break;
      default:
        return;
    }
    const destination = controls[target];
    if (!destination || destination === controls[index]) return;
    event.preventDefault();
    destination.focus();
  };

  return (
    <div
      ref={rootRef}
      className={HINT_ROOT_CLASS}
      role="status"
      aria-live="polite"
      data-testid="hint-bar"
      data-hint={shown}
      onKeyDown={keyDown}
    >
      <Icon size={14} className={HINT_ICON_CLASS} aria-hidden />
      <span className={HINT_TEXT_CLASS} title={copy.message}>
        {copy.message}
      </span>
      <button
        ref={actionRef}
        type="button"
        className={HINT_ACTION_CLASS}
        onMouseDown={preserveActionFocus}
        onClick={activatePrimary}
        data-testid="hint-action"
      >
        {copy.action}
      </button>
      <button
        ref={dismissRef}
        type="button"
        className={HINT_DISMISS_CLASS}
        onClick={activateDismiss}
        aria-label="Dismiss hint"
        data-testid="hint-dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}

/**
 * One-line, once-only hints under the toolbar for the agent/collaboration features. Reads session
 * state itself (the shell does not re-render for it) and remembers dismissals in `localStorage`
 * (`markdoc:hints`). A hint that has appeared stays until ✕ or its action; once both are dismissed
 * the bar never mounts again. Never shown on phone widths.
 */
export function HintBar({
  session,
  actions,
  onConnectAgent,
  onComment,
}: HintBarProps) {
  // Storage is read after hydration so the server markup (no bar) matches the first client render.
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const [record, setRecord] = useState<HintsRecord>(EMPTY_HINTS_RECORD);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setRecord(
      readHintsRecord(
        typeof window === "undefined" ? null : window.localStorage,
      ),
    );
    setLoaded(true);
  }, []);
  const wide = useMediaQuery(`(min-width: ${HINTS_MIN_WIDTH}px)`);
  const active =
    hydrated && loaded && wide && !allHintsDismissed(record.dismissed);

  // Everything else comes from the live session; the selector returns small primitives so the bar
  // re-renders only when a gate actually flips, not per keystroke.
  const live = useSessionValue(
    session,
    (s) => {
      if (!active) {
        return {
          people: 0,
          agentHere: false,
          threads: 0,
          role: s.role,
          canEdit: s.canEdit,
          canCreateComment: s.canCreateComment,
        };
      }
      const presence = s.presence();
      return {
        people: presence.filter((p) => !p.isLocal && !p.isAgent).length,
        agentHere: presence.some((p) => p.isAgent),
        threads: s.comments.list().length,
        role: s.role,
        canEdit: s.canEdit,
        canCreateComment: s.canCreateComment,
      };
    },
    shallowEqual,
  );

  // Share-list and token evidence are independent: a failed source stays unknown and is retried
  // without discarding a successful source. The coordinator outlives effect restarts so an older
  // request must settle before the same source can be requested for a replacement document.
  const settled = useOpenSettled(session);
  const documentId = session.docId;
  const discoveryKey = useMemo<DiscoveryKey>(
    () => ({ session, documentId }),
    [session, documentId],
  );
  const [discovery, setDiscovery] = useState<DiscoverySnapshot | null>(null);
  const discoveryCoordinator = useRef<DiscoveryCoordinator>({
    authority: null,
    collaboratorsOperation: null,
    tokenOperation: null,
    nextOperation: 0,
  });
  const needsShareInfo =
    active &&
    settled &&
    !record.dismissed.includes("collab-agent") &&
    !record.agentSeen &&
    !live.agentHere;
  const retireDiscovery = useCallback((authority: DiscoveryAuthority) => {
    if (authority.retired) return;
    authority.retired = true;
    const retry = authority.retry;
    if (retry?.authority === authority) {
      authority.retry = null;
      if (retry.timer !== null) {
        clearTimeout(retry.timer);
        retry.timer = null;
      }
    }
    if (authority.visibilityListener !== null) {
      document.removeEventListener(
        "visibilitychange",
        authority.visibilityListener,
      );
      authority.visibilityListener = null;
    }
    authority.run = null;
    if (discoveryCoordinator.current.authority === authority)
      discoveryCoordinator.current.authority = null;
  }, []);

  useLayoutEffect(() => {
    if (!needsShareInfo) return;
    const coordinator = discoveryCoordinator.current;
    const authority: DiscoveryAuthority = {
      key: discoveryKey,
      collaborators: null,
      tokenUsed: null,
      visible: false,
      generation: 0,
      retry: null,
      run: null,
      visibilityListener: null,
      retired: false,
    };
    if (coordinator.authority) retireDiscovery(coordinator.authority);
    coordinator.authority = authority;
    return () => retireDiscovery(authority);
  }, [discoveryKey, needsShareInfo, retireDiscovery]);

  useEffect(() => {
    if (!needsShareInfo) return;
    const coordinator = discoveryCoordinator.current;
    const authority = coordinator.authority;
    if (!authority || authority.key !== discoveryKey) return;
    const ownsAuthority = () =>
      !authority.retired && coordinator.authority === authority;
    if (!ownsAuthority()) return;
    authority.visible = document.visibilityState === "visible";

    const operationFor = (source: DiscoverySource) =>
      source === "collaborators"
        ? coordinator.collaboratorsOperation
        : coordinator.tokenOperation;
    const setOperation = (
      source: DiscoverySource,
      operation: DiscoveryOperation | null,
    ) => {
      if (source === "collaborators")
        coordinator.collaboratorsOperation = operation;
      else coordinator.tokenOperation = operation;
    };
    const ownsOperation = (operation: DiscoveryOperation) =>
      ownsAuthority() &&
      authority.visible &&
      operation.authority === authority &&
      operation.generation === authority.generation &&
      operationFor(operation.source) === operation;
    const publish = (operation: DiscoveryOperation) => {
      if (!ownsOperation(operation)) return;
      setDiscovery({
        authority,
        collaborators: authority.collaborators,
        tokenUsed: authority.tokenUsed,
      });
    };
    const clearRetry = () => {
      const retry = authority.retry;
      if (retry?.authority !== authority) return;
      authority.retry = null;
      if (retry.timer !== null) {
        clearTimeout(retry.timer);
        retry.timer = null;
      }
    };
    const agentKnown = () =>
      authority.collaborators?.agentKnown === true ||
      authority.tokenUsed === true;
    const scheduleRetry = () => {
      if (
        !ownsAuthority() ||
        !authority.visible ||
        agentKnown() ||
        (authority.collaborators !== null && authority.tokenUsed !== null)
      ) {
        clearRetry();
        return;
      }
      const retryableSource =
        (authority.collaborators === null &&
          coordinator.collaboratorsOperation === null) ||
        (authority.tokenUsed === null && coordinator.tokenOperation === null);
      if (!retryableSource || authority.retry !== null) return;
      const retry: DiscoveryRetry = { authority, timer: null };
      retry.timer = setTimeout(() => {
        if (!ownsAuthority() || authority.retry !== retry) return;
        authority.retry = null;
        retry.timer = null;
        run();
      }, COLLAB_HINT_RETRY_MS);
      authority.retry = retry;
    };
    const releaseOperation = (operation: DiscoveryOperation) => {
      if (
        operation.authority !== authority ||
        operationFor(operation.source) !== operation
      )
        return;
      const currentSettlement = ownsOperation(operation);
      setOperation(operation.source, null);
      if (currentSettlement && ownsAuthority()) scheduleRetry();
      else coordinator.authority?.run?.();
    };
    const requestCollaborators = () => {
      if (
        !ownsAuthority() ||
        !authority.visible ||
        authority.collaborators !== null ||
        coordinator.collaboratorsOperation !== null
      )
        return;
      const operation: DiscoveryOperation = {
        authority,
        source: "collaborators",
        generation: authority.generation,
        operation: ++coordinator.nextOperation,
      };
      coordinator.collaboratorsOperation = operation;
      void api.documents
        .collaborators(authority.key.documentId)
        .then(
        (result) => {
          if (!ownsOperation(operation)) return;
          authority.collaborators = {
            collaborators: result.collaborators.length,
            agentKnown: result.agents.length > 0,
          };
          publish(operation);
        },
        () => {
          if (!ownsOperation(operation)) return;
        },
        )
        .finally(() => releaseOperation(operation));
    };
    const requestTokens = () => {
      if (
        !ownsAuthority() ||
        !authority.visible ||
        authority.tokenUsed !== null ||
        coordinator.tokenOperation !== null
      )
        return;
      const operation: DiscoveryOperation = {
        authority,
        source: "tokens",
        generation: authority.generation,
        operation: ++coordinator.nextOperation,
      };
      coordinator.tokenOperation = operation;
      void api.tokens
        .list()
        .then(
        (result) => {
          if (!ownsOperation(operation)) return;
            authority.tokenUsed = result.tokens.some(
              (token) => !!token.lastUsedAt,
            );
          publish(operation);
        },
        () => {
          if (!ownsOperation(operation)) return;
        },
        )
        .finally(() => releaseOperation(operation));
    };
    const run = () => {
      if (!ownsAuthority() || !authority.visible || agentKnown()) return;
      clearRetry();
      requestCollaborators();
      requestTokens();
    };
    authority.run = run;

    const onVisibilityChange = () => {
      if (!ownsAuthority()) return;
      const nextVisible = document.visibilityState === "visible";
      if (nextVisible === authority.visible) return;
      authority.visible = nextVisible;
      if (!authority.visible) {
        authority.generation++;
        clearRetry();
        return;
      }
      run();
    };
    authority.visibilityListener = onVisibilityChange;
    document.addEventListener("visibilitychange", onVisibilityChange);
    run();
    return () => retireDiscovery(authority);
  }, [discoveryKey, needsShareInfo, retireDiscovery]);

  const currentDiscovery =
    needsShareInfo &&
    discovery?.authority.key === discoveryKey &&
    !discovery.authority.retired
      ? discovery
      : null;
  const discoveredAgent =
    currentDiscovery?.collaborators?.agentKnown === true ||
    currentDiscovery?.tokenUsed === true;

  // Remember that an agent has been seen so hint (a) stays quiet in future documents.
  useEffect(() => {
    const discoveryStillOwnsVisit =
      currentDiscovery !== null &&
      !currentDiscovery.authority.retired &&
      discoveryCoordinator.current.authority === currentDiscovery.authority;
    if (
      !loaded ||
      record.agentSeen ||
      !(live.agentHere || (discoveredAgent && discoveryStillOwnsVisit))
    )
      return;
    const next = { ...record, agentSeen: true };
    setRecord(next);
    writeHintsRecord(window.localStorage, next);
  }, [loaded, live.agentHere, discoveredAgent, currentDiscovery, record]);

  const agentEverConnected =
    record.agentSeen || live.agentHere || discoveredAgent;
  const agentAbsenceKnown =
    currentDiscovery?.collaborators != null &&
    currentDiscovery.tokenUsed !== null &&
    !discoveredAgent;
  const collaborators = agentAbsenceKnown
    ? Math.max(live.people, currentDiscovery.collaborators?.collaborators ?? 0)
    : 0;
  const due = active
    ? dueHint(
        { collaborators, agentEverConnected, commentThreads: live.threads },
        record.dismissed,
      )
    : null;

  // A hint that appeared is pinned until the user acts on it, even if its gate turns false again
  // or another hint becomes due.
  const [pinned, setPinned] = useState<PinnedHint | null>(null);
  useEffect(() => {
    if ((!pinned || pinned.key !== discoveryKey) && due)
      setPinned({ key: discoveryKey, id: due });
  }, [discoveryKey, due, pinned]);
  const shown =
    pinned?.key === discoveryKey &&
    !record.dismissed.includes(pinned.id) &&
    active &&
    (pinned.id !== "mention-copilot" || live.canCreateComment)
      ? pinned.id
      : null;

  if (!shown || !pinned) return null;
  return (
    <PublishedHintBar
      shown={shown}
      record={record}
      pinned={pinned}
      actions={actions}
      onConnectAgent={onConnectAgent}
      onComment={onComment}
      discovery={
        shown === "collab-agent" && currentDiscovery
          ? currentDiscovery.authority
          : null
      }
      retireDiscovery={retireDiscovery}
      setRecord={setRecord}
      setPinned={setPinned}
    />
  );
}
