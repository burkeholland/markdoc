"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefCallback,
  type RefObject,
} from "react";
import { ChevronDown, List } from "lucide-react";
import type { RenderedHeading } from "@/server/export/html";
import { cn } from "@/lib/utils";

/** Vertical offset (sticky chrome + breathing room) used to decide which heading is "current". */
const TOP_OFFSET = 88;

const TOGGLE_CLASS =
  "flex w-full items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm font-medium text-ink-2 lg:hidden";
const PAGE_HEADING_CLASS =
  "mb-2 hidden pl-2 text-[11px] font-semibold uppercase tracking-wider text-ink-4 lg:block";
const ENTRY_CLASS = "block rounded-md py-1 pr-2 text-[13px] leading-snug transition-colors";

type HeadingSnapshot = Readonly<{
  id: string;
  level: number;
  text: string;
  index: number;
  href: string;
}>;

type HeadingsVisit = Readonly<{
  session: symbol;
  headings: readonly HeadingSnapshot[];
}>;

type PermanentOwner = Readonly<{
  identity: symbol;
  isRetired: () => boolean;
  retire: () => void;
}>;

type VisitOwner = PermanentOwner & Readonly<{
  visit: HeadingsVisit;
  document: Document;
  placementParent: Node;
}>;

type HeadingElementFact = Readonly<{
  heading: HeadingSnapshot;
  element: HTMLElement | null;
}>;

type ObserverOwner = PermanentOwner & Readonly<{
  visitOwner: VisitOwner;
  document: Document;
  observer: IntersectionObserver | null;
  headings: readonly HeadingElementFact[];
  nodeFacts: readonly NodeFact[];
  trackedNodes: ReadonlySet<Node>;
  trackedParents: ReadonlySet<Node>;
  headingIds: ReadonlySet<string>;
  mutationObserver: MutationObserver | null;
  hasAuthority: () => boolean;
}>;

type ActiveHeading = Readonly<{
  owner: ObserverOwner;
  id: string | null;
}>;

type TocRender = Readonly<{
  identity: symbol;
  visit: HeadingsVisit;
  open: boolean;
  active: string | null;
}>;

type DomGeneration = PermanentOwner & Readonly<{
  render: TocRender;
}>;

type ElementOwner<T extends Element> = Readonly<{
  render: TocRender;
  generation: DomGeneration;
  element: T;
}>;

type NodeFact = Readonly<{
  node: Node;
  parent: Node | null;
  previous: Node | null;
  next: Node | null;
  nodeType: number;
  data: string | null;
  attributes: readonly (readonly [string | null, string, string])[] | null;
  children: readonly Node[];
}>;

type PublicationAction = "toggle" | "link" | "escape" | "navigate" | "reject-link";

type NavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

type CapturedDescriptor = Readonly<{
  configurable: boolean | undefined;
  enumerable: boolean | undefined;
  get: PropertyDescriptor["get"];
  set: PropertyDescriptor["set"];
  value: unknown;
  writable: boolean | undefined;
}>;

type CapturedGetter = Readonly<{
  owner: object;
  key: string;
  descriptor: CapturedDescriptor;
  getter: NonNullable<PropertyDescriptor["get"]>;
}>;

type CapturedMethod = Readonly<{
  owner: object;
  key: string;
  descriptor: CapturedDescriptor;
  method: (...args: never[]) => unknown;
}>;

type NavigationIntrinsics = Readonly<{
  view: Window & typeof globalThis;
  objectConstructor: ObjectConstructor;
  reflectObject: typeof Reflect;
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor;
  getPrototypeOf: typeof Object.getPrototypeOf;
  reflectApply: typeof Reflect.apply;
  eventConstructor: typeof Event;
  eventPrototype: Event;
  uiEventConstructor: typeof UIEvent;
  uiEventPrototype: UIEvent;
  keyboardEventConstructor: typeof KeyboardEvent;
  keyboardEventPrototype: KeyboardEvent;
  documentConstructor: typeof Document;
  documentPrototype: Document;
  htmlElementConstructor: typeof HTMLElement;
  htmlElementPrototype: HTMLElement;
  eventGetters: Readonly<{
    type: CapturedGetter;
    bubbles: CapturedGetter;
    cancelable: CapturedGetter;
    defaultPrevented: CapturedGetter;
    cancelBubble: CapturedGetter;
    target: CapturedGetter;
  }>;
  keyboardGetters: Readonly<{
    key: CapturedGetter;
    repeat: CapturedGetter;
    altKey: CapturedGetter;
    ctrlKey: CapturedGetter;
    metaKey: CapturedGetter;
    shiftKey: CapturedGetter;
    isComposing: CapturedGetter;
  }>;
  viewGetter: CapturedGetter;
  activeElementGetter: CapturedGetter;
  composedPathMethod: CapturedMethod;
  preventDefaultMethod: CapturedMethod;
  focusMethod: CapturedMethod;
  isTrustedDescriptor: CapturedDescriptor;
  isTrustedGetter: NonNullable<PropertyDescriptor["get"]>;
}>;

type NativeKeyboardFacts = Readonly<{
  target: EventTarget;
  path: readonly EventTarget[];
  view: Window;
  type: "keydown";
  bubbles: true;
  cancelable: true;
  key: NavigationKey;
  repeat: false;
  altKey: false;
  ctrlKey: false;
  metaKey: false;
  shiftKey: boolean;
  isComposing: false;
  defaultPrevented: false;
  cancelBubble: false;
  isTrusted: boolean;
}>;

type ReactKeyboardFacts = Readonly<{
  currentTarget: HTMLElement;
  target: EventTarget;
  nativeEvent: KeyboardEvent;
  type: "keydown";
  key: NavigationKey;
  repeat: false;
  altKey: false;
  ctrlKey: false;
  metaKey: false;
  shiftKey: boolean;
  defaultPrevented: false;
  isDefaultPrevented: ReactKeyboardEvent<HTMLElement>["isDefaultPrevented"];
  isPropagationStopped: ReactKeyboardEvent<HTMLElement>["isPropagationStopped"];
}>;

type KeyboardNavigation = Readonly<{
  publication: TocPublication;
  document: Document;
  view: Window;
  reactEvent: ReactKeyboardEvent<HTMLElement>;
  nativeEvent: KeyboardEvent;
  control: HTMLButtonElement | HTMLAnchorElement;
  controlIndex: number;
  destination: HTMLAnchorElement;
  destinationIndex: number;
  activeElement: Element;
  native: NativeKeyboardFacts;
  react: ReactKeyboardFacts;
}>;

type ActionClaim = Readonly<{
  visitOwner: VisitOwner;
  publication: TocPublication;
  action: PublicationAction;
  reactEvent: object;
  nativeEvent: Event;
  navigation: KeyboardNavigation | null;
}>;

type EventClaims = Readonly<{
  react: WeakMap<object, ActionClaim>;
  native: WeakMap<Event, ActionClaim>;
}>;

type TocPublication = PermanentOwner & Readonly<{
  render: TocRender;
  generation: DomGeneration;
  visitOwner: VisitOwner;
  observerOwner: ObserverOwner | null;
  document: Document;
  nav: HTMLElement;
  toggle: HTMLButtonElement;
  list: HTMLOListElement;
  anchors: readonly HTMLAnchorElement[];
  nodeFacts: readonly NodeFact[];
  trackedNodes: ReadonlySet<Node>;
  trackedParents: ReadonlySet<Node>;
  headingIds: ReadonlySet<string>;
  mutationObserver: MutationObserver;
  navigationIntrinsics: NavigationIntrinsics;
  claim: (
    action: Exclude<PublicationAction, "reject-link">,
    reactEvent: object,
    nativeEvent: Event,
    claims: EventClaims,
    navigation?: KeyboardNavigation,
  ) => ActionClaim | null;
  releaseNavigationClaim: (claim: ActionClaim, claims: EventClaims) => void;
}>;

type DisclosureState = Readonly<{
  visit: HeadingsVisit;
  open: boolean;
}>;

type HeadingsVisitOwner = Readonly<{
  source: RenderedHeading[];
  fingerprint: string;
  visit: HeadingsVisit;
}>;

const livePublications = new WeakMap<Document, Set<TocPublication>>();
const liveVisitOwners = new WeakMap<Node, Set<VisitOwner>>();

function registerVisitOwner(owner: VisitOwner) {
  let owners = liveVisitOwners.get(owner.placementParent);
  if (!owners) {
    owners = new Set();
    liveVisitOwners.set(owner.placementParent, owners);
  }
  owners.add(owner);
}

function unregisterVisitOwner(owner: VisitOwner) {
  const owners = liveVisitOwners.get(owner.placementParent);
  owners?.delete(owner);
  if (owners?.size === 0) liveVisitOwners.delete(owner.placementParent);
}

function registerPublication(publication: TocPublication) {
  let publications = livePublications.get(publication.document);
  if (!publications) {
    publications = new Set();
    livePublications.set(publication.document, publications);
  }
  publications.add(publication);
}

