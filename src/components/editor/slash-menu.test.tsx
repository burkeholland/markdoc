// @vitest-environment jsdom
import { StrictMode, useEffect, useLayoutEffect, type MouseEvent as ReactMouseEvent, type RefCallback } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { CollabSession } from "@/editor/collab/session";
import type {
  SlashKeyPublication,
  SlashMenuHandlers,
  SlashState,
} from "@/editor/prosemirror/slash-menu";
import { slashMenuPlugin } from "@/editor/prosemirror/slash-menu";
import { editablePlugin } from "@/editor/prosemirror/editable";
import { schema } from "@/editor/markdown/schema";
import { SLASH_GROUPS, SLASH_ITEMS, filterSlashItems } from "@/editor/slash-items";

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
  keyOwner: {
    handler: (publication: SlashKeyPublication) => boolean;
  } | null = null;
  readonly listeners = new Set<(state: SlashState | null) => void>();
  readonly capturedListeners: ((state: SlashState | null) => void)[] = [];
  readonly capturedKeyHandlers: ((
    publication: SlashKeyPublication,
  ) => boolean)[] = [];
  subscriptions = 0;
  unsubscriptions = 0;
  peakListeners = 0;

  readonly handlers: SlashMenuHandlers = {
    onState: (state) => this.emit(state),
    onKey: (publication) => this.keyHandler?.(publication) ?? false,
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

  readonly setKeyHandler = (
    handler: (publication: SlashKeyPublication) => boolean,
  ) => {
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

  key(publication: SlashKeyPublication) {
    return this.handlers.onKey?.(publication) ?? false;
  }
}

type MenuVisit = {
  controller: SlashMenuController;
  view: EditorView;
  session: CollabSession;
  onImage: Mock<() => void>;
  onLink: Mock<() => void>;
  onComment: Mock<() => void>;
  onConnectAgent: Mock<() => void>;
};

type Visit = Omit<MenuVisit, "controller"> & {
  controller: TrackingController;
};

type IntegratedVisit = MenuVisit & {
  host: HTMLDivElement;
  restoreOwnerWindow: () => void;
};

const container = document.createElement("div");
container.getBoundingClientRect = () =>
  ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
const containerRef = { current: container };

function makeView(): EditorView {
  const dom = document.createElement("div");
  dom.contentEditable = "true";
  document.body.append(dom);
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
    dom,
    isDestroyed: false,
    composing: false,
  } as unknown as EditorView;
}

function unpublishedKey(): SlashKeyPublication {
  return {} as SlashKeyPublication;
}

function markJsdomEventTrusted(event: Event) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map((symbol) => (event as unknown as Record<symbol, unknown>)[symbol])
    .find(
      (candidate): candidate is { isTrusted: boolean } =>
        typeof candidate === "object" &&
        candidate !== null &&
        "isTrusted" in candidate &&
        candidate.isTrusted === false,
    );
  const descriptor = implementation
    ? Object.getOwnPropertyDescriptor(implementation, "isTrusted")
    : undefined;
  if (!implementation || !descriptor?.writable) {
    throw new Error("Unable to set jsdom's internal event trust slot");
  }
  Object.defineProperty(implementation, "isTrusted", {
    configurable: true,
    enumerable: true,
    get: () => true,
    set: () => undefined,
  });
  if (!event.isTrusted) throw new Error("The jsdom event trust slot did not update");
}

type JsdomKeyboardEventImplementation = {
  isTrusted: boolean;
  view: Window | null;
};

function jsdomKeyboardEventImplementation(
  event: KeyboardEvent,
): JsdomKeyboardEventImplementation {
  const implementation = Object.getOwnPropertySymbols(event)
    .map((symbol) => (event as unknown as Record<symbol, unknown>)[symbol])
    .find(
      (candidate): candidate is JsdomKeyboardEventImplementation =>
        typeof candidate === "object" &&
        candidate !== null &&
        "isTrusted" in candidate &&
        "view" in candidate,
    );
  if (!implementation) throw new Error("jsdom keyboard event implementation was unavailable");
  return implementation;
}

