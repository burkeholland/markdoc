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
  retired: boolean;
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
  controlOrder: TableMenuControl[];
  root: HTMLDivElement | null;
  bindRoot: (element: HTMLDivElement | null) => void;
  domSnapshot: TableMenuDomSnapshot | null;
}

interface TableMenuControl {
  identity: symbol;
  publication: TableMenuControlPublication;
  element: HTMLButtonElement | null;
  buttonRef: (element: HTMLButtonElement | null) => void;
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

interface TableMenuElementOwner {
  publication: TableMenuControlPublication;
  publicationIdentity: symbol;
  control: TableMenuControl;
  controlIdentity: symbol;
}

interface TableMenuDomNodeSnapshot {
  node: Node;
  children: readonly Node[];
  attributes: readonly (readonly [string, string])[] | null;
  value: string | null;
}

interface TableMenuDomSnapshot {
  root: HTMLDivElement;
  parent: Node | null;
  previousSibling: Node | null;
  nextSibling: Node | null;
  buttons: readonly HTMLButtonElement[];
  nodes: readonly TableMenuDomNodeSnapshot[];
}

interface TableMenuReplayRefState {
  expected: HTMLElement;
  detached: boolean;
  attached: boolean;
}

interface TableMenuReplayCandidate {
  publication: TableMenuControlPublication;
  snapshot: TableMenuDomSnapshot;
  refs: Map<TableMenuControl | symbol, TableMenuReplayRefState>;
}

interface TableMenuReplay {
  source: TableMenuControlPublication;
  snapshot: TableMenuDomSnapshot;
}

interface TableMenuControlSet {
  publication: TableMenuControlPublication;
  controls: TableMenuControls;
}

const ROOT_REPLAY_REF = Symbol("table-menu-root-ref");

function elementAttributes(node: Node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  return Object.freeze(
    Array.from((node as Element).attributes, ({ name, value }) => Object.freeze([name, value] as const)),
  );
}

function domNodeSnapshots(root: Node) {
  const snapshots: TableMenuDomNodeSnapshot[] = [];
  const visit = (node: Node) => {
    const children = Object.freeze(Array.from(node.childNodes));
    snapshots.push(Object.freeze({
      node,
      children,
      attributes: elementAttributes(node),
      value: node.nodeValue,
    }));
    children.forEach(visit);
  };
  visit(root);
  return Object.freeze(snapshots);
}

function matchesDomSnapshot(snapshot: TableMenuDomSnapshot, exactContent = false) {
  const { root } = snapshot;
  if (
    !root.isConnected
    || root.parentNode !== snapshot.parent
    || root.previousSibling !== snapshot.previousSibling
    || root.nextSibling !== snapshot.nextSibling
  ) {
    return false;
  }
  for (const record of snapshot.nodes) {
    const children = record.node.childNodes;
    if (children.length !== record.children.length) return false;
    for (let index = 0; index < children.length; index++) {
      if (children[index] !== record.children[index]) return false;
    }
    if (exactContent && record.node.nodeValue !== record.value) return false;
    if (exactContent && record.attributes) {
      const attributes = (record.node as Element).attributes;
      if (attributes.length !== record.attributes.length) return false;
      for (let index = 0; index < attributes.length; index++) {
        const expected = record.attributes[index];
        if (attributes[index].name !== expected[0] || attributes[index].value !== expected[1]) return false;
      }
    }
  }
  return true;
}

function captureDomSnapshot(publication: TableMenuControlPublication): TableMenuDomSnapshot | null {
  const root = publication.root;
  const buttons = publication.controlOrder.map((control) => control.element);
  if (!root?.isConnected || buttons.some((button) => !button)) return null;
  const ownedButtons = buttons as HTMLButtonElement[];
  const renderedButtons = Array.from(root.querySelectorAll("button"));
  if (
    renderedButtons.length !== ownedButtons.length
    || renderedButtons.some((button, index) => button !== ownedButtons[index])
  ) {
    return null;
  }
  return Object.freeze({
    root,
    parent: root.parentNode,
    previousSibling: root.previousSibling,
    nextSibling: root.nextSibling,
    buttons: Object.freeze([...ownedButtons]),
    nodes: domNodeSnapshots(root),
  });
}

function publicationMatchesSnapshot(
  publication: TableMenuControlPublication,
  snapshot: TableMenuDomSnapshot,
  exactContent = false,
) {
  return publication.root === snapshot.root
    && publication.controlOrder.every((control, index) => control.element === snapshot.buttons[index])
    && matchesDomSnapshot(snapshot, exactContent);
}

function publicationsMatchForReplay(
  source: TableMenuControlPublication,
  successor: TableMenuControlPublication,
) {
  return successor.identity !== source.identity
    && successor.mount === source.mount
    && successor.geometry.authority === source.geometry.authority
    && successor.geometry.left === source.geometry.left
    && successor.geometry.top === source.geometry.top
    && successor.geometry.width === source.geometry.width
    && successor.authority === source.authority
    && successor.view === source.view
    && successor.container === source.container
    && successor.session === source.session
    && successor.actions === source.actions
    && successor.tableAction === source.tableAction
    && successor.alignAction === source.alignAction
    && successor.format === source.format
    && successor.tablePos === source.tablePos
    && successor.tableAlign === source.tableAlign
    && successor.canEdit === source.canEdit
    && successor.activeSurface === source.activeSurface;
}

class TableMenuControlCoordinator {
  #current: TableMenuControlPublication | null = null;
  #container: HTMLElement | null = null;
  #elementOwners = new WeakMap<HTMLButtonElement, TableMenuElementOwner>();
  #replayCandidate: TableMenuReplayCandidate | null = null;
  #replay: TableMenuReplay | null = null;

