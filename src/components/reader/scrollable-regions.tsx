"use client";

import { useLayoutEffect } from "react";

const ROOT_SELECTOR = "[data-reader-overflow-root]";
const REGION_SELECTOR = "pre, table";

/** Adds a keyboard entry point only while a reader code block or table overflows horizontally. */
export function ReaderScrollableRegions({ contentKey }: { contentKey: string }) {
  useLayoutEffect(() => {
    const root = document.querySelector<HTMLElement>(ROOT_SELECTOR);
    if (!root) return;

    const regions = Array.from(root.querySelectorAll<HTMLElement>(REGION_SELECTOR));
    const sync = () => {
      for (const region of regions) {
        if (region.scrollWidth > region.clientWidth + 1) region.tabIndex = 0;
        else region.removeAttribute("tabindex");
      }
    };

    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(root);
    regions.forEach((region) => observer.observe(region));

    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) sync();
    });

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [contentKey]);

  return null;
}
