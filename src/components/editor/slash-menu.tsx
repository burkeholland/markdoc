"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { EditorView } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import { Bot, Calendar, Heading1, Heading2, Heading3, Image, Link, List, ListChecks, ListOrdered, MessageSquarePlus, Minus, Quote, SquareCode, Table, Type, type LucideIcon } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { tableAt } from "@/editor/prosemirror/commands";
import {
  applySlashCommand,
  applySlashItem,
  closeSlashMenu,
  isSlashKeyPublication,
  type SlashKeyAction,
  type SlashKeyPublication,
  type SlashMenuHandlers,
  type SlashState,
} from "@/editor/prosemirror/slash-menu";
import { SLASH_GROUPS, SLASH_ITEMS, filterSlashItems, splitSlashQuery, type SlashGroup, type SlashItem, type SlashWhere } from "@/editor/slash-items";
import { cn } from "@/lib/utils";
import { clampToViewport } from "@/lib/viewport";
import { useSessionValue } from "./use-session";

const ICONS: Record<string, LucideIcon> = { Type, Heading1, Heading2, Heading3, List, ListOrdered, ListChecks, Quote, SquareCode, Minus, Table, Image, Link, MessageSquarePlus, Calendar, Bot };

const MENU_WIDTH = 288;
const ROW_HEIGHT = 36;
/** Rows with a description line (the `/agent` item). */
const ROW_HEIGHT_TALL = 52;
/** The "Insert" / "Blocks" group caption above each group's rows (pt-1.5 + 16 px line + pb-0.5). */
const GROUP_HEADER_HEIGHT = 24;
const MAX_VISIBLE = 8;
const MENU_MAX_HEIGHT = ROW_HEIGHT * MAX_VISIBLE + 8;

const rowHeight = (item: SlashItem) => (item.description ? ROW_HEIGHT_TALL : ROW_HEIGHT);

/**
 * Glue between the ProseMirror plugin (which owns the `/query` range and
 * intercepts navigation keys) and the React menu (which owns the filtered
 * list and the highlighted row). Create one per shell and hand `handlers`
 * to the rich pane.
 */
export interface SlashMenuController {
  handlers: SlashMenuHandlers;
  subscribe: (listener: (state: SlashState | null) => void) => () => void;
  getState: () => SlashState | null;
  setKeyHandler: (handler: (publication: SlashKeyPublication) => boolean) => () => void;
}

export function createSlashMenuController(): SlashMenuController {
  let state: SlashState | null = null;
  type ListenerOwner = {
    readonly identity: symbol;
    readonly listener: (state: SlashState | null) => void;
    active: boolean;
  };
  type ControllerKeyOwner = {
    readonly identity: symbol;
    readonly handler: (publication: SlashKeyPublication) => boolean;
    readonly listeners: readonly ListenerOwner[];
    active: boolean;
  };
  let keyOwner: ControllerKeyOwner | null = null;
  const listeners = new Set<ListenerOwner>();
  const attemptedPublications = new WeakSet<SlashKeyPublication>();
  return {
    handlers: {
      onState: (next) => {
        state = next;
        for (const owner of listeners) owner.listener(next);
      },
      onKey: (publication) => {
        const owner = keyOwner;
        if (
          !owner ||
          !owner.active ||
          !isSlashKeyPublication(publication) ||
          publication.state !== state ||
          attemptedPublications.has(publication) ||
          owner.listeners.length !== listeners.size ||
          owner.listeners.some((listener) => !listener.active || !listeners.has(listener))
        ) {
          return false;
        }
        attemptedPublications.add(publication);
        const accepted = owner.handler(publication);
        return accepted && keyOwner === owner && owner.active;
      },
    },
    subscribe: (listener) => {
      const owner: ListenerOwner = { identity: Symbol("slash-state-subscription"), listener, active: true };
      listeners.add(owner);
      return () => {
        if (!owner.active) return;
        owner.active = false;
        listeners.delete(owner);
      };
    },
    getState: () => state,
    setKeyHandler: (handler) => {
      const owner: ControllerKeyOwner = {
        identity: Symbol("slash-key-handler"),
        handler,
        listeners: Object.freeze([...listeners]),
        active: true,
      };
      keyOwner = owner;
      return () => {
        if (!owner.active) return;
        owner.active = false;
        if (keyOwner === owner) keyOwner = null;
      };
    },
  };
}

export function useSlashMenuController(): SlashMenuController {
  return useMemo(() => createSlashMenuController(), []);
}

/** Selects the text of the block around the caret so a comment can anchor to it. */
function selectCurrentBlock(view: EditorView) {
  const { $from } = view.state.selection;
  const start = $from.start();
  const end = $from.end();
  if (end > start) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start, end)));
}

type SlashMenuAuthority = {
  controller: SlashMenuController;
  view: EditorView;
  session: CollabSession;
};

type SlashMenuSnapshot = {
  authority: SlashMenuAuthority;
  state: SlashState | null;
  subscription: SubscriptionOwner | null;
};

type SubscriptionOwner = {
  readonly authority: SlashMenuAuthority;
  readonly identity: symbol;
  active: boolean;
};

type HighlightOwner = {
  authority: SlashMenuAuthority;
  query: string;
  index: number;
};

type PositionOwner = {
  snapshot: SlashMenuSnapshot;
  value: PositionValue;
};

type KeyOwner = {
  authority: SlashMenuAuthority;
  readonly identity: symbol;
  readonly subscription: SubscriptionOwner;
  retire: () => void;
};

type PositionValue = Readonly<{
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  container: HTMLElement;
  containerRect: HTMLElement["getBoundingClientRect"];
  ownerDocument: Document;
  ownerWindow: Window & typeof globalThis;
  hostLeft: number;
  hostTop: number;
  hostWidth: number;
  hostHeight: number;
  scrollTop: number;
  viewportWidth: number;
  viewportHeight: number;
}>;

type SlashStateFacts = Readonly<{
  source: SlashState;
  coordsSource: SlashState["coords"];
  from: number;
  to: number;
  query: string;
  left: number;
  top: number;
  bottom: number;
}>;

type PointerItem = Readonly<{
  source: SlashItem;
  sourceKeywords: string[];
  index: number;
  groupIndex: number;
  id: string;
  title: string;
  description: string | undefined;
  keywords: readonly string[];
  icon: string;
  group: SlashGroup;
  acceptsArg: boolean | undefined;
  hint: string | undefined;
  available: SlashItem["available"];
  command: SlashItem["command"];
  run: SlashItem["run"];
  height: number;
}>;

type PointerGroup = Readonly<{
  group: SlashGroup;
  order: number;
  registryOrder: number;
  items: readonly PointerItem[];
}>;

type PointerCallbacks = Readonly<{
  onImage: () => void;
  onLink: () => void;
  onComment: () => void;
  onKeepAgent: () => void;
}>;

type PointerPresentation = Readonly<{
  mount: symbol;
  authority: SlashMenuAuthority;
  snapshot: SlashMenuSnapshot;
  state: SlashStateFacts;
  editorState: EditorView["state"];
  controllerGetState: SlashMenuController["getState"];
  sessionUndoManager: CollabSession["undoManager"];
  viewFocus: EditorView["focus"];
  viewDispatch: EditorView["dispatch"];
  canEdit: boolean;
  canComment: boolean;
  where: Readonly<SlashWhere>;
  sourceItems: readonly SlashItem[];
  sourceGroups: readonly SlashGroup[];
  items: readonly PointerItem[];
  groups: readonly PointerGroup[];
  highlightedIndex: number;
  argument: string;
  callbacks: PointerCallbacks;
  position: PositionValue;
}>;

