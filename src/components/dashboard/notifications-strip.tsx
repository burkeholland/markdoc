"use client";

import {
  useCallback,
  useLayoutEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck, X } from "lucide-react";
import type { NotificationDto } from "@/lib/api";
import { markAllNotificationsRead, markNotificationRead, sentence, useNotifications } from "@/lib/notifications-store";
import { KindIcon, actorLabel } from "@/components/notifications/notifications-bell";
import { notificationHref } from "@/components/notifications/open";
import { RelativeTime } from "@/components/ui/relative-time";

type NotificationSnapshot = ReturnType<typeof useNotifications>;
type NotificationRouter = ReturnType<typeof useRouter>;
type NotificationNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

interface NotificationRowAuthority {
  readonly index: number;
  readonly source: NotificationDto;
  readonly notification: Readonly<NotificationDto>;
  readonly href: string;
}

interface NotificationStripAuthority {
  readonly mount: symbol;
  readonly snapshot: NotificationSnapshot;
  readonly items: NotificationSnapshot["items"];
  readonly router: NotificationRouter;
  readonly push: NotificationRouter["push"];
  readonly markRead: typeof markNotificationRead;
  readonly markAllRead: typeof markAllNotificationsRead;
  readonly unreadCount: number;
  readonly rows: readonly NotificationRowAuthority[];
}

type NotificationActionKind = "read-all" | "open" | "dismiss";

interface NotificationActionPublication {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly kind: NotificationActionKind;
  readonly rowIndex: number | null;
}

interface NotificationRowPublication {
  readonly identity: symbol;
  readonly authority: NotificationRowAuthority;
  readonly item: HTMLLIElement;
  readonly open: HTMLButtonElement;
  readonly openPath: readonly EventTarget[];
  readonly dismiss: HTMLButtonElement;
  readonly openAction: NotificationActionPublication;
  readonly dismissAction: NotificationActionPublication;
}

interface NotificationDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly NotificationDomSnapshot[];
}

interface NotificationNodePlacement {
  readonly node: Node;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
  readonly exactSiblings: boolean;
}

interface NotificationPlacement {
  readonly document: Document;
  readonly chain: readonly NotificationNodePlacement[];
}

interface NotificationDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface NotificationNativeKeyboardFacts {
  readonly type: string;
  readonly phase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly cancelBubble: boolean;
  readonly target: EventTarget | null;
  readonly path: readonly EventTarget[];
  readonly isTrusted: boolean;
  readonly view: Window | null;
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
}

interface NotificationKeyboardIntrinsics {
  readonly read: (event: object) => NotificationNativeKeyboardFacts | null;
  readonly defaultWasPrevented: (event: Event) => boolean;
  readonly activeElement: () => Element | null | undefined;
  readonly preventDefault: (event: Event) => boolean;
  readonly focus: (element: HTMLElement) => boolean;
}

interface NotificationFocusCustody {
  readonly controls: readonly HTMLButtonElement[];
  readonly activeElement: () => Element | null | undefined;
  readonly focus: (element: HTMLButtonElement) => boolean;
}

interface NotificationStripPublication {
  readonly identity: symbol;
  readonly authority: NotificationStripAuthority;
  readonly section: HTMLElement;
  readonly sectionParent: Node;
  readonly readAll: HTMLButtonElement;
  readonly list: HTMLUListElement;
  readonly rows: readonly NotificationRowPublication[];
  readonly openControls: readonly HTMLButtonElement[];
  readonly readAllAction: NotificationActionPublication;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly dom: NotificationDomSnapshot;
  readonly placement: NotificationPlacement;
  readonly focusCustody: NotificationFocusCustody;
  readonly keyboard: NotificationKeyboardIntrinsics | null;
}

interface ElementOwnerView {
  readonly element: () => HTMLElement | null;
}

