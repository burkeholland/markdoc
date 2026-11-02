import { afterEach, describe, expect, it, vi } from "vitest";
import { createAzureVideoStorage } from "./video-storage";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Azure video streaming", () => {
  it("limits response-header latency without timing out the body and cancels upstream on reader cancellation", async () => {
    vi.useFakeTimers();
    vi.stubEnv("IDENTITY_ENDPOINT", "http://identity.invalid/token");
    vi.stubEnv("IDENTITY_HEADER", "unit-test-header");

    let requestNumber = 0;
    let upstreamSignal: AbortSignal | undefined;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestNumber++;
      if (requestNumber === 1) {
        return new Response(JSON.stringify({ access_token: "unit-test-token", expires_in: 3600 }), { status: 200 });
      }
      upstreamSignal = init?.signal ?? undefined;
      return new Response(body, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      if (milliseconds === 60_000) setTimeout(() => controller.abort(), 1);
      return controller.signal;
    });

    const storage = createAzureVideoStorage("https://account.blob.core.windows.net/private");
    const reader = (await storage.stream("videos/0123456789abcdef")).getReader();

    expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([1]) });
    await vi.advanceTimersByTimeAsync(1);
    expect(upstreamSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(upstreamSignal?.aborted).toBe(false);

    bodyController!.enqueue(new Uint8Array([2]));
    expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([2]) });
    await reader.cancel();
    expect(bodyCancelled).toBe(true);
  });
});
