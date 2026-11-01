import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";

/**
 * Per-connection flood protection for the collaboration socket (issue #2285).
 *
 * - A per-message size cap plus token buckets on message count and bytes. A person typing sends a few
 *   messages a second; a large paste or first sync fits inside the byte burst. Rate abuse closes with 4429.
 * - Backpressure: a connection whose outgoing buffer passes `maxBufferedBytes` (it sends but does not
 *   read) is closed with 4430 instead of buffered without end.
 * - Incoming messages are handled in time slices so one connection's backlog yields to the event loop.
 */
export interface FloodLimits {
  maxMessageBytes: number;
  messagesPerSecond: number;
  messageBurst: number;
  bytesPerSecond: number;
  byteBurst: number;
  maxBufferedBytes: number;
  sliceMs: number;
}

export const DEFAULT_FLOOD_LIMITS: FloodLimits = {
  // Leaves headroom for Yjs framing around the tested 8 MiB paste.
  maxMessageBytes: 16 * 1024 * 1024,
  messagesPerSecond: 300,
  messageBurst: 1_500,
  bytesPerSecond: 4 * 1024 * 1024,
  byteBurst: 40 * 1024 * 1024,
  maxBufferedBytes: 32 * 1024 * 1024,
  sliceMs: 10,
};

export const MESSAGE_TOO_LARGE = { code: 1009, reason: "Message too big" } as const;
export const RATE_LIMITED = { code: 4429, reason: "Rate limit exceeded" } as const;
export const SEND_BUFFER_FULL = { code: 4430, reason: "Send buffer full" } as const;
const ABUSE_CLOSE_GRACE_MS = 500;

class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly rate: number,
    private readonly capacity: number,
    private readonly now: () => number,
  ) {
    this.tokens = capacity;
    this.last = now();
  }
  take(amount: number): boolean {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    this.tokens -= amount;
    return this.tokens >= 0;
  }
}

export interface FloodGuard {
  /** Queue an incoming message; returns false when the connection was closed for flooding. */
  receive(bytes: Uint8Array): boolean;
  dispose(): void;
}

export function createFloodGuard(
  socket: Pick<WebSocket, "readyState" | "bufferedAmount" | "close" | "send" | "terminate">,
  handle: (bytes: Uint8Array) => void,
  limits: Partial<FloodLimits> = {},
  now: () => number = () => performance.now(),
): FloodGuard {
  const l = { ...DEFAULT_FLOOD_LIMITS, ...limits };
  const messages = new TokenBucket(l.messagesPerSecond, l.messageBurst, now);
  const bytes = new TokenBucket(l.bytesPerSecond, l.byteBurst, now);
  let queue: Uint8Array[] = [];
  let head = 0;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let closed = false;
  let spentThisTick = 0;
  let tickReset: ReturnType<typeof setImmediate> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const terminate = () => {
    closeTimer = undefined;
    if (socket.readyState === WebSocket.CLOSED) return;
    try {
      socket.terminate();
    } catch {
      // already gone
    }
  };
  const isSocketClosed = () => socket.readyState === WebSocket.CLOSED;

  const shut = (why: { code: number; reason: string }) => {
    if (closed) return;
    closed = true;
    dispose();
    try {
      if (socket.readyState !== WebSocket.OPEN) {
        terminate();
        return;
      }
      socket.close(why.code, why.reason);
      if (!isSocketClosed()) {
        closeTimer = setTimeout(terminate, ABUSE_CLOSE_GRACE_MS);
        closeTimer.unref?.();
      }
    } catch {
      terminate();
    }
  };

  const overBuffered = () => {
    if (socket.bufferedAmount > l.maxBufferedBytes) {
      shut(SEND_BUFFER_FULL);
      return true;
    }
    return false;
  };
  const checkBackpressure = () => {
    if (closed) return false;
    return !overBuffered();
  };

  // Hocuspocus sends both async replies and broadcasts through the socket, not the receive callback.
  socket.send = new Proxy(socket.send, {
    apply(send, thisArg, args) {
      const result = Reflect.apply(send, thisArg, args);
      checkBackpressure();
      return result;
    },
  });

  const drain = () => {
    scheduled = undefined;
    const start = now();
    while (!closed && head < queue.length) {
      const next = queue[head];
      queue[head++] = undefined as unknown as Uint8Array;
      handle(next);
      if (overBuffered()) return;
      if (now() - start >= l.sliceMs) break;
    }
    if (head >= queue.length) {
      queue = [];
      head = 0;
    } else if (!closed) {
      scheduled = setImmediate(drain);
    }
  };

  const dispose = () => {
    if (scheduled) clearImmediate(scheduled);
    if (tickReset) clearImmediate(tickReset);
    if (closeTimer) clearTimeout(closeTimer);
    scheduled = tickReset = closeTimer = undefined;
    queue = [];
    head = 0;
  };

  return {
    receive(data) {
      if (closed) return false;
      if (overBuffered()) return false;
      if (data.byteLength > l.maxMessageBytes) {
        shut(MESSAGE_TOO_LARGE);
        return false;
      }
      if (!messages.take(1) || !bytes.take(data.byteLength)) {
        shut(RATE_LIMITED);
        return false;
      }
      if (!scheduled && spentThisTick < l.sliceMs) {
        const start = now();
        handle(data);
        spentThisTick += now() - start;
        if (!tickReset && !closed) {
          tickReset = setImmediate(() => {
            tickReset = undefined;
            spentThisTick = 0;
          });
        }
        return !overBuffered();
      }
      queue.push(data);
      if (!scheduled) scheduled = setImmediate(drain);
      return true;
    },
    dispose() {
      closed = true;
      dispose();
    },
  };
}
