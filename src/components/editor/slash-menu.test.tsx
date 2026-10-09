// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import * as Y from "yjs";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import type { CollabSession } from "@/editor/collab/session";
import { MarkdownBinding, markdownBindingPlugin } from "@/editor/sync/markdown-binding";
import { editablePlugin } from "@/editor/prosemirror/editable";
import { slashMenuPlugin, slashMenuState, type SlashState } from "@/editor/prosemirror/slash-menu";
import { SLASH_ITEMS } from "@/editor/slash-items";

vi.mock("./use-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./use-session")>();
  return {
    ...actual,
    useSessionValue: (session: never, select: (value: never) => unknown) => select(session),
  };
});

import { createSlashMenuController, SlashMenu, type SlashMenuController } from "./slash-menu";

/**
 * The real plugin in a real ProseMirror view, the real menu next to it, and keydown events dispatched on
 * the editor the way a browser does. Nothing in these tests waits for a timer or a microtask between a key
 * and its result: that wait is what hid #2334 (the old menu acted one microtask late, which a browser never
 * allows and jsdom always did).
 */
interface Mounted {
  controller: SlashMenuController;
  view: EditorView;
  ytext: Y.Text;
  session: { canEdit: boolean; canComment: boolean; undoManager: { stopCapturing: Mock<() => void> } };
  onImage: Mock<() => void>;
  onLink: Mock<() => void>;
  onComment: Mock<() => void>;
  onConnectAgent: Mock<() => void>;
  /** Keys that fell through the menu to the editor's own keymap. */
  editorKeys: string[];
  rerender: (view: EditorView | null) => void;
  unmount: () => void;
}

const container = document.createElement("div");
container.getBoundingClientRect = () =>
  ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
const containerRef = { current: container };

const cleanups: (() => void)[] = [];

function makeEditor(markdown: string, controller: SlashMenuController) {
  const ytext = new Y.Doc().getText("content");
  ytext.insert(0, markdown);
  const binding = new MarkdownBinding(ytext);
  const editorKeys: string[] = [];
  const reached = (name: string) => () => {
    editorKeys.push(name);
    return true;
  };
  const state = EditorState.create({
    doc: binding.initialDoc(),
    plugins: [
      editablePlugin(true),
      slashMenuPlugin(controller.handlers),
      markdownBindingPlugin(binding),
      keymap({ Enter: reached("Enter"), Tab: reached("Tab"), ArrowDown: reached("ArrowDown"), ArrowUp: reached("ArrowUp"), Home: reached("Home"), End: reached("End") }),
    ],
  });
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView(host, { state });
  cleanups.push(() => {
    if (!view.isDestroyed) view.destroy();
    binding.destroy();
    host.remove();
  });
  return { view, ytext, editorKeys };
}

function mount({ markdown = "Hello\n\nWorld", strict = false, canEdit = true, canComment = true }: { markdown?: string; strict?: boolean; canEdit?: boolean; canComment?: boolean } = {}): Mounted {
  const controller = createSlashMenuController();
  const { view, ytext, editorKeys } = makeEditor(markdown, controller);
  const session = { canEdit, canComment, undoManager: { stopCapturing: vi.fn<() => void>() } };
  const callbacks = { onImage: vi.fn<() => void>(), onLink: vi.fn<() => void>(), onComment: vi.fn<() => void>(), onConnectAgent: vi.fn<() => void>() };
  const ui = (current: EditorView | null) => {
    const menu = <SlashMenu view={current} session={session as unknown as CollabSession} controller={controller} containerRef={containerRef} {...callbacks} />;
    return strict ? <StrictMode>{menu}</StrictMode> : menu;
  };
  const rendered = render(ui(view), { container: document.body.appendChild(container) });
  return { controller, view, ytext, session, ...callbacks, editorKeys, rerender: (next) => rendered.rerender(ui(next)), unmount: rendered.unmount };
}

// Doc "Hello\n\nWorld": <p>Hello</p><p>World</p>; the second paragraph starts at 8.
const WORLD = 8;

/** Caret to `pos`, then the text typed one character per transaction, as the keyboard does. */
function typeAt(view: EditorView, pos: number, text: string) {
  act(() => {
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    for (const ch of text) view.dispatch(view.state.tr.insertText(ch));
  });
}

function keydown(view: EditorView, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true, ...init });
  view.dom.dispatchEvent(event);
  return event;
}
/** One key, then React renders. */
function press(view: EditorView, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  let event!: KeyboardEvent;
  act(() => {
    event = keydown(view, key, init);
  });
  return event;
}

