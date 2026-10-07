import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";

// Stand-in provider with the socket the session pokes when a connection attempt stalls (#190).
vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  class FakeSocket {
    disconnectCalls = 0;
    connectCalls = 0;
    disconnect() {
      this.disconnectCalls++;
    }
    connect() {
      this.connectCalls++;
      return Promise.resolve();
    }
  }
  class HocuspocusProvider {
    awareness: InstanceType<typeof Awareness>;
    configuration: { websocketProvider: FakeSocket };
    isAuthenticated = false;
    static last: HocuspocusProvider | null = null;
    constructor(
      readonly opts: {
        document: Y.Doc;
        token: () => Promise<string>;
        onStatus: (e: { status: string }) => void;
        onAuthenticationFailed: (e: { reason: string }) => void;
        maxDelay?: number;
        delay?: number;
      },
    ) {
      this.awareness = new Awareness(opts.document);
      this.configuration = { websocketProvider: new FakeSocket() };
      HocuspocusProvider.last = this;
    }
    destroy() {
      this.awareness.destroy();
    }
    disconnect() {
      this.configuration.websocketProvider.disconnect();
    }
  }
  return { HocuspocusProvider };
});

import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  CollabSession,
  CONNECT_ATTEMPT_TIMEOUT_MS,
  isAccessRefusal,
  OFFLINE_PROLONGED_MS,
  RECONNECT_MAX_DELAY_MS,
  TOKEN_RETRY_DELAY_MS,
} from "./session";
import { saveStateLabel } from "./offline";
import { makeCollabUser } from "./shared";

type FakeProvider = {
  opts: {
    token: () => Promise<string>;
    onStatus: (e: { status: string }) => void;
    onAuthenticationFailed: (e: { reason: string }) => void;
    maxDelay?: number;
    delay?: number;
  };
  configuration: { websocketProvider: { disconnectCalls: number; connectCalls: number } };
  isAuthenticated: boolean;
};
const lastProvider = () => (HocuspocusProvider as unknown as { last: FakeProvider }).last;

function makeSession(
  getToken: () => Promise<string> = async () => "token",
  preserveLocalOnAuthFailure = false,
): CollabSession {
  return new CollabSession({
    docId: "doc",
    user: makeCollabUser("a", "Alice"),
    role: "owner",
    getToken,
    preserveLocalOnAuthFailure,
  });
}