function unregisterPublication(publication: TocPublication) {
  const publications = livePublications.get(publication.document);
  publications?.delete(publication);
  if (publications?.size === 0) livePublications.delete(publication.document);
}

function createHeadingsVisit(headings: RenderedHeading[]): HeadingsVisit {
  const snapshots = headings.map<HeadingSnapshot>((heading, index) => Object.freeze({
    id: heading.id,
    level: heading.level,
    text: heading.text,
    index,
    href: `#${heading.id}`,
  }));
  return Object.freeze({
    session: Symbol("reader-toc-visit"),
    headings: Object.freeze(snapshots),
  });
}

function useHeadingsVisit(headings: RenderedHeading[]): HeadingsVisit {
  const fingerprint = JSON.stringify(headings.map(({ id, level, text }) => [id, level, text]));
  const [owner, setOwner] = useState<HeadingsVisitOwner>(() => ({
    source: headings,
    fingerprint,
    visit: createHeadingsVisit(headings),
  }));
  if (owner?.source === headings && owner.fingerprint === fingerprint) return owner.visit;
  const next = Object.freeze<HeadingsVisitOwner>({
    source: headings,
    fingerprint,
    visit: createHeadingsVisit(headings),
  });
  setOwner(next);
  return next.visit;
}

function createVisitOwner(
  visit: HeadingsVisit,
  ownerDocument: Document,
  placementParent: Node,
  visitOwnerRef: RefObject<VisitOwner | null>,
  observerOwnerRef: RefObject<ObserverOwner | null>,
): VisitOwner {
  let retired = false;
  const owner: VisitOwner = Object.freeze({
    identity: Symbol("reader-toc-visit-owner"),
    visit,
    document: ownerDocument,
    placementParent,
    isRetired: () => retired,
    retire: () => {
      if (retired) return;
      retired = true;
      const observerOwner = observerOwnerRef.current;
      if (observerOwner?.visitOwner === owner) observerOwner.retire();
      unregisterVisitOwner(owner);
      if (visitOwnerRef.current === owner) visitOwnerRef.current = null;
    },
  });
  return owner;
}

function headingFactsAreExact(owner: ObserverOwner): boolean {
  if (owner.isRetired() || owner.visitOwner.isRetired()) return false;
  const records = owner.mutationObserver?.takeRecords() ?? [];
  if (
    records.some((record) =>
      mutationIsRelevant(record, owner.trackedNodes, owner.trackedParents, owner.headingIds)) ||
    !nodeFactsAreExact(owner.nodeFacts, owner.document)
  ) {
    owner.retire();
    return false;
  }
  for (const fact of owner.headings) {
    const current = owner.document.getElementById(fact.heading.id);
    if (current !== fact.element) {
      owner.retire();
      return false;
    }
    if (
      fact.element &&
      (!fact.element.isConnected ||
        fact.element.ownerDocument !== owner.document ||
        fact.element.id !== fact.heading.id)
    ) {
      owner.retire();
      return false;
    }
  }
  return true;
}

function useActiveHeading(
  visit: HeadingsVisit,
  visitOwnerRef: RefObject<VisitOwner | null>,
  observerOwnerRef: RefObject<ObserverOwner | null>,
): ActiveHeading | null {
  const [activeHeading, setActiveHeading] = useState<ActiveHeading | null>(null);

  useEffect(() => {
    const visitOwner = visitOwnerRef.current;
    if (!visitOwner || visitOwner.visit !== visit || visitOwner.isRetired()) return;

    const ownerDocument = visitOwner.document;
    const headingFacts = Object.freeze(visit.headings.map((heading) => Object.freeze({
      heading,
      element: ownerDocument.getElementById(heading.id),
    })));
    const elements = headingFacts.flatMap((fact) => fact.element ? [fact.element] : []);
    const nodeFacts = captureNodeFacts(elements);
    const trackedNodes = new Set(nodeFacts.map((fact) => fact.node));
    const trackedParents = new Set(elements.flatMap((element) =>
      element.parentNode ? [element.parentNode] : []));
    const headingIds = new Set(headingFacts.map((fact) => fact.heading.id));
    const visible = new Set<string>();
    let retired = false;
    let observer: IntersectionObserver | null = null;
    let mutationObserver: MutationObserver | null = null;

    const hasAuthority = () =>
      !retired &&
      !visitOwner.isRetired() &&
      visitOwnerRef.current === visitOwner &&
      observerOwnerRef.current === owner;
    const isCurrent = () =>
      hasAuthority() && headingFactsAreExact(owner);
    const retire = () => {
      if (retired) return;
      retired = true;
      observer?.disconnect();
      mutationObserver?.disconnect();
      mutationObserver?.takeRecords();
      if (observerOwnerRef.current === owner) observerOwnerRef.current = null;
      setActiveHeading((current) => current?.owner === owner ? null : current);
    };
    const publish = (id: string | null) => {
      if (!isCurrent()) return;
      setActiveHeading((current) => {
        if (!isCurrent()) return current;
        if (current?.owner === owner && current.id === id) return current;
        return Object.freeze({ owner, id });
      });
    };
    const pick = () => {
      if (!isCurrent()) return;

      // Prefer the topmost heading on screen; with none on screen, keep the last one scrolled past.
      let best: { id: string; top: number } | null = null;
      let lastAbove: string | null = null;
      for (const element of elements) {
        const top = element.getBoundingClientRect().top;
        if (visible.has(element.id) && (!best || top < best.top)) best = { id: element.id, top };
        if (top < TOP_OFFSET) lastAbove = element.id;
      }
      if (!isCurrent()) return;
      publish(best?.id ?? lastAbove ?? elements[0]?.id ?? null);
    };

    const Observer = ownerDocument.defaultView?.IntersectionObserver;
    if (Observer) {
      observer = new Observer(
        (entries) => {
          if (!isCurrent()) return;
          for (const entry of entries) {
            const fact = headingFacts.find((candidate) => candidate.element === entry.target);
            if (!fact || entry.target.ownerDocument !== ownerDocument || entry.target.id !== fact.heading.id) {
              retire();
              return;
            }
          }
          for (const entry of entries) {
            if (entry.isIntersecting) visible.add(entry.target.id);
            else visible.delete(entry.target.id);
          }
          pick();
        },
        { rootMargin: `-${TOP_OFFSET}px 0px -55% 0px`, threshold: [0, 1] },
      );
    }
    const MutationObserverConstructor = ownerDocument.defaultView?.MutationObserver;
    if (MutationObserverConstructor) {
      mutationObserver = new MutationObserverConstructor((records) => {
        if (
          records.some((record) =>
            mutationIsRelevant(record, trackedNodes, trackedParents, headingIds))
        ) {
          owner.retire();
        }
      });
    }

    const owner: ObserverOwner = Object.freeze({
      identity: Symbol("reader-toc-observer-owner"),
      visitOwner,
      document: ownerDocument,
      observer,
      headings: headingFacts,
      nodeFacts,
      trackedNodes,
      trackedParents,
      headingIds,
      mutationObserver,
      hasAuthority,
      isRetired: () => retired,
      retire,
    });
    observerOwnerRef.current?.retire();
    observerOwnerRef.current = owner;
    mutationObserver?.observe(ownerDocument.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
      attributeOldValue: true,
    });
    elements.forEach((element) => observer?.observe(element));
    pick();
    return retire;
  }, [observerOwnerRef, visit, visitOwnerRef]);

  if (
    !activeHeading ||
    !activeHeading.owner.hasAuthority() ||
    activeHeading.owner.visitOwner.visit !== visit ||
    activeHeading.owner.isRetired()
  ) {
    return null;
  }
  return activeHeading;
}

function createDomGeneration(
  render: TocRender,
  generationRef: RefObject<DomGeneration | null>,
  publicationRef: RefObject<TocPublication | null>,
): DomGeneration {
  let retired = false;
  const generation: DomGeneration = Object.freeze({
    identity: Symbol("reader-toc-dom-generation"),
    render,
    isRetired: () => retired,
    retire: () => {
      if (retired) return;
      retired = true;
      const publication = publicationRef.current;
      if (publication?.generation === generation) publication.retire();
      if (generationRef.current === generation) generationRef.current = null;
    },
  });
  return generation;
}

function refCallback<T extends Element>(
  render: TocRender,
  ownerRef: RefObject<ElementOwner<T> | null>,
  generationRef: RefObject<DomGeneration | null>,
  publicationRef: RefObject<TocPublication | null>,
): RefCallback<T> {
  let attachment: ElementOwner<T> | null = null;
  return (element) => {
    if (element) {
      const currentPublication = publicationRef.current;
      if (currentPublication && currentPublication.render !== render && !currentPublication.isRetired()) return;
      let generation = generationRef.current;
      if (!generation || generation.render !== render || generation.isRetired()) {
        if (generation && !generation.isRetired()) generation.retire();
        generation = createDomGeneration(render, generationRef, publicationRef);
        generationRef.current = generation;
      }
      attachment = Object.freeze({ render, generation, element });
      ownerRef.current = attachment;
      return;
    }

    const detached = attachment;
    attachment = null;
    if (!detached) return;
    if (ownerRef.current === detached) ownerRef.current = null;
    detached.generation.retire();
  };
}

