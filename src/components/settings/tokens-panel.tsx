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
  | "cancelBubble";
type TokenRenameKeyboardField =
  | "key"
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
  readonly Node: typeof Node;
  readonly event: TokenRenameGetterAuthority<TokenRenameEventField>["getters"];
  readonly keyboard: TokenRenameGetterAuthority<TokenRenameKeyboardField>["getters"];
  readonly view: TokenRenameNativeGetter;
  readonly composedPath: Event["composedPath"];
  readonly preventDefault: Event["preventDefault"];
  readonly trusted: TokenRenameTrustedAuthority;
  readonly apply: typeof Reflect.apply;
  readonly prototypeOf: typeof Object.getPrototypeOf;
  readonly isCurrent: () => boolean;
}

interface TokenRenameKeyboardSnapshot {
  readonly event: KeyboardEvent;
  readonly target: EventTarget;
  readonly currentTarget: EventTarget | null;
  readonly path: readonly EventTarget[];
  readonly phase: number;
  readonly view: Window | null;
  readonly trusted: boolean;
}

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
  const NodeConstructor = ownerWindow.Node;
  const eventPrototype = EventConstructor.prototype;
  const uiEventPrototype = UIEventConstructor.prototype;
  const keyboardEventPrototype = KeyboardEventConstructor.prototype;
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
  if (!event || !keyboard || !ui || !composedPath || !preventDefault) return null;
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
    && ownerWindow.Node === NodeConstructor
    && EventConstructor.prototype === eventPrototype
    && UIEventConstructor.prototype === uiEventPrototype
    && KeyboardEventConstructor.prototype === keyboardEventPrototype
    && prototypeOf(keyboardEventPrototype) === uiEventPrototype
    && prototypeOf(uiEventPrototype) === eventPrototype
    && event.isCurrent()
    && keyboard.isCurrent()
    && ui.isCurrent()
    && composedPath.isCurrent()
    && preventDefault.isCurrent()
    && trusted.isCurrent();
  if (!isCurrent()) return null;

  return Object.freeze({
    ownerDocument,
    ownerWindow,
    Event: EventConstructor,
    UIEvent: UIEventConstructor,
    KeyboardEvent: KeyboardEventConstructor,
    Node: NodeConstructor,
    event: event.getters,
    keyboard: keyboard.getters,
    view: ui.getters.view,
    composedPath: composedPath.method,
    preventDefault: preventDefault.method,
    trusted,
    apply,
    prototypeOf,
    isCurrent,
  });
}

function tokenRenameNativeValue<Value>(
  authority: TokenRenameKeyboardAuthority,
  getter: TokenRenameNativeGetter,
  event: Event,
): Value {
  return authority.apply(getter, event, []) as Value;
}

function captureTokenRenameEscape(
  authority: TokenRenameKeyboardAuthority,
  event: Event,
  input: HTMLInputElement,
): TokenRenameKeyboardSnapshot | null {
  if (
    !authority.isCurrent()
    || authority.prototypeOf(event) !== authority.KeyboardEvent.prototype
    || !authority.trusted.matches(event)
  ) {
    return null;
  }
  try {
    const type = tokenRenameNativeValue<string>(authority, authority.event.type, event);
    const target = tokenRenameNativeValue<EventTarget | null>(
      authority,
      authority.event.target,
      event,
    );
    const currentTarget = tokenRenameNativeValue<EventTarget | null>(
      authority,
      authority.event.currentTarget,
      event,
    );
    const phase = tokenRenameNativeValue<number>(
      authority,
      authority.event.eventPhase,
      event,
    );
    const path = authority.apply(authority.composedPath, event, []) as EventTarget[];
    const view = tokenRenameNativeValue<Window | null>(authority, authority.view, event);
    const trusted = authority.trusted.read(event);
    const expected: EventTarget[] = [];
    let node: Node | null = input;
    while (node) {
      expected.push(node);
      if (node === authority.ownerDocument) break;
      node = node.parentNode;
    }
    const pathWindow = path.at(-1);
    if (
      type !== "keydown"
      || tokenRenameNativeValue<string>(authority, authority.keyboard.key, event) !== "Escape"
      || tokenRenameNativeValue<boolean>(authority, authority.keyboard.repeat, event)
      || tokenRenameNativeValue<boolean>(authority, authority.keyboard.isComposing, event)
      || tokenRenameNativeValue<boolean>(authority, authority.keyboard.ctrlKey, event)
      || tokenRenameNativeValue<boolean>(authority, authority.keyboard.altKey, event)
      || tokenRenameNativeValue<boolean>(authority, authority.keyboard.metaKey, event)
      || tokenRenameNativeValue<boolean>(authority, authority.keyboard.shiftKey, event)
      || !tokenRenameNativeValue<boolean>(authority, authority.event.bubbles, event)
      || !tokenRenameNativeValue<boolean>(authority, authority.event.cancelable, event)
      || tokenRenameNativeValue<boolean>(authority, authority.event.defaultPrevented, event)
      || tokenRenameNativeValue<boolean>(authority, authority.event.cancelBubble, event)
      || (phase !== authority.Event.AT_TARGET && phase !== authority.Event.BUBBLING_PHASE)
      || target !== input
      || input.ownerDocument !== authority.ownerDocument
      || !input.isConnected
      || (view !== null && view !== authority.ownerWindow)
      || expected.at(-1) !== authority.ownerDocument
      || path.length !== expected.length + 1
      || expected.some((entry, index) => path[index] !== entry)
      || typeof pathWindow !== "object"
      || pathWindow === null
      || !("document" in pathWindow)
      || pathWindow.document !== authority.ownerDocument
      || (currentTarget !== null && !path.includes(currentTarget))
    ) {
      return null;
    }
    return Object.freeze({
      event: event as KeyboardEvent,
      target,
      currentTarget,
      path: Object.freeze([...path]),
      phase,
      view,
      trusted,
    });
  } catch {
    return null;
  }
}

