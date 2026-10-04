"use client";
import { Dialog, DialogContent, Spinner } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type Dispatch,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from "react";
import { signIn } from "next-auth/react";
import { Check, ExternalLink, FileText, GitBranch, Loader2, Lock, Search, Unlink } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import { api, apiErrorText } from "@/lib/api";

import { cn, relativeTime } from "@/lib/utils";
import { GITHUB_NOT_CONFIGURED } from "./labels";
import { GistAutoUpdateControl } from "./gist-auto-update";
import { useEnterOnRelease, usePlaceHold } from "./press-once";

type Tab = "gist" | "repo";
type PickerSourceNavigationKey =
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "Home"
  | "End";
type PickerSourceNavigationStage =
  | "group-capture"
  | "source-capture"
  | "source-bubble"
  | "group-bubble";

const PICKER_SOURCE_ORDER = Object.freeze(["gist", "repo"] as const);
const PICKER_SOURCE_LABEL = "GitHub source";
const PICKER_PREVENT_SCROLL = Object.freeze({ preventScroll: true });

const GITHUB_SIGN_IN_ROOT_CLASS =
  "flex flex-col items-center gap-3 rounded-xl border border-dashed border-line-2 p-6 text-center text-sm text-ink-3";
const GITHUB_SIGN_IN_BUTTON_CLASS = "btn btn-primary gap-2";
const GITHUB_SIGN_IN_COPY =
  "Gists and repositories need a GitHub account. You are signed in without one — sign in with GitHub to use them as storage.";
const GITHUB_SIGN_IN_LABEL = "Sign in with GitHub";
const GITHUB_ICON_PATH =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z";

const seenGitHubSignInNativeEvents = new WeakSet<object>();
const taintedGitHubSignInNativeEvents = new WeakSet<object>();

interface GitHubSignInOperation {
  readonly identity: symbol;
  readonly mount: symbol;
}

interface GitHubSignInRender {
  readonly identity: object;
  readonly mount: symbol;
  readonly revision: number;
  readonly githubConfigured: boolean;
  readonly redirectTo: string | undefined;
  readonly busyOperation: GitHubSignInOperation | null;
  readonly callback: typeof signIn;
  readonly action: object;
}

interface GitHubSignInDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly GitHubSignInDomSnapshot[];
}

interface GitHubSignInNodePlacement {
  readonly node: Node;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface GitHubSignInPlacement {
  readonly document: Document;
  readonly chain: readonly GitHubSignInNodePlacement[];
}

interface GitHubSignInDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface GitHubSignInElementOwnerView {
  readonly element: () => HTMLElement | null;
}

interface GitHubSignInRefReplay {
  readonly owner: GitHubSignInElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

interface GitHubSignInPublication {
  readonly render: GitHubSignInRender;
  readonly root: HTMLDivElement;
  readonly button: HTMLButtonElement;
  readonly ownerDocument: Document;
  readonly redirectTo: string;
  readonly callback: typeof signIn;
  readonly dom: GitHubSignInDomSnapshot;
  readonly placement: GitHubSignInPlacement;
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
  readonly isExact: () => boolean;
}

interface GitHubSignInReplay {
  readonly source: GitHubSignInPublication;
  readonly dom: GitHubSignInDomSnapshot;
  readonly placement: GitHubSignInPlacement;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
  readonly expectSuccessor: (identity: object) => void;
  readonly successorTransitionIsExact: (identity: object) => boolean;
}

interface GitHubSignInClickAdmission {
  readonly publication: GitHubSignInPublication;
  readonly nativeEvent: MouseEvent;
  readonly captureEvent: ReactMouseEvent<HTMLDivElement>;
  readonly target: Node;
  readonly root: HTMLDivElement;
  readonly button: HTMLButtonElement;
  readonly deliverBubble: (event: ReactMouseEvent<HTMLButtonElement>) => boolean;
  readonly bubbleEvent: () => ReactMouseEvent<HTMLButtonElement> | null;
  readonly rejectAdditional: (event: object) => void;
  readonly isExact: () => boolean;
}

interface GitHubSignInCells {
  readonly active: { current: GitHubSignInPublication | null };
  readonly successorOf: { current: GitHubSignInPublication | null };
  readonly replay: { current: GitHubSignInReplay | null };
  readonly operation: { current: GitHubSignInOperation | null };
  readonly disposed: { current: boolean };
  readonly claimedPublications: WeakSet<GitHubSignInPublication>;
  readonly claimedActions: WeakSet<object>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
  readonly clickAdmissions: WeakMap<Event, GitHubSignInClickAdmission>;
}

interface GitHubSignInPublicationRuntime {
  readonly publication: GitHubSignInPublication;
  readonly publish: () => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: GitHubSignInElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly replay: () => GitHubSignInReplay | null;
  readonly beginReplayHandoff: () => void;
  readonly claimActivation: () => boolean;
}

interface GitHubSignInPresentation {
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly captureButton: (element: HTMLButtonElement | null) => void;
  readonly prepareReplay: () => void;
  readonly establish: () => void | (() => void);
  readonly onRootClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

class GitHubSignInElementOwner<T extends HTMLElement>
  implements GitHubSignInElementOwnerView {
  #current: T | null = null;
  #last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: GitHubSignInElementOwnerView,
      element: HTMLElement | null,
      previous: HTMLElement | null,
      last: HTMLElement | null,
    ) => void,
  ) {}

  readonly element = () => this.#current;

  readonly capture = (element: T | null) => {
    if (element === this.#current) return;
    const previous = this.#current;
    const last = this.#last;
    this.#current = element;
    if (element) this.#last = element;
    this.onChange(this, element, previous, last);
  };
}

function snapshotGitHubSignInAttributes(
  node: Node,
): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotGitHubSignInDom(node: Node): GitHubSignInDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotGitHubSignInAttributes(node),
    children: Object.freeze(
      [...node.childNodes].map(snapshotGitHubSignInDom),
    ),
  });
}

function githubSignInDomMatches(snapshot: GitHubSignInDomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = snapshotGitHubSignInAttributes(node);
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
    node.childNodes.length === snapshot.children.length &&
    snapshot.children.every(
      (child, index) =>
        node.childNodes.item(index) === child.node &&
        githubSignInDomMatches(child),
    )
  );
}

function githubSignInSnapshotContains(
  snapshot: GitHubSignInDomSnapshot,
  node: Node,
): boolean {
  return (
    snapshot.node === node ||
    snapshot.children.some((child) =>
      githubSignInSnapshotContains(child, node),
    )
  );
}

function captureGitHubSignInPlacement(
  root: HTMLDivElement,
): GitHubSignInPlacement | null {
  if (!root.isConnected) return null;
  const ownerDocument = root.ownerDocument;
  const chain: GitHubSignInNodePlacement[] = [];
  let node: Node = root;
  while (node !== ownerDocument) {
    const parent = node.parentNode;
    if (!parent) return null;
    chain.push(
      Object.freeze({
        node,
        parent,
        previousSibling: node.previousSibling,
        nextSibling: node.nextSibling,
      }),
    );
    node = parent;
  }
  return chain.length > 0
    ? Object.freeze({
        document: ownerDocument,
        chain: Object.freeze(chain),
      })
    : null;
}

function githubSignInPlacementMatches(
  root: HTMLDivElement,
  placement: GitHubSignInPlacement,
): boolean {
  return (
    root.isConnected &&
    root.ownerDocument === placement.document &&
    placement.chain[0]?.node === root &&
    placement.chain.every(
      (entry) =>
        entry.node.parentNode === entry.parent &&
        entry.node.previousSibling === entry.previousSibling &&
        entry.node.nextSibling === entry.nextSibling,
    )
  );
}

function githubSignInPlacementChanged(
  record: MutationRecord,
  entry: GitHubSignInNodePlacement,
): boolean {
  if (record.type !== "childList" || record.target !== entry.parent) {
    return false;
  }
  if (
    record.previousSibling === entry.node ||
    record.nextSibling === entry.node
  ) {
    return true;
  }
  return [...record.addedNodes, ...record.removedNodes].some(
    (node) => node === entry.node || node.contains(entry.node),
  );
}

function createGitHubSignInDomGuard(
  root: HTMLDivElement,
  placement: GitHubSignInPlacement,
  onMutation: () => void,
): GitHubSignInDomGuard | null {
  const Observer = placement.document.defaultView?.MutationObserver;
  if (typeof Observer !== "function") return null;

  let changed = false;
  let released = false;
  let observer: MutationObserver;
  let observe: MutationObserver["observe"];
  let takeRecords: MutationObserver["takeRecords"];
  let disconnect: MutationObserver["disconnect"];
  const placementNodes = new Set(placement.chain.map(({ node }) => node));
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed || released) return;
    changed = records.some(
      (record) =>
        record.target === root ||
        root.contains(record.target) ||
        (record.type === "attributes" && placementNodes.has(record.target)) ||
        placement.chain.some((entry) =>
          githubSignInPlacementChanged(record, entry),
        ),
    );
    if (changed) onMutation();
  };

  try {
    observer = new Observer(recordChanges);
    observe = observer.observe;
    takeRecords = observer.takeRecords;
    disconnect = observer.disconnect;
    if (
      typeof observe !== "function" ||
      typeof takeRecords !== "function" ||
      typeof disconnect !== "function"
    ) {
      return null;
    }
    Reflect.apply(observe, observer, [
      root,
      {
        attributeOldValue: true,
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      },
    ]);
    const observedParents = new Set<Node>(
      placement.chain.map(({ parent }) => parent),
    );
    for (const parent of observedParents) {
      const observeAttributes =
        placementNodes.has(parent) &&
        parent.nodeType ===
          placement.document.defaultView?.Node.ELEMENT_NODE;
      Reflect.apply(observe, observer, [
        parent,
        observeAttributes
          ? {
              attributeOldValue: true,
              attributes: true,
              childList: true,
            }
          : { childList: true },
      ]);
    }
    for (const entry of placement.chain) {
      if (
        entry.node !== root &&
        !observedParents.has(entry.node) &&
        entry.node.nodeType === placement.document.defaultView?.Node.ELEMENT_NODE
      ) {
        Reflect.apply(observe, observer, [
          entry.node,
          { attributeOldValue: true, attributes: true },
        ]);
      }
    }
  } catch {
    try {
      if (typeof disconnect! === "function") {
        Reflect.apply(disconnect!, observer!, []);
      }
    } catch {
      // A poisoned observer is never admitted as publication authority.
    }
    return null;
  }

  const readRecords = () => {
    if (released || changed) return !changed;
    try {
      recordChanges(Reflect.apply(takeRecords, observer, []));
    } catch {
      changed = true;
      onMutation();
    }
    return !changed;
  };
  return Object.freeze({
    isClean: readRecords,
    release: () => {
      if (released) return;
      readRecords();
      released = true;
      try {
        Reflect.apply(disconnect, observer, []);
      } catch {
        // The captured control is already retired even if a poisoned primitive cannot disconnect.
      }
    },
  });
}

function githubSignInIconIsExact(
  icon: Element,
  parent: HTMLElement,
  size: number,
  className: string | null,
): boolean {
  const path = icon.firstElementChild;
  return (
    icon.localName === "svg" &&
    icon.parentElement === parent &&
    icon.getAttribute("viewBox") === "0 0 16 16" &&
    icon.getAttribute("width") === String(size) &&
    icon.getAttribute("height") === String(size) &&
    icon.getAttribute("fill") === "currentColor" &&
    icon.getAttribute("class") === className &&
    icon.getAttribute("aria-hidden") === "true" &&
    icon.children.length === 1 &&
    icon.childNodes.length === 1 &&
    path?.localName === "path" &&
    path.getAttribute("d") === GITHUB_ICON_PATH
  );
}

function githubSignInEffectivelyEnabled(button: HTMLButtonElement): boolean {
  if (
    button.disabled ||
    button.matches(":disabled") ||
    button.hidden ||
    button.getAttribute("aria-disabled")?.toLowerCase() === "true"
  ) {
    return false;
  }
  for (
    let element: HTMLElement | null = button;
    element;
    element = element.parentElement
  ) {
    if (
      element.hidden ||
      element.hasAttribute("inert") ||
      element.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
      element.getAttribute("aria-disabled")?.toLowerCase() === "true"
    ) {
      return false;
    }
  }
  return true;
}

function githubSignInDomIsExact(
  render: GitHubSignInRender,
  root: HTMLDivElement | null,
  button: HTMLButtonElement | null,
): boolean {
  const ownerWindow = root?.ownerDocument.defaultView;
  const rootIcon = root?.children.item(0);
  const copy = root?.children.item(1);
  const buttonIcon = button?.children.item(0);
  return Boolean(
    render.githubConfigured &&
      render.busyOperation === null &&
      ownerWindow &&
      root instanceof ownerWindow.HTMLDivElement &&
      button instanceof ownerWindow.HTMLButtonElement &&
      root.isConnected &&
      button.isConnected &&
      root.ownerDocument === button.ownerDocument &&
      root.tagName === "DIV" &&
      root.className === GITHUB_SIGN_IN_ROOT_CLASS &&
      root.dataset.testid === "github-signin-prompt" &&
      root.children.length === 3 &&
      root.childNodes.length === 3 &&
      rootIcon instanceof ownerWindow.SVGSVGElement &&
      githubSignInIconIsExact(rootIcon, root, 24, "text-ink-4") &&
      copy instanceof ownerWindow.HTMLParagraphElement &&
      copy.parentElement === root &&
      copy.textContent === GITHUB_SIGN_IN_COPY &&
      copy.childNodes.length === 1 &&
      copy.firstChild?.nodeType === ownerWindow.Node.TEXT_NODE &&
      root.children.item(2) === button &&
      root.childNodes.item(2) === button &&
      button.parentElement === root &&
      button.tagName === "BUTTON" &&
      button.type === "button" &&
      button.getAttribute("type") === "button" &&
      button.className === GITHUB_SIGN_IN_BUTTON_CLASS &&
      button.dataset.testid === "github-signin" &&
      githubSignInEffectivelyEnabled(button) &&
      button.children.length === 1 &&
      button.childNodes.length === 2 &&
      buttonIcon instanceof ownerWindow.SVGSVGElement &&
      githubSignInIconIsExact(buttonIcon, button, 16, null) &&
      button.childNodes.item(1)?.nodeType === ownerWindow.Node.TEXT_NODE &&
      button.childNodes.item(1)?.nodeValue === ` ${GITHUB_SIGN_IN_LABEL}` &&
      button.textContent?.trim() === GITHUB_SIGN_IN_LABEL &&
      root.querySelectorAll("button").length === 1,
  );
}

function githubSignInRendersMatch(
  previous: GitHubSignInRender,
  current: GitHubSignInRender,
): boolean {
  return (
    previous.mount === current.mount &&
    previous.githubConfigured === current.githubConfigured &&
    previous.redirectTo === current.redirectTo &&
    previous.busyOperation === current.busyOperation &&
    previous.callback === current.callback
  );
}

function exactGitHubSignInReactClick(
  event: ReactMouseEvent<Element>,
  nativeEvent: MouseEvent,
  currentTarget: Element,
  target: Node,
  phase: number,
): boolean {
  try {
    const reactEvent = event as ReactMouseEvent<Element> & {
      _reactName?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
      persist?: unknown;
    };
    return (
      event.nativeEvent === nativeEvent &&
      event.type === "click" &&
      nativeEvent.type === "click" &&
      event.currentTarget === currentTarget &&
      event.target === target &&
      nativeEvent.target === target &&
      event.button === 0 &&
      nativeEvent.button === 0 &&
      event.buttons === nativeEvent.buttons &&
      event.altKey === nativeEvent.altKey &&
      event.ctrlKey === nativeEvent.ctrlKey &&
      event.metaKey === nativeEvent.metaKey &&
      event.shiftKey === nativeEvent.shiftKey &&
      event.clientX === nativeEvent.clientX &&
      event.clientY === nativeEvent.clientY &&
      event.detail === nativeEvent.detail &&
      event.bubbles &&
      nativeEvent.bubbles &&
      event.cancelable === nativeEvent.cancelable &&
      event.eventPhase === nativeEvent.eventPhase &&
      nativeEvent.eventPhase === phase &&
      event.isTrusted === nativeEvent.isTrusted &&
      event.timeStamp === nativeEvent.timeStamp &&
      !event.defaultPrevented &&
      !nativeEvent.defaultPrevented &&
      reactEvent._reactName === "onClick" &&
      typeof event.preventDefault === "function" &&
      typeof event.stopPropagation === "function" &&
      typeof reactEvent.isDefaultPrevented === "function" &&
      !reactEvent.isDefaultPrevented() &&
      typeof reactEvent.isPropagationStopped === "function" &&
      !reactEvent.isPropagationStopped() &&
      typeof reactEvent.persist === "function"
    );
  } catch {
    return false;
  }
}

function createGitHubSignInClickAdmission(
  publication: GitHubSignInPublication,
  nativeEvent: MouseEvent,
  event: ReactMouseEvent<HTMLDivElement>,
  target: Node,
): GitHubSignInClickAdmission {
  let delivered: ReactMouseEvent<HTMLButtonElement> | null = null;
  let invalid = false;
  return Object.freeze({
    publication,
    nativeEvent,
    captureEvent: event,
    target,
    root: publication.root,
    button: publication.button,
    deliverBubble: (candidate: ReactMouseEvent<HTMLButtonElement>) => {
      if (delivered || (candidate as object) === (event as object)) {
        invalid = true;
        return false;
      }
      delivered = candidate;
      return true;
    },
    bubbleEvent: () => delivered,
    rejectAdditional: (candidate: object) => {
      if (candidate !== event || delivered) invalid = true;
    },
    isExact: () =>
      !invalid &&
      delivered !== null &&
      event.currentTarget === null &&
      delivered.currentTarget === null,
  });
}

function settleGitHubSignInFailure(
  cells: GitHubSignInCells,
  operation: GitHubSignInOperation,
  setBusyOperation: Dispatch<
    SetStateAction<GitHubSignInOperation | null>
  >,
) {
  if (
    cells.disposed.current ||
    cells.operation.current !== operation
  ) {
    return;
  }
  cells.operation.current = null;
  setBusyOperation((current) => (current === operation ? null : current));
}

function watchGitHubSignInFailure(
  pending: PromiseLike<unknown>,
  cells: GitHubSignInCells,
  operation: GitHubSignInOperation,
  setBusyOperation: Dispatch<
    SetStateAction<GitHubSignInOperation | null>
  >,
) {
  void Promise.resolve(pending).then(
    () => undefined,
    () => settleGitHubSignInFailure(cells, operation, setBusyOperation),
  );
}