  publish(publication: TableMenuControlPublication) {
    if (publication.retired || (this.#current && this.#current !== publication)) return false;
    const replay = this.#replay;
    const snapshot = replay?.snapshot ?? captureDomSnapshot(publication);
    if (
      !snapshot
      || (replay && (
        !publicationsMatchForReplay(replay.source, publication)
        || !publicationMatchesSnapshot(publication, replay.snapshot, true)
      ))
    ) {
      this.#retire(publication, false);
      return false;
    }
    this.#replayCandidate = null;
    this.#replay = null;
    publication.domSnapshot = snapshot;
    this.#current = publication;
    this.#container = publication.container;
    return true;
  }

  retire(publication: TableMenuControlPublication | null) {
    this.#retire(publication, true);
  }

  replay(publication: TableMenuControlPublication) {
    const candidate = this.#replayCandidate;
    if (!candidate || candidate.publication !== publication) return null;
    this.#replayCandidate = null;
    if (
      this.#current
      || !publication.retired
      || !matchesDomSnapshot(candidate.snapshot, true)
      || [...candidate.refs.values()].some((ref) => !ref.detached || !ref.attached)
    ) {
      return null;
    }
    this.#replay = { source: publication, snapshot: candidate.snapshot };
    return this.#replay;
  }

  ownsPublication(publication: TableMenuControlPublication) {
    return this.#current === publication && this.#container === publication.container;
  }

  bindRoot(publication: TableMenuControlPublication, element: HTMLDivElement | null) {
    this.#observeReplayRef(publication, ROOT_REPLAY_REF, element);
    if (publication.retired || publication.root === element) return;
    if (publication.root || this.#current === publication) {
      this.#retire(publication, false);
      return;
    }
    if (element) publication.root = element;
  }

  bind(control: TableMenuControl, element: HTMLButtonElement | null) {
    const publication = control.publication;
    this.#observeReplayRef(publication, control, element);
    if (publication.retired || control.element === element) return;
    const previous = control.element;
    if (previous || this.#current === publication) {
      this.#retire(publication, false);
      return;
    }
    if (!element) return;
    const owner = this.#elementOwners.get(element);
    if (owner && (owner.publication !== publication || owner.control !== control)) {
      this.#retire(publication, false);
      return;
    }
    this.#elementOwners.set(element, {
      publication,
      publicationIdentity: publication.identity,
      control,
      controlIdentity: control.identity,
    });
    control.element = element;
  }

