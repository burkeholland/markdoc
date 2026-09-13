"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { ArrowLeft, Check, Copy, ExternalLink, Radio } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { api, apiErrorText } from "@/lib/api";
import { COPY_FALLBACK_HINT } from "@/lib/clipboard";
import { useCopy, type CopyStatus } from "@/lib/hooks";
import { AGENT_CONNECT_DISMISSED_KEY, AGENT_DOCS_URL } from "@/lib/mcp";
import { AgentConnectCard, useOrigin } from "@/components/settings/agent-connect-card";

/**
 * The sentence a person pastes into Copilot CLI (or any MCP client connected to Markdoc) to put their
 * agent into the watch loop for one document: `markdoc_presence` → `markdoc_watch { wait: 55 }` → act on
 * comments, mentions and requests (docs/agents.md "Sit in a document").
 */
export function keepAgentPrompt(doc: { id: string; title: string }): string {
  const title = (doc.title || "Untitled").replace(/"/g, "'");
  return `Sit in the Markdoc document "${title}" (id ${doc.id}): call markdoc_presence active, then loop markdoc_watch with wait 55 and act on comments, mentions and requests until I say stop.`;
}

/** Lead-in above the paste box: what to do with the sentence (Burke's "give them the exact command"). */
export const KEEP_AGENT_HINT = "Paste this into Copilot CLI (or any MCP client connected to Markdoc):";

export const KEEP_AGENT_AFTER = "While it runs, your requests and @mentions reach the agent within a minute.";

function readDismissed(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(AGENT_CONNECT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

interface TokenSetupCheck {
  hasTokens: boolean | null;
  pending: boolean;
  error: string | null;
  retry: () => void;
}

interface TokenCheckVisit {
  waitingFor: TokenListRequest | null;
}

interface TokenListRequest {
  visit: TokenCheckVisit | null;
  requiresFreshVisit: boolean;
}

/** The user's last confirmed token state, plus the exact active panel visit's request state. */
function useHasTokens(active: boolean): TokenSetupCheck {
  const [hasTokens, setHasTokens] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visitRef = useRef<TokenCheckVisit | null>(null);
  const requestRef = useRef<TokenListRequest | null>(null);

  const check = useCallback((visit: TokenCheckVisit) => {
    function run(currentVisit: TokenCheckVisit): void {
      if (visitRef.current !== currentVisit) return;
      const running = requestRef.current;
      if (running) {
        if (running.visit !== currentVisit) {
          if (running.requiresFreshVisit) currentVisit.waitingFor = running;
          else running.visit = currentVisit;
        }
        setPending(true);
        return;
      }

      currentVisit.waitingFor = null;
      const request: TokenListRequest = { visit: currentVisit, requiresFreshVisit: false };
      requestRef.current = request;
      setPending(true);

      void (async () => {
        try {
          const res = await api.tokens.list();
          if (requestRef.current !== request || !request.visit || request.visit !== visitRef.current) return;
          setHasTokens(res.tokens.length > 0);
          setError(null);
        } catch (reason) {
          if (requestRef.current !== request || !request.visit || request.visit !== visitRef.current) return;
          setError(apiErrorText(reason, "Could not check token setup"));
        } finally {
          if (requestRef.current !== request) return;
          requestRef.current = null;
          const requestVisit = request.visit;
          request.visit = null;
          if (requestVisit && visitRef.current === requestVisit) {
            setPending(false);
            return;
          }

          const waitingVisit = visitRef.current;
          if (!waitingVisit || waitingVisit.waitingFor !== request) return;
          waitingVisit.waitingFor = null;
          run(waitingVisit);
        }
      })();
    }

    run(visit);
  }, []);

  const retire = useCallback((visit: TokenCheckVisit) => {
    visit.waitingFor = null;
    if (requestRef.current?.visit === visit) requestRef.current.visit = null;
    if (visitRef.current === visit) visitRef.current = null;
  }, []);

  useLayoutEffect(() => {
    if (!active) {
      if (requestRef.current) requestRef.current.requiresFreshVisit = true;
      setPending(false);
      setError(null);
      return;
    }

    const visit: TokenCheckVisit = { waitingFor: null };
    visitRef.current = visit;
    setError(null);
    check(visit);
    return () => retire(visit);
  }, [active, check, retire]);

  const retry = useCallback(() => {
    const visit = visitRef.current;
    if (visit) check(visit);
  }, [check]);
  return { hasTokens, pending, error, retry };
}

export interface KeepAgentHerePanelProps {
  doc: { id: string; title: string };
  /** Where to go to create a token; defaults to /settings#tokens and back. */
  onCreateToken?: () => void;
  /** Renders a back arrow in the heading (a host that switches views). */
  onBack?: () => void;
  /** The panel is showing; the token check runs when it becomes true. */
  active?: boolean;
  /** Drop the panel's own heading (the dialog already has the title). */
  hideHeading?: boolean;
}

const PANEL_CLASS = "flex flex-col gap-3";
const HEADING_ROW_CLASS = "flex items-center gap-1.5";
const HEADING_CLASS = "flex items-center gap-2 text-sm font-semibold text-ink";
const BACK_CLASS = "icon-btn -ml-1 h-7 w-7";
const CHECKING_CLASS = "text-xs text-ink-3";
const ERROR_CLASS = "flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger dark:bg-red-950/40";
const RETRY_CLASS = "btn btn-outline btn-sm shrink-0";
const NAV_CLASS = "flex flex-wrap gap-2";
const LINK_CLASS = "btn btn-outline btn-sm";
const CONNECT_LINK_CLASS = "btn btn-outline btn-sm whitespace-normal";
const BODY_CLASS = "text-xs leading-5 text-ink-3";
const HINT_CLASS = "text-sm font-medium leading-5 text-ink-2";
const PROMPT_WRAPPER_CLASS = "relative";
const PROMPT_CLASS = "select-text whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2 p-3 pb-10 font-sans text-[13px] leading-5 text-ink";
const COPY_CLASS = "btn btn-primary btn-sm absolute bottom-2 right-2 gap-1.5";
const DOCS_LINK_CLASS = "inline-flex min-h-6 w-fit items-center gap-1 text-xs font-medium text-accent underline-offset-2 hover:underline";
const PANEL_BODY = "Your agent sits in this document and reacts to what people write — requests, @mentions and comments reach it without a trip to the terminal.";
const CLIENTS = "Works with any MCP client: Copilot CLI, VS Code, Claude, Cursor.";
const COPY_LABEL = "Copy instruction";

type CopySetup = Readonly<{
  copy: () => void;
  status: CopyStatus;
  label: string;
  copied: boolean;
}>;
type PanelActionKind = "back" | "retry" | "copy";

interface KeepAgentPanelRender {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly doc: KeepAgentHerePanelProps["doc"];
  readonly docId: string;
  readonly docTitle: string;
  readonly prompt: string;
  readonly onCreateToken: (() => void) | undefined;
  readonly onBack: (() => void) | undefined;
  readonly active: boolean;
  readonly hideHeading: boolean;
  readonly tokenSetup: TokenSetupCheck;
  readonly hasTokens: boolean | null;
  readonly tokenCheckPending: boolean;
  readonly tokenCheckError: string | null;
  readonly retryTokenCheck: () => void;
  readonly copySetup: CopySetup;
  readonly copy: () => void;
  readonly copyStatus: CopySetup["status"];
  readonly copyLabel: string;
  readonly copied: boolean;
  readonly origin: string;
  readonly dismissed: boolean;
  readonly dismiss: () => void;
  readonly showSetup: boolean;
  readonly tokensHref: string;
  readonly connectHref: string;
  readonly docsHref: string;
  readonly promptTestId: string;
  readonly copyTestId: string;
  readonly copyAriaLabel: string;
}

interface KeepAgentPanelElements {
  panel: HTMLDivElement | null;
  headingRow: HTMLDivElement | null;
  heading: HTMLHeadingElement | null;
  back: HTMLButtonElement | null;
  checking: HTMLParagraphElement | null;
  error: HTMLDivElement | null;
  retry: HTMLButtonElement | null;
  nav: HTMLElement | null;
  tokensLink: HTMLAnchorElement | null;
  connectLink: HTMLAnchorElement | null;
  body: HTMLParagraphElement | null;
  hint: HTMLParagraphElement | null;
  promptWrapper: HTMLDivElement | null;
  prompt: HTMLPreElement | null;
  copy: HTMLButtonElement | null;
  after: HTMLParagraphElement | null;
  clients: HTMLParagraphElement | null;
  docsLink: HTMLAnchorElement | null;
}

type PanelElementRole = keyof KeepAgentPanelElements;
type PanelNavRole = "tokensLink" | "connectLink";

const PANEL_ELEMENT_ROLES: readonly PanelElementRole[] = [
  "panel",
  "headingRow",
  "heading",
  "back",
  "checking",
  "error",
  "retry",
  "nav",
  "tokensLink",
  "connectLink",
  "body",
  "hint",
  "promptWrapper",
  "prompt",
  "copy",
  "after",
  "clients",
  "docsLink",
];
const PANEL_NAV_ROLES: readonly PanelNavRole[] = Object.freeze([
  "tokensLink",
  "connectLink",
]);

function emptyPanelElements(): KeepAgentPanelElements {
  return {
    panel: null,
    headingRow: null,
    heading: null,
    back: null,
    checking: null,
    error: null,
    retry: null,
    nav: null,
    tokensLink: null,
    connectLink: null,
    body: null,
    hint: null,
    promptWrapper: null,
    prompt: null,
    copy: null,
    after: null,
    clients: null,
    docsLink: null,
  };
}

interface KeepAgentPanelDraft {
  readonly identity: symbol;
  readonly render: KeepAgentPanelRender;
  readonly generation: KeepAgentPanelGeneration;
  committed: boolean;
  retired: boolean;
}

interface KeepAgentPanelGeneration {
  readonly identity: symbol;
  readonly render: KeepAgentPanelRender;
  readonly elements: KeepAgentPanelElements;
  readonly bindings: Record<PanelElementRole, KeepAgentPanelBinding | null>;
  authority: KeepAgentPanelDraft | null;
  target: RefObject<HTMLPreElement | null> | null;
}

interface KeepAgentPanelBinding {
  readonly identity: symbol;
  readonly generation: KeepAgentPanelGeneration;
  readonly role: PanelElementRole;
  readonly element: HTMLElement;
  active: boolean;
}

interface KeepAgentPanelAction {
  readonly kind: PanelActionKind;
  readonly element: HTMLButtonElement;
  readonly targets: readonly Node[];
}

interface KeepAgentPanelDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly KeepAgentPanelDomSnapshot[];
  readonly opaque: boolean;
}

interface KeepAgentPanelPlacement {
  readonly node: Node;
  readonly parent: Node | null;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface KeepAgentPanelPublication {
  readonly identity: symbol;
  readonly render: KeepAgentPanelRender;
  readonly draft: KeepAgentPanelDraft;
  readonly generation: KeepAgentPanelGeneration;
  readonly target: RefObject<HTMLPreElement | null>;
  readonly elements: Readonly<KeepAgentPanelElements>;
  readonly bindings: Readonly<Record<PanelElementRole, KeepAgentPanelBinding | null>>;
  readonly roles: readonly PanelElementRole[];
  readonly setup: Element | null;
  readonly topLevelChildren: readonly Element[];
  readonly placement: readonly KeepAgentPanelPlacement[];
  readonly dom: KeepAgentPanelDomSnapshot;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly navIntrinsics: KeepAgentPanelNavIntrinsics;
  readonly navActions: Readonly<Record<PanelNavRole, KeepAgentPanelNavAction>>;
  readonly navWindowListener: KeepAgentPanelNavWindowListener;
  readonly back: KeepAgentPanelAction | null;
  readonly retry: KeepAgentPanelAction | null;
  readonly copy: KeepAgentPanelAction;
  pendingNavRoutes: WeakMap<KeyboardEvent, KeepAgentPanelNavRoute>;
  retired: boolean;
  mutated: boolean;
  observer: MutationObserver | null;
}

interface PanelElementOwner {
  readonly binding: KeepAgentPanelBinding;
}

interface PromptOwner {
  readonly binding: KeepAgentPanelBinding;
  readonly target: RefObject<HTMLPreElement | null>;
}

interface KeepAgentPanelReplay {
  readonly publication: KeepAgentPanelPublication;
  readonly generation: KeepAgentPanelGeneration;
  readonly expected: Readonly<Record<PanelElementRole, KeepAgentPanelBinding | null>>;
  readonly released: Set<PanelElementRole>;
  readonly rebound: Map<PanelElementRole, KeepAgentPanelBinding>;
  layoutRetired: boolean;
  invalid: boolean;
}

interface KeepAgentPanelNavTrustedAuthority {
  readonly read: (event: object) => boolean;
  readonly matches: (event: object) => boolean;
  readonly isCurrent: () => boolean;
}

interface KeepAgentPanelNavIntrinsics {
  readonly ownerWindow: Window & typeof globalThis;
  readonly keyboardPrototype: object;
  readonly capturingPhase: number;
  readonly bubblingPhase: number;
  readonly apply: typeof Reflect.apply;
  readonly isPrototypeOf: typeof Object.prototype.isPrototypeOf;
  readonly trusted: KeepAgentPanelNavTrustedAuthority;
  readonly event: Readonly<{
    type: (this: Event) => string;
    target: (this: Event) => EventTarget | null;
    currentTarget: (this: Event) => EventTarget | null;
    eventPhase: (this: Event) => number;
    bubbles: (this: Event) => boolean;
    cancelable: (this: Event) => boolean;
    defaultPrevented: (this: Event) => boolean;
    cancelBubble: (this: Event) => boolean;
    composedPath: (this: Event) => EventTarget[];
    preventDefault: (this: Event) => void;
  }>;
  readonly keyboard: Readonly<{
    key: (this: KeyboardEvent) => string;
    code: (this: KeyboardEvent) => string;
    location: (this: KeyboardEvent) => number;
    altKey: (this: KeyboardEvent) => boolean;
    ctrlKey: (this: KeyboardEvent) => boolean;
    metaKey: (this: KeyboardEvent) => boolean;
    shiftKey: (this: KeyboardEvent) => boolean;
    repeat: (this: KeyboardEvent) => boolean;
    isComposing: (this: KeyboardEvent) => boolean;
  }>;
  readonly view: (this: UIEvent) => Window | null;
  readonly activeElement: (this: Document) => Element | null;
  readonly focus: (this: HTMLElement, options?: FocusOptions) => void;
  readonly isCurrent: () => boolean;
}

interface KeepAgentPanelNavNativeSnapshot {
  readonly type: string;
  readonly target: EventTarget | null;
  readonly currentTarget: EventTarget | null;
  readonly eventPhase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly cancelBubble: boolean;
  readonly path: readonly EventTarget[];
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly isTrusted: boolean;
  readonly view: Window | null;
}

interface KeepAgentPanelNavReactSnapshot {
  readonly event: ReactKeyboardEvent<HTMLElement>;
  readonly type: string;
  readonly target: EventTarget | null;
  readonly currentTarget: EventTarget | null;
  readonly eventPhase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly isTrusted: boolean;
  readonly nativeEvent: KeyboardEvent;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly view: ReactKeyboardEvent<HTMLElement>["view"];
  readonly preventDefault: () => void;
  readonly isDefaultPrevented: () => boolean;
  readonly isPropagationStopped: () => boolean;
}

interface KeepAgentPanelNavAction {
  readonly identity: symbol;
  readonly generation: KeepAgentPanelGeneration;
  readonly render: KeepAgentPanelRender;
  readonly sourceRole: PanelNavRole;
  readonly sourceIndex: number;
  readonly source: HTMLAnchorElement;
  readonly ownerDocument: Document;
  readonly order: readonly PanelNavRole[];
}

interface KeepAgentPanelNavWindowListener {
  readonly identity: symbol;
  readonly target: Window & typeof globalThis;
  readonly add: Window["addEventListener"];
  readonly remove: Window["removeEventListener"];
  readonly callback: EventListener;
  active: boolean;
}

interface KeepAgentPanelNavWindowProof {
  readonly identity: symbol;
  readonly listener: KeepAgentPanelNavWindowListener;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly pathTerminal: EventTarget;
}

interface KeepAgentPanelNavRoute {
  readonly identity: symbol;
  readonly publication: KeepAgentPanelPublication;
  readonly generation: KeepAgentPanelGeneration;
  readonly action: KeepAgentPanelNavAction;
  readonly sourceRole: PanelNavRole;
  readonly source: HTMLAnchorElement;
  readonly destinationRole: PanelNavRole;
  readonly destination: HTMLAnchorElement;
  readonly nativeEvent: KeyboardEvent;
  readonly windowSnapshot: KeepAgentPanelNavNativeSnapshot;
  readonly windowProof: KeepAgentPanelNavWindowProof;
  captureSnapshot: KeepAgentPanelNavReactSnapshot | null;
  captureNativeSnapshot: KeepAgentPanelNavNativeSnapshot | null;
  invalid: boolean;
}

interface KeepAgentPanelNavClaim {
  readonly identity: symbol;
  readonly publication: KeepAgentPanelPublication;
  readonly generation: KeepAgentPanelGeneration;
  readonly draft: KeepAgentPanelDraft;
  readonly nav: HTMLElement;
  readonly action: KeepAgentPanelNavAction;
  readonly route: KeepAgentPanelNavRoute;
  readonly sourceRole: PanelNavRole;
  readonly source: HTMLAnchorElement;
  readonly destinationRole: PanelNavRole;
  readonly destination: HTMLAnchorElement;
  readonly pendingNavRoutes: WeakMap<KeyboardEvent, KeepAgentPanelNavRoute>;
  readonly capture: KeepAgentPanelNavReactSnapshot;
  readonly bubble: KeepAgentPanelNavReactSnapshot;
  readonly nativeEvent: KeyboardEvent;
  readonly windowProof: KeepAgentPanelNavWindowProof;
  readonly preventDefault: () => void;
  readonly isPropagationStopped: () => boolean;
  readonly focus: KeepAgentPanelNavIntrinsics["focus"];
}

interface KeepAgentPanelNavPreventedProof {
  readonly isDefaultPrevented: () => boolean;
  readonly defaultPrevented: true;
  readonly propagationStopped: false;
}

interface KeepAgentPanelNavAuthentication {
  readonly route: KeepAgentPanelNavRoute;
  phase: "predicates" | "effect" | "post-predicates" | "final";
  reentered: boolean;
}

function descendantsOf(element: HTMLElement): readonly Node[] {
  const nodes: Node[] = [];
  const collect = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes) collect(child);
  };
  collect(element);
  return Object.freeze(nodes);
}

function sameNodes(expected: readonly Node[], element: HTMLElement): boolean {
  const current = descendantsOf(element);
  return current.length === expected.length && current.every((node, index) => node === expected[index]);
}

function isNodeFromDocument(value: EventTarget | null, document: Document): value is Node {
  const NodeConstructor = document.defaultView?.Node;
  return Boolean(NodeConstructor && value instanceof NodeConstructor);
}

function normalizedText(element: Element): string {
  return element.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function iconMatches(element: Element | null, iconClass: string, size: string): boolean {
  return Boolean(
    element &&
    element.tagName.toLowerCase() === "svg" &&
    element.classList.contains(iconClass) &&
    element.getAttribute("width") === size &&
    element.getAttribute("height") === size &&
    element.getAttribute("aria-hidden") === "true",
  );
}

function panelAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotPanelDom(node: Node, opaque: Node | null): KeepAgentPanelDomSnapshot {
  const isOpaque = node === opaque;
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: panelAttributes(node),
    children: isOpaque
      ? Object.freeze([])
      : Object.freeze([...node.childNodes].map((child) => snapshotPanelDom(child, opaque))),
    opaque: isOpaque,
  });
}