function createGitHubSignInPresentation(
  render: GitHubSignInRender,
  cells: GitHubSignInCells,
  requestSuccessor: () => void,
  setBusyOperation: Dispatch<
    SetStateAction<GitHubSignInOperation | null>
  >,
): GitHubSignInPresentation {
  let currentRuntime: GitHubSignInPublicationRuntime | null = null;
  let lastRuntime: GitHubSignInPublicationRuntime | null = null;
  let successorRequested = false;

  const onElementChange = (
    owner: GitHubSignInElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (
      element === null ||
      (element !== null && last !== null && element !== last)
    ) {
      currentRuntime?.retireForElement();
    }
    if (
      runtime?.isExactElementReplay() &&
      cells.successorOf.current === runtime.publication
    ) {
      requestReplaySuccessor(runtime);
    }
  };
  const rootOwner = new GitHubSignInElementOwner<HTMLDivElement>(
    onElementChange,
  );
  const buttonOwner = new GitHubSignInElementOwner<HTMLButtonElement>(
    onElementChange,
  );
  const expectedOwners = (): readonly GitHubSignInElementOwnerView[] => [
    rootOwner,
    buttonOwner,
  ];

  const factsAreCurrent = () =>
    !cells.disposed.current &&
    render.callback === signIn &&
    render.githubConfigured &&
    render.busyOperation === null &&
    cells.operation.current === null;

  const createRuntime = (
    root: HTMLDivElement,
    button: HTMLButtonElement,
    placement: GitHubSignInPlacement,
    redirectTo: string,
  ): GitHubSignInPublicationRuntime => {
    type Retirement = "element" | "layout" | "mutation" | "other";
    const dom = snapshotGitHubSignInDom(root);
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let invalidReplay = false;
    let activationClaimed = false;
    let replayHandedOff = false;
    let replayHandoffInvalid = false;
    let expectedSuccessor: object | null = null;
    let replayRefs: GitHubSignInRefReplay[] = [];
    let guard: GitHubSignInDomGuard | null = null;
    let removeNativeListener: (() => void) | null = null;

    const publishedDomMatches = () =>
      Boolean(
        guard &&
          guard.isClean() &&
          rootOwner.element() === root &&
          buttonOwner.element() === button &&
          root === dom.node &&
          githubSignInPlacementMatches(root, placement) &&
          githubSignInDomMatches(dom),
      );
    const retire = (reason: Retirement) => {
      if (retired) return false;
      retired = true;
      retirement = reason;
      removeNativeListener?.();
      removeNativeListener = null;
      if (cells.active.current === publication) {
        cells.active.current = null;
        cells.successorOf.current =
          !cells.claimedPublications.has(publication) &&
          (reason === "element" || reason === "layout")
            ? publication
            : null;
      }
      if (currentRuntime?.publication === publication) currentRuntime = null;
      if (cells.successorOf.current !== publication) {
        guard?.release();
        guard = null;
        return true;
      }
      queueMicrotask(() => {
        if (cells.replay.current?.source !== publication) {
          if (cells.successorOf.current === publication) {
            cells.successorOf.current = null;
          }
          guard?.release();
          guard = null;
        }
      });
      return true;
    };
    const publication: GitHubSignInPublication = Object.freeze({
      render,
      root,
      button,
      ownerDocument: root.ownerDocument,
      redirectTo,
      callback: render.callback,
      dom,
      placement,
      retire: () => retire("other"),
      isRetired: () => retired,
      isExact: () => {
        if (retired) return false;
        let exact = false;
        try {
          exact =
            currentRuntime?.publication === publication &&
            cells.active.current === publication &&
            publication.render === render &&
            publication.callback === signIn &&
            publication.ownerDocument === root.ownerDocument &&
            publication.ownerDocument.defaultView !== null &&
            factsAreCurrent() &&
            githubSignInDomIsExact(render, root, button) &&
            publishedDomMatches();
        } catch {
          exact = false;
        }
        if (!exact) retire("other");
        return exact;
      },
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
      replayRefs.length > 0 &&
      replayRefs.every(
        (entry) =>
          entry.detached &&
          entry.reattached &&
          entry.owner.element() === entry.element,
      );

    const runtime: GitHubSignInPublicationRuntime = Object.freeze({
      publication,
      publish: () => {
        established = true;
        replayRefs = expectedOwners().map((owner) => {
          const element = owner.element();
          if (!element) {
            throw new Error(
              "Cannot publish GitHubSignInPrompt without every committed ref",
            );
          }
          return { owner, element, detached: false, reattached: false };
        });
        guard = createGitHubSignInDomGuard(
          root,
          placement,
          () => retire("mutation"),
        );
        if (!guard) return false;
        const activeGuard = guard;

        try {
          const add = publication.ownerDocument.addEventListener;
          const remove = publication.ownerDocument.removeEventListener;
          if (typeof add !== "function" || typeof remove !== "function") {
            activeGuard.release();
            guard = null;
            return false;
          }
          Reflect.apply(add, publication.ownerDocument, [
            "click",
            completeNativeClick,
          ]);
          removeNativeListener = () => {
            try {
              Reflect.apply(remove, publication.ownerDocument, [
                "click",
                completeNativeClick,
              ]);
            } catch {
              // The publication is already inert even if listener removal was poisoned.
            }
          };
        } catch {
          activeGuard.release();
          guard = null;
          return false;
        }

        const previous = cells.active.current;
        if (previous && previous !== publication) previous.retire();
        cells.active.current = publication;
        cells.successorOf.current = null;
        cells.replay.current = null;
        return true;
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        layoutRetired = true;
        retire("layout");
      },
      noteRef: (
        owner: GitHubSignInElementOwnerView,
        element: HTMLElement | null,
        previous: HTMLElement | null,
      ) => {
        if (!established) return;
        if (replayHandedOff && element !== null) {
          replayHandoffInvalid = true;
        }
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
      },
      isExactElementReplay: () =>
        retired &&
        retirement === "element" &&
        layoutRetired &&
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
        guard
          ? Object.freeze({
              source: publication,
              dom,
              placement,
              historyIsClean: guard.isClean,
              release: guard.release,
              expectSuccessor: (identity: object) => {
                expectedSuccessor = identity;
              },
              successorTransitionIsExact: (identity: object) =>
                replayHandedOff &&
                !replayHandoffInvalid &&
                expectedSuccessor === identity &&
                replayRefs.every(
                  (entry) =>
                    entry.detached &&
                    !entry.reattached &&
                    entry.owner.element() === null,
                ),
            })
          : null,
      beginReplayHandoff: () => {
        replayHandedOff = true;
      },
      claimActivation: () => {
        if (activationClaimed) return false;
        activationClaimed = true;
        return true;
      },
    });

    function completeNativeClick(event: Event) {
      const admission = cells.clickAdmissions.get(event);
      cells.clickAdmissions.delete(event);
      if (!admission) return;
      const activeRuntime = currentRuntime;
      const activePublication = activeRuntime?.publication;
      const bubbleEvent = admission.bubbleEvent();
      const ownerWindow = publication.ownerDocument.defaultView;
      const target = event.target;
      let exact = false;
      try {
        exact = Boolean(
          activeRuntime &&
            activePublication === publication &&
            admission.publication === publication &&
            admission.nativeEvent === event &&
            admission.root === root &&
            admission.button === button &&
            admission.target === target &&
            admission.isExact() &&
            ownerWindow &&
            event instanceof ownerWindow.MouseEvent &&
            event.type === "click" &&
            event.button === 0 &&
            event.bubbles &&
            !event.defaultPrevented &&
            event.currentTarget === publication.ownerDocument &&
            event.eventPhase === ownerWindow.Event.BUBBLING_PHASE &&
            target instanceof ownerWindow.Node &&
            target.ownerDocument === publication.ownerDocument &&
            button.contains(target) &&
            event.composedPath().includes(root) &&
            event.composedPath().includes(button) &&
            githubSignInSnapshotContains(dom, target) &&
            seenGitHubSignInNativeEvents.has(event) &&
            !taintedGitHubSignInNativeEvents.has(event) &&
            !cells.claimedPublications.has(publication) &&
            !cells.claimedActions.has(render.action) &&
            !cells.claimedReactEvents.has(admission.captureEvent) &&
            bubbleEvent &&
            !cells.claimedReactEvents.has(bubbleEvent) &&
            !cells.claimedNativeEvents.has(event) &&
            publication.isExact() &&
            activeRuntime.claimActivation(),
        );
      } catch {
        exact = false;
      }
      if (!exact || !bubbleEvent) {
        if (event && typeof event === "object") {
          taintedGitHubSignInNativeEvents.add(event);
        }
        return;
      }

      cells.claimedPublications.add(publication);
      cells.claimedActions.add(render.action);
      cells.claimedReactEvents.add(admission.captureEvent);
      cells.claimedReactEvents.add(bubbleEvent);
      cells.claimedNativeEvents.add(event);
      const operation: GitHubSignInOperation = Object.freeze({
        identity: Symbol("github-sign-in-operation"),
        mount: render.mount,
      });
      cells.operation.current = operation;
      publication.retire();
      setBusyOperation(operation);

      let pending: PromiseLike<unknown>;
      try {
        pending = publication.callback("github", {
          redirectTo: publication.redirectTo,
        });
      } catch {
        settleGitHubSignInFailure(cells, operation, setBusyOperation);
        return;
      }
      watchGitHubSignInFailure(
        pending,
        cells,
        operation,
        setBusyOperation,
      );
    }

    return runtime;
  };

  const requestReplaySuccessor = (
    runtime: GitHubSignInPublicationRuntime,
  ) => {
    const replay = runtime.replay();
    if (
      successorRequested ||
      !replay ||
      cells.disposed.current ||
      cells.successorOf.current !== runtime.publication ||
      cells.claimedPublications.has(runtime.publication) ||
      !factsAreCurrent() ||
      !githubSignInDomIsExact(
        render,
        rootOwner.element() as HTMLDivElement | null,
        buttonOwner.element() as HTMLButtonElement | null,
      ) ||
      !replay.historyIsClean()
    ) {
      return;
    }
    successorRequested = true;
    runtime.beginReplayHandoff();
    cells.replay.current = replay;
    requestSuccessor();
  };

  const prepareReplay = () => {
    const replay = cells.replay.current;
    if (
      replay &&
      githubSignInRendersMatch(replay.source.render, render)
    ) {
      replay.expectSuccessor(render.identity);
    }
  };

  const establish = () => {
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() ||
          lastRuntime.isExactElementReplay()) &&
        cells.successorOf.current === lastRuntime.publication
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (!factsAreCurrent()) return undefined;

    const root = rootOwner.element();
    const button = buttonOwner.element();
    if (!githubSignInDomIsExact(render, root as HTMLDivElement | null, button as HTMLButtonElement | null)) {
      return undefined;
    }
    if (!root || !button) return undefined;
    const placement = captureGitHubSignInPlacement(root);
    const ownerWindow = root.ownerDocument.defaultView;
    let redirectTo: string;
    try {
      if (
        !placement ||
        !ownerWindow ||
        typeof ownerWindow.MouseEvent !== "function" ||
        typeof ownerWindow.Node !== "function" ||
        typeof ownerWindow.Event !== "function"
      ) {
        return undefined;
      }
      redirectTo = render.redirectTo ?? ownerWindow.location.href;
    } catch {
      return undefined;
    }

    const replay = cells.replay.current;
    if (replay) {
      const sameRender = githubSignInRendersMatch(
        replay.source.render,
        render,
      );
      let exactReplay = false;
      try {
        exactReplay =
          sameRender &&
          replay.source.isRetired() &&
          cells.successorOf.current === replay.source &&
          replay.successorTransitionIsExact(render.identity) &&
          replay.historyIsClean() &&
          root === replay.dom.node &&
          githubSignInPlacementMatches(root, replay.placement) &&
          githubSignInDomMatches(replay.dom);
      } catch {
        exactReplay = false;
      }
      cells.replay.current = null;
      replay.release();
      if (cells.successorOf.current === replay.source) {
        cells.successorOf.current = null;
      }
      if (sameRender && !exactReplay) return undefined;
    }

    const runtime = createRuntime(root, button, placement, redirectTo);
    currentRuntime = runtime;
    lastRuntime = runtime;
    if (!runtime.publish()) {
      runtime.retireForElement();
      currentRuntime = null;
      return undefined;
    }
    return runtime.retireForLayout;
  };

  const taint = (event: ReactMouseEvent<Element> | null | undefined) => {
    try {
      const nativeEvent = event?.nativeEvent;
      if (nativeEvent && typeof nativeEvent === "object") {
        taintedGitHubSignInNativeEvents.add(nativeEvent);
      }
    } catch {
      // Fabricated wrappers are rejected without consulting more of their surface.
    }
  };

  const onRootClickCapture = (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const root = rootOwner.element();
    const button = buttonOwner.element();
    const ownerWindow = publication?.ownerDocument.defaultView;
    let nativeEvent: Event | null = null;
    let target: EventTarget | null = null;
    try {
      nativeEvent = event?.nativeEvent ?? null;
      target = event?.target ?? null;
    } catch {
      taint(event);
      return;
    }
    if (
      publication &&
      ownerWindow &&
      nativeEvent instanceof ownerWindow.MouseEvent &&
      target instanceof ownerWindow.Node &&
      button?.contains(target)
    ) {
      if (
        seenGitHubSignInNativeEvents.has(nativeEvent) ||
        taintedGitHubSignInNativeEvents.has(nativeEvent)
      ) {
        taintedGitHubSignInNativeEvents.add(nativeEvent);
        return;
      }
      seenGitHubSignInNativeEvents.add(nativeEvent);
    }

    let exact = false;
    try {
      exact = Boolean(
        runtime &&
          publication &&
          root &&
          button &&
          ownerWindow &&
          nativeEvent instanceof ownerWindow.MouseEvent &&
          target instanceof ownerWindow.Node &&
          event.currentTarget === root &&
          publication.render === render &&
          cells.active.current === publication &&
          target.ownerDocument === publication.ownerDocument &&
          button.contains(target) &&
          nativeEvent.composedPath().includes(root) &&
          nativeEvent.composedPath().includes(button) &&
          githubSignInSnapshotContains(publication.dom, target) &&
          exactGitHubSignInReactClick(
            event,
            nativeEvent,
            root,
            target,
            ownerWindow.Event.CAPTURING_PHASE,
          ) &&
          publication.isExact(),
      );
    } catch {
      exact = false;
    }
    if (
      !exact ||
      !publication ||
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      !(target instanceof ownerWindow.Node)
    ) {
      taint(event);
      return;
    }

    const existing = cells.clickAdmissions.get(nativeEvent);
    if (existing) {
      existing.rejectAdditional(event);
      taintedGitHubSignInNativeEvents.add(nativeEvent);
      return;
    }
    cells.clickAdmissions.set(
      nativeEvent,
      createGitHubSignInClickAdmission(
        publication,
        nativeEvent,
        event,
        target,
      ),
    );
  };

  const onClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    let nativeEvent: Event | null = null;
    let target: EventTarget | null = null;
    try {
      nativeEvent = event?.nativeEvent ?? null;
      target = event?.target ?? null;
    } catch {
      taint(event);
      return;
    }
    const ownerWindow = currentRuntime?.publication.ownerDocument.defaultView;
    const admission =
      ownerWindow && nativeEvent instanceof ownerWindow.Event
        ? cells.clickAdmissions.get(nativeEvent)
        : undefined;
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const button = buttonOwner.element();
    const publicationWindow = publication?.ownerDocument.defaultView;
    let exact = false;
    try {
      exact = Boolean(
        admission &&
          runtime &&
          publication &&
          button &&
          publicationWindow &&
          nativeEvent instanceof publicationWindow.MouseEvent &&
          target instanceof publicationWindow.Node &&
          admission.publication === publication &&
          admission.nativeEvent === nativeEvent &&
          admission.target === target &&
          admission.root === publication.root &&
          admission.button === button &&
          publication.render === render &&
          cells.active.current === publication &&
          target.ownerDocument === publication.ownerDocument &&
          button.contains(target) &&
          exactGitHubSignInReactClick(
            event,
            nativeEvent,
            button,
            target,
            publicationWindow.Event.BUBBLING_PHASE,
          ) &&
          publication.isExact() &&
          admission.deliverBubble(event),
      );
    } catch {
      exact = false;
    }
    if (!exact) {
      admission?.rejectAdditional(event);
      taint(event);
    }
  };

  return Object.freeze({
    captureRoot: rootOwner.capture,
    captureButton: buttonOwner.capture,
    prepareReplay,
    establish,
    onRootClickCapture,
    onClick,
  });
}

function disposeGitHubSignInCells(cells: GitHubSignInCells) {
  cells.disposed.current = true;
  cells.operation.current = null;
  const active = cells.active.current;
  cells.active.current = null;
  active?.retire();
  const replay = cells.replay.current;
  cells.replay.current = null;
  replay?.release();
  cells.successorOf.current = null;
}

/**
 * Empty state of the GitHub picker for an account without a GitHub token (#162): the action the
 * sentence names, or why there is none. `redirectTo` defaults to the page the user is on.
 */
export function GitHubSignInPrompt({ githubConfigured, redirectTo }: { githubConfigured: boolean; redirectTo?: string }) {
  const [mount] = useState(() => Symbol("github-sign-in-prompt"));
  const [cells] = useState<GitHubSignInCells>(() => ({
    active: { current: null },
    successorOf: { current: null },
    replay: { current: null },
    operation: { current: null },
    disposed: { current: false },
    claimedPublications: new WeakSet(),
    claimedActions: new WeakSet(),
    claimedReactEvents: new WeakSet(),
    claimedNativeEvents: new WeakSet(),
    clickAdmissions: new WeakMap(),
  }));
  const [revision, setRevision] = useState(0);
  const [busyOperation, setBusyOperation] = useState<GitHubSignInOperation | null>(null);
  const requestSuccessor = useCallback(() => {
    setRevision((current) => current + 1);
  }, []);
  const render = Object.freeze<GitHubSignInRender>({
    identity: Object.freeze({}),
    mount,
    revision,
    githubConfigured,
    redirectTo,
    busyOperation,
    callback: signIn,
    action: Object.freeze({ identity: Symbol("github-sign-in-action") }),
  });
  const presentation = createGitHubSignInPresentation(
    render,
    cells,
    requestSuccessor,
    setBusyOperation,
  );

  useInsertionEffect(
    () => () => disposeGitHubSignInCells(cells),
    [cells],
  );
  useInsertionEffect(() => presentation.prepareReplay(), [presentation]);
  useLayoutEffect(() => presentation.establish(), [presentation]);

  const busy = busyOperation !== null;
  const {
    captureRoot,
    captureButton,
    onRootClickCapture,
    onClick,
  } = presentation;
  return (
    <div
      ref={captureRoot}
      className={GITHUB_SIGN_IN_ROOT_CLASS}
      data-testid="github-signin-prompt"
      onClickCapture={onRootClickCapture}
    >
      <GitHubIcon className="text-ink-4" size={24} />
      {githubConfigured ? (
        <>
          <p>{GITHUB_SIGN_IN_COPY}</p>
          <button
            ref={captureButton}
            type="button"
            className={GITHUB_SIGN_IN_BUTTON_CLASS}
            disabled={busy}
            onClick={onClick}
            data-testid="github-signin"
          >
            {busy ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <GitHubIcon size={16} />
            )} Sign in with GitHub
          </button>
        </>
      ) : (
        <p data-testid="github-not-configured">
          {GITHUB_NOT_CONFIGURED} Gists and repositories become available once the administrator sets <code className="font-mono text-xs">AUTH_GITHUB_ID</code> and{" "}
          <code className="font-mono text-xs">AUTH_GITHUB_SECRET</code>.
        </p>
      )}
    </div>
  );
}

interface GistItem {
  id: string;
  description: string | null;
  public: boolean;
  updatedAt: string;
  htmlUrl: string;
  files: { filename: string; language: string | null; size: number }[];
}
interface RepoItem {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  htmlUrl: string;
  description: string | null;
}

interface GitHubPickerProps {
  mode: "link" | "import";
  doc?: DocumentDto;
  onLinked?: (doc: DocumentDto) => void;
  onImported?: (docId: string) => void;
  /** The signed-in account has a GitHub token. */
  githubAvailable: boolean;
  /** The server has a GitHub OAuth app, so "Sign in with GitHub" can work. */
  githubConfigured: boolean;
}

type GitHubPickerAction =
  | Readonly<{ kind: "gist-import"; payload: Readonly<{ source: "gist"; gistId?: string; filename?: string }> }>
  | Readonly<{ kind: "gist-link"; payload: Readonly<{ storage: "gist"; gistId?: string; filename: string; isPublic: boolean; description: string }> }>
  | Readonly<{ kind: "repo-import"; payload: Readonly<{ source: "repo"; owner: string; repo: string; branch: string; path: string }> }>
  | Readonly<{ kind: "repo-link"; payload: Readonly<{ storage: "repo"; owner: string; repo: string; branch: string; path: string }> }>;

interface GitHubPickerOperation {
  readonly id: number;
  readonly visit: number;
  readonly mode: GitHubPickerProps["mode"];
  readonly documentId: string | null;
  readonly action: GitHubPickerAction;
}

let githubPickerVisitSequence = 0;
let githubPickerOperationSequence = 0;

interface ListLoadState<T> {
  items: T[] | null;
  error: string | null;
  pending: boolean;
}

type ListLoadAuthority =
  | Readonly<{ kind: "gists"; visit: number }>
  | Readonly<{ kind: "repositories"; visit: number }>
  | Readonly<{ kind: "branches"; visit: number; owner: string; repo: string; fullName: string }>
  | Readonly<{ kind: "files"; visit: number; owner: string; repo: string; fullName: string; branch: string }>;

interface ListRequestOwner {
  readonly authority: ListLoadAuthority;
  readonly token: symbol;
}

function initialListLoadState<T>(): ListLoadState<T> {
  return { items: null, error: null, pending: false };
}

function listLoadErrorText(error: unknown, fallback: string): string {
  const reason = apiErrorText(error, "");
  return reason ? `${fallback} ${reason}` : fallback;
}

function useListLoad<T>(authority: ListLoadAuthority | null) {
  const [state, setState] = useState<ListLoadState<T>>(initialListLoadState);
  const authorityRef = useRef<ListLoadAuthority | null>(null);
  const requestOwnerRef = useRef<ListRequestOwner | null>(null);

  useLayoutEffect(() => {
    authorityRef.current = authority;
    if (requestOwnerRef.current?.authority !== authority) {
      requestOwnerRef.current = null;
      setState((current) => (current.pending ? initialListLoadState<T>() : current));
    }
    return () => {
      if (authorityRef.current === authority) authorityRef.current = null;
      if (requestOwnerRef.current?.authority === authority) requestOwnerRef.current = null;
    };
  }, [authority]);

  const load = useCallback(
    (request: () => Promise<T[]>, fallback: string) => {
      if (!authority || authorityRef.current !== authority || requestOwnerRef.current) return;
      const owner: ListRequestOwner = { authority, token: Symbol(authority.kind) };
      requestOwnerRef.current = owner;
      setState((current) => ({ ...current, pending: true }));
      const ownsRequest = () => authorityRef.current === authority && requestOwnerRef.current === owner;

      let response: Promise<T[]>;
      try {
        response = request();
      } catch (error) {
        response = Promise.reject(error);
      }

      void response
        .then((items) => {
          if (!ownsRequest()) return;
          setState({ items, error: null, pending: true });
        })
        .catch((error: unknown) => {
          if (!ownsRequest()) return;
          setState({ items: null, error: listLoadErrorText(error, fallback), pending: true });
        })
        .finally(() => {
          if (!ownsRequest()) return;
          requestOwnerRef.current = null;
          setState((current) => ({ ...current, pending: false }));
        });
    },
    [authority],
  );

  const retire = useCallback(
    (reset: boolean) => {
      if (!authority || authorityRef.current !== authority) return;
      authorityRef.current = null;
      if (requestOwnerRef.current?.authority === authority) requestOwnerRef.current = null;
      setState((current) => (reset || current.pending ? initialListLoadState<T>() : current));
    },
    [authority],
  );

  const invalidate = useCallback(() => retire(false), [retire]);
  const reset = useCallback(() => retire(true), [retire]);
  return { state, load, invalidate, reset };
}

