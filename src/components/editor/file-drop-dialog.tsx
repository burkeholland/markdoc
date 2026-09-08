"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { FilePlus2, Loader2, Replace, TextCursorInput } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { uploadImportFiles } from "@/lib/import-upload";

type FileDropAction = "replace" | "insert" | "new";
const FILE_DROP_ACTIONS: readonly FileDropAction[] = ["replace", "insert", "new"];
const OPTION_CLASS_NAME =
  "flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left transition hover:border-accent disabled:cursor-default disabled:opacity-50";
const OPTION_ICON_CLASS_NAME =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-ink-2";
const OPTION_TITLE_CLASS_NAME = "block text-sm font-semibold text-ink";
const OPTION_DESCRIPTION_CLASS_NAME = "block text-xs text-ink-3";
const OPTIONS_CLASS_NAME = "flex flex-col gap-2";
const RADIX_SETTLING_ATTRIBUTES = new Set([
  "aria-describedby",
  "aria-labelledby",
  "style",
]);

export interface PendingFileDrop {
  file: File;
  /** Source offset where the file was dropped. */
  at: number;
}

export interface FileDropDialogProps {
  pending: PendingFileDrop | null;
  onClose: () => void;
  canEdit: boolean;
  /** Replace the whole source or insert at `at`; the text is already LF-normalised. */
  onReplace: (text: string) => void;
  onInsert: (text: string, at: number) => void;
  onError: (message: string) => void;
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.onload = () =>
      resolve(
        String(reader.result ?? "")
          .replace(/^\uFEFF/, "")
          .replace(/\r\n?/g, "\n"),
      );
    reader.readAsText(file);
  });
}

type FileDropRouter = ReturnType<typeof useRouter>;

interface FileDropOptionAuthority {
  readonly index: number;
  readonly action: FileDropAction;
  readonly eligible: boolean;
  readonly title: string;
  readonly description: string;
}

interface FileDropAuthority {
  readonly mount: symbol;
  readonly revision: number;
  readonly pending: PendingFileDrop;
  readonly file: File;
  readonly at: number;
  readonly canEdit: boolean;
  readonly router: FileDropRouter;
  readonly routerPush: FileDropRouter["push"];
  readonly onClose: () => void;
  readonly onReplace: (text: string) => void;
  readonly onInsert: (text: string, at: number) => void;
  readonly onError: (message: string) => void;
  readonly open: true;
  readonly busyAction: FileDropAction | null;
  readonly description: string;
  readonly options: readonly FileDropOptionAuthority[];
}

interface DomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly DomSnapshot[];
}

interface Placement {
  readonly document: Document;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface ElementOwnerView {
  readonly element: () => Element | null;
}

interface RefReplay {
  readonly owner: ElementOwnerView;
  readonly element: Element;
  detached: boolean;
  reattached: boolean;
}

interface FileDropPublication {
  readonly identity: symbol;
  readonly authority: FileDropAuthority;
  readonly content: HTMLDivElement;
  readonly ownerDocument: Document;
  readonly dom: DomSnapshot;
  readonly placement: Placement;
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
}

interface PublicationReplay {
  readonly source: FileDropPublication;
  readonly dom: DomSnapshot;
  readonly placement: Placement;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface PublicationRuntime {
  readonly publication: FileDropPublication;
  readonly publish: () => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: ElementOwnerView,
    element: Element | null,
    previous: Element | null,
  ) => void;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly replay: () => PublicationReplay | null;
}

class ElementOwner<T extends Element> implements ElementOwnerView {
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: ElementOwnerView,
      element: T | null,
      previous: T | null,
      last: T | null,
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

class PublicationCoordinator {
  readonly #mount: symbol;
  #active: FileDropPublication | null = null;
  #successorOf: FileDropPublication | null = null;
  #replay: PublicationReplay | null = null;
  #retired = new WeakSet<FileDropPublication>();
  #claimedPublications = new WeakSet<FileDropPublication>();
  #claimedActions = new WeakSet<object>();
  #claimedEvents = new WeakSet<object>();

  constructor(mount: symbol) {
    this.#mount = mount;
  }

  active() {
    return this.#active;
  }

  replay() {
    return this.#replay;
  }

  acceptsSuccessorOf(publication: FileDropPublication) {
    return (
      this.#active === null &&
      this.#successorOf === publication &&
      this.#retired.has(publication) &&
      !this.#claimedPublications.has(publication)
    );
  }

  stageReplay(replay: PublicationReplay) {
    if (!this.acceptsSuccessorOf(replay.source)) return false;
    this.#replay = replay;
    return true;
  }

