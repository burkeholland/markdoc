"use client";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { BookOpen, Bot, Check, ChevronDown, Copy, Globe, Link2, Loader2, Lock, Trash2 } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import type { Role } from "@/server/db/schema";
import { api, apiErrorText, type CollaboratorDto } from "@/lib/api";
import { useCopy } from "@/lib/hooks";
import { COPY_FALLBACK_HINT, copyText } from "@/lib/clipboard";
import { Avatar, Dialog, DialogContent } from "@/components/ui/primitives";
import { CollaboratorLoginInput } from "@/components/editor/collaborator-login-input";
import { TokensPanel } from "@/components/settings/tokens-panel";
import { cn } from "@/lib/utils";

type CollaboratorRole = Exclude<Role, "owner">;

const ROLE_OPTIONS = Object.freeze([
  Object.freeze({ value: "editor" as const, label: "Editor" }),
  Object.freeze({ value: "commenter" as const, label: "Commenter" }),
  Object.freeze({ value: "viewer" as const, label: "Viewer" }),
]);
const LINK_OPTIONS = Object.freeze([
  Object.freeze({ value: "private" as const, label: "Restricted", description: "Only people added above can open this document." }),
  Object.freeze({ value: "view" as const, label: "Anyone with the link can view", description: "Signed-out visitors can read the document." }),
  Object.freeze({ value: "comment" as const, label: "Anyone with the link can comment", description: "Signed-in visitors can comment; others can read." }),
  Object.freeze({ value: "edit" as const, label: "Anyone with the link can edit", description: "Signed-in visitors can edit; others can read." }),
]);
const SHARE_LINK_ROW_CLASS = "mt-2 flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs";
const SHARE_LINK_INPUT_CLASS = "input h-7 min-w-0 flex-1 px-2 font-mono text-[11px]";
const SHARE_LINK_CODE_CLASS = "min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2";
const SHARE_LINK_COPY_CLASS = "btn btn-sm btn-ghost shrink-0 gap-1.5";
const AGENT_CARD_CLASS = "rounded-xl border border-violet-200 bg-violet-50/60 dark:border-violet-900 dark:bg-violet-950/30";
const AGENT_TOGGLE_CLASS = "flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-violet-100/60 dark:hover:bg-violet-900/30";
const AGENT_PANEL_CLASS = "px-3 pb-3";
const COLLABORATOR_LIST_LABEL = "People with access";
const SHARE_REMOVE_PREVENT_SCROLL = Object.freeze({ preventScroll: true });

type CollaboratorOwner = { login: string | null; name: string | null; image: string | null };
type CollaboratorListState =
  | { documentId: string; status: "loading" }
  | { documentId: string; status: "error"; message: string; retrying: boolean }
  | { documentId: string; status: "loaded"; owner: CollaboratorOwner | null; collaborators: CollaboratorDto[] };
type ShareVisit = { documentId: string };
type ShareCopyStatus = "idle" | "copied" | "fallback";
type CollaboratorListRequest = { visit: ShareVisit; request: number; documentId: string };
type AddCollaboratorOperation = {
  visit: ShareVisit;
  request: number;
  documentId: string;
  login: string;
  role: CollaboratorRole;
};
type PermissionContext = { documentId: string };
type PermissionOperation = { context: PermissionContext; documentId: string };
type CollaboratorPermissionOperation = PermissionOperation & { login: string; kind: "role" | "remove" };
type LinkPermissionOperation = PermissionOperation & { kind: "link" };

interface CollaboratorPublication {
  readonly index: number;
  readonly source: CollaboratorDto;
  readonly login: string;
  readonly name: string | null;
  readonly image: string | null;
  readonly createdAt: string;
  readonly role: CollaboratorRole;
  readonly operation: CollaboratorPermissionOperation | null;
  readonly pending: boolean;
}

type CollaboratorListPublication =
  | { readonly status: "none"; readonly source: CollaboratorListState | null }
  | { readonly status: "loading"; readonly source: Extract<CollaboratorListState, { status: "loading" }>; readonly documentId: string }
  | {
      readonly status: "error";
      readonly source: Extract<CollaboratorListState, { status: "error" }>;
      readonly documentId: string;
      readonly message: string;
      readonly retrying: boolean;
    }
  | {
      readonly status: "loaded";
      readonly source: Extract<CollaboratorListState, { status: "loaded" }>;
      readonly documentId: string;
      readonly sourceOwner: CollaboratorOwner | null;
      readonly owner: Readonly<CollaboratorOwner> | null;
      readonly sourceCollaborators: CollaboratorDto[];
      readonly collaborators: readonly CollaboratorPublication[];
    };

interface PermissionOperationPublication {
  readonly source: PermissionOperation;
  readonly context: PermissionContext;
  readonly documentId: string;
}

interface CollaboratorPermissionOperationPublication extends PermissionOperationPublication {
  readonly source: CollaboratorPermissionOperation;
  readonly login: string;
  readonly kind: CollaboratorPermissionOperation["kind"];
}

interface LinkPermissionOperationPublication extends PermissionOperationPublication {
  readonly source: LinkPermissionOperation;
  readonly kind: "link";
}

interface CollaboratorListRequestPublication {
  readonly source: CollaboratorListRequest;
  readonly visit: ShareVisit;
  readonly request: number;
  readonly documentId: string;
}

interface AddCollaboratorOperationPublication extends CollaboratorListRequestPublication {
  readonly source: AddCollaboratorOperation;
  readonly login: string;
  readonly role: CollaboratorRole;
}

interface SharePresentation {
  readonly mount: symbol;
  readonly open: boolean;
  readonly visit: ShareVisit | null;
  readonly permissionContext: PermissionContext | null;
  readonly sourceDocument: DocumentDto;
  readonly document: Readonly<DocumentDto>;
  readonly isOwner: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDocChange: (doc: DocumentDto) => void;
  readonly sourceList: CollaboratorListState | null;
  readonly list: CollaboratorListPublication;
  readonly sourcePermissionOperations: Map<string, CollaboratorPermissionOperation>;
  readonly permissionOperations: readonly CollaboratorPermissionOperationPublication[];
  readonly linkPermissionOwner: LinkPermissionOperationPublication | null;
  readonly linkPermissionOperation: LinkPermissionOperationPublication | null;
  readonly permissionFeedbackOwner: PermissionOperationPublication | null;
  readonly sourceLogin: string;
  readonly login: string;
  readonly newRole: CollaboratorRole;
  readonly busy: boolean;
  readonly addEligible: boolean;
  readonly listPending: CollaboratorListRequestPublication | null;
  readonly addPending: AddCollaboratorOperationPublication | null;
  readonly sourceAddError: { documentId: string; message: string } | null;
  readonly addError: string | null;
  readonly sourceActionError: { operation: PermissionOperation; message: string } | null;
  readonly actionError: string | null;
  readonly linkAccess: DocumentDto["linkAccess"];
  readonly origin: string;
  readonly editorLink: string;
  readonly sourceCopyFeedback: ShareCopyFeedback | null;
  readonly sourceCopyFallback: ShareCopyFallback | null;
  readonly copyStatus: ShareCopyStatus;
  readonly copyFallback: boolean;
  readonly copyLabel: string;
  readonly copyCopied: boolean;
  readonly copyCallback: typeof copyText;
  readonly sourceAgentExpansion: ShareAgentExpansion | null;
  readonly agentExpanded: boolean;
  readonly agentPanelId: string;
  readonly removeCollaborator: ShareRemoveCallbackIdentity;
}

interface CollaboratorRowElements {
  row: HTMLLIElement | null;
  role: HTMLSelectElement | null;
  remove: HTMLButtonElement | null;
}

interface SharePresentationRuntime {
  active: boolean;
  retired: boolean;
  published: boolean;
  predecessor: SharePresentation | null;
  dialog: HTMLDivElement | null;
  overlay: HTMLDivElement | null;
  portalParent: HTMLElement | null;
  close: HTMLButtonElement | null;
  root: HTMLDivElement | null;
  form: HTMLFormElement | null;
  loginControl: HTMLDivElement | null;
  login: HTMLInputElement | null;
  newRole: HTMLSelectElement | null;
  add: HTMLButtonElement | null;
  addError: HTMLDivElement | null;
  actionError: HTMLDivElement | null;
  people: HTMLDivElement | null;
  list: HTMLUListElement | null;
  listState: HTMLLIElement | null;
  retry: HTMLButtonElement | null;
  owner: HTMLLIElement | null;
  empty: HTMLLIElement | null;
  editorLink: HTMLDivElement | null;
  linkValue: HTMLElement | null;
  linkFallback: HTMLInputElement | null;
  linkCopy: HTMLButtonElement | null;
  linkHint: HTMLParagraphElement | null;
  rows: CollaboratorRowElements[];
  general: HTMLDivElement | null;
  linkAccess: HTMLSelectElement | null;
  agent: HTMLDivElement | null;
  agentCard: HTMLElement | null;
  agentToggle: HTMLButtonElement | null;
  agentPanel: HTMLDivElement | null;
  agentDirectionalIntrinsics: ShareDirectionalEventIntrinsics | null;
  agentDirectionalCapture: ShareDirectionalNativeCapture | null;
  agentDirectionalPairs: WeakMap<
    KeyboardEvent,
    ShareDirectionalPair<SharePresentation, ShareAgentDirectionalAction>
  >;
  agentDirectionalFence:
    | ShareDirectionalPair<SharePresentation, ShareAgentDirectionalAction>
    | null;
  removeNavigation: ShareRemoveNavigationPublication | null;
  removeNavigationPairs: WeakMap<KeyboardEvent, ShareRemoveNavigationPair>;
  removeNavigationFence: ShareRemoveNavigationPair | null;
  controlBindings: Set<ShareControlElementRole>;
  footer: HTMLDivElement | null;
  done: HTMLButtonElement | null;
  claims: Set<string>;
  mutated: boolean;
  controlPlacementMutated: boolean;
  observer: MutationObserver | null;
  placementObserver: MutationObserver | null;
  observerRetirement: object | null;
  copyControlMutated: boolean;
  removeCloseCapture: (() => void) | null;
  closeProvenance: ShareCloseProvenance | null;
  closeProvenanceRetirement: { provenance: ShareCloseProvenance; timer: number } | null;
  placement: SharePlacementChain | null;
}

interface SharePresentationLineage {
  current: SharePresentation;
}

type ShareCloseProvenance =
  | { readonly kind: "escape"; readonly event: KeyboardEvent }
  | { readonly kind: "outside" | "close-button"; readonly event: MouseEvent };

interface ShareDirectionalTrustedAuthority {
  readonly read: (event: object) => boolean;
  readonly matches: (event: object) => boolean;
  readonly isCurrent: () => boolean;
}

type ShareRemoveCallback = (
  context: PermissionContext,
  documentId: string,
  login: string,
) => Promise<void>;

interface ShareRemoveCallbackIdentity {
  readonly kind: "remove-collaborator";
}

type ShareRemoveNavigationKey =
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "Home"
  | "End";

type ShareRemoveNativeGetter = (this: object) => unknown;
type ShareRemoveFocus = (this: HTMLElement, options?: FocusOptions) => void;

interface ShareRemoveGetterAuthority<Field extends string> {
  readonly getters: Readonly<Record<Field, ShareRemoveNativeGetter>>;
  readonly isCurrent: () => boolean;
}

interface ShareRemoveMethodAuthority<Method> {
  readonly method: Method;
  readonly isCurrent: () => boolean;
}

interface ShareRemoveWindowMethod<Property extends "addEventListener" | "removeEventListener"> {
  readonly value: Window[Property];
  readonly isCurrent: () => boolean;
}

interface ShareRemoveTerminalProof {
  readonly registration: ShareRemoveTerminalRegistration;
  readonly nativeEvent: KeyboardEvent;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly terminal: EventTarget;
  readonly path: readonly EventTarget[];
}

interface ShareRemoveTerminalRegistration {
  readonly proofFor: (event: KeyboardEvent) => ShareRemoveTerminalProof | null;
  readonly claim: (proof: ShareRemoveTerminalProof) => boolean;
  readonly retains: (proof: ShareRemoveTerminalProof) => boolean;
  readonly release: () => void;
  readonly isCurrent: () => boolean;
}

type ShareRemoveEventField =
  | "type"
  | "target"
  | "currentTarget"
  | "eventPhase"
  | "bubbles"
  | "cancelable"
  | "defaultPrevented"
  | "cancelBubble"
  | "composed";

type ShareRemoveKeyField =
  | "key"
  | "code"
  | "location"
  | "repeat"
  | "isComposing"
  | "ctrlKey"
  | "altKey"
  | "metaKey"
  | "shiftKey";

interface ShareRemoveKeyboardAuthority {
  readonly presentation: SharePresentation;
  readonly list: HTMLUListElement;
  readonly document: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly Event: typeof Event;
  readonly UIEvent: typeof UIEvent;
  readonly KeyboardEvent: typeof KeyboardEvent;
  readonly Document: typeof Document;
  readonly HTMLElement: typeof HTMLElement;
  readonly event: ShareRemoveGetterAuthority<ShareRemoveEventField>["getters"];
  readonly keyboard: ShareRemoveGetterAuthority<ShareRemoveKeyField>["getters"];
  readonly view: ShareRemoveNativeGetter;
  readonly detail: ShareRemoveNativeGetter;
  readonly activeElement: ShareRemoveNativeGetter;
  readonly composedPath: Event["composedPath"];
  readonly focus: ShareRemoveFocus;
  readonly trusted: ShareDirectionalTrustedAuthority;
  readonly terminal: ShareRemoveTerminalRegistration;
  readonly apply: typeof Reflect.apply;
  readonly prototypeOf: typeof Object.getPrototypeOf;
  readonly isCurrent: () => boolean;
}

interface ShareRemoveControlPublication {
  readonly presentation: SharePresentation;
  readonly visit: ShareVisit;
  readonly permissionContext: PermissionContext;
  readonly list: CollaboratorListPublication;
  readonly row: CollaboratorPublication;
  readonly element: HTMLButtonElement;
  readonly callback: ShareRemoveCallbackIdentity;
  readonly order: number;
}

interface ShareRemoveNavigationPublication {
  readonly presentation: SharePresentation;
  readonly visit: ShareVisit;
  readonly permissionContext: PermissionContext;
  readonly sourceList: CollaboratorListState;
  readonly list: CollaboratorListPublication;
  readonly listElement: HTMLUListElement;
  readonly controls: readonly ShareRemoveControlPublication[];
  readonly authority: ShareRemoveKeyboardAuthority;
  readonly retire: () => void;
  readonly isRetired: () => boolean;
}

interface ShareRemoveNativeSnapshot {
  readonly event: KeyboardEvent;
  readonly type: string;
  readonly target: HTMLElement;
  readonly currentTarget: EventTarget;
  readonly phase: number;
  readonly path: readonly EventTarget[];
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly cancelBubble: boolean;
  readonly composed: boolean;
  readonly key: ShareRemoveNavigationKey;
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
  readonly terminal: ShareRemoveTerminalProof;
}

interface ShareRemoveReactMethods {
  readonly preventDefault: ReactKeyboardEvent<HTMLElement>["preventDefault"];
  readonly isDefaultPrevented: ReactKeyboardEvent<HTMLElement>["isDefaultPrevented"];
  readonly isPropagationStopped: ReactKeyboardEvent<HTMLElement>["isPropagationStopped"];
}

interface ShareRemoveReactSnapshot {
  readonly event: ReactKeyboardEvent<HTMLElement>;
  readonly nativeEvent: KeyboardEvent;
  readonly target: HTMLElement;
  readonly currentTarget: HTMLElement;
  readonly phase: number;
  readonly view: ReactKeyboardEvent<HTMLElement>["view"];
  readonly composing: boolean | null;
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly isTrusted: boolean;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly locale: string;
  readonly charCode: number;
  readonly keyCode: number;
  readonly which: number;
  readonly detail: number;
  readonly timeStamp: number;
  readonly repeat: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly methods: ShareRemoveReactMethods;
}

interface ShareRemoveNavigationPair {
  readonly publication: ShareRemoveNavigationPublication;
  readonly authority: ShareRemoveKeyboardAuthority;
  readonly native: ShareRemoveNativeSnapshot;
  readonly capture: ShareRemoveReactSnapshot;
  readonly terminal: ShareRemoveTerminalProof;
  readonly source: ShareRemoveControlPublication;
  readonly destination: ShareRemoveControlPublication;
  readonly key: ShareRemoveNavigationKey;
  readonly movement: object;
  readonly publicationClaim: object;
  readonly visitClaim: object;
  readonly sourceClaim: object;
  readonly destinationClaim: object;
  readonly wrapperClaim: object;
  readonly nativeClaim: object;
  readonly windowClaim: object;
}

interface ShareRemoveNavigationDelivery {
  readonly pair: ShareRemoveNavigationPair;
  readonly bubble: ShareRemoveReactSnapshot;
}

interface ShareDirectionalEventIntrinsics {
  readonly keyboardPrototype: object;
  readonly capturingPhase: number;
  readonly bubblingPhase: number;
  readonly getPrototypeOf: typeof Object.getPrototypeOf;
  readonly apply: typeof Reflect.apply;
  readonly trusted: ShareDirectionalTrustedAuthority;
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
}