function ListLoadError({
  error,
  pending,
  onRetry,
  buttonRef,
  testId,
}: {
  error: string;
  pending: boolean;
  onRetry: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  buttonRef: (element: HTMLButtonElement | null) => void;
  testId: string;
}) {
  return (
    <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true" data-testid={testId}>
      <div className="wrap-anywhere">{error}</div>
      <button
        ref={buttonRef}
        type="button"
        className="btn btn-outline btn-sm mt-2 gap-1.5"
        onClick={onRetry}
        disabled={pending}
        aria-busy={pending || undefined}
      >
        {pending && <Loader2 size={13} className="animate-spin" />}
        {pending ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

interface PickerGistFilePresentation {
  readonly index: number;
  readonly source: GistItem["files"][number];
  readonly filename: string;
  readonly language: string | null;
  readonly size: number;
}

interface PickerGistPresentation {
  readonly index: number;
  readonly source: GistItem;
  readonly id: string;
  readonly description: string | null;
  readonly public: boolean;
  readonly updatedAt: string;
  readonly htmlUrl: string;
  readonly sourceFiles: GistItem["files"];
  readonly files: readonly PickerGistFilePresentation[];
}

interface PickerGistRowPresentation {
  readonly index: number;
  readonly gist: PickerGistPresentation;
  readonly file: PickerGistFilePresentation;
}

interface PickerRepoPresentation {
  readonly index: number;
  readonly source: RepoItem;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly pushedAt: string | null;
  readonly htmlUrl: string;
  readonly description: string | null;
  readonly value: RepoItem;
}

interface PickerFilePresentation {
  readonly index: number;
  readonly source: { path: string };
  readonly path: string;
}

interface PickerBranchPresentation {
  readonly index: number;
  readonly value: string;
}

interface PickerListPresentation<T, P> {
  readonly state: ListLoadState<T>;
  readonly sourceItems: T[] | null;
  readonly error: string | null;
  readonly pending: boolean;
  readonly items: readonly P[];
}

interface PickerCallbacks {
  readonly onLinked: GitHubPickerProps["onLinked"];
  readonly onImported: GitHubPickerProps["onImported"];
  readonly loadGists: () => void;
  readonly loadRepos: () => void;
  readonly loadBranches: () => void;
  readonly loadFiles: () => void;
  readonly invalidateGistLoad: () => void;
  readonly invalidateRepoLoad: () => void;
  readonly invalidateBranchLoad: () => void;
  readonly invalidateFileLoad: () => void;
  readonly resetBranchLoad: () => void;
  readonly resetFileLoad: () => void;
}

interface GitHubPickerPresentation {
  readonly identity: object;
  readonly revision: number;
  readonly mount: symbol;
  readonly visit: number;
  readonly mode: GitHubPickerProps["mode"];
  readonly document: DocumentDto | undefined;
  readonly documentId: string | null;
  readonly documentTitle: string | null;
  readonly githubAvailable: boolean;
  readonly githubConfigured: boolean;
  readonly sourceOrder: typeof PICKER_SOURCE_ORDER;
  readonly tab: Tab;
  readonly filter: string;
  readonly gistChoiceName: string;
  readonly newGist: boolean;
  readonly gistName: string;
  readonly gistPublic: boolean;
  readonly selectedRepo: PickerRepoPresentation | null;
  readonly branch: string;
  readonly path: string;
  readonly busy: boolean;
  readonly actionError: string | null;
  readonly operation: GitHubPickerOperation | null;
  readonly callbacks: PickerCallbacks;
  readonly gists: PickerListPresentation<GistItem, PickerGistPresentation>;
  readonly gistRows: readonly PickerGistRowPresentation[];
  readonly repositories: PickerListPresentation<RepoItem, PickerRepoPresentation>;
  readonly repositoryRows: readonly PickerRepoPresentation[];
  readonly branches: PickerListPresentation<string, PickerBranchPresentation>;
  readonly files: PickerListPresentation<{ path: string }, PickerFilePresentation>;
  readonly fileRows: readonly PickerFilePresentation[];
}

type PickerElementName =
  | "root"
  | "sourceGroup"
  | "tabGist"
  | "tabRepo"
  | "filter"
  | "newGist"
  | "existingGist"
  | "gistName"
  | "gistPublic"
  | "gistCreate"
  | "gistList"
  | "gistRetry"
  | "gistRows"
  | "repositoryList"
  | "repositoryRetry"
  | "repositoryRows"
  | "repositoryBack"
  | "branchList"
  | "branchRetry"
  | "branchSelect"
  | "pathForm"
  | "path"
  | "pathSubmit"
  | "fileList"
  | "fileRetry"
  | "fileRows";

type PickerMappedElementName = "gistRows" | "repositoryRows" | "branchOptions" | "fileRows";
type PickerMappedItem =
  | PickerGistRowPresentation
  | PickerRepoPresentation
  | PickerBranchPresentation
  | PickerFilePresentation;
type PickerRuntimePhase =
  | "mounting"
  | "active"
  | "layout-retired"
  | "replacement-retired"
  | "refs-detached"
  | "replay-ready"
  | "successor-requested"
  | "dead";

type PickerRefOwner =
  | {
      readonly kind: "element";
      readonly name: PickerElementName;
      current: HTMLElement | null;
      captured: boolean;
      readonly capture: (element: HTMLElement | null) => void;
    }
  | {
      readonly kind: "mapped";
      readonly mapName: PickerMappedElementName;
      readonly item: PickerMappedItem;
      current: HTMLElement | null;
      captured: boolean;
      readonly capture: (element: HTMLElement | null) => void;
    };

interface GitHubPickerPresentationRuntime {
  claimed: boolean;
  phase: PickerRuntimePhase;
  layoutRetired: boolean;
  publication: GitHubPickerPublication | null;
  history: PickerMutationHistory | null;
  expiry: number;
  readonly owners: PickerRefOwner[];
  readonly elementOwners: Map<PickerElementName, PickerRefOwner>;
  readonly mappedOwners: Map<object, PickerRefOwner>;
  committedRefs: Map<PickerRefOwner, HTMLElement> | null;
  mountReplayRefs: Set<PickerRefOwner>;
  replayExpected: Set<PickerRefOwner>;
  replayDetached: Set<PickerRefOwner>;
  replayAttached: Set<PickerRefOwner>;
  elements: Record<PickerElementName, HTMLElement | null>;
  gistRows: Map<PickerGistRowPresentation, HTMLButtonElement>;
  repositoryRows: Map<PickerRepoPresentation, HTMLButtonElement>;
  branchOptions: Map<PickerBranchPresentation, HTMLOptionElement>;
  fileRows: Map<PickerFilePresentation, HTMLButtonElement>;
}

interface PickerPublishedSource {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly source: Tab;
  readonly index: number;
  readonly selected: boolean;
  readonly enabled: boolean;
  readonly element: HTMLButtonElement;
}

interface PickerSourceMovement {
  readonly identity: symbol;
  readonly key: PickerSourceNavigationKey;
  readonly source: PickerPublishedSource;
  readonly destination: PickerPublishedSource | null;
}

interface PickerSourceReactMethods {
  readonly preventDefault: (...args: never[]) => unknown;
  readonly isDefaultPrevented: (...args: never[]) => unknown;
  readonly isPropagationStopped: (...args: never[]) => unknown;
}

interface PickerSourceReactDelivery {
  readonly stage: PickerSourceNavigationStage;
  readonly publication: GitHubPickerPublication;
  readonly wrapper: ReactKeyboardEvent<HTMLElement>;
  readonly methods: PickerSourceReactMethods;
  readonly native: CommitActionKeyboardEventSnapshot;
  readonly currentTarget: HTMLElement;
  readonly source: PickerPublishedSource;
}

interface PickerSourceNavigationPair {
  readonly publication: GitHubPickerPublication;
  readonly authority: CommitActionKeyboardAuthority;
  readonly movement: PickerSourceMovement;
  readonly groupCapture: PickerSourceReactDelivery;
  readonly sourceCapture: PickerSourceReactDelivery;
  readonly sourceBubble: PickerSourceReactDelivery;
  readonly groupBubble: PickerSourceReactDelivery;
  readonly terminal: CommitActionKeyboardTerminalProof;
  readonly publicationClaim: object;
  readonly movementClaim: object;
  readonly sourceClaim: object;
  readonly destinationClaim: object;
}

interface PickerSourceNavigationStages {
  readonly nativeEvent: Event;
  publication: GitHubPickerPublication | null;
  movement: PickerSourceMovement | null;
  groupCapture: PickerSourceReactDelivery | null;
  sourceCapture: PickerSourceReactDelivery | null;
  sourceBubble: PickerSourceReactDelivery | null;
  groupBubble: PickerSourceReactDelivery | null;
  pending: PickerSourceNavigationStage | null;
  invalid: boolean;
}

interface PickerDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly PickerDomSnapshot[];
}

interface GitHubPickerPublication {
  readonly identity: symbol;
  readonly presentation: GitHubPickerPresentation;
  readonly runtime: GitHubPickerPresentationRuntime;
  readonly ownerDocument: Document;
  readonly sourceGroup: HTMLDivElement;
  readonly sources: readonly PickerPublishedSource[];
  readonly movements: readonly PickerSourceMovement[];
  readonly keyboard: CommitActionKeyboardAuthority | null;
  readonly rootParent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
  readonly dom: PickerDomSnapshot;
}

interface PickerReplay {
  readonly source: GitHubPickerPublication;
  readonly history: PickerMutationHistory;
}

class GitHubPickerPublicationCoordinator {
  #active: GitHubPickerPublication | null = null;
  #successorOf: GitHubPickerPublication | null = null;
  #replay: PickerReplay | null = null;
  #retired = new WeakSet<GitHubPickerPublication>();
  #claimedEvents = new WeakSet<object>();
  #sourceNavigationStages = new WeakMap<object, PickerSourceNavigationStages>();
  #claimedSourceNavigationPairs = new WeakSet<PickerSourceNavigationPair>();
  #claimedSourceNavigationPublications = new WeakSet<object>();
  #claimedSourceNavigationMovements = new WeakSet<object>();
  #claimedSourceNavigationSources = new WeakSet<object>();
  #claimedSourceNavigationDestinations = new WeakSet<object>();
  #claimedSourceNavigationEvents = new WeakSet<object>();
  #sourceNavigationDelivery: PickerSourceNavigationPair | null = null;
  #sourceNavigationCallback: object | null = null;

  active() {
    return this.#active;
  }

  successorOf() {
    return this.#successorOf;
  }

  replay() {
    return this.#replay;
  }

  isRetired(publication: GitHubPickerPublication) {
    return this.#retired.has(publication);
  }

  markRetired(publication: GitHubPickerPublication) {
    publication.keyboard?.terminal.release();
    this.#retired.add(publication);
  }

  retire(publication: GitHubPickerPublication) {
    this.markRetired(publication);
    if (this.#active !== publication) return false;
    this.#active = null;
    this.#successorOf = publication;
    return true;
  }

  publish(publication: GitHubPickerPublication) {
    this.#active = publication;
    this.#successorOf = null;
  }

  clear(publication: GitHubPickerPublication) {
    publication.keyboard?.terminal.release();
    if (this.#active === publication) this.#active = null;
    if (this.#successorOf === publication) this.#successorOf = null;
  }

  startReplay(replay: PickerReplay) {
    this.#replay = replay;
  }

  clearReplay(publication: GitHubPickerPublication) {
    if (this.#replay?.source !== publication) return false;
    this.#replay = null;
    return true;
  }

  hasClaimed(event: object) {
    return this.#claimedEvents.has(event);
  }

  claim(event: object) {
    this.#claimedEvents.add(event);
  }

  beginSourceNavigationStage(
    stage: PickerSourceNavigationStage,
    nativeEvent: Event,
  ): PickerSourceNavigationStages | null {
    if (this.#sourceNavigationDelivery || this.#sourceNavigationCallback) {
      return null;
    }
    let stages = this.#sourceNavigationStages.get(nativeEvent);
    if (stage === "group-capture") {
      if (stages) {
        stages.invalid = true;
        return null;
      }
      stages = {
        nativeEvent,
        publication: null,
        movement: null,
        groupCapture: null,
        sourceCapture: null,
        sourceBubble: null,
        groupBubble: null,
        pending: stage,
        invalid: false,
      };
      this.#sourceNavigationStages.set(nativeEvent, stages);
      return stages;
    }
    if (!stages || stages.invalid || stages.pending) return null;
    if (stage === "source-capture") {
      if (
        !stages.groupCapture ||
        stages.sourceCapture ||
        stages.sourceBubble ||
        stages.groupBubble
      ) {
        stages.invalid = true;
        return null;
      }
      stages.pending = stage;
      return stages;
    }
    if (stage === "source-bubble") {
      if (
        !stages.sourceCapture ||
        stages.sourceBubble ||
        stages.groupBubble
      ) {
        stages.invalid = true;
        return null;
      }
      stages.pending = stage;
      return stages;
    }
    if (
      !stages.sourceBubble ||
      stages.groupBubble
    ) {
      stages.invalid = true;
      return null;
    }
    stages.pending = stage;
    return stages;
  }

  sourceNavigationStageIsCurrent(
    stages: PickerSourceNavigationStages,
    stage: PickerSourceNavigationStage,
  ) {
    return (
      !this.#sourceNavigationDelivery &&
      !this.#sourceNavigationCallback &&
      !stages.invalid &&
      stages.pending === stage &&
      this.#sourceNavigationStages.get(stages.nativeEvent) === stages
    );
  }

  completeSourceNavigationStage(
    stages: PickerSourceNavigationStages,
    stage: PickerSourceNavigationStage,
    delivery: PickerSourceReactDelivery,
    movement: PickerSourceMovement,
  ) {
    if (
      !this.sourceNavigationStageIsCurrent(stages, stage) ||
      delivery.stage !== stage ||
      delivery.native.event !== stages.nativeEvent ||
      (stages.publication !== null &&
        stages.publication !== delivery.publication) ||
      (stages.movement !== null && stages.movement !== movement)
    ) {
      stages.invalid = true;
      stages.pending = null;
      return false;
    }
    if (stage === "group-capture") {
      stages.publication = delivery.publication;
      stages.movement = movement;
      stages.groupCapture = delivery;
    } else if (stage === "source-capture") {
      stages.sourceCapture = delivery;
    } else if (stage === "source-bubble") {
      stages.sourceBubble = delivery;
    } else {
      stages.groupBubble = delivery;
    }
    stages.pending = null;
    return true;
  }

  rejectSourceNavigationStage(stages: PickerSourceNavigationStages) {
    stages.invalid = true;
    stages.pending = null;
  }

  invokeSourceNavigationStageCallback(
    stages: PickerSourceNavigationStages,
    stage: PickerSourceNavigationStage,
    invoke: () => unknown,
  ): Readonly<{ value: unknown }> | null {
    if (!this.sourceNavigationStageIsCurrent(stages, stage)) return null;
    const claim = Object.freeze({});
    this.#sourceNavigationCallback = claim;
    try {
      return Object.freeze({ value: invoke() });
    } catch {
      return null;
    } finally {
      if (this.#sourceNavigationCallback === claim) {
        this.#sourceNavigationCallback = null;
      }
    }
  }

  claimSourceNavigation(pair: PickerSourceNavigationPair) {
    const nativeEvent = pair.groupBubble.native.event;
    const stages = this.#sourceNavigationStages.get(nativeEvent);
    const destination = pair.movement.destination;
    if (
      !destination ||
      this.#sourceNavigationDelivery ||
      this.#sourceNavigationCallback ||
      this.#active !== pair.publication ||
      pair.publication.keyboard !== pair.authority ||
      stages?.pending !== null ||
      stages?.invalid ||
      stages?.publication !== pair.publication ||
      stages.movement !== pair.movement ||
      stages.groupCapture !== pair.groupCapture ||
      stages.sourceCapture !== pair.sourceCapture ||
      stages.sourceBubble !== pair.sourceBubble ||
      stages.groupBubble !== pair.groupBubble ||
      this.#claimedSourceNavigationPairs.has(pair) ||
      this.#claimedSourceNavigationPublications.has(pair.publicationClaim) ||
      this.#claimedSourceNavigationMovements.has(pair.movementClaim) ||
      this.#claimedSourceNavigationSources.has(pair.sourceClaim) ||
      this.#claimedSourceNavigationDestinations.has(pair.destinationClaim) ||
      this.#claimedSourceNavigationEvents.has(pair.groupCapture.wrapper) ||
      this.#claimedSourceNavigationEvents.has(pair.sourceCapture.wrapper) ||
      this.#claimedSourceNavigationEvents.has(pair.sourceBubble.wrapper) ||
      this.#claimedSourceNavigationEvents.has(pair.groupBubble.wrapper) ||
      this.#claimedSourceNavigationEvents.has(nativeEvent) ||
      !pair.authority.terminal.claim(pair.terminal)
    ) {
      return false;
    }
    this.#claimedSourceNavigationPairs.add(pair);
    this.#claimedSourceNavigationPublications.add(pair.publicationClaim);
    this.#claimedSourceNavigationMovements.add(pair.movementClaim);
    this.#claimedSourceNavigationSources.add(pair.sourceClaim);
    this.#claimedSourceNavigationDestinations.add(pair.destinationClaim);
    this.#claimedSourceNavigationEvents.add(pair.groupCapture.wrapper);
    this.#claimedSourceNavigationEvents.add(pair.sourceCapture.wrapper);
    this.#claimedSourceNavigationEvents.add(pair.sourceBubble.wrapper);
    this.#claimedSourceNavigationEvents.add(pair.groupBubble.wrapper);
    this.#claimedSourceNavigationEvents.add(nativeEvent);
    this.#sourceNavigationDelivery = pair;
    stages.invalid = true;
    return true;
  }

  sourceNavigationIsDelivering(pair: PickerSourceNavigationPair) {
    return (
      this.#sourceNavigationDelivery === pair &&
      !this.#sourceNavigationCallback &&
      this.#claimedSourceNavigationPairs.has(pair) &&
      this.#claimedSourceNavigationPublications.has(pair.publicationClaim) &&
      this.#claimedSourceNavigationMovements.has(pair.movementClaim) &&
      this.#claimedSourceNavigationSources.has(pair.sourceClaim) &&
      this.#claimedSourceNavigationDestinations.has(pair.destinationClaim) &&
      this.#claimedSourceNavigationEvents.has(pair.groupCapture.wrapper) &&
      this.#claimedSourceNavigationEvents.has(pair.sourceCapture.wrapper) &&
      this.#claimedSourceNavigationEvents.has(pair.sourceBubble.wrapper) &&
      this.#claimedSourceNavigationEvents.has(pair.groupBubble.wrapper) &&
      this.#claimedSourceNavigationEvents.has(pair.groupBubble.native.event) &&
      pair.authority.terminal.retains(pair.terminal)
    );
  }

  invokeSourceNavigationPairCallback(
    pair: PickerSourceNavigationPair,
    invoke: () => unknown,
  ): Readonly<{ value: unknown }> | null {
    if (!this.sourceNavigationIsDelivering(pair)) return null;
    const claim = Object.freeze({});
    this.#sourceNavigationCallback = claim;
    try {
      return Object.freeze({ value: invoke() });
    } catch {
      return null;
    } finally {
      if (this.#sourceNavigationCallback === claim) {
        this.#sourceNavigationCallback = null;
      }
    }
  }

  finishSourceNavigation(pair: PickerSourceNavigationPair) {
    this.#sourceNavigationCallback = null;
    if (this.#sourceNavigationDelivery === pair) {
      this.#sourceNavigationDelivery = null;
    }
  }
}

class GitHubPickerRuntimeRegistry {
  #runtimes = new WeakMap<GitHubPickerPresentation, GitHubPickerPresentationRuntime>();

  get(candidate: GitHubPickerPresentation) {
    return this.#runtimes.get(candidate);
  }

  for(candidate: GitHubPickerPresentation) {
    let runtime = this.get(candidate);
    if (!runtime) {
      runtime = {
        claimed: false,
        phase: "mounting",
        layoutRetired: false,
        publication: null,
        history: null,
        expiry: 0,
        owners: [],
        elementOwners: new Map(),
        mappedOwners: new Map(),
        committedRefs: null,
        mountReplayRefs: new Set(),
        replayExpected: new Set(),
        replayDetached: new Set(),
        replayAttached: new Set(),
        elements: emptyPickerElements(),
        gistRows: new Map(),
        repositoryRows: new Map(),
        branchOptions: new Map(),
        fileRows: new Map(),
      };
      this.#runtimes.set(candidate, runtime);
    }
    return runtime;
  }
}

type PickerChangingControl = "filter" | "newGist" | "gistName" | "gistPublic" | "branch" | "path" | null;

function snapshotPickerGist(item: GistItem, index: number): PickerGistPresentation {
  return Object.freeze({
    index,
    source: item,
    id: item.id,
    description: item.description,
    public: item.public,
    updatedAt: item.updatedAt,
    htmlUrl: item.htmlUrl,
    sourceFiles: item.files,
    files: Object.freeze(
      item.files.map((file, fileIndex) =>
        Object.freeze({
          index: fileIndex,
          source: file,
          filename: file.filename,
          language: file.language,
          size: file.size,
        }),
      ),
    ),
  });
}

function snapshotPickerRepo(item: RepoItem, index: number): PickerRepoPresentation {
  const value = Object.freeze<RepoItem>({
    owner: item.owner,
    name: item.name,
    fullName: item.fullName,
    private: item.private,
    defaultBranch: item.defaultBranch,
    pushedAt: item.pushedAt,
    htmlUrl: item.htmlUrl,
    description: item.description,
  });
  return Object.freeze({ index, source: item, ...value, value });
}

function snapshotPickerFile(item: { path: string }, index: number): PickerFilePresentation {
  return Object.freeze({ index, source: item, path: item.path });
}

function snapshotPickerBranch(value: string, index: number): PickerBranchPresentation {
  return Object.freeze({ index, value });
}

function pickerList<T, P>(state: ListLoadState<T>, snapshot: (item: T, index: number) => P): PickerListPresentation<T, P> {
  return Object.freeze({
    state,
    sourceItems: state.items,
    error: state.error,
    pending: state.pending,
    items: Object.freeze((state.items ?? []).map(snapshot)),
  });
}

function pickerGistFactsMatch(list: PickerListPresentation<GistItem, PickerGistPresentation>): boolean {
  const source = list.sourceItems;
  if (list.state.items !== source || list.state.error !== list.error || list.state.pending !== list.pending) return false;
  if (source === null) return list.items.length === 0;
  if (source.length !== list.items.length) return false;
  return list.items.every((item, index) => {
    const current = source[index];
    if (
      !current ||
      item.index !== index ||
      item.source !== current ||
      item.id !== current.id ||
      item.description !== current.description ||
      item.public !== current.public ||
      item.updatedAt !== current.updatedAt ||
      item.htmlUrl !== current.htmlUrl ||
      item.sourceFiles !== current.files ||
      item.files.length !== current.files.length
    ) {
      return false;
    }
    return item.files.every((file, fileIndex) => {
      const currentFile = current.files[fileIndex];
      return (
        !!currentFile &&
        file.index === fileIndex &&
        file.source === currentFile &&
        file.filename === currentFile.filename &&
        file.language === currentFile.language &&
        file.size === currentFile.size
      );
    });
  });
}

function pickerRepoFactsMatch(list: PickerListPresentation<RepoItem, PickerRepoPresentation>): boolean {
  const source = list.sourceItems;
  if (list.state.items !== source || list.state.error !== list.error || list.state.pending !== list.pending) return false;
  if (source === null) return list.items.length === 0;
  if (source.length !== list.items.length) return false;
  return list.items.every((item, index) => {
    const current = source[index];
    return (
      !!current &&
      item.index === index &&
      item.source === current &&
      item.owner === current.owner &&
      item.name === current.name &&
      item.fullName === current.fullName &&
      item.private === current.private &&
      item.defaultBranch === current.defaultBranch &&
      item.pushedAt === current.pushedAt &&
      item.htmlUrl === current.htmlUrl &&
      item.description === current.description
    );
  });
}

function pickerSelectedRepoFactsMatch(item: PickerRepoPresentation | null): boolean {
  if (!item) return true;
  const current = item.source;
  return (
    item.owner === current.owner &&
    item.name === current.name &&
    item.fullName === current.fullName &&
    item.private === current.private &&
    item.defaultBranch === current.defaultBranch &&
    item.pushedAt === current.pushedAt &&
    item.htmlUrl === current.htmlUrl &&
    item.description === current.description
  );
}

function pickerBranchFactsMatch(list: PickerListPresentation<string, PickerBranchPresentation>): boolean {
  const source = list.sourceItems;
  if (list.state.items !== source || list.state.error !== list.error || list.state.pending !== list.pending) return false;
  if (source === null) return list.items.length === 0;
  if (source.length !== list.items.length) return false;
  return list.items.every((branch, index) => branch.index === index && branch.value === source[index]);
}

function pickerFileFactsMatch(list: PickerListPresentation<{ path: string }, PickerFilePresentation>): boolean {
  const source = list.sourceItems;
  if (list.state.items !== source || list.state.error !== list.error || list.state.pending !== list.pending) return false;
  if (source === null) return list.items.length === 0;
  if (source.length !== list.items.length) return false;
  return list.items.every((item, index) => {
    const current = source[index];
    return !!current && item.index === index && item.source === current && item.path === current.path;
  });
}

function pickerRenderedFactsMatch(presentation: GitHubPickerPresentation): boolean {
  const query = presentation.filter.toLowerCase();
  const expectedGistRows: Array<readonly [PickerGistPresentation, PickerGistFilePresentation]> = [];
  for (const gist of presentation.gists.items) {
    if (
      query &&
      !(gist.description ?? "").toLowerCase().includes(query) &&
      !gist.files.some((file) => file.filename.toLowerCase().includes(query))
    ) {
      continue;
    }
    for (const file of gist.files) {
      if (/\.(md|markdown|mdx)$/i.test(file.filename) || file.language === "Markdown") {
        expectedGistRows.push([gist, file]);
      }
    }
  }
  if (
    expectedGistRows.length !== presentation.gistRows.length ||
    !presentation.gistRows.every(
      (row, index) =>
        row.index === index &&
        row.gist === expectedGistRows[index]?.[0] &&
        row.file === expectedGistRows[index]?.[1],
    )
  ) {
    return false;
  }

  const expectedRepos = presentation.repositories.items.filter(
    (repo) => !query || repo.fullName.toLowerCase().includes(query),
  );
  if (
    expectedRepos.length !== presentation.repositoryRows.length ||
    !presentation.repositoryRows.every((repo, index) => repo === expectedRepos[index])
  ) {
    return false;
  }

  const expectedFiles = presentation.files.items.filter((file) => !query || file.path.toLowerCase().includes(query));
  return (
    expectedFiles.length === presentation.fileRows.length &&
    presentation.fileRows.every((file, index) => file === expectedFiles[index])
  );
}

function pickerPresentationFactsMatch(presentation: GitHubPickerPresentation): boolean {
  return (
    presentation.githubAvailable &&
    presentation.sourceOrder === PICKER_SOURCE_ORDER &&
    presentation.sourceOrder[0] === "gist" &&
    presentation.sourceOrder[1] === "repo" &&
    (presentation.document?.id ?? null) === presentation.documentId &&
    (presentation.document?.title ?? null) === presentation.documentTitle &&
    pickerGistFactsMatch(presentation.gists) &&
    pickerRepoFactsMatch(presentation.repositories) &&
    pickerSelectedRepoFactsMatch(presentation.selectedRepo) &&
    pickerBranchFactsMatch(presentation.branches) &&
    pickerFileFactsMatch(presentation.files) &&
    pickerRenderedFactsMatch(presentation)
  );
}

function snapshotPickerAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    Array.from((node as Element).attributes, ({ name, value }) => Object.freeze([name, value] as const)).sort(
      ([left], [right]) => left.localeCompare(right),
    ),
  );
}

function snapshotPickerDom(node: Node): PickerDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotPickerAttributes(node),
    children: Object.freeze(Array.from(node.childNodes, snapshotPickerDom)),
  });
}

function pickerDomMatches(snapshot: PickerDomSnapshot, ownerDocument: Document): boolean {
  const { node, children } = snapshot;
  if (
    !node.isConnected ||
    node.ownerDocument !== ownerDocument ||
    node.nodeValue !== snapshot.nodeValue ||
    node.childNodes.length !== children.length
  ) {
    return false;
  }
  const attributes = snapshotPickerAttributes(node);
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
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (node.childNodes.item(index) !== child.node || !pickerDomMatches(child, ownerDocument)) return false;
  }
  return true;
}

function emptyPickerElements(): Record<PickerElementName, HTMLElement | null> {
  return {
    root: null,
    sourceGroup: null,
    tabGist: null,
    tabRepo: null,
    filter: null,
    newGist: null,
    existingGist: null,
    gistName: null,
    gistPublic: null,
    gistCreate: null,
    gistList: null,
    gistRetry: null,
    gistRows: null,
    repositoryList: null,
    repositoryRetry: null,
    repositoryRows: null,
    repositoryBack: null,
    branchList: null,
    branchRetry: null,
    branchSelect: null,
    pathForm: null,
    path: null,
    pathSubmit: null,
    fileList: null,
    fileRetry: null,
    fileRows: null,
  };
}

function pickerPlacementMatches(publication: GitHubPickerPublication): boolean {
  const root = publication.dom.node;
  return Boolean(
    root &&
      root.ownerDocument === publication.ownerDocument &&
      root.parentNode === publication.rootParent &&
      root.previousSibling === publication.previousSibling &&
      root.nextSibling === publication.nextSibling,
  );
}

function pickerSnapshotNodes(snapshot: PickerDomSnapshot, nodes = new Set<Node>()): Set<Node> {
  nodes.add(snapshot.node);
  for (const child of snapshot.children) pickerSnapshotNodes(child, nodes);
  return nodes;
}

function pickerInputCorrectionsAreExact(
  records: readonly MutationRecord[],
  publication: GitHubPickerPublication,
): boolean {
  const root = publication.dom.node;
  const Input = publication.ownerDocument.defaultView?.HTMLInputElement;
  if (!Input || !pickerDomMatches(publication.dom, publication.ownerDocument)) return false;

  for (let index = 0; index < records.length; ) {
    const first = records[index];
    if (
      !first ||
      first.type !== "attributes" ||
      first.attributeName !== "name" ||
      !(first.target instanceof Input) ||
      !root.contains(first.target)
    ) {
      return false;
    }
    const input = first.target;
    const checkable = input.type === "checkbox" || input.type === "radio";
    if (checkable) {
      const type = records[index + 1];
      const restoredName = records[index + 2];
      if (
        first.oldValue !== input.getAttribute("name") ||
        !type ||
        type.target !== input ||
        type.type !== "attributes" ||
        type.attributeName !== "type" ||
        type.oldValue !== input.type ||
        !restoredName ||
        restoredName.target !== input ||
        restoredName.type !== "attributes" ||
        restoredName.attributeName !== "name" ||
        restoredName.oldValue !== ""
      ) {
        return false;
      }
      index += 3;
      continue;
    }
    const restoredName = records[index + 1];
    if (
      first.oldValue !== null ||
      input.hasAttribute("name") ||
      !restoredName ||
      restoredName.target !== input ||
      restoredName.type !== "attributes" ||
      restoredName.attributeName !== "name" ||
      restoredName.oldValue !== ""
    ) {
      return false;
    }
    index += 2;
  }
  return records.length > 0;
}

class PickerMutationHistory {
  private dirty = false;
  private readonly records: MutationRecord[] = [];
  private readonly rootObserver: MutationObserver;
  private readonly parentObserver: MutationObserver;