  abandonReplay(publication: FileDropPublication) {
    if (this.#replay?.source === publication) this.#replay = null;
    if (this.#successorOf === publication) this.#successorOf = null;
  }

  publish(publication: FileDropPublication) {
    if (
      publication.authority.mount !== this.#mount ||
      this.#retired.has(publication)
    ) {
      return false;
    }
    const previous = this.#active;
    if (previous && previous !== publication) previous.retire();
    this.#active = publication;
    this.#successorOf = null;
    this.#replay = null;
    return true;
  }

  retire(publication: FileDropPublication) {
    if (this.#retired.has(publication)) return false;
    this.#retired.add(publication);
    if (this.#active === publication) {
      this.#active = null;
      this.#successorOf = publication;
    }
    return true;
  }

  isCurrent(publication: FileDropPublication) {
    return this.#active === publication && !this.#retired.has(publication);
  }

  hasClaimed(
    publication: FileDropPublication,
    action: object,
    event: object,
    nativeEvent: Event,
  ) {
    return (
      this.#claimedPublications.has(publication) ||
      this.#claimedActions.has(action) ||
      this.#claimedEvents.has(event) ||
      this.#claimedEvents.has(nativeEvent)
    );
  }

  claim(
    publication: FileDropPublication,
    action: object,
    event: object,
    nativeEvent: Event,
  ) {
    if (
      !this.isCurrent(publication) ||
      this.hasClaimed(publication, action, event, nativeEvent)
    ) {
      return false;
    }
    this.#claimedPublications.add(publication);
    this.#claimedActions.add(action);
    this.#claimedEvents.add(event);
    this.#claimedEvents.add(nativeEvent);
    return true;
  }
}

class PresentationCache {
  #current: {
    readonly authority: FileDropAuthority;
    readonly presentation: FileDropPresentation;
    readonly revision: number;
  } | null = null;

  resolve(
    authority: FileDropAuthority,
    revision: number,
    create: () => FileDropPresentation,
  ) {
    if (
      !this.#current ||
      this.#current.revision !== revision ||
      !authoritiesMatch(this.#current.authority, authority)
    ) {
      this.#current = Object.freeze({
        authority,
        presentation: create(),
        revision,
      });
    }
    return this.#current.presentation;
  }
}

class CurrentValue<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  get() {
    return this.#value;
  }

  set(value: T) {
    this.#value = value;
  }
}

interface DomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

function snapshotAttributes(
  node: Node,
): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  const element = node as Element;
  return Object.freeze(
    [...element.attributes]
      .filter(
        ({ name }) =>
          element.getAttribute("role") !== "dialog" ||
          !RADIX_SETTLING_ATTRIBUTES.has(name),
      )
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotDom(node: Node): DomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotDom)),
  });
}

function domMatches(snapshot: DomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = snapshotAttributes(node);
  if (attributes === null || snapshot.attributes === null) {
    if (attributes !== snapshot.attributes) return false;
  } else if (
    attributes.length !== snapshot.attributes.length ||
    attributes.some(([name, value], index) => {
      const expected = snapshot.attributes?.[index];
      return !expected || name !== expected[0] || value !== expected[1];
    })
  ) {
    return false;
  }
  return (
    node.childNodes.length === snapshot.children.length &&
    snapshot.children.every(
      (child, index) =>
        node.childNodes.item(index) === child.node && domMatches(child),
    )
  );
}

function snapshotContains(snapshot: DomSnapshot, node: Node): boolean {
  return (
    snapshot.node === node ||
    snapshot.children.some((child) => snapshotContains(child, node))
  );
}

function isRadixFocusGuard(node: Node | null) {
  if (!node || node.nodeType !== 1) return false;
  const element = node as Element;
  return (
    element.tagName === "SPAN" &&
    element.hasAttribute("data-radix-focus-guard")
  );
}

function previousCommittedSibling(node: Node) {
  let sibling = node.previousSibling;
  while (isRadixFocusGuard(sibling)) sibling = sibling?.previousSibling ?? null;
  return sibling;
}

function nextCommittedSibling(node: Node) {
  let sibling = node.nextSibling;
  while (isRadixFocusGuard(sibling)) sibling = sibling?.nextSibling ?? null;
  return sibling;
}

function capturePlacement(content: HTMLDivElement): Placement | null {
  const parent = content.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: content.ownerDocument,
    parent,
    previousSibling: previousCommittedSibling(content),
    nextSibling: nextCommittedSibling(content),
  });
}

function placementMatches(content: HTMLDivElement, placement: Placement) {
  return (
    content.ownerDocument === placement.document &&
    content.parentNode === placement.parent &&
    previousCommittedSibling(content) === placement.previousSibling &&
    nextCommittedSibling(content) === placement.nextSibling
  );
}

function createDomGuard(
  content: HTMLDivElement,
  placement: Placement,
): DomGuard | null {
  const MutationObserverConstructor =
    placement.document.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  const settlingAttributes = new Set(
    [...RADIX_SETTLING_ATTRIBUTES].filter(
      (attribute) => !content.hasAttribute(attribute),
    ),
  );
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some((record) => {
      if (
        record.type === "attributes" &&
        record.target === content &&
        record.attributeName &&
        settlingAttributes.delete(record.attributeName)
      ) {
        return false;
      }
      if (
        record.type === "childList" &&
        record.target === placement.parent &&
        [...record.addedNodes, ...record.removedNodes].length > 0 &&
        [...record.addedNodes, ...record.removedNodes].every(isRadixFocusGuard)
      ) {
        return false;
      }
      if (record.target === content || content.contains(record.target)) {
        return true;
      }
      if (record.type !== "childList" || record.target !== placement.parent) {
        return false;
      }
      if (
        record.previousSibling === content ||
        record.nextSibling === content
      ) {
        return true;
      }
      return [...record.addedNodes, ...record.removedNodes].some(
        (node) =>
          node === content ||
          (node.nodeType === 1 && (node as Element).contains(content)),
      );
    });
  };
  const observer = new MutationObserverConstructor(recordChanges);
  observer.observe(content, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  observer.observe(placement.parent, { childList: true });
  return Object.freeze({
    isClean: () => {
      recordChanges(observer.takeRecords());
      return !changed;
    },
    release: () => {
      recordChanges(observer.takeRecords());
      observer.disconnect();
    },
  });
}

