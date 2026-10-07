// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type SetStateAction } from "react";
import { EditorState, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import * as Y from "yjs";
import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import { SUGGESTIONS_ORIGIN } from "@/editor/collab/suggestions";
import { schema } from "@/editor/markdown/schema";
import { createRichEditorState } from "@/editor/prosemirror/setup";
import { EditorActions, EMPTY_FORMAT } from "./actions";
import { SelectionBubble } from "./selection-bubble";
import { budgetMs } from "../../../scripts/lib/test-budget";

const screen = within(document.documentElement);
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
  // The shared text holds the paragraph as it is: source offset n is editor position n + 1.
  const ytext = new Y.Doc().getText("content");
  ytext.insert(0, paragraph.textContent);
  const binding = { getSourceMap: () => ({ pmToSrc: (pos: number) => pos - 1, srcToPm: (offset: number) => offset + 1 }) };
  const session = { activeSurface: "rich", canEdit: true, canComment: true, undoManager: { stopCapturing: vi.fn() }, ytext, binding } as unknown as CollabSession;
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
    const rendered = render(<SelectionBubble {...f.props} />);
    env.flush();
    const replacement = document.createElement("div");
    replacement.append(f.editor);
    document.body.append(replacement);
    Object.defineProperty(replacement, "getBoundingClientRect", { configurable: true, value: vi.fn(() => new DOMRect(50, 100, 180, 500)) });
    f.props.containerRef.current = replacement;
    rendered.rerender(<SelectionBubble {...f.props} />);
    env.flush();
    expect(env.resizes[0].disconnect).toHaveBeenCalledTimes(1);
    expect(env.resizes[1].targets.has(replacement)).toBe(true);
    expect(env.resizes[1].targets.has(f.scroller)).toBe(false);
    expect(screen.getByTestId("selection-bubble").style.width).toBe("164px");
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

  it("keeps six pointer/keyboard actions and applies Bold to the restored selection", async () => {
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
      expect(f.view.state.doc.rangeHasMark(1, 9, schema.marks[mark])).toBe(false);
    }
    for (const [label, handler] of [["Link", f.onLink], ["Comment", f.onComment]] as const) {
      screen.getByRole("button", { name: label }).focus();
      await user.keyboard(" ");
      await user.click(screen.getByRole("button", { name: label }));
      expect(handler).toHaveBeenCalledTimes(2);
    }
    // The pointer click on Comment took the bubble away until the editor loses focus, as it does to the composer.
    expect(screen.queryByTestId("selection-bubble")).toBeNull();
    fireEvent.blur(f.editor);
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
    expect(f.view.state.doc.rangeHasMark(1, 9, schema.marks.strong)).toBe(true);
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
  }, budgetMs(60_000));
});