  ownsControl(publication: TableMenuControlPublication, control: TableMenuControl, element: HTMLButtonElement) {
    if (
      !this.ownsPublication(publication)
      || publication.retired
      || control.claimed
      || control.publication !== publication
      || control.element !== element
      || !element.isConnected
      || !publication.domSnapshot
    ) {
      return false;
    }
    if (!publicationMatchesSnapshot(publication, publication.domSnapshot)) {
      this.#retire(publication, false);
      return false;
    }
    const owner = this.#elementOwners.get(element);
    return owner?.publication === publication
      && owner.publicationIdentity === publication.identity
      && owner.control === control
      && owner.controlIdentity === control.identity;
  }

  #observeReplayRef(
    publication: TableMenuControlPublication,
    key: TableMenuControl | symbol,
    element: HTMLElement | null,
  ) {
    const candidate = this.#replayCandidate;
    if (!candidate || candidate.publication !== publication) return;
    const ref = candidate.refs.get(key);
    if (!ref || !matchesDomSnapshot(candidate.snapshot, true)) {
      this.#replayCandidate = null;
      return;
    }
    if (!element) {
      if (ref.detached || [...candidate.refs.values()].some((current) => current.attached)) {
        this.#replayCandidate = null;
        return;
      }
      ref.detached = true;
      return;
    }
    if (
      element !== ref.expected
      || ref.attached
      || [...candidate.refs.values()].some((current) => !current.detached)
    ) {
      this.#replayCandidate = null;
      return;
    }
    ref.attached = true;
  }

  #retire(publication: TableMenuControlPublication | null, allowReplay: boolean) {
    if (!publication || publication.retired) return;
    const snapshot = publication.domSnapshot;
    this.#replay = null;
    // Strict replay cleans layout effects before replaying refs. A real replacement
    // detaches refs first, so it cannot leave this complete connected candidate.
    this.#replayCandidate = allowReplay
      && this.#current === publication
      && snapshot
      && publicationMatchesSnapshot(publication, snapshot, true)
      ? {
        publication,
        snapshot,
        refs: new Map<TableMenuControl | symbol, TableMenuReplayRefState>([
          [ROOT_REPLAY_REF, { expected: snapshot.root, detached: false, attached: false }],
          ...publication.controlOrder.map((control, index) => [
            control,
            { expected: snapshot.buttons[index], detached: false, attached: false },
          ] as const),
        ]),
      }
      : null;
    publication.retired = true;
    publication.domSnapshot = null;
    if (this.#current === publication) {
      this.#current = null;
      this.#container = null;
    }
    for (const control of publication.controlOrder) {
      const element = control.element;
      if (element) {
        const owner = this.#elementOwners.get(element);
        if (
          owner?.publication === publication
          && owner.publicationIdentity === publication.identity
          && owner.control === control
          && owner.controlIdentity === control.identity
        ) {
          this.#elementOwners.delete(element);
        }
      }
      control.element = null;
    }
    publication.root = null;
  }
}

