"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
        user: makeCollabUser(user.id, user.name, user.image),
        role,
        getToken: async () => (await api.documents.collabToken(docId)).token,
      }),
  );
  useEffect(() => () => session.destroy(), [session]);
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

/** Derive a memoized value from the session; recomputed whenever the session changes. */
export function useSessionValue<T>(session: CollabSession, select: (s: CollabSession) => T): T {
  const version = useSessionVersion(session);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => select(session), [session, version]);
}
