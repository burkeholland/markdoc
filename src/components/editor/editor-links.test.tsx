// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextSelection } from "prosemirror-state";
import type { EditorView as RichView } from "prosemirror-view";
import type { EditorView as CodeView } from "@codemirror/view";
import * as Y from "yjs";

const platform = vi.hoisted(() => ({ mac: false }));
vi.mock("@/lib/utils", async (original) => ({
  ...await original<typeof import("@/lib/utils")>(),
  get isMac() { return platform.mac; },
}));
vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  return {
    HocuspocusProvider: class {
      awareness: InstanceType<typeof Awareness>;
      constructor({ document }: { document: Y.Doc }) { this.awareness = new Awareness(document); }
      destroy() { this.awareness.destroy(); }
    },
  };
});

import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import { activateHighlight } from "@/editor/highlight-activation";
import { refreshRichHighlights } from "@/editor/prosemirror/highlights";
import { RichPane } from "./rich-pane";
import { CodePane } from "./code-pane";

const SOURCE = "Before [**nested** *label*](https://example.test/guide) after\n\n## Section\n";
const sessions: CollabSession[] = [];
const rangeMethods = ["getClientRects", "getBoundingClientRect"] as const;
const originalRangeMethods = rangeMethods.map((name) => Object.getOwnPropertyDescriptor(Range.prototype, name));

beforeEach(() => {
  platform.mac = false;
  vi.spyOn(window, "open").mockImplementation(() => null);
  vi.spyOn(window, "scrollBy").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is forbidden in editor link fixtures"); }));
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => document.body.getClientRects() },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect(0, 0, 10, 10) },
  });
});

