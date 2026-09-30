// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { TextSelection } from "prosemirror-state";
import type { EditorView as PMView } from "prosemirror-view";
import type { EditorView as CMView } from "@codemirror/view";
import * as Y from "yjs";

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  return {
    HocuspocusProvider: class {
      awareness: InstanceType<typeof Awareness>;
      constructor(opts: { document: Y.Doc }) { this.awareness = new Awareness(opts.document); }
      destroy() { this.awareness.destroy(); }
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      documents: {
        collaborators: vi.fn().mockResolvedValue({ owner: null, collaborators: [], agents: [] }),
        reviews: vi.fn().mockResolvedValue({ reviews: [] }),
      },
      tokens: { list: vi.fn().mockResolvedValue({ tokens: [] }) },
    },
  };
});
vi.mock("@/lib/notifications-store", () => ({ markRefsRead: vi.fn(), useUnreadRefs: () => new Set<string>() }));
vi.mock("./use-session", async (importOriginal) => ({
  ...await importOriginal<typeof import("./use-session")>(),
  useCollabSession: () => session,
}));
// Keep the real editors, comment cards, lazy panel, responsive hook and Radix sheet. The surrounding
// chrome is reduced to its entry points so this suite never starts persistence or requests a server.
vi.mock("./header", () => ({
  Header: (props: ComponentProps<typeof import("./header").Header>) => (
    <button data-testid="comments-toggle" aria-label="Comments" onClick={(event) => props.onToggleComments(event.detail === 0)}>Comments</button>
  ),
}));
vi.mock("./toolbar", () => ({
  Toolbar: (props: ComponentProps<typeof import("./toolbar").Toolbar>) => <button onClick={props.onComment}>Add comment</button>,
}));
vi.mock("./status-bar", () => ({
  StatusBar: (props: ComponentProps<typeof import("./status-bar").StatusBar>) => (
    <div data-testid="layout" data-layout={props.layout}>
      <button onClick={() => props.onLayout("rich")}>Preview only</button>
      <button onClick={() => props.onLayout("code")}>Code only</button>
    </div>
  ),
}));
vi.mock("./outline", () => ({ OutlinePanel: () => null }));
vi.mock("./selection-bubble", () => ({ SelectionBubble: () => null }));
vi.mock("./table-menu", () => ({ TableMenu: () => null }));
vi.mock("./slash-menu", () => ({ SlashMenu: () => null, useSlashMenuController: () => ({ handlers: undefined }) }));
vi.mock("./hint-bar", () => ({ HintBar: () => null }));
vi.mock("./follow-banner", () => ({ FollowBanner: () => null }));
vi.mock("./scroll-sync", () => ({ useScrollSync: () => {} }));
vi.mock("./rich-pane", async (importOriginal) => {
  const { RichPane } = await importOriginal<typeof import("./rich-pane")>();
  return {
    RichPane: (props: ComponentProps<typeof RichPane>) => (
      <RichPane {...props} onReady={(view) => { rich = view; richOwner = view ? props.session : null; props.onReady(view); }} />
    ),
  };
});
vi.mock("./code-pane", async (importOriginal) => {
  const { CodePane } = await importOriginal<typeof import("./code-pane")>();
  return {
    CodePane: (props: ComponentProps<typeof CodePane>) => {
      codeHighlight = props.onHighlightClick;
      return <CodePane {...props} onReady={(view, api) => {
        code = view;
        codeOwner = view ? props.session : null;
        codeHighlight = view ? props.onHighlightClick : null;
        if (view) codeVisits.push(view);
        props.onReady(view, api);
      }} />;
    },
  };
});

import { CollabSession } from "@/editor/collab/session";
import { createAnchor, makeCollabUser } from "@/editor/collab/shared";
import type { HighlightClickHandler } from "@/editor/highlight-activation";
import { PHONE_MAX, TABLET_MAX, type Layout } from "@/lib/viewport";
import type { DocumentDto } from "@/server/dto";
import type { AgentRequestMirror } from "./agent-requests";
import { EditorShell } from "./editor-shell";

