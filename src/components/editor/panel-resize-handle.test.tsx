// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect, type ComponentProps, type PointerEvent as ReactPointerEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  PanelResizeHandle,
  PANEL_DEFAULT,
  PANEL_MAX,
  PANEL_MIN,
  clampPanelWidth,
  panelMaxFor,
  parseStoredPanelWidth,
} from "./panel-resize-handle";

const setPointerCapture = vi.fn();
const releasePointerCapture = vi.fn();

type HandlePointerProps = Required<
  Pick<ComponentProps<"div">, "onPointerMove" | "onPointerUp" | "onPointerCancel" | "onLostPointerCapture">
>;

function mount(props: Partial<ComponentProps<typeof PanelResizeHandle>> = {}) {
  const onResize = vi.fn();
  const onReset = vi.fn();
  render(<PanelResizeHandle width={PANEL_DEFAULT} min={PANEL_MIN} max={PANEL_MAX} onResize={onResize} onReset={onReset} {...props} />);
  return { handle: screen.getByTestId("panel-resize-handle"), onResize, onReset };
}

const drag = (handle: HTMLElement, from: number, to: number, pointerId = 1) => {
  fireEvent.pointerDown(handle, { clientX: from, pointerId, button: 0, pointerType: "mouse" });
  fireEvent.pointerMove(handle, { clientX: to, pointerId, pointerType: "mouse" });
};

function capturePointerHandlers(handle: HTMLElement): HandlePointerProps {
  const propsKey = Object.keys(handle).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the resize handle");
  const props = (handle as unknown as Record<string, HandlePointerProps | undefined>)[propsKey];
  if (!props?.onPointerMove || !props.onPointerUp || !props.onPointerCancel || !props.onLostPointerCapture) {
    throw new Error("React pointer handlers were not attached to the resize handle");
  }
  return props;
}

function capturedPointerEvent(
  target: HTMLElement,
  pointerId: number,
  clientX = 0,
): ReactPointerEvent<HTMLDivElement> {
  return { currentTarget: target, pointerId, clientX } as ReactPointerEvent<HTMLDivElement>;
}

