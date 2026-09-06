"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CollabSession, type SaveState } from "@/editor/collab/session";
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
export function useCollabSession(docId: string, user: EditorUser, role: Role, embed = false): CollabSession {
  // StrictMode (development) runs this initializer twice and keeps one result: the session connects in
  // the effect below, so the twin never opens a socket and frees itself (see CollabSessionOptions.autoConnect).
  const createSession = () =>
    new CollabSession({
      docId,
      user: makeCollabUser(user.id, user.name, user.image, user.login),
      role,
      getToken: async () => (await api.documents.collabToken(docId)).token,
      deferLocal: true,
      autoConnect: false,
      preserveLocalOnAuthFailure: embed,
    });
  const [session, setSession] = useState(createSession);
  if (
    session.docId !== docId || session.user.id !== user.id || session.role !== role ||
    !!session.options.preserveLocalOnAuthFailure !== embed
  ) {
    setSession(createSession());
  }
  useEffect(() => {
    // Only after hydration: locally stored content must not change the first client render. The
    // mirror goes first so the socket (opened by `connect` once the mirror is in) syncs the difference.
    session.startLocalPersistence();
    session.connect();
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
 * How long the raw save state must stay `saved` before the header chip shows it again after a run of
 * edits. One second: long enough that natural pauses between words (200–600 ms) do not flip the chip,
 * short enough that "Saved" still answers the question right after you stop (#1282).
 */
export const SAVED_HOLD_MS = 1000;

/**
 * The save state as the header chip should display it. Every change shows at once, except the edge
 * `saving → saved` that ends a run of local edits: the provider counts one unsynced change per
 * keystroke and the server acks each within tens of ms, so the raw state alternates `saving`/`saved`
 * on every key (two DOM flips and two `role="status"` announcements). That edge is shown only once the
 * raw state has stayed `saved` for `holdMs`; a flip back to `saving` inside the window cancels the timer
 * and nothing is shown. The sync itself is untouched — this hook only changes what is rendered.
 *
 * A `saving` that is part of a connection handshake (entered from `connecting`, `reconnecting`, `offline`
 * or `error` — the first sync of every open, `onStatus` fires before `onSynced`) is not a run of edits:
 * its `saved` shows immediately, so open time and the "All changes saved" recovery flash are unchanged.
 */
export function useSettledSaveState(live: SaveState, holdMs = SAVED_HOLD_MS): SaveState {
  const [shown, setShown] = useState(live);
  const previous = useRef(live);
  // Whether the current `saving` run began from `saved` (local edits on a live connection).
  const holdArmed = useRef(live === "saving");
  useEffect(() => {
    const prev = previous.current;
    previous.current = live;
    if (live === "saving" && prev !== "saving") holdArmed.current = prev === "saved";
    if (live !== "saved" || !holdArmed.current) {
      setShown(live);
      return;
    }
    const timer = setTimeout(() => setShown("saved"), holdMs);
    return () => clearTimeout(timer);
  }, [live, holdMs]);
  return shown;
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
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(update, delayMs);
    };
    const unsubscribe = session.subscribe(schedule);
    session.ytext.observe(schedule);
    return () => {
      unsubscribe();
      session.ytext.unobserve(schedule);
      if (timer) clearTimeout(timer);
    };
  }, [session, delayMs]);
  return value;
}

/** Longest the shell waits for the first sync before firing the deferred calls anyway (offline, auth refused, slow socket). */
export const OPEN_SETTLED_FALLBACK_MS = 2_500;

/**
 * True once the document is synced with the server (or {@link OPEN_SETTLED_FALLBACK_MS} has passed).
 * REST calls the editor does not need to become editable — star state, the notifications poll, the
 * share hint's collaborator and token lists — wait on this so they do not compete with the
 * collab-token call and the socket handshake for the server's single thread on open (#118).
 */
export function useOpenSettled(session: CollabSession): boolean {
  const synced = useSessionValue(session, (s) => s.synced || s.authError !== null || s.trashed);
  const [settled, setSettled] = useState(synced);
  useEffect(() => {
    if (settled) return;
    if (synced) {
      setSettled(true);
      return;
    }
    const t = setTimeout(() => setSettled(true), OPEN_SETTLED_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [synced, settled]);
  // Latched: a later reconnect must not re-hide what has already loaded.
  return settled || synced;
}
