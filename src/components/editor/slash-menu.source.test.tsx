// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { CollabSession } from "@/editor/collab/session";
import { createCodeApi } from "@/editor/codemirror/api";
import { sourceSlashMenu, sourceSlashState } from "@/editor/codemirror/slash-menu";

vi.mock("./use-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./use-session")>();
  return { ...actual, useSessionValue: (session: never, select: (value: never) => unknown) => select(session) };
});

import { createSlashMenuController, SlashMenu } from "./slash-menu";

/** The source pane's `/` menu: the real CodeMirror plugin, the real menu and the real CodeApi. */
const api = createCodeApi();
const container = document.createElement("div");
container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
const views: EditorView[] = [];

const layoutStubs = [
  [Element.prototype, "scrollIntoView", () => undefined],
  [Range.prototype, "getClientRects", () => Object.assign([], { item: () => null })],
  [Range.prototype, "getBoundingClientRect", () => new DOMRect(0, 0, 0, 0)],
] as const;
const originals = layoutStubs.map(([target, name]) => Object.getOwnPropertyDescriptor(target, name));
beforeEach(() => {
  for (const [target, name, value] of layoutStubs) Object.defineProperty(target, name, { configurable: true, writable: true, value });
});
afterEach(() => {
  cleanup();
  for (const view of views.splice(0)) view.destroy();
  container.remove();
  layoutStubs.forEach(([target, name], i) => {
    const original = originals[i];
    if (original) Object.defineProperty(target, name, original);
    else Reflect.deleteProperty(target, name);
  });
});

function mount(doc = "Hello\n\n") {
  const controller = createSlashMenuController();
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [markdown({ base: markdownLanguage }), sourceSlashMenu(controller.handlers)] }),
    parent: document.body,
  });
  views.push(view);
  const session = { contentReady: true, canEdit: true, canComment: true, canCreateComment: true, undoManager: { stopCapturing: vi.fn() } };
  const callbacks = { onImage: vi.fn(), onVideo: vi.fn(), onCard: vi.fn(), onLink: vi.fn(), onComment: vi.fn(), onConnectAgent: vi.fn() };
  render(
    <SlashMenu view={null} source={{ view, api }} session={session as unknown as CollabSession} controller={controller} containerRef={{ current: container }} {...callbacks} />,
    { container: document.body.appendChild(container) },
  );
  const type = async (text: string) => {
    act(() => {
      for (const ch of text) {
        const head = view.state.selection.main.head;
        view.dispatch({ changes: { from: head, insert: ch }, selection: EditorSelection.cursor(head + 1), userEvent: "input.type" });
        ensureSyntaxTree(view.state, view.state.doc.length, 1e9);
      }
    });
    // The plugin measures the `/` before it tells the menu.
    await waitFor(() => expect(controller.getState()?.query ?? null).toBe(sourceSlashState(view.state)?.query ?? null));
  };
  const press = (key: string) => act(() => void runScopeHandlers(view, new KeyboardEvent("keydown", { key }), "editor"));
  return { view, type, press, ...callbacks };
}

const rowIds = () => screen.getAllByRole("option").map((option) => option.getAttribute("data-testid")!.replace("slash-item-", ""));
const menu = () => screen.queryByTestId("slash-menu");

describe("slash menu in the source editor", () => {
  it("opens on / with the source items, Callout among them, and wires the listbox to the editor", async () => {
    const { view, type, press } = mount();
    await type("/");
    expect(menu()?.getAttribute("data-surface")).toBe("source");
    expect(menu()?.getAttribute("role")).toBe("listbox");
    expect(rowIds()).toContain("callout");
    expect(rowIds()).toContain("toc");
    const first = screen.getAllByRole("option")[0];
    expect(view.contentDOM.getAttribute("aria-controls")).toBe(menu()?.id);
    expect(view.contentDOM.getAttribute("aria-activedescendant")).toBe(first.id);
    press("ArrowDown");
    expect(view.contentDOM.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1].id);
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
  });

  it("filters while typing and Enter inserts the Markdown in one go", async () => {
    const { view, type, press } = mount();
    await type("/call");
    expect(rowIds()).toEqual(["callout"]);
    await type(" tip");
    press("Enter");
    expect(view.state.doc.toString()).toBe("Hello\n\n> [!TIP]\n> \n");
    await waitFor(() => expect(menu()).toBeNull());
    expect(view.contentDOM.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("Escape closes the menu and keeps the text", async () => {
    const { view, type, press } = mount();
    await type("/h");
    press("Escape");
    await waitFor(() => expect(menu()).toBeNull());
    expect(view.state.doc.toString()).toBe("Hello\n\n/h");
  });

  it("dialog items remove the query and open the dialog", async () => {
    const { view, type, press, onImage } = mount();
    await type("/image");
    press("Enter");
    expect(onImage).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe("Hello\n\n");
  });

  it("offers no block items inside a table", async () => {
    const { type } = mount("| a | b |\n| --- | --- |\n| c | ");
    await type("/");
    expect(rowIds()).not.toContain("heading1");
    expect(rowIds()).not.toContain("callout");
    expect(rowIds()).toContain("date");
  });
});
