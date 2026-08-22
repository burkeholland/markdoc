"use client";

import { ChevronsLeft, ChevronsRight } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { extractHeadings, type HeadingInfo } from "@/editor/markdown/parse";
import { cn } from "@/lib/utils";
import { useSessionValue } from "./use-session";

export interface OutlineProps {
  session: CollabSession;
  open: boolean;
  onToggle: () => void;
  /** Source offset of the active surface's cursor. */
  cursorSource: number | null;
  onSelect: (heading: HeadingInfo) => void;
}

export function useHeadings(session: CollabSession): HeadingInfo[] {
  return useSessionValue(session, (s) => extractHeadings(s.ytext.toString()));
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

export function OutlinePanel({ session, open, onToggle, cursorSource, onSelect }: OutlineProps) {
  const headings = useHeadings(session);
  const active = activeHeadingIndex(headings, cursorSource);
  const minLevel = headings.reduce((m, h) => Math.min(m, h.level), 6);

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
    <aside className="flex w-56 shrink-0 flex-col border-r border-line" data-testid="outline">
      <div className="flex h-12 items-center justify-between pl-6 pr-2">
        <span className="pane-label">Outline</span>
        <button type="button" className="icon-btn h-8 w-8" onClick={onToggle} aria-label="Hide outline" title="Hide outline">
          <ChevronsLeft size={16} />
        </button>
      </div>
      <nav className="scrollbar-thin flex-1 overflow-y-auto pb-6 pr-2" aria-label="Document outline">
        {headings.length === 0 ? (
          <p className="px-6 pt-1 text-[13px] leading-5 text-ink-4">Headings you add will show up here.</p>
        ) : (
          <ul className="flex flex-col">
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
                >
                  {i === active && <span className="absolute left-0 top-1.5 h-7 w-[3px] rounded-r bg-accent" aria-hidden />}
                  <span className="truncate">{h.text || "Untitled"}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </aside>
  );
}