function tokenRenameEscapeMatches(
  authority: TokenRenameKeyboardAuthority,
  snapshot: TokenRenameKeyboardSnapshot,
  input: HTMLInputElement,
) {
  const current = captureTokenRenameEscape(authority, snapshot.event, input);
  return Boolean(
    current
    && current.target === snapshot.target
    && current.currentTarget === snapshot.currentTarget
    && current.phase === snapshot.phase
    && current.view === snapshot.view
    && current.trusted === snapshot.trusted
    && current.path.length === snapshot.path.length
    && current.path.every((entry, index) => entry === snapshot.path[index]),
  );
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
      {error && <p role="alert" aria-atomic="true" className="text-sm text-danger">{error}</p>}
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
          <p role="alert" aria-atomic="true" className="text-danger">{loadError.message}</p>
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
        <button type="button" className="btn btn-outline w-fit gap-1.5" disabled={busy || tokens === null || Boolean(created) || blockingTokenActionPending}
          aria-expanded={showCreate} aria-controls={`${id}-create`} onClick={() => toggleCreate(controlVisit)} data-testid="token-add">
          <Plus size={16} /> {showCreate ? "Cancel creation" : "Create token"}
        </button>
        {showCreate && <form id={`${id}-create`} className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-3"
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
           {documentError && <><p role="alert" aria-atomic="true" className="text-sm text-danger">{documentError}</p>
           </>}
           {documents !== null && (documents.length === 0 ? <p className="text-xs text-ink-3">No documents yet.</p>
                  : documents.map((d) => <label key={d.id} className="flex items-start gap-2 text-sm text-ink-2">
                   <input type="checkbox" checked={documentIds.includes(d.id)} disabled={busy} onChange={() => setDocumentIds((ids) => ids.includes(d.id) ? ids.filter((value) => value !== d.id) : [...ids, d.id])} data-testid={`token-document-${d.id}`} />
                    <span className="min-w-0 break-words">{d.title}</span>
                  </label>))}
          </div>}
          {showRestrictionError && <p className="text-xs text-danger" role="alert" data-testid="token-document-error">{restrictionError}</p>}
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">Expires
           <select className="select w-fit" value={expires} disabled={busy} onChange={(e) => setExpires(e.target.value)}>
              <option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="never">Never</option>
            </select>
          </label>
          <button type="submit" className="btn btn-primary w-fit gap-1.5" disabled={busy || blockingTokenActionPending || Boolean(created) || tokens === null || !name.trim() || Boolean(restrictionError) || documentAuthorityUnavailable} data-testid="token-create">
            {busy && <Loader2 size={16} className="animate-spin" />} Create token
          </button>
        </form>}
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
    readonly ownerDocument: Document;
    readonly keyboard: TokenRenameKeyboardAuthority;
    readonly dom: SecretNoticeDomSnapshot;
    readonly placement: readonly SecretNoticePlacement[];
    readonly history: TokenRenameMutationHistory;
    claimed: boolean;
    retired: boolean;
  }
  type PendingRenameEscape = Readonly<{
    authority: RenameEscapeAuthority;
    reactEvent: object;
    native: TokenRenameKeyboardSnapshot;
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
  type FocusIntent = Readonly<{ mount: symbol; visit: RenameVisit; tokenId: string }>;
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
  const claimedEvents = useRef(new WeakSet<object>());
  const consumedCommits = useRef(new WeakSet<RowCommit>());
  const dispatchingCommits = useRef(new WeakSet<RowCommit>());
  const activeRenameEscape = useRef<RenameEscapeAuthority | null>(null);
  const pendingRenameEscapes = useRef(new Map<Event, PendingRenameEscape>());
  const claimedRenameReactEvents = useRef(new WeakSet<object>());
  const claimedRenameNativeEvents = useRef(new WeakSet<Event>());
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

  const retireRenameEscape = (authority: RenameEscapeAuthority) => {
    if (!authority.retired) {
      authority.retired = true;
      authority.history.disconnect();
    }
    if (activeRenameEscape.current === authority) activeRenameEscape.current = null;
    for (const [event, pending] of pendingRenameEscapes.current) {
      if (pending.authority === authority) pendingRenameEscapes.current.delete(event);
    }
  };
  const retireCandidate = (value: RowCandidate) => {
    const commit = activeCommit.current;
    if (commit?.candidate !== value) return;
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
  const exactRenameReactEvent = (
    event: ReactKeyboardEvent<HTMLInputElement | HTMLFormElement>,
    currentTarget: HTMLInputElement | HTMLFormElement,
    authority: RenameEscapeAuthority,
    snapshot: TokenRenameKeyboardSnapshot,
  ) => {
    try {
      const reactEvent = event as ReactKeyboardEvent<HTMLInputElement | HTMLFormElement> & {
        _reactName?: unknown;
        isComposing?: unknown;
        isDefaultPrevented?: unknown;
        isPropagationStopped?: unknown;
        isPersistent?: unknown;
        persist?: unknown;
      };
      return reactEvent._reactName === "onKeyDown"
        && event.type === "keydown"
        && event.key === "Escape"
        && event.currentTarget === currentTarget
        && event.target === authority.input
        && event.nativeEvent === snapshot.event
        && event.eventPhase === snapshot.phase
        && event.bubbles === true
        && event.bubbles === tokenRenameNativeValue<boolean>(
          authority.keyboard,
          authority.keyboard.event.bubbles,
          snapshot.event,
        )
        && event.cancelable === true
        && event.cancelable === tokenRenameNativeValue<boolean>(
          authority.keyboard,
          authority.keyboard.event.cancelable,
          snapshot.event,
        )
        && event.defaultPrevented === false
        && event.repeat === false
        && (reactEvent.isComposing === false || typeof reactEvent.isComposing === "undefined")
        && event.altKey === false
        && event.ctrlKey === false
        && event.metaKey === false
        && event.shiftKey === false
        && typeof reactEvent.preventDefault === "function"
        && typeof reactEvent.stopPropagation === "function"
        && typeof reactEvent.isDefaultPrevented === "function"
        && !reactEvent.isDefaultPrevented()
        && typeof reactEvent.isPropagationStopped === "function"
        && !reactEvent.isPropagationStopped()
        && typeof reactEvent.persist === "function"
        && typeof reactEvent.isPersistent === "function";
    } catch {
      return false;
    }
  };
  const renameEscapeIsCurrent = (authority: RenameEscapeAuthority) => {
    const commit = currentCommit(authority.candidate);
    const focus = focusedRename.current;
    return activeRenameEscape.current === authority
      && !authority.retired
      && !authority.claimed
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
      && authority.input.form === authority.form
      && authority.input.ownerDocument === authority.ownerDocument
      && authority.form.ownerDocument === authority.ownerDocument
      && authority.ownerDocument.defaultView === authority.keyboard.ownerWindow
      && authority.ownerDocument.activeElement === authority.input
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
  const establishRenameEscape = (
    commit: RowCommit,
    settlingInput: HTMLInputElement | null = null,
  ) => {
    const visit = commit.facts.renameVisit;
    const draft = commit.facts.draft;
    const input = commit.input;
    const form = commit.form;
    const ownerWindow = commit.ownerDocument.defaultView;
    if (
      !visit
      || draft === null
      || !input
      || !form
      || !commit.facts.inputEligible
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
      ownerDocument: commit.ownerDocument,
      keyboard,
      dom: snapshotSecretNoticeDom(commit.row),
      placement,
      history,
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
    }
  };
  const stageRenameEscape = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    const authority = activeRenameEscape.current;
    const nativeEvent = event.nativeEvent;
    if (
      !authority
      || !(nativeEvent instanceof authority.keyboard.Event)
      || claimedRenameReactEvents.current.has(event)
      || claimedRenameNativeEvents.current.has(nativeEvent)
      || pendingRenameEscapes.current.has(nativeEvent)
      || !renameEscapeIsCurrent(authority)
    ) {
      return;
    }
    const snapshot = captureTokenRenameEscape(
      authority.keyboard,
      nativeEvent,
      authority.input,
    );
    if (
      !snapshot
      || !exactRenameReactEvent(event, authority.input, authority, snapshot)
      || !renameEscapeIsCurrent(authority)
    ) {
      return;
    }
    const pending = Object.freeze<PendingRenameEscape>({
      authority,
      reactEvent: event,
      native: snapshot,
    });
    pendingRenameEscapes.current.set(nativeEvent, pending);
    queueMicrotask(() => {
      if (pendingRenameEscapes.current.get(nativeEvent) === pending) {
        pendingRenameEscapes.current.delete(nativeEvent);
      }
    });
  };
  const deliverRenameEscape = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    const nativeEvent = event.nativeEvent;
    const pending = pendingRenameEscapes.current.get(nativeEvent);
    if (
      !pending
      || pending.reactEvent !== event
      || pending.authority.form !== event.currentTarget
      || claimedRenameReactEvents.current.has(event)
      || claimedRenameNativeEvents.current.has(nativeEvent)
    ) {
      return;
    }
    const { authority, native } = pending;
    if (
      !renameEscapeIsCurrent(authority)
      || !exactRenameReactEvent(event, authority.form, authority, native)
      || !tokenRenameEscapeMatches(authority.keyboard, native, authority.input)
      || !renameEscapeIsCurrent(authority)
    ) {
      return;
    }

    authority.claimed = true;
    claimedRenameReactEvents.current.add(event);
    claimedRenameNativeEvents.current.add(nativeEvent);
    pendingRenameEscapes.current.delete(nativeEvent);
    const commit = authority.commit;
    if (
      activeRenameEscape.current !== authority
      || authority.retired
      || activeCommit.current !== commit
      || !authority.history.isPristine()
      || !tokenRenameEscapeMatches(authority.keyboard, native, authority.input)
      || !factsAreCurrent(commit.facts)
      || !domIsExact(commit)
    ) {
      retireRenameEscape(authority);
      return;
    }

    retireRenameEscape(authority);
    authority.keyboard.apply(
      authority.keyboard.preventDefault,
      nativeEvent,
      [],
    );
    try {
      if (!tokenRenameNativeValue<boolean>(
        authority.keyboard,
        authority.keyboard.event.defaultPrevented,
        nativeEvent,
      )) {
        return;
      }
    } catch {
      return;
    }
    closeRename(commit);
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
  const closeRename = (commit: RowCommit) => {
    const visit = commit.facts.renameVisit;
    if (!visit) return;
    returnFocus.current = Object.freeze({ mount, visit, tokenId: commit.facts.token.id });
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
      const replay = renameRefReplay.current;
      if (replay?.candidate.facts.mount === mount) quarantineRenameRefReplay(replay);
      controlledInputUpdate.current = null;
      pendingRenameEscapes.current.clear();
      if (saveOwner.current?.mount === mount) saveOwner.current = null;
      if (returnFocus.current?.mount === mount) returnFocus.current = null;
    };
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
    commit.rename.focus();
  });

  return (
    <li ref={(element) => bindElement(candidate.row, element)} tabIndex={-1} className={facts.rowClassName}
      data-testid="token-row" data-token-match={facts.matching || undefined}>
      <div ref={(element) => bindElement(candidate.header, element)} className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-all text-sm font-semibold text-ink">{facts.token.name}</span>
        <ScopeChip scope={facts.token.scope} /><span className="text-xs text-ink-3">{facts.state}</span>
        <span className="text-xs text-ink-3" data-testid="token-documents-count">{facts.documentCount}</span>
      </div>
      <p ref={(element) => bindElement(candidate.metadata, element)} className="text-xs text-ink-3">{facts.metadata}</p>
      {facts.mismatchText && <p ref={(element) => bindElement(candidate.mismatch, element)} className="text-xs text-ink-2">{facts.mismatchText}</p>}
      {facts.expiredText && <p ref={(element) => bindElement(candidate.expired, element)} className="text-xs text-ink-3">{facts.expiredText}</p>}
      {facts.actionsVisible && <div ref={(element) => bindElement(candidate.actions, element)} className="flex flex-wrap gap-2">
        <button ref={(element) => bindElement(candidate.rename, element)} type="button" className="btn btn-outline btn-sm"
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
        onKeyDown={deliverRenameEscape}
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
          onKeyDown={stageRenameEscape}
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
