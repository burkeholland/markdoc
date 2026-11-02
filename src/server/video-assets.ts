import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { MAX_VIDEO_BYTES, VIDEO_CHUNK_BYTES, VIDEO_TOO_LARGE_MESSAGE, normalizeVideoMime, type SupportedVideoMime } from "@/lib/video-limits";
import { getDb, schema, type Tx } from "@/server/db";
import { getVideoStorage, VideoStorageError } from "./video-storage";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 16);
const VIDEO_MIMES = new Set<SupportedVideoMime>(["video/mp4", "video/webm"]);
const VIDEO_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const VIDEO_UPLOAD_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const VIDEO_STORAGE_CLEANUP_BATCH_SIZE = 100;

export class VideoAssetError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "VideoAssetError";
  }
}

export interface VideoAsset {
  id: string;
  documentId: string;
  name: string;
  mime: SupportedVideoMime;
  size: number;
  storageKey: string;
}

export interface VideoCopyReservation {
  id: string;
  documentId: string;
  userId: string | null;
  name: string;
  mime: string;
  size: number;
  storageKey: string;
}

export interface StartedVideoUpload {
  uploadId: string;
  chunkCount: number;
  chunkSize: number;
}

export interface StoredVideoAsset extends Omit<VideoAsset, "storageKey"> {
  url: string;
}

export function videoAssetUrl(id: string, mime: SupportedVideoMime): string {
  return `/api/assets/${id}${mime === "video/mp4" ? ".mp4" : ".webm"}`;
}

export function videoStorageKey(id: string): string {
  return `videos/${id}`;
}

function isSupportedMime(mime: string): mime is SupportedVideoMime {
  return VIDEO_MIMES.has(mime as SupportedVideoMime);
}

function cleanVideoName(name: string, mime: SupportedVideoMime): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "video";
  const stem = cleaned.replace(/\.[a-z0-9]{1,8}$/i, "") || "video";
  return `${stem}${mime === "video/mp4" ? ".mp4" : ".webm"}`;
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasAscii(bytes: Uint8Array, offset: number, value: string): boolean {
  return bytes.length >= offset + value.length && [...value].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
}

