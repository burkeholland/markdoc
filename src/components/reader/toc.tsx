"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown, List } from "lucide-react";
import type { RenderedHeading } from "@/server/export/html";
import { cn } from "@/lib/utils";

/** Vertical offset (sticky chrome + breathing room) used to decide which heading is "current". */
const TOP_OFFSET = 88;

const TOGGLE_CLASS =
  "flex w-full items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm font-medium text-ink-2 lg:hidden";
const PAGE_HEADING_CLASS =
  "mb-2 hidden pl-2 text-[11px] font-semibold uppercase tracking-wider text-ink-4 lg:block";
const ENTRY_CLASS = "block wrap-anywhere rounded-md py-1 pr-2 text-[13px] leading-snug transition-colors";

function useActiveHeading(headings: RenderedHeading[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = headings.map((heading) => heading.id).join("\n");

  useEffect(() => {
    const ids = key ? key.split("\n") : [];
    const elements = ids.flatMap((id) => {
      const element = document.getElementById(id);
      return element ? [element] : [];
    });
    const visible = new Set<string>();
    let disposed = false;

    const pick = () => {
      if (disposed) return;
      // Prefer the topmost heading on screen; with none on screen, keep the last one scrolled past.
      let best: { id: string; top: number } | null = null;
      let lastAbove: string | null = null;
      for (const element of elements) {
        const top = element.getBoundingClientRect().top;
        if (visible.has(element.id) && (!best || top < best.top)) best = { id: element.id, top };
        if (top < TOP_OFFSET) lastAbove = element.id;
      }
      setActive(best?.id ?? lastAbove ?? elements[0]?.id ?? null);
    };

    const observer = typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) visible.add(entry.target.id);
              else visible.delete(entry.target.id);
            }
            pick();
          },
          { rootMargin: `-${TOP_OFFSET}px 0px -55% 0px`, threshold: [0, 1] },
        )
      : null;
    elements.forEach((element) => observer?.observe(element));
    pick();
    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, [key]);

  return active;
}

/** h2/h3 table of contents; sticky on wide screens, a "Contents" disclosure above the article on phones. */
export function ReaderToc({ headings }: { headings: RenderedHeading[] }) {
  const active = useActiveHeading(headings);
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!open || event.altKey || event.ctrlKey || event.metaKey) return;
    const anchors = Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? []);
    const target = event.target as HTMLElement;
    const index = anchors.indexOf(target as HTMLAnchorElement);
    if (target !== toggleRef.current && index < 0) return;

    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      toggleRef.current?.focus();
      return;
    }
    if (!anchors.length || event.shiftKey) return;
    const last = anchors.length - 1;
    let destination: number;
    switch (event.key) {
      case "Home":
        destination = 0;
        break;
      case "End":
        destination = last;
        break;
      case "ArrowDown":
      case "ArrowUp": {
        const down = event.key === "ArrowDown";
        if (index < 0) {
          const activeIndex = headings.findIndex((heading) => heading.id === active);
          destination = activeIndex >= 0 ? activeIndex : down ? 0 : last;
        } else {
          destination = (index + (down ? 1 : -1) + anchors.length) % anchors.length;
        }
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    anchors[destination]?.focus({ preventScroll: true });
  };

  return (
    <nav
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
        onClick={() => setOpen((value) => !value)}
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
        className={cn("reader-toc-list mt-2 flex-col gap-0.5 lg:mt-0 lg:max-h-[calc(100dvh-8rem)] lg:overflow-y-auto lg:overscroll-contain lg:flex", open ? "flex" : "hidden")}
      >
        {headings.map((heading) => (
          <li key={heading.id}>
            {/* The current entry is a soft filled pill (never a bar at the edge — docs/agents.md, UI conventions); h3s indent under their h2. */}
            <a
              href={`#${heading.id}`}
              className={cn(
                ENTRY_CLASS,
                heading.level === 3 ? "pl-5" : "pl-2",
                active === heading.id ? "bg-accent-soft font-medium text-accent" : "text-ink-3 hover:bg-surface-2 hover:text-ink",
              )}
              aria-current={active === heading.id ? "location" : undefined}
              data-testid="reader-toc-entry"
              onClick={() => setOpen(false)}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
