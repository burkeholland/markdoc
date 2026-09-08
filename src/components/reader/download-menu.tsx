"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type Dispatch,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from "react";
import { ChevronDown, Download, FileCode2, FileText } from "lucide-react";

type Format = "md" | "html" | "pdf";
type ExportHrefs = Readonly<Record<Format, string>>;

interface DocumentVisit {
  readonly mount: symbol;
  readonly docId: string;
  readonly hrefs: ExportHrefs;
}

interface DisclosureVisit {
  readonly document: DocumentVisit;
}

interface DownloadState {
  readonly document: DocumentVisit;
  readonly disclosure: DisclosureVisit | null;
}

interface PresentationAuthority {
  readonly document: DocumentVisit;
  readonly sourceState: DownloadState;
  readonly state: DownloadState | null;
  readonly disclosure: DisclosureVisit | null;
  readonly open: boolean;
  readonly focusPublished: boolean;
}

interface LinkPublication {
  readonly format: Format;
  readonly href: string;
  readonly capture: (element: HTMLAnchorElement | null) => void;
  readonly element: () => HTMLAnchorElement | null;
  readonly onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
}

interface DownloadPublication {
  readonly authority: PresentationAuthority;
  readonly ownerDocument: Document;
  readonly root: HTMLDivElement;
  readonly primary: HTMLAnchorElement;
  readonly toggle: HTMLButtonElement;
  readonly list: HTMLDivElement;
  readonly linkElements: Readonly<Record<Format, HTMLAnchorElement>>;
  readonly rootTargets: readonly Node[];
  readonly toggleTargets: readonly Node[];
  readonly linkTargets: Readonly<Record<Format, readonly Node[]>>;
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
}

interface DownloadPublicationSet {
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly capturePrimary: (element: HTMLAnchorElement | null) => void;
  readonly captureToggle: (element: HTMLButtonElement | null) => void;
  readonly captureList: (element: HTMLDivElement | null) => void;
  readonly links: Readonly<Record<Format, LinkPublication>>;
  readonly establish: () => void | (() => void);
  readonly onToggleClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onToggleKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  readonly onListKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly onRootKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly onRootBlur: (event: ReactFocusEvent<HTMLDivElement>) => void;
}

class CurrentCell<T> {
  constructor(public current: T) {}
}

interface ElementOwnerView {
  readonly element: () => HTMLElement | null;
}

class ElementOwner<T extends HTMLElement> implements ElementOwnerView {
  private current: T | null = null;
  private lastElement: T | null = null;

  constructor(
    private readonly onChange: (
      owner: ElementOwnerView,
      element: HTMLElement | null,
      previous: HTMLElement | null,
      last: HTMLElement | null,
    ) => void,
  ) {}

  readonly element = () => this.current;
  readonly capture = (element: T | null) => {
    if (this.current === element) return;
    if (
      element &&
      this.lastElement &&
      element !== this.lastElement &&
      !element.isConnected
    ) {
      return;
    }
    const previous = this.current;
    const last = this.lastElement;
    const replaced = element !== null && last !== null && last !== element;
    this.current = element;
    if (element) this.lastElement = element;
    if (replaced || element === null || previous !== element) {
      this.onChange(this, element, previous, last);
    }
  };
}

interface PublicationCells {
  readonly active: CurrentCell<DownloadPublication | null>;
  readonly successorOf: CurrentCell<DownloadPublication | null>;
  readonly replay: CurrentCell<DownloadReplay | null>;
  readonly focused: WeakSet<DisclosureVisit>;
  readonly claimedEvents: WeakSet<Event>;
}

interface DownloadDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly DownloadDomSnapshot[];
}

interface DownloadPlacement {
  readonly document: Document;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface DownloadReplay {
  readonly source: DownloadPublication;
  readonly dom: DownloadDomSnapshot;
  readonly placement: DownloadPlacement;
  readonly unchanged: () => boolean;
  readonly release: () => void;
}

interface RefReplay {
  readonly owner: ElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

interface DownloadPublicationRuntime {
  readonly publication: DownloadPublication;
  readonly publish: (
    snapshot: DownloadDomSnapshot,
    placement: DownloadPlacement,
    owners: readonly ElementOwnerView[],
  ) => void;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: ElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly focusFactsMatch: () => boolean;
  readonly focusDisclosure: () => boolean;
  readonly installPointer: () => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly replayDomUnchanged: () => boolean;
  readonly releaseReplayGuard: () => void;
  readonly snapshot: () => DownloadDomSnapshot | null;
  readonly placement: () => DownloadPlacement | null;
}

const ROWS: { format: Format; label: string; Icon: typeof Download }[] = [
  { format: "md", label: "Markdown", Icon: Download },
  { format: "html", label: "HTML", Icon: FileCode2 },
  { format: "pdf", label: "PDF", Icon: FileText },
];
const FORMATS = ROWS.map(({ format }) => format);
const LIST_ID = "reader-download-list";

function exportHref(docId: string, format: Format) {
  return `/api/documents/${docId}/export?format=${format}&download=1`;
}

function snapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotDownloadDom(node: Node): DownloadDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotDownloadDom)),
  });
}