describe("SelectionBubble keyboard and permissions", () => {
  const LABELS = ["Bold", "Italic", "Strikethrough", "Inline code", "Link", "Comment"] as const;
  const button = (label: string) => screen.getByRole("button", { name: label }) as HTMLButtonElement;
  const focusButton = (label: string) => act(() => button(label).focus());
  const tabStops = () => LABELS.filter((label) => button(label).tabIndex === 0);

  it.each([
    ["ArrowRight", "Bold", "Italic"],
    ["ArrowDown", "Italic", "Strikethrough"],
    ["ArrowLeft", "Inline code", "Strikethrough"],
    ["ArrowUp", "Strikethrough", "Italic"],
    ["Home", "Link", "Bold"],
    ["End", "Italic", "Comment"],
    ["ArrowRight", "Comment", "Bold"],
    ["ArrowLeft", "Bold", "Comment"],
  ] as const)("moves %s from %s to %s and keeps one tab stop", (key, from, to) => {
    const env = environment();
    const f = fixture();
    render(<SelectionBubble {...f.props} />);
    env.flush();
    expect(tabStops()).toEqual(["Bold"]);
    expect(screen.getByRole("toolbar", { name: "Selection" })).not.toHaveAttribute("tabindex");
    focusButton(from);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    expect(fireEvent.keyDown(button(from), { key })).toBe(false);
    expect(button(to)).toHaveFocus();
    expect(focus.mock.calls).toEqual([[{ preventScroll: true }]]);
    expect(tabStops()).toEqual([to]);
    expect(f.onLink).not.toHaveBeenCalled();
    expect(f.onComment).not.toHaveBeenCalled();
  });

  it("follows held arrows and leaves modified, composing, boundary and other keys alone", () => {
    const env = environment();
    const f = fixture();
    render(<SelectionBubble {...f.props} />);
    env.flush();
    focusButton("Bold");
    for (const label of ["Italic", "Strikethrough", "Inline code"]) {
      expect(fireEvent.keyDown(document.activeElement!, { key: "ArrowRight", repeat: true })).toBe(false);
      expect(button(label)).toHaveFocus();
    }
    for (const init of [
      { key: "ArrowRight", shiftKey: true },
      { key: "ArrowRight", ctrlKey: true },
      { key: "ArrowRight", altKey: true },
      { key: "ArrowRight", metaKey: true },
      { key: "ArrowRight", isComposing: true },
      { key: " " },
      { key: "a" },
    ]) {
      expect(fireEvent.keyDown(button("Inline code"), init)).toBe(true);
      expect(button("Inline code")).toHaveFocus();
    }
    // Tab and Shift+Tab hand focus back to the editor instead of leaving the page.
    const focusEditor = vi.spyOn(f.actions, "focus");
    expect(fireEvent.keyDown(button("Inline code"), { key: "Tab" })).toBe(false);
    expect(fireEvent.keyDown(button("Inline code"), { key: "Tab", shiftKey: true })).toBe(false);
    expect(focusEditor).toHaveBeenCalledTimes(2);
    expect(fireEvent.keyDown(button("Inline code"), { key: "Tab", ctrlKey: true })).toBe(true);
    expect(focusEditor).toHaveBeenCalledTimes(2);
    focusButton("Bold");
    expect(fireEvent.keyDown(button("Bold"), { key: "Home" })).toBe(true);
    focusButton("Comment");
    expect(fireEvent.keyDown(button("Comment"), { key: "End" })).toBe(true);
  });

  it("skips disabled buttons and keeps a moved tab stop when permissions return", async () => {
    const env = environment();
    const f = fixture();
    const session = f.session as unknown as { canEdit: boolean; canComment: boolean };
    session.canEdit = false;
    const rendered = render(<SelectionBubble {...f.props} />);
    env.flush();
    for (const label of LABELS.slice(0, 5)) expect(button(label)).toBeDisabled();
    expect(tabStops()).toEqual(["Comment"]);
    expect(fireEvent.keyDown(button("Comment"), { key: "ArrowRight" })).toBe(true);

    session.canEdit = true;
    rendered.rerender(<SelectionBubble {...f.props} />);
    expect(tabStops()).toEqual(["Comment"]);
    focusButton("Comment");
    fireEvent.keyDown(button("Comment"), { key: "ArrowRight" });
    expect(tabStops()).toEqual(["Bold"]);

    session.canComment = false;
    rendered.rerender(<SelectionBubble {...f.props} />);
    expect(button("Comment")).toBeDisabled();
    focusButton("Link");
    fireEvent.keyDown(button("Link"), { key: "ArrowRight" });
    expect(button("Bold")).toHaveFocus();
    fireEvent.keyDown(button("Bold"), { key: "ArrowLeft" });
    expect(button("Link")).toHaveFocus();
  });

  it("checks permissions and the pane when the click lands, not only when it rendered", async () => {
    const env = environment();
    const f = fixture();
    const user = userEvent.setup();
    const session = f.session as unknown as { canEdit: boolean; canComment: boolean; activeSurface: string };
    render(<SelectionBubble {...f.props} />);
    env.flush();

    session.canEdit = false;
    session.canComment = false;
    for (const label of LABELS) await user.click(button(label));
    session.canEdit = true;
    session.canComment = true;
    session.activeSurface = "code";
    for (const label of LABELS) await user.click(button(label));
    expect(f.view.state.doc.rangeHasMark(1, 9, schema.marks.strong)).toBe(false);
    expect(f.onLink).not.toHaveBeenCalled();
    expect(f.onComment).not.toHaveBeenCalled();

    session.activeSurface = "rich";
    await user.click(button("Bold"));
    await user.click(button("Comment"));
    expect(f.view.state.doc.rangeHasMark(1, 9, schema.marks.strong)).toBe(true);
    expect(f.onComment).toHaveBeenCalledTimes(1);
  });

  it("Enter acts once, on release, however long it is held; Ctrl, Alt and Meta+Enter do nothing", () => {
    const env = environment();
    const f = fixture();
    const toggleMark = vi.spyOn(f.actions, "toggleMark");
    render(<SelectionBubble {...f.props} />);
    env.flush();
    focusButton("Bold");
    expect(fireEvent.keyDown(button("Bold"), { key: "Enter" })).toBe(false);
    for (let i = 0; i < 5; i++) expect(fireEvent.keyDown(button("Bold"), { key: "Enter", repeat: true })).toBe(false);
    expect(toggleMark).not.toHaveBeenCalled();
    fireEvent.keyUp(button("Bold"), { key: "Enter" });
    expect(toggleMark.mock.calls).toEqual([["strong"]]);

    for (const modifier of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      fireEvent.keyDown(button("Bold"), { key: "Enter", ...modifier });
      fireEvent.keyUp(button("Bold"), { key: "Enter", ...modifier });
    }
    // Enter that went down on another button.
    fireEvent.keyDown(button("Bold"), { key: "Enter" });
    focusButton("Italic");
    fireEvent.keyUp(button("Italic"), { key: "Enter" });
    expect(toggleMark).toHaveBeenCalledTimes(1);
  });

  it("a pointer click on Comment hides the bubble at once and keeps its place; no other button and no keyboard click does", async () => {
    const env = environment();
    const f = fixture();
    const user = userEvent.setup();
    const rendered = render(<SelectionBubble {...f.props} />);
    env.flush();
    const rerender = () => {
      rendered.rerender(<SelectionBubble {...f.props} format={{ ...EMPTY_FORMAT }} />);
      env.flush();
    };
    const hideBubble = () => {
      f.select(1, 1);
      rerender();
      expect(screen.queryByTestId("selection-bubble")).toBeNull();
    };
    const showBubble = () => {
      f.select(1, 9);
      rerender();
      expect(screen.getByTestId("selection-bubble")).toBeInTheDocument();
    };

    // The format buttons and Link leave the bubble where it is: when it goes later, nothing keeps its place.
    for (const label of ["Bold", "Italic", "Strikethrough", "Inline code", "Link"]) {
      await user.click(button(label));
      hideBubble();
      expect(screen.queryByTestId("place-hold"), label).toBeNull();
      showBubble();
    }
    expect(f.onLink).toHaveBeenCalledTimes(1);

    // Comment: the bubble is gone in the same click, with no frame in between, and the box is in its place.
    vi.spyOn(screen.getByTestId("selection-bubble"), "getBoundingClientRect").mockReturnValue(new DOMRect(60, 150, 232, 40));
    await user.click(button("Comment"));
    expect(f.onComment).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("selection-bubble")).toBeNull();
    const box = screen.getByTestId("place-hold");
    expect(box).toHaveStyle({ left: "60px", top: "150px", width: "232px", height: "40px" });
    expect(box).toBeEmptyDOMElement();
    expect(box).toHaveAttribute("aria-hidden", "true");
    expect(fireEvent.mouseDown(box)).toBe(false);
    fireEvent.click(box, { detail: 2 });
    expect(f.onComment).toHaveBeenCalledTimes(1);

    // The same selection with focus still in the editor: the bubble stays away, whatever asks for it.
    rerender();
    fireEvent.scroll(f.scroller);
    env.flush();
    expect(screen.queryByTestId("selection-bubble")).toBeNull();

    // The selection changes: the bubble is back, and the box goes.
    f.select(2, 9);
    rerender();
    expect(screen.getByTestId("selection-bubble")).toBeInTheDocument();
    expect(screen.queryByTestId("place-hold")).toBeNull();

    // The editor loses focus (the composer took it) and gets it back on the same selection: the bubble is back.
    await user.click(button("Comment"));
    expect(screen.queryByTestId("selection-bubble")).toBeNull();
    fireEvent.blur(f.editor);
    rerender();
    expect(screen.getByTestId("selection-bubble")).toBeInTheDocument();

    // A press in the text ends it too.
    await user.click(button("Comment"));
    expect(screen.queryByTestId("selection-bubble")).toBeNull();
    fireEvent.pointerDown(f.paragraph);
    fireEvent.pointerUp(f.paragraph);
    env.flush();
    expect(screen.getByTestId("selection-bubble")).toBeInTheDocument();
    expect(screen.queryByTestId("place-hold"), "a press on anything else takes the box away").toBeNull();
    expect(f.onComment).toHaveBeenCalledTimes(3);

    // A click from the keyboard has its focus on the button: the bubble stays, and no box follows it.
    focusButton("Comment");
    await user.keyboard("{Enter}");
    expect(f.onComment).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId("selection-bubble")).toBeInTheDocument();
    hideBubble();
    expect(screen.queryByTestId("place-hold")).toBeNull();
  });

  it("a Comment click that is not allowed hides nothing and keeps no place", async () => {
    const env = environment();
    const f = fixture();
    const user = userEvent.setup();
    const session = f.session as unknown as { canComment: boolean; activeSurface: string };
    render(<SelectionBubble {...f.props} />);
    env.flush();
    session.canComment = false;
    await user.click(button("Comment"));
    session.canComment = true;
    session.activeSurface = "code";
    await user.click(button("Comment"));
    expect(f.onComment).not.toHaveBeenCalled();
    expect(screen.getByTestId("selection-bubble")).toBeInTheDocument();
    expect(screen.queryByTestId("place-hold")).toBeNull();
  });

  it("runs each action exactly once per click, Enter and Space under Strict Mode", async () => {
    const env = environment();
    const f = fixture();
    const user = userEvent.setup();
    const toggleMark = vi.spyOn(f.actions, "toggleMark");
    render(<StrictMode><SelectionBubble {...f.props} /></StrictMode>);
    env.flush();
    await user.click(button("Bold"));
    focusButton("Italic");
    await user.keyboard("{Enter}");
    focusButton("Inline code");
    await user.keyboard(" ");
    await user.click(button("Link"));
    expect(toggleMark.mock.calls).toEqual([["strong"], ["em"], ["code"]]);
    expect(f.onLink).toHaveBeenCalledTimes(1);
    expect(f.view.state.selection.from).toBe(1);
    expect(f.view.state.selection.to).toBe(9);
  });
});

