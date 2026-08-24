"use client";

import { ChevronsLeft, ChevronsRight } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { HeadingInfo } from "@/editor/markdown/parse";
import { useHydrated } from "@/lib/hooks";
import { rovingIndex } from "@/lib/a11y";
import { cn } from "@/lib/utils";
import { useSessionValue } from "./use-session";
import { memo, type KeyboardEvent } from "react";

export interface OutlineProps {
  session: CollabSession;
  open: boolean;
  onToggle: () => void;
  /** Source offset of the active surface's cursor. */
  cursorSource: number | null;
  onSelect: (heading: HeadingInfo) => void;
}

const EMPTY_HEADINGS: HeadingInfo[] = [];

function sameHeadings(a: HeadingInfo[], b: HeadingInfo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.from !== y.from || x.line !== y.line || x.level !== y.level || x.text !== y.text) return false;
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

export function OutlinePanel({ session, open, onToggle, cursorSource, onSelect }: OutlineProps) {
  // IndexedDB can fill the document before React hydrates; keep the first client render
  // identical to the server (no headings) and switch in the next render.
  const hydrated = useHydrated();
  const liveHeadings = useHeadings(session);
  const headings = hydrated ? liveHeadings : EMPTY_HEADINGS;
  const active = activeHeadingIndex(headings, cursorSource);

  if (!open) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-r border-line pt-3" data-testid="outline-collapsed">
        <button type="button" className="icon-btn h-8 w-8" onClick={onToggle} aria-label="Show outline" title="Show outline">
          <ChevronsRight size={16} />
        </button>
      </div>
    );
  }

  return (
    // max-h-full: inside the phone drawer (a fixed-height flex column) a long outline must scroll in the
    // nav instead of growing past the viewport; on the desktop row it already stretches to the main height.
    <aside className="flex max-h-full min-h-0 w-56 shrink-0 flex-col border-r border-line" data-testid="outline">
      <div className="flex h-12 items-center justify-between pl-6 pr-2">
        <span className="pane-label">Outline</span>
        <button type="button" className="icon-btn h-8 w-8" onClick={onToggle} aria-label="Hide outline" title="Hide outline">
          <ChevronsLeft size={16} />
        </button>
      </div>
      <nav className="scrollbar-thin flex-1 overflow-y-auto pb-6 pr-2" aria-label="Document outline">
        <OutlineList headings={headings} active={active} onSelect={onSelect} />
        {hydrated && headings.length === 0 && <p className="px-6 pt-1 text-[13px] leading-5 text-ink-4">Headings you add will show up here.</p>}
      </nav>
    </aside>
  );
}

/**
 * The heading list only depends on the headings and the active index, not on the cursor offset,
 * so typing inside a section does not re-render a 140-item list on every keystroke (task #357).
 */
const OutlineList = memo(function OutlineList({ headings, active, onSelect }: { headings: HeadingInfo[]; active: number; onSelect: (heading: HeadingInfo) => void }) {
  const minLevel = headings.reduce((m, h) => Math.min(m, h.level), 6);
  // Roving tabindex: the active heading (or the first one) is the list's single tab stop.
  const tabStop = active >= 0 ? active : 0;

  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-outline-item]"));
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = nextOutlineIndex(e.key, current, items.length);
    if (next < 0) return;
    e.preventDefault();
    items[next]?.focus();
  };

  return (
    <ul className="flex flex-col" onKeyDown={onListKeyDown}>
      {headings.map((h, i) => (
        <li key={`${h.from}-${i}`}>
          <button
            type="button"
            onClick={() => onSelect(h)}
            className={cn(
              "relative flex w-full items-start truncate py-2.5 pr-3 text-left text-[15px] leading-5 transition-colors hover:text-ink",
              i === active ? "font-medium text-accent" : "text-ink-2",
            )}
            style={{ paddingLeft: 24 + (h.level - minLevel) * 14 }}
            data-active={i === active || undefined}
            data-outline-item
            aria-current={i === active ? "location" : undefined}
            tabIndex={i === tabStop ? 0 : -1}
          >
            {i === active && <span className="absolute left-0 top-1.5 h-7 w-[3px] rounded-r bg-accent" aria-hidden />}
            <span className="truncate">{h.text || "Untitled"}</span>
          </button>
        </li>
      ))}
    </ul>
  );
});
