"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHydrated } from "@/lib/hooks";
import {
  isThemePreference,
  nextTheme,
  setThemePreference,
  systemPrefersDark,
  themeLabel,
  themeStore,
  type ThemePreference,
} from "@/lib/theme";

interface ThemeAuthority {
  preference: ThemePreference;
}

export function useTheme(): [ThemePreference, (next: ThemePreference) => void] {
  const preference = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot, themeStore.getServerSnapshot);
  const authority = useMemo<ThemeAuthority>(() => ({ preference }), [preference]);
  const authorityRef = useRef<ThemeAuthority | null>(null);

  useLayoutEffect(() => {
    authorityRef.current = authority;
    return () => {
      if (authorityRef.current === authority) authorityRef.current = null;
    };
  }, [authority]);

  const setPreference = useCallback((next: ThemePreference) => {
    if (
      authorityRef.current !== authority
      || !isThemePreference(next)
      || next === authority.preference
      || themeStore.getSnapshot() !== authority.preference
    )
      return;
    setThemePreference(next);
  }, [authority]);

  return [preference, setPreference];
}

function useThemeControl(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreference] = useTheme();
  const setterRef = useRef<typeof setPreference | null>(null);
  useLayoutEffect(() => {
    setterRef.current = setPreference;
    return () => {
      if (setterRef.current === setPreference) setterRef.current = null;
    };
  }, [setPreference]);
  const [setCommittedPreference] = useState<(next: ThemePreference) => void>(
    () => (next: ThemePreference) => setterRef.current?.(next),
  );
  return [preference, setCommittedPreference];
}

const ICONS = { system: Monitor, light: Sun, dark: Moon } as const;
const ICON_NAMES = { system: "monitor", light: "sun", dark: "moon" } as const;
const THEME_OPTIONS = ["system", "light", "dark"] as const;
const PICKER_CLASS_NAME = "inline-flex rounded-lg border border-line-2 bg-surface p-0.5";
const PICKER_ROW_BASE_CLASS_NAME =
  "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm transition-colors";
const PICKER_ROW_ACTIVE_CLASS_NAME = "bg-accent-soft text-accent font-medium";
const PICKER_ROW_INACTIVE_CLASS_NAME = "text-ink-2 hover:bg-surface-3 hover:text-ink";

interface PublicationAuthority {
  readonly mount: symbol;
}

interface DomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly DomSnapshot[];
}

interface Placement {
  readonly document: Document;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface ElementOwnerView {
  readonly element: () => Element | null;
}

interface RefReplay {
  readonly owner: ElementOwnerView;
  readonly element: Element;
  detached: boolean;
  reattached: boolean;
}

interface Publication<A extends PublicationAuthority> {
  readonly identity: symbol;
  readonly authority: A;
  readonly root: HTMLElement;
  readonly ownerDocument: Document;
  readonly ownerRealm: Window & typeof globalThis;
  readonly dom: DomSnapshot;
  readonly placement: Placement;
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
}

interface PublicationReplay<A extends PublicationAuthority> {
  readonly source: Publication<A>;
  readonly dom: DomSnapshot;
  readonly placement: Placement;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface PublicationRuntime<A extends PublicationAuthority> {
  readonly publication: Publication<A>;
  readonly publish: () => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: ElementOwnerView,
    element: Element | null,
    previous: Element | null,
  ) => void;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly replay: () => PublicationReplay<A> | null;
}

class ElementOwner<T extends Element> implements ElementOwnerView {
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: ElementOwnerView,
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

class PublicationCoordinator<A extends PublicationAuthority> {
  readonly #mount: symbol;
  #active: Publication<A> | null = null;
  #successorOf: Publication<A> | null = null;
  #replay: PublicationReplay<A> | null = null;
  #retired = new WeakSet<Publication<A>>();
  #claimedPublications = new WeakSet<Publication<A>>();
  #claimedActions = new WeakSet<object>();
  #claimedEvents = new WeakSet<object>();
  #claimedDeliveryParts = new WeakSet<object>();
  #activeDelivery: {
    readonly publication: Publication<A>;
    readonly action: object;
    readonly events: readonly object[];
    readonly parts: readonly object[];
    readonly delivery: object;
  } | null = null;

  constructor(mount: symbol) {
    this.#mount = mount;
  }

  active() {
    return this.#active;
  }

  replay() {
    return this.#replay;
  }

  acceptsSuccessorOf(publication: Publication<A>) {
    return (
      this.#active === null
      && this.#successorOf === publication
      && this.#retired.has(publication)
      && !this.#claimedPublications.has(publication)
    );
  }

  stageReplay(replay: PublicationReplay<A>) {
    if (!this.acceptsSuccessorOf(replay.source)) return false;
    this.#replay = replay;
    return true;
  }

  abandonReplay(publication: Publication<A>) {
    if (this.#replay?.source === publication) this.#replay = null;
    if (this.#successorOf === publication) this.#successorOf = null;
  }

  publish(publication: Publication<A>) {
    if (
      publication.authority.mount !== this.#mount
      || this.#retired.has(publication)
    ) {
      return false;
    }
    const previous = this.#active;
    if (previous && previous !== publication) previous.retire();
    this.#active = publication;
    this.#successorOf = null;
    this.#replay = null;
    return true;
  }

  retire(publication: Publication<A>) {
    if (this.#retired.has(publication)) return false;
    this.#retired.add(publication);
    if (this.#active === publication) {
      this.#active = null;
      this.#successorOf = publication;
    }
    return true;
  }

  isCurrent(publication: Publication<A>) {
    return this.#active === publication && !this.#retired.has(publication);
  }

  hasClaimed(
    publication: Publication<A>,
    action: object,
    event: object,
    nativeEvent: Event,
  ) {
    const active = this.#activeDelivery;
    return (
      this.#claimedPublications.has(publication)
      || this.#claimedActions.has(action)
      || this.#claimedEvents.has(event)
      || this.#claimedEvents.has(nativeEvent)
      || active?.publication === publication
      || active?.action === action
      || active?.events.includes(event)
      || active?.events.includes(nativeEvent)
    );
  }

  claim(
    publication: Publication<A>,
    action: object,
    event: object,
    nativeEvent: Event,
  ) {
    if (
      !this.isCurrent(publication)
      || this.#activeDelivery
      || this.hasClaimed(publication, action, event, nativeEvent)
    ) {
      return false;
    }
    this.#claimedPublications.add(publication);
    this.#claimedActions.add(action);
    this.#claimedEvents.add(event);
    this.#claimedEvents.add(nativeEvent);
    return true;
  }

  claimDelivery(
    publication: Publication<A>,
    action: object,
    events: readonly object[],
    parts: readonly object[],
    delivery: object,
  ) {
    const deliveryParts = [...parts, delivery];
    if (
      !this.isCurrent(publication)
      || this.#activeDelivery
      || this.#claimedPublications.has(publication)
      || this.#claimedActions.has(action)
      || events.some((event) => this.#claimedEvents.has(event))
      || deliveryParts.some((part) => this.#claimedDeliveryParts.has(part))
      || new Set([...events, ...deliveryParts]).size !== events.length + deliveryParts.length
    ) {
      return false;
    }
    this.#activeDelivery = Object.freeze({
      publication,
      action,
      events: Object.freeze([...events]),
      parts: Object.freeze(deliveryParts),
      delivery,
    });
    return true;
  }

  deliveryIsActive(delivery: object) {
    return this.#activeDelivery?.delivery === delivery;
  }

  commitDelivery(delivery: object) {
    const active = this.#activeDelivery;
    if (
      !active
      || active.delivery !== delivery
      || !this.isCurrent(active.publication)
      || this.#claimedPublications.has(active.publication)
      || this.#claimedActions.has(active.action)
      || active.events.some((event) => this.#claimedEvents.has(event))
      || active.parts.some((part) => this.#claimedDeliveryParts.has(part))
    ) {
      return false;
    }
    this.#claimedPublications.add(active.publication);
    this.#claimedActions.add(active.action);
    for (const event of active.events) this.#claimedEvents.add(event);
    for (const part of active.parts) this.#claimedDeliveryParts.add(part);
    this.#activeDelivery = null;
    return true;
  }

  finishDelivery(delivery: object) {
    if (this.#activeDelivery?.delivery === delivery) this.#activeDelivery = null;
  }
}

class PresentationCache<A, P> {
  #current: {
    readonly authority: A;
    readonly presentation: P;
    readonly revision: number;
  } | null = null;

  resolve(
    authority: A,
    revision: number,
    authoritiesMatch: (previous: A, current: A) => boolean,
    create: () => P,
  ) {
    if (
      !this.#current
      || this.#current.revision !== revision
      || !authoritiesMatch(this.#current.authority, authority)
    ) {
      this.#current = Object.freeze({
        authority,
        presentation: create(),
        revision,
      });
    }
    return this.#current.presentation;
  }
}

interface DomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

function snapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotDom(node: Node): DomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotDom)),
  });
}

function domMatches(snapshot: DomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = snapshotAttributes(node);
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
  return (
    node.childNodes.length === snapshot.children.length
    && snapshot.children.every((child, index) =>
      node.childNodes.item(index) === child.node && domMatches(child))
  );
}

function snapshotContains(snapshot: DomSnapshot, node: Node): boolean {
  return snapshot.node === node || snapshot.children.some((child) => snapshotContains(child, node));
}

function capturePlacement(root: HTMLElement): Placement | null {
  const parent = root.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: root.ownerDocument,
    parent,
    previousSibling: root.previousSibling,
    nextSibling: root.nextSibling,
  });
}

function placementMatches(root: HTMLElement, placement: Placement): boolean {
  return (
    root.ownerDocument === placement.document
    && root.parentNode === placement.parent
    && root.previousSibling === placement.previousSibling
    && root.nextSibling === placement.nextSibling
  );
}

function createDomGuard(root: HTMLElement, placement: Placement): DomGuard | null {
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
        node === root || (node.nodeType === 1 && (node as Element).contains(root)));
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

