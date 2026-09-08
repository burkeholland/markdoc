// @vitest-environment jsdom

import { useEffect, useLayoutEffect } from "react";
import { act } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CollabSession } from "@/editor/collab/session";
import type { SourceHighlight } from "@/editor/codemirror/highlights";
import type { CodeEditorHandlers, CodeEditorSetup } from "@/editor/codemirror/setup";

const mocks = vi.hoisted(() => ({
  codeApi: { stable: true },
  collectHighlights: vi.fn((session: object, focus: { from: number; to: number } | null) => {
    const highlights = mocks.highlights.get(session) ?? [];
    return focus ? [...highlights, { ...focus, kind: "focus" }] : [...highlights];
  }),
  effectOf: vi.fn((highlights: unknown[]) => ({ kind: "highlights", highlights })),
  highlights: new Map<object, unknown[]>(),
  setups: [] as unknown[],
  stateCreate: vi.fn((config: unknown) => config),
  views: [] as unknown[],
}));

vi.mock("@codemirror/state", () => ({
  EditorState: { create: mocks.stateCreate },
}));

vi.mock("@codemirror/view", () => ({
  EditorView: class {
    contentDOM = document.createElement("div");
    destroyed = false;
    dispatch = vi.fn();
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
    parent: HTMLElement;
    state: { doc: { length: number; lineAt: (position: number) => { from: number } } };

    constructor({ state, parent }: { state: { doc: string }; parent: HTMLElement }) {
      this.parent = parent;
      this.state = {
        doc: {
          length: state.doc.length,
          lineAt: (position) => ({ from: Math.max(0, position - 2) }),
        },
      };
      parent.append(this.contentDOM);
      mocks.views.push(this);
    }
  },
}));

vi.mock("@/editor/codemirror/api", () => ({
  createCodeApi: () => mocks.codeApi,
}));

vi.mock("@/editor/codemirror/setup", () => ({
  createCodeEditorSetup: vi.fn((session: CollabSession, handlers: CodeEditorHandlers) => {
    const setup = {
      session,
      handlers,
      extensions: [],
      setMode: vi.fn(),
      setLineWrapping: vi.fn(),
    };
    mocks.setups.push(setup);
    return setup;
  }),
}));

vi.mock("@/editor/codemirror/highlights", () => ({
  setHighlights: { of: mocks.effectOf },
}));

vi.mock("@/editor/prosemirror/highlights", () => ({
  collectHighlights: mocks.collectHighlights,
}));

import { CodePane, type CodePaneProps } from "./code-pane";

interface FakeView {
  contentDOM: HTMLElement;
  destroyed: boolean;
  dispatch: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  parent: HTMLElement;
}

interface CapturedSetup extends CodeEditorSetup {
  handlers: CodeEditorHandlers;
  session: CollabSession;
  setMode: Mock<CodeEditorSetup["setMode"]>;
  setLineWrapping: Mock<CodeEditorSetup["setLineWrapping"]>;
}

interface Subscription {
  listener: () => void;
  unsubscribes: number;
}

interface CompositionBinding {
  element: HTMLElement;
  unbinds: number;
}

interface SessionControl {
  session: CollabSession;
  subscriptions: Subscription[];
  compositionBindings: CompositionBinding[];
  subscribe: ReturnType<typeof vi.fn>;
  bindContentComposition: ReturnType<typeof vi.fn>;
  setActiveSurface: ReturnType<typeof vi.fn>;
  activeSubscriptions: () => number;
  activeBindings: () => number;
  setHighlights: (highlights: SourceHighlight[]) => void;
  setViewState: (state: { canEdit: boolean; mode: "editing" | "suggesting"; activeSurface: "code" | "rich"; richCursor: number | null }) => void;
}

interface HandlerSet {
  onReady: Mock<CodePaneProps["onReady"]>;
  onSelection: Mock<CodePaneProps["onSelection"]>;
  onHighlightClick: Mock<CodePaneProps["onHighlightClick"]>;
  uploadImage: Mock<NonNullable<CodePaneProps["uploadImage"]>>;
  onImageError: Mock<NonNullable<CodePaneProps["onImageError"]>>;
  onNotice: Mock<NonNullable<CodePaneProps["onNotice"]>>;
  onMarkdownFileDrop: Mock<NonNullable<CodePaneProps["onMarkdownFileDrop"]>>;
}

const equalHighlights: SourceHighlight[] = [
  { from: 1, to: 4, kind: "comment", id: "shared", active: true },
];

