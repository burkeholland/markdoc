"use client";

import { cloneElement, createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { markRefsRead, useUnreadRefs } from "@/lib/notifications-store";
import { ArrowRight, Bot, Check, CheckCheck, ChevronDown, ChevronRight, ExternalLink, FileText, Hourglass, Loader2, Lock, MessageSquare, MessageSquarePlus, MoreHorizontal, Reply, RotateCcw, SmilePlus, Trash2, X, Pencil, Sparkles, ThumbsDown, ThumbsUp, Wand2 } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { QUICK_REACTIONS, isDocumentRange, type CommentReply, type CommentThread, type Reactions } from "@/editor/collab/comments";
import { SuggestionConflictError, type SuggestionGroup } from "@/editor/collab/suggestions";
import { agentDisplayName, agentMentionLogin, mentionTriggerAt, parseAgentMentions, splitMentions } from "@/editor/collab/mentions";
import { renderCommentBody, wrapLink, wrapSelection } from "@/editor/collab/comment-markdown";
import { isSuggestionOutdated, parseSuggestionBlock, reviewSummaryLabel, reviewVerdictLabel, suggestionBlockFor, type SuggestionBlock } from "@/editor/collab/suggestion-block";
import type { ReviewDto } from "@/server/reviews";
import { Avatar, EmptyState, Menu, MenuContent, MenuItem, MenuTrigger, Popover, PopoverAnchor, PopoverContent, PopoverTrigger, Tip } from "@/components/ui/primitives";
import { api, apiErrorText } from "@/lib/api";
import { AGENT_CONNECT_DISMISSED_KEY, AGENT_DOCS_URL } from "@/lib/mcp";
import { rovingIndex } from "@/lib/a11y";
import { cn, isMac, relativeTime } from "@/lib/utils";
import { jsonEqual, useSessionValue } from "./use-session";
import { claimerName, describeResult, QUICK_INSTRUCTIONS, REQUEST_QUOTE_MAX, requestInstruction, useThreadRequests, waitForSynced, type AgentRequestMirror, type AgentRequestMode } from "./agent-requests";
import "./comments.css";

type Tab = "open" | "resolved" | "suggestions";

/** The anchored text above a comment: a soft rounded highlight, never a coloured bar (docs/agents.md, UI conventions). */
const QUOTE_CLASS = "mb-2 truncate rounded-md bg-amber-50 px-2 py-0.5 text-xs text-ink-3 dark:bg-amber-950/40";

/** Controls inside a comment card: clicks on them act on the control, not on the card. */
const CARD_CONTROLS = "a, button, input, textarea, select, [role='menu'], [role='menuitem'], [role='listbox']";

/** Someone who can be @mentioned: present in the document, a collaborator, or an agent (present or recently active). */
export interface MentionCandidate {
  /** What follows `@` when picked; for agents `<ownerLogin>/<slug>`. */
  login: string;
  name: string;
  image: string | null;
  /** Set for agents (API tokens): whose it is and whether this user may address a request to it. */
  agent?: MentionCandidateAgent | null;
  /** One of the current user's own tokens that has not been in this document yet (listed so it can still be asked). */
  own?: boolean;
}

export interface MentionCandidateAgent {
  /** The login of the user the token acts for. */
  ownerLogin: string;
  /** That user's display name, when the collaborators route knows it (the login stands in otherwise). */
  ownerName?: string | null;
  /**
   * Whether the current user may address a request to it: their own tokens always; someone else's only once its
   * owner switched `collaboratorsMayAsk` on (#1296). A locked agent can still be *mentioned* — the picker greys it.
   */
  canAsk: boolean;
}

/** The agent's owner as the UI names them: display name when known, else the login. */
export function agentOwnerName(agent: Pick<MentionCandidateAgent, "ownerLogin" | "ownerName">): string {
  return agent.ownerName?.trim() || agent.ownerLogin;
}

/**
 * What the composer says instead of sending to a locked agent — the same sentence the server would answer with
 * (`403 agent-owner-only`, `resolveAddressee` in src/server/agent-requests.ts): `Burke's Copilot CLI only takes
 * requests from Burke.` The server's 403 stays as the fallback when the two disagree (stale picker, owner just
 * switched it off).
 */
export function agentOwnerOnlyMessage(candidate: MentionCandidate & { agent: MentionCandidateAgent }, viewerLogin: string | null | undefined): string {
  return `${agentDisplayName({ name: candidate.name, ownerLogin: candidate.agent.ownerLogin, ownerName: candidate.agent.ownerName }, viewerLogin)} only takes requests from ${agentOwnerName(candidate.agent)}.`;
}

/**
 * Display name of a user by login, as far as the panel knows them: a collaborator or present person, or the owner of
 * an agent the collaborators route listed. Null when unknown (callers then show the login).
 */
export function displayNameOf(candidates: MentionCandidate[], login: string): string | null {
  const key = login.toLowerCase();
  for (const c of candidates) if (!c.agent && c.login.toLowerCase() === key && c.name) return c.name;
  for (const c of candidates) if (c.agent && c.agent.ownerLogin.toLowerCase() === key && c.agent.ownerName) return c.agent.ownerName;
  return null;
}

/** Candidates matching a picker query: login or name prefix; agents also by their slug. Humans first, then agents. */
export function filterMentionCandidates(candidates: MentionCandidate[], query: string, max: number): MentionCandidate[] {
  const q = query.toLowerCase();
  const hit = (c: MentionCandidate) => {
    if (c.login.toLowerCase().startsWith(q) || c.name.toLowerCase().startsWith(q)) return true;
    if (!c.agent) return false;
    const slug = c.login.slice(c.login.indexOf("/") + 1).toLowerCase();
    return slug.startsWith(q) || slug.replace(/-/g, " ").startsWith(q);
  };
  const humans = candidates.filter((c) => !c.agent && hit(c));
  const agents = candidates.filter((c) => c.agent && hit(c));
  return [...humans, ...agents].slice(0, max);
}

/** The agents a body mentions that the picker knows (`@owner/slug` matched case-insensitively), in order of first mention. */
export function mentionedAgents(body: string, candidates: MentionCandidate[]): MentionCandidate[] {
  const agents = candidates.filter((c) => c.agent);
  if (agents.length === 0) return [];
  const out: MentionCandidate[] = [];
  for (const m of parseAgentMentions(body)) {
    const login = `${m.login}/${m.agent}`.toLowerCase();
    const hit = agents.find((c) => c.login.toLowerCase() === login);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** Offset just past the last `@owner/agent` mention in a body, or -1 when there is none. */
function lastAgentMentionEnd(body: string): number {
  let offset = 0;
  let end = -1;
  for (const part of splitMentions(body)) {
    const length = part.type === "mention" ? 1 + part.value.length + (part.agent ? 1 + part.agent.length : 0) : part.value.length;
    offset += length;
    if (part.type === "mention" && part.agent) end = offset;
  }
  return end;
}

/** Renders a comment body: inline Markdown plus `@login` chips. A ```suggestion block is lifted out (see SuggestionBox). */
export function MentionBody({ body, className }: { body: string; className?: string }) {
  const content = useMemo(() => renderCommentBody(parseSuggestionBlock(body)?.prose ?? body), [body]);
  if (content === null) return null;
  return (
    <div className={cn("comment-body min-w-0 break-words", className)} data-testid="comment-body">
      {content}
    </div>
  );
}

/** The proposed replacement as plain text: the passage it applies to is already highlighted in the document, so no diff. */
export function SuggestionText({ text }: { text: string }) {
  return (
    <div className="suggestion-text" data-testid="suggestion-text">
      {text === "" ? (
        <span className="italic text-ink-4" data-testid="suggestion-deletes">
          Deletes the highlighted text
        </span>
      ) : (
        text
      )}
    </div>
  );
}

type CommentSuggestionState = "pending" | "accepted" | "rejected" | "outdated";

interface CommentSuggestionTarget {
  thread: CommentThread;
  reply: CommentReply | null;
  block: SuggestionBlock;
  state: CommentSuggestionState;
}

function commentSuggestionState(thread: CommentThread, stored: CommentReply["suggestionState"] | CommentThread["suggestionState"], text: string): CommentSuggestionState {
  return stored ?? (isSuggestionOutdated(thread, text) ? "outdated" : "pending");
}

/** Root and reply suggestion blocks in display order, with each reply retaining its own decision. */
function commentSuggestionTargets(threads: CommentThread[], text: string): CommentSuggestionTarget[] {
  return threads.flatMap((thread) => {
    const targets: CommentSuggestionTarget[] = [];
    const root = parseSuggestionBlock(thread.body);
    if (root) targets.push({ thread, reply: null, block: root, state: commentSuggestionState(thread, thread.suggestionState, text) });
    for (const reply of thread.replies) {
      const block = parseSuggestionBlock(reply.body);
      if (block) targets.push({ thread, reply, block, state: commentSuggestionState(thread, reply.suggestionState, text) });
    }
    return targets;
  });
}

const SUGGESTION_ACTIONS_CLASS = "mt-2 flex flex-wrap items-center gap-2";
const SUGGESTION_ACCEPT_CLASS = "btn btn-sm btn-primary shrink-0 gap-1.5 whitespace-nowrap";
const SUGGESTION_REJECT_CLASS = "btn btn-sm btn-outline shrink-0 gap-1.5 whitespace-nowrap";
const seenSuggestionNativeEvents = new WeakSet<globalThis.MouseEvent>();
const claimedSuggestionNativeEvents = new WeakSet<globalThis.MouseEvent>();
const suggestionEventCurrentTargetGetter = Object.getOwnPropertyDescriptor(
  globalThis.Event.prototype,
  "currentTarget",
)?.get;
const suggestionEventTargetGetter = Object.getOwnPropertyDescriptor(
  globalThis.Event.prototype,
  "target",
)?.get;
const suggestionEventDefaultPreventedGetter = Object.getOwnPropertyDescriptor(
  globalThis.Event.prototype,
  "defaultPrevented",
)?.get;
const suggestionEventComposedPath = globalThis.Event.prototype.composedPath;
const suggestionAddEventListener = globalThis.EventTarget.prototype.addEventListener;
const suggestionRemoveEventListener = globalThis.EventTarget.prototype.removeEventListener;
const suggestionWindowAddEventListener =
  typeof globalThis.addEventListener === "function" ? globalThis.addEventListener : null;
const suggestionWindowRemoveEventListener =
  typeof globalThis.removeEventListener === "function" ? globalThis.removeEventListener : null;
const suggestionGlobalWindow = typeof window === "undefined" ? null : window;
const suggestionReflectApply = Reflect.apply;

function suggestionNativeCurrentTarget(event: Event): EventTarget | null {
  return suggestionEventCurrentTargetGetter
    ? (suggestionReflectApply(suggestionEventCurrentTargetGetter, event, []) as EventTarget | null)
    : null;
}

function suggestionNativeTarget(event: Event): EventTarget | null {
  return suggestionEventTargetGetter
    ? (suggestionReflectApply(suggestionEventTargetGetter, event, []) as EventTarget | null)
    : null;
}

function suggestionNativeComposedPath(event: Event): EventTarget[] {
  return suggestionReflectApply(suggestionEventComposedPath, event, []) as EventTarget[];
}

function suggestionNativeDefaultPrevented(event: Event): boolean {
  return !suggestionEventDefaultPreventedGetter ||
    suggestionReflectApply(suggestionEventDefaultPreventedGetter, event, []) === true;
}

function addSuggestionClickListener(target: EventTarget, listener: EventListener, options?: boolean) {
  suggestionReflectApply(suggestionAddEventListener, target, ["click", listener, options]);
}

function removeSuggestionClickListener(target: EventTarget, listener: EventListener, options?: boolean) {
  suggestionReflectApply(suggestionRemoveEventListener, target, ["click", listener, options]);
}

function addSuggestionWindowClickListener(target: Window, listener: EventListener, options?: boolean): boolean {
  const intrinsic = target === suggestionGlobalWindow ? suggestionWindowAddEventListener : suggestionAddEventListener;
  if (!intrinsic) return false;
  suggestionReflectApply(intrinsic, target, ["click", listener, options]);
  return true;
}

function removeSuggestionWindowClickListener(target: Window, listener: EventListener, options?: boolean) {
  const intrinsic =
    target === suggestionGlobalWindow ? suggestionWindowRemoveEventListener : suggestionRemoveEventListener;
  if (!intrinsic) return;
  suggestionReflectApply(intrinsic, target, ["click", listener, options]);
}

type SuggestionActionKind = "accept" | "reject";

interface SuggestionActionAuthority {
  readonly mount: symbol;
  readonly state: CommentSuggestionState;
  readonly canAccept: boolean;
  readonly canReject: boolean;
  readonly disabled: boolean;
  readonly onAccept: () => void | Promise<void> | boolean;
  readonly onReject: () => void | Promise<unknown> | boolean;
  readonly order: readonly SuggestionActionKind[];
  readonly presentation: SuggestionActionPresentation;
  readonly batch: SuggestionBatchAuthority | null;
}

interface SuggestionActionButtonPresentation {
  readonly className: string;
  readonly testId: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly title: string | null;
  readonly ariaLabel: string | null;
}

interface SuggestionActionPresentation {
  readonly rootClassName: string;
  readonly rootTestId: string;
  readonly accept: SuggestionActionButtonPresentation | null;
  readonly reject: SuggestionActionButtonPresentation | null;
}

interface SuggestionActionElements {
  readonly root: HTMLDivElement;
  readonly accept: HTMLButtonElement | null;
  readonly reject: HTMLButtonElement | null;
  readonly buttons: readonly HTMLButtonElement[];
}

interface SuggestionActionDefinition {
  readonly identity: symbol;
  readonly renderIdentity: symbol;
  readonly kind: SuggestionActionKind;
  readonly enabled: boolean;
  readonly callback: () => void | Promise<unknown> | boolean;
  readonly capture: (element: HTMLButtonElement | null) => void;
  readonly onClickCapture: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

interface SuggestionActionRender {
  readonly identity: symbol;
  readonly authority: SuggestionActionAuthority;
  readonly accept: SuggestionActionDefinition | null;
  readonly reject: SuggestionActionDefinition | null;
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly onRootClickCapture: (event: MouseEvent<HTMLDivElement>) => void;
  readonly onRootClick: (event: MouseEvent<HTMLDivElement>) => void;
  readonly captureAccept: ((element: HTMLButtonElement | null) => void) | null;
  readonly onAcceptCapture: ((event: MouseEvent<HTMLButtonElement>) => void) | null;
  readonly onAccept: ((event: MouseEvent<HTMLButtonElement>) => void) | null;
  readonly captureReject: ((element: HTMLButtonElement | null) => void) | null;
  readonly onRejectCapture: ((event: MouseEvent<HTMLButtonElement>) => void) | null;
  readonly onReject: ((event: MouseEvent<HTMLButtonElement>) => void) | null;
  readonly establish: () => void | (() => void);
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
}

interface SuggestionActionDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly SuggestionActionDomSnapshot[];
}

interface SuggestionActionNodePlacement {
  readonly node: Node;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface SuggestionActionPlacement {
  readonly document: Document;
  readonly chain: readonly SuggestionActionNodePlacement[];
}

interface SuggestionActionPublication {
  readonly identity: symbol;
  readonly render: SuggestionActionRender;
  readonly authority: SuggestionActionAuthority;
  readonly elements: SuggestionActionElements;
  readonly ownerDocument: Document;
  readonly dom: SuggestionActionDomSnapshot;
  readonly placement: SuggestionActionPlacement;
}

interface SuggestionActionCells {
  readonly active: { current: SuggestionActionPublication | null };
  readonly successorOf: { current: SuggestionActionPublication | null };
  readonly replay: { current: SuggestionActionReplay | null };
  readonly retired: WeakSet<SuggestionActionPublication>;
  readonly claimedPublications: WeakSet<SuggestionActionPublication>;
  readonly claimedActions: WeakSet<SuggestionActionDefinition>;
  readonly claimedReactEvents: WeakSet<object>;
}

interface SuggestionActionElementOwnerView {
  readonly element: () => HTMLElement | null;
}

interface SuggestionActionRefReplay {
  readonly owner: SuggestionActionElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
  handoffDetached: boolean;
}

interface SuggestionActionReplay {
  readonly source: SuggestionActionPublication;
  readonly dom: SuggestionActionDomSnapshot;
  readonly placement: SuggestionActionPlacement;
  readonly historyIsClean: () => boolean;
  readonly refsAreExact: () => boolean;
  readonly release: () => void;
}

interface SuggestionActionDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface SuggestionNativeSnapshot {
  readonly event: globalThis.MouseEvent;
  readonly publication: SuggestionActionPublication;
  readonly action: SuggestionActionDefinition | null;
  readonly button: HTMLButtonElement | null;
  readonly target: Node;
  readonly path: readonly EventTarget[];
  readonly type: string;
  readonly buttonValue: number;
  readonly buttons: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly composed: boolean;
  readonly detail: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly screenX: number;
  readonly screenY: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly relatedTarget: EventTarget | null;
  readonly view: Window | null;
  readonly timeStamp: number;
}

interface SuggestionNativeDelivery {
  readonly snapshot: SuggestionNativeSnapshot;
  delegationTarget: EventTarget | null;
  crossedRoot: boolean;
  captureInvalid: boolean;
  captureEvent: object | null;
  captureAction: SuggestionActionDefinition | null;
  captureRootCount: number;
  captureActionCount: number;
  bubbleInvalid: boolean;
  bubbleEvent: object | null;
  bubbleAction: SuggestionActionDefinition | null;
  bubbleActionCount: number;
  bubbleRootCount: number;
  bubbleDelivery: SuggestionReactDelivery | null;
}

interface SuggestionReactDelivery {
  readonly publication: SuggestionActionPublication;
  readonly action: SuggestionActionDefinition;
  readonly event: object;
  readonly native: SuggestionNativeDelivery;
  readonly target: EventTarget;
  readonly type: string;
  readonly button: number;
  readonly buttons: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
}

interface SuggestionActionPublicationRuntime {
  readonly publication: SuggestionActionPublication;
  readonly publish: (owners: readonly SuggestionActionElementOwnerView[]) => boolean;
  readonly stageCaptureRoot: (event: MouseEvent<HTMLDivElement>) => void;
  readonly stageCaptureAction: (action: SuggestionActionDefinition, event: MouseEvent<HTMLButtonElement>) => void;
  readonly stageBubbleAction: (action: SuggestionActionDefinition, event: MouseEvent<HTMLButtonElement>) => void;
  readonly stageBubbleRoot: (event: MouseEvent<HTMLDivElement>) => void;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly retireForAction: () => void;
  readonly noteRef: (owner: SuggestionActionElementOwnerView, element: HTMLElement | null, previous: HTMLElement | null) => void;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly stageSuccessorHandoff: () => boolean;
  readonly successorHandoffIsExact: () => boolean;
  readonly mutationHistoryIsClean: () => boolean;
  readonly release: () => void;
}

class SuggestionActionElementOwner<T extends HTMLElement> implements SuggestionActionElementOwnerView {
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: SuggestionActionElementOwnerView,
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

function suggestionActionSnapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotSuggestionActionDom(node: Node): SuggestionActionDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: suggestionActionSnapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotSuggestionActionDom)),
  });
}

function suggestionActionDomMatches(snapshot: SuggestionActionDomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = suggestionActionSnapshotAttributes(node);
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
  return (
    node.childNodes.length === snapshot.children.length &&
    snapshot.children.every((child, index) => node.childNodes.item(index) === child.node && suggestionActionDomMatches(child))
  );
}

function suggestionActionDomContains(snapshot: SuggestionActionDomSnapshot, target: Node): boolean {
  return snapshot.node === target || snapshot.children.some((child) => suggestionActionDomContains(child, target));
}

function captureSuggestionActionPlacement(root: HTMLDivElement): SuggestionActionPlacement | null {
  const document = root.ownerDocument;
  if (!root.isConnected) return null;
  const chain: SuggestionActionNodePlacement[] = [];
  let node: Node = root;
  while (node !== document) {
    const parent = node.parentNode;
    if (!parent) return null;
    chain.push(
      Object.freeze({
        node,
        parent,
        previousSibling: node.previousSibling,
        nextSibling: node.nextSibling,
      }),
    );
    node = parent;
  }
  return Object.freeze({ document, chain: Object.freeze(chain) });
}

function suggestionActionPlacementMatches(root: HTMLDivElement, placement: SuggestionActionPlacement): boolean {
  return (
    root.ownerDocument === placement.document &&
    root.isConnected &&
    placement.chain.length > 0 &&
    placement.chain[0]?.node === root &&
    placement.chain.every(
      ({ node, parent, previousSibling, nextSibling }) =>
        node.parentNode === parent &&
        node.previousSibling === previousSibling &&
        node.nextSibling === nextSibling,
    )
  );
}

function suggestionActionPlacementMutationIsRelevant(record: MutationRecord, placement: SuggestionActionPlacement): boolean {
  if (record.type !== "childList") {
    return placement.chain.some(({ node }) => record.target === node);
  }
  return placement.chain.some(({ node, parent }) => {
    if (record.target !== parent) return false;
    return (
      record.previousSibling === node ||
      record.nextSibling === node ||
      [...record.addedNodes].some((changed) => changed === node) ||
      [...record.removedNodes].some((changed) => changed === node)
    );
  });
}

function createSuggestionActionDomGuard(
  root: HTMLDivElement,
  dom: SuggestionActionDomSnapshot,
  placement: SuggestionActionPlacement,
  onChange: () => void,
): SuggestionActionDomGuard | null {
  const MutationObserverConstructor = placement.document.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    const nextChanged = records.some(
      (record) =>
        suggestionActionDomContains(dom, record.target) ||
        suggestionActionPlacementMutationIsRelevant(record, placement),
    );
    if (nextChanged) {
      changed = true;
      onChange();
    }
  };
  const observer = new MutationObserverConstructor(recordChanges);
  observer.observe(placement.document, {
    attributes: true,
    attributeOldValue: true,
    characterData: true,
    characterDataOldValue: true,
    childList: true,
    subtree: true,
  });
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

function suggestionActionControlIsEnabled(control: HTMLButtonElement): boolean {
  if (control.disabled || control.matches(":disabled") || control.getAttribute("aria-disabled")?.toLowerCase() === "true") return false;
  for (let element: HTMLElement | null = control; element; element = element.parentElement) {
    if (element.hasAttribute("inert") || element.getAttribute("aria-disabled")?.toLowerCase() === "true") return false;
  }
  return true;
}

function suggestionActionButtonPresentationsMatch(
  previous: SuggestionActionButtonPresentation | null,
  current: SuggestionActionButtonPresentation | null,
): boolean {
  return (
    previous === current ||
    (!!previous &&
      !!current &&
      previous.className === current.className &&
      previous.testId === current.testId &&
      previous.label === current.label &&
      previous.disabled === current.disabled &&
      previous.busy === current.busy &&
      previous.title === current.title &&
      previous.ariaLabel === current.ariaLabel)
  );
}

function suggestionActionPresentationsMatch(
  previous: SuggestionActionPresentation,
  current: SuggestionActionPresentation,
): boolean {
  return (
    previous === current ||
    (previous.rootClassName === current.rootClassName &&
      previous.rootTestId === current.rootTestId &&
      suggestionActionButtonPresentationsMatch(previous.accept, current.accept) &&
      suggestionActionButtonPresentationsMatch(previous.reject, current.reject))
  );
}

function suggestionActionAuthoritiesMatch(previous: SuggestionActionAuthority, current: SuggestionActionAuthority): boolean {
  return (
    previous.mount === current.mount &&
    previous.state === current.state &&
    previous.canAccept === current.canAccept &&
    previous.canReject === current.canReject &&
    previous.disabled === current.disabled &&
    previous.onAccept === current.onAccept &&
    previous.onReject === current.onReject &&
    previous.order.length === current.order.length &&
    previous.order.every((kind, index) => kind === current.order[index]) &&
    suggestionActionPresentationsMatch(previous.presentation, current.presentation) &&
    suggestionBatchAuthoritiesMatch(previous.batch, current.batch)
  );
}

function exactSuggestionActionDomIsCurrent(publication: SuggestionActionPublication): boolean {
  const { authority, elements, ownerDocument } = publication;
  const { root, accept, reject, buttons } = elements;
  const { presentation } = authority;
  if (
    !root.isConnected ||
    root.ownerDocument !== ownerDocument ||
    root.tagName !== "DIV" ||
    root.className !== presentation.rootClassName ||
    root.dataset.testid !== presentation.rootTestId ||
    root.children.length !== authority.order.length ||
    buttons.length !== authority.order.length ||
    (!!presentation.accept !== !!accept) ||
    (!!presentation.reject !== !!reject)
  ) {
    return false;
  }
  return authority.order.every((kind, index) => {
    const button = buttons[index];
    const expected = kind === "accept" ? accept : reject;
    const expectedPresentation = kind === "accept" ? presentation.accept : presentation.reject;
    return (
      !!button &&
      !!expectedPresentation &&
      button === expected &&
      root.children.item(index) === button &&
      button.isConnected &&
      button.ownerDocument === ownerDocument &&
      button.parentElement === root &&
      button.tagName === "BUTTON" &&
      button.type === "button" &&
      button.disabled === expectedPresentation.disabled &&
      button.className === expectedPresentation.className &&
      button.dataset.testid === expectedPresentation.testId &&
      button.textContent?.trim() === expectedPresentation.label &&
      button.title === (expectedPresentation.title ?? "") &&
      button.getAttribute("aria-label") === expectedPresentation.ariaLabel &&
      button.getAttribute("aria-busy") === (expectedPresentation.busy ? "true" : null) &&
      (expectedPresentation.disabled || suggestionActionControlIsEnabled(button))
    );
  });
}

function suggestionNativeSnapshotFieldsMatch(delivery: SuggestionNativeDelivery): boolean {
  const { snapshot } = delivery;
  const { event, publication, target } = snapshot;
  const ownerWindow = publication.ownerDocument.defaultView;
  if (
    !ownerWindow ||
    !(event instanceof ownerWindow.MouseEvent) ||
    event.type !== snapshot.type ||
    event.button !== snapshot.buttonValue ||
    event.buttons !== snapshot.buttons ||
    event.bubbles !== snapshot.bubbles ||
    event.cancelable !== snapshot.cancelable ||
    event.composed !== snapshot.composed ||
    event.detail !== snapshot.detail ||
    event.clientX !== snapshot.clientX ||
    event.clientY !== snapshot.clientY ||
    event.screenX !== snapshot.screenX ||
    event.screenY !== snapshot.screenY ||
    event.ctrlKey !== snapshot.ctrlKey ||
    event.shiftKey !== snapshot.shiftKey ||
    event.altKey !== snapshot.altKey ||
    event.metaKey !== snapshot.metaKey ||
    event.relatedTarget !== snapshot.relatedTarget ||
    event.view !== snapshot.view ||
    event.timeStamp !== snapshot.timeStamp ||
    suggestionNativeTarget(event) !== target ||
    suggestionNativeDefaultPrevented(event)
  ) {
    return false;
  }
  return true;
}

function suggestionNativeSnapshotMatches(delivery: SuggestionNativeDelivery): boolean {
  const { event, publication, path } = delivery.snapshot;
  const ownerWindow = publication.ownerDocument.defaultView;
  if (!ownerWindow || event.eventPhase === ownerWindow.Event.NONE || !suggestionNativeSnapshotFieldsMatch(delivery)) {
    return false;
  }
  const currentPath = suggestionNativeComposedPath(event);
  return currentPath.length === path.length && path.every((entry, index) => currentPath[index] === entry);
}