// These are warm semantic scenarios, not cold chunk-load timing tests. Compile the real modules
// before mounting; EditorShell still installs them through its actual lazy/dynamic boundaries.
const commentsPanelReady = import("./comments-panel");
const codePaneReady = import("./code-pane");

let session: CollabSession;
let rich: PMView | null = null;
let code: CMView | null = null;
let richOwner: CollabSession | null = null;
let codeOwner: CollabSession | null = null;
let codeHighlight: HighlightClickHandler | null = null;
const codeVisits: CMView[] = [];
let threadId: string;
const TEXT = "A commented paragraph for editing.\n\nOrdinary plain text.\n";
const TYPED = "abcdefghijklmnopqrst";
const user = makeCollabUser("synthetic", "Synthetic");
const doc: DocumentDto = {
  id: "synthetic-doc", title: "Responsive comments", ownerId: user.id, storage: "local", linkAccess: "private",
  gistId: null, gistFile: null, repoOwner: null, repoName: null, repoBranch: null, repoPath: null,
  publishedAt: null, hasUnpublishedChanges: false, githubUrl: null,
  createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:00:00Z",
};
const media = new Map<string, { matches: boolean; listeners: Set<() => void> }>();
const originalGeometry = [
  { target: window, key: "innerWidth" },
  { target: Range.prototype, key: "getClientRects" },
  { target: Range.prototype, key: "getBoundingClientRect" },
  { target: HTMLElement.prototype, key: "scrollIntoView" },
].map(({ target, key }) => ({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) }));
const originalUrl = window.location.href;
function matches(query: string, width: number) {
  const min = /min-width: ([\d.]+)px/.exec(query);
  const max = /max-width: ([\d.]+)px/.exec(query);
  return !!(min || max) && (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
}
function viewport(width: number) {
  act(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    for (const [query, mq] of media) {
      const next = matches(query, width);
      if (mq.matches === next) continue;
      mq.matches = next;
      for (const listener of mq.listeners) listener();
    }
    window.dispatchEvent(new Event("resize"));
  });
}
function mount(width: number, layout?: Layout, strict = false) {
  viewport(width);
  if (layout) localStorage.setItem("markdoc:layout", layout);
  return render(<EditorShell doc={doc} role="owner" user={{ id: user.id, name: user.name, login: null, image: null }} githubAvailable={false} githubConfigured={false} />, { reactStrictMode: strict });
}
function currentCodeView(container: HTMLElement, view = code): CMView {
  if (!view || codeOwner !== session || !view.dom.isConnected ||
    container.querySelector('[data-testid="code-pane"] .cm-editor') !== view.dom) {
    throw new Error("Current source editor is not mounted");
  }
  return view;
}
async function sourceEditorReady(container: HTMLElement) {
  const view = await waitFor(() => currentCodeView(container));
  expect(container.querySelector('[data-testid="code-pane-loading"]')).toBeNull();
  expect(container.querySelectorAll('[data-testid="code-pane"] .cm-editor')).toHaveLength(1);
  expect(codeHighlight).not.toBeNull();
  expect(view.state.doc.toString()).toBe(TEXT);
  return view;
}
function selectRich(anchor = 5, head = anchor) {
  expect(richOwner).toBe(session);
  expect(rich!.dom.isConnected).toBe(true);
  expect(screen.getByTestId("rich-pane")).toContainElement(rich!.dom);
  act(() => {
    rich!.dispatch(rich!.state.tr.setSelection(TextSelection.create(rich!.state.doc, anchor, head)));
    rich!.focus();
  });
}
function clickRichHighlight() {
  const mark = rich!.dom.querySelector<HTMLElement>(`[data-highlight-id="${threadId}"]`)!;
  expect(mark).not.toBeNull();
  const hitTest = vi.spyOn(rich!, "posAtCoords").mockReturnValue({ pos: 5, inside: 0 });
  const dispatch = (type: string, init: MouseEventInit = {}) => {
    mark.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 5,
      clientY: 5,
      detail: 1,
      ...init,
    }));
  };
  vi.useFakeTimers();
  try {
    act(() => {
      dispatch("pointerdown", { buttons: 1 });
      dispatch("mousedown", { buttons: 1 });
      dispatch("pointerup");
      dispatch("mouseup");
      dispatch("click");
      vi.advanceTimersByTime(750);
    });
  } finally {
    hitTest.mockRestore();
    vi.useRealTimers();
  }
}
function expectClosed() {
  expect(screen.queryByTestId("comments-panel")).toBeNull();
  expect(screen.queryByTestId("sheet")).toBeNull();
  expect(screen.queryByTestId("panel-overlay")).toBeNull();
  expect(screen.queryByTestId("side-panel")).toBeNull();
}
async function expectPanel(width: number) {
  await screen.findByTestId("comments-panel");
  expect(screen.getAllByTestId("comments-panel")).toHaveLength(1);
  expect(screen.queryByTestId("side-panel-loading")).toBeNull();
  const kind = width < PHONE_MAX ? "sheet" : width < TABLET_MAX ? "panel-overlay" : "side-panel";
  expect(screen.getByTestId(kind)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Close comments" })).toBeInTheDocument();
  expect(screen.getAllByTestId("comment-thread")).toHaveLength(1);
  expect(screen.getByTestId("comment-thread")).toHaveAttribute("data-thread-id", threadId);
}

beforeEach(async () => {
  rich = null;
  code = null;
  richOwner = null;
  codeOwner = null;
  codeHighlight = null;
  codeVisits.length = 0;
  await Promise.all([commentsPanelReady, codePaneReady]);
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  media.clear();
  vi.stubGlobal("matchMedia", (query: string) => {
    let mq = media.get(query);
    if (!mq) {
      mq = { matches: matches(query, window.innerWidth), listeners: new Set() };
      media.set(query, mq);
    }
    const state = mq;
    return {
      get matches() { return state.matches; },
      addEventListener: (_: string, listener: () => void) => state.listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => state.listeners.delete(listener),
    };
  });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request in responsive comment test"); }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  // No geometry claims are made in jsdom. These methods allow the real editors to keep their
  // normal DOM selection machinery while the tests assert state, focus and scrollTop retention.
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  session = new CollabSession({ docId: doc.id, user, role: "owner", autoConnect: false, getToken: async () => { throw new Error("No provider connection permitted"); } });
  session.keepAlive();
  session.ytext.insert(0, TEXT);
  session.binding.releaseRemoteSync();
  await waitFor(() => expect(session.binding.hasHeldSync).toBe(false));
  session.localLoaded = true;
  threadId = session.comments.add({ from: 2, to: 21, body: "Synthetic thread", author: user });
});
afterEach(() => {
  try {
    cleanup();
    session.destroy();
    expect(fetch).not.toHaveBeenCalled();
    expect(rich).toBeNull();
    expect(code).toBeNull();
    expect(richOwner).toBeNull();
    expect(codeOwner).toBeNull();
    expect(codeHighlight).toBeNull();
    for (const view of codeVisits) expect(view.dom.isConnected).toBe(false);
  } finally {
    rich = null;
    code = null;
    richOwner = null;
    codeOwner = null;
    codeHighlight = null;
    codeVisits.length = 0;
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const { target, key, descriptor } of originalGeometry) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
    media.clear();
    localStorage.clear();
    window.history.replaceState(null, "", originalUrl);
  }
});

