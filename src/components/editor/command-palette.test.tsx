// @vitest-environment jsdom
import { StrictMode, useCallback, useEffect, useLayoutEffect, useState, type ChangeEventHandler, type KeyboardEventHandler, type MouseEventHandler, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./command-palette";
import type { Command } from "./commands";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function command(id: string, title: string, run: Command["run"] = vi.fn()): Command {
  return { id, title, keywords: [], group: "Test", run };
}

function childCommand(id: string, title: string, children: Command["children"]): Command {
  return { ...command(id, title), children };
}

function commandProvider(...items: Command[]): () => Command[] {
  return () => items;
}

function reactProps<T extends object>(element: Element): T {
  const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactProps$"));
  if (!key) throw new Error("React props were not published on the element");
  return (element as unknown as Record<string, unknown>)[key] as T;
}

function exactEvent<T extends HTMLElement>(currentTarget: T, extra: Record<string, unknown> = {}) {
  const ownerWindow = currentTarget.ownerDocument.defaultView!;
  const target = (extra.target as HTMLElement | undefined) ?? currentTarget;
  const nativeEvent =
    typeof extra.key === "string"
      ? new ownerWindow.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: extra.key,
        })
      : new ownerWindow.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
        });
  Object.defineProperty(nativeEvent, "target", { configurable: true, value: target });
  return {
    type: nativeEvent.type,
    currentTarget,
    target,
    nativeEvent,
    defaultPrevented: false,
    preventDefault: vi.fn(() => nativeEvent.preventDefault()),
    ...extra,
  };
}

function markJsdomEventTrusted(event: Event): void {
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

function exposeJsdomNativeDefaultView(ownerDocument: Document): () => void {
  const implementationSymbol = Object.getOwnPropertySymbols(ownerDocument).find(
    (symbol) => String(symbol) === "Symbol(impl)",
  );
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

function paletteKeyboardEvent(
  input: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
  trusted = true,
): KeyboardEvent {
  const ownerWindow = input.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("Palette input owner window was unavailable");
  if (!(input instanceof ownerWindow.HTMLInputElement)) {
    throw new Error("Palette key target was not an input");
  }
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    code: key,
    view: ownerWindow,
    ...init,
  });
  if (trusted) markJsdomEventTrusted(event);
  return event;
}

function dispatchPaletteKey(
  input: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
  trusted = true,
): KeyboardEvent {
  const event = paletteKeyboardEvent(input, key, init, trusted);
  act(() => input.dispatchEvent(event));
  return event;
}

function commandList(length: number, run: (index: number) => Command["run"] = () => vi.fn()) {
  return Array.from({ length }, (_, index) =>
    command(`item-${index}`, `Item ${index}`, run(index)),
  );
}

function selectedCommand(input: HTMLElement): string | null {
  return input.getAttribute("aria-activedescendant");
}

interface RowHandlerProps {
  onClick: MouseEventHandler<HTMLDivElement>;
  onMouseEnter: MouseEventHandler<HTMLDivElement>;
}

interface ButtonHandlerProps {
  onClick: MouseEventHandler<HTMLButtonElement>;
}

interface InputHandlerProps {
  onChange: ChangeEventHandler<HTMLInputElement>;
  onKeyDown: KeyboardEventHandler<HTMLInputElement>;
}

interface ContentDismissalHandlers {
  onEscapeKeyDown: (event: KeyboardEvent) => void;
  onPointerDownOutside: (event: CustomEvent<{ originalEvent: PointerEvent }>) => void;
  onFocusOutside: (event: CustomEvent<{ originalEvent: FocusEvent }>) => void;
  onDismiss: () => void;
}

function reactAncestorHandler<T extends (...args: never[]) => unknown>(element: Element, name: string): T {
  const key = Object.getOwnPropertyNames(element).find((value) => value.startsWith("__reactFiber$"));
  if (!key) throw new Error("React fiber was not published on the element");
  let fiber = (element as unknown as Record<string, unknown>)[key] as
    | { memoizedProps?: Record<string, unknown>; return?: unknown }
    | null;
  while (fiber) {
    const handler = fiber.memoizedProps?.[name];
    if (typeof handler === "function") return handler as T;
    fiber = fiber.return as typeof fiber;
  }
  throw new Error(`React ancestor handler ${name} was not found`);
}

function contentDismissalHandlers(content: Element): ContentDismissalHandlers {
  return {
    onEscapeKeyDown: reactAncestorHandler(content, "onEscapeKeyDown"),
    onPointerDownOutside: reactAncestorHandler(content, "onPointerDownOutside"),
    onFocusOutside: reactAncestorHandler(content, "onFocusOutside"),
    onDismiss: reactAncestorHandler(content, "onDismiss"),
  };
}

function escapeDismissalEvent(
  content: HTMLElement,
  target: Node = content,
  currentTarget: EventTarget = content.ownerDocument,
) {
  const ownerWindow = content.ownerDocument.defaultView!;
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Escape",
  });
  Object.defineProperties(event, {
    currentTarget: { configurable: true, value: currentTarget },
    target: { configurable: true, value: target },
  });
  return event;
}

function primaryPointerEvent(
  target: HTMLElement,
  type: "pointerdown" | "pointerup" | "pointercancel",
) {
  const ownerWindow = target.ownerDocument.defaultView!;
  const Pointer = ownerWindow.PointerEvent ?? ownerWindow.Event;
  const button = type === "pointercancel" ? -1 : 0;
  const event = new Pointer(type, {
    bubbles: true,
    cancelable: true,
    button,
    pointerId: 1,
    isPrimary: true,
  } as PointerEventInit);
  for (const [name, value] of Object.entries({
    button,
    pointerId: 1,
    isPrimary: true,
  })) {
    if (!(name in event)) {
      Object.defineProperty(event, name, { configurable: true, value });
    }
  }
  return event;
}

function primaryClickEvent(target: HTMLElement) {
  const ownerWindow = target.ownerDocument.defaultView!;
  return new ownerWindow.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
}

function implicitSubmitEvent(form: HTMLFormElement) {
  const ownerWindow = form.ownerDocument.defaultView!;
  return typeof ownerWindow.SubmitEvent === "function"
    ? new ownerWindow.SubmitEvent("submit", {
        bubbles: true,
        cancelable: true,
        submitter: null,
      })
    : new ownerWindow.Event("submit", { bubbles: true, cancelable: true });
}

function pointerOutsideEvent(
  content: HTMLElement,
  target: HTMLElement,
  currentTarget: EventTarget = content,
  dispatch = false,
) {
  const ownerWindow = content.ownerDocument.defaultView!;
  const originalEvent = primaryPointerEvent(target, "pointerdown");
  if (dispatch) {
    target.dispatchEvent(originalEvent);
    target.dispatchEvent(primaryPointerEvent(target, "pointerup"));
    target.dispatchEvent(primaryClickEvent(target));
  }
  else Object.defineProperty(originalEvent, "target", { configurable: true, value: target });
  const event = new ownerWindow.CustomEvent("dismissableLayer.pointerDownOutside", {
    cancelable: true,
    detail: { originalEvent },
  });
  Object.defineProperties(event, {
    currentTarget: { configurable: true, value: currentTarget },
    target: { configurable: true, value: content },
  });
  return event as CustomEvent<{ originalEvent: PointerEvent }>;
}

function focusOutsideEvent(
  content: HTMLElement,
  target: HTMLElement,
  currentTarget: EventTarget = content,
  dispatch = false,
) {
  const ownerWindow = content.ownerDocument.defaultView!;
  const originalEvent = new ownerWindow.FocusEvent("focusin", {
    bubbles: true,
    cancelable: true,
  });
  if (dispatch) target.dispatchEvent(originalEvent);
  else Object.defineProperty(originalEvent, "target", { configurable: true, value: target });
  const event = new ownerWindow.CustomEvent("dismissableLayer.focusOutside", {
    cancelable: true,
    detail: { originalEvent },
  });
  Object.defineProperties(event, {
    currentTarget: { configurable: true, value: currentTarget },
    target: { configurable: true, value: content },
  });
  return event as CustomEvent<{ originalEvent: FocusEvent }>;
}

async function settle<T>(pending: ReturnType<typeof deferred<T>>, kind: "resolve", value: T): Promise<void>;
async function settle<T>(pending: ReturnType<typeof deferred<T>>, kind: "reject", value: unknown): Promise<void>;
async function settle<T>(pending: ReturnType<typeof deferred<T>>, kind: "resolve" | "reject", value: T | unknown) {
  await act(async () => {
    if (kind === "resolve") pending.resolve(value as T);
    else pending.reject(value);
    await pending.promise.catch(() => undefined);
  });
}

