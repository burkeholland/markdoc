"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from "react";
import { Bot, MessageSquare, X } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { api } from "@/lib/api";
import {
  HINTS,
  HINTS_MIN_WIDTH,
  EMPTY_HINTS_RECORD,
  allHintsDismissed,
  dueHint,
  readHintsRecord,
  withDismissed,
  writeHintsRecord,
  type HintId,
  type HintsRecord,
} from "@/lib/hints";
import { useMediaQuery } from "@/lib/viewport-hooks";
import { shallowEqual, useOpenSettled, useSessionValue } from "./use-session";
import type { EditorActions } from "./actions";

export interface HintBarProps {
  session: CollabSession;
  actions: EditorActions;
  onShare: () => void;
  /** Hint (b): opens a comment on the whole document with `@` already typed, so the agent picker is up. */
  onComment: () => void;
}

const ICONS: Record<HintId, typeof Bot> = {
  "collab-agent": Bot,
  "mention-copilot": MessageSquare,
};

const noopSubscribe = () => () => {};

/** Quiet retry cadence for the optional collaborator/agent discovery behind hint (a). */
export const COLLAB_HINT_RETRY_MS = 30_000;

interface CollaboratorEvidence {
  collaborators: number;
  agentKnown: boolean;
}

interface DiscoveryKey {
  session: CollabSession;
  documentId: string;
}

interface DiscoverySnapshot {
  authority: DiscoveryAuthority;
  collaborators: CollaboratorEvidence | null;
  tokenUsed: boolean | null;
}

type DiscoverySource = "collaborators" | "tokens";

interface DiscoveryAuthority {
  key: DiscoveryKey;
  collaborators: CollaboratorEvidence | null;
  tokenUsed: boolean | null;
  visible: boolean;
  generation: number;
  retry: DiscoveryRetry | null;
  run: (() => void) | null;
  visibilityListener: (() => void) | null;
  retired: boolean;
}

interface DiscoveryOperation {
  authority: DiscoveryAuthority;
  source: DiscoverySource;
  generation: number;
  operation: number;
}

interface DiscoveryRetry {
  authority: DiscoveryAuthority;
  timer: ReturnType<typeof setTimeout> | null;
}

interface DiscoveryCoordinator {
  authority: DiscoveryAuthority | null;
  collaboratorsOperation: DiscoveryOperation | null;
  tokenOperation: DiscoveryOperation | null;
  nextOperation: number;
}

interface PinnedHint {
  key: DiscoveryKey;
  id: HintId;
}

const HINT_ROOT_CLASS =
  "flex h-9 shrink-0 items-center gap-3 border-b border-line bg-accent-soft px-4 text-[13px] text-ink";
const HINT_ICON_CLASS = "shrink-0 text-accent";
const HINT_TEXT_CLASS = "min-w-0 truncate";
const HINT_ACTION_CLASS =
  "btn btn-sm btn-outline ml-auto h-6 shrink-0 px-2 text-xs";
const HINT_DISMISS_CLASS =
  "icon-btn h-6 w-6 shrink-0 text-ink-3 hover:text-ink";

interface HintVisit {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly session: CollabSession;
  readonly documentId: string;
  readonly role: CollabSession["role"];
  readonly canEdit: boolean;
}

interface HintRecordSnapshot {
  readonly dismissed: readonly HintId[];
  readonly agentSeen: boolean;
}

interface HintRender {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly visit: HintVisit;
  readonly key: DiscoveryKey;
  readonly session: CollabSession;
  readonly documentId: string;
  readonly role: CollabSession["role"];
  readonly canEdit: boolean;
  readonly id: HintId;
  readonly message: string;
  readonly actionLabel: string;
  readonly record: HintRecordSnapshot;
  readonly dismissedRecord: HintRecordSnapshot;
  readonly pin: PinnedHint;
  readonly actions: EditorActions;
  readonly focus: EditorActions["focus"];
  readonly onShare: () => void;
  readonly onComment: () => void;
  readonly primaryCallback: () => void;
  readonly storage: Storage;
  readonly discovery: DiscoveryAuthority | null;
}

type HintElementRole =
  "root" | "icon" | "text" | "action" | "dismiss" | "dismissIcon";

interface HintElementOwnerView {
  readonly role: HintElementRole;
  readonly element: () => Element | null;
}

interface HintRefReplay {
  readonly owner: HintElementOwnerView;
  readonly element: Element;
  state: "attached" | "detached" | "reattached" | "invalid";
}

interface HintDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly HintDomSnapshot[];
}

