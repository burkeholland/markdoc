"use client";

import { ChevronsLeft, ChevronsRight } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { HeadingInfo } from "@/editor/markdown/parse";
import { useHydrated } from "@/lib/hooks";
import { rovingIndex } from "@/lib/a11y";
import { cn } from "@/lib/utils";
import { useSessionValue } from "./use-session";
import { RAIL_BOX, RAIL_COLLAPSED_BOX } from "./chrome-classes";
import { memo, type KeyboardEvent, type MouseEvent, useCallback, useLayoutEffect, useRef, useState } from "react";

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
  session: CollabSession;
  open: boolean;
  identity: number;
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
  active: boolean;
  root: HTMLElement | null;
  toggle: HTMLButtonElement | null;
  nav: HTMLElement | null;
  list: HTMLUListElement | null;
  rows: OutlineRowElements[];
}

function useOutlineVisit(session: CollabSession, open: boolean): OutlineVisit {
  const [visit, setVisit] = useState<OutlineVisit>(() => ({ session, open, identity: 0 }));
  if (visit.session === session && visit.open === open) return visit;
  const next = { session, open, identity: visit.identity + 1 };
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
  return rovingIndex(key, current, count, { orientation: "vertical", wrap: false });
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

  const activePresentationRef = useRef<OutlinePresentation | null>(null);
  const lastCommittedPresentationRef = useRef<OutlinePresentation | null>(null);
  const presentationRuntimesRef = useRef(new WeakMap<OutlinePresentation, OutlinePresentationRuntime>());
  const claimedTogglePresentationsRef = useRef(new WeakSet<OutlinePresentation>());
  const claimedListPresentationsRef = useRef(new WeakSet<OutlinePresentation>());
  const claimedRowsRef = useRef(new WeakSet<HeadingPublication>());
  const revealedPresentationsRef = useRef(new WeakSet<OutlinePresentation>());

  const runtimeFor = useCallback((candidate: OutlinePresentation) => {
    const runtimes = presentationRuntimesRef.current;
    let runtime = runtimes.get(candidate);
    if (!runtime) {
      runtime = {
        active: false,
        root: null,
        toggle: null,
        nav: null,
        list: null,
        rows: candidate.rows.map(() => ({ item: null, button: null })),
      };
      runtimes.set(candidate, runtime);
    }
    return runtime;
  }, []);

  const retirePresentation = useCallback((candidate: OutlinePresentation) => {
    const runtime = presentationRuntimesRef.current.get(candidate);
    if (runtime) runtime.active = false;
    if (activePresentationRef.current === candidate) activePresentationRef.current = null;
  }, []);

  const bindRoot = useCallback(
    (candidate: OutlinePresentation, element: HTMLElement | null) => {
      const runtime = runtimeFor(candidate);
      if (element) {
        if (!runtime.active || runtime.root === null || runtime.root === element) runtime.root = element;
      } else {
        retirePresentation(candidate);
      }
    },
    [retirePresentation, runtimeFor],
  );

  const bindToggle = useCallback(
    (candidate: OutlinePresentation, element: HTMLButtonElement | null) => {
      const runtime = runtimeFor(candidate);
      if (element) {
        if (!runtime.active || runtime.toggle === null || runtime.toggle === element) runtime.toggle = element;
      } else {
        retirePresentation(candidate);
      }
    },
    [retirePresentation, runtimeFor],
  );

  const bindNav = useCallback(
    (candidate: OutlinePresentation, element: HTMLElement | null) => {
      const runtime = runtimeFor(candidate);
      if (element) {
        if (!runtime.active || runtime.nav === null || runtime.nav === element) runtime.nav = element;
      } else {
        retirePresentation(candidate);
      }
    },
    [retirePresentation, runtimeFor],
  );

  const bindList = useCallback(
    (candidate: OutlinePresentation, element: HTMLUListElement | null) => {
      const runtime = runtimeFor(candidate);
      if (element) {
        if (!runtime.active || runtime.list === null || runtime.list === element) runtime.list = element;
      } else {
        retirePresentation(candidate);
      }
    },
    [retirePresentation, runtimeFor],
  );

  const bindRowElement = useCallback(
    <K extends keyof OutlineRowElements>(
      candidate: OutlinePresentation,
      row: HeadingPublication,
      control: K,
      element: OutlineRowElements[K],
    ) => {
      const runtime = runtimeFor(candidate);
      const elements = runtime.rows[row.index];
      if (element) {
        if (!runtime.active || elements[control] === null || elements[control] === element) {
          elements[control] = element;
        }
      } else {
        retirePresentation(candidate);
      }
    },
    [retirePresentation, runtimeFor],
  );

  const presentationDomIsValid = useCallback((candidate: OutlinePresentation) => {
    if (
      candidate.mount !== mount ||
      candidate.rows.length !== candidate.headings.length ||
      candidate.active !== activeHeadingIndex(candidate.headings, candidate.session.cursorSource) ||
      candidate.tabStop !== (candidate.active >= 0 ? candidate.active : 0)
    ) {
      return false;
    }

    let expectedMinLevel = 6;
    for (const row of candidate.rows) {
      if (!headingPublicationIsCurrent(candidate, row)) return false;
      expectedMinLevel = Math.min(expectedMinLevel, row.level);
    }
    if (candidate.minLevel !== expectedMinLevel) return false;

    const runtime = presentationRuntimesRef.current.get(candidate);
    const root = runtime?.root;
    const toggle = runtime?.toggle;
    if (!runtime || !root?.isConnected || !toggle?.isConnected || toggle.disabled) return false;

    if (!candidate.open) {
      return (
        root instanceof HTMLDivElement &&
        root.children.length === 1 &&
        root.firstElementChild === toggle &&
        toggle.parentElement === root &&
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
      !list?.isConnected ||
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
        button.disabled ||
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
    (candidate: OutlinePresentation) =>
      activePresentationRef.current === candidate &&
      presentationRuntimesRef.current.get(candidate)?.active === true &&
      presentationDomIsValid(candidate),
    [presentationDomIsValid],
  );

  const claimToggle = useCallback(
    (candidate: OutlinePresentation, source: HTMLButtonElement) => {
      const runtime = presentationRuntimesRef.current.get(candidate);
      if (
        claimedTogglePresentationsRef.current.has(candidate) ||
        runtime?.toggle !== source ||
        source.disabled
      ) {
        return false;
      }
      if (!presentationIsCurrent(candidate)) {
        retirePresentation(candidate);
        return false;
      }
      claimedTogglePresentationsRef.current.add(candidate);
      return true;
    },
    [presentationIsCurrent, retirePresentation],
  );

  const claimHeading = useCallback(
    (candidate: OutlinePresentation, row: HeadingPublication, source: HTMLButtonElement) => {
      const runtime = presentationRuntimesRef.current.get(candidate);
      if (
        claimedRowsRef.current.has(row) ||
        candidate.rows[row.index] !== row ||
        runtime?.rows[row.index]?.button !== source ||
        source.disabled
      ) {
        return false;
      }
      if (!presentationIsCurrent(candidate)) {
        retirePresentation(candidate);
        return false;
      }
      claimedRowsRef.current.add(row);
      return true;
    },
    [presentationIsCurrent, retirePresentation],
  );

  const claimListKey = useCallback(
    (candidate: OutlinePresentation, event: KeyboardEvent<HTMLUListElement>) => {
      if (nextOutlineIndex(event.key, 0, candidate.rows.length) < 0) return null;
      const runtime = presentationRuntimesRef.current.get(candidate);
      if (
        runtime?.list !== event.currentTarget ||
        !(event.target instanceof HTMLButtonElement) ||
        event.target !== document.activeElement ||
        claimedListPresentationsRef.current.has(candidate) ||
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
      if (!presentationIsCurrent(candidate)) {
        retirePresentation(candidate);
        return null;
      }
      claimedListPresentationsRef.current.add(candidate);
      return destination;
    },
    [presentationIsCurrent, retirePresentation],
  );

  useLayoutEffect(() => {
    const existing = activePresentationRef.current;
    if (existing && existing !== presentation) retirePresentation(existing);
    const runtime = runtimeFor(presentation);
    if (!presentationDomIsValid(presentation)) {
      retirePresentation(presentation);
      lastCommittedPresentationRef.current = null;
      return () => retirePresentation(presentation);
    }

    const before = lastCommittedPresentationRef.current;
    runtime.active = true;
    activePresentationRef.current = presentation;
    lastCommittedPresentationRef.current = presentation;

    if (
      presentation.open &&
      presentation.hydrated &&
      presentation.active >= 0 &&
      before &&
      before !== presentation &&
      before.session === presentation.session &&
      before.open &&
      before.hydrated === presentation.hydrated &&
      before.headings === presentation.headings &&
      before.active !== presentation.active &&
      !revealedPresentationsRef.current.has(presentation)
    ) {
      const beforeRuntime = presentationRuntimesRef.current.get(before);
      const activeButton = runtime.rows[presentation.active]?.button;
      const sameDom =
        beforeRuntime?.root === runtime.root &&
        beforeRuntime.toggle === runtime.toggle &&
        beforeRuntime.nav === runtime.nav &&
        beforeRuntime.list === runtime.list &&
        beforeRuntime.rows.length === runtime.rows.length &&
        beforeRuntime.rows.every(
          (elements, index) =>
            elements.item === runtime.rows[index]?.item &&
            elements.button === runtime.rows[index]?.button,
        );
      if (sameDom && activeButton && presentationIsCurrent(presentation)) {
        revealedPresentationsRef.current.add(presentation);
        activeButton.scrollIntoView({ block: "nearest" });
      }
    }

    return () => retirePresentation(presentation);
  }, [
    presentation,
    presentationDomIsValid,
    presentationIsCurrent,
    retirePresentation,
    runtimeFor,
  ]);

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    if (!claimToggle(presentation, event.currentTarget)) return;
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
  claimHeading: (presentation: OutlinePresentation, row: HeadingPublication, source: HTMLButtonElement) => boolean;
  claimListKey: (
    presentation: OutlinePresentation,
    event: KeyboardEvent<HTMLUListElement>,
  ) => HTMLButtonElement | null;
  republish: () => void;
}) {
  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const destination = claimListKey(presentation, event);
    if (!destination) return;
    republish();
    event.preventDefault();
    destination.focus();
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
              if (claimHeading(presentation, row, event.currentTarget)) {
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
