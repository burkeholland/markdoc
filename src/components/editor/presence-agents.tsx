"use client";

import { Bot, Loader2, Radio } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { AgentActivity } from "@/server/agents";
import { cn } from "@/lib/utils";
import { describeMode, type AgentRequestMirror } from "./agent-requests";
import { jsonEqual, useSessionValue } from "./use-session";

/** How long a `meta.agentActivity` entry counts as "working" (the old header chip used the same window). */
export const AGENT_ACTIVITY_SHOW_FOR_MS = 45_000;

/** The last thing an agent (API token) did to the document, as the server writes it into `meta.agentActivity`. */
export function useAgentActivity(session: CollabSession): AgentActivity | null {
  return useSessionValue(session, (s) => (s.meta.get("agentActivity") as AgentActivity | undefined) ?? null, jsonEqual);
}

export function isRecentActivity(activity: AgentActivity | null, now: number): activity is AgentActivity {
  return !!activity && now - activity.at <= AGENT_ACTIVITY_SHOW_FOR_MS;
}

export function activityVerb(action: string): string {
  return action === "suggested" ? "proposed changes" : action === "commented" ? "commented" : action === "reviewed" ? "reviewed suggestions" : "edited";
}

/** "12 s ago" — `relativeTime` says "just now" for the whole 45 s window, too coarse for a live row. */
export function secondsAgo(at: number, now: number): string {
  return `${Math.max(0, Math.round((now - at) / 1000))} s ago`;
}

/**
 * Names of the agents that count as working right now: whoever holds a claimed request, plus the
 * agent behind a fresh `agentActivity`. Agents are matched by name — the token name is what presence,
 * `claimedBy` and `agentActivity.name` all carry.
 */
export function busyAgentNames(pending: AgentRequestMirror[], activity: AgentActivity | null, now: number): Set<string> {
  const names = new Set<string>();
  for (const r of pending) if (r.status === "claimed" && r.claimedBy) names.add(r.claimedBy);
  if (isRecentActivity(activity, now)) names.add(activity.name);
  return names;
}

/** Spinner dot on an agent's avatar while it works. Sized for the 36 px stack avatar. */
export function AgentBusyBadge({ name }: { name: string }) {
  return (
    <span
      className="absolute -bottom-0.5 -right-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-violet-600 text-white ring-2 ring-surface dark:bg-violet-500"
      role="img"
      aria-label={`${name} is working`}
      data-testid="presence-avatar-busy"
    >
      <Loader2 size={10} className="animate-spin" aria-hidden="true" />
    </span>
  );
}

/** Dashed bot placeholder in the stack while requests wait and no agent is present. */
export function WaitingPlaceholder({ count, size }: { count: number; size: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full border-2 border-dashed border-violet-400 bg-surface text-violet-500 ring-2 ring-surface dark:border-violet-500 dark:text-violet-300"
      style={{ width: size, height: size }}
      role="img"
      aria-label={waitingLabel(count)}
      data-testid="presence-waiting"
      data-count={count}
    >
      <Bot size={Math.round(size * 0.5)} aria-hidden="true" />
    </span>
  );
}

export function waitingLabel(count: number): string {
  return `${count} request${count === 1 ? "" : "s"} waiting for an agent`;
}

/** "proposed changes · 12 s ago" appended to an agent's presence row while its activity is fresh. */
export function PresenceActivity({ activity, now }: { activity: AgentActivity; now: number }) {
  return (
    <span data-testid="presence-activity">
      {activityVerb(activity.action)} · {secondsAgo(activity.at, now)}
    </span>
  );
}

export interface PresenceRequestsProps {
  session: CollabSession;
  pending: AgentRequestMirror[];
  /** Display name for a requester, when a presence entry knows it. */
  nameOf: (userId: string) => string | null;
  /** Cancels a request; absent in embed / read-only shells, which then show the rows without Cancel. */
  onCancel?: (requestId: string) => void;
}

/** The "Requests" section of the presence popover: one row per open request, with Cancel for the requester or the owner. */
export function PresenceRequests({ session, pending, nameOf, onCancel }: PresenceRequestsProps) {
  const canCancel = (r: AgentRequestMirror) => !!onCancel && (r.userId === session.user.id || session.role === "owner");
  const who = (r: AgentRequestMirror) => (r.userId === session.user.id ? "you" : nameOf(r.userId));
  return (
    <div className="mt-1.5 border-t border-line pt-1.5" data-testid="presence-requests">
      <div className="px-2 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Requests</div>
      <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
        {pending.map((r) => {
          const requester = who(r);
          return (
            <li key={r.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm" data-testid="presence-request" data-status={r.status}>
              <span className={cn("mt-0.5 shrink-0", r.status === "claimed" ? "text-violet-600 dark:text-violet-300" : "text-ink-3")}>
                {r.status === "claimed" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Bot size={14} aria-hidden="true" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">{r.instruction}</span>
                <span className="block text-xs text-ink-3" data-testid="presence-request-state">
                  {r.status === "claimed" ? `${r.claimedBy ?? "An agent"} is on it` : "Waiting for an agent"} · {describeMode(r.mode)}
                  {requester ? ` · ${requester === "you" ? "asked by you" : `asked by ${requester}`}` : ""}
                </span>
              </span>
              {canCancel(r) && (
                <button type="button" className="btn btn-sm btn-outline h-7 shrink-0 px-2 text-xs" onClick={() => onCancel!(r.id)} aria-label="Cancel request" data-testid="presence-request-cancel">
                  Cancel
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** "Keep an agent here" — the popover's way to the dialog with the paste-able sentence. */
export function KeepAgentHereButton({ onClick, primary }: { onClick: () => void; primary?: boolean }) {
  return (
    <button type="button" className={cn("btn w-full justify-center gap-1.5", primary ? "btn-primary" : "btn-outline btn-sm")} onClick={onClick} data-testid="keep-agent-here">
      <Radio size={14} aria-hidden="true" /> Keep an agent here
    </button>
  );
}