interface RefReplay {
  readonly owner: ElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

interface NotificationReplay {
  readonly source: NotificationStripPublication;
  readonly dom: NotificationDomSnapshot;
  readonly placement: NotificationPlacement;
  readonly openControls: readonly HTMLButtonElement[];
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface NotificationPublicationRuntime {
  readonly publication: NotificationStripPublication;
  readonly publish: (owners: readonly ElementOwnerView[]) => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: ElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly historyIsClean: () => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly replay: () => NotificationReplay;
}

interface NotificationStripPublicationSet {
  readonly captureSection: (element: HTMLElement | null) => void;
  readonly captureReadAll: (element: HTMLButtonElement | null) => void;
  readonly captureList: (element: HTMLUListElement | null) => void;
  readonly rows: readonly {
    readonly authority: NotificationRowAuthority;
    readonly captureItem: (element: HTMLLIElement | null) => void;
    readonly captureOpen: (element: HTMLButtonElement | null) => void;
    readonly captureDismiss: (element: HTMLButtonElement | null) => void;
  }[];
  readonly establish: () => (() => void) | undefined;
  readonly onReadAll: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onOpen: (row: NotificationRowAuthority, event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onDismiss: (row: NotificationRowAuthority, event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onBrowse: (
    row: NotificationRowAuthority,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
}

class NotificationStripCoordinator {
  readonly #mount: symbol;
  #active: NotificationStripPublication | null = null;
  #successorOf: NotificationStripPublication | null = null;
  #replay: NotificationReplay | null = null;
  #retired = new WeakSet<NotificationStripPublication>();
  #claimedPublications = new WeakSet<NotificationStripPublication>();
  #claimedActions = new WeakSet<NotificationActionPublication>();
  #claimedRows = new WeakSet<NotificationRowPublication>();
  #claimedEvents = new WeakSet<object>();

  constructor(mount: symbol) {
    this.#mount = mount;
  }

  replay() {
    return this.#replay;
  }

  acceptsSuccessorOf(publication: NotificationStripPublication) {
    return (
      this.#active === null &&
      this.#successorOf === publication &&
      this.#retired.has(publication) &&
      !this.#claimedPublications.has(publication)
    );
  }

  stageReplay(replay: NotificationReplay) {
    if (!this.acceptsSuccessorOf(replay.source)) return false;
    this.#replay = replay;
    return true;
  }

  abandonReplay(publication: NotificationStripPublication) {
    if (this.#replay?.source === publication) {
      this.#replay.release();
      this.#replay = null;
    }
    if (this.#successorOf === publication) this.#successorOf = null;
  }

  publish(publication: NotificationStripPublication) {
    if (
      publication.authority.mount !== this.#mount ||
      this.#retired.has(publication)
    ) {
      return false;
    }
    const previous = this.#active;
    if (previous && previous !== publication) this.retire(previous);
    this.#replay?.release();
    this.#active = publication;
    this.#successorOf = null;
    this.#replay = null;
    return true;
  }

  retire(publication: NotificationStripPublication) {
    if (this.#retired.has(publication)) return false;
    this.#retired.add(publication);
    if (this.#active === publication) {
      this.#active = null;
      this.#successorOf = publication;
    }
    return true;
  }

  isCurrent(publication: NotificationStripPublication) {
    return this.#active === publication && !this.#retired.has(publication);
  }

  hasClaimed(
    publication: NotificationStripPublication,
    action: NotificationActionPublication,
    event: object,
    nativeEvent: Event,
  ) {
    const row = action.rowIndex === null ? null : publication.rows[action.rowIndex];
    return (
      this.#claimedActions.has(action) ||
      (row !== null && this.#claimedRows.has(row)) ||
      this.#claimedEvents.has(event) ||
      this.#claimedEvents.has(nativeEvent)
    );
  }

  claim(
    publication: NotificationStripPublication,
    action: NotificationActionPublication,
    event: object,
    nativeEvent: Event,
  ) {
    if (
      !this.isCurrent(publication) ||
      action.publicationIdentity !== publication.identity ||
      this.hasClaimed(publication, action, event, nativeEvent)
    ) {
      return false;
    }
    const row = action.rowIndex === null ? null : publication.rows[action.rowIndex];
    if (
      action.kind === "read-all"
        ? action !== publication.readAllAction || row !== null
        : !row ||
          (action.kind === "open"
            ? action !== row.openAction
            : action !== row.dismissAction)
    ) {
      return false;
    }
    this.#claimedActions.add(action);
    this.#claimedPublications.add(publication);
    if (row) this.#claimedRows.add(row);
    this.#claimedEvents.add(event);
    this.#claimedEvents.add(nativeEvent);
    return true;
  }

  claimKeyboard(
    publication: NotificationStripPublication,
    event: object,
    nativeEvent: KeyboardEvent,
  ) {
    if (
      !this.isCurrent(publication) ||
      this.#claimedPublications.has(publication) ||
      this.#claimedEvents.has(event) ||
      this.#claimedEvents.has(nativeEvent)
    ) {
      return false;
    }
    this.#claimedEvents.add(event);
    this.#claimedEvents.add(nativeEvent);
    return true;
  }
}

class ElementOwner<T extends HTMLElement> implements ElementOwnerView {
  #current: T | null = null;
  #last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: ElementOwnerView,
      element: T | null,
      previous: T | null,
      last: T | null,
    ) => void,
  ) {}

  readonly element = () => this.#current;

  readonly capture = (element: T | null) => {
    if (this.#current === element) return;
    const previous = this.#current;
    const last = this.#last;
    this.#current = element;
    if (element) this.#last = element;
    this.onChange(this, element, previous, last);
  };
}

function captureNotification(notification: NotificationDto): Readonly<NotificationDto> {
  return Object.freeze({
    id: notification.id,
    kind: notification.kind,
    documentId: notification.documentId,
    documentTitle: notification.documentTitle,
    actorLogin: notification.actorLogin,
    actorName: notification.actorName,
    refId: notification.refId,
    snippet: notification.snippet,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
  });
}

function notificationFactsMatch(source: NotificationDto, captured: Readonly<NotificationDto>) {
  return (
    source.id === captured.id &&
    source.kind === captured.kind &&
    source.documentId === captured.documentId &&
    source.documentTitle === captured.documentTitle &&
    source.actorLogin === captured.actorLogin &&
    source.actorName === captured.actorName &&
    source.refId === captured.refId &&
    source.snippet === captured.snippet &&
    source.createdAt === captured.createdAt &&
    source.readAt === captured.readAt
  );
}

function snapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotNotificationDom(node: Node): NotificationDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotNotificationDom)),
  });
}

function notificationDomMatches(snapshot: NotificationDomSnapshot, ownerDocument: Document): boolean {
  const { node } = snapshot;
  if (
    !node.isConnected ||
    node.ownerDocument !== ownerDocument ||
    node.nodeValue !== snapshot.nodeValue
  ) {
    return false;
  }
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
  return (
    node.childNodes.length === snapshot.children.length &&
    snapshot.children.every(
      (child, index) =>
        node.childNodes.item(index) === child.node &&
        notificationDomMatches(child, ownerDocument),
    )
  );
}

function captureNotificationPlacement(node: HTMLElement): NotificationPlacement | null {
  if (!node.isConnected) return null;
  const document = node.ownerDocument;
  const chain: NotificationNodePlacement[] = [];
  let current: Node = node;
  while (current !== document) {
    const parent = current.parentNode;
    if (!parent) return null;
    chain.push(Object.freeze({
      node: current,
      parent,
      previousSibling: current.previousSibling,
      nextSibling: current.nextSibling,
      exactSiblings: current === node,
    }));
    current = parent;
  }
  return chain.length > 0
    ? Object.freeze({ document, chain: Object.freeze(chain) })
    : null;
}

function notificationPlacementMatches(
  node: HTMLElement,
  placement: NotificationPlacement,
) {
  return (
    node.ownerDocument === placement.document &&
    node.isConnected &&
    placement.chain[0]?.node === node &&
    placement.chain.every(
      (entry) =>
        entry.node.parentNode === entry.parent &&
        (!entry.exactSiblings ||
          (entry.node.previousSibling === entry.previousSibling &&
            entry.node.nextSibling === entry.nextSibling)),
    )
  );
}

function notificationPlacementRecordChanged(
  record: MutationRecord,
  placement: NotificationNodePlacement,
) {
  if (record.type !== "childList" || record.target !== placement.parent) {
    return false;
  }
  if (
    placement.exactSiblings &&
    (record.previousSibling === placement.node ||
      record.nextSibling === placement.node)
  ) {
    return true;
  }
  return [...record.addedNodes, ...record.removedNodes].some(
    (node) => node === placement.node || node.contains(placement.node),
  );
}

function createNotificationDomGuard(
  root: HTMLElement,
  placement: NotificationPlacement,
): NotificationDomGuard | null {
  const MutationObserverConstructor =
    placement.document.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  let released = false;
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some((record) => {
      if (record.target === root || root.contains(record.target)) return true;
      return placement.chain.some((entry) =>
        notificationPlacementRecordChanged(record, entry));
    });
  };
  const observer = new MutationObserverConstructor(recordChanges);
  observer.observe(root, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  for (const entry of placement.chain) {
    observer.observe(entry.parent, { childList: true });
  }
  return Object.freeze({
    isClean: () => {
      recordChanges(observer.takeRecords());
      return !changed;
    },
    release: () => {
      if (released) return;
      recordChanges(observer.takeRecords());
      observer.disconnect();
      released = true;
    },
  });
}

const NOTIFICATION_GET_DESCRIPTOR =
  Object.getOwnPropertyDescriptor.bind(Object);
const NOTIFICATION_REFLECT_APPLY = Reflect.apply;

interface NotificationStableGetter<T> {
  readonly prototype: object;
  readonly property: PropertyKey;
  readonly getter: () => T;
  readonly read: (value: object) => T;
  readonly isCurrent: () => boolean;
}

interface NotificationUnforgeableGetter<T> {
  readonly owner: object;
  readonly property: PropertyKey;
  readonly getter: () => T;
  readonly setter: undefined | ((value: T) => void);
  readonly configurable: boolean;
  readonly enumerable: boolean;
  readonly isCurrent: () => boolean;
  readonly matches: (value: object) => boolean;
  readonly read: (value: object) => T;
}

interface NotificationStableMethod<T extends (...args: never[]) => unknown> {
  readonly prototype: object;
  readonly property: PropertyKey;
  readonly method: (...args: never[]) => unknown;
  readonly invoke: T;
  readonly isCurrent: () => boolean;
}

function captureStableGetter<T>(
  prototype: object | null,
  property: PropertyKey,
): NotificationStableGetter<T> | null {
  if (!prototype) return null;
  const descriptor = NOTIFICATION_GET_DESCRIPTOR(prototype, property);
  if (!descriptor?.get) return null;
  const getter = descriptor.get as () => T;
  return Object.freeze({
    prototype,
    property,
    getter,
    read: Function.prototype.call.bind(getter) as (value: object) => T,
    isCurrent: () =>
      NOTIFICATION_GET_DESCRIPTOR(prototype, property)?.get === getter,
  });
}

function captureStableMethod<T extends (...args: never[]) => unknown>(
  prototype: object | null,
  property: PropertyKey,
): NotificationStableMethod<T> | null {
  if (!prototype) return null;
  const descriptor = NOTIFICATION_GET_DESCRIPTOR(prototype, property);
  if (
    !descriptor ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function"
  ) {
    return null;
  }
  const method = descriptor.value as (...args: never[]) => unknown;
  return Object.freeze({
    prototype,
    property,
    method,
    invoke: Function.prototype.call.bind(method) as unknown as T,
    isCurrent: () =>
      NOTIFICATION_GET_DESCRIPTOR(prototype, property)?.value === method,
  });
}

function captureUnforgeableGetter<T>(
  owner: object | null,
  property: PropertyKey,
): NotificationUnforgeableGetter<T> | null {
  if (!owner) return null;
  const descriptor = NOTIFICATION_GET_DESCRIPTOR(owner, property);
  if (!descriptor?.get || "value" in descriptor) return null;
  const getter = descriptor.get as () => T;
  const setter = descriptor.set as undefined | ((value: T) => void);
  const configurable = descriptor.configurable === true;
  const enumerable = descriptor.enumerable === true;
  const matches = (value: object) => {
    const current = NOTIFICATION_GET_DESCRIPTOR(value, property);
    return (
      !!current &&
      !("value" in current) &&
      current.get === getter &&
      current.set === setter &&
      current.configurable === configurable &&
      current.enumerable === enumerable
    );
  };
  return Object.freeze({
    owner,
    property,
    getter,
    setter,
    configurable,
    enumerable,
    isCurrent: () => matches(owner),
    matches,
    read: (value: object) =>
      NOTIFICATION_REFLECT_APPLY(getter, value, []) as T,
  });
}

const NOTIFICATION_EVENT_CONSTRUCTOR =
  typeof Event === "undefined" ? null : Event;
const NOTIFICATION_EVENT_PROTOTYPE =
  NOTIFICATION_EVENT_CONSTRUCTOR?.prototype ?? null;
const NOTIFICATION_UI_EVENT_PROTOTYPE =
  typeof UIEvent === "undefined" ? null : UIEvent.prototype;
const NOTIFICATION_KEYBOARD_EVENT_PROTOTYPE =
  typeof KeyboardEvent === "undefined" ? null : KeyboardEvent.prototype;
const NOTIFICATION_DOCUMENT_PROTOTYPE =
  typeof Document === "undefined" ? null : Document.prototype;
const NOTIFICATION_HTML_ELEMENT_PROTOTYPE =
  typeof HTMLElement === "undefined" ? null : HTMLElement.prototype;

const NOTIFICATION_EVENT_TYPE = captureStableGetter<string>(
  NOTIFICATION_EVENT_PROTOTYPE,
  "type",
);
const NOTIFICATION_EVENT_PHASE = captureStableGetter<number>(
  NOTIFICATION_EVENT_PROTOTYPE,
  "eventPhase",
);
const NOTIFICATION_EVENT_BUBBLES = captureStableGetter<boolean>(
  NOTIFICATION_EVENT_PROTOTYPE,
  "bubbles",
);
const NOTIFICATION_EVENT_CANCELABLE = captureStableGetter<boolean>(
  NOTIFICATION_EVENT_PROTOTYPE,
  "cancelable",
);
const NOTIFICATION_EVENT_DEFAULT_PREVENTED = captureStableGetter<boolean>(
  NOTIFICATION_EVENT_PROTOTYPE,
  "defaultPrevented",
);
const NOTIFICATION_EVENT_CANCEL_BUBBLE = captureStableGetter<boolean>(
  NOTIFICATION_EVENT_PROTOTYPE,
  "cancelBubble",
);
const NOTIFICATION_EVENT_TARGET = captureStableGetter<EventTarget | null>(
  NOTIFICATION_EVENT_PROTOTYPE,
  "target",
);
const NOTIFICATION_EVENT_INSTANCE = (() => {
  if (!NOTIFICATION_EVENT_CONSTRUCTOR) return null;
  try {
    return new NOTIFICATION_EVENT_CONSTRUCTOR(
      "notification-keyboard-intrinsic",
    );
  } catch {
    return null;
  }
})();
const NOTIFICATION_EVENT_TRUSTED = captureUnforgeableGetter<boolean>(
  NOTIFICATION_EVENT_INSTANCE,
  "isTrusted",
);
const NOTIFICATION_EVENT_COMPOSED_PATH = captureStableMethod<
  (event: Event) => EventTarget[]
>(NOTIFICATION_EVENT_PROTOTYPE, "composedPath");
const NOTIFICATION_PREVENT_DEFAULT = captureStableMethod<
  (event: Event) => void
>(NOTIFICATION_EVENT_PROTOTYPE, "preventDefault");
const NOTIFICATION_UI_VIEW = captureStableGetter<Window | null>(
  NOTIFICATION_UI_EVENT_PROTOTYPE,
  "view",
);
const NOTIFICATION_KEY = captureStableGetter<string>(
  NOTIFICATION_KEYBOARD_EVENT_PROTOTYPE,
  "key",
);
const NOTIFICATION_CTRL = captureStableGetter<boolean>(
  NOTIFICATION_KEYBOARD_EVENT_PROTOTYPE,
  "ctrlKey",
);
const NOTIFICATION_ALT = captureStableGetter<boolean>(
  NOTIFICATION_KEYBOARD_EVENT_PROTOTYPE,
  "altKey",
);
const NOTIFICATION_META = captureStableGetter<boolean>(
  NOTIFICATION_KEYBOARD_EVENT_PROTOTYPE,
  "metaKey",
);
const NOTIFICATION_SHIFT = captureStableGetter<boolean>(
  NOTIFICATION_KEYBOARD_EVENT_PROTOTYPE,
  "shiftKey",
);
const NOTIFICATION_REPEAT = captureStableGetter<boolean>(
  NOTIFICATION_KEYBOARD_EVENT_PROTOTYPE,
  "repeat",
);
const NOTIFICATION_COMPOSING = captureStableGetter<boolean>(
  NOTIFICATION_KEYBOARD_EVENT_PROTOTYPE,
  "isComposing",
);
const NOTIFICATION_ACTIVE_ELEMENT = captureStableGetter<Element | null>(
  NOTIFICATION_DOCUMENT_PROTOTYPE,
  "activeElement",
);
const NOTIFICATION_FOCUS = captureStableMethod<
  (element: HTMLElement) => void
>(NOTIFICATION_HTML_ELEMENT_PROTOTYPE, "focus");

const NOTIFICATION_KEYBOARD_GETTERS = Object.freeze([
  NOTIFICATION_EVENT_TYPE,
  NOTIFICATION_EVENT_PHASE,
  NOTIFICATION_EVENT_BUBBLES,
  NOTIFICATION_EVENT_CANCELABLE,
  NOTIFICATION_EVENT_DEFAULT_PREVENTED,
  NOTIFICATION_EVENT_CANCEL_BUBBLE,
  NOTIFICATION_EVENT_TARGET,
  NOTIFICATION_UI_VIEW,
  NOTIFICATION_KEY,
  NOTIFICATION_CTRL,
  NOTIFICATION_ALT,
  NOTIFICATION_META,
  NOTIFICATION_SHIFT,
  NOTIFICATION_REPEAT,
  NOTIFICATION_COMPOSING,
  NOTIFICATION_ACTIVE_ELEMENT,
]);

const NOTIFICATION_KEYBOARD_METHODS = Object.freeze([
  NOTIFICATION_EVENT_COMPOSED_PATH,
  NOTIFICATION_PREVENT_DEFAULT,
  NOTIFICATION_FOCUS,
]);

function captureNotificationKeyboardIntrinsics(
  ownerWindow: Window & typeof globalThis,
): NotificationKeyboardIntrinsics | null {
  if (
    NOTIFICATION_EVENT_CONSTRUCTOR !== ownerWindow.Event ||
    NOTIFICATION_EVENT_PROTOTYPE !== ownerWindow.Event.prototype ||
    NOTIFICATION_UI_EVENT_PROTOTYPE !== ownerWindow.UIEvent.prototype ||
    NOTIFICATION_KEYBOARD_EVENT_PROTOTYPE !==
      ownerWindow.KeyboardEvent.prototype ||
    NOTIFICATION_DOCUMENT_PROTOTYPE !== ownerWindow.Document.prototype ||
    NOTIFICATION_HTML_ELEMENT_PROTOTYPE !==
      ownerWindow.HTMLElement.prototype ||
    NOTIFICATION_KEYBOARD_GETTERS.some(
      (intrinsic) => !intrinsic || !intrinsic.isCurrent(),
    ) ||
    NOTIFICATION_KEYBOARD_METHODS.some(
      (intrinsic) => !intrinsic || !intrinsic.isCurrent(),
    ) ||
    !NOTIFICATION_EVENT_TRUSTED ||
    !NOTIFICATION_EVENT_TRUSTED.isCurrent() ||
    !NOTIFICATION_EVENT_TYPE ||
    !NOTIFICATION_EVENT_PHASE ||
    !NOTIFICATION_EVENT_BUBBLES ||
    !NOTIFICATION_EVENT_CANCELABLE ||
    !NOTIFICATION_EVENT_DEFAULT_PREVENTED ||
    !NOTIFICATION_EVENT_CANCEL_BUBBLE ||
    !NOTIFICATION_EVENT_TARGET ||
    !NOTIFICATION_EVENT_COMPOSED_PATH ||
    !NOTIFICATION_PREVENT_DEFAULT ||
    !NOTIFICATION_UI_VIEW ||
    !NOTIFICATION_KEY ||
    !NOTIFICATION_CTRL ||
    !NOTIFICATION_ALT ||
    !NOTIFICATION_META ||
    !NOTIFICATION_SHIFT ||
    !NOTIFICATION_REPEAT ||
    !NOTIFICATION_COMPOSING ||
    !NOTIFICATION_ACTIVE_ELEMENT ||
    !NOTIFICATION_FOCUS
  ) {
    return null;
  }
  const ownerRealmIsCurrent = () =>
    NOTIFICATION_EVENT_CONSTRUCTOR === ownerWindow.Event &&
    NOTIFICATION_EVENT_PROTOTYPE === ownerWindow.Event.prototype &&
    NOTIFICATION_UI_EVENT_PROTOTYPE === ownerWindow.UIEvent.prototype &&
    NOTIFICATION_KEYBOARD_EVENT_PROTOTYPE ===
      ownerWindow.KeyboardEvent.prototype &&
    NOTIFICATION_DOCUMENT_PROTOTYPE === ownerWindow.Document.prototype &&
    NOTIFICATION_HTML_ELEMENT_PROTOTYPE ===
      ownerWindow.HTMLElement.prototype;
  let trustedHistoryIsClean = true;
  const descriptorsAreCurrent = () => {
    if (!trustedHistoryIsClean) return false;
    trustedHistoryIsClean =
      ownerRealmIsCurrent() &&
      NOTIFICATION_KEYBOARD_GETTERS.every(
        (intrinsic) => intrinsic?.isCurrent() === true,
      ) &&
      NOTIFICATION_KEYBOARD_METHODS.every(
        (intrinsic) => intrinsic?.isCurrent() === true,
      ) &&
      NOTIFICATION_EVENT_TRUSTED.isCurrent();
    return trustedHistoryIsClean;
  };
  return Object.freeze({
    read: (event: object) => {
      if (!descriptorsAreCurrent()) return null;
      try {
        if (!NOTIFICATION_EVENT_TRUSTED.matches(event)) return null;
        const isTrusted = NOTIFICATION_EVENT_TRUSTED.read(event);
        const view = NOTIFICATION_UI_VIEW.read(event);
        if (isTrusted !== true || view !== ownerWindow) return null;
        return Object.freeze({
          type: NOTIFICATION_EVENT_TYPE.read(event),
          phase: NOTIFICATION_EVENT_PHASE.read(event),
          bubbles: NOTIFICATION_EVENT_BUBBLES.read(event),
          cancelable: NOTIFICATION_EVENT_CANCELABLE.read(event),
          defaultPrevented:
            NOTIFICATION_EVENT_DEFAULT_PREVENTED.read(event),
          cancelBubble: NOTIFICATION_EVENT_CANCEL_BUBBLE.read(event),
          target: NOTIFICATION_EVENT_TARGET.read(event),
          path: Object.freeze([
            ...NOTIFICATION_EVENT_COMPOSED_PATH.invoke(event as Event),
          ]),
          isTrusted,
          view,
          key: NOTIFICATION_KEY.read(event),
          ctrlKey: NOTIFICATION_CTRL.read(event),
          altKey: NOTIFICATION_ALT.read(event),
          metaKey: NOTIFICATION_META.read(event),
          shiftKey: NOTIFICATION_SHIFT.read(event),
          repeat: NOTIFICATION_REPEAT.read(event),
          isComposing: NOTIFICATION_COMPOSING.read(event),
        });
      } catch {
        return null;
      }
    },
    defaultWasPrevented: (event: Event) => {
      if (!descriptorsAreCurrent()) return false;
      try {
        return NOTIFICATION_EVENT_DEFAULT_PREVENTED.read(event);
      } catch {
        return false;
      }
    },
    activeElement: () => {
      if (!descriptorsAreCurrent()) return undefined;
      try {
        return NOTIFICATION_ACTIVE_ELEMENT.read(ownerWindow.document);
      } catch {
        return undefined;
      }
    },
    preventDefault: (event: Event) => {
      if (!descriptorsAreCurrent()) return false;
      try {
        NOTIFICATION_PREVENT_DEFAULT.invoke(event);
        return true;
      } catch {
        return false;
      }
    },
    focus: (element: HTMLElement) => {
      if (!descriptorsAreCurrent()) return false;
      try {
        NOTIFICATION_FOCUS.invoke(element);
        return true;
      } catch {
        return false;
      }
    },
  });
}

function captureNotificationEventPath(
  node: Node,
  ownerDocument: Document,
) {
  const path: EventTarget[] = [];
  let current: Node | null = node;
  while (current) {
    path.push(current);
    if (current === ownerDocument) break;
    current = current.parentNode;
  }
  if (path[path.length - 1] !== ownerDocument) return null;
  return Object.freeze(path);
}

function isNotificationNavigationKey(
  key: string,
): key is NotificationNavigationKey {
  return (
    key === "ArrowDown" ||
    key === "ArrowUp" ||
    key === "Home" ||
    key === "End"
  );
}

function isEffectivelyEnabled(button: HTMLButtonElement) {
  if (
    button.disabled ||
    button.matches(":disabled") ||
    button.getAttribute("aria-disabled")?.toLowerCase() === "true"
  ) {
    return false;
  }
  for (let element: HTMLElement | null = button; element; element = element.parentElement) {
    if (
      element.hasAttribute("inert") ||
      element.getAttribute("aria-disabled")?.toLowerCase() === "true"
    ) {
      return false;
    }
  }
  return true;
}

function authoritiesMatch(
  previous: NotificationStripAuthority,
  current: NotificationStripAuthority,
) {
  return (
    previous.mount === current.mount &&
    previous.snapshot === current.snapshot &&
    previous.items === current.items &&
    previous.router === current.router &&
    previous.push === current.push &&
    previous.markRead === current.markRead &&
    previous.markAllRead === current.markAllRead &&
    previous.unreadCount === current.unreadCount &&
    previous.rows.length === current.rows.length &&
    previous.rows.every((row, index) => {
      const candidate = current.rows[index];
      return Boolean(
        candidate &&
          row.index === candidate.index &&
          row.source === candidate.source &&
          row.href === candidate.href &&
          notificationFactsMatch(row.source, row.notification) &&
          notificationFactsMatch(candidate.source, candidate.notification) &&
          notificationFactsMatch(row.notification, candidate.notification),
      );
    })
  );
}

function createNotificationStripPublication(
  authority: NotificationStripAuthority,
  coordinator: NotificationStripCoordinator,
  requestSuccessor: () => void,
): NotificationStripPublicationSet {
  let currentRuntime: NotificationPublicationRuntime | null = null;
  let lastRuntime: NotificationPublicationRuntime | null = null;
  let successorRequested = false;
  const snapshot = authority.snapshot;
  const items = authority.items;
  const router = authority.router;
  const push = authority.push;
  const markRead = authority.markRead;
  const markAllRead = authority.markAllRead;
  const unreadCount = authority.unreadCount;
  const rows = authority.rows;
  const onElementChange = (
    owner: ElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null || (element !== null && last !== null && element !== last)) {
      currentRuntime?.retireForElement();
    }
    if (
      runtime?.isExactElementReplay() &&
      coordinator.acceptsSuccessorOf(runtime.publication)
    ) {
      requestReplaySuccessor(runtime);
    }
  };
  const sectionOwner = new ElementOwner<HTMLElement>(onElementChange);
  const readAllOwner = new ElementOwner<HTMLButtonElement>(onElementChange);
  const listOwner = new ElementOwner<HTMLUListElement>(onElementChange);
  const rowOwners = Object.freeze(
    rows.map((row) => {
      const itemOwner = new ElementOwner<HTMLLIElement>(onElementChange);
      const openOwner = new ElementOwner<HTMLButtonElement>(onElementChange);
      const dismissOwner = new ElementOwner<HTMLButtonElement>(onElementChange);
      return Object.freeze({
        authority: row,
        captureItem: itemOwner.capture,
        captureOpen: openOwner.capture,
        captureDismiss: dismissOwner.capture,
        itemOwner,
        openOwner,
        dismissOwner,
      });
    }),
  );
  const expectedOwners = () =>
    Object.freeze([
      sectionOwner,
      readAllOwner,
      listOwner,
      ...rowOwners.flatMap(({ itemOwner, openOwner, dismissOwner }) => [
        itemOwner,
        openOwner,
        dismissOwner,
      ]),
    ]);

