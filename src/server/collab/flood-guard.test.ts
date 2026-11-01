import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Hocuspocus, OutgoingMessage } from "@hocuspocus/server";
import * as encoding from "lib0/encoding";
import WebSocket from "ws";
import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFloodGuard,
  DEFAULT_FLOOD_LIMITS,
  MESSAGE_TOO_LARGE,
  RATE_LIMITED,
  SEND_BUFFER_FULL,
  type FloodLimits,
} from "./flood-guard";
import { attachCollab } from "./ws";

function authMessage(doc: string): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, doc);
  encoding.writeVarUint(e, 2); // Auth
  encoding.writeVarUint(e, 0); // Token
  encoding.writeVarString(e, "token");
  return encoding.toUint8Array(e);
}

function syncStep1(doc: string): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, doc);
  encoding.writeVarUint(e, 0); // Sync
  encoding.writeVarUint(e, 0); // Step 1
  encoding.writeVarUint8Array(e, new Uint8Array([0]));
  return encoding.toUint8Array(e);
}

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  closes: { code?: number; reason?: string }[] = [];
  terminations = 0;
  close(code?: number, reason?: string) {
    this.closes.push({ code, reason });
    this.readyState = WebSocket.CLOSING;
  }
  send(data: Uint8Array) {
    this.bufferedAmount += data.byteLength;
  }
  terminate() {
    this.terminations++;
    this.readyState = WebSocket.CLOSED;
  }
}

describe("createFloodGuard", () => {
  const limits: Partial<FloodLimits> = { messagesPerSecond: 10, messageBurst: 20, bytesPerSecond: 100, byteBurst: 1000 };

  it("passes traffic within the limits, in order", async () => {
    const socket = new FakeSocket();
    const seen: number[] = [];
    let t = 0;
    const guard = createFloodGuard(socket as unknown as WebSocket, (b) => seen.push(b[0]), limits, () => t);
    for (let i = 0; i < 20; i++) expect(guard.receive(new Uint8Array([i]))).toBe(true);
    t += 1000;
    for (let i = 20; i < 30; i++) expect(guard.receive(new Uint8Array([i]))).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([...Array(30).keys()]);
    expect(socket.closes).toEqual([]);
  });

  it("closes with 4429 when the message rate is exceeded", () => {
    const socket = new FakeSocket();
    const guard = createFloodGuard(socket as unknown as WebSocket, () => {}, limits, () => 0);
    for (let i = 0; i < 20; i++) guard.receive(new Uint8Array([1]));
    expect(guard.receive(new Uint8Array([1]))).toBe(false);
    expect(socket.closes).toEqual([RATE_LIMITED]);
    guard.dispose();
  });

  it("closes with 4429 when the byte rate is exceeded", () => {
    const socket = new FakeSocket();
    const guard = createFloodGuard(socket as unknown as WebSocket, () => {}, limits, () => 0);
    expect(guard.receive(new Uint8Array(1000))).toBe(true);
    expect(guard.receive(new Uint8Array(1))).toBe(false);
    expect(socket.closes).toEqual([RATE_LIMITED]);
    guard.dispose();
  });

  it("closes with 1009 when an individual message exceeds the size limit", () => {
    const socket = new FakeSocket();
    const seen: number[] = [];
    const guard = createFloodGuard(
      socket as unknown as WebSocket,
      (bytes) => seen.push(bytes.byteLength),
      { maxMessageBytes: 4 },
    );

    expect(guard.receive(new Uint8Array(4))).toBe(true);
    expect(guard.receive(new Uint8Array(5))).toBe(false);
    expect(seen).toEqual([4]);
    expect(socket.closes).toEqual([MESSAGE_TOO_LARGE]);
    guard.dispose();
  });

  it("closes with 4430 when the outgoing buffer passes the bound", () => {
    const socket = new FakeSocket();
    const guard = createFloodGuard(
      socket as unknown as WebSocket,
      () => {},
      { maxBufferedBytes: 1000 },
    );
    socket.send(new Uint8Array(1001));
    expect(socket.closes).toEqual([SEND_BUFFER_FULL]);
    guard.dispose();
  });

  it("yields to the event loop when one connection's backlog is long", async () => {
    const socket = new FakeSocket();
    let t = 0;
    let handled = 0;
    const guard = createFloodGuard(
      socket as unknown as WebSocket,
      () => {
        handled++;
        t += 1;
      },
      { sliceMs: 5, messageBurst: 1000, messagesPerSecond: 1000 },
      () => t,
    );
    for (let i = 0; i < 100; i++) guard.receive(new Uint8Array([1]));
    expect(handled).toBe(5);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(handled).toBeGreaterThan(5);
    expect(handled).toBeLessThan(100);
    for (let i = 0; i < 50 && handled < 100; i++) await new Promise((r) => setImmediate(r));
    expect(handled).toBe(100);
  });
});