function downloadDomMatches(snapshot: DownloadDomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
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
        node.childNodes.item(index) === child.node && downloadDomMatches(child),
    )
  );
}

function captureDownloadPlacement(root: HTMLDivElement): DownloadPlacement | null {
  const parent = root.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: root.ownerDocument,
    parent,
    previousSibling: root.previousSibling,
    nextSibling: root.nextSibling,
  });
}

function downloadPlacementMatches(
  root: HTMLDivElement,
  placement: DownloadPlacement,
): boolean {
  return (
    root.ownerDocument === placement.document &&
    root.parentNode === placement.parent &&
    root.previousSibling === placement.previousSibling &&
    root.nextSibling === placement.nextSibling
  );
}

function descendantsOf(element: HTMLElement): readonly Node[] {
  const nodes: Node[] = [];
  const collect = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes) collect(child);
  };
  collect(element);
  return Object.freeze(nodes);
}

function isNodeFromDocument(
  value: EventTarget | null,
  ownerDocument: Document,
): value is Node {
  const NodeConstructor = ownerDocument.defaultView?.Node;
  return Boolean(
    NodeConstructor &&
      value instanceof NodeConstructor &&
      value.ownerDocument === ownerDocument,
  );
}

function isEffectivelyEnabled(element: HTMLElement): boolean {
  if (
    element.matches(":disabled") ||
    element.getAttribute("aria-disabled")?.toLowerCase() === "true"
  ) {
    return false;
  }
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (
      current.hasAttribute("inert") ||
      current.getAttribute("aria-disabled")?.toLowerCase() === "true"
    ) {
      return false;
    }
  }
  return true;
}

function authoritiesMatch(
  previous: PresentationAuthority,
  current: PresentationAuthority,
): boolean {
  return (
    previous.document === current.document &&
    previous.document.mount === current.document.mount &&
    previous.document.docId === current.document.docId &&
    previous.document.hrefs === current.document.hrefs &&
    FORMATS.every(
      (format) =>
        previous.document.hrefs[format] === current.document.hrefs[format],
    ) &&
    previous.sourceState === current.sourceState &&
    previous.state === current.state &&
    previous.disclosure === current.disclosure &&
    previous.open === current.open &&
    previous.focusPublished === current.focusPublished
  );
}

