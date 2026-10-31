import { describe, expect, it } from "vitest";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { parseMarkdown } from "../markdown/parse";
import { serializeMarkdown } from "../markdown/serialize";
import { headingsOf, insertFootnote, insertMarkdownBlocks, insertTableOfContents } from "./slash-commands";

/** Runs `command` with the caret at the end of the text `marker` in `markdown`. */
function run(markdown: string, marker: string, command: Command) {
  let state = EditorState.create({ doc: parseMarkdown(markdown).doc });
  let caret = -1;
  state.doc.descendants((node, pos) => {
    if (caret < 0 && node.isText && node.text!.includes(marker)) caret = pos + node.text!.indexOf(marker) + marker.length;
  });
  if (caret < 0) state.doc.descendants((node, pos) => (caret < 0 && node.isTextblock && node.content.size === 0 ? ((caret = pos + 1), false) : true));
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, caret)));
  const ok = command(state, (tr) => (state = state.apply(tr)));
  return { ok, state, markdown: serializeMarkdown(state.doc) };
}

describe("rich slash commands", () => {
  it("collects headings in order", () => {
    expect(headingsOf(parseMarkdown("# A\n\ntext\n\n## B\n\n> ### C").doc)).toEqual([
      { level: 1, text: "A" },
      { level: 2, text: "B" },
      { level: 3, text: "C" },
    ]);
  });

  it("inserts a table of contents in place of the empty paragraph", () => {
    const doc = "# Guide\n\n## Install\n\nx\n\n## Use it";
    let state = EditorState.create({ doc: parseMarkdown(doc).doc });
    // An empty paragraph after "x", where the slash query was.
    const end = state.doc.child(2).nodeSize + state.doc.child(0).nodeSize + state.doc.child(1).nodeSize;
    state = state.apply(state.tr.insert(end, state.schema.nodes.paragraph.create()));
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, end + 1)));
    expect(insertTableOfContents(state, (tr) => (state = state.apply(tr)))).toBe(true);
    expect(serializeMarkdown(state.doc)).toBe("# Guide\n\n## Install\n\nx\n\n- [Guide](#guide)\n  - [Install](#install)\n  - [Use it](#use-it)\n\n## Use it");
    expect(state.selection.$from.parent.textContent).toBe("Use it");
  });

  it("inserts blocks after a paragraph that has text", () => {
    const { markdown } = run("Intro", "Intro", insertMarkdownBlocks("- one"));
    expect(markdown).toBe("Intro\n\n- one");
  });

  it("does nothing without headings", () => {
    expect(run("Just text", "Just", insertTableOfContents).ok).toBe(false);
  });

  it("adds a footnote reference at the caret and its definition at the end, numbered after the last", () => {
    const { ok, state, markdown } = run("One[^1] two\n\n[^1]: first", "two", insertFootnote);
    expect(ok).toBe(true);
    expect(markdown).toMatch(/^One\[\^1\] two\[\^2\]\n\n\[\^1\]: first\n\n\[\^2\]:/);
    expect(state.selection.$from.node(1).type.name).toBe("footnote_definition");
  });

  it("offers no footnote in a code block", () => {
    expect(run("```\ncode\n```", "code", insertFootnote).ok).toBe(false);
  });
});
