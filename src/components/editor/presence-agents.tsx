"use client";

import { useLayoutEffect, useState, type MouseEvent } from "react";
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

const REQUEST_SECTION_CLASS = "mt-1.5 border-t border-line pt-1.5";
const REQUEST_TITLE_CLASS = "px-2 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3";
const REQUEST_LIST_CLASS = "flex max-h-56 flex-col gap-0.5 overflow-y-auto";
const REQUEST_ROW_CLASS = "flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm";
const REQUEST_DETAILS_CLASS = "min-w-0 flex-1";
const REQUEST_INSTRUCTION_CLASS = "block truncate text-ink";
const REQUEST_STATE_CLASS = "block text-xs text-ink-3";
const REQUEST_CANCEL_CLASS = "btn btn-sm btn-outline h-7 shrink-0 px-2 text-xs";
const KEEP_AGENT_CLASS = "btn w-full justify-center gap-1.5";

class PresenceElementOwner<T extends HTMLElement> {
  private current: T | null = null;
  private last: T | null = null;

  constructor(private readonly onReplacement: () => void) {}

  readonly element = () => this.current;
  readonly capture = (element: T | null) => {
    if (this.current === element) return;
    const replaced = element !== null && this.last !== null && this.last !== element;
    this.current = element;
    if (element) this.last = element;
    if (replaced || element === null) this.onReplacement();
  };
}

interface PresenceRequestRender {
  readonly request: AgentRequestMirror;
  readonly id: string;
  readonly userId: string;
  readonly status: AgentRequestMirror["status"];
  readonly mode: AgentRequestMirror["mode"];
  readonly instruction: string;
  readonly claimedBy: string | null;
  readonly claimedByLogin: AgentRequestMirror["claimedByLogin"];
  readonly requester: string | null;
  readonly state: string;
  readonly cancellable: boolean;
}

interface PresenceRequestsAuthority {
  readonly mount: symbol;
  readonly session: CollabSession;
  readonly user: CollabSession["user"];
  readonly userId: string;
  readonly viewer: string | null;
  readonly role: CollabSession["role"];
  readonly pendingSource: AgentRequestMirror[];
  readonly pending: readonly AgentRequestMirror[];
  readonly nameOf: PresenceRequestsProps["nameOf"];
  readonly ownerNameOf: PresenceRequestsProps["ownerNameOf"];
  readonly onCancel: PresenceRequestsProps["onCancel"];
  readonly rows: readonly PresenceRequestRender[];
}

interface PresenceRequestsCells {
  readonly active: { current: PresenceRequestsPublication | null };
  readonly claimedEvents: WeakSet<object>;
}

interface PresenceRequestPublication {
  readonly render: PresenceRequestRender;
  readonly captureRow: (element: HTMLLIElement | null) => void;
  readonly captureCancel: (element: HTMLButtonElement | null) => void;
  readonly onCancel: (event: MouseEvent<HTMLButtonElement>) => void;
}

interface PresenceRequestsPublication {
  readonly authority: PresenceRequestsAuthority;
  readonly rows: readonly PresenceRequestPublication[];
  readonly captureSection: (element: HTMLDivElement | null) => void;
  readonly captureList: (element: HTMLUListElement | null) => void;
  readonly establish: () => void;
  readonly retire: () => boolean;
}

function createPresenceRequestsAuthority(
  mount: symbol,
  { session, pending, nameOf, ownerNameOf, onCancel }: PresenceRequestsProps,
): PresenceRequestsAuthority {
  const user = session.user;
  const userId = user.id;
  const viewer = user.login ?? null;
  const role = session.role;
  const rows = pending.map((request): PresenceRequestRender => {
    const requester = request.userId === userId ? "you" : nameOf(request.userId);
    const state =
      `${request.status === "claimed" ? `${claimerName(request, viewer, ownerNameOf)} is on it` : "Waiting for an agent"} · ${describeMode(request.mode)}` +
      (requester ? ` · ${requester === "you" ? "asked by you" : `asked by ${requester}`}` : "");
    return Object.freeze({
      request,
      id: request.id,
      userId: request.userId,
      status: request.status,
      mode: request.mode,
      instruction: request.instruction,
      claimedBy: request.claimedBy,
      claimedByLogin: request.claimedByLogin,
      requester,
      state,
      cancellable: !!onCancel && (request.userId === userId || role === "owner"),
    });
  });
  return Object.freeze({
    mount,
    session,
    user,
    userId,
    viewer,
    role,
    pendingSource: pending,
    pending: Object.freeze([...pending]),
    nameOf,
    ownerNameOf,
    onCancel,
    rows: Object.freeze(rows),
  });
}

