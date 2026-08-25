import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";

// Stand-in provider that records whether it was told to connect on construction and when `connect()` ran.
vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  class HocuspocusProvider {
    awareness: InstanceType<typeof Awareness>;
    connectCalls = 0;
    destroyed = false;
    static last: HocuspocusProvider | null = null;
    constructor(readonly opts: { document: Y.Doc; autoConnect?: boolean }) {
      this.awareness = new Awareness(opts.document);
      HocuspocusProvider.last = this;
    }
    connect() {
      this.connectCalls++;
      return Promise.resolve();
    }
    destroy() {
      this.destroyed = true;
      this.awareness.destroy();
    }
  }
  return { HocuspocusProvider };
});

import { HocuspocusProvider } from "@hocuspocus/provider";
import { CollabSession, ORPHAN_GRACE_MS } from "./session";
import { makeCollabUser } from "./shared";

type FakeProvider = { opts: { autoConnect?: boolean }; connectCalls: number; destroyed: boolean };
const lastProvider = () => (HocuspocusProvider as unknown as { last: FakeProvider }).last;

function makeSession(autoConnect?: boolean): CollabSession {
  return new CollabSession({ docId: "doc", user: makeCollabUser("a", "Alice"), role: "owner", getToken: async () => "token", autoConnect });
}

describe("CollabSession connection timing (task #480)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("connects on construction by default and never self-destructs", () => {
    const session = makeSession();
    const provider = lastProvider();
    expect(provider.opts.autoConnect).toBeUndefined();
    vi.advanceTimersByTime(ORPHAN_GRACE_MS * 2);
    expect(provider.destroyed).toBe(false);
    // connect() on an already connecting session is a no-op.
    session.connect();
    expect(provider.connectCalls).toBe(0);
    session.destroy();
  });

  it("with autoConnect: false opens the socket only once connect() is called, then keeps the session", () => {
    const session = makeSession(false);
    const provider = lastProvider();
    expect(provider.opts.autoConnect).toBe(false);
    expect(provider.connectCalls).toBe(0);

    // StrictMode: effect → cleanup → effect again within milliseconds; one socket, the destroy is cancelled.
    session.connect();
    session.scheduleDestroy();
    session.connect();
    expect(provider.connectCalls).toBe(1);
    vi.advanceTimersByTime(ORPHAN_GRACE_MS * 2);
    expect(provider.destroyed).toBe(false);
    session.destroy();
    expect(provider.destroyed).toBe(true);
  });

  it("a deferred session nobody adopts frees itself after the grace period", () => {
    makeSession(false);
    const orphan = lastProvider();
    vi.advanceTimersByTime(ORPHAN_GRACE_MS - 1);
    expect(orphan.destroyed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(orphan.destroyed).toBe(true);
    expect(orphan.connectCalls).toBe(0);
  });
});
