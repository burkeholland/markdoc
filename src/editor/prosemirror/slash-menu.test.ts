// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { MarkdownBinding, markdownBindingPlugin } from "../sync/markdown-binding";
import { schema } from "../markdown/schema";
import { SLASH_ITEMS } from "../slash-items";
import { setHeadingLevel } from "./commands";
import { editablePlugin, setEditable } from "./setup";
import { applySlashCommand, applySlashItem, slashMenuPlugin, slashMenuState, type SlashKey, type SlashState } from "./slash-menu";

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

  it("applying a command removes the /query text and runs it in the same transaction", () => {
    select(WORLD);
    type("/head");
    expect(ytext.toString()).toBe("Hello\n\n/headWorld");
    let dispatched = 0;
    const dispatch = view.dispatch;
    view.dispatch = (tr) => {
      dispatched += 1;
      dispatch(tr);
    };
    expect(applySlashCommand(view, setHeadingLevel(1))).toBe(true);
    expect(dispatched).toBe(1);
    expect(tracked()).toBeNull();
    expect(view.state.doc.lastChild!.type).toBe(schema.nodes.heading);
    expect(view.state.doc.textContent).toBe("HelloWorld");
    expect(ytext.toString()).toBe("Hello\n\n# World");
    expect(view.state.selection.head).toBe(WORLD);
  });

  it("applying a command that does not apply still removes the /query", () => {
    select(WORLD);
    type("/text");
    expect(applySlashCommand(view, setHeadingLevel(0))).toBe(false);
    expect(tracked()).toBeNull();
    expect(ytext.toString()).toBe("Hello\n\nWorld");
  });

  it("applying an item removes the /query text and then runs the action", () => {
    select(WORLD);
    type("/img");
    let ran = "";
    applySlashItem(view, () => {
      ran = ytext.toString();
    });
    expect(ran).toBe("Hello\n\nWorld");
    expect(tracked()).toBeNull();
  });
});

/**
 * The session's undo manager merges consecutive local changes that land within
 * 400 ms into one undo step. The slash menu must not depend on that: its edit
 * has to be exactly one step, and the typed `/query` must stay its own step.
 */
