"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Bot, MessageSquare, Sparkles, X } from "lucide-react";
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
import { shallowEqual, useSessionValue } from "./use-session";
import type { EditorActions } from "./actions";

export interface HintBarProps {
  session: CollabSession;
  actions: EditorActions;
  onShare: () => void;
  onAskAgent: () => void;
  onComment: () => void;
}

const ICONS: Record<HintId, typeof Bot> = { "collab-agent": Bot, "ask-agent": Sparkles, "mention-copilot": MessageSquare };

const noopSubscribe = () => () => {};

/**
 * One-line, once-only hints under the toolbar for the three agent/collaboration features. Reads
 * session state itself (the shell does not re-render for it) and remembers dismissals in
 * `localStorage` (`markdoc:hints`). A hint that has appeared stays until ✕ or its action; once all
 * three are dismissed the bar never mounts again. Never shown on phone widths.
 */
export function HintBar({ session, actions, onShare, onAskAgent, onComment }: HintBarProps) {
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

  // Share list and token usage: fetched once per document, only while the hint that needs them is still open.
  const [shared, setShared] = useState<{ collaborators: number; agentUsed: boolean } | null>(null);
  const needsShareInfo = active && !record.dismissed.includes("collab-agent") && !record.agentSeen;
  useEffect(() => {
    if (!needsShareInfo || shared) return;
    let cancelled = false;
    Promise.all([
      api.documents
        .collaborators(session.docId)
        .then((r) => ({ collaborators: r.collaborators.length, agentPresent: r.agents.some((a) => a.present) }))
        .catch(() => ({ collaborators: 0, agentPresent: false })),
      api.tokens.list().then((r) => r.tokens.some((t) => !!t.lastUsedAt)).catch(() => false),
    ]).then(([share, tokenUsed]) => {
      if (!cancelled) setShared({ collaborators: share.collaborators, agentUsed: tokenUsed || share.agentPresent });
    });
    return () => {
      cancelled = true;
    };
  }, [needsShareInfo, shared, session.docId]);

  // Everything else comes from the live session; the selector returns small primitives so the bar
  // re-renders only when a gate actually flips, not per keystroke.
  const live = useSessionValue(
    session,
    (s) => {
      if (!active) return { people: 0, agentHere: false, selection: 0, threads: 0 };
      const presence = s.presence();
      return {
        people: presence.filter((p) => !p.isLocal && !p.isAgent).length,
        agentHere: presence.some((p) => p.isAgent),
        selection: (() => {
          const r = actions.selectionSourceRange();
          return r ? r.to - r.from : 0;
        })(),
        threads: s.comments.list().length,
      };
    },
    shallowEqual,
  );

  // Remember that an agent has been seen so hint (a) stays quiet in future documents.
  useEffect(() => {
    if (!loaded || record.agentSeen || !(live.agentHere || shared?.agentUsed)) return;
    const next = { ...record, agentSeen: true };
    setRecord(next);
    writeHintsRecord(window.localStorage, next);
  }, [loaded, live.agentHere, shared?.agentUsed, record]);

  const agentEverConnected = record.agentSeen || live.agentHere || (shared?.agentUsed ?? false);
  const due = active
    ? dueHint(
        { collaborators: Math.max(live.people, shared?.collaborators ?? 0), agentEverConnected, selectionLength: live.selection, commentThreads: live.threads },
        record.dismissed,
      )
    : null;

  // A hint that appeared is pinned until the user acts on it, even if its gate turns false again
  // (the selection collapses when the button takes focus) or another hint becomes due.
  const [pinned, setPinned] = useState<HintId | null>(null);
  useEffect(() => {
    if (!pinned && due) setPinned(due);
  }, [due, pinned]);
  const shown = pinned && !record.dismissed.includes(pinned) && active ? pinned : null;

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
      else if (id === "ask-agent") onAskAgent();
      else onComment();
    },
    [dismiss, onShare, onAskAgent, onComment],
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
