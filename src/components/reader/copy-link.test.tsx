// @vitest-environment jsdom
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const copyText = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", async (original) => ({ ...await original<typeof import("@/lib/clipboard")>(), copyText }));

import { ReaderCopyLink } from "./copy-link";

const DOC_ID = "doc-919";
const NEXT_DOC_ID = "doc-920";
const MANUAL_COPY_INSTRUCTION = "Press Ctrl+C (Command+C on Mac) to copy";
const readerUrl = (docId = DOC_ID) => `${window.location.origin}/p/${docId}`;

interface CopyClickEvent {
  type: string;
  button: number;
  currentTarget: EventTarget | null;
  target: EventTarget | null;
  nativeEvent: Event;
  defaultPrevented: boolean;
}

interface FallbackFocusEvent {
  type: string;
  currentTarget: EventTarget | null;
  target: EventTarget | null;
  nativeEvent: Event;
  defaultPrevented: boolean;
}

type CopyClick = (event: CopyClickEvent) => void;
type FallbackFocus = (event: FallbackFocusEvent) => void;
type CopyPart = "root" | "button" | "fallback";

interface BoundaryProps {
  docId?: string;
  present?: boolean;
  instance?: string;
  boundary?: number;
  onLayout?: () => void;
  onPassiveCleanup?: () => void;
}

function ReaderMount({
  docId,
  onPassiveCleanup,
}: {
  docId: string;
  onPassiveCleanup?: () => void;
}) {
  useEffect(() => onPassiveCleanup, [onPassiveCleanup]);
  return <ReaderCopyLink docId={docId} />;
}

function ReaderBoundary({
  docId = DOC_ID,
  present = true,
  instance = "reader",
  boundary = 0,
  onLayout,
  onPassiveCleanup,
}: BoundaryProps) {
  useLayoutEffect(() => {
    if (boundary > 0) onLayout?.();
  }, [boundary, onLayout]);
  return present ? (
    <ReaderMount
      key={instance}
      docId={docId}
      onPassiveCleanup={onPassiveCleanup}
    />
  ) : null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function reactHandler<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return handler as T;
}

function reactRef<T extends HTMLElement>(element: T): (node: T | null) => void {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? (element as unknown as Record<string, { ref?: unknown }>)[propsKey]
    : undefined;
  if (typeof props?.ref === "function") return props.ref as (node: T | null) => void;
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error(`React fiber was not attached to ${element.dataset.testid ?? element.tagName}`);
  const fiber = (element as unknown as Record<string, { ref?: unknown }>)[fiberKey];
  if (typeof fiber?.ref !== "function") throw new Error(`React ref was not attached to ${element.dataset.testid ?? element.tagName}`);
  return fiber.ref as (node: T | null) => void;
}

function copyElements(requireFallback = false) {
  const button = screen.getByTestId("reader-copy-link") as HTMLButtonElement;
  const root = button.parentElement;
  if (!(root instanceof HTMLDivElement)) throw new Error("Copy link root was not rendered");
  const fallback = screen.queryByTestId("reader-copy-link-fallback");
  if (fallback !== null && !(fallback instanceof HTMLInputElement)) {
    throw new Error("Copy link fallback was not an input");
  }
  const instruction = screen.queryByTestId("reader-copy-link-instruction");
  if (instruction !== null && !(instruction instanceof HTMLParagraphElement)) {
    throw new Error("Copy link instruction was not a paragraph");
  }
  if (requireFallback && (!fallback || !instruction)) {
    throw new Error("Copy link fallback was not rendered completely");
  }
  return { root, button, fallback, instruction };
}

function expectNoManualCopyGuidance() {
  expect(screen.queryByTestId("reader-copy-link-fallback")).not.toBeInTheDocument();
  expect(screen.queryByTestId("reader-copy-link-instruction")).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
}

async function enabledCopyButton() {
  const button = screen.getByRole("button", { name: "Copy link" });
  await waitFor(() => expect(button).toBeEnabled());
  return button as HTMLButtonElement;
}

function connectedButton(label = "Other") {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", label);
  document.body.append(button);
  return button;
}

