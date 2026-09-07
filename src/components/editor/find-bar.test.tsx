// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
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
const session = (role: "owner" | "viewer", docId?: string) => {
  const s = makeSession(role, docId);
  sessions.push(s);
  return s;
};

afterEach(() => {
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

function frameEnvironment() {
  let nextFrame = 1;
  const pending = new Map<number, FrameRequestCallback>();
  const captured: { id: number; callback: FrameRequestCallback }[] = [];
  const request = vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrame++;
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

type ClickHandler = () => void;
type ChangeHandler = (event: { target: { value: string } }) => void;

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
    (order) => {
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
      const retiredOpen = reactHandler<ClickHandler>(screen.getByTestId("find-toggle-replace"), "onClick");

      act(() => retiredOpen());
      expect(frames.pending.size).toBe(1);
      const retiredFrame = frames.captured[0];
      rendered.rerender(<FindBoundary session={previous} replaceVisible {...callbacks} />);
      fireEvent.change(screen.getByTestId("replace-input"), { target: { value: "previous draft" } });
      expect(screen.getByTestId("replace-input")).toHaveValue("previous draft");

      const retiredActions = {
        replacementChange: reactHandler<ChangeHandler>(screen.getByTestId("replace-input"), "onChange"),
        queryChange: reactHandler<ChangeHandler>(screen.getByTestId("find-input"), "onChange"),
        next: reactHandler<ClickHandler>(screen.getByTestId("find-next"), "onClick"),
        replaceOne: reactHandler<ClickHandler>(screen.getByTestId("replace-one"), "onClick"),
        replaceAll: reactHandler<ClickHandler>(screen.getByTestId("replace-all"), "onClick"),
        close: reactHandler<ClickHandler>(screen.getByTestId("find-close"), "onClick"),
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
        retiredOpen();
        retiredActions.replacementChange({ target: { value: "late previous draft" } });
        retiredActions.queryChange({ target: { value: "dog" } });
        retiredActions.next();
        retiredActions.replaceOne();
        retiredActions.replaceAll();
        retiredActions.close();
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
      const currentOpen = reactHandler<ClickHandler>(screen.getByTestId("find-toggle-replace"), "onClick");
      act(() => currentOpen());
      const currentFrame = frames.captured.at(-1);
      if (!currentFrame || currentFrame === retiredFrame) throw new Error("The current replace focus frame was not scheduled");
      expect(frames.pending.has(currentFrame.id)).toBe(true);
      rendered.rerender(<FindBoundary session={current} replaceVisible {...callbacks} />);
      fireEvent.change(screen.getByTestId("replace-input"), { target: { value: "dog" } });

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
      fireEvent.click(screen.getByTestId("replace-one"));
      expect(currentReplaceOne).toHaveBeenCalledOnce();
      expect(currentReplaceOne).toHaveBeenCalledWith("dog");
      fireEvent.change(screen.getByTestId("replace-input"), { target: { value: "fox" } });
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
    const retiredOpen = reactHandler<ClickHandler>(screen.getByTestId("find-toggle-replace"), "onClick");

    act(() => retiredOpen());
    const retiredFrame = frames.captured[0];
    rendered.rerender(<FindBoundary session={removed} replaceVisible {...callbacks} />);
    fireEvent.change(screen.getByTestId("replace-input"), { target: { value: "removed draft" } });
    const retiredActions = {
      queryChange: reactHandler<ChangeHandler>(screen.getByTestId("find-input"), "onChange"),
      next: reactHandler<ClickHandler>(screen.getByTestId("find-next"), "onClick"),
      replaceOne: reactHandler<ClickHandler>(screen.getByTestId("replace-one"), "onClick"),
      replaceAll: reactHandler<ClickHandler>(screen.getByTestId("replace-all"), "onClick"),
      close: reactHandler<ClickHandler>(screen.getByTestId("find-close"), "onClick"),
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
      retiredOpen();
      retiredActions.queryChange({ target: { value: "dog" } });
      retiredActions.next();
      retiredActions.replaceOne();
      retiredActions.replaceAll();
      retiredActions.close();
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
    const input = screen.getByTestId("find-input");
    fireEvent.change(input, { target: { value: "(" } });
    expect(await screen.findByTestId("find-regex-error")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("find-regex"));
    await waitFor(() => expect(screen.queryByTestId("find-regex-error")).toBeNull());
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByTestId("find-count")).toHaveTextContent("0 of 0");

    fireEvent.click(screen.getByTestId("find-regex"));
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(screen.queryByTestId("find-regex-error")).toBeNull());
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByTestId("find-count")).toHaveTextContent("");
  });
});