  const factsAreCurrent = () => {
    if (
      authority.snapshot !== snapshot ||
      authority.items !== items ||
      authority.router !== router ||
      authority.push !== push ||
      authority.markRead !== markRead ||
      authority.markAllRead !== markAllRead ||
      markNotificationRead !== markRead ||
      markAllNotificationsRead !== markAllRead ||
      authority.unreadCount !== unreadCount ||
      authority.rows !== rows ||
      snapshot.items !== items ||
      snapshot.unreadCount !== unreadCount ||
      router.push !== push
    ) {
      return false;
    }

    const currentRows = items.filter((notification) => !notification.readAt);
    if (currentRows.length !== rows.length) return false;
    return rows.every(
      (row, index) =>
        row.index === index &&
        rows[index] === row &&
        currentRows[index] === row.source &&
        notificationFactsMatch(row.source, row.notification) &&
        notificationHref(row.notification) === row.href,
    );
  };

  const exactDomIsCurrent = () => {
    const section = sectionOwner.element();
    const readAll = readAllOwner.element();
    const list = listOwner.element();
    const ownerDocument = section?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (
      !section ||
      !section.isConnected ||
      !section.parentNode ||
      !ownerDocument ||
      !ownerWindow ||
      section.tagName !== "SECTION" ||
      section.dataset.testid !== "notifications-strip" ||
      section.getAttribute("aria-label") !== "Notifications" ||
      !readAll ||
      !readAll.isConnected ||
      readAll.ownerDocument !== ownerDocument ||
      readAll.type !== "button" ||
      !isEffectivelyEnabled(readAll) ||
      readAll.dataset.testid !== "notifications-strip-read-all" ||
      readAll.textContent?.trim() !== "Mark all read" ||
      !list ||
      !list.isConnected ||
      list.ownerDocument !== ownerDocument ||
      list.tagName !== "UL" ||
      list.parentElement !== section ||
      section.children.length !== 2 ||
      section.children.item(1) !== list ||
      list.children.length !== rowOwners.length
    ) {
      return false;
    }

    const header = section.children.item(0);
    if (
      !(header instanceof ownerWindow.HTMLDivElement) ||
      header.children.length !== 2 ||
      header.children.item(1) !== readAll ||
      readAll.parentElement !== header
    ) {
      return false;
    }

    return rowOwners.every((owned, index) => {
      const row = owned.authority;
      const item = owned.itemOwner.element();
      const open = owned.openOwner.element();
      const dismiss = owned.dismissOwner.element();
      return (
        rows[index] === row &&
        item instanceof ownerWindow.HTMLLIElement &&
        item.isConnected &&
        item.ownerDocument === ownerDocument &&
        item.parentElement === list &&
        list.children.item(index) === item &&
        item.dataset.testid === "notification-item" &&
        item.dataset.kind === row.notification.kind &&
        item.dataset.notificationId === row.notification.id &&
        item.children.length === 3 &&
        open instanceof ownerWindow.HTMLButtonElement &&
        open.isConnected &&
        open.ownerDocument === ownerDocument &&
        open.parentElement === item &&
        item.children.item(1) === open &&
        open.type === "button" &&
        isEffectivelyEnabled(open) &&
        open.dataset.testid === "notification-open" &&
        dismiss instanceof ownerWindow.HTMLButtonElement &&
        dismiss.isConnected &&
        dismiss.ownerDocument === ownerDocument &&
        dismiss.parentElement === item &&
        item.children.item(2) === dismiss &&
        dismiss.type === "button" &&
        isEffectivelyEnabled(dismiss) &&
        dismiss.dataset.testid === "notification-dismiss" &&
        dismiss.getAttribute("aria-label") === "Mark as read" &&
        dismiss.title === "Mark as read"
      );
    });
  };

