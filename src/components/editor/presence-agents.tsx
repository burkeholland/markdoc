"use client";

import { Bot, Loader2, Radio } from "lucide-react";
import type { CollabSession, PresenceUser } from "@/editor/collab/session";
import { agentDisplayName } from "@/editor/collab/mentions";
import type { AgentActivity } from "@/server/agents";
import { cn } from "@/lib/utils";
import { claimerName, describeMode, type AgentRequestMirror } from "./agent-requests";
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

/** "just now" for the first seconds, then "12 s ago" — `relativeTime` says "just now" for the whole 45 s window, too coarse for a live row. */
export function secondsAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 5 ? "just now" : `${s} s ago`;
}

/**
 * Names of the agents that count as working right now: whoever holds a claimed request, plus the agent
 * behind a fresh `agentActivity` — unless that agent has since finished (or lost) a request, in which case the
 * activity was the work it just delivered and the badge goes with the request. Agents are matched by name:
 * the token name is what presence, `claimedBy` and `agentActivity.name` all carry.
 */
export function busyAgentNames(requests: AgentRequestMirror[], activity: AgentActivity | null, now: number): Set<string> {
  const names = new Set<string>();
  for (const r of requests) if (r.status === "claimed" && r.claimedBy) names.add(r.claimedBy);
  if (isRecentActivity(activity, now)) {
    const finishedSince = requests.some((r) => (r.status === "done" || r.status === "cancelled") && r.claimedBy === activity.name && r.updatedAt >= activity.at);
    if (!finishedSince) names.add(activity.name);
  }
  return names;
}

/**
 * Display name of a user by login, as far as presence knows: a person in the document, or the owner an agent
 * announced itself for. Null when nobody present answers to the login (callers then show the login).
 */
export function presenceNameOf(users: PresenceUser[], login: string): string | null {
  const key = login.toLowerCase();
  for (const u of users) if (!u.isAgent && u.login?.toLowerCase() === key && u.name) return u.name;
  for (const u of users) if (u.isAgent && u.ownerLogin?.toLowerCase() === key && u.ownerName) return u.ownerName;
  return null;
}

/** A present agent as this viewer reads it: its plain name when it is the viewer's own, else `Owner's Name`. */
export function presenceAgentName(u: Pick<PresenceUser, "name" | "ownerLogin" | "ownerName">, viewerLogin: string | null | undefined): string {
  return agentDisplayName({ name: u.name, ownerLogin: u.ownerLogin, ownerName: u.ownerName }, viewerLogin);
}

/** Spinner dot on an agent's avatar while it works. Sized for the 36 px stack avatar. `name` is the label as the viewer reads it (see presenceAgentName). */
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

/**
 * Dashed bot placeholder in the stack while requests are pending and no agent is present. If an agent has
 * already claimed one (without announcing itself) the placeholder stands in for it and carries the busy badge;
 * `workingBy` is that agent's name as the viewer reads it (see pendingWorker).
 */
export function WaitingPlaceholder({ count, workingBy, size }: { count: number; workingBy?: string | null; size: number }) {
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center rounded-full border-2 border-dashed border-violet-400 bg-surface text-violet-500 ring-2 ring-surface dark:border-violet-500 dark:text-violet-300"
      style={{ width: size, height: size }}
      role="img"
      aria-label={workingBy ? `${workingBy} is working` : waitingLabel(count)}
      data-testid="presence-waiting"
      data-count={count}
      data-state={workingBy ? "working" : "waiting"}
    >
      <Bot size={Math.round(size * 0.5)} aria-hidden="true" />
      {workingBy ? <AgentBusyBadge name={workingBy} /> : null}
    </span>
  );
}

export function waitingLabel(count: number): string {
  return `${count} request${count === 1 ? "" : "s"} waiting for an agent`;
}

/**
 * The agent that claimed a pending request, if any — when none is in presence the placeholder stands in for it.
 * Named as `viewerLogin` reads it: the bare token name for the viewer's own agent (and for rows claimed before
 * #1296, which carry no owner), `Burke's Copilot CLI` for someone else's (`ownerNameOf` supplies the display name).
 */
export function pendingWorker(pending: AgentRequestMirror[], viewerLogin?: string | null, ownerNameOf?: (login: string) => string | null): string | null {
  const claimed = pending.find((r) => r.status === "claimed" && r.claimedBy);
  return claimed ? claimerName(claimed, viewerLogin, ownerNameOf) : null;
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
  /** Display name for an agent's owner by login (see presenceNameOf); the login stands in when absent or null. */
  ownerNameOf?: (login: string) => string | null;
  /** Cancels a request; absent in embed / read-only shells, which then show the rows without Cancel. */
  onCancel?: (requestId: string) => void;
}

/** The "Requests" section of the presence popover: one row per open request, with Cancel for the requester or the owner. */
export function PresenceRequests({ session, pending, nameOf, ownerNameOf, onCancel }: PresenceRequestsProps) {
  const canCancel = (r: AgentRequestMirror) => !!onCancel && (r.userId === session.user.id || session.role === "owner");
  const who = (r: AgentRequestMirror) => (r.userId === session.user.id ? "you" : nameOf(r.userId));
  const viewer = session.user.login ?? null;
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
                  {r.status === "claimed" ? `${claimerName(r, viewer, ownerNameOf)} is on it` : "Waiting for an agent"} · {describeMode(r.mode)}
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