function createPublicationRuntime<A extends PublicationAuthority>(
  authority: A,
  coordinator: PublicationCoordinator<A>,
  root: HTMLElement,
  owners: readonly ElementOwnerView[],
): PublicationRuntime<A> {
  type Retirement = "element" | "layout" | "other";
  const placement = capturePlacement(root);
  if (!placement) throw new Error("Cannot publish a theme control without a committed parent");
  const ownerRealm = placement.document.defaultView;
  if (!ownerRealm) throw new Error("Cannot publish a theme control without an owner realm");
  const dom = snapshotDom(root);
  let retired = false;
  let retirement: Retirement | null = null;
  let established = false;
  let layoutRetired = false;
  let invalidReplay = false;
  let replayRefs: RefReplay[] = [];
  let domGuard: DomGuard | null = null;
  const publishedDomMatches = () =>
    Boolean(
      domGuard
      && domGuard.isClean()
      && root === dom.node
      && root.isConnected
      && placementMatches(root, placement)
      && domMatches(dom)
    );
  const retire = (reason: Retirement) => {
    if (retired) return false;
    retired = true;
    retirement = reason;
    coordinator.retire(publication);
    queueMicrotask(() => {
      if (coordinator.replay()?.source !== publication) domGuard?.release();
    });
    return true;
  };
  const publication: Publication<A> = Object.freeze({
    identity: Symbol("theme-control-publication"),
    authority,
    root,
    ownerDocument: root.ownerDocument,
    ownerRealm,
    dom,
    placement,
    retire: () => retire("other"),
    isRetired: () => retired,
    publishedDomMatches,
  });
  const refsHaveNoReplay = () =>
    !invalidReplay
    && replayRefs.every((entry) =>
      !entry.detached
      && !entry.reattached
      && entry.owner.element() === entry.element);
  const refsHaveExactReplay = () =>
    !invalidReplay
    && replayRefs.length > 0
    && replayRefs.every((entry) =>
      entry.detached
      && entry.reattached
      && entry.owner.element() === entry.element);

  const runtime: PublicationRuntime<A> = Object.freeze({
    publication,
    publish: () => {
      established = true;
      replayRefs = owners.map((owner) => {
        const element = owner.element();
        if (!element) throw new Error("Cannot publish a theme control without every committed ref");
        return { owner, element, detached: false, reattached: false };
      });
      domGuard = createDomGuard(root, placement);
      if (!domGuard || !coordinator.publish(publication)) {
        domGuard?.release();
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
      } else if (
        element === proof.element
        && previous === null
        && proof.detached
      ) {
        proof.reattached = true;
      } else if (element !== previous) {
        invalidReplay = true;
      }
      if (
        !retired
        && replayRefs.every((entry) => entry.owner.element() === entry.element)
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
    isExactElementReplay: () =>
      retired
      && retirement === "element"
      && layoutRetired
      && established
      && refsHaveExactReplay()
      && publishedDomMatches(),
    isExactLayoutReplay: () =>
      retired
      && retirement === "layout"
      && established
      && (refsHaveNoReplay() || refsHaveExactReplay())
      && publishedDomMatches(),
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
  });
  return runtime;
}

function replayAllowsPublication<A extends PublicationAuthority>(
  coordinator: PublicationCoordinator<A>,
  authority: A,
  root: HTMLElement,
  authoritiesMatch: (previous: A, current: A) => boolean,
): boolean {
  const replay = coordinator.replay();
  if (!replay) return true;
  const sameAuthority = authoritiesMatch(replay.source.authority, authority);
  const exactReplay = (
    sameAuthority
    && coordinator.acceptsSuccessorOf(replay.source)
    && replay.historyIsClean()
    && root === replay.dom.node
    && placementMatches(root, replay.placement)
    && domMatches(replay.dom)
  );
  coordinator.abandonReplay(replay.source);
  replay.release();
  return !sameAuthority || exactReplay;
}

function iconMatches(
  icon: SVGSVGElement,
  parent: HTMLButtonElement,
  preference: ThemePreference,
  size: number,
): boolean {
  return (
    icon.isConnected
    && icon.ownerDocument === parent.ownerDocument
    && icon.parentElement === parent
    && parent.children.length === 1
    && parent.firstElementChild === icon
    && icon.tagName.toLowerCase() === "svg"
    && icon.classList.contains(`lucide-${ICON_NAMES[preference]}`)
    && icon.getAttribute("width") === String(size)
    && icon.getAttribute("height") === String(size)
    && icon.getAttribute("aria-hidden") === "true"
  );
}

function exactNativeClick<A extends PublicationAuthority>(
  event: ReactMouseEvent<HTMLButtonElement>,
  publication: Publication<A>,
  control: HTMLButtonElement,
): MouseEvent | null {
  if (!event || typeof event !== "object") return null;
  const ownerDocument = publication.ownerDocument;
  const view = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  const target = event.target;
  const reactEvent = event as ReactMouseEvent<HTMLButtonElement> & {
    _reactName?: unknown;
    isDefaultPrevented?: unknown;
    isPropagationStopped?: unknown;
    persist?: unknown;
  };
  const eventPrototype = Object.getPrototypeOf(event) as {
    constructor?: { name?: unknown };
  } | null;
  return (
    view
    && nativeEvent instanceof view.MouseEvent
    && nativeEvent.type === "click"
    && nativeEvent.button === 0
    && nativeEvent.eventPhase !== view.Event.NONE
    && nativeEvent.bubbles
    && !nativeEvent.defaultPrevented
    && event.type === "click"
    && event.button === 0
    && event.bubbles
    && !event.defaultPrevented
    && event.currentTarget === control
    && nativeEvent.target === target
    && target instanceof view.Node
    && target.ownerDocument === ownerDocument
    && control.contains(target)
    && nativeEvent.composedPath().includes(control)
    && nativeEvent.composedPath().includes(publication.root)
    && snapshotContains(publication.dom, target)
    && eventPrototype?.constructor?.name === "SyntheticBaseEvent"
    && reactEvent._reactName === "onClick"
    && typeof reactEvent.isDefaultPrevented === "function"
    && !reactEvent.isDefaultPrevented()
    && typeof reactEvent.isPropagationStopped === "function"
    && !reactEvent.isPropagationStopped()
    && typeof reactEvent.persist === "function"
  )
    ? nativeEvent
    : null;
}

interface ToggleAuthority extends PublicationAuthority {
  readonly revision: number;
  readonly preference: ThemePreference;
  readonly nextPreference: ThemePreference;
  readonly setPreference: (next: ThemePreference) => void;
  readonly hydrated: boolean;
  readonly label: string;
  readonly title: string;
  readonly classNameInput: string | undefined;
  readonly className: string;
  readonly size: number;
}

interface TogglePresentation {
  readonly captureButton: (element: HTMLButtonElement | null) => void;
  readonly establish: () => void | (() => void);
  readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

function toggleAuthoritiesMatch(
  previous: ToggleAuthority,
  current: ToggleAuthority,
  includeRevision = true,
) {
  return (
    previous.mount === current.mount
    && (!includeRevision || previous.revision === current.revision)
    && previous.preference === current.preference
    && previous.nextPreference === current.nextPreference
    && previous.setPreference === current.setPreference
    && previous.hydrated === current.hydrated
    && previous.label === current.label
    && previous.title === current.title
    && previous.classNameInput === current.classNameInput
    && previous.className === current.className
    && previous.size === current.size
  );
}

function createTogglePresentation(
  authority: ToggleAuthority,
  coordinator: PublicationCoordinator<ToggleAuthority>,
  requestSuccessor: () => void,
): TogglePresentation {
  let currentRuntime: PublicationRuntime<ToggleAuthority> | null = null;
  let lastRuntime: PublicationRuntime<ToggleAuthority> | null = null;
  let successorRequested = false;
  const {
    mount,
    revision,
    preference,
    nextPreference,
    setPreference,
    hydrated,
    label,
    title,
    classNameInput,
    className,
    size,
  } = authority;
  const onElementChange = (
    owner: ElementOwnerView,
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
    if (
      runtime?.isExactElementReplay()
      && coordinator.acceptsSuccessorOf(runtime.publication)
    ) {
      requestReplaySuccessor(runtime);
    }
  };
  const buttonOwner = new ElementOwner<HTMLButtonElement>(onElementChange);
  const expectedOwners = () => Object.freeze([buttonOwner]);
  const factsAreCurrent = () =>
    authority.mount === mount
    && authority.revision === revision
    && authority.preference === preference
    && authority.nextPreference === nextPreference
    && authority.setPreference === setPreference
    && authority.hydrated === hydrated
    && authority.label === label
    && authority.title === title
    && authority.classNameInput === classNameInput
    && authority.className === className
    && authority.size === size
    && nextPreference === nextTheme(preference)
    && label === `Theme: ${themeLabel(preference)}`
    && title === `${label} (click to switch)`
    && className === cn("icon-btn", classNameInput);
  const exactDomIsCurrent = () => {
    const button = buttonOwner.element();
    const view = button?.ownerDocument.defaultView;
    const icon = button?.firstElementChild;
    return (
      hydrated
      && !!button
      && !!view
      && icon instanceof view.SVGSVGElement
      && button.isConnected
      && button.tagName === "BUTTON"
      && button.getAttribute("type") === "button"
      && button.type === "button"
      && !button.disabled
      && !button.matches(":disabled")
      && button.getAttribute("aria-busy") === null
      && button.getAttribute("aria-label") === label
      && button.getAttribute("title") === title
      && button.getAttribute("class") === className
      && button.dataset.testid === "theme-toggle"
      && button.dataset.themePreference === preference
      && button.childNodes.length === 1
      && iconMatches(icon, button, preference, size)
    );
  };
  const requestReplaySuccessor = (runtime: PublicationRuntime<ToggleAuthority>) => {
    const replay = runtime.replay();
    if (
      successorRequested
      || !replay
      || !coordinator.acceptsSuccessorOf(runtime.publication)
      || !factsAreCurrent()
      || !exactDomIsCurrent()
      || !runtime.publishedDomMatches()
      || !coordinator.stageReplay(replay)
    ) {
      return;
    }
    successorRequested = true;
    requestSuccessor();
  };
  const establish = () => {
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() || lastRuntime.isExactElementReplay())
        && coordinator.acceptsSuccessorOf(lastRuntime.publication)
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (!factsAreCurrent() || !exactDomIsCurrent()) return undefined;
    const button = buttonOwner.element();
    if (
      !button
      || !replayAllowsPublication(
        coordinator,
        authority,
        button,
        (previous, current) => toggleAuthoritiesMatch(previous, current, false),
      )
    ) {
      return undefined;
    }
    const runtime = createPublicationRuntime(authority, coordinator, button, expectedOwners());
    currentRuntime = runtime;
    lastRuntime = runtime;
    if (!runtime.publish()) {
      runtime.retireForElement();
      currentRuntime = null;
      return undefined;
    }
    return runtime.retireForLayout;
  };
  const action = Object.freeze({ identity: Symbol("theme-toggle-action") });
  const onClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const publication = coordinator.active();
    const button = buttonOwner.element();
    if (
      !publication
      || publication.isRetired()
      || !toggleAuthoritiesMatch(publication.authority, authority)
      || !button
      || button !== publication.root
      || !coordinator.isCurrent(publication)
      || !factsAreCurrent()
      || !exactDomIsCurrent()
      || !publication.publishedDomMatches()
      || themeStore.getSnapshot() !== preference
    ) {
      return;
    }
    const nativeEvent = exactNativeClick(event, publication, button);
    if (
      !nativeEvent
      || coordinator.hasClaimed(publication, action, event, nativeEvent)
      || !coordinator.claim(publication, action, event, nativeEvent)
    ) {
      return;
    }
    setPreference(nextPreference);
  };

  return Object.freeze({
    captureButton: buttonOwner.capture,
    establish,
    onClick,
  });
}

interface PickerRowAuthority {
  readonly index: number;
  readonly preference: ThemePreference;
  readonly label: string;
  readonly checked: boolean;
  readonly tabIndex: 0 | -1;
  readonly className: string;
  readonly size: number;
}

interface PickerAuthority extends PublicationAuthority {
  readonly revision: number;
  readonly preference: ThemePreference;
  readonly setPreference: (next: ThemePreference) => void;
  readonly rootClassName: string;
  readonly rows: readonly PickerRowAuthority[];
}

interface PickerRowPresentation {
  readonly authority: PickerRowAuthority;
  readonly captureButton: (element: HTMLButtonElement | null) => void;
  readonly captureIcon: (element: SVGSVGElement | null) => void;
  readonly buttonOwner: ElementOwner<HTMLButtonElement>;
  readonly iconOwner: ElementOwner<SVGSVGElement>;
  readonly action: object;
  readonly keyboardAction: object;
  readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}

interface PickerPresentation {
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly rows: readonly PickerRowPresentation[];
  readonly establish: () => void | (() => void);
  readonly onKeyDownCapture: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

function pickerAuthoritiesMatch(
  previous: PickerAuthority,
  current: PickerAuthority,
  includeRevision = true,
) {
  return (
    previous.mount === current.mount
    && (!includeRevision || previous.revision === current.revision)
    && previous.preference === current.preference
    && previous.setPreference === current.setPreference
    && previous.rootClassName === current.rootClassName
    && previous.rows.length === current.rows.length
    && previous.rows.every((row, index) => {
      const candidate = current.rows[index];
      return Boolean(
        candidate
        && row.index === candidate.index
        && row.preference === candidate.preference
        && row.label === candidate.label
        && row.checked === candidate.checked
        && row.tabIndex === candidate.tabIndex
        && row.className === candidate.className
        && row.size === candidate.size
      );
    })
  );
}

interface IntrinsicGetter<T> {
  readonly read: (target: object) => T;
  readonly isCurrent: () => boolean;
}

interface IntrinsicMethod<A extends readonly unknown[], R> {
  readonly invoke: (target: object, ...args: A) => R;
  readonly isCurrent: () => boolean;
}

interface WindowMethod {
  readonly value: (...args: unknown[]) => unknown;
  readonly isCurrent: () => boolean;
}

interface UnforgeableGetter<T> {
  readonly read: (target: object) => T;
  readonly matches: (target: object) => boolean;
  readonly isCurrent: () => boolean;
}

function descriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: Readonly<PropertyDescriptor>,
) {
  if (!current) return false;
  if (
    current.configurable !== expected.configurable
    || current.enumerable !== expected.enumerable
  ) {
    return false;
  }
  if ("value" in expected) {
    return (
      "value" in current
      && current.value === expected.value
      && current.writable === expected.writable
    );
  }
  return (
    !("value" in current)
    && current.get === expected.get
    && current.set === expected.set
  );
}

function captureIntrinsicGetter<T>(
  prototype: object,
  property: string,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  getPrototypeOf: typeof Object.getPrototypeOf,
  apply: typeof Reflect.apply,
): IntrinsicGetter<T> | null {
  let current: object | null = prototype;
  while (current) {
    const descriptor = getOwnPropertyDescriptor(current, property);
    if (descriptor) {
      if (typeof descriptor.get !== "function") return null;
      const getter = descriptor.get;
      const expected = Object.freeze({ ...descriptor });
      return Object.freeze({
        read: (target: object) => apply(getter, target, []) as T,
        isCurrent: () =>
          descriptorsMatch(getOwnPropertyDescriptor(current!, property), expected),
      });
    }
    current = getPrototypeOf(current) as object | null;
  }
  return null;
}

function captureIntrinsicMethod<A extends readonly unknown[], R>(
  prototype: object,
  property: string,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  getPrototypeOf: typeof Object.getPrototypeOf,
  apply: typeof Reflect.apply,
): IntrinsicMethod<A, R> | null {
  let current: object | null = prototype;
  while (current) {
    const descriptor = getOwnPropertyDescriptor(current, property);
    if (descriptor) {
      if (typeof descriptor.value !== "function") return null;
      const method = descriptor.value as (...args: A) => R;
      const expected = Object.freeze({ ...descriptor });
      return Object.freeze({
        invoke: (target: object, ...args: A) => apply(method, target, args) as R,
        isCurrent: () =>
          descriptorsMatch(getOwnPropertyDescriptor(current!, property), expected),
      });
    }
    current = getPrototypeOf(current) as object | null;
  }
  return null;
}

function captureWindowMethod(
  ownerWindow: Window & typeof globalThis,
  property: "addEventListener" | "removeEventListener",
): WindowMethod | null {
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
  const value = reflectGet(ownerWindow, property, ownerWindow);
  if (!found || typeof value !== "function") return null;
  const isCurrent = () =>
    ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor
    && ownerWindow.Object.getPrototypeOf === getPrototypeOf
    && ownerWindow.Reflect.get === reflectGet
    && path.every(({ target: entry, descriptor, prototype }) => {
      const current = getOwnPropertyDescriptor(entry, property);
      return (
        getPrototypeOf(entry) === prototype
        && (descriptor ? descriptorsMatch(current, descriptor) : current === undefined)
      );
    })
    && reflectGet(ownerWindow, property, ownerWindow) === value;
  return isCurrent()
    ? Object.freeze({
        value: value as (...args: unknown[]) => unknown,
        isCurrent,
      })
    : null;
}

function captureUnforgeableGetter<T>(
  owner: object,
  property: string,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  apply: typeof Reflect.apply,
): UnforgeableGetter<T> | null {
  const descriptor = getOwnPropertyDescriptor(owner, property);
  if (!descriptor?.get || "value" in descriptor) return null;
  const expected = Object.freeze({ ...descriptor });
  const getter = descriptor.get;
  const matches = (target: object) =>
    descriptorsMatch(getOwnPropertyDescriptor(target, property), expected);
  return Object.freeze({
    read: (target: object) => apply(getter, target, []) as T,
    matches,
    isCurrent: () => matches(owner),
  });
}

interface PickerNativeKeyboardFacts {
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
  readonly composed: boolean;
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

interface PickerKeyboardAuthority {
  readonly view: Window & typeof globalThis;
  readonly keyboardPrototype: object;
  readonly capturingPhase: number;
  readonly bubblingPhase: number;
  readonly apply: typeof Reflect.apply;
  readonly readKeyboard: (event: object) => PickerNativeKeyboardFacts | null;
  readonly methodMatches: (event: object, property: string, value: unknown) => boolean;
  readonly activeElement: () => Element | null | undefined;
  readonly focus: IntrinsicMethod<readonly [FocusOptions?], void>;
  readonly addEventListener: WindowMethod;
  readonly removeEventListener: WindowMethod;
}

function capturePickerKeyboardAuthority(
  publication: Publication<PickerAuthority>,
): PickerKeyboardAuthority | null {
  const { ownerDocument, ownerRealm: view } = publication;
  const objectConstructor = view.Object;
  const reflectObject = view.Reflect;
  const eventConstructor = view.Event;
  const uiEventConstructor = view.UIEvent;
  const keyboardConstructor = view.KeyboardEvent;
  const documentConstructor = view.Document;
  const htmlElementConstructor = view.HTMLElement;
  const eventPrototype = eventConstructor.prototype;
  const uiEventPrototype = uiEventConstructor.prototype;
  const keyboardPrototype = keyboardConstructor.prototype;
  const documentPrototype = documentConstructor.prototype;
  const htmlElementPrototype = htmlElementConstructor.prototype;
  const getOwnPropertyDescriptor = view.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = view.Object.getPrototypeOf;
  const apply = view.Reflect.apply;
  const getter = <T,>(prototype: object, property: string) =>
    captureIntrinsicGetter<T>(
      prototype,
      property,
      getOwnPropertyDescriptor,
      getPrototypeOf,
      apply,
    );
  const method = <A extends readonly unknown[], R>(
    prototype: object,
    property: string,
  ) =>
    captureIntrinsicMethod<A, R>(
      prototype,
      property,
      getOwnPropertyDescriptor,
      getPrototypeOf,
      apply,
    );
  const eventType = getter<string>(eventPrototype, "type");
  const eventTarget = getter<EventTarget | null>(eventPrototype, "target");
  const eventCurrentTarget = getter<EventTarget | null>(eventPrototype, "currentTarget");
  const eventPhase = getter<number>(eventPrototype, "eventPhase");
  const eventBubbles = getter<boolean>(eventPrototype, "bubbles");
  const eventCancelable = getter<boolean>(eventPrototype, "cancelable");
  const eventDefaultPrevented = getter<boolean>(eventPrototype, "defaultPrevented");
  const eventCancelBubble = getter<boolean>(eventPrototype, "cancelBubble");
  const eventComposed = getter<boolean>(eventPrototype, "composed");
  const eventPath = method<readonly [], EventTarget[]>(eventPrototype, "composedPath");
  const eventView = getter<EventTarget | null>(uiEventPrototype, "view");
  const eventDetail = getter<number>(uiEventPrototype, "detail");
  const key = getter<string>(keyboardPrototype, "key");
  const code = getter<string>(keyboardPrototype, "code");
  const location = getter<number>(keyboardPrototype, "location");
  const repeat = getter<boolean>(keyboardPrototype, "repeat");
  const composing = getter<boolean>(keyboardPrototype, "isComposing");
  const altKey = getter<boolean>(keyboardPrototype, "altKey");
  const ctrlKey = getter<boolean>(keyboardPrototype, "ctrlKey");
  const metaKey = getter<boolean>(keyboardPrototype, "metaKey");
  const shiftKey = getter<boolean>(keyboardPrototype, "shiftKey");
  const activeElement = captureIntrinsicGetter<Element | null>(
    documentPrototype,
    "activeElement",
    getOwnPropertyDescriptor,
    getPrototypeOf,
    apply,
  );
  const focus = captureIntrinsicMethod<readonly [FocusOptions?], void>(
    htmlElementPrototype,
    "focus",
    getOwnPropertyDescriptor,
    getPrototypeOf,
    apply,
  );
  const addEventListener = captureWindowMethod(view, "addEventListener");
  const removeEventListener = captureWindowMethod(view, "removeEventListener");
  let probe: KeyboardEvent;
  try {
    probe = new keyboardConstructor("theme-picker-keyboard-proof");
  } catch {
    return null;
  }
  const trusted = captureUnforgeableGetter<boolean>(
    probe,
    "isTrusted",
    getOwnPropertyDescriptor,
    apply,
  );
  const getters = Object.freeze([
    eventType,
    eventTarget,
    eventCurrentTarget,
    eventPhase,
    eventBubbles,
    eventCancelable,
    eventDefaultPrevented,
    eventCancelBubble,
    eventComposed,
    eventView,
    eventDetail,
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
  ]);
  const methods = Object.freeze([eventPath, focus]);
  if (
    getters.some((intrinsic) => !intrinsic || !intrinsic.isCurrent())
    || methods.some((intrinsic) => !intrinsic || !intrinsic.isCurrent())
    || !eventType
    || !eventTarget
    || !eventCurrentTarget
    || !eventPhase
    || !eventBubbles
    || !eventCancelable
    || !eventDefaultPrevented
    || !eventCancelBubble
    || !eventComposed
    || !eventPath
    || !eventView
    || !eventDetail
    || !key
    || !code
    || !location
    || !repeat
    || !composing
    || !altKey
    || !ctrlKey
    || !metaKey
    || !shiftKey
    || !activeElement
    || !focus
    || !trusted
    || !trusted.isCurrent()
    || !addEventListener
    || !addEventListener.isCurrent()
    || !removeEventListener
    || !removeEventListener.isCurrent()
    || ownerDocument.defaultView !== view
  ) {
    return null;
  }
  let historyIsClean = true;
  const intrinsicsAreCurrent = () => {
    if (!historyIsClean) return false;
    historyIsClean = (
      ownerDocument.defaultView === view
      && objectConstructor === view.Object
      && reflectObject === view.Reflect
      && eventConstructor === view.Event
      && uiEventConstructor === view.UIEvent
      && keyboardConstructor === view.KeyboardEvent
      && documentConstructor === view.Document
      && htmlElementConstructor === view.HTMLElement
      && eventPrototype === eventConstructor.prototype
      && uiEventPrototype === uiEventConstructor.prototype
      && keyboardPrototype === keyboardConstructor.prototype
      && documentPrototype === documentConstructor.prototype
      && htmlElementPrototype === htmlElementConstructor.prototype
      && view.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor
      && view.Object.getPrototypeOf === getPrototypeOf
      && view.Reflect.apply === apply
      && getters.every((intrinsic) => intrinsic?.isCurrent() === true)
      && methods.every((intrinsic) => intrinsic?.isCurrent() === true)
      && trusted.isCurrent()
      && addEventListener.isCurrent()
      && removeEventListener.isCurrent()
    );
    return historyIsClean;
  };
  return Object.freeze({
    view,
    keyboardPrototype,
    capturingPhase: eventConstructor.CAPTURING_PHASE,
    bubblingPhase: eventConstructor.BUBBLING_PHASE,
    apply,
    readKeyboard: (event: object) => {
      try {
        if (
          !intrinsicsAreCurrent()
          || getPrototypeOf(event) !== keyboardPrototype
          || !trusted.matches(event)
          || trusted.read(event) !== true
        ) {
          return null;
        }
        return Object.freeze({
          type: eventType.read(event),
          currentTarget: eventCurrentTarget.read(event),
          phase: eventPhase.read(event),
          bubbles: eventBubbles.read(event),
          cancelable: eventCancelable.read(event),
          defaultPrevented: eventDefaultPrevented.read(event),
          cancelBubble: eventCancelBubble.read(event),
          target: eventTarget.read(event),
          path: Object.freeze([...eventPath.invoke(event)]),
          isTrusted: trusted.read(event),
          view: eventView.read(event),
          composed: eventComposed.read(event),
          detail: eventDetail.read(event),
          key: key.read(event),
          code: code.read(event),
          location: location.read(event),
          repeat: repeat.read(event),
          composing: composing.read(event),
          altKey: altKey.read(event),
          ctrlKey: ctrlKey.read(event),
          metaKey: metaKey.read(event),
          shiftKey: shiftKey.read(event),
        });
      } catch {
        return null;
      }
    },
    methodMatches: (event: object, property: string, value: unknown) => {
      if (!intrinsicsAreCurrent() || typeof value !== "function") return false;
      try {
        let owner: object | null = event;
        while (owner) {
          const descriptor = getOwnPropertyDescriptor(owner, property);
          if (descriptor) return "value" in descriptor && descriptor.value === value;
          owner = getPrototypeOf(owner) as object | null;
        }
        return false;
      } catch {
        return false;
      }
    },
    activeElement: () => {
      if (!intrinsicsAreCurrent()) return undefined;
      try {
        return activeElement.read(ownerDocument);
      } catch {
        return undefined;
      }
    },
    focus,
    addEventListener,
    removeEventListener,
  });
}

function pickerDestination(key: string, current: number, count: number): number | null {
  if (count < 2 || current < 0 || current >= count) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + count) % count;
  if (key === "Home") return current === 0 ? null : 0;
  if (key === "End") return current === count - 1 ? null : count - 1;
  return null;
}

interface PickerWindowProof {
  readonly registration: PickerKeyListener;
  readonly publication: Publication<PickerAuthority>;
  readonly nativeEvent: KeyboardEvent;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly terminal: EventTarget;
  readonly path: readonly EventTarget[];
}

interface PickerKeyListener {
  readonly proofFor: (
    event: KeyboardEvent,
    publication: Publication<PickerAuthority>,
  ) => PickerWindowProof | null;
  readonly retains: (
    proof: PickerWindowProof,
    publication: Publication<PickerAuthority>,
  ) => boolean;
  readonly activate: (publication: Publication<PickerAuthority>) => boolean;
  readonly release: (publication: Publication<PickerAuthority>) => void;
  readonly isCurrent: () => boolean;
}

interface PickerReactKeyboardMethods {
  readonly preventDefault: (...args: never[]) => unknown;
  readonly isDefaultPrevented: (...args: never[]) => unknown;
  readonly isPropagationStopped: (...args: never[]) => unknown;
}

interface PickerReactKeyboardSnapshot {
  readonly event: ReactKeyboardEvent<HTMLElement>;
  readonly nativeEvent: KeyboardEvent;
  readonly target: HTMLButtonElement;
  readonly currentTarget: HTMLElement;
  readonly phase: number;
  readonly view: ReactKeyboardEvent<HTMLElement>["view"];
  readonly methods: PickerReactKeyboardMethods;
}

interface PickerMovement {
  readonly identity: symbol;
  readonly publication: Publication<PickerAuthority>;
  readonly sourceRow: PickerRowPresentation;
  readonly destinationRow: PickerRowPresentation;
  readonly source: HTMLButtonElement;
  readonly destination: HTMLButtonElement;
  readonly key: string;
}

interface PickerKeyPair {
  readonly publication: Publication<PickerAuthority>;
  readonly action: object;
  readonly prefersDark: boolean;
  readonly native: PickerNativeKeyboardFacts;
  readonly nativeEvent: KeyboardEvent;
  readonly capture: PickerReactKeyboardSnapshot;
  readonly windowProof: PickerWindowProof;
  readonly sourceRow: PickerRowPresentation;
  readonly destinationRow: PickerRowPresentation;
  readonly source: HTMLButtonElement;
  readonly destination: HTMLButtonElement;
  readonly key: string;
  readonly movement: PickerMovement;
  readonly publicationClaim: object;
  readonly sourceClaim: object;
  readonly destinationClaim: object;
  readonly captureClaim: object;
  readonly nativeClaim: object;
  readonly windowClaim: object;
}

interface PickerPairingStore {
  readonly isDisposed: () => boolean;
  readonly isInvalid: (event: object) => boolean;
  readonly has: (event: object) => boolean;
  readonly stage: (event: object, pair: PickerKeyPair) => boolean;
  readonly get: (event: object) => PickerKeyPair | null;
  readonly begin: (event: object, pair: PickerKeyPair) => boolean;
  readonly finish: (event: object, pair: PickerKeyPair) => void;
  readonly consume: (event: object, pair: PickerKeyPair) => boolean;
  readonly invalidate: (event: object) => void;
  readonly dispose: () => void;
}

interface PickerKeyDelivery {
  readonly pair: PickerKeyPair;
  readonly bubble: PickerReactKeyboardSnapshot;
}

function createPickerPairingStore(): PickerPairingStore {
  let pairs: WeakMap<object, PickerKeyPair> | null = new WeakMap();
  let active: WeakMap<object, PickerKeyPair> | null = new WeakMap();
  let invalid: WeakSet<object> | null = new WeakSet();
  let disposed = false;
  const isDisposed = () => disposed;
  return Object.freeze({
    isDisposed,
    isInvalid: (event) => {
      if (disposed || !invalid) return true;
      return invalid.has(event);
    },
    has: (event) => {
      if (disposed || !pairs) return false;
      return pairs.has(event);
    },
    stage: (event, pair) => {
      if (disposed || !pairs) return false;
      if (pairs.has(event)) return false;
      if (disposed || !pairs) return false;
      pairs.set(event, pair);
      return !disposed;
    },
    get: (event) => {
      if (disposed || !pairs) return null;
      return pairs.get(event) ?? null;
    },
    begin: (event, pair) => {
      if (disposed || !active) return false;
      if (active.has(event)) return false;
      if (disposed || !active) return false;
      active.set(event, pair);
      return !disposed;
    },
    finish: (event, pair) => {
      if (disposed || !active) return;
      if (active.get(event) !== pair) return;
      if (disposed || !active) return;
      active.delete(event);
    },
    consume: (event, pair) => {
      if (disposed || !pairs) return false;
      if (pairs.get(event) !== pair) return false;
      if (disposed || !pairs) return false;
      const consumed = pairs.delete(event);
      return !disposed && consumed;
    },
    invalidate: (event) => {
      if (disposed || !pairs || !invalid) return;
      pairs.delete(event);
      if (disposed || !invalid) return;
      invalid.add(event);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      pairs = null;
      active = null;
      invalid = null;
    },
  });
}

function createPickerKeyListener(
  authority: PickerKeyboardAuthority,
): PickerKeyListener {
  const proofs = new WeakMap<KeyboardEvent, PickerWindowProof>();
  const invalidEvents = new WeakSet<Event>();
  let publication: Publication<PickerAuthority> | null = null;
  let active = false;
  let released = false;
  const listener: EventListener = function (this: EventTarget, event: Event) {
    const current = publication;
    if (
      !current
      || !active
      || released
      || current.ownerRealm !== authority.view
      || invalidEvents.has(event)
    ) {
      return;
    }
    if (proofs.has(event as KeyboardEvent)) {
      proofs.delete(event as KeyboardEvent);
      invalidEvents.add(event);
      return;
    }
    const nativeEvent = event as KeyboardEvent;
    const facts = authority.readKeyboard(nativeEvent);
    const terminal = facts?.path.at(-1);
    if (
      !facts
      || facts.type !== "keydown"
      || facts.currentTarget !== this
      || terminal !== this
      || facts.phase !== authority.capturingPhase
      || facts.path.at(-2) !== current.ownerDocument
      || (facts.view !== null
        && facts.view !== authority.view
        && facts.view !== this)
    ) {
      invalidEvents.add(event);
      return;
    }
    proofs.set(nativeEvent, Object.freeze({
      registration,
      publication: current,
      nativeEvent,
      receiver: this,
      currentTarget: this,
      terminal,
      path: Object.freeze([...facts.path]),
    }));
  };
  const proofFor = (
    event: KeyboardEvent,
    current: Publication<PickerAuthority>,
  ) => {
    const proof = proofs.get(event);
    if (
      !proof
      || !active
      || released
      || publication !== current
      || proof.registration !== registration
      || proof.publication !== current
      || proof.nativeEvent !== event
      || proof.receiver !== proof.currentTarget
      || proof.receiver !== proof.terminal
      || invalidEvents.has(event)
    ) {
      return null;
    }
    const facts = authority.readKeyboard(event);
    return (
      facts
      && facts.path.length === proof.path.length
      && facts.path.every((entry, index) => entry === proof.path[index])
      && facts.path.at(-2) === current.ownerDocument
      && facts.path.at(-1) === proof.receiver
    )
      ? proof
      : null;
  };
  const registration: PickerKeyListener = Object.freeze({
    proofFor,
    retains: (
      proof: PickerWindowProof,
      current: Publication<PickerAuthority>,
    ) =>
      publication === current
      && proofFor(proof.nativeEvent, current) === proof
      && current.ownerRealm === authority.view
      && authority.addEventListener.isCurrent()
      && authority.removeEventListener.isCurrent(),
    activate: (current: Publication<PickerAuthority>) => {
      if (
        publication
        || active
        || released
        || current.ownerRealm !== authority.view
        || !authority.addEventListener.isCurrent()
        || !authority.removeEventListener.isCurrent()
      ) {
        return false;
      }
      publication = current;
      active = true;
      try {
        authority.apply(
          authority.addEventListener.value,
          authority.view,
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
        authority.apply(
          authority.removeEventListener.value,
          authority.view,
          ["keydown", listener, true],
        );
      } catch {
        return false;
      }
      return false;
    },
    release: (current: Publication<PickerAuthority>) => {
      if (publication !== current || released) return;
      released = true;
      const wasActive = active;
      active = false;
      publication = null;
      if (!wasActive) return;
      try {
        authority.apply(
          authority.removeEventListener.value,
          authority.view,
          ["keydown", listener, true],
        );
      } catch {
        return;
      }
    },
    isCurrent: () =>
      active
      && !released
      && publication?.ownerRealm === authority.view
      && authority.addEventListener.isCurrent()
      && authority.removeEventListener.isCurrent(),
  });
  return registration;
}

function pickerNativeFactsMatch(
  previous: PickerNativeKeyboardFacts,
  current: PickerNativeKeyboardFacts,
  defaultPrevented = false,
) {
  return (
    previous.type === current.type
    && previous.currentTarget === current.currentTarget
    && previous.bubbles === current.bubbles
    && previous.cancelable === current.cancelable
    && current.defaultPrevented === defaultPrevented
    && previous.cancelBubble === current.cancelBubble
    && previous.target === current.target
    && previous.path.length === current.path.length
    && previous.path.every((entry, index) => entry === current.path[index])
    && previous.isTrusted === current.isTrusted
    && previous.view === current.view
    && previous.composed === current.composed
    && previous.detail === current.detail
    && previous.key === current.key
    && previous.code === current.code
    && previous.location === current.location
    && previous.repeat === current.repeat
    && previous.composing === current.composing
    && previous.altKey === current.altKey
    && previous.ctrlKey === current.ctrlKey
    && previous.metaKey === current.metaKey
    && previous.shiftKey === current.shiftKey
  );
}

function applyPickerReactMethod(
  authority: PickerKeyboardAuthority,
  method: (...args: never[]) => unknown,
  event: ReactKeyboardEvent<HTMLElement>,
) {
  try {
    return Object.freeze({
      value: authority.apply(method, event, []),
    });
  } catch {
    return null;
  }
}

function pickerReactMethodsRemainExact(
  authority: PickerKeyboardAuthority,
  event: ReactKeyboardEvent<HTMLElement>,
  methods: PickerReactKeyboardMethods,
  currentIsDefaultPrevented: (...args: never[]) => unknown,
) {
  return (
    event.preventDefault === methods.preventDefault
    && event.isDefaultPrevented === currentIsDefaultPrevented
    && event.isPropagationStopped === methods.isPropagationStopped
    && authority.methodMatches(event, "preventDefault", methods.preventDefault)
    && authority.methodMatches(
      event,
      "isDefaultPrevented",
      currentIsDefaultPrevented,
    )
    && authority.methodMatches(
      event,
      "isPropagationStopped",
      methods.isPropagationStopped,
    )
  );
}

function capturePickerReactKeyboard(
  event: ReactKeyboardEvent<HTMLElement>,
  publication: Publication<PickerAuthority>,
  authority: PickerKeyboardAuthority,
  native: PickerNativeKeyboardFacts,
  nativeEvent: KeyboardEvent,
  target: HTMLButtonElement,
  currentTarget: HTMLElement,
  windowProof: PickerWindowProof,
): PickerReactKeyboardSnapshot | null {
  try {
    const wrapper = event as ReactKeyboardEvent<HTMLElement>;
    const preventDefault = wrapper.preventDefault;
    const isDefaultPrevented = wrapper.isDefaultPrevented;
    const isPropagationStopped = wrapper.isPropagationStopped;
    const isComposing = (
      wrapper as ReactKeyboardEvent<HTMLElement> & { isComposing?: unknown }
    ).isComposing;
    const view = wrapper.view;
    if (
      typeof preventDefault !== "function"
      || typeof isDefaultPrevented !== "function"
      || typeof isPropagationStopped !== "function"
      || wrapper === (nativeEvent as unknown)
      || wrapper.nativeEvent !== nativeEvent
      || wrapper.type !== native.type
      || wrapper.type !== "keydown"
      || wrapper.target !== target
      || wrapper.currentTarget !== currentTarget
      || wrapper.eventPhase !== native.phase
      || wrapper.bubbles !== native.bubbles
      || wrapper.cancelable !== native.cancelable
      || wrapper.defaultPrevented !== native.defaultPrevented
      || wrapper.isTrusted !== native.isTrusted
      || wrapper.key !== native.key
      || wrapper.code !== native.code
      || wrapper.location !== native.location
      || wrapper.repeat !== native.repeat
      || (isComposing !== undefined && isComposing !== native.composing)
      || wrapper.altKey !== native.altKey
      || wrapper.ctrlKey !== native.ctrlKey
      || wrapper.metaKey !== native.metaKey
      || wrapper.shiftKey !== native.shiftKey
      || wrapper.detail !== native.detail
      || (view !== null
        && !Object.is(view, publication.ownerRealm)
        && !Object.is(view, windowProof.receiver))
    ) {
      return null;
    }
    const methods = Object.freeze({
      preventDefault,
      isDefaultPrevented,
      isPropagationStopped,
    });
    if (!pickerReactMethodsRemainExact(authority, wrapper, methods, isDefaultPrevented)) {
      return null;
    }
    const defaultResult = applyPickerReactMethod(authority, isDefaultPrevented, wrapper);
    if (
      defaultResult?.value !== false
      || !pickerReactMethodsRemainExact(authority, wrapper, methods, isDefaultPrevented)
    ) {
      return null;
    }
    const propagationResult = applyPickerReactMethod(authority, isPropagationStopped, wrapper);
    if (
      propagationResult?.value !== false
      || !pickerReactMethodsRemainExact(authority, wrapper, methods, isDefaultPrevented)
    ) {
      return null;
    }
    return Object.freeze({
      event: wrapper,
      nativeEvent,
      target,
      currentTarget,
      phase: native.phase,
      view,
      methods,
    });
  } catch {
    return null;
  }
}

function pickerReactKeyboardRemainsExact(
  snapshot: PickerReactKeyboardSnapshot,
  publication: Publication<PickerAuthority>,
  authority: PickerKeyboardAuthority,
  native: PickerNativeKeyboardFacts,
  currentTarget: HTMLElement | null,
  defaultPrevented = false,
) {
  try {
    const event = snapshot.event;
    const methods = snapshot.methods;
    const currentIsDefaultPrevented = event.isDefaultPrevented;
    const isComposing = (
      event as ReactKeyboardEvent<HTMLElement> & { isComposing?: unknown }
    ).isComposing;
    if (
      typeof currentIsDefaultPrevented !== "function"
      || (
      event.nativeEvent === snapshot.nativeEvent
      && event.type === native.type
      && event.target === snapshot.target
      && event.target === native.target
      && event.currentTarget === currentTarget
      && event.eventPhase === snapshot.phase
      && event.eventPhase === native.phase
      && event.bubbles === native.bubbles
      && event.cancelable === native.cancelable
      && event.defaultPrevented === defaultPrevented
      && event.isTrusted === native.isTrusted
      && event.key === native.key
      && event.code === native.code
      && event.location === native.location
      && event.repeat === native.repeat
      && (isComposing === undefined || isComposing === native.composing)
      && event.altKey === native.altKey
      && event.ctrlKey === native.ctrlKey
      && event.metaKey === native.metaKey
      && event.shiftKey === native.shiftKey
      && event.detail === native.detail
      && event.view === snapshot.view
      && (event.view === null
        || Object.is(event.view, publication.ownerRealm)
        || Object.is(event.view, native.path.at(-1)))
      && (!defaultPrevented
        ? currentIsDefaultPrevented === methods.isDefaultPrevented
        : true)
      ) !== true
      || !pickerReactMethodsRemainExact(
        authority,
        event,
        methods,
        currentIsDefaultPrevented,
      )
    ) {
      return false;
    }
    const defaultResult = applyPickerReactMethod(authority, currentIsDefaultPrevented, event);
    if (
      defaultResult?.value !== defaultPrevented
      || !pickerReactMethodsRemainExact(
        authority,
        event,
        methods,
        currentIsDefaultPrevented,
      )
    ) {
      return false;
    }
    const propagationResult = applyPickerReactMethod(
      authority,
      methods.isPropagationStopped,
      event,
    );
    return (
      propagationResult?.value === false
      && pickerReactMethodsRemainExact(
        authority,
        event,
        methods,
        currentIsDefaultPrevented,
      )
    );
  } catch {
    return false;
  }
}

function createPickerPresentation(
  authority: PickerAuthority,
  coordinator: PublicationCoordinator<PickerAuthority>,
  requestSuccessor: () => void,
): PickerPresentation {
  let currentRuntime: PublicationRuntime<PickerAuthority> | null = null;
  let lastRuntime: PublicationRuntime<PickerAuthority> | null = null;
  let keyboardAuthority: PickerKeyboardAuthority | null = null;
  let keyboardListener: PickerKeyListener | null = null;
  let pairingStore: PickerPairingStore | null = null;
  let successorRequested = false;
  let completePickerNavigation = (
    _row: PickerRowAuthority,
    _event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {};
  const {
    mount,
    revision,
    preference,
    setPreference,
    rootClassName,
    rows,
  } = authority;
  const disposePairingStore = () => {
    pairingStore?.dispose();
    pairingStore = null;
  };
  const releaseKeyboard = (publication: Publication<PickerAuthority>) => {
    disposePairingStore();
    keyboardListener?.release(publication);
    keyboardAuthority = null;
    keyboardListener = null;
  };
  const onElementChange = (
    owner: ElementOwnerView,
    element: Element | null,
    previous: Element | null,
    last: Element | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null || (element !== null && last !== null && element !== last)) {
      if (currentRuntime) releaseKeyboard(currentRuntime.publication);
      currentRuntime?.retireForElement();
      currentRuntime = null;
    }
    if (
      runtime?.isExactElementReplay()
      && coordinator.acceptsSuccessorOf(runtime.publication)
    ) {
      requestReplaySuccessor(runtime);
    }
  };
  const rootOwner = new ElementOwner<HTMLDivElement>(onElementChange);
  const rowPresentations = rows.map((row) => {
    const buttonOwner = new ElementOwner<HTMLButtonElement>(onElementChange);
    const iconOwner = new ElementOwner<SVGSVGElement>(onElementChange);
    const action = Object.freeze({
      identity: Symbol(`theme-picker-${row.preference}-action`),
    });
    const keyboardAction = Object.freeze({
      identity: Symbol(`theme-picker-${row.preference}-keyboard-action`),
    });
    const onClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
      const publication = coordinator.active();
      const button = buttonOwner.element();
      const eventPrefersDark = readSystemTheme();
      if (
        !publication
        || publication.isRetired()
        || !pickerAuthoritiesMatch(publication.authority, authority)
        || row.checked
        || row.preference === preference
        || rows[row.index] !== row
        || !button
        || !coordinator.isCurrent(publication)
        || !factsAreCurrent()
        || !exactDomIsCurrent()
        || !publication.publishedDomMatches()
        || themeStore.getSnapshot() !== preference
        || eventPrefersDark === null
      ) {
        return;
      }
      const nativeEvent = exactNativeClick(event, publication, button);
      if (
        !nativeEvent
        || coordinator.hasClaimed(publication, action, event, nativeEvent)
        || !systemThemeMatches(eventPrefersDark)
        || !coordinator.isCurrent(publication)
        || !factsAreCurrent()
        || !exactDomIsCurrent()
        || !publication.publishedDomMatches()
        || !storeMatches(preference)
        || !coordinator.claim(publication, action, event, nativeEvent)
      ) {
        return;
      }
      setPreference(row.preference);
    };
    const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) =>
      completePickerNavigation(row, event);
    return Object.freeze({
      authority: row,
      captureButton: buttonOwner.capture,
      captureIcon: iconOwner.capture,
      buttonOwner,
      iconOwner,
      action,
      keyboardAction,
      onClick,
      onKeyDown,
    });
  });
  const expectedOwners = () => Object.freeze([
    rootOwner,
    ...rowPresentations.flatMap(({ buttonOwner, iconOwner }) => [buttonOwner, iconOwner]),
  ]);
  const readSystemTheme = () => {
    try {
      return systemPrefersDark();
    } catch {
      return null;
    }
  };
  const systemThemeMatches = (expected: boolean) => readSystemTheme() === expected;
  const storeMatches = (expected: ThemePreference) => {
    try {
      return themeStore.getSnapshot() === expected;
    } catch {
      return false;
    }
  };
  const factsAreCurrent = () =>
    authority.mount === mount
    && authority.revision === revision
    && authority.preference === preference
    && authority.setPreference === setPreference
    && authority.rootClassName === rootClassName
    && authority.rows === rows
    && rootClassName === PICKER_CLASS_NAME
    && rows.length === THEME_OPTIONS.length
    && rows.every((row, index) => (
      row.index === index
      && row.preference === THEME_OPTIONS[index]
      && row.label === themeLabel(row.preference)
      && row.checked === (row.preference === preference)
      && row.tabIndex === (row.checked ? 0 : -1)
      && row.className === cn(
        PICKER_ROW_BASE_CLASS_NAME,
        row.checked ? PICKER_ROW_ACTIVE_CLASS_NAME : PICKER_ROW_INACTIVE_CLASS_NAME,
      )
      && row.size === 14
    ));
  const exactDomIsCurrent = () => {
    const root = rootOwner.element();
    return (
      !!root
      && root.isConnected
      && root.ownerDocument.defaultView !== null
      && root.tagName === "DIV"
      && root.getAttribute("class") === rootClassName
      && root.getAttribute("role") === "radiogroup"
      && root.getAttribute("aria-label") === "Theme"
      && root.dataset.testid === "theme-picker"
      && root.children.length === THEME_OPTIONS.length
      && root.childNodes.length === THEME_OPTIONS.length
      && rowPresentations.every((presentation, index) => {
        const row = presentation.authority;
        const button = presentation.buttonOwner.element();
        const icon = presentation.iconOwner.element();
        return (
          rows[index] === row
          && !!button
          && !!icon
          && button.isConnected
          && button.ownerDocument === root.ownerDocument
          && button.tagName === "BUTTON"
          && button.parentElement === root
          && root.children.item(index) === button
          && root.childNodes.item(index) === button
          && button.getAttribute("type") === "button"
          && button.type === "button"
          && !button.disabled
          && !button.matches(":disabled")
          && button.getAttribute("role") === "radio"
          && button.getAttribute("aria-checked") === String(row.checked)
          && button.tabIndex === row.tabIndex
          && button.getAttribute("tabindex") === String(row.tabIndex)
          && button.getAttribute("class") === row.className
          && button.dataset.testid === `theme-option-${row.preference}`
          && button.textContent?.trim() === row.label
          && iconMatches(icon, button, row.preference, row.size)
        );
      })
    );
  };
  const movementIsCurrent = (
    runtime: PublicationRuntime<PickerAuthority>,
    publication: Publication<PickerAuthority>,
    sourceRow: PickerRowPresentation,
    destinationRow: PickerRowPresentation,
    source: HTMLButtonElement,
    destination: HTMLButtonElement,
    key: string,
    expectedStore: ThemePreference,
    expectedPrefersDark: boolean,
  ) => {
    const events = keyboardAuthority;
    const listener = keyboardListener;
    const destinationIndex = pickerDestination(
      key,
      sourceRow.authority.index,
      rows.length,
    );
    return Boolean(
      events
      && listener
      && currentRuntime === runtime
      && !runtime.isRetired()
      && publication === runtime.publication
      && publication.authority === authority
      && publication.ownerDocument.defaultView === publication.ownerRealm
      && sourceRow.authority === rows[sourceRow.authority.index]
      && destinationRow.authority === rows[destinationRow.authority.index]
      && sourceRow.authority.checked
      && sourceRow.authority.preference === preference
      && sourceRow.authority.tabIndex === 0
      && !destinationRow.authority.checked
      && destinationRow.authority.preference !== preference
      && destinationRow.authority.tabIndex === -1
      && destinationIndex === destinationRow.authority.index
      && sourceRow.buttonOwner.element() === source
      && destinationRow.buttonOwner.element() === destination
      && source.ownerDocument === publication.ownerDocument
      && destination.ownerDocument === publication.ownerDocument
      && source.parentElement === publication.root
      && destination.parentElement === publication.root
      && publication.root.children.item(sourceRow.authority.index) === source
      && publication.root.children.item(destinationRow.authority.index) === destination
      && events.activeElement() === source
      && events.focus.isCurrent()
      && listener.isCurrent()
      && coordinator.isCurrent(publication)
      && factsAreCurrent()
      && exactDomIsCurrent()
      && runtime.publishedDomMatches()
      && storeMatches(expectedStore)
      && systemThemeMatches(expectedPrefersDark)
    );
  };
  const publicationAllowsEventAbort = (
    pairs: PickerPairingStore,
    runtime: PublicationRuntime<PickerAuthority>,
    publication: Publication<PickerAuthority>,
    listener: PickerKeyListener,
    pair: PickerKeyPair,
  ) =>
    pairingStore === pairs
    && !pairs.isDisposed()
    && currentRuntime === runtime
    && runtime.publication === publication
    && pair.publication === publication
    && pair.action === pair.sourceRow.keyboardAction
    && rowPresentations[pair.sourceRow.authority.index] === pair.sourceRow
    && rowPresentations[pair.destinationRow.authority.index] === pair.destinationRow
    && listener.retains(pair.windowProof, publication)
    && movementIsCurrent(
      runtime,
      publication,
      pair.sourceRow,
      pair.destinationRow,
      pair.source,
      pair.destination,
      pair.key,
      preference,
      pair.prefersDark,
    );
  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const pairs = pairingStore;
    if (!pairs || pairs.isDisposed()) return;
    let nativeEvent: unknown;
    let eventCurrentTarget: EventTarget | null;
    try {
      nativeEvent = event.nativeEvent;
      eventCurrentTarget = event.currentTarget;
    } catch {
      return;
    }
    if (!nativeEvent || typeof nativeEvent !== "object" || pairs.isInvalid(nativeEvent)) {
      return;
    }
    if (pairs.has(nativeEvent)) {
      pairs.invalidate(nativeEvent);
      return;
    }
    const eventPrefersDark = readSystemTheme();
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const events = keyboardAuthority;
    const listener = keyboardListener;
    const root = rootOwner.element();
    if (
      !runtime
      || !publication
      || !events
      || !listener
      || !root
      || eventPrefersDark === null
      || runtime.isRetired()
      || eventCurrentTarget !== root
    ) {
      return;
    }
    const native = events.readKeyboard(nativeEvent);
    const proof = native
      ? listener.proofFor(nativeEvent as KeyboardEvent, publication)
      : null;
    const sourceRow = native
      ? rowPresentations.find((candidate) =>
          candidate.buttonOwner.element() === native.target)
      : undefined;
    const source = sourceRow?.buttonOwner.element();
    const destinationIndex = sourceRow && native
      ? pickerDestination(native.key, sourceRow.authority.index, rows.length)
      : null;
    const destinationRow = destinationIndex === null
      ? undefined
      : rowPresentations[destinationIndex];
    const destination = destinationRow?.buttonOwner.element();
    const capture = (
      native
      && proof
      && source
      && destination
    )
      ? capturePickerReactKeyboard(
          event,
          publication,
          events,
          native,
          nativeEvent as KeyboardEvent,
          source,
          root,
          proof,
        )
      : null;
    const nativeCurrentTarget = native?.currentTarget;
    if (
      !native
      || !proof
      || !sourceRow
      || !source
      || destinationIndex === null
      || !destinationRow
      || !destination
      || !capture
      || native.type !== "keydown"
      || native.phase !== events.capturingPhase
      || !native.bubbles
      || !native.cancelable
      || native.defaultPrevented
      || native.cancelBubble
      || !native.isTrusted
      || !native.composed
      || native.repeat
      || native.composing
      || native.altKey
      || native.ctrlKey
      || native.metaKey
      || native.shiftKey
      || native.target !== source
      || !(nativeCurrentTarget instanceof events.view.Node)
      || nativeCurrentTarget.ownerDocument !== publication.ownerDocument
      || !nativeCurrentTarget.contains(publication.root)
      || native.path[0] !== source
      || native.path.filter((entry) => entry === source).length !== 1
      || !native.path.includes(publication.root)
      || native.path.at(-1) !== proof.receiver
      || (native.view !== null
        && native.view !== publication.ownerRealm
        && native.view !== proof.receiver)
      || sourceRow.authority !== rows[sourceRow.authority.index]
      || destinationRow.authority !== rows[destinationIndex]
      || sourceRow.keyboardAction !== rowPresentations[sourceRow.authority.index]?.keyboardAction
      || coordinator.hasClaimed(
        publication,
        sourceRow.keyboardAction,
        capture.event,
        nativeEvent as Event,
      )
      || !movementIsCurrent(
        runtime,
        publication,
        sourceRow,
        destinationRow,
        source,
        destination,
        native.key,
        preference,
        eventPrefersDark,
      )
    ) {
      return;
    }
    const movement = Object.freeze<PickerMovement>({
      identity: Symbol("theme-picker-keyboard-movement"),
      publication,
      sourceRow,
      destinationRow,
      source,
      destination,
      key: native.key,
    });
    pairs.stage(nativeEvent, Object.freeze({
      publication,
      action: sourceRow.keyboardAction,
      prefersDark: eventPrefersDark,
      native,
      nativeEvent: nativeEvent as KeyboardEvent,
      capture,
      windowProof: proof,
      sourceRow,
      destinationRow,
      source,
      destination,
      key: native.key,
      movement,
      publicationClaim: Object.freeze({ publication }),
      sourceClaim: Object.freeze({ sourceRow, source }),
      destinationClaim: Object.freeze({ destinationRow, destination }),
      captureClaim: Object.freeze({ capture }),
      nativeClaim: Object.freeze({ nativeEvent }),
      windowClaim: Object.freeze({ listener, proof, receiver: proof.receiver }),
    }));
  };
  completePickerNavigation = (
    row: PickerRowAuthority,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    const pairs = pairingStore;
    if (!pairs || pairs.isDisposed()) return;
    let nativeEvent: unknown;
    let eventCurrentTarget: EventTarget | null;
    try {
      nativeEvent = event.nativeEvent;
      eventCurrentTarget = event.currentTarget;
    } catch {
      return;
    }
    if (!nativeEvent || typeof nativeEvent !== "object" || pairs.isInvalid(nativeEvent)) {
      return;
    }
    const pair = pairs.get(nativeEvent);
    if (!pair || pair.nativeEvent !== nativeEvent) return;
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const events = keyboardAuthority;
    const listener = keyboardListener;
    if (
      !runtime
      || !publication
      || !events
      || !listener
      || pair.publication !== publication
      || pair.sourceRow.authority !== row
      || pair.action !== pair.sourceRow.keyboardAction
      || pair.source !== eventCurrentTarget
    ) {
      return;
    }
    if (!pairs.begin(nativeEvent, pair)) return;
    let delivery: PickerKeyDelivery | null = null;
    let claimed = false;
    let committed = false;
    try {
      const native = events.readKeyboard(nativeEvent);
      const proof = native
        ? listener.proofFor(nativeEvent as KeyboardEvent, publication)
        : null;
      const bubble = native && proof
        ? capturePickerReactKeyboard(
            event,
            publication,
            events,
            native,
            nativeEvent as KeyboardEvent,
            pair.source,
            pair.source,
            proof,
          )
        : null;
      if (
        !native
        || !proof
        || !bubble
        || bubble.event === pair.capture.event
        || native.phase !== events.bubblingPhase
        || pair.native.phase !== events.capturingPhase
        || native.currentTarget !== pair.native.currentTarget
        || proof !== pair.windowProof
        || proof.receiver !== native.path.at(-1)
        || !pickerNativeFactsMatch(pair.native, native)
        || !pickerReactKeyboardRemainsExact(
          pair.capture,
          publication,
          events,
          pair.native,
          null,
        )
        || !pickerReactKeyboardRemainsExact(
          bubble,
          publication,
          events,
          native,
          pair.source,
        )
        || !movementIsCurrent(
          runtime,
          publication,
          pair.sourceRow,
          pair.destinationRow,
          pair.source,
          pair.destination,
          pair.key,
          preference,
          pair.prefersDark,
        )
      ) {
        return;
      }
      delivery = Object.freeze<PickerKeyDelivery>({ pair, bubble });
      if (
        !coordinator.claimDelivery(
          publication,
          pair.action,
          [pair.capture.event, bubble.event, pair.nativeEvent],
          [
            pair.movement,
            pair.windowProof,
            pair.publicationClaim,
            pair.sourceClaim,
            pair.destinationClaim,
            pair.captureClaim,
            pair.nativeClaim,
            pair.windowClaim,
          ],
          delivery,
        )
      ) {
        return;
      }
      claimed = true;
      if (!pairs.consume(nativeEvent, pair)) {
        pairs.invalidate(nativeEvent);
        return;
      }
      if (
        !coordinator.deliveryIsActive(delivery)
        || !listener.retains(pair.windowProof, publication)
        || !pickerReactKeyboardRemainsExact(
          pair.capture,
          publication,
          events,
          pair.native,
          null,
        )
        || !pickerReactKeyboardRemainsExact(
          bubble,
          publication,
          events,
          native,
          pair.source,
        )
        || !movementIsCurrent(
          runtime,
          publication,
          pair.sourceRow,
          pair.destinationRow,
          pair.source,
          pair.destination,
          pair.key,
          preference,
          pair.prefersDark,
        )
        || !pickerReactMethodsRemainExact(
          events,
          bubble.event,
          bubble.methods,
          bubble.methods.isDefaultPrevented,
        )
      ) {
        return;
      }
      const prevention = applyPickerReactMethod(
        events,
        bubble.methods.preventDefault,
        bubble.event,
      );
      const preventedNative = events.readKeyboard(pair.nativeEvent);
      if (
        !prevention
        || !preventedNative
        || preventedNative.phase !== events.bubblingPhase
        || !pickerNativeFactsMatch(native, preventedNative, true)
        || !listener.retains(pair.windowProof, publication)
        || !coordinator.deliveryIsActive(delivery)
        || !pickerReactKeyboardRemainsExact(
          pair.capture,
          publication,
          events,
          pair.native,
          null,
        )
        || !pickerReactKeyboardRemainsExact(
          bubble,
          publication,
          events,
          preventedNative,
          pair.source,
          true,
        )
        || !movementIsCurrent(
          runtime,
          publication,
          pair.sourceRow,
          pair.destinationRow,
          pair.source,
          pair.destination,
          pair.key,
          preference,
          pair.prefersDark,
        )
        || !pickerReactMethodsRemainExact(
          events,
          bubble.event,
          bubble.methods,
          bubble.event.isDefaultPrevented,
        )
      ) {
        return;
      }
      setPreference(pair.destinationRow.authority.preference);
      const selectedNative = events.readKeyboard(pair.nativeEvent);
      if (
        !selectedNative
        || selectedNative.phase !== events.bubblingPhase
        || !pickerNativeFactsMatch(preventedNative, selectedNative, true)
        || !listener.retains(pair.windowProof, publication)
        || !coordinator.deliveryIsActive(delivery)
        || !pickerReactKeyboardRemainsExact(
          pair.capture,
          publication,
          events,
          pair.native,
          null,
        )
        || !pickerReactKeyboardRemainsExact(
          bubble,
          publication,
          events,
          selectedNative,
          pair.source,
          true,
        )
        || !movementIsCurrent(
          runtime,
          publication,
          pair.sourceRow,
          pair.destinationRow,
          pair.source,
          pair.destination,
          pair.key,
          pair.destinationRow.authority.preference,
          pair.prefersDark,
        )
        || !pickerReactMethodsRemainExact(
          events,
          bubble.event,
          bubble.methods,
          bubble.event.isDefaultPrevented,
        )
      ) {
        return;
      }
      events.focus.invoke(pair.destination, { preventScroll: true });
      if (!coordinator.commitDelivery(delivery)) return;
      committed = true;
    } finally {
      pairs.finish(nativeEvent, pair);
      if (delivery && claimed) {
        coordinator.finishDelivery(delivery);
        if (!committed) {
          pairs.invalidate(nativeEvent);
          if (
            currentRuntime === runtime
            && !publicationAllowsEventAbort(pairs, runtime, publication, listener, pair)
          ) {
            releaseKeyboard(publication);
            runtime.retireForElement();
            currentRuntime = null;
            if (!successorRequested) {
              successorRequested = true;
              requestSuccessor();
            }
          }
        }
      }
    }
  };
  const requestReplaySuccessor = (runtime: PublicationRuntime<PickerAuthority>) => {
    const replay = runtime.replay();
    if (
      successorRequested
      || !replay
      || !coordinator.acceptsSuccessorOf(runtime.publication)
      || !factsAreCurrent()
      || !exactDomIsCurrent()
      || !runtime.publishedDomMatches()
      || !coordinator.stageReplay(replay)
    ) {
      return;
    }
    successorRequested = true;
    requestSuccessor();
  };
  const establish = () => {
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() || lastRuntime.isExactElementReplay())
        && coordinator.acceptsSuccessorOf(lastRuntime.publication)
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (!factsAreCurrent() || !exactDomIsCurrent()) return undefined;
    const root = rootOwner.element();
    if (
      !root
      || !replayAllowsPublication(
        coordinator,
        authority,
        root,
        (previous, current) => pickerAuthoritiesMatch(previous, current, false),
      )
    ) {
      return undefined;
    }
    const runtime = createPublicationRuntime(authority, coordinator, root, expectedOwners());
    currentRuntime = runtime;
    lastRuntime = runtime;
    keyboardAuthority = capturePickerKeyboardAuthority(runtime.publication);
    keyboardListener = keyboardAuthority
      ? createPickerKeyListener(keyboardAuthority)
      : null;
    if (
      !keyboardAuthority
      || !keyboardListener
      || !runtime.publish()
      || !keyboardListener.activate(runtime.publication)
    ) {
      keyboardListener?.release(runtime.publication);
      runtime.retireForElement();
      currentRuntime = null;
      keyboardAuthority = null;
      keyboardListener = null;
      return undefined;
    }
    pairingStore = createPickerPairingStore();
    return () => {
      releaseKeyboard(runtime.publication);
      runtime.retireForLayout();
    };
  };

  return Object.freeze({
    captureRoot: rootOwner.capture,
    rows: Object.freeze(rowPresentations),
    establish,
    onKeyDownCapture,
  });
}

