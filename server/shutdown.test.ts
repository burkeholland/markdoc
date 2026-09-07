import { describe, expect, it, vi } from "vitest";
import { createShutdownOwner, SHUTDOWN_DEADLINE_MS, shutdownServices } from "./shutdown";

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

function owner(overrides: Partial<Parameters<typeof createShutdownOwner>[0]> = {}) {
  const log = vi.fn();
  const error = vi.fn();
  const exit = vi.fn();
  const dependencies = {
    stopIntake: vi.fn(async () => {}),
    stopPublishing: vi.fn(async () => {}),
    stopCollaboration: vi.fn(async () => {}),
    closeDatabase: vi.fn(async () => {}),
    exit,
    log,
    error,
    ...overrides,
  };
  return { shutdown: createShutdownOwner(dependencies), dependencies, log, error, exit };
}

describe("bounded process shutdown owner", () => {
  it("settles intake and durable work before closing the database and reporting success", async () => {
    const order: string[] = [];
    const { shutdown, exit, log } = owner({
      stopIntake: async () => { order.push("intake"); },
      stopPublishing: async () => { order.push("publishing"); },
      stopCollaboration: async () => { order.push("collaboration"); },
      closeDatabase: async () => { order.push("database"); },
    });

    await expect(shutdown.request("SIGTERM")).resolves.toBe(0);
    expect(order.slice(0, 3).sort()).toEqual(["collaboration", "intake", "publishing"]);
    expect(order[3]).toBe("database");
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining(
      "intake=ok publishing=ok collaboration=ok database=ok deadline=ok",
    ));
  });

  it("uses one promise and performs no duplicate work for repeated signals", async () => {
    let release!: () => void;
    const intake = new Promise<void>((resolve) => { release = resolve; });
    const stopIntake = vi.fn(() => intake);
    const { shutdown, dependencies, exit } = owner({ stopIntake });

    const first = shutdown.request("SIGINT");
    const duplicate = shutdown.request("SIGTERM");
    expect(duplicate).toBe(first);
    release();
    await first;
    expect(dependencies.stopIntake).toHaveBeenCalledOnce();
    expect(dependencies.closeDatabase).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("exits nonzero and logs only phase results when database closure fails", async () => {
    const sensitive = "postgres://user:secret@example.invalid/database";
    const { shutdown, error, exit } = owner({
      closeDatabase: async () => { throw new Error(sensitive); },
    });

    await expect(shutdown.request("SIGTERM")).resolves.toBe(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("database=failed"));
    expect(JSON.stringify(error.mock.calls)).not.toContain(sensitive);
  });

  it("bounds a hung store or document drain and never reports success", async () => {
    vi.useFakeTimers();
    try {
      const sensitive = "document text and token must not be logged";
      const { shutdown, error, exit } = owner({
        stopCollaboration: () => new Promise<void>(() => {
          void sensitive;
        }),
      });
      const stopping = shutdown.request("SIGTERM");
      await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);
      await expect(stopping).resolves.toBe(1);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("collaboration=pending"));
      expect(error).toHaveBeenCalledWith(expect.stringContaining("deadline=failed"));
      expect(JSON.stringify(error.mock.calls)).not.toContain(sensitive);
    } finally {
      vi.useRealTimers();
    }
  });

  it("owns interruption during startup and preserves the nonzero outcome", async () => {
    const { shutdown, dependencies, exit, error } = owner();
    const stopping = shutdown.request("startup");
    expect(shutdown.signal.aborted).toBe(true);
    await expect(stopping).resolves.toBe(1);
    expect(dependencies.stopIntake).toHaveBeenCalledOnce();
    expect(dependencies.closeDatabase).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("trigger=startup"));
  });
});