function validVideoHeader(mime: SupportedVideoMime, bytes: Uint8Array): boolean {
  if (mime === "video/mp4") return hasAscii(bytes, 4, "ftyp");
  return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

export async function beginVideoUpload(input: {
  documentId: string;
  userId: string | null;
  name: string;
  mime: string;
  size: number;
}): Promise<StartedVideoUpload> {
  if (!isSupportedMime(normalizeVideoMime(input.mime))) {
    throw new VideoAssetError(415, "Only MP4 and WebM videos can be uploaded");
  }
  const mime = normalizeVideoMime(input.mime) as SupportedVideoMime;
  if (!Number.isSafeInteger(input.size) || input.size <= 0) throw new VideoAssetError(400, "The video file is empty");
  if (input.size > MAX_VIDEO_BYTES) throw new VideoAssetError(413, VIDEO_TOO_LARGE_MESSAGE);
  if (input.name.includes("\0")) throw new VideoAssetError(400, "The video name is invalid");

  const id = nanoid();
  const chunkCount = Math.ceil(input.size / VIDEO_CHUNK_BYTES);
  const key = videoStorageKey(id);
  try {
    getVideoStorage();
  } catch (error) {
    if (error instanceof VideoStorageError) throw new VideoAssetError(503, error.message);
    throw error;
  }

  const db = await getDb();
  await db.insert(schema.videoUploads).values({
    id,
    documentId: input.documentId,
    userId: input.userId,
    name: cleanVideoName(input.name, mime),
    mime,
    size: input.size,
    chunkCount,
    storageKey: key,
  });
  return { uploadId: id, chunkCount, chunkSize: VIDEO_CHUNK_BYTES };
}

function partSize(size: number, chunkCount: number, index: number): number {
  return index === chunkCount - 1 ? size - index * VIDEO_CHUNK_BYTES : VIDEO_CHUNK_BYTES;
}

export async function putVideoUploadChunk(input: {
  documentId: string;
  uploadId: string;
  index: number;
  bytes: Uint8Array;
}): Promise<void> {
  const db = await getDb();
  try {
    await db.transaction(async (tx) => {
      const [upload] = await tx
        .select()
        .from(schema.videoUploads)
        .where(and(eq(schema.videoUploads.id, input.uploadId), eq(schema.videoUploads.documentId, input.documentId)))
        .for("update");
      if (!upload || upload.state !== "uploading") throw new VideoAssetError(404, "Video upload not found");
      if (!Number.isInteger(input.index) || input.index < 0 || input.index >= upload.chunkCount) {
        throw new VideoAssetError(400, "Invalid video upload chunk index");
      }
      const expectedSize = partSize(upload.size, upload.chunkCount, input.index);
      if (input.bytes.byteLength !== expectedSize) throw new VideoAssetError(400, "Video upload chunk has the wrong size");
      if (input.index === 0 && !validVideoHeader(upload.mime as SupportedVideoMime, input.bytes)) {
        throw new VideoAssetError(415, "The file contents do not match an MP4 or WebM video");
      }

      const partHash = hash(input.bytes);
      await tx
        .insert(schema.videoUploadParts)
        .values({
          uploadId: upload.id,
          partIndex: input.index,
          size: input.bytes.byteLength,
          sha256: partHash,
        })
        .onConflictDoNothing({ target: [schema.videoUploadParts.uploadId, schema.videoUploadParts.partIndex] });
      const [storedPart] = await tx
        .select({ size: schema.videoUploadParts.size, sha256: schema.videoUploadParts.sha256 })
        .from(schema.videoUploadParts)
        .where(and(eq(schema.videoUploadParts.uploadId, upload.id), eq(schema.videoUploadParts.partIndex, input.index)));
      if (!storedPart || storedPart.size !== input.bytes.byteLength || storedPart.sha256 !== partHash) {
        throw new VideoAssetError(409, "This video upload chunk was already sent with different contents");
      }

      await getVideoStorage().putChunk(upload.storageKey, input.index, input.bytes);
    });
  } catch (error) {
    if (error instanceof VideoStorageError) throw new VideoAssetError(503, error.message);
    throw error;
  }
}

async function setUploadState(id: string, documentId: string, state: "uploading" | "completing"): Promise<void> {
  const db = await getDb();
  await db
    .update(schema.videoUploads)
    .set({ state })
    .where(and(eq(schema.videoUploads.id, id), eq(schema.videoUploads.documentId, documentId)));
}

async function enqueueVideoStorageCleanup(tx: Tx, keys: readonly string[]): Promise<void> {
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length === 0) return;
  await tx
    .insert(schema.videoStorageCleanup)
    .values(uniqueKeys.map((storageKey) => ({ storageKey })))
    .onConflictDoNothing();
}

export async function registerVideoCopyReservations(reservations: readonly VideoCopyReservation[]): Promise<void> {
  if (reservations.length === 0) return;
  const db = await getDb();
  await db.insert(schema.videoUploads).values(
    reservations.map((reservation) => ({
      ...reservation,
      chunkCount: Math.ceil(reservation.size / VIDEO_CHUNK_BYTES),
      state: "completing",
    })),
  );
}

export async function finalizeVideoCopyReservations(ids: readonly string[], tx: Tx): Promise<void> {
  if (ids.length === 0) return;
  const reserved = await tx
    .select({ id: schema.videoUploads.id })
    .from(schema.videoUploads)
    .where(inArray(schema.videoUploads.id, [...ids]))
    .for("update");
  if (reserved.length !== ids.length) throw new Error("Video copy reservation was reaped before commit");
  await tx.delete(schema.videoUploads).where(inArray(schema.videoUploads.id, [...ids]));
}

