import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Hocuspocus } from "@hocuspocus/server";
import type { CollabContext } from "./hocuspocus";

export const COLLAB_PATH = "/collab";

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
}

type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

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
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    socket.binaryType = "nodebuffer";
    const connection = hocuspocus.handleConnection(socket, toWebRequest(req));
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

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
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
  });

  return wss;
}
