"use client";

import { useEffect, useRef } from "react";
import type { CollabSession } from "@/editor/collab/session";
import { agentDisplayName, splitMentions } from "@/editor/collab/mentions";
import type { AgentRequestMirror } from "@/server/agent-requests";
import { jsonEqual, useSessionValue } from "./use-session";

export type { AgentRequestMirror };
export type AgentRequestMode = AgentRequestMirror["mode"];

function readMirror(session: CollabSession): AgentRequestMirror[] {
  const map = (session.meta.get("agentRequests") as Record<string, AgentRequestMirror> | undefined) ?? {};
  return Object.values(map).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The document's requests as mirrored into the shared document by the server (realtime, no polling). */
export function useAgentRequests(session: CollabSession): AgentRequestMirror[] {
  return useSessionValue(session, readMirror, jsonEqual);
}

/**
 * The request each comment thread shows on its card: the latest (by `updatedAt`) mirror carrying the thread's
 * id, else the one the server stamped on the thread's Y.Map as `requestId` (mirrors written before #997 have
 * no `threadId`). Threads without a request are absent from the record.
 */
export function threadRequests(session: CollabSession): Record<string, AgentRequestMirror> {
  const mirrors = readMirror(session);
  const out: Record<string, AgentRequestMirror> = {};
  for (const r of mirrors) {
    if (r.threadId && !out[r.threadId]) out[r.threadId] = r;
  }
  const byId = new Map(mirrors.map((r) => [r.id, r]));
  session.comments.ymap.forEach((map, threadId) => {
    if (out[threadId]) return;
    const stamped = map.get("requestId");
    const r = typeof stamped === "string" ? byId.get(stamped) : undefined;
    if (r) out[threadId] = r;
  });
  return out;
}

/** {@link threadRequests}, live: the comments panel re-renders its cards only when a thread's request changes. */
export function useThreadRequests(session: CollabSession): Record<string, AgentRequestMirror> {
  return useSessionValue(session, threadRequests, jsonEqual);
}

/** What the composer sends when the body is nothing but the mention. */
export const DEFAULT_INSTRUCTION = "Please take a look at this.";

/** The composer's quick chips once an agent is mentioned: one click fills in a common instruction. */
export const QUICK_INSTRUCTIONS = ["Tighten this", "Fix grammar and tone", "Turn into a checklist"];

/** The API's `QUOTE_MAX` (src/server/agent-requests.ts): a longer anchor is clipped before it is sent. */
export const REQUEST_QUOTE_MAX = 2000;

/** A comment body as an agent instruction: the `@login/agent` mentions removed, whitespace collapsed, trimmed; never empty. */
export function requestInstruction(body: string): string {
  const text = splitMentions(body)
    .filter((part) => !(part.type === "mention" && part.agent))
    .map((part) => (part.type === "mention" ? `@${part.value}` : part.value))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return text || DEFAULT_INSTRUCTION;
}

/**
 * Resolves once the server has acknowledged every local change (Hocuspocus `unsyncedChanges` back to 0 while
 * synced), or after `timeoutMs`. A request made from a comment names its thread, which the server looks up in
 * its live copy of the document: posting before the thread's update is acked answers `404 Comment not found`.
 * Returns the time waited, also recorded as the User Timing measure `markdoc:request-sync-wait`.
 */
export function waitForSynced(session: CollabSession, timeoutMs = 5_000): Promise<number> {
  const start = performance.now();
  const ready = () => session.synced && session.unsyncedChanges === 0;
  const finish = () => {
    const waited = performance.now() - start;
    if (typeof performance.measure === "function") {
      try {
        performance.measure("markdoc:request-sync-wait", { start, end: start + waited });
      } catch {
        // Older User Timing (no options bag): the measure is diagnostics only.
      }
    }
    return waited;
  };
  if (ready()) return Promise.resolve(finish());
  return new Promise((resolve) => {
    const done = () => {
      unsubscribe();
      clearTimeout(timer);
      resolve(finish());
    };
    const unsubscribe = session.subscribe(() => {
      if (ready()) done();
    });
    const timer = setTimeout(done, timeoutMs);
  });
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

/**
 * The agent that claimed a request, as this viewer should read it: `Copilot CLI` for the viewer's own token,
 * `Burke's Copilot CLI` for someone else's (`agentDisplayName`), `An agent` before anyone claimed it. Mirrors written
 * before #1296 carry no `claimedByLogin` and keep the bare name. `ownerNameOf` turns the owner's login into a display
 * name when the caller knows one (collaborators, presence); the login stands in otherwise.
 */
export function claimerName(request: Pick<AgentRequestMirror, "claimedBy" | "claimedByLogin">, viewerLogin: string | null | undefined, ownerNameOf?: (login: string) => string | null): string {
  if (!request.claimedBy) return "An agent";
  const ownerLogin = request.claimedByLogin ?? null;
  return agentDisplayName({ name: request.claimedBy, ownerLogin, ownerName: ownerLogin ? (ownerNameOf?.(ownerLogin) ?? null) : null }, viewerLogin);
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
