"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";

const ROOT_SELECTOR = "[data-reader-overflow-root]";
const REGION_SELECTOR = "pre, table";

type TabIndexMutation = {
  before: string | null;
  applied: string | null;
};

type ContentVisit = {
  contentKey: string;
  marker: HTMLSpanElement;
  root: HTMLElement | null;
  regions: readonly HTMLElement[];
  observer: ResizeObserver | null;
  fontsReadyContinuation: (() => void) | null;
  mutations: Map<HTMLElement, TabIndexMutation>;
  active: boolean;
  disconnected: boolean;
};

function exactRegions(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(REGION_SELECTOR));
}

function stillHasExactRegions(visit: ContentVisit): boolean {
  if (!visit.root) return true;
  const regions = exactRegions(visit.root);
  return regions.length === visit.regions.length && regions.every((region, index) => region === visit.regions[index]);
}

function stillHasExactDom(visit: ContentVisit): boolean {
  return visit.marker.previousElementSibling === visit.root && stillHasExactRegions(visit);
}

function ownsExactDom(visit: ContentVisit, ownerRef: RefObject<ContentVisit | null>): boolean {
  return visit.active && ownerRef.current === visit && stillHasExactDom(visit);
}

function applyTabIndex(visit: ContentVisit, region: HTMLElement, value: string | null) {
  const current = region.getAttribute("tabindex");
  if (current === value) return;
  const mutation = visit.mutations.get(region) ?? { before: current, applied: current };
  visit.mutations.set(region, mutation);
  if (value === null) region.removeAttribute("tabindex");
  else region.setAttribute("tabindex", value);
  mutation.applied = value;
}

function syncVisit(visit: ContentVisit, ownerRef: RefObject<ContentVisit | null>) {
  if (!ownsExactDom(visit, ownerRef)) return;
  for (const region of visit.regions) {
    if (!ownsExactDom(visit, ownerRef)) return;
    applyTabIndex(visit, region, region.scrollWidth > region.clientWidth + 1 ? "0" : null);
  }
}

function retireVisit(visit: ContentVisit, ownerRef: RefObject<ContentVisit | null>) {
  if (!visit.active) return;
  const restore = ownerRef.current === visit && stillHasExactRegions(visit);
  visit.active = false;
  if (!visit.disconnected) {
    visit.disconnected = true;
    visit.observer?.disconnect();
  }
  if (restore) {
    for (const [region, mutation] of visit.mutations) {
      if (ownerRef.current !== visit || !stillHasExactRegions(visit)) break;
      const current = region.getAttribute("tabindex");
      if (current !== mutation.applied || current === mutation.before) continue;
      if (mutation.before === null) region.removeAttribute("tabindex");
      else region.setAttribute("tabindex", mutation.before);
    }
  }
  if (ownerRef.current === visit) ownerRef.current = null;
}

/** Adds a keyboard entry point only while this helper's preceding reader regions overflow. */
export function ReaderScrollableRegions({ contentKey }: { contentKey: string }) {
  const markerRef = useRef<HTMLSpanElement>(null);
  const ownerRef = useRef<ContentVisit | null>(null);

  // Every commit is a distinct visit: the key can stay equal while React replaces the root or its regions.
  useLayoutEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    const sibling = marker.previousElementSibling;
    const root = sibling instanceof HTMLElement && sibling.matches(ROOT_SELECTOR) ? sibling : null;
    const regions = root ? exactRegions(root) : [];
    const visit: ContentVisit = {
      contentKey,
      marker,
      root,
      regions,
      observer: null,
      fontsReadyContinuation: null,
      mutations: new Map(),
      active: true,
      disconnected: false,
    };
    ownerRef.current = visit;

    if (root) {
      const sync = () => syncVisit(visit, ownerRef);
      visit.observer = new ResizeObserver(sync);
      sync();
      visit.observer.observe(root);
      regions.forEach((region) => visit.observer?.observe(region));
      visit.fontsReadyContinuation = sync;
      void document.fonts.ready.then(visit.fontsReadyContinuation);
    }

    return () => retireVisit(visit, ownerRef);
  });

  return <span ref={markerRef} data-reader-overflow-marker hidden aria-hidden="true" />;
}
