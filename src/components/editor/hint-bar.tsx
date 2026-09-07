"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
  onShare: () => void;
  /** Hint (b): opens a comment on the whole document with `@` already typed, so the agent picker is up. */
  onComment: () => void;
}

const ICONS: Record<HintId, typeof Bot> = { "collab-agent": Bot, "mention-copilot": MessageSquare };

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
  key: DiscoveryKey;
  collaborators: CollaboratorEvidence | null;
  tokenUsed: boolean | null;
}

interface DiscoveryCoordinator {
  key: DiscoveryKey | null;
  collaborators: CollaboratorEvidence | null;
  tokenUsed: boolean | null;
  collaboratorsInFlight: boolean;
  tokenInFlight: boolean;
  run: (() => void) | null;
}

/**
 * One-line, once-only hints under the toolbar for the agent/collaboration features. Reads session
 * state itself (the shell does not re-render for it) and remembers dismissals in `localStorage`
 * (`markdoc:hints`). A hint that has appeared stays until ✕ or its action; once both are dismissed
 * the bar never mounts again. Never shown on phone widths.
 */
export function HintBar({ session, actions, onShare, onComment }: HintBarProps) {
  // Storage is read after hydration so the server markup (no bar) matches the first client render.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [record, setRecord] = useState<HintsRecord>(EMPTY_HINTS_RECORD);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setRecord(readHintsRecord(typeof window === "undefined" ? null : window.localStorage));
    setLoaded(true);
  }, []);
  const wide = useMediaQuery(`(min-width: ${HINTS_MIN_WIDTH}px)`);
  const active = hydrated && loaded && wide && !allHintsDismissed(record.dismissed);

  // Everything else comes from the live session; the selector returns small primitives so the bar
  // re-renders only when a gate actually flips, not per keystroke.
  const live = useSessionValue(
    session,
    (s) => {
      if (!active) return { people: 0, agentHere: false, threads: 0 };
      const presence = s.presence();
      return {
        people: presence.filter((p) => !p.isLocal && !p.isAgent).length,
        agentHere: presence.some((p) => p.isAgent),
        threads: s.comments.list().length,
      };
    },
    shallowEqual,
  );

  // Share-list and token evidence are independent: a failed source stays unknown and is retried
  // without discarding a successful source. The coordinator outlives effect restarts so an older
  // request must settle before the same source can be requested for a replacement document.
  const settled = useOpenSettled(session);
  const documentId = session.docId;
  const discoveryKey = useMemo<DiscoveryKey>(() => ({ session, documentId }), [session, documentId]);
  const [discovery, setDiscovery] = useState<DiscoverySnapshot | null>(null);
  const discoveryCoordinator = useRef<DiscoveryCoordinator>({
    key: null,
    collaborators: null,
    tokenUsed: null,
    collaboratorsInFlight: false,
    tokenInFlight: false,
    run: null,
  });
  const needsShareInfo = active && settled && !record.dismissed.includes("collab-agent") && !record.agentSeen && !live.agentHere;
  useEffect(() => {
    const coordinator = discoveryCoordinator.current;
    if (coordinator.key !== discoveryKey) {
      coordinator.key = discoveryKey;
      coordinator.collaborators = null;
      coordinator.tokenUsed = null;
      setDiscovery({ key: discoveryKey, collaborators: null, tokenUsed: null });
    }
    if (!needsShareInfo) return;

    let running = true;
    let visible = document.visibilityState === "visible";
    let generation = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const publish = () => {
      setDiscovery({
        key: discoveryKey,
        collaborators: coordinator.collaborators,
        tokenUsed: coordinator.tokenUsed,
      });
    };
    const clearRetry = () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
    };
    const ownsCurrentRun = (requestGeneration: number) =>
      running &&
      visible &&
      requestGeneration === generation &&
      coordinator.key === discoveryKey &&
      coordinator.run === run;
    const agentKnown = () => coordinator.collaborators?.agentKnown === true || coordinator.tokenUsed === true;
    const scheduleRetry = () => {
      if (
        !running ||
        !visible ||
        coordinator.key !== discoveryKey ||
        agentKnown() ||
        (coordinator.collaborators !== null && coordinator.tokenUsed !== null)
      ) {
        clearRetry();
        return;
      }
      const retryableSource =
        (coordinator.collaborators === null && !coordinator.collaboratorsInFlight) ||
        (coordinator.tokenUsed === null && !coordinator.tokenInFlight);
      if (!retryableSource || retryTimer !== null) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        run();
      }, COLLAB_HINT_RETRY_MS);
    };
    const afterSettlement = () => {
      scheduleRetry();
    };
    const finishStaleRequest = () => {
      coordinator.run?.();
    };
    const requestCollaborators = () => {
      const requestGeneration = generation;
      coordinator.collaboratorsInFlight = true;
      void api.documents.collaborators(documentId).then(
        (result) => {
          coordinator.collaboratorsInFlight = false;
          if (!ownsCurrentRun(requestGeneration)) {
            finishStaleRequest();
            return;
          }
          coordinator.collaborators = {
            collaborators: result.collaborators.length,
            agentKnown: result.agents.length > 0,
          };
          publish();
          afterSettlement();
        },
        () => {
          coordinator.collaboratorsInFlight = false;
          if (!ownsCurrentRun(requestGeneration)) {
            finishStaleRequest();
            return;
          }
          afterSettlement();
        },
      );
    };
    const requestTokens = () => {
      const requestGeneration = generation;
      coordinator.tokenInFlight = true;
      void api.tokens.list().then(
        (result) => {
          coordinator.tokenInFlight = false;
          if (!ownsCurrentRun(requestGeneration)) {
            finishStaleRequest();
            return;
          }
          coordinator.tokenUsed = result.tokens.some((token) => !!token.lastUsedAt);
          publish();
          afterSettlement();
        },
        () => {
          coordinator.tokenInFlight = false;
          if (!ownsCurrentRun(requestGeneration)) {
            finishStaleRequest();
            return;
          }
          afterSettlement();
        },
      );
    };
    function run() {
      if (!running || !visible || coordinator.key !== discoveryKey || agentKnown()) return;
      clearRetry();
      if (coordinator.collaborators === null && !coordinator.collaboratorsInFlight) requestCollaborators();
      if (coordinator.tokenUsed === null && !coordinator.tokenInFlight) requestTokens();
    }
    coordinator.run = run;

    const onVisibilityChange = () => {
      const nextVisible = document.visibilityState === "visible";
      if (nextVisible === visible) return;
      visible = nextVisible;
      if (!visible) {
        generation++;
        clearRetry();
        return;
      }
      run();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    run();
    return () => {
      running = false;
      generation++;
      clearRetry();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (coordinator.run === run) coordinator.run = null;
    };
  }, [discoveryKey, documentId, needsShareInfo]);

  const currentDiscovery = discovery?.key === discoveryKey ? discovery : null;
  const discoveredAgent = currentDiscovery?.collaborators?.agentKnown === true || currentDiscovery?.tokenUsed === true;

  // Remember that an agent has been seen so hint (a) stays quiet in future documents.
  useEffect(() => {
    if (!loaded || record.agentSeen || !(live.agentHere || discoveredAgent)) return;
    const next = { ...record, agentSeen: true };
    setRecord(next);
    writeHintsRecord(window.localStorage, next);
  }, [loaded, live.agentHere, discoveredAgent, record]);

  const agentEverConnected = record.agentSeen || live.agentHere || discoveredAgent;
  const agentAbsenceKnown =
    currentDiscovery?.collaborators != null &&
    currentDiscovery.tokenUsed !== null &&
    !discoveredAgent;
  const collaborators = agentAbsenceKnown
    ? Math.max(live.people, currentDiscovery.collaborators?.collaborators ?? 0)
    : 0;
  const due = active
    ? dueHint({ collaborators, agentEverConnected, commentThreads: live.threads }, record.dismissed)
    : null;

  // A hint that appeared is pinned until the user acts on it, even if its gate turns false again
  // or another hint becomes due.
  const [pinned, setPinned] = useState<{ key: DiscoveryKey; id: HintId } | null>(null);
  useEffect(() => {
    if ((!pinned || pinned.key !== discoveryKey) && due) setPinned({ key: discoveryKey, id: due });
  }, [discoveryKey, due, pinned]);
  const shown = pinned?.key === discoveryKey && !record.dismissed.includes(pinned.id) && active ? pinned.id : null;

  const barRef = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(
    (id: HintId, restoreFocus: boolean) => {
      const next = withDismissed(record, id);
      setRecord(next);
      writeHintsRecord(window.localStorage, next);
      setPinned(null);
      if (restoreFocus && barRef.current?.contains(document.activeElement)) actions.focus();
    },
    [record, actions],
  );
  const act = useCallback(
    (id: HintId) => {
      dismiss(id, false);
      if (id === "collab-agent") onShare();
      else onComment();
    },
    [dismiss, onShare, onComment],
  );

  if (!shown) return null;
  const copy = HINTS[shown];
  const Icon = ICONS[shown];
  return (
    <div
      ref={barRef}
      className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-accent-soft px-4 text-[13px] text-ink"
      role="status"
      aria-live="polite"
      data-testid="hint-bar"
      data-hint={shown}
    >
      <Icon size={14} className="shrink-0 text-accent" aria-hidden />
      <span className="min-w-0 truncate">{copy.message}</span>
      <button type="button" className="btn btn-sm btn-outline ml-auto h-6 shrink-0 px-2 text-xs" onMouseDown={(e) => e.preventDefault()} onClick={() => act(shown)} data-testid="hint-action">
        {copy.action}
      </button>
      <button type="button" className="icon-btn h-6 w-6 shrink-0 text-ink-3 hover:text-ink" onClick={() => dismiss(shown, true)} aria-label="Dismiss hint" data-testid="hint-dismiss">
        <X size={14} />
      </button>
    </div>
  );
}
