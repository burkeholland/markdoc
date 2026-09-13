// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  StrictMode,
  useLayoutEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as Y from "yjs";

// A CollabSession normally opens a WebSocket through Hocuspocus; stand in a provider that only
// supplies the awareness instance so the find model can drive the bar offline (as session-find.test.ts).
vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  class HocuspocusProvider {
    awareness: InstanceType<typeof Awareness>;
    constructor(opts: { document: Y.Doc }) {
      this.awareness = new Awareness(opts.document);
    }
    destroy() {
      this.awareness.destroy();
    }
  }
  return { HocuspocusProvider };
});

vi.mock("./find-keyboard-trust", async (importOriginal) => {
  const trust = await importOriginal<typeof import("./find-keyboard-trust")>();
  return {
    ...trust,
    readFindKeyboardFacts: (
      ...args: Parameters<typeof trust.readFindKeyboardFacts>
    ) => {
      const facts = trust.readFindKeyboardFacts(...args);
      const marker = Object.getOwnPropertyDescriptor(
        args[1],
        Symbol.for("markdoc.unit-trusted-find-key"),
      );
      return facts && marker?.value === true
        ? Object.freeze({ ...facts, isTrusted: true })
        : facts;
    },
  };
});

import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import { TooltipProvider } from "@/components/ui/primitives";
import { FindBar, type FindBarProps } from "./find-bar";

const TEXT = "The cat sat on the mat. The cat ran.";

function makeSession(role: "owner" | "viewer", docId = "doc"): CollabSession {
  const session = new CollabSession({ docId, user: makeCollabUser("a", "Alice"), role, getToken: async () => "token", autoConnect: false });
  session.ytext.insert(0, TEXT);
  session.setFind("cat");
  return session;
}

function renderBar(session: CollabSession, replaceVisible: boolean, onReplaceVisible = vi.fn()) {
  render(
    <TooltipProvider>
      <FindBar session={session} replaceVisible={replaceVisible} onReplaceVisible={onReplaceVisible} focusNonce={0} onReveal={() => {}} onClose={() => {}} />
    </TooltipProvider>,
  );
  return onReplaceVisible;
}

const sessions: CollabSession[] = [];
const directRoots = new Set<Root>();
const session = (role: "owner" | "viewer", docId?: string) => {
  const s = makeSession(role, docId);
  sessions.push(s);
  return s;
};

afterEach(() => {
  for (const root of directRoots) {
    act(() => root.unmount());
  }
  directRoots.clear();
  cleanup();
  while (sessions.length) sessions.pop()!.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function FindBoundary({
  session,
  present = true,
  replaceVisible,
  focusNonce = 0,
  boundary = 0,
  onBoundary,
  onReplaceVisible,
  onReveal,
  onClose,
}: {
  session: CollabSession;
  present?: boolean;
  replaceVisible: boolean;
  focusNonce?: number;
  boundary?: number;
  onBoundary?: () => void;
  onReplaceVisible: (visible: boolean) => void;
  onReveal: FindBarProps["onReveal"];
  onClose: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? (
    <TooltipProvider>
      <FindBar
        session={session}
        replaceVisible={replaceVisible}
        onReplaceVisible={onReplaceVisible}
        focusNonce={focusNonce}
        onReveal={onReveal}
        onClose={onClose}
      />
    </TooltipProvider>
  ) : null;
}

function LayoutCapture({
  capture,
  children,
}: {
  capture: () => void;
  children: ReactNode;
}) {
  useLayoutEffect(capture, [capture]);
  return children;
}

function frameEnvironment(reuseFrameId = false) {
  let nextFrame = 1;
  const pending = new Map<number, FrameRequestCallback>();
  const captured: { id: number; callback: FrameRequestCallback }[] = [];
  const request = vi.fn((callback: FrameRequestCallback) => {
    const id = reuseFrameId ? 1 : nextFrame++;
    pending.set(id, callback);
    captured.push({ id, callback });
    return id;
  });
  const cancel = vi.fn((id: number) => pending.delete(id));
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  const invoke = (owner: { id: number; callback: FrameRequestCallback }) => {
    pending.delete(owner.id);
    owner.callback(0);
  };
  const reset = () => {
    pending.clear();
    captured.length = 0;
    request.mockClear();
    cancel.mockClear();
  };
  return { pending, captured, request, cancel, invoke, reset };
}

function trackFocus() {
  const focused: string[] = [];
  const selected: string[] = [];
  const focus = HTMLElement.prototype.focus;
  const select = HTMLInputElement.prototype.select;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
    focused.push(this.dataset.testid ?? this.tagName);
    focus.call(this, options);
  });
  vi.spyOn(HTMLInputElement.prototype, "select").mockImplementation(function (this: HTMLInputElement) {
    selected.push(this.dataset.testid ?? this.tagName);
    select.call(this);
  });
  return { focused, selected };
}

function reactHandler<T extends (...args: never[]) => unknown>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return handler as T;
}

type ClickHandler = (event: { currentTarget: HTMLButtonElement; preventDefault: () => void }) => void;
type ChangeHandler = (event: { currentTarget: HTMLInputElement }) => void;
type MouseDownHandler = (event: { currentTarget: HTMLButtonElement; preventDefault: () => void }) => void;
type InputKeyHandler = (event: {
  currentTarget: HTMLInputElement;
  target: EventTarget;
  key: string;
  shiftKey: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}) => void;
type BarKeyHandler = (event: {
  currentTarget: HTMLDivElement;
  target: EventTarget;
  key: string;
  preventDefault: () => void;
  stopPropagation: () => void;
}) => void;
type ElementRef<T extends HTMLElement> = (element: T | null) => void;
type NativeBarKeyHandler = (event: ReactKeyboardEvent<HTMLDivElement>) => void;
type ReactProps = Record<string, unknown>;

function reactPropsEntry(element: HTMLElement) {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"));
  if (!key) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const record = element as unknown as Record<string, ReactProps>;
  const props = record[key];
  if (!props) throw new Error("React props were empty");
  return { key, record, props };
}

/** Replaces the whole published props object so a frozen development props record stays intact. */
function interceptReactProp<T extends (...args: never[]) => unknown>(
  element: HTMLElement,
  property: string,
  invoke: (current: T, ...args: Parameters<T>) => unknown,
) {
  const { key, record, props } = reactPropsEntry(element);
  const current = props[property];
  if (typeof current !== "function") throw new Error(`${property} was not published`);
  const intercepted: ReactProps = {
    ...props,
    [property]: (...args: Parameters<T>) => invoke(current as T, ...args),
  };
  record[key] = intercepted;
  return () => {
    if (record[key] === intercepted) record[key] = props;
  };
}

function reactRef<T extends HTMLElement>(element: T): ElementRef<T> {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey]
    : undefined;
  if (typeof props?.ref === "function") return props.ref as ElementRef<T>;
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error("React fiber was not attached to the FindBar element");
  const fiber = (element as unknown as Record<string, { ref?: unknown }>)[fiberKey];
  if (typeof fiber.ref !== "function") throw new Error("FindBar element does not have a callback ref");
  return fiber.ref as ElementRef<T>;
}

function clickActivation(currentTarget: HTMLButtonElement) {
  return { currentTarget, preventDefault: vi.fn() };
}

function inputKeyActivation(currentTarget: HTMLInputElement, key: string, shiftKey = false) {
  return {
    currentTarget,
    target: currentTarget,
    key,
    shiftKey,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

function keyboardEventView(ownerWindow: Window) {
  // Vitest proxies jsdom's global; Web IDL initialization needs its branded window.
  return (ownerWindow as Window & { _globalObject?: Window })._globalObject ??
    ownerWindow;
}

function findKey(target: HTMLElement, init: KeyboardEventInit = {}) {
  const ownerWindow = target.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The Find control has no owner window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "F3",
    code: "F3",
    view: keyboardEventView(ownerWindow),
    ...init,
  });
  Object.defineProperty(event, Symbol.for("markdoc.unit-trusted-find-key"), {
    value: true,
  });
  return event;
}

function dispatchFindKey(target: HTMLElement, init: KeyboardEventInit = {}) {
  const event = findKey(target, init);
  act(() => {
    target.focus();
    target.dispatchEvent(event);
  });
  return event;
}

function invokeChange(handler: ChangeHandler, currentTarget: HTMLInputElement, value: string) {
  const previous = currentTarget.value;
  currentTarget.value = value;
  handler({ currentTarget });
  currentTarget.value = previous;
}

function trackActionFocus() {
  const calls: { element: HTMLElement; options: FocusOptions | undefined }[] = [];
  const focus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    calls.push({ element: this, options });
    focus.call(this, options);
  });
  return {
    calls,
    reset: () => {
      calls.length = 0;
    },
    /** Only the navigation focus asks for `{ preventScroll: true }`; plain test focus does not. */
    moves: () => calls.filter(({ options }) => options !== undefined),
  };
}

describe("FindBar session ownership", () => {
  it("focuses once for a same-session nonce and again for a new session with the same nonce before the parent layout boundary", () => {
    const previous = session("owner", "focus-previous");
    const current = session("owner", "focus-current");
    const focus = trackFocus();
    const callbacks = { onReplaceVisible: vi.fn(), onReveal: vi.fn(), onClose: vi.fn() };
    const rendered = render(<FindBoundary session={previous} replaceVisible={false} focusNonce={0} {...callbacks} />);

    expect(focus.focused.filter((target) => target === "find-input")).toHaveLength(1);
    expect(focus.selected.filter((target) => target === "find-input")).toHaveLength(1);

    rendered.rerender(
      <FindBoundary
        session={previous}
        replaceVisible={false}
        focusNonce={1}
        boundary={1}
        onBoundary={() => expect(screen.getByTestId("find-input")).toHaveFocus()}
        {...callbacks}
      />,
    );
    expect(focus.focused.filter((target) => target === "find-input")).toHaveLength(2);
    expect(focus.selected.filter((target) => target === "find-input")).toHaveLength(2);

    rendered.rerender(
      <FindBoundary
        session={current}
        replaceVisible={false}
        focusNonce={1}
        boundary={2}
        onBoundary={() => expect(screen.getByTestId("find-input")).toHaveFocus()}
        {...callbacks}
      />,
    );
    expect(focus.focused.filter((target) => target === "find-input")).toHaveLength(3);
    expect(focus.selected.filter((target) => target === "find-input")).toHaveLength(3);
  });

  it.each(["retired-before-current", "current-before-retired"] as const)(
    "retires a replacement frame and actions at the session layout boundary (%s)",
    async (order) => {
      const frames = frameEnvironment();
      const focus = trackFocus();
      const previous = session("owner", `replace-previous-${order}`);
      const current = session("owner", `replace-current-${order}`);
      const previousSetFind = vi.spyOn(previous, "setFind");
      const previousStep = vi.spyOn(previous, "stepFind");
      const previousReplaceOne = vi.spyOn(previous, "replaceActive");
      const previousReplaceAll = vi.spyOn(previous, "replaceAll");
      const currentSetFind = vi.spyOn(current, "setFind");
      const currentStep = vi.spyOn(current, "stepFind");
      const currentReplaceOne = vi.spyOn(current, "replaceActive");
      const currentReplaceAll = vi.spyOn(current, "replaceAll");
      const callbacks = { onReplaceVisible: vi.fn(), onReveal: vi.fn(), onClose: vi.fn() };
      const rendered = render(<FindBoundary session={previous} replaceVisible={false} {...callbacks} />);
      frames.reset();
      const retiredOpenElement = screen.getByTestId("find-toggle-replace") as HTMLButtonElement;
      const retiredOpen = reactHandler<ClickHandler>(retiredOpenElement, "onClick");

      act(() => retiredOpen(clickActivation(retiredOpenElement)));
      expect(frames.pending.size).toBe(0);
      rendered.rerender(<FindBoundary session={previous} replaceVisible {...callbacks} />);
      const retiredFrame = frames.captured[0];
      expect(frames.pending.has(retiredFrame.id)).toBe(true);
      fireEvent.change(screen.getByTestId("replace-input"), { target: { value: "previous draft" } });
      expect(screen.getByTestId("replace-input")).toHaveValue("previous draft");

      const retiredReplacementInput = screen.getByTestId("replace-input") as HTMLInputElement;
      const retiredQueryInput = screen.getByTestId("find-input") as HTMLInputElement;
      const retiredNextElement = screen.getByTestId("find-next") as HTMLButtonElement;
      const retiredReplaceOneElement = screen.getByTestId("replace-one") as HTMLButtonElement;
      const retiredReplaceAllElement = screen.getByTestId("replace-all") as HTMLButtonElement;
      const retiredCloseElement = screen.getByTestId("find-close") as HTMLButtonElement;
      const retiredActions = {
        replacementChange: reactHandler<ChangeHandler>(retiredReplacementInput, "onChange"),
        queryChange: reactHandler<ChangeHandler>(retiredQueryInput, "onChange"),
        next: reactHandler<ClickHandler>(retiredNextElement, "onClick"),
        replaceOne: reactHandler<ClickHandler>(retiredReplaceOneElement, "onClick"),
        replaceAll: reactHandler<ClickHandler>(retiredReplaceAllElement, "onClick"),
        close: reactHandler<ClickHandler>(retiredCloseElement, "onClick"),
      };
      callbacks.onReplaceVisible.mockClear();
      callbacks.onReveal.mockClear();
      callbacks.onClose.mockClear();
      let retiredPendingAtBoundary = true;

      rendered.rerender(
        <FindBoundary
          session={current}
          replaceVisible
          boundary={1}
          onBoundary={() => {
            retiredPendingAtBoundary = frames.pending.has(retiredFrame.id);
            expect(screen.getByTestId("replace-input")).toHaveValue("");
            expect(screen.getByTestId("find-input")).toHaveFocus();
          }}
          {...callbacks}
        />,
      );

      expect(retiredPendingAtBoundary).toBe(false);
      expect(frames.cancel).toHaveBeenCalledWith(retiredFrame.id);
      act(() => {
        frames.invoke(retiredFrame);
        retiredOpen(clickActivation(retiredOpenElement));
        invokeChange(retiredActions.replacementChange, retiredReplacementInput, "late previous draft");
        invokeChange(retiredActions.queryChange, retiredQueryInput, "dog");
        retiredActions.next(clickActivation(retiredNextElement));
        retiredActions.replaceOne(clickActivation(retiredReplaceOneElement));
        retiredActions.replaceAll(clickActivation(retiredReplaceAllElement));
        retiredActions.close(clickActivation(retiredCloseElement));
      });

      expect(screen.getByTestId("replace-input")).toHaveValue("");
      expect(screen.getByTestId("find-input")).toHaveFocus();
      expect(focus.focused.filter((target) => target === "replace-input")).toHaveLength(0);
      expect(frames.pending.has(retiredFrame.id)).toBe(false);
      expect(callbacks.onReplaceVisible).not.toHaveBeenCalled();
      expect(callbacks.onReveal).not.toHaveBeenCalled();
      expect(callbacks.onClose).not.toHaveBeenCalled();
      expect(previousSetFind).not.toHaveBeenCalled();
      expect(previousStep).not.toHaveBeenCalled();
      expect(previousReplaceOne).not.toHaveBeenCalled();
      expect(previousReplaceAll).not.toHaveBeenCalled();
      expect(currentSetFind).not.toHaveBeenCalled();
      expect(currentStep).not.toHaveBeenCalled();
      expect(currentReplaceOne).not.toHaveBeenCalled();
      expect(currentReplaceAll).not.toHaveBeenCalled();
      expect(current.ytext.toString()).toBe(TEXT);

      rendered.rerender(<FindBoundary session={current} replaceVisible={false} {...callbacks} />);
      const currentOpenElement = screen.getByTestId("find-toggle-replace") as HTMLButtonElement;
      const currentOpen = reactHandler<ClickHandler>(currentOpenElement, "onClick");
      act(() => currentOpen(clickActivation(currentOpenElement)));
      expect(frames.pending.size).toBe(0);
      rendered.rerender(<FindBoundary session={current} replaceVisible {...callbacks} />);
      const currentFrame = frames.captured.at(-1);
      if (!currentFrame || currentFrame === retiredFrame) throw new Error("The current replace focus frame was not scheduled");
      expect(frames.pending.has(currentFrame.id)).toBe(true);

      act(() => {
        for (const frame of order === "retired-before-current"
          ? [retiredFrame, currentFrame]
          : [currentFrame, retiredFrame]) {
          frames.invoke(frame);
        }
        frames.invoke(currentFrame);
      });

      expect(frames.pending.has(retiredFrame.id)).toBe(false);
      expect(frames.pending.has(currentFrame.id)).toBe(false);
      expect(screen.getByTestId("replace-input")).toHaveFocus();
      expect(focus.focused.filter((target) => target === "replace-input")).toHaveLength(1);
      fireEvent.change(screen.getByTestId("replace-input"), { target: { value: "dog" } });
      fireEvent.click(screen.getByTestId("replace-one"));
      expect(currentReplaceOne).toHaveBeenCalledOnce();
      expect(currentReplaceOne).toHaveBeenCalledWith("dog");
      await waitFor(() => expect(screen.getByTestId("find-count")).toHaveTextContent("1 of 1"));
      fireEvent.change(screen.getByTestId("replace-input"), { target: { value: "fox" } });
      await waitFor(() => expect(screen.getByTestId("replace-input")).toHaveValue("fox"));
      fireEvent.click(screen.getByTestId("replace-all"));
      expect(currentReplaceAll).toHaveBeenCalledOnce();
      expect(currentReplaceAll).toHaveBeenCalledWith("fox");
      expect(current.ytext.toString()).toBe("The dog sat on the mat. The fox ran.");
    },
  );

  it("cancels and retires replacement work before the parent removal layout boundary", () => {
    const frames = frameEnvironment();
    const focus = trackFocus();
    const removed = session("owner", "replace-removed");
    const setFind = vi.spyOn(removed, "setFind");
    const step = vi.spyOn(removed, "stepFind");
    const replaceOne = vi.spyOn(removed, "replaceActive");
    const replaceAll = vi.spyOn(removed, "replaceAll");
    const callbacks = { onReplaceVisible: vi.fn(), onReveal: vi.fn(), onClose: vi.fn() };
    const rendered = render(<FindBoundary session={removed} replaceVisible={false} {...callbacks} />);
    frames.reset();
    const retiredOpenElement = screen.getByTestId("find-toggle-replace") as HTMLButtonElement;
    const retiredOpen = reactHandler<ClickHandler>(retiredOpenElement, "onClick");

    act(() => retiredOpen(clickActivation(retiredOpenElement)));
    expect(frames.pending.size).toBe(0);
    rendered.rerender(<FindBoundary session={removed} replaceVisible {...callbacks} />);
    const retiredFrame = frames.captured[0];
    expect(frames.pending.has(retiredFrame.id)).toBe(true);
    fireEvent.change(screen.getByTestId("replace-input"), { target: { value: "removed draft" } });
    const retiredQueryInput = screen.getByTestId("find-input") as HTMLInputElement;
    const retiredNextElement = screen.getByTestId("find-next") as HTMLButtonElement;
    const retiredReplaceOneElement = screen.getByTestId("replace-one") as HTMLButtonElement;
    const retiredReplaceAllElement = screen.getByTestId("replace-all") as HTMLButtonElement;
    const retiredCloseElement = screen.getByTestId("find-close") as HTMLButtonElement;
    const retiredActions = {
      queryChange: reactHandler<ChangeHandler>(retiredQueryInput, "onChange"),
      next: reactHandler<ClickHandler>(retiredNextElement, "onClick"),
      replaceOne: reactHandler<ClickHandler>(retiredReplaceOneElement, "onClick"),
      replaceAll: reactHandler<ClickHandler>(retiredReplaceAllElement, "onClick"),
      close: reactHandler<ClickHandler>(retiredCloseElement, "onClick"),
    };
    callbacks.onReplaceVisible.mockClear();
    let retiredPendingAtBoundary = true;

    rendered.rerender(
      <FindBoundary
        session={removed}
        present={false}
        replaceVisible
        boundary={1}
        onBoundary={() => {
          retiredPendingAtBoundary = frames.pending.has(retiredFrame.id);
        }}
        {...callbacks}
      />,
    );

    expect(retiredPendingAtBoundary).toBe(false);
    expect(frames.cancel).toHaveBeenCalledWith(retiredFrame.id);
    act(() => {
      frames.invoke(retiredFrame);
      retiredOpen(clickActivation(retiredOpenElement));
      invokeChange(retiredActions.queryChange, retiredQueryInput, "dog");
      retiredActions.next(clickActivation(retiredNextElement));
      retiredActions.replaceOne(clickActivation(retiredReplaceOneElement));
      retiredActions.replaceAll(clickActivation(retiredReplaceAllElement));
      retiredActions.close(clickActivation(retiredCloseElement));
    });

    expect(screen.queryByTestId("find-bar")).toBeNull();
    expect(focus.focused.filter((target) => target === "replace-input")).toHaveLength(0);
    expect(frames.pending.has(retiredFrame.id)).toBe(false);
    expect(callbacks.onReplaceVisible).not.toHaveBeenCalled();
    expect(callbacks.onReveal).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(setFind).not.toHaveBeenCalled();
    expect(step).not.toHaveBeenCalled();
    expect(replaceOne).not.toHaveBeenCalled();
    expect(replaceAll).not.toHaveBeenCalled();
    expect(removed.ytext.toString()).toBe(TEXT);
  });
});

