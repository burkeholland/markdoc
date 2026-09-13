"use client";

import {
  useCallback,
  useLayoutEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
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

interface PresenceElementOwnerView {
  readonly element: () => HTMLElement | null;
}

class PresenceElementOwner<T extends HTMLElement> implements PresenceElementOwnerView {
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: PresenceElementOwnerView,
      element: T | null,
      previous: T | null,
      last: T | null,
    ) => void,
  ) {}

  readonly element = () => this.current;
  readonly capture = (element: T | null) => {
    if (this.current === element) return;
    const previous = this.current;
    const last = this.last;
    this.current = element;
    if (element) this.last = element;
    this.onChange(this, element, previous, last);
  };
}

interface PresenceDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly PresenceDomSnapshot[];
}

interface PresencePlacement {
  readonly document: Document;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface PresenceDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface PresenceExactPublication<Authority> {
  readonly authority: Authority;
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
}

interface PresenceReplay<Publication extends PresenceExactPublication<unknown>> {
  readonly source: Publication;
  readonly dom: PresenceDomSnapshot;
  readonly placement: PresencePlacement;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface PresencePublicationCells<Publication extends PresenceExactPublication<unknown>> {
  readonly active: { current: Publication | null };
  readonly successorOf: { current: Publication | null };
  readonly replay: { current: PresenceReplay<Publication> | null };
  readonly claimedEvents: WeakSet<Event>;
}

interface PresenceRefReplay {
  readonly owner: PresenceElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

interface PresencePublicationRuntime<Publication extends PresenceExactPublication<unknown>> {
  readonly publication: Publication;
  readonly publish: () => void;
  readonly retire: () => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: PresenceElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isRetired: () => boolean;
  readonly isExactReplay: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly snapshot: () => PresenceDomSnapshot;
  readonly placement: () => PresencePlacement;
  readonly mutationHistoryIsClean: () => boolean;
  readonly release: () => void;
  readonly claim: (action: object) => boolean;
}

function snapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotPresenceDom(node: Node): PresenceDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotPresenceDom)),
  });
}

function presenceDomMatches(snapshot: PresenceDomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = snapshotAttributes(node);
  if (attributes === null || snapshot.attributes === null) {
    if (attributes !== snapshot.attributes) return false;
  } else if (
    attributes.length !== snapshot.attributes.length ||
    attributes.some(([name, value], index) => {
      const expected = snapshot.attributes?.[index];
      return !expected || name !== expected[0] || value !== expected[1];
    })
  ) {
    return false;
  }
  return node.childNodes.length === snapshot.children.length &&
    snapshot.children.every((child, index) =>
      node.childNodes.item(index) === child.node && presenceDomMatches(child));
}

function capturePresencePlacement(root: HTMLElement): PresencePlacement | null {
  const parent = root.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: root.ownerDocument,
    parent,
    previousSibling: root.previousSibling,
    nextSibling: root.nextSibling,
  });
}

function presencePlacementMatches(root: HTMLElement, placement: PresencePlacement): boolean {
  return (
    root.ownerDocument === placement.document &&
    root.parentNode === placement.parent &&
    root.previousSibling === placement.previousSibling &&
    root.nextSibling === placement.nextSibling
  );
}

function createPresenceDomGuard(
  root: HTMLElement,
  placement: PresencePlacement,
): PresenceDomGuard | null {
  const MutationObserverConstructor = placement.document.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some((record) => {
      if (record.target === root || root.contains(record.target)) return true;
      if (record.type !== "childList" || record.target !== placement.parent) return false;
      if (record.previousSibling === root || record.nextSibling === root) return true;
      return [...record.addedNodes, ...record.removedNodes].some((node) =>
        node === root || (
          node.nodeType === 1 &&
          (node as Element).contains(root)
        ));
    });
  };
  const observer = new MutationObserverConstructor(recordChanges);
  observer.observe(root, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  observer.observe(placement.parent, { childList: true });
  return Object.freeze({
    isClean: () => {
      recordChanges(observer.takeRecords());
      return !changed;
    },
    release: () => {
      recordChanges(observer.takeRecords());
      observer.disconnect();
    },
  });
}

function createPresencePublicationRuntime<Publication extends PresenceExactPublication<unknown>>({
  publication,
  cells,
  root,
  owners,
  clearCurrent,
  onRetire,
}: {
  publication: Publication;
  cells: PresencePublicationCells<Publication>;
  root: HTMLElement;
  owners: readonly PresenceElementOwnerView[];
  clearCurrent: () => void;
  onRetire?: () => void;
}): PresencePublicationRuntime<Publication> | null {
  const placement = capturePresencePlacement(root);
  if (!placement) return null;
  const dom = snapshotPresenceDom(root);
  const guard = createPresenceDomGuard(root, placement);
  if (!guard) return null;
  const replayRefs: PresenceRefReplay[] = [];
  for (const owner of owners) {
    const element = owner.element();
    if (!element) {
      guard.release();
      return null;
    }
    replayRefs.push({ owner, element, detached: false, reattached: false });
  }

  let retired = false;
  let layoutRetired = false;
  let elementRetired = false;
  let invalidReplay = false;
  let publicationClaimed = false;
  const claimedActions = new WeakSet<object>();
  const retire = () => {
    if (retired) return false;
    retired = true;
    if (cells.active.current === publication) {
      cells.active.current = null;
      cells.successorOf.current = publication;
    }
    clearCurrent();
    onRetire?.();
    queueMicrotask(() => {
      if (cells.replay.current?.source !== publication) guard.release();
    });
    return true;
  };
  const publishedDomMatches = () =>
    guard.isClean() &&
    root === dom.node &&
    root.isConnected &&
    presencePlacementMatches(root, placement) &&
    presenceDomMatches(dom);
  const refsHaveExactReplay = () =>
    !invalidReplay &&
    replayRefs.length > 0 &&
    replayRefs.every((entry) =>
      entry.detached &&
      entry.reattached &&
      entry.owner.element() === entry.element);

  const runtime: PresencePublicationRuntime<Publication> = Object.freeze({
    publication,
    publish: () => {
      cells.active.current = publication;
      cells.successorOf.current = null;
      cells.replay.current = null;
    },
    retire,
    retireForElement: () => {
      elementRetired = true;
      retire();
    },
    retireForLayout: () => {
      layoutRetired = true;
      retire();
    },
    noteRef: (
      owner: PresenceElementOwnerView,
      element: HTMLElement | null,
      previous: HTMLElement | null,
    ) => {
      const proof = replayRefs.find((entry) => entry.owner === owner);
      if (!proof) {
        invalidReplay = true;
        return;
      }
      if (element === null && previous === proof.element) {
        proof.detached = true;
        proof.reattached = false;
      } else if (
        element === proof.element &&
        previous === null &&
        proof.detached
      ) {
        proof.reattached = true;
      } else if (element !== previous) {
        invalidReplay = true;
      }
    },
    isRetired: () => retired,
    isExactReplay: () =>
      retired &&
      layoutRetired &&
      elementRetired &&
      !publicationClaimed &&
      refsHaveExactReplay() &&
      publishedDomMatches(),
    publishedDomMatches,
    snapshot: () => dom,
    placement: () => placement,
    mutationHistoryIsClean: guard.isClean,
    release: guard.release,
    claim: (action: object) => {
      if (
        retired ||
        publicationClaimed ||
        claimedActions.has(action)
      ) {
        return false;
      }
      publicationClaimed = true;
      claimedActions.add(action);
      return true;
    },
  });
  return runtime;
}

function isNodeFromDocument(value: EventTarget | null, document: Document): value is Node {
  const NodeConstructor = document.defaultView?.Node;
  return Boolean(NodeConstructor && value instanceof NodeConstructor);
}

function claimPresenceClick<Publication extends PresenceExactPublication<unknown>>({
  event,
  button,
  runtime,
  publication,
  action,
  cells,
}: {
  event: ReactMouseEvent<HTMLButtonElement>;
  button: HTMLButtonElement;
  runtime: PresencePublicationRuntime<Publication> | null;
  publication: Publication;
  action: object;
  cells: PresencePublicationCells<Publication>;
}): boolean {
  if (!runtime || runtime.publication !== publication || typeof event !== "object" || event === null) {
    return false;
  }
  const document = button.ownerDocument;
  const view = document.defaultView;
  if (!view) return false;
  const reactEvent = event as ReactMouseEvent<HTMLButtonElement> & {
    _reactName?: unknown;
    isDefaultPrevented?: unknown;
    isPropagationStopped?: unknown;
    persist?: unknown;
  };
  const nativeEvent = reactEvent.nativeEvent;
  const source = reactEvent.currentTarget;
  const target = reactEvent.target;
  const prototype = Object.getPrototypeOf(event) as { constructor?: { name?: unknown } } | null;
  if (
    !(nativeEvent instanceof view.MouseEvent) ||
    !(source instanceof view.HTMLButtonElement) ||
    !isNodeFromDocument(target, document) ||
    prototype?.constructor?.name !== "SyntheticBaseEvent" ||
    reactEvent._reactName !== "onClick" ||
    typeof reactEvent.isDefaultPrevented !== "function" ||
    typeof reactEvent.isPropagationStopped !== "function" ||
    typeof reactEvent.persist !== "function" ||
    reactEvent.type !== "click" ||
    reactEvent.button !== 0 ||
    !reactEvent.bubbles ||
    nativeEvent.type !== "click" ||
    nativeEvent.button !== 0 ||
    nativeEvent.eventPhase === view.Event.NONE ||
    source !== button ||
    source.ownerDocument !== document ||
    !source.isConnected ||
    source.disabled ||
    target !== nativeEvent.target ||
    target.ownerDocument !== document ||
    !source.contains(target) ||
    reactEvent.defaultPrevented ||
    nativeEvent.defaultPrevented ||
    cells.claimedEvents.has(nativeEvent) ||
    cells.active.current !== publication ||
    runtime.isRetired()
  ) {
    return false;
  }
  if (!runtime.claim(action)) return false;
  cells.claimedEvents.add(nativeEvent);
  return true;
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
  readonly result: AgentRequestMirror["result"];
  readonly resultSuggestions: number | undefined;
  readonly resultComments: number | undefined;
  readonly resultSummary: string | undefined;
  readonly threadId: AgentRequestMirror["threadId"];
  readonly agent: AgentRequestMirror["agent"];
  readonly agentLogin: string | undefined;
  readonly agentSlug: string | undefined;
  readonly updatedAt: number;
  readonly requester: string | null;
  readonly state: string;
  readonly cancellable: boolean;
}

interface PresenceRequestsAuthority {
  readonly mount: symbol;
  readonly session: CollabSession;
  readonly documentId: string;
  readonly user: CollabSession["user"];
  readonly userId: string;
  readonly userName: string;
  readonly userColor: string;
  readonly userColorLight: string;
  readonly userAvatar: string | null | undefined;
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
  readonly successorOf: { current: PresenceRequestsPublication | null };
  readonly replay: { current: PresenceReplay<PresenceRequestsPublication> | null };
  readonly claimedEvents: WeakSet<Event>;
  readonly attemptedKeyboardReactEvents: WeakSet<object>;
  readonly attemptedKeyboardNativeEvents: WeakSet<object>;
  readonly claimedKeyboardDeliveries: WeakSet<PresenceKeyboardDelivery>;
  readonly claimedKeyboardPairs: WeakSet<PresenceKeyboardPair>;
  readonly claimedKeyboardMovements: WeakSet<object>;
  readonly claimedKeyboardPublications: WeakSet<object>;
  readonly claimedKeyboardWrappers: WeakSet<object>;
  readonly claimedKeyboardNativeClaims: WeakSet<object>;
  readonly claimedKeyboardWindowClaims: WeakSet<object>;
  readonly claimedKeyboardSources: WeakSet<object>;
  readonly claimedKeyboardDestinations: WeakSet<object>;
  readonly claimedKeyboardReactEvents: WeakSet<object>;
  readonly keyboardDelivery: { current: PresenceKeyboardDelivery | null };
}

