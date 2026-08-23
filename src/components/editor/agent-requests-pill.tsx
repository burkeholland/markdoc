"use client";

import { useEffect, useRef } from "react";
import { Bot, Loader2, X } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { AgentRequestMirror } from "@/server/agent-requests";
import { Menu, MenuContent, MenuLabel, MenuSeparator, MenuTrigger, Tip } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
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

export interface AgentRequestsPillProps {
  session: CollabSession;
  onCancel: (requestId: string) => void;
}

/** Header pill while requests are waiting for (or being worked on by) an agent. Its menu lists and cancels them. */
export function AgentRequestsPill({ session, onCancel }: AgentRequestsPillProps) {
  const requests = useAgentRequests(session);
  const pending = pendingRequests(requests);
  if (pending.length === 0) return null;
  const claimed = pending.filter((r) => r.status === "claimed");
  const label = claimed.length === pending.length ? `${claimed[0].claimedBy ?? "An agent"} is working…` : `${pending.length} request${pending.length === 1 ? "" : "s"} waiting`;
  const canCancel = (r: AgentRequestMirror) => r.userId === session.user.id || session.role === "owner";
  return (
    <Menu>
      <Tip label="Requests sent to agents from this document">
        <MenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium animate-fade-in",
              claimed.length ? "border-violet-300 bg-violet-100 text-violet-900" : "border-amber-200 bg-amber-50 text-amber-900",
            )}
            data-testid="agent-requests-pill"
            data-count={pending.length}
            aria-label={label}
          >
            {claimed.length ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
            <span className="max-w-48 truncate">{label}</span>
          </button>
        </MenuTrigger>
      </Tip>
      <MenuContent align="end" className="w-80">
        <MenuLabel>Agent requests</MenuLabel>
        <MenuSeparator />
        <ul className="max-h-72 overflow-y-auto py-1" data-testid="agent-requests-list">
          {pending.map((r) => (
            <li key={r.id} className="flex items-start gap-2 px-2 py-1.5 text-sm" data-testid="agent-request-item" data-status={r.status}>
              <span className="mt-0.5 shrink-0 text-ink-3">{r.status === "claimed" ? <Loader2 size={14} className="animate-spin text-violet-600" /> : <Bot size={14} />}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">{r.instruction}</span>
                <span className="block text-xs text-ink-3">
                  {r.status === "claimed" ? `${r.claimedBy ?? "An agent"} is on it` : "Waiting for an agent"} · {r.mode === "suggest" ? "tracked changes" : r.mode === "comment" ? "comments" : "rewrite"}
                </span>
              </span>
              {canCancel(r) && (
                <button type="button" className="icon-btn h-7 w-7 shrink-0 text-ink-3 hover:text-danger" onClick={() => onCancel(r.id)} aria-label="Cancel request" data-testid="agent-request-cancel">
                  <X size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </MenuContent>
    </Menu>
  );
}
