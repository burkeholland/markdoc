import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";

/**
 * Issue #2269: the session learns that the access of its own page changed, from the server's
 * `access-changed` message, from the role the token route answers on every connect, from a refused token
 * and from the server's refusal close. It never switches roles in place: lowered or removed it stops
 * editing at once and stays blocked; raised it only records the news.
 */
vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  class HocuspocusProvider {
    awareness: InstanceType<typeof Awareness>;
    configuration = { websocketProvider: { disconnect: vi.fn(), connect: vi.fn(async () => undefined) } };
    isAuthenticated = false;
    disconnect = vi.fn();
    sendStateless = vi.fn();
    static last: HocuspocusProvider | null = null;
    constructor(readonly opts: { document: Y.Doc }) {
      this.awareness = new Awareness(opts.document);
      HocuspocusProvider.last = this;
    }
    destroy() {
      this.awareness.destroy();
    }
  }
  return { HocuspocusProvider };
});

import { HocuspocusProvider } from "@hocuspocus/provider";
import { CollabSession, CONNECT_ATTEMPT_TIMEOUT_MS, type CollabTokenGrant } from "./session";
import { makeCollabUser } from "./shared";
import type { Role } from "@/server/db/schema";

interface FakeProvider {
  opts: {
    token: () => Promise<string>;
    onStatus: (e: { status: string }) => void;
    onSynced: (e: { state: boolean }) => void;
    onUnsyncedChanges: (e: { number: number }) => void;
    onStateless: (e: { payload: string }) => void;
    onClose: (e: { event: unknown }) => void;
    onAuthenticationFailed: (e: { reason: string }) => void;
  };
  configuration: { websocketProvider: { disconnect: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> } };
  disconnect: ReturnType<typeof vi.fn>;
}
const lastProvider = () => (HocuspocusProvider as unknown as { last: FakeProvider }).last;

function open(role: Role, { getToken = async () => "token", embed = false }: { getToken?: () => Promise<CollabTokenGrant>; embed?: boolean } = {}) {
  const session = new CollabSession({ docId: "doc", user: makeCollabUser("a", "Alice"), role, getToken, preserveLocalOnAuthFailure: embed });
  const provider = lastProvider();
  const tell = (message: unknown) => provider.opts.onStateless({ payload: typeof message === "string" ? message : JSON.stringify(message) });
  return {
    session,
    provider,
    tell,
    told: (now: Role | null) => tell({ type: "access-changed", role: now }),
    /** A connection that is up and in sync, with `unsent` changes the server has not acknowledged. */
    live: (unsent = 0) => {
      provider.opts.onStatus({ status: "connected" });
      provider.opts.onSynced({ state: true });
      provider.opts.onUnsyncedChanges({ number: unsent });
    },
  };
}

