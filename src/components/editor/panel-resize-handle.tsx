"use client";

import {
  useCallback,
  useLayoutEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from "react";
import { cn } from "@/lib/utils";

/** Side panel (Comments / Versions / Activity) width on desktop, in CSS pixels. */
export const PANEL_DEFAULT = 340;
export const PANEL_MIN = 280;
export const PANEL_MAX = 720;
export const PANEL_WIDTH_KEY = "markdoc:panelWidth";

/** Arrow keys move the edge by this many pixels (Shift: the larger step). */
export const PANEL_STEP = 16;
export const PANEL_BIG_STEP = 64;

const HANDLE_CLASS =
  "group/handle absolute inset-y-0 left-0 z-10 w-2 -translate-x-1/2 cursor-col-resize touch-none select-none outline-none";
const LINE_CLASS =
  "absolute inset-y-0 left-1/2 w-px bg-line transition-[width,background-color] duration-100 group-hover/handle:w-0.5 group-hover/handle:bg-accent group-focus-visible/handle:w-0.5 group-focus-visible/handle:bg-accent";

/** Widest the panel may be for a window: 720 px or 60 % of the viewport, whichever is smaller. */
export function panelMaxFor(viewportWidth: number): number {
  return Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.floor(viewportWidth * 0.6)));
}

export function clampPanelWidth(width: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(width)));
}

