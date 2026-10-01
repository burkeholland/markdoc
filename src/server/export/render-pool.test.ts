import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { Worker, WorkerOptions } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderedFragment, WorkerRequest, WorkerResponse } from "./render-markdown";

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: vi.fn(),
}));

// Only the public Worker API is faked; events are explicitly delivered after postMessage returns.
class FakeWorker extends EventEmitter implements Pick<Worker, "postMessage" | "unref" | "terminate"> {
  static instances: FakeWorker[] = [];
  static construct = vi.fn<(filename: string, options: WorkerOptions) => void>();
  static send = vi.fn<(worker: FakeWorker, request: WorkerRequest) => void>();

  readonly postMessage = vi.fn((request: WorkerRequest) => FakeWorker.send(this, request));
  readonly unref = vi.fn<() => void>();
  readonly terminate = vi.fn(async () => 1);

  constructor(filename: string, options: WorkerOptions) {
    super();
    FakeWorker.construct(filename, options);
    FakeWorker.instances.push(this);
  }

  request(index = this.postMessage.mock.calls.length - 1): WorkerRequest {
    return this.postMessage.mock.calls[index][0];
  }

  respond(response: WorkerResponse) {
    this.emit("message", response);
  }
}

const result: RenderedFragment = { html: "<p>rendered</p>", headings: [], assetIds: [] };
let renderOffThread: typeof import("./render-pool").renderOffThread;
let previewOffThread: typeof import("./render-pool").previewOffThread;
let RenderTimeoutError: typeof import("./render-pool").RenderTimeoutError;

function observe(promise: Promise<RenderedFragment>) {
  const resolved = vi.fn();
  const rejected = vi.fn();
  void promise.then(resolved, rejected);
  return { resolved, rejected };
}

function succeed(worker: FakeWorker) {
  worker.respond({ id: worker.request().id, ok: true, result });
}

async function expectSuccess(job: ReturnType<typeof observe>) {
  await Promise.resolve();
  expect(job.resolved).toHaveBeenCalledExactlyOnceWith(result);
  expect(job.rejected).not.toHaveBeenCalled();
}

