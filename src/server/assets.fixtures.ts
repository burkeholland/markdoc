import { crc32 } from "node:zlib";

/**
 * Small REAL image files for tests. The upload check (`validateAsset`) reads a file's own bytes, so a test
 * that stores an image needs bytes of the type it declares; made-up bytes are refused. Each constant below
 * was written by an image encoder and read back by a decoder before it was pasted here. Test-only: nothing
 * in the product imports this file.
 */
const b64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(Buffer.from(text, "base64"));

/** 1x1 transparent PNG, 70 bytes: the pixel most tests upload. */
export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
export const PNG = b64(PNG_BASE64);
/** 2x2 baseline JPEG (starts with a quantisation table, no JFIF header). */
export const JPEG = b64(
  "/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCOACqH/9k=",
);
/** 2x2 GIF, one frame. */
export const GIF = b64("R0lGODlhAgACAIAAAExpccgeHiH5BAUAAAAALAAAAAACAAIAAAICjFMAOw==");
/** 1x1 GIF with two frames and a loop extension. */
export const GIF_ANIMATED = b64("R0lGODlhAQABAIAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw==");
/** 2x2 lossy WebP (`VP8 ` chunk). */
export const WEBP = b64("UklGRjYAAABXRUJQVlA4ICoAAACQAQCdASoCAAIAAsBMJaACdLoAA5gA/u2QP4hd7G2//PTP62/j/xkAAAA=");
/** 2x2 lossless WebP (`VP8L` chunk). */
export const WEBP_LOSSLESS = b64("UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAAAdQjyLXo/+BiOh/AAA=");
/** 1x1 WebP with two frames (`VP8X` container). */
export const WEBP_ANIMATED = b64(
  "UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAAAAAAAAQU5JTQYAAAD/////AABBTk1GKAAAAAAAAAAAAAAAAAAAAGQAAAJWUDhMDwAAAC8AAAAABxD9j/4HIqL/AQBBTk1GKAAAAAAAAAAAAAAAAAAAAGQAAABWUDhMDwAAAC8AAAAABxDR//4HIqL/AQA=",
);
export const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="tomato"/></svg>';
export const SVG = new TextEncoder().encode(SVG_TEXT) as Uint8Array<ArrayBuffer>;

/** One real file per allowed type, keyed by the type it is. */
export const IMAGE_BY_TYPE: Record<string, Uint8Array<ArrayBuffer>> = {
  "image/png": PNG,
  "image/jpeg": JPEG,
  "image/gif": GIF,
  "image/webp": WEBP,
  "image/svg+xml": SVG,
};

/** {@link PNG} with a text chunk (`tEXt`, keyword "note") before its end chunk: still a well-formed PNG, with bytes of its own. */
function pngWithNote(note: Uint8Array): Uint8Array<ArrayBuffer> {
  const IEND = 12;
  const body = Buffer.concat([Buffer.from("tEXtnote\0", "latin1"), note]);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(body.length - 4, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), body.length + 4);
  return Uint8Array.from(Buffer.concat([PNG.subarray(0, PNG.length - IEND), chunk, PNG.subarray(PNG.length - IEND)]));
}

/** A real PNG whose bytes differ for every `tag`: for tests that need several distinct images. */
export function distinctPng(tag: string | number): Uint8Array<ArrayBuffer> {
  return pngWithNote(Buffer.from(String(tag), "latin1"));
}

/** A real PNG of exactly `size` bytes (the note is padding), for tests at a size limit. */
export function pngOfSize(size: number): Uint8Array<ArrayBuffer> {
  const overhead = pngWithNote(new Uint8Array()).length;
  if (size < overhead) throw new Error(`a padded PNG is at least ${overhead} bytes`);
  return pngWithNote(new Uint8Array(size - overhead).fill(0x2e));
}
