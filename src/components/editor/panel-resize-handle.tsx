"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

/** Side panel (Comments / Versions / Activity) width on desktop, in CSS pixels. */
export const PANEL_DEFAULT = 340;
export const PANEL_MIN = 280;
export const PANEL_MAX = 720;
export const PANEL_WIDTH_KEY = "markdoc:panelWidth";

/** Arrow keys move the edge by this many pixels (Shift: the larger step). */
export const PANEL_STEP = 16;
export const PANEL_BIG_STEP = 64;

/** Widest the panel may be for a window: 720 px or 60 % of the viewport, whichever is smaller. */
export function panelMaxFor(viewportWidth: number): number {
  return Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.floor(viewportWidth * 0.6)));
}

export function clampPanelWidth(width: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(width)));
}

/** A remembered width: whole pixels only; anything else (garbage, floats, negatives) is ignored. */
export function parseStoredPanelWidth(raw: string | null | undefined): number | null {
  if (typeof raw !== "string" || !/^\d{1,5}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

export interface PanelResizeHandleProps {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onReset: () => void;
}

interface Drag {
  pointerId: number;
  startX: number;
  startWidth: number;
}

/**
 * Thin vertical grip laid over the side panel's left border. Dragging it left widens the panel
 * (the panel sits on the right, so its left edge moves with the pointer); arrow keys nudge it,
 * Home/End jump to the limits and Enter or a double-click puts the default width back.
 */
export function PanelResizeHandle({ width, min, max, onResize, onReset }: PanelResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);
  const clamp = (w: number) => clampPanelWidth(w, min, max);

  // The panes hold iframes and CodeMirror, which would otherwise take the pointer and start a text
  // selection once it leaves the 8 px grip; pointer capture keeps the events, this keeps the look.
  useEffect(() => {
    if (!dragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Already released (the pointer was cancelled or the element lost capture).
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: width };
    setDragging(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture is best-effort; moves over the grip itself still resize.
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== e.pointerId) return;
    onResize(clamp(drag.current.startWidth + (drag.current.startX - e.clientX)));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? PANEL_BIG_STEP : PANEL_STEP;
    let next: number | null = null;
    switch (e.key) {
      case "ArrowLeft":
        next = width + step;
        break;
      case "ArrowRight":
        next = width - step;
        break;
      case "Home":
        next = min;
        break;
      case "End":
        next = max;
        break;
      case "Enter":
        e.preventDefault();
        onReset();
        return;
      default:
        return;
    }
    e.preventDefault();
    onResize(clamp(next));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      tabIndex={0}
      data-testid="panel-resize-handle"
      data-dragging={dragging || undefined}
      className="group/handle absolute inset-y-0 left-0 z-10 w-2 -translate-x-1/2 cursor-col-resize touch-none select-none outline-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => onReset()}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-1/2 w-px bg-line transition-[width,background-color] duration-100",
          "group-hover/handle:w-0.5 group-hover/handle:bg-accent group-focus-visible/handle:w-0.5 group-focus-visible/handle:bg-accent",
          dragging && "w-0.5 bg-accent",
        )}
      />
    </div>
  );
}
