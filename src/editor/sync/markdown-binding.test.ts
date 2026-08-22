// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { splitBlock, setBlockType } from "prosemirror-commands";
import { MarkdownBinding, markdownBindingPlugin } from "./markdown-binding";
import { schema } from "../markdown/schema";
import { diffOps, diffOpsWords, applyOps } from "./text-diff";

function makeEditor(ytext: Y.Text) {
  const binding = new MarkdownBinding(ytext);
  const state = EditorState.create({ doc: binding.initialDoc(), plugins: [markdownBindingPlugin(binding)] });
  const view = new EditorView(document.createElement("div"), { state });
  return { binding, view };
}

function typeText(view: EditorView, text: string, at?: number) {
  const tr = view.state.tr;
  if (at !== undefined) tr.setSelection(TextSelection.create(tr.doc, at));
  tr.insertText(text);
  view.dispatch(tr);
}

describe("diffOps", () => {
  it("produces minimal operations", () => {
    expect(diffOps("hello world", "hello brave world", 10)).toEqual([{ index: 16, deleteCount: 0, insert: "brave " }]);
    expect(diffOps("abc", "axc")).toEqual([{ index: 1, deleteCount: 1, insert: "x" }]);
    expect(diffOps("same", "same")).toEqual([]);
  });

  it("produces word-level operations that apply cleanly", () => {
    const oldText = "# Draft\n\nSecond version by the agent.\n\n- Ship\n";
    const newText = "# Draft\n\nImproved version by the agent.\n\n- Ship it to everyone\n";
    const ops = diffOpsWords(oldText, newText);
    expect(ops).toEqual([
      { index: 9, deleteCount: 6, insert: "Improved" },
      { index: 47, deleteCount: 0, insert: " it to everyone" },
    ]);
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("t");
    ytext.insert(0, oldText);
    applyOps(ytext, ops);
    expect(ytext.toString()).toBe(newText);
    expect(diffOpsWords("same", "same")).toEqual([]);
  });
});

