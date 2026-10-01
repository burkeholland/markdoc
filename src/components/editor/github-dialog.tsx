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

type CommitPrimitive = string | number | boolean | null | undefined;
type CommitRetirement = "element" | "layout" | "ordinary";
type CommitChangingControl = "message" | null;
type CommitActionKind = "cancel" | "submit";
type CommitActionNavigationKey =
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "Home"
  | "End";

const COMMIT_FORM_CLASS = "flex flex-col gap-3";
const COMMIT_LABEL_CLASS = "text-sm font-medium text-ink-2";
const COMMIT_STATIC_CLASS = "text-xs text-ink-3";
const COMMIT_ERROR_CLASS = "rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40 wrap-anywhere";
const COMMIT_ACTIONS_CLASS = "flex justify-end gap-2";
const COMMIT_CANCEL_CLASS = "btn btn-ghost";
const COMMIT_SUBMIT_CLASS = "btn btn-primary gap-2";
const COMMIT_RADIX_ATTRIBUTES = new Set(["aria-describedby", "aria-labelledby", "style"]);
const COMMIT_OVERLAY_ATTRIBUTES = new Set(["aria-hidden", "data-aria-hidden", "style"]);

interface CommitDocumentFacts {
  readonly source: DocumentDto;
  readonly values: readonly (readonly [string, CommitPrimitive])[];
}

interface CommitDialogVisit {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly doc: DocumentDto;
  readonly documentFacts: CommitDocumentFacts;
  readonly destination: string;
  readonly open: true;
  readonly onCommit: (message: string) => Promise<void>;
  readonly onOpenChange: (open: boolean) => void;
  readonly isOwner: boolean;
  readonly initialMessage: string;
  readonly title: string;
  readonly description: string;
  readonly label: string;
  readonly gistControlPresent: boolean;
}

interface CommitDialogOperation {
  readonly identity: symbol;
  readonly visit: CommitDialogVisit;
  readonly currentVisit: CommitCurrentValue<CommitDialogVisit>;
  readonly origin: CommitDialogPublication;
  readonly message: string;
  readonly commit: (message: string) => Promise<void>;
}

interface CommitDialogTimerOwner {
  readonly identity: symbol;
  readonly visit: CommitDialogVisit;
  readonly currentVisit: CommitCurrentValue<CommitDialogVisit>;
  readonly operation: CommitDialogOperation;
  readonly onOpenChange: (open: boolean) => void;
  handle: ReturnType<typeof setTimeout> | undefined;
}

interface CommitDialogOperationHandoff {
  readonly previous: CommitDialogVisit;
  readonly current: CommitDialogVisit;
  readonly operation: CommitDialogOperation;
  readonly timer: CommitDialogTimerOwner | null;
}

interface CommitDialogState {
  readonly visit: CommitDialogVisit;
  readonly message: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly done: boolean;
  readonly operation: CommitDialogOperation | null;
  readonly closeTimer: CommitDialogTimerOwner | null;
}

interface CommitDialogAuthority {
  readonly visit: CommitDialogVisit;
  readonly revision: number;
  readonly state: CommitDialogState;
  readonly message: string;
  readonly trimmedMessage: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly done: boolean;
  readonly operation: CommitDialogOperation | null;
  readonly closeTimer: CommitDialogTimerOwner | null;
  readonly submitDisabled: boolean;
  readonly submitText: "Commit" | "Update gist" | "Published";
  readonly submitIcon: "busy" | "done" | null;
  readonly actionOrder: readonly [
    CommitDialogAction,
    CommitDialogAction,
  ];
}

interface CommitDialogAction {
  readonly identity: symbol;
  readonly visit: CommitDialogVisit;
  readonly documentFacts: CommitDocumentFacts;
  readonly message: string;
  readonly callback:
    | CommitDialogVisit["onCommit"]
    | CommitDialogVisit["onOpenChange"];
  readonly kind: CommitActionKind;
  readonly order: 0 | 1;
  readonly eligible: boolean;
}

interface CommitPublishedAction {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly action: CommitDialogAction;
  readonly element: HTMLButtonElement;
  readonly order: 0 | 1;
}

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

interface CommitActionReactMethods {
  readonly preventDefault: ReactKeyboardEvent<HTMLDivElement>["preventDefault"];
  readonly isDefaultPrevented: () => boolean;
  readonly isPropagationStopped: () => boolean;
}

interface CommitActionReactSnapshot {
  readonly event: ReactKeyboardEvent<HTMLDivElement>;
  readonly nativeEvent: KeyboardEvent;
  readonly target: HTMLElement;
  readonly currentTarget: HTMLDivElement;
  readonly phase: number;
  readonly methods: CommitActionReactMethods;
}

interface CommitActionNavigationPair {
  readonly publication: CommitDialogPublication;
  readonly authority: CommitActionKeyboardAuthority;
  readonly native: CommitActionKeyboardEventSnapshot;
  readonly capture: CommitActionReactSnapshot;
  readonly terminal: CommitActionKeyboardTerminalProof;
  readonly source: CommitPublishedAction;
  readonly destination: CommitPublishedAction;
  readonly key: CommitActionNavigationKey;
  readonly movement: object;
  readonly publicationClaim: object;
  readonly actionClaim: object;
  readonly sourceClaim: object;
  readonly destinationClaim: object;
}

interface CommitDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly CommitDomSnapshot[];
  readonly opaque: boolean;
}

interface CommitAncestorPlacement {
  readonly node: Node;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface CommitNodePlacement {
  readonly node: Node;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
  readonly ancestors: readonly CommitAncestorPlacement[];
}

interface CommitPlacement {
  readonly document: Document;
  readonly bridge: CommitNodePlacement;
  readonly overlay: CommitNodePlacement;
  readonly content: CommitNodePlacement;
}

interface CommitElementOwnerView {
  readonly element: () => Element | null;
}

interface CommitRefReplay {
  readonly owner: CommitElementOwnerView;
  readonly element: Element;
  detached: boolean;
  reattached: boolean;
}

interface CommitDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface CommitDialogPublication {
  readonly identity: symbol;
  readonly presentation: CommitDialogRender;
  readonly authority: CommitDialogAuthority;
  readonly ownerDocument: Document;
  readonly bridge: HTMLDivElement;
  readonly overlay: HTMLDivElement;
  readonly content: HTMLDivElement;
  readonly gistSlot: HTMLDivElement;
  readonly placement: CommitPlacement;
  readonly bridgeDom: CommitDomSnapshot;
  readonly overlayDom: CommitDomSnapshot;
  readonly contentDom: CommitDomSnapshot;
  readonly actions: readonly CommitPublishedAction[];
  readonly keyboard: CommitActionKeyboardAuthority | null;
  readonly retire: () => void;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
}

interface CommitPublicationReplay {
  readonly source: CommitDialogPublication;
  readonly bridgeDom: CommitDomSnapshot;
  readonly overlayDom: CommitDomSnapshot;
  readonly contentDom: CommitDomSnapshot;
  readonly placement: CommitPlacement;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface CommitPublicationRuntime {
  readonly publication: CommitDialogPublication;
  readonly publish: () => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly retireOrdinary: () => void;
  readonly noteRef: (
    owner: CommitElementOwnerView,
    element: Element | null,
    previous: Element | null,
  ) => void;
  readonly isExactReplay: () => boolean;
  readonly replay: () => CommitPublicationReplay | null;
}

interface CommitDialogRender {
  readonly authority: CommitDialogAuthority;
  readonly captureBridge: (element: HTMLDivElement | null) => void | (() => void);
  readonly captureGistSlot: (element: HTMLDivElement | null) => void | (() => void);
  readonly captureForm: (element: HTMLFormElement | null) => void | (() => void);
  readonly captureLabel: (element: HTMLLabelElement | null) => void | (() => void);
  readonly captureMessage: (element: HTMLInputElement | null) => void | (() => void);
  readonly captureStatic: (element: HTMLParagraphElement | null) => void | (() => void);
  readonly captureError: (element: HTMLDivElement | null) => void | (() => void);
  readonly captureCancel: (element: HTMLButtonElement | null) => void | (() => void);
  readonly captureSubmit: (element: HTMLButtonElement | null) => void | (() => void);
  readonly establish: () => void | (() => void);
  readonly owns: (publication: CommitDialogPublication, changing?: CommitChangingControl) => boolean;
  readonly onBridgeChangeCapture: (event: ReactChangeEvent<HTMLDivElement>) => void;
  readonly onBridgeChange: (event: ReactChangeEvent<HTMLDivElement>) => void;
  readonly onBridgeClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly onBridgeClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly onBridgeKeyDownCapture: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly onBridgeKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly onBridgeSubmitCapture: (event: ReactFormEvent<HTMLDivElement>) => void;
  readonly onBridgeSubmit: (event: ReactFormEvent<HTMLDivElement>) => void;
  readonly onMessageChange: (event: ReactChangeEvent<HTMLInputElement>) => void;
  readonly onMessageKeyDownCapture: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  readonly onMessageKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  readonly onCancel: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onSubmitClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onSubmit: (event: ReactFormEvent<HTMLFormElement>) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly authorizeNativeDelivery: (publication: CommitDialogPublication, event: Event) => void;
}

class CommitCurrentValue<T> {
  constructor(private value: T) {}

  get() {
    return this.value;
  }

  set(value: T) {
    this.value = value;
  }
}

class CommitElementOwner<T extends Element> implements CommitElementOwnerView {
  private current: T | null = null;
  private last: T | null = null;
  private binding: object | null = null;

