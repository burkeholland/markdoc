"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * `false` on the server and during hydration, `true` once the component has been hydrated.
 * Use it to keep the first client render identical to the server markup when a value is only
 * known on the client (clock, IndexedDB, connection state), then switch in the next render.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}
