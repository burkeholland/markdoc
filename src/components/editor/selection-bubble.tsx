"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditorView } from "prosemirror-view";
import { Bold, Italic, Code, Link as LinkIcon, MessageSquarePlus, Strikethrough } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { EditorActions, FormatState } from "./actions";
import { cn } from "@/lib/utils";
import type { Box, Insets } from "@/lib/viewport";
import { isCoarsePointer } from "@/lib/viewport-hooks";
import {
  placeSelectionBubble,
  selectionBubbleBounds,
  selectionClientBox,
  type SelectionBubblePosition,
  type VisualViewportBox,
} from "./selection-bubble-geometry";

const cssPixels = (style: CSSStyleDeclaration, property: string): number => {
  const value = Number.parseFloat(style.getPropertyValue(property));
  return Number.isFinite(value) ? value : 0;
};

const clientBox = ({ left, top, width, height }: Pick<DOMRect, "left" | "top" | "width" | "height">): Box => ({ left, top, width, height });
const caretBox = ({ left, right, top, bottom }: Pick<DOMRect, "left" | "right" | "top" | "bottom">): Box => ({
  left,
  top,
  width: Math.max(0, right - left),
  height: Math.max(0, bottom - top),
});

function safeAreaInsets(): Insets {
  const style = getComputedStyle(document.documentElement);
  return {
    top: cssPixels(style, "--safe-area-inset-top"),
    right: cssPixels(style, "--safe-area-inset-right"),
    bottom: cssPixels(style, "--safe-area-inset-bottom"),
    left: cssPixels(style, "--safe-area-inset-left"),
  };
}

