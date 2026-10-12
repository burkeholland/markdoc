// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AllSelection, EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { parseMarkdown } from "../markdown/parse";
import { headingFoldPlugin, isHeadingFolded, toggleHeadingFold } from "./heading-fold";

const SOURCE = [
  "# One",
  "intro",
  "## A",
  "a1",
  "a2",
  "### A1",
  "a1-1",
  "## B",
  "b1",
  "# Two",
  "two body",
].join("\n\n");

const views: EditorView[] = [];

beforeAll(() => {
  // ProseMirror's own mousedown handler asks the document for the element under the pointer; jsdom has no layout.
  document.elementFromPoint ??= () => null;
});

function mount(markdown = SOURCE): EditorView {
  const host = document.body.appendChild(document.createElement("div"));
  const state = EditorState.create({ doc: parseMarkdown(markdown).doc, plugins: [headingFoldPlugin()] });
  const view = new EditorView(host, { state });
  views.push(view);
  return view;
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.dom.parentElement?.remove();
    view.destroy();
  }
});

function blockPos(view: EditorView, text: string): number {
  let found = -1;
  view.state.doc.forEach((node, offset) => {
    if (found < 0 && node.textContent === text) found = offset;
  });
  if (found < 0) throw new Error(`no block "${text}"`);
  return found;
}

function hiddenTexts(view: EditorView): string[] {
  return Array.from(view.dom.children)
    .filter((child) => child.classList.contains("md-fold-hidden"))
    .map((child) => child.textContent ?? "");
}

function pills(view: EditorView): string[] {
  return Array.from(view.dom.querySelectorAll(".md-fold-pill")).map((pill) => pill.textContent ?? "");
}

function fold(view: EditorView, text: string, deep = false): boolean {
  return toggleHeadingFold(view, blockPos(view, text), deep);
}

function isFolded(view: EditorView, text: string): boolean {
  return isHeadingFolded(view.state, blockPos(view, text));
}

