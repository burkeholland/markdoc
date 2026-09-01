"use client";

import { useEffect, useRef } from "react";
import type { SyncStatusDto } from "@/lib/api";
import { pollDocumentSync } from "./editor-shell";

const DEFAULT_POLL_MS = 60_000;
const ERROR_RETRY_MS = 60_000;

/**
 * Polls the three-way sync status of a GitHub-backed document: the first tick runs at once (`fresh`
 * when `refreshKey > 0`, i.e. right after a publish or pull), the next after the `pollMs` the server
 * suggests (60 s by default, 60 s after an error). While the tab is hidden no request is made — a due
 * tick waits; coming back to the tab (`visibilitychange`, or `pageshow` from the back/forward cache)
 * polls at once and the cadence restarts from there. When `enabled` is false nothing is polled and the
 * status is reset to `null`.
 */
export function useSyncPolling({
  documentId,
  enabled,
  refreshKey,
  onStatus,
}: {
  documentId: string;
  enabled: boolean;
  refreshKey: number;
  onStatus: (status: SyncStatusDto | null) => void;
}) {
  // A ref keeps the effect's dependencies to the three inputs, so an inline `onStatus` cannot restart the poll.
  const onStatusRef = useRef(onStatus);
  useEffect(() => {
    onStatusRef.current = onStatus;
  });
  useEffect(() => {
    if (!enabled) {
      onStatusRef.current(null);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const schedule = (ms: number) => {
      clear();
      timer = setTimeout(() => void tick(false), ms);
    };
    const tick = async (fresh: boolean) => {
      // Hidden: skip the request and leave the timer unset; `wake` runs the tick when the tab is shown again.
      if (cancelled || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const s = await pollDocumentSync(documentId, fresh);
        if (cancelled) return;
        onStatusRef.current(s);
        schedule(s.pollMs ?? DEFAULT_POLL_MS);
      } catch {
        if (!cancelled) schedule(ERROR_RETRY_MS);
      } finally {
        inFlight = false;
      }
    };
    const wake = () => {
      if (document.visibilityState === "hidden") return;
      clear();
      void tick(false);
    };
    // The initial page load fires pageshow too; the mount tick already covers it, so only a restore counts.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) wake();
    };
    void tick(refreshKey > 0);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      cancelled = true;
      clear();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [documentId, enabled, refreshKey]);
}
