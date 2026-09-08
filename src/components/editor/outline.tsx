"use client";

import { ChevronsLeft, ChevronsRight } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { HeadingInfo } from "@/editor/markdown/parse";
import { useHydrated } from "@/lib/hooks";
import { rovingIndex } from "@/lib/a11y";
import { cn } from "@/lib/utils";
import { useSessionValue } from "./use-session";
import { RAIL_BOX, RAIL_COLLAPSED_BOX } from "./chrome-classes";
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface OutlineProps {
  session: CollabSession;
  open: boolean;
  onToggle: () => void;
  onSelect: (heading: HeadingInfo) => void;
  /** Extra classes for the rail (open) or the collapsed strip, e.g. `max-md:hidden` for the in-shell instance. */
  className?: string;
}

const EMPTY_HEADINGS: HeadingInfo[] = [];

interface OutlineVisit {
  readonly session: CollabSession;
  readonly open: boolean;
  readonly identity: number;
}

interface HeadingPublication {
  readonly index: number;
  readonly heading: HeadingInfo;
  readonly id: string;
  readonly level: number;
  readonly text: string;
  readonly from: number;
  readonly line: number;
}

interface OutlinePresentation {
  readonly mount: symbol;
  readonly visit: OutlineVisit;
  readonly visitIdentity: number;
  readonly session: CollabSession;
  readonly open: boolean;
  readonly hydrated: boolean;
  readonly onToggle: () => void;
  readonly onSelect: (heading: HeadingInfo) => void;
  readonly headings: HeadingInfo[];
  readonly rows: readonly HeadingPublication[];
  readonly active: number;
  readonly tabStop: number;
  readonly minLevel: number;
  readonly revision: number;
}

interface OutlineRowElements {
  item: HTMLLIElement | null;
  button: HTMLButtonElement | null;
}

interface OutlinePresentationRuntime {
  retired: boolean;
  active: boolean;
  root: HTMLElement | null;
  toggle: HTMLButtonElement | null;
  nav: HTMLElement | null;
  list: HTMLUListElement | null;
  rows: OutlineRowElements[];
  proof: OutlineDomProof | null;
  guard: OutlineDomGuard | null;
}

interface OutlineDomNodeProof {
  readonly node: Node;
  readonly parent: Node | null;
  readonly value: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly childCount: number;
}

interface OutlineDomProof {
  readonly root: HTMLElement;
  readonly nodes: readonly OutlineDomNodeProof[];
}

interface OutlineDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface OutlineAuthority {
  readonly presentation: OutlinePresentation;
  readonly runtime: OutlinePresentationRuntime;
  retired: boolean;
  layoutCleaned: boolean;
}

function useOutlineVisit(session: CollabSession, open: boolean): OutlineVisit {
  const [visit, setVisit] = useState<OutlineVisit>(() => Object.freeze({ session, open, identity: 0 }));
  if (visit.session === session && visit.open === open) return visit;
  const next = Object.freeze({ session, open, identity: visit.identity + 1 });
  setVisit(next);
  return next;
}

function snapshotHeading(heading: HeadingInfo, index: number): HeadingPublication {
  return Object.freeze({
    index,
    heading,
    id: heading.id,
    level: heading.level,
    text: heading.text,
    from: heading.from,
    line: heading.line,
  });
}

function headingPublicationIsCurrent(candidate: OutlinePresentation, row: HeadingPublication): boolean {
  const heading = candidate.headings[row.index];
  return (
    candidate.rows[row.index] === row &&
    heading === row.heading &&
    heading.id === row.id &&
    heading.level === row.level &&
    heading.text === row.text &&
    heading.from === row.from &&
    heading.line === row.line
  );
}

function sameHeadings(a: HeadingInfo[], b: HeadingInfo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x !== y || x.id !== y.id || x.from !== y.from || x.line !== y.line || x.level !== y.level || x.text !== y.text) return false;
  }
  return true;
}

