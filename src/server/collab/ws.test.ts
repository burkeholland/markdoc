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
  protectUpgradePath,
} from "./ws";
import { UNPARSEABLE_UPGRADE_ANSWER } from "../../../server/request-guards";

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
    reportError?: (operation: "close" | "terminate" | "abort") => void;
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

  it.each([
    {
      owner: "deadline close failure only",
      configure: (subject: ReturnType<typeof deadline>) => {
        subject.socket.closeError = new Error("deadline close detail");
      },
      trigger: () => vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS),
      operations: ["close"],
      closeAttempts: 1,
      terminationAttempts: 1,
    },
    {
      owner: "deadline callback",
      configure: (subject: ReturnType<typeof deadline>) => {
        subject.socket.closeError = new Error("deadline close detail");
        subject.socket.terminateError = new Error("deadline terminate detail");
      },
      trigger: (subject: ReturnType<typeof deadline>) => {
        vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS);
        return subject.lifecycle.accepted();
      },
      operations: ["close", "terminate"],
      closeAttempts: 1,
      terminationAttempts: 1,
    },
    {
      owner: "late authorization completion",
      configure: (subject: ReturnType<typeof deadline>) => {
        subject.socket.closeError = new Error("late close detail");
        subject.socket.terminateError = new Error("late terminate detail");
      },
      trigger: (subject: ReturnType<typeof deadline>) => subject.lifecycle.accepted(),
      operations: ["close", "terminate"],
      closeAttempts: 1,
      terminationAttempts: 1,
      now: COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS,
    },
    {
      owner: "explicit rejection",
      configure: (subject: ReturnType<typeof deadline>) => {
        subject.socket.closeError = new Error("rejection close detail");
        subject.socket.terminateError = new Error("rejection terminate detail");
      },
      trigger: (subject: ReturnType<typeof deadline>) => {
        subject.lifecycle.rejected();
        vi.runOnlyPendingTimers();
      },
      operations: ["close", "terminate"],
      closeAttempts: 1,
      terminationAttempts: 1,
    },
    {
      owner: "socket close",
      configure: () => {},
      trigger: (subject: ReturnType<typeof deadline>) => {
        subject.socket.readyState = WebSocket.CLOSED;
        subject.socket.emit("close", 1000, Buffer.alloc(0));
      },
      operations: [],
      closeAttempts: 0,
      terminationAttempts: 0,
    },
    {
      owner: "socket error",
      configure: (subject: ReturnType<typeof deadline>) => {
        subject.socket.terminateError = new Error("socket error termination detail");
      },
      trigger: (subject: ReturnType<typeof deadline>) =>
        subject.socket.emit("error", new Error("socket event detail")),
      operations: ["terminate"],
      closeAttempts: 0,
      terminationAttempts: 1,
    },
    {
      owner: "request abort",
      configure: (subject: ReturnType<typeof deadline>) => {
        subject.socket.terminateError = new Error("request termination detail");
      },
      trigger: (subject: ReturnType<typeof deadline>) => subject.request.emit("aborted"),
      operations: ["terminate"],
      closeAttempts: 0,
      terminationAttempts: 1,
    },
    {
      owner: "binding abort",
      configure: (subject: ReturnType<typeof deadline>) => {
        subject.socket.terminateError = new Error("binding termination detail");
      },
      trigger: (subject: ReturnType<typeof deadline>) => subject.lifecycle.abort(),
      operations: ["terminate"],
      closeAttempts: 0,
      terminationAttempts: 1,
    },
    {
      owner: "close grace",
      configure: (subject: ReturnType<typeof deadline>) => {
        subject.socket.terminateError = new Error("grace termination detail");
      },
      trigger: () =>
        vi.advanceTimersByTime(
          COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS + COLLAB_PRE_AUTHENTICATION_CLOSE_GRACE_MS,
        ),
      operations: ["terminate"],
      closeAttempts: 1,
      terminationAttempts: 1,
    },
  ])(
    "contains a throwing diagnostic sink for $owner",
    ({ configure, trigger, operations, closeAttempts, terminationAttempts, now }) => {
      let clock = 0;
      const reported: string[] = [];
      const subject = deadline({
        now: () => clock,
        reportError: (operation) => {
          reported.push(operation);
          throw new Error(`reporter rejected ${operation}`);
        },
      });
      clock = now ?? 0;
      configure(subject);

      expect(() => trigger(subject)).not.toThrow();
      expect(() => vi.runAllTimers()).not.toThrow();

      expect(reported).toEqual(operations);
      expect(subject.socket.closeAttempts).toBe(closeAttempts);
      expect(subject.socket.terminationAttempts).toBe(terminationAttempts);
      expect(subject.settled).toHaveBeenCalledTimes(1);
      expect(subject.socket.listenerCount("close")).toBe(0);
      expect(subject.socket.listenerCount("error")).toBe(0);
      expect(subject.request.listenerCount("aborted")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("contains a throwing default console diagnostic and still hard-terminates after close failure", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("stderr unavailable");
    });
    try {
      const socket = new FakeSocket();
      const request = new EventEmitter();
      const settled = vi.fn();
      socket.closeError = new Error("close detail");
      socket.terminateError = new Error("terminate detail");
      createCollabPreAuthenticationDeadline(asSocket(socket), {
        request: asRequest(request),
        onSettled: settled,
      });

      expect(() => vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS)).not.toThrow();
      expect(socket.closeAttempts).toBe(1);
      expect(socket.terminationAttempts).toBe(1);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      error.mockRestore();
    }
  });

  it("reports only sanitized operation labels to a non-throwing injected sink", () => {
    const reported: string[] = [];
    const subject = deadline({ reportError: (operation) => reported.push(operation) });
    subject.socket.closeError = new Error("credential user document request socket fixture");
    subject.socket.terminateError = new Error("second sensitive failure");

    vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS);

    expect(reported).toEqual(["close", "terminate"]);
    expect(JSON.stringify(reported)).not.toMatch(
      /credential|user|document|request|socket|fixture|sensitive/,
    );
  });

  it("ignores duplicate and reordered terminal callbacks after a throwing reporter settles once", () => {
    const subject = deadline({
      reportError: () => {
        throw new Error("diagnostic failure");
      },
    });
    subject.socket.terminateError = new Error("termination failure");

    expect(() => {
      subject.lifecycle.rejected();
      subject.lifecycle.abort();
      subject.lifecycle.accepted();
      subject.lifecycle.rejected();
      subject.lifecycle.abort();
      subject.socket.emit("close", 1000, Buffer.alloc(0));
      vi.runAllTimers();
    }).not.toThrow();

    expect(subject.socket.closeAttempts).toBe(0);
    expect(subject.socket.terminationAttempts).toBe(1);
    expect(subject.settled).toHaveBeenCalledTimes(1);
    expect(subject.socket.listenerCount("close")).toBe(0);
    expect(subject.socket.listenerCount("error")).toBe(0);
    expect(subject.request.listenerCount("aborted")).toBe(0);
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

  describe("releases all ownership state after 30,000 deterministic lifecycle and boundary cases", () => {
    const subjectsPerPlan = 2_500;
    const boundaryPlans = [
      {
        name: "2,999 ms acceptance-first boundary",
        kind: "boundary",
        elapsed: 2_999,
        timerFirst: false,
        accepted: true,
        expectedReportsPerSubject: 0,
      },
      {
        name: "2,999 ms timer-first boundary",
        kind: "boundary",
        elapsed: 2_999,
        timerFirst: true,
        accepted: true,
        expectedReportsPerSubject: 0,
      },
      {
        name: "3,000 ms acceptance-first boundary",
        kind: "boundary",
        elapsed: 3_000,
        timerFirst: false,
        accepted: false,
        expectedReportsPerSubject: 0,
      },
      {
        name: "3,000 ms timer-first boundary",
        kind: "boundary",
        elapsed: 3_000,
        timerFirst: true,
        accepted: false,
        expectedReportsPerSubject: 0,
      },
      {
        name: "3,001 ms acceptance-first boundary",
        kind: "boundary",
        elapsed: 3_001,
        timerFirst: false,
        accepted: false,
        expectedReportsPerSubject: 0,
      },
      {
        name: "3,001 ms timer-first boundary",
        kind: "boundary",
        elapsed: 3_001,
        timerFirst: true,
        accepted: false,
        expectedReportsPerSubject: 0,
      },
    ] as const;
    const terminalPlans = [
      {
        name: "socket close terminal",
        kind: "terminal",
        terminal: "socket-close",
        expectedReportsPerSubject: 0,
      },
      {
        name: "binding abort terminal",
        kind: "terminal",
        terminal: "binding-abort",
        expectedReportsPerSubject: 0,
      },
      {
        name: "socket error with termination failure",
        kind: "terminal",
        terminal: "socket-error",
        expectedReportsPerSubject: 1,
      },
      {
        name: "request abort with termination failure",
        kind: "terminal",
        terminal: "request-abort",
        expectedReportsPerSubject: 1,
      },
      {
        name: "acknowledged rejection close",
        kind: "terminal",
        terminal: "acknowledged-rejection",
        expectedReportsPerSubject: 0,
      },
      {
        name: "deadline with close and termination failures",
        kind: "terminal",
        terminal: "deadline-errors",
        expectedReportsPerSubject: 2,
      },
    ] as const;
    const plans = [...boundaryPlans, ...terminalPlans] as const;

    it("defines six boundary and six terminal plans totaling exactly 30,000 cases", () => {
      expect(boundaryPlans).toHaveLength(6);
      expect(terminalPlans).toHaveLength(6);
      expect(plans).toHaveLength(12);
      expect(plans.length * subjectsPerPlan).toBe(30_000);
      expect(
        plans.reduce(
          (total, plan) => total + plan.expectedReportsPerSubject * subjectsPerPlan,
          0,
        ),
      ).toBe(10_000);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(plans)(
      "releases all ownership state for $name across 2,500 deterministic cases",
      (plan) => {
        let reportInvocations = 0;
        let cases = 0;
        let wrongAcceptance = 0;
        let retainedListeners = 0;
        let wrongSettlements = 0;
        let doubleTermination = 0;
        let postSettlementChanges = 0;

        const subjects = Array.from({ length: subjectsPerPlan }, () => {
          const socket = new FakeSocket();
          const request = new EventEmitter();
          let settlements = 0;
          let now = 0;
          const lifecycle = createCollabPreAuthenticationDeadline(asSocket(socket), {
            request: asRequest(request),
            closeGraceMs: COLLAB_PRE_AUTHENTICATION_CLOSE_GRACE_MS,
            now: () => now,
            onSettled: () => settlements++,
            reportError: () => {
              reportInvocations++;
              throw new Error("injected diagnostic failure");
            },
          });
          return {
            socket,
            request,
            lifecycle,
            settlements: () => settlements,
            setNow: (value: number) => {
              now = value;
            },
          };
        });

        if (plan.kind === "boundary") {
          for (const subject of subjects) subject.setNow(plan.elapsed);
          if (plan.timerFirst) vi.advanceTimersByTime(plan.elapsed);
          for (const subject of subjects) {
            if (subject.lifecycle.accepted() !== plan.accepted) wrongAcceptance++;
          }
        } else {
          for (const subject of subjects) {
            switch (plan.terminal) {
              case "socket-close":
                subject.socket.readyState = WebSocket.CLOSED;
                subject.socket.emit("close", 1000, Buffer.alloc(0));
                break;
              case "binding-abort":
                subject.lifecycle.abort();
                break;
              case "socket-error":
                subject.socket.terminateError = new Error("injected socket-error termination");
                subject.socket.emit("error", new Error("injected socket error"));
                break;
              case "request-abort":
                subject.socket.terminateError = new Error("injected request-abort termination");
                subject.request.emit("aborted");
                break;
              case "acknowledged-rejection":
                subject.socket.acknowledgeClose = true;
                subject.lifecycle.rejected();
                break;
              case "deadline-errors":
                subject.socket.closeError = new Error("injected close error");
                subject.socket.terminateError = new Error("injected terminate error");
                break;
            }
          }
        }
        vi.runAllTimers();
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

        expect(cases).toBe(subjectsPerPlan);
        expect(wrongAcceptance).toBe(0);
        expect(retainedListeners).toBe(0);
        expect(wrongSettlements).toBe(0);
        expect(doubleTermination).toBe(0);
        expect(postSettlementChanges).toBe(0);
        expect(reportInvocations).toBe(plan.expectedReportsPerSubject * subjectsPerPlan);
        expect(vi.getTimerCount()).toBe(0);
      },
    );
  });
});

describe("collaboration attachment shutdown", () => {
  it("settles a connection emitted after attachment stop when termination and reporting throw", () => {
    const server = createServer();
    const hocuspocus = new Hocuspocus({ quiet: true });
    const shutdown = new AbortController();
    shutdown.abort();
    let reportInvocations = 0;
    const attachment = attachCollab(server, hocuspocus, {
      signal: shutdown.signal,
      preAuthenticationErrorReporter: () => {
        reportInvocations++;
        throw new Error("injected diagnostic failure");
      },
    });
    const socket = new FakeSocket();
    const request = new EventEmitter();
    socket.terminateError = new Error("injected termination failure");

    expect(() =>
      attachment.emit(
        "connection",
        asSocket(socket),
        request as unknown as IncomingMessage,
      )).not.toThrow();

    expect(socket.terminationAttempts).toBe(1);
    expect(reportInvocations).toBe(1);
    expect(attachment.getPendingAuthenticationCount()).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
    expect(request.listenerCount("aborted")).toBe(0);
  });

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

  it("continues wrapped shutdown across 100 pending sockets when termination, reporting and abort throw", async () => {
    const server = createServer();
    const hocuspocus = new Hocuspocus({ quiet: true });
    const lifecycles: Array<{ abort(): void }> = [];
    const originalHandleConnection = hocuspocus.handleConnection.bind(hocuspocus);
    vi.spyOn(hocuspocus, "handleConnection").mockImplementation((socket, request, context) => {
      const lifecycle = (context as { preAuthentication?: { abort(): void } }).preAuthentication;
      if (lifecycle) lifecycles.push(lifecycle);
      return originalHandleConnection(socket, request, context);
    });
    let reportInvocations = 0;
    const attachment = attachCollab(server, hocuspocus, {
      preAuthenticationErrorReporter: () => {
        reportInvocations++;
        throw new Error("injected diagnostic failure");
      },
    });
    const serverSockets: { socket: WebSocket; terminate: () => void; attempts: number }[] = [];
    attachment.on("connection", (socket) => {
      const record = { socket, terminate: socket.terminate.bind(socket), attempts: 0 };
      serverSockets.push(record);
      socket.terminate = () => {
        record.attempts++;
        record.terminate();
        throw new Error("injected termination failure");
      };
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`;
    const clients = Array.from({ length: 100 }, () => new WebSocket(url));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let attachmentClosed = false;

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
      expect(attachment.getPendingAuthenticationCount()).toBe(100);
      expect(lifecycles).toHaveLength(100);
      let abortsVisited = 0;
      for (const lifecycle of lifecycles) {
        const abort = lifecycle.abort.bind(lifecycle);
        lifecycle.abort = () => {
          abortsVisited++;
          abort();
          throw new Error("unexpected post-cleanup abort failure");
        };
      }
      const clientCloses = clients.map(
        (client) =>
          new Promise<void>((resolve) => {
            client.once("close", () => resolve());
          }),
      );
      let closePromise!: Promise<void>;

      expect(() => {
        closePromise = new Promise<void>((resolve, reject) => {
          attachment.close((error) => error ? reject(error) : resolve());
        });
      }).not.toThrow();
      await Promise.all([closePromise, ...clientCloses]);
      attachmentClosed = true;

      expect(abortsVisited).toBe(100);
      expect(serverSockets.every((record) => record.attempts === 1)).toBe(true);
      expect(reportInvocations).toBe(200);
      expect(attachment.getPendingAuthenticationCount()).toBe(0);
      expect(attachment.clients.size).toBe(0);
      expect(serverSockets).toHaveLength(100);
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
      if (!attachmentClosed) {
        await new Promise<void>((resolve) => attachment.close(() => resolve()));
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      process.off("unhandledRejection", onUnhandled);
      expect({
        clients: attachment.clients.size,
        pending: attachment.getPendingAuthenticationCount(),
        documents: hocuspocus.getDocumentsCount(),
        connections: hocuspocus.getConnectionsCount(),
      }).toEqual({ clients: 0, pending: 0, documents: 0, connections: 0 });
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

  it("physically reclaims 150 silent, malformed-token, document-mismatch and revoked-token peers", async () => {
    const site = await startAttachment({
      timeoutMs: COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS,
      closeGraceMs: COLLAB_PRE_AUTHENTICATION_CLOSE_GRACE_MS,
    });
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
          Array.from({ length: 150 }, (_, index) =>
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

// Issue #2321: a websocket upgrade whose request target or Host header cannot be parsed into a URL.
// The parse runs inside the server's `upgrade` listeners, where an exception is an uncaughtException
// and server/index.ts exits 1: one such request ended a ready server. Each one must get a plain 400,
// be closed, and leave the routing of the next upgrade untouched.
describe("collaboration attachment and upgrades that cannot be parsed", () => {
  /** Request targets `new URL(target, "http://localhost")` rejects; Node's parser lets all of them through. */
  const UNPARSEABLE_TARGETS = ["//", "///", "//?x", "//#", "//:80", "//[", "//@", "/\\\\", "http://", "http://[", "http://[::1", "http://a:99999/", "http://a:b/collab", "//a:b/collab", "ws://["];
  /** Host header values that do not make a URL (the request target is the collaboration path). */
  const UNPARSEABLE_HOSTS = ["", "[", ":80", "[::1", "%", "a:b", "a:99999", "<>", "a|b", "@", "a b", "a^b", "[::1]:x", "a%zz"];
  /** Parses, but `Request` refuses a URL with credentials. */
  const CREDENTIALS = [{ target: "/collab", host: "a@b" }, { target: "http://a@b/collab", host: "b" }];
  const LINE = "[http] upgrade error GET :unparseable ERR_INVALID_URL";
  const processErrors: unknown[] = [];
  const recordProcessError = (err: unknown) => void processErrors.push(err);
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    processErrors.length = 0;
    process.on("uncaughtException", recordProcessError);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.off("uncaughtException", recordProcessError);
    warn.mockRestore();
  });

  /** The listeners server/index.ts has once it is ready: the filtered stand-in for Next's, then the collaboration router. */
  async function startRouted(options: { collab?: boolean } = {}) {
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const hocuspocus = new Hocuspocus({ quiet: true });
    const handedOn: string[] = [];
    let connections = 0;
    // An upgrade socket that nobody answers outlives `closeAllConnections()`; the test closes them itself.
    const sockets = new Set<{ destroy(): void }>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    const protect = protectUpgradePath(server);
    server.on("upgrade", (req) => void handedOn.push(req.url ?? ""));
    protect();
    const attachment = options.collab === false ? null : attachCollab(server, hocuspocus);
    attachment?.on("connection", () => connections++);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return {
      port,
      handedOn,
      connections: () => connections,
      openServerSockets: () => new Promise<number>((resolve) => server.getConnections((_error, count) => resolve(count))),
      async close() {
        for (const socket of attachment?.clients ?? []) socket.terminate();
        hocuspocus.closeConnections();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  /** One raw upgrade request; the client never closes first, so `closedByServer` is the server's doing. */
  function rawUpgrade(port: number, target: string, host = `127.0.0.1:${port}`, waitMs = 2_000) {
    return new Promise<{ answer: string; closedByServer: boolean }>((resolve) => {
      let answer = "";
      let closedByServer = false;
      const socket = connectTcp({ host: "127.0.0.1", port, allowHalfOpen: true }, () => {
        socket.write(
          `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
          "latin1",
        );
      });
      const giveUp = setTimeout(() => socket.destroy(), waitMs);
      socket.setEncoding("latin1");
      socket.on("data", (text: string) => (answer += text));
      socket.on("error", () => {});
      socket.on("close", () => {
        clearTimeout(giveUp);
        resolve({ answer, closedByServer });
      });
      socket.on("end", () => {
        closedByServer = true;
        // The client still has not closed its side: the server must have let go of the socket by itself.
        setTimeout(() => socket.destroy(), 50);
      });
    });
  }

  function opens(url: string): Promise<WebSocket> {
    const socket = new WebSocket(url);
    return new Promise((resolve, reject) => {
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
  }

  it("answers a request target that cannot be parsed with 400, closes it, hands it to no other listener and keeps routing", async () => {
    const site = await startRouted();
    try {
      for (const target of UNPARSEABLE_TARGETS) {
        const { answer, closedByServer } = await rawUpgrade(site.port, target);
        expect({ target, answer, closedByServer }).toEqual({ target, answer: UNPARSEABLE_UPGRADE_ANSWER, closedByServer: true });
      }
      for (let i = 0; i < 100 && (await site.openServerSockets()) > 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await site.openServerSockets()).toBe(0);
      expect(site.handedOn).toEqual([]);
      expect(site.connections()).toBe(0);
      expect(warn.mock.calls).toEqual(UNPARSEABLE_TARGETS.map(() => [LINE]));
      const client = await opens(`ws://127.0.0.1:${site.port}/collab`);
      expect(site.connections()).toBe(1);
      client.terminate();
    } finally {
      await site.close();
    }
    expect(processErrors).toEqual([]);
  });

  it("answers a Host header that makes no URL with 400 before any 101, and opens no connection", async () => {
    const site = await startRouted();
    try {
      const requests = [...UNPARSEABLE_HOSTS.map((host) => ({ target: "/collab", host })), ...CREDENTIALS];
      for (const { target, host } of requests) {
        const { answer, closedByServer } = await rawUpgrade(site.port, target, host);
        expect({ target, host, answer, closedByServer }).toEqual({ target, host, answer: UNPARSEABLE_UPGRADE_ANSWER, closedByServer: true });
      }
      expect(site.connections()).toBe(0);
      expect(site.handedOn).toEqual([]);
      expect(warn.mock.calls).toEqual(requests.map(() => [LINE]));
      const client = await opens(`ws://127.0.0.1:${site.port}/collab`);
      expect(site.connections()).toBe(1);
      client.terminate();
    } finally {
      await site.close();
    }
    expect(processErrors).toEqual([]);
  });

  it("lets go of the socket after the 400 although the client keeps its side open", async () => {
    const site = await startRouted();
    const client = connectTcp({ host: "127.0.0.1", port: site.port, allowHalfOpen: true });
    try {
      client.on("error", () => {});
      client.resume();
      await new Promise<void>((resolve) => client.once("connect", resolve));
      const ended = new Promise<void>((resolve) => client.once("end", resolve));
      client.write(`GET ${UNPARSEABLE_TARGETS[0]} HTTP/1.1\r\nHost: 127.0.0.1:${site.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
      await ended;
      for (let i = 0; i < 100 && (await site.openServerSockets()) > 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(client.destroyed).toBe(false);
      expect(await site.openServerSockets()).toBe(0);
    } finally {
      client.destroy();
      await site.close();
    }
    expect(processErrors).toEqual([]);
  });

  it("the path filter alone neither throws on such a target nor hands it on", async () => {
    const site = await startRouted({ collab: false });
    try {
      for (const target of UNPARSEABLE_TARGETS.slice(0, 4)) await rawUpgrade(site.port, target, undefined, 150);
      await rawUpgrade(site.port, "/other", undefined, 150);
      expect(site.handedOn).toEqual(["/other"]);
    } finally {
      await site.close();
    }
    expect(processErrors).toEqual([]);
  });
});
