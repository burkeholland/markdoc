// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { SlashKey, SlashState } from "../prosemirror/slash-menu";
import { applySourceSlash, closeSourceSlashMenu, sourceSlashMenu, sourceSlashState } from "./slash-menu";
import * as slash from "./slash-commands";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views) view.destroy();
  views.length = 0;
});

function editor(doc: string, at = doc.length, { readOnly = false, takeKeys = true } = {}) {
  const states: (SlashState | null)[] = [];
  const keys: SlashKey[] = [];
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: at },
      extensions: [
        markdown({ base: markdownLanguage }),
        EditorState.readOnly.of(readOnly),
        sourceSlashMenu({
          onState: (state) => states.push(state),
          onKey: (key) => {
            keys.push(key);
            return takeKeys;
          },
        }),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  ensureSyntaxTree(view.state, view.state.doc.length, 1e9);
  /** Types like the keyboard: one `input.type` transaction per character. */
  const type = (text: string) => {
    for (const ch of text) {
      const head = view.state.selection.main.head;
      view.dispatch({ changes: { from: head, insert: ch }, selection: EditorSelection.cursor(head + 1), userEvent: "input.type" });
      ensureSyntaxTree(view.state, view.state.doc.length, 1e9);
    }
  };
  const key = (name: string) => runScopeHandlers(view, new KeyboardEvent("keydown", { key: name }), "editor");
  return { view, type, key, states, keys };
}

const query = (view: EditorView) => sourceSlashState(view.state)?.query ?? null;

describe("source slash menu: when it opens", () => {
  it("opens at the start of a line and tracks the query", () => {
    const { view, type } = editor("Hello\n\n");
    type("/hea");
    expect(query(view)).toBe("hea");
    expect(sourceSlashState(view.state)).toMatchObject({ from: 7, to: 11 });
  });

  it("opens after whitespace, including after a list marker", () => {
    const a = editor("Some text ");
    a.type("/");
    expect(query(a.view)).toBe("");
    const b = editor("- ");
    b.type("/t");
    expect(query(b.view)).toBe("t");
  });

  it("does not open in the middle of a word or a path", () => {
    const { view, type } = editor("and");
    type("/or");
    expect(query(view)).toBeNull();
    const url = editor("see https:");
    url.type("/");
    expect(query(url.view)).toBeNull();
  });

  it("does not open inside fenced code, indented code or inline code", () => {
    const fenced = editor("```js\n\n```", 6);
    fenced.type("/");
    expect(query(fenced.view)).toBeNull();
    const indented = editor("Para\n\n    code ");
    indented.type("/");
    expect(query(indented.view)).toBeNull();
    const inline = editor("a `b c`", 5);
    inline.type("/");
    expect(query(inline.view)).toBeNull();
  });

  it("does not open in front matter", () => {
    const { view, type } = editor("---\ntitle: \n---\n", 11);
    type("/");
    expect(query(view)).toBeNull();
  });

  it("does not open for pasted or programmatic slashes, or when read-only", () => {
    const { view } = editor("");
    view.dispatch({ changes: { from: 0, insert: "/" }, selection: { anchor: 1 }, userEvent: "input.paste" });
    expect(query(view)).toBeNull();
    const ro = editor("", 0, { readOnly: true });
    ro.view.dispatch({ changes: { from: 0, insert: "/" }, selection: { anchor: 1 }, userEvent: "input.type" });
    expect(query(ro.view)).toBeNull();
  });

  it("closes when the slash is deleted, the caret leaves, or the query stops looking like one", () => {
    const a = editor("");
    a.type("/h");
    a.view.dispatch({ changes: { from: 0, to: 1 }, userEvent: "delete" });
    expect(query(a.view)).toBeNull();
    const b = editor("x\n");
    b.type("/h");
    b.view.dispatch({ selection: { anchor: 0 } });
    expect(query(b.view)).toBeNull();
    const c = editor("");
    c.type("/a!");
    expect(query(c.view)).toBeNull();
  });

  it("follows the slash when text is inserted before it", () => {
    const { view, type } = editor("x\n");
    type("/h");
    view.dispatch({ changes: { from: 0, insert: "abc" } });
    expect(sourceSlashState(view.state)).toMatchObject({ from: 5, query: "h" });
  });
});

