import { handler, requireAccess, HttpError } from "@/server/http";
import { getAsset } from "@/server/assets";
import { getVideoStorage, VideoStorageError } from "@/server/video-storage";
import { getVideoAsset } from "@/server/video-assets";
import { acquireAnonymousVideoStream, leasedVideoStream } from "@/server/video-streams";
import type { VideoRange } from "@/server/video-storage";

type Params = { params: Promise<{ id: string }> };

function parseRange(value: string | null, size: number): VideoRange | null | false {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return false;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || start > requestedEnd) return false;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function headersForVideo(asset: { mime: string; name: string; size: number }, range: VideoRange | null): Headers {
  const headers = new Headers({
    "Content-Type": asset.mime,
    "Content-Length": String(range ? range.end - range.start + 1 : asset.size),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": `inline; filename="${asset.name.replace(/[^\w.\- ]+/g, "")}"`,
  });
  if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${asset.size}`);
  return headers;
}

async function serveAsset(req: Request, { params }: Params): Promise<Response> {
  const { id: routeId } = await params;
  const videoMatch = /^([0-9a-z]{16})\.(mp4|webm)$/i.exec(routeId);
  if (videoMatch) {
    const [, id, extension] = videoMatch;
    const video = await getVideoAsset(id.toLowerCase());
    if (!video || (video.mime === "video/mp4" ? "mp4" : "webm") !== extension.toLowerCase()) {
      throw new HttpError(404, "Asset not found");
    }
    const access = await requireAccess(video.documentId, "view");
    const range = parseRange(req.headers.get("range"), video.size);
    if (range === false) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${video.size}`, "Accept-Ranges": "bytes" } });
    }
    const headers = headersForVideo(video, range);
    if (req.method.toUpperCase() === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });

    const lease = access.user ? null : await acquireAnonymousVideoStream();
    if (!access.user && !lease) {
      return new Response("Too many anonymous video streams", { status: 503, headers: { "Retry-After": "5" } });
    }
    let body: ReadableStream<Uint8Array>;
    try {
      body = await getVideoStorage().stream(video.storageKey, range || undefined);
    } catch (error) {
      await lease?.release();
      if (error instanceof VideoStorageError) throw new HttpError(503, error.message);
      throw error;
    }
    return new Response(lease ? leasedVideoStream(body, lease) : body, { status: range ? 206 : 200, headers });
  }

  const asset = await getAsset(routeId);
  if (!asset) throw new HttpError(404, "Asset not found");
  await requireAccess(asset.documentId, "view");
  const body = new Uint8Array(asset.bytes.buffer, asset.bytes.byteOffset, asset.bytes.byteLength) as Uint8Array<ArrayBuffer>;
  return new Response(req.method.toUpperCase() === "HEAD" ? null : body, {
    headers: {
      "Content-Type": asset.mime,
      "Content-Length": String(asset.size),
      // Asset ids are unique per upload and bytes never change, so clients can cache aggressively (privately).
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      // SVG is served as an image; the sandbox keeps any inline content from running in the app's origin.
      ...(asset.mime === "image/svg+xml" ? { "Content-Security-Policy": "sandbox; script-src 'none'" } : {}),
      "Content-Disposition": `inline; filename="${asset.name.replace(/[^\w.\- ]+/g, "")}"`,
    },
  });
}

/** Serve images as before and videos as access-checked, byte-range streams. */
export const GET = handler(serveAsset);
export const HEAD = handler(serveAsset);