function captureAttributes(element: Element): readonly (readonly [string | null, string, string])[] {
  return Object.freeze(
    Array.from(element.attributes)
      .map((attribute) => Object.freeze([
        attribute.namespaceURI,
        attribute.name,
        attribute.value,
      ] as const))
      .sort((left, right) =>
        `${left[0] ?? ""}\u0000${left[1]}`.localeCompare(`${right[0] ?? ""}\u0000${right[1]}`)),
  );
}

function captureNodeFacts(roots: readonly Node[]): readonly NodeFact[] {
  const facts: NodeFact[] = [];
  const seen = new Set<Node>();
  const visit = (node: Node) => {
    if (seen.has(node)) return;
    seen.add(node);
    facts.push(Object.freeze({
      node,
      parent: node.parentNode,
      previous: node.previousSibling,
      next: node.nextSibling,
      nodeType: node.nodeType,
      data: node instanceof CharacterData ? node.data : null,
      attributes: node instanceof Element ? captureAttributes(node) : null,
      children: Object.freeze(Array.from(node.childNodes)),
    }));
    node.childNodes.forEach(visit);
  };
  roots.forEach(visit);
  return Object.freeze(facts);
}

function nodeFactsAreExact(facts: readonly NodeFact[], ownerDocument: Document): boolean {
  for (const fact of facts) {
    const { node } = fact;
    if (
      node.ownerDocument !== ownerDocument ||
      node.nodeType !== fact.nodeType ||
      node.parentNode !== fact.parent ||
      node.previousSibling !== fact.previous ||
      node.nextSibling !== fact.next ||
      (node instanceof CharacterData ? node.data : null) !== fact.data
    ) {
      return false;
    }
    if (node instanceof Element) {
      const attributes = captureAttributes(node);
      if (
        !fact.attributes ||
        attributes.length !== fact.attributes.length ||
        attributes.some((attribute, index) =>
          attribute[0] !== fact.attributes![index][0] ||
          attribute[1] !== fact.attributes![index][1] ||
          attribute[2] !== fact.attributes![index][2])
      ) {
        return false;
      }
    } else if (fact.attributes) {
      return false;
    }
    const children = Array.from(node.childNodes);
    if (
      children.length !== fact.children.length ||
      children.some((child, index) => child !== fact.children[index])
    ) {
      return false;
    }
  }
  return true;
}

function hasExpectedEntryClasses(anchor: HTMLAnchorElement, heading: HeadingSnapshot, active: string | null) {
  const expected = cn(
    ENTRY_CLASS,
    heading.level === 3 ? "pl-5" : "pl-2",
    active === heading.id ? "bg-accent-soft font-medium text-accent" : "text-ink-3 hover:bg-surface-2 hover:text-ink",
  );
  return anchor.className === expected;
}

function captureDescriptor(descriptor: PropertyDescriptor): CapturedDescriptor {
  return Object.freeze({
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    get: descriptor.get,
    set: descriptor.set,
    value: descriptor.value,
    writable: descriptor.writable,
  });
}

function descriptorIsExact(
  descriptor: PropertyDescriptor | undefined,
  captured: CapturedDescriptor,
): boolean {
  return Boolean(
    descriptor &&
    descriptor.configurable === captured.configurable &&
    descriptor.enumerable === captured.enumerable &&
    descriptor.get === captured.get &&
    descriptor.set === captured.set &&
    descriptor.value === captured.value &&
    descriptor.writable === captured.writable
  );
}

function captureGetter(
  owner: object,
  key: string,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
): CapturedGetter | null {
  const descriptor = getOwnPropertyDescriptor(owner, key);
  if (!descriptor || typeof descriptor.get !== "function" || descriptor.value !== undefined) return null;
  return Object.freeze({
    owner,
    key,
    descriptor: captureDescriptor(descriptor),
    getter: descriptor.get,
  });
}

function captureMethod(
  owner: object,
  key: string,
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
): CapturedMethod | null {
  const descriptor = getOwnPropertyDescriptor(owner, key);
  if (!descriptor || typeof descriptor.value !== "function" || descriptor.get !== undefined) return null;
  return Object.freeze({
    owner,
    key,
    descriptor: captureDescriptor(descriptor),
    method: descriptor.value as (...args: never[]) => unknown,
  });
}

function captureNavigationIntrinsics(ownerDocument: Document): NavigationIntrinsics | null {
  const view = ownerDocument.defaultView as (Window & typeof globalThis) | null;
  if (!view) return null;
  try {
    const objectConstructor = view.Object;
    const reflectObject = view.Reflect;
    const getOwnPropertyDescriptor = objectConstructor.getOwnPropertyDescriptor;
    const getPrototypeOf = objectConstructor.getPrototypeOf;
    const reflectApply = reflectObject.apply;
    const eventConstructor = view.Event;
    const uiEventConstructor = view.UIEvent;
    const keyboardEventConstructor = view.KeyboardEvent;
    const documentConstructor = view.Document;
    const htmlElementConstructor = view.HTMLElement;
    const eventPrototype = eventConstructor.prototype;
    const uiEventPrototype = uiEventConstructor.prototype;
    const keyboardEventPrototype = keyboardEventConstructor.prototype;
    const documentPrototype = documentConstructor.prototype;
    const htmlElementPrototype = htmlElementConstructor.prototype;
    const type = captureGetter(eventPrototype, "type", getOwnPropertyDescriptor);
    const bubbles = captureGetter(eventPrototype, "bubbles", getOwnPropertyDescriptor);
    const cancelable = captureGetter(eventPrototype, "cancelable", getOwnPropertyDescriptor);
    const defaultPrevented = captureGetter(eventPrototype, "defaultPrevented", getOwnPropertyDescriptor);
    const cancelBubble = captureGetter(eventPrototype, "cancelBubble", getOwnPropertyDescriptor);
    const target = captureGetter(eventPrototype, "target", getOwnPropertyDescriptor);
    const key = captureGetter(keyboardEventPrototype, "key", getOwnPropertyDescriptor);
    const repeat = captureGetter(keyboardEventPrototype, "repeat", getOwnPropertyDescriptor);
    const altKey = captureGetter(keyboardEventPrototype, "altKey", getOwnPropertyDescriptor);
    const ctrlKey = captureGetter(keyboardEventPrototype, "ctrlKey", getOwnPropertyDescriptor);
    const metaKey = captureGetter(keyboardEventPrototype, "metaKey", getOwnPropertyDescriptor);
    const shiftKey = captureGetter(keyboardEventPrototype, "shiftKey", getOwnPropertyDescriptor);
    const isComposing = captureGetter(keyboardEventPrototype, "isComposing", getOwnPropertyDescriptor);
    const viewGetter = captureGetter(uiEventPrototype, "view", getOwnPropertyDescriptor);
    const activeElementGetter = captureGetter(documentPrototype, "activeElement", getOwnPropertyDescriptor);
    const composedPathMethod = captureMethod(eventPrototype, "composedPath", getOwnPropertyDescriptor);
    const preventDefaultMethod = captureMethod(eventPrototype, "preventDefault", getOwnPropertyDescriptor);
    const focusMethod = captureMethod(htmlElementPrototype, "focus", getOwnPropertyDescriptor);
    const trustProbe = new eventConstructor("reader-toc-intrinsic-probe");
    const isTrusted = getOwnPropertyDescriptor(trustProbe, "isTrusted");
    if (
      !type ||
      !bubbles ||
      !cancelable ||
      !defaultPrevented ||
      !cancelBubble ||
      !target ||
      !key ||
      !repeat ||
      !altKey ||
      !ctrlKey ||
      !metaKey ||
      !shiftKey ||
      !isComposing ||
      !viewGetter ||
      !activeElementGetter ||
      !composedPathMethod ||
      !preventDefaultMethod ||
      !focusMethod ||
      !isTrusted ||
      typeof isTrusted.get !== "function" ||
      isTrusted.configurable !== false
    ) {
      return null;
    }
    return Object.freeze({
      view,
      objectConstructor,
      reflectObject,
      getOwnPropertyDescriptor,
      getPrototypeOf,
      reflectApply,
      eventConstructor,
      eventPrototype,
      uiEventConstructor,
      uiEventPrototype,
      keyboardEventConstructor,
      keyboardEventPrototype,
      documentConstructor,
      documentPrototype,
      htmlElementConstructor,
      htmlElementPrototype,
      eventGetters: Object.freeze({ type, bubbles, cancelable, defaultPrevented, cancelBubble, target }),
      keyboardGetters: Object.freeze({ key, repeat, altKey, ctrlKey, metaKey, shiftKey, isComposing }),
      viewGetter,
      activeElementGetter,
      composedPathMethod,
      preventDefaultMethod,
      focusMethod,
      isTrustedDescriptor: captureDescriptor(isTrusted),
      isTrustedGetter: isTrusted.get,
    });
  } catch {
    return null;
  }
}

