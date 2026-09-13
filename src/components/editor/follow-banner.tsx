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
  keyboard: FollowKeyboardBinding | null;
  actionClaimed: boolean;
  retired: boolean;
  readonly retire: () => void;
}

type FollowNativeGetter = (this: object) => unknown;
type FollowEventField =
  | "type"
  | "target"
  | "currentTarget"
  | "eventPhase"
  | "bubbles"
  | "cancelable"
  | "defaultPrevented"
  | "cancelBubble";
type FollowKeyboardField =
  | "key"
  | "repeat"
  | "isComposing"
  | "ctrlKey"
  | "altKey"
  | "metaKey"
  | "shiftKey";

interface FollowGetterAuthority<Field extends string> {
  readonly getters: Readonly<Record<Field, FollowNativeGetter>>;
  readonly isCurrent: () => boolean;
}

interface FollowMethodAuthority<Method> {
  readonly method: Method;
  readonly isCurrent: () => boolean;
}

interface FollowTrustedAuthority {
  readonly getter: FollowNativeGetter;
  readonly matches: (event: object) => boolean;
  readonly read: (event: object) => boolean;
  readonly isCurrent: () => boolean;
}

interface FollowKeyboardAuthority {
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly Event: typeof Event;
  readonly UIEvent: typeof UIEvent;
  readonly KeyboardEvent: typeof KeyboardEvent;
  readonly Node: typeof Node;
  readonly event: FollowGetterAuthority<FollowEventField>["getters"];
  readonly keyboard: FollowGetterAuthority<FollowKeyboardField>["getters"];
  readonly view: FollowNativeGetter;
  readonly composedPath: Event["composedPath"];
  readonly preventDefault: Event["preventDefault"];
  readonly addEventListener: EventTarget["addEventListener"];
  readonly removeEventListener: EventTarget["removeEventListener"];
  readonly trusted: FollowTrustedAuthority;
  readonly apply: typeof Reflect.apply;
  readonly prototypeOf: typeof Object.getPrototypeOf;
  readonly isCurrent: () => boolean;
}

interface FollowKeyboardSnapshot {
  readonly event: KeyboardEvent;
  readonly target: EventTarget;
  readonly path: readonly EventTarget[];
  readonly phase: number;
  readonly view: Window | null;
  readonly trusted: boolean;
}

interface FollowKeyboardBinding {
  readonly authority: FollowKeyboardAuthority;
  readonly listener: EventListener;
  active: boolean;
  readonly release: () => void;
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

function descriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  if (
    !current ||
    current.configurable !== expected.configurable ||
    current.enumerable !== expected.enumerable ||
    ("value" in current) !== ("value" in expected) ||
    ("writable" in current) !== ("writable" in expected) ||
    ("get" in current) !== ("get" in expected) ||
    ("set" in current) !== ("set" in expected)
  ) {
    return false;
  }
  return "value" in expected
    ? current.value === expected.value && current.writable === expected.writable
    : current.get === expected.get && current.set === expected.set;
}

function captureGetters<const Fields extends readonly string[]>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  prototype: object,
  fields: Fields,
): FollowGetterAuthority<Fields[number]> | null {
  const entries: [Fields[number], FollowNativeGetter][] = [];
  const descriptors: [Fields[number], PropertyDescriptor][] = [];
  for (const field of fields) {
    const descriptor = getOwnPropertyDescriptor(prototype, field);
    if (!descriptor || typeof descriptor.get !== "function") return null;
    entries.push([field, descriptor.get]);
    descriptors.push([field, Object.freeze({ ...descriptor })]);
  }
  const getters = Object.freeze(
    Object.fromEntries(entries),
  ) as Readonly<Record<Fields[number], FollowNativeGetter>>;
  return Object.freeze({
    getters,
    isCurrent: () =>
      descriptors.every(([field, expected]) =>
        descriptorsMatch(getOwnPropertyDescriptor(prototype, field), expected),
      ),
  });
}

function captureMethod<Method>(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  prototype: object,
  name: PropertyKey,
): FollowMethodAuthority<Method> | null {
  const descriptor = getOwnPropertyDescriptor(prototype, name);
  if (!descriptor || typeof descriptor.value !== "function") return null;
  const expected = Object.freeze({ ...descriptor });
  return Object.freeze({
    method: descriptor.value as Method,
    isCurrent: () =>
      descriptorsMatch(getOwnPropertyDescriptor(prototype, name), expected),
  });
}