function makeSession(id: string): SessionControl {
  const subscriptions: Subscription[] = [];
  const compositionBindings: CompositionBinding[] = [];
  const state = {
    docId: id,
    ytext: { toString: () => `# ${id}` },
    canEdit: true,
    mode: "editing" as "editing" | "suggesting",
    activeSurface: "code" as "code" | "rich",
    localCursor: { rich: null as number | null },
  };
  const session = state as unknown as CollabSession;
  const subscribe = vi.fn((listener: () => void) => {
    const subscription = { listener, unsubscribes: 0 };
    subscriptions.push(subscription);
    return () => {
      subscription.unsubscribes++;
    };
  });
  const bindContentComposition = vi.fn((element: HTMLElement) => {
    const binding = { element, unbinds: 0 };
    compositionBindings.push(binding);
    return () => {
      binding.unbinds++;
    };
  });
  const setActiveSurface = vi.fn((surface: "code" | "rich") => {
    session.activeSurface = surface;
  });
  Object.assign(session, { subscribe, bindContentComposition, setActiveSurface });
  mocks.highlights.set(session, equalHighlights);
  return {
    session,
    subscriptions,
    compositionBindings,
    subscribe,
    bindContentComposition,
    setActiveSurface,
    activeSubscriptions: () => subscriptions.filter(({ unsubscribes }) => unsubscribes === 0).length,
    activeBindings: () => compositionBindings.filter(({ unbinds }) => unbinds === 0).length,
    setHighlights: (highlights) => mocks.highlights.set(session, highlights),
    setViewState: ({ canEdit, mode, activeSurface, richCursor }) => {
      state.canEdit = canEdit;
      state.mode = mode;
      state.activeSurface = activeSurface;
      state.localCursor.rich = richCursor;
    },
  };
}

function makeHandlers(label: string): HandlerSet {
  return {
    onReady: vi.fn<CodePaneProps["onReady"]>(),
    onSelection: vi.fn<CodePaneProps["onSelection"]>(),
    onHighlightClick: vi.fn<CodePaneProps["onHighlightClick"]>(),
    uploadImage: vi.fn<NonNullable<CodePaneProps["uploadImage"]>>(async () => ({ url: `https://example.test/${label}.png` })),
    onImageError: vi.fn<NonNullable<CodePaneProps["onImageError"]>>(),
    onNotice: vi.fn<NonNullable<CodePaneProps["onNotice"]>>(),
    onMarkdownFileDrop: vi.fn<NonNullable<CodePaneProps["onMarkdownFileDrop"]>>(),
  };
}

function paneProps(session: CollabSession, handlers: HandlerSet, lineWrapping: boolean): CodePaneProps {
  return { session, ...handlers, lineWrapping };
}

function Boundary({
  pane,
  present = true,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  pane: CodePaneProps;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => onPassiveCleanup, [onPassiveCleanup, pane.session, present]);
  return present ? <CodePane {...pane} /> : null;
}

function viewAt(index: number): FakeView {
  return mocks.views[index] as FakeView;
}

function setupAt(index: number): CapturedSetup {
  return mocks.setups[index] as CapturedSetup;
}

function invokeEditorHandlers(setup: CapturedSetup) {
  setup.handlers.onFocus?.();
  setup.handlers.onSelection?.(7, 3);
  setup.handlers.onHighlightClick?.("comment", "shared", 2);
  const upload = setup.handlers.uploadImage?.(new File(["image"], "image.png", { type: "image/png" }));
  if (upload) void upload.then(() => undefined, () => undefined);
  setup.handlers.onImageError?.("upload failed");
  setup.handlers.onNotice?.("notice");
  setup.handlers.onMarkdownFileDrop?.(new File(["# Drop"], "drop.md", { type: "text/markdown" }), 5);
}

function expectNoHandlerCalls(handlers: HandlerSet) {
  expect(handlers.onSelection).not.toHaveBeenCalled();
  expect(handlers.onHighlightClick).not.toHaveBeenCalled();
  expect(handlers.uploadImage).not.toHaveBeenCalled();
  expect(handlers.onImageError).not.toHaveBeenCalled();
  expect(handlers.onNotice).not.toHaveBeenCalled();
  expect(handlers.onMarkdownFileDrop).not.toHaveBeenCalled();
}

afterEach(() => {
  document.body.replaceChildren();
  mocks.collectHighlights.mockClear();
  mocks.effectOf.mockClear();
  mocks.highlights.clear();
  mocks.setups.length = 0;
  mocks.stateCreate.mockClear();
  mocks.views.length = 0;
  vi.clearAllMocks();
});

