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

      // The closing menu hands focus back to its trigger in a later task (Radix FocusScope).
      const returnMenuFocus = () => act(() => trigger.focus());
      if (load === "after") returnMenuFocus();
      await act(async () => {
        finishLoading();
        await loaded;
      });
      const shortcuts = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
      if (load === "before") returnMenuFocus();
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