function panelDomMatches(snapshot: KeepAgentPanelDomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = panelAttributes(node);
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
  if (snapshot.opaque) return true;
  return node.childNodes.length === snapshot.children.length &&
    snapshot.children.every((child, index) =>
      node.childNodes.item(index) === child.node && panelDomMatches(child));
}

function connectedPlacement(panel: HTMLElement): readonly KeepAgentPanelPlacement[] | null {
  const placement: KeepAgentPanelPlacement[] = [];
  const ownerDocument = panel.ownerDocument;
  let current: Node | null = panel;
  while (current) {
    placement.push(Object.freeze({
      node: current,
      parent: current.parentNode,
      previousSibling: current.previousSibling,
      nextSibling: current.nextSibling,
    }));
    if (current === ownerDocument) return Object.freeze(placement);
    current = current.parentNode;
  }
  return null;
}

function placementMatches(
  panel: HTMLElement,
  placement: readonly KeepAgentPanelPlacement[],
): boolean {
  const ownerDocument = panel.ownerDocument;
  if (!panel.isConnected || placement.length === 0 || placement[0]?.node !== panel) {
    return false;
  }
  for (let index = 0; index < placement.length; index++) {
    const current = placement[index]!;
    const next = placement[index + 1];
    if (
      current.node.parentNode !== current.parent ||
      current.node.previousSibling !== current.previousSibling ||
      current.node.nextSibling !== current.nextSibling ||
      (next && current.parent !== next.node)
    ) {
      return false;
    }
  }
  const last = placement.at(-1)!;
  return last.node === ownerDocument &&
    last.parent === null &&
    last.previousSibling === null &&
    last.nextSibling === null;
}

function mutationTouchesPlacement(
  placement: readonly KeepAgentPanelPlacement[],
  mutation: MutationRecord,
): boolean {
  if (mutation.type !== "childList") return false;
  return placement.some(({ node, parent }) =>
    parent === mutation.target &&
    (
      mutation.previousSibling === node ||
      mutation.nextSibling === node ||
      [...mutation.addedNodes].includes(node) ||
      [...mutation.removedNodes].includes(node)
    ));
}

function nativePathMatches(
  nativeEvent: MouseEvent,
  target: Node,
  ownerDocument: Document,
): boolean {
  const path = nativeEvent.composedPath();
  if (path[0] !== target) return false;
  const expected: EventTarget[] = [];
  let current: Node | null = target;
  while (current) {
    expected.push(current);
    if (current === ownerDocument) break;
    current = current.parentNode;
  }
  const terminal = path.at(-1);
  return expected.at(-1) === ownerDocument &&
    path.length === expected.length + 1 &&
    expected.every((entry, index) => path[index] === entry) &&
    typeof terminal === "object" &&
    terminal !== null &&
    "document" in terminal &&
    terminal.document === ownerDocument;
}

function panelNavGetter<This extends object, Value>(
  prototype: object,
  property: string,
): ((this: This) => Value) | null {
  const getter = Object.getOwnPropertyDescriptor(prototype, property)?.get;
  return typeof getter === "function" ? getter as (this: This) => Value : null;
}

function panelNavDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
): boolean {
  return Boolean(
    current &&
    current.configurable === expected.configurable &&
    current.enumerable === expected.enumerable &&
    current.get === expected.get &&
    current.set === expected.set &&
    current.value === expected.value &&
    current.writable === expected.writable
  );
}

