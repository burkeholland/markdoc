"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { ChevronDown, List } from "lucide-react";
import type { RenderedHeading } from "@/server/export/html";
import { cn } from "@/lib/utils";

/** Vertical offset (sticky chrome + breathing room) used to decide which heading is "current". */
const TOP_OFFSET = 88;

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

type ObserverOwner = {
  visit: HeadingsVisit;
  retire: () => void;
};

type ActiveHeading = {
  visit: HeadingsVisit;
  id: string;
};

type TocRender = Readonly<{
  identity: symbol;
  visit: HeadingsVisit;
  open: boolean;
}>;

type ElementOwner<T extends Element> = Readonly<{
  render: TocRender;
  element: T;
}>;

type TocPublication = Readonly<{
  render: TocRender;
  nav: HTMLElement;
  toggle: HTMLButtonElement;
  list: HTMLOListElement;
  anchors: readonly HTMLAnchorElement[];
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
  if (owner.source === headings && owner.fingerprint === fingerprint) return owner.visit;
  const next = Object.freeze<HeadingsVisitOwner>({
    source: headings,
    fingerprint,
    visit: createHeadingsVisit(headings),
  });
  setOwner(next);
  return next.visit;
}

function retireOwnedObserver(visit: HeadingsVisit, observerOwnerRef: RefObject<ObserverOwner | null>) {
  const observerOwner = observerOwnerRef.current;
  if (observerOwner?.visit === visit) observerOwner.retire();
}

function useActiveHeading(
  visit: HeadingsVisit,
  visitRef: RefObject<HeadingsVisit | null>,
  observerOwnerRef: RefObject<ObserverOwner | null>,
): string | null {
  const [publication, setPublication] = useState<ActiveHeading | null>(null);

  useEffect(() => {
    const hasAuthority = () => visitRef.current === visit;
    if (!hasAuthority()) return;

    const elements = visit.headings.map((heading) => document.getElementById(heading.id)).filter((el): el is HTMLElement => !!el);
    if (elements.length === 0) return;

    const visible = new Set<string>();
    let retired = false;
    const isCurrent = () => !retired && hasAuthority();
    const pick = () => {
      if (!isCurrent()) return;

      // Prefer the topmost heading on screen; with none on screen, keep the last one scrolled past.
      let best: { id: string; top: number } | null = null;
      let lastAbove: string | null = null;
      for (const el of elements) {
        const top = el.getBoundingClientRect().top;
        if (visible.has(el.id) && (!best || top < best.top)) best = { id: el.id, top };
        if (top < TOP_OFFSET) lastAbove = el.id;
      }
      if (!isCurrent()) return;
      setPublication({ visit, id: best?.id ?? lastAbove ?? elements[0].id });
    };
    const io = new IntersectionObserver(
      (entries) => {
        if (!isCurrent()) return;
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        pick();
      },
      { rootMargin: `-${TOP_OFFSET}px 0px -55% 0px`, threshold: [0, 1] },
    );
    const owner: ObserverOwner = {
      visit,
      retire: () => {
        if (retired) return;
        retired = true;
        io.disconnect();
        if (observerOwnerRef.current === owner) observerOwnerRef.current = null;
      },
    };

    observerOwnerRef.current = owner;
    elements.forEach((el) => io.observe(el));
    pick();
    return owner.retire;
  }, [observerOwnerRef, visit, visitRef]);

  return publication?.visit === visit ? publication.id : null;
}

function retirePublication(render: TocRender, publicationRef: RefObject<TocPublication | null>) {
  if (publicationRef.current?.render === render) publicationRef.current = null;
}

function publicationIsExact(publication: TocPublication): boolean {
  const { anchors, list, nav, render, toggle } = publication;
  const { headings } = render.visit;
  if (
    !nav.isConnected ||
    !toggle.isConnected ||
    !list.isConnected ||
    nav.tagName !== "NAV" ||
    toggle.tagName !== "BUTTON" ||
    list.tagName !== "OL" ||
    nav.dataset.testid !== "reader-toc" ||
    nav.getAttribute("aria-label") !== "Table of contents" ||
    toggle.dataset.testid !== "reader-toc-toggle" ||
    toggle.type !== "button" ||
    toggle.getAttribute("aria-controls") !== "reader-toc-list" ||
    toggle.getAttribute("aria-expanded") !== String(render.open) ||
    list.id !== "reader-toc-list" ||
    nav.children.length !== 3 ||
    nav.children.item(0) !== toggle ||
    nav.children.item(2) !== list ||
    toggle.parentElement !== nav ||
    list.parentElement !== nav ||
    list.children.length !== headings.length ||
    anchors.length !== headings.length ||
    list.classList.contains(render.open ? "hidden" : "flex") ||
    !list.classList.contains(render.open ? "flex" : "hidden")
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
      item.tagName !== "LI" ||
      anchor.tagName !== "A" ||
      item.children.length !== 1 ||
      item.children.item(0) !== anchor ||
      anchor.parentElement !== item ||
      anchor.dataset.testid !== "reader-toc-entry" ||
      anchor.getAttribute("href") !== heading.href ||
      anchor.textContent !== heading.text ||
      !anchor.classList.contains(heading.level === 3 ? "pl-5" : "pl-2")
    ) {
      return false;
    }
  }
  return true;
}

