import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Hocuspocus } from "@hocuspocus/server";
import * as encoding from "lib0/encoding";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createFloodGuard, DEFAULT_FLOOD_LIMITS, RATE_LIMITED, type FloodLimits } from "./flood-guard";
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
  });

  it("closes with 4429 when the byte rate is exceeded", () => {
    const socket = new FakeSocket();
    const guard = createFloodGuard(socket as unknown as WebSocket, () => {}, limits, () => 0);
    expect(guard.receive(new Uint8Array(1000))).toBe(true);
    expect(guard.receive(new Uint8Array(1))).toBe(false);
    expect(socket.closes).toEqual([RATE_LIMITED]);
  });

  it("terminates a connection whose outgoing buffer passes the bound", () => {
    const socket = new FakeSocket();
    const guard = createFloodGuard(
      socket as unknown as WebSocket,
      () => {
        socket.bufferedAmount += 600;
      },
      { maxBufferedBytes: 1000 },
    );
    expect(guard.receive(new Uint8Array(1))).toBe(true);
    expect(guard.receive(new Uint8Array(1))).toBe(false);
    expect(socket.terminations).toBe(1);
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
  const clients: WebSocket[] = [];

  afterEach(async () => {
    for (const c of clients) c.terminate();
    clients.length = 0;
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function start(limits?: Partial<FloodLimits>) {
    server = createServer();
    attachCollab(server, new Hocuspocus({ quiet: true }), { floodLimits: limits });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`;
  }

  async function open(url: string, doc: string) {
    const ws = new WebSocket(url);
    clients.push(ws);
    await new Promise<void>((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    ws.send(authMessage(doc));
    ws.send(syncStep1(doc));
    await new Promise((r) => ws.once("message", r));
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

  it("accepts a single large (8 MB) message with the default limits", async () => {
    const url = await start();
    const ws = await open(url, "paste");
    let closedWith: number | undefined;
    ws.once("close", (c) => (closedWith = c));
    // Not a valid Hocuspocus message, so it is ignored or rejected by Hocuspocus, never by the guard.
    const big = new Uint8Array(8 * 1024 * 1024);
    ws.send(big);
    await new Promise((r) => setTimeout(r, 300));
    expect(closedWith).not.toBe(RATE_LIMITED.code);
  });
});
