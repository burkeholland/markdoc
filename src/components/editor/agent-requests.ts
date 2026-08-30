"use client";

import { useEffect, useRef } from "react";
import type { CollabSession } from "@/editor/collab/session";
import type { AgentRequestMirror } from "@/server/agent-requests";
import { jsonEqual, useSessionValue } from "./use-session";

export type { AgentRequestMirror };

function readMirror(session: CollabSession): AgentRequestMirror[] {
  const map = (session.meta.get("agentRequests") as Record<string, AgentRequestMirror> | undefined) ?? {};
  return Object.values(map).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The document's requests as mirrored into the shared document by the server (realtime, no polling). */
export function useAgentRequests(session: CollabSession): AgentRequestMirror[] {
  return useSessionValue(session, readMirror, jsonEqual);
}

/** Requests still waiting for an agent or being worked on — what the presence popover lists. */
export function pendingRequests(requests: AgentRequestMirror[]): AgentRequestMirror[] {
  return requests.filter((r) => r.status === "open" || r.status === "claimed");
}

export function describeResult(result: AgentRequestMirror["result"]): string {
  if (!result) return "no changes";
  const parts: string[] = [];
  if (result.suggestions) parts.push(`${result.suggestions} suggestion${result.suggestions === 1 ? "" : "s"}`);
  if (result.comments) parts.push(`${result.comments} comment${result.comments === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "no changes";
}

/** How the agent was asked to answer, as the presence popover words it. */
export function describeMode(mode: AgentRequestMirror["mode"]): string {
  return mode === "suggest" ? "tracked changes" : mode === "comment" ? "comments" : "rewrite";
}

/**
 * Fire `onDone` once for each of the current user's requests that flips to done while the editor is
 * open. Requests that were already done when the page loaded are ignored (the bell covers those).
 */
export function useAgentRequestsDone(session: CollabSession, requests: AgentRequestMirror[], onDone: (r: AgentRequestMirror) => void) {
  const seen = useRef<Map<string, AgentRequestMirror["status"]> | null>(null);
  const handler = useRef(onDone);
  useEffect(() => {
    handler.current = onDone;
  });
  useEffect(() => {
    if (!seen.current) {
      seen.current = new Map(requests.map((r) => [r.id, r.status]));
      return;
    }
    const prev = seen.current;
    for (const r of requests) {
      const before = prev.get(r.id);
      if (r.status === "done" && before !== "done" && before !== undefined && r.userId === session.user.id) handler.current(r);
      prev.set(r.id, r.status);
    }
  }, [requests, session.user.id]);
}