function capturePanelNavTrustedAuthority(
  ownerWindow: Window & typeof globalThis,
): KeepAgentPanelNavTrustedAuthority | null {
  let probe: KeyboardEvent;
  try {
    probe = new ownerWindow.KeyboardEvent("keep-agent-panel-nav-intrinsic");
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
    panelNavDescriptorsMatch(
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

function capturePanelNavIntrinsics(
  ownerWindow: Window & typeof globalThis,
): KeepAgentPanelNavIntrinsics | null {
  const eventPrototype = ownerWindow.Event.prototype;
  const keyboardPrototype = ownerWindow.KeyboardEvent.prototype;
  const uiEventPrototype = ownerWindow.UIEvent.prototype;
  const documentPrototype = ownerWindow.Document.prototype;
  const htmlElementPrototype = ownerWindow.HTMLElement.prototype;
  const trusted = capturePanelNavTrustedAuthority(ownerWindow);
  const type = panelNavGetter<Event, string>(eventPrototype, "type");
  const target = panelNavGetter<Event, EventTarget | null>(eventPrototype, "target");
  const currentTarget = panelNavGetter<Event, EventTarget | null>(eventPrototype, "currentTarget");
  const eventPhase = panelNavGetter<Event, number>(eventPrototype, "eventPhase");
  const bubbles = panelNavGetter<Event, boolean>(eventPrototype, "bubbles");
  const cancelable = panelNavGetter<Event, boolean>(eventPrototype, "cancelable");
  const defaultPrevented = panelNavGetter<Event, boolean>(eventPrototype, "defaultPrevented");
  const cancelBubble = panelNavGetter<Event, boolean>(eventPrototype, "cancelBubble");
  const key = panelNavGetter<KeyboardEvent, string>(keyboardPrototype, "key");
  const code = panelNavGetter<KeyboardEvent, string>(keyboardPrototype, "code");
  const location = panelNavGetter<KeyboardEvent, number>(keyboardPrototype, "location");
  const altKey = panelNavGetter<KeyboardEvent, boolean>(keyboardPrototype, "altKey");
  const ctrlKey = panelNavGetter<KeyboardEvent, boolean>(keyboardPrototype, "ctrlKey");
  const metaKey = panelNavGetter<KeyboardEvent, boolean>(keyboardPrototype, "metaKey");
  const shiftKey = panelNavGetter<KeyboardEvent, boolean>(keyboardPrototype, "shiftKey");
  const repeat = panelNavGetter<KeyboardEvent, boolean>(keyboardPrototype, "repeat");
  const isComposing = panelNavGetter<KeyboardEvent, boolean>(keyboardPrototype, "isComposing");
  const view = panelNavGetter<UIEvent, Window | null>(uiEventPrototype, "view");
  const activeElement = panelNavGetter<Document, Element | null>(documentPrototype, "activeElement");
  const composedPath = eventPrototype.composedPath;
  const preventDefault = eventPrototype.preventDefault;
  const focus = htmlElementPrototype.focus;
  const apply = ownerWindow.Reflect.apply;
  const isPrototypeOf = ownerWindow.Object.prototype.isPrototypeOf;
  if (
    !trusted ||
    !type ||
    !target ||
    !currentTarget ||
    !eventPhase ||
    !bubbles ||
    !cancelable ||
    !defaultPrevented ||
    !cancelBubble ||
    !key ||
    !code ||
    !location ||
    !altKey ||
    !ctrlKey ||
    !metaKey ||
    !shiftKey ||
    !repeat ||
    !isComposing ||
    !view ||
    !activeElement ||
    typeof composedPath !== "function" ||
    typeof preventDefault !== "function" ||
    typeof focus !== "function" ||
    typeof apply !== "function" ||
    typeof isPrototypeOf !== "function"
  ) {
    return null;
  }
  const isCurrent = () => {
    try {
      return ownerWindow.Event.prototype === eventPrototype &&
        ownerWindow.KeyboardEvent.prototype === keyboardPrototype &&
        ownerWindow.UIEvent.prototype === uiEventPrototype &&
        ownerWindow.Document.prototype === documentPrototype &&
        ownerWindow.HTMLElement.prototype === htmlElementPrototype &&
        ownerWindow.Reflect.apply === apply &&
        ownerWindow.Object.prototype.isPrototypeOf === isPrototypeOf &&
        panelNavGetter<Event, string>(eventPrototype, "type") === type &&
        panelNavGetter<Event, EventTarget | null>(eventPrototype, "target") === target &&
        panelNavGetter<Event, EventTarget | null>(eventPrototype, "currentTarget") === currentTarget &&
        panelNavGetter<Event, number>(eventPrototype, "eventPhase") === eventPhase &&
        panelNavGetter<Event, boolean>(eventPrototype, "bubbles") === bubbles &&
        panelNavGetter<Event, boolean>(eventPrototype, "cancelable") === cancelable &&
        panelNavGetter<Event, boolean>(eventPrototype, "defaultPrevented") === defaultPrevented &&
        panelNavGetter<Event, boolean>(eventPrototype, "cancelBubble") === cancelBubble &&
        panelNavGetter<KeyboardEvent, string>(keyboardPrototype, "key") === key &&
        panelNavGetter<KeyboardEvent, string>(keyboardPrototype, "code") === code &&
        panelNavGetter<KeyboardEvent, number>(keyboardPrototype, "location") === location &&
        panelNavGetter<KeyboardEvent, boolean>(keyboardPrototype, "altKey") === altKey &&
        panelNavGetter<KeyboardEvent, boolean>(keyboardPrototype, "ctrlKey") === ctrlKey &&
        panelNavGetter<KeyboardEvent, boolean>(keyboardPrototype, "metaKey") === metaKey &&
        panelNavGetter<KeyboardEvent, boolean>(keyboardPrototype, "shiftKey") === shiftKey &&
        panelNavGetter<KeyboardEvent, boolean>(keyboardPrototype, "repeat") === repeat &&
        panelNavGetter<KeyboardEvent, boolean>(keyboardPrototype, "isComposing") === isComposing &&
        panelNavGetter<UIEvent, Window | null>(uiEventPrototype, "view") === view &&
        panelNavGetter<Document, Element | null>(documentPrototype, "activeElement") === activeElement &&
        eventPrototype.composedPath === composedPath &&
        eventPrototype.preventDefault === preventDefault &&
        htmlElementPrototype.focus === focus &&
        trusted.isCurrent();
    } catch {
      return false;
    }
  };
  return Object.freeze({
    ownerWindow,
    keyboardPrototype,
    capturingPhase: ownerWindow.Event.CAPTURING_PHASE,
    bubblingPhase: ownerWindow.Event.BUBBLING_PHASE,
    apply,
    isPrototypeOf,
    trusted,
    event: Object.freeze({
      type,
      target,
      currentTarget,
      eventPhase,
      bubbles,
      cancelable,
      defaultPrevented,
      cancelBubble,
      composedPath,
      preventDefault,
    }),
    keyboard: Object.freeze({
      key,
      code,
      location,
      altKey,
      ctrlKey,
      metaKey,
      shiftKey,
      repeat,
      isComposing,
    }),
    view,
    activeElement,
    focus,
    isCurrent,
  });
}

function readPanelNavNativeEvent(
  event: Event,
  intrinsics: KeepAgentPanelNavIntrinsics,
): KeepAgentPanelNavNativeSnapshot | null {
  try {
    if (
      !intrinsics.isCurrent() ||
      !intrinsics.apply(
        intrinsics.isPrototypeOf,
        intrinsics.keyboardPrototype,
        [event],
      ) ||
      !intrinsics.trusted.matches(event)
    ) {
      return null;
    }
    return Object.freeze({
      type: intrinsics.apply(intrinsics.event.type, event, []),
      target: intrinsics.apply(intrinsics.event.target, event, []),
      currentTarget: intrinsics.apply(intrinsics.event.currentTarget, event, []),
      eventPhase: intrinsics.apply(intrinsics.event.eventPhase, event, []),
      bubbles: intrinsics.apply(intrinsics.event.bubbles, event, []),
      cancelable: intrinsics.apply(intrinsics.event.cancelable, event, []),
      defaultPrevented: intrinsics.apply(intrinsics.event.defaultPrevented, event, []),
      cancelBubble: intrinsics.apply(intrinsics.event.cancelBubble, event, []),
      path: Object.freeze(intrinsics.apply(intrinsics.event.composedPath, event, [])),
      key: intrinsics.apply(intrinsics.keyboard.key, event, []),
      code: intrinsics.apply(intrinsics.keyboard.code, event, []),
      location: intrinsics.apply(intrinsics.keyboard.location, event, []),
      altKey: intrinsics.apply(intrinsics.keyboard.altKey, event, []),
      ctrlKey: intrinsics.apply(intrinsics.keyboard.ctrlKey, event, []),
      metaKey: intrinsics.apply(intrinsics.keyboard.metaKey, event, []),
      shiftKey: intrinsics.apply(intrinsics.keyboard.shiftKey, event, []),
      repeat: intrinsics.apply(intrinsics.keyboard.repeat, event, []),
      isComposing: intrinsics.apply(intrinsics.keyboard.isComposing, event, []),
      isTrusted: intrinsics.trusted.read(event),
      view: intrinsics.apply(intrinsics.view, event, []),
    });
  } catch {
    return null;
  }
}

function panelNavPathMatches(
  path: readonly EventTarget[],
  source: HTMLAnchorElement,
  ownerDocument: Document,
  terminal: EventTarget,
): boolean {
  const expected: EventTarget[] = [];
  let current: Node | null = source;
  while (current) {
    expected.push(current);
    if (current === ownerDocument) break;
    current = current.parentNode;
  }
  return expected.at(-1) === ownerDocument &&
    path.length === expected.length + 1 &&
    expected.every((entry, index) => path[index] === entry) &&
    path.at(-1) === terminal;
}

function panelNavNativeSnapshotsMatch(
  first: KeepAgentPanelNavNativeSnapshot,
  second: KeepAgentPanelNavNativeSnapshot,
  includeDispatchState: boolean,
): boolean {
  return first.type === second.type &&
    first.target === second.target &&
    (!includeDispatchState || first.currentTarget === second.currentTarget) &&
    (!includeDispatchState || first.eventPhase === second.eventPhase) &&
    first.bubbles === second.bubbles &&
    first.cancelable === second.cancelable &&
    first.defaultPrevented === second.defaultPrevented &&
    first.cancelBubble === second.cancelBubble &&
    first.path.length === second.path.length &&
    first.path.every((entry, index) => second.path[index] === entry) &&
    first.key === second.key &&
    first.code === second.code &&
    first.location === second.location &&
    first.altKey === second.altKey &&
    first.ctrlKey === second.ctrlKey &&
    first.metaKey === second.metaKey &&
    first.shiftKey === second.shiftKey &&
    first.repeat === second.repeat &&
    first.isComposing === second.isComposing &&
    first.isTrusted === second.isTrusted &&
    Object.is(first.view, second.view);
}

function panelNavNativeSnapshotIsPrevented(
  before: KeepAgentPanelNavNativeSnapshot,
  after: KeepAgentPanelNavNativeSnapshot,
): boolean {
  return before.type === after.type &&
    before.target === after.target &&
    before.currentTarget === after.currentTarget &&
    before.eventPhase === after.eventPhase &&
    before.bubbles === after.bubbles &&
    before.cancelable === after.cancelable &&
    !before.defaultPrevented &&
    after.defaultPrevented &&
    before.cancelBubble === after.cancelBubble &&
    before.path.length === after.path.length &&
    before.path.every((entry, index) => after.path[index] === entry) &&
    before.key === after.key &&
    before.code === after.code &&
    before.location === after.location &&
    before.altKey === after.altKey &&
    before.ctrlKey === after.ctrlKey &&
    before.metaKey === after.metaKey &&
    before.shiftKey === after.shiftKey &&
    before.repeat === after.repeat &&
    before.isComposing === after.isComposing &&
    before.isTrusted === after.isTrusted &&
    Object.is(before.view, after.view);
}

function readPanelNavReactEvent(
  event: ReactKeyboardEvent<HTMLElement>,
  nativeEvent: KeyboardEvent,
  intrinsics: KeepAgentPanelNavIntrinsics,
): KeepAgentPanelNavReactSnapshot | null {
  try {
    const snapshot: KeepAgentPanelNavReactSnapshot = Object.freeze({
      event,
      type: event.type,
      target: event.target,
      currentTarget: event.currentTarget,
      eventPhase: event.eventPhase,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      defaultPrevented: event.defaultPrevented,
      isTrusted: event.isTrusted,
      nativeEvent: event.nativeEvent,
      key: event.key,
      code: event.code,
      location: event.location,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      view: event.view,
      preventDefault: event.preventDefault,
      isDefaultPrevented: event.isDefaultPrevented,
      isPropagationStopped: event.isPropagationStopped,
    });
    return snapshot.nativeEvent === nativeEvent &&
      panelNavReactSnapshotMatches(snapshot, intrinsics)
        ? snapshot
        : null;
  } catch {
    return null;
  }
}

function panelNavReactSnapshotMatches(
  snapshot: KeepAgentPanelNavReactSnapshot,
  intrinsics: KeepAgentPanelNavIntrinsics,
  releasedCurrentTarget = false,
): boolean {
  const { event } = snapshot;
  try {
    if (
      !panelNavReactSnapshotIsStable(
        snapshot,
        intrinsics,
        releasedCurrentTarget,
      )
    ) {
      return false;
    }
    const defaultPrevented = intrinsics.apply(
      snapshot.isDefaultPrevented,
      event,
      [],
    );
    if (
      defaultPrevented !== false ||
      !panelNavReactSnapshotIsStable(
        snapshot,
        intrinsics,
        releasedCurrentTarget,
      )
    ) {
      return false;
    }
    const propagationStopped = intrinsics.apply(
      snapshot.isPropagationStopped,
      event,
      [],
    );
    return propagationStopped === false &&
      panelNavReactSnapshotIsStable(
        snapshot,
        intrinsics,
        releasedCurrentTarget,
      );
  } catch {
    return false;
  }
}

function panelNavReactSnapshotIsStable(
  snapshot: KeepAgentPanelNavReactSnapshot,
  intrinsics: KeepAgentPanelNavIntrinsics,
  releasedCurrentTarget = false,
  defaultPrevented = snapshot.defaultPrevented,
  isDefaultPrevented = snapshot.isDefaultPrevented,
): boolean {
  const { event } = snapshot;
  try {
    return intrinsics.isCurrent() &&
      event.type === snapshot.type &&
      event.target === snapshot.target &&
      (
        event.currentTarget === snapshot.currentTarget ||
        (releasedCurrentTarget && event.currentTarget === null)
      ) &&
      event.eventPhase === snapshot.eventPhase &&
      event.bubbles === snapshot.bubbles &&
      event.cancelable === snapshot.cancelable &&
      event.defaultPrevented === defaultPrevented &&
      event.isTrusted === snapshot.isTrusted &&
      event.nativeEvent === snapshot.nativeEvent &&
      event.key === snapshot.key &&
      event.code === snapshot.code &&
      event.location === snapshot.location &&
      event.altKey === snapshot.altKey &&
      event.ctrlKey === snapshot.ctrlKey &&
      event.metaKey === snapshot.metaKey &&
      event.shiftKey === snapshot.shiftKey &&
      event.repeat === snapshot.repeat &&
      Object.is(event.view, snapshot.view) &&
      event.preventDefault === snapshot.preventDefault &&
      event.isDefaultPrevented === isDefaultPrevented &&
      event.isPropagationStopped === snapshot.isPropagationStopped &&
      typeof snapshot.preventDefault === "function" &&
      typeof isDefaultPrevented === "function" &&
      typeof snapshot.isPropagationStopped === "function";
  } catch {
    return false;
  }
}

function readPanelNavReactPreventedProof(
  snapshot: KeepAgentPanelNavReactSnapshot,
  intrinsics: KeepAgentPanelNavIntrinsics,
): KeepAgentPanelNavPreventedProof | null {
  const { event } = snapshot;
  try {
    const isDefaultPrevented = event.isDefaultPrevented;
    if (
      typeof isDefaultPrevented !== "function" ||
      !panelNavReactSnapshotIsStable(
        snapshot,
        intrinsics,
        false,
        true,
        isDefaultPrevented,
      )
    ) {
      return null;
    }
    const defaultPrevented = intrinsics.apply(
      isDefaultPrevented,
      event,
      [],
    );
    if (
      defaultPrevented !== true ||
      !panelNavReactSnapshotIsStable(
        snapshot,
        intrinsics,
        false,
        true,
        isDefaultPrevented,
      )
    ) {
      return null;
    }
    const propagationStopped = intrinsics.apply(
      snapshot.isPropagationStopped,
      event,
      [],
    );
    return propagationStopped === false
      ? Object.freeze({
          isDefaultPrevented,
          defaultPrevented: true,
          propagationStopped: false,
        })
      : null;
  } catch {
    return null;
  }
}

function panelNavDestination(key: string, sourceIndex: number): number {
  if (key === "ArrowRight" || key === "ArrowDown") {
    const next = sourceIndex + 1;
    return next < PANEL_NAV_ROLES.length ? next : -1;
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return sourceIndex > 0 ? sourceIndex - 1 : -1;
  }
  if (key === "Home") return 0;
  if (key === "End") return PANEL_NAV_ROLES.length - 1;
  return -1;
}

class KeepAgentPanelCoordinator {
  readonly #mount: symbol;
  #current: KeepAgentPanelPublication | null = null;
  #replay: KeepAgentPanelReplay | null = null;
  #elementOwners = new WeakMap<HTMLElement, PanelElementOwner>();
  #promptOwner: PromptOwner | null = null;
  #publishedGenerations = new WeakSet<KeepAgentPanelGeneration>();
  #replayedGenerations = new WeakSet<KeepAgentPanelGeneration>();
  #claimedActions = new WeakSet<KeepAgentPanelAction>();
  #claimedNavPublications = new WeakSet<KeepAgentPanelPublication>();
  #claimedReactEvents = new WeakSet<object>();
  #claimedNativeEvents = new WeakSet<Event>();
  #navAuthentication: KeepAgentPanelNavAuthentication | null = null;
  #navEffect: KeepAgentPanelNavClaim | null = null;

  constructor(mount: symbol) {
    this.#mount = mount;
  }

  createDraft(render: KeepAgentPanelRender): KeepAgentPanelDraft {
    const generation: KeepAgentPanelGeneration = {
      identity: Symbol("keep-agent-panel-generation"),
      render,
      elements: emptyPanelElements(),
      bindings: Object.fromEntries(
        PANEL_ELEMENT_ROLES.map((role) => [role, null]),
      ) as Record<PanelElementRole, KeepAgentPanelBinding | null>,
      authority: null,
      target: null,
    };
    const draft: KeepAgentPanelDraft = {
      identity: Symbol("keep-agent-panel-draft"),
      render,
      generation,
      committed: false,
      retired: false,
    };
    generation.authority = draft;
    return draft;
  }

  bindElement<Role extends PanelElementRole>(
    draft: KeepAgentPanelDraft,
    role: Role,
    element: KeepAgentPanelElements[Role],
  ) {
    return this.#bind(draft.generation, role, element);
  }

  bindPrompt(
    draft: KeepAgentPanelDraft,
    target: RefObject<HTMLPreElement | null>,
    element: HTMLPreElement | null,
  ) {
    const generation = draft.generation;
    if (generation.target && generation.target !== target) {
      this.#retireAuthority(generation);
      return;
    }
    generation.target = target;
    return this.#bind(generation, "prompt", element, target);
  }

  #ownsElement(publication: KeepAgentPanelPublication, role: PanelElementRole, element: HTMLElement) {
    const binding = publication.bindings[role];
    const owner = this.#elementOwners.get(element);
    return Boolean(binding &&
      binding.element === element &&
      binding.generation === publication.generation &&
      binding.role === role &&
      binding.active &&
      publication.generation.bindings[role] === binding &&
      owner?.binding === binding);
  }

  #renderIsCurrent(render: KeepAgentPanelRender): boolean {
    const docId = render.doc.id;
    const docTitle = render.doc.title;
    const tokenSetup = render.tokenSetup;
    const hasTokens = tokenSetup.hasTokens;
    const tokenCheckPending = tokenSetup.pending;
    const tokenCheckError = tokenSetup.error;
    const retryTokenCheck = tokenSetup.retry;
    const copySetup = render.copySetup;
    const copy = copySetup.copy;
    const copyStatus = copySetup.status;
    const copyLabel = copySetup.label;
    const copied = copySetup.copied;
    const prompt = keepAgentPrompt({ id: docId, title: docTitle });
    const tokensHref = `/settings?next=${encodeURIComponent(`/d/${docId}`)}#tokens`;
    const connectHref = `/settings?next=${encodeURIComponent(`/d/${docId}`)}#connect`;
    return (
      render.mount === this.#mount &&
      docId === render.docId &&
      docTitle === render.docTitle &&
      prompt === render.prompt &&
      hasTokens === render.hasTokens &&
      tokenCheckPending === render.tokenCheckPending &&
      tokenCheckError === render.tokenCheckError &&
      retryTokenCheck === render.retryTokenCheck &&
      copy === render.copy &&
      copyStatus === render.copyStatus &&
      copyLabel === render.copyLabel &&
      copied === render.copied &&
      copied === (copyStatus === "copied") &&
      copyLabel === (
        copyStatus === "copied"
          ? "Copied"
          : copyStatus === "fallback"
            ? COPY_FALLBACK_HINT
            : "Copy"
      ) &&
      render.showSetup === (hasTokens === false && !render.dismissed) &&
      render.tokensHref === tokensHref &&
      render.connectHref === connectHref &&
      render.docsHref === `${AGENT_DOCS_URL}#sit-in-a-document` &&
      render.promptTestId === "keep-agent-prompt" &&
      render.copyTestId === "keep-agent-copy" &&
      render.copyAriaLabel === COPY_LABEL
    );
  }

  #hierarchyIsCurrent(publication: KeepAgentPanelPublication): boolean {
    const { render, generation, elements, bindings, setup, topLevelChildren } = publication;
    const {
      panel,
      headingRow,
      heading,
      back,
      checking,
      error,
      retry,
      nav,
      tokensLink,
      connectLink,
      body,
      hint,
      promptWrapper,
      prompt,
      copy,
      after,
      clients,
      docsLink,
    } = elements;
    const copyIcon = copy?.firstElementChild ?? null;
    if (
      generation.render !== render ||
      generation.authority !== publication.draft ||
      generation.target !== publication.target ||
      !panel ||
      !nav ||
      !tokensLink ||
      !connectLink ||
      !body ||
      !hint ||
      !promptWrapper ||
      !prompt ||
      !copy ||
      !after ||
      !clients ||
      !docsLink
    ) {
      return false;
    }

    const required = [
      panel,
      nav,
      tokensLink,
      connectLink,
      body,
      hint,
      promptWrapper,
      prompt,
      copy,
      after,
      clients,
      docsLink,
      ...(headingRow ? [headingRow] : []),
      ...(heading ? [heading] : []),
      ...(back ? [back] : []),
      ...(checking ? [checking] : []),
      ...(error ? [error] : []),
      ...(retry ? [retry] : []),
      ...(setup instanceof HTMLElement ? [setup] : []),
    ];
    const document = panel.ownerDocument;
    if (
      new Set(required).size !== required.length ||
      required.some((element) => !element.isConnected || element.ownerDocument !== document)
    ) {
      return false;
    }
    for (const role of PANEL_ELEMENT_ROLES) {
      const element = elements[role];
      if (
        generation.elements[role] !== element ||
        generation.bindings[role] !== bindings[role] ||
        (element && !this.#ownsElement(publication, role, element))
      ) {
        return false;
      }
    }

    const shouldShowHeading = !render.hideHeading;
    const shouldShowBack = shouldShowHeading && Boolean(render.onBack);
    const shouldShowChecking = render.tokenCheckPending && !render.tokenCheckError;
    const shouldShowError = Boolean(render.tokenCheckError);
    if (
      shouldShowHeading !== Boolean(headingRow && heading) ||
      shouldShowBack !== Boolean(back) ||
      shouldShowChecking !== Boolean(checking) ||
      shouldShowError !== Boolean(error && retry) ||
      render.showSetup !== Boolean(setup)
    ) {
      return false;
    }

    const expectedTopLevel: Element[] = [];
    if (headingRow) expectedTopLevel.push(headingRow);
    if (checking) expectedTopLevel.push(checking);
    if (error) expectedTopLevel.push(error);
    if (setup) expectedTopLevel.push(setup);
    expectedTopLevel.push(nav, body, hint, promptWrapper, after, clients, docsLink);
    if (
      panel.className !== PANEL_CLASS ||
      panel.dataset.testid !== "keep-agent-panel" ||
      panel.children.length !== expectedTopLevel.length ||
      topLevelChildren.length !== expectedTopLevel.length ||
      expectedTopLevel.some(
        (element, index) =>
          panel.children.item(index) !== element ||
          topLevelChildren[index] !== element,
      )
    ) {
      return false;
    }

    if (headingRow && heading) {
      const expectedHeadingChildren = back ? [back, heading] : [heading];
      const headingIcon = heading.firstElementChild;
      if (
        headingRow.className !== HEADING_ROW_CLASS ||
        headingRow.parentElement !== panel ||
        headingRow.children.length !== expectedHeadingChildren.length ||
        expectedHeadingChildren.some((element, index) => headingRow.children.item(index) !== element) ||
        heading.className !== HEADING_CLASS ||
        heading.tagName !== "H3" ||
        heading.children.length !== 1 ||
        !iconMatches(headingIcon, "lucide-radio", "15") ||
        normalizedText(heading) !== "Keep an agent here"
      ) {
        return false;
      }
    }
    if (
      back &&
      (back.parentElement !== headingRow ||
        back.className !== BACK_CLASS ||
        back.getAttribute("type") !== "button" ||
        back.type !== "button" ||
        back.disabled ||
        back.matches(":disabled") ||
        back.getAttribute("aria-label") !== "Back" ||
        back.dataset.testid !== "keep-agent-back" ||
        back.children.length !== 1 ||
        !iconMatches(back.firstElementChild, "lucide-arrow-left", "15"))
    ) {
      return false;
    }
    if (
      checking &&
      (checking.parentElement !== panel ||
        checking.className !== CHECKING_CLASS ||
        checking.getAttribute("role") !== "status" ||
        checking.getAttribute("aria-live") !== "polite" ||
        checking.getAttribute("aria-atomic") !== "true" ||
        checking.dataset.testid !== "keep-agent-token-checking" ||
        checking.textContent?.trim() !== "Checking token setup…")
    ) {
      return false;
    }
    if (error && retry) {
      const alert = error.firstElementChild;
      if (
        error.parentElement !== panel ||
        error.className !== ERROR_CLASS ||
        error.dataset.testid !== "keep-agent-token-error" ||
        error.children.length !== 2 ||
        alert?.tagName !== "SPAN" ||
        alert.getAttribute("role") !== "alert" ||
        alert.getAttribute("aria-atomic") !== "true" ||
        alert.textContent !== render.tokenCheckError ||
        error.lastElementChild !== retry ||
        retry.className !== RETRY_CLASS ||
        retry.type !== "button" ||
        retry.disabled !== render.tokenCheckPending ||
        retry.getAttribute("aria-busy") !== (render.tokenCheckPending ? "true" : null) ||
        retry.textContent?.trim() !== (render.tokenCheckPending ? "Retrying…" : "Retry")
      ) {
        return false;
      }
    }
    if (
      setup &&
      (setup.tagName !== "SECTION" ||
        setup.parentElement !== panel ||
        (setup as HTMLElement).dataset.testid !== "agent-connect-card" ||
        setup.getAttribute("aria-label") !== "Connect an MCP client")
    ) {
      return false;
    }
    if (
      nav.parentElement !== panel ||
      nav.tagName !== "NAV" ||
      nav.className !== NAV_CLASS ||
      nav.getAttribute("aria-label") !== "Agent setup" ||
      nav.children.length !== 2 ||
      nav.firstElementChild !== tokensLink ||
      nav.lastElementChild !== connectLink ||
      tokensLink.className !== LINK_CLASS ||
      tokensLink.getAttribute("href") !== render.tokensHref ||
      tokensLink.textContent !== "Tokens" ||
      connectLink.className !== CONNECT_LINK_CLASS ||
      connectLink.getAttribute("href") !== render.connectHref ||
      connectLink.textContent !== "Connect an MCP client"
    ) {
      return false;
    }
    if (
      body.parentElement !== panel ||
      body.className !== BODY_CLASS ||
      body.textContent !== PANEL_BODY ||
      hint.parentElement !== panel ||
      hint.className !== HINT_CLASS ||
      hint.dataset.testid !== "keep-agent-hint" ||
      hint.textContent?.trim() !== KEEP_AGENT_HINT
    ) {
      return false;
    }
    if (
      promptWrapper.parentElement !== panel ||
      promptWrapper.className !== PROMPT_WRAPPER_CLASS ||
      promptWrapper.children.length !== 2 ||
      promptWrapper.firstElementChild !== prompt ||
      promptWrapper.lastElementChild !== copy ||
      prompt.className !== PROMPT_CLASS ||
      prompt.dataset.testid !== render.promptTestId ||
      prompt.children.length !== 0 ||
      prompt.textContent !== render.prompt ||
      publication.target.current !== prompt ||
      this.#promptOwner?.binding !== bindings.prompt ||
      this.#promptOwner.target !== publication.target
    ) {
      return false;
    }
    if (
      copy.parentElement !== promptWrapper ||
      copy.className !== COPY_CLASS ||
      copy.getAttribute("type") !== "button" ||
      copy.type !== "button" ||
      copy.disabled ||
      copy.matches(":disabled") ||
      copy.getAttribute("aria-label") !== render.copyAriaLabel ||
      copy.dataset.testid !== render.copyTestId ||
      normalizedText(copy) !== render.copyLabel ||
      copy.children.length !== 1 ||
      !iconMatches(copyIcon, render.copied ? "lucide-check" : "lucide-copy", "14")
    ) {
      return false;
    }
    if (
      after.parentElement !== panel ||
      after.className !== BODY_CLASS ||
      after.dataset.testid !== "keep-agent-after" ||
      after.textContent?.trim() !== KEEP_AGENT_AFTER ||
      clients.parentElement !== panel ||
      clients.className !== BODY_CLASS ||
      clients.dataset.testid !== "keep-agent-clients" ||
      clients.textContent?.trim() !== CLIENTS ||
      docsLink.parentElement !== panel ||
      docsLink.className !== DOCS_LINK_CLASS ||
      docsLink.dataset.testid !== "keep-agent-docs-link" ||
      docsLink.getAttribute("href") !== render.docsHref ||
      docsLink.getAttribute("target") !== "_blank" ||
      docsLink.getAttribute("rel") !== "noreferrer" ||
      normalizedText(docsLink) !== "Agent docs · Sit in a document" ||
      docsLink.children.length !== 2 ||
      docsLink.firstElementChild?.tagName !== "SPAN" ||
      docsLink.firstElementChild?.getAttribute("aria-hidden") !== "true" ||
      !iconMatches(docsLink.lastElementChild, "lucide-external-link", "13")
    ) {
      return false;
    }
    return (
      publication.elements.panel === publication.dom.node &&
      placementMatches(publication.elements.panel, publication.placement) &&
      panelDomMatches(publication.dom) &&
      (!publication.back || sameNodes(publication.back.targets, publication.back.element)) &&
      (!publication.retry || sameNodes(publication.retry.targets, publication.retry.element)) &&
      sameNodes(publication.copy.targets, publication.copy.element)
    );
  }

  #bind<Role extends PanelElementRole>(
    generation: KeepAgentPanelGeneration,
    role: Role,
    element: KeepAgentPanelElements[Role],
    target?: RefObject<HTMLPreElement | null>,
  ): (() => void) | undefined {
    const previous = generation.bindings[role];
    if (element === null) {
      if (previous) this.#release(previous, "null");
      return;
    }
    if (previous?.active && previous.element === element) return;
    if (
      previous?.active &&
      (!element.isConnected || element.ownerDocument !== previous.element.ownerDocument)
    ) {
      return;
    }
    if (previous) this.#release(previous, "replace");
    if (this.#replay && this.#replay.generation !== generation) {
      this.#invalidateReplay(this.#replay);
    }
    if (!this.#canBind(generation)) return;

    const replay = this.#replay;
    if (replay?.generation === generation) {
      const expected = replay.expected[role];
      if (
        replay.invalid ||
        !expected ||
        !replay.released.has(role) ||
        replay.rebound.has(role) ||
        expected.element !== element
      ) {
        this.#invalidateReplay(replay);
        return;
      }
    }

    const displaced = this.#elementOwners.get(element);
    if (displaced) {
      const displacedBinding = displaced.binding;
      if (
        displacedBinding.generation !== generation &&
        this.#current?.generation === displacedBinding.generation &&
        generation.authority?.retired
      ) {
        return;
      }
      this.#release(displacedBinding, "replace");
      if (!this.#canBind(generation)) return;
    }

    const binding: KeepAgentPanelBinding = {
      identity: Symbol(`keep-agent-panel-${role}-binding`),
      generation,
      role,
      element,
      active: true,
    };
    generation.bindings[role] = binding;
    generation.elements[role] = element;
    this.#elementOwners.set(element, { binding });
    if (role === "prompt" && target) {
      this.#promptOwner = { binding, target };
      target.current = element as HTMLPreElement;
    }
    if (replay?.generation === generation) replay.rebound.set(role, binding);
    return () => this.#release(binding, "cleanup");
  }

  #release(
    binding: KeepAgentPanelBinding,
    source: "cleanup" | "null" | "replace",
  ) {
    if (!binding.active) return;
    const publication = this.#current;
    const startsReplay =
      publication?.generation === binding.generation &&
      publication.bindings[binding.role] === binding
        ? this.#beginReplay(publication)
        : null;
    const replay = this.#replay;

    binding.active = false;
    const { generation, role, element } = binding;
    if (generation.bindings[role] === binding) {
      generation.bindings[role] = null;
      generation.elements[role] = null;
    }
    if (this.#elementOwners.get(element)?.binding === binding) {
      this.#elementOwners.delete(element);
    }
    if (role === "prompt" && this.#promptOwner?.binding === binding) {
      const { target } = this.#promptOwner;
      this.#promptOwner = null;
      if (target.current === element) target.current = null;
    }

    if (replay?.generation === generation) {
      if (
        source !== "cleanup" ||
        replay.expected[role] !== binding ||
        replay.released.has(role) ||
        replay.rebound.has(role)
      ) {
        replay.invalid = true;
      } else {
        replay.released.add(role);
      }
    }

    if (publication?.generation === generation) {
      this.#retirePublication(publication, Boolean(startsReplay && !startsReplay.invalid));
    } else if (!replay && generation.authority && !generation.authority.retired) {
      this.#retireDraft(generation.authority);
    }
    if (replay?.invalid) this.#invalidateReplay(replay);
  }

  #canBind(generation: KeepAgentPanelGeneration): boolean {
    const authority = generation.authority;
    return Boolean(
      authority &&
      (
        !authority.retired ||
        this.#current?.generation === generation ||
        (this.#replay?.generation === generation && !this.#replay.invalid)
      ),
    );
  }

  #beginReplay(publication: KeepAgentPanelPublication): KeepAgentPanelReplay | null {
    if (this.#replay?.publication === publication) return this.#replay;
    if (
      this.#replay ||
      publication.retired ||
      this.#current !== publication ||
      this.#replayedGenerations.has(publication.generation) ||
      this.#claimedActions.has(publication.copy) ||
      Boolean(publication.back && this.#claimedActions.has(publication.back)) ||
      Boolean(publication.retry && this.#claimedActions.has(publication.retry)) ||
      this.#claimedNavPublications.has(publication) ||
      !this.#publicationIsCurrent(publication)
    ) {
      return null;
    }
    const replay: KeepAgentPanelReplay = {
      publication,
      generation: publication.generation,
      expected: publication.bindings,
      released: new Set(),
      rebound: new Map(),
      layoutRetired: false,
      invalid: false,
    };
    this.#replay = replay;
    queueMicrotask(() => {
      if (this.#replay === replay) this.#invalidateReplay(replay);
    });
    return replay;
  }

  establish(initialDraft: KeepAgentPanelDraft, target: RefObject<HTMLPreElement | null>) {
    if (initialDraft.retired) {
      const successor = this.#replaySuccessor(initialDraft, target);
      return successor ? () => this.retire(successor) : undefined;
    }
    const { generation } = initialDraft;
    if (
      generation.authority !== initialDraft ||
      generation.target !== target ||
      this.#publishedGenerations.has(generation)
    ) {
      this.#retireDraft(initialDraft);
      return;
    }
    this.#publishedGenerations.add(generation);
    if (this.#current && this.#current.generation !== generation) {
      this.#retirePublication(this.#current, false);
    }
    const publication = this.#createPublication(initialDraft, target);
    if (!publication || !this.#publish(publication)) {
      this.#retireDraft(initialDraft);
      return;
    }
    return () => this.retire(publication);
  }

  retire(publication: KeepAgentPanelPublication) {
    const existingReplay = this.#replay;
    if (existingReplay?.publication === publication) {
      existingReplay.layoutRetired = true;
      return;
    }
    if (publication.retired) return;
    const replay = this.#beginReplay(publication);
    if (replay) replay.layoutRetired = true;
    this.#retirePublication(publication, Boolean(replay));
  }

  #replaySuccessor(
    initialDraft: KeepAgentPanelDraft,
    target: RefObject<HTMLPreElement | null>,
  ): KeepAgentPanelPublication | null {
    const replay = this.#replay;
    const { generation } = initialDraft;
    if (
      !replay ||
      replay.publication.draft !== initialDraft ||
      replay.generation !== generation ||
      generation.authority !== initialDraft ||
      generation.target !== target ||
      !initialDraft.committed ||
      !initialDraft.retired ||
      !replay.publication.retired ||
      replay.invalid ||
      !replay.layoutRetired ||
      this.#current ||
      this.#replayedGenerations.has(generation) ||
      replay.released.size !== replay.publication.roles.length ||
      replay.rebound.size !== replay.publication.roles.length ||
      replay.publication.roles.some((role) => {
        const expected = replay.expected[role];
        const rebound = replay.rebound.get(role);
        return (
          !expected ||
          !rebound ||
          rebound.element !== expected.element ||
          generation.bindings[role] !== rebound ||
          !this.#ownsBinding(rebound)
        );
      }) ||
      !this.#renderIsCurrent(initialDraft.render) ||
      !this.#mutationFree(replay.publication)
    ) {
      if (replay) this.#invalidateReplay(replay);
      return null;
    }

    const successor: KeepAgentPanelDraft = {
      identity: Symbol("keep-agent-panel-successor-draft"),
      render: initialDraft.render,
      generation,
      committed: false,
      retired: false,
    };
    this.#replayedGenerations.add(generation);
    generation.authority = successor;
    const publication = this.#createPublication(
      successor,
      target,
      replay.publication.dom,
      replay.publication.placement,
      replay.publication.navIntrinsics,
    );
    this.#replay = null;
    this.#disconnect(replay.publication);
    if (!publication || !this.#publish(publication)) {
      this.#retireDraft(successor);
      return null;
    }
    return publication;
  }

  #completeBindings(
    generation: KeepAgentPanelGeneration,
  ): Readonly<Record<PanelElementRole, KeepAgentPanelBinding | null>> | null {
    if (PANEL_ELEMENT_ROLES.some((role) =>
      Boolean(generation.elements[role]) !== Boolean(generation.bindings[role]))) {
      return null;
    }
    return Object.freeze({ ...generation.bindings });
  }

  #createPublication(
    draft: KeepAgentPanelDraft,
    target: RefObject<HTMLPreElement | null>,
    expectedDom?: KeepAgentPanelDomSnapshot,
    expectedPlacement?: readonly KeepAgentPanelPlacement[],
    expectedNavIntrinsics?: KeepAgentPanelNavIntrinsics,
  ): KeepAgentPanelPublication | null {
    const { generation, render } = draft;
    const { elements } = generation;
    const {
      panel,
      headingRow,
      heading,
      back,
      checking,
      error,
      retry,
      nav,
      tokensLink,
      connectLink,
      body,
      hint,
      promptWrapper,
      prompt,
      copy,
      after,
      clients,
      docsLink,
    } = elements;
    const bindings = this.#completeBindings(generation);
    if (
      !panel ||
      !nav ||
      !tokensLink ||
      !connectLink ||
      !body ||
      !hint ||
      !promptWrapper ||
      !prompt ||
      !copy ||
      !after ||
      !clients ||
      !docsLink ||
      !bindings ||
      (render.hideHeading ? headingRow || heading || back : !headingRow || !heading) ||
      (!render.hideHeading && render.onBack ? !back : Boolean(back)) ||
      (render.tokenCheckPending && !render.tokenCheckError ? !checking : Boolean(checking)) ||
      (render.tokenCheckError ? !error || !retry : Boolean(error || retry))
    ) {
      return null;
    }

    const prefixLength = Number(Boolean(headingRow)) + Number(Boolean(checking)) + Number(Boolean(error));
    const setup = render.showSetup ? panel.children.item(prefixLength) : null;
    if (render.showSetup && !setup) {
      return null;
    }
    const action = (kind: PanelActionKind, element: HTMLButtonElement): KeepAgentPanelAction =>
      Object.freeze({ kind, element, targets: descendantsOf(element) });
    const dom = expectedDom ?? snapshotPanelDom(panel, setup);
    const placement = expectedPlacement ?? connectedPlacement(panel);
    const ownerDocument = panel.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const navIntrinsics = expectedNavIntrinsics ??
      (ownerWindow ? capturePanelNavIntrinsics(ownerWindow) : null);
    if (
      !placement ||
      !ownerWindow ||
      !navIntrinsics ||
      navIntrinsics.ownerWindow !== ownerWindow ||
      !navIntrinsics.isCurrent()
    ) {
      return null;
    }
    const add = ownerWindow.addEventListener;
    const remove = ownerWindow.removeEventListener;
    if (typeof add !== "function" || typeof remove !== "function") return null;
    const navActions = Object.freeze({
      tokensLink: Object.freeze({
        identity: Symbol("keep-agent-panel-tokens-nav-action"),
        generation,
        render,
        sourceRole: "tokensLink",
        sourceIndex: 0,
        source: tokensLink,
        ownerDocument,
        order: PANEL_NAV_ROLES,
      } satisfies KeepAgentPanelNavAction),
      connectLink: Object.freeze({
        identity: Symbol("keep-agent-panel-connect-nav-action"),
        generation,
        render,
        sourceRole: "connectLink",
        sourceIndex: 1,
        source: connectLink,
        ownerDocument,
        order: PANEL_NAV_ROLES,
      } satisfies KeepAgentPanelNavAction),
    });
    const recordWindowEvent = this.#recordNavWindowEvent.bind(this);
    const navWindowCallback: EventListener = function (this: EventTarget, event: Event) {
      recordWindowEvent(publication, navWindowListener, this, event);
    };
    const navWindowListener: KeepAgentPanelNavWindowListener = {
      identity: Symbol("keep-agent-panel-nav-window-listener"),
      target: ownerWindow,
      add,
      remove,
      callback: navWindowCallback,
      active: false,
    };
    const publication: KeepAgentPanelPublication = {
      identity: Symbol("keep-agent-panel-publication"),
      render,
      draft,
      generation,
      target,
      elements: Object.freeze({ ...elements }),
      bindings,
      roles: Object.freeze(
        PANEL_ELEMENT_ROLES.filter((role) => Boolean(elements[role])),
      ),
      setup,
      topLevelChildren: Object.freeze(Array.from(panel.children)),
      placement,
      dom,
      ownerDocument,
      ownerWindow,
      navIntrinsics,
      navActions,
      navWindowListener,
      back: back ? action("back", back) : null,
      retry: retry ? action("retry", retry) : null,
      copy: action("copy", copy),
      pendingNavRoutes: new WeakMap(),
      retired: false,
      mutated: false,
      observer: null,
    };
    if (!this.#renderIsCurrent(render) || !this.#hierarchyIsCurrent(publication)) {
      return null;
    }
    return publication;
  }

  #publish(publication: KeepAgentPanelPublication): boolean {
    if (
      this.#current ||
      publication.retired ||
      publication.draft.retired ||
      publication.generation.authority !== publication.draft
    ) {
      return false;
    }
    const Observer = publication.ownerWindow.MutationObserver;
    if (!Observer || !publication.navIntrinsics.isCurrent()) return false;
    const observer = new Observer((records) => {
      if (this.#hasRelevantMutation(publication, records)) {
      this.#markMutated(publication);
      }
    });
    const { panel, nav, promptWrapper } = publication.elements;
    observer.observe(panel!, { attributes: true, childList: true });
    observer.observe(nav!, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    observer.observe(promptWrapper!, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    for (const action of [publication.back, publication.retry, publication.copy]) {
      if (action) {
      observer.observe(action.element, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      }
    }
    const observedParents = new Set<Node>();
    for (const { parent } of publication.placement) {
      if (parent && !observedParents.has(parent)) {
      observedParents.add(parent);
      observer.observe(parent, { childList: true });
      }
    }
    publication.observer = observer;
    if (
      publication.ownerWindow.addEventListener !==
        publication.navWindowListener.add ||
      publication.ownerWindow.removeEventListener !==
        publication.navWindowListener.remove
    ) {
      observer.disconnect();
      publication.observer = null;
      return false;
    }
    publication.navIntrinsics.apply(
      publication.navWindowListener.add,
      publication.navWindowListener.target,
      ["keydown", publication.navWindowListener.callback, true],
    );
    publication.navWindowListener.active = true;
    publication.draft.committed = true;
    this.#current = publication;
    return true;
  }

  #retirePublication(publication: KeepAgentPanelPublication, preserveObserver: boolean) {
    publication.pendingNavRoutes = new WeakMap();
    if (!publication.retired) {
      publication.retired = true;
      publication.draft.retired = true;
    }
    if (this.#current === publication) this.#current = null;
    if (!preserveObserver) this.#disconnect(publication);
  }

  #retireDraft(draft: KeepAgentPanelDraft) {
    draft.retired = true;
    if (this.#current?.draft === draft) this.#retirePublication(this.#current, false);
  }

  #retireAuthority(generation: KeepAgentPanelGeneration) {
    const authority = generation.authority;
    if (authority) this.#retireDraft(authority);
    if (this.#replay?.generation === generation) this.#invalidateReplay(this.#replay);
  }

  #invalidateReplay(replay: KeepAgentPanelReplay) {
    if (this.#replay === replay) this.#replay = null;
    replay.invalid = true;
    this.#disconnect(replay.publication);
  }

  #disconnect(publication: KeepAgentPanelPublication) {
    publication.pendingNavRoutes = new WeakMap();
    const listener = publication.navWindowListener;
    if (listener.active) {
      listener.active = false;
      publication.navIntrinsics.apply(listener.remove, listener.target, [
        "keydown",
        listener.callback,
        true,
      ]);
    }
    publication.observer?.disconnect();
    publication.observer = null;
  }

  #markMutated(publication: KeepAgentPanelPublication) {
    publication.mutated = true;
    const replay = this.#replay;
    if (replay?.publication === publication) this.#invalidateReplay(replay);
    this.#retirePublication(publication, false);
  }

  #hasRelevantMutation(
    publication: KeepAgentPanelPublication,
    records: readonly MutationRecord[],
  ): boolean {
    const panel = publication.elements.panel;
    return records.some((record) =>
      Boolean(panel?.contains(record.target)) ||
      mutationTouchesPlacement(publication.placement, record));
  }

  #mutationFree(publication: KeepAgentPanelPublication): boolean {
    if (publication.mutated) return false;
    const records = publication.observer?.takeRecords() ?? [];
    if (!this.#hasRelevantMutation(publication, records)) return true;
    this.#markMutated(publication);
    return false;
  }

  #ownsBinding(binding: KeepAgentPanelBinding): boolean {
    return binding.active &&
      binding.generation.bindings[binding.role] === binding &&
      this.#elementOwners.get(binding.element)?.binding === binding;
  }

  #publicationIsCurrent(publication: KeepAgentPanelPublication): boolean {
    return (
      this.#current === publication &&
      !publication.retired &&
      !publication.draft.retired &&
      publication.generation.authority === publication.draft &&
      publication.ownerDocument === publication.elements.panel?.ownerDocument &&
      publication.ownerWindow === publication.ownerDocument.defaultView &&
      publication.navIntrinsics.ownerWindow === publication.ownerWindow &&
      publication.navIntrinsics.isCurrent() &&
      this.#navWindowListenerIsCurrent(publication) &&
      Object.isFrozen(publication.navActions) &&
      PANEL_NAV_ROLES.every((role) =>
        publication.navActions[role].source === publication.elements[role]) &&
      this.#mutationFree(publication) &&
      this.#renderIsCurrent(publication.render) &&
      this.#hierarchyIsCurrent(publication)
    );
  }

  navigate(
    generation: KeepAgentPanelGeneration,
    sourceRole: PanelNavRole,
    event: ReactKeyboardEvent<HTMLAnchorElement>,
  ) {
    const publication = this.#current;
    const action = publication?.navActions[sourceRole];
    const source = action?.source;
    const nativeEvent = event?.nativeEvent;
    const pendingNavRoutes = publication?.pendingNavRoutes;
    const route = nativeEvent
      ? pendingNavRoutes?.get(nativeEvent)
      : undefined;
    const activeAuthentication = this.#navAuthentication;
    if (activeAuthentication) {
      if (
        nativeEvent === activeAuthentication.route.nativeEvent &&
        (
          activeAuthentication.phase === "predicates" ||
          activeAuthentication.phase === "post-predicates"
        )
      ) {
        activeAuthentication.reentered = true;
      }
      return;
    }
    if (!route) return;
    const authentication: KeepAgentPanelNavAuthentication = {
      route,
      phase: "predicates",
      reentered: false,
    };
    this.#navAuthentication = authentication;
    try {
      const capture = route.captureSnapshot;
      const captureNativeSnapshot = route.captureNativeSnapshot;
      const snapshot = publication && nativeEvent
        ? readPanelNavNativeEvent(nativeEvent, publication.navIntrinsics)
        : null;
      const bubble = publication &&
        nativeEvent instanceof publication.ownerWindow.KeyboardEvent
          ? readPanelNavReactEvent(
              event as ReactKeyboardEvent<HTMLElement>,
              nativeEvent,
              publication.navIntrinsics,
            )
          : null;
      if (
      !publication ||
      !pendingNavRoutes ||
      !action ||
      !source ||
      !snapshot ||
      !bubble ||
      route.invalid ||
      route.publication !== publication ||
      route.generation !== generation ||
      route.action !== action ||
      route.sourceRole !== sourceRole ||
      route.source !== source ||
      route.destinationRole === sourceRole ||
      route.destination !== publication.elements[route.destinationRole] ||
      route.nativeEvent !== nativeEvent ||
      publication.pendingNavRoutes !== pendingNavRoutes ||
      pendingNavRoutes.get(nativeEvent) !== route ||
      !capture ||
      !captureNativeSnapshot ||
      capture.event === bubble.event ||
      publication.generation !== generation ||
      publication.draft !== generation.authority ||
      publication.retired ||
      publication.draft.retired ||
      !publication.draft.committed ||
      !publication.render.active ||
      action.generation !== generation ||
      action.render !== publication.render ||
      action.sourceRole !== sourceRole ||
      action.sourceIndex !== PANEL_NAV_ROLES.indexOf(sourceRole) ||
      action.source !== source ||
      action.ownerDocument !== publication.ownerDocument ||
      action.order !== PANEL_NAV_ROLES ||
      !Object.isFrozen(action) ||
      bubble.type !== "keydown" ||
      bubble.currentTarget !== source ||
      bubble.target !== source ||
      bubble.eventPhase !== publication.navIntrinsics.bubblingPhase ||
      bubble.bubbles !== snapshot.bubbles ||
      bubble.cancelable !== snapshot.cancelable ||
      bubble.defaultPrevented ||
      bubble.isTrusted !== snapshot.isTrusted ||
      bubble.key !== snapshot.key ||
      bubble.code !== snapshot.code ||
      bubble.location !== snapshot.location ||
      bubble.altKey !== snapshot.altKey ||
      bubble.ctrlKey !== snapshot.ctrlKey ||
      bubble.metaKey !== snapshot.metaKey ||
      bubble.shiftKey !== snapshot.shiftKey ||
      bubble.repeat !== snapshot.repeat ||
      !Object.is(bubble.view, snapshot.view) ||
      snapshot.type !== "keydown" ||
      snapshot.target !== source ||
      snapshot.currentTarget === null ||
      snapshot.eventPhase !== publication.navIntrinsics.bubblingPhase ||
      !snapshot.bubbles ||
      !snapshot.cancelable ||
      snapshot.defaultPrevented ||
      snapshot.cancelBubble ||
      !snapshot.isTrusted ||
      snapshot.altKey ||
      snapshot.ctrlKey ||
      snapshot.metaKey ||
      snapshot.shiftKey ||
      snapshot.repeat ||
      snapshot.isComposing ||
      (snapshot.view !== null &&
        snapshot.view !== publication.ownerWindow &&
        snapshot.view !== route.windowProof.receiver) ||
      !snapshot.path.includes(snapshot.currentTarget) ||
      !panelNavNativeSnapshotsMatch(route.windowSnapshot, snapshot, false) ||
      !panelNavNativeSnapshotsMatch(
        captureNativeSnapshot,
        snapshot,
        false,
      ) ||
      captureNativeSnapshot.currentTarget !== snapshot.currentTarget ||
      captureNativeSnapshot.eventPhase !==
        publication.navIntrinsics.capturingPhase ||
      !this.#navWindowProofIsCurrent(publication, route) ||
      !panelNavReactSnapshotMatches(
        capture,
        publication.navIntrinsics,
        true,
      ) ||
      !panelNavReactSnapshotMatches(bubble, publication.navIntrinsics) ||
      publication.navIntrinsics.apply(
        publication.navIntrinsics.activeElement,
        publication.ownerDocument,
        [],
      ) !== source ||
      this.#navEffect ||
      this.#claimedReactEvents.has(capture.event) ||
      this.#claimedReactEvents.has(event) ||
      this.#claimedNativeEvents.has(nativeEvent) ||
      !this.#navActionIsCurrent(publication, action) ||
      !this.#publicationIsCurrent(publication)
      ) {
        return;
      }

      const stableSnapshot = readPanelNavNativeEvent(
        nativeEvent,
        publication.navIntrinsics,
      );
      if (
      !stableSnapshot ||
      !panelNavNativeSnapshotsMatch(snapshot, stableSnapshot, true) ||
      publication.pendingNavRoutes !== pendingNavRoutes ||
      pendingNavRoutes.get(nativeEvent) !== route ||
      route.invalid ||
      route.publication !== publication ||
      route.generation !== generation ||
      route.action !== action ||
      route.sourceRole !== sourceRole ||
      route.source !== source ||
      route.destinationRole === sourceRole ||
      route.destination !== publication.elements[route.destinationRole] ||
      route.nativeEvent !== nativeEvent ||
      route.captureSnapshot !== capture ||
      route.captureNativeSnapshot !== captureNativeSnapshot ||
      publication.generation !== generation ||
      publication.draft !== generation.authority ||
      publication.retired ||
      publication.draft.retired ||
      !publication.draft.committed ||
      !publication.render.active ||
      action.generation !== generation ||
      action.render !== publication.render ||
      action.sourceRole !== sourceRole ||
      action.sourceIndex !== PANEL_NAV_ROLES.indexOf(sourceRole) ||
      action.source !== source ||
      action.ownerDocument !== publication.ownerDocument ||
      action.order !== PANEL_NAV_ROLES ||
      !Object.isFrozen(action) ||
      !panelNavReactSnapshotIsStable(
        capture,
        publication.navIntrinsics,
        true,
      ) ||
      !panelNavReactSnapshotIsStable(
        bubble,
        publication.navIntrinsics,
      ) ||
      !this.#navWindowProofIsCurrent(publication, route) ||
      !this.#navActionIsCurrent(publication, action) ||
      !this.#publicationIsCurrent(publication) ||
      publication.navIntrinsics.apply(
        publication.navIntrinsics.activeElement,
        publication.ownerDocument,
        [],
      ) !== source ||
      this.#navEffect ||
      this.#claimedReactEvents.has(capture.event) ||
      this.#claimedReactEvents.has(event) ||
      this.#claimedNativeEvents.has(nativeEvent) ||
      authentication.reentered
      ) {
        return;
      }
      if (!pendingNavRoutes.delete(nativeEvent)) return;
      const claim: KeepAgentPanelNavClaim = Object.freeze({
      identity: Symbol("keep-agent-panel-nav-claim"),
      publication,
      generation,
      draft: publication.draft,
      nav: publication.elements.nav!,
      action,
      route,
      sourceRole,
      source,
      destinationRole: route.destinationRole,
      destination: route.destination,
      pendingNavRoutes,
      capture,
      bubble,
      nativeEvent,
      windowProof: route.windowProof,
      preventDefault: bubble.preventDefault,
      isPropagationStopped: bubble.isPropagationStopped,
      focus: publication.navIntrinsics.focus,
      });
      this.#navEffect = claim;
      this.#claimedNavPublications.add(publication);
      this.#claimedReactEvents.add(claim.capture.event);
      this.#claimedReactEvents.add(claim.bubble.event);
      this.#claimedNativeEvents.add(claim.nativeEvent);
      authentication.phase = "effect";
      try {
      const immediateSnapshot = readPanelNavNativeEvent(
        claim.nativeEvent,
        claim.publication.navIntrinsics,
      );
      if (
        this.#navEffect !== claim ||
        !immediateSnapshot ||
        !panelNavNativeSnapshotsMatch(snapshot, immediateSnapshot, true) ||
        claim.publication.generation !== claim.generation ||
        claim.publication.draft !== claim.draft ||
        claim.generation.authority !== claim.draft ||
        !claim.draft.committed ||
        claim.nav !== claim.publication.elements.nav ||
        claim.route.action !== claim.action ||
        claim.route.sourceRole !== claim.sourceRole ||
        claim.route.source !== claim.source ||
        claim.route.destinationRole !== claim.destinationRole ||
        claim.route.destination !== claim.destination ||
        claim.action.source !== claim.source ||
        claim.publication.elements[claim.destinationRole] !==
          claim.destination ||
        !claim.publication.render.active ||
        !this.#navWindowProofIsCurrent(claim.publication, claim.route) ||
        !panelNavReactSnapshotIsStable(
          claim.capture,
          claim.publication.navIntrinsics,
          true,
        ) ||
        !panelNavReactSnapshotIsStable(
          claim.bubble,
          claim.publication.navIntrinsics,
        ) ||
        claim.bubble.preventDefault !== claim.preventDefault ||
        claim.bubble.isPropagationStopped !== claim.isPropagationStopped ||
        !this.#navActionIsCurrent(claim.publication, claim.action) ||
        !this.#publicationIsCurrent(claim.publication) ||
        claim.publication.navIntrinsics.apply(
          claim.publication.navIntrinsics.activeElement,
          claim.publication.ownerDocument,
          [],
        ) !== claim.source
      ) {
        return;
      }

      try {
        claim.publication.navIntrinsics.apply(
          claim.preventDefault,
          claim.bubble.event,
          [],
        );
      } catch {
        return;
      }
      const preventedSnapshot = readPanelNavNativeEvent(
        claim.nativeEvent,
        claim.publication.navIntrinsics,
      );
      if (
        this.#navEffect !== claim ||
        !preventedSnapshot ||
        !panelNavNativeSnapshotIsPrevented(
          immediateSnapshot,
          preventedSnapshot,
        ) ||
        claim.publication.pendingNavRoutes !== claim.pendingNavRoutes ||
        claim.pendingNavRoutes.has(claim.nativeEvent) ||
        claim.bubble.preventDefault !== claim.preventDefault ||
        claim.bubble.isPropagationStopped !== claim.isPropagationStopped ||
        !panelNavReactSnapshotIsStable(
         claim.capture,
         claim.publication.navIntrinsics,
         true,
        ) ||
        !this.#navWindowProofIsCurrent(claim.publication, claim.route) ||
        !this.#navActionIsCurrent(claim.publication, claim.action) ||
        !this.#publicationIsCurrent(claim.publication) ||
        claim.publication.navIntrinsics.apply(
          claim.publication.navIntrinsics.activeElement,
          claim.publication.ownerDocument,
          [],
        ) !== claim.source
      ) {
        return;
      }
      authentication.phase = "post-predicates";
      const preventedProof = readPanelNavReactPreventedProof(
        claim.bubble,
        claim.publication.navIntrinsics,
      );
      authentication.phase = "final";
      const finalSnapshot = readPanelNavNativeEvent(
        claim.nativeEvent,
        claim.publication.navIntrinsics,
      );
      if (
        this.#navEffect !== claim ||
        !preventedProof ||
        !finalSnapshot ||
        !panelNavNativeSnapshotIsPrevented(
          immediateSnapshot,
          finalSnapshot,
        ) ||
        !panelNavNativeSnapshotsMatch(
          preventedSnapshot,
          finalSnapshot,
          true,
        ) ||
        claim.publication.generation !== claim.generation ||
        claim.publication.draft !== claim.draft ||
        claim.generation.authority !== claim.draft ||
        claim.publication.retired ||
        claim.draft.retired ||
        !claim.draft.committed ||
        claim.nav !== claim.publication.elements.nav ||
        claim.route.publication !== claim.publication ||
        claim.route.generation !== claim.generation ||
        claim.route.action !== claim.action ||
        claim.route.sourceRole !== claim.sourceRole ||
        claim.route.source !== claim.source ||
        claim.route.destinationRole !== claim.destinationRole ||
        claim.route.destination !== claim.destination ||
        claim.route.nativeEvent !== claim.nativeEvent ||
        claim.route.windowProof !== claim.windowProof ||
        claim.action.source !== claim.source ||
        claim.publication.elements[claim.sourceRole] !== claim.source ||
        claim.publication.elements[claim.destinationRole] !==
          claim.destination ||
        claim.publication.pendingNavRoutes !== claim.pendingNavRoutes ||
        claim.pendingNavRoutes.has(claim.nativeEvent) ||
        !claim.publication.render.active ||
        !panelNavReactSnapshotIsStable(
          claim.capture,
          claim.publication.navIntrinsics,
          true,
        ) ||
        !panelNavReactSnapshotIsStable(
          claim.bubble,
          claim.publication.navIntrinsics,
          false,
          true,
          preventedProof.isDefaultPrevented,
        ) ||
        claim.bubble.preventDefault !== claim.preventDefault ||
        claim.bubble.isPropagationStopped !== claim.isPropagationStopped ||
        preventedProof.defaultPrevented !== true ||
        preventedProof.propagationStopped !== false ||
        claim.focus !== claim.publication.navIntrinsics.focus ||
        !this.#claimedNavPublications.has(claim.publication) ||
        !this.#claimedReactEvents.has(claim.capture.event) ||
        !this.#claimedReactEvents.has(claim.bubble.event) ||
        !this.#claimedNativeEvents.has(claim.nativeEvent) ||
        authentication.reentered ||
        !this.#navWindowProofIsCurrent(claim.publication, claim.route) ||
        !this.#navActionIsCurrent(claim.publication, claim.action) ||
        !this.#publicationIsCurrent(claim.publication) ||
        claim.publication.navIntrinsics.apply(
          claim.publication.navIntrinsics.activeElement,
          claim.publication.ownerDocument,
          [],
        ) !== claim.source
      ) {
        return;
      }
      claim.publication.navIntrinsics.apply(claim.focus, claim.destination, [
        { preventScroll: true },
      ]);
      } finally {
        if (this.#navEffect === claim) this.#navEffect = null;
      }
    } finally {
      if (this.#navAuthentication === authentication) {
        this.#navAuthentication = null;
      }
    }
  }

  captureNavigation(
    generation: KeepAgentPanelGeneration,
    event: ReactKeyboardEvent<HTMLElement>,
  ) {
    const publication = this.#current;
    const nativeEvent = event?.nativeEvent;
    const pendingNavRoutes = publication?.pendingNavRoutes;
    const route = nativeEvent
      ? pendingNavRoutes?.get(nativeEvent)
      : undefined;
    if (
      !publication ||
      !pendingNavRoutes ||
      !route ||
      route.nativeEvent !== nativeEvent ||
      route.invalid
    ) {
      return;
    }
    const nativeSnapshot = readPanelNavNativeEvent(
      nativeEvent,
      publication.navIntrinsics,
    );
    const capture =
      nativeEvent instanceof publication.ownerWindow.KeyboardEvent
        ? readPanelNavReactEvent(
            event,
            nativeEvent,
            publication.navIntrinsics,
          )
        : null;
    if (
      !nativeSnapshot ||
      !capture ||
      route.captureSnapshot ||
      route.captureNativeSnapshot ||
      route.publication !== publication ||
      route.generation !== generation ||
      publication.generation !== generation ||
      publication.pendingNavRoutes !== pendingNavRoutes ||
      pendingNavRoutes.get(nativeEvent) !== route ||
      capture.type !== "keydown" ||
      capture.currentTarget !== publication.elements.nav ||
      capture.target !== route.source ||
      capture.eventPhase !== publication.navIntrinsics.capturingPhase ||
      capture.bubbles !== nativeSnapshot.bubbles ||
      capture.cancelable !== nativeSnapshot.cancelable ||
      capture.defaultPrevented ||
      capture.isTrusted !== nativeSnapshot.isTrusted ||
      capture.key !== nativeSnapshot.key ||
      capture.code !== nativeSnapshot.code ||
      capture.location !== nativeSnapshot.location ||
      capture.altKey !== nativeSnapshot.altKey ||
      capture.ctrlKey !== nativeSnapshot.ctrlKey ||
      capture.metaKey !== nativeSnapshot.metaKey ||
      capture.shiftKey !== nativeSnapshot.shiftKey ||
      capture.repeat !== nativeSnapshot.repeat ||
      !Object.is(capture.view, nativeSnapshot.view) ||
      nativeSnapshot.currentTarget === null ||
      nativeSnapshot.eventPhase !== publication.navIntrinsics.capturingPhase ||
      !nativeSnapshot.path.includes(nativeSnapshot.currentTarget) ||
      !panelNavNativeSnapshotsMatch(
        route.windowSnapshot,
        nativeSnapshot,
        false,
      ) ||
      !this.#navWindowProofIsCurrent(publication, route) ||
      !this.#navActionIsCurrent(publication, route.action) ||
      !this.#publicationIsCurrent(publication)
    ) {
      route.invalid = true;
      return;
    }
    route.captureSnapshot = capture;
    route.captureNativeSnapshot = nativeSnapshot;
  }

  #recordNavWindowEvent(
    publication: KeepAgentPanelPublication,
    listener: KeepAgentPanelNavWindowListener,
    receiver: EventTarget,
    nativeEvent: Event,
  ) {
    if (this.#navAuthentication || this.#navEffect) return;
    const pendingNavRoutes = publication.pendingNavRoutes;
    const snapshot = readPanelNavNativeEvent(
      nativeEvent,
      publication.navIntrinsics,
    );
    if (
      !snapshot ||
      !(nativeEvent instanceof publication.ownerWindow.KeyboardEvent) ||
      !listener.active ||
      listener !== publication.navWindowListener ||
      snapshot.type !== "keydown" ||
      snapshot.target === null ||
      snapshot.currentTarget !== receiver ||
      snapshot.eventPhase !== publication.navIntrinsics.capturingPhase ||
      !snapshot.bubbles ||
      !snapshot.cancelable ||
      snapshot.defaultPrevented ||
      snapshot.cancelBubble ||
      !snapshot.isTrusted ||
      snapshot.altKey ||
      snapshot.ctrlKey ||
      snapshot.metaKey ||
      snapshot.shiftKey ||
      snapshot.repeat ||
      snapshot.isComposing ||
      pendingNavRoutes.has(nativeEvent) ||
      this.#claimedNativeEvents.has(nativeEvent) ||
      (snapshot.view !== null &&
        snapshot.view !== publication.ownerWindow &&
        snapshot.view !== receiver) ||
      snapshot.path.at(-1) !== receiver ||
      !publication.render.active ||
      !this.#navWindowListenerIsCurrent(publication) ||
      !this.#publicationIsCurrent(publication)
    ) {
      return;
    }
    const sourceRole = PANEL_NAV_ROLES.find(
      (role) => publication.elements[role] === snapshot.target,
    );
    const action = sourceRole
      ? publication.navActions[sourceRole]
      : undefined;
    const destinationIndex = action
      ? panelNavDestination(snapshot.key, action.sourceIndex)
      : -1;
    const destinationRole = destinationIndex >= 0
      ? PANEL_NAV_ROLES[destinationIndex]
      : undefined;
    const destination = destinationRole
      ? publication.elements[destinationRole]
      : undefined;
    if (
      !sourceRole ||
      !action ||
      !destinationRole ||
      !(destination instanceof publication.ownerWindow.HTMLAnchorElement) ||
      destinationRole === sourceRole ||
      !panelNavPathMatches(
        snapshot.path,
        action.source,
        publication.ownerDocument,
        receiver,
      ) ||
      publication.navIntrinsics.apply(
        publication.navIntrinsics.activeElement,
        publication.ownerDocument,
        [],
      ) !== action.source ||
      !this.#navActionIsCurrent(publication, action)
    ) {
      return;
    }
    const windowProof: KeepAgentPanelNavWindowProof = Object.freeze({
      identity: Symbol("keep-agent-panel-nav-window-proof"),
      listener,
      receiver,
      currentTarget: snapshot.currentTarget,
      pathTerminal: snapshot.path.at(-1)!,
    });
    if (
      publication.pendingNavRoutes !== pendingNavRoutes ||
      pendingNavRoutes.has(nativeEvent)
    ) {
      return;
    }
    pendingNavRoutes.set(nativeEvent, {
      identity: Symbol("keep-agent-panel-nav-route"),
      publication,
      generation: publication.generation,
      action,
      sourceRole,
      source: action.source,
      destinationRole,
      destination,
      nativeEvent: nativeEvent as KeyboardEvent,
      windowSnapshot: snapshot,
      windowProof,
      captureSnapshot: null,
      captureNativeSnapshot: null,
      invalid: false,
    });
  }

  #navWindowListenerIsCurrent(
    publication: KeepAgentPanelPublication,
  ): boolean {
    const listener = publication.navWindowListener;
    try {
      return listener.active &&
        listener.target === publication.ownerWindow &&
        publication.ownerWindow.addEventListener === listener.add &&
        publication.ownerWindow.removeEventListener === listener.remove &&
        publication.navIntrinsics.isCurrent();
    } catch {
      return false;
    }
  }

  #navWindowProofIsCurrent(
    publication: KeepAgentPanelPublication,
    route: KeepAgentPanelNavRoute,
  ): boolean {
    const { windowProof } = route;
    return route.publication === publication &&
      windowProof.listener === publication.navWindowListener &&
      windowProof.receiver === windowProof.currentTarget &&
      windowProof.receiver === windowProof.pathTerminal &&
      route.windowSnapshot.currentTarget === windowProof.currentTarget &&
      route.windowSnapshot.path.at(-1) === windowProof.pathTerminal &&
      this.#navWindowListenerIsCurrent(publication);
  }

  #navActionIsCurrent(
    publication: KeepAgentPanelPublication,
    action: KeepAgentPanelNavAction,
  ): boolean {
    return Object.isFrozen(publication.navActions) &&
      Object.isFrozen(action) &&
      publication.navActions[action.sourceRole] === action &&
      action.generation === publication.generation &&
      action.render === publication.render &&
      action.source === publication.elements[action.sourceRole] &&
      action.ownerDocument === publication.ownerDocument &&
      action.order === PANEL_NAV_ROLES &&
      action.sourceIndex === PANEL_NAV_ROLES.indexOf(action.sourceRole);
  }

  activate(
    generation: KeepAgentPanelGeneration,
    kind: PanelActionKind,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) {
    const publication = this.#current;
    const action = publication?.[kind];
    const element = action?.element;
    const document = element?.ownerDocument;
    const MouseEventConstructor = document?.defaultView?.MouseEvent;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !publication ||
      !action ||
      publication.generation !== generation ||
      publication.draft !== generation.authority ||
      publication.retired ||
      publication.draft.retired ||
      !element ||
      !document ||
      !MouseEventConstructor ||
      !event ||
      event.type !== "click" ||
      event.button !== 0 ||
      event.defaultPrevented ||
      !(nativeEvent instanceof MouseEventConstructor) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      nativeEvent.defaultPrevented ||
      !nativeEvent.bubbles ||
      event.currentTarget !== element ||
      nativeEvent.target !== target ||
      !isNodeFromDocument(target, document) ||
      !target.isConnected ||
      !element.contains(target) ||
      !action.targets.includes(target) ||
      !nativePathMatches(nativeEvent, target, document) ||
      !element.isConnected ||
      element.disabled ||
      element.matches(":disabled") ||
      this.#claimedActions.has(action) ||
      this.#claimedReactEvents.has(event) ||
      this.#claimedNativeEvents.has(nativeEvent) ||
      !this.#publicationIsCurrent(publication) ||
      (kind === "back" && !publication.render.onBack) ||
      (kind === "retry" && (!publication.render.tokenCheckError || publication.render.tokenCheckPending))
    ) {
      return;
    }

    this.#claimedActions.add(action);
    this.#claimedReactEvents.add(event);
    this.#claimedNativeEvents.add(nativeEvent);
    if (kind === "back") publication.render.onBack?.();
    else if (kind === "retry") publication.render.retryTokenCheck();
    else publication.render.copy();
  }
}