interface PointerGroupElements {
  root: HTMLDivElement | null;
  heading: HTMLDivElement | null;
}

interface PointerRowElements {
  root: HTMLButtonElement | null;
  icon: SVGSVGElement | null;
  body: HTMLSpanElement | null;
  title: HTMLSpanElement | null;
  description: HTMLSpanElement | null;
  hint: HTMLSpanElement | null;
}

interface PointerPresentationRuntime {
  retired: boolean;
  effectReplay: CommittedPointerPresentation | null;
  detachedCommit: CommittedPointerPresentation | null;
  detachedElements: Set<Element>;
  domHistory: PointerDomHistory | null;
  root: HTMLDivElement | null;
  groups: PointerGroupElements[];
  rows: PointerRowElements[];
  empty: HTMLDivElement | null;
  committed: CommittedPointerPresentation | null;
  highlightClaimed: boolean;
  itemClaimed: boolean;
}

interface PointerRootOwner {
  candidate: PointerPresentation;
  element: HTMLDivElement;
}

type PointerDomPlacement = Readonly<{
  node: Node;
  parent: Node;
  previousSibling: Node | null;
  nextSibling: Node | null;
  exactSiblings: boolean;
}>;

interface PointerDomHistory {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

type DomTree = Readonly<{
  node: Node;
  nodeValue: string | null;
  attributes: readonly (readonly [string, string])[];
  children: readonly DomTree[];
}>;

type CommittedPointerRow = Readonly<{
  item: PointerItem;
  elements: Readonly<{
    root: HTMLButtonElement;
    icon: SVGSVGElement;
    body: HTMLSpanElement;
    title: HTMLSpanElement;
    description: HTMLSpanElement | null;
    hint: HTMLSpanElement | null;
  }>;
  tree: DomTree;
}>;

type CommittedPointerGroup = Readonly<{
  group: PointerGroup;
  root: HTMLDivElement;
  heading: HTMLDivElement;
}>;

type CommittedPointerPresentation = Readonly<{
  source: PointerPresentation;
  root: HTMLDivElement;
  rootTree: DomTree;
  groups: readonly CommittedPointerGroup[];
  rows: readonly CommittedPointerRow[];
  empty: HTMLDivElement | null;
  emptyTree: DomTree | null;
}>;

function snapshotDomTree(node: Node): DomTree {
  const element = node.nodeType === 1 ? (node as Element) : null;
  const attributes = element
    ? Object.freeze(element.getAttributeNames().sort().map((name) => Object.freeze([name, element.getAttribute(name) ?? ""] as const)))
    : Object.freeze([]);
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes,
    children: Object.freeze(Array.from(node.childNodes, snapshotDomTree)),
  });
}

function domTreeIsCurrent(tree: DomTree): boolean {
  if (tree.node.nodeValue !== tree.nodeValue) return false;
  const element = tree.node.nodeType === 1 ? (tree.node as Element) : null;
  if (element) {
    const names = element.getAttributeNames().sort();
    if (
      names.length !== tree.attributes.length ||
      tree.attributes.some(([name, value], index) => names[index] !== name || element.getAttribute(name) !== value)
    ) {
      return false;
    }
  } else if (tree.attributes.length !== 0) {
    return false;
  }
  if (tree.node.childNodes.length !== tree.children.length) return false;
  return tree.children.every((child, index) => tree.node.childNodes.item(index) === child.node && domTreeIsCurrent(child));
}

function domTreeContains(tree: DomTree, target: Node): boolean {
  return tree.node === target || tree.children.some((child) => domTreeContains(child, target));
}

function capturePointerPlacement(root: Node): readonly PointerDomPlacement[] | null {
  if (!root.isConnected) return null;
  const placements: PointerDomPlacement[] = [];
  let current: Node = root;
  while (current !== root.ownerDocument) {
    const parent = current.parentNode;
    if (!parent) return null;
    placements.push(
      Object.freeze({
        node: current,
        parent,
        previousSibling: current.previousSibling,
        nextSibling: current.nextSibling,
        exactSiblings: current === root,
      }),
    );
    current = parent;
  }
  return Object.freeze(placements);
}

function pointerPlacementIsCurrent(placements: readonly PointerDomPlacement[]): boolean {
  return placements.every(
    (placement) =>
      placement.node.parentNode === placement.parent &&
      (!placement.exactSiblings ||
        (placement.node.previousSibling === placement.previousSibling &&
          placement.node.nextSibling === placement.nextSibling)),
  );
}

function pointerPlacementRecordChanged(record: MutationRecord, placement: PointerDomPlacement): boolean {
  if (record.type !== "childList" || record.target !== placement.parent) return false;
  if (
    placement.exactSiblings &&
    (record.previousSibling === placement.node || record.nextSibling === placement.node)
  ) {
    return true;
  }
  return [...record.addedNodes, ...record.removedNodes].some((node) => {
    let current: Node | null = placement.node;
    while (current) {
      if (current === node) return true;
      current = current.parentNode;
    }
    return false;
  });
}

function createPointerDomHistory(root: HTMLDivElement): PointerDomHistory | null {
  const ownerWindow = root.ownerDocument.defaultView;
  const placements = capturePointerPlacement(root);
  const MutationObserverConstructor = ownerWindow?.MutationObserver;
  if (!ownerWindow || !placements || typeof MutationObserverConstructor !== "function") return null;
  const mutationPrototype = MutationObserverConstructor.prototype;
  const elementPrototype = ownerWindow.Element.prototype;
  const nodePrototype = ownerWindow.Node.prototype;
  const observe = mutationPrototype.observe;
  const takeRecords = mutationPrototype.takeRecords;
  const disconnect = mutationPrototype.disconnect;
  const scrollIntoView = elementPrototype.scrollIntoView;
  const contains = nodePrototype.contains;
  if (
    typeof observe !== "function" ||
    typeof takeRecords !== "function" ||
    typeof disconnect !== "function" ||
    typeof scrollIntoView !== "function" ||
    typeof contains !== "function"
  ) {
    return null;
  }
  let changed = false;
  let released = false;
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some(
      (record) =>
        record.target === root ||
        ownerWindow.Reflect.apply(contains, root, [record.target]) ||
        placements.some((placement) => pointerPlacementRecordChanged(record, placement)),
    );
  };
  const observer = new MutationObserverConstructor(recordChanges);
  observer.observe(root, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  for (const placement of placements) observer.observe(placement.parent, { childList: true });
  return Object.freeze({
    isClean: () => {
      if (released || changed) return false;
      if (
        root.ownerDocument.defaultView !== ownerWindow ||
        ownerWindow.MutationObserver !== MutationObserverConstructor ||
        MutationObserverConstructor.prototype !== mutationPrototype ||
        ownerWindow.Element.prototype !== elementPrototype ||
        ownerWindow.Node.prototype !== nodePrototype ||
        mutationPrototype.observe !== observe ||
        mutationPrototype.takeRecords !== takeRecords ||
        mutationPrototype.disconnect !== disconnect ||
        elementPrototype.scrollIntoView !== scrollIntoView ||
        nodePrototype.contains !== contains
      ) {
        changed = true;
        return false;
      }
      recordChanges(observer.takeRecords());
      if (!root.isConnected || !pointerPlacementIsCurrent(placements)) changed = true;
      return !changed;
    },
    release: () => {
      if (released) return;
      recordChanges(observer.takeRecords());
      observer.disconnect();
      released = true;
    },
  });
}

