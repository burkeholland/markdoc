"use client";

import { memo, useCallback, useLayoutEffect, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import {
  Bold,
  Italic,
  Link as LinkIcon,
  Code,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Image as ImageIcon,
  Table,
  Minus,
  Undo2,
  Redo2,
  ChevronDown,
  Heading,
  Strikethrough,
  SquareCode,
  MessageSquarePlus,
} from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { EditorActions, FormatState } from "./actions";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger, Tip } from "@/components/ui/primitives";
import { cn, shortcut } from "@/lib/utils";
import { rovingIndex } from "@/lib/a11y";
import { shallowEqual, useSessionValue } from "./use-session";
import { TOOLBAR_BOX } from "./chrome-classes";

type ToolbarPermission = "edit" | "undo" | "redo" | "comment" | "current";
type HeadingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

type ToolbarControl<T extends HTMLElement = HTMLButtonElement> = Readonly<{
  id: string;
  enabled: boolean;
  rootButton: boolean;
  element: () => T | null;
  capture: (element: T | null) => void;
  onClick: (event: MouseEvent<T>) => void;
  onMouseDown: (event: MouseEvent<T>) => void;
}>;

type OwnedToolbarControl = Readonly<{
  id: string;
  enabled: boolean;
  rootButton: boolean;
  element: () => HTMLElement | null;
}>;

type ToolbarAction = Readonly<{
  token: symbol;
  control: OwnedToolbarControl;
  permission: ToolbarPermission;
  requireEnabled: boolean;
  run: () => void;
}>;

type ToolbarButtons = Readonly<{
  heading: ToolbarControl;
  bold: ToolbarControl;
  italic: ToolbarControl;
  strike: ToolbarControl;
  link: ToolbarControl;
  code: ToolbarControl;
  codeBlock: ToolbarControl;
  bullet: ToolbarControl;
  ordered: ToolbarControl;
  task: ToolbarControl;
  quote: ToolbarControl;
  image: ToolbarControl;
  table: ToolbarControl;
  rule: ToolbarControl;
  undo: ToolbarControl;
  redo: ToolbarControl;
  comment: ToolbarControl;
}>;

type ToolbarPublication = Readonly<{
  captureRoot: (element: HTMLDivElement | null) => void;
  captureHeadingContent: (element: HTMLDivElement | null) => void;
  buttons: ToolbarButtons;
  headingItems: ReadonlyArray<Readonly<{
    level: HeadingLevel;
    control: ToolbarControl<HTMLDivElement>;
    onSelect: (event: Event) => void;
  }>>;
  establish: () => void | (() => void);
  retire: () => boolean;
  isRetired: () => boolean;
  onFocus: (event: FocusEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onHeadingClose: (event: Event) => void;
}>;

class CurrentCell<T> {
  constructor(public current: T) {}
}

class PublicationIdentity {
  current?: ToolbarPublication;
}

interface ElementOwnerView {
  readonly element: () => HTMLElement | null;
}

class ElementOwner<T extends HTMLElement> {
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: ElementOwnerView,
      element: HTMLElement | null,
      previous: HTMLElement | null,
      last: HTMLElement | null,
    ) => void,
  ) {}

  readonly element = () => this.current;
  readonly capture = (element: T | null) => {
    if (this.current === element) return;
    const previous = this.current;
    const last = this.last;
    this.current = element;
    if (element) this.last = element;
    this.onChange(this, element, previous, last);
  };
}

interface ToolbarDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly ToolbarDomSnapshot[];
}

interface ToolbarPlacement {
  readonly document: Document;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface ToolbarReplay {
  readonly source: ToolbarPublication;
  readonly dom: ToolbarDomSnapshot;
  readonly placement: ToolbarPlacement;
  readonly unchanged: () => boolean;
  readonly release: () => void;
}

interface RefReplay {
  readonly owner: ElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

const TRANSIENT_BUTTON_ATTRIBUTES = new Set([
  "aria-controls",
  "aria-describedby",
  "aria-expanded",
  "data-state",
]);

function isTransientToolbarAttribute(node: Node, name: string | null): boolean {
  return Boolean(
    name &&
      node.nodeType === 1 &&
      (node as Element).tagName === "BUTTON" &&
      TRANSIENT_BUTTON_ATTRIBUTES.has(name),
  );
}

function snapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .filter(({ name }) => !isTransientToolbarAttribute(node, name))
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotToolbarDom(node: Node): ToolbarDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotToolbarDom)),
  });
}

function toolbarDomMatches(snapshot: ToolbarDomSnapshot): boolean {
  if (snapshot.node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = snapshotAttributes(snapshot.node);
  if (attributes === null || snapshot.attributes === null) {
    if (attributes !== snapshot.attributes) return false;
  } else if (
    attributes.length !== snapshot.attributes.length ||
    attributes.some(([name, value], index) => {
      const expected = snapshot.attributes?.[index];
      return !expected || expected[0] !== name || expected[1] !== value;
    })
  ) {
    return false;
  }
  return (
    snapshot.node.childNodes.length === snapshot.children.length &&
    snapshot.children.every(
      (child, index) =>
        snapshot.node.childNodes.item(index) === child.node && toolbarDomMatches(child),
    )
  );
}

function captureToolbarPlacement(root: HTMLDivElement): ToolbarPlacement | null {
  const parent = root.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: root.ownerDocument,
    parent,
    previousSibling: root.previousSibling,
    nextSibling: root.nextSibling,
  });
}

