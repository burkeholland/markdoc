import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { PersistenceMessage, PersistenceRequest } from "@/lib/document-persistence";
import { ClientDocumentPersistence, snapshotContains } from "./persistence";
import { contentHash } from "@/server/export/html";

const disposals: (() => void)[] = [];

function fixture(docId = "document-a") {
  const document = new Y.Doc();
  document.getText("content").insert(0, "original");
  const send = vi.fn<(request: PersistenceRequest) => void>();
  const changed = vi.fn();
  const client = new ClientDocumentPersistence(docId, document, send, changed);
  let sequence = 0;
  const ack = (revision = 0, extra: Partial<PersistenceMessage> = {}): PersistenceMessage => ({
    type: "document-persistence",
    docId,
    epoch: "epoch-a",
    sequence: ++sequence,
    revision,
    savedRevision: revision,
    state: "saved",
    error: null,
    saved: {
      docId,
      version: `epoch-a:${revision}`,
      contentHash: contentHash(document.getText("content").toString()),
      title: "",
      savedAt: new Date().toISOString(),
    },
    snapshot: Array.from(Y.encodeSnapshot(Y.snapshot(document))),
    ...extra,
  });
  const lastRequest = () => send.mock.calls.at(-1)![0] as Extract<PersistenceRequest, { requestId: string }>;
  const sync = (extra: Partial<PersistenceMessage> = {}) => {
    client.synced();
    client.receive(ack(0, { requestId: lastRequest().requestId, ...extra }));
  };
  disposals.push(() => { client.destroy(false); document.destroy(); });
  return { document, text: document.getText("content"), client, send, changed, ack, lastRequest, sync };
}

