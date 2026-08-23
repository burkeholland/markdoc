"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import { api } from "@/lib/api";
import type { Role } from "@/server/db/schema";

export interface EditorUser {
  id: string;
  name: string;
  login: string | null;
  image: string | null;
}

/** Create one collaboration session per mounted editor and tear it down on unmount. */
export function useCollabSession(docId: string, user: EditorUser, role: Role): CollabSession {
  const [session] = useState(
    () =>
      new CollabSession({
        docId,
        user: makeCollabUser(user.id, user.name, user.image, user.login),
        role,
        getToken: async () => (await api.documents.collabToken(docId)).token,
        deferLocal: true,
      }),
  );
  useEffect(() => {
    session.keepAlive();
    // Only after hydration: locally stored content must not change the first client render.
    session.startLocalPersistence();
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __markdocSession?: CollabSession }).__markdocSession = session;
    }
    return () => session.scheduleDestroy();
  }, [session]);
  return session;
}

/** Subscribe a component to session changes. Returns a version counter that changes on every update. */
export function useSessionVersion(session: CollabSession): number {
  return useSyncExternalStore(
    session.subscribe,
    () => session.version,
    () => session.version,
  );
}

/** Shallow equality for plain objects and arrays of primitives. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** Structural equality via JSON; for small snapshots whose members are plain data. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Derive a value from the session. The component only re-renders when the selected
 * value changes (per `isEqual`), not on every session update.
 */
export function useSessionValue<T>(session: CollabSession, select: (s: CollabSession) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const cache = useRef<{ session: CollabSession; value: T } | null>(null);
  const getSnapshot = () => {
    const next = select(session);
    const prev = cache.current;
    if (prev && prev.session === session && isEqual(prev.value, next)) return prev.value;
    cache.current = { session, value: next };
    return next;
  };
  return useSyncExternalStore(session.subscribe, getSnapshot, getSnapshot);
}

/**
 * Like {@link useSessionValue} but re-selects at most once per `delayMs` after the
 * session changes, for derived values that are expensive or not urgent.
 */
export function useDebouncedSessionValue<T>(
  session: CollabSession,
  select: (s: CollabSession) => T,
  delayMs: number,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const latest = useRef({ select, isEqual });
  useEffect(() => {
    latest.current = { select, isEqual };
  });
  const [value, setValue] = useState(() => select(session));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      timer = null;
      const next = latest.current.select(session);
      setValue((prev) => (latest.current.isEqual(prev, next) ? prev : next));
    };
    update();
    const unsubscribe = session.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(update, delayMs);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [session, delayMs]);
  return value;
}


