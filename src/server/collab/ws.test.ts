import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { connect as connectTcp } from "node:net";
import { Hocuspocus } from "@hocuspocus/server";
import * as encoding from "lib0/encoding";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachCollab,
  COLLAB_PRE_AUTHENTICATION_CLOSE_GRACE_MS,
  COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS,
  createCollabPreAuthenticationDeadline,
} from "./ws";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly closes: { code?: number; reason?: string }[] = [];
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

const asSocket = (socket: FakeSocket) => socket as unknown as WebSocket;
const asRequest = (request: EventEmitter) => request as unknown as Pick<IncomingMessage, "off" | "once">;

interface RawServerFrame {
  opcode: number;
  payload: Buffer;
}

function maskedBinaryFrame(payload: Uint8Array): Buffer {
  if (payload.byteLength >= 126) throw new Error("test frame is unexpectedly large");
  const mask = randomBytes(4);
  const frame = Buffer.alloc(6 + payload.byteLength);
  frame[0] = 0x82;
  frame[1] = 0x80 | payload.byteLength;
  mask.copy(frame, 2);
  payload.forEach((byte, index) => {
    frame[6 + index] = byte ^ mask[index % 4];
  });
  return frame;
}

function parseServerFrames(bytes: Buffer): RawServerFrame[] {
  const frames: RawServerFrame[] = [];
  let offset = 0;
  while (offset + 2 <= bytes.length) {
    const opcode = bytes[offset] & 0x0f;
    const masked = (bytes[offset + 1] & 0x80) !== 0;
    let length = bytes[offset + 1] & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (offset + 4 > bytes.length) break;
      length = bytes.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      throw new Error("test server frame is unexpectedly large");
    }
    const maskLength = masked ? 4 : 0;
    const end = offset + headerLength + maskLength + length;
    if (end > bytes.length) break;
    const payload = Buffer.from(bytes.subarray(offset + headerLength + maskLength, end));
    if (masked) {
      const mask = bytes.subarray(offset + headerLength, offset + headerLength + 4);
      payload.forEach((byte, index) => {
        payload[index] = byte ^ mask[index % 4];
      });
    }
    frames.push({ opcode, payload });
    offset = end;
  }
  if (offset !== bytes.length) throw new Error(`incomplete server frame (${bytes.length - offset} bytes remain)`);
  return frames;
}

