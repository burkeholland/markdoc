// @vitest-environment jsdom
import { StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabSession, EditMode } from "@/editor/collab/session";
import { ModeSwitcher } from "./header";

type ModeRole = "owner" | "editor" | "commenter" | "viewer";

class ModeSession {
  version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    public docId: string,
    public role: ModeRole,
    public mode: EditMode,
  ) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setMode = vi.fn((mode: EditMode) => {
    this.mode = mode;
    this.publish();
  });

  setExternalMode(mode: EditMode) {
    this.mode = mode;
    this.publish();
  }

  asCollabSession(): CollabSession {
    return this as unknown as CollabSession;
  }

  private publish() {
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

function ModeBoundary({
  session,
  present = true,
  boundary = 0,
  revision = 0,
  onChildBoundary,
  onBoundary,
}: {
  session: ModeSession;
  present?: boolean;
  boundary?: number;
  revision?: number;
  onChildBoundary?: () => void;
  onBoundary?: () => void;
}) {
  void revision;
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return (
    <>
      <LayoutBoundary boundary={boundary} onBoundary={onChildBoundary} />
      {present ? <ModeSwitcher session={session.asCollabSession()} /> : null}
    </>
  );
}

function LayoutBoundary({ boundary, onBoundary }: { boundary: number; onBoundary?: () => void }) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return null;
}

interface ReactFiber {
  return: ReactFiber | null;
  alternate?: ReactFiber | null;
  elementType?: string | { displayName?: string; name?: string };
  memoizedProps?: Record<string, unknown>;
  ref?: ((element: Element | null) => void) | { current: Element | null } | null;
}

function fiberFor(element: HTMLElement) {
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!fiberKey || !propsKey) throw new Error("React internals were not attached");
  const record = element as unknown as Record<string, ReactFiber | Record<string, unknown>>;
  const fiber = record[fiberKey] as ReactFiber;
  const props = record[propsKey] as Record<string, unknown>;
  const alternate = fiber.alternate;
  if (!alternate) return fiber;
  const eventProps = ["onClick", "onPointerDown", "onKeyDown"];
  const alternateIsCurrent = eventProps.some(
    (name) => typeof props[name] === "function" && alternate.memoizedProps?.[name] === props[name],
  );
  return alternateIsCurrent ? alternate : fiber;
}

function nearestHandler<T>(element: HTMLElement, property: string): T {
  let fiber: ReactFiber | null = fiberFor(element);
  while (fiber) {
    const handler = fiber.memoizedProps?.[property];
    if (typeof handler === "function") return handler as T;
    fiber = fiber.return;
  }
  throw new Error(`No ${property} handler was found`);
}

function handlerOwnedBy<T>(element: HTMLElement, property: string, owner: string): T {
  let fiber: ReactFiber | null = fiberFor(element);
  while (fiber) {
    const type = fiber.elementType;
    const name = typeof type === "string" ? type : type?.displayName ?? type?.name;
    const handler = fiber.memoizedProps?.[property];
    if (name === owner && typeof handler === "function") return handler as T;
    fiber = fiber.return;
  }
  throw new Error(`No ${property} handler owned by ${owner} was found`);
}