function publicationHasCurrentRefs(
  publication: TocPublication,
  navOwnerRef: RefObject<ElementOwner<HTMLElement> | null>,
  toggleOwnerRef: RefObject<ElementOwner<HTMLButtonElement> | null>,
  listOwnerRef: RefObject<ElementOwner<HTMLOListElement> | null>,
  anchorOwnersRef: RefObject<Array<ElementOwner<HTMLAnchorElement> | null>>,
): boolean {
  const { anchors, list, nav, render, toggle } = publication;
  return (
    navOwnerRef.current?.render === render &&
    navOwnerRef.current.element === nav &&
    toggleOwnerRef.current?.render === render &&
    toggleOwnerRef.current.element === toggle &&
    listOwnerRef.current?.render === render &&
    listOwnerRef.current.element === list &&
    anchors.every((anchor, index) => {
      const owner = anchorOwnersRef.current[index];
      return owner?.render === render && owner.element === anchor;
    })
  );
}

function currentPublication(
  render: TocRender,
  publicationRef: RefObject<TocPublication | null>,
  navOwnerRef: RefObject<ElementOwner<HTMLElement> | null>,
  toggleOwnerRef: RefObject<ElementOwner<HTMLButtonElement> | null>,
  listOwnerRef: RefObject<ElementOwner<HTMLOListElement> | null>,
  anchorOwnersRef: RefObject<Array<ElementOwner<HTMLAnchorElement> | null>>,
) {
  const publication = publicationRef.current;
  if (
    !publication ||
    publication.render !== render ||
    !publicationHasCurrentRefs(publication, navOwnerRef, toggleOwnerRef, listOwnerRef, anchorOwnersRef) ||
    !publicationIsExact(publication)
  ) {
    return null;
  }
  return publication;
}

function isNativeReactMouseEvent(event: ReactMouseEvent<HTMLElement>): boolean {
  return (
    event.type === "click" &&
    typeof window !== "undefined" &&
    event.nativeEvent instanceof window.MouseEvent &&
    event.nativeEvent.type === "click"
  );
}

function isNativeReactEscape(event: ReactKeyboardEvent<HTMLElement>): boolean {
  return (
    event.type === "keydown" &&
    event.key === "Escape" &&
    typeof window !== "undefined" &&
    event.nativeEvent instanceof window.KeyboardEvent &&
    event.nativeEvent.type === "keydown" &&
    event.nativeEvent.key === "Escape"
  );
}