  constructor(private readonly publication: GitHubPickerPublication) {
    const Observer = publication.ownerDocument.defaultView?.MutationObserver;
    if (!Observer) throw new Error("The GitHub picker has no owner-document MutationObserver");
    this.rootObserver = new Observer((records) => {
      this.records.push(...records);
    });
    this.parentObserver = new Observer((records) => {
      if (records.length > 0) this.dirty = true;
    });
    this.rootObserver.observe(publication.dom.node, {
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    this.parentObserver.observe(publication.rootParent, { childList: true });
  }

  readonly isPristine = (allowInputNameCorrection = false) => {
    this.records.push(...this.rootObserver.takeRecords());
    if (this.parentObserver.takeRecords().length > 0) this.dirty = true;
    if (!this.dirty && this.records.length > 0) {
      const exactInputCorrection =
        allowInputNameCorrection &&
        pickerInputCorrectionsAreExact(this.records, this.publication);
      if (exactInputCorrection) this.records.length = 0;
      else this.dirty = true;
    }
    return !this.dirty;
  };

  readonly disconnect = () => {
    this.isPristine();
    this.rootObserver.disconnect();
    this.parentObserver.disconnect();
  };
}

function pickerPresentationDomIsExact(
  presentation: GitHubPickerPresentation,
  runtime: GitHubPickerPresentationRuntime,
  changing: PickerChangingControl = null,
): boolean {
  const root = runtime.elements.root;
  const ownerWindow = root?.ownerDocument.defaultView;
  if (
    !ownerWindow ||
    !(root instanceof ownerWindow.HTMLDivElement) ||
    !root.isConnected ||
    root.dataset.testid !== "github-picker"
  ) {
    return false;
  }
  const ownerDocument = root.ownerDocument;
  const belongs = (element: HTMLElement | null) =>
    !!element && element.isConnected && element.ownerDocument === ownerDocument && root.contains(element);
  const none = (...names: PickerElementName[]) => names.every((name) => runtime.elements[name] === null);

  const sourceGroup = runtime.elements.sourceGroup;
  const tabGist = runtime.elements.tabGist;
  const tabRepo = runtime.elements.tabRepo;
  const filter = runtime.elements.filter;
  if (
    !(sourceGroup instanceof ownerWindow.HTMLDivElement) ||
    !(tabGist instanceof ownerWindow.HTMLButtonElement) ||
    !(tabRepo instanceof ownerWindow.HTMLButtonElement) ||
    !(filter instanceof ownerWindow.HTMLInputElement) ||
    !belongs(sourceGroup) ||
    !belongs(tabGist) ||
    !belongs(tabRepo) ||
    !belongs(filter) ||
    tabGist === tabRepo ||
    sourceGroup.getAttribute("role") !== "group" ||
    sourceGroup.getAttribute("aria-label") !== PICKER_SOURCE_LABEL ||
    sourceGroup.children.length !== PICKER_SOURCE_ORDER.length ||
    sourceGroup.children.item(0) !== tabGist ||
    sourceGroup.children.item(1) !== tabRepo ||
    tabGist.parentElement !== sourceGroup ||
    tabRepo.parentElement !== sourceGroup ||
    tabGist.type !== "button" ||
    tabRepo.type !== "button" ||
    tabGist.disabled !== presentation.busy ||
    tabRepo.disabled !== presentation.busy ||
    tabGist.dataset.testid !== "picker-tab-gist" ||
    tabRepo.dataset.testid !== "picker-tab-repo" ||
    tabGist.getAttribute("aria-pressed") !== String(presentation.tab === "gist") ||
    tabRepo.getAttribute("aria-pressed") !== String(presentation.tab === "repo") ||
    filter.disabled !== presentation.busy ||
    filter.placeholder !==
      (presentation.tab === "gist"
        ? "Filter gists"
        : presentation.selectedRepo
          ? "Filter files"
          : "Filter repositories") ||
    (changing !== "filter" && filter.value !== presentation.filter)
  ) {
    return false;
  }

  if (presentation.tab === "gist") {
    if (
      !none(
        "repositoryList",
        "repositoryRetry",
        "repositoryRows",
        "repositoryBack",
        "branchList",
        "branchRetry",
        "branchSelect",
        "pathForm",
        "path",
        "pathSubmit",
        "fileList",
        "fileRetry",
        "fileRows",
      ) ||
      runtime.repositoryRows.size !== 0 ||
      runtime.branchOptions.size !== 0 ||
      runtime.fileRows.size !== 0
    ) {
      return false;
    }

    if (presentation.mode === "link") {
      const newGist = runtime.elements.newGist;
      const existingGist = runtime.elements.existingGist;
      if (
        !(newGist instanceof ownerWindow.HTMLInputElement) ||
        !(existingGist instanceof ownerWindow.HTMLInputElement) ||
        !belongs(newGist) ||
        !belongs(existingGist) ||
        newGist.type !== "radio" ||
        existingGist.type !== "radio" ||
        newGist.name !== presentation.gistChoiceName ||
        existingGist.name !== presentation.gistChoiceName ||
        newGist.disabled !== presentation.busy ||
        existingGist.disabled !== presentation.busy ||
        (changing !== "newGist" &&
          (newGist.checked !== presentation.newGist || existingGist.checked !== !presentation.newGist))
      ) {
        return false;
      }
    } else if (!none("newGist", "existingGist")) {
      return false;
    }

    if (presentation.mode === "link" && presentation.newGist) {
      const gistName = runtime.elements.gistName;
      const gistPublic = runtime.elements.gistPublic;
      const gistCreate = runtime.elements.gistCreate;
      if (
        !(gistName instanceof ownerWindow.HTMLInputElement) ||
        !(gistPublic instanceof ownerWindow.HTMLInputElement) ||
        !(gistCreate instanceof ownerWindow.HTMLButtonElement) ||
        !belongs(gistName) ||
        !belongs(gistPublic) ||
        !belongs(gistCreate) ||
        gistName.disabled !== presentation.busy ||
        (changing !== "gistName" && gistName.value !== presentation.gistName) ||
        gistName.dataset.testid !== "gist-filename" ||
        gistPublic.type !== "checkbox" ||
        gistPublic.disabled !== presentation.busy ||
        (changing !== "gistPublic" && gistPublic.checked !== presentation.gistPublic) ||
        gistCreate.type !== "button" ||
        gistCreate.disabled !== (presentation.busy || !presentation.gistName.trim()) ||
        gistCreate.dataset.testid !== "gist-create" ||
        !none("gistList", "gistRetry", "gistRows") ||
        runtime.gistRows.size !== 0
      ) {
        return false;
      }
    } else {
      if (!none("gistName", "gistPublic", "gistCreate")) return false;
      const list = runtime.elements.gistList;
      const retry = runtime.elements.gistRetry;
      const rows = runtime.elements.gistRows;
      const hasRetry = presentation.gists.error !== null;
      const hasRows =
        !hasRetry &&
        presentation.gists.sourceItems !== null &&
        presentation.gistRows.length > 0;
      if (
        !(list instanceof ownerWindow.HTMLDivElement) ||
        !belongs(list) ||
        list.dataset.testid !== "gist-list" ||
        (hasRetry
          ? !(retry instanceof ownerWindow.HTMLButtonElement) ||
            !belongs(retry) ||
            retry.type !== "button" ||
            retry.disabled !== presentation.gists.pending
          : retry !== null) ||
        (hasRows
          ? !(rows instanceof ownerWindow.HTMLUListElement) || !belongs(rows) || rows.parentElement !== list
          : rows !== null) ||
        runtime.gistRows.size !== (hasRows ? presentation.gistRows.length : 0)
      ) {
        return false;
      }
      if (hasRows) {
        const rowList = rows as HTMLUListElement;
        if (rowList.children.length !== presentation.gistRows.length) return false;
        for (const row of presentation.gistRows) {
          const button = runtime.gistRows.get(row);
          const item = button?.parentElement;
          if (
            !(button instanceof ownerWindow.HTMLButtonElement) ||
            !belongs(button) ||
            button.type !== "button" ||
            button.disabled !== presentation.busy ||
            button.dataset.testid !== "gist-item" ||
            !(item instanceof ownerWindow.HTMLLIElement) ||
            item.parentElement !== rowList ||
            rowList.children.item(row.index) !== item ||
            item.firstElementChild !== button ||
            item.children.length !== 1
          ) {
            return false;
          }
        }
      }
    }
    return true;
  }

  if (
    !none("newGist", "existingGist", "gistName", "gistPublic", "gistCreate", "gistList", "gistRetry", "gistRows") ||
    runtime.gistRows.size !== 0
  ) {
    return false;
  }

  if (!presentation.selectedRepo) {
    if (
      !none(
        "repositoryBack",
        "branchList",
        "branchRetry",
        "branchSelect",
        "pathForm",
        "path",
        "pathSubmit",
        "fileList",
        "fileRetry",
        "fileRows",
      ) ||
      runtime.branchOptions.size !== 0 ||
      runtime.fileRows.size !== 0
    ) {
      return false;
    }
    const list = runtime.elements.repositoryList;
    const retry = runtime.elements.repositoryRetry;
    const rows = runtime.elements.repositoryRows;
    const hasRetry = presentation.repositories.error !== null;
    const hasRows =
      !hasRetry &&
      presentation.repositories.sourceItems !== null &&
      presentation.repositoryRows.length > 0;
    if (
      !(list instanceof ownerWindow.HTMLDivElement) ||
      !belongs(list) ||
      list.dataset.testid !== "repo-list" ||
      (hasRetry
        ? !(retry instanceof ownerWindow.HTMLButtonElement) ||
          !belongs(retry) ||
          retry.type !== "button" ||
          retry.disabled !== presentation.repositories.pending
        : retry !== null) ||
      (hasRows
        ? !(rows instanceof ownerWindow.HTMLUListElement) || !belongs(rows) || rows.parentElement !== list
        : rows !== null) ||
      runtime.repositoryRows.size !== (hasRows ? presentation.repositoryRows.length : 0)
    ) {
      return false;
    }
    if (hasRows) {
      const rowList = rows as HTMLUListElement;
      if (rowList.children.length !== presentation.repositoryRows.length) return false;
      for (let index = 0; index < presentation.repositoryRows.length; index++) {
        const row = presentation.repositoryRows[index];
        const button = runtime.repositoryRows.get(row);
        const item = button?.parentElement;
        if (
          !(button instanceof ownerWindow.HTMLButtonElement) ||
          !belongs(button) ||
          button.type !== "button" ||
          button.disabled !== presentation.busy ||
          button.dataset.testid !== "repo-item" ||
          !(item instanceof ownerWindow.HTMLLIElement) ||
          item.parentElement !== rowList ||
          rowList.children.item(index) !== item ||
          item.firstElementChild !== button ||
          item.children.length !== 1
        ) {
          return false;
        }
      }
    }
    return true;
  }

  if (!none("repositoryList", "repositoryRetry", "repositoryRows") || runtime.repositoryRows.size !== 0) return false;
  const repositoryBack = runtime.elements.repositoryBack;
  const branchList = runtime.elements.branchList;
  const branchRetry = runtime.elements.branchRetry;
  const fileList = runtime.elements.fileList;
  const fileRetry = runtime.elements.fileRetry;
  const fileRows = runtime.elements.fileRows;
  const hasBranchRetry = presentation.branches.error !== null;
  const hasBranchSelect =
    presentation.branches.error === null &&
    presentation.branches.sourceItems !== null &&
    presentation.branches.items.length > 0;
  const branchSelect = runtime.elements.branchSelect;
  const hasFileRows =
    presentation.files.error === null &&
    presentation.files.sourceItems !== null &&
    presentation.fileRows.length > 0;
  const hasFileRetry = presentation.files.error !== null;
  if (
    !(repositoryBack instanceof ownerWindow.HTMLButtonElement) ||
    !(branchList instanceof ownerWindow.HTMLDivElement) ||
    !(fileList instanceof ownerWindow.HTMLDivElement) ||
    !belongs(repositoryBack) ||
    !belongs(branchList) ||
    !belongs(fileList) ||
    repositoryBack.type !== "button" ||
    repositoryBack.disabled !== presentation.busy ||
    branchList.dataset.testid !== "branch-list" ||
    fileList.dataset.testid !== "file-list" ||
    (hasBranchRetry
      ? !(branchRetry instanceof ownerWindow.HTMLButtonElement) ||
        !belongs(branchRetry) ||
        branchRetry.type !== "button" ||
        branchRetry.disabled !== presentation.branches.pending
      : branchRetry !== null) ||
    (hasFileRetry
      ? !(fileRetry instanceof ownerWindow.HTMLButtonElement) ||
        !belongs(fileRetry) ||
        fileRetry.type !== "button" ||
        fileRetry.disabled !== presentation.files.pending
      : fileRetry !== null) ||
    (hasBranchSelect
      ? !(branchSelect instanceof ownerWindow.HTMLSelectElement) || !belongs(branchSelect)
      : branchSelect !== null) ||
    runtime.branchOptions.size !== (hasBranchSelect ? presentation.branches.items.length : 0) ||
    (hasFileRows
      ? !(fileRows instanceof ownerWindow.HTMLUListElement) || !belongs(fileRows) || fileRows.parentElement !== fileList
      : fileRows !== null) ||
    runtime.fileRows.size !== (hasFileRows ? presentation.fileRows.length : 0)
  ) {
    return false;
  }

  if (hasBranchSelect) {
    const select = branchSelect as HTMLSelectElement;
    if (
      select.disabled !== presentation.busy ||
      select.dataset.testid !== "branch-select" ||
      select.options.length !== presentation.branches.items.length ||
      (changing !== "branch" &&
        select.value !==
          (presentation.branches.items.some((item) => item.value === presentation.branch)
            ? presentation.branch
            : presentation.branches.items[0]?.value))
    ) {
      return false;
    }
    for (let index = 0; index < presentation.branches.items.length; index++) {
      const branch = presentation.branches.items[index];
      const option = runtime.branchOptions.get(branch);
      if (
        !(option instanceof ownerWindow.HTMLOptionElement) ||
        !belongs(option) ||
        option.parentElement !== select ||
        select.options.item(index) !== option ||
        option.value !== branch.value ||
        option.textContent !== branch.value
      ) {
        return false;
      }
    }
  }

  if (presentation.mode === "link") {
    const form = runtime.elements.pathForm;
    const path = runtime.elements.path;
    const submit = runtime.elements.pathSubmit;
    if (
      !(form instanceof ownerWindow.HTMLFormElement) ||
      !(path instanceof ownerWindow.HTMLInputElement) ||
      !(submit instanceof ownerWindow.HTMLButtonElement) ||
      !belongs(form) ||
      !belongs(path) ||
      !belongs(submit) ||
      path.form !== form ||
      submit.form !== form ||
      path.disabled !== presentation.busy ||
      (changing !== "path" && path.value !== presentation.path) ||
      path.dataset.testid !== "repo-path" ||
      submit.type !== "submit" ||
      submit.disabled !== (presentation.busy || !presentation.path.trim()) ||
      submit.dataset.testid !== "repo-link"
    ) {
      return false;
    }
  } else if (!none("pathForm", "path", "pathSubmit")) {
    return false;
  }

  if (hasFileRows) {
    const rowList = fileRows as HTMLUListElement;
    if (rowList.children.length !== presentation.fileRows.length) return false;
    for (let index = 0; index < presentation.fileRows.length; index++) {
      const row = presentation.fileRows[index];
      const button = runtime.fileRows.get(row);
      const item = button?.parentElement;
      if (
        !(button instanceof ownerWindow.HTMLButtonElement) ||
        !belongs(button) ||
        button.type !== "button" ||
        button.disabled !== presentation.busy ||
        button.dataset.testid !== "repo-file" ||
        !(item instanceof ownerWindow.HTMLLIElement) ||
        item.parentElement !== rowList ||
        rowList.children.item(index) !== item ||
        item.firstElementChild !== button ||
        item.children.length !== 1
      ) {
        return false;
      }
    }
  }
  return true;
}

function pickerSourceDestination(
  sources: readonly PickerPublishedSource[],
  source: PickerPublishedSource,
  key: PickerSourceNavigationKey,
): PickerPublishedSource | null {
  const enabled = sources.filter((entry) => entry.enabled);
  const index = enabled.indexOf(source);
  if (index < 0) return null;
  const destinationIndex =
    key === "Home"
      ? 0
      : key === "End"
        ? enabled.length - 1
        : key === "ArrowLeft" || key === "ArrowUp"
          ? index - 1
          : index + 1;
  const destination = enabled[destinationIndex] ?? null;
  return destination && destination !== source ? destination : null;
}

function pickerPublishedSourcesAreCurrent(
  publication: GitHubPickerPublication,
): boolean {
  const { presentation, sourceGroup, sources, movements } = publication;
  const ownerWindow = publication.ownerDocument.defaultView;
  if (
    !ownerWindow ||
    presentation.sourceOrder !== PICKER_SOURCE_ORDER ||
    !(sourceGroup instanceof ownerWindow.HTMLDivElement) ||
    sourceGroup.ownerDocument !== publication.ownerDocument ||
    !sourceGroup.isConnected ||
    sourceGroup.getAttribute("role") !== "group" ||
    sourceGroup.getAttribute("aria-label") !== PICKER_SOURCE_LABEL ||
    sourceGroup.children.length !== PICKER_SOURCE_ORDER.length ||
    sources.length !== PICKER_SOURCE_ORDER.length
  ) {
    return false;
  }
  for (let index = 0; index < PICKER_SOURCE_ORDER.length; index++) {
    const source = sources[index];
    const expectedSource = PICKER_SOURCE_ORDER[index];
    if (
      !source ||
      source.publicationIdentity !== publication.identity ||
      source.source !== expectedSource ||
      source.index !== index ||
      source.selected !== (presentation.tab === expectedSource) ||
      source.enabled !== !presentation.busy ||
      !(source.element instanceof ownerWindow.HTMLButtonElement) ||
      source.element.ownerDocument !== publication.ownerDocument ||
      !source.element.isConnected ||
      source.element.parentElement !== sourceGroup ||
      sourceGroup.children.item(index) !== source.element ||
      source.element.type !== "button" ||
      source.element.disabled === source.enabled ||
      source.element.getAttribute("aria-pressed") !== String(source.selected) ||
      source.element.dataset.testid !== `picker-tab-${expectedSource}`
    ) {
      return false;
    }
  }
  const keys: readonly PickerSourceNavigationKey[] = [
    "ArrowLeft",
    "ArrowUp",
    "ArrowRight",
    "ArrowDown",
    "Home",
    "End",
  ];
  if (movements.length !== sources.length * keys.length) return false;
  return sources.every((source, sourceIndex) =>
    keys.every((key, keyIndex) => {
      const movement = movements[sourceIndex * keys.length + keyIndex];
      return (
        !!movement &&
        movement.key === key &&
        movement.source === source &&
        movement.destination ===
          pickerSourceDestination(sources, source, key)
      );
    }),
  );
}

function commitPickerPresentation(
  presentation: GitHubPickerPresentation,
  runtime: GitHubPickerPresentationRuntime,
): GitHubPickerPublication | null {
  if (!pickerPresentationFactsMatch(presentation) || !pickerPresentationDomIsExact(presentation, runtime)) return null;
  const root = runtime.elements.root;
  const sourceGroup = runtime.elements.sourceGroup;
  const tabGist = runtime.elements.tabGist;
  const tabRepo = runtime.elements.tabRepo;
  const RootElement = root?.ownerDocument.defaultView?.HTMLDivElement;
  const ButtonElement = root?.ownerDocument.defaultView?.HTMLButtonElement;
  if (
    !RootElement ||
    !ButtonElement ||
    !(root instanceof RootElement) ||
    !(sourceGroup instanceof RootElement) ||
    !(tabGist instanceof ButtonElement) ||
    !(tabRepo instanceof ButtonElement) ||
    !root.parentNode
  ) {
    return null;
  }
  const identity = Symbol("github-picker-publication");
  const sources = Object.freeze(
    presentation.sourceOrder.map((source, index) =>
      Object.freeze<PickerPublishedSource>({
        identity: Symbol(`github-picker-source-${source}`),
        publicationIdentity: identity,
        source,
        index,
        selected: presentation.tab === source,
        enabled: !presentation.busy,
        element: source === "gist" ? tabGist : tabRepo,
      }),
    ),
  );
  const navigationKeys = Object.freeze<readonly PickerSourceNavigationKey[]>([
    "ArrowLeft",
    "ArrowUp",
    "ArrowRight",
    "ArrowDown",
    "Home",
    "End",
  ]);
  const movements = Object.freeze(
    sources.flatMap((source) =>
      navigationKeys.map((key) =>
        Object.freeze<PickerSourceMovement>({
          identity: Symbol(`github-picker-source-movement-${source.source}-${key}`),
          key,
          source,
          destination: pickerSourceDestination(sources, source, key),
        }),
      ),
    ),
  );
  return Object.freeze({
    identity,
    presentation,
    runtime,
    ownerDocument: root.ownerDocument,
    sourceGroup,
    sources,
    movements,
    keyboard: captureCommitActionKeyboardAuthority(root.ownerDocument),
    rootParent: root.parentNode,
    previousSibling: root.previousSibling,
    nextSibling: root.nextSibling,
    dom: snapshotPickerDom(root),
  });
}

function pickerReplayFactsMatch(
  source: GitHubPickerPresentation,
  successor: GitHubPickerPresentation,
): boolean {
  return (
    source.identity !== successor.identity &&
    successor.revision === source.revision + 1 &&
    source.mount === successor.mount &&
    source.visit === successor.visit &&
    source.mode === successor.mode &&
    source.document === successor.document &&
    source.documentId === successor.documentId &&
    source.documentTitle === successor.documentTitle &&
    source.githubAvailable === successor.githubAvailable &&
    source.githubConfigured === successor.githubConfigured &&
    source.sourceOrder === successor.sourceOrder &&
    source.tab === successor.tab &&
    source.filter === successor.filter &&
    source.gistChoiceName === successor.gistChoiceName &&
    source.newGist === successor.newGist &&
    source.gistName === successor.gistName &&
    source.gistPublic === successor.gistPublic &&
    source.selectedRepo === successor.selectedRepo &&
    source.branch === successor.branch &&
    source.path === successor.path &&
    source.busy === successor.busy &&
    source.actionError === successor.actionError &&
    source.operation === successor.operation &&
    source.callbacks === successor.callbacks &&
    source.gists === successor.gists &&
    source.gistRows === successor.gistRows &&
    source.repositories === successor.repositories &&
    source.repositoryRows === successor.repositoryRows &&
    source.branches === successor.branches &&
    source.files === successor.files &&
    source.fileRows === successor.fileRows &&
    pickerPresentationFactsMatch(source) &&
    pickerPresentationFactsMatch(successor)
  );
}

function pickerSyntheticEventShape(
  event: unknown,
  reactName: "onClick" | "onChange" | "onSubmit",
  defaultPrevented: boolean,
): boolean {
  if (typeof event !== "object" || event === null) return false;
  const candidate = event as {
    _reactName?: unknown;
    isDefaultPrevented?: unknown;
    isPropagationStopped?: unknown;
    persist?: unknown;
  };
  return (
    candidate._reactName === reactName &&
    typeof candidate.isDefaultPrevented === "function" &&
    candidate.isDefaultPrevented() === defaultPrevented &&
    typeof candidate.isPropagationStopped === "function" &&
    candidate.isPropagationStopped() === false &&
    typeof candidate.persist === "function"
  );
}

function exactPickerEventPath(
  nativeEvent: Event,
  target: EventTarget,
  control: HTMLElement,
  publication: GitHubPickerPublication,
): boolean {
  const root = publication.runtime.elements.root;
  const ownerWindow = publication.ownerDocument.defaultView;
  if (
    !ownerWindow ||
    !(root instanceof ownerWindow.HTMLDivElement) ||
    !root.isConnected ||
    root.ownerDocument !== publication.ownerDocument
  ) {
    return false;
  }
  const path = nativeEvent.composedPath();
  return path[0] === target && path.includes(control) && path.includes(root);
}

function pickerNativeMouseConstructorMatches(
  nativeEvent: MouseEvent,
  ownerWindow: Window & typeof globalThis,
): boolean {
  const PointerEventConstructor = ownerWindow.PointerEvent;
  return (
    nativeEvent.constructor === ownerWindow.MouseEvent ||
    (!!PointerEventConstructor && nativeEvent.constructor === PointerEventConstructor)
  );
}

function exactPickerClick(
  event: ReactMouseEvent<HTMLButtonElement>,
  control: HTMLButtonElement,
  publication: GitHubPickerPublication,
): boolean {
  if (!event || typeof event !== "object") return false;
  const ownerDocument = publication.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  const target = event.target;
  return (
    !!ownerWindow &&
    pickerSyntheticEventShape(event, "onClick", false) &&
    event.type === "click" &&
    event.button === nativeEvent.button &&
    nativeEvent.bubbles &&
    event.bubbles === nativeEvent.bubbles &&
    event.cancelable === nativeEvent.cancelable &&
    event.eventPhase === nativeEvent.eventPhase &&
    event.currentTarget === control &&
    !event.defaultPrevented &&
    nativeEvent instanceof ownerWindow.MouseEvent &&
    pickerNativeMouseConstructorMatches(nativeEvent, ownerWindow) &&
    nativeEvent.type === "click" &&
    nativeEvent.button === 0 &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    !nativeEvent.defaultPrevented &&
    target instanceof ownerWindow.Node &&
    target === nativeEvent.target &&
    target.ownerDocument === ownerDocument &&
    control.ownerDocument === ownerDocument &&
    control.isConnected &&
    !control.disabled &&
    control.contains(target) &&
    exactPickerEventPath(nativeEvent, target, control, publication)
  );
}

function exactPickerChange<T extends HTMLInputElement | HTMLSelectElement>(
  event: ReactChangeEvent<T>,
  control: T,
  publication: GitHubPickerPublication,
): boolean {
  if (!event || typeof event !== "object") return false;
  const ownerDocument = publication.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  const checkableInput =
    control.tagName === "INPUT" &&
    ((control as HTMLInputElement).type === "checkbox" || (control as HTMLInputElement).type === "radio");
  const controlIsUsable =
    control.ownerDocument === ownerDocument &&
    control.isConnected &&
    !control.disabled;
  const nativeTypeAllowed = Boolean(
    ownerWindow &&
      ((nativeEvent.type === "change" && nativeEvent.constructor === ownerWindow.Event) ||
        (nativeEvent.type === "input" &&
          (nativeEvent.constructor === ownerWindow.Event ||
            (!!ownerWindow.InputEvent && nativeEvent.constructor === ownerWindow.InputEvent))) ||
        (checkableInput &&
          nativeEvent.type === "click" &&
          nativeEvent instanceof ownerWindow.MouseEvent &&
          pickerNativeMouseConstructorMatches(nativeEvent, ownerWindow))),
  );
  return (
    !!ownerWindow &&
    pickerSyntheticEventShape(event, "onChange", false) &&
    event.type === "change" &&
    nativeEvent.bubbles &&
    event.bubbles === nativeEvent.bubbles &&
    event.cancelable === nativeEvent.cancelable &&
    event.eventPhase === nativeEvent.eventPhase &&
    event.currentTarget === control &&
    event.target === control &&
    !event.defaultPrevented &&
    nativeEvent instanceof ownerWindow.Event &&
    nativeTypeAllowed &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    nativeEvent.target === control &&
    !nativeEvent.defaultPrevented &&
    controlIsUsable &&
    exactPickerEventPath(nativeEvent, control, control, publication)
  );
}

function exactPickerSubmit(
  event: ReactFormEvent<HTMLFormElement>,
  form: HTMLFormElement,
  submit: HTMLButtonElement,
  publication: GitHubPickerPublication,
): boolean {
  if (!event || typeof event !== "object") return false;
  const ownerDocument = publication.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  return (
    !!ownerWindow?.SubmitEvent &&
    pickerSyntheticEventShape(event, "onSubmit", true) &&
    event.type === "submit" &&
    nativeEvent.bubbles &&
    event.bubbles === nativeEvent.bubbles &&
    event.cancelable === nativeEvent.cancelable &&
    event.eventPhase === nativeEvent.eventPhase &&
    event.currentTarget === form &&
    event.target === form &&
    event.defaultPrevented &&
    nativeEvent instanceof ownerWindow.SubmitEvent &&
    nativeEvent.constructor === ownerWindow.SubmitEvent &&
    nativeEvent.type === "submit" &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    nativeEvent.target === form &&
    nativeEvent.defaultPrevented &&
    (nativeEvent.submitter === null || nativeEvent.submitter === submit) &&
    form.ownerDocument === ownerDocument &&
    form.isConnected &&
    submit.ownerDocument === ownerDocument &&
    submit.isConnected &&
    !submit.disabled &&
    submit.form === form &&
    form.contains(submit) &&
    exactPickerEventPath(nativeEvent, form, form, publication)
  );
}

/** Connect a document to a gist or repository file, or pick a file to import. */
export function GitHubPicker(props: GitHubPickerProps) {
  const documentKey = props.mode === "link" ? (props.doc?.id ?? "missing") : "import";
  return <GitHubPickerVisit key={`${props.mode}:${documentKey}`} {...props} />;
}

function GitHubPickerVisit({
  mode,
  doc,
  onLinked,
  onImported,
  githubAvailable,
  githubConfigured,
}: GitHubPickerProps) {
  const [mount] = useState(() => Symbol("github-picker"));
  const gistChoiceName = useId();
  const [tab, setTab] = useState<Tab>("gist");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyOperation, setBusyOperation] = useState<GitHubPickerOperation | null>(null);
  const busy = busyOperation !== null;
  const [filter, setFilter] = useState("");
  // gist state
  const [newGist, setNewGist] = useState(mode === "link");
  const [gistName, setGistName] = useState(`${(doc?.title ?? "document").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document"}.md`);
  const [gistPublic, setGistPublic] = useState(false);
  // repo state
  const [repo, setRepo] = useState<RepoItem | null>(null);
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState("");
  const [visit] = useState(() => ++githubPickerVisitSequence);
  const gistAuthority = useMemo<ListLoadAuthority | null>(
    () => (githubAvailable && tab === "gist" ? { kind: "gists", visit } : null),
    [githubAvailable, tab, visit],
  );
  const repoAuthority = useMemo<ListLoadAuthority | null>(
    () => (githubAvailable && tab === "repo" && !repo ? { kind: "repositories", visit } : null),
    [githubAvailable, repo, tab, visit],
  );
  const branchAuthority = useMemo<ListLoadAuthority | null>(
    () =>
      githubAvailable && tab === "repo" && repo
        ? { kind: "branches", visit, owner: repo.owner, repo: repo.name, fullName: repo.fullName }
        : null,
    [githubAvailable, repo, tab, visit],
  );
  const fileAuthority = useMemo<ListLoadAuthority | null>(
    () =>
      githubAvailable && tab === "repo" && repo && branch
        ? { kind: "files", visit, owner: repo.owner, repo: repo.name, fullName: repo.fullName, branch }
        : null,
    [branch, githubAvailable, repo, tab, visit],
  );
  const { state: gistList, load: startGistLoad, invalidate: invalidateGistLoad } = useListLoad<GistItem>(gistAuthority);
  const { state: repoList, load: startRepoLoad, invalidate: invalidateRepoLoad } = useListLoad<RepoItem>(repoAuthority);
  const { state: branchList, load: startBranchLoad, invalidate: invalidateBranchLoad, reset: resetBranchLoad } = useListLoad<string>(branchAuthority);
  const { state: fileList, load: startFileLoad, invalidate: invalidateFileLoad, reset: resetFileLoad } = useListLoad<{ path: string }>(fileAuthority);
  const mountedRef = useRef(false);
  const activeOperationRef = useRef<GitHubPickerOperation | null>(null);
  const onLinkedRef = useRef(onLinked);
  const onImportedRef = useRef(onImported);
  const [publicationCoordinator] = useState(() => new GitHubPickerPublicationCoordinator());
  const [publicationRuntimes] = useState(() => new GitHubPickerRuntimeRegistry());
  const [publicationRevision, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeOperationRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    onLinkedRef.current = onLinked;
    onImportedRef.current = onImported;
  }, [onImported, onLinked]);

