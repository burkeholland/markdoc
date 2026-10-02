// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, within } from "@testing-library/react";
import { StrictMode, useEffect, useLayoutEffect, type ReactNode, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import type { EditorView } from "prosemirror-view";
import type { CollabSession } from "@/editor/collab/session";
import type { EditorActions, FormatState, TableCommand } from "./actions";

const setup = vi.hoisted(() => ({
  hidden: vi.fn(() => false),
}));

vi.mock("@/editor/prosemirror/setup", () => ({
  isTableMenuHidden: setup.hidden,
  TABLE_MENU_EVENT: "markdoc:table-menu",
}));

vi.mock("@/components/ui/primitives", () => ({
  Tip: ({ children }: { children: ReactNode }) => children,
}));

import { TableMenu } from "./table-menu";

const TABLE_MENU_EVENT = "markdoc:table-menu";
const screen = within(document.documentElement);

interface OwnedListener {
  target: EventTarget;
  type: string;
  callback: EventListener;
  removed: number;
}

function controlledBrowser() {
  let nextFrame = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const capturedFrames = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    capturedFrames.set(id, callback);
    return id;
  });
  const cancel = vi.fn((id: number) => {
    frames.delete(id);
  });
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);

  const listeners: OwnedListener[] = [];
  const trackAdd = (target: EventTarget, type: string, callback: EventListenerOrEventListenerObject | null) => {
    if (typeof callback === "function" && callback.name === "schedule") {
      listeners.push({ target, type, callback, removed: 0 });
    }
  };
  const trackRemove = (target: EventTarget, type: string, callback: EventListenerOrEventListenerObject | null) => {
    if (typeof callback !== "function" || callback.name !== "schedule") return;
    const owned = listeners.findLast(
      (entry) => entry.target === target && entry.type === type && entry.callback === callback && entry.removed === 0,
    );
    if (owned) owned.removed++;
  };
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (this: EventTarget, type, callback, options) {
    trackAdd(this, type, callback);
    add.call(this, type, callback, options);
  });
  vi.spyOn(EventTarget.prototype, "removeEventListener").mockImplementation(function (this: EventTarget, type, callback, options) {
    trackRemove(this, type, callback);
    remove.call(this, type, callback, options);
  });
  // jsdom's Window methods do not delegate through EventTarget.prototype.
  const windowAdd = window.addEventListener;
  const windowRemove = window.removeEventListener;
  vi.spyOn(window, "addEventListener").mockImplementation((type, callback, options) => {
    trackAdd(window, type, callback);
    windowAdd.call(window, type, callback, options);
  });
  vi.spyOn(window, "removeEventListener").mockImplementation((type, callback, options) => {
    trackRemove(window, type, callback);
    windowRemove.call(window, type, callback, options);
  });

  const flush = () => {
    const pending = [...frames];
    frames.clear();
    act(() => {
      for (const [, callback] of pending) callback(0);
    });
  };

  return { frames, capturedFrames, request, cancel, listeners, flush };
}

interface Fixture {
  view: EditorView;
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  /** What the editor reports when a click lands; the rendered `format` unless a test replaces it. */
  live: { format: FormatState };
  containerRef: RefObject<HTMLElement | null>;
  container: HTMLElement;
  editor: HTMLElement;
  stateRead: ReturnType<typeof vi.fn>;
  domRead: ReturnType<typeof vi.fn>;
  destroyedRead: ReturnType<typeof vi.fn>;
  nodeDOM: ReturnType<typeof vi.fn>;
  tableRect: ReturnType<typeof vi.fn>;
  hostRect: ReturnType<typeof vi.fn>;
  tableAction: ReturnType<typeof vi.fn<(command: TableCommand) => void>>;
  alignAction: ReturnType<typeof vi.fn<(align: "left" | "center" | "right" | null) => void>>;
}