  const requestReplaySuccessor = (runtime: NotificationPublicationRuntime) => {
    const replay = runtime.replay();
    if (
      successorRequested ||
      !coordinator.acceptsSuccessorOf(runtime.publication) ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !runtime.publishedDomMatches() ||
      !coordinator.stageReplay(replay)
    ) {
      return;
    }
    successorRequested = true;
    requestSuccessor();
  };

  const createRuntime = (
    section: HTMLElement,
    readAll: HTMLButtonElement,
    list: HTMLUListElement,
    dom: NotificationDomSnapshot,
  ): NotificationPublicationRuntime | null => {
    type Retirement = "element" | "layout";
    const ownerDocument = section.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const placement = captureNotificationPlacement(section);
    if (!ownerWindow || !placement) return null;
    const keyboard = captureNotificationKeyboardIntrinsics(ownerWindow);
    const domGuard = createNotificationDomGuard(section, placement);
    if (!domGuard) return null;
    const identity = Symbol("notification-strip-publication");
    const action = (
      kind: NotificationActionKind,
      rowIndex: number | null,
    ): NotificationActionPublication =>
      Object.freeze({
        identity: Symbol(`notification-strip-${kind}`),
        publicationIdentity: identity,
        kind,
        rowIndex,
      });
    const publishedRows = Object.freeze(
      rowOwners.map((owned, index) => {
        const item = owned.itemOwner.element();
        const open = owned.openOwner.element();
        const dismiss = owned.dismissOwner.element();
        if (!item || !open || !dismiss) {
          throw new Error("Cannot publish a notification row without every committed ref");
        }
        const openPath = captureNotificationEventPath(
          open,
          ownerDocument,
        );
        if (!openPath) {
          throw new Error("Cannot publish a notification row without its owner-realm path");
        }
        return Object.freeze({
          identity: Symbol("notification-strip-row"),
          authority: owned.authority,
          item,
          open,
          openPath,
          dismiss,
          openAction: action("open", index),
          dismissAction: action("dismiss", index),
        });
      }),
    );
    const openControls = Object.freeze(publishedRows.map((row) => row.open));
    const focusCustody: NotificationFocusCustody = Object.freeze({
      controls: openControls,
      activeElement: () => keyboard?.activeElement(),
      focus: (element: HTMLButtonElement) =>
        keyboard?.focus(element) === true,
    });
    const publication: NotificationStripPublication = Object.freeze({
      identity,
      authority,
      section,
      sectionParent: section.parentNode!,
      readAll,
      list,
      rows: publishedRows,
      openControls,
      readAllAction: action("read-all", null),
      ownerDocument,
      ownerWindow,
      dom,
      placement,
      focusCustody,
      keyboard,
    });
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let invalidReplay = false;
    let replayRefs: RefReplay[] = [];
    const retire = (reason: Retirement) => {
      if (retired) return false;
      retired = true;
      retirement = reason;
      coordinator.retire(publication);
      if (currentRuntime?.publication === publication) currentRuntime = null;
      queueMicrotask(() => {
        if (coordinator.replay()?.source !== publication) domGuard.release();
      });
      return true;
    };
    const publishedDomMatches = () =>
      section === dom.node &&
      section.parentNode === publication.sectionParent &&
      notificationPlacementMatches(section, placement) &&
      notificationDomMatches(dom, publication.ownerDocument) &&
      publication.rows.length === publication.openControls.length &&
      publication.rows.every(
        (row, index) =>
          row.open === publication.openControls[index] &&
          row.openPath[0] === row.open,
      );
    const refsHaveNoReplay = () =>
      !invalidReplay &&
      replayRefs.every(
        (entry) =>
          !entry.detached &&
          !entry.reattached &&
          entry.owner.element() === entry.element,
      );
    const refsHaveExactReplay = () =>
      !invalidReplay &&
      replayRefs.length > 0 &&
      replayRefs.every(
        (entry) =>
          entry.detached &&
          entry.reattached &&
          entry.owner.element() === entry.element,
      );
    const runtime: NotificationPublicationRuntime = Object.freeze({
      publication,
      publish: (owners: readonly ElementOwnerView[]) => {
        established = true;
        replayRefs = owners.map((owner) => {
          const element = owner.element();
          if (!element) {
            throw new Error("Cannot publish a notification strip without every committed ref");
          }
          return { owner, element, detached: false, reattached: false };
        });
        if (!coordinator.publish(publication)) {
          domGuard.release();
          return false;
        }
        return true;
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        layoutRetired = true;
        retire("layout");
      },
      noteRef: (
        owner: ElementOwnerView,
        element: HTMLElement | null,
        previous: HTMLElement | null,
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
        } else if (
          element === proof.element &&
          previous === null &&
          proof.detached
        ) {
          proof.reattached = true;
        } else if (element !== previous) {
          invalidReplay = true;
        }
        if (
          !retired &&
          replayRefs.every((entry) => entry.owner.element() === entry.element)
        ) {
          for (const entry of replayRefs) {
            entry.detached = false;
            entry.reattached = false;
          }
          invalidReplay = false;
        }
      },
      isRetired: () => retired,
      publishedDomMatches,
      historyIsClean: domGuard.isClean,
      isExactElementReplay: () =>
        retired &&
        retirement === "element" &&
        layoutRetired &&
        established &&
        refsHaveExactReplay() &&
        domGuard.isClean() &&
        publishedDomMatches(),
      isExactLayoutReplay: () =>
        retired &&
        retirement === "layout" &&
        established &&
        (refsHaveNoReplay() || refsHaveExactReplay()) &&
        domGuard.isClean() &&
        publishedDomMatches(),
      replay: () =>
        Object.freeze({
          source: publication,
          dom,
          placement,
          openControls,
          historyIsClean: domGuard.isClean,
          release: domGuard.release,
        }),
    });
    return runtime;
  };