function exposeJsdomNativeDefaultView(ownerDocument: Document): () => void {
  const implementationSymbol = Object.getOwnPropertySymbols(
    ownerDocument,
  ).find((symbol) => String(symbol) === "Symbol(impl)");
  if (!implementationSymbol) {
    throw new Error("Document implementation slot was not available");
  }
  const nativeOwnerWindow = (
    ownerDocument as unknown as Record<
      symbol,
      { _globalObject: Window & typeof globalThis }
    >
  )[implementationSymbol]._globalObject;
  const previous = Object.getOwnPropertyDescriptor(ownerDocument, "defaultView");
  Object.defineProperty(ownerDocument, "defaultView", {
    configurable: true,
    value: nativeOwnerWindow,
  });
  if (ownerDocument.defaultView !== nativeOwnerWindow) {
    throw new Error("Unable to expose jsdom's native owner window");
  }
  return () => {
    if (previous) {
      Object.defineProperty(ownerDocument, "defaultView", previous);
    } else if (!Reflect.deleteProperty(ownerDocument, "defaultView")) {
      throw new Error("Unable to restore jsdom's public owner window");
    }
  };
}

function makeIntegratedVisit(): IntegratedVisit {
  const restoreOwnerWindow = exposeJsdomNativeDefaultView(document);
  const controller = createSlashMenuController();
  const state = EditorState.create({
    schema,
    plugins: [editablePlugin(true), slashMenuPlugin(controller.handlers)],
  });
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView(host, { state });
  const dispatch = view.dispatch.bind(view);
  view.dispatch = vi.fn((transaction) => dispatch(transaction));
  const focus = view.focus.bind(view);
  view.focus = vi.fn(() => focus());
  return {
    controller,
    view,
    session: makeSession(),
    onImage: vi.fn<() => void>(),
    onLink: vi.fn<() => void>(),
    onComment: vi.fn<() => void>(),
    onConnectAgent: vi.fn<() => void>(),
    host,
    restoreOwnerWindow,
  };
}

async function openIntegrated(visit: IntegratedVisit) {
  await act(async () => {
    visit.view.dom.focus();
    visit.view.dispatch(
      visit.view.state.tr
        .setSelection(TextSelection.create(visit.view.state.doc, 1))
        .insertText("/"),
    );
    await Promise.resolve();
  });
  expect(screen.getByTestId("slash-menu")).toBeInTheDocument();
}

async function dispatchIntegratedKey(
  view: EditorView,
  key: string,
  init: KeyboardEventInit = {},
) {
  const ownerDocument = view.dom.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("Editor owner window was unavailable");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    ...init,
    view: ownerWindow,
  });
  if (event.view !== ownerWindow) throw new Error("Keyboard event lost its exact public owner window");
  markJsdomEventTrusted(event);
  await act(async () => {
    view.dom.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  });
  return event;
}

async function dispatchRejectedNativeViewKey(
  view: EditorView,
  nativeView: Window | null,
) {
  const ownerWindow = view.dom.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("Editor owner window was unavailable");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key: "End",
    code: "End",
    bubbles: true,
    cancelable: true,
    view: nativeView,
  });
  if (event.view !== nativeView) throw new Error("Rejected keyboard event lost its requested public view");
  markJsdomEventTrusted(event);
  await act(async () => {
    view.dom.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  });
  return event;
}