function fixture({
  host,
  tableBox,
  align = null,
}: {
  host: DOMRect;
  tableBox: DOMRect;
  align?: FormatState["tableAlign"];
}): Fixture {
  const container = document.createElement("div");
  const editor = document.createElement("div");
  const wrapper = document.createElement("div");
  const table = document.createElement("table");
  wrapper.append(table);
  editor.append(wrapper);
  container.append(editor);
  document.body.append(container);
  Object.defineProperties(container, {
    clientWidth: { configurable: true, value: 800 },
    scrollTop: { configurable: true, value: 20, writable: true },
  });
  const hostRect = vi.fn(() => host);
  const tableRect = vi.fn(() => tableBox);
  Object.defineProperty(container, "getBoundingClientRect", { configurable: true, value: hostRect });
  Object.defineProperty(table, "getBoundingClientRect", { configurable: true, value: tableRect });

  const stateRead = vi.fn(() => ({ tableMenuHidden: false }));
  const domRead = vi.fn(() => editor);
  const destroyedRead = vi.fn(() => false);
  const nodeDOM = vi.fn(() => wrapper);
  const view = {
    get dom() {
      return domRead();
    },
    get state() {
      return stateRead();
    },
    get isDestroyed() {
      return destroyedRead();
    },
    nodeDOM,
  } as unknown as EditorView;

  const subscribers = new Set<() => void>();
  const session = {
    canEdit: true,
    activeSurface: "rich",
    subscribe: (listener: () => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  } as unknown as CollabSession;
  const tableAction = vi.fn<(command: TableCommand) => void>();
  const alignAction = vi.fn<(value: "left" | "center" | "right" | null) => void>();
  const live = {} as { format: FormatState };
  const actions = {
    table: tableAction,
    setColumnAlign: alignAction,
    formatState: () => live.format,
  } as unknown as EditorActions;
  const format: FormatState = {
    strong: false,
    em: false,
    code: false,
    strike: false,
    link: false,
    heading: 0,
    bullet: false,
    ordered: false,
    task: false,
    quote: false,
    codeBlock: false,
    hasSelection: false,
    tablePos: 7,
    tableAlign: align,
  };
  live.format = format;
  return {
    view,
    session,
    actions,
    format,
    live,
    containerRef: { current: container },
    container,
    editor,
    stateRead,
    domRead,
    destroyedRead,
    nodeDOM,
    tableRect,
    hostRect,
    tableAction,
    alignAction,
  };
}

function Boundary({
  current,
  present = true,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  current: Fixture;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => onPassiveCleanup, [boundary, onPassiveCleanup]);
  return (
    <>
      {present ? (
        <TableMenu
          view={current.view}
          session={current.session}
          actions={current.actions}
          format={current.format}
          containerRef={current.containerRef}
        />
      ) : null}
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setup.hidden.mockClear();
  document.body.replaceChildren();
});

describe("TableMenu geometry ownership", () => {
  it("retires exact listeners and frames before parent layout boundaries while current events coalesce", () => {
    const browser = controlledBrowser();
    const first = fixture({
      host: new DOMRect(10, 100, 800, 600),
      tableBox: new DOMRect(110, 300, 500, 300),
    });
    const second = fixture({
      host: new DOMRect(50, 120, 800, 600),
      tableBox: new DOMRect(400, 360, 500, 300),
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error ?? event.message);
    const onRejection = (event: PromiseRejectionEvent) => errors.push(event.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    let passiveCleanups = 0;
    const recordPassiveCleanup = () => {
      passiveCleanups++;
    };

    try {
      act(() => root.render(<Boundary current={first} onPassiveCleanup={recordPassiveCleanup} />));
      expect(browser.request).toHaveBeenCalledTimes(1);
      expect(browser.listeners).toHaveLength(3);
      expect(browser.listeners.map(({ target, type }) => [target, type])).toEqual([
        [first.container, "scroll"],
        [window, "resize"],
        [first.editor, TABLE_MENU_EVENT],
      ]);
      browser.flush();
      const initial = screen.getByTestId("table-menu");
      expect(initial).toHaveStyle({ left: "100px", top: "172px", width: "372px" });
      expect(first.stateRead).toHaveBeenCalledTimes(1);
      expect(first.domRead).toHaveBeenCalledTimes(1);
      expect(first.destroyedRead).toHaveBeenCalledTimes(1);
      expect(first.nodeDOM).toHaveBeenCalledTimes(1);
      expect(first.tableRect).toHaveBeenCalledTimes(1);
      expect(first.hostRect).toHaveBeenCalledTimes(1);

      first.container.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));
      first.editor.dispatchEvent(new Event(TABLE_MENU_EVENT));
      expect(browser.request).toHaveBeenCalledTimes(2);
      expect(browser.frames.size).toBe(1);
      const staleFrame = browser.capturedFrames.get(2)!;
      const oldReads = {
        state: first.stateRead.mock.calls.length,
        dom: first.domRead.mock.calls.length,
        destroyed: first.destroyedRead.mock.calls.length,
        nodeDOM: first.nodeDOM.mock.calls.length,
        table: first.tableRect.mock.calls.length,
        host: first.hostRect.mock.calls.length,
      };
      const oldListeners = [...browser.listeners];
      let replacementBoundaries = 0;

      act(() => {
        root.render(
          <Boundary
            current={second}
            boundary={1}
            onPassiveCleanup={recordPassiveCleanup}
            onBoundary={() => {
              replacementBoundaries++;
              expect(passiveCleanups).toBe(0);
              expect(oldListeners.every((listener) => listener.removed === 1)).toBe(true);
              expect(host.querySelector("[data-testid=table-menu]")).toBeNull();
              const scheduled = browser.request.mock.calls.length;
              first.container.dispatchEvent(new Event("scroll"));
              first.editor.dispatchEvent(new Event(TABLE_MENU_EVENT));
              window.dispatchEvent(new Event("resize"));
              for (const listener of oldListeners) listener.callback.call(listener.target, new Event(listener.type));
              expect(browser.request).toHaveBeenCalledTimes(scheduled);
            }}
          />,
        );
      });
      expect(replacementBoundaries).toBe(1);
      expect(passiveCleanups).toBe(1);
      expect(browser.listeners).toHaveLength(6);
      expect(browser.listeners.slice(3).map(({ target, type }) => [target, type])).toEqual([
        [second.container, "scroll"],
        [window, "resize"],
        [second.editor, TABLE_MENU_EVENT],
      ]);
      expect(browser.cancel).toHaveBeenNthCalledWith(1, 2);
      expect(browser.frames.size).toBe(1);
      expect(browser.request).toHaveBeenCalledTimes(3);
      expect(() => staleFrame(0)).not.toThrow();
      expect(host.querySelector("[data-testid=table-menu]")).toBeNull();
      expect(first.stateRead).toHaveBeenCalledTimes(oldReads.state);
      expect(first.domRead).toHaveBeenCalledTimes(oldReads.dom);
      expect(first.destroyedRead).toHaveBeenCalledTimes(oldReads.destroyed);
      expect(first.nodeDOM).toHaveBeenCalledTimes(oldReads.nodeDOM);
      expect(first.tableRect).toHaveBeenCalledTimes(oldReads.table);
      expect(first.hostRect).toHaveBeenCalledTimes(oldReads.host);

      browser.flush();
      const current = screen.getByTestId("table-menu");
      expect(current).toHaveStyle({ left: "350px", top: "212px", width: "372px" });
      expect(screen.queryAllByTestId("table-menu")).toHaveLength(1);
      expect(second.stateRead).toHaveBeenCalledTimes(1);
      expect(second.domRead).toHaveBeenCalledTimes(1);
      expect(second.destroyedRead).toHaveBeenCalledTimes(1);
      expect(second.nodeDOM).toHaveBeenCalledTimes(1);
      expect(second.tableRect).toHaveBeenCalledTimes(1);
      expect(second.hostRect).toHaveBeenCalledTimes(1);

      second.container.dispatchEvent(new Event("scroll"));
      second.container.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));
      second.editor.dispatchEvent(new Event(TABLE_MENU_EVENT));
      second.editor.dispatchEvent(new Event(TABLE_MENU_EVENT));
      expect(browser.request).toHaveBeenCalledTimes(4);
      expect(browser.frames.size).toBe(1);
      browser.flush();
      expect(second.stateRead).toHaveBeenCalledTimes(2);
      expect(second.nodeDOM).toHaveBeenCalledTimes(2);
      expect(second.tableRect).toHaveBeenCalledTimes(2);
      expect(second.hostRect).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("table-menu")).toBe(current);

      second.container.dispatchEvent(new Event("scroll"));
      expect(browser.request).toHaveBeenCalledTimes(5);
      const removedFrame = browser.capturedFrames.get(5)!;
      const currentReads = {
        state: second.stateRead.mock.calls.length,
        dom: second.domRead.mock.calls.length,
        destroyed: second.destroyedRead.mock.calls.length,
        nodeDOM: second.nodeDOM.mock.calls.length,
        table: second.tableRect.mock.calls.length,
        host: second.hostRect.mock.calls.length,
      };
      let removalBoundaries = 0;
      act(() => {
        root.render(
          <Boundary
            current={second}
            present={false}
            boundary={2}
            onPassiveCleanup={recordPassiveCleanup}
            onBoundary={() => {
              removalBoundaries++;
              expect(passiveCleanups).toBe(1);
              expect(browser.listeners.slice(3).every((listener) => listener.removed === 1)).toBe(true);
              const scheduled = browser.request.mock.calls.length;
              second.container.dispatchEvent(new Event("scroll"));
              second.editor.dispatchEvent(new Event(TABLE_MENU_EVENT));
              window.dispatchEvent(new Event("resize"));
              expect(browser.request).toHaveBeenCalledTimes(scheduled);
            }}
          />,
        );
      });
      expect(removalBoundaries).toBe(1);
      expect(passiveCleanups).toBe(2);
      expect(browser.cancel).toHaveBeenNthCalledWith(2, 5);
      expect(browser.cancel).toHaveBeenCalledTimes(2);
      expect(browser.frames.size).toBe(0);
      expect(browser.listeners).toHaveLength(6);
      expect(browser.listeners.every((listener) => listener.removed === 1)).toBe(true);
      expect(host.querySelectorAll("[data-testid=table-menu]")).toHaveLength(0);
      expect(() => removedFrame(0)).not.toThrow();
      expect(second.stateRead).toHaveBeenCalledTimes(currentReads.state);
      expect(second.domRead).toHaveBeenCalledTimes(currentReads.dom);
      expect(second.destroyedRead).toHaveBeenCalledTimes(currentReads.destroyed);
      expect(second.nodeDOM).toHaveBeenCalledTimes(currentReads.nodeDOM);
      expect(second.tableRect).toHaveBeenCalledTimes(currentReads.table);
      expect(second.hostRect).toHaveBeenCalledTimes(currentReads.host);
      expect(first.tableAction).not.toHaveBeenCalled();
      expect(second.tableAction).not.toHaveBeenCalled();
      expect(first.alignAction).not.toHaveBeenCalled();
      expect(second.alignAction).not.toHaveBeenCalled();
      expect(setup.hidden).toHaveBeenCalledTimes(3);
      expect(errors).toEqual([]);
    } finally {
      act(() => root.unmount());
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    }
  });

  it("keeps every table button focus-safe and wired to exactly one intended action", () => {
    const browser = controlledBrowser();
    const current = fixture({
      host: new DOMRect(50, 120, 800, 600),
      tableBox: new DOMRect(400, 360, 500, 300),
      align: "center",
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      act(() => root.render(<Boundary current={current} />));
      browser.flush();
      const commands: Array<[string, TableCommand]> = [
        ["table-row-before", "rowBefore"],
        ["table-row-after", "rowAfter"],
        ["table-col-before", "colBefore"],
        ["table-col-after", "colAfter"],
        ["table-delete-row", "deleteRow"],
        ["table-delete-col", "deleteColumn"],
        ["table-delete", "deleteTable"],
      ];
      const alignments: Array<[string, "left" | "center" | "right" | null]> = [
        ["table-align-left", "left"],
        ["table-align-center", null],
        ["table-align-right", "right"],
      ];

      for (const [testId] of [...commands, ...alignments]) {
        const button = screen.getByTestId(testId);
        const pointer = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        expect(button.dispatchEvent(pointer)).toBe(false);
        expect(pointer.defaultPrevented).toBe(true);
        fireEvent.click(button);
      }

      expect(current.tableAction.mock.calls).toEqual(commands.map(([, command]) => [command]));
      expect(current.tableAction).toHaveBeenCalledTimes(7);
      expect(current.alignAction.mock.calls).toEqual(alignments.map(([, alignment]) => [alignment]));
      expect(current.alignAction).toHaveBeenCalledTimes(3);
      expect(screen.getAllByRole("button")).toHaveLength(10);
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("TableMenu keyboard and click checks", () => {
  const ORDER = [
    "table-row-before",
    "table-row-after",
    "table-col-before",
    "table-col-after",
    "table-delete-row",
    "table-delete-col",
    "table-align-left",
    "table-align-center",
    "table-align-right",
    "table-delete",
  ] as const;

  function mount(strict = false) {
    const browser = controlledBrowser();
    const current = fixture({ host: new DOMRect(50, 120, 800, 600), tableBox: new DOMRect(400, 360, 500, 300) });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(strict ? <StrictMode><Boundary current={current} /></StrictMode> : <Boundary current={current} />));
    browser.flush();
    return { current, unmount: () => act(() => root.unmount()) };
  }
  const button = (testId: string) => screen.getByTestId(testId);
  const focusButton = (testId: string) => act(() => button(testId).focus());

  it.each([
    ["ArrowRight", 0, 1],
    ["ArrowDown", 4, 5],
    ["ArrowLeft", 5, 4],
    ["ArrowUp", 1, 0],
    ["ArrowRight", 9, 0],
    ["ArrowLeft", 0, 9],
    ["Home", 6, 0],
    ["End", 3, 9],
  ] as const)("moves %s from button %i to %i without running a command", (key, from, to) => {
    const { current, unmount } = mount();
    try {
      expect(screen.getByRole("toolbar", { name: "Table" })).toHaveAttribute("aria-orientation", "horizontal");
      focusButton(ORDER[from]);
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      expect(fireEvent.keyDown(button(ORDER[from]), { key })).toBe(false);
      expect(button(ORDER[to])).toHaveFocus();
      expect(focus.mock.calls).toEqual([[{ preventScroll: true }]]);
      expect(current.tableAction).not.toHaveBeenCalled();
      expect(current.alignAction).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it("follows held arrows and leaves modified, composing, boundary and other keys alone", () => {
    const { unmount } = mount();
    try {
      focusButton(ORDER[0]);
      for (const testId of ORDER.slice(1, 4)) {
        expect(fireEvent.keyDown(document.activeElement!, { key: "ArrowRight", repeat: true })).toBe(false);
        expect(button(testId)).toHaveFocus();
      }
      for (const init of [
        { key: "ArrowRight", shiftKey: true },
        { key: "ArrowRight", ctrlKey: true },
        { key: "ArrowRight", altKey: true },
        { key: "ArrowRight", metaKey: true },
        { key: "ArrowRight", isComposing: true },
        { key: " " },
        { key: "Tab" },
      ]) {
        expect(fireEvent.keyDown(button(ORDER[3]), init)).toBe(true);
        expect(button(ORDER[3])).toHaveFocus();
      }
      expect(fireEvent.keyDown(button(ORDER[0]), { key: "Home" })).toBe(true);
      expect(fireEvent.keyDown(button(ORDER[9]), { key: "End" })).toBe(true);
      expect(screen.getAllByRole("button").every((element) => element.tabIndex === 0)).toBe(true);
    } finally {
      unmount();
    }
  });

  it("checks permission, pane, table, Esc and view state when the click lands", () => {
    const { current, unmount } = mount();
    const session = current.session as unknown as { canEdit: boolean; activeSurface: string };
    const clickAll = () => {
      for (const testId of ORDER) fireEvent.click(button(testId));
    };
    try {
      session.canEdit = false;
      clickAll();
      session.canEdit = true;
      session.activeSurface = "code";
      clickAll();
      session.activeSurface = "rich";
      current.format.tablePos = -1;
      clickAll();
      current.format.tablePos = 7;
      setup.hidden.mockReturnValue(true);
      clickAll();
      setup.hidden.mockReturnValue(false);
      current.destroyedRead.mockReturnValue(true);
      clickAll();
      expect(current.tableAction).not.toHaveBeenCalled();
      expect(current.alignAction).not.toHaveBeenCalled();

      current.destroyedRead.mockReturnValue(false);
      fireEvent.click(button("table-row-after"));
      fireEvent.click(button("table-align-right"));
      expect(current.tableAction.mock.calls).toEqual([["rowAfter"]]);
      expect(current.alignAction.mock.calls).toEqual([["right"]]);
    } finally {
      setup.hidden.mockReturnValue(false);
      unmount();
    }
  });

  it("acts on the editor's selection when the click lands, not on the last render's", () => {
    const { current, unmount } = mount();
    try {
      // Rendered for an unaligned column; the caret has since moved to a centred one.
      current.live.format = { ...current.format, tableAlign: "center" };
      fireEvent.click(button("table-align-center"));
      fireEvent.click(button("table-align-left"));
      expect(current.alignAction.mock.calls).toEqual([[null], ["left"]]);

      // The caret has left the table, and the menu is still on screen.
      current.live.format = { ...current.format, tablePos: -1 };
      for (const testId of ORDER) fireEvent.click(button(testId));
      expect(current.tableAction).not.toHaveBeenCalled();
      expect(current.alignAction).toHaveBeenCalledTimes(2);
    } finally {
      unmount();
    }
  });

  it("Enter runs a command once, on release, however long it is held; Ctrl, Alt and Meta+Enter do nothing", () => {
    const { current, unmount } = mount();
    try {
      focusButton("table-delete-row");
      expect(fireEvent.keyDown(button("table-delete-row"), { key: "Enter" })).toBe(false);
      for (let i = 0; i < 4; i++) fireEvent.keyDown(button("table-delete-row"), { key: "Enter", repeat: true });
      expect(current.tableAction).not.toHaveBeenCalled();
      fireEvent.keyUp(button("table-delete-row"), { key: "Enter" });
      expect(current.tableAction.mock.calls).toEqual([["deleteRow"]]);

      for (const modifier of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
        fireEvent.keyDown(button("table-delete-row"), { key: "Enter", ...modifier });
        fireEvent.keyUp(button("table-delete-row"), { key: "Enter", ...modifier });
      }
      // Released on another button, and released after focus left and came back.
      fireEvent.keyDown(button("table-delete-row"), { key: "Enter" });
      focusButton("table-row-after");
      fireEvent.keyUp(button("table-row-after"), { key: "Enter" });
      fireEvent.keyUp(button("table-row-after"), { key: "Enter" });
      expect(current.tableAction.mock.calls).toEqual([["deleteRow"]]);
    } finally {
      unmount();
    }
  });

  it("a double-click deletes one row or column; other buttons act on every click", () => {
    const { current, unmount } = mount();
    try {
      for (const testId of ["table-delete-row", "table-delete-col", "table-row-after"]) {
        for (const detail of [1, 2, 3]) fireEvent.click(button(testId), { detail });
      }
      // Two separate clicks are two deletes.
      fireEvent.click(button("table-delete-row"), { detail: 1 });
      expect(current.tableAction.mock.calls).toEqual([
        ["deleteRow"], ["deleteColumn"], ["rowAfter"], ["rowAfter"], ["rowAfter"], ["deleteRow"],
      ]);
    } finally {
      unmount();
    }
  });

  it("keeps the menu's place after a pointer click removed it, and not after a keyboard click", () => {
    const browser = controlledBrowser();
    const current = fixture({ host: new DOMRect(50, 120, 800, 600), tableBox: new DOMRect(400, 360, 500, 300) });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const removeTable = () => {
      current.format = { ...current.format, tablePos: -1 };
      current.live.format = current.format;
      act(() => root.render(<Boundary current={current} />));
      browser.flush();
    };
    const restoreTable = () => {
      current.format = { ...current.format, tablePos: 7 };
      current.live.format = current.format;
      act(() => root.render(<Boundary current={current} />));
      browser.flush();
    };
    try {
      act(() => root.render(<Boundary current={current} />));
      browser.flush();
      vi.spyOn(screen.getByTestId("table-menu"), "getBoundingClientRect").mockReturnValue(new DOMRect(350, 212, 372, 40));
      fireEvent.click(button("table-delete"), { detail: 1 });
      expect(current.tableAction.mock.calls).toEqual([["deleteTable"]]);
      removeTable();
      expect(screen.queryByTestId("table-menu")).toBeNull();
      const box = screen.getByTestId("place-hold");
      expect(box).toHaveStyle({ left: "350px", top: "212px", width: "372px", height: "40px" });
      expect(fireEvent.mouseDown(box)).toBe(false);
      fireEvent.click(box, { detail: 2 });
      expect(current.tableAction).toHaveBeenCalledTimes(1);

      // The menu comes back: the box goes. A keyboard click that removes the menu leaves no box.
      restoreTable();
      expect(screen.queryByTestId("place-hold")).toBeNull();
      fireEvent.click(button("table-delete"), { detail: 0 });
      removeTable();
      expect(screen.queryByTestId("place-hold")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
    expect(screen.queryByTestId("place-hold")).toBeNull();
  });

  it("runs each command exactly once per click under Strict Mode", () => {
    const { current, unmount } = mount(true);
    try {
      for (const testId of ORDER) fireEvent.click(button(testId));
      expect(current.tableAction.mock.calls).toEqual([
        ["rowBefore"], ["rowAfter"], ["colBefore"], ["colAfter"], ["deleteRow"], ["deleteColumn"], ["deleteTable"],
      ]);
      expect(current.alignAction.mock.calls).toEqual([["left"], ["center"], ["right"]]);
    } finally {
      unmount();
    }
  });
});
