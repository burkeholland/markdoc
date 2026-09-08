import { StateEffect, StateField, type EditorSelection, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import {
  elementEditorRange,
  eventHighlightTarget,
  type HighlightClickHandler,
  type HighlightTarget,
} from "../highlight-activation";

/** A highlighted range in source coordinates, shared by both editing surfaces. */
export interface SourceHighlight {
  from: number;
  to: number;
  kind: "comment" | "comment-resolved" | "suggest-insert" | "suggest-delete" | "focus" | "find" | "find-active";
  id?: string;
  active?: boolean;
  color?: string;
}

export const setHighlights = StateEffect.define<SourceHighlight[]>();

function classFor(h: SourceHighlight): string {
  switch (h.kind) {
    case "comment":
      return "md-comment" + (h.active ? " md-comment-active" : "");
    case "comment-resolved":
      return "md-comment-resolved";
    case "suggest-insert":
      return "md-suggest-insert" + (h.active ? " md-suggest-active" : "");
    case "suggest-delete":
      return "md-suggest-delete" + (h.active ? " md-suggest-active" : "");
    case "focus":
      return "md-focus-block";
    case "find":
      return "md-find";
    case "find-active":
      return "md-find md-find-active";
  }
}

function build(highlights: SourceHighlight[], docLength: number): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const h of highlights) {
    const from = Math.max(0, Math.min(h.from, docLength));
    const to = Math.max(from, Math.min(h.to, docLength));
    if (h.kind === "focus") {
      ranges.push(Decoration.line({ class: "md-focus-block" }).range(from));
      continue;
    }
    if (to === from) continue;
    ranges.push(
      Decoration.mark({
        class: classFor(h),
        attributes: {
          "data-highlight-kind": h.kind,
          ...(h.id ? { "data-highlight-id": h.id } : {}),
          ...(h.color ? { style: `text-decoration-color: ${h.color}` } : {}),
        },
      }).range(from, to),
    );
  }
  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return Decoration.set(ranges, true);
}

interface SourceHighlightsState {
  source: SourceHighlight[];
  deco: DecorationSet;
}