function createControlPublication({
  coordinator,
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
  coordinator: TableMenuControlCoordinator;
  mount: symbol;
  geometry: TableMenuGeometry;
  view: EditorView;
  container: HTMLElement;
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  canEdit: boolean;
  activeSurface: CollabSession["activeSurface"];
}): TableMenuControlSet {
  const ownedGeometry = {
    authority: geometry.authority,
    left: geometry.left,
    top: geometry.top,
    width: geometry.width,
  };
  const publication: TableMenuControlPublication = {
    identity: Symbol("table-menu-control-publication"),
    retired: false,
    mount,
    geometry: ownedGeometry,
    authority: ownedGeometry.authority,
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
    controlOrder: [],
    root: null,
    bindRoot: () => undefined,
    domSnapshot: null,
  };
  publication.bindRoot = (element) => coordinator.bindRoot(publication, element);
  const control = (invoke: () => void): TableMenuControl => {
    const owned: TableMenuControl = {
      identity: Symbol("table-menu-control"),
      publication,
      element: null,
      buttonRef: (element) => coordinator.bind(owned, element),
      claimed: false,
      invoke,
    };
    publication.controls.add(owned);
    publication.controlOrder.push(owned);
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
  buttonRef,
  onMouseDown,
  onClick,
  children,
  testId,
}: {
  label: string;
  keys?: string;
  active?: boolean;
  buttonRef: (element: HTMLButtonElement | null) => void;
  onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Tip label={label} shortcut={keys ? shortcut(keys) : undefined} side="top">
      <button
        ref={buttonRef}
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

function publicationMatchesRender(
  publication: TableMenuControlPublication,
  {
    controlMount,
    geometry,
    view,
    session,
    actions,
    format,
    canEdit,
    activeSurface,
    container,
  }: {
    controlMount: symbol;
    geometry: TableMenuGeometry;
    view: EditorView;
    session: CollabSession;
    actions: EditorActions;
    format: FormatState;
    canEdit: boolean;
    activeSurface: CollabSession["activeSurface"];
    container: HTMLElement | null;
  },
) {
  return publication.mount === controlMount
    && publication.geometry.authority === geometry.authority
    && publication.geometry.left === geometry.left
    && publication.geometry.top === geometry.top
    && publication.geometry.width === geometry.width
    && publication.authority === geometry.authority
    && publication.view === view
    && publication.container === container
    && publication.session === session
    && publication.actions === actions
    && publication.tableAction === actions.table
    && publication.alignAction === actions.setColumnAlign
    && publication.format === format
    && publication.tablePos === format.tablePos
    && publication.tableAlign === format.tableAlign
    && publication.canEdit === canEdit
    && publication.activeSurface === activeSurface;
}

function TableMenuControls({
  geometry,
  view,
  session,
  actions,
  format,
  canEdit,
  activeSurface,
  containerRef,
  authorityRef,
}: {
  geometry: TableMenuGeometry;
  view: EditorView;
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  canEdit: boolean;
  activeSurface: CollabSession["activeSurface"];
  containerRef: React.RefObject<HTMLElement | null>;
  authorityRef: React.RefObject<TableMenuAuthority | null>;
}) {
  const [controlMount] = useState(() => Symbol("table-menu-controls"));
  const [controlCoordinator] = useState(() => new TableMenuControlCoordinator());
  const [, setPublicationRevision] = useState(0);
  const controlSet = createControlPublication({
    coordinator: controlCoordinator,
    mount: controlMount,
    geometry,
    view,
    container: geometry.authority.container,
    session,
    actions,
    format,
    canEdit,
    activeSurface,
  });
  const { publication, controls } = controlSet;

  useLayoutEffect(() => {
    const current = publication.authority.active
      && authorityRef.current === publication.authority
      && publicationMatchesRender(publication, {
        controlMount,
        geometry,
        view,
        session,
        actions,
        format,
        canEdit,
        activeSurface,
        container: containerRef.current,
      })
      && publication.authority.container === publication.container
      && publication.authority.format === publication.format
      && publication.authority.canEdit === publication.canEdit
      && publication.authority.activeSurface === publication.activeSurface
      && publication.session.canEdit === publication.canEdit
      && publication.session.activeSurface === publication.activeSurface
      && publication.tablePos >= 0
      && publication.canEdit
      && publication.activeSurface === "rich";
    if (current && !controlCoordinator.publish(publication)) {
      if (controlCoordinator.replay(publication)) {
        setPublicationRevision((revision) => revision + 1);
      }
    } else {
      if (!current) controlCoordinator.retire(publication);
    }
    return () => controlCoordinator.retire(publication);
  }, [
    actions,
    activeSurface,
    authorityRef,
    canEdit,
    containerRef,
    controlCoordinator,
    controlMount,
    format,
    geometry,
    publication,
    session,
    view,
  ]);

  const { left, top, width } = publication.geometry;
  const ownsControl = (control: TableMenuControl, event: ReactMouseEvent<HTMLButtonElement>) => {
    if (
      control.publication !== publication
      || !publication.controls.has(control)
      || !controlCoordinator.ownsControl(publication, control, event.currentTarget)
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
    if (ownsControl(control, event)) event.preventDefault();
  };
  const onClick = (control: TableMenuControl) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!ownsControl(control, event)) return;
    control.claimed = true;
    control.invoke();
  };

  return (
    <div
      ref={(element) => publication.bindRoot(element)}
      className="touch-target scrollbar-thin absolute z-30 flex items-center gap-0.5 overflow-x-auto rounded-lg bg-inverse px-1 py-1 shadow-xl animate-fade-in dark:ring-1 dark:ring-white/10"
      style={{ left, top, width }}
      data-testid="table-menu"
      role="toolbar"
      aria-label="Table"
    >
      <MenuButton label="Row above" keys="Mod-Alt-↑" buttonRef={controls.rowBefore.buttonRef} onMouseDown={onMouseDown(controls.rowBefore)} onClick={onClick(controls.rowBefore)} testId="table-row-before">
        <ArrowUpToLine size={16} />
      </MenuButton>
      <MenuButton label="Row below" keys="Mod-Alt-↓" buttonRef={controls.rowAfter.buttonRef} onMouseDown={onMouseDown(controls.rowAfter)} onClick={onClick(controls.rowAfter)} testId="table-row-after">
        <ArrowDownToLine size={16} />
      </MenuButton>
      <MenuButton label="Column left" keys="Mod-Alt-←" buttonRef={controls.colBefore.buttonRef} onMouseDown={onMouseDown(controls.colBefore)} onClick={onClick(controls.colBefore)} testId="table-col-before">
        <ArrowLeftToLine size={16} />
      </MenuButton>
      <MenuButton label="Column right" keys="Mod-Alt-→" buttonRef={controls.colAfter.buttonRef} onMouseDown={onMouseDown(controls.colAfter)} onClick={onClick(controls.colAfter)} testId="table-col-after">
        <ArrowRightToLine size={16} />
      </MenuButton>
      <span className="mx-0.5 h-5 w-px bg-white/20" />
      <MenuButton label="Delete row" keys="Mod-Alt-⌫" buttonRef={controls.deleteRow.buttonRef} onMouseDown={onMouseDown(controls.deleteRow)} onClick={onClick(controls.deleteRow)} testId="table-delete-row">
        <TableRowsSplit size={16} />
      </MenuButton>
      <MenuButton label="Delete column" keys="Mod-Alt-Shift-⌫" buttonRef={controls.deleteColumn.buttonRef} onMouseDown={onMouseDown(controls.deleteColumn)} onClick={onClick(controls.deleteColumn)} testId="table-delete-col">
        <TableColumnsSplit size={16} />
      </MenuButton>
      <span className="mx-0.5 h-5 w-px bg-white/20" />
      <MenuButton label="Align left" active={format.tableAlign === "left"} buttonRef={controls.alignLeft.buttonRef} onMouseDown={onMouseDown(controls.alignLeft)} onClick={onClick(controls.alignLeft)} testId="table-align-left">
        <TextAlignStart size={16} />
      </MenuButton>
      <MenuButton label="Align center" active={format.tableAlign === "center"} buttonRef={controls.alignCenter.buttonRef} onMouseDown={onMouseDown(controls.alignCenter)} onClick={onClick(controls.alignCenter)} testId="table-align-center">
        <TextAlignCenter size={16} />
      </MenuButton>
      <MenuButton label="Align right" active={format.tableAlign === "right"} buttonRef={controls.alignRight.buttonRef} onMouseDown={onMouseDown(controls.alignRight)} onClick={onClick(controls.alignRight)} testId="table-align-right">
        <TextAlignEnd size={16} />
      </MenuButton>
      <span className="mx-0.5 h-5 w-px bg-white/20" />
      <MenuButton label="Delete table" buttonRef={controls.deleteTable.buttonRef} onMouseDown={onMouseDown(controls.deleteTable)} onClick={onClick(controls.deleteTable)} testId="table-delete">
        <Trash2 size={16} />
      </MenuButton>
    </div>
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

  if (!geometry || !view || geometry.authority.view !== view || geometry.authority.session !== session) {
    return null;
  }
  return (
    <TableMenuControls
      geometry={geometry}
      view={view}
      session={session}
      actions={actions}
      format={format}
      canEdit={canEdit}
      activeSurface={activeSurface}
      containerRef={containerRef}
      authorityRef={authorityRef}
    />
  );
}