const menu = () => screen.queryByTestId("slash-menu");
const row = (id: string) => screen.getByTestId(`slash-item-${id}`);
const selected = () => screen.getAllByRole("option").filter((option) => option.getAttribute("aria-selected") === "true").map((option) => option.getAttribute("data-testid"));
const rowIds = () => screen.getAllByRole("option").map((option) => option.getAttribute("data-testid")!.replace("slash-item-", ""));

// jsdom has no layout: the three methods ProseMirror and the menu ask for exist only for these tests.
const layoutStubs = [
  [Element.prototype, "scrollIntoView", () => undefined],
  [Range.prototype, "getClientRects", () => Object.assign([], { item: () => null })],
  [Range.prototype, "getBoundingClientRect", () => new DOMRect(0, 0, 0, 0)],
] as const;
const layoutOriginals = layoutStubs.map(([target, name]) => Object.getOwnPropertyDescriptor(target, name));
beforeEach(() => {
  for (const [target, name, value] of layoutStubs) Object.defineProperty(target, name, { configurable: true, writable: true, value: vi.fn(value) });
});
afterEach(() => {
  cleanup();
  for (const undo of cleanups.splice(0)) undo();
  container.remove();
  layoutStubs.forEach(([target, name], i) => {
    const original = layoutOriginals[i];
    if (original) Object.defineProperty(target, name, original);
    else Reflect.deleteProperty(target, name);
  });
});

describe("createSlashMenuController", () => {
  const state: SlashState = { from: 1, to: 2, query: "", coords: { left: 0, top: 0, bottom: 0 } };

  it("keeps the last state and tells every subscriber until it leaves", () => {
    const controller = createSlashMenuController();
    const seen: (SlashState | null)[] = [];
    const leave = controller.subscribe((next) => seen.push(next));
    expect(controller.getState()).toBeNull();
    controller.handlers.onState(state);
    expect(controller.getState()).toBe(state);
    leave();
    controller.handlers.onState(null);
    expect(seen).toEqual([state]);
    expect(controller.getState()).toBeNull();
  });

  it("does not take a key while no menu is mounted", () => {
    const controller = createSlashMenuController();
    expect(controller.handlers.onKey?.("Enter")).toBe(false);
  });

  it("hands the key to the mounted menu and gives back its answer", () => {
    const controller = createSlashMenuController();
    const handler = vi.fn((key: string) => key === "Enter");
    controller.setKeyHandler(handler);
    expect(controller.handlers.onKey?.("Enter")).toBe(true);
    expect(controller.handlers.onKey?.("Tab")).toBe(false);
    expect(handler.mock.calls).toEqual([["Enter"], ["Tab"]]);
  });

  it("a menu that leaves late does not remove the handler of its replacement", () => {
    const controller = createSlashMenuController();
    const removeFirst = controller.setKeyHandler(() => false);
    const removeSecond = controller.setKeyHandler(() => true);
    removeFirst();
    expect(controller.handlers.onKey?.("Enter")).toBe(true);
    removeSecond();
    expect(controller.handlers.onKey?.("Enter")).toBe(false);
  });
});

