import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it, vi } from "vitest";
import { getDb, schema } from "@/server/db";
import {
  acquireAnonymousVideoStream,
  leasedVideoStream,
  MAX_ANONYMOUS_VIDEO_STREAMS,
  type VideoStreamLease,
} from "./video-streams";

vi.mock("@/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db")>();
  return { ...actual, getDb: vi.fn(actual.getDb) };
});

describe("acquireAnonymousVideoStream", () => {
  it("initializes missing shared slots without overwriting an active lease", async () => {
    const client = new PGlite("memory://");
    await client.waitReady;
    await client.exec(
      `CREATE TABLE video_stream_slot (
         id integer PRIMARY KEY,
         lease_id text,
         lease_until timestamptz NOT NULL
       )`,
    );
    vi.mocked(getDb).mockResolvedValue(drizzle(client, { schema }));

    try {
      const first = await acquireAnonymousVideoStream();
      const second = await acquireAnonymousVideoStream();
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();

      const slots = await client.query<{ id: number; lease_id: string | null }>(
        `SELECT id, lease_id FROM video_stream_slot ORDER BY id`,
      );
      expect(slots.rows).toHaveLength(MAX_ANONYMOUS_VIDEO_STREAMS);
      expect(slots.rows.slice(0, 2).every((slot) => slot.lease_id !== null)).toBe(true);
      expect(slots.rows[0].lease_id).not.toBe(slots.rows[1].lease_id);

      await first?.release();
      await second?.release();
    } finally {
      vi.mocked(getDb).mockReset();
      await client.close();
    }
  });
});

function makeLease() {
  const controller = new AbortController();
  const release = vi.fn(async () => {});
  const lease: VideoStreamLease = { signal: controller.signal, release };
  return { controller, lease, release };
}

describe("leasedVideoStream", () => {
  it("reads only on demand and keeps the anonymous slot while the viewer is stalled", async () => {
    let produced = 0;
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          produced++;
          controller.enqueue(new Uint8Array(64 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const { lease, release } = makeLease();
    const reader = leasedVideoStream(source, lease).getReader();

    expect((await reader.read()).done).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(produced).toBe(1);
    expect(release).not.toHaveBeenCalled();

    await reader.cancel();
    expect(cancelled).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the lease after the last requested chunk is consumed", async () => {
    const source = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const { lease, release } = makeLease();
    const reader = leasedVideoStream(source, lease).getReader();

    expect(await reader.read()).toMatchObject({ done: false, value: new Uint8Array([1]) });
    expect(release).not.toHaveBeenCalled();
    expect(await reader.read()).toMatchObject({ done: true });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("cancels storage and releases the lease if the shared slot is lost", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const { controller, lease, release } = makeLease();
    const reader = leasedVideoStream(source, lease).getReader();

    expect(await reader.read()).toMatchObject({ done: false });
    const reason = new Error("Video stream lease was lost");
    controller.abort(reason);

    await expect(reader.read()).rejects.toBe(reason);
    expect(cancelled).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