describe("responsive comment opening at the real shell boundary", () => {
  it("keeps a stale same-ID highlight from opening automatic comments", () => {
    mount(1280, "rich");
    selectRich();
    const selection = rich!.state.selection.toJSON();
    const activate = vi.spyOn(session, "setActiveComment");
    act(() => {
      session.comments.ymap.get(threadId)!.set("anchor", createAnchor(session.ytext, 36, 44));
      clickRichHighlight();
    });
    expect(activate).not.toHaveBeenCalled();
    expect(session.activeCommentId).toBeNull();
    expectClosed();
    expect(rich!.hasFocus()).toBe(true);
    expect(rich!.state.selection.toJSON()).toEqual(selection);
  });

  it.each([
    [390, "phone", "rich"],
    [520, "phone", "rich"],
    [768, "tablet", "split"],
    [1024, "desktop", "split"],
    [1280, "desktop", "split"],
  ] as const)("uses the actual default layout at %i px (%s/%s)", async (width, breakpoint, layout) => {
    mount(width);
    expect(screen.getByTestId("editor-shell")).toHaveAttribute("data-breakpoint", breakpoint);
    expect(screen.getByTestId("layout")).toHaveAttribute("data-layout", layout);
    const activate = vi.spyOn(session, "setActiveComment");
    selectRich();
    clickRichHighlight();
    expect(activate).toHaveBeenCalledExactlyOnceWith(threadId);
    expect(session.activeCommentId).toBe(threadId);
    if (width < TABLET_MAX) {
      expectClosed();
      expect(rich!.hasFocus()).toBe(true);
    } else {
      await expectPanel(width);
      expect(rich!.hasFocus()).toBe(true);
    }
  });

  it.each([390, 520, 768])("keeps rich editing, 20 characters, selection and scroll at %i px", async (width) => {
    mount(width, "rich");
    selectRich();
    const scroller = screen.getByTestId("rich-column").querySelector<HTMLElement>(".overflow-y-auto")!;
    scroller.scrollTop = 180;
    clickRichHighlight();
    expectClosed();
    expect(rich!.state.selection.from).toBe(5);
    expect(scroller.scrollTop).toBe(180);
    const before = session.ytext.toString();
    const offset = session.binding.getSourceMap().pmToSrc(5);
    act(() => {
      for (const char of TYPED) rich!.dispatch(rich!.state.tr.insertText(char));
    });
    expect(session.ytext.toString()).toBe(before.slice(0, offset) + TYPED + before.slice(offset));
    expectClosed();
    selectRich(8, 4);
    const selection = rich!.state.selection.toJSON();
    await userEvent.click(screen.getByTestId("comments-toggle"));
    await expectPanel(width);
    await userEvent.click(screen.getByRole("button", { name: "Close comments" }));
    await waitFor(() => expect(rich!.hasFocus()).toBe(true));
    expect(rich!.state.selection.toJSON()).toEqual(selection);
    expect(scroller.scrollTop).toBe(180);
    expect(session.ytext.toString()).toBe(before.slice(0, offset) + TYPED + before.slice(offset));
  });

  describe.each([false, true])("source editor ownership (Strict Mode: %s)", (strict) => {
    it.each([390, 768])("keeps source clicks closed and restores the source selection at %i px", async (width) => {
      expect(code).toBeNull();
      expect(codeOwner).toBeNull();
      expect(codeHighlight).toBeNull();
      const { container } = mount(width, "code", strict);
      const view = await sourceEditorReady(container);
      expect(codeVisits).toHaveLength(strict ? 2 : 1);
      expect(codeVisits.at(-1)).toBe(view);
      // Strict Mode really retires the first view before publishing its successor.
      for (const retired of codeVisits.slice(0, -1)) {
        expect(retired.dom.isConnected).toBe(false);
        expect(() => currentCodeView(container, retired)).toThrow("Current source editor is not mounted");
      }
      act(() => {
        view.dispatch({ selection: { anchor: 4, head: 10 } });
        view.focus();
        codeHighlight!("comment", threadId, view.state.selection.main.head);
      });
      expectClosed();
      expect(session.activeCommentId).toBe(threadId);
      expect(view.hasFocus).toBe(true);
      expect(view.state.selection.main.anchor).toBe(4);
      expect(view.state.selection.main.head).toBe(10);
      const selection = view.state.selection.toJSON();
      view.scrollDOM.scrollTop = 120;
      await userEvent.click(screen.getByTestId("comments-toggle"));
      await expectPanel(width);
      expect(currentCodeView(container)).toBe(view);
      expect(view.state.selection.toJSON()).toEqual(selection);
      expect(view.scrollDOM.scrollTop).toBe(120);
      await userEvent.click(screen.getByRole("button", { name: "Close comments" }));
      await waitFor(() => expect(view.hasFocus).toBe(true));
      expectClosed();
      expect(currentCodeView(container)).toBe(view);
      expect(view.state.selection.toJSON()).toEqual(selection);
      expect(view.scrollDOM.scrollTop).toBe(120);
      expect(view.state.doc.toString()).toBe(TEXT);
      expect(session.ytext.toString()).toBe(TEXT);
    });
  });

  it.each([390, 520, 768])("never mounts an automatic-wide panel as an overlay when narrowing to %i px", async (width) => {
    mount(1280, "rich");
    selectRich();
    clickRichHighlight();
    await expectPanel(1280);
    viewport(width);
    expectClosed();
    expect(rich!.hasFocus()).toBe(true);
    viewport(1280);
    expectClosed();
  });

  it.each(["button", "panel-pointer", "panel-keyboard"] as const)("preserves deliberately opened/interacted panels on resize: %s", async (intent) => {
    mount(1280, "rich");
    selectRich();
    if (intent === "button") await userEvent.click(screen.getByTestId("comments-toggle"));
    else {
      clickRichHighlight();
      await expectPanel(1280);
      if (intent === "panel-pointer") fireEvent.pointerDown(screen.getByTestId("comments-panel"));
      else act(() => screen.getByRole("tab", { name: /Open/ }).focus());
    }
    clickRichHighlight();
    viewport(520);
    await expectPanel(520);
    await userEvent.click(screen.getByRole("button", { name: "Close comments" }));
    await waitFor(() => expect(rich!.hasFocus()).toBe(true));
  });

  it("keeps keyboard opening and Escape close available without losing the caret", async () => {
    mount(390, "rich");
    selectRich(9);
    clickRichHighlight();
    act(() => screen.getByTestId("comments-toggle").focus());
    await userEvent.keyboard("{Enter}");
    await expectPanel(390);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(rich!.hasFocus()).toBe(true));
    expect(rich!.state.selection.from).toBe(9);
    expectClosed();
  });

  it("opens a deliberate deep link on its resolved thread, not the default tab", async () => {
    session.comments.setResolved(threadId, true, user);
    window.history.replaceState(null, "", `/?thread=${threadId}`);
    mount(520, "rich");
    await expectPanel(520);
    expect(session.activeCommentId).toBe(threadId);
    expect(screen.getByRole("tab", { name: /Resolved/ })).toHaveAttribute("aria-selected", "true");
  });

  it("still starts a selected-text comment deliberately on narrow screens", async () => {
    mount(390, "rich");
    selectRich(3, 12);
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    await screen.findByTestId("comments-panel");
    expect(session.pendingComment).toEqual({ from: 2, to: 11 });
    expect(screen.getByTestId("sheet")).toBeInTheDocument();
  });

  it("restores the live rich selection after a collaborative edit while Comments is open", async () => {
    mount(520, "rich");
    selectRich(4, 10);
    await userEvent.click(screen.getByTestId("comments-toggle"));
    await expectPanel(520);
    act(() => session.ydoc.transact(() => session.ytext.insert(0, "Remote "), "remote-test"));
    await waitFor(() => expect(rich!.state.doc.textContent).toContain("Remote A commented"));
    const mappedSelection = rich!.state.selection.toJSON();
    expect(rich!.state.selection.from).toBe(11);
    expect(rich!.state.selection.to).toBe(17);
    await userEvent.click(screen.getByRole("button", { name: "Close comments" }));
    await waitFor(() => expect(rich!.hasFocus()).toBe(true));
    expect(rich!.state.selection.toJSON()).toEqual(mappedSelection);
    expect(session.ytext.toString()).toBe("Remote " + TEXT);
  });

  it("keeps suggestion clicks non-obstructing but explicitly reveals the intended suggestion", async () => {
    const { container } = mount(768, "code");
    const view = await sourceEditorReady(container);
    act(() => session.suggestions.applyEdit({ from: 4, to: 4, insert: "proposed" }, user));
    const suggestion = session.suggestions.list()[0];
    const suggestionId = suggestion.id;
    act(() => {
      view.focus();
      codeHighlight!("suggest-insert", suggestionId, suggestion.from);
    });
    expectClosed();
    expect(view.hasFocus).toBe(true);
    expect(session.activeSuggestionId).toBe(suggestionId);
    await userEvent.click(screen.getByTestId("comments-toggle"));
    await screen.findByTestId("comments-panel");
    expect(screen.getByRole("tab", { name: /Suggestions/ })).toHaveAttribute("aria-selected", "true");
  });

  it("does not let a background result open a narrow panel or leave a stale landing tab", async () => {
    const request: AgentRequestMirror = {
      id: "synthetic-request", status: "claimed", mode: "comment", instruction: "Review",
      claimedBy: "Synthetic agent", result: null, userId: user.id, updatedAt: 1,
    };
    mount(520, "rich");
    selectRich();
    act(() => session.meta.set("agentRequests", { [request.id]: request }));
    act(() => session.meta.set("agentRequests", { [request.id]: { ...request, status: "done", result: { suggestions: 1, comments: 0 }, updatedAt: 2 } }));
    expectClosed();
    expect(rich!.hasFocus()).toBe(true);
    clickRichHighlight();
    await userEvent.click(screen.getByTestId("comments-toggle"));
    await expectPanel(520);
    expect(screen.getByRole("tab", { name: /Open/ })).toHaveAttribute("aria-selected", "true");
  });

  it.each([
    { anchor: 12, head: 5, remote: false },
    { anchor: 5, head: 12, remote: false },
    { anchor: 12, head: 5, remote: true },
  ])("returns a hidden source selection ($anchor to $head, remote edit: $remote) to the same passage in preview after narrowing", async ({ anchor, head, remote }) => {
    const { container } = mount(1280);
    const view = await sourceEditorReady(container);
    act(() => {
      view.dispatch({ selection: { anchor, head } });
      view.focus();
      codeHighlight!("comment", threadId, view.state.selection.main.head);
    });
    await expectPanel(1280);
    fireEvent.pointerDown(screen.getByTestId("comments-panel"));
    viewport(390);
    await expectPanel(390);
    expect(session.activeSurface).toBe("rich");
    if (remote) {
      act(() => session.ydoc.transact(() => session.ytext.insert(0, "Remote "), "remote-test"));
      await waitFor(() => expect(rich!.state.doc.textContent).toContain("Remote A commented"));
    }
    await userEvent.click(screen.getByRole("button", { name: "Close comments" }));
    await waitFor(() => expect(rich!.hasFocus()).toBe(true));
    const map = session.binding.getSourceMap();
    expect(map.pmToSrc(rich!.state.selection.anchor)).toBe(anchor + (remote ? 7 : 0));
    expect(map.pmToSrc(rich!.state.selection.head)).toBe(head + (remote ? 7 : 0));
    expect(session.ytext.toString()).toBe((remote ? "Remote " : "") + TEXT);
  });

  it("does not activate a thread for ordinary text or native non-click gestures", () => {
    mount(1280, "rich");
    const activate = vi.spyOn(session, "setActiveComment");
    selectRich(5, 9);
    const paragraph = rich!.dom.querySelectorAll("p")[1];
    const event = new MouseEvent("click");
    Object.defineProperty(event, "target", { value: paragraph });
    act(() => rich!.someProp("handleClick", (handler) => handler(rich!, 40, event)));
    fireEvent.doubleClick(rich!.dom);
    fireEvent.contextMenu(rich!.dom);
    expect(activate).not.toHaveBeenCalled();
    expect(session.activeCommentId).toBeNull();
    expectClosed();
  });
});
