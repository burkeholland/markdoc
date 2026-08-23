"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EditorView } from "prosemirror-view";
import {
  ArrowUpToLine,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  TableRowsSplit,
  TableColumnsSplit,
  TextAlignStart,
  TextAlignCenter,
  TextAlignEnd,
  Trash2,
} from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { TableAlign } from "@/editor/prosemirror/commands";
import type { EditorActions, FormatState } from "./actions";
import { Tip } from "@/components/ui/primitives";
import { cn, shortcut } from "@/lib/utils";
import { useSessionValue } from "./use-session";

const MENU_WIDTH = 372;
const MENU_HEIGHT = 40;

function MenuButton({
  label,
  keys,
  active,
  onClick,
  children,
  testId,
}: {
  label: string;
  keys?: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Tip label={label} shortcut={keys ? shortcut(keys) : undefined} side="top">
      <button
        type="button"
        className={cn("flex h-8 w-8 items-center justify-center rounded-md text-white/85 hover:bg-white/15 hover:text-white", active && "bg-white/20 text-white")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        data-testid={testId}
      >
        {children}
      </button>
    </Tip>
  );
}

/**
 * Floating table toolbar anchored to the top edge of the table around the rich
 * pane's selection. Unlike the selection bubble it does not follow the caret, so
 * both can be visible at once without overlapping.
 */
export function TableMenu({
  view,
  session,
  actions,
  format,
  containerRef,
}: {
  view: EditorView | null;
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const raf = useRef<number | null>(null);
  const canEdit = useSessionValue(session, (s) => s.canEdit);
  const activeSurface = useSessionValue(session, (s) => s.activeSurface);

  const compute = useCallback(() => {
    const container = containerRef.current;
    if (!view || !container || format.tablePos < 0 || !canEdit || activeSurface !== "rich") {
      setPos(null);
      return;
    }
    const dom = view.nodeDOM(format.tablePos);
    // The table node view wraps the <table>; anchor to whichever element is actually rendered.
    const table = dom instanceof HTMLElement ? (dom.tagName === "TABLE" ? dom : dom.querySelector("table") ?? dom) : null;
    if (!table) {
      setPos(null);
      return;
    }
    const rect = table.getBoundingClientRect();
    const host = container.getBoundingClientRect();
    const left = Math.max(8, Math.min(host.width - MENU_WIDTH - 8, rect.left - host.left));
    // Sit above the table; if that edge is scrolled away, stick to the top of the viewport.
    const top = Math.max(container.scrollTop + 4, rect.top - host.top + container.scrollTop - MENU_HEIGHT - 8);
    setPos({ left, top });
  }, [view, canEdit, activeSurface, containerRef, format.tablePos]);

  const schedule = useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(compute);
  }, [compute]);

  useLayoutEffect(() => {
    schedule();
  }, [schedule, format]);

  useEffect(() => {
    if (!view) return;
    const scroller = containerRef.current;
    scroller?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      scroller?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [view, schedule, containerRef]);

  if (!pos) return null;

  const align = (value: TableAlign) => () => actions.setColumnAlign(format.tableAlign === value ? null : value);

  return (
    <div
      className="absolute z-30 flex items-center gap-0.5 rounded-lg bg-inverse px-1 py-1 shadow-xl animate-fade-in dark:ring-1 dark:ring-white/10"
      style={{ left: pos.left, top: pos.top, width: MENU_WIDTH }}
      data-testid="table-menu"
      role="toolbar"
      aria-label="Table"
    >
      <MenuButton label="Row above" keys="Mod-Alt-↑" onClick={() => actions.table("rowBefore")} testId="table-row-before">
        <ArrowUpToLine size={16} />
      </MenuButton>
      <MenuButton label="Row below" keys="Mod-Alt-↓" onClick={() => actions.table("rowAfter")} testId="table-row-after">
        <ArrowDownToLine size={16} />
      </MenuButton>
      <MenuButton label="Column left" keys="Mod-Alt-←" onClick={() => actions.table("colBefore")} testId="table-col-before">
        <ArrowLeftToLine size={16} />
      </MenuButton>
      <MenuButton label="Column right" keys="Mod-Alt-→" onClick={() => actions.table("colAfter")} testId="table-col-after">
        <ArrowRightToLine size={16} />
      </MenuButton>
      <span className="mx-0.5 h-5 w-px bg-white/20" />
      <MenuButton label="Delete row" keys="Mod-Alt-⌫" onClick={() => actions.table("deleteRow")} testId="table-delete-row">
        <TableRowsSplit size={16} />
      </MenuButton>
      <MenuButton label="Delete column" keys="Mod-Alt-Shift-⌫" onClick={() => actions.table("deleteColumn")} testId="table-delete-col">
        <TableColumnsSplit size={16} />
      </MenuButton>
      <span className="mx-0.5 h-5 w-px bg-white/20" />
      <MenuButton label="Align left" active={format.tableAlign === "left"} onClick={align("left")} testId="table-align-left">
        <TextAlignStart size={16} />
      </MenuButton>
      <MenuButton label="Align center" active={format.tableAlign === "center"} onClick={align("center")} testId="table-align-center">
        <TextAlignCenter size={16} />
      </MenuButton>
      <MenuButton label="Align right" active={format.tableAlign === "right"} onClick={align("right")} testId="table-align-right">
        <TextAlignEnd size={16} />
      </MenuButton>
      <span className="mx-0.5 h-5 w-px bg-white/20" />
      <MenuButton label="Delete table" onClick={() => actions.table("deleteTable")} testId="table-delete">
        <Trash2 size={16} />
      </MenuButton>
    </div>
  );
}
