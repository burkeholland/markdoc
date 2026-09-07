import { afterEach, describe, expect, it, vi } from "vitest";
import { Hocuspocus } from "@hocuspocus/server";
import { shutdownCollab } from "./hocuspocus";

describe("collaboration document drain", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fails when a loaded document cannot drain before the deadline", async () => {
    vi.useFakeTimers();
    const server = new Hocuspocus({ quiet: true, unloadImmediately: false });
    const connection = await server.openDirectConnection("held-open");
    const stopping = shutdownCollab(server, 100);
    const failed = expect(stopping).rejects.toThrow("Collaboration shutdown failed");

    await vi.advanceTimersByTimeAsync(100);
    await failed;
    expect(server.getDocumentsCount()).toBe(1);

    await connection.disconnect();
    await vi.runOnlyPendingTimersAsync();
  });
});