describe("source slash menu: keys", () => {
  it("hands navigation keys to the menu only while it is open", () => {
    const { type, key, keys } = editor("");
    expect(key("ArrowDown")).toBe(false);
    type("/");
    for (const name of ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Tab"]) expect(key(name)).toBe(true);
    expect(keys).toEqual(["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Tab"]);
  });

  it("Escape closes the menu and leaves the typed text", () => {
    const { view, type, key, states } = editor("");
    type("/ta");
    expect(key("Escape")).toBe(true);
    expect(query(view)).toBeNull();
    expect(view.state.doc.toString()).toBe("/ta");
    expect(states.at(-1)).toBeNull();
    expect(key("Escape")).toBe(false);
  });

  it("closeSourceSlashMenu closes it", () => {
    const { view, type } = editor("");
    type("/");
    closeSourceSlashMenu(view);
    expect(query(view)).toBeNull();
  });
});

describe("source slash menu: applying an item", () => {
  const apply = (doc: string, typed: string, command: slash.SourceSlashCommand | null) => {
    const { view, type } = editor(doc);
    type(typed);
    const undo = { stopCapturing: vi.fn() };
    applySourceSlash(view, command, undo);
    expect(undo.stopCapturing).toHaveBeenCalledTimes(2);
    expect(query(view)).toBeNull();
    return { text: view.state.doc.toString(), head: view.state.selection.main.head, view };
  };

  it("removes the query and runs the command", () => {
    expect(apply("Hello\n\nWorld ", "/h2", slash.heading(2)).text).toBe("Hello\n\n## World ");
    expect(apply("", "/task", slash.linePrefix("task")).text).toBe("- [ ] ");
    expect(apply("", "/quote", slash.linePrefix("quote")).text).toBe("> ");
    expect(apply("", "/code ts", slash.codeBlock("ts")).text).toBe("```ts\n\n```\n");
    expect(apply("Intro\n\n", "/divider", slash.divider).text).toBe("Intro\n\n---\n");
    expect(apply("", "/table", slash.table).text).toMatch(/^\| Column 1 \| Column 2 \| Column 3 \|\n\| --- \| --- \| --- \|\n/);
    expect(apply("", "/link", null).text).toBe("");
  });

  it("inserts a table of contents from the document's headings", () => {
    const { text } = apply("# Guide\n\n## Install\n\n## Use it\n\n", "/toc", slash.tableOfContents);
    expect(text).toBe("# Guide\n\n## Install\n\n## Use it\n\n- [Guide](#guide)\n  - [Install](#install)\n  - [Use it](#use-it)\n");
  });

  it("inserts a GitHub callout with the caret on its body line", () => {
    const { text, head } = apply("", "/callout warn", slash.callout("warning"));
    expect(text).toBe("> [!WARNING]\n> \n");
    expect(head).toBe("> [!WARNING]\n> ".length);
  });

  it("adds a numbered footnote reference and its definition at the end", () => {
    const { text, head } = apply("See this[^1] and that ", "/fn", slash.footnote);
    expect(text).toBe("See this[^1] and that [^2]\n\n[^2]: ");
    expect(head).toBe(text.length);
  });

  it("detects a table so block items can be hidden there", () => {
    const { view } = editor("| a | b |\n| --- | --- |\n| c | d |", 30);
    ensureSyntaxTree(view.state, view.state.doc.length, 1e9);
    expect(slash.inTable(view.state)).toBe(true);
    const { view: plain } = editor("text");
    expect(slash.inTable(plain.state)).toBe(false);
  });
});
