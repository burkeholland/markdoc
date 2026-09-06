// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { WebSocketStatus } from "@hocuspocus/provider";
import type { PersistenceMessage, PersistenceRequest } from "@/lib/document-persistence";

vi.mock("@hocuspocus/provider", async (importOriginal) => {
  const { WebSocketStatus } = await importOriginal<typeof import("@hocuspocus/provider")>();
  const { Awareness } = await import("y-protocols/awareness");
  return {
    WebSocketStatus,
    HocuspocusProvider: class {
      awareness: InstanceType<typeof Awareness>;
      constructor(options: { document: Y.Doc }) {
        this.awareness = new Awareness(options.document);
      }
      sendStateless = vi.fn();
      destroy() { this.awareness.destroy(); }
    },
  };
});

import { CollabSession } from "./session";
import { makeCollabUser } from "./shared";

let session: CollabSession;
afterEach(() => {
  session?.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("content composition persistence ownership", () => {
  it("notifies durability edges immediately without notifying for every dirty insertion", async () => {
    vi.useFakeTimers();
    session = new CollabSession({
      docId: "durability-edges", user: makeCollabUser("local", "Local"), role: "owner",
      getToken: async () => crypto.randomUUID(), autoConnect: false,
    });
    session.keepAlive();
    session.status = WebSocketStatus.Connected;
    session.synced = true;
    session.persistence.synced();
    const request = JSON.parse(vi.mocked(session.provider.sendStateless).mock.calls[0][0]) as PersistenceRequest;
    if (!("requestId" in request)) throw new Error("Expected a persistence status request");
    const saved: PersistenceMessage = {
      type: "document-persistence", docId: session.docId, epoch: "fixture", sequence: 1,
      revision: 0, savedRevision: 0, state: "saved", error: null, requestId: request.requestId,
      saved: { docId: session.docId, version: "initial", contentHash: "initial", title: "Fixture", savedAt: new Date().toISOString() },
      snapshot: Array.from(Y.encodeSnapshot(Y.snapshot(session.ydoc))),
    };
    session.persistence.receive(saved);
    await vi.advanceTimersByTimeAsync(50);
    const states: string[] = [];
    session.subscribe(() => states.push(session.saveState));

    session.ydoc.transact(() => session.ytext.insert(0, "a"), session.binding);
    await Promise.resolve();
    expect(states).toEqual(["pending"]);
    for (let index = 0; index < 20; index++) {
      session.ydoc.transact(() => session.ytext.insert(session.ytext.length, "x"), session.binding);
      await Promise.resolve();
    }
    expect(states).toEqual(["pending"]);

    session.persistence.receive({ ...saved, sequence: 2, state: "error", error: "Synthetic save failure" });
    await Promise.resolve();
    expect(states).toEqual(["pending", "error"]);
    session.persistence.receive({
      ...saved, sequence: 3, revision: 1, savedRevision: 1,
      snapshot: Array.from(Y.encodeSnapshot(Y.snapshot(session.ydoc))),
    });
    await Promise.resolve();
    expect(states).toEqual(["pending", "error", "saved"]);
  });

  it("does not end rich composition when an unrelated source pane unmounts", () => {
    session = new CollabSession({
      docId: "composition", user: makeCollabUser("local", "Local"), role: "owner",
      getToken: async () => "local-test", autoConnect: false,
    });
    session.keepAlive();
    const setComposing = vi.spyOn(session.persistence, "setComposing");
    const rich = document.createElement("div");
    const source = document.createElement("div");
    const unbindRich = session.bindContentComposition(rich);
    const unbindSource = session.bindContentComposition(source);
    rich.dispatchEvent(new CompositionEvent("compositionstart"));
    unbindSource();
    expect(setComposing).toHaveBeenLastCalledWith(true);
    rich.dispatchEvent(new CompositionEvent("compositionend"));
    expect(setComposing).toHaveBeenLastCalledWith(false);
    unbindRich();
    setComposing.mockClear();
    rich.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(setComposing).not.toHaveBeenCalled();
  });
});