function applyIntrinsic<T>(
  intrinsics: NavigationIntrinsics,
  target: (...args: never[]) => unknown,
  receiver: unknown,
  args: readonly unknown[] = [],
): T {
  return intrinsics.reflectApply(target, receiver, args) as T;
}

function capturedPropertyIsExact(
  intrinsics: NavigationIntrinsics,
  captured: CapturedGetter | CapturedMethod,
): boolean {
  const descriptor = applyIntrinsic<PropertyDescriptor | undefined>(
    intrinsics,
    intrinsics.getOwnPropertyDescriptor as (...args: never[]) => unknown,
    intrinsics.objectConstructor,
    [captured.owner, captured.key],
  );
  return descriptorIsExact(descriptor, captured.descriptor);
}

function navigationIntrinsicsAreExact(intrinsics: NavigationIntrinsics): boolean {
  try {
    const getters = [
      ...Object.values(intrinsics.eventGetters),
      ...Object.values(intrinsics.keyboardGetters),
      intrinsics.viewGetter,
      intrinsics.activeElementGetter,
    ];
    const methods = [
      intrinsics.composedPathMethod,
      intrinsics.preventDefaultMethod,
      intrinsics.focusMethod,
    ];
    return (
      intrinsics.view.Object === intrinsics.objectConstructor &&
      intrinsics.view.Reflect === intrinsics.reflectObject &&
      intrinsics.objectConstructor.getOwnPropertyDescriptor === intrinsics.getOwnPropertyDescriptor &&
      intrinsics.objectConstructor.getPrototypeOf === intrinsics.getPrototypeOf &&
      intrinsics.reflectObject.apply === intrinsics.reflectApply &&
      intrinsics.view.Event === intrinsics.eventConstructor &&
      intrinsics.eventConstructor.prototype === intrinsics.eventPrototype &&
      intrinsics.view.UIEvent === intrinsics.uiEventConstructor &&
      intrinsics.uiEventConstructor.prototype === intrinsics.uiEventPrototype &&
      intrinsics.view.KeyboardEvent === intrinsics.keyboardEventConstructor &&
      intrinsics.keyboardEventConstructor.prototype === intrinsics.keyboardEventPrototype &&
      intrinsics.view.Document === intrinsics.documentConstructor &&
      intrinsics.documentConstructor.prototype === intrinsics.documentPrototype &&
      intrinsics.view.HTMLElement === intrinsics.htmlElementConstructor &&
      intrinsics.htmlElementConstructor.prototype === intrinsics.htmlElementPrototype &&
      applyIntrinsic(
        intrinsics,
        intrinsics.getPrototypeOf as (...args: never[]) => unknown,
        intrinsics.objectConstructor,
        [intrinsics.keyboardEventPrototype],
      ) === intrinsics.uiEventPrototype &&
      applyIntrinsic(
        intrinsics,
        intrinsics.getPrototypeOf as (...args: never[]) => unknown,
        intrinsics.objectConstructor,
        [intrinsics.uiEventPrototype],
      ) === intrinsics.eventPrototype &&
      getters.every((getter) => capturedPropertyIsExact(intrinsics, getter)) &&
      methods.every((method) => capturedPropertyIsExact(intrinsics, method))
    );
  } catch {
    return false;
  }
}

function publicationFocusCustodyIsExact(publication: TocPublication): boolean {
  const { navigationIntrinsics: intrinsics } = publication;
  try {
    if (!navigationIntrinsicsAreExact(intrinsics)) return false;
    const hasOwnFocus = [publication.toggle, ...publication.anchors].some((control) =>
      applyIntrinsic<PropertyDescriptor | undefined>(
        intrinsics,
        intrinsics.getOwnPropertyDescriptor as (...args: never[]) => unknown,
        intrinsics.objectConstructor,
        [control, "focus"],
      ) !== undefined);
    const hasOwnActiveElement = applyIntrinsic<PropertyDescriptor | undefined>(
      intrinsics,
      intrinsics.getOwnPropertyDescriptor as (...args: never[]) => unknown,
      intrinsics.objectConstructor,
      [publication.document, "activeElement"],
    ) !== undefined;
    return !hasOwnFocus && !hasOwnActiveElement;
  } catch {
    return false;
  }
}

function publicationTopologyIsExact(publication: TocPublication): boolean {
  const { anchors, document: ownerDocument, list, nav, observerOwner, render, toggle } = publication;
  const { headings } = render.visit;
  const pageHeading = nav.children.item(1);
  const listIcon = toggle.children.item(0);
  const chevronIcon = toggle.children.item(1);
  if (
    !nav.isConnected ||
    !toggle.isConnected ||
    !list.isConnected ||
    nav.ownerDocument !== ownerDocument ||
    toggle.ownerDocument !== ownerDocument ||
    list.ownerDocument !== ownerDocument ||
    nav.tagName !== "NAV" ||
    toggle.tagName !== "BUTTON" ||
    list.tagName !== "OL" ||
    nav.dataset.testid !== "reader-toc" ||
    nav.getAttribute("aria-label") !== "Table of contents" ||
    nav.className !== "reader-toc lg:sticky lg:top-20" ||
    toggle.dataset.testid !== "reader-toc-toggle" ||
    toggle.type !== "button" ||
    toggle.disabled ||
    toggle.getAttribute("aria-disabled") !== null ||
    toggle.getAttribute("aria-controls") !== "reader-toc-list" ||
    toggle.getAttribute("aria-expanded") !== String(render.open) ||
    toggle.className !== TOGGLE_CLASS ||
    toggle.childNodes.length !== 3 ||
    listIcon?.tagName.toLowerCase() !== "svg" ||
    !listIcon.classList.contains("lucide-list") ||
    toggle.childNodes.item(1)?.textContent !== "Contents" ||
    chevronIcon?.tagName.toLowerCase() !== "svg" ||
    !chevronIcon.classList.contains("lucide-chevron-down") ||
    !chevronIcon.classList.contains("ml-auto") ||
    chevronIcon.classList.contains("rotate-180") !== render.open ||
    pageHeading?.tagName !== "DIV" ||
    pageHeading.className !== PAGE_HEADING_CLASS ||
    pageHeading.textContent !== "On this page" ||
    list.id !== "reader-toc-list" ||
    nav.children.length !== 3 ||
    nav.children.item(0) !== toggle ||
    nav.children.item(2) !== list ||
    toggle.parentElement !== nav ||
    list.parentElement !== nav ||
    list.children.length !== headings.length ||
    anchors.length !== headings.length ||
    list.classList.contains(render.open ? "hidden" : "flex") ||
    !list.classList.contains(render.open ? "flex" : "hidden") ||
    (observerOwner !== null && observerOwner.document !== ownerDocument)
  ) {
    return false;
  }

  for (const heading of headings) {
    const item = list.children.item(heading.index);
    const anchor = anchors[heading.index];
    if (
      !item ||
      !anchor ||
      !item.isConnected ||
      !anchor.isConnected ||
      item.ownerDocument !== ownerDocument ||
      anchor.ownerDocument !== ownerDocument ||
      item.tagName !== "LI" ||
      anchor.tagName !== "A" ||
      item.attributes.length !== 0 ||
      item.children.length !== 1 ||
      item.children.item(0) !== anchor ||
      anchor.parentElement !== item ||
      anchor.dataset.testid !== "reader-toc-entry" ||
      anchor.getAttribute("href") !== heading.href ||
      anchor.getAttribute("aria-disabled") !== null ||
      anchor.textContent !== heading.text ||
      anchor.getAttribute("aria-current") !== (render.active === heading.id ? "location" : null) ||
      !hasExpectedEntryClasses(anchor, heading, render.active)
    ) {
      return false;
    }
  }
  return true;
}

function mutationContainsTrackedNode(node: Node, trackedNodes: ReadonlySet<Node>): boolean {
  if (trackedNodes.has(node)) return true;
  for (const tracked of trackedNodes) {
    if (node.contains(tracked)) return true;
  }
  return false;
}

function mutationAddsHeading(node: Node, headingIds: ReadonlySet<string>): boolean {
  if (headingIds.size === 0 || !(node instanceof Element)) return false;
  if (node.id && headingIds.has(node.id)) return true;
  return Array.from(node.querySelectorAll<HTMLElement>("[id]"))
    .some((element) => headingIds.has(element.id));
}

