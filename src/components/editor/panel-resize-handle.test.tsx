// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
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

beforeEach(() => {
  // jsdom has PointerEvent but no pointer capture; the handle must cope with either.
  Element.prototype.setPointerCapture = setPointerCapture;
  Element.prototype.releasePointerCapture = releasePointerCapture;
});

afterEach(() => {
  cleanup();
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
    fireEvent.pointerMove(handle, { clientX: 100, pointerId: 4 });
    expect(onResize).toHaveBeenCalledTimes(1);
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