describe("acknowledged content persistence", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    disposals.splice(0).forEach((dispose) => dispose());
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("publishes only acknowledged saved content, not keys, transport acknowledgements or comment-only saves", () => {
    const f = fixture();
    const saved = vi.fn();
    f.client.subscribeSaved(saved);
    f.sync();
    expect(f.client.state).toBe("saved");
    expect(saved).not.toHaveBeenCalled();
    f.text.insert(0, "new ");
    f.text.insert(0, "more ");
    expect(f.client.dirty).toBe(true);
    expect(f.client.state).toBe("pending");
    expect(f.send).toHaveBeenCalledTimes(1); // handshake status only; no per-key requests
    expect(saved).not.toHaveBeenCalled();
    f.client.receive(f.ack(2));
    expect(f.client.state).toBe("saved");
    expect(saved).toHaveBeenCalledExactlyOnceWith(f.client.savedVersion);
    f.document.getMap("comments").set("thread", "a comment");
    f.client.receive(f.ack(3));
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it("old acknowledgements cannot mark newer inserts OR deletions saved", () => {
    const f = fixture();
    f.sync();
    f.text.insert(0, "one ");
    const firstSave = f.ack(1);
    f.text.delete(0, 4); // clocks did not advance, but the delete still needs persistence
    f.client.receive(firstSave);
    expect(f.client.dirty).toBe(true);
    expect(f.client.state).toBe("pending");
    expect(f.client.savedVersion?.contentHash).toBe(contentHash("one original"));
    f.client.receive(f.ack(2));
    expect(f.client.state).toBe("saved");
    f.client.receive(firstSave);
    expect(f.client.savedVersion?.contentHash).toBe(contentHash("original"));
    expect(f.client.state).toBe("saved");
  });

  it("manual Save waits for the exact pending snapshot, and a clean Save is a no-op", async () => {
    const f = fixture();
    f.sync();
    expect(await f.client.flush()).toBe(f.client.savedVersion);
    expect(f.send).toHaveBeenCalledTimes(1);
    f.text.insert(0, "new ");
    const stale = f.ack(1);
    f.text.delete(0, 1);
    const flush = f.client.flush();
    const requestId = f.lastRequest().requestId;
    const complete = vi.fn();
    void flush.then(complete);
    f.client.receive({ ...stale, requestId });
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();
    f.client.receive(f.ack(2, { requestId }));
    await flush;
    expect(complete).toHaveBeenCalledOnce();
    expect(f.client.state).toBe("saved");
  });

  it("manual Save acknowledges its requested content even if another edit arrives during the save", async () => {
    const f = fixture();
    f.sync();
    f.text.insert(0, "first ");
    const flush = f.client.flush();
    const committed = f.ack(1, { requestId: f.lastRequest().requestId });
    f.text.insert(0, "second ");
    f.client.receive(committed);
    expect((await flush)?.contentHash).toBe(contentHash("first original"));
    expect(f.client.state).toBe("pending");
    expect(f.client.dirty).toBe(true);
  });

  it("failed responses retain pending edits and reject Save; only a later acknowledgement clears error", async () => {
    const f = fixture();
    f.sync();
    f.text.insert(0, "pending ");
    const flush = f.client.flush();
    const rejected = expect(flush).rejects.toThrow("Store unavailable");
    f.client.receive(f.ack(0, {
      state: "error", error: "Store unavailable", requestId: f.lastRequest().requestId, saved: undefined, snapshot: undefined,
    }));
    await rejected;
    expect(f.client.state).toBe("error");
    expect(f.client.dirty).toBe(true);
    f.text.insert(0, "newest ");
    f.client.receive(f.ack(2));
    expect(f.client.error).toBeNull();
    expect(f.client.state).toBe("saved");
    expect(f.client.savedVersion?.contentHash).toBe(contentHash("newest pending original"));
  });

  it("ignores wrong-document, reordered and previous-connection messages", async () => {
    const f = fixture();
    f.sync();
    f.text.insert(0, "local ");
    const old = f.ack(1);
    f.client.receive({ ...old, docId: "document-b" });
    expect(f.client.dirty).toBe(true);
    const flush = f.client.flush();
    const rejected = expect(flush).rejects.toThrow("Disconnected");
    f.client.disconnected();
    await rejected;
    f.client.receive(old);
    expect(f.client.dirty).toBe(true);
    f.client.synced();
    f.client.receive(old); // unsolicited epoch cannot establish a new connection
    expect(f.client.dirty).toBe(true);
    const requestId = f.lastRequest().requestId;
    f.client.receive(f.ack(1, { epoch: "epoch-b", sequence: 1, requestId }));
    expect(f.client.state).toBe("saved");
    f.client.receive({ ...old, state: "error", error: "old failure", sequence: 100 });
    expect(f.client.state).toBe("saved");
    expect(f.client.error).toBeNull();
  });

  it("recovers unsaved content on reconnect, including when the server was reloaded", async () => {
    const f = fixture();
    f.sync();
    f.client.disconnected();
    f.text.insert(0, "offline ");
    await expect(f.client.flush()).rejects.toThrow("Offline");
    f.client.synced();
    f.client.receive(f.ack(1, {
      epoch: "reloaded", requestId: f.lastRequest().requestId, state: "pending", saved: undefined, snapshot: undefined,
    }));
    expect(f.client.state).toBe("pending");
    f.client.receive(f.ack(1, { epoch: "reloaded" }));
    expect(f.client.state).toBe("saved");
    expect(f.client.savedVersion?.contentHash).toBe(contentHash("offline original"));
  });

  it("unmount sends only a best-effort flush, rejects pending waits, and does not alter Yjs/journal content", async () => {
    const f = fixture();
    f.sync();
    f.text.insert(0, "closing ");
    const flush = f.client.flush();
    const rejected = expect(flush).rejects.toThrow("Disconnected");
    f.client.destroy();
    await rejected;
    expect(f.lastRequest().type).toBe("document-persistence-flush");
    expect(f.text.toString()).toBe("closing original");
    const count = f.send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.send).toHaveBeenCalledTimes(count);
  });

  it("sends composition boundaries, not keystrokes, and restores active composition on reconnect", () => {
    const f = fixture();
    f.sync();
    f.client.setComposing(true);
    f.text.insert(0, "あ");
    f.client.setComposing(true);
    expect(f.send).toHaveBeenCalledTimes(2);
    f.client.disconnected();
    f.client.synced();
    expect(f.send.mock.calls.at(-1)![0]).toEqual({ type: "document-composition", docId: "document-a", active: true });
    f.client.setComposing(false);
    expect(f.send.mock.calls.at(-1)![0]).toEqual({ type: "document-composition", docId: "document-a", active: false });
  });

  it("times out missing acknowledgements without fabricating success or retrying forever", async () => {
    const f = fixture();
    f.sync();
    f.text.insert(0, "pending ");
    const flush = f.client.flush();
    const rejected = expect(flush).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(f.client.state).toBe("error");
    expect(f.client.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it("requires both clocks and delete ranges when comparing acknowledgement coverage", () => {
    const f = fixture();
    const original = Y.snapshot(f.document);
    f.text.delete(0, 1);
    const deleted = Y.snapshot(f.document);
    expect(snapshotContains(original, deleted)).toBe(false);
    expect(snapshotContains(deleted, original)).toBe(true);
    f.text.insert(0, "x");
    expect(snapshotContains(deleted, Y.snapshot(f.document))).toBe(false);
  });
});

/**
 * #2284: `crypto.randomUUID` exists only where the browser calls the page "secure": https and localhost.
 * A person who opens the app as http://<machine-name>:3000 on the local network has a `crypto` without it.
 * The three places that ask the server about saving must work there too.
 */
describe("saving on a plain http address, where crypto.randomUUID does not exist", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // What such a page has: random bytes, but no randomUUID.
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto), subtle: crypto.subtle });
  });
  afterEach(() => {
    disposals.splice(0).forEach((dispose) => dispose());
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("the stand-in really has no randomUUID", () => {
    expect("randomUUID" in crypto).toBe(false);
  });

  it("asks for the save state, saves, and says goodbye, each with an id of its own", async () => {
    const f = fixture();
    f.client.synced();
    const status = f.lastRequest();
    expect(status.type).toBe("document-persistence-status");
    f.client.receive(f.ack(0, { requestId: status.requestId }));
    expect(f.client.state).toBe("saved");

    f.text.insert(0, "edit ");
    const flushed = f.client.flush();
    const flush = f.lastRequest();
    expect(flush.type).toBe("document-persistence-flush");
    f.client.receive(f.ack(1, { requestId: flush.requestId }));
    expect((await flushed)?.contentHash).toBe(contentHash("edit original"));
    expect(f.client.state).toBe("saved");

    f.text.insert(0, "more ");
    f.client.destroy();
    const goodbye = f.lastRequest();
    expect(goodbye.type).toBe("document-persistence-flush");

    const ids = [status.requestId, flush.requestId, goodbye.requestId];
    expect(f.send).toHaveBeenCalledTimes(3);
    expect(new Set(ids).size).toBe(3);
    // The server refuses an id that is not a string or is longer than 100 characters (autosave.ts).
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{8,100}$/);
  });
});