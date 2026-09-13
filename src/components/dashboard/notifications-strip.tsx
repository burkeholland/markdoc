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
type NotificationKeyboardKey = "Delete";
type NotificationRowActionKey =
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "Home"
  | "End";
const NOTIFICATION_ROW_PREVENT_SCROLL = Object.freeze({
  preventScroll: true,
});

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

type NotificationActionKind =
  | "read-all"
  | "open"
  | "dismiss"
  | "browse"
  | "delete";

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
  readonly dismissPath: readonly EventTarget[];
  readonly openAction: NotificationActionPublication;
  readonly dismissAction: NotificationActionPublication;
  readonly browseAction: NotificationActionPublication;
  readonly deleteAction: NotificationActionPublication;
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

interface NotificationNativeEventFacts {
  readonly type: string;
  readonly currentTarget: EventTarget | null;
  readonly phase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly cancelBubble: boolean;
  readonly target: EventTarget | null;
  readonly path: readonly EventTarget[];
  readonly isTrusted: boolean;
  readonly view: EventTarget | null;
}

interface NotificationNativeKeyboardFacts extends NotificationNativeEventFacts {
  readonly composed: boolean;
  readonly detail: number;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
}

interface NotificationNativeClickFacts extends NotificationNativeEventFacts {
  readonly button: number;
  readonly buttons: number;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

interface NotificationEventIntrinsics {
  readonly ownerWindow: Window & typeof globalThis;
  readonly keyboardPrototype: object;
  readonly capturingPhase: number;
  readonly bubblingPhase: number;
  readonly apply: typeof Reflect.apply;
  readonly getPrototypeOf: typeof Object.getPrototypeOf;
  readonly readKeyboard: (event: object) => NotificationNativeKeyboardFacts | null;
  readonly readClick: (event: object) => NotificationNativeClickFacts | null;
  readonly ownDataMatches: (
    event: object,
    property: PropertyKey,
    value: unknown,
  ) => boolean;
  readonly methodMatches: (
    event: object,
    property: PropertyKey,
    value: unknown,
  ) => boolean;
  readonly defaultWasPrevented: (event: Event) => boolean;
  readonly activeElement: () => Element | null | undefined;
  readonly preventDefault: (event: Event) => boolean;
  readonly focus: (element: HTMLElement, options?: FocusOptions) => boolean;
  readonly addEventListener: NotificationWindowMethod<Window["addEventListener"]>;
  readonly removeEventListener: NotificationWindowMethod<Window["removeEventListener"]>;
}

interface NotificationFocusCustody {
  readonly controls: readonly HTMLButtonElement[];
  readonly rowControls: readonly (readonly [
    HTMLButtonElement,
    HTMLButtonElement,
  ])[];
  readonly activeElement: () => Element | null | undefined;
  readonly focus: (
    element: HTMLButtonElement,
    options?: FocusOptions,
  ) => boolean;
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
  readonly dismissControls: readonly HTMLButtonElement[];
  readonly readAllAction: NotificationActionPublication;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly dom: NotificationDomSnapshot;
  readonly placement: NotificationPlacement;
  readonly focusCustody: NotificationFocusCustody;
  readonly events: NotificationEventIntrinsics | null;
  readonly keyListener: NotificationKeyListener | null;
}

interface NotificationWindowMethod<Method> {
  readonly value: Method;
  readonly isCurrent: () => boolean;
}

interface NotificationWindowProof {
  readonly registration: NotificationKeyListener;
  readonly publication: NotificationStripPublication;
  readonly nativeEvent: KeyboardEvent;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly terminal: EventTarget;
  readonly path: readonly EventTarget[];
}

interface NotificationKeyListener {
  readonly proofFor: (
    event: KeyboardEvent,
    publication: NotificationStripPublication,
  ) => NotificationWindowProof | null;
  readonly claim: (
    proof: NotificationWindowProof,
    publication: NotificationStripPublication,
  ) => boolean;
  readonly retains: (
    proof: NotificationWindowProof,
    publication: NotificationStripPublication,
  ) => boolean;
  readonly activate: (publication: NotificationStripPublication) => boolean;
  readonly release: (publication: NotificationStripPublication) => void;
  readonly isCurrent: () => boolean;
}

interface NotificationReactKeyboardMethods {
  readonly preventDefault: ReactKeyboardEvent<HTMLElement>["preventDefault"];
  readonly isDefaultPrevented: () => boolean;
  readonly isPropagationStopped: () => boolean;
}

interface NotificationReactKeyboardSnapshot {
  readonly event: ReactKeyboardEvent<HTMLElement>;
  readonly nativeEvent: KeyboardEvent;
  readonly target: HTMLButtonElement;
  readonly currentTarget: HTMLElement;
  readonly phase: number;
  readonly view: ReactKeyboardEvent<HTMLElement>["view"];
  readonly methods: NotificationReactKeyboardMethods;
}

interface NotificationRowMovement {
  readonly identity: symbol;
  readonly publication: NotificationStripPublication;
  readonly row: NotificationRowPublication;
  readonly sourceAction: NotificationActionPublication;
  readonly destinationAction: NotificationActionPublication;
  readonly source: HTMLButtonElement;
  readonly destination: HTMLButtonElement;
  readonly key: NotificationRowActionKey;
}

interface NotificationRowKeyPair {
  readonly publication: NotificationStripPublication;
  readonly row: NotificationRowPublication;
  readonly native: NotificationNativeKeyboardFacts;
  readonly nativeEvent: KeyboardEvent;
  readonly capture: NotificationReactKeyboardSnapshot;
  readonly windowProof: NotificationWindowProof;
  readonly sourceAction: NotificationActionPublication;
  readonly destinationAction: NotificationActionPublication;
  readonly source: HTMLButtonElement;
  readonly destination: HTMLButtonElement;
  readonly key: NotificationRowActionKey;
  readonly movement: NotificationRowMovement;
  readonly publicationClaim: object;
  readonly rowClaim: object;
  readonly sourceClaim: object;
  readonly destinationClaim: object;
  readonly captureClaim: object;
  readonly nativeClaim: object;
  readonly windowClaim: object;
}

interface NotificationRowKeyDelivery {
  readonly pair: NotificationRowKeyPair;
  readonly bubble: NotificationReactKeyboardSnapshot;
}

interface NotificationListMovement {
  readonly identity: symbol;
  readonly publication: NotificationStripPublication;
  readonly order: readonly NotificationRowPublication[];
  readonly sourceRow: NotificationRowPublication;
  readonly destinationRow: NotificationRowPublication;
  readonly sourceAction: NotificationActionPublication;
  readonly destinationAction: NotificationActionPublication;
  readonly source: HTMLButtonElement;
  readonly destination: HTMLButtonElement;
  readonly key: NotificationNavigationKey;
}

interface NotificationListKeyPair {
  readonly publication: NotificationStripPublication;
  readonly pairings: WeakMap<KeyboardEvent, NotificationListKeyPair>;
  readonly native: NotificationNativeKeyboardFacts;
  readonly nativeEvent: KeyboardEvent;
  readonly capture: NotificationReactKeyboardSnapshot;
  readonly windowProof: NotificationWindowProof;
  readonly sourceRow: NotificationRowPublication;
  readonly destinationRow: NotificationRowPublication;
  readonly sourceAction: NotificationActionPublication;
  readonly destinationAction: NotificationActionPublication;
  readonly source: HTMLButtonElement;
  readonly destination: HTMLButtonElement;
  readonly key: NotificationNavigationKey;
  readonly movement: NotificationListMovement;
  readonly publicationClaim: object;
  readonly orderClaim: object;
  readonly authorityClaim: object;
  readonly sourceClaim: object;
  readonly destinationClaim: object;
  readonly captureClaim: object;
  readonly nativeClaim: object;
  readonly windowClaim: object;
}

interface NotificationListKeyDelivery {
  readonly pair: NotificationListKeyPair;
  readonly bubble: NotificationReactKeyboardSnapshot;
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
  readonly dismissControls: readonly HTMLButtonElement[];
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
  readonly onKeyDown: (
    row: NotificationRowAuthority,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly onRowKeyDownCapture: (
    row: NotificationRowAuthority,
    event: ReactKeyboardEvent<HTMLLIElement>,
  ) => void;
  readonly onListKeyDownCapture: (
    event: ReactKeyboardEvent<HTMLUListElement>,
  ) => void;
  readonly onDismissKeyDown: (
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
  #attemptedRowReactEvents = new WeakSet<object>();
  #attemptedRowNativeEvents = new WeakSet<object>();
  #claimedRowDeliveries = new WeakSet<NotificationRowKeyDelivery>();
  #claimedRowPairs = new WeakSet<NotificationRowKeyPair>();
  #claimedRowMovements = new WeakSet<NotificationRowMovement>();
  #claimedRowPublicationClaims = new WeakSet<object>();
  #claimedRowClaims = new WeakSet<object>();
  #claimedRowSourceClaims = new WeakSet<object>();
  #claimedRowDestinationClaims = new WeakSet<object>();
  #claimedRowCaptureClaims = new WeakSet<object>();
  #claimedRowNativeClaims = new WeakSet<object>();
  #claimedRowWindowClaims = new WeakSet<object>();
  #claimedRowReactEvents = new WeakSet<object>();
  #claimedRowNativeEvents = new WeakSet<object>();
  #activeRowDelivery: NotificationRowKeyDelivery | null = null;
  #claimedListDeliveries = new WeakSet<NotificationListKeyDelivery>();
  #claimedListPairs = new WeakSet<NotificationListKeyPair>();
  #claimedListMovements = new WeakSet<NotificationListMovement>();
  #claimedListPublicationClaims = new WeakSet<object>();
  #claimedListOrderClaims = new WeakSet<object>();
  #claimedListAuthorityClaims = new WeakSet<object>();
  #claimedListSourceClaims = new WeakSet<object>();
  #claimedListDestinationClaims = new WeakSet<object>();
  #claimedListCaptureClaims = new WeakSet<object>();
  #claimedListNativeClaims = new WeakSet<object>();
  #claimedListWindowClaims = new WeakSet<object>();
  #activeListDelivery: NotificationListKeyDelivery | null = null;

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
    action: NotificationActionPublication,
    event: object,
    nativeEvent: KeyboardEvent,
  ) {
    if (
      !this.isCurrent(publication) ||
      this.#claimedPublications.has(publication) ||
      this.#claimedActions.has(action) ||
      this.#claimedEvents.has(event) ||
      this.#claimedEvents.has(nativeEvent) ||
      action.publicationIdentity !== publication.identity ||
      action.rowIndex === null ||
      !(
        (action.kind === "browse" &&
          publication.rows[action.rowIndex]?.browseAction === action) ||
        (action.kind === "delete" &&
          publication.rows[action.rowIndex]?.deleteAction === action)
      )
    ) {
      return false;
    }
    const row = publication.rows[action.rowIndex];
    if (
      !row ||
      (action.kind === "delete" && this.#claimedRows.has(row))
    ) {
      return false;
    }
    this.#claimedActions.add(action);
    this.#claimedEvents.add(event);
    this.#claimedEvents.add(nativeEvent);
    this.#claimedPublications.add(publication);
    if (action.kind === "delete") this.#claimedRows.add(row);
    return true;
  }

  prepareRowCapture(event: object, nativeEvent: object) {
    if (
      this.#activeRowDelivery ||
      this.#attemptedRowReactEvents.has(event) ||
      this.#attemptedRowNativeEvents.has(nativeEvent)
    ) {
      return false;
    }
    this.#attemptedRowReactEvents.add(event);
    this.#attemptedRowNativeEvents.add(nativeEvent);
    return true;
  }

  prepareRowBubble(event: object, nativeEvent: object) {
    if (
      this.#activeRowDelivery ||
      this.#attemptedRowReactEvents.has(event) ||
      !this.#attemptedRowNativeEvents.has(nativeEvent)
    ) {
      return false;
    }
    this.#attemptedRowReactEvents.add(event);
    return true;
  }

  claimRowMovement(delivery: NotificationRowKeyDelivery) {
    const { pair, bubble } = delivery;
    if (
      this.#activeRowDelivery ||
      !this.isCurrent(pair.publication) ||
      pair.publication.rows[pair.row.authority.index] !== pair.row ||
      this.#claimedRowDeliveries.has(delivery) ||
      this.#claimedRowPairs.has(pair) ||
      this.#claimedRowMovements.has(pair.movement) ||
      this.#claimedRowPublicationClaims.has(pair.publicationClaim) ||
      this.#claimedRowClaims.has(pair.rowClaim) ||
      this.#claimedRowSourceClaims.has(pair.sourceClaim) ||
      this.#claimedRowDestinationClaims.has(pair.destinationClaim) ||
      this.#claimedRowCaptureClaims.has(pair.captureClaim) ||
      this.#claimedRowNativeClaims.has(pair.nativeClaim) ||
      this.#claimedRowWindowClaims.has(pair.windowClaim) ||
      this.#claimedRowReactEvents.has(pair.capture.event) ||
      this.#claimedRowReactEvents.has(bubble.event) ||
      this.#claimedRowNativeEvents.has(pair.nativeEvent) ||
      !this.#attemptedRowReactEvents.has(pair.capture.event) ||
      !this.#attemptedRowReactEvents.has(bubble.event) ||
      !this.#attemptedRowNativeEvents.has(pair.nativeEvent) ||
      !pair.publication.keyListener?.claim(
        pair.windowProof,
        pair.publication,
      )
    ) {
      return false;
    }
    this.#claimedRowDeliveries.add(delivery);
    this.#claimedRowPairs.add(pair);
    this.#claimedRowMovements.add(pair.movement);
    this.#claimedRowPublicationClaims.add(pair.publicationClaim);
    this.#claimedRowClaims.add(pair.rowClaim);
    this.#claimedRowSourceClaims.add(pair.sourceClaim);
    this.#claimedRowDestinationClaims.add(pair.destinationClaim);
    this.#claimedRowCaptureClaims.add(pair.captureClaim);
    this.#claimedRowNativeClaims.add(pair.nativeClaim);
    this.#claimedRowWindowClaims.add(pair.windowClaim);
    this.#claimedRowReactEvents.add(pair.capture.event);
    this.#claimedRowReactEvents.add(bubble.event);
    this.#claimedRowNativeEvents.add(pair.nativeEvent);
    this.#activeRowDelivery = delivery;
    return true;
  }

  rowMovementIsDelivering(delivery: NotificationRowKeyDelivery) {
    return (
      this.#activeRowDelivery === delivery &&
      this.#claimedRowDeliveries.has(delivery) &&
      this.#claimedRowPairs.has(delivery.pair) &&
      this.#claimedRowMovements.has(delivery.pair.movement) &&
      this.#claimedRowPublicationClaims.has(
        delivery.pair.publicationClaim,
      ) &&
      this.#claimedRowClaims.has(delivery.pair.rowClaim) &&
      this.#claimedRowSourceClaims.has(delivery.pair.sourceClaim) &&
      this.#claimedRowDestinationClaims.has(
        delivery.pair.destinationClaim,
      ) &&
      this.#claimedRowCaptureClaims.has(delivery.pair.captureClaim) &&
      this.#claimedRowNativeClaims.has(delivery.pair.nativeClaim) &&
      this.#claimedRowWindowClaims.has(delivery.pair.windowClaim) &&
      this.#claimedRowReactEvents.has(delivery.pair.capture.event) &&
      this.#claimedRowReactEvents.has(delivery.bubble.event) &&
      this.#claimedRowNativeEvents.has(delivery.pair.nativeEvent) &&
      this.isCurrent(delivery.pair.publication)
    );
  }