async function renderStrictRoot(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const renderNode = async (next: ReactNode) => {
    await act(async () => {
      root.render(<StrictMode>{next}</StrictMode>);
    });
  };
  await renderNode(node);
  return {
    host,
    render: renderNode,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function Harness({ items, initiallyOpen = true }: { items: Command[]; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const commands = useCallback(() => items, [items]);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open palette
      </button>
      <CommandPalette open={open} onOpenChange={setOpen} commands={commands} />
    </>
  );
}

function PassiveCleanupProbe({ onCleanup }: { onCleanup: () => void }) {
  useEffect(() => onCleanup, [onCleanup]);
  return null;
}

function ControlledPaletteMount({
  items,
  onPassiveCleanup,
}: {
  items: Command[];
  onPassiveCleanup: () => void;
}) {
  const commands = useCallback(() => items, [items]);
  return (
    <>
      <CommandPalette open onOpenChange={() => {}} commands={commands} />
      <PassiveCleanupProbe onCleanup={onPassiveCleanup} />
    </>
  );
}

function StatefulPaletteMount({ items, onPassiveCleanup }: { items: Command[]; onPassiveCleanup: () => void }) {
  return (
    <>
      <Harness items={items} initiallyOpen={false} />
      <PassiveCleanupProbe onCleanup={onPassiveCleanup} />
    </>
  );
}

function PaletteBoundary({
  instance,
  items,
  present = true,
  stateful = false,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  instance: string;
  items: Command[];
  present?: boolean;
  stateful?: boolean;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  if (!present) return null;
  return stateful ? (
    <StatefulPaletteMount key={instance} items={items} onPassiveCleanup={onPassiveCleanup} />
  ) : (
    <ControlledPaletteMount key={instance} items={items} onPassiveCleanup={onPassiveCleanup} />
  );
}

function SameMountBoundary({
  items,
  revision,
  onBoundary,
}: {
  items: Command[];
  revision: number;
  onBoundary?: () => void;
}) {
  const commands = useCallback(() => items, [items]);
  useLayoutEffect(() => {
    if (revision > 0) onBoundary?.();
  }, [revision, onBoundary]);
  return <CommandPalette open onOpenChange={() => {}} commands={commands} />;
}

let originalScrollIntoView: typeof Element.prototype.scrollIntoView;
let restoreOwnerWindow: () => void;
const unhandledRejections: unknown[] = [];
const recordUnhandledRejection = (reason: unknown) => {
  unhandledRejections.push(reason);
};

beforeEach(() => {
  localStorage.clear();
  restoreOwnerWindow = exposeJsdomNativeDefaultView(document);
  originalScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
  unhandledRejections.length = 0;
  process.on("unhandledRejection", recordUnhandledRejection);
});

afterEach(async () => {
  cleanup();
  await Promise.resolve();
  process.off("unhandledRejection", recordUnhandledRejection);
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.clearAllTimers();
  vi.useRealTimers();
  restoreOwnerWindow();
  expect(unhandledRejections).toEqual([]);
});

describe("CommandPalette command titles", () => {
  const firstTitle = `Alpha <strong title="literal">command</strong> 'quoted' ${"long document name ".repeat(12)}`;
  const secondTitle = `Beta <img src="literal" alt='quoted'> command ${"another document name ".repeat(12)}`;

  function expectCommandTitle(id: string, title: string) {
    const row = screen.getByTestId(`palette-item-${id}`);
    const span = row.querySelector<HTMLSpanElement>(":scope > span.flex-1");
    if (!span) throw new Error("Command title span was not rendered");
    expect(span.getAttribute("title")).toBe(title);
    expect(span.textContent).toBe(title);
    expect(span.className).toBe("flex-1 truncate");
    expect(span.getAttributeNames().sort()).toEqual(["class", "title"]);
    expect(span.childElementCount).toBe(0);
    expect(span.childNodes).toHaveLength(title ? 1 : 0);
    expect(row).toHaveAttribute("role", "option");
    expect(row).not.toHaveAttribute("tabindex");
    expect(row.querySelector("button, a, input, [tabindex], [role='tooltip']")).toBeNull();
    return { row, span };
  }

  it("preserves raw root titles, row semantics, and highlight-only hover", async () => {
    const run = vi.fn();
    const children = vi.fn(() => []);
    const onOpenChange = vi.fn();
    const ordinary = { ...command("ordinary", firstTitle, run), icon: "FileText", shortcut: "Ctrl-K" };
    const parent = childCommand("parent", secondTitle, children);
    render(
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        commands={commandProvider(ordinary, parent, command("empty", ""), command("whitespace", " \t  "))}
      />,
    );
    const input = await screen.findByTestId("palette-input");
    expect(firstTitle.length).toBeGreaterThanOrEqual(200);
    expect(secondTitle.length).toBeGreaterThanOrEqual(200);
    expect(firstTitle).not.toBe(secondTitle);

    const { row: ordinaryRow } = expectCommandTitle("ordinary", firstTitle);
    expect(ordinaryRow).toHaveAccessibleName(`${firstTitle.trim()}Ctrl-K`);
    expect([...ordinaryRow.children].map((child) => child.tagName.toLowerCase())).toEqual(["svg", "span", "kbd", "svg"]);
    expect(ordinaryRow.children[0]).toHaveClass("lucide-file-text");
    expect(ordinaryRow.children[0]).toHaveAttribute("aria-hidden", "true");
    expect(ordinaryRow.children[2]).toHaveTextContent("Ctrl-K");
    expect(ordinaryRow.children[3]).toHaveClass("lucide-corner-down-left");
    expect(ordinaryRow.children[3]).toHaveAttribute("aria-hidden", "true");
    const { row: parentRow, span: parentSpan } = expectCommandTitle("parent", secondTitle);
    expect(parentRow).toHaveAccessibleName(secondTitle.trim());
    expect([...parentRow.children].map((child) => child.tagName.toLowerCase())).toEqual(["span", "span", "svg"]);
    expect(parentRow.children[0]).toHaveClass("inline-block", "h-4", "w-4");
    expect(parentRow.children[0]).toHaveAttribute("aria-hidden", "true");
    expect(parentRow.children[2]).toHaveClass("lucide-chevron-right");
    expect(parentRow.children[2]).toHaveAttribute("aria-hidden", "true");
    for (const [id, title] of [["empty", ""], ["whitespace", " \t  "]]) {
      const { row } = expectCommandTitle(id, title);
      expect(row).toHaveAccessibleName("");
      expect(row.children).toHaveLength(2);
    }
    expect(screen.getAllByRole("option")).toHaveLength(4);

    fireEvent.mouseEnter(parentSpan);
    await act(async () => {});
    expect(selectedCommand(input)).toBe("palette-item-parent");
    expectCommandTitle("parent", secondTitle);
    expect(ordinaryRow.querySelector(".lucide-corner-down-left")).toBeNull();
    expect(parentRow.querySelector(".lucide-chevron-right")).toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByTestId("command-palette").querySelector("button, a, [tabindex='0']")).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(run).not.toHaveBeenCalled();
    expect(parent.run).not.toHaveBeenCalled();
    expect(children).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    expect(input).toHaveFocus();
  });

  it("refreshes filtered, same-ID, and reopened titles before activating only the current command", async () => {
    const oldRun = vi.fn();
    const navigate = vi.fn();
    const currentRun = vi.fn(() => navigate());
    const oldItems = [command("shared", firstTitle, oldRun), command("other", secondTitle)];
    const currentItems = [command("shared", secondTitle, currentRun)];
    const rendered = render(<Harness items={oldItems} />);
    const input = await screen.findByTestId("palette-input");
    expectCommandTitle("shared", firstTitle);
    expectCommandTitle("other", secondTitle);

    fireEvent.change(input, { target: { value: "Alpha" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expectCommandTitle("shared", firstTitle);
    expect(screen.queryByTitle(secondTitle)).toBeNull();
    fireEvent.change(input, { target: { value: "" } });
    rendered.rerender(<Harness items={currentItems} />);
    expectCommandTitle("shared", secondTitle);
    expect(screen.queryByTitle(firstTitle)).toBeNull();
    expect(screen.queryByTestId("palette-item-other")).toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("command-palette")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open palette" }));
    await screen.findByTestId("palette-input");
    const { span } = expectCommandTitle("shared", secondTitle);
    expect(screen.queryByTitle(firstTitle)).toBeNull();
    fireEvent.mouseEnter(span);
    await act(async () => {});
    expect(screen.getByTestId("command-palette")).toBeInTheDocument();
    expect(oldRun).not.toHaveBeenCalled();
    expect(currentRun).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    fireEvent.click(span);
    await waitFor(() => expect(currentRun).toHaveBeenCalledOnce());
    expect(navigate).toHaveBeenCalledOnce();
    expect(oldRun).not.toHaveBeenCalled();
    expect(screen.queryByTestId("command-palette")).toBeNull();
  });

  it("keeps loaded and nested titles current without loading or running on hover", async () => {
    const pending = deferred<Command[]>();
    const run = vi.fn();
    const nestedChildren = vi.fn(() => pending.promise);
    const nested = childCommand("nested", secondTitle, nestedChildren);
    const sibling = command("sibling", firstTitle);
    const children = vi.fn(() => [nested, sibling]);
    const parent = childCommand("parent", firstTitle, children);
    render(<Harness items={[parent]} />);
    await screen.findByTestId("palette-input");
    fireEvent.click(expectCommandTitle("parent", firstTitle).span);
    await screen.findByTestId("palette-item-nested");
    expect(children).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("palette-item-parent")).toBeNull();
    const input = screen.getByTestId("palette-input");
    fireEvent.mouseEnter(expectCommandTitle("sibling", firstTitle).span);
    fireEvent.mouseEnter(expectCommandTitle("nested", secondTitle).span);
    await act(async () => {});
    expect(selectedCommand(input)).toBe("palette-item-nested");
    expect(children).toHaveBeenCalledOnce();
    expect(nestedChildren).not.toHaveBeenCalled();
    expect(nested.run).not.toHaveBeenCalled();
    expect(parent.run).not.toHaveBeenCalled();
    expect(sibling.run).not.toHaveBeenCalled();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.change(input, { target: { value: "Beta" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByTitle(firstTitle)).toBeNull();
    fireEvent.click(expectCommandTitle("nested", secondTitle).span);
    await waitFor(() => expect(nestedChildren).toHaveBeenCalledOnce());
    await settle(pending, "resolve", [command("leaf", firstTitle, run)]);
    expect(screen.queryByTitle(secondTitle)).toBeNull();
    const { span } = expectCommandTitle("leaf", firstTitle);
    fireEvent.mouseEnter(span);
    await act(async () => {});
    expect(run).not.toHaveBeenCalled();
    expect(children).toHaveBeenCalledOnce();
    expect(nestedChildren).toHaveBeenCalledOnce();
    expect(screen.getByTestId("command-palette")).toBeInTheDocument();
    expect(input).toHaveFocus();
    fireEvent.click(span);
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("command-palette")).toBeNull();
  });

  it.each(["resolve", "reject"] as const)(
    "preserves hover cancellation of a pending child %s without extra command work",
    async (settlement) => {
      const pending = deferred<Command[]>();
      const children = vi.fn(() => pending.promise);
      const run = vi.fn();
      const onOpenChange = vi.fn();
      const parent = childCommand("parent", firstTitle, children);
      render(
        <CommandPalette
          open
          onOpenChange={onOpenChange}
          commands={commandProvider(parent, command("ordinary", secondTitle, run))}
        />,
      );
      const input = await screen.findByTestId("palette-input");
      fireEvent.click(expectCommandTitle("parent", firstTitle).span);
      await waitFor(() => expect(children).toHaveBeenCalledOnce());
      expect(screen.getByRole("status")).toBeInTheDocument();

      fireEvent.mouseEnter(expectCommandTitle("ordinary", secondTitle).span);
      expect(selectedCommand(input)).toBe("palette-item-ordinary");
      expect(screen.queryByRole("status")).toBeNull();
      if (settlement === "resolve") {
        await settle(pending, "resolve", [command("stale", "Stale child title")]);
      } else {
        await settle(pending, "reject", new Error("Stale child failed"));
      }
      expectCommandTitle("parent", firstTitle);
      expectCommandTitle("ordinary", secondTitle);
      expect(screen.queryByTitle("Stale child title")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getAllByRole("option")).toHaveLength(2);
      expect(children).toHaveBeenCalledOnce();
      expect(parent.run).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(input).toHaveFocus();
    },
  );
});

describe("CommandPalette child loading", () => {
  it("announces a failed load and retries once without duplicate click or Enter requests", async () => {
    const first = deferred<Command[]>();
    const retry = deferred<Command[]>();
    const children = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    const recent = childCommand("recent", "Recent documents…", children);
    const unhandled = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    window.addEventListener("unhandledrejection", unhandled);

    try {
      localStorage.setItem("markdoc:paletteRecent", JSON.stringify(["recent"]));
      render(<Harness items={[recent, command("other", "Other command")]} />);
      const input = await screen.findByTestId("palette-input");
      const recentOption = screen.getByTestId("palette-item-recent");

      fireEvent.click(recentOption);
      fireEvent.click(recentOption);
      dispatchPaletteKey(input, "Enter");
      fireEvent.click(screen.getByTestId("palette-item-recent"));
      dispatchPaletteKey(input, "Enter");

      await waitFor(() => expect(children).toHaveBeenCalledOnce());
      expect(screen.getByRole("status")).toHaveTextContent("Loading…");
      expect(recentOption).toHaveAttribute("aria-disabled", "true");

      await settle(first, "reject", new Error("Recent documents are unavailable."));

      const alert = screen.getByRole("alert");
      expect(alert).toHaveAttribute("aria-atomic", "true");
      expect(alert).toHaveTextContent("Recent documents are unavailable.");
      expect(within(alert).getAllByRole("button", { name: "Retry" })).toHaveLength(1);
      expect(screen.getByTestId("palette-item-other")).toBeInTheDocument();
      expect(unhandled).not.toHaveBeenCalled();

      const retryButton = within(alert).getByRole("button", { name: "Retry" });
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);

      await waitFor(() => expect(children).toHaveBeenCalledTimes(2));
      expect(within(alert).getByRole("button", { name: "Retrying…" })).toBeDisabled();

      await settle(retry, "resolve", [command("recent-one", "Recent one")]);

      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByTestId("palette-item-recent-one")).toBeInTheDocument();
      expect(screen.getByText("Recent documents")).toBeInTheDocument();
      expect(input).toHaveFocus();
      expect(children).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });

  it("ignores a child resolution from before the palette was closed and reopened", async () => {
    const stale = deferred<Command[]>();
    const current = deferred<Command[]>();
    const children = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const recent = childCommand("recent", "Recent documents…", children);
    const commands = () => [recent];
    const onOpenChange = vi.fn();
    const rendered = render(<CommandPalette open onOpenChange={onOpenChange} commands={commands} />);

    fireEvent.click(await screen.findByTestId("palette-item-recent"));
    await waitFor(() => expect(children).toHaveBeenCalledOnce());

    rendered.rerender(<CommandPalette open={false} onOpenChange={onOpenChange} commands={commands} />);
    rendered.rerender(<CommandPalette open onOpenChange={onOpenChange} commands={commands} />);

    await settle(stale, "resolve", [command("stale", "Stale result")]);

    expect(screen.queryByTestId("palette-item-stale")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("palette-item-recent")).toBeInTheDocument();

    dispatchPaletteKey(screen.getByTestId("palette-input"), "Enter");
    await waitFor(() => expect(children).toHaveBeenCalledTimes(2));
    await settle(current, "resolve", [command("current", "Current result")]);
    expect(screen.getByTestId("palette-item-current")).toBeInTheDocument();
  });

  it("lets a different child supersede pending work without a stale error or focus change", async () => {
    const stale = deferred<Command[]>();
    const current = deferred<Command[]>();
    const first = childCommand("first", "First child…", vi.fn(() => stale.promise));
    const second = childCommand("second", "Second child…", vi.fn(() => current.promise));
    const parent = childCommand("parent", "Parent…", () => [first, second]);

    render(<Harness items={[parent]} />);
    fireEvent.click(await screen.findByTestId("palette-item-parent"));
    await screen.findByTestId("palette-item-first");

    fireEvent.click(screen.getByTestId("palette-item-first"));
    fireEvent.click(screen.getByTestId("palette-item-second"));
    const back = screen.getByRole("button", { name: "Back" });
    back.focus();

    await settle(stale, "reject", new Error("Stale child failed."));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("palette-item-stale")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(back).toHaveFocus();

    await settle(current, "resolve", [command("second-result", "Second result")]);

    expect(screen.getByTestId("palette-item-second-result")).toBeInTheDocument();
    expect(screen.queryByText("Stale child failed.")).toBeNull();
    expect(screen.getByTestId("palette-input")).toHaveFocus();
  });

  it("invalidates nested work on Back and preserves keyboard execution and focus restoration", async () => {
    const stale = deferred<Command[]>();
    const run = vi.fn();
    const nested = childCommand("nested", "Nested child…", vi.fn(() => stale.promise));
    const parent = childCommand("parent", "Parent…", () => [nested]);

    render(<Harness items={[parent, command("ordinary", "Ordinary command", run)]} initiallyOpen={false} />);
    const opener = screen.getByRole("button", { name: "Open palette" });
    opener.focus();
    fireEvent.click(opener);

    const input = await screen.findByTestId("palette-input");
    dispatchPaletteKey(input, "Enter");
    await screen.findByTestId("palette-item-nested");
    dispatchPaletteKey(input, "Enter");
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("palette-item-parent")).toBeInTheDocument();
    await settle(stale, "resolve", [command("stale", "Stale result")]);
    expect(screen.queryByTestId("palette-item-stale")).toBeNull();

    dispatchPaletteKey(input, "ArrowDown");
    expect(input).toHaveAttribute("aria-activedescendant", "palette-item-ordinary");
    dispatchPaletteKey(input, "Enter");

    await waitFor(() => expect(screen.queryByTestId("command-palette")).toBeNull());
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(opener).toHaveFocus();
  });

  it.each(
    (["replacement", "removal"] as const).flatMap((transition) =>
      (["resolve", "reject"] as const).map((settlement) => ({ transition, settlement })),
    ),
  )(
    "retires an old child $settlement at the parent-layout $transition boundary while the current visit stays usable",
    async ({ transition, settlement }) => {
      vi.useFakeTimers();
      const oldPending = deferred<Command[]>();
      const currentPending = deferred<Command[]>();
      const oldProvider = vi.fn(() => oldPending.promise);
      const currentProvider = vi.fn(() => currentPending.promise);
      const oldItems = [childCommand("old-child", "Old child…", oldProvider)];
      const currentItems = [childCommand("current-child", "Current child…", currentProvider)];
      const host = document.createElement("div");
      const focusOwner = document.createElement("button");
      focusOwner.textContent = "Persistent focus owner";
      document.body.append(focusOwner, host);
      const root = createRoot(host);
      let passiveCleanups = 0;
      let passiveCleanupsAtBoundary = -1;
      const recordPassiveCleanup = () => {
        passiveCleanups++;
      };

      try {
        focusOwner.focus();
        await act(async () => {
          root.render(
            <PaletteBoundary instance="old" items={oldItems} onPassiveCleanup={recordPassiveCleanup} />,
          );
        });
        const oldInput = screen.getByTestId("palette-input");
        expect(oldInput).toHaveFocus();
        fireEvent.click(screen.getByTestId("palette-item-old-child"));
        await act(async () => {});
        expect(oldProvider).toHaveBeenCalledOnce();
        expect(screen.getByRole("status")).toHaveTextContent("Loading…");

        let boundaryReached!: () => void;
        const atBoundary = new Promise<void>((resolve) => {
          boundaryReached = resolve;
        });
        root.render(
          <PaletteBoundary
            instance={transition === "replacement" ? "current" : "old"}
            items={transition === "replacement" ? currentItems : oldItems}
            present={transition === "replacement"}
            boundary={1}
            onBoundary={() => {
              passiveCleanupsAtBoundary = passiveCleanups;
              if (transition === "removal") focusOwner.focus();
              if (settlement === "resolve") oldPending.resolve([command("stale-child", "Stale child")]);
              else oldPending.reject(new Error("Retired child failed"));
              boundaryReached();
            }}
            onPassiveCleanup={recordPassiveCleanup}
          />,
        );
        await atBoundary;
        await act(async () => {
          await Promise.allSettled([oldPending.promise]);
          await Promise.resolve();
        });

        expect(passiveCleanupsAtBoundary).toBe(0);
        expect(oldProvider).toHaveBeenCalledOnce();
        expect(screen.queryByTestId("palette-item-stale-child")).toBeNull();
        expect(screen.queryByText("Retired child failed")).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();

        if (transition === "replacement") {
          expect(screen.getByTestId("palette-item-current-child")).toBeInTheDocument();
          expect(screen.getByTestId("palette-input")).toHaveFocus();
        } else {
          expect(screen.queryByTestId("command-palette")).toBeNull();
          expect(focusOwner).toHaveFocus();
          await act(async () => {
            root.render(
              <PaletteBoundary
                instance="current"
                items={currentItems}
                boundary={2}
                onPassiveCleanup={recordPassiveCleanup}
              />,
            );
          });
        }

        const currentInput = screen.getByTestId("palette-input");
        expect(currentInput).toHaveFocus();
        fireEvent.click(screen.getByTestId("palette-item-current-child"));
        await act(async () => {});
        expect(oldProvider).toHaveBeenCalledOnce();
        expect(currentProvider).toHaveBeenCalledOnce();
        expect(screen.getByRole("status")).toHaveTextContent("Loading…");
        expect(screen.getByTestId("palette-item-current-child")).toHaveAttribute("aria-disabled", "true");
        expect(screen.queryByRole("alert")).toBeNull();

        await act(async () => {
          currentPending.resolve([command("current-result", "Current result")]);
          await currentPending.promise;
        });
        expect(screen.queryByRole("status")).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByTestId("palette-item-current-result")).toBeInTheDocument();
        expect(screen.queryByTestId("palette-item-stale-child")).toBeNull();
        expect(currentInput).toHaveFocus();
        expect(oldProvider).toHaveBeenCalledOnce();
        expect(currentProvider).toHaveBeenCalledOnce();
        expect(unhandledRejections).toEqual([]);
      } finally {
        await act(async () => root.unmount());
        host.remove();
        focusOwner.remove();
      }
    },
  );

  it("retires a pending Retry at replacement without publishing its result into the current visit", async () => {
    vi.useFakeTimers();
    const oldRetry = deferred<Command[]>();
    const currentPending = deferred<Command[]>();
    const oldProvider = vi.fn().mockRejectedValueOnce(new Error("Old child failed")).mockReturnValueOnce(oldRetry.promise);
    const currentProvider = vi.fn(() => currentPending.promise);
    const oldItems = [childCommand("old-child", "Old child…", oldProvider)];
    const currentItems = [childCommand("current-child", "Current child…", currentProvider)];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let passiveCleanups = 0;
    let passiveCleanupsAtBoundary = -1;
    const recordPassiveCleanup = () => {
      passiveCleanups++;
    };

    try {
      await act(async () => {
        root.render(<PaletteBoundary instance="old" items={oldItems} onPassiveCleanup={recordPassiveCleanup} />);
      });
      fireEvent.click(screen.getByTestId("palette-item-old-child"));
      await act(async () => {});
      expect(screen.getByRole("alert")).toHaveTextContent("Old child failed");
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await act(async () => {});
      expect(oldProvider).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();

      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });
      root.render(
        <PaletteBoundary
          instance="current"
          items={currentItems}
          boundary={1}
          onBoundary={() => {
            passiveCleanupsAtBoundary = passiveCleanups;
            oldRetry.resolve([command("stale-retry", "Stale Retry result")]);
            boundaryReached();
          }}
          onPassiveCleanup={recordPassiveCleanup}
        />,
      );
      await atBoundary;
      await act(async () => {
        await oldRetry.promise;
      });

      expect(passiveCleanupsAtBoundary).toBe(0);
      expect(oldProvider).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId("palette-item-stale-retry")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByTestId("palette-item-current-child")).toBeInTheDocument();
      expect(screen.getByTestId("palette-input")).toHaveFocus();

      fireEvent.click(screen.getByTestId("palette-item-current-child"));
      await act(async () => {});
      expect(currentProvider).toHaveBeenCalledOnce();
      expect(screen.getByRole("status")).toHaveTextContent("Loading…");
      await act(async () => {
        currentPending.resolve([command("current-retry-result", "Current Retry result")]);
        await currentPending.promise;
      });
      expect(screen.getByTestId("palette-item-current-retry-result")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByTestId("palette-input")).toHaveFocus();
      expect(oldProvider).toHaveBeenCalledTimes(2);
      expect(currentProvider).toHaveBeenCalledOnce();
      expect(unhandledRejections).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("CommandPalette command ownership", () => {
  it.each(["replacement", "removal"] as const)(
    "cancels a retired command timer on $transition and runs only the current palette command after focus restoration",
    async (transition) => {
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      const oldRun = vi.fn();
      let focusAtCurrentRun: Element | null = null;
      const currentRun = vi.fn(() => {
        focusAtCurrentRun = document.activeElement;
      });
      const oldItems = [command("old-command", "Old command", oldRun)];
      const currentItems = [command("current-command", "Current command", currentRun)];
      const host = document.createElement("div");
      const focusOwner = document.createElement("button");
      focusOwner.textContent = "Persistent focus owner";
      document.body.append(focusOwner, host);
      const root = createRoot(host);
      let passiveCleanups = 0;
      let passiveCleanupsAtBoundary = -1;
      let timersAtBoundary = -1;
      let oldTimerClearedAtBoundary = false;
      const recordPassiveCleanup = () => {
        passiveCleanups++;
      };

      try {
        await act(async () => {
          root.render(
            <PaletteBoundary
              instance="old"
              items={oldItems}
              stateful
              onPassiveCleanup={recordPassiveCleanup}
            />,
          );
        });
        const oldOpener = screen.getByRole("button", { name: "Open palette" });
        oldOpener.focus();
        fireEvent.click(oldOpener);
        await act(async () => {});
        expect(screen.getByTestId("palette-input")).toHaveFocus();
        fireEvent.click(screen.getByTestId("palette-item-old-command"));
        await act(async () => {});
        expect(screen.queryByTestId("command-palette")).toBeNull();
        await act(async () => {
          await vi.advanceTimersToNextTimerAsync();
        });
        expect(oldOpener).toHaveFocus();
        const oldCommandTimer = setTimeoutSpy.mock.results.at(-1)?.value;
        const timersBeforeRetirement = vi.getTimerCount();
        expect(oldCommandTimer).toBeDefined();
        expect(timersBeforeRetirement).toBeGreaterThanOrEqual(1);
        expect(oldRun).not.toHaveBeenCalled();

        let boundaryReached!: () => void;
        const atBoundary = new Promise<void>((resolve) => {
          boundaryReached = resolve;
        });
        root.render(
          <PaletteBoundary
            instance={transition === "replacement" ? "current" : "old"}
            items={transition === "replacement" ? currentItems : oldItems}
            present={transition === "replacement"}
            stateful
            boundary={1}
            onBoundary={() => {
              passiveCleanupsAtBoundary = passiveCleanups;
              timersAtBoundary = vi.getTimerCount();
              oldTimerClearedAtBoundary = clearTimeoutSpy.mock.calls.some(([timer]) => timer === oldCommandTimer);
              focusOwner.focus();
              boundaryReached();
            }}
            onPassiveCleanup={recordPassiveCleanup}
          />,
        );
        await atBoundary;
        await act(async () => {});

        expect(passiveCleanupsAtBoundary).toBe(0);
        expect(oldTimerClearedAtBoundary).toBe(true);
        expect(timersAtBoundary).toBeLessThan(timersBeforeRetirement);
        expect(focusOwner).toHaveFocus();
        await act(async () => {
          await vi.runAllTimersAsync();
        });
        expect(vi.getTimerCount()).toBe(0);
        expect(oldRun).not.toHaveBeenCalled();
        expect(currentRun).not.toHaveBeenCalled();

        if (transition === "removal") {
          await act(async () => {
            root.render(
              <PaletteBoundary
                instance="current"
                items={currentItems}
                stateful
                boundary={2}
                onPassiveCleanup={recordPassiveCleanup}
              />,
            );
          });
        }

        const currentOpener = screen.getByRole("button", { name: "Open palette" });
        currentOpener.focus();
        fireEvent.click(currentOpener);
        await act(async () => {});
        expect(screen.getByTestId("palette-input")).toHaveFocus();
        fireEvent.click(screen.getByTestId("palette-item-current-command"));
        await act(async () => {});
        expect(screen.queryByTestId("command-palette")).toBeNull();
        await act(async () => {
          await vi.advanceTimersToNextTimerAsync();
        });
        expect(currentOpener).toHaveFocus();
        expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
        expect(oldRun).not.toHaveBeenCalled();
        expect(currentRun).not.toHaveBeenCalled();

        await act(async () => {
          await vi.runAllTimersAsync();
        });
        expect(oldRun).not.toHaveBeenCalled();
        expect(currentRun).toHaveBeenCalledOnce();
        expect(focusAtCurrentRun).toBe(currentOpener);
        expect(vi.getTimerCount()).toBe(0);
        expect(unhandledRejections).toEqual([]);
      } finally {
        await act(async () => root.unmount());
        host.remove();
        focusOwner.remove();
      }
    },
  );

  it.each(["stale-first", "current-first"] as const)(
    "binds an equal-looking same-open command/provider/prop replacement in $order order",
    async (order) => {
      const pending = deferred<Command[]>();
      const oldProvider = vi.fn(() => [command("old-result", "Old result")]);
      const currentProvider = vi.fn(() => pending.promise);
      const oldOpenChange = vi.fn();
      const currentOpenChange = vi.fn();
      const oldCommands = () => [childCommand("shared", "Shared child…", oldProvider)];
      const currentCommands = () => [childCommand("shared", "Shared child…", currentProvider)];
      const rendered = render(
        <CommandPalette open onOpenChange={oldOpenChange} commands={oldCommands} groupOrder={["Old"]} placeholder="Old placeholder" />,
      );
      const staleClick = reactProps<RowHandlerProps>(await screen.findByTestId("palette-item-shared")).onClick;

      rendered.rerender(
        <CommandPalette
          open
          onOpenChange={currentOpenChange}
          commands={currentCommands}
          groupOrder={["Current"]}
          placeholder="Current placeholder"
        />,
      );
      const input = screen.getByTestId("palette-input");
      const currentRow = await screen.findByTestId("palette-item-shared");
      const currentClick = reactProps<RowHandlerProps>(currentRow).onClick;
      const staleEvent = exactEvent(currentRow);
      const currentEvent = exactEvent(currentRow);

      await act(async () => {
        const stale = () => staleClick(staleEvent as unknown as React.MouseEvent<HTMLDivElement>);
        const current = () => currentClick(currentEvent as unknown as React.MouseEvent<HTMLDivElement>);
        if (order === "stale-first") {
          stale();
          current();
        } else {
          current();
          stale();
        }
        await Promise.resolve();
      });

      expect(input).toHaveAttribute("placeholder", "Current placeholder");
      expect(staleEvent.preventDefault).not.toHaveBeenCalled();
      expect(oldProvider).not.toHaveBeenCalled();
      expect(currentProvider).toHaveBeenCalledOnce();
      expect(oldOpenChange).not.toHaveBeenCalled();
      expect(currentOpenChange).not.toHaveBeenCalled();

      await settle(pending, "resolve", [command("current-result", "Current result")]);
      expect(screen.getByTestId("palette-item-current-result")).toBeInTheDocument();
      expect(input).toHaveFocus();
    },
  );

  it("withholds a same-mount command replacement until its exact state commits past the parent layout boundary", async () => {
    const pending = deferred<Command[]>();
    const oldProvider = vi.fn(() => [command("old-result", "Old result")]);
    const currentProvider = vi.fn(() => pending.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let boundaryAttempts = 0;

    try {
      await act(async () => {
        root.render(<SameMountBoundary items={[childCommand("shared", "Shared…", oldProvider)]} revision={0} />);
      });
      expect(screen.getByTestId("palette-item-shared")).toBeInTheDocument();

      await act(async () => {
        root.render(
          <SameMountBoundary
            items={[childCommand("shared", "Shared…", currentProvider)]}
            revision={1}
            onBoundary={() => {
              const row = screen.getByTestId("palette-item-shared");
              const click = reactProps<RowHandlerProps>(row).onClick;
              click(exactEvent(row) as unknown as React.MouseEvent<HTMLDivElement>);
              boundaryAttempts++;
            }}
          />,
        );
      });
      expect(boundaryAttempts).toBe(1);
      expect(oldProvider).not.toHaveBeenCalled();
      expect(currentProvider).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId("palette-item-shared"));
      await act(async () => {});
      expect(currentProvider).toHaveBeenCalledOnce();
      await settle(pending, "resolve", [command("current-result", "Current result")]);
      expect(screen.getByTestId("palette-item-current-result")).toBeInTheDocument();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("binds Escape and outside dismissal to each exact visit and restores its opener", async () => {
    render(<Harness items={[command("leaf", "Leaf")]} initiallyOpen={false} />);
    const opener = screen.getByRole("button", { name: "Open palette" });
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(outside);

    try {
      opener.focus();
      fireEvent.click(opener);
      await screen.findByTestId("palette-input");
      fireEvent.keyDown(screen.getByTestId("palette-input"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("command-palette")).toBeNull());
      await waitFor(() => expect(opener).toHaveFocus());

      fireEvent.click(opener);
      await screen.findByTestId("palette-input");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      act(() => {
        outside.dispatchEvent(primaryPointerEvent(outside, "pointerdown"));
        outside.dispatchEvent(primaryPointerEvent(outside, "pointerup"));
        outside.dispatchEvent(primaryClickEvent(outside));
      });
      await waitFor(() => expect(screen.queryByTestId("command-palette")).toBeNull());
      await waitFor(() => expect(opener).toHaveFocus());
    } finally {
      outside.remove();
    }
  });

  it("requires exact one-use dismissal provenance before accepting Radix dismissal", async () => {
    const onOpenChange = vi.fn();
    const connectedForeign = document.createElement("div");
    const detachedForeign = document.createElement("div");
    document.body.append(connectedForeign);
    render(
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        commands={commandProvider(command("alpha", "Alpha"))}
      />,
    );

    const content = screen.getByRole("dialog");
    const handlers = contentDismissalHandlers(content);

    try {
      handlers.onDismiss();
      handlers.onDismiss();
      handlers.onEscapeKeyDown(escapeDismissalEvent(content, content, connectedForeign));
      handlers.onDismiss();
      handlers.onEscapeKeyDown(escapeDismissalEvent(content, detachedForeign));
      handlers.onDismiss();
      handlers.onPointerDownOutside(pointerOutsideEvent(content, connectedForeign, content));
      handlers.onDismiss();
      handlers.onPointerDownOutside(pointerOutsideEvent(content, content));
      handlers.onDismiss();
      handlers.onPointerDownOutside(pointerOutsideEvent(content, detachedForeign));
      handlers.onDismiss();

      expect(onOpenChange).not.toHaveBeenCalled();

      fireEvent.keyDown(content, { key: "Escape" });
      handlers.onDismiss();
      handlers.onDismiss();

      expect(onOpenChange).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      connectedForeign.remove();
    }
  });

  it.each(["escape", "pointer"] as const)(
    "closes once and restores focus for an exact current %s dismissal",
    async (source) => {
      vi.useFakeTimers();
      const opener = document.createElement("button");
      const outside = document.createElement("div");
      document.body.append(opener, outside);
      opener.focus();
      const onOpenChange = vi.fn();
      const commands = commandProvider(command("alpha", "Alpha"));
      const rendered = render(
        <CommandPalette
          open
          onOpenChange={onOpenChange}
          commands={commands}
        />,
      );

      try {
        await act(async () => vi.runAllTimersAsync());
        const content = screen.getByRole("dialog");
        const handlers = contentDismissalHandlers(content);

        try {
          if (source === "escape") {
            fireEvent.keyDown(content, { key: "Escape" });
          } else {
            handlers.onPointerDownOutside(pointerOutsideEvent(content, outside, content, true));
            handlers.onDismiss();
          }

          expect(onOpenChange).toHaveBeenCalledTimes(1);
          rendered.rerender(
            <CommandPalette
              open={false}
              onOpenChange={onOpenChange}
              commands={commands}
            />,
          );
          await act(async () => vi.runAllTimersAsync());

          expect(document.activeElement).toBe(opener);
        } finally {
          outside.remove();
        }
      } finally {
        outside.remove();
        opener.remove();
      }
    },
  );

  it.each([
    { order: "stale-first", source: "escape" },
    { order: "current-first", source: "escape" },
    { order: "stale-first", source: "pointer" },
    { order: "current-first", source: "pointer" },
  ] as const)(
    "keeps replacement $source dismissal authority exact when $order handlers run first",
    async ({ order, source }) => {
      const onOpenChangeA = vi.fn();
      const onOpenChangeB = vi.fn();
      const outside = document.createElement("div");
      document.body.append(outside);
      const rendered = render(
        <CommandPalette
          open
          onOpenChange={onOpenChangeA}
          commands={commandProvider(command("alpha", "Alpha"))}
        />,
      );
      const content = await screen.findByRole("dialog");
      const stale = contentDismissalHandlers(content);

      rendered.rerender(
        <CommandPalette
          open
          onOpenChange={onOpenChangeB}
          commands={commandProvider(command("beta", "Beta"))}
        />,
      );
      await screen.findByText("Beta");
      const currentContent = screen.getByRole("dialog");
      const current = contentDismissalHandlers(currentContent);
      const invokeSource = (handlers: ContentDismissalHandlers, handlerContent: HTMLElement) => {
        if (source === "escape") {
          handlers.onEscapeKeyDown(escapeDismissalEvent(handlerContent));
        } else {
          handlers.onPointerDownOutside(pointerOutsideEvent(handlerContent, outside));
        }
      };
      const runStale = () => {
        invokeSource(stale, content);
        stale.onDismiss();
      };
      const runCurrent = () => {
        if (source === "escape") {
          fireEvent.keyDown(currentContent, { key: "Escape" });
        } else {
          current.onPointerDownOutside(
            pointerOutsideEvent(currentContent, outside, currentContent, true),
          );
          current.onDismiss();
        }
      };

      try {
        if (order === "stale-first") {
          runStale();
          expect(onOpenChangeA).not.toHaveBeenCalled();
          expect(onOpenChangeB).not.toHaveBeenCalled();
          runCurrent();
        } else {
          runCurrent();
          runStale();
        }

        expect(onOpenChangeA).not.toHaveBeenCalled();
        expect(onOpenChangeB).toHaveBeenCalledTimes(1);
        expect(screen.getByText("Beta")).toBeInTheDocument();
      } finally {
        outside.remove();
      }
    },
  );

  it("rejects an equal-looking remount's dismissal handlers while the replacement remains usable", async () => {
    const onOpenChangeA = vi.fn();
    const onOpenChangeB = vi.fn();
    const commands = commandProvider(command("alpha", "Alpha"));
    const rendered = render(
      <CommandPalette key="a" open onOpenChange={onOpenChangeA} commands={commands} />,
    );
    const staleContent = await screen.findByRole("dialog");
    const stale = contentDismissalHandlers(staleContent);

    rendered.rerender(
      <CommandPalette key="b" open onOpenChange={onOpenChangeB} commands={commands} />,
    );
    const currentContent = await screen.findByRole("dialog");

    stale.onEscapeKeyDown(escapeDismissalEvent(staleContent));
    stale.onDismiss();
    expect(onOpenChangeA).not.toHaveBeenCalled();
    expect(onOpenChangeB).not.toHaveBeenCalled();

    fireEvent.keyDown(currentContent, { key: "Escape" });
    expect(onOpenChangeA).not.toHaveBeenCalled();
    expect(onOpenChangeB).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong, foreign, and detached row currentTargets without claiming the current row", async () => {
    const pending = deferred<Command[]>();
    const children = vi.fn(() => pending.promise);
    const foreign = document.createElement("div");
    const detached = document.createElement("div");
    document.body.append(foreign);

    try {
      render(<Harness items={[childCommand("first", "First…", children), command("second", "Second")]} />);
      const first = await screen.findByTestId("palette-item-first");
      const second = screen.getByTestId("palette-item-second");
      const clickFirst = reactProps<RowHandlerProps>(first).onClick;
      await act(async () => {
        clickFirst(exactEvent(second) as unknown as React.MouseEvent<HTMLDivElement>);
        clickFirst(exactEvent(foreign) as unknown as React.MouseEvent<HTMLDivElement>);
        clickFirst(exactEvent(detached) as unknown as React.MouseEvent<HTMLDivElement>);
        await Promise.resolve();
      });
      expect(children).not.toHaveBeenCalled();
      expect(screen.queryByRole("status")).toBeNull();

      await act(async () => {
        clickFirst(exactEvent(first) as unknown as React.MouseEvent<HTMLDivElement>);
        await Promise.resolve();
      });
      expect(children).toHaveBeenCalledOnce();
      expect(screen.getByRole("status")).toHaveTextContent("Loading…");
      await settle(pending, "resolve", [command("result", "Result")]);
      expect(screen.getByTestId("palette-item-result")).toBeInTheDocument();
    } finally {
      foreign.remove();
    }
  });

  it("keeps Back and row publications disjoint and leaves the current Back usable", async () => {
    const run = vi.fn();
    render(<Harness items={[childCommand("parent", "Parent…", () => [command("leaf", "Leaf", run)])]} />);
    fireEvent.click(await screen.findByTestId("palette-item-parent"));
    const leaf = await screen.findByTestId("palette-item-leaf");
    const back = screen.getByRole("button", { name: "Back" });
    const leafClick = reactProps<RowHandlerProps>(leaf).onClick;
    const backClick = reactProps<ButtonHandlerProps>(back).onClick;

    act(() => {
      leafClick(exactEvent(back) as unknown as React.MouseEvent<HTMLDivElement>);
      backClick(exactEvent(leaf) as unknown as React.MouseEvent<HTMLButtonElement>);
    });
    expect(screen.getByTestId("palette-item-leaf")).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();

    act(() => backClick(exactEvent(back) as unknown as React.MouseEvent<HTMLButtonElement>));
    expect(screen.getByTestId("palette-item-parent")).toBeInTheDocument();
    act(() => backClick(exactEvent(back) as unknown as React.MouseEvent<HTMLButtonElement>));
    expect(screen.getByTestId("palette-item-parent")).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps Retry and row publications disjoint and leaves the current Retry usable once", async () => {
    const retry = deferred<Command[]>();
    const children = vi.fn().mockRejectedValueOnce(new Error("Try again")).mockReturnValueOnce(retry.promise);
    render(<Harness items={[childCommand("parent", "Parent…", children), command("other", "Other")]} />);
    fireEvent.click(await screen.findByTestId("palette-item-parent"));
    const alert = await screen.findByRole("alert");
    const retryButton = within(alert).getByRole("button", { name: "Retry" });
    const other = screen.getByTestId("palette-item-other");
    const retryClick = reactProps<ButtonHandlerProps>(retryButton).onClick;
    const otherClick = reactProps<RowHandlerProps>(other).onClick;

    act(() => {
      retryClick(exactEvent(other) as unknown as React.MouseEvent<HTMLButtonElement>);
      otherClick(exactEvent(retryButton) as unknown as React.MouseEvent<HTMLDivElement>);
    });
    expect(children).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent("Try again");

    await act(async () => {
      const retryEvent = exactEvent(retryButton);
      retryClick(retryEvent as unknown as React.MouseEvent<HTMLButtonElement>);
      retryClick(retryEvent as unknown as React.MouseEvent<HTMLButtonElement>);
      await Promise.resolve();
    });
    expect(children).toHaveBeenCalledTimes(2);
    await settle(retry, "resolve", [command("result", "Result")]);
    expect(screen.getByTestId("palette-item-result")).toBeInTheDocument();
  });

  it("retires query/input/row DOM publications and accepts only their replacements", async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      render(<Harness items={[command("leaf", "Leaf", run)]} />);
      await act(async () => {});
      const input = screen.getByTestId("palette-input");
      const oldRow = screen.getByTestId("palette-item-leaf");
      const oldRowClick = reactProps<RowHandlerProps>(oldRow).onClick;
      const oldInputChange = reactProps<InputHandlerProps>(input).onChange;

      fireEvent.change(input, { target: { value: "missing" } });
      expect(screen.getByTestId("palette-empty")).toBeInTheDocument();
      act(() => oldInputChange(exactEvent(input) as unknown as React.ChangeEvent<HTMLInputElement>));
      expect(screen.getByTestId("palette-empty")).toBeInTheDocument();

      fireEvent.change(input, { target: { value: "" } });
      const replacement = screen.getByTestId("palette-item-leaf");
      act(() => {
        oldRowClick(exactEvent(oldRow) as unknown as React.MouseEvent<HTMLDivElement>);
        oldRowClick(exactEvent(replacement) as unknown as React.MouseEvent<HTMLDivElement>);
      });
      expect(run).not.toHaveBeenCalled();
      expect(setItem).not.toHaveBeenCalled();

      fireEvent.click(replacement);
      await act(async () => vi.runAllTimersAsync());
      expect(setItem).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledOnce();
    } finally {
      setItem.mockRestore();
    }
  });

  it("consumes each exact keyboard event once and freezes every navigation destination", async () => {
    vi.useFakeTimers();
    const firstRun = vi.fn();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      render(
        <Harness
          initiallyOpen={false}
          items={[command("first", "First", firstRun), command("second", "Second"), command("third", "Third")]}
        />,
      );
      const opener = screen.getByRole("button", { name: "Open palette" });
      opener.focus();
      fireEvent.click(opener);
      await act(async () => {});
      const input = screen.getByTestId("palette-input");
      const endEvent = paletteKeyboardEvent(input, "End");
      const preventEnd = vi.spyOn(endEvent, "preventDefault");

      act(() => {
        input.dispatchEvent(endEvent);
        input.dispatchEvent(endEvent);
      });
      expect(preventEnd).toHaveBeenCalledOnce();
      expect(input).toHaveAttribute("aria-activedescendant", "palette-item-third");
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

      dispatchPaletteKey(input, "Home");
      expect(input).toHaveAttribute("aria-activedescendant", "palette-item-first");
      dispatchPaletteKey(input, "ArrowUp");
      expect(input).toHaveAttribute("aria-activedescendant", "palette-item-third");
      dispatchPaletteKey(input, "ArrowDown");
      expect(input).toHaveAttribute("aria-activedescendant", "palette-item-first");

      const enterEvent = paletteKeyboardEvent(input, "Enter");
      const preventEnter = vi.spyOn(enterEvent, "preventDefault");
      act(() => {
        input.dispatchEvent(enterEvent);
        input.dispatchEvent(enterEvent);
      });
      await act(async () => vi.runAllTimersAsync());
      expect(preventEnter).toHaveBeenCalledOnce();
      expect(setItem).toHaveBeenCalledOnce();
      expect(firstRun).toHaveBeenCalledOnce();
      expect(opener).toHaveFocus();
    } finally {
      setItem.mockRestore();
    }
  });
});

describe("CommandPalette direct-root Strict Mode replay", () => {
  it("moves PageDown and PageUp through long and short flat result orders by ten with boundary clamping", async () => {
    const mounted = await renderStrictRoot(<Harness items={commandList(20)} />);

    try {
      let input = await screen.findByTestId("palette-input");
      expect(input).toHaveFocus();

      expect(dispatchPaletteKey(input, "PageDown").defaultPrevented).toBe(true);
      expect(selectedCommand(input)).toBe("palette-item-item-10");

      fireEvent.mouseEnter(screen.getByTestId("palette-item-item-5"));
      expect(selectedCommand(input)).toBe("palette-item-item-5");
      dispatchPaletteKey(input, "PageDown");
      expect(selectedCommand(input)).toBe("palette-item-item-15");

      fireEvent.mouseEnter(screen.getByTestId("palette-item-item-19"));
      dispatchPaletteKey(input, "PageUp");
      expect(selectedCommand(input)).toBe("palette-item-item-9");

      fireEvent.mouseEnter(screen.getByTestId("palette-item-item-14"));
      dispatchPaletteKey(input, "PageUp");
      expect(selectedCommand(input)).toBe("palette-item-item-4");

      fireEvent.mouseEnter(screen.getByTestId("palette-item-item-18"));
      dispatchPaletteKey(input, "PageDown");
      expect(selectedCommand(input)).toBe("palette-item-item-19");
      dispatchPaletteKey(input, "PageDown");
      expect(selectedCommand(input)).toBe("palette-item-item-19");

      fireEvent.mouseEnter(screen.getByTestId("palette-item-item-3"));
      dispatchPaletteKey(input, "PageUp");
      expect(selectedCommand(input)).toBe("palette-item-item-0");
      dispatchPaletteKey(input, "PageUp");
      expect(selectedCommand(input)).toBe("palette-item-item-0");

      await mounted.render(<Harness items={commandList(6)} />);
      input = await screen.findByTestId("palette-input");
      expect(selectedCommand(input)).toBe("palette-item-item-0");
      dispatchPaletteKey(input, "PageDown");
      expect(selectedCommand(input)).toBe("palette-item-item-5");
      dispatchPaletteKey(input, "PageUp");
      expect(selectedCommand(input)).toBe("palette-item-item-0");
      expect(input).toHaveFocus();
    } finally {
      await mounted.unmount();
    }
  });

  it("claims one PageDown before one highlight transition without command or page work", async () => {
    const runs = Array.from({ length: 15 }, () => vi.fn());
    const children = vi.fn(() => [command("child", "Child")]);
    const items = commandList(15, (index) => runs[index]!);
    items[12] = childCommand("item-12", "Item 12", children);
    const commands = vi.fn(() => items);
    const onOpenChange = vi.fn();
    const scroll = vi.fn();
    window.addEventListener("scroll", scroll);
    const mounted = await renderStrictRoot(
      <CommandPalette open onOpenChange={onOpenChange} commands={commands} />,
    );

    try {
      const input = await screen.findByTestId("palette-input");
      const query = (input as HTMLInputElement).value;
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      const transitions: MutationRecord[] = [];
      const observer = new MutationObserver((records) => transitions.push(...records));
      observer.observe(input, {
        attributeFilter: ["aria-activedescendant"],
        attributeOldValue: true,
        attributes: true,
      });
      vi.mocked(Element.prototype.scrollIntoView).mockClear();
      commands.mockClear();
      const event = paletteKeyboardEvent(input, "PageDown");
      const highlightedAtPrevention: Array<string | null> = [];
      const preventDefault = vi
        .spyOn(event, "preventDefault")
        .mockImplementation(() => {
          highlightedAtPrevention.push(selectedCommand(input));
          Event.prototype.preventDefault.call(event);
        });

      act(() => input.dispatchEvent(event));
      await act(async () => Promise.resolve());
      transitions.push(...observer.takeRecords());
      observer.disconnect();

      expect(preventDefault).toHaveBeenCalledOnce();
      expect(highlightedAtPrevention).toEqual(["palette-item-item-0"]);
      expect(selectedCommand(input)).toBe("palette-item-item-10");
      expect(
        screen
          .getAllByRole("option")
          .filter((row) => row.getAttribute("aria-selected") === "true"),
      ).toHaveLength(1);
      expect(transitions).toHaveLength(1);
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledOnce();
      expect(input).toHaveFocus();
      expect(input).toHaveValue(query);
      expect(screen.getByTestId("command-palette")).toBeInTheDocument();
      expect(commands).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(children).not.toHaveBeenCalled();
      expect(runs.every((run) => run.mock.calls.length === 0)).toBe(true);
      expect(scroll).not.toHaveBeenCalled();
      expect(window.scrollX).toBe(scrollX);
      expect(window.scrollY).toBe(scrollY);
    } finally {
      window.removeEventListener("scroll", scroll);
      await mounted.unmount();
    }
  });

  it("leaves Page keys inert without results and rejects non-exact input events", async () => {
    const run = vi.fn();
    const childProvider = vi.fn(() => [command("child", "Child")]);
    const items = commandList(15, () => run);
    items[12] = childCommand("item-12", "Item 12", childProvider);
    const onOpenChange = vi.fn();
    const mounted = await renderStrictRoot(
      <CommandPalette open onOpenChange={onOpenChange} commands={commandProvider()} />,
    );
    const foreignFrame = document.createElement("iframe");
    const focusOwner = document.createElement("button");
    document.body.append(foreignFrame, focusOwner);

    try {
      let input = await screen.findByTestId("palette-input");
      vi.mocked(Element.prototype.scrollIntoView).mockClear();
      const emptyDown = dispatchPaletteKey(input, "PageDown");
      const emptyUp = dispatchPaletteKey(input, "PageUp");
      expect(emptyDown.defaultPrevented).toBe(false);
      expect(emptyUp.defaultPrevented).toBe(false);
      expect(selectedCommand(input)).toBeNull();
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

      await mounted.render(
        <CommandPalette open onOpenChange={onOpenChange} commands={commandProvider(...items)} />,
      );
      input = await screen.findByTestId("palette-input");
      const handler = reactProps<InputHandlerProps>(input).onKeyDown;
      vi.mocked(Element.prototype.scrollIntoView).mockClear();

      for (const init of [
        { altKey: true },
        { ctrlKey: true },
        { metaKey: true },
        { shiftKey: true },
        { repeat: true },
        { isComposing: true },
      ]) {
        expect(dispatchPaletteKey(input, "PageDown", init).defaultPrevented).toBe(false);
      }

      expect(dispatchPaletteKey(input, "PageDown", {}, false).defaultPrevented).toBe(false);

      const canceled = paletteKeyboardEvent(input, "PageDown");
      canceled.preventDefault();
      act(() => input.dispatchEvent(canceled));
      expect(canceled.defaultPrevented).toBe(true);

      const stopped = paletteKeyboardEvent(input, "PageDown");
      stopped.stopPropagation();
      act(() => input.dispatchEvent(stopped));
      expect(stopped.defaultPrevented).toBe(false);

      const activeElement = Object.getOwnPropertyDescriptor(document, "activeElement");
      Object.defineProperty(document, "activeElement", {
        configurable: true,
        value: focusOwner,
      });
      try {
        expect(dispatchPaletteKey(input, "PageDown").defaultPrevented).toBe(false);
      } finally {
        if (activeElement) {
          Object.defineProperty(document, "activeElement", activeElement);
        } else {
          Reflect.deleteProperty(document, "activeElement");
        }
      }
      expect(input).toHaveFocus();

      const fabricated = exactEvent(input, { key: "PageDown" });
      const proxied = new Proxy(exactEvent(input, { key: "PageDown" }), {});
      const crossed = exactEvent(input, {
        key: "PageDown",
        nativeEvent: paletteKeyboardEvent(input, "PageDown"),
      });
      act(() => {
        handler(fabricated as unknown as React.KeyboardEvent<HTMLInputElement>);
        handler(proxied as unknown as React.KeyboardEvent<HTMLInputElement>);
        handler(crossed as unknown as React.KeyboardEvent<HTMLInputElement>);
      });
      expect(fabricated.preventDefault).not.toHaveBeenCalled();
      expect(proxied.preventDefault).not.toHaveBeenCalled();
      expect(crossed.preventDefault).not.toHaveBeenCalled();

      const foreignWindow = foreignFrame.contentWindow as
        | (Window & typeof globalThis)
        | null;
      if (!foreignWindow) throw new Error("Foreign frame owner window was unavailable");
      const foreign = new foreignWindow.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "PageDown",
        key: "PageDown",
      });
      markJsdomEventTrusted(foreign);
      act(() => input.dispatchEvent(foreign));
      expect(foreign.defaultPrevented).toBe(false);

      expect(selectedCommand(input)).toBe("palette-item-item-0");
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(childProvider).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();

      const cleanSuccessor = dispatchPaletteKey(input, "PageDown");
      expect(cleanSuccessor.defaultPrevented).toBe(true);
      expect(selectedCommand(input)).toBe("palette-item-item-10");
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledOnce();
    } finally {
      await mounted.unmount();
      foreignFrame.remove();
      focusOwner.remove();
    }
  });

  it.each(["mutate-restore", "detach-reinsert", "reorder-restore"] as const)(
    "retires Page navigation after %s DOM history and accepts a distinct clean successor",
    async (transition) => {
      const mounted = await renderStrictRoot(<Harness items={commandList(15)} />);

      try {
        let input = await screen.findByTestId("palette-input");
        const content = screen.getByTestId("command-palette");
        const first = screen.getByTestId("palette-item-item-0");
        const parent = first.parentElement;
        if (!parent) throw new Error("Palette row group was unavailable");
        if (transition === "mutate-restore") {
          content.setAttribute("data-history-probe", "changed");
          content.removeAttribute("data-history-probe");
        } else if (transition === "detach-reinsert") {
          const next = first.nextSibling;
          first.remove();
          parent.insertBefore(first, next);
        } else {
          const next = first.nextSibling;
          parent.append(first);
          parent.insertBefore(first, next);
        }

        vi.mocked(Element.prototype.scrollIntoView).mockClear();
        const rejected = dispatchPaletteKey(input, "PageDown");
        expect(rejected.defaultPrevented).toBe(false);
        expect(selectedCommand(input)).toBe("palette-item-item-0");
        expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

        await mounted.render(
          <Harness
            key="clean-successor"
            items={Array.from({ length: 15 }, (_, index) =>
              command(`successor-${index}`, `Successor ${index}`),
            )}
          />,
        );
        input = await screen.findByTestId("palette-input");
        const accepted = dispatchPaletteKey(input, "PageDown");
        expect(accepted.defaultPrevented).toBe(true);
        expect(selectedCommand(input)).toBe("palette-item-successor-10");
        expect(input).toHaveFocus();
      } finally {
        await mounted.unmount();
      }
    },
  );

  it("rejects stale, replacement-restored, and cleaned-up Page handlers", async () => {
    const oldItems = commandList(15);
    const mounted = await renderStrictRoot(<Harness items={oldItems} />);
    let unmounted = false;

    try {
      const originalInput = await screen.findByTestId("palette-input");
      const staleHandler = reactProps<InputHandlerProps>(originalInput).onKeyDown;

      await mounted.render(
        <Harness
          items={Array.from({ length: 15 }, (_, index) =>
            command(`replacement-${index}`, `Replacement ${index}`),
          )}
        />,
      );
      await mounted.render(<Harness items={oldItems} />);
      const currentInput = await screen.findByTestId("palette-input");
      const restored = exactEvent(currentInput, { key: "PageDown" });
      act(() =>
        staleHandler(restored as unknown as React.KeyboardEvent<HTMLInputElement>),
      );
      expect(restored.preventDefault).not.toHaveBeenCalled();
      expect(selectedCommand(currentInput)).toBe("palette-item-item-0");

      const currentHandler = reactProps<InputHandlerProps>(currentInput).onKeyDown;
      await mounted.unmount();
      unmounted = true;
      const cleanedUp = exactEvent(currentInput, { key: "PageDown" });
      act(() =>
        currentHandler(cleanedUp as unknown as React.KeyboardEvent<HTMLInputElement>),
      );
      expect(cleanedUp.preventDefault).not.toHaveBeenCalled();
    } finally {
      if (!unmounted) await mounted.unmount();
    }
  });

  it("retains Arrow, Home, End, Enter, Backspace, Escape, and pointer behavior", async () => {
    const leafRun = vi.fn();
    const secondRun = vi.fn();
    const children = vi.fn(() => [command("leaf", "Leaf", leafRun)]);
    const mounted = await renderStrictRoot(
      <Harness
        items={[
          childCommand("parent", "Parent…", children),
          command("second", "Second", secondRun),
        ]}
      />,
    );

    try {
      let input = await screen.findByTestId("palette-input");
      dispatchPaletteKey(input, "ArrowUp");
      expect(selectedCommand(input)).toBe("palette-item-second");
      dispatchPaletteKey(input, "ArrowDown");
      expect(selectedCommand(input)).toBe("palette-item-parent");
      dispatchPaletteKey(input, "End");
      expect(selectedCommand(input)).toBe("palette-item-second");
      dispatchPaletteKey(input, "Home");
      expect(selectedCommand(input)).toBe("palette-item-parent");

      dispatchPaletteKey(input, "Enter");
      await screen.findByTestId("palette-item-leaf");
      expect(children).toHaveBeenCalledOnce();
      expect(input).toHaveFocus();
      dispatchPaletteKey(input, "Backspace");
      expect(screen.getByTestId("palette-item-parent")).toBeInTheDocument();
      expect(leafRun).not.toHaveBeenCalled();

      const second = screen.getByTestId("palette-item-second");
      fireEvent.mouseEnter(second);
      expect(selectedCommand(input)).toBe("palette-item-second");
      fireEvent.mouseDown(second);
      expect(input).toHaveFocus();
      fireEvent.click(second);
      await waitFor(() => expect(secondRun).toHaveBeenCalledOnce());
      expect(screen.queryByTestId("command-palette")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Open palette" }));
      input = await screen.findByTestId("palette-input");
      fireEvent.keyDown(input, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("command-palette")).toBeNull());
      expect(secondRun).toHaveBeenCalledOnce();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps the fresh input and keyboard navigation exact after replay", async () => {
    const mounted = await renderStrictRoot(
      <Harness
        items={[
          command("first", "First"),
          command("second", "Second"),
          command("third", "Third"),
        ]}
      />,
    );

    try {
      const input = await screen.findByTestId("palette-input");
      const staleKeyDown = reactProps<InputHandlerProps>(input).onKeyDown;

      fireEvent.change(input, { target: { value: "second" } });
      expect(screen.getByTestId("palette-item-second")).toBeInTheDocument();
      expect(screen.queryByTestId("palette-item-first")).toBeNull();

      const staleEvent = exactEvent(input, { key: "End" });
      act(() => staleKeyDown(staleEvent as unknown as React.KeyboardEvent<HTMLInputElement>));
      expect(staleEvent.preventDefault).not.toHaveBeenCalled();

      fireEvent.change(input, { target: { value: "" } });
      dispatchPaletteKey(input, "End");
      expect(input).toHaveAttribute("aria-activedescendant", "palette-item-third");
    } finally {
      await mounted.unmount();
    }
  });

  it("runs one fresh row command once under duplicate and reentrant delivery", async () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    let reenter = () => {};
    const run = vi.fn(() => reenter());
    const mounted = await renderStrictRoot(
      <Harness items={[command("leaf", "Leaf", run)]} initiallyOpen={false} />,
    );

    try {
      const opener = screen.getByRole("button", { name: "Open palette" });
      opener.focus();
      await act(async () => fireEvent.click(opener));
      const row = screen.getByTestId("palette-item-leaf");
      const click = reactProps<RowHandlerProps>(row).onClick;
      const clickEvent = exactEvent(row);
      reenter = () =>
        click(clickEvent as unknown as React.MouseEvent<HTMLDivElement>);

      act(() =>
        click({
          type: "click",
          currentTarget: row,
          target: row,
          nativeEvent: { type: "click", target: row },
          defaultPrevented: false,
          preventDefault: vi.fn(),
        } as unknown as React.MouseEvent<HTMLDivElement>),
      );
      expect(setItem).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();

      act(() => {
        click(clickEvent as unknown as React.MouseEvent<HTMLDivElement>);
        click(clickEvent as unknown as React.MouseEvent<HTMLDivElement>);
      });
      await act(async () => vi.runAllTimersAsync());

      expect(setItem).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledOnce();
      expect(opener).toHaveFocus();
    } finally {
      setItem.mockRestore();
      await mounted.unmount();
    }
  });

  it("accepts one genuine form submission from the fresh presentation", async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const mounted = await renderStrictRoot(
      <Harness items={[command("leaf", "Leaf", run)]} initiallyOpen={false} />,
    );

    try {
      const opener = screen.getByRole("button", { name: "Open palette" });
      opener.focus();
      await act(async () => fireEvent.click(opener));
      const input = screen.getByTestId("palette-input");
      const form = input.closest("form");
      if (!form) throw new Error("Palette form was not rendered");

      fireEvent.submit(form);
      fireEvent.submit(form);
      await act(async () => vi.runAllTimersAsync());

      expect(setItem).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledOnce();
      expect(opener).toHaveFocus();
    } finally {
      setItem.mockRestore();
      await mounted.unmount();
    }
  });

  it("loads and executes one fresh nested child after duplicate request delivery", async () => {
    vi.useFakeTimers();
    const pending = deferred<Command[]>();
    const childRun = vi.fn();
    const children = vi.fn(() => pending.promise);
    const mounted = await renderStrictRoot(
      <Harness items={[childCommand("parent", "Parent…", children)]} />,
    );

    try {
      const parent = screen.getByTestId("palette-item-parent");
      const click = reactProps<RowHandlerProps>(parent).onClick;
      const clickEvent = exactEvent(parent);
      await act(async () => {
        click(clickEvent as unknown as React.MouseEvent<HTMLDivElement>);
        click(clickEvent as unknown as React.MouseEvent<HTMLDivElement>);
      });
      expect(children).toHaveBeenCalledOnce();

      await settle(pending, "resolve", [command("child", "Child", childRun)]);
      fireEvent.click(screen.getByTestId("palette-item-child"));
      await act(async () => vi.runAllTimersAsync());

      expect(children).toHaveBeenCalledOnce();
      expect(childRun).toHaveBeenCalledOnce();
    } finally {
      await mounted.unmount();
    }
  });

  it("accepts one fresh Retry and rejects its repeated stale event", async () => {
    const retry = deferred<Command[]>();
    const children = vi
      .fn()
      .mockRejectedValueOnce(new Error("Retry this child"))
      .mockReturnValueOnce(retry.promise);
    const mounted = await renderStrictRoot(
      <Harness items={[childCommand("parent", "Parent…", children)]} />,
    );

    try {
      fireEvent.click(await screen.findByTestId("palette-item-parent"));
      const alert = await screen.findByRole("alert");
      const retryButton = within(alert).getByRole("button", { name: "Retry" });
      const retryClick = reactProps<ButtonHandlerProps>(retryButton).onClick;
      const retryEvent = exactEvent(retryButton);

      await act(async () => {
        retryClick(retryEvent as unknown as React.MouseEvent<HTMLButtonElement>);
        retryClick(retryEvent as unknown as React.MouseEvent<HTMLButtonElement>);
      });
      expect(children).toHaveBeenCalledTimes(2);

      await settle(retry, "resolve", [command("result", "Result")]);
      act(() =>
        retryClick(retryEvent as unknown as React.MouseEvent<HTMLButtonElement>),
      );
      expect(children).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("palette-item-result")).toBeInTheDocument();
    } finally {
      await mounted.unmount();
    }
  });

  it("accepts one fresh Back and rejects late child settlement", async () => {
    const late = deferred<Command[]>();
    const nested = childCommand("nested", "Nested…", () => late.promise);
    const children = vi.fn(() => [nested]);
    const mounted = await renderStrictRoot(
      <Harness items={[childCommand("parent", "Parent…", children)]} />,
    );

    try {
      fireEvent.click(await screen.findByTestId("palette-item-parent"));
      await screen.findByTestId("palette-item-nested");
      fireEvent.click(screen.getByTestId("palette-item-nested"));
      expect(screen.getByRole("status")).toHaveTextContent("Loading…");

      const backButton = screen.getByRole("button", { name: "Back" });
      const backClick = reactProps<ButtonHandlerProps>(backButton).onClick;
      const backEvent = exactEvent(backButton);
      act(() => {
        backClick(backEvent as unknown as React.MouseEvent<HTMLButtonElement>);
        backClick(backEvent as unknown as React.MouseEvent<HTMLButtonElement>);
      });
      expect(screen.getByTestId("palette-item-parent")).toBeInTheDocument();

      await settle(late, "resolve", [command("late", "Late result")]);
      expect(screen.queryByTestId("palette-item-late")).toBeNull();

      fireEvent.click(screen.getByTestId("palette-item-parent"));
      expect(await screen.findByTestId("palette-item-nested")).toBeInTheDocument();
      expect(children).toHaveBeenCalledTimes(2);
    } finally {
      await mounted.unmount();
    }
  });

  it("binds Escape to only the fresh Strict Mode visit", async () => {
    const mounted = await renderStrictRoot(
      <Harness items={[command("leaf", "Leaf")]} initiallyOpen={false} />,
    );

    try {
      const opener = screen.getByRole("button", { name: "Open palette" });
      opener.focus();
      fireEvent.click(opener);
      const staleContent = await screen.findByRole("dialog");
      const stale = contentDismissalHandlers(staleContent);
      fireEvent.keyDown(staleContent, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      fireEvent.click(opener);
      const currentContent = await screen.findByRole("dialog");
      stale.onEscapeKeyDown(escapeDismissalEvent(staleContent));
      stale.onDismiss();
      expect(currentContent).toBeInTheDocument();

      fireEvent.keyDown(currentContent, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(opener).toHaveFocus();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps primary pointer provenance through Radix's deferred click after a microtask", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    const onOpenChange = vi.fn();
    const mounted = await renderStrictRoot(
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        commands={commandProvider(command("leaf", "Leaf"))}
      />,
    );

    try {
      await screen.findByRole("dialog");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      act(() => outside.dispatchEvent(primaryPointerEvent(outside, "pointerdown")));
      await act(async () => Promise.resolve());
      act(() => {
        outside.dispatchEvent(primaryPointerEvent(outside, "pointerup"));
        outside.dispatchEvent(primaryClickEvent(outside));
        outside.dispatchEvent(primaryClickEvent(outside));
      });

      expect(onOpenChange).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      await mounted.unmount();
      outside.remove();
    }
  });

  it("expires incomplete and retired pointer sequences without poisoning the successor", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    const onOpenChangeA = vi.fn();
    const onOpenChangeB = vi.fn();
    const mounted = await renderStrictRoot(
      <CommandPalette
        open
        onOpenChange={onOpenChangeA}
        commands={commandProvider(command("alpha", "Alpha"))}
      />,
    );

    try {
      await screen.findByTestId("palette-item-alpha");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      act(() => {
        outside.dispatchEvent(primaryPointerEvent(outside, "pointerdown"));
        outside.dispatchEvent(primaryPointerEvent(outside, "pointerup"));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      act(() => outside.dispatchEvent(primaryClickEvent(outside)));
      expect(onOpenChangeA).not.toHaveBeenCalled();

      act(() => {
        outside.dispatchEvent(primaryPointerEvent(outside, "pointerdown"));
        outside.dispatchEvent(primaryPointerEvent(outside, "pointercancel"));
        outside.dispatchEvent(primaryPointerEvent(outside, "pointerup"));
        outside.dispatchEvent(primaryClickEvent(outside));
      });
      expect(onOpenChangeA).not.toHaveBeenCalled();

      act(() => outside.dispatchEvent(primaryPointerEvent(outside, "pointerdown")));
      await mounted.render(
        <CommandPalette
          open
          onOpenChange={onOpenChangeB}
          commands={commandProvider(command("beta", "Beta"))}
        />,
      );
      await screen.findByTestId("palette-item-beta");
      act(() => {
        outside.dispatchEvent(primaryPointerEvent(outside, "pointerup"));
        outside.dispatchEvent(primaryClickEvent(outside));
      });
      expect(onOpenChangeA).not.toHaveBeenCalled();
      expect(onOpenChangeB).not.toHaveBeenCalled();

      act(() => {
        outside.dispatchEvent(primaryPointerEvent(outside, "pointerdown"));
        outside.dispatchEvent(primaryPointerEvent(outside, "pointerup"));
        outside.dispatchEvent(primaryClickEvent(outside));
      });
      expect(onOpenChangeA).not.toHaveBeenCalled();
      expect(onOpenChangeB).toHaveBeenCalledOnce();
    } finally {
      await mounted.unmount();
      outside.remove();
    }
  });

  it("claims one genuine focus-outside dismissal after replay", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    const onOpenChange = vi.fn();
    const mounted = await renderStrictRoot(
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        commands={commandProvider(command("leaf", "Leaf"))}
      />,
    );

    try {
      const content = await screen.findByRole("dialog");
      const handlers = contentDismissalHandlers(content);
      const event = focusOutsideEvent(content, outside, content, true);
      handlers.onFocusOutside(event);
      handlers.onFocusOutside(event);
      handlers.onDismiss();
      handlers.onDismiss();

      expect(onOpenChange).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      await mounted.unmount();
      outside.remove();
    }
  });

  it("prevents an invalidated implicit submit and accepts the fresh submit once", async () => {
    vi.useFakeTimers();
    const staleRun = vi.fn();
    const currentRun = vi.fn();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const mounted = await renderStrictRoot(
      <Harness items={[command("stale", "Stale", staleRun)]} />,
    );

    try {
      const content = screen.getByRole("dialog");
      const staleForm = screen.getByTestId("palette-input").closest("form");
      if (!staleForm) throw new Error("Palette form was not rendered");
      content.setAttribute("data-intervening", "true");
      content.removeAttribute("data-intervening");
      const staleSubmit = implicitSubmitEvent(staleForm);
      act(() => staleForm.dispatchEvent(staleSubmit));

      expect(staleSubmit.defaultPrevented).toBe(true);
      expect(staleRun).not.toHaveBeenCalled();
      expect(setItem).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      await mounted.render(
        <Harness items={[command("current", "Current", currentRun)]} />,
      );
      const currentInput = screen.getByTestId("palette-input");
      screen.getByTestId("palette-item-current");
      const currentForm = currentInput.closest("form");
      if (!currentForm) throw new Error("Fresh palette form was not rendered");
      const currentSubmit = implicitSubmitEvent(currentForm);
      act(() => currentForm.dispatchEvent(currentSubmit));
      await act(async () => vi.runAllTimersAsync());

      expect(currentSubmit.defaultPrevented).toBe(true);
      expect(staleRun).not.toHaveBeenCalled();
      expect(currentRun).toHaveBeenCalledOnce();
      expect(setItem).toHaveBeenCalledOnce();
    } finally {
      setItem.mockRestore();
      await mounted.unmount();
    }
  });

  it("disconnects every palette guard after a layout-active ordinary invalidation", async () => {
    const NativeMutationObserver = window.MutationObserver;
    const tracked = new Set<TrackingMutationObserver>();
    class TrackingMutationObserver extends NativeMutationObserver {
      disconnected = false;

      override observe(target: Node, options?: MutationObserverInit): void {
        if (
          target instanceof HTMLElement &&
          (target.getAttribute("role") === "dialog" ||
            target.classList.contains("dialog-overlay"))
        ) {
          tracked.add(this);
        }
        super.observe(target, options);
      }

      override disconnect(): void {
        this.disconnected = true;
        super.disconnect();
      }
    }
    Object.defineProperty(window, "MutationObserver", {
      configurable: true,
      value: TrackingMutationObserver,
    });
    const run = vi.fn();
    const mounted = await renderStrictRoot(
      <Harness items={[command("leaf", "Leaf", run)]} />,
    );
    let unmounted = false;

    try {
      const content = await screen.findByRole("dialog");
      content.setAttribute("data-intervening", "true");
      content.removeAttribute("data-intervening");
      fireEvent.click(screen.getByTestId("palette-item-leaf"));
      expect(run).not.toHaveBeenCalled();

      await mounted.unmount();
      unmounted = true;
      expect(tracked.size).toBeGreaterThan(0);
      expect([...tracked].every((observer) => observer.disconnected)).toBe(true);
    } finally {
      if (!unmounted) await mounted.unmount();
      Object.defineProperty(window, "MutationObserver", {
        configurable: true,
        value: NativeMutationObserver,
      });
    }
  });

  it.each([
    "mutate-restore",
    "detach-reinsert",
    "reorder-restore",
    "portal-parent-detach",
    "portal-ancestor-detach",
  ] as const)(
    "retires a Strict Mode row after %s without poisoning its fresh replacement",
    async (transition) => {
      const staleChildren = vi.fn(() => [command("stale-result", "Stale result")]);
      const currentPending = deferred<Command[]>();
      const currentChildren = vi.fn(() => currentPending.promise);
      const onOpenChange = vi.fn();
      const staleCommands = commandProvider(
        childCommand("stale", "Stale…", staleChildren),
        command("other", "Other"),
      );
      const currentCommands = commandProvider(
        childCommand("current", "Current…", currentChildren),
      );
      const mounted = await renderStrictRoot(
        <CommandPalette
          open
          onOpenChange={onOpenChange}
          commands={staleCommands}
        />,
      );

      try {
        const content = await screen.findByRole("dialog");
        const staleRow = screen.getByTestId("palette-item-stale");
        if (transition === "mutate-restore") {
          content.setAttribute("data-intervening", "true");
          content.removeAttribute("data-intervening");
        } else if (
          transition === "portal-parent-detach" ||
          transition === "portal-ancestor-detach"
        ) {
          const portalParent = content.parentNode;
          const node =
            transition === "portal-parent-detach"
              ? portalParent
              : portalParent?.parentNode;
          const parent = node?.parentNode;
          if (!node || !parent) throw new Error("Palette portal ancestry was incomplete");
          const next = node.nextSibling;
          parent.removeChild(node);
          parent.insertBefore(node, next);
        } else {
          const parent = staleRow.parentElement!;
          if (transition === "detach-reinsert") {
            staleRow.remove();
            parent.prepend(staleRow);
          } else {
            const otherRow = screen.getByTestId("palette-item-other");
            parent.append(staleRow);
            parent.insertBefore(staleRow, otherRow);
          }
        }

        fireEvent.click(staleRow);
        expect(staleChildren).not.toHaveBeenCalled();
        expect(onOpenChange).not.toHaveBeenCalled();

        await mounted.render(
          <CommandPalette
            open
            onOpenChange={onOpenChange}
            commands={currentCommands}
          />,
        );
        fireEvent.click(await screen.findByTestId("palette-item-current"));
        expect(currentChildren).toHaveBeenCalledOnce();

        await settle(currentPending, "resolve", [
          command("current-result", "Current result"),
        ]);
        expect(screen.getByTestId("palette-item-current-result")).toBeInTheDocument();
        expect(staleChildren).not.toHaveBeenCalled();
      } finally {
        await mounted.unmount();
      }
    },
  );
});
