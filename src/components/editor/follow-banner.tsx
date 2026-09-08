"use client";

import {
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
}

interface FollowCells {
  readonly active: { current: FollowPresentation | null };
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

class ElementOwner<T extends Element> {
  private current: T | null = null;
  private last: T | null = null;

  constructor(private readonly onReplacement: () => void) {}

  readonly element = () => this.current;
  readonly capture = (element: T | null) => {
    if (this.current === element) return;
    const replaced = element !== null && this.last !== null && this.last !== element;
    this.current = element;
    if (element) this.last = element;
    if (replaced || element === null) this.onReplacement();
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

function createFollowPresentation(authority: FollowAuthority, cells: FollowCells): FollowPresentation {
  const {
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
  let committed: FollowDomSnapshot | null = null;
  let actionClaimed = false;
  const retireForReplacement = () => presentation.retire();
  const bannerOwner = new ElementOwner<HTMLDivElement>(retireForReplacement);
  const messageOwner = new ElementOwner<HTMLSpanElement>(retireForReplacement);
  const sectionOwner = new ElementOwner<HTMLSpanElement>(retireForReplacement);
  const separatorOwner = new ElementOwner<HTMLSpanElement>(retireForReplacement);
  const stopOwner = new ElementOwner<HTMLButtonElement>(retireForReplacement);
  const iconOwner = new ElementOwner<SVGSVGElement>(retireForReplacement);
  const shortcutOwner = new ElementOwner<HTMLSpanElement>(retireForReplacement);

  const authorityMatches = () =>
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
      session.follow !== follow ||
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
        sameNodes(snapshot.bannerNodes, banner) &&
        sameNodes(snapshot.stopTargets, stop))
    );
  };

  const retire = () => {
    if (cells.active.current !== presentation) return false;
    cells.active.current = null;
    return true;
  };

  const establish = () => {
    const previous = cells.active.current;
    if (previous && previous !== presentation) previous.retire();
    if (!liveFactsMatch() || !exactDomIsCurrent(null)) {
      retire();
      return;
    }
    const elements = currentElements();
    if (!elements) return;
    const snapshot: FollowDomSnapshot = Object.freeze({
      elements: Object.freeze(elements),
      bannerNodes: descendantsOf(elements.banner),
      stopTargets: descendantsOf(elements.stop),
      markup: elements.banner.outerHTML,
    });
    if (!liveFactsMatch() || !exactDomIsCurrent(snapshot)) {
      retire();
      return;
    }
    committed = snapshot;
    cells.active.current = presentation;
  };

  const onStop = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (
      cells.active.current !== presentation ||
      actionClaimed ||
      !committed ||
      !event ||
      typeof event !== "object"
    ) {
      return;
    }
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
      cells.claimedEvents.has(nativeEvent) ||
      cells.active.current !== presentation ||
      !exactDomIsCurrent(committed) ||
      !liveFactsMatch() ||
      cells.active.current !== presentation
    ) {
      return;
    }

    actionClaimed = true;
    cells.claimedEvents.add(event);
    cells.claimedEvents.add(nativeEvent);
    retire();
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
    active: { current: null },
    claimedEvents: new WeakSet<object>(),
  }));
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
    [follow, followed, mount, session],
  );
  const presentation = useMemo(
    () => (authority ? createFollowPresentation(authority, cells) : null),
    [authority, cells],
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