interface PresenceRequestPublication {
  readonly identity: symbol;
  readonly index: number;
  readonly render: PresenceRequestRender;
  readonly captureRow: (element: HTMLLIElement | null) => void;
  readonly captureCancel: (element: HTMLButtonElement | null) => void;
  readonly onCancel: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onCancelKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}

interface PresenceRequestsPublication extends PresenceExactPublication<PresenceRequestsAuthority> {
  readonly authority: PresenceRequestsAuthority;
  readonly rows: readonly PresenceRequestPublication[];
  readonly captureSection: (element: HTMLDivElement | null) => void;
  readonly captureList: (element: HTMLUListElement | null) => void;
  readonly onListKeyDownCapture: (event: ReactKeyboardEvent<HTMLUListElement>) => void;
}

interface PresenceRequestsPublicationSet {
  readonly rows: readonly PresenceRequestPublication[];
  readonly captureSection: (element: HTMLDivElement | null) => void;
  readonly captureList: (element: HTMLUListElement | null) => void;
  readonly onListKeyDownCapture: (event: ReactKeyboardEvent<HTMLUListElement>) => void;
  readonly establish: () => void | (() => void);
}

type PresenceNavigationKey =
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "Home"
  | "End";

type PresenceKeyboardGetter = (this: object) => unknown;
type PresenceKeyboardEventField =
  | "type"
  | "target"
  | "currentTarget"
  | "eventPhase"
  | "bubbles"
  | "cancelable"
  | "defaultPrevented"
  | "cancelBubble"
  | "composed";
type PresenceKeyboardKeyField =
  | "key"
  | "code"
  | "location"
  | "repeat"
  | "isComposing"
  | "ctrlKey"
  | "altKey"
  | "metaKey"
  | "shiftKey";

interface PresenceKeyboardGetterAuthority<Field extends string> {
  readonly getters: Readonly<Record<Field, PresenceKeyboardGetter>>;
  readonly isCurrent: () => boolean;
}

interface PresenceKeyboardMethodAuthority<Method> {
  readonly method: Method;
  readonly isCurrent: () => boolean;
}

interface PresenceKeyboardWindowMethod<Method> {
  readonly value: Method;
  readonly isCurrent: () => boolean;
}

type PresenceKeyboardFocus = (
  this: HTMLElement,
  options?: FocusOptions,
) => void;

interface PresenceKeyboardTrustedAuthority {
  readonly matches: (event: object) => boolean;
  readonly read: (event: object) => boolean;
  readonly isCurrent: () => boolean;
}

interface PresenceKeyboardTerminalProof {
  readonly registration: PresenceKeyboardTerminalRegistration;
  readonly nativeEvent: KeyboardEvent;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly terminal: EventTarget;
  readonly path: readonly EventTarget[];
}

interface PresenceKeyboardTerminalRegistration {
  readonly proofFor: (
    event: KeyboardEvent,
  ) => PresenceKeyboardTerminalProof | null;
  readonly claim: (proof: PresenceKeyboardTerminalProof) => boolean;
  readonly release: () => void;
  readonly isCurrent: () => boolean;
}

interface PresencePublishedCancel {
  readonly identity: symbol;
  readonly publication: PresenceRequestsPublication;
  readonly row: PresenceRequestPublication;
  readonly render: PresenceRequestRender;
  readonly owner: PresenceElementOwner<HTMLButtonElement>;
  readonly rowOwner: PresenceElementOwner<HTMLLIElement>;
  readonly element: HTMLButtonElement;
  readonly rowElement: HTMLLIElement;
  readonly index: number;
  readonly order: number;
  readonly session: CollabSession;
  readonly onCancel: NonNullable<PresenceRequestsProps["onCancel"]>;
}

interface PresenceKeyboardAuthority {
  readonly publication: PresenceRequestsPublication;
  readonly section: HTMLDivElement;
  readonly list: HTMLUListElement;
  readonly controls: readonly PresencePublishedCancel[];
  readonly document: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly Event: typeof Event;
  readonly UIEvent: typeof UIEvent;
  readonly KeyboardEvent: typeof KeyboardEvent;
  readonly Document: typeof Document;
  readonly HTMLElement: typeof HTMLElement;
  readonly HTMLButtonElement: typeof HTMLButtonElement;
  readonly event: PresenceKeyboardGetterAuthority<PresenceKeyboardEventField>["getters"];
  readonly keyboard: PresenceKeyboardGetterAuthority<PresenceKeyboardKeyField>["getters"];
  readonly view: PresenceKeyboardGetter;
  readonly detail: PresenceKeyboardGetter;
  readonly activeElement: PresenceKeyboardGetter;
  readonly composedPath: Event["composedPath"];
  readonly focus: PresenceKeyboardFocus;
  readonly trusted: PresenceKeyboardTrustedAuthority;
  readonly terminal: PresenceKeyboardTerminalRegistration;
  readonly apply: typeof Reflect.apply;
  readonly prototypeOf: typeof Object.getPrototypeOf;
  readonly isCurrent: () => boolean;
}

interface PresenceKeyboardEventSnapshot {
  readonly event: KeyboardEvent;
  readonly type: string;
  readonly target: HTMLButtonElement;
  readonly currentTarget: EventTarget;
  readonly phase: number;
  readonly path: readonly EventTarget[];
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly cancelBubble: boolean;
  readonly composed: boolean;
  readonly key: PresenceNavigationKey;
  readonly code: string;
  readonly location: number;
  readonly repeat: boolean;
  readonly composing: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly view: Window | EventTarget | null;
  readonly detail: number;
  readonly trusted: true;
  readonly terminal: PresenceKeyboardTerminalProof;
}

interface PresenceKeyboardReactMethods {
  readonly preventDefault: ReactKeyboardEvent<HTMLElement>["preventDefault"];
  readonly isDefaultPrevented: () => boolean;
  readonly isPropagationStopped: () => boolean;
}

interface PresenceKeyboardReactSnapshot {
  readonly event: ReactKeyboardEvent<HTMLElement>;
  readonly nativeEvent: KeyboardEvent;
  readonly target: HTMLButtonElement;
  readonly currentTarget: HTMLElement;
  readonly phase: number;
  readonly view: ReactKeyboardEvent<HTMLElement>["view"];
  readonly methods: PresenceKeyboardReactMethods;
}

interface PresenceKeyboardPair {
  readonly publication: PresenceRequestsPublication;
  readonly runtime: PresencePublicationRuntime<PresenceRequestsPublication>;
  readonly authority: PresenceKeyboardAuthority;
  readonly native: PresenceKeyboardEventSnapshot;
  readonly capture: PresenceKeyboardReactSnapshot;
  readonly terminal: PresenceKeyboardTerminalProof;
  readonly source: PresencePublishedCancel;
  readonly destination: PresencePublishedCancel;
  readonly key: PresenceNavigationKey;
  readonly movement: object;
  readonly publicationClaim: object;
  readonly wrapperClaim: object;
  readonly nativeClaim: object;
  readonly windowClaim: object;
  readonly sourceClaim: object;
  readonly destinationClaim: object;
}

interface PresenceKeyboardDelivery {
  readonly pair: PresenceKeyboardPair;
  readonly bubble: PresenceKeyboardReactSnapshot;
}

function presenceKeyboardDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  if (
    !current ||
    current.configurable !== expected.configurable ||
    current.enumerable !== expected.enumerable ||
    ("value" in current) !== ("value" in expected) ||
    ("writable" in current) !== ("writable" in expected) ||
    ("get" in current) !== ("get" in expected) ||
    ("set" in current) !== ("set" in expected)
  ) {
    return false;
  }
  return "value" in expected
    ? current.value === expected.value &&
        current.writable === expected.writable
    : current.get === expected.get && current.set === expected.set;
}

function capturePresenceKeyboardGetters<
  const Fields extends readonly string[],
>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  prototype: object,
  fields: Fields,
): PresenceKeyboardGetterAuthority<Fields[number]> | null {
  const entries: [Fields[number], PresenceKeyboardGetter][] = [];
  const descriptors: [Fields[number], PropertyDescriptor][] = [];
  for (const field of fields) {
    const descriptor = getOwnPropertyDescriptor(prototype, field);
    if (!descriptor || typeof descriptor.get !== "function") return null;
    entries.push([field, descriptor.get]);
    descriptors.push([field, Object.freeze({ ...descriptor })]);
  }
  const getters = Object.freeze(
    Object.fromEntries(entries),
  ) as Readonly<Record<Fields[number], PresenceKeyboardGetter>>;
  return Object.freeze({
    getters,
    isCurrent: () =>
      descriptors.every(([field, expected]) =>
        presenceKeyboardDescriptorsMatch(
          getOwnPropertyDescriptor(prototype, field),
          expected,
        ),
      ),
  });
}

function capturePresenceKeyboardMethod<Method>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  prototype: object,
  name: PropertyKey,
): PresenceKeyboardMethodAuthority<Method> | null {
  const descriptor = getOwnPropertyDescriptor(prototype, name);
  if (!descriptor || typeof descriptor.value !== "function") return null;
  const expected = Object.freeze({ ...descriptor });
  return Object.freeze({
    method: descriptor.value as Method,
    isCurrent: () =>
      presenceKeyboardDescriptorsMatch(
        getOwnPropertyDescriptor(prototype, name),
        expected,
      ),
  });
}

function capturePresenceKeyboardWindowMethod<
  Property extends "addEventListener" | "removeEventListener",
>(
  ownerWindow: Window & typeof globalThis,
  property: Property,
): PresenceKeyboardWindowMethod<Window[Property]> | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const reflectGet = ownerWindow.Reflect.get;
  const path: {
    readonly target: object;
    readonly descriptor: Readonly<PropertyDescriptor> | null;
    readonly prototype: object | null;
  }[] = [];
  let target: object | null = ownerWindow;
  let found = false;
  while (target) {
    const descriptor = getOwnPropertyDescriptor(target, property);
    const prototype = getPrototypeOf(target) as object | null;
    path.push(
      Object.freeze({
        target,
        descriptor: descriptor ? Object.freeze({ ...descriptor }) : null,
        prototype,
      }),
    );
    if (descriptor) {
      found = true;
      break;
    }
    target = prototype;
  }
  const value = reflectGet(
    ownerWindow,
    property,
    ownerWindow,
  ) as Window[Property];
  if (!found || typeof value !== "function") return null;
  const isCurrent = () =>
    ownerWindow.Object.getOwnPropertyDescriptor ===
      getOwnPropertyDescriptor &&
    ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
    ownerWindow.Reflect.get === reflectGet &&
    path.every(
      ({ target: entry, descriptor, prototype }) =>
        getPrototypeOf(entry) === prototype &&
        (descriptor
          ? presenceKeyboardDescriptorsMatch(
              getOwnPropertyDescriptor(entry, property),
              descriptor,
            )
          : getOwnPropertyDescriptor(entry, property) === undefined),
    ) &&
    reflectGet(ownerWindow, property, ownerWindow) === value;
  return isCurrent() ? Object.freeze({ value, isCurrent }) : null;
}