function copyClickEvent(
  currentTarget: EventTarget | null,
  {
    target = currentTarget,
    nativeTarget = target,
    type = "click",
    nativeType = "click",
    button = 0,
    nativeButton = button,
    nativeEvent,
  }: {
    target?: EventTarget | null;
    nativeTarget?: EventTarget | null;
    type?: string;
    nativeType?: string;
    button?: number;
    nativeButton?: number;
    nativeEvent?: Event;
  } = {},
): CopyClickEvent {
  const ownerDocument = currentTarget instanceof Node
    ? currentTarget.ownerDocument ?? document
    : document;
  const MouseEventConstructor = ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
  const actualNativeEvent = nativeEvent ??
    new MouseEventConstructor(nativeType, { bubbles: true, button: nativeButton });
  if (nativeEvent === undefined) {
    Object.defineProperty(actualNativeEvent, "target", {
      configurable: true,
      value: nativeTarget,
    });
  }
  return {
    type,
    button,
    currentTarget,
    target,
    nativeEvent: actualNativeEvent,
    defaultPrevented: false,
  };
}

function fallbackFocusEvent(
  currentTarget: EventTarget | null,
  target: EventTarget | null = currentTarget,
): FallbackFocusEvent {
  const ownerDocument = currentTarget instanceof Node
    ? currentTarget.ownerDocument ?? document
    : document;
  const FocusEventConstructor = ownerDocument.defaultView?.FocusEvent ?? FocusEvent;
  const nativeEvent = new FocusEventConstructor("focusin", { bubbles: true });
  Object.defineProperty(nativeEvent, "target", {
    configurable: true,
    value: target,
  });
  return {
    type: "focus",
    currentTarget,
    target,
    nativeEvent,
    defaultPrevented: false,
  };
}

const directRoots = new Set<Root>();

function createDirectView(props: BoundaryProps = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  directRoots.add(root);
  act(() => root.render(<ReaderBoundary {...props} />));
  return { host, root };
}

function createDirectStrictView(props: BoundaryProps = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  directRoots.add(root);
  act(() => root.render(
    <StrictMode>
      <ReaderBoundary {...props} />
    </StrictMode>,
  ));
  return { host, root };
}

function renderDirect(root: Root, props: BoundaryProps) {
  act(() => root.render(<ReaderBoundary {...props} />));
}

function renderDirectStrict(root: Root, props: BoundaryProps) {
  act(() => root.render(
    <StrictMode>
      <ReaderBoundary {...props} />
    </StrictMode>,
  ));
}

async function settle<T>(operation: ReturnType<typeof deferred<T>>, value: T) {
  await act(async () => {
    operation.resolve(value);
    await operation.promise;
    await Promise.resolve();
  });
}