function mutationIsRelevant(
  record: MutationRecord,
  trackedNodes: ReadonlySet<Node>,
  trackedParents: ReadonlySet<Node>,
  headingIds: ReadonlySet<string>,
): boolean {
  if (trackedNodes.has(record.target) || trackedParents.has(record.target)) return true;
  if (
    record.type === "attributes" &&
    record.attributeName === "id" &&
    record.target instanceof Element &&
    (headingIds.has(record.target.id) ||
      (record.oldValue !== null && headingIds.has(record.oldValue)))
  ) {
    return true;
  }
  if (record.type !== "childList") return false;
  return [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some((node) =>
    mutationContainsTrackedNode(node, trackedNodes) ||
    mutationAddsHeading(node, headingIds));
}

function publicationHasCurrentRefs(
  publication: TocPublication,
  navOwnerRef: RefObject<ElementOwner<HTMLElement> | null>,
  toggleOwnerRef: RefObject<ElementOwner<HTMLButtonElement> | null>,
  listOwnerRef: RefObject<ElementOwner<HTMLOListElement> | null>,
  anchorOwnersRef: RefObject<Array<ElementOwner<HTMLAnchorElement> | null>>,
): boolean {
  const { anchors, generation, list, nav, render, toggle } = publication;
  return (
    navOwnerRef.current?.render === render &&
    navOwnerRef.current.generation === generation &&
    navOwnerRef.current.element === nav &&
    toggleOwnerRef.current?.render === render &&
    toggleOwnerRef.current.generation === generation &&
    toggleOwnerRef.current.element === toggle &&
    listOwnerRef.current?.render === render &&
    listOwnerRef.current.generation === generation &&
    listOwnerRef.current.element === list &&
    anchors.every((anchor, index) => {
      const owner = anchorOwnersRef.current[index];
      return owner?.render === render && owner.generation === generation && owner.element === anchor;
    })
  );
}

function publicationIsExact(
  publication: TocPublication,
  publicationRef: RefObject<TocPublication | null>,
  visitOwnerRef: RefObject<VisitOwner | null>,
  observerOwnerRef: RefObject<ObserverOwner | null>,
  navOwnerRef: RefObject<ElementOwner<HTMLElement> | null>,
  toggleOwnerRef: RefObject<ElementOwner<HTMLButtonElement> | null>,
  listOwnerRef: RefObject<ElementOwner<HTMLOListElement> | null>,
  anchorOwnersRef: RefObject<Array<ElementOwner<HTMLAnchorElement> | null>>,
): boolean {
  if (publication.isRetired()) return false;
  const records = publication.mutationObserver.takeRecords();
  if (records.some((record) =>
    mutationIsRelevant(record, publication.trackedNodes, publication.trackedParents, publication.headingIds))
  ) {
    publication.retire();
    return false;
  }
  if (
    publicationRef.current !== publication ||
    publication.generation.isRetired() ||
    publication.visitOwner.isRetired() ||
    publication.observerOwner?.isRetired() ||
    visitOwnerRef.current !== publication.visitOwner ||
    observerOwnerRef.current !== publication.observerOwner ||
    publication.visitOwner.visit !== publication.render.visit ||
    (publication.observerOwner !== null &&
      (publication.observerOwner.visitOwner !== publication.visitOwner ||
        !headingFactsAreExact(publication.observerOwner))) ||
    !publicationHasCurrentRefs(publication, navOwnerRef, toggleOwnerRef, listOwnerRef, anchorOwnersRef) ||
    !publicationTopologyIsExact(publication) ||
    !nodeFactsAreExact(publication.nodeFacts, publication.document)
  ) {
    publication.retire();
    return false;
  }
  return true;
}

function createPublication(
  render: TocRender,
  generation: DomGeneration,
  visitOwner: VisitOwner,
  observerOwner: ObserverOwner | null,
  nav: HTMLElement,
  toggle: HTMLButtonElement,
  list: HTMLOListElement,
  anchors: readonly HTMLAnchorElement[],
  publicationRef: RefObject<TocPublication | null>,
): TocPublication | null {
  const ownerDocument = nav.ownerDocument;
  const MutationObserverConstructor = ownerDocument.defaultView?.MutationObserver;
  const navigationIntrinsics = captureNavigationIntrinsics(ownerDocument);
  if (
    !MutationObserverConstructor ||
    !navigationIntrinsics ||
    (observerOwner && observerOwner.document !== ownerDocument)
  ) {
    return null;
  }

  const headingRoots = observerOwner
    ? observerOwner.headings.flatMap((fact) => fact.element ? [fact.element] : [])
    : render.visit.headings.flatMap((heading) => {
        const element = ownerDocument.getElementById(heading.id);
        return element ? [element] : [];
      });
  const nodeFacts = captureNodeFacts([nav, ...headingRoots]);
  const trackedNodes = new Set(nodeFacts.map((fact) => fact.node));
  const trackedParents = new Set(
    [nav, ...headingRoots].flatMap((root) => root.parentNode ? [root.parentNode] : []),
  );
  const headingIds = new Set(render.visit.headings.map((heading) => heading.id));
  let retired = false;
  let stateActionClaimed = false;
  const mutationObserver = new MutationObserverConstructor((records) => {
    if (
      records.some((record) =>
        mutationIsRelevant(record, trackedNodes, trackedParents, headingIds))
    ) {
      publication.retire();
    }
  });
  const retire = () => {
    if (retired) return;
    retired = true;
    mutationObserver.disconnect();
    mutationObserver.takeRecords();
    unregisterPublication(publication);
    if (publicationRef.current === publication) publicationRef.current = null;
  };
  const claim: TocPublication["claim"] = (action, reactEvent, nativeEvent, claims, navigation) => {
    if (
      retired ||
      (action !== "navigate" && stateActionClaimed) ||
      (action === "navigate") !== Boolean(navigation) ||
      (navigation && (
        navigation.publication !== publication ||
        navigation.reactEvent !== reactEvent ||
        navigation.nativeEvent !== nativeEvent ||
        navigation.document !== ownerDocument ||
        navigation.view !== navigationIntrinsics.view
      )) ||
      claims.react.has(reactEvent) ||
      claims.native.has(nativeEvent)
    ) {
      return null;
    }
    const next = Object.freeze<ActionClaim>({
      visitOwner,
      publication,
      action,
      reactEvent,
      nativeEvent,
      navigation: navigation ?? null,
    });
    if (action !== "navigate") stateActionClaimed = true;
    claims.react.set(reactEvent, next);
    claims.native.set(nativeEvent, next);
    return next;
  };
  const releaseNavigationClaim: TocPublication["releaseNavigationClaim"] = (claim, claims) => {
    if (
      claim.publication !== publication ||
      claim.action !== "navigate" ||
      claim.navigation?.publication !== publication ||
      claims.react.get(claim.reactEvent) !== claim ||
      claims.native.get(claim.nativeEvent) !== claim
    ) {
      return;
    }
    claims.react.delete(claim.reactEvent);
    claims.native.delete(claim.nativeEvent);
  };
  const publication: TocPublication = Object.freeze({
    identity: Symbol("reader-toc-publication"),
    render,
    generation,
    visitOwner,
    observerOwner,
    document: ownerDocument,
    nav,
    toggle,
    list,
    anchors: Object.freeze([...anchors]),
    nodeFacts,
    trackedNodes,
    trackedParents,
    headingIds,
    mutationObserver,
    navigationIntrinsics,
    isRetired: () => retired,
    retire,
    claim,
    releaseNavigationClaim,
  });
  if (
    !publicationTopologyIsExact(publication) ||
    !publicationFocusCustodyIsExact(publication) ||
    !nodeFactsAreExact(nodeFacts, ownerDocument) ||
    (observerOwner !== null && !headingFactsAreExact(observerOwner))
  ) {
    retire();
    return null;
  }
  mutationObserver.observe(ownerDocument.documentElement, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
    attributeOldValue: true,
  });
  return publication;
}

function readNativeEvent(
  nativeEvent: Event,
  ownerDocument: Document,
): Readonly<{ target: EventTarget | null; path: readonly EventTarget[]; view: Window | null }> | null {
  const view = ownerDocument.defaultView;
  if (
    !view ||
    !view.Event.prototype.isPrototypeOf(nativeEvent) ||
    !view.UIEvent.prototype.isPrototypeOf(nativeEvent)
  ) {
    return null;
  }
  return Object.freeze({
    target: Object.getOwnPropertyDescriptor(view.Event.prototype, "target")!.get!.call(nativeEvent) as EventTarget | null,
    path: Object.freeze(view.Event.prototype.composedPath.call(nativeEvent)),
    view: Object.getOwnPropertyDescriptor(view.UIEvent.prototype, "view")!.get!.call(nativeEvent) as Window | null,
  });
}

function nativePathIsExact(
  path: readonly EventTarget[],
  target: EventTarget,
  currentTarget: Element,
  ownerDocument: Document,
): boolean {
  const NodeConstructor = ownerDocument.defaultView?.Node;
  if (
    !NodeConstructor ||
    !(target instanceof NodeConstructor) ||
    target.ownerDocument !== ownerDocument ||
    path[0] !== target
  ) {
    return false;
  }
  let node: Node | null = target;
  let index = 0;
  let containsCurrentTarget = false;
  while (node) {
    if (path[index] !== node) return false;
    if (node === currentTarget) containsCurrentTarget = true;
    index += 1;
    if (node === ownerDocument) break;
    node = node.parentNode;
  }
  return (
    node === ownerDocument &&
    containsCurrentTarget &&
    (path[index] as Window | undefined)?.document === ownerDocument &&
    index === path.length - 1
  );
}