  const loadGists = useCallback(() => {
    if (!gistAuthority) return;
    startGistLoad(async () => (await api.github.gists()).gists, "Could not load gists.");
  }, [gistAuthority, startGistLoad]);

  const loadRepos = useCallback(() => {
    if (!repoAuthority) return;
    startRepoLoad(async () => (await api.github.repos()).repos, "Could not load repositories.");
  }, [repoAuthority, startRepoLoad]);

  const loadBranches = useCallback(() => {
    if (!branchAuthority || branchAuthority.kind !== "branches") return;
    const source = branchAuthority;
    startBranchLoad(
      async () => (await api.github.branches(source.owner, source.repo)).branches,
      `Could not load branches for ${source.fullName}.`,
    );
  }, [branchAuthority, startBranchLoad]);

  const loadFiles = useCallback(() => {
    if (!fileAuthority || fileAuthority.kind !== "files") return;
    const source = fileAuthority;
    startFileLoad(
      async () => (await api.github.files(source.owner, source.repo, source.branch)).files,
      `Could not load files from ${source.fullName} on ${source.branch}.`,
    );
  }, [fileAuthority, startFileLoad]);

  useEffect(() => {
    if (!githubAvailable) return;
    if (tab === "gist" && gistList.items === null && !gistList.error && !gistList.pending) {
      loadGists();
    }
    if (tab === "repo" && !repo && repoList.items === null && !repoList.error && !repoList.pending) {
      loadRepos();
    }
  }, [githubAvailable, gistList.error, gistList.items, gistList.pending, loadGists, loadRepos, repo, repoList.error, repoList.items, repoList.pending, tab]);

  useEffect(() => {
    if (tab === "repo" && repo && branchList.items === null && !branchList.error && !branchList.pending) loadBranches();
  }, [branchList.error, branchList.items, branchList.pending, loadBranches, repo, tab]);

  useEffect(() => {
    if (tab === "repo" && repo && branch && fileList.items === null && !fileList.error && !fileList.pending) loadFiles();
  }, [branch, fileList.error, fileList.items, fileList.pending, loadFiles, repo, tab]);

  const publishedGists = useMemo(() => pickerList(gistList, snapshotPickerGist), [gistList]);
  const publishedRepositories = useMemo(() => pickerList(repoList, snapshotPickerRepo), [repoList]);
  const publishedBranches = useMemo(() => pickerList(branchList, snapshotPickerBranch), [branchList]);
  const publishedFiles = useMemo(() => pickerList(fileList, snapshotPickerFile), [fileList]);
  const query = filter.toLowerCase();
  const gistRows = useMemo(
    () =>
      Object.freeze(
        publishedGists.items
          .filter(
            (gist) =>
              !query ||
              (gist.description ?? "").toLowerCase().includes(query) ||
              gist.files.some((file) => file.filename.toLowerCase().includes(query)),
          )
          .flatMap((gist) =>
            gist.files
              .filter((file) => /\.(md|markdown|mdx)$/i.test(file.filename) || file.language === "Markdown")
              .map((file) => ({ gist, file })),
          )
          .map(({ gist, file }, index) => Object.freeze({ index, gist, file })),
      ),
    [publishedGists, query],
  );
  const repositoryRows = useMemo(
    () =>
      Object.freeze(
        publishedRepositories.items.filter((item) => !query || item.fullName.toLowerCase().includes(query)),
      ),
    [publishedRepositories, query],
  );
  const fileRows = useMemo(
    () => Object.freeze(publishedFiles.items.filter((item) => !query || item.path.toLowerCase().includes(query))),
    [publishedFiles, query],
  );
  const selectedRepo = useMemo(() => (repo ? snapshotPickerRepo(repo, -1) : null), [repo]);
  const callbacks = useMemo(
    () =>
      Object.freeze<PickerCallbacks>({
        onLinked,
        onImported,
        loadGists,
        loadRepos,
        loadBranches,
        loadFiles,
        invalidateGistLoad,
        invalidateRepoLoad,
        invalidateBranchLoad,
        invalidateFileLoad,
        resetBranchLoad,
        resetFileLoad,
      }),
    [
      invalidateBranchLoad,
      invalidateFileLoad,
      invalidateGistLoad,
      invalidateRepoLoad,
      loadBranches,
      loadFiles,
      loadGists,
      loadRepos,
      onImported,
      onLinked,
      resetBranchLoad,
      resetFileLoad,
    ],
  );
  const presentation = useMemo(
    () =>
      Object.freeze<GitHubPickerPresentation>({
        identity: Object.freeze({}),
        revision: publicationRevision,
        mount,
        visit,
        mode,
        document: doc,
        documentId: mode === "link" ? (doc?.id ?? null) : null,
        documentTitle: mode === "link" ? (doc?.title ?? null) : null,
        githubAvailable,
        githubConfigured,
        sourceOrder: PICKER_SOURCE_ORDER,
        tab,
        filter,
        gistChoiceName,
        newGist,
        gistName,
        gistPublic,
        selectedRepo,
        branch,
        path,
        busy,
        actionError,
        operation: busyOperation,
        callbacks,
        gists: publishedGists,
        gistRows,
        repositories: publishedRepositories,
        repositoryRows,
        branches: publishedBranches,
        files: publishedFiles,
        fileRows,
      }),
    [
      actionError,
      branch,
      busy,
      busyOperation,
      callbacks,
      doc,
      fileRows,
      filter,
      githubAvailable,
      githubConfigured,
      gistChoiceName,
      gistName,
      gistPublic,
      gistRows,
      mode,
      mount,
      newGist,
      path,
      publicationRevision,
      publishedBranches,
      publishedFiles,
      publishedGists,
      publishedRepositories,
      repositoryRows,
      selectedRepo,
      tab,
      visit,
    ],
  );
  const identity = presentation.identity;

  const invalidateRuntime = useCallback(
    (runtime: GitHubPickerPresentationRuntime) => {
      runtime.expiry++;
      runtime.phase = "dead";
      const publication = runtime.publication;
      if (publication) publicationCoordinator.markRetired(publication);
      const replay = publicationCoordinator.replay();
      if (publication && replay?.source === publication) {
        replay.history.disconnect();
        publicationCoordinator.clearReplay(publication);
      } else {
        runtime.history?.disconnect();
      }
      runtime.history = null;
      if (publication) publicationCoordinator.clear(publication);
    },
    [publicationCoordinator],
  );

  const retireRuntime = useCallback(
    (
      runtime: GitHubPickerPresentationRuntime,
      reason: "element" | "layout" | "replacement" | "other",
    ) => {
      if (reason === "layout") runtime.layoutRetired = true;
      const publication = runtime.publication;
      if (
        !publication ||
        runtime.phase === "mounting" ||
        runtime.phase === "dead" ||
        runtime.phase === "successor-requested" ||
        publicationCoordinator.isRetired(publication)
      ) {
        return false;
      }
      publicationCoordinator.retire(publication);
      runtime.phase = reason === "replacement" ? "replacement-retired" : "layout-retired";
      runtime.replayExpected =
        reason === "layout"
          ? new Set(runtime.committedRefs?.keys())
          : reason === "element"
            ? new Set(runtime.mountReplayRefs)
            : new Set();
      runtime.replayDetached.clear();
      runtime.replayAttached.clear();
      const ticket = ++runtime.expiry;
      queueMicrotask(() => {
        if (
          runtime.expiry === ticket &&
          runtime.phase !== "active" &&
          runtime.phase !== "successor-requested" &&
          publicationCoordinator.replay()?.source !== publication
        ) {
          invalidateRuntime(runtime);
        }
      });
      return true;
    },
    [invalidateRuntime, publicationCoordinator],
  );

  const requestReplaySuccessor = useCallback(
    (runtime: GitHubPickerPresentationRuntime) => {
      const publication = runtime.publication;
      const history = runtime.history;
      if (
        runtime.phase !== "replay-ready" ||
        !publication ||
        !history ||
        !publicationCoordinator.isRetired(publication) ||
        publicationCoordinator.active() !== null ||
        publicationCoordinator.successorOf() !== publication ||
        publicationCoordinator.replay() !== null ||
        runtime.replayExpected.size === 0 ||
        runtime.replayDetached.size !== runtime.replayExpected.size ||
        runtime.replayAttached.size !== runtime.replayExpected.size ||
        !history.isPristine() ||
        !pickerPlacementMatches(publication) ||
        !pickerDomMatches(publication.dom, publication.ownerDocument) ||
        !pickerPresentationDomIsExact(publication.presentation, runtime)
      ) {
        invalidateRuntime(runtime);
        return;
      }
      runtime.phase = "successor-requested";
      publicationCoordinator.startReplay(Object.freeze({ source: publication, history }));
      const ticket = ++runtime.expiry;
      queueMicrotask(() => {
        if (
          runtime.expiry !== ticket ||
          runtime.phase !== "successor-requested" ||
          publicationCoordinator.replay()?.source !== publication
        ) {
          return;
        }
        if (
          !history.isPristine() ||
          !pickerPlacementMatches(publication) ||
          !pickerDomMatches(publication.dom, publication.ownerDocument) ||
          !pickerPresentationDomIsExact(publication.presentation, runtime)
        ) {
          invalidateRuntime(runtime);
          return;
        }
        history.disconnect();
        requestPublicationSuccessor();
      });
    },
    [invalidateRuntime, publicationCoordinator, requestPublicationSuccessor],
  );

  const noteRef = useCallback(
    (
      runtime: GitHubPickerPresentationRuntime,
      owner: PickerRefOwner,
      element: HTMLElement | null,
    ) => {
      if (owner.current === element) return;
      const previous = owner.current;
      owner.current = element;
      if (owner.kind === "element") {
        runtime.elements[owner.name] = element;
      } else {
        const map = runtime[owner.mapName] as Map<PickerMappedItem, HTMLElement>;
        if (element) map.set(owner.item, element);
        else map.delete(owner.item);
      }

      if (
        runtime.phase === "dead" ||
        runtime.phase === "successor-requested" ||
        runtime.phase === "replacement-retired"
      ) {
        return;
      }
      if (runtime.phase === "mounting") {
        if (owner.captured || previous !== null || element === null) {
          invalidateRuntime(runtime);
          return;
        }
        owner.captured = true;
        return;
      }

      if (runtime.phase === "active") {
        if (!runtime.mountReplayRefs.has(owner)) {
          retireRuntime(runtime, "replacement");
          return;
        }
        retireRuntime(runtime, "element");
      }
      const committed = runtime.committedRefs?.get(owner);
      if (!committed || !runtime.replayExpected.has(owner)) {
        invalidateRuntime(runtime);
        return;
      }
      if (!runtime.layoutRetired) {
        if (
          previous === committed &&
          element === null &&
          !runtime.replayDetached.has(owner) &&
          !runtime.replayAttached.has(owner)
        ) {
          runtime.replayDetached.add(owner);
        } else if (
          previous === null &&
          element === committed &&
          runtime.replayDetached.has(owner) &&
          !runtime.replayAttached.has(owner)
        ) {
          runtime.replayAttached.add(owner);
        } else {
          invalidateRuntime(runtime);
          return;
        }
        if (
          runtime.replayDetached.size === runtime.replayExpected.size &&
          runtime.replayAttached.size === runtime.replayExpected.size
        ) {
          runtime.phase = "replay-ready";
          requestReplaySuccessor(runtime);
        }
        return;
      }
      if (runtime.phase === "layout-retired") {
        if (
          previous !== committed ||
          element !== null ||
          runtime.replayDetached.has(owner) ||
          runtime.replayAttached.size > 0
        ) {
          invalidateRuntime(runtime);
          return;
        }
        runtime.replayDetached.add(owner);
        if (runtime.replayDetached.size === runtime.replayExpected.size) runtime.phase = "refs-detached";
        return;
      }
      if (
        runtime.phase !== "refs-detached" ||
        previous !== null ||
        element !== committed ||
        !runtime.replayDetached.has(owner) ||
        runtime.replayAttached.has(owner)
      ) {
        invalidateRuntime(runtime);
        return;
      }
      runtime.replayAttached.add(owner);
      if (runtime.replayAttached.size === runtime.replayExpected.size) {
        runtime.phase = "replay-ready";
        if (!runtime.layoutRetired) requestReplaySuccessor(runtime);
      }
    },
    [invalidateRuntime, requestReplaySuccessor, retireRuntime],
  );

  const elementRef = useCallback(
    (candidate: GitHubPickerPresentation, name: PickerElementName) => {
      const runtime = publicationRuntimes.for(candidate);
      let owner = runtime.elementOwners.get(name);
      if (!owner) {
        owner = {
          kind: "element",
          name,
          current: null,
          captured: false,
          capture: (element) => noteRef(runtime, owner!, element),
        };
        runtime.elementOwners.set(name, owner);
        runtime.owners.push(owner);
      }
      return owner.capture;
    },
    [noteRef, publicationRuntimes],
  );

  const mappedElementRef = useCallback(
    <T extends PickerGistRowPresentation | PickerRepoPresentation | PickerBranchPresentation | PickerFilePresentation>(
      candidate: GitHubPickerPresentation,
      mapName: PickerMappedElementName,
      item: T,
    ) => {
      const runtime = publicationRuntimes.for(candidate);
      let owner = runtime.mappedOwners.get(item);
      if (!owner) {
        owner = {
          kind: "mapped",
          mapName,
          item,
          current: null,
          captured: false,
          capture: (element) => noteRef(runtime, owner!, element),
        };
        runtime.mappedOwners.set(item, owner);
        runtime.owners.push(owner);
      }
      return owner.capture;
    },
    [noteRef, publicationRuntimes],
  );

  const presentationIsCurrent = useCallback(
    (candidate: GitHubPickerPresentation) =>
      candidate === presentation &&
      candidate.identity === identity &&
      candidate.revision === publicationRevision &&
      candidate.mount === mount &&
      candidate.visit === visit &&
      candidate.mode === mode &&
      candidate.document === doc &&
      candidate.documentId === (mode === "link" ? (doc?.id ?? null) : null) &&
      candidate.documentTitle === (mode === "link" ? (doc?.title ?? null) : null) &&
      candidate.githubAvailable === githubAvailable &&
      candidate.githubConfigured === githubConfigured &&
      candidate.tab === tab &&
      candidate.filter === filter &&
      candidate.gistChoiceName === gistChoiceName &&
      candidate.newGist === newGist &&
      candidate.gistName === gistName &&
      candidate.gistPublic === gistPublic &&
      (candidate.selectedRepo?.source ?? null) === repo &&
      candidate.branch === branch &&
      candidate.path === path &&
      candidate.busy === busy &&
      candidate.actionError === actionError &&
      candidate.operation === activeOperationRef.current &&
      candidate.gists.state === gistList &&
      candidate.repositories.state === repoList &&
      candidate.branches.state === branchList &&
      candidate.files.state === fileList &&
      candidate.callbacks === callbacks &&
      candidate.callbacks.onLinked === onLinked &&
      candidate.callbacks.onImported === onImported &&
      candidate.callbacks.onLinked === onLinkedRef.current &&
      candidate.callbacks.onImported === onImportedRef.current &&
      pickerPresentationFactsMatch(candidate),
    [
      actionError,
      branch,
      branchList,
      busy,
      callbacks,
      doc,
      fileList,
      filter,
      gistChoiceName,
      gistList,
      gistName,
      gistPublic,
      githubAvailable,
      githubConfigured,
      identity,
      mode,
      mount,
      newGist,
      onImported,
      onLinked,
      path,
      presentation,
      publicationRevision,
      repo,
      repoList,
      tab,
      visit,
    ],
  );

  const replayRefsAreExact = (
    source: GitHubPickerPresentationRuntime,
    successor: GitHubPickerPresentationRuntime,
  ) => {
    const committed = source.committedRefs;
    if (
      !committed ||
      source.owners.length !== committed.size ||
      successor.owners.length !== source.owners.length
    ) {
      return false;
    }
    for (let index = 0; index < source.owners.length; index++) {
      const previous = source.owners[index];
      const current = successor.owners[index];
      if (
        !previous ||
        !current ||
        previous.kind !== current.kind ||
        current.current !== committed.get(previous) ||
        (previous.kind === "element" &&
          (current.kind !== "element" || previous.name !== current.name)) ||
        (previous.kind === "mapped" &&
          (current.kind !== "mapped" ||
            previous.mapName !== current.mapName ||
            previous.item !== current.item))
      ) {
        return false;
      }
    }
    return true;
  };

  const releasePublication = useCallback(
    (publication: GitHubPickerPublication) => {
      const replay = publicationCoordinator.replay();
      if (replay?.source === publication) {
        replay.history.disconnect();
        publicationCoordinator.clearReplay(publication);
      } else {
        publication.runtime.history?.disconnect();
      }
      publication.runtime.history = null;
      publication.runtime.phase = "dead";
      publication.runtime.expiry++;
      publicationCoordinator.clear(publication);
    },
    [publicationCoordinator],
  );

  useLayoutEffect(() => {
    const runtime = publicationRuntimes.for(presentation);
    if (!presentationIsCurrent(presentation)) {
      invalidateRuntime(runtime);
      return;
    }

    if (runtime.phase === "replay-ready") {
      if (!runtime.layoutRetired) {
        invalidateRuntime(runtime);
        return;
      }
      requestReplaySuccessor(runtime);
      return;
    }

    if (runtime.phase !== "mounting") {
      invalidateRuntime(runtime);
      return;
    }
    if (
      runtime.owners.length === 0 ||
      runtime.owners.some((owner) => !owner.captured || !owner.current) ||
      presentation.mount !== mount ||
      presentation.revision !== publicationRevision ||
      presentation.visit !== visit ||
      presentation.mode !== mode ||
      presentation.document !== doc ||
      presentation.githubAvailable !== githubAvailable ||
      presentation.githubConfigured !== githubConfigured ||
      presentation.tab !== tab ||
      presentation.filter !== filter ||
      presentation.gistChoiceName !== gistChoiceName ||
      presentation.newGist !== newGist ||
      presentation.gistName !== gistName ||
      presentation.gistPublic !== gistPublic ||
      (presentation.selectedRepo?.source ?? null) !== repo ||
      presentation.branch !== branch ||
      presentation.path !== path ||
      presentation.busy !== busy ||
      presentation.actionError !== actionError ||
      presentation.operation !== activeOperationRef.current ||
      presentation.gists.state !== gistList ||
      presentation.repositories.state !== repoList ||
      presentation.branches.state !== branchList ||
      presentation.files.state !== fileList ||
      presentation.callbacks.onLinked !== onLinkedRef.current ||
      presentation.callbacks.onImported !== onImportedRef.current
    ) {
      invalidateRuntime(runtime);
      return;
    }
    const publication = commitPickerPresentation(presentation, runtime);
    if (!publication) {
      invalidateRuntime(runtime);
      return;
    }

    let transitionSource: GitHubPickerPublication | null = null;
    const replay = publicationCoordinator.replay();
    if (replay) {
      transitionSource = replay.source;
      const sameFacts = pickerReplayFactsMatch(replay.source.presentation, presentation);
      const exactReplay =
        sameFacts &&
        publicationCoordinator.isRetired(replay.source) &&
        publicationCoordinator.successorOf() === replay.source &&
        replay.source.runtime.phase === "successor-requested" &&
        replay.history.isPristine() &&
        pickerPlacementMatches(replay.source) &&
        pickerDomMatches(replay.source.dom, replay.source.ownerDocument) &&
        replayRefsAreExact(replay.source.runtime, runtime);
      releasePublication(replay.source);
      if (sameFacts && !exactReplay) {
        invalidateRuntime(runtime);
        return;
      }
    } else {
      const successorOf = publicationCoordinator.successorOf();
      if (successorOf) {
        transitionSource = successorOf;
        releasePublication(successorOf);
      }
    }

    const previous = publicationCoordinator.active();
    if (previous && previous !== publication) {
      retireRuntime(previous.runtime, "other");
      if (publicationCoordinator.active()) {
        invalidateRuntime(runtime);
        return;
      }
      releasePublication(previous);
    }
    runtime.publication = publication;
    runtime.committedRefs = new Map(
      runtime.owners.map((owner) => [owner, owner.current!] as const),
    );
    const previousNodes = transitionSource
      ? pickerSnapshotNodes(transitionSource.dom)
      : new Set<Node>();
    runtime.mountReplayRefs = new Set(
      runtime.owners.filter((owner) => !previousNodes.has(owner.current!)),
    );
    runtime.history = new PickerMutationHistory(publication);
    if (
      !runtime.history.isPristine() ||
      !pickerPlacementMatches(publication) ||
      !pickerDomMatches(publication.dom, publication.ownerDocument) ||
      !pickerPresentationDomIsExact(presentation, runtime)
    ) {
      invalidateRuntime(runtime);
      return;
    }
    runtime.phase = "active";
    publicationCoordinator.publish(publication);
    return () => {
      retireRuntime(runtime, "layout");
    };
  }, [
    actionError,
    branch,
    branchList,
    busy,
    callbacks,
    doc,
    fileList,
    filter,
    gistChoiceName,
    gistList,
    gistName,
    gistPublic,
    githubAvailable,
    githubConfigured,
    identity,
    invalidateRuntime,
    mode,
    mount,
    newGist,
    path,
    presentation,
    presentationIsCurrent,
    publicationCoordinator,
    publicationRuntimes,
    publicationRevision,
    releasePublication,
    repo,
    repoList,
    requestPublicationSuccessor,
    requestReplaySuccessor,
    retireRuntime,
    tab,
    visit,
  ]);

  const currentPresentation = (
    candidate: GitHubPickerPresentation,
    changing: PickerChangingControl = null,
  ): GitHubPickerPublication | null => {
    const publication = publicationCoordinator.active();
    if (
      !publication ||
      publication.presentation !== candidate ||
      publication.runtime !== publicationRuntimes.get(candidate)
    ) {
      return null;
    }
    const runtime = publication.runtime;
    if (
      runtime.phase !== "active" ||
      runtime.claimed ||
      publicationCoordinator.isRetired(publication) ||
      !presentationIsCurrent(candidate) ||
      !runtime.history?.isPristine(true) ||
      !pickerPlacementMatches(publication) ||
      !pickerPresentationDomIsExact(candidate, runtime, changing) ||
      !pickerDomMatches(publication.dom, publication.ownerDocument)
    ) {
      invalidateRuntime(runtime);
      return null;
    }
    return publication;
  };

  const claimMouse = (
    candidate: GitHubPickerPresentation,
    event: ReactMouseEvent<HTMLButtonElement>,
    expected: HTMLButtonElement | null | undefined,
  ): GitHubPickerPublication | null => {
    const runtime = publicationRuntimes.get(candidate);
    const activePublication = publicationCoordinator.active();
    const nativeEvent = event?.nativeEvent;
    if (
      !runtime ||
      runtime.claimed ||
      !activePublication ||
      activePublication.presentation !== candidate ||
      activePublication.runtime !== runtime ||
      !expected ||
      !exactPickerClick(event, expected, activePublication) ||
      publicationCoordinator.hasClaimed(event) ||
      publicationCoordinator.hasClaimed(nativeEvent)
    ) {
      return null;
    }
    const publication = currentPresentation(candidate);
    if (!publication || publication.runtime !== runtime) return null;
    runtime.claimed = true;
    publicationCoordinator.claim(event);
    publicationCoordinator.claim(nativeEvent);
    return publication;
  };

