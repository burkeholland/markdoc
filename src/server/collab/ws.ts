import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { Hocuspocus } from "@hocuspocus/server";
import type { CollabContext, CollabPreAuthentication } from "./hocuspocus";

export const COLLAB_PATH = "/collab";
export const COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS = 3_000;
export const COLLAB_PRE_AUTHENTICATION_CLOSE_GRACE_MS = 500;
const UNAUTHORIZED = { code: 4401, reason: "Unauthorized" } as const;

export function toWebRequest(req: IncomingMessage, fallbackHost = "localhost"): Request {
  const host = req.headers.host ?? fallbackHost;
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  return new Request(url, { headers });
}

export interface AttachOptions {
  path?: string;
  /** Bootstrap handler for other upgrades until their own listener has been attached. */
  fallback?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
  /** Stops accepting upgrades and destroys sockets that have not authenticated yet. */
  signal?: AbortSignal;
  /** Test-only override; production uses `COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS`. */
  preAuthenticationTimeoutMs?: number;
  /** Test-only override; production uses `COLLAB_PRE_AUTHENTICATION_CLOSE_GRACE_MS`. */
  preAuthenticationCloseGraceMs?: number;
}

type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

export interface CollabPreAuthenticationDeadline extends CollabPreAuthentication {
  abort(): void;
}

interface DeadlineOptions {
  request?: Pick<IncomingMessage, "off" | "once">;
  timeoutMs?: number;
  closeGraceMs?: number;
  onSettled?: (deadline: CollabPreAuthenticationDeadline) => void;
}

/**
 * Own the one absolute deadline between a completed WebSocket upgrade and Hocuspocus authentication.
 * Only the authentication hook can accept or reject it; arbitrary application frames have no effect.
 */
export function createCollabPreAuthenticationDeadline(
  initialSocket: WebSocket,
  options: DeadlineOptions = {},
): CollabPreAuthenticationDeadline {
  let socket: WebSocket | null = initialSocket;
  let request = options.request;
  let onSettled = options.onSettled;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let closeGraceTimer: ReturnType<typeof setTimeout> | undefined;
  let deferredClose: ReturnType<typeof setImmediate> | undefined;
  let state: "pending" | "closing" | "settled" = "pending";

  const onClose = () => {
    finish();
  };
  const onError = () => {
    terminate();
  };
  const onAbort = () => {
    terminate();
  };

  const clearDeadline = () => {
    if (!deadlineTimer) return;
    clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
  };

  const finish = () => {
    const current = socket;
    if (!current) return;
    state = "settled";
    socket = null;
    clearDeadline();
    if (closeGraceTimer) {
      clearTimeout(closeGraceTimer);
      closeGraceTimer = undefined;
    }
    if (deferredClose) {
      clearImmediate(deferredClose);
      deferredClose = undefined;
    }
    current.off("close", onClose);
    current.off("error", onError);
    request?.off("aborted", onAbort);
    request = undefined;
    const notify = onSettled;
    onSettled = undefined;
    notify?.(lifecycle);
  };

  const terminate = () => {
    const current = socket;
    if (!current) return;
    try {
      if (current.readyState !== WebSocket.CLOSED) current.terminate();
    } finally {
      finish();
    }
  };

  const armCloseGrace = () => {
    if (!socket || closeGraceTimer) return;
    closeGraceTimer = setTimeout(terminate, options.closeGraceMs ?? COLLAB_PRE_AUTHENTICATION_CLOSE_GRACE_MS);
    closeGraceTimer.unref?.();
  };

  const closeUnauthorized = () => {
    deferredClose = undefined;
    const current = socket;
    if (!current || state !== "closing") return;
    if (current.readyState === WebSocket.CLOSED) {
      finish();
      return;
    }
    if (current.readyState === WebSocket.OPEN) current.close(UNAUTHORIZED.code, UNAUTHORIZED.reason);
    if (current.readyState === WebSocket.CONNECTING) {
      terminate();
      return;
    }
    armCloseGrace();
  };

  const reject = (defer: boolean) => {
    if (state !== "pending") return;
    state = "closing";
    clearDeadline();
    if (!defer) {
      closeUnauthorized();
      return;
    }
    // Hocuspocus sends permission-denied after the authentication hook rejects.
    deferredClose = setImmediate(closeUnauthorized);
    deferredClose.unref?.();
  };

  initialSocket.once("close", onClose);
  initialSocket.once("error", onError);
  options.request?.once("aborted", onAbort);
  deadlineTimer = setTimeout(() => reject(false), options.timeoutMs ?? COLLAB_PRE_AUTHENTICATION_TIMEOUT_MS);
  deadlineTimer.unref?.();

  const lifecycle: CollabPreAuthenticationDeadline = {
    accepted: () => {
      if (state !== "pending") return;
      finish();
    },
    rejected: () => {
      reject(true);
    },
    abort: onAbort,
  };
  return lifecycle;
}

