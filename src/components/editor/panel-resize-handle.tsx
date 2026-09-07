"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
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

interface HandleAuthority {
  active: boolean;
  drag: DragOwner | null;
  stopDragging: () => void;
}

interface DragOwner {
  active: boolean;
  authority: HandleAuthority;
  pointerId: number;
  startX: number;
  startWidth: number;
  target: HTMLDivElement;
  onResize: (width: number) => void;
  min: number;
  max: number;
  captureHeld: boolean;
  body: HTMLElement;
  bodyCursor: string;
  bodyUserSelect: string;
  ownsBodyStyles: boolean;
}

let bodyStyleOwner: DragOwner | null = null;

function claimBodyStyles(owner: DragOwner) {
  const previousOwner = bodyStyleOwner;
  if (previousOwner?.ownsBodyStyles) {
    previousOwner.ownsBodyStyles = false;
    owner.bodyCursor = previousOwner.bodyCursor;
    owner.bodyUserSelect = previousOwner.bodyUserSelect;
  } else {
    owner.bodyCursor = owner.body.style.cursor;
    owner.bodyUserSelect = owner.body.style.userSelect;
  }
  owner.ownsBodyStyles = true;
  bodyStyleOwner = owner;
  owner.body.style.cursor = "col-resize";
  owner.body.style.userSelect = "none";
}

function restoreBodyStyles(owner: DragOwner) {
  if (!owner.ownsBodyStyles || bodyStyleOwner !== owner) return;
  owner.ownsBodyStyles = false;
  bodyStyleOwner = null;
  owner.body.style.cursor = owner.bodyCursor;
  owner.body.style.userSelect = owner.bodyUserSelect;
}

function retireDrag(owner: DragOwner) {
  if (!owner.active) return;
  owner.active = false;
  if (owner.authority.drag === owner) owner.authority.drag = null;
  if (owner.captureHeld) {
    owner.captureHeld = false;
    try {
      owner.target.releasePointerCapture(owner.pointerId);
    } catch {
      // Unsupported or already released (the pointer was cancelled or the element lost capture).
    }
  }
  restoreBodyStyles(owner);
  if (owner.authority.active) owner.authority.stopDragging();
}

/**
 * Thin vertical grip laid over the side panel's left border. Dragging it left widens the panel
 * (the panel sits on the right, so its left edge moves with the pointer); arrow keys nudge it,
 * Home/End jump to the limits and Enter or a double-click puts the default width back.
 */
export function PanelResizeHandle({ width, min, max, onResize, onReset }: PanelResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const authorityRef = useRef<HandleAuthority | null>(null);
  const clamp = (w: number) => clampPanelWidth(w, min, max);

  useLayoutEffect(() => {
    const authority: HandleAuthority = {
      active: true,
      drag: null,
      stopDragging: () => setDragging(false),
    };
    authorityRef.current = authority;
    return () => {
      authority.active = false;
      if (authority.drag) retireDrag(authority.drag);
      if (authorityRef.current === authority) authorityRef.current = null;
    };
  }, []);

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const authority = authorityRef.current;
    const owner = authority?.drag;
    if (!authority?.active || !owner?.active || owner.pointerId !== e.pointerId || owner.target !== e.currentTarget) return;
    retireDrag(owner);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const authority = authorityRef.current;
    if (!authority?.active || authority.drag) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const owner: DragOwner = {
      active: true,
      authority,
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth: width,
      target: e.currentTarget,
      onResize,
      min,
      max,
      captureHeld: false,
      body: document.body,
      bodyCursor: "",
      bodyUserSelect: "",
      ownsBodyStyles: false,
    };
    authority.drag = owner;
    claimBodyStyles(owner);
    setDragging(true);
    try {
      owner.target.setPointerCapture(owner.pointerId);
      owner.captureHeld = true;
    } catch {
      // Capture is best-effort; moves over the grip itself still resize.
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const authority = authorityRef.current;
    const owner = authority?.drag;
    if (!authority?.active || !owner?.active || owner.pointerId !== e.pointerId || owner.target !== e.currentTarget) return;
    owner.onResize(clampPanelWidth(owner.startWidth + (owner.startX - e.clientX), owner.min, owner.max));
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