describe("CodePane visit authority", () => {
  it.each(["A-before-B", "B-before-A"] as const)(
    "retires A before replacement layout and keeps B authoritative with %s callbacks",
    (order) => {
      const a = makeSession("a");
      const b = makeSession("b");
      const aHandlers = makeHandlers("a");
      const bInitialHandlers = makeHandlers("b-initial");
      const bCurrentHandlers = makeHandlers("b-current");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      let passiveCleanups = 0;
      const passiveCleanup = () => {
        passiveCleanups++;
      };

      try {
        act(() => root.render(<Boundary pane={paneProps(a.session, aHandlers, true)} onPassiveCleanup={passiveCleanup} />));
        const aView = viewAt(0);
        const aSetup = setupAt(0);
        const aSubscription = a.subscriptions[0];
        expect(a.activeSubscriptions()).toBe(1);
        expect(a.activeBindings()).toBe(1);
        expect(aHandlers.onReady.mock.calls).toEqual([[aView, mocks.codeApi]]);
        expect(aSetup.setMode).toHaveBeenCalledWith(aView, true, false);
        expect(aSetup.setLineWrapping).toHaveBeenCalledWith(aView, true);
        expect(aView.dispatch).toHaveBeenCalledTimes(1);
        expect(mocks.stateCreate).toHaveBeenNthCalledWith(1, {
          doc: "# a",
          extensions: aSetup.extensions,
        });

        act(() => {
          root.render(
            <Boundary
              pane={paneProps(b.session, bInitialHandlers, true)}
              boundary={1}
              onPassiveCleanup={passiveCleanup}
              onBoundary={() => {
                const bView = viewAt(1);
                expect(passiveCleanups).toBe(0);
                expect(a.activeSubscriptions()).toBe(0);
                expect(a.activeBindings()).toBe(0);
                expect(aSubscription.unsubscribes).toBe(1);
                expect(a.compositionBindings[0].unbinds).toBe(1);
                expect(aView.destroyed).toBe(true);
                expect(aView.destroy).toHaveBeenCalledOnce();
                expect(aHandlers.onReady.mock.calls).toEqual([
                  [aView, mocks.codeApi],
                  [null, null],
                ]);
                expect(b.activeSubscriptions()).toBe(1);
                expect(b.activeBindings()).toBe(1);
                expect(bView.destroyed).toBe(false);
                expect(bHandlersNullReadyCalls(bInitialHandlers)).toBe(0);
                expect(bView.dispatch).toHaveBeenCalledTimes(1);
                expect(aView.dispatch).toHaveBeenCalledTimes(1);
                expect(mocks.views.filter((candidate) => !(candidate as FakeView).destroyed)).toEqual([bView]);
              }}
            />,
          );
        });
        expect(passiveCleanups).toBe(1);

        const bView = viewAt(1);
        const bSetup = setupAt(1);
        const bSubscription = b.subscriptions[0];
        b.setViewState({ canEdit: false, mode: "suggesting", activeSurface: "rich", richCursor: 8 });
        b.setHighlights([
          ...equalHighlights,
          { from: 5, to: 7, kind: "suggest-insert", id: "new" },
        ]);

        act(() => {
          root.render(
            <Boundary
              pane={paneProps(b.session, bCurrentHandlers, false)}
              boundary={2}
              onPassiveCleanup={passiveCleanup}
              onBoundary={() => {
                expect(bSetup.setLineWrapping).toHaveBeenLastCalledWith(bView, false);
                const invokeA = () => {
                  aSubscription.listener();
                  invokeEditorHandlers(aSetup);
                };
                const invokeB = () => {
                  bSubscription.listener();
                  bSubscription.listener();
                  invokeEditorHandlers(bSetup);
                };
                if (order === "A-before-B") {
                  invokeA();
                  invokeB();
                } else {
                  invokeB();
                  invokeA();
                }
              }}
            />,
          );
        });

        expect(a.activeSubscriptions()).toBe(0);
        expect(a.activeBindings()).toBe(0);
        expect(aView.destroy).toHaveBeenCalledOnce();
        expect(aView.dispatch).toHaveBeenCalledTimes(1);
        expect(aSetup.setMode).toHaveBeenCalledTimes(1);
        expect(aSetup.setLineWrapping).toHaveBeenCalledTimes(1);
        expect(a.setActiveSurface).not.toHaveBeenCalled();
        expectNoHandlerCalls(aHandlers);

        expect(b.activeSubscriptions()).toBe(1);
        expect(b.activeBindings()).toBe(1);
        expect(b.subscribe).toHaveBeenCalledOnce();
        expect(b.bindContentComposition).toHaveBeenCalledWith(bView.contentDOM);
        expect(bView.destroy).not.toHaveBeenCalled();
        expect(bView.dispatch).toHaveBeenCalledTimes(2);
        expect(bView.dispatch.mock.calls[1][0]).toEqual({
          effects: {
            kind: "highlights",
            highlights: [
              ...equalHighlights,
              { from: 5, to: 7, kind: "suggest-insert", id: "new" },
              { from: 1, to: 1, kind: "focus" },
            ],
          },
        });
        expect(bSetup.setMode.mock.calls).toEqual([
          [bView, true, false],
          [bView, false, true],
        ]);
        expect(bSetup.setLineWrapping.mock.calls).toEqual([
          [bView, true],
          [bView, false],
        ]);
        expect(bInitialHandlers.onReady.mock.calls).toEqual([[bView, mocks.codeApi]]);
        expectNoHandlerCalls(bInitialHandlers);
        expect(bCurrentHandlers.onSelection).toHaveBeenCalledOnce();
        expect(bCurrentHandlers.onSelection).toHaveBeenCalledWith(7, 3);
        expect(bCurrentHandlers.onHighlightClick).toHaveBeenCalledOnce();
        expect(bCurrentHandlers.uploadImage).toHaveBeenCalledOnce();
        expect(bCurrentHandlers.onImageError).toHaveBeenCalledOnce();
        expect(bCurrentHandlers.onNotice).toHaveBeenCalledOnce();
        expect(bCurrentHandlers.onMarkdownFileDrop).toHaveBeenCalledOnce();
        expect(b.setActiveSurface).toHaveBeenCalledOnce();
        expect(b.setActiveSurface).toHaveBeenCalledWith("code");
        expect(mocks.collectHighlights.mock.calls.filter(([candidate]) => candidate === a.session)).toHaveLength(1);
        expect(mocks.collectHighlights.mock.calls.filter(([candidate]) => candidate === b.session)).toHaveLength(3);
        expect(mocks.stateCreate).toHaveBeenNthCalledWith(2, {
          doc: "# b",
          extensions: bSetup.extensions,
        });
      } finally {
        act(() => root.unmount());
      }

      const bView = viewAt(1);
      expect(b.activeSubscriptions()).toBe(0);
      expect(b.activeBindings()).toBe(0);
      expect(bView.destroy).toHaveBeenCalledOnce();
      expect(bInitialHandlers.onReady.mock.calls).toEqual([
        [bView, mocks.codeApi],
        [null, null],
      ]);
    },
  );

  it("retires the exact view before removal layout and leaves every captured callback inert", () => {
    const a = makeSession("removed");
    const handlers = makeHandlers("removed");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let passiveCleaned = false;

    try {
      act(() => root.render(<Boundary pane={paneProps(a.session, handlers, false)} onPassiveCleanup={() => {
        passiveCleaned = true;
      }} />));
      const view = viewAt(0);
      const setup = setupAt(0);
      const subscription = a.subscriptions[0];

      act(() => {
        root.render(
          <Boundary
            pane={paneProps(a.session, handlers, false)}
            present={false}
            boundary={1}
            onPassiveCleanup={() => {
              passiveCleaned = true;
            }}
            onBoundary={() => {
              expect(passiveCleaned).toBe(false);
              expect(a.activeSubscriptions()).toBe(0);
              expect(a.activeBindings()).toBe(0);
              expect(subscription.unsubscribes).toBe(1);
              expect(a.compositionBindings[0].unbinds).toBe(1);
              expect(view.destroyed).toBe(true);
              expect(view.destroy).toHaveBeenCalledOnce();
              expect(handlers.onReady.mock.calls).toEqual([
                [view, mocks.codeApi],
                [null, null],
              ]);
              subscription.listener();
              invokeEditorHandlers(setup);
            }}
          />,
        );
      });

      expect(passiveCleaned).toBe(true);
      expect(a.subscribe).toHaveBeenCalledOnce();
      expect(a.bindContentComposition).toHaveBeenCalledOnce();
      expect(view.dispatch).toHaveBeenCalledTimes(1);
      expect(setup.setMode).toHaveBeenCalledTimes(1);
      expect(setup.setLineWrapping).toHaveBeenCalledTimes(1);
      expect(a.setActiveSurface).not.toHaveBeenCalled();
      expectNoHandlerCalls(handlers);
    } finally {
      act(() => root.unmount());
    }
  });
});

function bHandlersNullReadyCalls(handlers: HandlerSet): number {
  return handlers.onReady.mock.calls.filter(([view]) => view === null).length;
}