const highlightsField = StateField.define<SourceHighlightsState>({
  create: () => ({ source: [], deco: Decoration.none }),
  update(value, tr) {
    let source = value.source;
    let changed = false;
    for (const e of tr.effects) {
      if (e.is(setHighlights)) {
        source = e.value;
        changed = true;
      }
    }
    if (changed) return { source, deco: build(source, tr.newDoc.length) };
    if (tr.docChanged) return { source, deco: value.deco.map(tr.changes) };
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** Decorations for comments, suggestions, and the cross-pane focus block. */
export function sourceHighlights(): Extension {
  return highlightsField;
}

export interface PositionedHighlightTarget extends HighlightTarget {
  sourcePosition: number;
  from: number;
  to: number;
}

export function sourceHighlightAtPointer(view: EditorView, event: MouseEvent): PositionedHighlightTarget | null {
  const target = eventHighlightTarget(view.dom, event.target);
  if (!target) return null;
  const sourcePosition = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (sourcePosition === null) return null;
  const range = elementEditorRange(target.element, (node, offset) => view.posAtDOM(node, offset));
  const current = view.state.field(highlightsField, false);
  if (!range || !current) return null;
  let ownsRange = false;
  current.deco.between(range.from, range.to, (from, to, decoration) => {
    const attributes = decoration.spec.attributes as Record<string, string> | undefined;
    if (
      from <= range.from &&
      range.to <= to &&
      attributes?.["data-highlight-kind"] === target.kind &&
      attributes["data-highlight-id"] === target.id
    ) {
      ownsRange = true;
    }
  });
  return ownsRange ? { ...target, sourcePosition, ...range } : null;
}

// Match the editor's double-click window so a second native press can retire the first click.
const HIGHLIGHT_ACTIVATION_DELAY_MS = 500;
const DRAG_TOLERANCE_PX = 4;

interface SourceHighlightPress {
  down: MouseEvent;
  pointerId: number | null;
  target: PositionedHighlightTarget;
  highlights: SourceHighlightsState;
  released: boolean;
}

interface PendingSourceHighlightActivation {
  event: MouseEvent;
  target: PositionedHighlightTarget;
  highlights: SourceHighlightsState;
  selection: EditorSelection;
  timer: ReturnType<typeof setTimeout>;
}

function isPlainPrimaryEvent(event: MouseEvent): boolean {
  return event.button === 0 &&
    event.detail === 1 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey;
}

function samePositionedTarget(a: PositionedHighlightTarget, b: PositionedHighlightTarget | null): boolean {
  return !!b &&
    a.element === b.element &&
    a.kind === b.kind &&
    a.id === b.id &&
    a.sourcePosition === b.sourcePosition &&
    a.from === b.from &&
    a.to === b.to;
}

function movedPastClickTolerance(start: MouseEvent, current: MouseEvent): boolean {
  return Math.abs(start.clientX - current.clientX) > DRAG_TOLERANCE_PX ||
    Math.abs(start.clientY - current.clientY) > DRAG_TOLERANCE_PX;
}

function installSourceHighlightActivation(
  view: EditorView,
  onClick: HighlightClickHandler,
): { update(update: ViewUpdate): void; destroy(): void } {
  const dom = view.contentDOM;
  const owner = dom.ownerDocument;
  const win = owner.defaultView;
  let press: SourceHighlightPress | null = null;
  let pending: PendingSourceHighlightActivation | null = null;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  let nextPointerId: number | null = null;

  const currentHighlights = () => view.state.field(highlightsField, false);
  const pointerId = (event: Event) => {
    const value = (event as Partial<PointerEvent>).pointerId;
    return typeof value === "number" ? value : null;
  };
  const stopPressTracking = () => {
    owner.removeEventListener("mousemove", move, true);
    owner.removeEventListener("mouseup", up, true);
    owner.removeEventListener("pointerup", pointerUp, true);
  };
  const clearPress = () => {
    stopPressTracking();
    clearTimeout(releaseTimer);
    releaseTimer = undefined;
    press = null;
  };
  const clearPending = () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
  };
  const retire = () => {
    clearPress();
    clearPending();
    nextPointerId = null;
  };
  const pointerDown = (event: PointerEvent) => {
    retire();
    nextPointerId = pointerId(event);
  };
  const pointerUp = (event: PointerEvent) => {
    if (!press) {
      nextPointerId = null;
    } else if (press.pointerId !== null && pointerId(event) !== press.pointerId) {
      clearPress();
    }
  };
  const schedule = (current: SourceHighlightPress, event: MouseEvent) => {
    clearPending();
    const activation: PendingSourceHighlightActivation = {
      event,
      target: current.target,
      highlights: current.highlights,
      selection: view.state.selection,
      timer: setTimeout(() => {
        if (pending !== activation) return;
        pending = null;
        if (
          !dom.isConnected ||
          activation.highlights !== currentHighlights() ||
          !activation.selection.eq(view.state.selection) ||
          !samePositionedTarget(activation.target, sourceHighlightAtPointer(view, activation.event))
        ) {
          return;
        }
        onClick(activation.target.kind, activation.target.id, activation.target.sourcePosition);
      }, HIGHLIGHT_ACTIVATION_DELAY_MS),
    };
    pending = activation;
  };
  const move = (event: MouseEvent) => {
    if (!press) return;
    if (
      event.buttons !== 1 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      movedPastClickTolerance(press.down, event)
    ) {
      clearPress();
    }
  };
  const up = (event: MouseEvent) => {
    const current = press;
    if (
      !current ||
      !isPlainPrimaryEvent(event) ||
      event.buttons !== 0 ||
      movedPastClickTolerance(current.down, event) ||
      current.highlights !== currentHighlights() ||
      !samePositionedTarget(current.target, sourceHighlightAtPointer(view, event))
    ) {
      clearPress();
      return;
    }
    current.released = true;
    stopPressTracking();
    schedule(current, event);
    releaseTimer = setTimeout(clearPress, 0);
  };
  const down = (event: MouseEvent) => {
    const currentPointerId = nextPointerId;
    retire();
    const highlights = currentHighlights();
    if (event.defaultPrevented || !isPlainPrimaryEvent(event) || event.buttons !== 1 || !highlights) return;
    const target = sourceHighlightAtPointer(view, event);
    if (!target) return;
    press = { down: event, pointerId: currentPointerId, target, highlights, released: false };
    owner.addEventListener("mousemove", move, true);
    owner.addEventListener("mouseup", up, true);
    owner.addEventListener("pointerup", pointerUp, true);
  };
  const click = (event: MouseEvent) => {
    const current = press;
    clearPress();
    if (
      event.defaultPrevented ||
      !current?.released ||
      !isPlainPrimaryEvent(event) ||
      event.buttons !== 0 ||
      current.highlights !== currentHighlights() ||
      !samePositionedTarget(current.target, sourceHighlightAtPointer(view, event))
    ) {
      clearPending();
      return;
    }
    if (!pending || pending.target !== current.target) {
      clearPending();
      return;
    }
    pending.event = event;
    pending.selection = view.state.selection;
  };

  dom.addEventListener("pointerdown", pointerDown, true);
  dom.addEventListener("pointercancel", retire, true);
  dom.addEventListener("mousedown", down, true);
  dom.addEventListener("click", click, true);
  dom.addEventListener("dblclick", retire, true);
  dom.addEventListener("blur", retire, true);
  win?.addEventListener("blur", retire);

  return {
    update(update) {
      const highlights = currentHighlights();
      if (press && (update.docChanged || press.highlights !== highlights)) clearPress();
      if (
        pending &&
        (update.docChanged ||
          pending.highlights !== highlights ||
          !pending.selection.eq(update.state.selection) ||
          (update.focusChanged && !update.view.hasFocus))
      ) {
        clearPending();
      }
      if (!dom.isConnected) retire();
    },
    destroy() {
      retire();
      dom.removeEventListener("pointerdown", pointerDown, true);
      dom.removeEventListener("pointercancel", retire, true);
      dom.removeEventListener("mousedown", down, true);
      dom.removeEventListener("click", click, true);
      dom.removeEventListener("dblclick", retire, true);
      dom.removeEventListener("blur", retire, true);
      win?.removeEventListener("blur", retire);
    },
  };
}

/** Hook for clicks on highlighted ranges (for example to open a comment thread). */
export function highlightClickHandler(onClick: HighlightClickHandler): Extension {
  return ViewPlugin.define((view) => installSourceHighlightActivation(view, onClick));
}