beforeEach(() => {
  copyText.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  for (const root of directRoots) act(() => root.unmount());
  directRoots.clear();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("ReaderCopyLink presentation", () => {
  it("retires the disabled pre-origin handler and preserves the canonical URL, feedback, label, and phone target", async () => {
    let disabledAtBoundary: boolean | undefined;
    let preOriginClick: CopyClick | undefined;
    createDirectView({
      boundary: 1,
      onLayout: () => {
        const button = copyElements().button;
        disabledAtBoundary = button.disabled;
        preOriginClick = reactHandler<CopyClick>(button, "onClick");
      },
    });

    const button = await enabledCopyButton();
    expect(disabledAtBoundary).toBe(true);
    expect(preOriginClick).toBeDefined();
    act(() => preOriginClick?.(copyClickEvent(button)));
    expect(copyText).not.toHaveBeenCalled();

    const currentClick = reactHandler<CopyClick>(button, "onClick");
    await act(async () => {
      currentClick(copyClickEvent(button));
      await Promise.resolve();
    });

    expect(copyText).toHaveBeenCalledExactlyOnceWith(readerUrl());
    expect(screen.getByRole("button", { name: "Copied" })).toBe(button);
    expect(button).toHaveClass("h-11", "w-11", "sm:h-8", "sm:w-auto");
    expect(within(button).getByText("Copied")).toHaveClass("hidden", "sm:inline");
    expect(button).toHaveAccessibleName("Copied");
  });

  it("publishes one described fallback, polite announcement, focus, and selection through the exact Strict Mode input", async () => {
    copyText.mockResolvedValue(false);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const select = vi.spyOn(HTMLInputElement.prototype, "select");
    render(
      <StrictMode>
        <ReaderCopyLink docId={DOC_ID} />
      </StrictMode>,
    );
    expectNoManualCopyGuidance();
    fireEvent.click(await enabledCopyButton());

    const fallback = await screen.findByRole<HTMLInputElement>("textbox", {
      name: "Reader link",
      description: MANUAL_COPY_INSTRUCTION,
    });
    const instruction = screen.getByTestId("reader-copy-link-instruction");
    expect(screen.getAllByRole("textbox", { name: "Reader link" })).toEqual([fallback]);
    expect(screen.getAllByText(MANUAL_COPY_INSTRUCTION)).toEqual([instruction]);
    expect(screen.getAllByRole("status")).toEqual([instruction]);
    expect(fallback).toHaveValue(readerUrl());
    expect(fallback).toHaveAttribute("readonly");
    expect(fallback).toHaveAccessibleDescription(MANUAL_COPY_INSTRUCTION);
    expect(fallback).toHaveAccessibleDescription(/Ctrl\+C/);
    expect(fallback).toHaveAccessibleDescription(/Command\+C on Mac/);
    expect(fallback.getAttribute("aria-describedby")?.trim().split(/\s+/)).toEqual([
      instruction.id,
    ]);
    expect(instruction).toBeVisible();
    expect(instruction).toHaveTextContent("Ctrl+C");
    expect(instruction).toHaveTextContent("Command+C on Mac");
    expect(instruction).toHaveAttribute("role", "status");
    expect(instruction).toHaveAttribute("aria-live", "polite");
    expect(instruction).toHaveAttribute("aria-atomic", "true");
    expect(fallback).toHaveFocus();
    expect(fallback).toHaveProperty("selectionStart", 0);
    expect(fallback).toHaveProperty("selectionEnd", readerUrl().length);
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(select).toHaveBeenCalledTimes(1);

    const handler = reactHandler<FallbackFocus>(fallback, "onFocus");
    const sibling = document.createElement("input");
    const foreign = document.createElement("input");
    const detached = document.createElement("input");
    copyElements().root.before(sibling);
    document.body.append(foreign);
    const repeated = fallbackFocusEvent(fallback);
    focus.mockClear();
    select.mockClear();
    act(() => {
      handler(fallbackFocusEvent(sibling));
      handler(fallbackFocusEvent(foreign));
      handler(fallbackFocusEvent(detached));
      handler(repeated);
      handler(repeated);
    });
    expect(focus).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(fallback).toHaveFocus();
  });

  it("removes the Strict Mode fallback, description, and announcement on the existing two-second cadence", async () => {
    copyText.mockResolvedValue(false);
    render(
      <StrictMode>
        <ReaderCopyLink docId={DOC_ID} />
      </StrictMode>,
    );
    const button = await enabledCopyButton();
    vi.useFakeTimers();
    try {
      fireEvent.click(button);
      await act(async () => {
        await Promise.resolve();
      });
      const fallback = copyElements(true).fallback!;
      const instruction = screen.getByRole("status");
      expect(fallback).toHaveAccessibleDescription(MANUAL_COPY_INSTRUCTION);
      expect(instruction).toHaveTextContent(MANUAL_COPY_INSTRUCTION);

      act(() => vi.advanceTimersByTime(1999));
      expect(copyElements(true).instruction).toBe(instruction);
      act(() => vi.advanceTimersByTime(1));
      expectNoManualCopyGuidance();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes one fresh Strict Mode announcement for each accepted repeated fallback operation", async () => {
    const firstAttempt = deferred<boolean>();
    const secondAttempt = deferred<boolean>();
    copyText
      .mockReturnValueOnce(firstAttempt.promise)
      .mockReturnValueOnce(secondAttempt.promise);
    const view = createDirectStrictView();
    const button = await enabledCopyButton();
    vi.useFakeTimers();
    try {
      const firstClick = reactHandler<CopyClick>(button, "onClick");
      act(() => firstClick(copyClickEvent(button)));
      await settle(firstAttempt, false);

      const firstFallback = copyElements(true);
      const firstInstruction = firstFallback.instruction!;
      const descriptionId = firstInstruction.id;
      expect(screen.getAllByRole("status")).toEqual([firstInstruction]);
      expect(firstFallback.fallback).toHaveAccessibleDescription(
        MANUAL_COPY_INSTRUCTION,
      );

      act(() => vi.advanceTimersByTime(2000));
      expectNoManualCopyGuidance();
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);
      expect(copyText).toHaveBeenCalledTimes(2);
      expectNoManualCopyGuidance();

      await settle(secondAttempt, false);
      const secondFallback = copyElements(true);
      expect(secondFallback.instruction).not.toBe(firstInstruction);
      expect(secondFallback.instruction).toHaveAttribute("id", descriptionId);
      expect(screen.getAllByRole("status")).toEqual([secondFallback.instruction]);
      expect(secondFallback.fallback).toHaveAccessibleDescription(
        MANUAL_COPY_INSTRUCTION,
      );
      act(() => view.root.unmount());
      directRoots.delete(view.root);
      expectNoManualCopyGuidance();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps clipboard copy exact after direct Strict Mode replay and claims before reentrant work", async () => {
    const attempt = deferred<boolean>();
    let retiredClick: CopyClick | undefined;
    let retiredRootRef: ((node: HTMLDivElement | null) => void) | undefined;
    let retiredButtonRef: ((node: HTMLButtonElement | null) => void) | undefined;
    createDirectStrictView({
      boundary: 1,
      onLayout: () => {
        if (retiredClick) return;
        const { root, button } = copyElements();
        retiredClick = reactHandler<CopyClick>(button, "onClick");
        retiredRootRef = reactRef(root);
        retiredButtonRef = reactRef(button);
      },
    });
    const button = await enabledCopyButton();
    const currentClick = reactHandler<CopyClick>(button, "onClick");
    expect(retiredClick).toBeDefined();
    expect(currentClick).not.toBe(retiredClick);

    const activation = copyClickEvent(button);
    copyText.mockImplementationOnce(() => {
      currentClick(activation);
      retiredClick?.(activation);
      return attempt.promise;
    });
    act(() => {
      retiredClick?.(activation);
      currentClick(activation);
      currentClick(activation);
    });
    expect(copyText).toHaveBeenCalledExactlyOnceWith(readerUrl());

    await settle(attempt, true);
    act(() => {
      retiredRootRef?.(copyElements().root);
      retiredButtonRef?.(button);
      retiredButtonRef?.(null);
      retiredRootRef?.(null);
      retiredClick?.(copyClickEvent(button));
    });
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Copied" })).toBe(button);
    expectNoManualCopyGuidance();
  });

  it("keeps fallback selection exact after direct Strict Mode replay and isolates late A settlement", async () => {
    const oldAttempt = deferred<boolean>();
    const currentAttempt = deferred<boolean>();
    copyText
      .mockReturnValueOnce(oldAttempt.promise)
      .mockReturnValueOnce(currentAttempt.promise);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const select = vi.spyOn(HTMLInputElement.prototype, "select");
    const view = createDirectStrictView({ instance: "a" });
    const oldButton = await enabledCopyButton();
    const oldClick = reactHandler<CopyClick>(oldButton, "onClick");
    const oldRootRef = reactRef(copyElements().root);
    const oldButtonRef = reactRef(oldButton);
    act(() => oldClick(copyClickEvent(oldButton)));

    renderDirectStrict(view.root, {
      docId: NEXT_DOC_ID,
      instance: "b",
    });
    const currentButton = await enabledCopyButton();
    const currentClick = reactHandler<CopyClick>(currentButton, "onClick");
    act(() => {
      oldRootRef(copyElements().root);
      oldButtonRef(currentButton);
      oldButtonRef(null);
      oldRootRef(null);
      oldClick(copyClickEvent(currentButton));
      currentClick(copyClickEvent(oldButton));
      currentClick(copyClickEvent(currentButton));
    });
    expect(copyText).toHaveBeenNthCalledWith(1, readerUrl());
    expect(copyText).toHaveBeenNthCalledWith(2, readerUrl(NEXT_DOC_ID));

    await settle(oldAttempt, false);
    expectNoManualCopyGuidance();
    expect(focus).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();

    await settle(currentAttempt, false);
    const fallback = screen.getByRole<HTMLInputElement>("textbox", { name: "Reader link" });
    expect(fallback).toHaveValue(readerUrl(NEXT_DOC_ID));
    expect(fallback).toHaveAccessibleDescription(MANUAL_COPY_INSTRUCTION);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(fallback).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("rejects every wrong button source and accepts one exact repeated event without incidental work", async () => {
    const attempt = deferred<boolean>();
    copyText.mockReturnValue(attempt.promise);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const select = vi.spyOn(HTMLInputElement.prototype, "select");
    render(<ReaderCopyLink docId={DOC_ID} />);
    const exact = await enabledCopyButton();
    const root = copyElements().root;
    const handler = reactHandler<CopyClick>(exact, "onClick");
    const sibling = connectedButton("Copy link");
    const foreignRoot = document.createElement("div");
    const foreign = document.createElement("button");
    foreign.type = "button";
    foreign.setAttribute("aria-label", "Copy link");
    foreignRoot.append(foreign);
    document.body.append(foreignRoot);
    const detached = document.createElement("button");
    detached.type = "button";
    detached.setAttribute("aria-label", "Copy link");
    const replacement = exact.cloneNode(true) as HTMLButtonElement;
    document.body.append(replacement);
    const markup = root.outerHTML;

    act(() => {
      handler(copyClickEvent(sibling));
      handler(copyClickEvent(foreign));
      handler(copyClickEvent(detached));
      handler(copyClickEvent(replacement));
      handler(copyClickEvent(exact, { nativeEvent: new Event("click") }));
      handler(copyClickEvent(exact, { type: "pointerdown" }));
      handler(copyClickEvent(exact, { button: 1 }));
      handler(copyClickEvent(exact, { nativeButton: 1 }));
      handler(copyClickEvent(exact, { nativeTarget: sibling }));
    });
    expect(copyText).not.toHaveBeenCalled();
    expect(root.outerHTML).toBe(markup);
    expect(focus).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();

    const repeated = copyClickEvent(exact);
    act(() => {
      handler(repeated);
      handler(repeated);
      handler(repeated);
    });
    expect(copyText).toHaveBeenCalledExactlyOnceWith(readerUrl());
    expect(root.outerHTML).toBe(markup);
    expect(focus).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("fails a detached, reinserted, or previously mutated publication closed without poisoning its successor", async () => {
    const view = createDirectView({ instance: "a" });
    const stale = copyElements();
    await waitFor(() => expect(stale.button).toBeEnabled());
    const staleClick = reactHandler<CopyClick>(stale.button, "onClick");
    const staleRootRef = reactRef(stale.root);
    const staleButtonRef = reactRef(stale.button);
    const text = stale.button.querySelector("span");
    const parent = stale.root.parentNode;
    if (!text || !parent) throw new Error("Expected the committed Copy link topology");
    const replacementText = text.cloneNode(true) as Element;
    text.replaceWith(replacementText);
    replacementText.replaceWith(text);
    const nextSibling = stale.root.nextSibling;
    stale.root.remove();
    parent.insertBefore(stale.root, nextSibling);

    act(() => staleClick(copyClickEvent(stale.button)));
    expect(copyText).not.toHaveBeenCalled();

    renderDirect(view.root, { instance: "b" });
    const current = copyElements();
    await waitFor(() => expect(current.button).toBeEnabled());
    const currentClick = reactHandler<CopyClick>(current.button, "onClick");
    const activation = copyClickEvent(current.button);
    act(() => {
      staleRootRef(current.root);
      staleButtonRef(current.button);
      staleButtonRef(null);
      staleRootRef(null);
      staleClick(activation);
      currentClick(activation);
      currentClick(activation);
    });
    expect(copyText).toHaveBeenCalledExactlyOnceWith(readerUrl());
  });

  it.each([
    "partial fallback ref replay",
    "root detach and reinsert",
    "panel replacement and restoration",
    "instruction reorder and restoration",
    "instruction mutation and restoration",
  ] as const)(
    "does not revive old Strict Mode guidance after %s and document replacement",
    async (change) => {
      copyText.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      const view = createDirectStrictView({ instance: "a" });
      const button = await enabledCopyButton();
      vi.useFakeTimers();
      try {
        fireEvent.click(button);
        await act(async () => {
          await Promise.resolve();
        });
        const stale = copyElements(true);
        const fallback = stale.fallback!;
        const instruction = stale.instruction!;
        const panel = fallback.parentElement;
        const staleClick = reactHandler<CopyClick>(stale.button, "onClick");
        const staleFallbackRef = reactRef(fallback);
        if (!(panel instanceof HTMLDivElement)) {
          throw new Error("Manual-copy fallback did not have a panel");
        }

        if (change === "partial fallback ref replay") {
          act(() => {
            staleFallbackRef(null);
            staleFallbackRef(fallback);
          });
        } else if (change === "root detach and reinsert") {
          const parent = stale.root.parentNode;
          const nextSibling = stale.root.nextSibling;
          if (!parent) throw new Error("Copy link root did not have a parent");
          stale.root.remove();
          parent.insertBefore(stale.root, nextSibling);
        } else if (change === "panel replacement and restoration") {
          const replacement = panel.cloneNode(true);
          panel.replaceWith(replacement);
          const replacementParent = replacement.parentNode;
          if (!replacementParent) {
            throw new Error("Replacement panel did not have a parent");
          }
          replacementParent.replaceChild(panel, replacement);
        } else if (change === "instruction reorder and restoration") {
          panel.insertBefore(instruction, fallback);
          panel.append(instruction);
        } else {
          instruction.textContent = "Changed";
          instruction.textContent = MANUAL_COPY_INSTRUCTION;
        }

        act(() => staleClick(copyClickEvent(stale.button)));
        expect(copyText).toHaveBeenCalledTimes(1);

        renderDirectStrict(view.root, {
          docId: NEXT_DOC_ID,
          instance: "b",
        });
        const current = copyElements();
        expect(current.button).toBeEnabled();
        expectNoManualCopyGuidance();

        act(() => {
          staleFallbackRef(fallback);
          staleFallbackRef(null);
          staleClick(copyClickEvent(current.button));
          vi.advanceTimersByTime(2000);
        });
        expect(copyText).toHaveBeenCalledTimes(1);
        expectNoManualCopyGuidance();

        fireEvent.click(current.button);
        await act(async () => {
          await Promise.resolve();
        });
        expect(copyText).toHaveBeenNthCalledWith(2, readerUrl(NEXT_DOC_ID));
        expect(screen.getByRole("button", { name: "Copied" })).toBe(current.button);
        expectNoManualCopyGuidance();
        act(() => vi.advanceTimersByTime(1500));
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("retires the idle status handler before copied status and keeps the current control usable", async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    copyText.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<ReaderCopyLink docId={DOC_ID} />);
    const button = await enabledCopyButton();
    const idleClick = reactHandler<CopyClick>(button, "onClick");
    const firstEvent = copyClickEvent(button);
    act(() => {
      idleClick(firstEvent);
      idleClick(firstEvent);
    });
    expect(copyText).toHaveBeenCalledTimes(1);

    await settle(first, true);
    const copiedButton = screen.getByRole("button", { name: "Copied" }) as HTMLButtonElement;
    const copiedClick = reactHandler<CopyClick>(copiedButton, "onClick");
    act(() => {
      idleClick(copyClickEvent(copiedButton));
      copiedClick(copyClickEvent(connectedButton("Copied")));
    });
    expect(copyText).toHaveBeenCalledTimes(1);

    act(() => copiedClick(copyClickEvent(copiedButton)));
    expect(copyText).toHaveBeenNthCalledWith(2, readerUrl());
  });

  it("retires document A before the parent layout boundary and ignores its late fallback settlement", async () => {
    const oldAttempt = deferred<boolean>();
    const currentAttempt = deferred<boolean>();
    copyText.mockReturnValueOnce(oldAttempt.promise).mockReturnValueOnce(currentAttempt.promise);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const select = vi.spyOn(HTMLInputElement.prototype, "select");
    const view = render(<ReaderBoundary />);
    const oldButton = await enabledCopyButton();
    const oldClick = reactHandler<CopyClick>(oldButton, "onClick");
    act(() => oldClick(copyClickEvent(oldButton)));
    let labelAtBoundary: string | null | undefined;
    let fallbackAtBoundary: Element | null | undefined;

    view.rerender(
      <ReaderBoundary
        docId={NEXT_DOC_ID}
        boundary={1}
        onLayout={() => {
          labelAtBoundary = copyElements().button.getAttribute("aria-label");
          fallbackAtBoundary = screen.queryByTestId("reader-copy-link-fallback");
        }}
      />,
    );
    const currentButton = await enabledCopyButton();
    const currentClick = reactHandler<CopyClick>(currentButton, "onClick");
    act(() => {
      oldClick(copyClickEvent(currentButton));
      currentClick(copyClickEvent(oldButton));
      currentClick(copyClickEvent(currentButton));
    });
    expect(labelAtBoundary).toBe("Copy link");
    expect(fallbackAtBoundary).toBeNull();
    expect(copyText).toHaveBeenNthCalledWith(2, readerUrl(NEXT_DOC_ID));

    await settle(oldAttempt, false);
    expectNoManualCopyGuidance();
    expect(focus).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();

    await settle(currentAttempt, false);
    const fallback = screen.getByRole<HTMLInputElement>("textbox", { name: "Reader link" });
    expect(fallback).toHaveValue(readerUrl(NEXT_DOC_ID));
    expect(fallback).toHaveAccessibleDescription(MANUAL_COPY_INSTRUCTION);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(fallback).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it.each(["root", "button", "fallback"] as const)(
    "retires an exact %s callback-ref replacement without letting late old refs clear the successor",
    async (part: CopyPart) => {
      const currentAttempt = deferred<boolean>();
      copyText.mockResolvedValueOnce(false).mockReturnValueOnce(currentAttempt.promise);
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const select = vi.spyOn(HTMLInputElement.prototype, "select");
      const view = createDirectView();
      fireEvent.click(await enabledCopyButton());
      await screen.findByRole("textbox", { name: "Reader link" });
      const previous = copyElements(true);
      const previousFallback = previous.fallback!;
      const element = part === "root"
        ? previous.root
        : part === "button"
          ? previous.button
          : previousFallback;
      const staleRef = reactRef(element);
      const staleClick = reactHandler<CopyClick>(previous.button, "onClick");
      const replacement = element.cloneNode(true) as typeof element;
      document.body.append(replacement);

      focus.mockClear();
      select.mockClear();
      act(() => {
        staleRef(replacement);
        staleClick(copyClickEvent(previous.button));
      });
      expect(copyText).toHaveBeenCalledTimes(1);
      expect(focus).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      replacement.remove();

      let fallbackValueAtBoundary: string | undefined;
      renderDirect(view.root, {
        boundary: 1,
        onLayout: () => {
          fallbackValueAtBoundary = copyElements(true).fallback?.value;
        },
      });
      const current = copyElements(true);
      const currentElement = part === "root"
        ? current.root
        : part === "button"
          ? current.button
          : current.fallback!;
      const currentClick = reactHandler<CopyClick>(current.button, "onClick");
      expect(fallbackValueAtBoundary).toBe(readerUrl());
      expect(focus).toHaveBeenCalledTimes(1);
      expect(select).toHaveBeenCalledTimes(1);

      focus.mockClear();
      select.mockClear();
      act(() => {
        staleRef(currentElement);
        staleRef(null);
        staleClick(copyClickEvent(current.button));
        currentClick(copyClickEvent(previous.button));
        currentClick(copyClickEvent(current.button));
      });
      expect(copyText).toHaveBeenCalledTimes(2);
      expect(focus).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
    },
  );

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "isolates an equal-looking remount, crossed handlers, and reused DOM in %s order",
    async (order) => {
      const attempt = deferred<boolean>();
      copyText.mockReturnValue(attempt.promise);
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const select = vi.spyOn(HTMLInputElement.prototype, "select");
      const view = createDirectView({ instance: "a" });
      const a = copyElements();
      await waitFor(() => expect(a.button).toBeEnabled());
      const aClick = reactHandler<CopyClick>(a.button, "onClick");
      const aRootRef = reactRef(a.root);
      const aButtonRef = reactRef(a.button);
      let oldConnectedAtBoundary: boolean | undefined;

      renderDirect(view.root, {
        instance: "b",
        boundary: 1,
        onLayout: () => {
          oldConnectedAtBoundary = a.button.isConnected;
        },
      });
      const b = copyElements();
      const bClick = reactHandler<CopyClick>(b.button, "onClick");
      expect(oldConnectedAtBoundary).toBe(false);
      expect(b.root).not.toBe(a.root);
      expect(b.button).not.toBe(a.button);

      act(() => {
        aRootRef(b.root);
        aButtonRef(b.button);
        aRootRef(null);
        aButtonRef(null);
        aClick(copyClickEvent(b.button));
        bClick(copyClickEvent(a.button));
      });
      expect(copyText).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();

      const activation = copyClickEvent(b.button);
      act(() => {
        if (order === "stale-before-current") aClick(activation);
        bClick(activation);
        if (order === "current-before-stale") aClick(activation);
        bClick(activation);
      });
      expect(copyText).toHaveBeenCalledExactlyOnceWith(readerUrl());
      expect(focus).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
    },
  );

  it("retires removal before parent layout and passive cleanup, then leaves a new document usable", async () => {
    const oldAttempt = deferred<boolean>();
    const currentAttempt = deferred<boolean>();
    copyText.mockReturnValueOnce(oldAttempt.promise).mockReturnValueOnce(currentAttempt.promise);
    const passiveCleanup = vi.fn();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const select = vi.spyOn(HTMLInputElement.prototype, "select");
    const view = createDirectStrictView({ onPassiveCleanup: passiveCleanup });
    const old = copyElements();
    await waitFor(() => expect(old.button).toBeEnabled());
    const initialPassiveCleanups = passiveCleanup.mock.calls.length;
    const oldClick = reactHandler<CopyClick>(old.button, "onClick");
    const oldRootRef = reactRef(old.root);
    act(() => oldClick(copyClickEvent(old.button)));
    let passiveCleanedAtBoundary: boolean | undefined;
    let oldConnectedAtBoundary: boolean | undefined;

    renderDirect(view.root, {
      present: false,
      boundary: 1,
      onLayout: () => {
        passiveCleanedAtBoundary =
          passiveCleanup.mock.calls.length > initialPassiveCleanups;
        oldConnectedAtBoundary = old.button.isConnected;
        oldClick(copyClickEvent(old.button));
      },
    });
    expect(passiveCleanedAtBoundary).toBe(false);
    expect(oldConnectedAtBoundary).toBe(false);
    expect(passiveCleanup).toHaveBeenCalledTimes(initialPassiveCleanups + 1);
    expect(copyText).toHaveBeenCalledTimes(1);

    act(() => {
      oldRootRef(old.root);
      oldRootRef(null);
      oldClick(copyClickEvent(old.button));
    });
    await settle(oldAttempt, false);
    expectNoManualCopyGuidance();
    expect(focus).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();

    renderDirectStrict(view.root, {
      docId: NEXT_DOC_ID,
      instance: "b",
      boundary: 2,
    });
    const current = copyElements();
    await waitFor(() => expect(current.button).toBeEnabled());
    act(() => reactHandler<CopyClick>(current.button, "onClick")(copyClickEvent(current.button)));
    expect(copyText).toHaveBeenNthCalledWith(2, readerUrl(NEXT_DOC_ID));
  });

  it("handles a rejected removed copy without an unhandled rejection", async () => {
    const oldAttempt = deferred<boolean>();
    copyText.mockReturnValue(oldAttempt.promise);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const view = render(<ReaderBoundary />);

    try {
      fireEvent.click(await enabledCopyButton());
      view.rerender(<ReaderBoundary present={false} boundary={1} />);
      await act(async () => {
        oldAttempt.reject(new Error("removed copy failed"));
        await Promise.resolve();
      });
      expect(unhandled).toEqual([]);
      expect(screen.queryByTestId("reader-copy-link-fallback")).not.toBeInTheDocument();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