function isPrimaryClick(
  event: ReactMouseEvent<HTMLElement>,
  currentTarget: HTMLElement,
  publication: TocPublication,
): event is ReactMouseEvent<HTMLElement> & { nativeEvent: MouseEvent } {
  const view = publication.document.defaultView;
  if (
    !view ||
    event.type !== "click" ||
    event.currentTarget !== currentTarget ||
    currentTarget.ownerDocument !== publication.document ||
    !view.MouseEvent.prototype.isPrototypeOf(event.nativeEvent)
  ) {
    return false;
  }
  const native = readNativeEvent(event.nativeEvent, publication.document);
  if (!native || native.target !== event.target || (native.view !== null && native.view !== view)) return false;
  const button = Object.getOwnPropertyDescriptor(view.MouseEvent.prototype, "button")!.get!.call(event.nativeEvent);
  const type = Object.getOwnPropertyDescriptor(view.Event.prototype, "type")!.get!.call(event.nativeEvent);
  const bubbles = Object.getOwnPropertyDescriptor(view.Event.prototype, "bubbles")!.get!.call(event.nativeEvent);
  const cancelable = Object.getOwnPropertyDescriptor(view.Event.prototype, "cancelable")!.get!.call(event.nativeEvent);
  return (
    type === "click" &&
    button === 0 &&
    bubbles === true &&
    cancelable === true &&
    native.target !== null &&
    nativePathIsExact(native.path, native.target, currentTarget, publication.document)
  );
}

function isEscapeKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  publication: TocPublication,
): boolean {
  const view = publication.document.defaultView;
  if (
    !view ||
    event.type !== "keydown" ||
    event.key !== "Escape" ||
    event.currentTarget !== publication.nav ||
    !view.KeyboardEvent.prototype.isPrototypeOf(event.nativeEvent)
  ) {
    return false;
  }
  const native = readNativeEvent(event.nativeEvent, publication.document);
  if (!native || native.target !== event.target || (native.view !== null && native.view !== view)) return false;
  const key = Object.getOwnPropertyDescriptor(view.KeyboardEvent.prototype, "key")!.get!.call(event.nativeEvent);
  const repeat = Object.getOwnPropertyDescriptor(view.KeyboardEvent.prototype, "repeat")!.get!.call(event.nativeEvent);
  const type = Object.getOwnPropertyDescriptor(view.Event.prototype, "type")!.get!.call(event.nativeEvent);
  const bubbles = Object.getOwnPropertyDescriptor(view.Event.prototype, "bubbles")!.get!.call(event.nativeEvent);
  const cancelable = Object.getOwnPropertyDescriptor(view.Event.prototype, "cancelable")!.get!.call(event.nativeEvent);
  return (
    type === "keydown" &&
    key === "Escape" &&
    repeat === false &&
    bubbles === true &&
    cancelable === true &&
    native.target !== null &&
    nativePathIsExact(native.path, native.target, publication.nav, publication.document)
  );
}

function isNavigationKey(key: string): key is NavigationKey {
  return key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End";
}

function readNativeKeyboardFacts(
  nativeEvent: KeyboardEvent,
  publication: TocPublication,
): NativeKeyboardFacts | null {
  const intrinsics = publication.navigationIntrinsics;
  if (!navigationIntrinsicsAreExact(intrinsics)) {
    publication.retire();
    return null;
  }
  try {
    const eventPrototype = applyIntrinsic(
      intrinsics,
      intrinsics.getPrototypeOf as (...args: never[]) => unknown,
      intrinsics.objectConstructor,
      [nativeEvent],
    );
    const isTrustedDescriptor = applyIntrinsic<PropertyDescriptor | undefined>(
      intrinsics,
      intrinsics.getOwnPropertyDescriptor as (...args: never[]) => unknown,
      intrinsics.objectConstructor,
      [nativeEvent, "isTrusted"],
    );
    if (
      eventPrototype !== intrinsics.keyboardEventPrototype ||
      !descriptorIsExact(isTrustedDescriptor, intrinsics.isTrustedDescriptor)
    ) {
      return null;
    }

    const read = (captured: CapturedGetter) =>
      applyIntrinsic<unknown>(intrinsics, captured.getter, nativeEvent);
    const target = read(intrinsics.eventGetters.target);
    const path = applyIntrinsic<unknown>(
      intrinsics,
      intrinsics.composedPathMethod.method,
      nativeEvent,
    );
    const eventView = read(intrinsics.viewGetter);
    const type = read(intrinsics.eventGetters.type);
    const bubbles = read(intrinsics.eventGetters.bubbles);
    const cancelable = read(intrinsics.eventGetters.cancelable);
    const defaultPrevented = read(intrinsics.eventGetters.defaultPrevented);
    const cancelBubble = read(intrinsics.eventGetters.cancelBubble);
    const key = read(intrinsics.keyboardGetters.key);
    const repeat = read(intrinsics.keyboardGetters.repeat);
    const altKey = read(intrinsics.keyboardGetters.altKey);
    const ctrlKey = read(intrinsics.keyboardGetters.ctrlKey);
    const metaKey = read(intrinsics.keyboardGetters.metaKey);
    const shiftKey = read(intrinsics.keyboardGetters.shiftKey);
    const isComposing = read(intrinsics.keyboardGetters.isComposing);
    const isTrusted = applyIntrinsic<unknown>(
      intrinsics,
      intrinsics.isTrustedGetter,
      nativeEvent,
    );
    if (
      !navigationIntrinsicsAreExact(intrinsics) ||
      target === null ||
      (typeof target !== "object" && typeof target !== "function") ||
      !Array.isArray(path) ||
      eventView !== intrinsics.view ||
      type !== "keydown" ||
      bubbles !== true ||
      cancelable !== true ||
      defaultPrevented !== false ||
      cancelBubble !== false ||
      typeof key !== "string" ||
      !isNavigationKey(key) ||
      repeat !== false ||
      altKey !== false ||
      ctrlKey !== false ||
      metaKey !== false ||
      typeof shiftKey !== "boolean" ||
      isComposing !== false ||
      typeof isTrusted !== "boolean"
    ) {
      return null;
    }
    return Object.freeze({
      target: target as EventTarget,
      path: Object.freeze([...path]) as readonly EventTarget[],
      view: intrinsics.view,
      type,
      bubbles,
      cancelable,
      key,
      repeat,
      altKey,
      ctrlKey,
      metaKey,
      shiftKey,
      isComposing,
      defaultPrevented,
      cancelBubble,
      isTrusted,
    });
  } catch {
    return null;
  }
}

function readReactKeyboardFacts(
  event: ReactKeyboardEvent<HTMLElement>,
  expectedNativeEvent: KeyboardEvent,
  native: NativeKeyboardFacts,
  publication: TocPublication,
): ReactKeyboardFacts | null {
  const intrinsics = publication.navigationIntrinsics;
  try {
    const currentTarget = event.currentTarget;
    const target = event.target;
    const nativeEvent = event.nativeEvent;
    const type = event.type;
    const key = event.key;
    const repeat = event.repeat;
    const altKey = event.altKey;
    const ctrlKey = event.ctrlKey;
    const metaKey = event.metaKey;
    const shiftKey = event.shiftKey;
    const defaultPrevented = event.defaultPrevented;
    const isDefaultPrevented = event.isDefaultPrevented;
    const isPropagationStopped = event.isPropagationStopped;
    if (
      currentTarget !== publication.nav ||
      target !== native.target ||
      nativeEvent !== expectedNativeEvent ||
      type !== native.type ||
      key !== native.key ||
      repeat !== native.repeat ||
      altKey !== native.altKey ||
      ctrlKey !== native.ctrlKey ||
      metaKey !== native.metaKey ||
      shiftKey !== native.shiftKey ||
      defaultPrevented !== native.defaultPrevented ||
      typeof isDefaultPrevented !== "function" ||
      typeof isPropagationStopped !== "function" ||
      applyIntrinsic<boolean>(
        intrinsics,
        isDefaultPrevented as (...args: never[]) => unknown,
        event,
      ) ||
      applyIntrinsic<boolean>(
        intrinsics,
        isPropagationStopped as (...args: never[]) => unknown,
        event,
      )
    ) {
      return null;
    }
    return Object.freeze({
      currentTarget,
      target,
      nativeEvent,
      type,
      key,
      repeat,
      altKey,
      ctrlKey,
      metaKey,
      shiftKey,
      defaultPrevented,
      isDefaultPrevented,
      isPropagationStopped,
    });
  } catch {
    return null;
  }
}

function readActiveElement(publication: TocPublication): Element | null {
  const intrinsics = publication.navigationIntrinsics;
  try {
    if (!navigationIntrinsicsAreExact(intrinsics)) {
      publication.retire();
      return null;
    }
    const activeElement = applyIntrinsic<unknown>(
      intrinsics,
      intrinsics.activeElementGetter.getter,
      publication.document,
    );
    if (!navigationIntrinsicsAreExact(intrinsics)) {
      publication.retire();
      return null;
    }
    return activeElement instanceof intrinsics.view.Element ? activeElement : null;
  } catch {
    return null;
  }
}