interface HintNodePlacement {
  readonly node: Node;
  readonly parent: Node | null;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

type HintPlacement = readonly HintNodePlacement[];

interface HintDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

type HintControlKind = "primary" | "dismiss";

interface HintAction {
  readonly identity: symbol;
  readonly kind: HintControlKind | "preserve-focus";
  readonly render: HintRender;
  readonly callback: (() => void) | null;
}

interface HintControl {
  readonly identity: symbol;
  readonly kind: HintControlKind;
  readonly render: HintRender;
  readonly element: HTMLButtonElement;
  readonly action: HintAction;
  readonly targets: readonly Node[];
}

interface HintNativeMouseProof {
  readonly event: MouseEvent;
  readonly control: HintControl;
  readonly target: Node;
  readonly path: readonly EventTarget[];
}

interface HintKeyboardProof {
  readonly event: KeyboardEvent;
  readonly control: HintControl;
  readonly key: "Enter" | " ";
  readonly target: Node;
  readonly path: readonly EventTarget[];
}

interface HintKeyboardReleaseProof extends HintKeyboardProof {
  readonly down: HintKeyboardProof;
}

interface HintNativeClickProof extends HintNativeMouseProof {
  readonly source:
    HintNativeMouseProof | HintKeyboardProof | HintKeyboardReleaseProof;
  readonly pointerUp: HintNativeMouseProof | null;
}

interface HintReactProof {
  readonly event: object;
  readonly native: HintNativeMouseProof | HintNativeClickProof;
}

type HintNavigationKey =
  "ArrowLeft" | "ArrowUp" | "ArrowRight" | "ArrowDown" | "Home" | "End";

type HintKeyPhase = "capture" | "bubble";

interface HintCapturedIntrinsic {
  readonly isCurrent: () => boolean;
}

interface HintCapturedGetter<Value> extends HintCapturedIntrinsic {
  readonly read: (target: object) => Value;
}

interface HintCapturedValue<Value> extends HintCapturedIntrinsic {
  readonly read: () => Value;
}

interface HintCapturedMethod<
  Args extends readonly unknown[],
  Result,
> extends HintCapturedIntrinsic {
  readonly invoke: (target: object, ...args: Args) => Result;
}

interface HintTrustedGetter extends HintCapturedIntrinsic {
  readonly read: (event: object) => boolean;
  readonly matches: (event: object) => boolean;
}

interface HintKeyboardAuthority {
  readonly ownerWindow: Window & typeof globalThis;
  readonly Event: typeof globalThis.Event;
  readonly KeyboardEvent: typeof globalThis.KeyboardEvent;
  readonly Node: typeof globalThis.Node;
  readonly apply: typeof Reflect.apply;
  readonly eventType: HintCapturedGetter<string>;
  readonly eventTarget: HintCapturedGetter<EventTarget | null>;
  readonly eventCurrentTarget: HintCapturedGetter<EventTarget | null>;
  readonly eventPhase: HintCapturedGetter<number>;
  readonly eventBubbles: HintCapturedGetter<boolean>;
  readonly eventCancelable: HintCapturedGetter<boolean>;
  readonly eventDefaultPrevented: HintCapturedGetter<boolean>;
  readonly eventCancelBubble: HintCapturedGetter<boolean>;
  readonly eventPath: HintCapturedMethod<readonly [], EventTarget[]>;
  readonly eventPreventDefault: HintCapturedMethod<readonly [], void>;
  readonly eventView: HintCapturedGetter<Window | null>;
  readonly key: HintCapturedGetter<string>;
  readonly code: HintCapturedGetter<string>;
  readonly location: HintCapturedGetter<number>;
  readonly repeat: HintCapturedGetter<boolean>;
  readonly composing: HintCapturedGetter<boolean>;
  readonly altKey: HintCapturedGetter<boolean>;
  readonly ctrlKey: HintCapturedGetter<boolean>;
  readonly metaKey: HintCapturedGetter<boolean>;
  readonly shiftKey: HintCapturedGetter<boolean>;
  readonly activeElement: HintCapturedGetter<Element | null>;
  readonly documentView: HintCapturedValue<Window | null>;
  readonly focus: HintCapturedMethod<readonly [FocusOptions?], void>;
  readonly windowListen: HintCapturedMethod<
    readonly [string, EventListener, boolean],
    void
  >;
  readonly windowUnlisten: HintCapturedMethod<
    readonly [string, EventListener, boolean],
    void
  >;
  readonly trusted: HintTrustedGetter;
  readonly reactMethodMatches: (
    event: object,
    property: PropertyKey,
    value: unknown,
  ) => boolean;
  readonly isCurrent: () => boolean;
}

interface HintReactKeyMethods {
  readonly preventDefault: (...args: never[]) => unknown;
  readonly isDefaultPrevented: (...args: never[]) => unknown;
  readonly isPropagationStopped: (...args: never[]) => unknown;
}

interface HintReactKeyFacts {
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly key: HintNavigationKey;
  readonly delegationTarget: Node;
  readonly methods: HintReactKeyMethods;
}

interface HintNativeKeySnapshot {
  readonly event: globalThis.KeyboardEvent;
  readonly publication: HintPublication;
  readonly source: HintControl;
  readonly key: HintNavigationKey;
  readonly code: string;
  readonly location: number;
  readonly target: EventTarget | null;
  readonly path: readonly EventTarget[];
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly view: Window | null;
  readonly receiver: EventTarget;
}

interface HintNativeKeyDelivery {
  readonly snapshot: HintNativeKeySnapshot;
  delegationTarget: Node | null;
  captureInvalid: boolean;
  captureRootCount: number;
  captureRootEvent: ReactKeyboardEvent<HTMLElement> | null;
  captureMethods: HintReactKeyMethods | null;
  captureControlCount: number;
  captureControlEvent: ReactKeyboardEvent<HTMLButtonElement> | null;
  bubbleInvalid: boolean;
  bubbleMethods: HintReactKeyMethods | null;
  bubbleControlCount: number;
  bubbleControlEvent: ReactKeyboardEvent<HTMLButtonElement> | null;
  bubbleRootCount: number;
  bubbleRootEvent: ReactKeyboardEvent<HTMLElement> | null;
}

interface HintNavigationMovement {
  readonly identity: symbol;
  readonly publication: HintPublication;
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly captureEvent: ReactKeyboardEvent<HTMLButtonElement>;
  readonly bubbleEvent: ReactKeyboardEvent<HTMLButtonElement>;
  readonly receiver: EventTarget;
  readonly key: HintNavigationKey;
  readonly source: HintControl;
  readonly destination: HintControl;
}

interface HintPublication {
  readonly identity: symbol;
  readonly render: HintRender;
  readonly root: HTMLDivElement;
  readonly ownerDocument: Document;
  readonly controls: Readonly<Record<HintControlKind, HintControl>>;
  readonly preserveFocus: HintAction;
  readonly keyboard: HintKeyboardAuthority | null;
  readonly dom: HintDomSnapshot;
  readonly placement: HintPlacement;
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
}

interface HintReplay {
  readonly source: HintPublication;
  readonly dom: HintDomSnapshot;
  readonly placement: HintPlacement;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface HintPublicationCells {
  readonly active: { current: HintPublication | null };
  readonly successorOf: { current: HintPublication | null };
  readonly replay: { current: HintReplay | null };
  readonly claimedVisits: WeakSet<HintVisit>;
  readonly claimedPublications: WeakSet<HintPublication>;
  readonly claimedControls: WeakSet<HintControl>;
  readonly claimedActions: WeakSet<HintAction>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
  readonly claimedMovements: WeakSet<HintNavigationMovement>;
  readonly pressedPublications: WeakSet<HintPublication>;
  readonly pressedControls: WeakSet<HintControl>;
  readonly pressedActions: WeakSet<HintAction>;
}

interface HintPublicationRuntime {
  readonly publication: HintPublication;
  readonly publish: () => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: HintElementOwnerView,
    element: Element | null,
    previous: Element | null,
  ) => void;
  readonly isExactReplay: () => boolean;
  readonly replay: () => HintReplay | null;
  readonly captureReactMouseDown: (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => void;
  readonly captureReactClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly captureReactRootKey: (
    phase: HintKeyPhase,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
  readonly captureReactControlKey: (
    kind: HintControlKind,
    phase: HintKeyPhase,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly preserveActionFocus: (
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
  readonly activate: (
    kind: HintControlKind,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => HintPublication | null;
}

interface HintPublicationSet {
  readonly establish: () => void | (() => void);
  readonly captureRoot: (element: HTMLDivElement | null) => void | (() => void);
  readonly captureIcon: (element: SVGSVGElement | null) => void | (() => void);
  readonly captureText: (
    element: HTMLSpanElement | null,
  ) => void | (() => void);
  readonly captureAction: (
    element: HTMLButtonElement | null,
  ) => void | (() => void);
  readonly captureDismiss: (
    element: HTMLButtonElement | null,
  ) => void | (() => void);
  readonly captureDismissIcon: (
    element: SVGSVGElement | null,
  ) => void | (() => void);
  readonly captureMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly captureClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly captureKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly keyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly capturePrimaryKeyDown: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly primaryKeyDown: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly captureDismissKeyDown: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly dismissKeyDown: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly preserveActionFocus: (
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
  readonly activatePrimary: (
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => HintPublication | null;
  readonly activateDismiss: (
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => HintPublication | null;
}

class HintElementOwner<T extends Element> implements HintElementOwnerView {
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    readonly role: HintElementRole,
    private readonly onChange: (
      owner: HintElementOwnerView,
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
    if (!element) return;
    return () => {
      if (this.current === element) this.capture(null);
      else this.onChange(this, null, element, this.last);
    };
  };
}

function hintRecordSnapshot(record: HintsRecord): HintRecordSnapshot {
  return Object.freeze({
    dismissed: Object.freeze([...record.dismissed]),
    agentSeen: record.agentSeen,
  });
}

function hintRecordMatches(
  left: HintRecordSnapshot,
  right: HintRecordSnapshot,
) {
  return (
    left.agentSeen === right.agentSeen &&
    left.dismissed.length === right.dismissed.length &&
    left.dismissed.every((id, index) => id === right.dismissed[index])
  );
}

function hintAttributes(
  node: Node,
): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotHintDom(node: Node): HintDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: hintAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotHintDom)),
  });
}

function hintDomMatches(snapshot: HintDomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = hintAttributes(node);
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
    snapshot.children.every(
      (child, index) =>
        node.childNodes.item(index) === child.node && hintDomMatches(child),
    )
  );
}

function hintDomContains(snapshot: HintDomSnapshot, node: Node): boolean {
  return (
    snapshot.node === node ||
    snapshot.children.some((child) => hintDomContains(child, node))
  );
}

function snapshotHintPlacement(root: HTMLDivElement): HintPlacement | null {
  const placements: HintNodePlacement[] = [];
  const ownerDocument = root.ownerDocument;
  let current: Node | null = root;
  while (current) {
    placements.push(
      Object.freeze({
        node: current,
        parent: current.parentNode,
        previousSibling: current.previousSibling,
        nextSibling: current.nextSibling,
      }),
    );
    if (current === ownerDocument) return Object.freeze(placements);
    current = current.parentNode;
  }
  return null;
}

function hintPlacementMatches(
  ownerDocument: Document,
  placement: HintPlacement,
) {
  if (placement.length === 0) return false;
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
  return (
    last.node === ownerDocument &&
    last.parent === null &&
    last.previousSibling === null &&
    last.nextSibling === null
  );
}

function hintMutationTouchesPlacement(
  placement: HintPlacement,
  mutation: MutationRecord,
) {
  if (mutation.type !== "childList") return false;
  return placement.some(
    ({ node, parent }) =>
      mutation.target === parent &&
      (mutation.previousSibling === node ||
        mutation.nextSibling === node ||
        [...mutation.addedNodes, ...mutation.removedNodes].some(
          (changed) =>
            changed === node ||
            (changed.nodeType === 1 && (changed as Element).contains(node)),
        )),
  );
}

function createHintDomGuard(
  root: HTMLDivElement,
  placement: HintPlacement,
): HintDomGuard | null {
  const MutationObserverConstructor =
    root.ownerDocument.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  const record = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some(
      (mutation) =>
        mutation.target === root ||
        root.contains(mutation.target) ||
        hintMutationTouchesPlacement(placement, mutation),
    );
  };
  const observer = new MutationObserverConstructor(record);
  observer.observe(root, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  const observedParents = new Set<Node>();
  for (const { parent } of placement) {
    if (parent && !observedParents.has(parent)) {
      observedParents.add(parent);
      observer.observe(parent, { childList: true });
    }
  }
  return Object.freeze({
    isClean: () => {
      record(observer.takeRecords());
      return !changed;
    },
    release: () => {
      record(observer.takeRecords());
      observer.disconnect();
    },
  });
}

function hintNodes(element: HTMLElement): readonly Node[] {
  const nodes: Node[] = [];
  const visit = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(element);
  return Object.freeze(nodes);
}

function hintEventPath(
  ownerDocument: Document,
  target: Node,
): readonly EventTarget[] | null {
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) return null;
  const path: EventTarget[] = [];
  let current: Node | null = target;
  while (current) {
    path.push(current);
    current = current.parentNode;
  }
  if (path.at(-1) !== ownerDocument) return null;
  path.push(ownerWindow);
  return Object.freeze(path);
}

function hintEventPathMatches(
  ownerDocument: Document,
  target: Node,
  actual: readonly EventTarget[],
) {
  const expected = hintEventPath(ownerDocument, target);
  const actualView = actual.at(-1);
  const expectedView = expected?.at(-1);
  const hasOwnerDocumentView =
    actualView === expectedView ||
    (typeof actualView === "object" &&
      actualView !== null &&
      "document" in actualView &&
      actualView.document === ownerDocument &&
      "window" in actualView &&
      actualView.window === actualView);
  return Boolean(
    expected &&
      actual.length === expected.length &&
      hasOwnerDocumentView &&
    actual.slice(0, -1).every((entry, index) => entry === expected[index]),
  );
}

function hintEventPathsEqual(
  left: readonly EventTarget[],
  right: readonly EventTarget[],
) {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function hintRenderMatches(previous: HintRender, current: HintRender) {
  return (
    previous.mount === current.mount &&
    previous.visit === current.visit &&
    previous.key === current.key &&
    previous.session === current.session &&
    previous.documentId === current.documentId &&
    previous.role === current.role &&
    previous.canEdit === current.canEdit &&
    previous.id === current.id &&
    previous.message === current.message &&
    previous.actionLabel === current.actionLabel &&
    hintRecordMatches(previous.record, current.record) &&
    hintRecordMatches(previous.dismissedRecord, current.dismissedRecord) &&
    previous.pin === current.pin &&
    previous.actions === current.actions &&
    previous.focus === current.focus &&
    previous.onShare === current.onShare &&
    previous.onComment === current.onComment &&
    previous.primaryCallback === current.primaryCallback &&
    previous.storage === current.storage &&
    previous.discovery === current.discovery
  );
}

function hintFactsAreCurrent(render: HintRender) {
  const copy = HINTS[render.id];
  const expectedDismissed = withDismissed(
    {
      dismissed: [...render.record.dismissed],
      agentSeen: render.record.agentSeen,
    },
    render.id,
  );
  return (
    Object.isFrozen(render) &&
    Object.isFrozen(render.visit) &&
    Object.isFrozen(render.record) &&
    Object.isFrozen(render.record.dismissed) &&
    Object.isFrozen(render.dismissedRecord) &&
    Object.isFrozen(render.dismissedRecord.dismissed) &&
    render.visit.mount === render.mount &&
    render.visit.session === render.session &&
    render.visit.documentId === render.documentId &&
    render.visit.role === render.role &&
    render.visit.canEdit === render.canEdit &&
    render.key.session === render.session &&
    render.key.documentId === render.documentId &&
    render.session.docId === render.documentId &&
    render.session.role === render.role &&
    render.session.canEdit === render.canEdit &&
    render.pin.key === render.key &&
    render.pin.id === render.id &&
    copy.message === render.message &&
    copy.action === render.actionLabel &&
    render.actions.focus === render.focus &&
    render.primaryCallback ===
      (render.id === "collab-agent" ? render.onShare : render.onComment) &&
    hintRecordMatches(render.dismissedRecord, expectedDismissed) &&
    (!render.discovery ||
      (!render.discovery.retired && render.discovery.key === render.key))
  );
}

function hintElementsAreCurrent(
  render: HintRender,
  owners: Readonly<Record<HintElementRole, HintElementOwnerView>>,
) {
  const root = owners.root.element();
  const icon = owners.icon.element();
  const text = owners.text.element();
  const action = owners.action.element();
  const dismiss = owners.dismiss.element();
  const dismissIcon = owners.dismissIcon.element();
  const ownerWindow = root?.ownerDocument.defaultView;
  if (
    !ownerWindow ||
    !(root instanceof ownerWindow.HTMLDivElement) ||
    !(icon instanceof ownerWindow.SVGSVGElement) ||
    !(text instanceof ownerWindow.HTMLSpanElement) ||
    !(action instanceof ownerWindow.HTMLButtonElement) ||
    !(dismiss instanceof ownerWindow.HTMLButtonElement) ||
    !(dismissIcon instanceof ownerWindow.SVGSVGElement) ||
    new Set([root, icon, text, action, dismiss, dismissIcon]).size !== 6 ||
    !root.isConnected ||
    !icon.isConnected ||
    !text.isConnected ||
    !action.isConnected ||
    !dismiss.isConnected ||
    !dismissIcon.isConnected ||
    [icon, text, action, dismiss, dismissIcon].some(
      (element) => element.ownerDocument !== root.ownerDocument,
    ) ||
    root.tagName !== "DIV" ||
    root.className !== HINT_ROOT_CLASS ||
    root.getAttribute("role") !== "status" ||
    root.getAttribute("aria-live") !== "polite" ||
    root.dataset.testid !== "hint-bar" ||
    root.dataset.hint !== render.id ||
    root.childNodes.length !== 4 ||
    root.children.length !== 4 ||
    root.children.item(0) !== icon ||
    root.children.item(1) !== text ||
    root.children.item(2) !== action ||
    root.children.item(3) !== dismiss ||
    icon.parentElement !== root ||
    icon.className.baseVal !==
      `lucide lucide-${render.id === "collab-agent" ? "bot" : "message-square"} ${HINT_ICON_CLASS}` ||
    icon.getAttribute("width") !== "14" ||
    icon.getAttribute("height") !== "14" ||
    icon.getAttribute("aria-hidden") !== "true" ||
    text.parentElement !== root ||
    text.className !== HINT_TEXT_CLASS ||
    text.children.length !== 0 ||
    text.textContent !== render.message ||
    text.getAttribute("title") !== render.message ||
    action.parentElement !== root ||
    action.tagName !== "BUTTON" ||
    action.getAttribute("type") !== "button" ||
    action.type !== "button" ||
    action.disabled ||
    action.matches(":disabled") ||
    action.className !== HINT_ACTION_CLASS ||
    action.dataset.testid !== "hint-action" ||
    action.children.length !== 0 ||
    action.textContent?.trim() !== render.actionLabel ||
    dismiss.parentElement !== root ||
    dismiss.tagName !== "BUTTON" ||
    dismiss.getAttribute("type") !== "button" ||
    dismiss.type !== "button" ||
    dismiss.disabled ||
    dismiss.matches(":disabled") ||
    dismiss.className !== HINT_DISMISS_CLASS ||
    dismiss.getAttribute("aria-label") !== "Dismiss hint" ||
    dismiss.dataset.testid !== "hint-dismiss" ||
    dismiss.childNodes.length !== 1 ||
    dismiss.children.length !== 1 ||
    dismiss.firstElementChild !== dismissIcon ||
    dismissIcon.parentElement !== dismiss ||
    !dismissIcon.classList.contains("lucide-x") ||
    dismissIcon.getAttribute("width") !== "14" ||
    dismissIcon.getAttribute("height") !== "14" ||
    dismissIcon.getAttribute("aria-hidden") !== "true"
  ) {
    return false;
  }
  const controls = [...root.querySelectorAll<HTMLButtonElement>("button")];
  return (
    controls.length === 2 && controls[0] === action && controls[1] === dismiss
  );
}

function hintDescriptorMatches(
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

function captureHintGetter<Value>(
  ownerWindow: Window & typeof globalThis,
  prototype: object,
  property: string,
): HintCapturedGetter<Value> | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  let owner: object | null = prototype;
  while (owner) {
    const holder = owner;
    const descriptor = getOwnPropertyDescriptor(holder, property);
    if (descriptor) {
      if (typeof descriptor.get !== "function") return null;
      const expected = Object.freeze({ ...descriptor });
      const getter = descriptor.get;
      return Object.freeze({
        read: (target: object) => apply(getter, target, []) as Value,
        isCurrent: () =>
          ownerWindow.Object.getOwnPropertyDescriptor ===
            getOwnPropertyDescriptor &&
          ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
          ownerWindow.Reflect.apply === apply &&
          hintDescriptorMatches(
            getOwnPropertyDescriptor(holder, property),
            expected,
          ),
      });
    }
    owner = getPrototypeOf(holder) as object | null;
  }
  return null;
}

function captureHintValue<Value>(
  ownerWindow: Window & typeof globalThis,
  target: object,
  property: string,
): HintCapturedValue<Value> | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const emptyOwners: object[] = [];
  let owner: object | null = target;
  while (owner) {
    const descriptor = getOwnPropertyDescriptor(owner, property);
    if (descriptor) {
      if (!("value" in descriptor) && typeof descriptor.get !== "function") {
        return null;
      }
      const holder = owner;
      const expected = Object.freeze({ ...descriptor });
      const read =
        "value" in descriptor
          ? () => descriptor.value as Value
          : () => apply(descriptor.get!, target, []) as Value;
      return Object.freeze({
        read,
        isCurrent: () =>
          ownerWindow.Object.getOwnPropertyDescriptor ===
            getOwnPropertyDescriptor &&
          ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
          ownerWindow.Reflect.apply === apply &&
          emptyOwners.every(
            (candidate) =>
              getOwnPropertyDescriptor(candidate, property) === undefined,
          ) &&
          hintDescriptorMatches(
            getOwnPropertyDescriptor(holder, property),
            expected,
          ),
      });
    }
    emptyOwners.push(owner);
    owner = getPrototypeOf(owner) as object | null;
  }
  return null;
}

function captureHintTargetMethod<Args extends readonly unknown[], Result>(
  ownerWindow: Window & typeof globalThis,
  target: object,
  property: string,
): HintCapturedMethod<Args, Result> | null {
  const captured = captureHintValue<(...args: Args) => Result>(
    ownerWindow,
    target,
    property,
  );
  const apply = ownerWindow.Reflect.apply;
  try {
    const method = captured?.read();
    if (!captured || typeof method !== "function") return null;
    return Object.freeze({
      invoke: (receiver: object, ...args: Args) =>
        apply(method, receiver, args) as Result,
      isCurrent: () => {
        try {
          return (
            ownerWindow.Reflect.apply === apply &&
            captured.isCurrent() &&
            captured.read() === method
          );
        } catch {
          return false;
        }
      },
    });
  } catch {
    return null;
  }
}

function captureHintMethod<Args extends readonly unknown[], Result>(
  ownerWindow: Window & typeof globalThis,
  prototype: object,
  property: string,
): HintCapturedMethod<Args, Result> | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  let owner: object | null = prototype;
  while (owner) {
    const holder = owner;
    const descriptor = getOwnPropertyDescriptor(holder, property);
    if (descriptor) {
      if (typeof descriptor.value !== "function") return null;
      const expected = Object.freeze({ ...descriptor });
      const method = descriptor.value as (...args: Args) => Result;
      return Object.freeze({
        invoke: (target: object, ...args: Args) =>
          apply(method, target, args) as Result,
        isCurrent: () =>
          ownerWindow.Object.getOwnPropertyDescriptor ===
            getOwnPropertyDescriptor &&
          ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
          ownerWindow.Reflect.apply === apply &&
          hintDescriptorMatches(
            getOwnPropertyDescriptor(holder, property),
            expected,
          ),
      });
    }
    owner = getPrototypeOf(holder) as object | null;
  }
  return null;
}

function captureHintTrustedGetter(
  ownerWindow: Window & typeof globalThis,
): HintTrustedGetter | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const apply = ownerWindow.Reflect.apply;
  let probe: globalThis.KeyboardEvent;
  try {
    probe = new ownerWindow.KeyboardEvent("hint-navigation-trust-probe");
  } catch {
    return null;
  }
  const descriptor = getOwnPropertyDescriptor(probe, "isTrusted");
  if (
    !descriptor ||
    descriptor.configurable !== false ||
    typeof descriptor.get !== "function"
  ) {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  const getter = descriptor.get;
  const matches = (event: object) =>
    hintDescriptorMatches(
      getOwnPropertyDescriptor(event, "isTrusted"),
      expected,
    );
  return Object.freeze({
    read: (event: object) => apply(getter, event, []) as boolean,
    matches,
    isCurrent: () =>
      ownerWindow.Object.getOwnPropertyDescriptor ===
        getOwnPropertyDescriptor &&
      ownerWindow.Reflect.apply === apply &&
      matches(probe),
  });
}

function captureHintKeyboardAuthority(
  ownerDocument: Document,
  ownerWindow: Window & typeof globalThis,
): HintKeyboardAuthority | null {
  const EventConstructor = ownerWindow.Event;
  const UIEventConstructor = ownerWindow.UIEvent;
  const KeyboardEventConstructor = ownerWindow.KeyboardEvent;
  const NodeConstructor = ownerWindow.Node;
  const DocumentConstructor = ownerWindow.Document;
  const HTMLElementConstructor = ownerWindow.HTMLElement;
  const apply = ownerWindow.Reflect.apply;
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const eventPrototype = EventConstructor.prototype;
  const uiEventPrototype = UIEventConstructor.prototype;
  const keyboardPrototype = KeyboardEventConstructor.prototype;
  const documentPrototype = DocumentConstructor.prototype;
  const htmlElementPrototype = HTMLElementConstructor.prototype;
  const eventType = captureHintGetter<string>(
    ownerWindow,
    eventPrototype,
    "type",
  );
  const eventTarget = captureHintGetter<EventTarget | null>(
    ownerWindow,
    eventPrototype,
    "target",
  );
  const eventCurrentTarget = captureHintGetter<EventTarget | null>(
    ownerWindow,
    eventPrototype,
    "currentTarget",
  );
  const eventPhase = captureHintGetter<number>(
    ownerWindow,
    eventPrototype,
    "eventPhase",
  );
  const eventBubbles = captureHintGetter<boolean>(
    ownerWindow,
    eventPrototype,
    "bubbles",
  );
  const eventCancelable = captureHintGetter<boolean>(
    ownerWindow,
    eventPrototype,
    "cancelable",
  );
  const eventDefaultPrevented = captureHintGetter<boolean>(
    ownerWindow,
    eventPrototype,
    "defaultPrevented",
  );
  const eventCancelBubble = captureHintGetter<boolean>(
    ownerWindow,
    eventPrototype,
    "cancelBubble",
  );
  const eventPath = captureHintMethod<readonly [], EventTarget[]>(
    ownerWindow,
    eventPrototype,
    "composedPath",
  );
  const eventPreventDefault = captureHintMethod<readonly [], void>(
    ownerWindow,
    eventPrototype,
    "preventDefault",
  );
  const eventView = captureHintGetter<Window | null>(
    ownerWindow,
    uiEventPrototype,
    "view",
  );
  const key = captureHintGetter<string>(ownerWindow, keyboardPrototype, "key");
  const code = captureHintGetter<string>(
    ownerWindow,
    keyboardPrototype,
    "code",
  );
  const location = captureHintGetter<number>(
    ownerWindow,
    keyboardPrototype,
    "location",
  );
  const repeat = captureHintGetter<boolean>(
    ownerWindow,
    keyboardPrototype,
    "repeat",
  );
  const composing = captureHintGetter<boolean>(
    ownerWindow,
    keyboardPrototype,
    "isComposing",
  );
  const altKey = captureHintGetter<boolean>(
    ownerWindow,
    keyboardPrototype,
    "altKey",
  );
  const ctrlKey = captureHintGetter<boolean>(
    ownerWindow,
    keyboardPrototype,
    "ctrlKey",
  );
  const metaKey = captureHintGetter<boolean>(
    ownerWindow,
    keyboardPrototype,
    "metaKey",
  );
  const shiftKey = captureHintGetter<boolean>(
    ownerWindow,
    keyboardPrototype,
    "shiftKey",
  );
  const activeElement = captureHintGetter<Element | null>(
    ownerWindow,
    documentPrototype,
    "activeElement",
  );
  const documentView = captureHintValue<Window | null>(
    ownerWindow,
    ownerDocument,
    "defaultView",
  );
  const focus = captureHintMethod<readonly [FocusOptions?], void>(
    ownerWindow,
    htmlElementPrototype,
    "focus",
  );
  const windowListen = captureHintTargetMethod<
    readonly [string, EventListener, boolean],
    void
  >(ownerWindow, ownerWindow, "addEventListener");
  const windowUnlisten = captureHintTargetMethod<
    readonly [string, EventListener, boolean],
    void
  >(ownerWindow, ownerWindow, "removeEventListener");
  const trusted = captureHintTrustedGetter(ownerWindow);
  if (
    !eventType ||
    !eventTarget ||
    !eventCurrentTarget ||
    !eventPhase ||
    !eventBubbles ||
    !eventCancelable ||
    !eventDefaultPrevented ||
    !eventCancelBubble ||
    !eventPath ||
    !eventPreventDefault ||
    !eventView ||
    !key ||
    !code ||
    !location ||
    !repeat ||
    !composing ||
    !altKey ||
    !ctrlKey ||
    !metaKey ||
    !shiftKey ||
    !activeElement ||
    !documentView ||
    !focus ||
    !windowListen ||
    !windowUnlisten ||
    !trusted ||
    documentView.read() !== ownerWindow
  ) {
    return null;
  }
  const captured: readonly HintCapturedIntrinsic[] = Object.freeze([
    eventType,
    eventTarget,
    eventCurrentTarget,
    eventPhase,
    eventBubbles,
    eventCancelable,
    eventDefaultPrevented,
    eventCancelBubble,
    eventPath,
    eventPreventDefault,
    eventView,
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
    documentView,
    focus,
    windowListen,
    windowUnlisten,
    trusted,
  ]);
  let historyIsClean = true;
  const isCurrent = () => {
    if (!historyIsClean) return false;
    historyIsClean =
      ownerWindow.Event === EventConstructor &&
      ownerWindow.UIEvent === UIEventConstructor &&
      ownerWindow.KeyboardEvent === KeyboardEventConstructor &&
      ownerWindow.Node === NodeConstructor &&
      ownerWindow.Document === DocumentConstructor &&
      ownerWindow.HTMLElement === HTMLElementConstructor &&
      EventConstructor.prototype === eventPrototype &&
      UIEventConstructor.prototype === uiEventPrototype &&
      KeyboardEventConstructor.prototype === keyboardPrototype &&
      DocumentConstructor.prototype === documentPrototype &&
      HTMLElementConstructor.prototype === htmlElementPrototype &&
      captured.every((intrinsic) => intrinsic.isCurrent()) &&
      documentView.read() === ownerWindow;
    return historyIsClean;
  };
  const reactMethodMatches = (
    event: object,
    property: PropertyKey,
    value: unknown,
  ) => {
    if (!isCurrent() || typeof value !== "function") return false;
    try {
      let owner: object | null = event;
      for (let depth = 0; owner && depth < 16; depth++) {
        const descriptor = getOwnPropertyDescriptor(owner, property);
        if (descriptor) {
          return "value" in descriptor && descriptor.value === value;
        }
        owner = getPrototypeOf(owner) as object | null;
      }
    } catch {
      historyIsClean = false;
    }
    return false;
  };
  if (!isCurrent()) return null;
  return Object.freeze({
    ownerWindow,
    Event: EventConstructor,
    KeyboardEvent: KeyboardEventConstructor,
    Node: NodeConstructor,
    apply,
    eventType,
    eventTarget,
    eventCurrentTarget,
    eventPhase,
    eventBubbles,
    eventCancelable,
    eventDefaultPrevented,
    eventCancelBubble,
    eventPath,
    eventPreventDefault,
    eventView,
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
    documentView,
    focus,
    windowListen,
    windowUnlisten,
    trusted,
    reactMethodMatches,
    isCurrent,
  });
}

function isHintNavigationKey(key: string): key is HintNavigationKey {
  return (
    key === "ArrowLeft" ||
    key === "ArrowUp" ||
    key === "ArrowRight" ||
    key === "ArrowDown" ||
    key === "Home" ||
    key === "End"
  );
}

function hintControlIsEnabled(control: HintControl) {
  const { element } = control;
  if (
    !element.isConnected ||
    element.disabled ||
    element.matches(":disabled") ||
    element.getAttribute("aria-disabled")?.toLowerCase() === "true"
  ) {
    return false;
  }
  for (
    let node: HTMLElement | null = element;
    node;
    node = node.parentElement
  ) {
    if (
      node.hasAttribute("inert") ||
      node.getAttribute("aria-disabled")?.toLowerCase() === "true"
    ) {
      return false;
    }
  }
  return true;
}

function hintNavigationDestination(
  publication: HintPublication,
  source: HintControl,
  key: HintNavigationKey,
) {
  const controls = [
    publication.controls.primary,
    publication.controls.dismiss,
  ].filter(hintControlIsEnabled);
  const sourceIndex = controls.indexOf(source);
  if (sourceIndex < 0) return null;
  const destinationIndex =
    key === "ArrowRight" || key === "ArrowDown"
      ? sourceIndex + 1
      : key === "ArrowLeft" || key === "ArrowUp"
        ? sourceIndex - 1
        : key === "Home"
          ? 0
          : controls.length - 1;
  const destination = controls[destinationIndex] ?? null;
  return destination && destination !== source ? destination : null;
}

function hintNativeKeySnapshotMatches(
  keyboard: HintKeyboardAuthority,
  delivery: HintNativeKeyDelivery,
) {
  const { snapshot } = delivery;
  const { event } = snapshot;
  if (!keyboard.isCurrent()) return false;
  try {
    const path = keyboard.eventPath.invoke(event);
    const view = keyboard.eventView.read(event);
    return (
      keyboard.ownerWindow.Object.getPrototypeOf(event) ===
        keyboard.KeyboardEvent.prototype &&
      keyboard.trusted.matches(event) &&
      keyboard.trusted.read(event) &&
      keyboard.eventType.read(event) === "keydown" &&
      keyboard.key.read(event) === snapshot.key &&
      keyboard.code.read(event) === snapshot.code &&
      keyboard.location.read(event) === snapshot.location &&
      keyboard.eventTarget.read(event) === snapshot.target &&
      keyboard.eventBubbles.read(event) === snapshot.bubbles &&
      keyboard.eventCancelable.read(event) === snapshot.cancelable &&
      Object.is(view, snapshot.view) &&
      (view === null ||
        view === snapshot.publication.ownerDocument.defaultView ||
        view === snapshot.receiver) &&
      !keyboard.eventDefaultPrevented.read(event) &&
      !keyboard.eventCancelBubble.read(event) &&
      !keyboard.repeat.read(event) &&
      !keyboard.composing.read(event) &&
      !keyboard.altKey.read(event) &&
      !keyboard.ctrlKey.read(event) &&
      !keyboard.metaKey.read(event) &&
      !keyboard.shiftKey.read(event) &&
      snapshot.path[snapshot.path.length - 2] ===
        snapshot.publication.ownerDocument &&
      snapshot.path[snapshot.path.length - 1] === snapshot.receiver &&
      path.length === snapshot.path.length &&
      path.every((entry, index) => entry === snapshot.path[index])
    );
  } catch {
    return false;
  }
}

function hintWrapperNativeEvent(
  event: ReactKeyboardEvent<HTMLElement>,
): object | null {
  try {
    const nativeEvent: unknown = event.nativeEvent;
    return nativeEvent && typeof nativeEvent === "object" ? nativeEvent : null;
  } catch {
    return null;
  }
}

function hintReactKeyMethods(
  event: ReactKeyboardEvent<HTMLElement>,
  keyboard: HintKeyboardAuthority,
  expected?: HintReactKeyMethods,
): HintReactKeyMethods | null {
  try {
    const methods = Object.freeze({
      preventDefault: event.preventDefault as (...args: never[]) => unknown,
      isDefaultPrevented: event.isDefaultPrevented as (
        ...args: never[]
      ) => unknown,
      isPropagationStopped: event.isPropagationStopped as (
        ...args: never[]
      ) => unknown,
    });
    if (
      !keyboard.reactMethodMatches(
        event,
        "preventDefault",
        methods.preventDefault,
      ) ||
      !keyboard.reactMethodMatches(
        event,
        "isDefaultPrevented",
        methods.isDefaultPrevented,
      ) ||
      !keyboard.reactMethodMatches(
        event,
        "isPropagationStopped",
        methods.isPropagationStopped,
      ) ||
      keyboard.apply(methods.isDefaultPrevented, event, []) !== false ||
      keyboard.apply(methods.isPropagationStopped, event, []) !== false ||
      (expected !== undefined &&
        (methods.preventDefault !== expected.preventDefault ||
          methods.isDefaultPrevented !== expected.isDefaultPrevented ||
          methods.isPropagationStopped !== expected.isPropagationStopped))
    ) {
      return null;
    }
    return methods;
  } catch {
    return null;
  }
}

function exactHintReactKey<Element extends HTMLElement>(
  event: ReactKeyboardEvent<Element>,
  publication: HintPublication,
  source: HTMLButtonElement,
  reactCurrentTarget: Element,
  phase: HintKeyPhase,
  windowReceiver: EventTarget,
  expectedMethods?: HintReactKeyMethods,
): HintReactKeyFacts | null {
  const keyboard = publication.keyboard;
  if (
    !event ||
    typeof event !== "object" ||
    !keyboard ||
    !keyboard.isCurrent()
  ) {
    return null;
  }
  const nativeEvent = event.nativeEvent;
  if (
    !nativeEvent ||
    typeof nativeEvent !== "object" ||
    !(nativeEvent instanceof keyboard.KeyboardEvent) ||
    keyboard.ownerWindow.Object.getPrototypeOf(nativeEvent) !==
      keyboard.KeyboardEvent.prototype ||
    !keyboard.trusted.matches(nativeEvent)
  ) {
    return null;
  }
  try {
    const key = keyboard.key.read(nativeEvent);
    if (!isHintNavigationKey(key)) return null;
    const code = keyboard.code.read(nativeEvent);
    const location = keyboard.location.read(nativeEvent);
    const target = keyboard.eventTarget.read(nativeEvent);
    const currentTarget = keyboard.eventCurrentTarget.read(nativeEvent);
    const path = keyboard.eventPath.invoke(nativeEvent);
    const nativePhase = keyboard.eventPhase.read(nativeEvent);
    const bubbles = keyboard.eventBubbles.read(nativeEvent);
    const cancelable = keyboard.eventCancelable.read(nativeEvent);
    const defaultPrevented = keyboard.eventDefaultPrevented.read(nativeEvent);
    const cancelBubble = keyboard.eventCancelBubble.read(nativeEvent);
    const trusted = keyboard.trusted.read(nativeEvent);
    const repeat = keyboard.repeat.read(nativeEvent);
    const composing = keyboard.composing.read(nativeEvent);
    const altKey = keyboard.altKey.read(nativeEvent);
    const ctrlKey = keyboard.ctrlKey.read(nativeEvent);
    const metaKey = keyboard.metaKey.read(nativeEvent);
    const shiftKey = keyboard.shiftKey.read(nativeEvent);
    const nativeView = keyboard.eventView.read(nativeEvent);
    const methods = hintReactKeyMethods(
      event as ReactKeyboardEvent<HTMLElement>,
      keyboard,
      expectedMethods,
    );
    return keyboard.eventType.read(nativeEvent) === "keydown" &&
      nativePhase ===
        (phase === "capture"
          ? keyboard.Event.CAPTURING_PHASE
          : keyboard.Event.BUBBLING_PHASE) &&
      bubbles &&
      cancelable &&
      !defaultPrevented &&
      !cancelBubble &&
      trusted &&
      !repeat &&
      !composing &&
      !altKey &&
      !ctrlKey &&
      !metaKey &&
      !shiftKey &&
      (nativeView === null ||
        nativeView === publication.ownerDocument.defaultView ||
        nativeView === windowReceiver) &&
      target === source &&
      target instanceof keyboard.Node &&
      target.ownerDocument === publication.ownerDocument &&
      currentTarget instanceof keyboard.Node &&
      (currentTarget === publication.ownerDocument ||
        currentTarget.ownerDocument === publication.ownerDocument) &&
      currentTarget.contains(publication.root) &&
      path[0] === source &&
      path.filter((entry) => entry === source).length === 1 &&
      path.includes(currentTarget) &&
      path.includes(publication.root) &&
      path[path.length - 1] === windowReceiver &&
      keyboard.activeElement.read(publication.ownerDocument) === source &&
      event.type === "keydown" &&
      event.currentTarget === reactCurrentTarget &&
      event.target === target &&
      event.nativeEvent === nativeEvent &&
      event.key === key &&
      event.code === code &&
      event.location === location &&
      event.repeat === repeat &&
      event.altKey === altKey &&
      event.ctrlKey === ctrlKey &&
      event.metaKey === metaKey &&
      event.shiftKey === shiftKey &&
      event.bubbles === bubbles &&
      event.cancelable === cancelable &&
      event.defaultPrevented === defaultPrevented &&
      event.eventPhase === nativePhase &&
      event.isTrusted === trusted &&
      Object.is(event.view, nativeView) &&
      methods
      ? Object.freeze({
          nativeEvent,
          key,
          delegationTarget: currentTarget,
          methods,
        })
      : null;
  } catch {
    return null;
  }
}

function createHintPublication(
  render: HintRender,
  cells: HintPublicationCells,
  requestSuccessor: () => void,
): HintPublicationSet {
  let currentRuntime: HintPublicationRuntime | null = null;
  let lastRuntime: HintPublicationRuntime | null = null;
  let successorRequested = false;

  const onElementChange = (
    owner: HintElementOwnerView,
    element: Element | null,
    previous: Element | null,
    last: Element | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (
      element === null ||
      (element !== null && last !== null && element !== last)
    ) {
      currentRuntime?.retireForElement();
      currentRuntime = null;
    }
    if (
      !successorRequested &&
      runtime?.isExactReplay() &&
      cells.successorOf.current === runtime.publication
    ) {
      const replay = runtime.replay();
      if (
        replay &&
        hintFactsAreCurrent(render) &&
        hintElementsAreCurrent(render, owners) &&
        runtime.publication.publishedDomMatches()
      ) {
        cells.replay.current = replay;
        successorRequested = true;
        requestSuccessor();
      }
    }
  };
  const root = new HintElementOwner<HTMLDivElement>("root", onElementChange);
  const icon = new HintElementOwner<SVGSVGElement>("icon", onElementChange);
  const text = new HintElementOwner<HTMLSpanElement>("text", onElementChange);
  const action = new HintElementOwner<HTMLButtonElement>(
    "action",
    onElementChange,
  );
  const dismiss = new HintElementOwner<HTMLButtonElement>(
    "dismiss",
    onElementChange,
  );
  const dismissIcon = new HintElementOwner<SVGSVGElement>(
    "dismissIcon",
    onElementChange,
  );
  const owners: Readonly<Record<HintElementRole, HintElementOwnerView>> =
    Object.freeze({ root, icon, text, action, dismiss, dismissIcon });
  const expectedOwners = () =>
    Object.freeze([root, icon, text, action, dismiss, dismissIcon]);

  const createRuntime = (): HintPublicationRuntime | null => {
    type Retirement = "element" | "layout" | "other";
    const rootElement = root.element();
    const actionElement = action.element();
    const dismissElement = dismiss.element();
    if (
      !(rootElement instanceof HTMLDivElement) ||
      !(actionElement instanceof HTMLButtonElement) ||
      !(dismissElement instanceof HTMLButtonElement)
    ) {
      return null;
    }
    const ownerDocument = rootElement.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const placement = snapshotHintPlacement(rootElement);
    if (!ownerWindow || !placement) return null;
    const navigationKeyboard = captureHintKeyboardAuthority(
      ownerDocument,
      ownerWindow,
    );
    const dom = snapshotHintDom(rootElement);
    const primaryAction: HintAction = Object.freeze({
      identity: Symbol("hint-primary-action"),
      kind: "primary",
      render,
      callback: render.primaryCallback,
    });
    const dismissAction: HintAction = Object.freeze({
      identity: Symbol("hint-dismiss-action"),
      kind: "dismiss",
      render,
      callback: null,
    });
    const preserveFocus: HintAction = Object.freeze({
      identity: Symbol("hint-preserve-focus"),
      kind: "preserve-focus",
      render,
      callback: null,
    });
    const controls: Readonly<Record<HintControlKind, HintControl>> =
      Object.freeze({
        primary: Object.freeze({
          identity: Symbol("hint-primary-control"),
          kind: "primary",
          render,
          element: actionElement,
          action: primaryAction,
          targets: hintNodes(actionElement),
        }),
        dismiss: Object.freeze({
          identity: Symbol("hint-dismiss-control"),
          kind: "dismiss",
          render,
          element: dismissElement,
          action: dismissAction,
          targets: hintNodes(dismissElement),
        }),
      });
    let retired = false;
    let retirement: Retirement | null = null;
    let layoutRetired = false;
    let established = false;
    let refs: HintRefReplay[] = [];
    let guard: HintDomGuard | null = null;
    let nativeMouseDown: HintNativeMouseProof | null = null;
    let nativeMouseUp: HintNativeMouseProof | null = null;
    let keyboardDown: HintKeyboardProof | null = null;
    let keyboardUp: HintKeyboardReleaseProof | null = null;
    let nativeClick: HintNativeClickProof | null = null;
    let reactMouseDown: HintReactProof | null = null;
    let reactClick: HintReactProof | null = null;
    let interactionExpiry: number | null = null;
    let navigationListening = false;
    const nativeKeyDeliveries = new WeakMap<object, HintNativeKeyDelivery>();
    const seenNativeKeys = new WeakSet<object>();
    const releasePrimaryPress = () => {
      cells.pressedPublications.delete(publication);
      cells.pressedControls.delete(controls.primary);
      cells.pressedActions.delete(preserveFocus);
    };
    const cancelInteractionExpiry = () => {
      if (interactionExpiry === null) return;
      ownerWindow.clearTimeout(interactionExpiry);
      interactionExpiry = null;
    };
    const clearInteractionProofs = () => {
      cancelInteractionExpiry();
      nativeMouseDown = null;
      nativeMouseUp = null;
      keyboardDown = null;
      keyboardUp = null;
      nativeClick = null;
      reactMouseDown = null;
      reactClick = null;
    };
    const expirePointerProof = (
      down: HintNativeMouseProof,
      up: HintNativeMouseProof,
    ) => {
      cancelInteractionExpiry();
      interactionExpiry = ownerWindow.setTimeout(() => {
        interactionExpiry = null;
        if (nativeMouseDown !== down || nativeMouseUp !== up) return;
        releasePrimaryPress();
        clearInteractionProofs();
      }, 0);
    };
    const expireKeyboardProof = (
      down: HintKeyboardProof,
      up: HintKeyboardReleaseProof | null,
    ) => {
      cancelInteractionExpiry();
      interactionExpiry = ownerWindow.setTimeout(() => {
        interactionExpiry = null;
        if (keyboardDown !== down || keyboardUp !== up) return;
        releasePrimaryPress();
        clearInteractionProofs();
      }, 0);
    };

    const controlForTarget = (target: Node) =>
      (Object.values(controls) as HintControl[]).find((control) =>
        control.targets.includes(target),
      ) ?? null;
    const publicationOwnsCurrentDom = () =>
      !retired &&
      cells.active.current === publication &&
      render.storage === rootElement.ownerDocument.defaultView?.localStorage &&
      hintFactsAreCurrent(render) &&
      hintElementsAreCurrent(render, owners) &&
      publication.publishedDomMatches();
    const eventPath = (event: Event, target: Node) => {
      if (event.composedPath !== ownerWindow.Event.prototype.composedPath) {
        return null;
      }
      const path = event.composedPath();
      return hintEventPathMatches(ownerDocument, target, path)
        ? Object.freeze([...path])
        : null;
    };
    const exactNativeMouse = (
      event: MouseEvent,
      type: "mousedown" | "mouseup" | "click",
    ) => {
      const target = event.target;
      if (
        !(event instanceof ownerWindow.MouseEvent) ||
        event.type !== type ||
        event.button !== 0 ||
        event.eventPhase !== ownerWindow.Event.CAPTURING_PHASE ||
        event.currentTarget !== ownerDocument ||
        !event.bubbles ||
        event.defaultPrevented ||
        !(target instanceof ownerWindow.Node) ||
        !target.isConnected ||
        target.ownerDocument !== ownerDocument ||
        !hintDomContains(dom, target)
      ) {
        return null;
      }
      const control = controlForTarget(target);
      const path = eventPath(event, target);
      return control &&
        path &&
        path.includes(control.element) &&
        path.includes(rootElement) &&
        path.includes(ownerDocument)
        ? { event, control, target, path }
        : null;
    };
    const nativeReactDispatchIsCurrent = (
      native: Event,
      phase:
        | typeof ownerWindow.Event.CAPTURING_PHASE
        | typeof ownerWindow.Event.BUBBLING_PHASE,
    ) => {
      const currentTarget = native.currentTarget;
      return (
        native.eventPhase === phase &&
        currentTarget instanceof ownerWindow.Node &&
        currentTarget.ownerDocument === ownerDocument &&
        currentTarget.contains(rootElement)
      );
    };
    const onNativeMouseDown = (event: MouseEvent) => {
      releasePrimaryPress();
      clearInteractionProofs();
      if (!publicationOwnsCurrentDom()) return;
      nativeMouseDown = exactNativeMouse(event, "mousedown");
    };
    const onNativeMouseUp = (event: MouseEvent) => {
      if (!publicationOwnsCurrentDom()) {
        releasePrimaryPress();
        clearInteractionProofs();
        return;
      }
      const down = nativeMouseDown;
      if (!down) {
        releasePrimaryPress();
        clearInteractionProofs();
        return;
      }
      const up = exactNativeMouse(event, "mouseup");
      const preventedByOwnedPress =
        down?.control.kind === "primary" &&
        cells.pressedPublications.has(publication) &&
        cells.pressedControls.has(down.control) &&
        cells.pressedActions.has(preserveFocus) &&
        cells.claimedNativeEvents.has(down.event);
      nativeMouseUp =
        down &&
        up &&
        (!down.event.defaultPrevented || preventedByOwnedPress) &&
        down.control === up.control &&
        down.target === up.target &&
        hintEventPathsEqual(down.path, up.path)
          ? up
          : null;
      if (!nativeMouseUp) {
        releasePrimaryPress();
        clearInteractionProofs();
        return;
      }
      expirePointerProof(down, nativeMouseUp);
    };
    const onNativeKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      releasePrimaryPress();
      clearInteractionProofs();
      if (!publicationOwnsCurrentDom()) return;
      if (
        !(event instanceof ownerWindow.KeyboardEvent) ||
        event.type !== "keydown" ||
        (event.key !== "Enter" && event.key !== " ") ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.eventPhase !== ownerWindow.Event.CAPTURING_PHASE ||
        event.currentTarget !== ownerDocument ||
        !event.bubbles ||
        event.defaultPrevented ||
        !(target instanceof ownerWindow.Node) ||
        target.ownerDocument !== ownerDocument
      ) {
        return;
      }
      const control = controlForTarget(target);
      const path = eventPath(event, target);
      if (
        !control ||
        target !== control.element ||
        ownerDocument.activeElement !== control.element ||
        !path ||
        !path.includes(rootElement)
      ) {
        return;
      }
      keyboardDown = Object.freeze({
        event,
        control,
        key: event.key,
        target,
        path,
      });
      if (keyboardDown.key === "Enter") {
        expireKeyboardProof(keyboardDown, null);
      }
    };
    const onNativeKeyUp = (event: KeyboardEvent) => {
      const proof = keyboardDown;
      const target = event.target;
      releasePrimaryPress();
      clearInteractionProofs();
      if (
        !proof ||
        !publicationOwnsCurrentDom() ||
        !(event instanceof ownerWindow.KeyboardEvent) ||
        event.type !== "keyup" ||
        event.key !== proof.key ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.currentTarget !== ownerDocument ||
        target !== proof.target ||
        event.eventPhase !== ownerWindow.Event.CAPTURING_PHASE ||
        !event.bubbles ||
        event.defaultPrevented ||
        proof.event.defaultPrevented
      ) {
        return;
      }
      const path = eventPath(event, proof.target);
      if (
        proof.key !== " " ||
        !path ||
        !hintEventPathsEqual(path, proof.path)
      ) {
        return;
      }
      keyboardDown = proof;
      keyboardUp = Object.freeze({
        event,
        control: proof.control,
        key: proof.key,
        target: proof.target,
        path,
        down: proof,
      });
      expireKeyboardProof(proof, keyboardUp);
    };
    const onNativeFocusChange = (event: FocusEvent) => {
      if (
        (keyboardDown &&
          (event.type === "focusout" ||
            event.target !== keyboardDown.target)) ||
        (nativeMouseDown &&
          event.type === "focusout" &&
          event.target === nativeMouseDown.control.element)
      ) {
        releasePrimaryPress();
        clearInteractionProofs();
      }
    };
    const onNativeVisibilityChange = () => {
      if (ownerDocument.visibilityState === "visible") return;
      releasePrimaryPress();
      clearInteractionProofs();
    };
    const onNativeWindowBlur = () => {
      releasePrimaryPress();
      clearInteractionProofs();
    };
    const onNativeClick = (event: MouseEvent) => {
      if (!publicationOwnsCurrentDom()) {
        releasePrimaryPress();
        clearInteractionProofs();
        return;
      }
      const proof = exactNativeMouse(event, "click");
      const pointerSource =
        proof &&
        event.detail > 0 &&
        nativeMouseDown?.control === proof.control &&
        nativeMouseUp?.control === proof.control &&
        nativeMouseDown.target === proof.target &&
        nativeMouseUp.target === proof.target &&
        (!nativeMouseDown.event.defaultPrevented ||
          (nativeMouseDown.control.kind === "primary" &&
            cells.pressedPublications.has(publication) &&
            cells.pressedControls.has(nativeMouseDown.control) &&
            cells.pressedActions.has(preserveFocus) &&
            cells.claimedNativeEvents.has(nativeMouseDown.event))) &&
        !nativeMouseUp.event.defaultPrevented &&
        hintEventPathsEqual(nativeMouseDown.path, proof.path)
          ? nativeMouseDown
          : null;
      const keyboardSource =
        proof &&
        event.detail === 0 &&
        keyboardDown?.control === proof.control &&
        keyboardDown.target === proof.control.element &&
        keyboardDown.target === proof.target &&
        !keyboardDown.event.defaultPrevented &&
        (!keyboardUp || !keyboardUp.event.defaultPrevented) &&
        hintEventPathsEqual(keyboardDown.path, proof.path) &&
        ((keyboardDown.key === "Enter" && !keyboardUp) ||
          (keyboardDown.key === " " && keyboardUp?.down === keyboardDown))
          ? (keyboardUp ?? keyboardDown)
          : null;
      const source = pointerSource ?? keyboardSource;
      const pointerUp = pointerSource ? nativeMouseUp : null;
      nativeMouseDown = null;
      nativeMouseUp = null;
      keyboardDown = null;
      keyboardUp = null;
      reactClick = null;
      nativeClick =
        proof && source ? Object.freeze({ ...proof, source, pointerUp }) : null;
      if (!nativeClick) {
        releasePrimaryPress();
        return;
      }
      const capturedClick = nativeClick;
      cancelInteractionExpiry();
      interactionExpiry = ownerWindow.setTimeout(() => {
        interactionExpiry = null;
        if (nativeClick !== capturedClick) return;
        releasePrimaryPress();
        clearInteractionProofs();
      }, 0);
    };
    const releaseNativeListeners = () => {
      if (navigationListening && navigationKeyboard) {
        navigationListening = false;
        try {
          navigationKeyboard.windowUnlisten.invoke(
            ownerWindow,
            "keydown",
            captureNavigationNative,
            true,
          );
        } catch {
          /* The retained listener stays inert because this publication is retired. */
        }
      }
      ownerDocument.removeEventListener("mousedown", onNativeMouseDown, true);
      ownerDocument.removeEventListener("mouseup", onNativeMouseUp, true);
      ownerDocument.removeEventListener("keydown", onNativeKeyDown, true);
      ownerDocument.removeEventListener("keyup", onNativeKeyUp, true);
      ownerDocument.removeEventListener("focusin", onNativeFocusChange, true);
      ownerDocument.removeEventListener("focusout", onNativeFocusChange, true);
      ownerDocument.removeEventListener(
        "visibilitychange",
        onNativeVisibilityChange,
        true,
      );
      ownerWindow.removeEventListener("blur", onNativeWindowBlur, true);
      ownerDocument.removeEventListener("click", onNativeClick, true);
    };
    const addNativeListeners = () => {
      ownerDocument.addEventListener("mousedown", onNativeMouseDown, true);
      ownerDocument.addEventListener("mouseup", onNativeMouseUp, true);
      ownerDocument.addEventListener("keydown", onNativeKeyDown, true);
      ownerDocument.addEventListener("keyup", onNativeKeyUp, true);
      ownerDocument.addEventListener("focusin", onNativeFocusChange, true);
      ownerDocument.addEventListener("focusout", onNativeFocusChange, true);
      ownerDocument.addEventListener(
        "visibilitychange",
        onNativeVisibilityChange,
        true,
      );
      ownerWindow.addEventListener("blur", onNativeWindowBlur, true);
      ownerDocument.addEventListener("click", onNativeClick, true);
      if (navigationKeyboard?.isCurrent()) {
        try {
          navigationKeyboard.windowListen.invoke(
            ownerWindow,
            "keydown",
            captureNavigationNative,
            true,
          );
          navigationListening = true;
        } catch {
          navigationListening = false;
        }
      }
    };
    const publishedDomMatches = () =>
      Boolean(
        guard &&
          guard.isClean() &&
          root.element() === rootElement &&
          rootElement === dom.node &&
          rootElement.isConnected &&
          hintPlacementMatches(ownerDocument, placement) &&
          hintDomMatches(dom),
      );
    const release = () => {
      releasePrimaryPress();
      clearInteractionProofs();
      guard?.release();
      guard = null;
      releaseNativeListeners();
    };
    const retire = (reason: Retirement) => {
      if (reason === "layout") layoutRetired = true;
      if (retired) return false;
      retired = true;
      retirement = reason;
      releasePrimaryPress();
      clearInteractionProofs();
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
    const publication: HintPublication = Object.freeze({
      identity: Symbol("hint-publication"),
      render,
      root: rootElement,
      ownerDocument,
      controls,
      preserveFocus,
      keyboard: navigationKeyboard,
      dom,
      placement,
      retire: () => retire("other"),
      isRetired: () => retired,
      publishedDomMatches,
    });

    function captureNavigationNative(
      this: EventTarget,
      nativeEvent: Event,
    ): void {
      const keyboard = publication.keyboard;
      if (
        retired ||
        !keyboard ||
        !keyboard.isCurrent() ||
        !(nativeEvent instanceof keyboard.KeyboardEvent) ||
        keyboard.ownerWindow.Object.getPrototypeOf(nativeEvent) !==
          keyboard.KeyboardEvent.prototype ||
        seenNativeKeys.has(nativeEvent)
      ) {
        const delivery = nativeKeyDeliveries.get(nativeEvent);
        if (delivery) {
          delivery.captureInvalid = true;
          delivery.bubbleInvalid = true;
        }
        return;
      }
      seenNativeKeys.add(nativeEvent);
      if (!publicationOwnsCurrentDom()) return;
      try {
        const currentTarget = keyboard.eventCurrentTarget.read(nativeEvent);
        const path = keyboard.eventPath.invoke(nativeEvent);
        if (
          !keyboard.trusted.matches(nativeEvent) ||
          keyboard.trusted.read(nativeEvent) !== true ||
          keyboard.eventType.read(nativeEvent) !== "keydown" ||
          currentTarget !== this ||
          keyboard.eventPhase.read(nativeEvent) !==
            keyboard.Event.CAPTURING_PHASE ||
          path.length < 2 ||
          path[path.length - 2] !== ownerDocument ||
          path[path.length - 1] !== this
        ) {
          return;
        }
        const key = keyboard.key.read(nativeEvent);
        const target = keyboard.eventTarget.read(nativeEvent);
        const source =
          target === controls.primary.element
            ? controls.primary
            : target === controls.dismiss.element
              ? controls.dismiss
              : null;
        const view = keyboard.eventView.read(nativeEvent);
        if (
          !isHintNavigationKey(key) ||
          !source ||
          (view !== null && view !== ownerWindow && view !== this) ||
          keyboard.activeElement.read(ownerDocument) !== source.element ||
          source.element.ownerDocument !== ownerDocument ||
          !source.element.isConnected ||
          !hintControlIsEnabled(source) ||
          keyboard.eventBubbles.read(nativeEvent) !== true ||
          keyboard.eventCancelable.read(nativeEvent) !== true ||
          keyboard.eventDefaultPrevented.read(nativeEvent) !== false ||
          keyboard.eventCancelBubble.read(nativeEvent) !== false ||
          keyboard.repeat.read(nativeEvent) !== false ||
          keyboard.composing.read(nativeEvent) !== false ||
          keyboard.ctrlKey.read(nativeEvent) !== false ||
          keyboard.altKey.read(nativeEvent) !== false ||
          keyboard.shiftKey.read(nativeEvent) !== false ||
          keyboard.metaKey.read(nativeEvent) !== false
        ) {
          return;
        }
        const delivery: HintNativeKeyDelivery = {
          snapshot: Object.freeze({
            event: nativeEvent,
            publication,
            source,
            key,
            code: keyboard.code.read(nativeEvent),
            location: keyboard.location.read(nativeEvent),
            target,
            path: Object.freeze([...path]),
            bubbles: true,
            cancelable: true,
            view,
            receiver: this,
          }),
          delegationTarget: null,
          captureInvalid: false,
          captureRootCount: 0,
          captureRootEvent: null,
          captureMethods: null,
          captureControlCount: 0,
          captureControlEvent: null,
          bubbleInvalid: false,
          bubbleMethods: null,
          bubbleControlCount: 0,
          bubbleControlEvent: null,
          bubbleRootCount: 0,
          bubbleRootEvent: null,
        };
        nativeKeyDeliveries.set(nativeEvent, delivery);
      } catch {
        nativeKeyDeliveries.delete(nativeEvent);
      }
    }

    const liveNavigationControls = () => {
      const primary = action.element();
      const close = dismiss.element();
      if (
        primary !== controls.primary.element ||
        close !== controls.dismiss.element
      ) {
        return null;
      }
      return Object.freeze([controls.primary, controls.dismiss]);
    };

    const invalidateKeyDelivery = (
      delivery: HintNativeKeyDelivery,
      phase: HintKeyPhase,
    ) => {
      if (phase === "capture") delivery.captureInvalid = true;
      else delivery.bubbleInvalid = true;
    };

    const stageHintRootKey = (
      phase: HintKeyPhase,
      event: ReactKeyboardEvent<HTMLDivElement>,
    ) => {
      const keyboard = publication.keyboard;
      if (retired || !keyboard || !event || typeof event !== "object") {
        return;
      }
      const carried = hintWrapperNativeEvent(event);
      const delivery = carried ? nativeKeyDeliveries.get(carried) : undefined;
      if (!delivery || delivery.snapshot.publication !== publication) return;
      try {
        const expectedMethods =
          phase === "capture" ? delivery.captureMethods : delivery.bubbleMethods;
        const facts = exactHintReactKey(
          event,
          publication,
          delivery.snapshot.source.element,
          rootElement,
          phase,
          delivery.snapshot.receiver,
          expectedMethods ?? undefined,
        );
        const controlsNow = liveNavigationControls();
        if (
          !facts ||
          !controlsNow ||
          !publicationOwnsCurrentDom() ||
          delivery.snapshot.source.element !==
            controlsNow[delivery.snapshot.source.kind === "primary" ? 0 : 1]
              .element
        ) {
          invalidateKeyDelivery(delivery, phase);
          return;
        }
        if (phase === "capture") {
          if (
            delivery.captureInvalid ||
            delivery.captureRootCount !== 0 ||
            delivery.captureRootEvent !== null ||
            delivery.captureControlCount !== 0 ||
            delivery.captureControlEvent !== null ||
            delivery.delegationTarget !== null ||
            facts.delegationTarget === rootElement ||
            !delivery.snapshot.path.includes(facts.delegationTarget)
          ) {
            delivery.captureInvalid = true;
            return;
          }
          delivery.captureRootCount = 1;
          delivery.captureRootEvent = event;
          delivery.captureMethods = facts.methods;
          delivery.delegationTarget = facts.delegationTarget;
          return;
        }
        if (
          delivery.captureInvalid ||
          delivery.bubbleInvalid ||
          !delivery.delegationTarget ||
          delivery.delegationTarget !== facts.delegationTarget ||
          delivery.captureRootCount !== 1 ||
          !delivery.captureRootEvent ||
          delivery.captureControlCount !== 1 ||
          delivery.captureControlEvent !== delivery.captureRootEvent ||
          delivery.bubbleControlCount !== 1 ||
          delivery.bubbleControlEvent !==
            (event as ReactKeyboardEvent<HTMLElement>) ||
          delivery.bubbleRootCount !== 0 ||
          delivery.bubbleRootEvent !== null
        ) {
          delivery.bubbleInvalid = true;
          return;
        }
        delivery.bubbleRootCount = 1;
        delivery.bubbleRootEvent = event;
        finalizeNavigation(facts.nativeEvent);
      } finally {
        if (phase === "bubble") {
          delivery.captureInvalid = true;
          delivery.bubbleInvalid = true;
          if (carried && nativeKeyDeliveries.get(carried) === delivery) {
            nativeKeyDeliveries.delete(carried);
          }
        }
      }
    };

    const stageHintControlKey = (
      kind: HintControlKind,
      phase: HintKeyPhase,
      event: ReactKeyboardEvent<HTMLButtonElement>,
    ) => {
      const keyboard = publication.keyboard;
      if (retired || !keyboard || !event || typeof event !== "object") {
        return;
      }
      const carried = hintWrapperNativeEvent(event);
      const delivery = carried ? nativeKeyDeliveries.get(carried) : undefined;
      if (!delivery || delivery.snapshot.publication !== publication) return;
      const source = controls[kind];
      const expectedMethods =
        phase === "capture" ? delivery.captureMethods : delivery.bubbleMethods;
      const facts = exactHintReactKey(
        event,
        publication,
        source.element,
        source.element,
        phase,
        delivery.snapshot.receiver,
        expectedMethods ?? undefined,
      );
      if (
        !facts ||
        !publicationOwnsCurrentDom() ||
        delivery.snapshot.source !== source ||
        delivery.snapshot.target !== source.element ||
        delivery.snapshot.key !== facts.key ||
        delivery.delegationTarget !== facts.delegationTarget ||
        !hintNativeKeySnapshotMatches(keyboard, delivery)
      ) {
        invalidateKeyDelivery(delivery, phase);
        return;
      }
      if (phase === "capture") {
        if (
          delivery.captureInvalid ||
          delivery.captureRootCount !== 1 ||
          delivery.captureRootEvent !== event ||
          delivery.captureControlCount !== 0 ||
          delivery.captureControlEvent !== null
        ) {
          delivery.captureInvalid = true;
          return;
        }
        delivery.captureControlCount = 1;
        delivery.captureControlEvent = event;
        return;
      }
      if (
        delivery.captureInvalid ||
        delivery.bubbleInvalid ||
        delivery.captureControlCount !== 1 ||
        !delivery.captureControlEvent ||
        delivery.captureControlEvent === event ||
        delivery.bubbleControlCount !== 0 ||
        delivery.bubbleControlEvent !== null ||
        delivery.bubbleRootCount !== 0 ||
        delivery.bubbleRootEvent !== null
      ) {
        delivery.bubbleInvalid = true;
        return;
      }
      delivery.bubbleControlCount = 1;
      delivery.bubbleControlEvent = event;
      delivery.bubbleMethods = facts.methods;
    };

    function finalizeNavigation(nativeEvent: globalThis.KeyboardEvent): void {
      const keyboard = publication.keyboard;
      const delivery = nativeKeyDeliveries.get(nativeEvent);
      if (
        retired ||
        !keyboard ||
        !delivery ||
        delivery.snapshot.publication !== publication
      ) {
        return;
      }
      const staged = delivery.snapshot;
      const captureEvent = delivery.captureControlEvent;
      const bubbleEvent = delivery.bubbleControlEvent;
      const controlsNow = liveNavigationControls();
      const methodsAreCurrent = (
        event: ReactKeyboardEvent<HTMLElement>,
        methods: HintReactKeyMethods,
      ) =>
        keyboard.reactMethodMatches(
          event,
          "preventDefault",
          methods.preventDefault,
        ) &&
        keyboard.reactMethodMatches(
          event,
          "isDefaultPrevented",
          methods.isDefaultPrevented,
        ) &&
        keyboard.reactMethodMatches(
          event,
          "isPropagationStopped",
          methods.isPropagationStopped,
        );
      try {
        if (
          keyboard.eventCurrentTarget.read(nativeEvent) !==
            delivery.delegationTarget ||
          keyboard.eventPhase.read(nativeEvent) !==
            keyboard.Event.BUBBLING_PHASE ||
          delivery.captureInvalid ||
          delivery.bubbleInvalid ||
          delivery.captureRootCount !== 1 ||
          !delivery.captureMethods ||
          delivery.captureControlCount !== 1 ||
          !captureEvent ||
          delivery.captureRootEvent !== captureEvent ||
          delivery.bubbleControlCount !== 1 ||
          !delivery.bubbleMethods ||
          !bubbleEvent ||
          delivery.bubbleRootCount !== 1 ||
          delivery.bubbleRootEvent !== bubbleEvent ||
          captureEvent === bubbleEvent ||
          !controlsNow ||
          controlsNow[staged.source.kind === "primary" ? 0 : 1] !==
            staged.source ||
          keyboard.activeElement.read(ownerDocument) !==
            staged.source.element ||
          !hintNativeKeySnapshotMatches(keyboard, delivery) ||
          !publicationOwnsCurrentDom() ||
          !methodsAreCurrent(captureEvent, delivery.captureMethods) ||
          !methodsAreCurrent(bubbleEvent, delivery.bubbleMethods) ||
          keyboard.apply(
            delivery.captureMethods.isDefaultPrevented,
            captureEvent,
            [],
          ) !== false ||
          keyboard.apply(
            delivery.bubbleMethods.isDefaultPrevented,
            bubbleEvent,
            [],
          ) !== false
        ) {
          return;
        }
        const destination = hintNavigationDestination(
          publication,
          staged.source,
          staged.key,
        );
        if (
          !destination ||
          destination === staged.source ||
          destination.element.ownerDocument !== ownerDocument ||
          !destination.element.isConnected ||
          destination.element.parentElement !== rootElement ||
          !hintControlIsEnabled(destination)
        ) {
          return;
        }
        const movement: HintNavigationMovement = Object.freeze({
          identity: Symbol("hint-navigation-movement"),
          publication,
          source: staged.source,
          destination,
          key: staged.key,
          nativeEvent,
          captureEvent,
          bubbleEvent,
          receiver: staged.receiver,
        });
        if (
          cells.claimedPublications.has(publication) ||
          cells.claimedControls.has(staged.source) ||
          cells.claimedControls.has(destination) ||
          cells.claimedActions.has(staged.source.action) ||
          cells.claimedActions.has(destination.action) ||
          cells.claimedReactEvents.has(captureEvent) ||
          cells.claimedReactEvents.has(bubbleEvent) ||
          cells.claimedNativeEvents.has(nativeEvent) ||
          cells.claimedMovements.has(movement)
        ) {
          return;
        }
        cells.claimedPublications.add(publication);
        cells.claimedControls.add(staged.source);
        cells.claimedControls.add(destination);
        cells.claimedActions.add(staged.source.action);
        cells.claimedActions.add(destination.action);
        cells.claimedReactEvents.add(captureEvent);
        cells.claimedReactEvents.add(bubbleEvent);
        cells.claimedNativeEvents.add(nativeEvent);
        cells.claimedMovements.add(movement);
        delivery.captureInvalid = true;
        delivery.bubbleInvalid = true;
        if (
          !publicationOwnsCurrentDom() ||
          keyboard.activeElement.read(ownerDocument) !==
            staged.source.element ||
          hintNavigationDestination(publication, staged.source, staged.key) !==
            destination ||
          !methodsAreCurrent(captureEvent, delivery.captureMethods) ||
          !methodsAreCurrent(bubbleEvent, delivery.bubbleMethods) ||
          keyboard.apply(
            delivery.captureMethods.isDefaultPrevented,
            captureEvent,
            [],
          ) !== false ||
          keyboard.apply(
            delivery.bubbleMethods.isDefaultPrevented,
            bubbleEvent,
            [],
          ) !== false
        ) {
          return;
        }
        keyboard.apply(delivery.bubbleMethods.preventDefault, bubbleEvent, []);
        const postPreventionMethod = bubbleEvent.isDefaultPrevented as (
          ...args: never[]
        ) => unknown;
        if (
          keyboard.eventDefaultPrevented.read(nativeEvent) !== true ||
          !keyboard.reactMethodMatches(
            captureEvent,
            "isDefaultPrevented",
            delivery.captureMethods.isDefaultPrevented,
          ) ||
          !keyboard.reactMethodMatches(
            bubbleEvent,
            "isDefaultPrevented",
            postPreventionMethod,
          ) ||
          keyboard.apply(postPreventionMethod, bubbleEvent, []) !== true
        ) {
          return;
        }
        keyboard.focus.invoke(destination.element, { preventScroll: true });
        requestSuccessor();
      } catch {
        delivery.captureInvalid = true;
        delivery.bubbleInvalid = true;
      }
    }

    const exactReactProof = (
      proof: HintReactProof | null,
      event: ReactMouseEvent<HTMLButtonElement>,
      control: HintControl,
      native: HintNativeMouseProof | HintNativeClickProof | null,
      type: "mousedown" | "click",
    ) =>
      Boolean(
        proof &&
          native &&
          proof.native === native &&
          event.nativeEvent === native.event &&
          nativeReactDispatchIsCurrent(
            native.event,
            ownerWindow.Event.BUBBLING_PHASE,
          ) &&
          event.type === type &&
          event.button === 0 &&
          event.detail === native.event.detail &&
          event.bubbles &&
          !event.defaultPrevented &&
          event.currentTarget === control.element &&
          event.target === native.target &&
          native.control === control &&
          control.targets.includes(native.target),
      );
    const claimPress = (
      control: HintControl,
      event: ReactMouseEvent<HTMLButtonElement>,
      native: HintNativeMouseProof,
    ) => {
      if (
        cells.pressedPublications.has(publication) ||
        cells.pressedControls.has(control) ||
        cells.pressedActions.has(preserveFocus) ||
        (reactMouseDown &&
          cells.claimedReactEvents.has(reactMouseDown.event)) ||
        cells.claimedReactEvents.has(event) ||
        cells.claimedNativeEvents.has(native.event)
      ) {
        return false;
      }
      cells.pressedPublications.add(publication);
      cells.pressedControls.add(control);
      cells.pressedActions.add(preserveFocus);
      if (reactMouseDown) cells.claimedReactEvents.add(reactMouseDown.event);
      cells.claimedReactEvents.add(event);
      cells.claimedNativeEvents.add(native.event);
      return true;
    };
    const claimActivation = (
      control: HintControl,
      event: ReactMouseEvent<HTMLButtonElement>,
      native: HintNativeClickProof,
    ) => {
      const source = native.source;
      const keyboardRelease = "down" in source ? source : null;
      const keyboardPress =
        keyboardRelease?.down ??
        (source.event instanceof ownerWindow.KeyboardEvent ? source : null);
      const pointerPress =
        source.event instanceof ownerWindow.MouseEvent ? source : null;
      const pointerRelease = native.pointerUp;
      const claimedPrimaryPress =
        control.kind === "primary" &&
        pointerPress !== null &&
        pointerPress.event.defaultPrevented &&
        cells.pressedPublications.has(publication) &&
        cells.pressedControls.has(control) &&
        cells.pressedActions.has(preserveFocus) &&
        cells.claimedNativeEvents.has(pointerPress.event);
      if (
        cells.claimedVisits.has(render.visit) ||
        cells.claimedPublications.has(publication) ||
        cells.claimedControls.has(control) ||
        cells.claimedActions.has(control.action) ||
        (reactClick && cells.claimedReactEvents.has(reactClick.event)) ||
        cells.claimedReactEvents.has(event) ||
        cells.claimedNativeEvents.has(native.event) ||
        (control.kind === "primary" &&
          pointerPress !== null &&
          !claimedPrimaryPress) ||
        (pointerPress !== null &&
          cells.claimedNativeEvents.has(pointerPress.event) &&
          !claimedPrimaryPress) ||
        (pointerRelease !== null &&
          cells.claimedNativeEvents.has(pointerRelease.event)) ||
        (keyboardPress !== null &&
          cells.claimedNativeEvents.has(keyboardPress.event)) ||
        (keyboardRelease !== null &&
          cells.claimedNativeEvents.has(keyboardRelease.event))
      ) {
        return false;
      }
      cells.claimedVisits.add(render.visit);
      cells.claimedPublications.add(publication);
      cells.claimedControls.add(control);
      cells.claimedActions.add(control.action);
      if (reactClick) cells.claimedReactEvents.add(reactClick.event);
      cells.claimedReactEvents.add(event);
      cells.claimedNativeEvents.add(native.event);
      if (pointerPress) cells.claimedNativeEvents.add(pointerPress.event);
      if (pointerRelease) {
        cells.claimedNativeEvents.add(pointerRelease.event);
      }
      if (keyboardPress) cells.claimedNativeEvents.add(keyboardPress.event);
      if (keyboardRelease) cells.claimedNativeEvents.add(keyboardRelease.event);
      return true;
    };
    const captureReact = (
      event: ReactMouseEvent<HTMLDivElement>,
      native: HintNativeMouseProof | HintNativeClickProof | null,
      type: "mousedown" | "click",
    ) => {
      if (
        !native ||
        !publicationOwnsCurrentDom() ||
        event.nativeEvent !== native.event ||
        !nativeReactDispatchIsCurrent(
          native.event,
          ownerWindow.Event.CAPTURING_PHASE,
        ) ||
        event.type !== type ||
        event.button !== 0 ||
        event.currentTarget !== rootElement ||
        event.target !== native.target ||
        !event.bubbles ||
        event.defaultPrevented
      ) {
        return null;
      }
      return Object.freeze({ event, native });
    };
    const runtime: HintPublicationRuntime = Object.freeze({
      publication,
      publish: () => {
        established = true;
        refs = expectedOwners().map((owner) => {
          const element = owner.element();
          if (!element) {
            throw new Error(
              "Cannot publish HintBar without every committed ref",
            );
          }
          return { owner, element, state: "attached" as const };
        });
        guard = createHintDomGuard(rootElement, placement);
        if (!guard || cells.active.current) {
          release();
          return false;
        }
        cells.active.current = publication;
        cells.successorOf.current = null;
        cells.replay.current = null;
        addNativeListeners();
        return true;
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        retire("layout");
      },
      noteRef: (
        owner: HintElementOwnerView,
        element: Element | null,
        previous: Element | null,
      ) => {
        if (!established) return;
        const proof = refs.find((entry) => entry.owner === owner);
        if (!proof) return;
        if (
          proof.state === "attached" &&
          element === null &&
          previous === proof.element
        ) {
          proof.state = "detached";
        } else if (
          proof.state === "detached" &&
          element === proof.element &&
          previous === null
        ) {
          proof.state = "reattached";
        } else if (element !== previous) {
          proof.state = "invalid";
        }
      },
      isExactReplay: () =>
        retired &&
        layoutRetired &&
        (retirement === "element" || retirement === "layout") &&
        established &&
        refs.length === expectedOwners().length &&
        refs.every(
          (entry) =>
            entry.state === "reattached" &&
            entry.owner.element() === entry.element,
        ) &&
        publishedDomMatches(),
      replay: () =>
        guard
          ? Object.freeze({
              source: publication,
              dom,
              placement,
              historyIsClean: guard.isClean,
              release,
            })
          : null,
      captureReactMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => {
        reactMouseDown = captureReact(event, nativeMouseDown, "mousedown");
      },
      captureReactClick: (event: ReactMouseEvent<HTMLDivElement>) => {
        reactClick = captureReact(event, nativeClick, "click");
      },
      captureReactRootKey: (
        phase: HintKeyPhase,
        event: ReactKeyboardEvent<HTMLDivElement>,
      ) => {
        stageHintRootKey(phase, event);
      },
      captureReactControlKey: (
        kind: HintControlKind,
        phase: HintKeyPhase,
        event: ReactKeyboardEvent<HTMLButtonElement>,
      ) => {
        stageHintControlKey(kind, phase, event);
      },
      preserveActionFocus: (event: ReactMouseEvent<HTMLButtonElement>) => {
        const control = controls.primary;
        if (
          !publicationOwnsCurrentDom() ||
          !exactReactProof(
            reactMouseDown,
            event,
            control,
            nativeMouseDown,
            "mousedown",
          ) ||
          !nativeMouseDown ||
          !claimPress(control, event, nativeMouseDown)
        ) {
          return;
        }
        event.preventDefault();
      },
      activate: (
        kind: HintControlKind,
        event: ReactMouseEvent<HTMLButtonElement>,
      ) => {
        const control = controls[kind];
        if (
          !publicationOwnsCurrentDom() ||
          !exactReactProof(reactClick, event, control, nativeClick, "click") ||
          !nativeClick ||
          !claimActivation(control, event, nativeClick)
        ) {
          return null;
        }
        retire("other");
        release();
        return publication;
      },
    });
    return runtime;
  };

  return Object.freeze({
    establish: () => {
      if (lastRuntime) {
        if (
          !successorRequested &&
          lastRuntime.isExactReplay() &&
          cells.successorOf.current === lastRuntime.publication
        ) {
          const replay = lastRuntime.replay();
          if (
            replay &&
            hintFactsAreCurrent(render) &&
            hintElementsAreCurrent(render, owners) &&
            lastRuntime.publication.publishedDomMatches()
          ) {
            cells.replay.current = replay;
            successorRequested = true;
            requestSuccessor();
          }
        }
        return;
      }
      if (
        !hintFactsAreCurrent(render) ||
        !hintElementsAreCurrent(render, owners)
      ) {
        return;
      }
      const rootElement = root.element();
      if (!(rootElement instanceof HTMLDivElement)) return;
      const replay = cells.replay.current;
      if (replay) {
        const sameFacts = hintRenderMatches(replay.source.render, render);
        const exact =
          sameFacts &&
          replay.source.isRetired() &&
          cells.successorOf.current === replay.source &&
          replay.historyIsClean() &&
          rootElement === replay.dom.node &&
          hintPlacementMatches(rootElement.ownerDocument, replay.placement) &&
          hintDomMatches(replay.dom);
        cells.replay.current = null;
        replay.release();
        if (cells.successorOf.current === replay.source) {
          cells.successorOf.current = null;
        }
        if (sameFacts && !exact) return;
      }
      const runtime = createRuntime();
      if (!runtime) return;
      const previous = cells.active.current;
      if (previous) previous.retire();
      currentRuntime = runtime;
      lastRuntime = runtime;
      if (!runtime.publish()) {
        runtime.retireForElement();
        currentRuntime = null;
        return;
      }
      return runtime.retireForLayout;
    },
    captureRoot: root.capture,
    captureIcon: icon.capture,
    captureText: text.capture,
    captureAction: action.capture,
    captureDismiss: dismiss.capture,
    captureDismissIcon: dismissIcon.capture,
    captureMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => {
      currentRuntime?.captureReactMouseDown(event);
    },
    captureClick: (event: ReactMouseEvent<HTMLDivElement>) => {
      currentRuntime?.captureReactClick(event);
    },
    captureKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      currentRuntime?.captureReactRootKey("capture", event);
    },
    keyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      currentRuntime?.captureReactRootKey("bubble", event);
    },
    capturePrimaryKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      currentRuntime?.captureReactControlKey("primary", "capture", event);
    },
    primaryKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      currentRuntime?.captureReactControlKey("primary", "bubble", event);
    },
    captureDismissKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      currentRuntime?.captureReactControlKey("dismiss", "capture", event);
    },
    dismissKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      currentRuntime?.captureReactControlKey("dismiss", "bubble", event);
    },
    preserveActionFocus: (event: ReactMouseEvent<HTMLButtonElement>) => {
      currentRuntime?.preserveActionFocus(event);
    },
    activatePrimary: (event: ReactMouseEvent<HTMLButtonElement>) => {
      return currentRuntime?.activate("primary", event) ?? null;
    },
    activateDismiss: (event: ReactMouseEvent<HTMLButtonElement>) => {
      return currentRuntime?.activate("dismiss", event) ?? null;
    },
  });
}