  const nativeClick = (
    publication: NotificationStripPublication,
    source: HTMLButtonElement,
    event: ReactMouseEvent<HTMLButtonElement>,
  ): MouseEvent | null => {
    if (!event || typeof event !== "object") return null;
    const ownerWindow = publication.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    const reactEvent = event as ReactMouseEvent<HTMLButtonElement> & {
      _reactName?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
      persist?: unknown;
    };
    const reactEventPrototype = Object.getPrototypeOf(event) as {
      constructor?: { name?: unknown };
    } | null;
    if (
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      nativeEvent.eventPhase === ownerWindow.Event.NONE ||
      event.type !== "click" ||
      event.button !== 0 ||
      !event.bubbles ||
      event.currentTarget !== source ||
      target !== nativeEvent.target ||
      !(target instanceof ownerWindow.Node) ||
      target.ownerDocument !== publication.ownerDocument ||
      !source.contains(target) ||
      !nativeEvent.composedPath().includes(source) ||
      !nativeEvent.composedPath().includes(publication.section) ||
      reactEventPrototype?.constructor?.name !== "SyntheticBaseEvent" ||
      reactEvent._reactName !== "onClick" ||
      typeof reactEvent.isDefaultPrevented !== "function" ||
      typeof reactEvent.isPropagationStopped !== "function" ||
      typeof reactEvent.persist !== "function"
    ) {
      return null;
    }
    const targetWasCommitted = (snapshot: NotificationDomSnapshot): boolean =>
      snapshot.node === target ||
      snapshot.children.some(targetWasCommitted);
    return targetWasCommitted(publication.dom) ? nativeEvent : null;
  };

