"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

/**
 * Polls the document's content hash while the tab is visible and offers a refresh when it
 * changed. No WebSocket: a reader does not need live cursors, only to know it is stale.
 */
export function UpdatePill({ docId, initialHash, pollMs }: { docId: string; initialHash: string; pollMs: number }) {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (stale) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch(`/api/documents/${docId}/content`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { contentHash?: string };
        if (!cancelled && data.contentHash && data.contentHash !== initialHash) setStale(true);
      } catch {
        // Offline or transient error: try again on the next tick.
      }
    };
    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => void check(), pollMs);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void check();
        start();
      } else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [docId, initialHash, pollMs, stale]);

  if (!stale) return null;
  return (
    <div className="reader-pill pointer-events-none fixed inset-x-0 top-16 z-20 flex justify-center" role="status" data-testid="reader-updated">
      <button
        type="button"
        className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-line-2 bg-surface px-3.5 py-1.5 text-sm font-medium text-ink shadow-md hover:bg-surface-2"
        onClick={() => window.location.reload()}
      >
        <span className="text-ink-3">Updated</span>
        <span aria-hidden className="text-ink-4">
          —
        </span>
        <RefreshCw size={14} className="text-accent" />
        Refresh
      </button>
    </div>
  );
}