function snapshotPointerItem(item: SlashItem, index: number, groupIndex: number): PointerItem {
  return Object.freeze({
    source: item,
    sourceKeywords: item.keywords,
    index,
    groupIndex,
    id: item.id,
    title: item.title,
    description: item.description,
    keywords: Object.freeze([...item.keywords]),
    icon: item.icon,
    group: item.group,
    acceptsArg: item.acceptsArg,
    hint: item.hint,
    available: item.available,
    command: item.command,
    run: item.run,
    height: rowHeight(item),
  });
}

function pointerItemIsCurrent(item: PointerItem, source: SlashItem): boolean {
  if (
    source !== item.source ||
    source.keywords !== item.sourceKeywords ||
    source.id !== item.id ||
    source.title !== item.title ||
    source.description !== item.description ||
    source.icon !== item.icon ||
    source.group !== item.group ||
    source.acceptsArg !== item.acceptsArg ||
    source.hint !== item.hint ||
    source.available !== item.available ||
    source.command !== item.command ||
    source.run !== item.run ||
    source.keywords.length !== item.keywords.length
  ) {
    return false;
  }
  return item.keywords.every((keyword, index) => source.keywords[index] === keyword);
}

export function SlashMenu({
  view,
  session,
  controller,
  containerRef,
  onImage,
  onLink,
  onComment,
  onKeepAgent,
}: {
  view: EditorView | null;
  session: CollabSession;
  controller: SlashMenuController;
  containerRef: React.RefObject<HTMLElement | null>;
  onImage: () => void;
  onLink: () => void;
  onComment: () => void;
  /** `/agent`: opens the "Keep an agent here" dialog. */
  onKeepAgent: () => void;
}) {
  const [mount] = useState(() => Symbol("slash-menu"));
  const authority = useMemo<SlashMenuAuthority | null>(
    () => (view ? Object.freeze({ controller, view, session }) : null),
    [controller, view, session],
  );
  const authorityRef = useRef<SlashMenuAuthority | null>(null);
  const retiredControllersRef = useRef(new WeakSet<SlashMenuController>());
  const subscriptionOwnerRef = useRef<SubscriptionOwner | null>(null);
  const keyOwnerRef = useRef<KeyOwner | null>(null);
  const pendingKeyActionRef = useRef<SlashKeyAction | null>(null);
  const claimedKeyPublicationsRef = useRef(new WeakSet<SlashKeyPublication>());
  const claimedKeyActionsRef = useRef(new WeakSet<SlashKeyAction>());
  const pointerRuntimesRef = useRef(new WeakMap<PointerPresentation, PointerPresentationRuntime>());
  const activePointerRef = useRef<CommittedPointerPresentation | null>(null);
  const pointerRootOwnerRef = useRef<PointerRootOwner | null>(null);
  const claimedNativeEventsRef = useRef(new WeakSet<Event>());
  const [snapshot, setSnapshot] = useState<SlashMenuSnapshot | null>(() =>
    authority ? Object.freeze({ authority, state: controller.getState(), subscription: null }) : null,
  );
  const currentSnapshot =
    snapshot?.authority === authority &&
    snapshot.subscription?.active
      ? snapshot
      : null;
  const state = currentSnapshot?.state ?? null;
  const query = state ? `${state.from}:${state.query}` : "";
  const [highlight, setHighlight] = useState<HighlightOwner | null>(null);
  const index = highlight?.authority === authority && highlight.query === query ? highlight.index : 0;
  const [position, setPosition] = useState<PositionOwner | null>(null);
  const pos = position?.snapshot === currentSnapshot ? position.value : null;
  const canEdit = useSessionValue(session, (s) => s.canEdit);
  const canComment = useSessionValue(session, (s) => s.canComment);
  const editorDocument = view?.dom.ownerDocument ?? null;

  useLayoutEffect(() => {
    const retiredControllers = retiredControllersRef.current;
    if (!authority) {
      setSnapshot(null);
      return;
    }
    authorityRef.current = authority;
    const subscription: SubscriptionOwner = {
      authority,
      identity: Symbol("slash-menu-subscription"),
      active: true,
    };
    subscriptionOwnerRef.current = subscription;
    const publish = (next: SlashState | null) => {
      if (
        authorityRef.current !== authority ||
        subscriptionOwnerRef.current !== subscription ||
        !subscription.active
      ) {
        return;
      }
      setSnapshot(Object.freeze({ authority, state: next, subscription }));
    };
    const unsubscribe = controller.subscribe(publish);
    setSnapshot((current) => {
      if (
        current?.authority === authority &&
        current.subscription === subscription
      ) {
        return current;
      }
      // A shared controller still contains the retired view's last publication.
      // Its replacement visit starts closed until that view publishes for itself.
      const sameAuthority = current?.authority === authority;
      const retired =
        !sameAuthority &&
        (current?.authority.controller === controller ||
          retiredControllers.has(controller));
      const next = retired ? null : controller.getState();
      return Object.freeze({ authority, state: next, subscription });
    });
    return () => {
      retiredControllers.add(controller);
      subscription.active = false;
      if (subscriptionOwnerRef.current === subscription) {
        subscriptionOwnerRef.current = null;
      }
      if (authorityRef.current === authority) authorityRef.current = null;
      const keyOwner = keyOwnerRef.current;
      if (keyOwner?.authority === authority) keyOwner.retire();
      const pending = pendingKeyActionRef.current;
      if (pending?.publication.view === authority.view) pending.cancel();
      unsubscribe();
    };
  }, [authority, controller]);

  const where: SlashWhere = useMemo(() => ({ inTable: !!(view && state && tableAt(view.state)), canComment }), [view, state, canComment]);
  const items = useMemo(() => (state ? filterSlashItems(state.query, SLASH_ITEMS, where) : []), [state, where]);
  const open =
    !!state &&
    canEdit &&
    !!view &&
    !!currentSnapshot?.subscription &&
    currentSnapshot.subscription.active;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!open || !state || !currentSnapshot || !container) {
      setPosition((current) => (current?.snapshot === currentSnapshot ? null : current));
      return;
    }
    const ownerDocument = container.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (!ownerWindow || editorDocument !== ownerDocument) {
      setPosition((current) => (current?.snapshot === currentSnapshot ? null : current));
      return;
    }
    const host = container.getBoundingClientRect();
    // Rows plus one caption per group shown; short lists used to be cut off because the captions were not counted.
    const groupsShown = new Set(items.map((item) => item.group)).size;
    const listHeight = groupsShown * GROUP_HEADER_HEIGHT + items.reduce((h, item) => h + rowHeight(item), 0);
    const height = Math.min(MENU_MAX_HEIGHT, Math.max(ROW_HEIGHT, listHeight) + 8);
    const viewport = { width: ownerWindow.innerWidth, height: ownerWindow.innerHeight };
    const below = state.coords.bottom + 6 + height <= viewport.height - 8;
    const box = clampToViewport({ left: state.coords.left, top: below ? state.coords.bottom + 6 : state.coords.top - 6 - height, width: MENU_WIDTH, height }, viewport);
    const left = Math.max(8, Math.min(host.width - box.width - 8, box.left - host.left));
    const top = box.top - host.top + container.scrollTop;
    setPosition({
      snapshot: currentSnapshot,
      value: Object.freeze({
        left,
        top,
        width: box.width,
        maxHeight: box.height,
        container,
        containerRect: container.getBoundingClientRect,
        ownerDocument,
        ownerWindow,
        hostLeft: host.left,
        hostTop: host.top,
        hostWidth: host.width,
        hostHeight: host.height,
        scrollTop: container.scrollTop,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      }),
    });
  }, [open, state, currentSnapshot, items, containerRef, editorDocument]);

  const pointerPresentation = (() => {
    if (!open || !pos || !authority || !currentSnapshot || !state || !view) return null;
    const groupIndexes = new Map<SlashGroup, number>();
    const pointerItems = Object.freeze(
      items.map((item, itemIndex) => {
        const groupIndex = groupIndexes.get(item.group) ?? 0;
        groupIndexes.set(item.group, groupIndex + 1);
        return snapshotPointerItem(item, itemIndex, groupIndex);
      }),
    );
    const pointerGroups = Object.freeze(
      SLASH_GROUPS.map((group, registryOrder) => ({
        group,
        registryOrder,
        items: Object.freeze(pointerItems.filter((item) => item.group === group)),
      }))
        .filter((group) => group.items.length > 0)
        .map((group, order) => Object.freeze({ ...group, order })),
    );
    const stateFacts: SlashStateFacts = Object.freeze({
      source: state,
      coordsSource: state.coords,
      from: state.from,
      to: state.to,
      query: state.query,
      left: state.coords.left,
      top: state.coords.top,
      bottom: state.coords.bottom,
    });
    return Object.freeze({
      mount,
      authority,
      snapshot: currentSnapshot,
      state: stateFacts,
      editorState: view.state,
      controllerGetState: controller.getState,
      sessionUndoManager: session.undoManager,
      viewFocus: view.focus,
      viewDispatch: view.dispatch,
      canEdit,
      canComment,
      where: Object.freeze({ inTable: where.inTable, canComment: where.canComment }),
      sourceItems: Object.freeze([...items]),
      sourceGroups: Object.freeze([...SLASH_GROUPS]),
      items: pointerItems,
      groups: pointerGroups,
      highlightedIndex: index,
      argument: splitSlashQuery(state.query).arg,
      callbacks: Object.freeze({ onImage, onLink, onComment, onKeepAgent }),
      position: pos,
    } satisfies PointerPresentation);
  })();

  function createPointerRuntime(
    candidate: PointerPresentation,
    previous?: PointerPresentationRuntime,
  ): PointerPresentationRuntime {
    return {
      retired: false,
      effectReplay: null,
      detachedCommit: null,
      detachedElements: new Set(),
      domHistory: null,
      root: previous?.root ?? null,
      groups: candidate.groups.map((_, index) => ({
        root: previous?.groups[index]?.root ?? null,
        heading: previous?.groups[index]?.heading ?? null,
      })),
      rows: candidate.items.map((_, index) => ({
        root: previous?.rows[index]?.root ?? null,
        icon: previous?.rows[index]?.icon ?? null,
        body: previous?.rows[index]?.body ?? null,
        title: previous?.rows[index]?.title ?? null,
        description: previous?.rows[index]?.description ?? null,
        hint: previous?.rows[index]?.hint ?? null,
      })),
      empty: previous?.empty ?? null,
      committed: null,
      highlightClaimed: false,
      itemClaimed: false,
    };
  }

  function runtimeFor(candidate: PointerPresentation): PointerPresentationRuntime {
    const runtimes = pointerRuntimesRef.current;
    let runtime = runtimes.get(candidate);
    if (!runtime) {
      runtime = createPointerRuntime(candidate);
      runtimes.set(candidate, runtime);
    }
    return runtime;
  }

  function retirePointer(
    candidate: PointerPresentation,
    expectedRuntime?: PointerPresentationRuntime,
    reason: "ordinary" | "ref" | "effect" = "ordinary",
    detachedElement?: Element,
  ): void {
    const runtime = expectedRuntime ?? pointerRuntimesRef.current.get(candidate);
    if (!runtime) return;
    const committed = runtime.committed;
    if (reason === "ordinary") {
      runtime.effectReplay = null;
      runtime.detachedCommit = null;
      runtime.detachedElements.clear();
      runtime.domHistory?.release();
      runtime.domHistory = null;
    } else if (reason === "ref" && committed && activePointerRef.current === committed) {
      runtime.detachedCommit = committed;
      if (detachedElement) runtime.detachedElements.add(detachedElement);
    } else if (reason === "ref" && runtime.detachedCommit && detachedElement) {
      runtime.detachedElements.add(detachedElement);
    } else if (reason === "effect") {
      const replay = committed && activePointerRef.current === committed ? committed : runtime.detachedCommit;
      if (replay && (!activePointerRef.current || activePointerRef.current === replay)) {
        runtime.effectReplay = replay;
      }
    }
    runtime.retired = true;
    if (committed && activePointerRef.current === committed) activePointerRef.current = null;
    runtime.committed = null;
    if (reason !== "ordinary") {
      queueMicrotask(() => {
        if (
          runtime.retired &&
          pointerRuntimesRef.current.get(candidate) === runtime &&
          runtime.domHistory
        ) {
          runtime.domHistory.release();
          runtime.domHistory = null;
        }
      });
    }
  }

  function bindPointerRoot(candidate: PointerPresentation, element: HTMLDivElement | null): void {
    const runtime = runtimeFor(candidate);
    const rootOwner = pointerRootOwnerRef.current;
    if (!element && rootOwner?.candidate === candidate) pointerRootOwnerRef.current = null;
    if (runtime.root === element) return;
    if (!element) {
      if (runtime.root) {
        const detached = runtime.root;
        runtime.root = null;
        retirePointer(candidate, runtime, "ref", detached);
      }
      return;
    }
    if (runtime.retired && rootOwner && rootOwner.candidate !== candidate) return;
    if (runtime.root && runtime.root !== element) retirePointer(candidate);
    runtime.root = element;
    pointerRootOwnerRef.current = { candidate, element };
    if (runtime.retired && (runtime.effectReplay || runtime.detachedCommit)) establishPointer(candidate);
  }

  function bindPointerGroup<K extends keyof PointerGroupElements>(
    candidate: PointerPresentation,
    group: PointerGroup,
    kind: K,
    element: PointerGroupElements[K],
  ): void {
    const runtime = runtimeFor(candidate);
    const elements = runtime.groups[group.order];
    if (!elements || candidate.groups[group.order] !== group || elements[kind] === element) return;
    if (!element) {
      if (elements[kind]) {
        const detached = elements[kind];
        elements[kind] = null;
        retirePointer(candidate, runtime, "ref", detached);
      }
      return;
    }
    if (elements[kind] && elements[kind] !== element) retirePointer(candidate);
    elements[kind] = element;
    if (runtime.retired && (runtime.effectReplay || runtime.detachedCommit)) establishPointer(candidate);
  }

  function bindPointerRow<K extends keyof PointerRowElements>(
    candidate: PointerPresentation,
    item: PointerItem,
    kind: K,
    element: PointerRowElements[K],
  ): void {
    const runtime = runtimeFor(candidate);
    const elements = runtime.rows[item.index];
    if (!elements || candidate.items[item.index] !== item || elements[kind] === element) return;
    if (!element) {
      if (elements[kind]) {
        const detached = elements[kind];
        elements[kind] = null;
        retirePointer(candidate, runtime, "ref", detached);
      }
      return;
    }
    if (elements[kind] && elements[kind] !== element) retirePointer(candidate);
    elements[kind] = element;
    if (runtime.retired && (runtime.effectReplay || runtime.detachedCommit)) establishPointer(candidate);
  }

  function bindPointerEmpty(candidate: PointerPresentation, element: HTMLDivElement | null): void {
    const runtime = runtimeFor(candidate);
    if (runtime.empty === element) return;
    if (!element) {
      if (runtime.empty) {
        const detached = runtime.empty;
        runtime.empty = null;
        retirePointer(candidate, runtime, "ref", detached);
      }
      return;
    }
    if (runtime.empty && runtime.empty !== element) retirePointer(candidate);
    runtime.empty = element;
    if (runtime.retired && (runtime.effectReplay || runtime.detachedCommit)) establishPointer(candidate);
  }

  function pointerFactsAreCurrent(candidate: PointerPresentation): boolean {
    const { authority: owner, state: stateFacts, position: geometry } = candidate;
    const rootOwner = pointerRootOwnerRef.current;
    if (
      candidate.mount !== mount ||
      authorityRef.current !== owner ||
      owner.controller !== controller ||
      owner.view !== view ||
      owner.session !== session ||
      owner.controller.getState !== candidate.controllerGetState ||
      owner.view.state !== candidate.editorState ||
      owner.view.focus !== candidate.viewFocus ||
      owner.view.dispatch !== candidate.viewDispatch ||
      owner.session.undoManager !== candidate.sessionUndoManager ||
      owner.session.canEdit !== candidate.canEdit ||
      owner.session.canComment !== candidate.canComment ||
      !candidate.canEdit ||
      candidate.where.canComment !== candidate.canComment ||
      candidate.snapshot.authority !== owner ||
      candidate.snapshot.state !== stateFacts.source ||
      !candidate.snapshot.subscription?.active ||
      subscriptionOwnerRef.current !== candidate.snapshot.subscription ||
      containerRef.current !== geometry.container ||
      geometry.container.getBoundingClientRect !== geometry.containerRect ||
      geometry.container.ownerDocument !== geometry.ownerDocument ||
      geometry.ownerDocument.defaultView !== geometry.ownerWindow ||
      owner.view.dom.ownerDocument !== geometry.ownerDocument ||
      owner.view.dom.ownerDocument.defaultView !== geometry.ownerWindow ||
      rootOwner?.candidate !== candidate ||
      rootOwner.element !== pointerRuntimesRef.current.get(candidate)?.root
    ) {
      return false;
    }

    const liveState = owner.controller.getState();
    if (
      liveState !== stateFacts.source ||
      liveState.coords !== stateFacts.coordsSource ||
      liveState.from !== stateFacts.from ||
      liveState.to !== stateFacts.to ||
      liveState.query !== stateFacts.query ||
      liveState.coords.left !== stateFacts.left ||
      liveState.coords.top !== stateFacts.top ||
      liveState.coords.bottom !== stateFacts.bottom ||
      splitSlashQuery(liveState.query).arg !== candidate.argument
    ) {
      return false;
    }

    const liveWhere = { inTable: !!tableAt(owner.view.state), canComment: owner.session.canComment };
    if (liveWhere.inTable !== candidate.where.inTable || liveWhere.canComment !== candidate.where.canComment) return false;
    if (
      SLASH_GROUPS.length !== candidate.sourceGroups.length ||
      candidate.sourceGroups.some((group, groupIndex) => SLASH_GROUPS[groupIndex] !== group)
    ) {
      return false;
    }

    const liveItems = filterSlashItems(liveState.query, SLASH_ITEMS, liveWhere);
    if (liveItems.length !== candidate.items.length || candidate.sourceItems.length !== candidate.items.length) return false;
    const groupIndexes = new Map<SlashGroup, number>();
    for (let itemIndex = 0; itemIndex < liveItems.length; itemIndex++) {
      const liveItem = liveItems[itemIndex];
      const item = candidate.items[itemIndex];
      const groupIndex = groupIndexes.get(liveItem.group) ?? 0;
      groupIndexes.set(liveItem.group, groupIndex + 1);
      if (
        !item ||
        candidate.sourceItems[itemIndex] !== liveItem ||
        item.index !== itemIndex ||
        item.groupIndex !== groupIndex ||
        item.height !== rowHeight(liveItem) ||
        !pointerItemIsCurrent(item, liveItem)
      ) {
        return false;
      }
    }

    const currentGroups = candidate.sourceGroups
      .map((group) => liveItems.filter((item) => item.group === group))
      .filter((groupItems) => groupItems.length > 0);
    if (currentGroups.length !== candidate.groups.length) return false;
    for (let groupIndex = 0; groupIndex < candidate.groups.length; groupIndex++) {
      const group = candidate.groups[groupIndex];
      const liveGroupItems = currentGroups[groupIndex];
      if (
        !group ||
        !liveGroupItems ||
        group.order !== groupIndex ||
        group.registryOrder !== candidate.sourceGroups.indexOf(group.group) ||
        group.group !== liveGroupItems[0]?.group ||
        group.items.length !== liveGroupItems.length ||
        group.items.some((item, rowIndex) => item.source !== liveGroupItems[rowIndex] || item.groupIndex !== rowIndex)
      ) {
        return false;
      }
    }

    const host = geometry.container.getBoundingClientRect();
    return (
      host.left === geometry.hostLeft &&
      host.top === geometry.hostTop &&
      host.width === geometry.hostWidth &&
      host.height === geometry.hostHeight &&
      geometry.container.scrollTop === geometry.scrollTop &&
      geometry.ownerWindow.innerWidth === geometry.viewportWidth &&
      geometry.ownerWindow.innerHeight === geometry.viewportHeight
    );
  }

  function pointerDomIsCurrent(committed: CommittedPointerPresentation): boolean {
    const candidate = committed.source;
    const root = committed.root;
    const ownerWindow = root.ownerDocument.defaultView;
    if (
      !ownerWindow ||
      !(root instanceof ownerWindow.HTMLDivElement) ||
      !root.isConnected ||
      root.ownerDocument !== candidate.position.container.ownerDocument ||
      root.getAttribute("role") !== "listbox" ||
      root.getAttribute("aria-label") !== "Insert block" ||
      root.getAttribute("data-testid") !== "slash-menu" ||
      root.style.left !== `${candidate.position.left}px` ||
      root.style.top !== `${candidate.position.top}px` ||
      root.style.width !== `${candidate.position.width}px` ||
      root.style.maxHeight !== `${Math.min(MENU_MAX_HEIGHT, candidate.position.maxHeight)}px` ||
      committed.groups.length !== candidate.groups.length ||
      committed.rows.length !== candidate.items.length ||
      !domTreeIsCurrent(committed.rootTree)
    ) {
      return false;
    }

    if (candidate.items.length === 0) {
      return Boolean(
        committed.empty &&
        committed.emptyTree &&
        root.children.length === 1 &&
        root.firstElementChild === committed.empty &&
        committed.empty.parentElement === root &&
        committed.empty.isConnected &&
        committed.empty.getAttribute("role") === "option" &&
        committed.empty.getAttribute("aria-selected") === "true" &&
        committed.empty.getAttribute("data-testid") === "slash-empty" &&
        committed.empty.style.lineHeight === `${ROW_HEIGHT}px` &&
        committed.empty.textContent === "No matches" &&
        domTreeIsCurrent(committed.emptyTree),
      );
    }
    if (committed.empty || committed.emptyTree || root.children.length !== candidate.groups.length) return false;

    const seen = new Set<Element>();
    for (const group of committed.groups) {
      const groupFacts = group.group;
      if (
        !(group.root instanceof ownerWindow.HTMLDivElement) ||
        !(group.heading instanceof ownerWindow.HTMLDivElement) ||
        !group.root.isConnected ||
        !group.heading.isConnected ||
        group.root.parentElement !== root ||
        root.children.item(groupFacts.order) !== group.root ||
        group.heading.parentElement !== group.root ||
        group.root.firstElementChild !== group.heading ||
        group.heading.textContent !== groupFacts.group ||
        group.root.children.length !== groupFacts.items.length + 1 ||
        seen.has(group.root) ||
        seen.has(group.heading)
      ) {
        return false;
      }
      seen.add(group.root);
      seen.add(group.heading);

      for (const item of groupFacts.items) {
        const row = committed.rows[item.index];
        const elements = row?.elements;
        if (
          !row ||
          row.item !== item ||
          !elements ||
          !(elements.root instanceof ownerWindow.HTMLButtonElement) ||
          !(elements.icon instanceof ownerWindow.SVGSVGElement) ||
          !(elements.body instanceof ownerWindow.HTMLSpanElement) ||
          !(elements.title instanceof ownerWindow.HTMLSpanElement) ||
          (item.description
            ? !(elements.description instanceof ownerWindow.HTMLSpanElement)
            : elements.description !== null) ||
          (item.hint ? !(elements.hint instanceof ownerWindow.HTMLSpanElement) : elements.hint !== null) ||
          !elements.root.isConnected ||
          elements.root.disabled ||
          elements.root.parentElement !== group.root ||
          group.root.children.item(item.groupIndex + 1) !== elements.root ||
          elements.root.type !== "button" ||
          elements.root.getAttribute("role") !== "option" ||
          elements.root.getAttribute("aria-selected") !== String(item.index === candidate.highlightedIndex) ||
          elements.root.getAttribute("data-index") !== String(item.index) ||
          elements.root.getAttribute("data-testid") !== `slash-item-${item.id}` ||
          elements.root.style.height !== `${item.height}px` ||
          elements.root.classList.contains("bg-accent-soft") !== (item.index === candidate.highlightedIndex) ||
          elements.root.classList.contains("text-ink") !== (item.index === candidate.highlightedIndex) ||
          elements.root.firstElementChild !== elements.icon ||
          elements.icon.nextElementSibling !== elements.body ||
          elements.body.parentElement !== elements.root ||
          elements.body.firstElementChild !== elements.title ||
          elements.title.parentElement !== elements.body ||
          elements.title.textContent !== item.title ||
          elements.title.nextElementSibling !== elements.description ||
          (!!item.description && elements.description?.parentElement !== elements.body) ||
          elements.description?.textContent !== item.description ||
          elements.body.nextElementSibling !== elements.hint ||
          (!!item.hint && elements.hint?.parentElement !== elements.root) ||
          elements.hint?.textContent !== item.hint ||
          elements.root.children.length !== 2 + (item.hint ? 1 : 0) ||
          elements.body.children.length !== 1 + (item.description ? 1 : 0) ||
          seen.has(elements.root) ||
          !domTreeIsCurrent(row.tree)
        ) {
          return false;
        }
        seen.add(elements.root);
      }
    }
    return true;
  }

  function buildCommittedPointer(candidate: PointerPresentation): CommittedPointerPresentation | null {
    const runtime = runtimeFor(candidate);
    const root = runtime.root;
    if (runtime.retired || !root) return null;
    const groups: CommittedPointerGroup[] = [];
    for (const group of candidate.groups) {
      const elements = runtime.groups[group.order];
      if (!elements?.root || !elements.heading) return null;
      groups.push(Object.freeze({ group, root: elements.root, heading: elements.heading }));
    }
    const rows: CommittedPointerRow[] = [];
    for (const item of candidate.items) {
      const elements = runtime.rows[item.index];
      if (!elements?.root || !elements.icon || !elements.body || !elements.title) return null;
      if (item.description ? !elements.description : elements.description) return null;
      if (item.hint ? !elements.hint : elements.hint) return null;
      rows.push(
        Object.freeze({
          item,
          elements: Object.freeze({
            root: elements.root,
            icon: elements.icon,
            body: elements.body,
            title: elements.title,
            description: elements.description,
            hint: elements.hint,
          }),
          tree: snapshotDomTree(elements.root),
        }),
      );
    }
    if (candidate.items.length === 0 ? !runtime.empty : runtime.empty) return null;
    return Object.freeze({
      source: candidate,
      root,
      rootTree: snapshotDomTree(root),
      groups: Object.freeze(groups),
      rows: Object.freeze(rows),
      empty: runtime.empty,
      emptyTree: runtime.empty ? snapshotDomTree(runtime.empty) : null,
    });
  }

  function runtimeHasCommittedElements(
    runtime: PointerPresentationRuntime,
    committed: CommittedPointerPresentation,
  ): boolean {
    if (
      runtime.root !== committed.root ||
      runtime.empty !== committed.empty ||
      runtime.groups.length !== committed.groups.length ||
      runtime.rows.length !== committed.rows.length
    ) {
      return false;
    }
    for (const group of committed.groups) {
      const elements = runtime.groups[group.group.order];
      if (elements?.root !== group.root || elements.heading !== group.heading) return false;
    }
    for (const row of committed.rows) {
      const elements = runtime.rows[row.item.index];
      if (
        elements?.root !== row.elements.root ||
        elements.icon !== row.elements.icon ||
        elements.body !== row.elements.body ||
        elements.title !== row.elements.title ||
        elements.description !== row.elements.description ||
        elements.hint !== row.elements.hint
      ) {
        return false;
      }
    }
    return true;
  }

  function runtimeSawCompleteRefDetach(
    runtime: PointerPresentationRuntime,
    committed: CommittedPointerPresentation,
  ): boolean {
    // Strict Mode replays the whole ref tree; a retained individual ref must not revive a retired presentation.
    const detached = runtime.detachedElements;
    if (!detached.has(committed.root)) return false;
    for (const group of committed.groups) {
      if (!detached.has(group.root) || !detached.has(group.heading)) return false;
    }
    for (const row of committed.rows) {
      const elements = row.elements;
      if (
        !detached.has(elements.root) ||
        !detached.has(elements.icon) ||
        !detached.has(elements.body) ||
        !detached.has(elements.title) ||
        (elements.description && !detached.has(elements.description)) ||
        (elements.hint && !detached.has(elements.hint))
      ) {
        return false;
      }
    }
    return !committed.empty || detached.has(committed.empty);
  }

  function runtimeForEstablishment(candidate: PointerPresentation): PointerPresentationRuntime | null {
    const runtime = runtimeFor(candidate);
    if (!runtime.retired) return runtime;

    const replay =
      runtime.effectReplay ??
      (runtime.detachedCommit && runtimeSawCompleteRefDetach(runtime, runtime.detachedCommit)
        ? runtime.detachedCommit
        : null);
    if (!replay || replay.source !== candidate) return null;
    if (!runtimeHasCommittedElements(runtime, replay)) return null;
    if (activePointerRef.current || !pointerDomIsCurrent(replay)) {
      runtime.effectReplay = null;
      runtime.detachedCommit = null;
      return null;
    }
    if (!pointerFactsAreCurrent(candidate)) {
      if (!authorityRef.current) return null;
      runtime.effectReplay = null;
      runtime.detachedCommit = null;
      return null;
    }

    runtime.effectReplay = null;
    runtime.detachedCommit = null;
    // The retired runtime remains permanent; an exact replay receives a new one.
    const replacement = createPointerRuntime(candidate, runtime);
    replacement.domHistory = runtime.domHistory;
    runtime.domHistory = null;
    pointerRuntimesRef.current.set(candidate, replacement);
    return replacement;
  }

  function establishPointer(candidate: PointerPresentation): PointerPresentationRuntime | null {
    const runtime = runtimeForEstablishment(candidate);
    if (!runtime) return null;
    const previous = activePointerRef.current;
    if (previous && previous.source !== candidate) retirePointer(previous.source);
    const committed = buildCommittedPointer(candidate);
    const factsCurrent = pointerFactsAreCurrent(candidate);
    const domCurrent = committed ? pointerDomIsCurrent(committed) : false;
    if (!committed || !factsCurrent || !domCurrent) {
      retirePointer(candidate, runtime);
      return null;
    }
    runtime.domHistory ??= createPointerDomHistory(committed.root);
    if (!runtime.domHistory?.isClean()) {
      retirePointer(candidate, runtime);
      return null;
    }
    runtime.committed = committed;
    activePointerRef.current = committed;
    return runtime;
  }

  function currentPointer(candidate: PointerPresentation): CommittedPointerPresentation | null {
    const runtime = pointerRuntimesRef.current.get(candidate);
    const committed = activePointerRef.current;
    if (
      !runtime ||
      runtime.retired ||
      !committed ||
      committed.source !== candidate ||
      runtime.committed !== committed
    ) {
      return null;
    }
    if (
      !runtime.domHistory?.isClean() ||
      !pointerFactsAreCurrent(candidate) ||
      !pointerDomIsCurrent(committed)
    ) {
      retirePointer(candidate);
      return null;
    }
    return committed;
  }

  function claimPointerEvent<T extends HTMLElement>(
    candidate: PointerPresentation,
    event: ReactMouseEvent<T>,
    expected: T,
    syntheticType: "mouseenter" | "click" | "mousedown",
    nativeType: "mouseover" | "click" | "mousedown",
    targetTree: (committed: CommittedPointerPresentation) => DomTree | null,
  ): CommittedPointerPresentation | null {
    const active = activePointerRef.current;
    const runtime = pointerRuntimesRef.current.get(candidate);
    if (
      !active ||
      active.source !== candidate ||
      !runtime ||
      runtime.retired ||
      runtime.committed !== active ||
      event.type !== syntheticType ||
      event.currentTarget !== expected
    ) {
      return null;
    }
    const ownerWindow = expected.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      nativeEvent.type !== nativeType ||
      claimedNativeEventsRef.current.has(nativeEvent) ||
      !(target instanceof ownerWindow.Node) ||
      target !== nativeEvent.target ||
      !target.isConnected ||
      target.ownerDocument !== expected.ownerDocument ||
      !expected.contains(target)
    ) {
      return null;
    }
    const tree = targetTree(active);
    if (!tree || !domTreeContains(tree, target)) return null;
    const committed = currentPointer(candidate);
    if (!committed || committed !== active) return null;
    claimedNativeEventsRef.current.add(nativeEvent);
    return committed;
  }

  function applyPointerItem(candidate: PointerPresentation, item: PointerItem): void {
    const owner = candidate.authority;
    const callbacks = candidate.callbacks;
    if (item.command) {
      applySlashCommand(owner.view, item.command(candidate.argument), candidate.sessionUndoManager);
      owner.view.focus();
      return;
    }
    const context = Object.freeze({
      view: owner.view,
      where: candidate.where,
      openImage: callbacks.onImage,
      openLink: callbacks.onLink,
      startComment: () => {
        selectCurrentBlock(owner.view);
        callbacks.onComment();
      },
      keepAgent: callbacks.onKeepAgent,
    });
    const run = item.run;
    if (!run) return;
    applySlashItem(owner.view, () => run(context, candidate.argument), candidate.sessionUndoManager);
  }

  useLayoutEffect(() => {
    const candidate = pointerPresentation;
    const subscription = candidate?.snapshot.subscription;
    if (
      !candidate ||
      !subscription ||
      !subscription.active ||
      !authority ||
      authorityRef.current !== authority ||
      subscriptionOwnerRef.current !== subscription
    ) {
      return;
    }
    const previous = keyOwnerRef.current;
    if (previous) previous.retire();

    let active = true;
    const keyPublicationIsCurrent = (
      publication: SlashKeyPublication,
      owner: KeyOwner,
    ): boolean => {
      const committed = currentPointer(candidate);
      return Boolean(
        owner.authority === candidate.authority &&
        owner.subscription === subscription &&
        owner.subscription.active &&
        keyOwnerRef.current === owner &&
        subscriptionOwnerRef.current === subscription &&
        authorityRef.current === candidate.authority &&
        candidate.authority.controller === controller &&
        candidate.authority.view === view &&
        candidate.authority.session === session &&
        publication.view === candidate.authority.view &&
        publication.editorState === candidate.editorState &&
        publication.pluginState.from === candidate.state.from &&
        publication.pluginState.to === candidate.state.to &&
        publication.pluginState.query === candidate.state.query &&
        publication.state === candidate.state.source &&
        publication.ownerDocument === candidate.position.ownerDocument &&
        publication.ownerWindow === candidate.position.ownerWindow &&
        publication.nativeView === publication.path.at(-1) &&
        publication.nativeView.document === candidate.position.ownerDocument &&
        publication.nativeView.KeyboardEvent ===
          candidate.position.ownerWindow.KeyboardEvent &&
        publication.editorDom === candidate.authority.view.dom &&
        publication.activeElement === publication.editorDom &&
        publication.target === publication.editorDom &&
        publication.currentTarget === publication.editorDom &&
        publication.eventPhase === publication.ownerWindow.Event.AT_TARGET &&
        publication.bubbles &&
        publication.cancelable &&
        !publication.defaultPrevented &&
        !publication.cancelBubble &&
        !publication.altKey &&
        !publication.ctrlKey &&
        !publication.metaKey &&
        !publication.shiftKey &&
        !publication.repeat &&
        !publication.isComposing &&
        candidate.authority.controller.getState ===
          candidate.controllerGetState &&
        candidate.authority.controller.getState() === candidate.state.source &&
        candidate.highlightedIndex === index &&
        (candidate.items.length === 0
          ? candidate.highlightedIndex === 0
          : candidate.highlightedIndex >= 0 &&
            candidate.highlightedIndex < candidate.items.length) &&
        committed?.source === candidate
      );
    };
    const handler = (publication: SlashKeyPublication) => {
      if (
        !active ||
        keyOwnerRef.current !== owner ||
        pendingKeyActionRef.current ||
        !isSlashKeyPublication(publication) ||
        claimedKeyPublicationsRef.current.has(publication) ||
        claimedNativeEventsRef.current.has(publication.event) ||
        !keyPublicationIsCurrent(publication, owner)
      ) {
        return false;
      }

      const key = publication.key;
      let destination = candidate.highlightedIndex;
      if (key === "ArrowDown" && candidate.items.length) {
        destination = (candidate.highlightedIndex + 1) % candidate.items.length;
      } else if (key === "ArrowUp" && candidate.items.length) {
        destination =
          (candidate.highlightedIndex - 1 + candidate.items.length) %
          candidate.items.length;
      } else if (key === "Home") {
        destination = 0;
      } else if (key === "End") {
        destination = Math.max(0, candidate.items.length - 1);
      }
      const selected = candidate.items[candidate.highlightedIndex];
      const action: SlashKeyAction = Object.freeze({
        identity: Symbol("slash-key-action"),
        publication,
        key,
        isCurrent: () =>
          active &&
          pendingKeyActionRef.current === action &&
          claimedKeyPublicationsRef.current.has(publication) &&
          claimedKeyActionsRef.current.has(action) &&
          claimedNativeEventsRef.current.has(publication.event) &&
          keyPublicationIsCurrent(publication, owner),
        commit: () => {
          if (!action.isCurrent()) {
            action.cancel();
            return;
          }
          pendingKeyActionRef.current = null;
          if (
            key === "ArrowDown" ||
            key === "ArrowUp" ||
            key === "Home" ||
            key === "End"
          ) {
            if (destination === candidate.highlightedIndex) return;
            setHighlight({
              authority: candidate.authority,
              query,
              index: destination,
            });
            return;
          }
          if (key === "Escape") {
            closeSlashMenu(candidate.authority.view);
            return;
          }
          if (selected) applyPointerItem(candidate, selected);
          else closeSlashMenu(candidate.authority.view);
        },
        cancel: () => {
          if (pendingKeyActionRef.current === action) {
            pendingKeyActionRef.current = null;
          }
        },
      });
      if (!publication.claim(action)) return false;
      claimedKeyPublicationsRef.current.add(publication);
      claimedKeyActionsRef.current.add(action);
      claimedNativeEventsRef.current.add(publication.event);
      pendingKeyActionRef.current = action;
      return true;
    };
    const clear = controller.setKeyHandler(handler);
    const owner: KeyOwner = {
      authority,
      identity: Symbol("slash-key-owner"),
      subscription,
      retire: () => {
        if (!active) return;
        active = false;
        const pending = pendingKeyActionRef.current;
        if (pending?.publication.state === candidate.state.source) pending.cancel();
        if (keyOwnerRef.current === owner) keyOwnerRef.current = null;
        clear();
      },
    };
    keyOwnerRef.current = owner;
    return owner.retire;
  });

  useLayoutEffect(() => {
    if (!pointerPresentation) return;
    const runtime = establishPointer(pointerPresentation);
    if (!runtime) return;
    return () => retirePointer(pointerPresentation, runtime, "effect");
  });

  // Resolve the selected row from this exact committed presentation, never from a successor's DOM.
  useEffect(() => {
    if (!pointerPresentation || activePointerRef.current?.source !== pointerPresentation) return;
    const committed = currentPointer(pointerPresentation);
    const selected = committed?.rows[pointerPresentation.highlightedIndex];
    selected?.elements.root.scrollIntoView({ block: "nearest" });
  });

  if (!pointerPresentation) return null;

  return (
    <div
      ref={(element) => bindPointerRoot(pointerPresentation, element)}
      className="touch-target scrollbar-thin absolute z-40 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-xl animate-fade-in"
      style={{
        left: pointerPresentation.position.left,
        top: pointerPresentation.position.top,
        width: pointerPresentation.position.width,
        maxHeight: Math.min(MENU_MAX_HEIGHT, pointerPresentation.position.maxHeight),
      }}
      role="listbox"
      aria-label="Insert block"
      data-testid="slash-menu"
      onMouseDown={(event) => {
        const root = pointerRuntimesRef.current.get(pointerPresentation)?.root;
        if (!root) return;
        const committed = claimPointerEvent(
          pointerPresentation,
          event,
          root,
          "mousedown",
          "mousedown",
          (current) =>
            current.rows.find((row) => domTreeContains(row.tree, event.target as Node))?.tree ??
            (current.emptyTree && domTreeContains(current.emptyTree, event.target as Node) ? current.emptyTree : null),
        );
        if (committed) event.preventDefault();
      }}
    >
      {pointerPresentation.items.length === 0 && (
        <div
          ref={(element) => bindPointerEmpty(pointerPresentation, element)}
          className="px-3 text-sm text-ink-3"
          style={{ lineHeight: `${ROW_HEIGHT}px` }}
          data-testid="slash-empty"
          role="option"
          aria-selected
        >
          No matches
        </div>
      )}
      {pointerPresentation.groups.map((group) => (
        <div
          ref={(element) => bindPointerGroup(pointerPresentation, group, "root", element)}
          key={group.group}
        >
          <div
            ref={(element) => bindPointerGroup(pointerPresentation, group, "heading", element)}
            className="px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3"
          >
            {group.group}
          </div>
          {group.items.map((item) => {
            const Icon = ICONS[item.icon] ?? Type;
            const active = item.index === pointerPresentation.highlightedIndex;
            return (
              <button
                ref={(element) => bindPointerRow(pointerPresentation, item, "root", element)}
                key={item.id}
                type="button"
                role="option"
                aria-selected={active}
                data-index={item.index}
                data-testid={`slash-item-${item.id}`}
                className={cn("flex w-full items-center gap-3 px-3 text-left text-sm text-ink-2", active && "bg-accent-soft text-ink")}
                style={{ height: item.height }}
                onMouseEnter={(event) => {
                  const pointerRuntime = pointerRuntimesRef.current.get(pointerPresentation);
                  if (!pointerRuntime) return;
                  if (
                    item.index !== pointerPresentation.highlightedIndex &&
                    pointerRuntime.highlightClaimed
                  ) {
                    return;
                  }
                  const row = pointerRuntime.rows[item.index]?.root;
                  if (!row) return;
                  const committed = claimPointerEvent(
                    pointerPresentation,
                    event,
                    row,
                    "mouseenter",
                    "mouseover",
                    (current) => current.rows[item.index]?.tree ?? null,
                  );
                  if (!committed || committed.rows[item.index]?.item !== item) return;
                  if (item.index === pointerPresentation.highlightedIndex) return;
                  pointerRuntime.highlightClaimed = true;
                  setHighlight((current) => {
                    if (
                      activePointerRef.current?.source !== pointerPresentation ||
                      authorityRef.current !== pointerPresentation.authority ||
                      pointerPresentation.authority.controller.getState() !== pointerPresentation.state.source
                    ) {
                      return current;
                    }
                    return {
                      authority: pointerPresentation.authority,
                      query,
                      index: item.index,
                    };
                  });
                }}
                onClick={(event) => {
                  const pointerRuntime = pointerRuntimesRef.current.get(pointerPresentation);
                  if (!pointerRuntime) return;
                  if (pointerRuntime.itemClaimed) return;
                  const row = pointerRuntime.rows[item.index]?.root;
                  if (!row) return;
                  const committed = claimPointerEvent(
                    pointerPresentation,
                    event,
                    row,
                    "click",
                    "click",
                    (current) => current.rows[item.index]?.tree ?? null,
                  );
                  if (!committed || committed.rows[item.index]?.item !== item) return;
                  pointerRuntime.itemClaimed = true;
                  applyPointerItem(pointerPresentation, item);
                }}
              >
                <Icon
                  ref={(element) => bindPointerRow(pointerPresentation, item, "icon", element)}
                  size={16}
                  className="shrink-0 text-ink-3"
                />
                <span
                  ref={(element) => bindPointerRow(pointerPresentation, item, "body", element)}
                  className="flex min-w-0 flex-1 flex-col"
                >
                  <span
                    ref={(element) => bindPointerRow(pointerPresentation, item, "title", element)}
                    className="truncate"
                  >
                    {item.title}
                  </span>
                  {item.description && (
                    <span
                      ref={(element) => bindPointerRow(pointerPresentation, item, "description", element)}
                      className="truncate text-xs text-ink-3"
                    >
                      {item.description}
                    </span>
                  )}
                </span>
                {item.hint && (
                  <span
                    ref={(element) => bindPointerRow(pointerPresentation, item, "hint", element)}
                    className="text-xs text-ink-3"
                  >
                    {item.hint}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
