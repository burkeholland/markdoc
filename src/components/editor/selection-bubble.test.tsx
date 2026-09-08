// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useLayoutEffect, type ComponentProps, type SetStateAction } from "react";
import { EditorState, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import type * as Y from "yjs";
import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import { SUGGESTIONS_ORIGIN } from "@/editor/collab/suggestions";
import { schema } from "@/editor/markdown/schema";
import { createRichEditorState } from "@/editor/prosemirror/setup";
import { EditorActions, EMPTY_FORMAT } from "./actions";
import { SelectionBubble } from "./selection-bubble";

const screen = within(document.documentElement);
type SelectionBubbleProps = ComponentProps<typeof SelectionBubble>;
type CapturedMouseEvent = {
  currentTarget: EventTarget | null;
  preventDefault: ReturnType<typeof vi.fn>;
};
type MouseHandler = (event: CapturedMouseEvent) => void;
type ElementRef<T extends HTMLElement> = (element: T | null) => void | (() => void);
type ButtonRef = ElementRef<HTMLButtonElement>;
const TOOLBAR_LABELS = ["Bold", "Italic", "Strikethrough", "Inline code", "Link", "Comment"] as const;

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  return {
    HocuspocusProvider: class {
      awareness: InstanceType<typeof Awareness>;
      constructor(options: { document: Y.Doc }) { this.awareness = new Awareness(options.document); }
      destroy() { this.awareness.destroy(); }
    },
  };
});
const stateWrites = vi.hoisted(() => ({ count: 0 }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState<T>(initial: T | (() => T)) {
      const [value, setValue] = react.useState(initial);
      const set = react.useCallback((next: SetStateAction<T>) => {
        stateWrites.count++;
        setValue(next);
      }, [setValue]);
      return [value, set] as const;
    },
  };
});

const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
const originalFullscreen = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
const originalShowPopover = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "showPopover");
const originalHidePopover = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hidePopover");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [target, key, descriptor] of [
    [Range.prototype, "getClientRects", originalRangeRects],
    [document, "fonts", originalFonts],
    [window, "visualViewport", originalVisualViewport],
    [document, "fullscreenElement", originalFullscreen],
    [HTMLElement.prototype, "showPopover", originalShowPopover],
    [HTMLElement.prototype, "hidePopover", originalHidePopover],
  ] as const) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
  document.body.replaceChildren();
  document.body.removeAttribute("style");
});

function environment({ resize = true, popover = false } = {}) {
  let nextFrame = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const capturedFrames: FrameRequestCallback[] = [];
  const request = vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    capturedFrames.push(callback);
    return id;
  });
  const cancel = vi.fn((id: number) => frames.delete(id));
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  const flush = () => act(() => {
    const pending = [...frames];
    frames.clear();
    for (const [, callback] of pending) callback(0);
  });

  const resizes: TestResizeObserver[] = [];
  class TestResizeObserver implements ResizeObserver {
    targets = new Set<Element>();
    observe = vi.fn((target: Element) => { this.targets.add(target); });
    unobserve = vi.fn((target: Element) => { this.targets.delete(target); });
    disconnect = vi.fn(() => { this.targets.clear(); });
    constructor(readonly callback: ResizeObserverCallback) { resizes.push(this); }
    fire() { this.callback([], this); }
  }
  vi.stubGlobal("ResizeObserver", resize ? TestResizeObserver : undefined);
  const mutations: TestMutationObserver[] = [];
  class TestMutationObserver implements MutationObserver {
    targets = new Map<Node, MutationObserverInit>();
    observe = vi.fn((target: Node, options: MutationObserverInit = {}) => { this.targets.set(target, options); });
    disconnect = vi.fn(() => { this.targets.clear(); });
    takeRecords = () => [];
    constructor(readonly callback: MutationCallback) { mutations.push(this); }
    fire(records: MutationRecord[] = []) { this.callback(records, this); }
  }
  vi.stubGlobal("MutationObserver", TestMutationObserver);

  const visual = Object.assign(new EventTarget(), { offsetLeft: 0, offsetTop: 0, width: 800, height: 600 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: visual });
  const ready = Promise.withResolvers<void>();
  const readyThen = vi.spyOn(ready.promise, "then");
  const fonts = Object.assign(new EventTarget(), { ready: ready.promise });
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  let fullscreen: Element | null = null;
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen });
  const enterFullscreen = (element: Element | null) => {
    fullscreen = element;
    document.dispatchEvent(new Event("fullscreenchange"));
  };

  const opened = new Set<HTMLElement>();
  if (popover) {
    Object.defineProperties(HTMLElement.prototype, {
      showPopover: { configurable: true, value: vi.fn(function (this: HTMLElement) { opened.add(this); }) },
      hidePopover: { configurable: true, value: vi.fn(function (this: HTMLElement) { opened.delete(this); }) },
    });
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector) {
      return selector === ":popover-open" ? this instanceof HTMLElement && opened.has(this) : matches.call(this, selector);
    });
  } else {
    Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, value: undefined });
  }

  let layerRect = new DOMRect(0, 0, 800, 600);
  const getRect = Element.prototype.getBoundingClientRect;
  const layoutRead = vi.fn();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    layoutRead();
    return this.hasAttribute("data-selection-bubble-layer") ? layerRect : getRect.call(this);
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-selection-bubble-layer") ? 800 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-selection-bubble-layer") ? 600 : 0;
  });
  let fragments = [new DOMRect(100, 200, 40, 20)];
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => Object.assign([...fragments], { item: (index: number) => fragments[index] ?? null }),
  });

  type Listener = { target: EventTarget; type: string; callback: EventListenerOrEventListenerObject; capture: boolean; removed: number };
  const listeners: Listener[] = [];
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  // Ignore React's delegated handlers; track the toolbar's exact native ownership pairs.
  const trackAdd = (target: EventTarget, type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) => {
    if (typeof callback === "function" && ["schedule", "onPointerDown", "onPointerUp", "onBlur"].includes(callback.name)) {
      listeners.push({ target, type, callback, capture: typeof options === "boolean" ? options : !!options?.capture, removed: 0 });
    }
  };
  const trackRemove = (target: EventTarget, type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) => {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    const owned = listeners.findLast((entry) => entry.target === target && entry.type === type && entry.callback === callback && entry.capture === capture && !entry.removed);
    if (owned) owned.removed++;
  };
  vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (this: EventTarget, type, callback, options) {
    trackAdd(this, type, callback, options);
    add.call(this, type, callback, options);
  });
  vi.spyOn(EventTarget.prototype, "removeEventListener").mockImplementation(function (this: EventTarget, type, callback, options) {
    trackRemove(this, type, callback, options);
    remove.call(this, type, callback, options);
  });
  // jsdom's Window methods do not delegate through EventTarget.prototype.
  const windowAdd = window.addEventListener;
  const windowRemove = window.removeEventListener;
  vi.spyOn(window, "addEventListener").mockImplementation((type, callback, options) => {
    trackAdd(window, type, callback, options);
    windowAdd.call(window, type, callback, options);
  });
  vi.spyOn(window, "removeEventListener").mockImplementation((type, callback, options) => {
    trackRemove(window, type, callback, options);
    windowRemove.call(window, type, callback, options);
  });
  const replay = () => {
    for (const observer of resizes) observer.fire();
    for (const observer of mutations) observer.fire();
    for (const { target, type, callback } of listeners) {
      const event = new Event(type);
      if (typeof callback === "function") callback.call(target, event);
      else callback.handleEvent(event);
    }
    for (const callback of capturedFrames) callback(0);
    for (const [callback] of readyThen.mock.calls) callback?.(undefined);
  };
  return {
    frames, capturedFrames, request, cancel, flush, resizes, mutations, visual, fonts, ready,
    enterFullscreen, opened, listeners, replay, layoutRead,
    setLayerRect: (rect: DOMRect) => { layerRect = rect; },
    setFragments: (rects: DOMRect[]) => { fragments = rects; },
  };
}

