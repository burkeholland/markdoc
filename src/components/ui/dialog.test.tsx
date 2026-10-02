// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  StrictMode,
  Suspense,
  lazy,
  useState,
  type FormEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compile } from "tailwindcss";
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

  it.each([
    { unavailable: "hidden", strict: false },
    { unavailable: "fieldset-disabled", strict: false },
    { unavailable: "hidden", strict: true },
    { unavailable: "fieldset-disabled", strict: true },
  ])("skips the $unavailable first control on opening and recovery (StrictMode=$strict)", async ({ unavailable, strict }) => {
    const onClosed = vi.fn();
    const content = (
      <>
        {unavailable === "hidden"
          ? <div style={{ visibility: "hidden" }}><input data-testid="unavailable" /></div>
          : <fieldset disabled><input data-testid="unavailable" /></fieldset>}
        <input data-testid="available" />
      </>
    );
    const tree = (open: boolean) => {
      const harness = <Harness open={open} onClosed={onClosed}>{content}</Harness>;
      return strict ? <StrictMode>{harness}</StrictMode> : harness;
    };
    const { rerender } = render(tree(false));
    const opener = screen.getByTestId("more-menu");
    act(() => opener.focus());
    rerender(tree(true));
    const first = screen.getByTestId("unavailable");
    const second = screen.getByTestId("available");
    expect(first.getClientRects().length).toBeGreaterThan(0);
    expect(second).toHaveFocus();

    act(() => {
      opener.focus();
      // The modal trap returns focus immediately; leave it on body for the pending recovery.
      second.blur();
    });
    expect(document.activeElement).toBe(document.body);
    await flushTasks();
    expect(second).toHaveFocus();

    rerender(tree(false));
    await flushTasks();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
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

  it.each(["after", "before"] as const)(
    "closes a lazy dialog opened from a closing menu on the first Escape, loaded %s the menu returns focus (#2223)",
    async (load) => {
      const onClosed = vi.fn();
      let finishLoading!: () => void;
      const loaded = new Promise<void>((resolve) => { finishLoading = resolve; });
      function Shortcuts({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
        return (
          <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent title="Keyboard shortcuts" onClosed={onClosed}>
              <p>Command palette - Mod-Shift-P</p>
            </DialogContent>
          </Dialog>
        );
      }
      const LazyShortcuts = lazy(() => loaded.then(() => ({ default: Shortcuts })));
      function Shell() {
        const [menuOpen, setMenuOpen] = useState(true);
        const [open, setOpen] = useState(false);
        const [everOpened, setEverOpened] = useState(false);
        return (
          <>
            <button type="button" id="more-trigger" data-testid="more-menu" aria-controls={menuOpen ? "more-list" : undefined}>
              More
            </button>
            {menuOpen && (
              <div role="menu" id="more-list" aria-labelledby="more-trigger">
                <div
                  role="menuitem"
                  tabIndex={-1}
                  data-testid="shortcuts-item"
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    // The closing menu hands focus back to its trigger in a later task (Radix FocusScope).
                    const menuTrigger = document.getElementById("more-trigger");
                    setTimeout(() => menuTrigger?.focus(), 0);
                    setMenuOpen(false);
                    setOpen(true);
                    setEverOpened(true);
                  }}
                >
                  Keyboard shortcuts
                </div>
              </div>
            )}
            {everOpened && (
              <Suspense fallback={null}>
                <LazyShortcuts open={open} onOpenChange={setOpen} />
              </Suspense>
            )}
          </>
        );
      }
      render(<StrictMode><Shell /></StrictMode>);
      const trigger = screen.getByTestId("more-menu");
      const item = screen.getByTestId("shortcuts-item");
      act(() => item.focus());
      fireEvent.keyDown(item, { key: "Enter", code: "Enter" });
      expect(screen.queryByRole("menu")).toBeNull();

      if (load === "after") {
        await flushTasks();
        expect(trigger).toHaveFocus();
      }
      await act(async () => {
        finishLoading();
        await loaded;
      });
      // Synchronous lookup: `findByRole` waits a task, which would run the menu's queued focus first.
      const shortcuts = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
      if (load === "before") expect(trigger).not.toHaveFocus();
      await flushTasks();
      expect(shortcuts).toContainElement(document.activeElement as HTMLElement);

      fireEvent.keyDown(document.activeElement ?? document, { key: "Escape", code: "Escape" });
      await flushTasks();

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(trigger).toHaveFocus();
      expect(onClosed).toHaveBeenCalledOnce();
    },
  );

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

  // The people popover: its "Connect an AI agent" button has focus when the dialog opens, and the popover
  // closes in the same commit, so that button is gone when the dialog closes. The popover's trigger is
  // where focus belongs after the dialog. Radix hands focus back to it one task later (`handBackDelay`),
  // but not when focus moved into the dialog while the popover was still on the page (`null`); then the
  // trigger is found through the `aria-controls` Radix puts on it (`wired`).
  function PopoverShell({ handBackDelay = 0, wired = false }: { handBackDelay?: number | null; wired?: boolean }) {
    const [popoverOpen, setPopoverOpen] = useState(false);
    const [open, setOpen] = useState(false);
    return (
      <>
        <button
          type="button"
          data-testid="people"
          aria-controls={wired && popoverOpen ? "people-popover" : undefined}
          onClick={() => setPopoverOpen(true)}
        >
          People
        </button>
        {popoverOpen && (
          <div data-testid="popover" {...(wired ? { role: "dialog", id: "people-popover", "aria-label": "People" } : {})}>
            <button
              type="button"
              data-testid="connect"
              onClick={() => {
                const trigger = screen.getByTestId("people");
                if (handBackDelay !== null) setTimeout(() => trigger.focus(), handBackDelay);
                setPopoverOpen(false);
                setOpen(true);
              }}
            >
              Connect an AI agent
            </button>
          </div>
        )}
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent title="Connect an AI agent">
            <input data-testid="agent-input" autoFocus />
          </DialogContent>
        </Dialog>
      </>
    );
  }

  async function openFromPopover(wait: () => Promise<void> = flushTasks) {
    const people = screen.getByTestId("people");
    act(() => people.focus());
    fireEvent.click(people);
    const connect = screen.getByTestId("connect");
    act(() => connect.focus());
    fireEvent.click(connect);
    expect(screen.queryByTestId("popover")).toBeNull();
    expect(screen.getByTestId("agent-input")).toHaveFocus();
    await wait();
    return people;
  }

  it.each([
    { handBack: "hands focus back", strict: false },
    { handBack: "hands focus back", strict: true },
    { handBack: "does not hand focus back", strict: false },
    { handBack: "does not hand focus back", strict: true },
  ])(
    "returns focus to the popover's trigger every time when the button that opened the dialog is gone and the popover $handBack (StrictMode=$strict)",
    async ({ handBack, strict }) => {
      const shell = handBack === "hands focus back" ? <PopoverShell /> : <PopoverShell handBackDelay={null} wired />;
      render(strict ? <StrictMode>{shell}</StrictMode> : shell);
      for (const action of ["Escape", "Close", "Escape"] as const) {
        const people = await openFromPopover();
        // A hand-back took focus to the trigger; an open modal dialog takes it straight back.
        expect(screen.getByTestId("agent-input")).toHaveFocus();

        if (action === "Close") fireEvent.click(closeButton());
        else fireEvent.keyDown(screen.getByTestId("agent-input"), { key: "Escape", code: "Escape" });
        await flushTasks();

        expect(screen.queryByRole("dialog")).toBeNull();
        expect(people).toHaveFocus();
      }
    },
  );

  it("takes focus back from a hand-back that arrives long after the dialog opened, and closes on the first Escape", async () => {
    // The ⋮ menu hands focus back to its trigger on a later render, not in the next task.
    render(<PopoverShell handBackDelay={30} />);
    const people = await openFromPopover(() => act(() => new Promise<void>((resolve) => setTimeout(resolve, 60))));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("agent-input")).toHaveFocus();

    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape", code: "Escape" });
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(people).toHaveFocus();
  });

  it("returns focus to the button a shared menu handed it back to, not to the first button wired to that menu", async () => {
    // Publish and its arrow share one menu; only the menu knows which of them opened it.
    function SplitButtonShell() {
      const [menuOpen, setMenuOpen] = useState(true);
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" data-testid="publish" aria-controls={menuOpen ? "publish-menu" : undefined}>Publish</button>
          <button type="button" data-testid="publish-arrow" aria-controls={menuOpen ? "publish-menu" : undefined}>More publish options</button>
          {menuOpen && (
            <div role="menu" id="publish-menu">
              <div
                role="menuitem"
                tabIndex={-1}
                data-testid="connect-item"
                onClick={() => {
                  const arrow = screen.getByTestId("publish-arrow");
                  setTimeout(() => arrow.focus(), 0);
                  setMenuOpen(false);
                  setOpen(true);
                }}
              >
                Connect to GitHub
              </div>
            </div>
          )}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent title="Connect to GitHub">
              <button type="button">Sign in with GitHub</button>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    render(<SplitButtonShell />);
    const item = screen.getByTestId("connect-item");
    act(() => item.focus());
    fireEvent.click(item);
    await flushTasks();
    expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toHaveFocus();

    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape", code: "Escape" });
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("publish-arrow")).toHaveFocus();
  });

  it("falls back to the opener when the element focus was handed to is gone at close", async () => {
    const content = <input data-testid="version-name" autoFocus />;
    const { rerender } = render(<Harness open={false}>{content}</Harness>);
    const more = screen.getByTestId("more-menu");
    act(() => more.focus());
    rerender(<Harness open>{content}</Harness>);
    expect(screen.getByTestId("version-name")).toHaveFocus();
    const passing = document.createElement("button");
    document.body.append(passing);
    act(() => passing.focus());
    expect(screen.getByTestId("version-name")).toHaveFocus();
    passing.remove();

    rerender(<Harness open={false}>{content}</Harness>);
    await flushTasks();
    expect(more).toHaveFocus();
  });

  it.each(["Escape", "Close"] as const)(
    "returns to the page element that opened it on %s, not to a menu trigger that took focus while it was open",
    async (action) => {
      // Ctrl+/ from the editor while the ⋮ menu, closed a moment ago, still owes its trigger the focus.
      const content = <p>Command palette - Mod-Shift-P</p>;
      const { rerender } = render(<Harness open={false} title="Keyboard shortcuts">{content}</Harness>);
      const editor = document.createElement("div");
      editor.tabIndex = 0;
      document.body.append(editor);
      act(() => editor.focus());
      rerender(<Harness open title="Keyboard shortcuts">{content}</Harness>);
      await flushTasks();
      expect(dialog()).toContainElement(document.activeElement as HTMLElement);

      act(() => screen.getByTestId("more-menu").focus());
      expect(dialog()).toContainElement(document.activeElement as HTMLElement);

      if (action === "Close") fireEvent.click(closeButton());
      else fireEvent.keyDown(document.activeElement ?? document, { key: "Escape", code: "Escape" });
      rerender(<Harness open={false} title="Keyboard shortcuts">{content}</Harness>);
      await flushTasks();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(editor).toHaveFocus();
    },
  );

  it("leaves focus in a second dialog that opens outside the first one's tree", async () => {
    function Siblings() {
      const [second, setSecond] = useState(false);
      return (
        <>
          <Dialog open>
            <DialogContent title="First">
              <button type="button" onClick={() => setSecond(true)}>Open second</button>
            </DialogContent>
          </Dialog>
          <Dialog open={second} onOpenChange={setSecond}>
            <DialogContent title="Second">
              <input data-testid="second-input" />
            </DialogContent>
          </Dialog>
        </>
      );
    }
    render(<Siblings />);
    fireEvent.click(screen.getByRole("button", { name: "Open second" }));
    await flushTasks();
    expect(screen.getByTestId("second-input")).toHaveFocus();
  });
});