function toolbarPlacementMatches(root: HTMLDivElement, placement: ToolbarPlacement): boolean {
  return (
    root.ownerDocument === placement.document &&
    root.parentNode === placement.parent &&
    root.previousSibling === placement.previousSibling &&
    root.nextSibling === placement.nextSibling
  );
}

function descendantsOf(element: HTMLElement): readonly Node[] {
  const nodes: Node[] = [];
  const collect = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes) collect(child);
  };
  collect(element);
  return Object.freeze(nodes);
}

function isNodeFromDocument(value: EventTarget | null, ownerDocument: Document): value is Node {
  const NodeConstructor = ownerDocument.defaultView?.Node;
  return Boolean(
    NodeConstructor &&
      value instanceof NodeConstructor &&
      value.ownerDocument === ownerDocument,
  );
}

function isEffectivelyEnabled(element: HTMLElement): boolean {
  if (
    element.matches(":disabled") ||
    element.getAttribute("aria-disabled")?.toLowerCase() === "true"
  ) {
    return false;
  }
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (
      current.hasAttribute("inert") ||
      current.getAttribute("aria-disabled")?.toLowerCase() === "true"
    ) {
      return false;
    }
  }
  return true;
}

function createToolbarPublication({
  mount,
  active,
  successorOf,
  replay,
  last,
  claimedEvents,
  requestSuccessor,
  session,
  actions,
  format,
  canEdit,
  canUndo,
  canRedo,
  canComment,
  onComment,
  onImage,
  onTable,
}: {
  mount: object;
  active: CurrentCell<ToolbarPublication | null>;
  successorOf: CurrentCell<ToolbarPublication | null>;
  replay: CurrentCell<ToolbarReplay | null>;
  last: CurrentCell<HTMLButtonElement | null>;
  claimedEvents: WeakSet<Event>;
  requestSuccessor: () => void;
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  canEdit: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canComment: boolean;
  onComment: () => void;
  onImage: () => void;
  onTable: () => void;
}): ToolbarPublication {
  const authority = Object.freeze({
    mount,
    session,
    actions,
    format,
    formatValues: Object.freeze({
      strong: format.strong,
      em: format.em,
      code: format.code,
      strike: format.strike,
      link: format.link,
      heading: format.heading,
      bullet: format.bullet,
      ordered: format.ordered,
      task: format.task,
      quote: format.quote,
      codeBlock: format.codeBlock,
      hasSelection: format.hasSelection,
      tablePos: format.tablePos,
      tableAlign: format.tableAlign,
    }),
    methods: Object.freeze({
      toggleMark: actions.toggleMark,
      openLinkDialog: actions.openLinkDialog,
      toggleCodeBlock: actions.toggleCodeBlock,
      toggleList: actions.toggleList,
      toggleQuote: actions.toggleQuote,
      horizontalRule: actions.horizontalRule,
      undo: actions.undo,
      redo: actions.redo,
      setHeading: actions.setHeading,
      focus: actions.focus,
    }),
    canEdit,
    canUndo,
    canRedo,
    canComment,
    onComment,
    onImage,
    onTable,
  });
  let retired = false;
  let established = false;
  let layoutRetired = false;
  let consumed = false;
  let successorRequested = false;
  let invalidReplay = false;
  let replayRefs: RefReplay[] = [];
  let stableOwners = new Set<ElementOwnerView>();
  let domSnapshot: ToolbarDomSnapshot | null = null;
  let placementSnapshot: ToolbarPlacement | null = null;
  let domChanged = false;
  let domObserver: MutationObserver | null = null;
  let guardExpiryQueued = false;
  const claimed = new Set<symbol>();
  const identity = new PublicationIdentity();
  const owners: ElementOwnerView[] = [];

  const onElementChange = (
    owner: ElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    prior: HTMLElement | null,
  ) => {
    if (!established) return;
    const proof = replayRefs.find((entry) => entry.owner === owner);
    if (!proof) {
      invalidReplay = true;
      return;
    }
    if (
      element === null &&
      previous === proof.element &&
      proof.element.isConnected
    ) {
      proof.detached = true;
      proof.reattached = false;
    } else if (
      element === proof.element &&
      previous === null &&
      proof.detached &&
      proof.element.isConnected
    ) {
      proof.reattached = true;
    } else if (element !== previous) {
      invalidReplay = true;
    }
    if (
      stableOwners.has(owner) &&
      (element === null || (element !== null && prior !== null && element !== prior))
    ) {
      retire("element");
    }
    if (exactReplayReady()) requestReplaySuccessor();
  };
  const createOwner = <T extends HTMLElement>() => {
    const owner = new ElementOwner<T>(onElementChange);
    owners.push(owner);
    return owner;
  };
  const root = createOwner<HTMLDivElement>();
  const headingContent = createOwner<HTMLDivElement>();
  let lastHeadingContent: HTMLDivElement | null = null;
  const captureHeadingContent = (element: HTMLDivElement | null) => {
    if (element) lastHeadingContent = element;
    headingContent.capture(element);
  };

  const authorityOwned = () => {
    const values = authority.formatValues;
    const current = authority.format;
    return (
      authority.session.canEdit === authority.canEdit &&
      authority.session.canUndo === authority.canUndo &&
      authority.session.canRedo === authority.canRedo &&
      authority.session.canComment === authority.canComment &&
      authority.methods.toggleMark === authority.actions.toggleMark &&
      authority.methods.openLinkDialog === authority.actions.openLinkDialog &&
      authority.methods.toggleCodeBlock === authority.actions.toggleCodeBlock &&
      authority.methods.toggleList === authority.actions.toggleList &&
      authority.methods.toggleQuote === authority.actions.toggleQuote &&
      authority.methods.horizontalRule === authority.actions.horizontalRule &&
      authority.methods.undo === authority.actions.undo &&
      authority.methods.redo === authority.actions.redo &&
      authority.methods.setHeading === authority.actions.setHeading &&
      authority.methods.focus === authority.actions.focus &&
      current.strong === values.strong &&
      current.em === values.em &&
      current.code === values.code &&
      current.strike === values.strike &&
      current.link === values.link &&
      current.heading === values.heading &&
      current.bullet === values.bullet &&
      current.ordered === values.ordered &&
      current.task === values.task &&
      current.quote === values.quote &&
      current.codeBlock === values.codeBlock &&
      current.hasSelection === values.hasSelection &&
      current.tablePos === values.tablePos &&
      current.tableAlign === values.tableAlign
    );
  };
  const permissionOwned = (permission: ToolbarPermission) => {
    switch (permission) {
      case "edit":
        return authority.canEdit && authority.session.canEdit;
      case "undo":
        return authority.canEdit && authority.canUndo && authority.session.canEdit && authority.session.canUndo;
      case "redo":
        return authority.canEdit && authority.canRedo && authority.session.canEdit && authority.session.canRedo;
      case "comment":
        return authority.canComment && authority.session.canComment;
      case "current":
        return true;
    }
  };
  const ownsControl = (control: OwnedToolbarControl, requireEnabled = true) => {
    if (
      retired ||
      active.current !== identity.current ||
      !authorityOwned() ||
      !publishedDomMatches()
    ) {
      return false;
    }
    const ownedRoot = root.element();
    const element = control.element();
    if (!ownedRoot || !element) return false;
    if (!ownedRoot.isConnected || !element.isConnected) return false;
    if (control.rootButton && !ownedRoot.contains(element)) return false;
    if (!control.rootButton) {
      const content = headingContent.element();
      const itemIndex = headingItems.findIndex(({ control: item }) => item === control);
      const ordered = content
        ? [...content.querySelectorAll<HTMLElement>("[data-toolbar-heading]")]
        : [];
      if (
        !content ||
        !content.isConnected ||
        content.ownerDocument !== ownedRoot.ownerDocument ||
        content.dataset.toolbarHeadingContent !== "" ||
        itemIndex < 0 ||
        ordered.length !== headingItems.length ||
        ordered[itemIndex] !== element ||
        !content.contains(element) ||
        element.getAttribute("role") !== "menuitemradio" ||
        element.dataset.toolbarHeading !== String(headingItems[itemIndex]?.level)
      ) {
        return false;
      }
    }
    if (
      requireEnabled &&
      (!control.enabled || !isEffectivelyEnabled(element))
    ) return false;
    return true;
  };
  const claimEvent = (event: Event) => {
    if (claimedEvents.has(event)) return false;
    claimedEvents.add(event);
    consumed = true;
    return true;
  };
  const claim = (action: ToolbarAction, event: Event) => {
    if (
      !ownsControl(action.control, action.requireEnabled) ||
      !permissionOwned(action.permission) ||
      claimed.has(action.token) ||
      claimedEvents.has(event)
    ) {
      return false;
    }
    claimed.add(action.token);
    claimedEvents.add(event);
    consumed = true;
    return true;
  };
  const activate = (action: ToolbarAction, event: Event) => {
    if (!claim(action, event)) return;
    action.run();
  };
  const preventMouseDown = <T extends HTMLElement>(
    control: OwnedToolbarControl,
    event: MouseEvent<T>,
  ) => {
    const nativeEvent = exactMouseEvent(control, event, "mousedown");
    if (!nativeEvent || !ownsControl(control) || !claimEvent(nativeEvent)) return;
    event.preventDefault();
  };

  const makeControl = <T extends HTMLElement = HTMLButtonElement>({
    id,
    enabled,
    rootButton = true,
    permission = "current",
    requireEnabled = true,
    run,
  }: {
    id: string;
    enabled: boolean;
    rootButton?: boolean;
    permission?: ToolbarPermission;
    requireEnabled?: boolean;
    run?: () => void;
  }): ToolbarControl<T> => {
    const owner = createOwner<T>();
    let action: ToolbarAction | null = null;
    const control: ToolbarControl<T> = Object.freeze({
      id,
      enabled,
      rootButton,
      element: owner.element,
      capture: owner.capture,
      onClick: (event) => {
        if (!action) return;
        const nativeEvent = exactMouseEvent(control, event, "click");
        if (nativeEvent) activate(action, nativeEvent);
      },
      onMouseDown: (event) => preventMouseDown(control, event),
    });
    if (run) {
      action = Object.freeze({
        token: Symbol(id),
        control,
        permission,
        requireEnabled,
        run,
      });
    }
    return control;
  };

  const {
    toggleMark,
    openLinkDialog,
    toggleCodeBlock,
    toggleList,
    toggleQuote,
    horizontalRule,
    undo,
    redo,
    setHeading,
    focus,
  } = authority.methods;
  const buttons: ToolbarButtons = Object.freeze({
    heading: makeControl({ id: "heading", enabled: canEdit }),
    bold: makeControl({ id: "bold", enabled: canEdit, permission: "edit", run: () => toggleMark.call(actions, "strong") }),
    italic: makeControl({ id: "italic", enabled: canEdit, permission: "edit", run: () => toggleMark.call(actions, "em") }),
    strike: makeControl({ id: "strike", enabled: canEdit, permission: "edit", run: () => toggleMark.call(actions, "strike") }),
    link: makeControl({ id: "link", enabled: canEdit, permission: "edit", run: () => openLinkDialog.call(actions) }),
    code: makeControl({ id: "code", enabled: canEdit, permission: "edit", run: () => toggleMark.call(actions, "code") }),
    codeBlock: makeControl({ id: "code-block", enabled: canEdit, permission: "edit", run: () => toggleCodeBlock.call(actions) }),
    bullet: makeControl({ id: "bullet", enabled: canEdit, permission: "edit", run: () => toggleList.call(actions, "bullet") }),
    ordered: makeControl({ id: "ordered", enabled: canEdit, permission: "edit", run: () => toggleList.call(actions, "ordered") }),
    task: makeControl({ id: "task", enabled: canEdit, permission: "edit", run: () => toggleList.call(actions, "task") }),
    quote: makeControl({ id: "quote", enabled: canEdit, permission: "edit", run: () => toggleQuote.call(actions) }),
    image: makeControl({ id: "image", enabled: canEdit, permission: "edit", run: authority.onImage }),
    table: makeControl({ id: "table", enabled: canEdit, permission: "edit", run: authority.onTable }),
    rule: makeControl({ id: "rule", enabled: canEdit, permission: "edit", run: () => horizontalRule.call(actions) }),
    undo: makeControl({ id: "undo", enabled: canEdit && canUndo, permission: "undo", run: () => undo.call(actions) }),
    redo: makeControl({ id: "redo", enabled: canEdit && canRedo, permission: "redo", run: () => redo.call(actions) }),
    comment: makeControl({ id: "comment", enabled: canComment, permission: "comment", run: authority.onComment }),
  });
  const headingItems = Object.freeze(
    ([0, 1, 2, 3, 4, 5, 6] as const).map((level) => {
      const control = makeControl<HTMLDivElement>({
        id: `heading-${level}`,
        enabled: canEdit,
        rootButton: false,
        permission: "edit",
        run: () => setHeading.call(actions, level),
      });
      const action: ToolbarAction = Object.freeze({
        token: Symbol(`heading-${level}`),
        control,
        permission: "edit",
        requireEnabled: true,
        run: () => setHeading.call(actions, level),
      });
      return Object.freeze({
        level,
        control,
        onSelect: (event: Event) => {
          if (exactCustomEvent(event, control.element(), "menu.itemSelect")) {
            activate(action, event);
          }
        },
      });
    }),
  );
  const buttonOrder = Object.freeze([
    buttons.heading,
    buttons.bold,
    buttons.italic,
    buttons.strike,
    buttons.link,
    buttons.code,
    buttons.codeBlock,
    buttons.bullet,
    buttons.ordered,
    buttons.task,
    buttons.quote,
    buttons.image,
    buttons.table,
    buttons.rule,
    buttons.undo,
    buttons.redo,
    ...(canComment ? [buttons.comment] : []),
  ]);
  const closeAction: ToolbarAction = Object.freeze({
    token: Symbol("heading-close"),
    control: buttons.heading,
    permission: "current",
    requireEnabled: false,
    run: () => focus.call(actions),
  });

  const ownedButtons = () => {
    const ownedRoot = root.element();
    if (
      retired ||
      active.current !== identity.current ||
      !authorityOwned() ||
      !ownedRoot ||
      !ownedRoot.isConnected ||
      (established && !publishedDomMatches())
    ) {
      return null;
    }
    const owned: Array<{ control: ToolbarControl; element: HTMLButtonElement }> = [];
    for (const control of buttonOrder) {
      const element = control.element();
      if (!element || !element.isConnected || !ownedRoot.contains(element)) return null;
      owned.push({ control, element });
    }
    const domButtons = [...ownedRoot.querySelectorAll<HTMLButtonElement>("button")];
    if (
      domButtons.length !== owned.length ||
      owned.some(({ element }, index) => domButtons[index] !== element)
    ) {
      return null;
    }
    return owned;
  };
  const enabledButtons = () => {
    const owned = ownedButtons();
    return owned?.filter(({ control, element }) => control.enabled && !element.disabled) ?? [];
  };
  const mutationIsRelevant = (record: MutationRecord, allowTabStops = false) => {
    const ownedRoot = root.element();
    if (!ownedRoot) return true;
    if (
      record.type === "attributes" &&
      (isTransientToolbarAttribute(record.target, record.attributeName) ||
        (allowTabStops &&
          record.attributeName === "tabindex" &&
          buttonOrder.some((control) => control.element() === record.target)))
    ) {
      return false;
    }
    if (record.target === ownedRoot || ownedRoot.contains(record.target)) return true;
    if (
      record.type === "attributes" &&
      (record.attributeName === "disabled" ||
        record.attributeName === "inert" ||
        record.attributeName === "aria-disabled")
    ) {
      return record.target.contains(ownedRoot);
    }
    return record.type === "childList" && record.target === placementSnapshot?.parent;
  };
  const recordMutations = (records: readonly MutationRecord[], allowTabStops = false) => {
    if (!domChanged && records.some((record) => mutationIsRelevant(record, allowTabStops))) {
      domChanged = true;
    }
    return domChanged;
  };
  const releaseReplayGuard = () => {
    if (!domObserver) return;
    recordMutations(domObserver.takeRecords());
    domObserver.disconnect();
    domObserver = null;
  };
  const publishedDomMatches = () => {
    if (domObserver) recordMutations(domObserver.takeRecords());
    const ownedRoot = root.element();
    return Boolean(
      !domChanged &&
        domSnapshot &&
        placementSnapshot &&
        ownedRoot &&
        ownedRoot === domSnapshot.node &&
        ownedRoot.isConnected &&
        toolbarPlacementMatches(ownedRoot, placementSnapshot) &&
        toolbarDomMatches(domSnapshot),
    );
  };
  const replayDomUnchanged = () => {
    if (!domObserver) return false;
    recordMutations(domObserver.takeRecords());
    return Boolean(
      !domChanged &&
        domSnapshot &&
        placementSnapshot &&
        domSnapshot.node.isConnected &&
        toolbarPlacementMatches(domSnapshot.node as HTMLDivElement, placementSnapshot) &&
        toolbarDomMatches(domSnapshot),
    );
  };
  const syncTabStops = (commit = false) => {
    if (active.current !== identity.current || retired) return false;
    if (commit && !publishedDomMatches()) return false;
    const owned = ownedButtons();
    if (!owned) return false;
    const enabled = owned.filter(({ control, element }) => control.enabled && !element.disabled);
    const lastButton = last.current;
    const stop = enabled.find(({ element }) => element === lastButton)?.element ?? enabled[0]?.element;
    for (const { element } of owned) {
      element.tabIndex = element === stop ? 0 : -1;
    }
    if (commit && domObserver) {
      if (recordMutations(domObserver.takeRecords(), true)) {
        retire("element");
        return false;
      }
      const ownedRoot = root.element();
      if (!ownedRoot) return false;
      domSnapshot = snapshotToolbarDom(ownedRoot);
    }
    return true;
  };
  const exactReplayReady = () =>
    retired &&
    layoutRetired &&
    established &&
    !consumed &&
    !invalidReplay &&
    replayRefs.length > 0 &&
    replayRefs.every(
      (entry) =>
        entry.detached &&
        entry.reattached &&
        entry.owner.element() === entry.element,
    ) &&
    authorityOwned() &&
    replayDomUnchanged() &&
    successorOf.current === publication;
  const authorityMatches = (source: ToolbarPublication) => {
    const previous = (source as ToolbarPublication & { authority?: typeof authority }).authority;
    if (!previous) return false;
    const left = previous.formatValues;
    const right = authority.formatValues;
    return (
      previous.mount === authority.mount &&
      previous.session === authority.session &&
      previous.actions === authority.actions &&
      previous.format === authority.format &&
      previous.canEdit === authority.canEdit &&
      previous.canUndo === authority.canUndo &&
      previous.canRedo === authority.canRedo &&
      previous.canComment === authority.canComment &&
      previous.onComment === authority.onComment &&
      previous.onImage === authority.onImage &&
      previous.onTable === authority.onTable &&
      previous.methods.toggleMark === authority.methods.toggleMark &&
      previous.methods.openLinkDialog === authority.methods.openLinkDialog &&
      previous.methods.toggleCodeBlock === authority.methods.toggleCodeBlock &&
      previous.methods.toggleList === authority.methods.toggleList &&
      previous.methods.toggleQuote === authority.methods.toggleQuote &&
      previous.methods.horizontalRule === authority.methods.horizontalRule &&
      previous.methods.undo === authority.methods.undo &&
      previous.methods.redo === authority.methods.redo &&
      previous.methods.setHeading === authority.methods.setHeading &&
      previous.methods.focus === authority.methods.focus &&
      left.strong === right.strong &&
      left.em === right.em &&
      left.code === right.code &&
      left.strike === right.strike &&
      left.link === right.link &&
      left.heading === right.heading &&
      left.bullet === right.bullet &&
      left.ordered === right.ordered &&
      left.task === right.task &&
      left.quote === right.quote &&
      left.codeBlock === right.codeBlock &&
      left.hasSelection === right.hasSelection &&
      left.tablePos === right.tablePos &&
      left.tableAlign === right.tableAlign
    );
  };
  const requestReplaySuccessor = () => {
    if (
      successorRequested ||
      !domSnapshot ||
      !placementSnapshot ||
      !exactReplayReady()
    ) {
      return;
    }
    successorRequested = true;
    replay.current = Object.freeze({
      source: publication,
      dom: domSnapshot,
      placement: placementSnapshot,
      unchanged: replayDomUnchanged,
      release: releaseReplayGuard,
    });
    requestSuccessor();
  };
  const establish = () => {
    if (established) {
      if (exactReplayReady()) requestReplaySuccessor();
      return undefined;
    }
    const ownedRoot = root.element();
    if (!authorityOwned() || !ownedRoot || !ownedRoot.isConnected || buttonOrder.some((control) => {
      const element = control.element();
      return !element || !element.isConnected || !ownedRoot.contains(element);
    })) return undefined;
    const placement = captureToolbarPlacement(ownedRoot);
    if (!placement) return undefined;
    const pendingReplay = replay.current;
    if (pendingReplay) {
      const sameAuthority = authorityMatches(pendingReplay.source);
      const exactReplay =
        sameAuthority &&
        pendingReplay.source.isRetired() &&
        successorOf.current === pendingReplay.source &&
        pendingReplay.unchanged() &&
        pendingReplay.dom.node === ownedRoot &&
        toolbarPlacementMatches(ownedRoot, pendingReplay.placement) &&
        toolbarDomMatches(pendingReplay.dom);
      replay.current = null;
      pendingReplay.release();
      if (successorOf.current === pendingReplay.source) successorOf.current = null;
      if (sameAuthority && !exactReplay) return undefined;
    }
    const previous = active.current;
    if (previous && previous !== publication) previous.retire();
    active.current = publication;
    if (!syncTabStops()) {
      active.current = null;
      return undefined;
    }
    established = true;
    stableOwners = new Set(owners.filter((owner) => owner.element()));
    replayRefs = [...stableOwners].map((owner) => ({
      owner,
      element: owner.element()!,
      detached: false,
      reattached: false,
    }));
    placementSnapshot = placement;
    domSnapshot = snapshotToolbarDom(ownedRoot);
    const MutationObserverConstructor = ownedRoot.ownerDocument.defaultView?.MutationObserver;
    if (!MutationObserverConstructor) {
      retire("other");
      return undefined;
    }
    domObserver = new MutationObserverConstructor((records) => {
      if (recordMutations(records)) retire("element");
    });
    domObserver.observe(ownedRoot.ownerDocument, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    return retireForLayout;
  };
  const scheduleGuardExpiry = () => {
    if (guardExpiryQueued) return;
    guardExpiryQueued = true;
    queueMicrotask(() => {
      if (replay.current?.source === publication) return;
      if (domObserver) {
        recordMutations(domObserver.takeRecords());
        domChanged = true;
        domObserver.disconnect();
        domObserver = null;
      }
    });
  };
  const retire = (reason: "element" | "layout" | "other" = "other") => {
    if (retired) return false;
    if (domObserver) recordMutations(domObserver.takeRecords());
    retired = true;
    const wasActive = active.current === publication;
    if (wasActive) {
      active.current = null;
      successorOf.current = publication;
    }
    if (reason === "other") releaseReplayGuard();
    else scheduleGuardExpiry();
    return wasActive;
  };
  const retireForLayout = () => {
    layoutRetired = true;
    retire("layout");
    scheduleGuardExpiry();
  };
  const exactMouseEvent = <T extends HTMLElement>(
    control: OwnedToolbarControl,
    event: MouseEvent<T>,
    type: "mousedown" | "click",
  ): globalThis.MouseEvent | null => {
    const ownedRoot = root.element();
    const element = control.element();
    const ownerWindow = ownedRoot?.ownerDocument.defaultView;
    const nativeEvent = event?.nativeEvent;
    const target = event?.target;
    if (
      !ownedRoot ||
      !element ||
      !ownerWindow ||
      event.type !== type ||
      event.button !== 0 ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      nativeEvent.type !== type ||
      nativeEvent.button !== 0 ||
      nativeEvent.eventPhase === ownerWindow.Event.NONE ||
      event.currentTarget !== element ||
      nativeEvent.target !== target ||
      !isNodeFromDocument(target, ownedRoot.ownerDocument) ||
      !descendantsOf(element).includes(target) ||
      !nativeEvent.composedPath().includes(element) ||
      !nativeEvent.composedPath().includes(ownedRoot) ||
      event.defaultPrevented ||
      nativeEvent.defaultPrevented
    ) {
      return null;
    }
    return nativeEvent;
  };
  const exactCustomEvent = (
    event: Event,
    source: HTMLElement | null,
    type: "menu.itemSelect" | "focusScope.autoFocusOnUnmount",
  ) => {
    const ownedRoot = root.element();
    const ownerWindow = ownedRoot?.ownerDocument.defaultView;
    return Boolean(
      ownedRoot &&
        source &&
        ownerWindow &&
        event instanceof ownerWindow.CustomEvent &&
        event.type === type &&
        event.eventPhase !== ownerWindow.Event.NONE &&
        event.currentTarget === source &&
        event.target === source &&
        source.ownerDocument === ownedRoot.ownerDocument &&
        (type !== "focusScope.autoFocusOnUnmount" ||
          source.dataset.toolbarHeadingContent === "") &&
        event.composedPath().includes(source) &&
        !event.defaultPrevented,
    );
  };
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const ownedRoot = root.element();
    if (active.current !== identity.current || !ownedRoot || event.currentTarget !== ownedRoot) return;
    const ownerWindow = ownedRoot.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.FocusEvent) ||
      event.type !== "focus" ||
      nativeEvent.type !== "focusin" ||
      nativeEvent.eventPhase === ownerWindow.Event.NONE ||
      nativeEvent.target !== target ||
      !isNodeFromDocument(target, ownedRoot.ownerDocument) ||
      !nativeEvent.composedPath().includes(ownedRoot) ||
      event.defaultPrevented ||
      nativeEvent.defaultPrevented
    ) {
      return;
    }
    const button = target instanceof ownerWindow.Element ? target.closest("button") : null;
    const owned = buttonOrder.find((control) => control.element() === button);
    if (!owned || !ownsControl(owned) || !claimEvent(nativeEvent)) return;
    last.current = button as HTMLButtonElement;
    syncTabStops(true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const ownedRoot = root.element();
    if (
      active.current !== identity.current ||
      !ownedRoot ||
      event.currentTarget !== ownedRoot ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) return;
    const items = enabledButtons();
    const current = items.findIndex(({ element }) => element === event.target);
    const next = rovingIndex(event.key, current, items.length, { orientation: "horizontal", wrap: true });
    const ownerWindow = ownedRoot.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      next < 0 ||
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.KeyboardEvent) ||
      event.type !== "keydown" ||
      nativeEvent.type !== "keydown" ||
      nativeEvent.eventPhase === ownerWindow.Event.NONE ||
      nativeEvent.target !== target ||
      nativeEvent.key !== event.key ||
      nativeEvent.altKey !== event.altKey ||
      nativeEvent.ctrlKey !== event.ctrlKey ||
      nativeEvent.metaKey !== event.metaKey ||
      nativeEvent.shiftKey !== event.shiftKey ||
      !isNodeFromDocument(target, ownedRoot.ownerDocument) ||
      ownedRoot.ownerDocument.activeElement !== target ||
      !nativeEvent.composedPath().includes(ownedRoot) ||
      event.defaultPrevented ||
      nativeEvent.defaultPrevented ||
      !claimEvent(nativeEvent)
    ) {
      return;
    }
    event.preventDefault();
    items[next]?.element.focus();
  };
  const onHeadingClose = (event: Event) => {
    const source = headingContent.element() ?? lastHeadingContent;
    if (
      !source ||
      !exactCustomEvent(event, source, "focusScope.autoFocusOnUnmount") ||
      !claim(closeAction, event)
    ) {
      return;
    }
    event.preventDefault();
    closeAction.run();
  };

  const publication = Object.freeze({
    authority,
    captureRoot: root.capture,
    captureHeadingContent,
    buttons,
    headingItems,
    establish,
    retire,
    isRetired: () => retired,
    onFocus,
    onKeyDown,
    onHeadingClose,
  } as ToolbarPublication & { authority: typeof authority });
  identity.current = publication;
  return publication;
}

