// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { EditorView } from "prosemirror-view";
import type { CollabSession } from "@/editor/collab/session";
import type { SlashKey, SlashMenuHandlers, SlashState } from "@/editor/prosemirror/slash-menu";

const slashActions = vi.hoisted(() => ({
  applyCommand: vi.fn(),
  applyItem: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@/editor/prosemirror/slash-menu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/editor/prosemirror/slash-menu")>();
  return {
    ...actual,
    applySlashCommand: slashActions.applyCommand,
    applySlashItem: slashActions.applyItem,
    closeSlashMenu: slashActions.close,
  };
});

vi.mock("@/editor/prosemirror/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/editor/prosemirror/commands")>();
  return { ...actual, tableAt: () => null };
});

vi.mock("./use-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./use-session")>();
  return {
    ...actual,
    useSessionValue: (session: never, select: (value: never) => unknown) => select(session),
  };
});

import { createSlashMenuController, SlashMenu, type SlashMenuController } from "./slash-menu";

class TrackingController implements SlashMenuController {
  state: SlashState | null = null;
  keyOwner: { handler: (key: SlashKey) => boolean } | null = null;
  readonly listeners = new Set<(state: SlashState | null) => void>();
  readonly capturedListeners: ((state: SlashState | null) => void)[] = [];
  readonly capturedKeyHandlers: ((key: SlashKey) => boolean)[] = [];
  subscriptions = 0;
  unsubscriptions = 0;
  peakListeners = 0;

  readonly handlers: SlashMenuHandlers = {
    onState: (state) => this.emit(state),
    onKey: (key) => this.keyHandler?.(key) ?? false,
  };

  readonly subscribe = (listener: (state: SlashState | null) => void) => {
    this.subscriptions += 1;
    this.listeners.add(listener);
    this.capturedListeners.push(listener);
    this.peakListeners = Math.max(this.peakListeners, this.listeners.size);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.unsubscriptions += 1;
      this.listeners.delete(listener);
    };
  };

  readonly getState = () => this.state;

  get keyHandler() {
    return this.keyOwner?.handler ?? null;
  }

  readonly setKeyHandler = (handler: (key: SlashKey) => boolean) => {
    const owner = { handler };
    this.keyOwner = owner;
    this.capturedKeyHandlers.push(handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.keyOwner === owner) this.keyOwner = null;
    };
  };

  emit(state: SlashState | null) {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  key(key: SlashKey) {
    return this.handlers.onKey?.(key) ?? false;
  }
}

type Visit = {
  controller: TrackingController;
  view: EditorView;
  session: CollabSession;
  onImage: Mock<() => void>;
  onLink: Mock<() => void>;
  onComment: Mock<() => void>;
  onKeepAgent: Mock<() => void>;
};

const container = document.createElement("div");
container.getBoundingClientRect = () =>
  ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
const containerRef = { current: container };

function makeView(): EditorView {
  return {
    state: {},
    focus: vi.fn(),
  } as unknown as EditorView;
}

function makeSession(): CollabSession {
  return {
    canEdit: true,
    canComment: true,
    undoManager: { stopCapturing: vi.fn() },
  } as unknown as CollabSession;
}

function makeVisit(controller = new TrackingController()): Visit {
  return {
    controller,
    view: makeView(),
    session: makeSession(),
    onImage: vi.fn<() => void>(),
    onLink: vi.fn<() => void>(),
    onComment: vi.fn<() => void>(),
    onKeepAgent: vi.fn<() => void>(),
  };
}

function slashState(query = "", left = 100): SlashState {
  return { from: 1, to: query.length + 2, query, coords: { left, top: 100, bottom: 120 } };
}

function BoundaryHarness({
  visit,
  view = visit.view,
  present = true,
  boundary = 0,
  onBoundary,
}: {
  visit: Visit;
  view?: EditorView | null;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);

  if (!present) return null;
  return (
    <SlashMenu
      view={view}
      session={visit.session}
      controller={visit.controller}
      containerRef={containerRef}
      onImage={visit.onImage}
      onLink={visit.onLink}
      onComment={visit.onComment}
      onKeepAgent={visit.onKeepAgent}
    />
  );
}

function open(visit: Visit, state = slashState()) {
  act(() => visit.controller.emit(state));
  expect(screen.getByTestId("slash-menu")).toBeInTheDocument();
}

