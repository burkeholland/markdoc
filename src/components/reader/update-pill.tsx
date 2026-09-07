"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

type DocumentAuthority = {
  mount: symbol;
  docId: string;
  initialHash: string;
};

type RefreshPublication = {
  document: DocumentAuthority;
};

type PollingAuthority = {
  document: DocumentAuthority;
  pollMs: number;
};

type PollingOwner = {
  authority: PollingAuthority;
  retire: () => void;
};

type RequestOwner = {
  authority: PollingAuthority;
  controller: AbortController;
};

/**
 * Polls the document's content hash while the tab is visible and offers a refresh when it
 * changed. No WebSocket: a reader does not need live cursors, only to know it is stale.
 */
export function UpdatePill({ docId, initialHash, pollMs }: { docId: string; initialHash: string; pollMs: number }) {
  const [mount] = useState(() => Symbol("reader-update-pill"));
  const documentAuthority = useMemo<DocumentAuthority>(() => ({ mount, docId, initialHash }), [mount, docId, initialHash]);
  const authority = useMemo<PollingAuthority>(() => ({ document: documentAuthority, pollMs }), [documentAuthority, pollMs]);
  const documentAuthorityRef = useRef<DocumentAuthority | null>(null);
  const authorityRef = useRef<PollingAuthority | null>(null);
  const pollingOwnerRef = useRef<PollingOwner | null>(null);
  const requestOwnerRef = useRef<RequestOwner | null>(null);
  const refreshPublicationRef = useRef<RefreshPublication | null>(null);
  const [refreshPublication, setRefreshPublication] = useState<RefreshPublication | null>(null);

  useLayoutEffect(() => {
    documentAuthorityRef.current = documentAuthority;

    return () => {
      if (documentAuthorityRef.current === documentAuthority) documentAuthorityRef.current = null;
      if (refreshPublicationRef.current?.document === documentAuthority) refreshPublicationRef.current = null;
    };
  }, [documentAuthority]);

  useLayoutEffect(() => {
    authorityRef.current = authority;

    return () => {
      if (authorityRef.current === authority) authorityRef.current = null;

      const request = requestOwnerRef.current;
      if (request?.authority === authority) {
        requestOwnerRef.current = null;
        request.controller.abort();
      }
      const polling = pollingOwnerRef.current;
      if (polling?.authority === authority) polling.retire();
    };
  }, [authority]);

  useEffect(() => {
    const hasAuthority = () => authorityRef.current === authority;
    if (!hasAuthority() || refreshPublication?.document === authority.document) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    let retired = false;
    let changed = false;
    const stopTimer = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    const stopRequest = () => {
      const request = requestOwnerRef.current;
      if (request?.authority !== authority) return;
      requestOwnerRef.current = null;
      request.controller.abort();
    };
    const stop = () => {
      stopTimer();
      stopRequest();
    };
    const check = async () => {
      if (retired || changed || !hasAuthority() || requestOwnerRef.current !== null || document.visibilityState !== "visible") return;
      const request: RequestOwner = { authority, controller: new AbortController() };
      requestOwnerRef.current = request;
      const ownsRequest = () =>
        !retired &&
        hasAuthority() &&
        requestOwnerRef.current === request &&
        !request.controller.signal.aborted;

      try {
        const res = await fetch(`/api/documents/${authority.document.docId}/content`, {
          cache: "no-store",
          signal: request.controller.signal,
        });
        if (!ownsRequest() || !res.ok) return;
        const data = (await res.json()) as { contentHash?: string };
        if (!ownsRequest() || document.visibilityState !== "visible") return;
        if (data.contentHash && data.contentHash !== authority.document.initialHash) {
          changed = true;
          stopTimer();
          const publication: RefreshPublication = { document: authority.document };
          refreshPublicationRef.current = publication;
          setRefreshPublication(publication);
        }
      } catch {
        // Offline or transient error: try again on the next tick.
      } finally {
        if (!retired && hasAuthority() && requestOwnerRef.current === request) requestOwnerRef.current = null;
      }
    };
    const start = () => {
      if (retired || changed || !hasAuthority() || document.visibilityState !== "visible") return;
      void check();
      if (timer !== null) return;
      timer = setInterval(() => void check(), authority.pollMs);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        start();
      } else stop();
    };
    const retire = () => {
      if (retired) return;
      retired = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      if (pollingOwnerRef.current === polling) pollingOwnerRef.current = null;
    };
    const polling: PollingOwner = { authority, retire };

    pollingOwnerRef.current = polling;
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return retire;
  }, [authority, refreshPublication]);

  const currentPublication = refreshPublication?.document === documentAuthority ? refreshPublication : null;
  if (!currentPublication) return null;
  return (
    <div className="reader-pill pointer-events-none fixed inset-x-0 top-16 z-20 flex justify-center" role="status" data-testid="reader-updated">
      <button
        type="button"
        className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-line-2 bg-surface px-3.5 py-1.5 text-sm font-medium text-ink shadow-md hover:bg-surface-2"
        onClick={() => {
          if (
            documentAuthorityRef.current !== currentPublication.document ||
            authorityRef.current?.document !== currentPublication.document ||
            refreshPublicationRef.current !== currentPublication
          )
            return;
          refreshPublicationRef.current = null;
          window.location.reload();
        }}
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
