// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useLayoutEffect, type ReactNode } from "react";
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

function invokeChange(handler: ChangeHandler, currentTarget: HTMLInputElement, value: string) {
  const previous = currentTarget.value;
  currentTarget.value = value;
  handler({ currentTarget });
  currentTarget.value = previous;
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
