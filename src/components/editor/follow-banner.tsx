"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { X } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { jsonEqual, useSessionValue } from "./use-session";

const BANNER_CLASS =
  "flex h-8 shrink-0 items-center justify-center gap-2 px-3 text-[13px] font-medium text-white";
const SECTION_CLASS = "opacity-80";
const SEPARATOR_CLASS = "opacity-60";
const STOP_CLASS =
  "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white";
const SHORTCUT_CLASS = "opacity-70";

interface FollowedSnapshot {
  readonly followUserId: string;
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly section: string | null;
}

interface FollowAuthority {
  readonly generation: symbol;
  readonly revision: number;
  readonly mount: symbol;
  readonly session: CollabSession;
  readonly followed: FollowedSnapshot;
  readonly follow: CollabSession["follow"];
  readonly bannerClass: string;
  readonly sectionClass: string;
  readonly separatorClass: string;
  readonly stopClass: string;
  readonly shortcutClass: string;
}

interface FollowElements {
  readonly banner: HTMLDivElement;
  readonly message: HTMLSpanElement;
  readonly section: HTMLSpanElement | null;
  readonly separator: HTMLSpanElement;
  readonly stop: HTMLButtonElement;
  readonly icon: SVGSVGElement;
  readonly shortcut: HTMLSpanElement;
}

interface FollowDomSnapshot {
  readonly elements: FollowElements;
  readonly bannerNodes: readonly Node[];
  readonly stopTargets: readonly Node[];
  readonly markup: string;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface FollowCells {
  readonly active: {
    current: FollowGrant | null;
    revision: number;
  };
  readonly replay: { current: FollowSuccessor | null };
  readonly claimedEvents: WeakSet<object>;
}

interface FollowPresentation {
  readonly authority: FollowAuthority;
  readonly captureBanner: (element: HTMLDivElement | null) => void;
  readonly captureMessage: (element: HTMLSpanElement | null) => void;
  readonly captureSection: (element: HTMLSpanElement | null) => void;
  readonly captureSeparator: (element: HTMLSpanElement | null) => void;
  readonly captureStop: (element: HTMLButtonElement | null) => void;
  readonly captureIcon: (element: SVGSVGElement | null) => void;
  readonly captureShortcut: (element: HTMLSpanElement | null) => void;
  readonly establish: () => void;
  readonly retire: () => boolean;
  readonly onStop: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

interface FollowGrant {
  readonly generation: symbol;
  readonly publication: FollowPresentation;
  readonly committed: FollowDomSnapshot;
  actionClaimed: boolean;
  retired: boolean;
  readonly retire: () => void;
}

type FollowElementName = keyof FollowElements;
// React replays layout effects only after tearing down and restoring callback refs.
// A retired grant stays dead; this phase machine alone may issue its exact successor.
type FollowPhase =
  | "mounting"
  | "active"
  | "layout-retired"
  | "refs-detached"
  | "replay-ready"
  | "successor-requested"
  | "dead";

interface FollowReplay {
  readonly committed: FollowDomSnapshot;
  readonly revision: number;
  readonly detached: Set<FollowElementName>;
  readonly attached: Set<FollowElementName>;
}

interface FollowSuccessor {
  readonly source: FollowPresentation;
  readonly authority: FollowAuthority;
  readonly committed: FollowDomSnapshot;
  readonly history: FollowMutationHistory;
  readonly revision: number;
}

class ElementOwner<T extends Element> {
  private current: T | null = null;

  constructor(
    private readonly name: FollowElementName,
    private readonly onChange: (
      name: FollowElementName,
      previous: T | null,
      current: T | null,
    ) => void,
  ) {}

  readonly element = () => this.current;
  readonly capture = (element: T | null) => {
    if (this.current === element) return;
    const previous = this.current;
    this.current = element;
    this.onChange(this.name, previous, element);
  };
}

function descendantsOf(element: Element): readonly Node[] {
  const nodes: Node[] = [];
  const collect = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes) collect(child);
  };
  collect(element);
  return Object.freeze(nodes);
}

function sameNodes(expected: readonly Node[], element: Element): boolean {
  const current = descendantsOf(element);
  return current.length === expected.length && current.every((node, index) => node === expected[index]);
}

class FollowMutationHistory {
  private dirty = false;
  private readonly rootObserver: MutationObserver;
  private readonly placementObserver: MutationObserver;