  const claimChange = <T extends HTMLInputElement | HTMLSelectElement>(
    candidate: GitHubPickerPresentation,
    event: ReactChangeEvent<T>,
    expected: T | null,
    changing: Exclude<PickerChangingControl, null>,
    destinationMatches: (control: T) => boolean,
  ): GitHubPickerPublication | null => {
    const runtime = publicationRuntimes.get(candidate);
    const activePublication = publicationCoordinator.active();
    if (
      !runtime ||
      runtime.claimed ||
      !activePublication ||
      activePublication.presentation !== candidate ||
      activePublication.runtime !== runtime ||
      !expected ||
      !exactPickerChange(event, expected, activePublication) ||
      !destinationMatches(expected) ||
      publicationCoordinator.hasClaimed(event) ||
      publicationCoordinator.hasClaimed(event.nativeEvent)
    ) {
      return null;
    }
    const publication = currentPresentation(candidate, changing);
    if (!publication || publication.runtime !== runtime) return null;
    runtime.claimed = true;
    publicationCoordinator.claim(event);
    publicationCoordinator.claim(event.nativeEvent);
    return publication;
  };

  const claimSubmit = (
    candidate: GitHubPickerPresentation,
    event: ReactFormEvent<HTMLFormElement>,
  ): GitHubPickerPublication | null => {
    const runtime = publicationRuntimes.get(candidate);
    const activePublication = publicationCoordinator.active();
    const form = runtime?.elements.pathForm;
    const submit = runtime?.elements.pathSubmit;
    const ownerWindow = form?.ownerDocument.defaultView;
    if (
      !runtime ||
      runtime.claimed ||
      !activePublication ||
      activePublication.presentation !== candidate ||
      activePublication.runtime !== runtime ||
      !ownerWindow ||
      !(form instanceof ownerWindow.HTMLFormElement) ||
      !(submit instanceof ownerWindow.HTMLButtonElement) ||
      !exactPickerSubmit(event, form, submit, activePublication) ||
      publicationCoordinator.hasClaimed(event) ||
      publicationCoordinator.hasClaimed(event.nativeEvent)
    ) {
      return null;
    }
    const publication = currentPresentation(candidate);
    if (
      !publication ||
      publication.runtime !== runtime ||
      candidate.mode !== "link" ||
      !candidate.path.trim()
    ) {
      return null;
    }
    runtime.claimed = true;
    publicationCoordinator.claim(event);
    publicationCoordinator.claim(event.nativeEvent);
    return publication;
  };

  const run = (candidate: GitHubPickerPresentation, action: GitHubPickerAction) => {
    const documentId = candidate.documentId;
    if (candidate.mode === "link" && !documentId) {
      setActionError("Something went wrong");
      return;
    }
    const operation = Object.freeze<GitHubPickerOperation>({
      id: ++githubPickerOperationSequence,
      visit: candidate.visit,
      mode: candidate.mode,
      documentId,
      action,
    });
    activeOperationRef.current = operation;
    setBusyOperation(operation);
    setActionError(null);

    const isCurrent = () =>
      mountedRef.current &&
      activeOperationRef.current === operation &&
      operation.visit === visit &&
      operation.mode === mode &&
      operation.documentId === (mode === "link" ? (doc?.id ?? null) : null);

    void (async () => {
      try {
        switch (operation.action.kind) {
          case "gist-import": {
            const res = await api.import(operation.action.payload);
            if (isCurrent()) onImportedRef.current?.(res.document.id);
            break;
          }
          case "gist-link": {
            const res = await api.documents.link(operation.documentId!, operation.action.payload);
            if (isCurrent()) onLinkedRef.current?.(res.document);
            break;
          }
          case "repo-import": {
            const res = await api.import(operation.action.payload);
            if (isCurrent()) onImportedRef.current?.(res.document.id);
            break;
          }
          case "repo-link": {
            const res = await api.documents.link(operation.documentId!, operation.action.payload);
            if (isCurrent()) onLinkedRef.current?.(res.document);
            break;
          }
        }
      } catch (error) {
        if (isCurrent()) setActionError(apiErrorText(error, "Something went wrong"));
      } finally {
        if (!isCurrent()) return;
        activeOperationRef.current = null;
        setBusyOperation((current) => (current === operation ? null : current));
      }
    })();
  };

  const linkGist = (
    candidate: GitHubPickerPresentation,
    gistId?: string,
    filename?: string,
  ) => {
    if (candidate.mode === "import") {
      const payload = Object.freeze({ source: "gist" as const, gistId, filename });
      run(candidate, Object.freeze({ kind: "gist-import" as const, payload }));
      return;
    }
    if (!candidate.document || (!filename && !candidate.gistName.trim())) {
      setActionError("Something went wrong");
      return;
    }
    const payload = Object.freeze({
      storage: "gist" as const,
      gistId,
      filename: filename ?? candidate.gistName,
      isPublic: candidate.gistPublic,
      description: candidate.documentTitle!,
    });
    run(candidate, Object.freeze({ kind: "gist-link" as const, payload }));
  };

  const linkRepo = (candidate: GitHubPickerPresentation, filePath: string) => {
    const destination = candidate.selectedRepo;
    if (!destination || !candidate.branch || !filePath.trim()) {
      setActionError("Something went wrong");
      return;
    }
    if (candidate.mode === "import") {
      const payload = Object.freeze({
        source: "repo" as const,
        owner: destination.owner,
        repo: destination.name,
        branch: candidate.branch,
        path: filePath,
      });
      run(candidate, Object.freeze({ kind: "repo-import" as const, payload }));
      return;
    }
    if (!candidate.document) {
      setActionError("Something went wrong");
      return;
    }
    const payload = Object.freeze({
      storage: "repo" as const,
      owner: destination.owner,
      repo: destination.name,
      branch: candidate.branch,
      path: filePath,
    });
    run(candidate, Object.freeze({ kind: "repo-link" as const, payload }));
  };

