import type { CollabSession } from "./collab/session";

export type ActivatableHighlightKind = "comment" | "comment-resolved" | "suggest-insert" | "suggest-delete";

export interface HighlightTarget {
  element: HTMLElement;
  id: string;
  kind: ActivatableHighlightKind;
}

export type HighlightClickHandler = (kind: string, id: string | null, sourcePosition: number) => void;

export function isActivatableHighlightKind(kind: string): kind is ActivatableHighlightKind {
  return kind === "comment" || kind === "comment-resolved" || kind === "suggest-insert" || kind === "suggest-delete";
}

export function eventHighlightTarget(root: HTMLElement, eventTarget: EventTarget | null): HighlightTarget | null {
  if (!(eventTarget instanceof Element)) return null;
  const element = eventTarget.closest<HTMLElement>("[data-highlight-kind][data-highlight-id]");
  if (!element || !root.contains(element)) return null;
  const kind = element.dataset.highlightKind;
  const id = element.dataset.highlightId;
  if (!kind || !isActivatableHighlightKind(kind) || !id) return null;
  return { element, kind, id };
}

export function elementEditorRange(element: HTMLElement, posAtDOM: (node: Node, offset: number) => number): { from: number; to: number } | null {
  const from = posAtDOM(element, 0);
  const to = posAtDOM(element, element.childNodes.length);
  return to > from ? { from, to } : null;
}

function ownsSourcePosition(range: { from: number; to: number } | null, sourcePosition: number): boolean {
  return !!range && range.to > range.from && sourcePosition >= range.from && sourcePosition < range.to;
}

function liveHighlightOwner(
  session: CollabSession,
  kind: string,
  id: string | null,
  sourcePosition: number,
): "comment" | "suggestion" | null {
  if (!id || !isActivatableHighlightKind(kind) || !Number.isInteger(sourcePosition)) return null;
  if (kind === "comment" || kind === "comment-resolved") {
    const thread = session.comments.get(id);
    return thread &&
      (thread.resolved ? "comment-resolved" : "comment") === kind &&
      ownsSourcePosition(thread.range, sourcePosition)
      ? "comment"
      : null;
  }
  // Grouped replacements share a highlight ID, but only a live member of the clicked kind owns it.
  const suggestion = session.suggestions.list().find(
    (candidate) =>
      (candidate.groupId ?? candidate.id) === id &&
      (candidate.type === "insert" ? "suggest-insert" : "suggest-delete") === kind &&
      ownsSourcePosition(candidate, sourcePosition),
  );
  return suggestion ? "suggestion" : null;
}

export function ownsLiveHighlight(session: CollabSession, kind: string, id: string | null, sourcePosition: number): boolean {
  return liveHighlightOwner(session, kind, id, sourcePosition) !== null;
}

export function activateHighlight(session: CollabSession, kind: string, id: string | null, sourcePosition: number): boolean {
  const owner = liveHighlightOwner(session, kind, id, sourcePosition);
  if (!owner || !id) return false;
  if (owner === "comment") session.setActiveComment(id);
  else session.setActiveSuggestion(id);
  return true;
}