async function dispatchStructuralWindowLookalikeKey(
  view: EditorView,
  key: string,
) {
  const ownerDocument = view.dom.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("Editor owner window was unavailable");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    view: ownerWindow,
  });
  if (event.view !== ownerWindow) throw new Error("Keyboard event lost its exact public owner window");
  markJsdomEventTrusted(event);
  const implementation = jsdomKeyboardEventImplementation(event);
  const lookalike = new Proxy(
    Object.create(Object.getPrototypeOf(ownerWindow), {
      document: { configurable: true, value: ownerDocument },
      Event: { configurable: true, value: ownerWindow.Event },
      UIEvent: { configurable: true, value: ownerWindow.UIEvent },
      KeyboardEvent: { configurable: true, value: ownerWindow.KeyboardEvent },
      Document: { configurable: true, value: ownerWindow.Document },
      MutationObserver: {
        configurable: true,
        value: ownerWindow.MutationObserver,
      },
    }),
    {},
  );
  implementation.view = lookalike;
  expect(event.isTrusted).toBe(true);
  expect(event.view).toBe(lookalike);
  expect(lookalike).not.toBe(ownerWindow);
  expect(Object.getPrototypeOf(lookalike)).toBe(
    Object.getPrototypeOf(ownerWindow),
  );
  expect(lookalike.document).toBe(ownerDocument);
  expect(lookalike.Event).toBe(ownerWindow.Event);
  expect(lookalike.UIEvent).toBe(ownerWindow.UIEvent);
  expect(lookalike.KeyboardEvent).toBe(ownerWindow.KeyboardEvent);
  expect(lookalike.Document).toBe(ownerWindow.Document);
  expect(lookalike.MutationObserver).toBe(ownerWindow.MutationObserver);
  await act(async () => {
    view.dom.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  });
  return event;
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
    onConnectAgent: vi.fn<() => void>(),
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
  visit: MenuVisit;
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
      onConnectAgent={visit.onConnectAgent}
    />
  );
}

function open(visit: Visit, state = slashState()) {
  act(() => visit.controller.emit(state));
  expect(screen.getByTestId("slash-menu")).toBeInTheDocument();
}

