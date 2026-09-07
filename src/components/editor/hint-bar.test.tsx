// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CollabSession } from "@/editor/collab/session";
import { HINTS_STORAGE_KEY, readHintsRecord } from "@/lib/hints";
import type { EditorActions } from "./actions";

const collaborators = vi.fn();
const tokens = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      documents: {
        ...actual.api.documents,
        collaborators: (...args: unknown[]) => collaborators(...args),
      },
      tokens: {
        ...actual.api.tokens,
        list: (...args: unknown[]) => tokens(...args),
      },
    },
  };
});

import { COLLAB_HINT_RETRY_MS, HintBar } from "./hint-bar";

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function collaboratorResult(count = 1, agentKnown = false) {
  return {
    owner: null,
    linkAccess: "private",
    collaborators: Array.from({ length: count }, (_, index) => ({ login: `person-${index}` })),
    agents: agentKnown
      ? [{ name: "Copilot", login: "person/Copilot", ownerLogin: "person", ownerName: "Person", present: false, collaboratorsMayAsk: true }]
      : [],
  };
}

function tokenResult(used = false) {
  return { tokens: used ? [{ lastUsedAt: "2026-09-07T15:00:00.000Z" }] : [{ lastUsedAt: null }] };
}

function fakeSession(docId: string, options: { people?: number; agentHere?: boolean; threads?: number } = {}) {
  const listeners = new Set<() => void>();
  return {
    docId,
    synced: true,
    authError: null,
    trashed: false,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    presence: () => [
      ...Array.from({ length: options.people ?? 0 }, () => ({ isLocal: false, isAgent: false })),
      ...(options.agentHere ? [{ isLocal: false, isAgent: true }] : []),
    ],
    comments: {
      list: () => Array.from({ length: options.threads ?? 0 }, (_, index) => ({ id: `thread-${index}` })),
    },
  } as unknown as CollabSession;
}

const actions = { focus: vi.fn() } as unknown as EditorActions;
const onShare = vi.fn();
const onComment = vi.fn();

function mount(session = fakeSession("doc-1")) {
  return render(<HintBar session={session} actions={actions} onShare={onShare} onComment={onComment} />);
}

function HintBoundary({
  session,
  present = true,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
  instance = "hint",
  editorActions = actions,
  share = onShare,
  comment = onComment,
}: {
  session: CollabSession;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
  instance?: string;
  editorActions?: EditorActions;
  share?: () => void;
  comment?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => () => onPassiveCleanup?.(), [boundary, onPassiveCleanup]);
  return present ? (
    <HintBar key={instance} session={session} actions={editorActions} onShare={share} onComment={comment} />
  ) : null;
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}

let visibility: DocumentVisibilityState;

const directRoots: { root: Root; host: HTMLDivElement }[] = [];

function reactHandler<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return handler as T;
}

type HintMouseHandler = (event: React.MouseEvent<HTMLButtonElement>) => void;

function hintMouseEvent(
  currentTarget: HTMLButtonElement,
  preventDefault = vi.fn(),
): React.MouseEvent<HTMLButtonElement> {
  return { currentTarget, preventDefault } as unknown as React.MouseEvent<HTMLButtonElement>;
}

function captureHintCallbacks() {
  const actionElement = screen.getByTestId("hint-action") as HTMLButtonElement;
  const dismissElement = screen.getByTestId("hint-dismiss") as HTMLButtonElement;
  const actionHandler = reactHandler<HintMouseHandler>(actionElement, "onClick");
  const actionMouseDownHandler = reactHandler<HintMouseHandler>(actionElement, "onMouseDown");
  const dismissHandler = reactHandler<HintMouseHandler>(dismissElement, "onClick");
  return {
    actionElement,
    dismissElement,
    actionHandler,
    actionMouseDownHandler,
    dismissHandler,
    action: (currentTarget = actionElement) =>
      actionHandler(hintMouseEvent(currentTarget)),
    actionMouseDown: (
      currentTarget = actionElement,
      preventDefault = vi.fn(),
    ) => actionMouseDownHandler(hintMouseEvent(currentTarget, preventDefault)),
    dismiss: (currentTarget = dismissElement) =>
      dismissHandler(hintMouseEvent(currentTarget)),
  };
}

function createHintRoot() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  directRoots.push({ root, host });
  return root;
}

async function renderHintRoot(root: Root, node: React.ReactNode) {
  await act(async () => {
    root.render(node);
    await Promise.resolve();
  });
  await flushPromises();
}