function navigationDestinationIndex(
  publication: TocPublication,
  controlIndex: number,
  key: NavigationKey,
): number {
  const lastIndex = publication.anchors.length - 1;
  if (key === "Home") return 0;
  if (key === "End") return lastIndex;
  if (controlIndex < 0) {
    const activeIndex = publication.render.visit.headings.findIndex(
      (heading) => heading.id === publication.render.active,
    );
    return activeIndex >= 0 ? activeIndex : key === "ArrowDown" ? 0 : lastIndex;
  }
  return key === "ArrowDown"
    ? (controlIndex + 1) % publication.anchors.length
    : (controlIndex - 1 + publication.anchors.length) % publication.anchors.length;
}

function readKeyboardNavigation(
  event: ReactKeyboardEvent<HTMLElement>,
  publication: TocPublication,
): KeyboardNavigation | null {
  const ownerDocument = publication.document;
  const view = publication.navigationIntrinsics.view;
  let nativeEvent: KeyboardEvent;
  try {
    nativeEvent = event.nativeEvent;
  } catch {
    return null;
  }
  if (
    !publication.render.open ||
    publication.nav.ownerDocument !== ownerDocument ||
    !publicationFocusCustodyIsExact(publication)
  ) {
    return null;
  }
  const native = readNativeKeyboardFacts(nativeEvent, publication);
  if (
    !native ||
    !nativePathIsExact(native.path, native.target, publication.nav, ownerDocument)
  ) {
    return null;
  }
  const react = readReactKeyboardFacts(event, nativeEvent, native, publication);
  const activeElement = readActiveElement(publication);
  if (!react || !activeElement) return null;

  const anchorIndex = publication.anchors.findIndex((anchor) => anchor === native.target);
  const control = native.target === publication.toggle
    ? publication.toggle
    : anchorIndex >= 0 ? publication.anchors[anchorIndex] : null;
  if (
    !control ||
    control !== native.target ||
    activeElement !== control ||
    control.ownerDocument !== ownerDocument ||
    (control === publication.toggle && control.disabled)
  ) {
    return null;
  }
  if (anchorIndex >= 0) {
    const heading = publication.render.visit.headings[anchorIndex];
    const anchor = publication.anchors[anchorIndex];
    if (
      !heading ||
      anchor !== control ||
      anchor.getAttribute("aria-disabled") !== null ||
      anchor.getAttribute("href") !== heading.href ||
      anchor.textContent !== heading.text
    ) {
      return null;
    }
  }

  if (publication.anchors.length === 0) return null;
  const destinationIndex = navigationDestinationIndex(publication, anchorIndex, native.key);
  const destination = publication.anchors[destinationIndex];
  if (
    !destination ||
    destination.ownerDocument !== ownerDocument ||
    !destination.isConnected
  ) {
    return null;
  }
  return Object.freeze({
    publication,
    document: ownerDocument,
    view,
    reactEvent: event,
    nativeEvent,
    control,
    controlIndex: anchorIndex,
    destination,
    destinationIndex,
    activeElement,
    native,
    react,
  });
}

function nativeKeyboardFactsAreExact(
  current: NativeKeyboardFacts,
  captured: NativeKeyboardFacts,
): boolean {
  return (
    current.target === captured.target &&
    current.view === captured.view &&
    current.type === captured.type &&
    current.bubbles === captured.bubbles &&
    current.cancelable === captured.cancelable &&
    current.key === captured.key &&
    current.repeat === captured.repeat &&
    current.altKey === captured.altKey &&
    current.ctrlKey === captured.ctrlKey &&
    current.metaKey === captured.metaKey &&
    current.shiftKey === captured.shiftKey &&
    current.isComposing === captured.isComposing &&
    current.defaultPrevented === captured.defaultPrevented &&
    current.cancelBubble === captured.cancelBubble &&
    current.isTrusted === captured.isTrusted &&
    current.path.length === captured.path.length &&
    current.path.every((target, index) => target === captured.path[index])
  );
}

function reactKeyboardFactsAreExact(
  current: ReactKeyboardFacts,
  captured: ReactKeyboardFacts,
): boolean {
  return (
    current.currentTarget === captured.currentTarget &&
    current.target === captured.target &&
    current.nativeEvent === captured.nativeEvent &&
    current.type === captured.type &&
    current.key === captured.key &&
    current.repeat === captured.repeat &&
    current.altKey === captured.altKey &&
    current.ctrlKey === captured.ctrlKey &&
    current.metaKey === captured.metaKey &&
    current.shiftKey === captured.shiftKey &&
    current.defaultPrevented === captured.defaultPrevented &&
    current.isDefaultPrevented === captured.isDefaultPrevented &&
    current.isPropagationStopped === captured.isPropagationStopped
  );
}

function keyboardNavigationIsCurrent(
  event: ReactKeyboardEvent<HTMLElement>,
  publication: TocPublication,
  navigation: KeyboardNavigation,
): boolean {
  if (
    navigation.publication !== publication ||
    navigation.document !== publication.document ||
    navigation.view !== publication.navigationIntrinsics.view ||
    navigation.reactEvent !== event ||
    !publication.render.open ||
    !publicationFocusCustodyIsExact(publication)
  ) {
    return false;
  }
  let nativeEvent: KeyboardEvent;
  try {
    nativeEvent = event.nativeEvent;
  } catch {
    return false;
  }
  if (nativeEvent !== navigation.nativeEvent) return false;
  const native = readNativeKeyboardFacts(nativeEvent, publication);
  if (
    !native ||
    !nativeKeyboardFactsAreExact(native, navigation.native) ||
    !nativePathIsExact(native.path, native.target, publication.nav, publication.document)
  ) {
    return false;
  }
  const react = readReactKeyboardFacts(event, nativeEvent, native, publication);
  const activeElement = readActiveElement(publication);
  if (
    !react ||
    !reactKeyboardFactsAreExact(react, navigation.react) ||
    activeElement !== navigation.activeElement ||
    activeElement !== navigation.control ||
    native.target !== navigation.control ||
    publication.anchors[navigation.destinationIndex] !== navigation.destination ||
    navigationDestinationIndex(publication, navigation.controlIndex, native.key) !== navigation.destinationIndex ||
    (navigation.controlIndex < 0
      ? navigation.control !== publication.toggle
      : publication.anchors[navigation.controlIndex] !== navigation.control)
  ) {
    return false;
  }
  return native.isTrusted === true;
}

function performKeyboardNavigation(navigation: KeyboardNavigation): boolean {
  const intrinsics = navigation.publication.navigationIntrinsics;
  try {
    applyIntrinsic<void>(
      intrinsics,
      intrinsics.preventDefaultMethod.method,
      navigation.nativeEvent,
    );
    applyIntrinsic<void>(
      intrinsics,
      intrinsics.focusMethod.method,
      navigation.destination,
      [{ preventScroll: true }],
    );
    return true;
  } catch {
    return false;
  }
}

function anchorHasSafeFragmentNavigation(anchor: HTMLAnchorElement, owner: VisitOwner): boolean {
  const heading = owner.visit.headings.find((candidate) => candidate.href === anchor.getAttribute("href"));
  if (
    !heading ||
    anchor.ownerDocument !== owner.document ||
    anchor.hasAttribute("target") ||
    anchor.hasAttribute("download") ||
    anchor.hasAttribute("ping") ||
    anchor.hasAttribute("referrerpolicy")
  ) {
    return false;
  }
  return anchor.href === new URL(heading.href, owner.document.URL).href;
}

function claimRejectedAnchor(
  event: ReactMouseEvent<HTMLAnchorElement>,
  publication: TocPublication | null,
  claims: EventClaims,
) {
  const target = event.currentTarget;
  const placementParent = publication?.visitOwner.placementParent;
  const currentPublications = Array.from(livePublications.get(target.ownerDocument) ?? [])
    .filter((candidate) =>
      !candidate.isRetired() && candidate.visitOwner.placementParent === placementParent);
  const currentVisits = Array.from(placementParent ? liveVisitOwners.get(placementParent) ?? [] : [])
    .filter((owner) => !owner.isRetired());
  const claimVisitOwner = currentPublications[0]?.visitOwner ?? publication?.visitOwner;
  if (
    !publication ||
    !claimVisitOwner ||
    !target.isConnected ||
    !isPrimaryClick(event, target, publication) ||
    event.nativeEvent.defaultPrevented ||
    currentPublications.some((current) => current.anchors.includes(target)) ||
    currentVisits.some((owner) => anchorHasSafeFragmentNavigation(target, owner)) ||
    claims.react.has(event) ||
    claims.native.has(event.nativeEvent)
  ) {
    return;
  }
  const claim = Object.freeze<ActionClaim>({
    visitOwner: claimVisitOwner,
    publication,
    action: "reject-link",
    reactEvent: event,
    nativeEvent: event.nativeEvent,
    navigation: null,
  });
  claims.react.set(event, claim);
  claims.native.set(event.nativeEvent, claim);
  event.preventDefault();
}

