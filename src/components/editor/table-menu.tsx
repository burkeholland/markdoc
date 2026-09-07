"use client";

import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
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
import type { EditorActions, FormatState, TableCommand } from "./actions";
import { Tip } from "@/components/ui/primitives";
import { cn, shortcut } from "@/lib/utils";
import { clampToViewport } from "@/lib/viewport";
import { useSessionValue } from "./use-session";

const MENU_WIDTH = 372;
const MENU_HEIGHT = 40;

interface ScheduledFrame {
  id: number;
}

interface TableMenuAuthority {
  active: boolean;
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

type Alignment = Exclude<TableAlign, null>;

interface TableMenuControlPublication {
  identity: symbol;
  mount: symbol;
  geometry: TableMenuGeometry;
  authority: TableMenuAuthority;
  view: EditorView;
  container: HTMLElement;
  session: CollabSession;
  actions: EditorActions;
  tableAction: EditorActions["table"];
  alignAction: EditorActions["setColumnAlign"];
  format: FormatState;
  tablePos: number;
  tableAlign: TableAlign;
  canEdit: boolean;
  activeSurface: CollabSession["activeSurface"];
  controls: Set<TableMenuControl>;
}

interface TableMenuControl {
  identity: symbol;
  publication: TableMenuControlPublication;
  claimed: boolean;
  invoke: () => void;
}

interface TableMenuControls {
  rowBefore: TableMenuControl;
  rowAfter: TableMenuControl;
  colBefore: TableMenuControl;
  colAfter: TableMenuControl;
  deleteRow: TableMenuControl;
  deleteColumn: TableMenuControl;
  alignLeft: TableMenuControl;
  alignCenter: TableMenuControl;
  alignRight: TableMenuControl;
  deleteTable: TableMenuControl;
}

class TableMenuControlCoordinator {
  #current: TableMenuControlPublication | null = null;
  #container: HTMLElement | null = null;

  publish(publication: TableMenuControlPublication | null) {
    this.#current = publication;
    this.#container = publication?.container ?? null;
  }

