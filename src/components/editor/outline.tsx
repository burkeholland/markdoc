"use client";

import { ChevronsLeft, ChevronsRight } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { HeadingInfo } from "@/editor/markdown/parse";
import { useHydrated } from "@/lib/hooks";
import { rovingIndex } from "@/lib/a11y";
import { cn } from "@/lib/utils";
import { useSessionValue } from "./use-session";
import { RAIL_BOX, RAIL_COLLAPSED_BOX } from "./chrome-classes";
import { memo, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef } from "react";

export interface OutlineProps {
  session: CollabSession;
  open: boolean;
  onToggle: () => void;
  onSelect: (heading: HeadingInfo) => void;
  /** Extra classes for the rail (open) or the collapsed strip, e.g. `max-md:hidden` for the in-shell instance. */
  className?: string;
}

const EMPTY_HEADINGS: HeadingInfo[] = [];

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
  return rovingIndex(key, current, count, { orientation: "vertical", wrap: true });
}

export function OutlinePanel({ session, open, onToggle, onSelect, className }: OutlineProps) {
  // IndexedDB can fill the document before React hydrates; keep the first client render
  // identical to the server (no headings) and switch in the next render.
  const hydrated = useHydrated();
  const liveHeadings = useHeadings(session);
  const headings = hydrated ? liveHeadings : EMPTY_HEADINGS;
  // Only the active index matters: the panel re-renders when the caret crosses a heading, not per keystroke.
  const active = useSessionValue(session, (s) => activeHeadingIndex(headings, s.cursorSource));

  if (!open) {
    return (
      <div className={cn(RAIL_COLLAPSED_BOX, className)} data-testid="outline-collapsed">
        <button type="button" className="icon-btn h-8 w-8" onClick={onToggle} aria-label="Show outline" title="Show outline">
          <ChevronsRight size={16} />
        </button>
      </div>
    );
  }

  return (
    // max-h-full: inside the phone drawer (a fixed-height flex column) a long outline must scroll in the
    // nav instead of growing past the viewport; on the desktop row it already stretches to the main height.
    <aside className={cn(RAIL_BOX, className)} data-testid="outline">
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
 * The heading list only depends on the committed headings and active index, not on the cursor offset,
 * so typing inside a section does not re-render a 140-item list on every keystroke (task #357).
 */
const OutlineList = memo(function OutlineList({
  headings,
  active,
  onSelect,
}: {
  headings: HeadingInfo[];
  active: number;
  onSelect: (heading: HeadingInfo) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const revealed = useRef({ headings, active });
  const minLevel = headings.reduce((minimum, heading) => Math.min(minimum, heading.level), 6);
  // Roving tabindex: the active heading (or the first one) is the list's single tab stop.
  const tabStop = active >= 0 ? active : 0;

  // Keep the active heading visible as the caret moves, without moving focus or the document.
  useEffect(() => {
    const before = revealed.current;
    revealed.current = { headings, active };
    if (active < 0 || before.headings !== headings || before.active === active) return;
    listRef.current?.querySelectorAll<HTMLButtonElement>("[data-outline-item]")[active]?.scrollIntoView({ block: "nearest" });
  }, [headings, active]);

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat || event.nativeEvent.isComposing) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-outline-item]"));
    const current = buttons.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    const next = nextOutlineIndex(event.key, current, buttons.length);
    if (next < 0) return;
    event.preventDefault();
    buttons[next].focus({ preventScroll: true });
  };

  return (
    <ul ref={listRef} className="flex flex-col" onKeyDown={onListKeyDown}>
      {headings.map((heading, index) => (
        <li key={`${heading.id}-${heading.from}-${index}`}>
          <button
            type="button"
            onClick={() => onSelect(heading)}
            className={cn(
              "relative flex w-full items-start truncate py-2.5 pr-3 text-left text-[15px] leading-5 transition-colors hover:text-ink",
              index === active ? "font-medium text-accent" : "text-ink-2",
            )}
            style={{ paddingLeft: 24 + (heading.level - minLevel) * 14 }}
            data-active={index === active || undefined}
            data-outline-item
            aria-current={index === active ? "location" : undefined}
            tabIndex={index === tabStop ? 0 : -1}
            title={heading.text || "Untitled"}
          >
            {index === active && <span className="absolute left-0 top-1.5 h-7 w-[3px] rounded-r bg-accent" aria-hidden />}
            <span className="truncate">{heading.text || "Untitled"}</span>
          </button>
        </li>
      ))}
    </ul>
  );
});
