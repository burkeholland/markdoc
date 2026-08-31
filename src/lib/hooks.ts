"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { COPY_FALLBACK_HINT, copyText, selectContents } from "@/lib/clipboard";

const noopSubscribe = () => () => {};

export type CopyStatus = "idle" | "copied" | "fallback";

/**
 * State for a Copy button. `copy()` must be called straight from the click handler (it calls
 * `copyText` synchronously so the fallback keeps the gesture). On success the status is `copied`
 * for 1.5 s; when both copy paths fail it is `fallback` for 2 s and, when `target` is given, that
 * element's text is selected so the user finishes with Ctrl+C. `label` is what the button should read.
 */
export function useCopy(text: string, target?: RefObject<HTMLElement | null>, idleLabel = "Copy") {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = () => {
    void copyText(text).then((ok) => {
      if (!ok) selectContents(target?.current ?? null);
      setStatus(ok ? "copied" : "fallback");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setStatus("idle"), ok ? 1500 : 2000);
    });
  };
  const label = status === "copied" ? "Copied" : status === "fallback" ? COPY_FALLBACK_HINT : idleLabel;
  return { status, copy, label, copied: status === "copied" };
}

/**
 * `false` on the server and during hydration, `true` once the component has been hydrated.
 * Use it to keep the first client render identical to the server markup when a value is only
 * known on the client (clock, IndexedDB, connection state), then switch in the next render.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/**
 * `true` once `flag` has been true, and it never goes back to `false`. The mount-once gate for a
 * `next/dynamic` dialog or panel that takes an `open` prop: `{everOpened && <LazyDialog open={open} />}`
 * fetches the chunk on the first open and then keeps the component mounted exactly as a static import
 * would, so the close transition, `onOpenChange` and focus return to the trigger all still run (#1150).
 * Setting state during render is React's documented way to derive state from the previous render; it
 * re-renders this component before committing, so the first open mounts the dialog in one commit.
 */
export function useEverTrue(flag: boolean): boolean {
  const [ever, setEver] = useState(flag);
  if (flag && !ever) setEver(true);
  return ever || flag;
}
