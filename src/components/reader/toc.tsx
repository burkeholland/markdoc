"use client";

import { useEffect, useState } from "react";
import { ChevronDown, List } from "lucide-react";
import type { RenderedHeading } from "@/server/export/html";
import { cn } from "@/lib/utils";

/** Vertical offset (sticky chrome + breathing room) used to decide which heading is "current". */
const TOP_OFFSET = 88;

function useActiveHeading(headings: RenderedHeading[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const elements = headings.map((h) => document.getElementById(h.id)).filter((el): el is HTMLElement => !!el);
    if (elements.length === 0) return;
    const visible = new Set<string>();
    const pick = () => {
      // Prefer the topmost heading on screen; with none on screen, keep the last one scrolled past.
      let best: { id: string; top: number } | null = null;
      let lastAbove: string | null = null;
      for (const el of elements) {
        const top = el.getBoundingClientRect().top;
        if (visible.has(el.id) && (!best || top < best.top)) best = { id: el.id, top };
        if (top < TOP_OFFSET) lastAbove = el.id;
      }
      setActive(best?.id ?? lastAbove ?? elements[0].id);
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        pick();
      },
      { rootMargin: `-${TOP_OFFSET}px 0px -55% 0px`, threshold: [0, 1] },
    );
    elements.forEach((el) => io.observe(el));
    pick();
    return () => io.disconnect();
  }, [headings]);
  return active;
}

/** h2/h3 table of contents; sticky on wide screens, a "Contents" disclosure above the article on phones. */
export function ReaderToc({ headings }: { headings: RenderedHeading[] }) {
  const active = useActiveHeading(headings);
  const [open, setOpen] = useState(false);
  return (
    <nav className="reader-toc lg:sticky lg:top-20" aria-label="Table of contents" data-testid="reader-toc">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm font-medium text-ink-2 lg:hidden"
        aria-expanded={open}
        aria-controls="reader-toc-list"
        onClick={() => setOpen((o) => !o)}
        data-testid="reader-toc-toggle"
      >
        <List size={15} />
        Contents
        <ChevronDown size={15} className={cn("ml-auto transition-transform", open && "rotate-180")} />
      </button>
      <div className="mb-2 hidden text-[11px] font-semibold uppercase tracking-wider text-ink-4 lg:block">On this page</div>
      <ol id="reader-toc-list" className={cn("reader-toc-list mt-2 flex-col gap-0.5 border-l border-line lg:mt-0 lg:flex", open ? "flex" : "hidden")}>
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              className={cn(
                "block border-l-2 py-1 text-[13px] leading-snug transition-colors hover:text-ink",
                h.level === 3 ? "pl-6" : "pl-3",
                active === h.id ? "-ml-px border-accent font-medium text-accent" : "-ml-px border-transparent text-ink-3",
              )}
              aria-current={active === h.id ? "location" : undefined}
              data-testid="reader-toc-entry"
              onClick={() => setOpen(false)}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