let originalScrollIntoView: typeof Element.prototype.scrollIntoView;

beforeEach(() => {
  slashActions.applyCommand.mockReset();
  slashActions.applyItem.mockReset().mockImplementation((_view: EditorView, action: () => void) => action());
  slashActions.close.mockReset();
  originalScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(container, "scrollTop", { configurable: true, value: 0, writable: true });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
});

afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

describe("slash-menu visit authority", () => {
  it.each([
    ["A before B", false],
    ["B before A", true],
  ])("retires A before the parent layout boundary when events settle %s", (_label, bFirst) => {
    const a = makeVisit();
    const b = makeVisit();
    const mounted = render(<BoundaryHarness visit={a} />);
    open(a, slashState("text", 700));
    const staleListener = a.controller.capturedListeners[0];
    const staleKeyHandler = a.controller.capturedKeyHandlers[0];

    act(() => {
      mounted.rerender(
        <BoundaryHarness
          visit={b}
          boundary={1}
          onBoundary={() => {
            expect(a.controller.listeners.size).toBe(0);
            expect(a.controller.keyHandler).toBeNull();
            expect(b.controller.listeners.size).toBe(1);
            expect(screen.queryByTestId("slash-menu")).toBeNull();

            if (bFirst) b.controller.emit(slashState("", 222));
            staleListener(slashState("text", 900));
            expect(staleKeyHandler("ArrowDown")).toBe(false);
            expect(staleKeyHandler("Enter")).toBe(false);
            if (!bFirst) b.controller.emit(slashState("", 222));
          }}
        />,
      );
    });

    expect(screen.getByTestId("slash-menu")).toHaveStyle({ left: "222px" });
    expect(screen.getByTestId("slash-item-text")).toHaveAttribute("aria-selected", "true");
    expect(slashActions.applyCommand).not.toHaveBeenCalled();
    expect(a.view.focus).not.toHaveBeenCalled();
    expect(b.view.focus).not.toHaveBeenCalled();

    act(() => expect(b.controller.key("ArrowUp")).toBe(true));
    expect(screen.getByTestId("slash-item-agent")).toHaveAttribute("aria-selected", "true");
    act(() => expect(b.controller.key("ArrowDown")).toBe(true));
    expect(screen.getByTestId("slash-item-text")).toHaveAttribute("aria-selected", "true");
    act(() => expect(b.controller.key("Enter")).toBe(true));
    expect(slashActions.applyCommand).toHaveBeenCalledOnce();
    expect(slashActions.applyCommand.mock.calls[0][0]).toBe(b.view);
    expect(slashActions.applyCommand.mock.calls[0][2]).toBe(b.session.undoManager);
    expect(b.view.focus).toHaveBeenCalledOnce();
    expect(a.view.focus).not.toHaveBeenCalled();

    act(() => b.controller.emit(slashState("no-such-item", 333)));
    expect(screen.getByTestId("slash-empty")).toHaveTextContent("No matches");
    act(() => expect(b.controller.key("Enter")).toBe(true));
    expect(slashActions.close).toHaveBeenCalledOnce();
    expect(slashActions.close).toHaveBeenCalledWith(b.view);

    act(() => b.controller.emit(null));
    expect(screen.queryByTestId("slash-menu")).toBeNull();
    expect(b.controller.keyHandler).toBeNull();
    expect(a.controller.peakListeners).toBe(1);
    expect(b.controller.peakListeners).toBe(1);

    mounted.unmount();
    expect(a.controller.subscriptions).toBe(a.controller.unsubscriptions);
    expect(b.controller.subscriptions).toBe(b.controller.unsubscriptions);
  });

  it("retires a same-controller visit when its view and session change", () => {
    const controller = new TrackingController();
    const a = makeVisit(controller);
    const b = makeVisit(controller);
    const mounted = render(<BoundaryHarness visit={a} />);
    open(a, slashState("text", 700));
    const staleListener = controller.capturedListeners[0];
    const staleKeyHandler = controller.capturedKeyHandlers[0];

    act(() => {
      mounted.rerender(
        <BoundaryHarness
          visit={b}
          boundary={1}
          onBoundary={() => {
            expect(controller.listeners.size).toBe(1);
            expect(controller.subscriptions).toBe(2);
            expect(controller.unsubscriptions).toBe(1);
            expect(controller.keyHandler).toBeNull();
            expect(screen.queryByTestId("slash-menu")).toBeNull();

            controller.emit(slashState("image", 333));
            staleListener(slashState("text", 900));
            expect(staleKeyHandler("Enter")).toBe(false);
          }}
        />,
      );
    });

    expect(screen.getByTestId("slash-menu")).toHaveStyle({ left: "333px" });
    expect(screen.getByTestId("slash-item-image")).toHaveAttribute("aria-selected", "true");
    act(() => expect(controller.key("Enter")).toBe(true));
    expect(slashActions.applyItem).toHaveBeenCalledOnce();
    expect(slashActions.applyItem.mock.calls[0][0]).toBe(b.view);
    expect(slashActions.applyItem.mock.calls[0][2]).toBe(b.session.undoManager);
    expect(b.onImage).toHaveBeenCalledOnce();
    expect(a.onImage).not.toHaveBeenCalled();
    expect(a.view.focus).not.toHaveBeenCalled();
    expect(controller.peakListeners).toBe(1);

    mounted.unmount();
    expect(controller.listeners.size).toBe(0);
    expect(controller.keyHandler).toBeNull();
    expect(controller.subscriptions).toBe(controller.unsubscriptions);
  });

  it("does not restore a retired controller state after a null-view gap", () => {
    const controller = new TrackingController();
    const a = makeVisit(controller);
    const b = makeVisit(controller);
    const mounted = render(<BoundaryHarness visit={a} />);
    open(a, slashState("text", 700));
    const staleListener = controller.capturedListeners[0];

    act(() => mounted.rerender(<BoundaryHarness visit={a} view={null} />));
    expect(screen.queryByTestId("slash-menu")).toBeNull();
    expect(controller.listeners.size).toBe(0);
    expect(controller.keyHandler).toBeNull();

    act(() => {
      mounted.rerender(
        <BoundaryHarness
          visit={b}
          boundary={1}
          onBoundary={() => {
            expect(controller.listeners.size).toBe(1);
            expect(controller.keyHandler).toBeNull();
            expect(screen.queryByTestId("slash-menu")).toBeNull();
            staleListener(slashState("text", 900));
          }}
        />,
      );
    });
    expect(screen.queryByTestId("slash-menu")).toBeNull();

    act(() => controller.emit(slashState("image", 333)));
    expect(screen.getByTestId("slash-menu")).toHaveStyle({ left: "333px" });
    expect(screen.getByTestId("slash-item-image")).toHaveAttribute("aria-selected", "true");
    mounted.unmount();
    expect(controller.subscriptions).toBe(controller.unsubscriptions);
  });

  it("retires subscription, handler, and captured callbacks before a removal boundary", () => {
    const a = makeVisit();
    const mounted = render(<BoundaryHarness visit={a} />);
    open(a, slashState("text"));
    const staleListener = a.controller.capturedListeners[0];
    const staleKeyHandler = a.controller.capturedKeyHandlers[0];

    act(() => {
      mounted.rerender(
        <BoundaryHarness
          visit={a}
          present={false}
          boundary={1}
          onBoundary={() => {
            expect(a.controller.listeners.size).toBe(0);
            expect(a.controller.keyHandler).toBeNull();
            staleListener(slashState("text", 900));
            expect(staleKeyHandler("ArrowDown")).toBe(false);
            expect(staleKeyHandler("Enter")).toBe(false);
          }}
        />,
      );
    });

    expect(screen.queryByTestId("slash-menu")).toBeNull();
    expect(slashActions.applyCommand).not.toHaveBeenCalled();
    expect(a.view.focus).not.toHaveBeenCalled();
    expect(a.controller.subscriptions).toBe(a.controller.unsubscriptions);
  });

  it("does not let an older handler cleanup clear a newer registration of the same callback", () => {
    const controller = createSlashMenuController();
    const handler = vi.fn(() => true);
    const clearFirst = controller.setKeyHandler(handler);
    const clearSecond = controller.setKeyHandler(handler);

    clearFirst();
    expect(controller.handlers.onKey?.("Enter")).toBe(true);
    expect(handler).toHaveBeenCalledOnce();

    clearSecond();
    expect(controller.handlers.onKey?.("Enter")).toBe(false);
  });
});