  finishRowMovement(delivery: NotificationRowKeyDelivery) {
    if (this.#activeRowDelivery === delivery) {
      this.#activeRowDelivery = null;
    }
  }

  canStageListMovement() {
    return this.#activeListDelivery === null;
  }

  claimListMovement(delivery: NotificationListKeyDelivery) {
    const { pair, bubble } = delivery;
    if (
      this.#activeListDelivery ||
      !this.isCurrent(pair.publication) ||
      pair.publication.rows[pair.sourceRow.authority.index] !==
        pair.sourceRow ||
      pair.publication.rows[pair.destinationRow.authority.index] !==
        pair.destinationRow ||
      this.#claimedPublications.has(pair.publication) ||
      this.#claimedActions.has(pair.sourceAction) ||
      this.#claimedEvents.has(pair.capture.event) ||
      this.#claimedEvents.has(bubble.event) ||
      this.#claimedEvents.has(pair.nativeEvent) ||
      this.#claimedListDeliveries.has(delivery) ||
      this.#claimedListPairs.has(pair) ||
      this.#claimedListMovements.has(pair.movement) ||
      this.#claimedListPublicationClaims.has(pair.publicationClaim) ||
      this.#claimedListOrderClaims.has(pair.orderClaim) ||
      this.#claimedListAuthorityClaims.has(pair.authorityClaim) ||
      this.#claimedListSourceClaims.has(pair.sourceClaim) ||
      this.#claimedListDestinationClaims.has(pair.destinationClaim) ||
      this.#claimedListCaptureClaims.has(pair.captureClaim) ||
      this.#claimedListNativeClaims.has(pair.nativeClaim) ||
      this.#claimedListWindowClaims.has(pair.windowClaim) ||
      !pair.publication.keyListener?.claim(
        pair.windowProof,
        pair.publication,
      )
    ) {
      return false;
    }
    this.#claimedPublications.add(pair.publication);
    this.#claimedActions.add(pair.sourceAction);
    this.#claimedEvents.add(pair.capture.event);
    this.#claimedEvents.add(bubble.event);
    this.#claimedEvents.add(pair.nativeEvent);
    this.#claimedListDeliveries.add(delivery);
    this.#claimedListPairs.add(pair);
    this.#claimedListMovements.add(pair.movement);
    this.#claimedListPublicationClaims.add(pair.publicationClaim);
    this.#claimedListOrderClaims.add(pair.orderClaim);
    this.#claimedListAuthorityClaims.add(pair.authorityClaim);
    this.#claimedListSourceClaims.add(pair.sourceClaim);
    this.#claimedListDestinationClaims.add(pair.destinationClaim);
    this.#claimedListCaptureClaims.add(pair.captureClaim);
    this.#claimedListNativeClaims.add(pair.nativeClaim);
    this.#claimedListWindowClaims.add(pair.windowClaim);
    this.#activeListDelivery = delivery;
    return true;
  }

  listMovementIsDelivering(delivery: NotificationListKeyDelivery) {
    const { pair, bubble } = delivery;
    return (
      this.#activeListDelivery === delivery &&
      this.#claimedPublications.has(pair.publication) &&
      this.#claimedActions.has(pair.sourceAction) &&
      this.#claimedEvents.has(pair.capture.event) &&
      this.#claimedEvents.has(bubble.event) &&
      this.#claimedEvents.has(pair.nativeEvent) &&
      this.#claimedListDeliveries.has(delivery) &&
      this.#claimedListPairs.has(pair) &&
      this.#claimedListMovements.has(pair.movement) &&
      this.#claimedListPublicationClaims.has(pair.publicationClaim) &&
      this.#claimedListOrderClaims.has(pair.orderClaim) &&
      this.#claimedListAuthorityClaims.has(pair.authorityClaim) &&
      this.#claimedListSourceClaims.has(pair.sourceClaim) &&
      this.#claimedListDestinationClaims.has(pair.destinationClaim) &&
      this.#claimedListCaptureClaims.has(pair.captureClaim) &&
      this.#claimedListNativeClaims.has(pair.nativeClaim) &&
      this.#claimedListWindowClaims.has(pair.windowClaim) &&
      pair.movement.publication === pair.publication &&
      pair.movement.order === pair.publication.rows &&
      pair.movement.sourceRow === pair.sourceRow &&
      pair.movement.destinationRow === pair.destinationRow &&
      pair.movement.sourceAction === pair.sourceAction &&
      pair.movement.destinationAction === pair.destinationAction &&
      pair.movement.source === pair.source &&
      pair.movement.destination === pair.destination &&
      pair.movement.key === pair.key &&
      this.isCurrent(pair.publication)
    );
  }