/** h2/h3 table of contents; sticky on wide screens, a "Contents" disclosure above the article on phones. */
export function ReaderToc({ headings }: { headings: RenderedHeading[] }) {
  const visit = useHeadingsVisit(headings);
  const visitRef = useRef<HeadingsVisit | null>(null);
  const observerOwnerRef = useRef<ObserverOwner | null>(null);
  const publicationRef = useRef<TocPublication | null>(null);
  const navOwnerRef = useRef<ElementOwner<HTMLElement> | null>(null);
  const toggleOwnerRef = useRef<ElementOwner<HTMLButtonElement> | null>(null);
  const listOwnerRef = useRef<ElementOwner<HTMLOListElement> | null>(null);
  const anchorOwnersRef = useRef<Array<ElementOwner<HTMLAnchorElement> | null>>([]);
  const [disclosure, setDisclosure] = useState<DisclosureState | null>(null);
  const active = useActiveHeading(visit, visitRef, observerOwnerRef);
  const open = disclosure?.visit === visit && disclosure.open;
  const render = Object.freeze<TocRender>({ identity: Symbol("reader-toc-render"), visit, open });

  useLayoutEffect(() => {
    visitRef.current = visit;

    return () => {
      if (visitRef.current === visit) visitRef.current = null;
      retireOwnedObserver(visit, observerOwnerRef);
    };
  }, [visit]);

  useLayoutEffect(() => {
    const navOwner = navOwnerRef.current;
    const toggleOwner = toggleOwnerRef.current;
    const listOwner = listOwnerRef.current;
    const anchorOwners = visit.headings.map((heading) => anchorOwnersRef.current[heading.index]);
    if (
      navOwner?.render !== render ||
      toggleOwner?.render !== render ||
      listOwner?.render !== render ||
      anchorOwners.some((owner) => owner?.render !== render)
    ) {
      return;
    }
    const publication = Object.freeze<TocPublication>({
      render,
      nav: navOwner.element,
      toggle: toggleOwner.element,
      list: listOwner.element,
      anchors: Object.freeze(anchorOwners.map((owner) => owner!.element)),
    });
    if (!publicationIsExact(publication)) return;
    publicationRef.current = publication;
    return () => retirePublication(render, publicationRef);
  }, [render, visit.headings]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!isNativeReactEscape(event)) return;
    const publication = currentPublication(
      render,
      publicationRef,
      navOwnerRef,
      toggleOwnerRef,
      listOwnerRef,
      anchorOwnersRef,
    );
    if (
      !publication ||
      !publication.render.open ||
      event.currentTarget !== publication.nav ||
      (event.target !== publication.toggle && !publication.anchors.includes(event.target as HTMLAnchorElement))
    ) {
      return;
    }
    publicationRef.current = null;
    event.preventDefault();
    setDisclosure({ visit, open: false });
    publication.toggle.focus();
  };
  return (
    <nav
      ref={(node) => {
        if (node) navOwnerRef.current = Object.freeze({ render, element: node });
        else {
          if (navOwnerRef.current?.render === render) navOwnerRef.current = null;
          retirePublication(render, publicationRef);
        }
      }}
      className="reader-toc lg:sticky lg:top-20"
      aria-label="Table of contents"
      onKeyDown={onKeyDown}
      data-testid="reader-toc"
    >
      <button
        ref={(node) => {
          if (node) toggleOwnerRef.current = Object.freeze({ render, element: node });
          else {
            if (toggleOwnerRef.current?.render === render) toggleOwnerRef.current = null;
            retirePublication(render, publicationRef);
          }
        }}
        type="button"
        className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm font-medium text-ink-2 lg:hidden"
        aria-expanded={open}
        aria-controls="reader-toc-list"
        onClick={(event) => {
          if (!isNativeReactMouseEvent(event)) return;
          const publication = currentPublication(
            render,
            publicationRef,
            navOwnerRef,
            toggleOwnerRef,
            listOwnerRef,
            anchorOwnersRef,
          );
          if (!publication || event.currentTarget !== publication.toggle) return;
          publicationRef.current = null;
          setDisclosure({ visit, open: !publication.render.open });
        }}
        data-testid="reader-toc-toggle"
      >
        <List size={15} />
        Contents
        <ChevronDown size={15} className={cn("ml-auto transition-transform", open && "rotate-180")} />
      </button>
      <div className="mb-2 hidden pl-2 text-[11px] font-semibold uppercase tracking-wider text-ink-4 lg:block">On this page</div>
      <ol
        ref={(node) => {
          if (node) listOwnerRef.current = Object.freeze({ render, element: node });
          else {
            if (listOwnerRef.current?.render === render) listOwnerRef.current = null;
            retirePublication(render, publicationRef);
          }
        }}
        id="reader-toc-list"
        className={cn("reader-toc-list mt-2 flex-col gap-0.5 lg:mt-0 lg:flex", open ? "flex" : "hidden")}
      >
        {visit.headings.map((heading) => (
          <li key={heading.id}>
            {/* The current entry is a soft filled pill (never a bar at the edge — docs/agents.md, UI conventions); h3s indent under their h2. */}
            <a
              ref={(node) => {
                if (node) anchorOwnersRef.current[heading.index] = Object.freeze({ render, element: node });
                else {
                  if (anchorOwnersRef.current[heading.index]?.render === render) {
                    anchorOwnersRef.current[heading.index] = null;
                  }
                  retirePublication(render, publicationRef);
                }
              }}
              href={heading.href}
              className={cn(
                "block rounded-md py-1 pr-2 text-[13px] leading-snug transition-colors",
                heading.level === 3 ? "pl-5" : "pl-2",
                active === heading.id ? "bg-accent-soft font-medium text-accent" : "text-ink-3 hover:bg-surface-2 hover:text-ink",
              )}
              aria-current={active === heading.id ? "location" : undefined}
              data-testid="reader-toc-entry"
              onClick={(event) => {
                if (!isNativeReactMouseEvent(event)) return;
                const publication = currentPublication(
                  render,
                  publicationRef,
                  navOwnerRef,
                  toggleOwnerRef,
                  listOwnerRef,
                  anchorOwnersRef,
                );
                if (!publication || event.currentTarget !== publication.anchors[heading.index]) return;
                publicationRef.current = null;
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