function createSuggestionActionRender(
  authority: SuggestionActionAuthority,
  cells: SuggestionActionCells,
  requestSuccessor: () => void,
): SuggestionActionRender {
  const render = {} as SuggestionActionRender;
  const identity = Symbol("suggestion-action-render");
  let currentRuntime: SuggestionActionPublicationRuntime | null = null;
  let lastRuntime: SuggestionActionPublicationRuntime | null = null;
  let successorRequested = false;
  let renderRetired = false;
  let invalidBeforeEstablish = false;
  const buttonOwners: SuggestionActionElementOwner<HTMLButtonElement>[] = [];

  const acceptsSuccessorOf = (publication: SuggestionActionPublication) =>
    cells.active.current === null &&
    cells.successorOf.current === publication &&
    cells.retired.has(publication) &&
    publication.render.isRetired() &&
    !cells.claimedPublications.has(publication);

  const requestReplaySuccessor = (runtime: SuggestionActionPublicationRuntime) => {
    const { publication } = runtime;
    if (
      successorRequested ||
      cells.replay.current !== null ||
      !acceptsSuccessorOf(publication) ||
      !suggestionActionAuthoritiesMatch(publication.authority, authority) ||
      !suggestionActionAuthorityFactsAreCurrent(authority) ||
      !exactSuggestionActionDomIsCurrent(publication) ||
      !runtime.publishedDomMatches() ||
      !runtime.stageSuccessorHandoff()
    ) {
      return;
    }
    successorRequested = true;
    cells.replay.current = Object.freeze({
      source: publication,
      dom: publication.dom,
      placement: publication.placement,
      historyIsClean: runtime.mutationHistoryIsClean,
      refsAreExact: runtime.successorHandoffIsExact,
      release: runtime.release,
    });
    requestSuccessor();
  };

  const onElementChange = (
    owner: SuggestionActionElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null || (last !== null && element !== last)) {
      if (currentRuntime) currentRuntime.retireForElement();
      else if (!lastRuntime) {
        renderRetired = true;
        invalidBeforeEstablish = true;
      }
    }
    if (runtime?.isExactElementReplay() && acceptsSuccessorOf(runtime.publication)) requestReplaySuccessor(runtime);
  };

  const rootOwner = new SuggestionActionElementOwner<HTMLDivElement>(onElementChange);

  const committedElements = (): SuggestionActionElements | null => {
    const root = rootOwner.element();
    const buttons = buttonOwners.map((owner) => owner.element());
    if (!root || buttons.some((button) => button === null)) return null;
    const committed = buttons as HTMLButtonElement[];
    const acceptIndex = authority.order.indexOf("accept");
    const rejectIndex = authority.order.indexOf("reject");
    return Object.freeze({
      root,
      accept: acceptIndex === -1 ? null : committed[acceptIndex]!,
      reject: rejectIndex === -1 ? null : committed[rejectIndex]!,
      buttons: Object.freeze(committed),
    });
  };

  const expectedOwners = (): readonly SuggestionActionElementOwnerView[] => [rootOwner, ...buttonOwners];

  const createRuntime = (
    publication: SuggestionActionPublication,
    replayOwners: ReadonlySet<SuggestionActionElementOwnerView>,
  ): SuggestionActionPublicationRuntime => {
    type Retirement = "element" | "layout" | "action";
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let invalidReplay = false;
    let successorStaged = false;
    let released = false;
    let replayRefs: SuggestionActionRefReplay[] = [];
    let domGuard: SuggestionActionDomGuard | null = null;
    const nativeDeliveries = new WeakMap<globalThis.MouseEvent, SuggestionNativeDelivery>();
    const nativeBubbleTargets = new Set<EventTarget>();

    const removeListeners = () => {
      const ownerWindow = publication.ownerDocument.defaultView;
      if (ownerWindow) removeSuggestionWindowClickListener(ownerWindow, captureNative, true);
      removeSuggestionClickListener(publication.elements.root, crossNativeRoot);
      for (const target of nativeBubbleTargets) removeSuggestionClickListener(target, finalizeNative);
      nativeBubbleTargets.clear();
    };
    const release = () => {
      if (released) return;
      released = true;
      removeListeners();
      domGuard?.release();
    };
    const retire = (reason: Retirement) => {
      if (renderRetired) return false;
      renderRetired = true;
      retirement = reason;
      cells.retired.add(publication);
      removeListeners();
      if (cells.active.current === publication) {
        cells.active.current = null;
        cells.successorOf.current = publication;
      }
      if (currentRuntime?.publication === publication) currentRuntime = null;
      queueMicrotask(() => {
        if (cells.replay.current?.source !== publication) release();
      });
      return true;
    };
    const refsHaveNoReplay = () =>
      !invalidReplay &&
      replayRefs.every((entry) => !entry.detached && !entry.reattached && entry.owner.element() === entry.element);
    const refsHaveExactReplay = () =>
      !invalidReplay &&
      replayRefs.length > 0 &&
      replayRefs.every((entry) => entry.detached && entry.reattached && entry.owner.element() === entry.element);
    const refsHaveExactMountedReplay = () =>
      !invalidReplay &&
      replayOwners.size > 0 &&
      replayRefs.every((entry) =>
        replayOwners.has(entry.owner)
          ? entry.detached && entry.reattached && entry.owner.element() === entry.element
          : !entry.detached && !entry.reattached && entry.owner.element() === entry.element,
      );
    const publishedDomMatches = () =>
      Boolean(
        domGuard &&
        domGuard.isClean() &&
        publication.elements.root === publication.dom.node &&
        suggestionActionPlacementMatches(publication.elements.root, publication.placement) &&
        suggestionActionDomMatches(publication.dom),
      );
    const retireAndRequestSuccessor = () => {
      if (
        renderRetired ||
        cells.active.current !== publication ||
        cells.claimedPublications.has(publication)
      ) {
        return;
      }
      retire("action");
      if (successorRequested) return;
      successorRequested = true;
      flushSync(requestSuccessor);
    };
    const publicationIsCurrent = () => {
      if (
        renderRetired ||
        cells.active.current !== publication ||
        cells.retired.has(publication) ||
        publication.render !== render ||
        publication.authority !== authority
      ) {
        return false;
      }
      if (!suggestionActionAuthorityFactsAreCurrent(authority)) {
        retireAndRequestSuccessor();
        return false;
      }
      return exactSuggestionActionDomIsCurrent(publication) && publishedDomMatches();
    };
    const retireForMutation = () => {
      retireAndRequestSuccessor();
    };

    function captureNative(event: Event) {
      const ownerWindow = publication.ownerDocument.defaultView;
      if (
        !ownerWindow ||
        !(event instanceof ownerWindow.MouseEvent) ||
        event.type !== "click" ||
        event.button !== 0 ||
        !event.bubbles ||
        suggestionNativeDefaultPrevented(event) ||
        event.eventPhase === ownerWindow.Event.NONE
      ) {
        return;
      }
      const target = suggestionNativeTarget(event);
      const NodeConstructor = ownerWindow.Node;
      if (!(target instanceof NodeConstructor) || target.ownerDocument !== publication.ownerDocument) return;
      const path = suggestionNativeComposedPath(event);
      if (!path.includes(publication.elements.root)) return;
      if (authority.batch) {
        if (seenSuggestionNativeEvents.has(event)) return;
        seenSuggestionNativeEvents.add(event);
      }
      if (!publicationIsCurrent()) return;
      const action =
        publication.elements.buttons
          .map((button, index) => ({ button, action: authority.order[index] === "accept" ? render.accept : render.reject }))
          .find(({ button }) => button.contains(target) && path.includes(button)) ?? null;
      const snapshot: SuggestionNativeSnapshot = Object.freeze({
        event,
        publication,
        action: action?.action ?? null,
        button: action?.button ?? null,
        target,
        path: Object.freeze([...path]),
        type: event.type,
        buttonValue: event.button,
        buttons: event.buttons,
        bubbles: event.bubbles,
        cancelable: event.cancelable,
        composed: event.composed,
        detail: event.detail,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        relatedTarget: event.relatedTarget,
        view: event.view,
        timeStamp: event.timeStamp,
      });
      const delivery: SuggestionNativeDelivery = {
        snapshot,
        delegationTarget: null,
        crossedRoot: false,
        captureInvalid: false,
        captureEvent: null,
        captureAction: null,
        captureRootCount: 0,
        captureActionCount: 0,
        bubbleInvalid: false,
        bubbleEvent: null,
        bubbleAction: null,
        bubbleActionCount: 0,
        bubbleRootCount: 0,
        bubbleDelivery: null,
      };
      nativeDeliveries.set(event, delivery);
      queueMicrotask(() => {
        queueMicrotask(() => {
          if (nativeDeliveries.get(event) === delivery) nativeDeliveries.delete(event);
        });
      });
    }

    function crossNativeRoot(event: Event) {
      const ownerWindow = publication.ownerDocument.defaultView;
      if (!ownerWindow || !(event instanceof ownerWindow.MouseEvent)) return;
      const delivery = nativeDeliveries.get(event);
      if (
        !delivery ||
        delivery.snapshot.publication !== publication ||
        suggestionNativeCurrentTarget(event) !== publication.elements.root ||
        !suggestionNativeSnapshotMatches(delivery)
      ) {
        return;
      }
      delivery.crossedRoot = true;
      if (
        delivery.captureInvalid ||
        delivery.captureRootCount !== 1 ||
        delivery.captureActionCount !== 1 ||
        !delivery.captureEvent ||
        !delivery.captureAction ||
        delivery.snapshot.action !== delivery.captureAction ||
        delivery.snapshot.button !==
          (delivery.captureAction.kind === "accept"
            ? publication.elements.accept
            : publication.elements.reject)
      ) {
        delivery.captureInvalid = true;
      }
    }

    const nativeDelivery = (
      event: MouseEvent<HTMLElement>,
      currentTarget: HTMLElement,
      requireRootCrossing: boolean,
    ): SuggestionNativeDelivery | null => {
      if (!event || typeof event !== "object") return null;
      const ownerWindow = publication.ownerDocument.defaultView;
      const nativeEvent = event.nativeEvent;
      if (!ownerWindow || !(nativeEvent instanceof ownerWindow.MouseEvent)) return null;
      const delivery = nativeDeliveries.get(nativeEvent);
      if (
        !delivery ||
        (requireRootCrossing && !delivery.crossedRoot) ||
        delivery.snapshot.publication !== publication ||
        event.nativeEvent !== delivery.snapshot.event ||
        event.type !== "click" ||
        event.button !== 0 ||
        !event.bubbles ||
        event.defaultPrevented ||
        event.currentTarget !== currentTarget ||
        event.target !== delivery.snapshot.target ||
        suggestionNativeTarget(nativeEvent) !== event.target ||
        !suggestionNativeSnapshotMatches(delivery)
      ) {
        return null;
      }
      return delivery;
    };

    const stageCaptureRoot = (event: MouseEvent<HTMLDivElement>) => {
      const delivery = nativeDelivery(event, publication.elements.root, false);
      if (
        !delivery ||
        delivery.crossedRoot ||
        cells.claimedPublications.has(publication) ||
        cells.claimedReactEvents.has(event) ||
        claimedSuggestionNativeEvents.has(delivery.snapshot.event) ||
        !publicationIsCurrent()
      ) {
        return;
      }
      delivery.captureRootCount += 1;
      if (delivery.captureRootCount !== 1 || (delivery.captureEvent && delivery.captureEvent !== event)) {
        delivery.captureInvalid = true;
        return;
      }
      delivery.captureEvent = event;
      const delegationTarget = suggestionNativeCurrentTarget(delivery.snapshot.event);
      if (!delegationTarget || !delivery.snapshot.path.includes(delegationTarget)) {
        delivery.captureInvalid = true;
        return;
      }
      delivery.delegationTarget = delegationTarget;
      if (!nativeBubbleTargets.has(delegationTarget)) {
        addSuggestionClickListener(delegationTarget, finalizeNative);
        nativeBubbleTargets.add(delegationTarget);
      }
    };

    const stageCaptureAction = (action: SuggestionActionDefinition, event: MouseEvent<HTMLButtonElement>) => {
      const button = action.kind === "accept" ? publication.elements.accept : publication.elements.reject;
      const delivery = button ? nativeDelivery(event, button, false) : null;
      if (
        !delivery ||
        delivery.crossedRoot ||
        !button ||
        action.renderIdentity !== identity ||
        (action.kind === "accept" ? render.accept : render.reject) !== action ||
        !action.enabled ||
        !suggestionActionControlIsEnabled(button) ||
        cells.claimedPublications.has(publication) ||
        cells.claimedActions.has(action) ||
        cells.claimedReactEvents.has(event) ||
        claimedSuggestionNativeEvents.has(delivery.snapshot.event) ||
        !publicationIsCurrent()
      ) {
        return;
      }
      delivery.captureActionCount += 1;
      if (
        delivery.captureActionCount !== 1 ||
        delivery.captureRootCount !== 1 ||
        delivery.captureEvent !== event ||
        delivery.delegationTarget !== suggestionNativeCurrentTarget(delivery.snapshot.event) ||
        (delivery.captureAction && delivery.captureAction !== action) ||
        delivery.snapshot.action !== action ||
        delivery.snapshot.button !== button ||
        !button.contains(delivery.snapshot.target)
      ) {
        delivery.captureInvalid = true;
        return;
      }
      delivery.captureAction = action;
    };

    const stageBubbleAction = (action: SuggestionActionDefinition, event: MouseEvent<HTMLButtonElement>) => {
      const button = action.kind === "accept" ? publication.elements.accept : publication.elements.reject;
      const delivery = button ? nativeDelivery(event, button, true) : null;
      if (delivery && delivery.delegationTarget !== suggestionNativeCurrentTarget(delivery.snapshot.event)) {
        delivery.bubbleInvalid = true;
        return;
      }
      if (
        !delivery ||
        delivery.captureInvalid ||
        !button ||
        action.renderIdentity !== identity ||
        (action.kind === "accept" ? render.accept : render.reject) !== action ||
        delivery.captureAction !== action ||
        delivery.snapshot.action !== action ||
        delivery.snapshot.button !== button ||
        !button.contains(delivery.snapshot.target) ||
        !action.enabled ||
        !suggestionActionControlIsEnabled(button) ||
        cells.claimedPublications.has(publication) ||
        cells.claimedActions.has(action) ||
        cells.claimedReactEvents.has(event) ||
        claimedSuggestionNativeEvents.has(delivery.snapshot.event) ||
        !publicationIsCurrent()
      ) {
        return;
      }
      delivery.bubbleActionCount += 1;
      if (
        delivery.bubbleActionCount !== 1 ||
        (delivery.bubbleEvent && delivery.bubbleEvent !== event) ||
        (delivery.bubbleAction && delivery.bubbleAction !== action)
      ) {
        delivery.bubbleInvalid = true;
        return;
      }
      delivery.bubbleEvent = event;
      delivery.bubbleAction = action;
      delivery.bubbleDelivery = Object.freeze({
        publication,
        action,
        event,
        native: delivery,
        target: event.target,
        type: event.type,
        button: event.button,
        buttons: event.buttons,
        bubbles: event.bubbles,
        cancelable: event.cancelable,
      });
    };

    const stageBubbleRoot = (event: MouseEvent<HTMLDivElement>) => {
      const delivery = nativeDelivery(event, publication.elements.root, true);
      if (!delivery || !publicationIsCurrent()) return;
      delivery.bubbleRootCount += 1;
      if (
        delivery.bubbleRootCount !== 1 ||
        delivery.bubbleInvalid ||
        delivery.delegationTarget !== suggestionNativeCurrentTarget(delivery.snapshot.event) ||
        delivery.bubbleEvent !== event ||
        delivery.captureEvent === event ||
        !delivery.bubbleAction ||
        !delivery.bubbleDelivery
      ) {
        delivery.bubbleInvalid = true;
        return;
      }
    };

    function finalizeNative(event: Event) {
      const ownerWindow = publication.ownerDocument.defaultView;
      if (!ownerWindow || !(event instanceof ownerWindow.MouseEvent)) {
        return;
      }
      const delivery = nativeDeliveries.get(event);
      if (
        !delivery ||
        delivery.snapshot.publication !== publication ||
        suggestionNativeCurrentTarget(event) !== delivery.delegationTarget
      ) {
        return;
      }
      const pending = delivery.bubbleDelivery;
      if (!pending) return;
      const { action } = pending;
      const button = action.kind === "accept" ? publication.elements.accept : publication.elements.reject;
      if (
        delivery.captureInvalid ||
        delivery.bubbleInvalid ||
        delivery.captureRootCount !== 1 ||
        delivery.captureActionCount !== 1 ||
        delivery.bubbleActionCount !== 1 ||
        delivery.bubbleRootCount !== 1 ||
        delivery.captureAction !== action ||
        delivery.bubbleAction !== action ||
        pending.publication !== publication ||
        pending.event !== delivery.bubbleEvent ||
        pending.native !== delivery ||
        pending.target !== delivery.snapshot.target ||
        pending.type !== delivery.snapshot.type ||
        pending.button !== delivery.snapshot.buttonValue ||
        pending.buttons !== delivery.snapshot.buttons ||
        pending.bubbles !== delivery.snapshot.bubbles ||
        pending.cancelable !== delivery.snapshot.cancelable ||
        !suggestionNativeSnapshotMatches(delivery) ||
        delivery.snapshot.action !== action ||
        delivery.snapshot.button !== button ||
        !button ||
        !button.contains(delivery.snapshot.target) ||
        !action.enabled ||
        !suggestionActionControlIsEnabled(button) ||
        cells.claimedPublications.has(publication) ||
        cells.claimedActions.has(action) ||
        !delivery.captureEvent ||
        cells.claimedReactEvents.has(delivery.captureEvent) ||
        !delivery.bubbleEvent ||
        cells.claimedReactEvents.has(delivery.bubbleEvent) ||
        claimedSuggestionNativeEvents.has(delivery.snapshot.event) ||
        !publicationIsCurrent()
      ) {
        return;
      }
      cells.claimedPublications.add(publication);
      cells.claimedActions.add(action);
      cells.claimedReactEvents.add(delivery.captureEvent);
      cells.claimedReactEvents.add(delivery.bubbleEvent);
      claimedSuggestionNativeEvents.add(delivery.snapshot.event);
      nativeDeliveries.delete(delivery.snapshot.event);
      event.stopPropagation();
      const accepted = action.callback();
      if (accepted === false) {
        cells.claimedPublications.delete(publication);
        cells.claimedActions.delete(action);
        cells.claimedReactEvents.delete(delivery.captureEvent);
        cells.claimedReactEvents.delete(delivery.bubbleEvent);
        claimedSuggestionNativeEvents.delete(delivery.snapshot.event);
        return;
      }
      void accepted;
    }

    const runtime: SuggestionActionPublicationRuntime = Object.freeze({
      publication,
      publish: (owners: readonly SuggestionActionElementOwnerView[]) => {
        if (renderRetired || established) return false;
        domGuard = createSuggestionActionDomGuard(
          publication.elements.root,
          publication.dom,
          publication.placement,
          retireForMutation,
        );
        if (!domGuard) return false;
        replayRefs = owners.map((owner) => {
          const element = owner.element();
          if (!element) throw new Error("Cannot publish suggestion actions without every committed ref");
          return { owner, element, detached: false, reattached: false, handoffDetached: false };
        });
        const ownerWindow = publication.ownerDocument.defaultView;
        if (!ownerWindow || !addSuggestionWindowClickListener(ownerWindow, captureNative, true)) return false;
        addSuggestionClickListener(publication.elements.root, crossNativeRoot);
        established = true;
        cells.active.current = publication;
        cells.successorOf.current = null;
        cells.replay.current = null;
        return true;
      },
      stageCaptureRoot,
      stageCaptureAction,
      stageBubbleAction,
      stageBubbleRoot,
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        layoutRetired = true;
        retire("layout");
      },
      retireForAction: () => {
        retire("action");
      },
      noteRef: (owner: SuggestionActionElementOwnerView, element: HTMLElement | null, previous: HTMLElement | null) => {
        if (!established) return;
        const proof = replayRefs.find((entry) => entry.owner === owner);
        if (!proof) {
          invalidReplay = true;
          return;
        }
        if (successorStaged) {
          if (element === null && previous === proof.element && !proof.handoffDetached) proof.handoffDetached = true;
          else if (element !== previous) invalidReplay = true;
          return;
        }
        if (element === null && previous === proof.element) {
          proof.detached = true;
          proof.reattached = false;
        } else if (element === proof.element && previous === null && proof.detached) {
          proof.reattached = true;
        } else if (element !== previous) {
          invalidReplay = true;
        }
      },
      isRetired: () => renderRetired,
      publishedDomMatches,
      isExactElementReplay: () =>
        renderRetired &&
        retirement === "element" &&
        established &&
        ((layoutRetired && refsHaveExactReplay()) || (!layoutRetired && refsHaveExactMountedReplay())) &&
        publishedDomMatches(),
      isExactLayoutReplay: () =>
        renderRetired &&
        retirement === "layout" &&
        established &&
        (refsHaveNoReplay() || refsHaveExactReplay()) &&
        publishedDomMatches(),
      stageSuccessorHandoff: () => {
        if (successorStaged) return false;
        successorStaged = true;
        return true;
      },
      successorHandoffIsExact: () =>
        successorStaged &&
        !invalidReplay &&
        replayRefs.every((entry) => entry.handoffDetached && entry.owner.element() === null),
      mutationHistoryIsClean: () => domGuard?.isClean() ?? false,
      release,
    });
    return runtime;
  };

  const stageCaptureAction = (action: SuggestionActionDefinition, event: MouseEvent<HTMLButtonElement>) => {
    const runtime = currentRuntime;
    if (!runtime || runtime.isRetired()) return;
    runtime.stageCaptureAction(action, event);
  };

  const stageBubbleAction = (action: SuggestionActionDefinition, event: MouseEvent<HTMLButtonElement>) => {
    const runtime = currentRuntime;
    if (!runtime || runtime.isRetired()) return;
    runtime.stageBubbleAction(action, event);
  };

  const action = (
    kind: SuggestionActionKind,
    enabled: boolean,
    callback: () => void | Promise<unknown> | boolean,
  ): SuggestionActionDefinition => {
    const owner = new SuggestionActionElementOwner<HTMLButtonElement>(onElementChange);
    buttonOwners.push(owner);
    const definition = {} as SuggestionActionDefinition;
    Object.assign(definition, {
      identity: Symbol(`suggestion-${kind}`),
      renderIdentity: identity,
      kind,
      enabled,
      callback,
      capture: owner.capture,
      onClickCapture: (event: MouseEvent<HTMLButtonElement>) => stageCaptureAction(definition, event),
      onClick: (event: MouseEvent<HTMLButtonElement>) => stageBubbleAction(definition, event),
    });
    return Object.freeze(definition);
  };

  const accept = authority.canAccept
    ? action("accept", !authority.presentation.accept!.disabled, authority.onAccept)
    : null;
  const reject = authority.canReject
    ? action("reject", !authority.presentation.reject!.disabled, authority.onReject)
    : null;

  const establish = () => {
    if (lastRuntime) {
      const exactReplay = lastRuntime.isExactLayoutReplay() || lastRuntime.isExactElementReplay();
      if (exactReplay && acceptsSuccessorOf(lastRuntime.publication)) {
        requestReplaySuccessor(lastRuntime);
      } else if (
        lastRuntime.isRetired() &&
        !lastRuntime.mutationHistoryIsClean() &&
        !successorRequested
      ) {
        successorRequested = true;
        const replay = cells.replay.current;
        if (replay?.source === lastRuntime.publication) {
          cells.replay.current = null;
          replay.release();
        } else {
          lastRuntime.release();
        }
        requestSuccessor();
      }
      return undefined;
    }
    if (renderRetired || invalidBeforeEstablish || !suggestionActionAuthorityFactsAreCurrent(authority)) return undefined;
    const elements = committedElements();
    const placement = elements ? captureSuggestionActionPlacement(elements.root) : null;
    if (!elements || !placement) return undefined;
    const publication: SuggestionActionPublication = Object.freeze({
      identity: Symbol("suggestion-action-publication"),
      render,
      authority,
      elements,
      ownerDocument: elements.root.ownerDocument,
      dom: snapshotSuggestionActionDom(elements.root),
      placement,
    });
    if (!exactSuggestionActionDomIsCurrent(publication)) return undefined;

    const replay = cells.replay.current;
    if (replay) {
      const sameAuthority = suggestionActionAuthoritiesMatch(replay.source.authority, authority);
      const exactReplay =
        sameAuthority &&
        replay.source.render.isRetired() &&
        cells.retired.has(replay.source) &&
        cells.successorOf.current === replay.source &&
        replay.refsAreExact() &&
        replay.historyIsClean() &&
        elements.root === replay.dom.node &&
        suggestionActionPlacementMatches(elements.root, replay.placement) &&
        suggestionActionDomMatches(replay.dom);
      cells.replay.current = null;
      replay.release();
      if (cells.successorOf.current === replay.source) cells.successorOf.current = null;
      if (sameAuthority && !exactReplay) {
        renderRetired = true;
        cells.retired.add(publication);
        if (!successorRequested) {
          successorRequested = true;
          requestSuccessor();
        }
        return undefined;
      }
    }

    const previous = cells.active.current;
    if (previous && previous !== publication) previous.render.retire();
    const transitionSource = cells.successorOf.current;
    const owners = expectedOwners();
    const replayOwners = new Set<SuggestionActionElementOwnerView>();
    if (transitionSource?.authority.mount === authority.mount) {
      for (const owner of owners) {
        const element = owner.element();
        if (element && !suggestionActionDomContains(transitionSource.dom, element)) replayOwners.add(owner);
      }
    }
    const runtime = createRuntime(publication, replayOwners);
    currentRuntime = runtime;
    lastRuntime = runtime;
    if (!runtime.publish(owners)) {
      runtime.retireForElement();
      return undefined;
    }
    return runtime.retireForLayout;
  };

  const retire = () => {
    if (renderRetired) return false;
    if (currentRuntime) {
      currentRuntime.retireForAction();
      return true;
    }
    renderRetired = true;
    return true;
  };

  const onRootClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    const runtime = currentRuntime;
    if (!runtime || runtime.isRetired()) return;
    runtime.stageCaptureRoot(event);
  };

  const onRootClick = (event: MouseEvent<HTMLDivElement>) => {
    const runtime = currentRuntime;
    if (!runtime || runtime.isRetired()) return;
    runtime.stageBubbleRoot(event);
  };

  Object.assign(render, {
    identity,
    authority,
    accept,
    reject,
    captureRoot: rootOwner.capture,
    onRootClickCapture,
    onRootClick,
    captureAccept: accept?.capture ?? null,
    onAcceptCapture: accept?.onClickCapture ?? null,
    onAccept: accept?.onClick ?? null,
    captureReject: reject?.capture ?? null,
    onRejectCapture: reject?.onClickCapture ?? null,
    onReject: reject?.onClick ?? null,
    establish,
    retire,
    isRetired: () => renderRetired,
  });
  return Object.freeze(render);
}

function PublishedSuggestionActions({
  state,
  canAccept,
  canReject,
  disabled = false,
  onAccept,
  onReject,
  presentation: suppliedPresentation,
  batch = null,
}: {
  state: CommentSuggestionState;
  canAccept: boolean;
  canReject: boolean;
  disabled?: boolean;
  onAccept: () => void | Promise<void> | boolean;
  onReject: () => void | Promise<unknown> | boolean;
  presentation?: SuggestionActionPresentation;
  batch?: SuggestionBatchAuthority | null;
}) {
  const [mount] = useState(() => Symbol("suggestion-actions"));
  const [cells] = useState<SuggestionActionCells>(() => ({
    active: { current: null },
    successorOf: { current: null },
    replay: { current: null },
    retired: new WeakSet<SuggestionActionPublication>(),
    claimedPublications: new WeakSet<SuggestionActionPublication>(),
    claimedActions: new WeakSet<SuggestionActionDefinition>(),
    claimedReactEvents: new WeakSet<object>(),
  }));
  const replayCleanup = useRef(0);
  useLayoutEffect(() => {
    replayCleanup.current += 1;
    return () => {
      replayCleanup.current += 1;
      const cleanup = replayCleanup.current;
      queueMicrotask(() => {
        if (replayCleanup.current !== cleanup) return;
        const replay = cells.replay.current;
        if (!replay) return;
        cells.replay.current = null;
        if (cells.successorOf.current === replay.source) cells.successorOf.current = null;
        replay.release();
      });
    };
  }, [cells]);
  const [, setPublicationRevision] = useState(0);
  const requestSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const presentation =
    suppliedPresentation ??
    Object.freeze({
      rootClassName: SUGGESTION_ACTIONS_CLASS,
      rootTestId: "suggestion-actions",
      accept: canAccept
        ? Object.freeze({
            className: SUGGESTION_ACCEPT_CLASS,
            testId: "suggestion-accept-comment",
            label: "Accept suggestion",
            disabled: disabled || state === "outdated",
            busy: false,
            title: null,
            ariaLabel: null,
          })
        : null,
      reject: canReject
        ? Object.freeze({
            className: SUGGESTION_REJECT_CLASS,
            testId: "suggestion-reject-comment",
            label: "Reject",
            disabled,
            busy: false,
            title: null,
            ariaLabel: null,
          })
        : null,
    });
  const authority: SuggestionActionAuthority = Object.freeze({
    mount,
    state,
    canAccept,
    canReject,
    disabled,
    onAccept,
    onReject,
    order: Object.freeze([
      ...(canAccept ? (["accept"] as const) : []),
      ...(canReject ? (["reject"] as const) : []),
    ]),
    presentation,
    batch,
  });
  const publication = createSuggestionActionRender(authority, cells, requestSuccessor);
  useLayoutEffect(() => publication.establish(), [publication]);
  const {
    captureRoot,
    onRootClickCapture,
    onRootClick,
    captureAccept,
    onAcceptCapture,
    onAccept: onAcceptClick,
    captureReject,
    onRejectCapture,
    onReject: onRejectClick,
  } = publication;
  const acceptPresentation = presentation.accept;
  const rejectPresentation = presentation.reject;

  return (
    <div ref={captureRoot} className={presentation.rootClassName} onClickCapture={onRootClickCapture} onClick={onRootClick} data-testid={presentation.rootTestId}>
      {canAccept && (
        <button
          ref={captureAccept}
          type="button"
          className={acceptPresentation!.className}
          disabled={acceptPresentation!.disabled}
          aria-busy={acceptPresentation!.busy || undefined}
          aria-label={acceptPresentation!.ariaLabel ?? undefined}
          title={acceptPresentation!.title ?? undefined}
          onClickCapture={onAcceptCapture!}
          onClick={onAcceptClick!}
          data-testid={acceptPresentation!.testId}
        >
          {batch ? acceptPresentation!.label : <><Check size={13} /> {acceptPresentation!.label}</>}
        </button>
      )}
      {canReject && (
        <button
          ref={captureReject}
          type="button"
          className={rejectPresentation!.className}
          disabled={rejectPresentation!.disabled}
          aria-busy={rejectPresentation!.busy || undefined}
          aria-label={rejectPresentation!.ariaLabel ?? undefined}
          title={rejectPresentation!.title ?? undefined}
          onClickCapture={onRejectCapture!}
          onClick={onRejectClick!}
          data-testid={rejectPresentation!.testId}
        >
          {batch ? rejectPresentation!.label : <><X size={13} /> {rejectPresentation!.label}</>}
        </button>
      )}
    </div>
  );
}

function SuggestionActions(props: {
  state: CommentSuggestionState;
  canAccept: boolean;
  canReject: boolean;
  disabled?: boolean;
  onAccept: () => void | Promise<void>;
  onReject: () => void | Promise<unknown>;
}) {
  if ((props.state !== "pending" && props.state !== "outdated") || (!props.canAccept && !props.canReject)) return null;
  return <PublishedSuggestionActions {...props} />;
}

/** Review card author label: token name for agents, display name for humans. */
function verdictTone(verdict: ReviewDto["verdict"]): string {
  return verdict === "approve" ? "text-success" : verdict === "request_changes" ? "text-amber-700 dark:text-amber-300" : "text-ink-2";
}

/** "(edited)" with the edit time as a tooltip. */
function EditedMarker({ at }: { at?: number | null }) {
  if (!at) return null;
  return (
    <span className="shrink-0 text-xs italic text-ink-4" title={`Edited ${new Date(at).toLocaleString()}`} data-testid="comment-edited">
      (edited)
    </span>
  );
}

/**
 * Mounts a Radix Popover/DropdownMenu root only once the user reaches for its trigger. A Radix root is
 * ~20 fibers (Popper, Presence, DismissableLayer, FocusScope…) even while closed; the comments panel has
 * one menu and one reaction picker per thread and per reply — 150 roots for Burke's 15 threads, which
 * was most of the panel-open time (task #487). Until armed, `trigger` is rendered as a plain button
 * that arms on hover and arms-and-opens on pointer down / Enter / Space / ArrowDown, so the first
 * interaction behaves exactly like the Radix trigger. Once armed it stays mounted (focus return, etc.).
 */
function useLazyTrigger() {
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  const plainProps = useMemo(
    () => ({
      "aria-haspopup": "menu" as const,
      "aria-expanded": false,
      onPointerEnter: () => setArmed(true),
      onPointerDown: (e: React.PointerEvent) => {
        if (e.button !== 0 || e.ctrlKey) return;
        setArmed(true);
        setOpen(true);
      },
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key !== "Enter" && e.key !== " " && e.key !== "ArrowDown") return;
        e.preventDefault();
        setArmed(true);
        setOpen(true);
      },
    }),
    [],
  );
  return { armed, open, setOpen, plainProps };
}

function LazyMenu({ trigger, children, ...content }: { trigger: React.ReactElement<React.ComponentProps<"button">>; children: React.ReactNode } & Omit<React.ComponentProps<typeof MenuContent>, "children">) {
  const { armed, open, setOpen, plainProps } = useLazyTrigger();
  if (!armed) return cloneElement(trigger, plainProps);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>{trigger}</MenuTrigger>
      <MenuContent {...content}>{children}</MenuContent>
    </Menu>
  );
}