afterEach(() => {
  cleanup();
  for (const session of sessions.splice(0)) session.destroy();
  rangeMethods.forEach((name, index) => {
    const original = originalRangeMethods[index];
    if (original) Object.defineProperty(Range.prototype, name, original);
    else Reflect.deleteProperty(Range.prototype, name);
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function openSession(source: string, role: "owner" | "viewer" = "owner") {
  const session = new CollabSession({
    docId: "editor-link-fixture",
    user: makeCollabUser("local", "Local"),
    role,
    getToken: async () => { throw new Error("Provider access is forbidden in editor link fixtures"); },
    autoConnect: false,
  });
  session.keepAlive();
  session.binding.releaseRemoteSync();
  session.ytext.insert(0, source);
  sessions.push(session);
  return session;
}

function mouse(target: EventTarget, type: string, init: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail: 1, ...init });
  let handled: boolean | undefined;
  // Observe the editor's result, then block jsdom's native anchor default too.
  const preventNavigation = () => {
    handled = event.defaultPrevented;
    event.preventDefault();
  };
  const boundary = target instanceof Node && !target.isConnected ? target : document;
  if (type === "click") boundary.addEventListener(type, preventNavigation);
  act(() => { target.dispatchEvent(event); });
  boundary.removeEventListener(type, preventNavigation);
  return { defaultPrevented: handled ?? event.defaultPrevented };
}

function gesture(target: EventTarget, init: MouseEventInit) {
  const down = mouse(target, "mousedown", { ...init, buttons: 1 });
  const up = mouse(target, "mouseup", init);
  const click = mouse(target, "click", init);
  return { down, up, click };
}

function mountEditor(
  surface: "rich" | "source",
  source = SOURCE,
  role: "owner" | "viewer" = "owner",
  activateHighlights = false,
) {
  const session = openSession(source, role);
  const onSelection = vi.fn();
  let highlightOpens = 0;
  const onHighlightClick = vi.fn((kind: string, id: string | null, sourcePosition: number) => {
    if (activateHighlights && activateHighlight(session, kind, id, sourcePosition)) highlightOpens++;
  });
  const onLinkShortcut = vi.fn();
  const onCommentShortcut = vi.fn();
  let rich: RichView | null = null;
  let code: CodeView | null = null;
  const parentClick = vi.fn();
  const parentDown = vi.fn();
  const pane = () => surface === "rich" ? (
    <RichPane session={session} onReady={(view) => { rich = view; }} onSelection={onSelection}
      onHighlightClick={onHighlightClick} onLinkShortcut={onLinkShortcut} onCommentShortcut={onCommentShortcut} />
  ) : (
    <CodePane session={session} onReady={(view) => { code = view; }} onSelection={onSelection}
      onHighlightClick={onHighlightClick} lineWrapping />
  );
  const ui = () => <div onClick={parentClick} onMouseDown={parentDown}>{pane()}</div>;
  const mounted = render(ui());
  if (!rich && !code) throw new Error("Editor did not mount");
  const richView = rich as RichView | null;
  const codeView = code as CodeView | null;
  const dom = richView?.dom ?? codeView!.contentDOM;
  // jsdom has no layout. Coordinates stand for current source offsets; all event dispatch,
  // editor plugins, collaboration binding, decorations and the opener boundary are real.
  if (richView) {
    vi.spyOn(richView, "posAtCoords").mockImplementation(({ left }) => {
      const pos = session.binding.getSourceMap().srcToPm(left);
      return { pos, inside: Math.max(0, richView.state.doc.resolve(pos).before(1)) };
    });
  } else {
    vi.spyOn(codeView!, "posAtCoords").mockImplementation(({ x }) => Math.min(x, codeView!.state.doc.length));
  }
  const selection = () => richView?.state.selection.toJSON() ?? codeView!.state.selection.toJSON();
  const selectElsewhere = () => {
    act(() => {
      if (richView) richView.dispatch(richView.state.tr.setSelection(TextSelection.create(richView.state.doc, 1, 4)));
      else codeView!.dispatch({ selection: { anchor: 0, head: 4 } });
    });
    onSelection.mockClear();
  };
  const target = () => richView?.dom.querySelector("a strong") ?? richView?.dom.querySelector("a") ?? codeView!.contentDOM.querySelector(".cm-line")!;
  return {
    session, dom, rich: richView, code: codeView, selection, selectElsewhere, target,
    onSelection, onHighlightClick, onLinkShortcut, onCommentShortcut, parentClick, parentDown,
    highlightOpens: () => highlightOpens,
    focus: () => act(() => {
      if (richView) richView.focus();
      else codeView!.focus();
      onSelection.mockClear();
    }),
    rerender: () => mounted.rerender(ui()),
    unmount: () => mounted.unmount(),
  };
}

function addLiveHighlight(
  session: CollabSession,
  kind: "comment" | "suggest-insert",
  from: number,
  to: number,
): string {
  if (kind === "comment") return session.comments.add({ from, to, body: "A comment", author: session.user });
  session.suggestions.recordInserted(from, to - from, session.user);
  const suggestion = session.suggestions.list().find((candidate) => candidate.type === "insert" && candidate.from === from && candidate.to === to);
  if (!suggestion) throw new Error("Suggestion fixture was not created");
  return suggestion.groupId ?? suggestion.id;
}

describe.each(["rich", "source"] as const)("%s editor link input", (surface) => {
  it.each([
    ["comment", false],
    ["comment", true],
    ["suggest-insert", false],
    ["suggest-insert", true],
  ] as const)("preserves a platform-modified live non-link %s and keeps ordinary activation (Mac=%s)", async (kind, mac) => {
    platform.mac = mac;
    const editor = mountEditor(surface, "Before highlighted comment after", "owner", true);
    const from = editor.session.ytext.toString().indexOf("highlighted");
    let id = "";
    act(() => {
      id = addLiveHighlight(editor.session, kind, from, from + "highlighted".length);
      if (editor.rich) refreshRichHighlights(editor.rich);
    });
    const selector = kind === "comment" ? ".md-comment" : ".md-suggest-insert";
    await waitFor(() => expect(editor.dom.querySelector(selector)).not.toBeNull());
    editor.selectElsewhere();
    editor.focus();
    const before = editor.selection();
    const focused = document.activeElement;
    const markdown = editor.session.ytext.toString();
    const modifier = { [mac ? "metaKey" : "ctrlKey"]: true };
    const target = editor.dom.querySelector(selector)!;

    const modified = gesture(target, { clientX: from + 2, ...modifier });

    expect(modified.down.defaultPrevented).toBe(true);
    expect(modified.click.defaultPrevented).toBe(true);
    expect(editor.onHighlightClick).not.toHaveBeenCalled();
    expect(editor.highlightOpens()).toBe(0);
    expect(editor.session.activeCommentId).toBeNull();
    expect(editor.session.activeSuggestionId).toBeNull();
    expect(editor.selection()).toEqual(before);
    expect(document.activeElement).toBe(focused);
    expect(editor.session.ytext.toString()).toBe(markdown);
    expect(window.open).not.toHaveBeenCalled();

    gesture(target, { clientX: from + 2 });
    expect(editor.onHighlightClick).toHaveBeenCalledExactlyOnceWith(kind, id, from + 2);
    expect(editor.highlightOpens()).toBe(1);
    expect(kind === "comment" ? editor.session.activeCommentId : editor.session.activeSuggestionId).toBe(id);
  });

  it.each([false, true])("opens exactly once without changing text, selection, focus or parent UI (Mac=%s)", (mac) => {
    platform.mac = mac;
    const editor = mountEditor(surface);
    editor.selectElsewhere();
    const before = editor.selection();
    const focused = document.activeElement;
    const location = window.location.href;
    const markdown = editor.session.ytext.toString();
    const event = gesture(editor.target(), { clientX: SOURCE.indexOf("nested") + 2, [mac ? "metaKey" : "ctrlKey"]: true });
    expect(event.down.defaultPrevented).toBe(true);
    expect(event.click.defaultPrevented).toBe(true);
    expect(window.open).toHaveBeenCalledExactlyOnceWith("https://example.test/guide", "_blank", "noopener");
    expect(editor.session.ytext.toString()).toBe(markdown);
    expect(editor.selection()).toEqual(before);
    expect(document.activeElement).toBe(focused);
    expect(window.location.href).toBe(location);
    expect(editor.onSelection).not.toHaveBeenCalled();
    expect(editor.parentDown).not.toHaveBeenCalled();
    expect(editor.parentClick).not.toHaveBeenCalled();
    expect(editor.onHighlightClick).not.toHaveBeenCalled();
    expect(editor.onLinkShortcut).not.toHaveBeenCalled();
    expect(editor.onCommentShortcut).not.toHaveBeenCalled();
  });

  it.each(["owner", "viewer"] as const)("works without edit permission after mode changes (%s)", (role) => {
    const editor = mountEditor(surface, SOURCE, role);
    act(() => editor.session.setMode("viewing"));
    expect(editor.session.canEdit).toBe(false);
    editor.selectElsewhere();
    const before = editor.selection();
    gesture(editor.target(), { clientX: SOURCE.indexOf("nested"), ctrlKey: true });
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(editor.selection()).toEqual(before);
  });

  it.each([
    ["../guide?q=one#section", new URL("../guide?q=one#section", document.baseURI).href],
    ["#section", new URL("#section", document.baseURI).href],
    ["/guide", new URL("/guide", document.baseURI).href],
    ["//example.test/guide", new URL("//example.test/guide", document.baseURI).href],
    ["https://example.test/a?x=1&y=2", "https://example.test/a?x=1&y=2"],
    ["http://example.test/guide", "http://example.test/guide"],
    ["mailto:reader@example.test", "mailto:reader@example.test"],
    ["irc://example.test/channel", "irc://example.test/channel"],
    ["ircs://example.test/channel", "ircs://example.test/channel"],
    ["xmpp:reader@example.test", "xmpp:reader@example.test"],
  ])("uses current reader href policy for %s", (href, expected) => {
    const source = `before [link](${href}) after`;
    const editor = mountEditor(surface, source);
    gesture(editor.target(), { clientX: source.indexOf("link") + 1, ctrlKey: true });
    expect(window.open).toHaveBeenCalledExactlyOnceWith(expected, "_blank", "noopener");
    expect(editor.session.ytext.toString()).toBe(source);
  });

  it.each(["javascript:blocked", "data:text/plain,blocked", "vbscript:blocked", "file:///blocked", "https://[invalid", ""])(
    "does not open a disallowed or invalid destination (%s)", (href) => {
      const source = `before [link](${href}) after`;
      const editor = mountEditor(surface, source);
      const target = editor.rich?.dom.querySelector("a") ?? editor.dom.querySelector(".cm-line")!;
      const click = mouse(target, "click", { clientX: source.indexOf("link") + 1, ctrlKey: true });
      expect(click.defaultPrevented).toBe(false);
      expect(window.open).not.toHaveBeenCalled();
      expect(editor.session.ytext.toString()).toBe(source);
      if (editor.rich) expect(target.hasAttribute("href")).toBe(false);
    },
  );

  it.each([
    {},
    { button: 1, ctrlKey: true },
    { button: 2, ctrlKey: true },
    { ctrlKey: true, altKey: true },
    { ctrlKey: true, shiftKey: true },
    { metaKey: true },
  ])("leaves other click gestures alone (%j)", (init) => {
    const editor = mountEditor(surface);
    const click = mouse(editor.target(), "click", { clientX: SOURCE.indexOf("nested"), ...init });
    expect(click.defaultPrevented).toBe(false);
    expect(editor.parentClick).toHaveBeenCalledTimes(init.button === 2 ? 0 : 1);
    expect(window.open).not.toHaveBeenCalled();
  });

  it("leaves Mac Control-click for the context menu", () => {
    platform.mac = true;
    const editor = mountEditor(surface);
    const click = mouse(editor.target(), "click", { clientX: SOURCE.indexOf("nested"), ctrlKey: true });
    expect(click.defaultPrevented).toBe(false);
    expect(window.open).not.toHaveBeenCalled();
  });

  it("ignores modified clicks on nonlinks and adjacent text", () => {
    const editor = mountEditor(surface);
    const target = editor.rich?.dom.querySelector("p") ?? editor.dom.querySelector(".cm-line")!;
    for (const clientX of [1, SOURCE.indexOf(" after") + 3]) {
      const click = mouse(target, "click", { clientX, ctrlKey: true });
      expect(click.defaultPrevented).toBe(false);
    }
    expect(window.open).not.toHaveBeenCalled();
  });

  it.each([false, true])("wins over overlapping highlights without changing their plain-click behavior (Mac=%s)", async (mac) => {
    platform.mac = mac;
    const editor = mountEditor(surface, SOURCE, "owner", true);
    const from = SOURCE.indexOf("nested");
    let suggestionId = "";
    act(() => {
      editor.session.comments.add({ from, to: from + 6, body: "A comment", author: editor.session.user });
      suggestionId = addLiveHighlight(editor.session, "suggest-insert", from + 1, from + 4);
      if (editor.rich) refreshRichHighlights(editor.rich);
    });
    await waitFor(() => expect(editor.dom.querySelector(".md-suggest-insert")).not.toBeNull());
    const target = editor.dom.querySelector<HTMLElement>(".md-suggest-insert");
    expect(target).not.toBeNull();
    const targetKind = target!.dataset.highlightKind!;
    const targetId = target!.dataset.highlightId!;
    editor.selectElsewhere();
    editor.focus();
    const before = editor.selection();
    const focused = document.activeElement;
    const markdown = editor.session.ytext.toString();
    gesture(target!, { clientX: from + 2, [mac ? "metaKey" : "ctrlKey"]: true });
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(editor.onHighlightClick).not.toHaveBeenCalled();
    expect(editor.highlightOpens()).toBe(0);
    expect(editor.selection()).toEqual(before);
    expect(document.activeElement).toBe(focused);
    expect(editor.session.ytext.toString()).toBe(markdown);
    gesture(target!, { clientX: from + 2 });
    expect(editor.onHighlightClick).toHaveBeenCalledExactlyOnceWith(targetKind, targetId, from + 2);
    expect(editor.highlightOpens()).toBe(1);
    expect(
      targetKind.startsWith("comment") ? editor.session.activeCommentId : editor.session.activeSuggestionId,
    ).toBe(targetId);
    expect([suggestionId, editor.session.comments.list()[0].id]).toContain(targetId);
    expect(window.open).toHaveBeenCalledTimes(1);
  });

  it.each(["comment", "suggest-insert"] as const)("turns a modified non-link %s drag into selection without opening", async (kind) => {
    const source = "Before highlighted passage after";
    const editor = mountEditor(surface, source, "owner", true);
    const from = source.indexOf("highlighted");
    act(() => {
      addLiveHighlight(editor.session, kind, from, from + "highlighted".length);
      if (editor.rich) refreshRichHighlights(editor.rich);
    });
    const selector = kind === "comment" ? ".md-comment" : ".md-suggest-insert";
    await waitFor(() => expect(editor.dom.querySelector(selector)).not.toBeNull());
    editor.selectElsewhere();
    editor.focus();
    const before = editor.selection();
    const target = editor.dom.querySelector(selector)!;

    mouse(target, "mousedown", { clientX: from + 1, ctrlKey: true, buttons: 1 });
    mouse(target, "mousemove", { clientX: from + 7, ctrlKey: true, buttons: 1 });
    mouse(target, "mouseup", { clientX: from + 7, ctrlKey: true });
    mouse(target, "click", { clientX: from + 7, ctrlKey: true });

    expect(editor.selection()).not.toEqual(before);
    expect(document.activeElement).toBe(editor.dom);
    expect(editor.session.ytext.toString()).toBe(source);
    expect(editor.onHighlightClick).not.toHaveBeenCalled();
    expect(editor.highlightOpens()).toBe(0);
    expect(window.open).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong platform", { metaKey: true }],
    ["with Alt", { ctrlKey: true, altKey: true }],
    ["with Shift", { ctrlKey: true, shiftKey: true }],
    ["auxiliary", { button: 1, ctrlKey: true }],
    ["context", { button: 2, ctrlKey: true }],
    ["double", { detail: 2, ctrlKey: true }],
  ] as const)("does not add highlight behavior for %s gestures", async (_label, init) => {
    const source = "Before highlighted passage after";
    const editor = mountEditor(surface, source, "owner", true);
    const from = source.indexOf("highlighted");
    act(() => {
      addLiveHighlight(editor.session, "comment", from, from + "highlighted".length);
      if (editor.rich) refreshRichHighlights(editor.rich);
    });
    await waitFor(() => expect(editor.dom.querySelector(".md-comment")).not.toBeNull());

    gesture(editor.dom.querySelector(".md-comment")!, { clientX: from + 2, ...init });

    expect(editor.onHighlightClick).not.toHaveBeenCalled();
    expect(editor.highlightOpens()).toBe(0);
    expect(editor.session.activeCommentId).toBeNull();
    expect(editor.session.ytext.toString()).toBe(source);
    expect(window.open).not.toHaveBeenCalled();
  });

  it("reads current destinations after a remote edit and rerender, including edits during a gesture", () => {
    const editor = mountEditor(surface);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(editor.session.ydoc));
    const text = remote.getText("content");
    const replace = (old: string, next: string) => {
      const index = text.toString().indexOf(old);
      remote.transact(() => { text.delete(index, old.length); text.insert(index, next); });
      act(() => Y.applyUpdate(editor.session.ydoc, Y.encodeStateAsUpdate(remote)));
    };
    try {
      replace("guide", "updated");
      remote.transact(() => text.insert(0, "Prefix "));
      act(() => Y.applyUpdate(editor.session.ydoc, Y.encodeStateAsUpdate(remote)));
      editor.rerender();
      const clientX = editor.session.ytext.toString().indexOf("nested") + 2;
      mouse(editor.target(), "mousedown", { clientX, ctrlKey: true, buttons: 1 });
      replace("updated", "latest");
      mouse(editor.target(), "mouseup", { clientX, ctrlKey: true });
      mouse(editor.target(), "click", { clientX, ctrlKey: true });
      expect(window.open).toHaveBeenCalledExactlyOnceWith("https://example.test/latest", "_blank", "noopener");
    } finally {
      remote.destroy();
    }
  });

  it.each([false, true])("selects a modified drag instead of opening a link (release modifier=%s)", (release) => {
    const editor = mountEditor(surface);
    editor.selectElsewhere();
    const before = editor.selection();
    const clientX = SOURCE.indexOf("nested");
    mouse(editor.target(), "mousedown", { clientX, ctrlKey: true, buttons: 1 });
    mouse(editor.target(), "mousemove", { clientX: clientX + 6, ctrlKey: true, buttons: 1 });
    mouse(editor.target(), "mouseup", { clientX: clientX + 6, ctrlKey: true });
    mouse(editor.target(), "click", { clientX: clientX + 6, ctrlKey: !release });
    expect(window.open).not.toHaveBeenCalled();
    expect(editor.selection()).not.toEqual(before);
    expect(editor.session.ytext.toString()).toBe(SOURCE);
  });

  it("leaves unmodified mousedown and drag events with the editor", () => {
    const editor = mountEditor(surface);
    const clientX = SOURCE.indexOf("nested");
    mouse(editor.target(), "mousedown", { clientX, buttons: 1 });
    mouse(editor.target(), "mousemove", { clientX: clientX + 6, buttons: 1 });
    mouse(editor.target(), "mouseup", { clientX: clientX + 6 });
    mouse(editor.target(), "click", { clientX: clientX + 6 });
    expect(editor.parentDown).toHaveBeenCalledTimes(1);
    expect(editor.session.ytext.toString()).toBe(SOURCE);
    expect(window.open).not.toHaveBeenCalled();
  });

  it("does not intercept modified nonlink mousedown or middle/right buttons", () => {
    const editor = mountEditor(surface);
    const target = editor.rich?.dom.querySelector("p") ?? editor.dom.querySelector(".cm-line")!;
    gesture(target, { clientX: 1, ctrlKey: true });
    expect(editor.parentDown).toHaveBeenCalledTimes(1);
    for (const button of [1, 2]) {
      mouse(editor.target(), "mousedown", { clientX: SOURCE.indexOf("nested"), button, ctrlKey: true });
      mouse(editor.target(), "mouseup", { clientX: SOURCE.indexOf("nested"), button, ctrlKey: true });
    }
    expect(editor.parentDown).toHaveBeenCalledTimes(3);
    expect(window.open).not.toHaveBeenCalled();
  });

  it("removes pending gesture listeners on unmount", () => {
    const editor = mountEditor(surface);
    const target = editor.target();
    mouse(target, "mousedown", { clientX: SOURCE.indexOf("nested"), ctrlKey: true, buttons: 1 });
    editor.unmount();
    mouse(document, "mousemove", { clientX: 50, buttons: 1, ctrlKey: true });
    mouse(document, "mouseup", { clientX: 50, ctrlKey: true });
    mouse(target, "click", { clientX: 50, ctrlKey: true });
    expect(window.open).not.toHaveBeenCalled();
  });
});

describe("rich link editing", () => {
  it.each(["strong", "em", "code", "s"])("finds links through nested %s markup", (tag) => {
    const source = "Before [**bold** *italic* `code` ~~deleted~~](../guide) after";
    const editor = mountEditor("rich", source);
    const target = editor.dom.querySelector(`a ${tag}`)!;
    gesture(target, { ctrlKey: true });
    expect(window.open).toHaveBeenCalledExactlyOnceWith(new URL("../guide", document.baseURI).href, "_blank", "noopener");
  });

  it("preserves the link dialog and formatting keyboard shortcuts", () => {
    const editor = mountEditor("rich");
    act(() => {
      editor.rich!.focus();
      editor.rich!.dispatch(editor.rich!.state.tr.setSelection(TextSelection.create(editor.rich!.state.doc, 1, 4)));
      editor.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(editor.onLinkShortcut).toHaveBeenCalledTimes(1);
    act(() => editor.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(editor.rich!.state.doc.rangeHasMark(1, 4, editor.rich!.state.schema.marks.strong)).toBe(true);
    expect(window.open).not.toHaveBeenCalled();
  });
});

describe("source Markdown destinations", () => {
  it.each([
    ["before [**nested**][ref] after\n\n[ref]: ../reference \"Title\"\n", "nested", "../reference"],
    ["before [ref][] after\n\n[REF]: #section\n", "ref", "#section"],
    ["before [ref] after\n\n[ref]: /first\n[ref]: /second\n", "ref", "/first"],
    ["before <https://example.test/auto> after", "auto", "https://example.test/auto"],
    ["before https://example.test/bare after", "bare", "https://example.test/bare"],
    ["before [label](https://example.test/a_(b)?x=1&amp;y=2 \"Title\") after", "a_(b)", "https://example.test/a_(b)?x=1&y=2"],
  ])("resolves parsed link destinations rather than guessing from tokens (%s)", (source, label, href) => {
    const editor = mountEditor("source", source);
    gesture(editor.target(), { clientX: source.indexOf(label) + 1, ctrlKey: true });
    expect(window.open).toHaveBeenCalledExactlyOnceWith(new URL(href, document.baseURI).href, "_blank", "noopener");
  });

  it.each([
    "before `https://example.test/code` after",
    "```\n[link](https://example.test/fenced)\n```\n",
    "before ![image](https://example.test/image.png) after",
    "before [missing][ref] after",
  ])("does not treat code, images or unresolved references as links (%s)", (source) => {
    const editor = mountEditor("source", source);
    mouse(editor.target(), "click", { clientX: Math.max(source.indexOf("example"), source.indexOf("missing")) + 2, ctrlKey: true });
    expect(window.open).not.toHaveBeenCalled();
  });
});
