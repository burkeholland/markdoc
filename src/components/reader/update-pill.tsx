"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { RefreshCw, X } from "lucide-react";

const PILL_CLASS_NAME =
  "reader-pill pointer-events-none fixed inset-x-0 top-16 z-20 flex justify-center gap-1";
const BUTTON_CLASS_NAME =
  "pointer-events-auto inline-flex items-center gap-2 rounded-full border border-line-2 bg-surface px-3.5 py-1.5 text-sm font-medium text-ink shadow-md hover:bg-surface-2";
const DISMISS_BUTTON_CLASS_NAME =
  "pointer-events-auto inline-flex size-8 items-center justify-center rounded-full border border-line-2 bg-surface text-ink-3 shadow-md hover:bg-surface-2 hover:text-ink";
const UPDATED_CLASS_NAME = "text-ink-3";
const SEPARATOR_CLASS_NAME = "text-ink-4";
const ICON_CLASS_NAME = "text-accent";
const CONTROL_TEXT = "Updated—Refresh";
const DISMISS_LABEL = "Dismiss update notice";

type DocumentAuthority = Readonly<{
  mount: symbol;
  ownerDocument: Document;
  docId: string;
  initialHash: string;
}>;

type RefreshPublication = Readonly<{
  document: DocumentAuthority;
  remoteHash: string;
}>;

type DismissedUpdate = Readonly<{
  document: DocumentAuthority;
  remoteHash: string;
}>;

type PollingAuthority = Readonly<{
  document: DocumentAuthority;
  pollMs: number;
}>;

type PollingOwner = {
  authority: PollingAuthority;
  retire: () => void;
};

type RequestOwner = {
  authority: PollingAuthority;
  controller: AbortController;
};

type RefreshControlRender = Readonly<{
  identity: symbol;
  mount: symbol;
  ownerDocument: Document;
  docId: string;
  initialHash: string;
  pollMs: number;
  document: DocumentAuthority;
  polling: PollingAuthority;
  refresh: RefreshPublication;
  dismiss: (publication: RefreshPublication) => void;
}>;

type RefreshAction = {
  claimed: boolean;
};

type ReloadAuthority = Readonly<{
  owner: Window;
  location: Location;
  reload: Location["reload"];
}>;

type RefreshControlPublication = Readonly<{
  render: RefreshControlRender;
  action: RefreshAction;
  pill: HTMLDivElement;
  refreshButton: HTMLButtonElement;
  dismissButton: HTMLButtonElement;
  ownerDocument: Document;
  refreshTargets: readonly Node[];
  dismissTargets: readonly Node[];
  reloadAuthority: ReloadAuthority;
  retire: () => boolean;
  isRetired: () => boolean;
}>;

type CurrentCell<T> = {
  current: T;
};

type RefreshControlCells = {
  active: CurrentCell<RefreshControlPublication | null>;
  successorOf: CurrentCell<RefreshControlPublication | null>;
  replay: CurrentCell<RefreshControlReplay | null>;
  invalidRefreshes: WeakSet<RefreshPublication>;
  claimedRefreshes: WeakSet<RefreshPublication>;
  claimedPublications: WeakSet<RefreshControlPublication>;
  claimedActions: WeakSet<RefreshAction>;
  claimedReactEvents: WeakSet<object>;
  claimedNativeEvents: WeakSet<Event>;
};

type RefreshControlDomSnapshot = Readonly<{
  node: Node;
  nodeValue: string | null;
  attributes: readonly (readonly [string, string])[] | null;
  children: readonly RefreshControlDomSnapshot[];
}>;

type RefreshControlPlacement = Readonly<{
  document: Document;
  parent: Node;
  previousSibling: Node | null;
  nextSibling: Node | null;
}>;

type RefreshControlReplay = Readonly<{
  source: RefreshControlPublication;
  dom: RefreshControlDomSnapshot;
  placement: RefreshControlPlacement;
  historyIsClean: () => boolean;
  release: () => void;
}>;

interface ElementOwnerView {
  readonly element: () => HTMLElement | null;
}

