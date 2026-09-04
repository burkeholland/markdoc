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
  closeAttempts = 0;
  terminationAttempts = 0;
  terminations = 0;
  closeError?: Error;
  terminateError?: Error;
  acknowledgeClose = false;

  close(code?: number, reason?: string) {
    this.closeAttempts++;
    if (this.closeError) throw this.closeError;
    this.closes.push({ code, reason });
    this.readyState = WebSocket.CLOSING;
    if (this.acknowledgeClose) {
      this.readyState = WebSocket.CLOSED;
      this.emit("close", code, Buffer.from(reason ?? ""));
    }
  }

  terminate() {
    this.terminationAttempts++;
    if (this.terminateError) throw this.terminateError;
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

  function deadline(options: {
    timeoutMs?: number;
    closeGraceMs?: number;
    now?: () => number;
    reportError?: (operation: "close" | "terminate") => void;
  } = {}) {
    const socket = new FakeSocket();
    const request = new EventEmitter();
    const settled = vi.fn();
    const reportError = options.reportError ?? vi.fn();
    const lifecycle = createCollabPreAuthenticationDeadline(asSocket(socket), {
      request: asRequest(request),
      timeoutMs: options.timeoutMs,
      closeGraceMs: options.closeGraceMs ?? COLLAB_PRE_AUTHENTICATION_CLOSE_GRACE_MS,
      onSettled: settled,
      now: options.now,
      reportError,
    });
    return { socket, request, settled, lifecycle, reportError };
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
    let now = 0;
    const subject = deadline({ now: () => now });

    vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS - 1);
    now = COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS - 1;
    expect(subject.lifecycle.accepted()).toBe(true);
    vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS * 2);

    expect(subject.socket.closes).toEqual([]);
    expect(subject.settled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not revive a valid authentication result delivered after the deadline", () => {
    const subject = deadline();

    vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS);
    expect(subject.lifecycle.accepted()).toBe(false);
    vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_CLOSE_GRACE_MS);

    expect(subject.socket.closes).toEqual([{ code: 4401, reason: "Unauthorized" }]);
    expect(subject.socket.terminations).toBe(1);
    expect(subject.settled).toHaveBeenCalledTimes(1);
  });

  it.each([
    [2_999, "acceptance-first", true],
    [2_999, "timer-first", true],
    [3_000, "acceptance-first", false],
    [3_000, "timer-first", false],
    [3_001, "acceptance-first", false],
    [3_001, "timer-first", false],
  ] as const)(
    "uses the absolute 3,000 ms boundary at %i ms with %s callback order",
    (elapsed, order, accepted) => {
      let now = 0;
      const subject = deadline({ now: () => now });
      now = elapsed;

      if (order === "timer-first") vi.advanceTimersByTime(Math.min(elapsed, COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS));
      expect(subject.lifecycle.accepted()).toBe(accepted);
      vi.runAllTimers();

      expect(subject.socket.closes).toEqual(
        accepted ? [] : [{ code: 4401, reason: "Unauthorized" }],
      );
      expect(subject.socket.terminationAttempts).toBe(accepted ? 0 : 1);
      expect(subject.settled).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ["deadline", () => vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS)],
    ["explicit rejection", (subject: ReturnType<typeof deadline>) => {
      subject.lifecycle.rejected();
      vi.runOnlyPendingTimers();
    }],
  ])("reports and contains synchronous close and terminate failures on %s", (_owner, trigger) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const socket = new FakeSocket();
      const request = new EventEmitter();
      const settled = vi.fn();
      socket.closeError = new Error("sensitive close detail");
      socket.terminateError = new Error("sensitive terminate detail");
      const lifecycle = createCollabPreAuthenticationDeadline(asSocket(socket), {
        request: asRequest(request),
        onSettled: settled,
      });
      const direct = { socket, request, settled, lifecycle, reportError: vi.fn() };

      expect(() => trigger(direct)).not.toThrow();
      expect(direct.socket.closeAttempts).toBe(1);
      expect(direct.socket.terminationAttempts).toBe(1);
      expect(direct.settled).toHaveBeenCalledTimes(1);
      expect(error.mock.calls).toEqual([
        ["[collab] pre-authentication socket close failed"],
        ["[collab] pre-authentication socket terminate failed"],
      ]);
      expect(JSON.stringify(error.mock.calls)).not.toContain("sensitive");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      error.mockRestore();
    }
  });

  it.each([
    ["deadline", () => vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS)],
    ["explicit rejection", (subject: ReturnType<typeof deadline>) => {
      subject.lifecycle.rejected();
      vi.runOnlyPendingTimers();
    }],
  ])("hard-terminates and cleans up when close alone throws on %s", (_owner, trigger) => {
    const subject = deadline();
    subject.socket.closeError = new Error("close failed");

    expect(() => trigger(subject)).not.toThrow();

    expect(subject.socket.closeAttempts).toBe(1);
    expect(subject.socket.terminationAttempts).toBe(1);
    expect(subject.socket.terminations).toBe(1);
    expect(subject.reportError).toHaveBeenCalledTimes(1);
    expect(subject.reportError).toHaveBeenCalledWith("close");
    expect(subject.settled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["socket error", (subject: ReturnType<typeof deadline>) => subject.socket.emit("error", new Error("socket failed"))],
    ["request abort", (subject: ReturnType<typeof deadline>) => subject.request.emit("aborted")],
    ["binding abort", (subject: ReturnType<typeof deadline>) => subject.lifecycle.abort()],
  ])("contains a synchronous terminate failure during %s cleanup", (_owner, trigger) => {
    const subject = deadline();
    subject.socket.terminateError = new Error("terminate failed");

    expect(() => trigger(subject)).not.toThrow();

    expect(subject.socket.terminationAttempts).toBe(1);
    expect(subject.settled).toHaveBeenCalledTimes(1);
    expect(subject.reportError).toHaveBeenCalledWith("terminate");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains a synchronous terminate failure when close grace expires", () => {
    const subject = deadline();
    subject.socket.terminateError = new Error("terminate failed");

    expect(() => {
      vi.advanceTimersByTime(
        COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS + COLLAB_PRE_AUTHENTICATION_CLOSE_GRACE_MS,
      );
    }).not.toThrow();

    expect(subject.socket.closes).toEqual([{ code: 4401, reason: "Unauthorized" }]);
    expect(subject.socket.terminationAttempts).toBe(1);
    expect(subject.settled).toHaveBeenCalledTimes(1);
    expect(subject.reportError).toHaveBeenCalledWith("terminate");
    expect(vi.getTimerCount()).toBe(0);
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

  it("releases all ownership state after 25,000 deterministic lifecycle cases", () => {
    const reports = { close: 0, terminate: 0 };
    let cases = 0;
    let wrongAcceptance = 0;
    let retainedListeners = 0;
    let wrongSettlements = 0;
    let doubleTermination = 0;
    let postSettlementChanges = 0;

    for (let batch = 0; batch < 10; batch++) {
      const subjects = Array.from({ length: 2_500 }, (_, offset) => {
        const index = batch * 2_500 + offset;
        const socket = new FakeSocket();
        const request = new EventEmitter();
        let settlements = 0;
        let now = 0;
        const lifecycle = createCollabPreAuthenticationDeadline(asSocket(socket), {
          request: asRequest(request),
          closeGraceMs: COLLAB_PRE_AUTHENTICATION_CLOSE_GRACE_MS,
          now: () => now,
          onSettled: () => settlements++,
          reportError: (operation) => reports[operation]++,
        });

        switch (index % 10) {
          case 0:
            now = COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS - 1;
            if (!lifecycle.accepted()) wrongAcceptance++;
            break;
          case 1:
            now = COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS;
            if (lifecycle.accepted()) wrongAcceptance++;
            break;
          case 2:
            socket.readyState = WebSocket.CLOSED;
            socket.emit("close", 1000, Buffer.alloc(0));
            break;
          case 3:
            lifecycle.abort();
            break;
          case 4:
            socket.acknowledgeClose = true;
            lifecycle.rejected();
            break;
          case 5:
            break;
          case 6:
            socket.emit("error", new Error("injected socket error"));
            break;
          case 7:
            request.emit("aborted");
            break;
          case 8:
            socket.closeError = new Error("injected close error");
            break;
          case 9:
            socket.closeError = new Error("injected close error");
            socket.terminateError = new Error("injected terminate error");
            break;
        }
        return { socket, request, lifecycle, settlements: () => settlements };
      });

      vi.runAllTimers();
      expect(vi.getTimerCount()).toBe(0);
      cases += subjects.length;

      for (const subject of subjects) {
        retainedListeners +=
          subject.socket.listenerCount("close") +
          subject.socket.listenerCount("error") +
          subject.request.listenerCount("aborted");
        if (subject.settlements() !== 1) wrongSettlements++;
        if (subject.socket.closeAttempts > 1 || subject.socket.terminationAttempts > 1) {
          doubleTermination++;
        }
        const before = [
          subject.socket.closeAttempts,
          subject.socket.terminationAttempts,
          subject.settlements(),
        ];
        if (subject.lifecycle.accepted()) wrongAcceptance++;
        subject.lifecycle.rejected();
        subject.lifecycle.abort();
        const after = [
          subject.socket.closeAttempts,
          subject.socket.terminationAttempts,
          subject.settlements(),
        ];
        if (before.some((value, index) => value !== after[index])) postSettlementChanges++;
      }
    }

    expect(cases).toBe(25_000);
    expect(wrongAcceptance).toBe(0);
    expect(retainedListeners).toBe(0);
    expect(wrongSettlements).toBe(0);
    expect(doubleTermination).toBe(0);
    expect(postSettlementChanges).toBe(0);
    expect(reports).toEqual({ close: 5_000, terminate: 2_500 });
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

  it("continues binding shutdown across 50 pending sockets whose termination throws", async () => {
    const server = createServer();
    const hocuspocus = new Hocuspocus({ quiet: true });
    const shutdown = new AbortController();
    const attachment = attachCollab(server, hocuspocus, { signal: shutdown.signal });
    const serverSockets: { socket: WebSocket; terminate: () => void }[] = [];
    attachment.on("connection", (socket) => {
      serverSockets.push({ socket, terminate: socket.terminate.bind(socket) });
      socket.terminate = () => {
        throw new Error("injected termination failure");
      };
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`;
    const clients = Array.from({ length: 50 }, () => new WebSocket(url));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      await Promise.all(
        clients.map(
          (client) =>
            new Promise<void>((resolve, reject) => {
              client.once("open", resolve);
              client.once("error", reject);
            }),
        ),
      );
      expect(attachment.getPendingAuthenticationCount()).toBe(50);

      expect(() => shutdown.abort()).not.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(attachment.getPendingAuthenticationCount()).toBe(0);
      expect(
        error.mock.calls.filter(
          (call) => call[0] === "[collab] pre-authentication socket terminate failed",
        ),
      ).toHaveLength(50);
      expect(serverSockets).toHaveLength(50);
      expect(unhandled).toEqual([]);
    } finally {
      for (const { socket, terminate } of serverSockets) {
        socket.terminate = terminate;
        if (socket.readyState !== WebSocket.CLOSED) terminate();
      }
      for (const client of clients) {
        if (client.readyState !== WebSocket.CLOSED) client.terminate();
      }
      await waitFor(() => attachment.clients.size === 0);
      const final = {
        clients: attachment.clients.size,
        pending: attachment.getPendingAuthenticationCount(),
        documents: hocuspocus.getDocumentsCount(),
        connections: hocuspocus.getConnectionsCount(),
      };
      error.mockRestore();
      await new Promise<void>((resolve) => attachment.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      process.off("unhandledRejection", onUnhandled);
      expect(final).toEqual({ clients: 0, pending: 0, documents: 0, connections: 0 });
      expect(unhandled).toEqual([]);
    }
  });
});

describe("collaboration attachment first frames", () => {
  const timeoutMs = 500;

  async function startAttachment(options: { timeoutMs?: number; closeGraceMs?: number } = {}) {
    const server = createServer();
    const hocuspocus = new Hocuspocus({
      quiet: true,
      async onAuthenticate({ token, context, documentName }) {
        const lifecycle = (context as { preAuthentication?: { accepted(): boolean; rejected(): void } }).preAuthentication;
        try {
          if (token === "revoked") throw new Error("revoked token");
          if (token.startsWith("valid:") && token !== `valid:${documentName}`) {
            throw new Error("token does not match document");
          }
          if (token !== "valid" && token !== `valid:${documentName}`) throw new Error("invalid token");
          if (documentName === "missing") throw new Error("invalid document");
          if (lifecycle && !lifecycle.accepted()) throw new Error("authentication deadline expired");
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

  it("physically reclaims 100 silent, malformed-token, document-mismatch and revoked-token peers", async () => {
    const site = await startAttachment({ timeoutMs: 100, closeGraceMs: 100 });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const classes = [
      { name: "silent", frame: () => undefined },
      {
        name: "malformed-token",
        frame: (index: number) => authenticationFrame(`matrix-malformed-${index}`, "not-a-token"),
      },
      {
        name: "document-mismatch",
        frame: (index: number) => authenticationFrame(`matrix-mismatch-${index}`, "valid:another-document"),
      },
      {
        name: "revoked-token",
        frame: (index: number) => authenticationFrame(`matrix-revoked-${index}`, "revoked"),
      },
    ] as const;
    const timing: { name: string; median: number; p95: number; max: number }[] = [];

    try {
      for (const hostileClass of classes) {
        const results = await Promise.all(
          Array.from({ length: 100 }, (_, index) =>
            nonCooperativeRawPeer(site.url, hostileClass.frame(index)),
          ),
        );
        for (const result of results) {
          const closes = result.frames.filter((frame) => frame.opcode === 8);
          expect(closes).toHaveLength(1);
          expect(closePayload(closes[0])).toEqual({ code: 4401, reason: "Unauthorized" });
          expect(result.reclaimMs).toBeLessThan(5_000);
        }
        const durations = results.map((result) => result.reclaimMs).sort((a, b) => a - b);
        timing.push({
          name: hostileClass.name,
          median: durations[Math.floor(durations.length / 2)],
          p95: durations[Math.ceil(durations.length * 0.95) - 1],
          max: durations[durations.length - 1],
        });
      }

      await waitFor(() => site.attachment.clients.size === 0);
      expect(site.attachment.getPendingAuthenticationCount()).toBe(0);
      expect(site.hocuspocus.getDocumentsCount()).toBe(0);
      expect(site.hocuspocus.getConnectionsCount()).toBe(0);
      if (process.env.COLLAB_TIMING_REPORT === "1") {
        console.info(
          `[collab raw timing] ${timing
            .map((row) => `${row.name}: median=${row.median}ms p95=${row.p95}ms max=${row.max}ms`)
            .join("; ")}`,
        );
      }
    } finally {
      error.mockRestore();
      await site.close();
    }
  });
});
