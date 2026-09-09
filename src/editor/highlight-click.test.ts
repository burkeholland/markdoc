// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { EditorState as CodeState } from "@codemirror/state";
import { EditorView as CodeView } from "@codemirror/view";
import { EditorState as RichState, TextSelection } from "prosemirror-state";
import { EditorView as RichView } from "prosemirror-view";
import { CollabSession } from "./collab/session";
import { createAnchor, makeCollabUser } from "./collab/shared";
import type { SuggestionType } from "./collab/suggestions";
import { highlightClickHandler, setHighlights, sourceHighlights } from "./codemirror/highlights";
import {
  activateHighlight,
  type ActivatableHighlightKind,
  type HighlightClickHandler,
} from "./highlight-activation";
import { collectHighlights, refreshRichHighlights, richHighlightsPlugin } from "./prosemirror/highlights";
import { markdownBindingPlugin } from "./sync/markdown-binding";

type Surface = "rich" | "source";
type Gesture = "primary" | "auxiliary" | "context" | "double";
type Boundary = "start" | "interior" | "end" | "after";
type Mutation = "live" | "reanchor-away" | "removed" | "kind-changed" | "range-less" | "reanchor-containing";

interface Harness {
  session: CollabSession;
  surface: Surface;
  kind: ActivatableHighlightKind;
  id: string;
  view: CodeView | RichView;
  root: HTMLElement;
  target: HTMLElement;
  plainTarget: HTMLElement;
  rawClick: MockInstance<HighlightClickHandler>;
  setActiveComment: MockInstance<CollabSession["setActiveComment"]>;
  setActiveSuggestion: MockInstance<CollabSession["setActiveSuggestion"]>;
  panelIsOpen(): boolean;
  setSourcePosition(sourcePosition: number): void;
  destroy(): void;
}

const TEXT = "ordinary qzxvblort prefix targetword suffix remoteplace tail";
const MISSPELLING = "qzxvblort";
const ITEM_TEXT = "targetword";
const AWAY_TEXT = "remoteplace";
const ITEM_RANGE = rangeOf(ITEM_TEXT);
const AWAY_RANGE = rangeOf(AWAY_TEXT);
const SURFACES: Surface[] = ["rich", "source"];
const KINDS: ActivatableHighlightKind[] = ["comment", "comment-resolved", "suggest-insert", "suggest-delete"];
const GESTURES: Gesture[] = ["primary", "auxiliary", "context", "double"];
const BOUNDARIES: Boundary[] = ["start", "interior", "end", "after"];
const MUTATIONS: Mutation[] = ["live", "reanchor-away", "removed", "kind-changed", "range-less", "reanchor-containing"];
const HIGHLIGHT_ACTIVATION_WINDOW_MS = 750;
const harnesses: Harness[] = [];

let pointerTarget: HTMLElement | null = null;
let caretNode: Node | null = null;
let caretOffset = 0;

beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => pointerTarget,
  });
  Object.defineProperty(document, "caretPositionFromPoint", {
    configurable: true,
    value: () => (caretNode ? { offsetNode: caretNode, offset: caretOffset } : null),
  });
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.destroy();
  pointerTarget = null;
  caretNode = null;
  caretOffset = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function rangeOf(text: string) {
  const from = TEXT.indexOf(text);
  return { from, to: from + text.length };
}

function createItem(session: CollabSession, kind: ActivatableHighlightKind, range = ITEM_RANGE): string {
  if (kind === "comment" || kind === "comment-resolved") {
    const id = session.comments.add({ ...range, body: `${kind} body`, author: session.user });
    if (kind === "comment-resolved") session.comments.setResolved(id, true, session.user);
    return id;
  }

  session.ydoc.transact(() => {
    if (kind === "suggest-insert") session.suggestions.recordInserted(range.from, range.to - range.from, session.user);
    else session.suggestions.markDeleted(range.from, range.to, session.user);
  });
  const type: SuggestionType = kind === "suggest-insert" ? "insert" : "delete";
  const suggestion = session.suggestions.list().find((candidate) => candidate.type === type && candidate.from === range.from && candidate.to === range.to);
  if (!suggestion) throw new Error(`failed to create ${kind}`);
  return suggestion.id;
}

function makeHarness(surface: Surface, kind: ActivatableHighlightKind, options: { overlap?: boolean; replacement?: boolean } = {}): Harness {
  const session = new CollabSession({
    docId: `highlight-click-${surface}-${kind}`,
    user: makeCollabUser("alice", "Alice"),
    role: "owner",
    getToken: async () => "token",
    autoConnect: false,
    deferLocal: true,
  });
  session.keepAlive();
  session.ytext.insert(0, TEXT);
  const id = options.replacement
    ? session.suggestions.propose({ ...ITEM_RANGE, insert: "replacement" }, session.user)
    : createItem(session, kind);
  const richDoc = session.binding.initialDoc();
  session.binding.releaseRemoteSync();
  if (options.overlap) {
    const overlapKind: ActivatableHighlightKind = kind.startsWith("comment") ? "suggest-insert" : "comment";
    createItem(session, overlapKind, { from: ITEM_RANGE.from + 2, to: ITEM_RANGE.to - 2 });
  }
  session.setFind(MISSPELLING);

  let panelOpen = false;
  let sourcePosition = ITEM_RANGE.from;
  const rawClick = vi.fn<HighlightClickHandler>((clickedKind, clickedId, clickedSourcePosition) => {
    if (activateHighlight(session, clickedKind, clickedId, clickedSourcePosition)) panelOpen = true;
  });
  const host = document.body.appendChild(document.createElement("div"));
  let view: CodeView | RichView;

  if (surface === "source") {
    const codeView = new CodeView({
      state: CodeState.create({
        doc: session.ytext.toString(),
        extensions: [
          sourceHighlights(),
          highlightClickHandler(rawClick),
          // jsdom cannot lay out text for CodeMirror's built-in mouse selection.
          CodeView.domEventHandlers({ mousedown: () => true }),
        ],
      }),
      parent: host,
    });
    const focus = session.activeSurface === "rich" ? { from: 0, to: 0 } : null;
    codeView.dispatch({ effects: setHighlights.of(collectHighlights(session, focus)) });
    vi.spyOn(codeView, "posAtCoords").mockImplementation(() => sourcePosition);
    view = codeView;
  } else {
    view = new RichView(host, {
      state: RichState.create({
        doc: richDoc,
        plugins: [
          markdownBindingPlugin(session.binding),
          richHighlightsPlugin(session, {
            getFocusSource: () => session.activeSurface === "code" ? 0 : null,
            onHighlightClick: rawClick,
          }),
        ],
      }),
    });
  }

  const target = view.dom.querySelector<HTMLElement>(`[data-highlight-id="${id}"][data-highlight-kind="${kind}"]`);
  if (!target) throw new Error(`${kind} was not rendered in ${surface}`);
  const setActiveComment = vi.spyOn(session, "setActiveComment");
  const setActiveSuggestion = vi.spyOn(session, "setActiveSuggestion");
  const harness: Harness = {
    session,
    surface,
    kind,
    id,
    view,
    root: view.dom,
    target,
    plainTarget: view.dom.querySelector<HTMLElement>(surface === "source" ? ".cm-line" : "p")!,
    rawClick,
    setActiveComment,
    setActiveSuggestion,
    panelIsOpen: () => panelOpen,
    setSourcePosition(next) {
      sourcePosition = next;
      pointerTarget = harness.target;
      if (surface === "rich") {
        const richView = view as RichView;
        const pmPosition = session.binding.getSourceMap().srcToPm(next);
        const domPosition = richView.domAtPos(pmPosition);
        caretNode = domPosition.node;
        caretOffset = domPosition.offset;
      }
    },
    destroy() {
      view.destroy();
      host.remove();
      session.destroy();
    },
  };
  harnesses.push(harness);
  return harness;
}

