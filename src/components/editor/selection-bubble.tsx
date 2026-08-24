"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EditorView } from "prosemirror-view";
import { Bold, Bot, Italic, Code, Link as LinkIcon, MessageSquarePlus, Strikethrough } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { EditorActions, FormatState } from "./actions";
import { cn } from "@/lib/utils";
import { clampToViewport } from "@/lib/viewport";
import { isCoarsePointer } from "@/lib/viewport-hooks";

interface Position {
  left: number;
  top: number;
  /** Place below the selection when there is no room above. */
  below: boolean;
}

const BUBBLE_WIDTH = 232;
const BUBBLE_HEIGHT = 40;

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
      className={cn("flex h-8 w-8 items-center justify-center rounded-md text-white/85 hover:bg-white/15 hover:text-white disabled:opacity-30", active && "bg-white/20 text-white")}
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
  onAskAgent,
  onLink,
}: {
  view: EditorView | null;
  session: CollabSession;
  actions: EditorActions;
  format: FormatState;
  containerRef: React.RefObject<HTMLElement | null>;
  onComment: () => void;
  onAskAgent?: () => void;
  onLink: () => void;
}) {
  const [pos, setPos] = useState<Position | null>(null);
  const [visible, setVisible] = useState(false);
  const pointerDown = useRef(false);
  const raf = useRef<number | null>(null);

  const compute = useCallback(() => {
    const container = containerRef.current;
    if (!view || !container) {
      setVisible(false);
      return;
    }
    const { from, to, empty } = view.state.selection;
    const canShow = !empty && view.hasFocus() && session.activeSurface === "rich" && (session.canEdit || session.canComment);
    if (!canShow || pointerDown.current) {
      setVisible(false);
      return;
    }
    try {
      const start = view.coordsAtPos(from);
      const end = view.coordsAtPos(to, -1);
      const host = container.getBoundingClientRect();
      const topEdge = Math.min(start.top, end.top);
      const bottomEdge = Math.max(start.bottom, end.bottom);
      const centerX = (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2;
      // Touch devices draw the OS selection toolbar above the selection; sit below it there.
      let below = isCoarsePointer() || topEdge - host.top - BUBBLE_HEIGHT - 10 < 4;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      let box = clampToViewport(
        { left: centerX - BUBBLE_WIDTH / 2, top: below ? bottomEdge + 10 : topEdge - BUBBLE_HEIGHT - 10, width: BUBBLE_WIDTH, height: BUBBLE_HEIGHT },
        viewport,
      );
      if (below && box.top + box.height > viewport.height - 8 && topEdge - BUBBLE_HEIGHT - 10 >= 8) {
        // No room under the selection after all: flip back above.
        below = false;
        box = clampToViewport({ ...box, top: topEdge - BUBBLE_HEIGHT - 10 }, viewport);
      }
      // The bubble is absolutely positioned inside the scrolling container.
      const left = Math.max(8, Math.min(host.width - BUBBLE_WIDTH - 8, box.left - host.left));
      const top = box.top - host.top + container.scrollTop;
      setPos({ left, top, below });
      setVisible(true);
    } catch {
      setVisible(false);
    }
  }, [view, session, containerRef]);

  const schedule = useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(compute);
  }, [compute]);

  // Track mouse state so the bubble doesn't flicker while dragging a selection.
  useEffect(() => {
    const down = () => {
      pointerDown.current = true;
    };
    const up = () => {
      pointerDown.current = false;
      schedule();
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("mouseup", up);
    };
  }, [schedule]);

  // Recompute whenever the selection/format changes (format is derived from the selection).
  useLayoutEffect(() => {
    schedule();
  }, [schedule, format]);

  useEffect(() => {
    if (!view) return;
    const scroller = containerRef.current;
    const onScroll = () => schedule();
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    const onBlur = () => setVisible(false);
    view.dom.addEventListener("blur", onBlur);
    return () => {
      scroller?.removeEventListener("scroll", onScroll);
      view.dom.removeEventListener("blur", onBlur);
    };
  }, [view, schedule, containerRef]);

  if (!visible || !pos) return null;
  const canEdit = session.canEdit;

  return (
    <div
      className="touch-target absolute z-30 flex items-center gap-0.5 rounded-lg bg-inverse px-1 py-1 shadow-xl animate-fade-in dark:ring-1 dark:ring-white/10"
      style={{ left: pos.left, top: pos.top, width: BUBBLE_WIDTH }}
      data-testid="selection-bubble"
      data-below={pos.below || undefined}
      role="toolbar"
      aria-label="Selection"
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
      <span className="mx-0.5 h-5 w-px bg-white/20" />
      <BubbleButton label="Comment" disabled={!session.canComment} onClick={onComment}>
        <MessageSquarePlus size={16} />
      </BubbleButton>
      {onAskAgent && (
        <BubbleButton label="Ask an agent" disabled={!session.canComment} onClick={onAskAgent}>
          <Bot size={16} />
        </BubbleButton>
      )}
      <span className={cn("absolute left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 bg-inverse", pos.below ? "-top-1" : "-bottom-1")} aria-hidden />
    </div>
  );
}
