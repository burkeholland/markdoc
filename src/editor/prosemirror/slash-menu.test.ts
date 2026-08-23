// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { MarkdownBinding, markdownBindingPlugin } from "../sync/markdown-binding";
import { schema } from "../markdown/schema";
import { setHeadingLevel } from "./commands";
import { editablePlugin, setEditable } from "./setup";
import { applySlashItem, slashMenuPlugin, slashMenuState, type SlashKey, type SlashState } from "./slash-menu";

describe("slashMenuPlugin", () => {
  let ytext: Y.Text;
  let binding: MarkdownBinding;
  let view: EditorView;
  let states: (SlashState | null)[];
  let keys: SlashKey[];
  let enterReached: number;

  const setup = (markdown: string) => {
    const ydoc = new Y.Doc();
    ytext = ydoc.getText("content");
    ytext.insert(0, markdown);
    binding = new MarkdownBinding(ytext);
    states = [];
    keys = [];
    enterReached = 0;
    const state = EditorState.create({
      doc: binding.initialDoc(),
      plugins: [
        editablePlugin(true),
        slashMenuPlugin({
          onState: (s) => states.push(s),
          onKey: (k) => {
            keys.push(k);
            return true;
          },
        }),
        markdownBindingPlugin(binding),
        keymap({
          Enter: () => {
            enterReached += 1;
            return true;
          },
        }),
      ],
    });
    view = new EditorView(document.createElement("div"), { state });
  };

  const select = (pos: number) => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  const type = (text: string) => {
    for (const ch of text) view.dispatch(view.state.tr.insertText(ch));
  };
  const key = (k: string) => {
    const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    return view.someProp("handleKeyDown", (f) => f(view, event)) ?? false;
  };
  const tracked = () => slashMenuState(view.state);

  // Doc: <p>Hello</p><p>World</p>; the second paragraph starts at 8.
  const WORLD = 8;

  beforeEach(() => setup("Hello\n\nWorld"));
  afterEach(() => {
    view.destroy();
    binding.destroy();
  });

  it("activates on / at the start of a paragraph and tracks the query", () => {
    select(WORLD);
    type("/");
    expect(tracked()).toEqual({ from: WORLD, to: WORLD + 1, query: "" });
    expect(states.at(-1)).toMatchObject({ from: WORLD, query: "" });
    type("head");
    expect(tracked()).toEqual({ from: WORLD, to: WORLD + 5, query: "head" });
    expect(states.at(-1)).toMatchObject({ query: "head" });
    expect(ytext.toString()).toBe("Hello\n\n/headWorld");
  });

  it("activates after whitespace but not mid-word", () => {
    select(6); // after "Hello"
    type("/");
    expect(tracked()).toBeNull();
    type(" /");
    expect(tracked()).toMatchObject({ query: "" });
  });

  it("does not activate inside a code block", () => {
    view.destroy();
    binding.destroy();
    setup("```\nabc\n```");
    select(4); // end of "abc"
    type("/");
    expect(tracked()).toBeNull();
    expect(view.state.doc.firstChild!.type).toBe(schema.nodes.code_block);
  });

  it("does not activate while not editable", () => {
    setEditable(view, false);
    select(WORLD);
    type("/");
    expect(tracked()).toBeNull();
  });

  it("deactivates on Escape", () => {
    select(WORLD);
    type("/h");
    expect(tracked()).toMatchObject({ query: "h" });
    expect(key("Escape")).toBe(true);
    expect(tracked()).toBeNull();
    expect(states.at(-1)).toBeNull();
    expect(view.state.doc.textContent).toBe("Hello/hWorld");
  });

  it("deactivates on double space", () => {
    select(WORLD);
    type("/a ");
    expect(tracked()).toMatchObject({ query: "a " });
    type(" ");
    expect(tracked()).toBeNull();
  });

  it("deactivates when the slash is deleted", () => {
    select(WORLD);
    type("/");
    expect(tracked()).not.toBeNull();
    view.dispatch(view.state.tr.delete(WORLD, WORLD + 1));
    expect(tracked()).toBeNull();
  });

  it("deactivates when the selection leaves the range", () => {
    select(WORLD);
    type("/x");
    expect(tracked()).not.toBeNull();
    select(1);
    expect(tracked()).toBeNull();
  });

  it("routes navigation keys to the handler and keeps them from other keymaps while open", () => {
    select(WORLD);
    key("Enter");
    expect(enterReached).toBe(1);
    type("/");
    expect(key("ArrowDown")).toBe(true);
    expect(key("ArrowUp")).toBe(true);
    expect(key("Enter")).toBe(true);
    expect(key("Tab")).toBe(true);
    expect(keys).toEqual(["ArrowDown", "ArrowUp", "Enter", "Tab"]);
    expect(enterReached).toBe(1);
    expect(key("a")).toBe(false);
  });

  it("applying an item removes the /query text and runs the action", () => {
    select(WORLD);
    type("/head");
    expect(ytext.toString()).toBe("Hello\n\n/headWorld");
    applySlashItem(view, () => setHeadingLevel(1)(view.state, view.dispatch));
    expect(tracked()).toBeNull();
    expect(view.state.doc.lastChild!.type).toBe(schema.nodes.heading);
    expect(view.state.doc.textContent).toBe("HelloWorld");
    expect(ytext.toString()).toBe("Hello\n\n# World");
  });
});