function ResizeBoundary({
  instance,
  present = true,
  width = PANEL_DEFAULT,
  onResize,
  onReset,
  boundary = 0,
  onBoundary,
}: {
  instance: string;
  present?: boolean;
  width?: number;
  onResize: (width: number) => void;
  onReset: () => void;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  if (!present) return null;
  return (
    <PanelResizeHandle
      key={instance}
      width={width}
      min={PANEL_MIN}
      max={PANEL_MAX}
      onResize={onResize}
      onReset={onReset}
    />
  );
}

beforeEach(() => {
  // jsdom has PointerEvent but no pointer capture; the handle must cope with either.
  Element.prototype.setPointerCapture = setPointerCapture;
  Element.prototype.releasePointerCapture = releasePointerCapture;
});

afterEach(() => {
  cleanup();
  Element.prototype.setPointerCapture = setPointerCapture;
  Element.prototype.releasePointerCapture = releasePointerCapture;
  setPointerCapture.mockReset();
  releasePointerCapture.mockReset();
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

describe("PanelResizeHandle", () => {
  it("is a focusable vertical separator that reports the current width", () => {
    const { handle } = mount();
    expect(handle).toHaveAttribute("role", "separator");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-label", "Resize panel");
    expect(handle).toHaveAttribute("aria-valuemin", String(PANEL_MIN));
    expect(handle).toHaveAttribute("aria-valuemax", String(PANEL_MAX));
    expect(handle).toHaveAttribute("aria-valuenow", "340");
    expect(handle).toHaveAttribute("tabindex", "0");
    expect(handle).toHaveClass("cursor-col-resize");
    handle.focus();
    expect(handle).toHaveFocus();
  });

  it("ArrowLeft widens by 16 px and ArrowRight narrows by 16 px", () => {
    const { handle, onResize } = mount();
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenLastCalledWith(356);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onResize).toHaveBeenLastCalledWith(324);
    expect(onResize).toHaveBeenCalledTimes(2);
  });

  it("Shift+Arrow moves by 64 px", () => {
    const { handle, onResize } = mount();
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(onResize).toHaveBeenLastCalledWith(404);
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    // 340 - 64 = 276 lands under the minimum and is clamped.
    expect(onResize).toHaveBeenLastCalledWith(PANEL_MIN);
  });

  it("Home and End jump to the limits", () => {
    const { handle, onResize } = mount({ min: 300, max: 600 });
    fireEvent.keyDown(handle, { key: "Home" });
    expect(onResize).toHaveBeenLastCalledWith(300);
    fireEvent.keyDown(handle, { key: "End" });
    expect(onResize).toHaveBeenLastCalledWith(600);
  });

  it("Enter and double-click reset; other keys are ignored", () => {
    const { handle, onResize, onReset } = mount();
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(onReset).toHaveBeenCalledTimes(1);
    fireEvent.doubleClick(handle);
    expect(onReset).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    fireEvent.keyDown(handle, { key: "a" });
    expect(onResize).not.toHaveBeenCalled();
  });

  it("keyboard steps are clamped into [min, max]", () => {
    const { handle, onResize } = mount({ width: 290 });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onResize).toHaveBeenLastCalledWith(PANEL_MIN);
    cleanup();
    const top = mount({ width: 700 });
    fireEvent.keyDown(top.handle, { key: "ArrowLeft", shiftKey: true });
    expect(top.onResize).toHaveBeenLastCalledWith(PANEL_MAX);
  });

  it("dragging left widens the panel by the distance moved", () => {
    const { handle, onResize } = mount();
    drag(handle, 800, 700);
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(onResize).toHaveBeenLastCalledWith(440);
    fireEvent.pointerMove(handle, { clientX: 780, pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith(360);
    fireEvent.pointerUp(handle, { clientX: 780, pointerId: 1 });
    expect(releasePointerCapture).toHaveBeenCalledWith(1);
    // After release, moves no longer resize.
    fireEvent.pointerMove(handle, { clientX: 500, pointerId: 1 });
    expect(onResize).toHaveBeenCalledTimes(2);
  });

  it("drags are clamped at both ends", () => {
    const { handle, onResize } = mount();
    drag(handle, 800, 200);
    expect(onResize).toHaveBeenLastCalledWith(PANEL_MAX);
    fireEvent.pointerMove(handle, { clientX: 1400, pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith(PANEL_MIN);
  });

  it("sets a column-resize cursor and disables selection on the body only while dragging", () => {
    const { handle } = mount();
    expect(handle).not.toHaveAttribute("data-dragging");
    fireEvent.pointerDown(handle, { clientX: 800, pointerId: 2, pointerType: "touch" });
    expect(handle).toHaveAttribute("data-dragging", "true");
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");
    fireEvent.pointerCancel(handle, { pointerId: 2 });
    expect(handle).not.toHaveAttribute("data-dragging");
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("ignores secondary mouse buttons and other pointers during a drag", () => {
    const { handle, onResize } = mount();
    fireEvent.pointerDown(handle, { clientX: 800, pointerId: 1, button: 2, pointerType: "mouse" });
    fireEvent.pointerMove(handle, { clientX: 700, pointerId: 1, pointerType: "mouse" });
    expect(onResize).not.toHaveBeenCalled();
    drag(handle, 800, 760, 3);
    expect(onResize).toHaveBeenLastCalledWith(380);
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 4, button: 0, pointerType: "touch" });
    fireEvent.pointerMove(handle, { clientX: 100, pointerId: 4 });
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(setPointerCapture).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(handle, { clientX: 740, pointerId: 3 });
    expect(onResize).toHaveBeenLastCalledWith(400);
  });

  it("freezes the accepted drag geometry, callback, and limits across rerenders", () => {
    const oldResize = vi.fn();
    const newResize = vi.fn();
    const onReset = vi.fn();
    const view = render(
      <PanelResizeHandle width={PANEL_DEFAULT} min={PANEL_MIN} max={400} onResize={oldResize} onReset={onReset} />,
    );
    const handle = screen.getByTestId("panel-resize-handle");
    fireEvent.pointerDown(handle, { clientX: 800, pointerId: 9, button: 0, pointerType: "mouse" });
    const queuedHandlers = capturePointerHandlers(handle);

    view.rerender(<PanelResizeHandle width={600} min={500} max={620} onResize={newResize} onReset={onReset} />);
    act(() => {
      queuedHandlers.onPointerMove(capturedPointerEvent(handle, 9, 700));
    });
    expect(oldResize).toHaveBeenCalledOnce();
    expect(oldResize).toHaveBeenCalledWith(400);
    expect(newResize).not.toHaveBeenCalled();

    fireEvent.pointerMove(handle, { clientX: 780, pointerId: 9 });
    expect(oldResize).toHaveBeenLastCalledWith(360);
    expect(newResize).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 9 });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(newResize).toHaveBeenCalledWith(616);
  });

  it.each([
    ["pointer up", (handle: HTMLElement, pointerId: number) => fireEvent.pointerUp(handle, { pointerId })],
    ["pointer cancel", (handle: HTMLElement, pointerId: number) => fireEvent.pointerCancel(handle, { pointerId })],
    [
      "lost pointer capture",
      (handle: HTMLElement, pointerId: number) => fireEvent.lostPointerCapture(handle, { pointerId }),
    ],
  ])("makes duplicate terminal events inert after %s", (_, terminal) => {
    document.body.style.cursor = "wait";
    document.body.style.userSelect = "text";
    const { handle } = mount();
    fireEvent.pointerDown(handle, { clientX: 800, pointerId: 12, button: 0, pointerType: "mouse" });

    terminal(handle, 12);
    fireEvent.pointerUp(handle, { pointerId: 12 });
    fireEvent.pointerCancel(handle, { pointerId: 12 });
    fireEvent.lostPointerCapture(handle, { pointerId: 12 });

    expect(releasePointerCapture).toHaveBeenCalledOnce();
    expect(releasePointerCapture).toHaveBeenCalledWith(12);
    expect(handle).not.toHaveAttribute("data-dragging");
    expect(document.body.style.cursor).toBe("wait");
    expect(document.body.style.userSelect).toBe("text");
  });

  it("retires a replaced handle at the parent layout boundary and leaves its replacement usable", async () => {
    const oldResize = vi.fn();
    const oldReset = vi.fn();
    const currentResize = vi.fn();
    const currentReset = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    document.body.style.cursor = "help";
    document.body.style.userSelect = "text";

    try {
      await act(async () => {
        root.render(<ResizeBoundary instance="old" onResize={oldResize} onReset={oldReset} />);
      });
      const oldHandle = screen.getByTestId("panel-resize-handle");
      fireEvent.pointerDown(oldHandle, { clientX: 800, pointerId: 17, button: 0, pointerType: "mouse" });
      const oldHandlers = capturePointerHandlers(oldHandle);
      expect(document.body.style.cursor).toBe("col-resize");
      expect(document.body.style.userSelect).toBe("none");

      let stylesAtBoundary: [string, string] | undefined;
      let releasesAtBoundary = -1;
      await act(async () => {
        root.render(
          <ResizeBoundary
            instance="current"
            width={500}
            onResize={currentResize}
            onReset={currentReset}
            boundary={1}
            onBoundary={() => {
              stylesAtBoundary = [document.body.style.cursor, document.body.style.userSelect];
              releasesAtBoundary = releasePointerCapture.mock.calls.length;
            }}
          />,
        );
      });

      const currentHandle = screen.getByTestId("panel-resize-handle");
      expect(currentHandle).not.toBe(oldHandle);
      expect(stylesAtBoundary).toEqual(["help", "text"]);
      expect(releasesAtBoundary).toBe(1);
      expect(releasePointerCapture).toHaveBeenNthCalledWith(1, 17);
      expect(releasePointerCapture.mock.contexts[0]).toBe(oldHandle);

      fireEvent.pointerDown(currentHandle, { clientX: 800, pointerId: 17, button: 0, pointerType: "mouse" });
      const currentHandlers = capturePointerHandlers(currentHandle);
      act(() => {
        const staleEvent = capturedPointerEvent(oldHandle, 17, 100);
        oldHandlers.onPointerMove(staleEvent);
        oldHandlers.onPointerUp(staleEvent);
        oldHandlers.onPointerCancel(staleEvent);
        oldHandlers.onLostPointerCapture(staleEvent);
      });
      expect(oldResize).not.toHaveBeenCalled();
      expect(oldReset).not.toHaveBeenCalled();
      expect(currentResize).not.toHaveBeenCalled();
      expect(currentReset).not.toHaveBeenCalled();
      expect(currentHandle).toHaveAttribute("data-dragging", "true");
      expect(document.body.style.cursor).toBe("col-resize");
      expect(document.body.style.userSelect).toBe("none");
      expect(releasePointerCapture).toHaveBeenCalledTimes(1);

      fireEvent.pointerMove(currentHandle, { clientX: 760, pointerId: 17 });
      expect(currentResize).toHaveBeenCalledOnce();
      expect(currentResize).toHaveBeenLastCalledWith(540);
      fireEvent.pointerUp(currentHandle, { pointerId: 17 });
      act(() => {
        const duplicate = capturedPointerEvent(currentHandle, 17);
        currentHandlers.onPointerCancel(duplicate);
        currentHandlers.onLostPointerCapture(duplicate);
      });
      expect(releasePointerCapture).toHaveBeenCalledTimes(2);
      expect(releasePointerCapture).toHaveBeenNthCalledWith(2, 17);
      expect(releasePointerCapture.mock.contexts[1]).toBe(currentHandle);
      expect(document.body.style.cursor).toBe("help");
      expect(document.body.style.userSelect).toBe("text");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("retires a removed handle before the parent layout boundary without letting it disturb a later drag", async () => {
    const oldResize = vi.fn();
    const oldReset = vi.fn();
    const currentResize = vi.fn();
    const currentReset = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    document.body.style.cursor = "crosshair";
    document.body.style.userSelect = "all";

    try {
      await act(async () => {
        root.render(<ResizeBoundary instance="old" onResize={oldResize} onReset={oldReset} />);
      });
      const oldHandle = screen.getByTestId("panel-resize-handle");
      fireEvent.pointerDown(oldHandle, { clientX: 700, pointerId: 29, button: 0, pointerType: "mouse" });
      const oldHandlers = capturePointerHandlers(oldHandle);

      let stylesAtBoundary: [string, string] | undefined;
      await act(async () => {
        root.render(
          <ResizeBoundary
            instance="old"
            present={false}
            onResize={oldResize}
            onReset={oldReset}
            boundary={1}
            onBoundary={() => {
              stylesAtBoundary = [document.body.style.cursor, document.body.style.userSelect];
            }}
          />,
        );
      });

      expect(stylesAtBoundary).toEqual(["crosshair", "all"]);
      expect(releasePointerCapture).toHaveBeenCalledOnce();
      expect(releasePointerCapture.mock.contexts[0]).toBe(oldHandle);
      act(() => {
        oldHandlers.onPointerMove(capturedPointerEvent(oldHandle, 29, 0));
      });
      expect(oldResize).not.toHaveBeenCalled();

      await act(async () => {
        root.render(
          <ResizeBoundary instance="current" width={420} onResize={currentResize} onReset={currentReset} boundary={2} />,
        );
      });
      const currentHandle = screen.getByTestId("panel-resize-handle");
      fireEvent.pointerDown(currentHandle, { clientX: 700, pointerId: 29, button: 0, pointerType: "touch" });
      fireEvent.pointerMove(currentHandle, { clientX: 650, pointerId: 29, pointerType: "touch" });
      expect(currentResize).toHaveBeenLastCalledWith(470);
      fireEvent.pointerCancel(currentHandle, { pointerId: 29, pointerType: "touch" });

      act(() => {
        const staleTerminal = capturedPointerEvent(oldHandle, 29);
        oldHandlers.onPointerUp(staleTerminal);
        oldHandlers.onPointerCancel(staleTerminal);
        oldHandlers.onLostPointerCapture(staleTerminal);
      });
      expect(releasePointerCapture).toHaveBeenCalledTimes(2);
      expect(document.body.style.cursor).toBe("crosshair");
      expect(document.body.style.userSelect).toBe("all");

      fireEvent.pointerDown(currentHandle, { clientX: 700, pointerId: 29, button: 0, pointerType: "pen" });
      fireEvent.pointerMove(currentHandle, { clientX: 680, pointerId: 29, pointerType: "pen" });
      fireEvent.pointerUp(currentHandle, { pointerId: 29, pointerType: "pen" });
      fireEvent.keyDown(currentHandle, { key: "ArrowLeft" });
      fireEvent.doubleClick(currentHandle);
      expect(currentResize).toHaveBeenNthCalledWith(2, 440);
      expect(currentResize).toHaveBeenNthCalledWith(3, 436);
      expect(currentReset).toHaveBeenCalledOnce();
      expect(releasePointerCapture).toHaveBeenCalledTimes(3);
      expect(releasePointerCapture.mock.contexts.slice(1)).toEqual([currentHandle, currentHandle]);
      expect(oldResize).not.toHaveBeenCalled();
      expect(oldReset).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps best-effort dragging usable when pointer capture methods are unsupported", () => {
    Reflect.deleteProperty(Element.prototype, "setPointerCapture");
    const withoutSet = mount();
    fireEvent.pointerDown(withoutSet.handle, { clientX: 800, pointerId: 41, button: 0, pointerType: "mouse" });
    fireEvent.pointerMove(withoutSet.handle, { clientX: 760, pointerId: 41 });
    fireEvent.pointerUp(withoutSet.handle, { pointerId: 41 });
    expect(withoutSet.onResize).toHaveBeenCalledWith(380);
    expect(releasePointerCapture).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");

    cleanup();
    Element.prototype.setPointerCapture = setPointerCapture;
    const withoutRelease = mount();
    fireEvent.pointerDown(withoutRelease.handle, { clientX: 800, pointerId: 42, button: 0, pointerType: "touch" });
    Reflect.deleteProperty(Element.prototype, "releasePointerCapture");
    fireEvent.pointerMove(withoutRelease.handle, { clientX: 740, pointerId: 42 });
    fireEvent.lostPointerCapture(withoutRelease.handle, { pointerId: 42 });
    fireEvent.pointerCancel(withoutRelease.handle, { pointerId: 42 });
    expect(withoutRelease.onResize).toHaveBeenCalledWith(400);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });
});

describe("panel width helpers", () => {
  it("panelMaxFor is 720 px or 60 % of the viewport, never below the minimum", () => {
    expect(panelMaxFor(1440)).toBe(720);
    expect(panelMaxFor(1200)).toBe(720);
    expect(panelMaxFor(1199)).toBe(719);
    expect(panelMaxFor(1024)).toBe(614);
    expect(panelMaxFor(100)).toBe(PANEL_MIN);
  });

  it("clampPanelWidth rounds and clamps", () => {
    expect(clampPanelWidth(339.6, PANEL_MIN, PANEL_MAX)).toBe(340);
    expect(clampPanelWidth(10, PANEL_MIN, PANEL_MAX)).toBe(PANEL_MIN);
    expect(clampPanelWidth(5000, PANEL_MIN, PANEL_MAX)).toBe(PANEL_MAX);
  });

  it("parseStoredPanelWidth accepts whole pixels only", () => {
    expect(parseStoredPanelWidth("500")).toBe(500);
    expect(parseStoredPanelWidth(" 420 ")).toBe(420);
    expect(parseStoredPanelWidth(null)).toBeNull();
    expect(parseStoredPanelWidth("")).toBeNull();
    expect(parseStoredPanelWidth("abc")).toBeNull();
    expect(parseStoredPanelWidth("500.5")).toBeNull();
    expect(parseStoredPanelWidth("-300")).toBeNull();
    expect(parseStoredPanelWidth("1e3")).toBeNull();
    expect(parseStoredPanelWidth("{}")).toBeNull();
  });
});