function sourcePositionAt(boundary: Boundary): number {
  if (boundary === "start") return ITEM_RANGE.from;
  if (boundary === "interior") return ITEM_RANGE.from + Math.floor((ITEM_RANGE.to - ITEM_RANGE.from) / 2);
  if (boundary === "end") return ITEM_RANGE.to;
  return ITEM_RANGE.to + 1;
}

function dispatch(target: HTMLElement, type: string, init: MouseEventInit = {}): MouseEvent {
  pointerTarget = target;
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10, ...init });
  target.dispatchEvent(event);
  return event;
}

function dispatchClickSequence(target: HTMLElement, detail: number) {
  dispatch(target, "pointerdown", { button: 0, buttons: 1, detail });
  dispatch(target, "mousedown", { button: 0, buttons: 1, detail });
  dispatch(target, "pointerup", { button: 0, detail });
  dispatch(target, "mouseup", { button: 0, detail });
  dispatch(target, "click", { button: 0, detail });
}

function viewHasFocus(harness: Harness): boolean {
  return harness.surface === "rich" ? (harness.view as RichView).hasFocus() : (harness.view as CodeView).hasFocus;
}

function mutateBeforeRouting(harness: Harness, mutation: Mutation, sourcePosition: number) {
  if (mutation === "live") return;
  if (harness.kind === "comment" || harness.kind === "comment-resolved") {
    const map = harness.session.comments.ymap.get(harness.id);
    if (!map) throw new Error("comment disappeared before mutation");
    if (mutation === "reanchor-away") map.set("anchor", createAnchor(harness.session.ytext, AWAY_RANGE.from, AWAY_RANGE.to));
    else if (mutation === "removed") harness.session.comments.ymap.delete(harness.id);
    else if (mutation === "kind-changed") map.set("resolved", harness.kind === "comment");
    else if (mutation === "range-less") map.delete("anchor");
    else map.set("anchor", createAnchor(harness.session.ytext, Math.max(0, sourcePosition - 1), Math.min(TEXT.length, sourcePosition + 2)));
    return;
  }

  const suggestion = harness.session.suggestions.ymap.get(harness.id);
  if (!suggestion) throw new Error("suggestion disappeared before mutation");
  if (mutation === "removed") {
    harness.session.suggestions.ymap.delete(harness.id);
    return;
  }
  const type: SuggestionType =
    mutation === "kind-changed" ? (suggestion.type === "insert" ? "delete" : "insert") : suggestion.type;
  const range =
    mutation === "reanchor-away"
      ? AWAY_RANGE
      : mutation === "range-less"
        ? { from: sourcePosition, to: sourcePosition }
        : mutation === "reanchor-containing"
          ? { from: Math.max(0, sourcePosition - 1), to: Math.min(TEXT.length, sourcePosition + 2) }
          : ITEM_RANGE;
  harness.session.suggestions.ymap.set(harness.id, {
    ...suggestion,
    type,
    anchor: createAnchor(harness.session.ytext, range.from, range.to),
    text: TEXT.slice(range.from, range.to),
  });
}

function performInteraction(
  harness: Harness,
  gesture: Gesture,
  sourcePosition: number,
  mutation: Mutation,
  flushActivation = true,
) {
  harness.view.focus();
  harness.setSourcePosition(sourcePosition);
  const button = gesture === "auxiliary" ? 1 : gesture === "context" ? 2 : 0;
  const buttons = button === 0 ? 1 : button === 1 ? 4 : 2;
  const sequence = (detail: number, mutate: boolean) => {
    dispatch(harness.target, "pointerdown", { button, buttons, detail });
    if (mutate && harness.surface === "source") mutateBeforeRouting(harness, mutation, sourcePosition);
    dispatch(harness.target, "mousedown", { button, buttons, detail });
    if (mutate && harness.surface === "rich") mutateBeforeRouting(harness, mutation, sourcePosition);
    if (gesture === "context") {
      dispatch(harness.target, "contextmenu", { button, detail });
    } else if (gesture === "auxiliary") {
      dispatch(harness.target, "pointerup", { button, detail });
      dispatch(harness.target, "auxclick", { button, detail });
    } else {
      dispatch(harness.target, "pointerup", { button, detail });
      dispatch(harness.target, "mouseup", { button, detail });
      dispatch(harness.target, "click", { button, detail });
    }
  };
  sequence(1, true);
  if (gesture === "double") {
    sequence(2, false);
    dispatch(harness.target, "dblclick", { button, detail: 2 });
  }
  if (flushActivation) vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);
  expect(viewHasFocus(harness)).toBe(true);
}

function refreshHighlights(harness: Harness) {
  if (harness.surface === "source") {
    (harness.view as CodeView).dispatch({
      effects: setHighlights.of(collectHighlights(harness.session, null)),
    });
  } else {
    refreshRichHighlights(harness.view as RichView);
  }
}

