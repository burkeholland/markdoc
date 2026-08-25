// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { splitBlock, setBlockType } from "prosemirror-commands";
import { MarkdownBinding, markdownBindingPlugin, minimalReplaceTransaction, isStructuralChange, VERIFY_TRUST_AFTER, VERIFY_EVERY_NTH_WINDOW } from "./markdown-binding";
import { schema } from "../markdown/schema";
import { parseMarkdown } from "../markdown/parse";
import { insertHardBreak } from "../prosemirror/commands";
import { textChangeSpan } from "../markdown/incremental";
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

  it("reproduces a table column removed in the text exactly in the rich editor (task #459)", () => {
    // Undo of "add column" in the table menu: one Y transaction deletes a cell from every row. The
    // diff starts inside the header's second cell and ends inside the last row; ProseMirror's fitted
    // replace kept the header's empty cell (a 4×3 header over 4×2 bodies, then padded by fixTables)
    // while the text already said 4×2.
    const before = "Intro.\n\n| Column 1 |     | c1  |\n| -------- | --- | --- |\n| c2       |     | c3  |\n|          |     |     |\n|          |     |     |\n\nAfter text.\n";
    const after = "Intro.\n\n| Column 1 | c1  |\n| -------- | --- |\n| c2       | c3  |\n|          |     |\n|          |     |\n\nAfter text.\n";
    const expected = parseMarkdown(after).doc;
    const fitted = minimalReplaceTransaction(EditorState.create({ doc: parseMarkdown(before).doc }), expected);
    expect(fitted.doc.eq(expected)).toBe(true);
    expect(fitted.doc.child(1).child(0).childCount).toBe(2);

    ytext.insert(0, before);
    const { view } = editor();
    // Caret at the end of "After text." keeps its place relative to the paragraph.
    const tail = view.state.doc.content.size - 2;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, tail)));
    applyOps(ytext, diffOps(before, after));
    expect(view.state.doc.eq(expected)).toBe(true);
    expect(view.state.selection.head).toBe(view.state.doc.content.size - 2);
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

  it("Enter at the end of a quoted line keeps the caret in the quote and never re-syncs it away (task #415)", async () => {
    // Burke #1240: the empty paragraph splitBlock created inside the blockquote had no Markdown form,
    // the binding fell back to a full re-sync that dropped it, and the caret landed in the next block.
    ytext.insert(0, "# H1\n\n> A quote line.\n\n## Heading two\n");
    const { view, binding } = editor();
    const endOfQuote = 4 + 1 + 1 + "A quote line.".length;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, endOfQuote)));
    splitBlock(view.state, view.dispatch);
    await new Promise<void>((r) => queueMicrotask(r));
    expect(ytext.toString()).toBe("# H1\n\n> A quote line.\n>\n>\n\n## Heading two\n");
    expect(view.state.doc.child(1).childCount).toBe(2);
    expect(view.state.selection.$from.node(-1).type.name).toBe("blockquote");
    expect(view.state.selection.$from.parent.content.size).toBe(0);
    expect(binding.blocks[1]).toEqual({ from: 6, to: 25 });
    // Typing lands in the new quote line, not at the top of the document or in the heading.
    typeText(view, "more");
    await new Promise<void>((r) => queueMicrotask(r));
    expect(ytext.toString()).toBe("# H1\n\n> A quote line.\n>\n> more\n\n## Heading two\n");
  });

  it("Shift+Enter inside a quote keeps the break in both panes, then the typed line follows it (task #434)", async () => {
    // The break has nothing after it when it is inserted; it must still survive the round trip, or
    // the binding re-syncs the quote without it and the next line is glued on: "> A quote line.second line".
    ytext.insert(0, "# H1\n\n> A quote line.\n\n## Heading two\n");
    const { view } = editor();
    const endOfQuote = 4 + 1 + 1 + "A quote line.".length;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, endOfQuote)));
    insertHardBreak()(view.state, view.dispatch);
    await new Promise<void>((r) => queueMicrotask(r));
    expect(ytext.toString()).toBe("# H1\n\n> A quote line.<br>\n\n## Heading two\n");
    expect(view.state.doc.child(1).firstChild!.lastChild!.type.name).toBe("hard_break");
    expect(view.state.selection.$from.node(-1).type.name).toBe("blockquote");
    typeText(view, "second line");
    await new Promise<void>((r) => queueMicrotask(r));
    expect(ytext.toString()).toBe("# H1\n\n> A quote line.\\\n> second line\n\n## Heading two\n");
    expect(view.state.doc.child(1).firstChild!.childCount).toBe(3);
    expect(view.state.doc.child(1).firstChild!.child(1).type.name).toBe("hard_break");
    // Reload from the text: the same document comes back.
    expect(parseMarkdown(ytext.toString()).doc.eq(view.state.doc)).toBe(true);
  });

  it("Enter at the end of a code block keeps the blank last line (task #434)", async () => {
    ytext.insert(0, "```ts\nconst a = 1;\n```\n\nEnd.\n");
    const { view } = editor();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1 + "const a = 1;".length)));
    typeText(view, "\n");
    await new Promise<void>((r) => queueMicrotask(r));
    expect(ytext.toString()).toBe("```ts\nconst a = 1;\n\n```\n\nEnd.\n");
    expect(view.state.doc.firstChild!.textContent).toBe("const a = 1;\n");
    typeText(view, "\n");
    await new Promise<void>((r) => queueMicrotask(r));
    expect(ytext.toString()).toBe("```ts\nconst a = 1;\n\n\n```\n\nEnd.\n");
    expect(view.state.doc.firstChild!.textContent).toBe("const a = 1;\n\n");
    expect(parseMarkdown(ytext.toString()).doc.eq(view.state.doc)).toBe(true);
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

  describe("typing in the trailing paragraph of a document with an unpadded table (task #475)", () => {
    const FIXTURE =
      "# Scout doc\n\nFirst paragraph with some words to select here.\n\n- item one\n- item two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nLast paragraph.\n";
    const TABLE_LINES = ["| a | b |", "| --- | --- |", "| 1 | 2 |"];
    const tick = () => new Promise<void>((r) => queueMicrotask(r));
    const typeChars = async (view: EditorView, text: string) => {
      for (const ch of text) {
        view.dispatch(view.state.tr.insertText(ch));
        await tick();
      }
    };
    /** Every Y.Text delta as { retain, insert, delete } so a test can check the exact writes. */
    const recordDeltas = (t: Y.Text) => {
      const deltas: { retain: number; insert: string; delete: number }[] = [];
      t.observe((event) => {
        let retain = 0;
        let insert = "";
        let del = 0;
        for (const d of event.delta) {
          if (d.retain) retain += d.retain;
          if (typeof d.insert === "string") insert += d.insert;
          if (d.delete) del += d.delete;
        }
        deltas.push({ retain, insert, delete: del });
      });
      return deltas;
    };
    /** Enter at the end of the document, then "/" and Backspace (the slash menu), as in the issue. */
    const makeTrailingParagraph = async (view: EditorView) => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.doc.content.size - 1)));
      splitBlock(view.state, view.dispatch);
      await tick();
      await typeChars(view, "/");
      view.dispatch(view.state.tr.delete(view.state.selection.from - 1, view.state.selection.from));
      await tick();
      expect(ytext.toString()).toBe(FIXTURE);
      expect(view.state.doc.childCount).toBe(6);
    };
    const tableLinesOf = (text: string) => text.split("\n").slice(7, 10);
    const lastParagraphEnd = FIXTURE.indexOf("Last paragraph.") + "Last paragraph.".length;

    it("editing mode: the text delta is exactly the typed word and the table is untouched", async () => {
      ytext.insert(0, FIXTURE);
      const { view } = editor();
      await makeTrailingParagraph(view);
      const deltas = recordDeltas(ytext);
      await typeChars(view, " suggested-words");
      expect(ytext.toString()).toBe(FIXTURE.trimEnd() + "\n\n suggested-words\n");
      expect(tableLinesOf(ytext.toString())).toEqual(TABLE_LINES);
      // One write per keystroke, each an insertion at or after the end of "Last paragraph.", never a delete.
      expect(deltas.map((d) => d.insert).join("")).toBe("\n\n suggested-words");
      expect(deltas.every((d) => d.delete === 0 && d.retain >= lastParagraphEnd)).toBe(true);
      expect(view.state.doc.childCount).toBe(6);
      expect(view.state.doc.lastChild!.textContent).toBe(" suggested-words");
    });

    it("suggesting mode: the interceptor sees only the typed word and the filled phantom does not come back", async () => {
      ytext.insert(0, FIXTURE);
      const { view, binding } = editor();
      await makeTrailingParagraph(view);
      const seen: { index: number; deleteCount: number; insert: string }[] = [];
      // Like richSuggestingPlugin: apply the ops verbatim under another origin and let the binding re-sync.
      binding.setInterceptor((ops, text, origin) => {
        seen.push(...ops);
        text.doc!.transact(() => applyOps(text, ops), origin);
        return true;
      });
      await typeChars(view, " suggested-words");
      expect(seen.map((op) => op.insert).join("")).toBe("\n\n suggested-words");
      expect(seen.every((op) => op.deleteCount === 0 && op.index >= lastParagraphEnd)).toBe(true);
      expect(tableLinesOf(ytext.toString())).toEqual(TABLE_LINES);
      expect(ytext.toString()).toBe(FIXTURE.trimEnd() + "\n\n suggested-words\n");
      // The empty paragraph the word was typed into is now a real block, not an extra blank line before it.
      expect(view.state.doc.childCount).toBe(6);
      expect(view.state.doc.lastChild!.textContent).toBe(" suggested-words");
    });

    it("control: typing at the end of the last paragraph stays a minimal diff", async () => {
      ytext.insert(0, FIXTURE);
      const { view } = editor();
      const deltas = recordDeltas(ytext);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.doc.content.size - 1)));
      await typeChars(view, " suggested-words");
      expect(deltas.map((d) => d.insert).join("")).toBe(" suggested-words");
      expect(deltas.every((d) => d.delete === 0 && d.retain >= lastParagraphEnd)).toBe(true);
      expect(tableLinesOf(ytext.toString())).toEqual(TABLE_LINES);
    });
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

  describe("parse verification", () => {
    const DOC = "# Title\n\nFirst paragraph with words.\n\n- one\n- two\n\nLast paragraph.";
    let visibility: DocumentVisibilityState;

    beforeEach(() => {
      vi.useFakeTimers();
      visibility = "visible";
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    });
    afterEach(() => {
      vi.useRealTimers();
      delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    });

    /** Type `ch` at the end of the last paragraph through the text (the code pane / remote path) and let the quiet period elapse. */
    const typeAndPause = (ch: string) => {
      ytext.insert(ytext.length, ch);
      vi.advanceTimersByTime(1000);
    };
    /** Drive the binding until the incremental parser is trusted. */
    const N = VERIFY_TRUST_AFTER;
    const trust = (binding: MarkdownBinding) => {
      for (let i = 0; i < N; i++) typeAndPause("x");
      expect(binding.verifyStats).toMatchObject({ runs: N, matches: N, mismatches: 0, skipped: 0 });
    };

    it("detects structural edits", () => {
      const structural = (before: string, after: string) => {
        const span = textChangeSpan(before, after)!;
        return isStructuralChange(before, after, span);
      };
      expect(structural("Hello world", "Hello brave world")).toBe(false);
      expect(structural("Hello world", "Hello **brave** world")).toBe(false);
      expect(structural("Hello world", "Hello `brave` world")).toBe(false);
      expect(structural("Hello world", "Hello [world]")).toBe(true);
      expect(structural("Hello world", "Hello world[^1]")).toBe(true);
      expect(structural("a | b", "a | bc")).toBe(true);
      expect(structural("Hello", "# Hello")).toBe(true);
      expect(structural("Hello", "- Hello")).toBe(true);
      expect(structural("Hello", "> Hello")).toBe(true);
      expect(structural("Hello\n", "Hello\n---")).toBe(true);
      expect(structural("Hello world", "Hello\n\nworld")).toBe(true);
      expect(structural("```\ncode\n```", "```\ncod\n```")).toBe(false);
      expect(structural("```\ncode\n```", "\ncode\n```")).toBe(true);
      expect(structural("text\n\n    code", "text\n\n    cod")).toBe(true);
    });

    it("verifies an incremental parse after the quiet period and repairs drift", () => {
      ytext.insert(0, DOC);
      const { view, binding } = editor();
      typeAndPause("!");
      expect(binding.verifyStats).toMatchObject({ runs: 1, matches: 1, mismatches: 0 });

      // Inject a wrong incremental result and let the editor render it, as a drifted parse would.
      const wrong = parseMarkdown("# Wrong\n\nonly this");
      binding["parseCache"] = { text: ytext.toString(), result: wrong };
      binding.syncFromText();
      expect(view.state.doc.childCount).toBe(2);
      expect(view.state.doc.child(0).textContent).toBe("Wrong");

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(binding.verifyParse()).toBe(false);
      warn.mockRestore();
      expect(binding.verifyStats).toMatchObject({ runs: 2, matches: 1, mismatches: 1 });
      expect(view.state.doc.childCount).toBe(4);
      expect(view.state.doc.child(0).textContent).toBe("Title");
      expect(view.state.doc.child(3).textContent).toBe("Last paragraph.!");
      expect(binding.blocks.length).toBe(4);
    });

    it("skips the verification for routine edits once trusted, but not for structural ones", () => {
      ytext.insert(0, DOC);
      const { binding } = editor();
      trust(binding);

      typeAndPause("y");
      expect(binding.verifyStats).toMatchObject({ runs: N, skipped: 1 });
      typeAndPause(" more `code`");
      expect(binding.verifyStats).toMatchObject({ runs: N, skipped: 2 });

      typeAndPause(" [ref]");
      expect(binding.verifyStats).toMatchObject({ runs: N + 1, matches: N + 1, skipped: 2 });
      typeAndPause("\n\n## Heading");
      expect(binding.verifyStats).toMatchObject({ runs: N + 2, matches: N + 2, skipped: 2 });

      // A structural edit followed by a routine one within the same quiet period still verifies.
      ytext.insert(ytext.length, " [x]");
      typeAndPause("z");
      expect(binding.verifyStats).toMatchObject({ runs: N + 3, skipped: 2 });
    });

    it("still verifies a routine edit every 25th idle window once trusted", () => {
      ytext.insert(0, DOC);
      const { binding } = editor();
      trust(binding);
      for (let i = 0; i < VERIFY_EVERY_NTH_WINDOW - 1; i++) typeAndPause("r");
      expect(binding.verifyStats).toMatchObject({ runs: N, skipped: VERIFY_EVERY_NTH_WINDOW - 1 });
      typeAndPause("r");
      expect(binding.verifyStats).toMatchObject({ runs: N + 1, skipped: VERIFY_EVERY_NTH_WINDOW - 1 });
      typeAndPause("r");
      expect(binding.verifyStats).toMatchObject({ runs: N + 1, skipped: VERIFY_EVERY_NTH_WINDOW });
    });

    it("resets the trust after a mismatch", () => {
      ytext.insert(0, DOC);
      const { binding } = editor();
      trust(binding);
      binding["parseCache"] = { text: ytext.toString(), result: parseMarkdown("# Wrong") };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      binding.verifyParse();
      warn.mockRestore();
      typeAndPause("q");
      expect(binding.verifyStats).toMatchObject({ runs: N + 2, mismatches: 1, skipped: 0 });
    });

    it("does not verify while the tab is hidden and catches up when it becomes visible", () => {
      ytext.insert(0, DOC);
      const { binding } = editor();
      visibility = "hidden";
      typeAndPause("h");
      vi.advanceTimersByTime(10000);
      expect(binding.verifyStats.runs).toBe(0);

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      expect(binding.verifyStats.runs).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(binding.verifyStats).toMatchObject({ runs: 1, matches: 1 });
    });

    it("cancels a pending verification when another keystroke arrives", () => {
      ytext.insert(0, DOC);
      const { binding } = editor();
      for (let i = 0; i < 5; i++) {
        ytext.insert(ytext.length, "k");
        vi.advanceTimersByTime(900);
      }
      expect(binding.verifyStats.runs).toBe(0);
      vi.advanceTimersByTime(100);
      expect(binding.verifyStats.runs).toBe(1);
    });
  });
});

