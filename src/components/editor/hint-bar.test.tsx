// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { CollabSession } from "@/editor/collab/session";
import { HINTS, HINTS_STORAGE_KEY, readHintsRecord } from "@/lib/hints";
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

const originalMatchMedia = Object.getOwnPropertyDescriptor(
  window,
  "matchMedia",
);
const originalVisibility = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);

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
    collaborators: Array.from({ length: count }, (_, index) => ({
      login: `person-${index}`,
    })),
    agents: agentKnown
      ? [
          {
            name: "Copilot",
            login: "person/Copilot",
            ownerLogin: "person",
            ownerName: "Person",
            present: false,
            collaboratorsMayAsk: true,
          },
        ]
      : [],
  };
}

function tokenResult(used = false) {
  return {
    tokens: used
      ? [{ lastUsedAt: "2026-09-07T15:00:00.000Z" }]
      : [{ lastUsedAt: null }],
  };
}

function fakeSession(
  docId: string,
  options: { people?: number; agentHere?: boolean; threads?: number } = {},
) {
  const listeners = new Set<() => void>();
  return {
    docId,
    role: "editor",
    canEdit: true,
    canCreateComment: true,
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
      ...Array.from({ length: options.people ?? 0 }, () => ({
        isLocal: false,
        isAgent: false,
      })),
      ...(options.agentHere ? [{ isLocal: false, isAgent: true }] : []),
    ],
    comments: {
      list: () =>
        Array.from({ length: options.threads ?? 0 }, (_, index) => ({
          id: `thread-${index}`,
        })),
    },
  } as unknown as CollabSession;
}

const actions = { focus: vi.fn() } as unknown as EditorActions;
const onConnectAgent = vi.fn();
const onComment = vi.fn();

