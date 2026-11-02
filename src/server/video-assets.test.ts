import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/server/livedoc", () => ({
  evictLiveDocument: async () => {},
  readLiveText: async () => ({ title: null, clean: "" }),
}));

const { getDb, schema } = await import("./db");
const {
  beginVideoUpload,
  cancelVideoUpload,
  completeVideoUpload,
  putVideoUploadChunk,
  scheduleVideoStorageCleanup,
  sweepAbandonedVideoUploads,
  sweepVideoStorageCleanup,
} = await import("./video-assets");
const { duplicateDocument, purgeDocument } = await import("./documents");
const { setVideoStorageForTests } = await import("./video-storage");
type VideoStorage = import("./video-storage").VideoStorage;

function mp4Bytes(size = 12): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  return bytes;
}

function createMemoryVideoStorage(
  beforePut?: (events: string[]) => Promise<void>,
  beforeDiscard?: (events: string[], key: string) => Promise<void>,
) {
  const chunks = new Map<string, Map<number, Uint8Array>>();
  const blobs = new Map<string, Uint8Array>();
  const events: string[] = [];
  const storage: VideoStorage = {
    async putChunk(key, index, bytes) {
      await beforePut?.(events);
      const parts = chunks.get(key) ?? new Map<number, Uint8Array>();
      parts.set(index, new Uint8Array(bytes));
      chunks.set(key, parts);
    },
    async complete(key, chunkCount, size) {
      const parts = chunks.get(key);
      if (!parts || parts.size !== chunkCount) throw new Error("Missing test video chunks");
      const blob = new Uint8Array(size);
      let offset = 0;
      for (let index = 0; index < chunkCount; index++) {
        const part = parts.get(index);
        if (!part) throw new Error("Missing test video chunk");
        blob.set(part, offset);
        offset += part.byteLength;
      }
      if (offset !== size) throw new Error("Invalid test video size");
      blobs.set(key, blob);
    },
    async clearParts(key) {
      chunks.delete(key);
    },
    async discard(key) {
      events.push("discard");
      await beforeDiscard?.(events, key);
      chunks.delete(key);
      blobs.delete(key);
    },
    async stream(key, range) {
      const bytes = blobs.get(key);
      if (!bytes) throw new Error("Missing test video");
      const data = range ? bytes.subarray(range.start, range.end + 1) : bytes;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });
    },
  };
  return { storage, chunks, blobs, events };
}