  constructor(private readonly committed: FollowDomSnapshot) {
    const ownerWindow = committed.elements.banner.ownerDocument.defaultView;
    if (!ownerWindow) throw new Error("The Follow banner has no owner window");
    this.rootObserver = new ownerWindow.MutationObserver((records) => {
      if (records.length > 0) this.dirty = true;
    });
    this.placementObserver = new ownerWindow.MutationObserver((records) => {
      this.recordPlacement(records);
    });
    this.rootObserver.observe(committed.elements.banner, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    this.placementObserver.observe(committed.parent, { childList: true });
  }

  private readonly recordPlacement = (records: readonly MutationRecord[]) => {
    const banner = this.committed.elements.banner;
    for (const record of records) {
      if (
        Array.from(record.addedNodes).includes(banner) ||
        Array.from(record.removedNodes).includes(banner)
      ) {
        this.dirty = true;
        return;
      }
    }
  };

  readonly isPristine = () => {
    if (this.rootObserver.takeRecords().length > 0) this.dirty = true;
    this.recordPlacement(this.placementObserver.takeRecords());
    return !this.dirty;
  };

  readonly disconnect = () => {
    this.rootObserver.disconnect();
    this.placementObserver.disconnect();
  };
}

function snapshotDom(elements: FollowElements): FollowDomSnapshot | null {
  const parent = elements.banner.parentNode;
  if (!parent) return null;
  return Object.freeze({
    elements: Object.freeze(elements),
    bannerNodes: descendantsOf(elements.banner),
    stopTargets: descendantsOf(elements.stop),
    markup: elements.banner.outerHTML,
    parent,
    previousSibling: elements.banner.previousSibling,
    nextSibling: elements.banner.nextSibling,
  });
}

function snapshotElement(
  committed: FollowDomSnapshot,
  name: FollowElementName,
): Element | null {
  return committed.elements[name];
}

function sameAuthorityFacts(
  expected: FollowAuthority,
  current: FollowAuthority,
): boolean {
  return (
    expected.mount === current.mount &&
    expected.session === current.session &&
    expected.followed === current.followed &&
    expected.follow === current.follow &&
    expected.bannerClass === current.bannerClass &&
    expected.sectionClass === current.sectionClass &&
    expected.separatorClass === current.separatorClass &&
    expected.stopClass === current.stopClass &&
    expected.shortcutClass === current.shortcutClass
  );
}

function createFollowPresentation(
  authority: FollowAuthority,
  cells: FollowCells,
  requestSuccessor: () => void,
): FollowPresentation {
  const {
    generation,
    revision,
    mount,
    session,
    followed,
    follow,
    bannerClass,
    sectionClass,
    separatorClass,
    stopClass,
    shortcutClass,
  } = authority;
  const { followUserId, id, name, color, section } = followed;
  const refNames: readonly FollowElementName[] =
    section === null
      ? ["banner", "message", "separator", "stop", "icon", "shortcut"]
      : ["banner", "message", "section", "separator", "stop", "icon", "shortcut"];
  let phase: FollowPhase = "mounting";
  let grant: FollowGrant | null = null;
  let history: FollowMutationHistory | null = null;
  let replay: FollowReplay | null = null;
  let expiry = 0;
  const initialRefs = new Set<FollowElementName>();

  const clearGrant = (current: FollowGrant) => {
    current.retired = true;
    if (cells.active.current === current) {
      cells.active.current = null;
      cells.active.revision++;
    }
    if (grant === current) grant = null;
  };

  const releaseOwnedSuccessor = () => {
    const pending = cells.replay.current;
    if (!pending || pending.source !== presentation) return;
    pending.history.disconnect();
    cells.replay.current = null;
  };

  const invalidate = () => {
    expiry++;
    phase = "dead";
    replay = null;
    releaseOwnedSuccessor();
    history?.disconnect();
    history = null;
    if (grant) clearGrant(grant);
  };

  const refsComplete = (refs: ReadonlySet<FollowElementName>) =>
    refNames.every((name) => refs.has(name));

  const onElementChange = (
    name: FollowElementName,
    previous: Element | null,
    element: Element | null,
  ) => {
    if (phase === "dead") return;
    if (history && !history.isPristine()) {
      invalidate();
      return;
    }
    if (phase === "successor-requested") return;
    if (phase === "mounting") {
      if (previous !== null || element === null || initialRefs.has(name)) {
        invalidate();
        return;
      }
      initialRefs.add(name);
      return;
    }
    if (phase === "active" || phase === "replay-ready") {
      invalidate();
      return;
    }
    if (!replay) {
      invalidate();
      return;
    }
    const expected = snapshotElement(replay.committed, name);
    if (!expected) {
      invalidate();
      return;
    }
    if (phase === "layout-retired") {
      if (
        previous !== expected ||
        element !== null ||
        replay.detached.has(name) ||
        replay.attached.size > 0
      ) {
        invalidate();
        return;
      }
      replay.detached.add(name);
      if (refsComplete(replay.detached)) phase = "refs-detached";
      return;
    }
    if (
      phase !== "refs-detached" ||
      previous !== null ||
      element !== expected ||
      !replay.detached.has(name) ||
      replay.attached.has(name)
    ) {
      invalidate();
      return;
    }
    replay.attached.add(name);
    if (refsComplete(replay.attached)) phase = "replay-ready";
  };

  const bannerOwner = new ElementOwner<HTMLDivElement>("banner", onElementChange);
  const messageOwner = new ElementOwner<HTMLSpanElement>("message", onElementChange);
  const sectionOwner = new ElementOwner<HTMLSpanElement>("section", onElementChange);
  const separatorOwner = new ElementOwner<HTMLSpanElement>("separator", onElementChange);
  const stopOwner = new ElementOwner<HTMLButtonElement>("stop", onElementChange);
  const iconOwner = new ElementOwner<SVGSVGElement>("icon", onElementChange);
  const shortcutOwner = new ElementOwner<HTMLSpanElement>("shortcut", onElementChange);

  const authorityMatches = () =>
    authority.generation === generation &&
    authority.revision === revision &&
    authority.mount === mount &&
    authority.session === session &&
    authority.followed === followed &&
    authority.follow === follow &&
    followed.followUserId === followUserId &&
    followed.id === id &&
    followed.name === name &&
    followed.color === color &&
    followed.section === section &&
    authority.bannerClass === bannerClass &&
    authority.sectionClass === sectionClass &&
    authority.separatorClass === separatorClass &&
    authority.stopClass === stopClass &&
    authority.shortcutClass === shortcutClass;

  const liveFactsMatch = () => {
    if (
      !authorityMatches() ||
      session.followUserId !== followUserId
    ) {
      return false;
    }
    const current = session.presence().find((user) => user.id === id);
    return Boolean(
      current &&
      current.id === id &&
      current.name === name &&
      current.color === color &&
      current.section === section
    );
  };

  const currentElements = (): FollowElements | null => {
    const banner = bannerOwner.element();
    const message = messageOwner.element();
    const currentSection = sectionOwner.element();
    const separator = separatorOwner.element();
    const stop = stopOwner.element();
    const icon = iconOwner.element();
    const shortcut = shortcutOwner.element();
    if (
      !banner ||
      !message ||
      !separator ||
      !stop ||
      !icon ||
      !shortcut ||
      (section === null ? currentSection !== null : currentSection === null)
    ) {
      return null;
    }
    return {
      banner,
      message,
      section: currentSection,
      separator,
      stop,
      icon,
      shortcut,
    };
  };

  const exactDomIsCurrent = (snapshot: FollowDomSnapshot | null) => {
    const elements = currentElements();
    if (!elements) return false;
    const {
      banner,
      message,
      section: currentSection,
      separator,
      stop,
      icon,
      shortcut,
    } = elements;
    const ownerDocument = banner.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (
      !ownerWindow ||
      !banner.isConnected ||
      !banner.parentNode ||
      !message.isConnected ||
      !separator.isConnected ||
      !stop.isConnected ||
      !icon.isConnected ||
      !shortcut.isConnected ||
      Boolean(currentSection && !currentSection.isConnected) ||
      message.ownerDocument !== ownerDocument ||
      separator.ownerDocument !== ownerDocument ||
      stop.ownerDocument !== ownerDocument ||
      icon.ownerDocument !== ownerDocument ||
      shortcut.ownerDocument !== ownerDocument ||
      Boolean(currentSection && currentSection.ownerDocument !== ownerDocument) ||
      banner.tagName !== "DIV" ||
      banner.getAttribute("class") !== bannerClass ||
      banner.getAttribute("role") !== "status" ||
      banner.dataset.testid !== "follow-banner" ||
      banner.dataset.userId !== id ||
      !banner.style.backgroundColor ||
      banner.children.length !== 3 ||
      banner.childNodes.length !== 3 ||
      banner.children.item(0) !== message ||
      banner.children.item(1) !== separator ||
      banner.children.item(2) !== stop ||
      message.tagName !== "SPAN" ||
      message.parentElement !== banner ||
      message.firstChild?.nodeType !== ownerWindow.Node.TEXT_NODE ||
      message.firstChild.textContent !== "Following " ||
      message.childNodes.item(1)?.nodeType !== ownerWindow.Node.TEXT_NODE ||
      message.childNodes.item(1)?.textContent !== name ||
      message.children.length !== (section === null ? 0 : 1) ||
      message.childNodes.length !== (section === null ? 2 : 3) ||
      message.textContent !==
        `Following ${name}${section === null ? "" : ` · in ‘${section}’`}` ||
      (section === null
        ? currentSection !== null
        : currentSection?.parentElement !== message ||
          message.children.item(0) !== currentSection ||
          message.lastChild !== currentSection ||
          currentSection.getAttribute("class") !== sectionClass ||
          currentSection.textContent !== ` · in ‘${section}’`) ||
      separator.tagName !== "SPAN" ||
      separator.parentElement !== banner ||
      separator.getAttribute("class") !== separatorClass ||
      separator.textContent !== "·" ||
      stop.tagName !== "BUTTON" ||
      stop.parentElement !== banner ||
      stop.getAttribute("type") !== "button" ||
      stop.type !== "button" ||
      stop.disabled ||
      stop.matches(":disabled") ||
      stop.getAttribute("class") !== stopClass ||
      stop.dataset.testid !== "follow-stop" ||
      stop.children.length !== 2 ||
      stop.childNodes.length !== 3 ||
      stop.children.item(0) !== icon ||
      stop.children.item(1) !== shortcut ||
      stop.childNodes.item(1)?.nodeType !== ownerWindow.Node.TEXT_NODE ||
      stop.childNodes.item(1)?.textContent?.trim() !== "Stop" ||
      stop.textContent?.replace(/\s+/g, " ").trim() !== "Stop (Esc)" ||
      icon.tagName.toLowerCase() !== "svg" ||
      icon.parentElement !== stop ||
      icon.getAttribute("width") !== "13" ||
      icon.getAttribute("height") !== "13" ||
      icon.getAttribute("aria-hidden") !== "true" ||
      !icon.classList.contains("lucide-x") ||
      shortcut.tagName !== "SPAN" ||
      shortcut.parentElement !== stop ||
      shortcut.getAttribute("class") !== shortcutClass ||
      shortcut.textContent !== "(Esc)"
    ) {
      return false;
    }
    return (
      !snapshot ||
      (snapshot.elements.banner === banner &&
        snapshot.elements.message === message &&
        snapshot.elements.section === currentSection &&
        snapshot.elements.separator === separator &&
        snapshot.elements.stop === stop &&
        snapshot.elements.icon === icon &&
        snapshot.elements.shortcut === shortcut &&
        snapshot.markup === banner.outerHTML &&
        snapshot.parent === banner.parentNode &&
        snapshot.previousSibling === banner.previousSibling &&
        snapshot.nextSibling === banner.nextSibling &&
        sameNodes(snapshot.bannerNodes, banner) &&
        sameNodes(snapshot.stopTargets, stop))
    );
  };

  const createGrant = (committed: FollowDomSnapshot): FollowGrant => {
    const current: FollowGrant = {
      generation: Symbol("follow-authority"),
      publication: presentation,
      committed,
      actionClaimed: false,
      retired: false,
      retire: () => {
        if (current.retired) return;
        if (grant === current) invalidate();
        else current.retired = true;
      },
    };
    return current;
  };

  const activate = (
    committed: FollowDomSnapshot,
    currentHistory: FollowMutationHistory,
  ) => {
    const current = createGrant(committed);
    const previous = cells.active.current;
    if (previous) previous.retire();
    if (cells.active.current) {
      currentHistory.disconnect();
      current.retired = true;
      invalidate();
      return;
    }
    history = currentHistory;
    grant = current;
    cells.active.current = current;
    cells.active.revision++;
    phase = "active";
  };

  const establishInitial = () => {
    let successor = cells.replay.current;
    if (successor && !sameAuthorityFacts(successor.authority, authority)) {
      successor.history.disconnect();
      if (cells.replay.current === successor) cells.replay.current = null;
      successor = null;
    }
    if (
      successor &&
      (cells.active.current !== null ||
        cells.active.revision !== successor.revision ||
        !successor.history.isPristine() ||
        !exactDomIsCurrent(successor.committed))
    ) {
      successor.history.disconnect();
      if (cells.replay.current === successor) cells.replay.current = null;
      invalidate();
      return;
    }
    if (
      !refsComplete(initialRefs) ||
      !liveFactsMatch() ||
      !exactDomIsCurrent(null)
    ) {
      invalidate();
      return;
    }
    const elements = currentElements();
    const committed = elements ? snapshotDom(elements) : null;
    if (!committed) {
      invalidate();
      return;
    }
    const currentHistory = new FollowMutationHistory(committed);
    if (
      !currentHistory.isPristine() ||
      Boolean(successor && !successor.history.isPristine()) ||
      Boolean(successor && !exactDomIsCurrent(successor.committed)) ||
      !liveFactsMatch() ||
      !exactDomIsCurrent(committed)
    ) {
      currentHistory.disconnect();
      successor?.history.disconnect();
      if (cells.replay.current === successor) cells.replay.current = null;
      invalidate();
      return;
    }
    successor?.history.disconnect();
    if (cells.replay.current === successor) cells.replay.current = null;
    activate(committed, currentHistory);
  };

  const establishReplay = () => {
    const candidate = replay;
    const previousHistory = history;
    if (
      !candidate ||
      !previousHistory ||
      phase !== "replay-ready" ||
      cells.active.current !== null ||
      cells.active.revision !== candidate.revision ||
      !previousHistory.isPristine() ||
      !exactDomIsCurrent(candidate.committed) ||
      !liveFactsMatch()
    ) {
      invalidate();
      return;
    }
    if (
      !previousHistory.isPristine() ||
      !exactDomIsCurrent(candidate.committed) ||
      !liveFactsMatch() ||
      cells.active.current !== null ||
      cells.active.revision !== candidate.revision
    ) {
      invalidate();
      return;
    }
    if (cells.replay.current) {
      invalidate();
      return;
    }
    cells.replay.current = Object.freeze({
      source: presentation,
      authority,
      committed: candidate.committed,
      history: previousHistory,
      revision: candidate.revision,
    });
    history = null;
    replay = null;
    phase = "successor-requested";
    const ticket = ++expiry;
    requestSuccessor();
    queueMicrotask(() => {
      if (
        expiry === ticket &&
        cells.replay.current?.source === presentation
      ) {
        invalidate();
      }
    });
  };

  const establish = () => {
    if (phase === "mounting") {
      establishInitial();
      return;
    }
    if (phase === "replay-ready") {
      establishReplay();
      return;
    }
    invalidate();
  };

  const retire = () => {
    if (phase === "successor-requested") return false;
    if (phase !== "active" || !grant || !history || !history.isPristine()) {
      invalidate();
      return false;
    }
    const retired = grant;
    if (cells.active.current !== retired) {
      invalidate();
      return false;
    }
    clearGrant(retired);
    replay = {
      committed: retired.committed,
      revision: cells.active.revision,
      detached: new Set<FollowElementName>(),
      attached: new Set<FollowElementName>(),
    };
    phase = "layout-retired";
    const ticket = ++expiry;
    queueMicrotask(() => {
      if (
        expiry === ticket &&
        (phase === "layout-retired" ||
         phase === "refs-detached" ||
         phase === "replay-ready")
      ) {
        invalidate();
      }
    });
    return true;
  };

  const onStop = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const current = grant;
    if (
      !current ||
      current.retired ||
      cells.active.current !== current ||
      phase !== "active" ||
      current.actionClaimed ||
      !event ||
      typeof event !== "object"
    ) {
      return;
    }
    const { committed } = current;
    const stop = committed.elements.stop;
    const ownerDocument = stop.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !ownerWindow ||
      event.type !== "click" ||
      event.currentTarget !== stop ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      nativeEvent.target !== target ||
      !(target instanceof ownerWindow.Node) ||
      target.ownerDocument !== ownerDocument ||
      !committed.stopTargets.includes(target) ||
      !stop.isConnected ||
      stop.ownerDocument !== ownerDocument ||
      stop.disabled ||
      stop.matches(":disabled") ||
      cells.claimedEvents.has(event) ||
      cells.claimedEvents.has(nativeEvent)
    ) {
      return;
    }
    current.actionClaimed = true;
    cells.claimedEvents.add(event);
    cells.claimedEvents.add(nativeEvent);
    if (!exactDomIsCurrent(committed)) {
      invalidate();
      return;
    }
    if (!liveFactsMatch()) {
      invalidate();
      return;
    }
    if (
      current.retired ||
      cells.active.current !== current ||
      !exactDomIsCurrent(committed)
    ) {
      invalidate();
      return;
    }
    invalidate();
    follow.call(session, null);
  };

  const presentation: FollowPresentation = Object.freeze({
    authority,
    captureBanner: bannerOwner.capture,
    captureMessage: messageOwner.capture,
    captureSection: sectionOwner.capture,
    captureSeparator: separatorOwner.capture,
    captureStop: stopOwner.capture,
    captureIcon: iconOwner.capture,
    captureShortcut: shortcutOwner.capture,
    establish,
    retire,
    onStop,
  });
  return presentation;
}