describe("slash menu: what it shows", () => {
  it("opens on / with every item, the first one highlighted, and closes when the slash goes", () => {
    const { view } = mount();
    expect(menu()).toBeNull();
    typeAt(view, WORLD, "/");
    expect(menu()).toHaveAttribute("role", "listbox");
    expect(menu()).toHaveAccessibleName("Insert block");
    expect(rowIds()).toEqual(SLASH_ITEMS.map((item) => item.id));
    expect(selected()).toEqual(["slash-item-text"]);
    act(() => view.dispatch(view.state.tr.delete(WORLD, WORLD + 1)));
    expect(menu()).toBeNull();
  });

  it("filters while typing and starts again at the first row", () => {
    const { view } = mount();
    typeAt(view, WORLD, "/");
    press(view, "ArrowDown");
    expect(selected()).toEqual(["slash-item-heading1"]);
    typeAt(view, view.state.selection.head, "li");
    expect(rowIds()).toEqual(["bullet", "numbered", "task", "divider", "link"]);
    expect(selected()).toEqual(["slash-item-bullet"]);
  });

  it("shows No matches for a query nothing fits", () => {
    const { view } = mount();
    typeAt(view, WORLD, "/zzz");
    expect(screen.getByTestId("slash-empty")).toHaveTextContent("No matches");
    expect(screen.queryAllByRole("option")).toHaveLength(1);
  });

  it("gives every label and description a hover title with its full text", () => {
    const { view } = mount();
    typeAt(view, WORLD, "/");
    for (const item of SLASH_ITEMS) {
      const titles = [...row(item.id).querySelectorAll("[title]")].map((element) => [element.getAttribute("title"), element.textContent]);
      expect(titles, item.id).toEqual([[item.title, item.title], ...(item.description ? [[item.description, item.description]] : [])]);
    }
  });

  it("opens under the slash, and above it when there is no room below", () => {
    const { controller } = mount();
    const slashAt = (top: number) => act(() => controller.handlers.onState({ from: WORLD, to: WORLD + 1, query: "", coords: { left: 100, top, bottom: top + 20 } }));
    slashAt(100);
    expect(menu()!.style.left).toBe("100px");
    expect(menu()!.style.top).toBe("126px");
    // 16 rows are more than the 8 the menu shows: it is 296 px high and does not fit under a line near the bottom.
    slashAt(window.innerHeight - 60);
    expect(menu()!.style.top).toBe(`${window.innerHeight - 60 - 6 - 296}px`);
  });

  it("hides Comment from a person who may not comment", () => {
    const { view } = mount({ canComment: false });
    typeAt(view, WORLD, "/");
    expect(rowIds()).not.toContain("comment");
    expect(rowIds()).toContain("image");
  });

  it("offers no block items inside a table cell", () => {
    const { view } = mount({ markdown: "| a | b |\n| --- | --- |\n| 1 | 2 |\n" });
    let cell = -1;
    view.state.doc.descendants((node, pos) => {
      if (cell < 0 && node.isTextblock && node.textContent === "1") cell = pos + 1;
    });
    typeAt(view, cell + 1, " /");
    expect(rowIds()).toEqual(["text", "image", "link", "comment", "date", "agent"]);
  });

  it("stays closed for a person who may not edit, and leaves the keys to the editor", () => {
    const { view, editorKeys } = mount({ canEdit: false });
    typeAt(view, WORLD, "/");
    expect(slashMenuState(view.state)).not.toBeNull();
    expect(menu()).toBeNull();
    press(view, "Enter");
    expect(editorKeys).toEqual(["Enter"]);
  });
});

