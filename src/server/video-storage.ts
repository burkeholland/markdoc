import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { VIDEO_CHUNK_BYTES } from "@/lib/video-limits";

export interface VideoRange {
  start: number;
  end: number;
}

/** Storage contract for resumable, bounded video uploads and byte-range playback. */
export interface VideoStorage {
  putChunk(key: string, index: number, bytes: Uint8Array): Promise<void>;
  complete(key: string, chunkCount: number, size: number): Promise<void>;
  clearParts(key: string): Promise<void>;
  discard(key: string): Promise<void>;
  stream(key: string, range?: VideoRange): Promise<ReadableStream<Uint8Array>>;
}

export class VideoStorageError extends Error {
  constructor(message = "Video storage is unavailable") {
    super(message);
    this.name = "VideoStorageError";
  }
}

const STORAGE_KEY = /^videos\/([0-9a-z]{16})$/;

function assetId(key: string): string {
  const match = STORAGE_KEY.exec(key);
  if (!match) throw new VideoStorageError("Invalid video storage key");
  return match[1];
}

function diskPaths(root: string, key: string) {
  const id = assetId(key);
  return {
    blob: path.join(root, "blobs", id),
    parts: path.join(root, "parts", id),
  };
}

/** Disk-backed development/test storage. No video bytes are written to PostgreSQL. */
export function createDiskVideoStorage(root: string): VideoStorage {
  const base = path.resolve(root);

  return {
    async putChunk(key, index, bytes) {
      if (!Number.isInteger(index) || index < 0 || index >= 25 || bytes.byteLength === 0 || bytes.byteLength > VIDEO_CHUNK_BYTES) {
        throw new VideoStorageError("Invalid video upload chunk");
      }
      const { parts } = diskPaths(base, key);
      await mkdir(parts, { recursive: true });
      await writeFile(path.join(parts, `${index}.part`), bytes);
    },

    async complete(key, chunkCount, size) {
      const { blob, parts } = diskPaths(base, key);
      try {
        if ((await stat(/*turbopackIgnore: true*/ blob)).size === size) return;
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }

      await mkdir(path.dirname(blob), { recursive: true });
      const temporary = `${blob}.${randomUUID()}.uploading`;
      const output = await open(temporary, "wx");
      let written = 0;
      let complete = false;
      try {
        for (let index = 0; index < chunkCount; index++) {
          let chunk: Buffer;
          try {
            chunk = await readFile(path.join(parts, `${index}.part`));
          } catch {
            throw new VideoStorageError("Video upload is incomplete");
          }
          if (written + chunk.byteLength > size) throw new VideoStorageError("Video upload size does not match");
          await output.write(chunk, 0, chunk.byteLength, written);
          written += chunk.byteLength;
        }
        if (written !== size) throw new VideoStorageError("Video upload size does not match");
        await output.sync();
        complete = true;
      } finally {
        await output.close();
        if (!complete) await rm(temporary, { force: true });
      }
      await rename(temporary, blob);
    },

    async clearParts(key) {
      const { parts } = diskPaths(base, key);
      await rm(parts, { recursive: true, force: true });
    },

    async discard(key) {
      const { blob } = diskPaths(base, key);
      await rm(blob, { force: true });
      const { parts } = diskPaths(base, key);
      await rm(parts, { recursive: true, force: true });
    },

    async stream(key, range) {
      const { blob } = diskPaths(base, key);
      const stream = createReadStream(/*turbopackIgnore: true*/ blob, range ? { start: range.start, end: range.end } : undefined);
      return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    },
  };
}

interface ManagedIdentityToken {
  access_token: string;
  expires_on?: string | number;
  expires_in?: string | number;
}