function expectNativeTitles(query = "") {
  const items = filterSlashItems(query, SLASH_ITEMS, { inTable: false, canComment: true });
  const root = screen.getByTestId("slash-menu");
  const groups = SLASH_GROUPS.filter((group) => items.some((item) => item.group === group));
  expect(root).toHaveAttribute("role", "listbox");
  expect(root).toHaveAttribute("aria-label", "Insert block");
  expect(root).toHaveAttribute("class", "touch-target scrollbar-thin absolute z-40 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-xl animate-fade-in");
  expect(root.style.width).toBe("288px");
  expect(Number.parseFloat(root.style.maxHeight)).toBeLessThanOrEqual(36 * 8 + 8);
  expect(root.querySelectorAll("button")).toHaveLength(items.length);
  expect(root.querySelectorAll('[role="option"]')).toHaveLength(items.length || 1);
  expect(root.querySelectorAll("svg")).toHaveLength(items.length);
  expect(root.querySelectorAll("[title]")).toHaveLength(
    items.length + items.filter((item) => item.description).length,
  );
  expect(root.querySelectorAll("span")).toHaveLength(
    items.length * 2 + items.filter((item) => item.description).length + items.filter((item) => item.hint).length,
  );
  expect(root.children).toHaveLength(groups.length || 1);
  for (const [groupIndex, group] of groups.entries()) {
    const element = root.children[groupIndex];
    const heading = element.firstElementChild!;
    expect(element.tagName).toBe("DIV");
    expect(element.getAttributeNames()).toEqual([]);
    expect(element.children).toHaveLength(items.filter((item) => item.group === group).length + 1);
    expect(heading.tagName).toBe("DIV");
    expect(heading.getAttributeNames()).toEqual(["class"]);
    expect(heading).toHaveAttribute("class", "px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3");
    expect(heading.textContent).toBe(group);
  }
  for (const [index, item] of items.entries()) {
    const row = screen.getByTestId(`slash-item-${item.id}`);
    const [icon, body, hint] = Array.from(row.children);
    const [title, description] = Array.from(body.children);
    expect(row).toHaveAttribute("type", "button");
    expect(row).toHaveAttribute("role", "option");
    expect(row).toHaveAttribute("data-index", String(index));
    expect(row).toHaveAttribute("aria-selected", String(index === 0));
    expect(row.style.height).toBe(item.description ? "52px" : "36px");
    expect(row).toHaveAttribute("class", `flex w-full items-center gap-3 px-3 text-left text-sm text-ink-2${index === 0 ? " bg-accent-soft text-ink" : ""}`);
    expect(row.parentElement?.firstElementChild?.textContent).toBe(item.group);
    expect(row.children).toHaveLength(item.hint ? 3 : 2);
    expect(icon.tagName).toBe("svg");
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "16");
    expect(icon).toHaveClass("shrink-0", "text-ink-3");
    expect(body.tagName).toBe("SPAN");
    expect(body.getAttributeNames()).toEqual(["class"]);
    expect(body).toHaveAttribute("class", "flex min-w-0 flex-1 flex-col");
    expect(body.children).toHaveLength(item.description ? 2 : 1);
    expect(title.tagName).toBe("SPAN");
    expect(title.getAttributeNames().sort()).toEqual(["class", "title"]);
    expect(title).toHaveAttribute("class", "truncate");
    expect(title.textContent).toBe(item.title);
    expect(title.getAttribute("title")).toBe(title.textContent);
    expect(title.childNodes).toHaveLength(1);
    if (item.description) {
      expect(description.tagName).toBe("SPAN");
      expect(description.getAttributeNames().sort()).toEqual(["class", "title"]);
      expect(description).toHaveAttribute("class", "truncate text-xs text-ink-3");
      expect(description.textContent).toBe(item.description);
      expect(description.getAttribute("title")).toBe(description.textContent);
      expect(description.childNodes).toHaveLength(1);
    } else {
      expect(description).toBeUndefined();
    }
    if (item.hint) {
      expect(hint.tagName).toBe("SPAN");
      expect(hint.getAttributeNames()).toEqual(["class"]);
      expect(hint).toHaveAttribute("class", "text-xs text-ink-3");
      expect(hint.textContent).toBe(item.hint);
    } else {
      expect(hint).toBeUndefined();
    }
  }
  return root;
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
  document
    .querySelectorAll<HTMLElement>('[contenteditable="true"]')
    .forEach((element) => element.remove());
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
            expect(staleKeyHandler(unpublishedKey())).toBe(false);
            expect(staleKeyHandler(unpublishedKey())).toBe(false);
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

    clickRow(captureRow("text"));
    expect(slashActions.applyCommand).toHaveBeenCalledOnce();
    expect(slashActions.applyCommand.mock.calls[0][0]).toBe(b.view);
    expect(slashActions.applyCommand.mock.calls[0][2]).toBe(b.session.undoManager);
    expect(b.view.focus).toHaveBeenCalledOnce();
    expect(a.view.focus).not.toHaveBeenCalled();

    act(() => b.controller.emit(slashState("no-such-item", 333)));
    expect(screen.getByTestId("slash-empty")).toHaveTextContent("No matches");

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
            expect(staleKeyHandler(unpublishedKey())).toBe(false);
          }}
        />,
      );
    });

    expect(screen.getByTestId("slash-menu")).toHaveStyle({ left: "333px" });
    expect(screen.getByTestId("slash-item-image")).toHaveAttribute("aria-selected", "true");
    clickRow(captureRow("image"));
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
            expect(staleKeyHandler(unpublishedKey())).toBe(false);
            expect(staleKeyHandler(unpublishedKey())).toBe(false);
          }}
        />,
      );
    });

    expect(screen.queryByTestId("slash-menu")).toBeNull();
    expect(slashActions.applyCommand).not.toHaveBeenCalled();
    expect(a.view.focus).not.toHaveBeenCalled();
    expect(a.controller.subscriptions).toBe(a.controller.unsubscriptions);
  });

});

