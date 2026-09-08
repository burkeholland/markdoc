"use client";

import { useLayoutEffect, useRef } from "react";

const ROOT_SELECTOR = "[data-reader-overflow-root]";
const REGION_SELECTOR = "pre, table";

type TabIndexValue = string | null;

type RenderVisit = Readonly<{
  identity: symbol;
  contentKey: string;
}>;

type PlacementLink = Readonly<{
  node: Node;
  parent: Node;
  previousSibling: Node | null;
  nextSibling: Node | null;
}>;

type Placement = Readonly<{
  document: Document;
  links: readonly PlacementLink[];
}>;

type GeometryGetter = Readonly<{
  owner: object;
  get: (this: HTMLElement) => number;
}>;

type GeometryReader = Readonly<{
  clientWidth: GeometryGetter;
  scrollWidth: GeometryGetter;
}>;

type OwnTabIndexWrite = Readonly<{
  before: TabIndexValue;
  applied: TabIndexValue;
}>;

type RegionState = {
  initialTabIndex: TabIndexValue;
  currentTabIndex: TabIndexValue;
  owned: boolean;
  externallyOwned: boolean;
  pendingWrites: OwnTabIndexWrite[];
};

type RegionVisit = Readonly<{
  element: HTMLElement;
  tagName: "PRE" | "TABLE";
  placement: Placement;
  geometry: GeometryReader;
  state: RegionState;
}>;

type VisitPresentation = Readonly<{
  markerTagName: string;
  markerHiddenAttribute: string | null;
  markerHidden: boolean;
  markerAriaHidden: string | null;
  markerTabIndex: string | null;
  markerChildCount: number;
  markerText: string;
  markerDisplay: string;
  rootTagName: string;
  rootAttribute: string | null;
}>;

type Retirement = "cleanup" | "mutation" | "authority";

type MutationGuard = Readonly<{
  isStructurallyClean: () => boolean;
  release: () => void;
}>;

type FontReadySubscription = Readonly<{
  identity: symbol;
  ready: Promise<FontFaceSet>;
}>;

type ContentVisit = {
  readonly identity: symbol;
  readonly render: RenderVisit;
  readonly contentKey: string;
  readonly marker: HTMLSpanElement;
  readonly root: HTMLElement;
  readonly regions: readonly RegionVisit[];
  readonly observedTargets: readonly Element[];
  readonly markerPlacement: Placement;
  readonly rootPlacement: Placement;
  readonly presentation: VisitPresentation;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly resizeObserverConstructor: typeof ResizeObserver;
  readonly mutationObserverConstructor: typeof MutationObserver;
  readonly fonts: FontFaceSet;
  readonly fontsReady: Promise<FontFaceSet>;
  readonly getComputedStyle: typeof getComputedStyle;
  guard: MutationGuard | null;
  observer: ResizeObserver | null;
  fontReadySubscription: FontReadySubscription | null;
  observing: boolean;
  retired: boolean;
  retirement: Retirement | null;
  disconnected: boolean;
  releaseScheduled: boolean;
};

type VisitCoordinator = {
  active: ContentVisit | null;
  replay: ContentVisit | null;
};

type VisitCandidate = Omit<
  ContentVisit,
  | "guard"
  | "observer"
  | "fontReadySubscription"
  | "observing"
  | "retired"
  | "retirement"
  | "disconnected"
  | "releaseScheduled"
>;

function exactRegions(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(REGION_SELECTOR));
}

function capturePlacement(node: Node, ownerDocument: Document): Placement | null {
  if (!node.isConnected || node.ownerDocument !== ownerDocument) return null;
  const links: PlacementLink[] = [];
  let current = node;
  while (current !== ownerDocument) {
    const parent = current.parentNode;
    if (!parent) return null;
    links.push(Object.freeze({
      node: current,
      parent,
      previousSibling: current.previousSibling,
      nextSibling: current.nextSibling,
    }));
    current = parent;
  }
  return links.length > 0
    ? Object.freeze({ document: ownerDocument, links: Object.freeze(links) })
    : null;
}

function placementMatches(node: Node, placement: Placement): boolean {
  return (
    node.ownerDocument === placement.document &&
    node.isConnected &&
    placement.links[0]?.node === node &&
    placement.links.every((link) =>
      link.node.isConnected &&
      link.node.parentNode === link.parent &&
      link.node.previousSibling === link.previousSibling &&
      link.node.nextSibling === link.nextSibling
    ) &&
    placement.links.at(-1)?.parent === placement.document
  );
}