/** A remembered width: whole pixels only; anything else (garbage, floats, negatives) is ignored. */
export function parseStoredPanelWidth(raw: string | null | undefined): number | null {
  if (typeof raw !== "string" || !/^\d{1,5}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

export interface PanelResizeHandleProps {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onReset: () => void;
}

interface HandleAuthority {
  readonly mount: symbol;
  readonly width: number;
  readonly min: number;
  readonly max: number;
  readonly onResize: (width: number) => void;
  readonly onReset: () => void;
}

interface HandlePublication {
  readonly identity: symbol;
  readonly authority: HandleAuthority;
  readonly activeDrag: () => DragOwner | null;
  readonly isRetired: () => boolean;
  readonly retire: () => boolean;
}

interface HandlePublicationSet {
  readonly authority: HandleAuthority;
  readonly captureHandle: (element: HTMLDivElement | null) => void;
  readonly captureLine: (element: HTMLSpanElement | null) => void;
  readonly establish: () => void | (() => void);
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onKeyDownCapture: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly onDoubleClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

interface HandlePublicationRuntime {
  readonly publication: HandlePublication;
  readonly publish: () => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: HandleElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly replay: () => HandleReplay | null;
  readonly beginDrag: (owner: DragOwner) => boolean;
  readonly drag: () => DragOwner | null;
  readonly finishDrag: (owner: DragOwner, captureAlreadyLost?: boolean) => void;
  readonly allowDraggingState: (dragging: boolean) => boolean;
  readonly noteBodyStyleWrite: (
    oldValue: string | null,
    nextValue: string | null,
  ) => void;
  readonly captureKeyboard: (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
  readonly bubbleKeyboard: (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
}

interface HandleReplay {
  readonly source: HandlePublication;
  readonly dom: HandleDomSnapshot;
  readonly placement: HandlePlacement;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface HandleDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly HandleDomSnapshot[];
}

interface HandlePlacement {
  readonly document: Document;
  readonly window: Window & typeof globalThis;
  readonly body: HTMLElement;
  readonly chain: readonly HandleNodePlacement[];
}

interface HandleNodePlacement {
  readonly node: Node;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface HandleMutationGuard {
  readonly isClean: () => boolean;
  readonly historyIsClean: () => boolean;
  readonly allowAttribute: (
    target: Element,
    attributeName: string,
    nextValue: string | null,
  ) => boolean;
  readonly noteBodyStyleWrite: (
    oldValue: string | null,
    nextValue: string | null,
  ) => void;
  readonly release: () => void;
}

interface ExpectedMutation {
  readonly target: Element;
  readonly attributeName: string;
  readonly oldValue: string | null;
  readonly nextValue: string | null;
}

interface HandleElementOwnerView {
  readonly element: () => HTMLElement | null;
}

interface HandleRefReplay {
  readonly owner: HandleElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

interface HandleAction {
  readonly identity: symbol;
  readonly kind: string;
  readonly publication: HandlePublication;
}

interface DragOwner {
  active: boolean;
  readonly publication: HandlePublication;
  readonly runtime: HandlePublicationRuntime;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly button: number;
  readonly startX: number;
  readonly startWidth: number;
  readonly target: HTMLDivElement;
  readonly onResize: (width: number) => void;
  readonly min: number;
  readonly max: number;
  readonly body: HTMLElement;
  readonly setPointerCapture: ((pointerId: number) => void) | null;
  readonly releasePointerCapture: ((pointerId: number) => void) | null;
  captureHeld: boolean;
  bodyCursor: string;
  bodyUserSelect: string;
  ownsBodyStyles: boolean;
  sequence: number;
}

type ReactEventProof = SyntheticEvent<HTMLDivElement, Event> & {
  readonly _reactName?: unknown;
  readonly isPersistent?: unknown;
};

type HandleKeyboardKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End"
  | "Enter";

type HandleKeyboardMethod = (...args: never[]) => unknown;

interface HandleKeyboardIntrinsicGetter<T> {
  readonly read: (target: object) => T;
  readonly isCurrent: () => boolean;
}

interface HandleKeyboardIntrinsicMethod<
  Args extends readonly unknown[],
  Result,
> {
  readonly call: (target: object, ...args: Args) => Result;
  readonly isCurrent: () => boolean;
}

interface HandleKeyboardIntrinsics {
  readonly ownerWindow: Window & typeof globalThis;
  readonly keyboardPrototype: object;
  readonly getPrototypeOf: typeof Object.getPrototypeOf;
  readonly apply: typeof Reflect.apply;
  readonly eventType: HandleKeyboardIntrinsicGetter<string>;
  readonly eventTarget: HandleKeyboardIntrinsicGetter<EventTarget | null>;
  readonly eventCurrentTarget: HandleKeyboardIntrinsicGetter<EventTarget | null>;
  readonly eventPhase: HandleKeyboardIntrinsicGetter<number>;
  readonly eventBubbles: HandleKeyboardIntrinsicGetter<boolean>;
  readonly eventCancelable: HandleKeyboardIntrinsicGetter<boolean>;
  readonly eventDefaultPrevented: HandleKeyboardIntrinsicGetter<boolean>;
  readonly eventCancelBubble: HandleKeyboardIntrinsicGetter<boolean>;
  readonly eventComposed: HandleKeyboardIntrinsicGetter<boolean>;
  readonly eventTimeStamp: HandleKeyboardIntrinsicGetter<number>;
  readonly eventPath: HandleKeyboardIntrinsicMethod<readonly [], EventTarget[]>;
  readonly eventView: HandleKeyboardIntrinsicGetter<Window | null>;
  readonly eventDetail: HandleKeyboardIntrinsicGetter<number>;
  readonly keyboardKey: HandleKeyboardIntrinsicGetter<string>;
  readonly keyboardCode: HandleKeyboardIntrinsicGetter<string>;
  readonly keyboardLocation: HandleKeyboardIntrinsicGetter<number>;
  readonly keyboardCtrl: HandleKeyboardIntrinsicGetter<boolean>;
  readonly keyboardMeta: HandleKeyboardIntrinsicGetter<boolean>;
  readonly keyboardAlt: HandleKeyboardIntrinsicGetter<boolean>;
  readonly keyboardShift: HandleKeyboardIntrinsicGetter<boolean>;
  readonly keyboardRepeat: HandleKeyboardIntrinsicGetter<boolean>;
  readonly keyboardComposing: HandleKeyboardIntrinsicGetter<boolean>;
  readonly activeElement: HandleKeyboardIntrinsicGetter<Element | null>;
  readonly addEventListener: HandleKeyboardIntrinsicMethod<
    readonly [string, EventListener, (boolean | AddEventListenerOptions)?],
    void
  >;
  readonly removeEventListener: HandleKeyboardIntrinsicMethod<
    readonly [string, EventListener, (boolean | EventListenerOptions)?],
    void
  >;
  readonly addWindowEventListener: HandleKeyboardIntrinsicMethod<
    readonly [string, EventListener, (boolean | AddEventListenerOptions)?],
    void
  >;
  readonly removeWindowEventListener: HandleKeyboardIntrinsicMethod<
    readonly [string, EventListener, (boolean | EventListenerOptions)?],
    void
  >;
  readonly isTrusted: {
    readonly matches: (event: object) => boolean;
    readonly read: (event: object) => boolean;
    readonly isCurrent: () => boolean;
  };
  readonly isCurrent: () => boolean;
}

interface HandleKeyboardNativeProof {
  readonly event: KeyboardEvent;
  readonly target: HTMLDivElement | HTMLSpanElement;
  readonly path: readonly EventTarget[];
  readonly type: "keydown";
  readonly bubbles: true;
  readonly cancelable: true;
  readonly composed: true;
  readonly defaultPrevented: false;
  readonly cancelBubble: false;
  readonly timeStamp: number;
  readonly isTrusted: true;
  readonly view: Window | null;
  readonly detail: number;
  readonly key: HandleKeyboardKey;
  readonly code: string;
  readonly location: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: false;
}

interface HandleKeyboardReactMethods {
  readonly preventDefault: HandleKeyboardMethod;
  readonly isDefaultPrevented: HandleKeyboardMethod;
  readonly isPropagationStopped: HandleKeyboardMethod;
}

interface HandleKeyboardReactProof {
  readonly event: ReactKeyboardEvent<HTMLDivElement>;
  readonly nativeEvent: KeyboardEvent;
  readonly target: HTMLDivElement | HTMLSpanElement;
  readonly currentTarget: HTMLDivElement;
  readonly phase: number;
  readonly view: unknown;
  readonly composing: false | null;
  readonly methods: HandleKeyboardReactMethods;
}

interface HandleKeyboardWindowProof {
  readonly event: KeyboardEvent;
  readonly listener: EventListener;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget | null;
  readonly path: readonly EventTarget[];
  readonly addEventListener: HandleKeyboardIntrinsics["addWindowEventListener"];
  readonly removeEventListener: HandleKeyboardIntrinsics["removeWindowEventListener"];
}

interface HandleKeyboardAction extends HandleAction {
  readonly key: HandleKeyboardKey;
  readonly handle: HTMLDivElement;
  readonly width: number;
  readonly min: number;
  readonly max: number;
  readonly defaultWidth: number;
  readonly shiftKey: boolean;
  readonly onResize: HandleAuthority["onResize"];
  readonly onReset: HandleAuthority["onReset"];
  readonly callback: HandleAuthority["onResize"] | HandleAuthority["onReset"];
  readonly reset: boolean;
  readonly next: number | null;
}

interface HandleKeyboardPair {
  readonly native: HandleKeyboardNativeProof;
  readonly action: HandleKeyboardAction;
  capture: HandleKeyboardReactProof | null;
  bubble: HandleKeyboardReactProof | null;
  windowProof: HandleKeyboardWindowProof | null;
  consumed: boolean;
  finalizing: boolean;
}

interface HandleKeyboardRuntime {
  readonly publish: () => boolean;
  readonly release: () => void;
  readonly capture: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly bubble: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

function handleKeyboardDescriptorsMatch(
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

function captureHandleKeyboardIntrinsics(
  ownerWindow: Window & typeof globalThis,
): HandleKeyboardIntrinsics | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const eventConstructor = ownerWindow.Event;
  const uiEventConstructor = ownerWindow.UIEvent;
  const keyboardConstructor = ownerWindow.KeyboardEvent;
  const documentConstructor = ownerWindow.Document;
  const eventTargetConstructor = ownerWindow.EventTarget;
  const eventPrototype = eventConstructor.prototype;
  const uiEventPrototype = uiEventConstructor.prototype;
  const keyboardPrototype = keyboardConstructor.prototype;
  const documentPrototype = documentConstructor.prototype;
  const eventTargetPrototype = eventTargetConstructor.prototype;
  const authorities: Array<{ readonly isCurrent: () => boolean }> = [];
  const prototypeLinks: Array<readonly [object, object | null]> = [];
  const linkedPrototypes = new Set<object>();

  const capturePrototypeChain = (prototype: object) => {
    let current: object | null = prototype;
    while (current && !linkedPrototypes.has(current)) {
      linkedPrototypes.add(current);
      const parent = getPrototypeOf(current) as object | null;
      prototypeLinks.push(Object.freeze([current, parent] as const));
      current = parent;
    }
  };
  capturePrototypeChain(keyboardPrototype);
  capturePrototypeChain(eventPrototype);
  capturePrototypeChain(uiEventPrototype);
  capturePrototypeChain(documentPrototype);
  capturePrototypeChain(eventTargetPrototype);

  const captureGetter = <T,>(
    prototype: object,
    property: PropertyKey,
  ): HandleKeyboardIntrinsicGetter<T> | null => {
    let current: object | null = prototype;
    while (current) {
      const descriptor = getOwnPropertyDescriptor(current, property);
      if (descriptor) {
        if (typeof descriptor.get !== "function") return null;
        const owner = current;
        const expected = Object.freeze({ ...descriptor });
        const getter = descriptor.get;
        const authority = Object.freeze({
          read: (target: object) => apply(getter, target, []) as T,
          isCurrent: () =>
            handleKeyboardDescriptorsMatch(
              getOwnPropertyDescriptor(owner, property),
              expected,
            ),
        });
        authorities.push(authority);
        return authority;
      }
      current = getPrototypeOf(current) as object | null;
    }
    return null;
  };

  const captureMethod = <Args extends readonly unknown[], Result>(
    prototype: object,
    property: PropertyKey,
  ): HandleKeyboardIntrinsicMethod<Args, Result> | null => {
    let current: object | null = prototype;
    while (current) {
      const descriptor = getOwnPropertyDescriptor(current, property);
      if (descriptor) {
        if (typeof descriptor.value !== "function") return null;
        const owner = current;
        const expected = Object.freeze({ ...descriptor });
        const method = descriptor.value as (...args: Args) => Result;
        const authority = Object.freeze({
          call: (target: object, ...args: Args) =>
            apply(method, target, args) as Result,
          isCurrent: () =>
            handleKeyboardDescriptorsMatch(
              getOwnPropertyDescriptor(owner, property),
              expected,
            ),
        });
        authorities.push(authority);
        return authority;
      }
      current = getPrototypeOf(current) as object | null;
    }
    return null;
  };

  const captureCallableProperty = <
    Args extends readonly unknown[],
    Result,
  >(
    target: object,
    property: PropertyKey,
  ): HandleKeyboardIntrinsicMethod<Args, Result> | null => {
    let current: object | null = target;
    while (current) {
      const descriptor = getOwnPropertyDescriptor(current, property);
      if (descriptor) {
        const method = typeof descriptor.value === "function"
          ? descriptor.value
          : typeof descriptor.get === "function"
            ? apply(descriptor.get, target, [])
            : null;
        if (typeof method !== "function") return null;
        const owner = current;
        const expected = Object.freeze({ ...descriptor });
        const authority = Object.freeze({
          call: (receiver: object, ...args: Args) =>
            apply(method as (...values: Args) => Result, receiver, args) as Result,
          isCurrent: () => {
            const currentDescriptor = getOwnPropertyDescriptor(owner, property);
            return (
              handleKeyboardDescriptorsMatch(currentDescriptor, expected) &&
              (
                typeof expected.get !== "function" ||
                apply(expected.get, target, []) === method
              )
            );
          },
        });
        authorities.push(authority);
        return authority;
      }
      current = getPrototypeOf(current) as object | null;
    }
    return null;
  };

  const eventType = captureGetter<string>(eventPrototype, "type");
  const eventTarget = captureGetter<EventTarget | null>(eventPrototype, "target");
  const eventCurrentTarget = captureGetter<EventTarget | null>(
    eventPrototype,
    "currentTarget",
  );
  const eventPhase = captureGetter<number>(eventPrototype, "eventPhase");
  const eventBubbles = captureGetter<boolean>(eventPrototype, "bubbles");
  const eventCancelable = captureGetter<boolean>(eventPrototype, "cancelable");
  const eventDefaultPrevented = captureGetter<boolean>(
    eventPrototype,
    "defaultPrevented",
  );
  const eventCancelBubble = captureGetter<boolean>(
    eventPrototype,
    "cancelBubble",
  );
  const eventComposed = captureGetter<boolean>(eventPrototype, "composed");
  const eventTimeStamp = captureGetter<number>(eventPrototype, "timeStamp");
  const eventPath = captureMethod<readonly [], EventTarget[]>(
    eventPrototype,
    "composedPath",
  );
  const eventView = captureGetter<Window | null>(uiEventPrototype, "view");
  const eventDetail = captureGetter<number>(uiEventPrototype, "detail");
  const keyboardKey = captureGetter<string>(keyboardPrototype, "key");
  const keyboardCode = captureGetter<string>(keyboardPrototype, "code");
  const keyboardLocation = captureGetter<number>(
    keyboardPrototype,
    "location",
  );
  const keyboardCtrl = captureGetter<boolean>(keyboardPrototype, "ctrlKey");
  const keyboardMeta = captureGetter<boolean>(keyboardPrototype, "metaKey");
  const keyboardAlt = captureGetter<boolean>(keyboardPrototype, "altKey");
  const keyboardShift = captureGetter<boolean>(keyboardPrototype, "shiftKey");
  const keyboardRepeat = captureGetter<boolean>(keyboardPrototype, "repeat");
  const keyboardComposing = captureGetter<boolean>(
    keyboardPrototype,
    "isComposing",
  );
  const activeElement = captureGetter<Element | null>(
    documentPrototype,
    "activeElement",
  );
  const addEventListener = captureMethod<
    readonly [string, EventListener, (boolean | AddEventListenerOptions)?],
    void
  >(eventTargetPrototype, "addEventListener");
  const removeEventListener = captureMethod<
    readonly [string, EventListener, (boolean | EventListenerOptions)?],
    void
  >(eventTargetPrototype, "removeEventListener");
  const addWindowEventListener = captureCallableProperty<
    readonly [string, EventListener, (boolean | AddEventListenerOptions)?],
    void
  >(ownerWindow, "addEventListener");
  const removeWindowEventListener = captureCallableProperty<
    readonly [string, EventListener, (boolean | EventListenerOptions)?],
    void
  >(ownerWindow, "removeEventListener");

  let trustProbe: KeyboardEvent;
  try {
    trustProbe = new ownerWindow.KeyboardEvent(
      "panel-resize-keyboard-intrinsic",
    );
  } catch {
    return null;
  }
  const trustDescriptor = getOwnPropertyDescriptor(trustProbe, "isTrusted");
  if (
    !trustDescriptor ||
    trustDescriptor.configurable !== false ||
    typeof trustDescriptor.get !== "function" ||
    trustDescriptor.set !== undefined
  ) {
    return null;
  }
  const expectedTrustDescriptor = Object.freeze({ ...trustDescriptor });
  const isTrusted = Object.freeze({
    matches: (event: object) =>
      handleKeyboardDescriptorsMatch(
        getOwnPropertyDescriptor(event, "isTrusted"),
        expectedTrustDescriptor,
      ),
    read: (event: object) =>
      apply(trustDescriptor.get as (this: object) => boolean, event, []),
    isCurrent: () =>
      handleKeyboardDescriptorsMatch(
        getOwnPropertyDescriptor(trustProbe, "isTrusted"),
        expectedTrustDescriptor,
      ),
  });

  if (
    !eventType ||
    !eventTarget ||
    !eventCurrentTarget ||
    !eventPhase ||
    !eventBubbles ||
    !eventCancelable ||
    !eventDefaultPrevented ||
    !eventCancelBubble ||
    !eventComposed ||
    !eventTimeStamp ||
    !eventPath ||
    !eventView ||
    !eventDetail ||
    !keyboardKey ||
    !keyboardCode ||
    !keyboardLocation ||
    !keyboardCtrl ||
    !keyboardMeta ||
    !keyboardAlt ||
    !keyboardShift ||
    !keyboardRepeat ||
    !keyboardComposing ||
    !activeElement ||
    !addEventListener ||
    !removeEventListener ||
    !addWindowEventListener ||
    !removeWindowEventListener
  ) {
    return null;
  }

  let historyIsClean = true;
  const isCurrent = () => {
    if (!historyIsClean) return false;
    try {
      historyIsClean =
        ownerWindow.Object.getOwnPropertyDescriptor ===
          getOwnPropertyDescriptor &&
        ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
        ownerWindow.Reflect.apply === apply &&
        ownerWindow.Event === eventConstructor &&
        ownerWindow.UIEvent === uiEventConstructor &&
        ownerWindow.KeyboardEvent === keyboardConstructor &&
        ownerWindow.Document === documentConstructor &&
        ownerWindow.EventTarget === eventTargetConstructor &&
        eventConstructor.prototype === eventPrototype &&
        uiEventConstructor.prototype === uiEventPrototype &&
        keyboardConstructor.prototype === keyboardPrototype &&
        documentConstructor.prototype === documentPrototype &&
        eventTargetConstructor.prototype === eventTargetPrototype &&
        prototypeLinks.every(
          ([prototype, parent]) => getPrototypeOf(prototype) === parent,
        ) &&
        isTrusted.isCurrent() &&
        authorities.every((authority) => authority.isCurrent());
    } catch {
      historyIsClean = false;
    }
    return historyIsClean;
  };

  if (!isCurrent()) return null;
  return Object.freeze({
    ownerWindow,
    keyboardPrototype,
    getPrototypeOf,
    apply,
    eventType,
    eventTarget,
    eventCurrentTarget,
    eventPhase,
    eventBubbles,
    eventCancelable,
    eventDefaultPrevented,
    eventCancelBubble,
    eventComposed,
    eventTimeStamp,
    eventPath,
    eventView,
    eventDetail,
    keyboardKey,
    keyboardCode,
    keyboardLocation,
    keyboardCtrl,
    keyboardMeta,
    keyboardAlt,
    keyboardShift,
    keyboardRepeat,
    keyboardComposing,
    activeElement,
    addEventListener,
    removeEventListener,
    addWindowEventListener,
    removeWindowEventListener,
    isTrusted,
    isCurrent,
  });
}

function handleKeyboardPathMatches(
  path: readonly EventTarget[],
  target: EventTarget,
  handle: HTMLDivElement,
  line: HTMLSpanElement,
  placement: HandlePlacement,
  terminal: EventTarget,
) {
  const expected = target === line
    ? [line, ...placement.chain.map(({ node }) => node)]
    : placement.chain.map(({ node }) => node);
  return (
    (target === handle || target === line) &&
    path.length === expected.length + 2 &&
    expected.every((node, index) => path[index] === node) &&
    path[expected.length] === placement.document &&
    handleKeyboardIsOwnerWindow(
      path[expected.length + 1],
      placement.document,
      terminal,
    )
  );
}

function handleKeyboardIsOwnerWindow(
  candidate: unknown,
  ownerDocument: Document,
  expected: unknown,
) {
  if (candidate === expected) return true;
  try {
    return typeof candidate === "object"
      && candidate !== null
      && "document" in candidate
      && candidate.document === ownerDocument
      && "window" in candidate
      && candidate.window === candidate;
  } catch {
    return false;
  }
}

function handleKeyboardNativeIsCurrent(
  proof: HandleKeyboardNativeProof,
  intrinsics: HandleKeyboardIntrinsics,
  placement: HandlePlacement,
  handle: HTMLDivElement,
  line: HTMLSpanElement,
) {
  const event = proof.event;
  try {
    const path = intrinsics.eventPath.call(event);
    return (
      intrinsics.isCurrent() &&
      intrinsics.getPrototypeOf(event) === intrinsics.keyboardPrototype &&
      intrinsics.isTrusted.matches(event) &&
      intrinsics.isTrusted.read(event) === proof.isTrusted &&
      intrinsics.eventType.read(event) === proof.type &&
      intrinsics.eventTarget.read(event) === proof.target &&
      intrinsics.eventBubbles.read(event) === proof.bubbles &&
      intrinsics.eventCancelable.read(event) === proof.cancelable &&
      intrinsics.eventComposed.read(event) === proof.composed &&
      intrinsics.eventTimeStamp.read(event) === proof.timeStamp &&
      Object.is(intrinsics.eventView.read(event), proof.view) &&
      intrinsics.eventDetail.read(event) === proof.detail &&
      intrinsics.keyboardKey.read(event) === proof.key &&
      intrinsics.keyboardCode.read(event) === proof.code &&
      intrinsics.keyboardLocation.read(event) === proof.location &&
      intrinsics.keyboardCtrl.read(event) === proof.ctrlKey &&
      intrinsics.keyboardMeta.read(event) === proof.metaKey &&
      intrinsics.keyboardAlt.read(event) === proof.altKey &&
      intrinsics.keyboardShift.read(event) === proof.shiftKey &&
      intrinsics.keyboardRepeat.read(event) === proof.repeat &&
      intrinsics.keyboardComposing.read(event) === proof.isComposing &&
      path.length === proof.path.length &&
      path.every((entry, index) => entry === proof.path[index]) &&
      handleKeyboardPathMatches(
        path,
        proof.target,
        handle,
        line,
        placement,
        proof.path.at(-1)!,
      )
    );
  } catch {
    return false;
  }
}

function handleKeyboardMethod(value: unknown): value is HandleKeyboardMethod {
  return typeof value === "function";
}

function isHandleKeyboardKey(key: string): key is HandleKeyboardKey {
  return (
    key === "ArrowLeft"
    || key === "ArrowRight"
    || key === "Home"
    || key === "End"
    || key === "Enter"
  );
}

function readHandleKeyboardReactProof(
  event: ReactKeyboardEvent<HTMLDivElement>,
  native: HandleKeyboardNativeProof,
  handle: HTMLDivElement,
  phase: number,
  intrinsics: HandleKeyboardIntrinsics,
  expectedMethods?: HandleKeyboardReactMethods,
): HandleKeyboardReactProof | null {
  try {
    const publicValue = (property: PropertyKey) =>
      (event as unknown as Record<PropertyKey, unknown>)[property];
    const preventDefault = publicValue("preventDefault");
    const isDefaultPrevented = publicValue("isDefaultPrevented");
    const isPropagationStopped = publicValue("isPropagationStopped");
    if (
      !handleKeyboardMethod(preventDefault) ||
      !handleKeyboardMethod(isDefaultPrevented) ||
      !handleKeyboardMethod(isPropagationStopped)
    ) {
      return null;
    }
    const methods = Object.freeze({
      preventDefault,
      isDefaultPrevented,
      isPropagationStopped,
    });
    const composing = publicValue("isComposing");
    const view = publicValue("view");
    if (
      publicValue("type") !== native.type ||
      publicValue("nativeEvent") !== native.event ||
      publicValue("target") !== native.target ||
      publicValue("currentTarget") !== handle ||
      publicValue("eventPhase") !== phase ||
      publicValue("bubbles") !== native.bubbles ||
      publicValue("cancelable") !== native.cancelable ||
      publicValue("defaultPrevented") !== false ||
      publicValue("isTrusted") !== native.isTrusted ||
      publicValue("timeStamp") !== native.timeStamp ||
      publicValue("detail") !== native.detail ||
      publicValue("key") !== native.key ||
      publicValue("code") !== native.code ||
      publicValue("location") !== native.location ||
      publicValue("ctrlKey") !== native.ctrlKey ||
      publicValue("metaKey") !== native.metaKey ||
      publicValue("altKey") !== native.altKey ||
      publicValue("shiftKey") !== native.shiftKey ||
      publicValue("repeat") !== native.repeat ||
      (composing !== undefined && composing !== native.isComposing) ||
      !Object.is(view, native.view) ||
      (
        view !== null &&
        view !== intrinsics.ownerWindow &&
        view !== native.path.at(-1)
      ) ||
      intrinsics.apply(isDefaultPrevented, event, []) !== false ||
      intrinsics.apply(isPropagationStopped, event, []) !== false ||
      (
        expectedMethods &&
        (
          methods.preventDefault !== expectedMethods.preventDefault ||
          methods.isDefaultPrevented !==
            expectedMethods.isDefaultPrevented ||
          methods.isPropagationStopped !==
            expectedMethods.isPropagationStopped
        )
      )
    ) {
      return null;
    }
    return Object.freeze({
      event,
      nativeEvent: native.event,
      target: native.target,
      currentTarget: handle,
      phase,
      view,
      composing: composing === undefined ? null : false,
      methods,
    });
  } catch {
    return null;
  }
}

function handleKeyboardReactProofIsCurrent(
  proof: HandleKeyboardReactProof,
  native: HandleKeyboardNativeProof,
  intrinsics: HandleKeyboardIntrinsics,
  defaultPrevented: boolean,
  currentIsDefaultPrevented: HandleKeyboardMethod,
) {
  try {
    const event = proof.event;
    const publicValue = (property: PropertyKey) =>
      (event as unknown as Record<PropertyKey, unknown>)[property];
    return (
      publicValue("type") === native.type &&
      publicValue("nativeEvent") === native.event &&
      publicValue("target") === native.target &&
      publicValue("currentTarget") === null &&
      publicValue("eventPhase") === proof.phase &&
      publicValue("bubbles") === native.bubbles &&
      publicValue("cancelable") === native.cancelable &&
      publicValue("defaultPrevented") === defaultPrevented &&
      publicValue("isTrusted") === native.isTrusted &&
      publicValue("timeStamp") === native.timeStamp &&
      publicValue("detail") === native.detail &&
      publicValue("key") === native.key &&
      publicValue("code") === native.code &&
      publicValue("location") === native.location &&
      publicValue("ctrlKey") === native.ctrlKey &&
      publicValue("metaKey") === native.metaKey &&
      publicValue("altKey") === native.altKey &&
      publicValue("shiftKey") === native.shiftKey &&
      publicValue("repeat") === native.repeat &&
      (
        proof.composing === null
          ? publicValue("isComposing") === undefined
          : publicValue("isComposing") === native.isComposing
      ) &&
      Object.is(publicValue("view"), proof.view) &&
      Object.is(proof.view, native.view) &&
      publicValue("preventDefault") === proof.methods.preventDefault &&
      publicValue("isDefaultPrevented") === currentIsDefaultPrevented &&
      publicValue("isPropagationStopped") ===
        proof.methods.isPropagationStopped &&
      intrinsics.apply(currentIsDefaultPrevented, event, []) ===
        defaultPrevented &&
      intrinsics.apply(
        proof.methods.isPropagationStopped,
        event,
        [],
      ) === false
    );
  } catch {
    return false;
  }
}

class HandleCoordinator {
  #active: HandlePublication | null = null;
  #successorOf: HandlePublication | null = null;
  #replay: HandleReplay | null = null;
  readonly #claimedActions = new WeakSet<HandleAction>();
  readonly #claimedReactEvents = new WeakSet<object>();
  readonly #claimedNativeEvents = new WeakSet<Event>();
  readonly #claimedWindowProofs = new WeakSet<HandleKeyboardWindowProof>();

  active() {
    return this.#active;
  }

  successorOf() {
    return this.#successorOf;
  }

  replay() {
    return this.#replay;
  }

  publish(publication: HandlePublication) {
    this.#active = publication;
    this.#successorOf = null;
    this.#replay = null;
  }

  retire(publication: HandlePublication) {
    if (this.#active !== publication) return;
    this.#active = null;
    this.#successorOf = publication;
  }

  stageReplay(replay: HandleReplay) {
    if (this.#successorOf !== replay.source) return false;
    this.#replay = replay;
    return true;
  }

  consumeReplay(source: HandlePublication) {
    if (this.#replay?.source === source) this.#replay = null;
    if (this.#successorOf === source) this.#successorOf = null;
  }

  claim(action: HandleAction, reactEvent: object, nativeEvent: Event) {
    if (
      this.#claimedActions.has(action) ||
      this.#claimedReactEvents.has(reactEvent) ||
      this.#claimedNativeEvents.has(nativeEvent)
    ) {
      return false;
    }
    this.#claimedActions.add(action);
    this.#claimedReactEvents.add(reactEvent);
    this.#claimedNativeEvents.add(nativeEvent);
    return true;
  }

  canClaimKeyboard(
    action: HandleKeyboardAction,
    captureEvent: object,
    bubbleEvent: object,
    nativeEvent: Event,
    windowProof: HandleKeyboardWindowProof,
  ) {
    return (
      this.#active === action.publication &&
      captureEvent !== bubbleEvent &&
      !this.#claimedActions.has(action) &&
      !this.#claimedReactEvents.has(captureEvent) &&
      !this.#claimedReactEvents.has(bubbleEvent) &&
      !this.#claimedNativeEvents.has(nativeEvent) &&
      !this.#claimedWindowProofs.has(windowProof)
    );
  }

  claimKeyboard(
    action: HandleKeyboardAction,
    captureEvent: object,
    bubbleEvent: object,
    nativeEvent: Event,
    windowProof: HandleKeyboardWindowProof,
  ) {
    if (
      !this.canClaimKeyboard(
        action,
        captureEvent,
        bubbleEvent,
        nativeEvent,
        windowProof,
      )
    ) {
      return false;
    }
    this.#claimedActions.add(action);
    this.#claimedReactEvents.add(captureEvent);
    this.#claimedReactEvents.add(bubbleEvent);
    this.#claimedNativeEvents.add(nativeEvent);
    this.#claimedWindowProofs.add(windowProof);
    return true;
  }

  retainsKeyboardClaim(
    action: HandleKeyboardAction,
    captureEvent: object,
    bubbleEvent: object,
    nativeEvent: Event,
    windowProof: HandleKeyboardWindowProof,
  ) {
    return (
      this.#claimedActions.has(action) &&
      this.#claimedReactEvents.has(captureEvent) &&
      this.#claimedReactEvents.has(bubbleEvent) &&
      this.#claimedNativeEvents.has(nativeEvent) &&
      this.#claimedWindowProofs.has(windowProof)
    );
  }
}

class HandleElementOwner<T extends HTMLElement> implements HandleElementOwnerView {
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: HandleElementOwnerView,
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

const bodyStyleOwners = new WeakMap<HTMLElement, DragOwner>();

function lineClass(dragging: boolean) {
  return cn(LINE_CLASS, dragging && "w-0.5 bg-accent");
}

function handleAuthoritiesMatch(left: HandleAuthority, right: HandleAuthority) {
  return (
    left.mount === right.mount &&
    Object.is(left.width, right.width) &&
    Object.is(left.min, right.min) &&
    Object.is(left.max, right.max) &&
    left.onResize === right.onResize &&
    left.onReset === right.onReset
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

function snapshotHandleDom(node: Node): HandleDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotHandleDom)),
  });
}

function handleDomMatches(snapshot: HandleDomSnapshot): boolean {
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
        node.childNodes.item(index) === child.node && handleDomMatches(child),
    )
  );
}

function captureHandlePlacement(handle: HTMLDivElement): HandlePlacement | null {
  if (!handle.isConnected) return null;
  const ownerDocument = handle.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const body = ownerDocument.body;
  if (!ownerWindow || !body || body.ownerDocument !== ownerDocument) return null;
  const chain: HandleNodePlacement[] = [];
  let current: Node = handle;
  while (current !== ownerDocument) {
    const parent = current.parentNode;
    if (!parent) return null;
    chain.push(
      Object.freeze({
        node: current,
        parent,
        previousSibling: current.previousSibling,
        nextSibling: current.nextSibling,
      }),
    );
    current = parent;
  }
  if (chain[0]?.node !== handle || !chain.some(({ node }) => node === body)) {
    return null;
  }
  return Object.freeze({
    document: ownerDocument,
    window: ownerWindow,
    body,
    chain: Object.freeze(chain),
  });
}

function handlePlacementMatches(
  handle: HTMLDivElement,
  placement: HandlePlacement,
) {
  return (
    handle.ownerDocument === placement.document &&
    placement.document.defaultView === placement.window &&
    placement.document.body === placement.body &&
    handle.isConnected &&
    placement.chain[0]?.node === handle &&
    placement.chain.every(
      (entry) =>
        entry.node.parentNode === entry.parent &&
        entry.node.previousSibling === entry.previousSibling &&
        entry.node.nextSibling === entry.nextSibling,
    )
  );
}

function placementRecordChanged(
  record: MutationRecord,
  placement: HandleNodePlacement,
) {
  if (record.type !== "childList" || record.target !== placement.parent) {
    return false;
  }
  if (
    record.previousSibling === placement.node ||
    record.nextSibling === placement.node
  ) {
    return true;
  }
  return [...record.addedNodes, ...record.removedNodes].some(
    (node) => node === placement.node || node.contains(placement.node),
  );
}

function createHandleMutationGuard(
  handle: HTMLDivElement,
  line: HTMLSpanElement,
  placement: HandlePlacement,
  onInvalid: () => void,
): HandleMutationGuard | null {
  const MutationObserverConstructor = placement.window.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let clean = true;
  let released = false;
  const expectedBody: ExpectedMutation[] = [];
  const expectedDom: ExpectedMutation[] = [];

  const invalidate = () => {
    if (!clean) return;
    clean = false;
    onInvalid();
  };

  const nextRecordedValue = (
    records: readonly MutationRecord[],
    index: number,
    record: MutationRecord,
  ) => {
    for (let candidate = index + 1; candidate < records.length; candidate++) {
      const next = records[candidate];
      if (
        next?.type === "attributes" &&
        next.target === record.target &&
        next.attributeName === record.attributeName
      ) {
        return next.oldValue;
      }
    }
    return (record.target as Element).getAttribute(record.attributeName ?? "");
  };

  const consumeExpected = (
    queue: ExpectedMutation[],
    records: readonly MutationRecord[],
    index: number,
    record: MutationRecord,
    ordered: boolean,
  ) => {
    const expectedIndex = ordered
      ? 0
      : queue.findIndex(
        (candidate) =>
          candidate.target === record.target &&
          candidate.attributeName === record.attributeName,
      );
    const [expected] = expectedIndex >= 0
      ? queue.splice(expectedIndex, 1)
      : [];
    return Boolean(
      expected &&
        record.type === "attributes" &&
        record.target === expected.target &&
        record.attributeName === expected.attributeName &&
        record.oldValue === expected.oldValue &&
        nextRecordedValue(records, index, record) === expected.nextValue,
    );
  };

  const recordChanges = (records: readonly MutationRecord[]) => {
    if (!clean || records.length === 0) return;
    for (const [index, record] of records.entries()) {
      if (
        record.type === "attributes" &&
        record.target === placement.body &&
        record.attributeName === "style"
      ) {
        if (!consumeExpected(expectedBody, records, index, record, true)) {
          invalidate();
          return;
        }
        continue;
      }
      if (
        record.type === "attributes" &&
        (
          (record.target === handle && record.attributeName === "data-dragging") ||
          (record.target === line && record.attributeName === "class")
        )
      ) {
        if (!consumeExpected(expectedDom, records, index, record, false)) {
          invalidate();
          return;
        }
        continue;
      }
      if (
        record.target === handle ||
        handle.contains(record.target) ||
        placement.chain.some((entry) => placementRecordChanged(record, entry))
      ) {
        invalidate();
        return;
      }
    }
  };

  const observer = new MutationObserverConstructor(recordChanges);
  observer.observe(handle, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  const bodyIsPlacementParent = placement.chain.some(
    ({ parent }) => parent === placement.body,
  );
  observer.observe(placement.body, {
    attributeFilter: ["style"],
    attributeOldValue: true,
    attributes: true,
    childList: bodyIsPlacementParent,
  });
  for (const entry of placement.chain) {
    if (entry.parent !== placement.body) {
      observer.observe(entry.parent, { childList: true });
    }
  }

  const takeRecords = () => {
    if (!released) recordChanges(observer.takeRecords());
    return clean;
  };

  return Object.freeze({
    isClean: takeRecords,
    historyIsClean: () =>
      takeRecords() &&
      expectedBody.length === 0 &&
      expectedDom.length === 0,
    allowAttribute: (
      target: Element,
      attributeName: string,
      nextValue: string | null,
    ) => {
      if (!takeRecords()) return false;
      const oldValue = target.getAttribute(attributeName);
      if (oldValue !== nextValue) {
        expectedDom.push(
          Object.freeze({ target, attributeName, oldValue, nextValue }),
        );
      }
      return true;
    },
    noteBodyStyleWrite: (
      oldValue: string | null,
      nextValue: string | null,
    ) => {
      if (!clean || oldValue === nextValue) return;
      expectedBody.push(
        Object.freeze({
          target: placement.body,
          attributeName: "style",
          oldValue,
          nextValue,
        }),
      );
    },
    release: () => {
      if (released) return;
      recordChanges(observer.takeRecords());
      observer.disconnect();
      released = true;
    },
  });
}

function writeBodyStyle(
  owner: DragOwner,
  property: "cursor" | "userSelect",
  value: string,
) {
  const before = owner.body.getAttribute("style");
  if (owner.body.style[property] === value) return;
  owner.body.style[property] = value;
  owner.runtime.noteBodyStyleWrite(
    before,
    owner.body.getAttribute("style"),
  );
}

function claimBodyStyles(owner: DragOwner) {
  const previousOwner = bodyStyleOwners.get(owner.body);
  if (previousOwner?.ownsBodyStyles) {
    previousOwner.ownsBodyStyles = false;
    owner.bodyCursor = previousOwner.bodyCursor;
    owner.bodyUserSelect = previousOwner.bodyUserSelect;
  } else {
    owner.bodyCursor = owner.body.style.cursor;
    owner.bodyUserSelect = owner.body.style.userSelect;
  }
  owner.ownsBodyStyles = true;
  bodyStyleOwners.set(owner.body, owner);
  writeBodyStyle(owner, "cursor", "col-resize");
  writeBodyStyle(owner, "userSelect", "none");
}

function restoreBodyStyles(owner: DragOwner) {
  if (
    !owner.ownsBodyStyles ||
    bodyStyleOwners.get(owner.body) !== owner
  ) {
    return;
  }
  owner.ownsBodyStyles = false;
  bodyStyleOwners.delete(owner.body);
  if (owner.body.style.cursor === "col-resize") {
    writeBodyStyle(owner, "cursor", owner.bodyCursor);
  }
  if (owner.body.style.userSelect === "none") {
    writeBodyStyle(owner, "userSelect", owner.bodyUserSelect);
  }
}

function createHandleKeyboardRuntime({
  authority,
  runtime,
  handle,
  line,
  placement,
  coordinator,
  isRuntimeOwned,
  isRuntimeCurrent,
  invalidate,
}: {
  authority: HandleAuthority;
  runtime: HandlePublicationRuntime;
  handle: HTMLDivElement;
  line: HTMLSpanElement;
  placement: HandlePlacement;
  coordinator: HandleCoordinator;
  isRuntimeOwned: () => boolean;
  isRuntimeCurrent: () => boolean;
  invalidate: () => void;
}): HandleKeyboardRuntime | null {
  const capturedIntrinsics = captureHandleKeyboardIntrinsics(placement.window);
  if (!capturedIntrinsics) return null;
  const intrinsics = capturedIntrinsics;

  let published = false;
  let released = false;
  let readingReactEvent = false;
  let finalizing = false;
  let nativePairs = new WeakMap<KeyboardEvent, HandleKeyboardPair>();
  let seenNativeEvents = new WeakSet<KeyboardEvent>();
  let activeNativeEvent: WeakRef<KeyboardEvent> | null = null;

  const publicationIsCurrent = () => {
    const current = !released
      && published
      && intrinsics.isCurrent()
      && isRuntimeCurrent();
    if (!current && !released && isRuntimeOwned()) invalidate();
    return current;
  };
  const registrationIsCurrent = () =>
    publicationIsCurrent()
    && placement.document.defaultView === placement.window
    && intrinsics.isCurrent();
  const actionIsCurrent = (action: HandleKeyboardAction) =>
    action.publication === runtime.publication
    && action.handle === handle
    && action.width === authority.width
    && action.min === authority.min
    && action.max === authority.max
    && action.defaultWidth === PANEL_DEFAULT
    && action.onResize === authority.onResize
    && action.onReset === authority.onReset
    && action.callback === (
      action.reset ? authority.onReset : authority.onResize
    )
    && action.reset === (action.key === "Enter")
    && action.next === (
      action.reset
        ? null
        : clampPanelWidth(
          action.key === "Home"
            ? authority.min
            : action.key === "End"
              ? authority.max
              : authority.width + (
                action.key === "ArrowLeft" ? 1 : -1
              ) * (action.shiftKey ? PANEL_BIG_STEP : PANEL_STEP),
          authority.min,
          authority.max,
        )
    );
  const reactFieldsMatch = (
    proof: HandleKeyboardReactProof,
    expectedDefaultPrevented: boolean,
    expectedIsDefaultPrevented: HandleKeyboardMethod,
  ) => {
    const pair = nativePairs.get(proof.nativeEvent);
    return Boolean(
      pair &&
      handleKeyboardReactProofIsCurrent(
        proof,
        pair.native,
        intrinsics,
        expectedDefaultPrevented,
        expectedIsDefaultPrevented,
      ),
    );
  };
  const nativeAtWindow = (
    native: HandleKeyboardNativeProof,
    receiver: unknown,
  ) => {
    try {
      const event = native.event;
      const path = intrinsics.eventPath.call(event);
      const currentTarget = intrinsics.eventCurrentTarget.read(event);
      return (
        receiver === currentTarget
        && receiver === path.at(-1)
        && receiver === native.path.at(-1)
        && intrinsics.eventPhase.read(event)
          === placement.window.Event.BUBBLING_PHASE
        && handleKeyboardPathMatches(
          path,
          native.target,
          handle,
          line,
          placement,
          receiver as EventTarget,
        )
      );
    } catch {
      return false;
    }
  };
  const pairIsCurrent = (
    pair: HandleKeyboardPair,
    windowProof: HandleKeyboardWindowProof,
    beforePrevention: boolean,
  ) => {
    const { native, action, capture, bubble } = pair;
    if (!capture || !bubble) return false;
    try {
      return (
        !released
        && pair.windowProof === windowProof
        && pair.consumed
        && pair.finalizing
        && finalizing
        && activeNativeEvent?.deref() === native.event
        && nativePairs.get(native.event) === pair
        && handleKeyboardNativeIsCurrent(
          native,
          intrinsics,
          placement,
          handle,
          line,
        )
        && nativeAtWindow(native, windowProof.receiver)
        && intrinsics.activeElement.read(placement.document) === handle
        && intrinsics.eventCancelBubble.read(native.event) === false
        && intrinsics.eventDefaultPrevented.read(native.event)
          === !beforePrevention
        && reactFieldsMatch(
          capture,
          false,
          capture.methods.isDefaultPrevented,
        )
        && reactFieldsMatch(
          bubble,
          !beforePrevention,
          beforePrevention
            ? bubble.methods.isDefaultPrevented
            : (
              bubble.event as unknown as Record<PropertyKey, unknown>
            ).isDefaultPrevented as HandleKeyboardMethod
        )
        && capture.event !== bubble.event
        && capture.nativeEvent === native.event
        && bubble.nativeEvent === native.event
        && capture.methods.preventDefault === bubble.methods.preventDefault
        && capture.methods.isDefaultPrevented
          === bubble.methods.isDefaultPrevented
        && capture.methods.isPropagationStopped
          === bubble.methods.isPropagationStopped
        && windowProof.event === native.event
        && windowProof.listener === onWindowBubble
        && windowProof.addEventListener === intrinsics.addWindowEventListener
        && windowProof.removeEventListener
          === intrinsics.removeWindowEventListener
        && windowProof.currentTarget === windowProof.receiver
        && windowProof.path.at(-1) === windowProof.receiver
        && native.path.at(-1) === windowProof.receiver
        && handleKeyboardPathMatches(
          windowProof.path,
          native.target,
          handle,
          line,
          placement,
          windowProof.receiver,
        )
        && actionIsCurrent(action)
        && registrationIsCurrent()
        && coordinator.retainsKeyboardClaim(
          action,
          capture.event,
          bubble.event,
          native.event,
          windowProof,
        )
      );
    } catch {
      return false;
    }
  };
  const pairForReactEvent = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    try {
      const nativeEvent = (
        event as unknown as Record<PropertyKey, unknown>
      ).nativeEvent;
      return typeof nativeEvent === "object" && nativeEvent !== null
        ? nativePairs.get(nativeEvent as KeyboardEvent)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const capture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      readingReactEvent
      || finalizing
      || !event
      || typeof event !== "object"
    ) {
      return;
    }
    readingReactEvent = true;
    try {
      const pair = pairForReactEvent(event);
      if (
        !pair
        || pair.consumed
        || pair.finalizing
        || pair.native.event !== activeNativeEvent?.deref()
        || !publicationIsCurrent()
      ) {
        return;
      }
      const proof = readHandleKeyboardReactProof(
        event,
        pair.native,
        handle,
        placement.window.Event.CAPTURING_PHASE,
        intrinsics,
      );
      if (proof) pair.capture = proof;
    } finally {
      readingReactEvent = false;
    }
  };
  const bubble = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      readingReactEvent
      || finalizing
      || !event
      || typeof event !== "object"
    ) {
      return;
    }
    readingReactEvent = true;
    try {
      const pair = pairForReactEvent(event);
      if (
        !pair
        || !pair.capture
        || pair.consumed
        || pair.finalizing
        || event === pair.capture.event
        || pair.native.event !== activeNativeEvent?.deref()
        || !publicationIsCurrent()
      ) {
        return;
      }
      const proof = readHandleKeyboardReactProof(
        event,
        pair.native,
        handle,
        placement.window.Event.BUBBLING_PHASE,
        intrinsics,
        pair.capture.methods,
      );
      if (proof) pair.bubble = proof;
    } finally {
      readingReactEvent = false;
    }
  };
  const onNativeCapture: EventListener = (event) => {
    if (
      released
      || !published
      || readingReactEvent
      || finalizing
      || event.type !== "keydown"
    ) {
      return;
    }
    try {
      if (
        intrinsics.getPrototypeOf(event) !== intrinsics.keyboardPrototype
        || seenNativeEvents.has(event as KeyboardEvent)
        || activeNativeEvent?.deref()
          && intrinsics.eventPhase.read(activeNativeEvent.deref()!)
            !== placement.window.Event.NONE
        || !publicationIsCurrent()
      ) {
        return;
      }
      const keyboardEvent = event as KeyboardEvent;
      const target = intrinsics.eventTarget.read(event);
      if (target !== handle && target !== line) return;
      const keyboardTarget = target === handle ? handle : line;
      const path = intrinsics.eventPath.call(event);
      const eventType = intrinsics.eventType.read(event);
      const key = intrinsics.keyboardKey.read(keyboardEvent);
      const shiftKey = intrinsics.keyboardShift.read(keyboardEvent);
      const composed = intrinsics.eventComposed.read(event);
      const isComposing = intrinsics.keyboardComposing.read(keyboardEvent);
      if (
        !isHandleKeyboardKey(key)
        || eventType !== "keydown"
        || intrinsics.eventCurrentTarget.read(event) !== placement.document
        || intrinsics.eventPhase.read(event)
          !== placement.window.Event.CAPTURING_PHASE
        || !intrinsics.eventBubbles.read(event)
        || !intrinsics.eventCancelable.read(event)
        || !composed
        || intrinsics.eventDefaultPrevented.read(event)
        || intrinsics.eventCancelBubble.read(event)
        || !intrinsics.isTrusted.matches(event)
        || intrinsics.isTrusted.read(event) !== true
        || isComposing
        || intrinsics.activeElement.read(placement.document) !== handle
        || !handleKeyboardPathMatches(
          path,
          target,
          handle,
          line,
          placement,
          placement.window,
        )
      ) {
        return;
      }
      const view = intrinsics.eventView.read(keyboardEvent);
      if (
        view !== null
        && view !== placement.window
        && view !== path.at(-1)
      ) {
        return;
      }
      const reset = key === "Enter";
      const next = reset
        ? null
        : clampPanelWidth(
          key === "Home"
            ? authority.min
            : key === "End"
              ? authority.max
              : authority.width + (
                key === "ArrowLeft" ? 1 : -1
              ) * (shiftKey ? PANEL_BIG_STEP : PANEL_STEP),
          authority.min,
          authority.max,
        );
      const action: HandleKeyboardAction = Object.freeze({
        identity: Symbol(`keydown:${key}`),
        publication: runtime.publication,
        handle,
        kind: `keydown:${key}`,
        key,
        width: authority.width,
        min: authority.min,
        max: authority.max,
        defaultWidth: PANEL_DEFAULT,
        shiftKey,
        onResize: authority.onResize,
        onReset: authority.onReset,
        callback: reset ? authority.onReset : authority.onResize,
        reset,
        next,
      });
      const native = Object.freeze({
        event: keyboardEvent,
        target: keyboardTarget,
        path: Object.freeze([...path]),
        type: "keydown",
        bubbles: true,
        cancelable: true,
        composed: true,
        defaultPrevented: false,
        cancelBubble: false,
        isTrusted: true,
        timeStamp: intrinsics.eventTimeStamp.read(event),
        view,
        detail: intrinsics.eventDetail.read(keyboardEvent),
        key,
        code: intrinsics.keyboardCode.read(keyboardEvent),
        location: intrinsics.keyboardLocation.read(keyboardEvent),
        ctrlKey: intrinsics.keyboardCtrl.read(keyboardEvent),
        metaKey: intrinsics.keyboardMeta.read(keyboardEvent),
        altKey: intrinsics.keyboardAlt.read(keyboardEvent),
        shiftKey,
        repeat: intrinsics.keyboardRepeat.read(keyboardEvent),
        isComposing: false,
      }) satisfies HandleKeyboardNativeProof;
      if (
        native.type !== "keydown"
        || !handleKeyboardNativeIsCurrent(
          native,
          intrinsics,
          placement,
          handle,
          line,
        )
      ) {
        return;
      }
      const pair: HandleKeyboardPair = {
        native,
        action,
        capture: null,
        bubble: null,
        windowProof: null,
        consumed: false,
        finalizing: false,
      };
      seenNativeEvents.add(keyboardEvent);
      nativePairs.set(keyboardEvent, pair);
      activeNativeEvent = new WeakRef(keyboardEvent);
    } catch {
      return;
    }
  };
  function onWindowBubble(this: Window, event: Event) {
    if (
      released
      || !published
      || readingReactEvent
      || finalizing
      || event.type !== "keydown"
    ) {
      return;
    }
    const pair = nativePairs.get(event as KeyboardEvent);
    if (
      !pair
      || pair.native.event !== event
      || !pair.capture
      || !pair.bubble
      || pair.windowProof
      || pair.consumed
      || pair.finalizing
    ) {
      return;
    }
    try {
      const path = intrinsics.eventPath.call(event);
      const currentTarget = intrinsics.eventCurrentTarget.read(event);
      const proof = Object.freeze({
        event: event as KeyboardEvent,
        receiver: this as Window & typeof globalThis,
        currentTarget,
        path: Object.freeze([...path]),
        listener: onWindowBubble,
        addEventListener: intrinsics.addWindowEventListener,
        removeEventListener: intrinsics.removeWindowEventListener,
      });
      pair.windowProof = proof;
      const { native, action, capture, bubble } = pair;
      if (
        this !== currentTarget
        || this !== path.at(-1)
        || this !== native.path.at(-1)
        || !nativeAtWindow(native, this)
        || intrinsics.eventDefaultPrevented.read(event)
        || intrinsics.eventCancelBubble.read(event)
        || !handleKeyboardNativeIsCurrent(
          native,
          intrinsics,
          placement,
          handle,
          line,
        )
        || !reactFieldsMatch(
          capture,
          false,
          capture.methods.isDefaultPrevented,
        )
        || !reactFieldsMatch(
          bubble,
          false,
          bubble.methods.isDefaultPrevented,
        )
        || !publicationIsCurrent()
        || !actionIsCurrent(action)
        || !registrationIsCurrent()
        || !coordinator.canClaimKeyboard(
          action,
          capture.event,
          bubble.event,
          native.event,
          proof,
        )
        || !coordinator.claimKeyboard(
          action,
          capture.event,
          bubble.event,
          native.event,
          proof,
        )
      ) {
        pair.windowProof = null;
        return;
      }
      pair.consumed = true;
      pair.finalizing = true;
      finalizing = true;
      if (!pairIsCurrent(pair, proof, true)) return;
      intrinsics.apply(
        bubble.methods.preventDefault,
        bubble.event,
        [],
      );
      const currentIsDefaultPrevented = (
        bubble.event as unknown as Record<PropertyKey, unknown>
      ).isDefaultPrevented;
      if (
        !handleKeyboardMethod(currentIsDefaultPrevented)
        || currentIsDefaultPrevented
          === bubble.methods.isDefaultPrevented
        || intrinsics.apply(
          currentIsDefaultPrevented,
          bubble.event,
          [],
        ) !== true
        || intrinsics.apply(
          capture.methods.isDefaultPrevented,
          capture.event,
          [],
        ) !== false
        || intrinsics.apply(
          capture.methods.isPropagationStopped,
          capture.event,
          [],
        ) !== false
        || intrinsics.apply(
          bubble.methods.isPropagationStopped,
          bubble.event,
          [],
        ) !== false
        || !pairIsCurrent(pair, proof, false)
      ) {
        return;
      }
      if (action.reset) action.onReset();
      else if (action.next !== null) action.onResize(action.next);
    } finally {
      if (pair.consumed) {
        finalizing = false;
        pair.finalizing = false;
        if (nativePairs.get(pair.native.event) === pair) {
          nativePairs.delete(pair.native.event);
        }
        if (activeNativeEvent?.deref() === pair.native.event) {
          activeNativeEvent = null;
        }
      } else {
        pair.windowProof = null;
      }
    }
  }
  const publish = () => {
    if (
      published
      || released
      || !intrinsics.isCurrent()
      || !isRuntimeCurrent()
    ) {
      return false;
    }
    try {
      intrinsics.addEventListener.call(
        placement.document,
        "keydown",
        onNativeCapture,
        true,
      );
      intrinsics.addWindowEventListener.call(
        placement.window,
        "keydown",
        onWindowBubble,
      );
      published = true;
      if (registrationIsCurrent()) return true;
    } catch {
      // Release below uses the retained registration methods.
    }
    released = true;
    try {
      intrinsics.removeEventListener.call(
        placement.document,
        "keydown",
        onNativeCapture,
        true,
      );
    } finally {
      intrinsics.removeWindowEventListener.call(
        placement.window,
        "keydown",
        onWindowBubble,
      );
    }
    return false;
  };
  const release = () => {
    if (released) return;
    released = true;
    nativePairs = new WeakMap<KeyboardEvent, HandleKeyboardPair>();
    seenNativeEvents = new WeakSet<KeyboardEvent>();
    activeNativeEvent = null;
    if (!published) return;
    try {
      intrinsics.removeEventListener.call(
        placement.document,
        "keydown",
        onNativeCapture,
        true,
      );
    } finally {
      intrinsics.removeWindowEventListener.call(
        placement.window,
        "keydown",
        onWindowBubble,
      );
    }
  };

  return Object.freeze({ publish, release, capture, bubble });
}

function createHandlePublication(
  authority: HandleAuthority,
  coordinator: HandleCoordinator,
  setDragging: (dragging: boolean) => void,
  setPinnedPublication: (
    publication: HandlePublicationSet | null,
  ) => void,
  requestSuccessor: () => void,
): HandlePublicationSet {
  let currentRuntime: HandlePublicationRuntime | null = null;
  let lastRuntime: HandlePublicationRuntime | null = null;
  let successorRequested = false;

  const requestReplaySuccessor = (runtime: HandlePublicationRuntime) => {
    const replay = runtime.replay();
    if (
      successorRequested ||
      !replay ||
      coordinator.successorOf() !== runtime.publication ||
      !runtime.publishedDomMatches()
    ) {
      return;
    }
    successorRequested = true;
    if (!coordinator.stageReplay(replay)) return;
    requestSuccessor();
  };

  const onElementChange = (
    owner: HandleElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null || (element && last && element !== last)) {
      currentRuntime?.retireForElement();
    }
    if (
      runtime?.isExactElementReplay() &&
      coordinator.successorOf() === runtime.publication
    ) {
      requestReplaySuccessor(runtime);
    }
  };

  const handleOwner = new HandleElementOwner<HTMLDivElement>(onElementChange);
  const lineOwner = new HandleElementOwner<HTMLSpanElement>(onElementChange);

  const exactDomIsCurrent = (dragging: boolean) => {
    const handle = handleOwner.element();
    const line = lineOwner.element();
    if (
      !handle ||
      !line ||
      !handle.isConnected ||
      handle.tagName !== "DIV" ||
      handle.getAttribute("role") !== "separator" ||
      handle.getAttribute("aria-orientation") !== "vertical" ||
      handle.getAttribute("aria-label") !== "Resize panel" ||
      handle.getAttribute("aria-valuemin") !== String(authority.min) ||
      handle.getAttribute("aria-valuemax") !== String(authority.max) ||
      handle.getAttribute("aria-valuenow") !== String(authority.width) ||
      handle.getAttribute("aria-valuetext") !== `${authority.width} pixels` ||
      handle.tabIndex !== 0 ||
      handle.dataset.testid !== "panel-resize-handle" ||
      handle.getAttribute("data-dragging") !== (dragging ? "true" : null) ||
      handle.className !== HANDLE_CLASS ||
      handle.childNodes.length !== 1 ||
      handle.firstChild !== line ||
      line.parentElement !== handle ||
      line.tagName !== "SPAN" ||
      line.getAttribute("aria-hidden") !== "true" ||
      line.className !== lineClass(dragging) ||
      line.childNodes.length !== 0
    ) {
      return false;
    }
    const placement = captureHandlePlacement(handle);
    return Boolean(
      placement &&
        line.ownerDocument === placement.document &&
        line.isConnected,
    );
  };

  const ownsRuntime = (runtime: HandlePublicationRuntime) =>
    currentRuntime === runtime &&
    coordinator.active() === runtime.publication &&
    !runtime.publication.isRetired() &&
    runtime.publication.authority === authority &&
    runtime.publishedDomMatches();

  const createRuntime = (): HandlePublicationRuntime | null => {
    type Retirement = "element" | "layout" | "mutation" | "other";
    const handle = handleOwner.element();
    const line = lineOwner.element();
    const placement = handle ? captureHandlePlacement(handle) : null;
    if (!handle || !line || !placement) return null;
    const dom = snapshotHandleDom(handle);
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let invalidReplay = false;
    let expectedDragging = false;
    let drag: DragOwner | null = null;
    let replayRefs: HandleRefReplay[] = [];
    let guard: HandleMutationGuard | null = null;
    let keyboardRuntime: HandleKeyboardRuntime | null = null;
    let retireForMutation = () => {};

    const publishedDomMatches = () =>
      Boolean(
        guard?.isClean() &&
          handleOwner.element() === handle &&
          lineOwner.element() === line &&
          handlePlacementMatches(handle, placement) &&
          exactDomIsCurrent(expectedDragging),
      );

    const releaseCapture = (owner: DragOwner) => {
      if (!owner.captureHeld) return;
      owner.captureHeld = false;
      if (!owner.releasePointerCapture) return;
      try {
        owner.releasePointerCapture.call(owner.target, owner.pointerId);
      } catch {
        // The browser may already have released capture while cancelling the pointer.
      }
    };

    const finishDrag = (owner: DragOwner, captureAlreadyLost = false) => {
      if (!owner.active || drag !== owner) return;
      owner.active = false;
      drag = null;
      setPinnedPublication(null);
      if (captureAlreadyLost) owner.captureHeld = false;
      releaseCapture(owner);
      restoreBodyStyles(owner);
      if (guard?.isClean() && exactDomIsCurrent(expectedDragging)) {
        guard.allowAttribute(
          handle,
          "data-dragging",
          null,
        );
        guard.allowAttribute(line, "class", lineClass(false));
      }
      expectedDragging = false;
      setDragging(false);
    };

    const retire = (reason: Retirement) => {
      if (retired) return false;
      retired = true;
      retirement = reason;
      keyboardRuntime?.release();
      keyboardRuntime = null;
      coordinator.retire(publication);
      if (drag) finishDrag(drag);
      if (currentRuntime?.publication === publication) currentRuntime = null;
      queueMicrotask(() => {
        if (coordinator.replay()?.source !== publication) guard?.release();
      });
      return true;
    };

    const publication: HandlePublication = Object.freeze({
      identity: Symbol("panel-resize-publication"),
      authority,
      activeDrag: () => drag?.active ? drag : null,
      isRetired: () => retired,
      retire: () => retire("other"),
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

    const runtime: HandlePublicationRuntime = Object.freeze({
      publication,
      publish: () => {
        established = true;
        replayRefs = [handleOwner, lineOwner].map((owner) => {
          const element = owner.element();
          if (!element) {
            throw new Error(
              "Cannot publish PanelResizeHandle without every committed ref",
            );
          }
          return { owner, element, detached: false, reattached: false };
        });
        guard = createHandleMutationGuard(
          handle,
          line,
          placement,
          () => retireForMutation(),
        );
        if (!guard) return false;
        retireForMutation = () => {
          retire("mutation");
        };
        coordinator.publish(publication);
        keyboardRuntime = createHandleKeyboardRuntime({
          authority,
          runtime,
          handle,
          line,
          placement,
          coordinator,
          isRuntimeOwned: () =>
            currentRuntime === runtime &&
            coordinator.active() === publication &&
            !retired,
          isRuntimeCurrent: () => ownsRuntime(runtime),
          invalidate: () => {
            if (retire("other")) requestSuccessor();
          },
        });
        if (keyboardRuntime && !keyboardRuntime.publish()) {
          keyboardRuntime.release();
          keyboardRuntime = null;
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
        owner: HandleElementOwnerView,
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
      isExactElementReplay: () =>
        retired &&
        (retirement === "element" || retirement === "layout") &&
        established &&
        refsHaveExactReplay() &&
        publishedDomMatches(),
      isExactLayoutReplay: () =>
        retired &&
        retirement === "layout" &&
        established &&
        (refsHaveNoReplay() || refsHaveExactReplay()) &&
        publishedDomMatches(),
      publishedDomMatches,
      replay: () =>
        guard
          ? Object.freeze({
              source: publication,
              dom,
              placement,
              historyIsClean: guard.historyIsClean,
              release: guard.release,
            })
          : null,
      beginDrag: (owner: DragOwner) => {
        if (drag || retired) return false;
        drag = owner;
        setPinnedPublication(publicationSet);
        return true;
      },
      drag: () => drag?.active ? drag : null,
      finishDrag,
      allowDraggingState: (draggingState: boolean) => {
        if (
          retired ||
          !guard?.isClean() ||
          !exactDomIsCurrent(expectedDragging)
        ) {
          return false;
        }
        guard.allowAttribute(
          handle,
          "data-dragging",
          draggingState ? "true" : null,
        );
        guard.allowAttribute(line, "class", lineClass(draggingState));
        expectedDragging = draggingState;
        return true;
      },
      noteBodyStyleWrite: (
        oldValue: string | null,
        nextValue: string | null,
      ) => {
        guard?.noteBodyStyleWrite(oldValue, nextValue);
      },
      captureKeyboard: (event: ReactKeyboardEvent<HTMLDivElement>) => {
        keyboardRuntime?.capture(event);
      },
      bubbleKeyboard: (event: ReactKeyboardEvent<HTMLDivElement>) => {
        keyboardRuntime?.bubble(event);
      },
    });
    return runtime;
  };

  const nativeReactEvent = (
    runtime: HandlePublicationRuntime,
    event: SyntheticEvent<HTMLDivElement, Event>,
    reactName: string,
    nativeType: string,
    nativeKind: "pointer" | "mouse",
  ): Event | null => {
    const handle = handleOwner.element();
    const line = lineOwner.element();
    if (!handle || !line || !event || typeof event !== "object") return null;
    const placement = captureHandlePlacement(handle);
    const ownerWindow = placement?.window;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    const proof = event as ReactEventProof;
    const prototype = Object.getPrototypeOf(event);
    if (
      !placement ||
      !ownerWindow ||
      !prototype ||
      prototype === Object.prototype ||
      prototype === ownerWindow.Object.prototype ||
      (
        nativeKind === "pointer"
          ? !(nativeEvent instanceof ownerWindow.PointerEvent)
          : !(nativeEvent instanceof ownerWindow.MouseEvent)
      ) ||
      nativeEvent.type !== nativeType ||
      event.type !== nativeType ||
      nativeEvent.eventPhase === ownerWindow.Event.NONE ||
      event.eventPhase !== nativeEvent.eventPhase ||
      event.currentTarget !== handle ||
      nativeEvent.target !== target ||
      !(target instanceof ownerWindow.Node) ||
      target.ownerDocument !== placement.document ||
      (target !== handle && target !== line) ||
      event.bubbles !== nativeEvent.bubbles ||
      event.cancelable !== nativeEvent.cancelable ||
      event.defaultPrevented ||
      nativeEvent.defaultPrevented ||
      event.isTrusted !== nativeEvent.isTrusted ||
      event.timeStamp !== nativeEvent.timeStamp ||
      proof._reactName !== reactName ||
      typeof proof.isDefaultPrevented !== "function" ||
      proof.isDefaultPrevented() ||
      typeof proof.isPropagationStopped !== "function" ||
      proof.isPropagationStopped() ||
      typeof proof.isPersistent !== "function" ||
      !proof.isPersistent() ||
      typeof proof.persist !== "function" ||
      typeof event.preventDefault !== "function" ||
      typeof event.stopPropagation !== "function" ||
      !ownsRuntime(runtime)
    ) {
      return null;
    }

    const path = nativeEvent.composedPath();
    const expectedPath = target === line
      ? [line, ...placement.chain.map(({ node }) => node)]
      : placement.chain.map(({ node }) => node);
    const pathWindow = path[expectedPath.length + 1];
    if (
      !nativeEvent.composed ||
      path.length !== expectedPath.length + 2 ||
      expectedPath.some((node, index) => path[index] !== node) ||
      path[expectedPath.length] !== placement.document ||
      (
        pathWindow !== ownerWindow &&
        (
          !(pathWindow instanceof ownerWindow.Window) ||
          pathWindow.document !== placement.document
        )
      ) ||
      !nativeEvent.currentTarget ||
      !path.includes(nativeEvent.currentTarget)
    ) {
      return null;
    }
    return nativeEvent;
  };

  const claimAction = (
    runtime: HandlePublicationRuntime,
    action: HandleAction,
    event: object,
    nativeEvent: Event,
  ) => {
    if (
      action.publication !== runtime.publication ||
      !ownsRuntime(runtime)
    ) {
      return false;
    }
    return coordinator.claim(action, event, nativeEvent);
  };

  const pointerEvent = (
    runtime: HandlePublicationRuntime,
    event: ReactPointerEvent<HTMLDivElement>,
    reactName: string,
    nativeType: string,
  ) => {
    const nativeEvent = nativeReactEvent(
      runtime,
      event,
      reactName,
      nativeType,
      "pointer",
    );
    if (!(nativeEvent instanceof event.currentTarget.ownerDocument.defaultView!.PointerEvent)) {
      return null;
    }
    if (
      event.pointerId !== nativeEvent.pointerId ||
      event.pointerType !== nativeEvent.pointerType ||
      event.button !== nativeEvent.button ||
      event.buttons !== nativeEvent.buttons ||
      event.clientX !== nativeEvent.clientX ||
      event.ctrlKey !== nativeEvent.ctrlKey ||
      event.shiftKey !== nativeEvent.shiftKey ||
      event.altKey !== nativeEvent.altKey ||
      event.metaKey !== nativeEvent.metaKey ||
      event.isPrimary !== nativeEvent.isPrimary ||
      !Number.isInteger(nativeEvent.pointerId) ||
      !Number.isFinite(nativeEvent.clientX)
    ) {
      return null;
    }
    return nativeEvent;
  };

  const claimPointerDragEvent = (
    event: ReactPointerEvent<HTMLDivElement>,
    reactName: string,
    nativeType: string,
  ) => {
    const runtime = currentRuntime;
    const owner = runtime?.drag();
    if (!runtime || !owner) return null;
    const nativeEvent = pointerEvent(runtime, event, reactName, nativeType);
    if (
      !nativeEvent ||
      event.currentTarget !== owner.target ||
      nativeEvent.pointerId !== owner.pointerId ||
      nativeEvent.pointerType !== owner.pointerType ||
      (
        nativeType === "pointermove"
          ? (nativeEvent.buttons & 1) !== 1 ||
            (nativeEvent.button !== -1 && nativeEvent.button !== owner.button)
          : nativeType === "pointerup"
            ? nativeEvent.button !== owner.button || nativeEvent.buttons !== 0
            : nativeEvent.buttons !== 0 ||
              (nativeEvent.button !== -1 && nativeEvent.button !== owner.button)
      )
    ) {
      return null;
    }
    const action: HandleAction = Object.freeze({
      identity: Symbol(nativeType),
      kind: nativeType,
      publication: runtime.publication,
    });
    if (!claimAction(runtime, action, event, nativeEvent)) return null;
    owner.sequence += 1;
    return { runtime, owner, nativeEvent };
  };

  const establish = () => {
    if (lastRuntime) {
      if (
        (
          lastRuntime.isExactLayoutReplay() ||
          lastRuntime.isExactElementReplay()
        ) &&
        coordinator.successorOf() === lastRuntime.publication
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (!exactDomIsCurrent(false)) return undefined;
    const handle = handleOwner.element();
    const placement = handle ? captureHandlePlacement(handle) : null;
    if (!handle || !placement) return undefined;

    const replay = coordinator.replay();
    if (replay) {
      const sameAuthority = handleAuthoritiesMatch(
        replay.source.authority,
        authority,
      );
      const exactReplay =
        sameAuthority &&
        replay.source.isRetired() &&
        coordinator.successorOf() === replay.source &&
        replay.historyIsClean() &&
        handle === replay.dom.node &&
        handlePlacementMatches(handle, replay.placement) &&
        handleDomMatches(replay.dom);
      replay.release();
      coordinator.consumeReplay(replay.source);
      if (sameAuthority && !exactReplay) return undefined;
    }

    const runtime = createRuntime();
    if (!runtime) return undefined;
    const previous = coordinator.active();
    if (previous && previous !== runtime.publication) previous.retire();
    currentRuntime = runtime;
    lastRuntime = runtime;
    if (!runtime.publish()) {
      runtime.retireForElement();
      currentRuntime = null;
      return undefined;
    }
    return runtime.retireForLayout;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const runtime = currentRuntime;
    if (!runtime || runtime.drag()) return;
    const nativeEvent = pointerEvent(
      runtime,
      event,
      "onPointerDown",
      "pointerdown",
    );
    if (
      !nativeEvent ||
      !["mouse", "pen", "touch"].includes(nativeEvent.pointerType) ||
      nativeEvent.button !== 0 ||
      (nativeEvent.buttons & 1) !== 1
    ) {
      return;
    }
    const action: HandleAction = Object.freeze({
      identity: Symbol("pointerdown"),
      kind: "pointerdown",
      publication: runtime.publication,
    });
    if (!claimAction(runtime, action, event, nativeEvent)) return;

    const target = event.currentTarget;
    const setCapture = typeof target.setPointerCapture === "function"
      ? target.setPointerCapture
      : null;
    const releaseCapture = typeof target.releasePointerCapture === "function"
      ? target.releasePointerCapture
      : null;
    const owner: DragOwner = {
      active: true,
      publication: runtime.publication,
      runtime,
      pointerId: nativeEvent.pointerId,
      pointerType: nativeEvent.pointerType,
      button: nativeEvent.button,
      startX: nativeEvent.clientX,
      startWidth: authority.width,
      target,
      onResize: authority.onResize,
      min: authority.min,
      max: authority.max,
      body: target.ownerDocument.body,
      setPointerCapture: setCapture,
      releasePointerCapture: releaseCapture,
      captureHeld: false,
      bodyCursor: "",
      bodyUserSelect: "",
      ownsBodyStyles: false,
      sequence: 0,
    };
    if (!runtime.beginDrag(owner)) return;
    claimBodyStyles(owner);
    if (owner.setPointerCapture) {
      try {
        owner.setPointerCapture.call(owner.target, owner.pointerId);
        if (owner.active) owner.captureHeld = true;
      } catch {
        // Pointer capture is best-effort; moves over the separator still resize.
      }
    }
    if (!owner.active || !runtime.allowDraggingState(true)) {
      runtime.finishDrag(owner);
      return;
    }
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const claim = claimPointerDragEvent(
      event,
      "onPointerMove",
      "pointermove",
    );
    if (!claim) return;
    const { owner, nativeEvent } = claim;
    owner.onResize(
      clampPanelWidth(
        owner.startWidth + (owner.startX - nativeEvent.clientX),
        owner.min,
        owner.max,
      ),
    );
  };

  const endDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    reactName: string,
    nativeType: string,
  ) => {
    const claim = claimPointerDragEvent(event, reactName, nativeType);
    if (!claim) return;
    claim.runtime.finishDrag(
      claim.owner,
      nativeType === "lostpointercapture",
    );
    requestSuccessor();
  };

  const onKeyDownCapture = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    currentRuntime?.captureKeyboard(event);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    currentRuntime?.bubbleKeyboard(event);
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const runtime = currentRuntime;
    if (!runtime) return;
    const nativeEvent = nativeReactEvent(
      runtime,
      event,
      "onDoubleClick",
      "dblclick",
      "mouse",
    );
    const ownerWindow = event.currentTarget.ownerDocument.defaultView;
    if (
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      nativeEvent.button !== 0 ||
      nativeEvent.buttons !== 0 ||
      nativeEvent.detail !== 2 ||
      event.button !== nativeEvent.button ||
      event.buttons !== nativeEvent.buttons ||
      event.detail !== nativeEvent.detail ||
      event.ctrlKey !== nativeEvent.ctrlKey ||
      event.shiftKey !== nativeEvent.shiftKey ||
      event.altKey !== nativeEvent.altKey ||
      event.metaKey !== nativeEvent.metaKey
    ) {
      return;
    }
    const action: HandleAction = Object.freeze({
      identity: Symbol("double-click"),
      kind: "double-click",
      publication: runtime.publication,
    });
    if (!claimAction(runtime, action, event, nativeEvent)) return;
    authority.onReset();
  };

  const publicationSet: HandlePublicationSet = Object.freeze({
    authority,
    captureHandle: handleOwner.capture,
    captureLine: lineOwner.capture,
    establish,
    onPointerDown,
    onPointerMove,
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) =>
      endDrag(event, "onPointerUp", "pointerup"),
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) =>
      endDrag(event, "onPointerCancel", "pointercancel"),
    onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) =>
      endDrag(
        event,
        "onLostPointerCapture",
        "lostpointercapture",
      ),
    onKeyDownCapture,
    onKeyDown,
    onDoubleClick,
  });
  return publicationSet;
}

function PublishedPanelResizeHandle({
  publication,
  dragging,
}: {
  publication: HandlePublicationSet;
  dragging: boolean;
}) {
  const {
    authority,
    captureHandle,
    captureLine,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture,
    onDoubleClick,
    onKeyDownCapture,
    onKeyDown,
  } = publication;
  const { width, min, max } = authority;
  return (
    <div
      ref={captureHandle}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      tabIndex={0}
      data-testid="panel-resize-handle"
      data-dragging={dragging || undefined}
      className={HANDLE_CLASS}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onDoubleClick={onDoubleClick}
      onKeyDownCapture={onKeyDownCapture}
      onKeyDown={onKeyDown}
    >
      <span
        ref={captureLine}
        aria-hidden
        className={lineClass(dragging)}
      />
    </div>
  );
}

/**
 * Thin vertical grip laid over the side panel's left border. Dragging it left widens the panel
 * (the panel sits on the right, so its left edge moves with the pointer); arrow keys nudge it,
 * Home/End jump to the limits and Enter or a double-click puts the default width back.
 */
export function PanelResizeHandle({
  width,
  min,
  max,
  onResize,
  onReset,
}: PanelResizeHandleProps) {
  const [mount] = useState(() => Symbol("panel-resize-handle"));
  const [coordinator] = useState(() => new HandleCoordinator());
  const [dragging, setDragging] = useState(false);
  const [pinnedPublication, setPinnedPublication] =
    useState<HandlePublicationSet | null>(null);
  const [publicationRevision, setPublicationRevision] = useState(0);
  const requestSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);

  void publicationRevision;
  const publication =
    pinnedPublication ??
    createHandlePublication(
      Object.freeze({
        mount,
        width,
        min,
        max,
        onResize,
        onReset,
      }),
      coordinator,
      setDragging,
      setPinnedPublication,
      requestSuccessor,
    );

  useLayoutEffect(() => publication.establish(), [publication]);

  return (
    <PublishedPanelResizeHandle
      publication={publication}
      dragging={dragging}
    />
  );
}
