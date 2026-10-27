// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PANEL_BIG_STEP, PANEL_DEFAULT, PANEL_STEP, PanelResizeHandle } from "./panel-resize-handle";

afterEach(cleanup);

function Harness({ onResize, onReset }: { onResize?: (w: number) => void; onReset?: () => void }) {
  const [width, setWidth] = useState(400);
  return (
    <PanelResizeHandle
      width={width}
      min={280}
      max={720}
      onResize={(w) => { onResize?.(w); setWidth(w); }}
      onReset={() => { onReset?.(); setWidth(PANEL_DEFAULT); }}
    />
  );
}

describe("PanelResizeHandle real input", () => {
  it("honors synthetic keyboard events", () => {
    const onResize = vi.fn();
    const onReset = vi.fn();
    render(<Harness onResize={onResize} onReset={onReset} />);
    const handle = screen.getByRole("separator", { name: "Resize panel" });
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenLastCalledWith(400 + PANEL_STEP);
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(onResize).toHaveBeenLastCalledWith(400 + PANEL_STEP - PANEL_BIG_STEP);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(onResize).toHaveBeenLastCalledWith(280);
    fireEvent.keyDown(handle, { key: "End" });
    expect(onResize).toHaveBeenLastCalledWith(720);
    expect(handle.getAttribute("aria-valuenow")).toBe("720");
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(handle.getAttribute("aria-valuenow")).toBe(String(PANEL_DEFAULT));
  });

  it("ignores modified and already-handled keys", () => {
    const onResize = vi.fn();
    render(<Harness onResize={onResize} />);
    const handle = screen.getByRole("separator");
    fireEvent.keyDown(handle, { key: "ArrowLeft", ctrlKey: true });
    handle.addEventListener("keydown", (e) => e.preventDefault(), { capture: true });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onResize).not.toHaveBeenCalled();
  });

  it("honors a synthetic drag with frozen start geometry and restores body styles", () => {
    const onResize = vi.fn();
    document.body.style.cursor = "wait";
    render(<Harness onResize={onResize} />);
    const handle = screen.getByRole("separator");
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 500 });
    expect(handle.dataset.dragging).toBe("true");
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 450 });
    expect(onResize).toHaveBeenLastCalledWith(450);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400 });
    expect(onResize).toHaveBeenLastCalledWith(500);
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 0 });
    expect(onResize).toHaveBeenCalledTimes(2);
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(handle.dataset.dragging).toBeUndefined();
    expect(document.body.style.cursor).toBe("wait");
    expect(document.body.style.userSelect).toBe("");
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 });
    expect(onResize).toHaveBeenCalledTimes(2);
    document.body.style.cursor = "";
  });

  it("ends a drag on pointer cancel and restores styles on unmount", () => {
    const { unmount } = render(<Harness />);
    const handle = screen.getByRole("separator");
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 10 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(document.body.style.cursor).toBe("");
    fireEvent.pointerDown(handle, { pointerId: 3, button: 0, clientX: 10 });
    expect(document.body.style.cursor).toBe("col-resize");
    unmount();
    expect(document.body.style.cursor).toBe("");
  });

  it("resets on double-click", () => {
    const onReset = vi.fn();
    render(<Harness onReset={onReset} />);
    fireEvent.doubleClick(screen.getByRole("separator"));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