function addCommentDestination(harness: Harness): string {
  const destinationId = createItem(harness.session, "comment", AWAY_RANGE);
  refreshHighlights(harness);
  return destinationId;
}

function reanchorCommentToDestination(harness: Harness, destinationId: string): HTMLElement {
  const source = harness.session.comments.ymap.get(harness.id);
  const destination = harness.session.comments.get(destinationId);
  if (!source || !destination) throw new Error("comment re-anchor fixture unavailable");

  source.set("anchor", destination.anchor);
  refreshHighlights(harness);
  source.set("quote", destination.quote);
  refreshHighlights(harness);
  harness.session.comments.ymap.delete(destinationId);
  refreshHighlights(harness);

  const current = harness.root.querySelector<HTMLElement>(
    `[data-highlight-id="${harness.id}"][data-highlight-kind="comment"]`,
  );
  if (!current) throw new Error("re-anchored comment was not rendered");
  return current;
}

function performReleasedSourceInteraction(
  harness: Harness,
  sourcePosition: number,
) {
  const view = harness.view as CodeView;
  harness.view.focus();
  harness.setSourcePosition(sourcePosition);
  dispatch(harness.target, "pointerdown", { button: 0, buttons: 1, detail: 1 });
  dispatch(harness.target, "mousedown", { button: 0, buttons: 1, detail: 1 });
  dispatch(harness.target, "pointerup", { button: 0, detail: 1 });
  dispatch(harness.target, "mouseup", { button: 0, detail: 1 });
  view.dispatch({
    selection: { anchor: sourcePosition },
    userEvent: "select.pointer",
  });
  dispatch(harness.target, "click", { button: 0, detail: 1 });
}

function performReleasedRichInteraction(
  harness: Harness,
  sourcePosition: number,
  selectionOrigin: "pointer" | "programmatic",
  selectionPosition?: number,
) {
  const view = harness.view as RichView;
  harness.view.focus();
  harness.setSourcePosition(sourcePosition);
  dispatch(harness.target, "pointerdown", { button: 0, buttons: 1, detail: 1 });
  dispatch(harness.target, "mousedown", { button: 0, buttons: 1, detail: 1 });
  dispatch(harness.target, "pointerup", { button: 0, detail: 1 });
  dispatch(harness.target, "mouseup", { button: 0, detail: 1 });
  const position = selectionPosition ?? harness.session.binding.getSourceMap().srcToPm(sourcePosition);
  const transaction = view.state.tr.setSelection(TextSelection.create(view.state.doc, position));
  if (selectionOrigin === "pointer") transaction.setMeta("pointer", true);
  view.dispatch(transaction);
  dispatch(harness.target, "click", { button: 0, detail: 1 });
}

function expectedActivation(gesture: Gesture, boundary: Boundary, mutation: Mutation): boolean {
  if (gesture !== "primary") return false;
  if (mutation === "reanchor-containing") return true;
  return mutation === "live" && (boundary === "start" || boundary === "interior");
}