/**
 * Cycles system → light → dark. The server renders the "system" icon; the client corrects it after
 * hydration. The button is `disabled` (and `aria-busy`) until then: the server markup has no click
 * handler, so a click that lands before React hydrates would be silently lost. Disabling it makes
 * Playwright's actionability check wait, and tells assistive tech the control is not ready yet.
 */
export function ThemeToggle({ className, size = 16 }: { className?: string; size?: number }) {
  const [preference, setPreference] = useThemeControl();
  const hydrated = useHydrated();
  const [mount] = useState(() => Symbol("theme toggle"));
  const [coordinator] = useState(() => new PublicationCoordinator<ToggleAuthority>(mount));
  const [presentationCache] = useState(
    () => new PresentationCache<ToggleAuthority, TogglePresentation>(),
  );
  const [publicationRevision, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const Icon = ICONS[preference];
  const label = `Theme: ${themeLabel(preference)}`;
  const title = `${label} (click to switch)`;
  const buttonClassName = cn("icon-btn", className);
  const candidate: ToggleAuthority = Object.freeze({
    mount,
    revision: publicationRevision,
    preference,
    nextPreference: nextTheme(preference),
    setPreference,
    hydrated,
    label,
    title,
    classNameInput: className,
    className: buttonClassName,
    size,
  });
  const presentation = presentationCache.resolve(
    candidate,
    publicationRevision,
    toggleAuthoritiesMatch,
    () => createTogglePresentation(
        candidate,
        coordinator,
        requestPublicationSuccessor,
      ),
  );

  useLayoutEffect(() => presentation.establish(), [presentation]);
  const { captureButton, onClick } = presentation;

  return (
    <button
      ref={captureButton}
      type="button"
      className={buttonClassName}
      onClick={onClick}
      disabled={!hydrated}
      aria-busy={!hydrated || undefined}
      title={title}
      aria-label={label}
      data-testid="theme-toggle"
      data-theme-preference={preference}
    >
      <Icon size={size} />
    </button>
  );
}

/** Radio-style row for the settings page. */
export function ThemePicker() {
  const [preference, setPreference] = useThemeControl();
  const [mount] = useState(() => Symbol("theme picker"));
  const [coordinator] = useState(() => new PublicationCoordinator<PickerAuthority>(mount));
  const [presentationCache] = useState(
    () => new PresentationCache<PickerAuthority, PickerPresentation>(),
  );
  const [publicationRevision, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const candidateRows = Object.freeze(
    THEME_OPTIONS.map((rowPreference, index) => {
      const checked = rowPreference === preference;
      return Object.freeze({
        index,
        preference: rowPreference,
        label: themeLabel(rowPreference),
        checked,
        tabIndex: checked ? 0 : -1,
        className: cn(
          PICKER_ROW_BASE_CLASS_NAME,
          checked ? PICKER_ROW_ACTIVE_CLASS_NAME : PICKER_ROW_INACTIVE_CLASS_NAME,
        ),
        size: 14,
      });
    }),
  );
  const candidate: PickerAuthority = Object.freeze({
    mount,
    revision: publicationRevision,
    preference,
    setPreference,
    rootClassName: PICKER_CLASS_NAME,
    rows: candidateRows,
  });
  const presentation = presentationCache.resolve(
    candidate,
    publicationRevision,
    pickerAuthoritiesMatch,
    () => createPickerPresentation(
        candidate,
        coordinator,
        requestPublicationSuccessor,
      ),
  );

  useLayoutEffect(() => presentation.establish(), [presentation]);
  const { captureRoot, rows, onKeyDownCapture } = presentation;

  return (
    <div
      ref={captureRoot}
      className={PICKER_CLASS_NAME}
      role="radiogroup"
      aria-label="Theme"
      onKeyDownCapture={onKeyDownCapture}
      data-testid="theme-picker"
    >
      {rows.map((row) => {
        const option = row.authority.preference;
        const Icon = ICONS[option];
        return (
          <button
            ref={row.captureButton}
            key={option}
            type="button"
            role="radio"
            aria-checked={row.authority.checked}
            tabIndex={row.authority.tabIndex}
            className={row.authority.className}
            onClick={row.onClick}
            onKeyDown={row.onKeyDown}
            data-testid={`theme-option-${option}`}
          >
            <Icon ref={row.captureIcon} size={row.authority.size} /> {row.authority.label}
          </button>
        );
      })}
    </div>
  );
}