function createPublicationRuntime(
  authority: FileDropAuthority,
  coordinator: PublicationCoordinator,
  content: HTMLDivElement,
  owners: readonly ElementOwnerView[],
  onRetire: () => void,
): PublicationRuntime {
  type Retirement = "element" | "layout" | "other";
  const placement = capturePlacement(content);
  if (!placement) {
    throw new Error(
      "Cannot publish dropped-file controls without a committed portal",
    );
  }
  const dom = snapshotDom(content);
  let retired = false;
  let retirement: Retirement | null = null;
  let established = false;
  let invalidReplay = false;
  let replayRefs: RefReplay[] = [];
  let domGuard: DomGuard | null = null;
  const publishedDomMatches = () =>
    Boolean(
      domGuard &&
        domGuard.isClean() &&
        content === dom.node &&
        content.isConnected &&
        placementMatches(content, placement) &&
        domMatches(dom),
    );
  const retire = (reason: Retirement) => {
    if (retired) return false;
    retired = true;
    retirement = reason;
    onRetire();
    coordinator.retire(publication);
    queueMicrotask(() => {
      if (coordinator.replay()?.source !== publication) domGuard?.release();
    });
    return true;
  };
  const publication: FileDropPublication = Object.freeze({
    identity: Symbol("file-drop-publication"),
    authority,
    content,
    ownerDocument: content.ownerDocument,
    dom,
    placement,
    retire: () => retire("other"),
    isRetired: () => retired,
    publishedDomMatches,
  });
  const refsHaveNoReplay = () =>
    !invalidReplay &&
    replayRefs.every(
      (entry) =>
        !entry.detached &&
        !entry.reattached &&
        entry.owner.element() === entry.element,
    );
  const refsHaveExactReplay = () =>
    !invalidReplay &&
    replayRefs.some((entry) => entry.detached && entry.reattached) &&
    replayRefs.every(
      (entry) =>
        ((!entry.detached && !entry.reattached) ||
          (entry.detached && entry.reattached)) &&
        entry.owner.element() === entry.element,
    );

  return Object.freeze({
    publication,
    publish: () => {
      established = true;
      replayRefs = owners.map((owner) => {
        const element = owner.element();
        if (!element) {
          throw new Error(
            "Cannot publish dropped-file controls without every committed ref",
          );
        }
        return { owner, element, detached: false, reattached: false };
      });
      domGuard = createDomGuard(content, placement);
      if (!domGuard || !coordinator.publish(publication)) {
        domGuard?.release();
        return false;
      }
      return true;
    },
    retireForElement: () => {
      retire("element");
    },
    retireForLayout: () => {
      retire("layout");
    },
    noteRef: (
      owner: ElementOwnerView,
      element: Element | null,
      previous: Element | null,
    ) => {
      if (!established) return;
      const proof = replayRefs.find((entry) => entry.owner === owner);
      if (!proof) {
        invalidReplay = true;
        return;
      }
      if (element === null && previous === proof.element) {
        proof.detached = true;
        proof.reattached = false;
      } else if (
        element === proof.element &&
        previous === null &&
        proof.detached
      ) {
        proof.reattached = true;
      } else if (element !== previous) {
        invalidReplay = true;
      }
      if (
        !retired &&
        replayRefs.every((entry) => entry.owner.element() === entry.element)
      ) {
        for (const entry of replayRefs) {
          entry.detached = false;
          entry.reattached = false;
        }
        invalidReplay = false;
      }
    },
    isExactElementReplay: () =>
      retired &&
      retirement === "element" &&
      established &&
      refsHaveExactReplay() &&
      publishedDomMatches(),
    isExactLayoutReplay: () =>
      retired &&
      retirement === "layout" &&
      established &&
      (refsHaveNoReplay() || refsHaveExactReplay()) &&
      publishedDomMatches(),
    replay: () =>
      domGuard
        ? Object.freeze({
            source: publication,
            dom,
            placement,
            historyIsClean: domGuard.isClean,
            release: domGuard.release,
          })
        : null,
  });
}

function replayAllowsPublication(
  coordinator: PublicationCoordinator,
  authority: FileDropAuthority,
  content: HTMLDivElement,
) {
  const replay = coordinator.replay();
  if (!replay) return true;
  const sameAuthority = authoritiesMatch(
    replay.source.authority,
    authority,
    false,
  );
  const exactReplay =
    sameAuthority &&
    coordinator.acceptsSuccessorOf(replay.source) &&
    replay.historyIsClean() &&
    content === replay.dom.node &&
    placementMatches(content, replay.placement) &&
    domMatches(replay.dom);
  coordinator.abandonReplay(replay.source);
  replay.release();
  return !sameAuthority || exactReplay;
}

function authoritiesMatch(
  previous: FileDropAuthority,
  current: FileDropAuthority,
  includeRevision = true,
) {
  return (
    previous.mount === current.mount &&
    (!includeRevision || previous.revision === current.revision) &&
    previous.pending === current.pending &&
    previous.file === current.file &&
    Object.is(previous.at, current.at) &&
    previous.canEdit === current.canEdit &&
    previous.router === current.router &&
    previous.routerPush === current.routerPush &&
    previous.onClose === current.onClose &&
    previous.onReplace === current.onReplace &&
    previous.onInsert === current.onInsert &&
    previous.onError === current.onError &&
    previous.open === current.open &&
    previous.busyAction === current.busyAction &&
    previous.description === current.description &&
    previous.options.length === current.options.length &&
    previous.options.every((option, index) => {
      const candidate = current.options[index];
      return Boolean(
        candidate &&
          option.index === candidate.index &&
          option.action === candidate.action &&
          option.eligible === candidate.eligible &&
          option.title === candidate.title &&
          option.description === candidate.description,
      );
    })
  );
}

