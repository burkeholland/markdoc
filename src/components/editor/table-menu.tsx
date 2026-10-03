"use client";

import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
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
import { isTableMenuHidden, TABLE_MENU_EVENT } from "@/editor/prosemirror/setup";
import type { EditorActions, FormatState } from "./actions";
import { Tip } from "@/components/ui/primitives";
import { cn, shortcut } from "@/lib/utils";
import { clampToViewport } from "@/lib/viewport";
import { useSessionValue } from "./use-session";
import { useEnterOnRelease, usePlaceHold } from "./toolbar";

const MENU_WIDTH = 372;
const MENU_HEIGHT = 40;

interface ScheduledFrame {
  id: number;
}

interface TableMenuAuthority {
  view: EditorView;
  editor: HTMLElement | null;
  container: HTMLElement;
  session: CollabSession;
  format: FormatState;
  canEdit: boolean;
  activeSurface: CollabSession["activeSurface"];
  schedule: () => void;
  dispose: () => void;
}

interface TableMenuGeometry {
  authority: TableMenuAuthority;
  left: number;
  top: number;
  width: number;
}

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
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Tip label={label} shortcut={keys ? shortcut(keys) : undefined} side="top">
      <button
        type="button"
        className={cn("flex h-8 w-8 items-center justify-center rounded-md text-white/85 hover:bg-white/15 hover:text-white", active && "bg-white/20 text-white")}
        // Keep the editor's selection: table commands act on the cell the caret is in.
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

