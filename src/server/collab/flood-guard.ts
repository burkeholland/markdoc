import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";

/**
 * Per-connection flood protection for the collaboration socket (issue #2285).
 *
 * - Token buckets on message count and on bytes. A person typing sends a few messages a second; a large
 *   paste or the first sync of a big document is one or a few large messages, which the byte burst covers
 *   (it is larger than `maxPayload`). A connection that drains a bucket is closed with 4429.
 * - Backpressure: a connection whose outgoing buffer passes `maxBufferedBytes` (it sends but does not
 *   read) is closed with 4430 instead of buffered without end.
 * - Incoming messages are handled in time slices so one connection's backlog yields to the event loop.
 */
export interface FloodLimits {
  messagesPerSecond: number;
  messageBurst: number;
  bytesPerSecond: number;
  byteBurst: number;
  maxBufferedBytes: number;
  sliceMs: number;
}

export const DEFAULT_FLOOD_LIMITS: FloodLimits = {
  messagesPerSecond: 300,
  messageBurst: 1_500,
  bytesPerSecond: 4 * 1024 * 1024,
  byteBurst: 40 * 1024 * 1024,
  maxBufferedBytes: 32 * 1024 * 1024,
  sliceMs: 10,
};

export const RATE_LIMITED = { code: 4429, reason: "Rate limit exceeded" } as const;
export const SEND_BUFFER_FULL = { code: 4430, reason: "Send buffer full" } as const;

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
  socket: Pick<WebSocket, "readyState" | "bufferedAmount" | "close" | "terminate">,
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

  const shut = (why: { code: number; reason: string }) => {
    if (closed) return;
    closed = true;
    dispose();
    try {
      if (socket.readyState === WebSocket.OPEN) socket.close(why.code, why.reason);
      else socket.terminate();
    } catch {
      try {
        socket.terminate();
      } catch {
        // already gone
      }
    }
  };

  const overBuffered = () => {
    if (socket.bufferedAmount > l.maxBufferedBytes) {
      // A close frame would queue behind the full buffer; the peer is not reading, so drop it.
      closed = true;
      dispose();
      try {
        socket.terminate();
      } catch {
        // already gone
      }
      return true;
    }
    return false;
  };

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
    scheduled = tickReset = undefined;
    queue = [];
    head = 0;
  };

  return {
    receive(data) {
      if (closed) return false;
      if (!messages.take(1) || !bytes.take(data.byteLength)) {
        shut(RATE_LIMITED);
        return false;
      }
      if (overBuffered()) return false;
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
