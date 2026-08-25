// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DOMParser as PMDOMParser } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema } from "../markdown/schema";
import { serializeMarkdown } from "../markdown/serialize";
import { MarkdownBinding, markdownBindingPlugin } from "../sync/markdown-binding";
import { isUrlText, looksLikeMarkdown, smartPastePlugin } from "./paste";

/** Parse HTML the way the rich pane does on paste and serialize the result to Markdown. */
function htmlToMarkdown(html: string): string {
  const dom = document.createElement("div");
  dom.innerHTML = html;
  const doc = PMDOMParser.fromSchema(schema).parse(dom);
  return serializeMarkdown(doc).trim();
}

function clipboard(text: string, html = ""): ClipboardEvent {
  const types: Record<string, string> = { "text/plain": text, "text/html": html };
  return {
    clipboardData: { getData: (type: string) => types[type] ?? "", types: Object.keys(types).filter((t) => types[t]) },
    preventDefault() {},
  } as unknown as ClipboardEvent;
}

describe("HTML paste fidelity (parseDOM → Markdown)", () => {
  it("headings", () => {
    expect(htmlToMarkdown("<h1>Title</h1><h2>Section</h2><h3>Sub</h3><p>Body</p>")).toBe("# Title\n\n## Section\n\n### Sub\n\nBody");
  });

  it("bold, italic, strikethrough and inline code", () => {
    expect(htmlToMarkdown("<p>a <b>bold</b> and <strong>strong</strong> <i>italic</i> <em>em</em> <code>code</code> <s>gone</s></p>")).toBe(
      "a **bold** and **strong** *italic* *em* `code` ~~gone~~",
    );
  });

  it("word-processor bold via span font-weight and its font-weight:normal wrapper", () => {
    const html =
      '<b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-size:11pt;font-family:Arial;">Plain </span><span style="font-weight:700;">bold</span><span style="font-style:italic;"> italic</span><span style="text-decoration:line-through;"> struck</span></p></b>';
    expect(htmlToMarkdown(html)).toBe("Plain **bold** *italic* ~~struck~~");
  });

  it("links and images", () => {
    expect(htmlToMarkdown('<p>See <a href="https://example.com/x">the docs</a> and <img src="https://example.com/a.png" alt="Alt"></p>')).toBe(
      "See [the docs](https://example.com/x) and ![Alt](https://example.com/a.png)",
    );
  });

  it("hard breaks", () => {
    expect(htmlToMarkdown("<p>line one<br>line two</p>")).toBe("line one\\\nline two");
  });

  it("nested lists", () => {
    const html = "<ul><li>one<ul><li>nested</li><li>again</li></ul></li><li>two</li></ul><ol start=\"3\"><li>three</li><li>four</li></ol>";
    expect(htmlToMarkdown(html)).toBe("- one\n  - nested\n  - again\n- two\n\n3. three\n4. four");
  });

  it("lists whose items contain paragraphs", () => {
    expect(htmlToMarkdown("<ul><li><p>one</p></li><li><p>two</p></li></ul>")).toBe("- one\n- two");
  });

  it("fenced code from pre/code", () => {
    expect(htmlToMarkdown("<pre><code>const a = 1;\nconsole.log(a);</code></pre>")).toBe("```\nconst a = 1;\nconsole.log(a);\n```");
  });

  it("blockquotes", () => {
    expect(htmlToMarkdown("<blockquote><p>quoted</p></blockquote>")).toBe("> quoted");
  });

  it("tables", () => {
    const html = "<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>Apple</td><td>3</td></tr><tr><td>Pear</td><td>10</td></tr></tbody></table>";
    expect(htmlToMarkdown(html)).toBe("| Name  | Qty |\n| ----- | --- |\n| Apple | 3   |\n| Pear  | 10  |");
  });

  it("web-page noise: divs and spans without semantics become paragraphs", () => {
    expect(htmlToMarkdown('<div><span class="x">Hello</span> <span>world</span></div><div>Second</div>')).toBe("Hello world\n\nSecond");
  });
});