const CONTROL_CASES = [
  ["find-match-case", "setFind"],
  ["find-whole-word", "setFind"],
  ["find-regex", "setFind"],
  ["find-prev", "stepFind"],
  ["find-next", "stepFind"],
  ["find-toggle-replace", "onReplaceVisible"],
  ["find-close", "onClose"],
  ["replace-one", "replaceActive"],
  ["replace-all", "replaceAll"],
] as const;

describe("FindBar exact publication controls", () => {
  it("keeps all control families exact through direct-root Strict Mode replay", async () => {
    const s = session("owner", "strict-control-families");
    const setFind = vi.spyOn(s, "setFind");
    const stepFind = vi.spyOn(s, "stepFind");
    const replaceActive = vi.spyOn(s, "replaceActive");
    const replaceAll = vi.spyOn(s, "replaceAll");
    const callbacksA = { onReplaceVisible: vi.fn(), onReveal: vi.fn(), onClose: vi.fn() };
    const callbacksB = { onReplaceVisible: vi.fn(), onReveal: vi.fn(), onClose: vi.fn() };
    const focus = trackFocus();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    directRoots.add(root);
    const controlIds = [
      "find-match-case",
      "find-whole-word",
      "find-regex",
      "find-prev",
      "find-next",
      "find-toggle-replace",
      "find-close",
      "replace-one",
      "replace-all",
    ] as const;
    const element = <T extends HTMLElement>(testId: string) => {
      const match = host.querySelector(`[data-testid="${testId}"]`);
      if (!(match instanceof HTMLElement)) throw new Error(`Missing ${testId}`);
      return match as T;
    };
    const capture = () => {
      const bar = element<HTMLDivElement>("find-bar");
      const search = element<HTMLInputElement>("find-input");
      const replace = element<HTMLInputElement>("replace-input");
      const controls = Object.fromEntries(controlIds.map((id) => {
        const button = element<HTMLButtonElement>(id);
        return [id, {
          element: button,
          click: reactHandler<ClickHandler>(button, "onClick"),
        }];
      })) as Record<typeof controlIds[number], {
        element: HTMLButtonElement;
        click: ClickHandler;
      }>;
      const nodes: HTMLElement[] = [
        bar,
        search,
        replace,
        ...controlIds.map((id) => controls[id].element),
      ];
      return {
        bar,
        search,
        replace,
        searchChange: reactHandler<ChangeHandler>(search, "onChange"),
        replaceChange: reactHandler<ChangeHandler>(replace, "onChange"),
        controls,
        nodes,
        refs: nodes.map((node) => reactRef(node)),
      };
    };
    const strictCaptures: ReturnType<typeof capture>[] = [];
    const captureStrictLayout = () => {
      strictCaptures.push(capture());
    };
    const renderVisit = (
      key: string,
      callbacks: typeof callbacksA,
      captureReplay = false,
    ) => (
      <StrictMode>
        <TooltipProvider>
          <LayoutCapture capture={captureReplay ? captureStrictLayout : () => {}}>
            <section key={key}>
              <FindBar
                session={s}
                replaceVisible
                focusNonce={0}
                {...callbacks}
              />
            </section>
          </LayoutCapture>
        </TooltipProvider>
      </StrictMode>
    );

    act(() => root.render(renderVisit("A", callbacksA, true)));
    const strictRetired = strictCaptures[0];
    if (!strictRetired) throw new Error("Strict Mode did not run the first layout setup");
    const replayed = capture();
    expect(replayed.bar).toBe(strictRetired.bar);
    expect(replayed.searchChange).not.toBe(strictRetired.searchChange);
    expect(replayed.replaceChange).not.toBe(strictRetired.replaceChange);
    expect(replayed.refs[0]).not.toBe(strictRetired.refs[0]);
    act(() => {
      strictRetired.refs.forEach((ref, index) => ref(replayed.nodes[index] ?? null));
      [...strictRetired.refs].reverse().forEach((ref) => ref(null));
      invokeChange(strictRetired.searchChange, replayed.search, "mat");
      invokeChange(strictRetired.replaceChange, replayed.replace, "dog");
      for (const id of controlIds) {
        strictRetired.controls[id].click(clickActivation(replayed.controls[id].element));
      }
    });
    expect(setFind).not.toHaveBeenCalled();
    expect(stepFind).not.toHaveBeenCalled();
    expect(replaceActive).not.toHaveBeenCalled();
    expect(replaceAll).not.toHaveBeenCalled();
    expect(callbacksA.onReplaceVisible).not.toHaveBeenCalled();
    expect(callbacksA.onReveal).not.toHaveBeenCalled();
    expect(callbacksA.onClose).not.toHaveBeenCalled();
    expect(replayed.search).toHaveFocus();

    const stale = replayed;
    act(() => root.render(renderVisit("B", callbacksB)));
    const current = capture();
    expect(current.bar).not.toBe(stale.bar);
    expect(current.searchChange).not.toBe(stale.searchChange);
    expect(current.replaceChange).not.toBe(stale.replaceChange);
    expect(focus.focused.filter((target) => target === "find-input")).toHaveLength(2);
    expect(focus.selected.filter((target) => target === "find-input")).toHaveLength(2);

    act(() => {
      stale.refs.forEach((ref, index) => ref(current.nodes[index] ?? null));
      [...stale.refs].reverse().forEach((ref) => ref(null));
      current.refs.forEach((ref, index) => ref(stale.nodes[index] ?? null));
      invokeChange(stale.searchChange, current.search, "mat");
      invokeChange(stale.replaceChange, current.replace, "dog");
      invokeChange(current.searchChange, stale.search, "mat");
      invokeChange(current.replaceChange, stale.replace, "dog");
      for (const id of controlIds) {
        stale.controls[id].click(clickActivation(current.controls[id].element));
        current.controls[id].click(clickActivation(stale.controls[id].element));
      }
    });
    expect(setFind).not.toHaveBeenCalled();
    expect(stepFind).not.toHaveBeenCalled();
    expect(replaceActive).not.toHaveBeenCalled();
    expect(replaceAll).not.toHaveBeenCalled();
    expect(callbacksA.onReplaceVisible).not.toHaveBeenCalled();
    expect(callbacksA.onReveal).not.toHaveBeenCalled();
    expect(callbacksA.onClose).not.toHaveBeenCalled();
    expect(callbacksB.onReplaceVisible).not.toHaveBeenCalled();
    expect(callbacksB.onReveal).not.toHaveBeenCalled();
    expect(callbacksB.onClose).not.toHaveBeenCalled();
    expect(s.ytext.toString()).toBe(TEXT);
    expect(current.search).toHaveFocus();

    const clickCurrentOnce = (testId: typeof controlIds[number]) => {
      const button = element<HTMLButtonElement>(testId);
      const click = reactHandler<ClickHandler>(button, "onClick");
      const event = clickActivation(button);
      act(() => {
        click(event);
        click(event);
      });
    };
    clickCurrentOnce("find-match-case");
    await act(async () => {});
    expect(setFind).toHaveBeenCalledOnce();

    const searchInput = element<HTMLInputElement>("find-input");
    const searchChange = reactHandler<ChangeHandler>(searchInput, "onChange");
    const searchEvent = { currentTarget: searchInput };
    searchInput.value = "cat";
    act(() => {
      searchChange(searchEvent);
      searchChange(searchEvent);
    });
    await act(async () => {});
    expect(setFind).toHaveBeenCalledTimes(2);

    const replacementInput = element<HTMLInputElement>("replace-input");
    const replacementChange = reactHandler<ChangeHandler>(replacementInput, "onChange");
    const replacementEvent = { currentTarget: replacementInput };
    replacementInput.value = "dog";
    act(() => {
      replacementChange(replacementEvent);
      replacementChange(replacementEvent);
    });
    await act(async () => {});
    expect(element<HTMLInputElement>("replace-input")).toHaveValue("dog");

    clickCurrentOnce("find-next");
    await act(async () => {});
    expect(stepFind).toHaveBeenCalledOnce();
    clickCurrentOnce("find-toggle-replace");
    expect(callbacksB.onReplaceVisible).toHaveBeenCalledOnce();
    expect(callbacksB.onReplaceVisible).toHaveBeenCalledWith(false);
    clickCurrentOnce("replace-one");
    await act(async () => {});
    expect(replaceActive).toHaveBeenCalledOnce();
    expect(replaceActive).toHaveBeenCalledWith("dog");
    clickCurrentOnce("replace-all");
    await act(async () => {});
    expect(replaceAll).toHaveBeenCalledOnce();
    expect(replaceAll).toHaveBeenCalledWith("dog");
    expect(s.ytext.toString()).toBe("The dog sat on the mat. The dog ran.");
    clickCurrentOnce("find-close");
    expect(callbacksB.onClose).toHaveBeenCalledOnce();
    await act(async () => {});
  });

  it("publishes current callback facts after Strict Mode overtakes replay authority", async () => {
    const s = session("owner", "strict-callback-change");
    const stepFind = vi.spyOn(s, "stepFind");
    const retiredReveal = vi.fn();
    const currentReveal = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    directRoots.add(root);
    function CallbackChange() {
      const [onReveal, setOnReveal] = useState(() => retiredReveal);
      useLayoutEffect(() => {
        setOnReveal(() => currentReveal);
      }, []);
      return (
        <FindBar
          session={s}
          replaceVisible={false}
          onReplaceVisible={vi.fn()}
          focusNonce={0}
          onReveal={onReveal}
          onClose={vi.fn()}
        />
      );
    }

    act(() => {
      root.render(
        <StrictMode>
          <TooltipProvider>
            <CallbackChange />
          </TooltipProvider>
        </StrictMode>,
      );
    });
    await act(async () => {});
    const next = host.querySelector('[data-testid="find-next"]');
    if (!(next instanceof HTMLButtonElement)) throw new Error("Missing current Next control");
    fireEvent.click(next);
    expect(stepFind).toHaveBeenCalledOnce();
    expect(retiredReveal).not.toHaveBeenCalled();
    expect(currentReveal).toHaveBeenCalledOnce();
  });

  it("rejects Strict Mode replay after the committed bar is reparented", () => {
    const s = session("owner", "strict-reparent");
    const stepFind = vi.spyOn(s, "stepFind");
    const onReveal = vi.fn();
    const host = document.createElement("div");
    const foreign = document.createElement("div");
    document.body.append(host, foreign);
    const root = createRoot(host);
    directRoots.add(root);
    function ReparentOnLayout() {
      useLayoutEffect(() => {
        const bar =
          host.querySelector('[data-testid="find-bar"]') ??
          foreign.querySelector('[data-testid="find-bar"]');
        if (!(bar instanceof HTMLDivElement)) throw new Error("Missing FindBar root");
        if (bar.parentNode !== foreign) foreign.append(bar);
      }, []);
      return (
        <section>
          <FindBar
            session={s}
            replaceVisible={false}
            onReplaceVisible={vi.fn()}
            focusNonce={0}
            onReveal={onReveal}
            onClose={vi.fn()}
          />
        </section>
      );
    }

    act(() => {
      root.render(
        <StrictMode>
          <TooltipProvider>
            <ReparentOnLayout />
          </TooltipProvider>
        </StrictMode>,
      );
    });
    const bar = foreign.querySelector('[data-testid="find-bar"]');
    const next = foreign.querySelector('[data-testid="find-next"]');
    if (!(bar instanceof HTMLDivElement) || !(next instanceof HTMLButtonElement)) {
      throw new Error("FindBar was not reparented");
    }
    reactHandler<ClickHandler>(next, "onClick")(clickActivation(next));
    expect(stepFind).not.toHaveBeenCalled();
    expect(onReveal).not.toHaveBeenCalled();

    const section = host.querySelector("section");
    if (!(section instanceof HTMLElement)) throw new Error("Missing original FindBar parent");
    section.append(bar);
    foreign.remove();
  });

  it.each(CONTROL_CASES.flatMap(([testId, destination]) =>
    (["wrong-before-current", "current-before-wrong"] as const).map((order) => [testId, destination, order] as const)
  ))("binds %s only to its exact connected element (%s, %s)", (testId, destination, order) => {
    const s = session("owner", `control-${testId}-${order}`);
    const setFind = vi.spyOn(s, "setFind");
    const stepFind = vi.spyOn(s, "stepFind");
    const replaceActive = vi.spyOn(s, "replaceActive");
    const replaceAll = vi.spyOn(s, "replaceAll");
    const callbacks = {
      onReplaceVisible: vi.fn(),
      onReveal: vi.fn(),
      onClose: vi.fn(),
    };
    render(<FindBoundary session={s} replaceVisible {...callbacks} />);

    const element = screen.getByTestId(testId) as HTMLButtonElement;
    const handler = reactHandler<ClickHandler>(element, "onClick");
    const other = screen.getByTestId(testId === "find-close" ? "find-next" : "find-close") as HTMLButtonElement;
    const foreign = document.createElement("button");
    document.body.append(foreign);
    const replacement = document.createElement("button");
    screen.getByTestId("find-bar").append(replacement);
    const detached = document.createElement("button");
    const count = () => {
      switch (destination) {
        case "setFind":
          return setFind.mock.calls.length;
        case "stepFind":
          return stepFind.mock.calls.length;
        case "replaceActive":
          return replaceActive.mock.calls.length;
        case "replaceAll":
          return replaceAll.mock.calls.length;
        case "onReplaceVisible":
          return callbacks.onReplaceVisible.mock.calls.length;
        case "onClose":
          return callbacks.onClose.mock.calls.length;
      }
    };

    act(() => {
      handler(clickActivation(other));
      handler(clickActivation(foreign));
      handler(clickActivation(replacement));
      handler(clickActivation(detached));
    });
    expect(count()).toBe(0);

    const activation = clickActivation(order === "wrong-before-current" ? other : element);
    act(() => {
      handler(activation);
      activation.currentTarget = order === "wrong-before-current" ? element : other;
      handler(activation);
      activation.currentTarget = element;
      handler(activation);
    });
    expect(count()).toBe(1);

    foreign.remove();
    replacement.remove();
  });

  it("prevents mouse down only for each exact current focus-preserving control", () => {
    const s = session("owner", "mouse-down-controls");
    const callbacks = { onReplaceVisible: vi.fn(), onReveal: vi.fn(), onClose: vi.fn() };
    render(<FindBoundary session={s} replaceVisible {...callbacks} />);
    const ids = [
      "find-match-case",
      "find-whole-word",
      "find-regex",
      "find-prev",
      "find-next",
      "find-toggle-replace",
    ];

    for (const testId of ids) {
      const element = screen.getByTestId(testId) as HTMLButtonElement;
      const wrong = screen.getByTestId(testId === "find-next" ? "find-prev" : "find-next") as HTMLButtonElement;
      const handler = reactHandler<MouseDownHandler>(element, "onMouseDown");
      const event = clickActivation(wrong);
      act(() => {
        handler(event);
        event.currentTarget = element;
        handler(event);
        handler(event);
      });
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
  });

  it.each(["find", "options", "editability", "visibility"] as const)(
    "retires a same-session %s publication before a reused current DOM can act",
    async (boundary) => {
      const s = session("owner", `same-session-${boundary}`);
      const stepFind = vi.spyOn(s, "stepFind");
      const callbacks = { onReplaceVisible: vi.fn(), onReveal: vi.fn(), onClose: vi.fn() };
      const rendered = render(<FindBoundary session={s} replaceVisible {...callbacks} />);
      const staleElement = screen.getByTestId("find-next") as HTMLButtonElement;
      const staleHandler = reactHandler<ClickHandler>(staleElement, "onClick");

      if (boundary === "find") {
        act(() => s.setFind("cat", s.find?.options));
      } else if (boundary === "options") {
        act(() => s.setFind("cat", { ...s.find!.options }));
      } else if (boundary === "editability") {
        act(() => s.setMode("viewing"));
      } else {
        rendered.rerender(<FindBoundary session={s} replaceVisible={false} {...callbacks} />);
      }
      await waitFor(() => {
        const handler = reactHandler<ClickHandler>(screen.getByTestId("find-next"), "onClick");
        expect(handler).not.toBe(staleHandler);
      });
      stepFind.mockClear();
      callbacks.onReveal.mockClear();

      const currentElement = screen.getByTestId("find-next") as HTMLButtonElement;
      expect(currentElement).toBe(staleElement);
      act(() => staleHandler(clickActivation(staleElement)));
      expect(stepFind).not.toHaveBeenCalled();
      expect(callbacks.onReveal).not.toHaveBeenCalled();

      fireEvent.click(currentElement);
      expect(stepFind).toHaveBeenCalledOnce();
      expect(callbacks.onReveal).toHaveBeenCalledOnce();
    },
  );

  it("retires changed callbacks before the parent layout boundary and routes B to B", () => {
    const s = session("owner", "callback-boundary");
    const stepFind = vi.spyOn(s, "stepFind");
    const callbacksA = { onReplaceVisible: vi.fn(), onReveal: vi.fn(), onClose: vi.fn() };
    const callbacksB = { onReplaceVisible: vi.fn(), onReveal: vi.fn(), onClose: vi.fn() };
    const rendered = render(<FindBoundary session={s} replaceVisible={false} {...callbacksA} />);
    const staleElement = screen.getByTestId("find-next") as HTMLButtonElement;
    const staleHandler = reactHandler<ClickHandler>(staleElement, "onClick");

    rendered.rerender(
      <FindBoundary
        session={s}
        replaceVisible={false}
        boundary={1}
        onBoundary={() => staleHandler(clickActivation(staleElement))}
        {...callbacksB}
      />,
    );
    expect(stepFind).not.toHaveBeenCalled();
    expect(callbacksA.onReveal).not.toHaveBeenCalled();
    expect(callbacksB.onReveal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("find-next"));
    expect(stepFind).toHaveBeenCalledOnce();
    expect(callbacksA.onReveal).not.toHaveBeenCalled();
    expect(callbacksB.onReveal).toHaveBeenCalledOnce();
  });

  it("claims an accepted activation once across the publication it creates", async () => {
    const s = session("owner", "activation-publication");
    const stepFind = vi.spyOn(s, "stepFind");
    render(
      <FindBoundary
        session={s}
        replaceVisible={false}
        onReplaceVisible={vi.fn()}
        onReveal={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const element = screen.getByTestId("find-next") as HTMLButtonElement;
    const handlerA = reactHandler<ClickHandler>(element, "onClick");
    const activation = clickActivation(element);
    handlerA(activation);
    expect(stepFind).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(reactHandler<ClickHandler>(element, "onClick")).not.toBe(handlerA);
    });

    const handlerB = reactHandler<ClickHandler>(element, "onClick");
    handlerB(activation);
    expect(stepFind).toHaveBeenCalledOnce();
    handlerB(clickActivation(element));
    expect(stepFind).toHaveBeenCalledTimes(2);
  });

  it("retires an equal-looking remount while reused callback functions remain current", async () => {
    const s = session("owner", "equal-remount");
    const setFind = vi.spyOn(s, "setFind");
    const stepFind = vi.spyOn(s, "stepFind");
    const callbacks = { onReplaceVisible: vi.fn(), onReveal: vi.fn(), onClose: vi.fn() };
    const rendered = render(<FindBoundary key="A" session={s} replaceVisible {...callbacks} />);
    const staleSearch = screen.getByTestId("find-input") as HTMLInputElement;
    const staleNext = screen.getByTestId("find-next") as HTMLButtonElement;
    const staleSearchHandler = reactHandler<ChangeHandler>(staleSearch, "onChange");
    const staleNextHandler = reactHandler<ClickHandler>(staleNext, "onClick");

    rendered.rerender(<FindBoundary key="B" session={s} replaceVisible {...callbacks} />);
    expect(staleSearch.isConnected).toBe(false);
    expect(staleNext.isConnected).toBe(false);
    setFind.mockClear();
    stepFind.mockClear();
    invokeChange(staleSearchHandler, staleSearch, "mat");
    staleNextHandler(clickActivation(staleNext));
    expect(setFind).not.toHaveBeenCalled();
    expect(stepFind).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("find-next"));
    expect(stepFind).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByTestId("find-count")).toHaveTextContent("2 of 2"));
    fireEvent.change(screen.getByTestId("find-input"), { target: { value: "mat" } });
    expect(setFind).toHaveBeenCalledOnce();
  });

  it("uses the exact session methods and represented replacement captured by an accepted publication", () => {
    const s = session("owner", "frozen-methods");
    const returnedStep = { from: 10, to: 13 };
    const returnedReplace = { from: 20, to: 23 };
    const exactStep = vi.fn(() => returnedStep);
    const exactReplace = vi.fn(() => returnedReplace);
    const exactReplaceAll = vi.fn(() => 2);
    s.stepFind = exactStep;
    s.replaceActive = exactReplace;
    s.replaceAll = exactReplaceAll;
    const onReveal = vi.fn();
    render(
      <FindBoundary
        session={s}
        replaceVisible
        onReplaceVisible={vi.fn()}
        onReveal={onReveal}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("replace-input"), { target: { value: "$1 exact" } });

    const next = screen.getByTestId("find-next") as HTMLButtonElement;
    const replaceOne = screen.getByTestId("replace-one") as HTMLButtonElement;
    const replaceAll = screen.getByTestId("replace-all") as HTMLButtonElement;
    const nextHandler = reactHandler<ClickHandler>(next, "onClick");
    const replaceOneHandler = reactHandler<ClickHandler>(replaceOne, "onClick");
    const replaceAllHandler = reactHandler<ClickHandler>(replaceAll, "onClick");
    const laterStep = vi.fn();
    const laterReplace = vi.fn();
    const laterReplaceAll = vi.fn();
    s.stepFind = laterStep;
    s.replaceActive = laterReplace;
    s.replaceAll = laterReplaceAll;
    (screen.getByTestId("replace-input") as HTMLInputElement).value = "later DOM value";

    const nextEvent = clickActivation(next);
    act(() => {
      nextHandler(nextEvent);
      nextHandler(nextEvent);
      replaceOneHandler(clickActivation(replaceOne));
      replaceAllHandler(clickActivation(replaceAll));
    });
    expect(exactStep).toHaveBeenCalledOnce();
    expect(exactStep).toHaveBeenCalledWith(1);
    expect(exactReplace).toHaveBeenCalledOnce();
    expect(exactReplace).toHaveBeenCalledWith("$1 exact");
    expect(exactReplaceAll).toHaveBeenCalledOnce();
    expect(exactReplaceAll).toHaveBeenCalledWith("$1 exact");
    expect(laterStep).not.toHaveBeenCalled();
    expect(laterReplace).not.toHaveBeenCalled();
    expect(laterReplaceAll).not.toHaveBeenCalled();
    expect(onReveal.mock.calls.map(([match]) => match)).toEqual([returnedStep, returnedReplace]);
  });

  it("publishes exact query and option snapshots and reveals only that update's active match", () => {
    const s = session("owner", "option-snapshots");
    const setFind = vi.spyOn(s, "setFind");
    const onReveal = vi.fn();
    render(
      <FindBoundary
        session={s}
        replaceVisible={false}
        onReplaceVisible={vi.fn()}
        onReveal={onReveal}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("find-match-case"));
    expect(setFind).toHaveBeenCalledOnce();
    expect(setFind.mock.calls[0]?.[0]).toBe("cat");
    expect(setFind.mock.calls[0]?.[1]).toEqual({
      matchCase: true,
      wholeWord: false,
      regex: false,
    });
    expect(onReveal).toHaveBeenCalledOnce();
    expect(onReveal).toHaveBeenCalledWith(s.find?.matches[s.find.active]);
  });

  it("keeps no-match click controls disabled without suppressing exact keyboard semantics", () => {
    const s = session("owner", "no-matches");
    s.setFind("missing");
    const stepFind = vi.spyOn(s, "stepFind");
    const replaceActive = vi.spyOn(s, "replaceActive");
    const replaceAll = vi.spyOn(s, "replaceAll");
    const onReveal = vi.fn();
    render(
      <FindBoundary
        session={s}
        replaceVisible
        onReplaceVisible={vi.fn()}
        onReveal={onReveal}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId("find-count")).toHaveTextContent("0 of 0");
    for (const testId of ["find-prev", "find-next", "replace-one", "replace-all"]) {
      const element = screen.getByTestId(testId) as HTMLButtonElement;
      expect(element).toBeDisabled();
      reactHandler<ClickHandler>(element, "onClick")(clickActivation(element));
    }
    expect(stepFind).not.toHaveBeenCalled();
    expect(replaceActive).not.toHaveBeenCalled();
    expect(replaceAll).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByTestId("find-input"), { key: "Enter" });
    fireEvent.keyDown(screen.getByTestId("replace-input"), { key: "Enter" });
    expect(stepFind).toHaveBeenCalledOnce();
    expect(replaceActive).toHaveBeenCalledOnce();
    expect(onReveal).not.toHaveBeenCalled();
  });
});

