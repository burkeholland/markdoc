// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Dialog, DialogContent } from "./dialog";
import { lazyOnFirstUse } from "@/components/editor/lazy-on-first-use";

// What `next/dynamic` is in the browser once its Next-specific wrapping is peeled away: `React.lazy` under a
// Suspense boundary — a component that suspends on its own first render even when its module is in.
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

// A dialog opened from the ⋮ menu with the keyboard (task #1349): the menu item is unmounted in the commit
// that opens the dialog and Radix's menu FocusScope hands focus back to the trigger in a setTimeout(0). A
// dialog whose content mounts after that — a lazily loaded chunk — had its `autoFocus` input robbed by that
// hand-back, and never learned who opened it. Focus is played by hand here: the trigger takes it right
// after the dialog has mounted, as the menu's timer did.
describe("DialogContent opening focus", () => {
  const flushTimers = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  let getClientRects: typeof Element.prototype.getClientRects;

  beforeEach(() => {
    // jsdom lays nothing out; `firstTabbable` treats a control without client rects as display:none.
    getClientRects = Element.prototype.getClientRects;
    Element.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
  });
  afterEach(() => {
    cleanup();
    Element.prototype.getClientRects = getClientRects;
  });

  function Harness({ open, children, title = "Name this version" }: { open: boolean; children?: React.ReactNode; title?: string }) {
    return (
      <>
        <button type="button" data-testid="more-menu">
          ⋮
        </button>
        <Dialog open={open}>
          <DialogContent title={title}>{children}</DialogContent>
        </Dialog>
      </>
    );
  }

  it("brings focus back to the autoFocus input when the closing menu focuses its trigger right after the dialog mounted", async () => {
    render(
      <Harness open>
        <input data-testid="version-name" autoFocus />
      </Harness>,
    );
    const input = screen.getByTestId("version-name");
    expect(input).toHaveFocus();

    act(() => screen.getByTestId("more-menu").focus());
    expect(screen.getByTestId("more-menu")).toHaveFocus();

    await flushTimers();
    expect(input).toHaveFocus();
  });

  it("hands focus back to whoever took it, the menu trigger, when the dialog closes — it never saw the menu item", async () => {
    const { rerender } = render(
      <Harness open>
        <input data-testid="version-name" autoFocus />
      </Harness>,
    );
    act(() => screen.getByTestId("more-menu").focus());
    await flushTimers();
    expect(screen.getByTestId("version-name")).toHaveFocus();

    rerender(<Harness open={false} />);
    await flushTimers();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("more-menu")).toHaveFocus();
  });

  it("keeps focus inside a dialog without an autoFocus control too, and still returns it to the trigger", async () => {
    const { rerender } = render(
      <Harness open title="Keyboard shortcuts">
        <p>Command palette — Mod-Shift-P</p>
      </Harness>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    act(() => screen.getByTestId("more-menu").focus());
    await flushTimers();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    rerender(<Harness open={false} />);
    await flushTimers();
    expect(screen.getByTestId("more-menu")).toHaveFocus();
  });

  it("leaves focus alone when the user has already moved it to another control of the dialog", async () => {
    render(
      <Harness open>
        <input data-testid="version-name" autoFocus />
        <input data-testid="second" />
      </Harness>,
    );
    act(() => screen.getByTestId("second").focus());
    await flushTimers();
    expect(screen.getByTestId("second")).toHaveFocus();
  });
});

describe("lazyOnFirstUse", () => {
  afterEach(cleanup);

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

    // Not the component that loaded the module: the ⋮ menu item that opened it is still mounted and focused
    // in this commit, and nothing has queued a focus change yet — the same as a static import.
    render(<NameVersion />);
    expect(screen.getByTestId("name-version")).toBeInTheDocument();
  });
});