function fixture() {
  const scroller = document.createElement("div");
  const editor = document.createElement("div");
  const paragraph = document.createElement("p");
  paragraph.textContent = "Selected passage";
  editor.append(paragraph);
  scroller.append(editor);
  document.body.append(scroller);
  let host = new DOMRect(0, 100, 800, 500);
  Object.defineProperty(scroller, "getBoundingClientRect", { configurable: true, value: vi.fn(() => host) });
  const doc = schema.node("doc", null, [schema.node("paragraph", null, schema.text(paragraph.textContent))]);
  let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1, 9) });
  const stateRead = vi.fn(() => state);
  const domRead = vi.fn(() => editor);
  const hasFocus = vi.fn(() => true);
  const coords = vi.fn((pos: number) => ({ left: pos === 1 ? 100 : 140, right: pos === 1 ? 100 : 140, top: 200, bottom: 220 }));
  const view = {
    get dom() { return domRead(); },
    get state() { return stateRead(); },
    isDestroyed: false,
    hasFocus,
    coordsAtPos: coords,
    domAtPos: (pos: number) => ({ node: paragraph.firstChild!, offset: pos - 1 }),
    dispatch: (transaction: Parameters<EditorView["dispatch"]>[0]) => { state = state.apply(transaction); },
    focus: vi.fn(),
  } as unknown as EditorView;
  const session = { activeSurface: "rich", canEdit: true, canComment: true, undoManager: { stopCapturing: vi.fn() } } as unknown as CollabSession;
  const actions = new EditorActions(session, vi.fn());
  actions.setRichView(view);
  const onLink = vi.fn();
  const onComment = vi.fn();
  const containerRef = { current: scroller as HTMLElement | null };
  const props = { view, session, actions, format: EMPTY_FORMAT, containerRef, onLink, onComment };
  return {
    props, scroller, editor, paragraph, view, session, actions, coords, stateRead, domRead, hasFocus, onLink, onComment,
    setHost: (rect: DOMRect) => { host = rect; },
    select: (anchor: number, head: number) => { state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, anchor, head))); },
    remove: () => scroller.remove(),
  };
}