function exactNativeClick(
  event: ReactMouseEvent<HTMLElement>,
  publication: FileDropPublication,
  currentTarget: HTMLElement,
  expectedControl: HTMLButtonElement,
): MouseEvent | null {
  if (!event || typeof event !== "object") return null;
  const ownerDocument = publication.ownerDocument;
  const view = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  const target = event.target;
  const reactEvent = event as ReactMouseEvent<HTMLElement> & {
    _reactName?: unknown;
    isDefaultPrevented?: unknown;
    isPropagationStopped?: unknown;
    persist?: unknown;
  };
  const eventPrototype = Object.getPrototypeOf(event) as {
    constructor?: { name?: unknown };
  } | null;
  return view &&
    nativeEvent instanceof view.MouseEvent &&
    nativeEvent.type === "click" &&
    nativeEvent.button === 0 &&
    nativeEvent.eventPhase !== view.Event.NONE &&
    nativeEvent.bubbles &&
    !nativeEvent.defaultPrevented &&
    event.type === "click" &&
    event.button === 0 &&
    event.bubbles &&
    !event.defaultPrevented &&
    event.currentTarget === currentTarget &&
    nativeEvent.target === target &&
    target instanceof view.Node &&
    target.ownerDocument === ownerDocument &&
    expectedControl.contains(target) &&
    nativeEvent.composedPath().includes(expectedControl) &&
    nativeEvent.composedPath().includes(publication.content) &&
    snapshotContains(publication.dom, target) &&
    eventPrototype?.constructor?.name === "SyntheticBaseEvent" &&
    reactEvent._reactName === "onClick" &&
    typeof reactEvent.isDefaultPrevented === "function" &&
    !reactEvent.isDefaultPrevented() &&
    typeof reactEvent.isPropagationStopped === "function" &&
    !reactEvent.isPropagationStopped() &&
    typeof reactEvent.persist === "function"
    ? nativeEvent
    : null;
}

function exactNativeDismissal(
  event: KeyboardEvent | PointerEvent,
  publication: FileDropPublication,
) {
  const ownerDocument = publication.ownerDocument;
  const view = ownerDocument.defaultView;
  const target = event.target;
  if (
    !view ||
    event.eventPhase === view.Event.NONE ||
    !event.bubbles ||
    event.defaultPrevented ||
    !(target instanceof view.Node) ||
    !target.isConnected ||
    target.ownerDocument !== ownerDocument ||
    !event.composedPath().includes(target) ||
    !event.composedPath().includes(ownerDocument)
  ) {
    return false;
  }
  if (event instanceof view.KeyboardEvent) {
    return (
      event.type === "keydown" &&
      event.key === "Escape" &&
      publication.content.contains(target) &&
      snapshotContains(publication.dom, target)
    );
  }
  const PointerEventConstructor = view.PointerEvent;
  return Boolean(
    PointerEventConstructor &&
      event instanceof PointerEventConstructor &&
      event.type === "pointerdown" &&
      event.button === 0 &&
      !event.ctrlKey &&
      !publication.content.contains(target),
  );
}

function exactNativeOutsideClick(
  pointer: {
    readonly target: EventTarget | null;
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;
  },
  event: MouseEvent,
  publication: FileDropPublication,
) {
  const ownerDocument = publication.ownerDocument;
  const view = ownerDocument.defaultView;
  const PointerEventConstructor = view?.PointerEvent;
  const target = event.target;
  return Boolean(
    view &&
      PointerEventConstructor &&
      event instanceof PointerEventConstructor &&
      event.type === "click" &&
      event.eventPhase !== view.Event.NONE &&
      event.bubbles &&
      !event.defaultPrevented &&
      event.button === 0 &&
      !event.ctrlKey &&
      target === pointer.target &&
      target instanceof view.Node &&
      target.isConnected &&
      target.ownerDocument === ownerDocument &&
      event.composedPath().includes(target) &&
      event.composedPath().includes(ownerDocument) &&
      !publication.content.contains(target) &&
      event.pointerId === pointer.pointerId &&
      event.pointerType === pointer.pointerType &&
      event.isPrimary === pointer.isPrimary,
  );
}

interface FileDropOperation {
  readonly identity: symbol;
  readonly origin: FileDropPublication;
  readonly authority: FileDropAuthority;
  readonly action: FileDropAction;
}

interface FileDropOptionPresentation {
  readonly authority: FileDropOptionAuthority;
  readonly captureButton: (element: HTMLButtonElement | null) => void;
  readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

interface FileDropPresentation {
  readonly authority: FileDropAuthority;
  readonly captureBridge: (element: HTMLDivElement | null) => void;
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly options: Readonly<Record<FileDropAction, FileDropOptionPresentation>>;
  readonly establish: () => void | (() => void);
  readonly settlePortal: () => void | (() => void);
  readonly onOpenChange: (open: boolean) => void;
  readonly onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly authorizeNativeDismissal: (
    publication: FileDropPublication,
    event: KeyboardEvent | PointerEvent | MouseEvent,
  ) => void;
  readonly owns: (publication: FileDropPublication) => boolean;
}

function FileDropPublicationBoundary({
  establish,
  settlePortal,
  children,
}: {
  establish: FileDropPresentation["establish"];
  settlePortal: FileDropPresentation["settlePortal"];
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    const cleanup = establish();
    return cleanup;
  }, [establish]);
  useEffect(() => {
    const cleanup = settlePortal();
    return cleanup;
  }, [settlePortal]);
  return children;
}

function operationMatchesAuthority(
  operation: FileDropOperation,
  authority: FileDropAuthority,
) {
  const source = operation.authority;
  return (
    source.mount === authority.mount &&
    source.pending === authority.pending &&
    source.file === authority.file &&
    Object.is(source.at, authority.at) &&
    source.canEdit === authority.canEdit &&
    source.router === authority.router &&
    source.routerPush === authority.routerPush &&
    source.onClose === authority.onClose &&
    source.onReplace === authority.onReplace &&
    source.onInsert === authority.onInsert &&
    source.onError === authority.onError &&
    source.open === authority.open
  );
}