function placementsMatch(left: Placement, right: Placement): boolean {
  return (
    left.document === right.document &&
    left.links.length === right.links.length &&
    left.links.every((link, index) => {
      const candidate = right.links[index];
      return Boolean(
        candidate &&
        link.node === candidate.node &&
        link.parent === candidate.parent &&
        link.previousSibling === candidate.previousSibling &&
        link.nextSibling === candidate.nextSibling
      );
    })
  );
}

function captureGeometryGetter(element: HTMLElement, name: "clientWidth" | "scrollWidth"): GeometryGetter | null {
  let owner: object | null = element;
  while (owner) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor) {
      return descriptor.get
        ? Object.freeze({
            owner,
            get: descriptor.get as (this: HTMLElement) => number,
          })
        : null;
    }
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  return null;
}

function geometryGetterMatches(
  element: HTMLElement,
  name: "clientWidth" | "scrollWidth",
  expected: GeometryGetter,
): boolean {
  let owner: object | null = element;
  while (owner) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor) return owner === expected.owner && descriptor.get === expected.get;
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  return false;
}

function captureGeometryReader(element: HTMLElement): GeometryReader | null {
  const clientWidth = captureGeometryGetter(element, "clientWidth");
  const scrollWidth = captureGeometryGetter(element, "scrollWidth");
  return clientWidth && scrollWidth
    ? Object.freeze({ clientWidth, scrollWidth })
    : null;
}

function geometryReaderMatches(region: RegionVisit): boolean {
  return (
    geometryGetterMatches(region.element, "clientWidth", region.geometry.clientWidth) &&
    geometryGetterMatches(region.element, "scrollWidth", region.geometry.scrollWidth)
  );
}

function capturePresentation(
  marker: HTMLSpanElement,
  root: HTMLElement,
  getStyle: typeof getComputedStyle,
): VisitPresentation {
  return Object.freeze({
    markerTagName: marker.tagName,
    markerHiddenAttribute: marker.getAttribute("hidden"),
    markerHidden: marker.hidden,
    markerAriaHidden: marker.getAttribute("aria-hidden"),
    markerTabIndex: marker.getAttribute("tabindex"),
    markerChildCount: marker.childNodes.length,
    markerText: marker.textContent ?? "",
    markerDisplay: getStyle(marker).display,
    rootTagName: root.tagName,
    rootAttribute: root.getAttribute("data-reader-overflow-root"),
  });
}

function presentationIsEligible(presentation: VisitPresentation): boolean {
  return (
    presentation.markerTagName === "SPAN" &&
    presentation.markerHiddenAttribute !== null &&
    presentation.markerHidden &&
    presentation.markerAriaHidden === "true" &&
    presentation.markerTabIndex === null &&
    presentation.markerChildCount === 0 &&
    presentation.markerText === "" &&
    presentation.markerDisplay === "none" &&
    presentation.rootAttribute !== null
  );
}

function presentationMatches(visit: ContentVisit): boolean {
  const { marker, root, presentation } = visit;
  return (
    marker.tagName === presentation.markerTagName &&
    marker.getAttribute("hidden") === presentation.markerHiddenAttribute &&
    marker.hidden === presentation.markerHidden &&
    marker.getAttribute("aria-hidden") === presentation.markerAriaHidden &&
    marker.getAttribute("tabindex") === presentation.markerTabIndex &&
    marker.childNodes.length === presentation.markerChildCount &&
    (marker.textContent ?? "") === presentation.markerText &&
    visit.getComputedStyle(marker).display === presentation.markerDisplay &&
    root.tagName === presentation.rootTagName &&
    root.getAttribute("data-reader-overflow-root") === presentation.rootAttribute &&
    root.matches(ROOT_SELECTOR)
  );
}

