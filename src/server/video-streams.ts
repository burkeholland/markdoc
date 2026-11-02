import { randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { getDb, schema } from "@/server/db";

export const MAX_ANONYMOUS_VIDEO_STREAMS = 16;
const VIDEO_STREAM_LEASE_MS = 5 * 60 * 1000;
const VIDEO_STREAM_RENEW_MS = 60 * 1000;

export interface VideoStreamLease {
  signal: AbortSignal;
  release(): Promise<void>;
}

/** Claim one shared database slot so anonymous playback stays capped across app instances. */
export async function acquireAnonymousVideoStream(): Promise<VideoStreamLease | null> {
  const db = await getDb();
  await db
    .insert(schema.videoStreamSlots)
    .values(
      Array.from({ length: MAX_ANONYMOUS_VIDEO_STREAMS }, (_, index) => ({
        id: index + 1,
        leaseId: null,
        leaseUntil: new Date(0),
      })),
    )
    .onConflictDoNothing();
  for (let id = 1; id <= MAX_ANONYMOUS_VIDEO_STREAMS; id++) {
    const leaseId = randomUUID();
    const now = new Date();
    const [claimed] = await db
      .update(schema.videoStreamSlots)
      .set({ leaseId, leaseUntil: new Date(now.getTime() + VIDEO_STREAM_LEASE_MS) })
      .where(and(eq(schema.videoStreamSlots.id, id), lt(schema.videoStreamSlots.leaseUntil, now)))
      .returning();
    if (!claimed) continue;

    const controller = new AbortController();
    let active = true;
    const renew = async () => {
      if (!active) return;
      try {
        const renewedAt = new Date();
        const [renewed] = await db
          .update(schema.videoStreamSlots)
          .set({ leaseUntil: new Date(renewedAt.getTime() + VIDEO_STREAM_LEASE_MS) })
          .where(and(eq(schema.videoStreamSlots.id, id), eq(schema.videoStreamSlots.leaseId, leaseId)))
          .returning();
        if (!renewed) {
          controller.abort(new Error("Video stream lease was lost"));
          return;
        }
      } catch (error) {
        console.error("[video-stream] lease renewal failed", error);
        controller.abort(new Error("Video stream lease could not be renewed"));
      }
    };
    const timer = setInterval(() => void renew(), VIDEO_STREAM_RENEW_MS);
    timer.unref();

    return {
      signal: controller.signal,
      async release() {
        if (!active) return;
        active = false;
        clearInterval(timer);
        try {
          await db
            .update(schema.videoStreamSlots)
            .set({ leaseId: null, leaseUntil: new Date(0) })
            .where(and(eq(schema.videoStreamSlots.id, id), eq(schema.videoStreamSlots.leaseId, leaseId)));
        } catch (error) {
          console.error("[video-stream] lease release failed", error);
        }
      },
    };
  }
  return null;
}

/** Hold an anonymous lease until playback finishes or the viewer disconnects. */
export function leasedVideoStream(source: ReadableStream<Uint8Array>, lease: VideoStreamLease): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let downstreamCancelled = false;
  let downstreamErrored = false;
  let outputController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let cancelPromise: Promise<void> | null = null;
  let finishPromise: Promise<void> | null = null;

  const finish = () => {
    if (finishPromise) return finishPromise;
    finishPromise = (async () => {
      lease.signal.removeEventListener("abort", cancelSource);
      await cancelPromise;
      await lease.release();
    })();
    return finishPromise;
  };
  const cancelReader = (reason: unknown) => {
    if (!cancelPromise) {
      cancelPromise = reader.cancel(reason).catch((error: unknown) => {
        console.error("[video-stream] cancel failed", error);
      });
    }
    return cancelPromise;
  };
  const errorOutput = (error: unknown) => {
    if (downstreamCancelled || downstreamErrored || !outputController) return;
    downstreamErrored = true;
    outputController.error(error);
  };
  const cancelSource = () => {
    const reason = lease.signal.reason ?? new Error("Video stream lease was lost");
    void cancelReader(reason)
      .then(() => {
        errorOutput(reason);
        return finish();
      })
      .catch((error: unknown) => {
        errorOutput(error);
        console.error("[video-stream] stream cleanup failed", error);
      });
  };
  lease.signal.addEventListener("abort", cancelSource, { once: true });

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        outputController = controller;
        if (lease.signal.aborted) {
          errorOutput(lease.signal.reason ?? new Error("Video stream lease was lost"));
          cancelSource();
        }
      },
      async pull(controller) {
        try {
          if (lease.signal.aborted) throw lease.signal.reason ?? new Error("Video stream lease was lost");
          const result = await reader.read();
          if (downstreamCancelled) return;
          if (lease.signal.aborted) throw lease.signal.reason ?? new Error("Video stream lease was lost");
          if (result.done) {
            await finish();
            controller.close();
            return;
          }
          controller.enqueue(result.value);
        } catch (error) {
          errorOutput(error);
          await finish();
        }
      },
      async cancel(reason) {
        downstreamCancelled = true;
        await cancelReader(reason);
        await finish();
      },
    },
    { highWaterMark: 0 },
  );
}
