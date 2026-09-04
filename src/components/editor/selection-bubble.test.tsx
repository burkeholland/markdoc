// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { EditorView } from "prosemirror-view";
import type { CollabSession } from "@/editor/collab/session";
import type { EditorActions } from "./actions";
import { EMPTY_FORMAT } from "./actions";
import { SelectionBubble } from "./selection-bubble";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("SelectionBubble geometry scheduling", () => {
  it("coalesces geometry events and removes every observer, listener and queued frame", () => {
    let nextFrame = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const cancelFrame = vi.fn((id: number) => frames.delete(id));
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    }));
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);

    const resizeObservers: Array<{ observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class TestResizeObserver {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: ResizeObserverCallback) {
        resizeObservers.push(this);
        resizeCallbacks.push(callback);
      }
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const mutationObservers: Array<{ observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
    const mutationCallbacks: MutationCallback[] = [];
    class TestMutationObserver {
      observe = vi.fn();
      disconnect = vi.fn();
      takeRecords() {
        return [];
      }
      constructor(callback: MutationCallback) {
        mutationObservers.push(this);
        mutationCallbacks.push(callback);
      }
    }
    vi.stubGlobal("MutationObserver", TestMutationObserver);

    const visualViewport = Object.assign(new EventTarget(), {
      offsetLeft: 0,
      offsetTop: 0,
      width: 800,
      height: 600,
      scale: 1,
      pageLeft: 0,
      pageTop: 0,
      onresize: null,
      onscroll: null,
    }) as VisualViewport;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visualViewport });

    const scroller = document.createElement("div");
    const editor = document.createElement("div");
    const replacementEditor = document.createElement("div");
    document.body.append(scroller, editor, replacementEditor);
    const scrollerAdd = vi.spyOn(scroller, "addEventListener");
    const scrollerRemove = vi.spyOn(scroller, "removeEventListener");
    const editorRemove = vi.spyOn(editor, "removeEventListener");
    const replacementEditorRemove = vi.spyOn(replacementEditor, "removeEventListener");
    const documentAdd = vi.spyOn(document, "addEventListener");
    const documentRemove = vi.spyOn(document, "removeEventListener");
    const windowAdd = vi.spyOn(window, "addEventListener");
    const windowRemove = vi.spyOn(window, "removeEventListener");
    const visualAdd = vi.spyOn(visualViewport, "addEventListener");
    const visualRemove = vi.spyOn(visualViewport, "removeEventListener");

    const view = {
      dom: editor,
      state: { selection: { from: 1, to: 2, empty: false } },
      hasFocus: () => true,
      coordsAtPos: () => ({ left: 100, right: 101, top: 200, bottom: 220 }),
    } as unknown as EditorView;
    const replacementView = { ...view, dom: replacementEditor } as unknown as EditorView;
    const session = { activeSurface: "rich", canEdit: true, canComment: true } as CollabSession;
    const props = (currentView: EditorView) => (
      <SelectionBubble
        view={currentView}
        session={session}
        actions={{} as EditorActions}
        format={EMPTY_FORMAT}
        containerRef={{ current: scroller }}
        onComment={vi.fn()}
        onLink={vi.fn()}
      />
    );
    const rendered = render(props(view));

    expect(frames.size).toBe(1);
    scroller.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    visualViewport.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("selectionchange"));
    resizeCallbacks[0]([], resizeObservers[0] as unknown as ResizeObserver);
    mutationCallbacks[0]([], mutationObservers[0] as unknown as MutationObserver);
    expect(frames.size).toBe(1);

    const capturedScroll = windowAdd.mock.calls.find(
      ([type, , options]) => type === "scroll" && typeof options === "object" && options?.capture,
    );
    expect(capturedScroll).toBeDefined();
    rendered.rerender(props(replacementView));
    expect(frames.size).toBe(1);
    expect(resizeObservers).toHaveLength(2);
    expect(mutationObservers).toHaveLength(2);
    expect(resizeObservers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(mutationObservers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(editorRemove).toHaveBeenCalledWith("blur", expect.any(Function));
    rendered.unmount();

    for (const [, listener] of scrollerAdd.mock.calls.filter(([type]) => type === "scroll")) {
      expect(scrollerRemove).toHaveBeenCalledWith("scroll", listener);
    }
    for (const [, listener] of windowAdd.mock.calls.filter(
      ([type, , options]) => type === "scroll" && typeof options === "object" && options?.capture,
    )) {
      expect(windowRemove).toHaveBeenCalledWith("scroll", listener, true);
    }
    for (const type of ["resize", "pointerdown", "pointerup", "pointercancel"]) {
      const added = windowAdd.mock.calls.filter(
        ([event, , options]) => event === type && typeof options === "object" && options?.passive,
      );
      expect(added, `${type} was registered`).toHaveLength(2);
      for (const [, listener] of added) expect(windowRemove).toHaveBeenCalledWith(type, listener);
    }
    for (const type of ["resize", "scroll"]) {
      const added = visualAdd.mock.calls.filter(([event]) => event === type);
      expect(added, `visualViewport ${type} was registered`).toHaveLength(2);
      for (const [, listener] of added) expect(visualRemove).toHaveBeenCalledWith(type, listener);
    }
    const geometryListeners = scrollerAdd.mock.calls.filter(([event]) => event === "scroll").map(([, listener]) => listener);
    expect(geometryListeners).toHaveLength(2);
    for (const listener of geometryListeners) {
      expect(documentAdd).toHaveBeenCalledWith("selectionchange", listener);
      expect(documentRemove).toHaveBeenCalledWith("selectionchange", listener);
    }
    for (const observer of resizeObservers) {
      expect(observer.observe).toHaveBeenCalledWith(scroller);
      expect(observer.disconnect).toHaveBeenCalledTimes(1);
    }
    expect(mutationObservers[0].observe).toHaveBeenCalledWith(editor, { childList: true, characterData: true, subtree: true });
    expect(mutationObservers[1].observe).toHaveBeenCalledWith(replacementEditor, { childList: true, characterData: true, subtree: true });
    for (const observer of mutationObservers) expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(replacementEditorRemove).toHaveBeenCalledWith("blur", expect.any(Function));
    expect(cancelFrame).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(0);
  });
});