function captureDomProof(root: HTMLElement): OutlineDomProof {
  const nodes: OutlineDomNodeProof[] = [];
  const visit = (node: Node) => {
    const element = node.nodeType === 1 ? (node as Element) : null;
    nodes.push(
      Object.freeze({
        node,
        parent: node.parentNode,
        value: node.nodeValue,
        attributes: element
          ? Object.freeze(Array.from(element.attributes, ({ name, value }) => Object.freeze([name, value] as const)))
          : null,
        childCount: node.childNodes.length,
      }),
    );
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return Object.freeze({ root, nodes: Object.freeze(nodes) });
}

function nodeProofMatches(node: Node, proof: OutlineDomNodeProof): boolean {
  if (
    node !== proof.node ||
    node.parentNode !== proof.parent ||
    node.nodeValue !== proof.value ||
    node.childNodes.length !== proof.childCount
  ) {
    return false;
  }
  if (proof.attributes === null) return node.nodeType !== 1;
  if (node.nodeType !== 1) return false;
  const attributes = (node as Element).attributes;
  if (attributes.length !== proof.attributes.length) return false;
  for (let index = 0; index < attributes.length; index++) {
    const expected = proof.attributes[index];
    const actual = attributes.item(index);
    if (!actual || actual.name !== expected[0] || actual.value !== expected[1]) return false;
  }
  return true;
}

function domProofIsCurrent(proof: OutlineDomProof): boolean {
  let index = 0;
  const visit = (node: Node): boolean => {
    const expected = proof.nodes[index++];
    if (!expected || !nodeProofMatches(node, expected)) return false;
    for (const child of node.childNodes) {
      if (!visit(child)) return false;
    }
    return true;
  };
  return proof.root.isConnected && visit(proof.root) && index === proof.nodes.length;
}

function sameDomProof(a: OutlineDomProof, b: OutlineDomProof): boolean {
  if (a.root !== b.root || a.nodes.length !== b.nodes.length) return false;
  for (let index = 0; index < a.nodes.length; index++) {
    const x = a.nodes[index];
    const y = b.nodes[index];
    if (
      x.node !== y.node ||
      x.parent !== y.parent ||
      x.value !== y.value ||
      x.childCount !== y.childCount ||
      x.attributes?.length !== y.attributes?.length
    ) {
      return false;
    }
    for (let attributeIndex = 0; attributeIndex < (x.attributes?.length ?? 0); attributeIndex++) {
      const xAttribute = x.attributes?.[attributeIndex];
      const yAttribute = y.attributes?.[attributeIndex];
      if (xAttribute?.[0] !== yAttribute?.[0] || xAttribute?.[1] !== yAttribute?.[1]) return false;
    }
  }
  return true;
}

function createOutlineDomGuard(proof: OutlineDomProof): OutlineDomGuard | null {
  const root = proof.root;
  const parent = root.parentNode;
  const MutationObserverConstructor = root.ownerDocument.defaultView?.MutationObserver;
  if (!parent || !MutationObserverConstructor) return null;
  let changed = false;
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some((record) => {
      if (record.target === root || root.contains(record.target)) return true;
      if (record.type !== "childList" || record.target !== parent) return false;
      if (record.previousSibling === root || record.nextSibling === root) return true;
      return [...record.addedNodes, ...record.removedNodes].some(
        (node) => node === root || (node.nodeType === 1 && (node as Element).contains(root)),
      );
    });
  };
  const observer = new MutationObserverConstructor(recordChanges);
  observer.observe(root, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  observer.observe(parent, { childList: true });
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

function sameRuntimeElements(a: OutlinePresentationRuntime, b: OutlinePresentationRuntime): boolean {
  return (
    a.root === b.root &&
    a.toggle === b.toggle &&
    a.nav === b.nav &&
    a.list === b.list &&
    a.rows.length === b.rows.length &&
    a.rows.every(
      (elements, index) =>
        elements.item === b.rows[index]?.item &&
        elements.button === b.rows[index]?.button,
    )
  );
}

function runtimePublicationIsComplete(
  candidate: OutlinePresentation,
  runtime: OutlinePresentationRuntime,
): boolean {
  if (!runtime.root || !runtime.toggle || runtime.rows.length !== candidate.rows.length) return false;
  if (!candidate.open) {
    return (
      runtime.nav === null &&
      runtime.list === null &&
      runtime.rows.every(({ item, button }) => item === null && button === null)
    );
  }
  return (
    runtime.nav !== null &&
    runtime.list !== null &&
    runtime.rows.every(({ item, button }) => item !== null && button !== null)
  );
}

function nativeClickFor(
  event: ReactMouseEvent<HTMLButtonElement>,
  source: HTMLButtonElement,
  proof: OutlineDomProof,
): globalThis.MouseEvent | null {
  const ownerWindow = source.ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  const target = event.target;
  if (
    !ownerWindow ||
    !(nativeEvent instanceof ownerWindow.MouseEvent) ||
    nativeEvent.type !== "click" ||
    nativeEvent.eventPhase === ownerWindow.Event.NONE ||
    event.currentTarget !== source ||
    target !== nativeEvent.target ||
    !(target instanceof ownerWindow.Node) ||
    target.ownerDocument !== source.ownerDocument ||
    !source.contains(target) ||
    !nativeEvent.composedPath().includes(source) ||
    !nativeEvent.composedPath().includes(proof.root) ||
    !proof.nodes.some(({ node }) => node === target)
  ) {
    return null;
  }
  return nativeEvent;
}

function nativeKeyFor(
  event: ReactKeyboardEvent<HTMLUListElement>,
  list: HTMLUListElement,
  proof: OutlineDomProof,
): globalThis.KeyboardEvent | null {
  const ownerWindow = list.ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  const target = event.target;
  if (
    !ownerWindow ||
    event.type !== "keydown" ||
    !(nativeEvent instanceof ownerWindow.KeyboardEvent) ||
    nativeEvent.type !== "keydown" ||
    nativeEvent.eventPhase === ownerWindow.Event.NONE ||
    !nativeEvent.bubbles ||
    !nativeEvent.cancelable ||
    nativeEvent.key !== event.key ||
    nativeEvent.altKey !== event.altKey ||
    nativeEvent.ctrlKey !== event.ctrlKey ||
    nativeEvent.metaKey !== event.metaKey ||
    nativeEvent.shiftKey !== event.shiftKey ||
    nativeEvent.repeat !== event.repeat ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.repeat ||
    nativeEvent.isComposing ||
    event.defaultPrevented ||
    nativeEvent.defaultPrevented ||
    event.currentTarget !== list ||
    target !== nativeEvent.target ||
    !(target instanceof ownerWindow.Node) ||
    target.ownerDocument !== list.ownerDocument ||
    !list.contains(target) ||
    !nativeEvent.composedPath().includes(list) ||
    !nativeEvent.composedPath().includes(proof.root) ||
    !proof.nodes.some(({ node }) => node === target)
  ) {
    return null;
  }
  return nativeEvent;
}

export function useHeadings(session: CollabSession): HeadingInfo[] {
  return useSessionValue(session, (s) => s.binding.getHeadings(), sameHeadings);
}

export function activeHeadingIndex(headings: HeadingInfo[], cursor: number | null): number {
  if (cursor === null || headings.length === 0) return -1;
  let idx = -1;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].from <= cursor) idx = i;
    else break;
  }
  return idx;
}