function createDownloadPublication({
  authority,
  cells,
  setState,
  requestSuccessor,
}: {
  authority: PresentationAuthority;
  cells: PublicationCells;
  setState: Dispatch<SetStateAction<DownloadState>>;
  requestSuccessor: () => void;
}): DownloadPublicationSet {
  const mount = authority.document.mount;
  const docId = authority.document.docId;
  const hrefs = authority.document.hrefs;
  const sourceState = authority.sourceState;
  let currentRuntime: DownloadPublicationRuntime | null = null;
  let lastRuntime: DownloadPublicationRuntime | null = null;
  let successorRequested = false;

  const factsAreCurrent = (runtime?: DownloadPublicationRuntime) => {
    const focusFactsMatch = runtime
      ? runtime.focusFactsMatch()
      : authority.disclosure
        ? cells.focused.has(authority.disclosure) === authority.focusPublished
        : !authority.focusPublished;
    return (
      Object.isFrozen(authority) &&
      Object.isFrozen(authority.document) &&
      Object.isFrozen(authority.document.hrefs) &&
      Object.isFrozen(authority.sourceState) &&
      (!authority.disclosure || Object.isFrozen(authority.disclosure)) &&
      authority.document.mount === mount &&
      authority.document.docId === docId &&
      authority.document.hrefs === hrefs &&
      FORMATS.every(
        (format) => hrefs[format] === exportHref(docId, format),
      ) &&
      authority.open === (authority.disclosure !== null) &&
      authority.sourceState === sourceState &&
      authority.state ===
        (sourceState.document === authority.document ? sourceState : null) &&
      (!authority.state ||
        (authority.state.document === authority.document &&
          authority.state.disclosure === authority.disclosure)) &&
      focusFactsMatch
    );
  };

  const requestReplaySuccessor = (runtime: DownloadPublicationRuntime) => {
    const snapshot = runtime.snapshot();
    const placement = runtime.placement();
    if (
      successorRequested ||
      !snapshot ||
      !placement ||
      cells.successorOf.current !== runtime.publication ||
      !factsAreCurrent(runtime) ||
      !exactDomIsCurrent() ||
      !runtime.publishedDomMatches()
    ) {
      return;
    }
    successorRequested = true;
    cells.replay.current = Object.freeze({
      source: runtime.publication,
      dom: snapshot,
      placement,
      unchanged: runtime.replayDomUnchanged,
      release: runtime.releaseReplayGuard,
    });
    requestSuccessor();
  };

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
      cells.successorOf.current === runtime.publication
    ) {
      requestReplaySuccessor(runtime);
    }
  };

  const rootOwner = new ElementOwner<HTMLDivElement>(onElementChange);
  const primaryOwner = new ElementOwner<HTMLAnchorElement>(onElementChange);
  const toggleOwner = new ElementOwner<HTMLButtonElement>(onElementChange);
  const listOwner = new ElementOwner<HTMLDivElement>(onElementChange);
  const linkOwners = new Map<Format, ElementOwner<HTMLAnchorElement>>();

  const exactDomIsCurrent = () => {
    const root = rootOwner.element();
    const primary = primaryOwner.element();
    const toggle = toggleOwner.element();
    const list = listOwner.element();
    if (
      !root ||
      !root.isConnected ||
      root.tagName !== "DIV" ||
      root.className !== "relative flex items-stretch" ||
      !primary ||
      !primary.isConnected ||
      primary.ownerDocument !== root.ownerDocument ||
      primary.tagName !== "A" ||
      primary.parentElement !== root ||
      root.children.item(0) !== primary ||
      root.children.length !== 3 ||
      primary.getAttribute("href") !== authority.document.hrefs.md ||
      primary.getAttribute("aria-label") !== "Download Markdown" ||
      primary.dataset.testid !== "reader-download" ||
      primary.className !==
        "btn btn-sm btn-outline reader-split-main gap-1.5" ||
      !isEffectivelyEnabled(primary) ||
      !toggle ||
      !toggle.isConnected ||
      toggle.ownerDocument !== root.ownerDocument ||
      toggle.tagName !== "BUTTON" ||
      toggle.type !== "button" ||
      toggle.parentElement !== root ||
      root.children.item(1) !== toggle ||
      toggle.className !== "btn btn-sm btn-outline reader-split-more" ||
      toggle.getAttribute("aria-label") !== "Download as…" ||
      toggle.getAttribute("aria-expanded") !== String(authority.open) ||
      toggle.getAttribute("aria-controls") !== LIST_ID ||
      toggle.dataset.testid !== "reader-download-menu" ||
      !isEffectivelyEnabled(toggle) ||
      !list ||
      !list.isConnected ||
      list.ownerDocument !== root.ownerDocument ||
      list.tagName !== "DIV" ||
      list.parentElement !== root ||
      root.children.item(2) !== list ||
      list.id !== LIST_ID ||
      list.className !==
        "menu animate-fade-in absolute right-0 top-full mt-1.5 w-48" ||
      list.hidden === authority.open ||
      list.dataset.testid !== "reader-download-list" ||
      list.children.length !== FORMATS.length
    ) {
      return false;
    }

    return FORMATS.every((format, index) => {
      const link = links[format];
      const element = linkOwners.get(format)?.element();
      return (
        link.format === format &&
        link.href === authority.document.hrefs[format] &&
        !!element &&
        element.isConnected &&
        element.ownerDocument === root.ownerDocument &&
        element.tagName === "A" &&
        element.parentElement === list &&
        list.children.item(index) === element &&
        element.getAttribute("href") === link.href &&
        element.className === "menu-item" &&
        element.dataset.testid === `reader-download-${format}` &&
        element.textContent?.trim() === ROWS[index]?.label &&
        isEffectivelyEnabled(element)
      );
    });
  };

  const ownsIdentity = (publication: DownloadPublication) => {
    const runtime = currentRuntime;
    return (
      !!runtime &&
      runtime.publication === publication &&
      !runtime.isRetired() &&
      cells.active.current === publication &&
      publication.authority === authority &&
      factsAreCurrent(runtime)
    );
  };
  const ownsAuthority = (publication: DownloadPublication) => {
    const runtime = currentRuntime;
    return (
      !!runtime &&
      runtime.publication === publication &&
      ownsIdentity(publication) &&
      exactDomIsCurrent() &&
      runtime.publishedDomMatches()
    );
  };
  const ownsRoot = (
    publication: DownloadPublication,
    element: HTMLDivElement,
  ) =>
    ownsAuthority(publication) &&
    rootOwner.element() === element &&
    publication.root === element &&
    element.isConnected;
  const ownsToggle = (
    publication: DownloadPublication,
    element: HTMLButtonElement,
  ) =>
    ownsAuthority(publication) &&
    toggleOwner.element() === element &&
    publication.toggle === element &&
    element.isConnected &&
    isEffectivelyEnabled(element);
  const ownsList = (
    publication: DownloadPublication,
    element: HTMLDivElement,
  ) =>
    authority.open &&
    ownsAuthority(publication) &&
    listOwner.element() === element &&
    publication.list === element &&
    element.isConnected;
  const ownsLink = (
    publication: DownloadPublication,
    link: LinkPublication,
    element: HTMLAnchorElement,
  ) => {
    const index = FORMATS.indexOf(link.format);
    return (
      authority.open &&
      ownsAuthority(publication) &&
      links[link.format] === link &&
      linkOwners.get(link.format)?.element() === element &&
      publication.linkElements[link.format] === element &&
      element.isConnected &&
      element.parentElement === publication.list &&
      publication.list.children.item(index) === element &&
      element.getAttribute("href") === link.href &&
      isEffectivelyEnabled(element)
    );
  };
  const claimEvent = (event: Event) => {
    if (cells.claimedEvents.has(event)) return false;
    cells.claimedEvents.add(event);
    return true;
  };

  const nativeMouseEvent = <T extends HTMLElement>(
    publication: DownloadPublication,
    event: ReactMouseEvent<T>,
    control: T,
    targets: readonly Node[],
  ): MouseEvent | null => {
    const ownerWindow = publication.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !ownerWindow ||
      event.type !== "click" ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      event.currentTarget !== control ||
      nativeEvent.target !== target ||
      !isNodeFromDocument(target, publication.ownerDocument) ||
      !targets.includes(target) ||
      !isEffectivelyEnabled(control)
    ) {
      return null;
    }
    return nativeEvent;
  };

  const nativeKeyboardEvent = <T extends HTMLElement>(
    publication: DownloadPublication,
    event: ReactKeyboardEvent<T>,
    control: T,
    targets: readonly Node[],
  ): KeyboardEvent | null => {
    const ownerWindow = publication.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !ownerWindow ||
      event.type !== "keydown" ||
      !(nativeEvent instanceof ownerWindow.KeyboardEvent) ||
      nativeEvent.type !== "keydown" ||
      nativeEvent.key !== event.key ||
      nativeEvent.altKey !== event.altKey ||
      nativeEvent.ctrlKey !== event.ctrlKey ||
      nativeEvent.metaKey !== event.metaKey ||
      nativeEvent.shiftKey !== event.shiftKey ||
      event.currentTarget !== control ||
      nativeEvent.target !== target ||
      !isNodeFromDocument(target, publication.ownerDocument) ||
      !targets.includes(target) ||
      !isEffectivelyEnabled(control)
    ) {
      return null;
    }
    return nativeEvent;
  };

  const nativeFocusEvent = (
    publication: DownloadPublication,
    event: ReactFocusEvent<HTMLDivElement>,
  ): FocusEvent | null => {
    const ownerWindow = publication.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !ownerWindow ||
      event.type !== "blur" ||
      !(nativeEvent instanceof ownerWindow.FocusEvent) ||
      (nativeEvent.type !== "focusout" && nativeEvent.type !== "blur") ||
      event.currentTarget !== publication.root ||
      nativeEvent.target !== target ||
      nativeEvent.relatedTarget !== event.relatedTarget ||
      !isNodeFromDocument(target, publication.ownerDocument) ||
      !publication.rootTargets.includes(target)
    ) {
      return null;
    }
    return nativeEvent;
  };

  const commitState = (next: DownloadState) => {
    setState((current) =>
      current === authority.sourceState ? next : current,
    );
  };
  const transition = (
    runtime: DownloadPublicationRuntime,
    disclosure: DisclosureVisit | null,
    refocus: boolean,
  ) => {
    const publication = runtime.publication;
    if (!publication.retire()) return false;
    const ownsSuccession = () =>
      cells.active.current === null &&
      cells.successorOf.current === publication &&
      factsAreCurrent(runtime) &&
      runtime.publishedDomMatches();
    if (!ownsSuccession()) return false;
    if (refocus) {
      const toggle = publication.toggle;
      if (!isEffectivelyEnabled(toggle)) return false;
      toggle.focus();
      if (!ownsSuccession()) return false;
    }
    commitState(
      Object.freeze({
        document: authority.document,
        disclosure,
      }),
    );
    return true;
  };

  const links = Object.fromEntries(
    FORMATS.map((format) => {
      const owner = new ElementOwner<HTMLAnchorElement>(onElementChange);
      linkOwners.set(format, owner);
      const link: LinkPublication = Object.freeze({
        format,
        href: authority.document.hrefs[format],
        capture: owner.capture,
        element: owner.element,
        onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => {
          const runtime = currentRuntime;
          const publication = runtime?.publication;
          const element = event.currentTarget;
          if (
            !runtime ||
            !publication ||
            !ownsLink(publication, link, element)
          ) {
            return;
          }
          const nativeEvent = nativeMouseEvent(
            publication,
            event,
            element,
            publication.linkTargets[format],
          );
          if (!nativeEvent || !claimEvent(nativeEvent)) return;
          transition(runtime, null, true);
        },
      });
      return [format, link];
    }),
  ) as Record<Format, LinkPublication>;

  const onToggleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const toggle = event.currentTarget;
    if (
      !runtime ||
      !publication ||
      !ownsToggle(publication, toggle)
    ) {
      return;
    }
    const nativeEvent = nativeMouseEvent(
      publication,
      event,
      toggle,
      publication.toggleTargets,
    );
    if (!nativeEvent || !claimEvent(nativeEvent)) return;
    transition(
      runtime,
      authority.open
        ? null
        : Object.freeze({ document: authority.document }),
      false,
    );
  };
  const onToggleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const toggle = event.currentTarget;
    if (
      event.key !== "ArrowDown" ||
      !runtime ||
      !publication ||
      !ownsToggle(publication, toggle)
    ) {
      return;
    }
    const nativeEvent = nativeKeyboardEvent(
      publication,
      event,
      toggle,
      publication.toggleTargets,
    );
    if (!nativeEvent || !claimEvent(nativeEvent)) return;
    if (authority.open) {
      event.preventDefault();
      const first = links.md;
      const firstElement = publication.linkElements.md;
      if (ownsLink(publication, first, firstElement)) firstElement.focus();
      return;
    }
    if (
      !transition(
        runtime,
        Object.freeze({ document: authority.document }),
        false,
      )
    ) {
      return;
    }
    event.preventDefault();
  };
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    if (
      !runtime ||
      !publication ||
      !ownsList(publication, event.currentTarget) ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    const current = FORMATS.findIndex(
      (format) => publication.linkElements[format] === event.target,
    );
    if (current < 0) return;
    let next: number;
    if (event.key === "ArrowDown") next = (current + 1) % FORMATS.length;
    else if (event.key === "ArrowUp") next = (current - 1 + FORMATS.length) % FORMATS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = FORMATS.length - 1;
    else return;

    const format = FORMATS[next]!;
    const destination = links[format];
    const element = publication.linkElements[format];
    const nativeEvent = nativeKeyboardEvent(
      publication,
      event,
      event.currentTarget,
      publication.rootTargets,
    );
    if (
      !nativeEvent ||
      !ownsLink(publication, destination, element) ||
      !claimEvent(nativeEvent)
    ) {
      return;
    }
    event.preventDefault();
    if (ownsLink(publication, destination, element)) element.focus();
  };
  const onRootKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    if (
      event.key !== "Escape" ||
      !authority.open ||
      !runtime ||
      !publication ||
      !ownsRoot(publication, event.currentTarget)
    ) {
      return;
    }
    const nativeEvent = nativeKeyboardEvent(
      publication,
      event,
      event.currentTarget,
      publication.rootTargets,
    );
    if (!nativeEvent || !claimEvent(nativeEvent)) return;
    if (!transition(runtime, null, true)) return;
    event.preventDefault();
  };
  const onRootBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    if (
      !authority.open ||
      !runtime ||
      !publication ||
      !ownsRoot(publication, event.currentTarget)
    ) {
      return;
    }
    const nativeEvent = nativeFocusEvent(publication, event);
    if (!nativeEvent) return;
    const related = event.relatedTarget;
    if (
      !isNodeFromDocument(related, publication.ownerDocument) ||
      !related.isConnected ||
      publication.root.contains(related) ||
      !claimEvent(nativeEvent)
    ) {
      return;
    }
    transition(runtime, null, false);
  };

  const expectedOwners = (): readonly ElementOwnerView[] => [
    rootOwner,
    primaryOwner,
    toggleOwner,
    listOwner,
    ...FORMATS.map((format) => linkOwners.get(format)!),
  ];

  const createRuntime = (): DownloadPublicationRuntime | null => {
    type Retirement = "element" | "layout" | "other";
    const root = rootOwner.element();
    const primary = primaryOwner.element();
    const toggle = toggleOwner.element();
    const list = listOwner.element();
    const linkElements = Object.fromEntries(
      FORMATS.map((format) => [format, linkOwners.get(format)?.element()]),
    ) as Record<Format, HTMLAnchorElement | null>;
    const placement = root ? captureDownloadPlacement(root) : null;
    if (
      !root ||
      !primary ||
      !toggle ||
      !list ||
      !placement ||
      FORMATS.some((format) => !linkElements[format])
    ) {
      return null;
    }

    const exactLinks = linkElements as Record<Format, HTMLAnchorElement>;
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let focusClaimed = false;
    let pointerListening = false;
    let domChanged = false;
    let domObserver: MutationObserver | null = null;
    let domSnapshot: DownloadDomSnapshot | null = null;
    let placementSnapshot: DownloadPlacement | null = null;
    let replayRefs: RefReplay[] = [];
    let invalidReplay = false;

    const linkTargets = Object.fromEntries(
      FORMATS.map((format) => [
        format,
        descendantsOf(exactLinks[format]),
      ]),
    ) as Record<Format, readonly Node[]>;
    const publication: DownloadPublication = Object.freeze({
      authority,
      ownerDocument: root.ownerDocument,
      root,
      primary,
      toggle,
      list,
      linkElements: Object.freeze(exactLinks),
      rootTargets: descendantsOf(root),
      toggleTargets: descendantsOf(toggle),
      linkTargets: Object.freeze(linkTargets),
      retire: () => retire("other"),
      isRetired: () => retired,
    });

    const uninstallPointer = () => {
      if (!pointerListening) return;
      pointerListening = false;
      publication.ownerDocument.removeEventListener(
        "pointerdown",
        onPointerDown,
      );
    };
    const mutationIsRelevant = (record: MutationRecord) => {
      if (record.target === root || root.contains(record.target)) return true;
      if (
        record.type === "attributes" &&
        (record.attributeName === "inert" ||
          record.attributeName === "aria-disabled" ||
          record.attributeName === "disabled")
      ) {
        return root.contains(record.target) || record.target.contains(root);
      }
      if (record.type !== "childList") return false;
      if (record.target === placement.parent) return true;
      return [...record.addedNodes, ...record.removedNodes].some(
        (node) => node === root || node.contains(root),
      );
    };
    const recordMutations = (records: readonly MutationRecord[]) => {
      if (!domChanged && records.some(mutationIsRelevant)) domChanged = true;
      return domChanged;
    };
    const releaseReplayGuard = () => {
      if (!domObserver) return;
      recordMutations(domObserver.takeRecords());
      domObserver.disconnect();
      domObserver = null;
    };
    const noteMutations = (records: readonly MutationRecord[]) => {
      if (recordMutations(records)) retire("element");
    };
    const retire = (reason: Retirement) => {
      if (retired) return false;
      if (domObserver) recordMutations(domObserver.takeRecords());
      retired = true;
      retirement = reason;
      const wasActive = cells.active.current === publication;
      if (wasActive) {
        cells.active.current = null;
        cells.successorOf.current = publication;
      }
      if (currentRuntime?.publication === publication) currentRuntime = null;
      uninstallPointer();
      if (reason === "layout") {
        queueMicrotask(() => {
          if (!domObserver) return;
          recordMutations(domObserver.takeRecords());
          domChanged = true;
          domObserver.disconnect();
          domObserver = null;
        });
      } else {
        releaseReplayGuard();
      }
      return wasActive;
    };
    const publishedDomMatches = () => {
      if (domObserver) noteMutations(domObserver.takeRecords());
      return Boolean(
        !domChanged &&
          domSnapshot &&
          placementSnapshot &&
          rootOwner.element() === root &&
          root.isConnected &&
          downloadPlacementMatches(root, placementSnapshot) &&
          downloadDomMatches(domSnapshot),
      );
    };
    const focusFactsMatch = () => {
      const disclosure = authority.disclosure;
      return disclosure
        ? cells.focused.has(disclosure) ===
            (authority.focusPublished || focusClaimed)
        : !authority.focusPublished && !focusClaimed;
    };
    const ownsPublishedAuthority = () =>
      currentRuntime === runtime &&
      cells.active.current === publication &&
      !retired &&
      factsAreCurrent(runtime) &&
      exactDomIsCurrent() &&
      publishedDomMatches();
    const nativePointerEvent = (event: Event) => {
      const ownerWindow = publication.ownerDocument.defaultView;
      if (!ownerWindow || event.type !== "pointerdown") return false;
      const PointerEventConstructor = ownerWindow.PointerEvent;
      return PointerEventConstructor
        ? event instanceof PointerEventConstructor
        : event instanceof ownerWindow.Event;
    };
    const onPointerDown = (event: Event) => {
      if (
        !pointerListening ||
        !authority.open ||
        !ownsPublishedAuthority() ||
        !nativePointerEvent(event)
      ) {
        return;
      }
      const target = event.target;
      if (
        !isNodeFromDocument(target, publication.ownerDocument) ||
        !target.isConnected ||
        publication.root.contains(target) ||
        !claimEvent(event)
      ) {
        return;
      }
      transition(runtime, null, false);
    };
    const refsHaveExactReplay = () =>
      !invalidReplay &&
      replayRefs.length > 0 &&
      replayRefs.every(
        (entry) =>
          entry.detached &&
          entry.reattached &&
          entry.owner.element() === entry.element,
      );

    const runtime: DownloadPublicationRuntime = Object.freeze({
      publication,
      publish: (
        snapshot: DownloadDomSnapshot,
        publishedPlacement: DownloadPlacement,
        owners: readonly ElementOwnerView[],
      ) => {
        established = true;
        domSnapshot = snapshot;
        placementSnapshot = publishedPlacement;
        replayRefs = owners.map((owner) => {
          const element = owner.element();
          if (!element) {
            throw new Error(
              "Cannot publish DownloadMenu without every committed ref",
            );
          }
          return { owner, element, detached: false, reattached: false };
        });
        cells.active.current = publication;
        cells.successorOf.current = null;
        cells.replay.current = null;
        const MutationObserverConstructor =
          publication.ownerDocument.defaultView?.MutationObserver;
        if (MutationObserverConstructor) {
          domObserver = new MutationObserverConstructor((records) => {
            noteMutations(records);
          });
          domObserver.observe(publication.ownerDocument, {
            attributes: true,
            characterData: true,
            childList: true,
            subtree: true,
          });
        }
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
        if (
          element === null &&
          previous === proof.element &&
          proof.element.isConnected
        ) {
          proof.detached = true;
          proof.reattached = false;
        } else if (
          element === proof.element &&
          previous === null &&
          proof.detached &&
          proof.element.isConnected
        ) {
          proof.reattached = true;
        } else if (element !== previous) {
          invalidReplay = true;
        }
      },
      isRetired: () => retired,
      publishedDomMatches,
      focusFactsMatch,
      focusDisclosure: () => {
        const disclosure = authority.disclosure;
        if (
          !authority.open ||
          !disclosure ||
          authority.focusPublished ||
          cells.focused.has(disclosure)
        ) {
          return authority.focusPublished;
        }
        const first = links.md;
        const firstElement = publication.linkElements.md;
        if (!ownsLink(publication, first, firstElement)) return false;
        cells.focused.add(disclosure);
        focusClaimed = true;
        if (!ownsLink(publication, first, firstElement)) return false;
        firstElement.focus();
        return ownsLink(publication, first, firstElement);
      },
      installPointer: () => {
        if (
          pointerListening ||
          !authority.open ||
          !ownsPublishedAuthority()
        ) {
          return !authority.open;
        }
        pointerListening = true;
        publication.ownerDocument.addEventListener(
          "pointerdown",
          onPointerDown,
        );
        if (!ownsPublishedAuthority()) {
          uninstallPointer();
          return false;
        }
        return true;
      },
      isExactElementReplay: () =>
        retired &&
        retirement === "element" &&
        layoutRetired &&
        established &&
        refsHaveExactReplay() &&
        focusFactsMatch() &&
        publishedDomMatches(),
      isExactLayoutReplay: () =>
        retired &&
        retirement === "layout" &&
        established &&
        refsHaveExactReplay() &&
        focusFactsMatch() &&
        publishedDomMatches(),
      replayDomUnchanged: () => {
        if (!domObserver) return false;
        recordMutations(domObserver.takeRecords());
        return Boolean(
          !domChanged &&
            domSnapshot &&
            placementSnapshot &&
            root.isConnected &&
            downloadPlacementMatches(root, placementSnapshot) &&
            downloadDomMatches(domSnapshot),
        );
      },
      releaseReplayGuard,
      snapshot: () => domSnapshot,
      placement: () => placementSnapshot,
    });
    return runtime;
  };

  const establish = () => {
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() ||
          lastRuntime.isExactElementReplay()) &&
        cells.successorOf.current === lastRuntime.publication
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (!factsAreCurrent() || !exactDomIsCurrent()) return undefined;
    const root = rootOwner.element();
    const placement = root ? captureDownloadPlacement(root) : null;
    if (!root || !placement) return undefined;
    const replay = cells.replay.current;
    if (
      replay &&
      (
        cells.successorOf.current !== replay.source ||
        !authoritiesMatch(replay.source.authority, authority) ||
        root !== replay.dom.node ||
        !downloadPlacementMatches(root, replay.placement) ||
        !downloadDomMatches(replay.dom) ||
        !replay.unchanged()
      )
    ) {
      const exactDomStillCommitted =
        root === replay.dom.node &&
        downloadPlacementMatches(root, replay.placement) &&
        downloadDomMatches(replay.dom) &&
        replay.unchanged();
      replay.release();
      cells.replay.current = null;
      if (cells.successorOf.current === replay.source) {
        cells.successorOf.current = null;
      }
      if (exactDomStillCommitted) requestSuccessor();
      return undefined;
    }

    const runtime = createRuntime();
    if (!runtime) return undefined;
    const publication = runtime.publication;
    const previous = cells.active.current;
    if (previous && previous !== publication) previous.retire();
    currentRuntime = runtime;
    lastRuntime = runtime;
    runtime.publish(
      snapshotDownloadDom(root),
      placement,
      expectedOwners(),
    );
    replay?.release();
    if (
      authority.open &&
      !authority.focusPublished &&
      !runtime.focusDisclosure()
    ) {
      publication.retire();
      return runtime.retireForLayout;
    }
    if (!runtime.installPointer()) publication.retire();
    return runtime.retireForLayout;
  };

  return Object.freeze({
    captureRoot: rootOwner.capture,
    capturePrimary: primaryOwner.capture,
    captureToggle: toggleOwner.capture,
    captureList: listOwner.capture,
    links: Object.freeze(links),
    establish,
    onToggleClick,
    onToggleKeyDown,
    onListKeyDown,
    onRootKeyDown,
    onRootBlur,
  });
}