function layoutMatches(visit: ContentVisit): boolean {
  if (
    visit.marker.ownerDocument !== visit.ownerDocument ||
    visit.root.ownerDocument !== visit.ownerDocument ||
    visit.ownerDocument.defaultView !== visit.ownerWindow ||
    visit.ownerWindow.ResizeObserver !== visit.resizeObserverConstructor ||
    visit.ownerWindow.MutationObserver !== visit.mutationObserverConstructor ||
    visit.ownerDocument.fonts !== visit.fonts ||
    visit.ownerWindow.getComputedStyle !== visit.getComputedStyle ||
    visit.marker.previousSibling !== visit.root ||
    visit.root.nextSibling !== visit.marker ||
    !placementMatches(visit.marker, visit.markerPlacement) ||
    !placementMatches(visit.root, visit.rootPlacement) ||
    !presentationMatches(visit)
  ) {
    return false;
  }
  const currentRegions = exactRegions(visit.root);
  if (
    currentRegions.length !== visit.regions.length ||
    currentRegions.some((element, index) => element !== visit.regions[index]?.element)
  ) {
    return false;
  }
  return visit.regions.every((region) =>
    region.element.ownerDocument === visit.ownerDocument &&
    region.element.tagName === region.tagName &&
    visit.root.contains(region.element) &&
    placementMatches(region.element, region.placement) &&
    geometryReaderMatches(region)
  );
}

function structuralMutationIsRelevant(visit: ContentVisit, record: MutationRecord): boolean {
  if (record.type === "attributes") {
    if (record.target === visit.marker) return true;
    return (
      record.target === visit.root &&
      (
        record.attributeName === "data-reader-overflow-root" ||
        record.attributeName === "hidden" ||
        record.attributeName === "aria-hidden"
      )
    );
  }
  if (
    record.target === visit.marker ||
    (
      record.target instanceof visit.ownerWindow.Node &&
      visit.marker.contains(record.target)
    ) ||
    record.target === visit.root ||
    (
      record.target instanceof visit.ownerWindow.Node &&
      visit.root.contains(record.target)
    )
  ) {
    return true;
  }
  if (record.type !== "childList") return false;
  const changedNodes = [...record.addedNodes, ...record.removedNodes];
  const placements = [
    visit.markerPlacement,
    visit.rootPlacement,
    ...visit.regions.map((region) => region.placement),
  ];
  return placements.some((placement) =>
    placement.links.some((link) =>
      record.target === link.parent &&
      (
        record.previousSibling === link.node ||
        record.nextSibling === link.node ||
        changedNodes.some((node) =>
          node === link.node ||
          (
            node instanceof visit.ownerWindow.Element &&
            node.contains(link.node)
          )
        )
      )
    )
  );
}

function transferRegionOwnership(region: RegionVisit) {
  region.state.externallyOwned = true;
  region.state.owned = false;
  region.state.pendingWrites.length = 0;
  region.state.currentTabIndex = region.element.getAttribute("tabindex");
}

function recordTabIndexMutation(region: RegionVisit, record: MutationRecord) {
  const pending = region.state.pendingWrites[0];
  if (pending && pending.before === record.oldValue) {
    region.state.pendingWrites.shift();
    return;
  }
  transferRegionOwnership(region);
}