describe("slash-menu native title metadata", () => {
  it("exposes every actual catalog label without adding nodes or changing controls", () => {
    const visit = makeVisit();
    render(
      <StrictMode>
        <BoundaryHarness visit={visit} />
      </StrictMode>,
    );
    open(visit);
    expectNativeTitles();
    expect(screen.getAllByRole("option")).toHaveLength(SLASH_ITEMS.length);
    expect(slashActions.applyCommand).not.toHaveBeenCalled();
    expect(slashActions.applyItem).not.toHaveBeenCalled();
    expect(visit.view.dispatch).not.toHaveBeenCalled();
  });

  it("removes old titles through filtering, group changes, close-reopen, and session replacement", () => {
    const a = makeVisit();
    const b = makeVisit(a.controller);
    const mounted = render(
      <StrictMode>
        <BoundaryHarness visit={a} />
      </StrictMode>,
    );
    open(a, slashState("agent"));
    expectNativeTitles("agent");
    const oldAgent = captureRow("agent");
    const oldDescription = screen.getByText(SLASH_ITEMS.find((item) => item.id === "agent")!.description!);

    open(a, slashState("code ts"));
    expectNativeTitles("code ts");
    expect(oldAgent.element).not.toBeInTheDocument();
    expect(oldDescription).not.toBeInTheDocument();
    const oldCode = captureRow("code");
    open(a, slashState("no-such-item"));
    expectNativeTitles("no-such-item");
    expect(screen.getByTestId("slash-empty").textContent).toBe("No matches");
    expect(oldCode.element).not.toBeInTheDocument();

    act(() => a.controller.emit(null));
    expect(screen.queryByTestId("slash-menu")).toBeNull();
    open(a, slashState("image"));
    expectNativeTitles("image");
    const oldImage = captureRow("image");
    mounted.rerender(
      <StrictMode>
        <BoundaryHarness visit={b} />
      </StrictMode>,
    );
    expect(screen.queryByTestId("slash-menu")).toBeNull();
    expect(oldImage.element).not.toBeInTheDocument();
    open(b, slashState("keep"));
    expectNativeTitles("keep");
    const current = captureRow("agent");
    for (const retired of [oldAgent, oldCode, oldImage]) {
      clickRow(retired);
      clickRow({ ...retired, element: current.element });
    }
    expect(slashActions.applyCommand).not.toHaveBeenCalled();
    expect(slashActions.applyItem).not.toHaveBeenCalled();
    expect(a.view.focus).not.toHaveBeenCalled();
    expect(b.view.focus).not.toHaveBeenCalled();
    const accepted = clickRow(current, current.element.querySelector("[title]")!);
    current.click(accepted.event);
    expect(slashActions.applyItem).toHaveBeenCalledOnce();
    expect(slashActions.applyItem.mock.calls[0][0]).toBe(b.view);
    expect(slashActions.applyItem.mock.calls[0][2]).toBe(b.session.undoManager);
    expect(b.onConnectAgent).toHaveBeenCalledOnce();
    expect(a.onConnectAgent).not.toHaveBeenCalled();
  });

  it.each(["title", "description"] as const)("allows native hover on the agent %s without applying an editor command", (field) => {
    const visit = makeVisit();
    render(
      <StrictMode>
        <BoundaryHarness visit={visit} />
      </StrictMode>,
    );
    open(visit);
    const agent = SLASH_ITEMS.find((item) => item.id === "agent")!;
    const target = screen.getByText(agent[field]!);
    const before = captureRow("agent");
    const bodyMarkup = before.element.children[1].outerHTML;
    const iconMarkup = before.element.children[0].outerHTML;
    const controls = screen.getAllByRole("option");
    const activeElement = document.activeElement;
    fireEvent.mouseOver(target);
    expect(screen.getByTestId("slash-item-agent")).toHaveAttribute("aria-selected", "true");
    expect(target.getAttribute("title")).toBe(target.textContent);
    expect(screen.getAllByRole("option")).toEqual(controls);
    expect(before.element.children[1].outerHTML).toBe(bodyMarkup);
    expect(before.element.children[0].outerHTML).toBe(iconMarkup);
    expect(document.activeElement).toBe(activeElement);
    expect(slashActions.applyCommand).not.toHaveBeenCalled();
    expect(slashActions.applyItem).not.toHaveBeenCalled();
    expect(slashActions.close).not.toHaveBeenCalled();
    expect(visit.view.dispatch).not.toHaveBeenCalled();
    expect(visit.view.focus).not.toHaveBeenCalled();
    expect(visit.session.undoManager.stopCapturing).not.toHaveBeenCalled();
    expect(visit.onConnectAgent).not.toHaveBeenCalled();

    clickRow(before, target);
    expect(slashActions.applyItem).not.toHaveBeenCalled();
    const current = captureRow("agent");
    const accepted = clickRow(current, target);
    current.click(accepted.event);
    expect(slashActions.applyItem).toHaveBeenCalledOnce();
    expect(visit.onConnectAgent).toHaveBeenCalledOnce();
  });
});

