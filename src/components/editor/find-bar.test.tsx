// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useLayoutEffect, useState } from "react";
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

type Callbacks = {
  onReplaceVisible: FindBarProps["onReplaceVisible"];
  onReveal: FindBarProps["onReveal"];
  onClose: FindBarProps["onClose"];
};

function makeSession(role: "owner" | "viewer", docId = "doc"): CollabSession {
  const session = new CollabSession({ docId, user: makeCollabUser("a", "Alice"), role, getToken: async () => "token", autoConnect: false });
  session.ytext.insert(0, TEXT);
  session.setFind("cat");
  return session;
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
  document.body.replaceChildren();
  while (sessions.length) sessions.pop()!.destroy();
  vi.restoreAllMocks();
});

function callbacks(): Callbacks {
  return { onReplaceVisible: vi.fn(), onReveal: vi.fn(), onClose: vi.fn() };
}

function renderBar(session: CollabSession, replaceVisible: boolean, onReplaceVisible = vi.fn()) {
  render(
    <TooltipProvider>
      <FindBar session={session} replaceVisible={replaceVisible} onReplaceVisible={onReplaceVisible} focusNonce={0} onReveal={() => {}} onClose={() => {}} />
    </TooltipProvider>,
  );
  return onReplaceVisible;
}

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
} & Callbacks) {
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

/** Owns `replaceVisible` the way the editor shell does, so the toggle really opens the row. */
function ShellLikeBar({ session, initialReplace = false, ...rest }: { session: CollabSession; initialReplace?: boolean } & Omit<Callbacks, "onReplaceVisible">) {
  const [replace, setReplace] = useState(initialReplace);
  return (
    <TooltipProvider>
      <FindBar session={session} replaceVisible={replace} onReplaceVisible={setReplace} focusNonce={0} {...rest} />
    </TooltipProvider>
  );
}

/** Renders through a direct Strict Mode root so effects mount, unmount and mount again like dev. */
function renderStrict(s: CollabSession, cb: Callbacks, { replaceVisible = true }: { replaceVisible?: boolean } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  directRoots.add(root);
  act(() => {
    root.render(
      <StrictMode>
        <TooltipProvider>
          <FindBar session={s} replaceVisible={replaceVisible} focusNonce={0} {...cb} />
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

/** Dispatches a keydown the way a browser does (bubbling, cancelable) and returns it. */
function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.focus();
    target.dispatchEvent(event);
  });
  return event;
}

/** Stand-in for an editor pane: CodeMirror's `.cm-editor > .cm-content` or ProseMirror's `.md-rich`. */
function editorPane(kind: "code" | "rich" = "code") {
  const content = document.createElement("div");
  content.contentEditable = "true";
  content.tabIndex = 0;
  if (kind === "code") {
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    content.className = "cm-content";
    editor.append(content);
    document.body.append(editor);
  } else {
    content.className = "md-rich";
    document.body.append(content);
  }
  return content;
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

function trackActionFocus() {
  const calls: { element: HTMLElement; options: FocusOptions | undefined }[] = [];
  const focus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
    calls.push({ element: this, options });
    focus.call(this, options);
  });
  return {
    reset: () => {
      calls.length = 0;
    },
    /** Only arrow-key navigation focuses with `{ preventScroll: true }`; plain test focus has no options. */
    moves: () => calls.filter(({ options }) => options !== undefined),
  };
}

describe("FindBar focus and session lifetime", () => {
  it("focuses once for a same-session nonce and again for a new session with the same nonce before the parent layout boundary", () => {
    const previous = session("owner", "focus-previous");
    const current = session("owner", "focus-current");
    const focus = trackFocus();
    const cb = callbacks();
    const rendered = render(<FindBoundary session={previous} replaceVisible={false} focusNonce={0} {...cb} />);

    expect(focus.focused.filter((target) => target === "find-input")).toHaveLength(1);
    expect(focus.selected.filter((target) => target === "find-input")).toHaveLength(1);

    rendered.rerender(
      <FindBoundary
        session={previous}
        replaceVisible={false}
        focusNonce={1}
        boundary={1}
        onBoundary={() => expect(screen.getByTestId("find-input")).toHaveFocus()}
        {...cb}
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
        {...cb}
      />,
    );
    expect(focus.focused.filter((target) => target === "find-input")).toHaveLength(3);
    expect(focus.selected.filter((target) => target === "find-input")).toHaveLength(3);
  });

  it("does not refocus the search input when only the callbacks change", () => {
    const s = session("owner", "search-focus-callbacks");
    const focus = trackFocus();
    const a = callbacks();
    const b = callbacks();
    const rendered = render(<FindBoundary session={s} replaceVisible={false} focusNonce={4} {...a} />);
    expect(focus.focused.filter((target) => target === "find-input")).toHaveLength(1);

    rendered.rerender(<FindBoundary session={s} replaceVisible={false} focusNonce={4} {...b} />);
    expect(focus.focused.filter((target) => target === "find-input")).toHaveLength(1);
    expect(focus.selected.filter((target) => target === "find-input")).toHaveLength(1);

    rendered.rerender(<FindBoundary session={s} replaceVisible={false} focusNonce={5} {...b} />);
    expect(focus.focused.filter((target) => target === "find-input")).toHaveLength(2);
    expect(focus.selected.filter((target) => target === "find-input")).toHaveLength(2);
  });

  it("routes actions to the current callbacks after they change", () => {
    const s = session("owner", "callback-change");
    const stepFind = vi.spyOn(s, "stepFind");
    const a = callbacks();
    const b = callbacks();
    const rendered = render(<FindBoundary session={s} replaceVisible={false} {...a} />);
    rendered.rerender(<FindBoundary session={s} replaceVisible={false} {...b} />);

    fireEvent.click(screen.getByTestId("find-next"));
    expect(stepFind).toHaveBeenCalledOnce();
    expect(a.onReveal).not.toHaveBeenCalled();
    expect(b.onReveal).toHaveBeenCalledOnce();
  });

  it("starts a new session with an empty replacement and sends every action to that session only", async () => {
    const previous = session("owner", "switch-previous");
    const current = session("owner", "switch-current");
    const previousSpies = [
      vi.spyOn(previous, "setFind"),
      vi.spyOn(previous, "stepFind"),
      vi.spyOn(previous, "replaceActive"),
      vi.spyOn(previous, "replaceAll"),
    ];
    const currentReplaceOne = vi.spyOn(current, "replaceActive");
    const currentReplaceAll = vi.spyOn(current, "replaceAll");
    const cb = callbacks();
    const rendered = render(<FindBoundary session={previous} replaceVisible {...cb} />);
    fireEvent.change(screen.getByTestId("replace-input"), { target: { value: "previous draft" } });
    expect(screen.getByTestId("replace-input")).toHaveValue("previous draft");
    for (const spy of previousSpies) spy.mockClear();

    rendered.rerender(<FindBoundary session={current} replaceVisible {...cb} />);

    expect(screen.getByTestId("replace-input")).toHaveValue("");
    expect(screen.getByTestId("find-input")).toHaveFocus();
    fireEvent.change(screen.getByTestId("replace-input"), { target: { value: "dog" } });
    fireEvent.click(screen.getByTestId("replace-one"));
    expect(currentReplaceOne).toHaveBeenCalledWith("dog");
    await waitFor(() => expect(screen.getByTestId("find-count")).toHaveTextContent("1 of 1"));
    fireEvent.change(screen.getByTestId("replace-input"), { target: { value: "fox" } });
    fireEvent.click(screen.getByTestId("replace-all"));
    expect(currentReplaceAll).toHaveBeenCalledWith("fox");
    expect(current.ytext.toString()).toBe("The dog sat on the mat. The fox ran.");
    for (const spy of previousSpies) expect(spy).not.toHaveBeenCalled();
    expect(previous.ytext.toString()).toBe(TEXT);
  });

  it("stops handling F3 once the bar is removed", () => {
    const s = session("owner", "f3-after-close");
    const stepFind = vi.spyOn(s, "stepFind");
    const cb = callbacks();
    const rendered = render(<FindBoundary session={s} replaceVisible={false} {...cb} />);
    rendered.rerender(<FindBoundary session={s} present={false} replaceVisible={false} {...cb} />);

    const event = press(editorPane(), "F3");

    expect(event.defaultPrevented).toBe(false);
    expect(stepFind).not.toHaveBeenCalled();
  });
});

describe("FindBar replace focus", () => {
  it("moves focus into the replace input after the Replace toggle opens the row", () => {
    const s = session("owner", "replace-focus-click");
    render(<ShellLikeBar session={s} onReveal={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId("find-input")).toHaveFocus();

    fireEvent.click(screen.getByTestId("find-toggle-replace"));

    expect(screen.getByTestId("replace-input")).toHaveFocus();
  });

  it("does not steal focus when the row is opened by the shell instead of the toggle", () => {
    const s = session("owner", "replace-focus-shell");
    const cb = callbacks();
    const rendered = render(<FindBoundary session={s} replaceVisible={false} {...cb} />);
    rendered.rerender(<FindBoundary session={s} replaceVisible {...cb} />);
    expect(screen.getByTestId("find-input")).toHaveFocus();
  });

  it("hides the row from the toggle without moving focus into it later", () => {
    const s = session("owner", "replace-focus-hide");
    render(<ShellLikeBar session={s} initialReplace onReveal={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("find-toggle-replace"));
    expect(screen.queryByTestId("replace-input")).toBeNull();
    expect(screen.getByTestId("find-input")).toHaveFocus();
  });
});

describe("FindBar search, options and buttons", () => {
  it("searches as the user types with the current options and reveals the active match", () => {
    const s = session("owner", "typing");
    const setFind = vi.spyOn(s, "setFind");
    const cb = callbacks();
    render(<FindBoundary session={s} replaceVisible={false} {...cb} />);
    const options = s.find!.options;

    fireEvent.change(screen.getByTestId("find-input"), { target: { value: "mat" } });

    expect(setFind).toHaveBeenCalledWith("mat", options);
    expect(screen.getByTestId("find-input")).toHaveValue("mat");
    expect(screen.getByTestId("find-count")).toHaveTextContent("1 of 1");
    expect(cb.onReveal).toHaveBeenCalledWith(s.find!.matches[0]);
  });

  it("toggles an option with the current query and reveals that update's active match", () => {
    const s = session("owner", "option-snapshots");
    const setFind = vi.spyOn(s, "setFind");
    const cb = callbacks();
    render(<FindBoundary session={s} replaceVisible={false} {...cb} />);

    fireEvent.click(screen.getByTestId("find-match-case"));

    expect(setFind).toHaveBeenCalledOnce();
    expect(setFind).toHaveBeenCalledWith("cat", { matchCase: true, wholeWord: false, regex: false });
    expect(cb.onReveal).toHaveBeenCalledOnce();
    expect(cb.onReveal).toHaveBeenCalledWith(s.find?.matches[s.find.active]);
    expect(screen.getByTestId("find-match-case")).toHaveAttribute("aria-pressed", "true");
  });

  it("steps with Previous and Next and wraps at both ends", async () => {
    const s = session("owner", "buttons-wrap");
    const cb = callbacks();
    render(<FindBoundary session={s} replaceVisible={false} {...cb} />);
    const count = screen.getByTestId("find-count");
    expect(count).toHaveTextContent("1 of 2");

    fireEvent.click(screen.getByTestId("find-next"));
    await waitFor(() => expect(count).toHaveTextContent("2 of 2"));
    fireEvent.click(screen.getByTestId("find-next"));
    await waitFor(() => expect(count).toHaveTextContent("1 of 2"));
    fireEvent.click(screen.getByTestId("find-prev"));
    await waitFor(() => expect(count).toHaveTextContent("2 of 2"));
    expect(cb.onReveal).toHaveBeenCalledTimes(3);
    expect(cb.onReveal).toHaveBeenLastCalledWith(s.find!.matches[1]);
  });

  it("prevents mouse down only on the controls that keep focus in the find input", () => {
    const s = session("owner", "mouse-down-controls");
    render(<FindBoundary session={s} replaceVisible {...callbacks()} />);

    for (const testId of ["find-match-case", "find-whole-word", "find-regex", "find-prev", "find-next", "find-toggle-replace"]) {
      expect([testId, fireEvent.mouseDown(screen.getByTestId(testId))]).toEqual([testId, false]);
    }
    for (const testId of ["find-close", "replace-one", "replace-all"]) {
      expect([testId, fireEvent.mouseDown(screen.getByTestId(testId))]).toEqual([testId, true]);
    }
  });

  it("replaces the active match, reveals the next one, and replaces all in a single call", async () => {
    const s = session("owner", "replace-actions");
    const replaceActive = vi.spyOn(s, "replaceActive");
    const replaceAll = vi.spyOn(s, "replaceAll");
    const cb = callbacks();
    render(<FindBoundary session={s} replaceVisible {...cb} />);

    fireEvent.change(screen.getByTestId("replace-input"), { target: { value: "dog" } });
    fireEvent.click(screen.getByTestId("replace-one"));
    expect(replaceActive).toHaveBeenCalledWith("dog");
    expect(s.ytext.toString()).toBe("The dog sat on the mat. The cat ran.");
    expect(cb.onReveal).toHaveBeenCalledWith(s.find!.matches[0]);
    await waitFor(() => expect(screen.getByTestId("find-count")).toHaveTextContent("1 of 1"));

    fireEvent.change(screen.getByTestId("replace-input"), { target: { value: "fox" } });
    fireEvent.click(screen.getByTestId("replace-all"));
    expect(replaceAll).toHaveBeenCalledOnce();
    expect(replaceAll).toHaveBeenCalledWith("fox");
    expect(s.ytext.toString()).toBe("The dog sat on the mat. The fox ran.");
  });

  it("disables the click controls with no matches but keeps Enter in both inputs", () => {
    const s = session("owner", "no-matches");
    s.setFind("missing");
    const stepFind = vi.spyOn(s, "stepFind");
    const replaceActive = vi.spyOn(s, "replaceActive");
    const replaceAll = vi.spyOn(s, "replaceAll");
    const cb = callbacks();
    render(<FindBoundary session={s} replaceVisible {...cb} />);

    expect(screen.getByTestId("find-count")).toHaveTextContent("0 of 0");
    for (const testId of ["find-prev", "find-next", "replace-one", "replace-all"]) {
      const element = screen.getByTestId(testId);
      expect(element).toBeDisabled();
      fireEvent.click(element);
    }
    expect(stepFind).not.toHaveBeenCalled();
    expect(replaceActive).not.toHaveBeenCalled();
    expect(replaceAll).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByTestId("find-input"), { key: "Enter" });
    fireEvent.keyDown(screen.getByTestId("replace-input"), { key: "Enter" });
    expect(stepFind).toHaveBeenCalledOnce();
    expect(replaceActive).toHaveBeenCalledOnce();
    expect(cb.onReveal).not.toHaveBeenCalled();
  });
});

describe("FindBar Enter and Escape", () => {
  it.each([
    ["find-input", false, "step", 1],
    ["find-input", true, "step", -1],
    ["replace-input", false, "replace", 0],
    ["replace-input", true, "step", -1],
  ] as const)("Enter in %s with shift=%s runs %s once", (testId, shiftKey, destination, direction) => {
    const s = session("owner", `enter-${testId}-${shiftKey}`);
    const returned = { from: 4, to: 7 };
    const stepFind = vi.spyOn(s, "stepFind").mockReturnValue(returned);
    const replaceActive = vi.spyOn(s, "replaceActive").mockReturnValue(returned);
    const cb = callbacks();
    render(<FindBoundary session={s} replaceVisible {...cb} />);

    const event = press(screen.getByTestId(testId), "Enter", { shiftKey });

    expect(event.defaultPrevented).toBe(true);
    if (destination === "step") {
      expect(stepFind).toHaveBeenCalledOnce();
      expect(stepFind).toHaveBeenCalledWith(direction);
      expect(replaceActive).not.toHaveBeenCalled();
    } else {
      expect(replaceActive).toHaveBeenCalledOnce();
      expect(stepFind).not.toHaveBeenCalled();
    }
    expect(cb.onReveal).toHaveBeenCalledOnce();
    expect(cb.onReveal).toHaveBeenCalledWith(returned);
  });

  it.each(["find-input", "replace-input"])("leaves Enter alone while an IME is composing in %s", (testId) => {
    const s = session("owner", `enter-composing-${testId}`);
    const stepFind = vi.spyOn(s, "stepFind");
    const replaceActive = vi.spyOn(s, "replaceActive");
    render(<FindBoundary session={s} replaceVisible {...callbacks()} />);

    const event = press(screen.getByTestId(testId), "Enter", { isComposing: true });

    expect(event.defaultPrevented).toBe(false);
    expect(stepFind).not.toHaveBeenCalled();
    expect(replaceActive).not.toHaveBeenCalled();
  });

  it.each(["find-input", "replace-input", "find-next", "find-match-case", "find-close", "replace-all"])(
    "closes once on Escape from %s and keeps the key from reaching the page",
    (testId) => {
      const s = session("owner", `escape-${testId}`);
      const cb = callbacks();
      render(<FindBoundary session={s} replaceVisible {...cb} />);
      const pageListener = vi.fn();
      document.addEventListener("keydown", pageListener);

      const event = press(screen.getByTestId(testId), "Escape");

      document.removeEventListener("keydown", pageListener);
      expect(event.defaultPrevented).toBe(true);
      expect(cb.onClose).toHaveBeenCalledOnce();
      expect(pageListener).not.toHaveBeenCalled();
    },
  );

  it("does not close on Escape while an IME is composing", () => {
    const s = session("owner", "escape-composing");
    const cb = callbacks();
    render(<FindBoundary session={s} replaceVisible {...cb} />);

    const event = press(screen.getByTestId("find-input"), "Escape", { isComposing: true });

    expect(event.defaultPrevented).toBe(false);
    expect(cb.onClose).not.toHaveBeenCalled();
  });

  it("closes from the close button", () => {
    const s = session("owner", "close-click");
    const cb = callbacks();
    render(<FindBoundary session={s} replaceVisible {...cb} />);
    fireEvent.click(screen.getByTestId("find-close"));
    expect(cb.onClose).toHaveBeenCalledOnce();
  });
});

describe("FindBar F3 navigation", () => {
  it.each([
    ["find-input", false, 1],
    ["find-input", true, -1],
    ["replace-input", false, 1],
    ["replace-input", true, -1],
    ["find-match-case", false, 1],
    ["find-match-case", true, -1],
  ] as const)("steps once in Strict Mode from %s with shift=%s and keeps focus there", async (testId, shiftKey, direction) => {
    const s = session("owner", `f3-${testId}-${shiftKey}`);
    const stepFind = vi.spyOn(s, "stepFind");
    const replaceActive = vi.spyOn(s, "replaceActive");
    const replaceAll = vi.spyOn(s, "replaceAll");
    const setFind = vi.spyOn(s, "setFind");
    const cb = callbacks();
    const view = renderStrict(s, cb);
    await act(async () => {});
    const target = view.element(testId);
    fireEvent.change(view.element("replace-input"), { target: { value: "unchanged replacement" } });
    const optionPressed = target.getAttribute("aria-pressed");
    const expected = direction === 1 ? s.find!.matches[1] : s.find!.matches.at(-1);

    const event = press(target, "F3", { shiftKey });

    expect(event.defaultPrevented).toBe(true);
    expect(stepFind).toHaveBeenCalledOnce();
    expect(stepFind).toHaveBeenCalledWith(direction);
    expect(cb.onReveal).toHaveBeenCalledOnce();
    expect(cb.onReveal).toHaveBeenCalledWith(expected);
    expect(replaceActive).not.toHaveBeenCalled();
    expect(replaceAll).not.toHaveBeenCalled();
    expect(setFind).not.toHaveBeenCalled();
    expect(cb.onReplaceVisible).not.toHaveBeenCalled();
    expect(cb.onClose).not.toHaveBeenCalled();
    expect(view.element("find-input")).toHaveValue("cat");
    expect(view.element("replace-input")).toHaveValue("unchanged replacement");
    expect(target.getAttribute("aria-pressed")).toBe(optionPressed);
    expect(target).toHaveFocus();
  });

  it.each(["code", "rich"] as const)("steps from the %s pane while the bar is open and leaves focus there", async (kind) => {
    const s = session("owner", `f3-editor-${kind}`);
    const cb = callbacks();
    const view = renderStrict(s, cb);
    await act(async () => {});
    const editor = editorPane(kind);

    const forward = press(editor, "F3");
    expect(forward.defaultPrevented).toBe(true);
    await waitFor(() => expect(view.element("find-count")).toHaveTextContent("2 of 2"));

    const wrap = press(editor, "F3");
    expect(wrap.defaultPrevented).toBe(true);
    await waitFor(() => expect(view.element("find-count")).toHaveTextContent("1 of 2"));

    const back = press(editor, "F3", { shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    await waitFor(() => expect(view.element("find-count")).toHaveTextContent("2 of 2"));
    expect(cb.onReveal).toHaveBeenCalledTimes(3);
    expect(editor).toHaveFocus();
  });

  it("keeps stepping while F3 is held down", () => {
    const s = session("owner", "f3-repeat");
    const stepFind = vi.spyOn(s, "stepFind");
    render(<FindBoundary session={s} replaceVisible={false} {...callbacks()} />);
    const input = screen.getByTestId("find-input");

    press(input, "F3");
    press(input, "F3", { repeat: true });
    press(input, "F3", { repeat: true });

    expect(stepFind).toHaveBeenCalledTimes(3);
  });

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
    const cb = callbacks();
    const view = renderStrict(s, cb);
    await act(async () => {});

    const event = press(view.element("find-input"), "F3");

    expect(event.defaultPrevented).toBe(true);
    expect(stepFind).not.toHaveBeenCalled();
    expect(cb.onReveal).not.toHaveBeenCalled();
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Alt", { altKey: true }],
    ["Meta", { metaKey: true }],
    ["IME composition", { isComposing: true }],
  ] as const)("ignores F3 with %s", (_label, init) => {
    const s = session("owner", `f3-ignored-${_label}`);
    const stepFind = vi.spyOn(s, "stepFind");
    render(<FindBoundary session={s} replaceVisible={false} {...callbacks()} />);

    const event = press(screen.getByTestId("find-input"), "F3", init);

    expect(event.defaultPrevented).toBe(false);
    expect(stepFind).not.toHaveBeenCalled();
  });

  it("ignores F3 another handler already handled", () => {
    const s = session("owner", "f3-prevented");
    const stepFind = vi.spyOn(s, "stepFind");
    render(<FindBoundary session={s} replaceVisible={false} {...callbacks()} />);
    const editor = editorPane();
    editor.addEventListener("keydown", (e) => e.preventDefault());

    press(editor, "F3");

    expect(stepFind).not.toHaveBeenCalled();
  });

  it.each([
    ["an input in an open dialog", () => {
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      const input = document.createElement("input");
      dialog.append(input);
      document.body.append(dialog);
      return input;
    }],
    ["a header input", () => {
      const header = document.createElement("header");
      const input = document.createElement("input");
      header.append(input);
      document.body.append(header);
      return input;
    }],
    ["a page button", () => {
      const button = document.createElement("button");
      document.body.append(button);
      return button;
    }],
  ] as const)("leaves F3 alone with focus in %s", (_label, make) => {
    const s = session("owner", `f3-outside-${_label}`);
    const stepFind = vi.spyOn(s, "stepFind");
    const cb = callbacks();
    render(<FindBoundary session={s} replaceVisible={false} {...cb} />);

    const event = press(make(), "F3");

    expect(event.defaultPrevented).toBe(false);
    expect(stepFind).not.toHaveBeenCalled();
    expect(cb.onReveal).not.toHaveBeenCalled();
  });

  it("steps exactly once per press from the bar and from each editor pane", async () => {
    const s = session("owner", "f3-once-each");
    const stepFind = vi.spyOn(s, "stepFind");
    const cb = callbacks();
    const view = renderStrict(s, cb);
    await act(async () => {});
    const targets = [view.element("find-input"), view.element("replace-input"), view.action("find-next"), editorPane("code"), editorPane("rich")];

    for (const [index, target] of targets.entries()) {
      press(target, "F3");
      expect([index, stepFind.mock.calls.length, vi.mocked(cb.onReveal).mock.calls.length]).toEqual([index, index + 1, index + 1]);
    }
  });
});

describe("FindBar first-row action navigation", () => {
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

  it("moves focus to the bounded destination for every key from every enabled action, without running it", async () => {
    const s = session("owner", "actions-matrix");
    const focus = trackActionFocus();
    const setFind = vi.spyOn(s, "setFind");
    const stepFind = vi.spyOn(s, "stepFind");
    const replaceActive = vi.spyOn(s, "replaceActive");
    const replaceAll = vi.spyOn(s, "replaceAll");
    const cb = callbacks();
    const view = renderStrict(s, cb);
    await act(async () => {});

    for (const [sourceId, key, destinationId] of NAVIGATION_CASES) {
      const source = view.action(sourceId);
      focus.reset();
      const event = press(source, key);
      const moves = focus.moves();
      expect([sourceId, key, event.defaultPrevented, moves.length]).toEqual([
        sourceId,
        key,
        destinationId !== null,
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
    expect(cb.onReplaceVisible).not.toHaveBeenCalled();
    expect(cb.onReveal).not.toHaveBeenCalled();
    expect(cb.onClose).not.toHaveBeenCalled();
    expect(s.ytext.toString()).toBe(TEXT);
  });

  it.each(NUMPAD_CASES)("accepts %s from the numpad (%s)", async (key, code, sourceId, destinationId) => {
    const s = session("owner", `actions-${code}`);
    const view = renderStrict(s, callbacks());
    await act(async () => {});

    const event = press(view.action(sourceId), key, { code, location: 3 });

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.action(destinationId));
  });

  it("skips disabled Previous and Next and never wraps past the shortened group", async () => {
    const s = session("owner", "actions-disabled-steps");
    s.setFind("missing");
    const focus = trackActionFocus();
    const view = renderStrict(s, callbacks());
    await act(async () => {});
    expect(view.action("find-prev")).toBeDisabled();
    expect(view.action("find-next")).toBeDisabled();

    const forward = press(view.action("find-toggle-replace"), "ArrowRight");
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.action("find-close"));

    const backward = press(view.action("find-close"), "Home");
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.action("find-toggle-replace"));

    focus.reset();
    const bounded = press(view.action("find-toggle-replace"), "ArrowLeft");
    expect(bounded.defaultPrevented).toBe(false);
    expect(focus.moves()).toHaveLength(0);
    expect(document.activeElement).toBe(view.action("find-toggle-replace"));
  });

  it("steps across the absent Replace toggle for a viewer", async () => {
    const s = session("viewer", "actions-absent-toggle");
    const view = renderStrict(s, callbacks());
    await act(async () => {});
    expect(view.host.querySelector('[data-testid="find-toggle-replace"]')).toBeNull();

    expect(press(view.action("find-next"), "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.action("find-close"));
    expect(press(view.action("find-close"), "ArrowLeft").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.action("find-next"));
  });

  it("does nothing when only one enabled action remains", async () => {
    const s = session("viewer", "actions-single");
    s.setFind("missing");
    const focus = trackActionFocus();
    const view = renderStrict(s, callbacks());
    await act(async () => {});
    const close = view.action("find-close");

    for (const key of ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"]) {
      focus.reset();
      const event = press(close, key);
      expect([key, event.defaultPrevented, focus.moves().length]).toEqual([key, false, 0]);
      expect(document.activeElement).toBe(close);
    }
  });

  it.each(["find-input", "find-match-case", "find-whole-word", "find-regex", "replace-input", "replace-one", "replace-all"])(
    "ignores navigation keys from %s",
    async (testId) => {
      const s = session("owner", `actions-isolated-${testId}`);
      const focus = trackActionFocus();
      const view = renderStrict(s, callbacks());
      await act(async () => {});
      const source = view.element(testId);

      focus.reset();
      expect(press(source, "ArrowRight").defaultPrevented).toBe(false);
      expect(press(source, "Home").defaultPrevented).toBe(false);
      expect(focus.moves()).toHaveLength(0);
      expect(document.activeElement).toBe(source);
    },
  );

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Alt", { altKey: true }],
    ["Meta", { metaKey: true }],
    ["Shift", { shiftKey: true }],
    ["IME composition", { isComposing: true }],
  ] as const)("ignores arrow keys with %s", async (_label, init) => {
    const s = session("owner", `actions-modified-${_label}`);
    const view = renderStrict(s, callbacks());
    await act(async () => {});
    const source = view.action("find-prev");

    expect(press(source, "ArrowRight", init).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(source);
  });

  it("keeps Escape, native Tab order, click, Enter, and Space behavior", async () => {
    const s = session("owner", "actions-retained-behavior");
    const stepFind = vi.spyOn(s, "stepFind");
    const cb = callbacks();
    const view = renderStrict(s, cb);
    await act(async () => {});
    const row = view.element<HTMLDivElement>("find-actions");
    const order = [...row.querySelectorAll<HTMLButtonElement>("button")]
      .map((button) => button.dataset.testid)
      .filter((testId) => ["find-prev", "find-next", "find-toggle-replace", "find-close"].includes(testId ?? ""));
    expect(order).toEqual(["find-prev", "find-next", "find-toggle-replace", "find-close"]);
    for (const testId of order) {
      expect(view.action(testId!)).not.toHaveAttribute("tabindex");
    }

    // Enter and Space on a button are the browser's job (they become a click); the bar adds nothing.
    const next = view.action("find-next");
    expect(press(next, "Enter").defaultPrevented).toBe(false);
    expect(press(next, " ").defaultPrevented).toBe(false);
    expect(stepFind).not.toHaveBeenCalled();

    fireEvent.click(next);
    expect(stepFind).toHaveBeenCalledOnce();

    press(view.action("find-close"), "Escape");
    expect(cb.onClose).toHaveBeenCalledOnce();
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

  it("hides the row when the session becomes read-only", async () => {
    const s = session("owner", "becomes-read-only");
    renderBar(s, true);
    expect(screen.getByTestId("find-replace-row")).toBeInTheDocument();
    act(() => s.setMode("viewing"));
    await waitFor(() => expect(screen.queryByTestId("find-replace-row")).toBeNull());
    expect(screen.queryByTestId("find-toggle-replace")).toBeNull();
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