/** Where a key moves focus among `count` buttons: arrows wrap, Home/End jump. -1 = not ours. */
function tableMenuDestination(count: number, current: number, key: string) {
  if (current < 0 || count <= 1) return -1;
  let destination = -1;
  if (key === "Home") destination = 0;
  else if (key === "End") destination = count - 1;
  else if (key === "ArrowRight" || key === "ArrowDown") destination = (current + 1) % count;
  else if (key === "ArrowLeft" || key === "ArrowUp") destination = (current - 1 + count) % count;
  return destination === current ? -1 : destination;
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
  const [geometry, setGeometry] = useState<TableMenuGeometry | null>(null);
  const authorityRef = useRef<TableMenuAuthority | null>(null);
  const canEdit = useSessionValue(session, (s) => s.canEdit);
  const activeSurface = useSessionValue(session, (s) => s.activeSurface);
  const shown = Boolean(geometry && geometry.authority.view === view && geometry.authority.session === session);
  // Delete table removes the menu under the pointer: its place is kept for the rest of the gesture.
  const placeHold = usePlaceHold(!shown);
  const enterOnRelease = useEnterOnRelease();

  // Resolve ref.current on every commit: the pane can be replaced without replacing its ref.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const previous = authorityRef.current;
    if (previous?.view === view && previous.container === container && previous.session === session) {
      const changed = previous.format !== format || previous.canEdit !== canEdit || previous.activeSurface !== activeSurface;
      previous.format = format;
      previous.canEdit = canEdit;
      previous.activeSurface = activeSurface;
      if (changed) previous.schedule();
      return;
    }
    previous?.dispose();
    authorityRef.current = null;
    if (!view || !container) {
      return;
    }
    const ownedView = view;
    const ownedContainer = container;

    let disposed = false;
    let frame: ScheduledFrame | null = null;
    const authority: TableMenuAuthority = {
      view: ownedView,
      editor: null,
      container: ownedContainer,
      session,
      format,
      canEdit,
      activeSurface,
      schedule,
      dispose,
    };

    function owns(scheduled: ScheduledFrame) {
      return !disposed && authorityRef.current === authority && frame === scheduled;
    }

    function publish(scheduled: ScheduledFrame, position: Omit<TableMenuGeometry, "authority"> | null) {
      if (!owns(scheduled)) return;
      setGeometry(position ? { authority, ...position } : null);
    }

    function compute(scheduled: ScheduledFrame) {
      if (!owns(scheduled)) return;
      const currentFormat = authority.format;
      if (
        ownedView.isDestroyed ||
        currentFormat.tablePos < 0 ||
        !authority.canEdit ||
        authority.activeSurface !== "rich" ||
        isTableMenuHidden(ownedView.state)
      ) {
        publish(scheduled, null);
        return;
      }
      if (!owns(scheduled)) return;
      const dom = ownedView.nodeDOM(currentFormat.tablePos);
      // The table node view wraps the <table>; anchor to whichever element is actually rendered.
      const table = dom instanceof HTMLElement ? (dom.tagName === "TABLE" ? dom : dom.querySelector("table") ?? dom) : null;
      if (!table) {
        publish(scheduled, null);
        return;
      }
      const rect = table.getBoundingClientRect();
      const host = ownedContainer.getBoundingClientRect();
      // Sit above the table; if that edge is scrolled away, stick to the top of the pane. Then keep
      // the whole menu inside the window (narrow phones shrink it and let it scroll sideways).
      const box = clampToViewport(
        { left: rect.left, top: Math.max(host.top + 4, rect.top - MENU_HEIGHT - 8), width: MENU_WIDTH, height: MENU_HEIGHT },
        { width: window.innerWidth, height: window.innerHeight },
      );
      const left = Math.max(8, Math.min(ownedContainer.clientWidth - box.width - 8, box.left - host.left));
      const top = Math.max(ownedContainer.scrollTop + 4, box.top - host.top + ownedContainer.scrollTop);
      publish(scheduled, { left, top, width: box.width });
    }

    function schedule() {
      if (disposed || authorityRef.current !== authority || frame !== null) return;
      const scheduled: ScheduledFrame = { id: -1 };
      frame = scheduled;
      scheduled.id = requestAnimationFrame(() => {
        if (!owns(scheduled)) return;
        compute(scheduled);
        if (frame === scheduled) frame = null;
      });
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      ownedContainer.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      authority.editor?.removeEventListener(TABLE_MENU_EVENT, schedule);
      const scheduled = frame;
      frame = null;
      if (scheduled) cancelAnimationFrame(scheduled.id);
      setGeometry((current) => current?.authority === authority ? null : current);
    }

    authorityRef.current = authority;
    if (authorityRef.current !== authority) return;
    const editor = ownedView.dom;
    authority.editor = editor;
    ownedContainer.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    // Esc hides the menu (and the next caret move shows it again) through plugin state; the editor
    // announces each flip here because a meta-only transaction changes nothing the shell re-renders on.
    editor.addEventListener(TABLE_MENU_EVENT, schedule);
    schedule();
  });

  useLayoutEffect(() => () => {
    authorityRef.current?.dispose();
    authorityRef.current = null;
  }, []);

  if (!geometry || !shown) return placeHold.shield;
  const { left, top, width } = geometry;

  // Read the live state at click time, the editor's own selection included: a click that lands between a
  // change (read-only, code pane, caret left the table or moved to another column, Esc) and the re-render
  // that follows acts on what is there now, or does nothing.
  const run = (action: (now: FormatState) => void) => (e: MouseEvent<HTMLButtonElement>) => {
    placeHold.arm(e, e.currentTarget.closest("[data-testid=table-menu]"));
    const live = authorityRef.current;
    if (!live || live !== geometry.authority || live.view.isDestroyed || !session.canEdit || session.activeSurface !== "rich" || isTableMenuHidden(live.view.state)) {
      return;
    }
    const now = actions.formatState();
    if (now.tablePos >= 0) action(now);
  };
  const table = (command: Parameters<EditorActions["table"]>[0]) => run(() => actions.table(command));
  // The row or column under a second Delete is not the one the pointer was aimed at: a double-click
  // (or a double tap) deletes one. Two separate clicks delete two.
  const remove = (command: "deleteRow" | "deleteColumn") => {
    const click = table(command);
    return (e: MouseEvent<HTMLButtonElement>) => {
      if (e.detail <= 1) click(e);
    };
  };
  const align = (value: TableAlign) => run((now) => actions.setColumnAlign(now.tableAlign === value ? null : value));

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    enterOnRelease.onKeyDown(e);
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return;
    const buttons = Array.from(e.currentTarget.querySelectorAll("button"));
    const destination = tableMenuDestination(buttons.length, buttons.indexOf(e.target as HTMLButtonElement), e.key);
    if (destination < 0) return;
    e.preventDefault();
    buttons[destination]?.focus({ preventScroll: true });
  };

  return (
    <div
      className="touch-target scrollbar-thin absolute z-30 flex items-center gap-0.5 overflow-x-auto rounded-lg bg-inverse px-1 py-1 shadow-xl animate-fade-in dark:ring-1 dark:ring-white/10"
      style={{ left, top, width }}
      data-testid="table-menu"
      role="toolbar"
      aria-label="Table"
      aria-orientation="horizontal"
      onBlur={enterOnRelease.onBlur}
      onKeyDown={onKeyDown}
      onKeyUp={enterOnRelease.onKeyUp}
    >
      <MenuButton label="Row above" keys="Mod-Alt-↑" onClick={table("rowBefore")} testId="table-row-before">
        <ArrowUpToLine size={16} />
      </MenuButton>
      <MenuButton label="Row below" keys="Mod-Alt-↓" onClick={table("rowAfter")} testId="table-row-after">
        <ArrowDownToLine size={16} />
      </MenuButton>
      <MenuButton label="Column left" keys="Mod-Alt-←" onClick={table("colBefore")} testId="table-col-before">
        <ArrowLeftToLine size={16} />
      </MenuButton>
      <MenuButton label="Column right" keys="Mod-Alt-→" onClick={table("colAfter")} testId="table-col-after">
        <ArrowRightToLine size={16} />
      </MenuButton>
      <span className="mx-0.5 h-5 w-px bg-white/20" />
      <MenuButton label="Delete row" keys="Mod-Alt-⌫" onClick={remove("deleteRow")} testId="table-delete-row">
        <TableRowsSplit size={16} />
      </MenuButton>
      <MenuButton label="Delete column" keys="Mod-Alt-Shift-⌫" onClick={remove("deleteColumn")} testId="table-delete-col">
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
      <MenuButton label="Delete table" onClick={table("deleteTable")} testId="table-delete">
        <Trash2 size={16} />
      </MenuButton>
    </div>
  );
}
