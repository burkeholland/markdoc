// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdownEditingKeymap } from "./continue-markup";
import { markdownTyping } from "./markdown-typing";

// Same editing extensions as setup.ts, minus the collab / theme pieces.
const extensions = [
  closeBrackets(),
  markdownTyping(),
  markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }),
  markdownEditingKeymap,
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, indentWithTab]),
];

let views: EditorView[] = [];
afterEach(() => {
  for (const v of views) v.destroy();
  views = [];
});

function editor(doc: string, selection: number | { anchor: number; head: number } = doc.length) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, selection: typeof selection === "number" ? { anchor: selection } : selection, extensions }),
    parent,
  });
  views.push(view);
  const parse = () => ensureSyntaxTree(view.state, view.state.doc.length, 1000);
  parse();
  return {
    view,
    /** Simulates typing through the view's input handlers (what the DOM observer calls for a key press). */
    type(text: string) {
      for (const ch of text) {
        parse();
        const { from, to } = view.state.selection.main;
        const handled = view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, ch, () => view.state.update(view.state.replaceSelection(ch))));
        if (!handled) view.dispatch(view.state.replaceSelection(ch), { userEvent: "input.type" });
      }
    },
    press(key: string, opts: { shift?: boolean } = {}) {
      parse();
      return runScopeHandlers(view, new KeyboardEvent("keydown", { key, shiftKey: opts.shift ?? false }), "editor");
    },
    get doc() {
      return view.state.doc.toString();
    },
    get cursor() {
      return view.state.selection.main.head;
    },
    get selected() {
      const { from, to } = view.state.selection.main;
      return view.state.sliceDoc(from, to);
    },
  };
}

describe("markdownTyping: fences", () => {
  it("opens a fenced block on the third backtick at line start", () => {
    const ed = editor("# Title\n\n");
    ed.type("```");
    expect(ed.doc).toBe("# Title\n\n```\n\n```");
    expect(ed.cursor).toBe("# Title\n\n```".length);
  });

  it("lets the language be typed, and Enter moves onto the empty line inside", () => {
    const ed = editor("");
    ed.type("```ts");
    expect(ed.doc).toBe("```ts\n\n```");
    expect(ed.press("Enter")).toBe(true);
    expect(ed.doc).toBe("```ts\n\n```");
    expect(ed.cursor).toBe("```ts\n".length);
    ed.type("const a = 1");
    expect(ed.doc).toBe("```ts\nconst a = 1\n```");
  });

  it("does not duplicate a closing fence that already follows", () => {
    const ed = editor("\n\n```", 0);
    ed.type("```");
    expect(ed.doc).toBe("```\n\n```");
    // Retyping the opening fence of an existing block: the first fence below is its closing one.
    const retyped = editor("\ncode\n```", 0);
    retyped.type("```");
    expect(retyped.doc).toBe("```\ncode\n```");
    // A complete block further down is not a closing fence for this one.
    const other = editor("\n\n```js\nx\n```", 0);
    other.type("```");
    expect(other.doc).toBe("```\n\n```\n\n```js\nx\n```");
  });

  it("keeps the fence indented inside a list item", () => {
    const ed = editor("- item\n  ");
    ed.type("```");
    expect(ed.doc).toBe("- item\n  ```\n  \n  ```");
  });

  it("supports the ~~~ variant", () => {
    const ed = editor("");
    ed.type("~~~");
    expect(ed.doc).toBe("~~~\n\n~~~");
    expect(ed.cursor).toBe(3);
    ed.type("sh");
    ed.press("Enter");
    ed.type("ls");
    expect(ed.doc).toBe("~~~sh\nls\n~~~");
  });

  it("Enter at the end of a fence line whose block has content inserts a normal newline", () => {
    const ed = editor("```ts\nconst a = 1\n```", "```ts".length);
    expect(ed.press("Enter")).toBe(true);
    expect(ed.doc).toBe("```ts\n\nconst a = 1\n```");
  });

  it("Enter after a closing fence is a normal newline", () => {
    const ed = editor("```\nx\n```\n\n```");
    ed.press("Enter");
    expect(ed.doc).toBe("```\nx\n```\n\n```\n");
  });
});

