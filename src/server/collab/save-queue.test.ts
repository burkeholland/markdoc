import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTENT_AUTOSAVE_IDLE_MS } from "@/lib/document-persistence";
import { DocumentSaveQueue } from "./save-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("document content autosave scheduling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("saves a typing/paste/undo burst after the configured idle window", async () => {
    const write = vi.fn(async (revision: number) => revision);
    const queue = new DocumentSaveQueue(write, vi.fn());
    for (let index = 0; index < 10; index++) {
      queue.edit(true);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(write).not.toHaveBeenCalled();
    expect(queue.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS - 101);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledExactlyOnceWith(10);
    expect(queue.state).toBe("saved");
  });

  it("has no maximum-time flush during continuous typing", async () => {
    const write = vi.fn(async (revision: number) => revision);
    const queue = new DocumentSaveQueue(write, vi.fn());
    for (let index = 0; index < 100; index++) {
      queue.edit(true);
      await vi.advanceTimersByTimeAsync(900);
    }
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS - 900);
    expect(write).toHaveBeenCalledExactlyOnceWith(100);
  });

  it("never writes for a clean flush and does not schedule redundant saves after manual flush", async () => {
    const pending = deferred<number>();
    const write = vi.fn(() => pending.promise);
    const queue = new DocumentSaveQueue(write, vi.fn());
    expect(await queue.flush()).toBeNull();
    expect(write).not.toHaveBeenCalled();
    queue.edit(true);
    const flush = queue.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(queue.state).toBe("saving");
    const acknowledged = vi.fn();
    void flush.then(acknowledged);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(acknowledged).not.toHaveBeenCalled();
    pending.resolve(1);
    await flush;
    expect(queue.state).toBe("saved");
    expect(await queue.flush()).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("keeps newest edits pending behind one in-flight write AND their latest idle deadline", async () => {
    const first = deferred<number>();
    const write = vi.fn().mockImplementationOnce(() => first.promise).mockImplementation(async (revision: number) => revision);
    const queue = new DocumentSaveQueue<number>(write, vi.fn());
    queue.edit(true);
    await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS);
    queue.edit(true);
    await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS + 100); // second edit's first deadline passes while saving
    queue.edit(true); // fresh deadline must supersede the expired one
    first.resolve(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(1);
    expect(queue.savedRevision).toBe(1);
    expect(queue.dirty).toBe(true);
    expect(queue.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS - 1);
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenNthCalledWith(2, 3);
    expect(queue.savedRevision).toBe(3);
  });

  it("manual Save while saving flushes the newest pending version only after the previous write settles", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const write = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const queue = new DocumentSaveQueue<number>(write, vi.fn());
    queue.edit(true);
    await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS);
    queue.edit(true);
    const flush = queue.flush();
    const done = vi.fn();
    void flush.then(done);
    expect(write).toHaveBeenCalledTimes(1);
    first.resolve(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(2);
    expect(done).not.toHaveBeenCalled();
    second.resolve(2);
    await flush;
    expect(queue.savedRevision).toBe(2);
  });

  it("retains latest edits on failure, surfaces error and bounds automatic retries", async () => {
    const first = deferred<number>();
    const write = vi.fn().mockImplementationOnce(() => first.promise).mockRejectedValue(new Error("store failed"));
    const queue = new DocumentSaveQueue<number>(write, vi.fn());
    queue.edit(true);
    const flush = queue.flush();
    const rejected = expect(flush).rejects.toThrow("store failed");
    queue.edit(true);
    first.reject(new Error("store failed"));
    await rejected;
    expect(queue.savedRevision).toBe(0);
    expect(queue.revision).toBe(2);
    expect(queue.state).toBe("error");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(write).toHaveBeenCalledTimes(4); // initial + three retries
    expect(queue.dirty).toBe(true);
    write.mockResolvedValue(2);
    expect(await queue.flush()).toBe(2);
    expect(queue.error).toBeNull();
    expect(queue.state).toBe("saved");
  });

  it("retains newer comment priority when an older content save fails during continued typing and IME", async () => {
    const first = deferred<number>();
    const write = vi.fn().mockImplementationOnce(() => first.promise).mockImplementation(async (revision: number) => revision);
    const queue = new DocumentSaveQueue<number>(write, vi.fn());
    queue.edit(true);
    await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS);
    queue.edit(false);
    queue.composition("typing-client", true);
    queue.edit(true);
    first.reject(new Error("older write failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.savedRevision).toBe(0);
    for (let index = 0; index < 9; index++) {
      queue.edit(true);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(write).toHaveBeenCalledTimes(1);
    queue.edit(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(write).toHaveBeenCalledTimes(2);
    expect(queue.savedRevision).toBe(queue.revision);
    expect(queue.state).toBe("saved");
  });

  it("pauses for IME and restarts at completion even without a final content transaction", async () => {
    const write = vi.fn(async (revision: number) => revision);
    const queue = new DocumentSaveQueue(write, vi.fn());
    queue.composition("client-a", true);
    queue.edit(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(write).not.toHaveBeenCalled();
    queue.composition("client-a", false);
    await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS - 1);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledOnce();
  });

  it("does not debounce unrelated comment actions and keeps documents independent", async () => {
    const writeA = vi.fn(async (revision: number) => revision);
    const writeB = vi.fn(async (revision: number) => revision);
    const a = new DocumentSaveQueue(writeA, vi.fn());
    const b = new DocumentSaveQueue(writeB, vi.fn());
    a.composition("client-a", true);
    a.edit(true);
    b.edit(true);
    a.edit(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeA).toHaveBeenCalledExactlyOnceWith(2);
    expect(writeB).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS);
    expect(writeB).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("releases a disconnected composition owner without dropping pending content", async () => {
    const write = vi.fn(async (revision: number) => revision);
    const queue = new DocumentSaveQueue(write, vi.fn());
    queue.composition("closing-tab", true);
    queue.edit(true);
    queue.composition("closing-tab", false);
    await vi.advanceTimersByTimeAsync(CONTENT_AUTOSAVE_IDLE_MS);
    expect(write).toHaveBeenCalledOnce();
  });
});