async function expectFailure(job: ReturnType<typeof observe>, error: Error) {
  await Promise.resolve();
  expect(job.rejected).toHaveBeenCalledTimes(1);
  expect(job.rejected.mock.calls[0][0]).toBe(error);
  expect(job.resolved).not.toHaveBeenCalled();
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv("MARKDOWN_WORKER_PATH", undefined);
  vi.stubEnv("MARKDOWN_RENDER_TIMEOUT_MS", undefined);
  vi.mocked(existsSync).mockReset().mockReturnValue(true);
  FakeWorker.instances = [];
  FakeWorker.construct.mockReset();
  FakeWorker.send.mockReset();
  const getBuiltinModule = process.getBuiltinModule.bind(process);
  vi.spyOn(process, "getBuiltinModule").mockImplementation((id) =>
    id === "node:worker_threads" ? { Worker: FakeWorker } : getBuiltinModule(id),
  );
  ({ renderOffThread, previewOffThread, RenderTimeoutError } = await import("./render-pool"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("renderOffThread", () => {
  it("keeps one worker and FIFO order across successful and error responses", async () => {
    const first = observe(renderOffThread("first", "https://example.invalid"));
    const second = observe(renderOffThread("second", ""));
    const third = observe(renderOffThread("third", ""));
    const [worker] = FakeWorker.instances;
    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker.unref).toHaveBeenCalledTimes(1);
    expect(FakeWorker.construct.mock.calls[0][1]).toEqual({
      workerData: { role: "markdoc-markdown-render" }, stderr: false, stdout: false,
    });
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({
      id: 1, markdown: "first", assetBaseUrl: "https://example.invalid",
    });
    expect(vi.getTimerCount()).toBe(1);

    worker.respond({ id: 99, ok: true, result });
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    succeed(worker);
    await expectSuccess(first);
    expect(worker.request()).toMatchObject({ id: 2, markdown: "second" });
    worker.respond({ id: 1, ok: false, error: "duplicate response" });
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    worker.respond({ id: 2, ok: false, error: "render failed" });
    await Promise.resolve();
    expect(second.rejected).toHaveBeenCalledExactlyOnceWith(new Error("render failed"));
    expect(second.resolved).not.toHaveBeenCalled();
    expect(worker.request()).toMatchObject({ id: 3, markdown: "third" });
    succeed(worker);
    await expectSuccess(third);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("rejects a missing worker path and accepts a later job without a stuck current job", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const failed = observe(renderOffThread("missing", ""));
    await Promise.resolve();
    expect(failed.rejected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      message: expect.stringContaining("Markdown render worker not found"),
    }));
    expect(failed.resolved).not.toHaveBeenCalled();
    expect(FakeWorker.construct).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    vi.mocked(existsSync).mockReturnValue(true);
    const next = observe(renderOffThread("next", ""));
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].request().markdown).toBe("next");
    succeed(FakeWorker.instances[0]);
    await expectSuccess(next);
    expect(failed.rejected).toHaveBeenCalledTimes(1);
  });

  it.each(["constructor", "postMessage"] as const)("settles an initial %s throw with the original Error and recovers", async (source) => {
    const error = new Error(`${source} failed`);
    const hook = source === "constructor" ? FakeWorker.construct : FakeWorker.send;
    hook.mockImplementationOnce(() => { throw error; });
    const failed = observe(renderOffThread("failed", "", 10));
    await expectFailure(failed, error);
    expect(vi.getTimerCount()).toBe(0);
    const retired = source === "postMessage" ? FakeWorker.instances[0] : undefined;
    if (retired) expect(retired.terminate).toHaveBeenCalledTimes(1);

    const next = observe(renderOffThread("next", "", 100));
    expect(FakeWorker.instances).toHaveLength(retired ? 2 : 1);
    const worker = FakeWorker.instances.at(-1)!;
    expect(worker.request().markdown).toBe("next");
    await vi.advanceTimersByTimeAsync(10);
    expect(next.rejected).not.toHaveBeenCalled();
    succeed(worker);
    await expectSuccess(next);
    await expectFailure(failed, error);
  });

  it.each(["missing path", "constructor", "postMessage"] as const)("recovers queued jobs when %s throws inside a completion callback", async (source) => {
    const first = observe(renderOffThread("first", ""));
    const failed = observe(renderOffThread("failed", ""));
    const next = observe(renderOffThread("next", ""));
    const [worker] = FakeWorker.instances;
    const error = new Error("queued setup failed");
    const workerError = new Error("active worker failed");
    if (source === "missing path") vi.mocked(existsSync).mockReturnValue(false);
    if (source === "constructor") FakeWorker.construct.mockImplementationOnce(() => { throw error; });
    if (source === "postMessage") FakeWorker.send.mockImplementationOnce(() => { throw error; });

    expect(() => {
      if (source === "postMessage") succeed(worker);
      else worker.emit("error", workerError);
    }).not.toThrow();
    if (source === "postMessage") await expectSuccess(first);
    else await expectFailure(first, workerError);
    if (source === "missing path") {
      await Promise.resolve();
      expect(failed.rejected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        message: expect.stringContaining("Markdown render worker not found"),
      }));
      vi.mocked(existsSync).mockReturnValue(true);
    } else {
      await expectFailure(failed, error);
    }
    expect(failed.resolved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWorker.instances).toHaveLength(2);
    const fresh = FakeWorker.instances[1];
    expect(fresh.request()).toMatchObject({ id: 3, markdown: "next" });
    succeed(fresh);
    await expectSuccess(next);
    expect(failed.rejected).toHaveBeenCalledTimes(1);
  });

  it.each(["error", "clean exit", "nonzero exit"] as const)("rejects an active worker's %s and immediately starts the next FIFO job", async (event) => {
    const first = observe(renderOffThread("first", "", 10));
    const next = observe(renderOffThread("next", "", 100));
    const last = observe(renderOffThread("last", ""));
    const [retired] = FakeWorker.instances;
    const error = new Error("worker crashed");
    if (event === "error") retired.emit("error", error);
    else retired.emit("exit", event === "clean exit" ? 0 : 1);
    await Promise.resolve();
    if (event === "error") await expectFailure(first, error);
    else expect(first.rejected).toHaveBeenCalledExactlyOnceWith(new Error("Markdown render worker exited unexpectedly"));
    expect(first.resolved).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(2);
    const fresh = FakeWorker.instances[1];
    expect(fresh.request()).toMatchObject({ id: 2, markdown: "next" });
    expect(vi.getTimerCount()).toBe(1);
    retired.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(10);
    expect(next.rejected).not.toHaveBeenCalled();
    succeed(fresh);
    await expectSuccess(next);
    expect(fresh.request()).toMatchObject({ id: 3, markdown: "last" });
    succeed(fresh);
    await expectSuccess(last);
    expect(first.rejected).toHaveBeenCalledTimes(1);
  });

  it.each(["error", "success response", "error response", "exit"] as const)("ignores a timed-out worker's late %s even with the current job id", async (event) => {
    const failed = observe(renderOffThread("timeout", "", 10));
    const next = observe(renderOffThread("next", "", 100));
    const last = observe(renderOffThread("last", ""));
    const [retired] = FakeWorker.instances;
    await vi.advanceTimersByTimeAsync(10);
    expect(failed.rejected).toHaveBeenCalledExactlyOnceWith(new RenderTimeoutError(10));
    expect(retired.terminate).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances).toHaveLength(2);
    const fresh = FakeWorker.instances[1];
    const currentId = fresh.request().id;
    expect(vi.getTimerCount()).toBe(1);
    expect(() => {
      if (event === "error") retired.emit("error", new Error("late worker error"));
      if (event === "success response") retired.respond({ id: currentId, ok: true, result });
      if (event === "error response") retired.respond({ id: currentId, ok: false, error: "late response" });
      if (event === "exit") retired.emit("exit", 1);
    }).not.toThrow();
    await Promise.resolve();
    expect(next.rejected).not.toHaveBeenCalled();
    expect(next.resolved).not.toHaveBeenCalled();
    expect(fresh.postMessage).toHaveBeenCalledTimes(1);
    expect(fresh.terminate).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1);
    succeed(fresh);
    await expectSuccess(next);
    expect(fresh.request().markdown).toBe("last");
    succeed(fresh);
    await expectSuccess(last);
    expect(failed.rejected).toHaveBeenCalledTimes(1);
    expect(failed.resolved).not.toHaveBeenCalled();
  });

  it("starts each deadline only when its job is posted and leaves no timer after a lone timeout", async () => {
    const first = observe(renderOffThread("first", "", 10));
    const second = observe(renderOffThread("second", "", 40));
    await vi.advanceTimersByTimeAsync(10);
    expect(first.rejected).toHaveBeenCalledExactlyOnceWith(new RenderTimeoutError(10));
    expect(FakeWorker.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(39);
    expect(second.rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(second.rejected).toHaveBeenCalledExactlyOnceWith(new RenderTimeoutError(40));
    expect(FakeWorker.instances[1].terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const next = observe(renderOffThread("next", ""));
    expect(FakeWorker.instances).toHaveLength(3);
    succeed(FakeWorker.instances[2]);
    await expectSuccess(next);
  });

  it("uses the unchanged default deadline", async () => {
    const failed = observe(renderOffThread("default budget", ""));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(failed.rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(failed.rejected).toHaveBeenCalledExactlyOnceWith(new RenderTimeoutError(15_000));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unrefs the idle timer, cancels it on reuse, and retires only the idle worker", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const first = observe(renderOffThread("first", ""));
    const [worker] = FakeWorker.instances;
    succeed(worker);
    await expectSuccess(first);
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 30_000);
    expect(setTimeoutSpy.mock.results.at(-1)!.value.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(29_999);

    const reused = observe(renderOffThread("reused", "", 60_000));
    expect(FakeWorker.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.terminate).not.toHaveBeenCalled();
    succeed(worker);
    await expectSuccess(reused);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    const next = observe(renderOffThread("fresh", ""));
    expect(FakeWorker.instances).toHaveLength(2);
    worker.emit("exit", 1);
    succeed(FakeWorker.instances[1]);
    await expectSuccess(next);
    expect(FakeWorker.instances[1].unref).toHaveBeenCalledTimes(1);
  });

  it.each(["error", "exit"] as const)("clears an idle worker's timer after its %s and accepts another job", async (event) => {
    const first = observe(renderOffThread("first", ""));
    const [worker] = FakeWorker.instances;
    succeed(worker);
    await expectSuccess(first);
    if (event === "error") worker.emit("error", new Error("idle worker error"));
    else worker.emit("exit", 0);
    expect(vi.getTimerCount()).toBe(0);
    const next = observe(renderOffThread("next", ""));
    expect(FakeWorker.instances).toHaveLength(2);
    succeed(FakeWorker.instances[1]);
    await expectSuccess(next);
    await expectSuccess(first);
  });

  it("yields between queued setup failures instead of recursively draining the queue", async () => {
    const first = observe(renderOffThread("first", ""));
    const resolved = vi.fn();
    const rejected = vi.fn();
    const errors = 1_000;
    for (let i = 0; i < errors; i++) void renderOffThread(`failed-${i}`, "").then(resolved, rejected);
    const error = new Error("constructor unavailable");
    FakeWorker.construct.mockImplementation(() => { throw error; });
    expect(() => FakeWorker.instances[0].emit("exit", 1)).not.toThrow();
    expect(FakeWorker.construct).toHaveBeenCalledTimes(2);
    await vi.runAllTimersAsync();
    expect(first.rejected).toHaveBeenCalledTimes(1);
    expect(rejected).toHaveBeenCalledTimes(errors);
    expect(rejected.mock.calls.every(([received]) => received === error)).toBe(true);
    expect(resolved).not.toHaveBeenCalled();
    expect(FakeWorker.construct).toHaveBeenCalledTimes(errors + 1);
    expect(vi.getTimerCount()).toBe(0);

    FakeWorker.construct.mockReset();
    const next = observe(renderOffThread("next", ""));
    expect(FakeWorker.instances).toHaveLength(2);
    succeed(FakeWorker.instances[1]);
    await expectSuccess(next);
  });
});

describe("previewOffThread", () => {
  it("queues preview jobs with renders on the same worker, in order, under the same deadline", async () => {
    const render = observe(renderOffThread("render", ""));
    const preview = previewOffThread("# Title\n\nFirst lines.");
    const resolved = vi.fn();
    void preview.then(resolved);
    const [worker] = FakeWorker.instances;
    expect(worker.request()).toEqual({ id: 1, markdown: "render", assetBaseUrl: "" });
    succeed(worker);
    await expectSuccess(render);
    expect(worker.request()).toEqual({ id: 2, markdown: "# Title\n\nFirst lines.", preview: true });
    worker.respond({ id: 2, ok: true, result: "First lines." });
    await Promise.resolve();
    expect(resolved).toHaveBeenCalledExactlyOnceWith("First lines.");
    expect(FakeWorker.instances).toHaveLength(1);

    const slow = previewOffThread("slow");
    const rejected = vi.fn();
    void slow.catch(rejected);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(rejected).toHaveBeenCalledExactlyOnceWith(new RenderTimeoutError(15_000));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