describe("headingFoldPlugin", () => {
  it("hides the blocks under a heading up to the next heading of its level or higher", () => {
    const view = mount();
    expect(fold(view, "A")).toBe(true);
    expect(hiddenTexts(view)).toEqual(["a1", "a2", "A1", "a1-1"]);
    expect(pills(view)).toEqual(["4 blocks hidden"]);
    expect(view.dom.querySelector("h2.md-fold-collapsed")?.firstChild?.textContent).toBe("A");
  });

  it("folds an h1 over its h2s and h3s, and an inner fold survives the outer one", () => {
    const view = mount();
    fold(view, "A");
    fold(view, "One");
    expect(hiddenTexts(view)).toEqual(["intro", "A", "a1", "a2", "A1", "a1-1", "B", "b1"]);
    expect(pills(view)).toEqual(["8 blocks hidden"]);

    fold(view, "One");
    expect(hiddenTexts(view)).toEqual(["a1", "a2", "A1", "a1-1"]);
    expect(isFolded(view, "A")).toBe(true);
    expect(isFolded(view, "One")).toBe(false);
  });

  it("does not fold a heading with nothing under it", () => {
    const view = mount("# One\n\n# Two\n\ntext\n\n## Last");
    expect(fold(view, "One")).toBe(false);
    expect(fold(view, "Last")).toBe(false);
    expect(hiddenTexts(view)).toEqual([]);
    expect(fold(view, "Two")).toBe(true);
    expect(hiddenTexts(view)).toEqual(["text", "Last"]);
  });

  it("an alt-click style toggle folds and unfolds the whole subtree", () => {
    const view = mount();
    fold(view, "One", true);
    expect(isFolded(view, "One")).toBe(true);
    expect(isFolded(view, "A")).toBe(true);
    expect(isFolded(view, "A1")).toBe(true);
    expect(isFolded(view, "B")).toBe(true);
    expect(isFolded(view, "Two")).toBe(false);

    fold(view, "One", true);
    expect(isFolded(view, "A")).toBe(false);
    expect(isFolded(view, "A1")).toBe(false);
    expect(isFolded(view, "B")).toBe(false);
    expect(hiddenTexts(view)).toEqual([]);
  });

  it("moves a caret inside the section to the end of the heading when folding", () => {
    const view = mount();
    const a2 = blockPos(view, "a2");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, a2 + 2)));
    fold(view, "A");
    const heading = blockPos(view, "A");
    expect(view.state.selection.head).toBe(heading + 1 + "A".length);
    expect(isFolded(view, "A")).toBe(true);
  });

  it("keeps a caret outside the section where it is", () => {
    const view = mount();
    const b1 = blockPos(view, "b1");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, b1 + 1)));
    fold(view, "A");
    expect(view.state.selection.head).toBe(b1 + 1);
  });

  it("opens the folded sections around a selection that lands inside one", () => {
    const view = mount();
    fold(view, "A1");
    fold(view, "A");
    fold(view, "One");
    const target = blockPos(view, "a1-1");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target + 1)));
    expect(isFolded(view, "One")).toBe(false);
    expect(isFolded(view, "A")).toBe(false);
    expect(isFolded(view, "A1")).toBe(false);
    expect(hiddenTexts(view)).toEqual([]);
  });

  it("leaves a fold that does not contain the selection alone", () => {
    const view = mount();
    fold(view, "A");
    fold(view, "B");
    const two = blockPos(view, "two body");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, two + 1)));
    expect(isFolded(view, "A")).toBe(true);
    expect(isFolded(view, "B")).toBe(true);
  });

  it("does not open anything for select all", () => {
    const view = mount();
    fold(view, "B");
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    expect(isFolded(view, "B")).toBe(true);
  });

  it("keeps a fold on its heading when text is added above and inside it", () => {
    const view = mount();
    fold(view, "A");
    view.dispatch(view.state.tr.insertText("new ", blockPos(view, "intro") + 1));
    expect(isFolded(view, "A")).toBe(true);
    expect(hiddenTexts(view)).toEqual(["a1", "a2", "A1", "a1-1"]);
    view.dispatch(view.state.tr.insertText("x", blockPos(view, "A") + 1));
    expect(isFolded(view, "xA")).toBe(true);
    expect(hiddenTexts(view)).toEqual(["a1", "a2", "A1", "a1-1"]);
  });

  it("drops the fold when its heading is deleted or has nothing left under it", () => {
    const view = mount();
    fold(view, "B");
    const b1 = blockPos(view, "b1");
    view.dispatch(view.state.tr.delete(b1, b1 + view.state.doc.nodeAt(b1)!.nodeSize));
    expect(isFolded(view, "B")).toBe(false);
    expect(view.dom.querySelector(".md-fold-pill")).toBeNull();
    expect(view.dom.querySelector(".md-fold-collapsed")).toBeNull();

    fold(view, "A");
    const a = blockPos(view, "A");
    view.dispatch(view.state.tr.delete(a, a + view.state.doc.nodeAt(a)!.nodeSize));
    expect(hiddenTexts(view)).toEqual([]);
  });

  it("opens the section when a new block appears under a folded heading with the caret in it", () => {
    const view = mount();
    fold(view, "B");
    const heading = blockPos(view, "B");
    const end = heading + view.state.doc.nodeAt(heading)!.nodeSize;
    const paragraph = view.state.schema.nodes.paragraph.create(null, view.state.schema.text("typed"));
    const tr = view.state.tr.insert(end, paragraph);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, end + 1)));
    expect(isFolded(view, "B")).toBe(false);
  });

  it("toggles on a click left of a heading's box and ignores a click on its text", () => {
    const view = mount();
    const heading = Array.from(view.dom.children).find((child) => child.firstChild?.textContent === "A")!;
    heading.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 20 }));
    expect(isFolded(view, "A")).toBe(false);

    const chevron = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: -10 });
    heading.dispatchEvent(chevron);
    expect(isFolded(view, "A")).toBe(true);
    expect(chevron.defaultPrevented).toBe(true);

    heading.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: -10, altKey: true }));
    expect(isFolded(view, "A")).toBe(false);
  });

  it("unfolds from the hidden-blocks tag", () => {
    const view = mount();
    fold(view, "B");
    const pill = view.dom.querySelector(".md-fold-pill")!;
    expect(pill.textContent).toBe("1 block hidden");
    pill.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(isFolded(view, "B")).toBe(false);
    expect(view.dom.querySelector(".md-fold-pill")).toBeNull();
  });

  it("does not put fold state into the document", () => {
    const view = mount();
    const before = view.state.doc;
    fold(view, "A");
    expect(view.state.doc).toBe(before);
  });

  it("holds the page height while folding and gives it back when the editor goes away", () => {
    const view = mount();
    const scroller = view.dom.parentElement!;
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 500 });
    Object.defineProperty(view.dom, "offsetHeight", { configurable: true, value: 1800 });

    fold(view, "A");
    expect(view.dom.style.minHeight).toBe("1800px");
    fold(view, "A");
    expect(view.dom.style.minHeight).toBe("1800px");
    view.destroy();
    expect(view.dom.style.minHeight).toBe("");
  });
});
