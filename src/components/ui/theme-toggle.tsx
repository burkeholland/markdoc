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
  readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

interface PickerPresentation {
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly rows: readonly PickerRowPresentation[];
  readonly establish: () => void | (() => void);
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

const PICKER_NAVIGATION_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"]);

function pickerDestination(key: string, current: number, count: number): number | null {
  if (count < 2 || current < 0 || current >= count) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + count) % count;
  if (key === "Home") return current === 0 ? null : 0;
  if (key === "End") return current === count - 1 ? null : count - 1;
  return null;
}

function createPickerPresentation(
  authority: PickerAuthority,
  coordinator: PublicationCoordinator<PickerAuthority>,
  requestSuccessor: () => void,
): PickerPresentation {
  let currentRuntime: PublicationRuntime<PickerAuthority> | null = null;
  let lastRuntime: PublicationRuntime<PickerAuthority> | null = null;
  let successorRequested = false;
  const {
    mount,
    revision,
    preference,
    setPreference,
    rootClassName,
    rows,
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
  const rootOwner = new ElementOwner<HTMLDivElement>(onElementChange);
  const rowPresentations = rows.map((row) => {
    const buttonOwner = new ElementOwner<HTMLButtonElement>(onElementChange);
    const iconOwner = new ElementOwner<SVGSVGElement>(onElementChange);
    const action = Object.freeze({
      identity: Symbol(`theme-picker-${row.preference}-action`),
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
    return Object.freeze({
      authority: row,
      captureButton: buttonOwner.capture,
      captureIcon: iconOwner.capture,
      buttonOwner,
      iconOwner,
      action,
      onClick,
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
    if (!runtime.publish()) {
      runtime.retireForElement();
      currentRuntime = null;
      return undefined;
    }
    return () => {
      runtime.retireForLayout();
    };
  };

  return Object.freeze({
    captureRoot: rootOwner.capture,
    rows: Object.freeze(rowPresentations),
    establish,
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
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!PICKER_NAVIGATION_KEYS.has(event.key)) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const focused = options.indexOf(event.target as HTMLButtonElement);
    const destination = pickerDestination(event.key, focused >= 0 ? focused : THEME_OPTIONS.indexOf(preference), THEME_OPTIONS.length);
    if (destination === null) return;
    setPreference(THEME_OPTIONS[destination]!);
    options[destination]?.focus({ preventScroll: true });
  };
  const { captureRoot, rows } = presentation;

  return (
    <div
      ref={captureRoot}
      className={PICKER_CLASS_NAME}
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onKeyDown}
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
            data-testid={`theme-option-${option}`}
          >
            <Icon ref={row.captureIcon} size={row.authority.size} /> {row.authority.label}
          </button>
        );
      })}
    </div>
  );
}
