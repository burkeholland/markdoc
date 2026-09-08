// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import type { CollabSession, Surface } from "@/editor/collab/session";
import type { RichEditorHandlers } from "@/editor/prosemirror/setup";
import type { RichPaneProps } from "./rich-pane";

interface MockState {
  session: CollabSession;
  handlers: RichEditorHandlers;
}

interface MockView {
  dom: HTMLDivElement;
  state: MockState;
  isDestroyed: boolean;
  nodeCanEdit: () => boolean;
  initialNodeEditable: boolean;
}

const instrumentation = vi.hoisted(() => ({
  states: [] as MockState[],
  views: [] as MockView[],
  destroyed: [] as MockView[],
  editable: [] as Array<{ view: MockView; canEdit: boolean }>,
  highlights: [] as MockView[],
}));

vi.mock("prosemirror-view", () => ({
  EditorView: class {
    dom: HTMLDivElement;
    state: MockState;
    isDestroyed = false;
    nodeCanEdit: () => boolean;
    initialNodeEditable: boolean;

    constructor(host: HTMLElement, options: { state: MockState; nodeViews: { __canEdit: () => boolean } }) {
      this.state = options.state;
      this.nodeCanEdit = options.nodeViews.__canEdit;
      this.initialNodeEditable = this.nodeCanEdit();
      this.dom = document.createElement("div");
      this.dom.dataset.session = (options.state.session as unknown as { id: string }).id;
      host.append(this.dom);
      instrumentation.views.push(this);
    }

    destroy() {
      if (this.isDestroyed) throw new Error("View destroyed twice");
      this.isDestroyed = true;
      this.dom.remove();
      instrumentation.destroyed.push(this);
    }
  },
}));

vi.mock("@/editor/prosemirror/setup", () => ({
  createRichEditorState: (session: CollabSession, handlers: RichEditorHandlers) => {
    const state = { session, handlers };
    instrumentation.states.push(state);
    return state;
  },
  setEditable: (view: MockView, canEdit: boolean) => {
    instrumentation.editable.push({ view, canEdit });
  },
}));

vi.mock("@/editor/prosemirror/nodeviews", () => ({
  createNodeViews: (canEdit: () => boolean) => ({ __canEdit: canEdit }),
}));

vi.mock("@/editor/prosemirror/highlights", () => ({
  refreshRichHighlights: (view: MockView) => {
    instrumentation.highlights.push(view);
  },
}));

vi.mock("./use-session", () => ({
  useSessionValue: <T,>(session: CollabSession, select: (session: CollabSession) => T) => select(session),
}));

import { RichPane } from "./rich-pane";

interface MutableSession {
  id: string;
  canEdit: boolean;
  activeSurface: Surface;
  localCursor: { code: number; rich: number };
  setActiveSurface: (surface: Surface) => void;
  bindContentComposition: (target: HTMLElement) => () => void;
}

interface SessionFixture {
  session: CollabSession;
  mutable: MutableSession;
  activeBindings: Set<HTMLElement>;
  bound: HTMLElement[];
  unbound: HTMLElement[];
  activeSurfaces: Surface[];
}

interface PaneCalls {
  ready: Array<MockView | null>;
  selection: Array<[number, number]>;
  highlights: Array<[string, string | null, number | undefined]>;
  links: number;
  comments: number;
  uploads: File[];
  imageErrors: string[];
  notices: string[];
  drops: Array<[File, number]>;
}

interface PaneFixture {
  props: Omit<RichPaneProps, "session" | "hidden">;
  calls: PaneCalls;
}

function sessionFixture(id: string, canEdit = true, codeCursor = 10): SessionFixture {
  const activeBindings = new Set<HTMLElement>();
  const bound: HTMLElement[] = [];
  const unbound: HTMLElement[] = [];
  const activeSurfaces: Surface[] = [];
  const mutable: MutableSession = {
    id,
    canEdit,
    activeSurface: "code",
    localCursor: { code: codeCursor, rich: 0 },
    setActiveSurface(surface) {
      activeSurfaces.push(surface);
      mutable.activeSurface = surface;
    },
    bindContentComposition(target) {
      bound.push(target);
      activeBindings.add(target);
      let active = true;
      return () => {
        if (!active) throw new Error("Composition target unbound twice");
        active = false;
        activeBindings.delete(target);
        unbound.push(target);
      };
    },
  };
  return {
    session: mutable as unknown as CollabSession,
    mutable,
    activeBindings,
    bound,
    unbound,
    activeSurfaces,
  };
}

