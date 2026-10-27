"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "@/lib/utils";

/** Side panel (Comments / Versions / Activity) width on desktop, in CSS pixels. */
export const PANEL_DEFAULT = 340;
export const PANEL_MIN = 280;
export const PANEL_MAX = 720;
export const PANEL_WIDTH_KEY = "markdoc:panelWidth";

/** Arrow keys move the edge by this many pixels (Shift: the larger step). */
export const PANEL_STEP = 16;
export const PANEL_BIG_STEP = 64;

const HANDLE_CLASS =
  "group/handle absolute inset-y-0 left-0 z-10 w-2 -translate-x-1/2 cursor-col-resize touch-none select-none outline-none";
const LINE_CLASS =
  "absolute inset-y-0 left-1/2 w-px bg-line transition-[width,background-color] duration-100 group-hover/handle:w-0.5 group-hover/handle:bg-accent group-focus-visible/handle:w-0.5 group-focus-visible/handle:bg-accent";

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
  min: number;
  max: number;
  onResize: (width: number) => void;
  target: HTMLDivElement;
  body: HTMLElement;
  bodyCursor: string;
  bodyUserSelect: string;
}

function lineClass(dragging: boolean) {
  return cn(LINE_CLASS, dragging && "w-0.5 bg-accent");
}

function restoreBody(drag: Drag) {
  if (drag.body.style.cursor === "col-resize") drag.body.style.cursor = drag.bodyCursor;
  if (drag.body.style.userSelect === "none") drag.body.style.userSelect = drag.bodyUserSelect;
}

/**
 * Thin vertical grip laid over the side panel's left border. Dragging it left widens the panel
 * (the panel sits on the right, so its left edge moves with the pointer); arrow keys nudge it,
 * Home/End jump to the limits and Enter or a double-click puts the default width back.
 */
export function PanelResizeHandle({
  width,
  min,
  max,
  onResize,
  onReset,
}: PanelResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<Drag | null>(null);

  const finishDrag = (releaseCapture: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (releaseCapture) {
      try {
        if (drag.target.hasPointerCapture?.(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
      } catch {
        // Capture may already be gone.
      }
    }
    restoreBody(drag);
    setDragging(false);
  };

  useEffect(() => () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    try {
      drag.target.releasePointerCapture?.(drag.pointerId);
    } catch {
      // Capture may already be gone.
    }
    restoreBody(drag);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current || event.button !== 0) return;
    const target = event.currentTarget;
    const body = target.ownerDocument.body;
    const drag: Drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
      min,
      max,
      onResize,
      target,
      body,
      bodyCursor: body.style.cursor,
      bodyUserSelect: body.style.userSelect,
    };
    dragRef.current = drag;
    body.style.cursor = "col-resize";
    body.style.userSelect = "none";
    try {
      target.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is best-effort; moves over the separator still resize.
    }
    event.preventDefault();
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.onResize(clampPanelWidth(drag.startWidth + (drag.startX - event.clientX), drag.min, drag.max));
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    finishDrag(event.type !== "lostpointercapture");
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
    const { key } = event;
    if (key === "Enter") {
      event.preventDefault();
      onReset();
      return;
    }
    let next: number;
    if (key === "Home") next = min;
    else if (key === "End") next = max;
    else if (key === "ArrowLeft" || key === "ArrowRight") {
      next = width + (key === "ArrowLeft" ? 1 : -1) * (event.shiftKey ? PANEL_BIG_STEP : PANEL_STEP);
    } else return;
    event.preventDefault();
    onResize(clampPanelWidth(next, min, max));
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    onReset();
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
      className={HANDLE_CLASS}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    >
      <span aria-hidden className={lineClass(dragging)} />
    </div>
  );
}