describe("live highlight click ownership", () => {
  it.each(SURFACES)(
    "activates only the clean current %s comment after its destination replaces the old decoration",
    (surface) => {
      const harness = makeHarness(surface, "comment");
      const destinationId = addCommentDestination(harness);
      const staleTarget = harness.target;
      const currentTarget = reanchorCommentToDestination(harness, destinationId);

      harness.target = staleTarget;
      performInteraction(harness, "primary", ITEM_RANGE.from + 2, "live");
      expect(harness.setActiveComment).not.toHaveBeenCalled();
      expect(harness.setActiveSuggestion).not.toHaveBeenCalled();
      expect(harness.session.activeCommentId).toBeNull();
      expect(harness.session.comments.get(destinationId)).toBeNull();

      harness.rawClick.mockClear();
      harness.setActiveComment.mockClear();
      harness.target = currentTarget;
      const sourcePosition = AWAY_RANGE.from + 2;
      const startedAt = Date.now();
      if (surface === "source") {
        performReleasedSourceInteraction(harness, sourcePosition);
      } else {
        performInteraction(harness, "primary", sourcePosition, "live", false);
      }
      const acceptedSelection = harness.view.state.selection.toJSON();

      vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS - 1);
      expect(harness.rawClick).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(Date.now() - startedAt).toBe(HIGHLIGHT_ACTIVATION_WINDOW_MS);
      expect(harness.rawClick).toHaveBeenCalledExactlyOnceWith("comment", harness.id, sourcePosition);
      expect(harness.setActiveComment).toHaveBeenCalledExactlyOnceWith(harness.id);
      expect(harness.setActiveSuggestion).not.toHaveBeenCalled();
      expect(harness.session.activeCommentId).toBe(harness.id);
      expect(harness.session.activeSuggestionId).toBeNull();
      expect(harness.view.state.selection.toJSON()).toEqual(acceptedSelection);
      expect(viewHasFocus(harness)).toBe(true);
      expect(harness.session.ytext.toString()).toBe(TEXT);
    },
  );

  it("activates the moved rich successor when browser hit tests stay inside its current decoration", () => {
    const harness = makeHarness("rich", "comment");
    const destinationId = addCommentDestination(harness);
    const staleTarget = harness.target;
    harness.view.focus();
    harness.setSourcePosition(ITEM_RANGE.from + 2);
    dispatch(staleTarget, "pointerdown", { button: 0, buttons: 1, detail: 1 });
    dispatch(staleTarget, "mousedown", { button: 0, buttons: 1, detail: 1 });

    const currentTarget = reanchorCommentToDestination(harness, destinationId);
    dispatch(harness.plainTarget, "pointerup", { button: 0, detail: 1 });
    dispatch(harness.plainTarget, "mouseup", { button: 0, detail: 1 });
    dispatch(harness.plainTarget, "click", { button: 0, detail: 1 });
    vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);

    expect(harness.rawClick).not.toHaveBeenCalled();
    expect(harness.setActiveComment).not.toHaveBeenCalled();
    expect(harness.setActiveSuggestion).not.toHaveBeenCalled();
    expect(harness.session.activeCommentId).toBeNull();
    expect(harness.session.comments.get(destinationId)).toBeNull();
    harness.target = currentTarget;
    const view = harness.view as RichView;
    const downSourcePosition = AWAY_RANGE.from + 1;
    const releaseSourcePosition = AWAY_RANGE.from + 2;
    const clickSourcePosition = AWAY_RANGE.from + 3;
    const map = harness.session.binding.getSourceMap();
    const downPosition = map.srcToPm(downSourcePosition);
    const releasePosition = map.srcToPm(releaseSourcePosition);
    const clickPosition = map.srcToPm(clickSourcePosition);
    const targetFrom = view.posAtDOM(currentTarget, 0);
    const targetTo = view.posAtDOM(currentTarget, currentTarget.childNodes.length);
    expect(new Set([downPosition, releasePosition, clickPosition]).size).toBe(3);
    for (const position of [downPosition, releasePosition, clickPosition]) {
      expect(position).toBeGreaterThanOrEqual(targetFrom);
      expect(position).toBeLessThan(targetTo);
    }

    const startedAt = Date.now();
    harness.view.focus();
    harness.setSourcePosition(downSourcePosition);
    dispatch(currentTarget, "pointerdown", { button: 0, buttons: 1, detail: 1, clientX: 10 });
    dispatch(currentTarget, "mousedown", { button: 0, buttons: 1, detail: 1, clientX: 10 });
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, releasePosition))
        .setMeta("pointer", true),
    );
    harness.setSourcePosition(releaseSourcePosition);
    dispatch(currentTarget, "pointerup", { button: 0, detail: 1, clientX: 12 });
    dispatch(currentTarget, "mouseup", { button: 0, detail: 1, clientX: 12 });
    harness.setSourcePosition(clickSourcePosition);
    dispatch(currentTarget, "click", { button: 0, detail: 1, clientX: 14 });
    expect(view.state.selection.from).toBe(releasePosition);

    vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS - 1);
    expect(harness.rawClick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(Date.now() - startedAt).toBe(HIGHLIGHT_ACTIVATION_WINDOW_MS);
    expect(harness.rawClick).toHaveBeenCalledExactlyOnceWith("comment", harness.id, clickSourcePosition);
    expect(harness.setActiveComment).toHaveBeenCalledExactlyOnceWith(harness.id);
    expect(harness.setActiveSuggestion).not.toHaveBeenCalled();
    expect(harness.session.activeCommentId).toBe(harness.id);
    expect(harness.session.activeSuggestionId).toBeNull();
    expect(harness.session.ytext.toString()).toBe(TEXT);
    vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);
    expect(harness.rawClick).toHaveBeenCalledTimes(1);
  });

  it("rejects a programmatic rich selection update before release", () => {
    const harness = makeHarness("rich", "comment");
    const sourcePosition = ITEM_RANGE.from + 1;
    const view = harness.view as RichView;
    harness.view.focus();
    harness.setSourcePosition(sourcePosition);

    dispatch(harness.target, "pointerdown", { button: 0, buttons: 1, detail: 1 });
    dispatch(harness.target, "mousedown", { button: 0, buttons: 1, detail: 1 });
    const programmaticPosition = harness.session.binding.getSourceMap().srcToPm(sourcePosition + 1);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, programmaticPosition)));
    dispatch(harness.target, "pointerup", { button: 0, detail: 1 });
    dispatch(harness.target, "mouseup", { button: 0, detail: 1 });
    dispatch(harness.target, "click", { button: 0, detail: 1 });
    vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);

    expect(harness.rawClick).not.toHaveBeenCalled();
    expect(harness.setActiveComment).not.toHaveBeenCalled();
    expect(harness.setActiveSuggestion).not.toHaveBeenCalled();
    expect(harness.panelIsOpen()).toBe(false);
  });

  it("rejects a programmatic rich selection update between release and click", () => {
    const harness = makeHarness("rich", "comment");
    const sourcePosition = ITEM_RANGE.from + 2;

    performReleasedRichInteraction(harness, sourcePosition, "programmatic");
    vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);

    expect(harness.rawClick).not.toHaveBeenCalled();
    expect(harness.setActiveComment).not.toHaveBeenCalled();
    expect(harness.setActiveSuggestion).not.toHaveBeenCalled();
    expect(harness.panelIsOpen()).toBe(false);
    expect(harness.session.ytext.toString()).toBe(TEXT);
  });

  it("rejects a rich gesture that crosses to a different decoration with the same kind and ID", () => {
    const harness = makeHarness("rich", "suggest-insert");
    const destinationId = createItem(harness.session, "suggest-insert", AWAY_RANGE);
    const destination = harness.session.suggestions.ymap.get(destinationId);
    if (!destination) throw new Error("destination suggestion was not created");
    harness.session.suggestions.ymap.set(destinationId, { ...destination, groupId: harness.id });
    refreshHighlights(harness);

    const targets = Array.from(harness.root.querySelectorAll<HTMLElement>(
      `[data-highlight-id="${harness.id}"][data-highlight-kind="suggest-insert"]`,
    ));
    expect(targets).toHaveLength(2);
    const originTarget = targets[0]!;
    const destinationTarget = targets[1]!;
    harness.target = originTarget;
    harness.view.focus();
    harness.setSourcePosition(ITEM_RANGE.from + 1);
    dispatch(originTarget, "pointerdown", { button: 0, buttons: 1, detail: 1 });
    dispatch(originTarget, "mousedown", { button: 0, buttons: 1, detail: 1 });

    harness.target = destinationTarget;
    harness.setSourcePosition(AWAY_RANGE.from + 1);
    dispatch(destinationTarget, "pointerup", { button: 0, detail: 1 });
    dispatch(destinationTarget, "mouseup", { button: 0, detail: 1 });
    dispatch(destinationTarget, "click", { button: 0, detail: 1 });
    vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);

    expect(harness.rawClick).not.toHaveBeenCalled();
    expect(harness.setActiveComment).not.toHaveBeenCalled();
    expect(harness.setActiveSuggestion).not.toHaveBeenCalled();
    expect(harness.panelIsOpen()).toBe(false);
  });

  it("rejects a rich gesture whose release resolves to the adjacent decoration boundary", () => {
    const harness = makeHarness("rich", "comment");
    harness.view.focus();
    harness.setSourcePosition(ITEM_RANGE.from + 1);
    dispatch(harness.target, "pointerdown", { button: 0, buttons: 1, detail: 1 });
    dispatch(harness.target, "mousedown", { button: 0, buttons: 1, detail: 1 });

    harness.setSourcePosition(ITEM_RANGE.to);
    dispatch(harness.target, "pointerup", { button: 0, detail: 1 });
    dispatch(harness.target, "mouseup", { button: 0, detail: 1 });
    dispatch(harness.target, "click", { button: 0, detail: 1 });
    vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);

    expect(harness.rawClick).not.toHaveBeenCalled();
    expect(harness.setActiveComment).not.toHaveBeenCalled();
    expect(harness.setActiveSuggestion).not.toHaveBeenCalled();
    expect(harness.panelIsOpen()).toBe(false);
  });

  it.each(SURFACES.flatMap((surface) =>
    (["pointerdown", "press", "classification"] as const).map((phase) => [surface, phase] as const)
  ))(
    "retires a %s comment re-anchor during the %s phase and accepts the next clean click",
    (surface, phase) => {
      const harness = makeHarness(surface, "comment");
      const destinationId = addCommentDestination(harness);
      const staleTarget = harness.target;
      const sourcePosition = ITEM_RANGE.from + 2;
      harness.view.focus();
      harness.setSourcePosition(sourcePosition);

      dispatch(staleTarget, "pointerdown", { button: 0, buttons: 1, detail: 1 });
      if (phase !== "pointerdown") {
        dispatch(staleTarget, "mousedown", { button: 0, buttons: 1, detail: 1 });
      }
      if (phase === "classification") {
        dispatch(staleTarget, "pointerup", { button: 0, detail: 1 });
        dispatch(staleTarget, "mouseup", { button: 0, detail: 1 });
        dispatch(staleTarget, "click", { button: 0, detail: 1 });
      }

      const currentTarget = reanchorCommentToDestination(harness, destinationId);
      if (phase !== "classification") {
        dispatch(staleTarget, "pointerup", { button: 0, detail: 1 });
        dispatch(staleTarget, "mouseup", { button: 0, detail: 1 });
        dispatch(staleTarget, "click", { button: 0, detail: 1 });
      }
      vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);

      expect(harness.rawClick).not.toHaveBeenCalled();
      expect(harness.setActiveComment).not.toHaveBeenCalled();
      expect(harness.setActiveSuggestion).not.toHaveBeenCalled();
      expect(harness.session.activeCommentId).toBeNull();
      expect(harness.session.comments.get(destinationId)).toBeNull();

      harness.target = currentTarget;
      performInteraction(harness, "primary", AWAY_RANGE.from + 2, "live");

      expect(harness.rawClick).toHaveBeenCalledExactlyOnceWith("comment", harness.id, AWAY_RANGE.from + 2);
      expect(harness.setActiveComment).toHaveBeenCalledExactlyOnceWith(harness.id);
      expect(harness.setActiveSuggestion).not.toHaveBeenCalled();
      expect(harness.session.activeCommentId).toBe(harness.id);
      expect(viewHasFocus(harness)).toBe(true);
      expect(harness.session.ytext.toString()).toBe(TEXT);
    },
  );

  it.each(SURFACES)("requires the exact %s click after an accepted release", (surface) => {
    const harness = makeHarness(surface, "comment");
    const sourcePosition = ITEM_RANGE.from + 2;
    harness.view.focus();
    harness.setSourcePosition(sourcePosition);

    dispatch(harness.target, "pointerdown", { button: 0, buttons: 1, detail: 1 });
    dispatch(harness.target, "mousedown", { button: 0, buttons: 1, detail: 1 });
    dispatch(harness.target, "pointerup", { button: 0, detail: 1 });
    dispatch(harness.target, "mouseup", { button: 0, detail: 1 });
    vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);

    expect(harness.rawClick).not.toHaveBeenCalled();
    expect(harness.setActiveComment).not.toHaveBeenCalled();
    expect(harness.session.activeCommentId).toBeNull();

    performInteraction(harness, "primary", sourcePosition, "live");
    expect(harness.rawClick).toHaveBeenCalledExactlyOnceWith("comment", harness.id, sourcePosition);
    expect(harness.setActiveComment).toHaveBeenCalledExactlyOnceWith(harness.id);
  });

  it.each(SURFACES.flatMap((surface) => (["suggest-insert", "suggest-delete"] as const).map((kind) => [surface, kind] as const)))(
    "%s %s validates grouped replacement members without activating their stale shared ID",
    (surface, kind) => {
      for (const mutation of ["live", "reanchor-away", "removed", "kind-changed", "range-less", "group-changed", "other-kind-position", "end"] as const) {
        const harness = makeHarness(surface, kind, { replacement: true });
        const members = harness.session.suggestions.list();
        const member = members.find((candidate) => `suggest-${candidate.type}` === kind)!;
        const other = members.find((candidate) => candidate.id !== member.id)!;
        const sourcePosition =
          mutation === "other-kind-position" ? other.from + 1 : mutation === "end" ? member.to : member.from + 1;
        if (harness.view instanceof CodeView) {
          harness.view.dispatch({ selection: { anchor: sourcePosition } });
        } else {
          const position = harness.session.binding.getSourceMap().srcToPm(sourcePosition);
          harness.view.dispatch(harness.view.state.tr.setSelection(TextSelection.create(harness.view.state.doc, position)));
        }
        harness.view.focus();
        harness.setSourcePosition(sourcePosition);
        const selection = harness.view.state.selection.toJSON();
        dispatch(harness.target, "pointerdown", { button: 0, detail: 1 });
        if (surface === "rich") dispatch(harness.target, "mousedown", { button: 0, buttons: 1, detail: 1 });
        if (mutation === "removed") harness.session.suggestions.ymap.delete(member.id);
        else if (mutation === "reanchor-away" || mutation === "range-less") {
          harness.session.suggestions.ymap.set(member.id, {
            ...member,
            anchor: createAnchor(harness.session.ytext, other.from, mutation === "range-less" ? other.from : other.to),
          });
        } else if (mutation === "kind-changed" || mutation === "group-changed") {
          harness.session.suggestions.ymap.set(member.id, {
            ...member,
            ...(mutation === "kind-changed" ? { type: other.type } : { groupId: "different-group" }),
          });
        }
        if (surface === "source") dispatch(harness.target, "mousedown", { button: 0, buttons: 1, detail: 1 });
        dispatch(harness.target, "pointerup", { button: 0, detail: 1 });
        dispatch(harness.target, "mouseup", { button: 0, detail: 1 });
        dispatch(harness.target, "click", { button: 0, detail: 1 });
        vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);

        expect(harness.rawClick, mutation).toHaveBeenCalledOnce();
        expect(harness.setActiveComment, mutation).not.toHaveBeenCalled();
        expect(harness.setActiveSuggestion, mutation).toHaveBeenCalledTimes(mutation === "live" ? 1 : 0);
        expect(harness.panelIsOpen(), mutation).toBe(mutation === "live");
        expect(harness.session.activeSuggestionId, mutation).toBe(mutation === "live" ? harness.id : null);
        expect(viewHasFocus(harness), mutation).toBe(true);
        expect(harness.view.state.selection.toJSON(), mutation).toEqual(selection);
        harness.destroy();
        harnesses.pop();
      }
    },
  );

  it.each(SURFACES.flatMap((surface) => KINDS.map((kind) => [surface, kind] as const)))(
    "%s %s runs 96 fresh gesture/boundary/mutation interactions",
    (surface, kind) => {
      let interactions = 0;
      let staleActivations = 0;
      let liveActivations = 0;
      let lostFocus = 0;

      for (const gesture of GESTURES) {
        for (const boundary of BOUNDARIES) {
          for (const mutation of MUTATIONS) {
            const harness = makeHarness(surface, kind);
            const sourcePosition = sourcePositionAt(boundary);
            performInteraction(harness, gesture, sourcePosition, mutation);
            const shouldActivate = expectedActivation(gesture, boundary, mutation);
            const activeCalls =
              kind === "comment" || kind === "comment-resolved"
                ? harness.setActiveComment.mock.calls.length
                : harness.setActiveSuggestion.mock.calls.length;
            const wrongCalls =
              kind === "comment" || kind === "comment-resolved"
                ? harness.setActiveSuggestion.mock.calls.length
                : harness.setActiveComment.mock.calls.length;

            interactions++;
            if (!viewHasFocus(harness)) lostFocus++;
            if (!shouldActivate && activeCalls > 0) staleActivations += activeCalls;
            if (shouldActivate) liveActivations += activeCalls;
            expect(activeCalls, `${surface}/${kind}/${gesture}/${boundary}/${mutation}`).toBe(shouldActivate ? 1 : 0);
            expect(wrongCalls).toBe(0);
            expect(harness.panelIsOpen()).toBe(shouldActivate);
            if (shouldActivate) {
              expect(
                kind === "comment" || kind === "comment-resolved"
                  ? harness.session.activeCommentId
                  : harness.session.activeSuggestionId,
              ).toBe(harness.id);
            }
            harness.destroy();
            harnesses.pop();
          }
        }
      }

      expect(interactions).toBe(96);
      expect(staleActivations).toBe(0);
      expect(lostFocus).toBe(0);
      expect(liveActivations).toBe(6);
    },
  );

  it.each(SURFACES)("keeps ordinary spelling interactions in the %s editor with Comments closed or current", (surface) => {
    const harness = makeHarness(surface, "comment");
    const typoPosition = rangeOf(MISSPELLING).from + 2;
    const interactions: Gesture[] = ["primary", "double", "context", "auxiliary"];

    harness.view.focus();
    harness.session.setActiveComment(harness.id);
    harness.setActiveComment.mockClear();
    for (const gesture of interactions) {
      harness.setSourcePosition(typoPosition);
      pointerTarget = harness.plainTarget;
      const button = gesture === "auxiliary" ? 1 : gesture === "context" ? 2 : 0;
      const detail = gesture === "double" ? 2 : 1;
      dispatch(harness.plainTarget, "mousedown", { button, detail });
      if (surface === "rich" && gesture !== "context" && gesture !== "auxiliary") dispatch(harness.plainTarget, "click", { button, detail });
    }

    expect(harness.rawClick).not.toHaveBeenCalled();
    expect(harness.setActiveComment).not.toHaveBeenCalled();
    expect(harness.setActiveSuggestion).not.toHaveBeenCalled();
    expect(harness.session.activeCommentId).toBe(harness.id);
    expect(harness.panelIsOpen()).toBe(false);
    expect(viewHasFocus(harness)).toBe(true);
  });

  it.each(SURFACES.flatMap((surface) => KINDS.map((kind) => [surface, kind] as const)))(
    "activates the first %s %s click after its inactive pane takes focus",
    async (surface, kind) => {
      const harness = makeHarness(surface, kind);
      const sourcePosition = ITEM_RANGE.from + 2;
      harness.session.setActiveSurface(surface === "rich" ? "code" : "rich");
      await Promise.resolve();
      if (surface === "source") {
        (harness.view as CodeView).dispatch({
          effects: setHighlights.of(collectHighlights(harness.session, { from: 0, to: 0 })),
        });
      } else {
        refreshRichHighlights(harness.view as RichView);
      }
      harness.setSourcePosition(sourcePosition);
      dispatch(harness.target, "pointerdown", { button: 0, buttons: 1, detail: 1 });
      dispatch(harness.target, "mousedown", { button: 0, buttons: 1, detail: 1 });

      harness.session.setActiveSurface(surface === "rich" ? "rich" : "code");
      await Promise.resolve();
      if (surface === "source") {
        (harness.view as CodeView).dispatch({
          effects: setHighlights.of(collectHighlights(harness.session, null)),
        });
      } else {
        refreshRichHighlights(harness.view as RichView);
      }
      dispatch(harness.target, "pointerup", { button: 0, detail: 1 });
      dispatch(harness.target, "mouseup", { button: 0, detail: 1 });
      dispatch(harness.target, "click", { button: 0, detail: 1 });
      vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);

      expect(harness.rawClick).toHaveBeenCalledExactlyOnceWith(kind, harness.id, sourcePosition);
      const active = kind.startsWith("comment") ? harness.setActiveComment : harness.setActiveSuggestion;
      const inactive = kind.startsWith("comment") ? harness.setActiveSuggestion : harness.setActiveComment;
      expect(active).toHaveBeenCalledExactlyOnceWith(harness.id);
      expect(inactive).not.toHaveBeenCalled();
      expect(harness.panelIsOpen()).toBe(true);
      expect(harness.session.ytext.toString()).toBe(TEXT);
    },
  );

  it.each(SURFACES.flatMap((surface) => KINDS.map((kind) => [surface, kind] as const)))(
    "commits one responsive %s %s single click at the 750 ms product boundary",
    (surface, kind) => {
      const harness = makeHarness(surface, kind);
      const sourcePosition = ITEM_RANGE.from + 2;
      const startedAt = Date.now();
      harness.view.focus();
      harness.setSourcePosition(sourcePosition);

      dispatch(harness.target, "pointerdown", { button: 0, buttons: 1, detail: 1 });
      dispatch(harness.target, "mousedown", { button: 0, buttons: 1, detail: 1 });
      vi.advanceTimersByTime(100);
      dispatch(harness.target, "pointerup", { button: 0, detail: 1 });
      dispatch(harness.target, "mouseup", { button: 0, detail: 1 });
      dispatch(harness.target, "click", { button: 0, detail: 1 });
      vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS - 101);
      expect(harness.rawClick).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(Date.now() - startedAt).toBe(HIGHLIGHT_ACTIVATION_WINDOW_MS);
      expect(Date.now() - startedAt).toBeLessThanOrEqual(800);
      expect(harness.rawClick).toHaveBeenCalledExactlyOnceWith(kind, harness.id, sourcePosition);
      expect(harness.panelIsOpen()).toBe(true);

      vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);
      expect(harness.rawClick).toHaveBeenCalledTimes(1);
    },
  );

  it.each(SURFACES.flatMap((surface) => KINDS.map((kind) => [surface, kind] as const)))(
    "lets a browser-classified second %s %s press inside 750 ms cancel activation",
    (surface, kind) => {
      const harness = makeHarness(surface, kind);
      const sourcePosition = ITEM_RANGE.from + 2;
      const selection = harness.view.state.selection.toJSON();
      harness.view.focus();
      harness.setSourcePosition(sourcePosition);

      dispatchClickSequence(harness.target, 1);
      vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS - 1);
      dispatchClickSequence(harness.target, 2);
      const doubleClick = dispatch(harness.target, "dblclick", { button: 0, detail: 2 });
      vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);

      expect(harness.rawClick).not.toHaveBeenCalled();
      expect(harness.setActiveComment).not.toHaveBeenCalled();
      expect(harness.setActiveSuggestion).not.toHaveBeenCalled();
      expect(harness.panelIsOpen()).toBe(false);
      expect(harness.view.state.selection.toJSON()).toEqual(selection);
      expect(harness.session.ytext.toString()).toBe(TEXT);
      expect(doubleClick.defaultPrevented).toBe(false);
    },
  );

  it.each(SURFACES.flatMap((surface) => KINDS.map((kind) => [surface, kind] as const)))(
    "does not duplicate a committed %s %s click when detail 2 arrives after 750 ms",
    (surface, kind) => {
      const harness = makeHarness(surface, kind);
      const sourcePosition = ITEM_RANGE.from + 2;
      harness.view.focus();
      harness.setSourcePosition(sourcePosition);

      dispatchClickSequence(harness.target, 1);
      vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS + 1);
      expect(harness.rawClick).toHaveBeenCalledExactlyOnceWith(kind, harness.id, sourcePosition);
      expect(harness.panelIsOpen()).toBe(true);

      dispatchClickSequence(harness.target, 2);
      const doubleClick = dispatch(harness.target, "dblclick", { button: 0, detail: 2 });
      vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);

      const active = kind.startsWith("comment") ? harness.setActiveComment : harness.setActiveSuggestion;
      const inactive = kind.startsWith("comment") ? harness.setActiveSuggestion : harness.setActiveComment;
      expect(harness.rawClick).toHaveBeenCalledTimes(1);
      expect(active).toHaveBeenCalledExactlyOnceWith(harness.id);
      expect(inactive).not.toHaveBeenCalled();
      expect(harness.session.ytext.toString()).toBe(TEXT);
      expect(doubleClick.defaultPrevented).toBe(false);
    },
  );

  it("retires a rich click that drifts past tolerance after release", () => {
    const harness = makeHarness("rich", "comment");
    const sourcePosition = ITEM_RANGE.from + 2;
    harness.view.focus();
    harness.setSourcePosition(sourcePosition);

    dispatch(harness.target, "pointerdown", { button: 0, buttons: 1, detail: 1, clientX: 10 });
    dispatch(harness.target, "mousedown", { button: 0, buttons: 1, detail: 1, clientX: 10 });
    dispatch(harness.target, "pointerup", { button: 0, detail: 1, clientX: 10 });
    dispatch(harness.target, "mouseup", { button: 0, detail: 1, clientX: 10 });
    dispatch(harness.target, "click", { button: 0, detail: 1, clientX: 15 });
    vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);

    expect(harness.rawClick).not.toHaveBeenCalled();
    expect(harness.setActiveComment).not.toHaveBeenCalled();
    expect(harness.setActiveSuggestion).not.toHaveBeenCalled();
  });

  it.each(SURFACES)("retires drags, modifiers, and later selection movement in the %s editor", (surface) => {
    const harness = makeHarness(surface, "comment");
    const sourcePosition = ITEM_RANGE.from + 2;
    harness.view.focus();
    harness.setSourcePosition(sourcePosition);

    dispatch(harness.target, "pointerdown", { button: 0, buttons: 1, detail: 1 });
    dispatch(harness.target, "mousedown", { button: 0, buttons: 1, detail: 1 });
    dispatch(harness.target, "mousemove", { button: 0, buttons: 1, detail: 1, clientX: 18 });
    dispatch(harness.target, "pointerup", { button: 0, detail: 1, clientX: 18 });
    dispatch(harness.target, "mouseup", { button: 0, detail: 1, clientX: 18 });
    dispatch(harness.target, "click", { button: 0, detail: 1, clientX: 18 });
    vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);
    expect(harness.rawClick).not.toHaveBeenCalled();

    dispatch(harness.target, "pointerdown", { button: 0, buttons: 1, detail: 1 });
    dispatch(harness.target, "mousedown", { button: 0, buttons: 1, detail: 1 });
    dispatch(harness.target, "mousemove", { button: 0, buttons: 1, detail: 1, ctrlKey: true });
    dispatch(harness.target, "pointercancel", { button: 0, detail: 1 });
    dispatch(harness.target, "mouseup", { button: 0, detail: 1 });
    dispatch(harness.target, "click", { button: 0, detail: 1 });
    vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);
    expect(harness.rawClick).not.toHaveBeenCalled();

    dispatch(harness.target, "pointerdown", { button: 0, buttons: 1, detail: 1, ctrlKey: true });
    dispatch(harness.target, "mousedown", { button: 0, buttons: 1, detail: 1, ctrlKey: true });
    dispatch(harness.target, "pointerup", { button: 0, detail: 1, ctrlKey: true });
    dispatch(harness.target, "mouseup", { button: 0, detail: 1, ctrlKey: true });
    dispatch(harness.target, "click", { button: 0, detail: 1, ctrlKey: true });
    vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);
    expect(harness.rawClick).not.toHaveBeenCalled();

    performInteraction(harness, "primary", sourcePosition, "live", false);
    if (surface === "source") {
      (harness.view as CodeView).dispatch({ selection: { anchor: AWAY_RANGE.from } });
    } else {
      const rich = harness.view as RichView;
      const away = harness.session.binding.getSourceMap().srcToPm(AWAY_RANGE.from + 1);
      rich.dispatch(rich.state.tr.setSelection(TextSelection.create(rich.state.doc, away)));
    }
    vi.advanceTimersByTime(HIGHLIGHT_ACTIVATION_WINDOW_MS);

    expect(harness.rawClick).not.toHaveBeenCalled();
    expect(harness.panelIsOpen()).toBe(false);
    expect(harness.session.ytext.toString()).toBe(TEXT);
  });

  it.each(SURFACES)(
    "retires starved replacement and unmount timers before a fresh %s single click",
    async (surface) => {
      const harness = makeHarness(surface, "comment");
      const sourcePosition = ITEM_RANGE.from + 2;
      performInteraction(harness, "primary", sourcePosition, "live", false);
      const pendingTimerCount = vi.getTimerCount();
      expect(harness.rawClick).not.toHaveBeenCalled();

      harness.session.comments.remove(harness.id);
      const freshId = createItem(harness.session, "comment");
      if (surface === "source") {
        (harness.view as CodeView).dispatch({
          effects: setHighlights.of(collectHighlights(harness.session, { from: 0, to: 0 })),
        });
      } else {
        refreshRichHighlights(harness.view as RichView);
      }
      await vi.advanceTimersByTimeAsync(HIGHLIGHT_ACTIVATION_WINDOW_MS);

      expect(harness.rawClick).not.toHaveBeenCalled();
      expect(harness.panelIsOpen()).toBe(false);
      expect(harness.session.activeCommentId).toBeNull();
      expect(vi.getTimerCount()).toBeLessThan(pendingTimerCount);

      harness.id = freshId;
      harness.target = harness.root.querySelector<HTMLElement>(
        `[data-highlight-id="${freshId}"][data-highlight-kind="comment"]`,
      )!;
      expect(harness.target).not.toBeNull();
      performInteraction(harness, "primary", sourcePosition, "live");
      expect(harness.rawClick).toHaveBeenCalledExactlyOnceWith("comment", freshId, sourcePosition);
      expect(harness.setActiveComment).toHaveBeenCalledExactlyOnceWith(freshId);
      expect(harness.panelIsOpen()).toBe(true);

      await vi.advanceTimersByTimeAsync(20);
      harness.target = harness.root.querySelector<HTMLElement>(`[data-highlight-id="${freshId}"]`)!;
      performInteraction(harness, "primary", sourcePosition, "live", false);
      harness.destroy();
      harnesses.pop();
      await vi.advanceTimersByTimeAsync(HIGHLIGHT_ACTIVATION_WINDOW_MS);
      expect(harness.rawClick).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(harness.session.ytext.toString()).toBe(TEXT);
    },
  );

  it.each(SURFACES)("routes a nested fragment of an overlapping %s decoration exactly once", (surface) => {
    const harness = makeHarness(surface, "comment", { overlap: true });
    const nested = document.createElement("span");
    nested.replaceChildren(...harness.target.childNodes);
    harness.target.appendChild(nested);
    harness.target = nested;

    performInteraction(harness, "primary", ITEM_RANGE.from + 3, "live");

    expect(harness.setActiveComment).toHaveBeenCalledOnce();
    expect(harness.setActiveComment).toHaveBeenCalledWith(harness.id);
    expect(harness.setActiveSuggestion).not.toHaveBeenCalled();
  });

  it("routes the current rich position after remote source-map movement while decoration refresh is deferred", () => {
    const harness = makeHarness("rich", "comment");
    const oldTarget = harness.target;
    harness.session.ytext.insert(0, "remote ");
    const live = harness.session.comments.get(harness.id)!.range!;
    const movedTarget = harness.root.querySelector<HTMLElement>(`[data-highlight-id="${harness.id}"]`)!;
    harness.target = movedTarget;

    performInteraction(harness, "primary", live.from + 2, "live");

    expect(live.from).toBe(ITEM_RANGE.from + "remote ".length);
    expect(movedTarget).toBe(oldTarget);
    expect(harness.rawClick).toHaveBeenCalledOnce();
    expect(harness.rawClick.mock.calls[0]![2]).toBe(live.from + 2);
    expect(harness.setActiveComment).toHaveBeenCalledOnce();
    expect(harness.panelIsOpen()).toBe(true);
    expect(viewHasFocus(harness)).toBe(true);
  });

  it.each(SURFACES)("rejects unsupported, missing, and decoration-gap targets in the %s editor", (surface) => {
    const harness = makeHarness(surface, "comment");
    harness.setSourcePosition(ITEM_RANGE.from + 2);
    const originalId = harness.target.dataset.highlightId!;
    const originalKind = harness.target.dataset.highlightKind!;

    harness.target.removeAttribute("data-highlight-id");
    performInteraction(harness, "primary", ITEM_RANGE.from + 2, "live");
    harness.target.dataset.highlightId = originalId;
    harness.target.dataset.highlightKind = "find";
    performInteraction(harness, "primary", ITEM_RANGE.from + 2, "live");
    harness.target.dataset.highlightKind = originalKind;
    harness.plainTarget.dataset.highlightId = originalId;
    harness.plainTarget.dataset.highlightKind = originalKind;
    harness.target = harness.plainTarget;
    performInteraction(harness, "primary", ITEM_RANGE.from + 2, "live");

    expect(harness.rawClick).not.toHaveBeenCalled();
    expect(harness.setActiveComment).not.toHaveBeenCalled();
    expect(harness.setActiveSuggestion).not.toHaveBeenCalled();
  });
});