describe("FindBar exact publication inputs", () => {
  it.each((["search", "replace"] as const).flatMap((input) =>
    (["wrong-before-current", "current-before-wrong"] as const).map((order) => [input, order] as const)
  ))("binds %s change to its exact current input (%s)", async (input, order) => {
    const s = session("owner", `input-${input}-${order}`);
    const representedOptions = s.find!.options;
    const setFind = vi.spyOn(s, "setFind");
    render(
      <FindBoundary
        session={s}
        replaceVisible
        onReplaceVisible={vi.fn()}
        onReveal={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const testId = input === "search" ? "find-input" : "replace-input";
    const element = screen.getByTestId(testId) as HTMLInputElement;
    const handler = reactHandler<ChangeHandler>(element, "onChange");
    const foreign = document.createElement("input");
    const foreignReads = vi.fn(() => "foreign");
    Object.defineProperty(foreign, "value", { configurable: true, get: foreignReads });
    document.body.append(foreign);
    const replacement = document.createElement("input");
    const replacementReads = vi.fn(() => "replacement");
    Object.defineProperty(replacement, "value", { configurable: true, get: replacementReads });
    screen.getByTestId("find-bar").append(replacement);
    const detached = document.createElement("input");

    act(() => {
      handler({ currentTarget: foreign });
      handler({ currentTarget: replacement });
      handler({ currentTarget: detached });
      handler({ currentTarget: screen.getByTestId(input === "search" ? "replace-input" : "find-input") as HTMLInputElement });
    });
    expect(foreignReads).not.toHaveBeenCalled();
    expect(replacementReads).not.toHaveBeenCalled();
    expect(setFind).not.toHaveBeenCalled();
    if (input === "replace") expect(element).toHaveValue("");

    element.value = input === "search" ? "mat" : "dog";
    const activation = {
      currentTarget: order === "wrong-before-current" ? foreign : element,
    };
    act(() => {
      handler(activation);
      activation.currentTarget = order === "wrong-before-current" ? element : foreign;
      handler(activation);
      activation.currentTarget = element;
      handler(activation);
    });
    if (input === "search") {
      expect(setFind).toHaveBeenCalledOnce();
      expect(setFind.mock.calls[0]?.[0]).toBe("mat");
      expect(setFind.mock.calls[0]?.[1]).toBe(representedOptions);
      await waitFor(() => expect(screen.getByTestId("find-input")).toHaveValue("mat"));
      fireEvent.change(screen.getByTestId("find-input"), { target: { value: "cat" } });
      expect(setFind).toHaveBeenCalledTimes(2);
    } else {
      expect(screen.getByTestId("replace-input")).toHaveValue("dog");
      fireEvent.change(screen.getByTestId("replace-input"), { target: { value: "fox" } });
      expect(screen.getByTestId("replace-input")).toHaveValue("fox");
      expect(setFind).not.toHaveBeenCalled();
    }

    foreign.remove();
    replacement.remove();
  });

  it.each([
    ["search", "Enter", false, "step", 1],
    ["search", "Enter", true, "step", -1],
    ["replace", "Enter", false, "replace", 0],
    ["replace", "Enter", true, "step", -1],
  ] as const)("isolates %s %s with shift=%s and invokes only the exact result destination", (input, key, shiftKey, destination, direction) => {
    const s = session("owner", `key-${input}-${shiftKey}`);
    const returned = { from: 4, to: 7 };
    const stepFind = vi.spyOn(s, "stepFind").mockReturnValue(returned);
    const replaceActive = vi.spyOn(s, "replaceActive").mockReturnValue(returned);
    const onReveal = vi.fn();
    render(
      <FindBoundary
        session={s}
        replaceVisible
        onReplaceVisible={vi.fn()}
        onReveal={onReveal}
        onClose={vi.fn()}
      />,
    );
    const testId = input === "search" ? "find-input" : "replace-input";
    const element = screen.getByTestId(testId) as HTMLInputElement;
    const handler = reactHandler<InputKeyHandler>(element, "onKeyDown");
    const foreign = document.createElement("input");
    document.body.append(foreign);
    const event = inputKeyActivation(foreign, key, shiftKey);

    act(() => {
      handler(event);
      event.currentTarget = element;
      event.target = element;
      handler(event);
      handler(event);
    });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    if (destination === "step") {
      expect(stepFind).toHaveBeenCalledOnce();
      expect(stepFind).toHaveBeenCalledWith(direction);
      expect(replaceActive).not.toHaveBeenCalled();
    } else {
      expect(replaceActive).toHaveBeenCalledOnce();
      expect(stepFind).not.toHaveBeenCalled();
    }
    expect(onReveal).toHaveBeenCalledOnce();
    expect(onReveal).toHaveBeenCalledWith(returned);
    foreign.remove();
  });

  it.each(["search", "replace"] as const)("closes Escape only from the exact %s input publication", (input) => {
    const s = session("owner", `escape-${input}`);
    const onClose = vi.fn();
    render(
      <FindBoundary
        session={s}
        replaceVisible
        onReplaceVisible={vi.fn()}
        onReveal={vi.fn()}
        onClose={onClose}
      />,
    );
    const testId = input === "search" ? "find-input" : "replace-input";
    const element = screen.getByTestId(testId) as HTMLInputElement;
    const handler = reactHandler<InputKeyHandler>(element, "onKeyDown");
    const foreign = document.createElement("input");
    document.body.append(foreign);
    const event = inputKeyActivation(foreign, "Escape");

    handler(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    event.currentTarget = element;
    event.target = element;
    handler(event);
    handler(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    foreign.remove();
  });

  it("closes Escape from the exact bar but ignores a foreign target and a wrong bar", () => {
    const s = session("owner", "escape-bar");
    const onClose = vi.fn();
    render(
      <FindBoundary
        session={s}
        replaceVisible
        onReplaceVisible={vi.fn()}
        onReveal={vi.fn()}
        onClose={onClose}
      />,
    );
    const bar = screen.getByTestId("find-bar") as HTMLDivElement;
    const handler = reactHandler<BarKeyHandler>(bar, "onKeyDown");
    const foreignBar = document.createElement("div");
    const foreignTarget = document.createElement("button");
    document.body.append(foreignBar, foreignTarget);
    const wrongBar = {
      currentTarget: foreignBar,
      target: foreignTarget,
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    handler(wrongBar);
    expect(onClose).not.toHaveBeenCalled();
    const wrongTarget = { ...wrongBar, currentTarget: bar };
    handler(wrongTarget);
    expect(onClose).not.toHaveBeenCalled();

    const exact = {
      currentTarget: bar,
      target: screen.getByTestId("find-next"),
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    handler(exact);
    handler(exact);
    expect(exact.preventDefault).toHaveBeenCalledOnce();
    expect(exact.stopPropagation).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    foreignBar.remove();
    foreignTarget.remove();
  });
});

describe("FindBar F3 navigation", () => {
  function renderStrictBar(
    s: CollabSession,
    callbacks: {
      onReplaceVisible: FindBarProps["onReplaceVisible"];
      onReveal: FindBarProps["onReveal"];
      onClose: FindBarProps["onClose"];
    },
    key = "current",
  ) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    directRoots.add(root);
    act(() => {
      root.render(
        <StrictMode>
          <TooltipProvider>
            <FindBar
              key={key}
              session={s}
              replaceVisible
              focusNonce={0}
              {...callbacks}
            />
          </TooltipProvider>
        </StrictMode>,
      );
    });
    return { host, root };
  }

  const navigationCases = [
    ["find-input", false, 1],
    ["find-input", true, -1],
    ["replace-input", false, 1],
    ["replace-input", true, -1],
    ["find-match-case", false, 1],
    ["find-match-case", true, -1],
  ] as const;

  it.each(navigationCases)(
    "steps the current Strict Mode result from %s with shift=%s and preserves the current control",
    async (testId, shiftKey, direction) => {
      const s = session("owner", `f3-${testId}-${shiftKey}`);
      const stepFind = vi.spyOn(s, "stepFind");
      const replaceActive = vi.spyOn(s, "replaceActive");
      const replaceAll = vi.spyOn(s, "replaceAll");
      const setFind = vi.spyOn(s, "setFind");
      const callbacks = {
        onReplaceVisible: vi.fn(),
        onReveal: vi.fn(),
        onClose: vi.fn(),
      };
      renderStrictBar(s, callbacks);
      await act(async () => {});
      const target = screen.getByTestId(testId) as HTMLElement;
      const search = screen.getByTestId("find-input") as HTMLInputElement;
      const replacement = screen.getByTestId("replace-input") as HTMLInputElement;
      fireEvent.change(replacement, { target: { value: "unchanged replacement" } });
      await act(async () => {});
      const optionPressed = target.getAttribute("aria-pressed");
      const expected = direction === 1 ? s.find!.matches[1] : s.find!.matches.at(-1);

      const event = dispatchFindKey(target, { shiftKey });

      expect(event.defaultPrevented).toBe(true);
      expect(stepFind).toHaveBeenCalledOnce();
      expect(stepFind).toHaveBeenCalledWith(direction);
      expect(callbacks.onReveal).toHaveBeenCalledOnce();
      expect(callbacks.onReveal).toHaveBeenCalledWith(expected);
      expect(replaceActive).not.toHaveBeenCalled();
      expect(replaceAll).not.toHaveBeenCalled();
      expect(setFind).not.toHaveBeenCalled();
      expect(callbacks.onReplaceVisible).not.toHaveBeenCalled();
      expect(callbacks.onClose).not.toHaveBeenCalled();
      expect(search).toHaveValue("cat");
      expect(replacement).toHaveValue("unchanged replacement");
      expect(target.getAttribute("aria-pressed")).toBe(optionPressed);
      expect(target).toHaveFocus();
    },
  );

  it.each([
    ["no matches", false],
    ["invalid regular expression", true],
  ] as const)("claims F3 with %s without stepping or revealing", async (_label, invalid) => {
    const s = session("owner", `f3-empty-${invalid}`);
    if (invalid) {
      s.setFind("(", { matchCase: false, wholeWord: false, regex: true });
    } else {
      s.setFind("missing");
    }
    const stepFind = vi.spyOn(s, "stepFind");
    const onReveal = vi.fn();
    renderStrictBar(s, {
      onReplaceVisible: vi.fn(),
      onReveal,
      onClose: vi.fn(),
    });
    await act(async () => {});

    const event = dispatchFindKey(screen.getByTestId("find-input"));

    expect(event.defaultPrevented).toBe(true);
    expect(stepFind).not.toHaveBeenCalled();
    expect(onReveal).not.toHaveBeenCalled();
  });

  it("rejects modified, composing, canceled, fabricated, foreign, and outside deliveries without poisoning a fresh key", async () => {
    const s = session("owner", "f3-provenance");
    const stepFind = vi.spyOn(s, "stepFind");
    const onReveal = vi.fn();
    renderStrictBar(s, {
      onReplaceVisible: vi.fn(),
      onReveal,
      onClose: vi.fn(),
    });
    await act(async () => {});
    const bar = screen.getByTestId("find-bar") as HTMLDivElement;
    const input = screen.getByTestId("find-input") as HTMLInputElement;
    const handler = reactHandler<NativeBarKeyHandler>(bar, "onKeyDown");

    const rejected = [
      dispatchFindKey(input, { ctrlKey: true }),
      dispatchFindKey(input, { altKey: true }),
      dispatchFindKey(input, { metaKey: true }),
      dispatchFindKey(input, { isComposing: true }),
    ];
    expect(rejected.every((event) => !event.defaultPrevented)).toBe(true);

    const canceled = findKey(input);
    input.addEventListener("keydown", (event) => event.preventDefault(), {
      capture: true,
      once: true,
    });
    act(() => input.dispatchEvent(canceled));
    expect(canceled.defaultPrevented).toBe(true);

    const outside = document.createElement("button");
    document.body.append(outside);
    const outsideEvent = dispatchFindKey(outside);
    expect(outsideEvent.defaultPrevented).toBe(false);

    const frame = document.createElement("iframe");
    document.body.append(frame);
    const foreignDocument = frame.contentDocument;
    const ForeignKeyboardEvent = foreignDocument?.defaultView?.KeyboardEvent;
    if (!foreignDocument || !ForeignKeyboardEvent) {
      throw new Error("The foreign document was not created");
    }
    const foreign = foreignDocument.createElement("input");
    foreignDocument.body.append(foreign);
    const foreignEvent = new ForeignKeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "F3",
    });
    act(() => {
      foreign.focus();
      foreign.dispatchEvent(foreignEvent);
    });
    expect(foreignEvent.defaultPrevented).toBe(false);

    const fabricatedNative = findKey(input);
    const preventDefault = vi.fn();
    act(() => handler({
      _reactName: "onKeyDown",
      type: "keydown",
      key: "F3",
      code: "",
      location: 0,
      repeat: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      eventPhase: 0,
      isTrusted: false,
      timeStamp: fabricatedNative.timeStamp,
      currentTarget: bar,
      target: input,
      nativeEvent: fabricatedNative,
      preventDefault,
      stopPropagation: vi.fn(),
      isDefaultPrevented: () => false,
      isPropagationStopped: () => false,
      isPersistent: () => true,
      persist: vi.fn(),
    } as unknown as ReactKeyboardEvent<HTMLDivElement>));
    expect(preventDefault).not.toHaveBeenCalled();
    expect(fabricatedNative.defaultPrevented).toBe(false);
    expect(stepFind).not.toHaveBeenCalled();
    expect(onReveal).not.toHaveBeenCalled();

    const accepted = dispatchFindKey(input);
    expect(accepted.defaultPrevented).toBe(true);
    expect(stepFind).toHaveBeenCalledOnce();
    expect(onReveal).toHaveBeenCalledOnce();
    outside.remove();
    frame.remove();
  });

  it.each(["cancel", "change authority"] as const)(
    "does not let a target-capture wrapper consume proof before descendants %s",
    async (interruption) => {
      const s = session("owner", `f3-early-wrapper-${interruption}`);
      const stepFind = vi.spyOn(s, "stepFind");
      const onReveal = vi.fn();
      renderStrictBar(s, {
        onReplaceVisible: vi.fn(),
        onReveal,
        onClose: vi.fn(),
      });
      await act(async () => {});
      const bar = screen.getByTestId("find-bar") as HTMLDivElement;
      const input = screen.getByTestId("find-input") as HTMLInputElement;
      const handler = reactHandler<NativeBarKeyHandler>(bar, "onKeyDown");
      let preventedByEarlyInvocation: boolean | null = null;
      input.addEventListener("keydown", (nativeEvent) => {
        handler({ nativeEvent } as ReactKeyboardEvent<HTMLDivElement>);
        preventedByEarlyInvocation = nativeEvent.defaultPrevented;
        if (interruption === "cancel") {
          nativeEvent.preventDefault();
          nativeEvent.stopPropagation();
        } else {
          s.setFind("mat");
        }
      }, { capture: true, once: true });

      const interrupted = dispatchFindKey(input);

      expect(preventedByEarlyInvocation).toBe(false);
      expect(interrupted.defaultPrevented).toBe(interruption === "cancel");
      expect(stepFind).not.toHaveBeenCalled();
      expect(onReveal).not.toHaveBeenCalled();
      if (interruption === "change authority") {
        await waitFor(() => expect(input).toHaveValue("mat"));
      }
    },
  );

  it("fails closed when the owner realm KeyboardEvent binding is replaced after publication", async () => {
    const s = session("owner", "f3-replaced-constructor");
    const stepFind = vi.spyOn(s, "stepFind");
    const onReveal = vi.fn();
    renderStrictBar(s, {
      onReplaceVisible: vi.fn(),
      onReveal,
      onClose: vi.fn(),
    });
    await act(async () => {});
    const input = screen.getByTestId("find-input") as HTMLInputElement;
    const ownerWindow = input.ownerDocument.defaultView;
    const descriptor = ownerWindow &&
      Object.getOwnPropertyDescriptor(ownerWindow, "KeyboardEvent");
    if (!ownerWindow || !descriptor) {
      throw new Error("The owner realm KeyboardEvent binding is unavailable");
    }
    input.focus();
    const rejected = findKey(input);
    const original = ownerWindow.KeyboardEvent;
    if (
      !Reflect.set(ownerWindow, "KeyboardEvent", null) ||
      ownerWindow.KeyboardEvent !== null
    ) {
      throw new Error("The owner realm KeyboardEvent binding was not replaced");
    }
    try {
      act(() => input.dispatchEvent(rejected));
    } finally {
      Reflect.set(ownerWindow, "KeyboardEvent", original);
    }

    expect(rejected.defaultPrevented).toBe(false);
    expect(stepFind).not.toHaveBeenCalled();
    expect(onReveal).not.toHaveBeenCalled();

    const fresh = dispatchFindKey(input);
    expect(fresh.defaultPrevented).toBe(true);
    expect(stepFind).toHaveBeenCalledOnce();
    expect(onReveal).toHaveBeenCalledOnce();
  });

  it("rejects non-F3 intrinsic facts even when public keyboard fields imitate F3", async () => {
    const s = session("owner", "f3-shadowed-facts");
    const stepFind = vi.spyOn(s, "stepFind");
    const onReveal = vi.fn();
    renderStrictBar(s, {
      onReplaceVisible: vi.fn(),
      onReveal,
      onClose: vi.fn(),
    });
    await act(async () => {});
    const input = screen.getByTestId("find-input") as HTMLInputElement;
    const event = findKey(input, { key: "F4", ctrlKey: true });
    Object.defineProperties(event, {
      key: { value: "F3" },
      ctrlKey: { value: false },
      shiftKey: { value: false },
    });

    act(() => {
      input.focus();
      input.dispatchEvent(event);
    });

    expect(event.key).toBe("F3");
    expect(event.ctrlKey).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(stepFind).not.toHaveBeenCalled();
    expect(onReveal).not.toHaveBeenCalled();
  });

  it("rejects genuine auto-repeat and contradictory-code F3 deliveries", async () => {
    const s = session("owner", "f3-repeat-facts");
    const stepFind = vi.spyOn(s, "stepFind");
    const onReveal = vi.fn();
    renderStrictBar(s, {
      onReplaceVisible: vi.fn(),
      onReveal,
      onClose: vi.fn(),
    });
    await act(async () => {});
    const input = screen.getByTestId("find-input") as HTMLInputElement;

    const repeated = dispatchFindKey(input, { repeat: true });
    const contradictory = dispatchFindKey(input, { code: "F4" });

    expect(repeated.defaultPrevented).toBe(false);
    expect(contradictory.defaultPrevented).toBe(false);
    expect(stepFind).not.toHaveBeenCalled();
    expect(onReveal).not.toHaveBeenCalled();
  });

  it("rejects a foreign-realm F3 grafted onto the owner KeyboardEvent prototype", async () => {
    const s = session("owner", "f3-grafted-realm");
    const stepFind = vi.spyOn(s, "stepFind");
    const onReveal = vi.fn();
    renderStrictBar(s, {
      onReplaceVisible: vi.fn(),
      onReveal,
      onClose: vi.fn(),
    });
    await act(async () => {});
    const input = screen.getByTestId("find-input") as HTMLInputElement;
    const ownerWindow = input.ownerDocument.defaultView;
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const foreignWindow = frame.contentWindow;
    if (!ownerWindow || !foreignWindow) {
      throw new Error("The owner and foreign realms are required");
    }
    const ForeignKeyboardEvent =
      (foreignWindow as Window & typeof globalThis).KeyboardEvent;
    const event = new ForeignKeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "F3",
      code: "F3",
      view: keyboardEventView(ownerWindow),
    });
    Object.setPrototypeOf(event, ownerWindow.KeyboardEvent.prototype);

    act(() => {
      input.focus();
      input.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(stepFind).not.toHaveBeenCalled();
    expect(onReveal).not.toHaveBeenCalled();
    frame.remove();
  });

  it("rejects a key getter altered before publication and trusts only a complete fresh publication", async () => {
    const ownerWindow = document.defaultView as
      | (Window & typeof globalThis)
      | null;
    const keyDescriptor = ownerWindow &&
      Object.getOwnPropertyDescriptor(ownerWindow.KeyboardEvent.prototype, "key");
    if (!ownerWindow || !keyDescriptor || typeof keyDescriptor.get !== "function") {
      throw new Error("The owner realm key getter is unavailable");
    }
    const rejectedSession = session("owner", "f3-poisoned-getter");
    const rejectedStep = vi.spyOn(rejectedSession, "stepFind");
    const rejectedReveal = vi.fn();
    let rejectedRender: ReturnType<typeof renderStrictBar> | null = null;
    Object.defineProperty(ownerWindow.KeyboardEvent.prototype, "key", {
      ...keyDescriptor,
      get: () => "F3",
    });
    try {
      rejectedRender = renderStrictBar(rejectedSession, {
        onReplaceVisible: vi.fn(),
        onReveal: rejectedReveal,
        onClose: vi.fn(),
      });
      await act(async () => {});
      const input = screen.getByTestId("find-input") as HTMLInputElement;
      const event = findKey(input, { key: "F4", code: "F4" });
      expect(event.key).toBe("F3");

      act(() => {
        input.focus();
        input.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(false);
      expect(rejectedStep).not.toHaveBeenCalled();
      expect(rejectedReveal).not.toHaveBeenCalled();
    } finally {
      if (rejectedRender) {
        act(() => rejectedRender?.root.unmount());
        directRoots.delete(rejectedRender.root);
        rejectedRender.host.remove();
      }
      Object.defineProperty(
        ownerWindow.KeyboardEvent.prototype,
        "key",
        keyDescriptor,
      );
    }

    const freshSession = session("owner", "f3-restored-getter");
    const freshStep = vi.spyOn(freshSession, "stepFind");
    const freshReveal = vi.fn();
    renderStrictBar(freshSession, {
      onReplaceVisible: vi.fn(),
      onReveal: freshReveal,
      onClose: vi.fn(),
    });
    await act(async () => {});
    const fresh = dispatchFindKey(screen.getByTestId("find-input"));

    expect(fresh.defaultPrevented).toBe(true);
    expect(freshStep).toHaveBeenCalledOnce();
    expect(freshReveal).toHaveBeenCalledOnce();
  });

  it("rejects authority changed between native capture and terminal delivery, then admits a fresh publication", async () => {
    const s = session("owner", "f3-capture-delivery-drift");
    const stepFind = vi.spyOn(s, "stepFind");
    const onReveal = vi.fn();
    renderStrictBar(s, {
      onReplaceVisible: vi.fn(),
      onReveal,
      onClose: vi.fn(),
    });
    await act(async () => {});
    const input = screen.getByTestId("find-input") as HTMLInputElement;
    input.addEventListener("keydown", () => {
      s.setFind("mat");
    }, { capture: true, once: true });

    const stale = dispatchFindKey(input);

    expect(stale.defaultPrevented).toBe(false);
    expect(stepFind).not.toHaveBeenCalled();
    expect(onReveal).not.toHaveBeenCalled();

    await waitFor(() => expect(input).toHaveValue("mat"));
    const fresh = dispatchFindKey(input);
    expect(fresh.defaultPrevented).toBe(true);
    expect(stepFind).toHaveBeenCalledOnce();
    expect(onReveal).toHaveBeenCalledOnce();
  });

  it("uses captured keyboard getters and composedPath when public fields throw or deceive", async () => {
    const s = session("owner", "f3-intrinsic-fields");
    const stepFind = vi.spyOn(s, "stepFind");
    const onReveal = vi.fn();
    renderStrictBar(s, {
      onReplaceVisible: vi.fn(),
      onReveal,
      onClose: vi.fn(),
    });
    await act(async () => {});
    const input = screen.getByTestId("find-input") as HTMLInputElement;
    const event = findKey(input, { shiftKey: true });
    Object.defineProperties(event, {
      key: { value: "F4" },
      shiftKey: { value: false },
      composedPath: {
        value: () => {
          throw new Error("public composedPath must not be called");
        },
      },
    });

    act(() => {
      input.focus();
      input.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(stepFind).toHaveBeenCalledOnce();
    expect(stepFind).toHaveBeenCalledWith(-1);
    expect(onReveal).toHaveBeenCalledOnce();
  });

  it("claims one native delivery once across repeated delivery and accepts a fresh successor event", async () => {
    const s = session("owner", "f3-repeat");
    const stepFind = vi.spyOn(s, "stepFind");
    const onReveal = vi.fn();
    renderStrictBar(s, {
      onReplaceVisible: vi.fn(),
      onReveal,
      onClose: vi.fn(),
    });
    await act(async () => {});
    const input = screen.getByTestId("find-input") as HTMLInputElement;
    const repeated = findKey(input);
    act(() => {
      input.focus();
      input.dispatchEvent(repeated);
      input.dispatchEvent(repeated);
    });

    expect(repeated.defaultPrevented).toBe(true);
    expect(stepFind).toHaveBeenCalledOnce();
    expect(onReveal).toHaveBeenCalledOnce();

    await act(async () => {});
    const fresh = dispatchFindKey(screen.getByTestId("find-input"));
    expect(fresh.defaultPrevented).toBe(true);
    expect(stepFind).toHaveBeenCalledTimes(2);
    expect(onReveal).toHaveBeenCalledTimes(2);
  });

  it.each(["attribute restore", "detach and restore"] as const)(
    "retires %s history, rejects the restored DOM, and admits a fresh successor",
    async (scenario) => {
      const s = session("owner", `f3-${scenario.replaceAll(" ", "-")}`);
      const stepFind = vi.spyOn(s, "stepFind");
      const onReveal = vi.fn();
      renderStrictBar(s, {
        onReplaceVisible: vi.fn(),
        onReveal,
        onClose: vi.fn(),
      });
      await act(async () => {});
      const bar = screen.getByTestId("find-bar") as HTMLDivElement;
      const input = screen.getByTestId("find-input") as HTMLInputElement;
      const staleHandler = reactHandler<NativeBarKeyHandler>(bar, "onKeyDown");
      input.focus();

      if (scenario === "attribute restore") {
        bar.setAttribute("data-history", "changed");
        bar.removeAttribute("data-history");
      } else {
        const parent = bar.parentNode;
        const next = bar.nextSibling;
        if (!parent) throw new Error("FindBar has no committed parent");
        bar.remove();
        const detached = findKey(input);
        act(() => input.dispatchEvent(detached));
        expect(detached.defaultPrevented).toBe(false);
        parent.insertBefore(bar, next);
      }
      const restored = findKey(input);
      act(() => input.dispatchEvent(restored));
      expect(restored.defaultPrevented).toBe(false);
      expect(stepFind).not.toHaveBeenCalled();
      expect(onReveal).not.toHaveBeenCalled();

      await waitFor(() => {
        expect(reactHandler<NativeBarKeyHandler>(bar, "onKeyDown")).not.toBe(staleHandler);
      });
      const fresh = dispatchFindKey(input);
      expect(fresh.defaultPrevented).toBe(true);
      expect(stepFind).toHaveBeenCalledOnce();
      expect(onReveal).toHaveBeenCalledOnce();
    },
  );

  it("rejects a partial ref replay and a stale generation before a fresh keyed successor", async () => {
    const s = session("owner", "f3-partial-replay");
    const stepFind = vi.spyOn(s, "stepFind");
    const staleReveal = vi.fn();
    const currentReveal = vi.fn();
    const callbacks = {
      onReplaceVisible: vi.fn(),
      onReveal: staleReveal,
      onClose: vi.fn(),
    };
    const direct = renderStrictBar(s, callbacks, "stale");
    await act(async () => {});
    const staleBar = direct.host.querySelector('[data-testid="find-bar"]') as HTMLDivElement;
    const staleInput = direct.host.querySelector('[data-testid="find-input"]') as HTMLInputElement;
    const staleHandler = reactHandler<NativeBarKeyHandler>(staleBar, "onKeyDown");
    const barRef = reactRef(staleBar);
    act(() => {
      barRef(null);
      barRef(staleBar);
    });
    const replayed = dispatchFindKey(staleInput);
    expect(replayed.defaultPrevented).toBe(false);
    expect(stepFind).not.toHaveBeenCalled();

    act(() => {
      direct.root.render(
        <StrictMode>
          <TooltipProvider>
            <FindBar
              key="current"
              session={s}
              replaceVisible
              focusNonce={0}
              onReplaceVisible={callbacks.onReplaceVisible}
              onReveal={currentReveal}
              onClose={callbacks.onClose}
            />
          </TooltipProvider>
        </StrictMode>,
      );
    });
    await act(async () => {});
    const currentBar = direct.host.querySelector('[data-testid="find-bar"]') as HTMLDivElement;
    const currentInput = direct.host.querySelector('[data-testid="find-input"]') as HTMLInputElement;
    const staleNative = findKey(currentInput);
    act(() => staleHandler({
      currentTarget: currentBar,
      target: currentInput,
      key: "F3",
      nativeEvent: staleNative,
    } as unknown as ReactKeyboardEvent<HTMLDivElement>));
    expect(stepFind).not.toHaveBeenCalled();
    expect(staleReveal).not.toHaveBeenCalled();

    const fresh = dispatchFindKey(currentInput);
    expect(fresh.defaultPrevented).toBe(true);
    expect(stepFind).toHaveBeenCalledOnce();
    expect(staleReveal).not.toHaveBeenCalled();
    expect(currentReveal).toHaveBeenCalledOnce();
  });
});

describe("FindBar first-row action navigation", () => {
  type ActionCallbacks = {
    onReplaceVisible: FindBarProps["onReplaceVisible"];
    onReveal: FindBarProps["onReveal"];
    onClose: FindBarProps["onClose"];
  };

  function renderActionBar(
    s: CollabSession,
    callbacks: ActionCallbacks,
    {
      replaceVisible = true,
      key = "current",
      host: suppliedHost,
    }: {
      replaceVisible?: boolean;
      key?: string;
      host?: HTMLDivElement;
    } = {},
  ) {
    const host = suppliedHost ?? document.createElement("div");
    if (!host.isConnected) document.body.append(host);
    const root = createRoot(host);
    directRoots.add(root);
    act(() => {
      root.render(
        <StrictMode>
          <TooltipProvider>
            <FindBar
              key={key}
              session={s}
              replaceVisible={replaceVisible}
              focusNonce={0}
              {...callbacks}
            />
          </TooltipProvider>
        </StrictMode>,
      );
    });
    const element = <T extends HTMLElement>(testId: string) => {
      const match = host.querySelector(`[data-testid="${testId}"]`);
      if (!(match instanceof HTMLElement)) throw new Error(`Missing ${testId}`);
      return match as T;
    };
    const action = (testId: string) => element<HTMLButtonElement>(testId);
    return { host, root, element, action };
  }

  function silentCallbacks(): ActionCallbacks {
    return { onReplaceVisible: vi.fn(), onReveal: vi.fn(), onClose: vi.fn() };
  }

  function actionKey(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
    return findKey(target, { key, code: key, ...init });
  }

  function dispatchActionKey(
    target: HTMLElement,
    key: string,
    init: KeyboardEventInit = {},
  ) {
    const event = actionKey(target, key, init);
    act(() => {
      target.focus();
      target.dispatchEvent(event);
    });
    return event;
  }

  function dispatchExactKey(target: HTMLElement, event: KeyboardEvent, focus = true) {
    act(() => {
      if (focus) target.focus();
      target.dispatchEvent(event);
    });
    return event;
  }

  const NAVIGATION_CASES = [
    ["find-prev", "ArrowRight", "find-next"],
    ["find-prev", "ArrowDown", "find-next"],
    ["find-prev", "End", "find-close"],
    ["find-prev", "ArrowLeft", null],
    ["find-prev", "ArrowUp", null],
    ["find-prev", "Home", null],
    ["find-next", "ArrowLeft", "find-prev"],
    ["find-next", "ArrowUp", "find-prev"],
    ["find-next", "ArrowRight", "find-toggle-replace"],
    ["find-next", "ArrowDown", "find-toggle-replace"],
    ["find-next", "Home", "find-prev"],
    ["find-next", "End", "find-close"],
    ["find-toggle-replace", "ArrowLeft", "find-next"],
    ["find-toggle-replace", "ArrowUp", "find-next"],
    ["find-toggle-replace", "ArrowRight", "find-close"],
    ["find-toggle-replace", "ArrowDown", "find-close"],
    ["find-toggle-replace", "Home", "find-prev"],
    ["find-toggle-replace", "End", "find-close"],
    ["find-close", "ArrowLeft", "find-toggle-replace"],
    ["find-close", "ArrowUp", "find-toggle-replace"],
    ["find-close", "ArrowRight", null],
    ["find-close", "ArrowDown", null],
    ["find-close", "Home", "find-prev"],
    ["find-close", "End", null],
  ] as const;

  const NUMPAD_CASES = [
    ["ArrowLeft", "Numpad4", "find-next", "find-prev"],
    ["ArrowUp", "Numpad8", "find-next", "find-prev"],
    ["ArrowRight", "Numpad6", "find-prev", "find-next"],
    ["ArrowDown", "Numpad2", "find-prev", "find-next"],
    ["Home", "Numpad7", "find-close", "find-prev"],
    ["End", "Numpad1", "find-prev", "find-close"],
  ] as const;

  it("moves focus to the exact bounded destination for every accepted key from every current enabled action", async () => {
    const s = session("owner", "actions-matrix");
    const focus = trackActionFocus();
    const setFind = vi.spyOn(s, "setFind");
    const stepFind = vi.spyOn(s, "stepFind");
    const replaceActive = vi.spyOn(s, "replaceActive");
    const replaceAll = vi.spyOn(s, "replaceAll");
    const callbacks = silentCallbacks();
    const view = renderActionBar(s, callbacks);
    await act(async () => {});
    const counter = view.element("find-count").textContent;

    for (const [sourceId, key, destinationId] of NAVIGATION_CASES) {
      const source = view.action(sourceId);
      focus.reset();
      const event = dispatchActionKey(source, key);
      const moves = focus.moves();
      expect([sourceId, key, event.defaultPrevented]).toEqual([
        sourceId,
        key,
        destinationId !== null,
      ]);
      expect([sourceId, key, moves.length]).toEqual([
        sourceId,
        key,
        destinationId === null ? 0 : 1,
      ]);
      if (destinationId) {
        expect(moves[0]?.element).toBe(view.action(destinationId));
        expect(moves[0]?.options).toEqual({ preventScroll: true });
        expect(document.activeElement).toBe(view.action(destinationId));
      } else {
        expect(document.activeElement).toBe(source);
      }
      await act(async () => {});
    }

    expect(setFind).not.toHaveBeenCalled();
    expect(stepFind).not.toHaveBeenCalled();
    expect(replaceActive).not.toHaveBeenCalled();
    expect(replaceAll).not.toHaveBeenCalled();
    expect(callbacks.onReplaceVisible).not.toHaveBeenCalled();
    expect(callbacks.onReveal).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(view.element("find-count").textContent).toBe(counter);
    expect(s.ytext.toString()).toBe(TEXT);
  });

  it.each(NUMPAD_CASES)(
    "accepts semantic %s with an unrestricted %s code and numpad location",
    async (key, code, sourceId, destinationId) => {
      const s = session("owner", `actions-${code}`);
      const focus = trackActionFocus();
      const view = renderActionBar(s, silentCallbacks());
      await act(async () => {});
      const source = view.action(sourceId);
      focus.reset();

      const event = dispatchActionKey(source, key, { code, location: 3 });

      expect(event.code).toBe(code);
      expect(event.location).toBe(3);
      expect(event.defaultPrevented).toBe(true);
      expect(focus.moves()).toHaveLength(1);
      expect(document.activeElement).toBe(view.action(destinationId));
    },
  );

  it("prevents once through the public bubble wrapper and focuses once with prevent scroll", async () => {
    const s = session("owner", "actions-single-effect");
    const focus = trackActionFocus();
    const view = renderActionBar(s, silentCallbacks());
    await act(async () => {});
    const source = view.action("find-next");
    const prevented: { receiver: unknown; args: unknown[] }[] = [];
    const restore = interceptReactProp<(event: ReactKeyboardEvent<HTMLButtonElement>) => void>(
      source,
      "onKeyDown",
      (current, event) => {
        const original = event.preventDefault as (...args: unknown[]) => unknown;
        Object.defineProperty(event, "preventDefault", {
          configurable: true,
          writable: true,
          value: function (this: unknown, ...args: unknown[]) {
            prevented.push({ receiver: this, args });
            return original.apply(this, args);
          },
        });
        current(event);
        expect(event.isDefaultPrevented()).toBe(true);
        expect(event.isPropagationStopped()).toBe(false);
        expect(event.defaultPrevented).toBe(true);
        expect(event.nativeEvent.defaultPrevented).toBe(true);
      },
    );
    focus.reset();

    try {
      const event = dispatchActionKey(source, "ArrowRight");
      expect(event.defaultPrevented).toBe(true);
      expect(prevented).toHaveLength(1);
      expect(prevented[0]?.args).toEqual([]);
      expect(focus.moves()).toHaveLength(1);
      expect(focus.moves()[0]?.options).toEqual({ preventScroll: true });
      expect(document.activeElement).toBe(view.action("find-toggle-replace"));
    } finally {
      restore();
    }
  });

  it("performs no search, replacement, storage, timer, network, or scroll work before activation", async () => {
    const s = session("owner", "actions-zero-work");
    const frames = frameEnvironment();
    const focus = trackActionFocus();
    const fetchStub = vi.fn();
    const scrollTo = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    vi.stubGlobal("scrollTo", scrollTo);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const setFind = vi.spyOn(s, "setFind");
    const stepFind = vi.spyOn(s, "stepFind");
    const replaceActive = vi.spyOn(s, "replaceActive");
    const replaceAll = vi.spyOn(s, "replaceAll");
    const callbacks = silentCallbacks();
    const view = renderActionBar(s, callbacks);
    await act(async () => {});
    const bar = view.element<HTMLDivElement>("find-bar");
    const row = view.element<HTMLDivElement>("find-actions");
    const search = view.element<HTMLInputElement>("find-input");
    const replacement = view.element<HTMLInputElement>("replace-input");
    fireEvent.change(replacement, { target: { value: "kept replacement" } });
    await act(async () => {});
    const pressed = ["find-match-case", "find-whole-word", "find-regex"].map((testId) =>
      view.action(testId).getAttribute("aria-pressed"));
    frames.reset();
    focus.reset();

    const event = dispatchActionKey(view.action("find-prev"), "ArrowRight");

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.action("find-next"));
    expect(setFind).not.toHaveBeenCalled();
    expect(stepFind).not.toHaveBeenCalled();
    expect(replaceActive).not.toHaveBeenCalled();
    expect(replaceAll).not.toHaveBeenCalled();
    expect(callbacks.onReveal).not.toHaveBeenCalled();
    expect(callbacks.onReplaceVisible).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(frames.request).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(search).toHaveValue("cat");
    expect(replacement).toHaveValue("kept replacement");
    expect(["find-match-case", "find-whole-word", "find-regex"].map((testId) =>
      view.action(testId).getAttribute("aria-pressed"))).toEqual(pressed);
    expect(bar.scrollTop).toBe(0);
    expect(bar.scrollLeft).toBe(0);
    expect(row.scrollTop).toBe(0);
    expect(row.scrollLeft).toBe(0);
    expect(document.documentElement.scrollTop).toBe(0);
    expect(window.scrollX).toBe(0);
    expect(window.scrollY).toBe(0);
    expect(s.ytext.toString()).toBe(TEXT);
  });

  it("skips disabled Previous and Next and never wraps past the shortened group", async () => {
    const s = session("owner", "actions-disabled-steps");
    s.setFind("missing");
    const focus = trackActionFocus();
    const view = renderActionBar(s, silentCallbacks());
    await act(async () => {});
    expect(view.action("find-prev")).toBeDisabled();
    expect(view.action("find-next")).toBeDisabled();

    focus.reset();
    const fromDisabled = dispatchActionKey(view.action("find-prev"), "ArrowRight");
    expect(fromDisabled.defaultPrevented).toBe(false);
    expect(focus.moves()).toHaveLength(0);

    focus.reset();
    const forward = dispatchActionKey(view.action("find-toggle-replace"), "ArrowRight");
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.action("find-close"));
    await act(async () => {});

    focus.reset();
    const backward = dispatchActionKey(view.action("find-close"), "Home");
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.action("find-toggle-replace"));
    await act(async () => {});

    focus.reset();
    const bounded = dispatchActionKey(view.action("find-toggle-replace"), "ArrowLeft");
    expect(bounded.defaultPrevented).toBe(false);
    expect(focus.moves()).toHaveLength(0);
    expect(document.activeElement).toBe(view.action("find-toggle-replace"));
  });

  it("rejects an ancestor-disabled group even when public attribute methods hide it", async () => {
    const s = session("owner", "actions-disabled-facade");
    const focus = trackActionFocus();
    const host = document.createElement("div");
    host.setAttribute("aria-disabled", "true");
    Object.defineProperties(host, {
      hasAttribute: {
        configurable: true,
        value: () => false,
      },
      getAttribute: {
        configurable: true,
        value: () => null,
      },
    });
    const callbacks = silentCallbacks();
    const view = renderActionBar(s, callbacks, { host, key: "disabled-facade" });
    await act(async () => {});
    const source = view.action("find-prev");
    focus.reset();

    const rejected = dispatchActionKey(source, "ArrowRight");

    expect(rejected.defaultPrevented).toBe(false);
    expect(focus.moves()).toHaveLength(0);
    expect(document.activeElement).toBe(source);

    Reflect.deleteProperty(host, "hasAttribute");
    Reflect.deleteProperty(host, "getAttribute");
    host.removeAttribute("aria-disabled");
    renderActionSuccessor(view, s, callbacks, "enabled-successor");
    await act(async () => {});
    focus.reset();

    const recovered = dispatchActionKey(view.action("find-prev"), "ArrowRight");
    expect(recovered.defaultPrevented).toBe(true);
    expect(focus.moves()).toHaveLength(1);
    expect(document.activeElement).toBe(view.action("find-next"));
  });

  it("fails closed on a non-terminating public ancestry facade", async () => {
    const s = session("owner", "actions-cyclic-ancestry");
    const focus = trackActionFocus();
    const view = renderActionBar(s, silentCallbacks());
    await act(async () => {});
    const source = view.action("find-prev");
    Object.defineProperty(source, "parentElement", {
      configurable: true,
      get: () => source,
    });
    focus.reset();

    const rejected = dispatchActionKey(source, "ArrowRight");

    expect(rejected.defaultPrevented).toBe(false);
    expect(focus.moves()).toHaveLength(0);
    expect(document.activeElement).toBe(source);

    Reflect.deleteProperty(source, "parentElement");
    const recovered = dispatchActionKey(source, "ArrowRight");
    expect(recovered.defaultPrevented).toBe(true);
    expect(focus.moves()).toHaveLength(1);
    expect(document.activeElement).toBe(view.action("find-next"));
  });

  it("steps across an absent Replace toggle for a viewer", async () => {
    const s = session("viewer", "actions-absent-toggle");
    const focus = trackActionFocus();
    const view = renderActionBar(s, silentCallbacks());
    await act(async () => {});
    expect(view.host.querySelector('[data-testid="find-toggle-replace"]')).toBeNull();

    focus.reset();
    const forward = dispatchActionKey(view.action("find-next"), "ArrowRight");
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.action("find-close"));
    await act(async () => {});

    focus.reset();
    const backward = dispatchActionKey(view.action("find-close"), "ArrowLeft");
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.action("find-next"));
  });

  it("accepts no movement when only one current enabled action remains", async () => {
    const s = session("viewer", "actions-single");
    s.setFind("missing");
    const focus = trackActionFocus();
    const view = renderActionBar(s, silentCallbacks());
    await act(async () => {});
    const close = view.action("find-close");

    for (const key of ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"]) {
      focus.reset();
      const event = dispatchActionKey(close, key);
      expect([key, event.defaultPrevented]).toEqual([key, false]);
      expect([key, focus.moves().length]).toEqual([key, 0]);
      expect(document.activeElement).toBe(close);
    }
  });

  it.each([
    "find-input",
    "find-match-case",
    "find-whole-word",
    "find-regex",
    "replace-input",
    "replace-one",
    "replace-all",
  ])("ignores navigation keys from %s", async (testId) => {
    const s = session("owner", `actions-isolated-${testId}`);
    const focus = trackActionFocus();
    const view = renderActionBar(s, silentCallbacks());
    await act(async () => {});
    const source = view.element(testId);

    focus.reset();
    const right = dispatchActionKey(source, "ArrowRight");
    const home = dispatchActionKey(source, "Home");

    expect(right.defaultPrevented).toBe(false);
    expect(home.defaultPrevented).toBe(false);
    expect(focus.moves()).toHaveLength(0);
    expect(document.activeElement).toBe(source);
  });

  it("rejects modified, repeated, composing, untrusted, uncancelable, nonbubbling, unfocused, and foreign deliveries", async () => {
    const s = session("owner", "actions-provenance");
    const focus = trackActionFocus();
    const view = renderActionBar(s, silentCallbacks());
    await act(async () => {});
    const source = view.action("find-prev");
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const foreignWindow = frame.contentWindow;
    if (!foreignWindow) throw new Error("The foreign realm was not created");
    const ownerWindow = source.ownerDocument.defaultView;
    if (!ownerWindow) throw new Error("The Find bar has no owner window");

    const rejected = [
      actionKey(source, "ArrowRight", { ctrlKey: true }),
      actionKey(source, "ArrowRight", { altKey: true }),
      actionKey(source, "ArrowRight", { metaKey: true }),
      actionKey(source, "ArrowRight", { shiftKey: true }),
      actionKey(source, "ArrowRight", { repeat: true }),
      actionKey(source, "ArrowRight", { isComposing: true }),
      actionKey(source, "ArrowRight", { cancelable: false }),
      actionKey(source, "ArrowRight", { bubbles: false }),
      actionKey(source, "ArrowRight", {
        view: foreignWindow as Window & typeof globalThis,
      }),
      new ownerWindow.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowRight",
        code: "ArrowRight",
        view: keyboardEventView(ownerWindow),
      }),
    ];
    focus.reset();
    for (const event of rejected) {
      dispatchExactKey(source, event);
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(source);
    }

    const grafted = new (foreignWindow as Window & typeof globalThis).KeyboardEvent(
      "keydown",
      { bubbles: true, cancelable: true, key: "ArrowRight", code: "ArrowRight" },
    );
    Object.setPrototypeOf(grafted, ownerWindow.KeyboardEvent.prototype);
    dispatchExactKey(source, grafted);
    expect(grafted.defaultPrevented).toBe(false);

    const prevented = actionKey(source, "ArrowRight");
    prevented.preventDefault();
    dispatchExactKey(source, prevented);
    expect(document.activeElement).toBe(source);

    const stopped = actionKey(source, "ArrowRight");
    stopped.stopPropagation();
    dispatchExactKey(source, stopped);
    expect(stopped.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(source);

    view.action("find-close").focus();
    const unfocused = actionKey(source, "ArrowRight");
    dispatchExactKey(source, unfocused, false);
    expect(unfocused.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(view.action("find-close"));
    expect(focus.moves()).toHaveLength(0);

    await act(async () => {});
    const accepted = dispatchActionKey(view.action("find-prev"), "ArrowRight");
    expect(accepted.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.action("find-next"));
    frame.remove();
  });

  it("rejects a fabricated wrapper, a foreign row, and a structural Window lookalike", async () => {
    const s = session("owner", "actions-fabricated");
    const focus = trackActionFocus();
    const view = renderActionBar(s, silentCallbacks());
    await act(async () => {});
    const row = view.element<HTMLDivElement>("find-actions");
    const source = view.action("find-prev");
    const capture = reactHandler<NativeBarKeyHandler>(row, "onKeyDownCapture");
    const bubble = reactHandler<(event: ReactKeyboardEvent<HTMLButtonElement>) => void>(
      source,
      "onKeyDown",
    );
    const native = actionKey(source, "ArrowRight");
    const preventDefault = vi.fn();
    const fabricated = {
      type: "keydown",
      key: "ArrowRight",
      code: "ArrowRight",
      location: 0,
      repeat: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      eventPhase: 1,
      isTrusted: true,
      view: null,
      currentTarget: row,
      target: source,
      nativeEvent: native,
      preventDefault,
      stopPropagation: vi.fn(),
      isDefaultPrevented: () => false,
      isPropagationStopped: () => false,
    } as unknown as ReactKeyboardEvent<HTMLDivElement>;
    focus.reset();

    act(() => {
      source.focus();
      capture(fabricated);
      bubble(fabricated as unknown as ReactKeyboardEvent<HTMLButtonElement>);
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(native.defaultPrevented).toBe(false);
    expect(focus.moves()).toHaveLength(0);
    expect(document.activeElement).toBe(source);

    const lookalike = { document, window: {}, self: {} };
    const structural = actionKey(source, "ArrowRight");
    Object.defineProperty(structural, "view", { configurable: true, value: lookalike });
    dispatchExactKey(source, structural);
    expect(structural.defaultPrevented).toBe(false);
    expect(focus.moves()).toHaveLength(0);

    await act(async () => {});
    const recovered = dispatchActionKey(source, "ArrowRight");
    expect(recovered.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.action("find-next"));
  });

  it("accepts a distinct bubble wrapper with an unrelated prototype and absent persist and stopPropagation", async () => {
    const s = session("owner", "actions-unrelated-wrapper");
    const focus = trackActionFocus();
    const view = renderActionBar(s, silentCallbacks());
    await act(async () => {});
    const row = view.element<HTMLDivElement>("find-actions");
    const source = view.action("find-next");
    const wrappers: unknown[] = [];
    const restoreCapture = interceptReactProp<NativeBarKeyHandler>(
      row,
      "onKeyDownCapture",
      (current, event) => {
        wrappers.push(event);
        Object.defineProperty(event, "persist", { configurable: true, value: undefined });
        current(event);
      },
    );
    const restoreBubble = interceptReactProp<(event: ReactKeyboardEvent<HTMLButtonElement>) => void>(
      source,
      "onKeyDown",
      (current, event) => {
        wrappers.push(event);
        const clone = Object.create(Object.create(null)) as Record<string, unknown>;
        for (const property of [
          "nativeEvent",
          "type",
          "target",
          "currentTarget",
          "eventPhase",
          "bubbles",
          "cancelable",
          "defaultPrevented",
          "isTrusted",
          "key",
          "code",
          "location",
          "altKey",
          "ctrlKey",
          "metaKey",
          "shiftKey",
          "repeat",
          "view",
        ]) {
          clone[property] = (event as unknown as Record<string, unknown>)[property];
        }
        clone.preventDefault = function (this: Record<string, unknown>) {
          event.preventDefault();
          this.defaultPrevented = true;
          this.isDefaultPrevented = () => true;
        };
        clone.isDefaultPrevented = () => false;
        clone.isPropagationStopped = () => false;
        current(clone as unknown as ReactKeyboardEvent<HTMLButtonElement>);
      },
    );
    focus.reset();

    try {
      const event = dispatchActionKey(source, "ArrowRight");

      expect(wrappers).toHaveLength(2);
      expect(wrappers[0]).not.toBe(wrappers[1]);
      expect(event.defaultPrevented).toBe(true);
      expect(focus.moves()).toHaveLength(1);
      expect(document.activeElement).toBe(view.action("find-toggle-replace"));
    } finally {
      restoreBubble();
      restoreCapture();
    }
  });

  it.each([
    ["replaced", (): unknown => vi.fn()],
    ["non-function", (): unknown => 7],
    ["absent", (): unknown => undefined],
  ] as const)("accepts %s persist and stopPropagation on both wrappers", async (label, make) => {
    const s = session("owner", `actions-optional-${label}`);
    const focus = trackActionFocus();
    const view = renderActionBar(s, silentCallbacks());
    await act(async () => {});
    const row = view.element<HTMLDivElement>("find-actions");
    const source = view.action("find-next");
    const shadow = (event: object) => {
      for (const property of ["persist", "stopPropagation", "isPersistent"]) {
        Object.defineProperty(event, property, { configurable: true, value: make() });
      }
    };
    const restoreCapture = interceptReactProp<NativeBarKeyHandler>(
      row,
      "onKeyDownCapture",
      (current, event) => {
        shadow(event);
        current(event);
      },
    );
    const restoreBubble = interceptReactProp<(event: ReactKeyboardEvent<HTMLButtonElement>) => void>(
      source,
      "onKeyDown",
      (current, event) => {
        shadow(event);
        current(event);
      },
    );
    focus.reset();

    try {
      const event = dispatchActionKey(source, "ArrowLeft");
      expect(event.defaultPrevented).toBe(true);
      expect(focus.moves()).toHaveLength(1);
      expect(document.activeElement).toBe(view.action("find-prev"));
    } finally {
      restoreBubble();
      restoreCapture();
    }
  });

  it.each([1, 3])(
    "retains the exact native pair through %i nested microtask checkpoint(s) between capture and bubble",
    async (checkpoints) => {
      const s = session("owner", `actions-microtask-${checkpoints}`);
      const focus = trackActionFocus();
      const view = renderActionBar(s, silentCallbacks());
      await act(async () => {});
      const source = view.action("find-next");
      let observed = 0;
      source.addEventListener("keydown", () => {
        const checkpoint = () => {
          observed += 1;
          if (observed < checkpoints) queueMicrotask(checkpoint);
        };
        queueMicrotask(checkpoint);
        vi.runAllTicks();
      }, { capture: true, once: true });
      focus.reset();

      vi.useFakeTimers({ toFake: ["queueMicrotask"] });
      try {
        const event = dispatchActionKey(source, "ArrowRight");
        expect(observed).toBe(checkpoints);
        expect(event.defaultPrevented).toBe(true);
        expect(focus.moves()).toHaveLength(1);
        expect(document.activeElement).toBe(view.action("find-toggle-replace"));
      } finally {
        vi.runAllTicks();
        vi.useRealTimers();
      }
    },
  );

  it("claims one delivery once across replay and reentrancy, then accepts a fresh successor event", async () => {
    const s = session("owner", "actions-replay");
    const focus = trackActionFocus();
    const view = renderActionBar(s, silentCallbacks());
    await act(async () => {});
    const source = view.action("find-prev");
    const reentered: unknown[] = [];
    const restore = interceptReactProp<(event: ReactKeyboardEvent<HTMLButtonElement>) => void>(
      source,
      "onKeyDown",
      (current, event) => {
        current(event);
        reentered.push(event);
        current(event);
      },
    );
    focus.reset();

    try {
      const replayed = actionKey(source, "ArrowRight");
      act(() => {
        source.focus();
        source.dispatchEvent(replayed);
        source.dispatchEvent(replayed);
      });

      expect(reentered).toHaveLength(2);
      expect(replayed.defaultPrevented).toBe(true);
      expect(focus.moves()).toHaveLength(1);
      expect(document.activeElement).toBe(view.action("find-next"));
    } finally {
      restore();
    }

    await act(async () => {});
    focus.reset();
    const fresh = dispatchActionKey(view.action("find-prev"), "ArrowRight");
    expect(fresh.defaultPrevented).toBe(true);
    expect(focus.moves()).toHaveLength(1);
  });

  it("rejects facts changed between capture and bubble, then admits a fresh publication", async () => {
    const s = session("owner", "actions-stale-facts");
    const focus = trackActionFocus();
    const view = renderActionBar(s, silentCallbacks());
    await act(async () => {});
    const source = view.action("find-prev");
    source.addEventListener("keydown", () => {
      s.setFind("mat");
    }, { capture: true, once: true });
    focus.reset();

    const stale = dispatchActionKey(source, "ArrowRight");

    expect(stale.defaultPrevented).toBe(false);
    expect(focus.moves()).toHaveLength(0);

    await waitFor(() => expect(view.element("find-input")).toHaveValue("mat"));
    focus.reset();
    const fresh = dispatchActionKey(view.action("find-prev"), "ArrowRight");
    expect(fresh.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.action("find-next"));
  });

  it.each(["attribute restore", "detach and restore"] as const)(
    "rejects %s DOM history and admits a fresh successor",
    async (scenario) => {
      const s = session("owner", `actions-${scenario.replaceAll(" ", "-")}`);
      const focus = trackActionFocus();
      const view = renderActionBar(s, silentCallbacks());
      await act(async () => {});
      const bar = view.element<HTMLDivElement>("find-bar");
      const source = view.action("find-prev");
      const staleHandler = reactHandler<NativeBarKeyHandler>(bar, "onKeyDown");

      if (scenario === "attribute restore") {
        bar.setAttribute("data-history", "changed");
        bar.removeAttribute("data-history");
      } else {
        const parent = bar.parentNode;
        const previous = bar.previousSibling;
        const next = bar.nextSibling;
        if (!parent) throw new Error("FindBar has no committed parent");
        bar.remove();
        focus.reset();
        const detached = actionKey(source, "ArrowRight");
        act(() => source.dispatchEvent(detached));
        expect(detached.defaultPrevented).toBe(false);
        parent.insertBefore(bar, next);
        // Exactly where it was: placement alone passes, so only the history proof can reject it.
        expect(bar.parentNode).toBe(parent);
        expect(bar.previousSibling).toBe(previous);
        expect(bar.nextSibling).toBe(next);
      }
      focus.reset();
      const restored = actionKey(source, "ArrowRight");
      act(() => {
        source.focus();
        source.dispatchEvent(restored);
      });
      expect(restored.defaultPrevented).toBe(false);
      expect(focus.moves()).toHaveLength(0);

      await waitFor(() => {
        expect(reactHandler<NativeBarKeyHandler>(bar, "onKeyDown")).not.toBe(staleHandler);
      });
      focus.reset();
      const fresh = dispatchActionKey(view.action("find-prev"), "ArrowRight");
      expect(fresh.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(view.action("find-next"));
    },
  );

  it("rejects a partial Strict Mode ref replay before a clean keyed successor recovers", async () => {
    const s = session("owner", "actions-partial-replay");
    const focus = trackActionFocus();
    const callbacks = silentCallbacks();
    const view = renderActionBar(s, callbacks, { key: "stale" });
    await act(async () => {});
    const bar = view.element<HTMLDivElement>("find-bar");
    const barRef = reactRef(bar);
    act(() => {
      barRef(null);
      barRef(bar);
    });
    focus.reset();

    const replayed = dispatchActionKey(view.action("find-prev"), "ArrowRight");
    expect(replayed.defaultPrevented).toBe(false);
    expect(focus.moves()).toHaveLength(0);

    act(() => {
      view.root.render(
        <StrictMode>
          <TooltipProvider>
            <FindBar
              key="current"
              session={s}
              replaceVisible
              focusNonce={0}
              {...callbacks}
            />
          </TooltipProvider>
        </StrictMode>,
      );
    });
    await act(async () => {});
    focus.reset();

    const fresh = dispatchActionKey(view.action("find-prev"), "ArrowRight");
    expect(fresh.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.action("find-next"));
  });

  it("stops navigating after cleanup", async () => {
    const s = session("owner", "actions-cleanup");
    const focus = trackActionFocus();
    const view = renderActionBar(s, silentCallbacks());
    await act(async () => {});
    const source = view.action("find-prev");
    const destination = view.action("find-next");
    act(() => view.root.unmount());
    directRoots.delete(view.root);
    document.body.append(source, destination);
    focus.reset();

    const event = actionKey(source, "ArrowRight");
    act(() => {
      source.focus();
      source.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(focus.moves()).toHaveLength(0);
    expect(document.activeElement).toBe(source);
    source.remove();
    destination.remove();
    view.host.remove();
  });

  type ActionKeyHandler = (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  type AnyPredicate = (...args: unknown[]) => boolean;

  function renderActionSuccessor(
    view: ReturnType<typeof renderActionBar>,
    s: CollabSession,
    callbacks: ActionCallbacks,
    key: string,
  ) {
    act(() => {
      view.root.render(
        <StrictMode>
          <TooltipProvider>
            <FindBar key={key} session={s} replaceVisible focusNonce={0} {...callbacks} />
          </TooltipProvider>
        </StrictMode>,
      );
    });
  }

  it("keeps the rightful pair through crossed, malformed, throwing, duplicate, and reentrant attempts", async () => {
    const s = session("owner", "actions-rejected-attempts");
    const focus = trackActionFocus();
    const setFind = vi.spyOn(s, "setFind");
    const stepFind = vi.spyOn(s, "stepFind");
    const callbacks = silentCallbacks();
    const view = renderActionBar(s, callbacks);
    await act(async () => {});
    const row = view.element<HTMLDivElement>("find-actions");
    const source = view.action("find-prev");
    const crossed = view.action("find-close");
    const capture = reactHandler<NativeBarKeyHandler>(row, "onKeyDownCapture");
    const crossedBubble = reactHandler<ActionKeyHandler>(crossed, "onKeyDown");
    const elementMatches = Element.prototype.matches;
    const malformedPrevent = vi.fn();
    const reentered: string[] = [];
    const thrown: { error: unknown } = { error: null };
    let reentrantArmed = false;

    const restoreCapture = interceptReactProp<NativeBarKeyHandler>(
      row,
      "onKeyDownCapture",
      (current, event) => {
        const native = event.nativeEvent;
        // A capture attempt wearing the bubbling phase: malformed, and never the rightful pair.
        const malformed = {
          nativeEvent: native,
          currentTarget: row,
          target: source,
          type: "keydown",
          key: "ArrowRight",
          code: "ArrowRight",
          location: 0,
          repeat: false,
          altKey: false,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
          bubbles: true,
          cancelable: true,
          defaultPrevented: false,
          eventPhase: 3,
          isTrusted: true,
          view: null,
          preventDefault: malformedPrevent,
          stopPropagation: vi.fn(),
          isDefaultPrevented: () => false,
          isPropagationStopped: () => false,
        } as unknown as ReactKeyboardEvent<HTMLDivElement>;
        current(malformed);
        crossedBubble(event as unknown as ReactKeyboardEvent<HTMLButtonElement>);
        current(event);
        current(event);
      },
    );
    const restoreBubble = interceptReactProp<ActionKeyHandler>(
      source,
      "onKeyDown",
      (current, event) => {
        const native = event.nativeEvent;
        crossedBubble(event);
        current({
          nativeEvent: native,
          currentTarget: crossed,
        } as unknown as ReactKeyboardEvent<HTMLButtonElement>);
        try {
          current({
            nativeEvent: native,
            get currentTarget(): HTMLButtonElement {
              throw new Error("currentTarget is gone");
            },
          } as unknown as ReactKeyboardEvent<HTMLButtonElement>);
        } catch (error) {
          thrown.error = error;
        }
        Object.defineProperty(crossed, "matches", {
          configurable: true,
          value: function (this: Element, selector: string) {
            if (reentrantArmed) {
              reentrantArmed = false;
              reentered.push("reentrant");
              crossedBubble(event);
              capture(event as unknown as ReactKeyboardEvent<HTMLDivElement>);
            }
            return elementMatches.call(this, selector) as boolean;
          },
        });
        reentrantArmed = true;
        current(event);
        current(event);
      },
    );
    focus.reset();

    try {
      const event = dispatchActionKey(source, "ArrowRight");

      expect(malformedPrevent).not.toHaveBeenCalled();
      expect((thrown.error as Error | null)?.message).toBe("currentTarget is gone");
      expect(reentered).toEqual(["reentrant"]);
      expect(event.defaultPrevented).toBe(true);
      expect(focus.moves()).toHaveLength(1);
      expect(focus.moves()[0]?.element).toBe(view.action("find-next"));
      expect(focus.moves()[0]?.options).toEqual({ preventScroll: true });
      expect(document.activeElement).toBe(view.action("find-next"));
    } finally {
      restoreBubble();
      restoreCapture();
      Reflect.deleteProperty(crossed, "matches");
    }

    expect(setFind).not.toHaveBeenCalled();
    expect(stepFind).not.toHaveBeenCalled();
    expect(callbacks.onReveal).not.toHaveBeenCalled();
    expect(callbacks.onReplaceVisible).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(s.ytext.toString()).toBe(TEXT);
  });

  const FINAL_QUERY_DRIFTS = [
    "wrapper method",
    "source focus",
    "destination owner",
    "destination disabled",
    "committed order",
    "detach and restore",
    "live query",
    "live options",
    "live can edit",
    "can-edit accessor",
    "session method",
  ] as const;

  it.each(FINAL_QUERY_DRIFTS)(
    "focuses nothing and leaves a clean successor when the last mutation-capable query changes %s",
    async (drift) => {
      const s = session("owner", `actions-final-${drift.replaceAll(" ", "-")}`);
      const focus = trackActionFocus();
      const callbacks = silentCallbacks();
      const view = renderActionBar(s, callbacks, { key: "drifting" });
      await act(async () => {});
      const group = view.element<HTMLDivElement>("find-row");
      const source = view.action("find-prev");
      const destination = view.action("find-next");
      const searchInput = view.element<HTMLInputElement>("find-input");
      const closeAction = view.action("find-close");
      // The last element of the published tree, so the walk never re-reads what the drift changed.
      const lastPublished = view.action("replace-all");
      const held: { event: ReactKeyboardEvent<HTMLButtonElement> | null } = { event: null };
      const destinationRef = reactRef(destination);
      const readParentNode = Object.getOwnPropertyDescriptor(
        Node.prototype,
        "parentNode",
      )?.get;
      const readAttributes = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "attributes",
      )?.get;
      const canEditPrototype = Object.getPrototypeOf(s) as object;
      const canEditDescriptor = Object.getOwnPropertyDescriptor(
        canEditPrototype,
        "canEdit",
      );
      if (
        !readParentNode ||
        !readAttributes ||
        !canEditDescriptor ||
        typeof canEditDescriptor.get !== "function"
      ) {
        throw new Error("The realm publishes no node getters");
      }
      const readCanEdit = canEditDescriptor.get;
      let armed = false;
      let delivering = false;
      let walks = 0;
      let driftedOnWalk = 0;
      let restoredInPlace = false;
      const prevented = () => held.event?.nativeEvent.defaultPrevented === true;
      const applyDrift = () => {
        const event = held.event;
        if (!event) return;
        if (drift === "wrapper method") {
          Object.defineProperty(event, "preventDefault", {
            configurable: true,
            writable: true,
            value: () => {},
          });
        } else if (drift === "source focus") {
          searchInput.focus();
        } else if (drift === "destination owner") {
          destinationRef(null);
        } else if (drift === "destination disabled") {
          destination.disabled = true;
        } else if (drift === "committed order") {
          group.insertBefore(destination, source);
        } else if (drift === "live query") {
          s.setFind("mat");
        } else if (drift === "live options") {
          const current = s.find;
          if (!current) throw new Error("The session published no find state");
          s.setFind(current.query, { ...current.options, matchCase: !current.options.matchCase });
        } else if (drift === "live can edit") {
          Object.defineProperty(s, "canEdit", { configurable: true, get: () => false });
        } else if (drift === "can-edit accessor") {
          Object.defineProperty(canEditPrototype, "canEdit", {
            ...canEditDescriptor,
            get(this: CollabSession) {
              return readCanEdit.call(this) as boolean;
            },
          });
        } else if (drift === "session method") {
          Object.defineProperty(s, "stepFind", {
            configurable: true,
            writable: true,
            value: vi.fn(),
          });
        } else {
          // Reinserted at its exact original parent and sibling position, so every placement read
          // still accepts it and only the permanent mutation history can reject the detach.
          const before = destination.previousSibling;
          const after = destination.nextSibling;
          destination.remove();
          group.insertBefore(destination, after);
          restoredInPlace =
            destination.parentNode === group &&
            destination.previousSibling === before &&
            destination.nextSibling === after;
        }
      };

      // The committed first-row re-read is the only query that walks a control's public parentNode,
      // so arming here proves the drift below lands in the published DOM walk that follows it — the
      // last mutation-capable query of all, and the one the old order ran after its wrapper checks.
      Object.defineProperty(closeAction, "parentNode", {
        configurable: true,
        get(this: Node) {
          if (prevented()) armed = true;
          return readParentNode.call(this) as ParentNode | null;
        },
      });
      Object.defineProperty(lastPublished, "attributes", {
        configurable: true,
        get(this: Element) {
          if (delivering) walks += 1;
          if (delivering && armed && driftedOnWalk === 0) {
            driftedOnWalk = walks;
            applyDrift();
          }
          return readAttributes.call(this) as NamedNodeMap;
        },
      });
      const restore = interceptReactProp<ActionKeyHandler>(
        source,
        "onKeyDown",
        (current, event) => {
          held.event = event;
          delivering = true;
          try {
            current(event);
          } finally {
            delivering = false;
          }
        },
      );
      focus.reset();

      try {
        const event = dispatchActionKey(source, "ArrowRight");

        expect(armed).toBe(true);
        expect(walks).toBeGreaterThan(1);
        // The drift landed in the last published DOM walk; no mutable query ran after it.
        expect(driftedOnWalk).toBe(walks);
        if (drift === "detach and restore") expect(restoredInPlace).toBe(true);
        expect(event.defaultPrevented).toBe(true);
        expect(focus.moves()).toHaveLength(0);
        expect(document.activeElement).toBe(
          drift === "source focus" ? searchInput : source,
        );
      } finally {
        restore();
        Reflect.deleteProperty(closeAction, "parentNode");
        Reflect.deleteProperty(lastPublished, "attributes");
        Reflect.deleteProperty(s, "canEdit");
        Reflect.deleteProperty(s, "stepFind");
        if (drift === "can-edit accessor") {
          Object.defineProperty(canEditPrototype, "canEdit", canEditDescriptor);
        }
      }

      renderActionSuccessor(view, s, callbacks, "recovered");
      await act(async () => {});
      focus.reset();

      const fresh = dispatchActionKey(view.action("find-prev"), "ArrowRight");
      expect(fresh.defaultPrevented).toBe(true);
      expect(focus.moves()).toHaveLength(1);
      expect(document.activeElement).toBe(view.action("find-next"));
      expect(callbacks.onReveal).not.toHaveBeenCalled();
      expect(callbacks.onClose).not.toHaveBeenCalled();
      expect(s.ytext.toString()).toBe(TEXT);
    },
  );

  it("retains the rightful pair when the last pre-claim query replaces the bubble wrapper's prevention", async () => {
    const s = session("owner", "actions-pre-claim-drift");
    const focus = trackActionFocus();
    const setFind = vi.spyOn(s, "setFind");
    const stepFind = vi.spyOn(s, "stepFind");
    const callbacks = silentCallbacks();
    const view = renderActionBar(s, callbacks, { key: "pre-claim" });
    await act(async () => {});
    const source = view.action("find-prev");
    // The last element of the published tree, so the drift lands in the pre-claim DOM walk that
    // runs after the wrapper was already authenticated and before anything is consumed.
    const lastPublished = view.action("replace-all");
    const readAttributes = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "attributes",
    )?.get;
    if (!readAttributes) throw new Error("The realm publishes no attributes getter");
    const held: { event: ReactKeyboardEvent<HTMLButtonElement> | null } = { event: null };
    const retained: { preventDefault: unknown } = { preventDefault: null };
    let delivering = false;
    let drifted = false;

    Object.defineProperty(lastPublished, "attributes", {
      configurable: true,
      get(this: Element) {
        const event = held.event;
        if (delivering && !drifted && event && !event.nativeEvent.defaultPrevented) {
          drifted = true;
          retained.preventDefault = event.preventDefault;
          Object.defineProperty(event, "preventDefault", {
            configurable: true,
            writable: true,
            value: () => {},
          });
        }
        return readAttributes.call(this) as NamedNodeMap;
      },
    });
    const restore = interceptReactProp<ActionKeyHandler>(
      source,
      "onKeyDown",
      (current, event) => {
        held.event = event;
        delivering = true;
        try {
          current(event);
          expect(drifted).toBe(true);
          expect(event.nativeEvent.defaultPrevented).toBe(false);
          expect(focus.moves()).toHaveLength(0);
          // Nothing was consumed: put the exact prevention back and let the rightful bubble of the
          // same native event run again, which must now authenticate and move focus exactly once.
          Object.defineProperty(event, "preventDefault", {
            configurable: true,
            writable: true,
            value: retained.preventDefault,
          });
          current(event);
        } finally {
          delivering = false;
        }
      },
    );
    focus.reset();

    try {
      const event = dispatchActionKey(source, "ArrowRight");

      expect(drifted).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(focus.moves()).toHaveLength(1);
      expect(focus.moves()[0]?.element).toBe(view.action("find-next"));
      expect(focus.moves()[0]?.options).toEqual({ preventScroll: true });
      expect(document.activeElement).toBe(view.action("find-next"));
    } finally {
      restore();
      Reflect.deleteProperty(lastPublished, "attributes");
    }

    expect(setFind).not.toHaveBeenCalled();
    expect(stepFind).not.toHaveBeenCalled();
    expect(callbacks.onReveal).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(s.ytext.toString()).toBe(TEXT);
  });

  it("drains through the owner realm and rejects a detach and restore hidden behind a replaced takeRecords", async () => {
    const s = session("owner", "actions-laundered-drain");
    const focus = trackActionFocus();
    const callbacks = silentCallbacks();
    const view = renderActionBar(s, callbacks, { key: "laundered" });
    await act(async () => {});
    const group = view.element<HTMLDivElement>("find-row");
    const source = view.action("find-prev");
    const destination = view.action("find-next");
    // The last element of the published tree, so the detach lands in the walk that runs last.
    const lastPublished = view.action("replace-all");
    const readAttributes = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "attributes",
    )?.get;
    const drain = Object.getOwnPropertyDescriptor(
      MutationObserver.prototype,
      "takeRecords",
    );
    if (!readAttributes || typeof drain?.value !== "function") {
      throw new Error("The realm publishes no attributes getter or observer drain");
    }
    const takeRecords = drain.value as (this: MutationObserver) => MutationRecord[];
    const held: { event: ReactKeyboardEvent<HTMLButtonElement> | null } = { event: null };
    let delivering = false;
    let armed = false;
    let replaced = false;
    let publicDrains = 0;
    let laundered = 0;
    let restoredInPlace = false;

    const restoreDrain = () => {
      if (!replaced) return;
      replaced = false;
      Object.defineProperty(MutationObserver.prototype, "takeRecords", drain);
    };
    // A public `observer.takeRecords()` would be answered with an empty list after the real queue was
    // quietly emptied and the exact descriptor put back, so the detach below would leave no trace at
    // all. Only a drain that never looks the method up publicly can still see it.
    const replaceDrain = () => {
      replaced = true;
      Object.defineProperty(MutationObserver.prototype, "takeRecords", {
        configurable: true,
        writable: true,
        value: function (this: MutationObserver) {
          publicDrains += 1;
          laundered += takeRecords.call(this).length;
          restoreDrain();
          return [] as MutationRecord[];
        },
      });
    };

    Object.defineProperty(lastPublished, "attributes", {
      configurable: true,
      get(this: Element) {
        if (delivering && !armed && held.event?.nativeEvent.defaultPrevented === true) {
          armed = true;
          replaceDrain();
          // Reinserted at its exact original parent and sibling position, so every placement read
          // still accepts it and only the observed mutation history can reject the detach.
          const before = destination.previousSibling;
          const after = destination.nextSibling;
          destination.remove();
          group.insertBefore(destination, after);
          restoredInPlace =
            destination.parentNode === group &&
            destination.previousSibling === before &&
            destination.nextSibling === after;
        }
        return readAttributes.call(this) as NamedNodeMap;
      },
    });
    const restore = interceptReactProp<ActionKeyHandler>(
      source,
      "onKeyDown",
      (current, event) => {
        held.event = event;
        delivering = true;
        try {
          current(event);
        } finally {
          delivering = false;
        }
      },
    );
    focus.reset();

    try {
      const event = dispatchActionKey(source, "ArrowRight");

      expect(armed).toBe(true);
      expect(restoredInPlace).toBe(true);
      // The replacement is irrelevant: nothing ever looks the drain up, so it never answers and
      // never launders, and the mutation it offered to hide is still in the permanent history.
      expect(publicDrains).toBe(0);
      expect(laundered).toBe(0);
      expect(event.defaultPrevented).toBe(true);
      expect(focus.moves()).toHaveLength(0);
      expect(document.activeElement).toBe(source);
    } finally {
      restore();
      Reflect.deleteProperty(lastPublished, "attributes");
      restoreDrain();
    }

    renderActionSuccessor(view, s, callbacks, "recovered");
    await act(async () => {});
    focus.reset();

    const fresh = dispatchActionKey(view.action("find-prev"), "ArrowRight");
    expect(fresh.defaultPrevented).toBe(true);
    expect(focus.moves()).toHaveLength(1);
    expect(document.activeElement).toBe(view.action("find-next"));
    expect(callbacks.onReveal).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(s.ytext.toString()).toBe(TEXT);
  });

  it.each(["pre-claim", "final"] as const)(
    "rejects a %s delivery when a session method getter moves the live find behind the public pass",
    async (phase) => {
      const s = session("owner", `actions-live-getter-${phase}`);
      const focus = trackActionFocus();
      const callbacks = silentCallbacks();
      const view = renderActionBar(s, callbacks, { key: `live-getter-${phase}` });
      await act(async () => {});
      const source = view.action("find-prev");
      const destination = view.action("find-next");
      // The last element of the published tree, so the getter is installed by the last DOM walk of
      // the phase and answers the live pass that runs right after it.
      const lastPublished = view.action("replace-all");
      const readAttributes = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "attributes",
      )?.get;
      if (!readAttributes) throw new Error("The realm publishes no attributes getter");
      const publishedFind = s.find;
      if (!publishedFind) throw new Error("The session published no find state");
      const stepFind = s.stepFind;
      const held: { event: ReactKeyboardEvent<HTMLButtonElement> | null } = { event: null };
      let delivering = false;
      let installed = false;
      let methodReads = 0;

      const install = () => {
        installed = true;
        Object.defineProperty(s, "stepFind", {
          configurable: true,
          get: () => {
            methodReads += 1;
            // The live pass read `find` before it read this method: one pass cannot see that the
            // reading it already took is now stale.
            s.find = { ...publishedFind };
            return stepFind;
          },
        });
      };
      const restoreSession = () => {
        Reflect.deleteProperty(s, "stepFind");
        s.find = publishedFind;
      };

      Object.defineProperty(lastPublished, "attributes", {
        configurable: true,
        get(this: Element) {
          const prevented = held.event?.nativeEvent.defaultPrevented === true;
          if (delivering && !installed && prevented === (phase === "final")) install();
          return readAttributes.call(this) as NamedNodeMap;
        },
      });
      const restore = interceptReactProp<ActionKeyHandler>(
        source,
        "onKeyDown",
        (current, event) => {
          held.event = event;
          delivering = true;
          try {
            current(event);
            if (phase !== "pre-claim") return;
            expect(methodReads).toBeGreaterThan(0);
            expect(event.nativeEvent.defaultPrevented).toBe(false);
            expect(focus.moves()).toHaveLength(0);
            // Nothing was consumed: with the session exactly itself again, the rightful bubble of
            // this exact native event authenticates and moves focus once.
            restoreSession();
            current(event);
          } finally {
            delivering = false;
          }
        },
      );
      focus.reset();

      try {
        const event = dispatchActionKey(source, "ArrowRight");

        expect(installed).toBe(true);
        expect(methodReads).toBeGreaterThan(0);
        expect(event.defaultPrevented).toBe(true);
        if (phase === "pre-claim") {
          expect(focus.moves()).toHaveLength(1);
          expect(focus.moves()[0]?.element).toBe(destination);
          expect(focus.moves()[0]?.options).toEqual({ preventScroll: true });
          expect(document.activeElement).toBe(destination);
        } else {
          expect(focus.moves()).toHaveLength(0);
          expect(document.activeElement).toBe(source);
        }
      } finally {
        restore();
        Reflect.deleteProperty(lastPublished, "attributes");
        restoreSession();
      }

      if (phase === "final") {
        renderActionSuccessor(view, s, callbacks, "recovered");
        await act(async () => {});
        focus.reset();

        const fresh = dispatchActionKey(view.action("find-prev"), "ArrowRight");
        expect(fresh.defaultPrevented).toBe(true);
        expect(focus.moves()).toHaveLength(1);
        expect(document.activeElement).toBe(view.action("find-next"));
      }
      expect(callbacks.onReveal).not.toHaveBeenCalled();
      expect(callbacks.onClose).not.toHaveBeenCalled();
      expect(s.ytext.toString()).toBe(TEXT);
    },
  );

  it("calls no replaced Array method after the last live reading and still navigates once", async () => {
    const s = session("owner", "actions-array-poison");
    const callbacks = silentCallbacks();
    const moves: { element: HTMLElement; options: FocusOptions | undefined }[] = [];
    const nativeFocus = HTMLElement.prototype.focus;
    const arrayIndexOf = Array.prototype.indexOf;
    const arrayEvery = Array.prototype.every;
    const applyIndexOf = arrayIndexOf as unknown as (
      this: unknown[],
      ...values: unknown[]
    ) => number;
    const applyEvery = arrayEvery as unknown as (
      this: unknown[],
      ...values: unknown[]
    ) => boolean;
    const canEdit = s.canEdit;
    let delivering = false;
    let installed = false;
    let armed = false;
    let dispatches = 0;
    let dispatchesBeforeMove = -1;
    let sabotaged = false;

    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      if (options !== undefined) {
        // The gate ends the moment the retained focus intrinsic is applied; whatever the realm's own
        // focus implementation does with arrays afterwards is not the final path.
        dispatchesBeforeMove = dispatches;
        armed = false;
        moves.push({ element: this, options });
      }
      nativeFocus.call(this, options);
    });

    const view = renderActionBar(s, callbacks, { key: "array-poison" });
    await act(async () => {});
    const source = view.action("find-prev");
    const destination = view.action("find-next");
    const lastPublished = view.action("replace-all");
    const readAttributes = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "attributes",
    )?.get;
    if (!readAttributes) throw new Error("The realm publishes no attributes getter");
    const publishedFind = s.find;
    if (!publishedFind) throw new Error("The session published no find state");
    const held: { event: ReactKeyboardEvent<HTMLButtonElement> | null } = { event: null };

    // Called only if the final path dispatches through a mutable Array method: it rewrites the
    // destination, the wrapper, and the live authority underneath it, so such a call would both be
    // counted and change what the delivery is allowed to do.
    const sabotage = () => {
      dispatches += 1;
      if (sabotaged) return;
      sabotaged = true;
      destination.disabled = true;
      s.find = { ...publishedFind };
      const event = held.event;
      if (event) {
        Object.defineProperty(event, "preventDefault", {
          configurable: true,
          writable: true,
          value: () => {},
        });
      }
    };
    const poison = () => {
      Object.defineProperty(Array.prototype, "indexOf", {
        configurable: true,
        writable: true,
        value: function (this: unknown[], ...args: unknown[]) {
          if (armed) sabotage();
          return Reflect.apply(applyIndexOf, this, args);
        },
      });
      Object.defineProperty(Array.prototype, "every", {
        configurable: true,
        writable: true,
        value: function (this: unknown[], ...args: unknown[]) {
          if (armed) sabotage();
          return Reflect.apply(applyEvery, this, args);
        },
      });
    };
    const unpoison = () => {
      Object.defineProperty(Array.prototype, "indexOf", {
        configurable: true,
        writable: true,
        enumerable: false,
        value: arrayIndexOf,
      });
      Object.defineProperty(Array.prototype, "every", {
        configurable: true,
        writable: true,
        enumerable: false,
        value: arrayEvery,
      });
    };

    Object.defineProperty(lastPublished, "attributes", {
      configurable: true,
      get(this: Element) {
        if (delivering && !installed && held.event?.nativeEvent.defaultPrevented === true) {
          installed = true;
          // A one-shot reading that removes itself as it answers: the last public pass asks the
          // session for can-edit, so everything the delivery does after this point is the final
          // path, and the session it leaves behind is exactly ordinary again.
          Object.defineProperty(s, "canEdit", {
            configurable: true,
            get: () => {
              Reflect.deleteProperty(s, "canEdit");
              armed = true;
              return canEdit;
            },
          });
        }
        return readAttributes.call(this) as NamedNodeMap;
      },
    });
    const restore = interceptReactProp<ActionKeyHandler>(
      source,
      "onKeyDown",
      (current, event) => {
        held.event = event;
        delivering = true;
        poison();
        try {
          current(event);
        } finally {
          unpoison();
          delivering = false;
        }
      },
    );

    try {
      const event = dispatchActionKey(source, "ArrowRight");

      expect(installed).toBe(true);
      expect(dispatchesBeforeMove).toBe(0);
      expect(sabotaged).toBe(false);
      expect(destination.disabled).toBe(false);
      expect(s.find).toBe(publishedFind);
      expect(event.defaultPrevented).toBe(true);
      expect(moves).toHaveLength(1);
      expect(moves[0]?.element).toBe(destination);
      expect(moves[0]?.options).toEqual({ preventScroll: true });
      expect(document.activeElement).toBe(destination);
    } finally {
      restore();
      unpoison();
      Reflect.deleteProperty(lastPublished, "attributes");
      Reflect.deleteProperty(s, "canEdit");
      s.find = publishedFind;
    }

    expect(callbacks.onReveal).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(s.ytext.toString()).toBe(TEXT);
  });

  it.each([
    ["capture", "its own"],
    ["bubble", "the capture"],
  ] as const)(
    "focuses nothing when the %s predicate replaces %s wrapper's prevention after the effect",
    async (predicatePhase) => {
      const s = session("owner", `actions-predicate-${predicatePhase}`);
      const focus = trackActionFocus();
      const callbacks = silentCallbacks();
      const view = renderActionBar(s, callbacks, { key: "predicate" });
      await act(async () => {});
      const row = view.element<HTMLDivElement>("find-actions");
      const source = view.action("find-prev");
      const wrappers: { capture: object | null } = { capture: null };
      const native: { event: Event | null } = { event: null };
      let preventedCalls = 0;
      let mutated = false;

      // The accepted predicate keeps answering `false`, and only replaces a retained method on its
      // last reading — the one the old order invoked after it had finished re-reading the wrappers.
      const installPredicate = (wrapper: object) => {
        const original = (wrapper as { isPropagationStopped: AnyPredicate })
          .isPropagationStopped;
        Object.defineProperty(wrapper, "isPropagationStopped", {
          configurable: true,
          writable: true,
          value: function (this: unknown, ...args: unknown[]) {
            const stopped = original.apply(this, args);
            if (native.event?.defaultPrevented === true) {
              preventedCalls += 1;
              const target = wrappers.capture;
              if (preventedCalls === 2 && !mutated && target) {
                mutated = true;
                Object.defineProperty(target, "preventDefault", {
                  configurable: true,
                  writable: true,
                  value: () => {},
                });
              }
            }
            return stopped;
          },
        });
      };
      const restoreCapture = interceptReactProp<NativeBarKeyHandler>(
        row,
        "onKeyDownCapture",
        (current, event) => {
          wrappers.capture = event;
          native.event = event.nativeEvent;
          if (predicatePhase === "capture") installPredicate(event);
          current(event);
        },
      );
      const restoreBubble = interceptReactProp<ActionKeyHandler>(
        source,
        "onKeyDown",
        (current, event) => {
          if (predicatePhase === "bubble") installPredicate(event);
          current(event);
        },
      );
      focus.reset();

      try {
        const event = dispatchActionKey(source, "ArrowRight");

        expect(preventedCalls).toBeGreaterThanOrEqual(2);
        expect(mutated).toBe(true);
        expect(event.defaultPrevented).toBe(true);
        expect(focus.moves()).toHaveLength(0);
        expect(document.activeElement).toBe(source);
      } finally {
        restoreBubble();
        restoreCapture();
      }

      renderActionSuccessor(view, s, callbacks, "recovered");
      await act(async () => {});
      focus.reset();

      const fresh = dispatchActionKey(view.action("find-prev"), "ArrowRight");
      expect(fresh.defaultPrevented).toBe(true);
      expect(focus.moves()).toHaveLength(1);
      expect(document.activeElement).toBe(view.action("find-next"));
      expect(callbacks.onReveal).not.toHaveBeenCalled();
      expect(callbacks.onClose).not.toHaveBeenCalled();
      expect(s.ytext.toString()).toBe(TEXT);
    },
  );

  it("rejects an undefined published view and accepts an exactly absent one", async () => {
    const s = session("owner", "actions-view-ownership");
    const focus = trackActionFocus();
    const view = renderActionBar(s, silentCallbacks());
    await act(async () => {});
    const source = view.action("find-prev");
    const restore = interceptReactProp<ActionKeyHandler>(
      source,
      "onKeyDown",
      (current, event) => {
        Object.defineProperty(event, "view", {
          configurable: true,
          writable: true,
          value: undefined,
        });
        current(event);
      },
    );
    focus.reset();

    try {
      const undefinedView = dispatchActionKey(source, "ArrowRight");
      expect(undefinedView.defaultPrevented).toBe(false);
      expect(focus.moves()).toHaveLength(0);
      expect(document.activeElement).toBe(source);
    } finally {
      restore();
    }

    await act(async () => {});
    focus.reset();

    const absentView = dispatchActionKey(view.action("find-prev"), "ArrowRight", {
      view: null,
    });
    expect(absentView.view).toBeNull();
    expect(absentView.defaultPrevented).toBe(true);
    expect(focus.moves()).toHaveLength(1);
    expect(document.activeElement).toBe(view.action("find-next"));
  });

  it("releases a held pending pair at retirement and retains no publication work through cleanup", async () => {
    const s = session("owner", "actions-revoked-pair");
    const focus = trackActionFocus();
    const callbacks = silentCallbacks();
    const view = renderActionBar(s, callbacks);
    await act(async () => {});
    const bar = view.element<HTMLDivElement>("find-bar");
    const source = view.action("find-prev");
    const staleHandler = reactHandler<NativeBarKeyHandler>(bar, "onKeyDown");

    // The capture authenticates its pair; the rightful bubble never runs, so nothing consumes it and
    // the pair stays pending while the native event that keys it stays live.
    const restore = interceptReactProp<ActionKeyHandler>(source, "onKeyDown", () => {});
    const held = actionKey(source, "ArrowRight");
    dispatchExactKey(source, held);
    restore();
    expect(held.defaultPrevented).toBe(false);
    expect(focus.moves()).toHaveLength(0);

    // While the publication still owns it, the held pair makes the exact event inert.
    focus.reset();
    dispatchExactKey(source, held);
    expect(held.defaultPrevented).toBe(false);
    expect(focus.moves()).toHaveLength(0);

    bar.setAttribute("data-history", "changed");
    bar.removeAttribute("data-history");
    await waitFor(() => {
      expect(reactHandler<NativeBarKeyHandler>(
        view.element<HTMLDivElement>("find-bar"),
        "onKeyDown",
      )).not.toBe(staleHandler);
    });
    focus.reset();

    // Retirement revoked the held pair even though the native event is still live: the successor
    // finds no retired pair in the map and authenticates the exact event from scratch.
    dispatchExactKey(view.action("find-prev"), held);
    expect(held.defaultPrevented).toBe(true);
    expect(focus.moves()).toHaveLength(1);
    expect(focus.moves()[0]?.element).toBe(view.action("find-next"));
    expect(document.activeElement).toBe(view.action("find-next"));

    // Consumed once: the replay of the same native event stays inert.
    focus.reset();
    dispatchExactKey(view.action("find-prev"), held);
    expect(focus.moves()).toHaveLength(0);

    focus.reset();
    const fresh = dispatchActionKey(view.action("find-prev"), "ArrowRight");
    expect(fresh.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.action("find-next"));

    const retired = view.action("find-prev");
    const destination = view.action("find-next");
    act(() => view.root.unmount());
    directRoots.delete(view.root);
    document.body.append(retired, destination);
    focus.reset();

    const afterCleanup = actionKey(retired, "ArrowRight");
    dispatchExactKey(retired, afterCleanup);
    expect(afterCleanup.defaultPrevented).toBe(false);
    expect(focus.moves()).toHaveLength(0);
    expect(document.activeElement).toBe(retired);
    expect(callbacks.onReveal).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    retired.remove();
    destination.remove();
    view.host.remove();
  });

  it("claims through retained collection intrinsics: a rejected pre-claim attempt keeps the pair and a poisoned Set, Map, WeakMap, WeakSet, and global Boolean are never called", async () => {
    const s = session("owner", "actions-collection-poison");
    const focus = trackActionFocus();
    const setFind = vi.spyOn(s, "setFind");
    const stepFind = vi.spyOn(s, "stepFind");
    const callbacks = silentCallbacks();
    const view = renderActionBar(s, callbacks, { key: "collection-poison" });
    await act(async () => {});
    const source = view.action("find-prev");
    const destination = view.action("find-next");
    // The last element of the published tree, so both installations land in the walk that runs last
    // before the callback-free pre-claim gate and the claim boundary behind it.
    const lastPublished = view.action("replace-all");
    const readAttributes = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "attributes",
    )?.get;
    if (!readAttributes) throw new Error("The realm publishes no attributes getter");
    const publishedFind = s.find;
    if (!publishedFind) throw new Error("The session published no find state");
    const canEdit = s.canEdit;
    const mutators: readonly (readonly [object, string])[] = [
      [Set.prototype, "add"],
      [Set.prototype, "delete"],
      [Set.prototype, "clear"],
      [Map.prototype, "set"],
      [Map.prototype, "delete"],
      [Map.prototype, "clear"],
      [WeakMap.prototype, "set"],
      [WeakMap.prototype, "delete"],
      [WeakSet.prototype, "add"],
      [WeakSet.prototype, "delete"],
    ];
    const exactMutators = mutators.map(([target, property]) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, property);
      if (typeof descriptor?.value !== "function") {
        throw new Error(`The realm publishes no ${property}`);
      }
      return {
        target,
        property,
        descriptor,
        value: descriptor.value as (...args: unknown[]) => unknown,
      };
    });
    const exactSize = Object.getOwnPropertyDescriptor(Set.prototype, "size");
    const readSize = exactSize?.get;
    if (!exactSize || !readSize) throw new Error("The realm publishes no Set size getter");
    // The one callable mutable global an authentication path could still reach for: nothing in the
    // gate, the claim, or anything either reaches may coerce through `Boolean`.
    const exactBooleanBinding = Object.getOwnPropertyDescriptor(globalThis, "Boolean");
    const exactBoolean = Boolean;
    if (!exactBooleanBinding?.configurable) {
      throw new Error("The realm publishes no configurable Boolean binding");
    }
    const held: { event: ReactKeyboardEvent<HTMLButtonElement> | null } = { event: null };
    const retained: { preventDefault: unknown } = { preventDefault: null };
    let pass = 0;
    let delivering = false;
    let drifted = false;
    let installed = false;
    let armed = false;
    let probing = false;
    let poisonCalls = 0;
    let sabotaged = false;

    // Called only if the claim boundary looks a mutating collection method or the `size` accessor up
    // on a prototype page code owns, or coerces through the mutable global `Boolean`: such a call is
    // both counted and allowed to rewrite what the delivery may still do, so a consumed pair with no
    // effect would be impossible to miss.
    const sabotage = () => {
      poisonCalls += 1;
      if (probing || sabotaged) return;
      sabotaged = true;
      destination.disabled = true;
      s.find = { ...publishedFind };
    };
    const poison = () => {
      for (const entry of exactMutators) {
        Object.defineProperty(entry.target, entry.property, {
          configurable: true,
          writable: true,
          enumerable: false,
          value: function (this: unknown, ...args: unknown[]) {
            if (armed) sabotage();
            return Reflect.apply(entry.value, this, args);
          },
        });
      }
      Object.defineProperty(Set.prototype, "size", {
        configurable: true,
        enumerable: false,
        get: function (this: Set<unknown>) {
          if (armed) sabotage();
          return Reflect.apply(readSize, this, []) as number;
        },
      });
      const poisonedBoolean = function (value?: unknown) {
        if (armed) sabotage();
        return exactBoolean(value);
      };
      poisonedBoolean.prototype = exactBoolean.prototype;
      Object.defineProperty(globalThis, "Boolean", {
        configurable: true,
        writable: true,
        enumerable: exactBooleanBinding.enumerable,
        value: poisonedBoolean,
      });
    };
    const unpoison = () => {
      for (const entry of exactMutators) {
        Object.defineProperty(entry.target, entry.property, entry.descriptor);
      }
      Object.defineProperty(Set.prototype, "size", exactSize);
      Object.defineProperty(globalThis, "Boolean", exactBooleanBinding);
    };

    Object.defineProperty(lastPublished, "attributes", {
      configurable: true,
      get(this: Element) {
        const event = held.event;
        if (delivering && event && !event.nativeEvent.defaultPrevented) {
          if (pass === 1 && !drifted) {
            // The last pre-claim query replaces the retained bubble prevention behind the gate's
            // back, so the attempt is rejected with nothing consumed.
            drifted = true;
            retained.preventDefault = event.preventDefault;
            Object.defineProperty(event, "preventDefault", {
              configurable: true,
              writable: true,
              value: () => {},
            });
          } else if (pass === 2 && !installed) {
            installed = true;
            // A one-shot reading that removes itself as it answers: the last public pass asks the
            // session for can-edit, so everything after it is the callback-free gate and the claim,
            // and the session it leaves behind is exactly ordinary again.
            Object.defineProperty(s, "canEdit", {
              configurable: true,
              get: () => {
                Reflect.deleteProperty(s, "canEdit");
                armed = true;
                return canEdit;
              },
            });
          }
        }
        return readAttributes.call(this) as NamedNodeMap;
      },
    });
    const restore = interceptReactProp<ActionKeyHandler>(
      source,
      "onKeyDown",
      (current, event) => {
        held.event = event;
        delivering = true;
        try {
          pass = 1;
          current(event);
          expect(drifted).toBe(true);
          expect(event.nativeEvent.defaultPrevented).toBe(false);
          expect(focus.moves()).toHaveLength(0);
          // Nothing was consumed: with the exact prevention back — behind a wrapper that closes the
          // poisoned window as soon as the claim has committed — the rightful bubble of this exact
          // native event must authenticate, consume once, and move focus once.
          const exact = retained.preventDefault as (...args: unknown[]) => unknown;
          Object.defineProperty(event, "preventDefault", {
            configurable: true,
            writable: true,
            value: function (this: unknown, ...args: unknown[]) {
              armed = false;
              return Reflect.apply(exact, this, args);
            },
          });
          pass = 2;
          poison();
          try {
            // A live probe: the poison answers for ordinary collections, so the zero count below is
            // the claim boundary never asking, not a poison that was never installed.
            probing = true;
            armed = true;
            const probe = new Set<number>();
            probe.add(1);
            probe.delete(1);
            expect(probe.size).toBe(0);
            new Map<number, number>().set(1, 1);
            new WeakSet<object>().add(probe);
            new WeakMap<object, number>().set(probe, 1);
            expect(Boolean(1)).toBe(true);
            armed = false;
            probing = false;
            expect(poisonCalls).toBeGreaterThan(0);
            poisonCalls = 0;
            current(event);
          } finally {
            armed = false;
            probing = false;
            unpoison();
          }
        } finally {
          delivering = false;
        }
      },
    );
    focus.reset();

    try {
      const event = dispatchActionKey(source, "ArrowRight");

      expect(installed).toBe(true);
      expect(poisonCalls).toBe(0);
      expect(sabotaged).toBe(false);
      expect(destination.disabled).toBe(false);
      expect(s.find).toBe(publishedFind);
      expect(event.defaultPrevented).toBe(true);
      expect(focus.moves()).toHaveLength(1);
      expect(focus.moves()[0]?.element).toBe(destination);
      expect(focus.moves()[0]?.options).toEqual({ preventScroll: true });
      expect(document.activeElement).toBe(destination);
    } finally {
      restore();
      unpoison();
      Reflect.deleteProperty(lastPublished, "attributes");
      Reflect.deleteProperty(s, "canEdit");
      s.find = publishedFind;
    }

    // Consumed exactly once, with no search, replacement, or callback work before activation.
    expect(Boolean).toBe(exactBoolean);
    expect(setFind).not.toHaveBeenCalled();
    expect(stepFind).not.toHaveBeenCalled();
    expect(callbacks.onReveal).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(s.ytext.toString()).toBe(TEXT);
  });

  it("rejects a stateful Window constructor accessor installed by the last mutable query without ever invoking it", async () => {
    const s = session("owner", "actions-window-accessor");
    const focus = trackActionFocus();
    const callbacks = silentCallbacks();
    const view = renderActionBar(s, callbacks, { key: "window-accessor" });
    await act(async () => {});
    const source = view.action("find-prev");
    const destination = view.action("find-next");
    // The last element of the published tree, so the accessor is installed by the last mutable query
    // of the final phase and is in place for everything the delivery does afterwards.
    const lastPublished = view.action("replace-all");
    const ownerWindow = source.ownerDocument.defaultView;
    const publishedBinding = ownerWindow &&
      Object.getOwnPropertyDescriptor(ownerWindow, "HTMLElement");
    const readAttributes = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "attributes",
    )?.get;
    if (!ownerWindow || !publishedBinding?.configurable || !readAttributes) {
      throw new Error("The owner realm publishes no configurable HTMLElement binding");
    }
    const exactConstructor = ownerWindow.HTMLElement;
    const held: { event: ReactKeyboardEvent<HTMLButtonElement> | null } = { event: null };
    let delivering = false;
    let installed = false;
    let restored = false;
    let constructorReads = 0;

    // The accessor answers with the exact retained constructor, so a gate that resolved the binding
    // by reading the Window property would accept it — after it had already disabled the
    // destination, replaced the wrapper's prevention, and moved focus itself.
    const install = () => {
      installed = true;
      restored = false;
      Object.defineProperty(ownerWindow, "HTMLElement", {
        configurable: true,
        enumerable: publishedBinding.enumerable,
        get: () => {
          constructorReads += 1;
          destination.disabled = true;
          destination.focus({ preventScroll: true });
          const event = held.event;
          if (event) {
            Object.defineProperty(event, "preventDefault", {
              configurable: true,
              writable: true,
              value: () => {},
            });
          }
          return exactConstructor;
        },
      });
    };
    const restoreWindow = () => {
      if (!installed || restored) return;
      restored = true;
      Object.defineProperty(ownerWindow, "HTMLElement", publishedBinding);
    };

    Object.defineProperty(lastPublished, "attributes", {
      configurable: true,
      get(this: Element) {
        if (delivering && !installed && held.event?.nativeEvent.defaultPrevented === true) {
          install();
        }
        return readAttributes.call(this) as NamedNodeMap;
      },
    });
    const restore = interceptReactProp<ActionKeyHandler>(
      source,
      "onKeyDown",
      (current, event) => {
        held.event = event;
        delivering = true;
        try {
          current(event);
        } finally {
          delivering = false;
          restoreWindow();
        }
      },
    );
    focus.reset();

    try {
      const event = dispatchActionKey(source, "ArrowRight");

      expect(installed).toBe(true);
      // Descriptor drift alone rejects the delivery: every check reached after the wrapper reads
      // compares captured descriptors and prototype links, so the accessor is never applied and
      // never gets to move focus, disable the destination, or replace the prevention.
      expect(constructorReads).toBe(0);
      expect(destination.disabled).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      expect(focus.moves()).toHaveLength(0);
      expect(document.activeElement).toBe(source);
    } finally {
      restore();
      Reflect.deleteProperty(lastPublished, "attributes");
      restoreWindow();
    }

    expect(ownerWindow.HTMLElement).toBe(exactConstructor);
    renderActionSuccessor(view, s, callbacks, "recovered");
    await act(async () => {});
    focus.reset();

    const fresh = dispatchActionKey(view.action("find-prev"), "ArrowRight");
    expect(fresh.defaultPrevented).toBe(true);
    expect(focus.moves()).toHaveLength(1);
    expect(focus.moves()[0]?.element).toBe(view.action("find-next"));
    expect(focus.moves()[0]?.options).toEqual({ preventScroll: true });
    expect(document.activeElement).toBe(view.action("find-next"));
    expect(constructorReads).toBe(0);
    expect(callbacks.onReveal).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(s.ytext.toString()).toBe(TEXT);
  });

  it("proves keyboard trust by descriptor and never applies a stateful Window KeyboardEvent accessor installed by the last mutable query", async () => {
    const s = session("owner", "actions-keyboard-accessor");
    const focus = trackActionFocus();
    const setFind = vi.spyOn(s, "setFind");
    const stepFind = vi.spyOn(s, "stepFind");
    const callbacks = silentCallbacks();
    const view = renderActionBar(s, callbacks, { key: "keyboard-accessor" });
    await act(async () => {});
    const source = view.action("find-prev");
    const destination = view.action("find-next");
    // The last element of the published tree, so the accessor is installed by the last mutable query
    // of the final phase and is in place for every currentness question asked afterwards.
    const lastPublished = view.action("replace-all");
    const ownerWindow = source.ownerDocument.defaultView;
    // `KeyboardEvent` is held only by the shared keyboard-trust intrinsics, whose currentness walk
    // resolves an accessor-backed Window constructor by applying its captured getter. Nothing the
    // final phase reaches may do that, so the drift has to be caught by descriptor alone.
    const publishedBinding = ownerWindow &&
      Object.getOwnPropertyDescriptor(ownerWindow, "KeyboardEvent");
    const readAttributes = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "attributes",
    )?.get;
    if (!ownerWindow || !publishedBinding?.configurable || !readAttributes) {
      throw new Error("The owner realm publishes no configurable KeyboardEvent binding");
    }
    const exactConstructor = ownerWindow.KeyboardEvent;
    const lookalikeConstructor = function () {} as unknown as typeof exactConstructor;
    const held: { event: ReactKeyboardEvent<HTMLButtonElement> | null } = { event: null };
    let delivering = false;
    let installed = false;
    let restored = false;
    let constructorReads = 0;

    // Stateful on purpose: the first application answers with the exact retained constructor — after
    // it has disabled the destination, moved focus itself, and replaced the wrapper's prevention —
    // and every later one answers with a lookalike, so any gate that resolved the binding by reading
    // the Window property would both be deceived and be observed doing it.
    const install = () => {
      installed = true;
      restored = false;
      Object.defineProperty(ownerWindow, "KeyboardEvent", {
        configurable: true,
        enumerable: publishedBinding.enumerable,
        get: () => {
          constructorReads += 1;
          destination.disabled = true;
          destination.focus({ preventScroll: true });
          const event = held.event;
          if (event) {
            Object.defineProperty(event, "preventDefault", {
              configurable: true,
              writable: true,
              value: () => {},
            });
          }
          return constructorReads === 1 ? exactConstructor : lookalikeConstructor;
        },
      });
    };
    const restoreWindow = () => {
      if (!installed || restored) return;
      restored = true;
      Object.defineProperty(ownerWindow, "KeyboardEvent", publishedBinding);
    };

    Object.defineProperty(lastPublished, "attributes", {
      configurable: true,
      get(this: Element) {
        if (delivering && !installed && held.event?.nativeEvent.defaultPrevented === true) {
          install();
        }
        return readAttributes.call(this) as NamedNodeMap;
      },
    });
    const restore = interceptReactProp<ActionKeyHandler>(
      source,
      "onKeyDown",
      (current, event) => {
        held.event = event;
        delivering = true;
        try {
          current(event);
        } finally {
          delivering = false;
          restoreWindow();
        }
      },
    );
    focus.reset();

    try {
      const event = dispatchActionKey(source, "ArrowRight");

      expect(installed).toBe(true);
      // Descriptor drift alone rejects the delivery: the accessor is never applied, so it never gets
      // to move focus, disable the destination, or replace the prevention.
      expect(constructorReads).toBe(0);
      expect(destination.disabled).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      expect(focus.moves()).toHaveLength(0);
      expect(document.activeElement).toBe(source);
    } finally {
      restore();
      Reflect.deleteProperty(lastPublished, "attributes");
      restoreWindow();
    }

    expect(ownerWindow.KeyboardEvent).toBe(exactConstructor);
    renderActionSuccessor(view, s, callbacks, "recovered");
    await act(async () => {});
    focus.reset();

    const fresh = dispatchActionKey(view.action("find-prev"), "ArrowRight");
    expect(fresh.defaultPrevented).toBe(true);
    expect(focus.moves()).toHaveLength(1);
    expect(focus.moves()[0]?.element).toBe(view.action("find-next"));
    expect(focus.moves()[0]?.options).toEqual({ preventScroll: true });
    expect(document.activeElement).toBe(view.action("find-next"));
    expect(constructorReads).toBe(0);
    expect(setFind).not.toHaveBeenCalled();
    expect(stepFind).not.toHaveBeenCalled();
    expect(callbacks.onReveal).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(s.ytext.toString()).toBe(TEXT);
  });

  it("constructs mutation history from the exact retained owner-realm binding", async () => {
    const ownerWindow = document.defaultView as
      | (Window & typeof globalThis)
      | null;
    const publishedBinding = ownerWindow &&
      Object.getOwnPropertyDescriptor(ownerWindow, "MutationObserver");
    if (!ownerWindow || !publishedBinding?.configurable) {
      throw new Error("The owner realm publishes no configurable MutationObserver binding");
    }
    const exactConstructor = ownerWindow.MutationObserver;
    let constructorReads = 0;
    Object.defineProperty(ownerWindow, "MutationObserver", {
      configurable: true,
      enumerable: publishedBinding.enumerable,
      get: () => {
        constructorReads += 1;
        return exactConstructor;
      },
    });

    const s = session("owner", "actions-retained-observer");
    const focus = trackActionFocus();
    let view: ReturnType<typeof renderActionBar> | null = null;
    try {
      view = renderActionBar(s, silentCallbacks(), { key: "retained-observer" });
      await act(async () => {});
      focus.reset();

      const event = dispatchActionKey(view.action("find-prev"), "ArrowRight");

      // Root Strict Mode establishes, retires, and re-establishes the publication.
      expect(constructorReads).toBe(2);
      expect(event.defaultPrevented).toBe(true);
      expect(focus.moves()).toHaveLength(1);
      expect(document.activeElement).toBe(view.action("find-next"));
    } finally {
      Object.defineProperty(ownerWindow, "MutationObserver", publishedBinding);
    }
  });

  it("drops every listener proof at release so a held native event and a stale handler retain no retired publication work", async () => {
    const s = session("owner", "actions-released-proofs");
    const focus = trackActionFocus();
    const setFind = vi.spyOn(s, "setFind");
    const stepFind = vi.spyOn(s, "stepFind");
    const callbacks = silentCallbacks();
    const view = renderActionBar(s, callbacks, { key: "released-proofs" });
    await act(async () => {});
    const bar = view.element<HTMLDivElement>("find-bar");
    const row = view.element<HTMLDivElement>("find-actions");
    const source = view.action("find-prev");
    // Everything the retirement must not leave usable, held directly across it: the exact native
    // event that keys the Window proof, and the retiring publication's own capture and bubble
    // handlers.
    const staleCapture = reactHandler<NativeBarKeyHandler>(row, "onKeyDownCapture");
    const staleBubble = reactHandler<ActionKeyHandler>(source, "onKeyDown");
    const staleBarKeyDown = reactHandler<NativeBarKeyHandler>(bar, "onKeyDown");

    // The capture registers the Window proof and the pending pair; the rightful bubble never runs,
    // so nothing consumes either and both stay reachable through the still-live native event.
    const restore = interceptReactProp<ActionKeyHandler>(source, "onKeyDown", () => {});
    const held = actionKey(source, "ArrowRight");
    dispatchExactKey(source, held);
    restore();
    expect(held.defaultPrevented).toBe(false);
    expect(focus.moves()).toHaveLength(0);

    bar.setAttribute("data-history", "changed");
    bar.removeAttribute("data-history");
    await waitFor(() => {
      expect(reactHandler<NativeBarKeyHandler>(
        view.element<HTMLDivElement>("find-bar"),
        "onKeyDown",
      )).not.toBe(staleBarKeyDown);
    });
    focus.reset();

    // Retirement released the listener and dropped every proof it had registered: the stale handlers
    // reach no pair, no proof, and no publication through the held native event, and they cannot
    // register a new one either.
    const stale = {
      nativeEvent: held,
      currentTarget: row,
      target: source,
    } as unknown as ReactKeyboardEvent<HTMLDivElement>;
    act(() => {
      staleCapture(stale);
      staleBubble(stale as unknown as ReactKeyboardEvent<HTMLButtonElement>);
    });
    expect(held.defaultPrevented).toBe(false);
    expect(focus.moves()).toHaveLength(0);

    // The successor authenticates the very same native event from scratch, through its own listener.
    dispatchExactKey(view.action("find-prev"), held);
    expect(held.defaultPrevented).toBe(true);
    expect(focus.moves()).toHaveLength(1);
    expect(focus.moves()[0]?.element).toBe(view.action("find-next"));
    expect(document.activeElement).toBe(view.action("find-next"));

    // Consumed once: neither a replay of the exact event nor the stale handlers can move again.
    focus.reset();
    dispatchExactKey(view.action("find-prev"), held);
    act(() => {
      staleCapture(stale);
      staleBubble(stale as unknown as ReactKeyboardEvent<HTMLButtonElement>);
    });
    expect(focus.moves()).toHaveLength(0);

    const retired = view.action("find-prev");
    const destination = view.action("find-next");
    act(() => view.root.unmount());
    directRoots.delete(view.root);
    document.body.append(retired, destination);
    focus.reset();

    // Cleanup released the successor's listener too: a fresh native event registers no proof at all.
    const afterCleanup = actionKey(retired, "ArrowRight");
    dispatchExactKey(retired, afterCleanup);
    act(() => {
      staleCapture(stale);
      staleBubble(stale as unknown as ReactKeyboardEvent<HTMLButtonElement>);
    });
    expect(afterCleanup.defaultPrevented).toBe(false);
    expect(focus.moves()).toHaveLength(0);
    expect(document.activeElement).toBe(retired);
    expect(setFind).not.toHaveBeenCalled();
    expect(stepFind).not.toHaveBeenCalled();
    expect(callbacks.onReveal).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(s.ytext.toString()).toBe(TEXT);
    retired.remove();
    destination.remove();
    view.host.remove();
  });

  it("keeps Escape, native Tab order, click, Enter, and Space behavior", async () => {
    const s = session("owner", "actions-retained-behavior");
    const stepFind = vi.spyOn(s, "stepFind");
    const callbacks = silentCallbacks();
    const view = renderActionBar(s, callbacks);
    await act(async () => {});
    const row = view.element<HTMLDivElement>("find-actions");
    const next = view.action("find-next");
    const order = [...row.querySelectorAll<HTMLButtonElement>("button")]
      .map((button) => button.dataset.testid)
      .filter((testId) => testId?.startsWith("find-prev") || testId?.startsWith("find-next") ||
        testId?.startsWith("find-toggle-replace") || testId?.startsWith("find-close"));
    expect(order).toEqual(["find-prev", "find-next", "find-toggle-replace", "find-close"]);
    for (const testId of order) {
      expect(view.action(testId!)).not.toHaveAttribute("tabindex");
    }

    fireEvent.keyDown(next, { key: "Enter" });
    fireEvent.keyDown(next, { key: " ", code: "Space" });
    expect(stepFind).not.toHaveBeenCalled();

    fireEvent.click(next);
    expect(stepFind).toHaveBeenCalledOnce();
    await act(async () => {});

    fireEvent.keyDown(view.action("find-close"), { key: "Escape" });
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });
});