/** Index the arrow/Home/End keys should focus next, or -1 if the key is not a navigation key. */
export function nextOutlineIndex(key: string, current: number, count: number): number {
  return rovingIndex(key, current, count, { orientation: "vertical", wrap: true });
}

export function OutlinePanel({ session, open, onToggle, onSelect, className }: OutlineProps) {
  const visit = useOutlineVisit(session, open);
  const [mount] = useState(() => Symbol("outline"));
  const [revision, setRevision] = useState(0);
  // IndexedDB can fill the document before React hydrates; keep the first client render
  // identical to the server (no headings) and switch in the next render.
  const hydrated = useHydrated();
  const liveHeadings = useHeadings(session);
  const headings = hydrated ? liveHeadings : EMPTY_HEADINGS;
  // Only the active index matters: the panel re-renders when the caret crosses a heading, not per keystroke.
  const active = useSessionValue(session, (s) => activeHeadingIndex(headings, s.cursorSource));
  const rows = Object.freeze(headings.map(snapshotHeading));
  const minLevel = rows.reduce((minimum, row) => Math.min(minimum, row.level), 6);
  // Roving tabindex: the active heading (or the first one) is the list's single tab stop.
  const tabStop = active >= 0 ? active : 0;
  // Equal-looking renders remain distinct authorities so retained handlers cannot cross a commit boundary.
  const presentation: OutlinePresentation = Object.freeze({
    mount,
    visit,
    visitIdentity: visit.identity,
    session,
    open,
    hydrated,
    onToggle,
    onSelect,
    headings,
    rows,
    active,
    tabStop,
    minLevel,
    revision,
  });

  const activeAuthorityRef = useRef<OutlineAuthority | null>(null);
  const lastCommittedAuthorityRef = useRef<OutlineAuthority | null>(null);
  const presentationRuntimesRef = useRef(new WeakMap<OutlinePresentation, OutlinePresentationRuntime>());
  const disqualifiedPresentationsRef = useRef(new WeakSet<OutlinePresentation>());
  const replayedPresentationsRef = useRef(new WeakSet<OutlinePresentation>());
  const supersededPresentationsRef = useRef(new WeakSet<OutlinePresentation>());
  const claimedNativeEventsRef = useRef(new WeakSet<Event>());
  const revealedPresentationsRef = useRef(new WeakSet<OutlinePresentation>());
  const callbackReplayWindowRef = useRef<OutlinePresentation | null>(null);

  const runtimeForBinding = useCallback((candidate: OutlinePresentation) => {
    const runtimes = presentationRuntimesRef.current;
    let runtime = runtimes.get(candidate);
    if (!runtime || runtime.retired) {
      runtime = {
        retired: false,
        active: false,
        root: null,
        toggle: null,
        nav: null,
        list: null,
        rows: candidate.rows.map(() => ({ item: null, button: null })),
        proof: null,
        guard: null,
      };
      runtimes.set(candidate, runtime);
    }
    return runtime;
  }, []);

  const retireRuntime = useCallback((runtime: OutlinePresentationRuntime) => {
    runtime.guard?.release();
    runtime.guard = null;
    runtime.active = false;
    runtime.retired = true;
    const authority = activeAuthorityRef.current;
    if (authority?.runtime === runtime) {
      authority.retired = true;
      activeAuthorityRef.current = null;
    }
  }, []);

  const retirePresentation = useCallback((candidate: OutlinePresentation) => {
    const runtime = presentationRuntimesRef.current.get(candidate);
    if (runtime) retireRuntime(runtime);
  }, [retireRuntime]);

  const presentationDomIsValid = useCallback((candidate: OutlinePresentation, runtime: OutlinePresentationRuntime, requireProof: boolean) => {
    if (
      candidate.mount !== mount ||
      candidate.visit.session !== candidate.session ||
      candidate.visit.open !== candidate.open ||
      candidate.visit.identity !== candidate.visitIdentity ||
      candidate.rows.length !== candidate.headings.length ||
      candidate.active !== activeHeadingIndex(candidate.headings, candidate.session.cursorSource) ||
      candidate.tabStop !== (candidate.active >= 0 ? candidate.active : 0) ||
      runtime.retired ||
      (requireProof && (!runtime.proof || !domProofIsCurrent(runtime.proof)))
    ) {
      return false;
    }

    let expectedMinLevel = 6;
    for (const row of candidate.rows) {
      if (!headingPublicationIsCurrent(candidate, row)) return false;
      expectedMinLevel = Math.min(expectedMinLevel, row.level);
    }
    if (candidate.minLevel !== expectedMinLevel) return false;

    const root = runtime.root;
    const toggle = runtime.toggle;
    const ownerDocument = root?.ownerDocument;
    if (
      !root?.isConnected ||
      !toggle?.isConnected ||
      !ownerDocument?.defaultView ||
      toggle.ownerDocument !== ownerDocument ||
      toggle.disabled ||
      toggle.type !== "button"
    ) {
      return false;
    }

    if (!candidate.open) {
      return (
        root instanceof HTMLDivElement &&
        root.children.length === 1 &&
        root.firstElementChild === toggle &&
        toggle.parentElement === root &&
        toggle.getAttribute("aria-label") === "Show outline" &&
        toggle.title === "Show outline" &&
        runtime.nav === null &&
        runtime.list === null &&
        runtime.rows.every((elements) => elements.item === null && elements.button === null)
      );
    }

    const nav = runtime.nav;
    const list = runtime.list;
    const header = root.firstElementChild;
    if (
      root.tagName !== "ASIDE" ||
      root.children.length !== 2 ||
      !(header instanceof HTMLDivElement) ||
      header.parentElement !== root ||
      !nav?.isConnected ||
      nav.parentElement !== root ||
      root.children.item(1) !== nav ||
      header.children.length !== 2 ||
      header.lastElementChild !== toggle ||
      toggle.parentElement !== header ||
      toggle.getAttribute("aria-label") !== "Hide outline" ||
      toggle.title !== "Hide outline" ||
      !list?.isConnected ||
      nav.ownerDocument !== ownerDocument ||
      list.ownerDocument !== ownerDocument ||
      list.parentElement !== nav ||
      nav.firstElementChild !== list ||
      nav.children.length !== (candidate.hydrated && candidate.rows.length === 0 ? 2 : 1) ||
      list.children.length !== candidate.rows.length ||
      runtime.rows.length !== candidate.rows.length
    ) {
      return false;
    }

    for (const row of candidate.rows) {
      const elements = runtime.rows[row.index];
      const item = elements?.item;
      const button = elements?.button;
      const isActive = row.index === candidate.active;
      if (
        !(item instanceof HTMLLIElement) ||
        !item.isConnected ||
        !button?.isConnected ||
        item.ownerDocument !== ownerDocument ||
        button.ownerDocument !== ownerDocument ||
        button.disabled ||
        button.type !== "button" ||
        list.children.item(row.index) !== item ||
        item.parentElement !== list ||
        item.children.length !== 1 ||
        item.firstElementChild !== button ||
        button.parentElement !== item ||
        button.getAttribute("data-outline-item") === null ||
        button.tabIndex !== (row.index === candidate.tabStop ? 0 : -1) ||
        button.getAttribute("aria-current") !== (isActive ? "location" : null) ||
        button.getAttribute("data-active") !== (isActive ? "true" : null) ||
        button.style.paddingLeft !== `${24 + (row.level - candidate.minLevel) * 14}px`
      ) {
        return false;
      }
    }
    return true;
  }, [mount]);

  const presentationIsCurrent = useCallback(
    (candidate: OutlinePresentation, runtime: OutlinePresentationRuntime) => {
      const authority = activeAuthorityRef.current;
      return (
        authority?.presentation === candidate &&
        authority.runtime === runtime &&
        !authority.retired &&
        !runtime.retired &&
        runtime.active &&
        runtime.guard?.isClean() === true &&
        presentationRuntimesRef.current.get(candidate) === runtime &&
        presentationDomIsValid(candidate, runtime, true)
      );
    },
    [presentationDomIsValid],
  );

  const admitCallbackReplay = useCallback(
    (candidate: OutlinePresentation) => {
      const current = activeAuthorityRef.current;
      if (current?.presentation === candidate && presentationIsCurrent(candidate, current.runtime)) return;

      const before = lastCommittedAuthorityRef.current;
      const runtime = presentationRuntimesRef.current.get(candidate);
      if (
        callbackReplayWindowRef.current !== candidate ||
        !before ||
        before.presentation !== candidate ||
        !before.retired ||
        before.layoutCleaned ||
        before.runtime === runtime ||
        !before.runtime.proof ||
        !runtime ||
        runtime.retired ||
        !runtimePublicationIsComplete(candidate, runtime) ||
        replayedPresentationsRef.current.has(candidate) ||
        supersededPresentationsRef.current.has(candidate) ||
        disqualifiedPresentationsRef.current.has(candidate)
      ) {
        return;
      }

      if (!presentationDomIsValid(candidate, runtime, false)) {
        retireRuntime(runtime);
        disqualifiedPresentationsRef.current.add(candidate);
        callbackReplayWindowRef.current = null;
        return;
      }
      const proof = captureDomProof(runtime.root!);
      if (
        !sameRuntimeElements(before.runtime, runtime) ||
        !sameDomProof(before.runtime.proof, proof)
      ) {
        retireRuntime(runtime);
        disqualifiedPresentationsRef.current.add(candidate);
        callbackReplayWindowRef.current = null;
        return;
      }

      runtime.proof = proof;
      runtime.guard = createOutlineDomGuard(proof);
      if (!runtime.guard) {
        retireRuntime(runtime);
        disqualifiedPresentationsRef.current.add(candidate);
        callbackReplayWindowRef.current = null;
        return;
      }
      runtime.active = true;
      const authority: OutlineAuthority = {
        presentation: candidate,
        runtime,
        retired: false,
        layoutCleaned: false,
      };
      activeAuthorityRef.current = authority;
      lastCommittedAuthorityRef.current = authority;
      replayedPresentationsRef.current.add(candidate);
      callbackReplayWindowRef.current = null;
      if (!presentationIsCurrent(candidate, runtime)) {
        retireRuntime(runtime);
        disqualifiedPresentationsRef.current.add(candidate);
      }
    },
    [presentationDomIsValid, presentationIsCurrent, retireRuntime],
  );

  const bindRoot = useCallback(
    (candidate: OutlinePresentation, element: HTMLElement | null) => {
      if (element) {
        const runtime = runtimeForBinding(candidate);
        if (runtime.root === null) runtime.root = element;
        else if (runtime.root !== element) retireRuntime(runtime);
        if (!runtime.retired) admitCallbackReplay(candidate);
      } else {
        const runtime = presentationRuntimesRef.current.get(candidate);
        if (runtime?.root) retireRuntime(runtime);
      }
    },
    [admitCallbackReplay, retireRuntime, runtimeForBinding],
  );

  const bindToggle = useCallback(
    (candidate: OutlinePresentation, element: HTMLButtonElement | null) => {
      if (element) {
        const runtime = runtimeForBinding(candidate);
        if (runtime.toggle === null) runtime.toggle = element;
        else if (runtime.toggle !== element) retireRuntime(runtime);
        if (!runtime.retired) admitCallbackReplay(candidate);
      } else {
        const runtime = presentationRuntimesRef.current.get(candidate);
        if (runtime?.toggle) retireRuntime(runtime);
      }
    },
    [admitCallbackReplay, retireRuntime, runtimeForBinding],
  );

  const bindNav = useCallback(
    (candidate: OutlinePresentation, element: HTMLElement | null) => {
      if (element) {
        const runtime = runtimeForBinding(candidate);
        if (runtime.nav === null) runtime.nav = element;
        else if (runtime.nav !== element) retireRuntime(runtime);
        if (!runtime.retired) admitCallbackReplay(candidate);
      } else {
        const runtime = presentationRuntimesRef.current.get(candidate);
        if (runtime?.nav) retireRuntime(runtime);
      }
    },
    [admitCallbackReplay, retireRuntime, runtimeForBinding],
  );

  const bindList = useCallback(
    (candidate: OutlinePresentation, element: HTMLUListElement | null) => {
      if (element) {
        const runtime = runtimeForBinding(candidate);
        if (runtime.list === null) runtime.list = element;
        else if (runtime.list !== element) retireRuntime(runtime);
        if (!runtime.retired) admitCallbackReplay(candidate);
      } else {
        const runtime = presentationRuntimesRef.current.get(candidate);
        if (runtime?.list) retireRuntime(runtime);
      }
    },
    [admitCallbackReplay, retireRuntime, runtimeForBinding],
  );

  const bindRowElement = useCallback(
    <K extends keyof OutlineRowElements>(
      candidate: OutlinePresentation,
      row: HeadingPublication,
      control: K,
      element: OutlineRowElements[K],
    ) => {
      const runtime = runtimeForBinding(candidate);
      const elements = runtime.rows[row.index];
      if (!elements) {
        retireRuntime(runtime);
        return;
      }
      if (element) {
        if (elements[control] === null) elements[control] = element;
        else if (elements[control] !== element) retireRuntime(runtime);
        if (!runtime.retired) admitCallbackReplay(candidate);
      } else if (elements[control]) {
        retireRuntime(runtime);
      }
    },
    [admitCallbackReplay, retireRuntime, runtimeForBinding],
  );

  const claimToggle = useCallback(
    (candidate: OutlinePresentation, event: ReactMouseEvent<HTMLButtonElement>) => {
      const runtime = presentationRuntimesRef.current.get(candidate);
      const source = event.currentTarget;
      if (
        !runtime ||
        runtime?.toggle !== source ||
        source.disabled ||
        !runtime.proof
      ) {
        return false;
      }
      if (!presentationIsCurrent(candidate, runtime)) {
        retirePresentation(candidate);
        return false;
      }
      const nativeEvent = nativeClickFor(event, source, runtime.proof);
      if (!nativeEvent || claimedNativeEventsRef.current.has(nativeEvent)) return false;
      claimedNativeEventsRef.current.add(nativeEvent);
      return true;
    },
    [presentationIsCurrent, retirePresentation],
  );

  const claimHeading = useCallback(
    (candidate: OutlinePresentation, row: HeadingPublication, event: ReactMouseEvent<HTMLButtonElement>) => {
      const runtime = presentationRuntimesRef.current.get(candidate);
      const source = event.currentTarget;
      if (
        !runtime ||
        candidate.rows[row.index] !== row ||
        runtime?.rows[row.index]?.button !== source ||
        source.disabled ||
        !runtime.proof
      ) {
        return false;
      }
      if (!presentationIsCurrent(candidate, runtime)) {
        retirePresentation(candidate);
        return false;
      }
      const nativeEvent = nativeClickFor(event, source, runtime.proof);
      if (!nativeEvent || claimedNativeEventsRef.current.has(nativeEvent)) return false;
      claimedNativeEventsRef.current.add(nativeEvent);
      return true;
    },
    [presentationIsCurrent, retirePresentation],
  );

  const claimListKey = useCallback(
    (candidate: OutlinePresentation, event: ReactKeyboardEvent<HTMLUListElement>) => {
      if (nextOutlineIndex(event.key, 0, candidate.rows.length) < 0) return null;
      const runtime = presentationRuntimesRef.current.get(candidate);
      const list = event.currentTarget;
      const proof = runtime?.proof;
      const ownerWindow = list.ownerDocument.defaultView;
      const nativeEvent = proof ? nativeKeyFor(event, list, proof) : null;
      if (
        !runtime ||
        runtime.list !== list ||
        !ownerWindow ||
        !(event.target instanceof ownerWindow.HTMLButtonElement) ||
        event.target !== list.ownerDocument.activeElement ||
        !nativeEvent ||
        claimedNativeEventsRef.current.has(nativeEvent) ||
        !runtime.rows.some(({ button }) => button === event.target)
      ) {
        return null;
      }
      const current = runtime.rows.findIndex(({ button }) => button === event.target);
      const next = nextOutlineIndex(event.key, current, runtime.rows.length);
      const source = runtime.rows[current]?.button;
      const destination = runtime.rows[next]?.button;
      if (
        current < 0 ||
        next < 0 ||
        source !== event.target ||
        source.disabled ||
        !source.isConnected ||
        !destination?.isConnected ||
        destination.disabled
      ) {
        return null;
      }
      if (!presentationIsCurrent(candidate, runtime)) {
        retirePresentation(candidate);
        return null;
      }
      claimedNativeEventsRef.current.add(nativeEvent);
      return destination;
    },
    [presentationIsCurrent, retirePresentation],
  );

  useLayoutEffect(() => {
    const existing = activeAuthorityRef.current;
    if (existing && existing.presentation !== presentation) {
      supersededPresentationsRef.current.add(existing.presentation);
      retireRuntime(existing.runtime);
    }
    const before = lastCommittedAuthorityRef.current;
    if (before && before.presentation !== presentation) {
      supersededPresentationsRef.current.add(before.presentation);
    }

    const runtime = presentationRuntimesRef.current.get(presentation);
    if (
      !runtime ||
      supersededPresentationsRef.current.has(presentation) ||
      disqualifiedPresentationsRef.current.has(presentation) ||
      !presentationDomIsValid(presentation, runtime, false)
    ) {
      if (runtime) retireRuntime(runtime);
      disqualifiedPresentationsRef.current.add(presentation);
      lastCommittedAuthorityRef.current = null;
      return () => retirePresentation(presentation);
    }

    const proof = captureDomProof(runtime.root!);
    if (before?.presentation === presentation) {
      if (
        before.runtime === runtime ||
        !before.retired ||
        !before.layoutCleaned ||
        replayedPresentationsRef.current.has(presentation) ||
        !before.runtime.proof ||
        !sameRuntimeElements(before.runtime, runtime) ||
        !sameDomProof(before.runtime.proof, proof)
      ) {
        retireRuntime(runtime);
        disqualifiedPresentationsRef.current.add(presentation);
        lastCommittedAuthorityRef.current = null;
        return () => retirePresentation(presentation);
      }
      replayedPresentationsRef.current.add(presentation);
    }

    runtime.proof = proof;
    runtime.guard = createOutlineDomGuard(proof);
    if (!runtime.guard) {
      retireRuntime(runtime);
      disqualifiedPresentationsRef.current.add(presentation);
      lastCommittedAuthorityRef.current = null;
      return () => retirePresentation(presentation);
    }
    const authority: OutlineAuthority = {
      presentation,
      runtime,
      retired: false,
      layoutCleaned: false,
    };
    runtime.active = true;
    activeAuthorityRef.current = authority;
    lastCommittedAuthorityRef.current = authority;

    if (!presentationDomIsValid(presentation, runtime, true)) {
      retireRuntime(runtime);
      disqualifiedPresentationsRef.current.add(presentation);
      lastCommittedAuthorityRef.current = null;
      return () => retirePresentation(presentation);
    }

    if (
      presentation.open &&
      presentation.hydrated &&
      presentation.active >= 0 &&
      before &&
      before.presentation !== presentation &&
      before.presentation.session === presentation.session &&
      before.presentation.open &&
      before.presentation.hydrated === presentation.hydrated &&
      before.presentation.headings === presentation.headings &&
      before.presentation.active !== presentation.active &&
      !revealedPresentationsRef.current.has(presentation)
    ) {
      const beforeRuntime = before.runtime;
      const activeButton = runtime.rows[presentation.active]?.button;
      if (
        sameRuntimeElements(beforeRuntime, runtime) &&
        activeButton &&
        presentationIsCurrent(presentation, runtime)
      ) {
        revealedPresentationsRef.current.add(presentation);
        activeButton.scrollIntoView({ block: "nearest" });
      }
    }

    return () => {
      authority.layoutCleaned = true;
      retireRuntime(runtime);
    };
  }, [
    presentation,
    presentationDomIsValid,
    presentationIsCurrent,
    retirePresentation,
    retireRuntime,
  ]);

  useEffect(() => {
    const authority = activeAuthorityRef.current;
    if (
      replayedPresentationsRef.current.has(presentation) ||
      !authority ||
      authority.presentation !== presentation ||
      !presentationIsCurrent(presentation, authority.runtime)
    ) {
      return;
    }
    callbackReplayWindowRef.current = presentation;
    queueMicrotask(() => {
      if (callbackReplayWindowRef.current === presentation) {
        callbackReplayWindowRef.current = null;
      }
    });
  }, [presentation, presentationIsCurrent]);

  const toggle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!claimToggle(presentation, event)) return;
    presentation.onToggle();
  };

  if (!open) {
    return (
      <div
        ref={(element) => bindRoot(presentation, element)}
        className={cn(RAIL_COLLAPSED_BOX, className)}
        data-testid="outline-collapsed"
      >
        <button
          ref={(element) => bindToggle(presentation, element)}
          type="button"
          className="icon-btn h-8 w-8"
          onClick={toggle}
          aria-label="Show outline"
          title="Show outline"
        >
          <ChevronsRight size={16} />
        </button>
      </div>
    );
  }

  return (
    // max-h-full: inside the phone drawer (a fixed-height flex column) a long outline must scroll in the
    // nav instead of growing past the viewport; on the desktop row it already stretches to the main height.
    <aside
      ref={(element) => bindRoot(presentation, element)}
      className={cn(RAIL_BOX, className)}
      data-testid="outline"
    >
      <div className="flex h-12 items-center justify-between pl-6 pr-2">
        <span className="pane-label">Outline</span>
        <button
          ref={(element) => bindToggle(presentation, element)}
          type="button"
          className="icon-btn h-8 w-8"
          onClick={toggle}
          aria-label="Hide outline"
          title="Hide outline"
        >
          <ChevronsLeft size={16} />
        </button>
      </div>
      <nav
        ref={(element) => bindNav(presentation, element)}
        className="scrollbar-thin flex-1 overflow-y-auto pb-6 pr-2"
        aria-label="Document outline"
      >
        <OutlineList
          presentation={presentation}
          bindList={bindList}
          bindRowElement={bindRowElement}
          claimHeading={claimHeading}
          claimListKey={claimListKey}
          republish={() => setRevision((current) => current + 1)}
        />
        {hydrated && headings.length === 0 && <p className="px-6 pt-1 text-[13px] leading-5 text-ink-4">Headings you add will show up here.</p>}
      </nav>
    </aside>
  );
}

