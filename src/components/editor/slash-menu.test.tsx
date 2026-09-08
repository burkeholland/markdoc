// @vitest-environment jsdom
import { StrictMode, useEffect, useLayoutEffect, type MouseEvent as ReactMouseEvent, type RefCallback } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { TextSelection } from "prosemirror-state";
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
  const transaction = {
    setSelection: vi.fn(),
  };
  transaction.setSelection.mockReturnValue(transaction);
  return {
    state: {
      selection: {
        $from: {
          start: () => 1,
          end: () => 2,
        },
      },
      doc: {},
      tr: transaction,
    },
    dispatch: vi.fn(),
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

type DirectMouseEvent<T extends HTMLElement> = Pick<
  ReactMouseEvent<T>,
  "type" | "currentTarget" | "target" | "nativeEvent" | "preventDefault"
>;

type DirectMouseHandler<T extends HTMLElement> = (event: DirectMouseEvent<T>) => void;

interface CapturedRow {
  element: HTMLButtonElement;
  enter: DirectMouseHandler<HTMLButtonElement>;
  click: DirectMouseHandler<HTMLButtonElement>;
  ref: RefCallback<HTMLButtonElement>;
}

interface CapturedRoot {
  element: HTMLDivElement;
  down: DirectMouseHandler<HTMLDivElement>;
  ref: RefCallback<HTMLDivElement>;
}

function reactProp<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const value = props?.[name];
  if (typeof value !== "function") throw new Error(`${name} was not attached to ${element.tagName}`);
  return value as T;
}

function reactRef<T extends HTMLElement>(element: T): RefCallback<T> {
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error(`React fiber was not attached to ${element.tagName}`);
  const fiber = (element as unknown as Record<string, { ref?: unknown } | undefined>)[fiberKey];
  if (typeof fiber?.ref !== "function") throw new Error(`A callback ref was not attached to ${element.tagName}`);
  return fiber.ref as RefCallback<T>;
}

function captureRow(id: string): CapturedRow {
  const element = screen.getByTestId(`slash-item-${id}`) as HTMLButtonElement;
  return {
    element,
    enter: reactProp<DirectMouseHandler<HTMLButtonElement>>(element, "onMouseEnter"),
    click: reactProp<DirectMouseHandler<HTMLButtonElement>>(element, "onClick"),
    ref: reactRef(element),
  };
}

function captureRoot(): CapturedRoot {
  const element = screen.getByTestId("slash-menu") as HTMLDivElement;
  return {
    element,
    down: reactProp<DirectMouseHandler<HTMLDivElement>>(element, "onMouseDown"),
    ref: reactRef(element),
  };
}

interface MouseOverrides {
  type?: string;
  target?: EventTarget;
  nativeEvent?: Event;
  nativeType?: string;
  nativeTarget?: EventTarget;
}

