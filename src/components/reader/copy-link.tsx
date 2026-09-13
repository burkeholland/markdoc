"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  type FocusEvent,
  type MouseEvent,
} from "react";
import { Check, Link2 } from "lucide-react";
import { useCopy } from "@/lib/hooks";

const MANUAL_COPY_INSTRUCTION = "Press Ctrl+C (Command+C on Mac) to copy";

interface CopySource {
  readonly mount: symbol;
  readonly docId: string;
  readonly origin: string;
  readonly originReady: boolean;
  readonly readerUrl: string;
  readonly fallbackInstructionId: string;
  readonly status: ReturnType<typeof useCopy>["status"];
  readonly label: string;
  readonly copied: boolean;
  readonly copy: () => void;
}

type CopyAuthority = Readonly<CopySource>;

interface PublicationCells {
  readonly active: { current: CopyPublication | null };
  readonly successorOf: { current: CopyPublication | null };
  readonly replay: { current: CopyReplay | null };
  readonly claimedEvents: WeakSet<Event>;
}

interface ElementOwnerView {
  readonly element: () => HTMLElement | null;
}

class ElementOwner<T extends HTMLElement> implements ElementOwnerView {
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

interface CopyPublication {
  readonly authority: CopyAuthority;
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
}

interface CopyPublicationSet {
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly captureButton: (element: HTMLButtonElement | null) => void;
  readonly captureFallback: (element: HTMLInputElement | null) => void;
  readonly establish: () => void | (() => void);
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly onFallbackFocus: (event: FocusEvent<HTMLInputElement>) => void;
}

interface CopyDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly CopyDomSnapshot[];
}

interface CopyPlacement {
  readonly document: Document;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface CopyReplay {
  readonly source: CopyPublication;
  readonly dom: CopyDomSnapshot;
  readonly placement: CopyPlacement;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface RefReplay {
  readonly owner: ElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

interface CopyPublicationRuntime {
  readonly publication: CopyPublication;
  readonly publish: (
    snapshot: CopyDomSnapshot,
    placement: CopyPlacement,
    owners: readonly ElementOwnerView[],
  ) => void;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: ElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly snapshot: () => CopyDomSnapshot | null;
  readonly placement: () => CopyPlacement | null;
  readonly mutationHistoryIsClean: () => boolean;
  readonly release: () => void;
  readonly claimActivation: () => boolean;
  readonly beginProgrammaticSelection: () => boolean;
  readonly canClaimFocus: () => boolean;
  readonly claimFocus: () => boolean;
}

function copyAuthoritiesMatch(
  previous: CopyAuthority,
  current: CopySource,
  includeCopy = true,
) {
  return (
    previous.mount === current.mount &&
    previous.docId === current.docId &&
    previous.origin === current.origin &&
    previous.originReady === current.originReady &&
    previous.readerUrl === current.readerUrl &&
    previous.fallbackInstructionId === current.fallbackInstructionId &&
    previous.status === current.status &&
    previous.label === current.label &&
    previous.copied === current.copied &&
    (!includeCopy || previous.copy === current.copy)
  );
}

function snapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotCopyDom(node: Node): CopyDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotCopyDom)),
  });
}

function copyDomMatches(snapshot: CopyDomSnapshot): boolean {
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
  return node.childNodes.length === snapshot.children.length &&
    snapshot.children.every((child, index) =>
      node.childNodes.item(index) === child.node && copyDomMatches(child));
}

function captureCopyPlacement(root: HTMLDivElement): CopyPlacement | null {
  const parent = root.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: root.ownerDocument,
    parent,
    previousSibling: root.previousSibling,
    nextSibling: root.nextSibling,
  });
}

function copyPlacementMatches(root: HTMLDivElement, placement: CopyPlacement): boolean {
  return (
    root.ownerDocument === placement.document &&
    root.parentNode === placement.parent &&
    root.previousSibling === placement.previousSibling &&
    root.nextSibling === placement.nextSibling
  );
}

interface CopyDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