/**
 * The heading list only depends on the committed headings and active index, not on the cursor offset,
 * so typing inside a section does not re-render a 140-item list on every keystroke (task #357).
 */
const OutlineList = memo(function OutlineList({
  presentation,
  bindList,
  bindRowElement,
  claimHeading,
  claimListKey,
  republish,
}: {
  presentation: OutlinePresentation;
  bindList: (presentation: OutlinePresentation, element: HTMLUListElement | null) => void;
  bindRowElement: <K extends keyof OutlineRowElements>(
    presentation: OutlinePresentation,
    row: HeadingPublication,
    control: K,
    element: OutlineRowElements[K],
  ) => void;
  claimHeading: (
    presentation: OutlinePresentation,
    row: HeadingPublication,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => boolean;
  claimListKey: (
    presentation: OutlinePresentation,
    event: ReactKeyboardEvent<HTMLUListElement>,
  ) => HTMLButtonElement | null;
  republish: () => void;
}) {
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const destination = claimListKey(presentation, event);
    if (!destination) return;
    republish();
    event.preventDefault();
    destination.focus({ preventScroll: true });
  };

  return (
    <ul
      ref={(element) => bindList(presentation, element)}
      className="flex flex-col"
      onKeyDown={onListKeyDown}
    >
      {presentation.rows.map((row) => (
        <li
          key={`${presentation.visitIdentity}-${row.id}-${row.from}-${row.index}`}
          ref={(element) => bindRowElement(presentation, row, "item", element)}
        >
          <button
            type="button"
            ref={(element) => bindRowElement(presentation, row, "button", element)}
            onClick={(event) => {
              if (claimHeading(presentation, row, event)) {
                presentation.onSelect(row.heading);
              }
            }}
            className={cn(
              "relative flex w-full items-start truncate py-2.5 pr-3 text-left text-[15px] leading-5 transition-colors hover:text-ink",
              row.index === presentation.active ? "font-medium text-accent" : "text-ink-2",
            )}
            style={{ paddingLeft: 24 + (row.level - presentation.minLevel) * 14 }}
            data-active={row.index === presentation.active || undefined}
            data-outline-item
            aria-current={row.index === presentation.active ? "location" : undefined}
            tabIndex={row.index === presentation.tabStop ? 0 : -1}
          >
            {row.index === presentation.active && <span className="absolute left-0 top-1.5 h-7 w-[3px] rounded-r bg-accent" aria-hidden />}
            <span className="truncate">{row.text || "Untitled"}</span>
          </button>
        </li>
      ))}
    </ul>
  );
});