function capturePresenceKeyboardTrustedAuthority(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  apply: typeof Reflect.apply,
  probe: KeyboardEvent,
): PresenceKeyboardTrustedAuthority | null {
  const descriptor = getOwnPropertyDescriptor(probe, "isTrusted");
  if (
    !descriptor ||
    descriptor.configurable !== false ||
    descriptor.enumerable !== true ||
    typeof descriptor.get !== "function" ||
    descriptor.set !== undefined
  ) {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  const matches = (event: object) =>
    presenceKeyboardDescriptorsMatch(
      getOwnPropertyDescriptor(event, "isTrusted"),
      expected,
    );
  return Object.freeze({
    matches,
    read: (event: object) =>
      apply(descriptor.get as PresenceKeyboardGetter, event, []) as boolean,
    isCurrent: () => matches(probe),
  });
}

function createPresenceKeyboardTerminalRegistration(
  ownerWindow: Window & typeof globalThis,
  ownerDocument: Document,
  EventConstructor: typeof Event,
  KeyboardEventConstructor: typeof KeyboardEvent,
  keyboardEventPrototype: object,
  eventCurrentTarget: PresenceKeyboardGetter,
  eventPhase: PresenceKeyboardGetter,
  composedPath: Event["composedPath"],
  addEventListener: PresenceKeyboardWindowMethod<Window["addEventListener"]>,
  removeEventListener: PresenceKeyboardWindowMethod<
    Window["removeEventListener"]
  >,
  apply: typeof Reflect.apply,
  prototypeOf: typeof Object.getPrototypeOf,
  intrinsicsAreCurrent: () => boolean,
): PresenceKeyboardTerminalRegistration | null {
  const proofs = new WeakMap<
    KeyboardEvent,
    PresenceKeyboardTerminalProof
  >();
  const invalidEvents = new WeakSet<Event>();
  const claimed = new WeakSet<Event>();
  let active = false;
  let released = false;

  const listener: EventListener = function (
    this: EventTarget,
    event: Event,
  ) {
    if (
      !active ||
      released ||
      !(event instanceof KeyboardEventConstructor) ||
      prototypeOf(event) !== keyboardEventPrototype ||
      invalidEvents.has(event) ||
      !intrinsicsAreCurrent()
    ) {
      return;
    }
    if (proofs.has(event)) {
      invalidEvents.add(event);
      return;
    }
    try {
      const currentTarget = apply(
        eventCurrentTarget,
        event,
        [],
      ) as EventTarget | null;
      const phase = apply(eventPhase, event, []) as number;
      const path = apply(composedPath, event, []) as EventTarget[];
      const terminal = path.at(-1);
      if (
        currentTarget !== this ||
        terminal !== this ||
        phase !== EventConstructor.CAPTURING_PHASE ||
        path.at(-2) !== ownerDocument
      ) {
        invalidEvents.add(event);
        return;
      }
      proofs.set(
        event,
        Object.freeze({
          registration,
          nativeEvent: event,
          receiver: this,
          currentTarget,
          terminal,
          path: Object.freeze([...path]),
        }),
      );
    } catch {
      invalidEvents.add(event);
    }
  };

  const proofFor = (event: KeyboardEvent) => {
    const proof = proofs.get(event);
    if (
      !proof ||
      !active ||
      released ||
      claimed.has(event) ||
      invalidEvents.has(event) ||
      proof.registration !== registration ||
      proof.nativeEvent !== event ||
      proof.receiver !== proof.currentTarget ||
      proof.receiver !== proof.terminal ||
      !intrinsicsAreCurrent()
    ) {
      return null;
    }
    try {
      const path = apply(composedPath, event, []) as EventTarget[];
      return path.length === proof.path.length &&
        path.every((entry, index) => entry === proof.path[index]) &&
        path.at(-2) === ownerDocument &&
        path.at(-1) === proof.receiver
        ? proof
        : null;
    } catch {
      invalidEvents.add(event);
      return null;
    }
  };

  const registration: PresenceKeyboardTerminalRegistration = Object.freeze({
    proofFor,
    claim: (proof: PresenceKeyboardTerminalProof) => {
      if (
        claimed.has(proof.nativeEvent) ||
        proofFor(proof.nativeEvent) !== proof
      ) {
        return false;
      }
      claimed.add(proof.nativeEvent);
      return true;
    },
    release: () => {
      if (released) return;
      released = true;
      active = false;
      apply(removeEventListener.value, ownerWindow, [
        "keydown",
        listener,
        true,
      ]);
    },
    isCurrent: () =>
      active &&
      !released &&
      intrinsicsAreCurrent() &&
      addEventListener.isCurrent() &&
      removeEventListener.isCurrent(),
  });

  active = true;
  try {
    apply(addEventListener.value, ownerWindow, [
      "keydown",
      listener,
      true,
    ]);
    if (registration.isCurrent()) return registration;
    registration.release();
    return null;
  } catch {
    active = false;
    released = true;
    return null;
  }
}

function capturePresenceKeyboardAuthority(
  publication: PresenceRequestsPublication,
  section: HTMLDivElement,
  list: HTMLUListElement,
  rowOwners: readonly PresenceElementOwner<HTMLLIElement>[],
  cancelOwners: readonly PresenceElementOwner<HTMLButtonElement>[],
): PresenceKeyboardAuthority | null {
  const { authority, rows } = publication;
  const { onCancel, session } = authority;
  const document = section.ownerDocument;
  const ownerWindow = document.defaultView;
  if (
    !onCancel ||
    !ownerWindow ||
    list.ownerDocument !== document ||
    list.parentElement !== section ||
    rows.length !== authority.rows.length ||
    rowOwners.length !== rows.length ||
    cancelOwners.length !== rows.length
  ) {
    return null;
  }

  const controls: PresencePublishedCancel[] = [];
  for (const [index, row] of rows.entries()) {
    const render = authority.rows[index];
    if (!render || row.render !== render || row.index !== index) return null;
    if (!render.cancellable) continue;
    const rowElement = rowOwners[index]?.element() ?? null;
    const element = cancelOwners[index]?.element() ?? null;
    if (
      !rowElement ||
      !element ||
      rowElement.ownerDocument !== document ||
      element.ownerDocument !== document ||
      rowElement.parentElement !== list ||
      list.children.item(index) !== rowElement ||
      element.parentElement !== rowElement ||
      rowElement.children.item(2) !== element
    ) {
      return null;
    }
    controls.push(
      Object.freeze({
        identity: Symbol("presence request keyboard cancel"),
        publication,
        row,
        render,
        owner: cancelOwners[index]!,
        rowOwner: rowOwners[index]!,
        element,
        rowElement,
        index,
        order: controls.length,
        session,
        onCancel,
      }),
    );
  }
  if (controls.length < 1) return null;

  const objectConstructor = ownerWindow.Object;
  const getOwnPropertyDescriptor =
    objectConstructor.getOwnPropertyDescriptor;
  const prototypeOf = objectConstructor.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const EventConstructor = ownerWindow.Event;
  const UIEventConstructor = ownerWindow.UIEvent;
  const KeyboardEventConstructor = ownerWindow.KeyboardEvent;
  const DocumentConstructor = ownerWindow.Document;
  const HTMLElementConstructor = ownerWindow.HTMLElement;
  const HTMLButtonElementConstructor = ownerWindow.HTMLButtonElement;
  const eventPrototype = EventConstructor.prototype;
  const uiEventPrototype = UIEventConstructor.prototype;
  const keyboardEventPrototype = KeyboardEventConstructor.prototype;
  const documentPrototype = DocumentConstructor.prototype;
  const eventGetters = capturePresenceKeyboardGetters(
    getOwnPropertyDescriptor,
    eventPrototype,
    [
      "type",
      "target",
      "currentTarget",
      "eventPhase",
      "bubbles",
      "cancelable",
      "defaultPrevented",
      "cancelBubble",
      "composed",
    ] as const,
  );
  const keyboardGetters = capturePresenceKeyboardGetters(
    getOwnPropertyDescriptor,
    keyboardEventPrototype,
    [
      "key",
      "code",
      "location",
      "repeat",
      "isComposing",
      "ctrlKey",
      "altKey",
      "metaKey",
      "shiftKey",
    ] as const,
  );
  const uiGetters = capturePresenceKeyboardGetters(
    getOwnPropertyDescriptor,
    uiEventPrototype,
    ["view", "detail"] as const,
  );
  const documentGetters = capturePresenceKeyboardGetters(
    getOwnPropertyDescriptor,
    documentPrototype,
    ["activeElement"] as const,
  );
  const composedPath =
    capturePresenceKeyboardMethod<Event["composedPath"]>(
      getOwnPropertyDescriptor,
      eventPrototype,
      "composedPath",
    );
  const focus = capturePresenceKeyboardMethod<PresenceKeyboardFocus>(
    getOwnPropertyDescriptor,
    HTMLElementConstructor.prototype,
    "focus",
  );
  const addEventListener = capturePresenceKeyboardWindowMethod(
    ownerWindow,
    "addEventListener",
  );
  const removeEventListener = capturePresenceKeyboardWindowMethod(
    ownerWindow,
    "removeEventListener",
  );
  if (
    !eventGetters ||
    !keyboardGetters ||
    !uiGetters ||
    !documentGetters ||
    !composedPath ||
    !focus ||
    !addEventListener ||
    !removeEventListener
  ) {
    return null;
  }

  let probe: KeyboardEvent;
  try {
    probe = new KeyboardEventConstructor(
      "presence-request-keyboard-intrinsic",
    );
  } catch {
    return null;
  }
  const trusted = capturePresenceKeyboardTrustedAuthority(
    getOwnPropertyDescriptor,
    apply,
    probe,
  );
  if (!trusted) return null;

  let poisoned = false;
  const intrinsicsAreCurrent = () => {
    if (poisoned) return false;
    try {
      const current =
        document.defaultView === ownerWindow &&
        ownerWindow.Object === objectConstructor &&
        ownerWindow.Object.getOwnPropertyDescriptor ===
          getOwnPropertyDescriptor &&
        ownerWindow.Object.getPrototypeOf === prototypeOf &&
        ownerWindow.Reflect.apply === apply &&
        ownerWindow.Event === EventConstructor &&
        ownerWindow.UIEvent === UIEventConstructor &&
        ownerWindow.KeyboardEvent === KeyboardEventConstructor &&
        ownerWindow.Document === DocumentConstructor &&
        ownerWindow.HTMLElement === HTMLElementConstructor &&
        ownerWindow.HTMLButtonElement === HTMLButtonElementConstructor &&
        EventConstructor.prototype === eventPrototype &&
        UIEventConstructor.prototype === uiEventPrototype &&
        KeyboardEventConstructor.prototype === keyboardEventPrototype &&
        DocumentConstructor.prototype === documentPrototype &&
        prototypeOf(probe) === keyboardEventPrototype &&
        prototypeOf(keyboardEventPrototype) === uiEventPrototype &&
        prototypeOf(uiEventPrototype) === eventPrototype &&
        eventGetters.isCurrent() &&
        keyboardGetters.isCurrent() &&
        uiGetters.isCurrent() &&
        documentGetters.isCurrent() &&
        composedPath.isCurrent() &&
        focus.isCurrent() &&
        addEventListener.isCurrent() &&
        removeEventListener.isCurrent() &&
        trusted.isCurrent();
      if (!current) poisoned = true;
      return current;
    } catch {
      poisoned = true;
      return false;
    }
  };
  try {
    if (!intrinsicsAreCurrent() || trusted.read(probe) !== false) {
      return null;
    }
  } catch {
    return null;
  }

  const terminal = createPresenceKeyboardTerminalRegistration(
    ownerWindow,
    document,
    EventConstructor,
    KeyboardEventConstructor,
    keyboardEventPrototype,
    eventGetters.getters.currentTarget,
    eventGetters.getters.eventPhase,
    composedPath.method,
    addEventListener,
    removeEventListener,
    apply,
    prototypeOf,
    intrinsicsAreCurrent,
  );
  if (!terminal) return null;
  return Object.freeze({
    publication,
    section,
    list,
    controls: Object.freeze(controls),
    document,
    ownerWindow,
    Event: EventConstructor,
    UIEvent: UIEventConstructor,
    KeyboardEvent: KeyboardEventConstructor,
    Document: DocumentConstructor,
    HTMLElement: HTMLElementConstructor,
    HTMLButtonElement: HTMLButtonElementConstructor,
    event: eventGetters.getters,
    keyboard: keyboardGetters.getters,
    view: uiGetters.getters.view,
    detail: uiGetters.getters.detail,
    activeElement: documentGetters.getters.activeElement,
    composedPath: composedPath.method,
    focus: focus.method,
    trusted,
    terminal,
    apply,
    prototypeOf,
    isCurrent: () => intrinsicsAreCurrent() && terminal.isCurrent(),
  });
}

function presenceKeyboardValue<Value>(
  authority: PresenceKeyboardAuthority,
  getter: PresenceKeyboardGetter,
  target: object,
): Value {
  return authority.apply(getter, target, []) as Value;
}

function presenceKeyboardIdentitiesMatch(
  left: unknown,
  right: unknown,
) {
  return left === right;
}

function isPresenceNavigationKey(
  key: string,
): key is PresenceNavigationKey {
  return (
    key === "ArrowLeft" ||
    key === "ArrowUp" ||
    key === "ArrowRight" ||
    key === "ArrowDown" ||
    key === "Home" ||
    key === "End"
  );
}

function presenceControlIsEnabled(control: PresencePublishedCancel) {
  const { element, rowElement, owner, rowOwner } = control;
  return (
    owner.element() === element &&
    rowOwner.element() === rowElement &&
    element.isConnected &&
    rowElement.isConnected &&
    !element.disabled &&
    element.ownerDocument === rowElement.ownerDocument &&
    element.parentElement === rowElement
  );
}

function presenceKeyboardDestination(
  authority: PresenceKeyboardAuthority,
  source: PresencePublishedCancel,
  key: PresenceNavigationKey,
) {
  const { controls } = authority;
  const sourceIndex = controls.indexOf(source);
  if (sourceIndex < 0 || !presenceControlIsEnabled(source)) return null;
  let destinationIndex: number | null = null;
  const step =
    key === "ArrowLeft" || key === "ArrowUp"
      ? -1
      : key === "ArrowRight" || key === "ArrowDown"
        ? 1
        : 0;
  if (step !== 0) {
    for (
      let index = sourceIndex + step;
      index >= 0 && index < controls.length;
      index += step
    ) {
      const control = controls[index];
      if (control && presenceControlIsEnabled(control)) {
        destinationIndex = index;
        break;
      }
    }
  } else if (key === "Home") {
    destinationIndex = controls.findIndex(presenceControlIsEnabled);
  } else {
    for (let index = controls.length - 1; index >= 0; index -= 1) {
      const control = controls[index];
      if (control && presenceControlIsEnabled(control)) {
        destinationIndex = index;
        break;
      }
    }
  }
  if (
    destinationIndex === null ||
    destinationIndex < 0 ||
    destinationIndex === sourceIndex
  ) {
    return null;
  }
  const destination = controls[destinationIndex];
  return destination && destination !== source ? destination : null;
}

function capturePresenceKeyboardEvent(
  authority: PresenceKeyboardAuthority,
  nativeEvent: Event,
  expectedPhase: number,
): PresenceKeyboardEventSnapshot | null {
  if (
    !authority.isCurrent() ||
    authority.prototypeOf(nativeEvent) !==
      authority.KeyboardEvent.prototype ||
    !authority.trusted.matches(nativeEvent)
  ) {
    return null;
  }
  try {
    const type = presenceKeyboardValue<string>(
      authority,
      authority.event.type,
      nativeEvent,
    );
    const target = presenceKeyboardValue<EventTarget | null>(
      authority,
      authority.event.target,
      nativeEvent,
    );
    const currentTarget = presenceKeyboardValue<EventTarget | null>(
      authority,
      authority.event.currentTarget,
      nativeEvent,
    );
    const phase = presenceKeyboardValue<number>(
      authority,
      authority.event.eventPhase,
      nativeEvent,
    );
    const bubbles = presenceKeyboardValue<boolean>(
      authority,
      authority.event.bubbles,
      nativeEvent,
    );
    const cancelable = presenceKeyboardValue<boolean>(
      authority,
      authority.event.cancelable,
      nativeEvent,
    );
    const defaultPrevented = presenceKeyboardValue<boolean>(
      authority,
      authority.event.defaultPrevented,
      nativeEvent,
    );
    const cancelBubble = presenceKeyboardValue<boolean>(
      authority,
      authority.event.cancelBubble,
      nativeEvent,
    );
    const composed = presenceKeyboardValue<boolean>(
      authority,
      authority.event.composed,
      nativeEvent,
    );
    const key = presenceKeyboardValue<string>(
      authority,
      authority.keyboard.key,
      nativeEvent,
    );
    const code = presenceKeyboardValue<string>(
      authority,
      authority.keyboard.code,
      nativeEvent,
    );
    const location = presenceKeyboardValue<number>(
      authority,
      authority.keyboard.location,
      nativeEvent,
    );
    const repeat = presenceKeyboardValue<boolean>(
      authority,
      authority.keyboard.repeat,
      nativeEvent,
    );
    const composing = presenceKeyboardValue<boolean>(
      authority,
      authority.keyboard.isComposing,
      nativeEvent,
    );
    const ctrlKey = presenceKeyboardValue<boolean>(
      authority,
      authority.keyboard.ctrlKey,
      nativeEvent,
    );
    const altKey = presenceKeyboardValue<boolean>(
      authority,
      authority.keyboard.altKey,
      nativeEvent,
    );
    const metaKey = presenceKeyboardValue<boolean>(
      authority,
      authority.keyboard.metaKey,
      nativeEvent,
    );
    const shiftKey = presenceKeyboardValue<boolean>(
      authority,
      authority.keyboard.shiftKey,
      nativeEvent,
    );
    const view = presenceKeyboardValue<Window | EventTarget | null>(
      authority,
      authority.view,
      nativeEvent,
    );
    const detail = presenceKeyboardValue<number>(
      authority,
      authority.detail,
      nativeEvent,
    );
    const activeElement = presenceKeyboardValue<Element | null>(
      authority,
      authority.activeElement,
      authority.document,
    );
    const path = authority.apply(
      authority.composedPath,
      nativeEvent,
      [],
    ) as EventTarget[];
    const trusted = authority.trusted.read(nativeEvent);
    const terminal = authority.terminal.proofFor(
      nativeEvent as KeyboardEvent,
    );
    if (
      type !== "keydown" ||
      !(target instanceof authority.HTMLButtonElement) ||
      target.ownerDocument !== authority.document ||
      activeElement !== target ||
      !currentTarget ||
      phase !== expectedPhase ||
      !bubbles ||
      !cancelable ||
      defaultPrevented ||
      cancelBubble ||
      !isPresenceNavigationKey(key) ||
      repeat ||
      composing ||
      ctrlKey ||
      altKey ||
      metaKey ||
      shiftKey ||
      (view !== null &&
        view !== authority.ownerWindow &&
        (!terminal || view !== terminal.receiver)) ||
      trusted !== true ||
      !terminal
    ) {
      return null;
    }

    const expectedPath: EventTarget[] = [];
    let node: Node | null = target;
    while (node) {
      expectedPath.push(node);
      if (node === authority.document) break;
      node = node.parentNode;
    }
    expectedPath.push(terminal.receiver);
    if (
      expectedPath.at(-2) !== authority.document ||
      path.length !== expectedPath.length ||
      path.some((entry, index) => entry !== expectedPath[index]) ||
      path.length !== terminal.path.length ||
      path.some((entry, index) => entry !== terminal.path[index]) ||
      terminal.receiver !== terminal.currentTarget ||
      terminal.receiver !== terminal.terminal ||
      !path.includes(currentTarget) ||
      !path.includes(authority.section) ||
      !path.includes(authority.list)
    ) {
      return null;
    }
    return Object.freeze({
      event: nativeEvent as KeyboardEvent,
      type,
      target,
      currentTarget,
      phase,
      path: Object.freeze([...path]),
      bubbles,
      cancelable,
      defaultPrevented,
      cancelBubble,
      composed,
      key,
      code,
      location,
      repeat,
      composing,
      ctrlKey,
      altKey,
      metaKey,
      shiftKey,
      view,
      detail,
      trusted: true,
      terminal,
    });
  } catch {
    return null;
  }
}

function presenceKeyboardEventsMatch(
  capture: PresenceKeyboardEventSnapshot,
  bubble: PresenceKeyboardEventSnapshot,
  authority: PresenceKeyboardAuthority,
) {
  return (
    capture.event === bubble.event &&
    capture.type === bubble.type &&
    capture.target === bubble.target &&
    capture.currentTarget === bubble.currentTarget &&
    capture.phase === authority.Event.CAPTURING_PHASE &&
    bubble.phase === authority.Event.BUBBLING_PHASE &&
    capture.bubbles === bubble.bubbles &&
    capture.cancelable === bubble.cancelable &&
    capture.defaultPrevented === bubble.defaultPrevented &&
    capture.cancelBubble === bubble.cancelBubble &&
    capture.composed === bubble.composed &&
    capture.key === bubble.key &&
    capture.code === bubble.code &&
    capture.location === bubble.location &&
    capture.repeat === bubble.repeat &&
    capture.composing === bubble.composing &&
    capture.ctrlKey === bubble.ctrlKey &&
    capture.altKey === bubble.altKey &&
    capture.metaKey === bubble.metaKey &&
    capture.shiftKey === bubble.shiftKey &&
    capture.view === bubble.view &&
    capture.detail === bubble.detail &&
    capture.trusted === bubble.trusted &&
    capture.terminal === bubble.terminal &&
    capture.path.length === bubble.path.length &&
    capture.path.every((entry, index) => entry === bubble.path[index])
  );
}

function presenceKeyboardSnapshotRemainsExact(
  snapshot: PresenceKeyboardEventSnapshot,
  authority: PresenceKeyboardAuthority,
  expectedDefaultPrevented = snapshot.defaultPrevented,
) {
  try {
    const currentPath = authority.apply(
      authority.composedPath,
      snapshot.event,
      [],
    ) as EventTarget[];
    return (
      authority.isCurrent() &&
      authority.prototypeOf(snapshot.event) ===
        authority.KeyboardEvent.prototype &&
      authority.trusted.matches(snapshot.event) &&
      authority.trusted.read(snapshot.event) === snapshot.trusted &&
      presenceKeyboardValue(
        authority,
        authority.event.type,
        snapshot.event,
      ) === snapshot.type &&
      presenceKeyboardValue(
        authority,
        authority.event.target,
        snapshot.event,
      ) === snapshot.target &&
      presenceKeyboardValue(
        authority,
        authority.event.currentTarget,
        snapshot.event,
      ) === snapshot.currentTarget &&
      presenceKeyboardValue(
        authority,
        authority.event.eventPhase,
        snapshot.event,
      ) === snapshot.phase &&
      presenceKeyboardValue(
        authority,
        authority.event.bubbles,
        snapshot.event,
      ) === snapshot.bubbles &&
      presenceKeyboardValue(
        authority,
        authority.event.cancelable,
        snapshot.event,
      ) === snapshot.cancelable &&
      presenceKeyboardValue(
        authority,
        authority.event.defaultPrevented,
        snapshot.event,
      ) === expectedDefaultPrevented &&
      presenceKeyboardValue(
        authority,
        authority.event.cancelBubble,
        snapshot.event,
      ) === snapshot.cancelBubble &&
      presenceKeyboardValue(
        authority,
        authority.event.composed,
        snapshot.event,
      ) === snapshot.composed &&
      presenceKeyboardValue(
        authority,
        authority.keyboard.key,
        snapshot.event,
      ) === snapshot.key &&
      presenceKeyboardValue(
        authority,
        authority.keyboard.code,
        snapshot.event,
      ) === snapshot.code &&
      presenceKeyboardValue(
        authority,
        authority.keyboard.location,
        snapshot.event,
      ) === snapshot.location &&
      presenceKeyboardValue(
        authority,
        authority.keyboard.repeat,
        snapshot.event,
      ) === snapshot.repeat &&
      presenceKeyboardValue(
        authority,
        authority.keyboard.isComposing,
        snapshot.event,
      ) === snapshot.composing &&
      presenceKeyboardValue(
        authority,
        authority.keyboard.ctrlKey,
        snapshot.event,
      ) === snapshot.ctrlKey &&
      presenceKeyboardValue(
        authority,
        authority.keyboard.altKey,
        snapshot.event,
      ) === snapshot.altKey &&
      presenceKeyboardValue(
        authority,
        authority.keyboard.metaKey,
        snapshot.event,
      ) === snapshot.metaKey &&
      presenceKeyboardValue(
        authority,
        authority.keyboard.shiftKey,
        snapshot.event,
      ) === snapshot.shiftKey &&
      presenceKeyboardValue(
        authority,
        authority.view,
        snapshot.event,
      ) === snapshot.view &&
      presenceKeyboardValue(
        authority,
        authority.detail,
        snapshot.event,
      ) === snapshot.detail &&
      currentPath.length === snapshot.path.length &&
      currentPath.every(
        (entry, index) => entry === snapshot.path[index],
      ) &&
      currentPath.at(-1) === snapshot.terminal.receiver
    );
  } catch {
    return false;
  }
}

function capturePresenceKeyboardReactEvent(
  event: ReactKeyboardEvent<HTMLElement>,
  authority: PresenceKeyboardAuthority,
  native: PresenceKeyboardEventSnapshot,
  currentTarget: HTMLElement,
): PresenceKeyboardReactSnapshot | null {
  try {
    const reactEvent = event as ReactKeyboardEvent<HTMLElement> & {
      preventDefault?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
    };
    const preventDefault = reactEvent.preventDefault;
    const isDefaultPrevented = reactEvent.isDefaultPrevented;
    const isPropagationStopped = reactEvent.isPropagationStopped;
    if (
      typeof preventDefault !== "function" ||
      typeof isDefaultPrevented !== "function" ||
      typeof isPropagationStopped !== "function" ||
      authority.apply(isDefaultPrevented, event, []) !== false ||
      authority.apply(isPropagationStopped, event, []) !== false ||
      reactEvent.preventDefault !== preventDefault ||
      reactEvent.isDefaultPrevented !== isDefaultPrevented ||
      reactEvent.isPropagationStopped !== isPropagationStopped ||
      event.nativeEvent !== native.event ||
      event.type !== native.type ||
      event.target !== native.target ||
      event.currentTarget !== currentTarget ||
      event.eventPhase !== native.phase ||
      event.bubbles !== native.bubbles ||
      event.cancelable !== native.cancelable ||
      event.defaultPrevented !== native.defaultPrevented ||
      event.isTrusted !== native.trusted ||
      event.key !== native.key ||
      event.code !== native.code ||
      event.location !== native.location ||
      event.repeat !== native.repeat ||
      event.ctrlKey !== native.ctrlKey ||
      event.altKey !== native.altKey ||
      event.metaKey !== native.metaKey ||
      event.shiftKey !== native.shiftKey ||
      (event.view !== null &&
        !presenceKeyboardIdentitiesMatch(
          event.view,
          authority.ownerWindow,
        ) &&
        !presenceKeyboardIdentitiesMatch(
          event.view,
          native.terminal.receiver,
        )) ||
      event.detail !== native.detail
    ) {
      return null;
    }
    return Object.freeze({
      event,
      nativeEvent: native.event,
      target: native.target,
      currentTarget,
      phase: native.phase,
      view: event.view,
      methods: Object.freeze({
        preventDefault,
        isDefaultPrevented,
        isPropagationStopped,
      }),
    });
  } catch {
    return null;
  }
}

function presenceKeyboardReactSnapshotMatches(
  snapshot: PresenceKeyboardReactSnapshot,
  authority: PresenceKeyboardAuthority,
  native: PresenceKeyboardEventSnapshot,
  currentTarget: HTMLElement | null,
) {
  try {
    const event = snapshot.event as ReactKeyboardEvent<HTMLElement> & {
      preventDefault?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
    };
    return (
      event.nativeEvent === snapshot.nativeEvent &&
      event.nativeEvent === native.event &&
      event.type === native.type &&
      event.target === snapshot.target &&
      event.target === native.target &&
      event.currentTarget === currentTarget &&
      event.eventPhase === snapshot.phase &&
      event.eventPhase === native.phase &&
      event.bubbles === native.bubbles &&
      event.cancelable === native.cancelable &&
      event.defaultPrevented === native.defaultPrevented &&
      event.isTrusted === native.trusted &&
      event.key === native.key &&
      event.code === native.code &&
      event.location === native.location &&
      event.repeat === native.repeat &&
      event.ctrlKey === native.ctrlKey &&
      event.altKey === native.altKey &&
      event.metaKey === native.metaKey &&
      event.shiftKey === native.shiftKey &&
      event.view === snapshot.view &&
      (event.view === null ||
        presenceKeyboardIdentitiesMatch(
          event.view,
          authority.ownerWindow,
        ) ||
        presenceKeyboardIdentitiesMatch(
          event.view,
          native.terminal.receiver,
        )) &&
      event.detail === native.detail &&
      event.preventDefault === snapshot.methods.preventDefault &&
      event.isDefaultPrevented ===
        snapshot.methods.isDefaultPrevented &&
      event.isPropagationStopped ===
        snapshot.methods.isPropagationStopped &&
      authority.apply(
        snapshot.methods.isDefaultPrevented,
        snapshot.event,
        [],
      ) === false &&
      authority.apply(
        snapshot.methods.isPropagationStopped,
        snapshot.event,
        [],
      ) === false
    );
  } catch {
    return false;
  }
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
      result: request.result,
      resultSuggestions: request.result?.suggestions,
      resultComments: request.result?.comments,
      resultSummary: request.result?.summary,
      threadId: request.threadId,
      agent: request.agent,
      agentLogin: request.agent?.login,
      agentSlug: request.agent?.slug,
      updatedAt: request.updatedAt,
      requester,
      state,
      cancellable: !!onCancel && (request.userId === userId || role === "owner"),
    });
  });
  return Object.freeze({
    mount,
    session,
    documentId: session.docId,
    user,
    userId,
    userName: user.name,
    userColor: user.color,
    userColorLight: user.colorLight,
    userAvatar: user.avatar,
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

function presenceRequestAuthoritiesMatch(
  previous: PresenceRequestsAuthority,
  current: PresenceRequestsAuthority,
) {
  return (
    previous.mount === current.mount &&
    previous.session === current.session &&
    previous.documentId === current.documentId &&
    previous.user === current.user &&
    previous.userId === current.userId &&
    previous.userName === current.userName &&
    previous.userColor === current.userColor &&
    previous.userColorLight === current.userColorLight &&
    previous.userAvatar === current.userAvatar &&
    previous.viewer === current.viewer &&
    previous.role === current.role &&
    previous.pendingSource === current.pendingSource &&
    previous.nameOf === current.nameOf &&
    previous.ownerNameOf === current.ownerNameOf &&
    previous.onCancel === current.onCancel &&
    previous.pending.length === current.pending.length &&
    previous.rows.length === current.rows.length &&
    previous.rows.every((row, index) => {
      const next = current.rows[index];
      return (
        !!next &&
        previous.pending[index] === current.pending[index] &&
        row.request === next.request &&
        row.id === next.id &&
        row.userId === next.userId &&
        row.status === next.status &&
        row.mode === next.mode &&
        row.instruction === next.instruction &&
        row.claimedBy === next.claimedBy &&
        row.claimedByLogin === next.claimedByLogin &&
        row.result === next.result &&
        row.resultSuggestions === next.resultSuggestions &&
        row.resultComments === next.resultComments &&
        row.resultSummary === next.resultSummary &&
        row.threadId === next.threadId &&
        row.agent === next.agent &&
        row.agentLogin === next.agentLogin &&
        row.agentSlug === next.agentSlug &&
        row.updatedAt === next.updatedAt &&
        row.requester === next.requester &&
        row.state === next.state &&
        row.cancellable === next.cancellable
      );
    })
  );
}

function createPresenceRequestsPublication(
  authority: PresenceRequestsAuthority,
  cells: PresenceRequestsCells,
  requestSuccessor: () => void,
): PresenceRequestsPublicationSet {
  const {
    mount,
    session,
    documentId,
    user,
    userId,
    userName,
    userColor,
    userColorLight,
    userAvatar,
    viewer,
    role,
    pendingSource,
    pending,
    nameOf,
    ownerNameOf,
    onCancel,
  } = authority;
  const renders = authority.rows;
  let currentRuntime: PresencePublicationRuntime<PresenceRequestsPublication> | null = null;
  let lastRuntime: PresencePublicationRuntime<PresenceRequestsPublication> | null = null;
  let keyboardAuthority: PresenceKeyboardAuthority | null = null;
  let keyboardPairs = new WeakMap<KeyboardEvent, PresenceKeyboardPair>();
  let successorRequested = false;
  const onElementChange = (
    owner: PresenceElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (
      element === null ||
      (element !== null && last !== null && element !== last)
    ) {
      runtime?.retireForElement();
    }
  };
  const sectionOwner = new PresenceElementOwner<HTMLDivElement>(onElementChange);
  const listOwner = new PresenceElementOwner<HTMLUListElement>(onElementChange);
  const rowOwners = renders.map(() => new PresenceElementOwner<HTMLLIElement>(onElementChange));
  const cancelOwners = renders.map(() => new PresenceElementOwner<HTMLButtonElement>(onElementChange));

  const factsAreCurrent = () =>
    authority.mount === mount &&
    authority.session === session &&
    authority.documentId === documentId &&
    session.docId === documentId &&
    authority.user === user &&
    session.user === user &&
    authority.userId === userId &&
    user.id === userId &&
    authority.userName === userName &&
    user.name === userName &&
    authority.userColor === userColor &&
    user.color === userColor &&
    authority.userColorLight === userColorLight &&
    user.colorLight === userColorLight &&
    authority.userAvatar === userAvatar &&
    user.avatar === userAvatar &&
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
        request.result === row.result &&
        request.result?.suggestions === row.resultSuggestions &&
        request.result?.comments === row.resultComments &&
        request.result?.summary === row.resultSummary &&
        request.threadId === row.threadId &&
        request.agent === row.agent &&
        request.agent?.login === row.agentLogin &&
        request.agent?.slug === row.agentSlug &&
        request.updatedAt === row.updatedAt &&
        row.requester === (request.userId === userId ? "you" : nameOf(request.userId)) &&
        row.state === (
          `${request.status === "claimed" ? `${claimerName(request, viewer, ownerNameOf)} is on it` : "Waiting for an agent"} · ${describeMode(request.mode)}` +
          (row.requester ? ` · ${row.requester === "you" ? "asked by you" : `asked by ${row.requester}`}` : "")
        ) &&
        row.cancellable === (!!onCancel && (request.userId === userId || role === "owner"))
      );
    });
  const exactDomIsCurrent = () => {
    const section = sectionOwner.element();
    const list = listOwner.element();
    const document = section?.ownerDocument;
    const view = document?.defaultView;
    if (
      !section ||
      !section.isConnected ||
      !section.parentNode ||
      !view ||
      section.tagName !== "DIV" ||
      section.className !== REQUEST_SECTION_CLASS ||
      section.dataset.testid !== "presence-requests" ||
      !list ||
      !list.isConnected ||
      list.ownerDocument !== document ||
      list.tagName !== "UL" ||
      list.className !== REQUEST_LIST_CLASS ||
      list.parentElement !== section ||
      section.children.length !== 2 ||
      section.children.item(1) !== list ||
      list.children.length !== renders.length ||
      [...section.querySelectorAll<HTMLButtonElement>("button")].length !==
        renders.filter((render) => render.cancellable).length
    ) {
      return false;
    }
    const title = section.children.item(0);
    if (
      !(title instanceof view.HTMLDivElement) ||
      title.ownerDocument !== document ||
      title.className !== REQUEST_TITLE_CLASS ||
      title.textContent !== "Requests" ||
      title.childNodes.length !== 1 ||
      title.firstChild?.nodeType !== view.Node.TEXT_NODE
    ) {
      return false;
    }
    let cancelIndex = 0;
    const interactive = [...section.querySelectorAll<HTMLButtonElement>("button")];
    return renders.every((render, index) => {
      const row = rowOwners[index]?.element() ?? null;
      const cancel = cancelOwners[index]?.element() ?? null;
      if (
        !row ||
        !row.isConnected ||
        row.ownerDocument !== document ||
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
      const iconGraphic = icon?.children.item(0);
      if (
        !(icon instanceof view.HTMLSpanElement) ||
        icon.ownerDocument !== document ||
        icon.className !== cn("mt-0.5 shrink-0", render.status === "claimed" ? "text-violet-600 dark:text-violet-300" : "text-ink-3") ||
        icon.children.length !== 1 ||
        icon.childNodes.length !== 1 ||
        iconGraphic?.localName !== "svg" ||
        iconGraphic.getAttribute("aria-hidden") !== "true" ||
        iconGraphic.getAttribute("width") !== "14" ||
        iconGraphic.getAttribute("height") !== "14" ||
        !(details instanceof view.HTMLSpanElement) ||
        details.ownerDocument !== document ||
        details.className !== REQUEST_DETAILS_CLASS ||
        details.children.length !== 2 ||
        details.childNodes.length !== 2 ||
        !(instruction instanceof view.HTMLSpanElement) ||
        instruction.ownerDocument !== document ||
        instruction.className !== REQUEST_INSTRUCTION_CLASS ||
        instruction.textContent !== render.instruction ||
        instruction.children.length !== 0 ||
        !(state instanceof view.HTMLSpanElement) ||
        state.ownerDocument !== document ||
        state.className !== REQUEST_STATE_CLASS ||
        state.dataset.testid !== "presence-request-state" ||
        state.textContent !== render.state ||
        state.children.length !== 0
      ) {
        return false;
      }
      if (!render.cancellable) return cancel === null;
      const exactInteractive = interactive[cancelIndex++];
      return (
        !!cancel &&
        cancel.isConnected &&
        cancel.ownerDocument === document &&
        cancel.tagName === "BUTTON" &&
        cancel.parentElement === row &&
        row.children.item(2) === cancel &&
        cancel.type === "button" &&
        cancel.className === REQUEST_CANCEL_CLASS &&
        cancel.getAttribute("aria-label") === "Cancel request" &&
        cancel.dataset.testid === "presence-request-cancel" &&
        cancel.textContent === "Cancel" &&
        cancel.children.length === 0 &&
        cancel.childNodes.length === 1 &&
        exactInteractive === cancel
      );
    });
  };
  const ownsAuthority = (
    runtime: PresencePublicationRuntime<PresenceRequestsPublication>,
    publication: PresenceRequestsPublication,
  ) =>
    currentRuntime === runtime &&
    cells.active.current === publication &&
    runtime.publication === publication &&
    publication.authority === authority &&
    !runtime.isRetired() &&
    factsAreCurrent() &&
    exactDomIsCurrent() &&
    runtime.publishedDomMatches();
  const ownsCancel = (
    runtime: PresencePublicationRuntime<PresenceRequestsPublication>,
    publication: PresenceRequestsPublication,
    index: number,
    button: HTMLButtonElement,
  ) => {
    const render = renders[index];
    const row = rowOwners[index]?.element() ?? null;
    return (
      !!render?.cancellable &&
      ownsAuthority(runtime, publication) &&
      cancelOwners[index]?.element() === button &&
      button.isConnected &&
      !button.disabled &&
      !!row &&
      button.parentElement === row &&
      row.parentElement === listOwner.element() &&
      listOwner.element()?.children.item(index) === row
    );
  };
  const keyboardNavigationIsCurrent = (
    runtime: PresencePublicationRuntime<PresenceRequestsPublication>,
    publication: PresenceRequestsPublication,
    keyboard: PresenceKeyboardAuthority,
    source: PresencePublishedCancel,
    destination: PresencePublishedCancel,
    key: PresenceNavigationKey,
  ) => {
    if (
      keyboardAuthority !== keyboard ||
      keyboard.publication !== publication ||
      keyboard.section !== sectionOwner.element() ||
      keyboard.list !== listOwner.element() ||
      keyboard.document !== keyboard.section.ownerDocument ||
      keyboard.ownerWindow !== keyboard.document.defaultView ||
      !keyboard.isCurrent() ||
      !ownsAuthority(runtime, publication) ||
      keyboard.controls.length !==
        renders.filter((render) => render.cancellable).length ||
      !keyboard.controls.includes(source) ||
      !keyboard.controls.includes(destination) ||
      source === destination ||
      source.publication !== publication ||
      destination.publication !== publication ||
      source.session !== session ||
      destination.session !== session ||
      source.onCancel !== onCancel ||
      destination.onCancel !== onCancel ||
      source.row !== rows[source.index] ||
      destination.row !== rows[destination.index] ||
      source.row.render !== source.render ||
      destination.row.render !== destination.render ||
      source.render !== renders[source.index] ||
      destination.render !== renders[destination.index] ||
      source.owner !== cancelOwners[source.index] ||
      destination.owner !== cancelOwners[destination.index] ||
      source.rowOwner !== rowOwners[source.index] ||
      destination.rowOwner !== rowOwners[destination.index] ||
      source.owner.element() !== source.element ||
      destination.owner.element() !== destination.element ||
      source.rowOwner.element() !== source.rowElement ||
      destination.rowOwner.element() !== destination.rowElement ||
      source.rowElement.parentElement !== keyboard.list ||
      destination.rowElement.parentElement !== keyboard.list ||
      keyboard.list.children.item(source.index) !== source.rowElement ||
      keyboard.list.children.item(destination.index) !==
        destination.rowElement ||
      source.element.parentElement !== source.rowElement ||
      destination.element.parentElement !== destination.rowElement ||
      source.rowElement.children.item(2) !== source.element ||
      destination.rowElement.children.item(2) !== destination.element ||
      !source.render.cancellable ||
      !destination.render.cancellable ||
      !presenceControlIsEnabled(source) ||
      !presenceControlIsEnabled(destination) ||
      presenceKeyboardDestination(keyboard, source, key) !== destination
    ) {
      return false;
    }
    let order = 0;
    for (const [index, render] of renders.entries()) {
      if (!render.cancellable) {
        if (cancelOwners[index]?.element() !== null) return false;
        continue;
      }
      const control = keyboard.controls[order];
      if (
        !control ||
        control.order !== order ||
        control.index !== index ||
        control.publication !== publication ||
        control.row !== rows[index] ||
        control.render !== render ||
        control.owner !== cancelOwners[index] ||
        control.rowOwner !== rowOwners[index]
      ) {
        return false;
      }
      order += 1;
    }
    try {
      return (
        order === keyboard.controls.length &&
        presenceKeyboardValue<Element | null>(
          keyboard,
          keyboard.activeElement,
          keyboard.document,
        ) === source.element
      );
    } catch {
      return false;
    }
  };

  const captureKeyboardNavigation = (
    event: ReactKeyboardEvent<HTMLUListElement>,
  ) => {
    let nativeEvent: unknown;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return;
    }
    if (
      !nativeEvent ||
      typeof nativeEvent !== "object" ||
      keyboardPairs.has(nativeEvent as KeyboardEvent) ||
      cells.keyboardDelivery.current ||
      cells.attemptedKeyboardReactEvents.has(event) ||
      cells.attemptedKeyboardNativeEvents.has(nativeEvent)
    ) {
      return;
    }
    cells.attemptedKeyboardReactEvents.add(event);
    cells.attemptedKeyboardNativeEvents.add(nativeEvent);
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const keyboard = keyboardAuthority;
    if (
      !runtime ||
      !publication ||
      !keyboard ||
      publication !== keyboard.publication
    ) {
      return;
    }
    const native = capturePresenceKeyboardEvent(
      keyboard,
      nativeEvent as Event,
      keyboard.Event.CAPTURING_PHASE,
    );
    const list = listOwner.element();
    const capture =
      native && list
        ? capturePresenceKeyboardReactEvent(
            event as ReactKeyboardEvent<HTMLElement>,
            keyboard,
            native,
            list,
          )
        : null;
    const source = native
      ? keyboard.controls.find(
          (control) => control.element === native.target,
        )
      : undefined;
    const destination =
      source && native
        ? presenceKeyboardDestination(keyboard, source, native.key)
        : null;
    if (
      !native ||
      !capture ||
      !source ||
      !destination ||
      native.terminal !== keyboard.terminal.proofFor(native.event) ||
      !native.path.includes(source.rowElement) ||
      !presenceKeyboardSnapshotRemainsExact(native, keyboard) ||
      !keyboardNavigationIsCurrent(
        runtime,
        publication,
        keyboard,
        source,
        destination,
        native.key,
      )
    ) {
      return;
    }
    const pair: PresenceKeyboardPair = Object.freeze({
      publication,
      runtime,
      authority: keyboard,
      native,
      capture,
      terminal: native.terminal,
      source,
      destination,
      key: native.key,
      movement: Object.freeze({
        publication,
        source,
        destination,
        key: native.key,
      }),
      publicationClaim: Object.freeze({ publication }),
      wrapperClaim: Object.freeze({ capture: event }),
      nativeClaim: Object.freeze({ nativeEvent }),
      windowClaim: Object.freeze({
        registration: keyboard.terminal,
        proof: native.terminal,
        receiver: native.terminal.receiver,
      }),
      sourceClaim: Object.freeze({ source }),
      destinationClaim: Object.freeze({ destination }),
    });
    keyboardPairs.set(native.event, pair);
  };

  const completeKeyboardNavigation = (
    index: number,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    let nativeEvent: unknown;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return;
    }
    const pair =
      nativeEvent &&
      typeof nativeEvent === "object"
        ? keyboardPairs.get(nativeEvent as KeyboardEvent)
        : undefined;
    if (
      !pair ||
      !nativeEvent ||
      typeof nativeEvent !== "object" ||
      pair.native.event !== nativeEvent ||
      cells.keyboardDelivery.current ||
      cells.attemptedKeyboardReactEvents.has(event) ||
      !cells.attemptedKeyboardNativeEvents.has(nativeEvent)
    ) {
      return;
    }
    const {
      authority: keyboard,
      publication,
      runtime,
      source,
      destination,
      key,
    } = pair;
    let delivery: PresenceKeyboardDelivery | null = null;
    try {
      const currentElement = cancelOwners[index]?.element() ?? null;
      const native = capturePresenceKeyboardEvent(
        keyboard,
        nativeEvent as Event,
        keyboard.Event.BUBBLING_PHASE,
      );
      const bubble =
        native && currentElement
          ? capturePresenceKeyboardReactEvent(
              event as ReactKeyboardEvent<HTMLElement>,
              keyboard,
              native,
              currentElement,
            )
          : null;
      if (
        !currentElement ||
        !native ||
        !bubble ||
        bubble.event === pair.capture.event ||
        pair.publication !== publication ||
        pair.runtime !== runtime ||
        pair.authority !== keyboard ||
        source.index !== index ||
        source.row !== rows[index] ||
        source.owner !== cancelOwners[index] ||
        source.element !== currentElement ||
        event.currentTarget !== currentElement ||
        pair.capture.currentTarget !== keyboard.list ||
        bubble.currentTarget !== source.element ||
        pair.capture.phase !== keyboard.Event.CAPTURING_PHASE ||
        bubble.phase !== keyboard.Event.BUBBLING_PHASE ||
        native.terminal !== pair.terminal ||
        !presenceKeyboardEventsMatch(pair.native, native, keyboard) ||
        !presenceKeyboardReactSnapshotMatches(
          pair.capture,
          keyboard,
          pair.native,
          null,
        ) ||
        !presenceKeyboardReactSnapshotMatches(
          bubble,
          keyboard,
          native,
          currentElement,
        ) ||
        !presenceKeyboardSnapshotRemainsExact(native, keyboard) ||
        !keyboardNavigationIsCurrent(
          runtime,
          publication,
          keyboard,
          source,
          destination,
          key,
        )
      ) {
        return;
      }

      keyboardPairs.delete(pair.native.event);
      cells.attemptedKeyboardReactEvents.add(event);
      delivery = Object.freeze({ pair, bubble });
      if (
        cells.claimedKeyboardDeliveries.has(delivery) ||
        cells.claimedKeyboardPairs.has(pair) ||
        cells.claimedKeyboardMovements.has(pair.movement) ||
        cells.claimedKeyboardPublications.has(pair.publicationClaim) ||
        cells.claimedKeyboardWrappers.has(pair.wrapperClaim) ||
        cells.claimedKeyboardNativeClaims.has(pair.nativeClaim) ||
        cells.claimedKeyboardWindowClaims.has(pair.windowClaim) ||
        cells.claimedKeyboardSources.has(pair.sourceClaim) ||
        cells.claimedKeyboardDestinations.has(pair.destinationClaim) ||
        cells.claimedKeyboardReactEvents.has(pair.capture.event) ||
        cells.claimedKeyboardReactEvents.has(bubble.event) ||
        cells.claimedEvents.has(native.event) ||
        !cells.attemptedKeyboardReactEvents.has(pair.capture.event) ||
        !cells.attemptedKeyboardReactEvents.has(bubble.event) ||
        !cells.attemptedKeyboardNativeEvents.has(native.event) ||
        keyboard.terminal.claim(pair.terminal) !== true
      ) {
        return;
      }
      cells.claimedKeyboardDeliveries.add(delivery);
      cells.claimedKeyboardPairs.add(pair);
      cells.claimedKeyboardMovements.add(pair.movement);
      cells.claimedKeyboardPublications.add(pair.publicationClaim);
      cells.claimedKeyboardWrappers.add(pair.wrapperClaim);
      cells.claimedKeyboardNativeClaims.add(pair.nativeClaim);
      cells.claimedKeyboardWindowClaims.add(pair.windowClaim);
      cells.claimedKeyboardSources.add(pair.sourceClaim);
      cells.claimedKeyboardDestinations.add(pair.destinationClaim);
      cells.claimedKeyboardReactEvents.add(pair.capture.event);
      cells.claimedKeyboardReactEvents.add(bubble.event);
      cells.claimedEvents.add(native.event);
      cells.keyboardDelivery.current = delivery;

      if (
        cells.keyboardDelivery.current !== delivery ||
        !presenceKeyboardReactSnapshotMatches(
          pair.capture,
          keyboard,
          pair.native,
          null,
        ) ||
        !presenceKeyboardReactSnapshotMatches(
          bubble,
          keyboard,
          native,
          currentElement,
        ) ||
        !presenceKeyboardSnapshotRemainsExact(native, keyboard) ||
        !keyboardNavigationIsCurrent(
          runtime,
          publication,
          keyboard,
          source,
          destination,
          key,
        )
      ) {
        return;
      }

      keyboard.apply(
        bubble.methods.preventDefault,
        bubble.event,
        [],
      );
      const currentDefaultQuery = bubble.event.isDefaultPrevented;
      const currentPropagationQuery =
        bubble.event.isPropagationStopped;
      if (
        bubble.event.preventDefault !==
          bubble.methods.preventDefault ||
        typeof currentDefaultQuery !== "function" ||
        typeof currentPropagationQuery !== "function" ||
        currentPropagationQuery !==
          bubble.methods.isPropagationStopped ||
        presenceKeyboardValue<boolean>(
          keyboard,
          keyboard.event.defaultPrevented,
          native.event,
        ) !== true ||
        presenceKeyboardValue<boolean>(
          keyboard,
          keyboard.event.cancelBubble,
          native.event,
        ) !== false ||
        bubble.event.defaultPrevented !== true ||
        keyboard.apply(
          currentDefaultQuery,
          bubble.event,
          [],
        ) !== true ||
        keyboard.apply(
          currentPropagationQuery,
          bubble.event,
          [],
        ) !== false ||
        !presenceKeyboardSnapshotRemainsExact(
          native,
          keyboard,
          true,
        ) ||
        cells.keyboardDelivery.current !== delivery ||
        !keyboardNavigationIsCurrent(
          runtime,
          publication,
          keyboard,
          source,
          destination,
          key,
        )
      ) {
        return;
      }
      keyboard.apply(keyboard.focus, destination.element, [
        { preventScroll: true },
      ]);
    } catch {
      return;
    } finally {
      if (delivery && cells.keyboardDelivery.current === delivery) {
        cells.keyboardDelivery.current = null;
      }
    }
  };

  const requestReplaySuccessor = (
    runtime: PresencePublicationRuntime<PresenceRequestsPublication>,
  ) => {
    if (
      successorRequested ||
      cells.successorOf.current !== runtime.publication ||
      !runtime.isExactReplay() ||
      !factsAreCurrent() ||
      !exactDomIsCurrent()
    ) {
      return;
    }
    successorRequested = true;
    cells.replay.current = Object.freeze({
      source: runtime.publication,
      dom: runtime.snapshot(),
      placement: runtime.placement(),
      historyIsClean: runtime.mutationHistoryIsClean,
      release: runtime.release,
    });
    requestSuccessor();
  };
  const rowActions = renders.map(() => Object.freeze({ identity: Symbol("presence request cancel") }));
  let runtimeForPublication: PresencePublicationRuntime<PresenceRequestsPublication> | null = null;
  const rows = renders.map((render, index): PresenceRequestPublication =>
    Object.freeze({
      identity: Symbol("presence request row"),
      index,
      render,
      captureRow: rowOwners[index]!.capture,
      captureCancel: cancelOwners[index]!.capture,
      onCancel: (event: ReactMouseEvent<HTMLButtonElement>) => {
        const runtime = currentRuntime;
        const publication = runtime?.publication;
        const button = cancelOwners[index]?.element() ?? null;
        if (
          !runtime ||
          !publication ||
          !button ||
          !ownsCancel(runtime, publication, index, button) ||
          !claimPresenceClick({
            event,
            button,
            runtime,
            publication,
            action: rowActions[index]!,
            cells,
          })
        ) {
          return;
        }
        onCancel!(render.id);
      },
      onCancelKeyDown: (
        event: ReactKeyboardEvent<HTMLButtonElement>,
      ) => {
        completeKeyboardNavigation(index, event);
      },
    }));
  const publication: PresenceRequestsPublication = Object.freeze({
    authority,
    rows: Object.freeze(rows),
    captureSection: sectionOwner.capture,
    captureList: listOwner.capture,
    onListKeyDownCapture: captureKeyboardNavigation,
    retire: () => runtimeForPublication?.retire() ?? false,
    isRetired: () => runtimeForPublication?.isRetired() ?? true,
  });
  const establish = () => {
    if (lastRuntime) {
      if (
        lastRuntime.isExactReplay() &&
        cells.successorOf.current === lastRuntime.publication
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (!factsAreCurrent() || !exactDomIsCurrent()) return undefined;
    const section = sectionOwner.element();
    if (!section) return undefined;
    const replay = cells.replay.current;
    if (replay) {
      const sameAuthority = presenceRequestAuthoritiesMatch(
        replay.source.authority,
        authority,
      );
      const exactReplay = (
        sameAuthority &&
        replay.source.isRetired() &&
        cells.successorOf.current === replay.source &&
        replay.historyIsClean() &&
        section === replay.dom.node &&
        presencePlacementMatches(section, replay.placement) &&
        presenceDomMatches(replay.dom)
      );
      cells.replay.current = null;
      replay.release();
      if (cells.successorOf.current === replay.source) {
        cells.successorOf.current = null;
      }
      if (sameAuthority && !exactReplay) return undefined;
    }
    const previous = cells.active.current;
    if (previous && previous !== publication) previous.retire();
    const expectedOwners: PresenceElementOwnerView[] = [
      sectionOwner,
      listOwner,
      ...rowOwners,
      ...cancelOwners.filter((_, index) => renders[index]?.cancellable),
    ];
    const runtime = createPresencePublicationRuntime({
      publication,
      cells,
      root: section,
      owners: expectedOwners,
      clearCurrent: () => {
        if (currentRuntime?.publication === publication) currentRuntime = null;
      },
      onRetire: () => {
        keyboardPairs = new WeakMap<
          KeyboardEvent,
          PresenceKeyboardPair
        >();
        keyboardAuthority?.terminal.release();
        keyboardAuthority = null;
      },
    });
    if (!runtime) return undefined;
    const requiresKeyboard = renders.some((render) => render.cancellable);
    const keyboard = requiresKeyboard
      ? capturePresenceKeyboardAuthority(
          publication,
          section,
          listOwner.element()!,
          rowOwners,
          cancelOwners,
        )
      : null;
    if (requiresKeyboard && !keyboard) {
      runtime.retire();
      return undefined;
    }
    keyboardAuthority = keyboard;
    runtimeForPublication = runtime;
    currentRuntime = runtime;
    lastRuntime = runtime;
    runtime.publish();
    return runtime.retireForLayout;
  };
  return Object.freeze({
    rows: publication.rows,
    captureSection: publication.captureSection,
    captureList: publication.captureList,
    onListKeyDownCapture: publication.onListKeyDownCapture,
    establish,
  });
}

/** The "Requests" section of the presence popover: one row per open request, with Cancel for the requester or the owner. */
export function PresenceRequests(props: PresenceRequestsProps) {
  const [mount] = useState(() => Symbol("presence requests"));
  const [cells] = useState<PresenceRequestsCells>(() => ({
    active: { current: null },
    successorOf: { current: null },
    replay: { current: null },
    claimedEvents: new WeakSet<Event>(),
    attemptedKeyboardReactEvents: new WeakSet<object>(),
    attemptedKeyboardNativeEvents: new WeakSet<object>(),
    claimedKeyboardDeliveries: new WeakSet<PresenceKeyboardDelivery>(),
    claimedKeyboardPairs: new WeakSet<PresenceKeyboardPair>(),
    claimedKeyboardMovements: new WeakSet<object>(),
    claimedKeyboardPublications: new WeakSet<object>(),
    claimedKeyboardWrappers: new WeakSet<object>(),
    claimedKeyboardNativeClaims: new WeakSet<object>(),
    claimedKeyboardWindowClaims: new WeakSet<object>(),
    claimedKeyboardSources: new WeakSet<object>(),
    claimedKeyboardDestinations: new WeakSet<object>(),
    claimedKeyboardReactEvents: new WeakSet<object>(),
    keyboardDelivery: { current: null },
  }));
  const [, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const publication = createPresenceRequestsPublication(
    createPresenceRequestsAuthority(mount, props),
    cells,
    requestPublicationSuccessor,
  );

  useLayoutEffect(() => publication.establish(), [publication]);
  const {
    captureSection,
    captureList,
    onListKeyDownCapture,
    rows,
  } = publication;

  return (
    <div ref={captureSection} className={REQUEST_SECTION_CLASS} data-testid="presence-requests">
      <div className={REQUEST_TITLE_CLASS}>Requests</div>
      <ul
        ref={captureList}
        className={REQUEST_LIST_CLASS}
        onKeyDownCapture={onListKeyDownCapture}
      >
        {rows.map(
          ({
            render,
            captureRow,
            captureCancel,
            onCancel,
            onCancelKeyDown,
          }) => {
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
                  <button ref={captureCancel} type="button" className={REQUEST_CANCEL_CLASS} onClick={onCancel} onKeyDown={onCancelKeyDown} aria-label="Cancel request" data-testid="presence-request-cancel">
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
  readonly successorOf: { current: KeepAgentPublication | null };
  readonly replay: { current: PresenceReplay<KeepAgentPublication> | null };
  readonly claimedEvents: WeakSet<Event>;
}

interface KeepAgentPublication extends PresenceExactPublication<KeepAgentAuthority> {
  readonly authority: KeepAgentAuthority;
  readonly captureButton: (element: HTMLButtonElement | null) => void;
  readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

interface KeepAgentPublicationSet {
  readonly captureButton: (element: HTMLButtonElement | null) => void;
  readonly establish: () => void | (() => void);
  readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

function keepAgentAuthoritiesMatch(
  previous: KeepAgentAuthority,
  current: KeepAgentAuthority,
) {
  return (
    previous.mount === current.mount &&
    previous.onClick === current.onClick &&
    previous.primary === current.primary &&
    previous.className === current.className
  );
}

function createKeepAgentPublication(
  authority: KeepAgentAuthority,
  cells: KeepAgentCells,
  requestSuccessor: () => void,
): KeepAgentPublicationSet {
  const { mount, onClick, primary, className } = authority;
  let currentRuntime: PresencePublicationRuntime<KeepAgentPublication> | null = null;
  let lastRuntime: PresencePublicationRuntime<KeepAgentPublication> | null = null;
  let successorRequested = false;
  const onElementChange = (
    owner: PresenceElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (
      element === null ||
      (element !== null && last !== null && element !== last)
    ) {
      runtime?.retireForElement();
    }
  };
  const buttonOwner = new PresenceElementOwner<HTMLButtonElement>(onElementChange);
  const factsAreCurrent = () =>
    authority.mount === mount &&
    authority.onClick === onClick &&
    authority.primary === primary &&
    authority.className === className &&
    className === cn(KEEP_AGENT_CLASS, primary ? "btn-primary" : "btn-outline btn-sm");
  const exactDomIsCurrent = () => {
    const button = buttonOwner.element();
    const document = button?.ownerDocument;
    const icon = button?.children.item(0);
    const label = button?.childNodes.item(1);
    return (
      !!button &&
      button.isConnected &&
      !!button.parentNode &&
      !!document?.defaultView &&
      button.tagName === "BUTTON" &&
      button.type === "button" &&
      !button.disabled &&
      button.className === className &&
      button.dataset.testid === "keep-agent-here" &&
      button.children.length === 1 &&
      button.childNodes.length === 2 &&
      icon?.localName === "svg" &&
      icon.ownerDocument === document &&
      icon.getAttribute("aria-hidden") === "true" &&
      icon.getAttribute("width") === "14" &&
      icon.getAttribute("height") === "14" &&
      label?.nodeType === document.defaultView.Node.TEXT_NODE &&
      label.nodeValue === " Keep an agent here" &&
      button.textContent === " Keep an agent here"
    );
  };
  const ownsButton = (
    runtime: PresencePublicationRuntime<KeepAgentPublication>,
    publication: KeepAgentPublication,
    button: HTMLButtonElement,
  ) =>
    currentRuntime === runtime &&
    cells.active.current === publication &&
    runtime.publication === publication &&
    publication.authority === authority &&
    !runtime.isRetired() &&
    factsAreCurrent() &&
    exactDomIsCurrent() &&
    buttonOwner.element() === button &&
    button.isConnected &&
    !button.disabled &&
    runtime.publishedDomMatches();
  const requestReplaySuccessor = (
    runtime: PresencePublicationRuntime<KeepAgentPublication>,
  ) => {
    if (
      successorRequested ||
      cells.successorOf.current !== runtime.publication ||
      !runtime.isExactReplay() ||
      !factsAreCurrent() ||
      !exactDomIsCurrent()
    ) {
      return;
    }
    successorRequested = true;
    cells.replay.current = Object.freeze({
      source: runtime.publication,
      dom: runtime.snapshot(),
      placement: runtime.placement(),
      historyIsClean: runtime.mutationHistoryIsClean,
      release: runtime.release,
    });
    requestSuccessor();
  };
  const action = Object.freeze({ identity: Symbol("keep agent here") });
  let runtimeForPublication: PresencePublicationRuntime<KeepAgentPublication> | null = null;
  const publication: KeepAgentPublication = Object.freeze({
    authority,
    captureButton: buttonOwner.capture,
    retire: () => runtimeForPublication?.retire() ?? false,
    isRetired: () => runtimeForPublication?.isRetired() ?? true,
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
      const runtime = currentRuntime;
      const button = buttonOwner.element();
      if (
        !runtime ||
        !button ||
        !ownsButton(runtime, publication, button) ||
        !claimPresenceClick({
          event,
          button,
          runtime,
          publication,
          action,
          cells,
        })
      ) {
        return;
      }
      onClick();
    },
  });
  const establish = () => {
    if (lastRuntime) {
      if (
        lastRuntime.isExactReplay() &&
        cells.successorOf.current === lastRuntime.publication
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (!factsAreCurrent() || !exactDomIsCurrent()) return undefined;
    const button = buttonOwner.element();
    if (!button) return undefined;
    const replay = cells.replay.current;
    if (replay) {
      const sameAuthority = keepAgentAuthoritiesMatch(
        replay.source.authority,
        authority,
      );
      const exactReplay = (
        sameAuthority &&
        replay.source.isRetired() &&
        cells.successorOf.current === replay.source &&
        replay.historyIsClean() &&
        button === replay.dom.node &&
        presencePlacementMatches(button, replay.placement) &&
        presenceDomMatches(replay.dom)
      );
      cells.replay.current = null;
      replay.release();
      if (cells.successorOf.current === replay.source) {
        cells.successorOf.current = null;
      }
      if (sameAuthority && !exactReplay) return undefined;
    }
    const previous = cells.active.current;
    if (previous && previous !== publication) previous.retire();
    const runtime = createPresencePublicationRuntime({
      publication,
      cells,
      root: button,
      owners: [buttonOwner],
      clearCurrent: () => {
        if (currentRuntime?.publication === publication) currentRuntime = null;
      },
    });
    if (!runtime) return undefined;
    runtimeForPublication = runtime;
    currentRuntime = runtime;
    lastRuntime = runtime;
    runtime.publish();
    return runtime.retireForLayout;
  };
  return Object.freeze({
    captureButton: buttonOwner.capture,
    establish,
    onClick: publication.onClick,
  });
}

/** "Keep an agent here" — the popover's way to the dialog with the paste-able sentence. */
export function KeepAgentHereButton({ onClick, primary }: { onClick: () => void; primary?: boolean }) {
  const [mount] = useState(() => Symbol("keep agent here"));
  const [cells] = useState<KeepAgentCells>(() => ({
    active: { current: null },
    successorOf: { current: null },
    replay: { current: null },
    claimedEvents: new WeakSet<Event>(),
  }));
  const [, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const authority: KeepAgentAuthority = Object.freeze({
    mount,
    onClick,
    primary,
    className: cn(KEEP_AGENT_CLASS, primary ? "btn-primary" : "btn-outline btn-sm"),
  });
  const publication = createKeepAgentPublication(
    authority,
    cells,
    requestPublicationSuccessor,
  );

  useLayoutEffect(() => publication.establish(), [publication]);
  const { captureButton, onClick: handleClick } = publication;

  return (
    <button ref={captureButton} type="button" className={authority.className} onClick={handleClick} data-testid="keep-agent-here">
      <Radio size={14} aria-hidden="true" /> Keep an agent here
    </button>
  );
}
