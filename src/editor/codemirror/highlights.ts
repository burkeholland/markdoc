import { StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

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

const highlightsField = StateField.define<{ source: SourceHighlight[]; deco: DecorationSet }>({
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

/** Hook for clicks on highlighted ranges (for example to open a comment thread). */
export function highlightClickHandler(onClick: (kind: string, id: string | null) => void): Extension {
  return EditorView.domEventHandlers({
    mousedown(event) {
      const target = (event.target as HTMLElement).closest("[data-highlight-kind]") as HTMLElement | null;
      if (!target) return false;
      const kind = target.getAttribute("data-highlight-kind")!;
      if (kind === "focus") return false;
      onClick(kind, target.getAttribute("data-highlight-id"));
      return false;
    },
  });
}