/**
 * "Download" split button: Markdown, HTML or PDF through the existing export route.
 * The "Download as…" half is a WAI-ARIA disclosure (a button that shows a list of links), not a Radix
 * menu: this was the public reader's only Radix consumer and its first load matters most. The list
 * stays in the DOM with `hidden` while closed, so `aria-controls` always resolves.
 */
export function DownloadMenu({ docId }: { docId: string }) {
  const [mount] = useState(() => Symbol("reader download menu"));
  const documentVisit = useMemo<DocumentVisit>(() => {
    return Object.freeze({
      mount,
      docId,
      hrefs: Object.freeze({
        md: exportHref(docId, "md"),
        html: exportHref(docId, "html"),
        pdf: exportHref(docId, "pdf"),
      }),
    });
  }, [docId, mount]);
  const [state, setState] = useState<DownloadState>(() =>
    Object.freeze({ document: documentVisit, disclosure: null }),
  );
  const [cells] = useState<PublicationCells>(() => ({
    active: new CurrentCell<DownloadPublication | null>(null),
    successorOf: new CurrentCell<DownloadPublication | null>(null),
    replay: new CurrentCell<DownloadReplay | null>(null),
    focused: new WeakSet<DisclosureVisit>(),
    claimedEvents: new WeakSet<Event>(),
  }));
  const [, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const currentState = state.document === documentVisit ? state : null;
  const disclosure = currentState?.disclosure ?? null;
  const open = disclosure !== null;
  const publication = createDownloadPublication({
    authority: Object.freeze({
      document: documentVisit,
      sourceState: state,
      state: currentState,
      disclosure,
      open,
      focusPublished: disclosure ? cells.focused.has(disclosure) : false,
    }),
    cells,
    setState,
    requestSuccessor: requestPublicationSuccessor,
  });

  useLayoutEffect(() => publication.establish(), [publication]);

  const {
    captureRoot,
    capturePrimary,
    captureToggle,
    captureList,
    links,
    onToggleClick,
    onToggleKeyDown,
    onListKeyDown,
    onRootKeyDown,
    onRootBlur,
  } = publication;

  return (
    <div ref={captureRoot} className="relative flex items-stretch" onKeyDown={onRootKeyDown} onBlur={onRootBlur}>
      <a ref={capturePrimary} href={documentVisit.hrefs.md} className="btn btn-sm btn-outline reader-split-main gap-1.5" aria-label="Download Markdown" data-testid="reader-download">
        <Download size={14} />
        <span className="hidden sm:inline">Download</span>
      </a>
      <button
        ref={captureToggle}
        type="button"
        className="btn btn-sm btn-outline reader-split-more"
        aria-label="Download as…"
        aria-expanded={open}
        aria-controls={LIST_ID}
        onClick={onToggleClick}
        onKeyDown={onToggleKeyDown}
        data-testid="reader-download-menu"
      >
        <ChevronDown size={14} className="shrink-0" />
      </button>
      <div ref={captureList} id={LIST_ID} className="menu animate-fade-in absolute right-0 top-full mt-1.5 w-48" hidden={!open} onKeyDown={onListKeyDown} data-testid="reader-download-list">
        {ROWS.map(({ format, label, Icon }) => {
          const link = links[format];
          return (
            <a ref={link.capture} key={format} href={link.href} className="menu-item" onClick={link.onClick} data-testid={`reader-download-${format}`}>
              <span className="flex h-4 w-4 items-center justify-center text-ink-3">
                <Icon size={15} />
              </span>
              <span className="flex-1">{label}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