function createCopyDomGuard(
  root: HTMLDivElement,
  placement: CopyPlacement,
): CopyDomGuard | null {
  const MutationObserverConstructor = placement.document.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some((record) => {
      if (record.target === root || root.contains(record.target)) return true;
      if (record.type !== "childList" || record.target !== placement.parent) {
        return false;
      }
      if (record.previousSibling === root || record.nextSibling === root) return true;
      return [...record.addedNodes, ...record.removedNodes].some((node) =>
        node === root || (
          node.nodeType === 1 &&
          (node as Element).contains(root)
        ));
    });
  };
  const observer = new MutationObserverConstructor(recordChanges);
  observer.observe(root, {
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

function isNodeFromDocument(value: EventTarget | null, document: Document): value is Node {
  const NodeConstructor = document.defaultView?.Node;
  return Boolean(NodeConstructor && value instanceof NodeConstructor);
}

function createCopyPublication(
  source: CopySource,
  authority: CopyAuthority,
  cells: PublicationCells,
  requestSuccessor: () => void,
): CopyPublicationSet {
  let currentRuntime: CopyPublicationRuntime | null = null;
  let lastRuntime: CopyPublicationRuntime | null = null;
  let successorRequested = false;

  const requestReplaySuccessor = (runtime: CopyPublicationRuntime) => {
    const snapshot = runtime.snapshot();
    const placement = runtime.placement();
    if (
      successorRequested ||
      !snapshot ||
      !placement ||
      cells.successorOf.current !== runtime.publication ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !runtime.publishedDomMatches()
    ) {
      return;
    }
    successorRequested = true;
    cells.replay.current = Object.freeze({
      source: runtime.publication,
      dom: snapshot,
      placement,
      historyIsClean: runtime.mutationHistoryIsClean,
      release: runtime.release,
    });
    requestSuccessor();
  };

  const onElementChange = (
    owner: ElementOwnerView,
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
  const rootOwner = new ElementOwner<HTMLDivElement>(onElementChange);
  const buttonOwner = new ElementOwner<HTMLButtonElement>(onElementChange);
  const fallbackOwner = new ElementOwner<HTMLInputElement>(onElementChange);

  const factsAreCurrent = () =>
    copyAuthoritiesMatch(authority, source) &&
    authority.originReady === Boolean(authority.origin) &&
    authority.readerUrl === (
      authority.originReady
        ? `${authority.origin}/p/${authority.docId}`
        : ""
    ) &&
    authority.copied === (authority.status === "copied");

  const exactDomIsCurrent = () => {
    const root = rootOwner.element();
    const button = buttonOwner.element();
    const fallback = fallbackOwner.element();
    const fallbackExpected = authority.status === "fallback";
    const ownerDocument = root?.ownerDocument;
    const interactiveElements = root
      ? [...root.querySelectorAll<HTMLElement>("button, input")]
      : [];
    const icon = button?.children.item(0);
    const visibleText = button?.children.item(1);
    const fallbackPanel = fallback?.parentElement;
    const instruction = fallbackPanel?.children.item(1);
    if (
      !root ||
      !root.isConnected ||
      !root.parentNode ||
      root.tagName !== "DIV" ||
      !ownerDocument?.defaultView ||
      !button ||
      !button.isConnected ||
      button.ownerDocument !== ownerDocument ||
      button.tagName !== "BUTTON" ||
      buttonOwner.element() !== button ||
      button.parentElement !== root ||
      root.children.item(0) !== button ||
      button.type !== "button" ||
      button.disabled === authority.originReady ||
      button.dataset.testid !== "reader-copy-link" ||
      button.getAttribute("aria-label") !== authority.label ||
      button.textContent?.trim() !== (authority.copied ? "Copied" : "Copy link") ||
      button.children.length !== 2 ||
      icon?.localName !== "svg" ||
      visibleText?.tagName !== "SPAN" ||
      visibleText.getAttribute("aria-hidden") !== "true" ||
      visibleText.textContent?.trim() !== (authority.copied ? "Copied" : "Copy link") ||
      root.children.length !== (fallbackExpected ? 2 : 1) ||
      interactiveElements[0] !== button ||
      interactiveElements.length !== (fallbackExpected ? 2 : 1) ||
      (
        authority.originReady &&
        authority.origin !== ownerDocument.defaultView.location.origin
      )
    ) {
      return false;
    }
    if (!fallbackExpected) return fallback === null;
    const descriptionIds = fallback
      ?.getAttribute("aria-describedby")
      ?.trim()
      .split(/\s+/) ?? [];
    const matchingDescriptionIds = ownerDocument
      ? [...ownerDocument.querySelectorAll<HTMLElement>("[id]")]
          .filter((element) => element.id === authority.fallbackInstructionId)
      : [];
    return (
      !!fallback &&
      fallback.isConnected &&
      fallback.ownerDocument === ownerDocument &&
      fallback.tagName === "INPUT" &&
      !!fallbackPanel &&
      fallbackPanel.tagName === "DIV" &&
      fallbackPanel.parentElement === root &&
      root.children.item(1) === fallbackPanel &&
      fallbackPanel.children.length === 2 &&
      fallbackPanel.children.item(0) === fallback &&
      fallbackPanel.children.item(1) === instruction &&
      interactiveElements[1] === fallback &&
      fallback.dataset.testid === "reader-copy-link-fallback" &&
      fallback.getAttribute("aria-label") === "Reader link" &&
      descriptionIds.length === 1 &&
      descriptionIds[0] === authority.fallbackInstructionId &&
      matchingDescriptionIds.length === 1 &&
      matchingDescriptionIds[0] === instruction &&
      fallback.readOnly &&
      fallback.value === authority.readerUrl &&
      fallback.childNodes.length === 0 &&
      instruction?.tagName === "P" &&
      instruction.id === authority.fallbackInstructionId &&
      instruction.getAttribute("data-testid") === "reader-copy-link-instruction" &&
      instruction.getAttribute("role") === "status" &&
      instruction.getAttribute("aria-live") === "polite" &&
      instruction.getAttribute("aria-atomic") === "true" &&
      instruction.textContent === MANUAL_COPY_INSTRUCTION &&
      root.querySelectorAll('[role="status"]').length === 1
    );
  };

  const expectedOwners = (): readonly ElementOwnerView[] => [
    rootOwner,
    buttonOwner,
    ...(authority.status === "fallback" ? [fallbackOwner] : []),
  ];

  const ownsAuthority = (runtime: CopyPublicationRuntime) =>
    currentRuntime === runtime &&
    !runtime.isRetired() &&
    cells.active.current === runtime.publication &&
    runtime.publication.authority === authority &&
    factsAreCurrent() &&
    exactDomIsCurrent() &&
    runtime.publishedDomMatches();

  const ownsButton = (
    runtime: CopyPublicationRuntime,
    button: HTMLButtonElement,
  ) =>
    ownsAuthority(runtime) &&
    buttonOwner.element() === button &&
    button.isConnected &&
    !button.disabled &&
    button.getAttribute("aria-label") === authority.label;

  const ownsFallback = (
    runtime: CopyPublicationRuntime,
    fallback: HTMLInputElement,
  ) =>
    authority.status === "fallback" &&
    ownsAuthority(runtime) &&
    fallbackOwner.element() === fallback &&
    fallback.isConnected &&
    fallback.value === authority.readerUrl;

  const claimNativeEvent = (event: Event) => {
    if (cells.claimedEvents.has(event)) return false;
    cells.claimedEvents.add(event);
    return true;
  };

  const selectFallback = (runtime: CopyPublicationRuntime) => {
    const fallback = fallbackOwner.element();
    if (
      !fallback ||
      !ownsFallback(runtime, fallback) ||
      !runtime.beginProgrammaticSelection()
    ) {
      return;
    }
    fallback.focus({ preventScroll: true });
    if (
      ownsFallback(runtime, fallback) &&
      fallback.ownerDocument.activeElement === fallback &&
      runtime.canClaimFocus() &&
      runtime.claimFocus()
    ) {
      fallback.select();
    }
  };

  const createRuntime = (): CopyPublicationRuntime => {
    type Retirement = "element" | "layout" | "other";
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let domSnapshot: CopyDomSnapshot | null = null;
    let placementSnapshot: CopyPlacement | null = null;
    let domGuard: CopyDomGuard | null = null;
    let replayRefs: RefReplay[] = [];
    let invalidReplay = false;
    let activationClaimed = false;
    let selectionClaimed = false;
    let selectionCompleted = false;

    const retire = (reason: Retirement) => {
      if (retired) return false;
      retired = true;
      retirement = reason;
      if (cells.active.current === publication) {
        cells.active.current = null;
        cells.successorOf.current = publication;
      }
      if (currentRuntime?.publication === publication) currentRuntime = null;
      queueMicrotask(() => {
        if (cells.replay.current?.source !== publication) {
          domGuard?.release();
        }
      });
      return true;
    };
    const publication: CopyPublication = Object.freeze({
      authority,
      retire: () => retire("other"),
      isRetired: () => retired,
    });
    const publishedDomMatches = () => {
      const root = rootOwner.element();
      return Boolean(
        domSnapshot &&
        placementSnapshot &&
        domGuard &&
        domGuard.isClean() &&
        root &&
        root === domSnapshot.node &&
        root.isConnected &&
        copyPlacementMatches(root, placementSnapshot) &&
        copyDomMatches(domSnapshot)
      );
    };
    const refsHaveNoReplay = () =>
      !invalidReplay &&
      replayRefs.every((entry) =>
        !entry.detached &&
        !entry.reattached &&
        entry.owner.element() === entry.element);
    const refsHaveExactReplay = () =>
      !invalidReplay &&
      replayRefs.length > 0 &&
      replayRefs.every((entry) =>
        entry.detached &&
        entry.reattached &&
        entry.owner.element() === entry.element);

    const runtime: CopyPublicationRuntime = Object.freeze({
      publication,
      publish: (
        snapshot: CopyDomSnapshot,
        placement: CopyPlacement,
        owners: readonly ElementOwnerView[],
      ) => {
        established = true;
        domSnapshot = snapshot;
        placementSnapshot = placement;
        const root = rootOwner.element();
        if (!root) {
          throw new Error("Cannot publish ReaderCopyLink without its committed root");
        }
        domGuard = createCopyDomGuard(root, placement);
        if (!domGuard) {
          throw new Error("Cannot publish ReaderCopyLink without a DOM mutation observer");
        }
        replayRefs = owners.map((owner: ElementOwnerView) => {
          const element = owner.element();
          if (!element) {
            throw new Error("Cannot publish ReaderCopyLink without every committed ref");
          }
          return { owner, element, detached: false, reattached: false };
        });
        cells.active.current = publication;
        cells.successorOf.current = null;
        cells.replay.current = null;
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        layoutRetired = true;
        retire("layout");
      },
      noteRef: (
        owner: ElementOwnerView,
        element: HTMLElement | null,
        previous: HTMLElement | null,
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
      },
      isRetired: () => retired,
      publishedDomMatches,
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
      snapshot: () => domSnapshot,
      placement: () => placementSnapshot,
      mutationHistoryIsClean: () => domGuard?.isClean() ?? false,
      release: () => {
        domGuard?.release();
      },
      claimActivation: () => {
        if (activationClaimed) return false;
        activationClaimed = true;
        return true;
      },
      beginProgrammaticSelection: () => {
        if (selectionClaimed || selectionCompleted) return false;
        selectionClaimed = true;
        return true;
      },
      canClaimFocus: () => !selectionCompleted,
      claimFocus: () => {
        if (selectionCompleted) return false;
        selectionClaimed = true;
        selectionCompleted = true;
        return true;
      },
    });
    return runtime;
  };

  const establish = () => {
    if (lastRuntime) {
      if (
        (
          lastRuntime.isExactLayoutReplay() ||
          lastRuntime.isExactElementReplay()
        ) &&
        cells.successorOf.current === lastRuntime.publication
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (!factsAreCurrent() || !exactDomIsCurrent()) return undefined;
    const root = rootOwner.element();
    const placement = root ? captureCopyPlacement(root) : null;
    if (!root || !placement) return undefined;

    const replay = cells.replay.current;
    if (replay) {
      const sameAuthority = copyAuthoritiesMatch(
        replay.source.authority,
        authority,
      );
      const exactReplay = (
        sameAuthority &&
        replay.source.isRetired() &&
        cells.successorOf.current === replay.source &&
        replay.historyIsClean() &&
        root === replay.dom.node &&
        copyPlacementMatches(root, replay.placement) &&
        copyDomMatches(replay.dom)
      );
      cells.replay.current = null;
      replay.release();
      if (cells.successorOf.current === replay.source) {
        cells.successorOf.current = null;
      }
      if (sameAuthority && !exactReplay) return undefined;
    }

    const runtime = createRuntime();
    const publication = runtime.publication;
    const previous = cells.active.current;
    if (previous && previous !== publication) previous.retire();
    currentRuntime = runtime;
    lastRuntime = runtime;
    runtime.publish(snapshotCopyDom(root), placement, expectedOwners());
    if (authority.status === "fallback") selectFallback(runtime);
    return runtime.retireForLayout;
  };

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    const runtime = currentRuntime;
    const button = buttonOwner.element();
    const ownerDocument = button?.ownerDocument;
    const MouseEventConstructor = ownerDocument?.defaultView?.MouseEvent;
    const nativeEvent = event?.nativeEvent;
    const target = event?.target;
    if (
      !runtime ||
      !button ||
      !ownerDocument ||
      !MouseEventConstructor ||
      event.type !== "click" ||
      event.button !== 0 ||
      !(nativeEvent instanceof MouseEventConstructor) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      event.currentTarget !== button ||
      nativeEvent.target !== target ||
      !isNodeFromDocument(target, ownerDocument) ||
      !button.contains(target) ||
      event.defaultPrevented ||
      nativeEvent.defaultPrevented ||
      cells.claimedEvents.has(nativeEvent) ||
      !ownsButton(runtime, button) ||
      !runtime.claimActivation()
    ) {
      return;
    }
    claimNativeEvent(nativeEvent);
    authority.copy();
  };

  const onFallbackFocus = (event: FocusEvent<HTMLInputElement>) => {
    const runtime = currentRuntime;
    const fallback = fallbackOwner.element();
    const ownerDocument = fallback?.ownerDocument;
    const FocusEventConstructor = ownerDocument?.defaultView?.FocusEvent;
    const nativeEvent = event?.nativeEvent;
    if (
      !runtime ||
      !fallback ||
      !ownerDocument ||
      !FocusEventConstructor ||
      event.type !== "focus" ||
      !(nativeEvent instanceof FocusEventConstructor) ||
      (nativeEvent.type !== "focus" && nativeEvent.type !== "focusin") ||
      event.currentTarget !== fallback ||
      event.target !== fallback ||
      nativeEvent.target !== fallback ||
      ownerDocument.activeElement !== fallback ||
      event.defaultPrevented ||
      nativeEvent.defaultPrevented ||
      cells.claimedEvents.has(nativeEvent) ||
      !ownsFallback(runtime, fallback) ||
      !runtime.canClaimFocus()
    ) {
      return;
    }
    claimNativeEvent(nativeEvent);
    if (!runtime.claimFocus()) return;
    fallback.select();
  };

  return Object.freeze({
    captureRoot: rootOwner.capture,
    captureButton: buttonOwner.capture,
    captureFallback: fallbackOwner.capture,
    establish,
    onClick,
    onFallbackFocus,
  });
}

/** Copies this document's canonical public URL without pulling the reader shell into the client graph. */
export function ReaderCopyLink({ docId }: { docId: string }) {
  const [mount] = useState(() => Symbol("reader copy link"));
  const fallbackInstructionId = `${useId()}-manual-copy-instruction`;
  const [origin, setOrigin] = useState("");
  const [cells] = useState<PublicationCells>(() => ({
    active: { current: null },
    successorOf: { current: null },
    replay: { current: null },
    claimedEvents: new WeakSet<Event>(),
  }));
  const [, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);

  // The browser's origin is canonical for this visit and keeps proxy headers out of the server render.
  useEffect(() => setOrigin(window.location.origin), []);
  const readerUrl = origin ? `${origin}/p/${docId}` : "";
  const link = useCopy(readerUrl, undefined, "Copy link");
  const candidate: CopySource = {
    mount,
    docId,
    origin,
    originReady: Boolean(origin),
    readerUrl,
    fallbackInstructionId,
    status: link.status,
    label: link.label,
    copied: link.copied,
    copy: link.copy,
  };
  const replayAuthority = cells.replay.current?.source.authority;
  const source = replayAuthority &&
    copyAuthoritiesMatch(replayAuthority, candidate, false)
    ? { ...candidate, copy: replayAuthority.copy }
    : candidate;
  const authority = Object.freeze({ ...source });
  const publication = createCopyPublication(
    source,
    authority,
    cells,
    requestPublicationSuccessor,
  );

  useLayoutEffect(() => publication.establish(), [publication]);

  const {
    captureRoot,
    captureButton,
    captureFallback,
    onClick,
    onFallbackFocus,
  } = publication;
  const visibleLabel = link.copied ? "Copied" : "Copy link";
  return (
    <div
      ref={captureRoot}
      className="relative flex shrink-0"
    >
      <button
        ref={captureButton}
        type="button"
        className="btn btn-sm btn-outline h-11 w-11 shrink-0 gap-1.5 p-0 sm:h-8 sm:w-auto sm:px-3"
        aria-label={link.label}
        disabled={!origin}
        onClick={onClick}
        data-testid="reader-copy-link"
      >
        {link.copied ? <Check size={14} className="text-success" /> : <Link2 size={14} />}
        <span className="hidden sm:inline" aria-hidden="true">
          {visibleLabel}
        </span>
      </button>
      {link.status === "fallback" && (
        <div className="absolute right-0 top-full z-20 mt-2 w-[min(24rem,calc(100vw-2rem))] rounded-lg bg-surface p-2 shadow-md">
          <input
            ref={captureFallback}
            className="input w-full font-mono text-xs"
            value={readerUrl}
            readOnly
            aria-label="Reader link"
            aria-describedby={fallbackInstructionId}
            onFocus={onFallbackFocus}
            data-testid="reader-copy-link-fallback"
          />
          <p
            id={fallbackInstructionId}
            className="px-1 pt-1.5 text-xs text-ink-3"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="reader-copy-link-instruction"
          >
            {MANUAL_COPY_INSTRUCTION}
          </p>
        </div>
      )}
    </div>
  );
}