interface ShareDirectionalNativeSnapshot {
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

type ShareDirectionalReactEvent = ReactKeyboardEvent<HTMLButtonElement> & {
  readonly isComposing?: unknown;
};

type ShareDirectionalReactMethod = (...args: never[]) => unknown;

interface ShareDirectionalReactMethods {
  readonly preventDefault: ShareDirectionalReactMethod;
  readonly isDefaultPrevented: ShareDirectionalReactMethod;
  readonly isPropagationStopped: ShareDirectionalReactMethod;
}

interface ShareDirectionalReactSnapshot {
  readonly event: ReactKeyboardEvent<HTMLButtonElement>;
  readonly nativeEvent: Event;
  readonly target: EventTarget;
  readonly currentTarget: HTMLButtonElement;
  readonly eventPhase: number;
  readonly view: ReactKeyboardEvent<HTMLButtonElement>["view"];
  readonly composing: boolean | null;
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly isTrusted: boolean;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly locale: string;
  readonly charCode: number;
  readonly keyCode: number;
  readonly which: number;
  readonly detail: number;
  readonly timeStamp: number;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly methods: ShareDirectionalReactMethods;
}

interface ShareDirectionalNativeStage {
  readonly registration: ShareDirectionalNativeCapture;
  readonly nativeEvent: KeyboardEvent;
  readonly receiver: EventTarget;
  readonly snapshot: ShareDirectionalNativeSnapshot;
}

interface ShareDirectionalNativeCapture {
  readonly proofFor: (event: KeyboardEvent) => ShareDirectionalNativeStage | null;
  readonly claim: (stage: ShareDirectionalNativeStage) => boolean;
  readonly retains: (stage: ShareDirectionalNativeStage) => boolean;
  readonly release: () => void;
  readonly isCurrent: () => boolean;
}

interface ShareDirectionalPair<Publication extends object, Action extends object> {
  readonly publication: Publication;
  readonly action: Action;
  readonly nativeEvent: KeyboardEvent;
  readonly stage: ShareDirectionalNativeStage;
  readonly capture: ShareDirectionalReactSnapshot;
}

interface ShareAgentDirectionalAction {
  readonly presentation: SharePresentation;
  readonly visit: ShareVisit;
  readonly permissionContext: PermissionContext;
  readonly documentId: string;
  readonly origin: string;
  readonly expanded: boolean;
  readonly nextExpanded: boolean;
  readonly card: HTMLElement;
  readonly control: HTMLButtonElement;
  readonly panel: HTMLDivElement;
}

interface LocalAgentDirectionalAction {
  readonly publication: LocalAgentCardPublication;
  readonly render: LocalAgentCardRender;
  readonly expanded: boolean;
  readonly nextExpanded: boolean;
  readonly card: HTMLElement;
  readonly control: HTMLButtonElement;
  readonly panel: HTMLDivElement;
}

interface LocalAgentCardRender {
  readonly mount: symbol;
  readonly origin: string;
  readonly open: boolean;
  readonly docId: string;
  readonly onClose: (() => void) | undefined;
  readonly expanded: boolean;
  readonly panelId: string;
}

interface LocalAgentCardPublication {
  readonly render: LocalAgentCardRender;
  readonly card: HTMLElement;
  readonly control: HTMLButtonElement;
  readonly panel: HTMLDivElement;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly placement: SharePlacementChain;
  readonly intrinsics: ShareDirectionalEventIntrinsics;
  directionalCapture: ShareDirectionalNativeCapture | null;
  directionalPairs: WeakMap<
    KeyboardEvent,
    ShareDirectionalPair<LocalAgentCardPublication, LocalAgentDirectionalAction>
  >;
  directionalFence: ShareDirectionalPair<
    LocalAgentCardPublication,
    LocalAgentDirectionalAction
  > | null;
  observer: MutationObserver | null;
  placementObserver: MutationObserver | null;
  active: boolean;
  claimed: boolean;
  mutated: boolean;
  placementMutated: boolean;
}

interface ShareLiveFacts {
  open: boolean;
  doc: DocumentDto;
  isOwner: boolean;
  onOpenChange: (open: boolean) => void;
  onDocChange: (doc: DocumentDto) => void;
  collaboratorList: CollaboratorListState | null;
  collaboratorPermissionOperations: Map<string, CollaboratorPermissionOperation>;
  linkPermissionOperation: LinkPermissionOperation | null;
  login: string;
  role: CollaboratorRole;
  busy: boolean;
  addError: { documentId: string; message: string } | null;
  actionError: { operation: PermissionOperation; message: string } | null;
  listPending: CollaboratorListRequest | null;
  addPending: AddCollaboratorOperation | null;
  permissionFeedbackOwner: PermissionOperation | null;
  origin: string;
  copyFeedback: ShareCopyFeedback | null;
  copyFallback: ShareCopyFallback | null;
  agentExpansion: ShareAgentExpansion | null;
  removeCollaborator: ShareRemoveCallbackIdentity;
}

type ShareDomChange =
  | { kind: "new-role"; value: CollaboratorRole }
  | { kind: "collaborator-role"; row: CollaboratorPublication; value: CollaboratorRole }
  | { kind: "link-access"; value: DocumentDto["linkAccess"] };

interface ShareCopyFeedback {
  readonly visit: ShareVisit;
  readonly value: string;
  readonly status: Exclude<ShareCopyStatus, "idle">;
}

interface ShareCopyFallback {
  readonly visit: ShareVisit;
  readonly value: string;
}

interface ShareCopyAction {
  readonly presentation: SharePresentation;
  readonly visit: ShareVisit;
  readonly value: string;
  readonly callback: typeof copyText;
  readonly control: HTMLButtonElement;
}

interface ShareCopyOperation {
  action: Readonly<ShareCopyAction>;
  phase: "invoking" | "attaching" | "pending";
  handoffConsumed: boolean;
  settled: boolean;
  retired: boolean;
}

interface ShareCopyHandoff {
  readonly operation: ShareCopyOperation;
  readonly predecessor: SharePresentation;
  successor: SharePresentation | null;
}

interface ShareAgentExpansion {
  readonly visit: ShareVisit;
  readonly expanded: boolean;
}

interface SharePlacement {
  readonly node: Node;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

type SharePlacementChain = readonly SharePlacement[];

type ShareControlElementRole =
  | "linkValue"
  | "linkFallback"
  | "linkCopy"
  | "agentCard"
  | "agentToggle"
  | "agentPanel";

function snapshotPermissionOperation(operation: PermissionOperation | null): PermissionOperationPublication | null {
  if (!operation) return null;
  return Object.freeze({
    source: operation,
    context: operation.context,
    documentId: operation.documentId,
  });
}

function snapshotCollaboratorPermissionOperation(operation: CollaboratorPermissionOperation): CollaboratorPermissionOperationPublication {
  return Object.freeze({
    source: operation,
    context: operation.context,
    documentId: operation.documentId,
    login: operation.login,
    kind: operation.kind,
  });
}

function snapshotLinkPermissionOperation(operation: LinkPermissionOperation | null): LinkPermissionOperationPublication | null {
  if (!operation) return null;
  return Object.freeze({
    source: operation,
    context: operation.context,
    documentId: operation.documentId,
    kind: operation.kind,
  });
}

function snapshotListRequest(operation: CollaboratorListRequest | null): CollaboratorListRequestPublication | null {
  if (!operation) return null;
  return Object.freeze({
    source: operation,
    visit: operation.visit,
    request: operation.request,
    documentId: operation.documentId,
  });
}

function snapshotAddOperation(operation: AddCollaboratorOperation | null): AddCollaboratorOperationPublication | null {
  if (!operation) return null;
  return Object.freeze({
    source: operation,
    visit: operation.visit,
    request: operation.request,
    documentId: operation.documentId,
    login: operation.login,
    role: operation.role,
  });
}

function permissionOperationIsCurrent(
  operation: PermissionOperation | null,
  publication: PermissionOperationPublication | null,
): boolean {
  return (
    operation === publication?.source &&
    operation?.context === publication.context &&
    operation?.documentId === publication.documentId
  ) || (operation === null && publication === null);
}

function collaboratorPermissionOperationIsCurrent(
  operation: CollaboratorPermissionOperation,
  publication: CollaboratorPermissionOperationPublication,
): boolean {
  return (
    operation === publication.source &&
    operation.context === publication.context &&
    operation.documentId === publication.documentId &&
    operation.login === publication.login &&
    operation.kind === publication.kind
  );
}

function linkPermissionOperationIsCurrent(
  operation: LinkPermissionOperation | null,
  publication: LinkPermissionOperationPublication | null,
): boolean {
  return (
    operation === publication?.source &&
    operation?.context === publication.context &&
    operation?.documentId === publication.documentId &&
    operation?.kind === publication.kind
  ) || (operation === null && publication === null);
}

function shallowDocumentIsCurrent(source: DocumentDto, publication: Readonly<DocumentDto>): boolean {
  const sourceKeys = Object.keys(source);
  const publicationKeys = Object.keys(publication);
  if (sourceKeys.length !== publicationKeys.length) return false;
  return publicationKeys.every((key) => source[key as keyof DocumentDto] === publication[key as keyof DocumentDto]);
}

function snapshotList(
  source: CollaboratorListState | null,
  documentId: string,
  operations: Map<string, CollaboratorPermissionOperation>,
): CollaboratorListPublication {
  if (!source || source.documentId !== documentId) return Object.freeze({ status: "none", source });
  if (source.status === "loading") {
    return Object.freeze({ status: "loading", source, documentId: source.documentId });
  }
  if (source.status === "error") {
    return Object.freeze({
      status: "error",
      source,
      documentId: source.documentId,
      message: source.message,
      retrying: source.retrying,
    });
  }
  const collaborators = Object.freeze(
    source.collaborators.map((collaborator, index) => {
      const operation = operations.get(collaborator.login) ?? null;
      return Object.freeze({
        index,
        source: collaborator,
        login: collaborator.login,
        name: collaborator.name,
        image: collaborator.image,
        createdAt: collaborator.createdAt,
        role: collaborator.role,
        operation,
        pending: operation?.documentId === documentId,
      });
    }),
  );
  return Object.freeze({
    status: "loaded",
    source,
    documentId: source.documentId,
    sourceOwner: source.owner,
    owner: source.owner
      ? Object.freeze({ login: source.owner.login, name: source.owner.name, image: source.owner.image })
      : null,
    sourceCollaborators: source.collaborators,
    collaborators,
  });
}

function collaboratorListIsCurrent(
  source: CollaboratorListState | null,
  publication: CollaboratorListPublication,
  documentId: string,
  operations: Map<string, CollaboratorPermissionOperation>,
): boolean {
  if (source !== publication.source) return false;
  if (!source || source.documentId !== documentId) return publication.status === "none";
  if (source.status !== publication.status || source.documentId !== publication.documentId) return false;
  if (publication.status === "loading") return true;
  if (publication.status === "error") {
    if (source.status !== "error") return false;
    return source.message === publication.message && source.retrying === publication.retrying;
  }
  if (source.status !== "loaded") return false;
  if (
    source.owner !== publication.sourceOwner ||
    source.collaborators !== publication.sourceCollaborators ||
    source.collaborators.length !== publication.collaborators.length
  ) {
    return false;
  }
  if (source.owner) {
    if (
      !publication.owner ||
      source.owner.login !== publication.owner.login ||
      source.owner.name !== publication.owner.name ||
      source.owner.image !== publication.owner.image
    ) {
      return false;
    }
  } else if (publication.owner) {
    return false;
  }
  return publication.collaborators.every((row, index) => {
    const collaborator = source.collaborators[index];
    const operation = operations.get(row.login) ?? null;
    return (
      collaborator === row.source &&
      collaborator.login === row.login &&
      collaborator.name === row.name &&
      collaborator.image === row.image &&
      collaborator.createdAt === row.createdAt &&
      collaborator.role === row.role &&
      operation === row.operation &&
      (operation?.documentId === documentId) === row.pending
    );
  });
}

function listRequestIsCurrent(
  current: CollaboratorListRequest | null,
  published: CollaboratorListRequestPublication | null,
): boolean {
  return (
    current === published?.source &&
    current?.visit === published.visit &&
    current?.request === published.request &&
    current?.documentId === published.documentId
  ) || (current === null && published === null);
}

function addOperationIsCurrent(
  current: AddCollaboratorOperation | null,
  published: AddCollaboratorOperationPublication | null,
): boolean {
  return (
    current === published?.source &&
    current?.visit === published.visit &&
    current?.request === published.request &&
    current?.documentId === published.documentId &&
    current?.login === published.login &&
    current?.role === published.role
  ) || (current === null && published === null);
}

function isExactNativeClick(event: ReactMouseEvent<HTMLButtonElement>, control: HTMLButtonElement): boolean {
  const ownerWindow = control.ownerDocument.defaultView;
  const target = event.target;
  return (
    event.type === "click" &&
    !event.defaultPrevented &&
    ownerWindow !== null &&
    event.nativeEvent instanceof ownerWindow.MouseEvent &&
    event.nativeEvent.type === "click" &&
    !event.nativeEvent.defaultPrevented &&
    event.currentTarget === control &&
    target instanceof ownerWindow.Node &&
    target === event.nativeEvent.target &&
    control.contains(target)
  );
}

function exactClickPath(ownerDocument: Document, target: Node): readonly EventTarget[] | null {
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
  return path;
}

function isExactTraversedNativeClick(
  event: ReactMouseEvent<HTMLButtonElement>,
  control: HTMLButtonElement,
): boolean {
  try {
    const ownerDocument = control.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !ownerWindow ||
      event.type !== "click" ||
      event.button !== 0 ||
      event.defaultPrevented ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      nativeEvent.defaultPrevented ||
      event.currentTarget !== control ||
      nativeEvent.target !== target ||
      !(target instanceof ownerWindow.Node) ||
      target.ownerDocument !== ownerDocument ||
      !control.contains(target)
    ) {
      return false;
    }
    const expectedPath = exactClickPath(ownerDocument, target);
    const actualPath = nativeEvent.composedPath();
    const actualWindow = actualPath.at(-1);
    const expectedWindow = expectedPath?.at(-1);
    const sameWindow =
      actualWindow === expectedWindow ||
      (
        typeof actualWindow === "object" &&
        actualWindow !== null &&
        "document" in actualWindow &&
        actualWindow.document === ownerDocument &&
        "window" in actualWindow &&
        actualWindow.window === actualWindow
      );
    return Boolean(
      expectedPath &&
      actualPath.length === expectedPath.length &&
      sameWindow &&
      actualPath.slice(0, -1).every((entry, index) => entry === expectedPath[index]),
    );
  } catch {
    return false;
  }
}

function shareDirectionalGetter<This extends object, Value>(
  prototype: object,
  property: string,
): ((this: This) => Value) | null {
  const getter = Object.getOwnPropertyDescriptor(prototype, property)?.get;
  return typeof getter === "function" ? getter as (this: This) => Value : null;
}

function shareDirectionalDescriptorsMatch(
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

function captureShareDirectionalTrustedAuthority(
  ownerWindow: Window & typeof globalThis,
): ShareDirectionalTrustedAuthority | null {
  let probe: KeyboardEvent;
  try {
    probe = new ownerWindow.KeyboardEvent("share-agent-keyboard-intrinsic");
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
    shareDirectionalDescriptorsMatch(
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

function captureShareDirectionalIntrinsics(
  ownerWindow: Window & typeof globalThis,
): ShareDirectionalEventIntrinsics | null {
  const objectConstructor = ownerWindow.Object;
  const getPrototypeOf = objectConstructor.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const eventPrototype = ownerWindow.Event.prototype;
  const keyboardPrototype = ownerWindow.KeyboardEvent.prototype;
  const uiEventPrototype = ownerWindow.UIEvent.prototype;
  const documentPrototype = ownerWindow.Document.prototype;
  const trusted = captureShareDirectionalTrustedAuthority(ownerWindow);
  const type = shareDirectionalGetter<Event, string>(eventPrototype, "type");
  const target = shareDirectionalGetter<Event, EventTarget | null>(eventPrototype, "target");
  const currentTarget = shareDirectionalGetter<Event, EventTarget | null>(eventPrototype, "currentTarget");
  const eventPhase = shareDirectionalGetter<Event, number>(eventPrototype, "eventPhase");
  const bubbles = shareDirectionalGetter<Event, boolean>(eventPrototype, "bubbles");
  const cancelable = shareDirectionalGetter<Event, boolean>(eventPrototype, "cancelable");
  const defaultPrevented = shareDirectionalGetter<Event, boolean>(eventPrototype, "defaultPrevented");
  const cancelBubble = shareDirectionalGetter<Event, boolean>(eventPrototype, "cancelBubble");
  const key = shareDirectionalGetter<KeyboardEvent, string>(keyboardPrototype, "key");
  const code = shareDirectionalGetter<KeyboardEvent, string>(keyboardPrototype, "code");
  const location = shareDirectionalGetter<KeyboardEvent, number>(keyboardPrototype, "location");
  const altKey = shareDirectionalGetter<KeyboardEvent, boolean>(keyboardPrototype, "altKey");
  const ctrlKey = shareDirectionalGetter<KeyboardEvent, boolean>(keyboardPrototype, "ctrlKey");
  const metaKey = shareDirectionalGetter<KeyboardEvent, boolean>(keyboardPrototype, "metaKey");
  const shiftKey = shareDirectionalGetter<KeyboardEvent, boolean>(keyboardPrototype, "shiftKey");
  const repeat = shareDirectionalGetter<KeyboardEvent, boolean>(keyboardPrototype, "repeat");
  const isComposing = shareDirectionalGetter<KeyboardEvent, boolean>(keyboardPrototype, "isComposing");
  const view = shareDirectionalGetter<UIEvent, Window | null>(uiEventPrototype, "view");
  const activeElement = shareDirectionalGetter<Document, Element | null>(documentPrototype, "activeElement");
  const composedPath = eventPrototype.composedPath;
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
    typeof composedPath !== "function"
  ) {
    return null;
  }
  return Object.freeze({
    keyboardPrototype,
    capturingPhase: ownerWindow.Event.CAPTURING_PHASE,
    bubblingPhase: ownerWindow.Event.BUBBLING_PHASE,
    getPrototypeOf,
    apply,
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
  });
}

function readShareDirectionalNativeEvent(
  event: Event,
  intrinsics: ShareDirectionalEventIntrinsics,
): ShareDirectionalNativeSnapshot | null {
  try {
    if (
      intrinsics.getPrototypeOf(event) !== intrinsics.keyboardPrototype ||
      !intrinsics.trusted.isCurrent() ||
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

function shareDirectionalPathMatches(
  path: readonly EventTarget[],
  source: HTMLButtonElement,
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
  return (
    expected.at(-1) === ownerDocument &&
    path.length === expected.length + 1 &&
    expected.every((entry, index) => path[index] === entry) &&
    path.at(-1) === terminal
  );
}

function shareDirectionalDestination(key: string, expanded: boolean): boolean | null {
  if (key === "ArrowRight" && !expanded) return true;
  if (key === "ArrowLeft" && expanded) return false;
  return null;
}

function captureShareDirectionalReactEvent(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  nativeEvent: Event,
  snapshot: ShareDirectionalNativeSnapshot,
  control: HTMLButtonElement,
  ownerDocument: Document,
  ownerWindow: Window & typeof globalThis,
  intrinsics: ShareDirectionalEventIntrinsics,
  expectedPhase: number,
): ShareDirectionalReactSnapshot | null {
  try {
    const proof = event as ShareDirectionalReactEvent;
    const preventDefault = event.preventDefault;
    const isDefaultPrevented = event.isDefaultPrevented;
    const isPropagationStopped = event.isPropagationStopped;
    if (
      typeof preventDefault !== "function" ||
      typeof isDefaultPrevented !== "function" ||
      typeof isPropagationStopped !== "function"
    ) {
      return null;
    }
    const methods: ShareDirectionalReactMethods = Object.freeze({
      preventDefault,
      isDefaultPrevented,
      isPropagationStopped,
    });
    const composing = proof.isComposing === undefined
      ? null
      : proof.isComposing;
    if (composing !== null && typeof composing !== "boolean") return null;
    const reactSnapshot: ShareDirectionalReactSnapshot = Object.freeze({
      event,
      nativeEvent,
      target: event.target,
      currentTarget: event.currentTarget,
      eventPhase: event.eventPhase,
      view: event.view,
      composing,
      type: event.type,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      defaultPrevented: event.defaultPrevented,
      isTrusted: event.isTrusted,
      key: event.key,
      code: event.code,
      location: event.location,
      locale: event.locale,
      charCode: event.charCode,
      keyCode: event.keyCode,
      which: event.which,
      detail: event.detail,
      timeStamp: event.timeStamp,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      methods,
    });
    return shareDirectionalReactSnapshotIsCurrent(
      reactSnapshot,
      nativeEvent,
      snapshot,
      control,
      ownerDocument,
      ownerWindow,
      intrinsics,
      expectedPhase,
      control,
      false,
      isDefaultPrevented,
    )
      ? reactSnapshot
      : null;
  } catch {
    return null;
  }
}

function shareDirectionalReactSnapshotIsCurrent(
  react: ShareDirectionalReactSnapshot,
  nativeEvent: Event,
  snapshot: ShareDirectionalNativeSnapshot,
  control: HTMLButtonElement,
  ownerDocument: Document,
  ownerWindow: Window & typeof globalThis,
  intrinsics: ShareDirectionalEventIntrinsics,
  expectedPhase: number,
  liveCurrentTarget: HTMLButtonElement | null,
  expectedDefaultPrevented: boolean,
  currentDefaultQuery: ShareDirectionalReactMethod,
): boolean {
  try {
    const event = react.event as ShareDirectionalReactEvent;
    const composing = event.isComposing === undefined
      ? null
      : event.isComposing;
    const terminal = snapshot.path.at(-1);
    return (
      react.nativeEvent === nativeEvent &&
      react.target === control &&
      react.currentTarget === control &&
      react.eventPhase === expectedPhase &&
      react.type === "keydown" &&
      react.type === snapshot.type &&
      react.bubbles === snapshot.bubbles &&
      react.cancelable === snapshot.cancelable &&
      !react.defaultPrevented &&
      react.isTrusted === snapshot.isTrusted &&
      (react.view === null ||
        Object.is(react.view, ownerWindow) ||
        Object.is(react.view, terminal)) &&
      react.key === snapshot.key &&
      react.code === snapshot.code &&
      react.location === snapshot.location &&
      react.altKey === snapshot.altKey &&
      react.ctrlKey === snapshot.ctrlKey &&
      react.metaKey === snapshot.metaKey &&
      react.shiftKey === snapshot.shiftKey &&
      react.repeat === snapshot.repeat &&
      react.composing === composing &&
      (composing === null || composing === snapshot.isComposing) &&
      event.type === react.type &&
      event.nativeEvent === react.nativeEvent &&
      event.target === react.target &&
      event.currentTarget === liveCurrentTarget &&
      event.eventPhase === react.eventPhase &&
      event.bubbles === react.bubbles &&
      event.cancelable === react.cancelable &&
      event.defaultPrevented === expectedDefaultPrevented &&
      event.isTrusted === react.isTrusted &&
      event.view === react.view &&
      event.key === react.key &&
      event.code === react.code &&
      event.location === react.location &&
      event.locale === react.locale &&
      event.charCode === react.charCode &&
      event.keyCode === react.keyCode &&
      event.which === react.which &&
      event.detail === react.detail &&
      event.timeStamp === react.timeStamp &&
      event.altKey === react.altKey &&
      event.ctrlKey === react.ctrlKey &&
      event.metaKey === react.metaKey &&
      event.shiftKey === react.shiftKey &&
      event.repeat === react.repeat &&
      event.preventDefault === react.methods.preventDefault &&
      event.isDefaultPrevented === currentDefaultQuery &&
      event.isPropagationStopped === react.methods.isPropagationStopped &&
      snapshot.type === "keydown" &&
      snapshot.target === control &&
      snapshot.currentTarget !== null &&
      snapshot.eventPhase === expectedPhase &&
      snapshot.bubbles &&
      snapshot.cancelable &&
      snapshot.defaultPrevented === expectedDefaultPrevented &&
      !snapshot.cancelBubble &&
      snapshot.isTrusted &&
      !snapshot.altKey &&
      !snapshot.ctrlKey &&
      !snapshot.metaKey &&
      !snapshot.shiftKey &&
      !snapshot.repeat &&
      !snapshot.isComposing &&
      (snapshot.view === null ||
        snapshot.view === ownerWindow ||
        snapshot.view === terminal) &&
      snapshot.path.includes(snapshot.currentTarget) &&
      terminal !== undefined &&
      shareDirectionalPathMatches(
        snapshot.path,
        control,
        ownerDocument,
        terminal,
      ) &&
      intrinsics.apply(intrinsics.activeElement, ownerDocument, []) === control
    );
  } catch {
    return false;
  }
}

function queryShareDirectionalReactMethod(
  snapshot: ShareDirectionalReactSnapshot,
  method: ShareDirectionalReactMethod,
  expected: boolean,
  intrinsics: ShareDirectionalEventIntrinsics,
  revalidate: () => boolean,
): boolean {
  try {
    const result = intrinsics.apply(method, snapshot.event, []);
    return result === expected && revalidate();
  } catch {
    return false;
  }
}

function callShareDirectionalReactMethod(
  snapshot: ShareDirectionalReactSnapshot,
  method: ShareDirectionalReactMethod,
  intrinsics: ShareDirectionalEventIntrinsics,
  revalidate: () => boolean,
): boolean {
  try {
    intrinsics.apply(method, snapshot.event, []);
    return revalidate();
  } catch {
    return false;
  }
}

function shareDirectionalNativeSnapshotsMatch(
  first: ShareDirectionalNativeSnapshot,
  second: ShareDirectionalNativeSnapshot,
  expectedSecondDefaultPrevented = first.defaultPrevented,
): boolean {
  return (
    first.type === second.type &&
    first.target === second.target &&
    first.bubbles === second.bubbles &&
    first.cancelable === second.cancelable &&
    !first.defaultPrevented &&
    second.defaultPrevented === expectedSecondDefaultPrevented &&
    first.cancelBubble === second.cancelBubble &&
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
    first.view === second.view &&
    first.path.length === second.path.length &&
    first.path.every((entry, index) => entry === second.path[index])
  );
}

function captureShareDirectionalNativeStage(
  registration: ShareDirectionalNativeCapture,
  nativeEvent: KeyboardEvent,
  receiver: EventTarget,
  snapshot: ShareDirectionalNativeSnapshot,
  control: HTMLButtonElement,
  ownerDocument: Document,
  ownerWindow: Window & typeof globalThis,
  intrinsics: ShareDirectionalEventIntrinsics,
): ShareDirectionalNativeStage | null {
  const terminal = snapshot.path.at(-1);
  return (
    terminal !== undefined &&
    ownerDocument.defaultView === ownerWindow &&
    receiver === snapshot.currentTarget &&
    terminal === receiver &&
    snapshot.eventPhase === intrinsics.capturingPhase &&
    snapshot.target === control &&
    shareDirectionalPathMatches(
      snapshot.path,
      control,
      ownerDocument,
      terminal,
    )
  )
    ? Object.freeze({ registration, nativeEvent, receiver, snapshot })
    : null;
}

function shareDirectionalStageMatches(
  stage: ShareDirectionalNativeStage,
  registration: ShareDirectionalNativeCapture,
  nativeEvent: KeyboardEvent,
  snapshot: ShareDirectionalNativeSnapshot,
  control: HTMLButtonElement,
  ownerDocument: Document,
  ownerWindow: Window & typeof globalThis,
  intrinsics: ShareDirectionalEventIntrinsics,
): boolean {
  const terminal = stage.snapshot.path.at(-1);
  return (
    terminal !== undefined &&
    stage.registration === registration &&
    stage.nativeEvent === nativeEvent &&
    ownerDocument.defaultView === ownerWindow &&
    stage.receiver === stage.snapshot.currentTarget &&
    terminal === stage.receiver &&
    stage.snapshot.eventPhase === intrinsics.capturingPhase &&
    stage.snapshot.target === control &&
    shareDirectionalPathMatches(
      stage.snapshot.path,
      control,
      ownerDocument,
      terminal,
    ) &&
    snapshot.path.at(-1) === terminal &&
    shareDirectionalNativeSnapshotsMatch(
      stage.snapshot,
      snapshot,
      snapshot.defaultPrevented,
    )
  );
}

function installShareDirectionalNativeCapture(
  control: HTMLButtonElement,
  intrinsics: ShareDirectionalEventIntrinsics,
  eligible: () => boolean,
): ShareDirectionalNativeCapture | null {
  const ownerDocument = control.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) return null;
  const ownerRealm = ownerWindow;
  const addEventListener = ownerRealm.addEventListener;
  const removeEventListener = ownerRealm.removeEventListener;
  let stages: WeakMap<KeyboardEvent, ShareDirectionalNativeStage> | null =
    new WeakMap();
  let invalidEvents: WeakSet<KeyboardEvent> | null = new WeakSet();
  const claimedEvents = new WeakSet<KeyboardEvent>();
  let active = true;
  let released = false;
  const registrationAuthorityIsCurrent = () =>
    ownerDocument.defaultView === ownerRealm &&
    ownerRealm.addEventListener === addEventListener &&
    ownerRealm.removeEventListener === removeEventListener &&
    intrinsics.trusted.isCurrent();

  function rememberAgentDirectionalNative(
    this: EventTarget,
    nativeEvent: Event,
  ) {
    if (
      !active ||
      released ||
      !stages ||
      !invalidEvents ||
      !eligible() ||
      intrinsics.getPrototypeOf(nativeEvent) !== intrinsics.keyboardPrototype
    ) {
      return;
    }
    const keyboardEvent = nativeEvent as KeyboardEvent;
    if (stages.has(keyboardEvent)) {
      invalidEvents.add(keyboardEvent);
      return;
    }
    const snapshot = readShareDirectionalNativeEvent(nativeEvent, intrinsics);
    const stage = snapshot
      ? captureShareDirectionalNativeStage(
          registration,
          keyboardEvent,
          this,
          snapshot,
          control,
          ownerDocument,
          ownerRealm,
          intrinsics,
        )
      : null;
    if (!stage || !eligible()) {
      invalidEvents.add(keyboardEvent);
      return;
    }
    stages.set(keyboardEvent, stage);
  }

  const stageRemains = (stage: ShareDirectionalNativeStage) => {
    if (
      !active ||
      released ||
      !stages ||
      !invalidEvents ||
      stages.get(stage.nativeEvent) !== stage ||
      invalidEvents.has(stage.nativeEvent) ||
      stage.registration !== registration ||
      !registrationAuthorityIsCurrent()
    ) {
      return false;
    }
    const snapshot = readShareDirectionalNativeEvent(stage.nativeEvent, intrinsics);
    return Boolean(
      snapshot &&
      shareDirectionalStageMatches(
        stage,
        registration,
        stage.nativeEvent,
        snapshot,
        control,
        ownerDocument,
        ownerRealm,
        intrinsics,
      ),
    );
  };

  const registration: ShareDirectionalNativeCapture = Object.freeze({
    proofFor: (event: KeyboardEvent) => {
      const stage = stages?.get(event);
      return stage && !claimedEvents.has(event) && stageRemains(stage)
        ? stage
        : null;
    },
    claim: (stage: ShareDirectionalNativeStage) => {
      if (
        claimedEvents.has(stage.nativeEvent) ||
        registration.proofFor(stage.nativeEvent) !== stage
      ) {
        return false;
      }
      claimedEvents.add(stage.nativeEvent);
      return true;
    },
    retains: stageRemains,
    release: () => {
      if (released) return;
      released = true;
      active = false;
      stages = null;
      invalidEvents = null;
      try {
        intrinsics.apply(removeEventListener, ownerRealm, [
          "keydown",
          rememberAgentDirectionalNative,
          true,
        ]);
      } catch {
        // Cleanup cannot replace the captured owner-Window method.
      }
    },
    isCurrent: () =>
      active &&
      !released &&
      registrationAuthorityIsCurrent(),
  });

  try {
    intrinsics.apply(addEventListener, ownerRealm, [
      "keydown",
      rememberAgentDirectionalNative,
      true,
    ]);
  } catch {
    active = false;
    released = true;
    stages = null;
    invalidEvents = null;
    return null;
  }
  if (registration.isCurrent()) return registration;
  registration.release();
  return null;
}

function captureShareRemoveGetters<const Fields extends readonly string[]>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  prototype: object,
  fields: Fields,
): ShareRemoveGetterAuthority<Fields[number]> | null {
  const entries: [Fields[number], ShareRemoveNativeGetter][] = [];
  const descriptors: [Fields[number], Readonly<PropertyDescriptor>][] = [];
  for (const field of fields) {
    const descriptor = getOwnPropertyDescriptor(prototype, field);
    if (!descriptor || typeof descriptor.get !== "function") return null;
    entries.push([field, descriptor.get as ShareRemoveNativeGetter]);
    descriptors.push([field, Object.freeze({ ...descriptor })]);
  }
  const getters = Object.freeze(
    Object.fromEntries(entries),
  ) as Readonly<Record<Fields[number], ShareRemoveNativeGetter>>;
  return Object.freeze({
    getters,
    isCurrent: () =>
      descriptors.every(([field, descriptor]) =>
        shareDirectionalDescriptorsMatch(
          getOwnPropertyDescriptor(prototype, field),
          descriptor,
        )),
  });
}

function captureShareRemoveMethod<Method>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  prototype: object,
  property: PropertyKey,
): ShareRemoveMethodAuthority<Method> | null {
  const descriptor = getOwnPropertyDescriptor(prototype, property);
  if (!descriptor || typeof descriptor.value !== "function") return null;
  const expected = Object.freeze({ ...descriptor });
  return Object.freeze({
    method: descriptor.value as Method,
    isCurrent: () =>
      shareDirectionalDescriptorsMatch(
        getOwnPropertyDescriptor(prototype, property),
        expected,
      ),
  });
}

function captureShareRemoveWindowMethod<
  Property extends "addEventListener" | "removeEventListener",
>(
  ownerWindow: Window & typeof globalThis,
  property: Property,
): ShareRemoveWindowMethod<Property> | null {
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
    path.push(Object.freeze({
      target,
      descriptor: descriptor ? Object.freeze({ ...descriptor }) : null,
      prototype,
    }));
    if (descriptor) {
      found = true;
      break;
    }
    target = prototype;
  }
  const value = reflectGet(ownerWindow, property, ownerWindow) as Window[Property];
  const isCurrent = () =>
    ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
    ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
    ownerWindow.Reflect.get === reflectGet &&
    path.every(({ target: entry, descriptor, prototype }) =>
      getPrototypeOf(entry) === prototype &&
      (descriptor
        ? shareDirectionalDescriptorsMatch(
            getOwnPropertyDescriptor(entry, property),
            descriptor,
          )
        : getOwnPropertyDescriptor(entry, property) === undefined)) &&
    reflectGet(ownerWindow, property, ownerWindow) === value;
  return found && typeof value === "function" && isCurrent()
    ? Object.freeze({ value, isCurrent })
    : null;
}

function createShareRemoveTerminalRegistration(
  ownerWindow: Window & typeof globalThis,
  ownerDocument: Document,
  KeyboardEventConstructor: typeof KeyboardEvent,
  keyboardEventPrototype: object,
  eventCurrentTarget: ShareRemoveNativeGetter,
  eventPhase: ShareRemoveNativeGetter,
  composedPath: Event["composedPath"],
  addEventListener: ShareRemoveWindowMethod<"addEventListener">,
  removeEventListener: ShareRemoveWindowMethod<"removeEventListener">,
  apply: typeof Reflect.apply,
  prototypeOf: typeof Object.getPrototypeOf,
  intrinsicsAreCurrent: () => boolean,
): ShareRemoveTerminalRegistration | null {
  const proofs = new WeakMap<KeyboardEvent, ShareRemoveTerminalProof>();
  const invalidEvents = new WeakSet<Event>();
  const claimedEvents = new WeakSet<Event>();
  let active = false;
  let released = false;

  const listener: EventListener = function rememberShareRemoveNative(
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
        phase !== ownerWindow.Event.CAPTURING_PHASE ||
        path.at(-2) !== ownerDocument
      ) {
        invalidEvents.add(event);
        return;
      }
      proofs.set(event, Object.freeze({
        registration,
        nativeEvent: event,
        receiver: this,
        currentTarget,
        terminal,
        path: Object.freeze([...path]),
      }));
    } catch {
      invalidEvents.add(event);
    }
  };

  const proofRemains = (proof: ShareRemoveTerminalProof) => {
    if (
      proofs.get(proof.nativeEvent) !== proof ||
      !active ||
      released ||
      invalidEvents.has(proof.nativeEvent) ||
      proof.registration !== registration ||
      proof.receiver !== proof.currentTarget ||
      proof.receiver !== proof.terminal ||
      !intrinsicsAreCurrent()
    ) {
      return false;
    }
    try {
      const path = apply(composedPath, proof.nativeEvent, []) as EventTarget[];
      return (
        path.length === proof.path.length &&
        path.every((entry, index) => entry === proof.path[index]) &&
        path.at(-2) === ownerDocument &&
        path.at(-1) === proof.receiver
      );
    } catch {
      invalidEvents.add(proof.nativeEvent);
      return false;
    }
  };

  const proofFor = (event: KeyboardEvent) => {
    const proof = proofs.get(event);
    return proof && !claimedEvents.has(event) && proofRemains(proof)
      ? proof
      : null;
  };

  const registration: ShareRemoveTerminalRegistration = Object.freeze({
    proofFor,
    claim: (proof: ShareRemoveTerminalProof) => {
      if (
        claimedEvents.has(proof.nativeEvent) ||
        proofFor(proof.nativeEvent) !== proof
      ) {
        return false;
      }
      claimedEvents.add(proof.nativeEvent);
      return true;
    },
    retains: proofRemains,
    release: () => {
      if (released) return;
      released = true;
      active = false;
      try {
        apply(removeEventListener.value, ownerWindow, [
          "keydown",
          listener,
          true,
        ]);
      } catch {
        // Cleanup cannot replace the retained owner-Window registration method.
      }
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
    apply(addEventListener.value, ownerWindow, ["keydown", listener, true]);
    if (registration.isCurrent()) return registration;
    registration.release();
    return null;
  } catch {
    active = false;
    released = true;
    return null;
  }
}

function captureShareRemoveKeyboardAuthority(
  presentation: SharePresentation,
  list: HTMLUListElement,
): ShareRemoveKeyboardAuthority | null {
  const document = list.ownerDocument;
  const ownerWindow = document.defaultView as
    | (Window & typeof globalThis)
    | null;
  if (!ownerWindow || !list.isConnected) return null;
  const objectConstructor = ownerWindow.Object;
  const getOwnPropertyDescriptor = objectConstructor.getOwnPropertyDescriptor;
  const prototypeOf = objectConstructor.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const EventConstructor = ownerWindow.Event;
  const UIEventConstructor = ownerWindow.UIEvent;
  const KeyboardEventConstructor = ownerWindow.KeyboardEvent;
  const DocumentConstructor = ownerWindow.Document;
  const HTMLElementConstructor = ownerWindow.HTMLElement;
  const eventPrototype = EventConstructor.prototype;
  const uiEventPrototype = UIEventConstructor.prototype;
  const keyboardEventPrototype = KeyboardEventConstructor.prototype;
  const documentPrototype = DocumentConstructor.prototype;
  const htmlElementPrototype = HTMLElementConstructor.prototype;
  const eventGetters = captureShareRemoveGetters(
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
  const keyboardGetters = captureShareRemoveGetters(
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
  const uiGetters = captureShareRemoveGetters(
    getOwnPropertyDescriptor,
    uiEventPrototype,
    ["view", "detail"] as const,
  );
  const documentGetters = captureShareRemoveGetters(
    getOwnPropertyDescriptor,
    documentPrototype,
    ["activeElement"] as const,
  );
  const composedPath = captureShareRemoveMethod<Event["composedPath"]>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "composedPath",
  );
  const focus = captureShareRemoveMethod<ShareRemoveFocus>(
    getOwnPropertyDescriptor,
    htmlElementPrototype,
    "focus",
  );
  const addEventListener = captureShareRemoveWindowMethod(
    ownerWindow,
    "addEventListener",
  );
  const removeEventListener = captureShareRemoveWindowMethod(
    ownerWindow,
    "removeEventListener",
  );
  const trusted = captureShareDirectionalTrustedAuthority(ownerWindow);
  if (
    !eventGetters ||
    !keyboardGetters ||
    !uiGetters ||
    !documentGetters ||
    !composedPath ||
    !focus ||
    !addEventListener ||
    !removeEventListener ||
    !trusted
  ) {
    return null;
  }
  let probe: KeyboardEvent;
  try {
    probe = new KeyboardEventConstructor("share-remove-keyboard-intrinsic");
  } catch {
    return null;
  }
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
        EventConstructor.prototype === eventPrototype &&
        UIEventConstructor.prototype === uiEventPrototype &&
        KeyboardEventConstructor.prototype === keyboardEventPrototype &&
        DocumentConstructor.prototype === documentPrototype &&
        HTMLElementConstructor.prototype === htmlElementPrototype &&
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
    if (!intrinsicsAreCurrent() || trusted.read(probe) !== false) return null;
  } catch {
    return null;
  }
  const terminal = createShareRemoveTerminalRegistration(
    ownerWindow,
    document,
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
    presentation,
    list,
    document,
    ownerWindow,
    Event: EventConstructor,
    UIEvent: UIEventConstructor,
    KeyboardEvent: KeyboardEventConstructor,
    Document: DocumentConstructor,
    HTMLElement: HTMLElementConstructor,
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

function shareRemoveNativeValue<Value>(
  authority: ShareRemoveKeyboardAuthority,
  getter: ShareRemoveNativeGetter,
  target: object,
): Value {
  return authority.apply(getter, target, []) as Value;
}

function shareRemoveNavigationKey(
  key: string,
): ShareRemoveNavigationKey | null {
  return (
    key === "ArrowLeft" ||
    key === "ArrowUp" ||
    key === "ArrowRight" ||
    key === "ArrowDown" ||
    key === "Home" ||
    key === "End"
  )
    ? key
    : null;
}

function shareRemovePathMatches(
  path: readonly EventTarget[],
  source: HTMLButtonElement,
  ownerDocument: Document,
  terminal: EventTarget,
) {
  const expected: EventTarget[] = [];
  let current: Node | null = source;
  while (current) {
    expected.push(current);
    if (current === ownerDocument) break;
    current = current.parentNode;
  }
  return (
    expected.at(-1) === ownerDocument &&
    path.length === expected.length + 1 &&
    expected.every((entry, index) => path[index] === entry) &&
    path.at(-1) === terminal
  );
}

function captureShareRemoveNativeEvent(
  authority: ShareRemoveKeyboardAuthority,
  nativeEvent: Event,
  expectedPhase: number,
): ShareRemoveNativeSnapshot | null {
  if (
    !authority.isCurrent() ||
    authority.prototypeOf(nativeEvent) !== authority.KeyboardEvent.prototype ||
    !authority.trusted.matches(nativeEvent)
  ) {
    return null;
  }
  try {
    const type = shareRemoveNativeValue<string>(
      authority,
      authority.event.type,
      nativeEvent,
    );
    const target = shareRemoveNativeValue<EventTarget | null>(
      authority,
      authority.event.target,
      nativeEvent,
    );
    const currentTarget = shareRemoveNativeValue<EventTarget | null>(
      authority,
      authority.event.currentTarget,
      nativeEvent,
    );
    const phase = shareRemoveNativeValue<number>(
      authority,
      authority.event.eventPhase,
      nativeEvent,
    );
    const bubbles = shareRemoveNativeValue<boolean>(
      authority,
      authority.event.bubbles,
      nativeEvent,
    );
    const cancelable = shareRemoveNativeValue<boolean>(
      authority,
      authority.event.cancelable,
      nativeEvent,
    );
    const defaultPrevented = shareRemoveNativeValue<boolean>(
      authority,
      authority.event.defaultPrevented,
      nativeEvent,
    );
    const cancelBubble = shareRemoveNativeValue<boolean>(
      authority,
      authority.event.cancelBubble,
      nativeEvent,
    );
    const composed = shareRemoveNativeValue<boolean>(
      authority,
      authority.event.composed,
      nativeEvent,
    );
    const key = shareRemoveNavigationKey(shareRemoveNativeValue<string>(
      authority,
      authority.keyboard.key,
      nativeEvent,
    ));
    const code = shareRemoveNativeValue<string>(
      authority,
      authority.keyboard.code,
      nativeEvent,
    );
    const location = shareRemoveNativeValue<number>(
      authority,
      authority.keyboard.location,
      nativeEvent,
    );
    const repeat = shareRemoveNativeValue<boolean>(
      authority,
      authority.keyboard.repeat,
      nativeEvent,
    );
    const composing = shareRemoveNativeValue<boolean>(
      authority,
      authority.keyboard.isComposing,
      nativeEvent,
    );
    const ctrlKey = shareRemoveNativeValue<boolean>(
      authority,
      authority.keyboard.ctrlKey,
      nativeEvent,
    );
    const altKey = shareRemoveNativeValue<boolean>(
      authority,
      authority.keyboard.altKey,
      nativeEvent,
    );
    const metaKey = shareRemoveNativeValue<boolean>(
      authority,
      authority.keyboard.metaKey,
      nativeEvent,
    );
    const shiftKey = shareRemoveNativeValue<boolean>(
      authority,
      authority.keyboard.shiftKey,
      nativeEvent,
    );
    const view = shareRemoveNativeValue<Window | EventTarget | null>(
      authority,
      authority.view,
      nativeEvent,
    );
    const detail = shareRemoveNativeValue<number>(
      authority,
      authority.detail,
      nativeEvent,
    );
    const activeElement = shareRemoveNativeValue<Element | null>(
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
      !(target instanceof authority.HTMLElement) ||
      !(target instanceof authority.ownerWindow.HTMLButtonElement) ||
      target.ownerDocument !== authority.document ||
      activeElement !== target ||
      !currentTarget ||
      phase !== expectedPhase ||
      !bubbles ||
      !cancelable ||
      defaultPrevented ||
      cancelBubble ||
      !key ||
      repeat ||
      composing ||
      ctrlKey ||
      altKey ||
      metaKey ||
      shiftKey ||
      trusted !== true ||
      !terminal ||
      (view !== null &&
        view !== authority.ownerWindow &&
        view !== terminal.receiver) ||
      !shareRemovePathMatches(
        path,
        target,
        authority.document,
        terminal.receiver,
      ) ||
      path.length !== terminal.path.length ||
      path.some((entry, index) => entry !== terminal.path[index]) ||
      !path.includes(authority.list) ||
      !path.includes(currentTarget)
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

function shareRemoveNativeEventsMatch(
  capture: ShareRemoveNativeSnapshot,
  bubble: ShareRemoveNativeSnapshot,
  authority: ShareRemoveKeyboardAuthority,
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

function shareRemoveNativeSnapshotIsCurrent(
  snapshot: ShareRemoveNativeSnapshot,
  authority: ShareRemoveKeyboardAuthority,
  expectedDefaultPrevented = snapshot.defaultPrevented,
) {
  try {
    const path = authority.apply(
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
      shareRemoveNativeValue(authority, authority.event.type, snapshot.event) ===
        snapshot.type &&
      shareRemoveNativeValue(authority, authority.event.target, snapshot.event) ===
        snapshot.target &&
      shareRemoveNativeValue(
        authority,
        authority.event.currentTarget,
        snapshot.event,
      ) === snapshot.currentTarget &&
      shareRemoveNativeValue(
        authority,
        authority.event.eventPhase,
        snapshot.event,
      ) === snapshot.phase &&
      shareRemoveNativeValue(
        authority,
        authority.event.bubbles,
        snapshot.event,
      ) === snapshot.bubbles &&
      shareRemoveNativeValue(
        authority,
        authority.event.cancelable,
        snapshot.event,
      ) === snapshot.cancelable &&
      shareRemoveNativeValue(
        authority,
        authority.event.defaultPrevented,
        snapshot.event,
      ) === expectedDefaultPrevented &&
      shareRemoveNativeValue(
        authority,
        authority.event.cancelBubble,
        snapshot.event,
      ) === snapshot.cancelBubble &&
      shareRemoveNativeValue(
        authority,
        authority.event.composed,
        snapshot.event,
      ) === snapshot.composed &&
      shareRemoveNativeValue(
        authority,
        authority.keyboard.key,
        snapshot.event,
      ) === snapshot.key &&
      shareRemoveNativeValue(
        authority,
        authority.keyboard.code,
        snapshot.event,
      ) === snapshot.code &&
      shareRemoveNativeValue(
        authority,
        authority.keyboard.location,
        snapshot.event,
      ) === snapshot.location &&
      shareRemoveNativeValue(
        authority,
        authority.keyboard.repeat,
        snapshot.event,
      ) === snapshot.repeat &&
      shareRemoveNativeValue(
        authority,
        authority.keyboard.isComposing,
        snapshot.event,
      ) === snapshot.composing &&
      shareRemoveNativeValue(
        authority,
        authority.keyboard.ctrlKey,
        snapshot.event,
      ) === snapshot.ctrlKey &&
      shareRemoveNativeValue(
        authority,
        authority.keyboard.altKey,
        snapshot.event,
      ) === snapshot.altKey &&
      shareRemoveNativeValue(
        authority,
        authority.keyboard.metaKey,
        snapshot.event,
      ) === snapshot.metaKey &&
      shareRemoveNativeValue(
        authority,
        authority.keyboard.shiftKey,
        snapshot.event,
      ) === snapshot.shiftKey &&
      shareRemoveNativeValue(authority, authority.view, snapshot.event) ===
        snapshot.view &&
      shareRemoveNativeValue(authority, authority.detail, snapshot.event) ===
        snapshot.detail &&
      path.length === snapshot.path.length &&
      path.every((entry, index) => entry === snapshot.path[index]) &&
      authority.terminal.retains(snapshot.terminal)
    );
  } catch {
    return false;
  }
}

function captureShareRemoveReactEvent(
  event: ReactKeyboardEvent<HTMLElement>,
  authority: ShareRemoveKeyboardAuthority,
  native: ShareRemoveNativeSnapshot,
  currentTarget: HTMLElement,
): ShareRemoveReactSnapshot | null {
  try {
    const proof = event as ReactKeyboardEvent<HTMLElement> & {
      readonly isComposing?: unknown;
      readonly preventDefault?: unknown;
      readonly isDefaultPrevented?: unknown;
      readonly isPropagationStopped?: unknown;
    };
    const preventDefault = proof.preventDefault;
    const isDefaultPrevented = proof.isDefaultPrevented;
    const isPropagationStopped = proof.isPropagationStopped;
    const composing = proof.isComposing === undefined
      ? null
      : proof.isComposing;
    if (
      typeof preventDefault !== "function" ||
      typeof isDefaultPrevented !== "function" ||
      typeof isPropagationStopped !== "function" ||
      (composing !== null && typeof composing !== "boolean") ||
      event === (native.event as unknown) ||
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
      (composing !== null && composing !== native.composing) ||
      (event.view !== null &&
        !Object.is(event.view, authority.ownerWindow) &&
        !Object.is(event.view, native.terminal.receiver)) ||
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
      composing,
      type: event.type,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      defaultPrevented: event.defaultPrevented,
      isTrusted: event.isTrusted,
      key: event.key,
      code: event.code,
      location: event.location,
      locale: event.locale,
      charCode: event.charCode,
      keyCode: event.keyCode,
      which: event.which,
      timeStamp: event.timeStamp,
      repeat: event.repeat,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      detail: event.detail,
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

function shareRemoveReactSnapshotIsCurrent(
  snapshot: ShareRemoveReactSnapshot,
  authority: ShareRemoveKeyboardAuthority,
  native: ShareRemoveNativeSnapshot,
  currentTarget: HTMLElement | null,
  expectedDefaultPrevented = false,
  currentDefaultQuery = snapshot.methods.isDefaultPrevented,
) {
  try {
    const event = snapshot.event as ReactKeyboardEvent<HTMLElement> & {
      readonly isComposing?: unknown;
      readonly preventDefault?: unknown;
      readonly isDefaultPrevented?: unknown;
      readonly isPropagationStopped?: unknown;
    };
    const composing = event.isComposing === undefined
      ? null
      : event.isComposing;
    return (
      event.nativeEvent === snapshot.nativeEvent &&
      event.nativeEvent === native.event &&
      event.type === snapshot.type &&
      snapshot.type === native.type &&
      event.target === snapshot.target &&
      event.target === native.target &&
      event.currentTarget === currentTarget &&
      event.eventPhase === snapshot.phase &&
      event.bubbles === snapshot.bubbles &&
      snapshot.bubbles === native.bubbles &&
      event.cancelable === snapshot.cancelable &&
      snapshot.cancelable === native.cancelable &&
      event.defaultPrevented === expectedDefaultPrevented &&
      event.isTrusted === snapshot.isTrusted &&
      snapshot.isTrusted === native.trusted &&
      event.key === snapshot.key &&
      snapshot.key === native.key &&
      event.code === snapshot.code &&
      snapshot.code === native.code &&
      event.location === snapshot.location &&
      snapshot.location === native.location &&
      event.locale === snapshot.locale &&
      event.charCode === snapshot.charCode &&
      event.keyCode === snapshot.keyCode &&
      event.which === snapshot.which &&
      event.timeStamp === snapshot.timeStamp &&
      event.repeat === snapshot.repeat &&
      snapshot.repeat === native.repeat &&
      event.ctrlKey === snapshot.ctrlKey &&
      snapshot.ctrlKey === native.ctrlKey &&
      event.altKey === snapshot.altKey &&
      snapshot.altKey === native.altKey &&
      event.metaKey === snapshot.metaKey &&
      snapshot.metaKey === native.metaKey &&
      event.shiftKey === snapshot.shiftKey &&
      snapshot.shiftKey === native.shiftKey &&
      composing === snapshot.composing &&
      (composing === null || composing === native.composing) &&
      event.view === snapshot.view &&
      (event.view === null ||
        Object.is(event.view, authority.ownerWindow) ||
        Object.is(event.view, native.terminal.receiver)) &&
      event.detail === snapshot.detail &&
      snapshot.detail === native.detail &&
      event.preventDefault === snapshot.methods.preventDefault &&
      event.isDefaultPrevented === currentDefaultQuery &&
      event.isPropagationStopped ===
        snapshot.methods.isPropagationStopped
    );
  } catch {
    return false;
  }
}

function queryShareRemoveReactMethod(
  snapshot: ShareRemoveReactSnapshot,
  method: (...args: never[]) => unknown,
  expected: boolean,
  authority: ShareRemoveKeyboardAuthority,
  revalidate: () => boolean,
) {
  try {
    const result = authority.apply(method, snapshot.event, []);
    return result === expected && revalidate();
  } catch {
    return false;
  }
}

function callShareRemoveReactMethod(
  snapshot: ShareRemoveReactSnapshot,
  method: (...args: never[]) => unknown,
  authority: ShareRemoveKeyboardAuthority,
  revalidate: () => boolean,
) {
  try {
    authority.apply(method, snapshot.event, []);
    return revalidate();
  } catch {
    return false;
  }
}

function shareRemoveDestination(
  controls: readonly ShareRemoveControlPublication[],
  source: ShareRemoveControlPublication,
  key: ShareRemoveNavigationKey,
) {
  const sourceIndex = controls.indexOf(source);
  if (sourceIndex < 0) return null;
  let destinationIndex: number;
  if (key === "ArrowLeft" || key === "ArrowUp") {
    destinationIndex = Math.max(0, sourceIndex - 1);
  } else if (key === "ArrowRight" || key === "ArrowDown") {
    destinationIndex = Math.min(controls.length - 1, sourceIndex + 1);
  } else {
    destinationIndex = key === "Home" ? 0 : controls.length - 1;
  }
  return destinationIndex === sourceIndex
    ? null
    : controls[destinationIndex] ?? null;
}

function createShareRemoveNavigationPublication(
  presentation: SharePresentation,
  runtime: SharePresentationRuntime,
): ShareRemoveNavigationPublication | null {
  const list = runtime.list;
  const visit = presentation.visit;
  const context = presentation.permissionContext;
  if (
    !list ||
    !visit ||
    !context ||
    !presentation.isOwner ||
    presentation.list.status !== "loaded" ||
    presentation.sourceList !== presentation.list.source ||
    list.getAttribute("aria-label") !== COLLABORATOR_LIST_LABEL
  ) {
    return null;
  }
  const controls: ShareRemoveControlPublication[] = [];
  for (const row of presentation.list.collaborators) {
    const element = runtime.rows[row.index]?.remove;
    if (
      !element ||
      row.pending ||
      row.operation ||
      element.disabled ||
      !element.isConnected ||
      element.parentElement !== runtime.rows[row.index]?.row
    ) {
      continue;
    }
    controls.push(Object.freeze({
      presentation,
      visit,
      permissionContext: context,
      list: presentation.list,
      row,
      element,
      callback: presentation.removeCollaborator,
      order: controls.length,
    }));
  }
  if (controls.length === 0) return null;
  const authority = captureShareRemoveKeyboardAuthority(presentation, list);
  if (!authority) return null;
  let retired = false;
  const publication: ShareRemoveNavigationPublication = Object.freeze({
    presentation,
    visit,
    permissionContext: context,
    sourceList: presentation.list.source,
    list: presentation.list,
    listElement: list,
    controls: Object.freeze(controls),
    authority,
    retire: () => {
      if (retired) return;
      retired = true;
      authority.terminal.release();
    },
    isRetired: () => retired,
  });
  return publication;
}

function snapshotSharePlacement(node: Node, ownerDocument: Document): SharePlacementChain | null {
  const placements: SharePlacement[] = [];
  let current: Node | null = node;
  while (current && current !== ownerDocument) {
    const parentNode: Node | null = current.parentNode;
    if (!parentNode) return null;
    placements.push(Object.freeze({
      node: current,
      parent: parentNode,
      previousSibling: current.previousSibling,
      nextSibling: current.nextSibling,
    }));
    current = parentNode;
  }
  return current === ownerDocument ? Object.freeze(placements) : null;
}

function sharePlacementMatches(
  ownerDocument: Document,
  placements: SharePlacementChain,
): boolean {
  return (
    placements.length > 0 &&
    placements.at(-1)?.parent === ownerDocument &&
    placements.every(({ node, parent, previousSibling, nextSibling }) =>
      node.ownerDocument === ownerDocument &&
      node.parentNode === parent &&
      node.previousSibling === previousSibling &&
      node.nextSibling === nextSibling
    )
  );
}

function sharePlacementsAreExactReplay(
  previous: SharePlacementChain,
  next: SharePlacementChain,
): boolean {
  return (
    previous.length === next.length &&
    previous.every((placement, index) => {
      const candidate = next[index];
      return Boolean(
        candidate &&
        placement.node === candidate.node &&
        placement.parent === candidate.parent &&
        placement.previousSibling === candidate.previousSibling &&
        placement.nextSibling === candidate.nextSibling,
      );
    })
  );
}

function mutationTouchesSharePlacement(
  placements: SharePlacementChain,
  record: MutationRecord,
): boolean {
  if (record.type !== "childList") return false;
  return placements.some(({ node, parent, previousSibling, nextSibling }) => {
    if (record.target !== parent) return false;
    if (record.previousSibling === node || record.nextSibling === node) return true;
    if (
      record.previousSibling === previousSibling &&
      record.nextSibling === nextSibling
    ) {
      return true;
    }
    return [...record.addedNodes, ...record.removedNodes].some((changed) =>
      changed === node ||
      (changed.nodeType === 1 && (changed as Element).contains(node))
    );
  });
}

function localAgentCardDomIsExact(
  publication: LocalAgentCardPublication,
): boolean {
  const {
    render,
    card,
    control,
    panel,
    ownerDocument,
    ownerWindow,
  } = publication;
  const leadingIcon = control.children.item(0);
  const labels = control.children.item(1);
  const chevron = control.children.item(2);
  return (
    card instanceof ownerWindow.HTMLElement &&
    card.isConnected &&
    card.ownerDocument === ownerDocument &&
    card.getRootNode() === ownerDocument &&
    card.localName === "section" &&
    card.className === AGENT_CARD_CLASS &&
    card.getAttribute("aria-label") === "Collaborate with an agent" &&
    card.getAttribute("data-testid") === "share-agent-card" &&
    card.children.length === 2 &&
    control instanceof ownerWindow.HTMLButtonElement &&
    card.firstElementChild === control &&
    control.type === "button" &&
    !control.disabled &&
    control.className === AGENT_TOGGLE_CLASS &&
    control.getAttribute("aria-expanded") === String(render.expanded) &&
    control.getAttribute("aria-controls") === render.panelId &&
    control.getAttribute("data-testid") === "share-agent-toggle" &&
    control.children.length === 3 &&
    leadingIcon?.localName === "span" &&
    leadingIcon.className ===
      "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/60 dark:text-violet-300" &&
    leadingIcon.children.length === 1 &&
    leadingIcon.firstElementChild?.getAttribute("class") === "lucide lucide-bot" &&
    leadingIcon.firstElementChild?.getAttribute("width") === "15" &&
    leadingIcon.firstElementChild?.getAttribute("height") === "15" &&
    leadingIcon.firstElementChild?.getAttribute("aria-hidden") === "true" &&
    labels?.localName === "span" &&
    labels.className === "min-w-0 flex-1" &&
    labels.children.length === 2 &&
    labels.children.item(0)?.className === "block text-sm font-medium text-ink" &&
    labels.children.item(0)?.textContent === "Collaborate with an agent" &&
    labels.children.item(1)?.className === "block truncate text-xs text-ink-3" &&
    labels.children.item(1)?.textContent ===
      "Connect Copilot CLI or any MCP client as a collaborator" &&
    chevron?.localName === "svg" &&
    chevron.getAttribute("class") === cn(
      "lucide lucide-chevron-down shrink-0 text-ink-3 transition-transform",
      render.expanded && "rotate-180",
    ) &&
    chevron.getAttribute("width") === "16" &&
    chevron.getAttribute("height") === "16" &&
    chevron.getAttribute("aria-hidden") === "true" &&
    panel instanceof ownerWindow.HTMLDivElement &&
    card.children.item(1) === panel &&
    panel.id === render.panelId &&
    panel.hidden === !render.expanded &&
    panel.className === AGENT_PANEL_CLASS &&
    panel.children.length === (render.expanded ? 1 : 0) &&
    (
      !render.expanded ||
      panel.firstElementChild?.getAttribute("data-testid") === "token-manager"
    )
  );
}

function mutationTouchesLocalAgentCard(
  publication: LocalAgentCardPublication,
  record: MutationRecord,
): boolean {
  const { card, control, panel } = publication;
  const target = record.target;
  if (
    target === card ||
    target === control ||
    control.contains(target) ||
    target === panel
  ) {
    return true;
  }
  if (record.type !== "childList") return false;
  return [...record.addedNodes, ...record.removedNodes].some((node) =>
    node === card ||
    node === control ||
    node === panel ||
    (
      node.nodeType === 1 &&
      (
        (node as Element).contains(card) ||
        (node as Element).contains(control) ||
        (node as Element).contains(panel)
      )
    )
  );
}

function drainLocalAgentCardMutations(
  publication: LocalAgentCardPublication,
): boolean {
  const records = publication.observer?.takeRecords() ?? [];
  const placementRecords = publication.placementObserver?.takeRecords() ?? [];
  if (
    records.some((record) => mutationTouchesLocalAgentCard(publication, record))
  ) {
    publication.mutated = true;
  }
  if (
    placementRecords.some((record) =>
      mutationTouchesSharePlacement(publication.placement, record))
  ) {
    publication.placementMutated = true;
  }
  return !publication.mutated && !publication.placementMutated;
}

function retireLocalAgentCardPublication(
  publication: LocalAgentCardPublication,
) {
  publication.active = false;
  publication.directionalCapture?.release();
  publication.directionalCapture = null;
  publication.directionalPairs = new WeakMap();
  publication.directionalFence = null;
  publication.observer?.disconnect();
  publication.observer = null;
  publication.placementObserver?.disconnect();
  publication.placementObserver = null;
}

function isExactNativeChange(event: ReactChangeEvent<HTMLSelectElement>, control: HTMLSelectElement): boolean {
  const ownerWindow = control.ownerDocument.defaultView;
  return (
    event.type === "change" &&
    !event.defaultPrevented &&
    ownerWindow !== null &&
    event.nativeEvent instanceof ownerWindow.Event &&
    event.nativeEvent.type === "change" &&
    !event.nativeEvent.defaultPrevented &&
    event.currentTarget === control &&
    event.target === control &&
    event.nativeEvent.target === control
  );
}

function isExactNativeSubmit(
  event: ReactFormEvent<HTMLFormElement>,
  form: HTMLFormElement,
  add: HTMLButtonElement,
): boolean {
  const ownerWindow = form.ownerDocument.defaultView;
  if (
    event.type !== "submit" ||
    event.defaultPrevented ||
    ownerWindow === null ||
    typeof ownerWindow.SubmitEvent !== "function" ||
    !(event.nativeEvent instanceof ownerWindow.SubmitEvent) ||
    event.nativeEvent.type !== "submit" ||
    event.nativeEvent.defaultPrevented ||
    event.currentTarget !== form ||
    event.target !== form ||
    event.nativeEvent.target !== form
  ) {
    return false;
  }
  return event.nativeEvent.submitter === null || event.nativeEvent.submitter === add;
}

function optionValueIsRole(value: string): value is CollaboratorRole {
  return ROLE_OPTIONS.some((option) => option.value === value);
}

function optionValueIsLinkAccess(value: string): value is DocumentDto["linkAccess"] {
  return LINK_OPTIONS.some((option) => option.value === value);
}

function roleSelectIsExact(
  select: HTMLSelectElement,
  value: CollaboratorRole,
  disabled: boolean,
): boolean {
  const ownerWindow = select.ownerDocument.defaultView;
  if (
    !ownerWindow ||
    !(select instanceof ownerWindow.HTMLSelectElement) ||
    !select.isConnected ||
    select.disabled !== disabled ||
    select.value !== value ||
    select.options.length !== ROLE_OPTIONS.length ||
    select.selectedOptions.length !== 1 ||
    select.selectedOptions.item(0)?.value !== value
  ) {
    return false;
  }
  return ROLE_OPTIONS.every((option, index) => {
    const element = select.options.item(index);
    return (
      element instanceof ownerWindow.HTMLOptionElement &&
      element.parentElement === select &&
      element.value === option.value &&
      element.textContent === option.label &&
      !element.disabled
    );
  });
}

function linkSelectIsExact(
  select: HTMLSelectElement,
  value: DocumentDto["linkAccess"],
  disabled: boolean,
): boolean {
  const ownerWindow = select.ownerDocument.defaultView;
  if (
    !ownerWindow ||
    !(select instanceof ownerWindow.HTMLSelectElement) ||
    !select.isConnected ||
    select.disabled !== disabled ||
    select.value !== value ||
    select.options.length !== LINK_OPTIONS.length ||
    select.selectedOptions.length !== 1 ||
    select.selectedOptions.item(0)?.value !== value
  ) {
    return false;
  }
  return LINK_OPTIONS.every((option, index) => {
    const element = select.options.item(index);
    return (
      element instanceof ownerWindow.HTMLOptionElement &&
      element.parentElement === select &&
      element.value === option.value &&
      element.textContent === option.label &&
      element.disabled === disabled
    );
  });
}

function presentationFactsAreExactReplay(previous: SharePresentation, next: SharePresentation): boolean {
  const previousKeys = Object.keys(previous) as (keyof SharePresentation)[];
  const nextKeys = Object.keys(next) as (keyof SharePresentation)[];
  return (
    previousKeys.length === nextKeys.length &&
    previousKeys.every((key) => previous[key] === next[key])
  );
}

function runtimeElementsAreExactReplay(
  previous: SharePresentationRuntime,
  next: SharePresentationRuntime,
): boolean {
  const elementKeys = [
    "dialog",
    "overlay",
    "portalParent",
    "close",
    "root",
    "form",
    "loginControl",
    "login",
    "newRole",
    "add",
    "addError",
    "actionError",
    "people",
    "list",
    "listState",
    "retry",
    "owner",
    "empty",
    "editorLink",
    "linkValue",
    "linkFallback",
    "linkCopy",
    "linkHint",
    "general",
    "linkAccess",
    "agent",
    "agentCard",
    "agentToggle",
    "agentPanel",
    "footer",
    "done",
  ] as const;
  return (
    elementKeys.every((key) => previous[key] === next[key]) &&
    previous.rows.length === next.rows.length &&
    previous.rows.every(
      (row, index) =>
        row.row === next.rows[index]?.row &&
        row.role === next.rows[index]?.role &&
        row.remove === next.rows[index]?.remove,
    )
  );
}

function mutationTouchesPresentation(runtime: SharePresentationRuntime, record: MutationRecord): boolean {
  if (record.target === runtime.portalParent && record.type === "childList") {
    const placementNodes = new Set<Node | null>([
      runtime.overlay,
      runtime.dialog,
    ]);
    return (
      [...record.addedNodes, ...record.removedNodes].some((node) => placementNodes.has(node)) ||
      (record.previousSibling === runtime.overlay && record.nextSibling === runtime.dialog)
    );
  }

  const changedNodes = [...record.addedNodes, ...record.removedNodes];
  const ownedElements = [
    runtime.dialog,
    runtime.overlay,
    runtime.close,
    runtime.root,
    runtime.form,
    runtime.loginControl,
    runtime.login,
    runtime.newRole,
    runtime.add,
    runtime.addError,
    runtime.actionError,
    runtime.people,
    runtime.list,
    runtime.listState,
    runtime.retry,
    runtime.owner,
    runtime.empty,
    runtime.editorLink,
    runtime.linkValue,
    runtime.linkFallback,
    runtime.linkCopy,
    runtime.linkHint,
    ...runtime.rows.flatMap((row) => [row.row, row.role, row.remove]),
    runtime.general,
    runtime.linkAccess,
    runtime.agent,
    runtime.agentCard,
    runtime.agentToggle,
    runtime.agentPanel,
    runtime.footer,
    runtime.done,
  ].filter((element) => element !== null);
  if (
    changedNodes.some((node) =>
      ownedElements.some((element) => node === element || (node instanceof Element && node.contains(element))),
    )
  ) {
    return true;
  }

  const target = record.target;
  if (runtime.editorLink?.contains(target)) return true;
  if (
    record.type === "attributes" &&
    ((target === runtime.overlay &&
      (record.attributeName === "aria-hidden" || record.attributeName === "data-aria-hidden")) ||
      (target === runtime.dialog &&
        (record.attributeName === "aria-describedby" ||
          record.attributeName === "aria-labelledby" ||
          record.attributeName === "style")))
  ) {
    return false;
  }
  if (runtime.loginControl?.contains(target) || runtime.agent?.contains(target)) {
    return record.type === "attributes" && (
      target === runtime.loginControl ||
      target === runtime.agent ||
      target === runtime.agentCard ||
      target === runtime.agentToggle ||
      target === runtime.agentPanel
    );
  }
  return ownedElements.some(
    (element) =>
      target === element ||
      ((element instanceof HTMLButtonElement || element instanceof HTMLSelectElement) &&
        element.contains(target)),
  );
}

function drainPresentationMutations(runtime: SharePresentationRuntime): boolean {
  const records = runtime.observer?.takeRecords() ?? [];
  const placementRecords = runtime.placementObserver?.takeRecords() ?? [];
  const placement = runtime.placement;
  if (
    placement &&
    placementRecords.some((record) => mutationTouchesSharePlacement(placement, record))
  ) {
    runtime.controlPlacementMutated = true;
  }
  if (records.some((record) => mutationTouchesCopyControl(runtime, record))) {
    runtime.copyControlMutated = true;
  }
  if (records.some((record) => mutationTouchesPresentation(runtime, record))) runtime.mutated = true;
  return !runtime.mutated;
}

function mutationTouchesCopyControl(
  runtime: SharePresentationRuntime,
  record: MutationRecord,
): boolean {
  const editorLink = runtime.editorLink;
  if (!editorLink) return false;
  const target = record.target;
  if (target === editorLink || editorLink.contains(target)) return true;
  if (record.type !== "childList") return false;
  if (record.previousSibling === editorLink || record.nextSibling === editorLink) return true;
  return [...record.addedNodes, ...record.removedNodes].some((node) =>
    node === editorLink ||
    (
      node.nodeType === 1 &&
      ((node as Element).contains(editorLink) || editorLink.contains(node))
    )
  );
}

function stopPresentationObservation(runtime: SharePresentationRuntime): boolean {
  const clean = drainPresentationMutations(runtime);
  runtime.observer?.disconnect();
  runtime.observer = null;
  runtime.placementObserver?.disconnect();
  runtime.placementObserver = null;
  runtime.observerRetirement = null;
  return clean && !runtime.controlPlacementMutated;
}

function clearShareCloseProvenance(
  runtime: SharePresentationRuntime,
  expected?: ShareCloseProvenance,
) {
  if (expected && runtime.closeProvenance !== expected) return;
  runtime.closeProvenance = null;
  const retirement = runtime.closeProvenanceRetirement;
  if (!retirement || (expected && retirement.provenance !== expected)) return;
  runtime.closeProvenanceRetirement = null;
  runtime.dialog?.ownerDocument.defaultView?.clearTimeout(retirement.timer);
}

function captureRuntimeDerivedElements(runtime: SharePresentationRuntime) {
  const ownerWindow = runtime.root?.ownerDocument.defaultView;
  const dialog = runtime.root?.parentElement;
  runtime.dialog = ownerWindow && dialog instanceof ownerWindow.HTMLDivElement ? dialog : null;
  const overlay = runtime.dialog?.previousElementSibling;
  runtime.overlay = ownerWindow && overlay instanceof ownerWindow.HTMLDivElement ? overlay : null;
  const portalParent = runtime.dialog?.parentElement;
  runtime.portalParent = ownerWindow && portalParent instanceof ownerWindow.HTMLElement ? portalParent : null;
  const close = runtime.dialog?.firstElementChild?.lastElementChild;
  runtime.close = ownerWindow && close instanceof ownerWindow.HTMLButtonElement ? close : null;
  const loginControl = runtime.form?.firstElementChild;
  runtime.loginControl = ownerWindow && loginControl instanceof ownerWindow.HTMLDivElement ? loginControl : null;
  const login = runtime.loginControl?.querySelector('[data-testid="share-login"]');
  runtime.login = ownerWindow && login instanceof ownerWindow.HTMLInputElement ? login : null;
}

export const ShareDialog = memo(function ShareDialog({
  open,
  onOpenChange,
  doc,
  isOwner,
  onDocChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocumentDto;
  isOwner: boolean;
  onDocChange: (doc: DocumentDto) => void;
}) {
  const [mount] = useState(() => Symbol("share-dialog"));
  const [removeCallbackIdentity] = useState<ShareRemoveCallbackIdentity>(
    () => Object.freeze({ kind: "remove-collaborator" }),
  );
  const activePresentationRef = useRef<SharePresentation | null>(null);
  const presentationRuntimesRef = useRef(new WeakMap<SharePresentation, SharePresentationRuntime>());
  const presentationLineagesRef = useRef(new WeakMap<SharePresentation, SharePresentationLineage>());
  const publishPresentationRef = useRef<
    ((source: SharePresentation, expected?: SharePresentation) => SharePresentation | null) | null
  >(null);
  const shareVisit = useRef<ShareVisit | null>(null);
  const [collaboratorList, setCollaboratorList] = useState<CollaboratorListState | null>(null);
  const listRequest = useRef(0);
  const listPending = useRef<CollaboratorListRequest | null>(null);
  const [listPendingOperation, setListPendingOperation] = useState<CollaboratorListRequest | null>(null);
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<CollaboratorRole>("editor");
  const [busy, setBusy] = useState(false);
  const addRequest = useRef(0);
  const addPending = useRef<AddCollaboratorOperation | null>(null);
  const [addPendingOperation, setAddPendingOperation] = useState<AddCollaboratorOperation | null>(null);
  const [addError, setAddError] = useState<{ documentId: string; message: string } | null>(null);
  const permissionContext = useRef<PermissionContext | null>(null);
  const collaboratorPermissionOwners = useRef(new Map<string, CollaboratorPermissionOperation>());
  const linkPermissionOwner = useRef<LinkPermissionOperation | null>(null);
  const permissionFeedbackOwner = useRef<PermissionOperation | null>(null);
  const [permissionFeedbackOperation, setPermissionFeedbackOperation] = useState<PermissionOperation | null>(null);
  const [collaboratorPermissionOperations, setCollaboratorPermissionOperations] = useState<Map<string, CollaboratorPermissionOperation>>(() => new Map());
  const [linkPermissionOperation, setLinkPermissionOperation] = useState<LinkPermissionOperation | null>(null);
  const [actionError, setActionError] = useState<{ operation: PermissionOperation; message: string } | null>(null);
  const liveFactsRef = useRef<ShareLiveFacts | null>(null);
  const copyOperationRef = useRef<ShareCopyOperation | null>(null);
  const copyHandoffRef = useRef<ShareCopyHandoff | null>(null);
  const copyFeedbackRef = useRef<ShareCopyFeedback | null>(null);
  const copyFeedbackTimersRef = useRef(new WeakMap<ShareCopyFeedback, number>());
  const claimedControlActionsRef = useRef(new WeakSet<object>());
  const claimedControlEventsRef = useRef(new WeakSet<object>());
  const claimedNativeControlEventsRef = useRef(new WeakSet<Event>());
  const claimedDirectionalPairsRef = useRef(new WeakSet<object>());
  const claimedControlElementsRef = useRef(new WeakMap<HTMLButtonElement, object>());
  const claimedRemoveDeliveriesRef = useRef(new WeakSet<object>());
  const claimedRemovePairsRef = useRef(new WeakSet<object>());
  const claimedRemoveMovementsRef = useRef(new WeakSet<object>());
  const claimedRemovePublicationClaimsRef = useRef(new WeakSet<object>());
  const claimedRemoveVisitClaimsRef = useRef(new WeakSet<object>());
  const claimedRemoveSourceClaimsRef = useRef(new WeakSet<object>());
  const claimedRemoveDestinationClaimsRef = useRef(new WeakSet<object>());
  const claimedRemoveWrapperClaimsRef = useRef(new WeakSet<object>());
  const claimedRemoveNativeClaimsRef = useRef(new WeakSet<object>());
  const claimedRemoveWindowClaimsRef = useRef(new WeakSet<object>());
  const claimedRemoveReactWrappersRef = useRef(new WeakSet<object>());
  const claimedRemoveNativeKeyEventsRef = useRef(new WeakSet<Event>());
  const activeRemoveDeliveryRef = useRef<ShareRemoveNavigationDelivery | null>(
    null,
  );
  const selectedFallbacksRef = useRef(new WeakSet<ShareCopyFallback>());
  const [copyFeedback, setCopyFeedback] = useState<ShareCopyFeedback | null>(null);
  const [copyFallback, setCopyFallback] = useState<ShareCopyFallback | null>(null);
  const [agentExpansion, setAgentExpansion] = useState<ShareAgentExpansion | null>(null);
  const visit = useMemo<ShareVisit | null>(
    () => (open ? Object.freeze({ documentId: doc.id }) : null),
    [doc.id, open],
  );
  const currentPermissionContext = useMemo<PermissionContext | null>(
    () => (open ? Object.freeze({ documentId: doc.id }) : null),
    [doc.id, open],
  );
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const readerLink = `${origin}/p/${doc.id}`;
  const editorLink = `${origin}/d/${doc.id}`;
  const readerLinkEl = useRef<HTMLElement>(null);
  const currentCopyFeedback =
    visit &&
    copyFeedback?.visit === visit &&
    copyFeedback.value === editorLink
      ? copyFeedback
      : null;
  const currentCopyFallback =
    visit &&
    copyFallback?.visit === visit &&
    copyFallback.value === editorLink
      ? copyFallback
      : null;
  const copyStatus: ShareCopyStatus = currentCopyFeedback?.status ?? "idle";
  const copyLabel =
    copyStatus === "copied"
      ? "Copied"
      : copyStatus === "fallback"
        ? COPY_FALLBACK_HINT
        : "Copy link";
  const agentExpanded =
    Boolean(visit && agentExpansion?.visit === visit && agentExpansion.expanded);
  const agentPanelId = `${useId()}-panel`;

  const retireCopyOperation = useCallback((expected?: SharePresentation) => {
    const operation = copyOperationRef.current;
    if (!operation || (expected && operation.action.presentation !== expected)) return;
    if (copyHandoffRef.current?.operation === operation) copyHandoffRef.current = null;
    operation.retired = true;
    copyOperationRef.current = null;
  }, []);

  const retireCopyHandoff = useCallback((failed?: SharePresentation) => {
    const handoff = copyHandoffRef.current;
    if (!handoff || (failed && handoff.successor !== failed)) return;
    copyHandoffRef.current = null;
    if (copyOperationRef.current !== handoff.operation) return;
    handoff.operation.retired = true;
    copyOperationRef.current = null;
  }, []);

  useLayoutEffect(() => {
    const feedbackTimers = copyFeedbackTimersRef.current;
    copyFeedbackRef.current = currentCopyFeedback;
    return () => {
      if (copyFeedbackRef.current !== currentCopyFeedback) return;
      copyFeedbackRef.current = null;
      if (currentCopyFeedback) {
        const timer = feedbackTimers.get(currentCopyFeedback);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          feedbackTimers.delete(currentCopyFeedback);
        }
      }
    };
  }, [currentCopyFeedback]);

  useLayoutEffect(() => {
    const acceptedVisit = visit;
    const feedbackTimers = copyFeedbackTimersRef.current;
    return () => {
      const operation = copyOperationRef.current;
      if (operation?.action.visit === acceptedVisit) retireCopyOperation(operation.action.presentation);
      const feedback = copyFeedbackRef.current;
      if (feedback?.visit === acceptedVisit) {
        copyFeedbackRef.current = null;
        const timer = feedbackTimers.get(feedback);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          feedbackTimers.delete(feedback);
        }
      }
    };
  }, [retireCopyOperation, visit]);

  const retireShareRequests = useCallback((expectedVisit?: ShareVisit) => {
    if (expectedVisit && shareVisit.current !== expectedVisit) return;
    shareVisit.current = null;
    listRequest.current += 1;
    listPending.current = null;
    addRequest.current += 1;
    addPending.current = null;
  }, []);

  const retirePermissionOperations = useCallback((expectedContext?: PermissionContext) => {
    if (expectedContext && permissionContext.current !== expectedContext) return;
    permissionContext.current = null;
    collaboratorPermissionOwners.current.clear();
    linkPermissionOwner.current = null;
    permissionFeedbackOwner.current = null;
  }, []);

  const loadCollaborators = useCallback(async (documentId: string, mode: "load" | "retry" = "load", supersede = false) => {
    const visit = shareVisit.current;
    if (!visit || visit.documentId !== documentId) return;
    if (!supersede && listPending.current?.visit === visit) return;

    const ownership = { visit, request: ++listRequest.current, documentId };
    listPending.current = ownership;
    setListPendingOperation(ownership);
    setCollaboratorList((current) =>
      mode === "retry" && current?.documentId === documentId && current.status === "error"
        ? { ...current, retrying: true }
        : { documentId, status: "loading" },
    );
    try {
      const res = await api.documents.collaborators(documentId);
      if (shareVisit.current !== visit || listPending.current !== ownership || listRequest.current !== ownership.request) return;
      setCollaboratorList({ documentId, status: "loaded", owner: res.owner, collaborators: res.collaborators });
    } catch (e) {
      if (shareVisit.current !== visit || listPending.current !== ownership || listRequest.current !== ownership.request) return;
      setCollaboratorList({ documentId, status: "error", message: apiErrorText(e, "Could not load collaborators"), retrying: false });
    } finally {
      if (shareVisit.current === visit && listPending.current === ownership) {
        listPending.current = null;
        setListPendingOperation((current) => (current === ownership ? null : current));
      }
    }
  }, []);

  useLayoutEffect(() => {
    retireShareRequests();
    setListPendingOperation(null);
    setAddPendingOperation(null);
    setBusy(false);
    setAddError(null);
    if (!open) {
      setCollaboratorList(null);
      return;
    }
    if (!visit) return;
    shareVisit.current = visit;
    setCollaboratorList({ documentId: doc.id, status: "loading" });
    void loadCollaborators(doc.id);
    return () => retireShareRequests(visit);
  }, [open, doc.id, loadCollaborators, retireShareRequests, visit]);

  useLayoutEffect(() => {
    retirePermissionOperations();
    setCollaboratorPermissionOperations(new Map());
    setLinkPermissionOperation(null);
    setPermissionFeedbackOperation(null);
    setActionError(null);

    if (!open) return;
    if (!currentPermissionContext) return;
    permissionContext.current = currentPermissionContext;
    return () => retirePermissionOperations(currentPermissionContext);
  }, [open, doc.id, currentPermissionContext, retirePermissionOperations]);

  const currentAddError = addError?.documentId === doc.id ? addError.message : null;
  const currentActionError = actionError?.operation.documentId === doc.id ? actionError.message : null;
  const currentLinkPermissionOperation = linkPermissionOperation?.documentId === doc.id ? linkPermissionOperation : null;

  const add = async (
    acceptedVisit: ShareVisit,
    documentId: string,
    trimmedLogin: string,
    selectedRole: CollaboratorRole,
  ) => {
    if (
      shareVisit.current !== acceptedVisit ||
      acceptedVisit.documentId !== documentId ||
      !trimmedLogin ||
      addPending.current
    ) {
      return;
    }
    const ownership = {
      visit: acceptedVisit,
      request: ++addRequest.current,
      documentId,
      login: trimmedLogin,
      role: selectedRole,
    };
    addPending.current = ownership;
    setAddPendingOperation(ownership);
    setBusy(true);
    setAddError(null);
    try {
      await api.documents.addCollaborator(ownership.documentId, ownership.login, ownership.role);
      if (shareVisit.current !== acceptedVisit || addPending.current !== ownership || addRequest.current !== ownership.request) return;
      setLogin("");
      await loadCollaborators(ownership.documentId, "load", true);
    } catch (e) {
      if (shareVisit.current === acceptedVisit && addPending.current === ownership && addRequest.current === ownership.request) {
        setAddError({ documentId: ownership.documentId, message: apiErrorText(e, "Could not add collaborator") });
      }
    } finally {
      if (shareVisit.current === acceptedVisit && addPending.current === ownership && addRequest.current === ownership.request) {
        addPending.current = null;
        setAddPendingOperation((current) => (current === ownership ? null : current));
        setBusy(false);
      }
    }
  };

  const isCollaboratorPermissionCurrent = useCallback(
    (operation: CollaboratorPermissionOperation) =>
      permissionContext.current === operation.context &&
      collaboratorPermissionOwners.current.get(operation.login) === operation,
    [],
  );

  const isLinkPermissionCurrent = (operation: LinkPermissionOperation) =>
    permissionContext.current === operation.context && linkPermissionOwner.current === operation;

  const claimPermissionFeedback = useCallback((operation: PermissionOperation) => {
    permissionFeedbackOwner.current = operation;
    setPermissionFeedbackOperation(operation);
    setActionError(null);
  }, []);

  const setPermissionError = useCallback((operation: PermissionOperation, message: string) => {
    if (permissionContext.current === operation.context && permissionFeedbackOwner.current === operation) {
      setActionError({ operation, message });
    }
  }, []);

  const beginCollaboratorPermission = useCallback(
    (
      context: PermissionContext,
      documentId: string,
      login: string,
      kind: CollaboratorPermissionOperation["kind"],
    ) => {
      if (
        permissionContext.current !== context ||
        context.documentId !== documentId ||
        collaboratorPermissionOwners.current.has(login)
      ) {
        return null;
      }
      const operation = { context, documentId, login, kind };
      collaboratorPermissionOwners.current.set(login, operation);
      claimPermissionFeedback(operation);
      setCollaboratorPermissionOperations((current) =>
        new Map(current).set(login, operation),
      );
      return operation;
    },
    [claimPermissionFeedback],
  );

  const finishCollaboratorPermission = useCallback(
    (operation: CollaboratorPermissionOperation) => {
      if (!isCollaboratorPermissionCurrent(operation)) return;
      collaboratorPermissionOwners.current.delete(operation.login);
      setCollaboratorPermissionOperations((current) => {
        if (current.get(operation.login) !== operation) return current;
        const next = new Map(current);
        next.delete(operation.login);
        return next;
      });
    },
    [isCollaboratorPermissionCurrent],
  );

  const changeRole = async (
    context: PermissionContext,
    documentId: string,
    login: string,
    next: CollaboratorRole,
  ) => {
    const operation = beginCollaboratorPermission(context, documentId, login, "role");
    if (!operation) return;
    try {
      await api.documents.addCollaborator(operation.documentId, login, next);
      if (!isCollaboratorPermissionCurrent(operation)) return;
      setCollaboratorList((current) =>
        current?.documentId === operation.documentId && current.status === "loaded"
          ? { ...current, collaborators: current.collaborators.map((x) => (x.login === login ? { ...x, role: next } : x)) }
          : current,
      );
    } catch (e) {
      if (isCollaboratorPermissionCurrent(operation)) {
        setPermissionError(operation, apiErrorText(e, "Could not change collaborator role"));
      }
    } finally {
      finishCollaboratorPermission(operation);
    }
  };

  const remove: ShareRemoveCallback = useCallback(
    async (context: PermissionContext, documentId: string, login: string) => {
      const operation = beginCollaboratorPermission(
        context,
        documentId,
        login,
        "remove",
      );
      if (!operation) return;
      try {
        await api.documents.removeCollaborator(operation.documentId, login);
        if (!isCollaboratorPermissionCurrent(operation)) return;
        setCollaboratorList((current) =>
          current?.documentId === operation.documentId &&
          current.status === "loaded"
            ? {
                ...current,
                collaborators: current.collaborators.filter(
                  (collaborator) => collaborator.login !== login,
                ),
              }
            : current,
        );
      } catch (error) {
        if (isCollaboratorPermissionCurrent(operation)) {
          setPermissionError(
            operation,
            apiErrorText(error, "Could not remove collaborator"),
          );
        }
      } finally {
        finishCollaboratorPermission(operation);
      }
    },
    [
      beginCollaboratorPermission,
      finishCollaboratorPermission,
      isCollaboratorPermissionCurrent,
      setPermissionError,
    ],
  );

  const setLink = async (
    context: PermissionContext,
    documentId: string,
    value: DocumentDto["linkAccess"],
    acceptedOnDocChange: (doc: DocumentDto) => void,
  ) => {
    if (
      permissionContext.current !== context ||
      context.documentId !== documentId ||
      linkPermissionOwner.current
    ) {
      return;
    }
    const operation: LinkPermissionOperation = { context, documentId, kind: "link" };
    linkPermissionOwner.current = operation;
    claimPermissionFeedback(operation);
    setLinkPermissionOperation(operation);
    try {
      const res = await api.documents.patch(operation.documentId, { linkAccess: value });
      if (!isLinkPermissionCurrent(operation)) return;
      acceptedOnDocChange(res.document);
    } catch (e) {
      if (isLinkPermissionCurrent(operation)) {
        setPermissionError(operation, apiErrorText(e, "Could not change link access"));
      }
    } finally {
      if (isLinkPermissionCurrent(operation)) {
        linkPermissionOwner.current = null;
        setLinkPermissionOperation((current) => (current === operation ? null : current));
      }
    }
  };

  const publishedList = snapshotList(collaboratorList, doc.id, collaboratorPermissionOperations);
  const publishedPermissionOperations = Object.freeze(
    Array.from(collaboratorPermissionOperations.values(), snapshotCollaboratorPermissionOperation),
  );
  const presentation: SharePresentation = Object.freeze({
    mount,
    open,
    visit,
    permissionContext: currentPermissionContext,
    sourceDocument: doc,
    document: Object.freeze({ ...doc }),
    isOwner,
    onOpenChange,
    onDocChange,
    sourceList: collaboratorList,
    list: publishedList,
    sourcePermissionOperations: collaboratorPermissionOperations,
    permissionOperations: publishedPermissionOperations,
    linkPermissionOwner: snapshotLinkPermissionOperation(linkPermissionOperation),
    linkPermissionOperation: snapshotLinkPermissionOperation(linkPermissionOperation),
    permissionFeedbackOwner: snapshotPermissionOperation(permissionFeedbackOperation),
    sourceLogin: login,
    login: login.trim(),
    newRole: role,
    busy,
    addEligible: isOwner && open && !busy && login.trim().length > 0,
    listPending: snapshotListRequest(listPendingOperation),
    addPending: snapshotAddOperation(addPendingOperation),
    sourceAddError: addError,
    addError: currentAddError,
    sourceActionError: actionError,
    actionError: currentActionError,
    linkAccess: doc.linkAccess,
    origin,
    editorLink,
    sourceCopyFeedback: copyFeedback,
    sourceCopyFallback: copyFallback,
    copyStatus,
    copyFallback: currentCopyFallback !== null,
    copyLabel,
    copyCopied: copyStatus === "copied",
    copyCallback: copyText,
    sourceAgentExpansion: agentExpansion,
    agentExpanded,
    agentPanelId,
    removeCollaborator: removeCallbackIdentity,
  });
  const liveFacts = useMemo<ShareLiveFacts>(
    () => ({
      open,
      doc,
      isOwner,
      onOpenChange,
      onDocChange,
      collaboratorList,
      collaboratorPermissionOperations,
      linkPermissionOperation,
      login,
      role,
      busy,
      addError,
      actionError,
      listPending: listPendingOperation,
      addPending: addPendingOperation,
      permissionFeedbackOwner: permissionFeedbackOperation,
      origin,
      copyFeedback,
      copyFallback,
      agentExpansion,
      removeCollaborator: removeCallbackIdentity,
    }),
    [
      actionError,
      addError,
      addPendingOperation,
      agentExpansion,
      busy,
      collaboratorList,
      collaboratorPermissionOperations,
      copyFallback,
      copyFeedback,
      doc,
      isOwner,
      linkPermissionOperation,
      listPendingOperation,
      login,
      onDocChange,
      onOpenChange,
      open,
      origin,
      permissionFeedbackOperation,
      removeCallbackIdentity,
      role,
    ],
  );

  useLayoutEffect(() => {
    liveFactsRef.current = liveFacts;
    return () => {
      if (liveFactsRef.current === liveFacts) liveFactsRef.current = null;
    };
  }, [liveFacts]);

  const runtimeFor = useCallback((candidate: SharePresentation, predecessor: SharePresentation | null = null) => {
    const runtimes = presentationRuntimesRef.current;
    let runtime = runtimes.get(candidate);
    if (!runtime) {
      runtime = {
        active: false,
        retired: false,
        published: false,
        predecessor,
        dialog: null,
        overlay: null,
        portalParent: null,
        close: null,
        root: null,
        form: null,
        loginControl: null,
        login: null,
        newRole: null,
        add: null,
        addError: null,
        actionError: null,
        people: null,
        list: null,
        listState: null,
        retry: null,
        owner: null,
        empty: null,
        editorLink: null,
        linkValue: null,
        linkFallback: null,
        linkCopy: null,
        linkHint: null,
        rows: candidate.list.status === "loaded"
          ? candidate.list.collaborators.map(() => ({ row: null, role: null, remove: null }))
          : [],
        general: null,
        linkAccess: null,
        agent: null,
        agentCard: null,
        agentToggle: null,
        agentPanel: null,
        agentDirectionalIntrinsics: null,
        agentDirectionalCapture: null,
        agentDirectionalPairs: new WeakMap(),
        agentDirectionalFence: null,
        removeNavigation: null,
        removeNavigationPairs: new WeakMap(),
        removeNavigationFence: null,
        controlBindings: new Set(),
        footer: null,
        done: null,
        claims: new Set(),
        mutated: false,
        controlPlacementMutated: false,
        observer: null,
        placementObserver: null,
        observerRetirement: null,
        copyControlMutated: false,
        removeCloseCapture: null,
        closeProvenance: null,
        closeProvenanceRetirement: null,
        placement: null,
      };
      runtimes.set(candidate, runtime);
    }
    return runtime;
  }, []);

  const lineageFor = useCallback((candidate: SharePresentation) => {
    const lineages = presentationLineagesRef.current;
    let lineage = lineages.get(candidate);
    if (!lineage) {
      lineage = { current: candidate };
      lineages.set(candidate, lineage);
    }
    return lineage;
  }, []);

  const currentPresentation = useCallback(
    (candidate: SharePresentation) => presentationLineagesRef.current.get(candidate)?.current ?? candidate,
    [],
  );

  const runtimeForBinding = useCallback(
    (source: SharePresentation) => {
      const lineage = lineageFor(source);
      let candidate = lineage.current;
      let runtime = runtimeFor(candidate);
      if (runtime.retired) {
        const predecessor = candidate;
        candidate = Object.freeze({ ...candidate });
        lineage.current = candidate;
        presentationLineagesRef.current.set(candidate, lineage);
        runtime = runtimeFor(candidate, predecessor);
      }
      const handoff = copyHandoffRef.current;
      if (
        handoff &&
        handoff.successor === null &&
        candidate !== handoff.predecessor
      ) {
        handoff.successor = candidate;
      }
      return { candidate, runtime };
    },
    [lineageFor, runtimeFor],
  );

  const retirePresentation = useCallback((candidate: SharePresentation) => {
    const runtime = presentationRuntimesRef.current.get(candidate);
    const operation = copyOperationRef.current;
    if (
      operation?.action.presentation === candidate &&
      !operation.retired &&
      !operation.settled
    ) {
      const handoff = copyHandoffRef.current;
      if (handoff?.operation === operation && handoff.predecessor === candidate) {
        // Repeated ref/layout cleanup belongs to the same one-hop handoff.
      } else if (
        operation.phase === "pending" &&
        !operation.handoffConsumed &&
        runtime?.active &&
        !runtime.retired &&
        activePresentationRef.current === candidate &&
        handoff === null
      ) {
        copyHandoffRef.current = {
          operation,
          predecessor: candidate,
          successor: null,
        };
      } else {
        retireCopyOperation(candidate);
      }
    }
    if (runtime && !runtime.retired) {
      runtime.active = false;
      runtime.retired = true;
      runtime.agentDirectionalCapture?.release();
      runtime.agentDirectionalCapture = null;
      runtime.agentDirectionalPairs = new WeakMap();
      runtime.agentDirectionalFence = null;
      runtime.removeNavigationPairs = new WeakMap();
      runtime.removeNavigationFence = null;
      runtime.removeNavigation?.retire();
      runtime.removeNavigation = null;
      clearShareCloseProvenance(runtime);
      runtime.removeCloseCapture?.();
      runtime.removeCloseCapture = null;
      if (runtime.observer) {
        const retirement = {};
        runtime.observerRetirement = retirement;
        queueMicrotask(() => {
          if (runtime.observerRetirement === retirement) stopPresentationObservation(runtime);
        });
      }
    }
    if (activePresentationRef.current === candidate) activePresentationRef.current = null;
  }, [retireCopyOperation]);

  const retirePresentationLineage = useCallback(
    (candidate: SharePresentation) => {
      const lineage = presentationLineagesRef.current.get(candidate);
      const current = lineage?.current;
      const active = activePresentationRef.current;
      retirePresentation(candidate);
      if (current && current !== candidate) retirePresentation(current);
      if (
        lineage &&
        active &&
        active !== candidate &&
        active !== current &&
        presentationLineagesRef.current.get(active) === lineage
      ) {
        retirePresentation(active);
      }
    },
    [retirePresentation],
  );

  const schedulePresentationPublication = useCallback(
    (source: SharePresentation, expected: SharePresentation) => {
      queueMicrotask(() => publishPresentationRef.current?.(source, expected));
    },
    [],
  );

  const bindElement = useCallback(
    <
      K extends Exclude<
        keyof SharePresentationRuntime,
        | "active"
        | "retired"
        | "published"
        | "predecessor"
        | "dialog"
        | "overlay"
        | "portalParent"
        | "close"
        | "agentDirectionalIntrinsics"
        | "loginControl"
        | "login"
        | "rows"
        | "controlBindings"
        | "claims"
        | "mutated"
        | "controlPlacementMutated"
        | "observer"
        | "placementObserver"
        | "observerRetirement"
        | "copyControlMutated"
        | "removeCloseCapture"
        | "closeProvenance"
        | "closeProvenanceRetirement"
      >
    >(
      source: SharePresentation,
      kind: K,
      element: SharePresentationRuntime[K],
    ) => {
      if (!element) return;
      const { candidate, runtime } = runtimeForBinding(source);
      const existing = runtime[kind];
      if (existing && existing !== element) {
        retirePresentation(candidate);
        return;
      }
      runtime[kind] = element;
      captureRuntimeDerivedElements(runtime);
      schedulePresentationPublication(source, candidate);
    },
    [retirePresentation, runtimeForBinding, schedulePresentationPublication],
  );

  const bindControlElement = useCallback(
    <K extends ShareControlElementRole>(
      source: SharePresentation,
      kind: K,
      element: SharePresentationRuntime[K],
    ) => {
      const candidate = currentPresentation(source);
      const currentRuntime = presentationRuntimesRef.current.get(candidate);
      if (!element) {
        if (currentRuntime?.[kind]) retirePresentation(candidate);
        return;
      }
      const { candidate: bindingCandidate, runtime } = runtimeForBinding(source);
      const existing = runtime[kind];
      if (existing && existing !== element) {
        retirePresentation(bindingCandidate);
        return;
      }
      runtime[kind] = element;
      runtime.controlBindings.add(kind);
      captureRuntimeDerivedElements(runtime);
      schedulePresentationPublication(source, bindingCandidate);
    },
    [
      currentPresentation,
      retirePresentation,
      runtimeForBinding,
      schedulePresentationPublication,
    ],
  );

  const bindRowElement = useCallback(
    <K extends keyof CollaboratorRowElements>(
      source: SharePresentation,
      row: CollaboratorPublication,
      kind: K,
      element: CollaboratorRowElements[K],
    ) => {
      if (!element) return;
      const { candidate, runtime } = runtimeForBinding(source);
      const elements = runtime.rows[row.index];
      if (
        candidate.list.status !== "loaded" ||
        candidate.list.collaborators[row.index] !== row ||
        !elements
      ) {
        retirePresentation(candidate);
        return;
      }
      const existing = elements[kind];
      if (existing && existing !== element) {
        retirePresentation(candidate);
        return;
      }
      elements[kind] = element;
      captureRuntimeDerivedElements(runtime);
      schedulePresentationPublication(source, candidate);
    },
    [retirePresentation, runtimeForBinding, schedulePresentationPublication],
  );

  const presentationFactsAreCurrent = useCallback((candidate: SharePresentation) => {
    const live = liveFactsRef.current;
    if (
      !live ||
      candidate.mount !== mount ||
      !candidate.open ||
      live.open !== candidate.open ||
      live.doc !== candidate.sourceDocument ||
      !shallowDocumentIsCurrent(live.doc, candidate.document) ||
      live.isOwner !== candidate.isOwner ||
      live.onOpenChange !== candidate.onOpenChange ||
      live.onDocChange !== candidate.onDocChange ||
      shareVisit.current !== candidate.visit ||
      candidate.visit?.documentId !== candidate.document.id ||
      permissionContext.current !== candidate.permissionContext ||
      candidate.permissionContext?.documentId !== candidate.document.id ||
      live.collaboratorList !== candidate.sourceList ||
      !collaboratorListIsCurrent(
        live.collaboratorList,
        candidate.list,
        candidate.document.id,
        live.collaboratorPermissionOperations,
      ) ||
      live.collaboratorPermissionOperations !== candidate.sourcePermissionOperations ||
      live.collaboratorPermissionOperations.size !== candidate.permissionOperations.length ||
      collaboratorPermissionOwners.current.size !== candidate.permissionOperations.length ||
      live.listPending !== candidate.listPending?.source && !(live.listPending === null && candidate.listPending === null) ||
      live.addPending !== candidate.addPending?.source && !(live.addPending === null && candidate.addPending === null) ||
      !listRequestIsCurrent(listPending.current, candidate.listPending) ||
      !addOperationIsCurrent(addPending.current, candidate.addPending) ||
      live.login !== candidate.sourceLogin ||
      live.login.trim() !== candidate.login ||
      live.role !== candidate.newRole ||
      live.busy !== candidate.busy ||
      (live.isOwner && live.open && !live.busy && live.login.trim().length > 0) !== candidate.addEligible ||
      live.addError !== candidate.sourceAddError ||
      (live.addError?.documentId === live.doc.id ? live.addError.message : null) !== candidate.addError ||
      live.actionError !== candidate.sourceActionError ||
      (live.actionError?.operation.documentId === live.doc.id ? live.actionError.message : null) !== candidate.actionError ||
      live.doc.linkAccess !== candidate.linkAccess ||
      live.origin !== candidate.origin ||
      candidate.editorLink !== `${candidate.origin}/d/${candidate.document.id}` ||
      live.copyFeedback !== candidate.sourceCopyFeedback ||
      live.copyFallback !== candidate.sourceCopyFallback ||
      (
        live.copyFeedback?.visit === candidate.visit &&
        live.copyFeedback.value === candidate.editorLink
          ? live.copyFeedback.status
          : "idle"
      ) !== candidate.copyStatus ||
      Boolean(
        candidate.visit &&
        live.copyFallback?.visit === candidate.visit &&
        live.copyFallback.value === candidate.editorLink
      ) !== candidate.copyFallback ||
      candidate.copyLabel !== (
        candidate.copyStatus === "copied"
          ? "Copied"
          : candidate.copyStatus === "fallback"
            ? COPY_FALLBACK_HINT
            : "Copy link"
      ) ||
      candidate.copyCopied !== (candidate.copyStatus === "copied") ||
      candidate.copyCallback !== copyText ||
      live.agentExpansion !== candidate.sourceAgentExpansion ||
      Boolean(
        candidate.visit &&
        live.agentExpansion?.visit === candidate.visit &&
        live.agentExpansion.expanded,
      ) !== candidate.agentExpanded ||
      !candidate.agentPanelId ||
      live.removeCollaborator !== candidate.removeCollaborator ||
      !linkPermissionOperationIsCurrent(linkPermissionOwner.current, candidate.linkPermissionOwner) ||
      !linkPermissionOperationIsCurrent(live.linkPermissionOperation, candidate.linkPermissionOperation) ||
      live.permissionFeedbackOwner !== candidate.permissionFeedbackOwner?.source &&
        !(live.permissionFeedbackOwner === null && candidate.permissionFeedbackOwner === null) ||
      !permissionOperationIsCurrent(permissionFeedbackOwner.current, candidate.permissionFeedbackOwner)
    ) {
      return false;
    }

    const liveEntries = Array.from(live.collaboratorPermissionOperations.entries());
    for (let index = 0; index < candidate.permissionOperations.length; index++) {
      const publication = candidate.permissionOperations[index];
      const entry = liveEntries[index];
      if (
        !entry ||
        entry[0] !== publication.login ||
        !collaboratorPermissionOperationIsCurrent(entry[1], publication) ||
        collaboratorPermissionOwners.current.get(publication.login) !== publication.source
      ) {
        return false;
      }
    }
    return true;
  }, [mount]);

  const presentationDomIsValid = useCallback(
    (candidate: SharePresentation, change?: ShareDomChange) => {
      const runtime = presentationRuntimesRef.current.get(candidate);
      const dialog = runtime?.dialog;
      const root = runtime?.root;
      const ownerWindow = root?.ownerDocument.defaultView;
      if (
        !runtime ||
        runtime.retired ||
        !drainPresentationMutations(runtime) ||
        !ownerWindow ||
        !(dialog instanceof ownerWindow.HTMLDivElement) ||
        !dialog.isConnected ||
        dialog.getAttribute("role") !== "dialog" ||
        !(runtime.overlay instanceof ownerWindow.HTMLDivElement) ||
        !runtime.overlay.isConnected ||
        runtime.overlay.parentElement !== runtime.portalParent ||
        runtime.overlay.nextElementSibling !== dialog ||
        !(runtime.portalParent instanceof ownerWindow.HTMLElement) ||
        dialog.parentElement !== runtime.portalParent ||
        !(runtime.close instanceof ownerWindow.HTMLButtonElement) ||
        runtime.close.type !== "button" ||
        runtime.close.disabled ||
        runtime.close.getAttribute("aria-label") !== "Close" ||
        runtime.close.parentElement !== dialog.firstElementChild ||
        dialog.firstElementChild?.lastElementChild !== runtime.close ||
        dialog.children.length !== 2 ||
        !(root instanceof ownerWindow.HTMLDivElement) ||
        !root.isConnected ||
        root.parentElement !== dialog ||
        dialog.lastElementChild !== root
      ) {
        return false;
      }
      const expectedControlBindings: readonly ShareControlElementRole[] = [
        "linkValue",
        ...(candidate.copyFallback
          ? ["linkFallback" as const]
          : []),
        "linkCopy",
        "agentCard",
        "agentToggle",
        "agentPanel",
      ];
      if (
        runtime.controlBindings.size !== expectedControlBindings.length ||
        expectedControlBindings.some((role) => !runtime.controlBindings.has(role))
      ) {
        return false;
      }

      const expectedRootChildren: Element[] = [];
      if (candidate.isOwner) {
        if (!(runtime.form instanceof ownerWindow.HTMLFormElement)) return false;
        expectedRootChildren.push(runtime.form);
      } else if (runtime.form || runtime.newRole || runtime.add) {
        return false;
      }
      if (candidate.addError) {
        if (!(runtime.addError instanceof ownerWindow.HTMLDivElement)) return false;
        expectedRootChildren.push(runtime.addError);
      } else if (runtime.addError) {
        return false;
      }
      if (candidate.actionError) {
        if (!(runtime.actionError instanceof ownerWindow.HTMLDivElement)) return false;
        expectedRootChildren.push(runtime.actionError);
      } else if (runtime.actionError) {
        return false;
      }
      if (
        !(runtime.people instanceof ownerWindow.HTMLDivElement) ||
        !(runtime.general instanceof ownerWindow.HTMLDivElement) ||
        !(runtime.agent instanceof ownerWindow.HTMLDivElement) ||
        !(runtime.footer instanceof ownerWindow.HTMLDivElement)
      ) {
        return false;
      }
      expectedRootChildren.push(runtime.people, runtime.general, runtime.agent, runtime.footer);
      if (
        root.children.length !== expectedRootChildren.length ||
        expectedRootChildren.some((element, index) => root.children.item(index) !== element)
      ) {
        return false;
      }

      if (candidate.isOwner) {
        const form = runtime.form;
        const loginControl = runtime.loginControl;
        const loginInput = runtime.login;
        const newRole = runtime.newRole;
        const addButton = runtime.add;
        if (
          !(form instanceof ownerWindow.HTMLFormElement) ||
          !form.isConnected ||
          form.parentElement !== root ||
          form.children.length !== 3 ||
          !(loginControl instanceof ownerWindow.HTMLDivElement) ||
          loginControl.parentElement !== form ||
          form.firstElementChild !== loginControl ||
          !(loginInput instanceof ownerWindow.HTMLInputElement) ||
          loginInput.parentElement !== loginControl ||
          loginControl.querySelectorAll('[data-testid="share-login"]').length !== 1 ||
          loginInput.value !== candidate.sourceLogin ||
          loginInput.disabled ||
          loginInput.form !== form ||
          !(newRole instanceof ownerWindow.HTMLSelectElement) ||
          newRole.parentElement !== form ||
          form.children.item(1) !== newRole ||
          newRole.form !== form ||
          !(addButton instanceof ownerWindow.HTMLButtonElement) ||
          addButton.parentElement !== form ||
          form.lastElementChild !== addButton ||
          addButton.type !== "submit" ||
          addButton.disabled === candidate.addEligible ||
          !roleSelectIsExact(
            newRole,
            change?.kind === "new-role" ? change.value : candidate.newRole,
            false,
          )
        ) {
          return false;
        }
      }

      if (
        runtime.addError &&
        (runtime.addError.parentElement !== root ||
          runtime.addError.getAttribute("role") !== "alert" ||
          runtime.addError.textContent !== candidate.addError)
      ) {
        return false;
      }
      if (
        runtime.actionError &&
        (runtime.actionError.parentElement !== root ||
          runtime.actionError.getAttribute("role") !== "alert" ||
          runtime.actionError.textContent !== candidate.actionError)
      ) {
        return false;
      }

      const people = runtime.people;
      const list = runtime.list;
      const editorLink = runtime.editorLink;
      const linkValue = runtime.linkValue;
      const linkFallback = runtime.linkFallback;
      const linkCopy = runtime.linkCopy;
      const linkCopyIcon = linkCopy?.firstElementChild;
      const linkIcon = editorLink?.children.item(0);
      const linkLabel = editorLink?.children.item(1);
      const linkHint = runtime.linkHint;
      const expectedHint =
        candidate.linkAccess === "private"
          ? "Anyone listed above can open this link."
          : LINK_OPTIONS.find((option) => option.value === candidate.linkAccess)?.description;
      if (
        !(list instanceof ownerWindow.HTMLUListElement) ||
        !list.isConnected ||
        list.parentElement !== people ||
        people.children.item(1) !== list ||
        list.getAttribute("aria-label") !== COLLABORATOR_LIST_LABEL ||
        !(editorLink instanceof ownerWindow.HTMLDivElement) ||
        editorLink.parentElement !== people ||
        people.children.item(2) !== editorLink ||
        editorLink.className !== SHARE_LINK_ROW_CLASS ||
        editorLink.getAttribute("data-testid") !== "editor-link" ||
        editorLink.children.length !== 4 ||
        linkIcon?.localName !== "svg" ||
        linkIcon.getAttribute("class") !==
          "lucide lucide-link2 lucide-link-2 shrink-0 text-ink-3" ||
        linkIcon.getAttribute("width") !== "13" ||
        linkIcon.getAttribute("height") !== "13" ||
        linkIcon.getAttribute("aria-hidden") !== "true" ||
        linkLabel?.localName !== "span" ||
        linkLabel.className !== "shrink-0 text-ink-3" ||
        linkLabel.textContent !== "Link:" ||
        editorLink.children.item(2) !== linkValue ||
        editorLink.children.item(3) !== linkCopy ||
        !(linkValue instanceof ownerWindow.HTMLElement) ||
        linkValue.parentElement !== editorLink ||
        (
          !candidate.copyFallback &&
          linkValue.textContent !== candidate.editorLink
        ) ||
        !(linkCopy instanceof ownerWindow.HTMLButtonElement) ||
        linkCopy.parentElement !== editorLink ||
        linkCopy.type !== "button" ||
        linkCopy.disabled ||
        linkCopy.className !== SHARE_LINK_COPY_CLASS ||
        linkCopy.getAttribute("data-testid") !== "copy-link" ||
        linkCopy.getAttribute("aria-label") !== null ||
        linkCopy.textContent?.trim() !== candidate.copyLabel ||
        linkCopy.children.length !== 1 ||
        linkCopyIcon?.localName !== "svg" ||
        linkCopyIcon.getAttribute("class") !== (
          candidate.copyCopied
            ? "lucide lucide-check text-success"
            : "lucide lucide-copy"
        ) ||
        linkCopyIcon.getAttribute("width") !== "14" ||
        linkCopyIcon.getAttribute("height") !== "14" ||
        linkCopyIcon.getAttribute("aria-hidden") !== "true" ||
        !(linkHint instanceof ownerWindow.HTMLParagraphElement) ||
        linkHint.parentElement !== people ||
        people.children.item(3) !== linkHint ||
        linkHint.textContent !== expectedHint ||
        people.children.length !== 4
      ) {
        return false;
      }
      if (candidate.copyFallback) {
        if (
          !(linkFallback instanceof ownerWindow.HTMLInputElement) ||
          linkValue !== linkFallback ||
          linkFallback.className !== SHARE_LINK_INPUT_CLASS ||
          linkFallback.value !== candidate.editorLink ||
          !linkFallback.readOnly ||
          linkFallback.getAttribute("aria-label") !== "Document link" ||
          linkFallback.getAttribute("data-testid") !== "copy-link-fallback" ||
          linkFallback.children.length !== 0
        ) {
          return false;
        }
      } else if (
        linkFallback ||
        linkValue.localName !== "code" ||
        linkValue.className !== SHARE_LINK_CODE_CLASS
      ) {
        return false;
      }

      const expectedListChildren: Element[] = [];
      if (candidate.list.status === "none" || candidate.list.status === "loading") {
        if (
          !(runtime.listState instanceof ownerWindow.HTMLLIElement) ||
          runtime.listState.getAttribute("role") !== "status" ||
          runtime.retry ||
          runtime.owner ||
          runtime.empty ||
          runtime.rows.length !== 0
        ) {
          return false;
        }
        expectedListChildren.push(runtime.listState);
      } else if (candidate.list.status === "error") {
        if (
          !(runtime.listState instanceof ownerWindow.HTMLLIElement) ||
          runtime.listState.getAttribute("role") !== "alert" ||
          !(runtime.retry instanceof ownerWindow.HTMLButtonElement) ||
          runtime.retry.parentElement !== runtime.listState ||
          runtime.retry.disabled !== candidate.list.retrying ||
          runtime.retry.type !== "button" ||
          runtime.retry.textContent?.trim() !== (candidate.list.retrying ? "Retrying…" : "Retry") ||
          runtime.owner ||
          runtime.empty ||
          runtime.rows.length !== 0
        ) {
          return false;
        }
        expectedListChildren.push(runtime.listState);
      } else {
        if (runtime.listState || runtime.retry || runtime.rows.length !== candidate.list.collaborators.length) {
          return false;
        }
        if (candidate.list.owner) {
          if (!(runtime.owner instanceof ownerWindow.HTMLLIElement)) return false;
          expectedListChildren.push(runtime.owner);
        } else if (runtime.owner) {
          return false;
        }
        for (const row of candidate.list.collaborators) {
          const elements = runtime.rows[row.index];
          if (
            !elements ||
            !(elements.row instanceof ownerWindow.HTMLLIElement) ||
            !elements.row.isConnected ||
            elements.row.parentElement !== list ||
            elements.row.dataset.login !== row.login
          ) {
            return false;
          }
          expectedListChildren.push(elements.row);
          if (candidate.isOwner) {
            const roleElement = elements.role;
            const removeElement = elements.remove;
            const expectedValue =
              change?.kind === "collaborator-role" && change.row === row ? change.value : row.role;
            if (
              !(roleElement instanceof ownerWindow.HTMLSelectElement) ||
              roleElement.parentElement !== elements.row ||
              elements.row.children.item(elements.row.children.length - 2) !== roleElement ||
              roleElement.form !== null ||
              !roleSelectIsExact(roleElement, expectedValue, row.pending) ||
              !(removeElement instanceof ownerWindow.HTMLButtonElement) ||
              removeElement.parentElement !== elements.row ||
              elements.row.lastElementChild !== removeElement ||
              removeElement.form !== null ||
              removeElement.type !== "button" ||
              removeElement.disabled !== row.pending ||
              removeElement.getAttribute("aria-label") !== `Remove ${row.login}`
            ) {
              return false;
            }
          } else if (elements.role || elements.remove) {
            return false;
          }
        }
        if (candidate.list.collaborators.length === 0) {
          if (!(runtime.empty instanceof ownerWindow.HTMLLIElement)) return false;
          expectedListChildren.push(runtime.empty);
        } else if (runtime.empty) {
          return false;
        }
      }
      if (
        list.children.length !== expectedListChildren.length ||
        expectedListChildren.some((element, index) => list.children.item(index) !== element)
      ) {
        return false;
      }

      const linkPending =
        candidate.linkPermissionOperation?.documentId === candidate.document.id;
      if (candidate.isOwner) {
        const linkAccessElement = runtime.linkAccess;
        if (
          !(linkAccessElement instanceof ownerWindow.HTMLSelectElement) ||
          !linkAccessElement.isConnected ||
          !runtime.general.contains(linkAccessElement) ||
          runtime.general.querySelectorAll('[data-testid="link-access"]').length !== 1 ||
          linkAccessElement.form !== null ||
          !linkSelectIsExact(
            linkAccessElement,
            change?.kind === "link-access" ? change.value : candidate.linkAccess,
            linkPending,
          )
        ) {
          return false;
        }
      } else if (runtime.linkAccess || runtime.general.querySelector('[data-testid="link-access"]')) {
        return false;
      }

      const agent = runtime.agent;
      const agentCard = runtime.agentCard;
      const agentToggle = runtime.agentToggle;
      const agentPanel = runtime.agentPanel;
      const agentLeadingIcon = agentToggle?.children.item(0);
      const agentLabels = agentToggle?.children.item(1);
      const agentChevron = agentToggle?.children.item(2);
      if (
        !(agent instanceof ownerWindow.HTMLDivElement) ||
        !(agentCard instanceof ownerWindow.HTMLElement) ||
        agent.children.length !== 1 ||
        agent.firstElementChild !== agentCard ||
        agentCard.localName !== "section" ||
        agentCard.className !== AGENT_CARD_CLASS ||
        agentCard.getAttribute("aria-label") !== "Collaborate with an agent" ||
        agentCard.getAttribute("data-testid") !== "share-agent-card" ||
        agentCard.children.length !== 2 ||
        !(agentToggle instanceof ownerWindow.HTMLButtonElement) ||
        agentCard.firstElementChild !== agentToggle ||
        agentToggle.type !== "button" ||
        agentToggle.disabled ||
        agentToggle.className !== AGENT_TOGGLE_CLASS ||
        agentToggle.getAttribute("aria-expanded") !== String(candidate.agentExpanded) ||
        agentToggle.getAttribute("aria-controls") !== candidate.agentPanelId ||
        agentToggle.getAttribute("data-testid") !== "share-agent-toggle" ||
        agentToggle.children.length !== 3 ||
        agentLeadingIcon?.localName !== "span" ||
        agentLeadingIcon.className !==
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/60 dark:text-violet-300" ||
        agentLeadingIcon.children.length !== 1 ||
        agentLeadingIcon.firstElementChild?.getAttribute("class") !== "lucide lucide-bot" ||
        agentLeadingIcon.firstElementChild?.getAttribute("width") !== "15" ||
        agentLeadingIcon.firstElementChild?.getAttribute("height") !== "15" ||
        agentLeadingIcon.firstElementChild?.getAttribute("aria-hidden") !== "true" ||
        agentLabels?.localName !== "span" ||
        agentLabels.className !== "min-w-0 flex-1" ||
        agentLabels.children.length !== 2 ||
        agentLabels.children.item(0)?.className !== "block text-sm font-medium text-ink" ||
        agentLabels.children.item(0)?.textContent !== "Collaborate with an agent" ||
        agentLabels.children.item(1)?.className !== "block truncate text-xs text-ink-3" ||
        agentLabels.children.item(1)?.textContent !==
          "Connect Copilot CLI or any MCP client as a collaborator" ||
        agentChevron?.localName !== "svg" ||
        agentChevron.getAttribute("class") !== cn(
          "lucide lucide-chevron-down shrink-0 text-ink-3 transition-transform",
          candidate.agentExpanded && "rotate-180",
        ) ||
        agentChevron.getAttribute("width") !== "16" ||
        agentChevron.getAttribute("height") !== "16" ||
        agentChevron.getAttribute("aria-hidden") !== "true" ||
        !(agentPanel instanceof ownerWindow.HTMLDivElement) ||
        agentCard.children.item(1) !== agentPanel ||
        agentPanel.id !== candidate.agentPanelId ||
        agentPanel.hidden === candidate.agentExpanded ||
        agentPanel.className !== AGENT_PANEL_CLASS ||
        agentPanel.children.length !== (candidate.agentExpanded ? 1 : 0) ||
        (
          candidate.agentExpanded &&
          agentPanel.firstElementChild?.getAttribute("data-testid") !== "token-manager"
        )
      ) {
        return false;
      }

      const done = runtime.done;
      if (
        !(done instanceof ownerWindow.HTMLButtonElement) ||
        !done.isConnected ||
        done.parentElement !== runtime.footer ||
        done.form !== null ||
        runtime.footer.children.length !== 1 ||
        runtime.footer.firstElementChild !== done ||
        done.type !== "button" ||
        done.disabled ||
        done.textContent?.trim() !== "Done"
      ) {
        return false;
      }
      return true;
    },
    [],
  );

  const presentationIsCurrent = useCallback(
    (source: SharePresentation, change?: ShareDomChange) => {
      const candidate = currentPresentation(source);
      return (
        activePresentationRef.current === candidate &&
        presentationRuntimesRef.current.get(candidate)?.active === true &&
        presentationFactsAreCurrent(candidate) &&
        presentationDomIsValid(candidate, change)
      );
    },
    [currentPresentation, presentationDomIsValid, presentationFactsAreCurrent],
  );

  const claim = useCallback(
    (source: SharePresentation, key: string, change?: ShareDomChange) => {
      const candidate = currentPresentation(source);
      const runtime = presentationRuntimesRef.current.get(candidate);
      if (!runtime || runtime.claims.has(key)) return false;
      if (!presentationIsCurrent(source, change)) {
        retirePresentation(candidate);
        return false;
      }
      runtime.claims.add(key);
      return true;
    },
    [currentPresentation, presentationIsCurrent, retirePresentation],
  );

  const controlPlacementIsCurrent = useCallback((candidate: SharePresentation) => {
    const runtime = presentationRuntimesRef.current.get(candidate);
    const root = runtime?.root;
    if (!runtime || !runtime.placement || !root) return false;
    drainPresentationMutations(runtime);
    return (
      !runtime.controlPlacementMutated &&
      sharePlacementMatches(root.ownerDocument, runtime.placement)
    );
  }, []);

  const claimControlEvent = useCallback((
    source: SharePresentation,
    key: string,
    action: object,
    event: ReactMouseEvent<HTMLButtonElement>,
    control: HTMLButtonElement,
  ) => {
    const candidate = currentPresentation(source);
    const nativeEvent = event?.nativeEvent;
    if (
      !Object.isFrozen(action) ||
      claimedControlActionsRef.current.has(action) ||
      claimedControlEventsRef.current.has(event) ||
      !(nativeEvent instanceof Event) ||
      claimedNativeControlEventsRef.current.has(nativeEvent) ||
      claimedControlElementsRef.current.get(control) === action ||
      !isExactTraversedNativeClick(event, control) ||
      !controlPlacementIsCurrent(candidate) ||
      !claim(source, key)
    ) {
      return false;
    }
    claimedControlActionsRef.current.add(action);
    claimedControlEventsRef.current.add(event);
    claimedNativeControlEventsRef.current.add(nativeEvent);
    claimedControlElementsRef.current.set(control, action);
    return true;
  }, [claim, controlPlacementIsCurrent, currentPresentation]);

  const claimCopyLink = (
    source: SharePresentation,
    event: ReactMouseEvent<HTMLButtonElement>,
  ): Readonly<ShareCopyAction> | null => {
    const candidate = currentPresentation(source);
    const runtime = presentationRuntimesRef.current.get(candidate);
    const control = runtime?.linkCopy;
    const visit = candidate.visit;
    if (
      !control ||
      control !== event.currentTarget ||
      !visit ||
      !candidate.editorLink ||
      candidate.editorLink !== `${candidate.origin}/d/${candidate.document.id}` ||
      candidate.copyCallback !== copyText
    ) {
      return null;
    }
    const action = Object.freeze({
      presentation: candidate,
      visit,
      value: candidate.editorLink,
      callback: candidate.copyCallback,
      control,
    });
    return claimControlEvent(candidate, "copy-link", action, event, control)
      ? action
      : null;
  };

  const copyOperationIsCurrent = (operation: ShareCopyOperation) =>
    copyOperationRef.current === operation &&
    !operation.retired &&
    !operation.settled &&
    presentationIsCurrent(operation.action.presentation) &&
    controlPlacementIsCurrent(operation.action.presentation);

  const adoptCopyLinkAfterFeedback = (
    action: Readonly<ShareCopyAction>,
  ): Readonly<ShareCopyAction> | null => {
    const candidate = activePresentationRef.current;
    if (!candidate) return null;
    const runtime = presentationRuntimesRef.current.get(candidate);
    if (
      candidate === action.presentation ||
      candidate.visit !== action.visit ||
      candidate.copyStatus !== "idle" ||
      candidate.sourceCopyFeedback !== null ||
      candidate.editorLink !== action.value ||
      candidate.copyCallback !== action.callback ||
      runtime?.linkCopy !== action.control ||
      runtime.claims.has("copy-link") ||
      !claimedControlActionsRef.current.has(action) ||
      claimedControlElementsRef.current.get(action.control) !== action ||
      !presentationIsCurrent(candidate) ||
      !controlPlacementIsCurrent(candidate)
    ) {
      return null;
    }
    const adopted = Object.freeze({
      presentation: candidate,
      visit: action.visit,
      value: action.value,
      callback: action.callback,
      control: action.control,
    });
    runtime.claims.add("copy-link");
    claimedControlActionsRef.current.add(adopted);
    claimedControlElementsRef.current.set(action.control, adopted);
    return adopted;
  };

  const drainRejectedPromise = (
    value: unknown,
    ownerWindow: Window & typeof globalThis,
  ) => {
    try {
      if (!(value instanceof ownerWindow.Promise)) return;
      ownerWindow.Promise.prototype.then.call(value, undefined, () => undefined);
    } catch {
      // A stale hostile thenable cannot be allowed to reach the successor.
    }
  };

  const beginCopyLink = (claimedAction: Readonly<ShareCopyAction>) => {
    let action = claimedAction;
    const existingFeedback = copyFeedbackRef.current;
    if (existingFeedback) {
      const timer = copyFeedbackTimersRef.current.get(existingFeedback);
      if (timer !== undefined) {
        action.control.ownerDocument.defaultView?.clearTimeout(timer);
        copyFeedbackTimersRef.current.delete(existingFeedback);
      }
      copyFeedbackRef.current = null;
      flushSync(() => {
        setCopyFeedback((current) => current === existingFeedback ? null : current);
      });
      const adopted = adoptCopyLinkAfterFeedback(action);
      if (!adopted) return;
      action = adopted;
    }

    const operation: ShareCopyOperation = {
      action,
      phase: "invoking",
      handoffConsumed: false,
      settled: false,
      retired: false,
    };
    copyOperationRef.current = operation;
    const ownerWindow = action.control.ownerDocument.defaultView;
    if (!ownerWindow) {
      retireCopyOperation(action.presentation);
      return;
    }

    const settle = (ok: boolean) => {
      if (!copyOperationIsCurrent(operation)) {
        if (copyOperationRef.current === operation) {
          if (copyHandoffRef.current?.operation === operation) copyHandoffRef.current = null;
          operation.settled = true;
          operation.retired = true;
          copyOperationRef.current = null;
        }
        return;
      }
      operation.settled = true;
      copyOperationRef.current = null;
      const feedback: ShareCopyFeedback = Object.freeze({
        visit: action.visit,
        value: action.value,
        status: ok ? "copied" : "fallback",
      });
      copyFeedbackRef.current = feedback;
      if (ok) {
        setCopyFallback((current) =>
          current?.visit === action.visit && current.value === action.value
            ? null
            : current
        );
      } else {
        setCopyFallback(Object.freeze({
          visit: action.visit,
          value: action.value,
        }));
      }
      setCopyFeedback(feedback);
      const timer = ownerWindow.setTimeout(() => {
        if (
          copyFeedbackRef.current !== feedback ||
          copyFeedbackTimersRef.current.get(feedback) !== timer
        ) {
          return;
        }
        copyFeedbackTimersRef.current.delete(feedback);
        copyFeedbackRef.current = null;
        setCopyFeedback((current) => current === feedback ? null : current);
      }, ok ? 1500 : 2000);
      copyFeedbackTimersRef.current.set(feedback, timer);
    };

    let attempt: unknown;
    try {
      attempt = (action.callback as (value: string) => unknown)(action.value);
    } catch {
      settle(false);
      return;
    }
    if (!copyOperationIsCurrent(operation)) {
      drainRejectedPromise(attempt, ownerWindow);
      return;
    }
    if (
      attempt === null ||
      (typeof attempt !== "object" && typeof attempt !== "function")
    ) {
      settle(attempt === true);
      return;
    }

    operation.phase = "attaching";
    let then: unknown;
    try {
      then = Reflect.get(attempt, "then");
    } catch {
      settle(false);
      return;
    }
    if (!copyOperationIsCurrent(operation)) {
      drainRejectedPromise(attempt, ownerWindow);
      return;
    }
    if (typeof then !== "function") {
      settle(false);
      return;
    }
    try {
      Reflect.apply(then, attempt, [
        (ok: unknown) => settle(ok === true),
        () => settle(false),
      ]);
      if (copyOperationIsCurrent(operation)) operation.phase = "pending";
    } catch {
      settle(false);
    }
  };

  const transferPendingCopyOperation = useCallback((
    candidate: SharePresentation,
    runtime: SharePresentationRuntime,
    placement: SharePlacementChain,
  ) => {
    const operation = copyOperationRef.current;
    if (!operation || operation.action.presentation === candidate) return;
    const previous = operation.action.presentation;
    const handoff = copyHandoffRef.current;
    const previousRuntime = presentationRuntimesRef.current.get(previous);
    if (previousRuntime) drainPresentationMutations(previousRuntime);
    const ownerDocument = runtime.root?.ownerDocument;
    const previousPlacement = previousRuntime?.placement;
    if (
      operation.retired ||
      operation.settled ||
      operation.phase !== "pending" ||
      handoff?.operation !== operation ||
      handoff.predecessor !== previous ||
      handoff.successor !== candidate ||
      !previousRuntime ||
      !previousRuntime.retired ||
      !previousRuntime.claims.has("copy-link") ||
      previousRuntime.copyControlMutated ||
      previousRuntime.controlPlacementMutated ||
      !previousPlacement ||
      !ownerDocument ||
      previousRuntime.editorLink !== runtime.editorLink ||
      previousRuntime.linkValue !== runtime.linkValue ||
      previousRuntime.linkCopy !== operation.action.control ||
      runtime.linkCopy !== operation.action.control ||
      operation.action.control.ownerDocument !== ownerDocument ||
      candidate.visit !== operation.action.visit ||
      candidate.editorLink !== operation.action.value ||
      candidate.copyCallback !== operation.action.callback ||
      runtime.claims.has("copy-link") ||
      !sharePlacementMatches(ownerDocument, previousPlacement) ||
      !sharePlacementsAreExactReplay(previousPlacement, placement)
    ) {
      retireCopyOperation(previous);
      return;
    }
    const action = Object.freeze({
      presentation: candidate,
      visit: operation.action.visit,
      value: operation.action.value,
      callback: operation.action.callback,
      control: operation.action.control,
    });
    operation.action = action;
    operation.handoffConsumed = true;
    copyHandoffRef.current = null;
    runtime.claims.add("copy-link");
    claimedControlActionsRef.current.add(action);
    claimedControlElementsRef.current.set(action.control, action);
  }, [retireCopyOperation]);

  const claimAgentToggle = (
    source: SharePresentation,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    const candidate = currentPresentation(source);
    const runtime = presentationRuntimesRef.current.get(candidate);
    const control = runtime?.agentToggle;
    const visit = candidate.visit;
    if (
      !control ||
      control !== event.currentTarget ||
      !visit ||
      candidate.sourceAgentExpansion !== agentExpansion
    ) {
      return null;
    }
    const action = Object.freeze({
      presentation: candidate,
      visit,
      expanded: candidate.agentExpanded,
      nextExpanded: !candidate.agentExpanded,
      control,
    });
    return claimControlEvent(candidate, "agent-toggle", action, event, control)
      ? action
      : null;
  };

  const publishAgentDirectionalKey = (
    source: SharePresentation,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    const candidate = currentPresentation(source);
    const runtime = presentationRuntimesRef.current.get(candidate);
    const card = runtime?.agentCard;
    const control = runtime?.agentToggle;
    const panel = runtime?.agentPanel;
    const intrinsics = runtime?.agentDirectionalIntrinsics;
    const registration = runtime?.agentDirectionalCapture;
    const visit = candidate.visit;
    const permissionContext = candidate.permissionContext;
    let nativeEvent: Event;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return null;
    }
    if (!nativeEvent || typeof nativeEvent !== "object") return null;
    const snapshot = intrinsics && nativeEvent
      ? readShareDirectionalNativeEvent(nativeEvent, intrinsics)
      : null;
    const stage =
      registration &&
      intrinsics &&
      intrinsics.getPrototypeOf(nativeEvent) === intrinsics.keyboardPrototype
        ? registration.proofFor(nativeEvent as KeyboardEvent)
        : null;
    const nextExpanded = snapshot
      ? shareDirectionalDestination(snapshot.key, candidate.agentExpanded)
      : null;
    if (
      !runtime ||
      !card ||
      !control ||
      !panel ||
      !intrinsics ||
      !registration ||
      !stage ||
      !visit ||
      !permissionContext ||
      !snapshot ||
      nextExpanded === null ||
      runtime.agentDirectionalFence !== null ||
      runtime.agentDirectionalPairs.has(stage.nativeEvent) ||
      control !== event.currentTarget ||
      card.ownerDocument !== control.ownerDocument ||
      panel.ownerDocument !== control.ownerDocument ||
      candidate.sourceAgentExpansion !== agentExpansion
    ) {
      return null;
    }
    const ownerDocument = control.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (
      !ownerWindow ||
      intrinsics.apply(intrinsics.activeElement, ownerDocument, []) !== control
    ) {
      return;
    }
    const action = Object.freeze<ShareAgentDirectionalAction>({
      presentation: candidate,
      visit,
      permissionContext,
      documentId: candidate.document.id,
      origin: candidate.origin,
      expanded: candidate.agentExpanded,
      nextExpanded,
      card,
      control,
      panel,
    });
    const capture = captureShareDirectionalReactEvent(
      event,
      nativeEvent,
      snapshot,
      control,
      ownerDocument,
      ownerWindow,
      intrinsics,
      intrinsics.capturingPhase,
    );
    if (
      !Object.isFrozen(action) ||
      claimedControlActionsRef.current.has(action) ||
      claimedControlEventsRef.current.has(event) ||
      claimedNativeControlEventsRef.current.has(nativeEvent) ||
      claimedControlElementsRef.current.get(control) === action ||
      !capture ||
      !shareDirectionalStageMatches(
        stage,
        registration,
        stage.nativeEvent,
        snapshot,
        control,
        ownerDocument,
        ownerWindow,
        intrinsics,
      ) ||
      !controlPlacementIsCurrent(candidate) ||
      !presentationIsCurrent(candidate)
    ) {
      return;
    }
    const pair: ShareDirectionalPair<
      SharePresentation,
      ShareAgentDirectionalAction
    > = {
      publication: candidate,
      action,
      nativeEvent: stage.nativeEvent,
      stage,
      capture,
    };
    Object.freeze(pair);
    runtime.agentDirectionalPairs.set(stage.nativeEvent, pair);
    runtime.agentDirectionalFence = pair;
    const revalidate = () => {
      const currentSnapshot = readShareDirectionalNativeEvent(
        stage.nativeEvent,
        intrinsics,
      );
      return Boolean(
        currentSnapshot &&
        runtime.agentDirectionalFence === pair &&
        runtime.agentDirectionalPairs.get(stage.nativeEvent) === pair &&
        runtime.agentDirectionalCapture === registration &&
        registration.retains(stage) &&
        action.presentation === candidate &&
        action.visit === candidate.visit &&
        action.permissionContext === candidate.permissionContext &&
        action.documentId === candidate.document.id &&
        action.origin === candidate.origin &&
        action.expanded === candidate.agentExpanded &&
        action.nextExpanded ===
          shareDirectionalDestination(
            currentSnapshot.key,
            candidate.agentExpanded,
          ) &&
        action.card === runtime.agentCard &&
        action.control === runtime.agentToggle &&
        action.panel === runtime.agentPanel &&
        shareDirectionalNativeSnapshotsMatch(
          stage.snapshot,
          currentSnapshot,
        ) &&
        shareDirectionalReactSnapshotIsCurrent(
          capture,
          stage.nativeEvent,
          currentSnapshot,
          control,
          ownerDocument,
          ownerWindow,
          intrinsics,
          intrinsics.capturingPhase,
          control,
          false,
          capture.methods.isDefaultPrevented,
        ) &&
        controlPlacementIsCurrent(candidate) &&
        presentationIsCurrent(candidate),
      );
    };
    try {
      if (
        !revalidate() ||
        !queryShareDirectionalReactMethod(
          capture,
          capture.methods.isDefaultPrevented,
          false,
          intrinsics,
          revalidate,
        ) ||
        !queryShareDirectionalReactMethod(
          capture,
          capture.methods.isPropagationStopped,
          false,
          intrinsics,
          revalidate,
        )
      ) {
        runtime.agentDirectionalPairs.delete(stage.nativeEvent);
      }
    } finally {
      if (runtime.agentDirectionalFence === pair) {
        runtime.agentDirectionalFence = null;
      }
    }
  };

  const claimAgentDirectionalKey = (
    source: SharePresentation,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    const candidate = currentPresentation(source);
    const runtime = presentationRuntimesRef.current.get(candidate);
    let nativeEvent: Event;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return null;
    }
    if (!nativeEvent || typeof nativeEvent !== "object") return null;
    const intrinsics = runtime?.agentDirectionalIntrinsics;
    const pairKey =
      intrinsics &&
      intrinsics.getPrototypeOf(nativeEvent) === intrinsics.keyboardPrototype
        ? nativeEvent as KeyboardEvent
        : null;
    const pair =
      runtime && pairKey
        ? runtime.agentDirectionalPairs.get(pairKey)
        : undefined;
    const action = pair?.action;
    const snapshot = intrinsics && nativeEvent
      ? readShareDirectionalNativeEvent(nativeEvent, intrinsics)
      : null;
    if (
      !runtime ||
      !pair ||
      !action ||
      !intrinsics ||
      !snapshot ||
      runtime.agentDirectionalFence !== null ||
      pair.publication !== candidate ||
      pair.action !== action ||
      pair.nativeEvent !== nativeEvent ||
      pair.capture.nativeEvent !== nativeEvent ||
      pair.capture.event === event ||
      claimedDirectionalPairsRef.current.has(pair) ||
      action.presentation !== candidate ||
      action.visit !== candidate.visit ||
      action.permissionContext !== candidate.permissionContext ||
      action.documentId !== candidate.document.id ||
      action.origin !== candidate.origin ||
      action.expanded !== candidate.agentExpanded ||
      action.nextExpanded !==
        shareDirectionalDestination(snapshot.key, candidate.agentExpanded) ||
      action.card !== runtime.agentCard ||
      action.control !== runtime.agentToggle ||
      action.panel !== runtime.agentPanel ||
      claimedDirectionalPairsRef.current.has(pair) ||
      claimedControlActionsRef.current.has(action) ||
      claimedControlEventsRef.current.has(pair.capture.event) ||
      claimedControlEventsRef.current.has(event) ||
      claimedNativeControlEventsRef.current.has(nativeEvent) ||
      claimedControlElementsRef.current.get(action.control) === action
    ) {
      return null;
    }
    const ownerDocument = action.control.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const bubble = ownerWindow
      ? captureShareDirectionalReactEvent(
          event,
          nativeEvent,
          snapshot,
          action.control,
          ownerDocument,
          ownerWindow,
          intrinsics,
          intrinsics.bubblingPhase,
        )
      : null;
    if (
      !ownerWindow ||
      !bubble ||
      pair.capture.target !== bubble.target ||
      pair.capture.currentTarget !== bubble.currentTarget ||
      pair.capture.eventPhase !== intrinsics.capturingPhase ||
      bubble.eventPhase !== intrinsics.bubblingPhase ||
      !shareDirectionalStageMatches(
        pair.stage,
        pair.stage.registration,
        pair.nativeEvent,
        snapshot,
        action.control,
        ownerDocument,
        ownerWindow,
        intrinsics,
      ) ||
      !shareDirectionalNativeSnapshotsMatch(
        pair.stage.snapshot,
        snapshot,
      ) ||
      intrinsics.apply(intrinsics.activeElement, ownerDocument, []) !==
        action.control ||
      !controlPlacementIsCurrent(candidate) ||
      !presentationIsCurrent(candidate)
    ) {
      return null;
    }
    runtime.agentDirectionalFence = pair;
    const registration = pair.stage.registration;
    const revalidate = (
      expectedNativeDefaultPrevented: boolean,
      bubbleDefaultQuery: ShareDirectionalReactMethod,
    ) => {
      const currentSnapshot = readShareDirectionalNativeEvent(
        pair.nativeEvent,
        intrinsics,
      );
      return Boolean(
        currentSnapshot &&
        runtime.agentDirectionalFence === pair &&
        runtime.agentDirectionalPairs.get(pair.nativeEvent) === pair &&
        runtime.agentDirectionalCapture === registration &&
        registration.retains(pair.stage) &&
        pair.publication === candidate &&
        pair.action === action &&
        action.presentation === candidate &&
        action.visit === candidate.visit &&
        action.permissionContext === candidate.permissionContext &&
        action.documentId === candidate.document.id &&
        action.origin === candidate.origin &&
        action.expanded === candidate.agentExpanded &&
        action.nextExpanded ===
          shareDirectionalDestination(
            currentSnapshot.key,
            candidate.agentExpanded,
          ) &&
        action.card === runtime.agentCard &&
        action.control === runtime.agentToggle &&
        action.panel === runtime.agentPanel &&
        shareDirectionalNativeSnapshotsMatch(
          pair.stage.snapshot,
          currentSnapshot,
          expectedNativeDefaultPrevented,
        ) &&
        shareDirectionalReactSnapshotIsCurrent(
          pair.capture,
          pair.nativeEvent,
          pair.stage.snapshot,
          action.control,
          ownerDocument,
          ownerWindow,
          intrinsics,
          intrinsics.capturingPhase,
          null,
          false,
          pair.capture.methods.isDefaultPrevented,
        ) &&
        shareDirectionalReactSnapshotIsCurrent(
          bubble,
          pair.nativeEvent,
          currentSnapshot,
          action.control,
          ownerDocument,
          ownerWindow,
          intrinsics,
          intrinsics.bubblingPhase,
          action.control,
          expectedNativeDefaultPrevented,
          bubbleDefaultQuery,
        ) &&
        intrinsics.apply(intrinsics.activeElement, ownerDocument, []) ===
          action.control &&
        controlPlacementIsCurrent(candidate) &&
        presentationIsCurrent(candidate),
      );
    };
    try {
      if (
        !revalidate(false, bubble.methods.isDefaultPrevented) ||
        !queryShareDirectionalReactMethod(
          pair.capture,
          pair.capture.methods.isDefaultPrevented,
          false,
          intrinsics,
          () => revalidate(false, bubble.methods.isDefaultPrevented),
        ) ||
        !queryShareDirectionalReactMethod(
          pair.capture,
          pair.capture.methods.isPropagationStopped,
          false,
          intrinsics,
          () => revalidate(false, bubble.methods.isDefaultPrevented),
        ) ||
        !queryShareDirectionalReactMethod(
          bubble,
          bubble.methods.isDefaultPrevented,
          false,
          intrinsics,
          () => revalidate(false, bubble.methods.isDefaultPrevented),
        ) ||
        !queryShareDirectionalReactMethod(
          bubble,
          bubble.methods.isPropagationStopped,
          false,
          intrinsics,
          () => revalidate(false, bubble.methods.isDefaultPrevented),
        ) ||
        claimedDirectionalPairsRef.current.has(pair) ||
        claimedControlActionsRef.current.has(action) ||
        claimedControlEventsRef.current.has(pair.capture.event) ||
        claimedControlEventsRef.current.has(event) ||
        claimedNativeControlEventsRef.current.has(nativeEvent) ||
        claimedControlElementsRef.current.get(action.control) === action ||
        !registration.claim(pair.stage)
      ) {
        return null;
      }
      claimedDirectionalPairsRef.current.add(pair);
      claimedControlActionsRef.current.add(action);
      claimedControlEventsRef.current.add(pair.capture.event);
      claimedControlEventsRef.current.add(event);
      claimedNativeControlEventsRef.current.add(nativeEvent);
      claimedControlElementsRef.current.set(action.control, action);
      runtime.agentDirectionalPairs.delete(pair.nativeEvent);
      const claimedIsCurrent = (
        expectedNativeDefaultPrevented: boolean,
        bubbleDefaultQuery: ShareDirectionalReactMethod,
      ) => {
        const currentSnapshot = readShareDirectionalNativeEvent(
          pair.nativeEvent,
          intrinsics,
        );
        return Boolean(
          currentSnapshot &&
          runtime.agentDirectionalFence === pair &&
          !runtime.agentDirectionalPairs.has(pair.nativeEvent) &&
          runtime.agentDirectionalCapture === registration &&
          registration.retains(pair.stage) &&
          claimedDirectionalPairsRef.current.has(pair) &&
          claimedControlActionsRef.current.has(action) &&
          claimedControlEventsRef.current.has(pair.capture.event) &&
          claimedControlEventsRef.current.has(event) &&
          claimedNativeControlEventsRef.current.has(nativeEvent) &&
          claimedControlElementsRef.current.get(action.control) === action &&
          action.permissionContext === candidate.permissionContext &&
          shareDirectionalNativeSnapshotsMatch(
            pair.stage.snapshot,
            currentSnapshot,
            expectedNativeDefaultPrevented,
          ) &&
          shareDirectionalReactSnapshotIsCurrent(
            pair.capture,
            pair.nativeEvent,
            pair.stage.snapshot,
            action.control,
            ownerDocument,
            ownerWindow,
            intrinsics,
            intrinsics.capturingPhase,
            null,
            false,
            pair.capture.methods.isDefaultPrevented,
          ) &&
          shareDirectionalReactSnapshotIsCurrent(
            bubble,
            pair.nativeEvent,
            currentSnapshot,
            action.control,
            ownerDocument,
            ownerWindow,
            intrinsics,
            intrinsics.bubblingPhase,
            action.control,
            expectedNativeDefaultPrevented,
            bubbleDefaultQuery,
          ) &&
          intrinsics.apply(intrinsics.activeElement, ownerDocument, []) ===
            action.control &&
          controlPlacementIsCurrent(candidate) &&
          presentationIsCurrent(candidate),
        );
      };
      if (
        !claimedIsCurrent(false, bubble.methods.isDefaultPrevented) ||
        !callShareDirectionalReactMethod(
          bubble,
          bubble.methods.preventDefault,
          intrinsics,
          () => {
            const currentDefaultQuery = event.isDefaultPrevented;
            return (
              typeof currentDefaultQuery === "function" &&
              claimedIsCurrent(true, currentDefaultQuery)
            );
          },
        )
      ) {
        return null;
      }
      const currentDefaultQuery = event.isDefaultPrevented;
      if (
        typeof currentDefaultQuery !== "function" ||
        !claimedIsCurrent(true, currentDefaultQuery) ||
        !queryShareDirectionalReactMethod(
          bubble,
          currentDefaultQuery,
          true,
          intrinsics,
          () => claimedIsCurrent(true, currentDefaultQuery),
        ) ||
        !queryShareDirectionalReactMethod(
          pair.capture,
          pair.capture.methods.isDefaultPrevented,
          false,
          intrinsics,
          () => claimedIsCurrent(true, currentDefaultQuery),
        ) ||
        !queryShareDirectionalReactMethod(
          pair.capture,
          pair.capture.methods.isPropagationStopped,
          false,
          intrinsics,
          () => claimedIsCurrent(true, currentDefaultQuery),
        ) ||
        !queryShareDirectionalReactMethod(
          bubble,
          bubble.methods.isPropagationStopped,
          false,
          intrinsics,
          () => claimedIsCurrent(true, currentDefaultQuery),
        )
      ) {
        return null;
      }
      return action;
    } finally {
      if (runtime.agentDirectionalFence === pair) {
        runtime.agentDirectionalFence = null;
      }
    }
  };

  const removeNavigationIsCurrent = (
    candidate: SharePresentation,
    publication: ShareRemoveNavigationPublication,
    source: ShareRemoveControlPublication,
    destination: ShareRemoveControlPublication,
    key: ShareRemoveNavigationKey,
  ) => {
    const runtime = presentationRuntimesRef.current.get(candidate);
    const authority = publication.authority;
    if (
      !runtime ||
      runtime.removeNavigation !== publication ||
      publication.presentation !== candidate ||
      publication.visit !== candidate.visit ||
      publication.permissionContext !== candidate.permissionContext ||
      publication.sourceList !== candidate.sourceList ||
      publication.list !== candidate.list ||
      publication.listElement !== runtime.list ||
      publication.listElement.getAttribute("aria-label") !==
        COLLABORATOR_LIST_LABEL ||
      publication.isRetired() ||
      authority.presentation !== candidate ||
      authority.list !== publication.listElement ||
      authority.document !== publication.listElement.ownerDocument ||
      authority.ownerWindow !== authority.document.defaultView ||
      !authority.isCurrent() ||
      !candidate.open ||
      !candidate.isOwner ||
      candidate.busy ||
      candidate.list.status !== "loaded" ||
      candidate.removeCollaborator !== publication.controls[0]?.callback ||
      !publication.controls.includes(source) ||
      !publication.controls.includes(destination) ||
      source === destination ||
      source.presentation !== candidate ||
      destination.presentation !== candidate ||
      source.visit !== candidate.visit ||
      destination.visit !== candidate.visit ||
      source.permissionContext !== candidate.permissionContext ||
      destination.permissionContext !== candidate.permissionContext ||
      source.list !== candidate.list ||
      destination.list !== candidate.list ||
      source.callback !== candidate.removeCollaborator ||
      destination.callback !== candidate.removeCollaborator ||
      source.element === destination.element ||
      source.element.ownerDocument !== authority.document ||
      destination.element.ownerDocument !== authority.document ||
      source.element.disabled ||
      destination.element.disabled ||
      source.row.pending ||
      destination.row.pending ||
      source.row.operation ||
      destination.row.operation ||
      candidate.list.collaborators[source.row.index] !== source.row ||
      candidate.list.collaborators[destination.row.index] !== destination.row ||
      runtime.rows[source.row.index]?.remove !== source.element ||
      runtime.rows[destination.row.index]?.remove !== destination.element ||
      source.element.parentElement !== runtime.rows[source.row.index]?.row ||
      destination.element.parentElement !==
        runtime.rows[destination.row.index]?.row ||
      shareRemoveDestination(publication.controls, source, key) !== destination
    ) {
      return false;
    }
    const currentList = candidate.list;
    if (currentList.status !== "loaded") return false;
    const expectedControls = currentList.collaborators.flatMap((row) => {
      const element = runtime.rows[row.index]?.remove;
      return (
        element &&
        !row.pending &&
        !row.operation &&
        !element.disabled &&
        element.isConnected
      )
        ? [element]
        : [];
    });
    if (
      expectedControls.length !== publication.controls.length ||
      publication.controls.some((control, index) =>
        control.order !== index ||
        control.presentation !== candidate ||
        control.visit !== candidate.visit ||
        control.permissionContext !== candidate.permissionContext ||
        control.list !== candidate.list ||
        control.row !== currentList.collaborators[control.row.index] ||
        control.element !== expectedControls[index] ||
        control.element !== runtime.rows[control.row.index]?.remove ||
        control.callback !== candidate.removeCollaborator ||
        control.element.getAttribute("aria-label") !==
          `Remove ${control.row.login}` ||
        control.element.type !== "button" ||
        control.element.disabled ||
        !control.element.isConnected)
    ) {
      return false;
    }
    try {
      return (
        shareRemoveNativeValue<Element | null>(
          authority,
          authority.activeElement,
          authority.document,
        ) === source.element &&
        presentationIsCurrent(candidate)
      );
    } catch {
      return false;
    }
  };

  const captureRemoveNavigation = (
    sourcePresentation: SharePresentation,
    event: ReactKeyboardEvent<HTMLUListElement>,
  ) => {
    let nativeEvent: unknown;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return;
    }
    if (!nativeEvent || typeof nativeEvent !== "object") return;
    if (
      !nativeEvent ||
      typeof nativeEvent !== "object" ||
      activeRemoveDeliveryRef.current
    ) {
      return;
    }
    const candidate = currentPresentation(sourcePresentation);
    const runtime = presentationRuntimesRef.current.get(candidate);
    const publication = runtime?.removeNavigation;
    const authority = publication?.authority;
    if (
      !runtime ||
      !publication ||
      !authority ||
      runtime.removeNavigationFence !== null ||
      event.currentTarget !== publication.listElement
    ) {
      return;
    }
    const native = captureShareRemoveNativeEvent(
      authority,
      nativeEvent as Event,
      authority.Event.CAPTURING_PHASE,
    );
    const capture = native
      ? captureShareRemoveReactEvent(
          event as ReactKeyboardEvent<HTMLElement>,
          authority,
          native,
          publication.listElement,
        )
      : null;
    const source = native
      ? publication.controls.find(
          (control) => control.element === native.target,
        )
      : undefined;
    const destination =
      source && native
        ? shareRemoveDestination(publication.controls, source, native.key)
        : null;
    if (
      !native ||
      !capture ||
      !source ||
      !destination ||
      runtime.removeNavigationPairs.has(native.event) ||
      native.terminal !== authority.terminal.proofFor(native.event) ||
      !shareRemoveNativeSnapshotIsCurrent(native, authority) ||
      !removeNavigationIsCurrent(
        candidate,
        publication,
        source,
        destination,
        native.key,
      )
    ) {
      return;
    }
    const pair: ShareRemoveNavigationPair = Object.freeze({
      publication,
      authority,
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
      visitClaim: Object.freeze({
        visit: publication.visit,
        permissionContext: publication.permissionContext,
      }),
      sourceClaim: Object.freeze({ source }),
      destinationClaim: Object.freeze({ destination }),
      wrapperClaim: Object.freeze({ capture: event }),
      nativeClaim: Object.freeze({ nativeEvent }),
      windowClaim: Object.freeze({
        registration: authority.terminal,
        proof: native.terminal,
        receiver: native.terminal.receiver,
      }),
    });
    runtime.removeNavigationPairs.set(native.event, pair);
    runtime.removeNavigationFence = pair;
    const revalidate = () =>
      runtime.removeNavigationFence === pair &&
      runtime.removeNavigationPairs.get(native.event) === pair &&
      runtime.removeNavigation === publication &&
      authority.terminal.retains(pair.terminal) &&
      shareRemoveNativeSnapshotIsCurrent(native, authority) &&
      shareRemoveReactSnapshotIsCurrent(
        capture,
        authority,
        native,
        publication.listElement,
      ) &&
      removeNavigationIsCurrent(
        candidate,
        publication,
        source,
        destination,
        native.key,
      );
    try {
      if (
        !revalidate() ||
        !queryShareRemoveReactMethod(
          capture,
          capture.methods.isDefaultPrevented,
          false,
          authority,
          revalidate,
        ) ||
        !queryShareRemoveReactMethod(
          capture,
          capture.methods.isPropagationStopped,
          false,
          authority,
          revalidate,
        )
      ) {
        runtime.removeNavigationPairs.delete(native.event);
      }
    } finally {
      if (runtime.removeNavigationFence === pair) {
        runtime.removeNavigationFence = null;
      }
    }
  };

  const completeRemoveNavigation = (
    sourcePresentation: SharePresentation,
    row: CollaboratorPublication,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    const candidate = currentPresentation(sourcePresentation);
    const runtime = presentationRuntimesRef.current.get(candidate);
    let nativeEvent: unknown;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return;
    }
    if (!nativeEvent || typeof nativeEvent !== "object") return;
    const pairKey =
      runtime?.removeNavigation?.authority &&
      typeof nativeEvent === "object" &&
      nativeEvent !== null &&
      runtime.removeNavigation.authority.prototypeOf(nativeEvent) ===
        runtime.removeNavigation.authority.KeyboardEvent.prototype
       ? nativeEvent as KeyboardEvent
        : null;
    const pair =
      runtime && pairKey
        ? runtime.removeNavigationPairs.get(pairKey)
        : undefined;
    if (
      !runtime ||
      !pair ||
      !nativeEvent ||
      typeof nativeEvent !== "object" ||
      pair.native.event !== nativeEvent ||
      activeRemoveDeliveryRef.current ||
      runtime.removeNavigationFence !== null
    ) {
      return;
    }
    const {
      publication,
      authority,
      source,
      destination,
      key,
    } = pair;
    const currentElement = runtime.rows[row.index]?.remove;
    const native = captureShareRemoveNativeEvent(
      authority,
      nativeEvent as Event,
      authority.Event.BUBBLING_PHASE,
    );
    const bubble =
      native && currentElement
        ? captureShareRemoveReactEvent(
            event as ReactKeyboardEvent<HTMLElement>,
            authority,
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
      pair.authority !== authority ||
      pair.terminal !== native.terminal ||
      source.row !== row ||
      source.element !== currentElement ||
      source.callback !== candidate.removeCollaborator ||
      event.currentTarget !== currentElement ||
      pair.capture.currentTarget !== publication.listElement ||
      bubble.currentTarget !== source.element ||
      pair.capture.phase !== authority.Event.CAPTURING_PHASE ||
      bubble.phase !== authority.Event.BUBBLING_PHASE ||
      !shareRemoveNativeEventsMatch(pair.native, native, authority) ||
      !shareRemoveReactSnapshotIsCurrent(
        pair.capture,
        authority,
        pair.native,
        null,
      ) ||
      !shareRemoveReactSnapshotIsCurrent(
        bubble,
        authority,
        native,
        currentElement,
      ) ||
      !shareRemoveNativeSnapshotIsCurrent(native, authority) ||
      !removeNavigationIsCurrent(
        candidate,
        publication,
        source,
        destination,
        key,
      )
    ) {
      return;
    }
    const delivery: ShareRemoveNavigationDelivery = Object.freeze({
      pair,
      bubble,
    });
    runtime.removeNavigationFence = pair;
    const revalidate = (
      expectedNativeDefaultPrevented: boolean,
      bubbleDefaultQuery: ReactKeyboardEvent<HTMLElement>["isDefaultPrevented"],
    ) =>
      runtime.removeNavigationFence === pair &&
      runtime.removeNavigationPairs.get(native.event) === pair &&
      runtime.removeNavigation === publication &&
      authority.terminal.retains(pair.terminal) &&
      shareRemoveNativeSnapshotIsCurrent(
        native,
        authority,
        expectedNativeDefaultPrevented,
      ) &&
      shareRemoveReactSnapshotIsCurrent(
        pair.capture,
        authority,
        pair.native,
        null,
      ) &&
      shareRemoveReactSnapshotIsCurrent(
        bubble,
        authority,
        native,
        currentElement,
        expectedNativeDefaultPrevented,
        bubbleDefaultQuery,
      ) &&
      removeNavigationIsCurrent(
        candidate,
        publication,
        source,
        destination,
        key,
      );
    try {
      if (
        !revalidate(false, bubble.methods.isDefaultPrevented) ||
        !queryShareRemoveReactMethod(
          pair.capture,
          pair.capture.methods.isDefaultPrevented,
          false,
          authority,
          () => revalidate(false, bubble.methods.isDefaultPrevented),
        ) ||
        !queryShareRemoveReactMethod(
          pair.capture,
          pair.capture.methods.isPropagationStopped,
          false,
          authority,
          () => revalidate(false, bubble.methods.isDefaultPrevented),
        ) ||
        !queryShareRemoveReactMethod(
          bubble,
          bubble.methods.isDefaultPrevented,
          false,
          authority,
          () => revalidate(false, bubble.methods.isDefaultPrevented),
        ) ||
        !queryShareRemoveReactMethod(
          bubble,
          bubble.methods.isPropagationStopped,
          false,
          authority,
          () => revalidate(false, bubble.methods.isDefaultPrevented),
        ) ||
        claimedRemoveDeliveriesRef.current.has(delivery) ||
        claimedRemovePairsRef.current.has(pair) ||
        claimedRemoveMovementsRef.current.has(pair.movement) ||
        claimedRemovePublicationClaimsRef.current.has(pair.publicationClaim) ||
        claimedRemoveVisitClaimsRef.current.has(pair.visitClaim) ||
        claimedRemoveSourceClaimsRef.current.has(pair.sourceClaim) ||
        claimedRemoveDestinationClaimsRef.current.has(pair.destinationClaim) ||
        claimedRemoveWrapperClaimsRef.current.has(pair.wrapperClaim) ||
        claimedRemoveNativeClaimsRef.current.has(pair.nativeClaim) ||
        claimedRemoveWindowClaimsRef.current.has(pair.windowClaim) ||
        claimedRemoveReactWrappersRef.current.has(pair.capture.event) ||
        claimedRemoveReactWrappersRef.current.has(event) ||
        claimedRemoveNativeKeyEventsRef.current.has(native.event) ||
        !authority.terminal.claim(pair.terminal)
      ) {
        return;
      }
      claimedRemoveDeliveriesRef.current.add(delivery);
      claimedRemovePairsRef.current.add(pair);
      claimedRemoveMovementsRef.current.add(pair.movement);
      claimedRemovePublicationClaimsRef.current.add(pair.publicationClaim);
      claimedRemoveVisitClaimsRef.current.add(pair.visitClaim);
      claimedRemoveSourceClaimsRef.current.add(pair.sourceClaim);
      claimedRemoveDestinationClaimsRef.current.add(pair.destinationClaim);
      claimedRemoveWrapperClaimsRef.current.add(pair.wrapperClaim);
      claimedRemoveNativeClaimsRef.current.add(pair.nativeClaim);
      claimedRemoveWindowClaimsRef.current.add(pair.windowClaim);
      claimedRemoveReactWrappersRef.current.add(pair.capture.event);
      claimedRemoveReactWrappersRef.current.add(event);
      claimedRemoveNativeKeyEventsRef.current.add(native.event);
      runtime.removeNavigationPairs.delete(native.event);
      activeRemoveDeliveryRef.current = delivery;
      const claimedAuthorityIsCurrent = (
        expectedNativeDefaultPrevented: boolean,
        bubbleDefaultQuery: ReactKeyboardEvent<HTMLElement>["isDefaultPrevented"],
      ) =>
        runtime.removeNavigationFence === pair &&
        !runtime.removeNavigationPairs.has(native.event) &&
        runtime.removeNavigation === publication &&
        activeRemoveDeliveryRef.current === delivery &&
        claimedRemoveDeliveriesRef.current.has(delivery) &&
        claimedRemovePairsRef.current.has(pair) &&
        claimedRemoveMovementsRef.current.has(pair.movement) &&
        claimedRemovePublicationClaimsRef.current.has(
          pair.publicationClaim,
        ) &&
        claimedRemoveVisitClaimsRef.current.has(pair.visitClaim) &&
        claimedRemoveSourceClaimsRef.current.has(pair.sourceClaim) &&
        claimedRemoveDestinationClaimsRef.current.has(
          pair.destinationClaim,
        ) &&
        claimedRemoveWrapperClaimsRef.current.has(pair.wrapperClaim) &&
        claimedRemoveNativeClaimsRef.current.has(pair.nativeClaim) &&
        claimedRemoveWindowClaimsRef.current.has(pair.windowClaim) &&
        authority.terminal.retains(pair.terminal) &&
        shareRemoveNativeSnapshotIsCurrent(
          native,
          authority,
          expectedNativeDefaultPrevented,
        ) &&
        shareRemoveReactSnapshotIsCurrent(
          pair.capture,
          authority,
          pair.native,
          null,
        ) &&
        shareRemoveReactSnapshotIsCurrent(
          bubble,
          authority,
          native,
          currentElement,
          expectedNativeDefaultPrevented,
          bubbleDefaultQuery,
        ) &&
        removeNavigationIsCurrent(
          candidate,
          publication,
          source,
          destination,
          key,
        );
      if (
        !claimedAuthorityIsCurrent(false, bubble.methods.isDefaultPrevented) ||
        !callShareRemoveReactMethod(
          bubble,
          bubble.methods.preventDefault,
          authority,
          () => {
            const currentDefaultQuery = event.isDefaultPrevented;
            return (
              typeof currentDefaultQuery === "function" &&
              claimedAuthorityIsCurrent(true, currentDefaultQuery)
            );
          },
        )
      ) {
        return;
      }
      const currentDefaultQuery = event.isDefaultPrevented;
      if (
        typeof currentDefaultQuery !== "function" ||
        !claimedAuthorityIsCurrent(true, currentDefaultQuery) ||
        !queryShareRemoveReactMethod(
          bubble,
          currentDefaultQuery,
          true,
          authority,
          () => claimedAuthorityIsCurrent(true, currentDefaultQuery),
        ) ||
        !queryShareRemoveReactMethod(
          pair.capture,
          pair.capture.methods.isDefaultPrevented,
          false,
          authority,
          () => claimedAuthorityIsCurrent(true, currentDefaultQuery),
        ) ||
        !queryShareRemoveReactMethod(
          pair.capture,
          pair.capture.methods.isPropagationStopped,
          false,
          authority,
          () => claimedAuthorityIsCurrent(true, currentDefaultQuery),
        ) ||
        !queryShareRemoveReactMethod(
          bubble,
          bubble.methods.isPropagationStopped,
          false,
          authority,
          () => claimedAuthorityIsCurrent(true, currentDefaultQuery),
        )
      ) {
        return;
      }
      authority.apply(authority.focus, destination.element, [
        SHARE_REMOVE_PREVENT_SCROLL,
      ]);
    } catch {
      return;
    } finally {
      if (activeRemoveDeliveryRef.current === delivery) {
        activeRemoveDeliveryRef.current = null;
      }
      if (runtime.removeNavigationFence === pair) {
        runtime.removeNavigationFence = null;
      }
    }
  };

  const startPresentationObservation = useCallback((runtime: SharePresentationRuntime) => {
    const ownerWindow = runtime.root?.ownerDocument.defaultView;
    if (!ownerWindow || !runtime.dialog || !runtime.overlay || !runtime.portalParent) return false;
    const Observer = ownerWindow.MutationObserver;
    if (typeof Observer !== "function") return false;
    const observer = new Observer((records) => {
      if (records.some((record) => mutationTouchesCopyControl(runtime, record))) {
        runtime.copyControlMutated = true;
      }
      if (records.some((record) => mutationTouchesPresentation(runtime, record))) runtime.mutated = true;
    });
    observer.observe(runtime.dialog, { attributes: true, characterData: true, childList: true, subtree: true });
    observer.observe(runtime.overlay, { attributes: true, characterData: true, childList: true, subtree: true });
    observer.observe(runtime.portalParent, { childList: true });
    const placementObserver = new Observer((records) => {
      const placement = runtime.placement;
      if (placement && records.some((record) => mutationTouchesSharePlacement(placement, record))) {
        runtime.controlPlacementMutated = true;
      }
    });
    const alreadyObserved = new Set<Node>([
      runtime.dialog,
      runtime.overlay,
      runtime.portalParent,
    ]);
    for (const parent of new Set(runtime.placement?.map(({ parent }) => parent) ?? [])) {
      if (alreadyObserved.has(parent)) continue;
      placementObserver.observe(parent, { childList: true });
    }
    runtime.observer = observer;
    runtime.placementObserver = placementObserver;
    runtime.observerRetirement = null;
    return true;
  }, []);

  const startCloseCapture = useCallback((candidate: SharePresentation, runtime: SharePresentationRuntime) => {
    const dialog = runtime.dialog;
    const close = runtime.close;
    const ownerWindow = dialog?.ownerDocument.defaultView;
    if (!ownerWindow || !dialog || !close) return false;
    const remember = (event: Event) => {
      clearShareCloseProvenance(runtime);
      if (!runtime.active || runtime.retired || activePresentationRef.current !== candidate) return;
      const target = event.target;
      let provenance: ShareCloseProvenance | null = null;
      if (
        event instanceof ownerWindow.KeyboardEvent &&
        event.type === "keydown" &&
        event.key === "Escape" &&
        target instanceof ownerWindow.Node &&
        dialog.contains(target)
      ) {
        provenance = { kind: "escape", event };
      } else if (
        event instanceof ownerWindow.MouseEvent &&
        event.type === "click" &&
        target instanceof ownerWindow.Node
      ) {
        if (close.contains(target)) provenance = { kind: "close-button", event };
        else if (!dialog.contains(target)) provenance = { kind: "outside", event };
      }
      if (!provenance) return;
      runtime.closeProvenance = provenance;
      const retirement = { provenance, timer: -1 };
      runtime.closeProvenanceRetirement = retirement;
      retirement.timer = ownerWindow.setTimeout(() => {
        if (runtime.closeProvenanceRetirement !== retirement) return;
        runtime.closeProvenanceRetirement = null;
        if (runtime.closeProvenance === provenance) runtime.closeProvenance = null;
      }, 0);
    };
    const forget = (event: Event) => {
      const provenance = runtime.closeProvenance;
      if (provenance?.event === event) clearShareCloseProvenance(runtime, provenance);
    };
    ownerWindow.addEventListener("keydown", remember, true);
    ownerWindow.addEventListener("click", remember, true);
    ownerWindow.addEventListener("keydown", forget);
    ownerWindow.addEventListener("click", forget);
    runtime.removeCloseCapture = () => {
      ownerWindow.removeEventListener("keydown", remember, true);
      ownerWindow.removeEventListener("click", remember, true);
      ownerWindow.removeEventListener("keydown", forget);
      ownerWindow.removeEventListener("click", forget);
    };
    return true;
  }, []);

  const startAgentDirectionalCapture = useCallback((
    candidate: SharePresentation,
    runtime: SharePresentationRuntime,
  ) => {
    const control = runtime.agentToggle;
    const intrinsics = runtime.agentDirectionalIntrinsics;
    if (!control || !intrinsics || runtime.agentDirectionalCapture) {
      return false;
    }
    const registration = installShareDirectionalNativeCapture(
      control,
      intrinsics,
      () =>
        runtime.active &&
        runtime.published &&
        !runtime.retired &&
        runtime.agentDirectionalFence === null &&
        activePresentationRef.current === candidate &&
        presentationIsCurrent(candidate),
    );
    if (!registration) return false;
    runtime.agentDirectionalCapture = registration;
    return true;
  }, [presentationIsCurrent]);

  const publishPresentation = useCallback(
    (source: SharePresentation, expected?: SharePresentation) => {
      const candidate = currentPresentation(source);
      const handoff = copyHandoffRef.current;
      if (
        handoff &&
        handoff.successor === null &&
        candidate !== handoff.predecessor
      ) {
        handoff.successor = candidate;
      }
      if (expected && candidate !== expected) {
        retireCopyHandoff(candidate);
        return null;
      }
      const existing = activePresentationRef.current;
      const runtime = presentationRuntimesRef.current.get(candidate);
      if (!runtime || runtime.retired || (runtime.predecessor && existing && existing !== runtime.predecessor)) {
        retireCopyHandoff(candidate);
        if (runtime) retirePresentationLineage(candidate);
        return null;
      }
      if (runtime.published && runtime.active && existing === candidate) return candidate;
      captureRuntimeDerivedElements(runtime);

      const predecessor = runtime.predecessor;
      const placement = runtime.root
        ? snapshotSharePlacement(runtime.root, runtime.root.ownerDocument)
        : null;
      if (!placement) {
        retireCopyHandoff(candidate);
        retirePresentationLineage(candidate);
        return null;
      }
      if (predecessor) {
        const previousRuntime = presentationRuntimesRef.current.get(predecessor);
        if (
          !previousRuntime ||
          !previousRuntime.retired ||
          previousRuntime.claims.size > 0 ||
          !presentationFactsAreExactReplay(predecessor, candidate) ||
          !runtimeElementsAreExactReplay(previousRuntime, runtime) ||
          !previousRuntime.placement ||
          !sharePlacementMatches(runtime.root!.ownerDocument, previousRuntime.placement) ||
          !sharePlacementsAreExactReplay(previousRuntime.placement, placement) ||
          !stopPresentationObservation(previousRuntime)
        ) {
          retireCopyHandoff(candidate);
          retirePresentationLineage(candidate);
          return null;
        }
      }
      if (!presentationFactsAreCurrent(candidate)) {
        retireCopyHandoff(candidate);
        retirePresentationLineage(candidate);
        return null;
      }
      if (existing && existing !== candidate) retirePresentationLineage(existing);
      if (!presentationDomIsValid(candidate)) {
        retireCopyHandoff(candidate);
        retirePresentationLineage(candidate);
        return null;
      }
      const ownerWindow = runtime.agentToggle?.ownerDocument.defaultView;
      const directionalIntrinsics = ownerWindow
        ? captureShareDirectionalIntrinsics(ownerWindow)
        : null;
      if (!directionalIntrinsics) {
        retireCopyHandoff(candidate);
        retirePresentationLineage(candidate);
        return null;
      }
      runtime.agentDirectionalIntrinsics = directionalIntrinsics;
      runtime.placement = placement;
      if (!startPresentationObservation(runtime)) {
        retireCopyHandoff(candidate);
        retirePresentationLineage(candidate);
        return null;
      }
      runtime.active = true;
      runtime.published = true;
      activePresentationRef.current = candidate;
      const expectedRemoveControls =
        candidate.isOwner && candidate.list.status === "loaded"
          ? candidate.list.collaborators.filter((row) => !row.pending && !row.operation).length
          : 0;
      const removeNavigation = expectedRemoveControls > 0
        ? createShareRemoveNavigationPublication(candidate, runtime)
        : null;
      if (expectedRemoveControls > 0 && !removeNavigation) {
        retireCopyHandoff(candidate);
        retirePresentationLineage(candidate);
        return null;
      }
      runtime.removeNavigation = removeNavigation;
      if (!startCloseCapture(candidate, runtime)) {
        retireCopyHandoff(candidate);
        retirePresentationLineage(candidate);
        return null;
      }
      if (!startAgentDirectionalCapture(candidate, runtime)) {
        retireCopyHandoff(candidate);
        retirePresentationLineage(candidate);
        return null;
      }
      transferPendingCopyOperation(candidate, runtime, placement);
      return candidate;
    },
    [
      currentPresentation,
      presentationDomIsValid,
      presentationFactsAreCurrent,
      retireCopyHandoff,
      retirePresentationLineage,
      startAgentDirectionalCapture,
      startCloseCapture,
      startPresentationObservation,
      transferPendingCopyOperation,
    ],
  );
  useLayoutEffect(() => {
    publishPresentationRef.current = publishPresentation;
    return () => {
      if (publishPresentationRef.current === publishPresentation) publishPresentationRef.current = null;
    };
  }, [publishPresentation]);

  const claimAdd = (
    source: SharePresentation,
    form: HTMLFormElement,
    addButton: HTMLButtonElement,
  ) => {
    const candidate = currentPresentation(source);
    const runtime = presentationRuntimesRef.current.get(candidate);
    const accepted = candidate.visit
      ? Object.freeze({
          visit: candidate.visit,
          documentId: candidate.document.id,
          login: candidate.login,
          role: candidate.newRole,
        })
      : null;
    if (
      !candidate.isOwner ||
      !candidate.addEligible ||
      !accepted ||
      candidate.addPending ||
      candidate.busy ||
      !candidate.login ||
      runtime?.form !== form ||
      runtime.add !== addButton ||
      addButton.disabled ||
      addButton.form !== form ||
      !claim(source, "add")
    ) {
      return null;
    }
    return accepted;
  };

  const claimRetry = (source: SharePresentation, button: HTMLButtonElement) => {
    const candidate = currentPresentation(source);
    const runtime = presentationRuntimesRef.current.get(candidate);
    const documentId = candidate.document.id;
    if (
      candidate.list.status !== "error" ||
      candidate.list.retrying ||
      candidate.listPending ||
      runtime?.retry !== button ||
      button.disabled ||
      !claim(source, "retry")
    ) {
      return null;
    }
    return documentId;
  };

  const claimNewRole = (
    source: SharePresentation,
    select: HTMLSelectElement,
    nextRole: CollaboratorRole,
  ) => {
    const candidate = currentPresentation(source);
    const runtime = presentationRuntimesRef.current.get(candidate);
    if (
      !candidate.isOwner ||
      nextRole === candidate.newRole ||
      runtime?.newRole !== select ||
      select.disabled ||
      !claim(source, "new-role", { kind: "new-role", value: nextRole })
    ) {
      return false;
    }
    return true;
  };

  const claimCollaboratorRole = (
    source: SharePresentation,
    row: CollaboratorPublication,
    select: HTMLSelectElement,
    nextRole: CollaboratorRole,
  ) => {
    const candidate = currentPresentation(source);
    const runtime = presentationRuntimesRef.current.get(candidate);
    const accepted = candidate.permissionContext
      ? Object.freeze({
          context: candidate.permissionContext,
          documentId: candidate.document.id,
          login: row.login,
          role: nextRole,
        })
      : null;
    if (
      !candidate.isOwner ||
      !accepted ||
      row.pending ||
      row.operation ||
      nextRole === row.role ||
      runtime?.rows[row.index]?.role !== select ||
      select.disabled ||
      !claim(source, `role:${row.index}`, {
        kind: "collaborator-role",
        row,
        value: nextRole,
      })
    ) {
      return null;
    }
    return accepted;
  };

  const claimRemove = (
    source: SharePresentation,
    row: CollaboratorPublication,
    button: HTMLButtonElement,
  ) => {
    const candidate = currentPresentation(source);
    const runtime = presentationRuntimesRef.current.get(candidate);
    const accepted = candidate.permissionContext
      ? Object.freeze({
          context: candidate.permissionContext,
          documentId: candidate.document.id,
          login: row.login,
        })
      : null;
    if (
      !candidate.isOwner ||
      !accepted ||
      row.pending ||
      row.operation ||
      runtime?.rows[row.index]?.remove !== button ||
      button.disabled ||
      !claim(source, `remove:${row.index}`)
    ) {
      return null;
    }
    return accepted;
  };

  const claimLinkAccess = (
    source: SharePresentation,
    select: HTMLSelectElement,
    value: DocumentDto["linkAccess"],
  ) => {
    const candidate = currentPresentation(source);
    const runtime = presentationRuntimesRef.current.get(candidate);
    const accepted = candidate.permissionContext
      ? Object.freeze({
          context: candidate.permissionContext,
          documentId: candidate.document.id,
          value,
          onDocChange: candidate.onDocChange,
        })
      : null;
    if (
      !candidate.isOwner ||
      !accepted ||
      candidate.linkPermissionOwner ||
      candidate.linkPermissionOperation ||
      value === candidate.linkAccess ||
      runtime?.linkAccess !== select ||
      select.disabled ||
      !claim(source, "link-access", { kind: "link-access", value })
    ) {
      return null;
    }
    return accepted;
  };

  const claimDone = (candidate: SharePresentation, button: HTMLButtonElement) => {
    const runtime = presentationRuntimesRef.current.get(currentPresentation(candidate));
    return runtime?.done === button && !button.disabled && claim(candidate, "done");
  };

  const claimNativeClose = (source: SharePresentation) => {
    const candidate = currentPresentation(source);
    const runtime = presentationRuntimesRef.current.get(candidate);
    const provenance = runtime?.closeProvenance;
    const ownerWindow = runtime?.dialog?.ownerDocument.defaultView;
    const target = provenance?.event.target;
    if (
      !runtime ||
      !provenance ||
      !ownerWindow ||
      !(target instanceof ownerWindow.Node) ||
      (provenance.kind === "escape"
        ? !(
            provenance.event instanceof ownerWindow.KeyboardEvent &&
            provenance.event.type === "keydown" &&
            provenance.event.key === "Escape" &&
            runtime.dialog?.contains(target)
          )
        : !(
            provenance.event instanceof ownerWindow.MouseEvent &&
            provenance.event.type === "click" &&
            (provenance.kind === "close-button"
              ? runtime.close?.contains(target)
              : !runtime.dialog?.contains(target))
          )) ||
      !claim(source, "close")
    ) {
      return null;
    }
    clearShareCloseProvenance(runtime, provenance);
    return candidate;
  };

  const closePresentation = (
    source: SharePresentation,
    acceptedOnOpenChange = source.onOpenChange,
  ) => {
    const candidate = currentPresentation(source);
    if (!presentationIsCurrent(source)) return;
    retirePresentationLineage(candidate);
    retireCopyOperation(candidate);
    retireShareRequests(candidate.visit ?? undefined);
    retirePermissionOperations(candidate.permissionContext ?? undefined);
    acceptedOnOpenChange(false);
  };

  const selectCopyFallback = useCallback((candidate: SharePresentation) => {
    const runtime = presentationRuntimesRef.current.get(candidate);
    const fallbackState = candidate.sourceCopyFallback;
    const fallback = runtime?.linkFallback;
    if (
      !candidate.copyFallback ||
      !fallbackState ||
      fallbackState.visit !== candidate.visit ||
      fallbackState.value !== candidate.editorLink ||
      selectedFallbacksRef.current.has(fallbackState) ||
      !fallback ||
      !presentationIsCurrent(candidate) ||
      !controlPlacementIsCurrent(candidate)
    ) {
      return;
    }
    selectedFallbacksRef.current.add(fallbackState);
    try {
      fallback.focus({ preventScroll: true });
    } catch {
      return;
    }
    if (
      fallback.ownerDocument.activeElement !== fallback ||
      !presentationIsCurrent(candidate) ||
      !controlPlacementIsCurrent(candidate)
    ) {
      return;
    }
    try {
      fallback.select();
    } catch {
      // The exact fallback stays visible even when the host cannot select it.
    }
  }, [controlPlacementIsCurrent, presentationIsCurrent]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      if (presentationIsCurrent(presentation)) presentation.onOpenChange(true);
      return;
    }
    const candidate = claimNativeClose(presentation);
    if (candidate) closePresentation(candidate);
  };

  useLayoutEffect(() => {
    const candidate = publishPresentation(presentation);
    if (candidate) selectCopyFallback(candidate);
    return () => retirePresentationLineage(presentation);
  }, [presentation, publishPresentation, retirePresentationLineage, selectCopyFallback]);

  const linkOption = LINK_OPTIONS.find((option) => option.value === presentation.linkAccess);

  return (
    <Dialog open={presentation.open} onOpenChange={handleOpenChange}>
      <DialogContent title={`Share “${presentation.document.title}”`} description="Collaborators sign in with GitHub. Add people by their GitHub handle." className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <div
          ref={(element) => bindElement(presentation, "root", element)}
          className="contents"
          data-testid="share-presentation"
        >
        {presentation.isOwner && (
          <form
            ref={(element) => bindElement(presentation, "form", element)}
            className="flex gap-2"
            onSubmit={(e) => {
              const runtime = presentationRuntimesRef.current.get(currentPresentation(presentation));
              const addButton = runtime?.add;
              if (
                !addButton ||
                !isExactNativeSubmit(e, e.currentTarget, addButton)
              ) {
                return;
              }
              const accepted = claimAdd(presentation, e.currentTarget, addButton);
              if (!accepted) return;
              e.preventDefault();
              void add(accepted.visit, accepted.documentId, accepted.login, accepted.role);
            }}
          >
            <CollaboratorLoginInput
              value={presentation.sourceLogin}
              onChange={setLogin}
              exclude={[
                ...(presentation.list.status === "loaded" && presentation.list.owner?.login
                  ? [presentation.list.owner.login]
                  : []),
                ...(presentation.list.status === "loaded"
                  ? presentation.list.collaborators.map((collaborator) => collaborator.login)
                  : []),
              ]}
              onPick={() => {
                if (!presentationIsCurrent(presentation)) return;
                presentationRuntimesRef.current.get(currentPresentation(presentation))?.newRole?.focus();
              }}
            />
            <select
              ref={(element) => bindElement(presentation, "newRole", element)}
              className="select"
              value={presentation.newRole}
              onChange={(event) => {
                const nextRole = event.currentTarget.value;
                if (
                  !optionValueIsRole(nextRole) ||
                  !isExactNativeChange(event, event.currentTarget) ||
                  !claimNewRole(presentation, event.currentTarget, nextRole)
                ) {
                  return;
                }
                setRole(nextRole);
              }}
              aria-label="Role for new collaborator"
              data-testid="share-role"
            >
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              ref={(element) => bindElement(presentation, "add", element)}
              type="submit"
              className="btn btn-primary"
              disabled={!presentation.addEligible}
              data-testid="share-add"
            >
              {presentation.busy ? <Loader2 size={16} className="animate-spin" /> : "Add"}
            </button>
          </form>
        )}
        {presentation.addError && (
          <div
            ref={(element) => bindElement(presentation, "addError", element)}
            className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40 wrap-anywhere"
            role="alert"
            aria-atomic="true"
            data-testid="share-add-error"
          >
            {presentation.addError}
          </div>
        )}
        {presentation.actionError && (
          <div
            ref={(element) => bindElement(presentation, "actionError", element)}
            className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40 wrap-anywhere"
            role="alert"
            aria-atomic="true"
            data-testid="share-action-error"
          >
            {presentation.actionError}
          </div>
        )}

        <div ref={(element) => bindElement(presentation, "people", element)} className="mt-5">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">People with access</div>
          <ul
            ref={(element) => bindElement(presentation, "list", element)}
            className="flex flex-col divide-y divide-line rounded-xl border border-line"
            aria-label={COLLABORATOR_LIST_LABEL}
            onKeyDownCapture={(event) => {
              captureRemoveNavigation(presentation, event);
            }}
          >
            {(presentation.list.status === "none" || presentation.list.status === "loading") && (
              <li
                ref={(element) => bindElement(presentation, "listState", element)}
                className="flex items-center justify-center gap-2 px-3 py-4 text-sm text-ink-3"
                role="status"
                aria-live="polite"
                aria-atomic="true"
                data-testid="collaborator-list-loading"
              >
                <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                Loading collaborators…
              </li>
            )}
            {presentation.list.status === "error" && (
              <li
                ref={(element) => bindElement(presentation, "listState", element)}
                className="bg-red-50 px-3 py-3 text-sm text-danger dark:bg-red-950/40"
                role="alert"
                aria-atomic="true"
                data-testid="collaborator-list-error"
              >
                <div className="wrap-anywhere">{presentation.list.message}</div>
                <button
                  ref={(element) => bindElement(presentation, "retry", element)}
                  type="button"
                  className="btn btn-outline btn-sm mt-2 gap-1.5"
                  onClick={(event) => {
                    const documentId = presentation.document.id;
                    if (!isExactNativeClick(event, event.currentTarget)) return;
                    const acceptedDocumentId = claimRetry(presentation, event.currentTarget);
                    if (!acceptedDocumentId || acceptedDocumentId !== documentId) return;
                    void loadCollaborators(acceptedDocumentId, "retry");
                  }}
                  disabled={presentation.list.retrying}
                >
                  {presentation.list.retrying && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                  {presentation.list.retrying ? "Retrying…" : "Retry"}
                </button>
              </li>
            )}
            {presentation.list.status === "loaded" && presentation.list.owner && (
              <li
                ref={(element) => bindElement(presentation, "owner", element)}
                className="flex items-center gap-3 px-3 py-2.5"
              >
                <Avatar name={presentation.list.owner.name ?? presentation.list.owner.login ?? "Owner"} src={presentation.list.owner.image} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink" title={presentation.list.owner.name ?? presentation.list.owner.login ?? undefined}>{presentation.list.owner.name ?? presentation.list.owner.login}</div>
                  {presentation.list.owner.login && <div className="truncate text-xs text-ink-3" title={`@${presentation.list.owner.login}`}>@{presentation.list.owner.login}</div>}
                </div>
                <span className="text-xs font-medium text-ink-3">Owner</span>
              </li>
            )}
            {presentation.list.status === "loaded" && presentation.list.collaborators.map((collaborator) => {
              return (
                <li
                  ref={(element) => bindRowElement(presentation, collaborator, "row", element)}
                  key={collaborator.login}
                  className="flex items-center gap-3 px-3 py-2.5"
                  data-testid="collaborator-row"
                  data-login={collaborator.login}
                >
                  <Avatar name={collaborator.name ?? collaborator.login} src={collaborator.image ?? `https://avatars.githubusercontent.com/${collaborator.login}?s=64`} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink" title={collaborator.name ?? collaborator.login}>{collaborator.name ?? collaborator.login}</div>
                    <div className="truncate text-xs text-ink-3" title={`@${collaborator.login}`}>@{collaborator.login}</div>
                  </div>
                  {presentation.isOwner ? (
                    <>
                      <select
                        ref={(element) => bindRowElement(presentation, collaborator, "role", element)}
                        className="select h-8 text-xs"
                        value={collaborator.role}
                        onChange={(event) => {
                          const nextRole = event.currentTarget.value;
                          if (!optionValueIsRole(nextRole) || !isExactNativeChange(event, event.currentTarget)) return;
                          const accepted = claimCollaboratorRole(
                            presentation,
                            collaborator,
                            event.currentTarget,
                            nextRole,
                          );
                          if (!accepted) return;
                          void changeRole(
                            accepted.context,
                            accepted.documentId,
                            accepted.login,
                            accepted.role,
                          );
                        }}
                        aria-label={`Role for ${collaborator.login}`}
                        disabled={collaborator.pending}
                      >
                        {ROLE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <button
                        ref={(element) => bindRowElement(presentation, collaborator, "remove", element)}
                        type="button"
                        className="icon-btn h-8 w-8 text-ink-3 hover:text-danger"
                        onClick={(event) => {
                          const login = collaborator.login;
                          if (!isExactNativeClick(event, event.currentTarget)) return;
                          const accepted = claimRemove(presentation, collaborator, event.currentTarget);
                          if (!accepted || accepted.login !== login) return;
                          void remove(accepted.context, accepted.documentId, accepted.login);
                        }}
                        onKeyDown={(event) => {
                          completeRemoveNavigation(
                            presentation,
                            collaborator,
                            event,
                          );
                        }}
                        aria-label={`Remove ${collaborator.login}`}
                        disabled={collaborator.pending}
                      >
                        <Trash2 size={15} />
                      </button>
                    </>
                  ) : (
                    <span className="text-xs font-medium capitalize text-ink-3">{collaborator.role}</span>
                  )}
                </li>
              );
            })}
            {presentation.list.status === "loaded" && presentation.list.collaborators.length === 0 && (
              <li
                ref={(element) => bindElement(presentation, "empty", element)}
                className="px-3 py-3 text-sm text-ink-3"
              >
                Nobody else has been added yet.
              </li>
            )}
          </ul>
          {/* The link the people above open, in the same shape as the Reader link row under General access. */}
          <div
            ref={(element) => bindElement(presentation, "editorLink", element)}
            className={SHARE_LINK_ROW_CLASS}
            data-testid="editor-link"
          >
            <Link2 size={13} className="shrink-0 text-ink-3" />
            <span className="shrink-0 text-ink-3">Link:</span>
            {presentation.copyFallback ? (
              <input
                ref={(element) => {
                  bindControlElement(presentation, "linkValue", element);
                  bindControlElement(presentation, "linkFallback", element);
                }}
                className={SHARE_LINK_INPUT_CLASS}
                value={presentation.editorLink}
                readOnly
                aria-label="Document link"
                data-testid="copy-link-fallback"
              />
            ) : (
              <code
                ref={(element) => bindControlElement(presentation, "linkValue", element)}
                className={SHARE_LINK_CODE_CLASS}
              >
                {presentation.editorLink}
              </code>
            )}
            <button
              ref={(element) => bindControlElement(presentation, "linkCopy", element)}
              type="button"
              className={SHARE_LINK_COPY_CLASS}
              onClick={(event) => {
                const action = claimCopyLink(presentation, event);
                if (action) beginCopyLink(action);
              }}
              data-testid="copy-link"
            >
              {presentation.copyCopied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
              {presentation.copyLabel}
            </button>
          </div>
          <p
            ref={(element) => bindElement(presentation, "linkHint", element)}
            className="mt-1.5 text-xs text-ink-3"
            data-testid="copy-link-hint"
          >
            {presentation.linkAccess === "private" ? "Anyone listed above can open this link." : linkOption?.description}
          </p>
        </div>

        <div ref={(element) => bindElement(presentation, "general", element)} className="mt-5">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">General access</div>
          <div className="flex items-start gap-3 rounded-xl border border-line p-3">
            <span className={cn("mt-0.5 flex h-8 w-8 items-center justify-center rounded-full", presentation.linkAccess === "private" ? "bg-surface-3 text-ink-2" : "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300")}>
              {presentation.linkAccess === "private" ? <Lock size={15} /> : <Globe size={15} />}
            </span>
            <div className="min-w-0 flex-1">
              {presentation.isOwner ? (
                <select
                  ref={(element) => bindElement(presentation, "linkAccess", element)}
                  className="select w-full"
                  value={presentation.linkAccess}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (!optionValueIsLinkAccess(value) || !isExactNativeChange(event, event.currentTarget)) return;
                    const accepted = claimLinkAccess(presentation, event.currentTarget, value);
                    if (!accepted) return;
                    void setLink(
                      accepted.context,
                      accepted.documentId,
                      accepted.value,
                      accepted.onDocChange,
                    );
                  }}
                  aria-label="Link access"
                  data-testid="link-access"
                  disabled={currentLinkPermissionOperation !== null}
                >
                  {LINK_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value} disabled={currentLinkPermissionOperation !== null}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="text-sm font-medium text-ink">{linkOption?.label}</div>
              )}
              <p className="mt-1 text-xs text-ink-3">{linkOption?.description}</p>
              {presentation.linkAccess !== "private" && (
                <div className="mt-2 flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs" data-testid="reader-link">
                  <BookOpen size={13} className="shrink-0 text-ink-3" />
                  <span className="shrink-0 text-ink-3">Reader link:</span>
                  <code ref={readerLinkEl} className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2">
                    {readerLink}
                  </code>
                  <CopyButton text={readerLink} label="Copy" testId="copy-reader-link" target={readerLinkEl} />
                </div>
              )}
            </div>
          </div>
        </div>

        <div ref={(element) => bindElement(presentation, "agent", element)} className="mt-5">
          <AgentCollaborateCard
            origin={presentation.origin}
            open={presentation.open}
            docId={presentation.document.id}
            onClose={() => closePresentation(presentation)}
            expanded={presentation.agentExpanded}
            panelId={presentation.agentPanelId}
            cardRef={(element) => bindControlElement(presentation, "agentCard", element)}
            toggleRef={(element) => bindControlElement(presentation, "agentToggle", element)}
            panelRef={(element) => bindControlElement(presentation, "agentPanel", element)}
            onToggle={(event) => {
              const action = claimAgentToggle(presentation, event);
              if (!action) return;
              setAgentExpansion(Object.freeze({
                visit: action.visit,
                expanded: action.nextExpanded,
              }));
            }}
            onDirectionalKeyCapture={(event) => {
              publishAgentDirectionalKey(presentation, event);
            }}
            onDirectionalKey={(event) => {
              const action = claimAgentDirectionalKey(presentation, event);
              if (!action) return;
              setAgentExpansion(Object.freeze({
                visit: action.visit,
                expanded: action.nextExpanded,
              }));
            }}
          />
        </div>

        <div
          ref={(element) => bindElement(presentation, "footer", element)}
          className="mt-5 flex justify-end"
          data-testid="share-footer"
        >
          <button
            ref={(element) => bindElement(presentation, "done", element)}
            type="button"
            className="btn btn-primary shrink-0"
            onClick={(event) => {
              const closeCallback = presentation.onOpenChange;
              if (
                !isExactNativeClick(event, event.currentTarget) ||
                !claimDone(presentation, event.currentTarget)
              ) {
                return;
              }
              closePresentation(presentation, closeCallback);
            }}
          >
            Done
          </button>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});

export function CopyButton({ text, label = "Copy", testId, target }: { text: string; label?: string; testId?: string; target?: RefObject<HTMLElement | null> }) {
  const { copy, label: buttonLabel, copied } = useCopy(text, target, label);
  return (
    <button type="button" className="btn btn-sm btn-ghost gap-1.5" data-testid={testId} onClick={copy}>
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
      {buttonLabel}
    </button>
  );
}

/** The editor and Settings share one manager; closing this card discards its one-time secret. */
export function AgentCollaborateCard({
  origin,
  open,
  docId,
  onClose,
  expanded: controlledExpanded,
  panelId: controlledPanelId,
  cardRef,
  toggleRef,
  panelRef,
  onToggle,
  onDirectionalKeyCapture,
  onDirectionalKey,
}: {
  origin: string;
  open: boolean;
  docId: string;
  onClose?: () => void;
  expanded?: boolean;
  panelId?: string;
  cardRef?: (element: HTMLElement | null) => void;
  toggleRef?: (element: HTMLButtonElement | null) => void;
  panelRef?: (element: HTMLDivElement | null) => void;
  onToggle?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onDirectionalKeyCapture?: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  onDirectionalKey?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  const [mount] = useState(() => Symbol("share-agent-card"));
  const [localExpanded, setLocalExpanded] = useState(false);
  const id = useId();
  const expanded = controlledExpanded ?? localExpanded;
  const panelId = controlledPanelId ?? `${id}-panel`;
  const localCardRef = useRef<HTMLElement | null>(null);
  const localToggleRef = useRef<HTMLButtonElement | null>(null);
  const localPanelRef = useRef<HTMLDivElement | null>(null);
  const localPublicationRef = useRef<LocalAgentCardPublication | null>(null);
  const localClaimedActionsRef = useRef(new WeakSet<object>());
  const localClaimedPairsRef = useRef(new WeakSet<object>());
  const localClaimedReactEventsRef = useRef(new WeakSet<object>());
  const localClaimedNativeEventsRef = useRef(new WeakSet<Event>());
  const localRender: LocalAgentCardRender = Object.freeze({
    mount,
    origin,
    open,
    docId,
    onClose,
    expanded,
    panelId,
  });

  useLayoutEffect(() => {
    const previous = localPublicationRef.current;
    if (previous) {
      localPublicationRef.current = null;
      retireLocalAgentCardPublication(previous);
    }
    if (
      controlledExpanded !== undefined ||
      onDirectionalKeyCapture ||
      onDirectionalKey
    ) {
      return;
    }
    const card = localCardRef.current;
    const control = localToggleRef.current;
    const panel = localPanelRef.current;
    const ownerDocument = control?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (
      !card ||
      !control ||
      !panel ||
      !ownerDocument ||
      !ownerWindow ||
      card.ownerDocument !== ownerDocument ||
      panel.ownerDocument !== ownerDocument
    ) {
      return;
    }
    const placement = snapshotSharePlacement(card, ownerDocument);
    const intrinsics = captureShareDirectionalIntrinsics(ownerWindow);
    if (!placement || !intrinsics) return;
    const publication: LocalAgentCardPublication = {
      render: localRender,
      card,
      control,
      panel,
      ownerDocument,
      ownerWindow,
      placement,
      intrinsics,
      directionalCapture: null,
      directionalPairs: new WeakMap(),
      directionalFence: null,
      observer: null,
      placementObserver: null,
      active: false,
      claimed: false,
      mutated: false,
      placementMutated: false,
    };
    if (
      !localAgentCardDomIsExact(publication) ||
      !sharePlacementMatches(ownerDocument, placement)
    ) {
      return;
    }
    const Observer = ownerWindow.MutationObserver;
    if (typeof Observer !== "function") return;
    const observer = new Observer((records) => {
      if (
        records.some((record) =>
          mutationTouchesLocalAgentCard(publication, record))
      ) {
        publication.mutated = true;
      }
    });
    observer.observe(card, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    const placementObserver = new Observer((records) => {
      if (
        records.some((record) =>
          mutationTouchesSharePlacement(publication.placement, record))
      ) {
        publication.placementMutated = true;
      }
    });
    for (const parent of new Set(
      placement.map(({ parent }) => parent),
    )) {
      placementObserver.observe(parent, { childList: true });
    }
    publication.observer = observer;
    publication.placementObserver = placementObserver;
    publication.active = true;
    localPublicationRef.current = publication;
    const directionalCapture = installShareDirectionalNativeCapture(
      control,
      intrinsics,
      () =>
        localPublicationRef.current === publication &&
        publication.active &&
        !publication.claimed &&
        publication.directionalFence === null &&
        drainLocalAgentCardMutations(publication) &&
        sharePlacementMatches(ownerDocument, placement) &&
        localAgentCardDomIsExact(publication),
    );
    if (!directionalCapture) {
      localPublicationRef.current = null;
      retireLocalAgentCardPublication(publication);
      return;
    }
    publication.directionalCapture = directionalCapture;
    return () => {
      if (localPublicationRef.current === publication) {
        localPublicationRef.current = null;
      }
      retireLocalAgentCardPublication(publication);
    };
  }, [
    controlledExpanded,
    localRender,
    onDirectionalKey,
    onDirectionalKeyCapture,
  ]);

  const publishLocalDirectionalKey = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    const publication = localPublicationRef.current;
    let nativeEvent: Event;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return;
    }
    if (!nativeEvent || typeof nativeEvent !== "object") return;
    const registration = publication?.directionalCapture;
    const snapshot = publication && nativeEvent
      ? readShareDirectionalNativeEvent(nativeEvent, publication.intrinsics)
      : null;
    const stage =
      publication &&
      registration &&
      publication.intrinsics.getPrototypeOf(nativeEvent) ===
        publication.intrinsics.keyboardPrototype
        ? registration.proofFor(nativeEvent as KeyboardEvent)
        : null;
    const nextExpanded = snapshot
      ? shareDirectionalDestination(snapshot.key, localRender.expanded)
      : null;
    if (
      !publication ||
      !registration ||
      !stage ||
      !snapshot ||
      nextExpanded === null ||
      publication.directionalFence !== null ||
      publication.directionalPairs.has(stage.nativeEvent) ||
      publication.render !== localRender ||
      publication.render.mount !== mount ||
      publication.render.origin !== origin ||
      publication.render.open !== open ||
      publication.render.docId !== docId ||
      publication.render.onClose !== onClose ||
      publication.render.expanded !== expanded ||
      publication.render.panelId !== panelId
    ) {
      return;
    }
    const action = Object.freeze<LocalAgentDirectionalAction>({
      publication,
      render: localRender,
      expanded,
      nextExpanded,
      card: publication.card,
      control: publication.control,
      panel: publication.panel,
    });
    const capture = captureShareDirectionalReactEvent(
      event,
      nativeEvent,
      snapshot,
      publication.control,
      publication.ownerDocument,
      publication.ownerWindow,
      publication.intrinsics,
      publication.intrinsics.capturingPhase,
    );
    if (
      !Object.isFrozen(action) ||
      !publication.active ||
      publication.claimed ||
      localClaimedActionsRef.current.has(action) ||
      localClaimedReactEventsRef.current.has(event) ||
      localClaimedNativeEventsRef.current.has(nativeEvent) ||
      !drainLocalAgentCardMutations(publication) ||
      !sharePlacementMatches(
        publication.ownerDocument,
        publication.placement,
      ) ||
      !localAgentCardDomIsExact(publication) ||
      !capture ||
      !shareDirectionalStageMatches(
        stage,
        registration,
        stage.nativeEvent,
        snapshot,
        publication.control,
        publication.ownerDocument,
        publication.ownerWindow,
        publication.intrinsics,
      ) ||
      publication.intrinsics.apply(
        publication.intrinsics.activeElement,
        publication.ownerDocument,
        [],
      ) !== publication.control
    ) {
      return;
    }
    const pair: ShareDirectionalPair<
      LocalAgentCardPublication,
      LocalAgentDirectionalAction
    > = {
      publication,
      action,
      nativeEvent: stage.nativeEvent,
      stage,
      capture,
    };
    Object.freeze(pair);
    publication.directionalPairs.set(stage.nativeEvent, pair);
    publication.directionalFence = pair;
    const revalidate = () => {
      const currentSnapshot = readShareDirectionalNativeEvent(
        stage.nativeEvent,
        publication.intrinsics,
      );
      return Boolean(
        currentSnapshot &&
        localPublicationRef.current === publication &&
        publication.directionalFence === pair &&
        publication.directionalPairs.get(stage.nativeEvent) === pair &&
        publication.directionalCapture === registration &&
        registration.retains(stage) &&
        publication.active &&
        !publication.claimed &&
        publication.render === localRender &&
        action.publication === publication &&
        action.render === localRender &&
        action.expanded === expanded &&
        action.nextExpanded ===
          shareDirectionalDestination(currentSnapshot.key, localRender.expanded) &&
        action.card === publication.card &&
        action.control === publication.control &&
        action.panel === publication.panel &&
        shareDirectionalNativeSnapshotsMatch(
          stage.snapshot,
          currentSnapshot,
        ) &&
        shareDirectionalReactSnapshotIsCurrent(
          capture,
          stage.nativeEvent,
          currentSnapshot,
          publication.control,
          publication.ownerDocument,
          publication.ownerWindow,
          publication.intrinsics,
          publication.intrinsics.capturingPhase,
          publication.control,
          false,
          capture.methods.isDefaultPrevented,
        ) &&
        drainLocalAgentCardMutations(publication) &&
        sharePlacementMatches(
          publication.ownerDocument,
          publication.placement,
        ) &&
        localAgentCardDomIsExact(publication),
      );
    };
    try {
      if (
        !revalidate() ||
        !queryShareDirectionalReactMethod(
          capture,
          capture.methods.isDefaultPrevented,
          false,
          publication.intrinsics,
          revalidate,
        ) ||
        !queryShareDirectionalReactMethod(
          capture,
          capture.methods.isPropagationStopped,
          false,
          publication.intrinsics,
          revalidate,
        )
      ) {
        publication.directionalPairs.delete(stage.nativeEvent);
      }
    } finally {
      if (publication.directionalFence === pair) {
        publication.directionalFence = null;
      }
    }
  };

  const handleLocalDirectionalKey = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    const publication = localPublicationRef.current;
    let nativeEvent: Event;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return;
    }
    if (!nativeEvent || typeof nativeEvent !== "object") return;
    const pairKey =
      publication &&
      publication.intrinsics.getPrototypeOf(nativeEvent) ===
        publication.intrinsics.keyboardPrototype
        ? nativeEvent as KeyboardEvent
        : null;
    const pair =
      publication && pairKey
        ? publication.directionalPairs.get(pairKey)
        : undefined;
    const action = pair?.action;
    const snapshot = publication && nativeEvent
      ? readShareDirectionalNativeEvent(nativeEvent, publication.intrinsics)
      : null;
    if (
      !publication ||
      !pair ||
      !action ||
      !snapshot ||
      publication.directionalFence !== null ||
      pair.publication !== publication ||
      pair.action !== action ||
      pair.nativeEvent !== nativeEvent ||
      pair.capture.nativeEvent !== nativeEvent ||
      pair.capture.event === event ||
      localClaimedPairsRef.current.has(pair) ||
      action.publication !== publication ||
      action.render !== localRender ||
      action.expanded !== expanded ||
      action.nextExpanded !==
        shareDirectionalDestination(snapshot.key, localRender.expanded) ||
      action.card !== publication.card ||
      action.control !== publication.control ||
      action.panel !== publication.panel ||
      publication.render !== localRender ||
      publication.render.mount !== mount ||
      publication.render.origin !== origin ||
      publication.render.open !== open ||
      publication.render.docId !== docId ||
      publication.render.onClose !== onClose ||
      publication.render.expanded !== expanded ||
      publication.render.panelId !== panelId ||
      publication.claimed ||
      localClaimedActionsRef.current.has(action) ||
      localClaimedPairsRef.current.has(pair) ||
      localClaimedReactEventsRef.current.has(pair.capture.event) ||
      localClaimedReactEventsRef.current.has(event) ||
      localClaimedNativeEventsRef.current.has(nativeEvent)
    ) {
      return;
    }
    const bubble = captureShareDirectionalReactEvent(
      event,
      nativeEvent,
      snapshot,
      publication.control,
      publication.ownerDocument,
      publication.ownerWindow,
      publication.intrinsics,
      publication.intrinsics.bubblingPhase,
    );
    if (
      !bubble ||
      pair.capture.target !== bubble.target ||
      pair.capture.currentTarget !== bubble.currentTarget ||
      pair.capture.eventPhase !== publication.intrinsics.capturingPhase ||
      bubble.eventPhase !== publication.intrinsics.bubblingPhase ||
      !shareDirectionalStageMatches(
        pair.stage,
        pair.stage.registration,
        pair.nativeEvent,
        snapshot,
        publication.control,
        publication.ownerDocument,
        publication.ownerWindow,
        publication.intrinsics,
      ) ||
      !publication.active ||
      !drainLocalAgentCardMutations(publication) ||
      !sharePlacementMatches(
        publication.ownerDocument,
        publication.placement,
      ) ||
      !localAgentCardDomIsExact(publication) ||
      publication.intrinsics.apply(
        publication.intrinsics.activeElement,
        publication.ownerDocument,
        [],
      ) !== publication.control
    ) {
      return;
    }
    publication.directionalFence = pair;
    const registration = pair.stage.registration;
    const revalidate = (
      expectedNativeDefaultPrevented: boolean,
      bubbleDefaultQuery: ShareDirectionalReactMethod,
    ) => {
      const currentSnapshot = readShareDirectionalNativeEvent(
        pair.nativeEvent,
        publication.intrinsics,
      );
      return Boolean(
        currentSnapshot &&
        localPublicationRef.current === publication &&
        publication.directionalFence === pair &&
        publication.directionalPairs.get(pair.nativeEvent) === pair &&
        publication.directionalCapture === registration &&
        registration.retains(pair.stage) &&
        publication.active &&
        !publication.claimed &&
        publication.render === localRender &&
        action.publication === publication &&
        action.render === localRender &&
        action.expanded === expanded &&
        action.nextExpanded ===
          shareDirectionalDestination(
            currentSnapshot.key,
            localRender.expanded,
          ) &&
        action.card === publication.card &&
        action.control === publication.control &&
        action.panel === publication.panel &&
        shareDirectionalNativeSnapshotsMatch(
          pair.stage.snapshot,
          currentSnapshot,
          expectedNativeDefaultPrevented,
        ) &&
        shareDirectionalReactSnapshotIsCurrent(
          pair.capture,
          pair.nativeEvent,
          pair.stage.snapshot,
          publication.control,
          publication.ownerDocument,
          publication.ownerWindow,
          publication.intrinsics,
          publication.intrinsics.capturingPhase,
          null,
          false,
          pair.capture.methods.isDefaultPrevented,
        ) &&
        shareDirectionalReactSnapshotIsCurrent(
          bubble,
          pair.nativeEvent,
          currentSnapshot,
          publication.control,
          publication.ownerDocument,
          publication.ownerWindow,
          publication.intrinsics,
          publication.intrinsics.bubblingPhase,
          publication.control,
          expectedNativeDefaultPrevented,
          bubbleDefaultQuery,
        ) &&
        publication.intrinsics.apply(
          publication.intrinsics.activeElement,
          publication.ownerDocument,
          [],
        ) === publication.control &&
        drainLocalAgentCardMutations(publication) &&
        sharePlacementMatches(
          publication.ownerDocument,
          publication.placement,
        ) &&
        localAgentCardDomIsExact(publication),
      );
    };
    let committed = false;
    try {
      if (
        !revalidate(false, bubble.methods.isDefaultPrevented) ||
        !queryShareDirectionalReactMethod(
          pair.capture,
          pair.capture.methods.isDefaultPrevented,
          false,
          publication.intrinsics,
          () => revalidate(false, bubble.methods.isDefaultPrevented),
        ) ||
        !queryShareDirectionalReactMethod(
          pair.capture,
          pair.capture.methods.isPropagationStopped,
          false,
          publication.intrinsics,
          () => revalidate(false, bubble.methods.isDefaultPrevented),
        ) ||
        !queryShareDirectionalReactMethod(
          bubble,
          bubble.methods.isDefaultPrevented,
          false,
          publication.intrinsics,
          () => revalidate(false, bubble.methods.isDefaultPrevented),
        ) ||
        !queryShareDirectionalReactMethod(
          bubble,
          bubble.methods.isPropagationStopped,
          false,
          publication.intrinsics,
          () => revalidate(false, bubble.methods.isDefaultPrevented),
        ) ||
        localClaimedActionsRef.current.has(action) ||
        localClaimedPairsRef.current.has(pair) ||
        localClaimedReactEventsRef.current.has(pair.capture.event) ||
        localClaimedReactEventsRef.current.has(event) ||
        localClaimedNativeEventsRef.current.has(nativeEvent) ||
        !registration.claim(pair.stage)
      ) {
        return;
      }
      publication.claimed = true;
      localClaimedActionsRef.current.add(action);
      localClaimedPairsRef.current.add(pair);
      localClaimedReactEventsRef.current.add(pair.capture.event);
      localClaimedReactEventsRef.current.add(event);
      localClaimedNativeEventsRef.current.add(nativeEvent);
      publication.directionalPairs.delete(pair.nativeEvent);
      const claimedIsCurrent = (
        expectedNativeDefaultPrevented: boolean,
        bubbleDefaultQuery: ShareDirectionalReactMethod,
      ) => {
        const currentSnapshot = readShareDirectionalNativeEvent(
          pair.nativeEvent,
          publication.intrinsics,
        );
        return Boolean(
          currentSnapshot &&
          localPublicationRef.current === publication &&
          publication.directionalFence === pair &&
          !publication.directionalPairs.has(pair.nativeEvent) &&
          publication.directionalCapture === registration &&
          registration.retains(pair.stage) &&
          publication.active &&
          publication.claimed &&
          localClaimedActionsRef.current.has(action) &&
          localClaimedPairsRef.current.has(pair) &&
          localClaimedReactEventsRef.current.has(pair.capture.event) &&
          localClaimedReactEventsRef.current.has(event) &&
          localClaimedNativeEventsRef.current.has(nativeEvent) &&
          publication.render === localRender &&
          action.render === localRender &&
          shareDirectionalNativeSnapshotsMatch(
            pair.stage.snapshot,
            currentSnapshot,
            expectedNativeDefaultPrevented,
          ) &&
          shareDirectionalReactSnapshotIsCurrent(
            pair.capture,
            pair.nativeEvent,
            pair.stage.snapshot,
            publication.control,
            publication.ownerDocument,
            publication.ownerWindow,
            publication.intrinsics,
            publication.intrinsics.capturingPhase,
            null,
            false,
            pair.capture.methods.isDefaultPrevented,
          ) &&
          shareDirectionalReactSnapshotIsCurrent(
            bubble,
            pair.nativeEvent,
            currentSnapshot,
            publication.control,
            publication.ownerDocument,
            publication.ownerWindow,
            publication.intrinsics,
            publication.intrinsics.bubblingPhase,
            publication.control,
            expectedNativeDefaultPrevented,
            bubbleDefaultQuery,
          ) &&
          publication.intrinsics.apply(
            publication.intrinsics.activeElement,
            publication.ownerDocument,
            [],
          ) === publication.control &&
          drainLocalAgentCardMutations(publication) &&
          sharePlacementMatches(
            publication.ownerDocument,
            publication.placement,
          ) &&
          localAgentCardDomIsExact(publication),
        );
      };
      if (
        !claimedIsCurrent(false, bubble.methods.isDefaultPrevented) ||
        !callShareDirectionalReactMethod(
          bubble,
          bubble.methods.preventDefault,
          publication.intrinsics,
          () => {
            const currentDefaultQuery = event.isDefaultPrevented;
            return (
              typeof currentDefaultQuery === "function" &&
              claimedIsCurrent(true, currentDefaultQuery)
            );
          },
        )
      ) {
        return;
      }
      const currentDefaultQuery = event.isDefaultPrevented;
      if (
        typeof currentDefaultQuery !== "function" ||
        !claimedIsCurrent(true, currentDefaultQuery) ||
        !queryShareDirectionalReactMethod(
          bubble,
          currentDefaultQuery,
          true,
          publication.intrinsics,
          () => claimedIsCurrent(true, currentDefaultQuery),
        ) ||
        !queryShareDirectionalReactMethod(
          pair.capture,
          pair.capture.methods.isDefaultPrevented,
          false,
          publication.intrinsics,
          () => claimedIsCurrent(true, currentDefaultQuery),
        ) ||
        !queryShareDirectionalReactMethod(
          pair.capture,
          pair.capture.methods.isPropagationStopped,
          false,
          publication.intrinsics,
          () => claimedIsCurrent(true, currentDefaultQuery),
        ) ||
        !queryShareDirectionalReactMethod(
          bubble,
          bubble.methods.isPropagationStopped,
          false,
          publication.intrinsics,
          () => claimedIsCurrent(true, currentDefaultQuery),
        )
      ) {
        return;
      }
      setLocalExpanded(action.nextExpanded);
      committed = true;
    } finally {
      if (!committed && localPublicationRef.current === publication) {
        publication.claimed = false;
      }
      if (publication.directionalFence === pair) {
        publication.directionalFence = null;
      }
    }
  };

  return (
    <section
      ref={(element) => {
        localCardRef.current = element;
        cardRef?.(element);
      }}
      className={AGENT_CARD_CLASS}
      aria-label="Collaborate with an agent"
      data-testid="share-agent-card"
    >
      <button
        ref={(element) => {
          localToggleRef.current = element;
          toggleRef?.(element);
        }}
        type="button"
        className={AGENT_TOGGLE_CLASS}
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={(event) => {
          if (onToggle) {
            onToggle(event);
            return;
          }
          if (isExactNativeClick(event, event.currentTarget)) {
            setLocalExpanded((value) => !value);
          }
        }}
        onKeyDownCapture={(event) => {
          if (onDirectionalKeyCapture) {
            onDirectionalKeyCapture(event);
            return;
          }
          publishLocalDirectionalKey(event);
        }}
        onKeyDown={(event) => {
          if (onDirectionalKey) {
            onDirectionalKey(event);
            return;
          }
          handleLocalDirectionalKey(event);
        }}
        data-testid="share-agent-toggle"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/60 dark:text-violet-300">
          <Bot size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">Collaborate with an agent</span>
          <span className="block truncate text-xs text-ink-3">Connect Copilot CLI or any MCP client as a collaborator</span>
        </span>
        <ChevronDown size={16} className={cn("shrink-0 text-ink-3 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
      </button>
      <div
        ref={(element) => {
          localPanelRef.current = element;
          panelRef?.(element);
        }}
        id={panelId}
        hidden={!expanded}
        className={AGENT_PANEL_CLASS}
      >
        <TokensPanel origin={origin} userLogin="you" documentId={docId} embedded open={open && expanded} onClose={onClose} />
      </div>
    </section>
  );
}
