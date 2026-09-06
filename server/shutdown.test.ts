import { describe, expect, it, vi } from "vitest";
import { shutdownServices } from "./shutdown";

describe("independent collaboration shutdown", () => {
  it("starts flushing documents without waiting for publication shutdown", async () => {
    let release!: () => void;
    const publishing = new Promise<void>((resolve) => { release = resolve; });
    const flush = vi.fn(async () => {});
    const stopping = shutdownServices(() => publishing, flush);
    await Promise.resolve();
    expect(flush).toHaveBeenCalledOnce();
    release();
    await stopping;
  });

  it.each(["throw", "reject"] as const)("still flushes when publisher cleanup fails via %s", async (failure) => {
    const flush = vi.fn(async () => {});
    const stop = () => {
      if (failure === "throw") throw new Error("Owned session cleanup failed");
      return Promise.reject(new Error("Owned session cleanup failed"));
    };
    await expect(shutdownServices(stop, flush)).rejects.toThrow("Service shutdown failed");
    expect(flush).toHaveBeenCalledOnce();
  });

  it("waits for document flushing after publication cleanup fails and reports both failures", async () => {
    let release!: () => void;
    const flushing = new Promise<void>((resolve) => { release = resolve; });
    let finished = false;
    const stopped = shutdownServices(
      async () => { throw new Error("Publishing cleanup failed"); },
      async () => { await flushing; throw new Error("Document flush failed"); },
    ).catch((error: unknown) => { finished = true; return error; });
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    const error = await stopped;
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected both shutdown failures");
    expect(error.errors).toHaveLength(2);
  });
});