function reactHandler<T>(element: HTMLElement, property: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached while capturing ${property}`);
  const props = (element as unknown as Record<string, Record<string, unknown>>)[propsKey];
  const handler = props[property];
  if (typeof handler !== "function") throw new Error(`No ${property} handler was attached`);
  return handler as T;
}

type OpenHandler = (open: boolean) => void;
type ValueHandler = (value: string) => void;
type EventHandler = (event: Event) => void;
type SourceHandler = (event: ReturnType<typeof sourceEvent>) => void;
type OutsideHandler = (event: CustomEvent<{ originalEvent: Event }>) => void;

function trigger() {
  return screen.getByTestId("mode-switcher");
}

function menu() {
  return screen.getByRole("menu");
}

function radio(name: "Editing" | "Suggesting" | "Viewing") {
  return screen.getByRole("menuitemradio", { name: new RegExp(name) });
}

function openMenu() {
  fireEvent(trigger(), new PointerEvent("pointerdown", {
    bubbles: true,
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  }));
  return menu();
}

function pointerDown(element: Element, event = new PointerEvent("pointerdown", {
  bubbles: true,
  button: 0,
  ctrlKey: false,
  pointerType: "mouse",
})) {
  fireEvent(element, event);
  return event;
}

function keyDown(element: Element, key: string) {
  const event = new KeyboardEvent("keydown", { bubbles: true, key });
  fireEvent(element, event);
  return event;
}

async function waitForOutsideListener() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function captureOpenChange(): OpenHandler {
  return nearestHandler(trigger(), "onOpenChange");
}

function captureModeChange(): ValueHandler {
  return nearestHandler(radio("Editing"), "onValueChange");
}

function captureRowSelect(name: "Editing" | "Suggesting" | "Viewing"): EventHandler {
  return handlerOwnedBy(radio(name), "onSelect", "MenuRadioItem");
}

function captureReaderSelect(): EventHandler {
  return handlerOwnedBy(screen.getByTestId("mode-reader"), "onSelect", "MenuItem");
}

function captureEscape(): (event: KeyboardEvent) => void {
  return handlerOwnedBy(menu(), "onEscapeKeyDown", "MenuContent");
}

function captureOutside(): OutsideHandler {
  return handlerOwnedBy(menu(), "onPointerDownOutside", "MenuContent");
}

function sourceEvent(currentTarget: EventTarget | null, key = "") {
  return {
    currentTarget,
    target: currentTarget,
    key,
    button: 0,
    ctrlKey: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    isDefaultPrevented() {
      return this.defaultPrevented;
    },
    stopPropagation: vi.fn(),
    isPropagationStopped: () => false,
  };
}

function nativeSourceEvent(
  currentTarget: EventTarget,
  nativeEvent: PointerEvent | KeyboardEvent,
  key = "",
) {
  return {
    ...sourceEvent(currentTarget, key),
    type: nativeEvent.type,
    target: nativeEvent.target,
    nativeEvent,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
  };
}

function selectEvent(currentTarget: EventTarget | null) {
  return {
    currentTarget,
    target: currentTarget,
    defaultPrevented: false,
    preventDefault: vi.fn(),
  } as unknown as Event;
}

function selectMode(name: "Editing" | "Suggesting" | "Viewing", value: EditMode) {
  void value;
  fireEvent.click(radio(name));
}

beforeEach(() => {
  vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ModeSwitcher presentation authority", () => {
  it.each([
    ["pointer", "", "stale-before-current"],
    ["pointer", "", "current-before-stale"],
    ["keyboard", "Enter", "stale-before-current"],
    ["keyboard", "Enter", "current-before-stale"],
    ["keyboard", " ", "stale-before-current"],
    ["keyboard", " ", "current-before-stale"],
    ["keyboard", "ArrowDown", "stale-before-current"],
    ["keyboard", "ArrowDown", "current-before-stale"],
  ] as const)("accepts only the current exact %s open source with %s %s", (kind, key, order) => {
    const session = new ModeSession("same-element", "owner", "editing");
    const host = document.createElement("div");
    const wrong = document.createElement("button");
    document.body.append(wrong, host);
    const root = createRoot(host);

    try {
      act(() => root.render(<ModeBoundary session={session} />));
      const reused = trigger();
      const stale = reactHandler<SourceHandler>(reused, kind === "pointer" ? "onPointerDown" : "onKeyDown");
      const staleOpen = captureOpenChange();

      act(() => root.render(<ModeBoundary session={session} revision={1} />));
      expect(trigger()).toBe(reused);
      const exactEvent = kind === "pointer"
        ? new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            ctrlKey: false,
            pointerType: "mouse",
          })
        : new KeyboardEvent("keydown", { bubbles: true, key });
      const invokeCurrent = () => reused.dispatchEvent(exactEvent);
      const invokeStale = () => {
        stale(sourceEvent(reused, key));
        staleOpen(true);
        if (kind === "pointer") {
          reactHandler<SourceHandler>(reused, "onPointerDown")(sourceEvent(wrong, key));
        } else {
          reactHandler<SourceHandler>(reused, "onKeyDown")(sourceEvent(wrong, key));
        }
      };
      act(() => {
        if (order === "stale-before-current") {
          reused.addEventListener(exactEvent.type, (nativeEvent) => {
            stale(nativeSourceEvent(reused, nativeEvent as PointerEvent | KeyboardEvent, key));
            staleOpen(true);
          }, { capture: true, once: true });
          invokeCurrent();
          invokeCurrent();
        } else {
          invokeCurrent();
          invokeCurrent();
          invokeStale();
        }
      });

      expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
      expect(session.setMode).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("rejects bare disclosure booleans, wrong values, wrong siblings, detached controls, and foreign controls without consuming the current presentation", () => {
    const session = new ModeSession("exact-sources", "owner", "viewing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const open = captureOpenChange();

    act(() => open(true));
    expect(screen.queryByRole("menu")).toBeNull();
    openMenu();

    const editing = radio("Editing");
    const detached = document.createElement("div");
    const sibling = document.createElement("div");
    document.body.append(sibling);
    const foreign = document.implementation.createHTMLDocument("foreign").createElement("div");
    const selectEditing = captureRowSelect("Editing");
    const changeMode = captureModeChange();
    act(() => {
      selectEditing(selectEvent(sibling));
      changeMode("editing");
      selectEditing(selectEvent(detached));
      changeMode("editing");
      selectEditing(selectEvent(foreign));
      changeMode("editing");
      selectEditing(selectEvent(editing));
      changeMode("suggesting");
    });
    expect(session.setMode).not.toHaveBeenCalled();
    expect(menu()).toBeInTheDocument();

    fireEvent.click(editing);
    fireEvent.click(editing);
    expect(session.setMode).toHaveBeenCalledExactlyOnceWith("editing");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("retires an open A before child and parent layout when the exact session changes, then keeps B usable", () => {
    const sessionA = new ModeSession("document-a", "owner", "editing");
    const sessionB = new ModeSession("document-b", "editor", "viewing");
    const host = document.createElement("div");
    const focusOwner = document.createElement("button");
    document.body.append(focusOwner, host);
    const root = createRoot(host);

    try {
      act(() => root.render(<ModeBoundary session={sessionA} />));
      openMenu();
      const oldTrigger = trigger();
      const oldEditing = radio("Editing");
      const oldReader = screen.getByTestId("mode-reader");
      const stalePointer = reactHandler<SourceHandler>(oldTrigger, "onPointerDown");
      const staleOpen = captureOpenChange();
      const staleSelect = captureRowSelect("Editing");
      const staleMode = captureModeChange();
      const staleReader = captureReaderSelect();
      const boundaries: string[] = [];
      const invokeStale = (boundary: string) => {
        boundaries.push(boundary);
        focusOwner.focus();
        stalePointer(sourceEvent(oldTrigger));
        staleOpen(true);
        staleSelect(selectEvent(oldEditing));
        staleMode("editing");
        staleReader(selectEvent(oldReader));
      };

      act(() => root.render(
        <ModeBoundary
          session={sessionB}
          boundary={1}
          onChildBoundary={() => invokeStale("child")}
          onBoundary={() => invokeStale("parent")}
        />,
      ));

      expect(boundaries).toEqual(["child", "parent"]);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(focusOwner).toHaveFocus();
      expect(sessionA.setMode).not.toHaveBeenCalled();
      expect(sessionB.setMode).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();

      openMenu();
      act(() => selectMode("Suggesting", "suggesting"));
      expect(sessionB.setMode).toHaveBeenCalledExactlyOnceWith("suggesting");
      expect(sessionB.setMode.mock.contexts[0]).toBe(sessionB);

      openMenu();
      const reader = screen.getByTestId("mode-reader");
      fireEvent.click(reader);
      expect(window.open).toHaveBeenCalledExactlyOnceWith("/p/document-b", "_blank", "noopener");
    } finally {
      act(() => root.unmount());
    }
  });

  it("retires detach, reattach, replacement, removal, and unmount handlers without clearing a newer publication", () => {
    const removed = new ModeSession("removed", "owner", "editing");
    const current = new ModeSession("current", "owner", "editing");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<ModeBoundary session={removed} />));
    const oldElement = trigger();
    const oldPointer = reactHandler<SourceHandler>(oldElement, "onPointerDown");
    const oldOpen = captureOpenChange();
    const ref = fiberFor(oldElement).ref;
    if (typeof ref !== "function") throw new Error("Mode trigger callback ref was not attached");
    act(() => {
      ref(null);
      ref(oldElement);
    });
    oldPointer(sourceEvent(oldElement));
    oldOpen(true);
    expect(screen.queryByRole("menu")).toBeNull();

    act(() => root.render(<ModeBoundary session={current} revision={1} />));
    act(() => {
      oldPointer(sourceEvent(trigger()));
    });
    pointerDown(trigger());
    expect(menu()).toBeInTheDocument();

    const staleReaderElement = screen.getByTestId("mode-reader");
    const staleReader = captureReaderSelect();
    const staleModeElement = radio("Viewing");
    const staleMode = captureRowSelect("Viewing");
    const staleValue = captureModeChange();
    act(() => root.render(<ModeBoundary session={current} present={false} boundary={2} />));
    act(() => {
      staleReader(selectEvent(staleReaderElement));
      staleMode(selectEvent(staleModeElement));
      staleValue("viewing");
      oldOpen(false);
      root.unmount();
      staleReader(selectEvent(staleReaderElement));
      staleMode(selectEvent(staleModeElement));
      staleValue("viewing");
    });
    expect(removed.setMode).not.toHaveBeenCalled();
    expect(current.setMode).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it("publishes viewer rows exactly and leaves disabled row events inert", () => {
    const viewer = new ModeSession("viewer", "viewer", "viewing");
    render(<ModeSwitcher session={viewer.asCollabSession()} />);
    openMenu();
    expect(radio("Editing")).toHaveAttribute("aria-disabled", "true");
    expect(radio("Suggesting")).toHaveAttribute("aria-disabled", "true");
    expect(radio("Viewing")).not.toHaveAttribute("aria-disabled");

    act(() => {
      selectMode("Editing", "editing");
      selectMode("Suggesting", "suggesting");
    });
    expect(viewer.setMode).not.toHaveBeenCalled();
    expect(menu()).toBeInTheDocument();

    act(() => selectMode("Viewing", "viewing"));
    expect(viewer.setMode).toHaveBeenCalledExactlyOnceWith("viewing");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("requires exact trigger, content, and outside close events before closing or returning focus", async () => {
    const session = new ModeSession("close-sources", "owner", "editing");
    render(
      <>
        <ModeSwitcher session={session.asCollabSession()} />
        <button type="button">Outside</button>
      </>,
    );
    const modeTrigger = trigger();
    const outside = screen.getByRole("button", { name: "Outside" });
    openMenu();
    menu().focus();

    let close = captureOpenChange();
    const triggerPointer = reactHandler<SourceHandler>(modeTrigger, "onPointerDown");
    act(() => {
      triggerPointer(sourceEvent(outside));
      close(false);
    });
    expect(menu()).toBeInTheDocument();
    expect(modeTrigger).not.toHaveFocus();

    pointerDown(modeTrigger);
    expect(screen.queryByRole("menu")).toBeNull();

    openMenu();
    menu().focus();
    close = captureOpenChange();
    const escape = captureEscape();
    const wrongEscape = {
      key: "Escape",
      target: outside,
      currentTarget: document,
      defaultPrevented: false,
    } as unknown as KeyboardEvent;
    act(() => {
      escape(wrongEscape);
      close(false);
    });
    expect(menu()).toBeInTheDocument();
    expect(modeTrigger).not.toHaveFocus();

    keyDown(radio("Editing"), "Escape");
    expect(screen.queryByRole("menu")).toBeNull();

    openMenu();
    menu().focus();
    close = captureOpenChange();
    const outsideHandler = captureOutside();
    const wrongOriginal = { target: outside } as unknown as Event;
    act(() => {
      outsideHandler({
        currentTarget: modeTrigger,
        target: modeTrigger,
        detail: { originalEvent: wrongOriginal },
        defaultPrevented: false,
      } as unknown as CustomEvent<{ originalEvent: Event }>);
      close(false);
    });
    expect(menu()).toBeInTheDocument();
    expect(modeTrigger).not.toHaveFocus();

    await waitForOutsideListener();
    pointerDown(outside);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("rejects changed doc, role, mode, and method facts until the exact frozen presentation is current again", () => {
    const session = new ModeSession("frozen-document", "owner", "viewing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    openMenu();
    const readerElement = screen.getByTestId("mode-reader");
    const reader = captureReaderSelect();
    const editingElement = radio("Editing");
    const editing = captureRowSelect("Editing");
    const changeMode = captureModeChange();
    const originalSetMode = session.setMode;
    const wrongReader = document.createElement("div");
    document.body.append(wrongReader);

    act(() => reader(selectEvent(wrongReader)));
    session.docId = "changed-document";
    act(() => reader(selectEvent(readerElement)));
    session.docId = "frozen-document";
    session.role = "viewer";
    act(() => {
      editing(selectEvent(editingElement));
      changeMode("editing");
    });
    session.role = "owner";
    session.mode = "editing";
    act(() => reader(selectEvent(readerElement)));
    session.mode = "viewing";
    session.setMode = vi.fn();
    act(() => {
      editing(selectEvent(editingElement));
      changeMode("editing");
    });
    session.setMode = originalSetMode;

    expect(originalSetMode).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(menu()).toBeInTheDocument();

    fireEvent.click(editingElement);
    expect(originalSetMode).toHaveBeenCalledExactlyOnceWith("editing");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("retires a partial row handler while a fresh complete render remains usable", () => {
    const session = new ModeSession("row-ref", "owner", "editing");
    render(<ModeBoundary session={session} />);
    openMenu();
    const rowElement = radio("Viewing");
    const staleSelect = captureRowSelect("Viewing");
    const staleValue = captureModeChange();
    const staleClose = captureOpenChange();
    const ref = fiberFor(rowElement).ref;
    if (typeof ref !== "function") throw new Error("Mode row callback ref was not attached");

    act(() => {
      ref(null);
      ref(rowElement);
    });
    act(() => {
      staleSelect(selectEvent(rowElement));
      staleValue("viewing");
      staleClose(false);
    });
    expect(session.setMode).not.toHaveBeenCalled();
    expect(menu()).toBeInTheDocument();

    fireEvent.click(rowElement);
    expect(session.setMode).toHaveBeenCalledExactlyOnceWith("viewing");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each(["attribute", "order", "portal", "portal-ancestor", "placement"] as const)(
    "permanently retires a presentation after a restored transient %s mutation",
    (mutation) => {
      const session = new ModeSession(`mutation-${mutation}`, "owner", "editing");
      render(<ModeSwitcher session={session.asCollabSession()} />);
      openMenu();
      const content = menu();
      const group = radio("Editing").parentElement;
      if (!(group instanceof HTMLDivElement)) throw new Error("Mode group was not rendered");
      const editing = radio("Editing");
      const suggesting = radio("Suggesting");

      act(() => {
        if (mutation === "attribute") {
          editing.setAttribute("role", "option");
          editing.setAttribute("role", "menuitemradio");
        } else if (mutation === "order") {
          group.insertBefore(suggesting, editing);
          group.insertBefore(editing, suggesting);
        } else if (mutation === "portal") {
          const parent = content.parentNode;
          if (!parent) throw new Error("Mode portal did not have a parent");
          parent.removeChild(content);
          parent.appendChild(content);
        } else if (mutation === "portal-ancestor") {
          const portal = content.parentNode;
          const parent = portal?.parentNode;
          if (!portal || !parent) throw new Error("Mode portal wrapper did not have a parent");
          parent.removeChild(portal);
          parent.appendChild(portal);
        } else {
          const parent = content.parentNode;
          if (!parent) throw new Error("Mode portal did not have a parent");
          const sibling = document.createElement("div");
          parent.insertBefore(sibling, content);
          sibling.remove();
        }
      });

      fireEvent.click(radio("Viewing"));
      expect(session.setMode).not.toHaveBeenCalled();
      expect(menu()).toBeInTheDocument();
    },
  );
});

describe("ModeSwitcher current behavior", () => {
  it.each([
    ["trigger pointer", "pointer"],
    ["trigger keyboard", "keyboard"],
    ["Editing choice", "editing"],
    ["Suggesting choice", "suggesting"],
    ["Viewing choice", "viewing"],
    ["reader link", "reader"],
    ["Escape close", "escape"],
    ["outside close", "outside"],
  ] as const)("keeps the %s exact through direct-root Strict Mode replay", async (_name, family) => {
    const initialMode: EditMode = family === "viewing" ? "editing" : "viewing";
    const session = new ModeSession(`strict-${family}`, "owner", initialMode);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      act(() => root.render(
        <StrictMode>
          <ModeSwitcher session={session.asCollabSession()} />
          <button type="button">Strict outside</button>
        </StrictMode>,
      ));
      const modeTrigger = trigger();
      const strictOutside = screen.getByRole("button", { name: "Strict outside" });
      modeTrigger.focus();

      if (family === "pointer") {
        pointerDown(modeTrigger);
        expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
      } else if (family === "keyboard") {
        keyDown(modeTrigger, "Enter");
        expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
      } else {
        openMenu();
        if (family === "editing" || family === "suggesting" || family === "viewing") {
          const label = family === "editing" ? "Editing" : family === "suggesting" ? "Suggesting" : "Viewing";
          fireEvent.click(radio(label));
          expect(session.setMode).toHaveBeenCalledExactlyOnceWith(family);
          expect(screen.queryByRole("menu")).toBeNull();
        } else if (family === "reader") {
          fireEvent.click(screen.getByTestId("mode-reader"));
          expect(window.open).toHaveBeenCalledExactlyOnceWith(`/p/strict-${family}`, "_blank", "noopener");
          expect(screen.queryByRole("menu")).toBeNull();
        } else if (family === "escape") {
          keyDown(radio("Viewing"), "Escape");
          expect(screen.queryByRole("menu")).toBeNull();
        } else {
          await waitForOutsideListener();
          pointerDown(strictOutside);
          expect(screen.queryByRole("menu")).toBeNull();
        }
        await waitFor(() => expect(modeTrigger).toHaveFocus());
      }
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps Radix collision-placement attributes dynamic", () => {
    const session = new ModeSession("dynamic-placement", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    openMenu();

    act(() => {
      menu().setAttribute("data-side", "top");
      menu().setAttribute("data-align", "start");
    });
    fireEvent.click(radio("Viewing"));

    expect(session.setMode).toHaveBeenCalledExactlyOnceWith("viewing");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each([
    ["owner", "editing"],
    ["owner", "suggesting"],
    ["owner", "viewing"],
    ["editor", "editing"],
    ["editor", "suggesting"],
    ["editor", "viewing"],
    ["commenter", "viewing"],
    ["viewer", "viewing"],
  ] as const)("lets a current %s choose %s exactly once", (role, choice) => {
    const session = new ModeSession(`${role}-${choice}`, role, choice === "editing" ? "viewing" : "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    openMenu();

    const label = choice === "editing" ? "Editing" : choice === "suggesting" ? "Suggesting" : "Viewing";
    act(() => selectMode(label, choice));

    expect(session.setMode).toHaveBeenCalledExactlyOnceWith(choice);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each(["commenter", "viewer"] as const)(
    "rejects unknown and disabled editing modes for a current %s",
    (role) => {
      const session = new ModeSession(`${role}-disabled`, role, "viewing");
      render(<ModeSwitcher session={session.asCollabSession()} />);
      openMenu();
      const changeMode = captureModeChange();

      act(() => {
        changeMode("arbitrary");
        selectMode("Editing", "editing");
        selectMode("Suggesting", "suggesting");
      });

      expect(session.setMode).not.toHaveBeenCalled();
      expect(menu()).toBeInTheDocument();
    },
  );

  it.each(["owner", "editor"] as const)("keeps Editing and Suggesting enabled for a current %s", (role) => {
    const session = new ModeSession(`${role}-permissions`, role, "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    openMenu();

    expect(radio("Editing")).not.toHaveAttribute("aria-disabled");
    expect(radio("Suggesting")).not.toHaveAttribute("aria-disabled");
    expect(radio("Viewing")).not.toHaveAttribute("aria-disabled");
  });

  it("preserves labels, descriptions, styling, alignment, icons, and live session mode updates", () => {
    const session = new ModeSession("live-mode", "owner", "suggesting");
    render(<ModeSwitcher session={session.asCollabSession()} />);

    expect(trigger()).toHaveTextContent("Suggesting");
    expect(trigger()).toHaveClass("border-green-200", "bg-green-50", "text-green-800");
    expect(trigger().querySelector(".lucide-message-square-plus")).not.toBeNull();
    openMenu();

    const content = menu();
    expect(content).toHaveClass("w-64");
    expect(content).toHaveAttribute("data-align", "end");
    expect(radio("Editing")).toHaveTextContent("Edit the document directly");
    expect(radio("Suggesting")).toHaveTextContent("Edits become suggestions others can accept");
    expect(radio("Viewing")).toHaveTextContent("Read or print the final document");
    expect(screen.getAllByRole("menuitemradio").map((row) => row.textContent?.replace(/^✓/, ""))).toEqual([
      "EditingEdit the document directly",
      "SuggestingEdits become suggestions others can accept",
      "ViewingRead or print the final document",
    ]);
    expect(radio("Suggesting")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("mode-reader")).toHaveTextContent("Open reader view");

    act(() => session.setExternalMode("editing"));

    expect(trigger()).toHaveTextContent("Editing");
    expect(trigger()).toHaveClass("border-line-2", "bg-surface", "text-ink-2");
    expect(trigger()).not.toHaveClass("border-green-200");
    expect(trigger().querySelector(".lucide-pen-line")).not.toBeNull();
    expect(radio("Editing")).toHaveAttribute("aria-checked", "true");
    expect(radio("Suggesting")).toHaveAttribute("aria-checked", "false");
  });

  it("opens the current reader exactly once with the current document", async () => {
    const session = new ModeSession("reader-current", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    modeTrigger.focus();
    openMenu();

    const reader = screen.getByTestId("mode-reader");
    const selectReader = captureReaderSelect();
    const event = selectEvent(reader);
    fireEvent.click(reader);
    await waitFor(() => expect(modeTrigger).toHaveFocus());
    act(() => {
      selectReader(event);
      selectReader(event);
    });

    expect(window.open).toHaveBeenCalledExactlyOnceWith("/p/reader-current", "_blank", "noopener");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("preserves keyboard selection, Escape and outside close, and trigger focus return", async () => {
    const session = new ModeSession("keyboard-current", "editor", "editing");
    render(
      <>
        <ModeSwitcher session={session.asCollabSession()} />
        <button type="button">Outside control</button>
      </>,
    );
    const modeTrigger = trigger();
    const outside = screen.getByRole("button", { name: "Outside control" });
    modeTrigger.focus();

    fireEvent.keyDown(modeTrigger, { key: "ArrowDown", shiftKey: true });
    await waitFor(() => expect(radio("Editing")).toHaveFocus());
    await userEvent.keyboard("{ArrowDown}");
    expect(radio("Suggesting")).toHaveFocus();
    await userEvent.keyboard("{Enter}");

    expect(session.setMode).toHaveBeenCalledExactlyOnceWith("suggesting");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(modeTrigger).toHaveFocus());

    await userEvent.click(modeTrigger);
    await waitFor(() => expect(menu()).toBeInTheDocument());
    fireEvent.keyDown(radio("Suggesting"), { key: "Escape", shiftKey: true });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(modeTrigger).toHaveFocus());

    await userEvent.click(modeTrigger);
    await waitFor(() => expect(menu()).toBeInTheDocument());
    menu().focus();
    await waitForOutsideListener();
    pointerDown(outside, new PointerEvent("pointerdown", {
      bubbles: true,
      button: 2,
      pointerType: "mouse",
    }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(modeTrigger).not.toHaveFocus();

    await userEvent.click(modeTrigger);
    await waitFor(() => expect(menu()).toBeInTheDocument());
    outside.addEventListener("pointerdown", (event) => event.preventDefault(), { once: true });
    pointerDown(outside);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("keeps one controlled menu when the same current trigger event and callback are replayed", () => {
    const session = new ModeSession("single-disclosure", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    const openEvent = new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });

    act(() => {
      modeTrigger.dispatchEvent(openEvent);
      modeTrigger.dispatchEvent(openEvent);
    });
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    const closeEvent = new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });

    act(() => {
      modeTrigger.dispatchEvent(closeEvent);
      modeTrigger.dispatchEvent(closeEvent);
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
