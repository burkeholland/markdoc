"use client";

import { useLayoutEffect, useMemo, useRef } from "react";

const REGION_SELECTOR = "pre, table";

type ContentAuthority = {
  html: string;
};

/** Renders the reader body and adds a keyboard entry point only to its overflowing regions. */
export function ReaderScrollableRegions({ html, hideFirstH1 }: { html: string; hideFirstH1: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const authority = useMemo<ContentAuthority>(() => ({ html }), [html]);
  const authorityRef = useRef<ContentAuthority | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    authorityRef.current = authority;
    const regions = Array.from(root.querySelectorAll<HTMLElement>(REGION_SELECTOR));
    const originalTabIndexes = new Map(regions.map((region) => [region, region.getAttribute("tabindex")]));
    let retired = false;
    const isCurrent = () => !retired && authorityRef.current === authority && rootRef.current === root;
    const sync = () => {
      if (!isCurrent()) return;
      for (const region of regions) {
        if (!isCurrent()) return;
        if (region.scrollWidth > region.clientWidth + 1) region.tabIndex = 0;
        else region.removeAttribute("tabindex");
      }
    };

    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(root);
    regions.forEach((region) => observer.observe(region));

    void document.fonts.ready.then(sync);

    return () => {
      retired = true;
      if (authorityRef.current === authority) authorityRef.current = null;
      observer.disconnect();
      for (const [region, tabIndex] of originalTabIndexes) {
        if (tabIndex === null) region.removeAttribute("tabindex");
        else region.setAttribute("tabindex", tabIndex);
      }
    };
  }, [authority]);

  return (
    <div
      ref={rootRef}
      className="reader-body"
      data-testid="reader-body"
      data-hide-first-h1={hideFirstH1 || undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