describe("slash menu: keys", () => {
  // The regression test for cause A of #2334. A listener further up the page stands for "the browser
  // moved on": by then the choice must already be in the document.
  it("Enter applies the highlighted item during the keydown itself", () => {
    const { view, ytext, editorKeys } = mount();
    typeAt(view, WORLD, "/head");
    let markdownWhenTheEventLeftTheEditor = "";
    const later = () => {
      markdownWhenTheEventLeftTheEditor = ytext.toString();
    };
    document.addEventListener("keydown", later);
    const event = press(view, "Enter");
    document.removeEventListener("keydown", later);
    expect(markdownWhenTheEventLeftTheEditor).toBe("Hello\n\n# World");
    expect(event.defaultPrevented).toBe(true);
    expect(editorKeys).toEqual([]);
    expect(menu()).toBeNull();
    expect(slashMenuState(view.state)).toBeNull();
    expect(view.hasFocus()).toBe(true);
  });

  it("Tab picks like Enter", () => {
    const { view, ytext } = mount();
    typeAt(view, WORLD, "/quote");
    expect(press(view, "Tab").defaultPrevented).toBe(true);
    expect(ytext.toString()).toBe("Hello\n\n> World");
  });

  it("the arrow keys wrap, Home and End jump, and Enter picks the highlighted row", () => {
    const { view, ytext, editorKeys } = mount();
    typeAt(view, WORLD, "/h");
    // "h" also fits the keywords "hr" (Divider) and "href" (Link).
    expect(rowIds()).toEqual(["heading1", "heading2", "heading3", "divider", "link"]);
    const walk: [string, string][] = [
      ["ArrowDown", "heading2"],
      ["ArrowDown", "heading3"],
      ["ArrowDown", "divider"],
      ["ArrowDown", "link"],
      ["ArrowDown", "heading1"],
      ["ArrowUp", "link"],
      ["Home", "heading1"],
      ["Home", "heading1"],
      ["End", "link"],
      ["End", "link"],
      ["ArrowUp", "divider"],
      ["ArrowUp", "heading3"],
    ];
    for (const [key, expected] of walk) {
      expect(press(view, key).defaultPrevented, key).toBe(true);
      expect(selected(), `${key} -> ${expected}`).toEqual([`slash-item-${expected}`]);
    }
    expect(editorKeys).toEqual([]);
    expect(view.state.selection.head).toBe(WORLD + 2);
    press(view, "Enter");
    expect(ytext.toString()).toBe("Hello\n\n### World");
  });

  it("two arrow presses that arrive before React renders both count", () => {
    const { view, ytext } = mount();
    typeAt(view, WORLD, "/");
    act(() => {
      keydown(view, "ArrowDown");
      keydown(view, "ArrowDown");
      keydown(view, "Enter");
    });
    expect(ytext.toString()).toBe("Hello\n\n## World");
  });

  it("a query and Enter typed in one burst pick the item for that query, not for what was last drawn", () => {
    const { view, ytext } = mount();
    act(() => {
      view.focus();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, WORLD)));
      for (const ch of "/quote") view.dispatch(view.state.tr.insertText(ch));
      keydown(view, "Enter");
    });
    expect(ytext.toString()).toBe("Hello\n\n> World");
    expect(menu()).toBeNull();
  });

  it("the highlight of an older query does not carry over to a new one", () => {
    const { view, ytext } = mount();
    typeAt(view, WORLD, "/");
    press(view, "End");
    expect(selected()).toEqual(["slash-item-agent"]);
    act(() => {
      for (const ch of "h") view.dispatch(view.state.tr.insertText(ch));
      keydown(view, "Enter");
    });
    expect(ytext.toString()).toBe("Hello\n\n# World");
  });

  // The row belongs to one opening of the menu. Before this test the row was remembered for a place and a
  // query, so "/" + ArrowDown + Enter three times in one empty block made Heading 1, Heading 2, Heading 3.
  it("a menu that opens again at the same place starts at the first row", () => {
    const { view, ytext } = mount();
    typeAt(view, WORLD, "/");
    press(view, "ArrowDown");
    press(view, "ArrowDown");
    expect(selected()).toEqual(["slash-item-heading2"]);
    press(view, "Escape");
    expect(menu()).toBeNull();
    act(() => view.dispatch(view.state.tr.delete(WORLD, WORLD + 1)));
    typeAt(view, WORLD, "/");
    expect(selected()).toEqual(["slash-item-text"]);
    // The same after a choice: Heading 2 is made, and the next menu in that block starts at Text.
    press(view, "ArrowDown");
    press(view, "ArrowDown");
    press(view, "Enter");
    expect(ytext.toString()).toBe("Hello\n\n## World");
    act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, WORLD)));
      view.dispatch(view.state.tr.insertText("/"));
      keydown(view, "Enter");
    });
    expect(ytext.toString()).toBe("Hello\n\nWorld");
  });

  it("the highlighted row stays when text arrives above the slash, as when another person types there", () => {
    const { view, ytext } = mount();
    typeAt(view, WORLD, "/");
    press(view, "ArrowDown");
    press(view, "ArrowDown");
    act(() => view.dispatch(view.state.tr.insertText("They say ", 1)));
    expect(slashMenuState(view.state)).toMatchObject({ from: WORLD + 9, query: "" });
    expect(selected()).toEqual(["slash-item-heading2"]);
    press(view, "Enter");
    expect(ytext.toString()).toBe("They say Hello\n\n## World");
  });

  it("inside a table cell the keys pick from the list that is drawn", () => {
    const { view, onLink } = mount({ markdown: "| a | b |\n| --- | --- |\n| 1 | 2 |\n" });
    let cell = -1;
    view.state.doc.descendants((node, pos) => {
      if (cell < 0 && node.isTextblock && node.textContent === "1") cell = pos + 1;
    });
    // Outside a table "/h" starts with Heading 1. In a cell the headings are hidden and Link ("href") is first.
    typeAt(view, cell + 1, " /h");
    expect(rowIds()).toEqual(["link"]);
    press(view, "Enter");
    expect(onLink).toHaveBeenCalledTimes(1);
  });

  it("keeps the highlighted row in view", () => {
    const { view } = mount();
    typeAt(view, WORLD, "/");
    const scrolled = vi.mocked(Element.prototype.scrollIntoView);
    scrolled.mockClear();
    press(view, "End");
    expect(scrolled).toHaveBeenLastCalledWith({ block: "nearest" });
    expect(scrolled.mock.contexts.at(-1)).toBe(row("agent"));
  });

  it("when the list gets shorter under the highlight, the last row is the highlighted one", () => {
    const mounted = mount();
    typeAt(mounted.view, WORLD, "/");
    press(mounted.view, "End");
    expect(selected()).toEqual(["slash-item-agent"]);
    // The person loses the right to comment: the Comment row goes, and the list is one row shorter.
    act(() => {
      mounted.session.canComment = false;
      mounted.rerender(mounted.view);
    });
    expect(rowIds()).not.toContain("comment");
    expect(selected()).toEqual(["slash-item-agent"]);
    press(mounted.view, "Enter");
    expect(mounted.onConnectAgent).toHaveBeenCalledTimes(1);
  });

  it("Enter on No matches closes the menu, keeps the text and does not reach the editor", () => {
    const { view, ytext, editorKeys } = mount();
    typeAt(view, WORLD, "/zzz");
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) expect(press(view, key).defaultPrevented, key).toBe(true);
    expect(screen.getByTestId("slash-empty")).toBeInTheDocument();
    expect(press(view, "Enter").defaultPrevented).toBe(true);
    expect(menu()).toBeNull();
    expect(ytext.toString()).toBe("Hello\n\n/zzzWorld");
    expect(editorKeys).toEqual([]);
  });

  it("Escape closes the menu and keeps the slash", () => {
    const { view, ytext } = mount();
    typeAt(view, WORLD, "/");
    expect(press(view, "Escape").defaultPrevented).toBe(true);
    expect(menu()).toBeNull();
    expect(ytext.toString()).toBe("Hello\n\n/World");
  });

  it("passes the text after the item name on as its argument", () => {
    const { view, ytext } = mount();
    typeAt(view, WORLD, "/code ts");
    expect(rowIds()).toEqual(["code"]);
    press(view, "Enter");
    expect(ytext.toString()).toBe("Hello\n\n```ts\nWorld\n```");
  });

  it("once the choice is made the keys belong to the editor again", () => {
    const { view, editorKeys } = mount();
    typeAt(view, WORLD, "/h1");
    press(view, "Enter");
    press(view, "Enter");
    press(view, "ArrowDown");
    expect(editorKeys).toEqual(["Enter", "ArrowDown"]);
  });

  it("works the same when React runs every effect twice (Strict Mode)", () => {
    const { view, ytext } = mount({ strict: true });
    typeAt(view, WORLD, "/");
    press(view, "ArrowDown");
    expect(selected()).toEqual(["slash-item-heading1"]);
    press(view, "Enter");
    expect(ytext.toString()).toBe("Hello\n\n# World");
  });

  it("puts an undo boundary before and after the choice", () => {
    const { view, session } = mount();
    typeAt(view, WORLD, "/h1");
    press(view, "Enter");
    expect(session.undoManager.stopCapturing).toHaveBeenCalledTimes(2);
  });
});