  const claim = (
    kind: NotificationActionKind,
    row: NotificationRowAuthority,
    event: ReactMouseEvent<HTMLButtonElement>,
  ): NotificationStripPublication | null => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const publishedRow =
      publication && rows[row.index] === row
        ? publication.rows[row.index]
        : null;
    const action =
      kind === "open"
        ? publishedRow?.openAction
        : publishedRow?.dismissAction;
    const source = event?.currentTarget;
    const expectedSource =
      kind === "open"
        ? publishedRow?.open
        : publishedRow?.dismiss;
    if (
      !runtime ||
      !publication ||
      runtime.isRetired() ||
      publication.authority !== authority ||
      publishedRow?.authority !== row ||
      !action ||
      !source ||
      source !== expectedSource ||
      !source.isConnected ||
      !isEffectivelyEnabled(source) ||
      !coordinator.isCurrent(publication) ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !runtime.publishedDomMatches()
    ) {
      return null;
    }
    const nativeEvent = nativeClick(publication, source, event);
    if (
      !nativeEvent ||
      coordinator.hasClaimed(publication, action, event, nativeEvent) ||
      !coordinator.claim(publication, action, event, nativeEvent)
    ) {
      return null;
    }
    return publication;
  };

  const claimReadAll = (
    event: ReactMouseEvent<HTMLButtonElement>,
  ): NotificationStripPublication | null => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const source = event?.currentTarget;
    const action = publication?.readAllAction;
    if (
      !runtime ||
      !publication ||
      runtime.isRetired() ||
      publication.authority !== authority ||
      !action ||
      !source ||
      source !== publication.readAll ||
      !source.isConnected ||
      !isEffectivelyEnabled(source) ||
      !coordinator.isCurrent(publication) ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !runtime.publishedDomMatches()
    ) {
      return null;
    }
    const nativeEvent = nativeClick(publication, source, event);
    if (
      !nativeEvent ||
      coordinator.hasClaimed(publication, action, event, nativeEvent) ||
      !coordinator.claim(publication, action, event, nativeEvent)
    ) {
      return null;
    }
    return publication;
  };

  const keyboardFacts = (
    publication: NotificationStripPublication,
    row: NotificationRowPublication,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (!event || typeof event !== "object") return null;
    const source = row.open;
    const sourceIndex = row.authority.index;
    const nativeEvent = event.nativeEvent;
    const reactEvent = event as ReactKeyboardEvent<HTMLButtonElement> & {
      _reactName?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
      persist?: unknown;
    };
    const reactEventPrototype = Object.getPrototypeOf(event) as {
      constructor?: { name?: unknown };
    } | null;
    const keyboard = publication.keyboard;
    if (
      !keyboard ||
      !nativeEvent ||
      typeof nativeEvent !== "object"
    ) {
      return null;
    }
    const nativeFacts = keyboard.read(nativeEvent);
    if (!nativeFacts) return null;
    const {
      key,
      ctrlKey,
      altKey,
      metaKey,
      shiftKey,
      repeat,
      isComposing,
      target,
      path,
    } = nativeFacts;
    if (!isNotificationNavigationKey(key)) return null;
    const reactIsComposing = (
      event as unknown as { isComposing?: unknown }
    ).isComposing;
    if (
      nativeFacts.type !== "keydown" ||
      nativeFacts.phase === publication.ownerWindow.Event.NONE ||
      !nativeFacts.bubbles ||
      !nativeFacts.cancelable ||
      nativeFacts.defaultPrevented ||
      nativeFacts.cancelBubble ||
      nativeFacts.isTrusted !== true ||
      nativeFacts.view !== publication.ownerWindow ||
      ctrlKey ||
      altKey ||
      metaKey ||
      repeat ||
      isComposing ||
      target !== source ||
      path.length !== row.openPath.length + 1 ||
      row.openPath.some((entry, index) => entry !== path[index]) ||
      event.type !== "keydown" ||
      event.currentTarget !== source ||
      event.target !== target ||
      event.key !== key ||
      event.ctrlKey !== ctrlKey ||
      event.altKey !== altKey ||
      event.metaKey !== metaKey ||
      event.shiftKey !== shiftKey ||
      event.repeat !== repeat ||
      (reactIsComposing !== undefined &&
        reactIsComposing !== isComposing) ||
      event.defaultPrevented ||
      reactEventPrototype?.constructor?.name !== "SyntheticBaseEvent" ||
      reactEvent._reactName !== "onKeyDown" ||
      typeof reactEvent.isDefaultPrevented !== "function" ||
      reactEvent.isDefaultPrevented() ||
      typeof reactEvent.isPropagationStopped !== "function" ||
      reactEvent.isPropagationStopped() ||
      typeof reactEvent.persist !== "function" ||
      publication.focusCustody.activeElement() !== source ||
      publication.openControls[sourceIndex] !== source
    ) {
      return null;
    }
    let destinationIndex = sourceIndex;
    if (key === "ArrowDown") {
      destinationIndex = (sourceIndex + 1) % publication.rows.length;
    } else if (key === "ArrowUp") {
      destinationIndex =
        (sourceIndex - 1 + publication.rows.length) % publication.rows.length;
    } else if (key === "Home") {
      destinationIndex = 0;
    } else if (key === "End") {
      destinationIndex = publication.rows.length - 1;
    }
    const destinationRow = publication.rows[destinationIndex];
    const destination = publication.openControls[destinationIndex];
    if (
      !destinationRow ||
      !destination ||
      destinationRow.open !== destination ||
      destinationRow.authority !== rows[destinationIndex] ||
      !destination.isConnected ||
      !isEffectivelyEnabled(destination)
    ) {
      return null;
    }
    return Object.freeze({
      publicationIdentity: publication.identity,
      nativeEvent,
      source,
      sourceIndex,
      destination,
      destinationIndex,
      key,
      ctrlKey,
      altKey,
      metaKey,
      shiftKey,
      repeat,
      isComposing,
      target,
      path: Object.freeze([...path]),
    });
  };

  const establish = () => {
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() ||
          lastRuntime.isExactElementReplay()) &&
        coordinator.acceptsSuccessorOf(lastRuntime.publication)
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (!factsAreCurrent() || !exactDomIsCurrent()) return undefined;
    const section = sectionOwner.element();
    const readAll = readAllOwner.element();
    const list = listOwner.element();
    if (!section || !readAll || !list) return undefined;
    const replay = coordinator.replay();
    if (replay) {
      const replayIsCurrent =
        replay.historyIsClean() &&
        coordinator.acceptsSuccessorOf(replay.source) &&
        authoritiesMatch(replay.source.authority, authority) &&
        replay.dom.node === section &&
        replay.placement.document === section.ownerDocument &&
        notificationPlacementMatches(section, replay.placement) &&
        notificationDomMatches(replay.dom, section.ownerDocument) &&
        replay.openControls.length === rowOwners.length &&
        rowOwners.every(
          (owned, index) =>
            owned.openOwner.element() === replay.openControls[index],
        );
      coordinator.abandonReplay(replay.source);
      if (!replayIsCurrent) return undefined;
    }
    const runtime = createRuntime(
      section,
      readAll,
      list,
      snapshotNotificationDom(section),
    );
    if (!runtime) return undefined;
    currentRuntime = runtime;
    lastRuntime = runtime;
    if (!runtime.publish(expectedOwners())) {
      runtime.retireForElement();
      return undefined;
    }
    return runtime.retireForLayout;
  };

  const onReadAll = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const publication = claimReadAll(event);
    if (!publication) return;
    void publication.authority.markAllRead();
  };
  const onOpen = (
    row: NotificationRowAuthority,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    const publication = claim("open", row, event);
    if (!publication) return;
    void publication.authority.markRead(row.notification.id);
    publication.authority.push(row.href);
  };
  const onDismiss = (
    row: NotificationRowAuthority,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    const publication = claim("dismiss", row, event);
    if (!publication) return;
    void publication.authority.markRead(row.notification.id);
  };
  const onBrowse = (
    row: NotificationRowAuthority,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const publishedRow =
      publication && rows[row.index] === row
        ? publication.rows[row.index]
        : null;
    if (
      !runtime ||
      !publication ||
      !publishedRow ||
      runtime.isRetired() ||
      publication.authority !== authority ||
      publishedRow.authority !== row ||
      !coordinator.isCurrent(publication) ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !runtime.historyIsClean() ||
      !runtime.publishedDomMatches()
    ) {
      return;
    }
    const facts = keyboardFacts(publication, publishedRow, event);
    if (
      !facts ||
      facts.publicationIdentity !== publication.identity ||
      !coordinator.claimKeyboard(publication, event, facts.nativeEvent)
    ) {
      return;
    }
    const keyboard = publication.keyboard;
    if (
      !keyboard ||
      !keyboard.preventDefault(facts.nativeEvent) ||
      !keyboard.defaultWasPrevented(facts.nativeEvent) ||
      runtime.isRetired() ||
      !coordinator.isCurrent(publication) ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !runtime.historyIsClean() ||
      !runtime.publishedDomMatches() ||
      publication.focusCustody.activeElement() !== facts.source ||
      publication.focusCustody.controls[facts.sourceIndex] !== facts.source ||
      publication.focusCustody.controls[facts.destinationIndex] !==
        facts.destination
    ) {
      return;
    }
    publication.focusCustody.focus(facts.destination);
  };

  return Object.freeze({
    captureSection: sectionOwner.capture,
    captureReadAll: readAllOwner.capture,
    captureList: listOwner.capture,
    rows: rowOwners,
    establish,
    onReadAll,
    onOpen,
    onDismiss,
    onBrowse,
  });
}