/**
 * Slim strip above the panes while the viewport is glued to a collaborator's cursor.
 * Coloured with that user's presence colour; Esc or the Stop button ends following.
 */
export function FollowBanner({ session }: { session: CollabSession }) {
  const [mount] = useState(() => Symbol("follow-banner"));
  const [cells] = useState<FollowCells>(() => ({
    active: { current: null, revision: 0 },
    replay: { current: null },
    claimedEvents: new WeakSet<object>(),
  }));
  const [publicationRevision, setPublicationRevision] = useState(0);
  const requestSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const followed = useSessionValue(
    session,
    (currentSession) => {
      const followUserId = currentSession.followUserId;
      if (!followUserId) return null;
      const user = currentSession.presence().find((candidate) => candidate.id === followUserId);
      return user
        ? Object.freeze({
            followUserId,
            id: user.id,
            name: user.name,
            color: user.color,
            section: user.section,
          })
        : null;
    },
    jsonEqual,
  );
  const follow = session.follow;
  const authority = useMemo<FollowAuthority | null>(
    () =>
      followed
        ? Object.freeze({
            generation: Symbol("follow-publication"),
          revision: publicationRevision,
          mount,
            session,
            followed,
            follow,
            bannerClass: BANNER_CLASS,
            sectionClass: SECTION_CLASS,
            separatorClass: SEPARATOR_CLASS,
            stopClass: STOP_CLASS,
            shortcutClass: SHORTCUT_CLASS,
          })
        : null,
    [follow, followed, mount, publicationRevision, session],
  );
  const presentation = useMemo(
    () =>
      authority
        ? createFollowPresentation(authority, cells, requestSuccessor)
        : null,
    [authority, cells, requestSuccessor],
  );

  useLayoutEffect(() => {
    if (!presentation) return;
    presentation.establish();
    return () => {
      presentation.retire();
    };
  }, [presentation]);

  if (!authority || !presentation) return null;
  const {
    captureBanner,
    captureMessage,
    captureSection,
    captureSeparator,
    captureStop,
    captureIcon,
    captureShortcut,
    onStop,
  } = presentation;
  const { followed: current } = authority;
  return (
    <div
      ref={captureBanner}
      className={authority.bannerClass}
      style={{ backgroundColor: current.color }}
      role="status"
      data-testid="follow-banner"
      data-user-id={current.id}
    >
      <span ref={captureMessage}>
        Following {current.name}
        {current.section ? (
          <span ref={captureSection} className={authority.sectionClass}>
            {" · in ‘"}{current.section}{"’"}
          </span>
        ) : null}
      </span>
      <span ref={captureSeparator} className={authority.separatorClass}>·</span>
      <button
        ref={captureStop}
        type="button"
        className={authority.stopClass}
        onClick={onStop}
        data-testid="follow-stop"
      >
        <X ref={captureIcon} size={13} />
        Stop <span ref={captureShortcut} className={authority.shortcutClass}>(Esc)</span>
      </button>
    </div>
  );
}