describe("video uploads", () => {
  let ownerId: string;

  beforeAll(async () => {
    const db = await getDb();
    const [user] = await db.insert(schema.users).values({ name: "Video user", login: "video-user", email: "video-user@example.com" }).returning();
    ownerId = user.id;
  });

  afterEach(() => {
    setVideoStorageForTests(null);
    vi.restoreAllMocks();
  });

  async function createDocument(id: string) {
    const db = await getDb();
    await db.insert(schema.documents).values({ id, title: "Video uploads", ownerId, content: "" });
  }

  async function begin(documentId: string, size = 12) {
    return beginVideoUpload({ documentId, userId: ownerId, name: "phone clip.mp4", mime: "video/mp4", size });
  }

  it("checks a fixed file header before storing a part and keeps video bytes outside PostgreSQL", async () => {
    const documentId = "video-header-doc";
    await createDocument(documentId);
    const { storage, chunks } = createMemoryVideoStorage();
    setVideoStorageForTests(storage);
    const { uploadId } = await begin(documentId);
    const db = await getDb();

    await expect(putVideoUploadChunk({ documentId, uploadId, index: 0, bytes: new Uint8Array(12) })).rejects.toMatchObject({ status: 415 });
    expect(await db.select().from(schema.videoUploadParts).where(eq(schema.videoUploadParts.uploadId, uploadId))).toHaveLength(0);
    expect(chunks.size).toBe(0);

    const bytes = mp4Bytes();
    await putVideoUploadChunk({ documentId, uploadId, index: 0, bytes });
    const [part] = await db.select().from(schema.videoUploadParts).where(eq(schema.videoUploadParts.uploadId, uploadId));
    expect(part).toEqual({
      uploadId,
      partIndex: 0,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(chunks.values().next().value?.get(0)).toEqual(bytes);
    await cancelVideoUpload(documentId, uploadId);
  });

  it("cancellation waits for an in-flight chunk write, then removes its storage", async () => {
    const documentId = "video-cancel-race-doc";
    await createDocument(documentId);
    let release!: () => void;
    let signalStarted!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    const { storage, events } = createMemoryVideoStorage(async (events) => {
      events.push("put-start");
      signalStarted();
      await gate;
      events.push("put-finish");
    });
    setVideoStorageForTests(storage);
    const { uploadId } = await begin(documentId);
    const put = putVideoUploadChunk({ documentId, uploadId, index: 0, bytes: mp4Bytes() });
    await started;

    const cancel = cancelVideoUpload(documentId, uploadId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["put-start"]);
    release();
    await Promise.all([put, cancel]);
    await sweepVideoStorageCleanup();

    expect(events).toEqual(["put-start", "put-finish", "discard"]);
    const db = await getDb();
    expect(await db.select().from(schema.videoUploads)).toHaveLength(0);
    expect(await db.select().from(schema.videoUploadParts)).toHaveLength(0);
  });

  it("finalizes idempotently as an external video asset with no database payload", async () => {
    const documentId = "video-complete-doc";
    await createDocument(documentId);
    const { storage, blobs } = createMemoryVideoStorage();
    setVideoStorageForTests(storage);
    const { uploadId } = await begin(documentId);
    const bytes = mp4Bytes();
    await putVideoUploadChunk({ documentId, uploadId, index: 0, bytes });

    const completed = await completeVideoUpload(documentId, uploadId);
    expect(completed).toMatchObject({ id: uploadId, documentId, mime: "video/mp4", size: bytes.byteLength, url: `/api/assets/${uploadId}.mp4` });
    expect(blobs.get(`videos/${uploadId}`)).toEqual(bytes);
    expect(await completeVideoUpload(documentId, uploadId)).toEqual(completed);

    const db = await getDb();
    const [asset] = await db.select().from(schema.assets).where(eq(schema.assets.id, uploadId));
    expect(asset).toMatchObject({ id: uploadId, data: null, storageKey: `videos/${uploadId}` });
  });

  it("purges after an in-flight chunk settles and refuses a finalizing upload", async () => {
    const documentId = "video-purge-race-doc";
    await createDocument(documentId);
    let release!: () => void;
    let signalStarted!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    const { storage, events } = createMemoryVideoStorage(async (events) => {
      events.push("put-start");
      signalStarted();
      await gate;
      events.push("put-finish");
    });
    setVideoStorageForTests(storage);
    const { uploadId } = await begin(documentId);
    const put = putVideoUploadChunk({ documentId, uploadId, index: 0, bytes: mp4Bytes() });
    await started;

    const purge = purgeDocument(documentId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["put-start"]);
    release();
    await Promise.all([put, purge]);
    await sweepVideoStorageCleanup();
    expect(events).toEqual(["put-start", "put-finish", "discard"]);

    const activeDocumentId = "video-purge-finalizing-doc";
    await createDocument(activeDocumentId);
    const finalizing = await begin(activeDocumentId);
    const db = await getDb();
    await db.update(schema.videoUploads).set({ state: "completing" }).where(eq(schema.videoUploads.id, finalizing.uploadId));
    await expect(purgeDocument(activeDocumentId)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.documents).where(eq(schema.documents.id, activeDocumentId))).toHaveLength(1);
    expect(events).toEqual(["put-start", "put-finish", "discard"]);
  });

  it("keeps a failed blob deletion queued after the document transaction commits", async () => {
    const documentId = "video-purge-cleanup-retry-doc";
    await createDocument(documentId);
    const videoId = "2123456789abcdef";
    const db = await getDb();
    await db.insert(schema.assets).values({
      id: videoId,
      documentId,
      userId: ownerId,
      name: "clip.mp4",
      mime: "video/mp4",
      size: 12,
      sha256: null,
      data: null,
      storageKey: `videos/${videoId}`,
    });
    let fail = true;
    const { storage, events } = createMemoryVideoStorage(undefined, async () => {
      if (fail) throw new Error("storage unavailable");
    });
    setVideoStorageForTests(storage);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(purgeDocument(documentId)).resolves.toBeUndefined();
    await sweepVideoStorageCleanup();

    expect(await db.select().from(schema.documents).where(eq(schema.documents.id, documentId))).toHaveLength(0);
    expect(events).toEqual(["discard"]);
    expect(await db.select({ storageKey: schema.videoStorageCleanup.storageKey }).from(schema.videoStorageCleanup)).toEqual([
      { storageKey: `videos/${videoId}` },
    ]);
    expect(errorLog).toHaveBeenCalledWith("[video-storage] cleanup failed", expect.any(Error));

    fail = false;
    await expect(sweepVideoStorageCleanup()).resolves.toBe(1);
    expect(events).toEqual(["discard", "discard"]);
    expect(await db.select().from(schema.videoStorageCleanup)).toHaveLength(0);
  });

  it("processes cleanup work queued while another sweep is active", async () => {
    const firstKey = "videos/3123456789abcdef";
    const secondKey = "videos/4123456789abcdef";
    const db = await getDb();
    await db.insert(schema.videoStorageCleanup).values({ storageKey: firstKey });
    let release!: () => void;
    let signalStarted!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    const { storage, events } = createMemoryVideoStorage(undefined, async (_events, key) => {
      if (key !== firstKey) return;
      signalStarted();
      await gate;
    });
    setVideoStorageForTests(storage);

    const sweep = sweepVideoStorageCleanup();
    await started;
    await db.insert(schema.videoStorageCleanup).values({ storageKey: secondKey });
    scheduleVideoStorageCleanup();
    release();
    await expect(sweep).resolves.toBe(2);

    expect(events).toEqual(["discard", "discard"]);
    expect(await db.select().from(schema.videoStorageCleanup)).toHaveLength(0);
  });

  it("reserves copied blobs before duplication and commits the reservation with the copied asset", async () => {
    const documentId = "video-copy-source-doc";
    await createDocument(documentId);
    const videoId = "5123456789abcdef";
    const sourceKey = `videos/${videoId}`;
    const db = await getDb();
    await db.insert(schema.assets).values({
      id: videoId,
      documentId,
      userId: ownerId,
      name: "clip.mp4",
      mime: "video/mp4",
      size: 12,
      sha256: null,
      data: null,
      storageKey: sourceKey,
    });
    const observedReservations: { documentId: string; state: string; storageKey: string }[][] = [];
    const { storage, blobs } = createMemoryVideoStorage(async () => {
      if (observedReservations.length === 0) {
        observedReservations.push(
          await db
            .select({
              documentId: schema.videoUploads.documentId,
              state: schema.videoUploads.state,
              storageKey: schema.videoUploads.storageKey,
            })
            .from(schema.videoUploads)
            .where(eq(schema.videoUploads.documentId, documentId)),
        );
      }
    });
    setVideoStorageForTests(storage);
    const bytes = mp4Bytes();
    blobs.set(sourceKey, bytes);

    const duplicate = await duplicateDocument(documentId, ownerId, { content: `# Copy\n\n![clip](/api/assets/${videoId}.mp4)` });

    expect(observedReservations).toHaveLength(1);
    expect(observedReservations[0]).toHaveLength(1);
    expect(observedReservations[0]?.[0]).toMatchObject({ documentId, state: "completing" });
    const [copied] = await db.select().from(schema.assets).where(eq(schema.assets.documentId, duplicate.id));
    expect(copied).toBeDefined();
    if (!copied) throw new Error("Expected the duplicate to contain a video asset");
    expect(copied).toMatchObject({ data: null, size: 12, storageKey: `videos/${copied.id}` });
    expect(blobs.get(copied.storageKey!)).toEqual(bytes);
    expect(await db.select().from(schema.videoUploads).where(eq(schema.videoUploads.documentId, documentId))).toHaveLength(0);
    expect(
      await db.select().from(schema.videoStorageCleanup).where(eq(schema.videoStorageCleanup.storageKey, copied.storageKey!)),
    ).toHaveLength(0);
  });

  it("rolls back a duplicate if its reservation is reaped during the copy", async () => {
    const documentId = "video-copy-reaped-doc";
    await createDocument(documentId);
    const videoId = "7123456789abcdef";
    const sourceKey = `videos/${videoId}`;
    const db = await getDb();
    await db.insert(schema.assets).values({
      id: videoId,
      documentId,
      userId: ownerId,
      name: "clip.mp4",
      mime: "video/mp4",
      size: 12,
      sha256: null,
      data: null,
      storageKey: sourceKey,
    });
    let reservationId: string | null = null;
    let targetKey: string | null = null;
    let reaped = false;
    const { storage, blobs } = createMemoryVideoStorage(async () => {
      if (reaped) return;
      const [reservation] = await db
        .select({ id: schema.videoUploads.id, storageKey: schema.videoUploads.storageKey })
        .from(schema.videoUploads)
        .where(eq(schema.videoUploads.documentId, documentId));
      if (!reservation) throw new Error("Expected video copy reservation before writing the blob");
      reservationId = reservation.id;
      targetKey = reservation.storageKey;
      await db.update(schema.videoUploads).set({ createdAt: new Date(0) }).where(eq(schema.videoUploads.id, reservation.id));
      await expect(sweepAbandonedVideoUploads()).resolves.toBe(1);
      reaped = true;
    });
    setVideoStorageForTests(storage);
    blobs.set(sourceKey, mp4Bytes());

    await expect(
      duplicateDocument(documentId, ownerId, { content: `# Copy\n\n![clip](/api/assets/${videoId}.mp4)` }),
    ).rejects.toThrow("Video copy reservation was reaped before commit");
    await sweepVideoStorageCleanup();

    expect(reservationId).not.toBeNull();
    expect(targetKey).not.toBeNull();
    if (!reservationId || !targetKey) throw new Error("Expected the duplicate copy reservation to be captured");
    expect(await db.select().from(schema.assets).where(eq(schema.assets.id, reservationId))).toHaveLength(0);
    expect(await db.select().from(schema.videoUploads).where(eq(schema.videoUploads.id, reservationId))).toHaveLength(0);
    expect(await db.select().from(schema.videoStorageCleanup).where(eq(schema.videoStorageCleanup.storageKey, targetKey))).toHaveLength(0);
    expect(blobs.has(targetKey)).toBe(false);
  });

  it("queues failed copied blobs without masking the copy error, and retries cleanup", async () => {
    const documentId = "video-copy-failure-doc";
    await createDocument(documentId);
    const videoId = "6123456789abcdef";
    const sourceKey = `videos/${videoId}`;
    const db = await getDb();
    await db.insert(schema.assets).values({
      id: videoId,
      documentId,
      userId: ownerId,
      name: "clip.mp4",
      mime: "video/mp4",
      size: 12,
      sha256: null,
      data: null,
      storageKey: sourceKey,
    });
    let failDiscard = true;
    const discardedKeys: string[] = [];
    let targetKey: string | null = null;
    const { storage, blobs } = createMemoryVideoStorage(
      async () => {
        const [reservation] = await db
          .select({ storageKey: schema.videoUploads.storageKey })
          .from(schema.videoUploads)
          .where(eq(schema.videoUploads.documentId, documentId));
        targetKey = reservation?.storageKey ?? null;
        throw new Error("simulated video copy failure");
      },
      async (_events, key) => {
        discardedKeys.push(key);
        if (failDiscard) throw new Error("simulated storage cleanup failure");
      },
    );
    setVideoStorageForTests(storage);
    blobs.set(sourceKey, mp4Bytes());
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      duplicateDocument(documentId, ownerId, { content: `# Copy\n\n![clip](/api/assets/${videoId}.mp4)` }),
    ).rejects.toThrow("simulated video copy failure");
    await sweepVideoStorageCleanup();

    expect(targetKey).not.toBeNull();
    if (!targetKey) throw new Error("Expected failed video copy to have a reserved target key");
    const [cleanup] = await db
      .select()
      .from(schema.videoStorageCleanup)
      .where(eq(schema.videoStorageCleanup.storageKey, targetKey));
    expect(cleanup).toBeDefined();
    if (!cleanup) throw new Error("Expected failed video copy cleanup to be queued");
    expect(cleanup.storageKey).not.toBe(sourceKey);
    expect(await db.select().from(schema.videoUploads).where(eq(schema.videoUploads.documentId, documentId))).toHaveLength(0);
    expect(errorLog).toHaveBeenCalledWith("[video-storage] cleanup failed", expect.any(Error));
    expect(discardedKeys).toEqual([cleanup.storageKey]);

    failDiscard = false;
    await expect(sweepVideoStorageCleanup()).resolves.toBe(1);
    expect(discardedKeys).toEqual([cleanup.storageKey, cleanup.storageKey]);
    expect(await db.select().from(schema.videoStorageCleanup)).toHaveLength(0);
  });

  it("durably queues a copied blob when the document transaction fails", async () => {
    const documentId = "video-copy-transaction-failure-doc";
    await createDocument(documentId);
    const videoId = "8123456789abcdef";
    const sourceKey = `videos/${videoId}`;
    const db = await getDb();
    await db.insert(schema.assets).values({
      id: videoId,
      documentId,
      userId: ownerId,
      name: "clip.mp4",
      mime: "video/mp4",
      size: 12,
      sha256: null,
      data: null,
      storageKey: sourceKey,
    });
    await db.execute(
      sql.raw(
        `create or replace function markdoc_test_fail_video_copy() returns trigger language plpgsql as $$ begin raise exception 'injected video copy transaction failure'; end $$`,
      ),
    );
    await db.execute(
      sql.raw(
        `create trigger markdoc_test_fail_video_copy before insert on asset for each row execute function markdoc_test_fail_video_copy()`,
      ),
    );
    let failDiscard = true;
    const discardedKeys: string[] = [];
    const { storage, blobs } = createMemoryVideoStorage(undefined, async (_events, key) => {
      discardedKeys.push(key);
      if (failDiscard) throw new Error("simulated storage cleanup failure");
    });
    setVideoStorageForTests(storage);
    blobs.set(sourceKey, mp4Bytes());
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        duplicateDocument(documentId, ownerId, { content: `# Copy\n\n![clip](/api/assets/${videoId}.mp4)` }),
      ).rejects.toThrow('Failed query: insert into "asset"');
      await sweepVideoStorageCleanup();

      expect(discardedKeys).toHaveLength(1);
      expect(discardedKeys[0]).not.toBe(sourceKey);
      const [cleanup] = await db
        .select()
        .from(schema.videoStorageCleanup)
        .where(eq(schema.videoStorageCleanup.storageKey, discardedKeys[0]!));
      expect(cleanup).toBeDefined();
      expect(await db.select().from(schema.videoUploads).where(eq(schema.videoUploads.documentId, documentId))).toHaveLength(0);
      expect(errorLog).toHaveBeenCalledWith("[video-storage] cleanup failed", expect.any(Error));

      failDiscard = false;
      await expect(sweepVideoStorageCleanup()).resolves.toBe(1);
      expect(discardedKeys).toEqual([discardedKeys[0], discardedKeys[0]]);
      expect(await db.select().from(schema.videoStorageCleanup)).toHaveLength(0);
    } finally {
      await db.execute(sql.raw(`drop trigger markdoc_test_fail_video_copy on asset`));
      await db.execute(sql.raw(`drop function markdoc_test_fail_video_copy()`));
    }
  });

  it("reaps abandoned video-copy reservations through the upload sweeper", async () => {
    const documentId = "video-copy-abandoned-doc";
    await createDocument(documentId);
    const uploadId = "9123456789abcdef";
    const storageKey = `videos/${uploadId}`;
    const db = await getDb();
    await db.insert(schema.videoUploads).values({
      id: uploadId,
      documentId,
      userId: ownerId,
      name: "clip.mp4",
      mime: "video/mp4",
      size: 12,
      chunkCount: 1,
      state: "completing",
      storageKey,
      createdAt: new Date(0),
    });
    const { storage, blobs, events } = createMemoryVideoStorage();
    setVideoStorageForTests(storage);
    blobs.set(storageKey, mp4Bytes());

    await expect(sweepAbandonedVideoUploads()).resolves.toBe(1);

    expect(events).toEqual(["discard"]);
    expect(await db.select().from(schema.videoUploads).where(eq(schema.videoUploads.id, uploadId))).toHaveLength(0);
    expect(await db.select().from(schema.videoStorageCleanup)).toHaveLength(0);
    expect(blobs.has(storageKey)).toBe(false);
  });
});
