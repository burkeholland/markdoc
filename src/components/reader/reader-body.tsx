"use client";

import { useEffect, useRef, useState } from "react";
import { takeReaderBody } from "./reader-body-handoff";

const RELOAD_GUARD = "markdoc:reader-body-reload";

/**
 * The article body. Its HTML reaches the server render through {@link takeReaderBody}, not
 * through props, so it is not repeated in the RSC payload (#2418). The browser render has no
 * HTML and keeps what the server sent (`suppressHydrationWarning`; React leaves a hydrated
 * `dangerouslySetInnerHTML` alone and later renders pass the same empty string).
 */
export function ReaderBody({ bodyKey, empty, hideFirstH1 }: { bodyKey: string; empty: boolean; hideFirstH1: boolean }) {
  const [html] = useState(() => takeReaderBody(bodyKey) ?? "");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A client-side navigation renders without a server render, so there is no body to keep:
    // load the page for real, once (a guard stops a loop should the body still be missing).
    if (empty || html || ref.current?.hasChildNodes()) return;
    const last = Number(sessionStorage.getItem(RELOAD_GUARD) ?? 0);
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem(RELOAD_GUARD, String(Date.now()));
    window.location.reload();
  }, [empty, html]);

  return (
    /* Safe to inject: the HTML is the output of renderMarkdownBody, which runs rehype-sanitize
       (GitHub's default schema) before slugging/highlighting, so scripts, handlers and
       javascript: URLs never reach this point. */
    <div
      ref={ref}
      className="reader-body"
      data-testid="reader-body"
      data-reader-overflow-root
      data-hide-first-h1={hideFirstH1 || undefined}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