function captureTrustedGetter(
  getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor,
  apply: typeof Reflect.apply,
  probe: KeyboardEvent,
): FollowTrustedAuthority | null {
  const descriptor = getOwnPropertyDescriptor(probe, "isTrusted");
  if (
    !descriptor ||
    descriptor.configurable !== false ||
    typeof descriptor.get !== "function"
  ) {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  const matches = (event: object) =>
    descriptorsMatch(getOwnPropertyDescriptor(event, "isTrusted"), expected);
  return Object.freeze({
    getter: descriptor.get,
    matches,
    read: (event: object) =>
      apply(descriptor.get as FollowNativeGetter, event, []) as boolean,
    isCurrent: () => matches(probe),
  });
}

function captureKeyboardAuthority(
  ownerDocument: Document,
  ownerWindow: Window & typeof globalThis,
): FollowKeyboardAuthority | null {
  const objectConstructor = ownerWindow.Object;
  const getOwnPropertyDescriptor = objectConstructor.getOwnPropertyDescriptor;
  const prototypeOf = objectConstructor.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const EventConstructor = ownerWindow.Event;
  const UIEventConstructor = ownerWindow.UIEvent;
  const KeyboardEventConstructor = ownerWindow.KeyboardEvent;
  const NodeConstructor = ownerWindow.Node;
  const eventPrototype = EventConstructor.prototype;
  const uiEventPrototype = UIEventConstructor.prototype;
  const keyboardEventPrototype = KeyboardEventConstructor.prototype;
  const eventTargetPrototype = ownerWindow.EventTarget.prototype;
  const event = captureGetters(getOwnPropertyDescriptor, eventPrototype, [
    "type",
    "target",
    "currentTarget",
    "eventPhase",
    "bubbles",
    "cancelable",
    "defaultPrevented",
    "cancelBubble",
  ] as const);
  const keyboard = captureGetters(
    getOwnPropertyDescriptor,
    keyboardEventPrototype,
    [
      "key",
      "repeat",
      "isComposing",
      "ctrlKey",
      "altKey",
      "metaKey",
      "shiftKey",
    ] as const,
  );
  const ui = captureGetters(getOwnPropertyDescriptor, uiEventPrototype, [
    "view",
  ] as const);
  const composedPath = captureMethod<Event["composedPath"]>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "composedPath",
  );
  const preventDefault = captureMethod<Event["preventDefault"]>(
    getOwnPropertyDescriptor,
    eventPrototype,
    "preventDefault",
  );
  const addEventListener = captureMethod<EventTarget["addEventListener"]>(
    getOwnPropertyDescriptor,
    eventTargetPrototype,
    "addEventListener",
  );
  const removeEventListener = captureMethod<EventTarget["removeEventListener"]>(
    getOwnPropertyDescriptor,
    eventTargetPrototype,
    "removeEventListener",
  );
  if (
    !event ||
    !keyboard ||
    !ui ||
    !composedPath ||
    !preventDefault ||
    !addEventListener ||
    !removeEventListener
  ) {
    return null;
  }
  let probe: KeyboardEvent;
  try {
    probe = new KeyboardEventConstructor("follow-keyboard-probe");
  } catch {
    return null;
  }
  const trusted = captureTrustedGetter(getOwnPropertyDescriptor, apply, probe);
  if (!trusted) return null;

  const isCurrent = () =>
    ownerDocument.defaultView === ownerWindow &&
    ownerWindow.Object === objectConstructor &&
    ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
    ownerWindow.Object.getPrototypeOf === prototypeOf &&
    ownerWindow.Reflect.apply === apply &&
    ownerWindow.Event === EventConstructor &&
    ownerWindow.UIEvent === UIEventConstructor &&
    ownerWindow.KeyboardEvent === KeyboardEventConstructor &&
    ownerWindow.Node === NodeConstructor &&
    ownerWindow.EventTarget.prototype === eventTargetPrototype &&
    EventConstructor.prototype === eventPrototype &&
    UIEventConstructor.prototype === uiEventPrototype &&
    KeyboardEventConstructor.prototype === keyboardEventPrototype &&
    prototypeOf(keyboardEventPrototype) === uiEventPrototype &&
    prototypeOf(uiEventPrototype) === eventPrototype &&
    event.isCurrent() &&
    keyboard.isCurrent() &&
    ui.isCurrent() &&
    composedPath.isCurrent() &&
    preventDefault.isCurrent() &&
    addEventListener.isCurrent() &&
    removeEventListener.isCurrent() &&
    trusted.isCurrent();
  if (!isCurrent()) return null;

  return Object.freeze({
    ownerDocument,
    ownerWindow,
    Event: EventConstructor,
    UIEvent: UIEventConstructor,
    KeyboardEvent: KeyboardEventConstructor,
    Node: NodeConstructor,
    event: event.getters,
    keyboard: keyboard.getters,
    view: ui.getters.view,
    composedPath: composedPath.method,
    preventDefault: preventDefault.method,
    addEventListener: addEventListener.method,
    removeEventListener: removeEventListener.method,
    trusted,
    apply,
    prototypeOf,
    isCurrent,
  });
}