function createMutationGuard(
  visit: ContentVisit,
  coordinator: VisitCoordinator,
): MutationGuard {
  let structurallyChanged = false;
  let released = false;
  const record = (records: readonly MutationRecord[]) => {
    let shouldRetire = false;
    for (const mutation of records) {
      const region = visit.regions.find((candidate) => candidate.element === mutation.target);
      if (
        mutation.type === "attributes" &&
        mutation.attributeName === "tabindex" &&
        region
      ) {
        recordTabIndexMutation(region, mutation);
      } else if (structuralMutationIsRelevant(visit, mutation)) {
        structurallyChanged = true;
        shouldRetire = true;
      }
    }
    if (shouldRetire) retireVisit(visit, coordinator, "mutation");
  };
  const observer = new visit.mutationObserverConstructor(record);
  observer.observe(visit.ownerDocument, {
    attributes: true,
    attributeOldValue: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  return Object.freeze({
    isStructurallyClean: () => {
      record(observer.takeRecords());
      return !structurallyChanged;
    },
    release: () => {
      if (released) return;
      released = true;
      record(observer.takeRecords());
      observer.disconnect();
    },
  });
}

function disconnectObserver(visit: ContentVisit) {
  if (visit.disconnected) return;
  visit.disconnected = true;
  visit.observer?.disconnect();
}

function writeTabIndex(visit: ContentVisit, region: RegionVisit, value: TabIndexValue) {
  const { state, element } = region;
  if (state.externallyOwned) return;
  visit.guard?.isStructurallyClean();
  if (state.externallyOwned || !layoutMatches(visit)) return;
  const current = element.getAttribute("tabindex");
  if (current !== state.currentTabIndex) {
    transferRegionOwnership(region);
    return;
  }
  if (current === value) return;
  state.pendingWrites.push(Object.freeze({ before: current, applied: value }));
  state.currentTabIndex = value;
  if (value === null) element.removeAttribute("tabindex");
  else element.setAttribute("tabindex", value);
  if (element.getAttribute("tabindex") !== value) {
    transferRegionOwnership(region);
    return;
  }
  state.owned = value !== state.initialTabIndex;
  visit.guard?.isStructurallyClean();
  if (state.pendingWrites.length > 0) transferRegionOwnership(region);
}

function scheduleGuardRelease(visit: ContentVisit, coordinator: VisitCoordinator) {
  if (visit.releaseScheduled) return;
  visit.releaseScheduled = true;
  queueMicrotask(() => {
    if (coordinator.replay === visit) coordinator.replay = null;
    visit.guard?.release();
  });
}

function retireVisit(
  visit: ContentVisit,
  coordinator: VisitCoordinator,
  reason: Retirement,
) {
  if (visit.retired) {
    if (reason === "cleanup") scheduleGuardRelease(visit, coordinator);
    return;
  }
  visit.retired = true;
  visit.retirement = reason;
  const wasActive = coordinator.active === visit;
  if (wasActive) coordinator.active = null;
  disconnectObserver(visit);

  if (
    reason === "cleanup" &&
    visit.guard?.isStructurallyClean() &&
    layoutMatches(visit)
  ) {
    for (const region of visit.regions) {
      if (
        !visit.guard.isStructurallyClean() ||
        !layoutMatches(visit)
      ) {
        break;
      }
      const { state, element } = region;
      if (!state.owned || state.externallyOwned) continue;
      if (element.getAttribute("tabindex") !== state.currentTabIndex) {
        transferRegionOwnership(region);
        continue;
      }
      writeTabIndex(visit, region, state.initialTabIndex);
    }
  }

  if (wasActive) {
    coordinator.replay = visit;
  }
  if (reason === "cleanup") {
    scheduleGuardRelease(visit, coordinator);
  }
}

function visitHasAuthority(visit: ContentVisit, coordinator: VisitCoordinator): boolean {
  if (visit.retired || coordinator.active !== visit) return false;
  if (!visit.guard?.isStructurallyClean() || !layoutMatches(visit)) {
    retireVisit(visit, coordinator, "authority");
    return false;
  }
  return true;
}

function syncVisit(visit: ContentVisit, coordinator: VisitCoordinator) {
  if (!visitHasAuthority(visit, coordinator)) return;
  const measurements: Array<Readonly<{
    region: RegionVisit;
    clientWidth: number;
    scrollWidth: number;
  }>> = [];
  for (const region of visit.regions) {
    if (!visitHasAuthority(visit, coordinator)) return;
    if (region.state.externallyOwned) continue;
    if (region.element.getAttribute("tabindex") !== region.state.currentTabIndex) {
      transferRegionOwnership(region);
      continue;
    }
    measurements.push(Object.freeze({
      region,
      clientWidth: region.geometry.clientWidth.get.call(region.element),
      scrollWidth: region.geometry.scrollWidth.get.call(region.element),
    }));
  }
  if (!visitHasAuthority(visit, coordinator)) return;
  for (const measurement of measurements) {
    if (!visitHasAuthority(visit, coordinator)) return;
    writeTabIndex(
      visit,
      measurement.region,
      measurement.scrollWidth > measurement.clientWidth + 1 ? "0" : null,
    );
  }
}

function captureCandidate(
  render: RenderVisit,
  marker: HTMLSpanElement,
): VisitCandidate | null {
  const ownerDocument = marker.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow || !(marker instanceof ownerWindow.HTMLSpanElement)) return null;
  const sibling = marker.previousSibling;
  if (
    !(sibling instanceof ownerWindow.HTMLElement) ||
    !sibling.matches(ROOT_SELECTOR) ||
    sibling.nextSibling !== marker
  ) {
    return null;
  }
  const root = sibling;
  const resizeObserverConstructor = ownerWindow.ResizeObserver;
  const mutationObserverConstructor = ownerWindow.MutationObserver;
  const fonts = ownerDocument.fonts;
  const fontsReady = fonts?.ready;
  if (
    typeof resizeObserverConstructor !== "function" ||
    typeof mutationObserverConstructor !== "function" ||
    !fonts ||
    !fontsReady
  ) {
    return null;
  }
  const markerPlacement = capturePlacement(marker, ownerDocument);
  const rootPlacement = capturePlacement(root, ownerDocument);
  if (!markerPlacement || !rootPlacement) return null;
  const elements = exactRegions(root);
  const regionVisits: RegionVisit[] = [];
  for (const element of elements) {
    const tagName = element.tagName;
    const placement = capturePlacement(element, ownerDocument);
    const geometry = captureGeometryReader(element);
    if (
      (tagName !== "PRE" && tagName !== "TABLE") ||
      !placement ||
      !geometry
    ) {
      return null;
    }
    const initialTabIndex = element.getAttribute("tabindex");
    regionVisits.push(Object.freeze({
      element,
      tagName,
      placement,
      geometry,
      state: {
        initialTabIndex,
        currentTabIndex: initialTabIndex,
        owned: false,
        externallyOwned: false,
        pendingWrites: [],
      },
    }));
  }
  const regions = Object.freeze(regionVisits);
  const getStyle = ownerWindow.getComputedStyle;
  const presentation = capturePresentation(marker, root, getStyle);
  if (!presentationIsEligible(presentation)) return null;
  return {
    identity: Symbol("reader-scrollable-regions-visit"),
    render,
    contentKey: render.contentKey,
    marker,
    root,
    regions,
    observedTargets: Object.freeze([root, ...elements]),
    markerPlacement,
    rootPlacement,
    presentation,
    ownerDocument,
    ownerWindow,
    resizeObserverConstructor,
    mutationObserverConstructor,
    fonts,
    fontsReady,
    getComputedStyle: getStyle,
  };
}

function exactReplayMatches(source: ContentVisit, candidate: ContentVisit): boolean {
  if (
    source.retirement !== "cleanup" ||
    !source.guard?.isStructurallyClean() ||
    !layoutMatches(source) ||
    source.contentKey !== candidate.contentKey ||
    source.marker !== candidate.marker ||
    source.root !== candidate.root ||
    source.ownerDocument !== candidate.ownerDocument ||
    source.ownerWindow !== candidate.ownerWindow ||
    source.resizeObserverConstructor !== candidate.resizeObserverConstructor ||
    source.mutationObserverConstructor !== candidate.mutationObserverConstructor ||
    source.fonts !== candidate.fonts ||
    source.regions.length !== candidate.regions.length ||
    !placementsMatch(source.markerPlacement, candidate.markerPlacement) ||
    !placementsMatch(source.rootPlacement, candidate.rootPlacement)
  ) {
    return false;
  }
  return source.regions.every((region, index) => {
    const next = candidate.regions[index];
    return Boolean(
      next &&
      region.element === next.element &&
      region.tagName === next.tagName &&
      placementsMatch(region.placement, next.placement) &&
      region.state.currentTabIndex === next.state.currentTabIndex
    );
  });
}

function inheritOwnedWrites(source: ContentVisit, candidate: ContentVisit) {
  source.guard?.isStructurallyClean();
  for (const next of candidate.regions) {
    const previous = source.regions.find((region) => region.element === next.element);
    if (
      !previous ||
      previous.state.externallyOwned ||
      !previous.state.owned ||
      next.state.currentTabIndex !== previous.state.currentTabIndex
    ) {
      continue;
    }
    next.state.initialTabIndex = previous.state.initialTabIndex;
    next.state.owned = true;
  }
}

function subscribeFontReadyCycle(
  visit: ContentVisit,
  coordinator: VisitCoordinator,
  ready: Promise<FontFaceSet>,
) {
  const identity = Symbol("reader-scrollable-regions-font-ready");
  const continuation = (source: FontFaceSet) => {
    if (
      visit.retired ||
      coordinator.active !== visit ||
      visit.fontReadySubscription?.identity !== identity
    ) {
      return;
    }
    if (source !== visit.fonts || visit.ownerDocument.fonts !== visit.fonts) {
      retireVisit(visit, coordinator, "authority");
      return;
    }
    if (!ensureCurrentFontReadyCycle(visit, coordinator)) return;
    syncVisit(visit, coordinator);
  };
  const subscription = Object.freeze({
    identity,
    ready,
  });
  visit.fontReadySubscription = subscription;
  void ready.then(continuation);
}

function ensureCurrentFontReadyCycle(
  visit: ContentVisit,
  coordinator: VisitCoordinator,
): boolean {
  if (visit.retired || coordinator.active !== visit) return false;
  if (visit.ownerDocument.fonts !== visit.fonts) {
    retireVisit(visit, coordinator, "authority");
    return false;
  }
  const ready = visit.fonts.ready;
  if (visit.fontReadySubscription?.ready === ready) return true;
  if (!visitHasAuthority(visit, coordinator)) return false;
  subscribeFontReadyCycle(visit, coordinator, ready);
  return false;
}

function establishVisit(
  candidate: VisitCandidate,
  coordinator: VisitCoordinator,
): ContentVisit | null {
  const visit: ContentVisit = {
    ...candidate,
    guard: null,
    observer: null,
    fontReadySubscription: null,
    observing: false,
    retired: false,
    retirement: null,
    disconnected: false,
    releaseScheduled: false,
  };
  visit.guard = createMutationGuard(visit, coordinator);

  const replay = coordinator.replay;
  if (replay) {
    coordinator.replay = null;
    const sameRender = replay.render === visit.render;
    const accepted = !sameRender || exactReplayMatches(replay, visit);
    if (!sameRender) inheritOwnedWrites(replay, visit);
    replay.guard?.release();
    if (!accepted) {
      visit.retired = true;
      visit.retirement = "authority";
      visit.guard.release();
      return null;
    }
    if (sameRender) {
      for (const region of visit.regions) {
        const previous = replay.regions.find((entry) => entry.element === region.element);
        if (previous?.state.externallyOwned) {
          region.state.externallyOwned = true;
        }
      }
    }
  }

  if (visit.retired || !visit.guard.isStructurallyClean() || !layoutMatches(visit)) {
    visit.retired = true;
    visit.retirement = "authority";
    visit.guard.release();
    return null;
  }

  coordinator.active = visit;
  const observer = new visit.resizeObserverConstructor((entries, source) => {
    if (
      visit.retired ||
      coordinator.active !== visit ||
      source !== visit.observer ||
      !visit.observing
    ) {
      return;
    }
    if (entries.some((entry) => !visit.observedTargets.includes(entry.target))) {
      retireVisit(visit, coordinator, "authority");
      return;
    }
    if (!ensureCurrentFontReadyCycle(visit, coordinator)) return;
    syncVisit(visit, coordinator);
  });
  visit.observer = observer;
  for (const target of visit.observedTargets) observer.observe(target);
  visit.observing = true;
  syncVisit(visit, coordinator);
  if (!visitHasAuthority(visit, coordinator)) return visit;
  subscribeFontReadyCycle(visit, coordinator, visit.fontsReady);
  ensureCurrentFontReadyCycle(visit, coordinator);
  return visit;
}

/** Adds a keyboard entry point only while this helper's preceding reader regions overflow. */
export function ReaderScrollableRegions({ contentKey }: { contentKey: string }) {
  const markerRef = useRef<HTMLSpanElement>(null);
  const coordinatorRef = useRef<VisitCoordinator>({ active: null, replay: null });
  const render: RenderVisit = Object.freeze({
    identity: Symbol("reader-scrollable-regions-render"),
    contentKey,
  });

  // The effect intentionally runs for every commit; Strict Mode replays this exact render token.
  useLayoutEffect(() => {
    const coordinator = coordinatorRef.current;
    const marker = markerRef.current;
    const candidate = marker ? captureCandidate(render, marker) : null;
    const replay = coordinator.replay;
    if (!candidate) {
      if (replay) {
        coordinator.replay = null;
        replay.guard?.release();
      }
      return;
    }
    const visit = establishVisit(candidate, coordinator);
    if (!visit) return;
    return () => retireVisit(visit, coordinator, "cleanup");
  });

  return <span ref={markerRef} data-reader-overflow-marker hidden aria-hidden="true" />;
}
