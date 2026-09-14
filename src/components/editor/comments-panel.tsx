"use client";

import { Children, cloneElement, createContext, isValidElement, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { composeRefs, useComposedRefs } from "radix-ui/internal";
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
export function filterMentionCandidates(candidates: readonly MentionCandidate[], query: string, max: number): MentionCandidate[] {
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
export function mentionedAgents(body: string, candidates: readonly MentionCandidate[]): MentionCandidate[] {
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
const claimedSuggestionNativeEvents = new WeakSet<Event>();
const attemptedSuggestionKeyboardNativeEvents = new WeakSet<Event>();
const attemptedSuggestionKeyboardReactEvents = new WeakSet<object>();
const claimedSuggestionKeyboardReactEvents = new WeakSet<object>();
const claimedSuggestionKeyboardMovements = new WeakSet<SuggestionKeyboardMovement>();
const claimedSuggestionKeyboardWindowProofs = new WeakSet<SuggestionKeyboardWindowProof>();
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

type SuggestionNavigationKey =
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "Home"
  | "End";

interface SuggestionActionControlPublication {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly actionIdentity: symbol;
  readonly kind: SuggestionActionKind;
  readonly element: HTMLButtonElement;
  readonly path: readonly EventTarget[];
  readonly action: SuggestionActionDefinition;
}

interface SuggestionKeyboardPropertyAuthority<Value> {
  readonly read: (value: object) => Value;
  readonly isCurrent: () => boolean;
}

interface SuggestionKeyboardMethodAuthority<Args extends readonly unknown[], Result> {
  readonly value: (...args: Args) => Result;
  readonly call: (receiver: object, ...args: Args) => Result;
  readonly isCurrent: () => boolean;
}

interface SuggestionKeyboardWindowMethodAuthority<Method> {
  readonly value: Method;
  readonly isCurrent: () => boolean;
}

interface SuggestionKeyboardTrustedAuthority {
  readonly matches: (event: object) => boolean;
  readonly read: (event: object) => boolean;
  readonly isCurrent: () => boolean;
}

interface SuggestionKeyboardActiveElementAuthority {
  readonly read: (document: Document) => Element | null;
  readonly isCurrent: () => boolean;
}

interface SuggestionKeyboardWindowProof {
  readonly registration: SuggestionKeyboardWindowRegistration;
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly terminal: EventTarget;
  readonly path: readonly EventTarget[];
}

interface SuggestionKeyboardWindowRegistration {
  readonly proofFor: (
    event: globalThis.KeyboardEvent,
  ) => SuggestionKeyboardWindowProof | null;
  readonly claim: (proof: SuggestionKeyboardWindowProof) => boolean;
  readonly release: () => void;
  readonly isCurrent: () => boolean;
}

interface SuggestionKeyboardAuthority {
  readonly ownerWindow: Window & typeof globalThis;
  readonly Event: typeof Event;
  readonly KeyboardEvent: typeof globalThis.KeyboardEvent;
  readonly HTMLElement: typeof HTMLElement;
  readonly keyboardPrototype: object;
  readonly prototypeOf: typeof Object.getPrototypeOf;
  readonly apply: typeof Reflect.apply;
  readonly trusted: SuggestionKeyboardTrustedAuthority;
  readonly activeElement: SuggestionKeyboardActiveElementAuthority;
  readonly type: SuggestionKeyboardPropertyAuthority<string>;
  readonly target: SuggestionKeyboardPropertyAuthority<EventTarget | null>;
  readonly currentTarget: SuggestionKeyboardPropertyAuthority<EventTarget | null>;
  readonly phase: SuggestionKeyboardPropertyAuthority<number>;
  readonly bubbles: SuggestionKeyboardPropertyAuthority<boolean>;
  readonly cancelable: SuggestionKeyboardPropertyAuthority<boolean>;
  readonly composed: SuggestionKeyboardPropertyAuthority<boolean>;
  readonly defaultPrevented: SuggestionKeyboardPropertyAuthority<boolean>;
  readonly cancelBubble: SuggestionKeyboardPropertyAuthority<boolean>;
  readonly key: SuggestionKeyboardPropertyAuthority<string>;
  readonly code: SuggestionKeyboardPropertyAuthority<string>;
  readonly location: SuggestionKeyboardPropertyAuthority<number>;
  readonly ctrlKey: SuggestionKeyboardPropertyAuthority<boolean>;
  readonly metaKey: SuggestionKeyboardPropertyAuthority<boolean>;
  readonly altKey: SuggestionKeyboardPropertyAuthority<boolean>;
  readonly shiftKey: SuggestionKeyboardPropertyAuthority<boolean>;
  readonly repeat: SuggestionKeyboardPropertyAuthority<boolean>;
  readonly composing: SuggestionKeyboardPropertyAuthority<boolean>;
  readonly view: SuggestionKeyboardPropertyAuthority<Window | null>;
  readonly composedPath: SuggestionKeyboardMethodAuthority<readonly [], EventTarget[]>;
  readonly preventDefault: SuggestionKeyboardMethodAuthority<readonly [], void>;
  readonly focus: SuggestionKeyboardMethodAuthority<readonly [options?: FocusOptions], void>;
  readonly addWindowEventListener: SuggestionKeyboardWindowMethodAuthority<
    Window["addEventListener"]
  >;
  readonly removeWindowEventListener: SuggestionKeyboardWindowMethodAuthority<
    Window["removeEventListener"]
  >;
  readonly terminal: SuggestionKeyboardWindowRegistration;
  readonly isCurrent: () => boolean;
}

interface SuggestionReactKeyProof {
  readonly event: object;
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly target: HTMLButtonElement;
  readonly currentTarget: HTMLDivElement;
  readonly phase: number;
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
  readonly isDefaultPrevented: () => boolean;
  readonly isPropagationStopped: () => boolean;
  readonly defaultPreventedResult: false;
  readonly propagationStoppedResult: false;
}

interface SuggestionKeyboardMovement {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly sourceIdentity: symbol;
  readonly sourceActionIdentity: symbol;
  readonly destinationIdentity: symbol;
  readonly destinationActionIdentity: symbol;
  readonly key: SuggestionNavigationKey;
  readonly source: SuggestionActionControlPublication;
  readonly destination: SuggestionActionControlPublication;
}

interface SuggestionKeyboardNativeProof {
  readonly event: globalThis.KeyboardEvent;
  readonly publication: SuggestionActionPublication;
  readonly movement: SuggestionKeyboardMovement;
  readonly delegatedRoot: EventTarget;
  readonly path: readonly EventTarget[];
  readonly terminal: EventTarget;
  readonly window: SuggestionKeyboardWindowProof;
  readonly key: SuggestionNavigationKey;
  readonly code: string;
  readonly location: number;
  readonly capture: SuggestionReactKeyProof;
  bubble: SuggestionReactKeyProof | null;
  crossed: boolean;
}

interface SuggestionActionRender {
  readonly identity: symbol;
  readonly authority: SuggestionActionAuthority;
  readonly accept: SuggestionActionDefinition | null;
  readonly reject: SuggestionActionDefinition | null;
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly onRootClickCapture: (event: MouseEvent<HTMLDivElement>) => void;
  readonly onRootClick: (event: MouseEvent<HTMLDivElement>) => void;
  readonly onRootKeyDownCapture: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onRootKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
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
  readonly acceptControl: SuggestionActionControlPublication | null;
  readonly rejectControl: SuggestionActionControlPublication | null;
  readonly actions: readonly SuggestionActionControlPublication[];
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
  readonly claimedControls: WeakSet<SuggestionActionControlPublication>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
  readonly attemptedReactEvents: WeakSet<object>;
  readonly attemptedNativeEvents: WeakSet<Event>;
  readonly claimedMovements: WeakSet<SuggestionKeyboardMovement>;
  readonly claimedWindowProofs: WeakSet<SuggestionKeyboardWindowProof>;
  readonly evaluatingPublications: WeakSet<SuggestionActionPublication>;
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
  readonly stageCaptureKey: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly stageBubbleKey: (event: KeyboardEvent<HTMLDivElement>) => void;
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

function suggestionKeyboardDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  return Boolean(
    current &&
      current.configurable === expected.configurable &&
      current.enumerable === expected.enumerable &&
      current.writable === expected.writable &&
      current.value === expected.value &&
      current.get === expected.get &&
      current.set === expected.set,
  );
}

function captureSuggestionKeyboardPropertyAuthority<Value>(
  ownerWindow: Window & typeof globalThis,
  prototype: object,
  property: PropertyKey,
): SuggestionKeyboardPropertyAuthority<Value> | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  let owner: object | null = prototype;
  while (owner) {
    const descriptor = getOwnPropertyDescriptor(owner, property);
    if (descriptor) {
      if (typeof descriptor.get !== "function") return null;
      const descriptorOwner = owner;
      const expected = Object.freeze({ ...descriptor });
      const getter = descriptor.get;
      return Object.freeze({
        read: (value: object) =>
          apply(getter as (this: object) => Value, value, []),
        isCurrent: () =>
          ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
          ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
          ownerWindow.Reflect.apply === apply &&
          suggestionKeyboardDescriptorsMatch(
            getOwnPropertyDescriptor(descriptorOwner, property),
            expected,
          ),
      });
    }
    owner = getPrototypeOf(owner) as object | null;
  }
  return null;
}

function captureSuggestionKeyboardMethodAuthority<
  Args extends readonly unknown[],
  Result,
>(
  ownerWindow: Window & typeof globalThis,
  prototype: object,
  property: PropertyKey,
): SuggestionKeyboardMethodAuthority<Args, Result> | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  let owner: object | null = prototype;
  while (owner) {
    const descriptor = getOwnPropertyDescriptor(owner, property);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") return null;
      const descriptorOwner = owner;
      const expected = Object.freeze({ ...descriptor });
      const method = descriptor.value as (...args: Args) => Result;
      return Object.freeze({
        value: method,
        call: (receiver: object, ...args: Args) => apply(method, receiver, args),
        isCurrent: () =>
          ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
          ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
          ownerWindow.Reflect.apply === apply &&
          suggestionKeyboardDescriptorsMatch(
            getOwnPropertyDescriptor(descriptorOwner, property),
            expected,
          ),
      });
    }
    owner = getPrototypeOf(owner) as object | null;
  }
  return null;
}

function captureSuggestionKeyboardWindowMethod<
  Property extends "addEventListener" | "removeEventListener",
>(
  ownerWindow: Window & typeof globalThis,
  property: Property,
): SuggestionKeyboardWindowMethodAuthority<Window[Property]> | null {
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
  const value = reflectGet(ownerWindow, property, ownerWindow) as Window[Property];
  if (!found || typeof value !== "function") return null;
  const isCurrent = () =>
    ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
    ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
    ownerWindow.Reflect.get === reflectGet &&
    path.every(({ target: entry, descriptor, prototype }) => {
      if (getPrototypeOf(entry) !== prototype) return false;
      const current = getOwnPropertyDescriptor(entry, property);
      return descriptor
        ? suggestionKeyboardDescriptorsMatch(current, descriptor)
        : current === undefined;
    }) &&
    reflectGet(ownerWindow, property, ownerWindow) === value;
  return isCurrent() ? Object.freeze({ value, isCurrent }) : null;
}

function captureSuggestionKeyboardTrustedAuthority(
  ownerWindow: Window & typeof globalThis,
): SuggestionKeyboardTrustedAuthority | null {
  let probe: globalThis.KeyboardEvent;
  try {
    probe = new ownerWindow.KeyboardEvent("suggestion-keyboard-intrinsic");
  } catch {
    return null;
  }
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const apply = ownerWindow.Reflect.apply;
  const descriptor = getOwnPropertyDescriptor(probe, "isTrusted");
  if (
    !descriptor ||
    descriptor.configurable !== false ||
    typeof descriptor.get !== "function" ||
    descriptor.set !== undefined
  ) {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  const matches = (event: object) =>
    suggestionKeyboardDescriptorsMatch(
      getOwnPropertyDescriptor(event, "isTrusted"),
      expected,
    );
  return Object.freeze({
    matches,
    read: (event: object) =>
      apply(descriptor.get as (this: object) => boolean, event, []),
    isCurrent: () =>
      ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
      ownerWindow.Reflect.apply === apply &&
      matches(probe),
  });
}

function captureSuggestionKeyboardActiveElementAuthority(
  ownerWindow: Window & typeof globalThis,
): SuggestionKeyboardActiveElementAuthority | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  let owner: object | null = ownerWindow.Document.prototype;
  while (owner) {
    const descriptor = getOwnPropertyDescriptor(owner, "activeElement");
    if (descriptor) {
      if (typeof descriptor.get !== "function") return null;
      const descriptorOwner = owner;
      const expected = Object.freeze({ ...descriptor });
      return Object.freeze({
        read: (document: Document) =>
          apply(
            descriptor.get as (this: Document) => Element | null,
            document,
            [],
          ),
        isCurrent: () =>
          ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
          ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
          ownerWindow.Reflect.apply === apply &&
          suggestionKeyboardDescriptorsMatch(
            getOwnPropertyDescriptor(descriptorOwner, "activeElement"),
            expected,
          ),
      });
    }
    owner = getPrototypeOf(owner) as object | null;
  }
  return null;
}

function createSuggestionKeyboardWindowRegistration(
  ownerWindow: Window & typeof globalThis,
  ownerDocument: Document,
  KeyboardEventConstructor: typeof globalThis.KeyboardEvent,
  keyboardPrototype: object,
  currentTarget: SuggestionKeyboardPropertyAuthority<EventTarget | null>,
  phase: SuggestionKeyboardPropertyAuthority<number>,
  composedPath: SuggestionKeyboardMethodAuthority<readonly [], EventTarget[]>,
  addEventListener: SuggestionKeyboardWindowMethodAuthority<
    Window["addEventListener"]
  >,
  removeEventListener: SuggestionKeyboardWindowMethodAuthority<
    Window["removeEventListener"]
  >,
  apply: typeof Reflect.apply,
  prototypeOf: typeof Object.getPrototypeOf,
  intrinsicsAreCurrent: () => boolean,
): SuggestionKeyboardWindowRegistration | null {
  const proofs = new WeakMap<
    globalThis.KeyboardEvent,
    SuggestionKeyboardWindowProof
  >();
  const invalidEvents = new WeakSet<Event>();
  let claimed: SuggestionKeyboardWindowProof | null = null;
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
      prototypeOf(event) !== keyboardPrototype ||
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
      const eventCurrentTarget = currentTarget.read(event);
      const eventPhase = phase.read(event);
      const path = composedPath.call(event);
      const terminal = path.at(-1);
      if (
        !eventCurrentTarget ||
        eventCurrentTarget !== this ||
        terminal !== this ||
        eventPhase !== ownerWindow.Event.CAPTURING_PHASE ||
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
          currentTarget: eventCurrentTarget,
          terminal,
          path: Object.freeze([...path]),
        }),
      );
    } catch {
      invalidEvents.add(event);
    }
  };
  const proofFor = (event: globalThis.KeyboardEvent) => {
    const proof = proofs.get(event);
    if (
      !proof ||
      !active ||
      released ||
      claimed !== null ||
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
      const path = composedPath.call(event);
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
  const registration: SuggestionKeyboardWindowRegistration = Object.freeze({
    proofFor,
    claim: (proof: SuggestionKeyboardWindowProof) => {
      if (claimed || proofFor(proof.nativeEvent) !== proof) return false;
      claimed = proof;
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

function captureSuggestionKeyboardAuthority(
  ownerWindow: Window & typeof globalThis,
  ownerDocument: Document,
): SuggestionKeyboardAuthority | null {
  try {
    const EventConstructor = ownerWindow.Event;
    const UIEventConstructor = ownerWindow.UIEvent;
    const KeyboardEventConstructor = ownerWindow.KeyboardEvent;
    const DocumentConstructor = ownerWindow.Document;
    const HTMLElementConstructor = ownerWindow.HTMLElement;
    const eventPrototype = EventConstructor.prototype;
    const uiEventPrototype = UIEventConstructor.prototype;
    const keyboardPrototype = KeyboardEventConstructor.prototype;
    const documentPrototype = DocumentConstructor.prototype;
    const htmlElementPrototype = HTMLElementConstructor.prototype;
    const prototypeOf = ownerWindow.Object.getPrototypeOf;
    const apply = ownerWindow.Reflect.apply;
    const prototypeLinks = [
      [keyboardPrototype, prototypeOf(keyboardPrototype)],
      [uiEventPrototype, prototypeOf(uiEventPrototype)],
      [eventPrototype, prototypeOf(eventPrototype)],
      [documentPrototype, prototypeOf(documentPrototype)],
      [htmlElementPrototype, prototypeOf(htmlElementPrototype)],
    ] as const;
    const trusted = captureSuggestionKeyboardTrustedAuthority(ownerWindow);
    const activeElement =
      captureSuggestionKeyboardActiveElementAuthority(ownerWindow);
    const type = captureSuggestionKeyboardPropertyAuthority<string>(
      ownerWindow,
      eventPrototype,
      "type",
    );
    const target =
      captureSuggestionKeyboardPropertyAuthority<EventTarget | null>(
        ownerWindow,
        eventPrototype,
        "target",
      );
    const currentTarget =
      captureSuggestionKeyboardPropertyAuthority<EventTarget | null>(
        ownerWindow,
        eventPrototype,
        "currentTarget",
      );
    const phase = captureSuggestionKeyboardPropertyAuthority<number>(
      ownerWindow,
      eventPrototype,
      "eventPhase",
    );
    const bubbles = captureSuggestionKeyboardPropertyAuthority<boolean>(
      ownerWindow,
      eventPrototype,
      "bubbles",
    );
    const cancelable = captureSuggestionKeyboardPropertyAuthority<boolean>(
      ownerWindow,
      eventPrototype,
      "cancelable",
    );
    const composed = captureSuggestionKeyboardPropertyAuthority<boolean>(
      ownerWindow,
      eventPrototype,
      "composed",
    );
    const defaultPrevented =
      captureSuggestionKeyboardPropertyAuthority<boolean>(
        ownerWindow,
        eventPrototype,
        "defaultPrevented",
      );
    const cancelBubble = captureSuggestionKeyboardPropertyAuthority<boolean>(
      ownerWindow,
      eventPrototype,
      "cancelBubble",
    );
    const key = captureSuggestionKeyboardPropertyAuthority<string>(
      ownerWindow,
      keyboardPrototype,
      "key",
    );
    const code = captureSuggestionKeyboardPropertyAuthority<string>(
      ownerWindow,
      keyboardPrototype,
      "code",
    );
    const location = captureSuggestionKeyboardPropertyAuthority<number>(
      ownerWindow,
      keyboardPrototype,
      "location",
    );
    const ctrlKey = captureSuggestionKeyboardPropertyAuthority<boolean>(
      ownerWindow,
      keyboardPrototype,
      "ctrlKey",
    );
    const metaKey = captureSuggestionKeyboardPropertyAuthority<boolean>(
      ownerWindow,
      keyboardPrototype,
      "metaKey",
    );
    const altKey = captureSuggestionKeyboardPropertyAuthority<boolean>(
      ownerWindow,
      keyboardPrototype,
      "altKey",
    );
    const shiftKey = captureSuggestionKeyboardPropertyAuthority<boolean>(
      ownerWindow,
      keyboardPrototype,
      "shiftKey",
    );
    const repeat = captureSuggestionKeyboardPropertyAuthority<boolean>(
      ownerWindow,
      keyboardPrototype,
      "repeat",
    );
    const composing = captureSuggestionKeyboardPropertyAuthority<boolean>(
      ownerWindow,
      keyboardPrototype,
      "isComposing",
    );
    const view = captureSuggestionKeyboardPropertyAuthority<Window | null>(
      ownerWindow,
      uiEventPrototype,
      "view",
    );
    const composedPath = captureSuggestionKeyboardMethodAuthority<
      readonly [],
      EventTarget[]
    >(ownerWindow, eventPrototype, "composedPath");
    const preventDefault = captureSuggestionKeyboardMethodAuthority<
      readonly [],
      void
    >(ownerWindow, eventPrototype, "preventDefault");
    const focus = captureSuggestionKeyboardMethodAuthority<
      readonly [options?: FocusOptions],
      void
    >(ownerWindow, htmlElementPrototype, "focus");
    const addWindowEventListener = captureSuggestionKeyboardWindowMethod(
      ownerWindow,
      "addEventListener",
    );
    const removeWindowEventListener = captureSuggestionKeyboardWindowMethod(
      ownerWindow,
      "removeEventListener",
    );
    const authorities = [
      type,
      target,
      currentTarget,
      phase,
      bubbles,
      cancelable,
      composed,
      defaultPrevented,
      cancelBubble,
      key,
      code,
      location,
      ctrlKey,
      metaKey,
      altKey,
      shiftKey,
      repeat,
      composing,
      view,
      composedPath,
      preventDefault,
      focus,
    ];
    if (
      !trusted ||
      !activeElement ||
      !addWindowEventListener ||
      !removeWindowEventListener ||
      authorities.some((authority) => authority === null)
    ) {
      return null;
    }
    let stale = false;
    const intrinsicsAreCurrent = () => {
      if (stale) return false;
      const current =
        ownerDocument.defaultView === ownerWindow &&
        ownerWindow.Event === EventConstructor &&
        ownerWindow.UIEvent === UIEventConstructor &&
        ownerWindow.KeyboardEvent === KeyboardEventConstructor &&
        ownerWindow.Document === DocumentConstructor &&
        ownerWindow.HTMLElement === HTMLElementConstructor &&
        ownerWindow.Object.getPrototypeOf === prototypeOf &&
        ownerWindow.Reflect.apply === apply &&
        EventConstructor.prototype === eventPrototype &&
        UIEventConstructor.prototype === uiEventPrototype &&
        KeyboardEventConstructor.prototype === keyboardPrototype &&
        DocumentConstructor.prototype === documentPrototype &&
        HTMLElementConstructor.prototype === htmlElementPrototype &&
        prototypeLinks.every(
          ([prototype, parent]) => prototypeOf(prototype) === parent,
        ) &&
        prototypeOf(keyboardPrototype) === uiEventPrototype &&
        prototypeOf(uiEventPrototype) === eventPrototype &&
        trusted.isCurrent() &&
        activeElement.isCurrent() &&
        addWindowEventListener.isCurrent() &&
        removeWindowEventListener.isCurrent() &&
        authorities.every((authority) => authority?.isCurrent());
      if (!current) stale = true;
      return current;
    };
    const terminal = createSuggestionKeyboardWindowRegistration(
      ownerWindow,
      ownerDocument,
      KeyboardEventConstructor,
      keyboardPrototype,
      currentTarget!,
      phase!,
      composedPath!,
      addWindowEventListener,
      removeWindowEventListener,
      apply,
      prototypeOf,
      intrinsicsAreCurrent,
    );
    if (!terminal) return null;
    return Object.freeze({
      ownerWindow,
      Event: EventConstructor,
      KeyboardEvent: KeyboardEventConstructor,
      HTMLElement: HTMLElementConstructor,
      keyboardPrototype,
      prototypeOf,
      apply,
      trusted,
      activeElement,
      type: type!,
      target: target!,
      currentTarget: currentTarget!,
      phase: phase!,
      bubbles: bubbles!,
      cancelable: cancelable!,
      composed: composed!,
      defaultPrevented: defaultPrevented!,
      cancelBubble: cancelBubble!,
      key: key!,
      code: code!,
      location: location!,
      ctrlKey: ctrlKey!,
      metaKey: metaKey!,
      altKey: altKey!,
      shiftKey: shiftKey!,
      repeat: repeat!,
      composing: composing!,
      view: view!,
      composedPath: composedPath!,
      preventDefault: preventDefault!,
      focus: focus!,
      addWindowEventListener,
      removeWindowEventListener,
      terminal,
      isCurrent: () => intrinsicsAreCurrent() && terminal.isCurrent(),
    });
  } catch {
    return null;
  }
}

function suggestionActionEventPath(
  source: Node,
  ownerDocument: Document,
): readonly EventTarget[] | null {
  const path: EventTarget[] = [];
  for (let current: Node | null = source; current; current = current.parentNode) {
    path.push(current);
    if (current === ownerDocument) return Object.freeze(path);
  }
  return null;
}

function suggestionNavigationKey(key: string): SuggestionNavigationKey | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowUp":
    case "ArrowRight":
    case "ArrowDown":
    case "Home":
    case "End":
      return key;
    default:
      return null;
  }
}

function suggestionKeyboardMovement(
  publication: SuggestionActionPublication,
  source: SuggestionActionControlPublication,
  key: SuggestionNavigationKey,
): SuggestionKeyboardMovement | null {
  const sourceIndex = publication.actions.indexOf(source);
  if (sourceIndex < 0) return null;
  let destinationIndex: number;
  if (key === "ArrowLeft" || key === "ArrowUp") {
    destinationIndex = sourceIndex - 1;
  } else if (key === "ArrowRight" || key === "ArrowDown") {
    destinationIndex = sourceIndex + 1;
  } else if (key === "Home") {
    destinationIndex = 0;
  } else {
    destinationIndex = publication.actions.length - 1;
  }
  const destination = publication.actions[destinationIndex];
  if (!destination || destination === source) return null;
  return Object.freeze({
    identity: Symbol("suggestion-keyboard-movement"),
    publicationIdentity: publication.identity,
    sourceIdentity: source.identity,
    sourceActionIdentity: source.action.identity,
    destinationIdentity: destination.identity,
    destinationActionIdentity: destination.action.identity,
    key,
    source,
    destination,
  });
}

function captureSuggestionReactKeyProof(
  authority: SuggestionKeyboardAuthority,
  event: KeyboardEvent<HTMLDivElement> & {
    readonly isComposing?: boolean;
  },
  nativeEvent: globalThis.KeyboardEvent,
  target: HTMLButtonElement,
  currentTarget: HTMLDivElement,
  phase: number,
  key: SuggestionNavigationKey,
  code: string,
  location: number,
  view: Window,
): SuggestionReactKeyProof | null {
  try {
    const preventDefault = event.preventDefault;
    const stopPropagation = event.stopPropagation;
    const isDefaultPrevented = event.isDefaultPrevented;
    const isPropagationStopped = event.isPropagationStopped;
    if (
      event.nativeEvent !== nativeEvent ||
      event.type !== "keydown" ||
      event.target !== target ||
      event.currentTarget !== currentTarget ||
      event.eventPhase !== phase ||
      event.key !== key ||
      event.code !== code ||
      event.location !== location ||
      !event.bubbles ||
      !event.cancelable ||
      event.defaultPrevented ||
      !event.isTrusted ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      event.repeat ||
      event.isComposing === true ||
      !Object.is(event.view, view) ||
      typeof preventDefault !== "function" ||
      typeof stopPropagation !== "function" ||
      typeof isDefaultPrevented !== "function" ||
      typeof isPropagationStopped !== "function" ||
      authority.apply(isDefaultPrevented, event, []) !== false ||
      authority.apply(isPropagationStopped, event, []) !== false
    ) {
      return null;
    }
    return Object.freeze({
      event,
      nativeEvent,
      target,
      currentTarget,
      phase,
      preventDefault,
      stopPropagation,
      isDefaultPrevented,
      isPropagationStopped,
      defaultPreventedResult: false,
      propagationStoppedResult: false,
    });
  } catch {
    return null;
  }
}

function suggestionReactKeyProofIsCurrent(
  authority: SuggestionKeyboardAuthority,
  proof: SuggestionReactKeyProof,
): boolean {
  try {
    const event = proof.event as KeyboardEvent<HTMLElement>;
    return (
      event.preventDefault === proof.preventDefault &&
      event.stopPropagation === proof.stopPropagation &&
      event.isDefaultPrevented === proof.isDefaultPrevented &&
      event.isPropagationStopped === proof.isPropagationStopped &&
      authority.apply(proof.isDefaultPrevented, proof.event, []) ===
        proof.defaultPreventedResult &&
      authority.apply(proof.isPropagationStopped, proof.event, []) ===
        proof.propagationStoppedResult
    );
  } catch {
    return false;
  }
}

function suggestionReactKeyProofWasPrevented(
  authority: SuggestionKeyboardAuthority,
  proof: SuggestionReactKeyProof,
): boolean {
  try {
    const event = proof.event as KeyboardEvent<HTMLElement>;
    const isDefaultPrevented = event.isDefaultPrevented;
    return (
      event.preventDefault === proof.preventDefault &&
      event.stopPropagation === proof.stopPropagation &&
      event.isPropagationStopped === proof.isPropagationStopped &&
      event.defaultPrevented === true &&
      typeof isDefaultPrevented === "function" &&
      authority.apply(isDefaultPrevented, proof.event, []) === true &&
      authority.apply(proof.isPropagationStopped, proof.event, []) ===
        proof.propagationStoppedResult
    );
  } catch {
    return false;
  }
}

function suggestionPublishedActionsAreCurrent(
  publication: SuggestionActionPublication,
): boolean {
  const expected = [publication.acceptControl, publication.rejectControl].filter(
    (control): control is SuggestionActionControlPublication =>
      Boolean(
        control &&
          control.action.enabled &&
          suggestionActionControlIsEnabled(control.element),
      ),
  );
  return (
    Object.isFrozen(publication.actions) &&
    publication.actions.length <= 2 &&
    publication.actions.length === expected.length &&
    publication.actions.every((control, index) => {
      const expectedAction =
        control.kind === "accept"
          ? publication.render.accept
          : publication.render.reject;
      const expectedElement =
        control.kind === "accept"
          ? publication.elements.accept
          : publication.elements.reject;
      const expectedCallback =
        control.kind === "accept"
          ? publication.authority.onAccept
          : publication.authority.onReject;
      const path = suggestionActionEventPath(
        control.element,
        publication.ownerDocument,
      );
      return (
        control === expected[index] &&
        control.publicationIdentity === publication.identity &&
        control.actionIdentity === control.action.identity &&
        control.action === expectedAction &&
        control.action.renderIdentity === publication.render.identity &&
        control.action.kind === control.kind &&
        control.action.callback === expectedCallback &&
        control.element === expectedElement &&
        control.element.parentElement === publication.elements.root &&
        control.action.enabled &&
        suggestionActionControlIsEnabled(control.element) &&
        path !== null &&
        path.length === control.path.length &&
        path.every((entry, pathIndex) => entry === control.path[pathIndex])
      );
    })
  );
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
  return (
    authority.order.every((kind, index) => {
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
    }) && suggestionPublishedActionsAreCurrent(publication)
  );
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
      return false;
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
    const keyboardProofs = new WeakMap<
      globalThis.KeyboardEvent,
      SuggestionKeyboardNativeProof
    >();
    const invalidKeyboardEvents = new WeakSet<Event>();
    const keyboardOwnerWindow = publication.ownerDocument.defaultView;
    const keyboardAuthority =
      authority.batch === null && keyboardOwnerWindow
        ? captureSuggestionKeyboardAuthority(
            keyboardOwnerWindow,
            publication.ownerDocument,
          )
        : null;

    const removeListeners = () => {
      const ownerWindow = publication.ownerDocument.defaultView;
      if (ownerWindow) removeSuggestionWindowClickListener(ownerWindow, captureNative, true);
      removeSuggestionClickListener(publication.elements.root, crossNativeRoot);
      for (const target of nativeBubbleTargets) removeSuggestionClickListener(target, finalizeNative);
      nativeBubbleTargets.clear();
      keyboardAuthority?.terminal.release();
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

    const suggestionPathsMatch = (
      expected: readonly EventTarget[],
      current: readonly EventTarget[],
    ) =>
      expected.length === current.length &&
      expected.every((entry, index) => current[index] === entry);

    const delegatedRootIsCurrent = (
      path: readonly EventTarget[],
      delegatedRoot: EventTarget,
    ) => {
      const actionRootIndex = path.indexOf(publication.elements.root);
      const delegatedRootIndex = path.indexOf(delegatedRoot);
      return (
        actionRootIndex > 0 &&
        delegatedRootIndex > actionRootIndex &&
        delegatedRootIndex < path.length - 1 &&
        path.lastIndexOf(delegatedRoot) === delegatedRootIndex
      );
    };

    const keyboardCandidateIsCurrent = (
      movement: SuggestionKeyboardMovement,
    ) => {
      const source = movement.source;
      const destination = movement.destination;
      const sourceControl =
        source.kind === "accept"
          ? publication.acceptControl
          : publication.rejectControl;
      const destinationControl =
        destination.kind === "accept"
          ? publication.acceptControl
          : publication.rejectControl;
      return (
        authority.batch === null &&
        currentRuntime === runtime &&
        movement.publicationIdentity === publication.identity &&
        movement.sourceIdentity === source.identity &&
        movement.sourceActionIdentity === source.action.identity &&
        movement.destinationIdentity === destination.identity &&
        movement.destinationActionIdentity === destination.action.identity &&
        source !== destination &&
        source === sourceControl &&
        destination === destinationControl &&
        source.action ===
          (source.kind === "accept" ? render.accept : render.reject) &&
        destination.action ===
          (destination.kind === "accept" ? render.accept : render.reject) &&
        source.action.callback ===
          (source.kind === "accept" ? authority.onAccept : authority.onReject) &&
        destination.action.callback ===
          (destination.kind === "accept"
            ? authority.onAccept
            : authority.onReject) &&
        publication.actions.includes(source) &&
        publication.actions.includes(destination) &&
        suggestionPublishedActionsAreCurrent(publication) &&
        suggestionActionControlIsEnabled(source.element) &&
        suggestionActionControlIsEnabled(destination.element) &&
        !cells.claimedPublications.has(publication) &&
        !cells.claimedControls.has(source) &&
        !cells.claimedControls.has(destination) &&
        !cells.claimedActions.has(source.action) &&
        !cells.claimedActions.has(destination.action) &&
        publicationIsCurrent() &&
        keyboardAuthority?.ownerWindow ===
          publication.ownerDocument.defaultView &&
        keyboardAuthority.isCurrent() &&
        keyboardAuthority.activeElement.read(publication.ownerDocument) ===
          source.element
      );
    };

    const nativeKeyboardIsCurrent = (
      proof: SuggestionKeyboardNativeProof,
      expectedPhase: number,
    ) => {
      const keyboard = keyboardAuthority;
      if (!keyboard) return false;
      try {
        const event = proof.event;
        const path = keyboard.composedPath.call(event);
        const eventView = keyboard.view.read(event);
        return (
          proof.publication === publication &&
          keyboard.isCurrent() &&
          event instanceof keyboard.KeyboardEvent &&
          keyboard.prototypeOf(event) === keyboard.keyboardPrototype &&
          publication.ownerDocument.defaultView === keyboard.ownerWindow &&
          keyboard.trusted.matches(event) &&
          keyboard.trusted.read(event) === true &&
          keyboard.type.read(event) === "keydown" &&
          keyboard.target.read(event) === proof.movement.source.element &&
          keyboard.currentTarget.read(event) === proof.delegatedRoot &&
          keyboard.phase.read(event) === expectedPhase &&
          keyboard.bubbles.read(event) &&
          keyboard.cancelable.read(event) &&
          keyboard.composed.read(event) &&
          !keyboard.defaultPrevented.read(event) &&
          !keyboard.cancelBubble.read(event) &&
          keyboard.key.read(event) === proof.key &&
          keyboard.code.read(event) === proof.code &&
          keyboard.location.read(event) === proof.location &&
          !keyboard.ctrlKey.read(event) &&
          !keyboard.metaKey.read(event) &&
          !keyboard.altKey.read(event) &&
          !keyboard.shiftKey.read(event) &&
          !keyboard.repeat.read(event) &&
          !keyboard.composing.read(event) &&
          (eventView === keyboard.ownerWindow ||
            eventView === proof.window.receiver) &&
          suggestionPathsMatch(proof.path, path) &&
          suggestionPathsMatch(proof.window.path, path) &&
          proof.movement.source.path.length + 1 === path.length &&
          proof.movement.source.path.every(
            (entry, index) => path[index] === entry,
          ) &&
          delegatedRootIsCurrent(path, proof.delegatedRoot) &&
          path.at(-2) === publication.ownerDocument &&
          path.at(-1) === proof.terminal &&
          proof.window.registration === keyboard.terminal &&
          proof.window.nativeEvent === event &&
          proof.window.receiver === proof.window.currentTarget &&
          proof.window.receiver === proof.window.terminal &&
          proof.window.receiver === proof.terminal &&
          keyboard.terminal.proofFor(event) === proof.window &&
          keyboardCandidateIsCurrent(proof.movement)
        );
      } catch {
        return false;
      }
    };

    const releaseKeyboardClaims = (proof: SuggestionKeyboardNativeProof) => {
      cells.claimedPublications.delete(publication);
      cells.claimedControls.delete(proof.movement.source);
      cells.claimedControls.delete(proof.movement.destination);
      cells.claimedActions.delete(proof.movement.source.action);
      cells.claimedActions.delete(proof.movement.destination.action);
    };

    const claimKeyboard = (proof: SuggestionKeyboardNativeProof) => {
      const keyboard = keyboardAuthority;
      const capture = proof.capture;
      const bubble = proof.bubble;
      if (
        !keyboard ||
        !bubble ||
        cells.claimedPublications.has(publication) ||
        cells.claimedControls.has(proof.movement.source) ||
        cells.claimedControls.has(proof.movement.destination) ||
        cells.claimedActions.has(proof.movement.source.action) ||
        cells.claimedActions.has(proof.movement.destination.action) ||
        cells.claimedNativeEvents.has(proof.event) ||
        cells.claimedReactEvents.has(capture.event) ||
        cells.claimedReactEvents.has(bubble.event) ||
        cells.claimedMovements.has(proof.movement) ||
        cells.claimedWindowProofs.has(proof.window) ||
        claimedSuggestionNativeEvents.has(proof.event) ||
        claimedSuggestionKeyboardReactEvents.has(capture.event) ||
        claimedSuggestionKeyboardReactEvents.has(bubble.event) ||
        claimedSuggestionKeyboardMovements.has(proof.movement) ||
        claimedSuggestionKeyboardWindowProofs.has(proof.window) ||
        !cells.evaluatingPublications.has(publication) ||
        proof.window.registration !== keyboard.terminal ||
        !keyboard.terminal.claim(proof.window)
      ) {
        return false;
      }
      cells.claimedPublications.add(publication);
      cells.claimedControls.add(proof.movement.source);
      cells.claimedControls.add(proof.movement.destination);
      cells.claimedActions.add(proof.movement.source.action);
      cells.claimedActions.add(proof.movement.destination.action);
      cells.claimedNativeEvents.add(proof.event);
      cells.claimedReactEvents.add(capture.event);
      cells.claimedReactEvents.add(bubble.event);
      cells.claimedMovements.add(proof.movement);
      cells.claimedWindowProofs.add(proof.window);
      claimedSuggestionNativeEvents.add(proof.event);
      claimedSuggestionKeyboardReactEvents.add(capture.event);
      claimedSuggestionKeyboardReactEvents.add(bubble.event);
      claimedSuggestionKeyboardMovements.add(proof.movement);
      claimedSuggestionKeyboardWindowProofs.add(proof.window);
      return true;
    };

    const stageCaptureKey = (event: KeyboardEvent<HTMLDivElement>) => {
      const keyboard = keyboardAuthority;
      if (!keyboard || !event || typeof event !== "object") return;
      let nativeEvent: globalThis.KeyboardEvent;
      try {
        nativeEvent = event.nativeEvent;
      } catch {
        return;
      }
      if (!nativeEvent || typeof nativeEvent !== "object") return;
      const existing = keyboardProofs.get(nativeEvent);
      if (
        existing ||
        cells.attemptedNativeEvents.has(nativeEvent) ||
        cells.attemptedReactEvents.has(event) ||
        attemptedSuggestionKeyboardNativeEvents.has(nativeEvent) ||
        attemptedSuggestionKeyboardReactEvents.has(event)
      ) {
        if (existing) existing.crossed = true;
        invalidKeyboardEvents.add(nativeEvent);
        keyboardProofs.delete(nativeEvent);
        cells.attemptedNativeEvents.add(nativeEvent);
        cells.attemptedReactEvents.add(event);
        attemptedSuggestionKeyboardNativeEvents.add(nativeEvent);
        attemptedSuggestionKeyboardReactEvents.add(event);
        return;
      }
      cells.attemptedNativeEvents.add(nativeEvent);
      cells.attemptedReactEvents.add(event);
      attemptedSuggestionKeyboardNativeEvents.add(nativeEvent);
      attemptedSuggestionKeyboardReactEvents.add(event);
      try {
        const target = keyboard.target.read(nativeEvent);
        const source =
          publication.acceptControl?.element === target
            ? publication.acceptControl
            : publication.rejectControl?.element === target
              ? publication.rejectControl
              : null;
        const key = suggestionNavigationKey(keyboard.key.read(nativeEvent));
        const windowProof = keyboard.terminal.proofFor(nativeEvent);
        const eventView = keyboard.view.read(nativeEvent);
        const delegatedRoot = keyboard.currentTarget.read(nativeEvent);
        const code = keyboard.code.read(nativeEvent);
        const location = keyboard.location.read(nativeEvent);
        if (
          authority.batch !== null ||
          !source ||
          !key ||
          !windowProof ||
          !keyboard.isCurrent() ||
          publication.ownerDocument.defaultView !== keyboard.ownerWindow ||
          !(nativeEvent instanceof keyboard.KeyboardEvent) ||
          keyboard.prototypeOf(nativeEvent) !== keyboard.keyboardPrototype ||
          !keyboard.trusted.matches(nativeEvent) ||
          keyboard.trusted.read(nativeEvent) !== true ||
          keyboard.type.read(nativeEvent) !== "keydown" ||
          keyboard.target.read(nativeEvent) !== source.element ||
          !delegatedRoot ||
          keyboard.phase.read(nativeEvent) !==
            keyboard.Event.CAPTURING_PHASE ||
          !keyboard.bubbles.read(nativeEvent) ||
          !keyboard.cancelable.read(nativeEvent) ||
          !keyboard.composed.read(nativeEvent) ||
          keyboard.defaultPrevented.read(nativeEvent) ||
          keyboard.cancelBubble.read(nativeEvent) ||
          keyboard.key.read(nativeEvent) !== key ||
          keyboard.ctrlKey.read(nativeEvent) ||
          keyboard.metaKey.read(nativeEvent) ||
          keyboard.altKey.read(nativeEvent) ||
          keyboard.shiftKey.read(nativeEvent) ||
          keyboard.repeat.read(nativeEvent) ||
          keyboard.composing.read(nativeEvent) ||
          (eventView !== keyboard.ownerWindow &&
            eventView !== windowProof.receiver) ||
          keyboard.activeElement.read(publication.ownerDocument) !==
            source.element ||
          !suggestionPublishedActionsAreCurrent(publication) ||
          !publicationIsCurrent()
        ) {
          return;
        }
        const movement = suggestionKeyboardMovement(
          publication,
          source,
          key,
        );
        if (!movement || !keyboardCandidateIsCurrent(movement)) return;
        const path = keyboard.composedPath.call(nativeEvent);
        const terminal = path.at(-1);
        if (
          !terminal ||
          path.length !== source.path.length + 1 ||
          !suggestionPathsMatch(path, windowProof.path) ||
          path.at(-2) !== publication.ownerDocument ||
          terminal !== windowProof.receiver ||
          windowProof.receiver !== windowProof.currentTarget ||
          windowProof.receiver !== windowProof.terminal ||
          !source.path.every((entry, index) => path[index] === entry) ||
          !delegatedRootIsCurrent(path, delegatedRoot)
        ) {
          return;
        }
        const capture = captureSuggestionReactKeyProof(
          keyboard,
          event,
          nativeEvent,
          source.element,
          publication.elements.root,
          keyboard.Event.CAPTURING_PHASE,
          key,
          code,
          location,
          eventView,
        );
        if (!capture) return;
        const proof: SuggestionKeyboardNativeProof = {
          event: nativeEvent,
          publication,
          movement,
          delegatedRoot,
          path: Object.freeze([...path]),
          terminal,
          window: windowProof,
          key,
          code,
          location,
          capture,
          bubble: null,
          crossed: false,
        };
        keyboardProofs.set(nativeEvent, proof);
        queueMicrotask(() => {
          if (keyboardProofs.get(nativeEvent) !== proof) return;
          proof.crossed = true;
          invalidKeyboardEvents.add(nativeEvent);
          keyboardProofs.delete(nativeEvent);
        });
      } catch {
        invalidKeyboardEvents.add(nativeEvent);
        keyboardProofs.delete(nativeEvent);
      }
    };

    const stageBubbleKey = (event: KeyboardEvent<HTMLDivElement>) => {
      const keyboard = keyboardAuthority;
      if (!keyboard || !event || typeof event !== "object") return;
      let nativeEvent: globalThis.KeyboardEvent;
      try {
        nativeEvent = event.nativeEvent;
      } catch {
        return;
      }
      if (!nativeEvent || typeof nativeEvent !== "object") return;
      const proof = keyboardProofs.get(nativeEvent);
      if (
        cells.attemptedReactEvents.has(event) ||
        attemptedSuggestionKeyboardReactEvents.has(event)
      ) {
        if (proof) proof.crossed = true;
        invalidKeyboardEvents.add(nativeEvent);
        keyboardProofs.delete(nativeEvent);
        return;
      }
      cells.attemptedReactEvents.add(event);
      attemptedSuggestionKeyboardReactEvents.add(event);
      if (!proof) return;
      try {
        if (
          proof.crossed ||
          invalidKeyboardEvents.has(nativeEvent) ||
          proof.bubble ||
          event === proof.capture.event ||
          event.nativeEvent !== proof.event ||
          proof.publication !== publication ||
          keyboard.phase.read(proof.event) !==
            keyboard.Event.BUBBLING_PHASE ||
          !nativeKeyboardIsCurrent(
            proof,
            keyboard.Event.BUBBLING_PHASE,
          )
        ) {
          proof.crossed = true;
          invalidKeyboardEvents.add(nativeEvent);
          keyboardProofs.delete(nativeEvent);
          return;
        }
        const eventView = keyboard.view.read(proof.event);
        if (!eventView) {
          proof.crossed = true;
          invalidKeyboardEvents.add(nativeEvent);
          keyboardProofs.delete(nativeEvent);
          return;
        }
        const bubble = captureSuggestionReactKeyProof(
          keyboard,
          event,
          proof.event,
          proof.movement.source.element,
          publication.elements.root,
          keyboard.Event.BUBBLING_PHASE,
          proof.key,
          proof.code,
          proof.location,
          eventView,
        );
        if (!bubble) {
          proof.crossed = true;
          invalidKeyboardEvents.add(nativeEvent);
          keyboardProofs.delete(nativeEvent);
          return;
        }
        proof.bubble = bubble;
        if (
          proof.capture.event === bubble.event ||
          proof.capture.currentTarget !== publication.elements.root ||
          bubble.currentTarget !== proof.capture.currentTarget ||
          proof.capture.phase !== keyboard.Event.CAPTURING_PHASE ||
          bubble.phase !== keyboard.Event.BUBBLING_PHASE ||
          !suggestionReactKeyProofIsCurrent(keyboard, proof.capture) ||
          !suggestionReactKeyProofIsCurrent(keyboard, bubble) ||
          !nativeKeyboardIsCurrent(
            proof,
            keyboard.Event.BUBBLING_PHASE,
          ) ||
          keyboardProofs.get(nativeEvent) !== proof
        ) {
          proof.crossed = true;
          invalidKeyboardEvents.add(nativeEvent);
          keyboardProofs.delete(nativeEvent);
          return;
        }
        cells.evaluatingPublications.add(publication);
        let claimed = false;
        try {
          claimed =
            nativeKeyboardIsCurrent(
              proof,
              keyboard.Event.BUBBLING_PHASE,
            ) &&
            suggestionReactKeyProofIsCurrent(keyboard, proof.capture) &&
            suggestionReactKeyProofIsCurrent(keyboard, bubble) &&
            keyboardProofs.get(nativeEvent) === proof &&
            claimKeyboard(proof);
        } finally {
          cells.evaluatingPublications.delete(publication);
        }
        keyboardProofs.delete(nativeEvent);
        if (!claimed) return;
        try {
          keyboard.apply(bubble.preventDefault, bubble.event, []);
          if (
            !keyboard.defaultPrevented.read(proof.event) ||
            !suggestionReactKeyProofWasPrevented(keyboard, bubble)
          ) {
            return;
          }
          keyboard.focus.call(proof.movement.destination.element, {
            preventScroll: true,
          });
          requestSuccessor();
        } finally {
          releaseKeyboardClaims(proof);
        }
      } catch {
        proof.crossed = true;
        invalidKeyboardEvents.add(nativeEvent);
        keyboardProofs.delete(nativeEvent);
      }
    };

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
      stageCaptureKey,
      stageBubbleKey,
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
    const identity = Symbol("suggestion-action-publication");
    const control = (
      kind: SuggestionActionKind,
      element: HTMLButtonElement,
      action: SuggestionActionDefinition,
    ): SuggestionActionControlPublication | null => {
      const path = suggestionActionEventPath(element, elements.root.ownerDocument);
      if (!path) return null;
      return Object.freeze({
        identity: Symbol(`suggestion-${kind}-control`),
        publicationIdentity: identity,
        actionIdentity: action.identity,
        kind,
        element,
        path,
        action,
      });
    };
    const acceptControl =
      elements.accept && render.accept
        ? control("accept", elements.accept, render.accept)
        : null;
    const rejectControl =
      elements.reject && render.reject
        ? control("reject", elements.reject, render.reject)
        : null;
    if (
      (authority.canAccept && !acceptControl) ||
      (authority.canReject && !rejectControl)
    ) {
      return undefined;
    }
    const actions = Object.freeze(
      [acceptControl, rejectControl].filter(
        (published): published is SuggestionActionControlPublication =>
          Boolean(
            published &&
              published.action.enabled &&
              suggestionActionControlIsEnabled(published.element),
          ),
      ),
    );
    const publication: SuggestionActionPublication = Object.freeze({
      identity,
      render,
      authority,
      elements,
      acceptControl,
      rejectControl,
      actions,
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

  const onRootKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    const runtime = currentRuntime;
    if (!runtime || runtime.isRetired()) return;
    runtime.stageCaptureKey(event);
  };

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const runtime = currentRuntime;
    if (!runtime || runtime.isRetired()) return;
    runtime.stageBubbleKey(event);
  };

  Object.assign(render, {
    identity,
    authority,
    accept,
    reject,
    captureRoot: rootOwner.capture,
    onRootClickCapture,
    onRootClick,
    onRootKeyDownCapture,
    onRootKeyDown,
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
    claimedControls: new WeakSet<SuggestionActionControlPublication>(),
    claimedReactEvents: new WeakSet<object>(),
    claimedNativeEvents: new WeakSet<Event>(),
    attemptedReactEvents: new WeakSet<object>(),
    attemptedNativeEvents: new WeakSet<Event>(),
    claimedMovements: new WeakSet<SuggestionKeyboardMovement>(),
    claimedWindowProofs: new WeakSet<SuggestionKeyboardWindowProof>(),
    evaluatingPublications: new WeakSet<SuggestionActionPublication>(),
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
    onRootKeyDownCapture,
    onRootKeyDown,
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
    <div
      ref={captureRoot}
      className={presentation.rootClassName}
      onClickCapture={onRootClickCapture}
      onClick={onRootClick}
      onKeyDownCapture={onRootKeyDownCapture}
      onKeyDown={onRootKeyDown}
      data-testid={presentation.rootTestId}
    >
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

type LazyMenuDirection = "first" | "last";

interface LazyMenuItemFacts {
  readonly id: "edit" | "delete";
  readonly label: string;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}

interface LazyMenuOwnerFacts {
  readonly session: CollabSession;
  readonly documentId: string;
  readonly visit: CommentPanelVisit;
  readonly coordinator: CommentRowActionCoordinator;
  readonly thread: CommentThread;
  readonly reply: CommentReply | null;
  readonly targetIdentity: CommentTargetIdentity;
  readonly threadId: string;
  readonly replyId: string | null;
  readonly viewerId: string;
  readonly authorId: string;
  readonly moderator: boolean;
  readonly suggestionState: CommentThread["suggestionState"] | null;
  readonly triggerDisabled: boolean;
  readonly deleteDisabled: boolean;
  readonly items: readonly LazyMenuItemFacts[];
}

interface LazyMenuKeyboardAuthority extends RequestModeKeyboardAuthority {
  readonly eventCurrentTarget: RequestModeCapturedGetter<EventTarget | null>;
  readonly code: RequestModeCapturedGetter<string>;
  readonly addEventListener: LazyMenuWindowMethod<
    Window["addEventListener"]
  >;
  readonly removeEventListener: LazyMenuWindowMethod<
    Window["removeEventListener"]
  >;
  readonly getPrototypeOf: typeof Object.getPrototypeOf;
  readonly apply: typeof Reflect.apply;
}

interface LazyMenuWindowMethod<Method> {
  readonly value: Method;
  readonly isCurrent: () => boolean;
}

interface LazyMenuRenderAuthority {
  readonly mount: symbol;
  readonly owner: LazyMenuOwnerFacts;
  readonly trigger: React.ReactElement<React.ComponentProps<"button">>;
  readonly children: React.ReactNode;
  readonly items: readonly LazyMenuItemBinding[];
  readonly armed: boolean;
  readonly open: boolean;
}

interface LazyMenuItemBinding {
  readonly fact: LazyMenuItemFacts;
  readonly capture: React.RefCallback<HTMLElement>;
  readonly element: () => HTMLElement | null;
  readonly isCurrent: (content: HTMLElement) => boolean;
  readonly release: () => void;
}

interface LazyMenuPreparedItems {
  readonly bindings: readonly LazyMenuItemBinding[];
  readonly children: React.ReactNode;
}

interface LazyMenuPublication {
  readonly identity: symbol;
  readonly authority: LazyMenuRenderAuthority;
  readonly trigger: HTMLButtonElement;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly keyboard: LazyMenuKeyboardAuthority;
  readonly listener: LazyMenuListenerRegistration;
  readonly dom: RequestModeDomSnapshot;
  readonly placement: RequestModePlacement;
  readonly history: RequestModeDomGuard;
  readonly isRetired: () => boolean;
  readonly retire: () => void;
}

interface LazyMenuListenerProof {
  readonly identity: symbol;
  readonly registration: LazyMenuListenerRegistration;
  readonly publication: LazyMenuPublication;
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly terminal: EventTarget;
  readonly path: readonly EventTarget[];
}

interface LazyMenuListenerRegistration {
  readonly identity: symbol;
  readonly listener: EventListener;
  readonly activate: (publication: LazyMenuPublication) => boolean;
  readonly proofFor: (
    nativeEvent: globalThis.KeyboardEvent,
    publication: LazyMenuPublication,
  ) => LazyMenuListenerProof | null;
  readonly claim: (
    proof: LazyMenuListenerProof,
    publication: LazyMenuPublication,
  ) => boolean;
  readonly retains: (
    proof: LazyMenuListenerProof,
    publication: LazyMenuPublication,
  ) => boolean;
  readonly release: (publication: LazyMenuPublication) => void;
}

interface LazyMenuPendingOpen {
  readonly publication: LazyMenuPublication;
  readonly direction: LazyMenuDirection;
  readonly action: object;
  readonly destination: LazyMenuItemBinding;
  readonly capture: LazyMenuReactKey;
  readonly bubble: LazyMenuReactKey;
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly listener: LazyMenuListenerProof;
}

interface LazyMenuReactKey {
  readonly event: object;
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly listener: LazyMenuListenerProof;
  readonly direction: LazyMenuDirection;
  readonly dispatchTarget: EventTarget;
  readonly prototype: object | null;
  readonly phase: number;
  readonly target: EventTarget;
  readonly path: readonly EventTarget[];
  readonly key: string;
  readonly code: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly cancelBubble: boolean;
  readonly trusted: boolean;
  readonly view: Window | null;
  readonly repeat: boolean;
  readonly composing: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

class LazyMenuCell<Value> {
  constructor(private value: Value) {}

  read() {
    return this.value;
  }

  write(value: Value) {
    this.value = value;
  }
}

interface LazyMenuCells {
  readonly active: LazyMenuCell<LazyMenuPublication | null>;
  readonly openHistory: LazyMenuCell<RequestModeDomGuard | null>;
  readonly claimedPublications: WeakSet<LazyMenuPublication>;
  readonly claimedDirections: WeakSet<object>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
  readonly claimedListenerProofs: WeakSet<LazyMenuListenerProof>;
  readonly claimedDestinations: WeakSet<LazyMenuItemBinding>;
}

const claimedLazyMenuReactEvents = new WeakSet<object>();
const claimedLazyMenuNativeEvents = new WeakSet<Event>();
const claimedLazyMenuListenerProofs = new WeakSet<LazyMenuListenerProof>();
const claimedLazyMenuDestinations = new WeakSet<LazyMenuItemBinding>();

function createLazyMenuCells(): LazyMenuCells {
  return {
    active: new LazyMenuCell(null),
    openHistory: new LazyMenuCell(null),
    claimedPublications: new WeakSet(),
    claimedDirections: new WeakSet(),
    claimedReactEvents: new WeakSet(),
    claimedNativeEvents: new WeakSet(),
    claimedListenerProofs: new WeakSet(),
    claimedDestinations: new WeakSet(),
  };
}

function lazyMenuItemsMatch(
  previous: readonly LazyMenuItemFacts[],
  current: readonly LazyMenuItemFacts[],
) {
  return (
    previous.length === current.length &&
    previous.every((item, index) => {
      const next = current[index];
      return Boolean(
        next &&
          item === next &&
          item.id === next.id &&
          item.label === next.label &&
          item.disabled === next.disabled &&
          item.onSelect === next.onSelect,
      );
    })
  );
}

function lazyMenuOwnersMatch(previous: LazyMenuOwnerFacts, current: LazyMenuOwnerFacts) {
  return (
    previous === current &&
    previous.session === current.session &&
    previous.documentId === current.documentId &&
    previous.visit === current.visit &&
    previous.coordinator === current.coordinator &&
    previous.thread === current.thread &&
    previous.reply === current.reply &&
    previous.targetIdentity.thread === current.targetIdentity.thread &&
    previous.targetIdentity.reply === current.targetIdentity.reply &&
    previous.threadId === current.threadId &&
    previous.replyId === current.replyId &&
    previous.viewerId === current.viewerId &&
    previous.authorId === current.authorId &&
    previous.moderator === current.moderator &&
    previous.suggestionState === current.suggestionState &&
    previous.triggerDisabled === current.triggerDisabled &&
    previous.deleteDisabled === current.deleteDisabled &&
    lazyMenuItemsMatch(previous.items, current.items)
  );
}

function lazyMenuChildrenMatch(
  children: React.ReactNode,
  items: readonly LazyMenuItemFacts[],
) {
  const elements = Children.toArray(children);
  if (elements.length !== items.length) return false;
  return elements.every((child, index) => {
    if (!isValidElement(child)) return false;
    const item = items[index];
    const props = child.props as {
      children?: React.ReactNode;
      disabled?: boolean;
      onSelect?: () => void;
    };
    return Boolean(
      item &&
        props.children === item.label &&
        Boolean(props.disabled) === item.disabled &&
        props.onSelect === item.onSelect,
    );
  });
}

function createLazyMenuItemBinding(fact: LazyMenuItemFacts): LazyMenuItemBinding {
  let element: HTMLElement | null = null;
  let current = false;
  let invalid = false;
  let dom: RequestModeDomSnapshot | null = null;
  let placement: RequestModePlacement | null = null;
  let history: RequestModeDomGuard | null = null;
  const capture: React.RefCallback<HTMLElement> = (next) => {
    if (next === null) {
      if (element) current = false;
      return;
    }
    if (element && element !== next) {
      invalid = true;
      current = false;
      return;
    }
    if (element === next) {
      current = true;
      return;
    }
    element = next;
    current = true;
    placement = captureRequestModePlacement(next);
    dom = placement ? snapshotRequestModeDom(next) : null;
    history = placement ? createRequestModeDomGuard(next, placement) : null;
    if (!placement || !dom || !history) invalid = true;
  };
  return Object.freeze({
    fact,
    capture,
    element: () => (current && !invalid ? element : null),
    isCurrent: (content: HTMLElement) =>
      Boolean(
        current &&
          !invalid &&
          element &&
          dom &&
          placement &&
          history &&
          history.isClean() &&
          element.isConnected &&
          element.ownerDocument === content.ownerDocument &&
          element.parentElement === content &&
          requestModePlacementMatches(element, placement) &&
          requestModeDomMatches(dom) &&
          element.getAttribute("role") === "menuitem" &&
          element.textContent === fact.label &&
          element.getAttribute("aria-disabled") ===
            (fact.disabled ? "true" : null) &&
          element.hasAttribute("data-disabled") === fact.disabled &&
          history.isClean() &&
          requestModePlacementMatches(element, placement) &&
          requestModeDomMatches(dom),
      ),
    release: () => {
      history?.release();
      history = null;
    },
  });
}

function prepareLazyMenuItems(
  children: React.ReactNode,
  facts: readonly LazyMenuItemFacts[],
): LazyMenuPreparedItems | null {
  const elements = Children.toArray(children);
  if (elements.length !== facts.length) return null;
  const bindings: LazyMenuItemBinding[] = [];
  const rendered: React.ReactElement[] = [];
  for (const [index, child] of elements.entries()) {
    const fact = facts[index];
    if (!fact || !isValidElement(child)) return null;
    const binding = createLazyMenuItemBinding(fact);
    const item = child as React.ReactElement<{
      ref?: React.Ref<HTMLElement>;
    }>;
    bindings.push(binding);
    rendered.push(
      cloneElement(item, {
        ref: composeRefs(item.props.ref, binding.capture),
      }),
    );
  }
  return Object.freeze({
    bindings: Object.freeze(bindings),
    children: rendered,
  });
}

function currentLazyMenuBusyFacts(owner: LazyMenuOwnerFacts) {
  const { coordinator, threadId, replyId } = owner;
  const key = commentTargetKey(threadId, replyId);
  const ownBusy = coordinator.owners.has(key) || coordinator.batchTargets.has(key);
  if (replyId !== null) {
    const rootDeleting =
      coordinator.owners.get(commentTargetKey(threadId, null))?.action.type ===
      "delete";
    const blocked = ownBusy || rootDeleting;
    return { triggerDisabled: blocked, deleteDisabled: blocked };
  }
  const hasPendingReply =
    [...coordinator.owners.values()].some(
      (action) => action.threadId === threadId && action.replyId !== null,
    ) ||
    [...coordinator.batchOwners.values()].some((action) =>
      action.targets.some(
        (target) =>
          target.kind !== "local-suggestion" &&
          target.threadId === threadId &&
          target.replyId !== null,
      ),
    );
  return {
    triggerDisabled: ownBusy,
    deleteDisabled: ownBusy || hasPendingReply,
  };
}

function lazyMenuOwnerFactsAreCurrent(
  owner: LazyMenuOwnerFacts,
  requirePublishedTarget = true,
) {
  const {
    coordinator,
    session,
    threadId,
    replyId,
    targetIdentity,
  } = owner;
  const currentThread = session.comments
    .list()
    .find((candidate) => candidate.id === threadId);
  const currentReply =
    replyId === null
      ? null
      : currentThread?.replies.find((candidate) => candidate.id === replyId) ??
        null;
  const currentIdentity = storedCommentTargetIdentity(
    session,
    threadId,
    replyId,
  );
  const authorId = currentReply?.authorId ?? currentThread?.authorId;
  const suggestionState =
    currentReply?.suggestionState ?? currentThread?.suggestionState ?? null;
  const moderator = session.role === "owner";
  const visible = authorId === session.user.id || moderator;
  const canEdit = authorId === session.user.id && !suggestionState;
  const busy = currentLazyMenuBusyFacts(owner);
  const expectedItems = [
    ...(canEdit ? ["edit" as const] : []),
    "delete" as const,
  ];
  return (
    (!requirePublishedTarget || coordinator.mounted) &&
    coordinator.session === session &&
    coordinator.documentId === owner.documentId &&
    coordinator.visit === owner.visit &&
    (!requirePublishedTarget ||
      coordinator.targets.has(commentTargetKey(threadId, replyId))) &&
    session.docId === owner.documentId &&
    session.user.id === owner.viewerId &&
    currentThread !== undefined &&
    (replyId === null || currentReply !== null) &&
    currentIdentity?.thread === targetIdentity.thread &&
    currentIdentity.reply === targetIdentity.reply &&
    authorId === owner.authorId &&
    moderator === owner.moderator &&
    visible &&
    suggestionState === owner.suggestionState &&
    busy.triggerDisabled === owner.triggerDisabled &&
    busy.deleteDisabled === owner.deleteDisabled &&
    owner.items.length === expectedItems.length &&
    owner.items.every((item, index) => {
      const id = expectedItems[index];
      return Boolean(
        id &&
          item.id === id &&
          item.label ===
            (id === "edit"
              ? "Edit"
              : replyId === null
                ? "Delete thread"
                : "Delete") &&
          item.disabled ===
            (id === "edit"
              ? busy.triggerDisabled
              : busy.deleteDisabled),
      );
    })
  );
}

function captureLazyMenuKeyboardAuthority(
  ownerDocument: Document,
  ownerWindow: Window & typeof globalThis,
): LazyMenuKeyboardAuthority | null {
  const base = captureRequestModeKeyboardAuthority(ownerDocument, ownerWindow);
  if (!base) return null;
  const EventTargetConstructor = ownerWindow.EventTarget;
  const eventCurrentTarget = captureRequestModeGetter<EventTarget | null>(
    ownerWindow,
    ownerWindow.Event.prototype,
    "currentTarget",
  );
  const code = captureRequestModeGetter<string>(
    ownerWindow,
    ownerWindow.KeyboardEvent.prototype,
    "code",
  );
  const addEventListener = captureLazyMenuWindowMethod(
    ownerWindow,
    "addEventListener",
  );
  const removeEventListener = captureLazyMenuWindowMethod(
    ownerWindow,
    "removeEventListener",
  );
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const isCurrent = () =>
    base.isCurrent() &&
    ownerWindow.EventTarget === EventTargetConstructor &&
    ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
    ownerWindow.Reflect.apply === apply &&
    Boolean(eventCurrentTarget?.isCurrent()) &&
    Boolean(code?.isCurrent()) &&
    Boolean(addEventListener?.isCurrent()) &&
    Boolean(removeEventListener?.isCurrent());
  if (
    !eventCurrentTarget ||
    !code ||
    !addEventListener ||
    !removeEventListener ||
    !isCurrent()
  ) {
    return null;
  }
  return Object.freeze({
    ...base,
    eventCurrentTarget,
    code,
    addEventListener,
    removeEventListener,
    getPrototypeOf,
    apply,
    isCurrent,
  });
}

function captureLazyMenuWindowMethod<
  Property extends "addEventListener" | "removeEventListener",
>(
  ownerWindow: Window & typeof globalThis,
  property: Property,
): LazyMenuWindowMethod<Window[Property]> | null {
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
  const value = reflectGet(ownerWindow, property, ownerWindow) as Window[Property];
  if (!found || typeof value !== "function") return null;
  const isCurrent = () =>
    ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
    ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
    ownerWindow.Reflect.get === reflectGet &&
    path.every(
      ({ target: entry, descriptor, prototype }) =>
        getPrototypeOf(entry) === prototype &&
        (descriptor
          ? requestModeDescriptorMatches(
              getOwnPropertyDescriptor(entry, property),
              descriptor,
            )
          : getOwnPropertyDescriptor(entry, property) === undefined),
    ) &&
    reflectGet(ownerWindow, property, ownerWindow) === value;
  if (!isCurrent()) return null;
  return Object.freeze({ value, isCurrent });
}

function lazyMenuPathMatchesTerminal(
  path: readonly EventTarget[],
  publication: LazyMenuPublication,
  terminal: EventTarget,
) {
  const { ownerDocument, placement } = publication;
  return (
    path.length === placement.chain.length + 2 &&
    placement.chain.every(({ node }, index) => path[index] === node) &&
    path.at(-2) === ownerDocument &&
    path.at(-1) === terminal
  );
}

function createLazyMenuListenerRegistration(
  ownerWindow: Window & typeof globalThis,
  keyboard: LazyMenuKeyboardAuthority,
): LazyMenuListenerRegistration {
  const identity = Symbol("lazy-menu-listener");
  const proofs = new WeakMap<globalThis.KeyboardEvent, LazyMenuListenerProof>();
  const invalidEvents = new WeakSet<Event>();
  let publication: LazyMenuPublication | null = null;
  let claimed: LazyMenuListenerProof | null = null;
  let active = false;
  let released = false;

  const listener: EventListener = function (this: EventTarget, event: Event) {
    const current = publication;
    if (
      !current ||
      !active ||
      released ||
      current.listener !== registration ||
      current.isRetired() ||
      !(event instanceof keyboard.KeyboardEvent) ||
      keyboard.getPrototypeOf(event) !== keyboard.KeyboardEvent.prototype ||
      invalidEvents.has(event) ||
      !keyboard.isCurrent()
    ) {
      return;
    }
    if (proofs.has(event)) {
      invalidEvents.add(event);
      return;
    }
    try {
      const currentTarget = keyboard.eventCurrentTarget.read(event);
      const path = keyboard.eventPath.invoke(event);
      const terminal = path.at(-1);
      if (
        currentTarget !== this ||
        terminal !== this ||
        keyboard.eventPhase.read(event) !== keyboard.Event.CAPTURING_PHASE ||
        !lazyMenuPathMatchesTerminal(path, current, this)
      ) {
        return;
      }
      proofs.set(
        event,
        Object.freeze({
          identity: Symbol("lazy-menu-listener-proof"),
          registration,
          publication: current,
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

  const proofFor = (
    nativeEvent: globalThis.KeyboardEvent,
    current: LazyMenuPublication,
  ) => {
    const proof = proofs.get(nativeEvent);
    if (
      !proof ||
      !active ||
      released ||
      publication !== current ||
      current.listener !== registration ||
      current.isRetired() ||
      proof.registration !== registration ||
      proof.publication !== current ||
      proof.nativeEvent !== nativeEvent ||
      proof.receiver !== proof.currentTarget ||
      proof.receiver !== proof.terminal ||
      invalidEvents.has(nativeEvent) ||
      !keyboard.isCurrent()
    ) {
      return null;
    }
    try {
      const path = keyboard.eventPath.invoke(nativeEvent);
      return path.length === proof.path.length &&
        path.every((entry, index) => entry === proof.path[index]) &&
        lazyMenuPathMatchesTerminal(path, current, proof.receiver)
        ? proof
        : null;
    } catch {
      invalidEvents.add(nativeEvent);
      return null;
    }
  };

  const registration: LazyMenuListenerRegistration = Object.freeze({
    identity,
    listener,
    activate: (current: LazyMenuPublication) => {
      if (
        publication ||
        active ||
        released ||
        current.listener !== registration ||
        current.ownerWindow !== ownerWindow ||
        current.keyboard !== keyboard ||
        !keyboard.isCurrent()
      ) {
        return false;
      }
      publication = current;
      active = true;
      try {
        ownerWindow.addEventListener("keydown", listener, true);
        return (
          ownerWindow.addEventListener === keyboard.addEventListener.value &&
          keyboard.addEventListener.isCurrent()
        );
      } catch {
        active = false;
        publication = null;
        return false;
      }
    },
    proofFor,
    claim: (proof: LazyMenuListenerProof, current: LazyMenuPublication) => {
      if (claimed || proofFor(proof.nativeEvent, current) !== proof) return false;
      claimed = proof;
      return true;
    },
    retains: (proof: LazyMenuListenerProof, current: LazyMenuPublication) =>
      publication === current &&
      current.listener === registration &&
      claimed === proof &&
      proofs.get(proof.nativeEvent) === proof &&
      proof.registration === registration &&
      proof.publication === current &&
      proof.receiver === proof.currentTarget &&
      proof.receiver === proof.terminal &&
      !invalidEvents.has(proof.nativeEvent) &&
      (active !== released) &&
      keyboard.isCurrent(),
    release: (current: LazyMenuPublication) => {
      if (publication !== current || released) return;
      released = true;
      active = false;
      ownerWindow.removeEventListener("keydown", listener, true);
    },
  });
  return registration;
}

function lazyMenuEventPathMatches(
  path: readonly EventTarget[],
  publication: LazyMenuPublication,
  proof: LazyMenuListenerProof,
) {
  return (
    (publication.listener.proofFor(proof.nativeEvent, publication) === proof ||
      publication.listener.retains(proof, publication)) &&
    path.length === proof.path.length &&
    path.every((entry, index) => entry === proof.path[index]) &&
    lazyMenuPathMatchesTerminal(path, publication, proof.receiver)
  );
}

function exactLazyMenuKey(
  event: KeyboardEvent<HTMLButtonElement>,
  publication: LazyMenuPublication,
  expectedPhase: number,
  expectedDispatchTarget: EventTarget | null,
): LazyMenuReactKey | null {
  const keyboard = publication.keyboard;
  if (!event || typeof event !== "object" || !keyboard.isCurrent()) return null;
  const nativeEvent = event.nativeEvent;
  if (
    !(nativeEvent instanceof keyboard.KeyboardEvent) ||
    keyboard.getPrototypeOf(nativeEvent) !== keyboard.KeyboardEvent.prototype ||
    !keyboard.trusted.matches(nativeEvent)
  ) {
    return null;
  }
  const reactEventIdentity: object = event;
  const nativeEventIdentity: object = nativeEvent;
  const listener = publication.listener.proofFor(nativeEvent, publication);
  if (!listener) return null;
  try {
    const key = keyboard.key.read(nativeEvent);
    const code = keyboard.code.read(nativeEvent);
    const direction =
      key === "ArrowDown" && code === "ArrowDown"
        ? "first"
        : key === "ArrowUp" && code === "ArrowUp"
          ? "last"
          : null;
    if (!direction) return null;
    const target = keyboard.eventTarget.read(nativeEvent);
    const nativeCurrentTarget =
      keyboard.eventCurrentTarget.read(nativeEvent);
    const phase = keyboard.eventPhase.read(nativeEvent);
    const path = keyboard.eventPath.invoke(nativeEvent);
    const bubbles = keyboard.eventBubbles.read(nativeEvent);
    const cancelable = keyboard.eventCancelable.read(nativeEvent);
    const defaultPrevented =
      keyboard.eventDefaultPrevented.read(nativeEvent);
    const cancelBubble = keyboard.eventCancelBubble.read(nativeEvent);
    const view = keyboard.eventView.read(nativeEvent);
    const repeat = keyboard.repeat.read(nativeEvent);
    const composing = keyboard.composing.read(nativeEvent);
    const altKey = keyboard.altKey.read(nativeEvent);
    const ctrlKey = keyboard.ctrlKey.read(nativeEvent);
    const metaKey = keyboard.metaKey.read(nativeEvent);
    const shiftKey = keyboard.shiftKey.read(nativeEvent);
    const trusted = keyboard.trusted.read(nativeEvent);
    const reactEvent = event as KeyboardEvent<HTMLButtonElement> & {
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
      persist?: unknown;
    };
    return (
      keyboard.eventType.read(nativeEvent) === "keydown" &&
      phase === expectedPhase &&
      bubbles &&
      cancelable &&
      !defaultPrevented &&
      !cancelBubble &&
      trusted &&
      (view === null || view === publication.ownerWindow) &&
      !repeat &&
      !composing &&
      !altKey &&
      !ctrlKey &&
      !metaKey &&
      !shiftKey &&
      target === publication.trigger &&
      lazyMenuEventPathMatches(path, publication, listener) &&
      nativeCurrentTarget !== null &&
      (nativeCurrentTarget === publication.ownerDocument ||
        nativeCurrentTarget instanceof keyboard.Node) &&
      path.includes(nativeCurrentTarget) &&
      path.filter((entry) => entry === nativeCurrentTarget).length === 1 &&
      (expectedDispatchTarget === null ||
        nativeCurrentTarget === expectedDispatchTarget) &&
      publication.trigger.ownerDocument === publication.ownerDocument &&
      keyboard.activeElement.read(publication.ownerDocument) ===
        publication.trigger &&
      reactEventIdentity !== nativeEventIdentity &&
      event.type === "keydown" &&
      event.currentTarget === publication.trigger &&
      event.target === target &&
      event.nativeEvent === nativeEvent &&
      event.key === key &&
      event.code === code &&
      event.eventPhase === phase &&
      event.repeat === repeat &&
      event.altKey === altKey &&
      event.ctrlKey === ctrlKey &&
      event.metaKey === metaKey &&
      event.shiftKey === shiftKey &&
      event.bubbles === bubbles &&
      event.cancelable === cancelable &&
      event.defaultPrevented === defaultPrevented &&
      event.isTrusted === trusted &&
      Object.is(event.view, view) &&
      typeof reactEvent.isDefaultPrevented === "function" &&
      reactEvent.isDefaultPrevented() === defaultPrevented &&
      typeof reactEvent.isPropagationStopped === "function" &&
      reactEvent.isPropagationStopped() === cancelBubble &&
      typeof reactEvent.persist === "function"
    )
      ? Object.freeze({
          event,
          direction,
          nativeEvent,
          listener,
          dispatchTarget: nativeCurrentTarget,
          prototype: keyboard.getPrototypeOf(event),
          phase,
          target,
          path: Object.freeze([...path]),
          key,
          code,
          bubbles,
          cancelable,
          defaultPrevented,
          cancelBubble,
          trusted,
          view,
          repeat,
          composing,
          altKey,
          ctrlKey,
          metaKey,
          shiftKey,
        })
      : null;
  } catch {
    return null;
  }
}

function lazyMenuReactPairMatches(
  capture: LazyMenuReactKey,
  bubble: LazyMenuReactKey,
  publication: LazyMenuPublication,
) {
  const keyboard = publication.keyboard;
  return (
    capture.event !== bubble.event &&
    capture.nativeEvent === bubble.nativeEvent &&
    capture.listener === bubble.listener &&
    capture.listener.nativeEvent === capture.nativeEvent &&
    capture.listener.publication === publication &&
    capture.listener.registration === publication.listener &&
    capture.direction === bubble.direction &&
    capture.prototype === bubble.prototype &&
    capture.phase === keyboard.Event.CAPTURING_PHASE &&
    bubble.phase === keyboard.Event.BUBBLING_PHASE &&
    capture.dispatchTarget === bubble.dispatchTarget &&
    capture.target === publication.trigger &&
    bubble.target === publication.trigger &&
    lazyMenuEventPathMatches(capture.path, publication, capture.listener) &&
    lazyMenuEventPathMatches(bubble.path, publication, bubble.listener) &&
    capture.path.every((entry, index) => entry === bubble.path[index]) &&
    capture.key === bubble.key &&
    capture.code === bubble.code &&
    capture.bubbles === bubble.bubbles &&
    capture.cancelable === bubble.cancelable &&
    capture.defaultPrevented === bubble.defaultPrevented &&
    capture.cancelBubble === bubble.cancelBubble &&
    capture.trusted === bubble.trusted &&
    capture.view === bubble.view &&
    capture.repeat === bubble.repeat &&
    capture.composing === bubble.composing &&
    capture.altKey === bubble.altKey &&
    capture.ctrlKey === bubble.ctrlKey &&
    capture.metaKey === bubble.metaKey &&
    capture.shiftKey === bubble.shiftKey
  );
}

function lazyMenuTriggerMatches(
  publication: LazyMenuPublication,
  content: Element | null,
) {
  const { authority, trigger } = publication;
  const expected = authority.trigger.props;
  return (
    !publication.isRetired() &&
    publication.history.isClean() &&
    requestModePlacementMatches(trigger, publication.placement) &&
    requestModeDomMatches(publication.dom) &&
    lazyMenuOwnerFactsAreCurrent(authority.owner) &&
    lazyMenuChildrenMatch(authority.children, authority.owner.items) &&
    trigger.isConnected &&
    trigger.tagName === "BUTTON" &&
    trigger.type === (expected.type ?? "submit") &&
    trigger.className === (expected.className ?? "") &&
    trigger.getAttribute("aria-label") === expected["aria-label"] &&
    trigger.disabled === Boolean(expected.disabled) &&
    trigger.disabled === authority.owner.triggerDisabled &&
    trigger.getAttribute("aria-busy") ===
      (expected["aria-busy"] ? "true" : null) &&
    trigger.getAttribute("aria-haspopup") === "menu" &&
    trigger.getAttribute("aria-expanded") === "false" &&
    trigger.getAttribute("aria-controls") === null &&
    content === null
  );
}

function currentLazyMenuItems(
  content: HTMLElement,
  bindings: readonly LazyMenuItemBinding[],
  facts: readonly LazyMenuItemFacts[],
) {
  if (
    content.children.length !== bindings.length ||
    bindings.length !== facts.length
  ) {
    return null;
  }
  const elements: HTMLElement[] = [];
  for (const [index, binding] of bindings.entries()) {
    const element = binding.element();
    if (
      !element ||
      binding.fact !== facts[index] ||
      content.children.item(index) !== element ||
      !binding.isCurrent(content) ||
      elements.includes(element)
    ) {
      return null;
    }
    elements.push(element);
  }
  return Object.freeze(elements);
}

function useLazyTrigger() {
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  const plainProps = useMemo(
    () => ({
      "aria-haspopup": "menu" as const,
      "aria-expanded": false,
      onPointerEnter: () => setArmed(true),
      onPointerDown: (event: React.PointerEvent) => {
        if (event.button !== 0 || event.ctrlKey) return;
        setArmed(true);
        setOpen(true);
      },
      onKeyDown: (event: React.KeyboardEvent) => {
        if (
          event.key !== "Enter" &&
          event.key !== " " &&
          event.key !== "ArrowDown"
        ) {
          return;
        }
        event.preventDefault();
        setArmed(true);
        setOpen(true);
      },
    }),
    [],
  );
  return { armed, open, setOpen, plainProps };
}

// DropdownMenu forwards this Menu primitive callback at runtime but omits the private prop from its public type.
const DirectionalMenuContent = MenuContent as React.ComponentType<
  React.ComponentProps<typeof MenuContent> & {
    onOpenAutoFocus?: (event: Event) => void;
  }
>;

/**
 * Mounts a Radix DropdownMenu root only once the user reaches for its trigger. A root is ~20 fibers even
 * while closed, and comments can contain hundreds of action disclosures. The closed plain trigger keeps
 * an immutable owner-realm publication so ArrowDown and ArrowUp can safely hand the exact interaction to
 * the newly mounted menu and focus its first or last enabled item without a document-global listener.
 */
function LazyMenu({
  trigger,
  children,
  owner,
  ...content
}: {
  trigger: React.ReactElement<React.ComponentProps<"button">>;
  children: React.ReactNode;
  owner: LazyMenuOwnerFacts;
} & Omit<React.ComponentProps<typeof MenuContent>, "children">) {
  const [mount] = useState(() => Symbol("lazy-comment-menu"));
  const [cells] = useState(createLazyMenuCells);
  const [armed, setArmed] = useState(false);
  const [open, setOpenState] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pendingCapture = useRef<LazyMenuReactKey | null>(null);
  const pendingOpen = useRef<LazyMenuPendingOpen | null>(null);
  const preparedItems = useMemo(
    () => prepareLazyMenuItems(children, owner.items),
    [children, owner.items],
  );
  const authority = useMemo(
    () =>
      Object.freeze({
        mount,
        owner,
        trigger,
        children,
        items: preparedItems?.bindings ?? Object.freeze([]),
        armed,
        open,
      } satisfies LazyMenuRenderAuthority),
    [armed, children, mount, open, owner, preparedItems, trigger],
  );
  const directionActions = useMemo(
    () =>
      Object.freeze({
        first: Object.freeze({
          identity: Symbol("lazy-menu-first"),
          authority,
        }),
        last: Object.freeze({
          identity: Symbol("lazy-menu-last"),
          authority,
        }),
      }),
    [authority],
  );

  const setOpen = useCallback((next: boolean) => {
    if (!next) {
      pendingCapture.current = null;
      pendingOpen.current = null;
      cells.openHistory.read()?.release();
      cells.openHistory.write(null);
    }
    setOpenState(next);
  }, [cells]);

  const finishDirectionalOpen = useCallback(
    (event: Event) => {
      const pending = pendingOpen.current;
      const nextTrigger = triggerRef.current;
      const menu = contentRef.current;
      if (!pending) return;
      if (!nextTrigger || !menu) {
        pendingOpen.current = null;
        setOpenState(false);
        return;
      }
      const { publication, destination } = pending;
      const { keyboard, ownerDocument } = publication;
      const menuPlacement = captureRequestModePlacement(menu);
      const menuHistory = menuPlacement
        ? createRequestModeDomGuard(menu, menuPlacement)
        : null;
      const menuDom = menuPlacement ? snapshotRequestModeDom(menu) : null;
      const ownerCurrent = lazyMenuOwnerFactsAreCurrent(
        publication.authority.owner,
      );
      const items = currentLazyMenuItems(
        menu,
        publication.authority.items,
        publication.authority.owner.items,
      );
      const bubbleEvent =
        pending.bubble.event as KeyboardEvent<HTMLButtonElement>;
      const destinationIndex = publication.authority.items.indexOf(destination);
      const target =
        destinationIndex < 0 ? null : items?.[destinationIndex] ?? null;
      const controls = nextTrigger.getAttribute("aria-controls");
      const labelledBy = menu.getAttribute("aria-labelledby");
      if (
        !cells.claimedPublications.has(publication) ||
        !cells.claimedDirections.has(pending.action) ||
        !cells.claimedReactEvents.has(pending.capture.event) ||
        !cells.claimedReactEvents.has(pending.bubble.event) ||
        !cells.claimedNativeEvents.has(pending.nativeEvent) ||
        !cells.claimedListenerProofs.has(pending.listener) ||
        !cells.claimedDestinations.has(destination) ||
        !claimedLazyMenuReactEvents.has(pending.capture.event) ||
        !claimedLazyMenuReactEvents.has(pending.bubble.event) ||
        !claimedLazyMenuNativeEvents.has(pending.nativeEvent) ||
        !claimedLazyMenuListenerProofs.has(pending.listener) ||
        !claimedLazyMenuDestinations.has(destination) ||
        !keyboard.isCurrent() ||
        !ownerCurrent ||
        pending.capture.nativeEvent !== pending.nativeEvent ||
        pending.bubble.nativeEvent !== pending.nativeEvent ||
        pending.capture.listener !== pending.listener ||
        pending.bubble.listener !== pending.listener ||
        !publication.listener.retains(pending.listener, publication) ||
        pending.capture.direction !== pending.direction ||
        pending.bubble.direction !== pending.direction ||
        !lazyMenuReactPairMatches(
          pending.capture,
          pending.bubble,
          publication,
        ) ||
        !items ||
        !target ||
        destination.fact !== publication.authority.owner.items[destinationIndex] ||
        destination.fact.disabled ||
        target.getAttribute("aria-disabled") === "true" ||
        nextTrigger.ownerDocument !== ownerDocument ||
        menu.ownerDocument !== ownerDocument ||
        nextTrigger.getAttribute("aria-expanded") !== "true" ||
        nextTrigger.getAttribute("data-state") !== "open" ||
        !controls ||
        menu.id !== controls ||
        labelledBy !== nextTrigger.id ||
        menu.getAttribute("role") !== "menu" ||
        !menuPlacement ||
        !menuHistory ||
        !menuDom ||
        !menuHistory.isClean() ||
        !requestModePlacementMatches(menu, menuPlacement) ||
        !requestModeDomMatches(menuDom)
      ) {
        menuHistory?.release();
        pendingOpen.current = null;
        setOpenState(false);
        return;
      }
      event.preventDefault();
      if (!event.defaultPrevented) {
        menuHistory.release();
        pendingOpen.current = null;
        setOpenState(false);
        return;
      }
      if (!publication.listener.retains(pending.listener, publication)) {
        menuHistory.release();
        pendingOpen.current = null;
        setOpenState(false);
        return;
      }
      bubbleEvent.preventDefault();
      if (
        !bubbleEvent.defaultPrevented ||
        !keyboard.eventDefaultPrevented.read(pending.nativeEvent) ||
        !publication.listener.retains(pending.listener, publication) ||
        pendingOpen.current !== pending ||
        triggerRef.current !== nextTrigger ||
        contentRef.current !== menu ||
        !keyboard.isCurrent() ||
        !lazyMenuOwnerFactsAreCurrent(publication.authority.owner) ||
        !menuHistory.isClean() ||
        !requestModePlacementMatches(menu, menuPlacement) ||
        !requestModeDomMatches(menuDom)
      ) {
        menuHistory.release();
        pendingOpen.current = null;
        setOpenState(false);
        return;
      }
      pendingOpen.current = null;
      cells.openHistory.read()?.release();
      cells.openHistory.write(menuHistory);
      keyboard.focus.invoke(target, { preventScroll: true });
      const focused =
        keyboard.activeElement.read(ownerDocument) === target &&
        keyboard.isCurrent() &&
        publication.listener.retains(pending.listener, publication) &&
        lazyMenuOwnerFactsAreCurrent(publication.authority.owner) &&
        menuHistory.isClean() &&
        requestModePlacementMatches(menu, menuPlacement) &&
        requestModeDomMatches(menuDom);
      if (!focused) {
        menuHistory.release();
        cells.openHistory.write(null);
        setOpenState(false);
      }
    },
    [cells],
  );

  const onDirectionalKeyDown = useMemo(() => {
    const directions = directionActions;
    return (event: KeyboardEvent<HTMLButtonElement>) => {
      const publication = cells.active.read();
      if (publication && !publication.keyboard.isCurrent()) {
        publication.retire();
        return;
      }
      if (
        publication &&
        publication.authority === authority &&
        (!publication.history.isClean() ||
          !requestModePlacementMatches(
            publication.trigger,
            publication.placement,
          ) ||
          !requestModeDomMatches(publication.dom) ||
          !lazyMenuOwnerFactsAreCurrent(publication.authority.owner))
      ) {
        publication.retire();
        return;
      }
      if (
        !publication ||
        publication.authority !== authority ||
        publication.authority.mount !== mount ||
        publication.authority.armed !== armed ||
        publication.authority.open ||
        !lazyMenuOwnersMatch(publication.authority.owner, owner) ||
        !lazyMenuTriggerMatches(publication, contentRef.current)
      )
        return;
      const capture = pendingCapture.current;
      const exact = exactLazyMenuKey(
        event,
        publication,
        publication.keyboard.Event.BUBBLING_PHASE,
        capture?.dispatchTarget ?? null,
      );
      if (!exact) return;
      pendingCapture.current = null;
      if (
        !capture ||
        !lazyMenuReactPairMatches(capture, exact, publication)
      ) {
        return;
      }
      const enabled = publication.authority.items.filter(
        (item) => !item.fact.disabled,
      );
      const destination =
        exact.direction === "first"
          ? enabled[0]
          : enabled[enabled.length - 1];
      const direction = directions[exact.direction];
      if (
        !destination ||
        cells.claimedPublications.has(publication) ||
        cells.claimedDirections.has(direction) ||
        cells.claimedReactEvents.has(capture.event) ||
        cells.claimedReactEvents.has(event) ||
        cells.claimedNativeEvents.has(exact.nativeEvent) ||
        cells.claimedListenerProofs.has(exact.listener) ||
        cells.claimedDestinations.has(destination) ||
        claimedLazyMenuReactEvents.has(capture.event) ||
        claimedLazyMenuReactEvents.has(event) ||
        claimedLazyMenuNativeEvents.has(exact.nativeEvent) ||
        claimedLazyMenuListenerProofs.has(exact.listener) ||
        claimedLazyMenuDestinations.has(destination) ||
        cells.active.read() !== publication
      ) {
        return;
      }
      if (!publication.listener.claim(exact.listener, publication)) return;
      cells.claimedPublications.add(publication);
      cells.claimedDirections.add(direction);
      cells.claimedReactEvents.add(capture.event);
      cells.claimedReactEvents.add(event);
      cells.claimedNativeEvents.add(exact.nativeEvent);
      cells.claimedListenerProofs.add(exact.listener);
      cells.claimedDestinations.add(destination);
      claimedLazyMenuReactEvents.add(capture.event);
      claimedLazyMenuReactEvents.add(event);
      claimedLazyMenuNativeEvents.add(exact.nativeEvent);
      claimedLazyMenuListenerProofs.add(exact.listener);
      claimedLazyMenuDestinations.add(destination);
      pendingOpen.current = Object.freeze({
        publication,
        direction: exact.direction,
        action: direction,
        destination,
        capture,
        bubble: exact,
        nativeEvent: exact.nativeEvent,
        listener: exact.listener,
      });
      if (
        cells.active.read() !== publication ||
        publication.authority !== authority ||
        publication.authority.open ||
        !publication.listener.retains(exact.listener, publication) ||
        !publication.keyboard.isCurrent() ||
        !lazyMenuOwnersMatch(publication.authority.owner, owner) ||
        !lazyMenuTriggerMatches(publication, contentRef.current)
      ) {
        pendingOpen.current = null;
        return;
      }
      flushSync(() => {
        setArmed(true);
        setOpenState(true);
      });
    };
  }, [armed, authority, cells, directionActions, mount, owner]);

  const onDirectionalKeyDownCapture = useMemo(
    () => (event: KeyboardEvent<HTMLButtonElement>) => {
      const publication = cells.active.read();
      if (publication && !publication.keyboard.isCurrent()) {
        publication.retire();
        return;
      }
      if (
        publication &&
        publication.authority === authority &&
        (!publication.history.isClean() ||
          !requestModePlacementMatches(
            publication.trigger,
            publication.placement,
          ) ||
          !requestModeDomMatches(publication.dom) ||
          !lazyMenuOwnerFactsAreCurrent(publication.authority.owner))
      ) {
        publication.retire();
        return;
      }
      if (
        !publication ||
        publication.authority !== authority ||
        publication.authority.mount !== mount ||
        publication.authority.armed !== armed ||
        publication.authority.open ||
        !lazyMenuOwnersMatch(publication.authority.owner, owner) ||
        !lazyMenuTriggerMatches(publication, contentRef.current)
      ) {
        return;
      }
      const exact = exactLazyMenuKey(
        event,
        publication,
        publication.keyboard.Event.CAPTURING_PHASE,
        null,
      );
      if (
        !exact ||
        cells.claimedPublications.has(publication) ||
        cells.claimedReactEvents.has(event) ||
        cells.claimedNativeEvents.has(exact.nativeEvent) ||
        cells.claimedListenerProofs.has(exact.listener) ||
        claimedLazyMenuReactEvents.has(event) ||
        claimedLazyMenuNativeEvents.has(exact.nativeEvent) ||
        claimedLazyMenuListenerProofs.has(exact.listener)
      ) {
        return;
      }
      pendingCapture.current = exact;
      queueMicrotask(() => {
        if (pendingCapture.current === exact) pendingCapture.current = null;
      });
    },
    [armed, authority, cells, mount, owner],
  );

  const onPlainKeyDown = useMemo(
    () => (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        onDirectionalKeyDown(event);
        return;
      }
      if (
        armed ||
        (event.key !== "Enter" && event.key !== " ") ||
        owner.triggerDisabled
      ) {
        return;
      }
      event.preventDefault();
      setArmed(true);
      setOpenState(true);
    },
    [armed, onDirectionalKeyDown, owner.triggerDisabled],
  );

  useLayoutEffect(() => {
    const element = triggerRef.current;
    const ownerWindow = element?.ownerDocument.defaultView;
    const placement = element ? captureRequestModePlacement(element) : null;
    const keyboard =
      element && ownerWindow
        ? captureLazyMenuKeyboardAuthority(element.ownerDocument, ownerWindow)
        : null;
    const history =
      element && placement
        ? createRequestModeDomGuard(element, placement)
        : null;
    if (
      !element ||
      !ownerWindow ||
      !placement ||
      !keyboard ||
      !history ||
      open ||
      !lazyMenuOwnerFactsAreCurrent(owner, false) ||
      !lazyMenuChildrenMatch(children, owner.items) ||
      !preparedItems ||
      !preparedItems.bindings.every(
        (binding, index) => binding.fact === owner.items[index],
      )
    ) {
      history?.release();
      return;
    }
    let retired = false;
    const listener = createLazyMenuListenerRegistration(ownerWindow, keyboard);
    const publication: LazyMenuPublication = Object.freeze({
      identity: Symbol("lazy-menu-publication"),
      authority,
      trigger: element,
      ownerDocument: element.ownerDocument,
      ownerWindow,
      keyboard,
      listener,
      dom: snapshotRequestModeDom(element),
      placement,
      history,
      isRetired: () => retired,
      retire: () => {
        if (retired) return;
        retired = true;
        listener.release(publication);
        if (cells.active.read() === publication) cells.active.write(null);
        queueMicrotask(() => {
          history.release();
          publication.authority.items.forEach((item) => item.release());
        });
      },
    });
    cells.active.read()?.retire();
    cells.active.write(publication);
    if (!listener.activate(publication)) {
      publication.retire();
      return;
    }
    return publication.retire;
  }, [authority, cells, children, open, owner, preparedItems]);

  useLayoutEffect(
    () => () => {
      pendingCapture.current = null;
      pendingOpen.current = null;
      cells.openHistory.read()?.release();
      cells.openHistory.write(null);
    },
    [cells],
  );

  const captureTrigger = useCallback((element: HTMLButtonElement | null) => {
    triggerRef.current = element;
  }, []);
  const suppliedTriggerRef = (
    trigger.props as React.ComponentProps<"button"> & {
      ref?: React.Ref<HTMLButtonElement>;
    }
  ).ref;
  const composedTriggerRef = useComposedRefs(
    suppliedTriggerRef,
    captureTrigger,
  );
  const renderedTrigger = cloneElement(trigger, {
    ref: composedTriggerRef,
    onKeyDownCapture: onDirectionalKeyDownCapture,
    onKeyDown: onPlainKeyDown,
    ...(!armed
      ? {
          "aria-haspopup": "menu" as const,
          "aria-expanded": false,
          onPointerEnter: () => setArmed(true),
          onPointerDown: (event: React.PointerEvent) => {
            if (event.button !== 0 || event.ctrlKey) return;
            setArmed(true);
            setOpenState(true);
          },
        }
      : {}),
  });
  if (!armed) return renderedTrigger;
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>{renderedTrigger}</MenuTrigger>
      <DirectionalMenuContent
        {...content}
        ref={(element) => {
          contentRef.current = element;
        }}
        onOpenAutoFocus={finishDirectionalOpen}
      >
        {preparedItems?.children ?? children}
      </DirectionalMenuContent>
    </Menu>
  );
}

interface ReactionPickerOwnerFacts {
  readonly session: CollabSession;
  readonly documentId: string;
  readonly visit: CommentPanelVisit;
  readonly coordinator: CommentRowActionCoordinator;
  readonly thread: CommentThread;
  readonly reply: CommentReply | null;
  readonly targetIdentity: CommentTargetIdentity;
  readonly threadId: string;
  readonly replyId: string | null;
  readonly viewerId: string;
  readonly reactions: Reactions;
  readonly canReact: boolean;
  readonly disabled: boolean;
  readonly onToggle: (emoji: string) => void;
}

interface ReactionPickerReactionFact {
  readonly emoji: string;
  readonly reactorIds: readonly string[];
}

interface ReactionPickerOptionFact {
  readonly index: number;
  readonly emoji: string;
  readonly mine: boolean;
  readonly disabled: boolean;
}

interface ReactionPickerMovement {
  readonly identity: symbol;
  readonly key: RequestModeNavigationKey;
  readonly source: number;
  readonly destination: number | null;
}

interface ReactionPickerAuthority {
  readonly identity: symbol;
  readonly owner: ReactionPickerOwnerFacts;
  readonly armed: boolean;
  readonly open: boolean;
  readonly revision: number;
  readonly reactions: readonly ReactionPickerReactionFact[];
  readonly options: readonly ReactionPickerOptionFact[];
  readonly setOpen: (open: boolean) => void;
  readonly requestSuccessor: () => void;
}

interface ReactionPickerBinding<ElementType extends HTMLElement> {
  readonly capture: React.RefCallback<ElementType>;
  readonly element: () => ElementType | null;
}

interface ReactionPickerDelivery {
  readonly publication: ReactionPickerPublication;
  readonly wrapper: object;
  readonly methods: ReactionPickerReactMethods;
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly listener: ReactionPickerListenerProof;
  readonly currentTarget: HTMLElement;
  readonly dispatchTarget: EventTarget;
  readonly source: HTMLButtonElement;
  readonly sourceIndex: number;
  readonly key: RequestModeNavigationKey;
  readonly code: string;
  readonly path: readonly EventTarget[];
  readonly phase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly cancelBubble: boolean;
  readonly trusted: boolean;
  readonly view: Window | null;
  readonly repeat: boolean;
  readonly composing: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

interface ReactionPickerReactMethods {
  readonly isDefaultPrevented: (...args: never[]) => unknown;
  readonly isPropagationStopped: (...args: never[]) => unknown;
}

interface ReactionPickerListenerProof {
  readonly identity: symbol;
  readonly registration: ReactionPickerListenerRegistration;
  readonly publication: ReactionPickerPublication;
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly source: HTMLButtonElement;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly terminal: EventTarget;
  readonly path: readonly EventTarget[];
}

interface ReactionPickerListenerRegistration {
  readonly identity: symbol;
  readonly listener: EventListener;
  readonly activate: (publication: ReactionPickerPublication) => boolean;
  readonly proofFor: (
    nativeEvent: globalThis.KeyboardEvent,
    publication: ReactionPickerPublication,
    source: HTMLButtonElement,
  ) => ReactionPickerListenerProof | null;
  readonly claim: (
    proof: ReactionPickerListenerProof,
    publication: ReactionPickerPublication,
  ) => boolean;
  readonly retains: (
    proof: ReactionPickerListenerProof,
    publication: ReactionPickerPublication,
  ) => boolean;
  readonly release: (publication: ReactionPickerPublication) => void;
}

interface ReactionPickerPublication {
  readonly identity: symbol;
  readonly authority: ReactionPickerAuthority;
  readonly trigger: HTMLButtonElement;
  readonly content: HTMLElement;
  readonly group: HTMLDivElement;
  readonly buttons: readonly HTMLButtonElement[];
  readonly bindings: readonly ReactionPickerBinding<HTMLElement>[];
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly keyboard: LazyMenuKeyboardAuthority;
  readonly listener: ReactionPickerListenerRegistration;
  readonly triggerDom: RequestModeDomSnapshot;
  readonly contentDom: RequestModeDomSnapshot;
  readonly triggerPlacement: RequestModePlacement;
  readonly contentPlacement: RequestModePlacement;
  readonly triggerHistory: RequestModeDomGuard;
  readonly contentHistory: RequestModeDomGuard;
  readonly isCurrent: () => boolean;
  readonly isRetired: () => boolean;
  readonly retire: () => void;
}

interface ReactionPickerRowPresentation {
  readonly authority: ReactionPickerOptionFact;
  readonly captureButton: React.RefCallback<HTMLButtonElement>;
  readonly onKeyDownCapture: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

interface ReactionPickerPresentation {
  readonly captureTrigger: React.RefCallback<HTMLButtonElement>;
  readonly captureGroup: React.RefCallback<HTMLDivElement>;
  readonly onGroupKeyDownCapture: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onGroupKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly rows: readonly ReactionPickerRowPresentation[];
  readonly establish: () => void | (() => void);
}

interface ReactionPickerCells {
  readonly active: { current: ReactionPickerPublication | null };
  readonly invalidNativeEvents: WeakSet<Event>;
  readonly claimedPublications: WeakSet<ReactionPickerPublication>;
  readonly claimedMovements: WeakSet<ReactionPickerMovement>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
  readonly claimedListenerProofs: WeakSet<ReactionPickerListenerProof>;
  readonly claimedDestinations: WeakSet<ReactionPickerBinding<HTMLButtonElement>>;
}

const claimedReactionPickerMovements = new WeakSet<ReactionPickerMovement>();
const claimedReactionPickerReactEvents = new WeakSet<object>();
const claimedReactionPickerNativeEvents = new WeakSet<Event>();
const claimedReactionPickerListenerProofs = new WeakSet<ReactionPickerListenerProof>();
const claimedReactionPickerDestinations = new WeakSet<ReactionPickerBinding<HTMLButtonElement>>();

function createReactionPickerCells(): ReactionPickerCells {
  return {
    active: { current: null },
    invalidNativeEvents: new WeakSet(),
    claimedPublications: new WeakSet(),
    claimedMovements: new WeakSet(),
    claimedReactEvents: new WeakSet(),
    claimedNativeEvents: new WeakSet(),
    claimedListenerProofs: new WeakSet(),
    claimedDestinations: new WeakSet(),
  };
}

function snapshotReactionFacts(reactions: Reactions): readonly ReactionPickerReactionFact[] {
  return Object.freeze(
    Object.entries(reactions).map(([emoji, reactorIds]) =>
      Object.freeze({
        emoji,
        reactorIds: Object.freeze([...reactorIds]),
      }),
    ),
  );
}

function reactionFactsMatch(
  expected: readonly ReactionPickerReactionFact[],
  reactions: Reactions,
) {
  const current = Object.entries(reactions);
  return (
    current.length === expected.length &&
    expected.every((fact, index) => {
      const entry = current[index];
      return Boolean(
        entry &&
          entry[0] === fact.emoji &&
          entry[1].length === fact.reactorIds.length &&
          entry[1].every((id, reactorIndex) => id === fact.reactorIds[reactorIndex]),
      );
    })
  );
}

function currentReactionPickerBusy(owner: ReactionPickerOwnerFacts) {
  const { coordinator, threadId, replyId } = owner;
  const ownKey = commentTargetKey(threadId, replyId);
  const ownBusy = coordinator.owners.has(ownKey) || coordinator.batchTargets.has(ownKey);
  if (replyId !== null) {
    const rootDeleting =
      coordinator.owners.get(commentTargetKey(threadId, null))?.action.type === "delete";
    return ownBusy || rootDeleting;
  }
  return ownBusy;
}

function reactionPickerOwnerFactsAreCurrent(
  owner: ReactionPickerOwnerFacts,
  reactionFacts: readonly ReactionPickerReactionFact[],
) {
  const {
    coordinator,
    session,
    threadId,
    replyId,
    targetIdentity,
  } = owner;
  const currentThread = session.comments
    .list()
    .find((candidate) => candidate.id === threadId);
  const currentReply =
    replyId === null
      ? null
      : currentThread?.replies.find((candidate) => candidate.id === replyId) ?? null;
  const currentIdentity = storedCommentTargetIdentity(session, threadId, replyId);
  const currentReactions = currentReply?.reactions ?? currentThread?.reactions;
  return (
    coordinator.mounted &&
    coordinator.session === session &&
    coordinator.documentId === owner.documentId &&
    coordinator.visit === owner.visit &&
    coordinator.targets.has(commentTargetKey(threadId, replyId)) &&
    session.docId === owner.documentId &&
    session.user.id === owner.viewerId &&
    session.canComment === owner.canReact &&
    owner.canReact &&
    currentThread !== undefined &&
    (replyId === null || currentReply !== null) &&
    currentIdentity?.thread === targetIdentity.thread &&
    currentIdentity.reply === targetIdentity.reply &&
    owner.thread.id === threadId &&
    (replyId === null
      ? owner.reply === null && owner.reactions === owner.thread.reactions
      : owner.reply?.id === replyId && owner.reactions === owner.reply.reactions) &&
    Boolean(currentReactions) &&
    reactionFactsMatch(reactionFacts, owner.reactions) &&
    reactionFactsMatch(reactionFacts, currentReactions!) &&
    currentReactionPickerBusy(owner) === owner.disabled &&
    !owner.disabled &&
    typeof owner.onToggle === "function"
  );
}

function reactionPickerOptionsAreCurrent(authority: ReactionPickerAuthority) {
  return (
    authority.armed &&
    authority.open &&
    authority.options.length === QUICK_REACTIONS.length &&
    authority.options.length > 1 &&
    authority.options.every((option, index) => {
      const emoji = QUICK_REACTIONS[index];
      return (
        option.index === index &&
        option.emoji === emoji &&
        option.mine === Boolean(authority.owner.reactions[option.emoji]?.includes(authority.owner.viewerId)) &&
        option.disabled === authority.owner.disabled &&
        !option.disabled
      );
    })
  );
}

function createReactionPickerBinding<ElementType extends HTMLElement>(
  cells: ReactionPickerCells,
): ReactionPickerBinding<ElementType> {
  let current: ElementType | null = null;
  let last: ElementType | null = null;
  let invalid = false;
  const binding: ReactionPickerBinding<ElementType> = Object.freeze({
    capture: (element: ElementType | null) => {
      if (element === current) return;
      const publication = cells.active.current;
      if (
        publication &&
        publication.bindings.includes(binding as ReactionPickerBinding<HTMLElement>)
      ) {
        publication.retire();
      }
      if (element && last && element !== last) invalid = true;
      current = element;
      if (element) last = element;
    },
    element: () => (invalid ? null : current),
  });
  return binding;
}

function reactionPickerPathMatchesTerminal(
  path: readonly EventTarget[],
  publication: ReactionPickerPublication,
  source: HTMLButtonElement,
  terminal: EventTarget,
) {
  const { contentPlacement, group, ownerDocument } = publication;
  return (
    path.length === contentPlacement.chain.length + 4 &&
    path[0] === source &&
    path[1] === group &&
    contentPlacement.chain.every(({ node }, index) => path[index + 2] === node) &&
    path.at(-2) === ownerDocument &&
    path.at(-1) === terminal
  );
}

function createReactionPickerListenerRegistration(
  ownerWindow: Window & typeof globalThis,
  keyboard: LazyMenuKeyboardAuthority,
): ReactionPickerListenerRegistration {
  const identity = Symbol("reaction-picker-listener");
  const proofs = new WeakMap<globalThis.KeyboardEvent, ReactionPickerListenerProof>();
  const invalidEvents = new WeakSet<Event>();
  let publication: ReactionPickerPublication | null = null;
  let claimed: ReactionPickerListenerProof | null = null;
  let active = false;
  let released = false;

  const listener: EventListener = function (this: EventTarget, event: Event) {
    const current = publication;
    if (
      !current ||
      !active ||
      released ||
      current.listener !== registration ||
      current.isRetired() ||
      !(event instanceof keyboard.KeyboardEvent) ||
      keyboard.getPrototypeOf(event) !== keyboard.KeyboardEvent.prototype ||
      invalidEvents.has(event) ||
      !keyboard.isCurrent()
    ) {
      return;
    }
    if (proofs.has(event)) {
      invalidEvents.add(event);
      return;
    }
    try {
      const source = keyboard.eventTarget.read(event);
      const currentTarget = keyboard.eventCurrentTarget.read(event);
      const path = keyboard.eventPath.invoke(event);
      const terminal = path.at(-1);
      if (
        !(source instanceof keyboard.ownerWindow.HTMLButtonElement) ||
        !current.buttons.includes(source) ||
        currentTarget !== this ||
        terminal !== this ||
        keyboard.eventPhase.read(event) !== keyboard.Event.CAPTURING_PHASE ||
        !reactionPickerPathMatchesTerminal(path, current, source, this)
      ) {
        return;
      }
      proofs.set(
        event,
        Object.freeze({
          identity: Symbol("reaction-picker-listener-proof"),
          registration,
          publication: current,
          nativeEvent: event,
          source,
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

  const proofFor = (
    nativeEvent: globalThis.KeyboardEvent,
    current: ReactionPickerPublication,
    source: HTMLButtonElement,
  ) => {
    const proof = proofs.get(nativeEvent);
    if (
      !proof ||
      !active ||
      released ||
      publication !== current ||
      current.listener !== registration ||
      current.isRetired() ||
      proof.registration !== registration ||
      proof.publication !== current ||
      proof.nativeEvent !== nativeEvent ||
      proof.source !== source ||
      proof.receiver !== proof.currentTarget ||
      proof.receiver !== proof.terminal ||
      invalidEvents.has(nativeEvent) ||
      !keyboard.isCurrent()
    ) {
      return null;
    }
    try {
      const path = keyboard.eventPath.invoke(nativeEvent);
      return path.length === proof.path.length &&
        path.every((entry, index) => entry === proof.path[index]) &&
        reactionPickerPathMatchesTerminal(path, current, source, proof.receiver)
        ? proof
        : null;
    } catch {
      invalidEvents.add(nativeEvent);
      return null;
    }
  };

  const registration: ReactionPickerListenerRegistration = Object.freeze({
    identity,
    listener,
    activate: (current: ReactionPickerPublication) => {
      if (
        publication ||
        active ||
        released ||
        current.listener !== registration ||
        current.ownerWindow !== ownerWindow ||
        current.keyboard !== keyboard ||
        !keyboard.isCurrent()
      ) {
        return false;
      }
      publication = current;
      active = true;
      try {
        keyboard.apply(keyboard.addEventListener.value, ownerWindow, [
          "keydown",
          listener,
          true,
        ]);
        return (
          ownerWindow.addEventListener === keyboard.addEventListener.value &&
          keyboard.addEventListener.isCurrent()
        );
      } catch {
        active = false;
        publication = null;
        return false;
      }
    },
    proofFor,
    claim: (
      proof: ReactionPickerListenerProof,
      current: ReactionPickerPublication,
    ) => {
      if (
        claimed ||
        proofFor(proof.nativeEvent, current, proof.source) !== proof
      ) {
        return false;
      }
      claimed = proof;
      return true;
    },
    retains: (
      proof: ReactionPickerListenerProof,
      current: ReactionPickerPublication,
    ) =>
      publication === current &&
      current.listener === registration &&
      claimed === proof &&
      proofs.get(proof.nativeEvent) === proof &&
      proof.registration === registration &&
      proof.publication === current &&
      proof.receiver === proof.currentTarget &&
      proof.receiver === proof.terminal &&
      !invalidEvents.has(proof.nativeEvent) &&
      active &&
      !released &&
      keyboard.isCurrent(),
    release: (current: ReactionPickerPublication) => {
      if (publication !== current || released) return;
      released = true;
      active = false;
      keyboard.apply(keyboard.removeEventListener.value, ownerWindow, [
        "keydown",
        listener,
        true,
      ]);
    },
  });
  return registration;
}

function reactionPickerEventPathMatches(
  path: readonly EventTarget[],
  publication: ReactionPickerPublication,
  source: HTMLButtonElement,
  proof: ReactionPickerListenerProof,
) {
  return (
    (publication.listener.proofFor(proof.nativeEvent, publication, source) ===
      proof ||
      publication.listener.retains(proof, publication)) &&
    path.length === proof.path.length &&
    path.every((entry, index) => entry === proof.path[index]) &&
    reactionPickerPathMatchesTerminal(path, publication, source, proof.receiver)
  );
}

function exactReactionPickerDelivery(
  event: KeyboardEvent<HTMLElement>,
  publication: ReactionPickerPublication,
  currentTarget: HTMLElement,
  expectedPhase: number,
): ReactionPickerDelivery | null {
  if (!event || typeof event !== "object" || !publication.keyboard.isCurrent()) return null;
  const keyboard = publication.keyboard;
  const nativeEvent = event.nativeEvent;
  if (
    !(nativeEvent instanceof keyboard.KeyboardEvent) ||
    keyboard.getPrototypeOf(nativeEvent) !== keyboard.KeyboardEvent.prototype ||
    !keyboard.trusted.matches(nativeEvent)
  ) {
    return null;
  }
  try {
    const key = keyboard.key.read(nativeEvent);
    if (
      key !== "ArrowRight" &&
      key !== "ArrowDown" &&
      key !== "ArrowLeft" &&
      key !== "ArrowUp" &&
      key !== "Home" &&
      key !== "End"
    ) {
      return null;
    }
    const code = keyboard.code.read(nativeEvent);
    const target = keyboard.eventTarget.read(nativeEvent);
    const sourceIndex = publication.buttons.findIndex((button) => button === target);
    const source = publication.buttons[sourceIndex];
    if (!source) return null;
    const listener = publication.listener.proofFor(
      nativeEvent,
      publication,
      source,
    );
    if (!listener) return null;
    const path = keyboard.eventPath.invoke(nativeEvent);
    const phase = keyboard.eventPhase.read(nativeEvent);
    const dispatchTarget = keyboard.eventCurrentTarget.read(nativeEvent);
    const bubbles = keyboard.eventBubbles.read(nativeEvent);
    const cancelable = keyboard.eventCancelable.read(nativeEvent);
    const defaultPrevented = keyboard.eventDefaultPrevented.read(nativeEvent);
    const cancelBubble = keyboard.eventCancelBubble.read(nativeEvent);
    const view = keyboard.eventView.read(nativeEvent);
    const repeat = keyboard.repeat.read(nativeEvent);
    const composing = keyboard.composing.read(nativeEvent);
    const altKey = keyboard.altKey.read(nativeEvent);
    const ctrlKey = keyboard.ctrlKey.read(nativeEvent);
    const metaKey = keyboard.metaKey.read(nativeEvent);
    const shiftKey = keyboard.shiftKey.read(nativeEvent);
    const trusted = keyboard.trusted.read(nativeEvent);
    const reactEvent = event as KeyboardEvent<HTMLElement> & {
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
      persist?: unknown;
    };
    const methods = Object.freeze({
      isDefaultPrevented:
        reactEvent.isDefaultPrevented as (...args: never[]) => unknown,
      isPropagationStopped:
        reactEvent.isPropagationStopped as (...args: never[]) => unknown,
    });
    return typeof methods.isDefaultPrevented === "function" &&
      typeof methods.isPropagationStopped === "function" &&
      keyboard.apply(methods.isDefaultPrevented, event, []) === false &&
      keyboard.apply(methods.isPropagationStopped, event, []) === false &&
      code === key &&
      keyboard.eventType.read(nativeEvent) === "keydown" &&
      phase === expectedPhase &&
      bubbles &&
      cancelable &&
      !defaultPrevented &&
      !cancelBubble &&
      trusted &&
      (view === null ||
        (view === listener.receiver && view === path.at(-1))) &&
      !repeat &&
      !composing &&
      !altKey &&
      !ctrlKey &&
      !metaKey &&
      !shiftKey &&
      target === source &&
      reactionPickerEventPathMatches(path, publication, source, listener) &&
      dispatchTarget !== null &&
      dispatchTarget instanceof keyboard.Node &&
      dispatchTarget.ownerDocument === publication.ownerDocument &&
      path.filter((entry) => entry === dispatchTarget).length === 1 &&
      keyboard.activeElement.read(publication.ownerDocument) === source &&
      event.type === "keydown" &&
      event.currentTarget === currentTarget &&
      event.target === source &&
      event.nativeEvent === nativeEvent &&
      event.key === key &&
      event.code === code &&
      event.eventPhase === phase &&
      event.repeat === repeat &&
      event.altKey === altKey &&
      event.ctrlKey === ctrlKey &&
      event.metaKey === metaKey &&
      event.shiftKey === shiftKey &&
      event.bubbles === bubbles &&
      event.cancelable === cancelable &&
      event.defaultPrevented === defaultPrevented &&
      event.isTrusted === trusted &&
      Object.is(event.view, view) &&
      reactEvent.isDefaultPrevented === methods.isDefaultPrevented &&
      reactEvent.isPropagationStopped === methods.isPropagationStopped &&
      typeof reactEvent.persist === "function"
      ? Object.freeze({
          publication,
          wrapper: event,
          methods,
          nativeEvent,
          listener,
          currentTarget,
          dispatchTarget,
          source,
          sourceIndex,
          key,
          code,
          path: Object.freeze([...path]),
          phase,
          bubbles,
          cancelable,
          defaultPrevented,
          cancelBubble,
          trusted,
          view,
          repeat,
          composing,
          altKey,
          ctrlKey,
          metaKey,
          shiftKey,
        })
      : null;
  } catch {
    return null;
  }
}

function reactionPickerDeliveriesMatch(
  capture: ReactionPickerDelivery,
  current: ReactionPickerDelivery,
) {
  return (
    capture.publication === current.publication &&
    capture.wrapper === current.wrapper &&
    capture.methods.isDefaultPrevented ===
      current.methods.isDefaultPrevented &&
    capture.methods.isPropagationStopped ===
      current.methods.isPropagationStopped &&
    capture.nativeEvent === current.nativeEvent &&
    capture.listener === current.listener &&
    capture.dispatchTarget === current.dispatchTarget &&
    capture.source === current.source &&
    capture.sourceIndex === current.sourceIndex &&
    capture.key === current.key &&
    capture.code === current.code &&
    capture.path.length === current.path.length &&
    capture.path.every((entry, index) => entry === current.path[index]) &&
    capture.phase === current.phase &&
    capture.bubbles === current.bubbles &&
    capture.cancelable === current.cancelable &&
    capture.defaultPrevented === current.defaultPrevented &&
    capture.cancelBubble === current.cancelBubble &&
    capture.trusted === current.trusted &&
    capture.view === current.view &&
    capture.repeat === current.repeat &&
    capture.composing === current.composing &&
    capture.altKey === current.altKey &&
    capture.ctrlKey === current.ctrlKey &&
    capture.metaKey === current.metaKey &&
    capture.shiftKey === current.shiftKey
  );
}

function reactionPickerNativeFactsMatch(
  capture: ReactionPickerDelivery,
  bubble: ReactionPickerDelivery,
) {
  return (
    capture.publication === bubble.publication &&
    capture.wrapper !== bubble.wrapper &&
    capture.nativeEvent === bubble.nativeEvent &&
    capture.listener === bubble.listener &&
    capture.dispatchTarget === bubble.dispatchTarget &&
    capture.source === bubble.source &&
    capture.sourceIndex === bubble.sourceIndex &&
    capture.key === bubble.key &&
    capture.code === bubble.code &&
    capture.path.length === bubble.path.length &&
    capture.path.every((entry, index) => entry === bubble.path[index]) &&
    capture.bubbles === bubble.bubbles &&
    capture.cancelable === bubble.cancelable &&
    capture.defaultPrevented === bubble.defaultPrevented &&
    capture.cancelBubble === bubble.cancelBubble &&
    capture.trusted === bubble.trusted &&
    capture.view === bubble.view &&
    capture.repeat === bubble.repeat &&
    capture.composing === bubble.composing &&
    capture.altKey === bubble.altKey &&
    capture.ctrlKey === bubble.ctrlKey &&
    capture.metaKey === bubble.metaKey &&
    capture.shiftKey === bubble.shiftKey
  );
}

function reactionPickerMethodsRemainFalse(
  delivery: ReactionPickerDelivery,
) {
  const event = delivery.wrapper as KeyboardEvent<HTMLElement> & {
    isDefaultPrevented?: unknown;
    isPropagationStopped?: unknown;
  };
  const { keyboard } = delivery.publication;
  try {
    return (
      event.isDefaultPrevented === delivery.methods.isDefaultPrevented &&
      event.isPropagationStopped ===
        delivery.methods.isPropagationStopped &&
      keyboard.apply(
        delivery.methods.isDefaultPrevented,
        delivery.wrapper,
        [],
      ) === false &&
      keyboard.apply(
        delivery.methods.isPropagationStopped,
        delivery.wrapper,
        [],
      ) === false
    );
  } catch {
    return false;
  }
}

function currentReactionPickerElements(
  authority: ReactionPickerAuthority,
  triggerBinding: ReactionPickerBinding<HTMLButtonElement>,
  groupBinding: ReactionPickerBinding<HTMLDivElement>,
  rows: readonly (ReactionPickerRowPresentation & {
    readonly buttonBinding: ReactionPickerBinding<HTMLButtonElement>;
  })[],
) {
  const trigger = triggerBinding.element();
  const group = groupBinding.element();
  const content = group?.parentElement ?? null;
  const buttons = rows.map((row) => row.buttonBinding.element());
  if (!trigger || !content || !group || buttons.some((button) => !button)) return null;
  const exactButtons = buttons as HTMLButtonElement[];
  if (
    !trigger.isConnected ||
    trigger.tagName !== "BUTTON" ||
    trigger.type !== "button" ||
    trigger.disabled ||
    trigger.className !== "reaction-add" ||
    trigger.getAttribute("aria-label") !== "Add reaction" ||
    trigger.getAttribute("title") !== "Add reaction" ||
    trigger.getAttribute("aria-haspopup") !== "dialog" ||
    trigger.getAttribute("aria-expanded") !== "true" ||
    trigger.getAttribute("data-state") !== "open" ||
    !content.isConnected ||
    content.ownerDocument !== trigger.ownerDocument ||
    content.getAttribute("role") !== "dialog" ||
    content.getAttribute("data-state") !== "open" ||
    content.dataset.testid !== "reaction-picker" ||
    trigger.getAttribute("aria-controls") !== content.id ||
    !group.isConnected ||
    group.ownerDocument !== trigger.ownerDocument ||
    group.parentElement !== content ||
    content.children.length !== 1 ||
    content.children.item(0) !== group ||
    group.className !== "reaction-picker" ||
    group.getAttribute("role") !== "group" ||
    group.getAttribute("aria-label") !== "Pick a reaction" ||
    group.childNodes.length !== authority.options.length ||
    group.children.length !== authority.options.length
  ) {
    return null;
  }
  for (const [index, button] of exactButtons.entries()) {
    const option = authority.options[index];
    if (
      !option ||
      rows[index]?.authority !== option ||
      !button.isConnected ||
      button.ownerDocument !== trigger.ownerDocument ||
      button.parentElement !== group ||
      group.childNodes.item(index) !== button ||
      group.children.item(index) !== button ||
      button.tagName !== "BUTTON" ||
      button.type !== "button" ||
      button.disabled ||
      button.matches(":disabled") ||
      button.getAttribute("aria-label") !== `React with ${option.emoji}` ||
      button.getAttribute("data-mine") !== (option.mine ? "true" : null) ||
      button.dataset.testid !== "reaction-option" ||
      button.dataset.emoji !== option.emoji ||
      button.textContent !== option.emoji
    ) {
      return null;
    }
  }
  return Object.freeze({
    trigger,
    content,
    group,
    buttons: Object.freeze(exactButtons),
  });
}

function createReactionPickerPresentation(
  authority: ReactionPickerAuthority,
  cells: ReactionPickerCells,
): ReactionPickerPresentation {
  const triggerBinding = createReactionPickerBinding<HTMLButtonElement>(cells);
  const groupBinding = createReactionPickerBinding<HTMLDivElement>(cells);
  let establishAttempted = false;
  let portalSuccessorRequested = false;
  const captureGroup: React.RefCallback<HTMLDivElement> = (element) => {
    groupBinding.capture(element);
    if (element && establishAttempted && !portalSuccessorRequested) {
      portalSuccessorRequested = true;
      queueMicrotask(authority.requestSuccessor);
    }
  };
  let capturedGroup: ReactionPickerDelivery | null = null;
  let capturedOption: ReactionPickerDelivery | null = null;
  let bubbledOption: ReactionPickerDelivery | null = null;
  const clearBoundaryProof = () => {
    capturedGroup = null;
    capturedOption = null;
    bubbledOption = null;
  };
  const currentPublication = () => {
    const publication = cells.active.current;
    if (
      !publication ||
      publication.isRetired() ||
      publication.authority !== authority ||
      publication.authority.identity !== authority.identity
    ) {
      return null;
    }
    if (!publication.isCurrent()) {
      publication.retire();
      return null;
    }
    return publication;
  };
  const rowPresentations = authority.options.map((option) => {
    const buttonBinding = createReactionPickerBinding<HTMLButtonElement>(cells);
    const movements = Object.freeze(
      Object.fromEntries(
        (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"] as const).map(
          (key) => [
            key,
            Object.freeze({
              identity: Symbol(`reaction-picker-${key}-movement`),
              key,
              source: option.index,
              destination: requestModeDestination(key, option.index, authority.options.length),
            } satisfies ReactionPickerMovement),
          ],
        ),
      ) as Record<RequestModeNavigationKey, ReactionPickerMovement>,
    );
    const onKeyDownCapture = (event: KeyboardEvent<HTMLButtonElement>) => {
      const publication = currentPublication();
      const source = buttonBinding.element();
      const current = source && publication
        ? exactReactionPickerDelivery(
            event,
            publication,
            source,
            publication.keyboard.Event.CAPTURING_PHASE,
          )
        : null;
      if (
        !capturedGroup ||
        capturedOption ||
        bubbledOption ||
        !current ||
        !source ||
        capturedGroup.source !== source ||
        capturedGroup.sourceIndex !== option.index ||
        !reactionPickerDeliveriesMatch(capturedGroup, current)
      ) {
        clearBoundaryProof();
        return;
      }
      capturedOption = current;
    };
    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
      const publication = currentPublication();
      const source = buttonBinding.element();
      const current = source && publication
        ? exactReactionPickerDelivery(
            event,
            publication,
            source,
            publication.keyboard.Event.BUBBLING_PHASE,
          )
        : null;
      if (
        !capturedGroup ||
        !capturedOption ||
        bubbledOption ||
        !current ||
        !source ||
        capturedGroup.source !== source ||
        capturedGroup.sourceIndex !== option.index ||
        !reactionPickerDeliveriesMatch(capturedGroup, capturedOption) ||
        !reactionPickerNativeFactsMatch(capturedOption, current)
      ) {
        clearBoundaryProof();
        return;
      }
      bubbledOption = current;
    };
    return Object.freeze({
      authority: option,
      captureButton: buttonBinding.capture,
      buttonBinding,
      onKeyDownCapture,
      onKeyDown,
      movements,
    });
  });
  const onGroupKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    clearBoundaryProof();
    const publication = currentPublication();
    if (!publication) return;
    const current = exactReactionPickerDelivery(
      event,
      publication,
      publication.group,
      publication.keyboard.Event.CAPTURING_PHASE,
    );
    if (
      !current ||
      cells.invalidNativeEvents.has(current.nativeEvent) ||
      cells.claimedNativeEvents.has(current.nativeEvent) ||
      claimedReactionPickerNativeEvents.has(current.nativeEvent)
    ) {
      return;
    }
    capturedGroup = current;
    queueMicrotask(() => {
      if (capturedGroup === current) clearBoundaryProof();
    });
  };
  const onGroupKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const groupCapture = capturedGroup;
    const optionCapture = capturedOption;
    const optionBubble = bubbledOption;
    const publication = currentPublication();
    const groupBubble = publication
      ? exactReactionPickerDelivery(
          event,
          publication,
          publication.group,
          publication.keyboard.Event.BUBBLING_PHASE,
        )
      : null;
    clearBoundaryProof();
    if (
      !publication ||
      !groupCapture ||
      !optionCapture ||
      !optionBubble ||
      !groupBubble ||
      !reactionPickerDeliveriesMatch(groupCapture, optionCapture) ||
      !reactionPickerDeliveriesMatch(optionBubble, groupBubble) ||
      !reactionPickerNativeFactsMatch(optionCapture, optionBubble) ||
      groupCapture.phase !== publication.keyboard.Event.CAPTURING_PHASE ||
      optionCapture.phase !== publication.keyboard.Event.CAPTURING_PHASE ||
      optionBubble.phase !== publication.keyboard.Event.BUBBLING_PHASE ||
      groupBubble.phase !== publication.keyboard.Event.BUBBLING_PHASE ||
      groupCapture.currentTarget !== publication.group ||
      optionCapture.currentTarget !== optionCapture.source ||
      optionBubble.currentTarget !== optionBubble.source ||
      groupBubble.currentTarget !== publication.group ||
      !reactionPickerMethodsRemainFalse(groupCapture) ||
      !reactionPickerMethodsRemainFalse(optionCapture) ||
      !reactionPickerMethodsRemainFalse(optionBubble) ||
      !reactionPickerMethodsRemainFalse(groupBubble)
    ) {
      return;
    }
    const sourceIndex = groupCapture.sourceIndex;
    const sourceRow = rowPresentations[sourceIndex];
    const movement = sourceRow?.movements[groupCapture.key] ?? null;
    const destinationIndex = movement?.destination ?? null;
    if (destinationIndex === null) return;
    const destinationRow = rowPresentations[destinationIndex];
    const destination = destinationRow?.buttonBinding.element() ?? null;
    const listener = groupBubble.listener;
    if (
      !sourceRow ||
      sourceRow.authority !== authority.options[sourceIndex] ||
      !movement ||
      movement.source !== sourceIndex ||
      !destinationRow ||
      destinationRow.authority !== authority.options[destinationIndex] ||
      !destination ||
      publication.buttons[destinationIndex] !== destination ||
      destination.parentElement !== publication.group ||
      publication.group.children.item(destinationIndex) !== destination ||
      cells.invalidNativeEvents.has(groupBubble.nativeEvent) ||
      cells.claimedPublications.has(publication) ||
      cells.claimedMovements.has(movement) ||
      cells.claimedReactEvents.has(groupCapture.wrapper) ||
      cells.claimedReactEvents.has(groupBubble.wrapper) ||
      cells.claimedNativeEvents.has(groupBubble.nativeEvent) ||
      cells.claimedListenerProofs.has(listener) ||
      cells.claimedDestinations.has(destinationRow.buttonBinding) ||
      claimedReactionPickerMovements.has(movement) ||
      claimedReactionPickerReactEvents.has(groupCapture.wrapper) ||
      claimedReactionPickerReactEvents.has(groupBubble.wrapper) ||
      claimedReactionPickerNativeEvents.has(groupBubble.nativeEvent) ||
      claimedReactionPickerListenerProofs.has(listener) ||
      claimedReactionPickerDestinations.has(destinationRow.buttonBinding) ||
      cells.active.current !== publication ||
      !publication.isCurrent() ||
      !publication.listener.claim(listener, publication)
    ) {
      return;
    }
    cells.claimedPublications.add(publication);
    cells.claimedMovements.add(movement);
    cells.claimedReactEvents.add(groupCapture.wrapper);
    cells.claimedReactEvents.add(groupBubble.wrapper);
    cells.claimedNativeEvents.add(groupBubble.nativeEvent);
    cells.claimedListenerProofs.add(listener);
    cells.claimedDestinations.add(destinationRow.buttonBinding);
    claimedReactionPickerMovements.add(movement);
    claimedReactionPickerReactEvents.add(groupCapture.wrapper);
    claimedReactionPickerReactEvents.add(groupBubble.wrapper);
    claimedReactionPickerNativeEvents.add(groupBubble.nativeEvent);
    claimedReactionPickerListenerProofs.add(listener);
    claimedReactionPickerDestinations.add(destinationRow.buttonBinding);
    if (
      !publication.listener.retains(listener, publication) ||
      !reactionPickerMethodsRemainFalse(groupCapture) ||
      !reactionPickerMethodsRemainFalse(groupBubble)
    ) {
      return;
    }
    publication.keyboard.eventPreventDefault.invoke(groupBubble.nativeEvent);
    if (
      !publication.keyboard.eventDefaultPrevented.read(
        groupBubble.nativeEvent,
      ) ||
      !publication.listener.retains(listener, publication)
    ) {
      return;
    }
    publication.keyboard.focus.invoke(destination, { preventScroll: true });
    if (
      publication.keyboard.activeElement.read(publication.ownerDocument) !==
        destination ||
      !publication.listener.retains(listener, publication)
    ) {
      return;
    }
    authority.requestSuccessor();
  };
  const bindings: readonly ReactionPickerBinding<HTMLElement>[] = Object.freeze([
    triggerBinding,
    groupBinding,
    ...rowPresentations.map((row) => row.buttonBinding),
  ]);
  const establish = () => {
    establishAttempted = true;
    if (!reactionPickerOwnerFactsAreCurrent(authority.owner, authority.reactions)) return;
    if (!reactionPickerOptionsAreCurrent(authority)) return;
    const elements = currentReactionPickerElements(
      authority,
      triggerBinding,
      groupBinding,
      rowPresentations,
    );
    const ownerWindow = elements?.trigger.ownerDocument.defaultView;
    const keyboard =
      elements && ownerWindow
        ? captureLazyMenuKeyboardAuthority(elements.trigger.ownerDocument, ownerWindow)
        : null;
    const triggerPlacement = elements
      ? captureRequestModePlacement(elements.trigger)
      : null;
    const contentPlacement = elements
      ? captureRequestModePlacement(elements.content)
      : null;
    const triggerHistory =
      elements && triggerPlacement
        ? createRequestModeDomGuard(elements.trigger, triggerPlacement)
        : null;
    const contentHistory =
      elements && contentPlacement
        ? createRequestModeDomGuard(elements.content, contentPlacement)
        : null;
    if (
      !elements ||
      !ownerWindow ||
      !keyboard ||
      !triggerPlacement ||
      !contentPlacement ||
      !triggerHistory ||
      !contentHistory
    ) {
      triggerHistory?.release();
      contentHistory?.release();
      return;
    }
    const triggerDom = snapshotRequestModeDom(elements.trigger);
    const contentDom = snapshotRequestModeDom(elements.content);
    const listener = createReactionPickerListenerRegistration(
      ownerWindow,
      keyboard,
    );
    let retired = false;
    const publication: ReactionPickerPublication = Object.freeze({
      identity: Symbol("reaction-picker-publication"),
      authority,
      trigger: elements.trigger,
      content: elements.content,
      group: elements.group,
      buttons: elements.buttons,
      bindings,
      ownerDocument: elements.trigger.ownerDocument,
      ownerWindow,
      keyboard,
      listener,
      triggerDom,
      contentDom,
      triggerPlacement,
      contentPlacement,
      triggerHistory,
      contentHistory,
      isCurrent: () =>
        !retired &&
        cells.active.current === publication &&
        publication.authority === authority &&
        reactionPickerOwnerFactsAreCurrent(authority.owner, authority.reactions) &&
        reactionPickerOptionsAreCurrent(authority) &&
        triggerHistory.isClean() &&
        contentHistory.isClean() &&
        requestModePlacementMatches(elements.trigger, triggerPlacement) &&
        requestModePlacementMatches(elements.content, contentPlacement) &&
        requestModeDomMatches(triggerDom) &&
        requestModeDomMatches(contentDom) &&
        currentReactionPickerElements(
          authority,
          triggerBinding,
          groupBinding,
          rowPresentations,
        )?.buttons.every((button, index) => button === elements.buttons[index]) === true,
      isRetired: () => retired,
      retire: () => {
        if (retired) return;
        retired = true;
        clearBoundaryProof();
        listener.release(publication);
        if (cells.active.current === publication) cells.active.current = null;
        triggerHistory.release();
        contentHistory.release();
      },
    });
    cells.active.current?.retire();
    cells.active.current = publication;
    if (!listener.activate(publication) || !publication.isCurrent()) {
      publication.retire();
      return;
    }
    return publication.retire;
  };
  return Object.freeze({
    captureTrigger: triggerBinding.capture,
    captureGroup,
    onGroupKeyDownCapture,
    onGroupKeyDown,
    rows: Object.freeze(rowPresentations),
    establish,
  });
}

/** Reaction chips plus the quick picker for one thread body or reply. */
function ReactionRow({
  owner,
  names,
}: {
  owner: ReactionPickerOwnerFacts;
  names: Record<string, string>;
}) {
  const { armed, open, setOpen, plainProps } = useLazyTrigger();
  const [keyboardRevision, setKeyboardRevision] = useState(0);
  const [keyboardCells] = useState(createReactionPickerCells);
  const requestKeyboardSuccessor = useCallback(
    () => setKeyboardRevision((revision) => revision + 1),
    [],
  );
  const { reactions, viewerId: me, canReact, disabled, onToggle } = owner;
  const keyboardAuthority = armed
    ? Object.freeze({
        identity: Symbol("reaction-picker-authority"),
        owner,
        armed,
        open,
        revision: keyboardRevision,
        reactions: snapshotReactionFacts(reactions),
        options: Object.freeze(
          QUICK_REACTIONS.map((emoji, index) =>
            Object.freeze({
              index,
              emoji,
              mine: Boolean(reactions[emoji]?.includes(me)),
              disabled,
            }),
          ),
        ),
        setOpen,
        requestSuccessor: requestKeyboardSuccessor,
      } satisfies ReactionPickerAuthority)
    : null;
  const keyboardPresentation = useMemo(
    () =>
      keyboardAuthority
        ? createReactionPickerPresentation(keyboardAuthority, keyboardCells)
        : null,
    [keyboardAuthority, keyboardCells],
  );
  useLayoutEffect(
    () => keyboardPresentation?.establish(),
    [keyboardPresentation],
  );
  const entries = Object.entries(reactions).filter(([, ids]) => ids.length > 0);
  if (entries.length === 0 && !canReact) return null;
  const addButton = (
    <button
      ref={keyboardPresentation?.captureTrigger}
      type="button"
      className="reaction-add"
      aria-label="Add reaction"
      title="Add reaction"
      disabled={disabled}
      data-testid="reaction-add"
    >
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
            <PopoverContent
              side="top"
              align="start"
              className="p-1"
              data-testid="reaction-picker"
            >
              <div
                ref={keyboardPresentation?.captureGroup}
                className="reaction-picker"
                role="group"
                aria-label="Pick a reaction"
                onKeyDownCapture={keyboardPresentation?.onGroupKeyDownCapture}
                onKeyDown={keyboardPresentation?.onGroupKeyDown}
              >
                {keyboardAuthority?.options.map((option, index) => (
                  <button
                    ref={keyboardPresentation?.rows[index]?.captureButton}
                    key={option.emoji}
                    type="button"
                    data-mine={option.mine ? "true" : undefined}
                    aria-label={`React with ${option.emoji}`}
                    disabled={disabled}
                    onKeyDownCapture={keyboardPresentation?.rows[index]?.onKeyDownCapture}
                    onKeyDown={keyboardPresentation?.rows[index]?.onKeyDown}
                    onClick={() => {
                      onToggle(option.emoji);
                      setOpen(false);
                    }}
                    data-testid="reaction-option"
                    data-emoji={option.emoji}
                  >
                    {option.emoji}
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
    <div className="mt-1.5 rounded-md bg-red-50 px-2 py-1.5 text-xs text-danger dark:bg-red-950/40 wrap-anywhere" role="alert" aria-atomic="true" data-testid="comment-action-error">
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

type MentionNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

interface MentionRowAuthority {
  readonly index: number;
  readonly candidate: MentionCandidate;
  readonly login: string;
  readonly name: string;
  readonly image: string | null;
  readonly own: boolean;
  readonly agent: MentionCandidateAgent | null;
  readonly ownerLogin: string | null;
  readonly ownerName: string | null;
  readonly canAsk: boolean | null;
  readonly highlighted: boolean;
  readonly optionId: string;
}

interface MentionAuthority {
  readonly mount: symbol;
  readonly revision: number;
  readonly value: string;
  readonly trigger: Readonly<{ start: number; query: string }>;
  readonly candidates: readonly MentionCandidate[];
  readonly rows: readonly MentionRowAuthority[];
  readonly highlight: number;
  readonly busy: boolean;
  readonly listId: string;
  readonly currentVisit: () => ComposerVisit | null;
  readonly currentSubmission: () => ComposerSubmissionOwner | null;
  readonly currentRoot: () => HTMLDivElement | null;
  readonly currentTextarea: () => HTMLTextAreaElement | null;
  readonly currentList: () => HTMLUListElement | null;
  readonly currentRows: () => readonly (HTMLLIElement | null)[];
  readonly setHighlight: (index: number) => void;
  readonly requestSuccessor: () => void;
}

interface MentionAction {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly key: MentionNavigationKey;
  readonly source: number;
  readonly destination: number | null;
}

interface MentionDomEvidence {
  readonly textarea: RequestModeDomSnapshot;
  readonly list: RequestModeDomSnapshot;
  readonly textareaPlacement: RequestModePlacement;
  readonly listPlacement: RequestModePlacement;
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface MentionReactMethods {
  readonly preventDefault: (...args: never[]) => unknown;
  readonly isDefaultPrevented: (...args: never[]) => unknown;
  readonly isPropagationStopped: (...args: never[]) => unknown;
}

interface MentionReactProof {
  readonly event: object;
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly currentTarget: HTMLElement;
  readonly phase: number;
  readonly key: MentionNavigationKey;
  readonly type: string;
  readonly target: EventTarget;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly trusted: boolean;
  readonly view: Window | null;
  readonly detail: number;
  readonly code: string;
  readonly location: number;
  readonly charCode: number;
  readonly keyCode: number;
  readonly which: number;
  readonly locale: unknown;
  readonly repeat: boolean;
  readonly composing: boolean | undefined;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly methods: MentionReactMethods;
}

interface MentionKeyboardAuthority {
  readonly keyboard: RequestModeKeyboardAuthority;
  readonly charCode: RequestModeCapturedGetter<number> | null;
  readonly keyCode: RequestModeCapturedGetter<number> | null;
  readonly which: RequestModeCapturedGetter<number> | null;
  readonly locale: RequestModeCapturedGetter<unknown> | null;
  readonly isCurrent: () => boolean;
}

interface MentionNativeFacts extends RequestModeNativeKeyboardFacts {
  readonly charCode: number;
  readonly keyCode: number;
  readonly which: number;
  readonly locale: unknown;
}

interface MentionNativeProof {
  readonly event: globalThis.KeyboardEvent;
  readonly facts: MentionNativeFacts;
  readonly receiver: EventTarget;
  readonly terminal: EventTarget;
  readonly action: MentionAction;
}

interface MentionKeyboardPair {
  readonly native: MentionNativeProof;
  rootCapture: MentionReactProof | null;
  textareaCapture: MentionReactProof | null;
  textareaBubble: MentionReactProof | null;
  rootBubble: MentionReactProof | null;
  readonly postDefaultQueries: WeakMap<
    object,
    MentionReactMethods["isDefaultPrevented"]
  >;
  readonly postDefaultPrevented: WeakMap<object, boolean>;
  finalizing: boolean;
  consumed: boolean;
}

interface MentionPublication {
  readonly identity: symbol;
  readonly authority: MentionAuthority;
  readonly visit: ComposerVisit;
  readonly root: HTMLDivElement;
  readonly textarea: HTMLTextAreaElement;
  readonly list: HTMLUListElement;
  readonly rowElements: readonly HTMLLIElement[];
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly keyboard: MentionKeyboardAuthority;
  readonly dom: MentionDomEvidence;
  readonly actions: Readonly<Record<MentionNavigationKey, MentionAction>>;
  readonly captureRoot: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly captureTextarea: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly bubbleTextarea: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly bubbleRoot: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly retire: () => void;
  readonly isRetired: () => boolean;
}

interface MentionCells {
  readonly active: { current: MentionPublication | null };
  readonly retired: WeakSet<MentionPublication>;
  readonly claimedPublications: WeakSet<MentionPublication>;
  readonly claimedActions: WeakSet<MentionAction>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
  readonly retireForElement: (
    element: Element | null,
    expected: Element | null,
  ) => void;
}

interface MentionHandlers {
  readonly captureRoot: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly captureTextarea: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly bubbleTextarea: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly bubbleRoot: (event: KeyboardEvent<HTMLDivElement>) => void;
}

type RequestModeNavigationKey = "ArrowRight" | "ArrowDown" | "ArrowLeft" | "ArrowUp" | "Home" | "End";

interface RequestModeRowAuthority {
  readonly index: number;
  readonly id: AgentRequestMode;
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly tabIndex: 0 | -1;
}

interface RequestModeAuthority {
  readonly mount: symbol;
  readonly revision: number;
  readonly request: ComposerRequestOptions;
  readonly canEdit: boolean;
  readonly defaultMode: AgentRequestMode;
  readonly value: string;
  readonly candidates: readonly MentionCandidate[];
  readonly agents: readonly MentionCandidate[];
  readonly agentIdentities: readonly string[];
  readonly viewerLogin: string | null;
  readonly mode: AgentRequestMode;
  readonly effectiveMode: AgentRequestMode;
  readonly rowLabel: string;
  readonly busy: boolean;
  readonly rows: readonly RequestModeRowAuthority[];
  readonly visitIsCurrent: () => boolean;
  readonly submissionIsIdle: () => boolean;
  readonly setMode: (mode: AgentRequestMode) => void;
  readonly requestSuccessor: () => void;
}

interface RequestModeDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly ignoredAttributes: readonly string[];
  readonly children: readonly RequestModeDomSnapshot[];
}

interface RequestModeNodePlacement {
  readonly node: Node;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
  readonly exactSiblings: boolean;
}

interface RequestModePlacement {
  readonly document: Document;
  readonly chain: readonly RequestModeNodePlacement[];
}

interface RequestModeDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface RequestModeElementOwnerView {
  readonly element: () => Element | null;
}

interface RequestModeRefReplay {
  readonly owner: RequestModeElementOwnerView;
  readonly element: Element;
  detached: boolean;
  reattached: boolean;
}

type RequestModeReactKeyboardMethodName =
  | "preventDefault"
  | "isDefaultPrevented"
  | "isPropagationStopped";

type RequestModeReactKeyboardMethod = (...args: never[]) => unknown;

function isRequestModeReactKeyboardMethod(
  value: unknown,
): value is RequestModeReactKeyboardMethod {
  return typeof value === "function";
}

interface RequestModeNativeKeyboardFacts {
  readonly type: string;
  readonly target: EventTarget | null;
  readonly currentTarget: EventTarget | null;
  readonly phase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly composed: boolean;
  readonly defaultPrevented: boolean;
  readonly cancelBubble: boolean;
  readonly path: readonly EventTarget[];
  readonly trusted: boolean;
  readonly view: Window | null;
  readonly detail: number;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly repeat: boolean;
  readonly composing: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

interface RequestModeReactKeyboardEvent {
  readonly preventDefault?: unknown;
  readonly isDefaultPrevented?: unknown;
  readonly isPropagationStopped?: unknown;
  readonly isComposing?: unknown;
}

interface RequestModeReactKeyboardFacts {
  readonly nativeEvent: Event;
  readonly type: string;
  readonly target: EventTarget;
  readonly currentTarget: HTMLButtonElement;
  readonly phase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly trusted: boolean;
  readonly view: unknown;
  readonly detail: number;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly repeat: boolean;
  readonly composing: boolean | undefined;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

interface RequestModeReactKeyboardSnapshot {
  readonly event: KeyboardEvent<HTMLButtonElement>;
  readonly publicFacts: RequestModeReactKeyboardFacts;
  readonly nativeFacts: RequestModeNativeKeyboardFacts;
  readonly methods: Readonly<
    Record<RequestModeReactKeyboardMethodName, RequestModeReactKeyboardMethod>
  >;
}

interface RequestModeKeyboardWindowStage {
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly receiver: EventTarget;
  readonly facts: RequestModeNativeKeyboardFacts;
  readonly source: HTMLButtonElement;
  readonly row: RequestModeRowAuthority;
}

interface RequestModeKeyboardAction {
  readonly identity: symbol;
  readonly row: RequestModeRowAuthority;
}

interface RequestModeKeyboardPair {
  readonly publication: RequestModePublication;
  readonly action: RequestModeKeyboardAction;
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly stage: RequestModeKeyboardWindowStage;
  readonly capture: RequestModeReactKeyboardSnapshot;
  readonly sourceRow: RequestModeRowAuthority;
  readonly source: HTMLButtonElement;
  readonly destinationRow: RequestModeRowAuthority;
  readonly destination: HTMLButtonElement;
  readonly key: RequestModeNavigationKey;
}

interface RequestModeKeyboardRegistration {
  readonly isCurrent: () => boolean;
  readonly remove: () => void;
}

interface RequestModeCapturedGetter<Value> {
  readonly read: (target: object) => Value;
  readonly isCurrent: () => boolean;
}

interface RequestModeCapturedMethod<Args extends readonly unknown[], Result> {
  readonly invoke: (target: object, ...args: Args) => Result;
  readonly isCurrent: () => boolean;
}

interface RequestModeTrustedGetter {
  readonly read: (event: object) => boolean;
  readonly matches: (event: object) => boolean;
  readonly isCurrent: () => boolean;
}

interface RequestModeKeyboardAuthority {
  readonly ownerWindow: Window & typeof globalThis;
  readonly Event: typeof globalThis.Event;
  readonly UIEvent: typeof globalThis.UIEvent;
  readonly KeyboardEvent: typeof globalThis.KeyboardEvent;
  readonly Node: typeof globalThis.Node;
  readonly keyboardPrototype: object;
  readonly prototypeOf: typeof Object.getPrototypeOf;
  readonly eventType: RequestModeCapturedGetter<string>;
  readonly eventTarget: RequestModeCapturedGetter<EventTarget | null>;
  readonly eventCurrentTarget: RequestModeCapturedGetter<EventTarget | null>;
  readonly eventPhase: RequestModeCapturedGetter<number>;
  readonly eventBubbles: RequestModeCapturedGetter<boolean>;
  readonly eventCancelable: RequestModeCapturedGetter<boolean>;
  readonly eventComposed: RequestModeCapturedGetter<boolean>;
  readonly eventDefaultPrevented: RequestModeCapturedGetter<boolean>;
  readonly eventCancelBubble: RequestModeCapturedGetter<boolean>;
  readonly eventPath: RequestModeCapturedMethod<readonly [], EventTarget[]>;
  readonly eventPreventDefault: RequestModeCapturedMethod<readonly [], void>;
  readonly eventView: RequestModeCapturedGetter<Window | null>;
  readonly detail: RequestModeCapturedGetter<number>;
  readonly key: RequestModeCapturedGetter<string>;
  readonly code: RequestModeCapturedGetter<string>;
  readonly location: RequestModeCapturedGetter<number>;
  readonly repeat: RequestModeCapturedGetter<boolean>;
  readonly composing: RequestModeCapturedGetter<boolean>;
  readonly altKey: RequestModeCapturedGetter<boolean>;
  readonly ctrlKey: RequestModeCapturedGetter<boolean>;
  readonly metaKey: RequestModeCapturedGetter<boolean>;
  readonly shiftKey: RequestModeCapturedGetter<boolean>;
  readonly activeElement: RequestModeCapturedGetter<Element | null>;
  readonly focus: RequestModeCapturedMethod<readonly [FocusOptions?], void>;
  readonly trusted: RequestModeTrustedGetter;
  readonly isCurrent: () => boolean;
  readonly requestModeIsCurrent: () => boolean;
  readonly applyMethod: (
    method: RequestModeReactKeyboardMethod,
    receiver: object,
  ) => Readonly<{ called: boolean; value?: unknown }>;
  readonly registerRequestMode: (
    listener: (this: EventTarget, event: Event) => void,
  ) => RequestModeKeyboardRegistration | null;
}

interface RequestModePublication {
  readonly identity: symbol;
  readonly authority: RequestModeAuthority;
  readonly root: HTMLDivElement;
  readonly buttons: readonly HTMLButtonElement[];
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly dom: RequestModeDomSnapshot;
  readonly placement: RequestModePlacement;
  readonly keyboard: RequestModeKeyboardAuthority;
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
}

interface RequestModeReplay {
  readonly source: RequestModePublication;
  readonly dom: RequestModeDomSnapshot;
  readonly placement: RequestModePlacement;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface RequestModeRuntime {
  readonly publication: RequestModePublication;
  readonly publish: () => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: RequestModeElementOwnerView,
    element: Element | null,
    previous: Element | null,
  ) => void;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly replay: () => RequestModeReplay | null;
  readonly keyboardCaptureIsReady: () => boolean;
  readonly keyboardListenerIsCurrent: () => boolean;
  readonly keyboardStage: (
    event: globalThis.KeyboardEvent,
  ) => RequestModeKeyboardWindowStage | null;
  readonly pairKeyboard: (
    event: globalThis.KeyboardEvent,
    stage: RequestModeKeyboardWindowStage,
    pair: RequestModeKeyboardPair,
  ) => boolean;
  readonly keyboardPair: (
    event: globalThis.KeyboardEvent,
  ) => RequestModeKeyboardPair | null;
  readonly consumeKeyboardPair: (
    event: globalThis.KeyboardEvent,
    pair: RequestModeKeyboardPair,
  ) => boolean;
}

interface RequestModeRowPresentation {
  readonly authority: RequestModeRowAuthority;
  readonly captureButton: (element: HTMLButtonElement | null) => void;
  readonly onKeyDownCapture: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

interface RequestModePresentation {
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly rows: readonly RequestModeRowPresentation[];
  readonly establish: () => void | (() => void);
}

const EMPTY_REQUEST_MODE_PRESENTATION: RequestModePresentation = Object.freeze({
  captureRoot: () => undefined,
  rows: Object.freeze([]),
  establish: () => undefined,
});

interface RequestModeCells {
  readonly active: { current: RequestModePublication | null };
  readonly successorOf: { current: RequestModePublication | null };
  readonly replay: { current: RequestModeReplay | null };
  readonly retired: WeakSet<RequestModePublication>;
  readonly claimedPublications: WeakSet<RequestModePublication>;
  readonly claimedActions: WeakSet<object>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
  readonly claimedWindowStages: WeakSet<RequestModeKeyboardWindowStage>;
  readonly keyboardAttempt: { current: object | null };
  readonly keyboardDelivery: { current: symbol | null };
}

const claimedRequestModeReactEvents = new WeakSet<object>();
const claimedRequestModeNativeEvents = new WeakSet<Event>();

class RequestModeElementOwner<ElementType extends Element> implements RequestModeElementOwnerView {
  private current: ElementType | null = null;
  private last: ElementType | null = null;

  constructor(
    private readonly onChange: (
      owner: RequestModeElementOwnerView,
      element: ElementType | null,
      previous: ElementType | null,
      last: ElementType | null,
    ) => void,
  ) {}

  readonly element = () => this.current;
  readonly capture = (element: ElementType | null) => {
    if (this.current === element) return;
    const previous = this.current;
    const last = this.last;
    this.current = element;
    if (element) this.last = element;
    this.onChange(this, element, previous, last);
  };
}

class RequestModePresentationCache {
  private current: {
    readonly authority: RequestModeAuthority;
    readonly presentation: RequestModePresentation;
  } | null = null;

  resolve(authority: RequestModeAuthority, create: () => RequestModePresentation) {
    if (!this.current || !requestModeAuthoritiesMatch(this.current.authority, authority)) {
      this.current = Object.freeze({ authority, presentation: create() });
    }
    return this.current.presentation;
  }
}

function createRequestModeCells(): RequestModeCells {
  return {
    active: { current: null },
    successorOf: { current: null },
    replay: { current: null },
    retired: new WeakSet(),
    claimedPublications: new WeakSet(),
    claimedActions: new WeakSet(),
    claimedReactEvents: new WeakSet(),
    claimedNativeEvents: new WeakSet(),
    claimedWindowStages: new WeakSet(),
    keyboardAttempt: { current: null },
    keyboardDelivery: { current: null },
  };
}

function requestModeDescriptorMatches(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  if (
    !current ||
    current.configurable !== expected.configurable ||
    current.enumerable !== expected.enumerable
  ) {
    return false;
  }
  return "value" in expected
    ? current.value === expected.value && current.writable === expected.writable
    : current.get === expected.get && current.set === expected.set;
}

function captureRequestModeGetter<Value>(
  ownerWindow: Window & typeof globalThis,
  prototype: object,
  property: string,
): RequestModeCapturedGetter<Value> | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  let owner: object | null = prototype;
  while (owner) {
    const descriptor = getOwnPropertyDescriptor(owner, property);
    if (descriptor) {
      if (typeof descriptor.get !== "function") return null;
      const expected = Object.freeze({ ...descriptor });
      const getter = descriptor.get;
      return Object.freeze({
        read: (target: object) => apply(getter, target, []) as Value,
        isCurrent: () =>
          ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
          ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
          ownerWindow.Reflect.apply === apply &&
          requestModeDescriptorMatches(getOwnPropertyDescriptor(owner!, property), expected),
      });
    }
    owner = getPrototypeOf(owner) as object | null;
  }
  return null;
}

function captureRequestModeMethod<Args extends readonly unknown[], Result>(
  ownerWindow: Window & typeof globalThis,
  prototype: object,
  property: string,
): RequestModeCapturedMethod<Args, Result> | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  let owner: object | null = prototype;
  while (owner) {
    const descriptor = getOwnPropertyDescriptor(owner, property);
    if (descriptor) {
      if (typeof descriptor.value !== "function") return null;
      const expected = Object.freeze({ ...descriptor });
      const method = descriptor.value as (...args: Args) => Result;
      return Object.freeze({
        invoke: (target: object, ...args: Args) => apply(method, target, args) as Result,
        isCurrent: () =>
          ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
          ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
          ownerWindow.Reflect.apply === apply &&
          requestModeDescriptorMatches(getOwnPropertyDescriptor(owner!, property), expected),
      });
    }
    owner = getPrototypeOf(owner) as object | null;
  }
  return null;
}

function captureRequestModeTrustedGetter(
  ownerWindow: Window & typeof globalThis,
): RequestModeTrustedGetter | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const apply = ownerWindow.Reflect.apply;
  let probe: globalThis.KeyboardEvent;
  try {
    probe = new ownerWindow.KeyboardEvent("request-mode-trust-probe");
  } catch {
    return null;
  }
  const descriptor = getOwnPropertyDescriptor(probe, "isTrusted");
  if (!descriptor || descriptor.configurable !== false || typeof descriptor.get !== "function") {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  const matches = (event: object) =>
    requestModeDescriptorMatches(getOwnPropertyDescriptor(event, "isTrusted"), expected);
  return Object.freeze({
    read: (event: object) => apply(descriptor.get!, event, []) as boolean,
    matches,
    isCurrent: () =>
      ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
      ownerWindow.Reflect.apply === apply &&
      matches(probe),
  });
}

function captureRequestModeKeyboardAuthority(
  ownerDocument: Document,
  ownerWindow: Window & typeof globalThis,
): RequestModeKeyboardAuthority | null {
  const EventConstructor = ownerWindow.Event;
  const UIEventConstructor = ownerWindow.UIEvent;
  const KeyboardEventConstructor = ownerWindow.KeyboardEvent;
  const NodeConstructor = ownerWindow.Node;
  const eventPrototype = EventConstructor.prototype;
  const uiEventPrototype = UIEventConstructor.prototype;
  const keyboardPrototype = KeyboardEventConstructor.prototype;
  const documentPrototype = ownerWindow.Document.prototype;
  const htmlElementPrototype = ownerWindow.HTMLElement.prototype;
  const prototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const addEventListener = ownerWindow.addEventListener;
  const removeEventListener = ownerWindow.removeEventListener;
  const eventType = captureRequestModeGetter<string>(ownerWindow, eventPrototype, "type");
  const eventTarget = captureRequestModeGetter<EventTarget | null>(ownerWindow, eventPrototype, "target");
  const eventCurrentTarget = captureRequestModeGetter<EventTarget | null>(
    ownerWindow,
    eventPrototype,
    "currentTarget",
  );
  const eventPhase = captureRequestModeGetter<number>(ownerWindow, eventPrototype, "eventPhase");
  const eventBubbles = captureRequestModeGetter<boolean>(ownerWindow, eventPrototype, "bubbles");
  const eventCancelable = captureRequestModeGetter<boolean>(ownerWindow, eventPrototype, "cancelable");
  const eventComposed = captureRequestModeGetter<boolean>(
    ownerWindow,
    eventPrototype,
    "composed",
  );
  const eventDefaultPrevented = captureRequestModeGetter<boolean>(ownerWindow, eventPrototype, "defaultPrevented");
  const eventCancelBubble = captureRequestModeGetter<boolean>(ownerWindow, eventPrototype, "cancelBubble");
  const eventPath = captureRequestModeMethod<readonly [], EventTarget[]>(ownerWindow, eventPrototype, "composedPath");
  const eventPreventDefault = captureRequestModeMethod<readonly [], void>(ownerWindow, eventPrototype, "preventDefault");
  const eventView = captureRequestModeGetter<Window | null>(ownerWindow, uiEventPrototype, "view");
  const detail = captureRequestModeGetter<number>(ownerWindow, uiEventPrototype, "detail");
  const key = captureRequestModeGetter<string>(ownerWindow, keyboardPrototype, "key");
  const code = captureRequestModeGetter<string>(ownerWindow, keyboardPrototype, "code");
  const location = captureRequestModeGetter<number>(
    ownerWindow,
    keyboardPrototype,
    "location",
  );
  const repeat = captureRequestModeGetter<boolean>(ownerWindow, keyboardPrototype, "repeat");
  const composing = captureRequestModeGetter<boolean>(ownerWindow, keyboardPrototype, "isComposing");
  const altKey = captureRequestModeGetter<boolean>(ownerWindow, keyboardPrototype, "altKey");
  const ctrlKey = captureRequestModeGetter<boolean>(ownerWindow, keyboardPrototype, "ctrlKey");
  const metaKey = captureRequestModeGetter<boolean>(ownerWindow, keyboardPrototype, "metaKey");
  const shiftKey = captureRequestModeGetter<boolean>(ownerWindow, keyboardPrototype, "shiftKey");
  const activeElement = captureRequestModeGetter<Element | null>(ownerWindow, documentPrototype, "activeElement");
  const focus = captureRequestModeMethod<readonly [FocusOptions?], void>(ownerWindow, htmlElementPrototype, "focus");
  const trusted = captureRequestModeTrustedGetter(ownerWindow);
  const intrinsics = [
    eventType,
    eventTarget,
    eventCurrentTarget,
    eventPhase,
    eventBubbles,
    eventCancelable,
    eventComposed,
    eventDefaultPrevented,
    eventCancelBubble,
    eventPath,
    eventPreventDefault,
    eventView,
    detail,
    key,
    code,
    location,
    repeat,
    composing,
    altKey,
    ctrlKey,
    metaKey,
    shiftKey,
    activeElement,
    focus,
    trusted,
  ];
  if (
    intrinsics.some((intrinsic) => !intrinsic) ||
    ownerDocument.defaultView !== ownerWindow ||
    typeof addEventListener !== "function" ||
    typeof removeEventListener !== "function"
  ) {
    return null;
  }
  const exactIntrinsics = intrinsics as readonly (
    | RequestModeCapturedGetter<unknown>
    | RequestModeCapturedMethod<readonly unknown[], unknown>
    | RequestModeTrustedGetter
  )[];
  const isCurrent = () =>
    ownerDocument.defaultView === ownerWindow &&
    ownerWindow.Event === EventConstructor &&
    ownerWindow.UIEvent === UIEventConstructor &&
    ownerWindow.KeyboardEvent === KeyboardEventConstructor &&
    ownerWindow.Node === NodeConstructor &&
    ownerWindow.Object.getPrototypeOf === prototypeOf &&
    ownerWindow.Reflect.apply === apply &&
    EventConstructor.prototype === eventPrototype &&
    UIEventConstructor.prototype === uiEventPrototype &&
    KeyboardEventConstructor.prototype === keyboardPrototype &&
    ownerWindow.Document.prototype === documentPrototype &&
    ownerWindow.HTMLElement.prototype === htmlElementPrototype &&
    exactIntrinsics.every((intrinsic) => intrinsic.isCurrent());
  if (!isCurrent()) return null;
  let requestModeHistoryIsClean = true;
  const requestModeIsCurrent = () => {
    if (!requestModeHistoryIsClean) return false;
    requestModeHistoryIsClean =
    isCurrent() &&
    ownerWindow.addEventListener === addEventListener &&
    ownerWindow.removeEventListener === removeEventListener;
    return requestModeHistoryIsClean;
  };
  return Object.freeze({
    ownerWindow,
    Event: EventConstructor,
    UIEvent: UIEventConstructor,
    KeyboardEvent: KeyboardEventConstructor,
    Node: NodeConstructor,
    keyboardPrototype,
    prototypeOf,
    eventType: eventType!,
    eventTarget: eventTarget!,
    eventCurrentTarget: eventCurrentTarget!,
    eventPhase: eventPhase!,
    eventBubbles: eventBubbles!,
    eventCancelable: eventCancelable!,
    eventComposed: eventComposed!,
    eventDefaultPrevented: eventDefaultPrevented!,
    eventCancelBubble: eventCancelBubble!,
    eventPath: eventPath!,
    eventPreventDefault: eventPreventDefault!,
    eventView: eventView!,
    detail: detail!,
    key: key!,
    code: code!,
    location: location!,
    repeat: repeat!,
    composing: composing!,
    altKey: altKey!,
    ctrlKey: ctrlKey!,
    metaKey: metaKey!,
    shiftKey: shiftKey!,
    activeElement: activeElement!,
    focus: focus!,
    trusted: trusted!,
    isCurrent,
    requestModeIsCurrent,
    applyMethod: (
      method: RequestModeReactKeyboardMethod,
      receiver: object,
    ) => {
      if (!requestModeIsCurrent()) return Object.freeze({ called: false });
      try {
        return Object.freeze({
          called: true,
          value: apply(method, receiver, []),
        });
      } catch {
        return Object.freeze({ called: false });
      }
    },
    registerRequestMode: (
      listener: (this: EventTarget, event: Event) => void,
    ) => {
      if (!requestModeIsCurrent()) return null;
      let active = true;
      try {
        apply(addEventListener, ownerWindow, ["keydown", listener, true]);
      } catch {
        return null;
      }
      return Object.freeze({
        isCurrent: () => active && requestModeIsCurrent(),
        remove: () => {
          if (!active) return;
          active = false;
          try {
            apply(removeEventListener, ownerWindow, [
              "keydown",
              listener,
              true,
            ]);
          } catch {
            return;
          }
        },
      });
    },
  });
}

function requestModeAttributes(
  node: Node,
  ignoredAttributes: readonly string[] = [],
): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .filter(
        ({ name }) =>
          !ignoredAttributes.includes(name) &&
          !(
            ignoredAttributes.includes("data-radix-popper-*") &&
            name.startsWith("data-radix-popper-")
          ),
      )
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotRequestModeDom(
  node: Node,
  ignoredForNode: (node: Node) => readonly string[] = () => [],
): RequestModeDomSnapshot {
  const ignoredAttributes = Object.freeze([...ignoredForNode(node)]);
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: requestModeAttributes(node, ignoredAttributes),
    ignoredAttributes,
    children: Object.freeze(
      [...node.childNodes].map((child) =>
        snapshotRequestModeDom(child, ignoredForNode),
      ),
    ),
  });
}

function requestModeDomMatches(snapshot: RequestModeDomSnapshot): boolean {
  const attributes = requestModeAttributes(
    snapshot.node,
    snapshot.ignoredAttributes,
  );
  if (
    snapshot.node.nodeValue !== snapshot.nodeValue ||
    (attributes === null) !== (snapshot.attributes === null)
  ) {
    return false;
  }
  if (
    attributes &&
    snapshot.attributes &&
    (attributes.length !== snapshot.attributes.length ||
      attributes.some(([name, value], index) => {
        const expected = snapshot.attributes?.[index];
        return !expected || expected[0] !== name || expected[1] !== value;
      }))
  ) {
    return false;
  }
  return (
    snapshot.node.childNodes.length === snapshot.children.length &&
    snapshot.children.every(
      (child, index) =>
        snapshot.node.childNodes.item(index) === child.node && requestModeDomMatches(child),
    )
  );
}

function captureRequestModePlacement(root: Element): RequestModePlacement | null {
  const ownerDocument = root.ownerDocument;
  if (!root.isConnected) return null;
  const chain: RequestModeNodePlacement[] = [];
  let node: Node = root;
  while (node !== ownerDocument) {
    const parent = node.parentNode;
    if (!parent) return null;
    chain.push(
      Object.freeze({
        node,
        parent,
        previousSibling: node.previousSibling,
        nextSibling: node.nextSibling,
        exactSiblings: node === root,
      }),
    );
    node = parent;
  }
  return Object.freeze({ document: ownerDocument, chain: Object.freeze(chain) });
}

function requestModePlacementMatches(root: Element, placement: RequestModePlacement) {
  return (
    root.ownerDocument === placement.document &&
    root.isConnected &&
    placement.chain.length > 0 &&
    placement.chain[0]?.node === root &&
    placement.chain.every(
      ({ node, parent, previousSibling, nextSibling, exactSiblings }) =>
        node.parentNode === parent &&
        (!exactSiblings ||
          (node.previousSibling === previousSibling && node.nextSibling === nextSibling)),
    )
  );
}

function createRequestModeDomGuard(
  root: Element,
  placement: RequestModePlacement,
  ignoreMutation: (record: MutationRecord) => boolean = () => false,
): RequestModeDomGuard | null {
  const MutationObserverConstructor = placement.document.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some((record) => {
      if (ignoreMutation(record)) return false;
      if (record.target === root || root.contains(record.target)) return true;
      if (record.type !== "childList") return false;
      return placement.chain.some(({ node, parent, exactSiblings }) => {
        if (record.target !== parent) return false;
        const changedNodes = [...record.addedNodes, ...record.removedNodes];
        if (changedNodes.some((candidate) => candidate === node || candidate.contains?.(node))) {
          return true;
        }
        return exactSiblings && (record.previousSibling === node || record.nextSibling === node);
      });
    });
  };
  const observer = new MutationObserverConstructor(recordChanges);
  observer.observe(placement.document, {
    attributes: true,
    characterData: true,
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

function requestModeAgentName(candidate: MentionCandidate, viewerLogin: string | null) {
  return candidate.agent
    ? agentDisplayName(
        {
          name: candidate.name,
          ownerLogin: candidate.agent.ownerLogin,
          ownerName: candidate.agent.ownerName,
        },
        viewerLogin,
      )
    : candidate.name;
}

function requestModeRowsMatch(
  previous: readonly RequestModeRowAuthority[],
  current: readonly RequestModeRowAuthority[],
) {
  return (
    previous.length === current.length &&
    previous.every((row, index) => {
      const candidate = current[index];
      return Boolean(
        candidate &&
          row.index === candidate.index &&
          row.id === candidate.id &&
          row.label === candidate.label &&
          row.checked === candidate.checked &&
          row.disabled === candidate.disabled &&
          row.tabIndex === candidate.tabIndex,
      );
    })
  );
}

function requestModeAuthoritiesMatch(
  previous: RequestModeAuthority,
  current: RequestModeAuthority,
  includeRevision = true,
) {
  return (
    previous.mount === current.mount &&
    (!includeRevision || previous.revision === current.revision) &&
    previous.canEdit === current.canEdit &&
    previous.defaultMode === current.defaultMode &&
    previous.value === current.value &&
    previous.candidates === current.candidates &&
    previous.agents.length === current.agents.length &&
    previous.agents.every((agent, index) => agent === current.agents[index]) &&
    previous.agentIdentities.length === current.agentIdentities.length &&
    previous.agentIdentities.every(
      (identity, index) => identity === current.agentIdentities[index],
    ) &&
    previous.viewerLogin === current.viewerLogin &&
    previous.mode === current.mode &&
    previous.effectiveMode === current.effectiveMode &&
    previous.rowLabel === current.rowLabel &&
    previous.busy === current.busy &&
    previous.visitIsCurrent === current.visitIsCurrent &&
    previous.submissionIsIdle === current.submissionIsIdle &&
    previous.setMode === current.setMode &&
    previous.requestSuccessor === current.requestSuccessor &&
    requestModeRowsMatch(previous.rows, current.rows)
  );
}

function requestModeFactsAreCurrent(authority: RequestModeAuthority) {
  const currentAgents = mentionedAgents(authority.value, authority.candidates);
  const expectedLabel =
    currentAgents.length === 1
      ? `How should ${requestModeAgentName(currentAgents[0]!, authority.viewerLogin)} answer?`
      : "How should the agents answer?";
  return (
    authority.visitIsCurrent() &&
    authority.submissionIsIdle() &&
    !authority.busy &&
    authority.request.canEdit === authority.canEdit &&
    authority.request.defaultMode === authority.defaultMode &&
    currentAgents.length > 0 &&
    currentAgents.length === authority.agents.length &&
    currentAgents.every(
      (agent, index) =>
        agent === authority.agents[index] && agent.login === authority.agentIdentities[index],
    ) &&
    authority.effectiveMode === (authority.canEdit ? authority.mode : "comment") &&
    authority.rowLabel === expectedLabel &&
    authority.rows.length === REQUEST_MODES.length &&
    authority.rows.every((row, index) => {
      const expected = REQUEST_MODES[index];
      const disabled = expected?.id !== "comment" && !authority.canEdit;
      return Boolean(
        expected &&
          row.index === index &&
          row.id === expected.id &&
          row.label === expected.label &&
          row.checked === (row.id === authority.effectiveMode) &&
          row.disabled === disabled &&
          row.tabIndex === (row.checked ? 0 : -1),
      );
    })
  );
}

function currentRequestModeElements(
  authority: RequestModeAuthority,
  rootOwner: RequestModeElementOwner<HTMLDivElement>,
  rowPresentations: readonly (RequestModeRowPresentation & {
    readonly buttonOwner: RequestModeElementOwner<HTMLButtonElement>;
  })[],
) {
  const root = rootOwner.element();
  const ownerWindow = root?.ownerDocument.defaultView;
  const buttons = rowPresentations.map((presentation) => presentation.buttonOwner.element());
  if (!root || !ownerWindow || buttons.some((button) => !button)) return null;
  const exactButtons = buttons as HTMLButtonElement[];
  if (
    !root.isConnected ||
    root.tagName !== "DIV" ||
    root.className !== "composer-modes" ||
    root.getAttribute("role") !== "radiogroup" ||
    root.getAttribute("aria-label") !== authority.rowLabel ||
    root.childNodes.length !== authority.rows.length ||
    root.children.length !== authority.rows.length
  ) {
    return null;
  }
  for (const [index, button] of exactButtons.entries()) {
    const row = authority.rows[index];
    if (
      !row ||
      rowPresentations[index]?.authority !== row ||
      !button.isConnected ||
      button.ownerDocument !== root.ownerDocument ||
      button.parentElement !== root ||
      root.childNodes.item(index) !== button ||
      root.children.item(index) !== button ||
      button.tagName !== "BUTTON" ||
      button.type !== "button" ||
      button.disabled ||
      button.matches(":disabled") ||
      button.getAttribute("role") !== "radio" ||
      button.getAttribute("aria-checked") !== String(row.checked) ||
      button.getAttribute("aria-disabled") !== (row.disabled ? "true" : null) ||
      button.tabIndex !== row.tabIndex ||
      button.className !== "composer-mode" ||
      button.dataset.testid !== `composer-mode-${row.id}` ||
      button.textContent !== row.label
    ) {
      return null;
    }
  }
  return Object.freeze({ root, buttons: Object.freeze(exactButtons) });
}

function requestModeDestination(
  key: RequestModeNavigationKey,
  current: number,
  count: number,
): number | null {
  if (current < 0 || current >= count || count < 2) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + count) % count;
  if (key === "Home") return current === 0 ? null : 0;
  return current === count - 1 ? null : count - 1;
}

function isRequestModeNavigationKey(
  key: string,
): key is RequestModeNavigationKey {
  return (
    key === "ArrowRight" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowUp" ||
    key === "Home" ||
    key === "End"
  );
}

function readRequestModeNativeKeyboardFacts(
  event: object,
  keyboard: RequestModeKeyboardAuthority,
): RequestModeNativeKeyboardFacts | null {
  try {
    if (
      !keyboard.requestModeIsCurrent() ||
      !(event instanceof keyboard.KeyboardEvent) ||
      keyboard.prototypeOf(event) !== keyboard.keyboardPrototype ||
      !keyboard.trusted.matches(event) ||
      keyboard.trusted.read(event) !== true
    ) {
      return null;
    }
    return Object.freeze({
      type: keyboard.eventType.read(event),
      target: keyboard.eventTarget.read(event),
      currentTarget: keyboard.eventCurrentTarget.read(event),
      phase: keyboard.eventPhase.read(event),
      bubbles: keyboard.eventBubbles.read(event),
      cancelable: keyboard.eventCancelable.read(event),
      composed: keyboard.eventComposed.read(event),
      defaultPrevented: keyboard.eventDefaultPrevented.read(event),
      cancelBubble: keyboard.eventCancelBubble.read(event),
      path: Object.freeze([...keyboard.eventPath.invoke(event)]),
      trusted: true,
      view: keyboard.eventView.read(event),
      detail: keyboard.detail.read(event),
      key: keyboard.key.read(event),
      code: keyboard.code.read(event),
      location: keyboard.location.read(event),
      repeat: keyboard.repeat.read(event),
      composing: keyboard.composing.read(event),
      altKey: keyboard.altKey.read(event),
      ctrlKey: keyboard.ctrlKey.read(event),
      metaKey: keyboard.metaKey.read(event),
      shiftKey: keyboard.shiftKey.read(event),
    });
  } catch {
    return null;
  }
}

function requestModeEventPath(
  source: HTMLElement,
  ownerDocument: Document,
): readonly EventTarget[] | null {
  const path: EventTarget[] = [];
  for (let node: Node | null = source; node; node = node.parentNode) {
    path.push(node);
    if (node === ownerDocument) return Object.freeze(path);
  }
  return null;
}

function requestModePathMatches(
  actual: readonly EventTarget[],
  expected: readonly EventTarget[],
  terminal: EventTarget,
) {
  return (
    expected.length > 0 &&
    actual.length === expected.length + 1 &&
    expected.every((entry, index) => actual[index] === entry) &&
    actual.at(-1) === terminal
  );
}

function requestModeNativeKeyboardFactsMatch(
  first: RequestModeNativeKeyboardFacts,
  second: RequestModeNativeKeyboardFacts,
  expectedDefaultPrevented = first.defaultPrevented,
  expectedCancelBubble = first.cancelBubble,
) {
  return (
    first.type === second.type &&
    first.target === second.target &&
    first.bubbles === second.bubbles &&
    first.cancelable === second.cancelable &&
    first.composed === second.composed &&
    second.defaultPrevented === expectedDefaultPrevented &&
    second.cancelBubble === expectedCancelBubble &&
    first.trusted === second.trusted &&
    first.view === second.view &&
    first.detail === second.detail &&
    first.key === second.key &&
    first.code === second.code &&
    first.location === second.location &&
    first.repeat === second.repeat &&
    first.composing === second.composing &&
    first.altKey === second.altKey &&
    first.ctrlKey === second.ctrlKey &&
    first.metaKey === second.metaKey &&
    first.shiftKey === second.shiftKey &&
    first.path.length === second.path.length &&
    first.path.every((entry, index) => entry === second.path[index])
  );
}

function readRequestModeReactKeyboardMethods(
  event: RequestModeReactKeyboardEvent,
): Readonly<
  Record<RequestModeReactKeyboardMethodName, RequestModeReactKeyboardMethod>
> | null {
  try {
    const preventDefault = event.preventDefault;
    const isDefaultPrevented = event.isDefaultPrevented;
    const isPropagationStopped = event.isPropagationStopped;
    return isRequestModeReactKeyboardMethod(preventDefault) &&
      isRequestModeReactKeyboardMethod(isDefaultPrevented) &&
      isRequestModeReactKeyboardMethod(isPropagationStopped)
      ? Object.freeze({
          preventDefault,
          isDefaultPrevented,
          isPropagationStopped,
        })
      : null;
  } catch {
    return null;
  }
}

function readRequestModeReactKeyboardFacts(
  event: KeyboardEvent<HTMLButtonElement>,
): RequestModeReactKeyboardFacts | null {
  try {
    const proof = event as KeyboardEvent<HTMLButtonElement> &
      RequestModeReactKeyboardEvent;
    const composing = proof.isComposing;
    return Object.freeze({
      nativeEvent: event.nativeEvent,
      type: event.type,
      target: event.target,
      currentTarget: event.currentTarget,
      phase: event.eventPhase,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      defaultPrevented: event.defaultPrevented,
      trusted: event.isTrusted,
      view: event.view,
      detail: event.detail,
      key: event.key,
      code: event.code,
      location: event.location,
      repeat: event.repeat,
      composing:
        composing === undefined ? undefined : Boolean(composing),
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    });
  } catch {
    return null;
  }
}

function requestModeReactKeyboardSnapshotIsCurrent(
  snapshot: RequestModeReactKeyboardSnapshot,
  nativeFacts: RequestModeNativeKeyboardFacts,
  source: HTMLButtonElement,
  expectedPhase: number,
  expectedDefaultPrevented: boolean,
  expectedMethods: Readonly<
    Record<RequestModeReactKeyboardMethodName, RequestModeReactKeyboardMethod>
  >,
) {
  const current = readRequestModeReactKeyboardFacts(snapshot.event);
  const methods = readRequestModeReactKeyboardMethods(
    snapshot.event as KeyboardEvent<HTMLButtonElement> &
      RequestModeReactKeyboardEvent,
  );
  const initial = snapshot.publicFacts;
  return Boolean(
    current &&
      methods &&
      current.nativeEvent === initial.nativeEvent &&
      current.type === initial.type &&
      current.type === nativeFacts.type &&
      current.type === "keydown" &&
      current.target === initial.target &&
      current.target === source &&
      current.currentTarget === initial.currentTarget &&
      current.currentTarget === source &&
      current.phase === initial.phase &&
      current.phase === nativeFacts.phase &&
      current.phase === expectedPhase &&
      current.bubbles === initial.bubbles &&
      current.bubbles === nativeFacts.bubbles &&
      current.cancelable === initial.cancelable &&
      current.cancelable === nativeFacts.cancelable &&
      initial.defaultPrevented === false &&
      current.defaultPrevented === expectedDefaultPrevented &&
      nativeFacts.defaultPrevented === expectedDefaultPrevented &&
      current.trusted === initial.trusted &&
      current.trusted === nativeFacts.trusted &&
      Object.is(current.view, initial.view) &&
      Object.is(current.view, nativeFacts.view) &&
      current.detail === initial.detail &&
      current.detail === nativeFacts.detail &&
      current.key === initial.key &&
      current.key === nativeFacts.key &&
      current.code === initial.code &&
      current.code === nativeFacts.code &&
      current.location === initial.location &&
      current.location === nativeFacts.location &&
      current.repeat === initial.repeat &&
      current.repeat === nativeFacts.repeat &&
      current.composing === initial.composing &&
      (current.composing === undefined ||
        current.composing === nativeFacts.composing) &&
      current.altKey === initial.altKey &&
      current.altKey === nativeFacts.altKey &&
      current.ctrlKey === initial.ctrlKey &&
      current.ctrlKey === nativeFacts.ctrlKey &&
      current.metaKey === initial.metaKey &&
      current.metaKey === nativeFacts.metaKey &&
      current.shiftKey === initial.shiftKey &&
      current.shiftKey === nativeFacts.shiftKey &&
      methods.preventDefault === expectedMethods.preventDefault &&
      methods.isDefaultPrevented ===
        expectedMethods.isDefaultPrevented &&
      methods.isPropagationStopped ===
        expectedMethods.isPropagationStopped
  );
}

function requestModeReactKeyboardMethodsAreCurrent(
  snapshot: RequestModeReactKeyboardSnapshot,
  expectedMethods: Readonly<
    Record<RequestModeReactKeyboardMethodName, RequestModeReactKeyboardMethod>
  > = snapshot.methods,
) {
  const methods = readRequestModeReactKeyboardMethods(
    snapshot.event as KeyboardEvent<HTMLButtonElement> &
      RequestModeReactKeyboardEvent,
  );
  return Boolean(
    methods &&
      methods.preventDefault === expectedMethods.preventDefault &&
      methods.isDefaultPrevented ===
        expectedMethods.isDefaultPrevented &&
      methods.isPropagationStopped ===
        expectedMethods.isPropagationStopped,
  );
}

function captureRequestModeReactKeyboardEvent(
  event: KeyboardEvent<HTMLButtonElement>,
  nativeEvent: Event,
  nativeFacts: RequestModeNativeKeyboardFacts,
  source: HTMLButtonElement,
  expectedPhase: number,
): RequestModeReactKeyboardSnapshot | null {
  const publicFacts = readRequestModeReactKeyboardFacts(event);
  const methods = readRequestModeReactKeyboardMethods(
    event as KeyboardEvent<HTMLButtonElement> &
      RequestModeReactKeyboardEvent,
  );
  if (!publicFacts || !methods) return null;
  const snapshot = Object.freeze({
    event,
    publicFacts,
    nativeFacts,
    methods: Object.freeze({ ...methods }),
  });
  return publicFacts.nativeEvent === nativeEvent &&
    requestModeReactKeyboardSnapshotIsCurrent(
      snapshot,
      nativeFacts,
      source,
      expectedPhase,
      false,
      snapshot.methods,
    )
    ? snapshot
    : null;
}

function requestModeNativeKeyboardIsEligible(
  publication: RequestModePublication,
  source: HTMLButtonElement,
  facts: RequestModeNativeKeyboardFacts,
  expectedPhase: number,
  receiver: EventTarget,
  expectedDefaultPrevented = false,
) {
  const keyboard = publication.keyboard;
  const expectedPath = requestModeEventPath(
    source,
    publication.ownerDocument,
  );
  const terminal = facts.path.at(-1);
  return Boolean(
    expectedPath &&
      terminal &&
      keyboard.requestModeIsCurrent() &&
      publication.ownerDocument.defaultView === publication.ownerWindow &&
      facts.type === "keydown" &&
      isRequestModeNavigationKey(facts.key) &&
      facts.phase === expectedPhase &&
      facts.bubbles &&
      facts.cancelable &&
      facts.defaultPrevented === expectedDefaultPrevented &&
      !facts.cancelBubble &&
      facts.detail === 0 &&
      facts.location ===
        publication.ownerWindow.KeyboardEvent.DOM_KEY_LOCATION_STANDARD &&
      !facts.repeat &&
      !facts.composing &&
      !facts.altKey &&
      !facts.ctrlKey &&
      !facts.metaKey &&
      !facts.shiftKey &&
      facts.target === source &&
      facts.currentTarget !== null &&
      facts.path.includes(facts.currentTarget) &&
      (facts.view === null ||
        facts.view === publication.ownerWindow ||
        facts.view === receiver) &&
      requestModePathMatches(facts.path, expectedPath, terminal),
  );
}

function requestModeKeyboardStageMatches(
  publication: RequestModePublication,
  stage: RequestModeKeyboardWindowStage,
  source: HTMLButtonElement,
  nativeEvent: Event,
  facts: RequestModeNativeKeyboardFacts,
  expectedDefaultPrevented = false,
) {
  const terminal = stage.facts.path.at(-1);
  const expectedPath = requestModeEventPath(
    source,
    publication.ownerDocument,
  );
  return Boolean(
    terminal &&
      expectedPath &&
      stage.nativeEvent === nativeEvent &&
      stage.source === source &&
      stage.receiver === stage.facts.currentTarget &&
      stage.receiver === terminal &&
      stage.facts.phase === publication.keyboard.Event.CAPTURING_PHASE &&
      stage.facts.target === source &&
      requestModePathMatches(stage.facts.path, expectedPath, terminal) &&
      facts.path.at(-1) === terminal &&
      requestModeNativeKeyboardFactsMatch(
        stage.facts,
        facts,
        expectedDefaultPrevented,
      ),
  );
}

function createRequestModeRuntime(
  authority: RequestModeAuthority,
  cells: RequestModeCells,
  root: HTMLDivElement,
  buttons: readonly HTMLButtonElement[],
  owners: readonly RequestModeElementOwnerView[],
  keyboard: RequestModeKeyboardAuthority,
): RequestModeRuntime {
  type Retirement = "element" | "layout" | "other";
  const placement = captureRequestModePlacement(root);
  if (!placement) throw new Error("Cannot publish request modes without committed placement");
  const tooltipAttributes = Object.freeze([
    "aria-describedby",
    "data-state",
    "data-radix-popper-*",
  ]);
  const dom = snapshotRequestModeDom(root, (node) =>
    buttons.includes(node as HTMLButtonElement) ? tooltipAttributes : [],
  );
  let retired = false;
  let retirement: Retirement | null = null;
  let established = false;
  let invalidReplay = false;
  let replayRefs: RequestModeRefReplay[] = [];
  let domGuard: RequestModeDomGuard | null = null;
  let keyboardCaptureReady = false;
  let keyboardStages: WeakMap<
    globalThis.KeyboardEvent,
    RequestModeKeyboardWindowStage
  > | null = new WeakMap();
  let keyboardPairs: WeakMap<
    globalThis.KeyboardEvent,
    RequestModeKeyboardPair
  > | null = new WeakMap();
  let keyboardRegistration: RequestModeKeyboardRegistration | null = null;
  const publishedDomMatches = () => {
    const clean = domGuard?.isClean() === true;
    const placementMatches = requestModePlacementMatches(root, placement);
    const domMatches = requestModeDomMatches(dom);
    return Boolean(
      domGuard &&
        clean &&
        root === dom.node &&
        root.isConnected &&
        placementMatches &&
        domMatches
    );
  };
  const retire = (reason: Retirement) => {
    if (retired) return false;
    retired = true;
    retirement = reason;
    keyboardCaptureReady = false;
    keyboardStages = null;
    keyboardPairs = null;
    keyboardRegistration?.remove();
    keyboardRegistration = null;
    cells.retired.add(publication);
    if (cells.active.current === publication) {
      cells.active.current = null;
      cells.successorOf.current = publication;
    }
    queueMicrotask(() => {
      if (cells.replay.current?.source !== publication) domGuard?.release();
    });
    return true;
  };
  const publication: RequestModePublication = Object.freeze({
    identity: Symbol("request-mode-publication"),
    authority,
    root,
    buttons,
    ownerDocument: root.ownerDocument,
    ownerWindow: root.ownerDocument.defaultView!,
    dom,
    placement,
    keyboard,
    retire: () => retire("other"),
    isRetired: () => retired,
    publishedDomMatches,
  });
  const refsHaveNoReplay = () =>
    !invalidReplay &&
    replayRefs.every(
      (entry) =>
        !entry.detached && !entry.reattached && entry.owner.element() === entry.element,
    );
  const refsHaveExactReplay = () =>
    !invalidReplay &&
    replayRefs.length > 0 &&
    replayRefs.every(
      (entry) =>
        entry.detached && entry.reattached && entry.owner.element() === entry.element,
    );
  const refsHaveRecoveredReplay = () => {
    let replayed = false;
    const recovered = replayRefs.every((entry) => {
      if (!entry.detached) {
        return !entry.reattached && entry.owner.element() === entry.element;
      }
      replayed = true;
      return entry.reattached && entry.owner.element() === entry.element;
    });
    return !invalidReplay && replayed && recovered;
  };
  const runtime: RequestModeRuntime = Object.freeze({
    publication,
    publish: () => {
      established = true;
      replayRefs = owners.map((owner) => {
        const element = owner.element();
        if (!element) throw new Error("Cannot publish request modes without every committed ref");
        return { owner, element, detached: false, reattached: false };
      });
      domGuard = createRequestModeDomGuard(
        root,
        placement,
        (record) =>
          record.type === "attributes" &&
          buttons.includes(record.target as HTMLButtonElement) &&
          Boolean(
            record.attributeName &&
              (tooltipAttributes.includes(record.attributeName) ||
                (tooltipAttributes.includes("data-radix-popper-*") &&
                  record.attributeName.startsWith("data-radix-popper-"))),
          ),
      );
      if (!domGuard || cells.retired.has(publication)) {
        domGuard?.release();
        return false;
      }
      const previous = cells.active.current;
      previous?.retire();
      cells.active.current = publication;
      cells.successorOf.current = null;
      cells.replay.current = null;
      return true;
    },
    retireForElement: () => {
      retire("element");
    },
    retireForLayout: () => {
      retire("layout");
    },
    noteRef: (
      owner: RequestModeElementOwnerView,
      element: Element | null,
      previous: Element | null,
    ) => {
      if (!established) return;
      const proof = replayRefs.find((entry) => entry.owner === owner);
      if (!proof) {
        invalidReplay = true;
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
      if (!retired && replayRefs.every((entry) => entry.owner.element() === entry.element)) {
        for (const entry of replayRefs) {
          entry.detached = false;
          entry.reattached = false;
        }
        invalidReplay = false;
      }
    },
    isRetired: () => retired,
    publishedDomMatches,
    isExactElementReplay: () =>
      retired &&
      retirement === "element" &&
      established &&
      refsHaveRecoveredReplay() &&
      publishedDomMatches(),
    isExactLayoutReplay: () =>
      retired &&
      retirement === "layout" &&
      established &&
      (refsHaveNoReplay() || refsHaveExactReplay()) &&
      publishedDomMatches(),
    replay: () =>
      domGuard
        ? Object.freeze({
            source: publication,
            dom,
            placement,
            historyIsClean: domGuard.isClean,
            release: domGuard.release,
          })
        : null,
    keyboardCaptureIsReady: () => keyboardCaptureReady,
    keyboardListenerIsCurrent: () =>
      keyboardRegistration?.isCurrent() === true,
    keyboardStage: (event: globalThis.KeyboardEvent) =>
      keyboardStages?.get(event) ?? null,
    pairKeyboard: (
      event: globalThis.KeyboardEvent,
      stage: RequestModeKeyboardWindowStage,
      pair: RequestModeKeyboardPair,
    ) => {
      const stages = keyboardStages;
      const pairs = keyboardPairs;
      if (
        !stages ||
        !pairs ||
        stages.get(event) !== stage ||
        pairs.has(event)
      ) {
        return false;
      }
      stages.delete(event);
      pairs.set(event, pair);
      return true;
    },
    keyboardPair: (event: globalThis.KeyboardEvent) =>
      keyboardPairs?.get(event) ?? null,
    consumeKeyboardPair: (
      event: globalThis.KeyboardEvent,
      pair: RequestModeKeyboardPair,
    ) => {
      const pairs = keyboardPairs;
      if (!pairs || pairs.get(event) !== pair) return false;
      return pairs.delete(event);
    },
  });
  const listenerOwnerWindow = publication.ownerWindow;
  function rememberRequestModeNative(
    this: EventTarget,
    nativeEvent: Event,
  ) {
    const stages = keyboardStages;
    const pairs = keyboardPairs;
    if (
      !keyboardCaptureReady ||
      !stages ||
      !pairs ||
      keyboardRegistration?.isCurrent() !== true ||
      retired ||
      !established ||
      cells.active.current !== publication ||
      cells.keyboardAttempt.current !== null ||
      cells.keyboardDelivery.current !== null
    ) {
      return;
    }
    const facts = readRequestModeNativeKeyboardFacts(
      nativeEvent,
      publication.keyboard,
    );
    const sourceIndex = facts
      ? publication.buttons.findIndex((button) => button === facts.target)
      : -1;
    const source = publication.buttons[sourceIndex];
    const row = publication.authority.rows[sourceIndex];
    const terminal = facts?.path.at(-1);
    if (
      !facts ||
      !source ||
      !row ||
      !terminal ||
      facts.currentTarget !== this ||
      terminal !== this ||
      (facts.view !== null &&
        facts.view !== listenerOwnerWindow &&
        facts.view !== this) ||
      stages.has(nativeEvent as globalThis.KeyboardEvent) ||
      pairs.has(nativeEvent as globalThis.KeyboardEvent) ||
      publication.buttons[row.index] !== source ||
      publication.authority.rows[row.index] !== row ||
      publication.keyboard.activeElement.read(publication.ownerDocument) !==
        source ||
      !requestModeNativeKeyboardIsEligible(
        publication,
        source,
        facts,
        publication.keyboard.Event.CAPTURING_PHASE,
        this,
      ) ||
      !requestModeFactsAreCurrent(publication.authority) ||
      !publication.publishedDomMatches()
    ) {
      return;
    }
    stages.set(
      nativeEvent as globalThis.KeyboardEvent,
      Object.freeze({
        nativeEvent: nativeEvent as globalThis.KeyboardEvent,
        receiver: this,
        facts,
        source,
        row,
      }),
    );
  }
  const registration = keyboard.registerRequestMode(
    rememberRequestModeNative,
  );
  if (registration) {
    keyboardRegistration = registration;
    keyboardCaptureReady = true;
  } else {
    keyboardStages = null;
    keyboardPairs = null;
  }
  return runtime;
}

function requestModeReplayAllowsPublication(
  cells: RequestModeCells,
  authority: RequestModeAuthority,
  root: HTMLDivElement,
) {
  const replay = cells.replay.current;
  if (!replay) return true;
  const sameAuthority = requestModeAuthoritiesMatch(
    replay.source.authority,
    authority,
    false,
  );
  const exactReplay =
    sameAuthority &&
    cells.successorOf.current === replay.source &&
    cells.retired.has(replay.source) &&
    !cells.claimedPublications.has(replay.source) &&
    replay.historyIsClean() &&
    root === replay.dom.node &&
    requestModePlacementMatches(root, replay.placement) &&
    requestModeDomMatches(replay.dom);
  cells.replay.current = null;
  if (cells.successorOf.current === replay.source) cells.successorOf.current = null;
  replay.release();
  return !sameAuthority || exactReplay;
}

function createRequestModePresentation(
  authority: RequestModeAuthority,
  cells: RequestModeCells,
): RequestModePresentation {
  let currentRuntime: RequestModeRuntime | null = null;
  let lastRuntime: RequestModeRuntime | null = null;
  let successorRequested = false;
  const acceptsSuccessorOf = (publication: RequestModePublication) =>
    cells.active.current === null &&
    cells.successorOf.current === publication &&
    cells.retired.has(publication) &&
    !cells.claimedPublications.has(publication);
  const onElementChange = (
    owner: RequestModeElementOwnerView,
    element: Element | null,
    previous: Element | null,
    last: Element | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null || (element !== null && last !== null && element !== last)) {
      currentRuntime?.retireForElement();
      currentRuntime = null;
    }
    if (runtime?.isExactElementReplay() && acceptsSuccessorOf(runtime.publication)) {
      requestReplaySuccessor(runtime);
    }
  };
  const rootOwner = new RequestModeElementOwner<HTMLDivElement>(onElementChange);
  const rowPresentations = authority.rows.map((row) => {
    const buttonOwner = new RequestModeElementOwner<HTMLButtonElement>(onElementChange);
    const action: RequestModeKeyboardAction = Object.freeze({
      identity: Symbol(`request-mode-${row.id}-keyboard-action`),
      row,
    });
    const onKeyDownCapture = (event: KeyboardEvent<HTMLButtonElement>) => {
      stageRequestModeKey(row, buttonOwner, action, event);
    };
    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
      completeRequestModeKey(row, buttonOwner, action, event);
    };
    return Object.freeze({
      authority: row,
      captureButton: buttonOwner.capture,
      buttonOwner,
      onKeyDownCapture,
      onKeyDown,
    });
  });
  const requestModeAttemptIsCurrent = ({
    runtime,
    publication,
    stage,
    action,
    sourceRow,
    source,
    destinationRow,
    destination,
    nativeEvent,
    nativeFacts,
    react,
    methods,
    expectedPhase,
    expectedDefaultPrevented,
    storeIsCurrent,
    capture,
    claimed,
    expectedActive = source,
  }: {
    runtime: RequestModeRuntime;
    publication: RequestModePublication;
    stage: RequestModeKeyboardWindowStage;
    action: RequestModeKeyboardAction;
    sourceRow: RequestModeRowAuthority;
    source: HTMLButtonElement;
    destinationRow: RequestModeRowAuthority;
    destination: HTMLButtonElement;
    nativeEvent: globalThis.KeyboardEvent;
    nativeFacts: RequestModeNativeKeyboardFacts;
    react: RequestModeReactKeyboardSnapshot;
    methods: Readonly<
      Record<RequestModeReactKeyboardMethodName, RequestModeReactKeyboardMethod>
    >;
    expectedPhase: number;
    expectedDefaultPrevented: boolean;
    storeIsCurrent: () => boolean;
    capture?: RequestModeReactKeyboardSnapshot;
    claimed: boolean;
    expectedActive?: Element;
  }) => {
    const keyboard = publication.keyboard;
    const currentNativeFacts = readRequestModeNativeKeyboardFacts(
      nativeEvent,
      keyboard,
    );
    const sourcePresentation = rowPresentations[sourceRow.index];
    const destinationPresentation = rowPresentations[destinationRow.index];
    const currentElements = currentRequestModeElements(
      authority,
      rootOwner,
      rowPresentations,
    );
    return Boolean(
      currentNativeFacts &&
        runtime.keyboardCaptureIsReady() &&
        runtime.keyboardListenerIsCurrent() &&
        !runtime.isRetired() &&
        !publication.isRetired() &&
        !cells.retired.has(publication) &&
        cells.active.current === publication &&
        publication.authority === authority &&
        requestModeAuthoritiesMatch(publication.authority, authority) &&
        cells.keyboardAttempt.current === nativeEvent &&
        (claimed
          ? cells.keyboardDelivery.current === publication.identity &&
            cells.claimedPublications.has(publication) &&
            cells.claimedActions.has(action) &&
            cells.claimedReactEvents.has(capture?.event ?? react.event) &&
            cells.claimedReactEvents.has(react.event) &&
            cells.claimedNativeEvents.has(nativeEvent) &&
            cells.claimedWindowStages.has(stage) &&
            claimedRequestModeReactEvents.has(
              capture?.event ?? react.event,
            ) &&
            claimedRequestModeReactEvents.has(react.event) &&
            claimedRequestModeNativeEvents.has(nativeEvent)
          : cells.keyboardDelivery.current === null &&
            !cells.claimedPublications.has(publication) &&
            !cells.claimedActions.has(action) &&
            !cells.claimedReactEvents.has(capture?.event ?? react.event) &&
            !cells.claimedReactEvents.has(react.event) &&
            !cells.claimedNativeEvents.has(nativeEvent) &&
            !cells.claimedWindowStages.has(stage) &&
            !claimedRequestModeReactEvents.has(
              capture?.event ?? react.event,
            ) &&
            !claimedRequestModeReactEvents.has(react.event) &&
            !claimedRequestModeNativeEvents.has(nativeEvent)) &&
        action.row === sourceRow &&
        authority.rows[sourceRow.index] === sourceRow &&
        authority.rows[destinationRow.index] === destinationRow &&
        publication.buttons[sourceRow.index] === source &&
        publication.buttons[destinationRow.index] === destination &&
        sourcePresentation?.authority === sourceRow &&
        sourcePresentation.buttonOwner.element() === source &&
        destinationPresentation?.authority === destinationRow &&
        destinationPresentation.buttonOwner.element() === destination &&
        currentElements?.root === publication.root &&
        currentElements.buttons.length === publication.buttons.length &&
        currentElements.buttons.every(
          (button, index) => publication.buttons[index] === button,
        ) &&
        isRequestModeNavigationKey(currentNativeFacts.key) &&
        requestModeDestination(
          currentNativeFacts.key,
          sourceRow.index,
          authority.rows.length,
        ) === destinationRow.index &&
        currentNativeFacts.key === nativeFacts.key &&
        keyboard.activeElement.read(publication.ownerDocument) ===
          expectedActive &&
        react.publicFacts.nativeEvent === nativeEvent &&
        react.publicFacts.target === source &&
        react.publicFacts.currentTarget === source &&
        requestModeReactKeyboardSnapshotIsCurrent(
          react,
          currentNativeFacts,
          source,
          expectedPhase,
          expectedDefaultPrevented,
          methods,
        ) &&
        (!capture || requestModeReactKeyboardMethodsAreCurrent(capture)) &&
        requestModeNativeKeyboardIsEligible(
          publication,
          source,
          currentNativeFacts,
          expectedPhase,
          stage.receiver,
          expectedDefaultPrevented,
        ) &&
        requestModeKeyboardStageMatches(
          publication,
          stage,
          source,
          nativeEvent,
          currentNativeFacts,
          expectedDefaultPrevented,
        ) &&
        requestModeNativeKeyboardFactsMatch(
          nativeFacts,
          currentNativeFacts,
          expectedDefaultPrevented,
        ) &&
        stage.nativeEvent === nativeEvent &&
        stage.row === sourceRow &&
        stage.source === source &&
        storeIsCurrent() &&
        requestModeFactsAreCurrent(authority) &&
        publication.publishedDomMatches(),
    );
  };
  function stageRequestModeKey(
    row: RequestModeRowAuthority,
    buttonOwner: RequestModeElementOwner<HTMLButtonElement>,
    action: RequestModeKeyboardAction,
    event: KeyboardEvent<HTMLButtonElement>,
  ) {
    if (!event || typeof event !== "object") return;
    let carried: unknown;
    try {
      carried = event.nativeEvent;
    } catch {
      return;
    }
    if (
      !carried ||
      typeof carried !== "object" ||
      cells.claimedReactEvents.has(event) ||
      cells.claimedNativeEvents.has(carried as Event) ||
      claimedRequestModeReactEvents.has(event) ||
      claimedRequestModeNativeEvents.has(carried as Event) ||
      cells.keyboardAttempt.current !== null ||
      cells.keyboardDelivery.current !== null
    ) {
      return;
    }
    cells.keyboardAttempt.current = carried;
    try {
      const runtime = currentRuntime;
      const publication = runtime?.publication;
      const source = buttonOwner.element();
      const nativeEvent = carried as globalThis.KeyboardEvent;
      const stage = runtime?.keyboardStage(nativeEvent);
      const keyboard = publication?.keyboard;
      if (
        !runtime ||
        !publication ||
        !source ||
        !stage ||
        !keyboard ||
        stage.source !== source ||
        stage.row !== row ||
        action.row !== row ||
        runtime.keyboardPair(nativeEvent) !== null ||
        cells.active.current !== publication ||
        publication.authority !== authority ||
        publication.buttons[row.index] !== source ||
        authority.rows[row.index] !== row ||
        !requestModeFactsAreCurrent(authority) ||
        !publication.publishedDomMatches()
      ) {
        return;
      }
      const nativeFacts = readRequestModeNativeKeyboardFacts(
        nativeEvent,
        keyboard,
      );
      const destinationIndex =
        nativeFacts && isRequestModeNavigationKey(nativeFacts.key)
          ? requestModeDestination(
              nativeFacts.key,
              row.index,
              authority.rows.length,
            )
          : null;
      const destinationRow =
        destinationIndex === null ? null : authority.rows[destinationIndex];
      const destinationPresentation =
        destinationIndex === null
          ? null
          : rowPresentations[destinationIndex];
      const destination = destinationPresentation?.buttonOwner.element();
      const capture = nativeFacts
        ? captureRequestModeReactKeyboardEvent(
            event,
            nativeEvent,
            nativeFacts,
            source,
            keyboard.Event.CAPTURING_PHASE,
          )
        : null;
      if (
        !nativeFacts ||
        !destinationRow ||
        !destinationPresentation ||
        destinationPresentation.authority !== destinationRow ||
        !destination ||
        !capture ||
        !requestModeAttemptIsCurrent({
          runtime,
          publication,
          stage,
          action,
          sourceRow: row,
          source,
          destinationRow,
          destination,
          nativeEvent,
          nativeFacts,
          react: capture,
          methods: capture.methods,
          expectedPhase: keyboard.Event.CAPTURING_PHASE,
          expectedDefaultPrevented: false,
          storeIsCurrent: () =>
            runtime.keyboardStage(nativeEvent) === stage &&
            runtime.keyboardPair(nativeEvent) === null,
          claimed: false,
        })
      ) {
        return;
      }
      const defaultPrevented = keyboard.applyMethod(
        capture.methods.isDefaultPrevented,
        capture.event,
      );
      if (
        !defaultPrevented.called ||
        defaultPrevented.value !== false ||
        !requestModeAttemptIsCurrent({
          runtime,
          publication,
          stage,
          action,
          sourceRow: row,
          source,
          destinationRow,
          destination,
          nativeEvent,
          nativeFacts,
          react: capture,
          methods: capture.methods,
          expectedPhase: keyboard.Event.CAPTURING_PHASE,
          expectedDefaultPrevented: false,
          storeIsCurrent: () =>
            runtime.keyboardStage(nativeEvent) === stage &&
            runtime.keyboardPair(nativeEvent) === null,
          claimed: false,
        })
      ) {
        return;
      }
      const propagationStopped = keyboard.applyMethod(
        capture.methods.isPropagationStopped,
        capture.event,
      );
      if (
        !propagationStopped.called ||
        propagationStopped.value !== false ||
        !requestModeAttemptIsCurrent({
          runtime,
          publication,
          stage,
          action,
          sourceRow: row,
          source,
          destinationRow,
          destination,
          nativeEvent,
          nativeFacts,
          react: capture,
          methods: capture.methods,
          expectedPhase: keyboard.Event.CAPTURING_PHASE,
          expectedDefaultPrevented: false,
          storeIsCurrent: () =>
            runtime.keyboardStage(nativeEvent) === stage &&
            runtime.keyboardPair(nativeEvent) === null,
          claimed: false,
        })
      ) {
        return;
      }
      const pair: RequestModeKeyboardPair = Object.freeze({
        publication,
        action,
        nativeEvent,
        stage,
        capture,
        sourceRow: row,
        source,
        destinationRow,
        destination,
        key: nativeFacts.key as RequestModeNavigationKey,
      });
      runtime.pairKeyboard(nativeEvent, stage, pair);
    } finally {
      if (cells.keyboardAttempt.current === carried) {
        cells.keyboardAttempt.current = null;
      }
    }
  }
  function completeRequestModeKey(
    row: RequestModeRowAuthority,
    buttonOwner: RequestModeElementOwner<HTMLButtonElement>,
    action: RequestModeKeyboardAction,
    event: KeyboardEvent<HTMLButtonElement>,
  ) {
    if (!event || typeof event !== "object") return;
    let carried: unknown;
    try {
      carried = event.nativeEvent;
    } catch {
      return;
    }
    if (
      !carried ||
      typeof carried !== "object" ||
      cells.claimedReactEvents.has(event) ||
      cells.claimedNativeEvents.has(carried as Event) ||
      claimedRequestModeReactEvents.has(event) ||
      claimedRequestModeNativeEvents.has(carried as Event) ||
      cells.keyboardAttempt.current !== null ||
      cells.keyboardDelivery.current !== null
    ) {
      return;
    }
    cells.keyboardAttempt.current = carried;
    try {
      const runtime = currentRuntime;
      const publication = runtime?.publication;
      const nativeEvent = carried as globalThis.KeyboardEvent;
      const pair = runtime?.keyboardPair(nativeEvent);
      const source = buttonOwner.element();
      const keyboard = publication?.keyboard;
      if (
        !runtime ||
        !publication ||
        !pair ||
        !source ||
        !keyboard ||
        pair.publication !== publication ||
        pair.action !== action ||
        pair.sourceRow !== row ||
        pair.source !== source ||
        pair.nativeEvent !== nativeEvent ||
        pair.capture.publicFacts.nativeEvent !== nativeEvent ||
        pair.capture.event === event ||
        cells.active.current !== publication ||
        publication.authority !== authority ||
        publication.buttons[row.index] !== source ||
        authority.rows[row.index] !== row ||
        !requestModeFactsAreCurrent(authority) ||
        !publication.publishedDomMatches()
      ) {
        return;
      }
      const nativeFacts = readRequestModeNativeKeyboardFacts(
        nativeEvent,
        keyboard,
      );
      const bubble = nativeFacts
        ? captureRequestModeReactKeyboardEvent(
            event,
            nativeEvent,
            nativeFacts,
            source,
            keyboard.Event.BUBBLING_PHASE,
          )
        : null;
      const destinationIndex =
        nativeFacts && isRequestModeNavigationKey(nativeFacts.key)
          ? requestModeDestination(
              nativeFacts.key,
              row.index,
              authority.rows.length,
            )
          : null;
      const destinationRow =
        destinationIndex === null ? null : authority.rows[destinationIndex];
      const destinationPresentation =
        destinationIndex === null
          ? null
          : rowPresentations[destinationIndex];
      const destination = destinationPresentation?.buttonOwner.element();
      if (
        !nativeFacts ||
        !bubble ||
        !destinationRow ||
        !destinationPresentation ||
        destinationPresentation.authority !== destinationRow ||
        !destination ||
        destinationRow !== pair.destinationRow ||
        destination !== pair.destination ||
        nativeFacts.key !== pair.key ||
        pair.capture.publicFacts.target !== bubble.publicFacts.target ||
        pair.capture.publicFacts.currentTarget !==
          bubble.publicFacts.currentTarget ||
        pair.capture.publicFacts.phase !== keyboard.Event.CAPTURING_PHASE ||
        bubble.publicFacts.phase !== keyboard.Event.BUBBLING_PHASE ||
        !requestModeAttemptIsCurrent({
          runtime,
          publication,
          stage: pair.stage,
          action,
          sourceRow: row,
          source,
          destinationRow,
          destination,
          nativeEvent,
          nativeFacts,
          react: bubble,
          methods: bubble.methods,
          expectedPhase: keyboard.Event.BUBBLING_PHASE,
          expectedDefaultPrevented: false,
          storeIsCurrent: () => runtime.keyboardPair(nativeEvent) === pair,
          capture: pair.capture,
          claimed: false,
        })
      ) {
        return;
      }
      const defaultPrevented = keyboard.applyMethod(
        bubble.methods.isDefaultPrevented,
        bubble.event,
      );
      if (
        !defaultPrevented.called ||
        defaultPrevented.value !== false ||
        !requestModeAttemptIsCurrent({
          runtime,
          publication,
          stage: pair.stage,
          action,
          sourceRow: row,
          source,
          destinationRow,
          destination,
          nativeEvent,
          nativeFacts,
          react: bubble,
          methods: bubble.methods,
          expectedPhase: keyboard.Event.BUBBLING_PHASE,
          expectedDefaultPrevented: false,
          storeIsCurrent: () => runtime.keyboardPair(nativeEvent) === pair,
          capture: pair.capture,
          claimed: false,
        })
      ) {
        return;
      }
      const propagationStopped = keyboard.applyMethod(
        bubble.methods.isPropagationStopped,
        bubble.event,
      );
      if (
        !propagationStopped.called ||
        propagationStopped.value !== false ||
        !requestModeAttemptIsCurrent({
          runtime,
          publication,
          stage: pair.stage,
          action,
          sourceRow: row,
          source,
          destinationRow,
          destination,
          nativeEvent,
          nativeFacts,
          react: bubble,
          methods: bubble.methods,
          expectedPhase: keyboard.Event.BUBBLING_PHASE,
          expectedDefaultPrevented: false,
          storeIsCurrent: () => runtime.keyboardPair(nativeEvent) === pair,
          capture: pair.capture,
          claimed: false,
        })
      ) {
        return;
      }
      if (
        cells.claimedPublications.has(publication) ||
        cells.claimedActions.has(action) ||
        cells.claimedReactEvents.has(pair.capture.event) ||
        cells.claimedReactEvents.has(event) ||
        cells.claimedNativeEvents.has(nativeEvent) ||
        cells.claimedWindowStages.has(pair.stage) ||
        claimedRequestModeReactEvents.has(pair.capture.event) ||
        claimedRequestModeReactEvents.has(event) ||
        claimedRequestModeNativeEvents.has(nativeEvent) ||
        !runtime.consumeKeyboardPair(nativeEvent, pair)
      ) {
        return;
      }
      cells.claimedPublications.add(publication);
      cells.claimedActions.add(action);
      cells.claimedReactEvents.add(pair.capture.event);
      cells.claimedReactEvents.add(event);
      cells.claimedNativeEvents.add(nativeEvent);
      cells.claimedWindowStages.add(pair.stage);
      claimedRequestModeReactEvents.add(pair.capture.event);
      claimedRequestModeReactEvents.add(event);
      claimedRequestModeNativeEvents.add(nativeEvent);
      cells.keyboardDelivery.current = publication.identity;
      try {
        if (
          !requestModeAttemptIsCurrent({
            runtime,
            publication,
            stage: pair.stage,
            action,
            sourceRow: row,
            source,
            destinationRow,
            destination,
            nativeEvent,
            nativeFacts,
            react: bubble,
            methods: bubble.methods,
            expectedPhase: keyboard.Event.BUBBLING_PHASE,
            expectedDefaultPrevented: false,
            storeIsCurrent: () =>
              runtime.keyboardPair(nativeEvent) === null,
            capture: pair.capture,
            claimed: true,
          })
        ) {
          return;
        }
        const prevented = keyboard.applyMethod(
          bubble.methods.preventDefault,
          bubble.event,
        );
        if (!prevented.called) return;
        const postPreventionMethods =
          readRequestModeReactKeyboardMethods(
            bubble.event as KeyboardEvent<HTMLButtonElement> &
              RequestModeReactKeyboardEvent,
          );
        if (
          !postPreventionMethods ||
          postPreventionMethods.preventDefault !==
            bubble.methods.preventDefault ||
          postPreventionMethods.isPropagationStopped !==
            bubble.methods.isPropagationStopped ||
          !requestModeAttemptIsCurrent({
            runtime,
            publication,
            stage: pair.stage,
            action,
            sourceRow: row,
            source,
            destinationRow,
            destination,
            nativeEvent,
            nativeFacts,
            react: bubble,
            methods: postPreventionMethods,
            expectedPhase: keyboard.Event.BUBBLING_PHASE,
            expectedDefaultPrevented: true,
            storeIsCurrent: () =>
              runtime.keyboardPair(nativeEvent) === null,
            capture: pair.capture,
            claimed: true,
          })
        ) {
          return;
        }
        const defaultPreventedAfter = keyboard.applyMethod(
          postPreventionMethods.isDefaultPrevented,
          bubble.event,
        );
        if (
          !defaultPreventedAfter.called ||
          defaultPreventedAfter.value !== true ||
          !requestModeAttemptIsCurrent({
            runtime,
            publication,
            stage: pair.stage,
            action,
            sourceRow: row,
            source,
            destinationRow,
            destination,
            nativeEvent,
            nativeFacts,
            react: bubble,
            methods: postPreventionMethods,
            expectedPhase: keyboard.Event.BUBBLING_PHASE,
            expectedDefaultPrevented: true,
            storeIsCurrent: () =>
              runtime.keyboardPair(nativeEvent) === null,
            capture: pair.capture,
            claimed: true,
          })
        ) {
          return;
        }
        const propagationStoppedAfter = keyboard.applyMethod(
          postPreventionMethods.isPropagationStopped,
          bubble.event,
        );
        if (
          !propagationStoppedAfter.called ||
          propagationStoppedAfter.value !== false ||
          !requestModeAttemptIsCurrent({
            runtime,
            publication,
            stage: pair.stage,
            action,
            sourceRow: row,
            source,
            destinationRow,
            destination,
            nativeEvent,
            nativeFacts,
            react: bubble,
            methods: postPreventionMethods,
            expectedPhase: keyboard.Event.BUBBLING_PHASE,
            expectedDefaultPrevented: true,
            storeIsCurrent: () =>
              runtime.keyboardPair(nativeEvent) === null,
            capture: pair.capture,
            claimed: true,
          })
        ) {
          return;
        }
        keyboard.focus.invoke(destination, { preventScroll: true });
        if (
          keyboard.activeElement.read(publication.ownerDocument) !==
          destination
        ) {
          authority.requestSuccessor();
          return;
        }
        if (destinationRow.disabled) {
          return;
        } else {
          if (
            !requestModeAttemptIsCurrent({
              runtime,
              publication,
              stage: pair.stage,
              action,
              sourceRow: row,
              source,
              destinationRow,
              destination,
              nativeEvent,
              nativeFacts,
              react: bubble,
              methods: postPreventionMethods,
              expectedPhase: keyboard.Event.BUBBLING_PHASE,
              expectedDefaultPrevented: true,
              storeIsCurrent: () =>
                runtime.keyboardPair(nativeEvent) === null,
              capture: pair.capture,
              claimed: true,
              expectedActive: destination,
            })
          ) {
            authority.requestSuccessor();
            return;
          }
          authority.setMode(destinationRow.id);
          if (destinationRow.id === authority.effectiveMode) {
            authority.requestSuccessor();
          }
        }
      } finally {
        cells.claimedPublications.delete(publication);
        cells.claimedActions.delete(action);
        cells.claimedWindowStages.delete(pair.stage);
        if (cells.keyboardDelivery.current === publication.identity) {
          cells.keyboardDelivery.current = null;
        }
      }
    } finally {
      if (cells.keyboardAttempt.current === carried) {
        cells.keyboardAttempt.current = null;
      }
    }
  }
  const expectedOwners = () =>
    Object.freeze([
      rootOwner,
      ...rowPresentations.map((presentation) => presentation.buttonOwner),
    ]);
  const requestReplaySuccessor = (runtime: RequestModeRuntime) => {
    const replay = runtime.replay();
    if (
      successorRequested ||
      !replay ||
      !acceptsSuccessorOf(runtime.publication) ||
      !requestModeFactsAreCurrent(authority) ||
      !runtime.publishedDomMatches()
    ) {
      return;
    }
    cells.replay.current = replay;
    successorRequested = true;
    authority.requestSuccessor();
  };
  const establish = () => {
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() || lastRuntime.isExactElementReplay()) &&
        acceptsSuccessorOf(lastRuntime.publication)
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (!requestModeFactsAreCurrent(authority)) return undefined;
    const elements = currentRequestModeElements(authority, rootOwner, rowPresentations);
    const ownerWindow = elements?.root.ownerDocument.defaultView;
    const keyboard =
      elements && ownerWindow
        ? captureRequestModeKeyboardAuthority(elements.root.ownerDocument, ownerWindow)
        : null;
    if (
      !elements ||
      !ownerWindow ||
      !keyboard ||
      !requestModeReplayAllowsPublication(cells, authority, elements.root)
    ) {
      return undefined;
    }
    const runtime = createRequestModeRuntime(
      authority,
      cells,
      elements.root,
      elements.buttons,
      expectedOwners(),
      keyboard,
    );
    currentRuntime = runtime;
    lastRuntime = runtime;
    if (!runtime.publish()) {
      runtime.retireForElement();
      currentRuntime = null;
      return undefined;
    }
    return runtime.retireForLayout;
  };
  return Object.freeze({
    captureRoot: rootOwner.capture,
    rows: Object.freeze(rowPresentations),
    establish,
  });
}

function createMentionCells(): MentionCells {
  const active: MentionCells["active"] = { current: null };
  return {
    active,
    retired: new WeakSet(),
    claimedPublications: new WeakSet(),
    claimedActions: new WeakSet(),
    claimedReactEvents: new WeakSet(),
    claimedNativeEvents: new WeakSet(),
    retireForElement: (element, expected) => {
      const publication = active.current;
      if (publication && expected !== element) publication.retire();
    },
  };
}

function mentionDestination(
  key: MentionNavigationKey,
  current: number,
  count: number,
) {
  if (current < 0 || current >= count || count === 0) return null;
  if (key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowUp") return (current - 1 + count) % count;
  if (key === "Home") return current === 0 ? null : 0;
  return current === count - 1 ? null : count - 1;
}

function mentionRowMatches(
  row: MentionRowAuthority,
  candidate: MentionCandidate,
  index: number,
  highlight: number,
  listId: string,
) {
  return (
    row.index === index &&
    row.candidate === candidate &&
    row.login === candidate.login &&
    row.name === candidate.name &&
    row.image === candidate.image &&
    row.own === Boolean(candidate.own) &&
    row.agent === (candidate.agent ?? null) &&
    row.ownerLogin === (candidate.agent?.ownerLogin ?? null) &&
    row.ownerName === (candidate.agent?.ownerName ?? null) &&
    row.canAsk === (candidate.agent?.canAsk ?? null) &&
    row.highlighted === (index === highlight) &&
    row.optionId === `${listId}-option-${index}`
  );
}

function mentionFactsAreCurrent(
  publication: Pick<
    MentionPublication,
    "authority" | "visit" | "root" | "textarea" | "list" | "rowElements"
  >,
) {
  const { authority, visit, root, textarea, list, rowElements } = publication;
  if (
    authority.currentVisit() !== visit ||
    visit.retired ||
    authority.currentSubmission() !== null ||
    authority.busy ||
    authority.currentRoot() !== root ||
    authority.currentTextarea() !== textarea ||
    authority.currentList() !== list
  ) {
    return false;
  }
  const currentRows = authority.currentRows();
  if (
    currentRows.length < authority.rows.length ||
    rowElements.some((row, index) => currentRows[index] !== row)
  ) {
    return false;
  }
  const selectionStart = textarea.selectionStart;
  const selectionEnd = textarea.selectionEnd;
  const trigger =
    selectionStart === selectionEnd
      ? mentionTriggerAt(textarea.value, selectionStart)
      : null;
  const matches = trigger
    ? filterMentionCandidates(
        authority.candidates,
        trigger.query,
        MAX_SUGGESTIONS,
      )
    : [];
  return (
    textarea.value === authority.value &&
    trigger?.start === authority.trigger.start &&
    trigger.query === authority.trigger.query &&
    matches.length === authority.rows.length &&
    matches.every((candidate, index) => {
      const row = authority.rows[index];
      return Boolean(
        row &&
          mentionRowMatches(
            row,
            candidate,
            index,
            authority.highlight,
            authority.listId,
          ),
      );
    })
  );
}

function mentionDomIsExact(publication: MentionPublication) {
  const {
    authority,
    root,
    textarea,
    list,
    rowElements,
    ownerDocument,
    dom,
  } = publication;
  if (
    !dom.isClean() ||
    !requestModePlacementMatches(textarea, dom.textareaPlacement) ||
    !requestModePlacementMatches(list, dom.listPlacement) ||
    !requestModeDomMatches(dom.textarea) ||
    !requestModeDomMatches(dom.list) ||
    !root.isConnected ||
    !textarea.isConnected ||
    !list.isConnected ||
    root.ownerDocument !== ownerDocument ||
    textarea.ownerDocument !== ownerDocument ||
    list.ownerDocument !== ownerDocument ||
    !root.contains(textarea) ||
    textarea.tagName !== "TEXTAREA" ||
    textarea.disabled ||
    textarea.getAttribute("role") !== "combobox" ||
    textarea.getAttribute("aria-autocomplete") !== "list" ||
    textarea.getAttribute("aria-expanded") !== "true" ||
    textarea.getAttribute("aria-controls") !== authority.listId ||
    textarea.getAttribute("aria-activedescendant") !==
      authority.rows[authority.highlight]?.optionId ||
    list.tagName !== "UL" ||
    list.id !== authority.listId ||
    list.getAttribute("role") !== "listbox" ||
    list.getAttribute("aria-label") !== "Mention someone" ||
    list.childNodes.length !== authority.rows.length ||
    list.children.length !== authority.rows.length ||
    rowElements.length !== authority.rows.length
  ) {
    return false;
  }
  return rowElements.every((element, index) => {
    const row = authority.rows[index];
    if (!row) return false;
    const locked = row.agent !== null && !row.canAsk;
    return (
      element.ownerDocument === ownerDocument &&
      element.isConnected &&
      element.tagName === "LI" &&
      element.parentElement === list &&
      list.childNodes.item(index) === element &&
      list.children.item(index) === element &&
      element.id === row.optionId &&
      element.getAttribute("role") === "option" &&
      element.getAttribute("aria-selected") === String(row.highlighted) &&
      element.getAttribute("aria-disabled") === (locked ? "true" : null) &&
      element.className ===
        cn(
          "menu-item py-1.5",
          row.highlighted && "bg-surface-3",
          locked && "text-ink-3",
        ) &&
      element.dataset.testid === "mention-option" &&
      element.dataset.login === row.login &&
      element.hasAttribute("data-agent") === (row.agent !== null) &&
      element.hasAttribute("data-own") === row.own &&
      element.hasAttribute("data-locked") === locked
    );
  });
}

function createMentionDomEvidence(
  textarea: HTMLTextAreaElement,
  list: HTMLUListElement,
): MentionDomEvidence | null {
  const textareaPlacement = captureRequestModePlacement(textarea);
  const listPlacement = captureRequestModePlacement(list);
  if (!textareaPlacement || !listPlacement) return null;
  const textareaGuard = createRequestModeDomGuard(
    textarea,
    textareaPlacement,
  );
  if (!textareaGuard) return null;
  const listGuard = createRequestModeDomGuard(list, listPlacement);
  if (!listGuard) {
    textareaGuard.release();
    return null;
  }
  return Object.freeze({
    textarea: snapshotRequestModeDom(textarea),
    list: snapshotRequestModeDom(list),
    textareaPlacement,
    listPlacement,
    isClean: () => textareaGuard.isClean() && listGuard.isClean(),
    release: () => {
      textareaGuard.release();
      listGuard.release();
    },
  });
}

function captureMentionKeyboardAuthority(
  keyboard: RequestModeKeyboardAuthority,
): MentionKeyboardAuthority | null {
  const ownerWindow = keyboard.ownerWindow;
  const charCode = captureRequestModeGetter<number>(
    ownerWindow,
    keyboard.KeyboardEvent.prototype,
    "charCode",
  );
  const keyCode = captureRequestModeGetter<number>(
    ownerWindow,
    keyboard.KeyboardEvent.prototype,
    "keyCode",
  );
  const which = captureRequestModeGetter<number>(
    ownerWindow,
    keyboard.KeyboardEvent.prototype,
    "which",
  );
  const locale = captureRequestModeGetter<unknown>(
    ownerWindow,
    keyboard.KeyboardEvent.prototype,
    "locale",
  );
  if (!charCode || !keyCode || !which) return null;
  return Object.freeze({
    keyboard,
    charCode,
    keyCode,
    which,
    locale,
    isCurrent: () =>
      keyboard.requestModeIsCurrent() &&
      charCode.isCurrent() &&
      keyCode.isCurrent() &&
      which.isCurrent() &&
      (!locale || locale.isCurrent()),
  });
}

function readMentionNativeFacts(
  event: object,
  authority: MentionKeyboardAuthority,
): MentionNativeFacts | null {
  const facts = readRequestModeNativeKeyboardFacts(event, authority.keyboard);
  if (!facts || !authority.isCurrent()) return null;
  try {
    return Object.freeze({
      ...facts,
      charCode: authority.charCode!.read(event),
      keyCode: authority.keyCode!.read(event),
      which: authority.which!.read(event),
      locale: authority.locale?.read(event),
    });
  } catch {
    return null;
  }
}

function mentionNativeFactsMatch(
  first: MentionNativeFacts,
  second: MentionNativeFacts,
  defaultPrevented: boolean,
) {
  return (
    requestModeNativeKeyboardFactsMatch(
      first,
      second,
      defaultPrevented,
      false,
    ) &&
    first.charCode === second.charCode &&
    first.keyCode === second.keyCode &&
    first.which === second.which &&
    Object.is(first.locale, second.locale)
  );
}

function createMentionPublication(
  authority: MentionAuthority,
  cells: MentionCells,
): MentionPublication | null {
  const visit = authority.currentVisit();
  const root = authority.currentRoot();
  const textarea = authority.currentTextarea();
  const list = authority.currentList();
  const rowElements = authority.currentRows().slice(0, authority.rows.length);
  const ownerDocument = textarea?.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView as
    | (Window & typeof globalThis)
    | null;
  if (
    !visit ||
    visit.retired ||
    authority.currentSubmission() !== null ||
    authority.busy ||
    !root ||
    !textarea ||
    !list ||
    !ownerDocument ||
    !ownerWindow ||
    rowElements.length !== authority.rows.length ||
    rowElements.some((row) => !row)
  ) {
    return null;
  }
  const exactRows = Object.freeze(rowElements as HTMLLIElement[]);
  const capturedKeyboard = captureRequestModeKeyboardAuthority(
    ownerDocument,
    ownerWindow,
  );
  const keyboard = capturedKeyboard
    ? captureMentionKeyboardAuthority(capturedKeyboard)
    : null;
  const dom = createMentionDomEvidence(textarea, list);
  if (!keyboard || !dom) {
    dom?.release();
    return null;
  }
  const eventDocument = ownerDocument;
  const eventTextarea = textarea;
  const eventWindow = ownerWindow;
  const eventKeyboard = keyboard;
  const identity = Symbol("mention-keyboard-publication");
  const actions = Object.freeze(
    Object.fromEntries(
      (["ArrowDown", "ArrowUp", "Home", "End"] as const).map((key) => [
        key,
        Object.freeze({
          identity: Symbol(`mention-${key}-action`),
          publicationIdentity: identity,
          key,
          source: authority.highlight,
          destination: mentionDestination(
            key,
            authority.highlight,
            authority.rows.length,
          ),
        }),
      ]),
    ),
  ) as Readonly<Record<MentionNavigationKey, MentionAction>>;
  let retired = false;
  let nativePairs: WeakMap<globalThis.KeyboardEvent, MentionKeyboardPair> | null =
    new WeakMap();
  let attemptedNativeEvents = new WeakSet<globalThis.KeyboardEvent>();
  let activeNativePair: WeakRef<MentionKeyboardPair> | null = null;
  let publicCallActive = false;
  let publicCallGeneration = 0;
  const capturedAddEventListener = ownerWindow.addEventListener;
  const capturedRemoveEventListener = ownerWindow.removeEventListener;
  const apply = ownerWindow.Reflect.apply;
  let listenerActive = false;

  const retire = () => {
    if (retired) return;
    retired = true;
    cells.retired.add(publication);
    if (cells.active.current === publication) cells.active.current = null;
    if (listenerActive) {
      listenerActive = false;
      try {
        apply(capturedRemoveEventListener, ownerWindow, [
          "keydown",
          onWindowCapture,
          true,
        ]);
        apply(capturedRemoveEventListener, ownerWindow, [
          "keydown",
          onWindowBubble,
        ]);
      } catch {
        // Retiring makes the captured listener access unusable even when removal throws.
      }
    }
    nativePairs = null;
    attemptedNativeEvents = new WeakSet();
    activeNativePair = null;
    dom.release();
  };
  const invalidate = () => {
    if (retired) return;
    retire();
    authority.requestSuccessor();
  };
  const isCurrent = () => {
    if (
      !retired &&
      cells.active.current === publication &&
      !cells.retired.has(publication) &&
      mentionFactsAreCurrent(publication) &&
      mentionDomIsExact(publication) &&
      keyboard.isCurrent() &&
      ownerDocument.defaultView === ownerWindow &&
      ownerWindow.addEventListener === capturedAddEventListener &&
      ownerWindow.removeEventListener === capturedRemoveEventListener
    ) {
      return true;
    }
    if (!retired && cells.active.current === publication) invalidate();
    return false;
  };

  const callPublic = <Value,>(callback: () => Value) => {
    if (publicCallActive) {
      publicCallGeneration += 1;
      return null;
    }
    const generation = publicCallGeneration;
    publicCallActive = true;
    try {
      const value = callback();
      return generation === publicCallGeneration ? Object.freeze({ value }) : null;
    } catch {
      return null;
    } finally {
      publicCallActive = false;
    }
  };

  const pairIsCurrent = (
    pair: MentionKeyboardPair,
    consumed = false,
  ) =>
    !publicCallActive &&
    !retired &&
    pair.finalizing === consumed &&
    pair.consumed === consumed &&
    nativePairs?.get(pair.native.event) === pair &&
    activeNativePair?.deref() === pair &&
    isCurrent();

  const defaultQueryFor = (
    pair: MentionKeyboardPair,
    proof: MentionReactProof,
    defaultPrevented: boolean,
  ) =>
    defaultPrevented &&
    proof.event === pair.textareaBubble?.event &&
    pair.postDefaultQueries.get(proof.event)
      ? pair.postDefaultQueries.get(proof.event)!
      : proof.methods.isDefaultPrevented;

  const reactMethodsAreCurrent = (
    pair: MentionKeyboardPair,
    proof: MentionReactProof,
    defaultPrevented: boolean,
  ) => {
    const values = proof.event as Record<PropertyKey, unknown>;
    const preventDefault = callPublic(() => values.preventDefault);
    if (
      !preventDefault ||
      preventDefault.value !== proof.methods.preventDefault ||
      !pairIsCurrent(pair, pair.consumed)
    ) {
      return false;
    }
    const isDefaultPrevented = callPublic(() => values.isDefaultPrevented);
    if (
      !isDefaultPrevented ||
      isDefaultPrevented.value !== defaultQueryFor(pair, proof, defaultPrevented) ||
      !pairIsCurrent(pair, pair.consumed)
    ) {
      return false;
    }
    const isPropagationStopped = callPublic(
      () => values.isPropagationStopped,
    );
    return Boolean(
      isPropagationStopped &&
        isPropagationStopped.value === proof.methods.isPropagationStopped &&
        pairIsCurrent(pair, pair.consumed),
    );
  };

  const reactScalarsAreCurrent = (
    pair: MentionKeyboardPair,
    proof: MentionReactProof,
    defaultPrevented: boolean,
  ) => {
    if (defaultPrevented && !pair.postDefaultPrevented.has(proof.event)) {
      return false;
    }
    const expectedDefaultPrevented = defaultPrevented
      ? pair.postDefaultPrevented.get(proof.event)
      : false;
    const values = proof.event as Record<PropertyKey, unknown>;
    const read = <Value,>(callback: () => Value) => {
      const result = callPublic(callback);
      return result && pairIsCurrent(pair, pair.consumed) ? result : null;
    };
    const nativeEvent = read(() => values.nativeEvent);
    const type = read(() => values.type);
    const target = read(() => values.target);
    const currentTarget = read(() => values.currentTarget);
    const eventPhase = read(() => values.eventPhase);
    const bubbles = read(() => values.bubbles);
    const cancelable = read(() => values.cancelable);
    const currentDefaultPrevented = read(() => values.defaultPrevented);
    const trusted = read(() => values.isTrusted);
    const key = read(() => values.key);
    const code = read(() => values.code);
    const location = read(() => values.location);
    const charCode = read(() => values.charCode);
    const keyCode = read(() => values.keyCode);
    const which = read(() => values.which);
    const locale = read(() => values.locale);
    const detail = read(() => values.detail);
    const view = read(() => values.view);
    const repeat = read(() => values.repeat);
    const composing = read(() => values.isComposing);
    const altKey = read(() => values.altKey);
    const ctrlKey = read(() => values.ctrlKey);
    const metaKey = read(() => values.metaKey);
    const shiftKey = read(() => values.shiftKey);
    const sharesReactDelivery = [
      pair.rootCapture,
      pair.textareaCapture,
      pair.textareaBubble,
      pair.rootBubble,
    ].some((other) => other !== proof && other?.event === proof.event);
    const releasedReactPhase =
      sharesReactDelivery &&
      currentTarget?.value === null &&
      (eventPhase?.value === ownerWindow.Event.NONE ||
        [
          pair.rootCapture,
          pair.textareaCapture,
          pair.textareaBubble,
          pair.rootBubble,
        ].some(
          (other) =>
            other?.event === proof.event &&
            eventPhase?.value === other.phase,
        ));
    return Boolean(
      nativeEvent?.value === proof.nativeEvent &&
        type?.value === proof.type &&
        target?.value === proof.target &&
        (currentTarget?.value === proof.currentTarget ||
          releasedReactPhase) &&
        (eventPhase?.value === proof.phase ||
          releasedReactPhase) &&
        bubbles?.value === proof.bubbles &&
        cancelable?.value === proof.cancelable &&
        currentDefaultPrevented?.value === expectedDefaultPrevented &&
        trusted?.value === proof.trusted &&
        key?.value === proof.key &&
        code?.value === proof.code &&
        location?.value === proof.location &&
        charCode?.value === proof.charCode &&
        keyCode?.value === proof.keyCode &&
        which?.value === proof.which &&
        Object.is(locale?.value, proof.locale) &&
        detail?.value === proof.detail &&
        Object.is(view?.value, proof.view) &&
        repeat?.value === proof.repeat &&
        composing?.value === proof.composing &&
        altKey?.value === proof.altKey &&
        ctrlKey?.value === proof.ctrlKey &&
        metaKey?.value === proof.metaKey &&
        shiftKey?.value === proof.shiftKey &&
        pairIsCurrent(pair, pair.consumed),
    );
  };

  const reactProofIsCurrent = (
    pair: MentionKeyboardPair,
    proof: MentionReactProof,
    defaultPrevented: boolean,
  ) =>
    reactScalarsAreCurrent(pair, proof, defaultPrevented) &&
    reactMethodsAreCurrent(pair, proof, defaultPrevented);

  const readReactProof = (
    pair: MentionKeyboardPair,
    event: object,
    currentTarget: HTMLElement,
    phase: number,
  ): MentionReactProof | null => {
    if (!pairIsCurrent(pair) || !event || typeof event !== "object") {
      return null;
    }
    const values = event as Record<PropertyKey, unknown>;
    const read = <Value,>(callback: () => Value) => {
      const result = callPublic(callback);
      return result && pairIsCurrent(pair) ? result : null;
    };
    const nativeEvent = read(() => values.nativeEvent);
    if (nativeEvent?.value !== pair.native.event) return null;
    const type = read(() => values.type);
    const target = read(() => values.target);
    const actualCurrentTarget = read(() => values.currentTarget);
    const eventPhase = read(() => values.eventPhase);
    const bubbles = read(() => values.bubbles);
    const cancelable = read(() => values.cancelable);
    const defaultPrevented = read(() => values.defaultPrevented);
    const trusted = read(() => values.isTrusted);
    const key = read(() => values.key);
    const code = read(() => values.code);
    const location = read(() => values.location);
    const charCode = read(() => values.charCode);
    const keyCode = read(() => values.keyCode);
    const which = read(() => values.which);
    const locale = read(() => values.locale);
    const detail = read(() => values.detail);
    const view = read(() => values.view);
    const repeat = read(() => values.repeat);
    const composing = read(() => values.isComposing);
    const altKey = read(() => values.altKey);
    const ctrlKey = read(() => values.ctrlKey);
    const metaKey = read(() => values.metaKey);
    const shiftKey = read(() => values.shiftKey);
    const preventDefault = read(() => values.preventDefault);
    const isDefaultPrevented = read(() => values.isDefaultPrevented);
    const isPropagationStopped = read(() => values.isPropagationStopped);
    if (
      !type ||
      !target ||
      !actualCurrentTarget ||
      !eventPhase ||
      !bubbles ||
      !cancelable ||
      !defaultPrevented ||
      !trusted ||
      !key ||
      !code ||
      !location ||
      !charCode ||
      !keyCode ||
      !which ||
      !locale ||
      !detail ||
      !view ||
      !repeat ||
      !composing ||
      !altKey ||
      !ctrlKey ||
      !metaKey ||
      !shiftKey ||
      !preventDefault ||
      !isDefaultPrevented ||
      !isPropagationStopped ||
      typeof preventDefault.value !== "function" ||
      typeof isDefaultPrevented.value !== "function" ||
      typeof isPropagationStopped.value !== "function"
    ) {
      return null;
    }
    const facts = pair.native.facts;
    if (
      type.value !== "keydown" ||
      target.value !== textarea ||
      actualCurrentTarget.value !== currentTarget ||
      eventPhase.value !== phase ||
      bubbles.value !== facts.bubbles ||
      cancelable.value !== facts.cancelable ||
      defaultPrevented.value !== false ||
      trusted.value !== facts.trusted ||
      key.value !== facts.key ||
      code.value !== facts.code ||
      location.value !== facts.location ||
      charCode.value !== facts.charCode ||
      keyCode.value !== facts.keyCode ||
      which.value !== facts.which ||
      !Object.is(locale.value, facts.locale) ||
      detail.value !== facts.detail ||
      !Object.is(view.value, facts.view) ||
      repeat.value !== facts.repeat ||
      (composing.value !== undefined && composing.value !== facts.composing) ||
      altKey.value !== facts.altKey ||
      ctrlKey.value !== facts.ctrlKey ||
      metaKey.value !== facts.metaKey ||
      shiftKey.value !== facts.shiftKey
    ) {
      return null;
    }
    const proof = Object.freeze({
      event,
      nativeEvent: pair.native.event,
      currentTarget,
      phase,
      key: facts.key as MentionNavigationKey,
      type: type.value,
      target: target.value as EventTarget,
      bubbles: bubbles.value as boolean,
      cancelable: cancelable.value as boolean,
      defaultPrevented: false,
      trusted: trusted.value as boolean,
      view: view.value as Window | null,
      detail: detail.value as number,
      code: code.value as string,
      location: location.value as number,
      charCode: charCode.value as number,
      keyCode: keyCode.value as number,
      which: which.value as number,
      locale: locale.value,
      repeat: repeat.value as boolean,
      composing: composing.value as boolean | undefined,
      altKey: altKey.value as boolean,
      ctrlKey: ctrlKey.value as boolean,
      metaKey: metaKey.value as boolean,
      shiftKey: shiftKey.value as boolean,
      methods: Object.freeze({
        preventDefault:
          preventDefault.value as MentionReactMethods["preventDefault"],
        isDefaultPrevented:
          isDefaultPrevented.value as MentionReactMethods["isDefaultPrevented"],
        isPropagationStopped:
          isPropagationStopped.value as MentionReactMethods["isPropagationStopped"],
      }),
    } satisfies MentionReactProof);
    const query = (
      method: MentionReactMethods["isDefaultPrevented"] |
        MentionReactMethods["isPropagationStopped"],
    ) => {
      if (!reactProofIsCurrent(pair, proof, false)) return false;
      const result = callPublic(() => apply(method, event, []));
      return Boolean(
        result?.value === false &&
          reactProofIsCurrent(pair, proof, false) &&
          pairIsCurrent(pair),
      );
    };
    return query(proof.methods.isDefaultPrevented) &&
      query(proof.methods.isPropagationStopped)
      ? proof
      : null;
  };

  const stageForReact = (event: object) => {
    if (publicCallActive) {
      publicCallGeneration += 1;
      return null;
    }
    if (!event || typeof event !== "object") return null;
    const carried = callPublic(
      () => (event as Record<PropertyKey, unknown>).nativeEvent,
    );
    if (
      !carried ||
      !isCurrent() ||
      !carried.value ||
      typeof carried.value !== "object"
    ) {
      return null;
    }
    return nativePairs?.get(carried.value as globalThis.KeyboardEvent) ?? null;
  };

  const nativeFactsAreCurrent = (
    pair: MentionKeyboardPair,
    defaultPrevented: boolean,
    phase: number,
    receiver: EventTarget,
  ) => {
    const current = readMentionNativeFacts(pair.native.event, keyboard);
    const expectedPath = requestModeEventPath(textarea, ownerDocument);
    const terminal = current?.path.at(-1);
    return Boolean(
      current &&
        expectedPath &&
        terminal &&
        pair.native.receiver === pair.native.terminal &&
        receiver === pair.native.receiver &&
        current.currentTarget === receiver &&
        current.phase === phase &&
        current.target === textarea &&
        current.path.at(0) === textarea &&
        requestModePathMatches(current.path, expectedPath, terminal) &&
        terminal === receiver &&
        (current.view === null ||
          current.view === ownerWindow ||
          current.view === receiver) &&
        current.type === "keydown" &&
        current.bubbles &&
        current.cancelable &&
        current.defaultPrevented === defaultPrevented &&
        !current.cancelBubble &&
        current.detail === 0 &&
        current.location ===
          ownerWindow.KeyboardEvent.DOM_KEY_LOCATION_STANDARD &&
        !current.repeat &&
        !current.composing &&
        !current.altKey &&
        !current.ctrlKey &&
        !current.metaKey &&
        !current.shiftKey &&
        mentionNativeFactsMatch(
          pair.native.facts,
          current,
          defaultPrevented,
        ) &&
        keyboard.keyboard.activeElement.read(ownerDocument) === textarea,
    );
  };

  const terminalIsCurrent = (
    pair: MentionKeyboardPair,
    defaultPrevented: boolean,
    claimed: boolean,
  ) => {
    const action = pair.native.action;
    const proofs = [
      pair.rootCapture,
      pair.textareaCapture,
      pair.textareaBubble,
      pair.rootBubble,
    ];
    return Boolean(
      proofs.every((proof) => proof !== null) &&
        proofs.every(
          (proof) =>
            proof !== null &&
            proof.nativeEvent === pair.native.event &&
            proof.target === textarea &&
            proof.key === action.key &&
              proof.defaultPrevented === false &&
              reactProofIsCurrent(pair, proof, defaultPrevented),
        ) &&
        pair.rootCapture?.currentTarget === root &&
        pair.rootCapture.phase === ownerWindow.Event.CAPTURING_PHASE &&
        pair.textareaCapture?.currentTarget === textarea &&
        pair.textareaCapture.phase === ownerWindow.Event.CAPTURING_PHASE &&
        pair.textareaBubble?.currentTarget === textarea &&
        pair.textareaBubble.phase === ownerWindow.Event.BUBBLING_PHASE &&
        pair.rootBubble?.currentTarget === root &&
        pair.rootBubble.phase === ownerWindow.Event.BUBBLING_PHASE &&
        action.publicationIdentity === publication.identity &&
        actions[action.key] === action &&
        action.source === authority.highlight &&
        action.destination !== null &&
        action.destination ===
          mentionDestination(
            action.key,
            authority.highlight,
            authority.rows.length,
          ) &&
        (claimed
          ? cells.claimedPublications.has(publication) &&
            cells.claimedActions.has(action) &&
            cells.claimedNativeEvents.has(pair.native.event) &&
            proofs.every(
              (proof) =>
                proof !== null && cells.claimedReactEvents.has(proof.event),
            )
          : !cells.claimedPublications.has(publication) &&
            !cells.claimedActions.has(action) &&
            !cells.claimedNativeEvents.has(pair.native.event) &&
            proofs.every(
              (proof) =>
                proof !== null && !cells.claimedReactEvents.has(proof.event),
            )) &&
        pairIsCurrent(pair, claimed) &&
        nativeFactsAreCurrent(
          pair,
          defaultPrevented,
          ownerWindow.Event.BUBBLING_PHASE,
          pair.native.receiver,
        ),
    );
  };

  const queryTerminal = (
    pair: MentionKeyboardPair,
    proof: MentionReactProof,
    method: MentionReactMethods["isDefaultPrevented"] |
      MentionReactMethods["isPropagationStopped"],
    expected: boolean,
    defaultPrevented: boolean,
    claimed: boolean,
  ) => {
    if (
      !terminalIsCurrent(pair, defaultPrevented, claimed) ||
      (method !== defaultQueryFor(pair, proof, defaultPrevented) &&
        method !== proof.methods.isPropagationStopped)
    ) {
      return false;
    }
    const result = callPublic(() => apply(method, proof.event, []));
    return Boolean(
      result?.value === expected &&
        terminalIsCurrent(pair, defaultPrevented, claimed) &&
        reactProofIsCurrent(pair, proof, defaultPrevented),
    );
  };

  const claimTerminal = (pair: MentionKeyboardPair) => {
    const proofs = [
      pair.rootCapture,
      pair.textareaCapture,
      pair.textareaBubble,
      pair.rootBubble,
    ];
    const action = pair.native.action;
    if (
      !terminalIsCurrent(pair, false, false) ||
      proofs.some((proof) => proof === null) ||
      nativePairs?.get(pair.native.event) !== pair
    ) {
      return false;
    }
    pair.consumed = true;
    pair.finalizing = true;
    cells.claimedPublications.add(publication);
    cells.claimedActions.add(action);
    cells.claimedNativeEvents.add(pair.native.event);
    for (const proof of proofs) {
      cells.claimedReactEvents.add(proof!.event);
    }
    return true;
  };

  function onWindowCapture(this: EventTarget, event: Event) {
    if (publicCallActive) {
      publicCallGeneration += 1;
      return;
    }
    try {
      if (
        retired ||
        !listenerActive ||
        !isCurrent()
      ) {
        return;
      }
      const facts = readMentionNativeFacts(event, eventKeyboard);
      const expectedPath = requestModeEventPath(eventTextarea, eventDocument);
      const terminal = facts?.path.at(-1);
      const action =
        facts &&
        (facts.key === "ArrowDown" ||
          facts.key === "ArrowUp" ||
          facts.key === "Home" ||
          facts.key === "End")
          ? actions[facts.key]
          : null;
      if (
        !facts ||
        !terminal ||
        !expectedPath ||
        !action ||
        action.source !== authority.highlight ||
        action.destination === null ||
        action.destination !==
          mentionDestination(
            action.key,
            authority.highlight,
            authority.rows.length,
          ) ||
        facts.currentTarget !== this ||
        facts.phase !== eventWindow.Event.CAPTURING_PHASE ||
        facts.target !== textarea ||
        facts.path.at(0) !== textarea ||
        terminal !== this ||
        !requestModePathMatches(facts.path, expectedPath, terminal) ||
        (facts.view !== null &&
          facts.view !== eventWindow &&
          facts.view !== this) ||
        facts.type !== "keydown" ||
        !facts.bubbles ||
        !facts.cancelable ||
        facts.defaultPrevented ||
        facts.cancelBubble ||
        facts.detail !== 0 ||
        facts.location !==
          eventWindow.KeyboardEvent.DOM_KEY_LOCATION_STANDARD ||
        facts.repeat ||
        facts.composing ||
        facts.altKey ||
        facts.ctrlKey ||
        facts.metaKey ||
        facts.shiftKey ||
        eventKeyboard.keyboard.activeElement.read(eventDocument) !== textarea ||
        attemptedNativeEvents.has(event as globalThis.KeyboardEvent)
      ) {
        if (attemptedNativeEvents.has(event as globalThis.KeyboardEvent)) {
          nativePairs?.delete(event as globalThis.KeyboardEvent);
        }
        return;
      }
      const active = activeNativePair?.deref();
      if (
        active &&
        eventKeyboard.keyboard.eventPhase.read(active.native.event) ===
          eventWindow.Event.NONE
      ) {
        activeNativePair = null;
      }
      if (activeNativePair?.deref()) return;
      attemptedNativeEvents.add(event as globalThis.KeyboardEvent);
      const pair: MentionKeyboardPair = {
        native: Object.freeze({
          event: event as globalThis.KeyboardEvent,
          facts,
          receiver: this,
          terminal,
          action,
        }),
        rootCapture: null,
        textareaCapture: null,
        textareaBubble: null,
        rootBubble: null,
        postDefaultQueries: new WeakMap(),
        postDefaultPrevented: new WeakMap(),
        finalizing: false,
        consumed: false,
      };
      nativePairs?.set(event as globalThis.KeyboardEvent, pair);
      activeNativePair = new WeakRef(pair);
    } catch {
      return;
    }
  }

  function onWindowBubble(this: EventTarget, event: Event) {
    if (publicCallActive) {
      publicCallGeneration += 1;
      return;
    }
    const pair = nativePairs?.get(event as globalThis.KeyboardEvent);
    if (!pair) return;
    try {
      if (
        publicCallActive ||
        retired ||
        !listenerActive ||
        this !== pair.native.receiver ||
        !terminalIsCurrent(pair, false, false)
      ) {
        return;
      }
      const proofs = [
        pair.rootCapture!,
        pair.textareaCapture!,
        pair.textareaBubble!,
        pair.rootBubble!,
      ];
      for (const proof of proofs) {
        if (
          !queryTerminal(
            pair,
            proof,
            proof.methods.isDefaultPrevented,
            false,
            false,
            false,
          ) ||
          !queryTerminal(
            pair,
            proof,
            proof.methods.isPropagationStopped,
            false,
            false,
            false,
          )
        ) {
          return;
        }
      }
      if (!claimTerminal(pair)) return;
      try {
        const textareaBubble = pair.textareaBubble!;
        const prevented = callPublic(() =>
          apply(
            textareaBubble.methods.preventDefault,
            textareaBubble.event,
            [],
          ),
        );
        if (!prevented) return;
        // Only prevention's receiver (including exact-object aliases) may get
        // React's replacement query. Capture it before any other public getter.
        const currentDefault = callPublic(
          () =>
            (textareaBubble.event as Record<PropertyKey, unknown>)
              .isDefaultPrevented,
        );
        if (
          !currentDefault ||
          typeof currentDefault.value !== "function" ||
          !pairIsCurrent(pair, true)
        ) {
          return;
        }
        pair.postDefaultQueries.set(
          textareaBubble.event,
          currentDefault.value as MentionReactMethods["isDefaultPrevented"],
        );
        if (!proofs.every((proof) => reactMethodsAreCurrent(pair, proof, true))) {
          return;
        }
        for (const proof of proofs) {
          if (pair.postDefaultPrevented.has(proof.event)) continue;
          const currentDefaultPrevented = callPublic(
            () =>
              (proof.event as Record<PropertyKey, unknown>)
                .defaultPrevented,
          );
          if (
            !currentDefaultPrevented ||
            typeof currentDefaultPrevented.value !== "boolean" ||
            !pairIsCurrent(pair, true) ||
            !proofs.every((current) => reactMethodsAreCurrent(pair, current, true))
          ) {
            return;
          }
          pair.postDefaultPrevented.set(
            proof.event,
            currentDefaultPrevented.value,
          );
        }
        const currentDefaultPrevented = pair.postDefaultPrevented.get(
          textareaBubble.event,
        );
        if (
          currentDefaultPrevented === undefined ||
          !terminalIsCurrent(pair, true, true) ||
          !queryTerminal(
            pair,
            textareaBubble,
            defaultQueryFor(pair, textareaBubble, true),
            currentDefaultPrevented,
            true,
            true,
          )
        ) {
          return;
        }
        for (const proof of proofs) {
          if (
            !queryTerminal(
              pair,
              proof,
              defaultQueryFor(pair, proof, true),
              pair.postDefaultPrevented.get(proof.event) ?? false,
              true,
              true,
            ) ||
            !queryTerminal(
              pair,
              proof,
              proof.methods.isPropagationStopped,
              false,
              true,
              true,
            )
          ) {
            return;
          }
        }
        if (
          !terminalIsCurrent(pair, true, true) ||
          !reactProofIsCurrent(pair, textareaBubble, true)
        ) {
          return;
        }
        const destination = pair.native.action.destination;
        if (destination === null) return;
        const highlighted = callPublic(() => authority.setHighlight(destination));
        if (!highlighted || !terminalIsCurrent(pair, true, true)) return;
      } finally {
        cells.claimedPublications.delete(publication);
        cells.claimedActions.delete(pair.native.action);
        pair.finalizing = false;
      }
    } catch {
      return;
    } finally {
      nativePairs?.delete(pair.native.event);
      if (activeNativePair?.deref() === pair) activeNativePair = null;
    }
  }

  const publication: MentionPublication = Object.freeze({
    identity,
    authority,
    visit,
    root,
    textarea,
    list,
    rowElements: exactRows,
    ownerDocument,
    ownerWindow,
    keyboard,
    dom,
    actions,
    captureRoot: (event: KeyboardEvent<HTMLDivElement>) => {
      const pair = stageForReact(event);
      if (
        !pair ||
        pair.rootCapture ||
        pair.textareaCapture ||
        pair.textareaBubble ||
        pair.rootBubble
      ) {
        return;
      }
      const proof = readReactProof(
        pair,
        event,
        root,
        ownerWindow.Event.CAPTURING_PHASE,
      );
      if (proof) pair.rootCapture = proof;
    },
    captureTextarea: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const pair = stageForReact(event);
      if (
        !pair ||
        !pair.rootCapture ||
        pair.textareaCapture ||
        pair.textareaBubble ||
        pair.rootBubble
      ) {
        return;
      }
      const proof = readReactProof(
        pair,
        event,
        textarea,
        ownerWindow.Event.CAPTURING_PHASE,
      );
      if (proof) pair.textareaCapture = proof;
    },
    bubbleTextarea: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const pair = stageForReact(event);
      if (
        !pair ||
        !pair.rootCapture ||
        !pair.textareaCapture ||
        pair.textareaBubble ||
        pair.rootBubble
      ) {
        return;
      }
      const proof = readReactProof(
        pair,
        event,
        textarea,
        ownerWindow.Event.BUBBLING_PHASE,
      );
      if (proof) pair.textareaBubble = proof;
    },
    bubbleRoot: (event: KeyboardEvent<HTMLDivElement>) => {
      const pair = stageForReact(event);
      if (
        !pair ||
        !pair.rootCapture ||
        !pair.textareaCapture ||
        !pair.textareaBubble ||
        pair.rootBubble
      ) {
        return;
      }
      const proof = readReactProof(
        pair,
        event,
        root,
        ownerWindow.Event.BUBBLING_PHASE,
      );
      if (proof) pair.rootBubble = proof;
    },
    retire,
    isRetired: () => retired,
  });
  if (!mentionFactsAreCurrent(publication) || !mentionDomIsExact(publication)) {
    retire();
    return null;
  }
  const previous = cells.active.current;
  previous?.retire();
  cells.active.current = publication;
  try {
    apply(capturedAddEventListener, ownerWindow, [
      "keydown",
      onWindowCapture,
      true,
    ]);
    apply(capturedAddEventListener, ownerWindow, ["keydown", onWindowBubble]);
    listenerActive = true;
  } catch {
    retire();
    return null;
  }
  return publication;
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
  const mentionListId = useId();
  const [mentionMount] = useState(() => Symbol("mention composer"));
  const [mentionCells] = useState(createMentionCells);
  const mentionActive = mentionCells.active;
  const [mentionRevision, setMentionRevision] = useState(0);
  const [requestModeMount] = useState(() => Symbol("request mode composer"));
  const [requestModeCells] = useState(createRequestModeCells);
  const [requestModePresentationCache] = useState(() => new RequestModePresentationCache());
  const [requestModeRevision, setRequestModeRevision] = useState(0);
  const requestRequestModeSuccessor = useCallback(() => {
    setRequestModeRevision((revision) => revision + 1);
  }, []);
  const ref = useRef<HTMLTextAreaElement>(null);
  const mentionRootRef = useRef<HTMLDivElement>(null);
  const mentionListRef = useRef<HTMLUListElement>(null);
  const mentionRowRefs = useRef<(HTMLLIElement | null)[]>([]);
  const activeVisit = useRef<ComposerVisit | null>(null);
  const activeSubmission = useRef<ComposerSubmissionOwner | null>(null);
  const currentComposerVisit = useCallback(() => activeVisit.current, []);
  const currentComposerSubmission = useCallback(
    () => activeSubmission.current,
    [],
  );
  const currentMentionRoot = useCallback(() => mentionRootRef.current, []);
  const currentMentionTextarea = useCallback(() => ref.current, []);
  const currentMentionList = useCallback(() => mentionListRef.current, []);
  const currentMentionRows = useCallback(
    () => mentionRowRefs.current as readonly (HTMLLIElement | null)[],
    [],
  );
  const requestMentionSuccessor = useCallback(() => {
    setMentionRevision((revision) => revision + 1);
  }, []);
  const retireMentionForElement = mentionCells.retireForElement;
  const captureMentionRoot = useCallback(
    (element: HTMLDivElement | null) => {
      retireMentionForElement(element, mentionRootRef.current);
      mentionRootRef.current = element;
    },
    [retireMentionForElement],
  );
  const captureMentionTextarea = useCallback(
    (element: HTMLTextAreaElement | null) => {
      retireMentionForElement(element, ref.current);
      ref.current = element;
    },
    [retireMentionForElement],
  );
  const captureMentionList = useCallback(
    (element: HTMLUListElement | null) => {
      retireMentionForElement(element, mentionListRef.current);
      mentionListRef.current = element;
    },
    [retireMentionForElement],
  );
  const captureMentionRow = useCallback(
    (index: number, element: HTMLLIElement | null) => {
      retireMentionForElement(element, mentionRowRefs.current[index] ?? null);
      mentionRowRefs.current[index] = element;
    },
    [retireMentionForElement],
  );
  const captureMentionRows = useMemo(
    () =>
      Object.freeze(
        Array.from(
          { length: MAX_SUGGESTIONS },
          (_, index) => (element: HTMLLIElement | null) =>
            captureMentionRow(index, element),
        ),
      ),
    [captureMentionRow],
  );
  const requestModeVisitIsCurrent = useCallback(() => {
    const visit = activeVisit.current;
    return !!visit && !visit.retired;
  }, []);
  const requestModeSubmissionIsIdle = useCallback(
    () => activeSubmission.current === null,
    [],
  );
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
  const mentionListOpen = open && matches.length > 0;
  const mentionRows = useMemo(
    () =>
      Object.freeze(
        matches.map((candidate, index) =>
          Object.freeze({
            index,
            candidate,
            login: candidate.login,
            name: candidate.name,
            image: candidate.image,
            own: Boolean(candidate.own),
            agent: candidate.agent ?? null,
            ownerLogin: candidate.agent?.ownerLogin ?? null,
            ownerName: candidate.agent?.ownerName ?? null,
            canAsk: candidate.agent?.canAsk ?? null,
            highlighted: index === highlight,
            optionId: `${mentionListId}-option-${index}`,
          }),
        ),
      ),
    [highlight, matches, mentionListId],
  );
  const mentionAuthority = useMemo<MentionAuthority | null>(
    () =>
      mentionListOpen && trigger
        ? // The publication invokes these ref-backed predicates only after commit.
          // eslint-disable-next-line react-hooks/refs
          Object.freeze({
            mount: mentionMount,
            revision: mentionRevision,
            value,
            trigger: Object.freeze({ ...trigger }),
            candidates: Object.freeze([...candidates]),
            rows: mentionRows,
            highlight,
            busy,
            listId: mentionListId,
            currentVisit: currentComposerVisit,
            currentSubmission: currentComposerSubmission,
            currentRoot: currentMentionRoot,
            currentTextarea: currentMentionTextarea,
            currentList: currentMentionList,
            currentRows: currentMentionRows,
            setHighlight,
            requestSuccessor: requestMentionSuccessor,
          })
        : null,
    [
      busy,
      candidates,
      currentComposerSubmission,
      currentComposerVisit,
      currentMentionList,
      currentMentionRoot,
      currentMentionRows,
      currentMentionTextarea,
      highlight,
      mentionListId,
      mentionListOpen,
      mentionMount,
      mentionRevision,
      mentionRows,
      requestMentionSuccessor,
      trigger,
      value,
    ],
  );
  const mentionHandlers: MentionHandlers = Object.freeze({
    captureRoot: (event: KeyboardEvent<HTMLDivElement>) => {
      const publication = mentionActive.current;
      if (publication?.authority === mentionAuthority) {
        publication.captureRoot(event);
      }
    },
    captureTextarea: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const publication = mentionActive.current;
      if (publication?.authority === mentionAuthority) {
        publication.captureTextarea(event);
      }
    },
    bubbleTextarea: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const publication = mentionActive.current;
      if (publication?.authority === mentionAuthority) {
        publication.bubbleTextarea(event);
      }
    },
    bubbleRoot: (event: KeyboardEvent<HTMLDivElement>) => {
      const publication = mentionActive.current;
      if (publication?.authority === mentionAuthority) {
        publication.bubbleRoot(event);
      }
    },
  });
  useLayoutEffect(() => {
    const previous = mentionActive.current;
    if (!mentionAuthority) {
      previous?.retire();
      return;
    }
    if (previous?.authority === mentionAuthority && !previous.isRetired()) {
      return previous.retire;
    }
    previous?.retire();
    const publication = createMentionPublication(
      mentionAuthority,
      mentionCells,
    );
    return publication?.retire;
  }, [mentionActive, mentionAuthority, mentionCells]);

  // The mode row: only while the body names an agent the picker knows, and only on composers that can post a request.
  const agents = useMemo(() => (request ? mentionedAgents(value, candidates) : []), [request, value, candidates]);
  const showRow = request !== undefined && agents.length > 0;
  const effectiveMode: AgentRequestMode = request && !request.canEdit ? "comment" : mode;
  const modeDisabled = (id: AgentRequestMode) => id !== "comment" && request !== undefined && !request.canEdit;
  /** An agent as this user sees it: their own by its plain name, anyone else's as "Drew's Copilot CLI". */
  const nameOf = (c: MentionCandidate) => (c.agent ? agentDisplayName({ name: c.name, ownerLogin: c.agent.ownerLogin, ownerName: c.agent.ownerName }, viewerLogin) : c.name);
  const rowLabel = agents.length === 1 ? `How should ${nameOf(agents[0])} answer?` : "How should the agents answer?";
  // The publication stores these predicates for committed event delivery; it never invokes them during render.
  const requestModeAuthority = request && showRow
    ? // eslint-disable-next-line react-hooks/refs
      Object.freeze({
        mount: requestModeMount,
        revision: requestModeRevision,
        request,
        canEdit: request.canEdit,
        defaultMode: request.defaultMode,
        value,
        candidates,
        agents: Object.freeze([...agents]),
        agentIdentities: Object.freeze(agents.map((agent) => agent.login)),
        viewerLogin,
        mode,
        effectiveMode,
        rowLabel,
        busy,
        rows: Object.freeze(
          REQUEST_MODES.map((requestMode, index) => {
            const checked = requestMode.id === effectiveMode;
            return Object.freeze({
              index,
              id: requestMode.id,
              label: requestMode.label,
              checked,
              disabled: modeDisabled(requestMode.id),
              tabIndex: checked ? 0 as const : -1 as const,
            });
          }),
        ),
        visitIsCurrent: requestModeVisitIsCurrent,
        submissionIsIdle: requestModeSubmissionIsIdle,
        setMode,
        requestSuccessor: requestRequestModeSuccessor,
      } satisfies RequestModeAuthority)
    : null;
  const {
    captureRoot: captureRequestModeRoot,
    rows: requestModeRows,
    establish: establishRequestModes,
  } = requestModeAuthority
    ? requestModePresentationCache.resolve(
        requestModeAuthority,
        () => createRequestModePresentation(requestModeAuthority, requestModeCells),
      )
    : EMPTY_REQUEST_MODE_PRESENTATION;
  useLayoutEffect(
    () => establishRequestModes(),
    [establishRequestModes],
  );
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
    <div
      ref={captureMentionRoot}
      className="@container flex flex-col gap-2"
      onClick={(e) => e.stopPropagation()}
      onKeyDownCapture={mentionHandlers.captureRoot}
      onKeyDown={mentionHandlers.bubbleRoot}
    >
      <Popover open={open} onOpenChange={(o) => !o && !activeSubmission.current && setTrigger(null)}>
        <PopoverAnchor asChild>
          <textarea
            ref={captureMentionTextarea}
            className="textarea min-h-[64px] resize-none text-[13px]"
            placeholder={placeholder}
            value={value}
            disabled={busy}
            aria-busy={busy || undefined}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={mentionListOpen}
            aria-controls={mentionListOpen ? mentionListId : undefined}
            aria-activedescendant={
              mentionListOpen
                ? mentionRows[highlight]?.optionId
                : undefined
            }
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
            onKeyDownCapture={mentionHandlers.captureTextarea}
            onKeyDown={(e) => {
              mentionHandlers.bubbleTextarea(e);
              if (activeSubmission.current) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              if (
                mentionListOpen &&
                (e.key === "ArrowDown" ||
                  e.key === "ArrowUp" ||
                  e.key === "Home" ||
                  e.key === "End")
              ) {
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
            <ul
              ref={captureMentionList}
              id={mentionListId}
              role="listbox"
              aria-label="Mention someone"
            >
              {matches.map((c, i) => {
                // Someone else's agent whose owner has not opened it to collaborators: greyed, with a lock and the reason
                // (#1296). It can still be picked — the mention is legitimate — but the composer will not send a request.
                const lockedAgent = c.agent && !c.agent.canAsk ? c.agent : null;
                const lockedRow = lockedAgent !== null;
                const reason = lockedAgent ? `Only ${agentOwnerName(lockedAgent)} can ask this agent` : undefined;
                return (
                  <li
                    ref={captureMentionRows[i]}
                    key={c.login}
                    id={mentionRows[i]?.optionId}
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
                    <span className="min-w-0 flex-1 truncate text-[13px]" title={nameOf(c)}>{nameOf(c)}</span>
                    {c.agent ? (
                      <span
                        className={cn("flex min-w-0 items-center gap-1 truncate text-xs", lockedRow ? "text-ink-3" : "text-ink-4")}
                        title={reason ?? (c.own ? "One of your API tokens; it has not been in this document yet" : `Agent of @${c.agent.ownerLogin}`)}
                      >
                        {lockedRow && <Lock size={11} aria-hidden="true" className="shrink-0" />}
                        {c.own ? "your agent · not here yet" : lockedRow ? "owner only" : "agent"}
                      </span>
                    ) : (
                      <span className="truncate text-xs text-ink-3" title={`@${c.login}`}>@{c.login}</span>
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
      {showRow && requestModeRows.length > 0 && (
        <div className="composer-agent-row" data-testid="composer-agent-row">
          <div
            ref={captureRequestModeRoot}
            className="composer-modes"
            role="radiogroup"
            aria-label={rowLabel}
          >
            {requestModeRows.map((rowPresentation) => {
              const m = rowPresentation.authority;
              const radio = (
                <button
                  ref={rowPresentation.captureButton}
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={m.checked}
                  aria-disabled={busy || m.disabled || undefined}
                  disabled={busy}
                  tabIndex={m.tabIndex}
                  className="composer-mode"
                  // Choosing a mode with the pointer must not pull focus out of the textarea (Enter still posts).
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (!m.disabled && !activeSubmission.current) setMode(m.id);
                  }}
                  onKeyDownCapture={rowPresentation.onKeyDownCapture}
                  onKeyDown={rowPresentation.onKeyDown}
                  data-testid={`composer-mode-${m.id}`}
                >
                  {m.label}
                </button>
              );
              return m.disabled ? (
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
  const editRoot = () => setEditing("root");
  const deleteRoot = () => deleteTarget(null);
  const rootTargetIdentity =
    storedCommentTargetIdentity(session, thread.id, null) ??
    Object.freeze({ thread, reply: null });
  const rootMenuItems = Object.freeze([
    ...(thread.authorId === me && !thread.suggestionState
      ? [
          Object.freeze({
            id: "edit" as const,
            label: "Edit",
            disabled: rootBusy,
            onSelect: editRoot,
          }),
        ]
      : []),
    Object.freeze({
      id: "delete" as const,
      label: "Delete thread",
      disabled: rootDeleteBlocked,
      onSelect: deleteRoot,
    }),
  ]);
  const rootMenuOwner = Object.freeze({
    session,
    documentId: session.docId,
    visit: actionCoordinator.visit,
    coordinator: actionCoordinator,
    thread,
    reply: null,
    targetIdentity: rootTargetIdentity,
    threadId: thread.id,
    replyId: null,
    viewerId: me,
    authorId: thread.authorId,
    moderator: canModerate,
    suggestionState: thread.suggestionState ?? null,
    triggerDisabled: rootBusy,
    deleteDisabled: rootDeleteBlocked,
    items: rootMenuItems,
  } satisfies LazyMenuOwnerFacts);
  const rootReactionOwner = Object.freeze({
    session,
    documentId: session.docId,
    visit: actionCoordinator.visit,
    coordinator: actionCoordinator,
    thread,
    reply: null,
    targetIdentity: rootTargetIdentity,
    threadId: thread.id,
    replyId: null,
    viewerId: me,
    reactions: thread.reactions,
    canReact: canComment,
    disabled: rootBusy,
    onToggle: (emoji: string) => reactTo(null, thread.reactions, emoji),
  } satisfies ReactionPickerOwnerFacts);

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
            <span className="truncate text-[13px] font-semibold text-ink" title={thread.authorName}>{thread.authorName}</span>
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
              <ReactionRow owner={rootReactionOwner} names={thread.reactorNames} />
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
              owner={rootMenuOwner}
              trigger={
                <button type="button" className="icon-btn h-7 w-7" aria-label="Comment actions" disabled={rootBusy} aria-busy={rootBusy || undefined}>
                  <MoreHorizontal size={16} />
                </button>
              }
            >
              {thread.authorId === me && !thread.suggestionState && (
                <MenuItem icon={<Pencil size={14} />} disabled={rootBusy} onSelect={editRoot}>
                  Edit
                </MenuItem>
              )}
              <MenuItem icon={<Trash2 size={14} />} className="text-danger" disabled={rootDeleteBlocked} onSelect={deleteRoot}>
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
            const editReply = () => setEditing(r.id);
            const deleteReply = () => deleteTarget(r.id);
            const replyTargetIdentity =
              storedCommentTargetIdentity(session, thread.id, r.id) ??
              Object.freeze({ thread, reply: r });
            const replyMenuItems = Object.freeze([
              ...(r.authorId === me && !r.suggestionState
                ? [
                    Object.freeze({
                      id: "edit" as const,
                      label: "Edit",
                      disabled: replyBlocked,
                      onSelect: editReply,
                    }),
                  ]
                : []),
              Object.freeze({
                id: "delete" as const,
                label: "Delete",
                disabled: replyBlocked,
                onSelect: deleteReply,
              }),
            ]);
            const replyMenuOwner = Object.freeze({
              session,
              documentId: session.docId,
              visit: actionCoordinator.visit,
              coordinator: actionCoordinator,
              thread,
              reply: r,
              targetIdentity: replyTargetIdentity,
              threadId: thread.id,
              replyId: r.id,
              viewerId: me,
              authorId: r.authorId,
              moderator: canModerate,
              suggestionState: r.suggestionState ?? null,
              triggerDisabled: replyBlocked,
              deleteDisabled: replyBlocked,
              items: replyMenuItems,
            } satisfies LazyMenuOwnerFacts);
            const replyReactionOwner = Object.freeze({
              session,
              documentId: session.docId,
              visit: actionCoordinator.visit,
              coordinator: actionCoordinator,
              thread,
              reply: r,
              targetIdentity: replyTargetIdentity,
              threadId: thread.id,
              replyId: r.id,
              viewerId: me,
              reactions: r.reactions,
              canReact: canComment,
              disabled: replyBlocked,
              onToggle: (emoji: string) => reactTo(r.id, r.reactions, emoji),
            } satisfies ReactionPickerOwnerFacts);
            return (
              <div key={r.id} data-testid="comment-reply" data-reply-id={r.id} data-state={state ?? undefined}>
                <div className="flex items-start gap-2.5">
                  <AuthorAvatar id={r.authorId} name={r.authorName} src={r.authorAvatar} size={24} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-[13px] font-semibold text-ink" title={r.authorName}>{r.authorName}</span>
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
                        <ReactionRow owner={replyReactionOwner} names={thread.reactorNames} />
                      </>
                    )}
                  </div>
                  {(r.authorId === me || canModerate) && (
                    <div onClick={(e) => e.stopPropagation()}>
                      <LazyMenu
                        align="end"
                        className="w-36"
                        owner={replyMenuOwner}
                        trigger={
                          <button type="button" className="icon-btn h-6 w-6" aria-label="Reply actions" disabled={replyBlocked} aria-busy={replyBusy || undefined}>
                            <MoreHorizontal size={14} />
                          </button>
                        }
                      >
                        {r.authorId === me && !r.suggestionState && (
                          <MenuItem icon={<Pencil size={14} />} disabled={replyBlocked} onSelect={editReply}>
                            Edit
                          </MenuItem>
                        )}
                        <MenuItem icon={<Trash2 size={14} />} className="text-danger" disabled={replyBlocked} onSelect={deleteReply}>
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
            <span className="truncate text-[13px] font-semibold text-ink" title={s.authorName}>{s.authorName}</span>
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

const COMMENTS_PANEL_CLASS = "flex w-[340px] shrink-0 flex-col border-l border-line bg-surface-2";
const COMMENTS_HEADER_CLASS = "flex h-12 items-center justify-between border-b border-line pl-4 pr-2";
const COMMENTS_CLOSE_CLASS = "icon-btn h-8 w-8";
const COMMENTS_NAV_ROW_CLASS = "flex items-center gap-1 border-b border-line px-3 py-2";
const COMMENTS_TABLIST_CLASS = "flex min-w-0 flex-1 gap-1";
const COMMENTS_TAB_BASE_CLASS = "rounded-md px-2.5 py-1 text-xs font-medium";
const COMMENTS_TAB_SELECTED_CLASS = "bg-surface text-ink shadow-sm ring-1 ring-line";
const COMMENTS_TAB_IDLE_CLASS = "text-ink-3 hover:text-ink";
const COMMENTS_TABPANEL_CLASS = "scrollbar-thin flex flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto p-3";
const COMMENTS_EMPTY_SUGGESTIONS_CLASS = "mb-3 flex flex-wrap items-center justify-center gap-1 text-ink-3";
const COMMENTS_EMPTY_SUGGESTIONS_BUTTON_CLASS = "inline-flex items-center gap-1 font-medium text-accent hover:underline";
const seenCommentNavigationNativeEvents = new WeakSet<Event>();
const claimedCommentNavigationNativeEvents = new WeakSet<Event>();
const commentNavigationPreventDefault = globalThis.Event.prototype.preventDefault;
const commentNavigationGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const commentNavigationReflectGet = Reflect.get;
const COMMENT_NAVIGATION_MAX_MUTATION_NODES = 256;

type CommentNavigationNativeGetter = () => unknown;
type CommentNavigationNativeGetters<Field extends string> = Readonly<
  Record<Field, CommentNavigationNativeGetter>
>;
type CommentNavigationEventField =
  | "type"
  | "target"
  | "currentTarget"
  | "eventPhase"
  | "bubbles"
  | "cancelable"
  | "defaultPrevented"
  | "composed"
  | "timeStamp";
type CommentNavigationUiEventField = "detail" | "view";
type CommentNavigationMouseEventField =
  | "screenX"
  | "screenY"
  | "clientX"
  | "clientY"
  | "ctrlKey"
  | "shiftKey"
  | "altKey"
  | "metaKey"
  | "button"
  | "buttons"
  | "relatedTarget";
type CommentNavigationFocusEventField = "relatedTarget";
type CommentNavigationKeyboardEventField =
  | "key"
  | "code"
  | "location"
  | "repeat"
  | "isComposing"
  | "ctrlKey"
  | "shiftKey"
  | "altKey"
  | "metaKey";
type CommentNavigationMutationRecordField =
  | "type"
  | "target"
  | "previousSibling"
  | "nextSibling"
  | "addedNodes"
  | "removedNodes"
  | "attributeName"
  | "oldValue";

interface CommentNavigationEventIntrinsics {
  readonly document: CommentNavigationNativeGetters<"activeElement">;
  readonly event: CommentNavigationNativeGetters<CommentNavigationEventField>;
  readonly uiEvent: CommentNavigationNativeGetters<CommentNavigationUiEventField>;
  readonly mouseEvent: CommentNavigationNativeGetters<CommentNavigationMouseEventField>;
  readonly focusEvent: CommentNavigationNativeGetters<CommentNavigationFocusEventField>;
  readonly keyboardEvent: CommentNavigationNativeGetters<CommentNavigationKeyboardEventField>;
  readonly composedPath: Event["composedPath"];
}

interface CommentNavigationMutationObserverIntrinsics {
  readonly Constructor: typeof MutationObserver;
  readonly observe: MutationObserver["observe"];
  readonly takeRecords: MutationObserver["takeRecords"];
  readonly disconnect: MutationObserver["disconnect"];
  readonly record: CommentNavigationNativeGetters<CommentNavigationMutationRecordField>;
  readonly nodeList: Readonly<{
    length: CommentNavigationNativeGetter;
    item: NodeList["item"];
  }>;
  readonly node: CommentNavigationNativeGetters<"nodeType" | "ownerDocument">;
}

function captureCommentNavigationGetters<const Fields extends readonly string[]>(
  prototype: object,
  fields: Fields,
): CommentNavigationNativeGetters<Fields[number]> | null {
  const entries: [Fields[number], CommentNavigationNativeGetter][] = [];
  for (const field of fields) {
    const descriptor = suggestionReflectApply(
      commentNavigationGetOwnPropertyDescriptor,
      Object,
      [prototype, field],
    ) as PropertyDescriptor | undefined;
    if (typeof descriptor?.get !== "function") return null;
    entries.push([field, descriptor.get]);
  }
  return Object.freeze(Object.fromEntries(entries)) as CommentNavigationNativeGetters<
    Fields[number]
  >;
}

function captureCommentNavigationMethod<Method>(
  prototype: object,
  name: string,
): Method | null {
  const descriptor = suggestionReflectApply(
    commentNavigationGetOwnPropertyDescriptor,
    Object,
    [prototype, name],
  ) as PropertyDescriptor | undefined;
  return typeof descriptor?.value === "function" ? (descriptor.value as Method) : null;
}

function captureCommentNavigationEventIntrinsics(
  ownerWindow: Window & typeof globalThis,
): CommentNavigationEventIntrinsics | null {
  const document = captureCommentNavigationGetters(ownerWindow.Document.prototype, [
    "activeElement",
  ] as const);
  const event = captureCommentNavigationGetters(ownerWindow.Event.prototype, [
    "type",
    "target",
    "currentTarget",
    "eventPhase",
    "bubbles",
    "cancelable",
    "defaultPrevented",
    "composed",
    "timeStamp",
  ] as const);
  const uiEvent = captureCommentNavigationGetters(ownerWindow.UIEvent.prototype, [
    "detail",
    "view",
  ] as const);
  const mouseEvent = captureCommentNavigationGetters(ownerWindow.MouseEvent.prototype, [
    "screenX",
    "screenY",
    "clientX",
    "clientY",
    "ctrlKey",
    "shiftKey",
    "altKey",
    "metaKey",
    "button",
    "buttons",
    "relatedTarget",
  ] as const);
  const focusEvent = captureCommentNavigationGetters(ownerWindow.FocusEvent.prototype, [
    "relatedTarget",
  ] as const);
  const keyboardEvent = captureCommentNavigationGetters(
    ownerWindow.KeyboardEvent.prototype,
    [
      "key",
      "code",
      "location",
      "repeat",
      "isComposing",
      "ctrlKey",
      "shiftKey",
      "altKey",
      "metaKey",
    ] as const,
  );
  const composedPath = captureCommentNavigationMethod<Event["composedPath"]>(
    ownerWindow.Event.prototype,
    "composedPath",
  );
  if (
    !document ||
    !event ||
    !uiEvent ||
    !mouseEvent ||
    !focusEvent ||
    !keyboardEvent ||
    !composedPath
  ) {
    return null;
  }
  return Object.freeze({
    document,
    event,
    uiEvent,
    mouseEvent,
    focusEvent,
    keyboardEvent,
    composedPath,
  });
}

function captureCommentNavigationMutationObserverIntrinsics(
  ownerWindow: Window & typeof globalThis,
): CommentNavigationMutationObserverIntrinsics | null {
  const Constructor = ownerWindow.MutationObserver;
  const observe = captureCommentNavigationMethod<MutationObserver["observe"]>(
    Constructor.prototype,
    "observe",
  );
  const takeRecords = captureCommentNavigationMethod<MutationObserver["takeRecords"]>(
    Constructor.prototype,
    "takeRecords",
  );
  const disconnect = captureCommentNavigationMethod<MutationObserver["disconnect"]>(
    Constructor.prototype,
    "disconnect",
  );
  const record = captureCommentNavigationGetters(ownerWindow.MutationRecord.prototype, [
    "type",
    "target",
    "previousSibling",
    "nextSibling",
    "addedNodes",
    "removedNodes",
    "attributeName",
    "oldValue",
  ] as const);
  const nodeListLength = captureCommentNavigationGetters(
    ownerWindow.NodeList.prototype,
    ["length"] as const,
  );
  const nodeListItem = captureCommentNavigationMethod<NodeList["item"]>(
    ownerWindow.NodeList.prototype,
    "item",
  );
  const node = captureCommentNavigationGetters(ownerWindow.Node.prototype, [
    "nodeType",
    "ownerDocument",
  ] as const);
  if (
    !observe ||
    !takeRecords ||
    !disconnect ||
    !record ||
    !nodeListLength ||
    !nodeListItem ||
    !node
  ) {
    return null;
  }
  return Object.freeze({
    Constructor,
    observe,
    takeRecords,
    disconnect,
    record,
    nodeList: Object.freeze({
      length: nodeListLength.length,
      item: nodeListItem,
    }),
    node,
  });
}

function commentNavigationNativeValue<Value>(
  getter: CommentNavigationNativeGetter,
  event: Event,
): Value {
  return suggestionReflectApply(getter, event, []) as Value;
}

function commentNavigationNativeTarget(
  publication: CommentNavigationPublication,
  event: Event,
): EventTarget | null {
  return commentNavigationNativeValue<EventTarget | null>(
    publication.eventIntrinsics.event.target,
    event,
  );
}

function commentNavigationNativeCurrentTarget(
  publication: CommentNavigationPublication,
  event: Event,
): EventTarget | null {
  return commentNavigationNativeValue<EventTarget | null>(
    publication.eventIntrinsics.event.currentTarget,
    event,
  );
}

function commentNavigationNativeComposedPath(
  publication: CommentNavigationPublication,
  event: Event,
): EventTarget[] {
  return suggestionReflectApply(
    publication.eventIntrinsics.composedPath,
    event,
    [],
  ) as EventTarget[];
}

function commentNavigationNativeDefaultPrevented(
  publication: CommentNavigationPublication,
  event: Event,
): boolean {
  return commentNavigationNativeValue<boolean>(
    publication.eventIntrinsics.event.defaultPrevented,
    event,
  );
}

function commentNavigationActiveElement(
  publication: CommentNavigationPublication,
): Element | null {
  return suggestionReflectApply(
    publication.eventIntrinsics.document.activeElement,
    publication.ownerDocument,
    [],
  ) as Element | null;
}

interface CommentNavigationMutationRecordSnapshot {
  readonly type: MutationRecordType;
  readonly target: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
  readonly addedNodes: readonly Node[];
  readonly removedNodes: readonly Node[];
  readonly attributeName: string | null;
  readonly oldValue: string | null;
}

function snapshotCommentNavigationMutationRecord(
  record: MutationRecord,
  intrinsics: CommentNavigationMutationObserverIntrinsics,
  ownerDocument: Document,
): CommentNavigationMutationRecordSnapshot | null {
  try {
    const get = <Value,>(field: CommentNavigationMutationRecordField) =>
      suggestionReflectApply(intrinsics.record[field], record, []) as Value;
    const exactNode = (value: unknown): value is Node => {
      if ((typeof value !== "object" && typeof value !== "function") || value === null) {
        return false;
      }
      const nodeType = suggestionReflectApply(
        intrinsics.node.nodeType,
        value,
        [],
      ) as number;
      const document = suggestionReflectApply(
        intrinsics.node.ownerDocument,
        value,
        [],
      );
      return (
        Number.isSafeInteger(nodeType) &&
        nodeType >= 1 &&
        nodeType <= 12 &&
        document === ownerDocument
      );
    };
    const snapshotNodes = (nodes: NodeList): readonly Node[] | null => {
      const length = suggestionReflectApply(
        intrinsics.nodeList.length,
        nodes,
        [],
      ) as number;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > COMMENT_NAVIGATION_MAX_MUTATION_NODES
      ) {
        return null;
      }
      const snapshot: Node[] = [];
      for (let index = 0; index < length; index += 1) {
        const item = suggestionReflectApply(intrinsics.nodeList.item, nodes, [
          index,
        ]) as unknown;
        const indexed = suggestionReflectApply(commentNavigationReflectGet, Reflect, [
          nodes,
          String(index),
          nodes,
        ]) as unknown;
        if (item !== indexed || !exactNode(item)) return null;
        snapshot[index] = item;
      }
      const terminalItem = suggestionReflectApply(intrinsics.nodeList.item, nodes, [
        length,
      ]) as unknown;
      const terminalIndex = suggestionReflectApply(
        commentNavigationReflectGet,
        Reflect,
        [nodes, String(length), nodes],
      ) as unknown;
      if (terminalItem !== null || terminalIndex !== undefined) return null;
      return Object.freeze(snapshot);
    };
    const target = get<unknown>("target");
    const previousSibling = get<unknown>("previousSibling");
    const nextSibling = get<unknown>("nextSibling");
    const addedNodes = snapshotNodes(get<NodeList>("addedNodes"));
    const removedNodes = snapshotNodes(get<NodeList>("removedNodes"));
    if (
      !exactNode(target) ||
      (previousSibling !== null && !exactNode(previousSibling)) ||
      (nextSibling !== null && !exactNode(nextSibling)) ||
      !addedNodes ||
      !removedNodes
    ) {
      return null;
    }
    return Object.freeze({
      type: get<MutationRecordType>("type"),
      target,
      previousSibling,
      nextSibling,
      addedNodes,
      removedNodes,
      attributeName: get<string | null>("attributeName"),
      oldValue: get<string | null>("oldValue"),
    });
  } catch {
    return null;
  }
}

interface CommentNavigationTabFacts {
  readonly index: number;
  readonly id: Tab;
  readonly label: string;
  readonly count: number;
}

interface CommentNavigationTabPresentation extends CommentNavigationTabFacts {
  readonly buttonId: string;
  readonly className: string;
  readonly selected: boolean;
  readonly tabIndex: 0 | -1;
  readonly testId: string;
}

interface CommentNavigationPresentation {
  readonly panelClassName: string;
  readonly panelTestId: string;
  readonly headerClassName: string;
  readonly titleClassName: string;
  readonly title: string;
  readonly closeClassName: string;
  readonly closeLabel: string;
  readonly navRowClassName: string;
  readonly tablistClassName: string;
  readonly tablistLabel: string;
  readonly tablistOrientation: "horizontal";
  readonly tabs: readonly CommentNavigationTabPresentation[];
  readonly tabpanelClassName: string;
  readonly tabpanelId: string;
  readonly tabpanelLabelledBy: string;
  readonly emptySuggestions: Readonly<{
    containerClassName: string;
    containerTestId: string;
    buttonClassName: string;
    buttonTestId: string;
    label: string;
  }> | null;
}

interface CommentNavigationAuthority {
  readonly mount: symbol;
  readonly session: CollabSession;
  readonly documentId: string;
  readonly selectedTab: Tab;
  readonly tabs: readonly CommentNavigationTabFacts[];
  readonly canComment: boolean;
  readonly onSelect: (tab: Tab) => void;
  readonly onClose: () => void;
  readonly rowActions: CommentRowActionCoordinator;
  readonly presentation: CommentNavigationPresentation;
}

type CommentNavigationActionKind = "close" | "tab" | "empty-suggestions" | "keyboard";
type CommentNavigationNativeType = "click" | "focusin" | "keydown";

interface CommentNavigationAction {
  readonly identity: symbol;
  readonly renderIdentity: symbol;
  readonly kind: CommentNavigationActionKind;
  readonly tab: Tab | null;
  readonly index: number;
  readonly onClickCapture: ((event: MouseEvent<HTMLElement>) => void) | null;
  readonly onClick: ((event: MouseEvent<HTMLElement>) => void) | null;
  readonly onFocusCapture: ((event: FocusEvent<HTMLElement>) => void) | null;
  readonly onFocus: ((event: FocusEvent<HTMLElement>) => void) | null;
  readonly onKeyDownCapture: ((event: KeyboardEvent<HTMLElement>) => void) | null;
  readonly onKeyDown: ((event: KeyboardEvent<HTMLElement>) => void) | null;
}

interface CommentNavigationElements {
  readonly panel: HTMLElement;
  readonly header: HTMLDivElement;
  readonly title: HTMLSpanElement;
  readonly close: HTMLButtonElement;
  readonly navRow: HTMLDivElement;
  readonly tablist: HTMLDivElement;
  readonly tabs: readonly HTMLButtonElement[];
  readonly tabpanel: HTMLDivElement;
  readonly emptyContainer: HTMLSpanElement | null;
  readonly emptySuggestions: HTMLButtonElement | null;
}

interface CommentNavigationNodePlacement {
  readonly node: Node;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface CommentNavigationPlacement {
  readonly document: Document;
  readonly chain: readonly CommentNavigationNodePlacement[];
}

interface CommentNavigationDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface CommentNavigationSelectiveDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly CommentNavigationSelectiveDomSnapshot[] | null;
}

interface CommentNavigationDomSnapshot {
  readonly shell: CommentNavigationSelectiveDomSnapshot;
  readonly emptySuggestions: SuggestionActionDomSnapshot | null;
  readonly emptyPlacement: CommentNavigationPlacement | null;
}

interface CommentNavigationPublication {
  readonly identity: symbol;
  readonly render: CommentNavigationRender;
  readonly authority: CommentNavigationAuthority;
  readonly elements: CommentNavigationElements;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window;
  readonly constructors: Readonly<{
    Event: typeof Event;
    MouseEvent: typeof globalThis.MouseEvent;
    FocusEvent: typeof globalThis.FocusEvent;
    KeyboardEvent: typeof globalThis.KeyboardEvent;
    Node: typeof Node;
  }>;
  readonly focus: typeof HTMLElement.prototype.focus;
  readonly windowAddEventListener: Window["addEventListener"];
  readonly windowRemoveEventListener: Window["removeEventListener"];
  readonly eventIntrinsics: CommentNavigationEventIntrinsics;
  readonly mutationObserverIntrinsics: CommentNavigationMutationObserverIntrinsics;
  readonly dom: CommentNavigationDomSnapshot;
  readonly placement: CommentNavigationPlacement;
}

interface CommentNavigationElementOwnerView {
  readonly element: () => HTMLElement | null;
}

interface CommentNavigationRefReplay {
  readonly owner: CommentNavigationElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
  handoffDetached: boolean;
}

interface CommentNavigationReplay {
  readonly source: CommentNavigationPublication;
  readonly dom: CommentNavigationDomSnapshot;
  readonly placement: CommentNavigationPlacement;
  readonly historyIsClean: () => boolean;
  readonly refsAreExact: () => boolean;
  readonly release: () => void;
}

interface CommentNavigationCells {
  readonly active: { current: CommentNavigationPublication | null };
  readonly successorOf: { current: CommentNavigationPublication | null };
  readonly replay: { current: CommentNavigationReplay | null };
  readonly retired: WeakSet<CommentNavigationPublication>;
  readonly claimedPublications: WeakSet<CommentNavigationPublication>;
  readonly claimedActions: WeakSet<CommentNavigationAction>;
  readonly claimedControls: WeakMap<HTMLElement, WeakSet<CommentNavigationPublication>>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
}

interface CommentNavigationNativeSnapshot {
  readonly event: Event;
  readonly publication: CommentNavigationPublication;
  readonly action: CommentNavigationAction;
  readonly control: HTMLElement;
  readonly target: Node;
  readonly path: readonly EventTarget[];
  readonly type: CommentNavigationNativeType;
  readonly reactType: "click" | "focus" | "keydown";
  readonly nextTab: Tab | null;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly composed: boolean;
  readonly timeStamp: number;
  readonly mouse: Readonly<{
    button: number;
    buttons: number;
    detail: number;
    clientX: number;
    clientY: number;
    screenX: number;
    screenY: number;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    relatedTarget: EventTarget | null;
    view: Window | null;
  }> | null;
  readonly focus: Readonly<{
    relatedTarget: EventTarget | null;
    view: Window | null;
    activeElement: Element | null;
  }> | null;
  readonly keyboard: Readonly<{
    key: string;
    code: string;
    location: number;
    repeat: boolean;
    isComposing: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    activeElement: Element | null;
  }> | null;
}

function commentNavigationControlIsClaimed(
  cells: CommentNavigationCells,
  publication: CommentNavigationPublication,
  control: HTMLElement,
): boolean {
  return cells.claimedControls.get(control)?.has(publication) ?? false;
}

function claimCommentNavigationControl(
  cells: CommentNavigationCells,
  publication: CommentNavigationPublication,
  control: HTMLElement,
) {
  let publications = cells.claimedControls.get(control);
  if (!publications) {
    publications = new WeakSet();
    cells.claimedControls.set(control, publications);
  }
  publications.add(publication);
}

interface CommentNavigationNativeDelivery {
  readonly snapshot: CommentNavigationNativeSnapshot;
  delegationTarget: EventTarget | null;
  crossedPanel: boolean;
  captureInvalid: boolean;
  captureRootEvent: object | null;
  captureActionEvent: object | null;
  captureRootCount: number;
  captureActionCount: number;
  bubbleInvalid: boolean;
  bubbleActionEvent: object | null;
  bubbleRootEvent: object | null;
  bubbleActionCount: number;
  bubbleRootCount: number;
}

type CommentNavigationReactEvent =
  | MouseEvent<HTMLElement>
  | FocusEvent<HTMLElement>
  | KeyboardEvent<HTMLElement>;

interface CommentNavigationPublicationRuntime {
  readonly publication: CommentNavigationPublication;
  readonly publish: (owners: readonly CommentNavigationElementOwnerView[]) => boolean;
  readonly stageCaptureRoot: (event: CommentNavigationReactEvent) => void;
  readonly stageCaptureAction: (action: CommentNavigationAction, event: CommentNavigationReactEvent) => void;
  readonly stageBubbleAction: (action: CommentNavigationAction, event: CommentNavigationReactEvent) => void;
  readonly stageBubbleRoot: (event: CommentNavigationReactEvent) => void;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly retireForAction: () => void;
  readonly noteRef: (
    owner: CommentNavigationElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly stageSuccessorHandoff: () => boolean;
  readonly successorHandoffIsExact: () => boolean;
  readonly mutationHistoryIsClean: () => boolean;
  readonly release: () => void;
}

interface CommentNavigationRender {
  readonly identity: symbol;
  readonly authority: CommentNavigationAuthority;
  readonly close: CommentNavigationAction;
  readonly tabs: readonly CommentNavigationAction[];
  readonly emptySuggestions: CommentNavigationAction | null;
  readonly keyboard: CommentNavigationAction;
  readonly capturePanel: (element: HTMLElement | null) => void;
  readonly captureHeader: (element: HTMLDivElement | null) => void;
  readonly captureTitle: (element: HTMLSpanElement | null) => void;
  readonly captureClose: (element: HTMLButtonElement | null) => void;
  readonly captureNavRow: (element: HTMLDivElement | null) => void;
  readonly captureTablist: (element: HTMLDivElement | null) => void;
  readonly captureTabs: readonly ((element: HTMLButtonElement | null) => void)[];
  readonly captureTabpanel: (element: HTMLDivElement | null) => void;
  readonly captureEmptyContainer: ((element: HTMLSpanElement | null) => void) | null;
  readonly captureEmptySuggestions: ((element: HTMLButtonElement | null) => void) | null;
  readonly onPanelClickCapture: (event: MouseEvent<HTMLElement>) => void;
  readonly onPanelClick: (event: MouseEvent<HTMLElement>) => void;
  readonly onPanelFocusCapture: (event: FocusEvent<HTMLElement>) => void;
  readonly onPanelFocus: (event: FocusEvent<HTMLElement>) => void;
  readonly onPanelKeyDownCapture: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onPanelKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly establish: () => void | (() => void);
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
  readonly focusSelected: () => boolean;
}

class CommentNavigationElementOwner<T extends HTMLElement>
  implements CommentNavigationElementOwnerView
{
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: CommentNavigationElementOwnerView,
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

function commentNavigationPresentation(
  selectedTab: Tab,
  tabs: readonly CommentNavigationTabFacts[],
  showEmptySuggestions: boolean,
): CommentNavigationPresentation {
  return Object.freeze({
    panelClassName: COMMENTS_PANEL_CLASS,
    panelTestId: "comments-panel",
    headerClassName: COMMENTS_HEADER_CLASS,
    titleClassName: "pane-label",
    title: "Comments",
    closeClassName: COMMENTS_CLOSE_CLASS,
    closeLabel: "Close comments",
    navRowClassName: COMMENTS_NAV_ROW_CLASS,
    tablistClassName: COMMENTS_TABLIST_CLASS,
    tablistLabel: "Comment lists",
    tablistOrientation: "horizontal",
    tabs: Object.freeze(
      tabs.map((tab) =>
        Object.freeze({
          ...tab,
          buttonId: `comments-tab-${tab.id}`,
          className: cn(
            COMMENTS_TAB_BASE_CLASS,
            selectedTab === tab.id ? COMMENTS_TAB_SELECTED_CLASS : COMMENTS_TAB_IDLE_CLASS,
          ),
          selected: selectedTab === tab.id,
          tabIndex: selectedTab === tab.id ? 0 : -1,
          testId: `comments-tab-${tab.id}`,
        }),
      ),
    ),
    tabpanelClassName: COMMENTS_TABPANEL_CLASS,
    tabpanelId: "comments-tabpanel",
    tabpanelLabelledBy: `comments-tab-${selectedTab}`,
    emptySuggestions: showEmptySuggestions
      ? Object.freeze({
          containerClassName: COMMENTS_EMPTY_SUGGESTIONS_CLASS,
          containerTestId: "comments-empty-suggestions",
          buttonClassName: COMMENTS_EMPTY_SUGGESTIONS_BUTTON_CLASS,
          buttonTestId: "comments-empty-suggestions-button",
          label: `${tabs[2]!.count} ${tabs[2]!.count === 1 ? "suggestion" : "suggestions"} waiting`,
        })
      : null,
  });
}

function commentNavigationPresentationsMatch(
  previous: CommentNavigationPresentation,
  current: CommentNavigationPresentation,
): boolean {
  const previousEmpty = previous.emptySuggestions;
  const currentEmpty = current.emptySuggestions;
  return (
    previous.panelClassName === current.panelClassName &&
    previous.panelTestId === current.panelTestId &&
    previous.headerClassName === current.headerClassName &&
    previous.titleClassName === current.titleClassName &&
    previous.title === current.title &&
    previous.closeClassName === current.closeClassName &&
    previous.closeLabel === current.closeLabel &&
    previous.navRowClassName === current.navRowClassName &&
    previous.tablistClassName === current.tablistClassName &&
    previous.tablistLabel === current.tablistLabel &&
    previous.tablistOrientation === current.tablistOrientation &&
    previous.tabpanelClassName === current.tabpanelClassName &&
    previous.tabpanelId === current.tabpanelId &&
    previous.tabpanelLabelledBy === current.tabpanelLabelledBy &&
    previous.tabs.length === current.tabs.length &&
    previous.tabs.every((tab, index) => {
      const next = current.tabs[index];
      return Boolean(
        next &&
          tab.index === next.index &&
          tab.id === next.id &&
          tab.label === next.label &&
          tab.count === next.count &&
          tab.buttonId === next.buttonId &&
          tab.className === next.className &&
          tab.selected === next.selected &&
          tab.tabIndex === next.tabIndex &&
          tab.testId === next.testId,
      );
    }) &&
    (previousEmpty === currentEmpty ||
      Boolean(
        previousEmpty &&
          currentEmpty &&
          previousEmpty.containerClassName === currentEmpty.containerClassName &&
          previousEmpty.containerTestId === currentEmpty.containerTestId &&
          previousEmpty.buttonClassName === currentEmpty.buttonClassName &&
          previousEmpty.buttonTestId === currentEmpty.buttonTestId &&
          previousEmpty.label === currentEmpty.label,
      ))
  );
}

function commentNavigationAuthoritiesMatch(
  previous: CommentNavigationAuthority,
  current: CommentNavigationAuthority,
): boolean {
  return (
    previous.mount === current.mount &&
    previous.session === current.session &&
    previous.documentId === current.documentId &&
    previous.selectedTab === current.selectedTab &&
    previous.canComment === current.canComment &&
    previous.onSelect === current.onSelect &&
    previous.onClose === current.onClose &&
    previous.rowActions === current.rowActions &&
    previous.tabs.length === current.tabs.length &&
    previous.tabs.every((tab, index) => {
      const next = current.tabs[index];
      return Boolean(
        next &&
          tab.index === next.index &&
          tab.id === next.id &&
          tab.label === next.label &&
          tab.count === next.count,
      );
    }) &&
    commentNavigationPresentationsMatch(previous.presentation, current.presentation)
  );
}

function commentNavigationFactsAreCurrent(authority: CommentNavigationAuthority): boolean {
  const { presentation, session, tabs } = authority;
  return (
    session.docId === authority.documentId &&
    session.canComment === authority.canComment &&
    authority.rowActions.session === session &&
    authority.rowActions.documentId === authority.documentId &&
    authority.rowActions.mounted &&
    tabs.length === 3 &&
    tabs[0]?.index === 0 &&
    tabs[0]?.id === "open" &&
    tabs[0]?.label === "Open" &&
    tabs[1]?.index === 1 &&
    tabs[1]?.id === "resolved" &&
    tabs[1]?.label === "Resolved" &&
    tabs[2]?.index === 2 &&
    tabs[2]?.id === "suggestions" &&
    tabs[2]?.label === "Suggestions" &&
    tabs.every((tab) => Number.isSafeInteger(tab.count) && tab.count >= 0) &&
    tabs.some((tab) => tab.id === authority.selectedTab) &&
    commentNavigationPresentationsMatch(
      presentation,
      commentNavigationPresentation(
        authority.selectedTab,
        tabs,
        presentation.emptySuggestions !== null,
      ),
    )
  );
}

function captureCommentNavigationPlacement(panel: HTMLElement): CommentNavigationPlacement | null {
  const document = panel.ownerDocument;
  if (!panel.isConnected) return null;
  const chain: CommentNavigationNodePlacement[] = [];
  let node: Node = panel;
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

function commentNavigationPlacementMatches(
  root: Node,
  placement: CommentNavigationPlacement,
): boolean {
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

function commentNavigationPlacementMutationIsRelevant(
  record: CommentNavigationMutationRecordSnapshot,
  placement: CommentNavigationPlacement,
): boolean {
  if (record.type !== "childList") {
    return placement.chain.some(({ node }) => record.target === node);
  }
  return placement.chain.some(({ node, parent }) => {
    if (record.target !== parent) return false;
    const collectionContains = (nodes: readonly Node[]) => {
      for (let index = 0; index < nodes.length; index += 1) {
        const changed = nodes[index]!;
        if (changed === node || changed.contains?.(node)) return true;
      }
      return false;
    };
    return (
      record.previousSibling === node ||
      record.nextSibling === node ||
      collectionContains(record.addedNodes) ||
      collectionContains(record.removedNodes)
    );
  });
}

function snapshotCommentNavigationSelectiveDom(
  node: Node,
  openContent: Node,
): CommentNavigationSelectiveDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: suggestionActionSnapshotAttributes(node),
    children:
      node === openContent
        ? null
        : Object.freeze(
            [...node.childNodes].map((child) =>
              snapshotCommentNavigationSelectiveDom(child, openContent),
            ),
          ),
  });
}

function commentNavigationSelectiveDomMatches(
  snapshot: CommentNavigationSelectiveDomSnapshot,
): boolean {
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
  if (snapshot.children === null) return true;
  return (
    node.childNodes.length === snapshot.children.length &&
    snapshot.children.every(
      (child, index) =>
        node.childNodes.item(index) === child.node &&
        commentNavigationSelectiveDomMatches(child),
    )
  );
}

function commentNavigationSelectiveDomEntry(
  snapshot: CommentNavigationSelectiveDomSnapshot,
  target: Node,
): CommentNavigationSelectiveDomSnapshot | null {
  if (snapshot.node === target) return snapshot;
  if (snapshot.children === null) return null;
  for (const child of snapshot.children) {
    const entry = commentNavigationSelectiveDomEntry(child, target);
    if (entry) return entry;
  }
  return null;
}

function commentNavigationDomContains(
  snapshot: CommentNavigationDomSnapshot,
  target: Node,
): boolean {
  return (
    commentNavigationSelectiveDomEntry(snapshot.shell, target) !== null ||
    Boolean(
      snapshot.emptySuggestions &&
        suggestionActionDomContains(snapshot.emptySuggestions, target),
    )
  );
}

function snapshotCommentNavigationDom(
  elements: CommentNavigationElements,
): CommentNavigationDomSnapshot | null {
  const emptyPlacement = elements.emptyContainer
    ? captureCommentNavigationPlacement(elements.emptyContainer)
    : null;
  if (elements.emptyContainer && !emptyPlacement) return null;
  return Object.freeze({
    shell: snapshotCommentNavigationSelectiveDom(elements.panel, elements.tabpanel),
    emptySuggestions: elements.emptyContainer
      ? snapshotSuggestionActionDom(elements.emptyContainer)
      : null,
    emptyPlacement,
  });
}

function commentNavigationDomMatches(snapshot: CommentNavigationDomSnapshot): boolean {
  return (
    commentNavigationSelectiveDomMatches(snapshot.shell) &&
    (!snapshot.emptySuggestions ||
      suggestionActionDomMatches(snapshot.emptySuggestions)) &&
    (!snapshot.emptyPlacement ||
      commentNavigationPlacementMatches(
        snapshot.emptySuggestions!.node,
        snapshot.emptyPlacement,
      ))
  );
}

function commentNavigationDomMutationIsRelevant(
  record: CommentNavigationMutationRecordSnapshot,
  dom: CommentNavigationDomSnapshot,
): boolean {
  const shellEntry = commentNavigationSelectiveDomEntry(dom.shell, record.target);
  if (shellEntry && (record.type !== "childList" || shellEntry.children !== null)) {
    return true;
  }
  if (
    dom.emptySuggestions &&
    suggestionActionDomContains(dom.emptySuggestions, record.target)
  ) {
    return true;
  }
  return Boolean(
    dom.emptyPlacement &&
      commentNavigationPlacementMutationIsRelevant(record, dom.emptyPlacement),
  );
}

function createCommentNavigationDomGuard(
  dom: CommentNavigationDomSnapshot,
  placement: CommentNavigationPlacement,
  intrinsics: CommentNavigationMutationObserverIntrinsics,
  onChange: () => void,
): CommentNavigationDomGuard | null {
  let changed = false;
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    for (let index = 0; index < records.length; index += 1) {
      const record = snapshotCommentNavigationMutationRecord(
        records[index]!,
        intrinsics,
        placement.document,
      );
      if (
        !record ||
        commentNavigationDomMutationIsRelevant(record, dom) ||
        commentNavigationPlacementMutationIsRelevant(record, placement)
      ) {
        changed = true;
        onChange();
        return;
      }
    }
  };
  const observer = new intrinsics.Constructor(recordChanges);
  suggestionReflectApply(intrinsics.observe, observer, [
    placement.document,
    {
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
      childList: true,
      subtree: true,
    },
  ]);
  return Object.freeze({
    isClean: () => {
      recordChanges(
        suggestionReflectApply(intrinsics.takeRecords, observer, []) as MutationRecord[],
      );
      return !changed;
    },
    release: () => {
      recordChanges(
        suggestionReflectApply(intrinsics.takeRecords, observer, []) as MutationRecord[],
      );
      suggestionReflectApply(intrinsics.disconnect, observer, []);
    },
  });
}

function currentCommentNavigationElements(
  authority: CommentNavigationAuthority,
  owners: Readonly<{
    panel: CommentNavigationElementOwner<HTMLElement>;
    header: CommentNavigationElementOwner<HTMLDivElement>;
    title: CommentNavigationElementOwner<HTMLSpanElement>;
    close: CommentNavigationElementOwner<HTMLButtonElement>;
    navRow: CommentNavigationElementOwner<HTMLDivElement>;
    tablist: CommentNavigationElementOwner<HTMLDivElement>;
    tabs: readonly CommentNavigationElementOwner<HTMLButtonElement>[];
    tabpanel: CommentNavigationElementOwner<HTMLDivElement>;
    emptyContainer: CommentNavigationElementOwner<HTMLSpanElement> | null;
    emptySuggestions: CommentNavigationElementOwner<HTMLButtonElement> | null;
  }>,
): CommentNavigationElements | null {
  const panel = owners.panel.element();
  const ownerDocument = panel?.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView;
  if (!panel || !ownerDocument || !ownerWindow || !(panel instanceof ownerWindow.HTMLElement)) return null;
  const header = owners.header.element();
  const title = owners.title.element();
  const close = owners.close.element();
  const navRow = owners.navRow.element();
  const tablist = owners.tablist.element();
  const tabs = owners.tabs.map((owner) => owner.element());
  const tabpanel = owners.tabpanel.element();
  const emptyContainer = owners.emptyContainer?.element() ?? null;
  const emptySuggestions = owners.emptySuggestions?.element() ?? null;
  if (
    !header ||
    !title ||
    !close ||
    !navRow ||
    !tablist ||
    tabs.some((button) => !button) ||
    !tabpanel
  ) {
    return null;
  }
  const exactTabs = tabs as HTMLButtonElement[];
  const { presentation } = authority;
  const sameDocument = [
    panel,
    header,
    title,
    close,
    navRow,
    tablist,
    ...exactTabs,
    tabpanel,
    ...(emptyContainer ? [emptyContainer] : []),
    ...(emptySuggestions ? [emptySuggestions] : []),
  ].every((element) => element.ownerDocument === ownerDocument && element.isConnected);
  if (
    !sameDocument ||
    panel.tagName !== "ASIDE" ||
    panel.className !== presentation.panelClassName ||
    panel.dataset.testid !== presentation.panelTestId ||
    panel.children.length !== 3 ||
    panel.children.item(0) !== header ||
    panel.children.item(1) !== navRow ||
    panel.children.item(2) !== tabpanel ||
    header.parentElement !== panel ||
    header.tagName !== "DIV" ||
    header.className !== presentation.headerClassName ||
    header.children.length !== 2 ||
    header.children.item(0) !== title ||
    header.children.item(1) !== close ||
    title.parentElement !== header ||
    title.tagName !== "SPAN" ||
    title.className !== presentation.titleClassName ||
    title.textContent !== presentation.title ||
    close.parentElement !== header ||
    close.tagName !== "BUTTON" ||
    close.type !== "button" ||
    close.className !== presentation.closeClassName ||
    close.getAttribute("aria-label") !== presentation.closeLabel ||
    !commentNavigationControlIsEnabled(close) ||
    navRow.parentElement !== panel ||
    navRow.tagName !== "DIV" ||
    navRow.className !== presentation.navRowClassName ||
    navRow.children.length !== (authority.canComment ? 2 : 1) ||
    navRow.children.item(0) !== tablist ||
    tablist.parentElement !== navRow ||
    tablist.tagName !== "DIV" ||
    tablist.className !== presentation.tablistClassName ||
    tablist.getAttribute("role") !== "tablist" ||
    tablist.getAttribute("aria-label") !== presentation.tablistLabel ||
    tablist.getAttribute("aria-orientation") !== presentation.tablistOrientation ||
    tablist.children.length !== presentation.tabs.length ||
    tabpanel.parentElement !== panel ||
    tabpanel.tagName !== "DIV" ||
    tabpanel.className !== presentation.tabpanelClassName ||
    tabpanel.id !== presentation.tabpanelId ||
    tabpanel.getAttribute("role") !== "tabpanel" ||
    tabpanel.getAttribute("aria-labelledby") !== presentation.tabpanelLabelledBy
  ) {
    return null;
  }
  for (const tabPresentation of presentation.tabs) {
    const button = exactTabs[tabPresentation.index];
    if (
      !button ||
      tablist.children.item(tabPresentation.index) !== button ||
      button.parentElement !== tablist ||
      button.tagName !== "BUTTON" ||
      button.type !== "button" ||
      button.id !== tabPresentation.buttonId ||
      button.className !== tabPresentation.className ||
      button.dataset.testid !== tabPresentation.testId ||
      button.getAttribute("role") !== "tab" ||
      button.getAttribute("aria-selected") !== String(tabPresentation.selected) ||
      button.getAttribute("aria-controls") !== presentation.tabpanelId ||
      button.tabIndex !== tabPresentation.tabIndex ||
      button.textContent !== `${tabPresentation.label}${tabPresentation.count > 0 ? tabPresentation.count : ""}` ||
      !commentNavigationControlIsEnabled(button)
    ) {
      return null;
    }
  }
  const emptyPresentation = presentation.emptySuggestions;
  if (!emptyPresentation) {
    if (emptyContainer || emptySuggestions) return null;
  } else if (
    !emptyContainer ||
    !emptySuggestions ||
    emptyContainer.tagName !== "SPAN" ||
    emptyContainer.className !== emptyPresentation.containerClassName ||
    emptyContainer.dataset.testid !== emptyPresentation.containerTestId ||
    !tabpanel.contains(emptyContainer) ||
    emptyContainer.children.length !== 1 ||
    emptyContainer.children.item(0) !== emptySuggestions ||
    emptySuggestions.parentElement !== emptyContainer ||
    emptySuggestions.tagName !== "BUTTON" ||
    emptySuggestions.type !== "button" ||
    emptySuggestions.className !== emptyPresentation.buttonClassName ||
    emptySuggestions.dataset.testid !== emptyPresentation.buttonTestId ||
    emptySuggestions.textContent?.trim().replace(/\s+/g, " ") !== emptyPresentation.label ||
    !commentNavigationControlIsEnabled(emptySuggestions)
  ) {
    return null;
  }
  return Object.freeze({
    panel,
    header,
    title,
    close,
    navRow,
    tablist,
    tabs: Object.freeze(exactTabs),
    tabpanel,
    emptyContainer,
    emptySuggestions,
  });
}

function commentNavigationElementsAreSame(
  current: CommentNavigationElements,
  published: CommentNavigationElements,
): boolean {
  return (
    current.panel === published.panel &&
    current.header === published.header &&
    current.title === published.title &&
    current.close === published.close &&
    current.navRow === published.navRow &&
    current.tablist === published.tablist &&
    current.tabpanel === published.tabpanel &&
    current.emptyContainer === published.emptyContainer &&
    current.emptySuggestions === published.emptySuggestions &&
    current.tabs.length === published.tabs.length &&
    current.tabs.every((button, index) => button === published.tabs[index])
  );
}

function addCommentNavigationListener(
  target: EventTarget,
  type: CommentNavigationNativeType,
  listener: EventListener,
  options?: boolean,
) {
  const intrinsic =
    target === suggestionGlobalWindow && suggestionWindowAddEventListener
      ? suggestionWindowAddEventListener
      : suggestionAddEventListener;
  suggestionReflectApply(intrinsic, target, [type, listener, options]);
}

function removeCommentNavigationListener(
  target: EventTarget,
  type: CommentNavigationNativeType,
  listener: EventListener,
  options?: boolean,
) {
  const intrinsic =
    target === suggestionGlobalWindow && suggestionWindowRemoveEventListener
      ? suggestionWindowRemoveEventListener
      : suggestionRemoveEventListener;
  if (!intrinsic) return;
  suggestionReflectApply(intrinsic, target, [type, listener, options]);
}

function commentNavigationControlIsEnabled(control: HTMLElement): boolean {
  const Button = control.ownerDocument.defaultView?.HTMLButtonElement;
  if (
    (Button && control instanceof Button && control.disabled) ||
    control.matches(":disabled") ||
    control.getAttribute("aria-disabled")?.toLowerCase() === "true"
  ) {
    return false;
  }
  for (let element: HTMLElement | null = control; element; element = element.parentElement) {
    if (
      element.hasAttribute("inert") ||
      element.getAttribute("aria-disabled")?.toLowerCase() === "true"
    ) {
      return false;
    }
  }
  return true;
}

function commentNavigationActionControl(
  publication: CommentNavigationPublication,
  action: CommentNavigationAction,
): HTMLElement | null {
  if (action.renderIdentity !== publication.render.identity) return null;
  if (action.kind === "close") {
    return publication.render.close === action ? publication.elements.close : null;
  }
  if (action.kind === "tab") {
    return publication.render.tabs[action.index] === action
      ? publication.elements.tabs[action.index] ?? null
      : null;
  }
  if (action.kind === "empty-suggestions") {
    return publication.render.emptySuggestions === action
      ? publication.elements.emptySuggestions
      : null;
  }
  return publication.render.keyboard === action ? publication.elements.tablist : null;
}

function commentNavigationNativeSnapshotMatches(
  delivery: CommentNavigationNativeDelivery,
): boolean {
  const { snapshot } = delivery;
  const { event, publication, target } = snapshot;
  const { constructors } = publication;
  const { event: eventGetters } = publication.eventIntrinsics;
  if (
    !(event instanceof constructors.Event) ||
    commentNavigationNativeValue<string>(eventGetters.type, event) !== snapshot.type ||
    commentNavigationNativeValue<boolean>(eventGetters.bubbles, event) !==
      snapshot.bubbles ||
    commentNavigationNativeValue<boolean>(eventGetters.cancelable, event) !==
      snapshot.cancelable ||
    commentNavigationNativeValue<boolean>(eventGetters.composed, event) !==
      snapshot.composed ||
    commentNavigationNativeValue<number>(eventGetters.timeStamp, event) !==
      snapshot.timeStamp ||
    commentNavigationNativeTarget(publication, event) !== target ||
    commentNavigationNativeDefaultPrevented(publication, event)
  ) {
    return false;
  }
  const currentPath = commentNavigationNativeComposedPath(publication, event);
  if (
    currentPath.length !== snapshot.path.length ||
    snapshot.path.some((entry, index) => currentPath[index] !== entry)
  ) {
    return false;
  }
  if (snapshot.type === "click") {
    const mouse = snapshot.mouse;
    if (!mouse || !(event instanceof constructors.MouseEvent)) return false;
    const { mouseEvent, uiEvent } = publication.eventIntrinsics;
    return (
      commentNavigationNativeValue<number>(mouseEvent.button, event) === mouse.button &&
      commentNavigationNativeValue<number>(mouseEvent.buttons, event) ===
        mouse.buttons &&
      commentNavigationNativeValue<number>(uiEvent.detail, event) === mouse.detail &&
      commentNavigationNativeValue<number>(mouseEvent.clientX, event) ===
        mouse.clientX &&
      commentNavigationNativeValue<number>(mouseEvent.clientY, event) ===
        mouse.clientY &&
      commentNavigationNativeValue<number>(mouseEvent.screenX, event) ===
        mouse.screenX &&
      commentNavigationNativeValue<number>(mouseEvent.screenY, event) ===
        mouse.screenY &&
      commentNavigationNativeValue<boolean>(mouseEvent.ctrlKey, event) ===
        mouse.ctrlKey &&
      commentNavigationNativeValue<boolean>(mouseEvent.shiftKey, event) ===
        mouse.shiftKey &&
      commentNavigationNativeValue<boolean>(mouseEvent.altKey, event) === mouse.altKey &&
      commentNavigationNativeValue<boolean>(mouseEvent.metaKey, event) ===
        mouse.metaKey &&
      commentNavigationNativeValue<EventTarget | null>(
        mouseEvent.relatedTarget,
        event,
      ) === mouse.relatedTarget &&
      commentNavigationNativeValue<Window | null>(uiEvent.view, event) === mouse.view
    );
  }
  if (snapshot.type === "focusin") {
    const focus = snapshot.focus;
    const { focusEvent, uiEvent } = publication.eventIntrinsics;
    return Boolean(
      focus &&
        event instanceof constructors.FocusEvent &&
        commentNavigationNativeValue<EventTarget | null>(
          focusEvent.relatedTarget,
          event,
        ) === focus.relatedTarget &&
        commentNavigationNativeValue<Window | null>(uiEvent.view, event) === focus.view &&
        focus.activeElement === snapshot.control &&
        commentNavigationActiveElement(publication) === focus.activeElement,
    );
  }
  const keyboard = snapshot.keyboard;
  const { keyboardEvent } = publication.eventIntrinsics;
  return Boolean(
    keyboard &&
      event instanceof constructors.KeyboardEvent &&
      commentNavigationNativeValue<string>(keyboardEvent.key, event) === keyboard.key &&
      commentNavigationNativeValue<string>(keyboardEvent.code, event) === keyboard.code &&
      commentNavigationNativeValue<number>(keyboardEvent.location, event) ===
        keyboard.location &&
      commentNavigationNativeValue<boolean>(keyboardEvent.repeat, event) ===
        keyboard.repeat &&
      commentNavigationNativeValue<boolean>(keyboardEvent.isComposing, event) ===
        keyboard.isComposing &&
      commentNavigationNativeValue<boolean>(keyboardEvent.ctrlKey, event) ===
        keyboard.ctrlKey &&
      commentNavigationNativeValue<boolean>(keyboardEvent.shiftKey, event) ===
        keyboard.shiftKey &&
      commentNavigationNativeValue<boolean>(keyboardEvent.altKey, event) ===
        keyboard.altKey &&
      commentNavigationNativeValue<boolean>(keyboardEvent.metaKey, event) ===
        keyboard.metaKey &&
      commentNavigationActiveElement(publication) === keyboard.activeElement,
  );
}

function createCommentNavigationRender(
  authority: CommentNavigationAuthority,
  cells: CommentNavigationCells,
  requestSuccessor: () => void,
): CommentNavigationRender {
  const render = {} as CommentNavigationRender;
  const identity = Symbol("comment-navigation-render");
  let currentRuntime: CommentNavigationPublicationRuntime | null = null;
  let lastRuntime: CommentNavigationPublicationRuntime | null = null;
  let successorRequested = false;
  let renderRetired = false;
  let invalidBeforeEstablish = false;

  const acceptsSuccessorOf = (publication: CommentNavigationPublication) =>
    cells.active.current === null &&
    cells.successorOf.current === publication &&
    cells.retired.has(publication) &&
    publication.render.isRetired() &&
    !cells.claimedPublications.has(publication);

  const requestReplaySuccessor = (runtime: CommentNavigationPublicationRuntime) => {
    const { publication } = runtime;
    if (
      successorRequested ||
      cells.replay.current !== null ||
      !acceptsSuccessorOf(publication) ||
      !commentNavigationAuthoritiesMatch(publication.authority, authority) ||
      !commentNavigationFactsAreCurrent(authority) ||
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
    owner: CommentNavigationElementOwnerView,
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
    if (runtime?.isExactElementReplay() && acceptsSuccessorOf(runtime.publication)) {
      requestReplaySuccessor(runtime);
    }
  };

  const owners = Object.freeze({
    panel: new CommentNavigationElementOwner<HTMLElement>(onElementChange),
    header: new CommentNavigationElementOwner<HTMLDivElement>(onElementChange),
    title: new CommentNavigationElementOwner<HTMLSpanElement>(onElementChange),
    close: new CommentNavigationElementOwner<HTMLButtonElement>(onElementChange),
    navRow: new CommentNavigationElementOwner<HTMLDivElement>(onElementChange),
    tablist: new CommentNavigationElementOwner<HTMLDivElement>(onElementChange),
    tabs: Object.freeze(
      authority.tabs.map(
        () => new CommentNavigationElementOwner<HTMLButtonElement>(onElementChange),
      ),
    ),
    tabpanel: new CommentNavigationElementOwner<HTMLDivElement>(onElementChange),
    emptyContainer: authority.presentation.emptySuggestions
      ? new CommentNavigationElementOwner<HTMLSpanElement>(onElementChange)
      : null,
    emptySuggestions: authority.presentation.emptySuggestions
      ? new CommentNavigationElementOwner<HTMLButtonElement>(onElementChange)
      : null,
  });

  const expectedOwners = (): readonly CommentNavigationElementOwnerView[] =>
    Object.freeze([
      owners.panel,
      owners.header,
      owners.title,
      owners.close,
      owners.navRow,
      owners.tablist,
      ...owners.tabs,
      owners.tabpanel,
      ...(owners.emptyContainer ? [owners.emptyContainer] : []),
      ...(owners.emptySuggestions ? [owners.emptySuggestions] : []),
    ]);

  const createRuntime = (
    publication: CommentNavigationPublication,
    replayOwners: ReadonlySet<CommentNavigationElementOwnerView>,
  ): CommentNavigationPublicationRuntime => {
    type Retirement = "element" | "layout" | "action";
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let invalidReplay = false;
    let successorStaged = false;
    let released = false;
    let replayRefs: CommentNavigationRefReplay[] = [];
    let domGuard: CommentNavigationDomGuard | null = null;
    const nativeDeliveries = new WeakMap<Event, CommentNavigationNativeDelivery>();
    const nativeBubbleTargets = new Map<EventTarget, Set<CommentNavigationNativeType>>();

    const removeListeners = () => {
      for (const type of ["click", "focusin", "keydown"] as const) {
        suggestionReflectApply(
          publication.windowRemoveEventListener,
          publication.ownerWindow,
          [type, captureNative, true],
        );
        removeCommentNavigationListener(publication.ownerDocument, type, captureNative, true);
        removeCommentNavigationListener(publication.elements.panel, type, crossNativePanel);
      }
      for (const [target, types] of nativeBubbleTargets) {
        for (const type of types) {
          removeCommentNavigationListener(target, type, finalizeNative);
        }
      }
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
      replayRefs.every(
        (entry) =>
          !entry.detached && !entry.reattached && entry.owner.element() === entry.element,
      );
    const refsHaveExactReplay = () =>
      !invalidReplay &&
      replayRefs.length > 0 &&
      replayRefs.every(
        (entry) =>
          entry.detached && entry.reattached && entry.owner.element() === entry.element,
      );
    const refsHaveExactMountedReplay = () =>
      !invalidReplay &&
      replayOwners.size > 0 &&
      replayRefs.every((entry) =>
        replayOwners.has(entry.owner)
          ? entry.detached &&
            entry.reattached &&
            entry.owner.element() === entry.element
          : !entry.detached &&
            !entry.reattached &&
            entry.owner.element() === entry.element,
      );
    const publishedDomMatches = () => {
      const current = currentCommentNavigationElements(authority, owners);
      return Boolean(
        domGuard &&
          domGuard.isClean() &&
          current &&
          commentNavigationElementsAreSame(current, publication.elements) &&
          publication.elements.panel === publication.dom.shell.node &&
          commentNavigationPlacementMatches(
            publication.elements.panel,
            publication.placement,
          ) &&
          commentNavigationDomMatches(publication.dom),
      );
    };
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
    const publicationIsCurrent = (allowClaimed = false) => {
      if (
        renderRetired ||
        cells.active.current !== publication ||
        cells.retired.has(publication) ||
        publication.render !== render ||
        publication.authority !== authority ||
        (!allowClaimed && cells.claimedPublications.has(publication))
      ) {
        return false;
      }
      if (!commentNavigationFactsAreCurrent(authority)) {
        retireAndRequestSuccessor();
        return false;
      }
      return publishedDomMatches();
    };
    const retireForMutation = () => {
      retireAndRequestSuccessor();
    };

    const resolveAction = (
      event: Event,
      target: Node,
      path: readonly EventTarget[],
    ): Readonly<{
      action: CommentNavigationAction;
      control: HTMLElement;
      nextTab: Tab | null;
      reactType: "click" | "focus" | "keydown";
    }> | null => {
      const eventType = commentNavigationNativeValue<string>(
        publication.eventIntrinsics.event.type,
        event,
      );
      if (eventType === "click") {
        if (
          !(event instanceof publication.constructors.MouseEvent) ||
          commentNavigationNativeValue<number>(
            publication.eventIntrinsics.mouseEvent.button,
            event,
          ) !== 0
        ) {
          return null;
        }
        const candidates = [
          { action: render.close, control: publication.elements.close },
          ...render.tabs.map((action, index) => ({
            action,
            control: publication.elements.tabs[index]!,
          })),
          ...(render.emptySuggestions && publication.elements.emptySuggestions
            ? [
                {
                  action: render.emptySuggestions,
                  control: publication.elements.emptySuggestions,
                },
              ]
            : []),
        ].filter(
          ({ control }) => control.contains(target) && path.includes(control),
        );
        if (candidates.length !== 1) return null;
        const [{ action, control }] = candidates;
        if (action.kind === "tab" && action.tab === authority.selectedTab) return null;
        return Object.freeze({
          action,
          control,
          nextTab: action.tab,
          reactType: "click" as const,
        });
      }
      if (eventType === "focusin") {
        if (!(event instanceof publication.constructors.FocusEvent)) return null;
        const index = publication.elements.tabs.indexOf(target as HTMLButtonElement);
        const action = index < 0 ? null : render.tabs[index];
        const control = index < 0 ? null : publication.elements.tabs[index];
        if (
          !action ||
          !control ||
          target !== control ||
          !path.includes(control) ||
          commentNavigationActiveElement(publication) !== control ||
          action.tab === authority.selectedTab
        ) {
          return null;
        }
        return Object.freeze({
          action,
          control,
          nextTab: action.tab,
          reactType: "focus" as const,
        });
      }
      if (!(event instanceof publication.constructors.KeyboardEvent)) return null;
      const { keyboardEvent } = publication.eventIntrinsics;
      if (
        commentNavigationNativeValue<boolean>(keyboardEvent.altKey, event) ||
        commentNavigationNativeValue<boolean>(keyboardEvent.ctrlKey, event) ||
        commentNavigationNativeValue<boolean>(keyboardEvent.metaKey, event)
      ) {
        return null;
      }
      const activeIndex = publication.elements.tabs.findIndex(
        (button) => button === target,
      );
      const active = publication.elements.tabs[activeIndex];
      if (
        !active ||
        target !== active ||
        commentNavigationActiveElement(publication) !== active ||
        !path.includes(active) ||
        !path.includes(publication.elements.tablist)
      ) {
        return null;
      }
      const nextIndex = rovingIndex(
        commentNavigationNativeValue<string>(keyboardEvent.key, event),
        activeIndex,
        authority.tabs.length,
        {
          orientation: "horizontal",
          wrap: true,
        },
      );
      if (nextIndex < 0) return null;
      return Object.freeze({
        action: render.keyboard,
        control: publication.elements.tablist,
        nextTab: authority.tabs[nextIndex]!.id,
        reactType: "keydown" as const,
      });
    };

    function captureNative(event: Event) {
      const { event: eventGetters } = publication.eventIntrinsics;
      const eventType = commentNavigationNativeValue<string>(eventGetters.type, event);
      if (
        nativeDeliveries.has(event) ||
        !(event instanceof publication.constructors.Event) ||
        !["click", "focusin", "keydown"].includes(eventType) ||
        commentNavigationNativeValue<number>(eventGetters.eventPhase, event) !==
          publication.constructors.Event.CAPTURING_PHASE ||
        !commentNavigationNativeValue<boolean>(eventGetters.bubbles, event) ||
        commentNavigationNativeDefaultPrevented(publication, event) ||
        cells.claimedNativeEvents.has(event) ||
        seenCommentNavigationNativeEvents.has(event) ||
        claimedCommentNavigationNativeEvents.has(event)
      ) {
        return;
      }
      const target = commentNavigationNativeTarget(publication, event);
      if (
        !(target instanceof publication.constructors.Node) ||
        target.ownerDocument !== publication.ownerDocument
      ) {
        return;
      }
      const path = commentNavigationNativeComposedPath(publication, event);
      const currentTarget = commentNavigationNativeCurrentTarget(publication, event);
      if (
        !currentTarget ||
        !path.includes(currentTarget) ||
        !path.includes(publication.elements.panel)
      ) {
        return;
      }
      seenCommentNavigationNativeEvents.add(event);
      if (!publicationIsCurrent()) return;
      const resolved = resolveAction(event, target, path);
      if (
        !resolved ||
        commentNavigationActionControl(publication, resolved.action) !== resolved.control ||
        !commentNavigationControlIsEnabled(resolved.control)
      ) {
        return;
      }
      const { mouseEvent, uiEvent, focusEvent, keyboardEvent } =
        publication.eventIntrinsics;
      const mouse =
        event instanceof publication.constructors.MouseEvent
          ? Object.freeze({
              button: commentNavigationNativeValue<number>(mouseEvent.button, event),
              buttons: commentNavigationNativeValue<number>(mouseEvent.buttons, event),
              detail: commentNavigationNativeValue<number>(uiEvent.detail, event),
              clientX: commentNavigationNativeValue<number>(mouseEvent.clientX, event),
              clientY: commentNavigationNativeValue<number>(mouseEvent.clientY, event),
              screenX: commentNavigationNativeValue<number>(mouseEvent.screenX, event),
              screenY: commentNavigationNativeValue<number>(mouseEvent.screenY, event),
              ctrlKey: commentNavigationNativeValue<boolean>(mouseEvent.ctrlKey, event),
              shiftKey: commentNavigationNativeValue<boolean>(
                mouseEvent.shiftKey,
                event,
              ),
              altKey: commentNavigationNativeValue<boolean>(mouseEvent.altKey, event),
              metaKey: commentNavigationNativeValue<boolean>(mouseEvent.metaKey, event),
              relatedTarget: commentNavigationNativeValue<EventTarget | null>(
                mouseEvent.relatedTarget,
                event,
              ),
              view: commentNavigationNativeValue<Window | null>(uiEvent.view, event),
            })
          : null;
      const focus =
        event instanceof publication.constructors.FocusEvent
          ? Object.freeze({
              relatedTarget: commentNavigationNativeValue<EventTarget | null>(
                focusEvent.relatedTarget,
                event,
              ),
              view: commentNavigationNativeValue<Window | null>(uiEvent.view, event),
              activeElement: commentNavigationActiveElement(publication),
            })
          : null;
      const keyboard =
        event instanceof publication.constructors.KeyboardEvent
          ? Object.freeze({
              key: commentNavigationNativeValue<string>(keyboardEvent.key, event),
              code: commentNavigationNativeValue<string>(keyboardEvent.code, event),
              location: commentNavigationNativeValue<number>(
                keyboardEvent.location,
                event,
              ),
              repeat: commentNavigationNativeValue<boolean>(
                keyboardEvent.repeat,
                event,
              ),
              isComposing: commentNavigationNativeValue<boolean>(
                keyboardEvent.isComposing,
                event,
              ),
              ctrlKey: commentNavigationNativeValue<boolean>(
                keyboardEvent.ctrlKey,
                event,
              ),
              shiftKey: commentNavigationNativeValue<boolean>(
                keyboardEvent.shiftKey,
                event,
              ),
              altKey: commentNavigationNativeValue<boolean>(
                keyboardEvent.altKey,
                event,
              ),
              metaKey: commentNavigationNativeValue<boolean>(
                keyboardEvent.metaKey,
                event,
              ),
              activeElement: commentNavigationActiveElement(publication),
            })
          : null;
      const snapshot: CommentNavigationNativeSnapshot = Object.freeze({
        event,
        publication,
        action: resolved.action,
        control: resolved.control,
        target,
        path: Object.freeze([...path]),
        type: eventType as CommentNavigationNativeType,
        reactType: resolved.reactType,
        nextTab: resolved.nextTab,
        bubbles: commentNavigationNativeValue<boolean>(eventGetters.bubbles, event),
        cancelable: commentNavigationNativeValue<boolean>(
          eventGetters.cancelable,
          event,
        ),
        composed: commentNavigationNativeValue<boolean>(eventGetters.composed, event),
        timeStamp: commentNavigationNativeValue<number>(eventGetters.timeStamp, event),
        mouse,
        focus,
        keyboard,
      });
      const delivery: CommentNavigationNativeDelivery = {
        snapshot,
        delegationTarget: null,
        crossedPanel: false,
        captureInvalid: false,
        captureRootEvent: null,
        captureActionEvent: null,
        captureRootCount: 0,
        captureActionCount: 0,
        bubbleInvalid: false,
        bubbleActionEvent: null,
        bubbleRootEvent: null,
        bubbleActionCount: 0,
        bubbleRootCount: 0,
      };
      nativeDeliveries.set(event, delivery);
      queueMicrotask(() => {
        queueMicrotask(() => {
          if (nativeDeliveries.get(event) === delivery) nativeDeliveries.delete(event);
        });
      });
    }

    function crossNativePanel(event: Event) {
      const delivery = nativeDeliveries.get(event);
      if (
        !delivery ||
        delivery.snapshot.publication !== publication ||
        commentNavigationNativeCurrentTarget(publication, event) !==
          publication.elements.panel ||
        commentNavigationNativeValue<number>(
          publication.eventIntrinsics.event.eventPhase,
          event,
        ) !== publication.constructors.Event.BUBBLING_PHASE ||
        !commentNavigationNativeSnapshotMatches(delivery)
      ) {
        return;
      }
      delivery.crossedPanel = true;
      if (
        delivery.captureInvalid ||
        delivery.captureRootCount !== 1 ||
        delivery.captureActionCount !== 1 ||
        !delivery.captureRootEvent ||
        !delivery.captureActionEvent
      ) {
        delivery.captureInvalid = true;
      }
    }

    const reactDelivery = (
      event: CommentNavigationReactEvent,
      currentTarget: HTMLElement,
      phase: "capture" | "bubble",
    ): CommentNavigationNativeDelivery | null => {
      if (!event || typeof event !== "object") return null;
      const nativeEvent = event.nativeEvent;
      if (!(nativeEvent instanceof publication.constructors.Event)) return null;
      const delivery = nativeDeliveries.get(nativeEvent);
      const nativePhase =
        phase === "capture"
          ? publication.constructors.Event.CAPTURING_PHASE
          : publication.constructors.Event.BUBBLING_PHASE;
      if (
        !delivery ||
        delivery.snapshot.publication !== publication ||
        delivery.snapshot.event !== nativeEvent ||
        delivery.snapshot.reactType !== event.type ||
        event.currentTarget !== currentTarget ||
        event.target !== delivery.snapshot.target ||
        event.bubbles !== delivery.snapshot.bubbles ||
        event.cancelable !== delivery.snapshot.cancelable ||
        event.defaultPrevented ||
        commentNavigationNativeTarget(publication, nativeEvent) !== event.target ||
        commentNavigationNativeValue<number>(
          publication.eventIntrinsics.event.eventPhase,
          nativeEvent,
        ) !== nativePhase ||
        (delivery.delegationTarget !== null &&
          commentNavigationNativeCurrentTarget(publication, nativeEvent) !==
            delivery.delegationTarget) ||
        !commentNavigationNativeSnapshotMatches(delivery)
      ) {
        return null;
      }
      return delivery;
    };

    const stageCaptureRoot = (event: CommentNavigationReactEvent) => {
      if (
        event?.nativeEvent instanceof publication.constructors.Event &&
        !nativeDeliveries.has(event.nativeEvent)
      ) {
        captureNative(event.nativeEvent);
      }
      const delivery = reactDelivery(event, publication.elements.panel, "capture");
      if (
        !delivery ||
        delivery.crossedPanel ||
        cells.claimedPublications.has(publication) ||
        cells.claimedActions.has(delivery.snapshot.action) ||
        commentNavigationControlIsClaimed(cells, publication, delivery.snapshot.control) ||
        cells.claimedReactEvents.has(event) ||
        cells.claimedNativeEvents.has(delivery.snapshot.event) ||
        claimedCommentNavigationNativeEvents.has(delivery.snapshot.event) ||
        !publicationIsCurrent()
      ) {
        return;
      }
      delivery.captureRootCount += 1;
      if (
        delivery.captureRootCount !== 1 ||
        (delivery.captureRootEvent && delivery.captureRootEvent !== event)
      ) {
        delivery.captureInvalid = true;
        return;
      }
      delivery.captureRootEvent = event;
      const delegationTarget = commentNavigationNativeCurrentTarget(
        publication,
        delivery.snapshot.event,
      );
      if (
        !delegationTarget ||
        delegationTarget === publication.elements.panel ||
        !delivery.snapshot.path.includes(delegationTarget)
      ) {
        delivery.captureInvalid = true;
        return;
      }
      delivery.delegationTarget = delegationTarget;
      let types = nativeBubbleTargets.get(delegationTarget);
      if (!types) {
        types = new Set();
        nativeBubbleTargets.set(delegationTarget, types);
      }
      if (!types.has(delivery.snapshot.type)) {
        addCommentNavigationListener(
          delegationTarget,
          delivery.snapshot.type,
          finalizeNative,
        );
        types.add(delivery.snapshot.type);
      }
    };

    const stageCaptureAction = (
      action: CommentNavigationAction,
      event: CommentNavigationReactEvent,
    ) => {
      const control = commentNavigationActionControl(publication, action);
      const delivery = control ? reactDelivery(event, control, "capture") : null;
      if (
        !delivery ||
        delivery.crossedPanel ||
        !control ||
        delivery.snapshot.action !== action ||
        delivery.snapshot.control !== control ||
        delivery.captureRootCount !== 1 ||
        delivery.captureRootEvent !== event ||
        cells.claimedPublications.has(publication) ||
        cells.claimedActions.has(action) ||
        commentNavigationControlIsClaimed(cells, publication, control) ||
        cells.claimedReactEvents.has(event) ||
        cells.claimedNativeEvents.has(delivery.snapshot.event) ||
        claimedCommentNavigationNativeEvents.has(delivery.snapshot.event) ||
        !commentNavigationControlIsEnabled(control) ||
        !publicationIsCurrent()
      ) {
        return;
      }
      delivery.captureActionCount += 1;
      if (
        delivery.captureActionCount !== 1 ||
        (delivery.captureActionEvent && delivery.captureActionEvent !== event)
      ) {
        delivery.captureInvalid = true;
        return;
      }
      delivery.captureActionEvent = event;
    };

    const stageBubbleAction = (
      action: CommentNavigationAction,
      event: CommentNavigationReactEvent,
    ) => {
      const control = commentNavigationActionControl(publication, action);
      const delivery = control ? reactDelivery(event, control, "bubble") : null;
      if (
        !delivery ||
        !delivery.crossedPanel ||
        delivery.captureInvalid ||
        !control ||
        delivery.snapshot.action !== action ||
        delivery.snapshot.control !== control ||
        delivery.captureActionCount !== 1 ||
        !delivery.captureActionEvent ||
        delivery.captureActionEvent === event ||
        cells.claimedPublications.has(publication) ||
        cells.claimedActions.has(action) ||
        commentNavigationControlIsClaimed(cells, publication, control) ||
        cells.claimedReactEvents.has(event) ||
        cells.claimedNativeEvents.has(delivery.snapshot.event) ||
        claimedCommentNavigationNativeEvents.has(delivery.snapshot.event) ||
        !commentNavigationControlIsEnabled(control) ||
        !publicationIsCurrent()
      ) {
        return;
      }
      delivery.bubbleActionCount += 1;
      if (
        delivery.bubbleActionCount !== 1 ||
        (delivery.bubbleActionEvent && delivery.bubbleActionEvent !== event)
      ) {
        delivery.bubbleInvalid = true;
        return;
      }
      delivery.bubbleActionEvent = event;
    };

    const stageBubbleRoot = (event: CommentNavigationReactEvent) => {
      const delivery = reactDelivery(event, publication.elements.panel, "bubble");
      if (!delivery || !delivery.crossedPanel || !publicationIsCurrent()) return;
      delivery.bubbleRootCount += 1;
      if (
        delivery.bubbleRootCount !== 1 ||
        delivery.captureInvalid ||
        delivery.bubbleInvalid ||
        delivery.bubbleActionCount !== 1 ||
        delivery.bubbleActionEvent !== event ||
        delivery.captureRootEvent === event ||
        (delivery.bubbleRootEvent && delivery.bubbleRootEvent !== event)
      ) {
        delivery.bubbleInvalid = true;
        return;
      }
      delivery.bubbleRootEvent = event;
    };

    function finalizeNative(event: Event) {
      const delivery = nativeDeliveries.get(event);
      if (
        !delivery ||
        delivery.snapshot.publication !== publication ||
        commentNavigationNativeCurrentTarget(publication, event) !==
          delivery.delegationTarget ||
        commentNavigationNativeValue<number>(
          publication.eventIntrinsics.event.eventPhase,
          event,
        ) !== publication.constructors.Event.BUBBLING_PHASE
      ) {
        return;
      }
      const { action, control, nextTab } = delivery.snapshot;
      if (
        delivery.captureInvalid ||
        delivery.bubbleInvalid ||
        delivery.captureRootCount !== 1 ||
        delivery.captureActionCount !== 1 ||
        delivery.bubbleActionCount !== 1 ||
        delivery.bubbleRootCount !== 1 ||
        !delivery.captureRootEvent ||
        !delivery.captureActionEvent ||
        !delivery.bubbleActionEvent ||
        !delivery.bubbleRootEvent ||
        delivery.captureRootEvent !== delivery.captureActionEvent ||
        delivery.bubbleActionEvent !== delivery.bubbleRootEvent ||
        delivery.captureRootEvent === delivery.bubbleRootEvent ||
        commentNavigationActionControl(publication, action) !== control ||
        !commentNavigationControlIsEnabled(control) ||
        cells.claimedPublications.has(publication) ||
        cells.claimedActions.has(action) ||
        commentNavigationControlIsClaimed(cells, publication, control) ||
        cells.claimedReactEvents.has(delivery.captureRootEvent) ||
        cells.claimedReactEvents.has(delivery.bubbleRootEvent) ||
        cells.claimedNativeEvents.has(event) ||
        claimedCommentNavigationNativeEvents.has(event) ||
        !commentNavigationNativeSnapshotMatches(delivery) ||
        !publicationIsCurrent()
      ) {
        return;
      }
      cells.claimedPublications.add(publication);
      cells.claimedActions.add(action);
      claimCommentNavigationControl(cells, publication, control);
      cells.claimedReactEvents.add(delivery.captureRootEvent);
      cells.claimedReactEvents.add(delivery.bubbleRootEvent);
      cells.claimedNativeEvents.add(event);
      claimedCommentNavigationNativeEvents.add(event);
      nativeDeliveries.delete(event);

      if (action.kind === "keyboard") {
        const nextIndex = authority.tabs.findIndex((tab) => tab.id === nextTab);
        const next = publication.elements.tabs[nextIndex];
        if (!next || nextTab === null) return;
        suggestionReflectApply(commentNavigationPreventDefault, event, []);
        if (commentNavigationActiveElement(publication) !== next) {
          suggestionReflectApply(publication.focus, next, [{ preventScroll: true }]);
        }
        if (
          commentNavigationActiveElement(publication) !== next ||
          !publicationIsCurrent(true)
        ) {
          if (cells.active.current === publication && retire("action")) {
            if (!successorRequested) {
              successorRequested = true;
              requestSuccessor();
            }
          }
          return;
        }
        if (nextTab === authority.selectedTab) {
          if (retire("action") && !successorRequested) {
            successorRequested = true;
            requestSuccessor();
          }
          return;
        }
        authority.onSelect(nextTab);
        return;
      }
      if (action.kind === "close") {
        retireCommentRowActions(authority.rowActions);
        authority.onClose();
        return;
      }
      if (nextTab !== null) authority.onSelect(nextTab);
    }

    const runtime: CommentNavigationPublicationRuntime = Object.freeze({
      publication,
      publish: (expected: readonly CommentNavigationElementOwnerView[]) => {
        if (renderRetired || established) return false;
        domGuard = createCommentNavigationDomGuard(
          publication.dom,
          publication.placement,
          publication.mutationObserverIntrinsics,
          retireForMutation,
        );
        if (!domGuard) return false;
        replayRefs = expected.map((owner) => {
          const element = owner.element();
          if (!element) {
            throw new Error(
              "Cannot publish comment navigation without every committed ref",
            );
          }
          return {
            owner,
            element,
            detached: false,
            reattached: false,
            handoffDetached: false,
          };
        });
        for (const type of ["click", "focusin", "keydown"] as const) {
          suggestionReflectApply(
            publication.windowAddEventListener,
            publication.ownerWindow,
            [type, captureNative, true],
          );
          addCommentNavigationListener(
            publication.ownerDocument,
            type,
            captureNative,
            true,
          );
          addCommentNavigationListener(
            publication.elements.panel,
            type,
            crossNativePanel,
          );
        }
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
      noteRef: (
        owner: CommentNavigationElementOwnerView,
        element: HTMLElement | null,
        previous: HTMLElement | null,
      ) => {
        if (!established) return;
        const proof = replayRefs.find((entry) => entry.owner === owner);
        if (!proof) {
          invalidReplay = true;
          return;
        }
        if (successorStaged) {
          if (
            element === null &&
            previous === proof.element &&
            !proof.handoffDetached
          ) {
            proof.handoffDetached = true;
          } else if (element !== previous) {
            invalidReplay = true;
          }
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
      isRetired: () => renderRetired,
      publishedDomMatches,
      isExactElementReplay: () =>
        renderRetired &&
        retirement === "element" &&
        established &&
        ((layoutRetired && refsHaveExactReplay()) ||
          (!layoutRetired && refsHaveExactMountedReplay())) &&
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
        replayRefs.every(
          (entry) => entry.handoffDetached && entry.owner.element() === null,
        ),
      mutationHistoryIsClean: () => domGuard?.isClean() ?? false,
      release,
    });
    return runtime;
  };

  const stageCaptureAction = (
    action: CommentNavigationAction,
    event: CommentNavigationReactEvent,
  ) => {
    const runtime = currentRuntime;
    if (!runtime || runtime.isRetired()) return;
    runtime.stageCaptureAction(action, event);
  };
  const stageBubbleAction = (
    action: CommentNavigationAction,
    event: CommentNavigationReactEvent,
  ) => {
    const runtime = currentRuntime;
    if (!runtime || runtime.isRetired()) return;
    runtime.stageBubbleAction(action, event);
  };
  const createAction = (
    kind: CommentNavigationActionKind,
    tab: Tab | null,
    index: number,
    types: readonly CommentNavigationNativeType[],
  ): CommentNavigationAction => {
    const action = {} as CommentNavigationAction;
    Object.assign(action, {
      identity: Symbol(`comment-navigation-${kind}`),
      renderIdentity: identity,
      kind,
      tab,
      index,
      onClickCapture: types.includes("click")
        ? (event: MouseEvent<HTMLElement>) => stageCaptureAction(action, event)
        : null,
      onClick: types.includes("click")
        ? (event: MouseEvent<HTMLElement>) => stageBubbleAction(action, event)
        : null,
      onFocusCapture: types.includes("focusin")
        ? (event: FocusEvent<HTMLElement>) => stageCaptureAction(action, event)
        : null,
      onFocus: types.includes("focusin")
        ? (event: FocusEvent<HTMLElement>) => stageBubbleAction(action, event)
        : null,
      onKeyDownCapture: types.includes("keydown")
        ? (event: KeyboardEvent<HTMLElement>) => stageCaptureAction(action, event)
        : null,
      onKeyDown: types.includes("keydown")
        ? (event: KeyboardEvent<HTMLElement>) => stageBubbleAction(action, event)
        : null,
    });
    return Object.freeze(action);
  };

  const close = createAction("close", null, -1, ["click"]);
  const tabs = Object.freeze(
    authority.tabs.map((tab) =>
      createAction("tab", tab.id, tab.index, ["click", "focusin"]),
    ),
  );
  const emptySuggestions = authority.presentation.emptySuggestions
    ? createAction("empty-suggestions", "suggestions", -1, ["click"])
    : null;
  const keyboard = createAction("keyboard", null, -1, ["keydown"]);

  const establish = () => {
    if (lastRuntime) {
      const exactReplay =
        lastRuntime.isExactLayoutReplay() ||
        lastRuntime.isExactElementReplay();
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
    if (
      renderRetired ||
      invalidBeforeEstablish ||
      !commentNavigationFactsAreCurrent(authority)
    ) {
      return undefined;
    }
    const elements = currentCommentNavigationElements(authority, owners);
    const placement = elements
      ? captureCommentNavigationPlacement(elements.panel)
      : null;
    const dom = elements ? snapshotCommentNavigationDom(elements) : null;
    const ownerWindow = elements?.panel.ownerDocument.defaultView;
    const eventIntrinsics = ownerWindow
      ? captureCommentNavigationEventIntrinsics(ownerWindow)
      : null;
    const mutationObserverIntrinsics = ownerWindow
      ? captureCommentNavigationMutationObserverIntrinsics(ownerWindow)
      : null;
    if (
      !elements ||
      !placement ||
      !dom ||
      !ownerWindow ||
      !eventIntrinsics ||
      !mutationObserverIntrinsics
    ) {
      return undefined;
    }
    const publication: CommentNavigationPublication = Object.freeze({
      identity: Symbol("comment-navigation-publication"),
      render,
      authority,
      elements,
      ownerDocument: elements.panel.ownerDocument,
      ownerWindow,
      constructors: Object.freeze({
        Event: ownerWindow.Event,
        MouseEvent: ownerWindow.MouseEvent,
        FocusEvent: ownerWindow.FocusEvent,
        KeyboardEvent: ownerWindow.KeyboardEvent,
        Node: ownerWindow.Node,
      }),
      focus: ownerWindow.HTMLElement.prototype.focus,
      windowAddEventListener: ownerWindow.addEventListener,
      windowRemoveEventListener: ownerWindow.removeEventListener,
      eventIntrinsics,
      mutationObserverIntrinsics,
      dom,
      placement,
    });

    const replay = cells.replay.current;
    if (replay) {
      const sameAuthority = commentNavigationAuthoritiesMatch(
        replay.source.authority,
        authority,
      );
      const exactReplay =
        sameAuthority &&
        replay.source.render.isRetired() &&
        cells.retired.has(replay.source) &&
        cells.successorOf.current === replay.source &&
        replay.refsAreExact() &&
        replay.historyIsClean() &&
        elements.panel === replay.dom.shell.node &&
        commentNavigationPlacementMatches(elements.panel, replay.placement) &&
        commentNavigationDomMatches(replay.dom);
      cells.replay.current = null;
      replay.release();
      if (cells.successorOf.current === replay.source) {
        cells.successorOf.current = null;
      }
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
    const allOwners = expectedOwners();
    const replayedOwners = new Set<CommentNavigationElementOwnerView>();
    if (transitionSource?.authority.mount === authority.mount) {
      for (const owner of allOwners) {
        const element = owner.element();
        if (element && !commentNavigationDomContains(transitionSource.dom, element)) {
          replayedOwners.add(owner);
        }
      }
    }
    const runtime = createRuntime(publication, replayedOwners);
    currentRuntime = runtime;
    lastRuntime = runtime;
    if (!runtime.publish(allOwners)) {
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
  const stageRootCapture = (event: CommentNavigationReactEvent) => {
    const runtime = currentRuntime;
    if (!runtime || runtime.isRetired()) return;
    runtime.stageCaptureRoot(event);
  };
  const stageRootBubble = (event: CommentNavigationReactEvent) => {
    const runtime = currentRuntime;
    if (!runtime || runtime.isRetired()) return;
    runtime.stageBubbleRoot(event);
  };

  Object.assign(render, {
    identity,
    authority,
    close,
    tabs,
    emptySuggestions,
    keyboard,
    capturePanel: owners.panel.capture,
    captureHeader: owners.header.capture,
    captureTitle: owners.title.capture,
    captureClose: owners.close.capture,
    captureNavRow: owners.navRow.capture,
    captureTablist: owners.tablist.capture,
    captureTabs: Object.freeze(owners.tabs.map((owner) => owner.capture)),
    captureTabpanel: owners.tabpanel.capture,
    captureEmptyContainer: owners.emptyContainer?.capture ?? null,
    captureEmptySuggestions: owners.emptySuggestions?.capture ?? null,
    onPanelClickCapture: stageRootCapture,
    onPanelClick: stageRootBubble,
    onPanelFocusCapture: stageRootCapture,
    onPanelFocus: stageRootBubble,
    onPanelKeyDownCapture: stageRootCapture,
    onPanelKeyDown: stageRootBubble,
    establish,
    retire,
    isRetired: () => renderRetired,
    focusSelected: () => {
      const runtime = currentRuntime;
      const publication = runtime?.publication;
      const index = authority.tabs.findIndex(
        (tab) => tab.id === authority.selectedTab,
      );
      const selected = publication?.elements.tabs[index];
      if (
        !runtime ||
        !publication ||
        runtime.isRetired() ||
        cells.active.current !== publication ||
        !selected ||
        !runtime.publishedDomMatches()
      ) {
        return;
      }
      suggestionReflectApply(publication.focus, selected, [{ preventScroll: true }]);
      return commentNavigationActiveElement(publication) === selected;
    },
  });
  return Object.freeze(render);
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

  const tabs: readonly CommentNavigationTabFacts[] = Object.freeze([
    Object.freeze({ index: 0, id: "open", label: "Open", count: open.length }),
    Object.freeze({ index: 1, id: "resolved", label: "Resolved", count: resolved.length }),
    Object.freeze({ index: 2, id: "suggestions", label: "Suggestions", count: suggestionCount }),
  ]);
  const showEmptySuggestions =
    tab === "open" && open.length === 0 && !pending && reviewsLoaded && suggestionCount > 0;
  const [navigationMount] = useState(() => Symbol("comment-navigation"));
  const [navigationCells] = useState<CommentNavigationCells>(() => ({
    active: { current: null },
    successorOf: { current: null },
    replay: { current: null },
    retired: new WeakSet<CommentNavigationPublication>(),
    claimedPublications: new WeakSet<CommentNavigationPublication>(),
    claimedActions: new WeakSet<CommentNavigationAction>(),
    claimedControls: new WeakMap<HTMLElement, WeakSet<CommentNavigationPublication>>(),
    claimedReactEvents: new WeakSet<object>(),
    claimedNativeEvents: new WeakSet<Event>(),
  }));
  const navigationReplayCleanup = useRef(0);
  useLayoutEffect(() => {
    navigationReplayCleanup.current += 1;
    return () => {
      navigationReplayCleanup.current += 1;
      const cleanup = navigationReplayCleanup.current;
      queueMicrotask(() => {
        if (navigationReplayCleanup.current !== cleanup) return;
        const replay = navigationCells.replay.current;
        if (!replay) return;
        navigationCells.replay.current = null;
        if (navigationCells.successorOf.current === replay.source) {
          navigationCells.successorOf.current = null;
        }
        replay.release();
      });
    };
  }, [navigationCells]);
  const [, setNavigationRevision] = useState(0);
  const requestNavigationSuccessor = useCallback(() => {
    setNavigationRevision((revision) => revision + 1);
  }, []);
  const navigationPresentation = commentNavigationPresentation(
    tab,
    tabs,
    showEmptySuggestions,
  );
  const navigationAuthority: CommentNavigationAuthority = Object.freeze({
    mount: navigationMount,
    session,
    documentId: session.docId,
    selectedTab: tab,
    tabs,
    canComment: session.canComment,
    onSelect: setTab,
    onClose,
    rowActions: actionCoordinator,
    presentation: navigationPresentation,
  });
  const navigation = createCommentNavigationRender(
    navigationAuthority,
    navigationCells,
    requestNavigationSuccessor,
  );
  useLayoutEffect(() => navigation.establish(), [navigation]);
  const focusOnMountComplete = useRef(false);
  useEffect(() => {
    if (!focusOnMount || focusOnMountComplete.current) return;
    const timer = window.setTimeout(() => {
      if (navigation.focusSelected()) focusOnMountComplete.current = true;
    });
    return () => window.clearTimeout(timer);
  }, [focusOnMount, navigation]);
  const {
    close: closeNavigation,
    tabs: tabNavigation,
    emptySuggestions: emptySuggestionsNavigation,
    keyboard: keyboardNavigation,
    capturePanel,
    captureHeader,
    captureTitle,
    captureClose,
    captureNavRow,
    captureTablist,
    captureTabs,
    captureTabpanel,
    captureEmptyContainer,
    captureEmptySuggestions,
    onPanelClickCapture,
    onPanelClick,
    onPanelFocusCapture,
    onPanelFocus,
    onPanelKeyDownCapture,
    onPanelKeyDown,
  } = navigation;

  return (
    <MentionCandidatesContext.Provider value={mentionValue}>
    <AgentNamesContext.Provider value={agentNamesValue}>
    <aside
      ref={capturePanel}
      className={navigationPresentation.panelClassName}
      data-testid={navigationPresentation.panelTestId}
      onClickCapture={onPanelClickCapture}
      onClick={onPanelClick}
      onFocusCapture={onPanelFocusCapture}
      onFocus={onPanelFocus}
      onKeyDownCapture={onPanelKeyDownCapture}
      onKeyDown={onPanelKeyDown}
    >
      <div ref={captureHeader} className={navigationPresentation.headerClassName}>
        <span ref={captureTitle} className={navigationPresentation.titleClassName}>{navigationPresentation.title}</span>
        <button
          ref={captureClose}
          type="button"
          className={navigationPresentation.closeClassName}
          onClickCapture={closeNavigation.onClickCapture ?? undefined}
          onClick={closeNavigation.onClick ?? undefined}
          aria-label={navigationPresentation.closeLabel}
        >
          <X size={16} />
        </button>
      </div>
      <div ref={captureNavRow} className={navigationPresentation.navRowClassName}>
        <div
          ref={captureTablist}
          className={navigationPresentation.tablistClassName}
          role="tablist"
          aria-label={navigationPresentation.tablistLabel}
          aria-orientation={navigationPresentation.tablistOrientation}
          onKeyDownCapture={keyboardNavigation.onKeyDownCapture ?? undefined}
          onKeyDown={keyboardNavigation.onKeyDown ?? undefined}
        >
          {navigationPresentation.tabs.map((t) => {
            const currentTabNavigation = tabNavigation[t.index]!;
            return (
            <button
              key={t.id}
              ref={captureTabs[t.index]}
              type="button"
              role="tab"
              id={t.buttonId}
              aria-selected={t.selected}
              aria-controls={navigationPresentation.tabpanelId}
              tabIndex={t.tabIndex}
              className={t.className}
              onClickCapture={currentTabNavigation.onClickCapture ?? undefined}
              onClick={currentTabNavigation.onClick ?? undefined}
              onFocusCapture={currentTabNavigation.onFocusCapture ?? undefined}
              onFocus={currentTabNavigation.onFocus ?? undefined}
              data-testid={t.testId}
            >
              {t.label}
              {t.count > 0 && <span className="ml-1 text-ink-4">{t.count}</span>}
            </button>
            );
          })}
        </div>
        {/* Outside the tablist (which holds only tabs): a comment on the whole document, no selection needed (#1025). */}
        {session.canComment && (
          <button type="button" className="icon-btn h-7 w-7 shrink-0" title="Comment on the document" aria-label="Comment on the document" onClick={() => commentOnDocument(false)} data-testid="comment-document">
            <MessageSquarePlus size={15} />
          </button>
        )}
      </div>
      <div ref={captureTabpanel} className={navigationPresentation.tabpanelClassName} role="tabpanel" id={navigationPresentation.tabpanelId} aria-labelledby={navigationPresentation.tabpanelLabelledBy}>
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
                <span
                  ref={captureEmptyContainer ?? undefined}
                  className={navigationPresentation.emptySuggestions!.containerClassName}
                  data-testid={navigationPresentation.emptySuggestions!.containerTestId}
                >
                  <button
                    ref={captureEmptySuggestions ?? undefined}
                    type="button"
                    className={navigationPresentation.emptySuggestions!.buttonClassName}
                    onClickCapture={emptySuggestionsNavigation!.onClickCapture ?? undefined}
                    onClick={emptySuggestionsNavigation!.onClick ?? undefined}
                    data-testid={navigationPresentation.emptySuggestions!.buttonTestId}
                  >
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