function nativeValue<Value>(
  authority: FollowKeyboardAuthority,
  getter: FollowNativeGetter,
  event: Event,
): Value {
  return authority.apply(getter, event, []) as Value;
}

function captureEscapeSnapshot(
  authority: FollowKeyboardAuthority,
  event: Event,
): FollowKeyboardSnapshot | null {
  if (
    !authority.isCurrent() ||
    authority.prototypeOf(event) !== authority.KeyboardEvent.prototype ||
    !authority.trusted.matches(event)
  ) {
    return null;
  }
  try {
    const type = nativeValue<string>(authority, authority.event.type, event);
    const target = nativeValue<EventTarget | null>(
      authority,
      authority.event.target,
      event,
    );
    const currentTarget = nativeValue<EventTarget | null>(
      authority,
      authority.event.currentTarget,
      event,
    );
    const phase = nativeValue<number>(
      authority,
      authority.event.eventPhase,
      event,
    );
    const path = authority.apply(authority.composedPath, event, []) as EventTarget[];
    const view = nativeValue<Window | null>(authority, authority.view, event);
    const trusted = authority.trusted.read(event);
    if (
      type !== "keydown" ||
      nativeValue<string>(authority, authority.keyboard.key, event) !== "Escape" ||
      nativeValue<boolean>(authority, authority.keyboard.repeat, event) ||
      nativeValue<boolean>(authority, authority.keyboard.isComposing, event) ||
      nativeValue<boolean>(authority, authority.keyboard.ctrlKey, event) ||
      nativeValue<boolean>(authority, authority.keyboard.altKey, event) ||
      nativeValue<boolean>(authority, authority.keyboard.metaKey, event) ||
      nativeValue<boolean>(authority, authority.keyboard.shiftKey, event) ||
      !nativeValue<boolean>(authority, authority.event.bubbles, event) ||
      !nativeValue<boolean>(authority, authority.event.cancelable, event) ||
      nativeValue<boolean>(authority, authority.event.defaultPrevented, event) ||
      nativeValue<boolean>(authority, authority.event.cancelBubble, event) ||
      currentTarget !== authority.ownerDocument ||
      (phase !== authority.Event.AT_TARGET &&
        phase !== authority.Event.BUBBLING_PHASE) ||
      !target ||
      (target !== authority.ownerDocument &&
        (!(target instanceof authority.Node) ||
          target.ownerDocument !== authority.ownerDocument ||
          !target.isConnected)) ||
      (view !== null && view !== authority.ownerWindow) ||
      path[0] !== target ||
      path.filter((entry) => entry === authority.ownerDocument).length !== 1
    ) {
      return null;
    }
    return Object.freeze({
      event: event as KeyboardEvent,
      target,
      path: Object.freeze([...path]),
      phase,
      view,
      trusted,
    });
  } catch {
    // Built-in getters throw for objects that only imitate a KeyboardEvent.
    return null;
  }
}