describe("SelectionBubble after a pointer Comment, while edits land around the selection (#2258)", () => {
  const button = (label: string) => screen.getByRole("button", { name: label }) as HTMLButtonElement;
  /** An edit made by someone else: it arrives as an update, the way the socket delivers it. */
  function remoteEdit(session: CollabSession, from: number, to: number, insert = "") {
    act(() => {
      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(session.ydoc));
      const known = Y.encodeStateVector(session.ydoc);
      const text = remote.getText("content");
      if (to > from) text.delete(from, to - from);
      if (insert) text.insert(from, insert);
      Y.applyUpdate(session.ydoc, Y.encodeStateAsUpdate(remote, known));
      remote.destroy();
    });
  }

  it("stays away while the selection is still the same text, and comes back when the selection or the focus changes", () => {
    // The production session, binding and editor: "alpha beta gamma" with "beta" selected.
    const f = productionFixture();
    const env = environment();
    const selected = () => f.view.state.doc.textBetween(f.view.state.selection.from, f.view.state.selection.to);
    const select = (from: number, to: number) => {
      act(() => {
        f.view.dispatch(f.view.state.tr.setSelection(TextSelection.create(f.view.state.doc, from, to)));
        f.view.focus();
      });
    };
    /** The page moved or changed: every signal the bubble listens to asks for a new place. */
    const settle = () => {
      act(() => {
        for (const observer of env.mutations) observer.fire();
        document.dispatchEvent(new Event("selectionchange"));
      });
      env.flush();
    };
    const comment = () => {
      settle();
      expect(screen.getByTestId("selection-bubble")).toBeInTheDocument();
      fireEvent.click(button("Comment"), { detail: 1 });
      expect(screen.queryByTestId("selection-bubble")).toBeNull();
    };
    select(7, 11);
    const rendered = render(<SelectionBubble {...f.props} />);
    try {
      expect(selected()).toBe("beta");
      comment();
      expect(f.props.onComment).toHaveBeenCalledTimes(1);

      // A collaborator types and deletes before the selection: its positions move, its text does not.
      remoteEdit(f.session, 0, 0, "Remote ");
      settle();
      expect(selected()).toBe("beta");
      expect(f.view.state.selection.from, "the positions did move").toBe(14);
      expect(screen.queryByTestId("selection-bubble"), "typed before the selection").toBeNull();
      for (let i = 0; i < 20; i++) {
        remoteEdit(f.session, 3, 3, "w");
        settle();
        expect(screen.queryByTestId("selection-bubble"), `key ${i + 1} before the selection`).toBeNull();
      }
      remoteEdit(f.session, 0, 10, "");
      settle();
      expect(selected()).toBe("beta");
      expect(screen.queryByTestId("selection-bubble"), "deleted before the selection").toBeNull();
      // Typed inside it: the selection and the commented text grow together.
      remoteEdit(f.session, f.session.ytext.toString().indexOf("beta") + 2, f.session.ytext.toString().indexOf("beta") + 2, "XY");
      settle();
      expect(selected()).toBe("beXYta");
      expect(screen.queryByTestId("selection-bubble"), "typed inside the selection").toBeNull();
      // Typed after it.
      remoteEdit(f.session, f.session.ytext.length, f.session.ytext.length, " tail");
      settle();
      expect(screen.queryByTestId("selection-bubble"), "typed after the selection").toBeNull();

      // The person changes the selection: the bubble is back.
      select(f.view.state.selection.from, f.view.state.selection.to + 1);
      settle();
      expect(screen.getByTestId("selection-bubble")).toBeInTheDocument();

      // The editor loses focus (the composer took it) and gets it back on the same selection: the bubble is back.
      comment();
      remoteEdit(f.session, 0, 0, "Again ");
      settle();
      expect(screen.queryByTestId("selection-bubble")).toBeNull();
      act(() => {
        (f.view.dom as HTMLElement).blur();
        f.view.focus();
      });
      settle();
      expect(screen.getByTestId("selection-bubble")).toBeInTheDocument();
    } finally {
      rendered.unmount();
      f.destroy();
    }
  });
});