/**
 * Wrap upgrade listeners added after this call so they never receive `path`.
 * Next installs its HMR listener lazily on the first HTTP request; without this filter EventEmitter
 * also invokes it for the /collab socket that the existing router has already upgraded.
 */
export function protectUpgradePath(server: HttpServer, path = COLLAB_PATH): () => void {
  const known = new Set(server.listeners("upgrade"));
  return () => {
    for (const candidate of server.listeners("upgrade")) {
      if (known.has(candidate)) continue;
      const listener = candidate as UpgradeListener;
      server.off("upgrade", listener);
      const filtered: UpgradeListener = (req, socket, head) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (pathname !== path) listener.call(server, req, socket, head);
      };
      known.add(filtered);
      server.on("upgrade", filtered);
    }
  };
}

/** Route WebSocket upgrades on `path` to the Hocuspocus instance. */
export function attachCollab(server: HttpServer, hocuspocus: Hocuspocus<CollabContext>, options: AttachOptions = {}) {
  const path = options.path ?? COLLAB_PATH;
  const pendingAuthentication = new Set<CollabPreAuthenticationDeadline>();
  const wss = Object.assign(
    new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 }),
    { getPendingAuthenticationCount: () => pendingAuthentication.size },
  );
  let stopped = false;

  wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    socket.binaryType = "nodebuffer";
    const deadline = createCollabPreAuthenticationDeadline(socket, {
      request: req,
      timeoutMs: options.preAuthenticationTimeoutMs,
      closeGraceMs: options.preAuthenticationCloseGraceMs,
      onSettled: (settled) => pendingAuthentication.delete(settled),
    });
    pendingAuthentication.add(deadline);
    const context = {} as CollabContext;
    context.preAuthentication = deadline;
    const connection = hocuspocus.handleConnection(socket, toWebRequest(req), context);
    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      const bytes = Array.isArray(data)
        ? new Uint8Array(Buffer.concat(data))
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      connection.handleMessage(bytes);
    });
    socket.on("close", (code: number, reason: Buffer) => connection.handleClose({ code, reason: reason.toString() }));
    socket.on("error", (err: Error) => console.error("[collab] socket error", err));
  });

  const onUpgrade: UpgradeListener = (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === path) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      return;
    }
    // Next's HMR listener is lazy. Use its handler before it exists, then leave non-collab upgrades
    // to that listener after it has been attached; forwarding as well would handle every HMR socket twice.
    if (server.listenerCount("upgrade") !== 1) return;
    if (!options.fallback) return socket.destroy();
    try {
      const pending = options.fallback(req, socket, head);
      if (pending) {
        void pending.catch((err: unknown) => {
          console.error("[websocket] fallback upgrade failed", err);
          socket.destroy();
        });
      }
    } catch (err) {
      console.error("[websocket] fallback upgrade failed", err);
      socket.destroy();
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    server.off("upgrade", onUpgrade);
    server.off("close", stop);
    wss.off("close", stop);
    options.signal?.removeEventListener("abort", stop);
    for (const deadline of [...pendingAuthentication]) deadline.abort();
  };

  server.on("upgrade", onUpgrade);
  server.once("close", stop);
  wss.once("close", stop);
  const closeWebSocketServer = wss.close.bind(wss);
  wss.close = (callback?: (error?: Error) => void) => {
    stop();
    closeWebSocketServer(callback);
  };
  if (options.signal?.aborted) stop();
  else options.signal?.addEventListener("abort", stop, { once: true });

  return wss;
}
