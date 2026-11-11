"use client";

import { useLinkStatus } from "next/link";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { EditorChrome } from "@/components/editor/editor-chrome";

/** How a document card tells the boundary around the dashboard that its navigation started or ended. */
const ReportContext = createContext<((pending: boolean) => void) | null>(null);

/**
 * Inside a document card's `<Link>`: reports the link's pending navigation to the `OpeningDocumentBoundary`
 * above it. Renders nothing.
 */
export function OpeningDocument() {
  const { pending } = useLinkStatus();
  const report = useContext(ReportContext);
  // A layout effect, so the boundary's cover is in the same frame as the click's own render.
  useLayoutEffect(() => {
    if (!pending || !report) return;
    report(true);
    return () => report(false);
  }, [pending, report]);
  return null;
}

/**
 * Around the dashboard: from the click on a document card until the document page is ready, the editor's
 * empty chrome covers the dashboard. The page is rendered on the server per request, so without this the
 * dashboard stayed on screen, unchanged, for the whole round trip (0.2 s on a desktop, a second or more on
 * a phone) and then the editor appeared at once. The boxes are the editor's own, so nothing moves when the
 * real page takes over.
 *
 * While the cover is up it is the only thing a person can reach, as with a modal dialog: the dashboard
 * under it is `inert`, the keyboard is on the cover and stays there, and the dashboard's window shortcuts
 * stand down (`pendingRef`). If the navigation ends without leaving the dashboard, the keyboard goes back to where it
 * was. The status line is in the page from the start and outside the inert part, so a screen reader hears
 * its text change.
 */
export function OpeningDocumentBoundary({ pendingRef, children }: { pendingRef: RefObject<boolean>; children: ReactNode }) {
  const [pending, setPending] = useState(false);
  const pendingLinks = useRef(0);
  const cover = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const report = useCallback((started: boolean) => {
    if (started && pendingLinks.current === 0) {
      const active = document.activeElement;
      // A second card taking over from the first finds the keyboard on the cover; the first card's element stays.
      if (active instanceof HTMLElement && active !== document.body && !cover.current?.contains(active)) returnFocus.current = active;
    }
    pendingLinks.current = Math.max(0, pendingLinks.current + (started ? 1 : -1));
    setPending(pendingLinks.current > 0);
  }, []);

  // The dashboard's own window shortcuts (search, command palette) read this and stand down while the cover is up.
  useLayoutEffect(() => {
    pendingRef.current = pending;
    return () => {
      pendingRef.current = false;
    };
  }, [pending, pendingRef]);

  // The dashboard turns inert one paint after the cover. Turning it inert restyles every card, and in the
  // click's own frame that put the cover on screen ≈ 30 ms later on a phone. The keyboard is already on the
  // cover by then (below), so nothing under it can be reached in between.
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    if (!pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => setCovered(true), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      setCovered(false);
    };
  }, [pending]);

  useLayoutEffect(() => {
    if (pending) {
      cover.current?.focus({ preventScroll: true });
      return;
    }
    // Not reached when the document page replaces the dashboard: an unmount runs no effect body.
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, [pending]);

  return (
    <ReportContext.Provider value={report}>
      <p className="sr-only" role="status" aria-live="polite" data-testid="opening-status">
        {pending ? "Opening the document…" : ""}
      </p>
      <div className="contents" inert={pending && covered} data-testid="opening-covered">
        {children}
      </div>
      {pending && (
        <div
          ref={cover}
          tabIndex={-1}
          className="fixed inset-0 z-50 outline-none"
          data-testid="opening-document"
          // Nothing else can take the keyboard, so Tab would leave the page; it stays on the cover instead.
          onKeyDown={(event) => {
            if (event.key === "Tab") event.preventDefault();
          }}
        >
          <EditorChrome decorative aria-hidden />
        </div>
      )}
    </ReportContext.Provider>
  );
}