async function nonCooperativeRawPeer(url: string, applicationFrame?: Uint8Array) {
  const target = new URL(url);
  const socket = connectTcp({ host: target.hostname, port: Number(target.port) });
  let response = Buffer.alloc(0);
  let frameBytes = Buffer.alloc(0);
  let responseHead = "";
  let upgradedAt = 0;
  let resolveUpgrade!: () => void;
  let rejectUpgrade!: (error: Error) => void;
  const upgraded = new Promise<void>((resolve, reject) => {
    resolveUpgrade = resolve;
    rejectUpgrade = reject;
  });
  socket.on("error", (error) => {
    if (!upgradedAt) rejectUpgrade(error);
  });
  socket.on("data", (chunk: Buffer) => {
    if (upgradedAt) {
      frameBytes = Buffer.concat([frameBytes, chunk]);
      return;
    }
    response = Buffer.concat([response, chunk]);
    const end = response.indexOf("\r\n\r\n");
    if (end < 0) return;
    responseHead = response.subarray(0, end).toString("latin1");
    frameBytes = response.subarray(end + 4);
    upgradedAt = Date.now();
    resolveUpgrade();
  });
  const closed = new Promise<number>((resolve) => {
    socket.once("close", () => resolve(Date.now()));
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const key = randomBytes(16).toString("base64");
  socket.write(
    [
      `GET ${target.pathname} HTTP/1.1`,
      `Host: ${target.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );

  const upgradeTimeout = setTimeout(() => {
    socket.destroy();
    rejectUpgrade(new Error("raw WebSocket upgrade timed out"));
  }, 1_000);
  upgradeTimeout.unref();
  try {
    await upgraded;
  } finally {
    clearTimeout(upgradeTimeout);
  }
  if (!/^HTTP\/1\.1 101 Switching Protocols\r?$/m.test(responseHead)) {
    socket.destroy();
    throw new Error(`raw WebSocket did not receive 101: ${responseHead.split(/\r?\n/, 1)[0] ?? "empty response"}`);
  }
  if (applicationFrame) socket.write(maskedBinaryFrame(applicationFrame));

  let physicalCloseAt: number;
  const closeTimeout = setTimeout(() => socket.destroy(), 5_000);
  closeTimeout.unref();
  try {
    physicalCloseAt = await closed;
  } finally {
    clearTimeout(closeTimeout);
    socket.destroy();
  }
  return {
    frames: parseServerFrames(frameBytes),
    reclaimMs: physicalCloseAt - upgradedAt,
  };
}

function closePayload(frame: RawServerFrame): { code: number; reason: string } {
  return {
    code: frame.payload.readUInt16BE(0),
    reason: frame.payload.subarray(2).toString(),
  };
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= until) throw new Error("timed out waiting for test state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("collaboration pre-authentication deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function deadline(timeoutMs = COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS) {
    const socket = new FakeSocket();
    const request = new EventEmitter();
    const settled = vi.fn();
    const lifecycle = createCollabPreAuthenticationDeadline(asSocket(socket), {
      request: asRequest(request),
      timeoutMs,
      closeGraceMs: COLLAB_PRE_AUTHENTICATION_CLOSE_GRACE_MS,
      onSettled: settled,
    });
    return { socket, request, settled, lifecycle };
  }

  it("closes at the absolute deadline and terminates a peer that ignores it after the hard-close grace", () => {
    const subject = deadline();

    vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS - 1);
    expect(subject.socket.closes).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(subject.socket.closes).toEqual([{ code: 4401, reason: "Unauthorized" }]);
    expect(subject.settled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_CLOSE_GRACE_MS);

    expect(subject.socket.terminations).toBe(1);
    expect(subject.settled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(subject.socket.listenerCount("close")).toBe(0);
    expect(subject.socket.listenerCount("error")).toBe(0);
    expect(subject.request.listenerCount("aborted")).toBe(0);
  });

  it.each(["partial application message", "fragmented transport message", "malformed application message"])(
    "does not authorize on a %s",
    () => {
      const subject = deadline();

      subject.socket.emit("message", Buffer.from([0x80]));
      vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS + COLLAB_PRE_AUTHENTICATION_CLOSE_GRACE_MS);

      expect(subject.socket.closes).toEqual([{ code: 4401, reason: "Unauthorized" }]);
      expect(subject.socket.terminations).toBe(1);
      expect(subject.settled).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts valid authentication just before the deadline and stays idle beyond it", () => {
    const subject = deadline();

    vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS - 1);
    subject.lifecycle.accepted();
    vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS * 2);

    expect(subject.socket.closes).toEqual([]);
    expect(subject.settled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not revive a valid authentication result delivered after the deadline", () => {
    const subject = deadline();

    vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS);
    subject.lifecycle.accepted();
    vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_CLOSE_GRACE_MS);

    expect(subject.socket.closes).toEqual([{ code: 4401, reason: "Unauthorized" }]);
    expect(subject.socket.terminations).toBe(1);
    expect(subject.settled).toHaveBeenCalledTimes(1);
  });

  it("lets authentication win exactly at the boundary when its acceptance callback runs first", () => {
    const subject = deadline();

    vi.setSystemTime(Date.now() + COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS);
    subject.lifecycle.accepted();
    vi.runOnlyPendingTimers();

    expect(subject.socket.closes).toEqual([]);
    expect(subject.settled).toHaveBeenCalledTimes(1);
  });

  it.each(["invalid token", "missing document", "forbidden document"])(
    "clears the deadline and closes 4401 after Hocuspocus rejects a %s",
    async () => {
      const subject = deadline();

      subject.lifecycle.rejected();
      await vi.runAllTimersAsync();

      expect(subject.socket.closes).toEqual([{ code: 4401, reason: "Unauthorized" }]);
      expect(subject.socket.terminations).toBe(1);
      expect(subject.settled).toHaveBeenCalledTimes(1);
      expect(subject.socket.listenerCount("close")).toBe(0);
      expect(subject.socket.listenerCount("error")).toBe(0);
      expect(subject.request.listenerCount("aborted")).toBe(0);
    },
  );

  it("cleans up once when the socket closes before authentication", () => {
    const subject = deadline();

    subject.socket.readyState = WebSocket.CLOSED;
    subject.socket.emit("close", 1000, Buffer.alloc(0));
    subject.lifecycle.abort();

    expect(subject.settled).toHaveBeenCalledTimes(1);
    expect(subject.socket.terminations).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up and destroys a socket error before authentication", () => {
    const subject = deadline();

    subject.socket.emit("error", new Error("test socket failure"));
    subject.lifecycle.abort();

    expect(subject.settled).toHaveBeenCalledTimes(1);
    expect(subject.socket.terminations).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up and destroys a request aborted before authentication", () => {
    const subject = deadline();

    subject.request.emit("aborted");
    subject.lifecycle.abort();

    expect(subject.settled).toHaveBeenCalledTimes(1);
    expect(subject.socket.terminations).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up an explicit binding shutdown before authentication", () => {
    const subject = deadline();

    subject.lifecycle.abort();
    subject.lifecycle.accepted();
    subject.lifecycle.rejected();

    expect(subject.settled).toHaveBeenCalledTimes(1);
    expect(subject.socket.terminations).toBe(1);
    expect(subject.socket.closes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a deferred rejection close when shutdown immediately terminates the socket", () => {
    const subject = deadline();

    subject.lifecycle.rejected();
    subject.lifecycle.abort();
    vi.runAllTimers();

    expect(subject.socket.closes).toEqual([]);
    expect(subject.socket.terminations).toBe(1);
    expect(subject.settled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["CLOSING", WebSocket.CLOSING, 1],
    ["CLOSED", WebSocket.CLOSED, 0],
  ])("settles a socket already %s when the deadline wins", (_name, readyState, terminations) => {
    const subject = deadline();
    subject.socket.readyState = readyState;

    vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS + COLLAB_PRE_AUTHENTICATION_CLOSE_GRACE_MS);

    expect(subject.socket.closes).toEqual([]);
    expect(subject.socket.terminations).toBe(terminations);
    expect(subject.settled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases every timer, listener and socket reference after 10,000 bare sockets", () => {
    const subjects = Array.from({ length: 10_000 }, () => deadline());
    expect(vi.getTimerCount()).toBe(10_000);

    subjects.forEach((subject, index) => {
      if (index % 5 === 0) subject.lifecycle.accepted();
      else if (index % 5 === 1) subject.socket.emit("close", 1000, Buffer.alloc(0));
      else if (index % 5 === 2) subject.lifecycle.abort();
      else if (index % 5 === 3) subject.lifecycle.rejected();
    });
    vi.runAllTimers();

    expect(vi.getTimerCount()).toBe(0);
    expect(subjects.reduce((count, subject) => count + subject.socket.listenerCount("close") + subject.socket.listenerCount("error"), 0)).toBe(0);
    expect(subjects.reduce((count, subject) => count + subject.request.listenerCount("aborted"), 0)).toBe(0);
    expect(subjects.every((subject) => subject.settled.mock.calls.length === 1)).toBe(true);
  });
});

describe("collaboration attachment shutdown", () => {
  it("destroys a bare upgraded socket when server shutdown starts", async () => {
    const server = createServer();
    const hocuspocus = new Hocuspocus({ quiet: true });
    const shutdown = new AbortController();
    attachCollab(server, hocuspocus, { signal: shutdown.signal });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`);
    const closed = new Promise<number>((resolve, reject) => {
      client.once("close", resolve);
      client.once("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });

    shutdown.abort();
    expect(await closed).toBe(1006);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("destroys a bare upgraded socket when the attachment closes directly", async () => {
    const server = createServer();
    const hocuspocus = new Hocuspocus({ quiet: true });
    const attachment = attachCollab(server, hocuspocus);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`);
    const closed = new Promise<number>((resolve, reject) => {
      client.once("close", resolve);
      client.once("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });

    const attachmentClosed = new Promise<void>((resolve, reject) => {
      attachment.close((error) => error ? reject(error) : resolve());
    });
    expect(await closed).toBe(1006);
    await attachmentClosed;
    expect(attachment.clients.size).toBe(0);
    expect(attachment.getPendingAuthenticationCount()).toBe(0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe("collaboration attachment first frames", () => {
  const timeoutMs = 500;

  async function startAttachment(options: { timeoutMs?: number; closeGraceMs?: number } = {}) {
    const server = createServer();
    const hocuspocus = new Hocuspocus({
      quiet: true,
      async onAuthenticate({ token, context, documentName }) {
        const lifecycle = (context as { preAuthentication?: { accepted(): void; rejected(): void } }).preAuthentication;
        try {
          if (token !== "valid") throw new Error("invalid token");
          if (documentName === "missing") throw new Error("invalid document");
          lifecycle?.accepted();
          return {};
        } catch (error) {
          lifecycle?.rejected();
          throw error;
        } finally {
          delete (context as { preAuthentication?: unknown }).preAuthentication;
        }
      },
    });
    const attachment = attachCollab(
      server,
      hocuspocus as unknown as Parameters<typeof attachCollab>[1],
      {
        preAuthenticationTimeoutMs: options.timeoutMs ?? timeoutMs,
        preAuthenticationCloseGraceMs: options.closeGraceMs,
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      attachment,
      hocuspocus,
      server,
      url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`,
      async close() {
        for (const socket of attachment.clients) socket.terminate();
        hocuspocus.closeConnections();
        await new Promise<void>((resolve) => attachment.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  function authenticationFrame(documentName: string, token: string): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarString(encoder, documentName);
    encoding.writeVarUint(encoder, 2);
    encoding.writeVarUint(encoder, 0);
    encoding.writeVarString(encoder, token);
    return encoding.toUint8Array(encoder);
  }

  function open(url: string): Promise<WebSocket> {
    const socket = new WebSocket(url);
    return new Promise((resolve, reject) => {
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
  }

  function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      socket.once("error", reject);
    });
  }

  it("keeps an incomplete Hocuspocus message unauthenticated and preserves its malformed-message close", async () => {
    const site = await startAttachment();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const socket = await open(site.url);
      const close = closed(socket);
      socket.send(Buffer.from([0]));
      expect(await close).toEqual({ code: 4205, reason: "Reset Connection" });
      expect(site.hocuspocus.getConnectionsCount()).toBe(0);
    } finally {
      error.mockRestore();
      await site.close();
    }
  });

  it("cleans the deadline when a malformed address closes unauthorized", async () => {
    const site = await startAttachment();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const socket = await open(site.url);
      const close = closed(socket);
      socket.send(Buffer.from([0x80]));
      expect(await close).toEqual({ code: 4401, reason: "Unauthorized" });
      expect(site.hocuspocus.getConnectionsCount()).toBe(0);
    } finally {
      error.mockRestore();
      await site.close();
    }
  });

  it("does not treat an unfinished fragmented authentication frame as authentication", async () => {
    const site = await startAttachment();
    try {
      const socket = await open(site.url);
      const close = closed(socket);
      const frame = authenticationFrame("fragmented", "valid");
      socket.send(frame.subarray(0, Math.ceil(frame.byteLength / 2)), { binary: true, fin: false });
      expect(await close).toEqual({ code: 4401, reason: "Unauthorized" });
      expect(site.hocuspocus.getDocumentsCount()).toBe(0);
      expect(site.hocuspocus.getConnectionsCount()).toBe(0);
    } finally {
      await site.close();
    }
  });

  it("accepts a delayed valid auth frame and leaves the authenticated socket idle past the deadline", async () => {
    const site = await startAttachment();
    try {
      const socket = await open(site.url);
      await new Promise((resolve) => setTimeout(resolve, timeoutMs / 2));
      socket.send(authenticationFrame("delayed-valid", "valid"));
      await new Promise<void>((resolve, reject) => {
        socket.once("message", () => resolve());
        socket.once("error", reject);
      });
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      expect(socket.readyState).toBe(WebSocket.OPEN);
      expect(site.hocuspocus.getDocumentsCount()).toBe(1);
      expect(site.hocuspocus.getConnectionsCount()).toBe(1);
      socket.close();
      await closed(socket);
    } finally {
      await site.close();
    }
  });

  it("physically reclaims a bare raw peer that never acknowledges the 4401 close", async () => {
    const site = await startAttachment({
      timeoutMs: COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS,
      closeGraceMs: COLLAB_PRE_AUTHENTICATION_CLOSE_GRACE_MS,
    });
    let serverSocket: WebSocket | undefined;
    let deadlineListenerCounts: { close: number; error: number } | undefined;
    site.attachment.once("connection", (socket) => {
      serverSocket = socket;
      deadlineListenerCounts = {
        close: socket.listenerCount("close"),
        error: socket.listenerCount("error"),
      };
    });
    try {
      const result = await nonCooperativeRawPeer(site.url);
      const closeFrames = result.frames.filter((frame) => frame.opcode === 8);

      expect(result.reclaimMs).toBeGreaterThanOrEqual(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS);
      expect(result.reclaimMs).toBeLessThan(5_000);
      expect(closeFrames).toHaveLength(1);
      expect(closePayload(closeFrames[0])).toEqual({ code: 4401, reason: "Unauthorized" });
      await waitFor(() => site.attachment.clients.size === 0);
      expect(serverSocket?.readyState).toBe(WebSocket.CLOSED);
      expect(site.attachment.getPendingAuthenticationCount()).toBe(0);
      expect(serverSocket!.listenerCount("close")).toBeLessThan(deadlineListenerCounts!.close);
      expect(serverSocket!.listenerCount("error")).toBeLessThan(deadlineListenerCounts!.error);
    } finally {
      await site.close();
    }
  });

  it.each([
    ["invalid token", "raw-rejected", "invalid"],
    ["invalid document", "missing", "valid"],
  ])("physically reclaims a noncooperative raw peer after %s rejection", async (_case, documentName, token) => {
    const site = await startAttachment({
      timeoutMs: COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS,
      closeGraceMs: COLLAB_PRE_AUTHENTICATION_CLOSE_GRACE_MS,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let serverSocket: WebSocket | undefined;
    site.attachment.once("connection", (socket) => {
      serverSocket = socket;
    });
    try {
      const result = await nonCooperativeRawPeer(site.url, authenticationFrame(documentName, token));
      const closeFrames = result.frames.filter((frame) => frame.opcode === 8);

      expect(result.reclaimMs).toBeLessThan(5_000);
      expect(closeFrames).toHaveLength(1);
      expect(closePayload(closeFrames[0])).toEqual({ code: 4401, reason: "Unauthorized" });
      await waitFor(() => site.attachment.clients.size === 0);
      expect(serverSocket?.readyState).toBe(WebSocket.CLOSED);
      expect(site.attachment.getPendingAuthenticationCount()).toBe(0);
      expect(site.hocuspocus.getConnectionsCount()).toBe(0);
    } finally {
      error.mockRestore();
      await site.close();
    }
  });
});