describe("slash menu undo", () => {
  let ydoc: Y.Doc;
  let ytext: Y.Text;
  let binding: MarkdownBinding;
  let undoManager: Y.UndoManager;
  let view: EditorView;

  const WORLD = 8;
  const ORIGINAL = "Hello\n\nWorld";

  beforeEach(() => {
    ydoc = new Y.Doc();
    ytext = ydoc.getText("content");
    ytext.insert(0, ORIGINAL);
    binding = new MarkdownBinding(ytext);
    undoManager = new Y.UndoManager(ytext, { captureTimeout: 400, trackedOrigins: new Set([binding]) });
    const state = EditorState.create({
      doc: binding.initialDoc(),
      plugins: [editablePlugin(true), slashMenuPlugin({ onState: () => {} }), markdownBindingPlugin(binding)],
    });
    view = new EditorView(document.createElement("div"), { state });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, WORLD)));
  });
  afterEach(() => {
    view.destroy();
    binding.destroy();
    undoManager.destroy();
  });

  const type = (text: string) => {
    for (const ch of text) view.dispatch(view.state.tr.insertText(ch));
  };

  /** Counts shared-text transactions from the rich editor and undo stack items while `fn` runs. */
  const observe = (fn: () => void) => {
    let transactions = 0;
    let stackItems = 0;
    const onTransaction = (tr: Y.Transaction) => {
      if (tr.origin === binding) transactions += 1;
    };
    const onAdded = () => {
      stackItems += 1;
    };
    ydoc.on("afterTransaction", onTransaction);
    undoManager.on("stack-item-added", onAdded);
    try {
      fn();
    } finally {
      ydoc.off("afterTransaction", onTransaction);
      undoManager.off("stack-item-added", onAdded);
    }
    return { transactions, stackItems };
  };

  const EXPECTED: Record<string, string | RegExp> = {
    text: "Hello\n\nWorld",
    heading1: "Hello\n\n# World",
    heading2: "Hello\n\n## World",
    heading3: "Hello\n\n### World",
    bullet: "Hello\n\n- World",
    numbered: "Hello\n\n1. World",
    task: "Hello\n\n- [ ] World",
    quote: "Hello\n\n> World",
    code: "Hello\n\n```ts\nWorld\n```",
    divider: "Hello\n\nWorld\n\n---",
    table: /^Hello\n\nWorld\n\n\| Column 1 \| Column 2 \| Column 3 \|\n/,
    date: /^Hello\n\n\d{4}-\d{2}-\d{2}World$/,
  };

  const commandItems = SLASH_ITEMS.filter((item) => item.command);

  it("covers every editing item", () => {
    expect(commandItems.map((i) => i.id).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(SLASH_ITEMS.filter((item) => item.run).map((i) => i.id).sort()).toEqual(["comment", "image", "link"]);
  });

  it.each(commandItems.map((item) => [item.id, item] as const))("%s is one undo step and leaves the typed query as its own", (id, item) => {
    type(`/${id} ts`);
    const typed = ytext.toString();
    expect(typed).toBe(`Hello\n\n/${id} tsWorld`);
    expect(undoManager.undoStack).toHaveLength(1);

    // Applied right after typing: well inside the 400 ms capture window.
    const seen = observe(() => applySlashCommand(view, item.command!("ts"), undoManager));
    expect(slashMenuState(view.state)).toBeNull();
    expect(ytext.toString()).toMatch(EXPECTED[id]);
    expect(ytext.toString()).not.toContain(`/${id}`);
    expect(seen.transactions).toBe(1);
    expect(seen.stackItems).toBe(1);
    expect(undoManager.undoStack).toHaveLength(2);

    undoManager.undo();
    expect(ytext.toString()).toBe(typed);
    // The paragraph with the query is back. (The divider's trailing empty paragraph
    // is a local phantom block, not Markdown, so the binding keeps it after undo.)
    expect(view.state.doc.textContent).toBe(`Hello/${id} tsWorld`);
    expect(view.state.doc.child(1).type).toBe(schema.nodes.paragraph);
    expect(view.state.doc.child(1).textContent).toBe(`/${id} tsWorld`);

    undoManager.undo();
    expect(ytext.toString()).toBe(ORIGINAL);
    expect(undoManager.undoStack).toHaveLength(0);
  });

  it("on an empty paragraph (the e2e scenario) one undo brings the slash paragraph back", () => {
    // Enter at the end of "World" makes an empty paragraph, which Markdown cannot hold.
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, WORLD + 5)).split(WORLD + 5));
    expect(view.state.doc.childCount).toBe(3);
    expect(ytext.toString()).toBe(ORIGINAL);
    type("/");
    expect(ytext.toString()).toBe("Hello\n\nWorld\n\n/");

    const quote = SLASH_ITEMS.find((item) => item.id === "quote")!;
    const seen = observe(() => applySlashCommand(view, quote.command!(""), undoManager));
    expect(ytext.toString()).toBe("Hello\n\nWorld\n\n> ");
    expect(seen.transactions).toBe(1);
    expect(seen.stackItems).toBe(1);

    undoManager.undo();
    expect(ytext.toString()).toBe("Hello\n\nWorld\n\n/");
    expect(view.state.doc.childCount).toBe(3);
    expect(view.state.doc.child(2).type).toBe(schema.nodes.paragraph);
    expect(view.state.doc.child(2).textContent).toBe("/");

    // The typed "/" is the next step.
    undoManager.undo();
    expect(ytext.toString()).toBe(ORIGINAL);
  });

  it("typing right after the choice starts a new undo step", () => {
    type("/h1");
    applySlashCommand(view, setHeadingLevel(1), undoManager);
    type("Title");
    expect(ytext.toString()).toBe("Hello\n\n# TitleWorld");
    undoManager.undo();
    expect(ytext.toString()).toBe("Hello\n\n# World");
    undoManager.undo();
    expect(ytext.toString()).toBe("Hello\n\n/h1World");
  });

  it("dialog items remove the query as their own undo step", () => {
    type("/image");
    const seen = observe(() => applySlashItem(view, () => {}, undoManager));
    expect(ytext.toString()).toBe(ORIGINAL);
    expect(seen.transactions).toBe(1);
    expect(seen.stackItems).toBe(1);
    undoManager.undo();
    expect(ytext.toString()).toBe("Hello\n\n/imageWorld");
  });

  it("still works when the menu is not open", () => {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, WORLD + 2)));
    expect(applySlashCommand(view, setHeadingLevel(2), undoManager)).toBe(true);
    expect(ytext.toString()).toBe("Hello\n\n## World");
    undoManager.undo();
    expect(ytext.toString()).toBe(ORIGINAL);
  });
});