describe("DialogContent dismissal", () => {
  it.each(["Close", "Escape"] as const)(
    "closes once through %s and restores the opener once",
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

  it("finishes closing after the controlled root removes itself", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClosed = vi.fn();
    function ConditionalRootHarness() {
      const [open, setOpen] = useState(true);
      return open ? (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent title="Conditional root" onClosed={onClosed}>
            <input data-testid="conditional-root-input" autoFocus />
          </DialogContent>
        </Dialog>
      ) : null;
    }
    renderDirect(<StrictMode><ConditionalRootHarness /></StrictMode>);
    expect(screen.getByTestId("conditional-root-input")).toHaveFocus();

    fireEvent.click(closeButton());
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
    expect(onClosed).toHaveBeenCalledOnce();
    expect(document.querySelectorAll("[data-radix-focus-guard]")).toHaveLength(0);
  });

  it("closes an uncontrolled root through Close", async () => {
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
    fireEvent.click(closeButton());
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("lets an expanded combobox consume the first Escape before the second Escape closes", async () => {
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

  it("closes on an Escape dispatched to the document", async () => {
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

  it("renders an empty explicit description and restores the opener on close", async () => {
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

  it("closes on Escape after the description changes to empty", async () => {
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

  it("closes on an outside pointer and restores the opener", async () => {
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

  it("closes through inline callbacks recreated every render", async () => {
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

  it("runs the onClosed of the last open render, not the closing render's", async () => {
    const calls: string[] = [];
    function TokenHarness() {
      const [open, setOpen] = useState(true);
      const token = open ? "open" : "closed";
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent title="Close token" onClosed={() => calls.push(token)}>
            <input data-testid="token-input" />
          </DialogContent>
        </Dialog>
      );
    }
    renderDirect(<StrictMode><TokenHarness /></StrictMode>);

    fireEvent.click(closeButton());
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls).toEqual(["open"]);
  });

  it("stays open and keeps Close working when the controlled owner keeps it open", async () => {
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

  it("keeps body children direct and closes through an exported DialogClose", async () => {
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

  it("focuses the body and completes close without a modal overlay", async () => {
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

  it("closes an uncontrolled non-modal root through DialogTrigger", async () => {
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

  it("closes a non-modal root when focus moves outside", async () => {
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

  it("restores each opener through a nested non-modal dialog", async () => {
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

  it.each(["Escape", "Close"] as const)(
    "closes a nested modal dialog alone through %s and returns focus to the control that opened it",
    async (action) => {
      const pageOpener = document.createElement("button");
      document.body.append(pageOpener);
      pageOpener.focus();
      const outerClosed = vi.fn();
      const innerClosed = vi.fn();
      function NestedModalHarness() {
        const [outerOpen, setOuterOpen] = useState(true);
        const [innerOpen, setInnerOpen] = useState(false);
        return (
          <Dialog open={outerOpen} onOpenChange={setOuterOpen}>
            <DialogContent title="Outer modal" onClosed={outerClosed}>
              <input data-testid="outer-input" autoFocus />
              <button type="button" onClick={() => setInnerOpen(true)}>Open nested</button>
              <Dialog open={innerOpen} onOpenChange={setInnerOpen}>
                <DialogContent title="Inner modal" onClosed={innerClosed}>
                  <input data-testid="inner-input" autoFocus />
                </DialogContent>
              </Dialog>
            </DialogContent>
          </Dialog>
        );
      }
      renderDirect(<StrictMode><NestedModalHarness /></StrictMode>);
      const innerOpener = screen.getByRole("button", { name: "Open nested" });
      act(() => innerOpener.focus());
      fireEvent.click(innerOpener);
      const innerInput = screen.getByTestId("inner-input");
      expect(innerInput).toHaveFocus();
      await flushTasks();
      expect(innerInput).toHaveFocus();

      if (action === "Close") fireEvent.click(closeButton(screen.getByRole("dialog", { name: "Inner modal" })));
      else fireEvent.keyDown(innerInput, { key: "Escape", code: "Escape" });
      await flushTasks();

      expect(screen.queryByRole("dialog", { name: "Inner modal" })).toBeNull();
      expect(screen.getByRole("dialog", { name: "Outer modal" })).toBeInTheDocument();
      expect(innerOpener).toHaveFocus();
      expect(innerClosed).toHaveBeenCalledOnce();
      expect(outerClosed).not.toHaveBeenCalled();

      fireEvent.keyDown(innerOpener, { key: "Escape", code: "Escape" });
      await flushTasks();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(pageOpener).toHaveFocus();
      expect(outerClosed).toHaveBeenCalledOnce();
      expect(innerClosed).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "unmounted while open: focus goes to the opener, the page is unlocked and onClosed does not run (StrictMode=%s)",
    async (strict) => {
      const opener = document.createElement("button");
      document.body.append(opener);
      opener.focus();
      const onClosed = vi.fn();
      const tree = <ControlledDialog onClosed={onClosed} />;
      const view = renderDirect(strict ? <StrictMode>{tree}</StrictMode> : tree);
      expect(screen.getByTestId("dialog-input")).toHaveFocus();
      await flushTasks();
      expect(document.body.style.pointerEvents).toBe("none");
      expect(opener).toHaveAttribute("aria-hidden", "true");

      act(() => view.root.render(null));
      await flushTasks();

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(opener).toHaveFocus();
      expect(document.body.style.pointerEvents).toBe("");
      expect(document.body).not.toHaveAttribute("data-scroll-locked");
      expect(document.body.style.overflow).toBe("");
      expect(document.querySelectorAll("[data-radix-focus-guard]")).toHaveLength(0);
      expect(document.querySelectorAll("[aria-hidden], [inert]")).toHaveLength(0);
      expect(onClosed).not.toHaveBeenCalled();
    },
  );

  it("replaced through its key while open: the new body takes focus, no onClosed runs, and it still closes to the opener", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClosed = vi.fn();
    function KeyedHarness() {
      const [open, setOpen] = useState(true);
      const [step, setStep] = useState(1);
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent key={step} title={`Step ${step}`} onClosed={() => onClosed(step)}>
            <input data-testid={`step-${step}-input`} autoFocus />
            <button type="button" onClick={() => setStep(2)}>Next</button>
          </DialogContent>
        </Dialog>
      );
    }
    renderDirect(<StrictMode><KeyedHarness /></StrictMode>);
    expect(screen.getByTestId("step-1-input")).toHaveFocus();
    await flushTasks();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flushTasks();
    expect(screen.getByRole("dialog", { name: "Step 2" })).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByTestId("step-2-input")).toHaveFocus();
    expect(onClosed).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByTestId("step-2-input"), { key: "Escape", code: "Escape" });
    await flushTasks();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
    expect(onClosed.mock.calls).toEqual([[2]]);
  });

  it("closed and opened again before the first close has settled: both closes run onClosed and focus returns to the opener", async () => {
    // Radix reports a close one task after the dialog has unmounted. A dialog reopened inside that task
    // must not lose its own way back to the first close's late report.
    const onClosed = vi.fn();
    function ReopenHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" data-testid="toolbar-image" onClick={() => setOpen(true)}>Image</button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent title="Insert image" onClosed={onClosed}>
              <input data-testid="image-url" autoFocus />
            </DialogContent>
          </Dialog>
        </>
      );
    }
    renderDirect(<StrictMode><ReopenHarness /></StrictMode>);
    const opener = screen.getByTestId("toolbar-image");
    act(() => opener.focus());
    fireEvent.click(opener);
    expect(screen.getByTestId("image-url")).toHaveFocus();

    fireEvent.keyDown(screen.getByTestId("image-url"), { key: "Escape", code: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => opener.focus());
    fireEvent.click(opener);
    expect(screen.getByTestId("image-url")).toHaveFocus();
    await flushTasks();
    expect(onClosed).toHaveBeenCalledOnce();
    expect(screen.getByTestId("image-url")).toHaveFocus();

    fireEvent.keyDown(screen.getByTestId("image-url"), { key: "Escape", code: "Escape" });
    await flushTasks();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
    expect(onClosed).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "hands over to a second dialog from its onClosed: each onClosed runs once and focus ends on the first opener (StrictMode=%s)",
    async (strict) => {
      // Share closes, then opens "Connect an AI agent" from its onClosed. Each dialog keeps its own record
      // of the close, and the first dialog's late report must not take focus out of the second.
      const firstClosed = vi.fn();
      const secondClosed = vi.fn();
      function ChainHarness() {
        const [first, setFirst] = useState(false);
        const [second, setSecond] = useState(false);
        return (
          <>
            <button type="button" data-testid="share-button" onClick={() => setFirst(true)}>Share</button>
            <Dialog open={first} onOpenChange={setFirst}>
              <DialogContent
                title="Share"
                onClosed={() => {
                  firstClosed();
                  setSecond(true);
                }}
              >
                <button type="button" onClick={() => setFirst(false)}>Connect an AI agent</button>
              </DialogContent>
            </Dialog>
            <Dialog open={second} onOpenChange={setSecond}>
              <DialogContent title="Connect an AI agent" onClosed={secondClosed}>
                <input data-testid="agent-input" autoFocus />
              </DialogContent>
            </Dialog>
          </>
        );
      }
      renderDirect(strict ? <StrictMode><ChainHarness /></StrictMode> : <ChainHarness />);
      const share = screen.getByTestId("share-button");
      act(() => share.focus());
      fireEvent.click(share);
      await flushTasks();

      fireEvent.click(screen.getByRole("button", { name: "Connect an AI agent" }));
      await flushTasks();
      await flushTasks();
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(screen.getByTestId("agent-input")).toHaveFocus();
      expect(firstClosed).toHaveBeenCalledOnce();
      expect(secondClosed).not.toHaveBeenCalled();

      fireEvent.keyDown(screen.getByTestId("agent-input"), { key: "Escape", code: "Escape" });
      await flushTasks();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(share).toHaveFocus();
      expect(firstClosed).toHaveBeenCalledOnce();
      expect(secondClosed).toHaveBeenCalledOnce();
    },
  );

  it("runs onClosed when the owner closes it without Radix and keeps it mounted", async () => {
    const onClosed = vi.fn();
    function OwnCloseHarness() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent title="Own close" onClosed={onClosed}>
            <button type="button" onClick={() => setOpen(false)}>Insert</button>
          </DialogContent>
        </Dialog>
      );
    }
    renderDirect(<StrictMode><OwnCloseHarness /></StrictMode>);

    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    await flushTasks();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("restores the pre-existing body pointer style", async () => {
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

  it("completes a deferred controlled close", () => {
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

  it("keeps the Close label, classes, body focus order and fallback description", () => {
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

describe("DialogContent header wrapping", () => {
  const textCases = [
    { kind: "unbroken", title: "T".repeat(256), description: "D".repeat(320) },
    {
      kind: "multiword",
      title: "An ordinary dialog title with several words",
      description: "An explanation that keeps every word while wrapping beside the Close button.",
    },
    {
      kind: "literal markup",
      title: '<button tabindex="0">Not a control</button> & <em>not emphasis</em>',
      description: '<a href="/not-a-link">Plain text</a> & <img src="not-an-image" />',
    },
  ];
  const variants = [{ size: "normal", wide: false }, { size: "wide", wide: true }];
  const body = <><input data-testid="wrapping-input" autoFocus /><button type="button">Continue</button></>;

  function expectHeader(titleText: string, descriptionText: string | undefined, wide: boolean) {
    const content = dialog();
    const heading = screen.getByRole("heading", { level: 2, name: titleText });
    const description = content.querySelector("p");
    const group = heading.parentElement;
    const currentHeader = header();
    const close = closeButton();
    if (!description || !group) throw new Error("The dialog title group was not rendered");

    expect(content).toHaveAccessibleName(titleText);
    expect(content).toHaveAccessibleDescription(descriptionText ?? titleText);
    expect(content.className).toBe(`dialog animate-fade-in${wide ? " w-[min(94vw,760px)]" : ""}`);
    expect(heading.id).not.toBe("");
    expect(description.id).not.toBe("");
    expect(heading.id).not.toBe(description.id);
    expect(content).toHaveAttribute("aria-labelledby", heading.id);
    expect(content).toHaveAttribute("aria-describedby", description.id);
    expect(document.getElementById(heading.id)).toBe(heading);
    expect(document.getElementById(description.id)).toBe(description);
    expect(currentHeader.className).toBe("mb-4 flex items-start justify-between gap-4");
    expect(currentHeader).toHaveAttribute("data-focus-skip");
    expect(group.className).toBe("min-w-0");
    expect(heading.className).toBe("text-lg font-semibold text-ink wrap-anywhere");
    expect(description.className).toBe(
      descriptionText !== undefined ? "mt-1 text-sm text-ink-3 wrap-anywhere" : "sr-only",
    );
    if (descriptionText !== undefined) expect(description).toBeVisible();
    expect(heading.textContent).toBe(titleText);
    expect(description.textContent).toBe(descriptionText ?? titleText);
    expect(heading.children).toHaveLength(0);
    expect(description.children).toHaveLength(0);
    expect(heading.childNodes).toHaveLength(1);
    expect(description.childNodes).toHaveLength(descriptionText === "" ? 0 : 1);
    expect([...group.childNodes]).toEqual([heading, description]);
    expect([...currentHeader.childNodes]).toEqual([group, close]);
    expect([...content.childNodes]).toEqual([
      currentHeader, screen.getByTestId("wrapping-input"), screen.getByRole("button", { name: "Continue" }),
    ]);
    expect(close.className).toBe("icon-btn -mr-2 -mt-1 h-8 w-8 shrink-0");
    expect(close).toHaveAccessibleName("Close");
    expect(close).toBeEnabled();
    expect(close).toHaveAttribute("type", "button");
    expect([...content.querySelectorAll<HTMLElement>("*")].filter((element) => element.tabIndex >= 0)).toEqual([
      close, screen.getByTestId("wrapping-input"), screen.getByRole("button", { name: "Continue" }),
    ]);
    return { content, heading, description, group, close };
  }

  it.each(variants.flatMap((variant) => textCases.map((text) => ({ ...variant, ...text }))))(
    "preserves complete $kind text and header topology in $size dialogs",
    ({ title, description, wide }) => {
      renderDirect(
        <StrictMode>
          <Dialog defaultOpen><DialogContent title={title} description={description} wide={wide}>{body}</DialogContent></Dialog>
        </StrictMode>,
      );
      expectHeader(title, description, wide);
      expect(screen.getByTestId("wrapping-input")).toHaveFocus();
    },
  );

  it.each(variants.flatMap((variant) => [
    { ...variant, kind: "missing", description: undefined },
    { ...variant, kind: "empty", description: "" },
  ]))("preserves a $kind description in $size dialogs", ({ wide, description }) => {
    const title = textCases[0].title;
    renderDirect(
      <StrictMode>
        <Dialog defaultOpen><DialogContent title={title} description={description} wide={wide}>{body}</DialogContent></Dialog>
      </StrictMode>,
    );
    expectHeader(title, description, wide);
  });

  it.each(variants)(
    "keeps names and Radix references through text replacement and reopen in $size dialogs",
    async ({ wide }) => {
      const onClosed = vi.fn();
      const onOpenChange = vi.fn();
      const tree = (text: { title: string; description?: string }) => (
        <StrictMode>
          <Dialog onOpenChange={onOpenChange}>
            <DialogTrigger>Open dialog</DialogTrigger>
            <DialogContent {...text} wide={wide} onClosed={onClosed}>{body}</DialogContent>
          </Dialog>
        </StrictMode>
      );
      const view = renderDirect(tree(textCases[0]));
      const opener = screen.getByRole("button", { name: "Open dialog" });
      act(() => opener.focus());
      fireEvent.click(opener);
      const initial = expectHeader(textCases[0].title, textCases[0].description, wide);
      const titleId = initial.heading.id;
      const descriptionId = initial.description.id;

      for (const text of [
        textCases[2], textCases[1],
        { title: textCases[0].title, description: undefined },
        { title: textCases[0].title, description: "" },
        textCases[0],
      ]) {
        act(() => view.root.render(tree(text)));
        const current = expectHeader(text.title, text.description, wide);
        expect(current.content).toBe(initial.content);
        expect(current.heading.id).toBe(titleId);
        expect(current.description.id).toBe(descriptionId);
        expect(onClosed).not.toHaveBeenCalled();
        expect(onOpenChange.mock.calls).toEqual([[true]]);
        expect(screen.getByTestId("wrapping-input")).toHaveFocus();
      }

      fireEvent.click(closeButton());
      await flushTasks();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(onClosed).toHaveBeenCalledOnce();
      expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
      expect(opener).toHaveFocus();

      fireEvent.click(opener);
      const reopened = expectHeader(textCases[0].title, textCases[0].description, wide);
      expect(reopened.content).not.toBe(initial.content);
      expect(reopened.heading.id).toBe(titleId);
      expect(reopened.description.id).toBe(descriptionId);
      expect(onClosed).toHaveBeenCalledOnce();
      expect(onOpenChange.mock.calls).toEqual([[true], [false], [true]]);
      expect(screen.getByTestId("wrapping-input")).toHaveFocus();

      fireEvent.keyDown(screen.getByTestId("wrapping-input"), { key: "Escape", code: "Escape" });
      await flushTasks();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(onClosed).toHaveBeenCalledTimes(2);
      expect(onOpenChange.mock.calls).toEqual([[true], [false], [true], [false]]);
      expect(opener).toHaveFocus();
    },
  );

  it("does not schedule work, fetch or mutate DOM during passive header inspection", async () => {
    const { title, description } = textCases[0];
    renderDirect(
      <StrictMode>
        <Dialog defaultOpen><DialogContent title={title} description={description}>{body}</DialogContent></Dialog>
      </StrictMode>,
    );
    await flushTasks();
    const timeout = vi.spyOn(window, "setTimeout");
    const interval = vi.spyOn(window, "setInterval");
    const frame = vi.spyOn(window, "requestAnimationFrame");
    const microtask = vi.spyOn(window, "queueMicrotask");
    const fetch = vi.spyOn(globalThis, "fetch");
    const observer = new MutationObserver(() => {});
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    try {
      expectHeader(title, description, false);
      expectHeader(title, description, false);
      expect(observer.takeRecords()).toHaveLength(0);
      expect(timeout).not.toHaveBeenCalled();
      expect(interval).not.toHaveBeenCalled();
      expect(frame).not.toHaveBeenCalled();
      expect(microtask).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      observer.disconnect();
    }
  });

  it("emits anywhere wrapping, zero minimum width and unchanged Close sizing from installed Tailwind", async () => {
    const theme = readFileSync(createRequire(import.meta.url).resolve("tailwindcss/theme.css"), "utf8");
    const { build } = await compile(`${theme}\n@tailwind utilities;`);
    const css = build(["wrap-anywhere", "min-w-0", "shrink-0", "h-8", "w-8"]);
    expect(css).toMatch(/\.wrap-anywhere\s*\{\s*overflow-wrap:\s*anywhere;\s*\}/);
    expect(css).toMatch(/\.min-w-0\s*\{\s*min-width:\s*0px;\s*\}/);
    expect(css).toMatch(/\.shrink-0\s*\{\s*flex-shrink:\s*0;\s*\}/);
    expect(css).toContain("--spacing: 0.25rem;");
    expect(css).toMatch(/\.h-8\s*\{\s*height:\s*calc\(var\(--spacing\) \* 8\);\s*\}/);
    expect(css).toMatch(/\.w-8\s*\{\s*width:\s*calc\(var\(--spacing\) \* 8\);\s*\}/);
    expect(css).not.toMatch(/word-break:|text-overflow:|overflow:\s*(hidden|auto|scroll)/);
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