function ToolButton({
  label,
  keys,
  active,
  disabled,
  control,
  children,
  testId,
}: {
  label: string;
  keys?: string;
  active?: boolean;
  disabled?: boolean;
  control: ToolbarControl;
  children: React.ReactNode;
  testId?: string;
}) {
  const { capture, onMouseDown, onClick } = control;
  return (
    <Tip label={label} shortcut={keys ? shortcut(keys) : undefined}>
      <button
        ref={capture}
        type="button"
        className="icon-btn"
        data-active={active ? "true" : undefined}
        disabled={disabled}
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

function Divider() {
  return <span className="tb-divider mx-1.5 h-6 w-px bg-line" aria-hidden />;
}

/** A run of related buttons. Plain inline flow today; the brand candidates draw it as a hairline pill. */
function Group({ children }: { children: React.ReactNode }) {
  return <span className="tb-group flex items-center gap-0.5">{children}</span>;
}

const HEADINGS = [
  { value: "0", label: "Paragraph", className: "text-[15px]" },
  { value: "1", label: "Heading 1", className: "text-[22px] font-bold" },
  { value: "2", label: "Heading 2", className: "text-[19px] font-bold" },
  { value: "3", label: "Heading 3", className: "text-[17px] font-semibold" },
  { value: "4", label: "Heading 4", className: "text-[15px] font-semibold" },
  { value: "5", label: "Heading 5", className: "text-[14px] font-semibold" },
  { value: "6", label: "Heading 6", className: "text-[13px] font-semibold" },
];

export const Toolbar = memo(function Toolbar({
  session,
  actions,
  format,
  onComment,
  onImage,
  onTable,
}: {
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  onComment: () => void;
  onImage: () => void;
  onTable: () => void;
}) {
  const { canEdit, canUndo, canRedo, canComment } = useSessionValue(
    session,
    (s) => ({
      canEdit: s.canEdit,
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      canComment: s.canComment,
    }),
    shallowEqual,
  );
  const dis = !canEdit;
  const [mount] = useState(() => Object.freeze({}));
  const [active] = useState(() => new CurrentCell<ToolbarPublication | null>(null));
  const [successorOf] = useState(() => new CurrentCell<ToolbarPublication | null>(null));
  const [replay] = useState(() => new CurrentCell<ToolbarReplay | null>(null));
  const [last] = useState(() => new CurrentCell<HTMLButtonElement | null>(null));
  const [claimedEvents] = useState(() => new WeakSet<Event>());
  const [, setPublicationRevision] = useState(0);
  const requestSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const publication = createToolbarPublication({
    mount,
    active,
    successorOf,
    replay,
    last,
    claimedEvents,
    requestSuccessor,
    session,
    actions,
    format,
    canEdit,
    canUndo,
    canRedo,
    canComment,
    onComment,
    onImage,
    onTable,
  });
  useLayoutEffect(() => publication.establish(), [publication]);
  const {
    captureRoot,
    captureHeadingContent,
    onFocus: onToolbarFocus,
    onKeyDown: onToolbarKeyDown,
    onHeadingClose,
    headingItems,
    buttons,
  } = publication;
  const {
    heading,
    bold,
    italic,
    strike,
    link,
    code,
    codeBlock,
    bullet,
    ordered,
    task,
    quote,
    image,
    table,
    rule,
    undo,
    redo,
    comment,
  } = buttons;
  const { capture: captureHeading, onMouseDown: onHeadingMouseDown } = heading;
  const {
    capture: captureComment,
    onMouseDown: onCommentMouseDown,
    onClick: onCommentClick,
  } = comment;

  return (
    <div
      ref={captureRoot}
      className={TOOLBAR_BOX}
      role="toolbar"
      aria-label="Formatting"
      aria-orientation="horizontal"
      data-testid="toolbar"
      onFocus={onToolbarFocus}
      onKeyDown={onToolbarKeyDown}
    >
      <Group>
        <Menu>
          <MenuTrigger asChild>
            <button
              ref={captureHeading}
              type="button"
              className="icon-btn w-auto gap-1 px-2.5 font-semibold"
              disabled={dis}
              onMouseDown={onHeadingMouseDown}
              aria-label="Text style"
              data-testid="heading-menu"
            >
              <Heading size={18} />
              {format.heading > 0 && <span className="text-xs text-accent">{format.heading}</span>}
              <ChevronDown size={14} className="text-ink-4" />
            </button>
          </MenuTrigger>
          <MenuContent
            ref={captureHeadingContent}
            align="start"
            className="w-56"
            data-toolbar-heading-content=""
            // Radix hands focus back to the trigger when the menu closes; the caret belongs in the editor
            // the moment a style is picked (task #437: Ctrl+Z and typing went to the toolbar button).
            onCloseAutoFocus={onHeadingClose}
          >
            <MenuRadioGroup value={String(format.heading)}>
              {HEADINGS.map((h, index) => (
                <MenuRadioItem
                  ref={headingItems[index].control.capture}
                  key={h.value}
                  value={h.value}
                  className={h.className}
                  disabled={dis}
                  data-toolbar-heading={h.value}
                  onSelect={headingItems[index].onSelect}
                >
                  {h.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Bold" keys="Mod-B" active={format.strong} disabled={dis} control={bold} testId="tb-bold">
          <Bold size={18} strokeWidth={2.6} />
        </ToolButton>
        <ToolButton label="Italic" keys="Mod-I" active={format.em} disabled={dis} control={italic} testId="tb-italic">
          <Italic size={18} />
        </ToolButton>
        <ToolButton label="Strikethrough" keys="Mod-Shift-X" active={format.strike} disabled={dis} control={strike}>
          <Strikethrough size={18} />
        </ToolButton>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Link" keys="Mod-K" active={format.link} disabled={dis} control={link} testId="tb-link">
          <LinkIcon size={18} />
        </ToolButton>
        <ToolButton label="Inline code" keys="Mod-`" active={format.code} disabled={dis} control={code} testId="tb-code">
          <Code size={18} />
        </ToolButton>
        <ToolButton label="Code block" keys="Mod-Alt-C" active={format.codeBlock} disabled={dis} control={codeBlock}>
          <SquareCode size={18} />
        </ToolButton>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Bulleted list" keys="Mod-Shift-8" active={format.bullet} disabled={dis} control={bullet} testId="tb-bullet">
          <List size={18} />
        </ToolButton>
        <ToolButton label="Numbered list" keys="Mod-Shift-7" active={format.ordered} disabled={dis} control={ordered} testId="tb-ordered">
          <ListOrdered size={18} />
        </ToolButton>
        <ToolButton label="Task list" keys="Mod-Shift-9" active={format.task} disabled={dis} control={task} testId="tb-task">
          <ListChecks size={18} />
        </ToolButton>
        <ToolButton label="Quote" keys="Mod-Shift-." active={format.quote} disabled={dis} control={quote}>
          <Quote size={18} />
        </ToolButton>
        <ToolButton label="Image" disabled={dis} control={image} testId="tb-image">
          <ImageIcon size={18} />
        </ToolButton>
        <ToolButton label="Table" disabled={dis} control={table} testId="tb-table">
          <Table size={18} />
        </ToolButton>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Horizontal rule" disabled={dis} control={rule}>
          <Minus size={18} />
        </ToolButton>
      </Group>
      <Divider />
      <Group>
        <ToolButton label="Undo" keys="Mod-Z" disabled={!canEdit || !canUndo} control={undo} testId="tb-undo">
          <Undo2 size={18} />
        </ToolButton>
        <ToolButton label="Redo" keys="Mod-Shift-Z" disabled={!canEdit || !canRedo} control={redo} testId="tb-redo">
          <Redo2 size={18} />
        </ToolButton>
      </Group>
      <div className="flex-1" />
      {canComment && (
        <Tip label="Add comment" shortcut={shortcut("Mod-Alt-M")}>
          <button
            ref={captureComment}
            type="button"
            className={cn("btn btn-sm gap-1.5", format.hasSelection ? "btn-outline text-ink" : "btn-ghost text-ink-3")}
            onMouseDown={onCommentMouseDown}
            onClick={onCommentClick}
            data-testid="tb-comment"
          >
            <MessageSquarePlus size={16} />
            Comment
          </button>
        </Tip>
      )}
    </div>
  );
});