function paneFixture(label: string): PaneFixture {
  const calls: PaneCalls = {
    ready: [],
    selection: [],
    highlights: [],
    links: 0,
    comments: 0,
    uploads: [],
    imageErrors: [],
    notices: [],
    drops: [],
  };
  return {
    calls,
    props: {
      onReady: (view) => calls.ready.push(view as unknown as MockView | null),
      onSelection: (head, anchor) => calls.selection.push([head, anchor]),
      onHighlightClick: (kind, id, sourcePosition) => calls.highlights.push([kind, id, sourcePosition]),
      onLinkShortcut: () => {
        calls.links++;
      },
      onCommentShortcut: () => {
        calls.comments++;
      },
      uploadImage: async (file) => {
        calls.uploads.push(file);
        return { url: `/${label}/${file.name}` };
      },
      onImageError: (message) => calls.imageErrors.push(message),
      onNotice: (message) => calls.notices.push(message),
      onMarkdownFileDrop: (file, pos) => calls.drops.push([file, pos]),
    },
  };
}

function Boundary({
  current,
  pane,
  present = true,
  hidden = false,
  boundary = 0,
  onBoundary,
}: {
  current: SessionFixture;
  pane: PaneFixture;
  present?: boolean;
  hidden?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <RichPane session={current.session} {...pane.props} hidden={hidden} /> : null;
}

function viewFor(session: CollabSession): MockView {
  const view = instrumentation.views.find((candidate) => candidate.state.session === session);
  if (!view) throw new Error("Missing view for session");
  return view;
}

function handlersFor(session: CollabSession): RichEditorHandlers {
  const state = instrumentation.states.find((candidate) => candidate.session === session);
  if (!state) throw new Error("Missing handlers for session");
  return state.handlers;
}

function liveViews() {
  return instrumentation.views.filter((view) => !view.isDestroyed);
}

function invokeEditorHandlers(handlers: RichEditorHandlers, view: MockView, label: string) {
  const image = new File([label], `${label}.png`, { type: "image/png" });
  const markdown = new File([`# ${label}`], `${label}.md`, { type: "text/markdown" });
  const focusSource = handlers.getFocusSource?.();
  const nodeEditable = view.nodeCanEdit();
  handlers.onFocus?.();
  handlers.onSelection?.(12, 4);
  handlers.onLinkShortcut?.();
  handlers.onCommentShortcut?.();
  handlers.onHighlightClick?.("comment", `${label}-highlight`, 7);
  handlers.onImageError?.(`${label} image error`);
  handlers.onNotice?.(`${label} notice`);
  handlers.onMarkdownFileDrop?.(markdown, 9);
  const upload = handlers.uploadImage?.(image);
  return {
    focusSource,
    nodeEditable,
    upload: upload?.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    ),
  };
}

function expectNoUserCalls(calls: PaneCalls) {
  expect(calls.selection).toEqual([]);
  expect(calls.highlights).toEqual([]);
  expect(calls.links).toBe(0);
  expect(calls.comments).toBe(0);
  expect(calls.uploads).toEqual([]);
  expect(calls.imageErrors).toEqual([]);
  expect(calls.notices).toEqual([]);
  expect(calls.drops).toEqual([]);
}

function testWindow() {
  return window as unknown as { __markdocRichView?: MockView };
}

beforeEach(() => {
  instrumentation.states.length = 0;
  instrumentation.views.length = 0;
  instrumentation.destroyed.length = 0;
  instrumentation.editable.length = 0;
  instrumentation.highlights.length = 0;
  delete testWindow().__markdocRichView;
});

afterEach(() => {
  delete testWindow().__markdocRichView;
  document.body.replaceChildren();
});