describe("MarkdownBinding", () => {
  let ydoc: Y.Doc;
  let ytext: Y.Text;
  const views: EditorView[] = [];
  const bindings: MarkdownBinding[] = [];

  beforeEach(() => {
    ydoc = new Y.Doc();
    ytext = ydoc.getText("content");
  });
  afterEach(() => {
    for (const v of views) v.destroy();
    for (const b of bindings) b.destroy();
    views.length = 0;
    bindings.length = 0;
  });

  const editor = (t: Y.Text = ytext) => {
    const e = makeEditor(t);
    views.push(e.view);
    bindings.push(e.binding);
    return e;
  };

  it("builds the initial document from the text", () => {
    ytext.insert(0, "# Title\n\nHello **world**.");
    const { view, binding } = editor();
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(0).type.name).toBe("heading");
    expect(binding.blocks).toEqual([
      { from: 0, to: 7 },
      { from: 9, to: 25 },
    ]);
  });

  it("applies local typing to the text as a minimal diff", () => {
    ytext.insert(0, "# Title\n\nHello world.");
    const { view, binding } = editor();
    const updates: Uint8Array[] = [];
    ydoc.on("update", (u: Uint8Array) => updates.push(u));
    // Insert after "Hello" in the paragraph: heading nodeSize 7, paragraph starts at 7, text at 8.
    typeText(view, ",", 8 + 5);
    expect(ytext.toString()).toBe("# Title\n\nHello, world.");
    expect(binding.blocks).toEqual([
      { from: 0, to: 7 },
      { from: 9, to: 22 },
    ]);
    expect(updates.length).toBe(1);
  });

  it("reflects text changes in the rich editor while preserving the selection", () => {
    ytext.insert(0, "# Title\n\nHello world.");
    const { view } = editor();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8 + 11)));
    // Someone edits the heading.
    ytext.insert(7, " Page");
    expect(view.state.doc.child(0).textContent).toBe("Title Page");
    expect(view.state.doc.child(1).textContent).toBe("Hello world.");
    // Selection moved by the 5 inserted characters.
    expect(view.state.selection.head).toBe(8 + 11 + 5);
  });

  it("keeps the selection when a remote user edits the same paragraph", () => {
    ytext.insert(0, "Hello world.");
    const { view } = editor();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1 + 12)));
    ytext.insert(0, "Oh! ");
    expect(view.state.doc.textContent).toBe("Oh! Hello world.");
    expect(view.state.selection.head).toBe(1 + 16);
  });

  it("syncs two clients through Yjs updates in both directions", () => {
    ytext.insert(0, "# Doc\n\nFirst paragraph.");
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc));
    ydoc.on("update", (u: Uint8Array) => Y.applyUpdate(other, u));
    other.on("update", (u: Uint8Array) => Y.applyUpdate(ydoc, u));
    const a = editor();
    const b = editor(other.getText("content"));

    typeText(a.view, " Really.", 6 + 16);
    expect(other.getText("content").toString()).toBe("# Doc\n\nFirst paragraph. Really.");
    expect(b.view.state.doc.child(1).textContent).toBe("First paragraph. Really.");

    // B edits the "code" side directly.
    other.getText("content").insert(other.getText("content").length, "\n\n- item");
    expect(a.view.state.doc.childCount).toBe(3);
    expect(a.view.state.doc.child(2).type.name).toBe("bullet_list");
    expect(a.binding.blocks[2]).toEqual({ from: 33, to: 39 });
  });

  it("turns a paragraph into a heading", () => {
    ytext.insert(0, "Intro\n\nBody text.");
    const { view } = editor();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    setBlockType(schema.nodes.heading, { level: 2 })(view.state, view.dispatch);
    expect(ytext.toString()).toBe("## Intro\n\nBody text.");
  });

  it("keeps empty paragraphs as phantoms until they get content", () => {
    ytext.insert(0, "First.");
    const { view, binding } = editor();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7)));
    splitBlock(view.state, view.dispatch);
    expect(view.state.doc.childCount).toBe(2);
    expect(ytext.toString()).toBe("First.");
    expect(binding.blocks[1]).toEqual({ from: 6, to: 6, phantom: true });

    typeText(view, "Second.");
    expect(ytext.toString()).toBe("First.\n\nSecond.");
    expect(binding.blocks).toEqual([
      { from: 0, to: 6 },
      { from: 8, to: 15 },
    ]);
    expect(view.state.doc.childCount).toBe(2);
  });

  it("keeps a phantom paragraph across remote edits", () => {
    ytext.insert(0, "First.\n\nThird.");
    const { view } = editor();
    // Split after "First." to make an empty paragraph between the two.
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7)));
    splitBlock(view.state, view.dispatch);
    expect(view.state.doc.childCount).toBe(3);
    expect(ytext.toString()).toBe("First.\n\nThird.");
    ytext.insert(0, "Zero.\n\n");
    const types: string[] = [];
    view.state.doc.forEach((n) => types.push(n.textContent));
    expect(types).toEqual(["Zero.", "First.", "", "Third."]);
  });

  it("deletes blocks from the text when removed in the rich editor", () => {
    ytext.insert(0, "One.\n\nTwo.\n\nThree.");
    const { view, binding } = editor();
    // Delete the second paragraph (positions 6..12).
    view.dispatch(view.state.tr.delete(6, 12));
    expect(ytext.toString()).toBe("One.\n\nThree.");
    expect(binding.blocks).toEqual([
      { from: 0, to: 4 },
      { from: 6, to: 12 },
    ]);
  });

  it("inserts a new block in the middle", () => {
    ytext.insert(0, "One.\n\nThree.");
    const { view, binding } = editor();
    view.dispatch(view.state.tr.insert(6, schema.nodes.paragraph.create(null, schema.text("Two."))));
    expect(ytext.toString()).toBe("One.\n\nTwo.\n\nThree.");
    expect(binding.blocks).toEqual([
      { from: 0, to: 4 },
      { from: 6, to: 10 },
      { from: 12, to: 18 },
    ]);
  });

  it("starts from an empty document", () => {
    const { view, binding } = editor();
    expect(view.state.doc.childCount).toBe(1);
    typeText(view, "Hello", 1);
    expect(ytext.toString()).toBe("Hello");
    expect(binding.blocks).toEqual([{ from: 0, to: 5 }]);
    // Delete everything again.
    view.dispatch(view.state.tr.delete(1, 6));
    expect(ytext.toString()).toBe("");
    typeText(view, "Again", 1);
    expect(ytext.toString()).toBe("Again");
  });

  it("drops the empty-document placeholder once content arrives from the server", () => {
    const { view, binding } = editor(); // text is empty at construction time, like before the provider syncs
    expect(view.state.doc.childCount).toBe(1);
    ytext.insert(0, "# Title\n\nBody.");
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(0).type.name).toBe("heading");
    expect(binding.blocks).toEqual([
      { from: 0, to: 7 },
      { from: 9, to: 14 },
    ]);
    // Clearing the text brings a placeholder back.
    ytext.delete(0, ytext.length);
    expect(view.state.doc.childCount).toBe(1);
    expect(binding.blocks).toEqual([{ from: 0, to: 0, phantom: true }]);
  });

  it("falls back to a full re-sync when the markdown normalizes the structure", async () => {
    ytext.insert(0, "- a\n- b");
    const { view } = editor();
    // Insert a second bullet list right after the first: Markdown merges them.
    const list = schema.nodes.bullet_list.create(null, [
      schema.nodes.list_item.create(null, schema.nodes.paragraph.create(null, schema.text("c"))),
    ]);
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, list));
    await new Promise<void>((r) => queueMicrotask(r));
    expect(ytext.toString()).toBe("- a\n- b\n\n- c");
    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.child(0).childCount).toBe(3);
  });

  it("maps positions between surfaces including phantoms", () => {
    ytext.insert(0, "First.\n\nThird.");
    const { view, binding } = editor();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7)));
    splitBlock(view.state, view.dispatch);
    const map = binding.getSourceMap();
    // "Third." now lives in block 2 (pm pos 10..), source offset 8.
    expect(map.srcToPm(8)).toBe(11);
    expect(map.pmToSrc(11)).toBe(8);
    expect(map.pmToSrc(9)).toBe(6); // inside the phantom → end of previous block
  });

  it("supports an interceptor taking over local changes", async () => {
    ytext.insert(0, "Hello world.");
    const { view, binding } = editor();
    const seen: unknown[] = [];
    binding.setInterceptor((ops, text, origin) => {
      seen.push(ops);
      text.doc!.transact(() => text.insert(text.length, " (intercepted)"), origin);
      return true;
    });
    typeText(view, "X", 1);
    await new Promise<void>((r) => queueMicrotask(r));
    expect(seen).toEqual([[{ index: 0, deleteCount: 0, insert: "X" }]]);
    expect(ytext.toString()).toBe("Hello world. (intercepted)");
    expect(view.state.doc.textContent).toBe("Hello world. (intercepted)");
  });
});

