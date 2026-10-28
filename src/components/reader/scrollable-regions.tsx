"use client";

import { useLayoutEffect, useRef } from "react";

const ROOT_SELECTOR = "[data-reader-overflow-root]";
const REGION_SELECTOR = "pre, table";

/** Adds a keyboard entry point only while the preceding reader body's regions overflow. */
export function ReaderScrollableRegions({ contentKey }: { contentKey: string }) {
  const markerRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const root = markerRef.current?.previousElementSibling;
    if (!(root instanceof HTMLElement) || !root.matches(ROOT_SELECTOR)) return;
    const regions = Array.from(root.querySelectorAll<HTMLElement>(REGION_SELECTOR));
    const initial = new Map(regions.map((el) => [el, el.getAttribute("tabindex")]));
    let disposed = false;

    const sync = () => {
      if (disposed) return;
      for (const el of regions) {
        const original = initial.get(el) ?? null;
        const next = el.scrollWidth > el.clientWidth + 1 ? "0" : original;
        if (el.getAttribute("tabindex") === next) continue;
        if (next === null) el.removeAttribute("tabindex");
        else el.setAttribute("tabindex", next);
      }
    };

    sync();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(sync) : null;
    observer?.observe(root);
    for (const el of regions) observer?.observe(el);
    void document.fonts?.ready.then(sync);

    return () => {
      disposed = true;
      observer?.disconnect();
      for (const el of regions) {
        if (!el.isConnected) continue;
        const original = initial.get(el) ?? null;
        if (original === null) el.removeAttribute("tabindex");
        else el.setAttribute("tabindex", original);
      }
    };
  }, [contentKey]);

  return <span ref={markerRef} data-reader-overflow-marker hidden aria-hidden="true" />;
}