/** h2/h3 table of contents; sticky on wide screens, a "Contents" disclosure above the article on phones. */
export function ReaderToc({ headings }: { headings: RenderedHeading[] }) {
  const visit = useHeadingsVisit(headings);
  const visitOwnerRef = useRef<VisitOwner | null>(null);
  const observerOwnerRef = useRef<ObserverOwner | null>(null);
  const generationRef = useRef<DomGeneration | null>(null);
  const publicationRef = useRef<TocPublication | null>(null);
  const publicationsByRenderRef = useRef(new WeakMap<TocRender, TocPublication>());
  const navOwnerRef = useRef<ElementOwner<HTMLElement> | null>(null);
  const toggleOwnerRef = useRef<ElementOwner<HTMLButtonElement> | null>(null);
  const listOwnerRef = useRef<ElementOwner<HTMLOListElement> | null>(null);
  const anchorOwnersRef = useRef<Array<ElementOwner<HTMLAnchorElement> | null>>([]);
  const claimsRef = useRef<EventClaims>({
    react: new WeakMap<object, ActionClaim>(),
    native: new WeakMap<Event, ActionClaim>(),
  });
  const [disclosure, setDisclosure] = useState<DisclosureState | null>(null);
  const activeHeading = useActiveHeading(visit, visitOwnerRef, observerOwnerRef);
  const active = activeHeading?.id ?? null;
  const open = disclosure?.visit === visit && disclosure.open;
  const render = Object.freeze<TocRender>({
    identity: Symbol("reader-toc-render"),
    visit,
    open,
    active,
  });

  useLayoutEffect(() => {
    const ownerDocument = navOwnerRef.current?.element.ownerDocument ?? document;
    const placementParent = navOwnerRef.current?.element.parentNode;
    if (!placementParent) return;
    const owner = createVisitOwner(visit, ownerDocument, placementParent, visitOwnerRef, observerOwnerRef);
    visitOwnerRef.current?.retire();
    visitOwnerRef.current = owner;
    registerVisitOwner(owner);
    return owner.retire;
  }, [visit]);

  useLayoutEffect(() => {
    const navOwner = navOwnerRef.current;
    const toggleOwner = toggleOwnerRef.current;
    const listOwner = listOwnerRef.current;
    const anchorOwners = visit.headings.map((heading) => anchorOwnersRef.current[heading.index]);
    const visitOwner = visitOwnerRef.current;
    const observerOwner = observerOwnerRef.current;
    const generation = navOwner?.generation;
    if (
      !navOwner ||
      !toggleOwner ||
      !listOwner ||
      !visitOwner ||
      !generation ||
      generation.isRetired() ||
      visitOwner.isRetired() ||
      visitOwner.visit !== visit ||
      (observerOwner !== null &&
        (observerOwner.isRetired() || observerOwner.visitOwner !== visitOwner)) ||
      navOwner.render !== render ||
      toggleOwner.render !== render ||
      listOwner.render !== render ||
      navOwner.generation !== generation ||
      toggleOwner.generation !== generation ||
      listOwner.generation !== generation ||
      anchorOwners.some((owner) =>
        !owner || owner.render !== render || owner.generation !== generation)
    ) {
      return;
    }

    const publication = createPublication(
      render,
      generation,
      visitOwner,
      observerOwner,
      navOwner.element,
      toggleOwner.element,
      listOwner.element,
      anchorOwners.map((owner) => owner!.element),
      publicationRef,
    );
    if (!publication) return;
    publicationRef.current?.retire();
    publicationRef.current = publication;
    publicationsByRenderRef.current.set(render, publication);
    registerPublication(publication);
    return publication.retire;
  }, [activeHeading, render, visit, visit.headings]);

  const navRef = refCallback(render, navOwnerRef, generationRef, publicationRef);
  const toggleRef = refCallback(render, toggleOwnerRef, generationRef, publicationRef);
  const listRef = refCallback(render, listOwnerRef, generationRef, publicationRef);
  const anchorAttachments = visit.headings.map(() => ({
    owner: null as ElementOwner<HTMLAnchorElement> | null,
  }));

  const exactPublication = () => {
    const publication = publicationRef.current;
    if (
      !publication ||
      publication.render !== render ||
      !publicationIsExact(
        publication,
        publicationRef,
        visitOwnerRef,
        observerOwnerRef,
        navOwnerRef,
        toggleOwnerRef,
        listOwnerRef,
        anchorOwnersRef,
      )
    ) {
      return null;
    }
    return publication;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const publication = exactPublication();
    if (!publication || !publication.render.open) return;

    if (isEscapeKeyDown(event, publication)) {
      if (event.target !== publication.toggle && !publication.anchors.includes(event.target as HTMLAnchorElement)) {
        return;
      }
      const control = event.target;
      if (
        (control === publication.toggle && publication.toggle.disabled) ||
        (control instanceof HTMLAnchorElement &&
          (control.getAttribute("aria-disabled") !== null ||
            control.getAttribute("href") !== publication.render.visit.headings[
              publication.anchors.indexOf(control)
            ]?.href))
      ) {
        return;
      }
      if (!publication.claim("escape", event, event.nativeEvent, claimsRef.current)) return;
      publication.retire();
      event.preventDefault();
      setDisclosure({ visit, open: false });
      publication.toggle.focus();
      return;
    }

    const navigation = readKeyboardNavigation(event, publication);
    if (!navigation) return;
    const navigationIsExact = () =>
      exactPublication() === publication &&
      keyboardNavigationIsCurrent(event, publication, navigation) &&
      exactPublication() === publication;
    if (!navigationIsExact()) return;
    const claim = publication.claim(
      "navigate",
      event,
      navigation.nativeEvent,
      claimsRef.current,
      navigation,
    );
    if (!claim) return;
    if (!navigationIsExact() || !performKeyboardNavigation(navigation)) {
      publication.releaseNavigationClaim(claim, claimsRef.current);
    }
  };

  return (
    <nav
      ref={navRef}
      className="reader-toc lg:sticky lg:top-20"
      aria-label="Table of contents"
      onKeyDown={onKeyDown}
      data-testid="reader-toc"
    >
      <button
        ref={toggleRef}
        type="button"
        className={TOGGLE_CLASS}
        aria-expanded={open}
        aria-controls="reader-toc-list"
        onClick={(event) => {
          const publication = exactPublication();
          if (
            !publication ||
            event.currentTarget !== publication.toggle ||
            !isPrimaryClick(event, publication.toggle, publication)
          ) {
            return;
          }
          if (!publication.claim("toggle", event, event.nativeEvent, claimsRef.current)) return;
          publication.retire();
          setDisclosure({ visit, open: !publication.render.open });
        }}
        data-testid="reader-toc-toggle"
      >
        <List size={15} />
        Contents
        <ChevronDown size={15} className={cn("ml-auto transition-transform", open && "rotate-180")} />
      </button>
      <div className={PAGE_HEADING_CLASS}>On this page</div>
      <ol
        ref={listRef}
        id="reader-toc-list"
        className={cn("reader-toc-list mt-2 flex-col gap-0.5 lg:mt-0 lg:flex", open ? "flex" : "hidden")}
      >
        {visit.headings.map((heading) => (
          <li key={heading.id}>
            {/* The current entry is a soft filled pill (never a bar at the edge — docs/agents.md, UI conventions); h3s indent under their h2. */}
            <a
              ref={(element) => {
                const attachment = anchorAttachments[heading.index];
                if (element) {
                  const currentPublication = publicationRef.current;
                  if (
                    currentPublication &&
                    currentPublication.render !== render &&
                    !currentPublication.isRetired()
                  ) {
                    return;
                  }
                  let generation = generationRef.current;
                  if (!generation || generation.render !== render || generation.isRetired()) {
                    if (generation && !generation.isRetired()) generation.retire();
                    generation = createDomGeneration(render, generationRef, publicationRef);
                    generationRef.current = generation;
                  }
                  const owner = Object.freeze({ render, generation, element });
                  attachment.owner = owner;
                  anchorOwnersRef.current[heading.index] = owner;
                  return;
                }

                const detached = attachment.owner;
                attachment.owner = null;
                if (!detached) return;
                if (anchorOwnersRef.current[heading.index] === detached) {
                  anchorOwnersRef.current[heading.index] = null;
                }
                detached.generation.retire();
              }}
              href={heading.href}
              className={cn(
                ENTRY_CLASS,
                heading.level === 3 ? "pl-5" : "pl-2",
                active === heading.id ? "bg-accent-soft font-medium text-accent" : "text-ink-3 hover:bg-surface-2 hover:text-ink",
              )}
              aria-current={active === heading.id ? "location" : undefined}
              data-testid="reader-toc-entry"
              onClick={(event) => {
                const publication = exactPublication();
                if (
                  !publication ||
                  event.currentTarget !== publication.anchors[heading.index] ||
                  !isPrimaryClick(event, event.currentTarget, publication)
                ) {
                  claimRejectedAnchor(
                    event,
                    publicationsByRenderRef.current.get(render) ?? null,
                    claimsRef.current,
                  );
                  return;
                }
                if (!publication.claim("link", event, event.nativeEvent, claimsRef.current)) return;
                publication.retire();
                setDisclosure({ visit, open: false });
              }}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
