"use client";

import { useEffect } from "react";
import type { EditorView as CMView } from "@codemirror/view";
import type { EditorView as PMView } from "prosemirror-view";
import type { CollabSession } from "@/editor/collab/session";
import type { CodeApi } from "@/editor/codemirror/api";

type Pane = "code" | "rich";

/** How long a pane ignores its own scroll events after being scrolled programmatically. */
const LOCK_MS = 120;

/** Source offset at the top of the code pane's viewport, with the fraction scrolled into that line. */
function codeTopOffset(code: CMView): number {
  const scroller = code.scrollDOM;
  // Height at the top edge of the scroller, in document coordinates.
  const y = scroller.getBoundingClientRect().top - code.documentTop;
  const block = code.lineBlockAtHeight(Math.max(0, y));
  const line = code.state.doc.lineAt(block.from);
  const frac = block.height > 0 ? Math.min(1, Math.max(0, (y - block.top) / block.height)) : 0;
  return line.from + Math.round(frac * line.length);
}

/** Top-level ProseMirror block whose DOM box contains the top edge of the rich scroller. */
function richTopBlock(rich: PMView, scroller: HTMLElement): { index: number; frac: number } | null {
  const doc = rich.state.doc;
  const count = doc.childCount;
  if (!count) return null;
  const starts: number[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    starts.push(pos);
    pos += doc.child(i).nodeSize;
  }
  const rectAt = (i: number): DOMRect | null => {
    const dom = rich.nodeDOM(starts[i]) as HTMLElement | null;
    return dom && typeof dom.getBoundingClientRect === "function" ? dom.getBoundingClientRect() : null;
  };
  const top = scroller.getBoundingClientRect().top;
  // Blocks are laid out top to bottom: binary search for the first one that ends below the edge.
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const rect = rectAt(mid);
    if (rect && rect.bottom > top) hi = mid;
    else lo = mid + 1;
  }
  const rect = rectAt(lo);
  if (!rect) return { index: lo, frac: 0 };
  const frac = rect.height > 0 ? Math.min(1, Math.max(0, (top - rect.top) / rect.height)) : 0;
  return { index: lo, frac };
}

function blockDom(rich: PMView, index: number): HTMLElement | null {
  const doc = rich.state.doc;
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return (rich.nodeDOM(pos) as HTMLElement | null) ?? null;
}

/** Scroll the rich pane so the block containing `offset` sits at the top, proportionally within the block. */
export function scrollRichToSource(session: CollabSession, rich: PMView, scroller: HTMLElement, offset: number) {
  const map = session.binding.getSourceMap();
  const pm = map.srcToPm(offset);
  const index = Math.min(map.blockIndexAt(pm), rich.state.doc.childCount - 1);
  const block = map.blocks[index];
  const dom = blockDom(rich, index);
  if (!dom || !block) return;
  const span = block.to - block.from;
  const frac = span > 0 ? Math.min(1, Math.max(0, (offset - block.from) / span)) : 0;
  const rect = dom.getBoundingClientRect();
  const target = scroller.scrollTop + (rect.top - scroller.getBoundingClientRect().top) + frac * rect.height;
  scroller.scrollTop = Math.max(0, target);
}

/** Scroll the code pane so the line holding `offset` sits at the top. */
export function scrollCodeToSource(code: CMView, codeApi: CodeApi, offset: number) {
  const clamped = Math.min(code.state.doc.length, Math.max(0, offset));
  // CodeMirror's own scroll effect re-measures lines it has not rendered yet, so the
  // position ends up where it should even when line heights were only estimated.
  code.dispatch({ effects: codeApi.scrollIntoView(clamped, { y: "start", yMargin: 0 }) });
}

/** Source offset that is currently at the top of the rich pane. */
export function richTopSource(session: CollabSession, rich: PMView, scroller: HTMLElement): number | null {
  const top = richTopBlock(rich, scroller);
  if (!top) return null;
  const map = session.binding.getSourceMap();
  const block = map.blocks[Math.min(top.index, map.blocks.length - 1)];
  if (!block) return null;
  return block.from + Math.round(top.frac * (block.to - block.from));
}

export interface ScrollSyncTargets {
  session: CollabSession;
  code: CMView | null;
  /** Handed up by the code pane with its view (null whenever `code` is); this module never imports CodeMirror values. */
  codeApi: CodeApi | null;
  rich: PMView | null;
  richScroller: HTMLElement | null;
  enabled: boolean;
}

/**
 * Keeps the code and preview panes scrolled to the same place: scrolling either pane
 * moves the other so the block at the top of the viewport matches. The pane the user
 * is scrolling drives; the other ignores its own programmatic scroll events briefly.
 */
export function useScrollSync({ session, code, codeApi, rich, richScroller, enabled }: ScrollSyncTargets) {
  useEffect(() => {
    if (!enabled || !code || !codeApi || !rich || !richScroller) return;
    const lock: { pane: Pane | null; until: number } = { pane: null, until: 0 };
    let frame = 0;
    let pending: Pane | null = null;

    const run = () => {
      frame = 0;
      const source = pending;
      pending = null;
      if (!source) return;
      try {
        if (source === "code") {
          lock.pane = "rich";
          lock.until = performance.now() + LOCK_MS;
          scrollRichToSource(session, rich, richScroller, codeTopOffset(code));
        } else {
          const offset = richTopSource(session, rich, richScroller);
          if (offset === null) return;
          lock.pane = "code";
          lock.until = performance.now() + LOCK_MS;
          scrollCodeToSource(code, codeApi, offset);
        }
      } catch {
        // Layout may be mid-update (for example while a pane is hidden); skip this frame.
      }
    };
    const schedule = (pane: Pane) => {
      if (lock.pane === pane && performance.now() < lock.until) return;
      pending = pane;
      if (!frame) frame = requestAnimationFrame(run);
    };
    const onCode = () => schedule("code");
    const onRich = () => schedule("rich");
    code.scrollDOM.addEventListener("scroll", onCode, { passive: true });
    richScroller.addEventListener("scroll", onRich, { passive: true });
    return () => {
      code.scrollDOM.removeEventListener("scroll", onCode);
      richScroller.removeEventListener("scroll", onRich);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [session, code, codeApi, rich, richScroller, enabled]);
}
