// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useCollabSession } from "./use-session";

vi.mock("@/editor/collab/session", () => ({
  CollabSession: class {
    readonly docId: string;
    readonly user: { id: string };
    readonly role: string;
    startLocalPersistence = vi.fn();
    connect = vi.fn();
    scheduleDestroy = vi.fn();
    constructor(readonly options: { docId: string; user: { id: string }; role: string; preserveLocalOnAuthFailure: boolean }) {
      this.docId = options.docId;
      this.user = options.user;
      this.role = options.role;
    }
  },
}));
vi.mock("@/lib/api", () => ({ api: { documents: { collabToken: vi.fn(async (docId: string) => ({ token: `local-test-${docId}`, role: "editor" })) } } }));

const user = { id: "alice", name: "Alice", login: "alice", image: null };

describe("collaboration session identity and pending-save lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });

  it("replaces the session on document switch, preserving the old session's reliable deferred teardown", async () => {
    const { result, rerender, unmount } = renderHook(({ docId }) => useCollabSession(docId, user, "owner"), { initialProps: { docId: "a" } });
    const first = result.current;
    expect(first.startLocalPersistence).toHaveBeenCalledOnce();
    expect(first.connect).toHaveBeenCalledOnce();
    act(() => rerender({ docId: "b" }));
    const second = result.current;
    expect(second).not.toBe(first);
    expect(second.docId).toBe("b");
    expect(first.scheduleDestroy).toHaveBeenCalledOnce();
    expect(second.connect).toHaveBeenCalledOnce();
    // The token goes to the session together with the role the server holds at that moment (#2269).
    expect(await second.options.getToken()).toEqual({ token: "local-test-b", role: "editor" });
    expect(await first.options.getToken()).toEqual({ token: "local-test-a", role: "editor" });
    unmount();
    expect(second.scheduleDestroy).toHaveBeenCalledOnce();
  });

  it("does not replace the session on an unrelated render, but isolates an account change", () => {
    const { result, rerender } = renderHook(({ identity }) => useCollabSession("a", identity, "owner"), { initialProps: { identity: user } });
    const first = result.current;
    act(() => rerender({ identity: { ...user } }));
    expect(result.current).toBe(first);
    act(() => rerender({ identity: { ...user, id: "bob", name: "Bob" } }));
    expect(result.current).not.toBe(first);
    expect(result.current.user.id).toBe("bob");
    expect(first.scheduleDestroy).toHaveBeenCalledOnce();
  });
});