function createFileDropPresentation(
  authority: FileDropAuthority,
  coordinator: PublicationCoordinator,
  latestAuthority: () => FileDropAuthority | null,
  requestSuccessor: () => void,
  hasOperation: () => boolean,
  startOperation: (
    publication: FileDropPublication,
    authority: FileDropAuthority,
    action: FileDropAction,
  ) => void,
  onPublished: (
    authorize: FileDropPresentation["authorizeNativeDismissal"],
  ) => void,
): FileDropPresentation {
  let currentRuntime: PublicationRuntime | null = null;
  let lastRuntime: PublicationRuntime | null = null;
  let successorRequested = false;
  let dismissal:
    | {
        readonly publication: FileDropPublication;
        readonly event: object;
        readonly nativeEvent: Event;
      }
    | null = null;
  let outsidePointer:
    | {
        readonly publication: FileDropPublication;
        readonly target: EventTarget | null;
        readonly pointerId: number;
        readonly pointerType: string;
        readonly isPrimary: boolean;
      }
    | null = null;
  const clearDismissalAuthority = () => {
    dismissal = null;
    outsidePointer = null;
  };
  const onElementChange = (
    owner: ElementOwnerView,
    element: Element | null,
    previous: Element | null,
    last: Element | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null || (element !== null && last !== null && element !== last)) {
      currentRuntime?.retireForElement();
      currentRuntime = null;
      clearDismissalAuthority();
    }
    if (
      runtime?.isExactElementReplay() &&
      coordinator.acceptsSuccessorOf(runtime.publication)
    ) {
      requestReplaySuccessor(runtime);
    }
    if (
      !lastRuntime &&
      expectedOwners().every((expected) => expected.element() !== null)
    ) {
      establish();
    }
  };
  const bridgeOwner = new ElementOwner<HTMLDivElement>(onElementChange);
  const rootOwner = new ElementOwner<HTMLDivElement>(onElementChange);
  const optionPresentations = authority.options.map((optionAuthority) => {
    const buttonOwner = new ElementOwner<HTMLButtonElement>(onElementChange);
    const action = Object.freeze({
      identity: Symbol(`file-drop-${optionAuthority.action}-action`),
    });
    const onClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
      const publication = coordinator.active();
      const button = buttonOwner.element();
      if (
        !publication ||
        publication.isRetired() ||
        publication.authority !== authority ||
        latestAuthority() !== authority ||
        authority.busyAction !== null ||
        hasOperation() ||
        !optionAuthority.eligible ||
        authority.options[optionAuthority.index] !== optionAuthority ||
        !button ||
        !owns(publication) ||
        buttonOwner.element() !== button
      ) {
        return;
      }
      const nativeEvent = exactNativeClick(
        event,
        publication,
        button,
        button,
      );
      if (
        !nativeEvent ||
        coordinator.hasClaimed(publication, action, event, nativeEvent) ||
        !coordinator.claim(publication, action, event, nativeEvent)
      ) {
        return;
      }
      startOperation(publication, authority, optionAuthority.action);
    };
    return Object.freeze({
      authority: optionAuthority,
      captureButton: buttonOwner.capture,
      buttonOwner,
      onClick,
    });
  });
  const presentationFor = (action: FileDropAction) => {
    const presentation = optionPresentations.find(
      (candidate) => candidate.authority.action === action,
    );
    if (!presentation) {
      throw new Error(`Missing dropped-file ${action} presentation`);
    }
    return presentation;
  };
  const options: Readonly<
    Record<FileDropAction, FileDropOptionPresentation>
  > = Object.freeze({
    replace: presentationFor("replace"),
    insert: presentationFor("insert"),
    new: presentationFor("new"),
  });
  const expectedOwners = () =>
    Object.freeze([
      bridgeOwner,
      rootOwner,
      ...optionPresentations.map(({ buttonOwner }) => buttonOwner),
    ]);
  const factsAreCurrent = () =>
    latestAuthority() === authority &&
    authority.pending.file === authority.file &&
    Object.is(authority.pending.at, authority.at) &&
    authority.router.push === authority.routerPush &&
    authority.open &&
    authority.description ===
      `What should happen with “${authority.file.name}”?` &&
    authority.options.length === FILE_DROP_ACTIONS.length &&
    authority.options.every((option, index) => {
      const action = FILE_DROP_ACTIONS[index];
      return (
        option.index === index &&
        option.action === action &&
        option.eligible === (action === "new" || authority.canEdit)
      );
    });
  const exactDom = () => {
    const bridge = bridgeOwner.element();
    const root = rootOwner.element();
    const view = root?.ownerDocument.defaultView;
    const content = root?.parentElement;
    const header = content?.firstElementChild;
    const titleElement = header?.querySelector("h2");
    const descriptionElement = header?.querySelector("p");
    const close = header?.querySelector<HTMLButtonElement>(
      'button[aria-label="Close"]',
    );
    const overlay = content?.previousElementSibling;
    const valid = bridge &&
      root &&
      view &&
      content instanceof view.HTMLDivElement &&
      header instanceof view.HTMLDivElement &&
      close instanceof view.HTMLButtonElement &&
      overlay instanceof view.HTMLDivElement &&
      bridge.isConnected &&
      bridge.ownerDocument === root.ownerDocument &&
      bridge.tagName === "DIV" &&
      bridge.getAttribute("class") === "contents" &&
      bridge.childNodes.length === 0 &&
      root.isConnected &&
      root.tagName === "DIV" &&
      root.getAttribute("class") === OPTIONS_CLASS_NAME &&
      root.dataset.testid === "file-drop-dialog" &&
      root.hasAttribute("data-focus-skip") &&
      root.parentElement === content &&
      content.isConnected &&
      content.getAttribute("role") === "dialog" &&
      titleElement instanceof view.HTMLHeadingElement &&
      descriptionElement instanceof view.HTMLParagraphElement &&
      content.getAttribute("aria-labelledby") !== "" &&
      (content.getAttribute("aria-labelledby") === null ||
        content.getAttribute("aria-labelledby") === titleElement.id) &&
      content.getAttribute("aria-describedby") !== "" &&
      (content.getAttribute("aria-describedby") === null ||
        content.getAttribute("aria-describedby") === descriptionElement.id) &&
      (content.style.pointerEvents === "" ||
        content.style.pointerEvents === "auto") &&
      content.children.length === 2 &&
      content.childNodes.length === 2 &&
      content.children.item(0) === header &&
      content.children.item(1) === root &&
      header.parentElement === content &&
      close.type === "button" &&
      !close.disabled &&
      close.parentElement === header &&
      overlay.isConnected &&
      overlay.parentNode === content.parentNode &&
      overlay.nextSibling === content &&
      overlay.className === "dialog-overlay animate-fade-in" &&
      root.children.length === FILE_DROP_ACTIONS.length &&
      root.childNodes.length === FILE_DROP_ACTIONS.length &&
      optionPresentations.every((presentation, index) => {
        const option = presentation.authority;
        const button = presentation.buttonOwner.element();
        const icon = button?.children.item(0);
        const copy = button?.children.item(1);
        const title = copy?.children.item(0);
        const description = copy?.children.item(1);
        const expectedDisabled =
          authority.busyAction !== null || !option.eligible;
        return Boolean(
          authority.options[index] === option &&
            button &&
            icon instanceof view.HTMLSpanElement &&
            copy instanceof view.HTMLSpanElement &&
            title instanceof view.HTMLSpanElement &&
            description instanceof view.HTMLSpanElement &&
            button.isConnected &&
            button.ownerDocument === root.ownerDocument &&
            button.tagName === "BUTTON" &&
            button.parentElement === root &&
            root.children.item(index) === button &&
            root.childNodes.item(index) === button &&
            button.type === "button" &&
            button.disabled === expectedDisabled &&
            button.matches(":disabled") === expectedDisabled &&
            button.getAttribute("class") === OPTION_CLASS_NAME &&
            button.dataset.testid === `file-drop-${option.action}` &&
            button.children.length === 2 &&
            button.childNodes.length === 2 &&
            icon.getAttribute("class") === OPTION_ICON_CLASS_NAME &&
            icon.children.length === 1 &&
            icon.firstElementChild?.tagName.toLowerCase() === "svg" &&
            icon.firstElementChild?.getAttribute("width") === "16" &&
            icon.firstElementChild?.getAttribute("height") === "16" &&
            icon.firstElementChild?.getAttribute("aria-hidden") === "true" &&
            copy.children.length === 2 &&
            copy.childNodes.length === 2 &&
            title.getAttribute("class") === OPTION_TITLE_CLASS_NAME &&
            title.textContent === option.title &&
            description.getAttribute("class") ===
              OPTION_DESCRIPTION_CLASS_NAME &&
            description.textContent === option.description,
        );
      })
    return valid ? { bridge, root, content, close } : null;
  };
  const owns = (publication: FileDropPublication) => {
    const dom = exactDom();
    return Boolean(
      dom &&
        factsAreCurrent() &&
        publication.authority === authority &&
        publication.content === dom.content &&
        coordinator.isCurrent(publication) &&
        !publication.isRetired() &&
        publication.publishedDomMatches(),
    );
  };
  const requestReplaySuccessor = (runtime: PublicationRuntime) => {
    const replay = runtime.replay();
    const dom = exactDom();
    if (
      successorRequested ||
      !replay ||
      !dom ||
      !coordinator.acceptsSuccessorOf(runtime.publication) ||
      !factsAreCurrent() ||
      !runtime.publication.publishedDomMatches() ||
      !coordinator.stageReplay(replay)
    ) {
      return;
    }
    successorRequested = true;
    requestSuccessor();
  };
  const establish = () => {
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() ||
          lastRuntime.isExactElementReplay()) &&
        coordinator.acceptsSuccessorOf(lastRuntime.publication)
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    const dom = exactDom();
    if (
      !factsAreCurrent() ||
      !dom ||
      !replayAllowsPublication(coordinator, authority, dom.content)
    ) {
      return undefined;
    }
    const runtime = createPublicationRuntime(
      authority,
      coordinator,
      dom.content,
      expectedOwners(),
      clearDismissalAuthority,
    );
    currentRuntime = runtime;
    lastRuntime = runtime;
    if (!runtime.publish()) {
      runtime.retireForElement();
      currentRuntime = null;
      return undefined;
    }
    onPublished(authorizeNativeDismissal);
    return runtime.retireForLayout;
  };
  const dismissalAction = Object.freeze({
    identity: Symbol("file-drop-dismissal"),
  });
  const stageDismissal = (
    publication: FileDropPublication,
    event: object,
    nativeEvent: Event,
  ) => {
    clearDismissalAuthority();
    if (
      hasOperation() ||
      !owns(publication) ||
      coordinator.hasClaimed(
        publication,
        dismissalAction,
        event,
        nativeEvent,
      )
    ) {
      return;
    }
    const proof = { publication, event, nativeEvent };
    dismissal = proof;
    publication.ownerDocument.defaultView?.setTimeout(() => {
      if (dismissal === proof) dismissal = null;
    }, 0);
  };
  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    const publication = coordinator.active();
    const dom = exactDom();
    if (
      !publication ||
      !dom ||
      event.currentTarget !== dom.bridge ||
      !dom.close.contains(event.target as Node)
    ) {
      return;
    }
    const nativeEvent = exactNativeClick(
      event,
      publication,
      dom.bridge,
      dom.close,
    );
    if (nativeEvent) stageDismissal(publication, event, nativeEvent);
  };
  const authorizeNativeDismissal = (
    publication: FileDropPublication,
    event: KeyboardEvent | PointerEvent | MouseEvent,
  ) => {
    const view = publication.ownerDocument.defaultView;
    const PointerEventConstructor = view?.PointerEvent;
    if (!view) return;
    const pointer = outsidePointer;
    clearDismissalAuthority();
    if (
      event.type === "click" &&
      PointerEventConstructor &&
      event instanceof PointerEventConstructor
    ) {
      if (
        pointer?.publication === publication &&
        exactNativeOutsideClick(pointer, event, publication)
      ) {
        stageDismissal(publication, event, event);
      }
      return;
    }
    if (event instanceof view.KeyboardEvent) {
      if (
        publication.authority === authority &&
        exactNativeDismissal(event, publication)
      ) {
        stageDismissal(publication, event, event);
      }
      return;
    }
    if (
      !PointerEventConstructor ||
      !(event instanceof PointerEventConstructor)
    ) {
      return;
    }
    if (
      publication.authority !== authority ||
      !exactNativeDismissal(event, publication)
    ) {
      return;
    }
    outsidePointer = {
      publication,
      target: event.target,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      isPrimary: event.isPrimary,
    };
  };
  const onOpenChange = (open: boolean) => {
    const proof = dismissal;
    if (
      open ||
      !proof ||
      proof.publication.authority !== authority ||
      !owns(proof.publication) ||
      !coordinator.claim(
        proof.publication,
        dismissalAction,
        proof.event,
        proof.nativeEvent,
      )
    ) {
      clearDismissalAuthority();
      return;
    }
    clearDismissalAuthority();
    proof.publication.retire();
    authority.onClose();
  };
  const settlePortal = () => {
    if (!lastRuntime) return establish();
    establish();
  };

  return Object.freeze({
    authority,
    captureBridge: bridgeOwner.capture,
    captureRoot: rootOwner.capture,
    options,
    establish,
    settlePortal,
    onOpenChange,
    onClickCapture,
    authorizeNativeDismissal,
    owns,
  });
}

