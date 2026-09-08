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

type KeyboardNavigation = Readonly<{
  publication: TocPublication;
  document: Document;
  view: Window;
  nativeEvent: KeyboardEvent;
  control: HTMLButtonElement | HTMLAnchorElement;
  destination: HTMLAnchorElement;
  focus: HTMLAnchorElement["focus"];
  activeElement: Element;
  target: EventTarget;
  path: readonly EventTarget[];
  type: "keydown";
  bubbles: true;
  cancelable: true;
  key: NavigationKey;
  repeat: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  cancelBubble: boolean;
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
  claim: (
    action: Exclude<PublicationAction, "reject-link">,
    reactEvent: object,
    nativeEvent: Event,
    claims: EventClaims,
    navigation?: KeyboardNavigation,
  ) => ActionClaim | null;
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
  if (!MutationObserverConstructor || (observerOwner && observerOwner.document !== ownerDocument)) return null;

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
        navigation.nativeEvent !== nativeEvent ||
        navigation.document !== ownerDocument
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
    isRetired: () => retired,
    retire,
    claim,
  });
  if (
    !publicationTopologyIsExact(publication) ||
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

function readKeyboardNavigation(
  event: ReactKeyboardEvent<HTMLElement>,
  publication: TocPublication,
): KeyboardNavigation | null {
  const ownerDocument = publication.document;
  const view = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  if (
    !view ||
    !publication.render.open ||
    event.currentTarget !== publication.nav ||
    publication.nav.ownerDocument !== ownerDocument ||
    !view.KeyboardEvent.prototype.isPrototypeOf(nativeEvent)
  ) {
    return null;
  }

  const native = readNativeEvent(nativeEvent, ownerDocument);
  if (!native || native.target === null || native.target !== event.target) return null;

  const eventPrototype = view.Event.prototype;
  const keyboardPrototype = view.KeyboardEvent.prototype;
  const type = Object.getOwnPropertyDescriptor(eventPrototype, "type")!.get!.call(nativeEvent) as string;
  const bubbles = Object.getOwnPropertyDescriptor(eventPrototype, "bubbles")!.get!.call(nativeEvent) as boolean;
  const cancelable = Object.getOwnPropertyDescriptor(eventPrototype, "cancelable")!.get!.call(nativeEvent) as boolean;
  const defaultPrevented = Object.getOwnPropertyDescriptor(eventPrototype, "defaultPrevented")!.get!
    .call(nativeEvent) as boolean;
  const cancelBubble = Object.getOwnPropertyDescriptor(eventPrototype, "cancelBubble")!.get!
    .call(nativeEvent) as boolean;
  const key = Object.getOwnPropertyDescriptor(keyboardPrototype, "key")!.get!.call(nativeEvent) as string;
  const repeat = Object.getOwnPropertyDescriptor(keyboardPrototype, "repeat")!.get!.call(nativeEvent) as boolean;
  const altKey = Object.getOwnPropertyDescriptor(keyboardPrototype, "altKey")!.get!.call(nativeEvent) as boolean;
  const ctrlKey = Object.getOwnPropertyDescriptor(keyboardPrototype, "ctrlKey")!.get!.call(nativeEvent) as boolean;
  const metaKey = Object.getOwnPropertyDescriptor(keyboardPrototype, "metaKey")!.get!.call(nativeEvent) as boolean;
  const shiftKey = Object.getOwnPropertyDescriptor(keyboardPrototype, "shiftKey")!.get!.call(nativeEvent) as boolean;
  const isComposing = Object.getOwnPropertyDescriptor(keyboardPrototype, "isComposing")!.get!
    .call(nativeEvent) as boolean;
  const isDefaultPrevented = event.isDefaultPrevented;
  const isPropagationStopped = event.isPropagationStopped;
  if (
    type !== "keydown" ||
    event.type !== type ||
    !isNavigationKey(key) ||
    event.key !== key ||
    event.repeat !== repeat ||
    event.altKey !== altKey ||
    event.ctrlKey !== ctrlKey ||
    event.metaKey !== metaKey ||
    event.shiftKey !== shiftKey ||
    event.defaultPrevented !== defaultPrevented ||
    typeof isDefaultPrevented !== "function" ||
    typeof isPropagationStopped !== "function" ||
    isDefaultPrevented.call(event) ||
    isPropagationStopped.call(event) ||
    repeat ||
    altKey ||
    ctrlKey ||
    metaKey ||
    isComposing ||
    defaultPrevented ||
    cancelBubble ||
    bubbles !== true ||
    cancelable !== true ||
    (native.view !== null && native.view !== view) ||
    !nativePathIsExact(native.path, native.target, publication.nav, ownerDocument)
  ) {
    return null;
  }

  const target = native.target;
  const activeElement = ownerDocument.activeElement;
  const anchorIndex = publication.anchors.findIndex((anchor) => anchor === target);
  const control = target === publication.toggle
    ? publication.toggle
    : anchorIndex >= 0 ? publication.anchors[anchorIndex] : null;
  if (
    !control ||
    control !== target ||
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

  const lastIndex = publication.anchors.length - 1;
  if (lastIndex < 0) return null;
  let destinationIndex: number;
  if (key === "Home") {
    destinationIndex = 0;
  } else if (key === "End") {
    destinationIndex = lastIndex;
  } else if (control === publication.toggle) {
    const activeIndex = publication.render.visit.headings.findIndex(
      (heading) => heading.id === publication.render.active,
    );
    destinationIndex = activeIndex >= 0
      ? activeIndex
      : key === "ArrowDown" ? 0 : lastIndex;
  } else {
    destinationIndex = key === "ArrowDown"
      ? (anchorIndex + 1) % publication.anchors.length
      : (anchorIndex - 1 + publication.anchors.length) % publication.anchors.length;
  }

  const destination = publication.anchors[destinationIndex];
  const focus = view.HTMLElement.prototype.focus;
  if (
    !destination ||
    destination.ownerDocument !== ownerDocument ||
    !destination.isConnected ||
    destination.focus !== focus
  ) {
    return null;
  }
  return Object.freeze({
    publication,
    document: ownerDocument,
    view,
    nativeEvent,
    control,
    destination,
    focus,
    activeElement,
    target: native.target,
    path: native.path,
    type: "keydown",
    bubbles: true,
    cancelable: true,
    key,
    repeat,
    altKey,
    ctrlKey,
    metaKey,
    shiftKey,
    isComposing,
    defaultPrevented,
    cancelBubble,
  });
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
    if (!navigation || exactPublication() !== publication) return;
    if (
      !publication.claim(
        "navigate",
        event,
        event.nativeEvent,
        claimsRef.current,
        navigation,
      )
    ) {
      return;
    }
    event.preventDefault();
    navigation.focus.call(navigation.destination, { preventScroll: true });
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