describe("markdownTyping: inline characters", () => {
  it("inserts a single backtick without pairing", () => {
    const ed = editor("code ");
    ed.type("`");
    expect(ed.doc).toBe("code `");
    ed.type("x`");
    expect(ed.doc).toBe("code `x`");
  });

  it("inserts * and _ plainly without a selection", () => {
    const ed = editor("a ");
    ed.type("*b* _c_");
    expect(ed.doc).toBe("a *b* _c_");
  });

  it("wraps a selection with *, twice for bold", () => {
    const ed = editor("make this bold", { anchor: 5, head: 9 });
    ed.type("*");
    expect(ed.doc).toBe("make *this* bold");
    expect(ed.selected).toBe("this");
    ed.type("*");
    expect(ed.doc).toBe("make **this** bold");
    expect(ed.selected).toBe("this");
  });

  it("wraps a selection with _ and `", () => {
    const ed = editor("emphasis code", { anchor: 0, head: 8 });
    ed.type("_");
    expect(ed.doc).toBe("_emphasis_ code");
    ed.view.dispatch({ selection: { anchor: 11, head: 15 } });
    ed.type("`");
    expect(ed.doc).toBe("_emphasis_ `code`");
    expect(ed.selected).toBe("code");
  });

  it("turns a selection into a link with [ and puts the caret inside the parens", () => {
    const ed = editor("see docs here", { anchor: 4, head: 8 });
    ed.type("[");
    expect(ed.doc).toBe("see [docs]() here");
    expect(ed.cursor).toBe("see [docs](".length);
    ed.type("https://x.test");
    expect(ed.doc).toBe("see [docs](https://x.test) here");
  });

  it("keeps ( [ and quotes pairing when nothing is selected", () => {
    const ed = editor("");
    ed.type("(");
    expect(ed.doc).toBe("()");
    ed.type("x)");
    expect(ed.doc).toBe("(x)");
    ed.type(" [");
    expect(ed.doc).toBe("(x) []");
    ed.type('y] "');
    expect(ed.doc).toBe('(x) [y] ""');
  });

  it("inside a fenced block a backtick is one character and * does not wrap", () => {
    const ed = editor("```js\nconst s = \n```", "```js\nconst s = ".length);
    ed.type("`");
    expect(ed.doc).toBe("```js\nconst s = `\n```");
    ed.type("a`");
    expect(ed.doc).toBe("```js\nconst s = `a`\n```");
    ed.view.dispatch({ selection: { anchor: "```js\nconst s".length, head: "```js\nconst ".length } });
    ed.type("*");
    expect(ed.doc).toBe("```js\nconst * = `a`\n```");
    // Brackets still pair inside code.
    ed.type("(");
    expect(ed.doc).toBe("```js\nconst *() = `a`\n```");
  });

  it("does not open a fence from inside a fenced block", () => {
    const ed = editor("```\n\n\n```", 4);
    ed.type("```");
    expect(ed.doc).toBe("```\n```\n\n```");
  });
});

describe("markdownTyping: Tab on lists", () => {
  it("Tab indents a bullet item and Shift-Tab outdents it", () => {
    const ed = editor("- parent\n- item");
    expect(ed.press("Tab")).toBe(true);
    expect(ed.doc).toBe("- parent\n  - item");
    expect(ed.press("Tab", { shift: true })).toBe(true);
    expect(ed.doc).toBe("- parent\n- item");
  });

  it("indents ordered and task items by their marker width", () => {
    const ed = editor("1. one\n2. two");
    ed.press("Tab");
    expect(ed.doc).toBe("1. one\n   2. two");
    ed.press("Tab", { shift: true });
    expect(ed.doc).toBe("1. one\n2. two");

    const tasks = editor("- [ ] a\n- [ ] b");
    tasks.press("Tab");
    expect(tasks.doc).toBe("- [ ] a\n  - [ ] b");
  });

  it("indents every list line in a multi-line selection", () => {
    const ed = editor("- a\n- b\n- c", { anchor: 4, head: 11 });
    ed.press("Tab");
    expect(ed.doc).toBe("- a\n  - b\n  - c");
  });

  it("Shift-Tab on a top-level item leaves it alone", () => {
    const ed = editor("- a");
    expect(ed.press("Tab", { shift: true })).toBe(true);
    expect(ed.doc).toBe("- a");
  });

  it("Tab on plain text still inserts indentation", () => {
    const ed = editor("plain", 0);
    expect(ed.press("Tab")).toBe(true);
    expect(ed.doc).toBe("  plain");
  });

  it("Tab inside a fenced block is code indentation, not list nesting", () => {
    const ed = editor("```\n- not a list\n```", "```\n".length);
    ed.press("Tab");
    expect(ed.doc).toBe("```\n  - not a list\n```");
  });
});