function escapeSnapshotMatches(
  authority: FollowKeyboardAuthority,
  snapshot: FollowKeyboardSnapshot,
) {
  const current = captureEscapeSnapshot(authority, snapshot.event);
  return Boolean(
    current &&
      current.target === snapshot.target &&
      current.phase === snapshot.phase &&
      current.view === snapshot.view &&
      current.trusted === snapshot.trusted &&
      current.path.length === snapshot.path.length &&
      current.path.every((entry, index) => entry === snapshot.path[index]),
  );
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

  constructor(
    private readonly committed: FollowDomSnapshot,
    private readonly onDirty: () => void,
  ) {
    const ownerWindow = committed.elements.banner.ownerDocument.defaultView;
    if (!ownerWindow) throw new Error("The Follow banner has no owner window");
    this.rootObserver = new ownerWindow.MutationObserver((records) => {
      if (records.length > 0) this.markDirty();
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

  private readonly markDirty = () => {
    if (this.dirty) return;
    this.dirty = true;
    this.onDirty();
  };

  private readonly recordPlacement = (records: readonly MutationRecord[]) => {
    const banner = this.committed.elements.banner;
    for (const record of records) {
      if (
        Array.from(record.addedNodes).includes(banner) ||
        Array.from(record.removedNodes).includes(banner)
      ) {
        this.markDirty();
        return;
      }
    }
  };

  readonly isPristine = () => {
    if (this.rootObserver.takeRecords().length > 0) this.markDirty();
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
    current.keyboard?.release();
    current.keyboard = null;
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
      keyboard: null,
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

  const handleEscape = (
    current: FollowGrant,
    binding: FollowKeyboardBinding,
    event: Event,
  ) => {
    if (
      !binding.active ||
      !binding.authority.isCurrent() ||
      current.retired ||
      current.keyboard !== binding ||
      current.publication !== presentation ||
      cells.active.current !== current ||
      phase !== "active" ||
      current.actionClaimed ||
      cells.claimedEvents.has(event)
    ) {
      if (binding.active && !binding.authority.isCurrent()) invalidate();
      return;
    }
    const snapshot = captureEscapeSnapshot(binding.authority, event);
    if (!snapshot) return;
    const currentHistory = history;
    if (
      !currentHistory ||
      !currentHistory.isPristine() ||
      !exactDomIsCurrent(current.committed) ||
      !liveFactsMatch()
    ) {
      invalidate();
      return;
    }

    current.actionClaimed = true;
    cells.claimedEvents.add(event);
    if (
      current.retired ||
      current.keyboard !== binding ||
      cells.active.current !== current ||
      history !== currentHistory ||
      !currentHistory.isPristine() ||
      !escapeSnapshotMatches(binding.authority, snapshot) ||
      !exactDomIsCurrent(current.committed) ||
      !liveFactsMatch()
    ) {
      invalidate();
      return;
    }

    invalidate();
    binding.authority.apply(binding.authority.preventDefault, event, []);
    try {
      if (
        !nativeValue<boolean>(
          binding.authority,
          binding.authority.event.defaultPrevented,
          event,
        )
      ) {
        return;
      }
    } catch {
      return;
    }
    follow.call(session, null);
  };

  const bindEscape = (current: FollowGrant): FollowKeyboardBinding | null => {
    const ownerDocument = current.committed.elements.banner.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (!ownerWindow) return null;
    const keyboardAuthority = captureKeyboardAuthority(ownerDocument, ownerWindow);
    if (!keyboardAuthority) return null;
    const listener: EventListener = (event) => {
      handleEscape(current, binding, event);
    };
    const binding: FollowKeyboardBinding = {
      authority: keyboardAuthority,
      listener,
      active: true,
      release: () => {
        if (!binding.active) return;
        binding.active = false;
        keyboardAuthority.apply(
          keyboardAuthority.removeEventListener,
          ownerDocument,
          ["keydown", listener, false],
        );
      },
    };
    keyboardAuthority.apply(
      keyboardAuthority.addEventListener,
      ownerDocument,
      ["keydown", listener, false],
    );
    return binding;
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
    current.keyboard = bindEscape(current);
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
    const currentHistory = new FollowMutationHistory(committed, () => {
      if (history === currentHistory) invalidate();
      else currentHistory.disconnect();
    });
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