function BubbleBoundary({
  bubble,
  present = true,
  boundary = 0,
  onBoundary,
}: {
  bubble: SelectionBubbleProps;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <SelectionBubble {...bubble} /> : null;
}

function reactProperty<T>(element: HTMLElement, name: string): T | undefined {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.getAttribute("aria-label") ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  return props?.[name] as T | undefined;
}

function reactHandler<T extends (...args: never[]) => unknown>(element: HTMLElement, name: string): T {
  const handler = reactProperty<T>(element, name);
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.getAttribute("aria-label") ?? element.tagName}`);
  return handler;
}

function captureToolbar() {
  return TOOLBAR_LABELS.map((label) => {
    const element = screen.getByRole("button", { name: label }) as HTMLButtonElement;
    expect(element).toHaveClass("h-[32px]", "w-[32px]");
    return {
      label,
      element,
      click: reactHandler<MouseHandler>(element, "onClick"),
      mouseDown: reactHandler<MouseHandler>(element, "onMouseDown"),
      buttonRef: reactProperty<ButtonRef>(element, "ref"),
    };
  });
}

function mouseEvent(currentTarget: EventTarget | null): CapturedMouseEvent {
  return { currentTarget, preventDefault: vi.fn() };
}

function invokeToolbar(toolbar: ReturnType<typeof captureToolbar>) {
  for (const action of toolbar) action.click(mouseEvent(action.element));
}

function instrumentActions() {
  const toggleMark = vi.fn();
  return {
    actions: { toggleMark } as unknown as EditorActions,
    toggleMark,
  };
}

function instrumentPermissions(session: CollabSession, canEdit = true, canComment = true) {
  let editable = canEdit;
  let commentable = canComment;
  const editReads = vi.fn(() => editable);
  const commentReads = vi.fn(() => commentable);
  Object.defineProperties(session, {
    canEdit: { configurable: true, get: editReads },
    canComment: { configurable: true, get: commentReads },
  });
  return {
    editReads,
    commentReads,
    setCanEdit: (value: boolean) => { editable = value; },
    setCanComment: (value: boolean) => { commentable = value; },
  };
}

function toolbarSession() {
  return {
    activeSurface: "rich",
    undoManager: { stopCapturing: vi.fn() },
  } as unknown as CollabSession;
}

function expectToolbarCalls(
  actions: ReturnType<typeof instrumentActions>,
  onLink: ReturnType<typeof vi.fn>,
  onComment: ReturnType<typeof vi.fn>,
) {
  expect(actions.toggleMark.mock.calls).toEqual([["strong"], ["em"], ["strike"], ["code"]]);
  expect(onLink).toHaveBeenCalledTimes(1);
  expect(onComment).toHaveBeenCalledTimes(1);
}

function productionFixture() {
  const source = "alpha beta gamma";
  const getToken = vi.fn(async (): Promise<string> => { throw new Error("Unexpected connection"); });
  const session = new CollabSession({
    docId: "toolbar-lifecycle",
    user: makeCollabUser("local", "Local"),
    role: "owner",
    autoConnect: false,
    deferLocal: true,
    getToken,
  });
  session.keepAlive();
  session.binding.releaseRemoteSync();
  session.ytext.insert(0, source);
  session.setMode("suggesting");
  session.setActiveSurface("rich");
  const state = createRichEditorState(session, {
    slashMenu: { onState: vi.fn() },
    uploadImage: async () => { throw new Error("Unexpected upload"); },
  });
  const constructors = state.plugins.filter((plugin) => plugin.spec.view).map((plugin) => vi.spyOn(plugin.spec, "view"));
  const scroller = document.createElement("div");
  document.body.append(scroller);
  const decorations = vi.fn((current: EditorState) => DecorationSet.create(current.doc, [
    Decoration.inline(1, 2, { "data-existing-decoration": "" }),
  ]));
  const view = new EditorView(scroller, { state, decorations });
  const destroys = constructors.flatMap((constructor) => {
    const pluginView = constructor.mock.results[0].value;
    return pluginView.destroy ? [vi.spyOn(pluginView, "destroy")] : [];
  });
  Object.defineProperty(scroller, "getBoundingClientRect", { configurable: true, value: () => new DOMRect(0, 100, 800, 500) });
  Object.defineProperty(view.dom, "getBoundingClientRect", { configurable: true, value: () => new DOMRect(0, 0, 800, 600) });
  vi.spyOn(view, "coordsAtPos").mockImplementation((pos) => ({ left: 100 + pos, right: 100 + pos, top: 200, bottom: 220 }));
  const origins: unknown[] = [];
  session.ytext.observe((event) => { origins.push(event.transaction.origin); });
  const actions = new EditorActions(session, vi.fn());
  actions.setRichView(view);
  const props = { view, session, actions, format: EMPTY_FORMAT, containerRef: { current: scroller }, onLink: vi.fn(), onComment: vi.fn() };
  const select = () => {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6, 1)));
    view.focus();
  };
  const edit = async (insert: string, from = session.ytext.length, to = from) => {
    await act(async () => {
      const map = session.binding.getSourceMap();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, map.srcToPm(from), map.srcToPm(to))).insertText(insert));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const cursor = session.binding.getSourceMap().srcToPm(from + insert.length);
    expect(view.state.selection.anchor, "suggested edit caret anchor").toBe(cursor);
    expect(view.state.selection.head, "suggested edit caret head").toBe(cursor);
    expect(view.hasFocus(), "suggested edit retains focus").toBe(true);
  };
  const assertTracked = (raw: string) => {
    expect(session.suggestions.cleanText() === source, "accepted document must remain unchanged").toBe(true);
    expect(session.ytext.toString() === raw, "exact shared-text character accounting").toBe(true);
    expect(view.state.doc.textContent === raw, "exact rich-text character accounting").toBe(true);
    expect(origins.every((origin) => origin === SUGGESTIONS_ORIGIN), "no direct accepted text transactions").toBe(true);
  };
  const assertViewsRetained = () => {
    expect(view.state.plugins).toBe(state.plugins);
    expect(session.binding.view).toBe(view);
    for (const constructor of constructors) expect(constructor).toHaveBeenCalledTimes(1);
    for (const destroy of destroys) expect(destroy).not.toHaveBeenCalled();
    expect(view.dom.querySelector("[data-existing-decoration]")).not.toBeNull();
  };
  const destroy = () => {
    view.destroy();
    session.destroy();
    scroller.remove();
    expect(getToken).not.toHaveBeenCalled();
    for (const dispose of destroys) expect(dispose).toHaveBeenCalledTimes(1);
  };
  return { props, view, session, source, decorations, select, edit, assertTracked, assertViewsRetained, destroy };
}

describe("SelectionBubble geometry scheduling", () => {
  it("restores every action family after Strict Mode replay without letting retired controls poison a successor", () => {
    const env = environment();
    const f = fixture();
    const permissions = instrumentPermissions(f.session);
    const retiredActions = instrumentActions();
    const retiredLink = vi.fn();
    const retiredComment = vi.fn();
    const retiredBubble = {
      ...f.props,
      actions: retiredActions.actions,
      onLink: retiredLink,
      onComment: retiredComment,
    };

    const rendered = render(
      <StrictMode>
        <SelectionBubble {...retiredBubble} />
      </StrictMode>,
    );
    env.flush();
    const retired = captureToolbar();
    const retiredBubbleRef = reactProperty<ElementRef<HTMLDivElement>>(screen.getByTestId("selection-bubble"), "ref");
    const retiredRootRef = reactProperty<ElementRef<HTMLDivElement>>(screen.getByRole("toolbar", { name: "Selection" }), "ref");
    invokeToolbar(retired);
    expectToolbarCalls(retiredActions, retiredLink, retiredComment);

    const currentActions = instrumentActions();
    const currentLink = vi.fn();
    const currentComment = vi.fn();
    const currentBubble = {
      ...retiredBubble,
      actions: currentActions.actions,
      onLink: currentLink,
      onComment: currentComment,
    };
    rendered.rerender(
      <StrictMode>
        <SelectionBubble {...currentBubble} />
      </StrictMode>,
    );
    env.flush();
    const current = captureToolbar();
    const reusedMouseEvents = retired.map(({ element }) => mouseEvent(element));
    permissions.editReads.mockClear();
    permissions.commentReads.mockClear();

    retiredBubbleRef?.(null);
    retiredRootRef?.(null);
    for (const [index, control] of retired.entries()) {
      control.buttonRef?.(null);
      control.mouseDown(reusedMouseEvents[index]);
      control.click(mouseEvent(control.element));
    }
    expectToolbarCalls(retiredActions, retiredLink, retiredComment);
    expect(currentActions.toggleMark).not.toHaveBeenCalled();
    expect(currentLink).not.toHaveBeenCalled();
    expect(currentComment).not.toHaveBeenCalled();
    expect(permissions.editReads).not.toHaveBeenCalled();
    expect(permissions.commentReads).not.toHaveBeenCalled();

    for (const [index, control] of current.entries()) {
      reusedMouseEvents[index].currentTarget = control.element;
      control.mouseDown(reusedMouseEvents[index]);
      control.click(mouseEvent(control.element));
      expect(reusedMouseEvents[index].preventDefault).toHaveBeenCalledTimes(1);
    }
    expectToolbarCalls(currentActions, currentLink, currentComment);
  });

  it("coalesces all owned signals, observes selected content, and cleans exact replacement owners", () => {
    const env = environment();
    const first = fixture();
    const second = fixture();
    const rendered = render(<SelectionBubble {...first.props} />);
    env.flush();
    expect(screen.getByTestId("selection-bubble").style.width).toBe("232px");
    expect(env.resizes[0].targets).toEqual(new Set([first.scroller, first.editor, first.paragraph]));
    expect(env.mutations[0].targets.get(first.editor)).toEqual({ childList: true, characterData: true, attributes: true, subtree: true });
    for (const [target, options] of env.mutations[0].targets) {
      if (target !== first.editor) expect(options.subtree).not.toBe(true);
    }
    first.scroller.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    env.visual.dispatchEvent(new Event("scroll"));
    document.dispatchEvent(new Event("selectionchange"));
    document.dispatchEvent(new Event("fullscreenchange"));
    first.editor.dispatchEvent(new Event("load"));
    env.fonts.dispatchEvent(new Event("loadingdone"));
    env.resizes[0].fire();
    env.mutations[0].fire();
    expect(env.frames.size).toBe(1);
    rendered.rerender(<SelectionBubble {...second.props} />);
    expect(env.frames.size).toBe(1);
    expect(env.resizes[0].disconnect).toHaveBeenCalledTimes(1);
    expect(env.mutations[0].disconnect).toHaveBeenCalledTimes(1);
    const beforeReads = first.stateRead.mock.calls.length;
    env.resizes[0].fire();
    env.mutations[0].fire();
    env.capturedFrames[0](0);
    expect(first.stateRead).toHaveBeenCalledTimes(beforeReads);
    expect(env.frames.size).toBe(1);
    env.flush();
    window.dispatchEvent(new Event("resize"));
    rendered.unmount();
    expect(env.cancel).toHaveBeenCalledTimes(2);
    expect(env.frames.size).toBe(0);
    expect(env.listeners.length).toBe(30);
    expect(env.listeners.every((listener) => listener.removed === 1)).toBe(true);
    for (const observer of [...env.resizes, ...env.mutations]) {
      expect(observer.targets.size).toBe(0);
      expect(observer.disconnect).toHaveBeenCalledTimes(1);
    }
    expect(document.querySelectorAll("[data-selection-bubble-layer]")).toHaveLength(0);
  });

  it.each(["retired-before-current", "current-before-retired"] as const)(
    "binds reused-view publications and actions to the exact replacement owner (%s)",
    (order) => {
      const env = environment({ popover: true });
      const shared = fixture();
      const retiredActions = instrumentActions();
      const retiredPermissions = instrumentPermissions(shared.session);
      const retiredLink = vi.fn();
      const retiredComment = vi.fn();
      const retiredBubble = {
        ...shared.props,
        actions: retiredActions.actions,
        onLink: retiredLink,
        onComment: retiredComment,
      };
      env.enterFullscreen(shared.scroller);
      const rendered = render(<BubbleBoundary bubble={retiredBubble} />);
      env.flush();
      const retiredToolbar = captureToolbar();
      const retiredLayer = document.querySelector<HTMLElement>("[data-selection-bubble-layer]")!;
      const retiredObservers = { resize: env.resizes[0], mutation: env.mutations[0] };
      const retiredListeners = env.listeners.slice();
      window.dispatchEvent(new Event("resize"));
      const retiredFrameId = [...env.frames.keys()][0];
      const retiredFrames = env.capturedFrames.slice();
      if (retiredFrameId === undefined) throw new Error("The retired owner did not have a pending frame");
      retiredPermissions.editReads.mockClear();
      retiredPermissions.commentReads.mockClear();

      const currentSession = toolbarSession();
      const currentPermissions = instrumentPermissions(currentSession);
      const currentActions = instrumentActions();
      const currentLink = vi.fn();
      const currentComment = vi.fn();
      const currentBubble = {
        ...retiredBubble,
        session: currentSession,
        actions: currentActions.actions,
        onLink: currentLink,
        onComment: currentComment,
      };
      let retiredAbsentAtBoundary = false;
      rendered.rerender(
        <BubbleBoundary
          bubble={currentBubble}
          boundary={1}
          onBoundary={() => {
            retiredAbsentAtBoundary =
              screen.queryByTestId("selection-bubble") === null &&
              document.querySelectorAll("[data-selection-bubble-layer]").length === 0;
            invokeToolbar(retiredToolbar);
          }}
        />,
      );

      expect(retiredAbsentAtBoundary).toBe(true);
      expect(env.frames.has(retiredFrameId)).toBe(false);
      expect(env.frames.size).toBe(1);
      expect(retiredToolbar.every(({ element }) => !element.isConnected)).toBe(true);
      expect(retiredActions.toggleMark).not.toHaveBeenCalled();
      expect(retiredLink).not.toHaveBeenCalled();
      expect(retiredComment).not.toHaveBeenCalled();
      expect(retiredPermissions.editReads).not.toHaveBeenCalled();
      expect(retiredPermissions.commentReads).not.toHaveBeenCalled();
      expect(retiredObservers.resize.disconnect).toHaveBeenCalledTimes(1);
      expect(retiredObservers.mutation.disconnect).toHaveBeenCalledTimes(1);
      expect(retiredListeners).toHaveLength(15);
      expect(retiredListeners.every((listener) => listener.removed === 1)).toBe(true);
      expect(env.opened.has(retiredLayer)).toBe(false);

      env.flush();
      const currentToolbar = captureToolbar();
      const currentLayer = document.querySelector<HTMLElement>("[data-selection-bubble-layer]")!;
      expect(currentLayer).not.toBe(retiredLayer);
      expect(document.querySelectorAll("[data-selection-bubble-layer]")).toHaveLength(1);
      expect(screen.getAllByRole("button")).toHaveLength(6);
      expect(env.opened).toEqual(new Set([currentLayer]));
      expect(env.listeners).toHaveLength(30);
      expect(env.listeners.slice(15).every((listener) => listener.removed === 0)).toBe(true);
      expect(env.resizes).toHaveLength(2);
      expect(env.mutations).toHaveLength(2);
      const currentTargets = {
        resize: new Set(env.resizes[1].targets),
        mutation: new Map(env.mutations[1].targets),
        layerParent: currentLayer.parentElement,
        selection: shared.view.state.selection.toJSON(),
        focusCalls: shared.hasFocus.mock.calls.length,
        requests: env.request.mock.calls.length,
      };

      for (const observer of Object.values(retiredObservers)) observer.fire();
      for (const listener of retiredListeners) {
        const event = new Event(listener.type);
        if (typeof listener.callback === "function") listener.callback.call(listener.target, event);
        else listener.callback.handleEvent(event);
      }
      for (const frame of retiredFrames) frame(0);
      expect(env.frames.size).toBe(0);
      expect(env.request).toHaveBeenCalledTimes(currentTargets.requests);
      expect(env.resizes[1].targets).toEqual(currentTargets.resize);
      expect(env.mutations[1].targets).toEqual(currentTargets.mutation);
      expect(currentLayer.parentElement).toBe(currentTargets.layerParent);
      expect(shared.view.state.selection.toJSON()).toEqual(currentTargets.selection);
      expect(shared.hasFocus).toHaveBeenCalledTimes(currentTargets.focusCalls);
      expect(env.opened).toEqual(new Set([currentLayer]));
      expect(screen.getAllByRole("button")).toHaveLength(6);

      retiredPermissions.editReads.mockClear();
      retiredPermissions.commentReads.mockClear();
      currentPermissions.editReads.mockClear();
      currentPermissions.commentReads.mockClear();
      act(() => {
        if (order === "retired-before-current") {
          invokeToolbar(retiredToolbar);
          invokeToolbar(currentToolbar);
        } else {
          invokeToolbar(currentToolbar);
          invokeToolbar(retiredToolbar);
        }
      });
      expect(retiredActions.toggleMark).not.toHaveBeenCalled();
      expect(retiredLink).not.toHaveBeenCalled();
      expect(retiredComment).not.toHaveBeenCalled();
      expect(retiredPermissions.editReads).not.toHaveBeenCalled();
      expect(retiredPermissions.commentReads).not.toHaveBeenCalled();
      expectToolbarCalls(currentActions, currentLink, currentComment);
      expect(currentPermissions.editReads).toHaveBeenCalledTimes(6);
      expect(currentPermissions.commentReads).toHaveBeenCalledTimes(6);
    },
  );

  it.each(["retired-before-current", "current-before-retired"] as const)(
    "retires same-owner action props without replacing native ownership (%s)",
    (order) => {
      const env = environment({ popover: true });
      const shared = fixture();
      const permissions = instrumentPermissions(shared.session);
      const retiredActions = instrumentActions();
      const retiredLink = vi.fn();
      const retiredComment = vi.fn();
      const retiredBubble = {
        ...shared.props,
        actions: retiredActions.actions,
        onLink: retiredLink,
        onComment: retiredComment,
      };
      const rendered = render(<BubbleBoundary bubble={retiredBubble} />);
      env.flush();
      const retiredToolbar = captureToolbar();
      const layer = document.querySelector<HTMLElement>("[data-selection-bubble-layer]")!;
      window.dispatchEvent(new Event("resize"));
      const pendingFrame = [...env.frames.keys()][0];
      if (pendingFrame === undefined) throw new Error("The shared owner did not have a pending frame");
      permissions.editReads.mockClear();
      permissions.commentReads.mockClear();

      const currentActions = instrumentActions();
      const currentLink = vi.fn();
      const currentComment = vi.fn();
      const currentBubble = {
        ...retiredBubble,
        actions: currentActions.actions,
        onLink: currentLink,
        onComment: currentComment,
      };
      let retiredAbsentAtBoundary = false;
      rendered.rerender(
        <BubbleBoundary
          bubble={currentBubble}
          boundary={1}
          onBoundary={() => {
            retiredAbsentAtBoundary = screen.queryByTestId("selection-bubble") === null;
            invokeToolbar(retiredToolbar);
          }}
        />,
      );

      expect(retiredAbsentAtBoundary).toBe(true);
      expect(document.querySelectorAll("[data-selection-bubble-layer]")).toHaveLength(1);
      expect(document.querySelector("[data-selection-bubble-layer]")).toBe(layer);
      expect(env.frames.has(pendingFrame)).toBe(true);
      expect(env.cancel).not.toHaveBeenCalled();
      expect(env.resizes).toHaveLength(1);
      expect(env.mutations).toHaveLength(1);
      expect(env.resizes[0].disconnect).not.toHaveBeenCalled();
      expect(env.mutations[0].disconnect).not.toHaveBeenCalled();
      expect(env.listeners).toHaveLength(15);
      expect(env.listeners.every((listener) => listener.removed === 0)).toBe(true);
      expect(retiredActions.toggleMark).not.toHaveBeenCalled();
      expect(retiredLink).not.toHaveBeenCalled();
      expect(retiredComment).not.toHaveBeenCalled();
      expect(permissions.editReads).not.toHaveBeenCalled();
      expect(permissions.commentReads).not.toHaveBeenCalled();

      env.flush();
      const currentToolbar = captureToolbar();
      expect(document.querySelector("[data-selection-bubble-layer]")).toBe(layer);
      expect(screen.getAllByRole("button")).toHaveLength(6);
      permissions.editReads.mockClear();
      permissions.commentReads.mockClear();
      act(() => {
        if (order === "retired-before-current") {
          invokeToolbar(retiredToolbar);
          invokeToolbar(currentToolbar);
        } else {
          invokeToolbar(currentToolbar);
          invokeToolbar(retiredToolbar);
        }
      });
      expect(retiredActions.toggleMark).not.toHaveBeenCalled();
      expect(retiredLink).not.toHaveBeenCalled();
      expect(retiredComment).not.toHaveBeenCalled();
      expectToolbarCalls(currentActions, currentLink, currentComment);
      expect(permissions.editReads).toHaveBeenCalledTimes(6);
      expect(permissions.commentReads).toHaveBeenCalledTimes(6);
      expect(env.resizes[0].disconnect).not.toHaveBeenCalled();
      expect(env.mutations[0].disconnect).not.toHaveBeenCalled();
      expect(env.listeners.every((listener) => listener.removed === 0)).toBe(true);
      expect(env.opened).toEqual(new Set([layer]));
    },
  );

  it("requires each exact current button, consumes each mouse event once, and claims controls independently", () => {
    const env = environment();
    const f = fixture();
    const actions = instrumentActions();
    const permissions = instrumentPermissions(f.session);
    const onLink = vi.fn();
    const onComment = vi.fn();
    render(<SelectionBubble {...f.props} actions={actions.actions} onLink={onLink} onComment={onComment} />);
    env.flush();
    const toolbar = captureToolbar();
    const layer = document.querySelector<HTMLElement>("[data-selection-bubble-layer]")!;
    const layerContains = vi.spyOn(layer, "contains");
    const foreign = document.createElement("button");
    const detached = document.createElement("button");
    const replacement = document.createElement("button");
    document.body.append(foreign, replacement);
    permissions.editReads.mockClear();
    permissions.commentReads.mockClear();
    layerContains.mockClear();

    for (const control of [toolbar[0], toolbar[4], toolbar[5]]) {
      const sibling = toolbar[control === toolbar[0] ? 1 : 0];
      for (const target of [sibling.element, foreign, detached, replacement]) {
        const down = mouseEvent(target);
        control.mouseDown(down);
        control.click(mouseEvent(target));
        expect(down.preventDefault).not.toHaveBeenCalled();
      }
    }
    expect(actions.toggleMark).not.toHaveBeenCalled();
    expect(onLink).not.toHaveBeenCalled();
    expect(onComment).not.toHaveBeenCalled();
    expect(permissions.editReads).not.toHaveBeenCalled();
    expect(permissions.commentReads).not.toHaveBeenCalled();
    expect(layerContains).not.toHaveBeenCalled();
    expect(f.view.focus).not.toHaveBeenCalled();

    const competingMouseEvent = mouseEvent(toolbar[0].element);
    toolbar[0].mouseDown(competingMouseEvent);
    competingMouseEvent.currentTarget = toolbar[1].element;
    toolbar[1].mouseDown(competingMouseEvent);
    expect(competingMouseEvent.preventDefault).toHaveBeenCalledTimes(1);

    const acceptedMouseEvents: CapturedMouseEvent[] = [];
    for (const control of toolbar) {
      const down = mouseEvent(control.element);
      acceptedMouseEvents.push(down);
      control.mouseDown(down);
      control.mouseDown(down);
      control.click(mouseEvent(control.element));
      control.click(mouseEvent(control.element));
    }
    for (const event of acceptedMouseEvents) expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expectToolbarCalls(actions, onLink, onComment);
    expect(permissions.editReads).toHaveBeenCalledTimes(13);
    expect(permissions.commentReads).toHaveBeenCalledTimes(13);
  });

  it("rejects detached and replacement exact-control sources before permission or destination work", () => {
    const env = environment();
    const f = fixture();
    const actions = instrumentActions();
    const permissions = instrumentPermissions(f.session);
    const onLink = vi.fn();
    const onComment = vi.fn();
    render(<SelectionBubble {...f.props} actions={actions.actions} onLink={onLink} onComment={onComment} />);
    env.flush();
    const toolbar = captureToolbar();
    const bold = toolbar[0];
    const layer = document.querySelector<HTMLElement>("[data-selection-bubble-layer]")!;
    const layerContains = vi.spyOn(layer, "contains");
    const replacement = bold.element.cloneNode(true) as HTMLButtonElement;
    bold.element.replaceWith(replacement);
    permissions.editReads.mockClear();
    permissions.commentReads.mockClear();
    layerContains.mockClear();

    const detachedDown = mouseEvent(bold.element);
    const replacementDown = mouseEvent(replacement);
    bold.mouseDown(detachedDown);
    bold.mouseDown(replacementDown);
    bold.click(mouseEvent(bold.element));
    bold.click(mouseEvent(replacement));

    expect(detachedDown.preventDefault).not.toHaveBeenCalled();
    expect(replacementDown.preventDefault).not.toHaveBeenCalled();
    expect(actions.toggleMark).not.toHaveBeenCalled();
    expect(onLink).not.toHaveBeenCalled();
    expect(onComment).not.toHaveBeenCalled();
    expect(permissions.editReads).not.toHaveBeenCalled();
    expect(permissions.commentReads).not.toHaveBeenCalled();
    expect(layerContains).not.toHaveBeenCalled();
    expect(f.view.focus).not.toHaveBeenCalled();

    const link = toolbar[4];
    document.body.append(link.element);
    layerContains.mockClear();
    link.click(mouseEvent(link.element));
    expect(onLink).not.toHaveBeenCalled();
    expect(permissions.editReads).not.toHaveBeenCalled();
    expect(permissions.commentReads).not.toHaveBeenCalled();
  });

  it.each(["retired-before-current", "current-before-retired"] as const)(
    "reuses exact button, layer, method, and callbacks without restoring retired format controls (%s)",
    (order) => {
      const env = environment();
      const f = fixture();
      const actions = instrumentActions();
      const permissions = instrumentPermissions(f.session);
      const onLink = vi.fn();
      const onComment = vi.fn();
      const firstFormat = { ...EMPTY_FORMAT };
      const firstBubble = { ...f.props, actions: actions.actions, format: firstFormat, onLink, onComment };
      const rendered = render(<BubbleBoundary bubble={firstBubble} />);
      env.flush();
      const retired = captureToolbar();
      const layer = document.querySelector<HTMLElement>("[data-selection-bubble-layer]")!;
      const secondFormat = { ...firstFormat, strong: true };
      let current: ReturnType<typeof captureToolbar> | null = null;
      permissions.editReads.mockClear();
      permissions.commentReads.mockClear();

      rendered.rerender(
        <BubbleBoundary
          bubble={{ ...firstBubble, format: secondFormat }}
          boundary={1}
          onBoundary={() => {
            current = captureToolbar();
            expect(document.querySelector("[data-selection-bubble-layer]")).toBe(layer);
            expect(current.map(({ element }) => element)).toEqual(retired.map(({ element }) => element));
            retired[0].buttonRef?.(null);
            const invoke = (toolbar: ReturnType<typeof captureToolbar>) => {
              for (const index of [0, 4, 5]) toolbar[index].click(mouseEvent(toolbar[index].element));
            };
            if (order === "retired-before-current") {
              invoke(retired);
              invoke(current);
            } else {
              invoke(current);
              invoke(retired);
            }
          }}
        />,
      );

      expect(current).not.toBeNull();
      expect(actions.toggleMark.mock.calls).toEqual([["strong"]]);
      expect(onLink).toHaveBeenCalledTimes(1);
      expect(onComment).toHaveBeenCalledTimes(1);
      expect(permissions.editReads).toHaveBeenCalledTimes(5);
      expect(permissions.commentReads).toHaveBeenCalledTimes(5);
    },
  );

  it.each(["retired-before-current", "current-before-retired"] as const)(
    "retires exact controls across same-layer geometry replacement (%s)",
    (order) => {
      const env = environment();
      const f = fixture();
      const actions = instrumentActions();
      const permissions = instrumentPermissions(f.session);
      const onLink = vi.fn();
      const onComment = vi.fn();
      render(<SelectionBubble {...f.props} actions={actions.actions} onLink={onLink} onComment={onComment} />);
      env.flush();
      const retired = captureToolbar();
      const layer = document.querySelector<HTMLElement>("[data-selection-bubble-layer]")!;
      window.dispatchEvent(new Event("resize"));
      env.flush();
      const current = captureToolbar();
      expect(document.querySelector("[data-selection-bubble-layer]")).toBe(layer);
      expect(current.map(({ element }) => element)).toEqual(retired.map(({ element }) => element));
      permissions.editReads.mockClear();
      permissions.commentReads.mockClear();

      const invoke = (toolbar: ReturnType<typeof captureToolbar>) => {
        for (const index of [1, 4, 5]) toolbar[index].click(mouseEvent(toolbar[index].element));
      };
      if (order === "retired-before-current") {
        invoke(retired);
        invoke(current);
      } else {
        invoke(current);
        invoke(retired);
      }

      expect(actions.toggleMark.mock.calls).toEqual([["em"]]);
      expect(onLink).toHaveBeenCalledTimes(1);
      expect(onComment).toHaveBeenCalledTimes(1);
      expect(permissions.editReads).toHaveBeenCalledTimes(3);
      expect(permissions.commentReads).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["retired-before-current", "current-before-retired"] as const)(
    "keeps an equal-looking remount separate from every retired control (%s)",
    (order) => {
      const env = environment();
      const f = fixture();
      const actions = instrumentActions();
      const permissions = instrumentPermissions(f.session);
      const onLink = vi.fn();
      const onComment = vi.fn();
      const bubble = { ...f.props, actions: actions.actions, onLink, onComment };
      const first = render(<SelectionBubble {...bubble} />);
      env.flush();
      const retired = captureToolbar();
      first.unmount();
      const second = render(<SelectionBubble {...bubble} />);
      env.flush();
      const current = captureToolbar();
      for (const [index, control] of current.entries()) {
        expect(control.element).not.toBe(retired[index].element);
      }
      permissions.editReads.mockClear();
      permissions.commentReads.mockClear();

      const invoke = (toolbar: ReturnType<typeof captureToolbar>) => {
        for (const index of [3, 4, 5]) toolbar[index].click(mouseEvent(toolbar[index].element));
      };
      if (order === "retired-before-current") {
        invoke(retired);
        invoke(current);
      } else {
        invoke(current);
        invoke(retired);
      }

      expect(actions.toggleMark.mock.calls).toEqual([["code"]]);
      expect(onLink).toHaveBeenCalledTimes(1);
      expect(onComment).toHaveBeenCalledTimes(1);
      expect(permissions.editReads).toHaveBeenCalledTimes(3);
      expect(permissions.commentReads).toHaveBeenCalledTimes(3);
      second.unmount();
    },
  );

  it("fails closed for disabled publications and restores only later eligible controls", () => {
    const env = environment();
    const f = fixture();
    const actions = instrumentActions();
    const permissions = instrumentPermissions(f.session, false, true);
    const onLink = vi.fn();
    const onComment = vi.fn();
    const bubble = { ...f.props, actions: actions.actions, onLink, onComment };
    const rendered = render(<SelectionBubble {...bubble} />);
    env.flush();
    const retired = captureToolbar();
    expect(retired[0].element).toBeDisabled();
    expect(retired[5].element).toBeEnabled();
    permissions.editReads.mockClear();
    permissions.commentReads.mockClear();
    const disabledEdit = mouseEvent(retired[0].element);
    retired[0].mouseDown(disabledEdit);
    retired[0].click(mouseEvent(retired[0].element));
    expect(disabledEdit.preventDefault).not.toHaveBeenCalled();
    expect(permissions.editReads).not.toHaveBeenCalled();
    expect(permissions.commentReads).not.toHaveBeenCalled();

    permissions.setCanEdit(true);
    permissions.setCanComment(false);
    rendered.rerender(<SelectionBubble {...bubble} />);
    const current = captureToolbar();
    expect(current[0].element).toBeEnabled();
    expect(current[5].element).toBeDisabled();
    permissions.editReads.mockClear();
    permissions.commentReads.mockClear();
    const disabledComment = mouseEvent(current[5].element);
    retired[5].click(mouseEvent(retired[5].element));
    current[5].mouseDown(disabledComment);
    current[5].click(mouseEvent(current[5].element));
    current[0].click(mouseEvent(current[0].element));
    expect(disabledComment.preventDefault).not.toHaveBeenCalled();
    expect(actions.toggleMark.mock.calls).toEqual([["strong"]]);
    expect(onComment).not.toHaveBeenCalled();
    expect(permissions.editReads).toHaveBeenCalledTimes(1);
    expect(permissions.commentReads).toHaveBeenCalledTimes(1);

    permissions.setCanComment(true);
    rendered.rerender(<SelectionBubble {...bubble} />);
    const restored = captureToolbar();
    restored[5].click(mouseEvent(restored[5].element));
    restored[5].click(mouseEvent(restored[5].element));
    expect(onComment).toHaveBeenCalledTimes(1);
  });

  it("rejects silent format, method, and pre-commit permission drift before restoring a later publication", () => {
    const env = environment();
    const f = fixture();
    const actions = instrumentActions();
    const permissions = instrumentPermissions(f.session);
    const format = { ...EMPTY_FORMAT };
    const bubble = { ...f.props, actions: actions.actions, format };
    const rendered = render(<BubbleBoundary bubble={bubble} />);
    env.flush();
    const formatStale = captureToolbar();
    permissions.editReads.mockClear();
    permissions.commentReads.mockClear();
    format.strong = true;
    formatStale[0].click(mouseEvent(formatStale[0].element));
    expect(actions.toggleMark).not.toHaveBeenCalled();
    expect(permissions.editReads).not.toHaveBeenCalled();
    expect(permissions.commentReads).not.toHaveBeenCalled();

    rendered.rerender(<BubbleBoundary bubble={bubble} />);
    const methodStale = captureToolbar();
    const replacementToggle = vi.fn();
    actions.actions.toggleMark = replacementToggle;
    permissions.editReads.mockClear();
    permissions.commentReads.mockClear();
    methodStale[1].click(mouseEvent(methodStale[1].element));
    expect(actions.toggleMark).not.toHaveBeenCalled();
    expect(replacementToggle).not.toHaveBeenCalled();
    expect(permissions.editReads).not.toHaveBeenCalled();
    expect(permissions.commentReads).not.toHaveBeenCalled();

    rendered.rerender(<BubbleBoundary bubble={bubble} />);
    let permissionStale: ReturnType<typeof captureToolbar> | null = null;
    rendered.rerender(
      <BubbleBoundary
        bubble={bubble}
        boundary={1}
        onBoundary={() => {
          permissionStale = captureToolbar();
          permissions.setCanEdit(false);
        }}
      />,
    );
    permissions.editReads.mockClear();
    permissions.commentReads.mockClear();
    permissionStale![2].click(mouseEvent(permissionStale![2].element));
    expect(replacementToggle).not.toHaveBeenCalled();
    expect(permissions.editReads).toHaveBeenCalledTimes(1);
    expect(permissions.commentReads).not.toHaveBeenCalled();

    permissions.setCanEdit(true);
    rendered.rerender(<BubbleBoundary bubble={bubble} boundary={2} />);
    const restored = captureToolbar();
    restored[1].click(mouseEvent(restored[1].element));
    restored[1].click(mouseEvent(restored[1].element));
    expect(replacementToggle.mock.calls).toEqual([["em"]]);
    expect(actions.toggleMark).not.toHaveBeenCalled();
  });

  it("claims before destination reentrancy while leaving a distinct current control usable", () => {
    const env = environment();
    const f = fixture();
    let reenter: () => void = () => undefined;
    const toggleMark = vi.fn(() => reenter());
    const actions = { toggleMark } as unknown as EditorActions;
    const onLink = vi.fn();
    render(<SelectionBubble {...f.props} actions={actions} onLink={onLink} />);
    env.flush();
    const toolbar = captureToolbar();
    reenter = () => toolbar[0].click(mouseEvent(toolbar[0].element));

    toolbar[0].click(mouseEvent(toolbar[0].element));
    toolbar[4].click(mouseEvent(toolbar[4].element));

    expect(toggleMark.mock.calls).toEqual([["strong"]]);
    expect(onLink).toHaveBeenCalledTimes(1);
  });

  it("retires publication and captured actions before the parent removal layout boundary", () => {
    const env = environment({ popover: true });
    const f = fixture();
    const actions = instrumentActions();
    const permissions = instrumentPermissions(f.session);
    const onLink = vi.fn();
    const onComment = vi.fn();
    const bubble = { ...f.props, actions: actions.actions, onLink, onComment };
    const rendered = render(<BubbleBoundary bubble={bubble} />);
    env.flush();
    const retiredToolbar = captureToolbar();
    const retiredLayer = document.querySelector<HTMLElement>("[data-selection-bubble-layer]")!;
    window.dispatchEvent(new Event("resize"));
    const retiredFrames = env.capturedFrames.slice();
    const requested = env.request.mock.calls.length;
    permissions.editReads.mockClear();
    permissions.commentReads.mockClear();
    let absentAtBoundary = false;

    rendered.rerender(
      <BubbleBoundary
        bubble={bubble}
        present={false}
        boundary={1}
        onBoundary={() => {
          absentAtBoundary =
            screen.queryByTestId("selection-bubble") === null &&
            document.querySelectorAll("[data-selection-bubble-layer]").length === 0;
          invokeToolbar(retiredToolbar);
        }}
      />,
    );

    expect(absentAtBoundary).toBe(true);
    expect(retiredToolbar.every(({ element }) => !element.isConnected)).toBe(true);
    expect(env.frames.size).toBe(0);
    expect(env.opened.has(retiredLayer)).toBe(false);
    expect(actions.toggleMark).not.toHaveBeenCalled();
    expect(onLink).not.toHaveBeenCalled();
    expect(onComment).not.toHaveBeenCalled();
    expect(permissions.editReads).not.toHaveBeenCalled();
    expect(permissions.commentReads).not.toHaveBeenCalled();
    expect(env.listeners).toHaveLength(15);
    expect(env.listeners.every((listener) => listener.removed === 1)).toBe(true);
    expect(env.resizes[0].targets.size).toBe(0);
    expect(env.mutations[0].targets.size).toBe(0);
    expect(env.resizes[0].disconnect).toHaveBeenCalledTimes(1);
    expect(env.mutations[0].disconnect).toHaveBeenCalledTimes(1);

    for (const frame of retiredFrames) frame(0);
    for (const listener of env.listeners) {
      const event = new Event(listener.type);
      if (typeof listener.callback === "function") listener.callback.call(listener.target, event);
      else listener.callback.handleEvent(event);
    }
    env.resizes[0].fire();
    env.mutations[0].fire();
    expect(env.request).toHaveBeenCalledTimes(requested);
    expect(env.frames.size).toBe(0);
    expect(document.querySelectorAll("[data-selection-bubble-layer]")).toHaveLength(0);
    expect(actions.toggleMark).not.toHaveBeenCalled();
    expect(onLink).not.toHaveBeenCalled();
    expect(onComment).not.toHaveBeenCalled();
  });

  it("positions and follows existing signals without ResizeObserver", () => {
    const env = environment({ resize: false });
    const f = fixture();
    const rendered = render(<SelectionBubble {...f.props} />);
    env.flush();
    expect(screen.getByTestId("selection-bubble")).toBeInTheDocument();
    f.setHost(new DOMRect(0, 0, 180, 500));
    env.visual.dispatchEvent(new Event("resize"));
    env.flush();
    expect(screen.getByTestId("selection-bubble").style.width).toBe("164px");
    f.select(1, 1);
    rendered.rerender(<SelectionBubble {...f.props} format={{ ...EMPTY_FORMAT }} />);
    env.flush();
    expect(screen.queryByTestId("selection-bubble")).toBeNull();
    rendered.unmount();
    const requested = env.request.mock.calls.length;
    env.replay();
    expect(env.request).toHaveBeenCalledTimes(requested);
  });

  it("responds to image/font/attribute reflow without a scroller border-box resize", async () => {
    const env = environment();
    const f = fixture();
    render(<SelectionBubble {...f.props} />);
    env.flush();
    f.coords.mockReturnValue({ left: 100, right: 140, top: 300, bottom: 320 });
    env.setFragments([new DOMRect(100, 300, 40, 20)]);
    const image = document.createElement("img");
    f.paragraph.prepend(image);
    image.dispatchEvent(new Event("load"));
    env.fonts.dispatchEvent(new Event("loadingdone"));
    env.fonts.dispatchEvent(new Event("loadingerror"));
    env.mutations[0].fire();
    env.resizes[0].fire();
    expect(env.frames.size).toBe(1);
    image.remove();
    env.flush();
    expect(screen.getByTestId("selection-bubble").style.top).toBe("250px");
    await act(async () => { env.ready.resolve(); await env.ready.promise; });
    expect(env.frames.size).toBe(1);
  });

  it("replaces a scroller behind a stable ref and disconnects the precise old targets", () => {
    const env = environment();
    const f = fixture();
    const actions = instrumentActions();
    const permissions = instrumentPermissions(f.session);
    const rendered = render(<SelectionBubble {...f.props} actions={actions.actions} />);
    env.flush();
    const retired = captureToolbar();
    const retiredLayer = document.querySelector<HTMLElement>("[data-selection-bubble-layer]")!;
    const replacement = document.createElement("div");
    replacement.append(f.editor);
    document.body.append(replacement);
    Object.defineProperty(replacement, "getBoundingClientRect", { configurable: true, value: vi.fn(() => new DOMRect(50, 100, 180, 500)) });
    f.props.containerRef.current = replacement;
    rendered.rerender(<SelectionBubble {...f.props} actions={actions.actions} />);
    env.flush();
    const current = captureToolbar();
    permissions.editReads.mockClear();
    permissions.commentReads.mockClear();
    retired[0].click(mouseEvent(retired[0].element));
    current[0].click(mouseEvent(current[0].element));
    expect(env.resizes[0].disconnect).toHaveBeenCalledTimes(1);
    expect(env.resizes[1].targets.has(replacement)).toBe(true);
    expect(env.resizes[1].targets.has(f.scroller)).toBe(false);
    expect(document.querySelector("[data-selection-bubble-layer]")).not.toBe(retiredLayer);
    expect(screen.getByTestId("selection-bubble").style.width).toBe("164px");
    expect(actions.toggleMark.mock.calls).toEqual([["strong"]]);
    expect(permissions.editReads).toHaveBeenCalledTimes(1);
    expect(permissions.commentReads).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("owns transformed-body and descendant fullscreen enter/replace/exit (popover %s)", (popover) => {
    const env = environment({ popover });
    const f = fixture();
    document.body.style.transform = "translate(30px, 20px) scale(0.5)";
    const rendered = render(<SelectionBubble {...f.props} />);
    env.flush();
    const layer = document.querySelector<HTMLElement>("[data-selection-bubble-layer]")!;
    expect(layer.parentElement).toBe(document.documentElement);
    expect(screen.getByTestId("selection-bubble").style.transform).toBe("scale(1, 1)");
    if (popover) expect(env.opened.has(layer)).toBe(true);
    const shell = document.createElement("section");
    f.scroller.replaceWith(shell);
    shell.append(f.scroller);
    if (!popover) env.setLayerRect(new DOMRect(30, 20, 400, 300));
    env.enterFullscreen(f.scroller);
    env.flush();
    expect(layer.parentElement).toBe(f.scroller);
    const bubble = screen.getByTestId("selection-bubble");
    expect(bubble.style.transform).toBe(popover ? "scale(1, 1)" : "scale(2, 2)");
    expect(parseFloat(bubble.style.top) * (popover ? 1 : 0.5) + (popover ? 0 : 20)).toBe(150);
    expect(layer.style.clipPath).toContain("inset(");
    env.enterFullscreen(shell);
    env.flush();
    expect(layer.parentElement).toBe(shell);
    expect(document.querySelectorAll("[data-selection-bubble-layer]")).toHaveLength(1);
    env.setLayerRect(new DOMRect(0, 0, 800, 600));
    env.enterFullscreen(null);
    env.flush();
    expect(layer.parentElement).toBe(document.documentElement);
    rendered.unmount();
    expect(env.opened.size).toBe(0);
    expect(document.querySelectorAll("[data-selection-bubble-layer]")).toHaveLength(0);
  });

  it("does not surface over unrelated fullscreen content", () => {
    const env = environment({ popover: true });
    const f = fixture();
    render(<SelectionBubble {...f.props} />);
    env.flush();
    const unrelated = document.createElement("section");
    document.body.append(unrelated);
    env.enterFullscreen(unrelated);
    env.flush();
    expect(screen.queryByTestId("selection-bubble")).toBeNull();
    expect(env.opened.size).toBe(0);
    env.enterFullscreen(null);
    env.flush();
    expect(screen.getByTestId("selection-bubble")).toBeInTheDocument();
  });

  it("does not invent a transform from fractional zoom dimensions and rounded offset sizes", () => {
    const env = environment();
    const f = fixture();
    render(<SelectionBubble {...f.props} />);
    env.flush();
    const layer = document.querySelector<HTMLElement>("[data-selection-bubble-layer]")!;
    layer.style.width = "196.5px";
    layer.style.height = "600px";
    Object.defineProperty(layer, "offsetWidth", { value: 197 });
    env.setLayerRect(new DOMRect(0, 0, 196.5, 600));
    env.visual.width = 196.5;
    window.dispatchEvent(new Event("resize"));
    env.flush();
    const bubble = screen.getByTestId("selection-bubble");
    expect(bubble.style.transform).toBe("scale(1, 1)");
    expect(bubble.style.width).toBe("180.5px");
  });

  it("keeps a fullscreen editable root's toolbar out of document edits and editor key handling", async () => {
    const f = fixture();
    const editorKeydown = vi.fn(() => false);
    // Construct the editor before replacing observer globals, so its own DOM observer is real.
    const view = new EditorView({ mount: f.editor }, { state: f.view.state, handleKeyDown: editorKeydown });
    const initialDoc = view.state.doc;
    const initialPlugins = view.state.plugins;
    Object.defineProperty(view.dom, "getBoundingClientRect", { configurable: true, value: () => new DOMRect(0, 0, 800, 600) });
    const env = environment({ popover: true });
    vi.spyOn(view, "hasFocus").mockReturnValue(true);
    vi.spyOn(view, "coordsAtPos").mockImplementation(f.coords);
    const rendered = render(<SelectionBubble {...f.props} view={view} />);
    try {
      env.flush();
      env.enterFullscreen(view.dom);
      env.flush();
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(view.state.doc.eq(initialDoc)).toBe(true);
      expect(view.dom.querySelector("[data-selection-bubble-layer]")).not.toBeNull();
      fireEvent.keyDown(screen.getByRole("button", { name: "Bold" }), { key: "Enter" });
      expect(editorKeydown).not.toHaveBeenCalled();
      const widgetDecorations = view.props.decorations!;
      expect(widgetDecorations.call(view, view.state)).not.toBe(DecorationSet.empty);
      expect(view.state.plugins).toBe(initialPlugins);
      env.enterFullscreen(null);
      env.flush();
      expect(view.state.plugins).toEqual(initialPlugins);
      expect(view.state.doc.eq(initialDoc)).toBe(true);
      env.enterFullscreen(view.dom);
      env.flush();
      rendered.unmount();
      expect(view.state.plugins).toEqual(initialPlugins);
      expect(view.state.doc.eq(initialDoc)).toBe(true);
      expect(widgetDecorations.call(view, view.state)).toBe(DecorationSet.empty);
    } finally {
      rendered.unmount();
      view.destroy();
    }
  });

  it("production suggesting survives repeated fullscreen entry/exit and toolbar removal", async () => {
    // The production binding and every plugin view run with the real editor DOM observer.
    const f = productionFixture();
    const env = environment({ popover: true });
    f.select();
    const rendered = render(<SelectionBubble {...f.props} />);
    try {
      env.flush();
      await f.edit("!");
      f.assertTracked(`${f.source}!`);
      const typingGroup = f.session.suggestions.groups()[0].id;
      const transition = (target: Element | null) => {
        f.select();
        const selection = f.view.state.selection.toJSON();
        env.enterFullscreen(target);
        env.flush();
        expect(f.view.state.selection.toJSON()).toEqual(selection);
        expect(f.view.hasFocus()).toBe(true);
        expect(document.querySelector("[data-selection-bubble-layer]")?.parentElement).toBe(target ?? document.documentElement);
      };

      transition(f.view.dom);
      await f.edit("B", 6, 10);
      f.assertTracked("alpha Bbeta gamma!");
      transition(null);
      await f.edit("?");
      f.assertTracked("alpha Bbeta gamma!?");
      let suffix = "!?";
      for (const [during, after] of [["1", "a"], ["2", "b"]]) {
        transition(f.view.dom);
        await f.edit(during);
        suffix += during;
        f.assertTracked(`alpha Bbeta gamma${suffix}`);
        transition(null);
        await f.edit(after);
        suffix += after;
        f.assertTracked(`alpha Bbeta gamma${suffix}`);
      }
      const groups = f.session.suggestions.groups();
      expect(groups).toHaveLength(3);
      expect(groups.find((group) => group.id === typingGroup)?.after === suffix, "adjacent typing retains its original review group").toBe(true);
      expect(groups.filter((group) => group.type === "delete" && group.before === "beta")).toHaveLength(1);
      expect(groups.filter((group) => group.type === "insert" && group.after === "B")).toHaveLength(1);
      expect(groups.every((group) => !group.outdated && group.authorId === f.session.user.id)).toBe(true);
      f.assertViewsRetained();

      transition(f.view.dom);
      rendered.unmount();
      expect(f.view.props.decorations).toBe(f.decorations);
      expect(document.querySelectorAll("[data-selection-bubble-layer]")).toHaveLength(0);
      await f.edit("Z");
      f.assertTracked(`alpha Bbeta gamma${suffix}Z`);
      f.assertViewsRetained();
    } finally {
      rendered.unmount();
      f.destroy();
    }
  });

  it("production suggesting survives toolbar view replacement and destroyed-view unmount", async () => {
    const first = productionFixture();
    const second = productionFixture();
    const env = environment();
    first.select();
    const rendered = render(<SelectionBubble {...first.props} />);
    try {
      env.enterFullscreen(first.view.dom);
      env.flush();
      await first.edit("1");
      first.assertTracked(`${first.source}1`);
      first.select();
      env.flush();
      const staleDecorations = first.view.props.decorations!;
      const staleFrames = [...env.capturedFrames];
      second.select();
      env.enterFullscreen(second.view.dom);
      rendered.rerender(<SelectionBubble {...second.props} />);
      env.flush();
      expect(first.view.props.decorations).toBe(first.decorations);
      expect(staleDecorations.call(first.view, first.view.state)).toBe(DecorationSet.empty);
      for (const callback of staleFrames) callback(0);
      expect(document.querySelectorAll("[data-selection-bubble-layer]")).toHaveLength(1);
      await second.edit("2");
      second.assertTracked(`${second.source}2`);
      first.assertViewsRetained();
      second.assertViewsRetained();

      // An intervening direct-prop owner must not be overwritten by toolbar cleanup.
      const replacementDecorations = vi.fn(() => DecorationSet.empty);
      second.view.setProps({ decorations: replacementDecorations });
      rendered.rerender(<SelectionBubble {...second.props} view={null} />);
      expect(second.view.props.decorations).toBe(replacementDecorations);
      await second.edit("3");
      second.assertTracked(`${second.source}23`);

      second.select();
      rendered.rerender(<SelectionBubble {...second.props} />);
      env.flush();
      const destroyedDecorations = second.view.props.decorations!;
      second.view.destroy();
      rendered.unmount();
      expect(destroyedDecorations.call(second.view, second.view.state)).toBe(DecorationSet.empty);
      expect(document.querySelectorAll("[data-selection-bubble-layer]")).toHaveLength(0);
      first.select();
      await first.edit("4");
      first.assertTracked(`${first.source}14`);
    } finally {
      rendered.unmount();
      first.destroy();
      second.destroy();
    }
  });

  it.each([0, 1, 16, 17, 55])("removes toolbar paint when only %ipx remain", (width) => {
    const env = environment();
    const f = fixture();
    f.setHost(new DOMRect(100, 100, width, 500));
    const rendered = render(<SelectionBubble {...f.props} />);
    env.flush();
    expect(screen.queryByTestId("selection-bubble")).toBeNull();
    f.setHost(new DOMRect(100, 100, 56, 500));
    window.dispatchEvent(new Event("resize"));
    env.flush();
    expect(screen.getByTestId("selection-bubble").style.width).toBe("40px");
    rendered.unmount();
  });

  it("uses current selection and actual wrapped/image fragments, not only off-screen endpoints", () => {
    const env = environment();
    const f = fixture();
    const rendered = render(<SelectionBubble {...f.props} />);
    f.select(9, 1);
    f.coords.mockImplementation((pos) => pos === 1
      ? { left: -50, right: -50, top: 200, bottom: 220 }
      : { left: 900, right: 900, top: 250, bottom: 270 });
    env.setFragments([new DOMRect(-100, 200, 50, 20), new DOMRect(200, 220, 300, 20), new DOMRect(900, 250, 50, 20)]);
    env.flush();
    expect(screen.getByTestId("selection-bubble")).toBeInTheDocument();
    env.setFragments([new DOMRect(-100, 200, 50, 20), new DOMRect(900, 250, 50, 20)]);
    document.dispatchEvent(new Event("selectionchange"));
    env.flush();
    expect(screen.queryByTestId("selection-bubble")).toBeNull();
    env.setFragments([new DOMRect(120, 150, 200, 200)]);
    document.dispatchEvent(new Event("selectionchange"));
    env.flush();
    expect(screen.getByTestId("selection-bubble")).toBeInTheDocument();
    f.select(1, 1);
    rendered.rerender(<SelectionBubble {...f.props} format={{ ...EMPTY_FORMAT }} />);
    env.flush();
    expect(screen.queryByTestId("selection-bubble")).toBeNull();
  });

  it("keeps six pointer/keyboard actions single-use and applies Bold to a restored publication", async () => {
    const env = environment();
    const f = fixture();
    const user = userEvent.setup();
    render(<SelectionBubble {...f.props} />);
    env.flush();
    expect(screen.getAllByRole("button")).toHaveLength(6);
    for (const [label, mark] of [["Bold", "strong"], ["Italic", "em"], ["Strikethrough", "strikethrough"], ["Inline code", "code"]] as const) {
      await user.click(screen.getByRole("button", { name: label }));
      expect(f.view.state.doc.rangeHasMark(1, 9, schema.marks[mark])).toBe(true);
      screen.getByRole("button", { name: label }).focus();
      await user.keyboard("{Enter}");
      expect(f.view.state.doc.rangeHasMark(1, 9, schema.marks[mark])).toBe(true);
    }
    for (const [label, handler] of [["Link", f.onLink], ["Comment", f.onComment]] as const) {
      await user.click(screen.getByRole("button", { name: label }));
      screen.getByRole("button", { name: label }).focus();
      await user.keyboard(" ");
      expect(handler).toHaveBeenCalledTimes(1);
    }
    f.setHost(new DOMRect(0, 300, 180, 200));
    fireEvent.scroll(f.scroller);
    env.flush();
    expect(screen.queryByTestId("selection-bubble")).toBeNull();
    f.setHost(new DOMRect(0, 100, 180, 500));
    fireEvent.scroll(f.scroller);
    env.flush();
    const bold = screen.getByRole("button", { name: "Bold" });
    expect(bold.closest('[role="toolbar"]')).toHaveClass("overflow-x-auto");
    await user.click(bold);
    expect(f.view.state.doc.rangeHasMark(1, 9, schema.marks.strong)).toBe(false);
    expect(f.view.state.selection.from).toBe(1);
    expect(f.view.state.selection.to).toBe(9);
  });

  it("keeps all captured callbacks and frames inert after 1000 mount/replace/unmount cycles", async () => {
    const env = environment({ popover: true });
    const first = fixture();
    const second = fixture();
    for (let cycle = 0; cycle < 1000; cycle++) {
      const rendered = render(<SelectionBubble {...first.props} />);
      env.flush();
      window.dispatchEvent(new Event("resize"));
      rendered.rerender(<SelectionBubble {...second.props} />);
      env.flush();
      window.dispatchEvent(new Event("resize"));
      rendered.unmount();
      rendered.container.remove();
    }
    expect(env.resizes).toHaveLength(2000);
    expect(env.mutations).toHaveLength(2000);
    expect(env.listeners).toHaveLength(30000);
    expect(env.listeners.every((entry) => entry.removed === 1)).toBe(true);
    expect(env.resizes.every((observer) => observer.targets.size === 0 && observer.disconnect.mock.calls.length === 1)).toBe(true);
    expect(env.mutations.every((observer) => observer.targets.size === 0 && observer.disconnect.mock.calls.length === 1)).toBe(true);
    expect(env.opened.size).toBe(0);
    expect(document.querySelectorAll("[data-selection-bubble-layer]")).toHaveLength(0);
    const before = {
      frames: env.request.mock.calls.length,
      listeners: env.listeners.length,
      resizes: env.resizes.length,
      mutations: env.mutations.length,
      states: stateWrites.count,
      reads: first.stateRead.mock.calls.length + second.stateRead.mock.calls.length + first.domRead.mock.calls.length + second.domRead.mock.calls.length + env.layoutRead.mock.calls.length,
    };
    env.replay();
    await act(async () => { env.ready.resolve(); await env.ready.promise; });
    expect(env.request).toHaveBeenCalledTimes(before.frames);
    expect(env.listeners).toHaveLength(before.listeners);
    expect(env.resizes).toHaveLength(before.resizes);
    expect(env.mutations).toHaveLength(before.mutations);
    expect(stateWrites.count).toBe(before.states);
    expect(first.stateRead.mock.calls.length + second.stateRead.mock.calls.length + first.domRead.mock.calls.length + second.domRead.mock.calls.length + env.layoutRead.mock.calls.length).toBe(before.reads);
    expect(env.frames.size).toBe(0);
    expect(env.opened.size).toBe(0);
    expect(document.querySelectorAll("[data-selection-bubble-layer]")).toHaveLength(0);
  }, 60_000);
});
