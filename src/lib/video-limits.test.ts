import { describe, expect, it } from "vitest";
import {
  isHevcMp4,
  isVideoTooLarge,
  videoFileError,
  videoMimeForFile,
} from "./video-limits";

function box(type: string, payload = new Uint8Array()): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.byteLength);
  bytes.set([...type].map((character) => character.charCodeAt(0)), 4);
  bytes.set(payload, 8);
  return bytes;
}

function join(...parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function mp4WithCodec(codec: "avc1" | "hvc1" | "hev1"): Blob {
  const sampleEntry = box(codec);
  const stsd = box("stsd", join(new Uint8Array(4), new Uint8Array([0, 0, 0, 1]), sampleEntry));
  const stbl = box("stbl", stsd);
  const minf = box("minf", stbl);
  const mdia = box("mdia", minf);
  const trak = box("trak", mdia);
  return new Blob([box("ftyp"), box("mdat", new Uint8Array(32)), box("moov", trak)]);
}

describe("video limits and MP4 preflight", () => {
  it("accepts only MP4/WebM files and refuses empty or oversized uploads", () => {
    expect(videoMimeForFile(new File(["x"], "clip.mp4", { type: "video/mp4" }))).toBe("video/mp4");
    expect(videoMimeForFile(new File(["x"], "clip.webm", { type: "application/octet-stream" }))).toBe("video/webm");
    expect(videoFileError(new File([], "empty.mp4", { type: "video/mp4" }))).toBe("The video file is empty");
    expect(videoFileError(new File(["x"], "clip.mov", { type: "video/quicktime" }))).toBe("Only MP4 and WebM videos can be uploaded");
    const oversized = new File([new Uint8Array(100 * 1024 * 1024 + 1)], "large.mp4", { type: "video/mp4" });
    expect(isVideoTooLarge(oversized)).toBe(true);
    expect(videoFileError(oversized)).toBe("Videos must be 100 MB or smaller");
  });

  it.each(["hvc1", "hev1"] as const)("detects the %s HEVC sample entry without scanning media payloads", async (codec) => {
    expect(await isHevcMp4(mp4WithCodec(codec))).toBe(true);
  });

  it("does not mistake an H.264 sample entry for HEVC", async () => {
    expect(await isHevcMp4(mp4WithCodec("avc1"))).toBe(false);
  });
});
