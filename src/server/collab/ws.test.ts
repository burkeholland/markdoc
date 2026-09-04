import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Hocuspocus } from "@hocuspocus/server";
import * as encoding from "lib0/encoding";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachCollab,
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
      onSettled: settled,
    });
    return { socket, request, settled, lifecycle };
  }

  it("closes a completely bare upgraded socket with 4401 at the absolute deadline", () => {
    const subject = deadline();

    vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS - 1);
    expect(subject.socket.closes).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(subject.socket.closes).toEqual([{ code: 4401, reason: "Unauthorized" }]);
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
      vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS);

      expect(subject.socket.closes).toEqual([{ code: 4401, reason: "Unauthorized" }]);
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
    vi.advanceTimersByTime(COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS);

    expect(subject.socket.closes).toEqual([{ code: 4401, reason: "Unauthorized" }]);
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

  it("releases every timer, listener and socket reference after 10,000 bare sockets", () => {
    const subjects = Array.from({ length: 10_000 }, () => deadline());
    expect(vi.getTimerCount()).toBe(10_000);

    subjects.forEach((subject, index) => {
      if (index % 3 === 0) subject.lifecycle.accepted();
      else if (index % 3 === 1) subject.socket.emit("close", 1000, Buffer.alloc(0));
      else subject.lifecycle.abort();
    });

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
});

describe("collaboration attachment first frames", () => {
  const timeoutMs = 500;

  async function startAttachment() {
    const server = createServer();
    const hocuspocus = new Hocuspocus({
      quiet: true,
      async onAuthenticate({ token, context }) {
        const lifecycle = (context as { preAuthentication?: { accepted(): void; rejected(): void } }).preAuthentication;
        if (token !== "valid") {
          lifecycle?.rejected();
          throw new Error("invalid");
        }
        lifecycle?.accepted();
        return {};
      },
    });
    const attachment = attachCollab(
      server,
      hocuspocus as unknown as Parameters<typeof attachCollab>[1],
      { preAuthenticationTimeoutMs: timeoutMs },
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
});