function ownerMouseEvent(target: EventTarget, type: string): MouseEvent {
  const node = target as Node;
  const MouseEventConstructor = node.ownerDocument?.defaultView?.MouseEvent;
  if (!MouseEventConstructor) throw new Error("Pointer target has no owner-document MouseEvent");
  const event = new MouseEventConstructor(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

function invokeMouse<T extends HTMLElement>(
  handler: DirectMouseHandler<T>,
  currentTarget: T,
  syntheticType: "mouseenter" | "click" | "mousedown",
  overrides: MouseOverrides = {},
) {
  const nativeType = overrides.nativeType ?? (syntheticType === "mouseenter" ? "mouseover" : syntheticType);
  const target = overrides.target ?? currentTarget;
  const nativeEvent = overrides.nativeEvent ?? ownerMouseEvent(overrides.nativeTarget ?? target, nativeType);
  const preventDefault = vi.fn(() => nativeEvent.preventDefault());
  const event: DirectMouseEvent<T> = {
    type: overrides.type ?? syntheticType,
    currentTarget,
    target,
    nativeEvent: nativeEvent as ReactMouseEvent<T>["nativeEvent"],
    preventDefault,
  };
  handler(event);
  return { event, nativeEvent, preventDefault };
}

function clickRow(row: CapturedRow, target: EventTarget = row.element) {
  return invokeMouse(row.click, row.element, "click", { target, nativeTarget: target });
}

function PassiveCleanupProbe({ onCleanup }: { onCleanup: () => void }) {
  useEffect(() => onCleanup, [onCleanup]);
  return null;
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

describe("slash-menu pointer presentation", () => {
  it("keeps the exact current controls usable after Strict Mode replays layout effects", () => {
    const a = makeVisit();
    const b = makeVisit();
    a.controller.state = slashState();
    b.controller.state = slashState();
    const mounted = render(
      <StrictMode>
        <BoundaryHarness visit={a} />
      </StrictMode>,
    );

    const headingBeforeHover = captureRow("heading1");
    act(() => {
      invokeMouse(headingBeforeHover.enter, headingBeforeHover.element, "mouseenter");
    });
    const heading = captureRow("heading1");
    expect(heading.element).toHaveAttribute("aria-selected", "true");

    const root = captureRoot();
    const title = heading.element.querySelector(".truncate");
    expect(title).toBeInstanceOf(HTMLSpanElement);
    const down = invokeMouse(root.down, root.element, "mousedown", {
      target: title!,
      nativeTarget: title!,
    });
    root.down(down.event);
    expect(down.preventDefault).toHaveBeenCalledOnce();

    const click = clickRow(heading, title!);
    heading.click(click.event);
    expect(slashActions.applyCommand).toHaveBeenCalledOnce();
    expect(a.view.focus).toHaveBeenCalledOnce();

    act(() => a.controller.emit(slashState()));
    const staleRow = captureRow("heading1");
    const staleRoot = captureRoot();
    mounted.rerender(
      <StrictMode>
        <BoundaryHarness visit={b} />
      </StrictMode>,
    );
    const currentRow = captureRow("heading1");
    const currentRoot = captureRoot();

    act(() => {
      staleRow.ref(currentRow.element);
      staleRoot.ref(currentRoot.element);
      staleRow.ref(null);
      staleRoot.ref(null);
    });
    act(() => {
      invokeMouse(staleRow.enter, currentRow.element, "mouseenter");
    });
    const staleDown = invokeMouse(staleRoot.down, currentRoot.element, "mousedown", {
      target: currentRow.element,
      nativeTarget: currentRow.element,
    });
    clickRow({ ...staleRow, element: currentRow.element });
    expect(currentRow.element).toHaveAttribute("aria-selected", "false");
    expect(staleDown.preventDefault).not.toHaveBeenCalled();
    expect(slashActions.applyCommand).toHaveBeenCalledOnce();
    expect(b.view.focus).not.toHaveBeenCalled();

    act(() => {
      invokeMouse(currentRow.enter, currentRow.element, "mouseenter");
    });
    const acceptedRow = captureRow("heading1");
    const acceptedRoot = captureRoot();
    const acceptedTitle = acceptedRow.element.querySelector(".truncate");
    expect(acceptedTitle).toBeInstanceOf(HTMLSpanElement);
    const acceptedDown = invokeMouse(acceptedRoot.down, acceptedRoot.element, "mousedown", {
      target: acceptedTitle!,
      nativeTarget: acceptedTitle!,
    });
    acceptedRoot.down(acceptedDown.event);
    expect(acceptedDown.preventDefault).toHaveBeenCalledOnce();
    const acceptedClick = clickRow(acceptedRow, acceptedTitle!);
    acceptedRow.click(acceptedClick.event);
    expect(slashActions.applyCommand).toHaveBeenCalledTimes(2);
    expect(b.view.focus).toHaveBeenCalledOnce();
  });

  it("binds hover, root prevention, and command application to one exact native interaction", () => {
    const visit = makeVisit();
    render(<BoundaryHarness visit={visit} />);
    open(visit);

    expect(screen.getByText("Basic")).toBeInTheDocument();
    expect(screen.getByText("Keep an agent here")).toBeInTheDocument();
    expect(screen.getByText("Get the exact sentence that keeps an agent in this document")).toBeInTheDocument();
    const initialText = captureRow("text");
    expect(initialText.element).toHaveAttribute("aria-selected", "true");
    expect(initialText.element).toHaveClass("bg-accent-soft", "text-ink");

    fireEvent.mouseEnter(screen.getByTestId("slash-item-heading1"));
    const heading = captureRow("heading1");
    expect(heading.element).toHaveAttribute("aria-selected", "true");
    expect(heading.element).toHaveClass("bg-accent-soft", "text-ink");
    expect(screen.getByTestId("slash-item-text")).toHaveAttribute("aria-selected", "false");

    const root = captureRoot();
    const title = heading.element.querySelector(".truncate");
    expect(title).toBeInstanceOf(HTMLSpanElement);
    const down = invokeMouse(root.down, root.element, "mousedown", {
      target: title!,
      nativeTarget: title!,
    });
    expect(down.preventDefault).toHaveBeenCalledOnce();
    root.down(down.event);
    expect(down.preventDefault).toHaveBeenCalledOnce();

    const click = clickRow(heading, title!);
    heading.click(click.event);
    expect(slashActions.applyCommand).toHaveBeenCalledOnce();
    expect(slashActions.applyCommand.mock.calls[0][0]).toBe(visit.view);
    expect(slashActions.applyCommand.mock.calls[0][2]).toBe(visit.session.undoManager);
    expect(visit.view.focus).toHaveBeenCalledOnce();
    expect(click.preventDefault).not.toHaveBeenCalled();
  });

  it("rejects fabricated, mismatched, sibling, foreign, detached, unpublished, and disabled click sources", () => {
    const visit = makeVisit();
    render(<BoundaryHarness visit={visit} />);
    open(visit, slashState("text"));
    const current = captureRow("text");
    const foreign = document.createElement("button");
    const detached = document.createElement("button");
    const unpublished = document.createElement("span");
    document.body.append(foreign);
    current.element.append(unpublished);
    const focusOwner = document.createElement("button");
    document.body.append(focusOwner);
    focusOwner.focus();
    const activeElement = document.activeElement;
    const markup = document.body.innerHTML;

    const attempts = [
      invokeMouse(current.click, current.element, "click", {
        nativeEvent: new Event("click"),
      }),
      invokeMouse(current.click, current.element, "click", {
        type: "mousedown",
      }),
      invokeMouse(current.click, current.element, "click", {
        nativeType: "mousedown",
      }),
      invokeMouse(current.click, current.element, "click", {
        target: current.element,
        nativeTarget: unpublished,
      }),
      invokeMouse(current.click, foreign, "click"),
      invokeMouse(current.click, detached, "click"),
      invokeMouse(current.click, current.element, "click", {
        target: unpublished,
        nativeTarget: unpublished,
      }),
    ];
    for (const attempt of attempts) expect(attempt.preventDefault).not.toHaveBeenCalled();
    expect(slashActions.applyCommand).not.toHaveBeenCalled();
    expect(visit.view.focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(activeElement);
    expect(document.body.innerHTML).toBe(markup);

    unpublished.remove();
    current.element.disabled = true;
    clickRow(current);
    current.element.disabled = false;
    expect(slashActions.applyCommand).not.toHaveBeenCalled();

    act(() => visit.controller.emit(slashState("text")));
    const successor = captureRow("text");
    clickRow(successor);
    expect(slashActions.applyCommand).toHaveBeenCalledOnce();
    expect(visit.view.focus).toHaveBeenCalledOnce();
    foreign.remove();
    focusOwner.remove();
  });

  it.each([
    ["stale before current", false],
    ["current before stale", true],
  ] as const)("keeps an equal-looking successor usable %s, including after late old refs", (_label, currentFirst) => {
    const visit = makeVisit();
    const mounted = render(<BoundaryHarness visit={visit} />);
    open(visit, slashState("text"));
    const staleRow = captureRow("text");
    const staleRoot = captureRoot();

    mounted.rerender(<BoundaryHarness visit={{ ...visit }} boundary={1} />);
    const currentRow = captureRow("text");
    const currentRoot = captureRoot();
    expect(currentRow.element).toBe(staleRow.element);
    expect(currentRoot.element).toBe(staleRoot.element);

    act(() => {
      staleRow.ref(currentRow.element);
      staleRoot.ref(currentRoot.element);
      staleRow.ref(null);
      staleRoot.ref(null);
    });

    const staleClick = () => clickRow({ ...staleRow, element: currentRow.element });
    const currentClick = () => clickRow(currentRow);
    if (currentFirst) {
      currentClick();
      staleClick();
    } else {
      staleClick();
      currentClick();
    }
    expect(slashActions.applyCommand).toHaveBeenCalledOnce();

    const staleDown = () =>
      invokeMouse(staleRoot.down, currentRoot.element, "mousedown", {
        target: currentRow.element,
        nativeTarget: currentRow.element,
      });
    const currentDown = () =>
      invokeMouse(currentRoot.down, currentRoot.element, "mousedown", {
        target: currentRow.element,
        nativeTarget: currentRow.element,
      });
    const downs = currentFirst ? [currentDown(), staleDown()] : [staleDown(), currentDown()];
    expect(downs.filter((attempt) => attempt.preventDefault.mock.calls.length === 1)).toHaveLength(1);
  });

  it("retires stale handlers across state scalars, permissions, callbacks, highlight, and geometry", () => {
    const visit = makeVisit();
    const mounted = render(<BoundaryHarness visit={visit} />);
    const state = slashState("text", 100);
    open(visit, state);
    const stateHandler = captureRow("text");

    state.to += 1;
    clickRow(stateHandler);
    expect(slashActions.applyCommand).not.toHaveBeenCalled();
    state.to -= 1;
    act(() => visit.controller.emit(state));

    const permissionHandler = captureRow("text");
    Object.defineProperty(visit.session, "canEdit", { configurable: true, value: false, writable: true });
    clickRow(permissionHandler);
    expect(slashActions.applyCommand).not.toHaveBeenCalled();
    Object.defineProperty(visit.session, "canEdit", { configurable: true, value: true, writable: true });
    mounted.rerender(<BoundaryHarness visit={visit} boundary={1} />);

    const callbackHandler = captureRow("text");
    const replacementImage = vi.fn();
    const callbackVisit = { ...visit, onImage: replacementImage };
    mounted.rerender(<BoundaryHarness visit={callbackVisit} boundary={2} />);
    clickRow({ ...callbackHandler, element: screen.getByTestId("slash-item-text") as HTMLButtonElement });
    expect(slashActions.applyCommand).not.toHaveBeenCalled();

    act(() => visit.controller.emit(slashState()));
    const beforeHighlight = captureRow("text");
    fireEvent.mouseEnter(screen.getByTestId("slash-item-heading1"));
    const highlighted = captureRow("heading1");
    clickRow({ ...beforeHighlight, element: screen.getByTestId("slash-item-text") as HTMLButtonElement });
    expect(slashActions.applyCommand).not.toHaveBeenCalled();

    act(() => visit.controller.emit(slashState("h1", 640)));
    clickRow(highlighted);
    expect(slashActions.applyCommand).not.toHaveBeenCalled();
    const geometrySuccessor = captureRow("heading1");
    clickRow(geometrySuccessor);
    expect(slashActions.applyCommand).toHaveBeenCalledOnce();
    expect(screen.getByTestId("slash-menu")).toHaveStyle({ left: "640px" });
  });

  it("rejects row replacement, row reorder, and group crossing before accepting a fresh publication", () => {
    const visit = makeVisit();
    render(<BoundaryHarness visit={visit} />);
    open(visit);
    let text = captureRow("text");
    let root = captureRoot().element;
    let basic = text.element.parentElement as HTMLDivElement;
    let lists = screen.getByTestId("slash-item-bullet").parentElement as HTMLDivElement;
    const refresh = () => {
      text = captureRow("text");
      root = captureRoot().element;
      basic = text.element.parentElement as HTMLDivElement;
      lists = screen.getByTestId("slash-item-bullet").parentElement as HTMLDivElement;
    };
    const replacement = text.element.cloneNode(true) as HTMLButtonElement;

    text.element.replaceWith(replacement);
    invokeMouse(text.click, replacement, "click");
    expect(slashActions.applyCommand).not.toHaveBeenCalled();
    replacement.replaceWith(text.element);

    basic.append(text.element);
    clickRow(text);
    expect(slashActions.applyCommand).not.toHaveBeenCalled();
    basic.insertBefore(text.element, basic.children[1] ?? null);
    act(() => visit.controller.emit(slashState()));
    refresh();

    lists.append(text.element);
    clickRow(text);
    expect(slashActions.applyCommand).not.toHaveBeenCalled();
    basic.insertBefore(text.element, basic.children[1] ?? null);
    act(() => visit.controller.emit(slashState()));
    refresh();

    root.insertBefore(lists, basic);
    clickRow(text);
    expect(slashActions.applyCommand).not.toHaveBeenCalled();
    root.insertBefore(basic, lists);
    act(() => visit.controller.emit(slashState()));
    refresh();
    clickRow(text);
    expect(slashActions.applyCommand).toHaveBeenCalledOnce();
  });

  it("does no stale pointer or scroll work after removal before passive cleanup", () => {
    const visit = makeVisit();
    let staleClick: (() => void) | null = null;
    let staleDown: (() => void) | null = null;
    const onCleanup = vi.fn(() => {
      staleClick?.();
      staleDown?.();
    });
    const mounted = render(
      <>
        <BoundaryHarness visit={visit} />
        <PassiveCleanupProbe onCleanup={onCleanup} />
      </>,
    );
    open(visit, slashState("text"));
    const row = captureRow("text");
    const root = captureRoot();
    staleClick = () => {
      clickRow(row);
    };
    staleDown = () => {
      invokeMouse(root.down, root.element, "mousedown");
    };
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    mounted.rerender(
      <>
        <BoundaryHarness visit={visit} present={false} />
        <PassiveCleanupProbe onCleanup={vi.fn()} />
      </>,
    );
    expect(onCleanup).toHaveBeenCalledOnce();
    expect(slashActions.applyCommand).not.toHaveBeenCalled();
    expect(visit.view.focus).not.toHaveBeenCalled();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it.each([
    ["image", "onImage"],
    ["link", "onLink"],
    ["agent", "onKeepAgent"],
  ] as const)("applies the frozen %s item context and callback once", (id, callback) => {
    const visit = makeVisit();
    render(<BoundaryHarness visit={visit} />);
    open(visit, slashState(id));
    const row = captureRow(id);

    const accepted = clickRow(row);
    row.click(accepted.event);
    expect(slashActions.applyItem).toHaveBeenCalledOnce();
    expect(slashActions.applyItem.mock.calls[0][0]).toBe(visit.view);
    expect(slashActions.applyItem.mock.calls[0][2]).toBe(visit.session.undoManager);
    expect(visit[callback]).toHaveBeenCalledOnce();
  });

  it("preserves the comment selection, callback, and exact one-shot application", () => {
    const createSelection = vi.spyOn(TextSelection, "create").mockReturnValue({} as TextSelection);
    const visit = makeVisit();
    try {
      render(<BoundaryHarness visit={visit} />);
      open(visit, slashState("comment"));
      const row = captureRow("comment");
      const accepted = clickRow(row);
      row.click(accepted.event);

      expect(slashActions.applyItem).toHaveBeenCalledOnce();
      expect(createSelection).toHaveBeenCalledOnce();
      expect(visit.view.dispatch).toHaveBeenCalledOnce();
      expect(visit.onComment).toHaveBeenCalledOnce();
    } finally {
      createSelection.mockRestore();
    }
  });
});