describe("CollabSession reconnect across a server restart (#190)", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", undefined);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("caps the provider's reconnect backoff at a few seconds", () => {
    const session = makeSession();
    expect(lastProvider().opts.maxDelay).toBe(RECONNECT_MAX_DELAY_MS);
    expect(RECONNECT_MAX_DELAY_MS).toBeLessThanOrEqual(5_000);
    session.destroy();
  });

  it("abandons a connection attempt that stays 'connecting' and starts a fresh one", () => {
    const session = makeSession();
    const p = lastProvider();
    const socket = p.configuration.websocketProvider;
    p.opts.onStatus({ status: "connected" });
    p.opts.onStatus({ status: "disconnected" });
    p.opts.onStatus({ status: "connecting" });
    expect(session.saveState).toBe("reconnecting");

    vi.advanceTimersByTime(CONNECT_ATTEMPT_TIMEOUT_MS - 1);
    expect(socket.connectCalls).toBe(0);
    vi.advanceTimersByTime(2);
    expect(socket.disconnectCalls).toBe(1);
    expect(socket.connectCalls).toBe(1);

    // A new attempt that also stalls is retried again; one that connects is left alone.
    p.opts.onStatus({ status: "connecting" });
    vi.advanceTimersByTime(CONNECT_ATTEMPT_TIMEOUT_MS + 1);
    expect(socket.connectCalls).toBe(2);
    p.opts.onStatus({ status: "connecting" });
    p.opts.onStatus({ status: "connected" });
    vi.advanceTimersByTime(CONNECT_ATTEMPT_TIMEOUT_MS * 2);
    expect(socket.connectCalls).toBe(2);
    session.destroy();
  });

  it("does not restart a session that was destroyed while an attempt was pending", () => {
    const session = makeSession();
    const p = lastProvider();
    p.opts.onStatus({ status: "connecting" });
    session.destroy();
    vi.advanceTimersByTime(CONNECT_ATTEMPT_TIMEOUT_MS * 2);
    expect(p.configuration.websocketProvider.connectCalls).toBe(0);
  });

  it("keeps the local copy and retries when the token fetch fails for a reason other than refused access", async () => {
    const failure = Object.assign(new Error("fetch failed"), { status: 503 });
    const session = makeSession(async () => {
      throw failure;
    });
    const clearLocal = vi.spyOn(session, "clearLocal");
    const p = lastProvider();
    p.opts.onStatus({ status: "connected" });
    await expect(p.opts.token()).rejects.toBe(failure);
    p.opts.onAuthenticationFailed({ reason: `Failed to get token during sendToken(): ${failure}` });

    expect(session.authError).toBeNull();
    expect(session.saveState).not.toBe("error");
    expect(clearLocal).not.toHaveBeenCalled();

    const socket = p.configuration.websocketProvider;
    vi.advanceTimersByTime(TOKEN_RETRY_DELAY_MS + 1);
    expect(socket.connectCalls).toBe(1);
    session.destroy();
  });

  it("does not retry a token failure once the connection is authenticated", async () => {
    const session = makeSession(async () => {
      throw new Error("network");
    });
    const p = lastProvider();
    await expect(p.opts.token()).rejects.toThrow();
    p.opts.onAuthenticationFailed({ reason: "Failed to get token during sendToken(): Error: network" });
    p.opts.onStatus({ status: "connected" });
    p.isAuthenticated = true;
    vi.advanceTimersByTime(TOKEN_RETRY_DELAY_MS + 1);
    expect(p.configuration.websocketProvider.connectCalls).toBe(0);
    session.destroy();
  });

  it("still treats a refused token (401/403/404) and a server-side refusal as access errors", async () => {
    const refused = Object.assign(new Error("Forbidden"), { status: 403 });
    const session = makeSession(async () => {
      throw refused;
    });
    const clearLocal = vi.spyOn(session, "clearLocal").mockResolvedValue();
    const p = lastProvider();
    await expect(p.opts.token()).rejects.toBe(refused);
    p.opts.onAuthenticationFailed({ reason: "Failed to get token during sendToken(): Error: Forbidden" });
    expect(session.authError).toMatch(/Forbidden/);
    expect(session.saveState).toBe("error");
    expect(clearLocal).toHaveBeenCalledTimes(1);
    // The server answered that this person may not have the document: the page says so (#2269).
    expect(session.accessChange).toEqual({ role: null, kind: "removed", unsaved: false });
    session.destroy();

    const other = makeSession();
    const clearOther = vi.spyOn(other, "clearLocal").mockResolvedValue();
    lastProvider().opts.onAuthenticationFailed({ reason: "permission-denied" });
    expect(other.authError).toBe("permission-denied");
    expect(clearOther).toHaveBeenCalledTimes(1);
    // A token the collaboration server did not take is not an answer about the person's access.
    expect(other.accessChange).toBeNull();
    other.destroy();
  });

  it("a refused token that only says nobody is signed in (401) is not shown as lost access", async () => {
    const signedOut = Object.assign(new Error("Sign in required"), { status: 401 });
    const session = makeSession(async () => {
      throw signedOut;
    });
    vi.spyOn(session, "clearLocal").mockResolvedValue();
    const p = lastProvider();
    await expect(p.opts.token()).rejects.toBe(signedOut);
    p.opts.onAuthenticationFailed({ reason: "Failed to get token during sendToken(): Error: Sign in required" });
    expect(session.authError).toMatch(/Sign in required/);
    expect(session.accessChange).toBeNull();
    session.destroy();
  });

  it("retains local canvas edits and reconnects when an expired embed session returns 401", async () => {
    const expired = Object.assign(new Error("The embedded session has expired"), { status: 401 });
    const session = makeSession(async () => {
      throw expired;
    }, true);
    const clearLocal = vi.spyOn(session, "clearLocal").mockResolvedValue();
    const provider = lastProvider();
    await expect(provider.opts.token()).rejects.toBe(expired);
    provider.opts.onAuthenticationFailed({
      reason: "Failed to get token during sendToken(): Error: The embedded session has expired",
    });

    expect(session.authError).toBeNull();
    expect(clearLocal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TOKEN_RETRY_DELAY_MS + 1);
    expect(provider.configuration.websocketProvider.connectCalls).toBe(1);
    session.destroy();
  });

  it("says the edits are kept on this device once the connection has been down for a while", () => {
    const session = makeSession();
    const p = lastProvider();
    p.opts.onStatus({ status: "connected" });
    p.opts.onStatus({ status: "disconnected" });
    expect(session.prolongedOffline).toBe(false);
    expect(saveStateLabel(session.saveState, 3, false, session.prolongedOffline)).toBe("Offline — 3 unsaved changes");

    // The retry loop keeps cycling; the clock does not reset on each attempt.
    vi.advanceTimersByTime(OFFLINE_PROLONGED_MS / 2);
    p.opts.onStatus({ status: "connecting" });
    p.opts.onStatus({ status: "disconnected" });
    vi.advanceTimersByTime(OFFLINE_PROLONGED_MS / 2 + 1);
    expect(session.prolongedOffline).toBe(true);
    expect(saveStateLabel("offline", 3, false, true)).toBe("Offline — changes kept on this device");
    expect(saveStateLabel("reconnecting", 3, false, true)).toBe("Offline — changes kept on this device");
    // Nothing to keep: the plain labels stay.
    expect(saveStateLabel("offline", 0, false, true)).toBe("Offline — changes will sync");
    expect(saveStateLabel("reconnecting", 0, false, true)).toBe("Reconnecting…");

    p.opts.onStatus({ status: "connected" });
    expect(session.prolongedOffline).toBe(false);
    session.destroy();
  });

  it("classifies token fetch failures", () => {
    expect(isAccessRefusal({ status: 401 })).toBe(true);
    expect(isAccessRefusal({ status: 403 })).toBe(true);
    expect(isAccessRefusal({ status: 404 })).toBe(true);
    expect(isAccessRefusal({ status: 500 })).toBe(false);
    expect(isAccessRefusal({ status: 502 })).toBe(false);
    expect(isAccessRefusal(new TypeError("Failed to fetch"))).toBe(false);
    expect(isAccessRefusal(null)).toBe(false);
  });
});
