"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { RefreshCw, X } from "lucide-react";

const PILL_CLASS_NAME =
  "reader-pill pointer-events-none fixed inset-x-0 top-16 z-20 flex justify-center gap-1";
const BUTTON_CLASS_NAME =
  "pointer-events-auto inline-flex items-center gap-2 rounded-full border border-line-2 bg-surface px-3.5 py-1.5 text-sm font-medium text-ink shadow-md hover:bg-surface-2";
const DISMISS_BUTTON_CLASS_NAME =
  "pointer-events-auto inline-flex size-8 items-center justify-center rounded-full border border-line-2 bg-surface text-ink-3 shadow-md hover:bg-surface-2 hover:text-ink";
const UPDATED_CLASS_NAME = "text-ink-3";
const SEPARATOR_CLASS_NAME = "text-ink-4";
const ICON_CLASS_NAME = "text-accent";
const DISMISS_LABEL = "Dismiss update notice";
const FAILURE_MESSAGE = "Couldn't check for updates.";
const RETRY_TEXT = "Retry now";
const FAILURE_NOTICE_CLASS_NAME =
  "pointer-events-auto inline-flex items-center gap-2 rounded-full border border-line-2 bg-surface px-3.5 py-1.5 text-sm font-medium text-ink shadow-md";
const RETRY_BUTTON_CLASS_NAME =
  "rounded-full text-accent hover:opacity-80 disabled:cursor-wait disabled:opacity-60";

type Status =
  | { kind: "idle" }
  | { kind: "updated"; remoteHash: string }
  | { kind: "failed"; retrying: boolean };

const IDLE: Status = { kind: "idle" };

/**
 * Polls the document's content hash while the tab is visible and offers a refresh when it
 * changed. No WebSocket: a reader does not need live cursors, only to know it is stale.
 */
export function UpdatePill({
  docId,
  initialHash,
  pollMs,
}: {
  docId: string;
  initialHash: string;
  pollMs: number;
}) {
  const [status, setStatus] = useState<Status>(IDLE);
  const [visit, setVisit] = useState({ docId, initialHash });
  // Both are tagged with the document they belong to so a replacement document never inherits them.
  const dismissedRef = useRef<{ docId: string; hash: string } | null>(null);
  const resumeWithoutCheckRef = useRef<string | null>(null);
  const retryRef = useRef<(() => void) | null>(null);
  const reloadingRef = useRef(false);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);

  // A different document starts from a clean slate.
  if (visit.docId !== docId || visit.initialHash !== initialHash) {
    setVisit({ docId, initialHash });
    setStatus(IDLE);
  }

  const updated = status.kind === "updated";

  useEffect(() => {
    if (updated) return;
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let controller: AbortController | null = null;

    const fail = () => setStatus({ kind: "failed", retrying: false });

    const check = async () => {
      if (disposed || controller || document.visibilityState !== "visible") return;
      const current = new AbortController();
      controller = current;
      setStatus((s) => (s.kind === "failed" ? { kind: "failed", retrying: true } : s));
      try {
        const res = await fetch(`/api/documents/${docId}/content`, {
          cache: "no-store",
          signal: current.signal,
        });
        if (current.signal.aborted) return;
        if (!res.ok) return fail();
        const data = (await res.json()) as { contentHash?: unknown };
        if (current.signal.aborted) return;
        const remoteHash = data.contentHash;
        if (typeof remoteHash !== "string" || remoteHash.length === 0) return fail();
        if (remoteHash === initialHash) {
          dismissedRef.current = null;
          setStatus(IDLE);
        } else if (dismissedRef.current?.docId === docId && remoteHash === dismissedRef.current.hash) {
          setStatus(IDLE);
        } else {
          setStatus({ kind: "updated", remoteHash });
        }
      } catch {
        if (!current.signal.aborted) fail();
      } finally {
        if (controller === current) controller = null;
      }
    };

    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      controller?.abort();
      controller = null;
      setStatus((s) => (s.kind === "failed" && s.retrying ? { kind: "failed", retrying: false } : s));
    };
    const start = (checkNow: boolean) => {
      if (document.visibilityState !== "visible") return;
      if (checkNow) void check();
      timer ??= setInterval(() => void check(), pollMs);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") start(true);
      else stop();
    };

    retryRef.current = () => void check();
    start(resumeWithoutCheckRef.current !== docId);
    resumeWithoutCheckRef.current = null;
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      retryRef.current = null;
      if (timer !== null) clearInterval(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [docId, initialHash, pollMs, updated]);

  if (status.kind === "failed") {
    return (
      <div className={PILL_CLASS_NAME} role="status" data-testid="reader-update-error">
        <div className={FAILURE_NOTICE_CLASS_NAME}>
          <span>{FAILURE_MESSAGE}</span>
          <button
            type="button"
            className={RETRY_BUTTON_CLASS_NAME}
            disabled={status.retrying}
            onClick={() => retryRef.current?.()}
          >
            {RETRY_TEXT}
          </button>
        </div>
      </div>
    );
  }

  if (status.kind !== "updated") return null;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const buttons = [refreshRef.current, dismissRef.current];
    const index = buttons.indexOf(event.currentTarget);
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index < 1 ? index + 1 : -1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index > 0 ? index - 1 : -1;
    else if (event.key === "Home") next = index === 0 ? -1 : 0;
    else if (event.key === "End") next = index === 1 ? -1 : 1;
    const destination = next >= 0 ? buttons[next] : null;
    if (!destination) return;
    event.preventDefault();
    destination.focus();
  };

  return (
    <div className={PILL_CLASS_NAME} role="status" data-testid="reader-updated">
      <button
        ref={refreshRef}
        type="button"
        className={BUTTON_CLASS_NAME}
        onClick={() => {
          if (reloadingRef.current) return;
          reloadingRef.current = true;
          window.location.reload();
        }}
        onKeyDown={onKeyDown}
      >
        <span className={UPDATED_CLASS_NAME}>Updated</span>
        <span aria-hidden className={SEPARATOR_CLASS_NAME}>
          —
        </span>
        <RefreshCw size={14} className={ICON_CLASS_NAME} />
        Refresh
      </button>
      <button
        ref={dismissRef}
        type="button"
        className={DISMISS_BUTTON_CLASS_NAME}
        aria-label={DISMISS_LABEL}
        onClick={() => {
          dismissedRef.current = { docId, hash: status.remoteHash };
          resumeWithoutCheckRef.current = docId;
          setStatus(IDLE);
        }}
        onKeyDown={onKeyDown}
      >
        <X size={14} />
      </button>
    </div>
  );
}