/** The "Keep an agent here" contents: the Connect-an-agent card for first-timers, then the sentence and a Copy button. */
function KeepAgentHerePanelContent({
  doc,
  onCreateToken,
  onBack,
  active,
  hideHeading,
  tokenSetup,
}: KeepAgentHerePanelProps & { active: boolean; hideHeading: boolean; tokenSetup: TokenSetupCheck }) {
  const docId = doc.id;
  const docTitle = doc.title;
  const prompt = keepAgentPrompt({ id: docId, title: docTitle });
  const pre = useRef<HTMLPreElement>(null);
  const copyResult = useCopy(prompt, pre);
  const copySetup: CopySetup = Object.freeze({
    copy: copyResult.copy,
    status: copyResult.status,
    label: copyResult.label,
    copied: copyResult.copied,
  });
  const origin = useOrigin();
  const { hasTokens, pending: tokenCheckPending, error: tokenCheckError, retry: retryTokenCheck } = tokenSetup;
  const [mount] = useState(() => Symbol("keep-agent-panel"));
  const [coordinator] = useState(() => new KeepAgentPanelCoordinator(mount));
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    if (active) setDismissed(readDismissed());
  }, [active]);
  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(AGENT_CONNECT_DISMISSED_KEY, "1");
    } catch {
      /* private mode */
    }
  };
  const showSetup = hasTokens === false && !dismissed;
  const render: KeepAgentPanelRender = Object.freeze({
    identity: Symbol("keep-agent-panel-render"),
    mount,
    doc,
    docId,
    docTitle,
    prompt,
    onCreateToken,
    onBack,
    active,
    hideHeading,
    tokenSetup,
    hasTokens,
    tokenCheckPending,
    tokenCheckError,
    retryTokenCheck,
    copySetup,
    copy: copySetup.copy,
    copyStatus: copySetup.status,
    copyLabel: copySetup.label,
    copied: copySetup.copied,
    origin,
    dismissed,
    dismiss,
    showSetup,
    tokensHref: `/settings?next=${encodeURIComponent(`/d/${docId}`)}#tokens`,
    connectHref: `/settings?next=${encodeURIComponent(`/d/${docId}`)}#connect`,
    docsHref: `${AGENT_DOCS_URL}#sit-in-a-document`,
    promptTestId: "keep-agent-prompt",
    copyTestId: "keep-agent-copy",
    copyAriaLabel: COPY_LABEL,
  });
  const draft = coordinator.createDraft(render);

  useLayoutEffect(() => coordinator.establish(draft, pre), [coordinator, draft, pre]);

  return (
    <div ref={(element) => coordinator.bindElement(draft, "panel", element)} className={PANEL_CLASS} data-testid="keep-agent-panel">
      {!render.hideHeading && (
        <div ref={(element) => coordinator.bindElement(draft, "headingRow", element)} className={HEADING_ROW_CLASS}>
          {render.onBack && (
            <button
              ref={(element) => coordinator.bindElement(draft, "back", element)}
              type="button"
              className={BACK_CLASS}
              onClick={(event) => coordinator.activate(draft.generation, "back", event)}
              aria-label="Back"
              data-testid="keep-agent-back"
            >
              <ArrowLeft size={15} />
            </button>
          )}
          <h3 ref={(element) => coordinator.bindElement(draft, "heading", element)} className={HEADING_CLASS}>
            <Radio size={15} className="text-violet-600" /> Keep an agent here
          </h3>
        </div>
      )}
      {render.tokenCheckPending && !render.tokenCheckError && (
        <p
          ref={(element) => coordinator.bindElement(draft, "checking", element)}
          className={CHECKING_CLASS}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="keep-agent-token-checking"
        >
          Checking token setup…
        </p>
      )}
      {render.tokenCheckError && (
        <div
          ref={(element) => coordinator.bindElement(draft, "error", element)}
          className={ERROR_CLASS}
          data-testid="keep-agent-token-error"
        >
          <span className="min-w-0 flex-1" role="alert" aria-atomic="true">{render.tokenCheckError}</span>
          <button
            ref={(element) => coordinator.bindElement(draft, "retry", element)}
            type="button"
            className={RETRY_CLASS}
            onClick={(event) => coordinator.activate(draft.generation, "retry", event)}
            disabled={render.tokenCheckPending}
            aria-busy={render.tokenCheckPending || undefined}
          >
            {render.tokenCheckPending ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {render.showSetup && <AgentConnectCard origin={render.origin} onDismiss={render.dismiss} onCreateToken={render.onCreateToken} className="p-3" />}
      <nav
        ref={(element) => coordinator.bindElement(draft, "nav", element)}
        className={NAV_CLASS}
        aria-label="Agent setup"
        onKeyDownCapture={(event) =>
          coordinator.captureNavigation(draft.generation, event)}
      >
        <a
          ref={(element) => coordinator.bindElement(draft, "tokensLink", element)}
          className={LINK_CLASS}
          href={render.tokensHref}
          onKeyDown={(event) =>
            coordinator.navigate(draft.generation, "tokensLink", event)}
        >
          Tokens
        </a>
        <a
          ref={(element) => coordinator.bindElement(draft, "connectLink", element)}
          className={CONNECT_LINK_CLASS}
          href={render.connectHref}
          onKeyDown={(event) =>
            coordinator.navigate(draft.generation, "connectLink", event)}
        >
          Connect an MCP client
        </a>
      </nav>
      <p ref={(element) => coordinator.bindElement(draft, "body", element)} className={BODY_CLASS}>{PANEL_BODY}</p>
      <p ref={(element) => coordinator.bindElement(draft, "hint", element)} className={HINT_CLASS} data-testid="keep-agent-hint">
        {KEEP_AGENT_HINT}
      </p>
      <div ref={(element) => coordinator.bindElement(draft, "promptWrapper", element)} className={PROMPT_WRAPPER_CLASS}>
        <pre
          ref={(element) => coordinator.bindPrompt(draft, pre, element)}
          className={PROMPT_CLASS}
          data-testid={render.promptTestId}
        >
          {render.prompt}
        </pre>
        <button
          ref={(element) => coordinator.bindElement(draft, "copy", element)}
          type="button"
          className={COPY_CLASS}
          onClick={(event) => coordinator.activate(draft.generation, "copy", event)}
          aria-label={render.copyAriaLabel}
          data-testid={render.copyTestId}
        >
          {render.copied ? <Check size={14} /> : <Copy size={14} />}
          {render.copyLabel}
        </button>
      </div>
      <p ref={(element) => coordinator.bindElement(draft, "after", element)} className={BODY_CLASS} data-testid="keep-agent-after">
        {KEEP_AGENT_AFTER}
      </p>
      <p ref={(element) => coordinator.bindElement(draft, "clients", element)} className={BODY_CLASS} data-testid="keep-agent-clients">
        {CLIENTS}
      </p>
      <a
        ref={(element) => coordinator.bindElement(draft, "docsLink", element)}
        className={DOCS_LINK_CLASS}
        href={render.docsHref}
        target="_blank"
        rel="noreferrer"
        data-testid="keep-agent-docs-link"
      >
        Agent docs <span aria-hidden="true">·</span> Sit in a document <ExternalLink size={13} aria-hidden="true" />
      </a>
    </div>
  );
}

export function KeepAgentHerePanel({ doc, onCreateToken, onBack, active = true, hideHeading = false }: KeepAgentHerePanelProps) {
  const tokenSetup = useHasTokens(active);
  return (
    <KeepAgentHerePanelContent
      doc={doc}
      onCreateToken={onCreateToken}
      onBack={onBack}
      active={active}
      hideHeading={hideHeading}
      tokenSetup={tokenSetup}
    />
  );
}

export interface KeepAgentHereDialogProps {
  doc: { id: string; title: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateToken?: () => void;
}

/**
 * "Keep an agent here" as a dialog: the {@link KeepAgentHerePanel} with the ready-to-paste sentence. Opened from
 * the presence popover, the command palette (`doc:keep-agent`) and the editor's `/agent` slash item.
 */
export function KeepAgentHereDialog({ doc, open, onOpenChange, onCreateToken }: KeepAgentHereDialogProps) {
  const tokenSetup = useHasTokens(open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keep an agent here" className="max-h-[calc(100dvh-2rem)] w-[min(94vw,520px)] overflow-y-auto">
        <div data-testid="keep-agent-dialog">
          <KeepAgentHerePanelContent doc={doc} onCreateToken={onCreateToken} active={open} hideHeading tokenSetup={tokenSetup} />
        </div>
      </DialogContent>
    </Dialog>
  );
}