describe("slash-menu native keyboard publication", () => {
  it("moves Home and End to exact filtered boundaries without moving editor focus or selection", async () => {
    const visit = makeIntegratedVisit();
    try {
      render(
        <StrictMode>
          <BoundaryHarness visit={visit} />
        </StrictMode>,
      );
      await openIntegrated(visit);
      await act(async () => {
        visit.view.dispatch(visit.view.state.tr.setMeta("slash-key-probe", true));
        await Promise.resolve();
      });
      const dispatch = vi.mocked(visit.view.dispatch);
      const focus = vi.mocked(visit.view.focus);
      dispatch.mockClear();
      focus.mockClear();
      vi.mocked(Element.prototype.scrollIntoView).mockClear();
      const editorState = visit.view.state;
      const selection = visit.view.state.selection;

      const end = await dispatchIntegratedKey(visit.view, "End");
      expect(end.defaultPrevented).toBe(true);
      expect(screen.getByTestId("slash-item-agent")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(
        screen
          .getAllByRole("option")
          .filter((row) => row.getAttribute("aria-selected") === "true"),
      ).toHaveLength(1);
      expect(visit.view.state).toBe(editorState);
      expect(visit.view.state.selection).toBe(selection);
      expect(visit.view.dom).toHaveFocus();
      expect(dispatch).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(slashActions.applyCommand).not.toHaveBeenCalled();
      expect(slashActions.applyItem).not.toHaveBeenCalled();

      vi.mocked(Element.prototype.scrollIntoView).mockClear();
      const inertEnd = await dispatchIntegratedKey(visit.view, "End");
      expect(inertEnd.defaultPrevented).toBe(true);
      expect(screen.getByTestId("slash-item-agent")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();

      const home = await dispatchIntegratedKey(visit.view, "Home");
      expect(home.defaultPrevented).toBe(true);
      expect(screen.getByTestId("slash-item-text")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(visit.view.state).toBe(editorState);
      expect(visit.view.state.selection).toBe(selection);

      await act(async () => {
        visit.view.dispatch(visit.view.state.tr.insertText("hea"));
        await Promise.resolve();
      });
      expect(screen.getByTestId("slash-item-heading1")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      dispatch.mockClear();
      const filteredSelection = visit.view.state.selection;
      const filteredEnd = await dispatchIntegratedKey(visit.view, "End");
      expect(filteredEnd.defaultPrevented).toBe(true);
      expect(screen.getByTestId("slash-item-heading3")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(visit.view.state.selection).toBe(filteredSelection);
      expect(dispatch).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
    } finally {
      visit.view.destroy();
      visit.host.remove();
      visit.restoreOwnerWindow();
    }
  });

  it("retains wrapping arrows and exact Enter behavior", async () => {
    const visit = makeIntegratedVisit();
    try {
      render(
        <StrictMode>
          <BoundaryHarness visit={visit} />
        </StrictMode>,
      );
      await openIntegrated(visit);

      expect((await dispatchIntegratedKey(visit.view, "ArrowUp")).defaultPrevented).toBe(true);
      expect(screen.getByTestId("slash-item-agent")).toHaveAttribute("aria-selected", "true");
      expect((await dispatchIntegratedKey(visit.view, "ArrowDown")).defaultPrevented).toBe(true);
      expect(screen.getByTestId("slash-item-text")).toHaveAttribute("aria-selected", "true");

      expect((await dispatchIntegratedKey(visit.view, "Enter")).defaultPrevented).toBe(true);
      expect(slashActions.applyCommand).toHaveBeenCalledOnce();
      expect(visit.view.focus).toHaveBeenCalledOnce();
    } finally {
      visit.view.destroy();
      visit.host.remove();
      visit.restoreOwnerWindow();
    }
  });

  it("rejects null, foreign, and structural owner-window views without menu or editor work", async () => {
    const visit = makeIntegratedVisit();
    const foreignFrame = document.createElement("iframe");
    document.body.append(foreignFrame);
    try {
      render(
        <StrictMode>
          <BoundaryHarness visit={visit} />
        </StrictMode>,
      );
      await openIntegrated(visit);
      await act(async () => {
        visit.view.dispatch(visit.view.state.tr.setMeta("slash-key-probe", true));
        await Promise.resolve();
      });
      const dispatch = vi.mocked(visit.view.dispatch);
      const focus = vi.mocked(visit.view.focus);
      dispatch.mockClear();
      focus.mockClear();
      vi.mocked(Element.prototype.scrollIntoView).mockClear();
      const editorState = visit.view.state;
      const selection = visit.view.state.selection;

      const nullView = await dispatchRejectedNativeViewKey(visit.view, null);
      const foreignWindow = foreignFrame.contentWindow;
      if (!foreignWindow) throw new Error("Foreign frame has no window");
      const foreignView = await dispatchRejectedNativeViewKey(
        visit.view,
        foreignWindow,
      );
      const rejected = await dispatchStructuralWindowLookalikeKey(
        visit.view,
        "End",
      );

      expect(nullView.isTrusted).toBe(true);
      expect(nullView.view).toBeNull();
      expect(nullView.defaultPrevented).toBe(false);
      expect(foreignView.isTrusted).toBe(true);
      expect(foreignView.view).toBe(foreignWindow);
      expect(foreignView.view).not.toBe(visit.view.dom.ownerDocument.defaultView);
      expect(foreignView.defaultPrevented).toBe(false);
      expect(rejected.isTrusted).toBe(true);
      expect(rejected.defaultPrevented).toBe(false);
      expect(screen.getByTestId("slash-item-text")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(
        screen
          .getAllByRole("option")
          .filter((row) => row.getAttribute("aria-selected") === "true"),
      ).toHaveLength(1);
      expect(visit.view.state).toBe(editorState);
      expect(visit.view.state.selection).toBe(selection);
      expect(visit.view.dom).toHaveFocus();
      expect(dispatch).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(slashActions.applyCommand).not.toHaveBeenCalled();
      expect(slashActions.applyItem).not.toHaveBeenCalled();
      expect(slashActions.close).not.toHaveBeenCalled();
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    } finally {
      visit.view.destroy();
      visit.host.remove();
      visit.restoreOwnerWindow();
      foreignFrame.remove();
    }
  });

  it.each(["Tab", "Escape"] as const)("retains exact %s behavior", async (key) => {
    const visit = makeIntegratedVisit();
    try {
      render(
        <StrictMode>
          <BoundaryHarness visit={visit} />
        </StrictMode>,
      );
      await openIntegrated(visit);
      expect((await dispatchIntegratedKey(visit.view, key)).defaultPrevented).toBe(true);
      if (key === "Tab") {
        expect(slashActions.applyCommand).toHaveBeenCalledOnce();
        expect(visit.view.focus).toHaveBeenCalledOnce();
        expect(slashActions.close).not.toHaveBeenCalled();
      } else {
        expect(slashActions.close).toHaveBeenCalledOnce();
        expect(slashActions.close).toHaveBeenCalledWith(visit.view);
        expect(slashActions.applyCommand).not.toHaveBeenCalled();
      }
    } finally {
      visit.view.destroy();
      visit.host.remove();
      visit.restoreOwnerWindow();
    }
  });

  it.each(["root", "title", "description"] as const)("rejects mutate-restored menu DOM and lets a complete query successor recover (%s)", async (field) => {
    const visit = makeIntegratedVisit();
    try {
      render(
        <StrictMode>
          <BoundaryHarness visit={visit} />
        </StrictMode>,
      );
      await openIntegrated(visit);
      const root = screen.getByTestId("slash-menu");
      const agent = SLASH_ITEMS.find((item) => item.id === "agent")!;
      const target = field === "root" ? root : screen.getByText(agent[field]!);
      const attribute = field === "root" ? "data-history-probe" : "title";
      const original = target.getAttribute(attribute);
      target.setAttribute(attribute, "changed");
      if (original === null) target.removeAttribute(attribute);
      else target.setAttribute(attribute, original);

      const rejected = await dispatchIntegratedKey(visit.view, "End");
      expect(rejected.defaultPrevented).toBe(false);
      expect((await dispatchIntegratedKey(visit.view, "Enter")).defaultPrevented).toBe(false);
      expect(screen.getByTestId("slash-item-text")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(slashActions.applyCommand).not.toHaveBeenCalled();
      expect(slashActions.applyItem).not.toHaveBeenCalled();
      expect(visit.view.focus).not.toHaveBeenCalled();

      await act(async () => {
        visit.view.dispatch(visit.view.state.tr.insertText("hea"));
        await Promise.resolve();
      });
      const recovered = await dispatchIntegratedKey(visit.view, "End");
      expect(recovered.defaultPrevented).toBe(true);
      expect(screen.getByTestId("slash-item-heading3")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect((await dispatchIntegratedKey(visit.view, "Enter")).defaultPrevented).toBe(true);
      expect(slashActions.applyCommand).toHaveBeenCalledOnce();
      expect(slashActions.applyCommand.mock.calls[0][0]).toBe(visit.view);
      expect(slashActions.applyCommand.mock.calls[0][2]).toBe(visit.session.undoManager);
    } finally {
      visit.view.destroy();
      visit.host.remove();
      visit.restoreOwnerWindow();
    }
  });
});

describe("slash-menu pointer presentation", () => {
  it.each([
    ["title", false],
    ["title", true],
    ["description", false],
    ["description", true],
  ] as const)("guards the exact %s attribute, including restoration=%s", (field, restoreBeforeClick) => {
    const visit = makeVisit();
    render(
      <StrictMode>
        <BoundaryHarness visit={visit} />
      </StrictMode>,
    );
    open(visit, slashState("keep"));
    const row = captureRow("agent");
    const root = captureRoot();
    const agent = SLASH_ITEMS.find((item) => item.id === "agent")!;
    const target = screen.getByText(agent[field]!);
    const original = target.getAttribute("title")!;
    target.setAttribute("title", "changed");
    if (restoreBeforeClick) target.setAttribute("title", original);
    const rejectedDown = invokeMouse(root.down, root.element, "mousedown", { target });
    clickRow(row, target);
    expect(rejectedDown.preventDefault).not.toHaveBeenCalled();
    expect(slashActions.applyItem).not.toHaveBeenCalled();
    expect(visit.onConnectAgent).not.toHaveBeenCalled();
    expect(visit.view.focus).not.toHaveBeenCalled();
    if (!restoreBeforeClick) target.setAttribute("title", original);
    clickRow(row, target);
    expect(slashActions.applyItem).not.toHaveBeenCalled();

    open(visit, slashState("keep"));
    expectNativeTitles("keep");
    const current = captureRow("agent");
    const currentTarget = screen.getByText(agent[field]!);
    clickRow(current, target);
    clickRow({ ...row, element: current.element }, currentTarget);
    expect(slashActions.applyItem).not.toHaveBeenCalled();
    const accepted = clickRow(current, currentTarget);
    current.click(accepted.event);
    expect(slashActions.applyItem).toHaveBeenCalledOnce();
    expect(slashActions.applyItem.mock.calls[0][0]).toBe(visit.view);
    expect(slashActions.applyItem.mock.calls[0][2]).toBe(visit.session.undoManager);
    expect(visit.onConnectAgent).toHaveBeenCalledOnce();
  });

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
    expect(screen.getByText("Connect an AI agent")).toBeInTheDocument();
    expect(screen.getByText("Set up Copilot, Claude or Cursor, or invite your agent here")).toBeInTheDocument();
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
    ["agent", "onConnectAgent"],
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