  constructor(
    private readonly onChange: (
      owner: CommitElementOwnerView,
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
    const binding = element ? Object.freeze({}) : null;
    this.current = element;
    this.binding = binding;
    if (element) this.last = element;
    this.onChange(this, element, previous, last);
    if (!element || !binding) return;
    return () => {
      if (this.current !== element || this.binding !== binding) return;
      const detachedLast = this.last;
      this.current = null;
      this.binding = null;
      this.onChange(this, null, element, detachedLast);
    };
  };
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

function captureCommitActionReactEvent(
  event: ReactKeyboardEvent<HTMLDivElement>,
  authority: CommitActionKeyboardAuthority,
  native: CommitActionKeyboardEventSnapshot,
  bridge: HTMLDivElement,
): CommitActionReactSnapshot | null {
  try {
    const reactEvent = event as ReactKeyboardEvent<HTMLDivElement> & {
      preventDefault?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
    };
    const preventDefault = reactEvent.preventDefault;
    const isDefaultPrevented = reactEvent.isDefaultPrevented;
    const isPropagationStopped = reactEvent.isPropagationStopped;
    if (
      typeof preventDefault !== "function" ||
      typeof isDefaultPrevented !== "function" ||
      typeof isPropagationStopped !== "function" ||
      authority.apply(isDefaultPrevented, event, []) !== false ||
      authority.apply(isPropagationStopped, event, []) !== false ||
      reactEvent.preventDefault !== preventDefault ||
      reactEvent.isDefaultPrevented !== isDefaultPrevented ||
      reactEvent.isPropagationStopped !== isPropagationStopped ||
      event.nativeEvent !== native.event ||
      event.type !== native.type ||
      event.target !== native.target ||
      event.currentTarget !== bridge ||
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
      event.view !== native.view
    ) {
      return null;
    }
    return Object.freeze({
      event,
      nativeEvent: native.event,
      target: native.target,
      currentTarget: bridge,
      phase: native.phase,
      methods: Object.freeze({
        preventDefault,
        isDefaultPrevented,
        isPropagationStopped,
      }),
    });
  } catch {
    return null;
  }
}

function commitActionReactSnapshotMatches(
  snapshot: CommitActionReactSnapshot,
  authority: CommitActionKeyboardAuthority,
  currentTarget: HTMLDivElement | null,
) {
  try {
    const event = snapshot.event as ReactKeyboardEvent<HTMLDivElement> & {
      preventDefault?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
    };
    if (
      event.nativeEvent === snapshot.nativeEvent &&
      event.target === snapshot.target &&
      event.currentTarget === currentTarget &&
      event.preventDefault === snapshot.methods.preventDefault &&
      event.isDefaultPrevented === snapshot.methods.isDefaultPrevented &&
      event.isPropagationStopped === snapshot.methods.isPropagationStopped
    ) {
      if (
        authority.apply(
          snapshot.methods.isDefaultPrevented,
          snapshot.event,
          [],
        ) !== false ||
        authority.apply(
          snapshot.methods.isPropagationStopped,
          snapshot.event,
          [],
        ) !== false
      ) {
        return false;
      }
      return (
        event.preventDefault === snapshot.methods.preventDefault &&
        event.isDefaultPrevented === snapshot.methods.isDefaultPrevented &&
        event.isPropagationStopped === snapshot.methods.isPropagationStopped
      );
    }
    return false;
  } catch {
    return false;
  }
}

class CommitPublicationCoordinator {
  private activePublication: CommitDialogPublication | null = null;
  private successor: CommitDialogPublication | null = null;
  private replayValue: CommitPublicationReplay | null = null;
  private readonly retired = new WeakSet<CommitDialogPublication>();
  private readonly terminalPublications = new WeakSet<CommitDialogPublication>();
  private readonly actions = new WeakSet<object>();
  private readonly events = new WeakSet<object>();
  private readonly deliveredReactEvents = new WeakSet<object>();
  private readonly deliveredNativeEvents = new WeakSet<Event>();
  private readonly preparedSubmits = new WeakSet<Event>();
  private readonly attemptedNavigationReactEvents = new WeakSet<object>();
  private readonly attemptedNavigationNativeEvents = new WeakSet<object>();
  private readonly claimedNavigationReactEvents = new WeakSet<object>();
  private readonly claimedNavigationNativeEvents = new WeakSet<Event>();
  private readonly claimedNavigationPairs =
    new WeakSet<CommitActionNavigationPair>();
  private readonly claimedNavigationMovements = new WeakSet<object>();
  private readonly claimedNavigationPublicationClaims = new WeakSet<object>();
  private readonly claimedNavigationActionClaims = new WeakSet<object>();
  private readonly claimedNavigationSourceClaims = new WeakSet<object>();
  private readonly claimedNavigationDestinationClaims = new WeakSet<object>();
  private navigationDelivery: CommitDialogPublication | null = null;
  private readonly forms = new WeakSet<HTMLFormElement>();
  private readonly operations = new WeakSet<CommitDialogOperation>();
  private readonly timers = new WeakSet<CommitDialogTimerOwner>();
  private readonly firedTimers = new WeakSet<CommitDialogTimerOwner>();
  private enterDelivery = false;
  private readonly enterForms = new WeakSet<HTMLFormElement>();
  private readonly enterSubmits = new WeakSet<Event>();
  private readonly enterNativeEvents = new WeakSet<Event>();

  constructor(private readonly mount: symbol) {}

  enterIsDelivering() {
    return this.enterDelivery;
  }

  noteEnterForm(form: HTMLFormElement) {
    this.enterForms.add(form);
  }

  clearEnterForm(form: HTMLFormElement) {
    this.enterForms.delete(form);
  }

  enterOwnsForm(form: HTMLFormElement | null) {
    return form !== null && this.enterForms.has(form);
  }

  noteEnterSubmit(event: Event) {
    this.enterSubmits.add(event);
  }

  enterOwnsSubmit(event: Event) {
    return this.enterSubmits.has(event);
  }

  enterSawNative(event: Event) {
    return this.enterNativeEvents.has(event);
  }

  noteEnterNative(event: Event) {
    this.enterNativeEvents.add(event);
  }

  deliverEnter<T>(deliver: () => T): T | undefined {
    if (this.enterDelivery) return undefined;
    this.enterDelivery = true;
    try {
      return deliver();
    } finally {
      // Publication cleanup must not unlock an arbitrary callback still on the stack.
      this.enterDelivery = false;
    }
  }

  active() {
    return this.activePublication;
  }

  replay() {
    return this.replayValue;
  }

  publish(publication: CommitDialogPublication) {
    if (publication.authority.visit.mount !== this.mount || this.retired.has(publication)) return false;
    const previous = this.activePublication;
    if (previous && previous !== publication) previous.retire();
    this.activePublication = publication;
    this.successor = null;
    this.replayValue = null;
    return true;
  }

  retire(publication: CommitDialogPublication) {
    if (this.retired.has(publication)) return false;
    this.retired.add(publication);
    if (this.activePublication === publication) {
      this.activePublication = null;
      this.successor = publication;
    }
    return true;
  }

  isCurrent(publication: CommitDialogPublication) {
    return this.activePublication === publication && !this.retired.has(publication);
  }

  acceptsSuccessorOf(publication: CommitDialogPublication) {
    return (
      this.activePublication === null &&
      this.successor === publication &&
      this.retired.has(publication) &&
      !this.terminalPublications.has(publication)
    );
  }

  stageReplay(replay: CommitPublicationReplay) {
    if (!this.acceptsSuccessorOf(replay.source)) return false;
    this.replayValue = replay;
    return true;
  }

  abandonReplay(publication: CommitDialogPublication) {
    if (this.replayValue?.source === publication) this.replayValue = null;
    if (this.successor === publication) this.successor = null;
  }

  registerForm(form: HTMLFormElement) {
    this.forms.add(form);
  }

  ownsForm(form: HTMLFormElement) {
    return this.forms.has(form);
  }

  noteNativeEvent(event: Event) {
    this.deliveredNativeEvents.add(event);
  }

  nativeEventWasDelivered(event: Event) {
    return this.deliveredNativeEvents.has(event);
  }

  noteReactEvent(event: object) {
    this.deliveredReactEvents.add(event);
  }

  prepareSubmit(event: Event) {
    this.preparedSubmits.add(event);
  }

  submitIsPrepared(event: Event) {
    return this.preparedSubmits.has(event);
  }

  claimEvent(publication: CommitDialogPublication, action: object, event: object, nativeEvent: object) {
    if (
      !this.isCurrent(publication) ||
      this.actions.has(action) ||
      this.events.has(event) ||
      this.events.has(nativeEvent)
    ) {
      return false;
    }
    this.actions.add(action);
    this.events.add(event);
    this.events.add(nativeEvent);
    return true;
  }

  claimReactEvent(
    publication: CommitDialogPublication,
    action: object,
    event: object,
    nativeEvent: Event,
  ) {
    return (
      this.deliveredReactEvents.has(event) &&
      this.deliveredNativeEvents.has(nativeEvent) &&
      this.claimEvent(publication, action, event, nativeEvent)
    );
  }

  prepareNavigationCapture(event: object, nativeEvent: object) {
    if (
      this.navigationDelivery ||
      this.attemptedNavigationReactEvents.has(event) ||
      this.attemptedNavigationNativeEvents.has(nativeEvent)
    ) {
      return false;
    }
    this.attemptedNavigationReactEvents.add(event);
    this.attemptedNavigationNativeEvents.add(nativeEvent);
    return true;
  }

  prepareNavigationBubble(event: object, nativeEvent: object) {
    if (
      this.navigationDelivery ||
      this.attemptedNavigationReactEvents.has(event) ||
      !this.attemptedNavigationNativeEvents.has(nativeEvent)
    ) {
      return false;
    }
    this.attemptedNavigationReactEvents.add(event);
    return true;
  }

  claimNavigation(pair: CommitActionNavigationPair) {
    const nativeEvent = pair.native.event;
    if (
      this.navigationDelivery ||
      !this.isCurrent(pair.publication) ||
      pair.publication.keyboard !== pair.authority ||
      this.claimedNavigationPairs.has(pair) ||
      this.claimedNavigationMovements.has(pair.movement) ||
      this.claimedNavigationPublicationClaims.has(pair.publicationClaim) ||
      this.claimedNavigationActionClaims.has(pair.actionClaim) ||
      this.claimedNavigationSourceClaims.has(pair.sourceClaim) ||
      this.claimedNavigationDestinationClaims.has(pair.destinationClaim) ||
      this.claimedNavigationReactEvents.has(pair.capture.event) ||
      this.claimedNavigationNativeEvents.has(nativeEvent) ||
      !this.attemptedNavigationReactEvents.has(pair.capture.event) ||
      !this.attemptedNavigationNativeEvents.has(nativeEvent) ||
      !pair.authority.terminal.claim(pair.terminal)
    ) {
      return false;
    }
    this.claimedNavigationPairs.add(pair);
    this.claimedNavigationMovements.add(pair.movement);
    this.claimedNavigationPublicationClaims.add(pair.publicationClaim);
    this.claimedNavigationActionClaims.add(pair.actionClaim);
    this.claimedNavigationSourceClaims.add(pair.sourceClaim);
    this.claimedNavigationDestinationClaims.add(pair.destinationClaim);
    this.claimedNavigationReactEvents.add(pair.capture.event);
    this.claimedNavigationNativeEvents.add(nativeEvent);
    this.navigationDelivery = pair.publication;
    return true;
  }

  claimNavigationBubble(
    pair: CommitActionNavigationPair,
    event: object,
  ) {
    if (
      this.navigationDelivery !== pair.publication ||
      !this.claimedNavigationPairs.has(pair) ||
      this.claimedNavigationReactEvents.has(event) ||
      !this.attemptedNavigationReactEvents.has(event)
    ) {
      return false;
    }
    this.claimedNavigationReactEvents.add(event);
    return true;
  }

  navigationIsDelivering(publication: CommitDialogPublication) {
    return this.navigationDelivery === publication;
  }

  finishNavigation(publication: CommitDialogPublication) {
    if (this.navigationDelivery === publication) {
      this.navigationDelivery = null;
    }
  }

  claimTerminal(publication: CommitDialogPublication, action: object, event: object, nativeEvent: object) {
    if (this.terminalPublications.has(publication) || !this.claimEvent(publication, action, event, nativeEvent)) {
      return false;
    }
    this.terminalPublications.add(publication);
    return true;
  }

  claimTerminalReact(
    publication: CommitDialogPublication,
    action: object,
    event: object,
    nativeEvent: Event,
  ) {
    if (
      this.terminalPublications.has(publication) ||
      !this.claimReactEvent(publication, action, event, nativeEvent)
    ) {
      return false;
    }
    this.terminalPublications.add(publication);
    return true;
  }

  claimOperation(operation: CommitDialogOperation) {
    if (this.operations.has(operation)) return false;
    this.operations.add(operation);
    return true;
  }

  claimTimer(timer: CommitDialogTimerOwner) {
    if (this.timers.has(timer)) return false;
    this.timers.add(timer);
    return true;
  }

  claimTimerClose(
    publication: CommitDialogPublication,
    action: object,
    operation: CommitDialogOperation,
    timer: CommitDialogTimerOwner,
  ) {
    if (
      !this.isCurrent(publication) ||
      this.terminalPublications.has(publication) ||
      this.actions.has(action) ||
      !this.operations.has(operation) ||
      !this.timers.has(timer) ||
      this.firedTimers.has(timer)
    ) {
      return false;
    }
    this.terminalPublications.add(publication);
    this.actions.add(action);
    this.firedTimers.add(timer);
    return true;
  }
}

class CommitPresentationCache {
  private current: {
    readonly authority: CommitDialogAuthority;
    readonly render: CommitDialogRender;
  } | null = null;

  resolve(authority: CommitDialogAuthority, create: () => CommitDialogRender) {
    if (!this.current || !commitAuthoritiesMatch(this.current.authority, authority)) {
      this.current = Object.freeze({ authority, render: create() });
    }
    return this.current.render;
  }
}

function commitDocumentFacts(doc: DocumentDto): CommitDocumentFacts {
  const values = Object.entries(doc)
    .filter((entry) => {
      const value: unknown = entry[1];
      return value === null || value === undefined || ["string", "number", "boolean"].includes(typeof value);
    })
    .sort(([left], [right]) => left.localeCompare(right))
    .map((entry) => Object.freeze(entry as readonly [string, CommitPrimitive]));
  return Object.freeze({ source: doc, values: Object.freeze(values) });
}

function commitDocumentFactsMatch(facts: CommitDocumentFacts) {
  const current = commitDocumentFacts(facts.source);
  return (
    current.values.length === facts.values.length &&
    current.values.every(([name, value], index) => {
      const expected = facts.values[index];
      return expected?.[0] === name && Object.is(expected[1], value);
    })
  );
}

function commitDocumentFactsAllowOperationHandoff(
  previous: CommitDocumentFacts,
  current: CommitDocumentFacts,
) {
  if (
    previous.source === current.source ||
    previous.values.length !== current.values.length ||
    !commitDocumentFactsMatch(previous) ||
    !commitDocumentFactsMatch(current)
  ) {
    return false;
  }
  let unpublishedTransition = false;
  let publicationClockChange = false;
  let valueChanged = false;
  const exactResultShape = current.values.every(([name, value], index) => {
    const prior = previous.values[index];
    if (!prior || prior[0] !== name) return false;
    if (Object.is(prior[1], value)) return true;
    valueChanged = true;
    if (name === "hasUnpublishedChanges") {
      unpublishedTransition = prior[1] === true && value === false;
      return unpublishedTransition;
    }
    if (name === "publishedAt" || name === "updatedAt") {
      publicationClockChange = true;
      return true;
    }
    return false;
  });
  return (
    exactResultShape &&
    (!valueChanged || (unpublishedTransition && publicationClockChange))
  );
}

function commitVisitsAllowMetadataHandoff(
  previous: CommitDialogVisit,
  current: CommitDialogVisit,
) {
  return (
    previous !== current &&
    previous.mount === current.mount &&
    previous.destination === current.destination &&
    previous.open === current.open &&
    previous.onCommit === current.onCommit &&
    previous.onOpenChange === current.onOpenChange &&
    previous.isOwner === current.isOwner &&
    previous.initialMessage === current.initialMessage &&
    previous.title === current.title &&
    previous.description === current.description &&
    previous.label === current.label &&
    previous.gistControlPresent === current.gistControlPresent &&
    commitVisitFactsMatch(previous) &&
    commitVisitFactsMatch(current)
  );
}

function commitGistFirstPublicationAllowsVisitHandoff(
  previous: CommitDialogVisit,
  current: CommitDialogVisit,
) {
  const previousDoc = previous.doc;
  const currentDoc = current.doc;
  return (
    previousDoc.storage === "gist" &&
    currentDoc.storage === "gist" &&
    previous.isOwner &&
    current.isOwner &&
    previous.destination !== current.destination &&
    previousDoc.id === currentDoc.id &&
    Boolean(previousDoc.gistId) &&
    previousDoc.gistId === currentDoc.gistId &&
    Boolean(previousDoc.gistFile) &&
    previousDoc.gistFile === currentDoc.gistFile &&
    Boolean(previousDoc.githubUrl) &&
    previousDoc.githubUrl === currentDoc.githubUrl &&
    previousDoc.ownerId === currentDoc.ownerId &&
    previousDoc.publishedAt === null &&
    typeof currentDoc.publishedAt === "string" &&
    currentDoc.publishedAt.length > 0 &&
    !previous.gistControlPresent &&
    current.gistControlPresent
  );
}

function commitOperationAllowsVisitHandoff(
  operation: CommitDialogOperation,
  previous: CommitDialogVisit,
  current: CommitDialogVisit,
) {
  const presentationIsCompatible =
    (previous.destination === current.destination &&
      previous.gistControlPresent === current.gistControlPresent) ||
    commitGistFirstPublicationAllowsVisitHandoff(previous, current);
  return (
    operation.currentVisit.get() === previous &&
    operation.visit === previous &&
    previous.mount === current.mount &&
    presentationIsCompatible &&
    previous.open === current.open &&
    previous.onCommit === current.onCommit &&
    previous.onOpenChange === current.onOpenChange &&
    previous.isOwner === current.isOwner &&
    previous.initialMessage === current.initialMessage &&
    previous.title === current.title &&
    previous.description === current.description &&
    previous.label === current.label &&
    operation.commit === current.onCommit &&
    commitDocumentFactsAllowOperationHandoff(
      previous.documentFacts,
      current.documentFacts,
    )
  );
}

function commitDocumentKey(facts: CommitDocumentFacts) {
  return JSON.stringify(facts.values);
}

function initialCommitDialogState(visit: CommitDialogVisit): CommitDialogState {
  return Object.freeze({
    visit,
    message: visit.initialMessage,
    busy: false,
    error: null,
    done: false,
    operation: null,
    closeTimer: null,
  });
}

function commitState(
  state: CommitDialogState,
  change: Partial<Omit<CommitDialogState, "visit">>,
): CommitDialogState {
  return Object.freeze({ ...state, ...change });
}

function commitAuthoritiesMatch(
  previous: CommitDialogAuthority,
  current: CommitDialogAuthority,
  includeRevision = true,
) {
  return (
    previous.visit === current.visit &&
    (!includeRevision || previous.revision === current.revision) &&
    previous.state === current.state &&
    previous.message === current.message &&
    previous.trimmedMessage === current.trimmedMessage &&
    previous.busy === current.busy &&
    previous.error === current.error &&
    previous.done === current.done &&
    previous.operation === current.operation &&
    previous.closeTimer === current.closeTimer &&
    previous.submitDisabled === current.submitDisabled &&
    previous.submitText === current.submitText &&
    previous.submitIcon === current.submitIcon &&
    previous.actionOrder.length === current.actionOrder.length &&
    previous.actionOrder.every((action, index) => {
      const candidate = current.actionOrder[index];
      return Boolean(
        candidate &&
          action.visit === candidate.visit &&
          action.documentFacts === candidate.documentFacts &&
          action.message === candidate.message &&
          action.callback === candidate.callback &&
          action.kind === candidate.kind &&
          action.order === candidate.order &&
          action.eligible === candidate.eligible,
      );
    })
  );
}

function commitActionOrderMatches(authority: CommitDialogAuthority) {
  const [cancel, submit] = authority.actionOrder;
  return (
    authority.actionOrder.length === 2 &&
    cancel.kind === "cancel" &&
    cancel.order === 0 &&
    cancel.eligible &&
    cancel.visit === authority.visit &&
    cancel.documentFacts === authority.visit.documentFacts &&
    cancel.message === authority.message &&
    cancel.callback === authority.visit.onOpenChange &&
    submit.kind === "submit" &&
    submit.order === 1 &&
    submit.eligible === !authority.submitDisabled &&
    submit.visit === authority.visit &&
    submit.documentFacts === authority.visit.documentFacts &&
    submit.message === authority.message &&
    submit.callback === authority.visit.onCommit
  );
}

function commitVisitFactsMatch(visit: CommitDialogVisit) {
  const doc = visit.doc;
  return (
    commitDocumentFactsMatch(visit.documentFacts) &&
    visit.destination ===
      JSON.stringify([
        doc.id,
        doc.storage,
        doc.repoOwner,
        doc.repoName,
        doc.repoBranch,
        doc.repoPath,
        doc.gistId,
        doc.gistFile,
        doc.githubUrl,
        doc.ownerId,
        doc.storage === "gist" ? Boolean(doc.publishedAt) : null,
      ]) &&
    visit.initialMessage === `Update ${doc.repoPath ?? doc.gistFile ?? "document"}` &&
    visit.title === (doc.storage === "gist" ? "Update gist" : "Commit to GitHub") &&
    visit.description ===
      (doc.storage === "gist"
        ? "Publishes the current text to the gist."
        : `Creates a commit on ${doc.repoBranch} in ${doc.repoOwner}/${doc.repoName}.`) &&
    visit.label === (doc.storage === "gist" ? "Description" : "Commit message") &&
    visit.gistControlPresent ===
      Boolean(
        visit.isOwner &&
          doc.storage === "gist" &&
          doc.gistId &&
          doc.gistFile &&
          doc.githubUrl &&
          doc.publishedAt,
      )
  );
}

function commitAuthorityFactsMatch(
  authority: CommitDialogAuthority,
  latestAuthority: CommitCurrentValue<CommitDialogAuthority | null>,
  currentVisit: CommitCurrentValue<CommitDialogVisit | null>,
  activeOperation: CommitCurrentValue<CommitDialogOperation | null>,
  activeTimer: CommitCurrentValue<CommitDialogTimerOwner | null>,
  closedVisits: WeakSet<CommitDialogVisit>,
) {
  const state = authority.state;
  const operation = authority.operation;
  const timer = authority.closeTimer;
  return (
    latestAuthority.get() === authority &&
    currentVisit.get() === authority.visit &&
    !closedVisits.has(authority.visit) &&
    state.visit === authority.visit &&
    state.message === authority.message &&
    state.message.trim() === authority.trimmedMessage &&
    state.busy === authority.busy &&
    state.error === authority.error &&
    state.done === authority.done &&
    state.operation === operation &&
    state.closeTimer === timer &&
    authority.submitDisabled === (authority.busy || authority.done) &&
    authority.submitText ===
      (authority.done
        ? "Published"
        : authority.visit.doc.storage === "gist"
          ? "Update gist"
          : "Commit") &&
    authority.submitIcon === (authority.done ? "done" : authority.busy ? "busy" : null) &&
    commitActionOrderMatches(authority) &&
    commitVisitFactsMatch(authority.visit) &&
    (operation === null ||
      (activeOperation.get() === operation &&
        operation.currentVisit.get() === authority.visit &&
        commitVisitFactsMatch(operation.visit) &&
        operation.commit === authority.visit.onCommit &&
        operation.message === operation.message.trim())) &&
    (timer === null ||
      (activeTimer.get() === timer &&
        operation === timer.operation &&
        timer.currentVisit.get() === authority.visit &&
        commitVisitFactsMatch(timer.visit) &&
        timer.onOpenChange === authority.visit.onOpenChange))
  );
}

function commitPublishedActionsAreCurrent(
  publication: CommitDialogPublication,
  cancel: HTMLButtonElement,
  submit: HTMLButtonElement,
) {
  const expected = publication.authority.actionOrder.filter(
    ({ eligible }) => eligible,
  );
  return (
    commitActionOrderMatches(publication.authority) &&
    publication.actions.length === expected.length &&
    publication.actions.every((published, index) => {
      const action = expected[index];
      const element = action?.kind === "cancel" ? cancel : submit;
      return Boolean(
        action &&
          published.publicationIdentity === publication.identity &&
          published.action === action &&
          published.order === action.order &&
          published.element === element &&
          element.isConnected &&
          element.ownerDocument === publication.ownerDocument &&
          !element.disabled,
      );
    }) &&
    new Set(publication.actions.map(({ element }) => element)).size ===
      publication.actions.length
  );
}

function commitActionNavigationDestination(
  actions: readonly CommitPublishedAction[],
  source: CommitPublishedAction,
  key: CommitActionNavigationKey,
) {
  const sourceIndex = actions.indexOf(source);
  if (sourceIndex < 0) return null;
  let destinationIndex: number | null = null;
  if (
    (key === "ArrowLeft" || key === "ArrowUp") &&
    sourceIndex > 0
  ) {
    destinationIndex = sourceIndex - 1;
  } else if (
    (key === "ArrowRight" || key === "ArrowDown") &&
    sourceIndex + 1 < actions.length
  ) {
    destinationIndex = sourceIndex + 1;
  } else if (key === "Home" && sourceIndex !== 0) {
    destinationIndex = 0;
  } else if (key === "End" && sourceIndex !== actions.length - 1) {
    destinationIndex = actions.length - 1;
  }
  const destination =
    destinationIndex === null ? null : actions[destinationIndex];
  return destination && destination !== source ? destination : null;
}

function commitSnapshotAttributes(
  node: Node,
  content: HTMLDivElement,
  overlay: HTMLDivElement,
) {
  if (node.nodeType !== 1) return null;
  const element = node as Element;
  const controlledMessage =
    element.tagName === "INPUT" &&
    (element as HTMLElement).dataset.testid === "commit-message";
  return Object.freeze(
    [...element.attributes]
      .filter(
        ({ name }) =>
          !(element === content && COMMIT_RADIX_ATTRIBUTES.has(name)) &&
          !(element === overlay && COMMIT_OVERLAY_ATTRIBUTES.has(name)) &&
          !(controlledMessage && (name === "name" || name === "value")),
      )
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function commitSnapshotDom(
  node: Node,
  content: HTMLDivElement,
  overlay: HTMLDivElement,
  gistSlot: HTMLDivElement,
  opaque = false,
): CommitDomSnapshot {
  const gistChild = node.parentNode === gistSlot;
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: commitSnapshotAttributes(node, content, overlay),
    children: Object.freeze(
      opaque || gistChild
        ? []
        : [...node.childNodes].map((child) =>
            commitSnapshotDom(child, content, overlay, gistSlot, child.parentNode === gistSlot),
          ),
    ),
    opaque: opaque || gistChild,
  });
}

function commitDomMatches(
  snapshot: CommitDomSnapshot,
  ownerDocument: Document,
  content: HTMLDivElement,
  overlay: HTMLDivElement,
): boolean {
  const node = snapshot.node;
  if (
    !node.isConnected ||
    node.ownerDocument !== ownerDocument ||
    node.nodeValue !== snapshot.nodeValue
  ) {
    return false;
  }
  const attributes = commitSnapshotAttributes(node, content, overlay);
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
  if (snapshot.opaque) return true;
  return (
    node.childNodes.length === snapshot.children.length &&
    snapshot.children.every(
      (child, index) =>
        node.childNodes.item(index) === child.node &&
        commitDomMatches(child, ownerDocument, content, overlay),
    )
  );
}

function isCommitRadixFocusGuard(node: Node | null) {
  if (!node || node.nodeType !== 1) return false;
  const element = node as Element;
  return element.tagName === "SPAN" && element.hasAttribute("data-radix-focus-guard");
}

function commitPreviousSibling(node: Node) {
  let sibling = node.previousSibling;
  while (isCommitRadixFocusGuard(sibling)) sibling = sibling?.previousSibling ?? null;
  return sibling;
}

function commitNextSibling(node: Node) {
  let sibling = node.nextSibling;
  while (isCommitRadixFocusGuard(sibling)) sibling = sibling?.nextSibling ?? null;
  return sibling;
}

function captureCommitNodePlacement(
  node: Node,
  ownerDocument: Document,
  skipFocusGuards: boolean,
): CommitNodePlacement | null {
  const parent = node.parentNode;
  if (!parent || node.ownerDocument !== ownerDocument || !node.isConnected) return null;
  const ancestors: CommitAncestorPlacement[] = [];
  let ancestor = parent;
  while (ancestor !== ownerDocument) {
    const ancestorParent = ancestor.parentNode;
    if (!ancestorParent) return null;
    ancestors.push(
      Object.freeze({
        node: ancestor,
        parent: ancestorParent,
        previousSibling: commitPreviousSibling(ancestor),
        nextSibling: commitNextSibling(ancestor),
      }),
    );
    ancestor = ancestorParent;
  }
  return Object.freeze({
    node,
    parent,
    previousSibling: skipFocusGuards ? commitPreviousSibling(node) : node.previousSibling,
    nextSibling: skipFocusGuards ? commitNextSibling(node) : node.nextSibling,
    ancestors: Object.freeze(ancestors),
  });
}

function captureCommitPlacement(
  bridge: HTMLDivElement,
  overlay: HTMLDivElement,
  content: HTMLDivElement,
): CommitPlacement | null {
  const ownerDocument = content.ownerDocument;
  const bridgePlacement = captureCommitNodePlacement(bridge, ownerDocument, false);
  const overlayPlacement = captureCommitNodePlacement(overlay, ownerDocument, true);
  const contentPlacement = captureCommitNodePlacement(content, ownerDocument, true);
  if (!bridgePlacement || !overlayPlacement || !contentPlacement) return null;
  return Object.freeze({
    document: ownerDocument,
    bridge: bridgePlacement,
    overlay: overlayPlacement,
    content: contentPlacement,
  });
}

function commitNodePlacementMatches(placement: CommitNodePlacement, skipFocusGuards: boolean) {
  const node = placement.node;
  return (
    node.isConnected &&
    node.ownerDocument === placement.parent.ownerDocument &&
    node.parentNode === placement.parent &&
    (skipFocusGuards ? commitPreviousSibling(node) : node.previousSibling) === placement.previousSibling &&
    (skipFocusGuards ? commitNextSibling(node) : node.nextSibling) === placement.nextSibling &&
    placement.ancestors.every(
      (ancestor) =>
        ancestor.node.isConnected &&
        ancestor.node.parentNode === ancestor.parent &&
        commitPreviousSibling(ancestor.node) === ancestor.previousSibling &&
        commitNextSibling(ancestor.node) === ancestor.nextSibling,
    )
  );
}

function commitPlacementMatches(placement: CommitPlacement) {
  return (
    placement.bridge.node.ownerDocument === placement.document &&
    placement.overlay.node.ownerDocument === placement.document &&
    placement.content.node.ownerDocument === placement.document &&
    commitNodePlacementMatches(placement.bridge, false) &&
    commitNodePlacementMatches(placement.overlay, true) &&
    commitNodePlacementMatches(placement.content, true)
  );
}

function createCommitDomGuard(
  publication: CommitDialogPublication,
): CommitDomGuard | null {
  const ownerWindow = publication.ownerDocument.defaultView;
  const Observer = ownerWindow?.MutationObserver;
  if (!ownerWindow || !Observer) return null;
  const records: MutationRecord[] = [];
  let dirty = false;
  const opaqueNodes = new WeakSet<Node>();
  const rememberOpaqueNode = (node: Node) => {
    opaqueNodes.add(node);
    for (const child of node.childNodes) rememberOpaqueNode(child);
  };
  for (const child of publication.gistSlot.childNodes) rememberOpaqueNode(child);
  const isAllowed = (record: MutationRecord) => {
    if (
      record.type === "attributes" &&
      record.target === publication.content &&
      record.attributeName &&
      COMMIT_RADIX_ATTRIBUTES.has(record.attributeName)
    ) {
      return true;
    }
    if (
      record.type === "attributes" &&
      record.target === publication.overlay &&
      record.attributeName &&
      COMMIT_OVERLAY_ATTRIBUTES.has(record.attributeName)
    ) {
      return true;
    }
    if (
      record.type === "childList" &&
      record.target === publication.content.parentNode &&
      [...record.addedNodes, ...record.removedNodes].length > 0 &&
      [...record.addedNodes, ...record.removedNodes].every(isCommitRadixFocusGuard)
    ) {
      return true;
    }
    return (
      record.target !== publication.gistSlot &&
      opaqueNodes.has(record.target)
    );
  };
  const recordsAreAllowed = () => {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) return false;
      if (isAllowed(record)) continue;
      const input = record.target;
      const Input = publication.ownerDocument.defaultView?.HTMLInputElement;
      if (
        !Input ||
        record.type !== "attributes" ||
        record.attributeName !== "name" ||
        record.oldValue !== null ||
        !(input instanceof Input) ||
        input.type !== "text" ||
        input.dataset.testid !== "commit-message" ||
        !publication.content.contains(input) ||
        input.hasAttribute("name")
      ) {
        return false;
      }
      let restoredName = records[index + 1];
      const valueWrite = restoredName;
      if (
        valueWrite?.target === input &&
        valueWrite.type === "attributes" &&
        valueWrite.attributeName === "value"
      ) {
        if (input.getAttribute("value") !== publication.authority.message) return false;
        index += 1;
        restoredName = records[index + 1];
      }
      if (
        !restoredName ||
        restoredName.target !== input ||
        restoredName.type !== "attributes" ||
        restoredName.attributeName !== "name" ||
        restoredName.oldValue !== ""
      ) {
        return false;
      }
      index += 1;
    }
    return true;
  };
  const inspect = () => {
    records.push(...observer.takeRecords());
    if (!dirty && records.length > 0) {
      for (const record of records) {
        if (
          record.type !== "childList" ||
          record.target === publication.gistSlot ||
          !opaqueNodes.has(record.target)
        ) {
          continue;
        }
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          rememberOpaqueNode(node);
        }
      }
      dirty = !recordsAreAllowed();
      records.length = 0;
    }
  };
  const observer = new Observer((queued) => records.push(...queued));
  observer.observe(publication.bridge, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  observer.observe(publication.overlay, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  observer.observe(publication.content, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  const observedParents = new Set<Node>();
  for (const placement of [
    publication.placement.bridge,
    publication.placement.overlay,
    publication.placement.content,
  ]) {
    if (!observedParents.has(placement.parent)) {
      observedParents.add(placement.parent);
      observer.observe(placement.parent, { childList: true });
    }
    for (const ancestor of placement.ancestors) {
      if (observedParents.has(ancestor.parent)) continue;
      observedParents.add(ancestor.parent);
      observer.observe(ancestor.parent, { childList: true });
    }
  }
  return Object.freeze({
    isClean: () => {
      inspect();
      return !dirty;
    },
    release: () => {
      inspect();
      observer.disconnect();
    },
  });
}

function commitSyntheticEventShape(
  event: unknown,
  reactName: "onChange" | "onClick" | "onKeyDown" | "onSubmit",
  defaultPrevented: boolean,
) {
  if (!event || typeof event !== "object") return false;
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

function commitEventPath(
  nativeEvent: Event,
  target: EventTarget,
  ownerDocument: Document,
  required: readonly EventTarget[],
) {
  const ownerWindow = ownerDocument.defaultView;
  const path = nativeEvent.composedPath();
  return (
    !!ownerWindow &&
    path[0] === target &&
    required.every((entry) => path.includes(entry)) &&
    path.includes(ownerDocument)
  );
}

function exactCommitChange(
  event: ReactChangeEvent<HTMLInputElement>,
  input: HTMLInputElement,
  form: HTMLFormElement,
  content: HTMLDivElement,
) {
  if (!event || typeof event !== "object") return null;
  const ownerDocument = input.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  const nativeConstructorIsExact =
    !!ownerWindow &&
    (nativeEvent.constructor === ownerWindow.Event ||
      (!!ownerWindow.InputEvent && nativeEvent.constructor === ownerWindow.InputEvent));
  return ownerWindow &&
    commitSyntheticEventShape(event, "onChange", false) &&
    event.type === "change" &&
    nativeEvent instanceof ownerWindow.Event &&
    nativeConstructorIsExact &&
    (nativeEvent.type === "input" || nativeEvent.type === "change") &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    event.eventPhase === nativeEvent.eventPhase &&
    event.bubbles === nativeEvent.bubbles &&
    event.cancelable === nativeEvent.cancelable &&
    !event.defaultPrevented &&
    !nativeEvent.defaultPrevented &&
    event.currentTarget === input &&
    event.target === input &&
    nativeEvent.target === input &&
    input.isConnected &&
    input.form === form &&
    form.parentElement === content &&
    commitEventPath(nativeEvent, input, ownerDocument, [input, form, content])
    ? nativeEvent
    : null;
}

function exactCommitClick(
  event: ReactMouseEvent<HTMLElement>,
  currentTarget: HTMLElement,
  control: HTMLButtonElement,
  content: HTMLDivElement,
  form: HTMLFormElement | null,
) {
  if (!event || typeof event !== "object") return null;
  const ownerDocument = control.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  const Pointer = ownerWindow?.PointerEvent;
  const nativeConstructorIsExact =
    !!ownerWindow &&
    (nativeEvent.constructor === ownerWindow.MouseEvent ||
      (!!Pointer && nativeEvent.constructor === Pointer));
  const target = event.target;
  const required: EventTarget[] = [control, content];
  if (form) required.push(form);
  return ownerWindow &&
    commitSyntheticEventShape(event, "onClick", false) &&
    event.type === "click" &&
    nativeEvent instanceof ownerWindow.MouseEvent &&
    nativeConstructorIsExact &&
    nativeEvent.type === "click" &&
    nativeEvent.button === 0 &&
    event.button === nativeEvent.button &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    event.eventPhase === nativeEvent.eventPhase &&
    event.bubbles === nativeEvent.bubbles &&
    event.cancelable === nativeEvent.cancelable &&
    !event.defaultPrevented &&
    !nativeEvent.defaultPrevented &&
    event.currentTarget === currentTarget &&
    target instanceof ownerWindow.Node &&
    nativeEvent.target === target &&
    target.ownerDocument === ownerDocument &&
    control.isConnected &&
    !control.disabled &&
    control.contains(target) &&
    commitEventPath(nativeEvent, target, ownerDocument, required)
    ? nativeEvent
    : null;
}

type CommitEnterWrapper = ReactFormEvent<HTMLElement>;
type CommitEnterBoundary = "bridge-capture" | "input-capture" | "input" | "bridge";

interface CommitEnterDelivery {
  readonly event: CommitEnterWrapper;
  readonly nativeEvent: KeyboardEvent | SubmitEvent;
  readonly target: HTMLInputElement | HTMLFormElement;
  readonly phase: number;
  readonly prevent: CommitEnterWrapper["preventDefault"];
  queryDefault: CommitEnterWrapper["isDefaultPrevented"];
  readonly queryPropagation: CommitEnterWrapper["isPropagationStopped"];
  prevented: boolean;
  forwarding: CommitEnterDelivery | null;
}

interface CommitEnterNative {
  readonly event: KeyboardEvent | SubmitEvent;
  readonly path: readonly EventTarget[];
  readonly receiver: EventTarget;
  readonly trusted: boolean;
  readonly code: string | null;
  readonly location: number | null;
  readonly deliveries: Map<CommitEnterBoundary, CommitEnterDelivery>;
  finished: boolean;
}

interface CommitEnterClaim {
  readonly key: CommitEnterNative;
  readonly action: object;
  readonly message: string;
  readonly submit: CommitCurrentValue<WeakRef<SubmitEvent> | null>;
  readonly attempt: CommitCurrentValue<WeakRef<SubmitEvent> | null>;
  ready: boolean;
  consumed: boolean;
}

// The form retains only a weak reference to a key. Neither a completed dispatch
// nor a retained React handler can keep a stale event/claim alive.
function createCommitEnterRoute(
  publication: CommitDialogPublication,
  coordinator: CommitPublicationCoordinator,
  dom: {
    message: HTMLInputElement;
    form: HTMLFormElement;
    submit: HTMLButtonElement;
    content: HTMLDivElement;
    bridge: HTMLDivElement;
  },
  isCurrent: () => boolean,
  invalidate: () => void,
  commit: () => void,
) {
  const ownerDocument = publication.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) return null;
  const Keyboard = ownerWindow.KeyboardEvent;
  const Submit = ownerWindow.SubmitEvent;
  const EventConstructor = ownerWindow.Event;
  const composedPath = EventConstructor.prototype.composedPath;
  const getModifierState = Keyboard.prototype.getModifierState;
  const add = ownerWindow.addEventListener;
  const remove = ownerWindow.removeEventListener;
  const apply = Reflect.apply;
  const nativeProofs = new WeakMap<Event, CommitEnterNative>();
  const keys = new WeakMap<KeyboardEvent, CommitEnterClaim>();
  const forms = new WeakMap<HTMLFormElement, WeakRef<KeyboardEvent>>();
  const submits = new WeakMap<SubmitEvent, CommitEnterClaim>();
  const wrappers = new WeakMap<object, CommitEnterDelivery>();
  const seen = new WeakSet<Event>();
  const replayed = new WeakSet<Event>();
  let released = false;

  const internal = () =>
    !released &&
    coordinator.isCurrent(publication) &&
    !publication.isRetired() &&
    !publication.authority.submitDisabled &&
    publication.authority.trimmedMessage.length > 0;
  const listenerIsCurrent = () =>
    ownerDocument.defaultView === ownerWindow &&
    ownerWindow.KeyboardEvent === Keyboard &&
    ownerWindow.SubmitEvent === Submit &&
    ownerWindow.Event === EventConstructor &&
    EventConstructor.prototype.composedPath === composedPath &&
    Keyboard.prototype.getModifierState === getModifierState &&
    ownerWindow.addEventListener === add &&
    ownerWindow.removeEventListener === remove;
  const current = () => {
    const exact =
      listenerIsCurrent() &&
      dom.message.ownerDocument === ownerDocument &&
      dom.form.ownerDocument === ownerDocument &&
      dom.content.ownerDocument === ownerDocument &&
      dom.bridge.ownerDocument === ownerDocument &&
      dom.message.isConnected &&
      dom.form.isConnected &&
      dom.content.isConnected &&
      dom.bridge.isConnected &&
      dom.message.form === dom.form &&
      dom.message.parentElement === dom.form &&
      dom.form.parentElement === dom.content &&
      !dom.message.disabled &&
      dom.submit.isConnected &&
      dom.submit.form === dom.form &&
      !dom.submit.disabled &&
      dom.message.value === publication.authority.message &&
      dom.message.value.trim() === publication.authority.trimmedMessage &&
      ownerDocument.activeElement === dom.message &&
      isCurrent();
    if (!exact && internal()) invalidate();
    return exact && internal();
  };
  const pending = () => {
    const key = forms.get(dom.form)?.deref();
    return key ? keys.get(key) : undefined;
  };
  const retains = (claim: CommitEnterClaim) =>
    internal() &&
    !claim.consumed &&
    keys.get(claim.key.event as KeyboardEvent) === claim &&
    claim.message === publication.authority.trimmedMessage;
  const nativeMatches = (
    proof: CommitEnterNative,
    prevented: boolean,
    dispatching: boolean,
  ) => {
    const event = proof.event;
    const keyboard = event instanceof Keyboard;
    const target = keyboard ? dom.message : dom.form;
    if (
      event.type !== (keyboard ? "keydown" : "submit") ||
      event.target !== target ||
      event.bubbles !== true ||
      event.cancelable !== true ||
      event.defaultPrevented !== prevented ||
      event.cancelBubble !== false ||
      event.isTrusted !== proof.trusted ||
      (dispatching && event.eventPhase === EventConstructor.NONE) ||
      (!dispatching && event.eventPhase !== EventConstructor.NONE)
    ) {
      return false;
    }
    if (keyboard) {
      if (
        event.key !== "Enter" ||
        event.code !== proof.code ||
        event.location !== proof.location ||
        !["", "Enter", "NumpadEnter"].includes(event.code) ||
        (event.location !== 0 && event.location !== 3) ||
        (event.code === "NumpadEnter" && event.location !== 3) ||
        (event.code === "Enter" && event.location !== 0) ||
        event.repeat !== false ||
        event.isComposing !== false ||
        event.altKey !== false ||
        event.ctrlKey !== false ||
        event.metaKey !== false ||
        event.shiftKey !== false ||
        apply(getModifierState, event, ["Alt"]) !== false ||
        apply(getModifierState, event, ["Control"]) !== false ||
        apply(getModifierState, event, ["Meta"]) !== false ||
        apply(getModifierState, event, ["Shift"]) !== false
      ) {
        return false;
      }
    } else if (
      !(event instanceof Submit) ||
      (event.submitter !== null && event.submitter !== dom.submit)
    ) {
      return false;
    }
    if (!dispatching) return true;
    const path = apply(composedPath, event, []) as EventTarget[];
    return (
      path.length === proof.path.length &&
      path.every((entry, index) => entry === proof.path[index]) &&
      path[0] === target &&
      path.includes(dom.form) &&
      path.includes(dom.content) &&
      path.at(-2) === ownerDocument &&
      path.at(-1) === proof.receiver
    );
  };
  const methodsMatch = (delivery: CommitEnterDelivery) =>
    delivery.event.preventDefault === delivery.prevent &&
    delivery.event.isDefaultPrevented === delivery.queryDefault &&
    delivery.event.isPropagationStopped === delivery.queryPropagation;
  const sharesPhase = (earlier: CommitEnterDelivery, active: CommitEnterDelivery) =>
    earlier.nativeEvent === active.nativeEvent &&
    earlier.phase === active.phase &&
    earlier.target === active.target &&
    earlier.prevent === active.prevent &&
    earlier.queryDefault === active.queryDefault &&
    earlier.queryPropagation === active.queryPropagation;
  const deliveryMatches = (
    delivery: CommitEnterDelivery,
    active: CommitEnterDelivery | null,
    currentTarget: HTMLElement | null,
  ) => {
    const event = delivery.event;
    const native = delivery.nativeEvent;
    const keyboard = native instanceof Keyboard;
    const key = event as ReactKeyboardEvent<HTMLElement>;
    const target = event.currentTarget;
    return (
      event.nativeEvent === native &&
      event.target === delivery.target &&
      (event === active?.event
        ? target === currentTarget
        : target === null ||
          (!!active && sharesPhase(delivery, active) && target === currentTarget)) &&
      event.type === (keyboard ? "keydown" : "submit") &&
      event.eventPhase === delivery.phase &&
      event.bubbles === true &&
      event.cancelable === true &&
      event.isTrusted === native.isTrusted &&
      event.defaultPrevented === delivery.prevented &&
      (!keyboard ||
        (key.key === native.key &&
          key.code === native.code &&
          key.location === native.location &&
          key.repeat === false &&
          key.altKey === false &&
          key.ctrlKey === false &&
          key.metaKey === false &&
          key.shiftKey === false)) &&
      methodsMatch(delivery)
    );
  };
  const validate = (
    claim: CommitEnterClaim,
    proof: CommitEnterNative,
    deliveries: readonly CommitEnterDelivery[],
    active: CommitEnterDelivery | null,
    currentTarget: HTMLElement | null,
    prevented = false,
  ) => {
    const facts = () =>
      retains(claim) &&
      current() &&
      nativeMatches(claim.key, false, proof === claim.key) &&
      (proof === claim.key ||
        (claim.ready &&
          pending() === claim &&
          submits.get(proof.event as SubmitEvent) === claim &&
          claim.submit.get()?.deref() === proof.event &&
          nativeMatches(proof, prevented, true))) &&
      deliveries.every((entry) =>
        deliveryMatches(entry, active, currentTarget),
      ) &&
      internal() &&
      retains(claim);
    if (!facts()) return false;
    for (const delivery of deliveries) {
      // Public queries may reenter, retire the dialog, or replace another
      // method. Validate after each call, never invoking an earlier snapshot.
      if (!methodsMatch(delivery)) return false;
      const defaultPrevented = apply(delivery.queryDefault, delivery.event, []);
      if (defaultPrevented !== delivery.prevented || !facts()) return false;
      if (!methodsMatch(delivery)) return false;
      const propagationStopped = apply(
        delivery.queryPropagation,
        delivery.event,
        [],
      );
      if (propagationStopped !== false || !facts()) return false;
    }
    return facts();
  };
  const readDelivery = (
    event: CommitEnterWrapper,
    proof: CommitEnterNative,
    target: HTMLInputElement | HTMLFormElement,
  ): CommitEnterDelivery | null => {
    const previous = wrappers.get(event);
    if (previous) {
      return previous.nativeEvent === proof.event && methodsMatch(previous)
        ? previous
        : null;
    }
    const prevent = event.preventDefault;
    const queryDefault = event.isDefaultPrevented;
    const queryPropagation = event.isPropagationStopped;
    if (
      typeof prevent !== "function" ||
      typeof queryDefault !== "function" ||
      typeof queryPropagation !== "function"
    ) {
      return null;
    }
    return {
      event,
      nativeEvent: proof.event,
      target,
      phase: proof.event.eventPhase,
      prevent,
      queryDefault,
      queryPropagation,
      prevented: false,
      forwarding: null,
    };
  };
  const deliver = (
    event: CommitEnterWrapper,
    boundary: CommitEnterBoundary,
    keyboard: boolean,
  ) => {
    if (!event || typeof event !== "object") return;
    const native = event.nativeEvent;
    const proof = nativeProofs.get(native);
    const claim = keyboard
      ? keys.get(native as KeyboardEvent)
      : submits.get(native as SubmitEvent);
    if (!proof || !claim || proof.finished || replayed.has(native)) return;
    const order: CommitEnterBoundary[] = keyboard
      ? ["bridge-capture", "input-capture", "input", "bridge"]
      : ["bridge-capture", "input", "bridge"];
    const previous = proof.deliveries.get(boundary);
    if (!previous && order[proof.deliveries.size] !== boundary) return;
    const target = keyboard ? dom.message : dom.form;
    const currentTarget = boundary.startsWith("bridge") ? dom.bridge : target;
    const expectedPhase = boundary.endsWith("capture")
      ? EventConstructor.CAPTURING_PHASE
      : EventConstructor.BUBBLING_PHASE;
    if (
      native.eventPhase !== expectedPhase ||
      native.currentTarget === ownerDocument ||
      native.currentTarget === proof.receiver ||
      !native.currentTarget ||
      !proof.path.includes(native.currentTarget)
    ) {
      return;
    }
    if (
      previous &&
      (previous.event === event ||
        deliveryMatches(previous, null, null) ||
        deliveryMatches(previous, previous, currentTarget))
    ) {
      return;
    }
    const delivery = readDelivery(event, proof, target);
    if (!delivery) return;
    const deliveries = [
      ...[...claim.key.deliveries.values()].filter((entry) => entry !== previous),
      ...(proof === claim.key
        ? []
        : [...proof.deliveries.values()].filter((entry) => entry !== previous)),
      delivery,
    ];
    // Distinct public aliases can forward React's live per-phase currentTarget.
    // Record only this observed transition, not an assumed hidden backing object.
    const forwarding = deliveries.filter((entry) =>
      entry !== delivery &&
      sharesPhase(entry, delivery) &&
      entry.event.currentTarget === currentTarget,
    );
    if (!validate(claim, proof, deliveries, delivery, currentTarget)) return;
    for (const entry of forwarding) entry.forwarding = delivery;
    wrappers.set(event, delivery);
    proof.deliveries.set(boundary, delivery);
  };
  const remember: EventListener = function (this: EventTarget, event) {
    coordinator.deliverEnter(() => {
      if (
        released ||
        !coordinator.isCurrent(publication)
      ) return;
      if (seen.has(event) || coordinator.enterSawNative(event)) {
        replayed.add(event);
        return;
      }
      if (!(event instanceof Keyboard) && !(event instanceof Submit)) return;
      const keyboard = event instanceof Keyboard;
      if (
        (keyboard
          ? event.target !== dom.message || event.key !== "Enter"
          : !(event instanceof Submit) || event.target !== dom.form) ||
        !listenerIsCurrent() ||
        event.currentTarget !== this ||
        event.eventPhase !== EventConstructor.CAPTURING_PHASE
      ) {
        return;
      }
      if (!keyboard && !pending()) return;
      const path = apply(composedPath, event, []) as EventTarget[];
      if (path.at(-1) !== this || path.at(-2) !== ownerDocument) return;
      const proof: CommitEnterNative = {
        event,
        path,
        receiver: this,
        trusted: event.isTrusted,
        code: keyboard ? event.code : null,
        location: keyboard ? event.location : null,
        deliveries: new Map(),
        finished: false,
      };
      seen.add(event);
      coordinator.noteEnterNative(event);
      nativeProofs.set(event, proof);
      if (keyboard) {
        const claim: CommitEnterClaim = {
          key: proof,
          action: Object.freeze({}),
          message: publication.authority.trimmedMessage,
          submit: new CommitCurrentValue<WeakRef<SubmitEvent> | null>(null),
          attempt: new CommitCurrentValue<WeakRef<SubmitEvent> | null>(null),
          ready: false,
          consumed: false,
        };
        keys.set(event, claim);
        // A malformed/unfinished Enter still cannot fall back to native-submit
        // authority. A second key may not replace a rightful pending claim.
        const previous = pending();
        if (
          !previous ||
          (previous.key.event.eventPhase === EventConstructor.NONE &&
            (!previous.ready ||
              previous.attempt.get()?.deref()?.eventPhase === EventConstructor.NONE))
        ) {
          forms.set(dom.form, new WeakRef(event));
        }
        coordinator.noteEnterForm(dom.form);
      } else {
        coordinator.noteEnterSubmit(event);
        const claim = pending();
        const selected = claim?.submit.get()?.deref();
        if (
          claim &&
          selected &&
          selected.eventPhase === EventConstructor.NONE &&
          retains(claim) &&
          pending() === claim &&
          claim.submit.get()?.deref() === selected
        ) {
          // An ended attempt must not reserve a good key indefinitely. Keep its
          // native identity rejected, without displacing a still-live dispatch.
          replayed.add(selected);
          submits.delete(selected);
          claim.submit.set(null);
        }
        if (claim && !claim.submit.get()?.deref()) {
          submits.set(event, claim);
          claim.attempt.set(new WeakRef(event));
        }
      }
    });
  };
  const submitBoundary = (
    event: CommitEnterWrapper,
    boundary: "bridge-capture" | "input" | "bridge",
  ) => {
    if (!pending()) return false;
    coordinator.deliverEnter(() => {
      if (!event || typeof event !== "object") return;
      const native = event.nativeEvent;
      const claim = submits.get(native as SubmitEvent);
      const proof = nativeProofs.get(native);
      if (!claim || !proof || proof.finished || !claim.ready) return;
      const selected = claim.submit.get()?.deref();
      if (selected && selected !== native) return;
      const previous = claim.submit.get();
      if (!selected) claim.submit.set(new WeakRef(native as SubmitEvent));
      const size = proof.deliveries.size;
      deliver(event, boundary, false);
      if (proof.deliveries.size === size && !selected) claim.submit.set(previous);
    });
    return true;
  };
  const finish = (event: Event) => {
    const proof = nativeProofs.get(event);
    if (!proof) return false;
    coordinator.deliverEnter(() => {
      if (
        proof.finished ||
        replayed.has(event) ||
        event.currentTarget !== ownerDocument ||
        event.eventPhase !== EventConstructor.BUBBLING_PHASE
      ) {
        return;
      }
      proof.finished = true;
      const keyboard = event instanceof Keyboard;
      const claim = keyboard
        ? keys.get(event)
        : submits.get(event as SubmitEvent);
      const final = proof.deliveries.get("bridge");
      if (!claim || !final) return;
      const deliveries = [
        ...claim.key.deliveries.values(),
        ...(keyboard ? [] : proof.deliveries.values()),
      ];
      if (!validate(claim, proof, deliveries, null, null)) return;
      if (keyboard) {
        if (pending() === claim) claim.ready = true;
        return;
      }
      if (!methodsMatch(final) || !retains(claim)) return;
      apply(final.prevent, final.event, []);
      if (!retains(claim)) return;
      // React 19 changes this callable during preventDefault. Adopt only this
      // immediate result, including the previously observed live phase aliases.
      const queryDefault = final.event.isDefaultPrevented;
      if (!retains(claim) || typeof queryDefault !== "function") return;
      for (const delivery of deliveries) {
        if (delivery.forwarding !== final) continue;
        delivery.queryDefault = queryDefault;
        delivery.prevented = true;
      }
      final.queryDefault = queryDefault;
      final.prevented = true;
      if (!validate(claim, proof, deliveries, null, null, true)) return;
      if (
        !retains(claim) ||
        !coordinator.claimTerminal(
          publication,
          claim.action,
          final.event,
          event,
        )
      ) {
        return;
      }
      claim.consumed = true;
      coordinator.clearEnterForm(dom.form);
      commit();
    });
    return true;
  };
  apply(add, ownerWindow, ["keydown", remember, true]);
  apply(add, ownerWindow, ["submit", remember, true]);
  return {
    key: (event: ReactKeyboardEvent<HTMLElement>, boundary: CommitEnterBoundary) =>
      coordinator.deliverEnter(() => {
        if (!event || typeof event !== "object") return true;
        const native = event.nativeEvent;
        const recognized =
          nativeProofs.has(native) ||
          coordinator.enterSawNative(native) ||
          (native instanceof Keyboard &&
            native.target === dom.message &&
            native.key === "Enter") ||
          (event.target === dom.message && event.key === "Enter");
        if (recognized) deliver(event, boundary, true);
        return recognized;
      }),
    submit: submitBoundary,
    finish,
    clear: () => {
      forms.delete(dom.form);
      coordinator.clearEnterForm(dom.form);
    },
    release: () => {
      if (released) return;
      released = true;
      forms.delete(dom.form);
      apply(remove, ownerWindow, ["keydown", remember, true]);
      apply(remove, ownerWindow, ["submit", remember, true]);
    },
  };
}

function exactOwnedCommitSubmit(
  event: ReactFormEvent<HTMLFormElement>,
  coordinator: CommitPublicationCoordinator,
) {
  if (!event || typeof event !== "object") return null;
  const candidate = event as { currentTarget?: unknown };
  const possibleForm = candidate.currentTarget;
  if (!possibleForm || typeof possibleForm !== "object") return null;
  const possibleDocument = Reflect.get(possibleForm, "ownerDocument");
  if (!possibleDocument || typeof possibleDocument !== "object") return null;
  const ownerDocument = possibleDocument as Document;
  const ownerWindow = ownerDocument.defaultView;
  if (
    !ownerWindow ||
    !(possibleForm instanceof ownerWindow.HTMLFormElement)
  ) {
    return null;
  }
  const form = possibleForm;
  if (form.ownerDocument !== ownerDocument) return null;
  if (!coordinator.ownsForm(form)) return null;
  const Submit = ownerWindow.SubmitEvent;
  if (!Submit) return null;
  const nativeEvent = event.nativeEvent;
  const prepared = coordinator.submitIsPrepared(nativeEvent);
  const submitter = nativeEvent instanceof Submit ? nativeEvent.submitter : null;
  return (
    commitSyntheticEventShape(event, "onSubmit", prepared) &&
    event.type === "submit" &&
    nativeEvent instanceof Submit &&
    nativeEvent.constructor === Submit &&
    nativeEvent.type === "submit" &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    event.eventPhase === nativeEvent.eventPhase &&
    event.bubbles === nativeEvent.bubbles &&
    event.cancelable === nativeEvent.cancelable &&
    event.defaultPrevented === prepared &&
    nativeEvent.defaultPrevented === prepared &&
    event.target === form &&
    nativeEvent.target === form &&
    (submitter === null ||
      (submitter instanceof ownerWindow.HTMLButtonElement &&
        submitter.type === "submit" &&
        submitter.form === form)) &&
    form.isConnected &&
    commitEventPath(nativeEvent, form, ownerDocument, [form])
  )
    ? nativeEvent
    : null;
}

function exactRenderedCommitSubmit(
  event: ReactFormEvent<HTMLFormElement>,
  form: HTMLFormElement,
  submit: HTMLButtonElement,
  content: HTMLDivElement,
) {
  if (!event || typeof event !== "object") return null;
  const ownerDocument = form.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  return ownerWindow?.SubmitEvent &&
    commitSyntheticEventShape(event, "onSubmit", true) &&
    event.type === "submit" &&
    nativeEvent instanceof ownerWindow.SubmitEvent &&
    nativeEvent.constructor === ownerWindow.SubmitEvent &&
    nativeEvent.type === "submit" &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    event.eventPhase === nativeEvent.eventPhase &&
    event.bubbles === nativeEvent.bubbles &&
    event.cancelable === nativeEvent.cancelable &&
    event.defaultPrevented &&
    nativeEvent.defaultPrevented &&
    event.currentTarget === form &&
    event.target === form &&
    nativeEvent.target === form &&
    (nativeEvent.submitter === null || nativeEvent.submitter === submit) &&
    form.isConnected &&
    form.parentElement === content &&
    submit.isConnected &&
    submit.form === form &&
    form.contains(submit) &&
    commitEventPath(nativeEvent, form, ownerDocument, [form, content])
    ? nativeEvent
    : null;
}

function createCommitPublicationRuntime(
  presentation: CommitDialogRender,
  coordinator: CommitPublicationCoordinator,
  owners: readonly CommitElementOwnerView[],
  dom: {
    bridge: HTMLDivElement;
    overlay: HTMLDivElement;
    content: HTMLDivElement;
    gistSlot: HTMLDivElement;
  },
  onRetire: (publication: CommitDialogPublication) => void,
): CommitPublicationRuntime {
  const placement = captureCommitPlacement(dom.bridge, dom.overlay, dom.content);
  if (!placement) throw new Error("Cannot publish commit controls without a committed portal");
  const bridgeDom = commitSnapshotDom(dom.bridge, dom.content, dom.overlay, dom.gistSlot);
  const overlayDom = commitSnapshotDom(dom.overlay, dom.content, dom.overlay, dom.gistSlot);
  const contentDom = commitSnapshotDom(dom.content, dom.content, dom.overlay, dom.gistSlot);
  const ownerWindow = placement.document.defaultView;
  if (!ownerWindow) {
    throw new Error("Cannot publish commit controls without an owner Window");
  }
  const keyboard = captureCommitActionKeyboardAuthority(placement.document);
  const publicationIdentity = Symbol("commit-dialog-publication");
  const actionElements = [owners.at(-2)?.element(), owners.at(-1)?.element()];
  const actions = Object.freeze(
    presentation.authority.actionOrder.flatMap((action) => {
      if (!action.eligible) return [];
      const element = actionElements[action.order];
      if (!(element instanceof ownerWindow.HTMLButtonElement)) {
        return [];
      }
      return [
        Object.freeze<CommitPublishedAction>({
          identity: Symbol(`commit-${action.kind}-published-action`),
          publicationIdentity,
          action,
          element,
          order: action.order,
        }),
      ];
    }),
  );
  let retired = false;
  let layoutRetired = false;
  let established = false;
  let invalidReplay = false;
  let replayRefs: CommitRefReplay[] = [];
  let guard: CommitDomGuard | null = null;
  const publishedDomMatches = () =>
    Boolean(
      guard &&
        guard.isClean() &&
        commitPlacementMatches(placement) &&
        commitDomMatches(bridgeDom, placement.document, dom.content, dom.overlay) &&
        commitDomMatches(overlayDom, placement.document, dom.content, dom.overlay) &&
        commitDomMatches(contentDom, placement.document, dom.content, dom.overlay),
    );
  const retire = (reason: CommitRetirement) => {
    if (reason === "layout") layoutRetired = true;
    if (retired) return;
    retired = true;
    keyboard?.terminal.release();
    if (reason === "ordinary") invalidReplay = true;
    onRetire(publication);
    coordinator.retire(publication);
    queueMicrotask(() => {
      if (coordinator.replay()?.source !== publication) guard?.release();
    });
  };
  const publication: CommitDialogPublication = Object.freeze({
    identity: publicationIdentity,
    presentation,
    authority: presentation.authority,
    ownerDocument: placement.document,
    bridge: dom.bridge,
    overlay: dom.overlay,
    content: dom.content,
    gistSlot: dom.gistSlot,
    placement,
    bridgeDom,
    overlayDom,
    contentDom,
    actions,
    keyboard,
    retire: () => retire("ordinary"),
    isRetired: () => retired,
    publishedDomMatches,
  });
  const refsHaveExactReplay = () =>
    !invalidReplay &&
    replayRefs.length === owners.length &&
    replayRefs.every(
      (entry) =>
        entry.detached &&
        entry.reattached &&
        entry.owner.element() === entry.element,
    );
  return Object.freeze({
    publication,
    publish: () => {
      established = true;
      replayRefs = owners.map((owner) => {
        const element = owner.element();
        if (!element) throw new Error("Cannot publish commit controls without every committed ref");
        return { owner, element, detached: false, reattached: false };
      });
      guard = createCommitDomGuard(publication);
      if (
        actions.length !==
          presentation.authority.actionOrder.filter(
            ({ eligible }) => eligible,
          ).length ||
        !guard ||
        !coordinator.publish(publication)
      ) {
        keyboard?.terminal.release();
        guard?.release();
        return false;
      }
      return true;
    },
    retireForElement: () => retire("element"),
    retireForLayout: () => retire("layout"),
    retireOrdinary: () => retire("ordinary"),
    noteRef: (
      owner: CommitElementOwnerView,
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
      } else if (element === proof.element && previous === null && proof.detached) {
        proof.reattached = true;
      } else if (element !== previous) {
        invalidReplay = true;
      }
    },
    isExactReplay: () =>
      retired &&
      layoutRetired &&
      established &&
      refsHaveExactReplay() &&
      publishedDomMatches(),
    replay: () =>
      guard
        ? Object.freeze({
            source: publication,
            bridgeDom,
            overlayDom,
            contentDom,
            placement,
            historyIsClean: guard.isClean,
            release: guard.release,
          })
        : null,
  });
}

function commitReplayAllowsPublication(
  coordinator: CommitPublicationCoordinator,
  authority: CommitDialogAuthority,
  dom: { bridge: HTMLDivElement; overlay: HTMLDivElement; content: HTMLDivElement },
) {
  const replay = coordinator.replay();
  if (!replay) return true;
  const sameAuthority = commitAuthoritiesMatch(replay.source.authority, authority, false);
  const exact =
    sameAuthority &&
    coordinator.acceptsSuccessorOf(replay.source) &&
    replay.historyIsClean() &&
    commitPlacementMatches(replay.placement) &&
    replay.source.bridge === dom.bridge &&
    replay.source.overlay === dom.overlay &&
    replay.source.content === dom.content &&
    commitDomMatches(
      replay.bridgeDom,
      replay.source.ownerDocument,
      replay.source.content,
      replay.source.overlay,
    ) &&
    commitDomMatches(
      replay.overlayDom,
      replay.source.ownerDocument,
      replay.source.content,
      replay.source.overlay,
    ) &&
    commitDomMatches(
      replay.contentDom,
      replay.source.ownerDocument,
      replay.source.content,
      replay.source.overlay,
    );
  coordinator.abandonReplay(replay.source);
  replay.release();
  return !sameAuthority || exact;
}

function createCommitDialogRender(
  authority: CommitDialogAuthority,
  coordinator: CommitPublicationCoordinator,
  latestAuthority: CommitCurrentValue<CommitDialogAuthority | null>,
  currentVisit: CommitCurrentValue<CommitDialogVisit | null>,
  activeOperation: CommitCurrentValue<CommitDialogOperation | null>,
  activeTimer: CommitCurrentValue<CommitDialogTimerOwner | null>,
  closedVisits: WeakSet<CommitDialogVisit>,
  requestSuccessor: () => void,
  updateMessage: (
    publication: CommitDialogPublication,
    authority: CommitDialogAuthority,
    message: string,
  ) => void,
  startOperation: (
    publication: CommitDialogPublication,
    authority: CommitDialogAuthority,
  ) => void,
  closeVisit: (
    publication: CommitDialogPublication,
    authority: CommitDialogAuthority,
  ) => void,
  prepareDismissalCapture: (ownerDocument: Document) => void,
): CommitDialogRender {
  let currentRuntime: CommitPublicationRuntime | null = null;
  let lastRuntime: CommitPublicationRuntime | null = null;
  let successorRequested = false;
  let establishmentQueued = false;
  let navigationPair: CommitActionNavigationPair | null = null;
  let enterRoute: ReturnType<typeof createCommitEnterRoute> = null;
  const pendingReactDeliveries = new WeakMap<
    Event,
    Map<object, () => void>
  >();
  const reactCaptureProofs = new WeakMap<
    Event,
    {
      readonly publication: CommitDialogPublication;
      readonly reactName: "onChange" | "onClick" | "onKeyDown" | "onSubmit";
      readonly type: string;
      readonly captureEvent: object;
      readonly captureDefaultPrevented: boolean;
      readonly targetEvent: CommitCurrentValue<object | null>;
      readonly prototype: object;
    }
  >();
  const bridgeReactDeliveries = new WeakMap<
    Event,
    {
      readonly publication: CommitDialogPublication;
      readonly event: object;
      readonly run: () => void;
      readonly reactName: "onChange" | "onClick" | "onKeyDown" | "onSubmit";
      readonly type: string;
      readonly prototype: object;
    }
  >();
  const rejectedReactDeliveries = new WeakSet<Event>();
  const captureReactEvent = (
    event: object,
    reactName: "onChange" | "onClick" | "onKeyDown" | "onSubmit",
    type: string,
  ) => {
    const publication = coordinator.active();
    const bridge = bridgeOwner.element();
    const candidate = event as {
      currentTarget?: unknown;
      nativeEvent?: unknown;
      type?: unknown;
    };
    const nativeEvent = candidate.nativeEvent;
    const ownerWindow = publication?.ownerDocument.defaultView;
    const prototype = Object.getPrototypeOf(event);
    if (
      !publication ||
      publication.authority !== authority ||
      !bridge ||
      bridge !== publication.bridge ||
      candidate.currentTarget !== bridge ||
      candidate.type !== type ||
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.Event) ||
      nativeEvent.eventPhase === ownerWindow.Event.NONE ||
      !coordinator.nativeEventWasDelivered(nativeEvent) ||
      !prototype ||
      pendingReactDeliveries.has(nativeEvent) ||
      reactCaptureProofs.has(nativeEvent) ||
      bridgeReactDeliveries.has(nativeEvent) ||
      rejectedReactDeliveries.has(nativeEvent) ||
      !commitSyntheticEventShape(event, reactName, nativeEvent.defaultPrevented)
    ) {
      return;
    }
    reactCaptureProofs.set(nativeEvent, {
      publication,
      reactName,
      type,
      captureEvent: event,
      captureDefaultPrevented: nativeEvent.defaultPrevented,
      targetEvent: new CommitCurrentValue<object | null>(null),
      prototype,
    });
  };
  const stageReactDelivery = (
    event: object,
    nativeEvent: Event,
    run: () => void,
  ) => {
    const proof = reactCaptureProofs.get(nativeEvent);
    if (
      !proof ||
      proof.publication !== coordinator.active() ||
      bridgeReactDeliveries.has(nativeEvent) ||
      rejectedReactDeliveries.has(nativeEvent) ||
      Object.getPrototypeOf(event) !== proof.prototype
    ) {
      return;
    }
    const stagedEvent = proof.targetEvent.get();
    if (stagedEvent && stagedEvent !== event) return;
    if (!stagedEvent) proof.targetEvent.set(event);
    const pending =
      pendingReactDeliveries.get(nativeEvent) ?? new Map<object, () => void>();
    if (!pendingReactDeliveries.has(nativeEvent)) {
      pendingReactDeliveries.set(nativeEvent, pending);
    }
    if (!pending.has(event)) pending.set(event, run);
  };
  const deliverReactEvent = (
    event: object,
    reactName: "onChange" | "onClick" | "onKeyDown" | "onSubmit",
    type: string,
  ) => {
    const possibleNativeEvent = (event as { nativeEvent?: unknown }).nativeEvent;
    if (
      possibleNativeEvent !== null &&
      typeof possibleNativeEvent === "object" &&
      (bridgeReactDeliveries.has(possibleNativeEvent as Event) ||
        rejectedReactDeliveries.has(possibleNativeEvent as Event))
    ) {
      return;
    }
    const publication = coordinator.active();
    const bridge = bridgeOwner.element();
    const candidate = event as {
      currentTarget?: unknown;
      nativeEvent?: unknown;
      type?: unknown;
    };
    const nativeEvent = candidate.nativeEvent;
    const ownerWindow = publication?.ownerDocument.defaultView;
    const proof =
      ownerWindow && nativeEvent instanceof ownerWindow.Event
        ? reactCaptureProofs.get(nativeEvent)
        : undefined;
    const captureEvent = proof?.captureEvent as
      | {
          currentTarget?: unknown;
          nativeEvent?: unknown;
          type?: unknown;
        }
      | undefined;
    // React plugin events may reuse the capture wrapper; native events may create a bubble wrapper.
    const captureIsTargetEvent = proof?.captureEvent === event;
    if (
      !publication ||
      publication.authority !== authority ||
      !bridge ||
      bridge !== publication.bridge ||
      candidate.currentTarget !== bridge ||
      candidate.type !== type ||
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.Event) ||
      nativeEvent.eventPhase === ownerWindow.Event.NONE ||
      !coordinator.nativeEventWasDelivered(nativeEvent) ||
      !proof ||
      proof.publication !== publication ||
      proof.reactName !== reactName ||
      proof.type !== type ||
      captureEvent?.currentTarget !== (captureIsTargetEvent ? bridge : null) ||
      captureEvent.nativeEvent !== nativeEvent ||
      captureEvent.type !== type ||
      Object.getPrototypeOf(proof.captureEvent) !== proof.prototype ||
      !commitSyntheticEventShape(
        proof.captureEvent,
        reactName,
        captureIsTargetEvent
          ? nativeEvent.defaultPrevented
          : proof.captureDefaultPrevented,
      ) ||
      Object.getPrototypeOf(event) !== proof.prototype ||
      !commitSyntheticEventShape(event, reactName, nativeEvent.defaultPrevented)
    ) {
      return;
    }
    if (proof.targetEvent.get() !== event) {
      rejectedReactDeliveries.add(nativeEvent);
      pendingReactDeliveries.delete(nativeEvent);
      reactCaptureProofs.delete(nativeEvent);
      return;
    }
    const pending = pendingReactDeliveries.get(nativeEvent);
    const run = pending?.get(event);
    if (!run) {
      rejectedReactDeliveries.add(nativeEvent);
      pendingReactDeliveries.delete(nativeEvent);
      reactCaptureProofs.delete(nativeEvent);
      return;
    }
    bridgeReactDeliveries.set(nativeEvent, {
      publication,
      event,
      run,
      reactName,
      type,
      prototype: proof.prototype,
    });
    pendingReactDeliveries.delete(nativeEvent);
    reactCaptureProofs.delete(nativeEvent);
  };
  const authorizeNativeDelivery = (
    publication: CommitDialogPublication,
    nativeEvent: Event,
  ) => {
    if (coordinator.enterIsDelivering() || enterRoute?.finish(nativeEvent)) return;
    if (coordinator.enterOwnsSubmit(nativeEvent)) return;
    const candidate = bridgeReactDeliveries.get(nativeEvent);
    bridgeReactDeliveries.delete(nativeEvent);
    pendingReactDeliveries.delete(nativeEvent);
    reactCaptureProofs.delete(nativeEvent);
    if (!candidate) return;
    const ownerDocument = publication.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const reactEvent = candidate.event as {
      currentTarget?: unknown;
      nativeEvent?: unknown;
      type?: unknown;
    };
    if (
      !ownerWindow ||
      nativeEvent.currentTarget !== ownerDocument ||
      nativeEvent.eventPhase !== ownerWindow.Event.BUBBLING_PHASE ||
      candidate.publication !== publication ||
      publication.authority !== authority ||
      reactEvent.currentTarget !== null ||
      reactEvent.nativeEvent !== nativeEvent ||
      reactEvent.type !== candidate.type ||
      Object.getPrototypeOf(candidate.event) !== candidate.prototype ||
      !commitSyntheticEventShape(
        candidate.event,
        candidate.reactName,
        nativeEvent.defaultPrevented,
      )
    ) {
      return;
    }
    coordinator.noteReactEvent(candidate.event);
    candidate.run();
  };
  const onElementChange = (
    owner: CommitElementOwnerView,
    element: Element | null,
    previous: Element | null,
    last: Element | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null || (element !== null && last !== null && element !== last)) {
      currentRuntime?.retireForElement();
      currentRuntime = null;
    }
    if (owner === bridgeOwner && element) prepareDismissalCapture(element.ownerDocument);
    const form = formOwner.element();
    if (owner === formOwner && element && form === element) {
      coordinator.registerForm(form);
    }
    if (runtime?.isExactReplay() && coordinator.acceptsSuccessorOf(runtime.publication)) {
      requestReplaySuccessor(runtime);
    }
    if (
      !lastRuntime &&
      !establishmentQueued &&
      expectedOwners().every((expected) => expected.element() !== null)
    ) {
      establishmentQueued = true;
      queueMicrotask(() => {
        establishmentQueued = false;
        if (
          !lastRuntime &&
          expectedOwners().every((expected) => expected.element() !== null)
        ) {
          establish();
        }
      });
    }
  };
  const bridgeOwner = new CommitElementOwner<HTMLDivElement>(onElementChange);
  const gistSlotOwner = new CommitElementOwner<HTMLDivElement>(onElementChange);
  const formOwner = new CommitElementOwner<HTMLFormElement>(onElementChange);
  const labelOwner = new CommitElementOwner<HTMLLabelElement>(onElementChange);
  const messageOwner = new CommitElementOwner<HTMLInputElement>(onElementChange);
  const staticOwner = new CommitElementOwner<HTMLParagraphElement>(onElementChange);
  const errorOwner = new CommitElementOwner<HTMLDivElement>(onElementChange);
  const cancelOwner = new CommitElementOwner<HTMLButtonElement>(onElementChange);
  const submitOwner = new CommitElementOwner<HTMLButtonElement>(onElementChange);
  const expectedOwners = () =>
    Object.freeze([
      bridgeOwner,
      gistSlotOwner,
      formOwner,
      labelOwner,
      messageOwner,
      staticOwner,
      errorOwner,
      cancelOwner,
      submitOwner,
    ]);
  const exactDom = (changing: CommitChangingControl = null) => {
    const bridge = bridgeOwner.element();
    const gistSlot = gistSlotOwner.element();
    const form = formOwner.element();
    const label = labelOwner.element();
    const message = messageOwner.element();
    const staticText = staticOwner.element();
    const error = errorOwner.element();
    const cancel = cancelOwner.element();
    const submit = submitOwner.element();
    const content = form?.parentElement;
    const ownerWindow = content?.ownerDocument.defaultView;
    const header = content?.firstElementChild;
    const titleWrap = header?.firstElementChild;
    const title = titleWrap?.firstElementChild;
    const description = titleWrap?.lastElementChild;
    const close = header?.lastElementChild;
    const overlay = content ? commitPreviousSibling(content) : null;
    const actions = cancel?.parentElement;
    const expectedFormChildren = 6;
    const expectedActionsIndex = 5;
    const icon = submit?.firstElementChild;
    const valid =
      bridge &&
      gistSlot &&
      form &&
      label &&
      message &&
      staticText &&
      cancel &&
      submit &&
      content &&
      ownerWindow &&
      header &&
      titleWrap &&
      title &&
      description &&
      close instanceof ownerWindow.HTMLButtonElement &&
      overlay instanceof ownerWindow.HTMLDivElement &&
      bridge instanceof ownerWindow.HTMLDivElement &&
      gistSlot instanceof ownerWindow.HTMLDivElement &&
      form instanceof ownerWindow.HTMLFormElement &&
      label instanceof ownerWindow.HTMLLabelElement &&
      message instanceof ownerWindow.HTMLInputElement &&
      staticText instanceof ownerWindow.HTMLParagraphElement &&
      cancel instanceof ownerWindow.HTMLButtonElement &&
      submit instanceof ownerWindow.HTMLButtonElement &&
      actions instanceof ownerWindow.HTMLDivElement &&
      bridge.isConnected &&
      bridge.ownerDocument === content.ownerDocument &&
      bridge.getAttribute("class") === "contents" &&
      bridge.childNodes.length === 0 &&
      content instanceof ownerWindow.HTMLDivElement &&
      content.isConnected &&
      content.getAttribute("role") === "dialog" &&
      content.children.length === 2 &&
      content.children.item(0) === header &&
      content.children.item(1) === form &&
      header.parentElement === content &&
      header.children.length === 2 &&
      titleWrap.parentElement === header &&
      titleWrap.children.length === 2 &&
      title.tagName === "H2" &&
      title.textContent === authority.visit.title &&
      description.tagName === "P" &&
      description.textContent === authority.visit.description &&
      content.getAttribute("aria-labelledby") !== "" &&
      (content.getAttribute("aria-labelledby") === null ||
        content.getAttribute("aria-labelledby") === title.id) &&
      content.getAttribute("aria-describedby") !== "" &&
      (content.getAttribute("aria-describedby") === null ||
        content.getAttribute("aria-describedby") === description.id) &&
      close.parentElement === header &&
      close.type === "button" &&
      !close.disabled &&
      close.getAttribute("aria-label") === "Close" &&
      close.children.length === 1 &&
      close.firstElementChild?.tagName.toLowerCase() === "svg" &&
      overlay.isConnected &&
      overlay.ownerDocument === content.ownerDocument &&
      overlay.parentNode === content.parentNode &&
      commitNextSibling(overlay) === content &&
      overlay.getAttribute("class") === "dialog-overlay animate-fade-in" &&
      form.parentElement === content &&
      form.getAttribute("class") === COMMIT_FORM_CLASS &&
      form.getAttribute("action") === null &&
      form.getAttribute("method") === null &&
      form.getAttribute("enctype") === null &&
      form.getAttribute("target") === null &&
      form.getAttribute("novalidate") === null &&
      form.method === "get" &&
      form.enctype === "application/x-www-form-urlencoded" &&
      form.target === "" &&
      !form.noValidate &&
      form.children.length === expectedFormChildren &&
      form.childNodes.length === expectedFormChildren &&
      form.children.item(0) === gistSlot &&
      form.children.item(1) === label &&
      form.children.item(2) === message &&
      form.children.item(3) === staticText &&
      form.children.item(expectedActionsIndex) === actions &&
      gistSlot.parentElement === form &&
      gistSlot.getAttribute("class") === "contents" &&
      gistSlot.childElementCount === (authority.visit.gistControlPresent ? 1 : 0) &&
      label.parentElement === form &&
      label.getAttribute("class") === COMMIT_LABEL_CLASS &&
      label.textContent === authority.visit.label &&
      message.parentElement === form &&
      message.tagName === "INPUT" &&
      message.type === "text" &&
      message.form === form &&
      !message.disabled &&
      message.getAttribute("class") === "input" &&
      message.dataset.testid === "commit-message" &&
      message.getAttribute("name") === null &&
      (changing === "message" || message.value === authority.message) &&
      staticText.parentElement === form &&
      staticText.getAttribute("class") === COMMIT_STATIC_CLASS &&
      staticText.textContent === "Pending suggestions are not included until they are accepted." &&
      actions.parentElement === form &&
      actions.getAttribute("class") === COMMIT_ACTIONS_CLASS &&
      actions.children.length === 2 &&
      actions.childNodes.length === 2 &&
      actions.children.item(0) === cancel &&
      actions.children.item(1) === submit &&
      cancel.type === "button" &&
      cancel.form === form &&
      !cancel.disabled &&
      cancel.getAttribute("class") === COMMIT_CANCEL_CLASS &&
      cancel.textContent === "Cancel" &&
      cancel.getAttribute("aria-disabled") === null &&
      submit.type === "submit" &&
      submit.form === form &&
      submit.disabled === authority.submitDisabled &&
      submit.matches(":disabled") === authority.submitDisabled &&
      submit.getAttribute("class") === COMMIT_SUBMIT_CLASS &&
      submit.dataset.testid === "commit-submit" &&
      submit.textContent?.trim() === authority.submitText &&
      submit.getAttribute("aria-disabled") === null &&
      (authority.submitIcon === null
        ? submit.children.length === 0
        : submit.children.length === 1 &&
          icon?.tagName.toLowerCase() === "svg" &&
          icon.getAttribute("width") === "16" &&
          icon.getAttribute("height") === "16" &&
          icon.getAttribute("aria-hidden") === "true" &&
          icon.classList.contains("animate-spin") === (authority.submitIcon === "busy"));
    if (!valid) return null;
    if (
      !(error instanceof ownerWindow.HTMLDivElement) ||
      error.parentElement !== form ||
      form.children.item(4) !== error ||
      error.getAttribute("class") !== COMMIT_ERROR_CLASS ||
      error.hidden !== (authority.error === null) ||
      error.textContent !== (authority.error ?? "") ||
      error.getAttribute("role") !== null ||
      error.getAttribute("aria-live") !== null
    ) {
      return null;
    }
    return { bridge, gistSlot, form, label, message, staticText, error, cancel, submit, content, overlay, close };
  };
  const invalidate = (
    runtime: CommitPublicationRuntime,
    requireFreshSuccessor = false,
  ) => {
    runtime.retireOrdinary();
    coordinator.abandonReplay(runtime.publication);
    if (
      (!requireFreshSuccessor && successorRequested) ||
      closedVisits.has(authority.visit)
    ) {
      return;
    }
    successorRequested = true;
    requestSuccessor();
  };
  const owns = (
    publication: CommitDialogPublication,
    changing: CommitChangingControl = null,
  ) => {
    const dom = exactDom(changing);
    const exact = Boolean(
      dom &&
        commitAuthorityFactsMatch(
          authority,
          latestAuthority,
          currentVisit,
          activeOperation,
          activeTimer,
          closedVisits,
        ) &&
        publication.presentation === render &&
        publication.authority === authority &&
        publication.bridge === dom.bridge &&
        publication.overlay === dom.overlay &&
        publication.content === dom.content &&
        publication.gistSlot === dom.gistSlot &&
        coordinator.isCurrent(publication) &&
        !publication.isRetired() &&
        publication.publishedDomMatches(),
    );
    if (!exact && currentRuntime?.publication === publication && coordinator.isCurrent(publication)) {
      invalidate(currentRuntime);
    }
    return exact;
  };
  const actionNavigationIsCurrent = (
    publication: CommitDialogPublication,
    keyboard: CommitActionKeyboardAuthority,
    source: CommitPublishedAction,
    destination: CommitPublishedAction,
    key: CommitActionNavigationKey,
  ) => {
    const dom = exactDom();
    if (
      !dom ||
      publication.presentation !== render ||
      publication.authority !== authority ||
      publication.keyboard !== keyboard ||
      keyboard.ownerDocument !== publication.ownerDocument ||
      keyboard.ownerWindow !== publication.ownerDocument.defaultView ||
      !keyboard.isCurrent() ||
      !commitAuthorityFactsMatch(
        authority,
        latestAuthority,
        currentVisit,
        activeOperation,
        activeTimer,
        closedVisits,
      ) ||
      !coordinator.isCurrent(publication) ||
      publication.isRetired() ||
      !publication.publishedDomMatches() ||
      !commitPublishedActionsAreCurrent(
        publication,
        dom.cancel,
        dom.submit,
      ) ||
      !publication.actions.includes(source) ||
      !publication.actions.includes(destination) ||
      source === destination ||
      source.action !== authority.actionOrder[source.order] ||
      destination.action !== authority.actionOrder[destination.order] ||
      source.element.disabled ||
      destination.element.disabled ||
      commitActionNavigationDestination(
        publication.actions,
        source,
        key,
      ) !== destination
    ) {
      return false;
    }
    try {
      return (
        commitActionKeyboardValue<Element | null>(
          keyboard,
          keyboard.activeElement,
          keyboard.ownerDocument,
        ) === source.element
      );
    } catch {
      return false;
    }
  };
  const captureActionNavigation = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    let nativeEvent: unknown;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return false;
    }
    if (
      !nativeEvent ||
      typeof nativeEvent !== "object" ||
      !coordinator.prepareNavigationCapture(event, nativeEvent)
    ) {
      return false;
    }
    const publication = coordinator.active();
    const keyboard = publication?.keyboard;
    const bridge = bridgeOwner.element();
    if (
      !publication ||
      !keyboard ||
      !bridge ||
      navigationPair ||
      publication.presentation !== render ||
      publication.authority !== authority ||
      publication.bridge !== bridge
    ) {
      return false;
    }
    const native = captureCommitActionKeyboardEvent(
      keyboard,
      nativeEvent as Event,
      keyboard.Event.CAPTURING_PHASE,
    );
    const capture = native
      ? captureCommitActionReactEvent(event, keyboard, native, bridge)
      : null;
    const dom = exactDom();
    const source =
      native && dom
        ? publication.actions.find(
            ({ element }) => element === native.target,
          )
        : undefined;
    const destination =
      source && native
        ? commitActionNavigationDestination(
            publication.actions,
            source,
            native.key,
          )
        : null;
    if (
      !native ||
      !capture ||
      !dom ||
      !source ||
      !destination ||
      native.terminal !== keyboard.terminal.proofFor(native.event) ||
      !commitPublishedActionsAreCurrent(
        publication,
        dom.cancel,
        dom.submit,
      ) ||
      !actionNavigationIsCurrent(
        publication,
        keyboard,
        source,
        destination,
        native.key,
      )
    ) {
      return false;
    }
    const pair: CommitActionNavigationPair = Object.freeze({
      publication,
      authority: keyboard,
      native,
      capture,
      terminal: native.terminal,
      source,
      destination,
      key: native.key,
      movement: Object.freeze({
        publication,
        source,
        destination,
        key: native.key,
      }),
      publicationClaim: Object.freeze({ publication }),
      actionClaim: Object.freeze({ action: source.action }),
      sourceClaim: Object.freeze({ source }),
      destinationClaim: Object.freeze({ destination }),
    });
    navigationPair = pair;
    keyboard.ownerWindow.queueMicrotask(() => {
      if (navigationPair === pair) navigationPair = null;
    });
    return true;
  };
  const completeActionNavigation = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const pair = navigationPair;
    let nativeEvent: unknown;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return Boolean(pair);
    }
    if (
      !pair ||
      !nativeEvent ||
      typeof nativeEvent !== "object" ||
      pair.native.event !== nativeEvent ||
      !coordinator.prepareNavigationBubble(event, nativeEvent)
    ) {
      return false;
    }
    navigationPair = null;
    const {
      publication,
      authority: keyboard,
      source,
      destination,
      key,
    } = pair;
    try {
      const bridge = bridgeOwner.element();
      const native = captureCommitActionKeyboardEvent(
        keyboard,
        nativeEvent as Event,
        keyboard.Event.BUBBLING_PHASE,
      );
      const bubble =
        native && bridge
          ? captureCommitActionReactEvent(event, keyboard, native, bridge)
          : null;
      if (
        !bridge ||
        !native ||
        !bubble ||
        bubble.event === pair.capture.event ||
        bubble.nativeEvent !== pair.capture.nativeEvent ||
        bubble.target !== pair.capture.target ||
        bubble.currentTarget !== pair.capture.currentTarget ||
        pair.capture.phase !== keyboard.Event.CAPTURING_PHASE ||
        bubble.phase !== keyboard.Event.BUBBLING_PHASE ||
        !commitActionKeyboardEventsMatch(pair.native, native, keyboard) ||
        native.terminal !== pair.terminal ||
        !commitActionReactSnapshotMatches(pair.capture, keyboard, null) ||
        !actionNavigationIsCurrent(
          publication,
          keyboard,
          source,
          destination,
          key,
        ) ||
        !coordinator.claimNavigation(pair) ||
        !coordinator.claimNavigationBubble(pair, event)
      ) {
        return true;
      }
      if (
        !coordinator.navigationIsDelivering(publication) ||
        !commitActionReactSnapshotMatches(pair.capture, keyboard, null) ||
        !commitActionReactSnapshotMatches(bubble, keyboard, bridge) ||
        !actionNavigationIsCurrent(
          publication,
          keyboard,
          source,
          destination,
          key,
        )
      ) {
        return true;
      }
      keyboard.apply(bubble.methods.preventDefault, bubble.event, []);
      const currentBubbleDefaultQuery = bubble.event.isDefaultPrevented;
      if (
        commitActionKeyboardValue<boolean>(
          keyboard,
          keyboard.event.defaultPrevented,
          native.event,
        ) !== true ||
        bubble.event.defaultPrevented !== true ||
        typeof currentBubbleDefaultQuery !== "function" ||
        keyboard.apply(currentBubbleDefaultQuery, bubble.event, []) !== true ||
        commitActionKeyboardValue<boolean>(
          keyboard,
          keyboard.event.cancelBubble,
          native.event,
        ) !== false ||
        !coordinator.navigationIsDelivering(publication) ||
        !actionNavigationIsCurrent(
          publication,
          keyboard,
          source,
          destination,
          key,
        )
      ) {
        return true;
      }
      keyboard.apply(keyboard.focus, destination.element, [
        { preventScroll: true },
      ]);
      return true;
    } catch {
      return true;
    } finally {
      coordinator.finishNavigation(publication);
    }
  };
  const requestReplaySuccessor = (runtime: CommitPublicationRuntime) => {
    const replay = runtime.replay();
    const dom = exactDom();
    if (
      successorRequested ||
      !replay ||
      !dom ||
      !runtime.isExactReplay() ||
      !coordinator.acceptsSuccessorOf(runtime.publication) ||
      !commitAuthorityFactsMatch(
        authority,
        latestAuthority,
        currentVisit,
        activeOperation,
        activeTimer,
        closedVisits,
      ) ||
      !coordinator.stageReplay(replay)
    ) {
      return;
    }
    successorRequested = true;
    requestSuccessor();
  };
  const establish = () => {
    if (lastRuntime) {
      if (lastRuntime.isExactReplay()) requestReplaySuccessor(lastRuntime);
      return undefined;
    }
    const dom = exactDom();
    if (
      !dom ||
      !commitAuthorityFactsMatch(
        authority,
        latestAuthority,
        currentVisit,
        activeOperation,
        activeTimer,
        closedVisits,
      ) ||
      !commitReplayAllowsPublication(coordinator, authority, dom)
    ) {
      return undefined;
    }
    const runtime = createCommitPublicationRuntime(
      render,
      coordinator,
      expectedOwners(),
      dom,
      (publication) => {
        enterRoute?.release();
        enterRoute = null;
        if (navigationPair?.publication === publication) {
          navigationPair = null;
        }
        coordinator.finishNavigation(publication);
      },
    );
    currentRuntime = runtime;
    lastRuntime = runtime;
    if (!runtime.publish()) {
      runtime.retireOrdinary();
      currentRuntime = null;
      return undefined;
    }
    enterRoute = createCommitEnterRoute(
      runtime.publication,
      coordinator,
      dom,
      () => owns(runtime.publication),
      () => invalidate(runtime),
      () => startOperation(runtime.publication, authority),
    );
    return runtime.retireForLayout;
  };
  const onOpenChange = (open: boolean) => {
    if (open) return;
    const publication = currentRuntime?.publication ?? lastRuntime?.publication;
    if (publication) closeVisit(publication, authority);
  };
  const onBridgeChangeCapture = (event: ReactChangeEvent<HTMLDivElement>) => {
    captureReactEvent(event, "onChange", "change");
  };
  const onBridgeChange = (event: ReactChangeEvent<HTMLDivElement>) => {
    deliverReactEvent(event, "onChange", "change");
  };
  const onBridgeClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    captureReactEvent(event, "onClick", "click");
  };
  const onBridgeClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    deliverReactEvent(event, "onClick", "click");
  };
  const onBridgeKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (coordinator.enterIsDelivering()) return;
    if (enterRoute?.key(event, "bridge-capture") ||
        coordinator.enterSawNative(event.nativeEvent)) return;
    if (!captureActionNavigation(event)) {
      captureReactEvent(event, "onKeyDown", "keydown");
    }
  };
  const onBridgeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (coordinator.enterIsDelivering()) return;
    if (enterRoute?.key(event, "bridge") ||
        coordinator.enterSawNative(event.nativeEvent)) return;
    if (!completeActionNavigation(event)) {
      deliverReactEvent(event, "onKeyDown", "keydown");
    }
  };
  const onBridgeSubmitCapture = (event: ReactFormEvent<HTMLDivElement>) => {
    if (coordinator.enterIsDelivering() || enterRoute?.submit(event, "bridge-capture")) return;
    if (coordinator.enterOwnsSubmit(event.nativeEvent) ||
        coordinator.enterOwnsForm(formOwner.element())) return;
    captureReactEvent(event, "onSubmit", "submit");
  };
  const onBridgeSubmit = (event: ReactFormEvent<HTMLDivElement>) => {
    if (coordinator.enterIsDelivering() || enterRoute?.submit(event, "bridge")) return;
    if (coordinator.enterOwnsSubmit(event.nativeEvent) ||
        coordinator.enterOwnsForm(formOwner.element())) return;
    deliverReactEvent(event, "onSubmit", "submit");
  };
  const onMessageChange = (event: ReactChangeEvent<HTMLInputElement>) => {
    const publication = coordinator.active();
    const dom = exactDom("message");
    if (
      !publication ||
      !dom ||
      publication.authority !== authority ||
      event.currentTarget !== dom.message
    ) {
      return;
    }
    const nativeEvent = exactCommitChange(event, dom.message, dom.form, dom.content);
    const action = Object.freeze({ identity: Symbol("commit-message-change") });
    if (!nativeEvent) return;
    const message = dom.message.value;
    stageReactDelivery(event, nativeEvent, () => {
      if (
        !owns(publication, "message") ||
        !coordinator.claimReactEvent(publication, action, event, nativeEvent)
      ) {
        return;
      }
      updateMessage(publication, authority, message);
    });
  };
  const onMessageKeyDownCapture = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    enterRoute?.key(event, "input-capture");
  };
  const onMessageKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    enterRoute?.key(event, "input");
  };
  const onSubmitClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (coordinator.enterIsDelivering()) return;
    const publication = coordinator.active();
    const dom = exactDom();
    if (!publication || !dom || event.currentTarget !== dom.submit) return;
    const nativeEvent = exactCommitClick(event, dom.submit, dom.submit, dom.content, dom.form);
    const action = Object.freeze({ identity: Symbol("commit-submit-click") });
    if (!nativeEvent) return;
    if (
      nativeEvent.detail > 0 ||
      dom.form.ownerDocument.activeElement === dom.submit ||
      !coordinator.enterOwnsForm(dom.form)
    ) {
      enterRoute?.clear();
      coordinator.clearEnterForm(dom.form);
    }
    stageReactDelivery(event, nativeEvent, () => {
      if (
        owns(publication) &&
        coordinator.claimReactEvent(publication, action, event, nativeEvent)
      ) {
        return;
      }
    });
  };
  const onCancel = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const publication = coordinator.active();
    const dom = exactDom();
    if (!publication || !dom || event.currentTarget !== dom.cancel) return;
    const nativeEvent = exactCommitClick(event, dom.cancel, dom.cancel, dom.content, dom.form);
    const action = Object.freeze({ identity: Symbol("commit-cancel") });
    if (!nativeEvent) return;
    stageReactDelivery(event, nativeEvent, () => {
      if (
        !owns(publication) ||
        !coordinator.claimTerminalReact(
          publication,
          action,
          event,
          nativeEvent,
        )
      ) {
        return;
      }
      closeVisit(publication, authority);
    });
  };
  const onSubmit = (event: ReactFormEvent<HTMLFormElement>) => {
    if (coordinator.enterIsDelivering() || enterRoute?.submit(event, "input")) return;
    if (coordinator.enterOwnsSubmit(event.nativeEvent) ||
        coordinator.enterOwnsForm(formOwner.element())) return;
    const ownedNativeEvent = exactOwnedCommitSubmit(event, coordinator);
    if (!ownedNativeEvent) return;
    if (!coordinator.submitIsPrepared(ownedNativeEvent)) {
      event.preventDefault();
      if (
        !commitSyntheticEventShape(event, "onSubmit", true) ||
        !event.defaultPrevented ||
        !ownedNativeEvent.defaultPrevented
      ) {
        return;
      }
      coordinator.prepareSubmit(ownedNativeEvent);
    }
    const dom = exactDom();
    if (!dom || event.currentTarget !== dom.form) return;
    const nativeEvent = exactRenderedCommitSubmit(event, dom.form, dom.submit, dom.content);
    if (!nativeEvent) return;
    const publication = coordinator.active();
    const action = Object.freeze({ identity: Symbol("commit-submit") });
    if (!publication) return;
    stageReactDelivery(event, nativeEvent, () => {
      if (
        publication.authority !== authority ||
        authority.submitDisabled ||
        !owns(publication) ||
        !coordinator.claimTerminalReact(
          publication,
          action,
          event,
          nativeEvent,
        )
      ) {
        return;
      }
      startOperation(publication, authority);
    });
  };
  const render: CommitDialogRender = Object.freeze({
    authority,
    captureBridge: bridgeOwner.capture,
    captureGistSlot: gistSlotOwner.capture,
    captureForm: formOwner.capture,
    captureLabel: labelOwner.capture,
    captureMessage: messageOwner.capture,
    captureStatic: staticOwner.capture,
    captureError: errorOwner.capture,
    captureCancel: cancelOwner.capture,
    captureSubmit: submitOwner.capture,
    establish,
    owns,
    onBridgeChangeCapture,
    onBridgeChange,
    onBridgeClickCapture,
    onBridgeClick,
    onBridgeKeyDownCapture,
    onBridgeKeyDown,
    onBridgeSubmitCapture,
    onBridgeSubmit,
    onMessageChange,
    onMessageKeyDownCapture,
    onMessageKeyDown,
    onCancel,
    onSubmitClick,
    onSubmit,
    onOpenChange,
    authorizeNativeDelivery,
  });
  return render;
}

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
  const [mount] = useState(() => Symbol("commit-dialog"));
  const [coordinator] = useState(() => new CommitPublicationCoordinator(mount));
  const [presentationCache] = useState(() => new CommitPresentationCache());
  const [latestAuthority] = useState(
    () => new CommitCurrentValue<CommitDialogAuthority | null>(null),
  );
  const [currentVisit] = useState(
    () => new CommitCurrentValue<CommitDialogVisit | null>(null),
  );
  const [activeOperation] = useState(
    () => new CommitCurrentValue<CommitDialogOperation | null>(null),
  );
  const [activeTimer] = useState(
    () => new CommitCurrentValue<CommitDialogTimerOwner | null>(null),
  );
  const [pendingHandoff] = useState(
    () => new CommitCurrentValue<CommitDialogOperationHandoff | null>(null),
  );
  const [closedVisits] = useState(() => new WeakSet<CommitDialogVisit>());
  const [dismissalCapture] = useState(
    () =>
      new CommitCurrentValue<{
        readonly ownerDocument: Document;
        readonly remove: () => void;
      } | null>(null),
  );
  const [publicationRevision, setPublicationRevision] = useState(0);
  const documentFacts = commitDocumentFacts(doc);
  const documentKey = commitDocumentKey(documentFacts);
  const destination = JSON.stringify([
    doc.id,
    doc.storage,
    doc.repoOwner,
    doc.repoName,
    doc.repoBranch,
    doc.repoPath,
    doc.gistId,
    doc.gistFile,
    doc.githubUrl,
    doc.ownerId,
    doc.storage === "gist" ? Boolean(doc.publishedAt) : null,
  ]);
  const visit = useMemo(
    () =>
      open
        ? Object.freeze<CommitDialogVisit>({
            identity: Symbol("commit-dialog-visit"),
            mount,
            destination,
            doc,
            documentFacts: commitDocumentFacts(doc),
            open: true,
            onCommit,
            onOpenChange,
            isOwner,
            initialMessage: `Update ${doc.repoPath ?? doc.gistFile ?? "document"}`,
            title: doc.storage === "gist" ? "Update gist" : "Commit to GitHub",
            description:
              doc.storage === "gist"
                ? "Publishes the current text to the gist."
                : `Creates a commit on ${doc.repoBranch} in ${doc.repoOwner}/${doc.repoName}.`,
            label: doc.storage === "gist" ? "Description" : "Commit message",
            gistControlPresent: Boolean(
              isOwner &&
                doc.storage === "gist" &&
                doc.gistId &&
                doc.gistFile &&
                doc.githubUrl &&
                doc.publishedAt,
            ),
          })
        : null,
    // `documentKey` detects in-place DTO mutation; `doc` separates equal-looking replacements.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [destination, doc, documentKey, isOwner, mount, onCommit, onOpenChange, open],
  );
  const [storedState, setStoredState] = useState<CommitDialogState | null>(() =>
    visit ? initialCommitDialogState(visit) : null,
  );
  let state = storedState;
  let handoff: CommitDialogOperationHandoff | null = null;
  if (visit ? state?.visit !== visit : state !== null) {
    const operation = activeOperation.get();
    const timer = activeTimer.get();
    const pendingOperation =
      state !== null &&
      state.busy &&
      !state.done &&
      state.error === null &&
      state.closeTimer === null &&
      timer === null;
    const settledOperation =
      state !== null &&
      timer !== null &&
      !state.busy &&
      state.done &&
      state.error === null &&
      state.closeTimer !== null &&
      state.closeTimer === timer &&
      timer.operation === operation &&
      timer.visit === state.visit &&
      timer.currentVisit.get() === state.visit &&
      timer.onOpenChange === state.visit.onOpenChange &&
      timer.handle !== undefined;
    const idleMetadataRefresh =
      visit !== null &&
      state !== null &&
      operation === null &&
      timer === null &&
      state.operation === null &&
      state.closeTimer === null &&
      !state.busy &&
      !state.done &&
      commitVisitsAllowMetadataHandoff(state.visit, visit);
    if (
      visit &&
      state &&
      state.operation &&
      state.operation === operation &&
      (pendingOperation || settledOperation) &&
      commitOperationAllowsVisitHandoff(operation, state.visit, visit)
    ) {
      handoff = Object.freeze({
        previous: state.visit,
        current: visit,
        operation,
        timer,
      });
      state = Object.freeze({ ...state, visit });
    } else if (idleMetadataRefresh && state && visit) {
      state = Object.freeze({ ...state, visit });
    } else {
      state = visit ? initialCommitDialogState(visit) : null;
    }
    setStoredState(state);
  }
  if (!handoff) {
    const staged = pendingHandoff.get();
    if (
      staged?.current === visit &&
      state?.visit === visit &&
      state.operation === staged.operation &&
      state.closeTimer === staged.timer
    ) {
      handoff = staged;
    }
  }
  pendingHandoff.set(handoff);
  // Insertion effects commit before layout cleanup, so abandoned renders never steal ownership.
  useInsertionEffect(() => {
    if (!handoff) return;
    if (
      activeOperation.get() !== handoff.operation ||
      handoff.operation.currentVisit.get() !== handoff.previous ||
      (handoff.timer
        ? activeTimer.get() !== handoff.timer ||
          handoff.timer.currentVisit.get() !== handoff.previous
        : activeTimer.get() !== null)
    ) {
      if (pendingHandoff.get() === handoff) pendingHandoff.set(null);
      return;
    }
    handoff.operation.currentVisit.set(handoff.current);
    handoff.timer?.currentVisit.set(handoff.current);
    if (pendingHandoff.get() === handoff) pendingHandoff.set(null);
  }, [activeOperation, activeTimer, handoff, pendingHandoff]);

  const clearVisitResources = useCallback(
    (candidate: CommitDialogVisit) => {
      const timer = activeTimer.get();
      if (timer?.currentVisit.get() === candidate) {
        activeTimer.set(null);
        if (timer.handle !== undefined) clearTimeout(timer.handle);
        timer.handle = undefined;
      }
      const operation = activeOperation.get();
      if (operation?.currentVisit.get() === candidate) activeOperation.set(null);
    },
    [activeOperation, activeTimer],
  );
  useLayoutEffect(() => {
    currentVisit.set(visit);
    return () => {
      if (currentVisit.get() === visit) currentVisit.set(null);
      if (visit) clearVisitResources(visit);
    };
  }, [clearVisitResources, currentVisit, visit]);

  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const updateMessage = useCallback(
    (
      publication: CommitDialogPublication,
      authority: CommitDialogAuthority,
      message: string,
    ) => {
      if (
        coordinator.active() !== publication ||
        latestAuthority.get() !== authority ||
        currentVisit.get() !== authority.visit
      ) {
        return;
      }
      setStoredState((current) =>
        current?.visit === authority.visit
          ? commitState(current, { message })
          : current,
      );
    },
    [coordinator, currentVisit, latestAuthority],
  );
  const operationOwns = useCallback(
    (operation: CommitDialogOperation) => {
      const publication = coordinator.active();
      const state = publication?.authority.state;
      return Boolean(
        publication &&
          activeOperation.get() === operation &&
          currentVisit.get() === operation.currentVisit.get() &&
          !closedVisits.has(operation.currentVisit.get()) &&
          state?.visit === operation.currentVisit.get() &&
          (state.operation === operation || publication === operation.origin) &&
          publication.authority.visit === operation.currentVisit.get() &&
          coordinator.isCurrent(publication) &&
          !publication.isRetired() &&
          publication.publishedDomMatches() &&
          commitVisitFactsMatch(operation.visit) &&
          commitVisitFactsMatch(operation.currentVisit.get()),
      );
    },
    [activeOperation, closedVisits, coordinator, currentVisit],
  );
  const closeVisit = useCallback(
    (
      publication: CommitDialogPublication,
      authority: CommitDialogAuthority,
    ) => {
      if (
        coordinator.active() !== publication ||
        currentVisit.get() !== authority.visit ||
        latestAuthority.get() !== authority ||
        closedVisits.has(authority.visit)
      ) {
        return;
      }
      closedVisits.add(authority.visit);
      clearVisitResources(authority.visit);
      publication.retire();
      authority.visit.onOpenChange(false);
    },
    [
      clearVisitResources,
      closedVisits,
      coordinator,
      currentVisit,
      latestAuthority,
    ],
  );
  const startOperation = useCallback(
    (
      publication: CommitDialogPublication,
      authority: CommitDialogAuthority,
    ) => {
      if (activeOperation.get()) return;
      const operation = Object.freeze<CommitDialogOperation>({
        identity: Symbol("commit-dialog-operation"),
        visit: authority.visit,
        currentVisit: new CommitCurrentValue(authority.visit),
        origin: publication,
        message: authority.trimmedMessage,
        commit: authority.visit.onCommit,
      });
      if (!coordinator.claimOperation(operation)) return;
      activeOperation.set(operation);
      setStoredState((current) =>
        current?.visit === operation.currentVisit.get()
          ? commitState(current, {
              busy: true,
              error: null,
              done: false,
              operation,
              closeTimer: null,
            })
          : current,
      );
      let pending: Promise<void>;
      try {
        pending = operation.commit(operation.message);
      } catch (error) {
        pending = Promise.reject(error);
      }
      void Promise.resolve(pending).then(
        () => {
          if (!operationOwns(operation) || activeTimer.get()) return;
          const operationVisit = operation.currentVisit.get();
          const timer: CommitDialogTimerOwner = {
            identity: Symbol("commit-dialog-close-timer"),
            visit: operationVisit,
            currentVisit: new CommitCurrentValue(operationVisit),
            operation,
            onOpenChange: operationVisit.onOpenChange,
            handle: undefined,
          };
          if (!coordinator.claimTimer(timer)) return;
          activeTimer.set(timer);
          const timerAction = Object.freeze({
            identity: Symbol("commit-dialog-timer-close"),
          });
          timer.handle = setTimeout(() => {
            const currentPublication = coordinator.active();
            const currentState = currentPublication?.authority.state;
            if (
              !currentPublication ||
              activeTimer.get() !== timer ||
              activeOperation.get() !== operation ||
              currentVisit.get() !== timer.currentVisit.get() ||
              closedVisits.has(timer.currentVisit.get()) ||
              currentState?.visit !== timer.currentVisit.get() ||
              currentState.operation !== operation ||
              currentState.closeTimer !== timer ||
              !currentState.done ||
              currentState.busy ||
              currentPublication.authority.state !== currentState ||
              !currentPublication.presentation.owns(currentPublication) ||
              !coordinator.claimTimerClose(
                currentPublication,
                timerAction,
                operation,
                timer,
              )
            ) {
              return;
            }
            activeTimer.set(null);
            activeOperation.set(null);
            closedVisits.add(timer.currentVisit.get());
            currentPublication.retire();
            timer.onOpenChange(false);
          }, 900);
          setStoredState((current) =>
            current?.visit === operation.currentVisit.get() &&
            current.operation === operation
              ? commitState(current, {
                  busy: false,
                  error: null,
                  done: true,
                  closeTimer: timer,
                })
              : current,
          );
        },
        (error: unknown) => {
          if (!operationOwns(operation)) return;
          const operationVisit = operation.currentVisit.get();
          activeOperation.set(null);
          setStoredState((current) =>
            current?.visit === operationVisit &&
            (current.operation === operation || current === authority.state)
              ? commitState(current, {
                  busy: false,
                  error: apiErrorText(error, "Publish failed"),
                  done: false,
                  operation: null,
                  closeTimer: null,
                })
              : current,
          );
        },
      );
    },
    [
      activeOperation,
      activeTimer,
      closedVisits,
      coordinator,
      currentVisit,
      operationOwns,
    ],
  );
  const prepareDismissalCapture = useCallback(
    (ownerDocument: Document) => {
      const previous = dismissalCapture.get();
      if (previous?.ownerDocument === ownerDocument) {
        dismissalCapture.set({ ...previous });
        return;
      }
      previous?.remove();
      const remember = (event: Event) => {
        coordinator.noteNativeEvent(event);
      };
      const finish = (event: Event) => {
        const publication = coordinator.active();
        if (publication) {
          publication.presentation.authorizeNativeDelivery(publication, event);
        }
      };
      ownerDocument.addEventListener("keydown", remember, true);
      ownerDocument.addEventListener("input", remember, true);
      ownerDocument.addEventListener("change", remember, true);
      ownerDocument.addEventListener("click", remember, true);
      ownerDocument.addEventListener("submit", remember, true);
      ownerDocument.addEventListener("pointerdown", remember, true);
      ownerDocument.addEventListener("pointerup", remember, true);
      ownerDocument.addEventListener("pointercancel", remember, true);
      ownerDocument.addEventListener("keydown", finish);
      ownerDocument.addEventListener("input", finish);
      ownerDocument.addEventListener("change", finish);
      ownerDocument.addEventListener("click", finish);
      ownerDocument.addEventListener("submit", finish);
      const capture = {
        ownerDocument,
        remove: () => {
          ownerDocument.removeEventListener("keydown", remember, true);
          ownerDocument.removeEventListener("input", remember, true);
          ownerDocument.removeEventListener("change", remember, true);
          ownerDocument.removeEventListener("click", remember, true);
          ownerDocument.removeEventListener("submit", remember, true);
          ownerDocument.removeEventListener("pointerdown", remember, true);
          ownerDocument.removeEventListener("pointerup", remember, true);
          ownerDocument.removeEventListener("pointercancel", remember, true);
          ownerDocument.removeEventListener("keydown", finish);
          ownerDocument.removeEventListener("input", finish);
          ownerDocument.removeEventListener("change", finish);
          ownerDocument.removeEventListener("click", finish);
          ownerDocument.removeEventListener("submit", finish);
        },
      };
      dismissalCapture.set(capture);
    },
    [coordinator, dismissalCapture],
  );

  const submitDisabled = Boolean(state?.busy || state?.done);
  const actionOrder =
    visit && state?.visit === visit
      ? Object.freeze([
          Object.freeze<CommitDialogAction>({
            identity: Symbol("commit-cancel-action"),
            visit,
            documentFacts: visit.documentFacts,
            message: state.message,
            callback: visit.onOpenChange,
            kind: "cancel",
            order: 0,
            eligible: true,
          }),
          Object.freeze<CommitDialogAction>({
            identity: Symbol("commit-submit-action"),
            visit,
            documentFacts: visit.documentFacts,
            message: state.message,
            callback: visit.onCommit,
            kind: "submit",
            order: 1,
            eligible: !submitDisabled,
          }),
        ] as const)
      : null;
  const authority =
    visit && state?.visit === visit && actionOrder
      ? Object.freeze<CommitDialogAuthority>({
          visit,
          revision: publicationRevision,
          state,
          message: state.message,
          trimmedMessage: state.message.trim(),
          busy: state.busy,
          error: state.error,
          done: state.done,
          operation: state.operation,
          closeTimer: state.closeTimer,
          submitDisabled,
          submitText: state.done
            ? "Published"
            : visit.doc.storage === "gist"
              ? "Update gist"
              : "Commit",
          submitIcon: state.done ? "done" : state.busy ? "busy" : null,
          actionOrder,
        })
      : null;
  const presentation = authority
    ? presentationCache.resolve(authority, () =>
        createCommitDialogRender(
          authority,
          coordinator,
          latestAuthority,
          currentVisit,
          activeOperation,
          activeTimer,
          closedVisits,
          requestPublicationSuccessor,
          updateMessage,
          startOperation,
          closeVisit,
          prepareDismissalCapture,
        ),
      )
    : null;
  useInsertionEffect(() => {
    const committedAuthority = presentation?.authority ?? null;
    latestAuthority.set(committedAuthority);
    return () => {
      if (latestAuthority.get() === committedAuthority) latestAuthority.set(null);
    };
  }, [latestAuthority, presentation]);

  useLayoutEffect(() => presentation?.establish(), [presentation]);

  useLayoutEffect(
    () => () => {
      const capture = dismissalCapture.get();
      const replay = coordinator.replay();
      queueMicrotask(() => {
        if (
          replay &&
          currentVisit.get() === null &&
          coordinator.replay() === replay
        ) {
          coordinator.abandonReplay(replay.source);
          replay.release();
        }
        if (!coordinator.active() && dismissalCapture.get() === capture) {
          capture?.remove();
          dismissalCapture.set(null);
        }
      });
    },
    [coordinator, currentVisit, dismissalCapture],
  );

  const shown = presentation?.authority ?? null;
  const captureBridge = presentation?.captureBridge;
  const captureGistSlot = presentation?.captureGistSlot;
  const captureForm = presentation?.captureForm;
  const captureLabel = presentation?.captureLabel;
  const captureMessage = presentation?.captureMessage;
  const captureStatic = presentation?.captureStatic;
  const captureError = presentation?.captureError;
  const captureCancel = presentation?.captureCancel;
  const captureSubmit = presentation?.captureSubmit;
  const onBridgeChangeCapture = presentation?.onBridgeChangeCapture;
  const onBridgeChange = presentation?.onBridgeChange;
  const onBridgeClickCapture = presentation?.onBridgeClickCapture;
  const onBridgeClick = presentation?.onBridgeClick;
  const onBridgeKeyDownCapture = presentation?.onBridgeKeyDownCapture;
  const onBridgeKeyDown = presentation?.onBridgeKeyDown;
  const onBridgeSubmitCapture = presentation?.onBridgeSubmitCapture;
  const onBridgeSubmit = presentation?.onBridgeSubmit;
  const onMessageChange = presentation?.onMessageChange;
  const onMessageKeyDownCapture = presentation?.onMessageKeyDownCapture;
  const onMessageKeyDown = presentation?.onMessageKeyDown;
  const onCancel = presentation?.onCancel;
  const onSubmitClick = presentation?.onSubmitClick;
  const onSubmit = presentation?.onSubmit;
  const changeOpen = presentation?.onOpenChange;

  return (
    <Dialog open={open} onOpenChange={changeOpen ?? (() => undefined)}>
      <div
        ref={captureBridge}
        className="contents"
        onChangeCapture={onBridgeChangeCapture}
        onChange={onBridgeChange}
        onClickCapture={onBridgeClickCapture}
        onClick={onBridgeClick}
        onKeyDownCapture={onBridgeKeyDownCapture}
        onKeyDown={onBridgeKeyDown}
        onSubmitCapture={onBridgeSubmitCapture}
        onSubmit={onBridgeSubmit}
      >
        {presentation && shown && (
          <DialogContent title={shown.visit.title} description={shown.visit.description}>
            <form
              ref={captureForm}
              className={COMMIT_FORM_CLASS}
              onSubmit={onSubmit}
            >
              <div ref={captureGistSlot} className="contents">
                <GistAutoUpdateControl doc={shown.visit.doc} isOwner={shown.visit.isOwner} />
              </div>
              <label ref={captureLabel} className={COMMIT_LABEL_CLASS}>
                {shown.visit.label}
              </label>
              <input
                ref={captureMessage}
                className="input"
                value={shown.message}
                onChange={onMessageChange}
                onKeyDownCapture={onMessageKeyDownCapture}
                onKeyDown={onMessageKeyDown}
                autoFocus
                data-testid="commit-message"
              />
              <p ref={captureStatic} className={COMMIT_STATIC_CLASS}>
                Pending suggestions are not included until they are accepted.
              </p>
              <div ref={captureError} className={COMMIT_ERROR_CLASS} hidden={shown.error === null}>
                {shown.error ?? ""}
              </div>
              <div className={COMMIT_ACTIONS_CLASS}>
                <button
                  ref={captureCancel}
                  type="button"
                  className={COMMIT_CANCEL_CLASS}
                  onClick={onCancel}
                >
                  Cancel
                </button>
                <button
                  ref={captureSubmit}
                  type="submit"
                  className={COMMIT_SUBMIT_CLASS}
                  disabled={shown.submitDisabled}
                  onClick={onSubmitClick}
                  data-testid="commit-submit"
                >
                  {shown.submitIcon === "done" ? (
                    <Check size={16} />
                  ) : shown.submitIcon === "busy" ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : null}
                  {shown.submitText}
                </button>
              </div>
            </form>
          </DialogContent>
        )}
      </div>
    </Dialog>
  );
});
