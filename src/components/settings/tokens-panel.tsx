"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { ArrowLeft, Check, Copy, KeyRound, Loader2, Plus } from "lucide-react";
import { cn, relativeTime } from "@/lib/utils";
import { useCopy, type CopyStatus } from "@/lib/hooks";
import { COPY_FALLBACK_HINT } from "@/lib/clipboard";
import { ApiError, api, apiErrorText, type ApiTokenDto, type CreatedApiTokenDto, type DocumentSummaryDto } from "@/lib/api";
import { SCOPES, TOKEN_SCOPE_LABEL, TOKEN_SCOPE_SUMMARY, type TokenScopeName } from "@/lib/mcp";
import { agentMentionSlug } from "@/editor/collab/mentions";
import { AgentConnectCard, useOrigin } from "@/components/settings/agent-connect-card";

export function ScopeChip({ scope, className }: { scope: TokenScopeName; className?: string }) {
  return (
    <span className={cn("inline-flex rounded-full border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-ink-2", className)}
      title={`${TOKEN_SCOPE_LABEL[scope]}: ${TOKEN_SCOPE_SUMMARY[scope]}`} data-testid="token-scope-chip" data-scope={scope}>
      {scope}
    </span>
  );
}

function tokenState(token: ApiTokenDto) {
  return token.revokedAt ? "Revoked" : token.expiresAt && new Date(token.expiresAt).getTime() < Date.now() ? "Expired" : "Active";
}

interface TokensPanelProps {
  origin: string;
  userLogin: string;
  next?: string | null;
  documentId?: string;
  embedded?: boolean;
  open?: boolean;
  onClose?: () => void;
}

type TokenMutationKind = "rename" | "replace" | "revoke" | "collaborators";

interface MountedOperation {
  mount: symbol;
}

interface ManagerSession {
  readonly authority: symbol;
  readonly origin: string;
  readonly userLogin: string;
  readonly documentId?: string;
}

interface TokenPanelAuthority {
  readonly identity: symbol;
  readonly session: ManagerSession;
  readonly update: typeof api.tokens.update;
}

interface ManagerControlVisit {
  readonly identity: symbol;
  readonly sequence: number;
  session: ManagerSession;
  embedded: boolean | undefined;
  next: string | null | undefined;
  onClose: (() => void) | undefined;
  hashListener: (() => void) | null;
}

interface TokensButtonControl {
  visit: ManagerControlVisit;
  element: HTMLButtonElement | null;
}

type CreatedSecretValue = Readonly<
  Omit<CreatedApiTokenDto, "documentIds"> & {
    documentIds: readonly string[] | null;
  }
>;

interface CreatedSecretPublication {
  readonly identity: symbol;
  readonly sequence: number;
  readonly session: ManagerSession;
  readonly value: CreatedSecretValue;
  retired: boolean;
}

interface ManagerOperation {
  session: ManagerSession;
}

interface CreateOperation extends ManagerOperation {
  name: string;
  expires: string;
  scope: TokenScopeName;
  restrict: boolean;
  documentIds: string[];
}

interface TokenOperation extends ManagerOperation {
  id: string;
  kind: TokenMutationKind;
}

type DocumentListIntent = "initial" | "refresh" | "retry";

interface DocumentListInputs {
  readonly starred?: false;
  readonly trash?: false;
}

type DocumentListApi = typeof api.documents.list;
type BeginDocumentRequest = (
  intent: DocumentListIntent,
  visit: number,
  activation?: DocumentListActivation,
) => void;

interface DocumentListRequest extends MountedOperation {
  id: number;
  inputs: Readonly<DocumentListInputs>;
  list: DocumentListApi;
  promise: ReturnType<typeof api.documents.list>;
}

interface DocumentListOperation extends MountedOperation {
  session: ManagerSession;
  visit: number;
  requestId: number;
  intent: DocumentListIntent;
  request: DocumentListRequest;
  callback: BeginDocumentRequest;
  list: DocumentListApi;
  activation: DocumentListActivation | null;
  pendingCommit: DocumentChooserCommit | null;
}

interface DocumentChooserAction {
  readonly identity: symbol;
  readonly intent: "refresh" | "retry";
  claimed: boolean;
}

interface DocumentChooserSlot<T extends HTMLElement> {
  element: T | null;
}

interface DocumentChooserCandidate {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly session: ManagerSession;
  readonly visit: number;
  readonly requestSequence: number;
  readonly inputs: Readonly<DocumentListInputs>;
  readonly callback: BeginDocumentRequest;
  readonly list: DocumentListApi;
  readonly pending: DocumentListOperation | null;
  readonly action: DocumentChooserAction | null;
  readonly buttonLabel: "Refresh documents" | "Retry documents";
  readonly root: DocumentChooserSlot<HTMLDivElement>;
  readonly button: DocumentChooserSlot<HTMLButtonElement>;
}

interface DocumentChooserCommit {
  readonly candidate: DocumentChooserCandidate;
  readonly ownerDocument: Document;
  readonly root: HTMLDivElement;
  readonly button: HTMLButtonElement;
  dom: SecretNoticeDomSnapshot | null;
  placement: readonly SecretNoticePlacement[] | null;
  buttonTargets: readonly Node[];
  established: boolean;
  retired: boolean;
  mutated: boolean;
  observer: MutationObserver | null;
}

interface DocumentListActivation {
  readonly commit: DocumentChooserCommit;
  readonly action: DocumentChooserAction;
  readonly button: HTMLButtonElement;
  readonly ownerDocument: Document;
  readonly inputs: Readonly<DocumentListInputs>;
  readonly callback: BeginDocumentRequest;
  readonly list: DocumentListApi;
}

type SecretNoticeRole = "notice" | "code" | "copy" | "hide";
type SecretNoticeActionKind = "copy" | "hide";

interface SecretNoticeRender {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly visit: ManagerControlVisit;
  readonly visitIdentity: symbol;
  readonly visitSequence: number;
  readonly session: ManagerSession;
  readonly sessionAuthority: symbol;
  readonly origin: string;
  readonly userLogin: string;
  readonly documentId: string | undefined;
  readonly embedded: boolean | undefined;
  readonly next: string | null | undefined;
  readonly onClose: (() => void) | undefined;
  readonly publication: CreatedSecretPublication;
  readonly publicationIdentity: symbol;
  readonly publicationSequence: number;
  readonly created: CreatedSecretValue;
  readonly buttonControl: TokensButtonControl;
  readonly owns: SecretNoticeOwner;
  readonly dismiss: SecretNoticeDismiss;
  readonly copySetup: Readonly<{
    copy: () => void;
    status: CopyStatus;
    label: string;
    copied: boolean;
  }>;
  readonly copy: () => void;
  readonly status: CopyStatus;
  readonly label: string;
  readonly copied: boolean;
  readonly headline: string;
  readonly access: string;
}

interface SecretNoticeElements {
  notice: HTMLDivElement | null;
  code: HTMLElement | null;
  copy: HTMLButtonElement | null;
  hide: HTMLButtonElement | null;
}

interface SecretNoticeAction {
  readonly identity: symbol;
  readonly kind: SecretNoticeActionKind;
  claimed: boolean;
}

interface SecretNoticeGeneration {
  readonly identity: symbol;
  readonly render: SecretNoticeRender;
  readonly elements: SecretNoticeElements;
  readonly bindings: Record<SecretNoticeRole, SecretNoticeBinding | null>;
  readonly actions: Readonly<Record<SecretNoticeActionKind, SecretNoticeAction>>;
  authority: SecretNoticeDraft | null;
  target: RefObject<HTMLElement | null> | null;
}

interface SecretNoticeDraft {
  readonly identity: symbol;
  readonly render: SecretNoticeRender;
  readonly generation: SecretNoticeGeneration;
  committed: boolean;
  retired: boolean;
}

interface SecretNoticeBinding {
  readonly identity: symbol;
  readonly generation: SecretNoticeGeneration;
  readonly role: SecretNoticeRole;
  readonly element: HTMLElement;
  active: boolean;
}

interface SecretNoticeDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly SecretNoticeDomSnapshot[];
}

interface SecretNoticePlacement {
  readonly node: Node;
  readonly parent: Node | null;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

type TokenRenameNativeGetter = (this: object) => unknown;
type TokenRenameEventField =
  | "type"
  | "target"
  | "currentTarget"
  | "eventPhase"
  | "bubbles"
  | "cancelable"
  | "defaultPrevented"
  | "cancelBubble"
  | "composed"
  | "timeStamp";
type TokenRenameKeyboardField =
  | "key"
  | "code"
  | "location"
  | "charCode"
  | "keyCode"
  | "repeat"
  | "isComposing"
  | "ctrlKey"
  | "altKey"
  | "metaKey"
  | "shiftKey";

interface TokenRenameGetterAuthority<Field extends string> {
  readonly getters: Readonly<Record<Field, TokenRenameNativeGetter>>;
  readonly isCurrent: () => boolean;
}

interface TokenRenameMethodAuthority<Method> {
  readonly method: Method;
  readonly isCurrent: () => boolean;
}

interface TokenRenameTrustedAuthority {
  readonly getter: TokenRenameNativeGetter;
  readonly matches: (event: object) => boolean;
  readonly read: (event: object) => boolean;
  readonly isCurrent: () => boolean;
}

interface TokenRenameKeyboardAuthority {
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly Event: typeof Event;
  readonly UIEvent: typeof UIEvent;
  readonly KeyboardEvent: typeof KeyboardEvent;
  readonly Document: typeof Document;
  readonly HTMLElement: typeof HTMLElement;
  readonly Node: typeof Node;
  readonly event: TokenRenameGetterAuthority<TokenRenameEventField>["getters"];
  readonly keyboard: TokenRenameGetterAuthority<TokenRenameKeyboardField>["getters"];
  readonly view: TokenRenameNativeGetter;
  readonly detail: TokenRenameNativeGetter;
  readonly activeElement: TokenRenameNativeGetter;
  readonly composedPath: Event["composedPath"];
  readonly preventDefault: Event["preventDefault"];
  readonly focus: HTMLElement["focus"];
  readonly addEventListener: EventTarget["addEventListener"];
  readonly removeEventListener: EventTarget["removeEventListener"];
  readonly trusted: TokenRenameTrustedAuthority;
  readonly apply: typeof Reflect.apply;
  readonly getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor;
  readonly prototypeOf: typeof Object.getPrototypeOf;
  readonly isCurrent: () => boolean;
}

interface TokenRowKeyboardTerminalProof {
  readonly registration: TokenRowKeyboardTerminalRegistration;
  readonly nativeEvent: KeyboardEvent;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly terminal: EventTarget;
  readonly path: readonly EventTarget[];
}

interface TokenRowKeyboardTerminalRegistration {
  readonly proofFor: (event: KeyboardEvent) => TokenRowKeyboardTerminalProof | null;
  readonly claim: (proof: TokenRowKeyboardTerminalProof) => boolean;
  readonly release: () => void;
  readonly isCurrent: () => boolean;
}

const TOKEN_RENAME_NAVIGATION_KEYS = Object.freeze([
  "ArrowLeft",
  "ArrowUp",
  "ArrowRight",
  "ArrowDown",
  "Home",
  "End",
] as const);
type TokenRenameNavigationKey = (typeof TOKEN_RENAME_NAVIGATION_KEYS)[number];
const TOKEN_RENAME_PREVENT_SCROLL = Object.freeze({ preventScroll: true });

interface SecretNoticePublication {
  readonly identity: symbol;
  readonly render: SecretNoticeRender;
  readonly draft: SecretNoticeDraft;
  readonly generation: SecretNoticeGeneration;
  readonly notice: HTMLDivElement;
  readonly code: HTMLElement;
  readonly copy: HTMLButtonElement;
  readonly hide: HTMLButtonElement;
  readonly bindings: Readonly<Record<SecretNoticeRole, SecretNoticeBinding>>;
  readonly actions: Readonly<Record<SecretNoticeActionKind, SecretNoticeAction>>;
  readonly target: RefObject<HTMLElement | null>;
  readonly ownerDocument: Document;
  readonly dom: SecretNoticeDomSnapshot;
  readonly placement: readonly SecretNoticePlacement[];
  readonly copyTargets: readonly Node[];
  readonly hideTargets: readonly Node[];
  retired: boolean;
  claimed: boolean;
  mutated: boolean;
  observer: MutationObserver | null;
}

interface SecretNoticeCodeOwner {
  readonly binding: SecretNoticeBinding;
  readonly target: RefObject<HTMLElement | null>;
}

interface SecretNoticeReplay {
  readonly publication: SecretNoticePublication;
  readonly generation: SecretNoticeGeneration;
  readonly expected: Readonly<Record<SecretNoticeRole, SecretNoticeBinding>>;
  readonly released: Set<SecretNoticeRole>;
  readonly rebound: Map<SecretNoticeRole, SecretNoticeBinding>;
  layoutRetired: boolean;
  invalid: boolean;
}

type SecretNoticeOwner = (
  visit: ManagerControlVisit,
  publication: CreatedSecretPublication,
  buttonControl: TokensButtonControl,
) => boolean;

type SecretNoticeDismiss = (
  visit: ManagerControlVisit,
  publication: CreatedSecretPublication,
  buttonControl: TokensButtonControl,
) => void;

const SECRET_NOTICE_ROLES = ["notice", "code", "copy", "hide"] as const;
const SECRET_NOTICE_CLASS = "min-w-0 rounded-xl border border-green-200 bg-green-50 p-3 dark:border-green-900 dark:bg-green-950/40";
const SECRET_CODE_CLASS = "mt-2 block select-text break-all rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-ink";
const SECRET_COPY_CLASS = "btn btn-outline btn-sm h-auto max-w-full gap-1.5 whitespace-normal text-left";
const SECRET_HIDE_CLASS = "btn btn-ghost btn-sm";
const SECRET_COPY_LABEL = "Copy token";
const SECRET_HIDE_LABEL = "I stored it - hide secret";
const SECRET_GUIDANCE = "Store it now in a safe place. Only a hash is saved by Markdoc; the secret cannot be recovered or edited.";
const SecretNoticeMutationObserver =
  typeof MutationObserver === "function" ? MutationObserver : null;
const DocumentChooserMutationObserver =
  typeof MutationObserver === "function" ? MutationObserver : null;

function snapshotCreatedSecret(value: CreatedApiTokenDto | CreatedSecretValue): CreatedSecretValue {
  return Object.freeze({
    id: value.id,
    name: value.name,
    token: value.token,
    prefix: value.prefix,
    scope: value.scope,
    documentIds: value.documentIds ? Object.freeze([...value.documentIds]) : null,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  });
}

function createdSecretValuesMatch(left: CreatedSecretValue, right: CreatedSecretValue): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.token === right.token
    && left.prefix === right.prefix
    && left.scope === right.scope
    && left.createdAt === right.createdAt
    && left.expiresAt === right.expiresAt
    && (left.documentIds === null
      ? right.documentIds === null
      : right.documentIds !== null
        && left.documentIds.length === right.documentIds.length
        && left.documentIds.every((id, index) => right.documentIds?.[index] === id));
}

function secretNoticeAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotSecretNoticeDom(node: Node): SecretNoticeDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: secretNoticeAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotSecretNoticeDom)),
  });
}

function secretNoticeDomMatches(snapshot: SecretNoticeDomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = secretNoticeAttributes(node);
  if (attributes === null || snapshot.attributes === null) {
    if (attributes !== snapshot.attributes) return false;
  } else if (
    attributes.length !== snapshot.attributes.length
    || attributes.some(([name, value], index) => {
      const expected = snapshot.attributes?.[index];
      return !expected || name !== expected[0] || value !== expected[1];
    })
  ) {
    return false;
  }
  return node.childNodes.length === snapshot.children.length
    && snapshot.children.every((child, index) =>
      node.childNodes.item(index) === child.node && secretNoticeDomMatches(child));
}

function secretNoticeDomContains(snapshot: SecretNoticeDomSnapshot, target: Node): boolean {
  return snapshot.node === target
    || snapshot.children.some((child) => secretNoticeDomContains(child, target));
}

function secretNoticeNodes(element: HTMLElement): readonly Node[] {
  const nodes: Node[] = [];
  const visit = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(element);
  return Object.freeze(nodes);
}

function exactDocumentChooserEventPath(
  nativeEvent: MouseEvent,
  target: Node,
  ownerDocument: Document,
): boolean {
  const expected: EventTarget[] = [];
  let node: Node | null = target;
  while (node) {
    expected.push(node);
    if (node === ownerDocument) break;
    node = node.parentNode;
  }
  const ownerWindow = ownerDocument.defaultView;
  const actual = nativeEvent.composedPath();
  const pathWindow = actual.at(-1);
  return expected.at(-1) === ownerDocument
    && !!ownerWindow
    && actual.length === expected.length + 1
    && expected.every((entry, index) => actual[index] === entry)
    && typeof pathWindow === "object"
    && pathWindow !== null
    && "document" in pathWindow
    && pathWindow.document === ownerDocument;
}

function snapshotSecretNoticePlacement(root: HTMLElement): readonly SecretNoticePlacement[] | null {
  const placement: SecretNoticePlacement[] = [];
  const ownerDocument = root.ownerDocument;
  let node: Node | null = root;
  while (node) {
    placement.push(Object.freeze({
      node,
      parent: node.parentNode,
      previousSibling: node.previousSibling,
      nextSibling: node.nextSibling,
    }));
    if (node === ownerDocument) return Object.freeze(placement);
    node = node.parentNode;
  }
  return null;
}

function secretNoticePlacementMatches(
  root: HTMLElement,
  ownerDocument: Document,
  placement: readonly SecretNoticePlacement[],
): boolean {
  if (
    placement.length < 2
    || placement[0]?.node !== root
    || placement.at(-1)?.node !== ownerDocument
    || placement.at(-1)?.parent !== null
    || root.ownerDocument !== ownerDocument
    || root.getRootNode() !== ownerDocument
  ) {
    return false;
  }
  return placement.every((entry, index) => (
    entry.node.isConnected
    && entry.node.parentNode === entry.parent
    && entry.node.previousSibling === entry.previousSibling
    && entry.node.nextSibling === entry.nextSibling
    && (index === placement.length - 1 || entry.parent === placement[index + 1]?.node)
  ));
}

function tokenRenameDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  if (
    !current
    || current.configurable !== expected.configurable
    || current.enumerable !== expected.enumerable
    || ("value" in current) !== ("value" in expected)
    || ("writable" in current) !== ("writable" in expected)
    || ("get" in current) !== ("get" in expected)
    || ("set" in current) !== ("set" in expected)
  ) {
    return false;
  }
  return "value" in expected
    ? current.value === expected.value && current.writable === expected.writable
    : current.get === expected.get && current.set === expected.set;
}

function captureTokenRenameGetters<const Fields extends readonly string[]>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  prototype: object,
  fields: Fields,
): TokenRenameGetterAuthority<Fields[number]> | null {
  const entries: [Fields[number], TokenRenameNativeGetter][] = [];
  const descriptors: [Fields[number], PropertyDescriptor][] = [];
  for (const field of fields) {
    const descriptor = getOwnPropertyDescriptor(prototype, field);
    if (!descriptor || typeof descriptor.get !== "function") return null;
    entries.push([field, descriptor.get]);
    descriptors.push([field, Object.freeze({ ...descriptor })]);
  }
  const getters = Object.freeze(
    Object.fromEntries(entries),
  ) as Readonly<Record<Fields[number], TokenRenameNativeGetter>>;
  return Object.freeze({
    getters,
    isCurrent: () => descriptors.every(([field, expected]) =>
      tokenRenameDescriptorsMatch(getOwnPropertyDescriptor(prototype, field), expected)),
  });
}

function captureTokenRenameMethod<Method>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  prototype: object,
  name: PropertyKey,
): TokenRenameMethodAuthority<Method> | null {
  const descriptor = getOwnPropertyDescriptor(prototype, name);
  if (!descriptor || typeof descriptor.value !== "function") return null;
  const expected = Object.freeze({ ...descriptor });
  return Object.freeze({
    method: descriptor.value as Method,
    isCurrent: () =>
      tokenRenameDescriptorsMatch(getOwnPropertyDescriptor(prototype, name), expected),
  });
}

function captureTokenRenameCallableProperty<Method>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  prototypeOf: typeof Object.getPrototypeOf,
  apply: typeof Reflect.apply,
  target: object,
  name: PropertyKey,
): TokenRenameMethodAuthority<Method> | null {
  let current: object | null = target;
  while (current) {
    const descriptor = getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      const method = typeof descriptor.value === "function"
        ? descriptor.value
        : typeof descriptor.get === "function"
          ? apply(descriptor.get, target, [])
          : null;
      if (typeof method !== "function") return null;
      const owner = current;
      const expected = Object.freeze({ ...descriptor });
      return Object.freeze({
        method: method as Method,
        isCurrent: () => {
          const currentDescriptor = getOwnPropertyDescriptor(owner, name);
          return tokenRenameDescriptorsMatch(currentDescriptor, expected)
            && (typeof expected.get !== "function"
              || apply(expected.get, target, []) === method);
        },
      });
    }
    current = prototypeOf(current) as object | null;
  }
  return null;
}

function captureTokenRenameTrustedGetter(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  apply: typeof Reflect.apply,
  probe: KeyboardEvent,
): TokenRenameTrustedAuthority | null {
  const descriptor = getOwnPropertyDescriptor(probe, "isTrusted");
  if (
    !descriptor
    || descriptor.configurable !== false
    || typeof descriptor.get !== "function"
  ) {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  const matches = (event: object) =>
    tokenRenameDescriptorsMatch(getOwnPropertyDescriptor(event, "isTrusted"), expected);
  return Object.freeze({
    getter: descriptor.get,
    matches,
    read: (event: object) =>
      apply(descriptor.get as TokenRenameNativeGetter, event, []) as boolean,
    isCurrent: () => matches(probe),
  });
}

function captureTokenRenameKeyboardAuthority(
  ownerDocument: Document,
  ownerWindow: Window & typeof globalThis,
): TokenRenameKeyboardAuthority | null {
  const objectConstructor = ownerWindow.Object;
  const getOwnPropertyDescriptor = objectConstructor.getOwnPropertyDescriptor;
  const prototypeOf = objectConstructor.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const EventConstructor = ownerWindow.Event;
  const UIEventConstructor = ownerWindow.UIEvent;
  const KeyboardEventConstructor = ownerWindow.KeyboardEvent;
  const DocumentConstructor = ownerWindow.Document;
  const HTMLElementConstructor = ownerWindow.HTMLElement;
  const NodeConstructor = ownerWindow.Node;
  const eventPrototype = EventConstructor.prototype;
  const uiEventPrototype = UIEventConstructor.prototype;
  const keyboardEventPrototype = KeyboardEventConstructor.prototype;
  const documentPrototype = DocumentConstructor.prototype;
  const htmlElementPrototype = HTMLElementConstructor.prototype;
  const event = captureTokenRenameGetters(getOwnPropertyDescriptor, eventPrototype, [
    "type",
    "target",
    "currentTarget",
    "eventPhase",
    "bubbles",
    "cancelable",
    "defaultPrevented",
    "cancelBubble",
    "composed",
    "timeStamp",
  ] as const);
  const keyboard = captureTokenRenameGetters(
    getOwnPropertyDescriptor,
    keyboardEventPrototype,
    [
      "key",
      "code",
      "location",
      "charCode",
      "keyCode",
      "repeat",
      "isComposing",
      "ctrlKey",
      "altKey",
      "metaKey",
      "shiftKey",
    ] as const,
  );
  const ui = captureTokenRenameGetters(getOwnPropertyDescriptor, uiEventPrototype, [
    "view",
    "detail",
  ] as const);
  const document = captureTokenRenameGetters(
    getOwnPropertyDescriptor,
    documentPrototype,
    ["activeElement"] as const,
  );
  const composedPath = captureTokenRenameMethod<Event["composedPath"]>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "composedPath",
  );
  const preventDefault = captureTokenRenameMethod<Event["preventDefault"]>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "preventDefault",
  );
  const focus = captureTokenRenameMethod<HTMLElement["focus"]>(
    getOwnPropertyDescriptor,
    htmlElementPrototype,
    "focus",
  );
  const addEventListener = captureTokenRenameCallableProperty<EventTarget["addEventListener"]>(
    getOwnPropertyDescriptor,
    prototypeOf,
    apply,
    ownerWindow,
    "addEventListener",
  );
  const removeEventListener = captureTokenRenameCallableProperty<EventTarget["removeEventListener"]>(
    getOwnPropertyDescriptor,
    prototypeOf,
    apply,
    ownerWindow,
    "removeEventListener",
  );
  if (
    !event
    || !keyboard
    || !ui
    || !document
    || !composedPath
    || !preventDefault
    || !focus
    || !addEventListener
    || !removeEventListener
  ) return null;
  let probe: KeyboardEvent;
  try {
    probe = new KeyboardEventConstructor("token-rename-keyboard-probe");
  } catch {
    return null;
  }
  const trusted = captureTokenRenameTrustedGetter(getOwnPropertyDescriptor, apply, probe);
  if (!trusted) return null;

  const isCurrent = () =>
    ownerDocument.defaultView === ownerWindow
    && ownerWindow.Object === objectConstructor
    && ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor
    && ownerWindow.Object.getPrototypeOf === prototypeOf
    && ownerWindow.Reflect.apply === apply
    && ownerWindow.Event === EventConstructor
    && ownerWindow.UIEvent === UIEventConstructor
    && ownerWindow.KeyboardEvent === KeyboardEventConstructor
    && ownerWindow.Document === DocumentConstructor
    && ownerWindow.HTMLElement === HTMLElementConstructor
    && ownerWindow.Node === NodeConstructor
    && EventConstructor.prototype === eventPrototype
    && UIEventConstructor.prototype === uiEventPrototype
    && KeyboardEventConstructor.prototype === keyboardEventPrototype
    && DocumentConstructor.prototype === documentPrototype
    && HTMLElementConstructor.prototype === htmlElementPrototype
    && prototypeOf(keyboardEventPrototype) === uiEventPrototype
    && prototypeOf(uiEventPrototype) === eventPrototype
    && event.isCurrent()
    && keyboard.isCurrent()
    && ui.isCurrent()
    && document.isCurrent()
    && composedPath.isCurrent()
    && preventDefault.isCurrent()
    && focus.isCurrent()
    && addEventListener.isCurrent()
    && removeEventListener.isCurrent()
    && trusted.isCurrent();
  if (!isCurrent()) return null;

  return Object.freeze({
    ownerDocument,
    ownerWindow,
    Event: EventConstructor,
    UIEvent: UIEventConstructor,
    KeyboardEvent: KeyboardEventConstructor,
    Document: DocumentConstructor,
    HTMLElement: HTMLElementConstructor,
    Node: NodeConstructor,
    event: event.getters,
    keyboard: keyboard.getters,
    view: ui.getters.view,
    detail: ui.getters.detail,
    activeElement: document.getters.activeElement,
    composedPath: composedPath.method,
    preventDefault: preventDefault.method,
    focus: focus.method,
    addEventListener: addEventListener.method,
    removeEventListener: removeEventListener.method,
    trusted,
    apply,
    getOwnPropertyDescriptor,
    prototypeOf,
    isCurrent,
  });
}