describe("slash menu: pointer", () => {
  it("a click on a row applies it and the editor keeps the focus", async () => {
    const user = userEvent.setup();
    const { view, ytext } = mount();
    typeAt(view, WORLD, "/");
    expect(view.hasFocus()).toBe(true);
    await user.click(row("quote"));
    expect(ytext.toString()).toBe("Hello\n\n> World");
    expect(menu()).toBeNull();
    expect(view.hasFocus()).toBe(true);
  });

  it("a click that finds the focus outside the editor still applies and brings the caret back", () => {
    const { view, ytext } = mount();
    typeAt(view, WORLD, "/");
    const elsewhere = document.body.appendChild(document.createElement("button"));
    elsewhere.focus();
    expect(view.hasFocus()).toBe(false);
    fireEvent.click(row("quote"));
    elsewhere.remove();
    expect(ytext.toString()).toBe("Hello\n\n> World");
    expect(view.hasFocus()).toBe(true);
  });

  it("cancels mousedown anywhere in the menu, so the editor does not blur and close it", () => {
    const { view } = mount();
    typeAt(view, WORLD, "/");
    expect(fireEvent.mouseDown(row("quote"))).toBe(false);
    expect(fireEvent.mouseDown(menu()!)).toBe(false);
    typeAt(view, view.state.selection.head, "zzz");
    expect(fireEvent.mouseDown(screen.getByTestId("slash-empty"))).toBe(false);
  });

  it("hover moves the highlight, and the keyboard goes on from the hovered row", async () => {
    const user = userEvent.setup();
    const { view, ytext } = mount();
    typeAt(view, WORLD, "/");
    await user.hover(row("quote"));
    expect(selected()).toEqual(["slash-item-quote"]);
    await user.hover(row("bullet"));
    expect(selected()).toEqual(["slash-item-bullet"]);
    press(view, "ArrowDown");
    expect(selected()).toEqual(["slash-item-numbered"]);
    press(view, "Enter");
    expect(ytext.toString()).toBe("Hello\n\n1. World");
  });

  // The pointer often rests where the menu opens (the person just clicked there). The browser then sends
  // mouseover and mouseenter for the row under it, but no mousemove. Enter must still pick the first row.
  it("a menu that opens under a resting pointer keeps its first row", () => {
    const { view, ytext } = mount();
    typeAt(view, WORLD, "/");
    fireEvent.mouseOver(row("quote"));
    fireEvent.mouseEnter(row("quote"));
    expect(selected()).toEqual(["slash-item-text"]);
    fireEvent.mouseMove(row("quote"));
    expect(selected()).toEqual(["slash-item-quote"]);
    press(view, "Enter");
    expect(ytext.toString()).toBe("Hello\n\n> World");
  });

  it("a click applies the clicked row, not the highlighted one", () => {
    const { view, ytext } = mount();
    typeAt(view, WORLD, "/");
    press(view, "ArrowDown");
    expect(selected()).toEqual(["slash-item-heading1"]);
    fireEvent.click(row("divider"));
    expect(ytext.toString()).toBe("Hello\n\nWorld\n\n---");
  });
});

