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
import { editablePlugin, setEditable } from "./editable";
import {
  applySlashCommand,
  applySlashItem,
  SLASH_KEYS,
  slashMenuPlugin,
  slashMenuState,
  type SlashKey,
  type SlashMenuHandlers,
  type SlashState,
} from "./slash-menu";

describe("slashMenuPlugin", () => {
  let ytext: Y.Text;
  let binding: MarkdownBinding;
  let view: EditorView;
  let host: HTMLDivElement;
  let states: (SlashState | null)[];
  let keys: SlashKey[];
  /** What the menu answers: true = "I took the key". */
  let menuTakesKeys: boolean;
  /** How often a key fell through to the editor's own keymap. */
  let editorKeys: string[];

  const setup = (markdown: string, onKey: SlashMenuHandlers["onKey"] | "none" = (k) => (keys.push(k), menuTakesKeys)) => {
    const ydoc = new Y.Doc();
    ytext = ydoc.getText("content");
    ytext.insert(0, markdown);
    binding = new MarkdownBinding(ytext);
    states = [];
    keys = [];
    menuTakesKeys = true;
    editorKeys = [];
    const reached = (name: string) => () => {
      editorKeys.push(name);
      return true;
    };
    const state = EditorState.create({
      doc: binding.initialDoc(),
      plugins: [
        editablePlugin(true),
        slashMenuPlugin({ onState: (s) => states.push(s), ...(onKey === "none" ? {} : { onKey }) }),
        markdownBindingPlugin(binding),
        keymap({
          Enter: reached("Enter"),
          "Shift-Enter": reached("Shift-Enter"),
          Tab: reached("Tab"),
          ArrowDown: reached("ArrowDown"),
          ArrowUp: reached("ArrowUp"),
          Home: reached("Home"),
          End: reached("End"),
          Escape: reached("Escape"),
        }),
      ],
    });
    host = document.createElement("div");
    document.body.append(host);
    view = new EditorView(host, { state });
  };
  const teardown = () => {
    view.destroy();
    binding.destroy();
    host.remove();
  };

  const select = (pos: number) => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  const type = (text: string) => {
    for (const ch of text) view.dispatch(view.state.tr.insertText(ch));
  };
  /** A keydown on the editor, the way a browser delivers it: nothing is awaited before the result is read. */
  const key = (k: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key: k, code: k, bubbles: true, cancelable: true, ...init });
    view.dom.dispatchEvent(event);
    return event;
  };
  const tracked = () => slashMenuState(view.state);

  // Doc: <p>Hello</p><p>World</p>; the second paragraph starts at 8.
  const WORLD = 8;

  beforeEach(() => setup("Hello\n\nWorld"));
  afterEach(teardown);

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
    teardown();
    setup("```\nabc\n```");
    select(4); // end of "abc"
    type("/");
    expect(tracked()).toBeNull();
    // After a space and at the start too: right after "abc" it is the mid-word rule that keeps the menu closed.
    type(" /");
    expect(tracked()).toBeNull();
    select(1);
    type("/");
    expect(tracked()).toBeNull();
    expect(view.state.doc.firstChild!.type).toBe(schema.nodes.code_block);
  });

  it("a slash that was not typed here does not open the menu: another person's, or a pasted one", () => {
    select(WORLD);
    view.dispatch(view.state.tr.insertText("/").setMeta("addToHistory", false));
    expect(tracked()).toBeNull();
    view.dispatch(view.state.tr.delete(WORLD, WORLD + 1));
    view.dispatch(view.state.tr.insertText("/").setMeta("paste", true));
    expect(tracked()).toBeNull();
    view.dispatch(view.state.tr.delete(WORLD, WORLD + 1));
    type("/");
    expect(tracked()).toEqual({ from: WORLD, to: WORLD + 1, query: "" });
  });

  it("closes when the editor loses the focus, and stays open when the focus never left", async () => {
    const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));
    view.focus();
    select(WORLD);
    type("/");
    // A blur event while the editor still has the focus (it came back in the same task) closes nothing.
    view.dom.dispatchEvent(new FocusEvent("blur"));
    await nextTask();
    expect(tracked()).not.toBeNull();
    const elsewhere = document.body.appendChild(document.createElement("button"));
    elsewhere.focus();
    await nextTask();
    elsewhere.remove();
    expect(tracked()).toBeNull();
    expect(states.at(-1)).toBeNull();
  });

  // The plugin has no check of its own for this: ProseMirror hands no keydown to a plugin while a composition
  // is open. This test holds the two together, so the Enter that confirms Japanese, Chinese or Korean text
  // never picks an item.
  it("a key pressed while an input method is composing is not the menu's", () => {
    select(WORLD);
    type("/h");
    view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    for (const handled of [...SLASH_KEYS, "Escape"]) expect(key(handled, { isComposing: true }).defaultPrevented, handled).toBe(false);
    expect(keys).toEqual([]);
    expect(editorKeys).toEqual([]);
    expect(tracked()).toMatchObject({ query: "h" });
    view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    // Safari sends the confirming Enter right after compositionend, and ProseMirror drops that one key as well.
    // jsdom gives Apple as its vendor, so that is the path taken here.
    if (/Apple Computer/.test(navigator.vendor)) {
      expect(key("Enter").defaultPrevented).toBe(false);
      expect(keys).toEqual([]);
    }
    expect(key("Enter").defaultPrevented).toBe(true);
    expect(keys).toEqual(["Enter"]);
  });

  it("does not activate while not editable", () => {
    setEditable(view, false);
    select(WORLD);
    type("/");
    expect(tracked()).toBeNull();
  });

  it("Escape closes the menu, keeps the typed text and does not reach the editor", () => {
    select(WORLD);
    type("/h");
    expect(tracked()).toMatchObject({ query: "h" });
    const event = key("Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(tracked()).toBeNull();
    expect(states.at(-1)).toBeNull();
    expect(view.state.doc.textContent).toBe("Hello/hWorld");
    expect(editorKeys).toEqual([]);
    // The menu itself is not asked: Escape closes even when no menu is mounted.
    expect(keys).toEqual([]);
  });

  it("Escape with the menu closed is the editor's key", () => {
    select(WORLD);
    key("Escape");
    expect(editorKeys).toEqual(["Escape"]);
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

  it("hands the six menu keys to the menu while it is open, and keeps them from the editor", () => {
    select(WORLD);
    key("Enter");
    expect(editorKeys).toEqual(["Enter"]);
    type("/");
    for (const handled of SLASH_KEYS) {
      expect(key(handled).defaultPrevented, handled).toBe(true);
    }
    expect(keys).toEqual(["ArrowUp", "ArrowDown", "Home", "End", "Enter", "Tab"]);
    expect(editorKeys).toEqual(["Enter"]);
    expect(key("a").defaultPrevented).toBe(false);
    expect(keys).toHaveLength(6);
  });

  // #2334: the menu used to be asked in a microtask, after the browser had moved on. The menu must get
  // the key while the keydown is still at the editor, so what it does is done when a later listener runs.
  it("asks the menu during the keydown itself, before the event reaches the next listener", () => {
    teardown();
    const seen: { key: SlashKey; currentTarget: EventTarget | null; phase: number }[] = [];
    setup("Hello\n\nWorld", (k) => {
      const event = window.event as KeyboardEvent;
      seen.push({ key: k, currentTarget: event.currentTarget, phase: event.eventPhase });
      return true;
    });
    select(WORLD);
    type("/");
    let seenAtDocument = -1;
    const later = () => {
      seenAtDocument = seen.length;
    };
    document.addEventListener("keydown", later);
    try {
      key("Enter");
    } finally {
      document.removeEventListener("keydown", later);
    }
    expect(seenAtDocument).toBe(1);
    expect(seen).toEqual([{ key: "Enter", currentTarget: view.dom, phase: Event.AT_TARGET }]);
  });

  it.each([{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }])("leaves a key with %o to the editor", (modifier) => {
    select(WORLD);
    type("/");
    for (const handled of [...SLASH_KEYS, "Escape"]) key(handled, modifier);
    expect(keys).toEqual([]);
    expect(tracked()).not.toBeNull();
  });

  it("Shift+Enter with the menu open reaches the editor's own Shift-Enter", () => {
    select(WORLD);
    type("/");
    key("Enter", { shiftKey: true });
    expect(editorKeys).toEqual(["Shift-Enter"]);
    expect(keys).toEqual([]);
  });

  it("a key the menu does not take goes on to the editor", () => {
    select(WORLD);
    type("/");
    menuTakesKeys = false;
    for (const handled of SLASH_KEYS) key(handled);
    expect(keys).toEqual([...SLASH_KEYS]);
    expect(editorKeys).toEqual([...SLASH_KEYS]);
  });

  it("without a menu the keys stay with the editor, and Escape still closes", () => {
    teardown();
    setup("Hello\n\nWorld", "none");
    select(WORLD);
    type("/");
    key("Enter");
    key("ArrowDown");
    expect(editorKeys).toEqual(["Enter", "ArrowDown"]);
    expect(key("Escape").defaultPrevented).toBe(true);
    expect(tracked()).toBeNull();
  });

  it("with the menu closed no key is handed to the menu", () => {
    select(WORLD);
    for (const handled of SLASH_KEYS) key(handled);
    expect(keys).toEqual([]);
    expect(editorKeys).toEqual([...SLASH_KEYS]);
  });

  it("tells the menu about each change of the query once, and null when the editor goes away", () => {
    select(WORLD);
    type("/he");
    expect(states.map((s) => s?.query)).toEqual(["", "h", "he"]);
    // A transaction that changes nothing for the menu is not announced again.
    view.dispatch(view.state.tr.setMeta("noop", true));
    expect(states).toHaveLength(3);
    teardown();
    expect(states.at(-1)).toBeNull();
    setup("Hello\n\nWorld");
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
    // No headings in the document: the query goes and nothing is inserted.
    toc: "Hello\n\nWorld",
    footnote: /^Hello\n\n\[\^1\]World\n\n\[\^1\]:/,
    lorem: /^Hello\n\nLorem ipsum dolor sit amet, .*pariatur\.World$/,
  };

  const commandItems = SLASH_ITEMS.filter((item) => item.command);

  it("covers every editing item", () => {
    expect(commandItems.map((i) => i.id).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(SLASH_ITEMS.filter((item) => item.run).map((i) => i.id).sort()).toEqual(["agent", "card", "comment", "image", "link"]);
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
    expect(ytext.toString()).toBe("Hello\n\nWorld\n\n>");
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

  it("'/ag' + the agent item hands off to the dialog with the typed text gone from the document", () => {
    type("/ag");
    expect(ytext.toString()).toBe("Hello\n\n/agWorld");
    const agent = SLASH_ITEMS.find((item) => item.id === "agent")!;
    let opened = 0;
    let docWhenOpened = "";
    applySlashItem(
      view,
      () => {
        docWhenOpened = ytext.toString();
        agent.run!({ view, where: { inTable: false, canComment: true }, openImage: () => {}, openCard: () => {}, openLink: () => {}, startComment: () => {}, connectAgent: () => opened++ }, "");
      },
      undoManager,
    );
    expect(opened).toBe(1);
    expect(docWhenOpened).toBe(ORIGINAL);
    expect(ytext.toString()).toBe(ORIGINAL);
    expect(slashMenuState(view.state)).toBeNull();
  });

  it("still works when the menu is not open", () => {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, WORLD + 2)));
    expect(applySlashCommand(view, setHeadingLevel(2), undoManager)).toBe(true);
    expect(ytext.toString()).toBe("Hello\n\n## World");
    undoManager.undo();
    expect(ytext.toString()).toBe(ORIGINAL);
  });
});