class ElementOwner<T extends HTMLElement> implements ElementOwnerView {
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

type RefReplay = {
  readonly owner: ElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
};

interface RefreshControlDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface RefreshControlRuntime {
  readonly publication: RefreshControlPublication;
  readonly publish: (
    snapshot: RefreshControlDomSnapshot,
    placement: RefreshControlPlacement,
    owners: readonly ElementOwnerView[],
  ) => void;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly retireForInvalidation: () => void;
  readonly noteRef: (
    owner: ElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly snapshot: () => RefreshControlDomSnapshot | null;
  readonly placement: () => RefreshControlPlacement | null;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

type RefreshControlPublicationSet = Readonly<{
  capturePill: (element: HTMLDivElement | null) => void;
  captureRefreshButton: (element: HTMLButtonElement | null) => void;
  captureDismissButton: (element: HTMLButtonElement | null) => void;
  establish: () => void | (() => void);
  onRefresh: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onDismiss: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}>;

function snapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotControlDom(node: Node): RefreshControlDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotControlDom)),
  });
}

function controlDomMatches(snapshot: RefreshControlDomSnapshot): boolean {
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
        node.childNodes.item(index) === child.node && controlDomMatches(child),
    )
  );
}

function captureControlPlacement(pill: HTMLDivElement): RefreshControlPlacement | null {
  const parent = pill.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: pill.ownerDocument,
    parent,
    previousSibling: pill.previousSibling,
    nextSibling: pill.nextSibling,
  });
}

function controlPlacementMatches(
  pill: HTMLDivElement,
  placement: RefreshControlPlacement,
): boolean {
  return (
    pill.ownerDocument === placement.document &&
    pill.parentNode === placement.parent &&
    pill.previousSibling === placement.previousSibling &&
    pill.nextSibling === placement.nextSibling
  );
}

