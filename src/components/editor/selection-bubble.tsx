"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { Plugin } from "prosemirror-state";
import { Bold, Italic, Code, Link as LinkIcon, MessageSquarePlus, Strikethrough } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { EditorActions, FormatState } from "./actions";
import { cn } from "@/lib/utils";
import type { Box, Insets } from "@/lib/viewport";
import { isCoarsePointer } from "@/lib/viewport-hooks";
import {
  placeSelectionBubble,
  selectionBubbleLayerPosition,
  selectionBubbleBounds,
  selectionClientBox,
  selectionIntersectsBounds,
  SELECTION_BUBBLE_ARROW_SIZE,
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

interface BubbleGeometry {
  view: EditorView;
  layer: HTMLDivElement;
  position: SelectionBubblePosition;
  placement: NonNullable<ReturnType<typeof selectionBubbleLayerPosition>>;
}

interface BubbleOwner {
  view: EditorView;
  editor: HTMLElement;
  scroller: HTMLElement;
  session: CollabSession;
  schedule: () => void;
  dispose: () => void;
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
      className={cn("flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-md text-white/85 hover:bg-white/15 hover:text-white disabled:opacity-30", active && "bg-white/20 text-white")}
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
  const [geometry, setGeometry] = useState<BubbleGeometry | null>(null);
  const ownerRef = useRef<BubbleOwner | null>(null);

  // Resolve ref.current on every commit: the pane can be replaced without replacing its ref.
  useLayoutEffect(() => {
    const scroller = containerRef.current;
    const previous = ownerRef.current;
    if (previous?.view === view && previous?.editor === view?.dom && previous?.scroller === scroller && previous?.session === session) return;
    previous?.dispose();
    ownerRef.current = null;
    if (!view || !scroller) {
      return;
    }
    const editor = view.dom;
    const visualViewport = window.visualViewport;
    const fonts = document.fonts;
    const layer = document.createElement("div");
    layer.className = "selection-bubble-layer";
    layer.setAttribute("data-selection-bubble-layer", "");
    layer.contentEditable = "false";
    const topLayer = typeof layer.showPopover === "function";
    if (topLayer) layer.popover = "manual";
    let disposed = false;
    let pointerDown = false;
    let frame: number | null = null;
    let fullscreenWidget: Plugin | null = null;
    const observedContent = new Set<Element>();

    const removeFullscreenWidget = () => {
      if (!fullscreenWidget) return;
      if (!view.isDestroyed) {
        const state = view.state;
        if (state.plugins.includes(fullscreenWidget)) {
          view.updateState(state.reconfigure({ plugins: state.plugins.filter((plugin) => plugin !== fullscreenWidget) }));
        }
      }
      fullscreenWidget = null;
    };
    const hide = () => {
      if (disposed) return;
      if (topLayer && layer.matches(":popover-open")) layer.hidePopover();
      setGeometry(null);
    };
    const compute = () => {
      if (disposed) return;
      if (view.isDestroyed || !editor.isConnected || !scroller.isConnected || containerRef.current !== scroller) {
        hide();
        return;
      }
      const { from, to, empty } = view.state.selection;
      const ownsFocus = view.hasFocus() || Boolean(document.activeElement && layer.contains(document.activeElement));
      if (empty || !ownsFocus || pointerDown || session.activeSurface !== "rich" || !(session.canEdit || session.canComment)) {
        hide();
        return;
      }
      const fullscreen = document.fullscreenElement;
      if (fullscreen && !fullscreen.contains(editor) && !fullscreen.contains(scroller)) {
        hide();
        return;
      }
      // The top layer escapes transforms and overflow. The non-popover fallback is outside
      // transformed body, or directly inside fullscreen with an explicit scale conversion.
      const target = fullscreen ?? document.documentElement;
      if (layer.parentElement !== target) {
        if (topLayer && layer.matches(":popover-open")) layer.hidePopover();
        if (target === editor) {
          // A portal inside editable content must be a widget: otherwise ProseMirror removes
          // its DOM, reparses its contents, and handles the toolbar's keyboard events as edits.
          fullscreenWidget ??= new Plugin({
            props: {
              decorations(state) {
                if (disposed) return DecorationSet.empty;
                return DecorationSet.create(state.doc, [
                  Decoration.widget(0, layer, { side: -1, ignoreSelection: true, stopEvent: () => true }),
                ]);
              },
            },
          });
          const state = view.state;
          if (!state.plugins.includes(fullscreenWidget)) {
            view.updateState(state.reconfigure({ plugins: [...state.plugins, fullscreenWidget] }));
          }
        } else {
          removeFullscreenWidget();
          target.appendChild(layer);
        }
      }
      layer.dir = getComputedStyle(editor).direction;
      if (topLayer && !layer.matches(":popover-open")) layer.showPopover();
      try {
        const start = view.coordsAtPos(from);
        const end = view.coordsAtPos(to, -1);
        const startDOM = view.domAtPos(from);
        const endDOM = view.domAtPos(to);
        const range = document.createRange();
        range.setStart(startDOM.node, startDOM.offset);
        range.setEnd(endDOM.node, endDOM.offset);
        const fragments = Array.from(range.getClientRects(), clientBox);
        const nextContent = new Set<Element>();
        for (const node of [startDOM.node, endDOM.node]) {
          let element = node instanceof Element ? node : node.parentElement;
          while (element && element !== editor && editor.contains(element)) {
            nextContent.add(element);
            element = element.parentElement;
          }
        }
        for (const element of observedContent) {
          if (!nextContent.has(element)) {
            resizeObserver?.unobserve(element);
            observedContent.delete(element);
          }
        }
        for (const element of nextContent) {
          if (!observedContent.has(element)) {
            resizeObserver?.observe(element);
            observedContent.add(element);
          }
        }
        const visual: VisualViewportBox | null = visualViewport
          ? {
              offsetLeft: visualViewport.offsetLeft,
              offsetTop: visualViewport.offsetTop,
              width: visualViewport.width,
              height: visualViewport.height,
            }
          : null;
        const bounds = selectionBubbleBounds({
          host: clientBox((fullscreen && !fullscreen.contains(scroller) ? fullscreen : scroller).getBoundingClientRect()),
          layoutViewport: {
            left: 0,
            top: 0,
            width: document.documentElement.clientWidth || window.innerWidth,
            height: document.documentElement.clientHeight || window.innerHeight,
          },
          visualViewport: visual,
          safeArea: safeAreaInsets(),
        });
        if (fragments.length && !fragments.some((fragment) => selectionIntersectsBounds(fragment, bounds))) {
          hide();
          return;
        }
        const position = placeSelectionBubble(selectionClientBox(caretBox(start), caretBox(end), fragments), bounds, isCoarsePointer());
        const layerBox = clientBox(layer.getBoundingClientRect());
        const layerStyle = getComputedStyle(layer);
        // offsetWidth rounds fractional CSS pixels, which otherwise invents a scale at zoom.
        const layerWidth = cssPixels(layerStyle, "width") || layer.offsetWidth;
        const layerHeight = cssPixels(layerStyle, "height") || layer.offsetHeight;
        const placement = position && selectionBubbleLayerPosition(position, layerBox, layerWidth, layerHeight);
        if (!position || !placement) {
          hide();
          return;
        }
        // Clip only paint beyond the allowed pane/viewport intersection (including shadow tails).
        layer.style.clipPath = `inset(${(bounds.top - layerBox.top) * placement.scaleY}px ${(layerBox.left + layerBox.width - bounds.left - bounds.width) * placement.scaleX}px ${(layerBox.top + layerBox.height - bounds.top - bounds.height) * placement.scaleY}px ${(bounds.left - layerBox.left) * placement.scaleX}px)`;
        setGeometry({ view, layer, position, placement });
      } catch (error) {
        // A replaced editor DOM can invalidate a range between selection and layout updates.
        if (error instanceof RangeError || (error instanceof DOMException && ["IndexSizeError", "InvalidStateError"].includes(error.name))) {
          hide();
          return;
        }
        throw error;
      }
    };
    const schedule = () => {
      if (disposed || frame !== null) return;
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        frame = null;
        compute();
      });
    };
    const onPointerDown = (event: PointerEvent) => {
      if (disposed) return;
      if (event.target instanceof Node && editor.contains(event.target) && !layer.contains(event.target)) {
        pointerDown = true;
        hide();
      }
    };
    const onPointerUp = () => {
      if (disposed) return;
      pointerDown = false;
      schedule();
    };
    const onBlur = (event: FocusEvent) => {
      if (disposed) return;
      if (event.relatedTarget instanceof Node && layer.contains(event.relatedTarget)) return;
      hide();
    };
    const onMutation: MutationCallback = (records) => {
      if (disposed) return;
      if (!records.length || records.some((record) => {
        if (layer.contains(record.target)) return false;
        return record.type !== "childList" || [...record.addedNodes, ...record.removedNodes].some((node) => node !== layer);
      })) schedule();
    };
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    resizeObserver?.observe(scroller);
    resizeObserver?.observe(editor);
    const mutationObserver = new MutationObserver(onMutation);
    mutationObserver.observe(editor, { childList: true, characterData: true, attributes: true, subtree: true });
    // Ancestor attribute changes can move content without resizing the scroller. No document subtree observer.
    for (let ancestor: HTMLElement | null = scroller; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor === editor) continue;
      mutationObserver.observe(ancestor, { attributes: true, attributeFilter: ["style", "class", "dir", "hidden"], childList: ancestor === scroller });
    }
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("pointercancel", onPointerUp, { passive: true });
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("fullscreenchange", schedule);
    visualViewport?.addEventListener("resize", schedule, { passive: true });
    visualViewport?.addEventListener("scroll", schedule, { passive: true });
    editor.addEventListener("blur", onBlur);
    editor.addEventListener("load", schedule, true);
    layer.addEventListener("focusout", schedule);
    fonts?.addEventListener("loadingdone", schedule);
    fonts?.addEventListener("loadingerror", schedule);
    void fonts?.ready.then(schedule);
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("fullscreenchange", schedule);
      visualViewport?.removeEventListener("resize", schedule);
      visualViewport?.removeEventListener("scroll", schedule);
      editor.removeEventListener("blur", onBlur);
      editor.removeEventListener("load", schedule, true);
      layer.removeEventListener("focusout", schedule);
      fonts?.removeEventListener("loadingdone", schedule);
      fonts?.removeEventListener("loadingerror", schedule);
      resizeObserver?.disconnect();
      observedContent.clear();
      mutationObserver.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      if (topLayer && layer.matches(":popover-open")) layer.hidePopover();
      removeFullscreenWidget();
      layer.remove();
    };
    ownerRef.current = { view, editor, scroller, session, schedule, dispose };
    schedule();
  });

  useLayoutEffect(() => () => {
    ownerRef.current?.dispose();
    ownerRef.current = null;
  }, []);

  // Format changes carry every editor selection update into the shared geometry scheduler.
  useLayoutEffect(() => ownerRef.current?.schedule(), [format]);

  if (!geometry || geometry.view !== view) return null;
  const { position: pos, placement, layer } = geometry;
  const canEdit = session.canEdit;

  return createPortal(
    <div
      className="selection-bubble touch-target absolute z-30 rounded-lg bg-inverse shadow-xl dark:ring-1 dark:ring-white/10"
      style={{ left: placement.left, top: placement.top, width: pos.width, transform: `scale(${placement.scaleX}, ${placement.scaleY})`, transformOrigin: "top left" }}
      data-testid="selection-bubble"
      data-below={pos.below || undefined}
    >
      <div
        className="selection-bubble-scroll flex items-center gap-[2px] overflow-x-auto overflow-y-hidden rounded-lg p-[4px]"
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
        <span className="mx-[2px] h-[20px] w-px shrink-0 bg-white/20" />
        <BubbleButton label="Comment" disabled={!session.canComment} onClick={onComment}>
          <MessageSquarePlus size={16} />
        </BubbleButton>
      </div>
      <span
        className="absolute -translate-x-1/2 rotate-45 bg-inverse"
        style={{ left: pos.arrowLeft, width: SELECTION_BUBBLE_ARROW_SIZE, height: SELECTION_BUBBLE_ARROW_SIZE, ...(pos.below ? { top: -4 } : { bottom: -4 }) }}
        aria-hidden
      />
    </div>,
    layer,
  );
}