/** Azure Blob REST client using the app's managed identity; the container must remain private. */
export function createAzureVideoStorage(containerUrl: string): VideoStorage {
  let base: URL;
  try {
    base = new URL(containerUrl);
  } catch {
    throw new VideoStorageError("Video storage is not configured");
  }
  const permittedHost = /\.(?:blob\.core\.windows\.net|blob\.core\.usgovcloudapi\.net|blob\.core\.chinacloudapi\.cn|blob\.core\.cloudapi\.de)$/i;
  if (base.protocol !== "https:" || !permittedHost.test(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname === "/") {
    throw new VideoStorageError("Video storage is not configured");
  }
  base.pathname = base.pathname.replace(/\/+$/, "");

  let token: string | null = null;
  let tokenExpiresAt = 0;
  let tokenRequest: Promise<string> | null = null;

  async function managedIdentityToken(): Promise<string> {
    if (token && tokenExpiresAt - Date.now() > 60_000) return token;
    if (tokenRequest) return tokenRequest;
    tokenRequest = (async () => {
      const clientId = process.env.AZURE_CLIENT_ID;
      const identityEndpoint = process.env.IDENTITY_ENDPOINT;
      const url = new URL(identityEndpoint ?? "http://169.254.169.254/metadata/identity/oauth2/token");
      url.searchParams.set("resource", "https://storage.azure.com/");
      url.searchParams.set("api-version", identityEndpoint ? "2019-08-01" : "2018-02-01");
      if (clientId) url.searchParams.set("client_id", clientId);

      const headers = new Headers();
      if (identityEndpoint) {
        const identityHeader = process.env.IDENTITY_HEADER;
        if (!identityHeader) throw new VideoStorageError("Managed identity is not available");
        headers.set("X-IDENTITY-HEADER", identityHeader);
      } else {
        headers.set("Metadata", "true");
      }

      let response: Response;
      try {
        response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      } catch {
        throw new VideoStorageError("Managed identity is not available");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new VideoStorageError("Managed identity is not available");
      }
      let body: ManagedIdentityToken;
      try {
        body = (await response.json()) as ManagedIdentityToken;
      } catch {
        throw new VideoStorageError("Managed identity returned an invalid token");
      }
      if (!body.access_token) throw new VideoStorageError("Managed identity returned an invalid token");
      const expiry = Number(body.expires_on ?? 0) * 1000 || Date.now() + Number(body.expires_in ?? 300) * 1000;
      token = body.access_token;
      tokenExpiresAt = expiry;
      return token;
    })().finally(() => {
      tokenRequest = null;
    });
    return tokenRequest;
  }

  function urlFor(key: string, query?: Record<string, string>): URL {
    const id = assetId(key);
    const url = new URL(base);
    url.pathname = `${base.pathname}/videos/${id}`;
    if (query) for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  }

  async function request(
    method: string,
    key: string,
    query?: Record<string, string>,
    body?: BodyInit,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const headers = new Headers({
      Authorization: `Bearer ${await managedIdentityToken()}`,
      "x-ms-date": new Date().toUTCString(),
      "x-ms-version": "2023-11-03",
      ...extraHeaders,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    timeout.unref?.();
    try {
      // Bound response-header latency without aborting a body that is still streaming to its reader.
      return await fetch(urlFor(key, query), { method, headers, body, signal: controller.signal });
    } catch {
      throw new VideoStorageError();
    } finally {
      clearTimeout(timeout);
    }
  }

  const blockId = (index: number) => Buffer.from(`markdoc-${String(index).padStart(6, "0")}`).toString("base64");

  return {
    async putChunk(key, index, bytes) {
      const response = await request(
        "PUT",
        key,
        { comp: "block", blockid: blockId(index) },
        Buffer.from(bytes),
        { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.byteLength) },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new VideoStorageError();
      }
    },

    async complete(key, chunkCount, size) {
      const response = await request("HEAD", key);
      if (response.ok && Number(response.headers.get("content-length")) === size) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
      if (!response.ok && response.status !== 404) throw new VideoStorageError();

      const blocks = Array.from({ length: chunkCount }, (_, index) => `<Latest>${blockId(index)}</Latest>`).join("");
      const commit = await request(
        "PUT",
        key,
        { comp: "blocklist" },
        `<BlockList>${blocks}</BlockList>`,
        { "Content-Type": "application/xml", "x-ms-blob-content-type": "application/octet-stream" },
      );
      if (!commit.ok) {
        await commit.body?.cancel();
        throw new VideoStorageError();
      }
    },

    async clearParts() {
      // Put Block List commits the blocks, which clears Azure's uncommitted block set.
    },

    async discard(key) {
      const empty = await request(
        "PUT",
        key,
        { comp: "blocklist" },
        "<BlockList></BlockList>",
        { "Content-Type": "application/xml", "x-ms-blob-content-type": "application/octet-stream" },
      );
      await empty.body?.cancel();
      if (!empty.ok && empty.status !== 404) throw new VideoStorageError();
      const deleted = await request("DELETE", key);
      await deleted.body?.cancel();
      if (!deleted.ok && deleted.status !== 404) throw new VideoStorageError();
    },

    async stream(key, range) {
      const response = await request("GET", key, undefined, undefined, range ? { Range: `bytes=${range.start}-${range.end}` } : undefined);
      if (response.status !== (range ? 206 : 200) || !response.body) {
        await response.body?.cancel();
        throw new VideoStorageError();
      }
      return response.body as ReadableStream<Uint8Array>;
    },
  };
}

let override: VideoStorage | null = null;
let configuredUrl: string | undefined;
let configured: VideoStorage | null = null;

/** Test seam and deployment selection: Azure in production, disk storage for local development. */
export function getVideoStorage(): VideoStorage {
  if (override) return override;
  const containerUrl = process.env.MARKDOC_VIDEO_CONTAINER_URL;
  if (configured && configuredUrl === containerUrl) return configured;
  configuredUrl = containerUrl;
  configured = containerUrl
    ? createAzureVideoStorage(containerUrl)
    : process.env.NODE_ENV === "production"
      ? (() => {
          throw new VideoStorageError("Video storage is not configured");
        })()
      : createDiskVideoStorage(
          process.env.MARKDOC_VIDEO_DIR ??
            (process.env.NODE_ENV === "test" ? path.join(tmpdir(), `markdoc-videos-${process.pid}`) : path.join(process.cwd(), ".data", "videos")),
        );
  return configured;
}

export function setVideoStorageForTests(storage: VideoStorage | null): void {
  override = storage;
}
