// @vitest-environment jsdom
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "./dialog";
import { lazyOnFirstUse } from "@/components/editor/lazy-on-first-use";

vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return {
    default: (loader: () => Promise<unknown>, opts?: { loading?: (() => React.ReactElement | null) | null }) => {
      const Lazy = React.lazy(() => loader().then((mod) => ({ default: mod as React.ComponentType<object> })));
      const Loading = opts?.loading;
      return (props: object) => <React.Suspense fallback={Loading ? <Loading /> : null}>{React.createElement(Lazy, props)}</React.Suspense>;
    },
  };
});

interface DirectView {
  readonly host: HTMLDivElement;
  readonly root: Root;
}

type CloseClick = (event: ReactMouseEvent<HTMLButtonElement>) => void;

const directViews: DirectView[] = [];

function renderDirect(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { host, root: createRoot(host) };
  directViews.push(view);
  act(() => view.root.render(node));
  return view;
}

function flushTasks() {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

function reactProperty<T>(element: Element, name: string): T | undefined {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the dialog element");
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  return props?.[name] as T | undefined;
}

function captureClick(element: HTMLButtonElement): CloseClick {
  const click = reactProperty<CloseClick>(element, "onClick");
  if (typeof click !== "function") throw new Error("The dialog Close did not have an onClick handler");
  return click;
}

function captureRef<T extends Element>(element: T): RefCallback<T> {
  const ref = reactProperty<RefCallback<T>>(element, "ref");
  if (typeof ref !== "function") throw new Error("The dialog element did not have a callback ref");
  return ref;
}

function fabricatedClick(currentTarget: HTMLButtonElement) {
  const nativeEvent = new MouseEvent("click", { bubbles: true, button: 0, cancelable: true });
  Object.defineProperty(nativeEvent, "target", { configurable: true, value: currentTarget });
  return {
    type: "click",
    button: 0,
    bubbles: true,
    defaultPrevented: false,
    currentTarget,
    target: currentTarget,
    nativeEvent,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    isDefaultPrevented: () => false,
    isPropagationStopped: () => false,
    persist: vi.fn(),
  } as unknown as ReactMouseEvent<HTMLButtonElement>;
}

function invokeFromCurrentNativePath(handler: CloseClick, currentTarget: HTMLButtonElement) {
  const listener = (nativeEvent: MouseEvent) => {
    nativeEvent.stopPropagation();
    handler({
      type: "click",
      button: 0,
      bubbles: true,
      defaultPrevented: false,
      currentTarget,
      target: currentTarget,
      nativeEvent,
    } as unknown as ReactMouseEvent<HTMLButtonElement>);
  };
  currentTarget.addEventListener("click", listener, { once: true });
  fireEvent.click(currentTarget);
}

function dialog() {
  return screen.getByRole("dialog") as HTMLDivElement;
}

function closeButton(root: ParentNode = document) {
  const close = root.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
  if (!close) throw new Error("Dialog Close was not rendered");
  return close;
}

function header(root: ParentNode = document) {
  const element = closeButton(root).parentElement;
  if (!(element instanceof HTMLDivElement)) throw new Error("Dialog header was not rendered");
  return element;
}

function ControlledDialog({
  title = "Name this version",
  description,
  onClosed,
  children = <input data-testid="dialog-input" autoFocus />,
}: {
  title?: string;
  description?: string;
  onClosed?: () => void;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title={title} description={description} onClosed={onClosed}>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function LayoutCapture({ capture }: { capture: () => void }) {
  useLayoutEffect(capture, [capture]);
  return null;
}

function RemoveLeadingGuardOnRefReplay() {
  const removed = useRef(false);
  return (
    <span
      ref={() => () => {
        if (removed.current) return;
        removed.current = true;
        document.querySelector<HTMLElement>("[data-radix-focus-guard]")?.remove();
      }}
    />
  );
}

function MutateDescendantOnPassiveReplayCleanup() {
  const element = useRef<HTMLSpanElement>(null);
  useEffect(() => () => {
    element.current?.setAttribute("data-passive-cleanup", "complete");
  }, []);
  return <span ref={element} />;
}

function createFocusGuard() {
  const guard = document.createElement("span");
  guard.setAttribute("data-radix-focus-guard", "");
  guard.tabIndex = 0;
  guard.style.outline = "none";
  guard.style.opacity = "0";
  guard.style.position = "fixed";
  guard.style.pointerEvents = "none";
  return guard;
}

beforeEach(() => {
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
});

afterEach(() => {
  cleanup();
  while (directViews.length) {
    const view = directViews.pop()!;
    act(() => view.root.unmount());
    view.host.remove();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("DialogContent focus lifecycle", () => {
  function Harness({
    open,
    children,
    title = "Name this version",
    onClosed,
  }: {
    open: boolean;
    children?: ReactNode;
    title?: string;
    onClosed?: () => void;
  }) {
    return (
      <>
        <button type="button" data-testid="more-menu">
          More
        </button>
        <Dialog open={open}>
          <DialogContent title={title} onClosed={onClosed}>{children}</DialogContent>
        </Dialog>
      </>
    );
  }

  it("recovers opening focus from a closing menu and returns it to that exact trigger", async () => {
    const onClosed = vi.fn();
    const content = <input data-testid="version-name" autoFocus />;
    const { rerender } = render(<Harness open onClosed={onClosed}>{content}</Harness>);
    const input = screen.getByTestId("version-name");
    expect(input).toHaveFocus();

    act(() => screen.getByTestId("more-menu").focus());
    await flushTasks();
    expect(input).toHaveFocus();

    rerender(<Harness open={false} onClosed={onClosed}>{content}</Harness>);
    await flushTasks();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("more-menu")).toHaveFocus();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("keeps a body without a tabbable control focused inside and restores its opener", async () => {
    const content = <p>Command palette - Mod-Shift-P</p>;
    const { rerender } = render(<Harness open title="Keyboard shortcuts">{content}</Harness>);
    const currentDialog = dialog();
    expect(currentDialog).toContainElement(document.activeElement as HTMLElement);

    act(() => screen.getByTestId("more-menu").focus());
    await flushTasks();
    expect(currentDialog).toContainElement(document.activeElement as HTMLElement);

    rerender(<Harness open={false} title="Keyboard shortcuts">{content}</Harness>);
    await flushTasks();
    expect(screen.getByTestId("more-menu")).toHaveFocus();
  });

  it("does not disturb focus already moved to another body control", async () => {
    render(
      <Harness open>
        <input data-testid="first" autoFocus />
        <input data-testid="second" />
      </Harness>,
    );
    act(() => screen.getByTestId("second").focus());
    await flushTasks();
    expect(screen.getByTestId("second")).toHaveFocus();
  });
});

describe("DialogContent exact Strict Mode publication", () => {
  it.each(["Close", "Escape"] as const)(
    "closes once through the exact %s action and restores the opener once",
    async (action) => {
      const opener = document.createElement("button");
      document.body.append(opener);
      opener.focus();
      const onClosed = vi.fn();
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      renderDirect(
        <StrictMode>
          <ControlledDialog onClosed={onClosed} />
        </StrictMode>,
      );
      const input = screen.getByTestId("dialog-input");
      expect(input).toHaveFocus();
      focus.mockClear();

      if (action === "Close") fireEvent.click(closeButton());
      else fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
      await flushTasks();

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(opener).toHaveFocus();
      expect(focus.mock.contexts.filter((target) => target === opener)).toHaveLength(1);
      expect(onClosed).toHaveBeenCalledOnce();
    },
  );

  it("bridges only the current Radix Close chain to its parent authority", () => {
    const staleParent = vi.fn();
    const currentParent = vi.fn();
    const acceptedCurrent = vi.fn();
    let authorizedClose: HTMLButtonElement | null = null;
    const tree = (visit: "A" | "B") => (
      <StrictMode>
        <Dialog
          key={visit}
          open
          onOpenChange={visit === "A"
            ? staleParent
            : (open) => {
                currentParent(open);
                if (authorizedClose === closeButton()) acceptedCurrent(open);
              }}
        >
          <DialogContent title={`Close ${visit}`}>
            <input autoFocus />
          </DialogContent>
        </Dialog>
      </StrictMode>
    );
    const view = renderDirect(tree("A"));
    const staleElement = closeButton();
    const staleClose = captureClick(staleElement);

    act(() => view.root.render(tree("B")));
    const currentElement = closeButton();
    const currentClose = captureClick(currentElement);
    const capturedEvent = (currentTarget: HTMLButtonElement) => ({
      currentTarget,
      defaultPrevented: false,
    }) as unknown as ReactMouseEvent<HTMLButtonElement>;

    act(() => {
      staleClose(capturedEvent(currentElement));
      currentClose(capturedEvent(staleElement));
    });
    expect(staleParent).not.toHaveBeenCalled();
    expect(acceptedCurrent).not.toHaveBeenCalled();

    authorizedClose = currentElement;
    act(() => currentClose(capturedEvent(currentElement)));
    expect(currentParent).toHaveBeenCalledOnce();
    expect(acceptedCurrent).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("completes an uncontrolled current Radix Close bridge", async () => {
    const onClosed = vi.fn();
    renderDirect(
      <StrictMode>
        <Dialog defaultOpen>
          <DialogContent title="Uncontrolled bridge" onClosed={onClosed}>
            <input autoFocus />
          </DialogContent>
        </Dialog>
      </StrictMode>,
    );
    const currentClose = closeButton();

    act(() => captureClick(currentClose)({
      currentTarget: currentClose,
      defaultPrevented: false,
    } as unknown as ReactMouseEvent<HTMLButtonElement>));
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("lets an expanded combobox consume the first Escape before the exact second Escape closes", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClosed = vi.fn();
    renderDirect(
      <StrictMode>
        <ControlledDialog onClosed={onClosed}>
          <input
            role="combobox"
            aria-controls="combobox-options"
            aria-expanded="true"
            data-testid="combobox"
            autoFocus
          />
        </ControlledDialog>
      </StrictMode>,
    );
    const combobox = screen.getByTestId("combobox");

    fireEvent.keyDown(combobox, { key: "Escape", code: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    combobox.setAttribute("aria-expanded", "false");
    fireEvent.keyDown(combobox, { key: "Escape", code: "Escape" });
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("authenticates an owner-document Escape through current focus custody", async () => {
    const onClosed = vi.fn();
    renderDirect(
      <StrictMode>
        <ControlledDialog onClosed={onClosed}>
          <input data-testid="document-escape-input" autoFocus />
        </ControlledDialog>
      </StrictMode>,
    );
    expect(screen.getByTestId("document-escape-input")).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("rejects a foreign-document Escape without poisoning the current publication", async () => {
    const onClosed = vi.fn();
    const foreignFrame = document.createElement("iframe");
    document.body.append(foreignFrame);
    renderDirect(
      <StrictMode>
        <ControlledDialog onClosed={onClosed}>
          <input data-testid="foreign-escape-input" autoFocus />
        </ControlledDialog>
      </StrictMode>,
    );
    const foreignDocument = foreignFrame.contentDocument;
    const foreignWindow = foreignFrame.contentWindow;
    if (!foreignDocument || !foreignWindow) throw new Error("The foreign document was not created");

    const foreignEscape = foreignDocument.createEvent("KeyboardEvent");
    foreignEscape.initEvent("keydown", true, true);
    Object.defineProperty(foreignEscape, "key", { value: "Escape" });
    document.dispatchEvent(foreignEscape);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onClosed).not.toHaveBeenCalled();

    fireEvent.click(closeButton());
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("publishes an initially empty explicit description and closes with exact focus custody", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClosed = vi.fn();
    renderDirect(
      <StrictMode>
        <ControlledDialog description="" onClosed={onClosed} />
      </StrictMode>,
    );
    expect(screen.getByTestId("dialog-input")).toHaveFocus();
    expect(dialog().querySelector("p")).toHaveClass("mt-1", "text-sm", "text-ink-3");
    expect(dialog().querySelector("p")).toHaveTextContent("");

    fireEvent.click(closeButton());
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("publishes a nonempty-to-empty description successor for exact Escape close", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClosed = vi.fn();
    function DescriptionHarness() {
      const [description, setDescription] = useState("Before");
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent title="Description transition" description={description} onClosed={onClosed}>
            <button type="button" onClick={() => setDescription("")}>Empty description</button>
            <input data-testid="description-input" autoFocus />
          </DialogContent>
        </Dialog>
      );
    }
    renderDirect(<StrictMode><DescriptionHarness /></StrictMode>);

    fireEvent.click(screen.getByRole("button", { name: "Empty description" }));
    const input = screen.getByTestId("description-input");
    act(() => input.focus());
    expect(dialog().querySelector("p")).toHaveClass("mt-1", "text-sm", "text-ink-3");
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("uses real Radix outside-event timing without letting delayed replay autofocus steal focus", async () => {
    const opener = document.createElement("button");
    const outside = document.createElement("button");
    document.body.append(opener, outside);
    opener.focus();
    const onClosed = vi.fn();
    renderDirect(
      <StrictMode>
        <ControlledDialog onClosed={onClosed} />
      </StrictMode>,
    );
    await flushTasks();

    fireEvent.pointerDown(outside, { button: 0, isPrimary: true });
    fireEvent.click(outside, { button: 0 });
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("publishes a distinct exact successor after direct Strict Mode ref and layout replay", async () => {
    let retiredClick: CloseClick | undefined;
    let retiredHeaderRef: RefCallback<HTMLDivElement> | undefined;
    const capture = () => {
      if (retiredClick) return;
      retiredClick = captureClick(closeButton());
      retiredHeaderRef = captureRef(header());
    };
    const onClosed = vi.fn();
    renderDirect(
      <StrictMode>
        <ControlledDialog onClosed={onClosed}>
          <LayoutCapture capture={capture} />
          <input data-testid="current-input" autoFocus />
        </ControlledDialog>
      </StrictMode>,
    );
    const currentClose = closeButton();
    const currentHeader = header();
    const currentClick = captureClick(currentClose);
    expect(retiredClick).toBeDefined();
    expect(currentClick).not.toBe(retiredClick);

    act(() => {
      retiredClick?.(fabricatedClick(currentClose));
      retiredHeaderRef?.(currentHeader);
      retiredHeaderRef?.(null);
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onClosed).not.toHaveBeenCalled();

    fireEvent.click(currentClose);
    await flushTasks();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("keeps replacement custody exact and neutralizes stale timers, callbacks, and partial refs", async () => {
    vi.useFakeTimers();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const closedA = vi.fn();
    const closedB = vi.fn();

    function ReplacementHarness() {
      const [visit, setVisit] = useState<"A" | "B">("A");
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" data-testid="replace" onClick={() => setVisit("B")}>Replace</button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent
              key={visit}
              title={`Dialog ${visit}`}
              onClosed={visit === "A" ? closedA : closedB}
            >
              <input data-testid={`input-${visit}`} autoFocus />
            </DialogContent>
          </Dialog>
        </>
      );
    }

    renderDirect(<StrictMode><ReplacementHarness /></StrictMode>);
    act(() => vi.runOnlyPendingTimers());
    const staleCloseElement = closeButton();
    const staleClick = captureClick(staleCloseElement);
    const staleHeaderRef = captureRef(header());
    expect(screen.getByTestId("input-A")).toHaveFocus();

    fireEvent.click(screen.getByTestId("replace"));
    const inputB = screen.getByTestId("input-B");
    const currentClose = closeButton();
    expect(inputB).toHaveFocus();
    act(() => {
      staleClick(fabricatedClick(currentClose));
      staleHeaderRef(header());
      staleHeaderRef(null);
      vi.runOnlyPendingTimers();
    });

    expect(inputB).toHaveFocus();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Dialog B");
    expect(closedA).not.toHaveBeenCalled();
    expect(closedB).not.toHaveBeenCalled();

    fireEvent.click(currentClose);
    act(() => vi.runOnlyPendingTimers());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
    expect(closedA).not.toHaveBeenCalled();
    expect(closedB).toHaveBeenCalledOnce();
  });

  it("clears the exact opening-recovery timer at the synchronous replacement boundary", () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(window, "setTimeout");
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const onOpenChange = vi.fn();
    const tree = (visit: "A" | "B") => (
      <StrictMode>
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent key={visit} title={`Recovery ${visit}`}>
            <input data-testid={`recovery-${visit}`} autoFocus />
          </DialogContent>
        </Dialog>
      </StrictMode>
    );
    const outside = document.createElement("button");
    document.body.append(outside);
    const view = renderDirect(tree("A"));
    const callsBeforeFocusOut = timeout.mock.calls.length;

    fireEvent.focusOut(screen.getByTestId("recovery-A"), { relatedTarget: outside });
    const timerIndex = timeout.mock.calls.findIndex(
      (call, index) => index >= callsBeforeFocusOut && call[1] === 0,
    );
    expect(timerIndex).toBeGreaterThanOrEqual(callsBeforeFocusOut);
    const timer = timeout.mock.results[timerIndex]!.value;
    const staleCallback = timeout.mock.calls[timerIndex]![0] as () => void;

    act(() => view.root.render(tree("B")));
    expect(clearTimeout).toHaveBeenCalledWith(timer);
    expect(screen.getByTestId("recovery-B")).toHaveFocus();

    act(staleCallback);
    expect(screen.getByTestId("recovery-B")).toHaveFocus();
  });

  it.each(["subtree", "immediate placement", "higher ancestor"] as const)(
    "permanently rejects %s mutation and restore, then admits a fresh keyed successor",
    async (kind) => {
      const onClosed = vi.fn();
      function MutationHarness() {
        const [visit, setVisit] = useState<"A" | "B">("A");
        const [open, setOpen] = useState(true);
        return (
          <>
            <button type="button" data-testid="replace" onClick={() => setVisit("B")}>Replace</button>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogContent key={visit} title={`Dialog ${visit}`} onClosed={onClosed}>
                <input data-testid={`input-${visit}`} autoFocus />
              </DialogContent>
            </Dialog>
          </>
        );
      }
      renderDirect(<StrictMode><MutationHarness /></StrictMode>);
      const staleDialog = dialog();
      const staleClose = closeButton();

      if (kind === "subtree") {
        staleClose.setAttribute("aria-label", "Changed");
        staleClose.setAttribute("aria-label", "Close");
      } else if (kind === "immediate placement") {
        const parent = staleDialog.parentNode!;
        const next = staleDialog.nextSibling;
        staleDialog.remove();
        parent.insertBefore(staleDialog, next);
      } else {
        const html = document.documentElement;
        const currentBody = document.body;
        currentBody.remove();
        html.append(currentBody);
      }

      fireEvent.click(staleClose);
      await flushTasks();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(onClosed).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId("replace"));
      expect(screen.getByRole("dialog")).toHaveAccessibleName("Dialog B");
      fireEvent.click(closeButton());
      await flushTasks();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(onClosed).toHaveBeenCalledOnce();
    },
  );

  it("rejects crossed title/body/callback drift while the current replacement remains usable", async () => {
    const closedA = vi.fn();
    const closedB = vi.fn();
    function DriftHarness() {
      const [visit, setVisit] = useState<"A" | "B">("A");
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" data-testid="replace" onClick={() => setVisit("B")}>Replace</button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent
              title={`Title ${visit}`}
              description={`Description ${visit}`}
              className={`visit-${visit}`}
              onClosed={visit === "A" ? closedA : closedB}
            >
              <input key={visit} data-testid={`drift-${visit}`} autoFocus />
            </DialogContent>
          </Dialog>
        </>
      );
    }
    renderDirect(<StrictMode><DriftHarness /></StrictMode>);
    const staleClose = closeButton();
    const staleClick = captureClick(staleClose);
    const staleHeaderRef = captureRef(staleClose.parentElement as HTMLDivElement);

    fireEvent.click(screen.getByTestId("replace"));
    const currentClose = closeButton();
    expect(dialog()).toHaveAccessibleName("Title B");
    expect(dialog()).toHaveAccessibleDescription("Description B");
    expect(dialog()).toHaveClass("visit-B");
    act(() => {
      staleClick(fabricatedClick(currentClose));
      staleHeaderRef(currentClose.parentElement as HTMLDivElement);
      staleHeaderRef(null);
    });
    expect(screen.getByTestId("drift-B")).toHaveFocus();
    expect(closedA).not.toHaveBeenCalled();
    expect(closedB).not.toHaveBeenCalled();

    fireEvent.click(currentClose);
    await flushTasks();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(closedA).not.toHaveBeenCalled();
    expect(closedB).toHaveBeenCalledOnce();
  });

  it("transfers nested custody without letting the outer publication focus through the inner one", async () => {
    const outerClosed = vi.fn();
    const innerClosed = vi.fn();
    function NestedHarness() {
      const [outerOpen, setOuterOpen] = useState(true);
      const [innerOpen, setInnerOpen] = useState(false);
      return (
        <Dialog open={outerOpen} onOpenChange={setOuterOpen}>
          <DialogContent title="Outer" onClosed={outerClosed}>
            <button type="button" data-testid="open-inner" onClick={() => setInnerOpen(true)}>
              Open inner
            </button>
            <Dialog open={innerOpen} onOpenChange={setInnerOpen}>
              <DialogContent title="Inner" onClosed={innerClosed}>
                <input data-testid="inner-input" autoFocus />
              </DialogContent>
            </Dialog>
          </DialogContent>
        </Dialog>
      );
    }
    renderDirect(<StrictMode><NestedHarness /></StrictMode>);
    const innerOpener = screen.getByTestId("open-inner");
    fireEvent.click(innerOpener);
    expect(screen.getByTestId("inner-input")).toHaveFocus();

    fireEvent.click(closeButton(screen.getByRole("dialog", { name: "Inner" })));
    await flushTasks();

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(innerOpener).toHaveFocus();
    expect(innerClosed).toHaveBeenCalledOnce();
    expect(outerClosed).not.toHaveBeenCalled();
  });

  it("forgets repeated nested roots and rejects off-state focus-guard removal", async () => {
    const outerClosed = vi.fn();
    const innerClosed = vi.fn();
    function RepeatedNestedHarness() {
      const [outerOpen, setOuterOpen] = useState(true);
      const [innerOpen, setInnerOpen] = useState(false);
      return (
        <Dialog open={outerOpen} onOpenChange={setOuterOpen}>
          <DialogContent title="Outer retained roots" onClosed={outerClosed}>
            <button type="button" onClick={() => setInnerOpen(true)}>Open repeated inner</button>
            <Dialog open={innerOpen} onOpenChange={setInnerOpen}>
              <DialogContent title="Repeated inner" onClosed={innerClosed}>
                <input autoFocus />
              </DialogContent>
            </Dialog>
          </DialogContent>
        </Dialog>
      );
    }
    renderDirect(<StrictMode><RepeatedNestedHarness /></StrictMode>);
    const innerOpener = screen.getByRole("button", { name: "Open repeated inner" });

    for (let visit = 0; visit < 4; visit++) {
      fireEvent.click(innerOpener);
      const inner = screen.getByRole("dialog", { name: "Repeated inner" });
      fireEvent.click(closeButton(inner));
      await flushTasks();
      expect(screen.queryByRole("dialog", { name: "Repeated inner" })).toBeNull();
    }
    expect(innerClosed).toHaveBeenCalledTimes(4);

    const focusGuard = document.querySelector<HTMLElement>("[data-radix-focus-guard]");
    expect(focusGuard).not.toBeNull();
    focusGuard!.remove();
    await act(() => Promise.resolve());
    fireEvent.click(closeButton(screen.getByRole("dialog", { name: "Outer retained roots" })));
    await flushTasks();

    expect(screen.getByRole("dialog", { name: "Outer retained roots" })).toBeInTheDocument();
    expect(outerClosed).not.toHaveBeenCalled();
  });

  it.each(["replacement", "swap"] as const)(
    "rejects repeated focus-guard %s while a nested dialog is open",
    async (mutation) => {
      const outerClosed = vi.fn();
      function NestedGuardHarness() {
        const [outerOpen, setOuterOpen] = useState(true);
        const [innerOpen, setInnerOpen] = useState(false);
        return (
          <Dialog open={outerOpen} onOpenChange={setOuterOpen}>
            <DialogContent title="Outer guard owner" onClosed={outerClosed}>
              <button type="button" onClick={() => setInnerOpen(true)}>Open guard nested</button>
              <button type="button" onClick={() => setInnerOpen(false)}>Dismiss nested state</button>
              <Dialog open={innerOpen} onOpenChange={setInnerOpen}>
                <DialogContent title="Guard nested">
                  <input autoFocus />
                </DialogContent>
              </Dialog>
            </DialogContent>
          </Dialog>
        );
      }
      renderDirect(<StrictMode><NestedGuardHarness /></StrictMode>);
      fireEvent.click(screen.getByRole("button", { name: "Open guard nested" }));
      const original = [...document.querySelectorAll<HTMLElement>("[data-radix-focus-guard]")];
      const firstReplacement = [createFocusGuard(), createFocusGuard()];
      const secondReplacement = [createFocusGuard(), createFocusGuard()];

      act(() => {
        if (mutation === "replacement") {
          original.forEach((guard) => guard.remove());
          document.body.prepend(firstReplacement[0]);
          document.body.append(firstReplacement[1]);
          firstReplacement.forEach((guard) => guard.remove());
          document.body.prepend(secondReplacement[0]);
          document.body.append(secondReplacement[1]);
        } else {
          original.forEach((guard) => guard.remove());
          document.body.prepend(original[1]);
          document.body.append(original[0]);
          original.forEach((guard) => guard.remove());
          document.body.prepend(original[0]);
          document.body.append(original[1]);
        }
      });
      fireEvent.click(screen.getByRole("button", { name: "Dismiss nested state", hidden: true }));
      await flushTasks();
      expect(screen.queryByRole("dialog", { name: "Guard nested" })).toBeNull();

      fireEvent.click(closeButton(screen.getByRole("dialog", { name: "Outer guard owner" })));
      await flushTasks();

      expect(screen.getByRole("dialog", { name: "Outer guard owner" })).toBeInTheDocument();
      expect(outerClosed).not.toHaveBeenCalled();
      if (mutation === "replacement") secondReplacement.forEach((guard) => guard.remove());
    },
  );

  it("removes both exact guards after a clean nested close", async () => {
    function CleanNestedHarness() {
      const [outerOpen, setOuterOpen] = useState(true);
      const [innerOpen, setInnerOpen] = useState(false);
      return (
        <Dialog open={outerOpen} onOpenChange={setOuterOpen}>
          <DialogContent title="Clean outer">
            <button type="button" onClick={() => setInnerOpen(true)}>Open clean inner</button>
            <Dialog open={innerOpen} onOpenChange={setInnerOpen}>
              <DialogContent title="Clean inner"><input autoFocus /></DialogContent>
            </Dialog>
          </DialogContent>
        </Dialog>
      );
    }
    renderDirect(<StrictMode><CleanNestedHarness /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: "Open clean inner" }));
    fireEvent.click(closeButton(screen.getByRole("dialog", { name: "Clean inner" })));
    await flushTasks();
    fireEvent.click(closeButton(screen.getByRole("dialog", { name: "Clean outer" })));
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelectorAll("[data-radix-focus-guard]")).toHaveLength(0);
  });

  it("drains off-state focus-guard removal before synchronous replay and recovers cleanly", async () => {
    const taintedClosed = vi.fn();
    const cleanClosed = vi.fn();
    const body = <input data-testid="guard-replay" autoFocus />;
    const tree = (rootKey: string, onClosed: () => void) => (
      <StrictMode>
        <ControlledDialog
          key={rootKey}
          title="Guard replay"
          onClosed={onClosed}
        >
          {body}
        </ControlledDialog>
      </StrictMode>
    );
    const view = renderDirect(tree("tainted", taintedClosed));
    const focusGuard = document.querySelector<HTMLElement>("[data-radix-focus-guard]");
    expect(focusGuard).not.toBeNull();

    act(() => {
      focusGuard!.remove();
      view.root.render(tree("tainted", taintedClosed));
    });
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Guard replay");
    fireEvent.click(closeButton());
    await flushTasks();

    expect(screen.getByRole("dialog")).toHaveAccessibleName("Guard replay");
    expect(taintedClosed).not.toHaveBeenCalled();

    act(() => view.root.render(tree("clean", cleanClosed)));
    expect(screen.getByTestId("guard-replay")).toHaveFocus();
    expect(document.querySelectorAll("[data-radix-focus-guard]")).toHaveLength(2);
    fireEvent.click(closeButton());
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(cleanClosed).toHaveBeenCalledOnce();
  });

  it("rejects a focus guard removed by child ref cleanup after replay preparation", async () => {
    const taintedClosed = vi.fn();
    const cleanClosed = vi.fn();
    const tree = (rootKey: string, tainted: boolean, onClosed: () => void) => (
      <StrictMode>
        <ControlledDialog key={rootKey} title="Child cleanup" onClosed={onClosed}>
          {tainted && <RemoveLeadingGuardOnRefReplay />}
          <input data-testid="child-cleanup-input" autoFocus />
        </ControlledDialog>
      </StrictMode>
    );
    const view = renderDirect(tree("tainted", true, taintedClosed));

    fireEvent.click(closeButton());
    fireEvent.keyDown(screen.getByTestId("child-cleanup-input"), {
      key: "Escape",
      code: "Escape",
    });
    await flushTasks();

    expect(screen.getByRole("dialog")).toHaveAccessibleName("Child cleanup");
    expect(taintedClosed).not.toHaveBeenCalled();

    act(() => view.root.render(tree("clean", false, cleanClosed)));
    expect(document.querySelectorAll("[data-radix-focus-guard]")).toHaveLength(2);
    fireEvent.click(closeButton());
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(cleanClosed).toHaveBeenCalledOnce();
  });

  it("accepts exact replay guard teardown before a later allowed passive cleanup mutation", async () => {
    const onClosed = vi.fn();
    renderDirect(
      <StrictMode>
        <ControlledDialog title="Passive cleanup replay" onClosed={onClosed}>
          <MutateDescendantOnPassiveReplayCleanup />
          <input autoFocus />
        </ControlledDialog>
      </StrictMode>,
    );

    fireEvent.click(closeButton());
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it.each(["leading", "trailing"] as const)(
    "rejects moving the %s focus guard to the opposite body edge",
    async (edge) => {
      const onClosed = vi.fn();
      renderDirect(
        <StrictMode>
          <ControlledDialog title={`${edge} guard swap`} onClosed={onClosed} />
        </StrictMode>,
      );
      const guards = document.querySelectorAll<HTMLElement>("[data-radix-focus-guard]");
      const guard = edge === "leading" ? guards[0] : guards[guards.length - 1];

      act(() => {
        guard.remove();
        if (edge === "leading") document.body.append(guard);
        else document.body.prepend(guard);
      });
      fireEvent.click(closeButton());
      await flushTasks();

      expect(screen.getByRole("dialog")).toHaveAccessibleName(`${edge} guard swap`);
      expect(onClosed).not.toHaveBeenCalled();
    },
  );

  it.each(["marker", "tabindex", "style"] as const)(
    "rejects tracked focus-guard %s mutation",
    async (attribute) => {
      const onClosed = vi.fn();
      renderDirect(
        <StrictMode>
          <ControlledDialog title={`${attribute} guard mutation`} onClosed={onClosed} />
        </StrictMode>,
      );
      const guard = document.querySelector<HTMLElement>("[data-radix-focus-guard]");
      expect(guard).not.toBeNull();

      act(() => {
        if (attribute === "marker") guard!.setAttribute("data-radix-focus-guard", "changed");
        else if (attribute === "tabindex") guard!.tabIndex = -1;
        else guard!.style.opacity = "1";
      });
      fireEvent.click(closeButton());
      await flushTasks();

      expect(screen.getByRole("dialog")).toHaveAccessibleName(`${attribute} guard mutation`);
      expect(onClosed).not.toHaveBeenCalled();
    },
  );

  it("rejects an unrelated body-edge span becoming a third focus guard", async () => {
    const onClosed = vi.fn();
    renderDirect(
      <StrictMode>
        <ControlledDialog title="Third guard" onClosed={onClosed} />
      </StrictMode>,
    );
    const third = document.createElement("span");

    act(() => {
      document.body.append(third);
      third.setAttribute("data-radix-focus-guard", "");
      third.tabIndex = 0;
      third.style.outline = "none";
      third.style.opacity = "0";
      third.style.position = "fixed";
      third.style.pointerEvents = "none";
    });
    fireEvent.click(closeButton());
    await flushTasks();

    expect(screen.getByRole("dialog")).toHaveAccessibleName("Third guard");
    expect(onClosed).not.toHaveBeenCalled();
    third.remove();
  });

  it("requires exactly two body-edge focus guards before publication", async () => {
    const extra = createFocusGuard();
    document.body.append(extra);
    const onClosed = vi.fn();
    renderDirect(
      <StrictMode>
        <ControlledDialog title="Pre-existing third guard" onClosed={onClosed} />
      </StrictMode>,
    );

    fireEvent.click(closeButton());
    await flushTasks();

    expect(screen.getByRole("dialog")).toHaveAccessibleName("Pre-existing third guard");
    expect(onClosed).not.toHaveBeenCalled();
    extra.remove();
  });

  it.each(["leading", "trailing"] as const)(
    "preserves %s focus-guard repositioning at its original body edge",
    async (edge) => {
      const onClosed = vi.fn();
      renderDirect(
        <StrictMode>
          <ControlledDialog title={`${edge} guard reposition`} onClosed={onClosed} />
        </StrictMode>,
      );
      const guards = document.querySelectorAll<HTMLElement>("[data-radix-focus-guard]");
      const guard = edge === "leading" ? guards[0] : guards[guards.length - 1];

      act(() => {
        guard.remove();
        if (edge === "leading") document.body.prepend(guard);
        else document.body.append(guard);
      });
      fireEvent.click(closeButton());
      await flushTasks();

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(onClosed).toHaveBeenCalledOnce();
    },
  );

  it("finishes an authenticated close through fresh controlled callback identities", async () => {
    const onClosed = vi.fn();
    function InlineCallbacksHarness() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onOpenChange={(next) => setOpen(next)}>
          <DialogContent title="Inline callbacks" onClosed={() => onClosed()}>
            <input data-testid="inline-input" autoFocus />
          </DialogContent>
        </Dialog>
      );
    }
    renderDirect(<StrictMode><InlineCallbacksHarness /></StrictMode>);

    fireEvent.click(closeButton());
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("keeps the current publication usable across an application theme change", async () => {
    const previousTheme = document.documentElement.getAttribute("data-theme");
    const onClosed = vi.fn();
    renderDirect(
      <StrictMode>
        <ControlledDialog onClosed={onClosed}>
          <input data-testid="theme-input" autoFocus />
        </ControlledDialog>
      </StrictMode>,
    );
    document.documentElement.setAttribute("data-theme", previousTheme === "dark" ? "light" : "dark");
    await act(() => Promise.resolve());

    fireEvent.click(closeButton());
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClosed).toHaveBeenCalledOnce();
    if (previousTheme === null) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", previousTheme);
  });

  it("publishes again after a controlled owner vetoes an authenticated close", async () => {
    const onOpenChange = vi.fn();
    function VetoHarness() {
      return (
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent title="Vetoed close">
            <button type="button">Still open</button>
          </DialogContent>
        </Dialog>
      );
    }
    renderDirect(<StrictMode><VetoHarness /></StrictMode>);

    fireEvent.click(closeButton());
    await flushTasks();
    fireEvent.click(closeButton());

    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  it("preserves direct body roots and authenticates exported DialogClose controls", async () => {
    const onClosed = vi.fn();
    function OwnedCloseHarness() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent title="Owned Close" onClosed={onClosed}>
            <form data-testid="direct-body">
              <DialogClose asChild><a href="#done">Done</a></DialogClose>
            </form>
          </DialogContent>
        </Dialog>
      );
    }
    renderDirect(<StrictMode><OwnedCloseHarness /></StrictMode>);
    const currentDialog = dialog();
    expect(screen.getByTestId("direct-body").parentElement).toBe(currentDialog);
    expect(currentDialog.children).toHaveLength(2);

    fireEvent.click(screen.getByRole("link", { name: "Done" }));
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it.each([
    { variant: "regular", type: "submit" as const },
    { variant: "regular", type: "reset" as const },
    { variant: "asChild", type: "submit" as const },
    { variant: "asChild", type: "reset" as const },
  ])("closes once through an exported $variant $type button", async ({ variant, type }) => {
    const onOpenChange = vi.fn();
    const onClosed = vi.fn();
    function ButtonTypeHarness() {
      const [open, setOpen] = useState(true);
      const close = variant === "asChild"
        ? (
            <DialogClose asChild>
              <button type={type}>Close {variant} {type}</button>
            </DialogClose>
          )
        : <DialogClose type={type}>Close {variant} {type}</DialogClose>;
      return (
        <Dialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
        >
          <DialogContent title={`${variant} ${type}`} onClosed={onClosed}>
            <form
              onSubmit={(event) => event.preventDefault()}
              onReset={(event) => event.preventDefault()}
            >
              {close}
            </form>
          </DialogContent>
        </Dialog>
      );
    }
    renderDirect(<StrictMode><ButtonTypeHarness /></StrictMode>);

    fireEvent.click(screen.getByRole("button", { name: `Close ${variant} ${type}` }));
    await flushTasks();

    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it.each([
    { variant: "regular", type: "submit" as const },
    { variant: "regular", type: "reset" as const },
    { variant: "asChild", type: "submit" as const },
    { variant: "asChild", type: "reset" as const },
  ])(
    "closes a non-modal root through an external $variant $type control",
    async ({ variant, type }) => {
      const onOpenChange = vi.fn();
      const onClosed = vi.fn();
      const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
      const onReset = vi.fn((event: FormEvent) => event.preventDefault());
      function ExternalCloseHarness() {
        const [open, setOpen] = useState(true);
        const close = variant === "asChild"
          ? (
              <DialogClose asChild>
                <button type={type}>External {variant} {type}</button>
              </DialogClose>
            )
          : <DialogClose type={type}>External {variant} {type}</DialogClose>;
        return (
          <Dialog
            open={open}
            onOpenChange={(next) => {
              onOpenChange(next);
              setOpen(next);
            }}
            modal={false}
          >
            <form onSubmit={onSubmit} onReset={onReset}>{close}</form>
            <DialogContent title={`External ${variant} ${type}`} onClosed={onClosed}>
              <input autoFocus />
            </DialogContent>
          </Dialog>
        );
      }
      renderDirect(<StrictMode><ExternalCloseHarness /></StrictMode>);

      fireEvent.click(screen.getByRole("button", { name: `External ${variant} ${type}` }));
      await flushTasks();

      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(onSubmit).toHaveBeenCalledTimes(type === "submit" ? 1 : 0);
      expect(onReset).toHaveBeenCalledTimes(type === "reset" ? 1 : 0);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(onClosed).toHaveBeenCalledOnce();
    },
  );

  it.each(["trigger", "close"] as const)(
    "rejects a stale exported Dialog%s token on the current replacement path",
    (kind) => {
      const staleOpenChange = vi.fn();
      const currentOpenChange = vi.fn();
      const tree = (visit: "A" | "B") => (
        <StrictMode>
          <Dialog open onOpenChange={visit === "A" ? staleOpenChange : currentOpenChange}>
            <DialogTrigger>Toggle {visit}</DialogTrigger>
            <DialogContent title={`Owned ${visit}`}>
              <DialogClose>Body close {visit}</DialogClose>
            </DialogContent>
          </Dialog>
        </StrictMode>
      );
      const view = renderDirect(tree("A"));
      const staleElement = screen.getByText(
        kind === "trigger" ? /Toggle\s+A/ : /Body close\s+A/,
      ) as HTMLButtonElement;
      const staleHandler = captureClick(staleElement);

      act(() => view.root.render(tree("B")));
      const currentElement = screen.getByText(
        kind === "trigger" ? /Toggle\s+B/ : /Body close\s+B/,
      ) as HTMLButtonElement;
      invokeFromCurrentNativePath(staleHandler, currentElement);

      expect(staleOpenChange).not.toHaveBeenCalled();
      expect(currentOpenChange).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "Owned B" })).toBeInTheDocument();

      fireEvent.click(currentElement);
      expect(currentOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    },
  );

  it("preserves React 19 cleanup returns from exported control refs", () => {
    const triggerCleanup = vi.fn();
    const closeCleanup = vi.fn();
    const triggerRef: RefCallback<HTMLButtonElement> = (element) =>
      element ? triggerCleanup : undefined;
    const closeRef: RefCallback<HTMLButtonElement> = (element) =>
      element ? closeCleanup : undefined;
    const view = renderDirect(
      <Dialog open onOpenChange={vi.fn()}>
        <DialogTrigger ref={triggerRef}>Cleanup trigger</DialogTrigger>
        <DialogContent title="Cleanup refs">
          <DialogClose ref={closeRef}>Cleanup close</DialogClose>
        </DialogContent>
      </Dialog>,
    );
    const triggerBeforeUnmount = triggerCleanup.mock.calls.length;
    const closeBeforeUnmount = closeCleanup.mock.calls.length;

    act(() => view.root.render(null));

    expect(triggerCleanup).toHaveBeenCalledTimes(triggerBeforeUnmount + 1);
    expect(closeCleanup).toHaveBeenCalledTimes(closeBeforeUnmount + 1);
  });

  it("owns autofocus and close completion without a modal overlay", async () => {
    const onClosed = vi.fn();
    function NonModalHarness() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onOpenChange={setOpen} modal={false}>
          <DialogContent title="Non-modal" onClosed={onClosed}>
            <input data-testid="non-modal-input" autoFocus />
          </DialogContent>
        </Dialog>
      );
    }
    renderDirect(<StrictMode><NonModalHarness /></StrictMode>);
    expect(screen.getByTestId("non-modal-input")).toHaveFocus();

    fireEvent.click(closeButton());
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("authenticates a current uncontrolled non-modal DialogTrigger close", async () => {
    const onClosed = vi.fn();
    renderDirect(
      <StrictMode>
        <Dialog defaultOpen modal={false}>
          <DialogTrigger type="reset">Toggle dialog</DialogTrigger>
          <DialogContent title="Uncontrolled non-modal" onClosed={onClosed}>
            <input autoFocus />
          </DialogContent>
        </Dialog>
      </StrictMode>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle dialog" }));
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("authenticates non-modal focus-outside dismissal", async () => {
    const onClosed = vi.fn();
    function NonModalFocusHarness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" data-testid="outside-focus">Outside</button>
          <Dialog open={open} onOpenChange={setOpen} modal={false}>
            <DialogContent title="Non-modal focus" onClosed={onClosed}>
              <input data-testid="non-modal-focus-input" autoFocus />
            </DialogContent>
          </Dialog>
        </>
      );
    }
    renderDirect(<StrictMode><NonModalFocusHarness /></StrictMode>);

    act(() => screen.getByTestId("outside-focus").focus());
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("preserves the page opener through a nested non-modal focus visit", async () => {
    const pageOpener = document.createElement("button");
    document.body.append(pageOpener);
    pageOpener.focus();
    const outerClosed = vi.fn();
    const innerClosed = vi.fn();
    function NestedNonModalHarness() {
      const [outerOpen, setOuterOpen] = useState(true);
      const [innerOpen, setInnerOpen] = useState(false);
      return (
        <Dialog open={outerOpen} onOpenChange={setOuterOpen}>
          <DialogContent title="Outer custody" onClosed={outerClosed}>
            <button type="button" onClick={() => setInnerOpen(true)}>Open nested</button>
            <Dialog open={innerOpen} onOpenChange={setInnerOpen} modal={false}>
              <DialogContent title="Inner custody" onClosed={innerClosed}>
                <input data-testid="inner-custody-input" autoFocus />
              </DialogContent>
            </Dialog>
          </DialogContent>
        </Dialog>
      );
    }
    renderDirect(<StrictMode><NestedNonModalHarness /></StrictMode>);
    const innerOpener = screen.getByRole("button", { name: "Open nested" });

    fireEvent.click(innerOpener);
    expect(screen.getByTestId("inner-custody-input")).toHaveFocus();
    fireEvent.click(closeButton(screen.getByRole("dialog", { name: "Inner custody" })));
    await flushTasks();
    expect(innerOpener).toHaveFocus();
    expect(innerClosed).toHaveBeenCalledOnce();

    fireEvent.click(closeButton(screen.getByRole("dialog", { name: "Outer custody" })));
    await flushTasks();
    expect(pageOpener).toHaveFocus();
    expect(outerClosed).toHaveBeenCalledOnce();
  });

  it("restores the exact pre-existing body pointer style", async () => {
    const previousPointerEvents = document.body.style.pointerEvents;
    document.body.style.pointerEvents = "auto";
    try {
      renderDirect(
        <StrictMode>
          <ControlledDialog><input autoFocus /></ControlledDialog>
        </StrictMode>,
      );

      fireEvent.click(closeButton());
      await flushTasks();

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.body.style.pointerEvents).toBe("auto");
    } finally {
      document.body.style.pointerEvents = previousPointerEvents;
    }
  });

  it("keeps an authenticated transition through a deferred controlled close", () => {
    vi.useFakeTimers();
    const onClosed = vi.fn();
    function DeferredCloseHarness() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onOpenChange={(next) => setTimeout(() => setOpen(next), 10)}>
          <DialogContent title="Deferred close" onClosed={onClosed}>
            <input autoFocus />
          </DialogContent>
        </Dialog>
      );
    }
    renderDirect(<StrictMode><DeferredCloseHarness /></StrictMode>);
    act(() => vi.runOnlyPendingTimers());

    fireEvent.click(closeButton());
    act(() => vi.advanceTimersByTime(10));
    act(() => vi.runOnlyPendingTimers());

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("disconnects every document observer when an open root finally unmounts", async () => {
    const documentObservers = new Set<MutationObserver>();
    const disconnected = new Set<MutationObserver>();
    const nativeObserve = MutationObserver.prototype.observe;
    const nativeDisconnect = MutationObserver.prototype.disconnect;
    vi.spyOn(MutationObserver.prototype, "observe").mockImplementation(function (
      this: MutationObserver,
      target,
      options,
    ) {
      if (target === document) documentObservers.add(this);
      return nativeObserve.call(this, target, options);
    });
    vi.spyOn(MutationObserver.prototype, "disconnect").mockImplementation(function (
      this: MutationObserver,
    ) {
      disconnected.add(this);
      return nativeDisconnect.call(this);
    });
    const view = renderDirect(
      <StrictMode>
        <ControlledDialog><input autoFocus /></ControlledDialog>
      </StrictMode>,
    );

    act(() => view.root.unmount());
    view.host.remove();
    directViews.splice(directViews.indexOf(view), 1);
    await act(() => Promise.resolve());

    expect(documentObservers.size).toBeGreaterThan(0);
    expect([...documentObservers].every((observer) => disconnected.has(observer))).toBe(true);
  });

  it("processes bounded mutation batches and disconnects on terminal invalidation", async () => {
    const documentObservers = new Set<MutationObserver>();
    const disconnected = new Set<MutationObserver>();
    const nativeObserve = MutationObserver.prototype.observe;
    const nativeDisconnect = MutationObserver.prototype.disconnect;
    vi.spyOn(MutationObserver.prototype, "observe").mockImplementation(function (
      this: MutationObserver,
      target,
      options,
    ) {
      if (target === document) documentObservers.add(this);
      return nativeObserve.call(this, target, options);
    });
    vi.spyOn(MutationObserver.prototype, "disconnect").mockImplementation(function (
      this: MutationObserver,
    ) {
      disconnected.add(this);
      return nativeDisconnect.call(this);
    });
    renderDirect(
      <StrictMode>
        <ControlledDialog><input data-testid="journal-input" autoFocus /></ControlledDialog>
      </StrictMode>,
    );
    const activeObserver = [...documentObservers].find((observer) => !disconnected.has(observer));
    expect(activeObserver).toBeDefined();
    const input = screen.getByTestId("journal-input");
    for (let batch = 0; batch < 20; batch++) {
      input.setAttribute("data-batch", String(batch));
      await act(() => Promise.resolve());
    }
    expect(disconnected.has(activeObserver!)).toBe(false);

    closeButton().setAttribute("aria-label", "Invalid");
    await act(() => Promise.resolve());

    expect(disconnected.has(activeObserver!)).toBe(true);
    expect(activeObserver!.takeRecords()).toHaveLength(0);
  });

  it("renders a closed dialog tree without a browser document", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    if (!descriptor) throw new Error("The test environment did not provide document");
    Reflect.deleteProperty(globalThis, "document");
    try {
      expect(() => renderToString(
        <Dialog open={false}>
          <DialogContent title="Server-safe"><input /></DialogContent>
        </Dialog>,
      )).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, "document", descriptor);
    }
  });

  it("preserves the exact Close label, classes, body focus order, and conditional description", () => {
    renderDirect(
      <StrictMode>
        <ControlledDialog title="Exact title">
          <button type="button" data-focus-skip>Skipped</button>
          <input data-testid="first-body-control" autoFocus />
        </ControlledDialog>
      </StrictMode>,
    );
    const close = closeButton();
    expect(close).toHaveAccessibleName("Close");
    expect(close).toHaveClass("icon-btn", "-mr-2", "-mt-1", "h-8", "w-8", "shrink-0");
    expect(dialog()).toHaveAccessibleName("Exact title");
    expect(dialog()).toHaveAccessibleDescription("Exact title");
    expect(screen.getByTestId("first-body-control")).toHaveFocus();
  });
});

describe("lazyOnFirstUse", () => {
  it("mounts a component in the same commit once a sibling from its module has loaded it", async () => {
    const mod = {
      Shortcuts: () => <p data-testid="shortcuts">shortcuts</p>,
      NameVersion: () => <p data-testid="name-version">name version</p>,
    };
    const load = vi.fn(() => Promise.resolve(mod));
    const Shortcuts = lazyOnFirstUse(load, (m) => m.Shortcuts);
    const NameVersion = lazyOnFirstUse(load, (m) => m.NameVersion);

    render(<Shortcuts />);
    expect(await screen.findByTestId("shortcuts")).toBeInTheDocument();
    render(<NameVersion />);
    expect(screen.getByTestId("name-version")).toBeInTheDocument();
  });
});
