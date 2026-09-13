import { StateEffect, StateField, type EditorSelection, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import {
  elementEditorRange,
  eventHighlightTarget,
  isActivatableHighlightKind,
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
  activationVersion: number;
}

function sameActivationHighlights(a: SourceHighlight[], b: SourceHighlight[]): boolean {
  const left = a.filter((highlight) => isActivatableHighlightKind(highlight.kind));
  const right = b.filter((highlight) => isActivatableHighlightKind(highlight.kind));
  return left.length === right.length && left.every((highlight, index) => {
    const other = right[index]!;
    return highlight.from === other.from &&
      highlight.to === other.to &&
      highlight.kind === other.kind &&
      highlight.id === other.id &&
      highlight.active === other.active;
  });
}

const highlightsField = StateField.define<SourceHighlightsState>({
  create: () => ({ source: [], deco: Decoration.none, activationVersion: 0 }),
  update(value, tr) {
    let source = value.source;
    let changed = false;
    for (const e of tr.effects) {
      if (e.is(setHighlights)) {
        source = e.value;
        changed = true;
      }
    }
    if (changed) {
      return {
        source,
        deco: build(source, tr.newDoc.length),
        activationVersion: value.activationVersion + (sameActivationHighlights(value.source, source) ? 0 : 1),
      };
    }
    if (tr.docChanged) return { source, deco: value.deco.map(tr.changes), activationVersion: value.activationVersion };
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
  return sourceHighlightOwnsRange(current, { ...target, sourcePosition, ...range })
    ? { ...target, sourcePosition, ...range }
    : null;
}

function sourceHighlightOwnsRange(
  current: SourceHighlightsState,
  target: PositionedHighlightTarget,
): boolean {
  let ownsRange = false;
  current.deco.between(target.from, target.to, (from, to, decoration) => {
    const attributes = decoration.spec.attributes as Record<string, string> | undefined;
    if (
      from <= target.from &&
      target.to <= to &&
      attributes?.["data-highlight-kind"] === target.kind &&
      attributes["data-highlight-id"] === target.id
    ) {
      ownsRange = true;
    }
  });
  return ownsRange;
}

function sourceHighlightIsCurrent(view: EditorView, target: PositionedHighlightTarget): boolean {
  const current = view.state.field(highlightsField, false);
  return !!current && sourceHighlightOwnsRange(current, target);
}

// Product policy: classify clicks for 750 ms from the first press. A later detail-2
// gesture cannot undo an activation that has already committed.
const HIGHLIGHT_ACTIVATION_WINDOW_MS = 750;
const DRAG_TOLERANCE_PX = 4;

interface SourceHighlightPress {
  down: MouseEvent;
  startedAt: number;
  pointerId: number | null;
  target: PositionedHighlightTarget;
  doc: Text;
  activationVersion: number;
  released: boolean;
}

interface PendingSourceHighlightActivation {
  target: PositionedHighlightTarget;
  doc: Text;
  activationVersion: number;
  selection: EditorSelection;
  confirmed: boolean;
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

function isPointerSelectionUpdate(update: ViewUpdate): boolean {
  return update.selectionSet &&
    update.transactions.length > 0 &&
    update.transactions.every((transaction) => transaction.isUserEvent("select.pointer"));
}

function sourceSelectionMatchesTarget(
  selection: EditorSelection,
  target: PositionedHighlightTarget,
): boolean {
  return selection.ranges.length === 1 &&
    selection.main.empty &&
    selection.main.head === target.sourcePosition;
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
  let nextPressStartedAt: number | null = null;

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
    nextPressStartedAt = null;
  };
  const pointerDown = (event: PointerEvent) => {
    retire();
    nextPointerId = pointerId(event);
    nextPressStartedAt = Date.now();
  };
  const pointerUp = (event: PointerEvent) => {
    if (!press) {
      nextPointerId = null;
      nextPressStartedAt = null;
    } else if (press.pointerId !== null && pointerId(event) !== press.pointerId) {
      clearPress();
    }
  };
  const schedule = (current: SourceHighlightPress) => {
    clearPending();
    const activation: PendingSourceHighlightActivation = {
      target: current.target,
      doc: current.doc,
      activationVersion: current.activationVersion,
      selection: view.state.selection,
      confirmed: false,
      timer: setTimeout(() => {
        if (pending !== activation) return;
        pending = null;
        if (
          !activation.confirmed ||
          !dom.isConnected ||
          activation.doc !== view.state.doc ||
          activation.activationVersion !== currentHighlights()?.activationVersion ||
          !activation.selection.eq(view.state.selection) ||
          !sourceHighlightIsCurrent(view, activation.target)
        ) {
          return;
        }
        onClick(activation.target.kind, activation.target.id, activation.target.sourcePosition);
      }, Math.max(0, HIGHLIGHT_ACTIVATION_WINDOW_MS - (Date.now() - current.startedAt))),
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
      current.doc !== view.state.doc ||
      current.activationVersion !== currentHighlights()?.activationVersion ||
      !samePositionedTarget(current.target, sourceHighlightAtPointer(view, event))
    ) {
      clearPress();
      return;
    }
    current.released = true;
    stopPressTracking();
    schedule(current);
    releaseTimer = setTimeout(clearPress, 0);
  };
  const down = (event: MouseEvent) => {
    const currentPointerId = nextPointerId;
    const startedAt = nextPressStartedAt ?? Date.now();
    retire();
    const highlights = currentHighlights();
    if (event.defaultPrevented || !isPlainPrimaryEvent(event) || event.buttons !== 1 || !highlights) return;
    const target = sourceHighlightAtPointer(view, event);
    if (!target) return;
    press = {
      down: event,
      startedAt,
      pointerId: currentPointerId,
      target,
      doc: view.state.doc,
      activationVersion: highlights.activationVersion,
      released: false,
    };
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
      current.doc !== view.state.doc ||
      current.activationVersion !== currentHighlights()?.activationVersion ||
      !samePositionedTarget(current.target, sourceHighlightAtPointer(view, event))
    ) {
      clearPending();
      return;
    }
    if (!pending || pending.target !== current.target) {
      clearPending();
      return;
    }
    pending.selection = view.state.selection;
    pending.confirmed = true;
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
      if (press && (update.docChanged || press.activationVersion !== highlights?.activationVersion)) clearPress();
      if (
        pending &&
        !pending.confirmed &&
        press?.released &&
        pending.target === press.target &&
        !pending.selection.eq(update.state.selection) &&
        isPointerSelectionUpdate(update) &&
        sourceSelectionMatchesTarget(update.state.selection, pending.target)
      ) {
        // CodeMirror may commit this gesture's native selection after our document-level
        // mouseup listener. The exact click below still has to confirm the same target.
        pending.selection = update.state.selection;
      }
      if (
        pending &&
        (update.docChanged ||
          pending.activationVersion !== highlights?.activationVersion ||
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
