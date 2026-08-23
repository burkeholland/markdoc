"use client";

import { useCallback, useSyncExternalStore } from "react";
import { PHONE_MAX, TABLET_MAX } from "./viewport";

/**
 * `matchMedia` as an external store. The server (and the hydration render) report `fallback`,
 * so components must render the desktop markup first and switch once hydrated.
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener("change", notify);
      return () => mq.removeEventListener("change", notify);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : fallback),
    () => fallback,
  );
}

export type Breakpoint = "phone" | "tablet" | "desktop";

/** Tailwind-aligned: phone `< md`, tablet `md–lg`, desktop `≥ lg`. Desktop during SSR/hydration. */
export function useBreakpoint(): Breakpoint {
  const phone = useMediaQuery(`(max-width: ${PHONE_MAX - 0.02}px)`);
  const tablet = useMediaQuery(`(min-width: ${PHONE_MAX}px) and (max-width: ${TABLET_MAX - 0.02}px)`);
  return phone ? "phone" : tablet ? "tablet" : "desktop";
}

/** Touch-first devices (phones, tablets) where the OS draws its own selection toolbar. */
export function useCoarsePointer(): boolean {
  return useMediaQuery("(pointer: coarse)");
}

export function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
}