describe("HintBar collaborator discovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({
        matches: true,
        media: "",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    window.localStorage.clear();
    collaborators.mockReset();
    tokens.mockReset();
    collaborators.mockResolvedValue(collaboratorResult());
    tokens.mockResolvedValue(tokenResult());
    actions.focus = vi.fn();
    onShare.mockReset();
    onComment.mockReset();
  });

  afterEach(() => {
    for (const view of directRoots.splice(0)) {
      act(() => view.root.unmount());
      view.host.remove();
    }
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
    else Reflect.deleteProperty(window, "matchMedia");
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
  });

  it.each(["collaborators", "tokens"] as const)(
    "requests both sources, keeps a failed %s source unknown, and retries only that source",
    async (failedSource) => {
      if (failedSource === "collaborators") {
        collaborators.mockRejectedValueOnce(new Error("share unavailable")).mockResolvedValueOnce(collaboratorResult());
      } else {
        tokens.mockRejectedValueOnce(new Error("tokens unavailable")).mockResolvedValueOnce(tokenResult());
      }

      mount();
      expect(collaborators).toHaveBeenCalledOnce();
      expect(collaborators).toHaveBeenCalledWith("doc-1");
      expect(tokens).toHaveBeenCalledOnce();
      await flushPromises();

      expect(screen.queryByTestId("hint-bar")).not.toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(COLLAB_HINT_RETRY_MS - 1));
      expect(collaborators).toHaveBeenCalledTimes(1);
      expect(tokens).toHaveBeenCalledTimes(1);

      await act(() => vi.advanceTimersByTimeAsync(1));
      await flushPromises();
      expect(collaborators).toHaveBeenCalledTimes(failedSource === "collaborators" ? 2 : 1);
      expect(tokens).toHaveBeenCalledTimes(failedSource === "tokens" ? 2 : 1);
      expect(screen.getByTestId("hint-bar")).toHaveAttribute("data-hint", "collab-agent");
    },
  );

  it.each(["known collaborator agent", "used token"] as const)(
    "persists positive agent evidence from a %s and never shows the setup hint",
    async (source) => {
      collaborators.mockResolvedValue(collaboratorResult(1, source === "known collaborator agent"));
      tokens.mockResolvedValue(tokenResult(source === "used token"));

      mount();
      await flushPromises();

      expect(readHintsRecord(window.localStorage).agentSeen).toBe(true);
      expect(screen.queryByTestId("hint-bar")).not.toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(COLLAB_HINT_RETRY_MS * 2));
      expect(collaborators).toHaveBeenCalledOnce();
      expect(tokens).toHaveBeenCalledOnce();
    },
  );

  it("allows at most one request per source in flight across timer and visibility triggers", async () => {
    const shareRetry = deferred<ReturnType<typeof collaboratorResult>>();
    const tokenList = deferred<ReturnType<typeof tokenResult>>();
    collaborators.mockRejectedValueOnce(new Error("share unavailable")).mockReturnValueOnce(shareRetry.promise);
    tokens.mockReturnValue(tokenList.promise);

    mount();
    expect(collaborators).toHaveBeenCalledOnce();
    expect(tokens).toHaveBeenCalledOnce();
    await flushPromises();

    await act(() => vi.advanceTimersByTimeAsync(COLLAB_HINT_RETRY_MS));
    expect(collaborators).toHaveBeenCalledTimes(2);
    expect(tokens).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(COLLAB_HINT_RETRY_MS * 4));
    setVisibility("hidden");
    setVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(() => vi.advanceTimersByTimeAsync(COLLAB_HINT_RETRY_MS * 4));

    expect(collaborators).toHaveBeenCalledTimes(2);
    expect(tokens).toHaveBeenCalledOnce();
  });

  it("pauses failed-source retries while hidden and resumes each once on visibility return", async () => {
    const shareRetry = deferred<ReturnType<typeof collaboratorResult>>();
    const tokenRetry = deferred<ReturnType<typeof tokenResult>>();
    collaborators.mockRejectedValueOnce(new Error("share unavailable")).mockReturnValueOnce(shareRetry.promise);
    tokens.mockRejectedValueOnce(new Error("tokens unavailable")).mockReturnValueOnce(tokenRetry.promise);

    visibility = "hidden";
    mount();
    await act(() => vi.advanceTimersByTimeAsync(COLLAB_HINT_RETRY_MS * 2));
    expect(collaborators).not.toHaveBeenCalled();
    expect(tokens).not.toHaveBeenCalled();

    setVisibility("visible");
    expect(collaborators).toHaveBeenCalledOnce();
    expect(tokens).toHaveBeenCalledOnce();
    await flushPromises();
    setVisibility("hidden");
    await act(() => vi.advanceTimersByTimeAsync(COLLAB_HINT_RETRY_MS * 3));
    expect(collaborators).toHaveBeenCalledOnce();
    expect(tokens).toHaveBeenCalledOnce();

    setVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(collaborators).toHaveBeenCalledTimes(2);
    expect(tokens).toHaveBeenCalledTimes(2);
  });

  it("stops discovery after the relevant hint is dismissed", async () => {
    window.localStorage.setItem(HINTS_STORAGE_KEY, JSON.stringify({ dismissed: ["mention-copilot"], agentSeen: false }));
    mount();
    await flushPromises();
    expect(screen.getByTestId("hint-bar")).toHaveAttribute("data-hint", "collab-agent");

    fireEvent.click(screen.getByTestId("hint-dismiss"));
    expect(screen.queryByTestId("hint-bar")).not.toBeInTheDocument();
    expect(readHintsRecord(window.localStorage).dismissed).toEqual(["collab-agent", "mention-copilot"]);

    setVisibility("hidden");
    setVisibility("visible");
    await act(() => vi.advanceTimersByTimeAsync(COLLAB_HINT_RETRY_MS * 2));
    expect(collaborators).toHaveBeenCalledOnce();
    expect(tokens).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires both old source owners at the replacement layout boundary before admitting one request per source", async () => {
    const oldShare = deferred<ReturnType<typeof collaboratorResult>>();
    const oldTokens = deferred<ReturnType<typeof tokenResult>>();
    const newShare = deferred<ReturnType<typeof collaboratorResult>>();
    const newTokens = deferred<ReturnType<typeof tokenResult>>();
    collaborators.mockReturnValueOnce(oldShare.promise).mockReturnValueOnce(newShare.promise);
    tokens.mockReturnValueOnce(oldTokens.promise).mockReturnValueOnce(newTokens.promise);
    const storageWrites = vi.spyOn(Storage.prototype, "setItem");
    const timers = vi.spyOn(globalThis, "setTimeout");

    const rendered = render(<HintBoundary session={fakeSession("boundary-old")} />);
    expect(collaborators).toHaveBeenCalledTimes(1);
    expect(tokens).toHaveBeenCalledTimes(1);
    rendered.rerender(
      <HintBoundary
        session={fakeSession("boundary-new")}
        boundary={1}
        onBoundary={() => {
          expect(collaborators).toHaveBeenCalledTimes(1);
          expect(tokens).toHaveBeenCalledTimes(1);
          oldShare.resolve(collaboratorResult(2, true));
          oldTokens.reject(new Error("retired token lookup failed"));
        }}
      />,
    );
    await act(async () => {
      await Promise.allSettled([oldShare.promise, oldTokens.promise]);
      await Promise.resolve();
    });

    expect(collaborators.mock.calls.map(([document]) => document)).toEqual(["boundary-old", "boundary-new"]);
    expect(tokens).toHaveBeenCalledTimes(2);
    expect(storageWrites).toHaveBeenCalledTimes(0);
    expect(readHintsRecord(window.localStorage).agentSeen).toBe(false);
    expect(screen.queryByTestId("hint-bar")).not.toBeInTheDocument();
    expect(timers.mock.calls.filter(([, delay]) => delay === COLLAB_HINT_RETRY_MS)).toHaveLength(0);

    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(() => vi.advanceTimersByTimeAsync(COLLAB_HINT_RETRY_MS * 3));
    expect(collaborators).toHaveBeenCalledTimes(2);
    expect(tokens).toHaveBeenCalledTimes(2);

    newShare.resolve(collaboratorResult());
    newTokens.resolve(tokenResult());
    await flushPromises();
    expect(collaborators).toHaveBeenCalledTimes(2);
    expect(tokens).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("hint-bar")).toHaveAttribute("data-hint", "collab-agent");
    expect(storageWrites).toHaveBeenCalledTimes(0);
    expect(timers.mock.calls.filter(([, delay]) => delay === COLLAB_HINT_RETRY_MS)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires both sources before success and failure settle at the removal layout boundary", async () => {
    const oldShare = deferred<ReturnType<typeof collaboratorResult>>();
    const oldTokens = deferred<ReturnType<typeof tokenResult>>();
    collaborators.mockReturnValue(oldShare.promise);
    tokens.mockReturnValue(oldTokens.promise);
    const storageWrites = vi.spyOn(Storage.prototype, "setItem");
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    let timersAtBoundary = -1;

    try {
      const rendered = render(<HintBoundary session={fakeSession("boundary-removed")} />);
      expect(collaborators).toHaveBeenCalledTimes(1);
      expect(tokens).toHaveBeenCalledTimes(1);
      rendered.rerender(
        <HintBoundary
          session={fakeSession("boundary-removed")}
          present={false}
          boundary={1}
          onBoundary={() => {
            timersAtBoundary = vi.getTimerCount();
            oldShare.resolve(collaboratorResult(2, true));
            oldTokens.reject(new Error("removed token lookup failed"));
          }}
        />,
      );
      await act(async () => {
        await Promise.allSettled([oldShare.promise, oldTokens.promise]);
        await Promise.resolve();
      });

      setVisibility("hidden");
      setVisibility("visible");
      await act(() => vi.advanceTimersByTimeAsync(COLLAB_HINT_RETRY_MS * 3));
      expect(timersAtBoundary).toBe(0);
      expect(collaborators).toHaveBeenCalledTimes(1);
      expect(tokens).toHaveBeenCalledTimes(1);
      expect(storageWrites).toHaveBeenCalledTimes(0);
      expect(readHintsRecord(window.localStorage).agentSeen).toBe(false);
      expect(screen.queryByTestId("hint-bar")).not.toBeInTheDocument();
      expect(vi.getTimerCount()).toBe(0);
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("ignores stale settlements after a document/session change", async () => {
    const oldShare = deferred<ReturnType<typeof collaboratorResult>>();
    const oldTokens = deferred<ReturnType<typeof tokenResult>>();
    const newShare = deferred<ReturnType<typeof collaboratorResult>>();
    const newTokens = deferred<ReturnType<typeof tokenResult>>();
    collaborators.mockReturnValueOnce(oldShare.promise).mockReturnValueOnce(newShare.promise);
    tokens.mockReturnValueOnce(oldTokens.promise).mockReturnValueOnce(newTokens.promise);

    const oldSession = fakeSession("doc-old");
    const newSession = fakeSession("doc-new");
    const { rerender } = mount(oldSession);
    expect(collaborators).toHaveBeenCalledWith("doc-old");
    rerender(<HintBar session={newSession} actions={actions} onShare={onShare} onComment={onComment} />);
    expect(collaborators).toHaveBeenCalledOnce();
    expect(tokens).toHaveBeenCalledOnce();

    oldShare.resolve(collaboratorResult(2, true));
    oldTokens.reject(new Error("old token lookup failed"));
    await flushPromises();
    expect(readHintsRecord(window.localStorage).agentSeen).toBe(false);
    expect(screen.queryByTestId("hint-bar")).not.toBeInTheDocument();
    expect(collaborators).toHaveBeenNthCalledWith(2, "doc-new");
    expect(tokens).toHaveBeenCalledTimes(2);

    newShare.resolve(collaboratorResult());
    newTokens.resolve(tokenResult());
    await flushPromises();
    expect(readHintsRecord(window.localStorage).agentSeen).toBe(false);
    expect(screen.getByTestId("hint-bar")).toHaveAttribute("data-hint", "collab-agent");
  });

  it("clears its retry timer on unmount", async () => {
    collaborators.mockRejectedValue(new Error("share unavailable"));
    tokens.mockRejectedValue(new Error("tokens unavailable"));
    const { unmount } = mount();
    await flushPromises();
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(() => vi.advanceTimersByTimeAsync(COLLAB_HINT_RETRY_MS * 2));
    expect(collaborators).toHaveBeenCalledOnce();
    expect(tokens).toHaveBeenCalledOnce();
    expect(readHintsRecord(window.localStorage).agentSeen).toBe(false);
  });

  it.each([
    {
      id: "collab-agent",
      dismissed: ["mention-copilot"],
      session: fakeSession("action-collab"),
      destination: "share",
    },
    {
      id: "mention-copilot",
      dismissed: ["collab-agent"],
      session: fakeSession("action-comment", { threads: 1 }),
      destination: "comment",
    },
  ] as const)("claims the current $id Action once before its exact destination", async ({ id, dismissed, session, destination }) => {
    window.localStorage.setItem(HINTS_STORAGE_KEY, JSON.stringify({ dismissed, agentSeen: false }));
    const storageWrites = vi.spyOn(Storage.prototype, "setItem");
    const root = createHintRoot();

    await renderHintRoot(root, <HintBoundary session={session} />);
    expect(screen.getByTestId("hint-bar")).toHaveAttribute("data-hint", id);
    const callbacks = captureHintCallbacks();
    const preventDefault = vi.fn();
    callbacks.actionMouseDown(callbacks.actionElement, preventDefault);
    expect(preventDefault).toHaveBeenCalledOnce();

    act(() => {
      callbacks.action();
      callbacks.action();
      callbacks.dismiss();
    });

    expect(storageWrites).toHaveBeenCalledOnce();
    expect(readHintsRecord(window.localStorage).dismissed).toEqual(["collab-agent", "mention-copilot"]);
    expect(actions.focus).not.toHaveBeenCalled();
    expect(onShare).toHaveBeenCalledTimes(destination === "share" ? 1 : 0);
    expect(onComment).toHaveBeenCalledTimes(destination === "comment" ? 1 : 0);
    expect(screen.queryByTestId("hint-bar")).toBeNull();
  });

  it.each([
    ["inside", true],
    ["outside", false],
  ] as const)("claims the current Dismiss once with focus $0 the exact publication", async (_label, focusInside) => {
    window.localStorage.setItem(
      HINTS_STORAGE_KEY,
      JSON.stringify({ dismissed: ["collab-agent"], agentSeen: false }),
    );
    const storageWrites = vi.spyOn(Storage.prototype, "setItem");
    const outside = document.createElement("button");
    document.body.append(outside);
    const root = createHintRoot();

    try {
      await renderHintRoot(root, <HintBoundary session={fakeSession("dismiss-focus", { threads: 1 })} />);
      const callbacks = captureHintCallbacks();
      if (focusInside) screen.getByTestId("hint-dismiss").focus();
      else outside.focus();

      act(() => {
        callbacks.dismiss();
        callbacks.action();
        callbacks.dismiss();
      });

      expect(storageWrites).toHaveBeenCalledOnce();
      expect(actions.focus).toHaveBeenCalledTimes(focusInside ? 1 : 0);
      expect(onShare).not.toHaveBeenCalled();
      expect(onComment).not.toHaveBeenCalled();
    } finally {
      outside.remove();
    }
  });

  it.each([
    ["session/document", "action"],
    ["editor actions", "dismiss"],
    ["parent callbacks", "action"],
  ] as const)(
    "retires captured callbacks at the $0 replacement layout boundary and keeps B usable",
    async (replacement, currentActivation) => {
      window.localStorage.setItem(
        HINTS_STORAGE_KEY,
        JSON.stringify({ dismissed: ["collab-agent"], agentSeen: false }),
      );
      const storageWrites = vi.spyOn(Storage.prototype, "setItem");
      const sessionA = fakeSession("publication-A", { threads: 1 });
      const sessionB =
        replacement === "session/document"
          ? fakeSession("publication-B", { threads: 1 })
          : sessionA;
      const actionsA = { focus: vi.fn() } as unknown as EditorActions;
      const actionsB =
        replacement === "editor actions"
          ? ({ focus: vi.fn() } as unknown as EditorActions)
          : actionsA;
      const commentA = vi.fn();
      const commentB = replacement === "parent callbacks" ? vi.fn() : commentA;
      const shareA = vi.fn();
      const shareB = replacement === "parent callbacks" ? vi.fn() : shareA;
      let passiveCleanups = 0;
      const onPassiveCleanup = () => {
        passiveCleanups++;
      };
      const root = createHintRoot();

      await renderHintRoot(
        root,
        <HintBoundary
          session={sessionA}
          editorActions={actionsA}
          share={shareA}
          comment={commentA}
          onPassiveCleanup={onPassiveCleanup}
        />,
      );
      const stale = captureHintCallbacks();
      const publicationA = screen.getByTestId("hint-bar");
      if (currentActivation === "dismiss") screen.getByTestId("hint-dismiss").focus();
      const preventDefault = vi.fn();

      await renderHintRoot(
        root,
        <HintBoundary
          session={sessionB}
          editorActions={actionsB}
          share={shareB}
          comment={commentB}
          boundary={1}
          onPassiveCleanup={onPassiveCleanup}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            stale.actionMouseDown(stale.actionElement, preventDefault);
            stale.action();
            stale.dismiss();
            expect(storageWrites).not.toHaveBeenCalled();
            expect(actionsA.focus).not.toHaveBeenCalled();
            expect(commentA).not.toHaveBeenCalled();
            expect(commentB).not.toHaveBeenCalled();
            expect(shareA).not.toHaveBeenCalled();
            expect(shareB).not.toHaveBeenCalled();
          }}
        />,
      );

      expect(passiveCleanups).toBe(1);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(screen.getByTestId("hint-bar")).toHaveAttribute("data-hint", "mention-copilot");
      if (replacement !== "session/document") {
        expect(screen.getByTestId("hint-bar")).toBe(publicationA);
      }
      const current = captureHintCallbacks();
      if (replacement !== "session/document") {
        expect(current.actionElement).toBe(stale.actionElement);
        expect(current.dismissElement).toBe(stale.dismissElement);
      }
      if (currentActivation === "dismiss") screen.getByTestId("hint-dismiss").focus();

      act(() => {
        if (currentActivation === "action") current.action();
        else current.dismiss();
        stale.action();
        stale.dismiss();
      });

      expect(storageWrites).toHaveBeenCalledOnce();
      expect(actionsA.focus).not.toHaveBeenCalled();
      expect(actionsB.focus).toHaveBeenCalledTimes(currentActivation === "dismiss" ? 1 : 0);
      expect(commentA).toHaveBeenCalledTimes(
        currentActivation === "action" && commentA === commentB ? 1 : 0,
      );
      expect(commentB).toHaveBeenCalledTimes(currentActivation === "action" ? 1 : 0);
      expect(shareA).not.toHaveBeenCalled();
      expect(shareB).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["stale-before-current", false],
    ["current-before-stale", true],
  ] as const)(
    "keeps an equal-looking remount distinct in $0 order",
    async (_order, currentFirst) => {
      window.localStorage.setItem(
        HINTS_STORAGE_KEY,
        JSON.stringify({ dismissed: ["collab-agent"], agentSeen: false }),
      );
      const storageWrites = vi.spyOn(Storage.prototype, "setItem");
      const session = fakeSession("equal-publication", { threads: 1 });
      const comment = vi.fn();
      let passiveCleanups = 0;
      const onPassiveCleanup = () => {
        passiveCleanups++;
      };
      const root = createHintRoot();

      await renderHintRoot(
        root,
        <HintBoundary
          instance="A"
          session={session}
          comment={comment}
          onPassiveCleanup={onPassiveCleanup}
        />,
      );
      const stale = captureHintCallbacks();

      await renderHintRoot(
        root,
        <HintBoundary
          instance="B"
          session={session}
          comment={comment}
          boundary={1}
          onPassiveCleanup={onPassiveCleanup}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            stale.action();
            stale.dismiss();
            expect(storageWrites).not.toHaveBeenCalled();
            expect(comment).not.toHaveBeenCalled();
          }}
        />,
      );
      expect(passiveCleanups).toBe(1);
      const current = captureHintCallbacks();

      act(() => {
        if (currentFirst) current.action();
        stale.action();
        stale.dismiss();
        if (!currentFirst) current.action();
      });

      expect(storageWrites).toHaveBeenCalledOnce();
      expect(comment).toHaveBeenCalledOnce();
      expect(actions.focus).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["stale-before-current", false],
    ["current-before-stale", true],
  ] as const)(
    "requires exact publication controls across a ref replacement in $0 order",
    async (_order, currentFirst) => {
      window.localStorage.setItem(
        HINTS_STORAGE_KEY,
        JSON.stringify({ dismissed: ["collab-agent"], agentSeen: false }),
      );
      const storageWrites = vi.spyOn(Storage.prototype, "setItem");
      const session = fakeSession("control-identity", { threads: 1 });
      const commentA = vi.fn();
      const commentB = vi.fn();
      const foreign = document.createElement("button");
      document.body.append(foreign);
      const root = createHintRoot();
      let passiveCleanups = 0;
      const prevented = vi.fn();
      const invokeStaleWithWrongControls = (
        stale: ReturnType<typeof captureHintCallbacks>,
        current: ReturnType<typeof captureHintCallbacks> | null,
      ) => {
        stale.actionMouseDown(stale.dismissElement, prevented);
        if (current) stale.actionMouseDown(current.actionElement, prevented);
        stale.actionMouseDown(foreign, prevented);
        stale.action(stale.actionElement);
        stale.action(stale.dismissElement);
        if (current) stale.action(current.actionElement);
        stale.action(foreign);
        stale.dismiss(stale.dismissElement);
        stale.dismiss(stale.actionElement);
        if (current) stale.dismiss(current.dismissElement);
        stale.dismiss(foreign);
      };

      try {
        await renderHintRoot(
          root,
          <HintBoundary
            instance="control-A"
            session={session}
            comment={commentA}
            onPassiveCleanup={() => {
              passiveCleanups++;
            }}
          />,
        );
        const stale = captureHintCallbacks();

        await renderHintRoot(
          root,
          <HintBoundary
            instance="control-B"
            session={session}
            comment={commentB}
            boundary={1}
            onPassiveCleanup={() => {
              passiveCleanups++;
            }}
            onBoundary={() => {
              expect(passiveCleanups).toBe(0);
              invokeStaleWithWrongControls(stale, null);
              expect(prevented).not.toHaveBeenCalled();
              expect(storageWrites).not.toHaveBeenCalled();
              expect(commentA).not.toHaveBeenCalled();
              expect(commentB).not.toHaveBeenCalled();
              expect(actions.focus).not.toHaveBeenCalled();
            }}
          />,
        );
        expect(passiveCleanups).toBe(1);
        const current = captureHintCallbacks();
        expect(current.actionElement).not.toBe(stale.actionElement);
        expect(current.dismissElement).not.toBe(stale.dismissElement);

        act(() => {
          invokeStaleWithWrongControls(stale, current);
          current.actionMouseDown(current.dismissElement, prevented);
          current.actionMouseDown(stale.actionElement, prevented);
          current.actionMouseDown(foreign, prevented);
          current.action(current.dismissElement);
          current.action(stale.actionElement);
          current.action(foreign);
          current.dismiss(current.actionElement);
          current.dismiss(stale.dismissElement);
          current.dismiss(foreign);
        });
        expect(prevented).not.toHaveBeenCalled();
        expect(storageWrites).not.toHaveBeenCalled();
        expect(commentA).not.toHaveBeenCalled();
        expect(commentB).not.toHaveBeenCalled();
        expect(actions.focus).not.toHaveBeenCalled();
        expect(screen.getByTestId("hint-bar")).toHaveAttribute(
          "data-hint",
          "mention-copilot",
        );

        act(() => {
          if (currentFirst) current.action();
          invokeStaleWithWrongControls(stale, current);
          if (!currentFirst) current.action();
        });

        expect(prevented).not.toHaveBeenCalled();
        expect(storageWrites).toHaveBeenCalledOnce();
        expect(commentA).not.toHaveBeenCalled();
        expect(commentB).toHaveBeenCalledOnce();
        expect(actions.focus).not.toHaveBeenCalled();
        expect(onShare).not.toHaveBeenCalled();
        expect(screen.queryByTestId("hint-bar")).toBeNull();
      } finally {
        foreign.remove();
      }
    },
  );

  it.each([
    ["dismissal record", false],
    ["shown hint", true],
  ] as const)(
    "retires A before an exact $0 replacement is published",
    async (_replacement, replaceShownHint) => {
      window.localStorage.setItem(
        HINTS_STORAGE_KEY,
        JSON.stringify({ dismissed: ["collab-agent"], agentSeen: false }),
      );
      const storageWrites = vi.spyOn(Storage.prototype, "setItem");
      const root = createHintRoot();

      await renderHintRoot(
        root,
        <HintBoundary instance="A" session={fakeSession("record-A", { threads: 1 })} />,
      );
      expect(screen.getByTestId("hint-bar")).toHaveAttribute("data-hint", "mention-copilot");
      const stale = captureHintCallbacks();

      window.localStorage.setItem(
        HINTS_STORAGE_KEY,
        JSON.stringify({
          dismissed: [replaceShownHint ? "mention-copilot" : "collab-agent"],
          agentSeen: !replaceShownHint,
        }),
      );
      storageWrites.mockClear();
      await renderHintRoot(
        root,
        <HintBoundary
          instance="B"
          session={fakeSession("record-B", { threads: replaceShownHint ? 0 : 1 })}
          boundary={1}
          onBoundary={() => {
            stale.action();
            stale.dismiss();
            expect(storageWrites).not.toHaveBeenCalled();
            expect(onShare).not.toHaveBeenCalled();
            expect(onComment).not.toHaveBeenCalled();
          }}
        />,
      );

      expect(screen.getByTestId("hint-bar")).toHaveAttribute(
        "data-hint",
        replaceShownHint ? "collab-agent" : "mention-copilot",
      );
      const current = captureHintCallbacks();
      act(() => {
        stale.action();
        current.action();
        stale.dismiss();
      });

      expect(storageWrites).toHaveBeenCalledOnce();
      expect(onShare).toHaveBeenCalledTimes(replaceShownHint ? 1 : 0);
      expect(onComment).toHaveBeenCalledTimes(replaceShownHint ? 0 : 1);
      expect(actions.focus).not.toHaveBeenCalled();
    },
  );

  it("retires every captured callback before removal and after passive cleanup", async () => {
    window.localStorage.setItem(
      HINTS_STORAGE_KEY,
      JSON.stringify({ dismissed: ["collab-agent"], agentSeen: false }),
    );
    const storageWrites = vi.spyOn(Storage.prototype, "setItem");
    const root = createHintRoot();
    let passiveCleanups = 0;
    const onPassiveCleanup = () => {
      passiveCleanups++;
    };

    await renderHintRoot(
      root,
      <HintBoundary
        session={fakeSession("removed-publication", { threads: 1 })}
        onPassiveCleanup={onPassiveCleanup}
      />,
    );
    const stale = captureHintCallbacks();
    const preventDefault = vi.fn();

    await renderHintRoot(
      root,
      <HintBoundary
        session={fakeSession("removed-publication", { threads: 1 })}
        present={false}
        boundary={1}
        onPassiveCleanup={onPassiveCleanup}
        onBoundary={() => {
          expect(passiveCleanups).toBe(0);
          stale.actionMouseDown(stale.actionElement, preventDefault);
          stale.action();
          stale.dismiss();
          expect(storageWrites).not.toHaveBeenCalled();
        }}
      />,
    );
    expect(passiveCleanups).toBe(1);

    act(() => {
      stale.actionMouseDown(stale.actionElement, preventDefault);
      stale.action();
      stale.dismiss();
    });
    expect(storageWrites).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(actions.focus).not.toHaveBeenCalled();
    expect(onShare).not.toHaveBeenCalled();
    expect(onComment).not.toHaveBeenCalled();
    expect(screen.queryByTestId("hint-bar")).toBeNull();
  });

  it("keeps B discovery owned after stale A callbacks and retires only current B on activation", async () => {
    window.localStorage.setItem(
      HINTS_STORAGE_KEY,
      JSON.stringify({ dismissed: ["mention-copilot"], agentSeen: false }),
    );
    const storageWrites = vi.spyOn(Storage.prototype, "setItem");
    const root = createHintRoot();

    await renderHintRoot(root, <HintBoundary session={fakeSession("discovery-A")} />);
    expect(screen.getByTestId("hint-bar")).toHaveAttribute("data-hint", "collab-agent");
    const stale = captureHintCallbacks();
    const currentShare = deferred<ReturnType<typeof collaboratorResult>>();
    const currentTokens = deferred<ReturnType<typeof tokenResult>>();
    collaborators.mockReturnValueOnce(currentShare.promise);
    tokens.mockReturnValueOnce(currentTokens.promise);

    await renderHintRoot(
      root,
      <HintBoundary
        session={fakeSession("discovery-B")}
        boundary={1}
        onBoundary={() => {
          stale.action();
          stale.dismiss();
          expect(storageWrites).not.toHaveBeenCalled();
          expect(onShare).not.toHaveBeenCalled();
        }}
      />,
    );
    expect(collaborators.mock.calls.map(([document]) => document)).toEqual([
      "discovery-A",
      "discovery-B",
    ]);
    expect(tokens).toHaveBeenCalledTimes(2);

    act(() => {
      stale.action();
      stale.dismiss();
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(collaborators).toHaveBeenCalledTimes(2);
    expect(tokens).toHaveBeenCalledTimes(2);

    currentShare.resolve(collaboratorResult());
    currentTokens.resolve(tokenResult());
    await flushPromises();
    expect(screen.getByTestId("hint-bar")).toHaveAttribute("data-hint", "collab-agent");
    const current = captureHintCallbacks();

    act(() => {
      current.action();
      current.dismiss();
      stale.action();
    });
    expect(storageWrites).toHaveBeenCalledOnce();
    expect(onShare).toHaveBeenCalledOnce();
    expect(onComment).not.toHaveBeenCalled();

    setVisibility("hidden");
    setVisibility("visible");
    await act(() => vi.advanceTimersByTimeAsync(COLLAB_HINT_RETRY_MS * 2));
    expect(collaborators).toHaveBeenCalledTimes(2);
    expect(tokens).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