export async function failVideoCopyReservations(reservations: readonly VideoCopyReservation[]): Promise<void> {
  if (reservations.length === 0) return;
  const db = await getDb();
  await db.transaction(async (tx) => {
    const ids = reservations.map(({ id }) => id);
    // Wait for an in-flight duplicate commit before checking whether its assets survived.
    await tx.delete(schema.videoUploads).where(inArray(schema.videoUploads.id, ids));
    const committed = await tx
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(inArray(schema.assets.id, ids));
    const committedIds = new Set(committed.map(({ id }) => id));
    await enqueueVideoStorageCleanup(
      tx,
      reservations.filter(({ id }) => !committedIds.has(id)).map(({ storageKey }) => storageKey),
    );
  });
  scheduleVideoStorageCleanup();
}

async function discardUpload(tx: Tx, upload: { id: string; documentId: string; storageKey: string }): Promise<void> {
  await tx
    .update(schema.videoUploads)
    .set({ state: "canceling" })
    .where(and(eq(schema.videoUploads.id, upload.id), eq(schema.videoUploads.documentId, upload.documentId)));
  await enqueueVideoStorageCleanup(tx, [upload.storageKey]);
  await tx.delete(schema.videoUploads).where(and(eq(schema.videoUploads.id, upload.id), eq(schema.videoUploads.documentId, upload.documentId)));
}

export async function cancelVideoUpload(documentId: string, uploadId: string): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const [upload] = await tx
      .select({
        id: schema.videoUploads.id,
        documentId: schema.videoUploads.documentId,
        storageKey: schema.videoUploads.storageKey,
        state: schema.videoUploads.state,
      })
      .from(schema.videoUploads)
      .where(and(eq(schema.videoUploads.id, uploadId), eq(schema.videoUploads.documentId, documentId)))
      .for("update");
    if (!upload) return;
    if (upload.state === "completing") throw new VideoAssetError(409, "Video upload is being finalized");
    await discardUpload(tx, upload);
  });
  scheduleVideoStorageCleanup();
}

export async function completeVideoUpload(documentId: string, uploadId: string): Promise<StoredVideoAsset> {
  const db = await getDb();
  const [claimed] = await db
    .update(schema.videoUploads)
    .set({ state: "completing" })
    .where(
      and(
        eq(schema.videoUploads.id, uploadId),
        eq(schema.videoUploads.documentId, documentId),
        eq(schema.videoUploads.state, "uploading"),
      ),
    )
    .returning();

  if (!claimed) {
    const [existing] = await db
      .select({
        id: schema.assets.id,
        documentId: schema.assets.documentId,
        name: schema.assets.name,
        mime: schema.assets.mime,
        size: schema.assets.size,
        storageKey: schema.assets.storageKey,
      })
      .from(schema.assets)
      .where(and(eq(schema.assets.id, uploadId), eq(schema.assets.documentId, documentId), isNotNull(schema.assets.storageKey)));
    if (existing) {
      return {
        id: existing.id,
        documentId: existing.documentId,
        name: existing.name,
        mime: existing.mime as SupportedVideoMime,
        size: existing.size,
        url: videoAssetUrl(existing.id, existing.mime as SupportedVideoMime),
      };
    }
    const [upload] = await db
      .select({ state: schema.videoUploads.state })
      .from(schema.videoUploads)
      .where(and(eq(schema.videoUploads.id, uploadId), eq(schema.videoUploads.documentId, documentId)));
    if (upload?.state === "completing") throw new VideoAssetError(409, "Video upload is being finalized");
    throw new VideoAssetError(404, "Video upload not found");
  }

  const reset = () => setUploadState(uploadId, documentId, "uploading");
  try {
    const parts = await db
      .select()
      .from(schema.videoUploadParts)
      .where(eq(schema.videoUploadParts.uploadId, claimed.id))
      .orderBy(asc(schema.videoUploadParts.partIndex));
    if (parts.length !== claimed.chunkCount || parts.some((part, index) => part.partIndex !== index || part.size !== partSize(claimed.size, claimed.chunkCount, index))) {
      throw new VideoAssetError(409, "Video upload is incomplete");
    }

    try {
      const storage = getVideoStorage();
      await storage.complete(claimed.storageKey, claimed.chunkCount, claimed.size);
      await storage.clearParts(claimed.storageKey);
    } catch (error) {
      if (error instanceof VideoStorageError) throw new VideoAssetError(503, error.message);
      throw error;
    }

    await db.transaction(async (tx) => {
      await tx.insert(schema.assets).values({
        id: claimed.id,
        documentId: claimed.documentId,
        userId: claimed.userId,
        name: claimed.name,
        mime: claimed.mime,
        size: claimed.size,
        sha256: null,
        data: null,
        storageKey: claimed.storageKey,
      });
      await tx.delete(schema.videoUploads).where(eq(schema.videoUploads.id, claimed.id));
    });

    return {
      id: claimed.id,
      documentId: claimed.documentId,
      name: claimed.name,
      mime: claimed.mime as SupportedVideoMime,
      size: claimed.size,
      url: videoAssetUrl(claimed.id, claimed.mime as SupportedVideoMime),
    };
  } catch (error) {
    await reset();
    throw error;
  }
}