function createControlDomGuard(
  pill: HTMLDivElement,
  placement: RefreshControlPlacement,
): RefreshControlDomGuard | null {
  const MutationObserverConstructor =
    placement.document.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some((record) => {
      if (record.target === pill || pill.contains(record.target)) return true;
      if (record.type !== "childList" || record.target !== placement.parent) {
        return false;
      }
      return true;
    });
  };
  const observer = new MutationObserverConstructor(recordChanges);
  observer.observe(pill, {
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

function descendantsOf(element: HTMLElement): readonly Node[] {
  const descendants: Node[] = [];
  const collect = (node: Node) => {
    descendants.push(node);
    for (const child of node.childNodes) collect(child);
  };
  collect(element);
  return Object.freeze(descendants);
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

function isEffectivelyEnabled(button: HTMLButtonElement): boolean {
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

function controlHasExpectedPresentation(
  pill: HTMLDivElement,
  refreshButton: HTMLButtonElement,
  dismissButton: HTMLButtonElement,
): boolean {
  const updated = refreshButton.children.item(0);
  const separator = refreshButton.children.item(1);
  const refreshIcon = refreshButton.children.item(2);
  const refreshText = refreshButton.childNodes.item(3);
  const dismissIcon = dismissButton.children.item(0);
  return (
    pill.isConnected &&
    refreshButton.isConnected &&
    dismissButton.isConnected &&
    pill.ownerDocument === refreshButton.ownerDocument &&
    pill.ownerDocument === dismissButton.ownerDocument &&
    pill.tagName === "DIV" &&
    refreshButton.tagName === "BUTTON" &&
    dismissButton.tagName === "BUTTON" &&
    pill.getAttribute("class") === PILL_CLASS_NAME &&
    pill.getAttribute("role") === "status" &&
    pill.dataset.testid === "reader-updated" &&
    pill.children.length === 2 &&
    pill.childNodes.length === 2 &&
    pill.children.item(0) === refreshButton &&
    pill.children.item(1) === dismissButton &&
    refreshButton.parentElement === pill &&
    dismissButton.parentElement === pill &&
    refreshButton.getAttribute("type") === "button" &&
    refreshButton.type === "button" &&
    isEffectivelyEnabled(refreshButton) &&
    refreshButton.getAttribute("class") === BUTTON_CLASS_NAME &&
    refreshButton.children.length === 3 &&
    refreshButton.childNodes.length === 4 &&
    updated?.tagName === "SPAN" &&
    updated.getAttribute("class") === UPDATED_CLASS_NAME &&
    updated.childNodes.length === 1 &&
    updated.firstChild?.nodeType === 3 &&
    updated.firstChild.nodeValue === "Updated" &&
    separator?.tagName === "SPAN" &&
    separator.getAttribute("class") === SEPARATOR_CLASS_NAME &&
    separator.getAttribute("aria-hidden") === "true" &&
    separator.childNodes.length === 1 &&
    separator.firstChild?.nodeType === 3 &&
    separator.firstChild.nodeValue === "—" &&
    refreshIcon?.localName === "svg" &&
    refreshIcon.classList.contains("lucide-refresh-cw") &&
    refreshIcon.classList.contains(ICON_CLASS_NAME) &&
    refreshIcon.getAttribute("width") === "14" &&
    refreshIcon.getAttribute("height") === "14" &&
    refreshText?.nodeType === 3 &&
    refreshText.nodeValue === "Refresh" &&
    refreshButton.textContent === CONTROL_TEXT &&
    dismissButton.getAttribute("type") === "button" &&
    dismissButton.type === "button" &&
    isEffectivelyEnabled(dismissButton) &&
    dismissButton.getAttribute("class") === DISMISS_BUTTON_CLASS_NAME &&
    dismissButton.getAttribute("aria-label") === DISMISS_LABEL &&
    dismissButton.children.length === 1 &&
    dismissButton.childNodes.length === 1 &&
    dismissIcon?.localName === "svg" &&
    dismissIcon.classList.contains("lucide-x") &&
    dismissIcon.getAttribute("width") === "14" &&
    dismissIcon.getAttribute("height") === "14"
  );
}

function captureReloadAuthority(
  ownerDocument: Document,
): ReloadAuthority | null {
  const owner = window;
  if (owner.document !== ownerDocument) return null;
  const location = owner.location;
  const reload = location.reload;
  if (typeof reload !== "function") return null;
  return Object.freeze({ owner, location, reload });
}

function reloadAuthorityIsCurrent(
  authority: ReloadAuthority,
  ownerDocument: Document,
): boolean {
  return (
    authority.owner.document === ownerDocument &&
    authority.owner.location === authority.location &&
    authority.location.reload === authority.reload
  );
}

function reloadAuthoritiesMatch(
  previous: ReloadAuthority,
  current: ReloadAuthority,
): boolean {
  return (
    previous.owner === current.owner &&
    previous.location === current.location &&
    previous.reload === current.reload
  );
}

function controlAuthoritiesMatch(
  previous: RefreshControlRender,
  current: RefreshControlRender,
): boolean {
  return (
    previous.identity !== current.identity &&
    previous.mount === current.mount &&
    previous.ownerDocument === current.ownerDocument &&
    previous.docId === current.docId &&
    previous.initialHash === current.initialHash &&
    previous.pollMs === current.pollMs &&
    previous.document === current.document &&
    previous.polling === current.polling &&
    previous.refresh === current.refresh &&
    previous.refresh.remoteHash === current.refresh.remoteHash &&
    previous.dismiss === current.dismiss
  );
}

function retireInactiveControl(cells: RefreshControlCells) {
  cells.active.current?.retire();
  cells.replay.current?.release();
  cells.replay.current = null;
  cells.successorOf.current = null;
}

function createRefreshControlPublication(
  render: RefreshControlRender,
  cells: RefreshControlCells,
  documentAuthorityRef: React.RefObject<DocumentAuthority | null>,
  pollingAuthorityRef: React.RefObject<PollingAuthority | null>,
  refreshPublicationRef: React.RefObject<RefreshPublication | null>,
  requestSuccessor: () => void,
  dismissCurrentPublication: (publication: RefreshPublication) => void,
): RefreshControlPublicationSet {
  let currentRuntime: RefreshControlRuntime | null = null;
  let lastRuntime: RefreshControlRuntime | null = null;
  let successorRequested = false;

  const factsAreCurrent = () =>
    render.mount === render.document.mount &&
    render.ownerDocument === render.document.ownerDocument &&
    render.docId === render.document.docId &&
    render.initialHash === render.document.initialHash &&
    render.document === render.polling.document &&
    render.pollMs === render.polling.pollMs &&
    render.document === render.refresh.document &&
    render.dismiss === dismissCurrentPublication &&
    documentAuthorityRef.current === render.document &&
    pollingAuthorityRef.current === render.polling &&
    refreshPublicationRef.current === render.refresh &&
    !cells.invalidRefreshes.has(render.refresh) &&
    !cells.claimedRefreshes.has(render.refresh);

  const onElementChange = (
    owner: ElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null) {
      currentRuntime?.retireForElement();
    } else if (last !== null && element !== last) {
      currentRuntime?.retireForInvalidation();
    }
    if (
      runtime?.isExactElementReplay() &&
      cells.successorOf.current === runtime.publication
    ) {
      requestReplaySuccessor(runtime);
    }
  };
  const pillOwner = new ElementOwner<HTMLDivElement>(onElementChange);
  const refreshButtonOwner = new ElementOwner<HTMLButtonElement>(onElementChange);
  const dismissButtonOwner = new ElementOwner<HTMLButtonElement>(onElementChange);

  const exactDomIsCurrent = () => {
    const pill = pillOwner.element();
    const refreshButton = refreshButtonOwner.element();
    const dismissButton = dismissButtonOwner.element();
    return Boolean(
      pill &&
        refreshButton &&
        dismissButton &&
        pill.ownerDocument === render.ownerDocument &&
        refreshButton.ownerDocument === render.ownerDocument &&
        dismissButton.ownerDocument === render.ownerDocument &&
        controlHasExpectedPresentation(pill, refreshButton, dismissButton),
    );
  };

  const expectedOwners = (): readonly ElementOwnerView[] => [
    pillOwner,
    refreshButtonOwner,
    dismissButtonOwner,
  ];

  const publicationIsCurrent = (runtime: RefreshControlRuntime) => {
    const publication = runtime.publication;
    return (
      currentRuntime === runtime &&
      cells.active.current === publication &&
      !publication.isRetired() &&
      !publication.action.claimed &&
      !cells.claimedPublications.has(publication) &&
      !cells.claimedActions.has(publication.action) &&
      publication.render === render &&
      publication.pill === pillOwner.element() &&
      publication.refreshButton === refreshButtonOwner.element() &&
      publication.dismissButton === dismissButtonOwner.element() &&
      render.refresh.remoteHash.length > 0 &&
      render.refresh.remoteHash !== render.initialHash &&
      factsAreCurrent() &&
      exactDomIsCurrent() &&
      runtime.publishedDomMatches()
    );
  };

  const requestReplaySuccessor = (runtime: RefreshControlRuntime) => {
    const snapshot = runtime.snapshot();
    const placement = runtime.placement();
    const publication = runtime.publication;
    if (
      successorRequested ||
      !snapshot ||
      !placement ||
      cells.successorOf.current !== publication ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !reloadAuthorityIsCurrent(
        publication.reloadAuthority,
        publication.ownerDocument,
      ) ||
      !runtime.publishedDomMatches()
    ) {
      return;
    }
    successorRequested = true;
    cells.replay.current = Object.freeze({
      source: publication,
      dom: snapshot,
      placement,
      historyIsClean: runtime.historyIsClean,
      release: runtime.release,
    });
    requestSuccessor();
  };

  const createRuntime = (
    pill: HTMLDivElement,
    refreshButton: HTMLButtonElement,
    dismissButton: HTMLButtonElement,
    reloadAuthority: ReloadAuthority,
  ): RefreshControlRuntime => {
    type Retirement = "element" | "layout" | "invalid" | "other";
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let domSnapshot: RefreshControlDomSnapshot | null = null;
    let placementSnapshot: RefreshControlPlacement | null = null;
    let domGuard: RefreshControlDomGuard | null = null;
    let replayRefs: RefReplay[] = [];
    let invalidReplay = false;

    const retire = (reason: Retirement) => {
      if (retired) return false;
      if (
        reason === "invalid" ||
        (reason === "element" && domGuard && !domGuard.isClean())
      ) {
        cells.invalidRefreshes.add(render.refresh);
      }
      retired = true;
      retirement = reason;
      if (cells.active.current === publication) {
        cells.active.current = null;
        cells.successorOf.current = publication;
      }
      if (currentRuntime?.publication === publication) currentRuntime = null;
      queueMicrotask(() => {
        if (cells.replay.current?.source !== publication) {
          domGuard?.release();
        }
        if (
          reason === "element" &&
          cells.active.current === null &&
          cells.successorOf.current === publication &&
          cells.replay.current?.source !== publication
        ) {
          cells.invalidRefreshes.add(render.refresh);
        }
      });
      return true;
    };
    const action: RefreshAction = { claimed: false };
    const publication: RefreshControlPublication = Object.freeze({
      render,
      action,
      pill,
      refreshButton,
      dismissButton,
      ownerDocument: pill.ownerDocument,
      refreshTargets: descendantsOf(refreshButton),
      dismissTargets: descendantsOf(dismissButton),
      reloadAuthority,
      retire: () => retire("other"),
      isRetired: () => retired,
    });
    const publishedDomMatches = () =>
      Boolean(
        domSnapshot &&
          placementSnapshot &&
          domGuard &&
          domGuard.isClean() &&
          pillOwner.element() === pill &&
          refreshButtonOwner.element() === refreshButton &&
          dismissButtonOwner.element() === dismissButton &&
          pill.isConnected &&
          refreshButton.isConnected &&
          dismissButton.isConnected &&
          controlPlacementMatches(pill, placementSnapshot) &&
          controlDomMatches(domSnapshot),
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

    const runtime: RefreshControlRuntime = Object.freeze({
      publication,
      publish: (
        snapshot: RefreshControlDomSnapshot,
        placement: RefreshControlPlacement,
        owners: readonly ElementOwnerView[],
      ) => {
        established = true;
        domSnapshot = snapshot;
        placementSnapshot = placement;
        domGuard = createControlDomGuard(pill, placement);
        if (!domGuard) {
          throw new Error(
            "Cannot publish UpdatePill without a DOM mutation observer",
          );
        }
        replayRefs = owners.map((owner: ElementOwnerView) => {
          const element = owner.element();
          if (!element) {
            throw new Error(
              "Cannot publish UpdatePill without every committed ref",
            );
          }
          return { owner, element, detached: false, reattached: false };
        });
        cells.active.current = publication;
        cells.successorOf.current = null;
        cells.replay.current = null;
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        layoutRetired = true;
        retire("layout");
      },
      retireForInvalidation: () => {
        retire("invalid");
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
      isExactElementReplay: () =>
        retired &&
        retirement === "element" &&
        layoutRetired &&
        established &&
        refsHaveExactReplay() &&
        publishedDomMatches(),
      isExactLayoutReplay: () =>
        retired &&
        retirement === "layout" &&
        established &&
        (refsHaveNoReplay() || refsHaveExactReplay()) &&
        publishedDomMatches(),
      publishedDomMatches,
      snapshot: () => domSnapshot,
      placement: () => placementSnapshot,
      historyIsClean: () => domGuard?.isClean() ?? false,
      release: () => {
        domGuard?.release();
      },
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
    if (!factsAreCurrent()) {
      if (
        !successorRequested &&
        documentAuthorityRef.current === render.document &&
        pollingAuthorityRef.current !== render.polling &&
        refreshPublicationRef.current === render.refresh &&
        exactDomIsCurrent()
      ) {
        successorRequested = true;
        requestSuccessor();
      }
      return undefined;
    }
    if (!exactDomIsCurrent()) return undefined;
    const pill = pillOwner.element();
    const refreshButton = refreshButtonOwner.element();
    const dismissButton = dismissButtonOwner.element();
    const placement = pill ? captureControlPlacement(pill) : null;
    const reloadAuthority = captureReloadAuthority(render.ownerDocument);
    if (
      !pill ||
      !refreshButton ||
      !dismissButton ||
      !placement ||
      !reloadAuthority
    ) {
      return undefined;
    }

    const replay = cells.replay.current;
    if (replay) {
      const exactReplay =
        controlAuthoritiesMatch(replay.source.render, render) &&
        replay.source.isRetired() &&
        cells.successorOf.current === replay.source &&
        replay.historyIsClean() &&
        reloadAuthoritiesMatch(
          replay.source.reloadAuthority,
          reloadAuthority,
        ) &&
        pill === replay.dom.node &&
        controlPlacementMatches(pill, replay.placement) &&
        controlDomMatches(replay.dom);
      cells.replay.current = null;
      replay.release();
      if (cells.successorOf.current === replay.source) {
        cells.successorOf.current = null;
      }
      if (!exactReplay) return undefined;
    }

    const runtime = createRuntime(
      pill,
      refreshButton,
      dismissButton,
      reloadAuthority,
    );
    const previous = cells.active.current;
    if (previous && previous !== runtime.publication) previous.retire();
    currentRuntime = runtime;
    lastRuntime = runtime;
    runtime.publish(
      snapshotControlDom(pill),
      placement,
      expectedOwners(),
    );
    return runtime.retireForLayout;
  };

  const claim = (
    event: ReactMouseEvent<HTMLButtonElement>,
    kind: "refresh" | "dismiss",
  ) => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const button =
      kind === "refresh"
        ? publication?.refreshButton
        : publication?.dismissButton;
    const targets =
      kind === "refresh"
        ? publication?.refreshTargets
        : publication?.dismissTargets;
    const ownerDocument = publication?.ownerDocument;
    const MouseEventConstructor = ownerDocument?.defaultView?.MouseEvent;
    const nativeEvent = event?.nativeEvent;
    const target = event?.target;
    if (
      !runtime ||
      !publication ||
      !button ||
      !targets ||
      !ownerDocument ||
      !MouseEventConstructor ||
      event.type !== "click" ||
      event.button !== 0 ||
      !(nativeEvent instanceof MouseEventConstructor) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      !nativeEvent.bubbles ||
      event.currentTarget !== button ||
      nativeEvent.target !== target ||
      !isNodeFromDocument(target, ownerDocument) ||
      !target.isConnected ||
      !button.contains(target) ||
      !targets.includes(target) ||
      event.defaultPrevented ||
      nativeEvent.defaultPrevented ||
      cells.claimedReactEvents.has(event) ||
      cells.claimedNativeEvents.has(nativeEvent) ||
      cells.claimedRefreshes.has(render.refresh) ||
      cells.claimedPublications.has(publication) ||
      cells.claimedActions.has(publication.action) ||
      publication.action.claimed
    ) {
      return;
    }
    if (!publicationIsCurrent(runtime)) {
      runtime.retireForInvalidation();
      return;
    }
    if (
      kind === "refresh" &&
      !reloadAuthorityIsCurrent(
        publication.reloadAuthority,
        publication.ownerDocument,
      )
    ) {
      runtime.retireForInvalidation();
      return;
    }

    cells.claimedRefreshes.add(render.refresh);
    cells.claimedPublications.add(publication);
    cells.claimedActions.add(publication.action);
    cells.claimedReactEvents.add(event);
    cells.claimedNativeEvents.add(nativeEvent);
    publication.action.claimed = true;
    publication.retire();
    if (
      kind === "refresh" &&
      refreshPublicationRef.current === render.refresh
    ) {
      refreshPublicationRef.current = null;
    }
    if (kind === "refresh") {
      publication.reloadAuthority.reload.call(
        publication.reloadAuthority.location,
      );
    } else {
      render.dismiss(render.refresh);
    }
  };

  return Object.freeze({
    capturePill: pillOwner.capture,
    captureRefreshButton: refreshButtonOwner.capture,
    captureDismissButton: dismissButtonOwner.capture,
    establish,
    onRefresh: (event) => claim(event, "refresh"),
    onDismiss: (event) => claim(event, "dismiss"),
  });
}

function RefreshControl({
  mount,
  ownerDocument,
  docId,
  initialHash,
  pollMs,
  documentAuthority,
  pollingAuthority,
  refreshPublication,
  cells,
  documentAuthorityRef,
  pollingAuthorityRef,
  refreshPublicationRef,
  dismissCurrentPublication,
}: {
  mount: symbol;
  ownerDocument: Document;
  docId: string;
  initialHash: string;
  pollMs: number;
  documentAuthority: DocumentAuthority;
  pollingAuthority: PollingAuthority;
  refreshPublication: RefreshPublication;
  cells: RefreshControlCells;
  documentAuthorityRef: React.RefObject<DocumentAuthority | null>;
  pollingAuthorityRef: React.RefObject<PollingAuthority | null>;
  refreshPublicationRef: React.RefObject<RefreshPublication | null>;
  dismissCurrentPublication: (publication: RefreshPublication) => void;
}) {
  const [, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const render = Object.freeze<RefreshControlRender>({
    identity: Symbol("reader-update-control-render"),
    mount,
    ownerDocument,
    docId,
    initialHash,
    pollMs,
    document: documentAuthority,
    polling: pollingAuthority,
    refresh: refreshPublication,
    dismiss: dismissCurrentPublication,
  });
  const publication = createRefreshControlPublication(
    render,
    cells,
    documentAuthorityRef,
    pollingAuthorityRef,
    refreshPublicationRef,
    requestPublicationSuccessor,
    dismissCurrentPublication,
  );

  useLayoutEffect(() => publication.establish(), [publication]);

  const {
    capturePill,
    captureRefreshButton,
    captureDismissButton,
    onRefresh,
    onDismiss,
  } = publication;
  return (
    <div
      ref={capturePill}
      className={PILL_CLASS_NAME}
      role="status"
      data-testid="reader-updated"
    >
      <button
        ref={captureRefreshButton}
        type="button"
        className={BUTTON_CLASS_NAME}
        onClick={onRefresh}
      >
        <span className={UPDATED_CLASS_NAME}>Updated</span>
        <span aria-hidden className={SEPARATOR_CLASS_NAME}>
          —
        </span>
        <RefreshCw size={14} className={ICON_CLASS_NAME} />
        Refresh
      </button>
      <button
        ref={captureDismissButton}
        type="button"
        className={DISMISS_BUTTON_CLASS_NAME}
        aria-label={DISMISS_LABEL}
        onClick={onDismiss}
      >
        <X size={14} />
      </button>
    </div>
  );
}

/**
 * Polls the document's content hash while the tab is visible and offers a refresh when it
 * changed. No WebSocket: a reader does not need live cursors, only to know it is stale.
 */
export function UpdatePill({
  docId,
  initialHash,
  pollMs,
}: {
  docId: string;
  initialHash: string;
  pollMs: number;
}) {
  const [mount] = useState(() => Symbol("reader-update-pill"));
  const ownerDocument =
    typeof document === "undefined" ? null : document;
  const documentAuthority = useMemo<DocumentAuthority | null>(
    () =>
      ownerDocument
        ? Object.freeze({ mount, ownerDocument, docId, initialHash })
        : null,
    [mount, ownerDocument, docId, initialHash],
  );
  const authority = useMemo<PollingAuthority | null>(
    () =>
      documentAuthority
        ? Object.freeze({ document: documentAuthority, pollMs })
        : null,
    [documentAuthority, pollMs],
  );
  const documentAuthorityRef = useRef<DocumentAuthority | null>(null);
  const authorityRef = useRef<PollingAuthority | null>(null);
  const pollingOwnerRef = useRef<PollingOwner | null>(null);
  const requestOwnerRef = useRef<RequestOwner | null>(null);
  const refreshPublicationRef = useRef<RefreshPublication | null>(null);
  const dismissedUpdateRef = useRef<DismissedUpdate | null>(null);
  const [refreshPublication, setRefreshPublication] =
    useState<RefreshPublication | null>(null);
  const [controlCells] = useState<RefreshControlCells>(() => ({
    active: { current: null },
    successorOf: { current: null },
    replay: { current: null },
    invalidRefreshes: new WeakSet<RefreshPublication>(),
    claimedRefreshes: new WeakSet<RefreshPublication>(),
    claimedPublications: new WeakSet<RefreshControlPublication>(),
    claimedActions: new WeakSet<RefreshAction>(),
    claimedReactEvents: new WeakSet<object>(),
    claimedNativeEvents: new WeakSet<Event>(),
  }));
  useLayoutEffect(() => {
    if (!documentAuthority) return;
    documentAuthorityRef.current = documentAuthority;

    return () => {
      if (documentAuthorityRef.current === documentAuthority) {
        documentAuthorityRef.current = null;
      }
      if (refreshPublicationRef.current?.document === documentAuthority) {
        refreshPublicationRef.current = null;
      }
      if (dismissedUpdateRef.current?.document === documentAuthority) {
        dismissedUpdateRef.current = null;
      }
    };
  }, [documentAuthority]);

  const dismissCurrentPublication = useCallback(
    (publication: RefreshPublication) => {
      if (
        documentAuthorityRef.current !== publication.document ||
        refreshPublicationRef.current !== publication ||
        publication.remoteHash.length === 0 ||
        publication.remoteHash === publication.document.initialHash
      ) {
        return;
      }
      dismissedUpdateRef.current = Object.freeze({
        document: publication.document,
        remoteHash: publication.remoteHash,
      });
      refreshPublicationRef.current = null;
      setRefreshPublication((current) =>
        current === publication ? null : current,
      );
    },
    [],
  );

  useLayoutEffect(() => {
    if (!authority) return;
    authorityRef.current = authority;

    return () => {
      if (authorityRef.current === authority) authorityRef.current = null;

      const request = requestOwnerRef.current;
      if (request?.authority === authority) {
        requestOwnerRef.current = null;
        request.controller.abort();
      }
      const polling = pollingOwnerRef.current;
      if (polling?.authority === authority) polling.retire();
    };
  }, [authority]);

  useEffect(() => {
    if (!authority) return;
    const pollingDocument = authority.document.ownerDocument;
    const hasAuthority = () => authorityRef.current === authority;
    if (
      !hasAuthority() ||
      refreshPublication?.document === authority.document
    ) {
      return;
    }
    const resumesDismissedUpdate =
      dismissedUpdateRef.current?.document === authority.document;

    let timer: ReturnType<typeof setInterval> | null = null;
    let retired = false;
    let changed = false;
    const stopTimer = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    const stopRequest = () => {
      const request = requestOwnerRef.current;
      if (request?.authority !== authority) return;
      requestOwnerRef.current = null;
      request.controller.abort();
    };
    const stop = () => {
      stopTimer();
      stopRequest();
    };
    const check = async () => {
      if (
        retired ||
        changed ||
        !hasAuthority() ||
        requestOwnerRef.current !== null ||
        pollingDocument.visibilityState !== "visible"
      ) {
        return;
      }
      const request: RequestOwner = {
        authority,
        controller: new AbortController(),
      };
      requestOwnerRef.current = request;
      const ownsRequest = () =>
        !retired &&
        hasAuthority() &&
        requestOwnerRef.current === request &&
        !request.controller.signal.aborted;

      try {
        const res = await fetch(
          `/api/documents/${authority.document.docId}/content`,
          {
            cache: "no-store",
            signal: request.controller.signal,
          },
        );
        if (!ownsRequest() || !res.ok) return;
        const data = (await res.json()) as { contentHash?: unknown };
        if (
          !ownsRequest() ||
          pollingDocument.visibilityState !== "visible"
        ) {
          return;
        }
        const remoteHash = data.contentHash;
        if (typeof remoteHash !== "string" || remoteHash.length === 0) return;
        if (remoteHash === authority.document.initialHash) {
          if (
            dismissedUpdateRef.current?.document === authority.document
          ) {
            dismissedUpdateRef.current = null;
          }
          return;
        }
        const dismissed = dismissedUpdateRef.current;
        if (
          dismissed?.document === authority.document &&
          dismissed.remoteHash === remoteHash
        ) {
          return;
        }
        changed = true;
        stopTimer();
        const publication = Object.freeze<RefreshPublication>({
          document: authority.document,
          remoteHash,
        });
        refreshPublicationRef.current = publication;
        setRefreshPublication(publication);
      } catch {
        // Offline or transient error: try again on the next tick.
      } finally {
        if (
          !retired &&
          hasAuthority() &&
          requestOwnerRef.current === request
        ) {
          requestOwnerRef.current = null;
        }
      }
    };
    const start = (checkImmediately = true) => {
      if (
        retired ||
        changed ||
        !hasAuthority() ||
        pollingDocument.visibilityState !== "visible"
      ) {
        return;
      }
      if (checkImmediately) void check();
      if (timer !== null) return;
      timer = setInterval(() => void check(), authority.pollMs);
    };
    const onVisibility = () => {
      if (pollingDocument.visibilityState === "visible") {
        start();
      } else {
        stop();
      }
    };
    const retire = () => {
      if (retired) return;
      retired = true;
      stop();
      pollingDocument.removeEventListener("visibilitychange", onVisibility);
      if (pollingOwnerRef.current === polling) {
        pollingOwnerRef.current = null;
      }
    };
    const polling: PollingOwner = { authority, retire };

    pollingOwnerRef.current = polling;
    start(!resumesDismissedUpdate);
    pollingDocument.addEventListener("visibilitychange", onVisibility);
    return retire;
  }, [authority, refreshPublication]);

  const currentPublication =
    documentAuthority &&
    refreshPublication?.document === documentAuthority &&
    refreshPublication.remoteHash.length > 0 &&
    refreshPublication.remoteHash !== documentAuthority.initialHash &&
    !controlCells.invalidRefreshes.has(refreshPublication) &&
    !controlCells.claimedRefreshes.has(refreshPublication)
      ? refreshPublication
      : null;

  useLayoutEffect(() => {
    if (currentPublication) return;
    retireInactiveControl(controlCells);
  }, [controlCells, currentPublication]);

  if (
    !currentPublication ||
    !ownerDocument ||
    !documentAuthority ||
    !authority
  ) {
    return null;
  }
  return (
    <RefreshControl
      mount={mount}
      ownerDocument={ownerDocument}
      docId={docId}
      initialHash={initialHash}
      pollMs={pollMs}
      documentAuthority={documentAuthority}
      pollingAuthority={authority}
      refreshPublication={currentPublication}
      cells={controlCells}
      documentAuthorityRef={documentAuthorityRef}
      pollingAuthorityRef={authorityRef}
      refreshPublicationRef={refreshPublicationRef}
      dismissCurrentPublication={dismissCurrentPublication}
    />
  );
}