/** Asks what to do with a Markdown file dropped on the editor: replace, insert at the drop point, or open as a new document. */
export const FileDropDialog = memo(function FileDropDialog({
  pending,
  onClose,
  canEdit,
  onReplace,
  onInsert,
  onError,
}: FileDropDialogProps) {
  const router = useRouter();
  const routerPush = router.push;
  const [mount] = useState(() => Symbol("file-drop-dialog"));
  const [coordinator] = useState(() => new PublicationCoordinator(mount));
  const [presentationCache] = useState(() => new PresentationCache());
  const [publicationRevision, setPublicationRevision] = useState(0);
  const [busy, setBusy] = useState<FileDropOperation | null>(null);
  const [latestAuthority] = useState(
    () => new CurrentValue<FileDropAuthority | null>(null),
  );
  const [dismissalAuthorization] = useState(
    () =>
      new CurrentValue<
        FileDropPresentation["authorizeNativeDismissal"] | null
      >(null),
  );
  const [activeOperation] = useState(
    () => new CurrentValue<FileDropOperation | null>(null),
  );
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const ownsOperation = useCallback(
    (operation: FileDropOperation) => {
      const publication = coordinator.active();
      return Boolean(
        activeOperation.get() === operation &&
          publication &&
          latestAuthority.get() === publication.authority &&
          operationMatchesAuthority(operation, publication.authority) &&
          (publication === operation.origin ||
            publication.authority.busyAction === operation.action) &&
          coordinator.isCurrent(publication) &&
          !publication.isRetired() &&
          publication.publishedDomMatches(),
      );
    },
    [activeOperation, coordinator, latestAuthority],
  );
  const startOperation = useCallback(
    async (
      publication: FileDropPublication,
      authority: FileDropAuthority,
      action: FileDropAction,
    ) => {
      if (
        activeOperation.get() ||
        coordinator.active() !== publication ||
        publication.authority !== authority
      ) {
        return;
      }
      const operation = Object.freeze({
        identity: Symbol(`file-drop-${action}-operation`),
        origin: publication,
        authority,
        action,
      });
      activeOperation.set(operation);
      setBusy(operation);
      try {
        if (action === "new") {
          const [doc] = await uploadImportFiles([authority.file]);
          if (!ownsOperation(operation)) return;
          if (!doc) throw new Error("Import failed");
          authority.routerPush.call(authority.router, `/d/${doc.id}`);
        } else {
          const text = await readText(authority.file);
          if (!ownsOperation(operation)) return;
          if (action === "replace") authority.onReplace(text);
          else authority.onInsert(text, authority.at);
        }
        if (ownsOperation(operation)) authority.onClose();
      } catch (error) {
        if (ownsOperation(operation)) {
          authority.onError(
            error instanceof Error
              ? error.message
              : "Could not read the file",
          );
        }
      } finally {
        if (ownsOperation(operation)) {
          activeOperation.set(null);
          setBusy((current) => (current === operation ? null : current));
        }
      }
    },
    [activeOperation, coordinator, ownsOperation],
  );
  const busyAction =
    busy &&
    busy === activeOperation.get() &&
    pending &&
    busy.authority.mount === mount &&
    busy.authority.pending === pending &&
    busy.authority.file === pending.file &&
    Object.is(busy.authority.at, pending.at) &&
    busy.authority.canEdit === canEdit &&
    busy.authority.router === router &&
    busy.authority.routerPush === routerPush &&
    busy.authority.onClose === onClose &&
    busy.authority.onReplace === onReplace &&
    busy.authority.onInsert === onInsert &&
    busy.authority.onError === onError
      ? busy.action
      : null;
  const candidate: FileDropAuthority | null = pending
    ? Object.freeze({
        mount,
        revision: publicationRevision,
        pending,
        file: pending.file,
        at: pending.at,
        canEdit,
        router,
        routerPush,
        onClose,
        onReplace,
        onInsert,
        onError,
        open: true,
        busyAction,
        description: `What should happen with “${pending.file.name}”?`,
        options: Object.freeze([
          Object.freeze({
            index: 0,
            action: "replace" as const,
            eligible: canEdit,
            title: "Replace document content",
            description:
              "The whole document becomes the file's text (undoable).",
          }),
          Object.freeze({
            index: 1,
            action: "insert" as const,
            eligible: canEdit,
            title: "Insert at cursor",
            description: "Put the file's text where you dropped it.",
          }),
          Object.freeze({
            index: 2,
            action: "new" as const,
            eligible: true,
            title: "Open as new document",
            description:
              "Import the file as a separate document and open it.",
          }),
        ]),
      })
    : null;
  latestAuthority.set(candidate);
  const presentation = candidate
    ? presentationCache.resolve(candidate, publicationRevision, () =>
        createFileDropPresentation(
          candidate,
          coordinator,
          () => latestAuthority.get(),
          requestPublicationSuccessor,
          () => activeOperation.get() !== null,
          (publication, authority, action) => {
            void startOperation(publication, authority, action);
          },
          (authorize) => dismissalAuthorization.set(authorize),
        ),
      )
    : null;
  latestAuthority.set(presentation?.authority ?? null);

  useLayoutEffect(() => {
    const operation = activeOperation.get();
    if (
      operation &&
      (!presentation ||
        !operationMatchesAuthority(operation, presentation.authority))
    ) {
      activeOperation.set(null);
    }
  }, [activeOperation, presentation]);

  // Radix handles Escape and outside pointer events in document capture, before portal React capture.
  useLayoutEffect(() => {
    const authorizeNativeOpenChange = (
      event: KeyboardEvent | PointerEvent | MouseEvent,
    ) => {
      const publication = coordinator.active();
      const authorize = dismissalAuthorization.get();
      if (!publication || !authorize) return;
      authorize(publication, event);
    };
    document.addEventListener(
      "keydown",
      authorizeNativeOpenChange as EventListener,
      true,
    );
    document.addEventListener(
      "pointerdown",
      authorizeNativeOpenChange as EventListener,
      true,
    );
    document.addEventListener(
      "click",
      authorizeNativeOpenChange as EventListener,
      true,
    );
    return () => {
      document.removeEventListener(
        "keydown",
        authorizeNativeOpenChange as EventListener,
        true,
      );
      document.removeEventListener(
        "pointerdown",
        authorizeNativeOpenChange as EventListener,
        true,
      );
      document.removeEventListener(
        "click",
        authorizeNativeOpenChange as EventListener,
        true,
      );
    };
  }, [coordinator, dismissalAuthorization]);

  const authority = presentation?.authority;
  const captureBridge = presentation?.captureBridge;
  const captureRoot = presentation?.captureRoot;
  const onClickCapture = presentation?.onClickCapture;
  const onOpenChange = presentation?.onOpenChange;
  const establish = presentation?.establish;
  const settlePortal = presentation?.settlePortal;
  const replaceOption = presentation?.options.replace;
  const insertOption = presentation?.options.insert;
  const newOption = presentation?.options.new;
  const busyPresentationAction = authority?.busyAction ?? null;

  const option = (
    control: FileDropOptionPresentation,
    icon: ReactNode,
  ) => (
    <button
      ref={control.captureButton}
      type="button"
      onClick={control.onClick}
      disabled={
        control.authority.action === busyPresentationAction ||
        busyPresentationAction !== null ||
        !control.authority.eligible
      }
      className={OPTION_CLASS_NAME}
      data-testid={`file-drop-${control.authority.action}`}
    >
      <span className={OPTION_ICON_CLASS_NAME}>
        {busyPresentationAction === control.authority.action ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          icon
        )}
      </span>
      <span>
        <span className={OPTION_TITLE_CLASS_NAME}>
          {control.authority.title}
        </span>
        <span className={OPTION_DESCRIPTION_CLASS_NAME}>
          {control.authority.description}
        </span>
      </span>
    </button>
  );

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={onOpenChange}
    >
      <div
        ref={captureBridge}
        className="contents"
        onClickCapture={onClickCapture}
      >
        {authority &&
          establish &&
          settlePortal &&
          replaceOption &&
          insertOption &&
          newOption && (
          <FileDropPublicationBoundary
            establish={establish}
            settlePortal={settlePortal}
          >
            <DialogContent
              title="Dropped file"
              description={authority.description}
            >
              {/* Every option changes the document; keep the opening focus on Close rather than an option Enter would fire. */}
              <div
                ref={captureRoot}
                className={OPTIONS_CLASS_NAME}
                data-testid="file-drop-dialog"
                data-focus-skip
              >
                {option(
                  replaceOption,
                  <Replace size={16} />,
                )}
                {option(
                  insertOption,
                  <TextCursorInput size={16} />,
                )}
                {option(
                  newOption,
                  <FilePlus2 size={16} />,
                )}
              </div>
            </DialogContent>
          </FileDropPublicationBoundary>
        )}
      </div>
    </Dialog>
  );
});