export async function getVideoAsset(id: string): Promise<VideoAsset | null> {
  const db = await getDb();
  const [row] = await db
    .select({
      id: schema.assets.id,
      documentId: schema.assets.documentId,
      name: schema.assets.name,
      mime: schema.assets.mime,
      size: schema.assets.size,
      storageKey: schema.assets.storageKey,
    })
    .from(schema.assets)
    .where(and(eq(schema.assets.id, id), isNotNull(schema.assets.storageKey)));
  if (!row || !isSupportedMime(row.mime)) return null;
  return { ...row, mime: row.mime, storageKey: row.storageKey! };
}

/** Caller holds the document row lock and records cleanup in the same transaction as permanent deletion. */
export async function deleteVideoStorageForDocument(documentId: string, tx: Tx): Promise<void> {
  const uploads = await tx
    .select({
      id: schema.videoUploads.id,
      state: schema.videoUploads.state,
      storageKey: schema.videoUploads.storageKey,
    })
    .from(schema.videoUploads)
    .where(eq(schema.videoUploads.documentId, documentId))
    .for("update");
  if (uploads.some((upload) => upload.state !== "uploading" && upload.state !== "canceling")) {
    throw new VideoAssetError(409, "A video upload is being finalized");
  }
  await tx
    .update(schema.videoUploads)
    .set({ state: "canceling" })
    .where(and(eq(schema.videoUploads.documentId, documentId), eq(schema.videoUploads.state, "uploading")));
  const assets = await tx
    .select({ storageKey: schema.assets.storageKey })
    .from(schema.assets)
    .where(and(eq(schema.assets.documentId, documentId), isNotNull(schema.assets.storageKey)));
  const keys = [...assets, ...uploads].map((row) => row.storageKey).filter((key): key is string => !!key);
  await enqueueVideoStorageCleanup(tx, keys);
}

export async function discardVideoBlobs(keys: string[]): Promise<void> {
  if (!keys.length) return;
  try {
    const storage = getVideoStorage();
    await Promise.all(keys.map((key) => storage.discard(key)));
  } catch (error) {
    if (error instanceof VideoStorageError) throw new VideoAssetError(503, error.message);
    throw error;
  }
}

/** Remove queued blobs after their database transaction commits; failed deletes remain retryable. */
let cleanupSweep: Promise<number> | null = null;
let cleanupSweepRequested = false;

export async function sweepVideoStorageCleanup(): Promise<number> {
  if (cleanupSweep) return cleanupSweep;
  const active = (async () => {
    let totalRemoved = 0;
    do {
      cleanupSweepRequested = false;
      const db = await getDb();
      const pending = await db
        .select({ storageKey: schema.videoStorageCleanup.storageKey })
        .from(schema.videoStorageCleanup)
        .orderBy(asc(schema.videoStorageCleanup.createdAt))
        .limit(VIDEO_STORAGE_CLEANUP_BATCH_SIZE);
      let removed = 0;
      for (const { storageKey } of pending) {
        try {
          await getVideoStorage().discard(storageKey);
          await db.delete(schema.videoStorageCleanup).where(eq(schema.videoStorageCleanup.storageKey, storageKey));
          removed++;
        } catch (error) {
          console.error("[video-storage] cleanup failed", error);
        }
      }
      totalRemoved += removed;
    } while (cleanupSweepRequested);
    return totalRemoved;
  })();
  cleanupSweep = active;
  try {
    return await active;
  } finally {
    if (cleanupSweep === active) {
      cleanupSweep = null;
      if (cleanupSweepRequested) {
        cleanupSweepRequested = false;
        scheduleVideoStorageCleanup();
      }
    }
  }
}

