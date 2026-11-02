export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const VIDEO_CHUNK_BYTES = 4 * 1024 * 1024;
export const VIDEO_TOO_LARGE_MESSAGE = "Videos must be 100 MB or smaller";
export const VIDEO_UNSUPPORTED_MESSAGE = "Only MP4 and WebM videos can be uploaded";
export const VIDEO_HEVC_MESSAGE = "HEVC videos are not supported. Export as H.264 MP4 or WebM and upload again";

export type SupportedVideoMime = "video/mp4" | "video/webm";

const MIME_TYPES = new Set<SupportedVideoMime>(["video/mp4", "video/webm"]);

export interface UploadedVideo {
  id: string;
  url: string;
  name: string;
  mime: SupportedVideoMime;
  size: number;
}

export type VideoUploadProgress = (uploadedBytes: number, totalBytes: number) => void;
export type VideoUploader = (file: File, signal: AbortSignal, onProgress: VideoUploadProgress) => Promise<UploadedVideo>;

export function normalizeVideoMime(mime: string | null | undefined): string {
  return (mime ?? "").split(";")[0].trim().toLowerCase();
}

/** Whether the browser should intercept this file for video upload instead of inserting it itself. */
export function isVideoFile(file: File): boolean {
  return normalizeVideoMime(file.type).startsWith("video/") || /\.(?:mp4|webm)$/i.test(file.name);
}

export function videoFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []).filter(isVideoFile);
  if (files.length) return files;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("video/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
}

/** Infer the supported container only when the browser supplied no type or a generic binary type. */
export function videoMimeForFile(file: Pick<File, "name" | "type">): SupportedVideoMime | null {
  const declared = normalizeVideoMime(file.type);
  if (MIME_TYPES.has(declared as SupportedVideoMime)) return declared as SupportedVideoMime;
  if (declared && declared !== "application/octet-stream") return null;
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  return extension === "mp4" ? "video/mp4" : extension === "webm" ? "video/webm" : null;
}

export function isVideoTooLarge(file: Pick<File, "size">): boolean {
  return file.size > MAX_VIDEO_BYTES;
}

export function videoFileError(file: Pick<File, "name" | "type" | "size">): string | null {
  if (file.size === 0) return "The video file is empty";
  if (isVideoTooLarge(file)) return VIDEO_TOO_LARGE_MESSAGE;
  return videoMimeForFile(file) ? null : VIDEO_UNSUPPORTED_MESSAGE;
}

interface Mp4Box {
  type: string;
  start: number;
  payload: number;
  end: number;
}

function mp4Box(bytes: DataView, start: number, limit: number): Mp4Box | null {
  if (start + 8 > limit) return null;
  const size32 = bytes.getUint32(start);
  const type = String.fromCharCode(bytes.getUint8(start + 4), bytes.getUint8(start + 5), bytes.getUint8(start + 6), bytes.getUint8(start + 7));
  let header = 8;
  let size: number;
  if (size32 === 1) {
    if (start + 16 > limit) return null;
    const extended = bytes.getBigUint64(start + 8);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(extended);
    header = 16;
  } else {
    size = size32 === 0 ? limit - start : size32;
  }
  if (size < header || start + size > limit) return null;
  return { type, start, payload: start + header, end: start + size };
}

const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "mvex", "moof", "traf"]);

function hasHevcSampleEntry(bytes: DataView, moov: Mp4Box): boolean {
  const stack = [{ from: moov.payload, to: moov.end, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const { from, to, depth } = stack.pop()!;
    if (depth > 16) continue;
    for (let offset = from; offset < to; ) {
      if (++visited > 100_000) return false;
      const box = mp4Box(bytes, offset, to);
      if (!box) break;
      if (box.type === "stsd") {
        if (box.payload + 8 <= box.end) {
          const entryCount = bytes.getUint32(box.payload + 4);
          let entryOffset = box.payload + 8;
          for (let index = 0; index < entryCount && entryOffset < box.end; index++) {
            const entry = mp4Box(bytes, entryOffset, box.end);
            if (!entry) break;
            if (entry.type === "hvc1" || entry.type === "hev1") return true;
            entryOffset = entry.end;
          }
        }
      } else if (MP4_CONTAINERS.has(box.type)) {
        stack.push({ from: box.payload, to: box.end, depth: depth + 1 });
      }
      offset = box.end;
    }
  }
  return false;
}

/**
 * Detect HEVC from MP4 sample-entry boxes before upload. This reads only box headers and the `moov`
 * metadata atom; media payloads are skipped and never decoded or retained in memory.
 */
export async function isHevcMp4(file: Blob): Promise<boolean> {
  let offset = 0;
  while (offset + 8 <= file.size) {
    const header = await file.slice(offset, Math.min(file.size, offset + 16)).arrayBuffer();
    const view = new DataView(header);
    const box = mp4Box(view, 0, file.size - offset);
    if (!box) return false;
    const size = box.end;
    if (box.type === "moov") {
      if (size > 16 * 1024 * 1024) return false;
      const data = await file.slice(offset, offset + size).arrayBuffer();
      const moov = mp4Box(new DataView(data), 0, data.byteLength);
      return moov ? hasHevcSampleEntry(new DataView(data), moov) : false;
    }
    offset += size;
  }
  return false;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