function PublishedHintBar({
  session,
  documentId,
  discoveryKey,
  role,
  canEdit,
  shown,
  record,
  pinned,
  actions,
  onShare,
  onComment,
  discovery,
  retireDiscovery,
  setRecord,
  setPinned,
}: {
  session: CollabSession;
  documentId: string;
  discoveryKey: DiscoveryKey;
  role: CollabSession["role"];
  canEdit: boolean;
  shown: HintId;
  record: HintsRecord;
  pinned: PinnedHint;
  actions: EditorActions;
  onShare: () => void;
  onComment: () => void;
  discovery: DiscoveryAuthority | null;
  retireDiscovery: (authority: DiscoveryAuthority) => void;
  setRecord: Dispatch<SetStateAction<HintsRecord>>;
  setPinned: Dispatch<SetStateAction<PinnedHint | null>>;
}) {
  const [publicationMount] = useState(() => Symbol("hint publication mount"));
  const visit = useMemo<HintVisit>(
    () =>
      Object.freeze({
        identity: Symbol("hint visit"),
        mount: publicationMount,
        session,
        documentId,
        role,
        canEdit,
      }),
    [canEdit, documentId, publicationMount, role, session],
  );
  const [cells] = useState<HintPublicationCells>(() => ({
    active: { current: null },
    successorOf: { current: null },
    replay: { current: null },
    claimedVisits: new WeakSet(),
    claimedPublications: new WeakSet(),
    claimedControls: new WeakSet(),
    claimedActions: new WeakSet(),
    claimedReactEvents: new WeakSet(),
    claimedNativeEvents: new WeakSet(),
    claimedMovements: new WeakSet(),
    pressedPublications: new WeakSet(),
    pressedControls: new WeakSet(),
    pressedActions: new WeakSet(),
  }));
  const [, setPublicationRevision] = useState(0);
  const requestSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const copy = HINTS[shown];
  const Icon = ICONS[shown];
  const render: HintRender = Object.freeze({
    identity: Symbol("hint render"),
    mount: publicationMount,
    visit,
    key: discoveryKey,
    session,
    documentId,
    role,
    canEdit,
    id: shown,
    message: copy.message,
    actionLabel: copy.action,
    record: hintRecordSnapshot(record),
    dismissedRecord: hintRecordSnapshot(withDismissed(record, shown)),
    pin: pinned,
    actions,
    focus: actions.focus,
    onShare,
    onComment,
    primaryCallback: shown === "collab-agent" ? onShare : onComment,
    storage: window.localStorage,
    discovery,
  });
  const publication = createHintPublication(render, cells, requestSuccessor);

  useLayoutEffect(() => publication.establish(), [publication]);

  const activatePrimary = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const current = publication.activatePrimary(event);
    if (!current) return;
    const { render: authority } = current;
    const next: HintsRecord = {
      dismissed: [...authority.dismissedRecord.dismissed],
      agentSeen: authority.dismissedRecord.agentSeen,
    };
    setRecord(next);
    setPinned((value) => (value === authority.pin ? null : value));
    writeHintsRecord(authority.storage, next);
    if (authority.discovery) retireDiscovery(authority.discovery);
    authority.primaryCallback();
  };
  const activateDismiss = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const current = publication.activateDismiss(event);
    if (!current) return;
    const restoreFocus = current.root.contains(
      current.ownerDocument.activeElement,
    );
    const { render: authority } = current;
    const next: HintsRecord = {
      dismissed: [...authority.dismissedRecord.dismissed],
      agentSeen: authority.dismissedRecord.agentSeen,
    };
    setRecord(next);
    setPinned((value) => (value === authority.pin ? null : value));
    writeHintsRecord(authority.storage, next);
    if (authority.discovery) retireDiscovery(authority.discovery);
    if (restoreFocus) authority.focus();
  };
  const {
    captureRoot,
    captureIcon,
    captureText,
    captureAction,
    captureDismiss,
    captureDismissIcon,
    captureMouseDown,
    captureClick,
    captureKeyDown,
    keyDown,
    capturePrimaryKeyDown,
    primaryKeyDown,
    captureDismissKeyDown,
    dismissKeyDown,
    preserveActionFocus,
  } = publication;
  return (
    <div
      ref={captureRoot}
      className={HINT_ROOT_CLASS}
      role="status"
      aria-live="polite"
      data-testid="hint-bar"
      data-hint={shown}
      onMouseDownCapture={captureMouseDown}
      onClickCapture={captureClick}
      onKeyDownCapture={captureKeyDown}
      onKeyDown={keyDown}
    >
      <Icon
        ref={captureIcon}
        size={14}
        className={HINT_ICON_CLASS}
        aria-hidden
      />
      <span ref={captureText} className={HINT_TEXT_CLASS} title={copy.message}>
        {copy.message}
      </span>
      <button
        ref={captureAction}
        type="button"
        className={HINT_ACTION_CLASS}
        onMouseDown={preserveActionFocus}
        onKeyDownCapture={capturePrimaryKeyDown}
        onKeyDown={primaryKeyDown}
        onClick={activatePrimary}
        data-testid="hint-action"
      >
        {copy.action}
      </button>
      <button
        ref={captureDismiss}
        type="button"
        className={HINT_DISMISS_CLASS}
        onKeyDownCapture={captureDismissKeyDown}
        onKeyDown={dismissKeyDown}
        onClick={activateDismiss}
        aria-label="Dismiss hint"
        data-testid="hint-dismiss"
      >
        <X ref={captureDismissIcon} size={14} />
      </button>
    </div>
  );
}