export async function flushVideoStorageCleanup(): Promise<void> {
  try {
    const removed = await sweepVideoStorageCleanup();
    if (removed > 0) console.log(`> Removed ${removed} video blob(s) pending cleanup`);
  } catch (error) {
    console.error("[video-storage] cleanup sweep failed", error);
  }
}

/** Copy a video without buffering the full asset; used when a document is duplicated. */
export async function copyVideoBlob(sourceKey: string, targetId: string, size: number): Promise<string> {
  const storage = getVideoStorage();
  const targetKey = videoStorageKey(targetId);
  const reader = (await storage.stream(sourceKey)).getReader();
  let chunks: Uint8Array[] = [];
  let chunkBytes = 0;
  let total = 0;
  let index = 0;
  const writeChunk = async () => {
    const bytes = new Uint8Array(chunkBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    await storage.putChunk(targetKey, index++, bytes);
    chunks = [];
    chunkBytes = 0;
  };
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      let offset = 0;
      while (offset < result.value.byteLength) {
        const take = Math.min(VIDEO_CHUNK_BYTES - chunkBytes, result.value.byteLength - offset);
        chunks.push(result.value.subarray(offset, offset + take));
        chunkBytes += take;
        total += take;
        offset += take;
        if (chunkBytes === VIDEO_CHUNK_BYTES) await writeChunk();
      }
    }
    if (chunkBytes > 0) await writeChunk();
    if (total !== size || index === 0) throw new VideoAssetError(503, "Video storage returned an incomplete asset");
    await storage.complete(targetKey, index, size);
    return targetKey;
  } finally {
    reader.releaseLock();
  }
}

export async function sweepAbandonedVideoUploads(now = new Date()): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - VIDEO_UPLOAD_MAX_AGE_MS);
  const stale = await db.select({ id: schema.videoUploads.id }).from(schema.videoUploads).where(lt(schema.videoUploads.createdAt, cutoff));
  let removed = 0;
  for (const candidate of stale) {
    const didRemove = await db.transaction(async (tx) => {
      const [upload] = await tx
        .select({
          id: schema.videoUploads.id,
          storageKey: schema.videoUploads.storageKey,
          createdAt: schema.videoUploads.createdAt,
        })
        .from(schema.videoUploads)
        .where(eq(schema.videoUploads.id, candidate.id))
        .for("update");
      if (!upload || upload.createdAt >= cutoff) return false;
      await tx.update(schema.videoUploads).set({ state: "canceling" }).where(eq(schema.videoUploads.id, upload.id));
      await enqueueVideoStorageCleanup(tx, [upload.storageKey]);
      await tx.delete(schema.videoUploads).where(eq(schema.videoUploads.id, upload.id));
      return true;
    });
    if (didRemove) removed++;
  }
  if (cleanupSweep) cleanupSweepRequested = true;
  await flushVideoStorageCleanup();
  return removed;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function scheduleVideoStorageCleanup(): void {
  if (cleanupSweep) cleanupSweepRequested = true;
  void flushVideoStorageCleanup();
}

export function startVideoUploadSweeper(): void {
  if (sweepTimer) return;
  const sweep = () => {
    void sweepAbandonedVideoUploads()
      .then((count) => count > 0 && console.log(`> Removed ${count} abandoned video upload(s)`))
      .catch((error: unknown) => console.error("[video-upload] cleanup failed", error));
  };
  sweep();
  sweepTimer = setInterval(sweep, VIDEO_UPLOAD_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export function stopVideoUploadSweeper(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}