  finishListMovement(delivery: NotificationListKeyDelivery) {
    if (this.#activeListDelivery === delivery) {
      this.#activeListDelivery = null;
    }
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

function notificationDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
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

function captureStableGetter<T>(
  prototype: object | null,
  property: PropertyKey,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  apply: typeof Reflect.apply,
): NotificationStableGetter<T> | null {
  if (!prototype) return null;
  const descriptor = getOwnPropertyDescriptor(prototype, property);
  if (!descriptor?.get) return null;
  const expected = Object.freeze({ ...descriptor });
  const getter = descriptor.get as () => T;
  return Object.freeze({
    prototype,
    property,
    getter,
    read: (value: object) => apply(getter, value, []) as T,
    isCurrent: () =>
      notificationDescriptorsMatch(
        getOwnPropertyDescriptor(prototype, property),
        expected,
      ),
  });
}

function captureStableMethod<T extends (...args: never[]) => unknown>(
  prototype: object | null,
  property: PropertyKey,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  apply: typeof Reflect.apply,
): NotificationStableMethod<T> | null {
  if (!prototype) return null;
  const descriptor = getOwnPropertyDescriptor(prototype, property);
  if (
    !descriptor ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function"
  ) {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  const method = descriptor.value as (...args: never[]) => unknown;
  return Object.freeze({
    prototype,
    property,
    method,
    invoke: ((value: object, ...args: unknown[]) =>
      apply(method, value, args)) as unknown as T,
    isCurrent: () =>
      notificationDescriptorsMatch(
        getOwnPropertyDescriptor(prototype, property),
        expected,
      ),
  });
}

function captureNotificationWindowMethod<
  Property extends "addEventListener" | "removeEventListener",
>(
  ownerWindow: Window & typeof globalThis,
  property: Property,
): NotificationWindowMethod<Window[Property]> | null {
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
    ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
    ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
    ownerWindow.Reflect.get === reflectGet &&
    path.every(({ target: entry, descriptor, prototype }) => {
      const current = getOwnPropertyDescriptor(entry, property);
      return (
        getPrototypeOf(entry) === prototype &&
        (descriptor
          ? notificationDescriptorsMatch(current, descriptor)
          : current === undefined)
      );
    }) &&
    reflectGet(ownerWindow, property, ownerWindow) === value;
  return isCurrent() ? Object.freeze({ value, isCurrent }) : null;
}

function captureUnforgeableGetter<T>(
  owner: object | null,
  property: PropertyKey,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  apply: typeof Reflect.apply,
): NotificationUnforgeableGetter<T> | null {
  if (!owner) return null;
  const descriptor = getOwnPropertyDescriptor(owner, property);
  if (!descriptor?.get || "value" in descriptor) return null;
  const getter = descriptor.get as () => T;
  const setter = descriptor.set as undefined | ((value: T) => void);
  const configurable = descriptor.configurable === true;
  const enumerable = descriptor.enumerable === true;
  const matches = (value: object) => {
    const current = getOwnPropertyDescriptor(value, property);
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
      apply(getter, value, []) as T,
  });
}

function captureNotificationEventIntrinsics(
  ownerWindow: Window & typeof globalThis,
): NotificationEventIntrinsics | null {
  const objectConstructor = ownerWindow.Object;
  const reflectObject = ownerWindow.Reflect;
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const eventConstructor = ownerWindow.Event;
  const uiEventConstructor = ownerWindow.UIEvent;
  const keyboardConstructor = ownerWindow.KeyboardEvent;
  const mouseConstructor = ownerWindow.MouseEvent;
  const documentConstructor = ownerWindow.Document;
  const htmlElementConstructor = ownerWindow.HTMLElement;
  const eventPrototype = eventConstructor.prototype;
  const uiEventPrototype = uiEventConstructor.prototype;
  const keyboardPrototype = keyboardConstructor.prototype;
  const mousePrototype = mouseConstructor.prototype;
  const documentPrototype = documentConstructor.prototype;
  const htmlElementPrototype = htmlElementConstructor.prototype;
  const objectPrototype = ownerWindow.Object.prototype;
  const getter = <T,>(prototype: object, property: PropertyKey) =>
    captureStableGetter<T>(
      prototype,
      property,
      getOwnPropertyDescriptor,
      apply,
    );
  const method = <T extends (...args: never[]) => unknown>(
    prototype: object,
    property: PropertyKey,
  ) =>
    captureStableMethod<T>(
      prototype,
      property,
      getOwnPropertyDescriptor,
      apply,
    );
  const type = getter<string>(eventPrototype, "type");
  const currentTarget = getter<EventTarget | null>(
    eventPrototype,
    "currentTarget",
  );
  const phase = getter<number>(eventPrototype, "eventPhase");
  const bubbles = getter<boolean>(eventPrototype, "bubbles");
  const cancelable = getter<boolean>(eventPrototype, "cancelable");
  const defaultPrevented = getter<boolean>(
    eventPrototype,
    "defaultPrevented",
  );
  const cancelBubble = getter<boolean>(eventPrototype, "cancelBubble");
  const target = getter<EventTarget | null>(eventPrototype, "target");
  const composedPath = method<(event: Event) => EventTarget[]>(
    eventPrototype,
    "composedPath",
  );
  const preventDefault = method<(event: Event) => void>(
    eventPrototype,
    "preventDefault",
  );
  const view = getter<Window | null>(uiEventPrototype, "view");
  const key = getter<string>(keyboardPrototype, "key");
  const code = getter<string>(keyboardPrototype, "code");
  const location = getter<number>(keyboardPrototype, "location");
  const keyboardCtrl = getter<boolean>(keyboardPrototype, "ctrlKey");
  const keyboardAlt = getter<boolean>(keyboardPrototype, "altKey");
  const keyboardMeta = getter<boolean>(keyboardPrototype, "metaKey");
  const keyboardShift = getter<boolean>(keyboardPrototype, "shiftKey");
  const repeat = getter<boolean>(keyboardPrototype, "repeat");
  const composing = getter<boolean>(keyboardPrototype, "isComposing");
  const composed = getter<boolean>(eventPrototype, "composed");
  const detail = getter<number>(uiEventPrototype, "detail");
  const button = getter<number>(mousePrototype, "button");
  const buttons = getter<number>(mousePrototype, "buttons");
  const mouseCtrl = getter<boolean>(mousePrototype, "ctrlKey");
  const mouseAlt = getter<boolean>(mousePrototype, "altKey");
  const mouseMeta = getter<boolean>(mousePrototype, "metaKey");
  const mouseShift = getter<boolean>(mousePrototype, "shiftKey");
  const activeElement = getter<Element | null>(
    documentPrototype,
    "activeElement",
  );
  const focus = method<(
    element: HTMLElement,
    options?: FocusOptions,
  ) => void>(
    htmlElementPrototype,
    "focus",
  );
  const isPrototypeOf = method<(prototype: object, value: object) => boolean>(
    objectPrototype,
    "isPrototypeOf",
  );
  const addEventListener = captureNotificationWindowMethod(
    ownerWindow,
    "addEventListener",
  );
  const removeEventListener = captureNotificationWindowMethod(
    ownerWindow,
    "removeEventListener",
  );
  let keyboardProbe: KeyboardEvent;
  let mouseProbe: MouseEvent;
  try {
    keyboardProbe = new keyboardConstructor(
      "notification-keyboard-intrinsic",
    );
    mouseProbe = new mouseConstructor("notification-click-intrinsic");
  } catch {
    return null;
  }
  const keyboardTrusted = captureUnforgeableGetter<boolean>(
    keyboardProbe,
    "isTrusted",
    getOwnPropertyDescriptor,
    apply,
  );
  const clickTrusted = captureUnforgeableGetter<boolean>(
    mouseProbe,
    "isTrusted",
    getOwnPropertyDescriptor,
    apply,
  );
  const commonGetters = Object.freeze([
    type,
    currentTarget,
    phase,
    bubbles,
    cancelable,
    defaultPrevented,
    cancelBubble,
    target,
    view,
  ]);
  const keyboardGetters = Object.freeze([
    key,
    code,
    location,
    keyboardCtrl,
    keyboardAlt,
    keyboardMeta,
    keyboardShift,
    repeat,
    composing,
    composed,
    detail,
    activeElement,
  ]);
  const clickGetters = Object.freeze([
    button,
    buttons,
    mouseCtrl,
    mouseAlt,
    mouseMeta,
    mouseShift,
  ]);
  const commonMethods = Object.freeze([
    composedPath,
    preventDefault,
    isPrototypeOf,
  ]);
  const keyboardMethods = Object.freeze([focus]);
  if (
    [...commonGetters, ...keyboardGetters, ...clickGetters].some(
      (intrinsic) => !intrinsic || !intrinsic.isCurrent(),
    ) ||
    [...commonMethods, ...keyboardMethods].some(
      (intrinsic) => !intrinsic || !intrinsic.isCurrent(),
    ) ||
    !keyboardTrusted ||
    !keyboardTrusted.isCurrent() ||
    !clickTrusted ||
    !clickTrusted.isCurrent() ||
    !type ||
    !currentTarget ||
    !phase ||
    !bubbles ||
    !cancelable ||
    !defaultPrevented ||
    !cancelBubble ||
    !target ||
    !composedPath ||
    !preventDefault ||
    !view ||
    !key ||
    !code ||
    !location ||
    !keyboardCtrl ||
    !keyboardAlt ||
    !keyboardMeta ||
    !keyboardShift ||
    !repeat ||
    !composing ||
    !composed ||
    !detail ||
    !button ||
    !buttons ||
    !mouseCtrl ||
    !mouseAlt ||
    !mouseMeta ||
    !mouseShift ||
    !activeElement ||
    !focus ||
    !isPrototypeOf ||
    !addEventListener ||
    !addEventListener.isCurrent() ||
    !removeEventListener ||
    !removeEventListener.isCurrent()
  ) {
    return null;
  }
  const ownerRealmIsCurrent = () =>
    objectConstructor === ownerWindow.Object &&
    reflectObject === ownerWindow.Reflect &&
    eventConstructor === ownerWindow.Event &&
    uiEventConstructor === ownerWindow.UIEvent &&
    documentConstructor === ownerWindow.Document &&
    htmlElementConstructor === ownerWindow.HTMLElement &&
    eventPrototype === eventConstructor.prototype &&
    uiEventPrototype === uiEventConstructor.prototype &&
    documentPrototype === documentConstructor.prototype &&
    htmlElementPrototype === htmlElementConstructor.prototype &&
    objectPrototype === ownerWindow.Object.prototype &&
    ownerWindow.Object.getOwnPropertyDescriptor ===
      getOwnPropertyDescriptor &&
    ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
    ownerWindow.Reflect.apply === apply &&
    addEventListener.isCurrent() &&
    removeEventListener.isCurrent();
  let commonHistoryIsClean = true;
  let keyboardHistoryIsClean = true;
  let clickHistoryIsClean = true;
  const commonDescriptorsAreCurrent = () => {
    if (!commonHistoryIsClean) return false;
    commonHistoryIsClean =
      ownerRealmIsCurrent() &&
      commonGetters.every(
        (intrinsic) => intrinsic?.isCurrent() === true,
      ) &&
      commonMethods.every(
        (intrinsic) => intrinsic?.isCurrent() === true,
      );
    return commonHistoryIsClean;
  };
  const keyboardDescriptorsAreCurrent = () => {
    if (!keyboardHistoryIsClean) return false;
    keyboardHistoryIsClean =
      commonDescriptorsAreCurrent() &&
      keyboardConstructor === ownerWindow.KeyboardEvent &&
      keyboardPrototype === keyboardConstructor.prototype &&
      keyboardGetters.every(
        (intrinsic) => intrinsic?.isCurrent() === true,
      ) &&
      keyboardMethods.every(
        (intrinsic) => intrinsic?.isCurrent() === true,
      ) &&
      keyboardTrusted.isCurrent();
    return keyboardHistoryIsClean;
  };
  const clickDescriptorsAreCurrent = () => {
    if (!clickHistoryIsClean) return false;
    clickHistoryIsClean =
      commonDescriptorsAreCurrent() &&
      mouseConstructor === ownerWindow.MouseEvent &&
      mousePrototype === mouseConstructor.prototype &&
      clickGetters.every(
        (intrinsic) => intrinsic?.isCurrent() === true,
      ) &&
      clickTrusted.isCurrent();
    return clickHistoryIsClean;
  };
  const isOwnerPrototype = (prototype: object, event: object) =>
    isPrototypeOf.invoke(prototype, event);
  const readBase = (
    event: object,
    trusted: NotificationUnforgeableGetter<boolean>,
    descriptorsAreCurrent: () => boolean,
  ): NotificationNativeEventFacts | null => {
    if (!descriptorsAreCurrent() || !trusted.matches(event)) return null;
    const isTrusted = trusted.read(event);
    const eventView = view.read(event);
    if (isTrusted !== true) return null;
    return Object.freeze({
      type: type.read(event),
      currentTarget: currentTarget.read(event),
      phase: phase.read(event),
      bubbles: bubbles.read(event),
      cancelable: cancelable.read(event),
      defaultPrevented: defaultPrevented.read(event),
      cancelBubble: cancelBubble.read(event),
      target: target.read(event),
      path: Object.freeze([
        ...composedPath.invoke(event as Event),
      ]),
      isTrusted,
      view: eventView,
    });
  };
  return Object.freeze({
    ownerWindow,
    keyboardPrototype,
    capturingPhase: eventConstructor.CAPTURING_PHASE,
    bubblingPhase: eventConstructor.BUBBLING_PHASE,
    apply,
    getPrototypeOf,
    readKeyboard: (event: object) => {
      try {
        if (!isOwnerPrototype(keyboardPrototype, event)) return null;
        const base = readBase(
          event,
          keyboardTrusted,
          keyboardDescriptorsAreCurrent,
        );
        if (!base) return null;
        return Object.freeze({
          ...base,
          composed: composed.read(event),
          detail: detail.read(event),
          key: key.read(event),
          code: code.read(event),
          location: location.read(event),
          ctrlKey: keyboardCtrl.read(event),
          altKey: keyboardAlt.read(event),
          metaKey: keyboardMeta.read(event),
          shiftKey: keyboardShift.read(event),
          repeat: repeat.read(event),
          isComposing: composing.read(event),
        });
      } catch {
        return null;
      }
    },
    readClick: (event: object) => {
      try {
        if (!isOwnerPrototype(mousePrototype, event)) return null;
        const base = readBase(
          event,
          clickTrusted,
          clickDescriptorsAreCurrent,
        );
        if (!base) return null;
        if (base.view !== null && base.view !== ownerWindow) return null;
        return Object.freeze({
          ...base,
          button: button.read(event),
          buttons: buttons.read(event),
          ctrlKey: mouseCtrl.read(event),
          altKey: mouseAlt.read(event),
          metaKey: mouseMeta.read(event),
          shiftKey: mouseShift.read(event),
        });
      } catch {
        return null;
      }
    },
    ownDataMatches: (
      event: object,
      property: PropertyKey,
      value: unknown,
    ) => {
      if (!commonDescriptorsAreCurrent()) return false;
      try {
        const descriptor = getOwnPropertyDescriptor(event, property);
        return Boolean(
          descriptor &&
            "value" in descriptor &&
            descriptor.value === value,
        );
      } catch {
        return false;
      }
    },
    methodMatches: (
      event: object,
      property: PropertyKey,
      value: unknown,
    ) => {
      if (!commonDescriptorsAreCurrent() || typeof value !== "function") {
        return false;
      }
      try {
        let owner: object | null = event;
        while (owner) {
          const descriptor = getOwnPropertyDescriptor(owner, property);
          if (descriptor) {
            return "value" in descriptor && descriptor.value === value;
          }
          owner = getPrototypeOf(owner);
        }
        return false;
      } catch {
        return false;
      }
    },
    defaultWasPrevented: (event: Event) => {
      if (!keyboardDescriptorsAreCurrent()) return false;
      try {
        return defaultPrevented.read(event);
      } catch {
        return false;
      }
    },
    activeElement: () => {
      if (!keyboardDescriptorsAreCurrent()) return undefined;
      try {
        return activeElement.read(ownerWindow.document);
      } catch {
        return undefined;
      }
    },
    preventDefault: (event: Event) => {
      if (!keyboardDescriptorsAreCurrent()) return false;
      try {
        preventDefault.invoke(event);
        return true;
      } catch {
        return false;
      }
    },
    focus: (element: HTMLElement, options?: FocusOptions) => {
      if (!keyboardDescriptorsAreCurrent()) return false;
      try {
        if (options === undefined) {
          focus.invoke(element);
        } else {
          focus.invoke(element, options);
        }
        return true;
      } catch {
        return false;
      }
    },
    addEventListener,
    removeEventListener,
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

function notificationKeyboardPathMatches(
  path: readonly EventTarget[],
  expected: readonly EventTarget[],
  terminal: EventTarget,
) {
  return (
    expected.length > 0 &&
    path.length === expected.length + 1 &&
    expected.every((entry, index) => path[index] === entry) &&
    path.at(-1) === terminal
  );
}

function notificationKeyboardStableFactsMatch(
  left: NotificationNativeKeyboardFacts,
  right: NotificationNativeKeyboardFacts,
  rightDefaultPrevented = left.defaultPrevented,
) {
  return (
    left.type === right.type &&
    left.bubbles === right.bubbles &&
    left.cancelable === right.cancelable &&
    right.defaultPrevented === rightDefaultPrevented &&
    left.cancelBubble === right.cancelBubble &&
    left.target === right.target &&
    left.isTrusted === right.isTrusted &&
    left.view === right.view &&
    left.composed === right.composed &&
    left.detail === right.detail &&
    left.key === right.key &&
    left.code === right.code &&
    left.location === right.location &&
    left.ctrlKey === right.ctrlKey &&
    left.altKey === right.altKey &&
    left.metaKey === right.metaKey &&
    left.shiftKey === right.shiftKey &&
    left.repeat === right.repeat &&
    left.isComposing === right.isComposing &&
    left.path.length === right.path.length &&
    left.path.every((entry, index) => entry === right.path[index])
  );
}

function createNotificationKeyListener(
  intrinsics: NotificationEventIntrinsics,
): NotificationKeyListener {
  const proofs = new WeakMap<KeyboardEvent, NotificationWindowProof>();
  const invalidEvents = new WeakSet<Event>();
  const claimedEvents = new WeakSet<Event>();
  let publication: NotificationStripPublication | null = null;
  let active = false;
  let released = false;

  const listener: EventListener = function (
    this: EventTarget,
    event: Event,
  ) {
    const current = publication;
    if (
      !current ||
      !active ||
      released ||
      current.keyListener !== registration ||
      intrinsics.getPrototypeOf(event) !== intrinsics.keyboardPrototype ||
      invalidEvents.has(event)
    ) {
      return;
    }
    if (proofs.has(event as KeyboardEvent)) {
      invalidEvents.add(event);
      return;
    }
    const nativeEvent = event as KeyboardEvent;
    const facts = intrinsics.readKeyboard(nativeEvent);
    const terminal = facts?.path.at(-1);
    if (
      !facts ||
      !terminal ||
      facts.currentTarget !== this ||
      terminal !== this ||
      facts.phase !== intrinsics.capturingPhase ||
      facts.path.at(-2) !== current.ownerDocument
    ) {
      invalidEvents.add(event);
      return;
    }
    proofs.set(
      nativeEvent,
      Object.freeze({
        registration,
        publication: current,
        nativeEvent,
        receiver: this,
        currentTarget: this,
        terminal,
        path: Object.freeze([...facts.path]),
      }),
    );
  };

  const proofFor = (
    event: KeyboardEvent,
    current: NotificationStripPublication,
  ) => {
    const proof = proofs.get(event);
    if (
      !proof ||
      !active ||
      released ||
      publication !== current ||
      current.keyListener !== registration ||
      proof.registration !== registration ||
      proof.publication !== current ||
      proof.nativeEvent !== event ||
      proof.receiver !== proof.currentTarget ||
      proof.receiver !== proof.terminal ||
      claimedEvents.has(event) ||
      invalidEvents.has(event)
    ) {
      return null;
    }
    const facts = intrinsics.readKeyboard(event);
    return facts &&
      facts.path.length === proof.path.length &&
      facts.path.every((entry, index) => entry === proof.path[index]) &&
      facts.path.at(-2) === current.ownerDocument &&
      facts.path.at(-1) === proof.receiver
      ? proof
      : null;
  };

  const registration: NotificationKeyListener = Object.freeze({
    proofFor,
    claim: (
      proof: NotificationWindowProof,
      current: NotificationStripPublication,
    ) => {
      if (
        claimedEvents.has(proof.nativeEvent) ||
        proofFor(proof.nativeEvent, current) !== proof
      ) {
        return false;
      }
      claimedEvents.add(proof.nativeEvent);
      return true;
    },
    retains: (
      proof: NotificationWindowProof,
      current: NotificationStripPublication,
    ) =>
      publication === current &&
      current.keyListener === registration &&
      claimedEvents.has(proof.nativeEvent) &&
      proofs.get(proof.nativeEvent) === proof &&
      proof.publication === current &&
      proof.receiver === proof.currentTarget &&
      proof.receiver === proof.terminal &&
      !invalidEvents.has(proof.nativeEvent) &&
      active &&
      !released &&
      intrinsics.addEventListener.isCurrent() &&
      intrinsics.removeEventListener.isCurrent(),
    activate: (current: NotificationStripPublication) => {
      if (
        publication ||
        active ||
        released ||
        current.keyListener !== registration ||
        current.events !== intrinsics ||
        current.ownerWindow !== intrinsics.ownerWindow ||
        !intrinsics.addEventListener.isCurrent() ||
        !intrinsics.removeEventListener.isCurrent()
      ) {
        return false;
      }
      publication = current;
      active = true;
      try {
        intrinsics.apply(
          intrinsics.addEventListener.value,
          intrinsics.ownerWindow,
          ["keydown", listener, true],
        );
      } catch {
        publication = null;
        active = false;
        return false;
      }
      if (registration.isCurrent()) return true;
      publication = null;
      active = false;
      try {
        intrinsics.apply(
          intrinsics.removeEventListener.value,
          intrinsics.ownerWindow,
          ["keydown", listener, true],
        );
      } catch {
        return false;
      }
      return false;
    },
    release: (current: NotificationStripPublication) => {
      if (publication !== current || released) return;
      released = true;
      const wasActive = active;
      active = false;
      if (!wasActive) return;
      try {
        intrinsics.apply(
          intrinsics.removeEventListener.value,
          intrinsics.ownerWindow,
          ["keydown", listener, true],
        );
      } catch {
        return;
      }
    },
    isCurrent: () =>
      active &&
      !released &&
      publication?.events === intrinsics &&
      publication.keyListener === registration &&
      intrinsics.addEventListener.isCurrent() &&
      intrinsics.removeEventListener.isCurrent(),
  });
  return registration;
}

function notificationNativeDispatchMatches(
  facts: NotificationNativeEventFacts,
  target: Node,
  publication: NotificationStripPublication,
) {
  const expected = captureNotificationEventPath(
    target,
    publication.ownerDocument,
  );
  const currentTarget = facts.currentTarget;
  const terminal = facts.path.at(-1);
  return Boolean(
    expected &&
      facts.phase === publication.ownerWindow.Event.BUBBLING_PHASE &&
      facts.path.length === expected.length + 1 &&
      expected.every((entry, index) => facts.path[index] === entry) &&
      (terminal === publication.ownerWindow ||
        (typeof terminal === "object" &&
          terminal !== null &&
          "document" in terminal &&
          terminal.document === publication.ownerDocument)) &&
      currentTarget instanceof publication.ownerWindow.Node &&
      currentTarget.ownerDocument === publication.ownerDocument &&
      facts.path.includes(currentTarget) &&
      currentTarget.contains(publication.section)
  );
}

type NotificationReactEvent = {
  readonly _reactName?: unknown;
  readonly isPersistent?: unknown;
  readonly isDefaultPrevented?: unknown;
  readonly isPropagationStopped?: unknown;
  readonly persist?: unknown;
  readonly preventDefault?: unknown;
  readonly stopPropagation?: unknown;
};

function notificationReactMethodsMatch(
  event: object,
  proof: NotificationReactEvent,
  facts: NotificationNativeEventFacts,
  intrinsics: NotificationEventIntrinsics,
) {
  const isDefaultPrevented = proof.isDefaultPrevented;
  const isPropagationStopped = proof.isPropagationStopped;
  const isPersistent = proof.isPersistent;
  const persist = proof.persist;
  const preventDefault = proof.preventDefault;
  const stopPropagation = proof.stopPropagation;
  return (
    typeof isDefaultPrevented === "function" &&
    typeof isPropagationStopped === "function" &&
    isDefaultPrevented === isPropagationStopped &&
    intrinsics.methodMatches(
      event,
      "isDefaultPrevented",
      isDefaultPrevented,
    ) &&
    intrinsics.methodMatches(
      event,
      "isPropagationStopped",
      isPropagationStopped,
    ) &&
    isDefaultPrevented.call(event) === facts.defaultPrevented &&
    isPropagationStopped.call(event) === facts.cancelBubble &&
    typeof isPersistent === "function" &&
    intrinsics.methodMatches(event, "isPersistent", isPersistent) &&
    isPersistent.call(event) === true &&
    typeof persist === "function" &&
    intrinsics.methodMatches(event, "persist", persist) &&
    typeof preventDefault === "function" &&
    intrinsics.methodMatches(event, "preventDefault", preventDefault) &&
    typeof stopPropagation === "function" &&
    intrinsics.methodMatches(event, "stopPropagation", stopPropagation)
  );
}

function notificationReactOwnPropertiesMatch(
  event: object,
  entries: readonly (readonly [PropertyKey, unknown])[],
  intrinsics: NotificationEventIntrinsics,
) {
  return entries.every(([property, value]) =>
    intrinsics.ownDataMatches(event, property, value));
}

function captureNotificationReactKeyboard(
  event: ReactKeyboardEvent<HTMLElement>,
  publication: NotificationStripPublication,
  native: NotificationNativeKeyboardFacts,
  nativeEvent: KeyboardEvent,
  currentTarget: HTMLElement,
  windowProof: NotificationWindowProof,
): NotificationReactKeyboardSnapshot | null {
  const intrinsics = publication.events;
  if (!intrinsics) return null;
  try {
    const preventDefault = event.preventDefault;
    const isDefaultPrevented = event.isDefaultPrevented;
    const isPropagationStopped = event.isPropagationStopped;
    const reactIsComposing = (
      event as ReactKeyboardEvent<HTMLElement> & {
        isComposing?: unknown;
      }
    ).isComposing;
    const view = event.view;
    if (
      typeof preventDefault !== "function" ||
      typeof isDefaultPrevented !== "function" ||
      typeof isPropagationStopped !== "function" ||
      !intrinsics.methodMatches(event, "preventDefault", preventDefault) ||
      !intrinsics.methodMatches(
        event,
        "isDefaultPrevented",
        isDefaultPrevented,
      ) ||
      !intrinsics.methodMatches(
        event,
        "isPropagationStopped",
        isPropagationStopped,
      ) ||
      intrinsics.apply(isDefaultPrevented, event, []) !== false ||
      intrinsics.apply(isPropagationStopped, event, []) !== false ||
      event === (nativeEvent as unknown) ||
      event.nativeEvent !== nativeEvent ||
      event.type !== native.type ||
      event.target !== native.target ||
      event.currentTarget !== currentTarget ||
      event.eventPhase !== native.phase ||
      event.bubbles !== native.bubbles ||
      event.cancelable !== native.cancelable ||
      event.defaultPrevented !== native.defaultPrevented ||
      event.isTrusted !== native.isTrusted ||
      event.key !== native.key ||
      event.code !== native.code ||
      event.location !== native.location ||
      event.ctrlKey !== native.ctrlKey ||
      event.altKey !== native.altKey ||
      event.metaKey !== native.metaKey ||
      event.shiftKey !== native.shiftKey ||
      event.repeat !== native.repeat ||
      (reactIsComposing !== undefined &&
        reactIsComposing !== native.isComposing) ||
      event.detail !== native.detail ||
      (!Object.is(view, null) &&
        !Object.is(view, publication.ownerWindow) &&
        !Object.is(view, windowProof.receiver))
    ) {
      return null;
    }
    return Object.freeze({
      event,
      nativeEvent,
      target: native.target as HTMLButtonElement,
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
}

function notificationReactKeyboardRemainsExact(
  snapshot: NotificationReactKeyboardSnapshot,
  publication: NotificationStripPublication,
  native: NotificationNativeKeyboardFacts,
  currentTarget: HTMLElement | null,
  defaultPrevented = false,
) {
  const intrinsics = publication.events;
  if (!intrinsics) return false;
  try {
    const event = snapshot.event;
    const methods = snapshot.methods;
    const currentIsDefaultPrevented = event.isDefaultPrevented;
    const reactIsComposing = (
      event as ReactKeyboardEvent<HTMLElement> & {
        isComposing?: unknown;
      }
    ).isComposing;
    return (
      event.nativeEvent === snapshot.nativeEvent &&
      event.type === native.type &&
      event.target === snapshot.target &&
      event.target === native.target &&
      event.currentTarget === currentTarget &&
      event.eventPhase === snapshot.phase &&
      event.eventPhase === native.phase &&
      event.bubbles === native.bubbles &&
      event.cancelable === native.cancelable &&
      event.defaultPrevented === defaultPrevented &&
      event.isTrusted === native.isTrusted &&
      event.key === native.key &&
      event.code === native.code &&
      event.location === native.location &&
      event.ctrlKey === native.ctrlKey &&
      event.altKey === native.altKey &&
      event.metaKey === native.metaKey &&
      event.shiftKey === native.shiftKey &&
      event.repeat === native.repeat &&
      (reactIsComposing === undefined ||
        reactIsComposing === native.isComposing) &&
      event.detail === native.detail &&
      Object.is(event.view, snapshot.view) &&
      (Object.is(event.view, null) ||
        Object.is(event.view, publication.ownerWindow) ||
        Object.is(event.view, native.path.at(-1))) &&
      event.preventDefault === methods.preventDefault &&
      event.isPropagationStopped === methods.isPropagationStopped &&
      intrinsics.methodMatches(
        event,
        "preventDefault",
        methods.preventDefault,
      ) &&
      intrinsics.methodMatches(
        event,
        "isPropagationStopped",
        methods.isPropagationStopped,
      ) &&
      (defaultPrevented
        ? currentIsDefaultPrevented !== methods.isDefaultPrevented &&
          intrinsics.methodMatches(
            event,
            "isDefaultPrevented",
            currentIsDefaultPrevented,
          ) &&
          intrinsics.apply(
            currentIsDefaultPrevented,
            event,
            [],
          ) === true
        : currentIsDefaultPrevented === methods.isDefaultPrevented &&
          intrinsics.methodMatches(
            event,
            "isDefaultPrevented",
            methods.isDefaultPrevented,
          ) &&
          intrinsics.apply(
            methods.isDefaultPrevented,
            event,
            [],
          ) === false) &&
      intrinsics.apply(
        methods.isPropagationStopped,
        event,
        [],
      ) === false
    );
  } catch {
    return false;
  }
}

function captureNotificationPublicReactKeyboard(
  event: ReactKeyboardEvent<HTMLElement>,
  publication: NotificationStripPublication,
  native: NotificationNativeKeyboardFacts,
  nativeEvent: KeyboardEvent,
  currentTarget: HTMLElement,
  windowProof: NotificationWindowProof,
): NotificationReactKeyboardSnapshot | null {
  const intrinsics = publication.events;
  if (!intrinsics) return null;
  try {
    const preventDefault = event.preventDefault;
    const isDefaultPrevented = event.isDefaultPrevented;
    const isPropagationStopped = event.isPropagationStopped;
    const reactIsComposing = (
      event as ReactKeyboardEvent<HTMLElement> & {
        isComposing?: unknown;
      }
    ).isComposing;
    const view = event.view;
    if (
      typeof preventDefault !== "function" ||
      typeof isDefaultPrevented !== "function" ||
      typeof isPropagationStopped !== "function" ||
      intrinsics.apply(isDefaultPrevented, event, []) !== false ||
      intrinsics.apply(isPropagationStopped, event, []) !== false ||
      event.preventDefault !== preventDefault ||
      event.isDefaultPrevented !== isDefaultPrevented ||
      event.isPropagationStopped !== isPropagationStopped ||
      event === (nativeEvent as unknown) ||
      event.nativeEvent !== nativeEvent ||
      event.type !== native.type ||
      event.target !== native.target ||
      event.currentTarget !== currentTarget ||
      event.eventPhase !== native.phase ||
      event.bubbles !== native.bubbles ||
      event.cancelable !== native.cancelable ||
      event.defaultPrevented !== native.defaultPrevented ||
      event.isTrusted !== native.isTrusted ||
      event.key !== native.key ||
      event.code !== native.code ||
      event.location !== native.location ||
      event.ctrlKey !== native.ctrlKey ||
      event.altKey !== native.altKey ||
      event.metaKey !== native.metaKey ||
      event.shiftKey !== native.shiftKey ||
      event.repeat !== native.repeat ||
      (reactIsComposing !== undefined &&
        reactIsComposing !== native.isComposing) ||
      event.detail !== native.detail ||
      (!Object.is(view, null) &&
        !Object.is(view, publication.ownerWindow) &&
        !Object.is(view, windowProof.receiver))
    ) {
      return null;
    }
    return Object.freeze({
      event,
      nativeEvent,
      target: native.target as HTMLButtonElement,
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
}

function notificationPublicReactKeyboardRemainsExact(
  snapshot: NotificationReactKeyboardSnapshot,
  publication: NotificationStripPublication,
  native: NotificationNativeKeyboardFacts,
  currentTarget: HTMLElement | null,
  defaultPrevented = false,
) {
  const intrinsics = publication.events;
  if (!intrinsics) return false;
  try {
    const event = snapshot.event;
    const methods = snapshot.methods;
    const currentIsDefaultPrevented = event.isDefaultPrevented;
    const currentIsPropagationStopped = event.isPropagationStopped;
    const reactIsComposing = (
      event as ReactKeyboardEvent<HTMLElement> & {
        isComposing?: unknown;
      }
    ).isComposing;
    if (
      typeof currentIsDefaultPrevented !== "function" ||
      typeof currentIsPropagationStopped !== "function" ||
      event.nativeEvent !== snapshot.nativeEvent ||
      event.type !== native.type ||
      event.target !== snapshot.target ||
      event.target !== native.target ||
      event.currentTarget !== currentTarget ||
      event.eventPhase !== snapshot.phase ||
      event.eventPhase !== native.phase ||
      event.bubbles !== native.bubbles ||
      event.cancelable !== native.cancelable ||
      event.defaultPrevented !== defaultPrevented ||
      event.isTrusted !== native.isTrusted ||
      event.key !== native.key ||
      event.code !== native.code ||
      event.location !== native.location ||
      event.ctrlKey !== native.ctrlKey ||
      event.altKey !== native.altKey ||
      event.metaKey !== native.metaKey ||
      event.shiftKey !== native.shiftKey ||
      event.repeat !== native.repeat ||
      (reactIsComposing !== undefined &&
        reactIsComposing !== native.isComposing) ||
      event.detail !== native.detail ||
      !Object.is(event.view, snapshot.view) ||
      (!Object.is(event.view, null) &&
        !Object.is(event.view, publication.ownerWindow) &&
        !Object.is(event.view, native.path.at(-1))) ||
      event.preventDefault !== methods.preventDefault ||
      event.isPropagationStopped !== methods.isPropagationStopped ||
      (!defaultPrevented &&
        currentIsDefaultPrevented !== methods.isDefaultPrevented) ||
      intrinsics.apply(currentIsDefaultPrevented, event, []) !==
        defaultPrevented ||
      intrinsics.apply(currentIsPropagationStopped, event, []) !== false ||
      event.preventDefault !== methods.preventDefault ||
      event.isDefaultPrevented !== currentIsDefaultPrevented ||
      event.isPropagationStopped !== methods.isPropagationStopped ||
      event.nativeEvent !== snapshot.nativeEvent ||
      event.type !== native.type ||
      event.target !== snapshot.target ||
      event.target !== native.target ||
      event.currentTarget !== currentTarget ||
      event.eventPhase !== snapshot.phase ||
      event.eventPhase !== native.phase ||
      event.bubbles !== native.bubbles ||
      event.cancelable !== native.cancelable ||
      event.defaultPrevented !== defaultPrevented ||
      event.isTrusted !== native.isTrusted ||
      event.key !== native.key ||
      event.code !== native.code ||
      event.location !== native.location ||
      event.ctrlKey !== native.ctrlKey ||
      event.altKey !== native.altKey ||
      event.metaKey !== native.metaKey ||
      event.shiftKey !== native.shiftKey ||
      event.repeat !== native.repeat ||
      (reactIsComposing !== undefined &&
        reactIsComposing !== native.isComposing) ||
      event.detail !== native.detail ||
      !Object.is(event.view, snapshot.view)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function notificationRowDestination(
  row: NotificationRowPublication,
  source: HTMLButtonElement,
  key: string,
) {
  if (source === row.open && key === "ArrowRight") {
    return Object.freeze({
      key,
      sourceAction: row.openAction,
      destinationAction: row.dismissAction,
      destination: row.dismiss,
    });
  }
  if (
    source === row.dismiss &&
    (key === "ArrowLeft" || key === "ArrowUp" || key === "Home")
  ) {
    return Object.freeze({
      key,
      sourceAction: row.dismissAction,
      destinationAction: row.openAction,
      destination: row.open,
    });
  }
  return null;
}

function notificationListDestination(
  publication: NotificationStripPublication,
  sourceIndex: number,
  key: NotificationNavigationKey,
) {
  if (
    publication.rows.length <= 1 ||
    sourceIndex < 0 ||
    sourceIndex >= publication.rows.length
  ) {
    return null;
  }
  let destinationIndex = sourceIndex;
  if (key === "ArrowDown") {
    destinationIndex = (sourceIndex + 1) % publication.rows.length;
  } else if (key === "ArrowUp") {
    destinationIndex =
      (sourceIndex - 1 + publication.rows.length) %
      publication.rows.length;
  } else if (key === "Home") {
    destinationIndex = 0;
  } else {
    destinationIndex = publication.rows.length - 1;
  }
  if (destinationIndex === sourceIndex) return null;
  const row = publication.rows[destinationIndex];
  const destination = publication.openControls[destinationIndex];
  return row && destination && row.open === destination
    ? Object.freeze({ index: destinationIndex, row, destination })
    : null;
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
  let listKeyPublication: NotificationStripPublication | null = null;
  let listKeyPairs: WeakMap<KeyboardEvent, NotificationListKeyPair> | null =
    null;
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
  const activateListNavigation = (
    publication: NotificationStripPublication,
  ) => {
    if (listKeyPublication || listKeyPairs) return false;
    listKeyPublication = publication;
    listKeyPairs = new WeakMap<KeyboardEvent, NotificationListKeyPair>();
    return true;
  };
  const revokeListNavigation = (
    publication: NotificationStripPublication,
  ) => {
    if (listKeyPublication !== publication) return;
    listKeyPublication = null;
    listKeyPairs = null;
  };

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
    const events = captureNotificationEventIntrinsics(ownerWindow);
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
        const dismissPath = captureNotificationEventPath(
          dismiss,
          ownerDocument,
        );
        if (!openPath || !dismissPath) {
          throw new Error("Cannot publish a notification row without its owner-realm path");
        }
        return Object.freeze({
          identity: Symbol("notification-strip-row"),
          authority: owned.authority,
          item,
          open,
          openPath,
          dismiss,
          dismissPath,
          openAction: action("open", index),
          dismissAction: action("dismiss", index),
          browseAction: action("browse", index),
          deleteAction: action("delete", index),
        });
      }),
    );
    const openControls = Object.freeze(publishedRows.map((row) => row.open));
    const dismissControls = Object.freeze(
      publishedRows.map((row) => row.dismiss),
    );
    const focusCustody: NotificationFocusCustody = Object.freeze({
      controls: openControls,
      rowControls: Object.freeze(
        publishedRows.map((row) =>
          Object.freeze([row.open, row.dismiss] as const)),
      ),
      activeElement: () => events?.activeElement(),
      focus: (element: HTMLButtonElement, options?: FocusOptions) =>
        events?.focus(element, options) === true,
    });
    const keyListener = events
      ? createNotificationKeyListener(events)
      : null;
    const publication: NotificationStripPublication = Object.freeze({
      identity,
      authority,
      section,
      sectionParent: section.parentNode!,
      readAll,
      list,
      rows: publishedRows,
      openControls,
      dismissControls,
      readAllAction: action("read-all", null),
      ownerDocument,
      ownerWindow,
      dom,
      placement,
      focusCustody,
      events,
      keyListener,
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
      revokeListNavigation(publication);
      keyListener?.release(publication);
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
          row.dismiss === publication.dismissControls[index] &&
          row.openPath[0] === row.open &&
          row.dismissPath[0] === row.dismiss,
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
        if (
          !keyListener?.activate(publication) ||
          !activateListNavigation(publication)
        ) {
          retire("element");
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
          dismissControls,
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
    const intrinsics = publication.events;
    if (!intrinsics) return null;
    try {
      const nativeEvent = event.nativeEvent;
      if (!nativeEvent || typeof nativeEvent !== "object") return null;
      const facts = intrinsics.readClick(nativeEvent);
      if (!facts) return null;
      const target = facts.target;
      const proof = event as ReactMouseEvent<HTMLButtonElement> &
        NotificationReactEvent;
      if (
        facts.type !== "click" ||
        !facts.bubbles ||
        !facts.cancelable ||
        facts.defaultPrevented ||
        facts.cancelBubble ||
        facts.button !== 0 ||
        facts.buttons !== 0 ||
        facts.ctrlKey ||
        facts.altKey ||
        facts.metaKey ||
        facts.shiftKey ||
        !(target instanceof publication.ownerWindow.Node) ||
        target.ownerDocument !== publication.ownerDocument ||
        !source.contains(target) ||
        !publication.section.contains(source) ||
        !notificationNativeDispatchMatches(facts, target, publication) ||
        event.nativeEvent !== nativeEvent ||
        event.type !== facts.type ||
        event.currentTarget !== source ||
        event.target !== target ||
        event.eventPhase !== facts.phase ||
        event.bubbles !== facts.bubbles ||
        event.cancelable !== facts.cancelable ||
        event.defaultPrevented !== facts.defaultPrevented ||
        event.isTrusted !== facts.isTrusted ||
        !Object.is(event.view, facts.view) ||
        event.button !== facts.button ||
        event.buttons !== facts.buttons ||
        event.ctrlKey !== facts.ctrlKey ||
        event.altKey !== facts.altKey ||
        event.metaKey !== facts.metaKey ||
        event.shiftKey !== facts.shiftKey ||
        proof._reactName !== "onClick" ||
        !notificationReactOwnPropertiesMatch(
          event,
          [
            ["_reactName", proof._reactName],
            ["nativeEvent", nativeEvent],
            ["type", event.type],
            ["currentTarget", event.currentTarget],
            ["target", event.target],
            ["eventPhase", event.eventPhase],
            ["bubbles", event.bubbles],
            ["cancelable", event.cancelable],
            ["defaultPrevented", event.defaultPrevented],
            ["isTrusted", event.isTrusted],
            ["view", event.view],
            ["button", event.button],
            ["buttons", event.buttons],
            ["ctrlKey", event.ctrlKey],
            ["altKey", event.altKey],
            ["metaKey", event.metaKey],
            ["shiftKey", event.shiftKey],
          ],
          intrinsics,
        ) ||
        !notificationReactMethodsMatch(event, proof, facts, intrinsics)
      ) {
        return null;
      }
      const targetWasCommitted = (
        snapshot: NotificationDomSnapshot,
      ): boolean =>
        snapshot.node === target ||
        snapshot.children.some(targetWasCommitted);
      return targetWasCommitted(publication.dom) ? nativeEvent : null;
    } catch {
      return null;
    }
  };

  const claim = (
    kind: "open" | "dismiss",
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
    const intrinsics = publication.events;
    if (!intrinsics) return null;
    try {
      const nativeEvent = event.nativeEvent;
      if (!nativeEvent || typeof nativeEvent !== "object") return null;
      const nativeFacts = intrinsics.readKeyboard(nativeEvent);
      if (!nativeFacts) return null;
      const {
        key,
        code,
        location,
        ctrlKey,
        altKey,
        metaKey,
        shiftKey,
        repeat,
        isComposing,
        target,
        path,
      } = nativeFacts;
      if (
        key !== "Delete" ||
        code !== "Delete" ||
        location !==
          publication.ownerWindow.KeyboardEvent.DOM_KEY_LOCATION_STANDARD
      ) {
        return null;
      }
      const proof = event as ReactKeyboardEvent<HTMLButtonElement> &
        NotificationReactEvent;
      const reactIsComposing = (
        event as ReactKeyboardEvent<HTMLButtonElement> & {
          isComposing?: unknown;
        }
      ).isComposing;
      if (
        nativeFacts.type !== "keydown" ||
        !nativeFacts.bubbles ||
        !nativeFacts.cancelable ||
        nativeFacts.defaultPrevented ||
        nativeFacts.cancelBubble ||
        ctrlKey ||
        altKey ||
        metaKey ||
        shiftKey ||
        repeat ||
        isComposing ||
        (nativeFacts.view !== null &&
          nativeFacts.view !== publication.ownerWindow) ||
        target !== source ||
        path.length !== row.openPath.length + 1 ||
        row.openPath.some((entry, index) => entry !== path[index]) ||
        !notificationNativeDispatchMatches(
          nativeFacts,
          source,
          publication,
        ) ||
        event.nativeEvent !== nativeEvent ||
        event.type !== nativeFacts.type ||
        event.currentTarget !== source ||
        event.target !== target ||
        event.eventPhase !== nativeFacts.phase ||
        event.bubbles !== nativeFacts.bubbles ||
        event.cancelable !== nativeFacts.cancelable ||
        event.defaultPrevented !== nativeFacts.defaultPrevented ||
        event.isTrusted !== nativeFacts.isTrusted ||
        !Object.is(event.view, nativeFacts.view) ||
        event.key !== key ||
        event.code !== code ||
        event.location !== location ||
        event.ctrlKey !== ctrlKey ||
        event.altKey !== altKey ||
        event.metaKey !== metaKey ||
        event.shiftKey !== shiftKey ||
        event.repeat !== repeat ||
        (reactIsComposing !== undefined &&
          reactIsComposing !== isComposing) ||
        proof._reactName !== "onKeyDown" ||
        !notificationReactOwnPropertiesMatch(
          event,
          [
            ["_reactName", proof._reactName],
            ["nativeEvent", nativeEvent],
            ["type", event.type],
            ["currentTarget", event.currentTarget],
            ["target", event.target],
            ["eventPhase", event.eventPhase],
            ["bubbles", event.bubbles],
            ["cancelable", event.cancelable],
            ["defaultPrevented", event.defaultPrevented],
            ["isTrusted", event.isTrusted],
            ["view", event.view],
            ["key", event.key],
            ["code", event.code],
            ["location", event.location],
            ["ctrlKey", event.ctrlKey],
            ["altKey", event.altKey],
            ["metaKey", event.metaKey],
            ["shiftKey", event.shiftKey],
            ["repeat", event.repeat],
          ],
          intrinsics,
        ) ||
        !notificationReactMethodsMatch(
          event,
          proof,
          nativeFacts,
          intrinsics,
        ) ||
        publication.focusCustody.activeElement() !== source ||
        publication.openControls[sourceIndex] !== source
      ) {
        return null;
      }
      const destinationIndex = sourceIndex;
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
        actionKind: "delete",
        nativeEvent,
        source,
        sourceIndex,
        destination,
        destinationIndex,
        key: key as NotificationKeyboardKey,
      });
    } catch {
      return null;
    }
  };

  const rowKeyPairs = new WeakMap<object, NotificationRowKeyPair>();

  const rowMovementIsCurrent = (
    runtime: NotificationPublicationRuntime,
    publication: NotificationStripPublication,
    row: NotificationRowPublication,
    sourceAction: NotificationActionPublication,
    destinationAction: NotificationActionPublication,
    source: HTMLButtonElement,
    destination: HTMLButtonElement,
    key: NotificationRowActionKey,
  ) => {
    const sourceIsOpen = source === row.open;
    const expectedSourceAction = sourceIsOpen
      ? row.openAction
      : row.dismissAction;
    const expectedDestinationAction = sourceIsOpen
      ? row.dismissAction
      : row.openAction;
    const resolved = notificationRowDestination(row, source, key);
    return Boolean(
      currentRuntime === runtime &&
        !runtime.isRetired() &&
        publication.authority === authority &&
        publication.rows[row.authority.index] === row &&
        rows[row.authority.index] === row.authority &&
        row.authority.index >= 0 &&
        row.item === row.item.parentElement?.children.item(
          row.authority.index,
        ) &&
        sourceAction === expectedSourceAction &&
        destinationAction === expectedDestinationAction &&
        sourceAction.publicationIdentity === publication.identity &&
        destinationAction.publicationIdentity === publication.identity &&
        sourceAction.rowIndex === row.authority.index &&
        destinationAction.rowIndex === row.authority.index &&
        sourceAction.kind === (sourceIsOpen ? "open" : "dismiss") &&
        destinationAction.kind === (sourceIsOpen ? "dismiss" : "open") &&
        resolved?.sourceAction === sourceAction &&
        resolved.destinationAction === destinationAction &&
        resolved.destination === destination &&
        resolved.key === key &&
        publication.focusCustody.rowControls[row.authority.index]?.[0] ===
          row.open &&
        publication.focusCustody.rowControls[row.authority.index]?.[1] ===
          row.dismiss &&
        publication.focusCustody.activeElement() === source &&
        source.isConnected &&
        destination.isConnected &&
        source.ownerDocument === publication.ownerDocument &&
        destination.ownerDocument === publication.ownerDocument &&
        source.parentElement === row.item &&
        destination.parentElement === row.item &&
        isEffectivelyEnabled(source) &&
        isEffectivelyEnabled(destination) &&
        publication.keyListener?.isCurrent() === true &&
        coordinator.isCurrent(publication) &&
        factsAreCurrent() &&
        exactDomIsCurrent() &&
        runtime.historyIsClean() &&
        runtime.publishedDomMatches(),
    );
  };

  const listMovementIsCurrent = (
    runtime: NotificationPublicationRuntime,
    publication: NotificationStripPublication,
    pairings: WeakMap<KeyboardEvent, NotificationListKeyPair>,
    sourceRow: NotificationRowPublication,
    destinationRow: NotificationRowPublication,
    source: HTMLButtonElement,
    destination: HTMLButtonElement,
    key: NotificationNavigationKey,
  ) => {
    const sourceIndex = sourceRow.authority.index;
    const destinationIndex = destinationRow.authority.index;
    const resolved = notificationListDestination(
      publication,
      sourceIndex,
      key,
    );
    return Boolean(
      currentRuntime === runtime &&
      !runtime.isRetired() &&
      listKeyPublication === publication &&
      listKeyPairs === pairings &&
      publication.authority === authority &&
      rows[sourceIndex] === sourceRow.authority &&
      rows[destinationIndex] === destinationRow.authority &&
      publication.rows[sourceIndex] === sourceRow &&
      publication.rows[destinationIndex] === destinationRow &&
      sourceIndex >= 0 &&
      destinationIndex >= 0 &&
      sourceIndex !== destinationIndex &&
      sourceRow.item.parentElement === publication.list &&
      destinationRow.item.parentElement === publication.list &&
      publication.list.children.item(sourceIndex) === sourceRow.item &&
      publication.list.children.item(destinationIndex) ===
      destinationRow.item &&
      sourceRow.open === source &&
      destinationRow.open === destination &&
      sourceRow.browseAction.publicationIdentity === publication.identity &&
      destinationRow.browseAction.publicationIdentity ===
      publication.identity &&
      sourceRow.browseAction.rowIndex === sourceIndex &&
      destinationRow.browseAction.rowIndex === destinationIndex &&
      sourceRow.browseAction.kind === "browse" &&
      destinationRow.browseAction.kind === "browse" &&
      publication.openControls[sourceIndex] === source &&
      publication.openControls[destinationIndex] === destination &&
      publication.focusCustody.controls[sourceIndex] === source &&
      publication.focusCustody.controls[destinationIndex] === destination &&
      publication.focusCustody.activeElement() === source &&
      source.isConnected &&
      destination.isConnected &&
      source.ownerDocument === publication.ownerDocument &&
      destination.ownerDocument === publication.ownerDocument &&
      source.parentElement === sourceRow.item &&
      destination.parentElement === destinationRow.item &&
      isEffectivelyEnabled(source) &&
      isEffectivelyEnabled(destination) &&
      resolved?.index === destinationIndex &&
      resolved.row === destinationRow &&
      resolved.destination === destination &&
      publication.keyListener?.isCurrent() === true &&
      coordinator.isCurrent(publication) &&
      factsAreCurrent() &&
      exactDomIsCurrent() &&
      runtime.historyIsClean() &&
      runtime.publishedDomMatches(),
    );
  };

  const captureListNavigation = (
    event: ReactKeyboardEvent<HTMLUListElement>,
  ) => {
    let nativeEvent: unknown;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return;
    }
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const pairings = listKeyPairs;
    if (
      !runtime ||
      !publication ||
      !pairings ||
      listKeyPublication !== publication ||
      !nativeEvent ||
      typeof nativeEvent !== "object" ||
      pairings.has(nativeEvent as KeyboardEvent) ||
      !coordinator.canStageListMovement()
    ) {
      return;
    }
    const events = publication.events;
    const listener = publication.keyListener;
    if (
      !events ||
      !listener ||
      runtime.isRetired() ||
      publication.authority !== authority ||
      publication.list !== event.currentTarget
    ) {
      return;
    }
    const native = events.readKeyboard(nativeEvent);
    const proof = native
      ? listener.proofFor(
        nativeEvent as KeyboardEvent,
        publication,
      )
      : null;
    const sourceIndex = native
      ? publication.openControls.findIndex(
        (control) => control === native.target,
      )
      : -1;
    const sourceRow =
      sourceIndex >= 0 ? publication.rows[sourceIndex] : undefined;
    const source = sourceRow?.open;
    const key =
      native && isNotificationNavigationKey(native.key)
        ? native.key
        : null;
    const resolved =
      key && sourceRow
        ? notificationListDestination(publication, sourceIndex, key)
        : null;
    const capture =
      native && proof
        ? captureNotificationPublicReactKeyboard(
          event,
          publication,
          native,
          nativeEvent as KeyboardEvent,
          publication.list,
          proof,
        )
        : null;
    if (
      !native ||
      !proof ||
      !sourceRow ||
      !source ||
      !key ||
      !resolved ||
      !capture ||
      native.type !== "keydown" ||
      native.phase !== events.capturingPhase ||
      !native.bubbles ||
      !native.cancelable ||
      native.defaultPrevented ||
      native.cancelBubble ||
      !native.isTrusted ||
      native.ctrlKey ||
      native.altKey ||
      native.metaKey ||
      native.shiftKey ||
      native.repeat ||
      native.isComposing ||
      native.target !== source ||
      native.currentTarget === null ||
      !native.path.includes(native.currentTarget) ||
      proof.publication !== publication ||
      proof.nativeEvent !== nativeEvent ||
      proof.receiver !== proof.currentTarget ||
      proof.receiver !== proof.terminal ||
      native.path.at(-1) !== proof.receiver ||
      (native.view !== null &&
        native.view !== publication.ownerWindow &&
        native.view !== proof.receiver) ||
      !notificationKeyboardPathMatches(
        native.path,
        sourceRow.openPath,
        proof.receiver,
      ) ||
      !listMovementIsCurrent(
        runtime,
        publication,
        pairings,
        sourceRow,
        resolved.row,
        source,
        resolved.destination,
        key,
      )
    ) {
      return;
    }
    const movement = Object.freeze<NotificationListMovement>({
      identity: Symbol("notification-list-movement"),
      publication,
      order: publication.rows,
      sourceRow,
      destinationRow: resolved.row,
      sourceAction: sourceRow.browseAction,
      destinationAction: resolved.row.browseAction,
      source,
      destination: resolved.destination,
      key,
    });
    const pair = Object.freeze<NotificationListKeyPair>({
      publication,
      pairings,
      native,
      nativeEvent: nativeEvent as KeyboardEvent,
      capture,
      windowProof: proof,
      sourceRow,
      destinationRow: resolved.row,
      sourceAction: sourceRow.browseAction,
      destinationAction: resolved.row.browseAction,
      source,
      destination: resolved.destination,
      key,
      movement,
      publicationClaim: Object.freeze({ publication }),
      orderClaim: Object.freeze({
        rows: publication.rows,
        controls: publication.openControls,
      }),
      authorityClaim: Object.freeze({
        authority,
        snapshot,
        items,
        rows,
        router,
        push,
        markRead,
        markAllRead,
      }),
      sourceClaim: Object.freeze({
        row: sourceRow,
        action: sourceRow.browseAction,
        source,
      }),
      destinationClaim: Object.freeze({
        row: resolved.row,
        action: resolved.row.browseAction,
        destination: resolved.destination,
      }),
      captureClaim: Object.freeze({ capture }),
      nativeClaim: Object.freeze({ nativeEvent }),
      windowClaim: Object.freeze({
        listener,
        proof,
        receiver: proof.receiver,
      }),
    });
    if (
      currentRuntime === runtime &&
      listKeyPublication === publication &&
      listKeyPairs === pairings &&
      !pairings.has(pair.nativeEvent) &&
      coordinator.canStageListMovement()
    ) {
      pairings.set(pair.nativeEvent, pair);
    }
  };

  const completeListNavigation = (
    row: NotificationRowAuthority,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    let nativeEvent: unknown;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return;
    }
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const pairings = listKeyPairs;
    const pair =
      pairings && nativeEvent && typeof nativeEvent === "object"
        ? pairings.get(nativeEvent as KeyboardEvent)
        : undefined;
    if (
      !runtime ||
      !publication ||
      !pairings ||
      !pair ||
      listKeyPublication !== publication ||
      pair.publication !== publication ||
      pair.pairings !== pairings ||
      pair.nativeEvent !== nativeEvent ||
      pair.sourceRow.authority !== row ||
      rows[row.index] !== row ||
      !coordinator.canStageListMovement()
    ) {
      return;
    }
    const events = publication.events;
    const listener = publication.keyListener;
    if (!events || !listener) return;
    const native = events.readKeyboard(nativeEvent);
    const proof = native
      ? listener.proofFor(
        nativeEvent as KeyboardEvent,
        publication,
      )
      : null;
    const bubble =
      native && proof
        ? captureNotificationPublicReactKeyboard(
          event,
          publication,
          native,
          nativeEvent as KeyboardEvent,
          pair.source,
          proof,
        )
        : null;
    if (
      !native ||
      !proof ||
      !bubble ||
      bubble.event === pair.capture.event ||
      event.currentTarget !== pair.source ||
      pair.sourceRow.open !== pair.source ||
      pair.destinationRow.open !== pair.destination ||
      pair.sourceAction !== pair.sourceRow.browseAction ||
      pair.destinationAction !== pair.destinationRow.browseAction ||
      native.phase !== events.bubblingPhase ||
      pair.native.phase !== events.capturingPhase ||
      native.currentTarget !== pair.native.currentTarget ||
      proof !== pair.windowProof ||
      proof.receiver !== native.path.at(-1) ||
      !notificationKeyboardStableFactsMatch(pair.native, native) ||
      !notificationPublicReactKeyboardRemainsExact(
        pair.capture,
        publication,
        pair.native,
        null,
      ) ||
      !notificationPublicReactKeyboardRemainsExact(
        bubble,
        publication,
        native,
        pair.source,
      ) ||
      !listMovementIsCurrent(
        runtime,
        publication,
        pairings,
        pair.sourceRow,
        pair.destinationRow,
        pair.source,
        pair.destination,
        pair.key,
      ) ||
      listKeyPairs !== pairings ||
      pairings.get(pair.nativeEvent) !== pair
    ) {
      return;
    }
    const delivery = Object.freeze<NotificationListKeyDelivery>({
      pair,
      bubble,
    });
    if (!coordinator.claimListMovement(delivery)) return;
    try {
      if (
        currentRuntime !== runtime ||
        listKeyPublication !== publication ||
        listKeyPairs !== pairings ||
        pairings.get(pair.nativeEvent) !== pair ||
        !pairings.delete(pair.nativeEvent) ||
        !coordinator.listMovementIsDelivering(delivery) ||
        !listener.retains(pair.windowProof, publication) ||
        !notificationPublicReactKeyboardRemainsExact(
          pair.capture,
          publication,
          pair.native,
          null,
        ) ||
        !notificationPublicReactKeyboardRemainsExact(
          bubble,
          publication,
          native,
          pair.source,
        ) ||
        !listMovementIsCurrent(
          runtime,
          publication,
          pairings,
          pair.sourceRow,
          pair.destinationRow,
          pair.source,
          pair.destination,
          pair.key,
        )
      ) {
        return;
      }
      events.apply(
        bubble.methods.preventDefault,
        bubble.event,
        [],
      );
      const preventedNative = events.readKeyboard(pair.nativeEvent);
      if (
        !preventedNative ||
        !notificationKeyboardStableFactsMatch(
          native,
          preventedNative,
          true,
        ) ||
        preventedNative.currentTarget !== native.currentTarget ||
        preventedNative.phase !== native.phase ||
        !notificationPublicReactKeyboardRemainsExact(
          pair.capture,
          publication,
          pair.native,
          null,
        ) ||
        !notificationPublicReactKeyboardRemainsExact(
          bubble,
          publication,
          preventedNative,
          pair.source,
          true,
        )
      ) {
        return;
      }
      const finalNative = events.readKeyboard(pair.nativeEvent);
      if (
        !finalNative ||
        !notificationKeyboardStableFactsMatch(
          preventedNative,
          finalNative,
          true,
        ) ||
        finalNative.currentTarget !== preventedNative.currentTarget ||
        finalNative.phase !== preventedNative.phase ||
        finalNative.cancelBubble ||
        !listener.retains(pair.windowProof, publication) ||
        !coordinator.listMovementIsDelivering(delivery) ||
        currentRuntime !== runtime ||
        listKeyPublication !== publication ||
        listKeyPairs !== pairings ||
        pairings.has(pair.nativeEvent) ||
        !listMovementIsCurrent(
          runtime,
          publication,
          pairings,
          pair.sourceRow,
          pair.destinationRow,
          pair.source,
          pair.destination,
          pair.key,
        )
      ) {
        return;
      }
      publication.focusCustody.focus(
        pair.destination,
        NOTIFICATION_ROW_PREVENT_SCROLL,
      );
    } finally {
      coordinator.finishListMovement(delivery);
    }
  };

  const captureRowNavigation = (
    row: NotificationRowAuthority,
    event: ReactKeyboardEvent<HTMLLIElement>,
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
      rowKeyPairs.has(nativeEvent) ||
      !coordinator.prepareRowCapture(event, nativeEvent)
    ) {
      return;
    }
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const publishedRow =
      publication && rows[row.index] === row
        ? publication.rows[row.index]
        : null;
    const events = publication?.events;
    const listener = publication?.keyListener;
    if (
      !runtime ||
      !publication ||
      !publishedRow ||
      !events ||
      !listener ||
      runtime.isRetired() ||
      publication.authority !== authority ||
      publishedRow.authority !== row ||
      publishedRow.item !== event.currentTarget
    ) {
      return;
    }
    const native = events.readKeyboard(nativeEvent);
    const proof = native
      ? listener.proofFor(
          nativeEvent as KeyboardEvent,
          publication,
        )
      : null;
    const source =
      native?.target === publishedRow.open
        ? publishedRow.open
        : native?.target === publishedRow.dismiss
          ? publishedRow.dismiss
          : null;
    const resolved =
      source && native
        ? notificationRowDestination(
            publishedRow,
            source,
            native.key,
          )
        : null;
    const sourcePath =
      source === publishedRow.open
        ? publishedRow.openPath
        : publishedRow.dismissPath;
    const capture =
      native && proof
        ? captureNotificationReactKeyboard(
            event,
            publication,
            native,
            nativeEvent as KeyboardEvent,
            publishedRow.item,
            proof,
          )
        : null;
    if (
      !native ||
      !proof ||
      !source ||
      !resolved ||
      !capture ||
      native.type !== "keydown" ||
      native.phase !== events.capturingPhase ||
      !native.bubbles ||
      !native.cancelable ||
      native.defaultPrevented ||
      native.cancelBubble ||
      !native.isTrusted ||
      native.ctrlKey ||
      native.altKey ||
      native.metaKey ||
      native.shiftKey ||
      native.repeat ||
      native.isComposing ||
      native.target !== source ||
      native.currentTarget === null ||
      !native.path.includes(native.currentTarget) ||
      proof.publication !== publication ||
      proof.nativeEvent !== nativeEvent ||
      proof.receiver !== proof.currentTarget ||
      proof.receiver !== proof.terminal ||
      native.path.at(-1) !== proof.receiver ||
      (native.view !== null &&
        native.view !== publication.ownerWindow &&
        native.view !== proof.receiver) ||
      !notificationKeyboardPathMatches(
        native.path,
        sourcePath,
        proof.receiver,
      ) ||
      !rowMovementIsCurrent(
        runtime,
        publication,
        publishedRow,
        resolved.sourceAction,
        resolved.destinationAction,
        source,
        resolved.destination,
        resolved.key,
      )
    ) {
      return;
    }
    const movement = Object.freeze<NotificationRowMovement>({
      identity: Symbol("notification-row-action-movement"),
      publication,
      row: publishedRow,
      sourceAction: resolved.sourceAction,
      destinationAction: resolved.destinationAction,
      source,
      destination: resolved.destination,
      key: resolved.key,
    });
    const pair = Object.freeze<NotificationRowKeyPair>({
      publication,
      row: publishedRow,
      native,
      nativeEvent: nativeEvent as KeyboardEvent,
      capture,
      windowProof: proof,
      sourceAction: resolved.sourceAction,
      destinationAction: resolved.destinationAction,
      source,
      destination: resolved.destination,
      key: resolved.key,
      movement,
      publicationClaim: Object.freeze({ publication }),
      rowClaim: Object.freeze({ row: publishedRow }),
      sourceClaim: Object.freeze({
        action: resolved.sourceAction,
        source,
      }),
      destinationClaim: Object.freeze({
        action: resolved.destinationAction,
        destination: resolved.destination,
      }),
      captureClaim: Object.freeze({ capture }),
      nativeClaim: Object.freeze({ nativeEvent }),
      windowClaim: Object.freeze({
        listener,
        proof,
        receiver: proof.receiver,
      }),
    });
    rowKeyPairs.set(nativeEvent, pair);
  };

  const completeRowNavigation = (
    row: NotificationRowAuthority,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    let nativeEvent: unknown;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return;
    }
    const pair =
      nativeEvent && typeof nativeEvent === "object"
        ? rowKeyPairs.get(nativeEvent)
        : undefined;
    if (
      !pair ||
      !nativeEvent ||
      typeof nativeEvent !== "object" ||
      pair.nativeEvent !== nativeEvent ||
      !coordinator.prepareRowBubble(event, nativeEvent)
    ) {
      return;
    }
    rowKeyPairs.delete(nativeEvent);
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    if (
      !runtime ||
      !publication ||
      pair.publication !== publication ||
      pair.row.authority !== row ||
      rows[row.index] !== row
    ) {
      return;
    }
    const events = publication.events;
    const listener = publication.keyListener;
    if (!events || !listener) return;
    const native = events.readKeyboard(nativeEvent);
    const proof = native
      ? listener.proofFor(
          nativeEvent as KeyboardEvent,
          publication,
        )
      : null;
    const bubble =
      native && proof
        ? captureNotificationReactKeyboard(
            event,
            publication,
            native,
            nativeEvent as KeyboardEvent,
            pair.source,
            proof,
          )
        : null;
    if (
      !native ||
      !proof ||
      !bubble ||
      bubble.event === pair.capture.event ||
      event.currentTarget !== pair.source ||
      pair.sourceAction !==
        (pair.source === pair.row.open
          ? pair.row.openAction
          : pair.row.dismissAction) ||
      pair.destinationAction !==
        (pair.destination === pair.row.open
          ? pair.row.openAction
          : pair.row.dismissAction) ||
      native.phase !== events.bubblingPhase ||
      pair.native.phase !== events.capturingPhase ||
      native.currentTarget !== pair.native.currentTarget ||
      proof !== pair.windowProof ||
      proof.receiver !== native.path.at(-1) ||
      !notificationKeyboardStableFactsMatch(pair.native, native) ||
      !notificationReactKeyboardRemainsExact(
        pair.capture,
        publication,
        pair.native,
        null,
      ) ||
      !notificationReactKeyboardRemainsExact(
        bubble,
        publication,
        native,
        pair.source,
      ) ||
      !rowMovementIsCurrent(
        runtime,
        publication,
        pair.row,
        pair.sourceAction,
        pair.destinationAction,
        pair.source,
        pair.destination,
        pair.key,
      )
    ) {
      return;
    }
    const delivery = Object.freeze<NotificationRowKeyDelivery>({
      pair,
      bubble,
    });
    if (!coordinator.claimRowMovement(delivery)) return;
    try {
      if (
        !coordinator.rowMovementIsDelivering(delivery) ||
        !listener.retains(pair.windowProof, publication) ||
        !notificationReactKeyboardRemainsExact(
          pair.capture,
          publication,
          pair.native,
          null,
        ) ||
        !notificationReactKeyboardRemainsExact(
          bubble,
          publication,
          native,
          pair.source,
        ) ||
        !rowMovementIsCurrent(
          runtime,
          publication,
          pair.row,
          pair.sourceAction,
          pair.destinationAction,
          pair.source,
          pair.destination,
          pair.key,
        )
      ) {
        return;
      }
      events.apply(
        bubble.methods.preventDefault,
        bubble.event,
        [],
      );
      const preventedNative = events.readKeyboard(pair.nativeEvent);
      if (
        !preventedNative ||
        !notificationKeyboardStableFactsMatch(
          native,
          preventedNative,
          true,
        ) ||
        preventedNative.currentTarget !== native.currentTarget ||
        preventedNative.phase !== native.phase ||
        !listener.retains(pair.windowProof, publication) ||
        !coordinator.rowMovementIsDelivering(delivery) ||
        !notificationReactKeyboardRemainsExact(
          pair.capture,
          publication,
          pair.native,
          null,
        ) ||
        !notificationReactKeyboardRemainsExact(
          bubble,
          publication,
          preventedNative,
          pair.source,
          true,
        ) ||
        !rowMovementIsCurrent(
          runtime,
          publication,
          pair.row,
          pair.sourceAction,
          pair.destinationAction,
          pair.source,
          pair.destination,
          pair.key,
        )
      ) {
        return;
      }
      publication.focusCustody.focus(
        pair.destination,
        NOTIFICATION_ROW_PREVENT_SCROLL,
      );
    } finally {
      coordinator.finishRowMovement(delivery);
    }
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
        replay.dismissControls.length === rowOwners.length &&
        rowOwners.every(
          (owned, index) =>
            owned.openOwner.element() === replay.openControls[index] &&
            owned.dismissOwner.element() === replay.dismissControls[index],
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
  const onKeyDown = (
    row: NotificationRowAuthority,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    completeListNavigation(row, event);
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
    const action =
      facts?.actionKind === "delete"
        ? publishedRow.deleteAction
        : publishedRow.browseAction;
    if (
      !facts ||
      facts.publicationIdentity !== publication.identity ||
      runtime.isRetired() ||
      publication.authority !== authority ||
      publishedRow.authority !== row ||
      !coordinator.isCurrent(publication) ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !runtime.historyIsClean() ||
      !runtime.publishedDomMatches() ||
      !coordinator.claimKeyboard(
        publication,
        action,
        event,
        facts.nativeEvent,
      )
    ) {
      return;
    }
    const events = publication.events;
    if (
      !events ||
      !events.preventDefault(facts.nativeEvent) ||
      !events.defaultWasPrevented(facts.nativeEvent) ||
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
    if (facts.actionKind === "delete") {
      void publication.authority.markRead(row.notification.id);
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
    onKeyDown,
    onRowKeyDownCapture: captureRowNavigation,
    onListKeyDownCapture: captureListNavigation,
    onDismissKeyDown: completeRowNavigation,
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
    onKeyDown,
    onRowKeyDownCapture,
    onListKeyDownCapture,
    onDismissKeyDown,
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
      <ul
        ref={captureList}
        className="flex flex-col gap-1.5"
        onKeyDownCapture={onListKeyDownCapture}
      >
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
              onKeyDownCapture={(event) =>
                onRowKeyDownCapture(row, event)}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-3">
                <KindIcon kind={notification.kind} />
              </span>
              <button
                ref={published.captureOpen}
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={(event) => onOpen(row, event)}
                onKeyDown={(event) => {
                  onKeyDown(row, event);
                  onDismissKeyDown(row, event);
                }}
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
                onKeyDown={(event) =>
                  onDismissKeyDown(row, event)}
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
