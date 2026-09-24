import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Connection, Hocuspocus, MessageType, type Document, type onStatelessPayload } from "@hocuspocus/server";
import { createDecoder, readVarString, readVarUint, readVarUint8Array } from "lib0/decoding";
import { messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { documentStoreSnapshot, installDocumentAutosave, type DocumentStoreSnapshot } from "./autosave";
import { installOriginAwareBroadcast } from "./broadcast";
import { CommentsModel } from "@/editor/collab/comments";
import { ClientDocumentPersistence, snapshotContains } from "@/editor/collab/persistence";
import { makeCollabUser } from "@/editor/collab/shared";
import { CONTENT_AUTOSAVE_IDLE_MS, type PersistenceMessage } from "@/lib/document-persistence";
import { contentHash } from "@/server/export/html";

vi.mock("./authorization", () => ({ collabAccessChangeBlocks: (connection: { blocked?: boolean }) => !!connection.blocked }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const documents: Document[] = [];
const disposals: (() => void)[] = [];

async function fixture(content = "original") {
  const writes: DocumentStoreSnapshot[] = [];
  const store = vi.fn(async () => {});
  const server = new Hocuspocus({
    quiet: true,
    debounce: CONTENT_AUTOSAVE_IDLE_MS,
    flushDelay: false,
    unloadImmediately: false,
    async onLoadDocument({ document }) {
      installOriginAwareBroadcast(document);
      document.getText("content").insert(0, content);
      autosave.track(document, new Date());
      documents.push(document);
    },
    async onStoreDocument(payload) {
      writes.push(documentStoreSnapshot(payload));
      await store();
    },
    async afterUnloadDocument({ documentName }) { autosave.untrack(documentName); },
  });
  const autosave = installDocumentAutosave(server);
  const connection = await server.openDirectConnection("document", { userId: "alice" });
  const document = server.documents.get("document")!;
  return { server, autosave, connection, document, text: document.getText("content"), writes, store };
}

function client() {
  const close: (() => void)[] = [];
  return {
    readOnly: false,
    blocked: false,
    sendStateless: vi.fn<(payload: string) => void>(),
    onClose: (callback: () => void) => close.push(callback),
    close: () => close.forEach((callback) => callback()),
  };
}

function recipient(f: Awaited<ReturnType<typeof fixture>>, readOnly = false) {
  const document = new Y.Doc();
  Y.applyUpdate(document, Y.encodeStateAsUpdate(f.document));
  const packets: Uint8Array[] = [];
  const received: Uint8Array[] = [];
  const connection = new Connection({
    readyState: 1,
    send(data) {
      if (!(data instanceof Uint8Array)) throw new Error("Expected a binary Hocuspocus message");
      packets.push(data);
      received.push(data);
    },
    close: vi.fn(),
  }, new Request("http://localhost/document"), f.document, crypto.randomUUID(), {}, readOnly);
  const persistence = new ClientDocumentPersistence("document", document, (request) => f.autosave.onStateless({
    connection, document: f.document, documentName: "document", payload: JSON.stringify(request),
  }), vi.fn());
  const deliver = () => {
    const events: ("update" | PersistenceMessage)[] = [];
    for (const packet of packets.splice(0)) {
      const decoder = createDecoder(packet);
      expect(readVarString(decoder)).toBe("document");
      const type = readVarUint(decoder);
      if (type === MessageType.Sync) {
        expect(readVarUint(decoder)).toBe(messageYjsUpdate);
        Y.applyUpdate(document, readVarUint8Array(decoder), connection);
        events.push("update");
      } else if (type === MessageType.Stateless) {
        const message: PersistenceMessage = JSON.parse(readVarString(decoder));
        persistence.receive(message);
        events.push(message);
      }
    }
    return events;
  };
  persistence.synced();
  deliver();
  disposals.push(() => { persistence.destroy(false); connection.close(); document.destroy(); });
  return { document, connection, persistence, deliver, received };
}

describe("server-owned content persistence integration (no sockets/database)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    disposals.splice(0).forEach((dispose) => dispose());
    documents.splice(0).forEach((document) => document.destroy());
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("merges both clients' inserts, deletes, paste and undo into one durable Yjs snapshot", async () => {
    const f = await fixture();
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, Y.encodeStateAsUpdate(f.document));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(f.document));
    a.getText("content").insert(0, "A ");
    b.getText("content").insert(0, "B ");
    Y.applyUpdate(f.document, Y.encodeStateAsUpdate(a));
    await vi.advanceTimersByTimeAsync(400);
    Y.applyUpdate(f.document, Y.encodeStateAsUpdate(b));
    await vi.advanceTimersByTimeAsync(400);
    const undo = new Y.UndoManager(f.text);
    f.text.insert(f.text.length, " pasted");
    undo.undo();
    await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS - 1);
    expect(f.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.writes).toHaveLength(1);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, f.writes[0].ystate);
    expect(restored.getText("content").toString()).toBe(f.text.toString());
    expect(f.text.toString()).toContain("A ");
    expect(f.text.toString()).toContain("B ");
    expect(f.text.toString()).not.toContain("pasted");
    undo.destroy(); a.destroy(); b.destroy(); restored.destroy();
  });

  it("keeps a single immutable snapshot in flight and persists edits that arrive during that write later", async () => {
    const f = await fixture();
    const saving = deferred();
    f.store.mockImplementationOnce(() => saving.promise);
    f.text.insert(0, "first ");
    await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS);
    expect(f.document.saveMutex.isLocked()).toBe(true);
    f.text.insert(0, "second ");
    await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS + 100);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].content).toBe("first original");
    f.text.insert(0, "third ");
    saving.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS - 1);
    expect(f.writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.writes.map((write) => write.content)).toEqual(["first original", "third second first original"]);
  });

  it("flushes through the existing authorization/shutdown facade and adds no no-op direct-disconnect write", async () => {
    const f = await fixture();
    expect(f.server.debouncer.isDebounced("onStoreDocument-document")).toBe(false);
    f.text.insert(0, "pending ");
    expect(f.server.debouncer.isDebounced("onStoreDocument-document")).toBe(true);
    await f.server.debouncer.executeNow("onStoreDocument-document");
    expect(f.writes).toHaveLength(1);
    expect(f.server.debouncer.isDebounced("onStoreDocument-document")).toBe(false);
    await f.connection.disconnect();
    expect(f.writes).toHaveLength(1);
  });

  it("keeps the shutdown flush pending until a dirty document is durably stored", async () => {
    const f = await fixture();
    const saving = deferred();
    f.store.mockImplementationOnce(() => saving.promise);
    f.text.insert(0, "pending ");
    let settled = false;
    const flushing = Promise.resolve(f.server.flushPendingStores()).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.writes).toHaveLength(1);
    expect(settled).toBe(false);
    saving.resolve();
    await flushing;
    expect(f.writes[0].content).toBe("pending original");
    expect(f.server.debouncer.isDebounced("onStoreDocument-document")).toBe(false);
  });

  it("rejects the shutdown flush when a dirty store fails", async () => {
    const f = await fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    f.store.mockRejectedValueOnce(new Error("database details must remain internal"));
    f.text.insert(0, "pending ");
    await expect(Promise.resolve(f.server.flushPendingStores())).rejects.toThrow(
      "database details must remain internal",
    );
    expect(f.server.documents.has("document")).toBe(true);
  });

  it("preserves synchronous REST durability and rejects a failed direct flush without unloading data", async () => {
    const f = await fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    f.store.mockRejectedValueOnce(new Error("database failed"));
    await f.connection.transact((document) => document.getText("content").insert(0, "REST "));
    await expect(f.connection.disconnect()).rejects.toThrow("database failed");
    expect(f.server.documents.has("document")).toBe(true);
    expect(f.server.shouldUnloadDocument(f.document)).toBe(false);
    expect(f.text.toString()).toBe("REST original");
    await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS);
    expect(f.writes).toHaveLength(2);
    expect(f.writes[1].content).toBe("REST original");
  });

  it("responds to manual Save only after acknowledgement without blocking live message handling", async () => {
    const f = await fixture();
    const saving = deferred();
    f.store.mockImplementationOnce(() => saving.promise);
    const socket = client();
    const messages = (request: object) => f.autosave.onStateless({
      connection: socket, document: f.document, documentName: "document", payload: JSON.stringify(request),
    } as unknown as onStatelessPayload);
    f.text.insert(0, "first ");
    expect(messages({ type: "document-persistence-flush", docId: "document", requestId: "save-1" })).toBeUndefined();
    expect(socket.sendStateless).not.toHaveBeenCalled();
    f.text.insert(0, "second ");
    saving.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const response = JSON.parse(socket.sendStateless.mock.calls[0][0]);
    expect(response.requestId).toBe("save-1");
    expect(response.saved.contentHash).toBe(contentHash("first original"));
    expect(response.state).toBe("pending");
    expect(f.text.toString()).toBe("second first original");
  });

  it("cannot force or pause persistence from a read-only/wrong-document/access-gated connection", async () => {
    const f = await fixture();
    const socket = client();
    socket.readOnly = true;
    f.text.insert(0, "pending ");
    const request = (payload: object) => f.autosave.onStateless({
      connection: socket, document: f.document, documentName: "document", payload: JSON.stringify(payload),
    } as unknown as onStatelessPayload);
    request({ type: "document-persistence-flush", docId: "document", requestId: "denied" });
    expect(JSON.parse(socket.sendStateless.mock.calls[0][0]).state).toBe("error");
    socket.readOnly = false;
    socket.blocked = true;
    request({ type: "document-composition", docId: "document", active: true });
    request({ type: "document-persistence-flush", docId: "other-document", requestId: "wrong" });
    expect(f.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS);
    expect(f.writes).toHaveLength(1);
  });

  it("releases abandoned IME state on disconnect and saves the retained document", async () => {
    const f = await fixture();
    const socket = client();
    f.autosave.onStateless({
      connection: socket, document: f.document, documentName: "document",
      payload: JSON.stringify({ type: "document-composition", docId: "document", active: true }),
    } as unknown as onStatelessPayload);
    f.text.insert(0, "あ");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.writes).toHaveLength(0);
    socket.close();
    await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS);
    expect(f.writes[0].content).toBe("あoriginal");
  });

  it.each([false, true])("releases downgraded IME owners through the authorization flush (completion sent: %s)", async (completion) => {
    const f = await fixture();
    const socket = client();
    const composition = (active: boolean) => f.autosave.onStateless({
      connection: socket, document: f.document, documentName: "document",
      payload: JSON.stringify({ type: "document-composition", docId: "document", active }),
    } as unknown as onStatelessPayload);
    composition(true);
    f.text.insert(0, "IME ");
    socket.blocked = true;
    socket.readOnly = true;
    if (completion) composition(false);
    await f.server.debouncer.executeNow("onStoreDocument-document");
    socket.blocked = false;
    f.text.insert(0, "Other editor ");
    await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS - 1);
    expect(f.writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.writes).toHaveLength(2);
    expect(f.writes[1].content).toBe("Other editor IME original");
  });

  it("persists an accepted comment suggestion with its text atomically despite subsequent typing", async () => {
    const f = await fixture();
    const comments = new CommentsModel(f.document, f.text);
    const author = makeCollabUser("alice", "Alice");
    try {
      const id = comments.add({ from: 0, to: 8, body: "```suggestion\nreplacement\n```", author });
      await f.server.debouncer.executeNow("onStoreDocument-document");
      expect(comments.acceptSuggestion(id, "replacement", author)).toBe(true);
      f.text.insert(f.text.length, "!");
      await vi.advanceTimersByTimeAsync(0);
      expect(f.writes).toHaveLength(2);
      const restored = new Y.Doc();
      try {
        Y.applyUpdate(restored, f.writes[1].ystate);
        expect(restored.getText("content").toString()).toBe("replacement!");
        expect(restored.getMap<Y.Map<unknown>>("comments").get(id)?.get("suggestionState")).toBe("accepted");
      } finally {
        restored.destroy();
      }
    } finally {
      comments.destroy();
    }
  });

  it("persists CRDT-only offline replies into a deleted and saved thread, and settles manual Save", async () => {
    const f = await fixture();
    const comments = new CommentsModel(f.document, f.text);
    const author = makeCollabUser("alice", "Alice");
    const id = comments.add({ from: 0, to: 8, body: "Original thread", author });
    await f.server.debouncer.executeNow("onStoreDocument-document");
    const offline = recipient(f);
    const offlineComments = new CommentsModel(offline.document, offline.document.getText("content"));
    try {
      offline.persistence.disconnected();
      expect(offlineComments.reply(id, "Offline reply", author)).not.toBeNull();
      comments.remove(id);
      await f.server.debouncer.executeNow("onStoreDocument-document");
      expect(f.writes).toHaveLength(2);
      offline.deliver();
      const target = Y.snapshot(offline.document);
      const update = Y.encodeStateAsUpdate(offline.document);
      const integrated = vi.fn();
      f.document.on("update", integrated);
      Y.applyUpdate(f.document, update, { source: "connection", connection: offline.connection });
      expect(integrated).toHaveBeenCalledOnce();
      expect(integrated.mock.calls[0][3].changed.size).toBe(0);
      expect(f.server.debouncer.isDebounced("onStoreDocument-document")).toBe(true);
      offline.persistence.synced();
      offline.deliver();
      expect(offline.persistence.state).toBe("pending");
      const saved = offline.persistence.flush();
      await f.server.debouncer.executeNow("onStoreDocument-document");
      offline.deliver();
      expect((await saved)?.contentHash).toBe(contentHash("original"));
      expect(offline.persistence.state).toBe("saved");
      expect(offline.persistence.dirty).toBe(false);
      expect(f.writes).toHaveLength(3);
      const restored = new Y.Doc();
      try {
        Y.applyUpdate(restored, f.writes[2].ystate);
        expect(snapshotContains(Y.snapshot(restored), target)).toBe(true);
        expect(snapshotContains(Y.decodeSnapshot(new Uint8Array(f.writes[2].snapshot)), target)).toBe(true);
        expect(restored.getMap("comments").size).toBe(0);
        expect(restored.getText("content").toString()).toBe("original");
        expect(Y.decodeUpdate(f.writes[2].ystate).structs.some((item) =>
          item instanceof Y.GC && item.id.client === offline.document.clientID)).toBe(true);
      } finally {
        restored.destroy();
      }
      Y.applyUpdate(f.document, update);
      f.document.transact(() => {});
      await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS);
      expect(f.writes).toHaveLength(3);
      expect(f.server.debouncer.isDebounced("onStoreDocument-document")).toBe(false);
    } finally {
      offlineComments.destroy();
      comments.destroy();
    }
  });

  it.each([false, true])("sends buffered REST updates before same-turn saved broadcasts (read-only: %s)", async (readOnly) => {
    const f = await fixture();
    const remote = recipient(f, readOnly);
    await f.connection.transact((document) => document.getText("content").insert(0, "REST "));
    expect(remote.document.getText("content").toString()).toBe("original");
    // No timer/setImmediate turn: a fast store finishes while fan-out is still buffered.
    await f.connection.disconnect();
    expect(f.writes).toHaveLength(1);
    const events = remote.deliver();
    const savedIndex = events.findIndex((event) => event !== "update" && event.state === "saved");
    expect(events.indexOf("update")).toBeGreaterThanOrEqual(0);
    expect(savedIndex).toBeGreaterThan(events.indexOf("update"));
    expect(remote.document.getText("content").toString()).toBe("REST original");
    expect(remote.persistence.state).toBe("saved");
    await vi.advanceTimersByTimeAsync(0);
    expect(remote.deliver()).toEqual([]);
    expect(remote.persistence.state).toBe("saved");
    const stale = events.find((event) => event !== "update" && event.state === "pending");
    expect(stale).toBeDefined();
    if (stale && stale !== "update") remote.persistence.receive(stale);
    expect(remote.persistence.state).toBe("saved");
  });

  it.each([false, true])("orders snapshot-bearing status replies after buffered updates (read-only: %s)", async (readOnly) => {
    const f = await fixture();
    const remote = recipient(f, readOnly);
    await f.connection.transact((document) => document.getText("content").insert(0, "REST "));
    remote.persistence.synced();
    const events = remote.deliver();
    const replyIndex = events.findIndex((event) => event !== "update" && !!event.requestId);
    expect(replyIndex).toBeGreaterThan(events.indexOf("update"));
    expect(events.indexOf("update")).toBeGreaterThanOrEqual(0);
    expect(remote.document.getText("content").toString()).toBe("REST original");
    expect(remote.persistence.state).toBe("pending");
    await f.connection.disconnect();
    remote.deliver();
    expect(remote.persistence.state).toBe("saved");
  });

  it("keeps newer local edits pending across a buffered remote save and reordered acknowledgements", async () => {
    const f = await fixture();
    const remote = recipient(f);
    await f.connection.transact((document) => document.getText("content").insert(0, "REST "));
    await f.connection.disconnect();
    remote.document.getText("content").insert(0, "LOCAL ");
    const events = remote.deliver();
    const older = events.find((event) => event !== "update" && !!event.saved);
    expect(older).toBeDefined();
    expect(remote.persistence.state).toBe("pending");
    expect(remote.persistence.dirty).toBe(true);
    Y.applyUpdate(f.document, Y.encodeStateAsUpdate(remote.document), { source: "connection", connection: remote.connection });
    const saved = remote.persistence.flush();
    await f.server.debouncer.executeNow("onStoreDocument-document");
    const replies = remote.deliver();
    expect(replies.some((event) => event !== "update" && !!event.requestId)).toBe(true);
    expect((await saved)?.contentHash).toBe(contentHash(remote.document.getText("content").toString()));
    expect(remote.persistence.state).toBe("saved");
    if (older && older !== "update") remote.persistence.receive(older);
    expect(remote.persistence.state).toBe("saved");
    expect(remote.persistence.savedVersion?.contentHash).toBe(contentHash(f.writes[1].content));
    expect(f.writes[1].content).toContain("LOCAL ");
    expect(f.writes).toHaveLength(2);
  });

  it("keeps warm status, saved broadcasts and manual replies compact without resending source", async () => {
    const content = "A long document paragraph.\n\n".repeat(5000);
    const f = await fixture(content);
    const remote = recipient(f);
    expect(remote.received.reduce((bytes, packet) => bytes + packet.byteLength, 0)).toBeLessThan(content.length * 0.05);
    remote.received.length = 0;
    remote.document.getText("content").insert(0, "Local ");
    Y.applyUpdate(f.document, Y.encodeStateAsUpdate(remote.document), { source: "connection", connection: remote.connection });
    const saved = remote.persistence.flush();
    await f.server.debouncer.executeNow("onStoreDocument-document");
    remote.deliver();
    expect((await saved)?.contentHash).toBe(contentHash("Local " + content));
    expect(remote.persistence.savedVersion).not.toHaveProperty("content");
    expect(remote.persistence.state).toBe("saved");
    expect(remote.received.reduce((bytes, packet) => bytes + packet.byteLength, 0)).toBeLessThan(content.length * 0.05);
    expect(f.writes[0].content).toBe("Local " + content);
  });
});