function BubbleButton({
  label,
  active,
  onClick,
  children,
  disabled,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-white/85 hover:bg-white/15 hover:text-white disabled:opacity-30", active && "bg-white/20 text-white")}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      aria-label={label}
      title={label}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/**
 * Floating toolbar that appears over a non-empty selection in the rich pane, the way
 * word processors do. It offers the most common inline actions and "Comment".
 */
export function SelectionBubble({
  view,
  session,
  actions,
  format,
  containerRef,
  onComment,
  onLink,
}: {
  view: EditorView | null;
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  containerRef: React.RefObject<HTMLElement | null>;
  onComment: () => void;
  onLink: () => void;
}) {
  const [pos, setPos] = useState<SelectionBubblePosition | null>(null);
  const [visible, setVisible] = useState(false);
  const pointerDown = useRef(false);
  const raf = useRef<number | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  const compute = useCallback(() => {
    const container = containerRef.current;
    if (!view || !container) {
      setVisible(false);
      return;
    }
    const { from, to, empty } = view.state.selection;
    const ownsFocus = view.hasFocus() || Boolean(document.activeElement && bubbleRef.current?.contains(document.activeElement));
    const canShow = !empty && ownsFocus && session.activeSurface === "rich" && (session.canEdit || session.canComment);
    if (!canShow || pointerDown.current) {
      setVisible(false);
      return;
    }
    try {
      const start = view.coordsAtPos(from);
      const end = view.coordsAtPos(to, -1);
      const host = container.getBoundingClientRect();
      const visualViewport: VisualViewportBox | null = window.visualViewport
        ? {
            offsetLeft: window.visualViewport.offsetLeft,
            offsetTop: window.visualViewport.offsetTop,
            width: window.visualViewport.width,
            height: window.visualViewport.height,
          }
        : null;
      const bounds = selectionBubbleBounds({
        host: clientBox(host),
        layoutViewport: {
          left: 0,
          top: 0,
          width: document.documentElement.clientWidth || window.innerWidth,
          height: document.documentElement.clientHeight || window.innerHeight,
        },
        visualViewport,
        safeArea: safeAreaInsets(),
      });
      const next = placeSelectionBubble(
        selectionClientBox(caretBox(start), caretBox(end)),
        bounds,
        isCoarsePointer(),
      );
      if (!next) {
        setPos(null);
        setVisible(false);
        return;
      }
      setPos(next);
      setVisible(true);
    } catch {
      setPos(null);
      setVisible(false);
    }
  }, [view, session, containerRef]);

  const schedule = useCallback(() => {
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      compute();
    });
  }, [compute]);

  useLayoutEffect(() => {
    const scroller = containerRef.current;
    if (!view || !scroller) {
      schedule();
      return () => {
        if (raf.current !== null) cancelAnimationFrame(raf.current);
        raf.current = null;
      };
    }
    const visualViewport = window.visualViewport;
    const onPointerDown = () => {
      pointerDown.current = true;
    };
    const onPointerUp = () => {
      pointerDown.current = false;
      schedule();
    };
    const onBlur = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && bubbleRef.current?.contains(event.relatedTarget)) return;
      setVisible(false);
    };
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("pointercancel", onPointerUp, { passive: true });
    document.addEventListener("selectionchange", schedule);
    visualViewport?.addEventListener("resize", schedule, { passive: true });
    visualViewport?.addEventListener("scroll", schedule, { passive: true });
    view.dom.addEventListener("blur", onBlur);
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(scroller);
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(view.dom, { childList: true, characterData: true, subtree: true });
    schedule();
    return () => {
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.removeEventListener("selectionchange", schedule);
      visualViewport?.removeEventListener("resize", schedule);
      visualViewport?.removeEventListener("scroll", schedule);
      view.dom.removeEventListener("blur", onBlur);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [view, schedule, containerRef]);

  // Format changes carry every editor selection update into the shared geometry scheduler.
  useLayoutEffect(schedule, [schedule, format]);

  if (!visible || !pos) return null;
  const canEdit = session.canEdit;

  return createPortal(
    <div
      ref={bubbleRef}
      className="touch-target fixed z-30 rounded-lg bg-inverse shadow-xl animate-fade-in dark:ring-1 dark:ring-white/10"
      style={{ left: pos.left, top: pos.top, width: pos.width }}
      data-testid="selection-bubble"
      data-below={pos.below || undefined}
    >
      <div
        className="selection-bubble-scroll flex items-center gap-0.5 overflow-x-auto overflow-y-hidden rounded-lg px-1 py-1"
        tabIndex={0}
        role="toolbar"
        aria-label="Selection"
        aria-orientation="horizontal"
      >
        <BubbleButton label="Bold" active={format.strong} disabled={!canEdit} onClick={() => actions.toggleMark("strong")}>
          <Bold size={16} strokeWidth={2.6} />
        </BubbleButton>
        <BubbleButton label="Italic" active={format.em} disabled={!canEdit} onClick={() => actions.toggleMark("em")}>
          <Italic size={16} />
        </BubbleButton>
        <BubbleButton label="Strikethrough" active={format.strike} disabled={!canEdit} onClick={() => actions.toggleMark("strike")}>
          <Strikethrough size={16} />
        </BubbleButton>
        <BubbleButton label="Inline code" active={format.code} disabled={!canEdit} onClick={() => actions.toggleMark("code")}>
          <Code size={16} />
        </BubbleButton>
        <BubbleButton label="Link" active={format.link} disabled={!canEdit} onClick={onLink}>
          <LinkIcon size={16} />
        </BubbleButton>
        <span className="mx-0.5 h-5 w-px shrink-0 bg-white/20" />
        <BubbleButton label="Comment" disabled={!session.canComment} onClick={onComment}>
          <MessageSquarePlus size={16} />
        </BubbleButton>
      </div>
      <span
        className={cn("absolute h-2.5 w-2.5 -translate-x-1/2 rotate-45 bg-inverse", pos.below ? "-top-1" : "-bottom-1")}
        style={{ left: pos.arrowLeft }}
        aria-hidden
      />
    </div>,
    document.body,
  );
}