  retire(publication: TableMenuControlPublication | null) {
    if (this.#current !== publication) return;
    this.#current = null;
    this.#container = null;
  }

  owns(publication: TableMenuControlPublication) {
    return this.#current === publication && this.#container === publication.container;
  }
}

function createControlPublication({
  mount,
  geometry,
  view,
  container,
  session,
  actions,
  format,
  canEdit,
  activeSurface,
}: {
  mount: symbol;
  geometry: TableMenuGeometry;
  view: EditorView;
  container: HTMLElement;
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  canEdit: boolean;
  activeSurface: CollabSession["activeSurface"];
}): { publication: TableMenuControlPublication; controls: TableMenuControls } {
  const publication: TableMenuControlPublication = {
    identity: Symbol("table-menu-control-publication"),
    mount,
    geometry,
    authority: geometry.authority,
    view,
    container,
    session,
    actions,
    tableAction: actions.table,
    alignAction: actions.setColumnAlign,
    format,
    tablePos: format.tablePos,
    tableAlign: format.tableAlign,
    canEdit,
    activeSurface,
    controls: new Set(),
  };
  const control = (invoke: () => void): TableMenuControl => {
    const owned = {
      identity: Symbol("table-menu-control"),
      publication,
      claimed: false,
      invoke,
    };
    publication.controls.add(owned);
    return owned;
  };
  const table = (command: TableCommand) => control(() => publication.tableAction.call(publication.actions, command));
  const align = (value: Alignment) => {
    const target = publication.tableAlign === value ? null : value;
    return control(() => publication.alignAction.call(publication.actions, target));
  };

  return {
    publication,
    controls: {
      rowBefore: table("rowBefore"),
      rowAfter: table("rowAfter"),
      colBefore: table("colBefore"),
      colAfter: table("colAfter"),
      deleteRow: table("deleteRow"),
      deleteColumn: table("deleteColumn"),
      alignLeft: align("left"),
      alignCenter: align("center"),
      alignRight: align("right"),
      deleteTable: table("deleteTable"),
    },
  };
}

function MenuButton({
  label,
  keys,
  active,
  onMouseDown,
  onClick,
  children,
  testId,
}: {
  label: string;
  keys?: string;
  active?: boolean;
  onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Tip label={label} shortcut={keys ? shortcut(keys) : undefined} side="top">
      <button
        type="button"
        className={cn("flex h-8 w-8 items-center justify-center rounded-md text-white/85 hover:bg-white/15 hover:text-white", active && "bg-white/20 text-white")}
        onMouseDown={onMouseDown}
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
  const [geometry, setGeometry] = useState<TableMenuGeometry | null>(null);
  const [controlMount] = useState(() => Symbol("table-menu-controls"));
  const [controlCoordinator] = useState(() => new TableMenuControlCoordinator());
  const authorityRef = useRef<TableMenuAuthority | null>(null);
  const canEdit = useSessionValue(session, (s) => s.canEdit);
  const activeSurface = useSessionValue(session, (s) => s.activeSurface);

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
      active: true,
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
      authority.active = false;
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

  const controlSet = geometry && view && geometry.authority.view === view && geometry.authority.session === session
    ? createControlPublication({
      mount: controlMount,
      geometry,
      view,
      container: geometry.authority.container,
      session,
      actions,
      format,
      canEdit,
      activeSurface,
    })
    : null;
  const controlPublication = controlSet?.publication ?? null;

  useLayoutEffect(() => {
    const current = controlPublication
      && authorityRef.current === controlPublication.authority
      && controlPublication.authority.container === controlPublication.container
      && controlPublication.authority.format === controlPublication.format
      && controlPublication.authority.canEdit === controlPublication.canEdit
      && controlPublication.authority.activeSurface === controlPublication.activeSurface
      && containerRef.current === controlPublication.container
      && controlPublication.tablePos >= 0
      && controlPublication.canEdit
      && controlPublication.activeSurface === "rich"
      ? controlPublication
      : null;
    controlCoordinator.publish(current);
    return () => controlCoordinator.retire(controlPublication);
  }, [containerRef, controlCoordinator, controlPublication]);

  if (!controlSet) {
    return null;
  }
  const { publication, controls } = controlSet;
  const { left, top, width } = publication.geometry;

  const ownsControl = (control: TableMenuControl) => {
    if (
      control.publication !== publication
      || !publication.controls.has(control)
      || !controlCoordinator.owns(publication)
    ) {
      return false;
    }
    const authority = publication.authority;
    if (
      !authority.active
      || publication.mount !== controlMount
      || publication.geometry.authority !== authority
      || authority.view !== publication.view
      || authority.container !== publication.container
      || authority.session !== publication.session
      || authority.format !== publication.format
      || authority.canEdit !== publication.canEdit
      || authority.activeSurface !== publication.activeSurface
      || publication.session.canEdit !== publication.canEdit
      || publication.session.activeSurface !== publication.activeSurface
      || publication.format.tablePos !== publication.tablePos
      || publication.format.tableAlign !== publication.tableAlign
      || publication.tablePos < 0
      || !publication.canEdit
      || publication.activeSurface !== "rich"
    ) {
      return false;
    }
    return !publication.view.isDestroyed && !isTableMenuHidden(publication.view.state);
  };
  const onMouseDown = (control: TableMenuControl) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (ownsControl(control)) event.preventDefault();
  };
  const onClick = (control: TableMenuControl) => () => {
    if (!controlCoordinator.owns(publication) || control.claimed || !ownsControl(control)) return;
    control.claimed = true;
    control.invoke();
  };

  return (
    <div
      className="touch-target scrollbar-thin absolute z-30 flex items-center gap-0.5 overflow-x-auto rounded-lg bg-inverse px-1 py-1 shadow-xl animate-fade-in dark:ring-1 dark:ring-white/10"
      style={{ left, top, width }}
      data-testid="table-menu"
      role="toolbar"
      aria-label="Table"
    >
      <MenuButton label="Row above" keys="Mod-Alt-↑" onMouseDown={onMouseDown(controls.rowBefore)} onClick={onClick(controls.rowBefore)} testId="table-row-before">
        <ArrowUpToLine size={16} />
      </MenuButton>
      <MenuButton label="Row below" keys="Mod-Alt-↓" onMouseDown={onMouseDown(controls.rowAfter)} onClick={onClick(controls.rowAfter)} testId="table-row-after">
        <ArrowDownToLine size={16} />
      </MenuButton>
      <MenuButton label="Column left" keys="Mod-Alt-←" onMouseDown={onMouseDown(controls.colBefore)} onClick={onClick(controls.colBefore)} testId="table-col-before">
        <ArrowLeftToLine size={16} />
      </MenuButton>
      <MenuButton label="Column right" keys="Mod-Alt-→" onMouseDown={onMouseDown(controls.colAfter)} onClick={onClick(controls.colAfter)} testId="table-col-after">
        <ArrowRightToLine size={16} />
      </MenuButton>
      <span className="mx-0.5 h-5 w-px bg-white/20" />
      <MenuButton label="Delete row" keys="Mod-Alt-⌫" onMouseDown={onMouseDown(controls.deleteRow)} onClick={onClick(controls.deleteRow)} testId="table-delete-row">
        <TableRowsSplit size={16} />
      </MenuButton>
      <MenuButton label="Delete column" keys="Mod-Alt-Shift-⌫" onMouseDown={onMouseDown(controls.deleteColumn)} onClick={onClick(controls.deleteColumn)} testId="table-delete-col">
        <TableColumnsSplit size={16} />
      </MenuButton>
      <span className="mx-0.5 h-5 w-px bg-white/20" />
      <MenuButton label="Align left" active={format.tableAlign === "left"} onMouseDown={onMouseDown(controls.alignLeft)} onClick={onClick(controls.alignLeft)} testId="table-align-left">
        <TextAlignStart size={16} />
      </MenuButton>
      <MenuButton label="Align center" active={format.tableAlign === "center"} onMouseDown={onMouseDown(controls.alignCenter)} onClick={onClick(controls.alignCenter)} testId="table-align-center">
        <TextAlignCenter size={16} />
      </MenuButton>
      <MenuButton label="Align right" active={format.tableAlign === "right"} onMouseDown={onMouseDown(controls.alignRight)} onClick={onClick(controls.alignRight)} testId="table-align-right">
        <TextAlignEnd size={16} />
      </MenuButton>
      <span className="mx-0.5 h-5 w-px bg-white/20" />
      <MenuButton label="Delete table" onMouseDown={onMouseDown(controls.deleteTable)} onClick={onClick(controls.deleteTable)} testId="table-delete">
        <Trash2 size={16} />
      </MenuButton>
    </div>
  );
}