describe("the session learns that its own access changed (#2269)", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("the server's message", () => {
    it.each([
      ["editor", "viewer"],
      ["editor", "commenter"],
      ["commenter", "viewer"],
      ["owner", "viewer"],
    ] as const)("%s to %s: lowered. Editing stops in the same turn, and the page keeps the role it was built with", async (built, now) => {
      const { session, told, live } = open(built);
      live();
      const before = session.canEdit;
      told(now);
      expect(session.accessChange).toEqual({ role: now, kind: "lowered", unsaved: false });
      // No await in between: nothing typed after the message can enter the document through a pane.
      expect(session.canEdit).toBe(false);
      expect(session.accessBlocked).toBe(true);
      expect(before).toBe(built !== "commenter");
      expect(session.role).toBe(built);
      await expect(session.flushSave()).rejects.toThrow(/permission/);
      session.destroy();
    });

    it.each([
      ["viewer", "editor"],
      ["viewer", "commenter"],
      ["commenter", "editor"],
    ] as const)("%s to %s: raised. Nothing is blocked and nothing else changes", (built, now) => {
      const { session, told, live } = open(built);
      live();
      told(now);
      expect(session.accessChange).toEqual({ role: now, kind: "raised", unsaved: false });
      expect(session.accessBlocked).toBe(false);
      expect(session.canEdit).toBe(false);
      expect(session.canComment).toBe(built !== "viewer");
      expect(session.role).toBe(built);
      session.destroy();
    });

    it("null: removed. The session stops reconnecting, shows an error state, and nothing that comes later changes it", () => {
      const { session, provider, told, live } = open("editor");
      live();
      told(null);
      expect(session.accessChange).toEqual({ role: null, kind: "removed", unsaved: false });
      expect(session.canEdit).toBe(false);
      expect(session.saveState).toBe("error");
      expect(provider.disconnect).toHaveBeenCalledTimes(1);
      told("editor");
      told("viewer");
      expect(session.accessChange).toEqual({ role: null, kind: "removed", unsaved: false });
      // An attempt that stalls is not replaced by a fresh one any more.
      vi.useFakeTimers();
      try {
        provider.opts.onStatus({ status: "connecting" });
        vi.advanceTimersByTime(CONNECT_ATTEMPT_TIMEOUT_MS + 1);
        expect(provider.configuration.websocketProvider.connect).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
      session.destroy();
    });

    it("the role the page already has says nothing", () => {
      const { session, told, live } = open("editor");
      live();
      told("editor");
      expect(session.accessChange).toBeNull();
      expect(session.canEdit).toBe(true);
      session.destroy();
    });

    it.each([
      ["no role at all", { type: "access-changed" }],
      ["a role that does not exist", { type: "access-changed", role: "admin" }],
      ["a role that is not a string", { type: "access-changed", role: 3 }],
      ["a property of every object", { type: "access-changed", role: "constructor" }],
      ["not JSON", "access-changed"],
      ["another message", { type: "something-else", role: "viewer" }],
    ])("a message that is not valid (%s) blocks nothing and deletes nothing", (_what, message) => {
      const { session, tell, live } = open("editor");
      const clearLocal = vi.spyOn(session, "clearLocal");
      live();
      tell(message);
      expect(session.accessChange).toBeNull();
      expect(session.canEdit).toBe(true);
      expect(clearLocal).not.toHaveBeenCalled();
      session.destroy();
    });

    it("a message that is not valid changes nothing on a page that is already blocked either", () => {
      const { session, tell, told, live } = open("editor");
      live();
      told("viewer");
      for (const message of [{ type: "access-changed" }, { type: "access-changed", role: "admin" }, { type: "access-changed", role: 3 }, { type: "access-changed", role: "constructor" }]) tell(message);
      expect(session.accessChange).toEqual({ role: "viewer", kind: "lowered", unsaved: false });
      session.destroy();
    });

    it("the session itself never deletes the local copy for an access change (the shell does, once the notice is on screen)", () => {
      const { session, told, live } = open("editor");
      const clearLocal = vi.spyOn(session, "clearLocal");
      live(2);
      told("viewer");
      told(null);
      expect(clearLocal).not.toHaveBeenCalled();
      session.destroy();
    });

    it("subscribers hear of it", async () => {
      const { session, told, live } = open("editor");
      live();
      await Promise.resolve();
      const heard = vi.fn();
      session.subscribe(heard);
      told("viewer");
      await Promise.resolve();
      expect(heard).toHaveBeenCalledTimes(1);
      session.destroy();
    });
  });

  describe("more than one change", () => {
    it("lowered, then back to the role the page was built with: still blocked, and the role is the newest one", () => {
      const { session, told, live } = open("editor");
      live();
      told("viewer");
      told("editor");
      expect(session.accessChange).toEqual({ role: "editor", kind: "lowered", unsaved: false });
      expect(session.canEdit).toBe(false);
      told("commenter");
      expect(session.accessChange).toEqual({ role: "commenter", kind: "lowered", unsaved: false });
      session.destroy();
    });

    it("lowered, then removed", () => {
      const { session, told, live } = open("editor");
      live();
      told("commenter");
      told(null);
      expect(session.accessChange).toEqual({ role: null, kind: "removed", unsaved: false });
      session.destroy();
    });

    it("raised, then back to the role the page was built with: nothing is left to say", () => {
      const { session, told, live } = open("viewer");
      live();
      told("editor");
      told("viewer");
      expect(session.accessChange).toBeNull();
      session.destroy();
    });

    it("raised, then to another raised role, then below the built role: the newest role, and now it blocks", () => {
      const { session, told, live } = open("commenter");
      live();
      told("editor");
      expect(session.accessChange?.kind).toBe("raised");
      told("viewer");
      expect(session.accessChange).toEqual({ role: "viewer", kind: "lowered", unsaved: false });
      session.destroy();
    });
  });

  describe("changes that the server had not accepted", () => {
    it("unacknowledged changes on a synced connection when the page is blocked: unsaved", () => {
      const { session, told, live } = open("editor");
      live(3);
      told("viewer");
      expect(session.accessChange).toEqual({ role: "viewer", kind: "lowered", unsaved: true });
      session.destroy();
    });

    it("removed with unacknowledged changes: unsaved too", () => {
      const { session, told, live } = open("editor");
      live(1);
      told(null);
      expect(session.accessChange).toEqual({ role: null, kind: "removed", unsaved: true });
      session.destroy();
    });

    it("raised never counts anything as unsaved", () => {
      const { session, told, live } = open("commenter");
      live(1);
      told("editor");
      expect(session.accessChange).toEqual({ role: "editor", kind: "raised", unsaved: false });
      session.destroy();
    });

    it("the role goes back to Editor: the server takes the changes after all, so they are not called unsaved; lowered again before it did, they are", () => {
      const { session, told, live } = open("editor");
      live(2);
      told("viewer");
      told("editor");
      expect(session.accessChange).toEqual({ role: "editor", kind: "lowered", unsaved: false });
      told("commenter");
      expect(session.accessChange).toEqual({ role: "commenter", kind: "lowered", unsaved: true });
      session.destroy();
    });

    it("every change is acknowledged afterwards: nothing is unsaved any more, also after a later lowering", () => {
      const { session, provider, told, live } = open("editor");
      live(2);
      told("viewer");
      told("editor");
      provider.opts.onUnsyncedChanges({ number: 1 });
      provider.opts.onUnsyncedChanges({ number: 0 });
      told("viewer");
      expect(session.accessChange).toEqual({ role: "viewer", kind: "lowered", unsaved: false });
      session.destroy();
    });

    it("a count that reaches zero while the page is blocked takes the sentence away (the server had it all)", () => {
      const { session, provider, told, live } = open("editor");
      live(1);
      told("viewer");
      expect(session.accessChange?.unsaved).toBe(true);
      provider.opts.onUnsyncedChanges({ number: 0 });
      expect(session.accessChange).toEqual({ role: "viewer", kind: "lowered", unsaved: false });
      session.destroy();
    });
  });

  describe("the role the token route answers on every connect", () => {
    it("the token goes on to the provider; a role that differs from the page's is recorded", async () => {
      const { session, provider } = open("editor", { getToken: async () => ({ token: "t-1", role: "viewer" }) });
      await expect(provider.opts.token()).resolves.toBe("t-1");
      expect(session.accessChange).toEqual({ role: "viewer", kind: "lowered", unsaved: false });
      expect(session.canEdit).toBe(false);
      session.destroy();
    });

    it("the same role, no role, or a role that does not exist: nothing", async () => {
      for (const grant of [{ token: "t", role: "editor" }, { token: "t" }, "t", { token: "t", role: "admin" }] as CollabTokenGrant[]) {
        const { session, provider } = open("editor", { getToken: async () => grant });
        await expect(provider.opts.token()).resolves.toBe("t");
        expect(session.accessChange).toBeNull();
        session.destroy();
      }
    });

    it("raised while the page had no connection", async () => {
      const { session, provider } = open("viewer", { getToken: async () => ({ token: "t", role: "commenter" }) });
      await provider.opts.token();
      expect(session.accessChange).toEqual({ role: "commenter", kind: "raised", unsaved: false });
      session.destroy();
    });

    it("lowered while offline with changes made offline: unsaved, counted before the handshake restarts the count", async () => {
      let role: Role = "editor";
      const { session, provider, live } = open("editor", { getToken: async () => ({ token: "t", role }) });
      await provider.opts.token();
      live();
      provider.opts.onStatus({ status: "disconnected" });
      provider.opts.onUnsyncedChanges({ number: 4 });
      role = "viewer";
      provider.opts.onStatus({ status: "connecting" });
      provider.opts.onStatus({ status: "connected" });
      await provider.opts.token();
      expect(session.accessChange).toEqual({ role: "viewer", kind: "lowered", unsaved: true });
      // The handshake restarts the count at one and the server refuses the answer: still unsaved.
      provider.opts.onUnsyncedChanges({ number: 1 });
      provider.opts.onSynced({ state: true });
      expect(session.accessChange?.unsaved).toBe(true);
      session.destroy();
    });

    it("lowered while offline with nothing typed: not unsaved; and a handshake that is acknowledged clears a count that only looked unsent", async () => {
      let role: Role = "editor";
      const { session, provider, live } = open("editor", { getToken: async () => ({ token: "t", role }) });
      await provider.opts.token();
      live();
      provider.opts.onStatus({ status: "disconnected" });
      role = "viewer";
      await provider.opts.token();
      expect(session.accessChange).toEqual({ role: "viewer", kind: "lowered", unsaved: false });
      session.destroy();

      // One change was in flight when the socket dropped; the server had applied it.
      role = "editor";
      const second = open("editor", { getToken: async () => ({ token: "t", role }) });
      await second.provider.opts.token();
      second.live(1);
      second.provider.opts.onStatus({ status: "disconnected" });
      role = "viewer";
      await second.provider.opts.token();
      expect(second.session.accessChange?.unsaved).toBe(true);
      second.provider.opts.onStatus({ status: "connected" });
      second.provider.opts.onUnsyncedChanges({ number: 1 });
      second.provider.opts.onSynced({ state: true });
      second.provider.opts.onUnsyncedChanges({ number: 0 });
      expect(second.session.accessChange).toEqual({ role: "viewer", kind: "lowered", unsaved: false });
      second.session.destroy();
    });

    it("told as the connection opens, before the first sync: the count the handshake starts with is not a change of the person's", async () => {
      const { session, provider, told } = open("editor");
      await provider.opts.token();
      provider.opts.onStatus({ status: "connected" });
      // The provider restarts its count at one when the handshake begins.
      provider.opts.onUnsyncedChanges({ number: 1 });
      told("viewer");
      expect(session.accessChange).toEqual({ role: "viewer", kind: "lowered", unsaved: false });
      session.destroy();
    });

    it("the server's message after the token is the newer one", async () => {
      const { session, provider, told } = open("editor", { getToken: async () => ({ token: "t", role: "commenter" }) });
      await provider.opts.token();
      told("viewer");
      expect(session.accessChange).toEqual({ role: "viewer", kind: "lowered", unsaved: false });
      session.destroy();
    });

    it("a token refused with 403 or 404: removed", async () => {
      for (const status of [403, 404]) {
        const refused = Object.assign(new Error("Document not found"), { status });
        const { session, provider } = open("editor", {
          getToken: async () => {
            throw refused;
          },
        });
        vi.spyOn(session, "clearLocal").mockResolvedValue();
        await expect(provider.opts.token()).rejects.toBe(refused);
        provider.opts.onAuthenticationFailed({ reason: "Failed to get token during sendToken(): Error: Document not found" });
        expect(session.accessChange).toEqual({ role: null, kind: "removed", unsaved: false });
        session.destroy();
      }
    });

    it("a token fetch that failed for another reason (a server that is restarting) shows nothing", async () => {
      const failure = Object.assign(new Error("fetch failed"), { status: 503 });
      const { session, provider } = open("editor", {
        getToken: async () => {
          throw failure;
        },
      });
      await expect(provider.opts.token()).rejects.toBe(failure);
      provider.opts.onAuthenticationFailed({ reason: `Failed to get token during sendToken(): ${failure}` });
      expect(session.accessChange).toBeNull();
      expect(session.canEdit).toBe(true);
      session.destroy();
    });
  });

  describe("the server closes the document for this connection", () => {
    it("with its refusal reason: removed", () => {
      const { session, provider, live } = open("editor");
      live();
      provider.opts.onClose({ event: { code: 1000, reason: "Unauthorized" } });
      expect(session.accessChange).toEqual({ role: null, kind: "removed", unsaved: false });
      session.destroy();
    });

    it.each([
      ["a socket that dropped", { code: 1006, reason: "", target: {} }],
      ["a socket closed normally", { code: 1000, reason: "", target: {} }],
      ["a server that is shutting down", { code: 1001, reason: "Going away", target: {} }],
      ["a socket the server closed because the sign-in took too long", { code: 4401, reason: "Unauthorized", target: {} }],
      ["a socket event that carries the refusal reason", { code: 1000, reason: "Unauthorized", target: {} }],
      ["a document close with another reason", { code: 1000, reason: "Server closed the connection" }],
      ["a document reset", { code: 4205, reason: "Reset Connection" }],
      ["no event at all", undefined],
    ])("%s is an outage, not a refusal: nothing is shown and editing goes on", (_what, event) => {
      const { session, provider, live } = open("editor");
      live();
      provider.opts.onClose({ event });
      expect(session.accessChange).toBeNull();
      expect(session.canEdit).toBe(true);
      expect(provider.disconnect).not.toHaveBeenCalled();
      session.destroy();
    });

    it("an embedded page, whose sign-in is renewed out of band, is not told it lost access by a close", () => {
      const { session, provider, live } = open("editor", { embed: true });
      live();
      provider.opts.onClose({ event: { code: 1000, reason: "Unauthorized" } });
      expect(session.accessChange).toBeNull();
      session.destroy();
    });
  });
});
