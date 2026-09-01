"use client";

import { useEffect } from "react";

/**
 * Marks `html[data-hydrated]` once React has committed the root tree. Rendered once from the root
 * layout; the e2e suite waits on the attribute (`waitForHydration` in e2e/helpers.ts) before it
 * clicks, because a click on server markup is dropped, and the boot script's `data-theme` is written
 * before React runs so it says nothing about interactivity. Renders nothing; the attribute is never
 * removed, readers check it after the tree has settled.
 */
export function HydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "";
  }, []);
  return null;
}