describe("FindBar exact focus publications", () => {
  it.each(["stale-before-current", "current-before-stale"] as const)(
    "keeps reused frame ids isolated by their exact publication (%s)",
    (order) => {
      const frames = frameEnvironment(true);
      const focus = trackFocus();
      const s = session("owner", `reused-frame-${order}`);
      const callbacks = { onReplaceVisible: vi.fn(), onReveal: vi.fn(), onClose: vi.fn() };
      const rendered = render(<FindBoundary session={s} replaceVisible={false} {...callbacks} />);
      frames.reset();

      fireEvent.click(screen.getByTestId("find-toggle-replace"));
      rendered.rerender(<FindBoundary session={s} replaceVisible {...callbacks} />);
      const stale = frames.captured[0];
      expect(stale.id).toBe(1);
      rendered.rerender(<FindBoundary session={s} replaceVisible={false} {...callbacks} />);
      expect(frames.cancel).toHaveBeenCalledWith(1);

      fireEvent.click(screen.getByTestId("find-toggle-replace"));
      rendered.rerender(<FindBoundary session={s} replaceVisible {...callbacks} />);
      const current = frames.captured[1];
      expect(current.id).toBe(stale.id);
      const before = focus.focused.filter((target) => target === "replace-input").length;
      act(() => {
        for (const frame of order === "stale-before-current" ? [stale, current] : [current, stale]) {
          frames.invoke(frame);
        }
      });
      expect(focus.focused.filter((target) => target === "replace-input")).toHaveLength(before + 1);
      expect(screen.getByTestId("replace-input")).toHaveFocus();
    },
  );

  it("does not replay a search focus request across callback-only publications", () => {
    const s = session("owner", "search-focus-publication");
    const focus = trackFocus();
    const callbacksA = { onReplaceVisible: vi.fn(), onReveal: vi.fn(), onClose: vi.fn() };
    const callbacksB = { onReplaceVisible: vi.fn(), onReveal: vi.fn(), onClose: vi.fn() };
    const rendered = render(<FindBoundary session={s} replaceVisible={false} focusNonce={4} {...callbacksA} />);
    expect(focus.focused.filter((target) => target === "find-input")).toHaveLength(1);
    expect(focus.selected.filter((target) => target === "find-input")).toHaveLength(1);

    rendered.rerender(<FindBoundary session={s} replaceVisible={false} focusNonce={4} {...callbacksB} />);
    expect(focus.focused.filter((target) => target === "find-input")).toHaveLength(1);
    expect(focus.selected.filter((target) => target === "find-input")).toHaveLength(1);

    rendered.rerender(<FindBoundary session={s} replaceVisible={false} focusNonce={5} {...callbacksB} />);
    expect(focus.focused.filter((target) => target === "find-input")).toHaveLength(2);
    expect(focus.selected.filter((target) => target === "find-input")).toHaveLength(2);
  });
});

