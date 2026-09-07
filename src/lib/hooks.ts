"use client";

import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { COPY_FALLBACK_HINT, copyText, selectContents } from "@/lib/clipboard";

const noopSubscribe = () => () => {};

export type CopyStatus = "idle" | "copied" | "fallback";

interface CopyAuthority {
  mount: symbol;
  text: string;
  target: RefObject<HTMLElement | null> | undefined;
  idleLabel: string;
}

interface CopyOperation {
  authority: CopyAuthority;
  target: HTMLElement | null;
  pending: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface CopyFeedback {
  operation: CopyOperation;
  status: Exclude<CopyStatus, "idle">;
}

/**
 * State for a Copy button. `copy()` must be called straight from the click handler (it calls
 * `copyText` synchronously so the fallback keeps the gesture). On success the status is `copied`
 * for 1.5 s; when both copy paths fail it is `fallback` for 2 s and, when `target` is given, that
 * element's text is selected so the user finishes with Ctrl+C. `label` is what the button should read.
 */
export function useCopy(text: string, target?: RefObject<HTMLElement | null>, idleLabel = "Copy") {
  const [feedback, setFeedback] = useState<CopyFeedback | null>(null);
  const [mount] = useState(() => Symbol("copy"));
  const authority = useMemo<CopyAuthority>(
    () => ({ mount, text, target, idleLabel }),
    [idleLabel, mount, target, text],
  );
  const authorityRef = useRef<CopyAuthority | null>(null);
  const operation = useRef<CopyOperation | null>(null);

  useLayoutEffect(() => {
    authorityRef.current = authority;
    return () => {
      if (authorityRef.current === authority) authorityRef.current = null;
      const current = operation.current;
      if (current?.authority !== authority) return;
      operation.current = null;
      if (current.timer !== null) {
        const timer = current.timer;
        current.timer = null;
        clearTimeout(timer);
      }
    };
  }, [authority]);

  const copy = () => {
    if (authorityRef.current !== authority) return;
    const current = operation.current;
    if (current?.authority === authority && current.pending) return;
    if (current?.authority === authority && current.timer !== null) {
      const timer = current.timer;
      current.timer = null;
      clearTimeout(timer);
      if (authorityRef.current !== authority || operation.current !== current) return;
    }

    const owned: CopyOperation = {
      authority,
      target: authority.target?.current ?? null,
      pending: true,
      timer: null,
    };
    operation.current = owned;
    const attempt = copyText(authority.text);
    const ownsOperation = () => authorityRef.current === authority && operation.current === owned;

    const settle = (ok: boolean) => {
      if (!ownsOperation()) return;
      owned.pending = false;
      if (!ok) {
        selectContents(owned.target);
        if (!ownsOperation()) return;
      }
      setFeedback({ operation: owned, status: ok ? "copied" : "fallback" });
      owned.timer = setTimeout(() => {
        if (!ownsOperation()) return;
        operation.current = null;
        owned.timer = null;
        setFeedback((currentFeedback) => (currentFeedback?.operation === owned ? null : currentFeedback));
      }, ok ? 1500 : 2000);
    };

    void attempt.then(settle, () => settle(false));
    if (ownsOperation()) setFeedback(null);
  };
  const status: CopyStatus = feedback?.operation.authority === authority ? feedback.status : "idle";
  const label = status === "copied" ? "Copied" : status === "fallback" ? COPY_FALLBACK_HINT : authority.idleLabel;
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