function createTokenRowKeyboardTerminalRegistration(
  authority: TokenRenameKeyboardAuthority,
): TokenRowKeyboardTerminalRegistration | null {
  const proofs = new WeakMap<KeyboardEvent, TokenRowKeyboardTerminalProof>();
  const invalidEvents = new WeakSet<Event>();
  const claimedEvents = new WeakSet<Event>();
  let active = false;
  let released = false;
  let poisoned = false;
  const intrinsicsAreCurrent = () => {
    if (poisoned) return false;
    try {
      const current = authority.isCurrent();
      if (!current) poisoned = true;
      return current;
    } catch {
      poisoned = true;
      return false;
    }
  };

  const listener: EventListener = function (this: EventTarget, event: Event) {
    if (
      !active
      || released
      || authority.prototypeOf(event) !== authority.KeyboardEvent.prototype
      || invalidEvents.has(event)
      || !intrinsicsAreCurrent()
    ) {
      return;
    }
    if (proofs.has(event as KeyboardEvent)) {
      invalidEvents.add(event);
      return;
    }
    try {
      const currentTarget = authority.apply(
        authority.event.currentTarget,
        event,
        [],
      ) as EventTarget | null;
      const phase = authority.apply(
        authority.event.eventPhase,
        event,
        [],
      ) as number;
      const path = authority.apply(authority.composedPath, event, []) as EventTarget[];
      const terminal = path.at(-1);
      if (
        currentTarget !== this
        || terminal !== this
        || phase !== authority.Event.CAPTURING_PHASE
        || path.at(-2) !== authority.ownerDocument
      ) {
        invalidEvents.add(event);
        return;
      }
      proofs.set(
        event as KeyboardEvent,
        Object.freeze({
          registration,
          nativeEvent: event as KeyboardEvent,
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
      !proof
      || !active
      || released
      || claimedEvents.has(event)
      || invalidEvents.has(event)
      || proof.registration !== registration
      || proof.nativeEvent !== event
      || proof.receiver !== proof.currentTarget
      || proof.receiver !== proof.terminal
      || !intrinsicsAreCurrent()
    ) {
      return null;
    }
    try {
      const path = authority.apply(authority.composedPath, event, []) as EventTarget[];
      return path.length === proof.path.length
        && path.every((entry, index) => entry === proof.path[index])
        && path.at(-2) === authority.ownerDocument
        && path.at(-1) === proof.receiver
        ? proof
        : null;
    } catch {
      invalidEvents.add(event);
      return null;
    }
  };

  const registration: TokenRowKeyboardTerminalRegistration = Object.freeze({
    proofFor,
    claim: (proof: TokenRowKeyboardTerminalProof) => {
      if (
        claimedEvents.has(proof.nativeEvent)
        || proofFor(proof.nativeEvent) !== proof
      ) {
        return false;
      }
      claimedEvents.add(proof.nativeEvent);
      return true;
    },
    release: () => {
      if (released) return;
      released = true;
      active = false;
      authority.apply(
        authority.removeEventListener,
        authority.ownerWindow,
        ["keydown", listener, true],
      );
    },
    isCurrent: () =>
      active
      && !released
      && intrinsicsAreCurrent(),
  });

  active = true;
  try {
    authority.apply(
      authority.addEventListener,
      authority.ownerWindow,
      ["keydown", listener, true],
    );
    if (registration.isCurrent()) return registration;
    registration.release();
    return null;
  } catch {
    active = false;
    released = true;
    return null;
  }
}

function tokenRenameNativeValue<Value>(
  authority: TokenRenameKeyboardAuthority,
  getter: TokenRenameNativeGetter,
  event: Event,
): Value {
  return authority.apply(getter, event, []) as Value;
}

function isTokenRenameNavigationKey(key: string): key is TokenRenameNavigationKey {
  return TOKEN_RENAME_NAVIGATION_KEYS.some((candidate) => candidate === key);
}

class TokenRenameMutationHistory {
  private dirty = false;
  private readonly observer: MutationObserver;
  private settlingInput: Readonly<{
    input: HTMLInputElement;
    name: string | null;
  }> | null;

  constructor(
    ownerWindow: Window & typeof globalThis,
    root: HTMLElement,
    placement: readonly SecretNoticePlacement[],
    settlingInput: HTMLInputElement | null,
  ) {
    this.settlingInput = settlingInput
      ? Object.freeze({
        input: settlingInput,
        name: settlingInput.getAttribute("name"),
      })
      : null;
    this.observer = new ownerWindow.MutationObserver((records) => {
      this.record(records);
    });
    this.observer.observe(root, {
      attributes: true,
      attributeOldValue: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    const observed = new Set<Node>([root]);
    for (const entry of placement) {
      if (entry.parent && !observed.has(entry.parent)) {
        this.observer.observe(entry.parent, { childList: true });
        observed.add(entry.parent);
      }
    }
  }

  readonly isPristine = () => {
    this.record(this.observer.takeRecords());
    return !this.dirty;
  };

  readonly disconnect = () => {
    this.settlingInput = null;
    this.observer.disconnect();
  };

  private record(records: MutationRecord[]) {
    if (records.length === 0) return;
    const settling = this.settlingInput;
    this.settlingInput = null;
    if (
      settling
      && records.length === 2
      && settling.input.getAttribute("name") === settling.name
      && records.every((record, index) =>
        record.type === "attributes"
        && record.target === settling.input
        && record.attributeName === "name"
        && record.oldValue === (index === 0 ? settling.name : ""))
    ) {
      return;
    }
    this.dirty = true;
  }
}

type CreateFormEventField =
  | "type"
  | "target"
  | "currentTarget"
  | "eventPhase"
  | "bubbles"
  | "cancelable"
  | "defaultPrevented"
  | "cancelBubble";
type CreateFormKeyboardField =
  | "key"
  | "code"
  | "repeat"
  | "isComposing"
  | "ctrlKey"
  | "altKey"
  | "metaKey"
  | "shiftKey";

interface CreateFormKeyboardAuthority {
  readonly form: HTMLFormElement;
  readonly button: HTMLButtonElement;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly objectPrototype: object;
  readonly Event: typeof Event;
  readonly UIEvent: typeof UIEvent;
  readonly KeyboardEvent: typeof KeyboardEvent;
  readonly Document: typeof Document;
  readonly HTMLElement: typeof HTMLElement;
  readonly event: TokenRenameGetterAuthority<CreateFormEventField>["getters"];
  readonly keyboard: TokenRenameGetterAuthority<CreateFormKeyboardField>["getters"];
  readonly view: TokenRenameNativeGetter;
  readonly activeElement: TokenRenameNativeGetter;
  readonly composedPath: Event["composedPath"];
  readonly preventDefault: Event["preventDefault"];
  readonly focus: HTMLElement["focus"];
  readonly trusted: TokenRenameTrustedAuthority;
  readonly apply: typeof Reflect.apply;
  readonly prototypeOf: typeof Object.getPrototypeOf;
  readonly isPrototypeOf: typeof Object.prototype.isPrototypeOf;
  readonly isCurrent: () => boolean;
  readonly targets: readonly HTMLElement[];
}

interface CreateFormKeyboardSnapshot {
  readonly event: KeyboardEvent;
  readonly target: HTMLElement;
  readonly currentTarget: EventTarget;
  readonly phase: number;
  readonly path: readonly EventTarget[];
  readonly view: Window;
}

interface CreateFormKeyboardPair {
  readonly identity: symbol;
  readonly publication: CreateFormPublication;
  readonly action: CreateFormAction;
  readonly captureReactEvent: ReactKeyboardEvent<HTMLFormElement>;
  readonly nativeEvent: Event;
  readonly capture: CreateFormKeyboardSnapshot;
  bubbleReactEvent: ReactKeyboardEvent<HTMLFormElement> | null;
  claimed: boolean;
}

interface CreateFormButtonControl {
  readonly visit: ManagerControlVisit;
  element: HTMLButtonElement | null;
}

interface CreateFormFacts {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly visit: ManagerControlVisit;
  readonly visitIdentity: symbol;
  readonly visitSequence: number;
  readonly session: ManagerSession;
  readonly sessionAuthority: symbol;
  readonly origin: string;
  readonly userLogin: string;
  readonly documentId: string | undefined;
  readonly embedded: boolean | undefined;
  readonly next: string | null | undefined;
  readonly onClose: (() => void) | undefined;
  readonly destination: "tokens";
  readonly tokens: ApiTokenDto[] | null;
  readonly name: string;
  readonly expires: string;
  readonly scope: TokenScopeName;
  readonly restrict: boolean;
  readonly documentIdsSource: string[];
  readonly documentIds: readonly string[];
  readonly documents: DocumentSummaryDto[] | null;
  readonly documentError: string | null;
  readonly documentPending: DocumentListOperation | null;
  readonly createPending: CreateOperation | null;
  readonly pendingActionsSource: Record<string, TokenOperation>;
  readonly pendingActions: readonly (readonly [string, TokenOperation])[];
  readonly error: string | null;
  readonly conflictName: string | null;
  readonly createdPublication: CreatedSecretPublication | null;
  readonly createOwner: CreateOperation | null;
  readonly tokenOwners: readonly (readonly [string, TokenOperation])[];
  readonly documentOwner: DocumentListOperation | null;
  readonly documentVisit: number | null;
  readonly documentRequestSequence: number;
  readonly documentCallback: BeginDocumentRequest | null;
  readonly documentCandidate: DocumentChooserCandidate | null;
  readonly documentCommit: DocumentChooserCommit | null;
  readonly restrictionError: string | null;
  readonly documentAuthorityUnavailable: boolean;
  readonly buttonEligible: boolean;
  readonly cancel: (visit: ManagerControlVisit) => void;
  readonly submit: () => Promise<void>;
  readonly beginDocumentVisit: () => void;
  readonly retireDocumentVisit: (updatePending?: boolean, expectedVisit?: number) => void;
  readonly buttonControl: CreateFormButtonControl;
}

interface CreateFormAction {
  readonly identity: symbol;
  readonly kind: "cancel";
  claimed: boolean;
}

interface CreateFormSlot<T extends HTMLElement> {
  readonly identity: symbol;
  readonly role: "button" | "form";
  element: T | null;
}

interface CreateFormPublication {
  readonly identity: symbol;
  readonly facts: CreateFormFacts;
  readonly action: CreateFormAction;
  readonly button: CreateFormSlot<HTMLButtonElement>;
  readonly form: CreateFormSlot<HTMLFormElement>;
  keyboard: CreateFormKeyboardAuthority | null;
  keyboardPair: CreateFormKeyboardPair | null;
  dom: SecretNoticeDomSnapshot | null;
  buttonDom: SecretNoticeDomSnapshot | null;
  placement: readonly SecretNoticePlacement[] | null;
  history: CreateFormMutationHistory | null;
  established: boolean;
  retired: boolean;
  replayed: boolean;
  claimed: boolean;
}

interface CreateFormReplay {
  readonly publication: CreateFormPublication;
  readonly button: HTMLButtonElement;
  readonly form: HTMLFormElement;
  readonly released: Set<CreateFormSlot<HTMLElement>>;
  readonly rebound: Set<CreateFormSlot<HTMLElement>>;
  layoutReleased: boolean;
  invalid: boolean;
}

interface CreateFormFocusIntent {
  readonly publication: CreateFormPublication;
  readonly facts: CreateFormFacts;
  readonly authority: CreateFormKeyboardAuthority;
  readonly button: HTMLButtonElement;
  readonly ownerDocument: Document;
  readonly buttonControl: CreateFormButtonControl;
}

interface CreateFormLayoutCycle {
  readonly setup: () => void;
  readonly cleanup: () => void;
}

class CreateFormMutationHistory {
  private dirty = false;
  private readonly observer: MutationObserver;

  constructor(
    ownerWindow: Window & typeof globalThis,
    form: HTMLFormElement,
    button: HTMLButtonElement,
    placement: readonly SecretNoticePlacement[],
  ) {
    this.observer = new ownerWindow.MutationObserver((records) => {
      if (records.length > 0) this.dirty = true;
    });
    this.observer.observe(form, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    this.observer.observe(button, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    const observed = new Set<Node>([form, button]);
    for (const entry of placement) {
      if (entry.parent && !observed.has(entry.parent)) {
        this.observer.observe(entry.parent, { childList: true });
        observed.add(entry.parent);
      }
    }
  }

  readonly isPristine = () => {
    if (this.observer.takeRecords().length > 0) this.dirty = true;
    return !this.dirty;
  };

  readonly disconnect = () => {
    this.observer.disconnect();
  };
}

function captureCreateFormKeyboardAuthority(
  form: HTMLFormElement,
  button: HTMLButtonElement,
): CreateFormKeyboardAuthority | null {
  const ownerDocument = form.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (
    !ownerWindow
    || button.ownerDocument !== ownerDocument
    || !form.isConnected
    || !button.isConnected
  ) {
    return null;
  }
  const objectConstructor = ownerWindow.Object;
  const objectPrototype = objectConstructor.prototype;
  const getOwnPropertyDescriptor = objectConstructor.getOwnPropertyDescriptor;
  const prototypeOf = objectConstructor.getPrototypeOf;
  const reflectObject = ownerWindow.Reflect;
  const apply = reflectObject.apply;
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
  const event = captureTokenRenameGetters(getOwnPropertyDescriptor, eventPrototype, [
    "type",
    "target",
    "currentTarget",
    "eventPhase",
    "bubbles",
    "cancelable",
    "defaultPrevented",
    "cancelBubble",
  ] as const);
  const keyboard = captureTokenRenameGetters(
    getOwnPropertyDescriptor,
    keyboardEventPrototype,
    [
      "key",
      "code",
      "repeat",
      "isComposing",
      "ctrlKey",
      "altKey",
      "metaKey",
      "shiftKey",
    ] as const,
  );
  const ui = captureTokenRenameGetters(getOwnPropertyDescriptor, uiEventPrototype, [
    "view",
  ] as const);
  const document = captureTokenRenameGetters(
    getOwnPropertyDescriptor,
    documentPrototype,
    ["activeElement"] as const,
  );
  const composedPath = captureTokenRenameMethod<Event["composedPath"]>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "composedPath",
  );
  const preventDefault = captureTokenRenameMethod<Event["preventDefault"]>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "preventDefault",
  );
  const focus = captureTokenRenameMethod<HTMLElement["focus"]>(
    getOwnPropertyDescriptor,
    htmlElementPrototype,
    "focus",
  );
  const getOwnPropertyDescriptorMethod = captureTokenRenameMethod<
    typeof Object.getOwnPropertyDescriptor
  >(getOwnPropertyDescriptor, objectConstructor, "getOwnPropertyDescriptor");
  const getPrototypeOfMethod = captureTokenRenameMethod<typeof Object.getPrototypeOf>(
    getOwnPropertyDescriptor,
    objectConstructor,
    "getPrototypeOf",
  );
  const isPrototypeOfMethod = captureTokenRenameMethod<
    typeof Object.prototype.isPrototypeOf
  >(getOwnPropertyDescriptor, objectPrototype, "isPrototypeOf");
  const applyMethod = captureTokenRenameMethod<typeof Reflect.apply>(
    getOwnPropertyDescriptor,
    reflectObject,
    "apply",
  );
  if (
    !event
    || !keyboard
    || !ui
    || !document
    || !composedPath
    || !preventDefault
    || !focus
    || !getOwnPropertyDescriptorMethod
    || !getPrototypeOfMethod
    || !isPrototypeOfMethod
    || !applyMethod
  ) {
    return null;
  }
  let probe: KeyboardEvent;
  try {
    probe = new KeyboardEventConstructor("token-create-keyboard-probe");
  } catch {
    return null;
  }
  const trusted = captureTokenRenameTrustedGetter(getOwnPropertyDescriptor, apply, probe);
  if (!trusted) return null;
  const targets = [
    form,
    ...[...form.querySelectorAll("*")].filter(
      (target): target is HTMLElement => target instanceof HTMLElementConstructor,
    ),
  ];
  let invalid = false;
  const isCurrent = () => {
    if (invalid) return false;
    try {
      const current = ownerDocument.defaultView === ownerWindow
        && ownerWindow.Object === objectConstructor
        && ownerWindow.Object.prototype === objectPrototype
        && ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor
        && ownerWindow.Object.getPrototypeOf === prototypeOf
        && ownerWindow.Object.prototype.isPrototypeOf === isPrototypeOfMethod.method
        && ownerWindow.Reflect === reflectObject
        && ownerWindow.Reflect.apply === apply
        && ownerWindow.Event === EventConstructor
        && ownerWindow.UIEvent === UIEventConstructor
        && ownerWindow.KeyboardEvent === KeyboardEventConstructor
        && ownerWindow.Document === DocumentConstructor
        && ownerWindow.HTMLElement === HTMLElementConstructor
        && EventConstructor.prototype === eventPrototype
        && UIEventConstructor.prototype === uiEventPrototype
        && KeyboardEventConstructor.prototype === keyboardEventPrototype
        && DocumentConstructor.prototype === documentPrototype
        && HTMLElementConstructor.prototype === htmlElementPrototype
        && prototypeOf(probe) === keyboardEventPrototype
        && prototypeOf(keyboardEventPrototype) === uiEventPrototype
        && prototypeOf(uiEventPrototype) === eventPrototype
        && event.isCurrent()
        && keyboard.isCurrent()
        && ui.isCurrent()
        && document.isCurrent()
        && composedPath.isCurrent()
        && preventDefault.isCurrent()
        && focus.isCurrent()
        && trusted.isCurrent()
        && getOwnPropertyDescriptorMethod.isCurrent()
        && getPrototypeOfMethod.isCurrent()
        && isPrototypeOfMethod.isCurrent()
        && applyMethod.isCurrent()
        && apply(isPrototypeOfMethod.method, keyboardEventPrototype, [probe]) === true;
      if (!current) invalid = true;
      return current;
    } catch {
      invalid = true;
      return false;
    }
  };
  try {
    if (!isCurrent() || trusted.read(probe) !== false) return null;
  } catch {
    return null;
  }
  return Object.freeze({
    form,
    button,
    ownerDocument,
    ownerWindow,
    objectPrototype,
    Event: EventConstructor,
    UIEvent: UIEventConstructor,
    KeyboardEvent: KeyboardEventConstructor,
    Document: DocumentConstructor,
    HTMLElement: HTMLElementConstructor,
    event: event.getters,
    keyboard: keyboard.getters,
    view: ui.getters.view,
    activeElement: document.getters.activeElement,
    composedPath: composedPath.method,
    preventDefault: preventDefault.method,
    focus: focus.method,
    trusted,
    apply,
    prototypeOf,
    isPrototypeOf: isPrototypeOfMethod.method,
    isCurrent,
    targets: Object.freeze(targets),
  });
}

function createFormNativeValue<Value>(
  authority: CreateFormKeyboardAuthority,
  getter: TokenRenameNativeGetter,
  target: object,
): Value {
  return authority.apply(getter, target, []) as Value;
}

function captureCreateFormEscape(
  authority: CreateFormKeyboardAuthority,
  nativeEvent: Event,
  expectedPhase: number,
): CreateFormKeyboardSnapshot | null {
  if (
    !authority.isCurrent()
    || authority.prototypeOf(nativeEvent) !== authority.KeyboardEvent.prototype
    || authority.apply(
      authority.isPrototypeOf,
      authority.KeyboardEvent.prototype,
      [nativeEvent],
    ) !== true
    || !authority.trusted.matches(nativeEvent)
  ) {
    return null;
  }
  try {
    const target = createFormNativeValue<EventTarget | null>(
      authority,
      authority.event.target,
      nativeEvent,
    );
    const currentTarget = createFormNativeValue<EventTarget | null>(
      authority,
      authority.event.currentTarget,
      nativeEvent,
    );
    const phase = createFormNativeValue<number>(
      authority,
      authority.event.eventPhase,
      nativeEvent,
    );
    const view = createFormNativeValue<Window | null>(
      authority,
      authority.view,
      nativeEvent,
    );
    const activeElement = createFormNativeValue<Element | null>(
      authority,
      authority.activeElement,
      authority.ownerDocument,
    );
    const path = authority.apply(authority.composedPath, nativeEvent, []) as EventTarget[];
    if (
      createFormNativeValue<string>(authority, authority.event.type, nativeEvent) !== "keydown"
      || !(target instanceof authority.HTMLElement)
      || !currentTarget
      || phase !== expectedPhase
      || !createFormNativeValue<boolean>(authority, authority.event.bubbles, nativeEvent)
      || !createFormNativeValue<boolean>(authority, authority.event.cancelable, nativeEvent)
      || createFormNativeValue<boolean>(authority, authority.event.defaultPrevented, nativeEvent)
      || createFormNativeValue<boolean>(authority, authority.event.cancelBubble, nativeEvent)
      || createFormNativeValue<string>(authority, authority.keyboard.key, nativeEvent) !== "Escape"
      || createFormNativeValue<string>(authority, authority.keyboard.code, nativeEvent) !== "Escape"
      || createFormNativeValue<boolean>(authority, authority.keyboard.repeat, nativeEvent)
      || createFormNativeValue<boolean>(authority, authority.keyboard.isComposing, nativeEvent)
      || createFormNativeValue<boolean>(authority, authority.keyboard.ctrlKey, nativeEvent)
      || createFormNativeValue<boolean>(authority, authority.keyboard.altKey, nativeEvent)
      || createFormNativeValue<boolean>(authority, authority.keyboard.metaKey, nativeEvent)
      || createFormNativeValue<boolean>(authority, authority.keyboard.shiftKey, nativeEvent)
      || view !== authority.ownerWindow
      || authority.trusted.read(nativeEvent) !== true
      || target.ownerDocument !== authority.ownerDocument
      || activeElement !== target
      || !authority.targets.includes(target)
      || !authority.form.isConnected
      || !authority.button.isConnected
      || (!authority.form.contains(target) && authority.form !== target)
    ) {
      return null;
    }
    const expectedPath: EventTarget[] = [];
    let node: Node | null = target;
    while (node) {
      expectedPath.push(node);
      if (node === authority.ownerDocument) break;
      node = node.parentNode;
    }
    expectedPath.push(authority.ownerWindow);
    if (
      expectedPath.at(-2) !== authority.ownerDocument
      || path.length !== expectedPath.length
      || path.some((entry, index) => entry !== expectedPath[index])
      || !path.includes(authority.form)
      || !path.includes(currentTarget)
    ) {
      return null;
    }
    return Object.freeze({
      event: nativeEvent as KeyboardEvent,
      target,
      currentTarget,
      phase,
      path: Object.freeze([...path]),
      view,
    });
  } catch {
    return null;
  }
}

function createFormEscapeMatches(
  authority: CreateFormKeyboardAuthority,
  snapshot: CreateFormKeyboardSnapshot,
) {
  const current = captureCreateFormEscape(authority, snapshot.event, snapshot.phase);
  return Boolean(
    current
    && current.target === snapshot.target
    && current.currentTarget === snapshot.currentTarget
    && current.phase === snapshot.phase
    && current.view === snapshot.view
    && current.path.length === snapshot.path.length
    && current.path.every((entry, index) => entry === snapshot.path[index]),
  );
}

function exactCreateFormReactEvent(
  event: ReactKeyboardEvent<HTMLFormElement>,
  authority: CreateFormKeyboardAuthority,
  snapshot: CreateFormKeyboardSnapshot,
) {
  try {
    const reactEvent = event as ReactKeyboardEvent<HTMLFormElement> & {
      isComposing?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
      isPersistent?: unknown;
      persist?: unknown;
    };
    return event.nativeEvent === snapshot.event
      && event.type === "keydown"
      && event.target === snapshot.target
      && event.currentTarget === authority.form
      && event.eventPhase === snapshot.phase
      && event.bubbles === true
      && event.cancelable === true
      && event.defaultPrevented === false
      && event.isTrusted === true
      && event.key === "Escape"
      && event.code === "Escape"
      && event.repeat === false
      && (typeof reactEvent.isComposing === "undefined" || reactEvent.isComposing === false)
      && event.ctrlKey === false
      && event.altKey === false
      && event.metaKey === false
      && event.shiftKey === false
      && Object.is(event.view, authority.ownerWindow)
      && typeof event.preventDefault === "function"
      && typeof event.stopPropagation === "function"
      && typeof reactEvent.isDefaultPrevented === "function"
      && !authority.apply(reactEvent.isDefaultPrevented as () => boolean, event, [])
      && typeof reactEvent.isPropagationStopped === "function"
      && !authority.apply(reactEvent.isPropagationStopped as () => boolean, event, [])
      && typeof reactEvent.persist === "function"
      && typeof reactEvent.isPersistent === "function"
      && authority.apply(reactEvent.isPersistent as () => boolean, event, []) === true;
  } catch {
    return false;
  }
}

class CreateFormCoordinator {
  readonly #mount: symbol;
  #current: CreateFormPublication | null = null;
  #replay: CreateFormReplay | null = null;
  #claimedPublications = new WeakSet<CreateFormPublication>();
  #claimedActions = new WeakSet<CreateFormAction>();
  #claimedKeyboardPairs = new WeakSet<CreateFormKeyboardPair>();
  #claimedReactEvents = new WeakSet<object>();
  #claimedNativeEvents = new WeakSet<Event>();

  constructor(mount: symbol) {
    this.#mount = mount;
  }

  create(facts: CreateFormFacts): CreateFormPublication {
    const action: CreateFormAction = {
      identity: Symbol("token-create-cancel-action"),
      kind: "cancel",
      claimed: false,
    };
    Object.seal(action);
    const publication: CreateFormPublication = {
      identity: Symbol("token-create-form-publication"),
      facts,
      action,
      button: {
        identity: Symbol("token-create-button-slot"),
        role: "button",
        element: null,
      },
      form: {
        identity: Symbol("token-create-form-slot"),
        role: "form",
        element: null,
      },
      keyboard: null,
      keyboardPair: null,
      dom: null,
      buttonDom: null,
      placement: null,
      history: null,
      established: false,
      retired: false,
      replayed: false,
      claimed: false,
    };
    Object.seal(publication);
    return publication;
  }

  bind<T extends HTMLButtonElement | HTMLFormElement>(
    publication: CreateFormPublication,
    slot: CreateFormSlot<T>,
    element: T | null,
  ) {
    const previous = slot.element;
    if (previous === element) return;
    if (this.#replay && this.#replay.publication !== publication) {
      this.#invalidateReplay(this.#replay);
    }
    let replay = this.#replay;
    if (previous && this.#current === publication && !replay) {
      if (slot.role === "form") replay = this.#beginReplay(publication);
      else this.#retire(publication);
    }
    if (replay?.publication === publication) {
      const expected = slot.role === "button" ? replay.button : replay.form;
      if (element === null) {
        if (
          previous !== expected
          || replay.released.has(slot)
          || replay.rebound.has(slot)
        ) {
          replay.invalid = true;
        } else {
          replay.released.add(slot);
        }
      } else if (
        element !== expected
        || previous !== null
        || !replay.released.has(slot)
        || replay.rebound.has(slot)
      ) {
        replay.invalid = true;
      } else {
        replay.rebound.add(slot);
      }
    }
    slot.element = element;
    if (replay?.invalid) this.#invalidateReplay(replay);
  }

  establish(
    publication: CreateFormPublication,
    factsAreCurrent: () => boolean,
    domIsExact: () => boolean,
  ): (() => void) | undefined {
    if (
      publication.facts.mount !== this.#mount
      || publication.facts.session.authority !== publication.facts.sessionAuthority
    ) return;
    if (publication.retired) {
      const replay = this.#replay;
      const noRefCycle = replay
        && replay.released.size === 0
        && replay.rebound.size === 0;
      const completeRefCycle = replay
        && replay.released.size === 1
        && replay.rebound.size === 1;
      if (
        !replay
        || replay.publication !== publication
        || replay.invalid
        || !replay.layoutReleased
        || publication.replayed
        || publication.claimed
        || (!noRefCycle && !completeRefCycle)
        || publication.button.element !== replay.button
        || publication.form.element !== replay.form
        || !publication.history?.isPristine()
        || !publication.dom
        || !publication.buttonDom
        || !publication.placement
        || !secretNoticeDomMatches(publication.dom)
        || !secretNoticeDomMatches(publication.buttonDom)
        || !secretNoticePlacementMatches(
          replay.form,
          replay.form.ownerDocument,
          publication.placement,
        )
        || !factsAreCurrent()
        || !domIsExact()
      ) {
        if (replay) this.#invalidateReplay(replay);
        return;
      }
      publication.retired = false;
      publication.replayed = true;
      this.#replay = null;
      this.#current = publication;
      return () => this.retire(publication);
    }
    const button = publication.button.element;
    const form = publication.form.element;
    if (
      this.#current === publication
      || !button
      || !form
      || !factsAreCurrent()
      || !domIsExact()
    ) {
      return;
    }
    if (this.#current) this.#retire(this.#current);
    const placement = snapshotSecretNoticePlacement(form);
    const keyboard = captureCreateFormKeyboardAuthority(form, button);
    if (!placement || !keyboard) return;
    const history = new CreateFormMutationHistory(
      keyboard.ownerWindow,
      form,
      button,
      placement,
    );
    publication.keyboard = keyboard;
    publication.dom = snapshotSecretNoticeDom(form);
    publication.buttonDom = snapshotSecretNoticeDom(button);
    publication.placement = placement;
    publication.history = history;
    publication.established = true;
    this.#current = publication;
    if (
      !history.isPristine()
      || !factsAreCurrent()
      || !domIsExact()
      || !secretNoticePlacementMatches(form, form.ownerDocument, placement)
    ) {
      this.#retire(publication);
      return;
    }
    return () => this.retire(publication);
  }

  retire(publication: CreateFormPublication) {
    if (this.#replay?.publication === publication) {
      this.#replay.layoutReleased = true;
      return;
    }
    if (publication.retired) return;
    const replay = this.#beginReplay(publication);
    if (replay) replay.layoutReleased = true;
    else this.#retire(publication);
  }

  retireCurrent() {
    if (this.#current) this.#retire(this.#current);
    if (this.#replay) this.#invalidateReplay(this.#replay);
  }

  publishKeyboardPair(
    publication: CreateFormPublication,
    event: ReactKeyboardEvent<HTMLFormElement>,
    factsAreCurrent: () => boolean,
    domIsExact: () => boolean,
  ) {
    const authority = publication.keyboard;
    const nativeEvent = event.nativeEvent;
    if (
      !authority
      || this.#current !== publication
      || publication.retired
      || publication.claimed
      || publication.action.claimed
      || publication.keyboardPair
      || this.#claimedPublications.has(publication)
      || this.#claimedActions.has(publication.action)
      || this.#claimedReactEvents.has(event)
      || this.#claimedNativeEvents.has(nativeEvent)
      || !factsAreCurrent()
      || !this.#publicationIsCurrent(publication, domIsExact)
    ) {
      return;
    }
    const capture = captureCreateFormEscape(
      authority,
      nativeEvent,
      authority.Event.CAPTURING_PHASE,
    );
    if (
      !capture
      || !exactCreateFormReactEvent(event, authority, capture)
      || !createFormEscapeMatches(authority, capture)
      || !factsAreCurrent()
      || !this.#publicationIsCurrent(publication, domIsExact)
    ) {
      return;
    }
    const pair: CreateFormKeyboardPair = {
      identity: Symbol("token-create-keyboard-pair"),
      publication,
      action: publication.action,
      captureReactEvent: event,
      nativeEvent,
      capture,
      bubbleReactEvent: null,
      claimed: false,
    };
    Object.seal(pair);
    publication.keyboardPair = pair;
    queueMicrotask(() => {
      if (publication.keyboardPair === pair && !pair.claimed) {
        publication.keyboardPair = null;
      }
    });
  }

  claim(
    publication: CreateFormPublication,
    event: ReactKeyboardEvent<HTMLFormElement>,
    factsAreCurrent: () => boolean,
    domIsExact: () => boolean,
  ): Readonly<{
    authority: CreateFormKeyboardAuthority;
    native: CreateFormKeyboardSnapshot;
    pair: CreateFormKeyboardPair;
  }> | null {
    const authority = publication.keyboard;
    const pair = publication.keyboardPair;
    const nativeEvent = event.nativeEvent;
    if (
      !authority
      || !pair
      || pair.publication !== publication
      || pair.action !== publication.action
      || pair.captureReactEvent === event
      || pair.bubbleReactEvent !== null
      || pair.nativeEvent !== nativeEvent
      || pair.capture.event !== nativeEvent
      || pair.capture.phase !== authority.Event.CAPTURING_PHASE
      || pair.claimed
      || this.#current !== publication
      || publication.retired
      || publication.claimed
      || publication.action.claimed
      || this.#claimedPublications.has(publication)
      || this.#claimedActions.has(publication.action)
      || this.#claimedKeyboardPairs.has(pair)
      || this.#claimedReactEvents.has(event)
      || this.#claimedNativeEvents.has(nativeEvent)
      || !factsAreCurrent()
      || !this.#publicationIsCurrent(publication, domIsExact)
    ) {
      return null;
    }
    const native = captureCreateFormEscape(
      authority,
      nativeEvent,
      authority.Event.BUBBLING_PHASE,
    );
    if (
      !native
      || !exactCreateFormReactEvent(event, authority, native)
      || native.target !== pair.capture.target
      || native.currentTarget !== pair.capture.currentTarget
      || native.view !== pair.capture.view
      || native.path.length !== pair.capture.path.length
      || !native.path.every((entry, index) => entry === pair.capture.path[index])
      || !createFormEscapeMatches(authority, native)
      || !factsAreCurrent()
      || !this.#publicationIsCurrent(publication, domIsExact)
    ) {
      return null;
    }
    pair.bubbleReactEvent = event;
    publication.claimed = true;
    publication.action.claimed = true;
    pair.claimed = true;
    this.#claimedPublications.add(publication);
    this.#claimedActions.add(publication.action);
    this.#claimedKeyboardPairs.add(pair);
    this.#claimedReactEvents.add(pair.captureReactEvent);
    this.#claimedReactEvents.add(event);
    this.#claimedNativeEvents.add(nativeEvent);
    return Object.freeze({ authority, native, pair });
  }

  claimedIsCurrent(
    publication: CreateFormPublication,
    native: CreateFormKeyboardSnapshot,
    pair: CreateFormKeyboardPair,
    factsAreCurrent: () => boolean,
    domIsExact: () => boolean,
  ) {
    return this.#current === publication
      && publication.claimed
      && publication.action.claimed
      && publication.keyboardPair === pair
      && pair.publication === publication
      && pair.action === publication.action
      && pair.bubbleReactEvent !== null
      && pair.claimed
      && this.#claimedPublications.has(publication)
      && this.#claimedActions.has(publication.action)
      && this.#claimedKeyboardPairs.has(pair)
      && this.#claimedReactEvents.has(pair.captureReactEvent)
      && this.#claimedReactEvents.has(pair.bubbleReactEvent)
      && this.#claimedNativeEvents.has(native.event)
      && factsAreCurrent()
      && this.#publicationIsCurrent(publication, domIsExact);
  }

  ownsClaim(publication: CreateFormPublication) {
    const pair = publication.keyboardPair;
    return publication.claimed
      && publication.action.claimed
      && !!pair
      && pair.publication === publication
      && pair.action === publication.action
      && pair.bubbleReactEvent !== null
      && pair.claimed
      && this.#claimedPublications.has(publication)
      && this.#claimedActions.has(publication.action)
      && this.#claimedKeyboardPairs.has(pair)
      && this.#claimedReactEvents.has(pair.captureReactEvent)
      && this.#claimedReactEvents.has(pair.bubbleReactEvent)
      && this.#claimedNativeEvents.has(pair.nativeEvent);
  }

  #publicationIsCurrent(
    publication: CreateFormPublication,
    domIsExact: () => boolean,
  ) {
    const button = publication.button.element;
    const form = publication.form.element;
    return this.#current === publication
      && publication.established
      && !publication.retired
      && publication.facts.session.authority === publication.facts.sessionAuthority
      && publication.facts.mount === this.#mount
      && publication.keyboard !== null
      && publication.keyboard.isCurrent()
      && publication.history?.isPristine() === true
      && !!publication.dom
      && !!publication.buttonDom
      && !!publication.placement
      && !!button
      && !!form
      && publication.keyboard.form === form
      && publication.keyboard.button === button
      && secretNoticeDomMatches(publication.dom)
      && secretNoticeDomMatches(publication.buttonDom)
      && secretNoticePlacementMatches(form, form.ownerDocument, publication.placement)
      && domIsExact();
  }

  #beginReplay(publication: CreateFormPublication): CreateFormReplay | null {
    if (this.#replay?.publication === publication) return this.#replay;
    const button = publication.button.element;
    const form = publication.form.element;
    if (
      this.#replay
      || this.#current !== publication
      || publication.retired
      || publication.claimed
      || publication.replayed
      || !button
      || !form
      || !publication.history?.isPristine()
    ) {
      return null;
    }
    const replay: CreateFormReplay = {
      publication,
      button,
      form,
      released: new Set(),
      rebound: new Set(),
      layoutReleased: false,
      invalid: false,
    };
    publication.retired = true;
    this.#current = null;
    this.#replay = replay;
    queueMicrotask(() => {
      if (this.#replay === replay) this.#invalidateReplay(replay);
    });
    return replay;
  }

  #invalidateReplay(replay: CreateFormReplay) {
    replay.invalid = true;
    if (this.#replay === replay) this.#replay = null;
    this.#retire(replay.publication);
  }

  #retire(publication: CreateFormPublication) {
    publication.retired = true;
    if (this.#current === publication) this.#current = null;
    if (!publication.keyboardPair?.claimed) publication.keyboardPair = null;
    publication.history?.disconnect();
  }
}

function exactSecretEventPath(
  nativeEvent: MouseEvent,
  target: Node,
  publication: SecretNoticePublication,
): boolean {
  const expected: EventTarget[] = [];
  let node: Node | null = target;
  while (node) {
    expected.push(node);
    if (node === publication.ownerDocument) break;
    node = node.parentNode;
  }
  const ownerWindow = publication.ownerDocument.defaultView;
  if (expected.at(-1) !== publication.ownerDocument || !ownerWindow) return false;
  const actual = nativeEvent.composedPath();
  const pathWindow = actual.at(-1);
  return actual.length === expected.length + 1
    && expected.every((entry, index) => actual[index] === entry)
    && typeof pathWindow === "object"
    && pathWindow !== null
    && "document" in pathWindow
    && pathWindow.document === publication.ownerDocument;
}

function setSecretNoticeElement(
  generation: SecretNoticeGeneration,
  role: SecretNoticeRole,
  element: HTMLElement | null,
) {
  if (role === "notice") generation.elements.notice = element as HTMLDivElement | null;
  else if (role === "code") generation.elements.code = element;
  else if (role === "copy") generation.elements.copy = element as HTMLButtonElement | null;
  else generation.elements.hide = element as HTMLButtonElement | null;
}

class SecretNoticeCoordinator {
  readonly #mount: symbol;
  #current: SecretNoticePublication | null = null;
  #replay: SecretNoticeReplay | null = null;
  #elementOwners = new WeakMap<HTMLElement, SecretNoticeBinding>();
  #codeOwner: SecretNoticeCodeOwner | null = null;
  #publishedGenerations = new WeakSet<SecretNoticeGeneration>();
  #replayedGenerations = new WeakSet<SecretNoticeGeneration>();
  #claimedReactEvents = new WeakSet<object>();
  #claimedNativeEvents = new WeakSet<Event>();

  constructor(mount: symbol) {
    this.#mount = mount;
  }

  createDraft(render: SecretNoticeRender): SecretNoticeDraft {
    const actions = Object.freeze({
      copy: { identity: Symbol("token-secret-copy-action"), kind: "copy" as const, claimed: false },
      hide: { identity: Symbol("token-secret-hide-action"), kind: "hide" as const, claimed: false },
    });
    const generation: SecretNoticeGeneration = {
      identity: Symbol("token-secret-generation"),
      render,
      elements: { notice: null, code: null, copy: null, hide: null },
      bindings: { notice: null, code: null, copy: null, hide: null },
      actions,
      authority: null,
      target: null,
    };
    const draft: SecretNoticeDraft = {
      identity: Symbol("token-secret-draft"),
      render,
      generation,
      committed: false,
      retired: false,
    };
    generation.authority = draft;
    return draft;
  }

  bindNotice(draft: SecretNoticeDraft, element: HTMLDivElement | null) {
    return this.#bind(draft.generation, "notice", element);
  }

  bindCode(
    draft: SecretNoticeDraft,
    target: RefObject<HTMLElement | null>,
    element: HTMLElement | null,
  ) {
    const generation = draft.generation;
    if (generation.target && generation.target !== target) {
      this.#retireAuthority(generation);
      return;
    }
    generation.target = target;
    return this.#bind(generation, "code", element, target);
  }

  bindCopy(draft: SecretNoticeDraft, element: HTMLButtonElement | null) {
    return this.#bind(draft.generation, "copy", element);
  }

  bindHide(draft: SecretNoticeDraft, element: HTMLButtonElement | null) {
    return this.#bind(draft.generation, "hide", element);
  }

  establish(initialDraft: SecretNoticeDraft, target: RefObject<HTMLElement | null>) {
    if (initialDraft.retired) {
      const successor = this.#replaySuccessor(initialDraft, target);
      return successor ? () => this.retire(successor) : undefined;
    }
    const { generation } = initialDraft;
    if (
      generation.authority !== initialDraft
      || generation.target !== target
      || this.#publishedGenerations.has(generation)
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

  retire(publication: SecretNoticePublication) {
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

  activate(
    generation: SecretNoticeGeneration,
    action: SecretNoticeAction,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) {
    const publication = this.#current;
    const expectedAction = publication?.actions[action.kind];
    const control = action.kind === "copy" ? publication?.copy : publication?.hide;
    const targets = action.kind === "copy" ? publication?.copyTargets : publication?.hideTargets;
    const nativeEvent = event?.nativeEvent;
    const target = event?.target;
    const ownerWindow = publication?.ownerDocument.defaultView;
    const reactEvent = event as ReactMouseEvent<HTMLButtonElement> & {
      _reactName?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
      persist?: unknown;
    };
    if (
      !publication
      || publication.generation !== generation
      || publication.draft !== generation.authority
      || publication.retired
      || publication.draft.retired
      || publication.claimed
      || expectedAction !== action
      || generation.actions[action.kind] !== action
      || action.claimed
      || !control
      || !targets
      || !ownerWindow
      || !event
      || typeof event !== "object"
      || event.type !== "click"
      || event.button !== 0
      || !(nativeEvent instanceof ownerWindow.MouseEvent)
      || nativeEvent.type !== "click"
      || nativeEvent.button !== 0
      || nativeEvent.eventPhase === ownerWindow.Event.NONE
      || !nativeEvent.bubbles
      || !nativeEvent.cancelable
      || nativeEvent.defaultPrevented
      || event.bubbles !== nativeEvent.bubbles
      || event.cancelable !== nativeEvent.cancelable
      || event.eventPhase !== nativeEvent.eventPhase
      || event.defaultPrevented
      || reactEvent._reactName !== "onClick"
      || typeof reactEvent.isDefaultPrevented !== "function"
      || reactEvent.isDefaultPrevented()
      || typeof reactEvent.isPropagationStopped !== "function"
      || reactEvent.isPropagationStopped()
      || typeof reactEvent.persist !== "function"
      || event.currentTarget !== control
      || nativeEvent.target !== target
      || !(target instanceof ownerWindow.Node)
      || target.ownerDocument !== publication.ownerDocument
      || !control.contains(target)
      || !targets.includes(target)
      || !secretNoticeDomContains(publication.dom, target)
      || !exactSecretEventPath(nativeEvent, target, publication)
      || this.#claimedReactEvents.has(event)
      || this.#claimedNativeEvents.has(nativeEvent)
      || !publication.render.owns(
        publication.render.visit,
        publication.render.publication,
        publication.render.buttonControl,
      )
      || !this.#publicationIsCurrent(publication)
    ) {
      return;
    }

    publication.claimed = true;
    action.claimed = true;
    this.#claimedReactEvents.add(event);
    this.#claimedNativeEvents.add(nativeEvent);
    if (action.kind === "copy") {
      publication.render.copy();
    } else {
      publication.render.dismiss(
        publication.render.visit,
        publication.render.publication,
        publication.render.buttonControl,
      );
    }
  }

  #bind(
    generation: SecretNoticeGeneration,
    role: SecretNoticeRole,
    element: HTMLElement | null,
    target?: RefObject<HTMLElement | null>,
  ): (() => void) | undefined {
    const previous = generation.bindings[role];
    if (element === null) {
      if (previous) this.#release(previous, "null");
      return;
    }
    if (previous?.active && previous.element === element) return;
    if (
      previous?.active
      && (!element.isConnected || element.ownerDocument !== previous.element.ownerDocument)
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
        replay.invalid
        || !replay.released.has(role)
        || replay.rebound.has(role)
        || expected.element !== element
      ) {
        this.#invalidateReplay(replay);
        return;
      }
    }

    const displaced = this.#elementOwners.get(element);
    if (displaced) {
      if (
        displaced.generation !== generation
        && this.#current?.generation === displaced.generation
        && generation.authority?.retired
      ) {
        return;
      }
      this.#release(displaced, "replace");
      if (!this.#canBind(generation)) return;
    }

    const binding: SecretNoticeBinding = {
      identity: Symbol(`token-secret-${role}-binding`),
      generation,
      role,
      element,
      active: true,
    };
    generation.bindings[role] = binding;
    setSecretNoticeElement(generation, role, element);
    this.#elementOwners.set(element, binding);
    if (role === "code" && target) {
      this.#codeOwner = { binding, target };
      target.current = element;
    }
    if (replay?.generation === generation) replay.rebound.set(role, binding);
    return () => this.#release(binding, "cleanup");
  }

  #release(
    binding: SecretNoticeBinding,
    source: "cleanup" | "null" | "replace",
  ) {
    if (!binding.active) return;
    const publication = this.#current;
    const startsReplay =
      publication?.generation === binding.generation
      && publication.bindings[binding.role] === binding
        ? this.#beginReplay(publication)
        : null;
    const replay = this.#replay;

    binding.active = false;
    const { generation, role, element } = binding;
    if (generation.bindings[role] === binding) {
      generation.bindings[role] = null;
      setSecretNoticeElement(generation, role, null);
    }
    if (this.#elementOwners.get(element) === binding) this.#elementOwners.delete(element);
    if (role === "code" && this.#codeOwner?.binding === binding) {
      const { target } = this.#codeOwner;
      this.#codeOwner = null;
      if (target.current === element) target.current = null;
    }

    if (replay?.generation === generation) {
      if (
        source !== "cleanup"
        || replay.expected[role] !== binding
        || replay.released.has(role)
        || replay.rebound.has(role)
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

  #canBind(generation: SecretNoticeGeneration): boolean {
    const authority = generation.authority;
    return Boolean(
      authority
      && (
        !authority.retired
        || this.#current?.generation === generation
        || (this.#replay?.generation === generation && !this.#replay.invalid)
      ),
    );
  }

  #beginReplay(publication: SecretNoticePublication): SecretNoticeReplay | null {
    if (this.#replay?.publication === publication) return this.#replay;
    if (
      this.#replay
      || publication.retired
      || publication.claimed
      || this.#current !== publication
      || this.#replayedGenerations.has(publication.generation)
      || !this.#publicationIsCurrent(publication)
    ) {
      return null;
    }
    const replay: SecretNoticeReplay = {
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

  #replaySuccessor(
    initialDraft: SecretNoticeDraft,
    target: RefObject<HTMLElement | null>,
  ): SecretNoticePublication | null {
    const replay = this.#replay;
    const { generation } = initialDraft;
    if (
      !replay
      || replay.publication.draft !== initialDraft
      || replay.generation !== generation
      || generation.authority !== initialDraft
      || generation.target !== target
      || !initialDraft.committed
      || !initialDraft.retired
      || !replay.publication.retired
      || replay.invalid
      || !replay.layoutRetired
      || this.#current
      || this.#replayedGenerations.has(generation)
      || replay.released.size !== SECRET_NOTICE_ROLES.length
      || replay.rebound.size !== SECRET_NOTICE_ROLES.length
      || SECRET_NOTICE_ROLES.some((role) => {
        const expected = replay.expected[role];
        const rebound = replay.rebound.get(role);
        return (
          !rebound
          || rebound.element !== expected.element
          || generation.bindings[role] !== rebound
          || !this.#ownsBinding(rebound)
        );
      })
      || !this.#renderIsCurrent(initialDraft.render)
      || !this.#mutationFree(replay.publication)
      || !this.#hierarchyIsCurrent(
        generation,
        initialDraft.render,
        target,
        replay.publication.dom,
        replay.publication.placement,
      )
    ) {
      if (replay) this.#invalidateReplay(replay);
      return null;
    }

    const successor: SecretNoticeDraft = {
      identity: Symbol("token-secret-successor-draft"),
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
    );
    this.#replay = null;
    this.#disconnect(replay.publication);
    if (!publication || !this.#publish(publication)) {
      this.#retireDraft(successor);
      return null;
    }
    return publication;
  }

  #createPublication(
    draft: SecretNoticeDraft,
    target: RefObject<HTMLElement | null>,
    expectedDom?: SecretNoticeDomSnapshot,
    expectedPlacement?: readonly SecretNoticePlacement[],
  ): SecretNoticePublication | null {
    const { generation, render } = draft;
    const { notice, code, copy, hide } = generation.elements;
    const noticeBinding = generation.bindings.notice;
    const codeBinding = generation.bindings.code;
    const copyBinding = generation.bindings.copy;
    const hideBinding = generation.bindings.hide;
    if (
      !notice
      || !code
      || !copy
      || !hide
      || !noticeBinding
      || !codeBinding
      || !copyBinding
      || !hideBinding
      || !this.#hierarchyIsCurrent(
        generation,
        render,
        target,
        expectedDom,
        expectedPlacement,
      )
    ) {
      return null;
    }
    const placement = expectedPlacement ?? snapshotSecretNoticePlacement(notice);
    if (!placement) return null;
    return {
      identity: Symbol("token-secret-publication"),
      render,
      draft,
      generation,
      notice,
      code,
      copy,
      hide,
      bindings: Object.freeze({
        notice: noticeBinding,
        code: codeBinding,
        copy: copyBinding,
        hide: hideBinding,
      }),
      actions: generation.actions,
      target,
      ownerDocument: notice.ownerDocument,
      dom: expectedDom ?? snapshotSecretNoticeDom(notice),
      placement,
      copyTargets: secretNoticeNodes(copy),
      hideTargets: secretNoticeNodes(hide),
      retired: false,
      claimed: false,
      mutated: false,
      observer: null,
    };
  }

  #publish(publication: SecretNoticePublication): boolean {
    if (
      this.#current
      || publication.retired
      || publication.draft.retired
      || publication.generation.authority !== publication.draft
    ) {
      return false;
    }
    publication.draft.committed = true;
    this.#current = publication;
    if (SecretNoticeMutationObserver) {
      const observer = new SecretNoticeMutationObserver(() => {
        publication.mutated = true;
      });
      observer.observe(publication.notice, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      const observed = new Set<Node>([publication.notice]);
      for (const entry of publication.placement) {
        if (entry.parent && !observed.has(entry.parent)) {
          observer.observe(entry.parent, { childList: true });
          observed.add(entry.parent);
        }
      }
      publication.observer = observer;
    }
    return true;
  }

  #retirePublication(publication: SecretNoticePublication, preserveObserver: boolean) {
    if (!publication.retired) {
      publication.retired = true;
      publication.draft.retired = true;
    }
    if (this.#current === publication) this.#current = null;
    if (!preserveObserver) this.#disconnect(publication);
  }

  #retireDraft(draft: SecretNoticeDraft) {
    draft.retired = true;
    if (this.#current?.draft === draft) this.#retirePublication(this.#current, false);
  }

  #retireAuthority(generation: SecretNoticeGeneration) {
    const authority = generation.authority;
    if (authority) this.#retireDraft(authority);
    if (this.#replay?.generation === generation) this.#invalidateReplay(this.#replay);
  }

  #invalidateReplay(replay: SecretNoticeReplay) {
    if (this.#replay === replay) this.#replay = null;
    replay.invalid = true;
    this.#disconnect(replay.publication);
  }

  #disconnect(publication: SecretNoticePublication) {
    publication.observer?.disconnect();
    publication.observer = null;
  }

  #mutationFree(publication: SecretNoticePublication): boolean {
    if (publication.mutated) return false;
    if ((publication.observer?.takeRecords().length ?? 0) > 0) {
      publication.mutated = true;
      return false;
    }
    return true;
  }

  #ownsBinding(binding: SecretNoticeBinding): boolean {
    return binding.active
      && binding.generation.bindings[binding.role] === binding
      && this.#elementOwners.get(binding.element) === binding;
  }

  #renderIsCurrent(render: SecretNoticeRender): boolean {
    const setup = render.copySetup;
    const { visit, session, publication, created } = render;
    return (
      render.mount === this.#mount
      && render.visitIdentity === visit.identity
      && render.visitSequence === visit.sequence
      && render.session === visit.session
      && render.sessionAuthority === session.authority
      && session === visit.session
      && render.origin === session.origin
      && render.userLogin === session.userLogin
      && render.documentId === session.documentId
      && render.embedded === visit.embedded
      && render.next === visit.next
      && render.onClose === visit.onClose
      && render.publicationIdentity === publication.identity
      && render.publicationSequence === publication.sequence
      && publication.session === session
      && publication.value === created
      && !publication.retired
      && Object.isFrozen(created)
      && (created.documentIds === null || Object.isFrozen(created.documentIds))
      && createdSecretValuesMatch(created, publication.value)
      && render.buttonControl.visit === visit
      && setup.copy === render.copy
      && setup.status === render.status
      && setup.label === render.label
      && setup.copied === render.copied
      && render.copied === (render.status === "copied")
      && render.label === (
        render.status === "copied"
          ? "Copied"
          : render.status === "fallback"
            ? COPY_FALLBACK_HINT
            : "Copy"
      )
      && render.headline === `Token “${created.name}” created. Copy it now; it will not be shown again.`
      && render.access === (
        created.documentIds
          ? `${created.documentIds.length} document(s)`
          : "All documents you can access"
      )
    );
  }

  #hierarchyIsCurrent(
    generation: SecretNoticeGeneration,
    render: SecretNoticeRender,
    target: RefObject<HTMLElement | null>,
    expectedDom?: SecretNoticeDomSnapshot,
    expectedPlacement?: readonly SecretNoticePlacement[],
  ): boolean {
    const { notice, code, copy, hide } = generation.elements;
    const noticeBinding = generation.bindings.notice;
    const codeBinding = generation.bindings.code;
    const copyBinding = generation.bindings.copy;
    const hideBinding = generation.bindings.hide;
    if (
      !notice
      || !code
      || !copy
      || !hide
      || !noticeBinding
      || !codeBinding
      || !copyBinding
      || !hideBinding
      || new Set([notice, code, copy, hide]).size !== 4
      || noticeBinding.element !== notice
      || codeBinding.element !== code
      || copyBinding.element !== copy
      || hideBinding.element !== hide
      || !this.#ownsBinding(noticeBinding)
      || !this.#ownsBinding(codeBinding)
      || !this.#ownsBinding(copyBinding)
      || !this.#ownsBinding(hideBinding)
      || generation.render !== render
      || generation.target !== target
      || this.#codeOwner?.binding !== codeBinding
      || this.#codeOwner.target !== target
      || target.current !== code
      || !this.#renderIsCurrent(render)
    ) {
      return false;
    }

    const ownerDocument = notice.ownerDocument;
    const headline = notice.children.item(0);
    const guidance = notice.children.item(1);
    const access = notice.children.item(2);
    const scope = access?.firstElementChild;
    const controls = notice.children.item(4);
    const copyIcon = copy.firstElementChild;
    if (
      !notice.isConnected
      || !code.isConnected
      || !copy.isConnected
      || !hide.isConnected
      || code.ownerDocument !== ownerDocument
      || copy.ownerDocument !== ownerDocument
      || hide.ownerDocument !== ownerDocument
      || notice.className !== SECRET_NOTICE_CLASS
      || notice.getAttribute("role") !== "status"
      || notice.getAttribute("aria-live") !== "polite"
      || notice.getAttribute("aria-atomic") !== "true"
      || notice.dataset.testid !== "token-created"
      || notice.children.length !== 5
      || notice.childNodes.length !== 5
      || headline?.tagName !== "P"
      || headline.className !== "text-sm font-medium text-green-900 dark:text-green-200"
      || headline.children.length !== 0
      || headline.textContent !== render.headline
      || guidance?.tagName !== "P"
      || guidance.className !== "mt-1 text-xs text-ink-2"
      || guidance.children.length !== 0
      || guidance.textContent !== SECRET_GUIDANCE
      || access?.tagName !== "P"
      || access.className !== "mt-1 text-xs text-ink-2"
      || access.children.length !== 1
      || scope?.tagName !== "SPAN"
      || scope.className !== "inline-flex rounded-full border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-ink-2"
      || scope.getAttribute("title") !== `${TOKEN_SCOPE_LABEL[render.created.scope]}: ${TOKEN_SCOPE_SUMMARY[render.created.scope]}`
      || scope.getAttribute("data-testid") !== "token-scope-chip"
      || scope.getAttribute("data-scope") !== render.created.scope
      || scope.textContent !== render.created.scope
      || access.textContent !== `${render.created.scope} ${render.access}`
      || notice.children.item(3) !== code
      || code.parentElement !== notice
      || code.tagName !== "CODE"
      || code.className !== SECRET_CODE_CLASS
      || code.dataset.testid !== "copy-token"
      || code.children.length !== 0
      || code.textContent !== render.created.token
      || controls?.tagName !== "DIV"
      || controls.className !== "mt-2 flex flex-wrap gap-2"
      || controls.children.length !== 2
      || controls.childNodes.length !== 2
      || controls.firstElementChild !== copy
      || controls.lastElementChild !== hide
      || copy.parentElement !== controls
      || copy.nextElementSibling !== hide
      || copy.className !== SECRET_COPY_CLASS
      || copy.dataset.testid !== "copy-token-button"
      || copy.getAttribute("type") !== "button"
      || copy.type !== "button"
      || copy.disabled
      || copy.matches(":disabled")
      || copy.getAttribute("aria-label") !== SECRET_COPY_LABEL
      || copy.textContent !== render.label
      || copy.children.length !== 1
      || copy.childNodes.length !== 2
      || !copyIcon
      || copyIcon.tagName.toLowerCase() !== "svg"
      || !copyIcon.classList.contains(render.copied ? "lucide-check" : "lucide-copy")
      || copyIcon.getAttribute("width") !== "14"
      || copyIcon.getAttribute("height") !== "14"
      || copyIcon.getAttribute("aria-hidden") !== "true"
      || hide.parentElement !== controls
      || hide.className !== SECRET_HIDE_CLASS
      || hide.getAttribute("type") !== "button"
      || hide.type !== "button"
      || hide.disabled
      || hide.matches(":disabled")
      || hide.getAttribute("aria-label") !== null
      || hide.children.length !== 0
      || hide.childNodes.length !== 1
      || hide.textContent !== SECRET_HIDE_LABEL
      || (expectedDom && (expectedDom.node !== notice || !secretNoticeDomMatches(expectedDom)))
      || (expectedPlacement && !secretNoticePlacementMatches(notice, ownerDocument, expectedPlacement))
    ) {
      return false;
    }
    return true;
  }

  #publicationIsCurrent(publication: SecretNoticePublication): boolean {
    return (
      this.#current === publication
      && !publication.retired
      && !publication.draft.retired
      && publication.generation.authority === publication.draft
      && publication.bindings.notice === publication.generation.bindings.notice
      && publication.bindings.code === publication.generation.bindings.code
      && publication.bindings.copy === publication.generation.bindings.copy
      && publication.bindings.hide === publication.generation.bindings.hide
      && publication.actions === publication.generation.actions
      && this.#mutationFree(publication)
      && secretNoticePlacementMatches(
        publication.notice,
        publication.ownerDocument,
        publication.placement,
      )
      && this.#hierarchyIsCurrent(
        publication.generation,
        publication.render,
        publication.target,
        publication.dom,
        publication.placement,
      )
    );
  }
}

function SecretNotice({
  visit,
  publication,
  buttonControl,
  owns,
  dismiss,
}: {
  visit: ManagerControlVisit;
  publication: CreatedSecretPublication;
  buttonControl: TokensButtonControl;
  owns: SecretNoticeOwner;
  dismiss: SecretNoticeDismiss;
}) {
  const created = publication.value;
  const code = useRef<HTMLElement>(null);
  const copyResult = useCopy(created.token, code);
  const copySetup = Object.freeze({
    copy: copyResult.copy,
    status: copyResult.status,
    label: copyResult.label,
    copied: copyResult.copied,
  });
  const { copy, status, label, copied } = copySetup;
  const [mount] = useState(() => Symbol("token-secret-notice"));
  const [coordinator] = useState(() => new SecretNoticeCoordinator(mount));
  const render: SecretNoticeRender = Object.freeze({
    identity: Symbol("token-secret-render"),
    mount,
    visit,
    visitIdentity: visit.identity,
    visitSequence: visit.sequence,
    session: visit.session,
    sessionAuthority: visit.session.authority,
    origin: visit.session.origin,
    userLogin: visit.session.userLogin,
    documentId: visit.session.documentId,
    embedded: visit.embedded,
    next: visit.next,
    onClose: visit.onClose,
    publication,
    publicationIdentity: publication.identity,
    publicationSequence: publication.sequence,
    created,
    buttonControl,
    owns,
    dismiss,
    copySetup,
    copy,
    status,
    label,
    copied,
    headline: `Token “${created.name}” created. Copy it now; it will not be shown again.`,
    access: created.documentIds
      ? `${created.documentIds.length} document(s)`
      : "All documents you can access",
  });
  const draft = coordinator.createDraft(render);

  useLayoutEffect(() => coordinator.establish(draft, code), [coordinator, draft, code]);

  return (
    <div ref={(element) => coordinator.bindNotice(draft, element)} className={SECRET_NOTICE_CLASS}
      role="status" aria-live="polite" aria-atomic="true" data-testid="token-created">
      <p className="text-sm font-medium text-green-900 dark:text-green-200">{render.headline}</p>
      <p className="mt-1 text-xs text-ink-2">{SECRET_GUIDANCE}</p>
      <p className="mt-1 text-xs text-ink-2"><ScopeChip scope={created.scope} /> {render.access}</p>
      <code ref={(element) => coordinator.bindCode(draft, code, element)}
        className={SECRET_CODE_CLASS} data-testid="copy-token">{created.token}</code>
      <div className="mt-2 flex flex-wrap gap-2">
        <button ref={(element) => coordinator.bindCopy(draft, element)}
          type="button" className={SECRET_COPY_CLASS}
          onClick={(event) => coordinator.activate(draft.generation, draft.generation.actions.copy, event)}
          aria-label={SECRET_COPY_LABEL} data-testid="copy-token-button">
          {copied ? <Check size={14} /> : <Copy size={14} />}{label}
        </button>
        <button ref={(element) => coordinator.bindHide(draft, element)}
          type="button" className={SECRET_HIDE_CLASS}
          onClick={(event) => coordinator.activate(draft.generation, draft.generation.actions.hide, event)}>
          {SECRET_HIDE_LABEL}
        </button>
      </div>
    </div>
  );
}

interface TokenRenameLayoutCycle {
  readonly setup: () => void;
  readonly cleanup: () => void;
}

function CreateFormLayoutBoundary({
  cycle,
}: {
  cycle: CreateFormLayoutCycle;
}) {
  useLayoutEffect(() => {
    cycle.setup();
    return cycle.cleanup;
  }, [cycle]);
  return null;
}

function TokenRenameLayoutBoundary({
  cycle,
}: {
  cycle: TokenRenameLayoutCycle;
}) {
  const [mountCycle] = useState(() => cycle);
  useLayoutEffect(() => {
    mountCycle.setup();
    return mountCycle.cleanup;
  }, [mountCycle]);
  return null;
}

/** Closing a host dialog unmounts all transient state, including late creation responses. */
export function TokensPanel({ open = true, ...props }: TokensPanelProps) {
  const managerKey = JSON.stringify([props.origin, props.userLogin, props.documentId ?? null]);
  return open ? <TokenManager key={managerKey} {...props} /> : null;
}

function TokenManager({ origin, userLogin, next, documentId, embedded, onClose }: Omit<TokensPanelProps, "open">) {
  const [tokens, setTokens] = useState<ApiTokenDto[] | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; permission: boolean } | null>(null);
  const [destination, setDestination] = useState<"tokens" | "connect">("tokens");
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("GitHub Copilot CLI");
  const [expires, setExpires] = useState("90");
  const [scope, setScope] = useState<TokenScopeName>("comment");
  const [restrict, setRestrict] = useState(Boolean(documentId));
  const [documentIds, setDocumentIds] = useState<string[]>(documentId ? [documentId] : []);
  const [documents, setDocuments] = useState<DocumentSummaryDto[] | null>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [documentPending, setDocumentPending] = useState<DocumentListOperation | null>(null);
  const [createPending, setCreatePending] = useState<CreateOperation | null>(null);
  const [pendingActions, setPendingActions] = useState<Record<string, TokenOperation>>({});
  const [error, setError] = useState<string | null>(null);
  const [conflictName, setConflictName] = useState<string | null>(null);
  const [switchErrors, setSwitchErrors] = useState<Record<string, string>>({});
  const [createdPublication, setCreatedPublication] = useState<CreatedSecretPublication | null>(null);
  const created = createdPublication?.value ?? null;
  const liveOrigin = useOrigin(origin);
  const id = useId();
  const documentMount = useRef(Symbol("token-manager-documents")).current;
  const documentMountActive = useRef(true);
  const documentVisitSeq = useRef(0);
  const documentRequestSeq = useRef(0);
  const documentVisit = useRef<number | null>(null);
  const documentOwner = useRef<DocumentListOperation | null>(null);
  const documentRequest = useRef<DocumentListRequest | null>(null);
  const activeDocumentCallback = useRef<BeginDocumentRequest | null>(null);
  const activeDocumentCommit = useRef<DocumentChooserCommit | null>(null);
  const committedDocumentCandidates = useRef(new WeakSet<DocumentChooserCandidate>());
  const detachedDocumentCandidates = useRef(new WeakSet<DocumentChooserCandidate>());
  const repairRequestedDocumentCandidates = useRef(new WeakSet<DocumentChooserCandidate>());
  const claimedDocumentEvents = useRef(new WeakSet<object>());
  const consumedDocumentCommits = useRef(new WeakSet<DocumentChooserCommit>());
  const [, setDocumentPresentationRevision] = useState(0);
  const managerSession = useRef<ManagerSession>(Object.freeze({
    authority: Symbol("token-manager-session"),
    origin,
    userLogin,
    documentId,
  })).current;
  const tokenPanelAuthority = useRef<TokenPanelAuthority>(Object.freeze({
    identity: Symbol("token-panel-authority"),
    session: managerSession,
    update: api.tokens.update,
  })).current;
  const activeManagerSession = useRef<ManagerSession | null>(null);
  const controlVisitSequence = useRef(0);
  const controlVisit = useMemo<ManagerControlVisit>(() => ({
    identity: Symbol("token-manager-control-visit"),
    sequence: ++controlVisitSequence.current,
    session: managerSession,
    embedded,
    next,
    onClose,
    hashListener: null,
  }), [embedded, managerSession, next, onClose]);
  const activeControlVisit = useRef<ManagerControlVisit | null>(null);
  const tokensButtonOwner = useRef<TokensButtonControl | null>(null);
  const tokensButtonControl = useMemo<TokensButtonControl>(() => ({
    visit: controlVisit,
    element: null,
  }), [controlVisit]);
  const createFormMount = useRef(Symbol("token-create-form")).current;
  const [createFormCoordinator] = useState(() => new CreateFormCoordinator(createFormMount));
  const createButtonOwner = useRef<CreateFormButtonControl | null>(null);
  const createButtonControl = useMemo<CreateFormButtonControl>(() => ({
    visit: controlVisit,
    element: null,
  }), [controlVisit]);
  const createFocusIntent = useRef<CreateFormFocusIntent | null>(null);
  const createOwner = useRef<CreateOperation | null>(null);
  const tokenOwners = useRef(new Map<string, TokenOperation>());
  const latestTokenOperations = useRef(new Map<string, TokenOperation>());
  const createdRef = useRef<CreatedSecretPublication | null>(null);
  const createdPublicationSequence = useRef(0);
  const loadSeq = useRef(0);
  const pendingFlips = useRef(new Map<string, { value: boolean; owner: TokenOperation }>());
  const updatedRows = useRef(new Map<string, ApiTokenDto>());
  const busy = createPending !== null;
  const secretWorkPending = busy || Object.values(pendingActions).some((operation) => operation.kind === "replace");
  const blockingTokenActionPending = Object.values(pendingActions).some((operation) => operation.kind !== "collaborators");
  const restrictionError = restrict && documentIds.length === 0 ? "Select at least one document when restricting a token." : null;
  const documentAuthorityUnavailable = restrict && !documentId && (documentPending !== null || documentError !== null);
  const showRestrictionError = Boolean(restrictionError) && !documentAuthorityUnavailable;
  const managementLink = documentId ? `/settings?next=${encodeURIComponent(`/d/${documentId}`)}#tokens` : "/settings#tokens";
  const matching = conflictName ? tokens?.find((t) => tokenState(t) === "Active" && agentMentionSlug(t.name).toLowerCase() === agentMentionSlug(conflictName).toLowerCase()) : null;
  const chooserVisible = destination === "tokens" && showCreate && restrict && !documentId;

  const isManagerSessionCurrent = useCallback((session: ManagerSession) =>
    activeManagerSession.current === session
    && activeManagerSession.current?.authority === session.authority
    && session.origin === origin
    && session.userLogin === userLogin
    && session.documentId === documentId, [documentId, origin, userLogin]);
  const isControlVisitCurrent = useCallback((visit: ManagerControlVisit) =>
    activeControlVisit.current === visit && isManagerSessionCurrent(visit.session), [isManagerSessionCurrent]);
  const retireControlVisit = useCallback((visit: ManagerControlVisit) => {
    if (activeControlVisit.current === visit) activeControlVisit.current = null;
    const listener = visit.hashListener;
    if (!listener) return;
    visit.hashListener = null;
    window.removeEventListener("hashchange", listener);
  }, []);
  const hasSecretWork = useCallback((visit: ManagerControlVisit) =>
    isControlVisitCurrent(visit)
    && (createOwner.current !== null || [...tokenOwners.current.values()].some((operation) => operation.kind === "replace")),
  [isControlVisitCurrent]);
  const bindTokensButton = useCallback((element: HTMLButtonElement | null) => {
    if (element) {
      tokensButtonControl.element = element;
      tokensButtonOwner.current = tokensButtonControl;
      return;
    }
    tokensButtonControl.element = null;
    if (tokensButtonOwner.current === tokensButtonControl) tokensButtonOwner.current = null;
  }, [tokensButtonControl]);
  const bindCreateButton = useCallback((element: HTMLButtonElement | null) => {
    if (element) {
      createButtonControl.element = element;
      createButtonOwner.current = createButtonControl;
      return;
    }
    createButtonControl.element = null;
    if (createButtonOwner.current === createButtonControl) createButtonOwner.current = null;
  }, [createButtonControl]);
  const documentMutationFree = useCallback((commit: DocumentChooserCommit) => {
    if (commit.mutated) return false;
    if ((commit.observer?.takeRecords().length ?? 0) > 0) {
      commit.mutated = true;
      return false;
    }
    return true;
  }, []);
  const retireDocumentCommit = useCallback((commit: DocumentChooserCommit) => {
    commit.retired = true;
    commit.observer?.disconnect();
    commit.observer = null;
    if (activeDocumentCommit.current === commit) activeDocumentCommit.current = null;
    if (commit.candidate.pending?.pendingCommit === commit) {
      commit.candidate.pending.pendingCommit = null;
    }
  }, []);
  const documentCommitMatches = useCallback((commit: DocumentChooserCommit) => {
    const candidate = commit.candidate;
    const ownerWindow = commit.ownerDocument.defaultView;
    return commit.established
      && !commit.retired
      && documentMountActive.current
      && candidate.mount === documentMount
      && candidate.session === activeManagerSession.current
      && candidate.session.authority === activeManagerSession.current?.authority
      && documentVisit.current === candidate.visit
      && candidate.requestSequence === documentRequestSeq.current
      && candidate.callback === activeDocumentCallback.current
      && candidate.list === api.documents.list
      && Object.isFrozen(candidate.inputs)
      && !!ownerWindow
      && commit.root.isConnected
      && commit.button.isConnected
      && commit.root.ownerDocument === commit.ownerDocument
      && commit.button.ownerDocument === commit.ownerDocument
      && commit.button.parentElement === commit.root.firstElementChild
      && commit.root.dataset.testid === "token-documents"
      && commit.root.className === "max-h-48 overflow-y-auto"
      && commit.button.type === "button"
      && commit.button.className === "btn btn-sm btn-outline"
      && commit.button.textContent === candidate.buttonLabel
      && commit.button.disabled === (candidate.action === null)
      && commit.button.getAttribute("aria-disabled") !== "true"
      && commit.dom !== null
      && secretNoticeDomMatches(commit.dom)
      && commit.placement !== null
      && secretNoticePlacementMatches(commit.root, commit.ownerDocument, commit.placement);
  }, [documentMount]);
  const documentCommitIsCurrent = useCallback((commit: DocumentChooserCommit) =>
    activeDocumentCommit.current === commit
    && documentCommitMatches(commit)
    && documentMutationFree(commit),
  [documentCommitMatches, documentMutationFree]);
  const isDocumentCurrent = useCallback((operation: DocumentListOperation) => {
    const activationCurrent = !operation.activation || (
      operation.pendingCommit !== null
      && operation.pendingCommit.candidate.pending === operation
      && operation.pendingCommit.button === operation.activation.button
      && operation.pendingCommit.ownerDocument === operation.activation.ownerDocument
      && documentCommitIsCurrent(operation.pendingCommit)
    );
    return documentMountActive.current
      && operation.mount === documentMount
      && operation.session === activeManagerSession.current
      && operation.session.authority === activeManagerSession.current?.authority
      && documentVisit.current === operation.visit
      && operation.requestId === operation.request.id
      && operation.request.mount === documentMount
      && (!operation.activation || operation.request.inputs === operation.activation.inputs)
      && operation.request.list === operation.list
      && operation.callback === activeDocumentCallback.current
      && operation.list === api.documents.list
      && documentOwner.current === operation
      && activationCurrent;
  }, [documentCommitIsCurrent, documentMount]);
  const retireDocumentVisit = useCallback((updatePending = true, expectedVisit?: number) => {
    if (expectedVisit !== undefined && documentVisit.current !== expectedVisit) return;
    const owner = documentOwner.current;
    documentVisit.current = null;
    documentOwner.current = null;
    if (owner?.pendingCommit) retireDocumentCommit(owner.pendingCommit);
    const commit = activeDocumentCommit.current;
    if (commit) retireDocumentCommit(commit);
    if (updatePending && owner) {
      setDocumentPending((current) => current === owner ? null : current);
    }
  }, [retireDocumentCommit]);
  const beginDocumentRequest = useCallback<BeginDocumentRequest>((intent, visit, activation) => {
    if (!documentMountActive.current || documentVisit.current !== visit || documentOwner.current) return;
    if (intent !== "initial") {
      if (
        !activation
        || activation.commit.candidate.visit !== visit
        || activation.commit.candidate.inputs !== activation.inputs
        || activation.commit.candidate.callback !== activation.callback
        || activation.commit.candidate.list !== activation.list
        || activation.commit.candidate.action !== activation.action
        || activation.action.intent !== intent
        || activation.button !== activation.commit.button
        || activation.ownerDocument !== activation.commit.ownerDocument
        || activation.callback !== beginDocumentRequest
        || activation.callback !== activeDocumentCallback.current
        || activation.list !== api.documents.list
        || documentRequest.current
        || !documentCommitIsCurrent(activation.commit)
      ) {
        return;
      }
    } else if (activation) {
      return;
    }
    let request = intent === "initial" ? documentRequest.current : null;
    if (!request) {
      const inputs = activation?.inputs ?? Object.freeze<DocumentListInputs>({});
      const list = activation?.list ?? api.documents.list;
      request = {
        mount: documentMount,
        id: ++documentRequestSeq.current,
        inputs,
        list,
        promise: list(inputs),
      };
      documentRequest.current = request;
      const clearRequest = () => {
        if (documentRequest.current === request) documentRequest.current = null;
      };
      void request.promise.then(clearRequest, clearRequest);
    }
    const operation: DocumentListOperation = {
      mount: documentMount,
      session: managerSession,
      visit,
      requestId: request.id,
      intent,
      request,
      callback: beginDocumentRequest,
      list: request.list,
      activation: activation ?? null,
      pendingCommit: null,
    };
    documentOwner.current = operation;
    setDocumentError(null);
    setDocumentPending(operation);
    void (async () => {
      try {
        const res = await operation.request.promise;
        if (!isDocumentCurrent(operation)) return;
        const accessibleIds = new Set(res.documents.map((entry) => entry.id));
        setDocuments(res.documents);
        setDocumentIds((current) => current.filter((documentId) => accessibleIds.has(documentId)));
      } catch (e) {
        if (!isDocumentCurrent(operation)) return;
        setDocumentError(apiErrorText(e, "Could not load documents"));
      } finally {
        if (!isDocumentCurrent(operation)) return;
        documentOwner.current = null;
        setDocumentPending((current) => current === operation ? null : current);
      }
    })();
  }, [documentCommitIsCurrent, documentMount, isDocumentCurrent, managerSession]);
  const beginDocumentVisit = useCallback(() => {
    if (!documentMountActive.current || documentVisit.current !== null) return;
    const visit = ++documentVisitSeq.current;
    documentVisit.current = visit;
    beginDocumentRequest("initial", visit);
  }, [beginDocumentRequest]);
  const documentButtonLabel: DocumentChooserCandidate["buttonLabel"] | null =
    documentPending?.intent === "retry" || (documentError !== null && documentPending === null)
      ? "Retry documents"
      : documents !== null
        ? "Refresh documents"
        : null;
  const documentActionIntent: DocumentChooserAction["intent"] | null =
    documentPending !== null || busy || documentButtonLabel === null
      ? null
      : documentError !== null
        ? "retry"
        : "refresh";
  const documentChooserCandidate: DocumentChooserCandidate | null =
    chooserVisible && documentButtonLabel
      ? Object.freeze({
        identity: Symbol("token-document-chooser"),
        mount: documentMount,
        session: managerSession,
        visit: documentVisit.current ?? -1,
        requestSequence: documentRequestSeq.current,
        inputs: documentPending?.request.inputs ?? Object.freeze<DocumentListInputs>({}),
        callback: beginDocumentRequest,
        list: api.documents.list,
        pending: documentPending,
        action: documentActionIntent
          ? {
            identity: Symbol(`token-document-${documentActionIntent}`),
            intent: documentActionIntent,
            claimed: false,
          }
          : null,
        buttonLabel: documentButtonLabel,
        root: { element: null },
        button: { element: null },
      })
      : null;
  const retireDocumentCandidate = (candidate: DocumentChooserCandidate) => {
    const commit = activeDocumentCommit.current;
    if (commit?.candidate === candidate) retireDocumentCommit(commit);
  };
  const bindDocumentChooserElement = <T extends HTMLDivElement | HTMLButtonElement>(
    candidate: DocumentChooserCandidate,
    slot: DocumentChooserSlot<T>,
    element: T | null,
  ) => {
    const hadActiveCommit = activeDocumentCommit.current?.candidate === candidate;
    if (slot.element !== element) retireDocumentCandidate(candidate);
    slot.element = element;
    if (!element) {
      if (hadActiveCommit || committedDocumentCandidates.current.has(candidate)) {
        detachedDocumentCandidates.current.add(candidate);
      }
      retireDocumentCandidate(candidate);
      return;
    }
    if (
      detachedDocumentCandidates.current.has(candidate)
      && !repairRequestedDocumentCandidates.current.has(candidate)
      && documentMountActive.current
      && documentVisit.current === candidate.visit
      && activeDocumentCommit.current === null
    ) {
      repairRequestedDocumentCandidates.current.add(candidate);
      setDocumentPresentationRevision((current) => current + 1);
    }
  };
  const buildDocumentCommit = (candidate: DocumentChooserCandidate) => {
    const root = candidate.root.element;
    const button = candidate.button.element;
    if (!root || !button || button.parentElement !== root.firstElementChild) return null;
    const commit: DocumentChooserCommit = {
      candidate,
      ownerDocument: root.ownerDocument,
      root,
      button,
      dom: null,
      placement: null,
      buttonTargets: Object.freeze([]),
      established: false,
      retired: false,
      mutated: false,
      observer: null,
    };
    activeDocumentCommit.current = commit;
    queueMicrotask(() => {
      if (
        commit.retired
        || activeDocumentCommit.current !== commit
        || candidate.root.element !== root
        || candidate.button.element !== button
      ) {
        return;
      }
      const placement = snapshotSecretNoticePlacement(root);
      if (!placement) {
        retireDocumentCommit(commit);
        return;
      }
      commit.dom = snapshotSecretNoticeDom(root);
      commit.placement = placement;
      commit.buttonTargets = secretNoticeNodes(button);
      commit.established = true;
      if (!documentCommitMatches(commit)) {
        retireDocumentCommit(commit);
        return;
      }
      if (DocumentChooserMutationObserver) {
        const observer = new DocumentChooserMutationObserver(() => {
          commit.mutated = true;
        });
        observer.observe(root, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
        const observed = new Set<Node>([root]);
        for (const entry of placement) {
          if (entry.parent && !observed.has(entry.parent)) {
            observer.observe(entry.parent, { childList: true });
            observed.add(entry.parent);
          }
        }
        commit.observer = observer;
      }
      committedDocumentCandidates.current.add(candidate);
      if (candidate.pending && documentOwner.current === candidate.pending) {
        candidate.pending.pendingCommit = commit;
      }
    });
    return commit;
  };
  const activateDocumentChooser = (
    candidate: DocumentChooserCandidate,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    const commit = activeDocumentCommit.current;
    const action = candidate.action;
    const button = candidate.button.element;
    const ownerWindow = commit?.ownerDocument.defaultView;
    const nativeEvent = event?.nativeEvent;
    const target = event?.target;
    const reactEvent = event as ReactMouseEvent<HTMLButtonElement> & {
      _reactName?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
      persist?: unknown;
    };
    if (
      !commit
      || commit.candidate !== candidate
      || !action
      || action.claimed
      || !button
      || commit.button !== button
      || !ownerWindow
      || !event
      || typeof event !== "object"
      || event.type !== "click"
      || event.button !== 0
      || event.currentTarget !== button
      || event.defaultPrevented
      || event.bubbles !== true
      || event.cancelable !== true
      || !(nativeEvent instanceof ownerWindow.MouseEvent)
      || nativeEvent.type !== "click"
      || nativeEvent.button !== 0
      || nativeEvent.eventPhase === ownerWindow.Event.NONE
      || !nativeEvent.bubbles
      || !nativeEvent.cancelable
      || nativeEvent.defaultPrevented
      || reactEvent._reactName !== "onClick"
      || typeof reactEvent.isDefaultPrevented !== "function"
      || reactEvent.isDefaultPrevented()
      || typeof reactEvent.isPropagationStopped !== "function"
      || reactEvent.isPropagationStopped()
      || typeof reactEvent.persist !== "function"
      || nativeEvent.target !== target
      || !(target instanceof ownerWindow.Node)
      || target.ownerDocument !== commit.ownerDocument
      || !button.contains(target)
      || !commit.buttonTargets.includes(target)
      || !commit.dom
      || !secretNoticeDomContains(commit.dom, target)
      || !exactDocumentChooserEventPath(nativeEvent, target, commit.ownerDocument)
      || claimedDocumentEvents.current.has(event)
      || claimedDocumentEvents.current.has(nativeEvent)
      || consumedDocumentCommits.current.has(commit)
      || !documentCommitIsCurrent(commit)
    ) {
      return;
    }
    action.claimed = true;
    claimedDocumentEvents.current.add(event);
    claimedDocumentEvents.current.add(nativeEvent);
    consumedDocumentCommits.current.add(commit);
    const activation = Object.freeze<DocumentListActivation>({
      commit,
      action,
      button,
      ownerDocument: commit.ownerDocument,
      inputs: candidate.inputs,
      callback: candidate.callback,
      list: candidate.list,
    });
    candidate.callback(action.intent, candidate.visit, activation);
  };
  const selectDestination = useCallback((visit: ManagerControlVisit, value: "tokens" | "connect") => {
    if (!isControlVisitCurrent(visit) || hasSecretWork(visit)) return;
    setDestination((current) =>
      isControlVisitCurrent(visit) && !hasSecretWork(visit) && current !== value ? value : current);
  }, [hasSecretWork, isControlVisitCurrent]);
  const toggleCreate = useCallback((visit: ManagerControlVisit) => {
    if (!isControlVisitCurrent(visit)) return;
    setShowCreate((current) => isControlVisitCurrent(visit) ? !current : current);
  }, [isControlVisitCurrent]);
  const guardNavigation = useCallback((visit: ManagerControlVisit, event: { preventDefault: () => void }) => {
    if (isControlVisitCurrent(visit) && hasSecretWork(visit)) event.preventDefault();
  }, [hasSecretWork, isControlVisitCurrent]);
  const closeControlVisit = useCallback((visit: ManagerControlVisit) => {
    if (!isControlVisitCurrent(visit) || hasSecretWork(visit)) return;
    const ownedDocumentVisit = documentVisit.current;
    retireControlVisit(visit);
    if (ownedDocumentVisit !== null) retireDocumentVisit(true, ownedDocumentVisit);
    visit.onClose?.();
  }, [hasSecretWork, isControlVisitCurrent, retireControlVisit, retireDocumentVisit]);

  useLayoutEffect(() => {
    const owners = tokenOwners.current;
    const latestOperations = latestTokenOperations.current;
    const flips = pendingFlips.current;
    const rows = updatedRows.current;
    activeManagerSession.current = managerSession;
    return () => {
      if (activeManagerSession.current !== managerSession) return;
      activeManagerSession.current = null;
      loadSeq.current += 1;
      if (createOwner.current?.session === managerSession) createOwner.current = null;
      if (createFocusIntent.current?.facts.session === managerSession) {
        createFocusIntent.current = null;
      }
      for (const [tokenId, operation] of owners) {
        if (operation.session === managerSession) owners.delete(tokenId);
      }
      for (const [tokenId, operation] of latestOperations) {
        if (operation.session === managerSession) latestOperations.delete(tokenId);
      }
      for (const [tokenId, pending] of flips) {
        if (pending.owner.session === managerSession) flips.delete(tokenId);
      }
      rows.clear();
      const publication = createdRef.current;
      if (publication?.session === managerSession) {
        publication.retired = true;
        createdRef.current = null;
      }
    };
  }, [managerSession]);
  useLayoutEffect(() => {
    documentMountActive.current = true;
    return () => {
      documentMountActive.current = false;
      retireDocumentVisit(false);
    };
  }, [retireDocumentVisit]);
  useLayoutEffect(() => {
    activeDocumentCallback.current = beginDocumentRequest;
    return () => {
      if (activeDocumentCallback.current === beginDocumentRequest) {
        activeDocumentCallback.current = null;
      }
    };
  }, [beginDocumentRequest]);
  useLayoutEffect(() => {
    if (chooserVisible) beginDocumentVisit();
    else retireDocumentVisit();
    return () => {
      if (chooserVisible) retireDocumentVisit();
    };
  }, [beginDocumentVisit, chooserVisible, retireDocumentVisit]);
  useLayoutEffect(() => {
    if (!documentChooserCandidate) {
      const current = activeDocumentCommit.current;
      if (current) retireDocumentCommit(current);
      return;
    }
    retireDocumentCandidate(documentChooserCandidate);
    const commit = buildDocumentCommit(documentChooserCandidate);
    if (!commit) return;
    return () => retireDocumentCommit(commit);
  });

  const load = useCallback(async (ownerCurrent?: () => boolean) => {
    const session = activeManagerSession.current;
    if (!session || !isManagerSessionCurrent(session) || (ownerCurrent && !ownerCurrent())) return;
    const seq = ++loadSeq.current;
    updatedRows.current.clear();
    setLoadError(null);
    const current = () => isManagerSessionCurrent(session) && seq === loadSeq.current && (!ownerCurrent || ownerCurrent());
    try {
      const res = await api.tokens.list(true);
      if (!current()) return;
      // Keep rows added or revoked by this reload without overwriting newer metadata edits.
      setTokens(res.tokens.map((row) => {
        const updated = updatedRows.current.get(row.id) ?? row;
        return { ...updated, collaboratorsMayAsk: pendingFlips.current.get(row.id)?.value ?? updated.collaboratorsMayAsk };
      }));
    } catch (e) {
      if (!current()) return;
      setTokens(null);
      setLoadError({ message: apiErrorText(e, "Failed to load tokens"), permission: e instanceof ApiError && (e.status === 401 || e.status === 403) });
    }
  }, [isManagerSessionCurrent]);
  useEffect(() => { void load(); }, [load]);
  useLayoutEffect(() => {
    activeControlVisit.current = controlVisit;
    if (controlVisit.embedded) return () => retireControlVisit(controlVisit);
    const readHash = () => {
      if (!isControlVisitCurrent(controlVisit) || hasSecretWork(controlVisit)) return;
      const value = window.location.hash === "#connect" ? "connect" : "tokens";
      setDestination((current) =>
        isControlVisitCurrent(controlVisit) && !hasSecretWork(controlVisit) && current !== value ? value : current);
    };
    controlVisit.hashListener = readHash;
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => retireControlVisit(controlVisit);
  }, [controlVisit, hasSecretWork, isControlVisitCurrent, retireControlVisit]);

  const isCreateCurrent = (operation: CreateOperation) =>
    isManagerSessionCurrent(operation.session) && createOwner.current === operation;
  const isTokenCurrent = (operation: TokenOperation) =>
    isManagerSessionCurrent(operation.session) && tokenOwners.current.get(operation.id) === operation;
  const isLatestTokenOperation = (operation: TokenOperation) =>
    isManagerSessionCurrent(operation.session) && latestTokenOperations.current.get(operation.id) === operation;
  const tokenOperationBlocked = (tokenId: string, kind: TokenMutationKind) =>
    !isManagerSessionCurrent(managerSession)
    || tokenOwners.current.has(tokenId)
    || (kind === "replace" && (createdRef.current !== null || hasSecretWork(controlVisit)));
  const beginTokenOperation = (tokenId: string, kind: TokenMutationKind) => {
    const session = activeManagerSession.current;
    if (!session || !isManagerSessionCurrent(session) || tokenOperationBlocked(tokenId, kind)) return null;
    const operation: TokenOperation = { session, id: tokenId, kind };
    tokenOwners.current.set(tokenId, operation);
    latestTokenOperations.current.set(tokenId, operation);
    setPendingActions((current) => ({ ...current, [tokenId]: operation }));
    return operation;
  };
  const finishTokenOperation = (operation: TokenOperation) => {
    if (!isTokenCurrent(operation)) return;
    tokenOwners.current.delete(operation.id);
    setPendingActions((current) => {
      if (current[operation.id] !== operation) return current;
      const next = { ...current };
      delete next[operation.id];
      return next;
    });
  };
  const showCreated = (value: CreatedApiTokenDto | CreatedSecretValue) => {
    const previous = createdRef.current;
    if (previous) previous.retired = true;
    const publication: CreatedSecretPublication = {
      identity: Symbol("created-token-secret"),
      sequence: ++createdPublicationSequence.current,
      session: managerSession,
      value: snapshotCreatedSecret(value),
      retired: false,
    };
    Object.seal(publication);
    createdRef.current = publication;
    setCreatedPublication(publication);
  };
  const clearCreated = (publication: CreatedSecretPublication) => {
    if (createdRef.current !== publication || publication.retired) return false;
    publication.retired = true;
    createdRef.current = null;
    setCreatedPublication((current) => current === publication ? null : current);
    return true;
  };
  const ownsSecretNotice = useCallback<SecretNoticeOwner>((visit, publication, buttonControl) => {
    const button = buttonControl.element;
    return isControlVisitCurrent(visit)
      && publication.session === visit.session
      && createdRef.current === publication
      && !publication.retired
      && buttonControl.visit === visit
      && tokensButtonOwner.current === buttonControl
      && !!button
      && button.isConnected
      && button.ownerDocument.defaultView !== null;
  }, [isControlVisitCurrent]);
  const dismissCreated = (
    visit: ManagerControlVisit,
    publication: CreatedSecretPublication,
    buttonControl: TokensButtonControl,
  ) => {
    const button = buttonControl.element;
    if (!ownsSecretNotice(visit, publication, buttonControl)
      || !button
      || !clearCreated(publication)) return;
    if (isControlVisitCurrent(visit)
      && tokensButtonOwner.current === buttonControl
      && buttonControl.element === button
      && button.isConnected) button.focus();
  };

  const create = async () => {
    const session = activeManagerSession.current;
    if (!session || !isManagerSessionCurrent(session)) return;
    if (documentAuthorityUnavailable) return;
    if (restrictionError) { setError(restrictionError); return; }
    if (createOwner.current || createdRef.current || [...tokenOwners.current.values()].some((operation) => operation.kind !== "collaborators")) return;
    const operation: CreateOperation = { session, name, expires, scope, restrict, documentIds: [...documentIds] };
    createOwner.current = operation;
    setCreatePending(operation);
    setError(null);
    setConflictName(null);
    try {
      const res = await api.tokens.create(operation.name, operation.expires === "never" ? null : Number(operation.expires), {
        scope: operation.scope,
        documentIds: operation.restrict ? operation.documentIds : null,
      });
      if (!isCreateCurrent(operation)) return;
      showCreated(res.token);
      await load(() => isCreateCurrent(operation));
    } catch (e) {
      if (!isCreateCurrent(operation)) return;
      setError(apiErrorText(e, "Could not create token"));
      if (e instanceof ApiError && e.status === 409) {
        setConflictName(operation.name);
        await load(() => isCreateCurrent(operation));
      }
    } finally {
      if (isCreateCurrent(operation)) {
        createOwner.current = null;
        setCreatePending((current) => current === operation ? null : current);
      }
    }
  };

  const changeToken = async (token: ApiTokenDto, action: "rename" | "replace" | "revoke", newName?: string): Promise<boolean> => {
    if (tokenOperationBlocked(token.id, action)) return false;
    if (action === "revoke" && !window.confirm(`Revoke "${token.name}"? Every client using it will stop working immediately.`)) return false;
    if (action === "replace" && !window.confirm(`Replace "${token.name}"? Once the replacement is created, the old token stops working in every client. Update those clients with the new secret. Scope, documents and expiry stay unchanged. Continue?`)) return false;
    const operation = beginTokenOperation(token.id, action);
    if (!operation) return false;
    setError(null);
    try {
      if (action === "rename") {
        const res = await api.tokens.update(token.id, { name: newName });
        if (!isTokenCurrent(operation)) return false;
        updatedRows.current.set(token.id, res.token);
        setTokens((rows) => isLatestTokenOperation(operation) ? rows?.map((row) => row.id === token.id ? res.token : row) ?? null : rows);
        const publication = createdRef.current;
        if (publication?.value.id === token.id) showCreated({ ...publication.value, name: res.token.name });
      } else {
        if (action === "replace") {
          const res = await api.tokens.replace(token.id);
          if (!isTokenCurrent(operation)) return false;
          showCreated(res.token);
        } else {
          await api.tokens.revoke(token.id);
          if (!isTokenCurrent(operation)) return false;
          const publication = createdRef.current;
          if (publication?.value.id === token.id) clearCreated(publication);
        }
        tokensButtonOwner.current?.element?.focus();
        await load(() => isTokenCurrent(operation));
      }
      return true;
    } catch (e) {
      if (isTokenCurrent(operation)) setError(apiErrorText(e, `Could not ${action} token`));
      return false;
    } finally {
      finishTokenOperation(operation);
    }
  };

  const setCollaboratorsMayAsk = async (t: ApiTokenDto, value: boolean) => {
    const operation = beginTokenOperation(t.id, "collaborators");
    if (!operation) return;
    const pending = { value, owner: operation };
    pendingFlips.current.set(t.id, pending);
    const flip = (nextValue: boolean) => setTokens((rows) =>
      isLatestTokenOperation(operation)
        ? rows?.map((row) => row.id === t.id ? { ...row, collaboratorsMayAsk: nextValue } : row) ?? rows
        : rows);
    flip(value);
    setSwitchErrors((current) => {
      if (!isLatestTokenOperation(operation)) return current;
      if (!(t.id in current)) return current;
      const next = { ...current };
      delete next[t.id];
      return next;
    });
    try {
      const res = await api.tokens.update(t.id, { collaboratorsMayAsk: value });
      if (isTokenCurrent(operation) && pendingFlips.current.get(t.id) === pending) {
        updatedRows.current.set(t.id, res.token);
        setTokens((rows) => isLatestTokenOperation(operation) ? rows?.map((row) => row.id === t.id ? res.token : row) ?? rows : rows);
      }
    } catch (e) {
      if (!isTokenCurrent(operation) || pendingFlips.current.get(t.id) !== pending) return;
      flip(!value);
      setSwitchErrors((current) => isLatestTokenOperation(operation)
        ? { ...current, [t.id]: `Could not update “${t.name}”: ${apiErrorText(e, "The change was not saved")}` }
        : current);
    } finally {
      if (isTokenCurrent(operation) && pendingFlips.current.get(t.id) === pending) {
        pendingFlips.current.delete(t.id);
      }
      finishTokenOperation(operation);
    }
  };

  const createButtonEligible =
    !busy && tokens !== null && !created && !blockingTokenActionPending;
  const sameValues = <Value,>(left: readonly Value[], right: readonly Value[]) =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  const mapHasEntries = <Value,>(
    map: ReadonlyMap<string, Value>,
    entries: readonly (readonly [string, Value])[],
  ) => map.size === entries.length
    && entries.every(([key, value]) => map.get(key) === value);
  const recordHasEntries = <Value,>(
    record: Record<string, Value>,
    entries: readonly (readonly [string, Value])[],
  ) => Object.keys(record).length === entries.length
    && entries.every(([key, value]) => record[key] === value);
  const createFormFacts = showCreate
    ? Object.freeze<CreateFormFacts>({
      identity: Symbol("token-create-form-facts"),
      mount: createFormMount,
      visit: controlVisit,
      visitIdentity: controlVisit.identity,
      visitSequence: controlVisit.sequence,
      session: managerSession,
      sessionAuthority: managerSession.authority,
      origin,
      userLogin,
      documentId,
      embedded,
      next,
      onClose,
      destination: "tokens",
      tokens,
      name,
      expires,
      scope,
      restrict,
      documentIdsSource: documentIds,
      documentIds: Object.freeze([...documentIds]),
      documents,
      documentError,
      documentPending,
      createPending,
      pendingActionsSource: pendingActions,
      pendingActions: Object.freeze(Object.entries(pendingActions)),
      error,
      conflictName,
      createdPublication,
      createOwner: createOwner.current,
      tokenOwners: Object.freeze([...tokenOwners.current.entries()]),
      documentOwner: documentOwner.current,
      documentVisit: documentVisit.current,
      documentRequestSequence: documentRequestSeq.current,
      documentCallback: activeDocumentCallback.current,
      documentCandidate: documentChooserCandidate,
      documentCommit: activeDocumentCommit.current,
      restrictionError,
      documentAuthorityUnavailable,
      buttonEligible: createButtonEligible,
      cancel: toggleCreate,
      submit: create,
      beginDocumentVisit,
      retireDocumentVisit,
      buttonControl: createButtonControl,
    })
    : null;
  const createFormPublication = createFormFacts
    ? createFormCoordinator.create(createFormFacts)
    : null;
  const createStateMatches = (
    facts: CreateFormFacts,
    expanded: boolean,
    exactDocumentOperation: boolean,
  ) => {
    const tokenEntriesMatch = mapHasEntries(tokenOwners.current, facts.tokenOwners);
    const activeCommit = activeDocumentCommit.current;
    const documentCommitMatchesFacts = facts.documentCandidate
      ? activeCommit?.candidate === facts.documentCandidate
        && documentCommitIsCurrent(activeCommit)
      : activeCommit === facts.documentCommit;
    const documentOperationMatches = exactDocumentOperation
      ? documentPending === facts.documentPending
        && documentOwner.current === facts.documentOwner
        && documentVisit.current === facts.documentVisit
        && documentRequestSeq.current === facts.documentRequestSequence
        && activeDocumentCallback.current === facts.documentCallback
        && documentCommitMatchesFacts
      : (documentPending === facts.documentPending || documentPending === null)
        && documentVisit.current === null
        && documentOwner.current === null
        && activeDocumentCommit.current === null;
    return facts.mount === createFormMount
      && facts.visit === controlVisit
      && facts.visitIdentity === controlVisit.identity
      && facts.visitSequence === controlVisit.sequence
      && facts.session === managerSession
      && facts.sessionAuthority === managerSession.authority
      && facts.origin === origin
      && facts.userLogin === userLogin
      && facts.documentId === documentId
      && facts.embedded === embedded
      && facts.next === next
      && facts.onClose === onClose
      && facts.destination === "tokens"
      && destination === facts.destination
      && showCreate === expanded
      && isControlVisitCurrent(facts.visit)
      && activeManagerSession.current === facts.session
      && tokens === facts.tokens
      && name === facts.name
      && expires === facts.expires
      && scope === facts.scope
      && restrict === facts.restrict
      && documentIds === facts.documentIdsSource
      && sameValues(documentIds, facts.documentIds)
      && documents === facts.documents
      && documentError === facts.documentError
      && createPending === facts.createPending
      && pendingActions === facts.pendingActionsSource
      && recordHasEntries(pendingActions, facts.pendingActions)
      && error === facts.error
      && conflictName === facts.conflictName
      && createdPublication === facts.createdPublication
      && createOwner.current === facts.createOwner
      && tokenEntriesMatch
      && restrictionError === facts.restrictionError
      && documentAuthorityUnavailable === facts.documentAuthorityUnavailable
      && createButtonEligible === facts.buttonEligible
      && facts.cancel === toggleCreate
      && facts.beginDocumentVisit === beginDocumentVisit
      && facts.retireDocumentVisit === retireDocumentVisit
      && facts.buttonControl === createButtonControl
      && documentOperationMatches;
  };
  const createFactsAreCurrent = (facts: CreateFormFacts) =>
    createStateMatches(facts, true, true)
    && facts.submit === create
    && facts.buttonEligible
    && facts.createOwner === null
    && facts.createPending === null
    && facts.pendingActions.every(([, operation]) => operation.kind === "collaborators")
    && facts.tokenOwners.every(([, operation]) => operation.kind === "collaborators");
  const createDomIsExact = (publication: CreateFormPublication) => {
    const facts = publication.facts;
    const button = publication.button.element;
    const form = publication.form.element;
    const ownerWindow = form?.ownerDocument.defaultView;
    const nameInput = form?.querySelector<HTMLInputElement>('[data-testid="token-name"]');
    const scopeFieldset = form?.querySelector<HTMLFieldSetElement>('[data-testid="token-scope"]');
    const scopeInputs = scopeFieldset
      ? [...scopeFieldset.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
      : [];
    const restrictInput = form?.querySelector<HTMLInputElement>('[data-testid="token-restrict"]');
    const access = form?.querySelector<HTMLElement>('[data-testid="token-document-access"]');
    const expiration = form?.querySelector<HTMLSelectElement>('[data-testid="token-expiration"]');
    const createButton = form?.querySelector<HTMLButtonElement>('[data-testid="token-create"]');
    const chooser = form?.querySelector<HTMLElement>('[data-testid="token-documents"]');
    const restriction = form?.querySelector<HTMLElement>('[data-testid="token-document-error"]');
    const documentInputs = chooser
      ? [...chooser.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      : [];
    const expectedDocumentInputs = facts.documents ?? [];
    const createDisabled = busy
      || blockingTokenActionPending
      || Boolean(created)
      || tokens === null
      || !name.trim()
      || Boolean(restrictionError)
      || documentAuthorityUnavailable;
    return !!button
      && !!form
      && !!ownerWindow
      && publication.facts.buttonControl.element === button
      && createButtonOwner.current === publication.facts.buttonControl
      && button.ownerDocument === form.ownerDocument
      && button.isConnected
      && form.isConnected
      && button.type === "button"
      && button.className === "btn btn-outline w-fit gap-1.5"
      && button.dataset.testid === "token-add"
      && button.disabled === !facts.buttonEligible
      && button.getAttribute("aria-expanded") === "true"
      && button.getAttribute("aria-controls") === form.id
      && button.textContent?.trim() === "Cancel creation"
      && form.id === `${id}-create`
      && form.className === "flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-3"
      && form.dataset.testid === "token-create-form"
      && form.tabIndex === -1
      && form.getAttribute("aria-busy") === (facts.createPending ? "true" : null)
      && !!nameInput
      && nameInput.form === form
      && nameInput.value === facts.name
      && nameInput.maxLength === 80
      && nameInput.disabled === Boolean(facts.createPending)
      && !!scopeFieldset
      && scopeFieldset.form === form
      && scopeFieldset.disabled === Boolean(facts.createPending)
      && scopeInputs.length === SCOPES.length
      && scopeInputs.every((input, index) =>
        input.form === form
        && input.name === `${id}-scope`
        && input.checked === (facts.scope === SCOPES[index])
        && input.dataset.testid === `token-scope-${SCOPES[index]}`)
      && !!restrictInput
      && restrictInput.form === form
      && restrictInput.type === "checkbox"
      && restrictInput.checked === facts.restrict
      && restrictInput.disabled === Boolean(facts.createPending)
      && restrictInput.getAttribute("aria-invalid") === (
        Boolean(showRestrictionError) ? "true" : "false"
      )
      && !!access
      && access.textContent === (
        facts.restrict
          ? "Every other document answers 404 to this token."
          : "This token will access all documents you can access."
      )
      && Boolean(chooser) === (facts.restrict && !facts.documentId)
      && documentInputs.length === (
        facts.restrict && !facts.documentId && facts.documents
          ? expectedDocumentInputs.length
          : 0
      )
      && documentInputs.every((input, index) => {
        const document = expectedDocumentInputs[index];
        return !!document
          && input.form === form
          && input.dataset.testid === `token-document-${document.id}`
          && input.checked === facts.documentIds.includes(document.id)
          && input.disabled === Boolean(facts.createPending);
      })
      && Boolean(restriction) === Boolean(showRestrictionError)
      && (!restriction || restriction.textContent === facts.restrictionError)
      && !!expiration
      && expiration.form === form
      && expiration.value === facts.expires
      && expiration.disabled === Boolean(facts.createPending)
      && !!createButton
      && createButton.form === form
      && createButton.type === "submit"
      && createButton.disabled === createDisabled
      && createButton.textContent?.trim() === "Create token"
      && [...form.querySelectorAll("*")].every(
        (element) => element.ownerDocument === form.ownerDocument,
      );
  };
  const deliverCreateEscape = (
    publication: CreateFormPublication,
    event: ReactKeyboardEvent<HTMLFormElement>,
  ) => {
    const claim = createFormCoordinator.claim(
      publication,
      event,
      () => createFactsAreCurrent(publication.facts),
      () => createDomIsExact(publication),
    );
    if (!claim) return;
    claim.authority.apply(claim.authority.preventDefault, claim.native.event, []);
    let prevented = false;
    try {
      prevented = createFormNativeValue<boolean>(
        claim.authority,
        claim.authority.event.defaultPrevented,
        claim.native.event,
      );
    } catch {
      return;
    }
    if (
      !prevented
      || !createFormCoordinator.claimedIsCurrent(
        publication,
        claim.native,
        claim.pair,
        () => createFactsAreCurrent(publication.facts),
        () => createDomIsExact(publication),
      )
    ) {
      return;
    }
    const button = publication.button.element;
    if (!button) return;
    createFocusIntent.current = Object.freeze({
      publication,
      facts: publication.facts,
      authority: claim.authority,
      button,
      ownerDocument: button.ownerDocument,
      buttonControl: publication.facts.buttonControl,
    });
    publication.facts.cancel(publication.facts.visit);
  };

  const createLayoutCycle = createFormPublication
    ? Object.freeze<CreateFormLayoutCycle>({
        setup: () => {
          createFormCoordinator.establish(
            createFormPublication,
            () => createFactsAreCurrent(createFormPublication.facts),
            () => createDomIsExact(createFormPublication),
          );
        },
        cleanup: () => createFormCoordinator.retire(createFormPublication),
      })
    : null;
  useLayoutEffect(() => {
    if (!createFormPublication) {
      createFormCoordinator.retireCurrent();
      return;
    }
    if (!createFormPublication.established) {
      const establish = () => createFormCoordinator.establish(
        createFormPublication,
        () => createFactsAreCurrent(createFormPublication.facts),
        () => createDomIsExact(createFormPublication),
      );
      establish();
      if (!createFormPublication.established) {
        queueMicrotask(establish);
      }
    }
  });
  useLayoutEffect(() => {
    const intent = createFocusIntent.current;
    if (!intent) return;
    const button = intent.buttonControl.element;
    const facts = intent.facts;
    const valid = createFormCoordinator.ownsClaim(intent.publication)
      && createStateMatches(facts, false, false)
      && button === intent.button
      && createButtonOwner.current === intent.buttonControl
      && intent.buttonControl.visit === facts.visit
      && button?.ownerDocument === intent.ownerDocument
      && intent.ownerDocument.defaultView === intent.authority.ownerWindow
      && button.isConnected
      && button.type === "button"
      && button.dataset.testid === "token-add"
      && button.getAttribute("aria-expanded") === "false"
      && button.textContent?.trim() === "Create token"
      && !button.disabled
      && intent.authority.isCurrent();
    createFocusIntent.current = null;
    if (!valid || !button) return;
    intent.authority.apply(intent.authority.focus, button, [{ preventScroll: true }]);
  });

  return (
    <div className="flex min-w-0 flex-col gap-4" id={embedded ? undefined : "tokens"} data-testid="token-manager">
      {!embedded && <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-ink"><KeyRound size={20} /> Tokens &amp; MCP</h1>
        <p className="mt-1 text-sm text-ink-3">Manage tokens for {userLogin}. Agents can never do more than you can.</p>
        {next && <a className={cn("btn btn-outline btn-sm mt-3 gap-1.5", secretWorkPending && "pointer-events-none opacity-50")}
          href={next} aria-disabled={secretWorkPending || undefined} tabIndex={secretWorkPending ? -1 : undefined}
          onClick={(event) => guardNavigation(controlVisit, event)} data-testid="settings-back-to-document">
          <ArrowLeft size={14} /> Back to the document
        </a>}
      </div>}
      <div className={cn("flex flex-wrap items-start gap-2", embedded && "sticky top-0 z-10 bg-surface py-2")}>
      <nav className="flex min-w-0 flex-wrap gap-2" aria-label="Token access">
        <button ref={bindTokensButton} type="button" className={cn("btn btn-sm", destination === "tokens" ? "btn-primary" : "btn-outline")}
         aria-pressed={destination === "tokens"} disabled={secretWorkPending}
         onClick={() => selectDestination(controlVisit, "tokens")}>Tokens</button>
        <button type="button" className={cn("btn btn-sm whitespace-normal text-left", destination === "connect" ? "btn-primary" : "btn-outline")}
         aria-pressed={destination === "connect"} disabled={secretWorkPending}
         onClick={() => selectDestination(controlVisit, "connect")}>Connect an MCP client</button>
      </nav>
      {onClose && <button type="button" className="btn btn-ghost btn-sm" disabled={secretWorkPending}
       onClick={() => closeControlVisit(controlVisit)}>Close token management</button>}
      </div>
      <p className="text-xs leading-5 text-ink-3">Existing secrets cannot be shown again. Rename changes only the name; replace creates a new secret.</p>
      {error && <p role="alert" aria-atomic="true" className="wrap-anywhere text-sm text-danger">{error}</p>}
      {conflictName && <p className="text-sm text-ink-2" data-testid="token-conflict">
        {matching ? `The matching token "${matching.name}" is in Your tokens below. Rename, replace or revoke it, or choose a different name for a separate token.`
          : "That name is reserved by an existing token, but it could not be matched to this list. Retry the list or open all your tokens in a signed-in browser session; do not create another until the scope and account are clear."}
        {!matching && <button type="button" className="btn btn-outline btn-sm mt-2" disabled={busy} onClick={() => void load()}>Refresh token list</button>}
      </p>}
      {createdPublication && <SecretNotice
        key={`${controlVisit.sequence}:${createdPublication.sequence}`}
        visit={controlVisit}
        publication={createdPublication}
        buttonControl={tokensButtonControl}
        owns={ownsSecretNotice}
        dismiss={dismissCreated}
      />}
      <section className="min-w-0 rounded-xl border border-line bg-surface" aria-label="Your tokens">
        <h2 className="border-b border-line px-3 py-2 text-sm font-semibold text-ink">Your tokens</h2>
        {loadError ? <div className="p-3 text-sm">
          <p role="alert" aria-atomic="true" className="wrap-anywhere text-danger">{loadError.message}</p>
          <p className="mt-1 text-ink-3">{loadError.permission ? "Token management requires your signed-in browser session, not an agent or embedded session." : "The list could not be loaded. This does not mean you have no tokens."}</p>
          <button type="button" className="btn btn-outline btn-sm mt-2" onClick={() => void load()}>Retry token list</button>
        </div> : tokens === null ? <p className="p-3 text-sm text-ink-3">Loading tokens...</p>
          : tokens.length === 0 ? <p className="p-3 text-sm text-ink-3">No tokens yet.</p>
            : <ul className="divide-y divide-line">
             {tokens.map((t) => <TokenRow key={t.id} panel={tokenPanelAuthority} token={t} documentId={documentId} matching={matching?.id === t.id}
             disabled={Boolean(pendingActions[t.id])} replacementDisabled={Boolean(created) || secretWorkPending}
                onAction={(action, newName) => changeToken(t, action, newName)}
                onCollaboratorsChange={() => void setCollaboratorsMayAsk(t, !t.collaboratorsMayAsk)}
             switchError={switchErrors[t.id] ?? null} />)}
            </ul>}
      </section>
      {embedded && <a className={cn("w-fit text-sm font-medium text-accent hover:underline", secretWorkPending && "pointer-events-none opacity-50")}
        href={managementLink} aria-disabled={secretWorkPending || undefined} tabIndex={secretWorkPending ? -1 : undefined}
        onClick={(event) => guardNavigation(controlVisit, event)}>Open all your tokens in Settings</a>}
      {destination === "connect" ? <div id={embedded ? undefined : "connect"} className="min-w-0">
        <p className="mb-3 text-sm text-ink-2">Choose a client and copy its setup. Put your saved token in the Authorization header where it says MARKDOC_TOKEN. No connection is needed to read these instructions.</p>
        <AgentConnectCard origin={liveOrigin} scope={created?.scope} hideTokenStep />
      </div> : <>
        <button
          ref={createFormPublication
            ? (element) => {
              createFormCoordinator.bind(
                createFormPublication,
                createFormPublication.button,
                element,
              );
              bindCreateButton(element);
            }
            : bindCreateButton}
          type="button" className="btn btn-outline w-fit gap-1.5" disabled={!createButtonEligible}
          aria-expanded={showCreate} aria-controls={`${id}-create`} onClick={() => toggleCreate(controlVisit)} data-testid="token-add">
          <Plus size={16} /> {showCreate ? "Cancel creation" : "Create token"}
        </button>
        {createFormPublication && createLayoutCycle && <><form
          ref={(element) => createFormCoordinator.bind(
            createFormPublication,
            createFormPublication.form,
            element,
          )}
          id={`${id}-create`}
          className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-3"
          tabIndex={-1}
          aria-busy={busy || undefined}
          data-testid="token-create-form"
          onKeyDownCapture={(event) => createFormCoordinator.publishKeyboardPair(
           createFormPublication,
           event,
           () => createFactsAreCurrent(createFormPublication.facts),
           () => createDomIsExact(createFormPublication),
          )}
          onKeyDown={(event) => deliverCreateEscape(createFormPublication, event)}
          onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-3">Name (shown as the agent)
           <input className="input w-full min-w-0" value={name} maxLength={80} disabled={busy} onChange={(e) => setName(e.target.value)} data-testid="token-name" />
          </label>
         <fieldset className="flex flex-col gap-1.5" disabled={busy} data-testid="token-scope">
            <legend className="mb-1 text-xs font-medium text-ink-3">Scope</legend>
            {SCOPES.map((s) => <label key={s} className="flex items-start gap-2 text-sm text-ink-2">
              <input type="radio" name={`${id}-scope`} checked={scope === s} onChange={() => setScope(s)} className="mt-1" data-testid={`token-scope-${s}`} />
              <span><span className="font-medium text-ink">{TOKEN_SCOPE_LABEL[s]}</span> — {TOKEN_SCOPE_SUMMARY[s]}</span>
            </label>)}
          </fieldset>
          <label className="flex items-center gap-2 text-sm text-ink-2">
           <input type="checkbox" checked={restrict} disabled={busy} onChange={(e) => {
             if (e.target.checked) beginDocumentVisit();
             else retireDocumentVisit();
             setRestrict(e.target.checked);
           }} aria-invalid={Boolean(showRestrictionError)}
              aria-describedby={`${id}-access`} data-testid="token-restrict" />
            {documentId ? "Only this document" : "Only these documents"}
          </label>
          <p id={`${id}-access`} className="text-xs text-ink-3" data-testid="token-document-access">{restrict ? "Every other document answers 404 to this token." : "This token will access all documents you can access."}</p>
          {restrict && !documentId && <div
            ref={documentChooserCandidate
              ? (element) => bindDocumentChooserElement(documentChooserCandidate, documentChooserCandidate.root, element)
              : undefined}
            className="max-h-48 overflow-y-auto" data-testid="token-documents">
           {(documentPending || documentChooserCandidate) && <div className="flex flex-wrap items-center gap-2">
             {documentPending && <p role="status" aria-live="polite" aria-atomic="true" className="text-xs text-ink-3" data-testid="token-documents-pending">
               {documentPending.intent === "initial" ? "Loading your documents..." : "Refreshing your documents..."}
             </p>}
             {documentChooserCandidate && <button
               ref={(element) => bindDocumentChooserElement(documentChooserCandidate, documentChooserCandidate.button, element)}
               type="button" className="btn btn-sm btn-outline"
               disabled={documentChooserCandidate.action === null}
               onClick={(event) => activateDocumentChooser(documentChooserCandidate, event)}>
               {documentChooserCandidate.buttonLabel}
             </button>}
           </div>}
           {documentError && <><p role="alert" aria-atomic="true" className="wrap-anywhere text-sm text-danger">{documentError}</p>
           </>}
           {documents !== null && (documents.length === 0 ? <p className="text-xs text-ink-3">No documents yet.</p>
                  : documents.map((d) => <label key={d.id} className="flex items-start gap-2 text-sm text-ink-2">
                   <input type="checkbox" checked={documentIds.includes(d.id)} disabled={busy} onChange={() => setDocumentIds((ids) => ids.includes(d.id) ? ids.filter((value) => value !== d.id) : [...ids, d.id])} data-testid={`token-document-${d.id}`} />
                    <span className="min-w-0 break-words">{d.title}</span>
                  </label>))}
          </div>}
          {showRestrictionError && <p className="text-xs text-danger" role="alert" data-testid="token-document-error">{restrictionError}</p>}
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">Expires
           <select className="select w-fit" value={expires} disabled={busy} onChange={(e) => setExpires(e.target.value)}
             data-testid="token-expiration">
              <option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="never">Never</option>
            </select>
          </label>
          <button type="submit" className="btn btn-primary w-fit gap-1.5" disabled={busy || blockingTokenActionPending || Boolean(created) || tokens === null || !name.trim() || Boolean(restrictionError) || documentAuthorityUnavailable} data-testid="token-create">
            {busy && <Loader2 size={16} className="animate-spin" />} Create token
          </button>
        </form><CreateFormLayoutBoundary cycle={createLayoutCycle} /></>}
      </>}
    </div>
  );
}

function TokenRow({ panel, token: t, documentId, matching, disabled, replacementDisabled, onAction, onCollaboratorsChange, switchError }: {
  panel: TokenPanelAuthority; token: ApiTokenDto; documentId?: string; matching: boolean; disabled: boolean; replacementDisabled: boolean;
  onAction: (action: "rename" | "replace" | "revoke", name?: string) => Promise<boolean>;
  onCollaboratorsChange: () => void; switchError: string | null;
}) {
  type RenameVisit = Readonly<{ identity: symbol; mount: symbol; tokenId: string }>;
  type RenameDraft = Readonly<{ visit: RenameVisit; value: string }>;
  type RowActionKind = "rename" | "replace" | "revoke" | "cancel" | "save";
  type RowActionFacts = Readonly<{ kind: RowActionKind; eligible: boolean }>;
  type RowNavigationRole = "rename" | "replace" | "revoke";
  type RenameNavigationRole = "save" | "cancel";
  type TokenSnapshot = Readonly<{
    source: ApiTokenDto;
    id: string;
    name: string;
    prefix: string;
    scope: ApiTokenDto["scope"];
    documentIdsSource: string[] | null;
    documentIds: readonly string[] | null;
    collaboratorsMayAsk: boolean;
    createdAt: string;
    lastUsedAt: string | null;
    lastMcpSeenAt: string | null;
    lastMcpCallAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null | undefined;
  }>;
  type RowFacts = Readonly<{
    identity: symbol;
    mount: symbol;
    panel: TokenPanelAuthority;
    token: TokenSnapshot;
    documentId: string | undefined;
    matching: boolean;
    disabled: boolean;
    replacementDisabled: boolean;
    onAction: (action: "rename" | "replace" | "revoke", name?: string) => Promise<boolean>;
    onCollaboratorsChange: () => void;
    switchError: string | null;
    renameVisit: RenameVisit | null;
    draft: string | null;
    state: "Active" | "Expired" | "Revoked";
    mismatch: boolean;
    actionsVisible: boolean;
    documentCount: string;
    metadata: string;
    mismatchText: string | null;
    expiredText: string | null;
    prefixDetails: string;
    timeDetails: string;
    mcpDetails: string;
    revokedDetails: string | null;
    documentDetails: string | null;
    renameLabel: string;
    replaceLabel: string;
    revokeLabel: string;
    actionsLabel: string;
    switchLabelId: string;
    switchHelpId: string;
    rowClassName: string;
    rename: RowActionFacts | null;
    replace: RowActionFacts | null;
    revoke: RowActionFacts | null;
    cancel: RowActionFacts | null;
    save: RowActionFacts | null;
    inputEligible: boolean;
  }>;
  type RowElementRole =
    | "row"
    | "header"
    | "metadata"
    | "mismatch"
    | "expired"
    | "actions"
    | "rename"
    | "replace"
    | "revoke"
    | "form"
    | "input"
    | "save"
    | "cancel"
    | "details"
    | "detailsBody"
    | "collaborators"
    | "switchError";
  type RenameRefRole = "row" | "form" | "input" | "save" | "cancel";
  interface ElementSlot<T extends HTMLElement> {
    readonly identity: symbol;
    readonly role: RowElementRole;
    element: T | null;
  }
  interface RowCandidate {
    readonly facts: RowFacts;
    readonly row: ElementSlot<HTMLLIElement>;
    readonly header: ElementSlot<HTMLDivElement>;
    readonly metadata: ElementSlot<HTMLParagraphElement>;
    readonly mismatch: ElementSlot<HTMLParagraphElement>;
    readonly expired: ElementSlot<HTMLParagraphElement>;
    readonly actions: ElementSlot<HTMLDivElement>;
    readonly rename: ElementSlot<HTMLButtonElement>;
    readonly replace: ElementSlot<HTMLButtonElement>;
    readonly revoke: ElementSlot<HTMLButtonElement>;
    readonly form: ElementSlot<HTMLFormElement>;
    readonly input: ElementSlot<HTMLInputElement>;
    readonly save: ElementSlot<HTMLButtonElement>;
    readonly cancel: ElementSlot<HTMLButtonElement>;
    readonly details: ElementSlot<HTMLDetailsElement>;
    readonly detailsBody: ElementSlot<HTMLDivElement>;
    readonly collaborators: ElementSlot<HTMLButtonElement>;
    readonly switchError: ElementSlot<HTMLParagraphElement>;
  }
  type RowCommit = Readonly<{
    candidate: RowCandidate;
    facts: RowFacts;
    ownerDocument: Document;
    parent: HTMLUListElement;
    parentChildren: readonly Element[];
    tree: readonly Node[];
    row: HTMLLIElement;
    header: HTMLDivElement;
    metadata: HTMLParagraphElement;
    mismatch: HTMLParagraphElement | null;
    expired: HTMLParagraphElement | null;
    actions: HTMLDivElement | null;
    rename: HTMLButtonElement | null;
    replace: HTMLButtonElement | null;
    revoke: HTMLButtonElement | null;
    form: HTMLFormElement | null;
    input: HTMLInputElement | null;
    save: HTMLButtonElement | null;
    cancel: HTMLButtonElement | null;
    details: HTMLDetailsElement;
    detailsBody: HTMLDivElement;
    collaborators: HTMLButtonElement | null;
    switchError: HTMLParagraphElement | null;
    renameTargets: readonly Node[] | null;
    replaceTargets: readonly Node[] | null;
    revokeTargets: readonly Node[] | null;
    cancelTargets: readonly Node[] | null;
  }>;
  type RenameNavigationControl = Readonly<{
    identity: symbol;
    role: RenameNavigationRole;
    index: number;
    ownerIdentity: symbol;
    action: RowActionFacts;
    element: HTMLButtonElement;
  }>;
  type RowNavigationControl = Readonly<{
    identity: symbol;
    role: RowNavigationRole;
    index: number;
    order: 0 | 1 | 2;
    ownerIdentity: symbol;
    action: RowActionFacts;
    element: HTMLButtonElement;
  }>;
  type RowNavigationNativeSnapshot = Readonly<{
    event: KeyboardEvent;
    type: string;
    target: HTMLButtonElement;
    currentTarget: EventTarget;
    phase: number;
    path: readonly EventTarget[];
    bubbles: boolean;
    cancelable: boolean;
    defaultPrevented: false;
    cancelBubble: false;
    composed: boolean;
    key: TokenRenameNavigationKey;
    code: string;
    location: number;
    repeat: false;
    composing: false;
    ctrlKey: false;
    altKey: false;
    metaKey: false;
    shiftKey: false;
    view: Window | EventTarget | null;
    detail: number;
    trusted: true;
    terminal: TokenRowKeyboardTerminalProof;
  }>;
  type RowNavigationReactMethods = Readonly<{
    preventDefault: ReactKeyboardEvent<HTMLElement>["preventDefault"];
    isDefaultPrevented: ReactKeyboardEvent<HTMLElement>["isDefaultPrevented"];
    isPropagationStopped: ReactKeyboardEvent<HTMLElement>["isPropagationStopped"];
  }>;
  type RowNavigationReactSnapshot = Readonly<{
    event: ReactKeyboardEvent<HTMLElement>;
    nativeEvent: KeyboardEvent;
    target: HTMLButtonElement;
    currentTarget: HTMLElement;
    phase: number;
    view: ReactKeyboardEvent<HTMLElement>["view"] | null;
    methods: RowNavigationReactMethods;
  }>;
  interface RowNavigationPublication {
    current: WeakMap<KeyboardEvent, PendingRowNavigation> | null;
  }
  interface RowNavigationAuthority {
    readonly identity: symbol;
    readonly mount: symbol;
    readonly panel: TokenPanelAuthority;
    readonly candidate: RowCandidate;
    readonly commit: RowCommit;
    readonly token: TokenSnapshot;
    readonly callback: RowFacts["onAction"];
    readonly group: HTMLDivElement;
    readonly controls: readonly RowNavigationControl[];
    readonly ownerDocument: Document;
    readonly keyboard: TokenRenameKeyboardAuthority;
    readonly terminal: TokenRowKeyboardTerminalRegistration;
    readonly publication: RowNavigationPublication;
    readonly dom: SecretNoticeDomSnapshot;
    readonly placement: readonly SecretNoticePlacement[];
    readonly history: TokenRenameMutationHistory;
    retired: boolean;
  }
  type PendingRowNavigation = Readonly<{
    authority: RowNavigationAuthority;
    publication: WeakMap<KeyboardEvent, PendingRowNavigation>;
    native: RowNavigationNativeSnapshot;
    capture: RowNavigationReactSnapshot;
    terminal: TokenRowKeyboardTerminalProof;
    source: RowNavigationControl;
    destination: RowNavigationControl;
    key: TokenRenameNavigationKey;
    movement: object;
    commitClaim: object;
    actionSetClaim: object;
    movementClaim: object;
    wrapperClaim: object;
    nativeClaim: object;
    windowClaim: object;
    sourceClaim: object;
    destinationClaim: object;
  }>;
  type RowNavigationDelivery = Readonly<{
    pair: PendingRowNavigation;
    bubble: RowNavigationReactSnapshot;
  }>;
  type RenameNavigationReactEvent = ReactKeyboardEvent<HTMLFormElement>;
  type RenameNavigationReactMethod = (this: object, ...args: never[]) => unknown;
  type RenameNavigationReactMethods = Readonly<{
    preventDefault: RenameNavigationReactMethod;
    isDefaultPrevented: RenameNavigationReactMethod;
    isPropagationStopped: RenameNavigationReactMethod;
  }>;
  type RenameNavigationReactProof = Readonly<{
    event: RenameNavigationReactEvent;
    nativeEvent: KeyboardEvent;
    currentTarget: HTMLFormElement;
    target: HTMLButtonElement;
    type: string;
    methods: RenameNavigationReactMethods;
    eventPhase: number;
    bubbles: boolean;
    cancelable: boolean;
    defaultPrevented: false;
    isTrusted: true;
    timeStamp: number;
    key: TokenRenameNavigationKey;
    code: string;
    location: number;
    charCode: number;
    keyCode: number;
    repeat: false;
    altKey: false;
    ctrlKey: false;
    metaKey: false;
    shiftKey: false;
    detail: number;
    view: unknown;
  }>;
  type RenameNavigationTerminalProof = Readonly<{
    publication: RenameNavigationPublication;
    event: KeyboardEvent;
    receiver: EventTarget;
    currentTarget: EventTarget;
    terminal: EventTarget;
    eventPhase: number;
  }>;
  type RenameNavigationNativeSnapshot = Readonly<{
    event: KeyboardEvent;
    type: string;
    target: HTMLButtonElement;
    path: readonly EventTarget[];
    bubbles: true;
    cancelable: true;
    defaultPrevented: false;
    cancelBubble: false;
    composed: true;
    timeStamp: number;
    key: TokenRenameNavigationKey;
    code: string;
    location: number;
    charCode: number;
    keyCode: number;
    repeat: false;
    isComposing: false;
    ctrlKey: false;
    altKey: false;
    metaKey: false;
    shiftKey: false;
    view: Window | EventTarget | null;
    detail: number;
    trusted: true;
    terminal: RenameNavigationTerminalProof;
  }>;
  interface RenameNavigationPublication {
    readonly identity: symbol;
    readonly target: Window & typeof globalThis;
    readonly listener: EventListener;
    readonly add: EventTarget["addEventListener"];
    readonly remove: EventTarget["removeEventListener"];
    readonly capture: true;
    current: WeakMap<KeyboardEvent, PendingRenameNavigation> | null;
    seen: WeakSet<Event> | null;
    attached: boolean;
    publicCallActive: boolean;
    retired: boolean;
  }
  interface RenameEscapeAuthority {
    readonly identity: symbol;
    readonly mount: symbol;
    readonly panel: TokenPanelAuthority;
    readonly candidate: RowCandidate;
    readonly commit: RowCommit;
    readonly visit: RenameVisit;
    readonly token: TokenSnapshot;
    readonly persistedName: string;
    readonly draft: string;
    readonly callback: RowFacts["onAction"];
    readonly update: typeof api.tokens.update;
    readonly input: HTMLInputElement;
    readonly form: HTMLFormElement;
    readonly controls: readonly RenameNavigationControl[];
    readonly ownerDocument: Document;
    readonly keyboard: TokenRenameKeyboardAuthority;
    readonly dom: SecretNoticeDomSnapshot;
    readonly placement: readonly SecretNoticePlacement[];
    readonly history: TokenRenameMutationHistory;
    readonly navigation: RenameNavigationPublication;
    readonly escape: RenameEscapePublication;
    claimed: boolean;
    retired: boolean;
  }
  type RenameEscapeReactEvent = ReactKeyboardEvent<HTMLInputElement | HTMLFormElement>;
  type RenameEscapeReactProof = Readonly<{
    event: RenameEscapeReactEvent;
    nativeEvent: KeyboardEvent;
    target: HTMLInputElement;
    currentTarget: HTMLInputElement | HTMLFormElement;
    nativeCurrentTarget: EventTarget;
    eventPhase: number;
    values: Readonly<Record<string, unknown>>;
    methods: RenameNavigationReactMethods;
  }>;
  type RenameEscapeNativeProof = Readonly<{
    event: KeyboardEvent;
    receiver: EventTarget;
    currentTarget: EventTarget;
    terminal: EventTarget;
    path: readonly EventTarget[];
    values: Readonly<Record<string, unknown>>;
  }>;
  interface RenameEscapePublication {
    readonly target: Window & typeof globalThis;
    readonly listener: EventListener;
    readonly add: EventTarget["addEventListener"];
    readonly remove: EventTarget["removeEventListener"];
    current: WeakMap<KeyboardEvent, PendingRenameEscape> | null;
    wrappers: WeakMap<object, RenameEscapeReactProof> | null;
    inputDeliveries: WeakSet<KeyboardEvent> | null;
    retiredEvents: WeakSet<KeyboardEvent> | null;
    claimedEvents: WeakSet<KeyboardEvent> | null;
    attached: boolean;
  }
  type PendingRenameEscape = Readonly<{
    authority: RenameEscapeAuthority;
    publication: RenameEscapePublication;
    native: RenameEscapeNativeProof;
    capture: RenameEscapeReactProof | null;
  }>;
  type PendingRenameNavigation = Readonly<{
    authority: RenameEscapeAuthority;
    publication: RenameNavigationPublication;
    reactCapture: RenameNavigationReactProof | null;
    reactBubble: RenameNavigationReactProof | null;
    native: RenameNavigationNativeSnapshot;
    terminal: RenameNavigationTerminalProof;
    source: RenameNavigationControl;
    destination: RenameNavigationControl;
    movement: object;
    replayed: boolean;
  }>;
  type ClaimedRenameNavigation = Readonly<{
    pair: PendingRenameNavigation;
    authority: RenameEscapeAuthority;
    publication: RenameNavigationPublication;
    native: RenameNavigationNativeSnapshot;
    terminal: RenameNavigationTerminalProof;
    capture: RenameNavigationReactProof;
    bubble: RenameNavigationReactProof;
    visit: RenameVisit;
    token: TokenSnapshot;
    draft: string;
    callback: RowFacts["onAction"];
    controls: readonly RenameNavigationControl[];
    source: RenameNavigationControl;
    destination: RenameNavigationControl;
    movement: object;
  }>;
  type RenameRefExpectation = Readonly<{
    role: RenameRefRole;
    ownerIdentity: symbol;
    element: HTMLElement;
  }>;
  interface RenameRefReplay {
    readonly identity: symbol;
    readonly candidate: RowCandidate;
    readonly expected: readonly RenameRefExpectation[];
    readonly released: Set<HTMLElement>;
    readonly rebound: Set<HTMLElement>;
    successor: RowCandidate | null;
    layoutRetired: boolean;
    invalid: boolean;
  }
  type CompletedRenameRefReplay = Readonly<{
    identity: symbol;
    replayIdentity: symbol;
    source: RowCandidate;
    target: RowCandidate;
    bindings: readonly RenameRefExpectation[];
  }>;
  type CompletedRenameRefReplayResult = "none" | "matched" | "mismatched";
  type SaveOwner = Readonly<{
    mount: symbol;
    visit: RenameVisit;
    token: ApiTokenDto;
    callback: RowFacts["onAction"];
    name: string;
    commit: RowCommit;
  }>;
  type FocusIntent = Readonly<{ mount: symbol; visit: RenameVisit; tokenId: string; preventScroll: boolean }>;
  type InputOverride = Readonly<{ input: HTMLInputElement; value: string }>;
  type ControlledInputUpdate = Readonly<{
    commit: RowCommit;
    visit: RenameVisit;
    input: HTMLInputElement;
    value: string;
  }>;

  const slot = <T extends HTMLElement>(role: RowElementRole): ElementSlot<T> => ({
    identity: Symbol(`token-row-${role}-slot`),
    role,
    element: null,
  });
  const [mount] = useState(() => Symbol("token-row-mount"));
  const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null);
  const activeMount = useRef<symbol | null>(null);
  const activeCommit = useRef<RowCommit | null>(null);
  const activeRowNavigation = useRef<RowNavigationAuthority | null>(null);
  const rowNavigationDelivery = useRef<RowNavigationDelivery | null>(null);
  const attemptedRowReactEvents = useRef(new WeakSet<object>());
  const attemptedRowNativeEvents = useRef(new WeakSet<object>());
  const claimedRowDeliveries = useRef(new WeakSet<object>());
  const claimedRowPairs = useRef(new WeakSet<object>());
  const claimedRowMovements = useRef(new WeakSet<object>());
  const claimedRowCommits = useRef(new WeakSet<object>());
  const claimedRowActionSets = useRef(new WeakSet<object>());
  const claimedRowMovementClaims = useRef(new WeakSet<object>());
  const claimedRowWrapperClaims = useRef(new WeakSet<object>());
  const claimedRowNativeClaims = useRef(new WeakSet<object>());
  const claimedRowWindowClaims = useRef(new WeakSet<object>());
  const claimedRowSourceClaims = useRef(new WeakSet<object>());
  const claimedRowDestinationClaims = useRef(new WeakSet<object>());
  const claimedRowReactEvents = useRef(new WeakSet<object>());
  const claimedRowNativeEvents = useRef(new WeakSet<object>());
  const claimedRowTerminalProofs = useRef(new WeakSet<object>());
  const claimedEvents = useRef(new WeakSet<object>());
  const consumedCommits = useRef(new WeakSet<RowCommit>());
  const dispatchingCommits = useRef(new WeakSet<RowCommit>());
  const activeRenameEscape = useRef<RenameEscapeAuthority | null>(null);
  const renameEscapeRouteActive = useRef(false);
  const claimedRenameReactEvents = useRef(new WeakSet<object>());
  const claimedRenameNativeEvents = useRef(new WeakSet<Event>());
  const claimedRenameNavigationPairs = useRef(new WeakSet<PendingRenameNavigation>());
  const claimedRenameNavigationMovements = useRef(new WeakSet<object>());
  const claimedRenameTerminalProofs = useRef(new WeakSet<RenameNavigationTerminalProof>());
  const renameNavigationInProgress = useRef<ClaimedRenameNavigation | null>(null);
  const partialRenameRefElements = useRef(new WeakSet<HTMLElement>());
  const renameRefReplay = useRef<RenameRefReplay | null>(null);
  const completedRenameRefReplay = useRef<CompletedRenameRefReplay | null>(null);
  const controlledInputUpdate = useRef<ControlledInputUpdate | null>(null);
  const saveOwner = useRef<SaveOwner | null>(null);
  const returnFocus = useRef<FocusIntent | null>(null);
  const focusedRename = useRef<{ visit: RenameVisit; input: HTMLInputElement } | null>(null);
  const focusedMatch = useRef<HTMLLIElement | null>(null);
  const state = tokenState(t);
  const mismatch = Boolean(documentId && t.documentIds !== null && !t.documentIds.includes(documentId));
  const token = Object.freeze<TokenSnapshot>({
    source: t,
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scope: t.scope,
    documentIdsSource: t.documentIds,
    documentIds: t.documentIds ? Object.freeze([...t.documentIds]) : null,
    collaboratorsMayAsk: t.collaboratorsMayAsk,
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
    lastMcpSeenAt: t.lastMcpSeenAt,
    lastMcpCallAt: t.lastMcpCallAt,
    expiresAt: t.expiresAt,
    revokedAt: t.revokedAt,
  });
  const action = (kind: RowActionKind, eligible: boolean) => Object.freeze<RowActionFacts>({ kind, eligible });
  const actionsVisible = !t.revokedAt;
  const facts = Object.freeze<RowFacts>({
    identity: Symbol("token-row-presentation"),
    mount,
    panel,
    token,
    documentId,
    matching,
    disabled,
    replacementDisabled,
    onAction,
    onCollaboratorsChange,
    switchError,
    renameVisit: renameDraft?.visit ?? null,
    draft: renameDraft?.value ?? null,
    state,
    mismatch,
    actionsVisible,
    documentCount: t.documentIds?.length
      ? `${t.documentIds.length} ${t.documentIds.length === 1 ? "document" : "documents"}`
      : "all documents",
    metadata: `Created ${relativeTime(t.createdAt)}${t.lastUsedAt ? ` · used ${relativeTime(t.lastUsedAt)}` : " · no recorded use"}${t.expiresAt ? ` · expires ${relativeTime(t.expiresAt)}` : " · no expiry"}`,
    mismatchText: mismatch
      ? "This token is scoped to other documents, not this one. Replacement keeps that restriction. Create a differently named token for this document."
      : null,
    expiredText: state === "Expired" ? "Create a new token to choose a new expiry." : null,
    prefixDetails: `Prefix: ${t.prefix}…`,
    timeDetails: `Created: ${t.createdAt}. Last used: ${t.lastUsedAt ?? "not recorded"}.`,
    mcpDetails: `Last MCP discovery: ${t.lastMcpSeenAt ?? "not recorded"}. Last MCP tool call: ${t.lastMcpCallAt ?? "not recorded"}.`,
    revokedDetails: t.revokedAt ? `Revoked: ${t.revokedAt}` : null,
    documentDetails: t.documentIds ? `Document IDs: ${t.documentIds.join(", ")}` : null,
    renameLabel: `Rename ${t.name}`,
    replaceLabel: `Replace ${t.name}`,
    revokeLabel: `Revoke ${t.name}`,
    actionsLabel: `${t.name} token actions`,
    switchLabelId: `token-${t.id}-may-ask-label`,
    switchHelpId: `token-${t.id}-may-ask-help`,
    rowClassName: cn("flex min-w-0 flex-col gap-2 p-3", matching && "ring-2 ring-inset ring-accent"),
    rename: actionsVisible ? action("rename", !disabled) : null,
    replace: actionsVisible ? action("replace", !disabled && !replacementDisabled && state === "Active") : null,
    revoke: actionsVisible ? action("revoke", !disabled) : null,
    cancel: renameDraft ? action("cancel", !disabled) : null,
    save: renameDraft ? action("save", !disabled && Boolean(renameDraft.value.trim())) : null,
    inputEligible: Boolean(renameDraft) && !disabled,
  });
  const candidate: RowCandidate = Object.freeze({
    facts,
    row: slot<HTMLLIElement>("row"),
    header: slot<HTMLDivElement>("header"),
    metadata: slot<HTMLParagraphElement>("metadata"),
    mismatch: slot<HTMLParagraphElement>("mismatch"),
    expired: slot<HTMLParagraphElement>("expired"),
    actions: slot<HTMLDivElement>("actions"),
    rename: slot<HTMLButtonElement>("rename"),
    replace: slot<HTMLButtonElement>("replace"),
    revoke: slot<HTMLButtonElement>("revoke"),
    form: slot<HTMLFormElement>("form"),
    input: slot<HTMLInputElement>("input"),
    save: slot<HTMLButtonElement>("save"),
    cancel: slot<HTMLButtonElement>("cancel"),
    details: slot<HTMLDetailsElement>("details"),
    detailsBody: slot<HTMLDivElement>("detailsBody"),
    collaborators: slot<HTMLButtonElement>("collaborators"),
    switchError: slot<HTMLParagraphElement>("switchError"),
  });

  const retireRowNavigation = (authority: RowNavigationAuthority) => {
    authority.publication.current = null;
    if (!authority.retired) {
      authority.retired = true;
      authority.terminal.release();
      authority.history.disconnect();
    }
    if (activeRowNavigation.current === authority) {
      activeRowNavigation.current = null;
    }
    if (rowNavigationDelivery.current?.pair.authority === authority) {
      rowNavigationDelivery.current = null;
    }
  };
  const retireRenameEscape = (authority: RenameEscapeAuthority) => {
    const escape = authority.escape;
    escape.current = null;
    escape.wrappers = null;
    escape.inputDeliveries = null;
    escape.retiredEvents = null;
    escape.claimedEvents = null;
    if (escape.attached) {
      escape.attached = false;
      authority.keyboard.apply(
        escape.remove,
        escape.target,
        ["keydown", escape.listener, true],
      );
    }
    if (!authority.retired) {
      authority.retired = true;
      const navigation = authority.navigation;
      navigation.retired = true;
      navigation.current = null;
      navigation.seen = null;
      navigation.publicCallActive = false;
      if (navigation.attached) {
        authority.keyboard.apply(
          navigation.remove,
          navigation.target,
          ["keydown", navigation.listener, navigation.capture],
        );
        navigation.attached = false;
      }
      authority.history.disconnect();
    }
    if (activeRenameEscape.current === authority) activeRenameEscape.current = null;
    if (renameNavigationInProgress.current?.authority === authority) {
      renameNavigationInProgress.current = null;
    }
  };
  const retireCandidate = (value: RowCandidate) => {
    const commit = activeCommit.current;
    if (commit?.candidate !== value) return;
    const rowNavigation = activeRowNavigation.current;
    if (rowNavigation?.commit === commit) retireRowNavigation(rowNavigation);
    const renameEscape = activeRenameEscape.current;
    if (renameEscape?.commit === commit) retireRenameEscape(renameEscape);
    activeCommit.current = null;
  };
  const renameRefReplayComplete = (replay: RenameRefReplay) =>
    replay.expected.length === 5
    && replay.expected.every(({ element }) =>
      replay.released.has(element) && replay.rebound.has(element));
  const renameRefExpectation = (
    role: RenameRefRole,
    owner: Readonly<Pick<ElementSlot<HTMLElement>, "identity">>,
    element: HTMLElement | null,
  ): RenameRefExpectation | null => element
    ? Object.freeze({ role, ownerIdentity: owner.identity, element })
    : null;
  const quarantineRenameRefReplay = (replay: RenameRefReplay) => {
    replay.invalid = true;
    for (const { element } of replay.expected) {
      partialRenameRefElements.current.add(element);
    }
    if (renameRefReplay.current?.identity === replay.identity) {
      renameRefReplay.current = null;
    }
  };
  const quarantineCompletedRenameRefReplay = (completion: CompletedRenameRefReplay) => {
    for (const { element } of completion.bindings) {
      partialRenameRefElements.current.add(element);
    }
    if (completedRenameRefReplay.current?.identity === completion.identity) {
      completedRenameRefReplay.current = null;
    }
  };
  const completeRenameRefReplay = (replay: RenameRefReplay) => {
    const target = replay.successor ?? replay.candidate;
    const bindings = replay.expected.map(({ role, element }) =>
      renameRefExpectation(role, target[role], element))
      .filter((binding): binding is RenameRefExpectation => binding !== null);
    if (
      replay.invalid
      || !replay.layoutRetired
      || !renameRefReplayComplete(replay)
      || bindings.length !== replay.expected.length
      || replay.expected.some(({ role, element }) => target[role].element !== element)
    ) {
      quarantineRenameRefReplay(replay);
      return;
    }
    const completion = Object.freeze<CompletedRenameRefReplay>({
      identity: Symbol("completed-token-rename-ref-replay"),
      replayIdentity: replay.identity,
      source: replay.candidate,
      target,
      bindings: Object.freeze(bindings),
    });
    renameRefReplay.current = null;
    completedRenameRefReplay.current = completion;
    queueMicrotask(() => {
      if (completedRenameRefReplay.current?.identity === completion.identity) {
        quarantineCompletedRenameRefReplay(completion);
      }
    });
  };
  const consumeCompletedRenameRefReplay = (
    value: RowCandidate,
  ): CompletedRenameRefReplayResult => {
    const completion = completedRenameRefReplay.current;
    if (!completion) return "none";
    const exact = completion.target === value
      && completion.bindings.length === 5
      && completion.bindings.every(({ role, ownerIdentity, element }) =>
        value[role].identity === ownerIdentity && value[role].element === element);
    completedRenameRefReplay.current = null;
    if (!exact) {
      for (const { element } of completion.bindings) {
        partialRenameRefElements.current.add(element);
      }
    }
    return exact ? "matched" : "mismatched";
  };
  const bindElement = <T extends HTMLElement>(owner: ElementSlot<T>, element: T | null) => {
    const previous = owner.element;
    const renameEscape = activeRenameEscape.current;
    let replay = renameRefReplay.current;
    if (!element && previous && !replay && renameEscape?.candidate === candidate) {
      const expected = [
        renameRefExpectation("row", candidate.row, renameEscape.commit.row),
        renameRefExpectation("form", candidate.form, renameEscape.form),
        renameRefExpectation("input", candidate.input, renameEscape.input),
        renameRefExpectation("save", candidate.save, renameEscape.commit.save),
        renameRefExpectation("cancel", candidate.cancel, renameEscape.commit.cancel),
      ].filter((entry): entry is RenameRefExpectation => entry !== null);
      replay = {
        identity: Symbol("token-rename-ref-replay"),
        candidate,
        expected: Object.freeze(expected),
        released: new Set(),
        rebound: new Set(),
        successor: null,
        layoutRetired: false,
        invalid: expected.length !== 5,
      };
      renameRefReplay.current = replay;
      const replayIdentity = replay.identity;
      queueMicrotask(() => {
        const current = renameRefReplay.current;
        if (current?.identity !== replayIdentity) return;
        quarantineRenameRefReplay(current);
      });
    }
    const expectedRole = replay?.expected.find(({ role }) => role === owner.role);
    const expectedElement = replay?.expected.find((entry) => entry.element === (element ?? previous));
    if (!element && previous && (expectedRole || expectedElement)) {
      if (
        !replay
        || replay.candidate !== candidate
        || !expectedRole
        || expectedRole.ownerIdentity !== owner.identity
        || expectedRole.element !== previous
        || expectedElement !== expectedRole
        || replay.released.has(previous)
        || replay.rebound.has(previous)
      ) {
        if (replay) replay.invalid = true;
      } else {
        replay.released.add(previous);
      }
    }
    if (owner.element !== element) retireCandidate(candidate);
    owner.element = element;
    if (!element) {
      retireCandidate(candidate);
      if (replay?.invalid) quarantineRenameRefReplay(replay);
      return;
    }
    replay = renameRefReplay.current;
    const reboundRole = replay?.expected.find(({ role }) => role === owner.role);
    const reboundElement = replay?.expected.find((entry) => entry.element === element);
    if (replay && (reboundRole || reboundElement)) {
      if (candidate !== replay.candidate) {
        if (!replay.successor) replay.successor = candidate;
        else if (replay.successor !== candidate) replay.invalid = true;
      }
      if (
        (candidate !== replay.candidate && candidate !== replay.successor)
        || !reboundRole
        || reboundRole.element !== element
        || reboundElement !== reboundRole
        || (candidate === replay.candidate
          ? reboundRole.ownerIdentity !== owner.identity
          : candidate[reboundRole.role].identity !== owner.identity)
        || !replay.released.has(reboundRole.element)
        || replay.rebound.has(element)
      ) {
        replay.invalid = true;
      } else {
        replay.rebound.add(element);
      }
      if (replay.invalid) {
        quarantineRenameRefReplay(replay);
      } else if (replay.layoutRetired && renameRefReplayComplete(replay)) {
        completeRenameRefReplay(replay);
      }
    }
  };
  const nodesBelow = (root: Node): readonly Node[] => {
    const nodes: Node[] = [];
    const append = (node: Node) => {
      nodes.push(node);
      for (const child of node.childNodes) append(child);
    };
    append(root);
    return Object.freeze(nodes);
  };
  const arraysMatch = <T,>(current: readonly T[], frozen: readonly T[]) =>
    current.length === frozen.length && current.every((value, index) => value === frozen[index]);
  const tokenMatches = (snapshot: TokenSnapshot) =>
    t === snapshot.source
    && t.id === snapshot.id
    && t.name === snapshot.name
    && t.prefix === snapshot.prefix
    && t.scope === snapshot.scope
    && t.documentIds === snapshot.documentIdsSource
    && (t.documentIds
      ? snapshot.documentIds !== null && arraysMatch(t.documentIds, snapshot.documentIds)
      : snapshot.documentIds === null)
    && t.collaboratorsMayAsk === snapshot.collaboratorsMayAsk
    && t.createdAt === snapshot.createdAt
    && t.lastUsedAt === snapshot.lastUsedAt
    && t.lastMcpSeenAt === snapshot.lastMcpSeenAt
    && t.lastMcpCallAt === snapshot.lastMcpCallAt
    && t.expiresAt === snapshot.expiresAt
    && t.revokedAt === snapshot.revokedAt;
  const factsAreCurrent = (snapshot: RowFacts) =>
    activeMount.current === snapshot.mount
    && snapshot.mount === mount
    && panel === snapshot.panel
    && Object.isFrozen(snapshot.panel)
    && snapshot.panel.session === panel.session
    && snapshot.panel.update === api.tokens.update
    && tokenMatches(snapshot.token)
    && documentId === snapshot.documentId
    && matching === snapshot.matching
    && disabled === snapshot.disabled
    && replacementDisabled === snapshot.replacementDisabled
    && onAction === snapshot.onAction
    && onCollaboratorsChange === snapshot.onCollaboratorsChange
    && switchError === snapshot.switchError
    && (renameDraft?.visit ?? null) === snapshot.renameVisit
    && (renameDraft?.value ?? null) === snapshot.draft
    && tokenState(t) === snapshot.state
    && mismatch === snapshot.mismatch;
  const buttonIsExact = (
    button: HTMLButtonElement,
    commit: RowCommit,
    type: "button" | "submit",
    label: string,
    eligible: boolean,
  ) =>
    button.ownerDocument === commit.ownerDocument
    && button.isConnected
    && button.type === type
    && button.disabled === !eligible
    && button.getAttribute("aria-disabled") !== "true"
    && button.textContent?.trim() === label;
  const domIsExact = (commit: RowCommit, override?: InputOverride) => {
    const value = commit.facts;
    const ownerWindow = commit.ownerDocument.defaultView;
    if (
      !ownerWindow
      || !commit.row.isConnected
      || commit.row.ownerDocument !== commit.ownerDocument
      || commit.row.parentElement !== commit.parent
      || !arraysMatch(Array.from(commit.parent.children), commit.parentChildren)
      || !arraysMatch(nodesBelow(commit.row), commit.tree)
      || commit.row.tabIndex !== -1
      || commit.row.className !== value.rowClassName
      || commit.row.dataset.testid !== "token-row"
      || commit.row.getAttribute("data-token-match") !== (value.matching ? "true" : null)
      || !commit.header.isConnected
      || commit.header.parentElement !== commit.row
      || commit.header.className !== "flex min-w-0 flex-wrap items-center gap-2"
      || commit.header.children.length !== 4
      || commit.header.children.item(0)?.textContent !== value.token.name
      || commit.header.children.item(1)?.getAttribute("data-testid") !== "token-scope-chip"
      || commit.header.children.item(1)?.getAttribute("data-scope") !== value.token.scope
      || commit.header.children.item(1)?.getAttribute("title") !== `${TOKEN_SCOPE_LABEL[value.token.scope]}: ${TOKEN_SCOPE_SUMMARY[value.token.scope]}`
      || commit.header.children.item(1)?.textContent?.trim() !== value.token.scope
      || commit.header.children.item(2)?.textContent !== value.state
      || commit.header.children.item(3)?.getAttribute("data-testid") !== "token-documents-count"
      || commit.header.children.item(3)?.textContent !== value.documentCount
      || !commit.metadata.isConnected
      || commit.metadata.parentElement !== commit.row
      || commit.metadata.textContent !== value.metadata
    ) {
      return false;
    }

    const directChildren: Element[] = [commit.header, commit.metadata];
    if (value.mismatchText) {
      if (
        !commit.mismatch?.isConnected
        || commit.mismatch.parentElement !== commit.row
        || commit.mismatch.textContent !== value.mismatchText
      ) {
        return false;
      }
      directChildren.push(commit.mismatch);
    } else if (commit.mismatch) {
      return false;
    }
    if (value.expiredText) {
      if (
        !commit.expired?.isConnected
        || commit.expired.parentElement !== commit.row
        || commit.expired.textContent !== value.expiredText
      ) {
        return false;
      }
      directChildren.push(commit.expired);
    } else if (commit.expired) {
      return false;
    }

    if (value.actionsVisible) {
      if (
        !value.rename
        || !value.replace
        || !value.revoke
        || !commit.actions?.isConnected
        || commit.actions.parentElement !== commit.row
        || commit.actions.getAttribute("role") !== "group"
        || commit.actions.getAttribute("aria-label") !== value.actionsLabel
        || commit.actions.children.length !== 3
        || commit.actions.children.item(0) !== commit.rename
        || commit.actions.children.item(1) !== commit.replace
        || commit.actions.children.item(2) !== commit.revoke
        || !commit.rename
        || !commit.replace
        || !commit.revoke
        || !buttonIsExact(commit.rename, commit, "button", "Rename", value.rename.eligible)
        || commit.rename.getAttribute("aria-label") !== value.renameLabel
        || !buttonIsExact(commit.replace, commit, "button", "Replace", value.replace.eligible)
        || commit.replace.getAttribute("aria-label") !== value.replaceLabel
        || !buttonIsExact(commit.revoke, commit, "button", "Revoke", value.revoke.eligible)
        || commit.revoke.getAttribute("aria-label") !== value.revokeLabel
        || commit.revoke.dataset.testid !== "token-revoke"
      ) {
        return false;
      }
      directChildren.push(commit.actions);
    } else if (commit.actions || commit.rename || commit.replace || commit.revoke) {
      return false;
    }

    if (value.renameVisit) {
      const input = commit.input;
      const form = commit.form;
      const save = commit.save;
      const cancel = commit.cancel;
      const label = input?.parentElement;
      const guidance = label?.nextElementSibling;
      const buttons = guidance?.nextElementSibling;
      if (
        value.draft === null
        || !value.save
        || !value.cancel
        || !form?.isConnected
        || form.parentElement !== commit.row
        || form.children.length !== 3
        || form.children.item(0) !== label
        || form.children.item(1) !== guidance
        || form.children.item(2) !== buttons
        || label?.tagName !== "LABEL"
        || label.children.length !== 1
        || label.firstElementChild !== input
        || label.childNodes.item(0)?.textContent !== "Token name"
        || guidance?.textContent !== "This changes the agent name and @mention, not its secret or permissions."
        || buttons?.children.length !== 2
        || buttons.children.item(0) !== save
        || buttons.children.item(1) !== cancel
        || !input?.isConnected
        || input.ownerDocument !== commit.ownerDocument
        || input.form !== form
        || input.type !== "text"
        || input.maxLength !== 80
        || input.disabled !== !value.inputEligible
        || input.value !== (override?.input === input ? override.value : value.draft)
        || !save
        || !cancel
        || !buttonIsExact(save, commit, "submit", "Save name", value.save.eligible)
        || save.form !== form
        || !buttonIsExact(cancel, commit, "button", "Cancel rename", value.cancel.eligible)
        || cancel.form !== form
      ) {
        return false;
      }
      directChildren.push(form);
    } else if (commit.form || commit.input || commit.save || commit.cancel || value.draft !== null) {
      return false;
    }

    const summary = commit.details.firstElementChild;
    if (
      !commit.details.isConnected
      || commit.details.parentElement !== commit.row
      || commit.details.children.length !== 2
      || summary?.tagName !== "SUMMARY"
      || summary.textContent !== "Details & agent requests"
      || commit.details.lastElementChild !== commit.detailsBody
      || !commit.detailsBody.isConnected
      || commit.detailsBody.parentElement !== commit.details
    ) {
      return false;
    }
    const detailChildren: Element[] = [];
    const takeDetail = (text: string) => {
      const element = commit.detailsBody.children.item(detailChildren.length);
      if (element?.tagName !== "P" || element.textContent !== text) return false;
      detailChildren.push(element);
      return true;
    };
    if (
      !takeDetail(value.prefixDetails)
      || !takeDetail(value.timeDetails)
      || !takeDetail(value.mcpDetails)
      || (value.revokedDetails ? !takeDetail(value.revokedDetails) : false)
      || (value.documentDetails ? !takeDetail(value.documentDetails) : false)
    ) {
      return false;
    }
    if (value.actionsVisible) {
      const switchContainer = commit.detailsBody.children.item(detailChildren.length);
      const copy = switchContainer?.lastElementChild;
      if (
        !commit.collaborators?.isConnected
        || switchContainer?.children.length !== 2
        || switchContainer.firstElementChild !== commit.collaborators
        || commit.collaborators.parentElement !== switchContainer
        || commit.collaborators.type !== "button"
        || commit.collaborators.getAttribute("role") !== "switch"
        || commit.collaborators.getAttribute("aria-checked") !== String(value.token.collaboratorsMayAsk)
        || commit.collaborators.getAttribute("aria-labelledby") !== value.switchLabelId
        || commit.collaborators.getAttribute("aria-describedby") !== value.switchHelpId
        || commit.collaborators.disabled !== value.disabled
        || commit.collaborators.dataset.testid !== "token-collaborators-may-ask"
        || copy?.children.length !== 2
        || copy.children.item(0)?.id !== value.switchLabelId
        || copy.children.item(0)?.textContent !== "Collaborators may ask this agent"
        || copy.children.item(1)?.id !== value.switchHelpId
        || copy.children.item(1)?.textContent !== "Off: only you can send requests to it. On: people you share documents with can too."
      ) {
        return false;
      }
      detailChildren.push(switchContainer);
    } else if (commit.collaborators) {
      return false;
    }
    if (commit.detailsBody.children.length !== detailChildren.length) return false;
    directChildren.push(commit.details);

    if (value.switchError) {
      if (
        !commit.switchError?.isConnected
        || commit.switchError.parentElement !== commit.row
        || commit.switchError.getAttribute("role") !== "alert"
        || commit.switchError.getAttribute("aria-atomic") !== "true"
        || commit.switchError.dataset.testid !== "token-collaborators-may-ask-error"
        || commit.switchError.textContent !== value.switchError
      ) {
        return false;
      }
      directChildren.push(commit.switchError);
    } else if (commit.switchError) {
      return false;
    }
    return commit.row.children.length === directChildren.length
      && directChildren.every((element, index) => commit.row.children.item(index) === element);
  };
  const buildCommit = (): RowCommit | null => {
    const row = candidate.row.element;
    const header = candidate.header.element;
    const metadata = candidate.metadata.element;
    const details = candidate.details.element;
    const detailsBody = candidate.detailsBody.element;
    const parent = row?.parentElement;
    const ownerWindow = row?.ownerDocument.defaultView;
    if (
      !row
      || !header
      || !metadata
      || !details
      || !detailsBody
      || !ownerWindow?.HTMLUListElement
      || !(parent instanceof ownerWindow.HTMLUListElement)
    ) {
      return null;
    }
    const commit = Object.freeze<RowCommit>({
      candidate,
      facts,
      ownerDocument: row.ownerDocument,
      parent,
      parentChildren: Object.freeze(Array.from(parent.children)),
      tree: nodesBelow(row),
      row,
      header,
      metadata,
      mismatch: candidate.mismatch.element,
      expired: candidate.expired.element,
      actions: candidate.actions.element,
      rename: candidate.rename.element,
      replace: candidate.replace.element,
      revoke: candidate.revoke.element,
      form: candidate.form.element,
      input: candidate.input.element,
      save: candidate.save.element,
      cancel: candidate.cancel.element,
      details,
      detailsBody,
      collaborators: candidate.collaborators.element,
      switchError: candidate.switchError.element,
      renameTargets: candidate.rename.element ? nodesBelow(candidate.rename.element) : null,
      replaceTargets: candidate.replace.element ? nodesBelow(candidate.replace.element) : null,
      revokeTargets: candidate.revoke.element ? nodesBelow(candidate.revoke.element) : null,
      cancelTargets: candidate.cancel.element ? nodesBelow(candidate.cancel.element) : null,
    });
    return domIsExact(commit) ? commit : null;
  };
  const currentCommit = (value: RowCandidate, override?: InputOverride) => {
    const commit = activeCommit.current;
    return commit?.candidate === value
      && commit.facts === value.facts
      && factsAreCurrent(commit.facts)
      && domIsExact(commit, override)
      ? commit
      : null;
  };
  const readRenameNavigationReactProof = (
    event: RenameNavigationReactEvent,
    pair: PendingRenameNavigation,
    expectedPhase: number,
  ): RenameNavigationReactProof | null => {
    const { authority, native } = pair;
    try {
      const nativeEvent = event.nativeEvent;
      const currentTarget = event.currentTarget;
      const target = event.target;
      const preventDefault = event.preventDefault as RenameNavigationReactMethod;
      const isDefaultPrevented = event.isDefaultPrevented as RenameNavigationReactMethod;
      const isPropagationStopped = event.isPropagationStopped as RenameNavigationReactMethod;
      const proof = Object.freeze<RenameNavigationReactProof>({
        event,
        nativeEvent,
        currentTarget,
        target: target as HTMLButtonElement,
        type: event.type,
        methods: Object.freeze({
          preventDefault,
          isDefaultPrevented,
          isPropagationStopped,
        }),
        eventPhase: event.eventPhase,
        bubbles: event.bubbles,
        cancelable: event.cancelable,
        defaultPrevented: false,
        isTrusted: event.isTrusted as true,
        timeStamp: event.timeStamp,
        key: event.key as TokenRenameNavigationKey,
        code: event.code,
        location: event.location,
        charCode: event.charCode,
        keyCode: event.keyCode,
        repeat: event.repeat as false,
        altKey: event.altKey as false,
        ctrlKey: event.ctrlKey as false,
        metaKey: event.metaKey as false,
        shiftKey: event.shiftKey as false,
        detail: event.detail,
        view: event.view,
      });
      if (
        event === (nativeEvent as unknown)
        || nativeEvent !== native.event
        || currentTarget !== authority.form
        || target !== native.target
        || proof.type !== native.type
        || proof.eventPhase !== expectedPhase
        || proof.bubbles !== native.bubbles
        || proof.cancelable !== native.cancelable
        || event.defaultPrevented !== false
        || proof.isTrusted !== native.trusted
        || proof.timeStamp !== native.timeStamp
        || proof.key !== native.key
        || proof.code !== native.code
        || proof.location !== native.location
        || proof.charCode !== native.charCode
        || proof.keyCode !== native.keyCode
        || proof.repeat !== native.repeat
        || proof.altKey !== native.altKey
        || proof.ctrlKey !== native.ctrlKey
        || proof.metaKey !== native.metaKey
        || proof.shiftKey !== native.shiftKey
        || proof.detail !== native.detail
        || !Object.is(proof.view, native.view)
        || typeof preventDefault !== "function"
        || typeof isDefaultPrevented !== "function"
        || typeof isPropagationStopped !== "function"
      ) {
        return null;
      }
      return proof;
    } catch {
      return null;
    }
  };
  const rowNavigationControlIsCurrent = (
    authority: RowNavigationAuthority,
    control: RowNavigationControl,
  ) => {
    const owner = authority.candidate[control.role];
    const element = authority.commit[control.role];
    const action = authority.commit.facts[control.role];
    return authority.controls[control.index] === control
      && control.ownerIdentity === owner.identity
      && control.action === action
      && control.action.eligible
      && control.element === element
      && owner.element === element
      && element?.ownerDocument === authority.ownerDocument
      && element.parentElement === authority.group
      && authority.group.children.item(control.order) === element
      && !element.disabled
      && element.getAttribute("aria-disabled") !== "true";
  };
  const rowNavigationAuthorityIsCurrent = (authority: RowNavigationAuthority) => {
    const commit = currentCommit(authority.candidate);
    if (
      activeRowNavigation.current !== authority
      || authority.retired
      || authority.mount !== mount
      || authority.panel !== panel
      || authority.panel !== authority.commit.facts.panel
      || !Object.isFrozen(authority.panel)
      || authority.panel.update !== api.tokens.update
      || authority.candidate !== candidate
      || commit !== authority.commit
      || commit.facts.token !== authority.token
      || commit.facts.onAction !== authority.callback
      || commit.actions !== authority.group
      || authority.group.ownerDocument !== authority.ownerDocument
      || authority.ownerDocument.defaultView !== authority.keyboard.ownerWindow
      || !Object.isFrozen(authority.controls)
      || authority.controls.length === 0
      || !authority.publication.current
      || !authority.keyboard.isCurrent()
      || !authority.terminal.isCurrent()
      || !authority.history.isPristine()
      || !secretNoticeDomMatches(authority.dom)
      || !secretNoticePlacementMatches(
        commit.row,
        authority.ownerDocument,
        authority.placement,
      )
      || !domIsExact(commit)
    ) {
      return false;
    }
    const enabled = ([
      ["rename", 0],
      ["replace", 1],
      ["revoke", 2],
    ] as const).filter(([role]) => commit.facts[role]?.eligible);
    return authority.controls.length === enabled.length
      && authority.controls.every((control, index) => {
        const expected = enabled[index];
        return Boolean(
          expected
          && control.role === expected[0]
          && control.order === expected[1]
          && control.index === index
          && Object.isFrozen(control)
          && rowNavigationControlIsCurrent(authority, control),
        );
      })
      && new Set(authority.controls.map(({ element }) => element)).size
        === authority.controls.length;
  };
  const rowNavigationDestination = (
    authority: RowNavigationAuthority,
    source: RowNavigationControl,
    key: TokenRenameNavigationKey,
  ) => {
    if (!rowNavigationControlIsCurrent(authority, source)) return null;
    let destinationIndex: number | null = null;
    if (
      (key === "ArrowLeft" || key === "ArrowUp")
      && source.index > 0
    ) {
      destinationIndex = source.index - 1;
    } else if (
      (key === "ArrowRight" || key === "ArrowDown")
      && source.index + 1 < authority.controls.length
    ) {
      destinationIndex = source.index + 1;
    } else if (key === "Home" && source.index !== 0) {
      destinationIndex = 0;
    } else if (
      key === "End"
      && source.index !== authority.controls.length - 1
    ) {
      destinationIndex = authority.controls.length - 1;
    }
    const destination = destinationIndex === null
      ? null
      : authority.controls[destinationIndex] ?? null;
    return destination && rowNavigationControlIsCurrent(authority, destination)
      ? destination
      : null;
  };
  const rowMovementIsCurrent = (
    authority: RowNavigationAuthority,
    source: RowNavigationControl,
    destination: RowNavigationControl,
    key: TokenRenameNavigationKey,
  ) => {
    try {
      return rowNavigationDelivery.current === null
        && rowNavigationAuthorityIsCurrent(authority)
        && source !== destination
        && rowNavigationDestination(authority, source, key) === destination
        && authority.keyboard.apply(
          authority.keyboard.activeElement,
          authority.ownerDocument,
          [],
        ) === source.element;
    } catch {
      return false;
    }
  };
  const captureRowNavigationNative = (
    authority: RowNavigationAuthority,
    event: Event,
    expectedPhase: number,
  ): RowNavigationNativeSnapshot | null => {
    if (
      !rowNavigationAuthorityIsCurrent(authority)
      || authority.keyboard.prototypeOf(event)
        !== authority.keyboard.KeyboardEvent.prototype
      || !authority.keyboard.trusted.matches(event)
    ) {
      return null;
    }
    try {
      const native = authority.keyboard;
      const type = tokenRenameNativeValue<string>(native, native.event.type, event);
      const target = tokenRenameNativeValue<EventTarget | null>(
        native,
        native.event.target,
        event,
      );
      const currentTarget = tokenRenameNativeValue<EventTarget | null>(
        native,
        native.event.currentTarget,
        event,
      );
      const phase = tokenRenameNativeValue<number>(
        native,
        native.event.eventPhase,
        event,
      );
      const bubbles = tokenRenameNativeValue<boolean>(
        native,
        native.event.bubbles,
        event,
      );
      const cancelable = tokenRenameNativeValue<boolean>(
        native,
        native.event.cancelable,
        event,
      );
      const defaultPrevented = tokenRenameNativeValue<boolean>(
        native,
        native.event.defaultPrevented,
        event,
      );
      const cancelBubble = tokenRenameNativeValue<boolean>(
        native,
        native.event.cancelBubble,
        event,
      );
      const composed = tokenRenameNativeValue<boolean>(
        native,
        native.event.composed,
        event,
      );
      const key = tokenRenameNativeValue<string>(
        native,
        native.keyboard.key,
        event,
      );
      const code = tokenRenameNativeValue<string>(
        native,
        native.keyboard.code,
        event,
      );
      const location = tokenRenameNativeValue<number>(
        native,
        native.keyboard.location,
        event,
      );
      const repeat = tokenRenameNativeValue<boolean>(
        native,
        native.keyboard.repeat,
        event,
      );
      const composing = tokenRenameNativeValue<boolean>(
        native,
        native.keyboard.isComposing,
        event,
      );
      const ctrlKey = tokenRenameNativeValue<boolean>(
        native,
        native.keyboard.ctrlKey,
        event,
      );
      const altKey = tokenRenameNativeValue<boolean>(
        native,
        native.keyboard.altKey,
        event,
      );
      const metaKey = tokenRenameNativeValue<boolean>(
        native,
        native.keyboard.metaKey,
        event,
      );
      const shiftKey = tokenRenameNativeValue<boolean>(
        native,
        native.keyboard.shiftKey,
        event,
      );
      const view = tokenRenameNativeValue<Window | EventTarget | null>(
        native,
        native.view,
        event,
      );
      const detail = tokenRenameNativeValue<number>(native, native.detail, event);
      const activeElement = native.apply(
        native.activeElement,
        authority.ownerDocument,
        [],
      ) as Element | null;
      const path = native.apply(native.composedPath, event, []) as EventTarget[];
      const trusted = native.trusted.read(event);
      const terminal = authority.terminal.proofFor(event as KeyboardEvent);
      if (
        type !== "keydown"
        || !(target instanceof native.HTMLElement)
        || target.tagName !== "BUTTON"
        || target.ownerDocument !== authority.ownerDocument
        || activeElement !== target
        || !currentTarget
        || phase !== expectedPhase
        || !bubbles
        || !cancelable
        || !composed
        || defaultPrevented
        || cancelBubble
        || !isTokenRenameNavigationKey(key)
        || repeat
        || composing
        || ctrlKey
        || altKey
        || metaKey
        || shiftKey
        || trusted !== true
        || !terminal
        || (view !== null
          && view !== authority.keyboard.ownerWindow
          && view !== terminal.receiver)
      ) {
        return null;
      }
      const expectedPath: EventTarget[] = [];
      let node: Node | null = target;
      while (node) {
        expectedPath.push(node);
        if (node === authority.ownerDocument) break;
        node = node.parentNode;
      }
      expectedPath.push(terminal.receiver);
      if (
        expectedPath.at(-2) !== authority.ownerDocument
        || path.length !== expectedPath.length
        || path.some((entry, index) => entry !== expectedPath[index])
        || path.length !== terminal.path.length
        || path.some((entry, index) => entry !== terminal.path[index])
        || terminal.receiver !== terminal.currentTarget
        || terminal.receiver !== terminal.terminal
        || !path.includes(currentTarget)
        || !path.includes(authority.commit.row)
        || !path.includes(authority.group)
      ) {
        return null;
      }
      return Object.freeze({
        event: event as KeyboardEvent,
        type,
        target: target as HTMLButtonElement,
        currentTarget,
        phase,
        path: Object.freeze([...path]),
        bubbles,
        cancelable,
        defaultPrevented: false,
        cancelBubble: false,
        composed,
        key,
        code,
        location,
        repeat: false,
        composing: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        view,
        detail,
        trusted: true,
        terminal,
      });
    } catch {
      return null;
    }
  };
  const rowNavigationNativeSnapshotsMatch = (
    capture: RowNavigationNativeSnapshot,
    bubble: RowNavigationNativeSnapshot,
    authority: RowNavigationAuthority,
  ) => capture.event === bubble.event
    && capture.type === bubble.type
    && capture.target === bubble.target
    && capture.currentTarget === bubble.currentTarget
    && capture.phase === authority.keyboard.Event.CAPTURING_PHASE
    && bubble.phase === authority.keyboard.Event.BUBBLING_PHASE
    && capture.bubbles === bubble.bubbles
    && capture.cancelable === bubble.cancelable
    && capture.defaultPrevented === bubble.defaultPrevented
    && capture.cancelBubble === bubble.cancelBubble
    && capture.composed === bubble.composed
    && capture.key === bubble.key
    && capture.code === bubble.code
    && capture.location === bubble.location
    && capture.repeat === bubble.repeat
    && capture.composing === bubble.composing
    && capture.ctrlKey === bubble.ctrlKey
    && capture.altKey === bubble.altKey
    && capture.metaKey === bubble.metaKey
    && capture.shiftKey === bubble.shiftKey
    && capture.view === bubble.view
    && capture.detail === bubble.detail
    && capture.trusted === bubble.trusted
    && capture.terminal === bubble.terminal
    && capture.path.length === bubble.path.length
    && capture.path.every((entry, index) => entry === bubble.path[index]);
  const rowNavigationNativeSnapshotIsCurrent = (
    snapshot: RowNavigationNativeSnapshot,
    authority: RowNavigationAuthority,
    expectedDefaultPrevented = false,
  ) => {
    try {
      const native = authority.keyboard;
      const path = native.apply(
        native.composedPath,
        snapshot.event,
        [],
      ) as EventTarget[];
      return rowNavigationAuthorityIsCurrent(authority)
        && native.prototypeOf(snapshot.event) === native.KeyboardEvent.prototype
        && native.trusted.matches(snapshot.event)
        && native.trusted.read(snapshot.event) === snapshot.trusted
        && tokenRenameNativeValue(native, native.event.type, snapshot.event)
          === snapshot.type
        && tokenRenameNativeValue(native, native.event.target, snapshot.event)
          === snapshot.target
        && tokenRenameNativeValue(
          native,
          native.event.currentTarget,
          snapshot.event,
        ) === snapshot.currentTarget
        && tokenRenameNativeValue(
          native,
          native.event.eventPhase,
          snapshot.event,
        ) === snapshot.phase
        && tokenRenameNativeValue(native, native.event.bubbles, snapshot.event)
          === snapshot.bubbles
        && tokenRenameNativeValue(native, native.event.cancelable, snapshot.event)
          === snapshot.cancelable
        && tokenRenameNativeValue(
          native,
          native.event.defaultPrevented,
          snapshot.event,
        ) === expectedDefaultPrevented
        && tokenRenameNativeValue(
          native,
          native.event.cancelBubble,
          snapshot.event,
        ) === snapshot.cancelBubble
        && tokenRenameNativeValue(native, native.event.composed, snapshot.event)
          === snapshot.composed
        && tokenRenameNativeValue(native, native.keyboard.key, snapshot.event)
          === snapshot.key
        && tokenRenameNativeValue(native, native.keyboard.code, snapshot.event)
          === snapshot.code
        && tokenRenameNativeValue(
          native,
          native.keyboard.location,
          snapshot.event,
        ) === snapshot.location
        && tokenRenameNativeValue(native, native.keyboard.repeat, snapshot.event)
          === snapshot.repeat
        && tokenRenameNativeValue(
          native,
          native.keyboard.isComposing,
          snapshot.event,
        ) === snapshot.composing
        && tokenRenameNativeValue(native, native.keyboard.ctrlKey, snapshot.event)
          === snapshot.ctrlKey
        && tokenRenameNativeValue(native, native.keyboard.altKey, snapshot.event)
          === snapshot.altKey
        && tokenRenameNativeValue(native, native.keyboard.metaKey, snapshot.event)
          === snapshot.metaKey
        && tokenRenameNativeValue(native, native.keyboard.shiftKey, snapshot.event)
          === snapshot.shiftKey
        && tokenRenameNativeValue(native, native.view, snapshot.event)
          === snapshot.view
        && tokenRenameNativeValue(native, native.detail, snapshot.event)
          === snapshot.detail
        && path.length === snapshot.path.length
        && path.every((entry, index) => entry === snapshot.path[index])
        && path.at(-1) === snapshot.terminal.receiver
        && snapshot.terminal.registration === authority.terminal
        && snapshot.terminal.nativeEvent === snapshot.event
        && snapshot.terminal.receiver === snapshot.terminal.currentTarget
        && snapshot.terminal.receiver === snapshot.terminal.terminal;
    } catch {
      return false;
    }
  };
  const captureRowNavigationReact = (
    event: ReactKeyboardEvent<HTMLElement>,
    authority: RowNavigationAuthority,
    native: RowNavigationNativeSnapshot,
    currentTarget: HTMLElement,
  ): RowNavigationReactSnapshot | null => {
    try {
      const reactEvent = event as ReactKeyboardEvent<HTMLElement> & {
        preventDefault?: unknown;
        isDefaultPrevented?: unknown;
        isPropagationStopped?: unknown;
      };
      const preventDefault = reactEvent.preventDefault;
      const isDefaultPrevented = reactEvent.isDefaultPrevented;
      const isPropagationStopped = reactEvent.isPropagationStopped;
      const view: ReactKeyboardEvent<HTMLElement>["view"] | null = event.view;
      if (
        typeof preventDefault !== "function"
        || typeof isDefaultPrevented !== "function"
        || typeof isPropagationStopped !== "function"
        || authority.keyboard.apply(isDefaultPrevented, event, []) !== false
        || authority.keyboard.apply(isPropagationStopped, event, []) !== false
        || reactEvent.preventDefault !== preventDefault
        || reactEvent.isDefaultPrevented !== isDefaultPrevented
        || reactEvent.isPropagationStopped !== isPropagationStopped
        || event.nativeEvent !== native.event
        || event.type !== native.type
        || event.target !== native.target
        || event.currentTarget !== currentTarget
        || event.eventPhase !== native.phase
        || event.bubbles !== native.bubbles
        || event.cancelable !== native.cancelable
        || event.defaultPrevented !== false
        || event.isTrusted !== native.trusted
        || event.key !== native.key
        || event.code !== native.code
        || event.location !== native.location
        || event.repeat !== native.repeat
        || event.ctrlKey !== native.ctrlKey
        || event.altKey !== native.altKey
        || event.metaKey !== native.metaKey
        || event.shiftKey !== native.shiftKey
        || (view !== null
          && !Object.is(event.view, authority.keyboard.ownerWindow)
          && !Object.is(event.view, native.terminal.receiver))
        || event.detail !== native.detail
      ) {
        return null;
      }
      return Object.freeze({
        event,
        nativeEvent: native.event,
        target: native.target,
        currentTarget,
        phase: native.phase,
        view,
        methods: Object.freeze({
          preventDefault,
          isDefaultPrevented,
          isPropagationStopped,
        }),
      });
    } catch {
      return null;
    }
  };
  const rowNavigationReactSnapshotIsCurrent = (
    snapshot: RowNavigationReactSnapshot,
    authority: RowNavigationAuthority,
    native: RowNavigationNativeSnapshot,
    currentTarget: HTMLElement | null,
  ) => {
    try {
      const event = snapshot.event as ReactKeyboardEvent<HTMLElement> & {
        preventDefault?: unknown;
        isDefaultPrevented?: unknown;
        isPropagationStopped?: unknown;
      };
      const view: ReactKeyboardEvent<HTMLElement>["view"] | null = event.view;
      return event.nativeEvent === snapshot.nativeEvent
        && event.nativeEvent === native.event
        && event.type === native.type
        && event.target === snapshot.target
        && event.target === native.target
        && event.currentTarget === currentTarget
        && event.eventPhase === snapshot.phase
        && event.eventPhase === native.phase
        && event.bubbles === native.bubbles
        && event.cancelable === native.cancelable
        && event.defaultPrevented === false
        && event.isTrusted === native.trusted
        && event.key === native.key
        && event.code === native.code
        && event.location === native.location
        && event.repeat === native.repeat
        && event.ctrlKey === native.ctrlKey
        && event.altKey === native.altKey
        && event.metaKey === native.metaKey
        && event.shiftKey === native.shiftKey
        && Object.is(event.view, snapshot.view)
        && Object.is(view, snapshot.view)
        && (view === null
          || Object.is(event.view, authority.keyboard.ownerWindow)
          || Object.is(event.view, native.terminal.receiver))
        && event.detail === native.detail
        && event.preventDefault === snapshot.methods.preventDefault
        && event.isDefaultPrevented === snapshot.methods.isDefaultPrevented
        && event.isPropagationStopped === snapshot.methods.isPropagationStopped
        && authority.keyboard.apply(
          snapshot.methods.isDefaultPrevented,
          event,
          [],
        ) === false
        && authority.keyboard.apply(
          snapshot.methods.isPropagationStopped,
          event,
          [],
        ) === false;
    } catch {
      return false;
    }
  };
  const claimRowNavigation = (delivery: RowNavigationDelivery) => {
    const { pair, bubble } = delivery;
    const nativeEvent = pair.native.event;
    if (
      rowNavigationDelivery.current
      || !rowMovementIsCurrent(
        pair.authority,
        pair.source,
        pair.destination,
        pair.key,
      )
      || claimedRowDeliveries.current.has(delivery)
      || claimedRowPairs.current.has(pair)
      || claimedRowMovements.current.has(pair.movement)
      || claimedRowCommits.current.has(pair.commitClaim)
      || claimedRowActionSets.current.has(pair.actionSetClaim)
      || claimedRowMovementClaims.current.has(pair.movementClaim)
      || claimedRowWrapperClaims.current.has(pair.wrapperClaim)
      || claimedRowNativeClaims.current.has(pair.nativeClaim)
      || claimedRowWindowClaims.current.has(pair.windowClaim)
      || claimedRowSourceClaims.current.has(pair.sourceClaim)
      || claimedRowDestinationClaims.current.has(pair.destinationClaim)
      || claimedRowReactEvents.current.has(pair.capture.event)
      || claimedRowReactEvents.current.has(bubble.event)
      || claimedRowNativeEvents.current.has(nativeEvent)
      || claimedRowTerminalProofs.current.has(pair.terminal)
      || !attemptedRowReactEvents.current.has(pair.capture.event)
      || !attemptedRowReactEvents.current.has(bubble.event)
      || !attemptedRowNativeEvents.current.has(nativeEvent)
      || !pair.authority.terminal.claim(pair.terminal)
    ) {
      return false;
    }
    claimedRowDeliveries.current.add(delivery);
    claimedRowPairs.current.add(pair);
    claimedRowMovements.current.add(pair.movement);
    claimedRowCommits.current.add(pair.commitClaim);
    claimedRowActionSets.current.add(pair.actionSetClaim);
    claimedRowMovementClaims.current.add(pair.movementClaim);
    claimedRowWrapperClaims.current.add(pair.wrapperClaim);
    claimedRowNativeClaims.current.add(pair.nativeClaim);
    claimedRowWindowClaims.current.add(pair.windowClaim);
    claimedRowSourceClaims.current.add(pair.sourceClaim);
    claimedRowDestinationClaims.current.add(pair.destinationClaim);
    claimedRowReactEvents.current.add(pair.capture.event);
    claimedRowReactEvents.current.add(bubble.event);
    claimedRowNativeEvents.current.add(nativeEvent);
    claimedRowTerminalProofs.current.add(pair.terminal);
    rowNavigationDelivery.current = delivery;
    return true;
  };
  const stageRowNavigation = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nativeEvent: KeyboardEvent;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return;
    }
    const authority = activeRowNavigation.current;
    const publication = authority?.publication.current;
    if (
      !authority
      || !publication
      || !nativeEvent
      || typeof nativeEvent !== "object"
      || publication.has(nativeEvent)
      || rowNavigationDelivery.current
      || attemptedRowReactEvents.current.has(event)
      || attemptedRowNativeEvents.current.has(nativeEvent)
    ) {
      return;
    }
    attemptedRowReactEvents.current.add(event);
    attemptedRowNativeEvents.current.add(nativeEvent);
    if (event.currentTarget !== authority.group) return;
    const native = captureRowNavigationNative(
      authority,
      nativeEvent,
      authority.keyboard.Event.CAPTURING_PHASE,
    );
    const capture = native
      ? captureRowNavigationReact(event, authority, native, authority.group)
      : null;
    const source = native
      ? authority.controls.find(({ element }) => element === native.target)
      : undefined;
    const destination = source && native
      ? rowNavigationDestination(authority, source, native.key)
      : null;
    if (
      !native
      || !capture
      || !source
      || !destination
      || native.terminal !== authority.terminal.proofFor(native.event)
      || !rowNavigationNativeSnapshotIsCurrent(native, authority)
      || !rowMovementIsCurrent(
        authority,
        source,
        destination,
        native.key,
      )
    ) {
      return;
    }
    const pair = Object.freeze<PendingRowNavigation>({
      authority,
      publication,
      native,
      capture,
      terminal: native.terminal,
      source,
      destination,
      key: native.key,
      movement: Object.freeze({
        authority,
        commit: authority.commit,
        controls: authority.controls,
        source,
        destination,
        key: native.key,
      }),
      commitClaim: Object.freeze({ commit: authority.commit }),
      actionSetClaim: Object.freeze({ controls: authority.controls }),
      movementClaim: Object.freeze({
        source,
        destination,
        key: native.key,
      }),
      wrapperClaim: Object.freeze({ capture: event }),
      nativeClaim: Object.freeze({ nativeEvent }),
      windowClaim: Object.freeze({
        registration: authority.terminal,
        proof: native.terminal,
        receiver: native.terminal.receiver,
      }),
      sourceClaim: Object.freeze({ source }),
      destinationClaim: Object.freeze({ destination }),
    });
    if (
      activeRowNavigation.current === authority
      && authority.publication.current === publication
    ) {
      publication.set(native.event, pair);
    }
  };
  const deliverRowNavigation = (
    role: RowNavigationRole,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    let nativeEvent: KeyboardEvent;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return;
    }
    const authority = activeRowNavigation.current;
    const publication = authority?.publication.current;
    const pair = publication?.get(nativeEvent);
    if (
      !authority
      || !publication
      || !pair
      || !nativeEvent
      || typeof nativeEvent !== "object"
      || pair.authority !== authority
      || pair.publication !== publication
      || pair.native.event !== nativeEvent
      || pair.source.role !== role
      || rowNavigationDelivery.current
      || attemptedRowReactEvents.current.has(event)
      || !attemptedRowNativeEvents.current.has(nativeEvent)
    ) {
      return;
    }
    attemptedRowReactEvents.current.add(event);
    const { source, destination, key } = pair;
    let delivery: RowNavigationDelivery | null = null;
    try {
      const native = captureRowNavigationNative(
        authority,
        nativeEvent,
        authority.keyboard.Event.BUBBLING_PHASE,
      );
      const bubble = native
        ? captureRowNavigationReact(event, authority, native, source.element)
        : null;
      if (
        !native
        || !bubble
        || bubble.event === pair.capture.event
        || event.currentTarget !== source.element
        || pair.capture.currentTarget !== authority.group
        || pair.capture.phase !== authority.keyboard.Event.CAPTURING_PHASE
        || bubble.phase !== authority.keyboard.Event.BUBBLING_PHASE
        || native.terminal !== pair.terminal
        || !rowNavigationNativeSnapshotsMatch(pair.native, native, authority)
        || !rowNavigationReactSnapshotIsCurrent(
          pair.capture,
          authority,
          pair.native,
          null,
        )
        || !rowNavigationReactSnapshotIsCurrent(
          bubble,
          authority,
          native,
          source.element,
        )
        || !rowNavigationNativeSnapshotIsCurrent(native, authority)
        || !rowMovementIsCurrent(
          authority,
          source,
          destination,
          key,
        )
        || activeRowNavigation.current !== authority
        || authority.publication.current !== publication
        || publication.get(nativeEvent) !== pair
      ) {
        return;
      }
      delivery = Object.freeze({ pair, bubble });
      if (!claimRowNavigation(delivery)) return;
      if (
        activeRowNavigation.current !== authority
        || authority.publication.current !== publication
        || publication.get(nativeEvent) !== pair
        || !publication.delete(nativeEvent)
      ) {
        return;
      }
      if (
        rowNavigationDelivery.current !== delivery
        || !rowNavigationReactSnapshotIsCurrent(
          pair.capture,
          authority,
          pair.native,
          null,
        )
        || !rowNavigationReactSnapshotIsCurrent(
          bubble,
          authority,
          native,
          source.element,
        )
        || !rowNavigationNativeSnapshotIsCurrent(native, authority)
        || !rowNavigationAuthorityIsCurrent(authority)
        || rowNavigationDestination(authority, source, key) !== destination
        || authority.keyboard.apply(
          authority.keyboard.activeElement,
          authority.ownerDocument,
          [],
        ) !== source.element
      ) {
        return;
      }
      authority.keyboard.apply(
        bubble.methods.preventDefault,
        bubble.event,
        [],
      );
      const currentPreventDefault = bubble.event.preventDefault;
      const currentPropagationQuery = bubble.event.isPropagationStopped;
      const currentDefaultQuery = bubble.event.isDefaultPrevented;
      if (
        currentPreventDefault !== bubble.methods.preventDefault
        || currentPropagationQuery !== bubble.methods.isPropagationStopped
        || tokenRenameNativeValue<boolean>(
          authority.keyboard,
          authority.keyboard.event.defaultPrevented,
          native.event,
        ) !== true
        || tokenRenameNativeValue<boolean>(
          authority.keyboard,
          authority.keyboard.event.cancelBubble,
          native.event,
        ) !== false
        || bubble.event.defaultPrevented !== true
        || typeof currentDefaultQuery !== "function"
        || typeof currentPropagationQuery !== "function"
        || authority.keyboard.apply(
          currentDefaultQuery,
          bubble.event,
          [],
        ) !== true
        || authority.keyboard.apply(
          currentPropagationQuery,
          bubble.event,
          [],
        ) !== false
        || !rowNavigationNativeSnapshotIsCurrent(native, authority, true)
        || rowNavigationDelivery.current !== delivery
        || !rowNavigationAuthorityIsCurrent(authority)
        || rowNavigationDestination(authority, source, key) !== destination
        || authority.keyboard.apply(
          authority.keyboard.activeElement,
          authority.ownerDocument,
          [],
        ) !== source.element
      ) {
        return;
      }
      authority.keyboard.apply(
        authority.keyboard.focus,
        destination.element,
        [TOKEN_RENAME_PREVENT_SCROLL],
      );
    } catch {
      return;
    } finally {
      if (delivery && rowNavigationDelivery.current === delivery) {
        rowNavigationDelivery.current = null;
      }
    }
  };
  const establishRowNavigation = (commit: RowCommit) => {
    const group = commit.actions;
    const ownerWindow = commit.ownerDocument.defaultView;
    if (
      !group
      || !commit.facts.actionsVisible
      || !ownerWindow?.MutationObserver
      || activeCommit.current !== commit
      || !factsAreCurrent(commit.facts)
      || !domIsExact(commit)
    ) {
      return;
    }
    const placement = snapshotSecretNoticePlacement(commit.row);
    const keyboard = captureTokenRenameKeyboardAuthority(
      commit.ownerDocument,
      ownerWindow,
    );
    if (!placement || !keyboard) return;
    const terminal = createTokenRowKeyboardTerminalRegistration(keyboard);
    if (!terminal) return;
    const publication: RowNavigationPublication = {
      current: new WeakMap<KeyboardEvent, PendingRowNavigation>(),
    };
    Object.seal(publication);
    const entries = ([
      ["rename", 0],
      ["replace", 1],
      ["revoke", 2],
    ] as const).filter(([role]) => commit.facts[role]?.eligible);
    const controls = entries.flatMap(([role, order], index) => {
      const element = commit[role];
      const action = commit.facts[role];
      return element && action
        ? [Object.freeze<RowNavigationControl>({
            identity: Symbol(`token-row-${role}-navigation`),
            role,
            index,
            order,
            ownerIdentity: candidate[role].identity,
            action,
            element,
          })]
        : [];
    });
    if (controls.length !== entries.length || controls.length === 0) {
      terminal.release();
      return;
    }
    const history = new TokenRenameMutationHistory(
      ownerWindow,
      commit.row,
      placement,
      null,
    );
    const authority: RowNavigationAuthority = {
      identity: Symbol("token-row-action-navigation"),
      mount,
      panel: commit.facts.panel,
      candidate,
      commit,
      token: commit.facts.token,
      callback: commit.facts.onAction,
      group,
      controls: Object.freeze(controls),
      ownerDocument: commit.ownerDocument,
      keyboard,
      terminal,
      publication,
      dom: snapshotSecretNoticeDom(commit.row),
      placement,
      history,
      retired: false,
    };
    Object.seal(authority);
    const previous = activeRowNavigation.current;
    if (previous) retireRowNavigation(previous);
    activeRowNavigation.current = authority;
    if (!rowNavigationAuthorityIsCurrent(authority)) {
      retireRowNavigation(authority);
    }
  };
  const renameAuthorityIsCurrent = (authority: RenameEscapeAuthority) => {
    const commit = currentCommit(authority.candidate);
    const focus = focusedRename.current;
    return activeRenameEscape.current === authority
      && !authority.retired
      && authority.mount === mount
      && authority.panel === panel
      && authority.panel === authority.commit.facts.panel
      && Object.isFrozen(authority.panel)
      && authority.panel.update === api.tokens.update
      && authority.update === authority.panel.update
      && authority.candidate === candidate
      && commit === authority.commit
      && commit.facts.renameVisit === authority.visit
      && commit.facts.token === authority.token
      && commit.facts.token.id === authority.visit.tokenId
      && commit.facts.token.name === authority.persistedName
      && commit.facts.draft === authority.draft
      && commit.facts.onAction === authority.callback
      && commit.facts.inputEligible
      && commit.facts.cancel?.eligible === true
      && saveOwner.current === null
      && commit.input === authority.input
      && commit.form === authority.form
      && commit.save === authority.controls[0]?.element
      && commit.cancel === authority.controls[1]?.element
      && authority.controls.length === 2
      && Object.isFrozen(authority.controls)
      && authority.controls.every((control, index) => {
        const role = index === 0 ? "save" : "cancel";
        const owner = candidate[role];
        const element = commit[role];
        const action = commit.facts[role];
        return Object.isFrozen(control)
          && control.role === role
          && control.index === index
          && control.ownerIdentity === owner.identity
          && control.action === action
          && control.element === element
          && element?.parentElement === commit.form?.children.item(2)
          && commit.form?.children.item(2)?.children.item(index) === element;
      })
      && authority.input.form === authority.form
      && authority.input.ownerDocument === authority.ownerDocument
      && authority.form.ownerDocument === authority.ownerDocument
      && authority.ownerDocument.defaultView === authority.keyboard.ownerWindow
      && !authority.navigation.retired
      && authority.navigation.attached
      && authority.navigation.current !== null
      && authority.navigation.seen !== null
      && authority.navigation.target === authority.keyboard.ownerWindow
      && authority.navigation.add === authority.keyboard.addEventListener
      && authority.navigation.remove === authority.keyboard.removeEventListener
      && authority.navigation.capture === true
      && focus?.visit === authority.visit
      && focus.input === authority.input
      && !authority.input.disabled
      && authority.input.getAttribute("aria-disabled") !== "true"
      && authority.keyboard.isCurrent()
      && authority.history.isPristine()
      && secretNoticeDomMatches(authority.dom)
      && secretNoticePlacementMatches(
        commit.row,
        authority.ownerDocument,
        authority.placement,
      )
      && domIsExact(commit);
  };
  const renameEscapePublicationIsCurrent = (authority: RenameEscapeAuthority) => {
    const publication = authority.escape;
    return activeRenameEscape.current === authority
      && !authority.retired
      && activeMount.current === authority.mount
      && authority.candidate === candidate
      && publication.current !== null
      && publication.wrappers !== null
      && publication.inputDeliveries !== null
      && publication.retiredEvents !== null
      && publication.claimedEvents !== null
      && publication.attached
      && publication.target === authority.keyboard.ownerWindow
      && publication.add === authority.keyboard.addEventListener
      && publication.remove === authority.keyboard.removeEventListener;
  };
  const renameEscapeIsCurrent = (authority: RenameEscapeAuthority) =>
    renameEscapePublicationIsCurrent(authority)
    && renameAuthorityIsCurrent(authority)
    && authority.keyboard.apply(
      authority.keyboard.activeElement,
      authority.ownerDocument,
      [],
    ) === authority.input;
  const navigationControlIsEnabled = (
    authority: RenameEscapeAuthority,
    control: RenameNavigationControl,
  ) => {
    const expectedRole = control.index === 0 ? "save" : "cancel";
    return Object.isFrozen(control)
      && control.role === expectedRole
      && control.ownerIdentity === authority.candidate[expectedRole].identity
      && control.action === authority.commit.facts[expectedRole]
      && control.action.eligible
      && control.element === authority.commit[expectedRole]
      && control.element === authority.candidate[expectedRole].element
      && control.element.ownerDocument === authority.ownerDocument
      && control.element.parentElement === authority.form.children.item(2)
      && authority.form.children.item(2)?.children.item(control.index) === control.element
      && !control.element.disabled
      && control.element.getAttribute("aria-disabled") !== "true"
      && authority.controls[control.index] === control;
  };
  const renameNavigationDestination = (
    authority: RenameEscapeAuthority,
    source: RenameNavigationControl,
    key: TokenRenameNavigationKey,
  ): RenameNavigationControl | null => {
    if (
      authority.controls.length !== 2
      || authority.controls[source.index] !== source
      || !navigationControlIsEnabled(authority, source)
    ) {
      return null;
    }
    if (key === "Home" || key === "End") {
      const ordered = key === "Home"
        ? authority.controls
        : [...authority.controls].reverse();
      const destination = ordered.find((control) =>
        navigationControlIsEnabled(authority, control)) ?? null;
      return destination === source ? null : destination;
    }
    const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
    for (
      let index = source.index + step;
      index >= 0 && index < authority.controls.length;
      index += step
    ) {
      const destination = authority.controls[index];
      if (destination && navigationControlIsEnabled(authority, destination)) {
        return destination;
      }
    }
    return null;
  };
  const renameNavigationIsCurrent = (
    authority: RenameEscapeAuthority,
    source: RenameNavigationControl,
    destination: RenameNavigationControl,
  ) => renameAuthorityIsCurrent(authority)
    && authority.ownerDocument.activeElement === source.element
    && navigationControlIsEnabled(authority, source)
    && navigationControlIsEnabled(authority, destination);
  const renameNavigationPublicationIsCurrent = (
    authority: RenameEscapeAuthority,
    publication: RenameNavigationPublication,
  ) => authority.navigation === publication
    && !publication.retired
    && publication.attached
    && publication.current !== null
    && publication.seen !== null
    && publication.target === authority.keyboard.ownerWindow
    && publication.add === authority.keyboard.addEventListener
    && publication.remove === authority.keyboard.removeEventListener
    && publication.capture === true
    && authority.keyboard.isCurrent();
  const renameNavigationTerminalProofIsCurrent = (
    pair: PendingRenameNavigation,
  ) => {
    const { authority, publication, terminal, native } = pair;
    if (
      !Object.isFrozen(terminal)
      || terminal.publication !== publication
      || terminal.event !== native.event
      || terminal.receiver !== terminal.currentTarget
      || terminal.receiver !== terminal.terminal
      || terminal.eventPhase !== authority.keyboard.Event.CAPTURING_PHASE
      || native.path.at(-1) !== terminal.receiver
      || !renameNavigationPublicationIsCurrent(authority, publication)
    ) {
      return false;
    }
    try {
      const path = authority.keyboard.apply(
        authority.keyboard.composedPath,
        native.event,
        [],
      ) as EventTarget[];
      return path.length === native.path.length
        && path.every((entry, index) => entry === native.path[index]);
    } catch {
      return false;
    }
  };
  const renameNavigationPairIsRetained = (pair: PendingRenameNavigation) => {
    const current = pair.publication.current;
    const claim = renameNavigationInProgress.current;
    return Boolean(
      current?.get(pair.native.event) === pair
      || claim?.pair === pair
    );
  };
  const renameNavigationNativeIsCurrent = (
    pair: PendingRenameNavigation,
    expectedPhase: number,
    expectedDefaultPrevented: boolean,
  ) => {
    const { authority, native, source, destination } = pair;
    const keyboard = authority.keyboard;
    if (
      pair.replayed
      || !renameNavigationPairIsRetained(pair)
      || !renameNavigationTerminalProofIsCurrent(pair)
      || !renameNavigationIsCurrent(authority, source, destination)
      || renameNavigationDestination(authority, source, native.key) !== destination
      || keyboard.prototypeOf(native.event) !== keyboard.KeyboardEvent.prototype
      || !keyboard.trusted.matches(native.event)
    ) {
      return false;
    }
    try {
      const currentTarget = tokenRenameNativeValue<EventTarget | null>(
        keyboard,
        keyboard.event.currentTarget,
        native.event,
      );
      const path = keyboard.apply(keyboard.composedPath, native.event, []) as EventTarget[];
      return tokenRenameNativeValue<string>(keyboard, keyboard.event.type, native.event)
          === native.type
        && tokenRenameNativeValue<EventTarget | null>(
          keyboard,
          keyboard.event.target,
          native.event,
        ) === native.target
        && currentTarget !== null
        && path.includes(currentTarget)
        && tokenRenameNativeValue<number>(
          keyboard,
          keyboard.event.eventPhase,
          native.event,
        ) === expectedPhase
        && tokenRenameNativeValue<boolean>(
          keyboard,
          keyboard.event.bubbles,
          native.event,
        ) === native.bubbles
        && tokenRenameNativeValue<boolean>(
          keyboard,
          keyboard.event.cancelable,
          native.event,
        ) === native.cancelable
        && tokenRenameNativeValue<boolean>(
          keyboard,
          keyboard.event.defaultPrevented,
          native.event,
        ) === expectedDefaultPrevented
        && tokenRenameNativeValue<boolean>(
          keyboard,
          keyboard.event.cancelBubble,
          native.event,
        ) === native.cancelBubble
        && tokenRenameNativeValue<boolean>(
          keyboard,
          keyboard.event.composed,
          native.event,
        ) === native.composed
        && tokenRenameNativeValue<number>(
          keyboard,
          keyboard.event.timeStamp,
          native.event,
        ) === native.timeStamp
        && tokenRenameNativeValue<string>(
          keyboard,
          keyboard.keyboard.key,
          native.event,
        ) === native.key
        && tokenRenameNativeValue<string>(
          keyboard,
          keyboard.keyboard.code,
          native.event,
        ) === native.code
        && tokenRenameNativeValue<number>(
          keyboard,
          keyboard.keyboard.location,
          native.event,
        ) === native.location
        && tokenRenameNativeValue<number>(
          keyboard,
          keyboard.keyboard.charCode,
          native.event,
        ) === native.charCode
        && tokenRenameNativeValue<number>(
          keyboard,
          keyboard.keyboard.keyCode,
          native.event,
        ) === native.keyCode
        && tokenRenameNativeValue<boolean>(
          keyboard,
          keyboard.keyboard.repeat,
          native.event,
        ) === native.repeat
        && tokenRenameNativeValue<boolean>(
          keyboard,
          keyboard.keyboard.isComposing,
          native.event,
        ) === native.isComposing
        && tokenRenameNativeValue<boolean>(
          keyboard,
          keyboard.keyboard.ctrlKey,
          native.event,
        ) === native.ctrlKey
        && tokenRenameNativeValue<boolean>(
          keyboard,
          keyboard.keyboard.altKey,
          native.event,
        ) === native.altKey
        && tokenRenameNativeValue<boolean>(
          keyboard,
          keyboard.keyboard.metaKey,
          native.event,
        ) === native.metaKey
        && tokenRenameNativeValue<boolean>(
          keyboard,
          keyboard.keyboard.shiftKey,
          native.event,
        ) === native.shiftKey
        && tokenRenameNativeValue<Window | EventTarget | null>(
          keyboard,
          keyboard.view,
          native.event,
        ) === native.view
        && tokenRenameNativeValue<number>(keyboard, keyboard.detail, native.event)
          === native.detail
        && keyboard.trusted.read(native.event) === native.trusted
        && (
          native.view === null
          || native.view === keyboard.ownerWindow
          || native.view === native.terminal.receiver
        )
        && path.length === native.path.length
        && path.every((entry, index) => entry === native.path[index]);
    } catch {
      return false;
    }
  };
  const renameNavigationReactProofIsCurrent = (
    pair: PendingRenameNavigation,
    proof: RenameNavigationReactProof,
    expectedPhase: number,
    expectedCurrentTarget: HTMLFormElement | null,
    expectedDefaultPrevented: boolean,
    defaultQuery: RenameNavigationReactMethod = proof.methods.isDefaultPrevented,
  ) => {
    const { event } = proof;
    const { native } = pair;
    try {
      return proof.nativeEvent === native.event
        && proof.currentTarget === pair.authority.form
        && proof.target === native.target
        && proof.type === native.type
        && proof.eventPhase === expectedPhase
        && proof.bubbles === native.bubbles
        && proof.cancelable === native.cancelable
        && proof.defaultPrevented === false
        && proof.isTrusted === native.trusted
        && proof.timeStamp === native.timeStamp
        && proof.key === native.key
        && proof.code === native.code
        && proof.location === native.location
        && proof.charCode === native.charCode
        && proof.keyCode === native.keyCode
        && proof.repeat === native.repeat
        && proof.altKey === native.altKey
        && proof.ctrlKey === native.ctrlKey
        && proof.metaKey === native.metaKey
        && proof.shiftKey === native.shiftKey
        && proof.detail === native.detail
        && Object.is(proof.view, native.view)
        && event.nativeEvent === proof.nativeEvent
        && event.currentTarget === expectedCurrentTarget
        && event.target === proof.target
        && event.type === proof.type
        && event.eventPhase === proof.eventPhase
        && event.bubbles === proof.bubbles
        && event.cancelable === proof.cancelable
        && event.defaultPrevented === expectedDefaultPrevented
        && event.isTrusted === proof.isTrusted
        && event.timeStamp === proof.timeStamp
        && event.key === proof.key
        && event.code === proof.code
        && event.location === proof.location
        && event.charCode === proof.charCode
        && event.keyCode === proof.keyCode
        && event.repeat === proof.repeat
        && event.altKey === proof.altKey
        && event.ctrlKey === proof.ctrlKey
        && event.metaKey === proof.metaKey
        && event.shiftKey === proof.shiftKey
        && event.detail === proof.detail
        && Object.is(event.view, proof.view)
        && event.preventDefault === proof.methods.preventDefault
        && event.isDefaultPrevented === defaultQuery
        && event.isPropagationStopped === proof.methods.isPropagationStopped
        && typeof defaultQuery === "function";
    } catch {
      return false;
    }
  };
  const renameNavigationContextIsCurrent = (
    pair: PendingRenameNavigation,
    expectedPhase: number,
    expectedDefaultPrevented: boolean,
    capture: RenameNavigationReactProof | null,
    bubble: RenameNavigationReactProof | null,
    bubbleDefaultQuery?: RenameNavigationReactMethod,
  ) => renameNavigationNativeIsCurrent(pair, expectedPhase, expectedDefaultPrevented)
    && (!capture || renameNavigationReactProofIsCurrent(
      pair,
      capture,
      pair.authority.keyboard.Event.CAPTURING_PHASE,
      expectedPhase === pair.authority.keyboard.Event.CAPTURING_PHASE
        ? pair.authority.form
        : null,
      false,
    ))
    && (!bubble || renameNavigationReactProofIsCurrent(
      pair,
      bubble,
      pair.authority.keyboard.Event.BUBBLING_PHASE,
      pair.authority.form,
      expectedDefaultPrevented,
      bubbleDefaultQuery,
    ));
  const invokeRenameNavigationPublic = (
    pair: PendingRenameNavigation,
    callback: RenameNavigationReactMethod,
    receiver: RenameNavigationReactEvent,
  ) => {
    const { publication } = pair;
    if (
      publication.publicCallActive
      || !renameNavigationPublicationIsCurrent(pair.authority, publication)
      || !renameNavigationPairIsRetained(pair)
    ) {
      return null;
    }
    publication.publicCallActive = true;
    try {
      return Object.freeze({
        value: pair.authority.keyboard.apply(callback, receiver, []),
      });
    } catch {
      return null;
    } finally {
      publication.publicCallActive = false;
    }
  };
  const validateRenameNavigationQuery = (
    pair: PendingRenameNavigation,
    proof: RenameNavigationReactProof,
    expectedPhase: number,
    capture: RenameNavigationReactProof | null,
    bubble: RenameNavigationReactProof | null,
    method: "isDefaultPrevented" | "isPropagationStopped",
    expectedResult: boolean,
  ) => {
    if (
      !renameNavigationContextIsCurrent(
        pair,
        expectedPhase,
        false,
        capture,
        bubble,
      )
      || !renameNavigationReactProofIsCurrent(
        pair,
        proof,
        expectedPhase,
        pair.authority.form,
        false,
      )
    ) {
      return false;
    }
    const callback = proof.methods[method];
    const result = invokeRenameNavigationPublic(pair, callback, proof.event);
    return result?.value === expectedResult
      && renameNavigationContextIsCurrent(
        pair,
        expectedPhase,
        false,
        capture,
        bubble,
      )
      && renameNavigationReactProofIsCurrent(
        pair,
        proof,
        expectedPhase,
        pair.authority.form,
        false,
      );
  };
  const readRenameNavigationNativeAtWindow = (
    authority: RenameEscapeAuthority,
    publication: RenameNavigationPublication,
    receiver: EventTarget,
    event: Event,
  ): PendingRenameNavigation | null => {
    const keyboard = authority.keyboard;
    if (
      !renameNavigationPublicationIsCurrent(authority, publication)
      || !(event instanceof keyboard.Event)
      || keyboard.prototypeOf(event) !== keyboard.KeyboardEvent.prototype
      || !keyboard.trusted.matches(event)
    ) {
      return null;
    }
    try {
      const type = tokenRenameNativeValue<string>(keyboard, keyboard.event.type, event);
      const target = tokenRenameNativeValue<EventTarget | null>(
        keyboard,
        keyboard.event.target,
        event,
      );
      const currentTarget = tokenRenameNativeValue<EventTarget | null>(
        keyboard,
        keyboard.event.currentTarget,
        event,
      );
      const eventPhase = tokenRenameNativeValue<number>(
        keyboard,
        keyboard.event.eventPhase,
        event,
      );
      const bubbles = tokenRenameNativeValue<boolean>(
        keyboard,
        keyboard.event.bubbles,
        event,
      );
      const cancelable = tokenRenameNativeValue<boolean>(
        keyboard,
        keyboard.event.cancelable,
        event,
      );
      const defaultPrevented = tokenRenameNativeValue<boolean>(
        keyboard,
        keyboard.event.defaultPrevented,
        event,
      );
      const cancelBubble = tokenRenameNativeValue<boolean>(
        keyboard,
        keyboard.event.cancelBubble,
        event,
      );
      const composed = tokenRenameNativeValue<boolean>(
        keyboard,
        keyboard.event.composed,
        event,
      );
      const timeStamp = tokenRenameNativeValue<number>(
        keyboard,
        keyboard.event.timeStamp,
        event,
      );
      const key = tokenRenameNativeValue<string>(keyboard, keyboard.keyboard.key, event);
      const code = tokenRenameNativeValue<string>(keyboard, keyboard.keyboard.code, event);
      const location = tokenRenameNativeValue<number>(
        keyboard,
        keyboard.keyboard.location,
        event,
      );
      const charCode = tokenRenameNativeValue<number>(
        keyboard,
        keyboard.keyboard.charCode,
        event,
      );
      const keyCode = tokenRenameNativeValue<number>(
        keyboard,
        keyboard.keyboard.keyCode,
        event,
      );
      const repeat = tokenRenameNativeValue<boolean>(
        keyboard,
        keyboard.keyboard.repeat,
        event,
      );
      const isComposing = tokenRenameNativeValue<boolean>(
        keyboard,
        keyboard.keyboard.isComposing,
        event,
      );
      const ctrlKey = tokenRenameNativeValue<boolean>(
        keyboard,
        keyboard.keyboard.ctrlKey,
        event,
      );
      const altKey = tokenRenameNativeValue<boolean>(
        keyboard,
        keyboard.keyboard.altKey,
        event,
      );
      const metaKey = tokenRenameNativeValue<boolean>(
        keyboard,
        keyboard.keyboard.metaKey,
        event,
      );
      const shiftKey = tokenRenameNativeValue<boolean>(
        keyboard,
        keyboard.keyboard.shiftKey,
        event,
      );
      const view = tokenRenameNativeValue<Window | EventTarget | null>(
        keyboard,
        keyboard.view,
        event,
      );
      const detail = tokenRenameNativeValue<number>(keyboard, keyboard.detail, event);
      const trusted = keyboard.trusted.read(event);
      const path = keyboard.apply(keyboard.composedPath, event, []) as EventTarget[];
      const source = authority.controls.find((control) => control.element === target);
      const destination = source && isTokenRenameNavigationKey(key)
        ? renameNavigationDestination(authority, source, key)
        : null;
      const activeElement = keyboard.apply(
        keyboard.activeElement,
        authority.ownerDocument,
        [],
      ) as Element | null;
      const expectedPath: EventTarget[] = [];
      let node: Node | null = source?.element ?? null;
      while (node) {
        expectedPath.push(node);
        if (node === authority.ownerDocument) break;
        node = node.parentNode;
      }
      expectedPath.push(receiver);
      if (
        type !== "keydown"
        || !source
        || !destination
        || currentTarget !== receiver
        || eventPhase !== keyboard.Event.CAPTURING_PHASE
        || !bubbles
        || !cancelable
        || defaultPrevented
        || cancelBubble
        || !composed
        || !isTokenRenameNavigationKey(key)
        || repeat
        || isComposing
        || ctrlKey
        || altKey
        || metaKey
        || shiftKey
        || trusted !== true
        || activeElement !== source.element
        || source.element.ownerDocument !== authority.ownerDocument
        || path.at(-1) !== receiver
        || path.at(-2) !== authority.ownerDocument
        || expectedPath.at(-2) !== authority.ownerDocument
        || path.length !== expectedPath.length
        || path.some((entry, index) => entry !== expectedPath[index])
        || (view !== null && view !== keyboard.ownerWindow && view !== receiver)
        || !renameNavigationIsCurrent(authority, source, destination)
      ) {
        return null;
      }
      const terminal = Object.freeze<RenameNavigationTerminalProof>({
        publication,
        event: event as KeyboardEvent,
        receiver,
        currentTarget,
        terminal: receiver,
        eventPhase,
      });
      const native = Object.freeze<RenameNavigationNativeSnapshot>({
        event: event as KeyboardEvent,
        type,
        target: source.element,
        path: Object.freeze([...path]),
        bubbles: true,
        cancelable: true,
        defaultPrevented: false,
        cancelBubble: false,
        composed: true,
        timeStamp,
        key,
        code,
        location,
        charCode,
        keyCode,
        repeat: false,
        isComposing: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        view,
        detail,
        trusted: true,
        terminal,
      });
      return Object.freeze<PendingRenameNavigation>({
        authority,
        publication,
        reactCapture: null,
        reactBubble: null,
        native,
        terminal,
        source,
        destination,
        movement: Object.freeze({
          authority,
          visit: authority.visit,
          draft: authority.draft,
          token: authority.token,
          callback: authority.callback,
          controls: authority.controls,
          source,
          destination,
          key,
        }),
        replayed: false,
      });
    } catch {
      return null;
    }
  };
  const escapeScalarFields = [
    "type", "bubbles", "cancelable", "isTrusted", "timeStamp",
    "key", "code", "location", "charCode", "keyCode", "repeat",
    "altKey", "ctrlKey", "metaKey", "shiftKey", "detail", "view",
  ] as const;
  const readRenameEscapeNative = (
    authority: RenameEscapeAuthority,
    event: KeyboardEvent,
    phase: number,
    prevented = false,
    receiver?: EventTarget,
  ): RenameEscapeNativeProof | null => {
    const keyboard = authority.keyboard;
    if (
      !renameEscapeIsCurrent(authority)
      || keyboard.prototypeOf(event) !== keyboard.KeyboardEvent.prototype
      || !keyboard.trusted.matches(event)
    ) return null;
    const values: Record<string, unknown> = {};
    for (const field of ["type", "bubbles", "cancelable", "composed", "timeStamp"] as const) {
      values[field] = tokenRenameNativeValue(keyboard, keyboard.event[field], event);
    }
    for (const field of [
      "key", "code", "location", "charCode", "keyCode", "repeat", "isComposing",
      "altKey", "ctrlKey", "metaKey", "shiftKey",
    ] as const) {
      values[field] = tokenRenameNativeValue(keyboard, keyboard.keyboard[field], event);
    }
    values.isTrusted = keyboard.trusted.read(event);
    values.view = tokenRenameNativeValue(keyboard, keyboard.view, event);
    values.detail = tokenRenameNativeValue(keyboard, keyboard.detail, event);
    const currentTarget = tokenRenameNativeValue<EventTarget | null>(
      keyboard, keyboard.event.currentTarget, event,
    );
    const path = keyboard.apply(keyboard.composedPath, event, []) as EventTarget[];
    const terminal = path.at(-1);
    const expected: EventTarget[] = [];
    let node: Node | null = authority.input;
    while (node) {
      expected.push(node);
      if (node === authority.ownerDocument) break;
      node = node.parentNode;
    }
    if (
      values.type !== "keydown"
      || values.key !== "Escape"
      || values.bubbles !== true
      || values.cancelable !== true
      || values.isTrusted !== true
      || ["repeat", "isComposing", "altKey", "ctrlKey", "metaKey", "shiftKey"]
        .some((field) => values[field] !== false)
      || tokenRenameNativeValue(keyboard, keyboard.event.target, event) !== authority.input
      || tokenRenameNativeValue(keyboard, keyboard.event.eventPhase, event) !== phase
      || tokenRenameNativeValue(keyboard, keyboard.event.defaultPrevented, event) !== prevented
      || tokenRenameNativeValue(keyboard, keyboard.event.cancelBubble, event) !== false
      || !currentTarget
      || !terminal
      || (receiver !== undefined && (currentTarget !== receiver || terminal !== receiver))
      || expected.at(-1) !== authority.ownerDocument
      || path.at(-2) !== authority.ownerDocument
      || path.length !== expected.length + 1
      || expected.some((entry, index) => path[index] !== entry)
      || !path.includes(currentTarget)
      || (values.view !== null
        && values.view !== keyboard.ownerWindow
        && values.view !== terminal)
    ) return null;
    return Object.freeze({
      event,
      receiver: receiver ?? terminal,
      currentTarget,
      terminal,
      path: Object.freeze([...path]),
      values: Object.freeze(values),
    });
  };
  const readRenameEscapeReact = (
    event: RenameEscapeReactEvent,
    pair: PendingRenameEscape,
    currentTarget: HTMLInputElement | HTMLFormElement,
    phase: number,
  ): RenameEscapeReactProof | null => {
    const { authority } = pair;
    if (
      !renameEscapePublicationIsCurrent(authority)
      || authority.escape !== pair.publication
    ) return null;
    const keyboard = pair.authority.keyboard;
    const nativeCurrentTarget = tokenRenameNativeValue<EventTarget | null>(
      keyboard, keyboard.event.currentTarget, pair.native.event,
    );
    const nativeEvent = event.nativeEvent;
    if (!renameEscapePublicationIsCurrent(authority)) return null;
    const target = event.target;
    if (!renameEscapePublicationIsCurrent(authority)) return null;
    const deliveredTarget = event.currentTarget;
    if (!renameEscapePublicationIsCurrent(authority)) return null;
    const eventPhase = event.eventPhase;
    if (!renameEscapePublicationIsCurrent(authority)) return null;
    const defaultPrevented = event.defaultPrevented;
    if (!renameEscapePublicationIsCurrent(authority)) return null;
    const record = event as unknown as Record<string, unknown>;
    const values: Record<string, unknown> = {};
    for (const field of [...escapeScalarFields, "which", "locale", "isComposing"]) {
      values[field] = record[field];
      if (!renameEscapePublicationIsCurrent(authority)) return null;
    }
    const preventDefault = event.preventDefault as RenameNavigationReactMethod;
    if (!renameEscapePublicationIsCurrent(authority)) return null;
    const isDefaultPrevented = event.isDefaultPrevented as RenameNavigationReactMethod;
    if (!renameEscapePublicationIsCurrent(authority)) return null;
    const isPropagationStopped = event.isPropagationStopped as RenameNavigationReactMethod;
    if (!renameEscapePublicationIsCurrent(authority)) return null;
    const methods = Object.freeze({
      preventDefault,
      isDefaultPrevented,
      isPropagationStopped,
    });
    if (
      event === (pair.native.event as unknown)
      || nativeEvent !== pair.native.event
      || !nativeCurrentTarget
      || tokenRenameNativeValue(keyboard, keyboard.event.eventPhase, pair.native.event) !== phase
      || target !== pair.authority.input
      || deliveredTarget !== currentTarget
      || eventPhase !== phase
      || defaultPrevented !== false
      || escapeScalarFields.some((field) => !Object.is(values[field], pair.native.values[field]))
      || (values.isComposing !== undefined && values.isComposing !== false)
      || (values.which !== undefined && values.which !== values.keyCode)
      || Object.values(methods).some((method) => typeof method !== "function")
    ) return null;
    return Object.freeze({
      event,
      nativeEvent: pair.native.event,
      target: pair.authority.input,
      currentTarget,
      nativeCurrentTarget,
      eventPhase: phase,
      values: Object.freeze(values),
      methods,
    });
  };
  const renameEscapeReactIsCurrent = (
    pair: PendingRenameEscape,
    proof: RenameEscapeReactProof,
    currentTarget: HTMLInputElement | HTMLFormElement | null,
    prevented: boolean,
    defaultQuery = proof.methods.isDefaultPrevented,
  ) => {
    const { event } = proof;
    const { authority } = pair;
    const record = event as unknown as Record<string, unknown>;
    return renameEscapePublicationIsCurrent(authority)
      && event.nativeEvent === proof.nativeEvent
      && renameEscapePublicationIsCurrent(authority)
      && event.target === proof.target
      && renameEscapePublicationIsCurrent(authority)
      && event.currentTarget === currentTarget
      && renameEscapePublicationIsCurrent(authority)
      && event.eventPhase === proof.eventPhase
      && renameEscapePublicationIsCurrent(authority)
      && event.defaultPrevented === prevented
      && renameEscapePublicationIsCurrent(authority)
      && Object.entries(proof.values).every(([field, value]) =>
        Object.is(record[field], value) && renameEscapePublicationIsCurrent(authority))
      && event.preventDefault === proof.methods.preventDefault
      && renameEscapePublicationIsCurrent(authority)
      && event.isDefaultPrevented === defaultQuery
      && renameEscapePublicationIsCurrent(authority)
      && event.isPropagationStopped === proof.methods.isPropagationStopped
      && renameEscapePublicationIsCurrent(authority)
      && typeof defaultQuery === "function";
  };
  // This check never reads a public wrapper, so it is safe after selecting a callable.
  const renameEscapePairIsCurrent = (
    pair: PendingRenameEscape,
    capture: RenameEscapeReactProof,
    bubble: RenameEscapeReactProof | null,
    claimed = false,
    prevented = false,
  ) => {
    const { authority, publication, native } = pair;
    // Check revocation before touching any weak store, including from retained handlers.
    if (
      !renameEscapePublicationIsCurrent(authority)
      || authority.escape !== publication
      || publication.current?.get(native.event) !== pair
      || publication.retiredEvents?.has(native.event)
      || publication.claimedEvents?.has(native.event) !== claimed
      || authority.claimed !== claimed
      || consumedCommits.current.has(authority.commit)
      || dispatchingCommits.current.has(authority.commit)
      || renameNavigationInProgress.current !== null
      || authority.navigation.publicCallActive
      || !renameEscapeIsCurrent(authority)
    ) return false;
    const phase = bubble
      ? authority.keyboard.Event.BUBBLING_PHASE
      : authority.keyboard.Event.CAPTURING_PHASE;
    const current = readRenameEscapeNative(authority, native.event, phase, prevented);
    if (
      !current
      || native.receiver !== native.currentTarget
      || native.receiver !== native.terminal
      || current.terminal !== native.receiver
      || current.currentTarget !== (bubble ?? capture).nativeCurrentTarget
      || !arraysMatch(current.path, native.path)
      || Object.entries(native.values).some(([field, value]) => !Object.is(current.values[field], value))
      || capture.nativeEvent !== native.event
      || capture.currentTarget !== authority.input
      || capture.target !== authority.input
    ) return false;
    const retainedCapture = publication.wrappers?.get(capture.event);
    if (pair.capture ? retainedCapture !== capture : retainedCapture !== undefined) return false;
    const wrappersAreCurrent = !bubble || (
      pair.capture === capture
      && bubble.nativeEvent === native.event
      && bubble.currentTarget === authority.form
      && bubble.target === authority.input
      && (claimed
        ? publication.wrappers?.get(bubble.event) === bubble
        : !publication.wrappers?.has(bubble.event))
    );
    return wrappersAreCurrent
      && renameEscapePublicationIsCurrent(authority)
      && renameEscapeIsCurrent(authority)
      && publication.current?.get(native.event) === pair
      && publication.claimedEvents?.has(native.event) === claimed
      && !publication.retiredEvents?.has(native.event)
      && authority.claimed === claimed
      && !consumedCommits.current.has(authority.commit)
      && !dispatchingCommits.current.has(authority.commit)
      && renameNavigationInProgress.current === null
      && !authority.navigation.publicCallActive;
  };
  const renameEscapeContextIsCurrent = (
    pair: PendingRenameEscape,
    capture: RenameEscapeReactProof,
    bubble: RenameEscapeReactProof | null,
    claimed = false,
    prevented = false,
    defaultQuery = bubble?.methods.isDefaultPrevented,
  ) => renameEscapePairIsCurrent(pair, capture, bubble, claimed, prevented)
    && renameEscapeReactIsCurrent(pair, capture, bubble ? null : pair.authority.input, false)
    && (!bubble || renameEscapeReactIsCurrent(
      pair, bubble, pair.authority.form, prevented, defaultQuery,
    ))
    && renameEscapePairIsCurrent(pair, capture, bubble, claimed, prevented);
  const queryRenameEscape = (
    pair: PendingRenameEscape,
    capture: RenameEscapeReactProof,
    bubble: RenameEscapeReactProof | null,
    proof: RenameEscapeReactProof,
    method: "isDefaultPrevented" | "isPropagationStopped",
    claimed = false,
    prevented = false,
    defaultQuery = bubble?.methods.isDefaultPrevented,
  ) => {
    if (!renameEscapeContextIsCurrent(pair, capture, bubble, claimed, prevented, defaultQuery)) {
      return false;
    }
    const expected = proof === bubble && method === "isDefaultPrevented"
      ? defaultQuery
      : proof.methods[method];
    const callback = proof.event[method];
    if (
      callback !== expected
      || typeof callback !== "function"
      || !renameEscapeRouteActive.current
      || !renameEscapePairIsCurrent(pair, capture, bubble, claimed, prevented)
    ) return false;
    const result = pair.authority.keyboard.apply(callback, proof.event, []);
    return result === (proof === bubble && method === "isDefaultPrevented" && prevented)
      && renameEscapeContextIsCurrent(pair, capture, bubble, claimed, prevented, defaultQuery);
  };
  const establishRenameEscape = (
    commit: RowCommit,
    settlingInput: HTMLInputElement | null = null,
  ) => {
    const visit = commit.facts.renameVisit;
    const draft = commit.facts.draft;
    const input = commit.input;
    const form = commit.form;
    const save = commit.save;
    const cancel = commit.cancel;
    const ownerWindow = commit.ownerDocument.defaultView;
    if (
      !visit
      || draft === null
      || !input
      || !form
      || !save
      || !cancel
      || !commit.facts.inputEligible
      || !commit.facts.save
      || !commit.facts.cancel?.eligible
      || !ownerWindow?.MutationObserver
      || renameRefReplay.current !== null
      || partialRenameRefElements.current.has(commit.row)
      || partialRenameRefElements.current.has(form)
      || partialRenameRefElements.current.has(input)
      || (commit.save ? partialRenameRefElements.current.has(commit.save) : false)
      || (commit.cancel ? partialRenameRefElements.current.has(commit.cancel) : false)
    ) {
      return;
    }
    const placement = snapshotSecretNoticePlacement(commit.row);
    const keyboard = captureTokenRenameKeyboardAuthority(commit.ownerDocument, ownerWindow);
    if (!placement || !keyboard) return;
    const history = new TokenRenameMutationHistory(
      ownerWindow,
      commit.row,
      placement,
      settlingInput,
    );
    const controls = Object.freeze([
      Object.freeze<RenameNavigationControl>({
        identity: Symbol("token-rename-save-navigation"),
        role: "save",
        index: 0,
        ownerIdentity: candidate.save.identity,
        action: commit.facts.save,
        element: save,
      }),
      Object.freeze<RenameNavigationControl>({
        identity: Symbol("token-rename-cancel-navigation"),
        role: "cancel",
        index: 1,
        ownerIdentity: candidate.cancel.identity,
        action: commit.facts.cancel,
        element: cancel,
      }),
    ]);
    const publication: RenameNavigationPublication = {
      identity: Symbol("token-rename-navigation-publication"),
      target: ownerWindow,
      listener: function (this: EventTarget, event: Event) {
        const current = publication.current;
        const seen = publication.seen;
        if (
          !current
          || !seen
          || publication.publicCallActive
          || publication.retired
          || claimedRenameNativeEvents.current.has(event)
          || renameNavigationInProgress.current !== null
        ) {
          return;
        }
        const existing = current.get(event as KeyboardEvent);
        if (existing) {
          const replay = readRenameNavigationNativeAtWindow(
            authority,
            publication,
            this,
            event,
          );
          if (replay) {
            current.set(event as KeyboardEvent, Object.freeze({
              ...existing,
              replayed: true,
            }));
          }
          return;
        }
        if (seen.has(event)) return;
        const pair = readRenameNavigationNativeAtWindow(
          authority,
          publication,
          this,
          event,
        );
        if (
          !pair
          || publication.current !== current
          || publication.seen !== seen
          || !renameNavigationPublicationIsCurrent(authority, publication)
        ) {
          return;
        }
        seen.add(event);
        current.set(pair.native.event, pair);
      },
      add: keyboard.addEventListener,
      remove: keyboard.removeEventListener,
      capture: true,
      current: new WeakMap(),
      seen: new WeakSet(),
      attached: false,
      publicCallActive: false,
      retired: false,
    };
    Object.seal(publication);
    const escape: RenameEscapePublication = {
      target: ownerWindow,
      listener: function (this: EventTarget, event: Event) {
        if (
          renameEscapeRouteActive.current
          || !renameEscapePublicationIsCurrent(authority)
          || authority.claimed
          || authority.navigation.publicCallActive
          || renameNavigationInProgress.current !== null
        ) return;
        renameEscapeRouteActive.current = true;
        try {
          const native = readRenameEscapeNative(
            authority, event as KeyboardEvent, keyboard.Event.CAPTURING_PHASE, false, this,
          );
          if (!native || !renameEscapePublicationIsCurrent(authority)) return;
          if (escape.current?.has(native.event)) {
            // Returning to Window after input delivery is replay; a duplicate Window call is not.
            if (escape.inputDeliveries?.has(native.event)) escape.retiredEvents?.add(native.event);
            return;
          }
          if (escape.retiredEvents?.has(native.event) || escape.claimedEvents?.has(native.event)) return;
          escape.current?.set(native.event, Object.freeze({
            authority,
            publication: escape,
            native,
            capture: null,
          }));
        } catch {
          return;
        } finally {
          renameEscapeRouteActive.current = false;
        }
      },
      add: keyboard.addEventListener,
      remove: keyboard.removeEventListener,
      current: new WeakMap(),
      wrappers: new WeakMap(),
      inputDeliveries: new WeakSet(),
      retiredEvents: new WeakSet(),
      claimedEvents: new WeakSet(),
      attached: false,
    };
    Object.seal(escape);
    const authority: RenameEscapeAuthority = {
      identity: Symbol("token-rename-escape-authority"),
      mount,
      panel: commit.facts.panel,
      candidate,
      commit,
      visit,
      token: commit.facts.token,
      persistedName: commit.facts.token.name,
      draft,
      callback: commit.facts.onAction,
      update: commit.facts.panel.update,
      input,
      form,
      controls,
      ownerDocument: commit.ownerDocument,
      keyboard,
      dom: snapshotSecretNoticeDom(commit.row),
      placement,
      history,
      navigation: publication,
      escape,
      claimed: false,
      retired: false,
    };
    Object.seal(authority);
    const previous = activeRenameEscape.current;
    if (previous) retireRenameEscape(previous);
    activeRenameEscape.current = authority;
    if (
      activeCommit.current !== commit
      || !factsAreCurrent(commit.facts)
      || !history.isPristine()
      || !domIsExact(commit)
      || !secretNoticePlacementMatches(commit.row, commit.ownerDocument, placement)
    ) {
      retireRenameEscape(authority);
      return;
    }
    try {
      keyboard.apply(
        publication.add,
        publication.target,
        ["keydown", publication.listener, publication.capture],
      );
      publication.attached = true;
      keyboard.apply(escape.add, escape.target, ["keydown", escape.listener, true]);
      escape.attached = true;
      if (!renameAuthorityIsCurrent(authority)) retireRenameEscape(authority);
    } catch {
      retireRenameEscape(authority);
    }
  };
  const stageRenameEscape = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const authority = activeRenameEscape.current;
    if (
      renameEscapeRouteActive.current
      || !authority
      || !renameEscapePublicationIsCurrent(authority)
      || authority.claimed
    ) return;
    const publication = authority.escape;
    renameEscapeRouteActive.current = true;
    try {
      const nativeEvent = event.nativeEvent;
      if (!renameEscapePublicationIsCurrent(authority)) return;
      const pair = publication.current?.get(nativeEvent);
      if (!pair || pair.capture || publication.wrappers?.has(event)) return;
      const capture = readRenameEscapeReact(
        event, pair, authority.input, authority.keyboard.Event.CAPTURING_PHASE,
      );
      if (!capture || capture.nativeCurrentTarget === pair.native.receiver) return;
      publication.inputDeliveries?.add(nativeEvent);
      if (
        !queryRenameEscape(pair, capture, null, capture, "isDefaultPrevented")
        || !queryRenameEscape(pair, capture, null, capture, "isPropagationStopped")
        || !renameEscapeContextIsCurrent(pair, capture, null)
      ) return;
      publication.wrappers?.set(event, capture);
      publication.current?.set(nativeEvent, Object.freeze({ ...pair, capture }));
    } catch {
      return;
    } finally {
      renameEscapeRouteActive.current = false;
    }
  };
  const renameNavigationClaimIsCurrent = (
    claim: ClaimedRenameNavigation,
    expectedDefaultPrevented: boolean,
    bubbleDefaultQuery?: RenameNavigationReactMethod,
  ) => claim === renameNavigationInProgress.current
    && claim.authority === claim.pair.authority
    && claim.publication === claim.pair.publication
    && claim.native === claim.pair.native
    && claim.terminal === claim.pair.terminal
    && claim.capture === claim.pair.reactCapture
    && claim.bubble === claim.pair.reactBubble
    && claim.visit === claim.authority.visit
    && claim.token === claim.authority.token
    && claim.draft === claim.authority.draft
    && claim.callback === claim.authority.callback
    && claim.controls === claim.authority.controls
    && claim.source === claim.pair.source
    && claim.destination === claim.pair.destination
    && claim.movement === claim.pair.movement
    && claimedRenameNavigationPairs.current.has(claim.pair)
    && claimedRenameNavigationMovements.current.has(claim.movement)
    && claimedRenameTerminalProofs.current.has(claim.terminal)
    && claimedRenameReactEvents.current.has(claim.capture.event)
    && claimedRenameReactEvents.current.has(claim.bubble.event)
    && claimedRenameNativeEvents.current.has(claim.native.event)
    && renameNavigationContextIsCurrent(
      claim.pair,
      claim.authority.keyboard.Event.BUBBLING_PHASE,
      expectedDefaultPrevented,
      claim.capture,
      claim.bubble,
      bubbleDefaultQuery,
    );
  const claimRenameNavigation = (
    pair: PendingRenameNavigation,
  ): ClaimedRenameNavigation | null => {
    const capture = pair.reactCapture;
    const bubble = pair.reactBubble;
    const current = pair.publication.current;
    if (
      !capture
      || !bubble
      || capture.event === bubble.event
      || !current
      || current.get(pair.native.event) !== pair
      || pair.replayed
      || renameNavigationInProgress.current !== null
      || claimedRenameNavigationPairs.current.has(pair)
      || claimedRenameNavigationMovements.current.has(pair.movement)
      || claimedRenameTerminalProofs.current.has(pair.terminal)
      || claimedRenameReactEvents.current.has(capture.event)
      || claimedRenameReactEvents.current.has(bubble.event)
      || claimedRenameNativeEvents.current.has(pair.native.event)
      || !renameNavigationContextIsCurrent(
        pair,
        pair.authority.keyboard.Event.BUBBLING_PHASE,
        false,
        capture,
        bubble,
      )
    ) {
      return null;
    }
    const claim = Object.freeze<ClaimedRenameNavigation>({
      pair,
      authority: pair.authority,
      publication: pair.publication,
      native: pair.native,
      terminal: pair.terminal,
      capture,
      bubble,
      visit: pair.authority.visit,
      token: pair.authority.token,
      draft: pair.authority.draft,
      callback: pair.authority.callback,
      controls: pair.authority.controls,
      source: pair.source,
      destination: pair.destination,
      movement: pair.movement,
    });
    if (!current.delete(pair.native.event)) return null;
    claimedRenameNavigationPairs.current.add(pair);
    claimedRenameNavigationMovements.current.add(pair.movement);
    claimedRenameTerminalProofs.current.add(pair.terminal);
    claimedRenameReactEvents.current.add(capture.event);
    claimedRenameReactEvents.current.add(bubble.event);
    claimedRenameNativeEvents.current.add(pair.native.event);
    renameNavigationInProgress.current = claim;
    if (renameNavigationClaimIsCurrent(claim, false)) return claim;
    if (renameNavigationInProgress.current === claim) {
      renameNavigationInProgress.current = null;
    }
    return null;
  };
  const preventAndFocusRenameNavigation = (claim: ClaimedRenameNavigation) => {
    const { authority, bubble, destination, pair } = claim;
    try {
      if (!renameNavigationClaimIsCurrent(claim, false)) return;
      const prevented = invokeRenameNavigationPublic(
        pair,
        bubble.methods.preventDefault,
        bubble.event,
      );
      if (!prevented) return;
      let currentDefaultQuery: RenameNavigationReactMethod;
      try {
        currentDefaultQuery = (
          bubble.event.isDefaultPrevented as RenameNavigationReactMethod
        );
      } catch {
        return;
      }
      if (
        typeof currentDefaultQuery !== "function"
        || bubble.event.preventDefault !== bubble.methods.preventDefault
        || bubble.event.isPropagationStopped !== bubble.methods.isPropagationStopped
        || !renameNavigationClaimIsCurrent(claim, true, currentDefaultQuery)
      ) {
        return;
      }
      const defaultResult = invokeRenameNavigationPublic(
        pair,
        currentDefaultQuery,
        bubble.event,
      );
      if (
        defaultResult?.value !== true
        || !renameNavigationClaimIsCurrent(claim, true, currentDefaultQuery)
      ) {
        return;
      }
      const propagationResult = invokeRenameNavigationPublic(
        pair,
        bubble.methods.isPropagationStopped,
        bubble.event,
      );
      if (
        propagationResult?.value !== false
        || !renameNavigationClaimIsCurrent(claim, true, currentDefaultQuery)
      ) {
        return;
      }
      authority.keyboard.apply(
        authority.keyboard.focus,
        destination.element,
        [TOKEN_RENAME_PREVENT_SCROLL],
      );
    } finally {
      if (renameNavigationInProgress.current === claim) {
        renameNavigationInProgress.current = null;
      }
    }
  };
  const stageRenameNavigation = (
    event: RenameNavigationReactEvent,
    nativeEvent: KeyboardEvent,
    authority: RenameEscapeAuthority,
  ) => {
    const publication = authority?.navigation;
    const current = publication?.current;
    const pair = current?.get(nativeEvent);
    if (
      !authority
      || !publication
      || !current
      || !pair
      || pair.authority !== authority
      || pair.publication !== publication
      || pair.native.event !== nativeEvent
      || pair.reactCapture
      || pair.reactBubble
      || pair.replayed
      || event.currentTarget !== authority.form
      || claimedRenameReactEvents.current.has(event)
      || claimedRenameNativeEvents.current.has(nativeEvent)
      || renameNavigationInProgress.current !== null
      || publication.publicCallActive
    ) {
      return;
    }
    const reactCapture = readRenameNavigationReactProof(
      event,
      pair,
      authority.keyboard.Event.CAPTURING_PHASE,
    );
    if (
      !reactCapture
      || !validateRenameNavigationQuery(
        pair,
        reactCapture,
        authority.keyboard.Event.CAPTURING_PHASE,
        reactCapture,
        null,
        "isDefaultPrevented",
        false,
      )
      || !validateRenameNavigationQuery(
        pair,
        reactCapture,
        authority.keyboard.Event.CAPTURING_PHASE,
        reactCapture,
        null,
        "isPropagationStopped",
        false,
      )
      || current.get(nativeEvent) !== pair
      || !renameNavigationContextIsCurrent(
        pair,
        authority.keyboard.Event.CAPTURING_PHASE,
        false,
        reactCapture,
        null,
      )
    ) {
      return;
    }
    current.set(nativeEvent, Object.freeze({
      ...pair,
      reactCapture,
    }));
  };
  const deliverRenameNavigation = (
    event: RenameNavigationReactEvent,
    nativeEvent: KeyboardEvent,
    authority: RenameEscapeAuthority,
  ) => {
    const publication = authority?.navigation;
    const current = publication?.current;
    const pair = current?.get(nativeEvent);
    if (
      !authority
      || !publication
      || !current
      || !pair
      || pair.authority !== authority
      || pair.publication !== publication
      || pair.native.event !== nativeEvent
      || !pair.reactCapture
      || pair.reactBubble
      || pair.replayed
      || authority.form !== event.currentTarget
      || claimedRenameReactEvents.current.has(event)
      || claimedRenameNativeEvents.current.has(nativeEvent)
      || renameNavigationInProgress.current !== null
      || publication.publicCallActive
    ) {
      return;
    }
    const reactBubble = readRenameNavigationReactProof(
      event,
      pair,
      authority.keyboard.Event.BUBBLING_PHASE,
    );
    const reactCapture = pair.reactCapture;
    if (
      !reactBubble
      || reactBubble.event === reactCapture.event
      || !validateRenameNavigationQuery(
        pair,
        reactBubble,
        authority.keyboard.Event.BUBBLING_PHASE,
        reactCapture,
        reactBubble,
        "isDefaultPrevented",
        false,
      )
      || !validateRenameNavigationQuery(
        pair,
        reactBubble,
        authority.keyboard.Event.BUBBLING_PHASE,
        reactCapture,
        reactBubble,
        "isPropagationStopped",
        false,
      )
      || current.get(nativeEvent) !== pair
      || !renameNavigationContextIsCurrent(
        pair,
        authority.keyboard.Event.BUBBLING_PHASE,
        false,
        reactCapture,
        reactBubble,
      )
    ) {
      return;
    }
    const complete = Object.freeze<PendingRenameNavigation>({
      ...pair,
      reactBubble,
    });
    current.set(nativeEvent, complete);
    const claim = claimRenameNavigation(complete);
    if (claim) preventAndFocusRenameNavigation(claim);
  };
  const deliverRenameEscape = (
    event: ReactKeyboardEvent<HTMLFormElement>,
    nativeEvent: KeyboardEvent,
    authority: RenameEscapeAuthority,
  ) => {
    if (
      !renameEscapeRouteActive.current
      || !renameEscapePublicationIsCurrent(authority)
      || authority.claimed
    ) return;
    const publication = authority.escape;
    let claimed = false;
    try {
      const pair = publication.current?.get(nativeEvent);
      const capture = pair?.capture;
      if (!pair || !capture || publication.wrappers?.has(event)) return;
      const bubble = readRenameEscapeReact(
        event, pair, authority.form, authority.keyboard.Event.BUBBLING_PHASE,
      );
      if (!bubble) return;
      for (const proof of [capture, bubble]) {
        for (const method of ["isDefaultPrevented", "isPropagationStopped"] as const) {
          if (!queryRenameEscape(pair, capture, bubble, proof, method)) return;
        }
      }
      if (!renameEscapeContextIsCurrent(pair, capture, bubble)) return;
      const preventDefault = bubble.event.preventDefault;
      if (
        preventDefault !== bubble.methods.preventDefault
        || !renameEscapePairIsCurrent(pair, capture, bubble)
      ) return;

      // The complete immutable pair claims this publication only at the effect boundary.
      publication.wrappers?.set(event, bubble);
      publication.claimedEvents?.add(pair.native.event);
      authority.claimed = true;
      claimed = true;
      if (!renameEscapePairIsCurrent(pair, capture, bubble, true)) return;
      authority.keyboard.apply(preventDefault, bubble.event, []);

      // React DOM replaces only this query as part of its public prevention method.
      if (!renameEscapePublicationIsCurrent(authority)) return;
      const defaultQuery = bubble.event.isDefaultPrevented as RenameNavigationReactMethod;
      if (
        !renameEscapeContextIsCurrent(pair, capture, bubble, true, true, defaultQuery)
        || !queryRenameEscape(pair, capture, bubble, bubble, "isDefaultPrevented", true, true, defaultQuery)
        || !queryRenameEscape(pair, capture, bubble, bubble, "isPropagationStopped", true, true, defaultQuery)
        || !renameEscapeContextIsCurrent(pair, capture, bubble, true, true, defaultQuery)
      ) return;
      consumedCommits.current.add(authority.commit);
      retireRenameEscape(authority);
      closeRename(authority.commit, true);
    } catch {
      return;
    } finally {
      if (claimed) authority.claimed = false;
    }
  };
  const routeRenameKeyDown = (
    event: RenameNavigationReactEvent,
    phase: "capture" | "bubble",
  ) => {
    if (renameEscapeRouteActive.current) return;
    const authority = activeRenameEscape.current;
    if (!authority || !renameEscapePublicationIsCurrent(authority)) return;
    // Own exclusion before either route can read a reentrant public accessor.
    renameEscapeRouteActive.current = true;
    try {
      const nativeEvent = event.nativeEvent;
      if (!renameEscapePublicationIsCurrent(authority)) return;
      if (phase === "capture") {
        stageRenameNavigation(event, nativeEvent, authority);
      } else {
        deliverRenameNavigation(event, nativeEvent, authority);
        if (!renameEscapePublicationIsCurrent(authority)) return;
        deliverRenameEscape(event, nativeEvent, authority);
      }
    } catch {
      return;
    } finally {
      renameEscapeRouteActive.current = false;
    }
  };
  const clickControl = (
    commit: RowCommit,
    kind: Exclude<RowActionKind, "save">,
  ): { button: HTMLButtonElement | null; targets: readonly Node[] | null; action: RowActionFacts | null } => {
    if (kind === "rename") return { button: commit.rename, targets: commit.renameTargets, action: commit.facts.rename };
    if (kind === "replace") return { button: commit.replace, targets: commit.replaceTargets, action: commit.facts.replace };
    if (kind === "revoke") return { button: commit.revoke, targets: commit.revokeTargets, action: commit.facts.revoke };
    return { button: commit.cancel, targets: commit.cancelTargets, action: commit.facts.cancel };
  };
  const claimClick = (
    event: ReactMouseEvent<HTMLButtonElement>,
    kind: Exclude<RowActionKind, "save">,
    consume: boolean,
  ) => {
    const commit = currentCommit(candidate);
    if (!commit) return null;
    const { button, targets, action: expectedAction } = clickControl(commit, kind);
    const ownerWindow = commit.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !button
      || !expectedAction?.eligible
      || !ownerWindow
      || event.type !== "click"
      || event.button !== 0
      || event.currentTarget !== button
      || event.defaultPrevented
      || !(nativeEvent instanceof ownerWindow.MouseEvent)
      || nativeEvent.type !== "click"
      || nativeEvent.button !== 0
      || nativeEvent.defaultPrevented
      || !(target instanceof ownerWindow.Node)
      || nativeEvent.target !== target
      || target.ownerDocument !== commit.ownerDocument
      || !button.contains(target)
      || targets?.includes(target) !== true
      || button.disabled
      || button.getAttribute("aria-disabled") === "true"
      || claimedEvents.current.has(event)
      || claimedEvents.current.has(nativeEvent)
      || consumedCommits.current.has(commit)
      || dispatchingCommits.current.has(commit)
    ) {
      return null;
    }
    claimedEvents.current.add(event);
    claimedEvents.current.add(nativeEvent);
    if (consume) consumedCommits.current.add(commit);
    else dispatchingCommits.current.add(commit);
    return commit;
  };
  const claimInput = (event: ChangeEvent<HTMLInputElement>) => {
    const input = candidate.input.element;
    const ownerWindow = input?.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const next = event.currentTarget.value;
    if (
      !input
      || !ownerWindow
      || (event.type !== "input" && event.type !== "change")
      || event.currentTarget !== input
      || event.target !== input
      || event.defaultPrevented
      || !(nativeEvent instanceof ownerWindow.Event)
      || (nativeEvent.type !== "input" && nativeEvent.type !== "change")
      || nativeEvent.target !== input
      || nativeEvent.defaultPrevented
      || next !== input.value
    ) {
      return null;
    }
    const commit = currentCommit(candidate, { input, value: next });
    if (
      !commit
      || commit.input !== input
      || !commit.facts.inputEligible
      || next === commit.facts.draft
      || claimedEvents.current.has(event)
      || claimedEvents.current.has(nativeEvent)
      || consumedCommits.current.has(commit)
      || dispatchingCommits.current.has(commit)
    ) {
      return null;
    }
    claimedEvents.current.add(event);
    claimedEvents.current.add(nativeEvent);
    consumedCommits.current.add(commit);
    const visit = commit.facts.renameVisit;
    if (visit) {
      controlledInputUpdate.current = Object.freeze({
        commit,
        visit,
        input,
        value: next,
      });
    }
    return { commit, next };
  };
  const claimSubmit = (event: FormEvent<HTMLFormElement>) => {
    const form = candidate.form.element;
    const ownerWindow = form?.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    if (
      !form
      || !ownerWindow?.SubmitEvent
      || event.type !== "submit"
      || event.currentTarget !== form
      || event.target !== form
      || event.defaultPrevented
      || !(nativeEvent instanceof ownerWindow.SubmitEvent)
      || nativeEvent.type !== "submit"
      || nativeEvent.target !== form
      || nativeEvent.defaultPrevented
    ) {
      return null;
    }
    const commit = currentCommit(candidate);
    const submitter = nativeEvent.submitter;
    if (
      !commit
      || commit.form !== form
      || !commit.save
      || !commit.facts.save?.eligible
      || (submitter !== null && submitter !== commit.save)
      || commit.save.disabled
      || commit.save.getAttribute("aria-disabled") === "true"
      || claimedEvents.current.has(event)
      || claimedEvents.current.has(nativeEvent)
      || consumedCommits.current.has(commit)
      || dispatchingCommits.current.has(commit)
    ) {
      return null;
    }
    claimedEvents.current.add(event);
    claimedEvents.current.add(nativeEvent);
    consumedCommits.current.add(commit);
    return commit;
  };
  const closeRename = (commit: RowCommit, preventScroll = false) => {
    const visit = commit.facts.renameVisit;
    if (!visit) return;
    returnFocus.current = Object.freeze({ mount, visit, tokenId: commit.facts.token.id, preventScroll });
    setRenameDraft((current) => current?.visit === visit ? null : current);
  };
  const retireRenameLayout = (value: RowCandidate) => {
    retireCandidate(value);
    const replay = renameRefReplay.current;
    if (!replay || replay.candidate !== value) return;
    const row = replay.expected.find(({ role }) => role === "row");
    if (
      replay.invalid
      || replay.layoutRetired
      || replay.expected.length !== 5
      || !row
      || row.ownerIdentity !== value.row.identity
    ) {
      quarantineRenameRefReplay(replay);
      return;
    }
    if (value.row.element === row.element) {
      if (replay.released.has(row.element) || replay.rebound.has(row.element)) {
        quarantineRenameRefReplay(replay);
        return;
      }
      replay.released.add(row.element);
      replay.rebound.add(row.element);
    } else if (
      value.row.element !== null
      || !replay.released.has(row.element)
      || replay.rebound.has(row.element)
    ) {
      quarantineRenameRefReplay(replay);
      return;
    }
    replay.layoutRetired = true;
    if (renameRefReplayComplete(replay)) completeRenameRefReplay(replay);
  };
  const recoverRenameLayout = (value: RowCandidate): RowCommit | null => {
    const completion = completedRenameRefReplay.current;
    const replayResult = consumeCompletedRenameRefReplay(value);
    if (replayResult === "mismatched") return null;
    const existing = currentCommit(value);
    if (existing) return existing;
    const commit = buildCommit();
    if (
      !commit
      || commit.candidate !== value
      || !factsAreCurrent(commit.facts)
      || activeCommit.current !== null
    ) {
      return null;
    }
    const inputUpdate = controlledInputUpdate.current;
    const settlingInput = replayResult === "matched"
      && completion
      && inputUpdate
      && inputUpdate.commit.candidate === completion.source
      && completion.bindings.some(({ role, element }) =>
        role === "input" && element === inputUpdate.input)
      && inputUpdate.visit === commit.facts.renameVisit
      && inputUpdate.value === commit.facts.draft
      ? inputUpdate.input
      : null;
    if (inputUpdate && (settlingInput || inputUpdate.commit.candidate === value)) {
      controlledInputUpdate.current = null;
    }
    activeCommit.current = commit;
    establishRowNavigation(commit);
    establishRenameEscape(commit, settlingInput);
    return commit;
  };
  const renameLayoutCycle = Object.freeze<TokenRenameLayoutCycle>({
    setup: () => recoverRenameLayout(candidate),
    cleanup: () => retireRenameLayout(candidate),
  });

  useLayoutEffect(() => {
    activeMount.current = mount;
    return () => {
      if (activeMount.current === mount) activeMount.current = null;
      const current = activeCommit.current;
      if (current?.facts.mount === mount) retireCandidate(current.candidate);
      const renameEscape = activeRenameEscape.current;
      if (renameEscape?.mount === mount) retireRenameEscape(renameEscape);
      const rowNavigation = activeRowNavigation.current;
      if (rowNavigation?.mount === mount) retireRowNavigation(rowNavigation);
      const replay = renameRefReplay.current;
      if (replay?.candidate.facts.mount === mount) quarantineRenameRefReplay(replay);
      controlledInputUpdate.current = null;
      renameNavigationInProgress.current = null;
      if (saveOwner.current?.mount === mount) saveOwner.current = null;
      if (returnFocus.current?.mount === mount) returnFocus.current = null;
    };
  // The teardown owns the complete lifetime of this immutable mount identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mount]);
  useLayoutEffect(() => {
    const commit = recoverRenameLayout(candidate);
    if (!commit || !factsAreCurrent(facts)) return;
    return () => {
      if (
        activeCommit.current === commit
        || renameRefReplay.current?.candidate === candidate
      ) {
        retireRenameLayout(candidate);
      }
      else {
        const renameEscape = activeRenameEscape.current;
        if (renameEscape?.commit === commit) retireRenameEscape(renameEscape);
      }
    };
  });
  useLayoutEffect(() => {
    if (!renameDraft) {
      focusedRename.current = null;
      return;
    }
    const commit = currentCommit(candidate);
    if (
      commit?.facts.renameVisit === renameDraft.visit
      && commit.input?.isConnected
      && (focusedRename.current?.visit !== renameDraft.visit || focusedRename.current.input !== commit.input)
    ) {
      focusedRename.current = { visit: renameDraft.visit, input: commit.input };
      commit.input.focus();
    }
  });
  useLayoutEffect(() => {
    if (!matching) {
      focusedMatch.current = null;
      return;
    }
    const commit = currentCommit(candidate);
    if (!commit || focusedMatch.current === commit.row) return;
    focusedMatch.current = commit.row;
    commit.row.focus();
    commit.row.scrollIntoView?.({ block: "nearest" });
  });
  useLayoutEffect(() => {
    const intent = returnFocus.current;
    if (!intent) return;
    const commit = currentCommit(candidate);
    if (
      !commit
      || commit.facts.renameVisit
      || commit.facts.mount !== intent.mount
      || commit.facts.token.id !== intent.tokenId
      || !commit.rename
      || !commit.facts.rename?.eligible
    ) {
      return;
    }
    returnFocus.current = null;
    if (intent.preventScroll) commit.rename.focus(TOKEN_RENAME_PREVENT_SCROLL);
    else commit.rename.focus();
  });

  return (
    <li ref={(element) => bindElement(candidate.row, element)} tabIndex={-1} className={facts.rowClassName}
      data-testid="token-row" data-token-match={facts.matching || undefined}>
      <div ref={(element) => bindElement(candidate.header, element)} className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 wrap-anywhere text-sm font-semibold text-ink">{facts.token.name}</span>
        <ScopeChip scope={facts.token.scope} /><span className="text-xs text-ink-3">{facts.state}</span>
        <span className="text-xs text-ink-3" data-testid="token-documents-count">{facts.documentCount}</span>
      </div>
      <p ref={(element) => bindElement(candidate.metadata, element)} className="text-xs text-ink-3">{facts.metadata}</p>
      {facts.mismatchText && <p ref={(element) => bindElement(candidate.mismatch, element)} className="text-xs text-ink-2">{facts.mismatchText}</p>}
      {facts.expiredText && <p ref={(element) => bindElement(candidate.expired, element)} className="text-xs text-ink-3">{facts.expiredText}</p>}
      {facts.actionsVisible && <div ref={(element) => bindElement(candidate.actions, element)} className="flex flex-wrap gap-2"
        role="group" aria-label={facts.actionsLabel} onKeyDownCapture={stageRowNavigation}>
        <button ref={(element) => bindElement(candidate.rename, element)} type="button" className="btn btn-outline btn-sm"
          onKeyDown={(event) => deliverRowNavigation("rename", event)}
          disabled={!facts.rename?.eligible} onClick={(event) => {
            const commit = claimClick(event, "rename", true);
            if (!commit) return;
            const visit = Object.freeze<RenameVisit>({
              identity: Symbol("token-row-rename"),
              mount,
              tokenId: commit.facts.token.id,
            });
            setRenameDraft(Object.freeze({ visit, value: commit.facts.token.name }));
          }} aria-label={facts.renameLabel}>Rename</button>
        <button ref={(element) => bindElement(candidate.replace, element)} type="button" className="btn btn-outline btn-sm"
          onKeyDown={(event) => deliverRowNavigation("replace", event)}
          disabled={!facts.replace?.eligible} onClick={(event) => {
            const commit = claimClick(event, "replace", false);
            if (!commit) return;
            try {
              void commit.facts.onAction("replace");
            } finally {
              dispatchingCommits.current.delete(commit);
            }
          }} aria-label={facts.replaceLabel}>Replace</button>
        <button ref={(element) => bindElement(candidate.revoke, element)} type="button" className="btn btn-outline btn-sm text-danger"
          onKeyDown={(event) => deliverRowNavigation("revoke", event)}
          disabled={!facts.revoke?.eligible} onClick={(event) => {
            const commit = claimClick(event, "revoke", false);
            if (!commit) return;
            try {
              void commit.facts.onAction("revoke");
            } finally {
              dispatchingCommits.current.delete(commit);
            }
          }} aria-label={facts.revokeLabel} data-testid="token-revoke">Revoke</button>
      </div>}
      {facts.renameVisit && <><form ref={(element) => bindElement(candidate.form, element)} className="flex min-w-0 flex-col gap-2"
        onKeyDownCapture={(event) => routeRenameKeyDown(event, "capture")}
        onKeyDown={(event) => routeRenameKeyDown(event, "bubble")}
        onSubmit={(event) => {
          const commit = claimSubmit(event);
          const visit = commit?.facts.renameVisit;
          const name = commit?.facts.draft;
          if (!commit || !visit || typeof name !== "string" || saveOwner.current) return;
          const owner = Object.freeze<SaveOwner>({
            mount,
            visit,
            token: commit.facts.token.source,
            callback: commit.facts.onAction,
            name,
            commit,
          });
          saveOwner.current = owner;
          event.preventDefault();
          const settlement = owner.callback("rename", owner.name);
          void settlement.then((ok) => {
            if (saveOwner.current !== owner || activeMount.current !== owner.mount) return;
            const current = activeCommit.current;
            if (
              !current
              || current.facts.mount !== owner.mount
              || current.facts.renameVisit !== owner.visit
              || current.facts.token.id !== owner.token.id
            ) {
              saveOwner.current = null;
              return;
            }
            saveOwner.current = null;
            if (ok) closeRename(current);
          });
        }}>
        <label className="text-xs text-ink-2">Token name<input ref={(element) => bindElement(candidate.input, element)}
          className="input mt-1 w-full min-w-0" value={facts.draft ?? ""} maxLength={80} disabled={!facts.inputEligible}
          onKeyDownCapture={stageRenameEscape}
          onChange={(event) => {
            const claimed = claimInput(event);
            if (!claimed || !claimed.commit.facts.renameVisit) return;
            setRenameDraft(Object.freeze({ visit: claimed.commit.facts.renameVisit, value: claimed.next }));
          }} /></label>
        <p className="text-xs text-ink-3">This changes the agent name and @mention, not its secret or permissions.</p>
        <div className="flex flex-wrap gap-2">
          <button ref={(element) => bindElement(candidate.save, element)} type="submit" className="btn btn-primary btn-sm" disabled={!facts.save?.eligible}>Save name</button>
          <button ref={(element) => bindElement(candidate.cancel, element)} type="button" className="btn btn-ghost btn-sm"
            disabled={!facts.cancel?.eligible} onClick={(event) => {
              const commit = claimClick(event, "cancel", true);
              if (commit) closeRename(commit);
            }}>Cancel rename</button>
        </div>
      </form><TokenRenameLayoutBoundary cycle={renameLayoutCycle} /></>}
      <details ref={(element) => bindElement(candidate.details, element)} className="min-w-0 text-xs text-ink-3">
        <summary className="cursor-pointer">Details &amp; agent requests</summary>
        <div ref={(element) => bindElement(candidate.detailsBody, element)} className="mt-2 flex min-w-0 flex-col gap-2 break-words">
          <p className="break-all">{facts.prefixDetails}</p>
          <p>{facts.timeDetails}</p>
          <p>{facts.mcpDetails}</p>
          {facts.revokedDetails && <p>{facts.revokedDetails}</p>}
          {facts.documentDetails && <p className="break-all">{facts.documentDetails}</p>}
          {facts.actionsVisible && <div className="flex items-start gap-2">
            <button ref={(element) => bindElement(candidate.collaborators, element)} type="button" role="switch"
              aria-checked={facts.token.collaboratorsMayAsk === true} aria-labelledby={facts.switchLabelId}
              aria-describedby={facts.switchHelpId} className="switch mt-px" disabled={facts.disabled}
              onClick={facts.onCollaboratorsChange} data-testid="token-collaborators-may-ask" />
            <div><span id={facts.switchLabelId} className="font-medium text-ink-2">Collaborators may ask this agent</span>
              <p id={facts.switchHelpId}>Off: only you can send requests to it. On: people you share documents with can too.</p>
            </div>
          </div>}
        </div>
      </details>
      {facts.switchError && <p ref={(element) => bindElement(candidate.switchError, element)} className="text-xs text-danger"
        role="alert" aria-atomic="true" data-testid="token-collaborators-may-ask-error">{facts.switchError}</p>}
    </li>
  );
}