describe("FindBar replace row", () => {
  it("shows the row to an editor with the toggle reading Hide replace and pointing at it", () => {
    const onReplaceVisible = renderBar(session("owner"), true);
    expect(screen.getByTestId("find-count")).toHaveTextContent("1 of 2");

    const row = screen.getByTestId("find-replace-row");
    expect(row).toHaveAttribute("id", "find-replace-row");
    expect(screen.getByTestId("replace-input")).toBeInTheDocument();
    expect(screen.getByTestId("replace-one")).toBeEnabled();
    expect(screen.getByTestId("replace-all")).toBeEnabled();

    const toggle = screen.getByTestId("find-toggle-replace");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", "find-replace-row");
    expect(toggle).toHaveTextContent(/^Hide replace$/);
    expect(toggle.querySelector("svg")).not.toBeNull();

    fireEvent.click(toggle);
    expect(onReplaceVisible).toHaveBeenCalledWith(false);
  });

  it("collapsed: no row, the toggle reads Replace and asks the shell to show it", () => {
    const onReplaceVisible = renderBar(session("owner"), false);
    expect(screen.queryByTestId("find-replace-row")).toBeNull();

    const toggle = screen.getByTestId("find-toggle-replace");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent(/^Replace$/);
    expect(toggle.querySelector("svg")).not.toBeNull();

    fireEvent.click(toggle);
    expect(onReplaceVisible).toHaveBeenCalledWith(true);
  });

  it("gives a viewer neither the row nor the toggle, even when the shell asks for the row", () => {
    renderBar(session("viewer"), true);
    expect(screen.getByTestId("find-bar")).toBeInTheDocument();
    expect(screen.getByTestId("find-count")).toHaveTextContent("1 of 2");
    expect(screen.queryByTestId("find-replace-row")).toBeNull();
    expect(screen.queryByTestId("find-toggle-replace")).toBeNull();
    expect(screen.queryByTestId("replace-input")).toBeNull();
  });
});