/**
 * Unread notifications of the current user (mentions, replies, resolutions, suggestion decisions,
 * shares), shown at the top of the dashboard. Renders nothing when there is nothing to show.
 * Clicking one marks it read and opens the document on the relevant thread.
 */
export function NotificationsStrip() {
  const router = useRouter();
  const snapshot = useNotifications();
  const [mount] = useState(() => Symbol("notifications-strip"));
  const [coordinator] = useState(() => new NotificationStripCoordinator(mount));
  const [, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const rows = Object.freeze(
    snapshot.items
      .filter((notification) => !notification.readAt)
      .map((source, index) => {
        const notification = captureNotification(source);
        return Object.freeze({
          index,
          source,
          notification,
          href: notificationHref(notification),
        });
      }),
  );
  const authority: NotificationStripAuthority = Object.freeze({
    mount,
    snapshot,
    items: snapshot.items,
    router,
    push: router.push,
    markRead: markNotificationRead,
    markAllRead: markAllNotificationsRead,
    unreadCount: snapshot.unreadCount,
    rows,
  });
  const publication = createNotificationStripPublication(
    authority,
    coordinator,
    requestPublicationSuccessor,
  );

  useLayoutEffect(() => publication.establish(), [publication]);

  if (authority.rows.length === 0) return null;
  const {
    captureSection,
    captureReadAll,
    captureList,
    rows: publishedRows,
    onReadAll,
    onOpen,
    onDismiss,
    onBrowse,
  } = publication;

  return (
    <section
      ref={captureSection}
      className="mb-8 rounded-2xl border border-accent/40 bg-accent-soft/40 p-4"
      aria-label="Notifications"
      data-testid="notifications-strip"
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Bell size={15} className="text-accent" /> Notifications
          <span className="text-ink-4">{authority.unreadCount}</span>
        </h2>
        <button
          ref={captureReadAll}
          type="button"
          className="btn btn-ghost h-7 gap-1.5 px-2 text-xs"
          onClick={onReadAll}
          data-testid="notifications-strip-read-all"
        >
          <CheckCheck size={14} /> Mark all read
        </button>
      </div>
      <ul ref={captureList} className="flex flex-col gap-1.5">
        {publishedRows.map((published) => {
          const row = published.authority;
          const notification = row.notification;
          return (
            <li
              ref={published.captureItem}
              key={notification.id}
              className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2 text-[13px] shadow-sm"
              data-testid="notification-item"
              data-kind={notification.kind}
              data-notification-id={notification.id}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-3">
                <KindIcon kind={notification.kind} />
              </span>
              <button
                ref={published.captureOpen}
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={(event) => onOpen(row, event)}
                onKeyDown={(event) => onBrowse(row, event)}
                data-testid="notification-open"
              >
                <span className="text-ink-2">
                  <span className="font-medium text-ink">{actorLabel(notification)}</span> {sentence(notification)}
                  {notification.kind !== "share" && (
                    <>
                      {" "}
                      in{" "}
                      <span className="font-medium text-ink" data-testid="notification-doc-title">
                        {notification.documentTitle}
                      </span>
                    </>
                  )}
                </span>
                <RelativeTime date={notification.createdAt} className="ml-2 text-xs text-ink-4" />
                {notification.snippet && notification.kind !== "share" && <span className="mt-0.5 block truncate text-ink-3">{notification.snippet}</span>}
              </button>
              <button
                ref={published.captureDismiss}
                type="button"
                className="icon-btn h-7 w-7 shrink-0"
                aria-label="Mark as read"
                title="Mark as read"
                onClick={(event) => onDismiss(row, event)}
                data-testid="notification-dismiss"
              >
                <X size={14} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