  const sourceNavigationIsCurrent = (
    publication: GitHubPickerPublication,
    movement: PickerSourceMovement,
    activeElement: HTMLButtonElement,
  ) => {
    const authority = publication.keyboard;
    const destination = movement.destination;
    if (
      !authority ||
      !destination ||
      currentPresentation(presentation) !== publication ||
      !pickerPublishedSourcesAreCurrent(publication) ||
      !publication.movements.includes(movement) ||
      !publication.sources.includes(movement.source) ||
      !publication.sources.includes(destination) ||
      movement.source.publicationIdentity !== publication.identity ||
      destination.publicationIdentity !== publication.identity ||
      !movement.source.enabled ||
      !destination.enabled ||
      movement.destination !==
        pickerSourceDestination(
          publication.sources,
          movement.source,
          movement.key,
        )
    ) {
      return false;
    }
    try {
      return (
        authority.isCurrent() &&
        commitActionKeyboardValue<Element | null>(
          authority,
          authority.activeElement,
          authority.ownerDocument,
        ) === activeElement
      );
    } catch {
      return false;
    }
  };
  const sourceNavigationDeliveriesMatch = (
    authority: CommitActionKeyboardAuthority,
    deliveries: readonly PickerSourceReactDelivery[],
  ) => {
    const [groupCapture, sourceCapture, sourceBubble, groupBubble] = deliveries;
    return (
      (!sourceCapture ||
        (!!groupCapture &&
          pickerSourceKeyboardEventsMatch(
            groupCapture.native,
            sourceCapture.native,
          ))) &&
      (!sourceBubble ||
        (!!sourceCapture &&
          sourceCapture.native.currentTarget ===
            sourceBubble.native.currentTarget &&
          commitActionKeyboardEventsMatch(
            sourceCapture.native,
            sourceBubble.native,
            authority,
          ))) &&
      (!groupBubble ||
        (!!sourceBubble &&
          pickerSourceKeyboardEventsMatch(
            sourceBubble.native,
            groupBubble.native,
          )))
    );
  };
  const sourceNavigationStageIsCurrent = (
    stages: PickerSourceNavigationStages,
    stage: PickerSourceNavigationStage,
    delivery: PickerSourceReactDelivery,
    movement: PickerSourceMovement,
  ) => {
    const publication = delivery.publication;
    const authority = publication.keyboard;
    const completed = [
      stages.groupCapture,
      stages.sourceCapture,
      stages.sourceBubble,
      stages.groupBubble,
    ].filter(
      (entry): entry is PickerSourceReactDelivery => entry !== null,
    );
    const expectedCompleted =
      stage === "group-capture"
        ? 0
        : stage === "source-capture"
          ? 1
          : stage === "source-bubble"
            ? 2
            : 3;
    const deliveries = [...completed, delivery];
    const expectedCurrentTarget =
      stage === "group-capture" || stage === "group-bubble"
        ? publication.sourceGroup
        : movement.source.element;
    if (
      !authority ||
      completed.length !== expectedCompleted ||
      !publicationCoordinator.sourceNavigationStageIsCurrent(stages, stage) ||
      stages.nativeEvent !== delivery.native.event ||
      (stages.publication !== null &&
        stages.publication !== publication) ||
      (stages.movement !== null && stages.movement !== movement) ||
      delivery.stage !== stage ||
      delivery.source !== movement.source ||
      delivery.currentTarget !== expectedCurrentTarget ||
      !movement.destination ||
      deliveries.some(
        (entry) =>
          entry.publication !== publication ||
          entry.source !== movement.source ||
          entry.native.event !== stages.nativeEvent,
      ) ||
      !sourceNavigationDeliveriesMatch(authority, deliveries) ||
      completed.some(
        (entry) =>
          !pickerSourceReactDeliveryRemains(
            entry,
            false,
            false,
            false,
            false,
          ),
      ) ||
      !pickerSourceReactDeliveryRemains(
        delivery,
        false,
        false,
        true,
        true,
      ) ||
      authority.terminal.proofFor(delivery.native.event) !==
        delivery.native.terminal ||
      !sourceNavigationIsCurrent(
        publication,
        movement,
        movement.source.element,
      )
    ) {
      return false;
    }
    return true;
  };
  const sourceNavigationDelivery = (
    stage: PickerSourceNavigationStage,
    event: ReactKeyboardEvent<HTMLElement>,
    currentTarget: HTMLElement,
  ) => {
    const publication = currentPresentation(presentation);
    const authority = publication?.keyboard;
    if (
      !publication ||
      !authority ||
      !pickerPublishedSourcesAreCurrent(publication)
    ) {
      return null;
    }
    let nativeEvent: Event;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return null;
    }
    const stages = publicationCoordinator.beginSourceNavigationStage(
      stage,
      nativeEvent,
    );
    if (!stages) return null;
    const reject = () => {
      publicationCoordinator.rejectSourceNavigationStage(stages);
      return null;
    };
    const phase =
      stage === "group-capture" || stage === "source-capture"
        ? authority.Event.CAPTURING_PHASE
        : authority.Event.BUBBLING_PHASE;
    const native = captureCommitActionKeyboardEvent(
      authority,
      nativeEvent,
      phase,
    );
    const delivery = native
      ? capturePickerSourceReactDelivery(
          stage,
          event,
          publication,
          native,
          currentTarget,
        )
      : null;
    const movement =
      stage === "group-capture"
        ? delivery?.publication.movements.find(
            (entry) =>
              entry.source === delivery.source &&
              entry.key === delivery.native.key,
          ) ?? null
        : stages.movement;
    if (
      !delivery ||
      !movement?.destination ||
      !sourceNavigationStageIsCurrent(stages, stage, delivery, movement)
    ) {
      return reject();
    }
    const defaultState =
      publicationCoordinator.invokeSourceNavigationStageCallback(
        stages,
        stage,
        () =>
          authority.apply(
            delivery.methods.isDefaultPrevented,
            delivery.wrapper,
            [],
          ),
      );
    if (
      defaultState?.value !== false ||
      !sourceNavigationStageIsCurrent(stages, stage, delivery, movement)
    ) {
      return reject();
    }
    const propagationState =
      publicationCoordinator.invokeSourceNavigationStageCallback(
        stages,
        stage,
        () =>
          authority.apply(
            delivery.methods.isPropagationStopped,
            delivery.wrapper,
            [],
          ),
      );
    if (
      propagationState?.value !== false ||
      !sourceNavigationStageIsCurrent(stages, stage, delivery, movement) ||
      !publicationCoordinator.completeSourceNavigationStage(
        stages,
        stage,
        delivery,
        movement,
      )
    ) {
      return reject();
    }
    return { stages, delivery, movement };
  };
  const sourceNavigationPairIsCurrent = (
    pair: PickerSourceNavigationPair,
    nativeDefaultPrevented: boolean,
    finalIsDefaultPrevented: (...args: never[]) => unknown =
      pair.groupBubble.methods.isDefaultPrevented,
  ) => {
    const {
      publication,
      authority,
      movement,
      groupCapture,
      sourceCapture,
      sourceBubble,
      groupBubble,
    } = pair;
    const deliveries = [
      groupCapture,
      sourceCapture,
      sourceBubble,
      groupBubble,
    ] as const;
    return (
      publicationCoordinator.sourceNavigationIsDelivering(pair) &&
      publication.keyboard === authority &&
      movement.destination !== null &&
      sourceNavigationDeliveriesMatch(authority, deliveries) &&
      deliveries.every((entry) => {
        const finalWrapper =
          entry.wrapper === groupBubble.wrapper &&
          nativeDefaultPrevented;
        return pickerSourceReactDeliveryRemains(
          entry,
          finalWrapper,
          nativeDefaultPrevented,
          entry === groupBubble,
          entry === groupBubble,
          finalWrapper
            ? finalIsDefaultPrevented
            : entry.methods.isDefaultPrevented,
          pair.terminal,
        );
      }) &&
      sourceNavigationIsCurrent(
        publication,
        movement,
        movement.source.element,
      )
    );
  };
  const sourceGroupCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    sourceNavigationDelivery(
      "group-capture",
      event,
      event.currentTarget,
    );
  };
  const sourceButtonCapture = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    sourceNavigationDelivery(
      "source-capture",
      event,
      event.currentTarget,
    );
  };
  const sourceButtonBubble = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    sourceNavigationDelivery(
      "source-bubble",
      event,
      event.currentTarget,
    );
  };
  const sourceGroupBubble = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const result = sourceNavigationDelivery(
      "group-bubble",
      event,
      event.currentTarget,
    );
    const { stages, delivery, movement } = result ?? {};
    const publication = delivery?.publication;
    const authority = publication?.keyboard;
    const destination = movement?.destination;
    const groupCapture = stages?.groupCapture;
    const sourceCapture = stages?.sourceCapture;
    const sourceBubble = stages?.sourceBubble;
    if (
      !stages ||
      !delivery ||
      !publication ||
      !authority ||
      !movement ||
      !destination ||
      !groupCapture ||
      !sourceCapture ||
      !sourceBubble ||
      stages.groupBubble !== delivery
    ) {
      return;
    }
    const pair: PickerSourceNavigationPair = Object.freeze({
      publication,
      authority,
      movement,
      groupCapture,
      sourceCapture,
      sourceBubble,
      groupBubble: delivery,
      terminal: delivery.native.terminal,
      publicationClaim: Object.freeze({ publication }),
      movementClaim: Object.freeze({ movement }),
      sourceClaim: Object.freeze({ source: movement.source }),
      destinationClaim: Object.freeze({ destination }),
    });
    if (!publicationCoordinator.claimSourceNavigation(pair)) return;
    try {
      if (!sourceNavigationPairIsCurrent(pair, false)) return;
      const prevention =
        publicationCoordinator.invokeSourceNavigationPairCallback(
          pair,
          () =>
            authority.apply(
              delivery.methods.preventDefault,
              delivery.wrapper,
              [],
            ),
        );
      if (!prevention) return;
      let finalIsDefaultPrevented: (...args: never[]) => unknown;
      try {
        finalIsDefaultPrevented = delivery.wrapper.isDefaultPrevented;
      } catch {
        return;
      }
      if (
        typeof finalIsDefaultPrevented !== "function" ||
        !sourceNavigationPairIsCurrent(
          pair,
          true,
          finalIsDefaultPrevented,
        )
      ) {
        return;
      }
      const defaultState =
        publicationCoordinator.invokeSourceNavigationPairCallback(
          pair,
          () =>
            authority.apply(
              finalIsDefaultPrevented,
              delivery.wrapper,
              [],
            ),
        );
      if (
        defaultState?.value !== true ||
        !sourceNavigationPairIsCurrent(
          pair,
          true,
          finalIsDefaultPrevented,
        )
      ) {
        return;
      }
      const propagationState =
        publicationCoordinator.invokeSourceNavigationPairCallback(
          pair,
          () =>
            authority.apply(
              delivery.methods.isPropagationStopped,
              delivery.wrapper,
              [],
            ),
        );
      if (
        propagationState?.value !== false ||
        !sourceNavigationPairIsCurrent(
          pair,
          true,
          finalIsDefaultPrevented,
        )
      ) {
        return;
      }
      authority.apply(authority.focus, destination.element, [
        PICKER_PREVENT_SCROLL,
      ]);
      sourceNavigationIsCurrent(
        publication,
        movement,
        destination.element,
      );
    } catch {
      return;
    } finally {
      publicationCoordinator.finishSourceNavigation(pair);
    }
  };

  if (!githubAvailable) {
    return <GitHubSignInPrompt githubConfigured={githubConfigured} />;
  }

  return (
    <div
      ref={elementRef(presentation, "root")}
      className="flex flex-col gap-3"
      data-testid="github-picker"
    >
      <div className="flex items-center gap-2">
        <div
          ref={elementRef(presentation, "sourceGroup")}
          role="group"
          aria-label={PICKER_SOURCE_LABEL}
          className="flex rounded-lg border border-line p-0.5"
          onKeyDownCapture={sourceGroupCapture}
          onKeyDown={sourceGroupBubble}
        >
          {presentation.sourceOrder.map((t) => (
            <button
              key={t}
              ref={elementRef(presentation, t === "gist" ? "tabGist" : "tabRepo")}
              type="button"
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium",
                presentation.tab === t ? "bg-inverse text-white" : "text-ink-2 hover:bg-surface-3",
              )}
              aria-pressed={presentation.tab === t}
              onKeyDownCapture={sourceButtonCapture}
              onKeyDown={sourceButtonBubble}
              onClick={(event) => {
                if (t === presentation.tab) return;
                const runtime = publicationRuntimes.get(presentation);
                const publication = claimMouse(
                  presentation,
                  event,
                  (runtime?.elements[t === "gist" ? "tabGist" : "tabRepo"] as HTMLButtonElement | null) ?? null,
                );
                if (!publication) return;
                if (presentation.tab === "gist") {
                  presentation.callbacks.invalidateGistLoad();
                } else if (presentation.selectedRepo) {
                  presentation.callbacks.invalidateBranchLoad();
                  presentation.callbacks.invalidateFileLoad();
                } else {
                  presentation.callbacks.invalidateRepoLoad();
                }
                setTab(t);
                setFilter("");
              }}
              disabled={presentation.busy}
              data-testid={`picker-tab-${t}`}
            >
              {t === "gist" ? "Gist" : "Repository"}
            </button>
          ))}
        </div>
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-2.5 text-ink-4" />
          <input
            ref={elementRef(presentation, "filter")}
            className="input pl-9"
            placeholder={
              presentation.tab === "gist"
                ? "Filter gists"
                : presentation.selectedRepo
                  ? "Filter files"
                  : "Filter repositories"
            }
            value={presentation.filter}
            disabled={presentation.busy}
            onChange={(event) => {
              const nextFilter = event.currentTarget.value;
              if (nextFilter === presentation.filter) return;
              const runtime = publicationRuntimes.get(presentation);
              if (
                !claimChange(
                  presentation,
                  event,
                  (runtime?.elements.filter as HTMLInputElement | null) ?? null,
                  "filter",
                  (control) => control.value === nextFilter,
                )
              ) {
                return;
              }
              setFilter(nextFilter);
            }}
          />
        </div>
      </div>
      {presentation.actionError && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40 wrap-anywhere" role="alert" aria-atomic="true" data-testid="github-action-error">
          {presentation.actionError}
        </div>
      )}

      {presentation.tab === "gist" && (
        <div className="flex flex-col gap-3">
          {presentation.mode === "link" && (
            <div className="rounded-xl border border-line p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-ink">
                <input
                  ref={elementRef(presentation, "newGist")}
                  type="radio"
                  name={presentation.gistChoiceName}
                  checked={presentation.newGist}
                  disabled={presentation.busy}
                  onChange={(event) => {
                    if (presentation.newGist) return;
                    const runtime = publicationRuntimes.get(presentation);
                    if (
                      !claimChange(
                        presentation,
                        event,
                        (runtime?.elements.newGist as HTMLInputElement | null) ?? null,
                        "newGist",
                        (control) =>
                          control.checked &&
                          (runtime?.elements.existingGist as HTMLInputElement | null)?.checked === false,
                      )
                    ) {
                      return;
                    }
                    setNewGist(true);
                  }}
                />{" "}
                Create a new gist
              </label>
              {presentation.newGist && (
                <div className="mt-3 flex items-center gap-2 pl-6">
                  <input
                    ref={elementRef(presentation, "gistName")}
                    className="input flex-1"
                    value={presentation.gistName}
                    disabled={presentation.busy}
                    onChange={(event) => {
                      const nextName = event.currentTarget.value;
                      if (nextName === presentation.gistName) return;
                      const runtime = publicationRuntimes.get(presentation);
                      if (
                        !claimChange(
                          presentation,
                          event,
                          (runtime?.elements.gistName as HTMLInputElement | null) ?? null,
                          "gistName",
                          (control) => control.value === nextName,
                        )
                      ) {
                        return;
                      }
                      setGistName(nextName);
                    }}
                    placeholder="filename.md"
                    data-testid="gist-filename"
                  />
                  <label className="flex items-center gap-1.5 text-sm text-ink-2">
                    <input
                      ref={elementRef(presentation, "gistPublic")}
                      type="checkbox"
                      checked={presentation.gistPublic}
                      disabled={presentation.busy}
                      onChange={(event) => {
                        const nextPublic = event.currentTarget.checked;
                        if (nextPublic === presentation.gistPublic) return;
                        const runtime = publicationRuntimes.get(presentation);
                        if (
                          !claimChange(
                            presentation,
                            event,
                            (runtime?.elements.gistPublic as HTMLInputElement | null) ?? null,
                            "gistPublic",
                            (control) => control.checked === nextPublic,
                          )
                        ) {
                          return;
                        }
                        setGistPublic(nextPublic);
                      }}
                    />{" "}
                    Public
                  </label>
                  <button
                    ref={elementRef(presentation, "gistCreate")}
                    type="button"
                    className="btn btn-primary"
                    disabled={presentation.busy || !presentation.gistName.trim()}
                    onClick={(event) => {
                      const runtime = publicationRuntimes.get(presentation);
                      if (
                        !claimMouse(
                          presentation,
                          event,
                          (runtime?.elements.gistCreate as HTMLButtonElement | null) ?? null,
                        )
                      ) {
                        return;
                      }
                      linkGist(presentation);
                    }}
                    data-testid="gist-create"
                  >
                    {presentation.busy ? <Loader2 size={16} className="animate-spin" /> : "Create & publish"}
                  </button>
                </div>
              )}
              <label className="mt-3 flex items-center gap-2 text-sm font-medium text-ink">
                <input
                  ref={elementRef(presentation, "existingGist")}
                  type="radio"
                  name={presentation.gistChoiceName}
                  checked={!presentation.newGist}
                  disabled={presentation.busy}
                  onChange={(event) => {
                    if (!presentation.newGist) return;
                    const runtime = publicationRuntimes.get(presentation);
                    if (
                      !claimChange(
                        presentation,
                        event,
                        (runtime?.elements.existingGist as HTMLInputElement | null) ?? null,
                        "newGist",
                        (control) =>
                          control.checked &&
                          (runtime?.elements.newGist as HTMLInputElement | null)?.checked === false,
                      )
                    ) {
                      return;
                    }
                    setNewGist(false);
                  }}
                />{" "}
                Use an existing gist
              </label>
            </div>
          )}
          {(presentation.mode === "import" || !presentation.newGist) && (
            <div
              ref={elementRef(presentation, "gistList")}
              className="scrollbar-thin max-h-72 overflow-y-auto rounded-xl border border-line"
              data-testid="gist-list"
            >
              {presentation.gists.error ? (
                <ListLoadError
                  error={presentation.gists.error}
                  pending={presentation.gists.pending}
                  onRetry={(event) => {
                    const runtime = publicationRuntimes.get(presentation);
                    if (
                      !claimMouse(
                        presentation,
                        event,
                        (runtime?.elements.gistRetry as HTMLButtonElement | null) ?? null,
                      )
                    ) {
                      return;
                    }
                    presentation.callbacks.loadGists();
                  }}
                  buttonRef={elementRef(presentation, "gistRetry")}
                  testId="gist-load-error"
                />
              ) : presentation.gists.sourceItems === null ? (
                <div className="flex justify-center py-8">
                  <Spinner />
                </div>
              ) : presentation.gistRows.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-ink-3">No Markdown gists found.</div>
              ) : (
                <ul ref={elementRef(presentation, "gistRows")} className="divide-y divide-line">
                  {presentation.gistRows.map((row) => (
                    <li key={row.gist.id + row.file.filename}>
                      <button
                        ref={mappedElementRef(presentation, "gistRows", row)}
                        type="button"
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2 disabled:opacity-50"
                        disabled={presentation.busy}
                        onClick={(event) => {
                          const runtime = publicationRuntimes.get(presentation);
                          if (!claimMouse(presentation, event, runtime?.gistRows.get(row))) return;
                          linkGist(presentation, row.gist.id, row.file.filename);
                        }}
                        data-testid="gist-item"
                      >
                        <FileText size={16} className="shrink-0 text-ink-4" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-ink" title={row.file.filename}>{row.file.filename}</div>
                          <div className="truncate text-xs text-ink-3" title={row.gist.description || row.gist.id}>{row.gist.description || row.gist.id}</div>
                        </div>
                        <span className="flex items-center gap-2 text-xs text-ink-4">
                          {!row.gist.public && <Lock size={12} />}
                          {relativeTime(row.gist.updatedAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {presentation.tab === "repo" && (
        <div className="flex flex-col gap-3">
          {!presentation.selectedRepo ? (
            <div
              ref={elementRef(presentation, "repositoryList")}
              className="scrollbar-thin max-h-80 overflow-y-auto rounded-xl border border-line"
              data-testid="repo-list"
            >
              {presentation.repositories.error ? (
                <ListLoadError
                  error={presentation.repositories.error}
                  pending={presentation.repositories.pending}
                  onRetry={(event) => {
                    const runtime = publicationRuntimes.get(presentation);
                    if (
                      !claimMouse(
                        presentation,
                        event,
                        (runtime?.elements.repositoryRetry as HTMLButtonElement | null) ?? null,
                      )
                    ) {
                      return;
                    }
                    presentation.callbacks.loadRepos();
                  }}
                  buttonRef={elementRef(presentation, "repositoryRetry")}
                  testId="repo-load-error"
                />
              ) : presentation.repositories.sourceItems === null ? (
                <div className="flex justify-center py-8">
                  <Spinner />
                </div>
              ) : presentation.repositoryRows.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-ink-3">No repositories found.</div>
              ) : (
                <ul
                  ref={elementRef(presentation, "repositoryRows")}
                  className="divide-y divide-line"
                >
                  {presentation.repositoryRows.map((row) => (
                    <li key={row.fullName}>
                      <button
                        ref={mappedElementRef(presentation, "repositoryRows", row)}
                        type="button"
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2 disabled:opacity-50"
                        onClick={(event) => {
                          const runtime = publicationRuntimes.get(presentation);
                          if (!claimMouse(presentation, event, runtime?.repositoryRows.get(row))) return;
                          presentation.callbacks.resetBranchLoad();
                          presentation.callbacks.resetFileLoad();
                          setRepo(row.value);
                          setBranch(row.defaultBranch);
                        }}
                        disabled={presentation.busy}
                        data-testid="repo-item"
                      >
                        <GitHubIcon size={16} className="shrink-0 text-ink-4" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-ink" title={row.fullName}>{row.fullName}</div>
                          {row.description && <div className="truncate text-xs text-ink-3" title={row.description}>{row.description}</div>}
                        </div>
                        <span className="flex items-center gap-2 text-xs text-ink-4">
                          {row.private && <Lock size={12} />}
                          {row.pushedAt && relativeTime(row.pushedAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm">
                <button
                  ref={elementRef(presentation, "repositoryBack")}
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={(event) => {
                    const runtime = publicationRuntimes.get(presentation);
                    if (
                      !claimMouse(
                        presentation,
                        event,
                        (runtime?.elements.repositoryBack as HTMLButtonElement | null) ?? null,
                      )
                    ) {
                      return;
                    }
                    presentation.callbacks.resetBranchLoad();
                    presentation.callbacks.resetFileLoad();
                    setRepo(null);
                    setBranch("");
                  }}
                  disabled={presentation.busy}
                >
                  ← Repositories
                </button>
                <span className="font-medium text-ink">{presentation.selectedRepo.fullName}</span>
                <div
                  ref={elementRef(presentation, "branchList")}
                  className="ml-auto inline-flex items-center gap-1.5 text-ink-3"
                  data-testid="branch-list"
                >
                  <GitBranch size={14} />
                  {presentation.branches.error ? (
                    <ListLoadError
                      error={presentation.branches.error}
                      pending={presentation.branches.pending}
                      onRetry={(event) => {
                        const runtime = publicationRuntimes.get(presentation);
                        if (
                          !claimMouse(
                            presentation,
                            event,
                            (runtime?.elements.branchRetry as HTMLButtonElement | null) ?? null,
                          )
                        ) {
                          return;
                        }
                        presentation.callbacks.loadBranches();
                      }}
                      buttonRef={elementRef(presentation, "branchRetry")}
                      testId="branch-load-error"
                    />
                  ) : presentation.branches.sourceItems === null ? (
                    <Spinner />
                  ) : presentation.branches.items.length === 0 ? (
                    <span data-testid="branch-empty">No branches found.</span>
                  ) : (
                    <select
                      ref={elementRef(presentation, "branchSelect")}
                      className="select h-8 text-xs"
                      value={presentation.branch}
                      onChange={(event) => {
                        const option = presentation.branches.items[event.currentTarget.selectedIndex];
                        if (!option || option.value === presentation.branch) return;
                        const runtime = publicationRuntimes.get(presentation);
                        if (
                          !claimChange(
                            presentation,
                            event,
                            (runtime?.elements.branchSelect as HTMLSelectElement | null) ?? null,
                            "branch",
                            (control) =>
                              control.value === option.value &&
                              control.options.item(option.index) === runtime?.branchOptions.get(option),
                          )
                        ) {
                          return;
                        }
                        presentation.callbacks.resetFileLoad();
                        setBranch(option.value);
                      }}
                      disabled={presentation.busy}
                      data-testid="branch-select"
                    >
                      {presentation.branches.items.map((item) => (
                        <option
                          ref={mappedElementRef(presentation, "branchOptions", item)}
                          key={`${item.value}:${item.index}`}
                          value={item.value}
                        >
                          {item.value}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
              {presentation.mode === "link" && (
                <form
                  ref={elementRef(presentation, "pathForm")}
                  className="flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!claimSubmit(presentation, event)) return;
                    linkRepo(presentation, presentation.path.trim());
                  }}
                >
                  <input
                    ref={elementRef(presentation, "path")}
                    className="input flex-1 font-mono text-[13px]"
                    placeholder="docs/new-file.md (new or existing path)"
                    value={presentation.path}
                    disabled={presentation.busy}
                    onChange={(event) => {
                      const nextPath = event.currentTarget.value;
                      if (nextPath === presentation.path) return;
                      const runtime = publicationRuntimes.get(presentation);
                      if (
                        !claimChange(
                          presentation,
                          event,
                          (runtime?.elements.path as HTMLInputElement | null) ?? null,
                          "path",
                          (control) => control.value === nextPath,
                        )
                      ) {
                        return;
                      }
                      setPath(nextPath);
                    }}
                    data-testid="repo-path"
                  />
                  <button
                    ref={elementRef(presentation, "pathSubmit")}
                    type="submit"
                    className="btn btn-primary"
                    disabled={presentation.busy || !presentation.path.trim()}
                    data-testid="repo-link"
                  >
                    {presentation.busy ? <Loader2 size={16} className="animate-spin" /> : "Connect"}
                  </button>
                </form>
              )}
              <div
                ref={elementRef(presentation, "fileList")}
                className="scrollbar-thin max-h-64 overflow-y-auto rounded-xl border border-line"
                data-testid="file-list"
              >
                {presentation.files.error ? (
                  <ListLoadError
                    error={presentation.files.error}
                    pending={presentation.files.pending}
                    onRetry={(event) => {
                      const runtime = publicationRuntimes.get(presentation);
                      if (
                        !claimMouse(
                          presentation,
                          event,
                          (runtime?.elements.fileRetry as HTMLButtonElement | null) ?? null,
                        )
                      ) {
                        return;
                      }
                      presentation.callbacks.loadFiles();
                    }}
                    buttonRef={elementRef(presentation, "fileRetry")}
                    testId="file-load-error"
                  />
                ) : presentation.files.sourceItems === null ? (
                  <div className="flex justify-center py-8">
                    <Spinner />
                  </div>
                ) : presentation.fileRows.length === 0 ? (
                  <div className="px-3 py-6 text-center text-sm text-ink-3">No Markdown files on this branch.</div>
                ) : (
                  <ul ref={elementRef(presentation, "fileRows")} className="divide-y divide-line">
                    {presentation.fileRows.map((row) => (
                      <li key={row.path}>
                        <button
                          ref={mappedElementRef(presentation, "fileRows", row)}
                          type="button"
                          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2 disabled:opacity-50"
                          disabled={presentation.busy}
                          onClick={(event) => {
                            if (presentation.mode === "link" && presentation.path === row.path) return;
                            const runtime = publicationRuntimes.get(presentation);
                            if (!claimMouse(presentation, event, runtime?.fileRows.get(row))) return;
                            if (presentation.mode === "link") setPath(row.path);
                            else linkRepo(presentation, row.path);
                          }}
                          data-testid="repo-file"
                        >
                          <FileText size={15} className="shrink-0 text-ink-4" />
                          <span className="truncate font-mono text-[13px] text-ink-2" title={row.path}>{row.path}</span>
                          {presentation.mode === "import" && <span className="ml-auto text-xs text-accent">Open</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export const GitHubDialog = memo(function GitHubDialog({
  open,
  onOpenChange,
  doc,
  onDocChange,
  githubAvailable,
  githubConfigured,
  isOwner,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocumentDto;
  onDocChange: (doc: DocumentDto) => void;
  githubAvailable: boolean;
  githubConfigured: boolean;
  isOwner: boolean;
}) {
  const [unlinking, setUnlinking] = useState(false);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const linked = doc.storage !== "local";
  const linkedDestination = linked
    ? doc.storage === "gist" ? `Gist · ${doc.gistFile}` : `${doc.repoOwner}/${doc.repoName} · ${doc.repoBranch} · ${doc.repoPath}`
    : "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={linked ? "GitHub connection" : "Connect to GitHub"}
        description={linked ? "This document publishes to the location below." : "Store this document in a gist or a repository file. Publishing commits the current text."}
        wide
      >
        {linked && (
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-line bg-surface-2 p-3">
            <GitHubIcon size={18} className="text-ink-2" />
            <div className="min-w-0 flex-1 text-sm">
              <div className="truncate font-medium text-ink" title={linkedDestination}>
                {linkedDestination}
              </div>
              <div className="text-xs text-ink-3">
                {doc.publishedAt ? `Last published ${relativeTime(doc.publishedAt)}` : "Not published yet"}
                {doc.hasUnpublishedChanges && " · unpublished changes"}
              </div>
            </div>
            {doc.githubUrl && (
              <a className="btn btn-sm btn-outline gap-1.5" href={doc.githubUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={14} /> Open
              </a>
            )}
            <button
              type="button"
              className="btn btn-sm btn-ghost gap-1.5 text-ink-3"
              disabled={unlinking}
              onClick={async () => {
                setUnlinking(true);
                setUnlinkError(null);
                try {
                  const res = await api.documents.link(doc.id, { storage: "local" });
                  onDocChange(res.document);
                } catch (error) {
                  setUnlinkError(apiErrorText(error, "Could not disconnect the gist."));
                } finally {
                  setUnlinking(false);
                }
              }}
            >
              <Unlink size={14} /> Disconnect
            </button>
          </div>
        )}
        {linked && unlinkError && <p role="alert" className="mb-3 text-sm text-danger wrap-anywhere">{unlinkError}</p>}
        {open && <GistAutoUpdateControl doc={doc} isOwner={isOwner} />}
        <GitHubPicker
          mode="link"
          doc={doc}
          githubAvailable={githubAvailable}
          githubConfigured={githubConfigured}
          onLinked={(d) => {
            onDocChange(d);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
});

/* ---------------- Keyboard event checks of the picker's source tabs ---------------- */

// These belong to the picker (row 60 of the #2222 inventory) and go when its other event checks go.
// They carry "Commit" in their names because they were first written for the Commit dialog's buttons.
// The Commit dialog below calls none of them.

type CommitActionNavigationKey =
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "Home"
  | "End";

type CommitActionKeyboardGetter = (this: object) => unknown;

interface CommitActionKeyboardGetterAuthority<Field extends string> {
  readonly getters: Readonly<Record<Field, CommitActionKeyboardGetter>>;
  readonly isCurrent: () => boolean;
}

interface CommitActionKeyboardMethodAuthority<Method> {
  readonly method: Method;
  readonly isCurrent: () => boolean;
}

interface CommitActionKeyboardWindowMethod<Method> {
  readonly value: Method;
  readonly isCurrent: () => boolean;
}

interface CommitActionKeyboardTrustAuthority {
  readonly matches: (event: object) => boolean;
  readonly read: (event: object) => boolean;
  readonly isCurrent: () => boolean;
}

interface CommitActionKeyboardTerminalProof {
  readonly registration: CommitActionKeyboardTerminalRegistration;
  readonly nativeEvent: KeyboardEvent;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly terminal: EventTarget;
  readonly path: readonly EventTarget[];
}

interface CommitActionKeyboardTerminalRegistration {
  readonly proofFor: (
    event: KeyboardEvent,
  ) => CommitActionKeyboardTerminalProof | null;
  readonly claim: (proof: CommitActionKeyboardTerminalProof) => boolean;
  readonly retains: (proof: CommitActionKeyboardTerminalProof) => boolean;
  readonly release: () => void;
  readonly isCurrent: () => boolean;
}

type CommitActionKeyboardEventField =
  | "type"
  | "target"
  | "currentTarget"
  | "eventPhase"
  | "bubbles"
  | "cancelable"
  | "defaultPrevented"
  | "cancelBubble"
  | "composed";

type CommitActionKeyboardKeyField =
  | "key"
  | "code"
  | "location"
  | "repeat"
  | "isComposing"
  | "ctrlKey"
  | "altKey"
  | "metaKey"
  | "shiftKey";

interface CommitActionKeyboardAuthority {
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly Event: typeof Event;
  readonly KeyboardEvent: typeof KeyboardEvent;
  readonly HTMLElement: typeof HTMLElement;
  readonly event: CommitActionKeyboardGetterAuthority<CommitActionKeyboardEventField>["getters"];
  readonly keyboard: CommitActionKeyboardGetterAuthority<CommitActionKeyboardKeyField>["getters"];
  readonly view: CommitActionKeyboardGetter;
  readonly detail: CommitActionKeyboardGetter;
  readonly activeElement: CommitActionKeyboardGetter;
  readonly composedPath: Event["composedPath"];
  readonly focus: (this: HTMLElement, options?: FocusOptions) => void;
  readonly trusted: CommitActionKeyboardTrustAuthority;
  readonly reactMethodMatches: (
    event: ReactKeyboardEvent<HTMLElement>,
    name:
      | "preventDefault"
      | "stopPropagation"
      | "isDefaultPrevented"
      | "isPropagationStopped"
      | "persist",
    method: (...args: never[]) => unknown,
  ) => boolean;
  readonly terminal: CommitActionKeyboardTerminalRegistration;
  readonly apply: typeof Reflect.apply;
  readonly prototypeOf: typeof Object.getPrototypeOf;
  readonly isCurrent: () => boolean;
}

interface CommitActionKeyboardEventSnapshot {
  readonly event: KeyboardEvent;
  readonly type: string;
  readonly target: HTMLElement;
  readonly currentTarget: EventTarget;
  readonly phase: number;
  readonly path: readonly EventTarget[];
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly cancelBubble: boolean;
  readonly composed: boolean;
  readonly key: CommitActionNavigationKey;
  readonly code: string;
  readonly location: number;
  readonly repeat: boolean;
  readonly composing: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly view: ReactKeyboardEvent<HTMLDivElement>["view"];
  readonly detail: number;
  readonly trusted: true;
  readonly terminal: CommitActionKeyboardTerminalProof;
}

function commitDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  return Boolean(
    current &&
      current.configurable === expected.configurable &&
      current.enumerable === expected.enumerable &&
      current.writable === expected.writable &&
      current.value === expected.value &&
      current.get === expected.get &&
      current.set === expected.set,
  );
}

function captureCommitActionKeyboardGetters<
  const Fields extends readonly string[],
>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  prototype: object,
  fields: Fields,
): CommitActionKeyboardGetterAuthority<Fields[number]> | null {
  const entries: [Fields[number], CommitActionKeyboardGetter][] = [];
  const descriptors: [Fields[number], PropertyDescriptor][] = [];
  for (const field of fields) {
    const descriptor = getOwnPropertyDescriptor(prototype, field);
    if (!descriptor || typeof descriptor.get !== "function") return null;
    entries.push([field, descriptor.get]);
    descriptors.push([field, Object.freeze({ ...descriptor })]);
  }
  const getters = Object.freeze(
    Object.fromEntries(entries),
  ) as Readonly<Record<Fields[number], CommitActionKeyboardGetter>>;
  return Object.freeze({
    getters,
    isCurrent: () =>
      descriptors.every(([field, expected]) =>
        commitDescriptorsMatch(
          getOwnPropertyDescriptor(prototype, field),
          expected,
        ),
      ),
  });
}

function captureCommitActionKeyboardMethod<Method>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  prototype: object,
  name: PropertyKey,
): CommitActionKeyboardMethodAuthority<Method> | null {
  const descriptor = getOwnPropertyDescriptor(prototype, name);
  if (!descriptor || typeof descriptor.value !== "function") return null;
  const expected = Object.freeze({ ...descriptor });
  return Object.freeze({
    method: descriptor.value as Method,
    isCurrent: () =>
      commitDescriptorsMatch(
        getOwnPropertyDescriptor(prototype, name),
        expected,
      ),
  });
}

function captureCommitActionKeyboardWindowMethod<
  Property extends "addEventListener" | "removeEventListener",
>(
  ownerWindow: Window & typeof globalThis,
  property: Property,
): CommitActionKeyboardWindowMethod<Window[Property]> | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
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
  const isCurrent = () =>
    ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
    ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
    ownerWindow.Reflect.get === reflectGet &&
    path.every(
      ({ target: entry, descriptor, prototype }) =>
        getPrototypeOf(entry) === prototype &&
        (descriptor
          ? commitDescriptorsMatch(
              getOwnPropertyDescriptor(entry, property),
              descriptor,
            )
          : getOwnPropertyDescriptor(entry, property) === undefined),
    ) &&
    reflectGet(ownerWindow, property, ownerWindow) === value;
  return isCurrent() ? Object.freeze({ value, isCurrent }) : null;
}

function captureCommitActionKeyboardTrust(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  apply: typeof Reflect.apply,
  probe: KeyboardEvent,
): CommitActionKeyboardTrustAuthority | null {
  const descriptor = getOwnPropertyDescriptor(probe, "isTrusted");
  if (
    !descriptor ||
    descriptor.configurable !== false ||
    descriptor.enumerable !== true ||
    typeof descriptor.get !== "function" ||
    descriptor.set !== undefined
  ) {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  const matches = (event: object) =>
    commitDescriptorsMatch(
      getOwnPropertyDescriptor(event, "isTrusted"),
      expected,
    );
  return Object.freeze({
    matches,
    read: (event: object) =>
      apply(
        descriptor.get as CommitActionKeyboardGetter,
        event,
        [],
      ) as boolean,
    isCurrent: () => matches(probe),
  });
}

function createCommitActionKeyboardTerminal(
  ownerWindow: Window & typeof globalThis,
  ownerDocument: Document,
  KeyboardEventConstructor: typeof KeyboardEvent,
  keyboardEventPrototype: object,
  eventCurrentTarget: CommitActionKeyboardGetter,
  eventPhase: CommitActionKeyboardGetter,
  composedPath: Event["composedPath"],
  addEventListener: CommitActionKeyboardWindowMethod<
    Window["addEventListener"]
  >,
  removeEventListener: CommitActionKeyboardWindowMethod<
    Window["removeEventListener"]
  >,
  apply: typeof Reflect.apply,
  prototypeOf: typeof Object.getPrototypeOf,
  intrinsicsAreCurrent: () => boolean,
): CommitActionKeyboardTerminalRegistration | null {
  const proofs = new WeakMap<KeyboardEvent, CommitActionKeyboardTerminalProof>();
  const invalidEvents = new WeakSet<Event>();
  const claimedEvents = new WeakSet<Event>();
  let active = false;
  let released = false;

  const listener: EventListener = function (
    this: EventTarget,
    event: Event,
  ) {
    if (
      !active ||
      released ||
      prototypeOf(event) !== keyboardEventPrototype ||
      invalidEvents.has(event) ||
      claimedEvents.has(event) ||
      !intrinsicsAreCurrent()
    ) {
      return;
    }
    if (proofs.has(event as KeyboardEvent)) {
      invalidEvents.add(event);
      return;
    }
    try {
      const currentTarget = apply(
        eventCurrentTarget,
        event,
        [],
      ) as EventTarget | null;
      const phase = apply(eventPhase, event, []) as number;
      const path = apply(composedPath, event, []) as EventTarget[];
      const terminal = path.at(-1);
      if (
        currentTarget !== this ||
        terminal !== this ||
        phase !== ownerWindow.Event.CAPTURING_PHASE ||
        path.at(-2) !== ownerDocument
      ) {
        invalidEvents.add(event);
        return;
      }
      proofs.set(
        event as KeyboardEvent,
        Object.freeze({
          registration,
          nativeEvent: event as KeyboardEvent,
          receiver: this,
          currentTarget,
          terminal,
          path: Object.freeze([...path]),
        }),
      );
    } catch {
      invalidEvents.add(event);
    }
  };

  const proofFor = (event: KeyboardEvent) => {
    const proof = proofs.get(event);
    if (
      !proof ||
      !active ||
      released ||
      claimedEvents.has(event) ||
      invalidEvents.has(event) ||
      proof.registration !== registration ||
      proof.nativeEvent !== event ||
      proof.receiver !== proof.currentTarget ||
      proof.receiver !== proof.terminal ||
      !intrinsicsAreCurrent()
    ) {
      return null;
    }
    try {
      const path = apply(composedPath, event, []) as EventTarget[];
      return path.length === proof.path.length &&
        path.every((entry, index) => entry === proof.path[index]) &&
        path.at(-2) === ownerDocument &&
        path.at(-1) === proof.receiver
        ? proof
        : null;
    } catch {
      invalidEvents.add(event);
      return null;
    }
  };
  const retains = (proof: CommitActionKeyboardTerminalProof) => {
    if (
      !active ||
      released ||
      proofs.get(proof.nativeEvent) !== proof ||
      !claimedEvents.has(proof.nativeEvent) ||
      invalidEvents.has(proof.nativeEvent) ||
      proof.registration !== registration ||
      proof.receiver !== proof.currentTarget ||
      proof.receiver !== proof.terminal ||
      !intrinsicsAreCurrent()
    ) {
      return false;
    }
    try {
      const path = apply(
        composedPath,
        proof.nativeEvent,
        [],
      ) as EventTarget[];
      return (
        path.length === proof.path.length &&
        path.every((entry, index) => entry === proof.path[index]) &&
        path.at(-2) === ownerDocument &&
        path.at(-1) === proof.receiver
      );
    } catch {
      invalidEvents.add(proof.nativeEvent);
      return false;
    }
  };

  const registration: CommitActionKeyboardTerminalRegistration =
    Object.freeze({
      proofFor,
      claim: (proof: CommitActionKeyboardTerminalProof) => {
        if (
          proofFor(proof.nativeEvent) !== proof ||
          claimedEvents.has(proof.nativeEvent)
        ) {
          return false;
        }
        claimedEvents.add(proof.nativeEvent);
        return true;
      },
      retains,
      release: () => {
        if (released) return;
        released = true;
        active = false;
        apply(removeEventListener.value, ownerWindow, [
          "keydown",
          listener,
          true,
        ]);
      },
      isCurrent: () =>
        active &&
        !released &&
        intrinsicsAreCurrent() &&
        addEventListener.isCurrent() &&
        removeEventListener.isCurrent(),
    });

  active = true;
  try {
    apply(addEventListener.value, ownerWindow, ["keydown", listener, true]);
    if (registration.isCurrent()) return registration;
    registration.release();
    return null;
  } catch {
    active = false;
    released = true;
    return null;
  }
}

function captureCommitActionKeyboardAuthority(
  ownerDocument: Document,
): CommitActionKeyboardAuthority | null {
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) return null;
  const objectConstructor = ownerWindow.Object;
  const getOwnPropertyDescriptor = objectConstructor.getOwnPropertyDescriptor;
  const prototypeOf = objectConstructor.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const EventConstructor = ownerWindow.Event;
  const UIEventConstructor = ownerWindow.UIEvent;
  const KeyboardEventConstructor = ownerWindow.KeyboardEvent;
  const DocumentConstructor = ownerWindow.Document;
  const HTMLElementConstructor = ownerWindow.HTMLElement;
  const eventPrototype = EventConstructor.prototype;
  const uiEventPrototype = UIEventConstructor.prototype;
  const keyboardEventPrototype = KeyboardEventConstructor.prototype;
  const documentPrototype = DocumentConstructor.prototype;
  const eventGetters = captureCommitActionKeyboardGetters(
    getOwnPropertyDescriptor,
    eventPrototype,
    [
      "type",
      "target",
      "currentTarget",
      "eventPhase",
      "bubbles",
      "cancelable",
      "defaultPrevented",
      "cancelBubble",
      "composed",
    ] as const,
  );
  const keyboardGetters = captureCommitActionKeyboardGetters(
    getOwnPropertyDescriptor,
    keyboardEventPrototype,
    [
      "key",
      "code",
      "location",
      "repeat",
      "isComposing",
      "ctrlKey",
      "altKey",
      "metaKey",
      "shiftKey",
    ] as const,
  );
  const uiGetters = captureCommitActionKeyboardGetters(
    getOwnPropertyDescriptor,
    uiEventPrototype,
    ["view", "detail"] as const,
  );
  const documentGetters = captureCommitActionKeyboardGetters(
    getOwnPropertyDescriptor,
    documentPrototype,
    ["activeElement"] as const,
  );
  const composedPath =
    captureCommitActionKeyboardMethod<Event["composedPath"]>(
      getOwnPropertyDescriptor,
      eventPrototype,
      "composedPath",
    );
  const nativePreventDefault =
    captureCommitActionKeyboardMethod<Event["preventDefault"]>(
      getOwnPropertyDescriptor,
      eventPrototype,
      "preventDefault",
    );
  const focus = captureCommitActionKeyboardMethod<
    (this: HTMLElement, options?: FocusOptions) => void
  >(getOwnPropertyDescriptor, HTMLElementConstructor.prototype, "focus");
  const addEventListener = captureCommitActionKeyboardWindowMethod(
    ownerWindow,
    "addEventListener",
  );
  const removeEventListener = captureCommitActionKeyboardWindowMethod(
    ownerWindow,
    "removeEventListener",
  );
  if (
    !eventGetters ||
    !keyboardGetters ||
    !uiGetters ||
    !documentGetters ||
    !composedPath ||
    !nativePreventDefault ||
    !focus ||
    !addEventListener ||
    !removeEventListener
  ) {
    return null;
  }
  let probe: KeyboardEvent;
  try {
    probe = new KeyboardEventConstructor("commit-action-keyboard-intrinsic");
  } catch {
    return null;
  }
  const trusted = captureCommitActionKeyboardTrust(
    getOwnPropertyDescriptor,
    apply,
    probe,
  );
  if (!trusted) return null;
  let poisoned = false;
  const intrinsicsAreCurrent = () => {
    if (poisoned) return false;
    try {
      const current =
        ownerDocument.defaultView === ownerWindow &&
        ownerWindow.Object === objectConstructor &&
        ownerWindow.Object.getOwnPropertyDescriptor ===
          getOwnPropertyDescriptor &&
        ownerWindow.Object.getPrototypeOf === prototypeOf &&
        ownerWindow.Reflect.apply === apply &&
        ownerWindow.Event === EventConstructor &&
        ownerWindow.UIEvent === UIEventConstructor &&
        ownerWindow.KeyboardEvent === KeyboardEventConstructor &&
        ownerWindow.Document === DocumentConstructor &&
        ownerWindow.HTMLElement === HTMLElementConstructor &&
        EventConstructor.prototype === eventPrototype &&
        UIEventConstructor.prototype === uiEventPrototype &&
        KeyboardEventConstructor.prototype === keyboardEventPrototype &&
        DocumentConstructor.prototype === documentPrototype &&
        prototypeOf(probe) === keyboardEventPrototype &&
        prototypeOf(keyboardEventPrototype) === uiEventPrototype &&
        prototypeOf(uiEventPrototype) === eventPrototype &&
        eventGetters.isCurrent() &&
        keyboardGetters.isCurrent() &&
        uiGetters.isCurrent() &&
        documentGetters.isCurrent() &&
        composedPath.isCurrent() &&
        nativePreventDefault.isCurrent() &&
        focus.isCurrent() &&
        addEventListener.isCurrent() &&
        removeEventListener.isCurrent() &&
        trusted.isCurrent();
      if (!current) poisoned = true;
      return current;
    } catch {
      poisoned = true;
      return false;
    }
  };
  try {
    if (!intrinsicsAreCurrent() || trusted.read(probe) !== false) return null;
  } catch {
    return null;
  }
  const terminal = createCommitActionKeyboardTerminal(
    ownerWindow,
    ownerDocument,
    KeyboardEventConstructor,
    keyboardEventPrototype,
    eventGetters.getters.currentTarget,
    eventGetters.getters.eventPhase,
    composedPath.method,
    addEventListener,
    removeEventListener,
    apply,
    prototypeOf,
    intrinsicsAreCurrent,
  );
  if (!terminal) return null;
  const reactMethodMatches: CommitActionKeyboardAuthority["reactMethodMatches"] =
    (event, name, method) => {
      if (!intrinsicsAreCurrent()) return false;
      try {
        let current: object | null = event;
        while (current) {
          const descriptor = getOwnPropertyDescriptor(current, name);
          if (descriptor) {
            return (
              descriptor.get === undefined &&
              descriptor.set === undefined &&
              descriptor.value === method
            );
          }
          current = prototypeOf(current);
        }
        return false;
      } catch {
        poisoned = true;
        return false;
      }
    };
  return Object.freeze({
    ownerDocument,
    ownerWindow,
    Event: EventConstructor,
    KeyboardEvent: KeyboardEventConstructor,
    HTMLElement: HTMLElementConstructor,
    event: eventGetters.getters,
    keyboard: keyboardGetters.getters,
    view: uiGetters.getters.view,
    detail: uiGetters.getters.detail,
    activeElement: documentGetters.getters.activeElement,
    composedPath: composedPath.method,
    focus: focus.method,
    trusted,
    reactMethodMatches,
    terminal,
    apply,
    prototypeOf,
    isCurrent: () => intrinsicsAreCurrent() && terminal.isCurrent(),
  });
}

function commitActionKeyboardValue<Value>(
  authority: CommitActionKeyboardAuthority,
  getter: CommitActionKeyboardGetter,
  target: object,
): Value {
  return authority.apply(getter, target, []) as Value;
}

function isCommitActionNavigationKey(
  key: string,
): key is CommitActionNavigationKey {
  return (
    key === "ArrowLeft" ||
    key === "ArrowUp" ||
    key === "ArrowRight" ||
    key === "ArrowDown" ||
    key === "Home" ||
    key === "End"
  );
}

function commitActionKeyboardObjectsMatch(left: object, right: object) {
  return left === right;
}

function captureCommitActionKeyboardEvent(
  authority: CommitActionKeyboardAuthority,
  nativeEvent: Event,
  expectedPhase: number,
  expectedDefaultPrevented = false,
  retainedTerminal: CommitActionKeyboardTerminalProof | null = null,
): CommitActionKeyboardEventSnapshot | null {
  if (
    !authority.isCurrent() ||
    authority.prototypeOf(nativeEvent) !== authority.KeyboardEvent.prototype ||
    !authority.trusted.matches(nativeEvent)
  ) {
    return null;
  }
  try {
    const type = commitActionKeyboardValue<string>(
      authority,
      authority.event.type,
      nativeEvent,
    );
    const target = commitActionKeyboardValue<EventTarget | null>(
      authority,
      authority.event.target,
      nativeEvent,
    );
    const currentTarget = commitActionKeyboardValue<EventTarget | null>(
      authority,
      authority.event.currentTarget,
      nativeEvent,
    );
    const phase = commitActionKeyboardValue<number>(
      authority,
      authority.event.eventPhase,
      nativeEvent,
    );
    const bubbles = commitActionKeyboardValue<boolean>(
      authority,
      authority.event.bubbles,
      nativeEvent,
    );
    const cancelable = commitActionKeyboardValue<boolean>(
      authority,
      authority.event.cancelable,
      nativeEvent,
    );
    const defaultPrevented = commitActionKeyboardValue<boolean>(
      authority,
      authority.event.defaultPrevented,
      nativeEvent,
    );
    const cancelBubble = commitActionKeyboardValue<boolean>(
      authority,
      authority.event.cancelBubble,
      nativeEvent,
    );
    const composed = commitActionKeyboardValue<boolean>(
      authority,
      authority.event.composed,
      nativeEvent,
    );
    const key = commitActionKeyboardValue<string>(
      authority,
      authority.keyboard.key,
      nativeEvent,
    );
    const code = commitActionKeyboardValue<string>(
      authority,
      authority.keyboard.code,
      nativeEvent,
    );
    const location = commitActionKeyboardValue<number>(
      authority,
      authority.keyboard.location,
      nativeEvent,
    );
    const repeat = commitActionKeyboardValue<boolean>(
      authority,
      authority.keyboard.repeat,
      nativeEvent,
    );
    const composing = commitActionKeyboardValue<boolean>(
      authority,
      authority.keyboard.isComposing,
      nativeEvent,
    );
    const ctrlKey = commitActionKeyboardValue<boolean>(
      authority,
      authority.keyboard.ctrlKey,
      nativeEvent,
    );
    const altKey = commitActionKeyboardValue<boolean>(
      authority,
      authority.keyboard.altKey,
      nativeEvent,
    );
    const metaKey = commitActionKeyboardValue<boolean>(
      authority,
      authority.keyboard.metaKey,
      nativeEvent,
    );
    const shiftKey = commitActionKeyboardValue<boolean>(
      authority,
      authority.keyboard.shiftKey,
      nativeEvent,
    );
    const view = commitActionKeyboardValue<
      ReactKeyboardEvent<HTMLDivElement>["view"] | null
    >(
      authority,
      authority.view,
      nativeEvent,
    );
    const detail = commitActionKeyboardValue<number>(
      authority,
      authority.detail,
      nativeEvent,
    );
    const activeElement = commitActionKeyboardValue<Element | null>(
      authority,
      authority.activeElement,
      authority.ownerDocument,
    );
    const path = authority.apply(
      authority.composedPath,
      nativeEvent,
      [],
    ) as EventTarget[];
    const trusted = authority.trusted.read(nativeEvent);
    const terminal =
      retainedTerminal?.nativeEvent === nativeEvent &&
      authority.terminal.retains(retainedTerminal)
        ? retainedTerminal
        : authority.terminal.proofFor(nativeEvent as KeyboardEvent);
    if (!view) return null;
    if (
      type !== "keydown" ||
      !(target instanceof authority.HTMLElement) ||
      target.ownerDocument !== authority.ownerDocument ||
      activeElement !== target ||
      !currentTarget ||
      phase !== expectedPhase ||
      !bubbles ||
      !cancelable ||
      defaultPrevented !== expectedDefaultPrevented ||
      cancelBubble ||
      !isCommitActionNavigationKey(key) ||
      repeat ||
      composing ||
      ctrlKey ||
      altKey ||
      metaKey ||
      shiftKey ||
      (!commitActionKeyboardObjectsMatch(view, authority.ownerWindow) &&
        (!terminal ||
          !commitActionKeyboardObjectsMatch(view, terminal.receiver))) ||
      detail !== 0 ||
      trusted !== true ||
      !terminal
    ) {
      return null;
    }
    const expectedPath: EventTarget[] = [];
    let node: Node | null = target;
    while (node) {
      expectedPath.push(node);
      if (node === authority.ownerDocument) break;
      node = node.parentNode;
    }
    expectedPath.push(terminal.receiver);
    if (
      expectedPath.at(-2) !== authority.ownerDocument ||
      path.length !== expectedPath.length ||
      path.some((entry, index) => entry !== expectedPath[index]) ||
      path.length !== terminal.path.length ||
      path.some((entry, index) => entry !== terminal.path[index]) ||
      terminal.receiver !== terminal.currentTarget ||
      terminal.receiver !== terminal.terminal ||
      !path.includes(currentTarget)
    ) {
      return null;
    }
    return Object.freeze({
      event: nativeEvent as KeyboardEvent,
      type,
      target,
      currentTarget,
      phase,
      path: Object.freeze([...path]),
      bubbles,
      cancelable,
      defaultPrevented,
      cancelBubble,
      composed,
      key,
      code,
      location,
      repeat,
      composing,
      ctrlKey,
      altKey,
      metaKey,
      shiftKey,
      view,
      detail,
      trusted: true,
      terminal,
    });
  } catch {
    return null;
  }
}

function commitActionKeyboardEventsMatch(
  capture: CommitActionKeyboardEventSnapshot,
  bubble: CommitActionKeyboardEventSnapshot,
  authority: CommitActionKeyboardAuthority,
) {
  return (
    capture.event === bubble.event &&
    capture.type === bubble.type &&
    capture.target === bubble.target &&
    capture.phase === authority.Event.CAPTURING_PHASE &&
    bubble.phase === authority.Event.BUBBLING_PHASE &&
    capture.bubbles === bubble.bubbles &&
    capture.cancelable === bubble.cancelable &&
    capture.defaultPrevented === bubble.defaultPrevented &&
    capture.cancelBubble === bubble.cancelBubble &&
    capture.composed === bubble.composed &&
    capture.key === bubble.key &&
    capture.code === bubble.code &&
    capture.location === bubble.location &&
    capture.repeat === bubble.repeat &&
    capture.composing === bubble.composing &&
    capture.ctrlKey === bubble.ctrlKey &&
    capture.altKey === bubble.altKey &&
    capture.metaKey === bubble.metaKey &&
    capture.shiftKey === bubble.shiftKey &&
    capture.view === bubble.view &&
    capture.detail === bubble.detail &&
    capture.trusted === bubble.trusted &&
    capture.terminal === bubble.terminal &&
    capture.path.length === bubble.path.length &&
    capture.path.every((entry, index) => entry === bubble.path[index])
  );
}

function pickerSourceKeyboardEventsMatch(
  left: CommitActionKeyboardEventSnapshot,
  right: CommitActionKeyboardEventSnapshot,
) {
  return (
    left.event === right.event &&
    left.type === right.type &&
    left.target === right.target &&
    left.currentTarget === right.currentTarget &&
    left.phase === right.phase &&
    left.path.length === right.path.length &&
    left.path.every((entry, index) => entry === right.path[index]) &&
    left.bubbles === right.bubbles &&
    left.cancelable === right.cancelable &&
    left.defaultPrevented === right.defaultPrevented &&
    left.cancelBubble === right.cancelBubble &&
    left.composed === right.composed &&
    left.key === right.key &&
    left.code === right.code &&
    left.location === right.location &&
    left.repeat === right.repeat &&
    left.composing === right.composing &&
    left.ctrlKey === right.ctrlKey &&
    left.altKey === right.altKey &&
    left.metaKey === right.metaKey &&
    left.shiftKey === right.shiftKey &&
    left.view === right.view &&
    left.detail === right.detail &&
    left.trusted === right.trusted &&
    left.terminal === right.terminal
  );
}

function capturePickerSourceReactDelivery(
  stage: PickerSourceNavigationStage,
  event: ReactKeyboardEvent<HTMLElement>,
  publication: GitHubPickerPublication,
  native: CommitActionKeyboardEventSnapshot,
  currentTarget: HTMLElement,
): PickerSourceReactDelivery | null {
  const authority = publication.keyboard;
  const source = publication.sources.find(
    (entry) => entry.element === native.target,
  );
  if (!authority || !source) return null;
  try {
    const candidate = event as ReactKeyboardEvent<HTMLElement> &
      Partial<PickerSourceReactMethods>;
    const methods = {
      preventDefault: candidate.preventDefault,
      isDefaultPrevented: candidate.isDefaultPrevented,
      isPropagationStopped: candidate.isPropagationStopped,
    };
    if (
      typeof methods.preventDefault !== "function" ||
      typeof methods.isDefaultPrevented !== "function" ||
      typeof methods.isPropagationStopped !== "function"
    ) {
      return null;
    }
    const captured = Object.freeze<PickerSourceReactMethods>({
      preventDefault: methods.preventDefault,
      isDefaultPrevented: methods.isDefaultPrevented,
      isPropagationStopped: methods.isPropagationStopped,
    });
    if (
      event.nativeEvent !== native.event ||
      event.type !== native.type ||
      event.target !== native.target ||
      event.currentTarget !== currentTarget ||
      event.eventPhase !== native.phase ||
      event.bubbles !== native.bubbles ||
      event.cancelable !== native.cancelable ||
      event.defaultPrevented !== native.defaultPrevented ||
      event.isTrusted !== native.trusted ||
      event.key !== native.key ||
      event.code !== native.code ||
      event.location !== native.location ||
      event.repeat !== native.repeat ||
      event.ctrlKey !== native.ctrlKey ||
      event.altKey !== native.altKey ||
      event.metaKey !== native.metaKey ||
      event.shiftKey !== native.shiftKey ||
      event.view !== native.view ||
      event.detail !== native.detail ||
      native.path[0] !== source.element ||
      !native.path.includes(currentTarget)
    ) {
      return null;
    }
    return Object.freeze({
      stage,
      publication,
      wrapper: event,
      methods: captured,
      native,
      currentTarget,
      source,
    });
  } catch {
    return null;
  }
}

function pickerSourceReactDeliveryRemains(
  delivery: PickerSourceReactDelivery,
  publicDefaultPrevented: boolean,
  nativeDefaultPrevented: boolean,
  requireCurrentTarget: boolean,
  revalidateNative: boolean,
  isDefaultPrevented: (...args: never[]) => unknown =
    delivery.methods.isDefaultPrevented,
  retainedTerminal: CommitActionKeyboardTerminalProof | null = null,
) {
  const { publication, wrapper, methods, native } = delivery;
  const authority = publication.keyboard;
  if (!authority) return false;
  try {
    const currentNative = revalidateNative
      ? captureCommitActionKeyboardEvent(
          authority,
          native.event,
          native.phase,
          nativeDefaultPrevented,
          retainedTerminal,
        )
      : null;
    return (
      (!revalidateNative || !!currentNative) &&
      authority.isCurrent() &&
      typeof isDefaultPrevented === "function" &&
      (!revalidateNative ||
        (!!currentNative &&
          currentNative.event === native.event &&
          currentNative.type === native.type &&
          currentNative.target === native.target &&
          currentNative.currentTarget === native.currentTarget &&
          currentNative.phase === native.phase &&
          currentNative.path.length === native.path.length &&
          currentNative.path.every(
            (entry, index) => entry === native.path[index],
          ) &&
          currentNative.bubbles === native.bubbles &&
          currentNative.cancelable === native.cancelable &&
          currentNative.defaultPrevented === nativeDefaultPrevented &&
          currentNative.cancelBubble === native.cancelBubble &&
          currentNative.composed === native.composed &&
          currentNative.key === native.key &&
          currentNative.code === native.code &&
          currentNative.location === native.location &&
          currentNative.repeat === native.repeat &&
          currentNative.composing === native.composing &&
          currentNative.ctrlKey === native.ctrlKey &&
          currentNative.altKey === native.altKey &&
          currentNative.metaKey === native.metaKey &&
          currentNative.shiftKey === native.shiftKey &&
          currentNative.view === native.view &&
          currentNative.detail === native.detail &&
          currentNative.trusted === native.trusted &&
          currentNative.terminal === native.terminal)) &&
      wrapper.nativeEvent === native.event &&
      wrapper.target === native.target &&
      (!requireCurrentTarget ||
        wrapper.currentTarget === delivery.currentTarget) &&
      wrapper.type === native.type &&
      (!requireCurrentTarget || wrapper.eventPhase === native.phase) &&
      wrapper.bubbles === native.bubbles &&
      wrapper.cancelable === native.cancelable &&
      wrapper.isTrusted === native.trusted &&
      wrapper.key === native.key &&
      wrapper.code === native.code &&
      wrapper.location === native.location &&
      wrapper.repeat === native.repeat &&
      wrapper.ctrlKey === native.ctrlKey &&
      wrapper.altKey === native.altKey &&
      wrapper.metaKey === native.metaKey &&
      wrapper.shiftKey === native.shiftKey &&
      wrapper.view === native.view &&
      wrapper.detail === native.detail &&
      wrapper.preventDefault === methods.preventDefault &&
      wrapper.isDefaultPrevented === isDefaultPrevented &&
      wrapper.isPropagationStopped === methods.isPropagationStopped &&
      wrapper.defaultPrevented === publicDefaultPrevented
    );
  } catch {
    return false;
  }
}

/* ---------------- Commit dialog ---------------- */

/**
 * Commit is `aria-disabled`, not `disabled`, while the request runs and after it has succeeded: a disabled
 * button drops focus to the page when it switches off under the pointer or the key that pressed it, and
 * Escape and Tab then no longer reach the dialog. Pressing it while it is off does nothing.
 */
const COMMIT_SUBMIT_OFF = "aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-accent";
/** How long "Published" stays on screen before the dialog closes itself. */
const COMMIT_CLOSE_AFTER_MS = 900;
/**
 * The card keeps its top edge where a card of the usual height would have it when centred, and grows
 * downwards only. The error line is the last thing in it, so Cancel and Commit stay where they are when it
 * appears, changes or goes: a second click lands on the button the first one was aimed at, never beside
 * the card. A card taller than the window scrolls inside.
 */
const COMMIT_PINNED = "[--pin:max(0.75rem,calc(50dvh-8.5rem))] top-(--pin) translate-y-0 max-h-[calc(100dvh-var(--pin)-0.75rem)] overflow-y-auto";

/** Where a commit goes. The form starts over when this changes under an open dialog. */
const commitDestination = (doc: DocumentDto) =>
  JSON.stringify([doc.id, doc.storage, doc.repoOwner, doc.repoName, doc.repoBranch, doc.repoPath, doc.gistId, doc.gistFile]);

export const CommitDialog = memo(function CommitDialog({
  open,
  onOpenChange,
  doc,
  onCommit,
  isOwner,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocumentDto;
  onCommit: (message: string) => Promise<void>;
  isOwner: boolean;
}) {
  const gist = doc.storage === "gist";
  const defaultMessage = `Update ${doc.repoPath ?? doc.gistFile ?? "document"}`;
  // One visit is the dialog open on one destination. Opening it, or the destination changing under it,
  // starts over; a refresh of the same document (a new title, its first `publishedAt`) keeps the draft.
  const visit = open ? commitDestination(doc) : null;
  const [shownVisit, setShownVisit] = useState(visit);
  const [message, setMessage] = useState(defaultMessage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (shownVisit !== visit) {
    setShownVisit(visit);
    if (visit !== null) {
      setMessage(defaultMessage);
      setBusy(false);
      setError(null);
      setDone(false);
    }
  }
  // The request this visit is waiting for, from the submit until "Published" has closed the dialog (or
  // the failure is shown). While it is set nothing else is sent. Ending the visit (Cancel, Escape, Close,
  // a click outside, a new destination) lets go of it: the request itself goes on and the editor reports
  // how it ended, but it no longer changes this form.
  const running = useRef<symbol | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  });
  useEffect(
    () => () => {
      running.current = null;
    },
    [visit],
  );
  const messageId = useId();
  const messageRef = useRef<HTMLInputElement | null>(null);
  // Enter in the message field commits when the key is released, and only a press that started in the
  // field: a key held since the menu item that opened this dialog commits nothing, and the repeats of a
  // held Enter do not outlive the dialog on the button that gets focus back.
  const enterInMessage = useRef(false);
  const enterOnRelease = useEnterOnRelease();
  // Cancel closes the dialog under the pointer: the rest of a double-click must not land on the page.
  const cancelHold = usePlaceHold(!open);

  const submit = () => {
    if (running.current) return;
    const own = Symbol("commit");
    running.current = own;
    // An error from the try before stays until this one has ended, so nothing moves at the click.
    setBusy(true);
    let pending: Promise<void>;
    try {
      // The message as the field shows it now, not as the last render saw it.
      pending = onCommit((messageRef.current?.value ?? message).trim());
    } catch (e) {
      pending = Promise.reject(e);
    }
    pending.then(
      () => {
        if (running.current !== own) return;
        setBusy(false);
        setError(null);
        setDone(true);
        // "Published" stays for a moment, then the dialog closes, unless the visit has ended by then.
        setTimeout(() => {
          if (running.current !== own) return;
          running.current = null;
          onOpenChangeRef.current(false);
        }, COMMIT_CLOSE_AFTER_MS);
      },
      (e: unknown) => {
        if (running.current !== own) return;
        running.current = null;
        setBusy(false);
        setError(apiErrorText(e, "Publish failed"));
      },
    );
  };

  // Arrow keys, Home and End move between Cancel and Commit. They stop at the ends and at a button that is off.
  const onActionsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    const from = buttons.findIndex((button) => button === event.target);
    if (from < 0) return;
    const to =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? from + 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? from - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : -1;
    const next = buttons[to];
    if (!next || to === from || next.getAttribute("aria-disabled") === "true") return;
    event.preventDefault();
    next.focus({ preventScroll: true });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={COMMIT_PINNED}
          title={gist ? "Update gist" : "Commit to GitHub"}
          description={gist ? "Publishes the current text to the gist." : `Creates a commit on ${doc.repoBranch} in ${doc.repoOwner}/${doc.repoName}.`}
        >
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            onKeyDown={enterOnRelease.onKeyDown}
            onKeyUp={enterOnRelease.onKeyUp}
            onBlur={enterOnRelease.onBlur}
          >
            <GistAutoUpdateControl doc={doc} isOwner={isOwner} />
            <label className="text-sm font-medium text-ink-2" htmlFor={messageId}>
              {gist ? "Description" : "Commit message"}
            </label>
            <input
              ref={messageRef}
              id={messageId}
              className="input"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                // 229: the Enter that ends an IME composition, which some browsers report as not composing.
                if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
                event.preventDefault();
                if (!event.repeat) enterInMessage.current = !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey);
              }}
              onKeyUp={(event) => {
                if (event.key !== "Enter") return;
                const pressed = enterInMessage.current;
                enterInMessage.current = false;
                if (pressed) submit();
              }}
              onBlur={() => {
                enterInMessage.current = false;
              }}
              autoFocus
              data-testid="commit-message"
            />
            <p className="text-xs text-ink-3">Pending suggestions are not included until they are accepted.</p>
            <div className="flex justify-end gap-2" onKeyDown={onActionsKeyDown}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={(event) => {
                  cancelHold.arm(event, event.currentTarget);
                  onOpenChange(false);
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={cn("btn btn-primary gap-2", COMMIT_SUBMIT_OFF)}
                aria-disabled={busy || done || undefined}
                // A double-click, or a double tap, is one press: its second click (`detail` 2) submits
                // nothing, also when the first one has already failed and the button is on again.
                onClick={(event) => {
                  if (event.detail > 1) event.preventDefault();
                }}
                data-testid="commit-submit"
              >
                {done ? <Check size={16} /> : busy ? <Loader2 size={16} className="animate-spin" /> : null}
                {done ? "Published" : gist ? "Update gist" : "Commit"}
              </button>
            </div>
            {error !== null && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40 wrap-anywhere" role="alert">
                {error}
              </div>
            )}
          </form>
        </DialogContent>
      </Dialog>
      {cancelHold.shield}
    </>
  );
});
