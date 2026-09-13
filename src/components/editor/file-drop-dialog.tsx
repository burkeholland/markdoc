"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { FilePlus2, Loader2, Replace, TextCursorInput } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { uploadImportFiles } from "@/lib/import-upload";

type FileDropAction = "replace" | "insert" | "new";
const FILE_DROP_ACTIONS: readonly FileDropAction[] = ["replace", "insert", "new"];
const FILE_DROP_NAVIGATION_KEYS = [
  "ArrowDown",
  "ArrowRight",
  "ArrowUp",
  "ArrowLeft",
  "Home",
  "End",
] as const;
type FileDropNavigationKey = (typeof FILE_DROP_NAVIGATION_KEYS)[number];
const FILE_DROP_PREVENT_SCROLL = Object.freeze({ preventScroll: true });
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const units = ["KiB", "MiB", "GiB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${Number(size.toFixed(1))} ${units[unit]}`;
}

function fileDropDescription(file: File): string {
  return `What should happen with “${file.name}” (${formatFileSize(file.size)})?`;
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
  readonly root: HTMLDivElement;
  readonly options: readonly FileDropPublishedOption[];
  readonly enabledOptions: readonly FileDropPublishedOption[];
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly keyboard: FileDropKeyboardAuthority;
  readonly keyListener: FileDropKeyListener;
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

interface FileDropPublishedOption {
  readonly authority: FileDropOptionAuthority;
  readonly owner: ElementOwnerView;
  readonly button: HTMLButtonElement;
  readonly index: number;
}

interface FileDropMovement {
  readonly identity: symbol;
  readonly key: FileDropNavigationKey;
  readonly source: FileDropOptionAuthority;
  readonly destination: FileDropOptionAuthority | null;
}

interface FileDropTrustedAuthority {
  readonly matches: (event: object) => boolean;
  readonly read: (event: object) => boolean;
  readonly isCurrent: () => boolean;
}

interface FileDropWindowMethod<Method> {
  readonly value: Method;
  readonly isCurrent: () => boolean;
}

interface FileDropKeyboardAuthority {
  readonly ownerWindow: Window & typeof globalThis;
  readonly listenerTarget: Window & typeof globalThis;
  readonly KeyboardEvent: typeof globalThis.KeyboardEvent;
  readonly Node: typeof globalThis.Node;
  readonly HTMLButtonElement: typeof globalThis.HTMLButtonElement;
  readonly keyboardPrototype: object;
  readonly capturingPhase: number;
  readonly bubblingPhase: number;
  readonly standardLocation: number;
  readonly apply: typeof Reflect.apply;
  readonly getPrototypeOf: typeof Object.getPrototypeOf;
  readonly trusted: FileDropTrustedAuthority;
  readonly event: Readonly<{
    type: (this: Event) => string;
    target: (this: Event) => EventTarget | null;
    currentTarget: (this: Event) => EventTarget | null;
    eventPhase: (this: Event) => number;
    bubbles: (this: Event) => boolean;
    cancelable: (this: Event) => boolean;
    defaultPrevented: (this: Event) => boolean;
    cancelBubble: (this: Event) => boolean;
    composedPath: (this: Event) => EventTarget[];
    preventDefault: (this: Event) => void;
  }>;
  readonly keyboard: Readonly<{
    key: (this: globalThis.KeyboardEvent) => string;
    code: (this: globalThis.KeyboardEvent) => string;
    location: (this: globalThis.KeyboardEvent) => number;
    altKey: (this: globalThis.KeyboardEvent) => boolean;
    ctrlKey: (this: globalThis.KeyboardEvent) => boolean;
    metaKey: (this: globalThis.KeyboardEvent) => boolean;
    shiftKey: (this: globalThis.KeyboardEvent) => boolean;
    repeat: (this: globalThis.KeyboardEvent) => boolean;
    isComposing: (this: globalThis.KeyboardEvent) => boolean;
  }>;
  readonly view: (this: UIEvent) => Window | null;
  readonly activeElement: (this: Document) => Element | null;
  readonly focus: (this: HTMLElement, options?: FocusOptions) => void;
  readonly addEventListener: FileDropWindowMethod<Window["addEventListener"]>;
  readonly removeEventListener: FileDropWindowMethod<
    Window["removeEventListener"]
  >;
  readonly isCurrent: () => boolean;
}

interface FileDropNativeSnapshot {
  readonly type: string;
  readonly target: EventTarget | null;
  readonly currentTarget: EventTarget | null;
  readonly phase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly cancelBubble: boolean;
  readonly path: readonly EventTarget[];
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly isTrusted: boolean;
  readonly view: Window | null;
}

interface FileDropWindowProof {
  readonly identity: symbol;
  readonly registration: FileDropKeyListener;
  readonly publication: FileDropPublication;
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly source: HTMLButtonElement;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly terminal: EventTarget;
  readonly snapshot: FileDropNativeSnapshot;
}

interface FileDropKeyListener {
  readonly identity: symbol;
  readonly listener: EventListener;
  readonly activate: (publication: FileDropPublication) => boolean;
  readonly proofFor: (
    event: globalThis.KeyboardEvent,
    publication: FileDropPublication,
    source: HTMLButtonElement,
  ) => FileDropWindowProof | null;
  readonly claim: (
    proof: FileDropWindowProof,
    publication: FileDropPublication,
  ) => boolean;
  readonly retains: (
    proof: FileDropWindowProof,
    publication: FileDropPublication,
  ) => boolean;
  readonly release: (publication: FileDropPublication) => void;
}

interface FileDropReactMethods {
  readonly preventDefault: (...args: never[]) => unknown;
  readonly isDefaultPrevented: (...args: never[]) => unknown;
  readonly isPropagationStopped: (...args: never[]) => unknown;
}

interface FileDropKeyDelivery {
  readonly publication: FileDropPublication;
  readonly wrapper: ReactKeyboardEvent<HTMLElement>;
  readonly methods: FileDropReactMethods;
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly listener: FileDropWindowProof;
  readonly currentTarget: HTMLElement;
  readonly dispatchTarget: EventTarget;
  readonly source: HTMLButtonElement;
  readonly sourceIndex: number;
  readonly key: FileDropNavigationKey;
  readonly snapshot: FileDropNativeSnapshot;
}

interface FileDropNavigationClaim {
  readonly publication: FileDropPublication;
  readonly movement: FileDropMovement;
  readonly captureWrapper: object;
  readonly bubbleWrapper: object;
  readonly nativeEvent: Event;
  readonly listener: FileDropWindowProof;
  readonly source: ElementOwnerView;
  readonly destination: ElementOwnerView;
}

const claimedFileDropMovements = new WeakSet<FileDropMovement>();
const claimedFileDropReactEvents = new WeakSet<object>();
const claimedFileDropNativeEvents = new WeakSet<Event>();
const claimedFileDropListenerProofs = new WeakSet<FileDropWindowProof>();
const claimedFileDropSources = new WeakSet<ElementOwnerView>();
const claimedFileDropDestinations = new WeakSet<ElementOwnerView>();

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
  #claimedWindowProofs = new WeakSet<FileDropWindowProof>();
  #claimedSources = new WeakSet<ElementOwnerView>();
  #claimedDestinations = new WeakSet<ElementOwnerView>();

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

  claimNavigation(claim: FileDropNavigationClaim) {
    const {
      publication,
      movement,
      captureWrapper,
      bubbleWrapper,
      nativeEvent,
      listener,
      source,
      destination,
    } = claim;
    if (
      captureWrapper === bubbleWrapper ||
      !this.isCurrent(publication) ||
      this.#claimedPublications.has(publication) ||
      this.#claimedActions.has(movement) ||
      this.#claimedEvents.has(captureWrapper) ||
      this.#claimedEvents.has(bubbleWrapper) ||
      this.#claimedEvents.has(nativeEvent) ||
      this.#claimedWindowProofs.has(listener) ||
      this.#claimedSources.has(source) ||
      this.#claimedDestinations.has(destination) ||
      claimedFileDropMovements.has(movement) ||
      claimedFileDropReactEvents.has(captureWrapper) ||
      claimedFileDropReactEvents.has(bubbleWrapper) ||
      claimedFileDropNativeEvents.has(nativeEvent) ||
      claimedFileDropListenerProofs.has(listener) ||
      claimedFileDropSources.has(source) ||
      claimedFileDropDestinations.has(destination)
    ) {
      return false;
    }
    this.#claimedPublications.add(publication);
    this.#claimedActions.add(movement);
    this.#claimedEvents.add(captureWrapper);
    this.#claimedEvents.add(bubbleWrapper);
    this.#claimedEvents.add(nativeEvent);
    this.#claimedWindowProofs.add(listener);
    this.#claimedSources.add(source);
    this.#claimedDestinations.add(destination);
    claimedFileDropMovements.add(movement);
    claimedFileDropReactEvents.add(captureWrapper);
    claimedFileDropReactEvents.add(bubbleWrapper);
    claimedFileDropNativeEvents.add(nativeEvent);
    claimedFileDropListenerProofs.add(listener);
    claimedFileDropSources.add(source);
    claimedFileDropDestinations.add(destination);
    return true;
  }

  retainsNavigation(claim: FileDropNavigationClaim) {
    return (
      this.isCurrent(claim.publication) &&
      this.#claimedPublications.has(claim.publication) &&
      this.#claimedActions.has(claim.movement) &&
      this.#claimedEvents.has(claim.captureWrapper) &&
      this.#claimedEvents.has(claim.bubbleWrapper) &&
      this.#claimedEvents.has(claim.nativeEvent) &&
      this.#claimedWindowProofs.has(claim.listener) &&
      this.#claimedSources.has(claim.source) &&
      this.#claimedDestinations.has(claim.destination) &&
      claimedFileDropMovements.has(claim.movement) &&
      claimedFileDropReactEvents.has(claim.captureWrapper) &&
      claimedFileDropReactEvents.has(claim.bubbleWrapper) &&
      claimedFileDropNativeEvents.has(claim.nativeEvent) &&
      claimedFileDropListenerProofs.has(claim.listener) &&
      claimedFileDropSources.has(claim.source) &&
      claimedFileDropDestinations.has(claim.destination)
    );
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

function fileDropDescriptorMatches(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  return Boolean(
    current &&
      current.configurable === expected.configurable &&
      current.enumerable === expected.enumerable &&
      current.get === expected.get &&
      current.set === expected.set &&
      current.value === expected.value &&
      current.writable === expected.writable
  );
}

function captureFileDropWindowMethod<
  Property extends "addEventListener" | "removeEventListener",
>(
  ownerWindow: Window & typeof globalThis,
  property: Property,
): FileDropWindowMethod<Window[Property]> | null {
  const getOwnPropertyDescriptor =
    ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const reflectGet = ownerWindow.Reflect.get;
  const path: {
    readonly target: object;
    readonly descriptor: Readonly<PropertyDescriptor> | null;
    readonly prototype: object | null;
  }[] = [];
  let target: object | null = ownerWindow;
  let found = false;
  while (target) {
    const descriptor = getOwnPropertyDescriptor(target, property);
    const prototype = getPrototypeOf(target) as object | null;
    path.push(
      Object.freeze({
        target,
        descriptor: descriptor ? Object.freeze({ ...descriptor }) : null,
        prototype,
      }),
    );
    if (descriptor) {
      found = true;
      break;
    }
    target = prototype;
  }
  const value = reflectGet(
    ownerWindow,
    property,
    ownerWindow,
  ) as Window[Property];
  if (!found || typeof value !== "function") return null;
  let historyIsClean = true;
  const isCurrent = () => {
    if (!historyIsClean) return false;
    historyIsClean =
      ownerWindow.Object.getOwnPropertyDescriptor ===
        getOwnPropertyDescriptor &&
      ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
      ownerWindow.Reflect.get === reflectGet &&
      path.every(
        ({ target: entry, descriptor, prototype }) =>
          getPrototypeOf(entry) === prototype &&
          (descriptor
            ? fileDropDescriptorMatches(
                getOwnPropertyDescriptor(entry, property),
                descriptor,
              )
            : getOwnPropertyDescriptor(entry, property) === undefined),
      ) &&
      reflectGet(ownerWindow, property, ownerWindow) === value;
    return historyIsClean;
  };
  return isCurrent() ? Object.freeze({ value, isCurrent }) : null;
}

function captureFileDropTrustedAuthority(
  ownerWindow: Window & typeof globalThis,
): FileDropTrustedAuthority | null {
  let probe: globalThis.KeyboardEvent;
  try {
    probe = new ownerWindow.KeyboardEvent("file-drop-keyboard-trust-probe");
  } catch {
    return null;
  }
  const getOwnPropertyDescriptor =
    ownerWindow.Object.getOwnPropertyDescriptor;
  const apply = ownerWindow.Reflect.apply;
  const descriptor = getOwnPropertyDescriptor(probe, "isTrusted");
  if (
    !descriptor ||
    descriptor.configurable !== false ||
    typeof descriptor.get !== "function" ||
    descriptor.set !== undefined
  ) {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  const matches = (event: object) =>
    fileDropDescriptorMatches(
      getOwnPropertyDescriptor(event, "isTrusted"),
      expected,
    );
  let historyIsClean = true;
  const isCurrent = () => {
    if (!historyIsClean) return false;
    historyIsClean =
      ownerWindow.Object.getOwnPropertyDescriptor ===
        getOwnPropertyDescriptor &&
      ownerWindow.Reflect.apply === apply &&
      matches(probe);
    return historyIsClean;
  };
  return Object.freeze({
    matches,
    read: (event: object) =>
      apply(descriptor.get as (this: object) => boolean, event, []),
    isCurrent,
  });
}

function captureFileDropKeyboardAuthority(
  ownerWindow: Window & typeof globalThis,
): FileDropKeyboardAuthority | null {
  const objectConstructor = ownerWindow.Object;
  const reflect = ownerWindow.Reflect;
  const eventConstructor = ownerWindow.Event;
  const keyboardConstructor = ownerWindow.KeyboardEvent;
  const uiEventConstructor = ownerWindow.UIEvent;
  const documentConstructor = ownerWindow.Document;
  const htmlElementConstructor = ownerWindow.HTMLElement;
  const nodeConstructor = ownerWindow.Node;
  const htmlButtonElementConstructor = ownerWindow.HTMLButtonElement;
  const eventPrototype = eventConstructor.prototype;
  const keyboardPrototype = keyboardConstructor.prototype;
  const uiEventPrototype = uiEventConstructor.prototype;
  const documentPrototype = documentConstructor.prototype;
  const htmlElementPrototype = htmlElementConstructor.prototype;
  const getOwnPropertyDescriptor =
    objectConstructor.getOwnPropertyDescriptor;
  const getPrototypeOf = objectConstructor.getPrototypeOf;
  const apply = reflect.apply;
  const descriptors: {
    readonly target: object;
    readonly property: PropertyKey;
    readonly descriptor: Readonly<PropertyDescriptor>;
  }[] = [];
  const getter = <This extends object, Value>(
    target: object,
    property: PropertyKey,
  ): ((this: This) => Value) | null => {
    const descriptor = getOwnPropertyDescriptor(target, property);
    if (!descriptor || typeof descriptor.get !== "function") return null;
    descriptors.push(
      Object.freeze({
        target,
        property,
        descriptor: Object.freeze({ ...descriptor }),
      }),
    );
    return descriptor.get as (this: This) => Value;
  };
  const method = <This extends object, Args extends readonly unknown[], Result>(
    target: object,
    property: PropertyKey,
  ): ((this: This, ...args: Args) => Result) | null => {
    const descriptor = getOwnPropertyDescriptor(target, property);
    if (!descriptor || typeof descriptor.value !== "function") return null;
    descriptors.push(
      Object.freeze({
        target,
        property,
        descriptor: Object.freeze({ ...descriptor }),
      }),
    );
    return descriptor.value as (this: This, ...args: Args) => Result;
  };
  const trusted = captureFileDropTrustedAuthority(ownerWindow);
  const type = getter<Event, string>(eventPrototype, "type");
  const target = getter<Event, EventTarget | null>(eventPrototype, "target");
  const currentTarget = getter<Event, EventTarget | null>(
    eventPrototype,
    "currentTarget",
  );
  const eventPhase = getter<Event, number>(eventPrototype, "eventPhase");
  const bubbles = getter<Event, boolean>(eventPrototype, "bubbles");
  const cancelable = getter<Event, boolean>(eventPrototype, "cancelable");
  const defaultPrevented = getter<Event, boolean>(
    eventPrototype,
    "defaultPrevented",
  );
  const cancelBubble = getter<Event, boolean>(
    eventPrototype,
    "cancelBubble",
  );
  const composedPath = method<Event, readonly [], EventTarget[]>(
    eventPrototype,
    "composedPath",
  );
  const preventDefault = method<Event, readonly [], void>(
    eventPrototype,
    "preventDefault",
  );
  const key = getter<globalThis.KeyboardEvent, string>(
    keyboardPrototype,
    "key",
  );
  const code = getter<globalThis.KeyboardEvent, string>(
    keyboardPrototype,
    "code",
  );
  const location = getter<globalThis.KeyboardEvent, number>(
    keyboardPrototype,
    "location",
  );
  const altKey = getter<globalThis.KeyboardEvent, boolean>(
    keyboardPrototype,
    "altKey",
  );
  const ctrlKey = getter<globalThis.KeyboardEvent, boolean>(
    keyboardPrototype,
    "ctrlKey",
  );
  const metaKey = getter<globalThis.KeyboardEvent, boolean>(
    keyboardPrototype,
    "metaKey",
  );
  const shiftKey = getter<globalThis.KeyboardEvent, boolean>(
    keyboardPrototype,
    "shiftKey",
  );
  const repeat = getter<globalThis.KeyboardEvent, boolean>(
    keyboardPrototype,
    "repeat",
  );
  const isComposing = getter<globalThis.KeyboardEvent, boolean>(
    keyboardPrototype,
    "isComposing",
  );
  const view = getter<UIEvent, Window | null>(uiEventPrototype, "view");
  const activeElement = getter<Document, Element | null>(
    documentPrototype,
    "activeElement",
  );
  const focus = method<HTMLElement, readonly [FocusOptions?], void>(
    htmlElementPrototype,
    "focus",
  );
  const addEventListener = captureFileDropWindowMethod(
    ownerWindow,
    "addEventListener",
  );
  const removeEventListener = captureFileDropWindowMethod(
    ownerWindow,
    "removeEventListener",
  );
  if (
    !trusted ||
    !type ||
    !target ||
    !currentTarget ||
    !eventPhase ||
    !bubbles ||
    !cancelable ||
    !defaultPrevented ||
    !cancelBubble ||
    !composedPath ||
    !preventDefault ||
    !key ||
    !code ||
    !location ||
    !altKey ||
    !ctrlKey ||
    !metaKey ||
    !shiftKey ||
    !repeat ||
    !isComposing ||
    !view ||
    !activeElement ||
    !focus ||
    !addEventListener ||
    !removeEventListener
  ) {
    return null;
  }
  let historyIsClean = true;
  const isCurrent = () => {
    if (!historyIsClean) return false;
    historyIsClean =
      ownerWindow.Object === objectConstructor &&
      ownerWindow.Reflect === reflect &&
      ownerWindow.Event === eventConstructor &&
      ownerWindow.KeyboardEvent === keyboardConstructor &&
      ownerWindow.UIEvent === uiEventConstructor &&
      ownerWindow.Document === documentConstructor &&
      ownerWindow.HTMLElement === htmlElementConstructor &&
      ownerWindow.Node === nodeConstructor &&
      ownerWindow.HTMLButtonElement === htmlButtonElementConstructor &&
      eventConstructor.prototype === eventPrototype &&
      keyboardConstructor.prototype === keyboardPrototype &&
      uiEventConstructor.prototype === uiEventPrototype &&
      documentConstructor.prototype === documentPrototype &&
      htmlElementConstructor.prototype === htmlElementPrototype &&
      ownerWindow.Object.getOwnPropertyDescriptor ===
        getOwnPropertyDescriptor &&
      ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
      ownerWindow.Reflect.apply === apply &&
      descriptors.every(({ target, property, descriptor }) =>
        fileDropDescriptorMatches(
          getOwnPropertyDescriptor(target, property),
          descriptor,
        ),
      ) &&
      addEventListener.isCurrent() &&
      removeEventListener.isCurrent() &&
      trusted.isCurrent();
    return historyIsClean;
  };
  const authority: FileDropKeyboardAuthority = {
    ownerWindow,
    listenerTarget: ownerWindow,
    KeyboardEvent: keyboardConstructor,
    Node: nodeConstructor,
    HTMLButtonElement: htmlButtonElementConstructor,
    keyboardPrototype,
    capturingPhase: eventConstructor.CAPTURING_PHASE,
    bubblingPhase: eventConstructor.BUBBLING_PHASE,
    standardLocation: keyboardConstructor.DOM_KEY_LOCATION_STANDARD,
    apply,
    getPrototypeOf,
    trusted,
    event: Object.freeze({
      type,
      target,
      currentTarget,
      eventPhase,
      bubbles,
      cancelable,
      defaultPrevented,
      cancelBubble,
      composedPath,
      preventDefault,
    }),
    keyboard: Object.freeze({
      key,
      code,
      location,
      altKey,
      ctrlKey,
      metaKey,
      shiftKey,
      repeat,
      isComposing,
    }),
    view,
    activeElement,
    focus,
    addEventListener,
    removeEventListener,
    isCurrent,
  };
  return isCurrent() ? Object.freeze(authority) : null;
}

function readFileDropNativeSnapshot(
  event: globalThis.KeyboardEvent,
  keyboard: FileDropKeyboardAuthority,
): FileDropNativeSnapshot | null {
  try {
    if (
      keyboard.getPrototypeOf(event) !== keyboard.keyboardPrototype ||
      !keyboard.isCurrent() ||
      !keyboard.trusted.matches(event)
    ) {
      return null;
    }
    return Object.freeze({
      type: keyboard.apply(keyboard.event.type, event, []),
      target: keyboard.apply(keyboard.event.target, event, []),
      currentTarget: keyboard.apply(
        keyboard.event.currentTarget,
        event,
        [],
      ),
      phase: keyboard.apply(keyboard.event.eventPhase, event, []),
      bubbles: keyboard.apply(keyboard.event.bubbles, event, []),
      cancelable: keyboard.apply(keyboard.event.cancelable, event, []),
      defaultPrevented: keyboard.apply(
        keyboard.event.defaultPrevented,
        event,
        [],
      ),
      cancelBubble: keyboard.apply(
        keyboard.event.cancelBubble,
        event,
        [],
      ),
      path: Object.freeze(
        keyboard.apply(keyboard.event.composedPath, event, []),
      ),
      key: keyboard.apply(keyboard.keyboard.key, event, []),
      code: keyboard.apply(keyboard.keyboard.code, event, []),
      location: keyboard.apply(keyboard.keyboard.location, event, []),
      altKey: keyboard.apply(keyboard.keyboard.altKey, event, []),
      ctrlKey: keyboard.apply(keyboard.keyboard.ctrlKey, event, []),
      metaKey: keyboard.apply(keyboard.keyboard.metaKey, event, []),
      shiftKey: keyboard.apply(keyboard.keyboard.shiftKey, event, []),
      repeat: keyboard.apply(keyboard.keyboard.repeat, event, []),
      isComposing: keyboard.apply(
        keyboard.keyboard.isComposing,
        event,
        [],
      ),
      isTrusted: keyboard.trusted.read(event),
      view: keyboard.apply(keyboard.view, event, []),
    });
  } catch {
    return null;
  }
}

function fileDropNativeStableFactsMatch(
  left: FileDropNativeSnapshot,
  right: FileDropNativeSnapshot,
) {
  return (
    left.type === right.type &&
    left.target === right.target &&
    left.bubbles === right.bubbles &&
    left.cancelable === right.cancelable &&
    left.defaultPrevented === right.defaultPrevented &&
    left.cancelBubble === right.cancelBubble &&
    left.key === right.key &&
    left.code === right.code &&
    left.location === right.location &&
    left.altKey === right.altKey &&
    left.ctrlKey === right.ctrlKey &&
    left.metaKey === right.metaKey &&
    left.shiftKey === right.shiftKey &&
    left.repeat === right.repeat &&
    left.isComposing === right.isComposing &&
    left.isTrusted === right.isTrusted &&
    left.view === right.view &&
    left.path.length === right.path.length &&
    left.path.every((entry, index) => right.path[index] === entry)
  );
}

function fileDropNativeFactsMatch(
  left: FileDropNativeSnapshot,
  right: FileDropNativeSnapshot,
) {
  return (
    left.currentTarget === right.currentTarget &&
    left.phase === right.phase &&
    fileDropNativeStableFactsMatch(left, right)
  );
}

function fileDropPathMatches(
  path: readonly EventTarget[],
  source: HTMLButtonElement,
  ownerDocument: Document,
  terminal: EventTarget,
) {
  const expected: EventTarget[] = [];
  let current: Node | null = source;
  while (current) {
    expected.push(current);
    if (current === ownerDocument) break;
    current = current.parentNode;
  }
  return (
    expected.at(-1) === ownerDocument &&
    path.length === expected.length + 1 &&
    expected.every((entry, index) => path[index] === entry) &&
    path.at(-1) === terminal
  );
}

function createFileDropKeyListener(
  keyboard: FileDropKeyboardAuthority,
): FileDropKeyListener {
  const proofs = new WeakMap<
    globalThis.KeyboardEvent,
    FileDropWindowProof
  >();
  const invalidEvents = new WeakSet<Event>();
  const claimedProofs = new WeakSet<FileDropWindowProof>();
  let publication: FileDropPublication | null = null;
  let active = false;
  let released = false;

  const listener: EventListener = function (
    this: EventTarget,
    event: Event,
  ) {
    const current = publication;
    if (
      !current ||
      !active ||
      released ||
      current.keyListener !== registration ||
      current.isRetired() ||
      invalidEvents.has(event) ||
      keyboard.getPrototypeOf(event) !== keyboard.keyboardPrototype ||
      !keyboard.isCurrent()
    ) {
      return;
    }
    const nativeEvent = event as globalThis.KeyboardEvent;
    if (proofs.has(nativeEvent)) {
      invalidEvents.add(nativeEvent);
      return;
    }
    const snapshot = readFileDropNativeSnapshot(nativeEvent, keyboard);
    const source =
      snapshot?.target instanceof keyboard.HTMLButtonElement &&
      current.options.some(
        (option) => option.button === snapshot.target,
      )
        ? snapshot.target
        : null;
    const terminal = snapshot?.path.at(-1);
    if (
      !snapshot ||
      !source ||
      !terminal ||
      snapshot.currentTarget !== this ||
      terminal !== this ||
      snapshot.phase !== keyboard.capturingPhase ||
      !fileDropPathMatches(
        snapshot.path,
        source,
        current.ownerDocument,
        this,
      )
    ) {
      return;
    }
    proofs.set(
      nativeEvent,
      Object.freeze({
        identity: Symbol("file-drop-window-key-proof"),
        registration,
        publication: current,
        nativeEvent,
        source,
        receiver: this,
        currentTarget: this,
        terminal,
        snapshot,
      }),
    );
  };

  const proofFor = (
    event: globalThis.KeyboardEvent,
    current: FileDropPublication,
    source: HTMLButtonElement,
  ) => {
    const proof = proofs.get(event);
    if (
      !proof ||
      !active ||
      released ||
      publication !== current ||
      current.keyListener !== registration ||
      current.isRetired() ||
      proof.registration !== registration ||
      proof.publication !== current ||
      proof.nativeEvent !== event ||
      proof.source !== source ||
      proof.receiver !== proof.currentTarget ||
      proof.receiver !== proof.terminal ||
      invalidEvents.has(event) ||
      !keyboard.isCurrent()
    ) {
      return null;
    }
    const snapshot = readFileDropNativeSnapshot(event, keyboard);
    return snapshot &&
      fileDropNativeStableFactsMatch(proof.snapshot, snapshot) &&
      fileDropPathMatches(
        snapshot.path,
        source,
        current.ownerDocument,
        proof.receiver,
      )
      ? proof
      : null;
  };

  const registration: FileDropKeyListener = Object.freeze({
    identity: Symbol("file-drop-window-key-listener"),
    listener,
    activate: (current: FileDropPublication) => {
      if (
        publication ||
        active ||
        released ||
        current.keyListener !== registration ||
        current.keyboard !== keyboard ||
        current.ownerWindow !== keyboard.ownerWindow ||
        current.ownerDocument.defaultView !== keyboard.ownerWindow ||
        !keyboard.isCurrent()
      ) {
        return false;
      }
      publication = current;
      active = true;
      try {
        keyboard.apply(
          keyboard.addEventListener.value,
          keyboard.listenerTarget,
          ["keydown", listener, true],
        );
      } catch {
        active = false;
        publication = null;
        return false;
      }
      if (keyboard.isCurrent()) return true;
      active = false;
      publication = null;
      keyboard.apply(
        keyboard.removeEventListener.value,
        keyboard.listenerTarget,
        ["keydown", listener, true],
      );
      return false;
    },
    proofFor,
    claim: (
      proof: FileDropWindowProof,
      current: FileDropPublication,
    ) => {
      if (
        claimedProofs.has(proof) ||
        proofFor(proof.nativeEvent, current, proof.source) !== proof
      ) {
        return false;
      }
      claimedProofs.add(proof);
      return true;
    },
    retains: (
      proof: FileDropWindowProof,
      current: FileDropPublication,
    ) =>
      publication === current &&
      current.keyListener === registration &&
      claimedProofs.has(proof) &&
      proofs.get(proof.nativeEvent) === proof &&
      proof.registration === registration &&
      proof.publication === current &&
      proof.receiver === proof.currentTarget &&
      proof.receiver === proof.terminal &&
      !invalidEvents.has(proof.nativeEvent) &&
      active &&
      !released &&
      keyboard.isCurrent(),
    release: (current: FileDropPublication) => {
      if (publication !== current || released) return;
      released = true;
      const wasActive = active;
      active = false;
      if (wasActive) {
        keyboard.apply(
          keyboard.removeEventListener.value,
          keyboard.listenerTarget,
          ["keydown", listener, true],
        );
      }
    },
  });
  return registration;
}

function isFileDropNavigationKey(
  key: string,
): key is FileDropNavigationKey {
  return FILE_DROP_NAVIGATION_KEYS.some((candidate) => candidate === key);
}

function exactFileDropKeyDelivery(
  event: ReactKeyboardEvent<HTMLElement>,
  publication: FileDropPublication,
  currentTarget: HTMLElement,
  expectedPhase: number,
): FileDropKeyDelivery | null {
  if (!event || typeof event !== "object") return null;
  const keyboard = publication.keyboard;
  const nativeEvent = event.nativeEvent;
  if (
    !(nativeEvent instanceof keyboard.KeyboardEvent) ||
    keyboard.getPrototypeOf(nativeEvent) !== keyboard.keyboardPrototype ||
    !keyboard.isCurrent() ||
    !keyboard.trusted.matches(nativeEvent)
  ) {
    return null;
  }
  try {
    const snapshot = readFileDropNativeSnapshot(nativeEvent, keyboard);
    if (!snapshot || !isFileDropNavigationKey(snapshot.key)) return null;
    const key = snapshot.key;
    const sourceIndex = publication.options.findIndex(
      ({ button }) => button === snapshot.target,
    );
    const publishedSource = publication.options[sourceIndex];
    if (
      !publishedSource ||
      !publication.enabledOptions.includes(publishedSource)
    ) {
      return null;
    }
    const source = publishedSource.button;
    const listener = publication.keyListener.proofFor(
      nativeEvent,
      publication,
      source,
    );
    if (
      !listener ||
      !fileDropNativeStableFactsMatch(listener.snapshot, snapshot)
    ) {
      return null;
    }
    const reactEvent = event as ReactKeyboardEvent<HTMLElement> & {
      preventDefault?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
    };
    const methods = Object.freeze({
      preventDefault:
        reactEvent.preventDefault as (...args: never[]) => unknown,
      isDefaultPrevented:
        reactEvent.isDefaultPrevented as (...args: never[]) => unknown,
      isPropagationStopped:
        reactEvent.isPropagationStopped as (...args: never[]) => unknown,
    });
    const dispatchTarget = snapshot.currentTarget;
    return typeof methods.preventDefault === "function" &&
      typeof methods.isDefaultPrevented === "function" &&
      typeof methods.isPropagationStopped === "function" &&
      keyboard.apply(methods.isDefaultPrevented, event, []) === false &&
      keyboard.apply(methods.isPropagationStopped, event, []) === false &&
      snapshot.type === "keydown" &&
      snapshot.phase === expectedPhase &&
      snapshot.bubbles &&
      snapshot.cancelable &&
      !snapshot.defaultPrevented &&
      !snapshot.cancelBubble &&
      snapshot.isTrusted &&
      (snapshot.view === null ||
        (snapshot.view === listener.receiver &&
          snapshot.view === snapshot.path.at(-1))) &&
      !snapshot.repeat &&
      !snapshot.isComposing &&
      !snapshot.altKey &&
      !snapshot.ctrlKey &&
      !snapshot.metaKey &&
      !snapshot.shiftKey &&
      snapshot.target === source &&
      fileDropPathMatches(
        snapshot.path,
        source,
        publication.ownerDocument,
        listener.receiver,
      ) &&
      dispatchTarget !== null &&
      dispatchTarget instanceof keyboard.Node &&
      dispatchTarget.ownerDocument === publication.ownerDocument &&
      snapshot.path.filter((entry) => entry === dispatchTarget).length ===
        1 &&
      keyboard.apply(
        keyboard.activeElement,
        publication.ownerDocument,
        [],
      ) === source &&
      event !== (nativeEvent as unknown) &&
      event.type === snapshot.type &&
      event.nativeEvent === nativeEvent &&
      event.currentTarget === currentTarget &&
      event.target === source &&
      event.eventPhase === snapshot.phase &&
      event.bubbles === snapshot.bubbles &&
      event.cancelable === snapshot.cancelable &&
      event.defaultPrevented === snapshot.defaultPrevented &&
      event.isTrusted === snapshot.isTrusted &&
      event.key === snapshot.key &&
      event.code === snapshot.code &&
      event.location === snapshot.location &&
      event.altKey === snapshot.altKey &&
      event.ctrlKey === snapshot.ctrlKey &&
      event.metaKey === snapshot.metaKey &&
      event.shiftKey === snapshot.shiftKey &&
      event.repeat === snapshot.repeat &&
      Object.is(event.view, snapshot.view) &&
      reactEvent.preventDefault === methods.preventDefault &&
      reactEvent.isDefaultPrevented === methods.isDefaultPrevented &&
      reactEvent.isPropagationStopped ===
        methods.isPropagationStopped
      ? Object.freeze({
          publication,
          wrapper: event,
          methods,
          nativeEvent,
          listener,
          currentTarget,
          dispatchTarget,
          source,
          sourceIndex,
          key,
          snapshot,
        })
      : null;
  } catch {
    return null;
  }
}

function fileDropSameWrapperDeliveriesMatch(
  left: FileDropKeyDelivery,
  right: FileDropKeyDelivery,
) {
  return (
    left.publication === right.publication &&
    left.wrapper === right.wrapper &&
    left.methods.preventDefault === right.methods.preventDefault &&
    left.methods.isDefaultPrevented ===
      right.methods.isDefaultPrevented &&
    left.methods.isPropagationStopped ===
      right.methods.isPropagationStopped &&
    left.nativeEvent === right.nativeEvent &&
    left.listener === right.listener &&
    left.dispatchTarget === right.dispatchTarget &&
    left.source === right.source &&
    left.sourceIndex === right.sourceIndex &&
    left.key === right.key &&
    fileDropNativeFactsMatch(left.snapshot, right.snapshot)
  );
}

function fileDropDistinctWrapperDeliveriesMatch(
  capture: FileDropKeyDelivery,
  bubble: FileDropKeyDelivery,
) {
  return (
    capture.publication === bubble.publication &&
    capture.wrapper !== bubble.wrapper &&
    capture.nativeEvent === bubble.nativeEvent &&
    capture.listener === bubble.listener &&
    capture.dispatchTarget === bubble.dispatchTarget &&
    capture.source === bubble.source &&
    capture.sourceIndex === bubble.sourceIndex &&
    capture.key === bubble.key &&
    fileDropNativeStableFactsMatch(capture.snapshot, bubble.snapshot)
  );
}

function fileDropReactMethodsRemainFalse(
  delivery: FileDropKeyDelivery,
) {
  const event = delivery.wrapper as ReactKeyboardEvent<HTMLElement> & {
    preventDefault?: unknown;
    isDefaultPrevented?: unknown;
    isPropagationStopped?: unknown;
  };
  const { keyboard } = delivery.publication;
  try {
    return (
      event.preventDefault === delivery.methods.preventDefault &&
      event.isDefaultPrevented ===
        delivery.methods.isDefaultPrevented &&
      event.isPropagationStopped ===
        delivery.methods.isPropagationStopped &&
      keyboard.apply(
        delivery.methods.isDefaultPrevented,
        delivery.wrapper,
        [],
      ) === false &&
      keyboard.apply(
        delivery.methods.isPropagationStopped,
        delivery.wrapper,
        [],
      ) === false
    );
  } catch {
    return false;
  }
}

function fileDropReactPreventionMatches(
  delivery: FileDropKeyDelivery,
) {
  const event = delivery.wrapper as ReactKeyboardEvent<HTMLElement> & {
    preventDefault?: unknown;
    isDefaultPrevented?: unknown;
    isPropagationStopped?: unknown;
  };
  const { keyboard } = delivery.publication;
  const isDefaultPrevented = event.isDefaultPrevented;
  try {
    return (
      event.preventDefault === delivery.methods.preventDefault &&
      event.isPropagationStopped ===
        delivery.methods.isPropagationStopped &&
      typeof isDefaultPrevented === "function" &&
      event.defaultPrevented === true &&
      keyboard.apply(isDefaultPrevented, delivery.wrapper, []) === true &&
      keyboard.apply(
        delivery.methods.isPropagationStopped,
        delivery.wrapper,
        [],
      ) === false
    );
  } catch {
    return false;
  }
}

function createPublicationRuntime(
  authority: FileDropAuthority,
  coordinator: PublicationCoordinator,
  content: HTMLDivElement,
  root: HTMLDivElement,
  optionOwners: readonly ElementOwnerView[],
  buttons: readonly HTMLButtonElement[],
  owners: readonly ElementOwnerView[],
  onRetire: () => void,
): PublicationRuntime | null {
  type Retirement = "element" | "layout" | "other";
  const placement = capturePlacement(content);
  if (!placement) {
    throw new Error(
      "Cannot publish dropped-file controls without a committed portal",
    );
  }
  const ownerWindow = content.ownerDocument.defaultView;
  if (
    !ownerWindow ||
    root.ownerDocument !== content.ownerDocument ||
    root.parentElement !== content ||
    buttons.length !== authority.options.length ||
    optionOwners.length !== authority.options.length
  ) {
    return null;
  }
  const keyboard = captureFileDropKeyboardAuthority(ownerWindow);
  if (!keyboard) return null;
  const keyListener = createFileDropKeyListener(keyboard);
  const options = buttons.map((button, index) => {
    const optionAuthority = authority.options[index];
    const owner = optionOwners[index];
    if (!optionAuthority || !owner || owner.element() !== button) return null;
    return Object.freeze({
      authority: optionAuthority,
      owner,
      button,
      index,
    });
  });
  if (options.some((option) => option === null)) return null;
  const publishedOptions = Object.freeze(
    options as FileDropPublishedOption[],
  );
  const enabledOptions = Object.freeze(
    publishedOptions.filter(
      ({ authority: optionAuthority, button }) =>
        authority.busyAction === null &&
        optionAuthority.eligible &&
        !button.disabled &&
        !button.matches(":disabled"),
    ),
  );
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
        content.ownerDocument.defaultView === ownerWindow &&
        root.parentElement === content &&
        publishedOptions.every(
          ({ authority: optionAuthority, owner, button, index }) =>
            authority.options[index] === optionAuthority &&
            owner.element() === button &&
            root.children.item(index) === button &&
            root.childNodes.item(index) === button &&
            button.parentElement === root &&
            enabledOptions.includes(publishedOptions[index]!) ===
              (authority.busyAction === null &&
                optionAuthority.eligible &&
                !button.disabled &&
                !button.matches(":disabled")),
        ) &&
        placementMatches(content, placement) &&
        domMatches(dom),
    );
  const retire = (reason: Retirement) => {
    if (retired) return false;
    retired = true;
    retirement = reason;
    onRetire();
    keyListener.release(publication);
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
    root,
    options: publishedOptions,
    enabledOptions,
    ownerDocument: content.ownerDocument,
    ownerWindow,
    keyboard,
    keyListener,
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
      if (!keyListener.activate(publication) || !publishedDomMatches()) {
        retire("other");
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
  readonly onKeyDownCapture: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly onKeyDown: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
}

interface FileDropPresentation {
  readonly authority: FileDropAuthority;
  readonly captureBridge: (element: HTMLDivElement | null) => void;
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly options: Readonly<Record<FileDropAction, FileDropOptionPresentation>>;
  readonly onRootKeyDownCapture: (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
  readonly onRootKeyDown: (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
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

function fileDropMovementDestination(
  key: FileDropNavigationKey,
  source: FileDropOptionAuthority,
  authority: FileDropAuthority,
): FileDropOptionAuthority | null {
  const enabled =
    authority.busyAction === null
      ? authority.options.filter((option) => option.eligible)
      : [];
  const sourceIndex = enabled.indexOf(source);
  if (sourceIndex < 0) return null;
  let destinationIndex = sourceIndex;
  if (key === "ArrowDown" || key === "ArrowRight") {
    destinationIndex++;
  } else if (key === "ArrowUp" || key === "ArrowLeft") {
    destinationIndex--;
  } else if (key === "Home") {
    destinationIndex = 0;
  } else {
    destinationIndex = enabled.length - 1;
  }
  const destination = enabled[destinationIndex] ?? null;
  return destination === source ? null : destination;
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
  let capturedRoot: FileDropKeyDelivery | null = null;
  let capturedOption: FileDropKeyDelivery | null = null;
  let bubbledOption: FileDropKeyDelivery | null = null;
  const clearKeyboardAuthority = () => {
    capturedRoot = null;
    capturedOption = null;
    bubbledOption = null;
  };
  const clearPublicationAuthority = () => {
    clearDismissalAuthority();
    clearKeyboardAuthority();
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
      clearKeyboardAuthority();
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
    const movements = Object.freeze(
      Object.fromEntries(
        FILE_DROP_NAVIGATION_KEYS.map((key) => [
          key,
          Object.freeze({
            identity: Symbol(
              `file-drop-${optionAuthority.action}-${key}-movement`,
            ),
            key,
            source: optionAuthority,
            destination: fileDropMovementDestination(
              key,
              optionAuthority,
              authority,
            ),
          } satisfies FileDropMovement),
        ]),
      ) as Record<FileDropNavigationKey, FileDropMovement>,
    );
    const onKeyDownCapture = (
      event: ReactKeyboardEvent<HTMLButtonElement>,
    ) => {
      const publication = currentKeyboardPublication();
      const source = buttonOwner.element();
      const current =
        publication && source
          ? exactFileDropKeyDelivery(
              event,
              publication,
              source,
              publication.keyboard.capturingPhase,
            )
          : null;
      if (
        !capturedRoot ||
        capturedOption ||
        bubbledOption ||
        !current ||
        !source ||
        capturedRoot.source !== source ||
        capturedRoot.sourceIndex !== optionAuthority.index ||
        !fileDropSameWrapperDeliveriesMatch(capturedRoot, current)
      ) {
        clearKeyboardAuthority();
        return;
      }
      capturedOption = current;
    };
    const onKeyDown = (
      event: ReactKeyboardEvent<HTMLButtonElement>,
    ) => {
      const publication = currentKeyboardPublication();
      const source = buttonOwner.element();
      const current =
        publication && source
          ? exactFileDropKeyDelivery(
              event,
              publication,
              source,
              publication.keyboard.bubblingPhase,
            )
          : null;
      if (
        !capturedRoot ||
        !capturedOption ||
        bubbledOption ||
        !current ||
        !source ||
        capturedRoot.source !== source ||
        capturedRoot.sourceIndex !== optionAuthority.index ||
        !fileDropSameWrapperDeliveriesMatch(
          capturedRoot,
          capturedOption,
        ) ||
        !fileDropDistinctWrapperDeliveriesMatch(
          capturedOption,
          current,
        )
      ) {
        clearKeyboardAuthority();
        return;
      }
      bubbledOption = current;
    };
    return Object.freeze({
      authority: optionAuthority,
      captureButton: buttonOwner.capture,
      buttonOwner,
      onClick,
      onKeyDownCapture,
      onKeyDown,
      movements,
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
    authority.description === fileDropDescription(authority.file) &&
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
    const buttons = optionPresentations.map(
      (presentation) => presentation.buttonOwner.element(),
    );
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
        const button = buttons[index];
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
    return valid
      ? {
          bridge,
          root,
          content,
          close,
          buttons: Object.freeze(buttons as HTMLButtonElement[]),
        }
      : null;
  };
  const owns = (publication: FileDropPublication) => {
    const dom = exactDom();
    return Boolean(
      dom &&
        factsAreCurrent() &&
        publication.authority === authority &&
        publication.content === dom.content &&
        publication.root === dom.root &&
        publication.ownerDocument === dom.root.ownerDocument &&
        publication.ownerWindow === dom.root.ownerDocument.defaultView &&
        publication.keyboard.isCurrent() &&
        publication.options.every(
          (option, index) =>
            option.authority === authority.options[index] &&
            option.owner ===
              optionPresentations[index]?.buttonOwner &&
            option.button === dom.buttons[index],
        ) &&
        coordinator.isCurrent(publication) &&
        !publication.isRetired() &&
        publication.publishedDomMatches(),
    );
  };
  function currentKeyboardPublication() {
    const publication = coordinator.active();
    if (
      !publication ||
      publication.authority !== authority ||
      latestAuthority() !== authority ||
      !owns(publication)
    ) {
      return null;
    }
    return publication;
  }
  const onRootKeyDownCapture = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    clearKeyboardAuthority();
    const publication = currentKeyboardPublication();
    if (!publication) return;
    const current = exactFileDropKeyDelivery(
      event,
      publication,
      publication.root,
      publication.keyboard.capturingPhase,
    );
    if (
      !current ||
      claimedFileDropNativeEvents.has(current.nativeEvent)
    ) {
      return;
    }
    capturedRoot = current;
    queueMicrotask(() => {
      if (capturedRoot === current) clearKeyboardAuthority();
    });
  };
  const onRootKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const rootCapture = capturedRoot;
    const optionCapture = capturedOption;
    const optionBubble = bubbledOption;
    const publication = currentKeyboardPublication();
    const rootBubble = publication
      ? exactFileDropKeyDelivery(
          event,
          publication,
          publication.root,
          publication.keyboard.bubblingPhase,
        )
      : null;
    clearKeyboardAuthority();
    if (
      !publication ||
      !rootCapture ||
      !optionCapture ||
      !optionBubble ||
      !rootBubble ||
      !fileDropSameWrapperDeliveriesMatch(
        rootCapture,
        optionCapture,
      ) ||
      !fileDropSameWrapperDeliveriesMatch(
        optionBubble,
        rootBubble,
      ) ||
      !fileDropDistinctWrapperDeliveriesMatch(
        optionCapture,
        optionBubble,
      ) ||
      rootCapture.snapshot.phase !==
        publication.keyboard.capturingPhase ||
      optionCapture.snapshot.phase !==
        publication.keyboard.capturingPhase ||
      optionBubble.snapshot.phase !==
        publication.keyboard.bubblingPhase ||
      rootBubble.snapshot.phase !== publication.keyboard.bubblingPhase ||
      rootCapture.currentTarget !== publication.root ||
      optionCapture.currentTarget !== optionCapture.source ||
      optionBubble.currentTarget !== optionBubble.source ||
      rootBubble.currentTarget !== publication.root ||
      !fileDropReactMethodsRemainFalse(rootCapture) ||
      !fileDropReactMethodsRemainFalse(optionCapture) ||
      !fileDropReactMethodsRemainFalse(optionBubble) ||
      !fileDropReactMethodsRemainFalse(rootBubble)
    ) {
      return;
    }
    const source = publication.options[rootCapture.sourceIndex];
    const sourcePresentation =
      optionPresentations[rootCapture.sourceIndex];
    const movement =
      sourcePresentation?.movements[rootCapture.key] ?? null;
    const destinationAuthority = movement?.destination ?? null;
    const destinationIndex = destinationAuthority?.index ?? -1;
    const destination = publication.options[destinationIndex];
    const destinationPresentation = optionPresentations[destinationIndex];
    const listener = rootBubble.listener;
    if (
      !source ||
      !sourcePresentation ||
      source.authority !== sourcePresentation.authority ||
      source.authority !== authority.options[rootCapture.sourceIndex] ||
      source.owner !== sourcePresentation.buttonOwner ||
      source.button !== rootCapture.source ||
      !publication.enabledOptions.includes(source) ||
      !movement ||
      movement.source !== source.authority ||
      movement.key !== rootCapture.key ||
      !destinationAuthority ||
      !destination ||
      !destinationPresentation ||
      destination.authority !== destinationAuthority ||
      destination.authority !== destinationPresentation.authority ||
      destination.owner !== destinationPresentation.buttonOwner ||
      destination.button === source.button ||
      destination.button.parentElement !== publication.root ||
      publication.root.children.item(destinationIndex) !==
        destination.button ||
      publication.root.childNodes.item(destinationIndex) !==
        destination.button ||
      !publication.enabledOptions.includes(destination) ||
      destination.button.disabled ||
      destination.button.matches(":disabled") ||
      publication.keyListener.proofFor(
        rootBubble.nativeEvent,
        publication,
        source.button,
      ) !== listener ||
      !publication.keyListener.claim(listener, publication)
    ) {
      return;
    }
    const claim: FileDropNavigationClaim = Object.freeze({
      publication,
      movement,
      captureWrapper: rootCapture.wrapper,
      bubbleWrapper: rootBubble.wrapper,
      nativeEvent: rootBubble.nativeEvent,
      listener,
      source: source.owner,
      destination: destination.owner,
    });
    if (
      !coordinator.claimNavigation(claim) ||
      !publication.keyListener.retains(listener, publication) ||
      !coordinator.retainsNavigation(claim) ||
      !owns(publication) ||
      source.owner.element() !== source.button ||
      destination.owner.element() !== destination.button ||
      !fileDropReactMethodsRemainFalse(rootCapture) ||
      !fileDropReactMethodsRemainFalse(rootBubble) ||
      publication.keyboard.apply(
        publication.keyboard.activeElement,
        publication.ownerDocument,
        [],
      ) !== source.button
    ) {
      return;
    }
    publication.keyboard.apply(
      rootBubble.methods.preventDefault,
      rootBubble.wrapper,
      [],
    );
    if (
      publication.keyboard.apply(
        publication.keyboard.event.defaultPrevented,
        rootBubble.nativeEvent,
        [],
      ) !== true ||
      !fileDropReactPreventionMatches(rootBubble) ||
      !publication.keyListener.retains(listener, publication) ||
      !coordinator.retainsNavigation(claim) ||
      !owns(publication) ||
      source.owner.element() !== source.button ||
      destination.owner.element() !== destination.button ||
      destination.button.disabled ||
      destination.button.matches(":disabled") ||
      publication.keyboard.apply(
        publication.keyboard.activeElement,
        publication.ownerDocument,
        [],
      ) !== source.button
    ) {
      return;
    }
    publication.keyboard.apply(
      publication.keyboard.focus,
      destination.button,
      [FILE_DROP_PREVENT_SCROLL],
    );
    if (
      publication.keyboard.apply(
        publication.keyboard.activeElement,
        publication.ownerDocument,
        [],
      ) === destination.button &&
      publication.keyListener.retains(listener, publication) &&
      coordinator.retainsNavigation(claim)
    ) {
      requestSuccessor();
    }
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
      dom.root,
      optionPresentations.map(({ buttonOwner }) => buttonOwner),
      dom.buttons,
      expectedOwners(),
      clearPublicationAuthority,
    );
    if (!runtime) return undefined;
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
    onRootKeyDownCapture,
    onRootKeyDown,
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
        description: fileDropDescription(pending.file),
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
  const onRootKeyDownCapture = presentation?.onRootKeyDownCapture;
  const onRootKeyDown = presentation?.onRootKeyDown;
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
      onKeyDownCapture={control.onKeyDownCapture}
      onKeyDown={control.onKeyDown}
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
                onKeyDownCapture={onRootKeyDownCapture}
                onKeyDown={onRootKeyDown}
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