describe("collab socket flood protection (real WebSocket)", () => {
  let server: Server;
  let hocuspocus: Hocuspocus;
  const clients: WebSocket[] = [];

  afterEach(async () => {
    for (const c of clients) c.terminate();
    clients.length = 0;
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function start(
    limits?: Partial<FloodLimits>,
    instance = new Hocuspocus({ quiet: true }),
    onConnection?: (socket: WebSocket) => void,
  ) {
    server = createServer();
    hocuspocus = instance;
    const wss = attachCollab(server, hocuspocus, { floodLimits: limits });
    if (onConnection) wss.on("connection", (socket) => onConnection(socket));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`;
  }

  async function open(url: string, doc: string, onFirstMessage?: (bytes: number) => void) {
    const ws = new WebSocket(url);
    clients.push(ws);
    await new Promise<void>((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    const firstMessage = new Promise<void>((r) =>
      ws.once("message", (data) => {
        const bytes = Array.isArray(data)
          ? data.reduce((total, part) => total + part.byteLength, 0)
          : data.byteLength;
        onFirstMessage?.(bytes);
        r();
      }),
    );
    ws.send(authMessage(doc));
    ws.send(syncStep1(doc));
    await firstMessage;
    return ws;
  }

  const closeCode = (ws: WebSocket) => new Promise<number>((r) => ws.once("close", (code) => r(code)));

  it("keeps a connection just under the limit open", async () => {
    const url = await start();
    const ws = await open(url, "under");
    const msg = syncStep1("under");
    for (let i = 0; i < DEFAULT_FLOOD_LIMITS.messageBurst - 10; i++) ws.send(msg);
    let closed = false;
    ws.once("close", () => (closed = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(closed).toBe(false);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("closes a flooding connection with 4429 and does not stall other clients", async () => {
    const url = await start();
    const victim = await open(url, "other");
    const flooder = await open(url, "flood");
    const code = closeCode(flooder);
    const msg = syncStep1("flood");
    for (let i = 0; i < 20_000; i++) flooder.send(msg);

    let maxLag = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - last - 5);
      last = now;
    }, 5);
    expect(await code).toBe(RATE_LIMITED.code);
    const started = performance.now();
    victim.send(syncStep1("other"));
    await new Promise((r) => victim.once("message", r));
    clearInterval(timer);
    expect(performance.now() - started).toBeLessThan(200);
    expect(victim.readyState).toBe(WebSocket.OPEN);
    expect(maxLag).toBeLessThan(250);
  });

  it("closes a connection that sends too many bytes", async () => {
    const url = await start({ bytesPerSecond: 1024, byteBurst: 64 * 1024 });
    const ws = await open(url, "bytes");
    const code = closeCode(ws);
    ws.send(new Uint8Array(70 * 1024));
    expect(await code).toBe(RATE_LIMITED.code);
  });

  it("closes an individual message over the configured size limit with 1009", async () => {
    const url = await start({ maxMessageBytes: 1024 });
    const ws = await open(url, "oversized");
    const code = closeCode(ws);
    ws.send(new Uint8Array(1025));
    expect(await code).toBe(MESSAGE_TOO_LARGE.code);
  });

  it("closes with 4430 when a Hocuspocus send exceeds the outgoing buffer bound", async () => {
    const url = await start({ maxBufferedBytes: 512 }, undefined, (socket) => {
      Object.defineProperty(socket, "bufferedAmount", {
        configurable: true,
        get: () => 513,
      });
    });
    const ws = new WebSocket(url);
    clients.push(ws);
    await new Promise<void>((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    const code = closeCode(ws);
    ws.send(authMessage("backpressure"));
    ws.send(syncStep1("backpressure"));
    expect(await code).toBe(SEND_BUFFER_FULL.code);
  });

  it("keeps normal typing, an 8 MiB paste, and a 1 MiB first sync working", async () => {
    const initial = new Y.Doc();
    initial.getText("content").insert(0, "s".repeat(1024 * 1024));
    const initialUpdate = Y.encodeStateAsUpdate(initial);
    const instance = new Hocuspocus({
      quiet: true,
      async onLoadDocument({ document, documentName }) {
        if (documentName === "one-megabyte-sync") Y.applyUpdate(document, initialUpdate);
        return document;
      },
    });
    const url = await start(undefined, instance);

    const sync = await open(url, "one-megabyte-sync");
    let syncBytes = 0;
    const firstSync = new Promise<void>((resolve) =>
      sync.once("message", (data) => {
        syncBytes = Array.isArray(data)
          ? data.reduce((total, part) => total + part.byteLength, 0)
          : data.byteLength;
        resolve();
      }),
    );
    sync.send(syncStep1("one-megabyte-sync"));
    await firstSync;
    expect(syncBytes).toBeGreaterThan(1024 * 1024);

    const typing = await open(url, "typing");
    const typed = new Y.Doc();
    const updates: Uint8Array[] = [];
    typed.on("update", (update) => updates.push(update));
    const text = typed.getText("content");
    const phrase = "normal collaborative typing";
    for (const character of phrase) {
      text.insert(text.length, character);
      const update = updates.shift();
      if (!update) throw new Error("Yjs did not emit an update for typed text");
      typing.send(new OutgoingMessage("typing").createSyncMessage().writeUpdate(update).toUint8Array());
    }
    await waitFor(() => hocuspocus.documents.get("typing")?.getText("content").toString() === phrase);

    const paste = await open(url, "paste");
    const pasteText = "p".repeat(8 * 1024 * 1024);
    const pasteDoc = new Y.Doc();
    pasteDoc.getText("content").insert(0, pasteText);
    const pasteMessage = new OutgoingMessage("paste")
      .createSyncMessage()
      .writeUpdate(Y.encodeStateAsUpdate(pasteDoc))
      .toUint8Array();
    expect(pasteMessage.byteLength).toBeLessThan(DEFAULT_FLOOD_LIMITS.maxMessageBytes);
    expect(pasteMessage.byteLength).toBeLessThan(DEFAULT_FLOOD_LIMITS.byteBurst);
    paste.send(pasteMessage);
    await waitFor(
      () => hocuspocus.documents.get("paste")?.getText("content").length === pasteText.length,
      20_000,
    );
    expect(paste.readyState).toBe(WebSocket.OPEN);
  });

  async function waitFor(check: () => boolean, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() >= deadline) throw new Error("timed out waiting for collaboration message");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
});