function createPresenceRequestsPublication(
  authority: PresenceRequestsAuthority,
  cells: PresenceRequestsCells,
): PresenceRequestsPublication {
  const { mount, session, user, userId, viewer, role, pendingSource, pending, nameOf, ownerNameOf, onCancel } = authority;
  const renders = authority.rows;
  const retireForReplacement = () => publication.retire();
  const sectionOwner = new PresenceElementOwner<HTMLDivElement>(retireForReplacement);
  const listOwner = new PresenceElementOwner<HTMLUListElement>(retireForReplacement);
  const rowOwners = renders.map(() => new PresenceElementOwner<HTMLLIElement>(retireForReplacement));
  const cancelOwners = renders.map(() => new PresenceElementOwner<HTMLButtonElement>(retireForReplacement));

  const factsAreCurrent = () =>
    authority.mount === mount &&
    authority.session === session &&
    authority.user === user &&
    session.user === user &&
    authority.userId === userId &&
    user.id === userId &&
    authority.viewer === viewer &&
    (user.login ?? null) === viewer &&
    authority.role === role &&
    session.role === role &&
    authority.pendingSource === pendingSource &&
    authority.pending === pending &&
    authority.nameOf === nameOf &&
    authority.ownerNameOf === ownerNameOf &&
    authority.onCancel === onCancel &&
    pendingSource.length === pending.length &&
    pending.length === renders.length &&
    renders.every((row, index) => {
      const request = pendingSource[index];
      return (
        pending[index] === request &&
        row.request === request &&
        request?.id === row.id &&
        request.userId === row.userId &&
        request.status === row.status &&
        request.mode === row.mode &&
        request.instruction === row.instruction &&
        request.claimedBy === row.claimedBy &&
        request.claimedByLogin === row.claimedByLogin &&
        row.cancellable === (!!onCancel && (row.userId === userId || role === "owner"))
      );
    });
  const exactDomIsCurrent = () => {
    const section = sectionOwner.element();
    const list = listOwner.element();
    if (
      !section ||
      !section.isConnected ||
      section.tagName !== "DIV" ||
      section.className !== REQUEST_SECTION_CLASS ||
      section.dataset.testid !== "presence-requests" ||
      !list ||
      !list.isConnected ||
      list.tagName !== "UL" ||
      list.className !== REQUEST_LIST_CLASS ||
      list.parentElement !== section ||
      section.children.length !== 2 ||
      section.children.item(1) !== list ||
      list.children.length !== renders.length
    ) {
      return false;
    }
    const title = section.children.item(0);
    if (
      !(title instanceof HTMLDivElement) ||
      title.className !== REQUEST_TITLE_CLASS ||
      title.textContent !== "Requests"
    ) {
      return false;
    }
    return renders.every((render, index) => {
      const row = rowOwners[index]?.element() ?? null;
      const cancel = cancelOwners[index]?.element() ?? null;
      if (
        !row ||
        !row.isConnected ||
        row.tagName !== "LI" ||
        row.parentElement !== list ||
        list.children.item(index) !== row ||
        row.className !== REQUEST_ROW_CLASS ||
        row.dataset.testid !== "presence-request" ||
        row.dataset.status !== render.status ||
        row.children.length !== (render.cancellable ? 3 : 2)
      ) {
        return false;
      }
      const icon = row.children.item(0);
      const details = row.children.item(1);
      const instruction = details?.children.item(0);
      const state = details?.children.item(1);
      if (
        !(icon instanceof HTMLSpanElement) ||
        icon.className !== cn("mt-0.5 shrink-0", render.status === "claimed" ? "text-violet-600 dark:text-violet-300" : "text-ink-3") ||
        icon.children.length !== 1 ||
        icon.children.item(0)?.getAttribute("aria-hidden") !== "true" ||
        !(details instanceof HTMLSpanElement) ||
        details.className !== REQUEST_DETAILS_CLASS ||
        details.children.length !== 2 ||
        !(instruction instanceof HTMLSpanElement) ||
        instruction.className !== REQUEST_INSTRUCTION_CLASS ||
        instruction.textContent !== render.instruction ||
        !(state instanceof HTMLSpanElement) ||
        state.className !== REQUEST_STATE_CLASS ||
        state.dataset.testid !== "presence-request-state" ||
        state.textContent !== render.state
      ) {
        return false;
      }
      if (!render.cancellable) return cancel === null;
      return (
        !!cancel &&
        cancel.isConnected &&
        cancel.tagName === "BUTTON" &&
        cancel.parentElement === row &&
        row.children.item(2) === cancel &&
        cancel.type === "button" &&
        !cancel.disabled &&
        cancel.className === REQUEST_CANCEL_CLASS &&
        cancel.getAttribute("aria-label") === "Cancel request" &&
        cancel.dataset.testid === "presence-request-cancel" &&
        cancel.textContent?.trim() === "Cancel"
      );
    });
  };
  const ownsAuthority = () =>
    cells.active.current === publication &&
    publication.authority === authority &&
    factsAreCurrent() &&
    exactDomIsCurrent();
  const ownsCancel = (index: number, button: HTMLButtonElement) => {
    const render = renders[index];
    const row = rowOwners[index]?.element() ?? null;
    return (
      !!render?.cancellable &&
      ownsAuthority() &&
      cancelOwners[index]?.element() === button &&
      button.isConnected &&
      !button.disabled &&
      !!row &&
      button.parentElement === row &&
      row.parentElement === listOwner.element() &&
      listOwner.element()?.children.item(index) === row
    );
  };
  const claimEvent = (event: object) => {
    if (cells.claimedEvents.has(event)) return false;
    cells.claimedEvents.add(event);
    return true;
  };
  const retire = () => {
    if (cells.active.current !== publication) return false;
    cells.active.current = null;
    return true;
  };
  const establish = () => {
    const previous = cells.active.current;
    if (previous && previous !== publication) previous.retire();
    if (!factsAreCurrent() || !exactDomIsCurrent()) return;
    cells.active.current = publication;
  };
  const rows = renders.map(
    (render, index): PresenceRequestPublication =>
      Object.freeze({
        render,
        captureRow: rowOwners[index]!.capture,
        captureCancel: cancelOwners[index]!.capture,
        onCancel: (event: MouseEvent<HTMLButtonElement>) => {
          if (!ownsCancel(index, event.currentTarget) || !claimEvent(event)) return;
          onCancel!(render.id);
        },
      }),
  );
  const publication: PresenceRequestsPublication = Object.freeze({
    authority,
    rows: Object.freeze(rows),
    captureSection: sectionOwner.capture,
    captureList: listOwner.capture,
    establish,
    retire,
  });
  return publication;
}