function mount(session = fakeSession("doc-1")) {
  return render(
    <HintBar
      session={session}
      actions={actions}
      onConnectAgent={onConnectAgent}
      onComment={onComment}
    />,
  );
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
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
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
    onConnectAgent.mockReset();
    onComment.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalMatchMedia)
      Object.defineProperty(window, "matchMedia", originalMatchMedia);
    else Reflect.deleteProperty(window, "matchMedia");
    if (originalVisibility)
      Object.defineProperty(document, "visibilityState", originalVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
  });

  it.each(["collaborators", "tokens"] as const)(
    "requests both sources, keeps a failed %s source unknown, and retries only that source",
    async (failedSource) => {
      if (failedSource === "collaborators") {
        collaborators
          .mockRejectedValueOnce(new Error("share unavailable"))
          .mockResolvedValueOnce(collaboratorResult());
      } else {
        tokens
          .mockRejectedValueOnce(new Error("tokens unavailable"))
          .mockResolvedValueOnce(tokenResult());
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
      expect(collaborators).toHaveBeenCalledTimes(
        failedSource === "collaborators" ? 2 : 1,
      );
      expect(tokens).toHaveBeenCalledTimes(failedSource === "tokens" ? 2 : 1);
      expect(screen.getByTestId("hint-bar")).toHaveAttribute(
        "data-hint",
        "collab-agent",
      );
    },
  );

  it.each(["known collaborator agent", "used token"] as const)(
    "persists positive agent evidence from a %s and never shows the setup hint",
    async (source) => {
      collaborators.mockResolvedValue(
        collaboratorResult(1, source === "known collaborator agent"),
      );
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
    collaborators
      .mockRejectedValueOnce(new Error("share unavailable"))
      .mockReturnValueOnce(shareRetry.promise);
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
    collaborators
      .mockRejectedValueOnce(new Error("share unavailable"))
      .mockReturnValueOnce(shareRetry.promise);
    tokens
      .mockRejectedValueOnce(new Error("tokens unavailable"))
      .mockReturnValueOnce(tokenRetry.promise);

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
    window.localStorage.setItem(
      HINTS_STORAGE_KEY,
      JSON.stringify({ dismissed: ["mention-copilot"], agentSeen: false }),
    );
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
});

describe("HintBar controls", () => {
  beforeEach(() => {
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
    window.localStorage.setItem(
      HINTS_STORAGE_KEY,
      JSON.stringify({ dismissed: [], agentSeen: true }),
    );
    collaborators.mockReset();
    tokens.mockReset();
    actions.focus = vi.fn();
    onConnectAgent.mockReset();
    onComment.mockReset();
  });

  afterEach(() => {
    cleanup();
    if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
    else Reflect.deleteProperty(window, "matchMedia");
  });

  it("shows the comment hint with its full text as a title", () => {
    mount(fakeSession("doc-1", { threads: 1 }));
    const bar = screen.getByTestId("hint-bar");
    expect(bar).toHaveAttribute("data-hint", "mention-copilot");
    expect(bar).toHaveTextContent(HINTS["mention-copilot"].message);
    expect(screen.getByText(HINTS["mention-copilot"].message)).toHaveAttribute(
      "title",
      HINTS["mention-copilot"].message,
    );
  });

  it("does not offer the comment hint before new threads can be created", () => {
    const session = fakeSession("doc-1", { threads: 1 });
    (session as { canCreateComment: boolean }).canCreateComment = false;
    mount(session);
    expect(screen.queryByTestId("hint-bar")).not.toBeInTheDocument();
    expect(onComment).not.toHaveBeenCalled();
  });

  it("Write a comment opens a comment, hides the bar, and remembers the dismissal", () => {
    mount(fakeSession("doc-1", { threads: 1 }));
    fireEvent.click(screen.getByTestId("hint-action"));
    expect(onComment).toHaveBeenCalledOnce();
    expect(onConnectAgent).not.toHaveBeenCalled();
    expect(screen.queryByTestId("hint-bar")).not.toBeInTheDocument();
    expect(readHintsRecord(window.localStorage).dismissed).toEqual(["mention-copilot"]);
  });

  it("keeps editor focus when the action is pressed with the mouse", () => {
    mount(fakeSession("doc-1", { threads: 1 }));
    const pressed = fireEvent.mouseDown(screen.getByTestId("hint-action"));
    expect(pressed).toBe(false);
  });

  it("the X hides the bar, remembers the dismissal, and runs no action", () => {
    mount(fakeSession("doc-1", { threads: 1 }));
    fireEvent.click(screen.getByTestId("hint-dismiss"));
    expect(screen.queryByTestId("hint-bar")).not.toBeInTheDocument();
    expect(onComment).not.toHaveBeenCalled();
    expect(onConnectAgent).not.toHaveBeenCalled();
    expect(actions.focus).not.toHaveBeenCalled();
    expect(readHintsRecord(window.localStorage).dismissed).toEqual(["mention-copilot"]);
  });

  it("returns focus to the editor when the X is used from the keyboard", () => {
    mount(fakeSession("doc-1", { threads: 1 }));
    const dismiss = screen.getByTestId("hint-dismiss");
    dismiss.focus();
    fireEvent.click(dismiss);
    expect(actions.focus).toHaveBeenCalledOnce();
  });

  it("stays dismissed after remounting", () => {
    const view = mount(fakeSession("doc-1", { threads: 1 }));
    fireEvent.click(screen.getByTestId("hint-dismiss"));
    view.unmount();
    mount(fakeSession("doc-1", { threads: 1 }));
    expect(screen.queryByTestId("hint-bar")).not.toBeInTheDocument();
  });

  it.each([
    ["ArrowRight", "hint-action", "hint-dismiss"],
    ["ArrowDown", "hint-action", "hint-dismiss"],
    ["End", "hint-action", "hint-dismiss"],
    ["ArrowLeft", "hint-dismiss", "hint-action"],
    ["ArrowUp", "hint-dismiss", "hint-action"],
    ["Home", "hint-dismiss", "hint-action"],
  ])("%s moves focus from %s to %s", (key, from, to) => {
    mount(fakeSession("doc-1", { threads: 1 }));
    screen.getByTestId(from).focus();
    expect(fireEvent.keyDown(screen.getByTestId(from), { key })).toBe(false);
    expect(screen.getByTestId(to)).toHaveFocus();
    expect(onComment).not.toHaveBeenCalled();
  });

  it.each([
    ["ArrowLeft", "hint-action"],
    ["Home", "hint-action"],
    ["ArrowRight", "hint-dismiss"],
    ["End", "hint-dismiss"],
  ])("%s at the edge (%s) does nothing", (key, at) => {
    mount(fakeSession("doc-1", { threads: 1 }));
    screen.getByTestId(at).focus();
    expect(fireEvent.keyDown(screen.getByTestId(at), { key })).toBe(true);
    expect(screen.getByTestId(at)).toHaveFocus();
  });
});