describe("RichPane exact view visits", () => {
  it.each(["retired-before-current", "current-before-retired"] as const)(
    "retires A before the replacement layout boundary and rejects callbacks %s",
    async (order) => {
      const a = sessionFixture("A", true, 21);
      const b = sessionFixture("B", true, 34);
      const paneA = paneFixture("A");
      const paneB = paneFixture("B");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        act(() => root.render(<Boundary current={a} pane={paneA} />));
        const viewA = viewFor(a.session);
        const handlersA = handlersFor(a.session);
        expect(paneA.calls.ready).toEqual([viewA]);
        expect(viewA.initialNodeEditable).toBe(true);
        expect(a.activeBindings).toEqual(new Set([viewA.dom]));
        expect(testWindow().__markdocRichView).toBe(viewA);

        let staleInvocation: ReturnType<typeof invokeEditorHandlers> | undefined;
        let currentInvocation: ReturnType<typeof invokeEditorHandlers> | undefined;
        let boundaryLiveViews: MockView[] = [];
        act(() => {
          root.render(
            <Boundary
              current={b}
              pane={paneB}
              boundary={1}
              onBoundary={() => {
                const viewB = viewFor(b.session);
                expect(viewB.initialNodeEditable).toBe(true);
                const handlersB = handlersFor(b.session);
                const invokeRetired = () => {
                  staleInvocation = invokeEditorHandlers(handlersA, viewA, "retired");
                };
                const invokeCurrent = () => {
                  currentInvocation = invokeEditorHandlers(handlersB, viewB, "current");
                };
                if (order === "retired-before-current") {
                  invokeRetired();
                  invokeCurrent();
                } else {
                  invokeCurrent();
                  invokeRetired();
                }
                boundaryLiveViews = liveViews();
              }}
            />,
          );
        });

        const viewB = viewFor(b.session);
        expect(staleInvocation?.focusSource).toBeNull();
        expect(staleInvocation?.nodeEditable).toBe(false);
        await expect(staleInvocation?.upload).resolves.toMatchObject({
          status: "rejected",
          reason: expect.objectContaining({ message: "Rich editor view is no longer current" }),
        });
        expect(currentInvocation?.focusSource).toBe(34);
        expect(currentInvocation?.nodeEditable).toBe(true);
        await expect(currentInvocation?.upload).resolves.toEqual({
          status: "fulfilled",
          value: { url: "/B/current.png" },
        });

        expect(boundaryLiveViews).toEqual([viewB]);
        expect(instrumentation.destroyed).toEqual([viewA]);
        expect(a.bound).toEqual([viewA.dom]);
        expect(a.unbound).toEqual([viewA.dom]);
        expect(a.activeBindings.size).toBe(0);
        expect(b.bound).toEqual([viewB.dom]);
        expect(b.unbound).toEqual([]);
        expect(b.activeBindings).toEqual(new Set([viewB.dom]));
        expect(paneA.calls.ready).toEqual([viewA, null]);
        expect(paneB.calls.ready).toEqual([viewB]);
        expect(testWindow().__markdocRichView).toBe(viewB);
        expectNoUserCalls(paneA.calls);
        expect(a.activeSurfaces).toEqual([]);
        expect(b.activeSurfaces).toEqual(["rich"]);
        expect(paneB.calls.selection).toEqual([[12, 4]]);
        expect(paneB.calls.highlights).toEqual([["comment", "current-highlight", 7]]);
        expect(paneB.calls.links).toBe(1);
        expect(paneB.calls.comments).toBe(1);
        expect(paneB.calls.uploads).toHaveLength(1);
        expect(paneB.calls.imageErrors).toEqual(["current image error"]);
        expect(paneB.calls.notices).toEqual(["current notice"]);
        expect(paneB.calls.drops).toHaveLength(1);
        expect(instrumentation.editable.filter(({ view }) => view === viewA)).toEqual([{ view: viewA, canEdit: true }]);
        expect(instrumentation.editable.filter(({ view }) => view === viewB)).toEqual([{ view: viewB, canEdit: true }]);
        expect(instrumentation.highlights.filter((view) => view === viewA)).toHaveLength(1);
        expect(instrumentation.highlights.filter((view) => view === viewB)).toHaveLength(1);

        b.mutable.canEdit = false;
        b.mutable.activeSurface = "code";
        b.mutable.localCursor.code = 55;
        let hiddenFocus: number | null | undefined;
        let hiddenNodeEditable = true;
        const selectionsBeforeHidden = paneB.calls.selection.length;
        act(() => {
          root.render(
            <Boundary
              current={b}
              pane={paneB}
              hidden
              boundary={2}
              onBoundary={() => {
                hiddenFocus = handlersFor(b.session).getFocusSource?.();
                hiddenNodeEditable = viewB.nodeCanEdit();
                handlersFor(b.session).onSelection?.(20, 11);
              }}
            />,
          );
        });
        expect(host.querySelector("[data-testid='rich-pane']")).toHaveClass("hidden");
        expect(hiddenFocus).toBe(55);
        expect(hiddenNodeEditable).toBe(false);
        expect(paneB.calls.selection.slice(selectionsBeforeHidden)).toEqual([[20, 11]]);
        expect(instrumentation.editable.filter(({ view }) => view === viewB)).toEqual([
          { view: viewB, canEdit: true },
          { view: viewB, canEdit: false },
        ]);
        expect(instrumentation.highlights.filter((view) => view === viewB)).toHaveLength(2);

        b.mutable.canEdit = true;
        b.mutable.activeSurface = "rich";
        let visibleFocus: number | null | undefined = 1;
        let visibleNodeEditable = false;
        const linksBeforeVisible = paneB.calls.links;
        act(() => {
          root.render(
            <Boundary
              current={b}
              pane={paneB}
              boundary={3}
              onBoundary={() => {
                visibleFocus = handlersFor(b.session).getFocusSource?.();
                visibleNodeEditable = viewB.nodeCanEdit();
                handlersFor(b.session).onLinkShortcut?.();
              }}
            />,
          );
        });
        expect(host.querySelector("[data-testid='rich-pane']")).not.toHaveClass("hidden");
        expect(visibleFocus).toBeNull();
        expect(visibleNodeEditable).toBe(true);
        expect(paneB.calls.links - linksBeforeVisible).toBe(1);
        expect(liveViews()).toEqual([viewB]);
        expect(testWindow().__markdocRichView).toBe(viewB);
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    },
  );

  it("retires the exact view before the removal layout boundary", async () => {
    const session = sessionFixture("removed", true, 18);
    const pane = paneFixture("removed");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      act(() => root.render(<Boundary current={session} pane={pane} />));
      const view = viewFor(session.session);
      const handlers = handlersFor(session.session);
      let staleInvocation: ReturnType<typeof invokeEditorHandlers> | undefined;
      let boundaryLiveViews: MockView[] = [];
      act(() => {
        root.render(
          <Boundary
            current={session}
            pane={pane}
            present={false}
            boundary={1}
            onBoundary={() => {
              staleInvocation = invokeEditorHandlers(handlers, view, "removed");
              boundaryLiveViews = liveViews();
            }}
          />,
        );
      });

      expect(boundaryLiveViews).toEqual([]);
      expect(staleInvocation?.focusSource).toBeNull();
      expect(staleInvocation?.nodeEditable).toBe(false);
      await expect(staleInvocation?.upload).resolves.toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ message: "Rich editor view is no longer current" }),
      });
      expect(instrumentation.destroyed).toEqual([view]);
      expect(session.bound).toEqual([view.dom]);
      expect(session.unbound).toEqual([view.dom]);
      expect(session.activeBindings.size).toBe(0);
      expect(pane.calls.ready).toEqual([view, null]);
      expect(testWindow().__markdocRichView).toBeUndefined();
      expectNoUserCalls(pane.calls);
      expect(session.activeSurfaces).toEqual([]);
      expect(instrumentation.editable).toEqual([{ view, canEdit: true }]);
      expect(instrumentation.highlights).toEqual([view]);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("publishes replacement handlers to an existing view by the parent layout boundary", async () => {
    const session = sessionFixture("handlers", true, 27);
    const initialPane = paneFixture("initial");
    const currentPane = paneFixture("current");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      act(() => root.render(<Boundary current={session} pane={initialPane} />));
      const view = viewFor(session.session);
      const handlers = handlersFor(session.session);
      let invocation: ReturnType<typeof invokeEditorHandlers> | undefined;
      act(() => {
        root.render(
          <Boundary
            current={session}
            pane={currentPane}
            boundary={1}
            onBoundary={() => {
              invocation = invokeEditorHandlers(handlers, view, "fresh");
            }}
          />,
        );
      });

      await expect(invocation?.upload).resolves.toEqual({
        status: "fulfilled",
        value: { url: "/current/fresh.png" },
      });
      expectNoUserCalls(initialPane.calls);
      expect(currentPane.calls.selection).toEqual([[12, 4]]);
      expect(currentPane.calls.highlights).toEqual([["comment", "fresh-highlight", 7]]);
      expect(currentPane.calls.links).toBe(1);
      expect(currentPane.calls.comments).toBe(1);
      expect(currentPane.calls.uploads).toHaveLength(1);
      expect(currentPane.calls.imageErrors).toEqual(["fresh image error"]);
      expect(currentPane.calls.notices).toEqual(["fresh notice"]);
      expect(currentPane.calls.drops).toHaveLength(1);
      expect(session.activeSurfaces).toEqual(["rich"]);
      expect(instrumentation.views).toEqual([view]);
      expect(instrumentation.destroyed).toEqual([]);
      expect(initialPane.calls.ready).toEqual([view]);
      expect(currentPane.calls.ready).toEqual([]);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