/** The "Requests" section of the presence popover: one row per open request, with Cancel for the requester or the owner. */
export function PresenceRequests(props: PresenceRequestsProps) {
  const [mount] = useState(() => Symbol("presence requests"));
  const [cells] = useState<PresenceRequestsCells>(() => ({
    active: { current: null },
    claimedEvents: new WeakSet<object>(),
  }));
  const publication = createPresenceRequestsPublication(createPresenceRequestsAuthority(mount, props), cells);

  useLayoutEffect(() => {
    publication.establish();
    return () => {
      publication.retire();
    };
  }, [publication]);
  const { captureSection, captureList, rows } = publication;

  return (
    <div ref={captureSection} className={REQUEST_SECTION_CLASS} data-testid="presence-requests">
      <div className={REQUEST_TITLE_CLASS}>Requests</div>
      <ul ref={captureList} className={REQUEST_LIST_CLASS}>
        {rows.map(({ render, captureRow, captureCancel, onCancel }) => {
          return (
            <li ref={captureRow} key={render.id} className={REQUEST_ROW_CLASS} data-testid="presence-request" data-status={render.status}>
              <span className={cn("mt-0.5 shrink-0", render.status === "claimed" ? "text-violet-600 dark:text-violet-300" : "text-ink-3")}>
                {render.status === "claimed" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Bot size={14} aria-hidden="true" />}
              </span>
              <span className={REQUEST_DETAILS_CLASS}>
                <span className={REQUEST_INSTRUCTION_CLASS}>{render.instruction}</span>
                <span className={REQUEST_STATE_CLASS} data-testid="presence-request-state">
                  {render.state}
                </span>
              </span>
              {render.cancellable && (
                <button ref={captureCancel} type="button" className={REQUEST_CANCEL_CLASS} onClick={onCancel} aria-label="Cancel request" data-testid="presence-request-cancel">
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

interface KeepAgentAuthority {
  readonly mount: symbol;
  readonly onClick: () => void;
  readonly primary: boolean | undefined;
  readonly className: string;
}

interface KeepAgentCells {
  readonly active: { current: KeepAgentPublication | null };
  readonly claimedEvents: WeakSet<object>;
}

interface KeepAgentPublication {
  readonly authority: KeepAgentAuthority;
  readonly captureButton: (element: HTMLButtonElement | null) => void;
  readonly establish: () => void;
  readonly retire: () => boolean;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

function createKeepAgentPublication(
  authority: KeepAgentAuthority,
  cells: KeepAgentCells,
): KeepAgentPublication {
  const { mount, onClick, primary, className } = authority;
  const retireForReplacement = () => publication.retire();
  const buttonOwner = new PresenceElementOwner<HTMLButtonElement>(retireForReplacement);
  const factsAreCurrent = () =>
    authority.mount === mount &&
    authority.onClick === onClick &&
    authority.primary === primary &&
    authority.className === className &&
    className === cn(KEEP_AGENT_CLASS, primary ? "btn-primary" : "btn-outline btn-sm");
  const exactDomIsCurrent = () => {
    const button = buttonOwner.element();
    return (
      !!button &&
      button.isConnected &&
      button.tagName === "BUTTON" &&
      button.type === "button" &&
      !button.disabled &&
      button.className === className &&
      button.dataset.testid === "keep-agent-here" &&
      button.children.length === 1 &&
      button.children.item(0)?.getAttribute("aria-hidden") === "true" &&
      button.textContent?.trim() === "Keep an agent here"
    );
  };
  const ownsButton = (button: HTMLButtonElement) =>
    cells.active.current === publication &&
    publication.authority === authority &&
    factsAreCurrent() &&
    exactDomIsCurrent() &&
    buttonOwner.element() === button &&
    button.isConnected &&
    !button.disabled;
  const claimEvent = (event: object) => {
    if (cells.claimedEvents.has(event)) return false;
    cells.claimedEvents.add(event);
    return true;
  };
  const retire = () => {
    if (cells.active.current !== publication) return false;
    cells.active.current = null;
    return true;
  };
  const establish = () => {
    const previous = cells.active.current;
    if (previous && previous !== publication) previous.retire();
    if (!factsAreCurrent() || !exactDomIsCurrent()) return;
    cells.active.current = publication;
  };
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (!ownsButton(event.currentTarget) || !claimEvent(event)) return;
    onClick();
  };
  const publication: KeepAgentPublication = Object.freeze({
    authority,
    captureButton: buttonOwner.capture,
    establish,
    retire,
    onClick: handleClick,
  });
  return publication;
}

/** "Keep an agent here" — the popover's way to the dialog with the paste-able sentence. */
export function KeepAgentHereButton({ onClick, primary }: { onClick: () => void; primary?: boolean }) {
  const [mount] = useState(() => Symbol("keep agent here"));
  const [cells] = useState<KeepAgentCells>(() => ({
    active: { current: null },
    claimedEvents: new WeakSet<object>(),
  }));
  const authority: KeepAgentAuthority = Object.freeze({
    mount,
    onClick,
    primary,
    className: cn(KEEP_AGENT_CLASS, primary ? "btn-primary" : "btn-outline btn-sm"),
  });
  const publication = createKeepAgentPublication(authority, cells);

  useLayoutEffect(() => {
    publication.establish();
    return () => {
      publication.retire();
    };
  }, [publication]);
  const { captureButton, onClick: handleClick } = publication;

  return (
    <button ref={captureButton} type="button" className={authority.className} onClick={handleClick} data-testid="keep-agent-here">
      <Radio size={14} aria-hidden="true" /> Keep an agent here
    </button>
  );
}