/** Reaction chips plus the quick picker for one thread body or reply. */
function ReactionRow({
  reactions,
  names,
  me,
  canReact,
  disabled = false,
  onToggle,
}: {
  reactions: Reactions;
  names: Record<string, string>;
  me: string;
  canReact: boolean;
  disabled?: boolean;
  onToggle: (emoji: string) => void;
}) {
  const { armed, open, setOpen, plainProps } = useLazyTrigger();
  const entries = Object.entries(reactions).filter(([, ids]) => ids.length > 0);
  if (entries.length === 0 && !canReact) return null;
  const addButton = (
    <button type="button" className="reaction-add" aria-label="Add reaction" title="Add reaction" disabled={disabled} data-testid="reaction-add">
      <SmilePlus size={14} />
    </button>
  );
  return (
    <div className="reaction-row" onClick={(e) => e.stopPropagation()} data-testid="reaction-row">
      {entries.map(([emoji, ids]) => {
        const mine = ids.includes(me);
        return (
          <button
            key={emoji}
            type="button"
            className="reaction-chip"
            data-mine={mine ? "true" : undefined}
            data-emoji={emoji}
            title={ids.map((id) => names[id] ?? id).join(", ")}
            aria-pressed={mine}
            aria-label={`${emoji} ${ids.length}`}
            disabled={!canReact || disabled}
            onClick={() => onToggle(emoji)}
            data-testid="reaction-chip"
          >
            <span>{emoji}</span> <span className="reaction-count">{ids.length}</span>
          </button>
        );
      })}
      {canReact &&
        (!armed ? (
          cloneElement(addButton, { ...plainProps, "aria-haspopup": "dialog" })
        ) : (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>{addButton}</PopoverTrigger>
            <PopoverContent side="top" align="start" className="p-1" data-testid="reaction-picker">
              <div className="reaction-picker" role="group" aria-label="Pick a reaction">
                {QUICK_REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    data-mine={reactions[emoji]?.includes(me) ? "true" : undefined}
                    aria-label={`React with ${emoji}`}
                    disabled={disabled}
                    onClick={() => {
                      onToggle(emoji);
                      setOpen(false);
                    }}
                    data-testid="reaction-option"
                    data-emoji={emoji}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        ))}
    </div>
  );
}

/**
 * Collaborators and recently active agents of the document, fetched once while the panel is open, merged with who
 * is present. With `withOwnTokens` (set the first time a composer's `@` picker opens) the user's own API tokens join
 * the list too, so an agent that has never been in this document can still be asked; one already known through
 * presence or activity is listed once, as that entry. `tokenCount` is how many tokens that fetch returned — null
 * until it has, or when it failed — so the picker can offer "Connect an agent" to a user who has none (#1025).
 */
function useMentionCandidates(session: CollabSession, withOwnTokens: boolean): { candidates: MentionCandidate[]; tokenCount: number | null } {
  const ownerLogin = session.user.login ?? null;
  const me = ownerLogin?.toLowerCase() ?? null;
  const [collaborationResult, setCollaborationResult] = useState<{
    session: CollabSession;
    documentId: string;
    viewerLogin: string | null;
    collaborators: MentionCandidate[];
    knownAgents: MentionCandidate[];
  } | null>(null);
  const [tokenResult, setTokenResult] = useState<{
    session: CollabSession;
    viewerLogin: string;
    viewerName: string;
    candidates: MentionCandidate[];
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const documentId = session.docId;
    const viewerLogin = me;
    api.documents
      .collaborators(documentId)
      .then((res) => {
        if (cancelled) return;
        const list: MentionCandidate[] = [];
        if (res.owner?.login) list.push({ login: res.owner.login, name: res.owner.name ?? res.owner.login, image: res.owner.image });
        for (const c of res.collaborators) list.push({ login: c.login, name: c.name ?? c.login, image: c.image });
        setCollaborationResult({
          session,
          documentId,
          viewerLogin,
          collaborators: list,
          knownAgents: (res.agents ?? []).map((a) => ({
            login: a.login,
            name: a.name,
            image: null,
            agent: { ownerLogin: a.ownerLogin, ownerName: a.ownerName ?? null, canAsk: a.ownerLogin.toLowerCase() === viewerLogin || a.collaboratorsMayAsk === true },
          })),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session, session.docId, me]);
  useEffect(() => {
    if (!withOwnTokens || !ownerLogin) return;
    let cancelled = false;
    const viewerLogin = ownerLogin.toLowerCase();
    const viewerName = session.user.name;
    api.tokens
      .list()
      .then((res) => {
        if (cancelled) return;
        setTokenResult({
          session,
          viewerLogin,
          viewerName,
          candidates: res.tokens.map((t) => ({ login: agentMentionLogin(ownerLogin, t.name), name: t.name, image: null, agent: { ownerLogin, ownerName: viewerName, canAsk: true }, own: true })),
        });
      })
      .catch((err: unknown) => {
        // Agents' sessions cannot list tokens (403); the picker simply offers what the document knows.
        if (!cancelled) console.debug("[comments] own tokens not listed for the mention picker", err);
      });
    return () => {
      cancelled = true;
    };
  }, [withOwnTokens, session, ownerLogin, session.user.name]);
  const present = useSessionValue(
    session,
    (s) =>
      s
        .presence()
        .filter((u) => !u.isLocal && (u.isAgent ? u.ownerLogin : u.login))
        .map((u): MentionCandidate =>
          u.isAgent
            ? // Presence does not carry the owner's switch; the merge below fills `canAsk` in from the collaborators route.
              { login: agentMentionLogin(u.ownerLogin!, u.name), name: u.name, image: null, agent: { ownerLogin: u.ownerLogin!, ownerName: u.ownerName, canAsk: u.ownerLogin!.toLowerCase() === me } }
            : { login: u.login!, name: u.name, image: u.avatar ?? null },
        ),
    jsonEqual,
  );
  const currentCollaboration =
    collaborationResult?.session === session && collaborationResult.documentId === session.docId && collaborationResult.viewerLogin === me ? collaborationResult : null;
  const ownTokens =
    me !== null && tokenResult?.session === session && tokenResult.viewerLogin === me && tokenResult.viewerName === session.user.name ? tokenResult.candidates : null;
  return useMemo(() => {
    const collaborators = currentCollaboration?.collaborators ?? [];
    const knownAgents = currentCollaboration?.knownAgents ?? [];
    const seen = new Set<string>();
    const out: MentionCandidate[] = [];
    const known = new Map(knownAgents.map((a) => [a.login.toLowerCase(), a] as const));
    // Your own agent stays in the list even though you are not: it is the agent that needs the mention.
    // Own tokens come last so one that is present or recently active keeps its ordinary entry.
    for (const c of [...present, ...collaborators, ...knownAgents, ...(ownTokens ?? [])]) {
      const key = c.login.toLowerCase();
      if (key === me || seen.has(key)) continue;
      seen.add(key);
      const listed = c.agent ? known.get(key)?.agent : undefined;
      out.push(listed && c.agent ? { ...c, agent: { ...c.agent, ownerName: c.agent.ownerName ?? listed.ownerName, canAsk: c.agent.canAsk || listed.canAsk } } : c);
    }
    return { candidates: out, tokenCount: ownTokens ? ownTokens.length : null };
  }, [present, currentCollaboration, ownTokens, me]);
}

const MAX_SUGGESTIONS = 6;

/** The "Connect an agent" row under the `@` picker, for a user whose token list came back empty (#1025). */
interface MentionConnectValue {
  /** Show the row: the user has no API token and has not dismissed the row on this browser. */
  due: boolean;
  /** Settings → tokens (the row's button is hidden without it). */
  onCreateToken?: () => void;
  onDismiss: () => void;
}

interface MentionCandidatesValue {
  candidates: MentionCandidate[];
  /** The current user's login; someone else's agent is labelled with its owner relative to them ("Drew's Copilot CLI"). */
  viewerLogin: string | null;
  /** A composer's `@` picker opened: the panel fetches the user's own tokens once (see useMentionCandidates). */
  onPickerOpen: () => void;
  connect: MentionConnectValue;
}

/** What a thread card's request chip needs to name the agent that claimed a request (#1330): the owner's name by login. */
interface AgentNamesValue {
  /** The current user's login; someone else's agent is labelled with its owner relative to them ("Drew's Copilot CLI"). */
  viewerLogin: string | null;
  /** Display name of an agent's owner by login, as far as the agent entries know it; null when unknown (the login stands in). */
  nameOf: (login: string) => string | null;
}

/**
 * Mention candidates reach the composers through context rather than as a ThreadCard prop: the list
 * arrives a moment after the panel opens (collaborators fetch) and would otherwise re-render every
 * memoised card for a value only an open composer reads. The one thing a card itself needs from the
 * list — an agent's owner name for the request chip — comes through AgentNamesContext, whose value
 * only changes when an agent entry does (#1382): a person joining or leaving, the token list loading
 * or the "Connect an agent" row flipping never re-render a card.
 */
const MentionCandidatesContext = createContext<MentionCandidatesValue>({ candidates: [], viewerLogin: null, onPickerOpen: () => {}, connect: { due: false, onDismiss: () => {} } });
const AgentNamesContext = createContext<AgentNamesValue>({ viewerLogin: null, nameOf: () => null });

/** An agent entry as a chip can see it (no image, `canAsk` or `own`); AgentNamesContext is stable while these are (jsonEqual). */
function agentNameTuples(candidates: MentionCandidate[]): [login: string, name: string, ownerLogin: string, ownerName: string | null][] {
  return candidates.map((c) => [c.login, c.name, c.agent?.ownerLogin ?? "", c.agent?.ownerName ?? null]);
}

/**
 * `value` while it is equal (per `isEqual`) to the last one returned, else the new one — a reference that only changes
 * with the content, for a context value memoised consumers must not re-render for. The React docs' "storing
 * information from previous renders": a state set during render re-runs this render at once with the new value.
 */
function useStableValue<T>(value: T, isEqual: (a: T, b: T) => boolean): T {
  const [stable, setStable] = useState(value);
  if (isEqual(stable, value)) return stable;
  setStable(value);
  return value;
}

/** The picker's "Connect an agent" row shares the settings card's `localStorage` flag: dismissed once, gone everywhere. */
function readConnectDismissed(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(AGENT_CONNECT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Avatar for a comment/suggestion author; agents (API tokens) get a bot badge. */
function AuthorAvatar({ id, name, src, size }: { id: string; name: string; src?: string | null; size: number }) {
  if (id.startsWith("agent:")) {
    return (
      <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700 ring-2 ring-surface dark:bg-violet-950 dark:text-violet-300" style={{ width: size, height: size }} title={`${name} (agent)`}>
        <Bot size={Math.round(size * 0.55)} />
      </span>
    );
  }
  return <Avatar name={name} src={src} size={size} />;
}

export interface CommentsPanelProps {
  session: CollabSession;
  onClose: () => void;
  onReveal: (offset: number) => void;
  /** Called when the pending (new-comment) composer is posted or cancelled, so focus can return to the editor. */
  onPendingDone?: () => void;
  /** Switch to a tab from outside; bump `nonce` to switch again to the same tab. */
  focusTab?: { tab: "open" | "resolved" | "suggestions"; nonce: number } | null;
  /**
   * Open a composer on the whole document (a zero-width thread at {0,0}, #1025); bump `nonce` to do it again.
   * With `mention` the composer starts with `@` typed, so the agent picker is up at once.
   */
  documentComposer?: { mention: boolean; nonce: number } | null;
  /** Settings → API tokens, for the picker's "Connect an agent" row (a user with no token); the button is hidden without it. */
  onCreateToken?: () => void;
  /** Move focus to the selected tab when this panel mounts. */
  focusOnMount?: boolean;
  /** Shell toast (Accept suggestion offers Undo). */
  onToast?: (message: string, kind?: "info" | "success" | "error", action?: { label: string; onClick?: () => void }) => void;
  /** Cancels an open or claimed agent request (the × on a thread card's request chip); the × is hidden when omitted. */
  onCancelRequest?: (requestId: string) => void;
}

/** Writes comment changes either to the shared doc (editors) or through the API (commenters). */
function useCommentOps(session: CollabSession) {
  const viaApi = session.commentsViaApi;
  const id = session.docId;
  return useMemo(
    () => ({
      async add(from: number, to: number, body: string) {
        if (viaApi) return (await api.documents.comment(id, { action: "add", from, to, body })).id ?? null;
        return session.comments.add({ from, to, body, author: session.user });
      },
      /** Accept the thread's suggestion block. Editors apply it locally (one undo step); returns false when it could not be applied. */
      async acceptSuggestion(threadId: string, proposed: string, replyId?: string): Promise<boolean> {
        if (viaApi) {
          await api.documents.comment(id, { action: "suggestion", threadId, replyId, decision: "accept" });
          return true;
        }
        return session.acceptCommentSuggestion(threadId, proposed, replyId);
      },
      async rejectSuggestion(threadId: string, replyId?: string): Promise<boolean> {
        if (viaApi) {
          await api.documents.comment(id, { action: "suggestion", threadId, replyId, decision: "reject" });
          return true;
        }
        if (replyId) return session.comments.rejectReplySuggestion(threadId, replyId, session.user);
        return session.comments.rejectSuggestion(threadId, session.user);
      },
      async reply(threadId: string, body: string) {
        if (viaApi) return api.documents.comment(id, { action: "reply", threadId, body });
        session.comments.reply(threadId, body, session.user);
      },
      async resolve(threadId: string, resolved: boolean) {
        if (viaApi) return api.documents.comment(id, { action: "resolve", threadId, resolved });
        session.comments.setResolved(threadId, resolved, session.user);
      },
      async edit(threadId: string, body: string, replyId?: string) {
        if (viaApi) return api.documents.comment(id, { action: "edit", threadId, replyId, body });
        session.comments.editBody(threadId, body, replyId);
      },
      async remove(threadId: string, replyId?: string) {
        if (viaApi) return api.documents.comment(id, { action: "delete", threadId, replyId });
        if (replyId) session.comments.deleteReply(threadId, replyId);
        else session.comments.remove(threadId);
      },
      async react(threadId: string, replyId: string | null, emoji: string) {
        if (viaApi) return api.documents.comment(id, { action: "react", threadId, replyId: replyId ?? undefined, emoji });
        session.comments.toggleReaction(threadId, replyId, emoji, session.user);
      },
    }),
    [session, viaApi, id],
  );
}

interface CommentPanelVisit {
  readonly marker: "comment-panel-visit";
}

type CommentRowAction =
  | { type: "resolve"; resolved: boolean }
  | { type: "delete" }
  | { type: "react"; emoji: string; reacted: boolean };

type CommentBatchAction = "review-accept" | "review-reject" | "review-resolve" | "suggestions-accept" | "suggestions-reject";

interface CommentTargetIdentity {
  readonly thread: object;
  readonly reply: object | null;
}

interface CommentSuggestionBatchTarget {
  readonly kind: "comment-suggestion";
  readonly key: string;
  readonly threadId: string;
  readonly replyId: string | null;
  readonly identity: CommentTargetIdentity;
  readonly body: string;
  readonly proposed: string;
  readonly initiallyOutdated: boolean;
}

interface CommentResolveBatchTarget {
  readonly kind: "comment-resolve";
  readonly key: string;
  readonly threadId: string;
  readonly replyId: null;
  readonly identity: CommentTargetIdentity;
}

interface LocalSuggestionBatchTarget {
  readonly kind: "local-suggestion";
  readonly key: string;
  readonly suggestionId: string;
  readonly memberIds: readonly string[];
  readonly memberIdentities: readonly object[];
  readonly before: string;
  readonly after: string;
}

type CommentBatchTarget = CommentSuggestionBatchTarget | CommentResolveBatchTarget | LocalSuggestionBatchTarget;

interface CommentBatchOwner {
  readonly session: CollabSession;
  readonly documentId: string;
  readonly visit: CommentPanelVisit;
  readonly scope: string;
  readonly reviewId: string | null;
  readonly reviewSignature: string | null;
  readonly authorName: string | null;
  readonly action: CommentBatchAction;
  readonly operation: number;
  readonly targets: readonly CommentBatchTarget[];
}

function reviewIdentitySignature(review: ReviewDto): string {
  return JSON.stringify([review.id, review.documentId, review.authorId, review.authorName, review.collabAuthorId, review.agent, review.verdict, review.summary, review.threadIds, review.createdAt]);
}

interface CommentRowActionOwner {
  readonly session: CollabSession;
  readonly documentId: string;
  readonly visit: CommentPanelVisit;
  readonly threadId: string;
  readonly replyId: string | null;
  readonly action: Readonly<CommentRowAction>;
}

interface CommentRowActionCoordinator {
  readonly session: CollabSession;
  readonly documentId: string;
  readonly visit: CommentPanelVisit;
  mounted: boolean;
  operation: number;
  targets: Set<string>;
  readonly owners: Map<string, CommentRowActionOwner>;
  readonly errors: Map<string, string>;
  readonly batchOwners: Map<string, CommentBatchOwner>;
  readonly batchTargets: Map<string, CommentBatchOwner>;
  reviewSignatures: Map<string, string>;
  readonly versions: Map<string, number>;
  readonly listeners: Map<string, Set<() => void>>;
  readonly batchVersions: Map<string, number>;
  readonly batchListeners: Map<string, Set<() => void>>;
}

interface CommentRowActionState {
  pending: CommentRowActionOwner | null;
  batch: CommentBatchOwner | null;
  error: string | null;
}

const ROOT_COMMENT_TARGET = "";
const SUGGESTION_TARGET_PREFIX = "suggestion\0";
const REVIEW_SCOPE_PREFIX = "review\0";
const SUGGESTIONS_SCOPE = "suggestions";

function commentTargetKey(threadId: string, replyId: string | null): string {
  return `${threadId}\0${replyId ?? ROOT_COMMENT_TARGET}`;
}

function localSuggestionTargetKey(suggestionId: string): string {
  return `${SUGGESTION_TARGET_PREFIX}${suggestionId}`;
}

function reviewBatchScope(reviewId: string): string {
  return `${REVIEW_SCOPE_PREFIX}${reviewId}`;
}

function storedCommentTargetIdentity(session: CollabSession, threadId: string, replyId: string | null): CommentTargetIdentity | null {
  const thread = session.comments.ymap.get(threadId);
  if (!thread) return null;
  if (replyId === null) return Object.freeze({ thread, reply: null });
  const replies = thread.get("replies");
  if (!replies || typeof replies !== "object" || !("toArray" in replies) || typeof replies.toArray !== "function") return null;
  const reply = (replies.toArray() as object[]).find((value) => "id" in value && value.id === replyId);
  return reply ? Object.freeze({ thread, reply }) : null;
}

function sameCommentTargetIdentity(session: CollabSession, target: CommentSuggestionBatchTarget | CommentResolveBatchTarget): boolean {
  const current = storedCommentTargetIdentity(session, target.threadId, target.replyId);
  return current?.thread === target.identity.thread && current.reply === target.identity.reply;
}

function commentBatchLabel(owner: CommentBatchOwner): string {
  if (owner.action === "review-resolve") return "Resolving comment…";
  if (owner.action === "review-accept" || owner.action === "suggestions-accept") return "Accepting suggestion…";
  return "Rejecting suggestion…";
}

function pendingCommentActionLabel(owner: CommentRowActionOwner): string {
  if (owner.action.type === "resolve") return owner.action.resolved ? "Resolving comment…" : "Re-opening comment…";
  if (owner.action.type === "delete") return owner.replyId ? "Deleting reply…" : "Deleting comment…";
  return `${owner.action.reacted ? "Adding" : "Removing"} ${owner.action.emoji} reaction…`;
}

function failedCommentActionText(error: unknown, owner: CommentRowActionOwner): string {
  const { action } = owner;
  const fallback =
    action.type === "resolve"
      ? `Couldn’t ${action.resolved ? "resolve" : "re-open"} the comment.`
      : action.type === "delete"
        ? `Couldn’t delete the ${owner.replyId ? "reply" : "comment"}.`
        : "Couldn’t update the reaction.";
  const reason = apiErrorText(error, fallback).trim() || fallback;
  return `${reason.replace(/[.\s]+$/, "")}. Try again.`;
}

function CommentActionFeedback({ state }: { state: CommentRowActionState }) {
  if (state.pending) {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-3" role="status" aria-live="polite" data-testid="comment-action-pending" data-action={state.pending.action.type}>
        <Loader2 size={12} className="animate-spin" aria-hidden />
        {pendingCommentActionLabel(state.pending)}
      </div>
    );
  }
  if (state.batch) {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-3" role="status" aria-live="polite" data-testid="comment-batch-pending" data-action={state.batch.action}>
        <Loader2 size={12} className="animate-spin" aria-hidden />
        {commentBatchLabel(state.batch)}
      </div>
    );
  }
  if (!state.error) return null;
  return (
    <div className="mt-1.5 rounded-md bg-red-50 px-2 py-1.5 text-xs text-danger dark:bg-red-950/40" role="alert" aria-atomic="true" data-testid="comment-action-error">
      {state.error}
    </div>
  );
}

function retireCommentRowActions(coordinator: CommentRowActionCoordinator) {
  coordinator.mounted = false;
  coordinator.owners.clear();
  coordinator.errors.clear();
  coordinator.batchOwners.clear();
  coordinator.batchTargets.clear();
  coordinator.reviewSignatures.clear();
  coordinator.listeners.clear();
  coordinator.batchListeners.clear();
}

function mountCommentRowActions(coordinator: CommentRowActionCoordinator) {
  coordinator.mounted = true;
  return () => retireCommentRowActions(coordinator);
}

function syncCommentRowActionTargets(coordinator: CommentRowActionCoordinator, threads: CommentThread[]) {
  const targets = new Set(threads.flatMap((thread) => [commentTargetKey(thread.id, null), ...thread.replies.map((reply) => commentTargetKey(thread.id, reply.id))]));
  coordinator.targets = targets;
  for (const key of coordinator.owners.keys()) if (!targets.has(key)) coordinator.owners.delete(key);
  for (const key of coordinator.errors.keys()) if (!targets.has(key)) coordinator.errors.delete(key);
}

function publishCommentRowAction(coordinator: CommentRowActionCoordinator, threadId: string) {
  coordinator.versions.set(threadId, (coordinator.versions.get(threadId) ?? 0) + 1);
  for (const listener of coordinator.listeners.get(threadId) ?? []) listener();
}

function ownsCommentRowAction(coordinator: CommentRowActionCoordinator, owner: CommentRowActionOwner): boolean {
  const key = commentTargetKey(owner.threadId, owner.replyId);
  return (
    coordinator.mounted &&
    coordinator.session === owner.session &&
    coordinator.documentId === owner.documentId &&
    coordinator.visit === owner.visit &&
    coordinator.targets.has(key) &&
    coordinator.owners.get(key) === owner
  );
}

function createCommentRowActionCoordinator(session: CollabSession, visit: CommentPanelVisit): CommentRowActionCoordinator {
  return {
    session,
    documentId: session.docId,
    visit,
    mounted: true,
    operation: 0,
    targets: new Set(),
    owners: new Map(),
    errors: new Map(),
    batchOwners: new Map(),
    batchTargets: new Map(),
    reviewSignatures: new Map(),
    versions: new Map(),
    listeners: new Map(),
    batchVersions: new Map(),
    batchListeners: new Map(),
  };
}

function publishCommentBatchScope(coordinator: CommentRowActionCoordinator, scope: string) {
  coordinator.batchVersions.set(scope, (coordinator.batchVersions.get(scope) ?? 0) + 1);
  for (const listener of coordinator.batchListeners.get(scope) ?? []) listener();
}

function commentBatchThreadIds(owner: CommentBatchOwner): string[] {
  return [...new Set(owner.targets.flatMap((target) => (target.kind === "local-suggestion" ? [] : [target.threadId])))];
}

function publishCommentBatch(coordinator: CommentRowActionCoordinator, owner: CommentBatchOwner) {
  publishCommentBatchScope(coordinator, owner.scope);
  for (const threadId of commentBatchThreadIds(owner)) publishCommentRowAction(coordinator, threadId);
}

function ownsCommentBatch(coordinator: CommentRowActionCoordinator, owner: CommentBatchOwner): boolean {
  return (
    coordinator.mounted &&
    coordinator.session === owner.session &&
    coordinator.documentId === owner.documentId &&
    coordinator.visit === owner.visit &&
    coordinator.batchOwners.get(owner.scope) === owner &&
    owner.targets.every((target) => coordinator.batchTargets.get(target.key) === owner)
  );
}

function currentCommentBatchContext(coordinator: CommentRowActionCoordinator, owner: CommentBatchOwner): boolean {
  return ownsCommentBatch(coordinator, owner) && (owner.reviewId === null || coordinator.reviewSignatures.get(owner.reviewId) === owner.reviewSignature);
}

function releaseCommentBatch(coordinator: CommentRowActionCoordinator, owner: CommentBatchOwner) {
  if (!ownsCommentBatch(coordinator, owner)) return;
  coordinator.batchOwners.delete(owner.scope);
  for (const target of owner.targets) if (coordinator.batchTargets.get(target.key) === owner) coordinator.batchTargets.delete(target.key);
  publishCommentBatch(coordinator, owner);
}

function commentTargetHasRowConflict(coordinator: CommentRowActionCoordinator, target: CommentBatchTarget): boolean {
  if (target.kind === "local-suggestion") return false;
  if (coordinator.owners.has(target.key)) return true;
  if (target.replyId !== null) return coordinator.owners.get(commentTargetKey(target.threadId, null))?.action.type === "delete";
  return false;
}

function commentTargetHasBatchConflict(coordinator: CommentRowActionCoordinator, target: CommentBatchTarget): boolean {
  if (coordinator.batchTargets.has(target.key)) return true;
  if (target.kind !== "comment-suggestion") return false;
  return [...coordinator.batchOwners.values()].some((owner) =>
    owner.targets.some((claimed) => claimed.kind === "comment-suggestion" && claimed.threadId === target.threadId),
  );
}

function isCommentBatchBlocked(coordinator: CommentRowActionCoordinator, targets: readonly CommentBatchTarget[]): boolean {
  return targets.some((target) => commentTargetHasRowConflict(coordinator, target) || commentTargetHasBatchConflict(coordinator, target));
}

function claimCommentBatch(
  coordinator: CommentRowActionCoordinator,
  input: {
    scope: string;
    review: ReviewDto | null;
    authorName: string | null;
    action: CommentBatchAction;
    targets: readonly CommentBatchTarget[];
  },
): CommentBatchOwner | null {
  if (!coordinator.mounted || coordinator.batchOwners.has(input.scope) || input.targets.length === 0 || isCommentBatchBlocked(coordinator, input.targets)) return null;
  const reviewSignature = input.review ? reviewIdentitySignature(input.review) : null;
  if (input.review && coordinator.reviewSignatures.get(input.review.id) !== reviewSignature) return null;

  const owner = Object.freeze({
    session: coordinator.session,
    documentId: coordinator.documentId,
    visit: coordinator.visit,
    scope: input.scope,
    reviewId: input.review?.id ?? null,
    reviewSignature,
    authorName: input.authorName,
    action: input.action,
    operation: ++coordinator.operation,
    targets: Object.freeze([...input.targets]),
  }) satisfies CommentBatchOwner;
  coordinator.batchOwners.set(owner.scope, owner);
  for (const target of owner.targets) {
    coordinator.batchTargets.set(target.key, owner);
    coordinator.errors.delete(target.key);
  }
  if (!ownsCommentBatch(coordinator, owner)) {
    coordinator.batchOwners.delete(owner.scope);
    for (const target of owner.targets) if (coordinator.batchTargets.get(target.key) === owner) coordinator.batchTargets.delete(target.key);
    return null;
  }
  publishCommentBatch(coordinator, owner);
  return owner;
}

function syncCommentBatchReviews(coordinator: CommentRowActionCoordinator, reviews: ReviewDto[]) {
  coordinator.reviewSignatures = new Map(reviews.map((review) => [review.id, reviewIdentitySignature(review)]));
  for (const owner of [...coordinator.batchOwners.values()]) {
    if (owner.reviewId !== null && coordinator.reviewSignatures.get(owner.reviewId) !== owner.reviewSignature) releaseCommentBatch(coordinator, owner);
  }
}

function useCommentBatchState(
  coordinator: CommentRowActionCoordinator,
  scope: string,
  targets: readonly CommentBatchTarget[],
): { owner: CommentBatchOwner | null; blocked: boolean } {
  const threadIdsKey = [...new Set(targets.flatMap((target) => (target.kind === "local-suggestion" ? [] : [target.threadId])))].sort().join("\0");
  const targetKeys = targets.map((target) => target.key).join("\u001f");
  const subscribe = useCallback(
    (listener: () => void) => {
      let scopeListeners = coordinator.batchListeners.get(scope);
      if (!scopeListeners) {
        scopeListeners = new Set();
        coordinator.batchListeners.set(scope, scopeListeners);
      }
      scopeListeners.add(listener);
      const threadIds = threadIdsKey ? threadIdsKey.split("\0") : [];
      for (const threadId of threadIds) {
        let listeners = coordinator.listeners.get(threadId);
        if (!listeners) {
          listeners = new Set();
          coordinator.listeners.set(threadId, listeners);
        }
        listeners.add(listener);
      }
      return () => {
        scopeListeners.delete(listener);
        if (scopeListeners.size === 0) coordinator.batchListeners.delete(scope);
        for (const threadId of threadIds) {
          const listeners = coordinator.listeners.get(threadId);
          listeners?.delete(listener);
          if (listeners?.size === 0) coordinator.listeners.delete(threadId);
        }
      };
    },
    [coordinator, scope, threadIdsKey],
  );
  const getSnapshot = useCallback(() => {
    const owner = coordinator.batchOwners.get(scope);
    return `${owner?.operation ?? 0}:${isCommentBatchBlocked(coordinator, targets) ? 1 : 0}:${targetKeys}`;
  }, [coordinator, scope, targets, targetKeys]);
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { owner: coordinator.batchOwners.get(scope) ?? null, blocked: isCommentBatchBlocked(coordinator, targets) };
}

/**
 * The panel visit owns in-flight work so changing tabs cannot unlock a target. Cards subscribe by thread,
 * preserving memoisation while root/reply actions inside one card remain independently addressable.
 */
function useCommentRowActionCoordinator(session: CollabSession, visit: CommentPanelVisit, threads: CommentThread[]) {
  const coordinator = useMemo(() => createCommentRowActionCoordinator(session, visit), [session, visit]);

  useLayoutEffect(() => mountCommentRowActions(coordinator), [coordinator]);
  useLayoutEffect(() => syncCommentRowActionTargets(coordinator, threads), [coordinator, threads]);

  return coordinator;
}

function useCommentRowActions(coordinator: CommentRowActionCoordinator, thread: CommentThread) {
  const threadId = thread.id;
  const subscribe = useCallback(
    (listener: () => void) => {
      let listeners = coordinator.listeners.get(threadId);
      if (!listeners) {
        listeners = new Set();
        coordinator.listeners.set(threadId, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) coordinator.listeners.delete(threadId);
      };
    },
    [coordinator, threadId],
  );
  const getSnapshot = useCallback(() => coordinator.versions.get(threadId) ?? 0, [coordinator, threadId]);
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const run = useCallback(
    (replyId: string | null, nextAction: CommentRowAction) => {
      const key = commentTargetKey(threadId, replyId);
      if (!coordinator.session.commentsViaApi || !coordinator.mounted || !coordinator.targets.has(key) || coordinator.owners.has(key) || coordinator.batchTargets.has(key)) return;

      const rootKey = commentTargetKey(threadId, null);
      const rootOwner = coordinator.owners.get(rootKey);
      const threadHasOwner =
        [...coordinator.owners.values()].some((owner) => owner.threadId === threadId) ||
        [...coordinator.batchOwners.values()].some((owner) => owner.targets.some((target) => target.kind !== "local-suggestion" && target.threadId === threadId));
      if ((replyId !== null && rootOwner?.action.type === "delete") || (replyId === null && nextAction.type === "delete" && threadHasOwner)) return;

      const action: Readonly<CommentRowAction> = Object.freeze({ ...nextAction });
      const owner = Object.freeze({
        session: coordinator.session,
        documentId: coordinator.documentId,
        visit: coordinator.visit,
        threadId,
        replyId,
        action,
      }) satisfies CommentRowActionOwner;
      coordinator.errors.delete(key);
      coordinator.owners.set(key, owner);
      if (!ownsCommentRowAction(coordinator, owner)) return;
      publishCommentRowAction(coordinator, threadId);

      const settle = (result: { ok: true } | { ok: false; error: unknown }) => {
        if (!ownsCommentRowAction(coordinator, owner)) return;
        if (result.ok) coordinator.errors.delete(key);
        else coordinator.errors.set(key, failedCommentActionText(result.error, owner));
        coordinator.owners.delete(key);
        publishCommentRowAction(coordinator, threadId);
      };

      let request: Promise<unknown>;
      try {
        if (action.type === "resolve") {
          const payload = Object.freeze({ action: "resolve" as const, threadId: owner.threadId, resolved: action.resolved });
          request = api.documents.comment(owner.documentId, payload);
        } else if (action.type === "delete") {
          const payload = Object.freeze({ action: "delete" as const, threadId: owner.threadId, replyId: owner.replyId ?? undefined });
          request = api.documents.comment(owner.documentId, payload);
        } else {
          const payload = Object.freeze({ action: "react" as const, threadId: owner.threadId, replyId: owner.replyId ?? undefined, emoji: action.emoji });
          request = api.documents.comment(owner.documentId, payload);
        }
      } catch (error) {
        settle({ ok: false, error });
        return;
      }
      void request.then(
        () => settle({ ok: true }),
        (error: unknown) => settle({ ok: false, error }),
      );
    },
    [coordinator, threadId],
  );

  const state = (replyId: string | null): CommentRowActionState => {
    const key = commentTargetKey(threadId, replyId);
    return { pending: coordinator.owners.get(key) ?? null, batch: coordinator.batchTargets.get(key) ?? null, error: coordinator.errors.get(key) ?? null };
  };
  const rootOwner = coordinator.owners.get(commentTargetKey(threadId, null));
  const hasBatchReply = [...coordinator.batchOwners.values()].some((owner) =>
    owner.targets.some((target) => target.kind !== "local-suggestion" && target.threadId === threadId && target.replyId !== null),
  );

  return {
    run,
    state,
    blocked: (replyId: string | null) => coordinator.batchTargets.has(commentTargetKey(threadId, replyId)),
    hasPendingReply: [...coordinator.owners.values()].some((owner) => owner.threadId === threadId && owner.replyId !== null) || hasBatchReply,
    rootDeleting: rootOwner?.action.type === "delete",
  };
}

/** Tallest the composer grows before it scrolls inside: about 16 lines, or 40 % of a short viewport. */
const COMPOSER_MAX_HEIGHT = 320;

/** Nearest ancestor that scrolls vertically (the comments list). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === "auto" || overflowY === "scroll") return p;
  }
  return null;
}

/** The answer modes an agent can be asked for, in the order the composer row shows them. */
const REQUEST_MODES: { id: AgentRequestMode; label: string }[] = [
  { id: "suggest", label: "Tracked changes" },
  { id: "comment", label: "Comment only" },
  { id: "rewrite", label: "Rewrite directly" },
];

/** What a composer that can turn a mention into an agent request needs to know (new-comment and reply composers; not edit). */
export interface ComposerRequestOptions {
  /** `session.canEdit`: without it only "Comment only" can be chosen (the server refuses the other modes too). */
  canEdit: boolean;
  /** Preselected mode: the thread's latest request mode for a reply, else tracked changes. */
  defaultMode: AgentRequestMode;
}

/** A submitted body that mentions a known agent becomes a request in this mode. */
export interface ComposerRequest {
  mode: AgentRequestMode;
  agents: MentionCandidate[];
}

interface ComposerVisit {
  readonly marker: "composer-visit";
  retired: boolean;
  focusOperation: ComposerFocusOperation | null;
  blurOperation: ComposerBlurOperation | null;
}

interface ComposerFocusOperation {
  readonly visit: ComposerVisit;
  readonly element: HTMLTextAreaElement;
  readonly operation: number;
  readonly selection: readonly [start: number, end: number] | null;
  readonly syncMention: boolean;
  readonly caretAction: number;
  frame: number | null;
}

interface ComposerBlurOperation {
  readonly visit: ComposerVisit;
  readonly element: HTMLTextAreaElement;
  readonly operation: number;
  readonly closeMention: true;
  readonly caretAction: number;
  timer: number | null;
}

interface ComposerSubmissionOwner {
  readonly visit: ComposerVisit;
  readonly operation: number;
  readonly body: string;
  readonly request: ComposerRequest | null;
  readonly agentIdentities: readonly string[];
}

function cancelComposerFocusOperation(owner: ComposerFocusOperation) {
  const frame = owner.frame;
  owner.frame = null;
  if (owner.visit.focusOperation === owner) owner.visit.focusOperation = null;
  if (frame !== null) cancelAnimationFrame(frame);
}

function cancelComposerBlurOperation(owner: ComposerBlurOperation) {
  const timer = owner.timer;
  owner.timer = null;
  if (owner.visit.blurOperation === owner) owner.visit.blurOperation = null;
  if (timer !== null) window.clearTimeout(timer);
}

function cancelComposerDeferredWork(visit: ComposerVisit) {
  if (visit.focusOperation) cancelComposerFocusOperation(visit.focusOperation);
  if (visit.blurOperation) cancelComposerBlurOperation(visit.blurOperation);
}

function Composer<Result>({
  placeholder,
  autoFocus,
  onSubmit,
  onSuccess,
  onCancel,
  submitLabel = "Comment",
  initial = "",
  quote,
  editing = false,
  request,
}: {
  placeholder: string;
  autoFocus?: boolean;
  /** `request` is set when the body mentions an agent the picker knows and this composer offers the mode row. */
  onSubmit: (body: string, request: ComposerRequest | null) => Result | Promise<Result>;
  /** Runs only while this exact composer and submission still own the successful result. */
  onSuccess?: (result: Result, body: string, request: ComposerRequest | null) => void;
  onCancel?: () => void;
  submitLabel?: string;
  initial?: string;
  /** Anchored text; when set, "Suggest a change" (Ctrl+Shift+S) inserts a ```suggestion block pre-filled with it. */
  quote?: string;
  /** Replacing an existing comment's body (Enter saves, Esc cancels) rather than writing a new one. */
  editing?: boolean;
  /** Offer the "How should the agent answer?" row when an agent is mentioned; absent on the edit composer. */
  request?: ComposerRequestOptions;
}) {
  const { candidates, viewerLogin, onPickerOpen, connect } = useContext(MentionCandidatesContext);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [mode, setMode] = useState<AgentRequestMode>(request?.defaultMode ?? "suggest");
  const ref = useRef<HTMLTextAreaElement>(null);
  const activeVisit = useRef<ComposerVisit | null>(null);
  const activeSubmission = useRef<ComposerSubmissionOwner | null>(null);
  const operationSequence = useRef(0);
  const deferredOperationSequence = useRef(0);
  const caretActionSequence = useRef(0);
  const lastCaretEvent = useRef<Event | null>(null);
  useLayoutEffect(() => {
    const visit: ComposerVisit = {
      marker: "composer-visit",
      retired: false,
      focusOperation: null,
      blurOperation: null,
    };
    activeVisit.current = visit;
    activeSubmission.current = null;
    return () => {
      visit.retired = true;
      cancelComposerDeferredWork(visit);
      if (activeVisit.current === visit) {
        activeVisit.current = null;
        activeSubmission.current = null;
      }
    };
  }, []);
  const ownsSubmission = (owner: ComposerSubmissionOwner) => activeVisit.current === owner.visit && activeSubmission.current === owner;
  /** Re-evaluate whether the caret is in an `@` token. */
  const syncTrigger = useCallback((el: HTMLTextAreaElement) => {
    if (activeSubmission.current) return;
    setHighlight(0);
    if (el.selectionStart !== el.selectionEnd) {
      setTrigger(null);
      return;
    }
    setTrigger(mentionTriggerAt(el.value, el.selectionStart));
  }, []);

  const scheduleFocusSelection = useCallback(
    (element: HTMLTextAreaElement, selection: readonly [start: number, end: number] | null, syncMention = false) => {
      const visit = activeVisit.current;
      if (!visit || visit.retired || ref.current !== element || activeSubmission.current) return null;
      cancelComposerDeferredWork(visit);
      const owner: ComposerFocusOperation = {
        visit,
        element,
        operation: ++deferredOperationSequence.current,
        selection,
        syncMention,
        caretAction: caretActionSequence.current,
        frame: null,
      };
      visit.focusOperation = owner;
      owner.frame = requestAnimationFrame(() => {
        if (owner.frame === null) return;
        owner.frame = null;
        if (owner.visit.focusOperation === owner) owner.visit.focusOperation = null;
        if (
          activeVisit.current !== owner.visit ||
          owner.visit.retired ||
          ref.current !== owner.element ||
          !owner.element.isConnected ||
          activeSubmission.current ||
          caretActionSequence.current !== owner.caretAction
        ) {
          return;
        }
        owner.element.focus();
        if (owner.selection) owner.element.setSelectionRange(owner.selection[0], owner.selection[1]);
        if (owner.syncMention) syncTrigger(owner.element);
      });
      return owner;
    },
    [syncTrigger],
  );

  const recordCaretAction = (element: HTMLTextAreaElement, event: Event) => {
    const visit = activeVisit.current;
    if (!visit || visit.retired || ref.current !== element) return;
    if (lastCaretEvent.current === event) return;
    lastCaretEvent.current = event;
    caretActionSequence.current += 1;
    cancelComposerDeferredWork(visit);
  };

  const scheduleBlurDismissal = (element: HTMLTextAreaElement) => {
    const visit = activeVisit.current;
    if (!visit || visit.retired || ref.current !== element || activeSubmission.current) return;
    if (visit.blurOperation) cancelComposerBlurOperation(visit.blurOperation);
    const owner: ComposerBlurOperation = {
      visit,
      element,
      operation: ++deferredOperationSequence.current,
      closeMention: true,
      caretAction: caretActionSequence.current,
      timer: null,
    };
    visit.blurOperation = owner;
    owner.timer = window.setTimeout(() => {
      if (owner.timer === null) return;
      owner.timer = null;
      if (owner.visit.blurOperation === owner) owner.visit.blurOperation = null;
      if (
        activeVisit.current !== owner.visit ||
        owner.visit.retired ||
        ref.current !== owner.element ||
        !owner.element.isConnected ||
        activeSubmission.current ||
        caretActionSequence.current !== owner.caretAction
      ) {
        return;
      }
      setTrigger(null);
    }, 120);
  };

  useLayoutEffect(() => {
    if (!autoFocus) return;
    const element = ref.current;
    if (!element) return;
    // A frame later: a closing menu (Edit…) hands focus back to its trigger first.
    // A seeded new comment ("@" from the empty state or the hint bar, #1025) starts with the caret after the seed, so
    // the `@` picker is open before the user types; an edit keeps the browser's caret placement.
    const selection = initial && !editing ? ([initial.length, initial.length] as const) : null;
    const owner = scheduleFocusSelection(element, selection, selection !== null);
    return () => {
      if (owner) cancelComposerFocusOperation(owner);
    };
    // `initial` is read once, on mount, like useState(initial) above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus, scheduleFocusSelection]);
  // The user's own tokens join the picker the first time an `@` is typed in any composer (not on panel mount);
  // a pasted `@login/agent` counts too, so the row can appear for an agent the document has not seen yet.
  const namesAgent = request !== undefined && parseAgentMentions(value).length > 0;
  useEffect(() => {
    if (trigger || namesAgent) onPickerOpen();
  }, [trigger, namesAgent, onPickerOpen]);

  // The box follows its content: from 3 lines (min-h-[64px]) up to the cap, beyond which it scrolls. Measured
  // from height:auto so it shrinks too, before paint so nothing flashes; the list's scroll position is pinned
  // because the momentary collapse would otherwise let the scroller clamp it. (`field-sizing: content` would do
  // this in CSS alone, but Firefox and Safari lack it.)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = scrollParent(el);
    const scrollTop = scroller?.scrollTop ?? 0;
    const cap = Math.min(COMPOSER_MAX_HEIGHT, window.innerHeight * 0.4);
    el.style.height = "auto";
    // scrollHeight leaves out the borders that the border-box height includes; add them so the text fits exactly.
    const borders = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + borders, cap)}px`;
    if (scroller) scroller.scrollTop = scrollTop;
  }, [value]);

  // The keyboard reference lives in the Save / send button's tooltip (and its accessible description), not under the box.
  // Each item is held together with no-break spaces so the wrapped tooltip breaks between shortcuts, never inside one.
  const mod = isMac ? "⌘" : "Ctrl";
  const shortcuts = [
    editing ? "Enter saves" : "Enter sends",
    "Shift+Enter newline",
    ...(editing ? ["Esc cancels"] : []),
    `${mod}+B bold`,
    `${mod}+I italic`,
    `${mod}+E code`,
    `${mod}+K link`,
    "@ mentions",
  ]
    .map((item) => item.replaceAll(" ", "\u00a0"))
    .join(" · ");

  /** Insert a suggestion block for the quoted text and select its contents so typing replaces them. */
  const insertSuggestion = () => {
    if (activeSubmission.current) return;
    const el = ref.current;
    if (!el || quote === undefined || parseSuggestionBlock(value)) return;
    const next = suggestionBlockFor(quote, value);
    setValue(next);
    setTrigger(null);
    const start = next.lastIndexOf(quote);
    scheduleFocusSelection(el, [start, start + quote.length]);
  };

  /** Apply a formatting shortcut to the textarea selection and restore the selection afterwards. */
  const applyFormat = (kind: "bold" | "italic" | "code" | "link") => {
    if (activeSubmission.current) return;
    const el = ref.current;
    if (!el) return;
    const { selectionStart, selectionEnd } = el;
    const r =
      kind === "link"
        ? wrapLink(el.value, selectionStart, selectionEnd)
        : wrapSelection(el.value, selectionStart, selectionEnd, kind === "bold" ? "**" : kind === "italic" ? "*" : "`");
    setValue(r.value);
    setTrigger(null);
    scheduleFocusSelection(el, [r.selectionStart, r.selectionEnd]);
  };

  const matches = useMemo(() => (trigger ? filterMentionCandidates(candidates, trigger.query, MAX_SUGGESTIONS) : []), [trigger, candidates]);
  // The popover also opens with no match for a user who has no agent yet: the "Connect an agent" row is the answer to
  // an `@` that finds nothing (#1025). It never opens for an edit, which cannot become a request.
  const connectDue = connect.due && request !== undefined;
  const open = trigger !== null && (matches.length > 0 || connectDue);

  // The mode row: only while the body names an agent the picker knows, and only on composers that can post a request.
  const agents = useMemo(() => (request ? mentionedAgents(value, candidates) : []), [request, value, candidates]);
  const showRow = request !== undefined && agents.length > 0;
  const effectiveMode: AgentRequestMode = request && !request.canEdit ? "comment" : mode;
  const modeDisabled = (id: AgentRequestMode) => id !== "comment" && request !== undefined && !request.canEdit;
  /** An agent as this user sees it: their own by its plain name, anyone else's as "Drew's Copilot CLI". */
  const nameOf = (c: MentionCandidate) => (c.agent ? agentDisplayName({ name: c.name, ownerLogin: c.agent.ownerLogin, ownerName: c.agent.ownerName }, viewerLogin) : c.name);
  const rowLabel = agents.length === 1 ? `How should ${nameOf(agents[0])} answer?` : "How should the agents answer?";
  // The request goes to the first agent mentioned (part A's `resolveAddressee`); when its owner has not opened it to
  // collaborators the composer says so and will not send, instead of letting the server answer 403 (#1296).
  const addressee = useMemo(() => {
    if (!showRow) return null;
    const first = parseAgentMentions(value)[0];
    const login = first ? `${first.login}/${first.agent}`.toLowerCase() : null;
    const hit = agents.find((c) => c.login.toLowerCase() === login);
    return hit?.agent ? (hit as MentionCandidate & { agent: MentionCandidateAgent }) : null;
  }, [showRow, value, agents]);
  const locked = addressee !== null && !addressee.agent.canAsk;

  /** A quick instruction goes right after the mention; once the body has text past it, at the caret instead. Focus stays in the box. */
  const insertInstruction = (text: string) => {
    if (activeSubmission.current) return;
    const el = ref.current;
    if (!el) return;
    const mentionEnd = lastAgentMentionEnd(value);
    let next: string;
    let pos: number;
    if (mentionEnd >= 0 && value.slice(mentionEnd).trim() === "") {
      const head = value.slice(0, mentionEnd).replace(/\s+$/, "");
      next = `${head} ${text}`;
      pos = next.length;
    } else {
      const caret = el.selectionStart ?? value.length;
      const before = value.slice(0, caret);
      const after = value.slice(caret);
      const lead = before && !/\s$/.test(before) ? " " : "";
      const trail = after && !/^\s/.test(after) ? " " : "";
      next = before + lead + text + trail + after;
      pos = (before + lead + text).length;
    }
    setValue(next);
    setTrigger(null);
    scheduleFocusSelection(el, [pos, pos]);
  };

  /** Arrow keys move through the modes; a disabled mode takes focus (so its tooltip can say why) without being chosen. */
  const onModeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (activeSubmission.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key === "ArrowUp" ? "ArrowLeft" : event.key === "ArrowDown" ? "ArrowRight" : event.key;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = rovingIndex(key, current, items.length, { orientation: "horizontal", wrap: true });
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
    const id = REQUEST_MODES[next]?.id;
    if (id && !modeDisabled(id)) setMode(id);
  };

  const pick = (c: MentionCandidate) => {
    if (activeSubmission.current) return;
    const el = ref.current;
    if (!el || !trigger) return;
    const caret = el.selectionStart;
    const insert = `@${c.login} `;
    const next = value.slice(0, trigger.start) + insert + value.slice(caret);
    setValue(next);
    setTrigger(null);
    const pos = trigger.start + insert.length;
    scheduleFocusSelection(el, [pos, pos]);
  };

  const submit = async () => {
    const body = value.trim();
    const visit = activeVisit.current;
    if (!visit || activeSubmission.current || !body || locked) return;
    const submittedRequest = showRow ? { mode: effectiveMode, agents: [...agents] } : null;
    const owner: ComposerSubmissionOwner = {
      visit,
      operation: ++operationSequence.current,
      body,
      request: submittedRequest,
      agentIdentities: submittedRequest?.agents.map((agent) => agent.login) ?? [],
    };
    cancelComposerDeferredWork(visit);
    activeSubmission.current = owner;
    setBusy(true);
    try {
      const result = await onSubmit(owner.body, owner.request);
      if (ownsSubmission(owner)) {
        setValue("");
        setTrigger(null);
        onSuccess?.(result, owner.body, owner.request);
      }
    } catch (reason) {
      if (ownsSubmission(owner)) throw reason;
    } finally {
      if (ownsSubmission(owner)) {
        activeSubmission.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <div className="@container flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
      <Popover open={open} onOpenChange={(o) => !o && !activeSubmission.current && setTrigger(null)}>
        <PopoverAnchor asChild>
          <textarea
            ref={ref}
            className="textarea min-h-[64px] resize-none text-[13px]"
            placeholder={placeholder}
            value={value}
            disabled={busy}
            aria-busy={busy || undefined}
            onPointerDown={(e) => recordCaretAction(e.currentTarget, e.nativeEvent)}
            onFocus={(e) => recordCaretAction(e.currentTarget, e.nativeEvent)}
            onChange={(e) => {
              if (activeSubmission.current) return;
              recordCaretAction(e.currentTarget, e.nativeEvent);
              setValue(e.target.value);
              syncTrigger(e.target);
            }}
            onSelect={(e) => {
              if (!activeSubmission.current) {
                recordCaretAction(e.currentTarget, e.nativeEvent);
                syncTrigger(e.currentTarget);
              }
            }}
            onBlur={(e) => {
              if (activeSubmission.current) return;
              recordCaretAction(e.currentTarget, e.nativeEvent);
              scheduleBlurDismissal(e.currentTarget);
            }}
            onKeyDown={(e) => {
              if (activeSubmission.current) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              recordCaretAction(e.currentTarget, e.nativeEvent);
              const mod = e.metaKey || e.ctrlKey;
              if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "s" && quote !== undefined) {
                e.preventDefault();
                e.stopPropagation();
                insertSuggestion();
                return;
              }
              // Formatting shortcuts belong to the composer; never let the editor's Ctrl+K / Ctrl+B handlers see them.
              if (mod && !e.altKey && !e.shiftKey) {
                const key = e.key.toLowerCase();
                const kind = key === "b" ? "bold" : key === "i" ? "italic" : key === "e" ? "code" : key === "k" ? "link" : null;
                if (kind) {
                  e.preventDefault();
                  e.stopPropagation();
                  applyFormat(kind);
                  return;
                }
              }
              if (open) {
                if (matches.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setHighlight((h) => (h + 1) % matches.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setHighlight((h) => (h - 1 + matches.length) % matches.length);
                    return;
                  }
                  if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
                    e.preventDefault();
                    pick(matches[highlight] ?? matches[0]);
                    return;
                  }
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setTrigger(null);
                  return;
                }
              }
              // Enter sends, Shift+Enter inserts a newline (Ctrl/⌘+Enter still sends).
              if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
                e.preventDefault();
                e.stopPropagation();
                void submit();
                return;
              }
              // Esc cancels (an edit restores the original body); with the mention popover open it only closed that, above.
              if (e.key === "Escape" && onCancel) {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
              }
            }}
            data-testid="comment-composer"
          />
        </PopoverAnchor>
        <PopoverContent
          side="bottom"
          align="start"
          className="w-64 p-1.5"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (e.target === ref.current) e.preventDefault();
          }}
          data-testid="mention-suggestions"
        >
          {matches.length > 0 && (
            <ul role="listbox" aria-label="Mention someone">
              {matches.map((c, i) => {
                // Someone else's agent whose owner has not opened it to collaborators: greyed, with a lock and the reason
                // (#1296). It can still be picked — the mention is legitimate — but the composer will not send a request.
                const lockedAgent = c.agent && !c.agent.canAsk ? c.agent : null;
                const lockedRow = lockedAgent !== null;
                const reason = lockedAgent ? `Only ${agentOwnerName(lockedAgent)} can ask this agent` : undefined;
                return (
                  <li
                    key={c.login}
                    role="option"
                    aria-selected={i === highlight}
                    aria-disabled={busy || lockedRow || undefined}
                    className={cn("menu-item py-1.5", i === highlight && "bg-surface-3", lockedRow && "text-ink-3")}
                    title={reason}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => pick(c)}
                    data-testid="mention-option"
                    data-login={c.login}
                    data-agent={c.agent ? "" : undefined}
                    data-own={c.own ? "" : undefined}
                    data-locked={lockedRow ? "" : undefined}
                  >
                    {c.agent ? <AuthorAvatar id="agent:" name={c.name} size={20} /> : <Avatar name={c.name} src={c.image} size={20} />}
                    <span className="min-w-0 flex-1 truncate text-[13px]">{nameOf(c)}</span>
                    {c.agent ? (
                      <span
                        className={cn("flex min-w-0 items-center gap-1 truncate text-xs", lockedRow ? "text-ink-3" : "text-ink-4")}
                        title={reason ?? (c.own ? "One of your API tokens; it has not been in this document yet" : `Agent of @${c.agent.ownerLogin}`)}
                      >
                        {lockedRow && <Lock size={11} aria-hidden="true" className="shrink-0" />}
                        {c.own ? "your agent · not here yet" : lockedRow ? "owner only" : "agent"}
                      </span>
                    ) : (
                      <span className="truncate text-xs text-ink-3">@{c.login}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {/* No agent to mention yet: a footer that leads to Settings → API tokens, once per browser (#1025). Pointer
              actions keep the caret in the box (mousedown is swallowed) so the picker does not close under the click. */}
          {connectDue && (
            <div className={cn("mention-connect-row", matches.length > 0 && "mention-connect-row-under")} data-testid="mention-connect-row">
              <Bot size={14} className="shrink-0 text-ink-4" aria-hidden />
              <span className="min-w-0 flex-1 text-xs text-ink-3">
                No agent connected yet —{" "}
                {connect.onCreateToken && (
                  <button type="button" className="font-medium text-accent hover:underline" onMouseDown={(e) => e.preventDefault()} onClick={connect.onCreateToken} data-testid="mention-connect-agent">
                    Connect an agent
                  </button>
                )}
                {connect.onCreateToken && " · "}
                <a href={AGENT_DOCS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-accent hover:underline" onMouseDown={(e) => e.preventDefault()} data-testid="mention-connect-docs">
                  Agent docs
                  <ExternalLink size={11} aria-hidden />
                </a>
              </span>
              <button type="button" className="icon-btn h-5 w-5 shrink-0 text-ink-4 hover:text-ink" onMouseDown={(e) => e.preventDefault()} onClick={connect.onDismiss} aria-label="Dismiss" data-testid="mention-connect-dismiss">
                <X size={12} />
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {/* Mentioning an agent turns the comment into a request: this row chooses how it answers. Controls only — no
          hint text under the box (Burke); the question is the group's accessible name. It appears and goes with the
          mention and never takes focus: typing carries on in the box. */}
      {showRow && (
        <div className="composer-agent-row" data-testid="composer-agent-row">
          <div className="composer-modes" role="radiogroup" aria-label={rowLabel} onKeyDown={onModeKeyDown}>
            {REQUEST_MODES.map((m) => {
              const disabled = modeDisabled(m.id);
              const checked = effectiveMode === m.id;
              const radio = (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-disabled={busy || disabled || undefined}
                  disabled={busy}
                  tabIndex={checked ? 0 : -1}
                  className="composer-mode"
                  // Choosing a mode with the pointer must not pull focus out of the textarea (Enter still posts).
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (!disabled && !activeSubmission.current) setMode(m.id);
                  }}
                  data-testid={`composer-mode-${m.id}`}
                >
                  {m.label}
                </button>
              );
              return disabled ? (
                <Tip key={m.id} label="Needs edit access" side="top">
                  {radio}
                </Tip>
              ) : (
                radio
              );
            })}
          </div>
          <div className="composer-chips" role="group" aria-label="Quick instructions">
            {QUICK_INSTRUCTIONS.map((q) => (
              <button key={q} type="button" className="composer-chip" onMouseDown={(e) => e.preventDefault()} onClick={() => insertInstruction(q)} disabled={busy} data-testid="composer-chip">
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
      {/* The agent named first is someone else's and its owner keeps it to themself: say so here, before the server
          would (403 agent-owner-only), and hold the send. A sibling of the row, not inside it: the row is controls only. */}
      {locked && addressee && (
        <p className="flex items-start gap-1.5 text-xs text-ink-3" role="status" data-testid="agent-owner-only">
          <Lock size={12} aria-hidden="true" className="mt-px shrink-0" />
          <span>{agentOwnerOnlyMessage(addressee, viewerLogin)}</span>
        </p>
      )}
      {/* Nothing sits between the box and its buttons (Burke, #4138): the shortcuts are in the Save / send button's tooltip.
          One row, single-line labels: below ~21rem of composer width (the 340 px panel) "Suggest a change"
          is icon-only — the tooltip and aria-label carry the name — so the three buttons never wrap. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {quote !== undefined && (
          <button
            type="button"
            className="btn btn-ghost btn-sm mr-auto min-w-8 gap-1.5 whitespace-nowrap px-2 @min-[21rem]:px-3"
            onClick={insertSuggestion}
            disabled={busy || parseSuggestionBlock(value) !== null}
            title="Suggest a change (Ctrl+Shift+S)"
            aria-label="Suggest a change"
            data-testid="comment-suggest-change"
          >
            <Wand2 size={13} /> <span className="hidden @min-[21rem]:inline">Suggest a change</span>
          </button>
        )}
        {onCancel && (
          <button
            type="button"
            className="btn btn-ghost btn-sm whitespace-nowrap"
            onClick={() => {
              if (!activeSubmission.current) onCancel();
            }}
            disabled={busy}
          >
            Cancel
          </button>
        )}
        <Tip label={shortcuts} side="top" wrap testId="composer-shortcuts">
          {/* aria-description is ARIA 1.3: Chrome, Firefox 119+, Safari 16.4+ and axe-core know it, jsx-a11y's ARIA 1.2 table does not yet. */}
          {/* eslint-disable-next-line jsx-a11y/role-supports-aria-props */}
          <button
            type="button"
            className="btn btn-primary btn-sm whitespace-nowrap"
            disabled={!value.trim() || busy || locked}
            onClick={submit}
            // Read after the button's name by screen readers, so keyboard users get the shortcuts without hovering.
            // (Not aria-label, which would replace "Save"; not title, which would add a second, native tooltip.)
            aria-description={shortcuts}
            data-testid="comment-submit"
          >
            {submitLabel}
          </button>
        </Tip>
      </div>
    </div>
  );
}

/** How long a "Done: 2 suggestions" chip keeps its detail before collapsing to a plain Done check. */
const DONE_DETAIL_MS = 60_000;

/** How long an optimistically cancelled request stays hidden before it may come back (the server refused), as the header does (#981). */
const CANCEL_GRACE_MS = 8_000;

/**
 * The request a thread carries, as a soft pill in the card header: Waiting for an agent → <agent> is working… →
 * Done: 2 suggestions (then a plain Done once the detail is a minute old). A cancelled request shows nothing.
 * Someone else's agent is named with its owner ("Drew's Copilot CLI is working…"); your own by its plain name.
 * The × cancels for the requester or the document owner; it hides at once and comes back only if the server refuses.
 */
function RequestChip({ request, canCancel, onCancel }: { request: AgentRequestMirror; canCancel: boolean; onCancel?: (requestId: string) => void }) {
  // Not MentionCandidatesContext: that value changes with every presence event, and a card must not re-render for those (#1382).
  const { viewerLogin, nameOf } = useContext(AgentNamesContext);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pending = request.status === "open" || request.status === "claimed";
  useEffect(() => {
    if (!cancelling) return;
    if (!pending) {
      setCancelling(false);
      return;
    }
    const t = setTimeout(() => setCancelling(false), CANCEL_GRACE_MS);
    return () => clearTimeout(t);
  }, [cancelling, pending]);
  const detailUntil = request.updatedAt + DONE_DETAIL_MS;
  const showDetail = request.status === "done" && now < detailUntil;
  useEffect(() => {
    if (!showDetail) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, detailUntil - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [showDetail, detailUntil]);
  if (request.status === "cancelled" || cancelling) return null;
  const label =
    request.status === "open"
      ? "Waiting for an agent"
      : request.status === "claimed"
        ? `${claimerName(request, viewerLogin, nameOf)} is working…`
        : showDetail
          ? `Done: ${describeResult(request.result)}`
          : "Done";
  return (
    <span className="request-chip" data-testid="comment-request-chip" data-status={request.status} data-request-id={request.id} onClick={(e) => e.stopPropagation()}>
      {request.status === "open" ? (
        <Hourglass size={11} aria-hidden="true" className="shrink-0" />
      ) : request.status === "claimed" ? (
        <Loader2 size={11} aria-hidden="true" className="shrink-0 animate-spin" />
      ) : (
        <Check size={11} aria-hidden="true" className="shrink-0" />
      )}
      <span className="request-chip-label">{label}</span>
      {pending && canCancel && onCancel && (
        <button
          type="button"
          className="request-chip-cancel"
          aria-label="Cancel request"
          title="Cancel request"
          onClick={() => {
            setCancelling(true);
            onCancel(request.id);
          }}
          data-testid="comment-request-cancel"
        >
          <X size={11} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

const ThreadCard = memo(function ThreadCard({
  thread,
  session,
  actionCoordinator,
  outdated,
  active,
  onReveal,
  ops,
  unread,
  onToast,
  request,
  canRequestEdits,
  onCancelRequest,
  onRequest,
}: {
  thread: CommentThread;
  session: CollabSession;
  actionCoordinator: CommentRowActionCoordinator;
  outdated: boolean;
  active: boolean;
  onReveal: (offset: number) => void;
  ops: ReturnType<typeof useCommentOps>;
  /** The current user has unread notifications about this thread. */
  unread?: boolean;
  onToast?: CommentsPanelProps["onToast"];
  /** The latest agent request made from this thread, if any (see useThreadRequests). */
  request?: AgentRequestMirror | null;
  /** `session.canEdit`: whether a reply that mentions an agent may ask for tracked changes / a rewrite. */
  canRequestEdits: boolean;
  onCancelRequest?: (requestId: string) => void;
  /** Posts an agent request for a reply that mentioned one (after the reply itself landed). */
  onRequest?: (threadId: string, body: string, mode: AgentRequestMode) => void;
}) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); // "root" or reply id
  const me = session.user.id;
  const canModerate = session.role === "owner";
  const canComment = session.canComment;
  const canEdit = session.role === "owner" || session.role === "editor";
  // Same rule as the header's Requests section (#981): the requester or the document owner may cancel.
  const canCancelRequest = !!onCancelRequest && !!request && (request.userId === me || canModerate);
  const rowActions = useCommentRowActions(actionCoordinator, thread);
  const rootAction = rowActions.state(null);
  const rootBusy = rootAction.pending !== null || rootAction.batch !== null;
  const rootDeleteBlocked = rootBusy || rowActions.hasPendingReply;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);
  // Opening the thread reads every notification about it (the thread itself and its replies).
  const replyIds = thread.replies.map((r) => r.id).join(",");
  useEffect(() => {
    if (active && unread) void markRefsRead(session.docId, [thread.id, ...replyIds.split(",").filter(Boolean)]);
  }, [active, unread, session.docId, thread.id, replyIds]);

  const suggestion = useMemo(() => parseSuggestionBlock(thread.body), [thread.body]);
  const suggestionState = suggestion ? thread.suggestionState ?? (outdated ? "outdated" : "pending") : null;
  const editingRoot = editing === "root" && !thread.suggestionState;
  // A comment on the whole document (#1025): "Whole document" where the quote would be, no Accept on its
  // suggestions (there is no anchored text to replace; the model refuses too), no "Suggest a change" in its replies.
  const isDocument = isDocumentRange(thread.range);
  const canAcceptHere = canEdit && !isDocument;

  const accept = async (block: SuggestionBlock, reply: CommentReply | null = null) => {
    if (rowActions.blocked(reply?.id ?? null)) return;
    const ok = await ops.acceptSuggestion(thread.id, block.text, reply?.id);
    if (!ok) {
      onToast?.("The quoted text changed — this suggestion is outdated.", "error");
      return;
    }
    onToast?.(`Accepted suggestion from ${reply?.authorName ?? thread.authorName}.`, "success", { label: "Undo", onClick: () => session.undo() });
  };

  // The card itself is the "show me the text" control; a thread whose text is gone still becomes
  // active and says why the document did not move, instead of silently doing nothing.
  const reveal = () => {
    session.setActiveComment(thread.id);
    if (thread.range) onReveal(thread.range.from);
    else onToast?.("The text this comment referred to was removed.", "info");
  };
  const onCardClick = (event: MouseEvent<HTMLDivElement>) => {
    const control = (event.target as HTMLElement).closest(CARD_CONTROLS);
    if (control && event.currentTarget.contains(control)) return;
    reveal();
  };
  const onCardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    reveal();
  };
  const resolveThread = () => {
    if (rowActions.blocked(null)) return;
    if (session.commentsViaApi) rowActions.run(null, { type: "resolve", resolved: !thread.resolved });
    else void ops.resolve(thread.id, !thread.resolved);
  };
  const deleteTarget = (replyId: string | null) => {
    if (rowActions.blocked(replyId) || (replyId === null && rowActions.hasPendingReply)) return;
    if (session.commentsViaApi) rowActions.run(replyId, { type: "delete" });
    else void ops.remove(thread.id, replyId ?? undefined);
  };
  const reactTo = (replyId: string | null, reactions: Reactions, emoji: string) => {
    if (rowActions.blocked(replyId)) return;
    if (session.commentsViaApi) rowActions.run(replyId, { type: "react", emoji, reacted: !reactions[emoji]?.includes(me) });
    else void ops.react(thread.id, replyId, emoji);
  };

  return (
    <div
      ref={ref}
      className={cn(
        "relative rounded-xl border p-3 transition-shadow",
        thread.resolved ? "bg-surface/80" : "bg-surface",
        active ? "border-accent shadow-md shadow-accent/10" : "border-line hover:border-line-2",
      )}
      data-unread={unread || undefined}
      data-suggestion={suggestionState ?? undefined}
      role="article"
      aria-label={`Comment by ${thread.authorName}`}
      tabIndex={0}
      onClick={onCardClick}
      onKeyDown={onCardKeyDown}
      data-testid="comment-thread"
      data-thread-id={thread.id}
    >
      {unread && <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-accent" aria-label="Unread activity" data-testid="thread-unread-dot" />}
      {isDocument ? (
        <div className="comment-quote-document" title="A comment on the whole document" data-testid="comment-quote-document">
          <FileText size={12} aria-hidden />
          Whole document
        </div>
      ) : (
        thread.quote && (
          <div className={QUOTE_CLASS} title={thread.quote} data-testid="comment-quote">
            {thread.range ? thread.quote : <span className="italic">(original text removed) </span>}
          </div>
        )
      )}
      <div className="flex items-start gap-2.5">
        <AuthorAvatar id={thread.authorId} name={thread.authorName} src={thread.authorAvatar} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="truncate text-[13px] font-semibold text-ink">{thread.authorName}</span>
            <span className="shrink-0 text-xs text-ink-4" data-testid="comment-timestamp">
              {relativeTime(thread.createdAt)}
            </span>
            <EditedMarker at={thread.editedAt} />
            {request && <RequestChip request={request} canCancel={canCancelRequest} onCancel={onCancelRequest} />}
          </div>
          {/* While editing, the composer takes the full card width below this row (see after the row). */}
          {!editingRoot && (
            <>
              <MentionBody body={thread.body} className="mt-0.5 text-[13px] leading-5 text-ink-2" />
              {suggestion && suggestionState && (
                <div className="suggestion-box mt-2" onClick={(e) => e.stopPropagation()} data-testid="suggestion-box" data-state={suggestionState}>
                  <div className="suggestion-box-head">
                    <Wand2 size={12} aria-hidden />
                    <span>Suggested change</span>
                    {suggestionState === "outdated" && (
                      <span className="suggestion-badge" data-testid="suggestion-outdated" title="The quoted text changed since this was suggested">
                        Outdated
                      </span>
                    )}
                    {suggestionState === "accepted" && <span className="suggestion-badge suggestion-badge-ok">Accepted</span>}
                    {suggestionState === "rejected" && <span className="suggestion-badge">Rejected</span>}
                    {suggestion.warning && <span className="ml-auto text-[11px] text-ink-4">{suggestion.warning}</span>}
                  </div>
                  <SuggestionText text={suggestion.text} />
                  <SuggestionActions
                    state={suggestionState}
                    canAccept={canAcceptHere}
                    canReject={canComment}
                    disabled={rootBusy}
                    onAccept={() => accept(suggestion)}
                    onReject={() => {
                      if (!rowActions.blocked(null)) return ops.rejectSuggestion(thread.id);
                    }}
                  />
                </div>
              )}
              <ReactionRow reactions={thread.reactions} names={thread.reactorNames} me={me} canReact={canComment} disabled={rootBusy} onToggle={(emoji) => reactTo(null, thread.reactions, emoji)} />
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          {canComment && (
            <button
              type="button"
              className="icon-btn h-7 w-7"
              title={thread.resolved ? "Re-open" : "Resolve"}
              aria-label={thread.resolved ? "Re-open" : "Resolve"}
              disabled={rootBusy}
              aria-busy={rootBusy || undefined}
              onClick={resolveThread}
              data-testid="comment-resolve"
            >
              {thread.resolved ? <RotateCcw size={15} /> : <Check size={16} />}
            </button>
          )}
          {(thread.authorId === me || canModerate) && (
            <LazyMenu
              align="end"
              className="w-40"
              trigger={
                <button type="button" className="icon-btn h-7 w-7" aria-label="Comment actions" disabled={rootBusy} aria-busy={rootBusy || undefined}>
                  <MoreHorizontal size={16} />
                </button>
              }
            >
              {thread.authorId === me && !thread.suggestionState && (
                <MenuItem icon={<Pencil size={14} />} disabled={rootBusy} onSelect={() => setEditing("root")}>
                  Edit
                </MenuItem>
              )}
              <MenuItem icon={<Trash2 size={14} />} className="text-danger" disabled={rootDeleteBlocked} onSelect={() => deleteTarget(null)}>
                Delete thread
              </MenuItem>
            </LazyMenu>
          )}
        </div>
      </div>
      <CommentActionFeedback state={rootAction} />
      {editingRoot && (
        <div className="mt-1" data-testid="comment-edit">
          <Composer
            placeholder="Edit comment"
            initial={thread.body}
            autoFocus
            editing
            submitLabel="Save"
            onSubmit={(body) => ops.edit(thread.id, body)}
            onSuccess={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}

      {thread.replies.length > 0 && (
        <div className="mt-3 flex flex-col gap-3 border-l border-line pl-3">
          {thread.replies.map((r) => {
            const block = parseSuggestionBlock(r.body);
            const state = block ? r.suggestionState ?? (outdated ? "outdated" : "pending") : null;
            const editingReply = editing === r.id && !r.suggestionState;
            const replyAction = rowActions.state(r.id);
            const replyBusy = replyAction.pending !== null || replyAction.batch !== null;
            const replyBlocked = replyBusy || rowActions.rootDeleting;
            return (
              <div key={r.id} data-testid="comment-reply" data-reply-id={r.id} data-state={state ?? undefined}>
                <div className="flex items-start gap-2.5">
                  <AuthorAvatar id={r.authorId} name={r.authorName} src={r.authorAvatar} size={24} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-[13px] font-semibold text-ink">{r.authorName}</span>
                      <span className="shrink-0 text-xs text-ink-4" data-testid="comment-timestamp">
                        {relativeTime(r.createdAt)}
                      </span>
                      <EditedMarker at={r.editedAt} />
                    </div>
                    {!editingReply && (
                      <>
                        <MentionBody body={r.body} className="mt-0.5 text-[13px] leading-5 text-ink-2" />
                        {block && state && (
                          <div className="suggestion-box mt-1.5" onClick={(event) => event.stopPropagation()} data-testid="suggestion-box" data-state={state}>
                            <div className="suggestion-box-head">
                              <Wand2 size={12} aria-hidden />
                              <span>Suggested change</span>
                              {state === "outdated" && (
                                <span className="suggestion-badge" data-testid="suggestion-outdated" title="The quoted text changed since this was suggested">
                                  Outdated
                                </span>
                              )}
                              {state === "accepted" && <span className="suggestion-badge suggestion-badge-ok">Accepted</span>}
                              {state === "rejected" && <span className="suggestion-badge">Rejected</span>}
                              {block.warning && <span className="ml-auto text-[11px] text-ink-4">{block.warning}</span>}
                            </div>
                            <SuggestionText text={block.text} />
                            <SuggestionActions
                              state={state}
                              canAccept={canAcceptHere}
                              canReject={canComment}
                              disabled={replyBlocked}
                              onAccept={() => accept(block, r)}
                              onReject={() => {
                                if (!rowActions.blocked(r.id)) return ops.rejectSuggestion(thread.id, r.id);
                              }}
                            />
                          </div>
                        )}
                        <ReactionRow reactions={r.reactions} names={thread.reactorNames} me={me} canReact={canComment} disabled={replyBlocked} onToggle={(emoji) => reactTo(r.id, r.reactions, emoji)} />
                      </>
                    )}
                  </div>
                  {(r.authorId === me || canModerate) && (
                    <div onClick={(e) => e.stopPropagation()}>
                      <LazyMenu
                        align="end"
                        className="w-36"
                        trigger={
                          <button type="button" className="icon-btn h-6 w-6" aria-label="Reply actions" disabled={replyBlocked} aria-busy={replyBusy || undefined}>
                            <MoreHorizontal size={14} />
                          </button>
                        }
                      >
                        {r.authorId === me && !r.suggestionState && (
                          <MenuItem icon={<Pencil size={14} />} disabled={replyBlocked} onSelect={() => setEditing(r.id)}>
                            Edit
                          </MenuItem>
                        )}
                        <MenuItem icon={<Trash2 size={14} />} className="text-danger" disabled={replyBlocked} onSelect={() => deleteTarget(r.id)}>
                          Delete
                        </MenuItem>
                      </LazyMenu>
                    </div>
                  )}
                </div>
                <CommentActionFeedback state={replyAction} />
                {editingReply && (
                  <div className="mt-1" data-testid="comment-edit">
                    <Composer
                      placeholder="Edit reply"
                      initial={r.body}
                      autoFocus
                      editing
                      submitLabel="Save"
                      onSubmit={(body) => ops.edit(thread.id, body, r.id)}
                      onSuccess={() => setEditing(null)}
                      onCancel={() => setEditing(null)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {canComment && !thread.resolved && (
        <div className="mt-3" onClick={(e) => e.stopPropagation()}>
          {replying ? (
            <Composer
              placeholder="Reply…"
              autoFocus
              submitLabel="Reply"
              quote={thread.range && !isDocument ? thread.quote : undefined}
              request={onRequest ? { canEdit: canRequestEdits, defaultMode: request?.mode ?? "suggest" } : undefined}
              onSubmit={(body) => ops.reply(thread.id, body)}
              onSuccess={(_result, body, req) => {
                setReplying(false);
                if (req && onRequest) onRequest(thread.id, body, req.mode);
              }}
              onCancel={() => setReplying(false)}
            />
          ) : (
            <button type="button" className="inline-flex min-h-6 items-center gap-1.5 text-xs font-medium text-ink-3 hover:text-accent" onClick={() => setReplying(true)} data-testid="comment-reply">
              <Reply size={13} /> Reply
            </button>
          )}
        </div>
      )}
      {thread.resolved && (
        <div className="mt-2 inline-flex items-center gap-1 text-xs text-success" data-testid="comment-resolved-state">
          <CheckCheck size={13} /> Resolved {thread.resolvedAt ? relativeTime(thread.resolvedAt) : ""}
        </div>
      )}
    </div>
  );
});

function SuggestionCard({ s, session, active, onReveal, onToast }: { s: SuggestionGroup; session: CollabSession; active: boolean; onReveal: (offset: number) => void; onToast?: CommentsPanelProps["onToast"] }) {
  const canAct = session.role === "owner" || session.role === "editor";
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);
  const [error, setError] = useState<string | null>(null);
  const decide = (action: "accept" | "reject") => {
    try {
      if (session.reviewSuggestion(action, s.id)) {
        onToast?.(`${action === "accept" ? "Accepted" : "Rejected"} suggestion from ${s.authorName}.`, "success", { label: "Undo", onClick: () => session.undo() });
      }
    } catch (error) {
      if (!(error instanceof SuggestionConflictError)) throw error;
      setError(error.message);
    }
  };
  return (
    <div
      ref={ref}
      className={cn("rounded-xl border bg-surface p-3", active ? "border-accent shadow-md shadow-accent/10" : "border-line hover:border-line-2")}
      onClick={() => {
        session.setActiveSuggestion(s.id);
        onReveal(s.from);
      }}
      data-testid="suggestion-card"
      data-suggestion-id={s.id}
    >
      <div className="flex items-start gap-2.5">
        <AuthorAvatar id={s.authorId} name={s.authorName} src={s.authorAvatar} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-semibold text-ink">{s.authorName}</span>
            <span className="shrink-0 text-xs text-ink-4" data-testid="comment-timestamp">
              {relativeTime(s.createdAt)}
            </span>
          </div>
          <div className="mt-0.5 space-y-1 whitespace-pre-wrap break-words text-[13px] leading-5 text-ink-2">
            <span className="font-medium">{s.type === "replace" ? "Replace passage" : s.type === "insert" ? "Add" : "Delete"}:</span>
            {s.before && <del className="block rounded bg-red-50 px-1 text-red-800 dark:bg-red-950/50 dark:text-red-300" data-testid="suggestion-before">{s.before}</del>}
            {s.after && <ins className="block rounded bg-green-50 px-1 text-green-800 dark:bg-green-950/50 dark:text-green-300" data-testid="suggestion-after">{s.after}</ins>}
          </div>
        </div>
      </div>
      {(s.outdated || error) && <p className="mt-2 text-xs text-danger" role="alert">{error ?? "This suggestion overlaps a newer edit. Review the changed text before deciding it."}</p>}
      {canAct && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="btn btn-sm btn-outline gap-1.5 text-success" disabled={s.outdated} onClick={() => decide("accept")} data-testid="suggestion-accept">
            <ThumbsUp size={14} /> Accept
          </button>
          <button type="button" className="btn btn-sm btn-outline gap-1.5 text-danger" disabled={s.outdated} onClick={() => decide("reject")} data-testid="suggestion-reject">
            <ThumbsDown size={14} /> Reject
          </button>
        </div>
      )}
    </div>
  );
}

/** Threads of a review that still exist in the document (a deleted thread simply drops out). */
function reviewThreads(review: ReviewDto, threads: CommentThread[]): CommentThread[] {
  return threads.filter((t) => review.threadIds.includes(t.id));
}

/**
 * A review is open while one of its threads is unresolved or still carries a pending (or outdated)
 * suggestion. Once every suggestion is decided and every thread resolved — or all of its threads were
 * deleted — it is resolved and lists at the top of the Resolved tab instead of Open (Burke, task #994).
 */
export function isReviewOpen(review: ReviewDto, threads: CommentThread[], text: string): boolean {
  const mine = reviewThreads(review, threads);
  if (mine.some((t) => !t.resolved)) return true;
  return commentSuggestionTargets(mine, text).some((target) => target.state === "pending" || target.state === "outdated");
}

function snapshotCommentSuggestionTarget(session: CollabSession, target: CommentSuggestionTarget): CommentSuggestionBatchTarget | null {
  const replyId = target.reply?.id ?? null;
  const identity = storedCommentTargetIdentity(session, target.thread.id, replyId);
  const current = session.comments.get(target.thread.id);
  const currentBody = replyId === null ? current?.body : current?.replies.find((reply) => reply.id === replyId)?.body;
  if (!identity || currentBody !== (target.reply?.body ?? target.thread.body) || parseSuggestionBlock(currentBody ?? "")?.text !== target.block.text) return null;
  return Object.freeze({
    kind: "comment-suggestion",
    key: commentTargetKey(target.thread.id, replyId),
    threadId: target.thread.id,
    replyId,
    identity,
    body: currentBody,
    proposed: target.block.text,
    initiallyOutdated: target.state === "outdated",
  });
}

function snapshotCommentResolveTarget(session: CollabSession, thread: CommentThread): CommentResolveBatchTarget | null {
  const identity = storedCommentTargetIdentity(session, thread.id, null);
  const current = session.comments.get(thread.id);
  if (!identity || !current || current.resolved) return null;
  return Object.freeze({
    kind: "comment-resolve",
    key: commentTargetKey(thread.id, null),
    threadId: thread.id,
    replyId: null,
    identity,
  });
}

function indexLocalSuggestionGroups(groups: readonly SuggestionGroup[]): ReadonlyMap<string, SuggestionGroup> {
  return new Map(groups.map((group) => [group.id, group]));
}

function snapshotLocalSuggestionTarget(
  session: CollabSession,
  suggestion: SuggestionGroup,
  currentGroups: ReadonlyMap<string, SuggestionGroup>,
): LocalSuggestionBatchTarget | null {
  const memberIds = suggestion.members.map((member) => member.id);
  const memberIdentities = memberIds.map((id) => session.suggestions.ymap.get(id));
  if (memberIdentities.some((identity) => !identity)) return null;
  const current = currentGroups.get(suggestion.id);
  if (!current || current.members.map((member) => member.id).join("\0") !== memberIds.join("\0") || current.before !== suggestion.before || current.after !== suggestion.after) return null;
  return Object.freeze({
    kind: "local-suggestion",
    key: localSuggestionTargetKey(suggestion.id),
    suggestionId: suggestion.id,
    memberIds: Object.freeze(memberIds),
    memberIdentities: Object.freeze(memberIdentities as object[]),
    before: suggestion.before,
    after: suggestion.after,
  });
}

function snapshotLocalSuggestionTargets(
  session: CollabSession,
  sources: readonly SuggestionGroup[],
  currentGroups: readonly SuggestionGroup[],
): readonly (LocalSuggestionBatchTarget | null)[] {
  const index = indexLocalSuggestionGroups(currentGroups);
  return sources.map((source) => snapshotLocalSuggestionTarget(session, source, index));
}

function commentSuggestionTargetStatus(session: CollabSession, target: CommentSuggestionBatchTarget): "ready" | "outdated" | "missing" {
  if (!sameCommentTargetIdentity(session, target)) return "missing";
  const thread = session.comments.get(target.threadId);
  const item = target.replyId === null ? thread : thread?.replies.find((reply) => reply.id === target.replyId);
  if (!thread || !item || item.body !== target.body || parseSuggestionBlock(item.body)?.text !== target.proposed) return "missing";
  if (item.suggestionState) return "outdated";
  return isSuggestionOutdated(thread, session.ytext.toString()) ? "outdated" : "ready";
}

function resolveTargetStatus(session: CollabSession, target: CommentResolveBatchTarget): "ready" | "outdated" | "missing" {
  if (!sameCommentTargetIdentity(session, target)) return "missing";
  const thread = session.comments.get(target.threadId);
  if (!thread) return "missing";
  return thread.resolved ? "outdated" : "ready";
}

function sameCommentBatchTargetDefinition(session: CollabSession, target: CommentSuggestionBatchTarget | CommentResolveBatchTarget): boolean {
  if (!sameCommentTargetIdentity(session, target)) return false;
  if (target.kind === "comment-resolve") return session.comments.get(target.threadId) !== null;
  const thread = session.comments.get(target.threadId);
  const item = target.replyId === null ? thread : thread?.replies.find((reply) => reply.id === target.replyId);
  return !!item && item.body === target.body && parseSuggestionBlock(item.body)?.text === target.proposed;
}

function commentBatchResult(owner: CommentBatchOwner, done: number, failed: number, skipped: number): { message: string; kind: "success" | "error" } {
  const accepting = owner.action === "review-accept" || owner.action === "suggestions-accept";
  const resolving = owner.action === "review-resolve";
  const noun = resolving ? "comment" : "suggestion";
  const verb = resolving ? "Resolved" : accepting ? "Accepted" : "Rejected";
  const author = owner.authorName ? ` from ${owner.authorName}` : "";
  const base = `${verb} ${done} ${noun}${done === 1 ? "" : "s"}${author}.`;
  if (failed === 0 && skipped === 0) return { message: base, kind: "success" };
  return {
    message: `${base.slice(0, -1)} (${done} done, ${failed} failed, ${skipped} outdated skipped).`,
    kind: failed > 0 ? "error" : "success",
  };
}

async function executeCommentBatch(
  coordinator: CommentRowActionCoordinator,
  owner: CommentBatchOwner,
  ops: Pick<ReturnType<typeof useCommentOps>, "acceptSuggestion" | "rejectSuggestion" | "resolve">,
  onToast?: CommentsPanelProps["onToast"],
  reviewSuggestion?: CollabSession["reviewSuggestion"],
) {
  let done = 0;
  let failed = 0;
  let skipped = 0;
  let index = 0;
  const accepting = owner.action === "review-accept" || owner.action === "suggestions-accept";
  const localTargets = owner.targets.filter((target): target is LocalSuggestionBatchTarget => target.kind === "local-suggestion");

  if (localTargets.length > 0) {
    if (!currentCommentBatchContext(coordinator, owner)) return;
    const currentReviewSuggestion = owner.session.reviewSuggestion;
    const currentLocalGroups = owner.session.suggestions.groups(owner.session.ytext.toString());
    const currentLocalTargets = snapshotLocalSuggestionTargets(owner.session, currentLocalGroups, currentLocalGroups);
    const exactLocalBatch =
      reviewSuggestion !== undefined &&
      currentReviewSuggestion === reviewSuggestion &&
      currentLocalGroups.length === localTargets.length &&
      currentLocalTargets.length === localTargets.length &&
      currentLocalTargets.every((target, targetIndex) =>
        sameLocalSuggestionTarget(target, localTargets[targetIndex] ?? null),
      ) &&
      currentLocalGroups.every((group) => !group.outdated);
    if (!exactLocalBatch) {
      skipped += owner.targets.length;
      index = owner.targets.length;
    } else {
      try {
        const decided = suggestionReflectApply(reviewSuggestion, owner.session, [
          accepting ? "acceptAll" : "rejectAll",
        ]) as number;
        done += Math.min(decided, localTargets.length);
        skipped += Math.max(0, localTargets.length - decided);
      } catch (error) {
        if (!currentCommentBatchContext(coordinator, owner)) return;
        if (error instanceof SuggestionConflictError) {
          skipped += owner.targets.length;
          index = owner.targets.length;
        } else {
          failed += localTargets.length;
        }
      }
      if (!currentCommentBatchContext(coordinator, owner)) return;
      index = Math.max(index, localTargets.length);
    }
  }

  for (; index < owner.targets.length; index++) {
    const target = owner.targets[index];
    if (!currentCommentBatchContext(coordinator, owner)) return;
    if (target.kind === "local-suggestion") continue;
    const status = target.kind === "comment-resolve" ? resolveTargetStatus(owner.session, target) : commentSuggestionTargetStatus(owner.session, target);
    if (status === "missing") {
      skipped += owner.targets.length - index;
      break;
    }
    if (status === "outdated" && (target.kind === "comment-resolve" || accepting)) {
      skipped++;
      continue;
    }

    try {
      const ok =
        target.kind === "comment-resolve"
          ? (await ops.resolve(target.threadId, true), true)
          : accepting
            ? await ops.acceptSuggestion(target.threadId, target.proposed, target.replyId ?? undefined)
            : await ops.rejectSuggestion(target.threadId, target.replyId ?? undefined);
      if (!currentCommentBatchContext(coordinator, owner)) return;
      if (!sameCommentBatchTargetDefinition(owner.session, target)) {
        skipped += owner.targets.length - index;
        break;
      }
      if (ok) done++;
      else if (target.kind === "comment-suggestion" && accepting && commentSuggestionTargetStatus(owner.session, target) === "outdated") skipped++;
      else failed++;
    } catch {
      if (!currentCommentBatchContext(coordinator, owner)) return;
      if (!sameCommentBatchTargetDefinition(owner.session, target)) {
        skipped += owner.targets.length - index;
        break;
      }
      failed++;
    }
  }

  if (!currentCommentBatchContext(coordinator, owner)) return;
  releaseCommentBatch(coordinator, owner);
  const result = commentBatchResult(owner, done, failed, skipped);
  onToast?.(result.message, result.kind);
}

const REVIEW_CARD_CLASS = "review-card";
const REVIEW_HEADER_CLASS = "flex items-start gap-2.5";
const REVIEW_TOGGLE_CLASS = "icon-btn h-7 w-7 shrink-0";
const REVIEW_SUGGESTION_ACTIONS_CLASS = "@container mt-2 grid grid-cols-2 gap-2";
const REVIEW_RESOLVE_ACTIONS_CLASS = "mt-2 flex";
const REVIEW_ACCEPT_CLASS = "btn btn-sm btn-primary min-w-0 gap-1.5 whitespace-nowrap px-2";
const REVIEW_REJECT_CLASS = "btn btn-sm btn-outline min-w-0 gap-1.5 whitespace-nowrap px-2";
const REVIEW_RESOLVE_CLASS = "btn btn-sm btn-outline gap-1.5 whitespace-nowrap";
const REVIEW_THREADS_CLASS = "mt-2 flex flex-col gap-1 border-t border-line pt-2";
const REVIEW_THREAD_LINK_CLASS = "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-surface-2";
const SUGGESTION_BATCH_ACTIONS_CLASS = "flex items-center justify-end gap-2 text-xs";
const SUGGESTION_BATCH_ACCEPT_CLASS = "btn btn-sm btn-ghost text-success";
const SUGGESTION_BATCH_REJECT_CLASS = "btn btn-sm btn-ghost text-danger";

interface ReviewPrimitiveSnapshot {
  readonly id: string;
  readonly documentId: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly collabAuthorId: string;
  readonly agent: string | null;
  readonly verdict: ReviewDto["verdict"];
  readonly summary: string;
  readonly threadIds: readonly string[];
  readonly createdAt: string;
}

interface ReviewReplyPrimitiveSnapshot {
  readonly source: CommentReply;
  readonly id: string;
  readonly body: string;
  readonly suggestionState: CommentReply["suggestionState"];
}

interface ReviewThreadPrimitiveSnapshot {
  readonly source: CommentThread;
  readonly identity: object;
  readonly id: string;
  readonly quote: string;
  readonly body: string;
  readonly resolved: boolean;
  readonly range: Readonly<{ from: number; to: number }> | null;
  readonly suggestionState: CommentThread["suggestionState"];
  readonly replies: readonly ReviewReplyPrimitiveSnapshot[];
  readonly suggestionLabel: string | null;
}

interface ReviewSuggestionPrimitiveSnapshot {
  readonly threadSource: CommentThread;
  readonly replySource: CommentReply | null;
  readonly threadId: string;
  readonly replyId: string | null;
  readonly body: string;
  readonly proposed: string;
  readonly state: CommentSuggestionState;
}

interface SuggestionBatchClaimCells {
  readonly authorities: WeakSet<SuggestionBatchAuthority>;
  readonly targets: WeakSet<object>;
  readonly owners: WeakSet<CommentBatchOwner>;
}

interface SuggestionBatchAuthority {
  readonly session: CollabSession;
  readonly documentId: string;
  readonly role: CollabSession["role"];
  readonly canAct: boolean;
  readonly text: string;
  readonly localSources: readonly SuggestionGroup[];
  readonly localTargetSnapshots: readonly (LocalSuggestionBatchTarget | null)[];
  readonly localOutdated: readonly boolean[];
  readonly commentSources: readonly CommentSuggestionTarget[];
  readonly commentTargetSnapshots: readonly (CommentSuggestionBatchTarget | null)[];
  readonly commentStates: readonly CommentSuggestionState[];
  readonly targets: readonly CommentBatchTarget[];
  readonly pendingCount: number;
  readonly coordinator: CommentRowActionCoordinator;
  readonly batchOwner: CommentBatchOwner | null;
  readonly busy: boolean;
  readonly blocked: boolean;
  readonly acceptDisabled: boolean;
  readonly rejectDisabled: boolean;
  readonly opsSource: ReturnType<typeof useCommentOps>;
  readonly ops: Readonly<Pick<ReturnType<typeof useCommentOps>, "acceptSuggestion" | "rejectSuggestion" | "resolve">>;
  readonly reviewSuggestion: CollabSession["reviewSuggestion"];
  readonly onToast: CommentsPanelProps["onToast"];
  readonly presentation: SuggestionActionPresentation;
  readonly claims: SuggestionBatchClaimCells;
}

type ReviewCardActionKind = "toggle" | "accept" | "reject" | "resolve" | "thread";

interface ReviewCardAuthority {
  readonly mount: symbol;
  readonly position: number;
  readonly session: CollabSession;
  readonly documentId: string;
  readonly role: CollabSession["role"];
  readonly canEdit: boolean;
  readonly canComment: boolean;
  readonly text: string;
  readonly reviewSource: ReviewDto;
  readonly review: ReviewDto;
  readonly reviewSnapshot: ReviewPrimitiveSnapshot;
  readonly threadsSource: CommentThread[];
  readonly threads: readonly CommentThread[];
  readonly mine: readonly ReviewThreadPrimitiveSnapshot[];
  readonly suggestions: readonly ReviewSuggestionPrimitiveSnapshot[];
  readonly pending: readonly ReviewSuggestionPrimitiveSnapshot[];
  readonly applicable: readonly ReviewSuggestionPrimitiveSnapshot[];
  readonly unresolved: readonly ReviewThreadPrimitiveSnapshot[];
  readonly suggestionTargetSnapshots: readonly (CommentSuggestionBatchTarget | null)[];
  readonly resolveTargetSnapshots: readonly (CommentResolveBatchTarget | null)[];
  readonly renderedSuggestionTargets: readonly CommentSuggestionBatchTarget[];
  readonly renderedResolveTargets: readonly CommentResolveBatchTarget[];
  readonly renderedTargets: readonly CommentBatchTarget[];
  readonly scope: string;
  readonly coordinator: CommentRowActionCoordinator;
  readonly batchOwner: CommentBatchOwner | null;
  readonly busy: boolean;
  readonly blocked: boolean;
  readonly open: boolean;
  readonly actionRegion: "suggestions" | "resolve" | null;
  readonly partial: boolean;
  readonly verdictLabel: string;
  readonly verdictClass: string;
  readonly timestampLabel: string;
  readonly countsLabel: string;
  readonly acceptTitle: string;
  readonly resolveTitle: string;
  readonly opsSource: ReturnType<typeof useCommentOps>;
  readonly ops: Readonly<Pick<ReturnType<typeof useCommentOps>, "acceptSuggestion" | "rejectSuggestion" | "resolve">>;
  readonly onToast: CommentsPanelProps["onToast"];
  readonly setOpen: (open: boolean) => void;
  readonly setActiveComment: CollabSession["setActiveComment"];
}

interface ReviewCardElements {
  readonly card: HTMLDivElement;
  readonly header: HTMLDivElement;
  readonly toggle: HTMLButtonElement;
  readonly actions: HTMLDivElement | null;
  readonly accept: HTMLButtonElement | null;
  readonly reject: HTMLButtonElement | null;
  readonly resolve: HTMLButtonElement | null;
  readonly list: HTMLUListElement | null;
  readonly rows: readonly Readonly<{ item: HTMLLIElement; link: HTMLButtonElement }>[];
}

interface ReviewCardPresentation {
  readonly identity: symbol;
  readonly render: ReviewCardRender;
  readonly authority: ReviewCardAuthority;
  readonly elements: ReviewCardElements;
  readonly ownerDocument: Document;
  readonly dom: ReviewCardDomSnapshot;
  readonly placement: ReviewCardPlacement;
}

interface ReviewCardCells {
  readonly active: { current: ReviewCardPresentation | null };
  readonly successorOf: { current: ReviewCardPresentation | null };
  readonly replay: { current: ReviewCardReplay | null };
  readonly retired: WeakSet<ReviewCardPresentation>;
  readonly claimedPresentations: WeakSet<ReviewCardPresentation>;
  readonly claimedEvents: WeakSet<object>;
  readonly claimedActions: WeakSet<ReviewCardAction>;
}

interface ReviewCardAction {
  readonly identity: symbol;
  readonly renderIdentity: symbol;
  readonly kind: ReviewCardActionKind;
  readonly index: number | null;
  readonly threadId: string | null;
  readonly enabled: boolean;
  readonly capture: (element: HTMLButtonElement | null) => void;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

interface ReviewCardRender {
  readonly identity: symbol;
  readonly authority: ReviewCardAuthority;
  readonly toggle: ReviewCardAction;
  readonly accept: ReviewCardAction | null;
  readonly reject: ReviewCardAction | null;
  readonly resolve: ReviewCardAction | null;
  readonly threadLinks: readonly ReviewCardAction[];
  readonly captureCard: (element: HTMLDivElement | null) => void;
  readonly captureHeader: (element: HTMLDivElement | null) => void;
  readonly captureActions: (element: HTMLDivElement | null) => void;
  readonly captureList: (element: HTMLUListElement | null) => void;
  readonly captureRows: readonly ((element: HTMLLIElement | null) => void)[];
  readonly captureToggle: (element: HTMLButtonElement | null) => void;
  readonly onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly captureAccept: ((element: HTMLButtonElement | null) => void) | null;
  readonly onAccept: ((event: MouseEvent<HTMLButtonElement>) => void) | null;
  readonly captureReject: ((element: HTMLButtonElement | null) => void) | null;
  readonly onReject: ((event: MouseEvent<HTMLButtonElement>) => void) | null;
  readonly captureResolve: ((element: HTMLButtonElement | null) => void) | null;
  readonly onResolve: ((event: MouseEvent<HTMLButtonElement>) => void) | null;
  readonly captureThreadLinks: readonly ((element: HTMLButtonElement | null) => void)[];
  readonly onThreadClicks: readonly ((event: MouseEvent<HTMLButtonElement>) => void)[];
  readonly establish: () => void | (() => void);
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
}

interface ReviewCardElementOwnerView {
  readonly element: () => HTMLElement | null;
}

interface ReviewCardRefReplay {
  readonly owner: ReviewCardElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
  handoffDetached: boolean;
}

interface ReviewCardDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly ReviewCardDomSnapshot[];
}

interface ReviewCardPlacement {
  readonly document: Document;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface ReviewCardReplay {
  readonly source: ReviewCardPresentation;
  readonly dom: ReviewCardDomSnapshot;
  readonly placement: ReviewCardPlacement;
  readonly historyIsClean: () => boolean;
  readonly refsAreExact: () => boolean;
  readonly release: () => void;
}

interface ReviewCardDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface ReviewCardPublicationRuntime {
  readonly presentation: ReviewCardPresentation;
  readonly publish: (owners: readonly ReviewCardElementOwnerView[]) => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly retireForAction: () => void;
  readonly noteRef: (owner: ReviewCardElementOwnerView, element: HTMLElement | null, previous: HTMLElement | null) => void;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly stageSuccessorHandoff: () => boolean;
  readonly successorHandoffIsExact: () => boolean;
  readonly mutationHistoryIsClean: () => boolean;
  readonly release: () => void;
}

class ReviewCardElementOwner<T extends HTMLElement> implements ReviewCardElementOwnerView {
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: ReviewCardElementOwnerView,
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

function reviewCardSnapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotReviewCardDom(node: Node): ReviewCardDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: reviewCardSnapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotReviewCardDom)),
  });
}

function reviewCardDomMatches(snapshot: ReviewCardDomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = reviewCardSnapshotAttributes(node);
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
  return (
    node.childNodes.length === snapshot.children.length &&
    snapshot.children.every((child, index) => node.childNodes.item(index) === child.node && reviewCardDomMatches(child))
  );
}

function reviewCardDomContains(snapshot: ReviewCardDomSnapshot, target: Node): boolean {
  return snapshot.node === target || snapshot.children.some((child) => reviewCardDomContains(child, target));
}

function captureReviewCardPlacement(card: HTMLDivElement): ReviewCardPlacement | null {
  const parent = card.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: card.ownerDocument,
    parent,
    previousSibling: card.previousSibling,
    nextSibling: card.nextSibling,
  });
}

function reviewCardPlacementMatches(card: HTMLDivElement, placement: ReviewCardPlacement): boolean {
  return (
    card.ownerDocument === placement.document &&
    card.parentNode === placement.parent &&
    card.previousSibling === placement.previousSibling &&
    card.nextSibling === placement.nextSibling
  );
}

function createReviewCardDomGuard(card: HTMLDivElement, placement: ReviewCardPlacement): ReviewCardDomGuard | null {
  const MutationObserverConstructor = placement.document.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some((record) => {
      if (record.target === card || card.contains(record.target)) return true;
      return record.type === "childList" && record.target === placement.parent;
    });
  };
  const observer = new MutationObserverConstructor(recordChanges);
  observer.observe(card, { attributes: true, characterData: true, childList: true, subtree: true });
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

function reviewCardControlIsEnabled(control: HTMLButtonElement): boolean {
  if (control.disabled || control.matches(":disabled") || control.getAttribute("aria-disabled")?.toLowerCase() === "true") return false;
  for (let element: HTMLElement | null = control; element; element = element.parentElement) {
    if (element.hasAttribute("inert") || element.getAttribute("aria-disabled")?.toLowerCase() === "true") return false;
  }
  return true;
}

function freezeReview(review: ReviewDto): { review: ReviewDto; snapshot: ReviewPrimitiveSnapshot } {
  const threadIds = [...review.threadIds];
  Object.freeze(threadIds);
  const snapshot: ReviewPrimitiveSnapshot = Object.freeze({
    id: review.id,
    documentId: review.documentId,
    authorId: review.authorId,
    authorName: review.authorName,
    collabAuthorId: review.collabAuthorId,
    agent: review.agent,
    verdict: review.verdict,
    summary: review.summary,
    threadIds,
    createdAt: review.createdAt,
  });
  const frozen: ReviewDto = {
    id: snapshot.id,
    documentId: snapshot.documentId,
    authorId: snapshot.authorId,
    authorName: snapshot.authorName,
    collabAuthorId: snapshot.collabAuthorId,
    agent: snapshot.agent,
    verdict: snapshot.verdict,
    summary: snapshot.summary,
    threadIds,
    createdAt: snapshot.createdAt,
  };
  return { review: Object.freeze(frozen), snapshot };
}

function sameReviewPrimitives(review: ReviewDto, snapshot: ReviewPrimitiveSnapshot): boolean {
  return (
    review.id === snapshot.id &&
    review.documentId === snapshot.documentId &&
    review.authorId === snapshot.authorId &&
    review.authorName === snapshot.authorName &&
    review.collabAuthorId === snapshot.collabAuthorId &&
    review.agent === snapshot.agent &&
    review.verdict === snapshot.verdict &&
    review.summary === snapshot.summary &&
    review.createdAt === snapshot.createdAt &&
    review.threadIds.length === snapshot.threadIds.length &&
    snapshot.threadIds.every((id, index) => review.threadIds[index] === id)
  );
}

function suggestionLabel(targets: readonly ReviewSuggestionPrimitiveSnapshot[]): string | null {
  const pending = targets.filter((target) => target.state === "pending" || target.state === "outdated");
  return targets.length === 1 ? targets[0]!.state : pending.length > 0 ? `${pending.length} pending` : targets.length > 0 ? "all decided" : null;
}

function snapshotReviewThread(
  session: CollabSession,
  thread: CommentThread,
  targets: readonly ReviewSuggestionPrimitiveSnapshot[],
): ReviewThreadPrimitiveSnapshot | null {
  const identity = storedCommentTargetIdentity(session, thread.id, null)?.thread;
  if (!identity) return null;
  return Object.freeze({
    source: thread,
    identity,
    id: thread.id,
    quote: thread.quote,
    body: thread.body,
    resolved: thread.resolved,
    range: thread.range ? Object.freeze({ from: thread.range.from, to: thread.range.to }) : null,
    suggestionState: thread.suggestionState,
    replies: Object.freeze(
      thread.replies.map((reply) =>
        Object.freeze({
          source: reply,
          id: reply.id,
          body: reply.body,
          suggestionState: reply.suggestionState,
        }),
      ),
    ),
    suggestionLabel: suggestionLabel(targets),
  });
}

function sameThreadPrimitives(thread: CommentThread, snapshot: ReviewThreadPrimitiveSnapshot, requireSource: boolean): boolean {
  return (
    (!requireSource || thread === snapshot.source) &&
    thread.id === snapshot.id &&
    thread.quote === snapshot.quote &&
    thread.body === snapshot.body &&
    thread.resolved === snapshot.resolved &&
    (thread.suggestionState ?? null) === (snapshot.suggestionState ?? null) &&
    (thread.range?.from ?? null) === (snapshot.range?.from ?? null) &&
    (thread.range?.to ?? null) === (snapshot.range?.to ?? null) &&
    thread.replies.length === snapshot.replies.length &&
    snapshot.replies.every((reply, index) => {
      const current = thread.replies[index];
      return (
        !!current &&
        (!requireSource || current === reply.source) &&
        current.id === reply.id &&
        current.body === reply.body &&
        (current.suggestionState ?? null) === (reply.suggestionState ?? null)
      );
    })
  );
}

function sameSuggestionPrimitives(target: CommentSuggestionTarget, snapshot: ReviewSuggestionPrimitiveSnapshot): boolean {
  return (
    target.thread === snapshot.threadSource &&
    target.reply === snapshot.replySource &&
    target.thread.id === snapshot.threadId &&
    (target.reply?.id ?? null) === snapshot.replyId &&
    (target.reply?.body ?? target.thread.body) === snapshot.body &&
    target.block.text === snapshot.proposed &&
    target.state === snapshot.state
  );
}

function sameLiveSuggestionPrimitives(target: CommentSuggestionTarget, snapshot: ReviewSuggestionPrimitiveSnapshot): boolean {
  return (
    target.thread.id === snapshot.threadId &&
    (target.reply?.id ?? null) === snapshot.replyId &&
    (target.reply?.body ?? target.thread.body) === snapshot.body &&
    target.block.text === snapshot.proposed &&
    target.state === snapshot.state
  );
}

function sameSuggestionTarget(left: CommentSuggestionBatchTarget | null, right: CommentSuggestionBatchTarget | null): boolean {
  if (!left || !right) return left === right;
  return (
    left.kind === right.kind &&
    left.key === right.key &&
    left.threadId === right.threadId &&
    left.replyId === right.replyId &&
    left.identity.thread === right.identity.thread &&
    left.identity.reply === right.identity.reply &&
    left.body === right.body &&
    left.proposed === right.proposed &&
    left.initiallyOutdated === right.initiallyOutdated
  );
}

function sameResolveTarget(left: CommentResolveBatchTarget | null, right: CommentResolveBatchTarget | null): boolean {
  if (!left || !right) return left === right;
  return (
    left.kind === right.kind &&
    left.key === right.key &&
    left.threadId === right.threadId &&
    left.replyId === right.replyId &&
    left.identity.thread === right.identity.thread &&
    left.identity.reply === right.identity.reply
  );
}

function createReviewCardAuthority({
  mount,
  position,
  review,
  threads,
  session,
  text,
  ops,
  coordinator,
  onToast,
  open,
  setOpen,
}: {
  mount: symbol;
  position: number;
  review: ReviewDto;
  threads: CommentThread[];
  session: CollabSession;
  text: string;
  ops: ReturnType<typeof useCommentOps>;
  coordinator: CommentRowActionCoordinator;
  onToast?: CommentsPanelProps["onToast"];
  open: boolean;
  setOpen: (open: boolean) => void;
}): ReviewCardAuthority {
  const canEdit = session.role === "owner" || session.role === "editor";
  const canComment = session.canComment;
  const mineSources = reviewThreads(review, threads);
  const sourceSuggestions = commentSuggestionTargets(mineSources, text);
  const suggestions = Object.freeze(
    sourceSuggestions.map((target) =>
      Object.freeze({
        threadSource: target.thread,
        replySource: target.reply,
        threadId: target.thread.id,
        replyId: target.reply?.id ?? null,
        body: target.reply?.body ?? target.thread.body,
        proposed: target.block.text,
        state: target.state,
      }),
    ),
  );
  const mine = mineSources.map((thread) => snapshotReviewThread(session, thread, suggestions.filter((target) => target.threadId === thread.id)));
  const validMine = mine.filter((thread): thread is ReviewThreadPrimitiveSnapshot => thread !== null);
  const pendingIndexes = suggestions.flatMap((target, index) => (target.state === "pending" || target.state === "outdated" ? [index] : []));
  const pending = Object.freeze(pendingIndexes.map((index) => suggestions[index]!));
  const applicable = Object.freeze(pending.filter((target) => target.state === "pending"));
  const unresolved = Object.freeze(validMine.filter((thread) => !thread.resolved));
  const pendingSourceTargets = pendingIndexes.map((index) => sourceSuggestions[index]!);
  const suggestionTargetSnapshots = Object.freeze(pendingSourceTargets.map((target) => snapshotCommentSuggestionTarget(session, target)));
  const resolveTargetSnapshots = Object.freeze(unresolved.map((thread) => snapshotCommentResolveTarget(session, thread.source)));
  const renderedSuggestionTargets = Object.freeze(suggestionTargetSnapshots.filter((target): target is CommentSuggestionBatchTarget => target !== null));
  const renderedResolveTargets = Object.freeze(resolveTargetSnapshots.filter((target): target is CommentResolveBatchTarget => target !== null));
  const renderedTargets: readonly CommentBatchTarget[] = pending.length > 0 ? renderedSuggestionTargets : renderedResolveTargets;
  const scope = reviewBatchScope(review.id);
  const batchOwner = coordinator.batchOwners.get(scope) ?? null;
  const blocked = isCommentBatchBlocked(coordinator, renderedTargets);
  const partial = applicable.length !== pending.length;
  const { review: frozenReview, snapshot: reviewSnapshot } = freezeReview(review);
  const actionRegion = canEdit && pending.length > 0 ? "suggestions" : canComment && pending.length === 0 && unresolved.length > 0 ? "resolve" : null;
  const opsSnapshot = Object.freeze({
    acceptSuggestion: ops.acceptSuggestion,
    rejectSuggestion: ops.rejectSuggestion,
    resolve: ops.resolve,
  });

  return Object.freeze({
    mount,
    position,
    session,
    documentId: session.docId,
    role: session.role,
    canEdit,
    canComment,
    text,
    reviewSource: review,
    review: frozenReview,
    reviewSnapshot,
    threadsSource: threads,
    threads: Object.freeze([...threads]),
    mine: Object.freeze(validMine),
    suggestions,
    pending,
    applicable,
    unresolved,
    suggestionTargetSnapshots,
    resolveTargetSnapshots,
    renderedSuggestionTargets,
    renderedResolveTargets,
    renderedTargets: Object.freeze([...renderedTargets]),
    scope,
    coordinator,
    batchOwner,
    busy: batchOwner !== null,
    blocked,
    open,
    actionRegion,
    partial,
    verdictLabel: reviewVerdictLabel(review.authorName, review.verdict),
    verdictClass: cn("text-[13px] font-semibold", verdictTone(review.verdict)),
    timestampLabel: relativeTime(new Date(review.createdAt).getTime()),
    countsLabel: `${reviewSummaryLabel(validMine.length, suggestions.length)}${suggestions.length > 0 && pending.length === 0 ? " · all decided" : ""}`,
    acceptTitle: partial ? `Accept all suggestions (${applicable.length} of ${pending.length}; outdated ones are skipped)` : "Accept all suggestions",
    resolveTitle: `Resolve the ${unresolved.length === 1 ? "open comment" : `${unresolved.length} open comments`} of this review`,
    opsSource: ops,
    ops: opsSnapshot,
    onToast,
    setOpen,
    setActiveComment: session.setActiveComment,
  });
}

function reviewCardFactsAreCurrent(authority: ReviewCardAuthority, allowPendingReviewPublication = false): boolean {
  const {
    session,
    reviewSource,
    reviewSnapshot,
    threadsSource,
    threads,
    mine,
    suggestions,
    pending,
    applicable,
    unresolved,
    suggestionTargetSnapshots,
    resolveTargetSnapshots,
    coordinator,
    scope,
  } = authority;
  if (
    session.docId !== authority.documentId ||
    session.role !== authority.role ||
    (session.role === "owner" || session.role === "editor") !== authority.canEdit ||
    session.canComment !== authority.canComment ||
    session.ytext.toString() !== authority.text ||
    session.setActiveComment !== authority.setActiveComment ||
    !sameReviewPrimitives(reviewSource, reviewSnapshot) ||
    authority.review.documentId !== authority.documentId ||
    threadsSource !== authority.threadsSource ||
    threadsSource.length !== threads.length ||
    !threads.every((thread, index) => threadsSource[index] === thread) ||
    authority.opsSource.acceptSuggestion !== authority.ops.acceptSuggestion ||
    authority.opsSource.rejectSuggestion !== authority.ops.rejectSuggestion ||
    authority.opsSource.resolve !== authority.ops.resolve ||
    coordinator.session !== session ||
    coordinator.documentId !== authority.documentId ||
    !coordinator.mounted ||
    (!allowPendingReviewPublication || coordinator.reviewSignatures.has(reviewSnapshot.id)) &&
      coordinator.reviewSignatures.get(reviewSnapshot.id) !== reviewIdentitySignature(authority.review)
  ) {
    return false;
  }

  const currentMineSources = reviewThreads(reviewSource, threadsSource);
  if (
    currentMineSources.length !== mine.length ||
    !mine.every((thread, index) => {
      const source = currentMineSources[index];
      const current = session.comments.get(thread.id);
      return (
        !!source &&
        !!current &&
        source === thread.source &&
        sameThreadPrimitives(source, thread, true) &&
        sameThreadPrimitives(current, thread, false) &&
        storedCommentTargetIdentity(session, thread.id, null)?.thread === thread.identity
      );
    })
  ) {
    return false;
  }

  const sourceSuggestions = commentSuggestionTargets(currentMineSources, authority.text);
  const liveThreads = mine.map((thread) => session.comments.get(thread.id)).filter((thread): thread is CommentThread => thread !== null);
  const liveSuggestions = commentSuggestionTargets(liveThreads, authority.text);
  if (
    sourceSuggestions.length !== suggestions.length ||
    liveSuggestions.length !== suggestions.length ||
    !suggestions.every(
      (suggestion, index) =>
        sameSuggestionPrimitives(sourceSuggestions[index]!, suggestion) &&
        sameLiveSuggestionPrimitives(liveSuggestions[index]!, suggestion),
    )
  ) {
    return false;
  }

  const currentPending = suggestions.filter((target) => target.state === "pending" || target.state === "outdated");
  const currentApplicable = currentPending.filter((target) => target.state === "pending");
  const currentUnresolved = mine.filter((thread) => !thread.resolved);
  if (
    currentPending.length !== pending.length ||
    !pending.every((target, index) => currentPending[index] === target) ||
    currentApplicable.length !== applicable.length ||
    !applicable.every((target, index) => currentApplicable[index] === target) ||
    currentUnresolved.length !== unresolved.length ||
    !unresolved.every((thread, index) => currentUnresolved[index] === thread)
  ) {
    return false;
  }

  const livePending = liveSuggestions.filter((target) => target.state === "pending" || target.state === "outdated");
  const currentSuggestionTargets = livePending.map((target) => snapshotCommentSuggestionTarget(session, target));
  const currentResolveTargets = currentUnresolved.map((thread) => {
    const live = session.comments.get(thread.id);
    return live ? snapshotCommentResolveTarget(session, live) : null;
  });
  const renderedTargets: readonly CommentBatchTarget[] =
    pending.length > 0
      ? currentSuggestionTargets.filter((target): target is CommentSuggestionBatchTarget => target !== null)
      : currentResolveTargets.filter((target): target is CommentResolveBatchTarget => target !== null);
  const expectedActionRegion =
    authority.canEdit && pending.length > 0
      ? "suggestions"
      : authority.canComment && pending.length === 0 && unresolved.length > 0
        ? "resolve"
        : null;
  const matches =
    currentSuggestionTargets.length === suggestionTargetSnapshots.length &&
    suggestionTargetSnapshots.every((target, index) => sameSuggestionTarget(target, currentSuggestionTargets[index] ?? null)) &&
    currentResolveTargets.length === resolveTargetSnapshots.length &&
    resolveTargetSnapshots.every((target, index) => sameResolveTarget(target, currentResolveTargets[index] ?? null)) &&
    (coordinator.batchOwners.get(scope) ?? null) === authority.batchOwner &&
    ((coordinator.batchOwners.get(scope) ?? null) !== null) === authority.busy &&
    isCommentBatchBlocked(coordinator, renderedTargets) === authority.blocked &&
    expectedActionRegion === authority.actionRegion &&
    (currentApplicable.length !== currentPending.length) === authority.partial &&
    renderedTargets.length === authority.renderedTargets.length &&
    authority.renderedTargets.every((target, index) => {
      const current = renderedTargets[index];
      if (!current || target.kind !== current.kind) return false;
      if (target.kind === "comment-suggestion" && current.kind === "comment-suggestion") return sameSuggestionTarget(target, current);
      if (target.kind === "comment-resolve" && current.kind === "comment-resolve") return sameResolveTarget(target, current);
      return false;
    });
  return matches;
}

function sameReviewSnapshots(left: ReviewPrimitiveSnapshot, right: ReviewPrimitiveSnapshot): boolean {
  return (
    left.id === right.id &&
    left.documentId === right.documentId &&
    left.authorId === right.authorId &&
    left.authorName === right.authorName &&
    left.collabAuthorId === right.collabAuthorId &&
    left.agent === right.agent &&
    left.verdict === right.verdict &&
    left.summary === right.summary &&
    left.createdAt === right.createdAt &&
    left.threadIds.length === right.threadIds.length &&
    left.threadIds.every((id, index) => id === right.threadIds[index])
  );
}

function sameReviewThreadSnapshots(left: ReviewThreadPrimitiveSnapshot, right: ReviewThreadPrimitiveSnapshot): boolean {
  return (
    left.source === right.source &&
    left.identity === right.identity &&
    left.id === right.id &&
    left.quote === right.quote &&
    left.body === right.body &&
    left.resolved === right.resolved &&
    (left.range?.from ?? null) === (right.range?.from ?? null) &&
    (left.range?.to ?? null) === (right.range?.to ?? null) &&
    (left.suggestionState ?? null) === (right.suggestionState ?? null) &&
    left.suggestionLabel === right.suggestionLabel &&
    left.replies.length === right.replies.length &&
    left.replies.every((reply, index) => {
      const current = right.replies[index];
      return (
        !!current &&
        reply.source === current.source &&
        reply.id === current.id &&
        reply.body === current.body &&
        (reply.suggestionState ?? null) === (current.suggestionState ?? null)
      );
    })
  );
}

function sameReviewSuggestionSnapshots(left: ReviewSuggestionPrimitiveSnapshot, right: ReviewSuggestionPrimitiveSnapshot): boolean {
  return (
    left.threadSource === right.threadSource &&
    left.replySource === right.replySource &&
    left.threadId === right.threadId &&
    left.replyId === right.replyId &&
    left.body === right.body &&
    left.proposed === right.proposed &&
    left.state === right.state
  );
}

function sameReviewTargetSnapshots(left: CommentBatchTarget, right: CommentBatchTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "comment-suggestion" && right.kind === "comment-suggestion") return sameSuggestionTarget(left, right);
  if (left.kind === "comment-resolve" && right.kind === "comment-resolve") return sameResolveTarget(left, right);
  return (
    left.kind === "local-suggestion" &&
    right.kind === "local-suggestion" &&
    left.key === right.key &&
    left.suggestionId === right.suggestionId &&
    left.before === right.before &&
    left.after === right.after &&
    left.memberIds.length === right.memberIds.length &&
    left.memberIds.every((id, index) => id === right.memberIds[index]) &&
    left.memberIdentities.length === right.memberIdentities.length &&
    left.memberIdentities.every((identity, index) => identity === right.memberIdentities[index])
  );
}

function sameLocalSuggestionTarget(
  left: LocalSuggestionBatchTarget | null,
  right: LocalSuggestionBatchTarget | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.key === right.key &&
    left.suggestionId === right.suggestionId &&
    left.before === right.before &&
    left.after === right.after &&
    left.memberIds.length === right.memberIds.length &&
    left.memberIds.every((id, index) => id === right.memberIds[index]) &&
    left.memberIdentities.length === right.memberIdentities.length &&
    left.memberIdentities.every((identity, index) => identity === right.memberIdentities[index])
  );
}

function sameSuggestionBatchTarget(
  left: CommentBatchTarget | null,
  right: CommentBatchTarget | null,
): boolean {
  if (!left || !right) return left === right;
  if (left.kind === "local-suggestion" || right.kind === "local-suggestion") {
    return left.kind === "local-suggestion" && right.kind === "local-suggestion" && sameLocalSuggestionTarget(left, right);
  }
  if (left.kind === "comment-suggestion" || right.kind === "comment-suggestion") {
    return left.kind === "comment-suggestion" && right.kind === "comment-suggestion" && sameSuggestionTarget(left, right);
  }
  return sameResolveTarget(left, right);
}

function suggestionBatchPresentation(
  acceptDisabled: boolean,
  rejectDisabled: boolean,
  batchOwner: CommentBatchOwner | null,
): SuggestionActionPresentation {
  const accepting = batchOwner?.action === "suggestions-accept";
  const rejecting = batchOwner?.action === "suggestions-reject";
  return Object.freeze({
    rootClassName: SUGGESTION_BATCH_ACTIONS_CLASS,
    rootTestId: "suggestion-batch-actions",
    accept: Object.freeze({
      className: SUGGESTION_BATCH_ACCEPT_CLASS,
      testId: "accept-all",
      label: accepting ? "Accepting…" : "Accept all",
      disabled: acceptDisabled,
      busy: accepting,
      title: null,
      ariaLabel: null,
    }),
    reject: Object.freeze({
      className: SUGGESTION_BATCH_REJECT_CLASS,
      testId: "reject-all",
      label: rejecting ? "Rejecting…" : "Reject all",
      disabled: rejectDisabled,
      busy: rejecting,
      title: null,
      ariaLabel: null,
    }),
  });
}

function createSuggestionBatchAuthority({
  session,
  text,
  localSources,
  localTargetSnapshots,
  commentSources,
  targets,
  coordinator,
  batchOwner,
  blocked,
  ops,
  onToast,
  claims,
}: {
  session: CollabSession;
  text: string;
  localSources: readonly SuggestionGroup[];
  localTargetSnapshots: readonly (LocalSuggestionBatchTarget | null)[];
  commentSources: readonly CommentSuggestionTarget[];
  targets: readonly CommentBatchTarget[];
  coordinator: CommentRowActionCoordinator;
  batchOwner: CommentBatchOwner | null;
  blocked: boolean;
  ops: ReturnType<typeof useCommentOps>;
  onToast: CommentsPanelProps["onToast"];
  claims: SuggestionBatchClaimCells;
}): SuggestionBatchAuthority {
  const commentTargetSnapshots = Object.freeze(commentSources.map((target) => snapshotCommentSuggestionTarget(session, target)));
  const localOutdated = Object.freeze(localSources.map((target) => target.outdated));
  const commentStates = Object.freeze(commentSources.map((target) => target.state));
  const pendingCount = localSources.length + commentSources.length;
  const busy = batchOwner !== null;
  const acceptDisabled =
    busy ||
    blocked ||
    targets.length !== pendingCount ||
    localOutdated.some(Boolean) ||
    (localSources.length === 0 && commentStates.every((state) => state === "outdated"));
  const rejectDisabled =
    busy ||
    blocked ||
    targets.length !== pendingCount ||
    localOutdated.some(Boolean);
  const presentation = suggestionBatchPresentation(acceptDisabled, rejectDisabled, batchOwner);
  return Object.freeze({
    session,
    documentId: session.docId,
    role: session.role,
    canAct: session.role === "owner" || session.role === "editor",
    text,
    localSources: Object.freeze([...localSources]),
    localTargetSnapshots: Object.freeze([...localTargetSnapshots]),
    localOutdated,
    commentSources: Object.freeze([...commentSources]),
    commentTargetSnapshots,
    commentStates,
    targets: Object.freeze([...targets]),
    pendingCount,
    coordinator,
    batchOwner,
    busy,
    blocked,
    acceptDisabled,
    rejectDisabled,
    opsSource: ops,
    ops: Object.freeze({
      acceptSuggestion: ops.acceptSuggestion,
      rejectSuggestion: ops.rejectSuggestion,
      resolve: ops.resolve,
    }),
    reviewSuggestion: session.reviewSuggestion,
    onToast,
    presentation,
    claims,
  });
}

function suggestionBatchAuthoritiesMatch(
  previous: SuggestionBatchAuthority | null,
  current: SuggestionBatchAuthority | null,
): boolean {
  const sameArray = <T,>(left: readonly T[], right: readonly T[], matches: (a: T, b: T) => boolean) =>
    left.length === right.length && left.every((value, index) => matches(value, right[index]!));
  return (
    previous === current ||
    (!!previous &&
      !!current &&
      previous.session === current.session &&
      previous.documentId === current.documentId &&
      previous.role === current.role &&
      previous.canAct === current.canAct &&
      previous.text === current.text &&
      sameArray(previous.localSources, current.localSources, (left, right) => left === right) &&
      sameArray(previous.localTargetSnapshots, current.localTargetSnapshots, sameLocalSuggestionTarget) &&
      sameArray(previous.localOutdated, current.localOutdated, (left, right) => left === right) &&
      sameArray(previous.commentSources, current.commentSources, (left, right) => left === right) &&
      sameArray(previous.commentTargetSnapshots, current.commentTargetSnapshots, sameSuggestionTarget) &&
      sameArray(previous.commentStates, current.commentStates, (left, right) => left === right) &&
      sameArray(previous.targets, current.targets, sameReviewTargetSnapshots) &&
      previous.pendingCount === current.pendingCount &&
      previous.coordinator === current.coordinator &&
      previous.batchOwner === current.batchOwner &&
      previous.busy === current.busy &&
      previous.blocked === current.blocked &&
      previous.acceptDisabled === current.acceptDisabled &&
      previous.rejectDisabled === current.rejectDisabled &&
      previous.opsSource === current.opsSource &&
      previous.ops.acceptSuggestion === current.ops.acceptSuggestion &&
      previous.ops.rejectSuggestion === current.ops.rejectSuggestion &&
      previous.ops.resolve === current.ops.resolve &&
      previous.reviewSuggestion === current.reviewSuggestion &&
      previous.onToast === current.onToast &&
      suggestionActionPresentationsMatch(previous.presentation, current.presentation) &&
      previous.claims === current.claims)
  );
}

function suggestionBatchAuthorityFactsAreCurrent(batch: SuggestionBatchAuthority): boolean {
  const { session, coordinator } = batch;
  if (
    session.docId !== batch.documentId ||
    session.role !== batch.role ||
    (session.role === "owner" || session.role === "editor") !== batch.canAct ||
    !batch.canAct ||
    session.ytext.toString() !== batch.text ||
    coordinator.session !== session ||
    coordinator.documentId !== batch.documentId ||
    !coordinator.mounted ||
    (coordinator.batchOwners.get(SUGGESTIONS_SCOPE) ?? null) !== batch.batchOwner ||
    ((coordinator.batchOwners.get(SUGGESTIONS_SCOPE) ?? null) !== null) !== batch.busy ||
    batch.opsSource.acceptSuggestion !== batch.ops.acceptSuggestion ||
    batch.opsSource.rejectSuggestion !== batch.ops.rejectSuggestion ||
    batch.opsSource.resolve !== batch.ops.resolve ||
    session.reviewSuggestion !== batch.reviewSuggestion
  ) {
    return false;
  }

  const currentLocalSources = session.suggestions.groups(batch.text);
  const sourceLocalTargets = snapshotLocalSuggestionTargets(session, batch.localSources, currentLocalSources);
  const sourceCommentTargets = batch.commentSources.map((target) => snapshotCommentSuggestionTarget(session, target));
  if (
    sourceLocalTargets.length !== batch.localTargetSnapshots.length ||
    !sourceLocalTargets.every((target, index) => sameLocalSuggestionTarget(target, batch.localTargetSnapshots[index] ?? null)) ||
    batch.localSources.some((target, index) => target.outdated !== batch.localOutdated[index]) ||
    sourceCommentTargets.length !== batch.commentTargetSnapshots.length ||
    !sourceCommentTargets.every((target, index) => sameSuggestionTarget(target, batch.commentTargetSnapshots[index] ?? null)) ||
    batch.commentSources.some((target, index) => target.state !== batch.commentStates[index])
  ) {
    return false;
  }

  const currentCommentSources = commentSuggestionTargets(session.comments.list(), batch.text).filter(
    (target) => target.state === "pending" || target.state === "outdated",
  );
  const currentLocalTargets = snapshotLocalSuggestionTargets(session, currentLocalSources, currentLocalSources);
  const currentCommentTargets = currentCommentSources.map((target) => snapshotCommentSuggestionTarget(session, target));
  const currentTargets = [...currentLocalTargets, ...currentCommentTargets].filter(
    (target): target is LocalSuggestionBatchTarget | CommentSuggestionBatchTarget => target !== null,
  );
  const pendingCount = currentLocalSources.length + currentCommentSources.length;
  const blocked = isCommentBatchBlocked(coordinator, currentTargets);
  const acceptDisabled =
    batch.busy ||
    blocked ||
    currentTargets.length !== pendingCount ||
    currentLocalSources.some((target) => target.outdated) ||
    (currentLocalSources.length === 0 && currentCommentSources.every((target) => target.state === "outdated"));
  const rejectDisabled =
    batch.busy ||
    blocked ||
    currentTargets.length !== pendingCount ||
    currentLocalSources.some((target) => target.outdated);
  return (
    currentLocalTargets.length === batch.localTargetSnapshots.length &&
    currentLocalTargets.every((target, index) => sameLocalSuggestionTarget(target, batch.localTargetSnapshots[index] ?? null)) &&
    currentLocalSources.every((target, index) => target.outdated === batch.localOutdated[index]) &&
    currentCommentTargets.length === batch.commentTargetSnapshots.length &&
    currentCommentTargets.every((target, index) => sameSuggestionTarget(target, batch.commentTargetSnapshots[index] ?? null)) &&
    currentCommentSources.every((target, index) => target.state === batch.commentStates[index]) &&
    pendingCount === batch.pendingCount &&
    currentTargets.length === batch.targets.length &&
    currentTargets.every((target, index) => sameSuggestionBatchTarget(target, batch.targets[index] ?? null)) &&
    blocked === batch.blocked &&
    acceptDisabled === batch.acceptDisabled &&
    rejectDisabled === batch.rejectDisabled &&
    suggestionActionPresentationsMatch(
      suggestionBatchPresentation(acceptDisabled, rejectDisabled, batch.batchOwner),
      batch.presentation,
    )
  );
}

function suggestionActionAuthorityFactsAreCurrent(authority: SuggestionActionAuthority): boolean {
  return authority.batch === null || suggestionBatchAuthorityFactsAreCurrent(authority.batch);
}

function invokeSuggestionBatch(authority: SuggestionBatchAuthority, accept: boolean): boolean {
  if (
    !suggestionBatchAuthorityFactsAreCurrent(authority) ||
    authority.claims.authorities.has(authority) ||
    authority.claims.targets.has(authority.targets)
  ) {
    return false;
  }
  authority.claims.authorities.add(authority);
  authority.claims.targets.add(authority.targets);
  const owner = claimCommentBatch(authority.coordinator, {
    scope: SUGGESTIONS_SCOPE,
    review: null,
    authorName: null,
    action: accept ? "suggestions-accept" : "suggestions-reject",
    targets: authority.targets,
  });
  if (!owner) {
    authority.claims.authorities.delete(authority);
    authority.claims.targets.delete(authority.targets);
    return false;
  }
  authority.claims.owners.add(owner);
  void executeCommentBatch(
    authority.coordinator,
    owner,
    authority.ops,
    authority.onToast,
    authority.reviewSuggestion,
  );
  return true;
}

function reviewCardAuthoritiesMatch(previous: ReviewCardAuthority, current: ReviewCardAuthority): boolean {
  const sameArray = <T,>(left: readonly T[], right: readonly T[], matches: (a: T, b: T) => boolean) =>
    left.length === right.length && left.every((value, index) => matches(value, right[index]!));
  return (
    previous.mount === current.mount &&
    previous.position === current.position &&
    previous.session === current.session &&
    previous.documentId === current.documentId &&
    previous.role === current.role &&
    previous.canEdit === current.canEdit &&
    previous.canComment === current.canComment &&
    previous.text === current.text &&
    previous.reviewSource === current.reviewSource &&
    sameReviewSnapshots(previous.reviewSnapshot, current.reviewSnapshot) &&
    sameReviewPrimitives(previous.review, current.reviewSnapshot) &&
    previous.threadsSource === current.threadsSource &&
    sameArray(previous.threads, current.threads, (left, right) => left === right) &&
    sameArray(previous.mine, current.mine, sameReviewThreadSnapshots) &&
    sameArray(previous.suggestions, current.suggestions, sameReviewSuggestionSnapshots) &&
    sameArray(previous.pending, current.pending, sameReviewSuggestionSnapshots) &&
    sameArray(previous.applicable, current.applicable, sameReviewSuggestionSnapshots) &&
    sameArray(previous.unresolved, current.unresolved, sameReviewThreadSnapshots) &&
    sameArray(previous.suggestionTargetSnapshots, current.suggestionTargetSnapshots, sameSuggestionTarget) &&
    sameArray(previous.resolveTargetSnapshots, current.resolveTargetSnapshots, sameResolveTarget) &&
    sameArray(previous.renderedSuggestionTargets, current.renderedSuggestionTargets, sameSuggestionTarget) &&
    sameArray(previous.renderedResolveTargets, current.renderedResolveTargets, sameResolveTarget) &&
    sameArray(previous.renderedTargets, current.renderedTargets, sameReviewTargetSnapshots) &&
    previous.scope === current.scope &&
    previous.coordinator === current.coordinator &&
    previous.batchOwner === current.batchOwner &&
    previous.busy === current.busy &&
    previous.blocked === current.blocked &&
    previous.open === current.open &&
    previous.actionRegion === current.actionRegion &&
    previous.partial === current.partial &&
    previous.verdictLabel === current.verdictLabel &&
    previous.verdictClass === current.verdictClass &&
    previous.timestampLabel === current.timestampLabel &&
    previous.countsLabel === current.countsLabel &&
    previous.acceptTitle === current.acceptTitle &&
    previous.resolveTitle === current.resolveTitle &&
    previous.opsSource === current.opsSource &&
    previous.ops.acceptSuggestion === current.ops.acceptSuggestion &&
    previous.ops.rejectSuggestion === current.ops.rejectSuggestion &&
    previous.ops.resolve === current.ops.resolve &&
    previous.onToast === current.onToast &&
    previous.setOpen === current.setOpen &&
    previous.setActiveComment === current.setActiveComment
  );
}

function exactReviewCardDomIsCurrent(presentation: ReviewCardPresentation): boolean {
  const { authority, elements } = presentation;
  const { card, header, toggle, actions, accept, reject, resolve, list, rows } = elements;
  const document = card.ownerDocument;
  const NodeConstructor = document.defaultView?.Node;
  if (
    !NodeConstructor ||
    !card.isConnected ||
    card.tagName !== "DIV" ||
    card.className !== REVIEW_CARD_CLASS ||
    card.dataset.testid !== "review-card" ||
    card.dataset.reviewId !== authority.reviewSnapshot.id ||
    card.dataset.verdict !== authority.reviewSnapshot.verdict ||
    !card.parentElement ||
    card.parentElement.dataset.testid !== "review-cards" ||
    card.parentElement.children.item(authority.position) !== card ||
    !header.isConnected ||
    header.ownerDocument !== document ||
    header.parentElement !== card ||
    header.className !== REVIEW_HEADER_CLASS ||
    header.dataset.testid !== "review-header" ||
    header.children.length !== 3 ||
    header.children.item(2) !== toggle ||
    !toggle.isConnected ||
    toggle.ownerDocument !== document ||
    toggle.parentElement !== header ||
    toggle.tagName !== "BUTTON" ||
    toggle.type !== "button" ||
    !reviewCardControlIsEnabled(toggle) ||
    toggle.className !== REVIEW_TOGGLE_CLASS ||
    toggle.dataset.testid !== "review-toggle" ||
    toggle.getAttribute("aria-expanded") !== String(authority.open) ||
    toggle.getAttribute("aria-label") !== (authority.open ? "Collapse review" : "Expand review")
  ) {
    return false;
  }

  const details = header.children.item(1);
  const heading = details?.children.item(0);
  const verdict = heading?.children.item(0);
  const timestamp = heading?.children.item(1);
  const counts = details?.children.item(1);
  const summary = details?.children.item(2);
  if (
    !(details instanceof NodeConstructor) ||
    details?.children.length !== (authority.reviewSnapshot.summary ? 3 : 2) ||
    !(verdict instanceof NodeConstructor) ||
    !(timestamp instanceof NodeConstructor) ||
    !(counts instanceof NodeConstructor) ||
    (verdict as HTMLElement).dataset.testid !== "review-verdict" ||
    (verdict as HTMLElement).className !== authority.verdictClass ||
    verdict.textContent !== authority.verdictLabel ||
    (timestamp as HTMLElement).dataset.testid !== "comment-timestamp" ||
    timestamp.textContent !== authority.timestampLabel ||
    (counts as HTMLElement).dataset.testid !== "review-counts" ||
    counts.textContent !== authority.countsLabel ||
    (authority.reviewSnapshot.summary
      ? (summary as HTMLElement | null)?.dataset.testid !== "comment-body"
      : summary !== null)
  ) {
    return false;
  }

  const expectedChildren: Element[] = [header];
  if (authority.actionRegion) expectedChildren.push(actions!);
  if (authority.open) expectedChildren.push(list!);
  if (card.children.length !== expectedChildren.length || !expectedChildren.every((element, index) => card.children.item(index) === element)) return false;

  if (authority.actionRegion === null) {
    if (actions || accept || reject || resolve) return false;
  } else {
    const suggestionActions = authority.actionRegion === "suggestions";
    if (
      !actions ||
      !actions.isConnected ||
      actions.ownerDocument !== document ||
      actions.parentElement !== card ||
      actions.dataset.testid !== "review-actions" ||
      actions.className !== (suggestionActions ? REVIEW_SUGGESTION_ACTIONS_CLASS : REVIEW_RESOLVE_ACTIONS_CLASS)
    ) {
      return false;
    }
    if (suggestionActions) {
      const acceptEnabled =
        !authority.busy &&
        !authority.blocked &&
        authority.renderedSuggestionTargets.length === authority.pending.length &&
        authority.applicable.length > 0;
      const rejectEnabled = !authority.busy && !authority.blocked && authority.renderedSuggestionTargets.length === authority.pending.length;
      if (
        !accept ||
        !reject ||
        resolve !== null ||
        actions.children.length !== 2 ||
        actions.children.item(0) !== accept ||
        actions.children.item(1) !== reject ||
        !accept.isConnected ||
        !reject.isConnected ||
        accept.ownerDocument !== document ||
        reject.ownerDocument !== document ||
        accept.parentElement !== actions ||
        reject.parentElement !== actions ||
        accept.type !== "button" ||
        reject.type !== "button" ||
        accept.disabled === acceptEnabled ||
        reject.disabled === rejectEnabled ||
        (acceptEnabled && !reviewCardControlIsEnabled(accept)) ||
        (rejectEnabled && !reviewCardControlIsEnabled(reject)) ||
        accept.className !== REVIEW_ACCEPT_CLASS ||
        reject.className !== REVIEW_REJECT_CLASS ||
        accept.dataset.testid !== "review-accept-all" ||
        reject.dataset.testid !== "review-reject-all" ||
        accept.getAttribute("aria-label") !== authority.acceptTitle ||
        accept.title !== authority.acceptTitle ||
        reject.getAttribute("aria-label") !== "Reject all suggestions" ||
        reject.title !== "Reject all suggestions" ||
        accept.getAttribute("aria-busy") !== (authority.batchOwner?.action === "review-accept" ? "true" : null) ||
        reject.getAttribute("aria-busy") !== (authority.batchOwner?.action === "review-reject" ? "true" : null) ||
        accept.textContent?.trim() !==
          (authority.batchOwner?.action === "review-accept"
            ? "Accepting…"
            : `Accept all${authority.partial ? `(${authority.applicable.length} of ${authority.pending.length})` : ""}`) ||
        reject.textContent?.trim() !== (authority.batchOwner?.action === "review-reject" ? "Rejecting…" : "Reject all")
      ) {
        return false;
      }
    } else {
      const resolveEnabled = !authority.busy && !authority.blocked && authority.renderedResolveTargets.length === authority.unresolved.length;
      if (
        accept !== null ||
        reject !== null ||
        !resolve ||
        actions.children.length !== 1 ||
        actions.children.item(0) !== resolve ||
        !resolve.isConnected ||
        resolve.ownerDocument !== document ||
        resolve.parentElement !== actions ||
        resolve.type !== "button" ||
        resolve.disabled === resolveEnabled ||
        (resolveEnabled && !reviewCardControlIsEnabled(resolve)) ||
        resolve.className !== REVIEW_RESOLVE_CLASS ||
        resolve.dataset.testid !== "review-resolve-all" ||
        resolve.title !== authority.resolveTitle ||
        resolve.getAttribute("aria-busy") !== (authority.batchOwner?.action === "review-resolve" ? "true" : null) ||
        resolve.textContent?.trim() !== (authority.batchOwner?.action === "review-resolve" ? "Resolving…" : "Resolve all")
      ) {
        return false;
      }
    }
  }

  if (!authority.open) return list === null && rows.length === 0;
  if (
    !list ||
    !list.isConnected ||
    list.ownerDocument !== document ||
    list.parentElement !== card ||
    list.tagName !== "UL" ||
    list.className !== REVIEW_THREADS_CLASS ||
    list.dataset.testid !== "review-threads" ||
    rows.length !== authority.mine.length ||
    list.children.length !== (authority.mine.length || 1)
  ) {
    return false;
  }
  if (authority.mine.length === 0) {
    return list.children.item(0)?.textContent === "The comments of this review were deleted.";
  }
  return authority.mine.every((thread, index) => {
    const row = rows[index];
    if (
      !row ||
      !row.item.isConnected ||
      !row.link.isConnected ||
      row.item.ownerDocument !== document ||
      row.link.ownerDocument !== document ||
      row.item.parentElement !== list ||
      list.children.item(index) !== row.item ||
      row.item.tagName !== "LI" ||
      row.item.dataset.testid !== "review-thread-row" ||
      row.item.children.length !== 1 ||
      row.item.children.item(0) !== row.link ||
      row.link.parentElement !== row.item ||
      row.link.tagName !== "BUTTON" ||
      row.link.type !== "button" ||
      !reviewCardControlIsEnabled(row.link) ||
      row.link.className !== REVIEW_THREAD_LINK_CLASS ||
      row.link.dataset.testid !== "review-thread-link" ||
      row.link.dataset.threadId !== thread.id ||
      row.link.children.length !== (thread.suggestionLabel ? 3 : 2)
    ) {
      return false;
    }
    const icon = row.link.children.item(0);
    const quote = row.link.children.item(1);
    const state = row.link.children.item(2);
    return (
      icon?.getAttribute("aria-label") === (thread.resolved ? "Resolved" : null) &&
      quote?.getAttribute("title") === thread.quote &&
      quote?.textContent === (thread.quote || "(comment)") &&
      (thread.suggestionLabel
        ? state?.className === "suggestion-badge shrink-0" && state.textContent === thread.suggestionLabel
        : state === null)
    );
  });
}

function createReviewCardRender(
  authority: ReviewCardAuthority,
  cells: ReviewCardCells,
  requestSuccessor: () => void,
): ReviewCardRender {
  const render = {} as ReviewCardRender;
  const identity = Symbol("review-card-render");
  let currentRuntime: ReviewCardPublicationRuntime | null = null;
  let lastRuntime: ReviewCardPublicationRuntime | null = null;
  let successorRequested = false;
  let renderRetired = false;
  let invalidBeforeEstablish = false;

  const acceptsSuccessorOf = (presentation: ReviewCardPresentation) =>
    cells.active.current === null &&
    cells.successorOf.current === presentation &&
    cells.retired.has(presentation) &&
    presentation.render.isRetired() &&
    !cells.claimedPresentations.has(presentation);

  const requestReplaySuccessor = (runtime: ReviewCardPublicationRuntime) => {
    const { presentation } = runtime;
    if (
      successorRequested ||
      cells.replay.current !== null ||
      !acceptsSuccessorOf(presentation) ||
      !reviewCardFactsAreCurrent(authority, true) ||
      !exactReviewCardDomIsCurrent(presentation) ||
      !runtime.publishedDomMatches()
    ) {
      return;
    }
    if (!runtime.stageSuccessorHandoff()) return;
    successorRequested = true;
    cells.replay.current = Object.freeze({
      source: presentation,
      dom: presentation.dom,
      placement: presentation.placement,
      historyIsClean: runtime.mutationHistoryIsClean,
      refsAreExact: runtime.successorHandoffIsExact,
      release: runtime.release,
    });
    requestSuccessor();
  };

  const onElementChange = (
    owner: ReviewCardElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null || (element !== null && last !== null && element !== last)) {
      if (currentRuntime) currentRuntime.retireForElement();
      else if (!lastRuntime) {
        renderRetired = true;
        invalidBeforeEstablish = true;
      }
    }
    if (runtime?.isExactElementReplay() && acceptsSuccessorOf(runtime.presentation)) {
      requestReplaySuccessor(runtime);
    }
  };
  const cardOwner = new ReviewCardElementOwner<HTMLDivElement>(onElementChange);
  const headerOwner = new ReviewCardElementOwner<HTMLDivElement>(onElementChange);
  const actionsOwner = new ReviewCardElementOwner<HTMLDivElement>(onElementChange);
  const listOwner = new ReviewCardElementOwner<HTMLUListElement>(onElementChange);
  const rowOwners = authority.mine.map(() => new ReviewCardElementOwner<HTMLLIElement>(onElementChange));
  const controlOwners: ReviewCardElementOwner<HTMLButtonElement>[] = [];

  const committedElements = (): ReviewCardElements | null => {
    const card = cardOwner.element();
    const header = headerOwner.element();
    const toggleElement = controlOwners[0]?.element() ?? null;
    const actions = actionsOwner.element();
    const list = listOwner.element();
    const actionOffset = 1;
    const acceptElement = render.accept ? controlOwners[actionOffset]?.element() ?? null : null;
    const rejectElement = render.reject ? controlOwners[actionOffset + 1]?.element() ?? null : null;
    const resolveElement = render.resolve ? controlOwners[actionOffset]?.element() ?? null : null;
    const threadOffset = 1 + (render.accept ? 2 : render.resolve ? 1 : 0);
    const rowElements = authority.open
      ? authority.mine.map((_, index) => {
          const item = rowOwners[index]?.element() ?? null;
          const link = controlOwners[threadOffset + index]?.element() ?? null;
          return item && link ? Object.freeze({ item, link }) : null;
        })
      : [];
    if (
      !card ||
      !header ||
      !toggleElement ||
      (authority.actionRegion !== null) !== !!actions ||
      (authority.actionRegion === "suggestions" && (!acceptElement || !rejectElement)) ||
      (authority.actionRegion === "resolve" && !resolveElement) ||
      authority.open !== !!list ||
      rowElements.some((row) => row === null)
    ) {
      return null;
    }
    return Object.freeze({
      card,
      header,
      toggle: toggleElement,
      actions,
      accept: acceptElement,
      reject: rejectElement,
      resolve: resolveElement,
      list,
      rows: Object.freeze(rowElements as Readonly<{ item: HTMLLIElement; link: HTMLButtonElement }>[]),
    });
  };

  const expectedOwners = (): readonly ReviewCardElementOwnerView[] => [
    cardOwner,
    headerOwner,
    ...(authority.actionRegion ? [actionsOwner] : []),
    ...(authority.open ? [listOwner, ...rowOwners] : []),
    ...controlOwners,
  ];

  const createRuntime = (
    presentation: ReviewCardPresentation,
    replayOwners: ReadonlySet<ReviewCardElementOwnerView>,
  ): ReviewCardPublicationRuntime => {
    type Retirement = "element" | "layout" | "action";
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let invalidReplay = false;
    let successorStaged = false;
    let replayRefs: ReviewCardRefReplay[] = [];
    let domGuard: ReviewCardDomGuard | null = null;

    const retire = (reason: Retirement) => {
      if (renderRetired) return false;
      renderRetired = true;
      retirement = reason;
      cells.retired.add(presentation);
      if (cells.active.current === presentation) {
        cells.active.current = null;
        cells.successorOf.current = presentation;
      }
      if (currentRuntime?.presentation === presentation) currentRuntime = null;
      queueMicrotask(() => {
        if (cells.replay.current?.source !== presentation) domGuard?.release();
      });
      return true;
    };
    const refsHaveNoReplay = () =>
      !invalidReplay &&
      replayRefs.every((entry) => !entry.detached && !entry.reattached && entry.owner.element() === entry.element);
    const refsHaveExactReplay = () =>
      !invalidReplay &&
      replayRefs.length > 0 &&
      replayRefs.every((entry) => entry.detached && entry.reattached && entry.owner.element() === entry.element);
    const refsHaveExactMountedReplay = () =>
      !invalidReplay &&
      replayOwners.size > 0 &&
      replayRefs.every((entry) =>
        replayOwners.has(entry.owner)
          ? entry.detached && entry.reattached && entry.owner.element() === entry.element
          : !entry.detached && !entry.reattached && entry.owner.element() === entry.element,
      );
    const publishedDomMatches = () =>
      Boolean(
        domGuard &&
        domGuard.isClean() &&
        presentation.elements.card === presentation.dom.node &&
        presentation.elements.card.isConnected &&
        reviewCardPlacementMatches(presentation.elements.card, presentation.placement) &&
        reviewCardDomMatches(presentation.dom),
      );

    const runtime: ReviewCardPublicationRuntime = Object.freeze({
      presentation,
      publish: (owners: readonly ReviewCardElementOwnerView[]) => {
        if (renderRetired || established) return false;
        domGuard = createReviewCardDomGuard(presentation.elements.card, presentation.placement);
        if (!domGuard) return false;
        replayRefs = owners.map((owner) => {
          const element = owner.element();
          if (!element) throw new Error("Cannot publish a review card without every committed ref");
          return { owner, element, detached: false, reattached: false, handoffDetached: false };
        });
        established = true;
        cells.active.current = presentation;
        cells.successorOf.current = null;
        cells.replay.current = null;
        return true;
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        layoutRetired = true;
        retire("layout");
      },
      retireForAction: () => {
        retire("action");
      },
      noteRef: (owner: ReviewCardElementOwnerView, element: HTMLElement | null, previous: HTMLElement | null) => {
        if (!established) return;
        const proof = replayRefs.find((entry) => entry.owner === owner);
        if (!proof) {
          invalidReplay = true;
          return;
        }
        if (successorStaged) {
          if (element === null && previous === proof.element && !proof.handoffDetached) {
            proof.handoffDetached = true;
          } else if (element !== previous) {
            invalidReplay = true;
          }
          return;
        }
        if (element === null && previous === proof.element) {
          proof.detached = true;
          proof.reattached = false;
        } else if (element === proof.element && previous === null && proof.detached) {
          proof.reattached = true;
        } else if (element !== previous) {
          invalidReplay = true;
        }
      },
      isRetired: () => renderRetired,
      publishedDomMatches,
      isExactElementReplay: () =>
        renderRetired &&
        retirement === "element" &&
        established &&
        ((layoutRetired && refsHaveExactReplay()) || (!layoutRetired && refsHaveExactMountedReplay())) &&
        publishedDomMatches(),
      isExactLayoutReplay: () =>
        renderRetired &&
        retirement === "layout" &&
        established &&
        (refsHaveNoReplay() || refsHaveExactReplay()) &&
        publishedDomMatches(),
      stageSuccessorHandoff: () => {
        if (successorStaged) return false;
        successorStaged = true;
        return true;
      },
      successorHandoffIsExact: () =>
        successorStaged &&
        !invalidReplay &&
        replayRefs.every((entry) => entry.handoffDetached && entry.owner.element() === null),
      mutationHistoryIsClean: () => domGuard?.isClean() ?? false,
      release: () => {
        domGuard?.release();
      },
    });
    return runtime;
  };

  const nativeClick = (
    presentation: ReviewCardPresentation,
    source: HTMLButtonElement,
    event: MouseEvent<HTMLButtonElement>,
  ): globalThis.MouseEvent | null => {
    if (!event || typeof event !== "object") return null;
    const ownerWindow = presentation.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    const reactEvent = event as MouseEvent<HTMLButtonElement> & {
      _reactName?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
      persist?: unknown;
    };
    const reactEventPrototype = Object.getPrototypeOf(event) as { constructor?: { name?: unknown } } | null;
    if (
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      !nativeEvent.bubbles ||
      nativeEvent.eventPhase === ownerWindow.Event.NONE ||
      event.type !== "click" ||
      event.button !== 0 ||
      !event.bubbles ||
      event.defaultPrevented ||
      nativeEvent.defaultPrevented ||
      event.currentTarget !== source ||
      target !== nativeEvent.target ||
      !(target instanceof ownerWindow.Node) ||
      target.ownerDocument !== presentation.ownerDocument ||
      !source.contains(target) ||
      !nativeEvent.composedPath().includes(source) ||
      !nativeEvent.composedPath().includes(presentation.elements.card) ||
      reactEventPrototype?.constructor?.name !== "SyntheticBaseEvent" ||
      reactEvent._reactName !== "onClick" ||
      typeof reactEvent.isDefaultPrevented !== "function" ||
      typeof reactEvent.isPropagationStopped !== "function" ||
      typeof reactEvent.persist !== "function" ||
      !reviewCardDomContains(presentation.dom, target)
    ) {
      return null;
    }
    return nativeEvent;
  };

  const currentPresentation = (
    action: ReviewCardAction,
    event: MouseEvent<HTMLButtonElement>,
  ): { presentation: ReviewCardPresentation; nativeEvent: globalThis.MouseEvent } | null => {
    const runtime = currentRuntime;
    const presentation = runtime?.presentation;
    const element =
      action.kind === "toggle"
        ? presentation?.elements.toggle
        : action.kind === "accept"
          ? presentation?.elements.accept
          : action.kind === "reject"
            ? presentation?.elements.reject
            : action.kind === "resolve"
              ? presentation?.elements.resolve
              : action.index === null
                ? null
                : presentation?.elements.rows[action.index]?.link;
    const expectedAction =
      action.kind === "toggle"
        ? render.toggle
        : action.kind === "accept"
          ? render.accept
          : action.kind === "reject"
            ? render.reject
            : action.kind === "resolve"
              ? render.resolve
              : action.index === null
                ? null
                : render.threadLinks[action.index];
    if (
      !runtime ||
      !presentation ||
      runtime.isRetired() ||
      presentation.render !== render ||
      presentation.authority !== authority ||
      cells.active.current !== presentation ||
      cells.retired.has(presentation) ||
      action.renderIdentity !== identity ||
      expectedAction !== action ||
      !element ||
      !element.isConnected ||
      !reviewCardControlIsEnabled(element) ||
      !action.enabled ||
      !reviewCardFactsAreCurrent(authority) ||
      !exactReviewCardDomIsCurrent(presentation) ||
      !runtime.publishedDomMatches()
    ) {
      return null;
    }
    const nativeEvent = nativeClick(presentation, element, event);
    return nativeEvent ? { presentation, nativeEvent } : null;
  };

  const reserve = (action: ReviewCardAction, event: MouseEvent<HTMLButtonElement>) => {
    const current = currentPresentation(action, event);
    if (
      !current ||
      cells.claimedEvents.has(event) ||
      cells.claimedEvents.has(current.nativeEvent) ||
      cells.claimedActions.has(action)
    ) {
      return null;
    }
    const presentationWasClaimed = cells.claimedPresentations.has(current.presentation);
    cells.claimedPresentations.add(current.presentation);
    cells.claimedEvents.add(event);
    cells.claimedEvents.add(current.nativeEvent);
    cells.claimedActions.add(action);
    let pending = true;
    return Object.freeze({
      rollback: () => {
        if (!pending) return;
        pending = false;
        cells.claimedEvents.delete(event);
        cells.claimedEvents.delete(current.nativeEvent);
        cells.claimedActions.delete(action);
        if (!presentationWasClaimed) cells.claimedPresentations.delete(current.presentation);
      },
      retain: () => {
        pending = false;
      },
      releaseAction: () => {
        if (!pending) return;
        pending = false;
        cells.claimedActions.delete(action);
      },
    });
  };

  const invoke = (action: ReviewCardAction, event: MouseEvent<HTMLButtonElement>) => {
    const claim = reserve(action, event);
    if (!claim) return;
    if (action.kind === "toggle") {
      claim.retain();
      render.retire();
      authority.setOpen(!authority.open);
      return;
    }
    if (action.kind === "thread") {
      try {
        authority.setActiveComment.call(authority.session, action.threadId!);
      } finally {
        claim.releaseAction();
      }
      return;
    }

    const targets = action.kind === "resolve" ? authority.renderedResolveTargets : authority.renderedSuggestionTargets;
    const owner = claimCommentBatch(authority.coordinator, {
      scope: authority.scope,
      review: authority.review,
      authorName: authority.reviewSnapshot.authorName,
      action: action.kind === "accept" ? "review-accept" : action.kind === "reject" ? "review-reject" : "review-resolve",
      targets,
    });
    if (!owner) {
      claim.rollback();
      return;
    }
    claim.retain();
    void executeCommentBatch(authority.coordinator, owner, authority.ops, authority.onToast);
  };

  const action = (kind: ReviewCardActionKind, enabled: boolean, index: number | null = null, threadId: string | null = null) => {
    const owner = new ReviewCardElementOwner<HTMLButtonElement>(onElementChange);
    controlOwners.push(owner);
    const owned = {} as ReviewCardAction;
    Object.assign(owned, {
      identity: Symbol(`review-card-${kind}`),
      renderIdentity: identity,
      kind,
      index,
      threadId,
      enabled,
      capture: owner.capture,
      onClick: (event: MouseEvent<HTMLButtonElement>) => invoke(owned, event),
    });
    return Object.freeze(owned);
  };

  const toggle = action("toggle", true);
  const acceptEnabled =
    !authority.busy &&
    !authority.blocked &&
    authority.renderedSuggestionTargets.length === authority.pending.length &&
    authority.applicable.length > 0;
  const rejectEnabled = !authority.busy && !authority.blocked && authority.renderedSuggestionTargets.length === authority.pending.length;
  const resolveEnabled = !authority.busy && !authority.blocked && authority.renderedResolveTargets.length === authority.unresolved.length;
  const accept = authority.actionRegion === "suggestions" ? action("accept", acceptEnabled) : null;
  const reject = authority.actionRegion === "suggestions" ? action("reject", rejectEnabled) : null;
  const resolve = authority.actionRegion === "resolve" ? action("resolve", resolveEnabled) : null;
  const threadLinks = authority.open ? authority.mine.map((thread, index) => action("thread", true, index, thread.id)) : [];

  const establish = () => {
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() || lastRuntime.isExactElementReplay()) &&
        acceptsSuccessorOf(lastRuntime.presentation)
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (renderRetired || invalidBeforeEstablish) return undefined;
    if (!reviewCardFactsAreCurrent(authority, true)) return undefined;
    const elements = committedElements();
    const placement = elements ? captureReviewCardPlacement(elements.card) : null;
    if (!elements || !placement) return undefined;
    const presentation: ReviewCardPresentation = Object.freeze({
      identity: Symbol("review-card-presentation"),
      render,
      authority,
      elements,
      ownerDocument: elements.card.ownerDocument,
      dom: snapshotReviewCardDom(elements.card),
      placement,
    });
    if (!exactReviewCardDomIsCurrent(presentation)) return undefined;

    const replay = cells.replay.current;
    if (replay) {
      const sameAuthority = reviewCardAuthoritiesMatch(replay.source.authority, authority);
      const exactReplay =
        sameAuthority &&
        replay.source.render.isRetired() &&
        cells.retired.has(replay.source) &&
        cells.successorOf.current === replay.source &&
        replay.refsAreExact() &&
        replay.historyIsClean() &&
        elements.card === replay.dom.node &&
        reviewCardPlacementMatches(elements.card, replay.placement) &&
        reviewCardDomMatches(replay.dom);
      cells.replay.current = null;
      replay.release();
      if (cells.successorOf.current === replay.source) cells.successorOf.current = null;
      if (sameAuthority && !exactReplay) {
        renderRetired = true;
        cells.retired.add(presentation);
        return undefined;
      }
    }

    const previous = cells.active.current;
    if (previous && previous !== presentation) previous.render.retire();
    const transitionSource = cells.successorOf.current;
    const owners = expectedOwners();
    const replayOwners = new Set<ReviewCardElementOwnerView>();
    // On an update, Strict Mode replays only refs for DOM that the update mounted.
    if (transitionSource?.authority.mount === authority.mount) {
      for (const owner of owners) {
        const element = owner.element();
        if (element && !reviewCardDomContains(transitionSource.dom, element)) replayOwners.add(owner);
      }
    }
    const runtime = createRuntime(presentation, replayOwners);
    currentRuntime = runtime;
    lastRuntime = runtime;
    if (!runtime.publish(owners)) {
      runtime.retireForElement();
      return undefined;
    }
    return runtime.retireForLayout;
  };

  const retire = () => {
    if (renderRetired) return false;
    if (currentRuntime) {
      currentRuntime.retireForAction();
      return true;
    }
    renderRetired = true;
    return true;
  };

  Object.assign(render, {
    identity,
    authority,
    toggle,
    accept,
    reject,
    resolve,
    threadLinks: Object.freeze(threadLinks),
    captureCard: cardOwner.capture,
    captureHeader: headerOwner.capture,
    captureActions: actionsOwner.capture,
    captureList: listOwner.capture,
    captureRows: Object.freeze(rowOwners.map((owner) => owner.capture)),
    captureToggle: toggle.capture,
    onToggle: toggle.onClick,
    captureAccept: accept?.capture ?? null,
    onAccept: accept?.onClick ?? null,
    captureReject: reject?.capture ?? null,
    onReject: reject?.onClick ?? null,
    captureResolve: resolve?.capture ?? null,
    onResolve: resolve?.onClick ?? null,
    captureThreadLinks: Object.freeze(threadLinks.map((link) => link.capture)),
    onThreadClicks: Object.freeze(threadLinks.map((link) => link.onClick)),
    establish,
    retire,
    isRetired: () => renderRetired,
  });
  return Object.freeze(render);
}

/** One agent/human review: verdict + summary, expandable to its threads, Accept all / Reject all on the pending suggestions. */
const ReviewCard = memo(function ReviewCard({ position, review, threads, session, text, ops, coordinator, onToast }: { position: number; review: ReviewDto; threads: CommentThread[]; session: CollabSession; text: string; ops: ReturnType<typeof useCommentOps>; coordinator: CommentRowActionCoordinator; onToast?: CommentsPanelProps["onToast"] }) {
  const [open, setOpen] = useState(false);
  const [mount] = useState(() => Symbol("review-card"));
  const [cells] = useState<ReviewCardCells>(() => ({
    active: { current: null },
    successorOf: { current: null },
    replay: { current: null },
    retired: new WeakSet<ReviewCardPresentation>(),
    claimedPresentations: new WeakSet<ReviewCardPresentation>(),
    claimedEvents: new WeakSet<object>(),
    claimedActions: new WeakSet<ReviewCardAction>(),
  }));
  const replayCleanup = useRef(0);
  useLayoutEffect(() => {
    replayCleanup.current += 1;
    return () => {
      replayCleanup.current += 1;
      const cleanup = replayCleanup.current;
      queueMicrotask(() => {
        // A Strict Mode setup cancels this; a real unmount releases a staged observer.
        if (replayCleanup.current !== cleanup) return;
        const replay = cells.replay.current;
        if (!replay) return;
        cells.replay.current = null;
        if (cells.successorOf.current === replay.source) cells.successorOf.current = null;
        replay.release();
      });
    };
  }, [cells]);
  const [, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const mine = reviewThreads(review, threads);
  const withSuggestion = commentSuggestionTargets(mine, text);
  const pending = withSuggestion.filter((target) => target.state === "pending" || target.state === "outdated");
  const applicable = pending.filter((target) => target.state === "pending");
  const unresolved = mine.filter((t) => !t.resolved);
  const renderedSuggestionTargets = pending.map((target) => snapshotCommentSuggestionTarget(session, target)).filter((target): target is CommentSuggestionBatchTarget => target !== null);
  const renderedResolveTargets = unresolved.map((thread) => snapshotCommentResolveTarget(session, thread)).filter((target): target is CommentResolveBatchTarget => target !== null);
  const renderedTargets = pending.length > 0 ? renderedSuggestionTargets : renderedResolveTargets;
  const scope = reviewBatchScope(review.id);
  const batchState = useCommentBatchState(coordinator, scope, renderedTargets);
  const busy = batchState.owner !== null;
  const partial = applicable.length !== pending.length;
  const acceptTitle = partial ? `Accept all suggestions (${applicable.length} of ${pending.length}; outdated ones are skipped)` : "Accept all suggestions";
  const authority = createReviewCardAuthority({
    mount,
    position,
    review,
    threads,
    session,
    text,
    ops,
    coordinator,
    onToast,
    open,
    setOpen,
  });
  const publication = createReviewCardRender(authority, cells, requestPublicationSuccessor);
  useLayoutEffect(() => publication.establish(), [publication]);
  const {
    captureCard,
    captureHeader,
    captureActions,
    captureList,
    captureRows,
    captureToggle,
    onToggle,
    captureAccept,
    onAccept,
    captureReject,
    onReject,
    captureResolve,
    onResolve,
    captureThreadLinks,
    onThreadClicks,
  } = publication;

  return (
    <div ref={captureCard} className={REVIEW_CARD_CLASS} data-testid="review-card" data-review-id={review.id} data-verdict={review.verdict}>
      <div ref={captureHeader} className={REVIEW_HEADER_CLASS} data-testid="review-header">
        <AuthorAvatar id={review.collabAuthorId} name={review.authorName} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className={cn("text-[13px] font-semibold", verdictTone(review.verdict))} data-testid="review-verdict">
              {reviewVerdictLabel(review.authorName, review.verdict)}
            </span>
            <span className="text-xs text-ink-4" data-testid="comment-timestamp">
              {relativeTime(new Date(review.createdAt).getTime())}
            </span>
          </div>
          <div className="text-xs text-ink-3" data-testid="review-counts">
            {reviewSummaryLabel(mine.length, withSuggestion.length)}
            {withSuggestion.length > 0 && pending.length === 0 && <span> · all decided</span>}
          </div>
          {review.summary && <MentionBody body={review.summary} className="mt-1 text-[13px] leading-5 text-ink-2" />}
        </div>
        <button ref={captureToggle} type="button" className={REVIEW_TOGGLE_CLASS} onClick={onToggle} aria-expanded={open} aria-label={open ? "Collapse review" : "Expand review"} data-testid="review-toggle">
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
      </div>
      {/* Two equal columns, single-line labels at every panel width (280–720 px). The "(n of m)" count only
          shows once the row is wide enough for it; the tooltip always carries the full wording. */}
      {authority.actionRegion === "suggestions" && (
        <div ref={captureActions} className={REVIEW_SUGGESTION_ACTIONS_CLASS} data-testid="review-actions">
          <button
            ref={captureAccept}
            type="button"
            className={REVIEW_ACCEPT_CLASS}
            disabled={busy || batchState.blocked || renderedSuggestionTargets.length !== pending.length || applicable.length === 0}
            aria-busy={batchState.owner?.action === "review-accept" || undefined}
            onClick={onAccept!}
            title={acceptTitle}
            aria-label={acceptTitle}
            data-testid="review-accept-all"
          >
            {batchState.owner?.action === "review-accept" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <CheckCheck size={13} aria-hidden />}
            {batchState.owner?.action === "review-accept" ? "Accepting…" : "Accept all"}
            {partial && <span className="hidden text-[11px] opacity-80 @min-[18rem]:inline">({applicable.length} of {pending.length})</span>}
          </button>
          <button
            ref={captureReject}
            type="button"
            className={REVIEW_REJECT_CLASS}
            disabled={busy || batchState.blocked || renderedSuggestionTargets.length !== pending.length}
            aria-busy={batchState.owner?.action === "review-reject" || undefined}
            onClick={onReject!}
            title="Reject all suggestions"
            aria-label="Reject all suggestions"
            data-testid="review-reject-all"
          >
            {batchState.owner?.action === "review-reject" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <X size={13} aria-hidden />}
            {batchState.owner?.action === "review-reject" ? "Rejecting…" : "Reject all"}
          </button>
        </div>
      )}
      {/* Every suggestion decided but comments still open: one click clears the review from Open. */}
      {authority.actionRegion === "resolve" && (
        <div ref={captureActions} className={REVIEW_RESOLVE_ACTIONS_CLASS} data-testid="review-actions">
          <button
            ref={captureResolve}
            type="button"
            className={REVIEW_RESOLVE_CLASS}
            disabled={busy || batchState.blocked || renderedResolveTargets.length !== unresolved.length}
            aria-busy={batchState.owner?.action === "review-resolve" || undefined}
            onClick={onResolve!}
            title={`Resolve the ${unresolved.length === 1 ? "open comment" : `${unresolved.length} open comments`} of this review`}
            data-testid="review-resolve-all"
          >
            {batchState.owner?.action === "review-resolve" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Check size={13} aria-hidden />}
            {batchState.owner?.action === "review-resolve" ? "Resolving…" : "Resolve all"}
          </button>
        </div>
      )}
      {open && (
        <ul ref={captureList} className={REVIEW_THREADS_CLASS} data-testid="review-threads">
          {mine.map((t, index) => {
            const targets = withSuggestion.filter((target) => target.thread.id === t.id);
            const pendingTargets = targets.filter((target) => target.state === "pending" || target.state === "outdated");
            const state = targets.length === 1 ? targets[0].state : pendingTargets.length > 0 ? `${pendingTargets.length} pending` : targets.length > 0 ? "all decided" : null;
            return (
              <li ref={captureRows[index]} key={t.id} data-testid="review-thread-row">
                <button
                  ref={captureThreadLinks[index]}
                  type="button"
                  className={REVIEW_THREAD_LINK_CLASS}
                  onClick={onThreadClicks[index]}
                  data-testid="review-thread-link"
                  data-thread-id={t.id}
                >
                  {t.resolved ? <CheckCheck size={12} className="shrink-0 text-success" aria-label="Resolved" /> : <MessageSquare size={12} className="shrink-0 text-ink-4" />}
                  <span className="min-w-0 flex-1 truncate text-ink-2" title={t.quote}>
                    {t.quote || "(comment)"}
                  </span>
                  {state && <span className="suggestion-badge shrink-0">{state}</span>}
                </button>
              </li>
            );
          })}
          {mine.length === 0 && <li className="px-1.5 text-xs italic text-ink-4">The comments of this review were deleted.</li>}
        </ul>
      )}
    </div>
  );
});

interface ReviewLoadState {
  documentId: string;
  reviews: ReviewDto[];
  loaded: boolean;
  loading: boolean;
  error: boolean;
}

interface ReviewLoadCoordinator {
  mounted: boolean;
  initialized: boolean;
  documentId: string;
  threadCount: number;
  version: number;
  request: { documentId: string; version: number } | null;
}

function initialReviewLoadState(documentId: string): ReviewLoadState {
  return { documentId, reviews: [], loaded: false, loading: true, error: false };
}

/** Review cards for the document; thread-count changes coalesce behind one stale-safe request. */
function useReviews(session: CollabSession): ReviewLoadState & { retry: () => void } {
  const threadCount = useSessionValue(session, (s) => s.comments.ymap.size);
  const [state, setState] = useState<ReviewLoadState>(() => initialReviewLoadState(session.docId));
  const coordinator = useRef<ReviewLoadCoordinator>({
    mounted: true,
    initialized: false,
    documentId: session.docId,
    threadCount,
    version: 0,
    request: null,
  });

  const load = useCallback(function loadReviews() {
    const current = coordinator.current;
    if (!current.mounted || current.request) return;

    const request = { documentId: current.documentId, version: current.version };
    current.request = request;
    setState((previous) =>
      previous.documentId === request.documentId
        ? { ...previous, loading: true }
        : initialReviewLoadState(request.documentId),
    );

    const settle = (reviews: ReviewDto[] | null) => {
      const latest = coordinator.current;
      if (latest.request !== request) return;
      latest.request = null;
      if (!latest.mounted) return;
      if (request.documentId !== latest.documentId || request.version !== latest.version) {
        loadReviews();
        return;
      }
      setState((previous) => {
        if (previous.documentId !== request.documentId) return previous;
        if (reviews === null) return { ...previous, loading: false, error: true };
        return { ...previous, reviews, loaded: true, loading: false, error: false };
      });
    };

    void api.documents.reviews(request.documentId).then(
      (response) => settle(response.reviews),
      () => settle(null),
    );
  }, []);

  useEffect(() => {
    const current = coordinator.current;
    current.mounted = true;
    return () => {
      current.mounted = false;
      current.version += 1;
    };
  }, []);

  useLayoutEffect(() => {
    const current = coordinator.current;
    current.mounted = true;
    if (!current.initialized || current.documentId !== session.docId) {
      current.initialized = true;
      current.documentId = session.docId;
      current.threadCount = threadCount;
      current.version += 1;
      setState(initialReviewLoadState(session.docId));
      load();
    }
  }, [load, session.docId, threadCount]);

  useEffect(() => {
    const current = coordinator.current;
    if (!current.mounted || current.documentId !== session.docId || current.threadCount === threadCount) return;
    current.threadCount = threadCount;
    current.version += 1;
    load();
  }, [load, session.docId, threadCount]);

  const retry = useCallback(() => {
    const current = coordinator.current;
    if (!current.mounted || current.documentId !== session.docId || current.request) return;
    current.version += 1;
    load();
  }, [load, session.docId]);

  const visibleState = state.documentId === session.docId ? state : initialReviewLoadState(session.docId);
  return { ...visibleState, retry };
}

function PublishedSuggestionBatchActions({
  session,
  text,
  localSources,
  localTargetSnapshots,
  commentSources,
  targets,
  coordinator,
  batchOwner,
  blocked,
  ops,
  onToast,
}: {
  session: CollabSession;
  text: string;
  localSources: readonly SuggestionGroup[];
  localTargetSnapshots: readonly (LocalSuggestionBatchTarget | null)[];
  commentSources: readonly CommentSuggestionTarget[];
  targets: readonly CommentBatchTarget[];
  coordinator: CommentRowActionCoordinator;
  batchOwner: CommentBatchOwner | null;
  blocked: boolean;
  ops: ReturnType<typeof useCommentOps>;
  onToast: CommentsPanelProps["onToast"];
}) {
  const [claims] = useState<SuggestionBatchClaimCells>(() => ({
    authorities: new WeakSet<SuggestionBatchAuthority>(),
    targets: new WeakSet<object>(),
    owners: new WeakSet<CommentBatchOwner>(),
  }));
  const authority = createSuggestionBatchAuthority({
    session,
    text,
    localSources,
    localTargetSnapshots,
    commentSources,
    targets,
    coordinator,
    batchOwner,
    blocked,
    ops,
    onToast,
    claims,
  });
  return (
    <PublishedSuggestionActions
      state="pending"
      canAccept
      canReject
      onAccept={() => invokeSuggestionBatch(authority, true)}
      onReject={() => invokeSuggestionBatch(authority, false)}
      presentation={authority.presentation}
      batch={authority}
    />
  );
}

export function CommentsPanel({
  session,
  onClose,
  onReveal,
  onPendingDone,
  onCancelRequest,
  onCreateToken,
  focusTab,
  documentComposer,
  focusOnMount = false,
  onToast,
}: CommentsPanelProps) {
  const [visit] = useState<CommentPanelVisit>(() => ({ marker: "comment-panel-visit" }));
  // Threads are selected on their own so a change elsewhere (active thread, reveal, pending composer)
  // keeps the same thread objects and the memoised cards skip their render.
  const threads = useSessionValue(session, (s) => s.comments.list(), jsonEqual);
  const actionCoordinator = useCommentRowActionCoordinator(session, visit, threads);
  const text = useSessionValue(session, (s) => s.ytext.toString());
  const { suggestions, activeCommentId, activeSuggestionId, revealSeq, pending, mode, canEdit } = useSessionValue(
    session,
    (s) => ({
      suggestions: s.suggestions.groups(text),
      activeCommentId: s.activeCommentId,
      activeSuggestionId: s.activeSuggestionId,
      revealSeq: s.revealSeq,
      pending: s.pendingComment,
      mode: s.mode,
      canEdit: s.canEdit,
    }),
    jsonEqual,
  );
  const ops = useCommentOps(session);
  // A replacement session gets its own lazy-load gate: an old picker opening must not eagerly fetch the new viewer.
  const tokenViewerLogin = session.user.login?.toLowerCase() ?? null;
  const tokenViewerName = session.user.name;
  const [tokenRequestIdentity, setTokenRequestIdentity] = useState<{ session: CollabSession; viewerLogin: string; viewerName: string } | null>(null);
  const withOwnTokens =
    tokenViewerLogin !== null &&
    tokenRequestIdentity?.session === session &&
    tokenRequestIdentity.viewerLogin === tokenViewerLogin &&
    tokenRequestIdentity.viewerName === tokenViewerName;
  const requestOwnTokens = useCallback(() => {
    if (tokenViewerLogin === null) return;
    setTokenRequestIdentity((current) =>
      current?.session === session && current.viewerLogin === tokenViewerLogin && current.viewerName === tokenViewerName
        ? current
        : { session, viewerLogin: tokenViewerLogin, viewerName: tokenViewerName },
    );
  }, [session, tokenViewerLogin, tokenViewerName]);
  const { candidates, tokenCount } = useMentionCandidates(session, withOwnTokens);
  // "Connect an agent" under the picker for a user whose token list came back empty, until dismissed (#1025).
  const [connectDismissed, setConnectDismissed] = useState(readConnectDismissed);
  const dismissConnect = useCallback(() => {
    setConnectDismissed(true);
    try {
      window.localStorage.setItem(AGENT_CONNECT_DISMISSED_KEY, "1");
    } catch {
      // Storage unavailable: the row still goes away for this panel.
    }
  }, []);
  const mentionValue = useMemo<MentionCandidatesValue>(
    () => ({
      candidates,
      viewerLogin: session.user.login ?? null,
      onPickerOpen: requestOwnTokens,
      connect: { due: tokenCount === 0 && !connectDismissed, onCreateToken, onDismiss: dismissConnect },
    }),
    [candidates, session.user.login, requestOwnTokens, tokenCount, connectDismissed, onCreateToken, dismissConnect],
  );
  // The agent entries only, and the same reference while they read the same: the cards' request chips read this
  // and stay out of every other candidate change (#1382).
  const agents = useMemo(() => candidates.filter((c) => c.agent), [candidates]);
  const agentCandidates = useStableValue(agents, (a, b) => a === b || jsonEqual(agentNameTuples(a), agentNameTuples(b)));
  const agentNamesValue = useMemo<AgentNamesValue>(
    () => ({ viewerLogin: session.user.login ?? null, nameOf: (login) => displayNameOf(agentCandidates, login) }),
    [agentCandidates, session.user.login],
  );
  const requests = useThreadRequests(session);
  /**
   * A comment that mentions an agent is also a request. The comment goes through the shared doc as usual and the
   * request follows over REST, after the server has that thread: `createRequest` checks `threadId` against the live
   * doc and answers 404 otherwise, so this waits for the sync ack and retries briefly. The request is addressed to
   * the first agent the body mentions (a reply may name a different agent than the thread's root comment). A failed
   * request never loses the comment; the toast says why, or to mention the agent again.
   */
  const postAgentRequest = useCallback(
    async (threadId: string, body: string, mode: AgentRequestMode, selection: { from: number; to: number; quote: string } | null) => {
      await waitForSynced(session);
      const [addressee] = parseAgentMentions(body);
      const payload = {
        mode,
        instruction: requestInstruction(body),
        selection: selection ? { ...selection, quote: selection.quote.slice(0, REQUEST_QUOTE_MAX) } : null,
        threadId,
        agent: addressee ? `${addressee.login}/${addressee.agent}` : null,
      };
      const delays = [0, 250, 500, 1000];
      for (let i = 0; i < delays.length; i++) {
        if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
        try {
          await api.documents.createRequest(session.docId, payload);
          return;
        } catch (err) {
          const status = (err as { status?: unknown }).status;
          if (status === 404 && i < delays.length - 1) continue;
          console.debug("[comments] agent request not posted", err);
          // 400 (unknown agent) and 403 (the owner has not opened the agent to others) carry a message worth showing as is.
          const message = (status === 400 || status === 403) && err instanceof Error && err.message ? err.message : null;
          onToast?.(message ? `The comment is posted, but the request was refused: ${message}` : "The comment is posted, but the request did not reach the agent — mention them again.", "error");
          return;
        }
      }
    },
    [session, onToast],
  );
  const requestFromThread = useCallback(
    (threadId: string, body: string, mode: AgentRequestMode) => {
      const thread = session.comments.list().find((t) => t.id === threadId);
      // A document thread asks about the whole document: selection: null, like the pending composer below.
      const selection = thread?.range && !isDocumentRange(thread.range) ? { from: thread.range.from, to: thread.range.to, quote: thread.quote } : null;
      void postAgentRequest(threadId, body, mode, selection);
    },
    [session, postAgentRequest],
  );
  const { reviews, loaded: reviewsLoaded, loading: reviewsLoading, error: reviewsError, retry: retryReviews } = useReviews(session);
  useLayoutEffect(() => syncCommentBatchReviews(actionCoordinator, reviews), [actionCoordinator, reviews]);
  const unreadRefs = useUnreadRefs(session.docId);
  const hasUnread = (t: CommentThread) => unreadRefs.has(t.id) || t.replies.some((r) => unreadRefs.has(r.id));
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);
  // Decided reviews leave Open: a card sits in Open while a thread of its is unresolved or a suggestion is pending.
  const openReviews = reviews.filter((r) => isReviewOpen(r, threads, text));
  const resolvedReviews = reviews.filter((r) => !isReviewOpen(r, threads, text));
  const commentSuggestions = useMemo(
    () => commentSuggestionTargets(threads, text).filter((target) => target.state === "pending" || target.state === "outdated"),
    [threads, text],
  );
  const commentSuggestionThreads = threads.filter((thread) => commentSuggestions.some((target) => target.thread.id === thread.id));
  const suggestionCount = suggestions.length + commentSuggestions.length;
  // Preserve the tab for current work; otherwise land on Suggestions when suggesting or when it is the only populated tab (#117).
  const [tab, setTab] = useState<Tab>(() => {
    if (focusTab) return focusTab.tab;
    if (pending) return "open";
    if (activeSuggestionId) return "suggestions";
    if (activeCommentId) {
      const activeThread = threads.find((thread) => thread.id === activeCommentId);
      if (activeThread) return activeThread.resolved ? "resolved" : "open";
    }
    return mode === "suggesting" || (open.length === 0 && suggestionCount > 0) ? "suggestions" : "open";
  });
  const renderedLocalSuggestionTargetSnapshots = snapshotLocalSuggestionTargets(session, suggestions, suggestions);
  const renderedLocalSuggestionTargets = renderedLocalSuggestionTargetSnapshots.filter((target): target is LocalSuggestionBatchTarget => target !== null);
  const renderedCommentSuggestionTargets = commentSuggestions.map((target) => snapshotCommentSuggestionTarget(session, target)).filter((target): target is CommentSuggestionBatchTarget => target !== null);
  const renderedSuggestionBatchTargets = [...renderedLocalSuggestionTargets, ...renderedCommentSuggestionTargets];
  // The global controls only exist on this tab. Elsewhere, do not subscribe the panel to every row owner:
  // the affected review and thread cards update without rerendering unrelated cards.
  const suggestionBatchState = useCommentBatchState(actionCoordinator, SUGGESTIONS_SCOPE, tab === "suggestions" ? renderedSuggestionBatchTargets : []);
  const canAct = session.role === "owner" || session.role === "editor";
  const tablistRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusOnMount) return;
    const timer = window.setTimeout(() => {
      tablistRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
    });
    return () => window.clearTimeout(timer);
  }, [focusOnMount]);

  // The first suggestion that appears while the panel is open switches to the Suggestions tab, once per mount,
  // so a user who switched back is not fought. Skipped while a comment is being composed on the Open tab.
  const autoSwitched = useRef(false);
  const prevSuggestionCount = useRef(suggestionCount);
  useEffect(() => {
    const arrived = prevSuggestionCount.current === 0 && suggestionCount > 0;
    prevSuggestionCount.current = suggestionCount;
    if (!arrived || autoSwitched.current || pending) return;
    if (mode !== "suggesting" && open.length > 0) return;
    autoSwitched.current = true;
    setTab("suggestions");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestionCount]);

  useEffect(() => {
    if (activeSuggestionId) setTab("suggestions");
    else if (activeCommentId) {
      const t = threads.find((x) => x.id === activeCommentId);
      if (t) setTab(t.resolved ? "resolved" : "open");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCommentId, activeSuggestionId, revealSeq]);

  useEffect(() => {
    if (pending) setTab("open");
  }, [pending]);

  useEffect(() => {
    if (focusTab) setTab(focusTab.tab);
  }, [focusTab]);

  // A comment on the whole document (#1025): the pending composer at {0,0}, seeded with `@` when the caller wants
  // the agent picker up at once. The seed is keyed so the composer remounts and reads it; it is cleared when the
  // composer goes (posted or cancelled) so a later plain "comment" starts empty.
  const [seed, setSeed] = useState<{ initial: string; nonce: number } | null>(null);
  const startDocumentComment = useCallback(
    (opts: { mention: boolean; nonce: number }) => {
      if (!session.canComment) return;
      setSeed({ initial: opts.mention ? "@" : "", nonce: opts.nonce });
      session.setPendingComment({ from: 0, to: 0 });
      setTab("open");
    },
    [session],
  );
  useEffect(() => {
    if (documentComposer) startDocumentComment(documentComposer);
  }, [documentComposer, startDocumentComment]);
  // Cleared when a pending composer goes, not on mount: the panel may open with `documentComposer` already set (the
  // hint bar), and the seed and the pending range land in the same commit.
  const hadPending = useRef(false);
  useEffect(() => {
    if (pending) hadPending.current = true;
    else if (hadPending.current) {
      hadPending.current = false;
      setSeed(null);
    }
  }, [pending]);
  // The panel's own entry points: the header button and the empty state (the shell's nonce space is not reused).
  const localNonce = useRef(0);
  const commentOnDocument = useCallback((mention: boolean) => startDocumentComment({ mention, nonce: -++localNonce.current }), [startDocumentComment]);

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "open", label: "Open", count: open.length },
    { id: "resolved", label: "Resolved", count: resolved.length },
    { id: "suggestions", label: "Suggestions", count: suggestionCount },
  ];

  const onTablistKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = rovingIndex(event.key, current, items.length, { orientation: "horizontal", wrap: true });
    if (next < 0) return;
    event.preventDefault();
    setTab(tabs[next].id);
    items[next]?.focus();
  };

  return (
    <MentionCandidatesContext.Provider value={mentionValue}>
    <AgentNamesContext.Provider value={agentNamesValue}>
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface-2" data-testid="comments-panel">
      <div className="flex h-12 items-center justify-between border-b border-line pl-4 pr-2">
        <span className="pane-label">Comments</span>
        <button
          type="button"
          className="icon-btn h-8 w-8"
          onClick={() => {
            retireCommentRowActions(actionCoordinator);
            onClose();
          }}
          aria-label="Close comments"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex items-center gap-1 border-b border-line px-3 py-2">
        <div ref={tablistRef} className="flex min-w-0 flex-1 gap-1" role="tablist" aria-label="Comment lists" aria-orientation="horizontal" onKeyDown={onTablistKeyDown}>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`comments-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="comments-tabpanel"
              tabIndex={tab === t.id ? 0 : -1}
              className={cn("rounded-md px-2.5 py-1 text-xs font-medium", tab === t.id ? "bg-surface text-ink shadow-sm ring-1 ring-line" : "text-ink-3 hover:text-ink")}
              onClick={() => setTab(t.id)}
              onFocus={() => setTab(t.id)}
              data-testid={`comments-tab-${t.id}`}
            >
              {t.label}
              {t.count > 0 && <span className="ml-1 text-ink-4">{t.count}</span>}
            </button>
          ))}
        </div>
        {/* Outside the tablist (which holds only tabs): a comment on the whole document, no selection needed (#1025). */}
        {session.canComment && (
          <button type="button" className="icon-btn h-7 w-7 shrink-0" title="Comment on the document" aria-label="Comment on the document" onClick={() => commentOnDocument(false)} data-testid="comment-document">
            <MessageSquarePlus size={15} />
          </button>
        )}
      </div>
      <div className="scrollbar-thin flex flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto p-3" role="tabpanel" id="comments-tabpanel" aria-labelledby={`comments-tab-${tab}`}>
        {tab !== "suggestions" && reviewsError && (
          <div className="flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger dark:bg-red-950/40" role="alert" aria-atomic="true" data-testid="reviews-error">
            <span className="min-w-0 flex-1">{reviewsLoaded ? "Review details may be out of date." : "Couldn’t load review details."}</span>
            <button type="button" className="btn btn-sm btn-outline shrink-0 gap-1.5" onClick={retryReviews} disabled={reviewsLoading} aria-busy={reviewsLoading || undefined}>
              {reviewsLoading && <Loader2 size={13} className="animate-spin" aria-hidden />}
              {reviewsLoading ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}
        {tab !== "suggestions" && !reviewsError && reviewsLoading && (
          <div className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-xs text-ink-3 ring-1 ring-line" role="status" data-testid="reviews-loading">
            <Loader2 size={13} className="animate-spin" aria-hidden />
            {reviewsLoaded ? "Refreshing review details…" : "Loading review details…"}
          </div>
        )}
        {tab === "open" && openReviews.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="review-cards">
            {openReviews.map((r, index) => (
             <ReviewCard key={r.id} position={index} review={r} threads={threads} session={session} text={text} ops={ops} coordinator={actionCoordinator} onToast={onToast} />
            ))}
          </div>
        )}
        {pending && tab === "open" && (
          <div className="rounded-xl border border-accent bg-surface p-3 shadow-md shadow-accent/10" data-testid="pending-comment">
            {isDocumentRange(pending) ? (
              <div className="comment-quote-document" data-testid="comment-quote-document">
                <FileText size={12} aria-hidden />
                Whole document
              </div>
            ) : (
              <div className={QUOTE_CLASS} data-testid="comment-quote">
                {session.ytext.toString().slice(pending.from, pending.to) || "Selected text"}
              </div>
            )}
            <Composer
              key={seed ? `seed-${seed.nonce}` : "pending"}
              placeholder="Add a comment… (⌘/Ctrl+Enter to post)"
              autoFocus
              initial={seed?.initial ?? ""}
              quote={pending.to > pending.from ? session.ytext.toString().slice(pending.from, pending.to) : undefined}
              request={{ canEdit, defaultMode: "suggest" }}
              onSubmit={(body) => {
                const quote = session.ytext.toString().slice(pending.from, pending.to);
                return ops.add(pending.from, pending.to, body).then((id) => ({ id, quote }));
              }}
              onSuccess={({ id, quote }, body, req) => {
                session.setPendingComment(null);
                if (typeof id === "string") session.setActiveComment(id);
                onPendingDone?.();
                // A document comment asks about the whole document: the request carries selection: null (#1025).
                const selection = isDocumentRange(pending) ? null : { from: pending.from, to: pending.to, quote };
                if (req && typeof id === "string") void postAgentRequest(id, body, req.mode, selection);
              }}
              onCancel={() => {
                session.setPendingComment(null);
                onPendingDone?.();
              }}
            />
          </div>
        )}
        {tab === "open" &&
          (open.length === 0 && !pending && reviewsLoaded ? (
            <EmptyState icon={<MessageSquare size={28} />} title="No open comments">
              {suggestionCount > 0 && (
                <span className="mb-3 flex flex-wrap items-center justify-center gap-1 text-ink-3" data-testid="comments-empty-suggestions">
                  <button type="button" className="inline-flex items-center gap-1 font-medium text-accent hover:underline" onClick={() => setTab("suggestions")} data-testid="comments-empty-suggestions-button">
                    <Sparkles size={13} /> {suggestionCount === 1 ? "1 suggestion" : `${suggestionCount} suggestions`} waiting <ArrowRight size={13} />
                  </button>
                </span>
              )}
              Select some text and press <kbd className="kbd">⌘/Ctrl</kbd>+<kbd className="kbd">Alt</kbd>+<kbd className="kbd">M</kbd> or use the Comment button.
              {session.canComment && (
                <span className="mt-3 flex flex-wrap items-center justify-center gap-1.5 text-ink-3" data-testid="comments-empty-agent-line">
                  Agents can review this document too —
                  <button type="button" className="inline-flex items-center gap-1 font-medium text-accent hover:underline" onClick={() => commentOnDocument(true)} data-testid="comments-empty-agent">
                    <Bot size={13} /> Comment and mention an agent
                  </button>
                </span>
              )}
            </EmptyState>
          ) : (
            open.map((t) => (
              <ThreadCard
                key={t.id}
                thread={t}
                session={session}
                actionCoordinator={actionCoordinator}
                outdated={isSuggestionOutdated(t, text)}
                active={t.id === activeCommentId}
                unread={hasUnread(t)}
                onReveal={onReveal}
                ops={ops}
                onToast={onToast}
                request={requests[t.id] ?? null}
                canRequestEdits={canEdit}
                onCancelRequest={onCancelRequest}
                onRequest={requestFromThread}
              />
            ))
          ))}
        {tab === "resolved" && resolvedReviews.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="review-cards">
            {resolvedReviews.map((r, index) => (
             <ReviewCard key={r.id} position={index} review={r} threads={threads} session={session} text={text} ops={ops} coordinator={actionCoordinator} onToast={onToast} />
            ))}
          </div>
        )}
        {tab === "resolved" &&
          (resolved.length === 0 && resolvedReviews.length === 0 && reviewsLoaded ? (
            <EmptyState title="Nothing resolved yet" />
          ) : (
            resolved.map((t) => (
              <ThreadCard
                key={t.id}
                thread={t}
                session={session}
                actionCoordinator={actionCoordinator}
                outdated={isSuggestionOutdated(t, text)}
                active={t.id === activeCommentId}
                unread={hasUnread(t)}
                onReveal={onReveal}
                ops={ops}
                onToast={onToast}
                request={requests[t.id] ?? null}
                canRequestEdits={canEdit}
                onCancelRequest={onCancelRequest}
                onRequest={requestFromThread}
              />
            ))
          ))}
        {tab === "suggestions" &&
          (suggestionCount === 0 ? (
            <EmptyState icon={<Sparkles size={28} />} title="No pending suggestions">
              Switch to <strong>Suggesting</strong> mode to propose edits that others can accept or reject.
            </EmptyState>
          ) : (
            <>
              {canAct && (
                <PublishedSuggestionBatchActions
                  session={session}
                  text={text}
                  localSources={suggestions}
                  localTargetSnapshots={renderedLocalSuggestionTargetSnapshots}
                  commentSources={commentSuggestions}
                  targets={renderedSuggestionBatchTargets}
                  coordinator={actionCoordinator}
                  batchOwner={suggestionBatchState.owner}
                  blocked={suggestionBatchState.blocked}
                  ops={ops}
                  onToast={onToast}
                />
              )}
              {suggestions.map((s) => (
                <SuggestionCard key={s.id} s={s} session={session} active={s.id === activeSuggestionId} onReveal={onReveal} onToast={onToast} />
              ))}
              {commentSuggestionThreads.map((thread) => (
                <ThreadCard
                  key={`suggestion-${thread.id}`}
                  thread={thread}
                  session={session}
                  actionCoordinator={actionCoordinator}
                  outdated={isSuggestionOutdated(thread, text)}
                  active={thread.id === activeCommentId}
                  unread={hasUnread(thread)}
                  onReveal={onReveal}
                  ops={ops}
                  onToast={onToast}
                  request={requests[thread.id] ?? null}
                  canRequestEdits={canEdit}
                  onCancelRequest={onCancelRequest}
                  onRequest={requestFromThread}
                />
              ))}
            </>
          ))}
      </div>
    </aside>
    </AgentNamesContext.Provider>
    </MentionCandidatesContext.Provider>
  );
}