describe("slash menu: items that hand off to the shell", () => {
  it.each([
    ["image", "image", "onImage"],
    ["link", "link", "onLink"],
    // "/agent" lists Comment first (asking an agent is a comment); "/connect" names the agent dialog.
    ["connect", "agent", "onConnectAgent"],
  ] as const)("/%s picks %s, removes the typed text and calls %s once", (typed, id, callback) => {
    const mounted = mount();
    typeAt(mounted.view, WORLD, `/${typed}`);
    expect(selected()).toEqual([`slash-item-${id}`]);
    press(mounted.view, "Enter");
    expect(mounted[callback]).toHaveBeenCalledTimes(1);
    expect(mounted.ytext.toString()).toBe("Hello\n\nWorld");
    expect(menu()).toBeNull();
    // The removal of the typed text is an undo step of its own.
    expect(mounted.session.undoManager.stopCapturing).toHaveBeenCalledTimes(2);
    for (const other of ["onImage", "onLink", "onComment", "onConnectAgent"] as const) {
      if (other !== callback) expect(mounted[other], other).not.toHaveBeenCalled();
    }
  });

  it("/comment selects the block around the caret and then starts the comment", () => {
    const mounted = mount();
    typeAt(mounted.view, WORLD, "/comment");
    let selectionAtCallback = "";
    mounted.onComment.mockImplementation(() => {
      const { from, to } = mounted.view.state.selection;
      selectionAtCallback = mounted.view.state.doc.textBetween(from, to);
    });
    fireEvent.click(row("comment"));
    expect(mounted.onComment).toHaveBeenCalledTimes(1);
    expect(selectionAtCallback).toBe("World");
    expect(mounted.ytext.toString()).toBe("Hello\n\nWorld");
  });
});

describe("slash menu: coming and going", () => {
  it("after the menu unmounts the keys go to the editor", () => {
    const { view, editorKeys, unmount } = mount();
    typeAt(view, WORLD, "/");
    unmount();
    keydown(view, "Enter");
    expect(editorKeys).toEqual(["Enter"]);
  });

  it("a new editor on the same controller starts closed and gets its own keys", () => {
    const first = mount();
    typeAt(first.view, WORLD, "/h1");
    expect(menu()).not.toBeNull();
    const second = makeEditor("Second", first.controller);
    act(() => {
      first.view.destroy();
      first.rerender(second.view);
    });
    expect(menu()).toBeNull();
    typeAt(second.view, 1, "/h1");
    expect(rowIds()).toEqual(["heading1"]);
    press(second.view, "Enter");
    expect(second.ytext.toString()).toBe("# Second");
    expect(first.ytext.toString()).toBe("Hello\n\n/h1World");
  });

  it("with no editor there is no menu and no key is taken", () => {
    const first = mount();
    typeAt(first.view, WORLD, "/");
    act(() => first.rerender(null));
    expect(menu()).toBeNull();
    keydown(first.view, "Enter");
    expect(first.editorKeys).toEqual(["Enter"]);
  });
});