/**
 * One-line, once-only hints under the toolbar for the agent/collaboration features. Reads session
 * state itself (the shell does not re-render for it) and remembers dismissals in `localStorage`
 * (`markdoc:hints`). A hint that has appeared stays until ✕ or its action; once both are dismissed
 * the bar never mounts again. Never shown on phone widths.
 */
export function HintBar({
  session,
  actions,
  onShare,
  onComment,
}: HintBarProps) {
  // Storage is read after hydration so the server markup (no bar) matches the first client render.
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const [record, setRecord] = useState<HintsRecord>(EMPTY_HINTS_RECORD);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setRecord(
      readHintsRecord(
        typeof window === "undefined" ? null : window.localStorage,
      ),
    );
    setLoaded(true);
  }, []);
  const wide = useMediaQuery(`(min-width: ${HINTS_MIN_WIDTH}px)`);
  const active =
    hydrated && loaded && wide && !allHintsDismissed(record.dismissed);

  // Everything else comes from the live session; the selector returns small primitives so the bar
  // re-renders only when a gate actually flips, not per keystroke.
  const live = useSessionValue(
    session,
    (s) => {
      if (!active) {
        return {
          people: 0,
          agentHere: false,
          threads: 0,
          role: s.role,
          canEdit: s.canEdit,
        };
      }
      const presence = s.presence();
      return {
        people: presence.filter((p) => !p.isLocal && !p.isAgent).length,
        agentHere: presence.some((p) => p.isAgent),
        threads: s.comments.list().length,
        role: s.role,
        canEdit: s.canEdit,
      };
    },
    shallowEqual,
  );

  // Share-list and token evidence are independent: a failed source stays unknown and is retried
  // without discarding a successful source. The coordinator outlives effect restarts so an older
  // request must settle before the same source can be requested for a replacement document.
  const settled = useOpenSettled(session);
  const documentId = session.docId;
  const discoveryKey = useMemo<DiscoveryKey>(
    () => ({ session, documentId }),
    [session, documentId],
  );
  const [discovery, setDiscovery] = useState<DiscoverySnapshot | null>(null);
  const discoveryCoordinator = useRef<DiscoveryCoordinator>({
    authority: null,
    collaboratorsOperation: null,
    tokenOperation: null,
    nextOperation: 0,
  });
  const needsShareInfo =
    active &&
    settled &&
    !record.dismissed.includes("collab-agent") &&
    !record.agentSeen &&
    !live.agentHere;
  const retireDiscovery = useCallback((authority: DiscoveryAuthority) => {
    if (authority.retired) return;
    authority.retired = true;
    const retry = authority.retry;
    if (retry?.authority === authority) {
      authority.retry = null;
      if (retry.timer !== null) {
        clearTimeout(retry.timer);
        retry.timer = null;
      }
    }
    if (authority.visibilityListener !== null) {
      document.removeEventListener(
        "visibilitychange",
        authority.visibilityListener,
      );
      authority.visibilityListener = null;
    }
    authority.run = null;
    if (discoveryCoordinator.current.authority === authority)
      discoveryCoordinator.current.authority = null;
  }, []);

  useLayoutEffect(() => {
    if (!needsShareInfo) return;
    const coordinator = discoveryCoordinator.current;
    const authority: DiscoveryAuthority = {
      key: discoveryKey,
      collaborators: null,
      tokenUsed: null,
      visible: false,
      generation: 0,
      retry: null,
      run: null,
      visibilityListener: null,
      retired: false,
    };
    if (coordinator.authority) retireDiscovery(coordinator.authority);
    coordinator.authority = authority;
    return () => retireDiscovery(authority);
  }, [discoveryKey, needsShareInfo, retireDiscovery]);

  useEffect(() => {
    if (!needsShareInfo) return;
    const coordinator = discoveryCoordinator.current;
    const authority = coordinator.authority;
    if (!authority || authority.key !== discoveryKey) return;
    const ownsAuthority = () =>
      !authority.retired && coordinator.authority === authority;
    if (!ownsAuthority()) return;
    authority.visible = document.visibilityState === "visible";

    const operationFor = (source: DiscoverySource) =>
      source === "collaborators"
        ? coordinator.collaboratorsOperation
        : coordinator.tokenOperation;
    const setOperation = (
      source: DiscoverySource,
      operation: DiscoveryOperation | null,
    ) => {
      if (source === "collaborators")
        coordinator.collaboratorsOperation = operation;
      else coordinator.tokenOperation = operation;
    };
    const ownsOperation = (operation: DiscoveryOperation) =>
      ownsAuthority() &&
      authority.visible &&
      operation.authority === authority &&
      operation.generation === authority.generation &&
      operationFor(operation.source) === operation;
    const publish = (operation: DiscoveryOperation) => {
      if (!ownsOperation(operation)) return;
      setDiscovery({
        authority,
        collaborators: authority.collaborators,
        tokenUsed: authority.tokenUsed,
      });
    };
    const clearRetry = () => {
      const retry = authority.retry;
      if (retry?.authority !== authority) return;
      authority.retry = null;
      if (retry.timer !== null) {
        clearTimeout(retry.timer);
        retry.timer = null;
      }
    };
    const agentKnown = () =>
      authority.collaborators?.agentKnown === true ||
      authority.tokenUsed === true;
    const scheduleRetry = () => {
      if (
        !ownsAuthority() ||
        !authority.visible ||
        agentKnown() ||
        (authority.collaborators !== null && authority.tokenUsed !== null)
      ) {
        clearRetry();
        return;
      }
      const retryableSource =
        (authority.collaborators === null &&
          coordinator.collaboratorsOperation === null) ||
        (authority.tokenUsed === null && coordinator.tokenOperation === null);
      if (!retryableSource || authority.retry !== null) return;
      const retry: DiscoveryRetry = { authority, timer: null };
      retry.timer = setTimeout(() => {
        if (!ownsAuthority() || authority.retry !== retry) return;
        authority.retry = null;
        retry.timer = null;
        run();
      }, COLLAB_HINT_RETRY_MS);
      authority.retry = retry;
    };
    const releaseOperation = (operation: DiscoveryOperation) => {
      if (
        operation.authority !== authority ||
        operationFor(operation.source) !== operation
      )
        return;
      const currentSettlement = ownsOperation(operation);
      setOperation(operation.source, null);
      if (currentSettlement && ownsAuthority()) scheduleRetry();
      else coordinator.authority?.run?.();
    };
    const requestCollaborators = () => {
      if (
        !ownsAuthority() ||
        !authority.visible ||
        authority.collaborators !== null ||
        coordinator.collaboratorsOperation !== null
      )
        return;
      const operation: DiscoveryOperation = {
        authority,
        source: "collaborators",
        generation: authority.generation,
        operation: ++coordinator.nextOperation,
      };
      coordinator.collaboratorsOperation = operation;
      void api.documents
        .collaborators(authority.key.documentId)
        .then(
        (result) => {
          if (!ownsOperation(operation)) return;
          authority.collaborators = {
            collaborators: result.collaborators.length,
            agentKnown: result.agents.length > 0,
          };
          publish(operation);
        },
        () => {
          if (!ownsOperation(operation)) return;
        },
        )
        .finally(() => releaseOperation(operation));
    };
    const requestTokens = () => {
      if (
        !ownsAuthority() ||
        !authority.visible ||
        authority.tokenUsed !== null ||
        coordinator.tokenOperation !== null
      )
        return;
      const operation: DiscoveryOperation = {
        authority,
        source: "tokens",
        generation: authority.generation,
        operation: ++coordinator.nextOperation,
      };
      coordinator.tokenOperation = operation;
      void api.tokens
        .list()
        .then(
        (result) => {
          if (!ownsOperation(operation)) return;
            authority.tokenUsed = result.tokens.some(
              (token) => !!token.lastUsedAt,
            );
          publish(operation);
        },
        () => {
          if (!ownsOperation(operation)) return;
        },
        )
        .finally(() => releaseOperation(operation));
    };
    const run = () => {
      if (!ownsAuthority() || !authority.visible || agentKnown()) return;
      clearRetry();
      requestCollaborators();
      requestTokens();
    };
    authority.run = run;

    const onVisibilityChange = () => {
      if (!ownsAuthority()) return;
      const nextVisible = document.visibilityState === "visible";
      if (nextVisible === authority.visible) return;
      authority.visible = nextVisible;
      if (!authority.visible) {
        authority.generation++;
        clearRetry();
        return;
      }
      run();
    };
    authority.visibilityListener = onVisibilityChange;
    document.addEventListener("visibilitychange", onVisibilityChange);
    run();
    return () => retireDiscovery(authority);
  }, [discoveryKey, needsShareInfo, retireDiscovery]);

  const currentDiscovery =
    needsShareInfo &&
    discovery?.authority.key === discoveryKey &&
    !discovery.authority.retired
      ? discovery
      : null;
  const discoveredAgent =
    currentDiscovery?.collaborators?.agentKnown === true ||
    currentDiscovery?.tokenUsed === true;

  // Remember that an agent has been seen so hint (a) stays quiet in future documents.
  useEffect(() => {
    const discoveryStillOwnsVisit =
      currentDiscovery !== null &&
      !currentDiscovery.authority.retired &&
      discoveryCoordinator.current.authority === currentDiscovery.authority;
    if (
      !loaded ||
      record.agentSeen ||
      !(live.agentHere || (discoveredAgent && discoveryStillOwnsVisit))
    )
      return;
    const next = { ...record, agentSeen: true };
    setRecord(next);
    writeHintsRecord(window.localStorage, next);
  }, [loaded, live.agentHere, discoveredAgent, currentDiscovery, record]);

  const agentEverConnected =
    record.agentSeen || live.agentHere || discoveredAgent;
  const agentAbsenceKnown =
    currentDiscovery?.collaborators != null &&
    currentDiscovery.tokenUsed !== null &&
    !discoveredAgent;
  const collaborators = agentAbsenceKnown
    ? Math.max(live.people, currentDiscovery.collaborators?.collaborators ?? 0)
    : 0;
  const due = active
    ? dueHint(
        { collaborators, agentEverConnected, commentThreads: live.threads },
        record.dismissed,
      )
    : null;

  // A hint that appeared is pinned until the user acts on it, even if its gate turns false again
  // or another hint becomes due.
  const [pinned, setPinned] = useState<PinnedHint | null>(null);
  useEffect(() => {
    if ((!pinned || pinned.key !== discoveryKey) && due)
      setPinned({ key: discoveryKey, id: due });
  }, [discoveryKey, due, pinned]);
  const shown =
    pinned?.key === discoveryKey &&
    !record.dismissed.includes(pinned.id) &&
    active
      ? pinned.id
      : null;

  if (!shown || !pinned) return null;
  return (
    <PublishedHintBar
      session={session}
      documentId={documentId}
      discoveryKey={discoveryKey}
      role={live.role}
      canEdit={live.canEdit}
      shown={shown}
      record={record}
      pinned={pinned}
      actions={actions}
      onShare={onShare}
      onComment={onComment}
      discovery={
        shown === "collab-agent" && currentDiscovery
          ? currentDiscovery.authority
          : null
      }
      retireDiscovery={retireDiscovery}
      setRecord={setRecord}
      setPinned={setPinned}
    />
  );
}