describe("FindBar invalid regular expressions", () => {
  it("explains invalid syntax and blocks navigation and replacement until corrected", async () => {
    const s = session("owner");
    const stepFind = vi.spyOn(s, "stepFind");
    const replaceActive = vi.spyOn(s, "replaceActive");
    const replaceAll = vi.spyOn(s, "replaceAll");
    renderBar(s, true);

    fireEvent.click(screen.getByTestId("find-regex"));
    await waitFor(() => expect(screen.getByTestId("find-regex")).toHaveAttribute("aria-pressed", "true"));
    const input = screen.getByTestId("find-input");
    fireEvent.change(input, { target: { value: "(" } });

    const error = await screen.findByTestId("find-regex-error");
    expect(error).toHaveTextContent("Invalid regular expression");
    expect(error).toHaveAttribute("role", "status");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", error.id);
    expect(screen.queryByTestId("find-count")).toBeNull();
    expect(screen.getByTestId("find-prev")).toBeDisabled();
    expect(screen.getByTestId("find-next")).toBeDisabled();
    expect(screen.getByTestId("replace-one")).toBeDisabled();
    expect(screen.getByTestId("replace-all")).toBeDisabled();

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(screen.getByTestId("replace-input"), { key: "Enter" });
    fireEvent.keyDown(screen.getByTestId("replace-input"), { key: "Enter", shiftKey: true });
    expect(stepFind).not.toHaveBeenCalled();
    expect(replaceActive).not.toHaveBeenCalled();
    expect(replaceAll).not.toHaveBeenCalled();
    expect(s.ytext.toString()).toBe(TEXT);

    fireEvent.change(input, { target: { value: "cat" } });
    await waitFor(() => expect(screen.queryByTestId("find-regex-error")).toBeNull());
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(screen.getByTestId("find-count")).toHaveTextContent("1 of 2");
    expect(screen.getByTestId("find-prev")).toBeEnabled();
    expect(screen.getByTestId("find-next")).toBeEnabled();
    expect(screen.getByTestId("replace-one")).toBeEnabled();
    expect(screen.getByTestId("replace-all")).toBeEnabled();
  });

  it("clears the error when regex mode is turned off and does not reject an empty query", async () => {
    const s = session("owner");
    renderBar(s, false);

    fireEvent.click(screen.getByTestId("find-regex"));
    await waitFor(() => expect(screen.getByTestId("find-regex")).toHaveAttribute("aria-pressed", "true"));
    const input = screen.getByTestId("find-input");
    fireEvent.change(input, { target: { value: "(" } });
    expect(await screen.findByTestId("find-regex-error")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("find-regex"));
    await waitFor(() => expect(screen.queryByTestId("find-regex-error")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("find-regex")).toHaveAttribute("aria-pressed", "false"));
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByTestId("find-count")).toHaveTextContent("0 of 0");

    fireEvent.click(screen.getByTestId("find-regex"));
    await waitFor(() => expect(screen.getByTestId("find-regex")).toHaveAttribute("aria-pressed", "true"));
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(screen.queryByTestId("find-regex-error")).toBeNull());
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByTestId("find-count")).toHaveTextContent("");
  });
});