describe("heuristics", () => {
  it("recognizes URLs", () => {
    expect(isUrlText("https://example.com/a_b?x=1")).toBe(true);
    expect(isUrlText("  http://example.com  ")).toBe(true);
    expect(isUrlText("www.example.com")).toBe(true);
    expect(isUrlText("mailto:a@b.co")).toBe(true);
    expect(isUrlText("not a url")).toBe(false);
    expect(isUrlText("https://a.com and more")).toBe(false);
  });

  it("recognizes Markdown-looking text", () => {
    expect(looksLikeMarkdown("# Title\n\n- a\n- b")).toBe(true);
    expect(looksLikeMarkdown("```js\nlet a = 1;\n```")).toBe(true);
    expect(looksLikeMarkdown("some text\nwith a [link](https://x.y)")).toBe(true);
    expect(looksLikeMarkdown("first\n**bold** second")).toBe(true);
    expect(looksLikeMarkdown("1. one\n2. two")).toBe(true);
    expect(looksLikeMarkdown("> quote\nmore")).toBe(true);
    expect(looksLikeMarkdown("# single line")).toBe(false);
    expect(looksLikeMarkdown("just two\nplain lines")).toBe(false);
  });
});

describe("smartPastePlugin", () => {
  let ydoc: Y.Doc;
  let ytext: Y.Text;
  let binding: MarkdownBinding;
  let view: EditorView;
  let undoManager: Y.UndoManager;

  const setup = (markdown: string, mode = "editing") => {
    ydoc = new Y.Doc();
    ytext = ydoc.getText("content");
    ytext.insert(0, markdown);
    binding = new MarkdownBinding(ytext);
    undoManager = new Y.UndoManager(ytext, { captureTimeout: 0, trackedOrigins: new Set() });
    undoManager.addTrackedOrigin(binding);
    const session = { ydoc, ytext, binding, undoManager, mode };
    const state = EditorState.create({
      doc: binding.initialDoc(),
      plugins: [markdownBindingPlugin(binding), smartPastePlugin(session)],
    });
    view = new EditorView(document.createElement("div"), { state });
    return session;
  };

  const select = (from: number, to = from) => {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
  };

  beforeEach(() => setup("Hello world"));
  afterEach(() => {
    view.destroy();
    binding.destroy();
  });

  it("pasting a URL over a selection wraps it in a link", () => {
    select(7, 12);
    expect(view.state.doc.textBetween(7, 12)).toBe("world");
    view.pasteText("https://example.com/w", clipboard("https://example.com/w"));
    expect(ytext.toString()).toBe("Hello [world](https://example.com/w)");
    expect(view.state.doc.firstChild!.childCount).toBe(2);
  });

  it("pasting a www URL over a selection links with an https scheme", () => {
    select(1, 6);
    view.pasteText("www.example.com", clipboard("www.example.com"));
    expect(ytext.toString()).toBe("[Hello](https://www.example.com) world");
  });

  it("pasting a URL over a selection inside a code block inserts it as text", () => {
    view.destroy();
    binding.destroy();
    setup("```\nabc\n```");
    select(2, 3);
    view.pasteText("https://example.com", clipboard("https://example.com"));
    expect(ytext.toString()).toBe("```\nahttps://example.comc\n```");
  });

  it("pasting a URL with no selection inserts it as text", () => {
    select(12);
    view.pasteText(" https://example.com", clipboard(" https://example.com"));
    expect(ytext.toString()).toBe("Hello world https://example.com");
    expect(view.state.doc.firstChild!.childCount).toBe(1);
  });

  it("pasting Markdown-looking text inserts it as source that renders as structure", () => {
    select(12);
    view.pasteText("# Title\n\n- a\n- b", clipboard("# Title\n\n- a\n- b"));
    expect(ytext.toString()).toBe("Hello world\n\n# Title\n\n- a\n- b");
    const doc = view.state.doc;
    expect(doc.childCount).toBe(3);
    expect(doc.child(1).type.name).toBe("heading");
    expect(doc.child(2).type.name).toBe("bullet_list");
    expect(doc.child(2).childCount).toBe(2);
    // Cursor lands at the end of the pasted content.
    expect(view.state.selection.head).toBe(doc.content.size - 3);
  });

  it("pasting a fenced code block renders a code block", () => {
    select(12);
    const code = "```js\nconst a = 1;\n```";
    view.pasteText(code, clipboard(code));
    expect(ytext.toString()).toBe("Hello world\n\n" + code);
    expect(view.state.doc.child(1).type.name).toBe("code_block");
    expect(view.state.doc.child(1).attrs.language).toBe("js");
  });

  it("replaces the selection when pasting Markdown over it", () => {
    select(1, 12);
    view.pasteText("- a\n- b", clipboard("- a\n- b"));
    expect(ytext.toString()).toBe("- a\n- b");
    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.firstChild!.type.name).toBe("bullet_list");
  });

  it("splits a paragraph when pasting Markdown in the middle of it", () => {
    select(6);
    view.pasteText("- a\n- b", clipboard("- a\n- b"));
    expect(ytext.toString()).toBe("Hello\n\n- a\n- b\n\nworld");
    expect(view.state.doc.childCount).toBe(3);
    expect(view.state.doc.child(1).type.name).toBe("bullet_list");
  });

  it("replaces an empty paragraph between blocks instead of leaving it above the paste", () => {
    view.destroy();
    binding.destroy();
    setup("First\n\nLast");
    // Make an empty paragraph after "First" like pressing Enter twice would.
    view.dispatch(view.state.tr.insert(7, schema.nodes.paragraph.create()));
    expect(view.state.doc.childCount).toBe(3);
    expect(ytext.toString()).toBe("First\n\nLast");
    select(8);
    view.pasteText("## Middle\n\ntext", clipboard("## Middle\n\ntext"));
    expect(ytext.toString()).toBe("First\n\n## Middle\n\ntext\n\nLast");
    expect(view.state.doc.childCount).toBe(4);
    expect(view.state.doc.child(1).type.name).toBe("heading");
  });

  it("undoes a Markdown paste as a single step", () => {
    select(12);
    view.pasteText("# Title\n\n- a\n- b", clipboard("# Title\n\n- a\n- b"));
    expect(undoManager.canUndo()).toBe(true);
    undoManager.undo();
    expect(ytext.toString()).toBe("Hello world");
    expect(view.state.doc.childCount).toBe(1);
  });

  it("single-line plain text keeps the default behaviour and is escaped", () => {
    select(12);
    view.pasteText(" # not a heading", clipboard(" # not a heading"));
    expect(ytext.toString()).toBe("Hello world # not a heading");
    expect(view.state.doc.childCount).toBe(1);
  });

  it("multi-line text that does not look like Markdown keeps the default behaviour", () => {
    select(12);
    view.pasteText("one\ntwo", clipboard("one\ntwo"));
    expect(view.state.doc.childCount).toBe(2);
    expect(ytext.toString()).toBe("Hello worldone\n\ntwo");
  });

  it("bracket soup that micromark cannot parse in time goes in as a fenced code block with a notice (#115)", () => {
    view.destroy();
    binding.destroy();
    const notices: string[] = [];
    const session = setup("Hello world");
    view.destroy();
    view = new EditorView(document.createElement("div"), {
      state: EditorState.create({ doc: binding.initialDoc(), plugins: [markdownBindingPlugin(binding), smartPastePlugin(session, { onNotice: (m) => notices.push(m) })] }),
    });
    const soup = "[".repeat(40_000) + "a" + "]".repeat(40_000);
    select(12);
    const started = performance.now();
    view.pasteText(soup, clipboard(soup, "<p>" + soup + "</p>"));
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(ytext.toString()).toBe("Hello world\n\n```\n" + soup + "\n```");
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(1).type.name).toBe("code_block");
    expect(notices).toEqual(["Pasted text contains 40,000 unbalanced brackets in one paragraph and cannot be rendered — inserted as a code block"]);
  });

  it("pastes literally inside a code block", () => {
    view.destroy();
    binding.destroy();
    setup("```\nx\n```");
    select(2);
    view.pasteText("# Title\n\n- a", clipboard("# Title\n\n- a"));
    expect(ytext.toString()).toBe("```\nx# Title\n\n- a\n```");
    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.firstChild!.type.name).toBe("code_block");
  });

  it("HTML with structure wins over the Markdown heuristic", () => {
    select(12);
    const text = "# Not a heading\n- not a list";
    const html = "<p><b># Not a heading</b></p><p>- not a list</p>";
    view.pasteHTML(html, clipboard(text, html));
    expect(ytext.toString()).toBe("Hello world**# Not a heading**\n\n\\- not a list");
  });

  it("uses the plain text when the HTML carries no formatting (e.g. copied from a code editor)", () => {
    select(12);
    const text = "# Title\n\n- a";
    const html = '<div style="color:#ccc"><div><span style="color:#569cd6"># Title</span></div><br><div><span>- a</span></div></div>';
    view.pasteHTML(html, clipboard(text, html));
    expect(ytext.toString()).toBe("Hello world\n\n# Title\n\n- a");
    expect(view.state.doc.child(1).type.name).toBe("heading");
  });

  it("falls back to the default paste in suggesting mode", () => {
    view.destroy();
    binding.destroy();
    setup("Hello world", "suggesting");
    select(12);
    view.pasteText("# Title\n\n- a", clipboard("# Title\n\n- a"));
    // Default paste: the first line joins the current paragraph and nothing is parsed as Markdown.
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(1).type.name).toBe("paragraph");
    expect(ytext.toString()).toBe("Hello world# Title\n\n\\- a");
  });

  it("does not link the selection when the view is not editable", () => {
    view.setProps({ editable: () => false });
    select(7, 12);
    view.pasteText("https://example.com", clipboard("https://example.com"));
    expect(ytext.toString()).not.toContain("[world]");
  });

  describe("tab-separated text (#166)", () => {
    const TSV = "Name\tQty\tPrice\nApple\t3\t1.20\nPear\t5\t0.80\n";
    const TABLE = "| Name  | Qty | Price |\n| ----- | --- | ----- |\n| Apple | 3   | 1.20  |\n| Pear  | 5   | 0.80  |";

    it("3×3 TSV becomes a table with a header row and two body rows", () => {
      select(12);
      view.pasteText(TSV, clipboard(TSV));
      expect(ytext.toString()).toBe("Hello world\n\n" + TABLE);
      const doc = view.state.doc;
      expect(doc.childCount).toBe(2);
      const table = doc.child(1);
      expect(table.type.name).toBe("table");
      expect(table.childCount).toBe(3);
      expect(table.child(0).child(0).type.name).toBe("table_header");
      expect(table.child(0).childCount).toBe(3);
      expect(table.child(1).child(0).type.name).toBe("table_cell");
      expect(table.child(1).child(0).textContent).toBe("Apple");
      expect(table.child(2).child(2).textContent).toBe("0.80");
      expect(doc.textContent).not.toContain("\t");
    });

    it("a single line with tabs stays plain text", () => {
      select(12);
      view.pasteText(" a\tb\tc", clipboard(" a\tb\tc"));
      expect(view.state.doc.childCount).toBe(1);
      expect(ytext.toString()).not.toContain("|");
      expect(view.state.doc.textContent).toBe("Hello world a\tb\tc");
    });

    it("ragged rows (different tab counts) keep the default behaviour", () => {
      select(12);
      const ragged = "a\tb\nc\td\te";
      view.pasteText(ragged, clipboard(ragged));
      expect(ytext.toString()).not.toContain("|");
      expect(view.state.doc.childCount).toBe(2);
    });

    it("a real HTML table on the clipboard goes through the HTML path, not the TSV one", () => {
      select(12);
      const html = "<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Apple</td><td>3</td></tr></table>";
      view.pasteHTML(html, clipboard("Name\tQty\nApple\t3", html));
      expect(view.state.doc.child(1).type.name).toBe("table");
      expect(ytext.toString()).toContain("| Name  | Qty |");
    });

    it("HTML without structure (a terminal's coloured spans) still yields a table", () => {
      select(12);
      const html = '<div><span style="color:#ccc">Name\tQty</span></div><div><span>Apple\t3</span></div>';
      view.pasteHTML(html, clipboard("Name\tQty\nApple\t3", html));
      expect(view.state.doc.child(1).type.name).toBe("table");
    });

    it("is one undo step and offers Undo in the notice", () => {
      view.destroy();
      binding.destroy();
      const notices: [string, { label: string; onClick: () => void } | undefined][] = [];
      const session = setup("Hello world");
      view.destroy();
      view = new EditorView(document.createElement("div"), {
        state: EditorState.create({
          doc: binding.initialDoc(),
          plugins: [markdownBindingPlugin(binding), smartPastePlugin(session, { onNotice: (m, a) => notices.push([m, a]) })],
        }),
      });
      select(12);
      view.pasteText(TSV, clipboard(TSV));
      expect(ytext.toString()).toBe("Hello world\n\n" + TABLE);
      expect(notices).toHaveLength(1);
      expect(notices[0][0]).toBe("Pasted tab-separated text as a table");
      expect(notices[0][1]?.label).toBe("Undo");
      notices[0][1]!.onClick();
      expect(ytext.toString()).toBe("Hello world");
      expect(view.state.doc.childCount).toBe(1);
    });

    it("pastes literally inside a code block", () => {
      view.destroy();
      binding.destroy();
      setup("```\nx\n```");
      select(2);
      view.pasteText("a\tb\nc\td", clipboard("a\tb\nc\td"));
      expect(ytext.toString()).toBe("```\nxa\tb\nc\td\n```");
      expect(view.state.doc.childCount).toBe(1);
    });
  });
});
