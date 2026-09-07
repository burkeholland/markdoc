// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
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
}: {
  session: CollabSession;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <HintBar session={session} actions={actions} onShare={onShare} onComment={onComment} /> : null;
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
});
