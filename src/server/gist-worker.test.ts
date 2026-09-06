import { afterEach, describe, expect, it, vi } from "vitest";
import type { schema } from "@/server/db";
import { shutdownServices } from "../../server/shutdown";
import { coordinationPostgresFixtureUrl } from "./db/postgres-test-fixture";

const postgresFixture = coordinationPostgresFixtureUrl();
if (postgresFixture) process.env.DATABASE_URL = postgresFixture;

type Job = typeof schema.gistAutoUpdates.$inferSelect;
const selectDue = vi.hoisted(() => vi.fn<() => Promise<Job[]>>(async () => []));
const acquire = vi.hoisted(() => vi.fn<(
  gistId: string, filename: string, callback: (signal: AbortSignal) => Promise<void>, signal?: AbortSignal,
) => Promise<{ acquired: false }>>(async () => ({ acquired: false })));
vi.mock("@/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db")>();
  if (process.env.MARKDOC_PG_COORDINATION_TESTS === "1") return actual;
  return {
    ...actual,
    getDb: async () => ({
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: selectDue }) }) }) }),
    }),
    withGistPublicationLock: acquire,
  };
});
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
const { startGistAutoUpdateWorker, stopGistAutoUpdateWorker, GIST_WORKER_SHUTDOWN_MS } = await import("./gist-auto-update");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const candidate = (): Job => ({
  documentId: "fixture-doc", publisherId: "fixture-owner", gistId: "fixture-gist", filename: "notes.md",
  accountLogin: "fixture", isPublic: false, enabled: true, acknowledgedAt: new Date(),
  generation: "fixture-generation", queuedVersion: 1, syncedVersion: 0, activeVersion: null,
  dueAt: new Date(), status: "pending", syncedAt: null, message: null,
});
let expectedStopFailure = false;

afterEach(async () => {
  if (expectedStopFailure) await expect(stopGistAutoUpdateWorker()).rejects.toThrow();
  else await stopGistAutoUpdateWorker();
  expectedStopFailure = false;
  selectDue.mockReset().mockResolvedValue([]);
  acquire.mockReset().mockResolvedValue({ acquired: false });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("gist queue worker lifecycle", () => {
  it.skipIf(!postgresFixture)("real PostgreSQL worker polls the queue and stops without another scan", async () => {
    const { getDb, closeDb } = await import("@/server/db");
    const { Pool } = await import("pg");
    await getDb();
    const query = vi.spyOn(Pool.prototype, "query");
    try {
      startGistAutoUpdateWorker();
      await vi.waitFor(() => {
        expect(query.mock.calls.some(([statement]) => JSON.stringify(statement).includes("gist_auto_update"))).toBe(true);
      });
      const started = performance.now();
      await stopGistAutoUpdateWorker();
      expect(performance.now() - started).toBeLessThan(GIST_WORKER_SHUTDOWN_MS);
      const scans = query.mock.calls.length;
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(query).toHaveBeenCalledTimes(scans);
    } finally {
      await stopGistAutoUpdateWorker();
      query.mockRestore();
      await closeDb();
    }
  });

  it("starts only one process-wide poller and stops scheduling on shutdown", async () => {
    vi.useFakeTimers();
    startGistAutoUpdateWorker();
    startGistAutoUpdateWorker();
    await vi.advanceTimersByTimeAsync(1000);
    expect(selectDue).toHaveBeenCalledTimes(4);
    await stopGistAutoUpdateWorker();
    await vi.advanceTimersByTimeAsync(5000);
    expect(selectDue).toHaveBeenCalledTimes(4);
  });

  it("bounds queue infrastructure retries and logs no raw error payload", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    selectDue.mockRejectedValue(new Error("This fixture payload must not appear in logs"));
    startGistAutoUpdateWorker();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(selectDue).toHaveBeenCalledTimes(5);
    expect(errors).toHaveBeenCalledTimes(5);
    expect(errors.mock.calls.every((call) => call[0] === "[gist-auto-update] queue-unavailable" && typeof call[1] === "number")).toBe(true);
  });

  it("cancels pending coordination acquisition and never starts a later sender", async () => {
    vi.useFakeTimers();
    selectDue.mockResolvedValue([candidate()]);
    let canceled = false;
    acquire.mockImplementationOnce(async (_id, _file, _fn, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener("abort", () => { canceled = true; reject(signal!.reason); }, { once: true });
      });
      throw new Error("Canceled acquisition continued");
    });
    startGistAutoUpdateWorker();
    await vi.advanceTimersByTimeAsync(250);
    await stopGistAutoUpdateWorker();
    expect(canceled).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(acquire).toHaveBeenCalledOnce();
  });

  it.each([1, 2])("reports cleanup failure among %i canceled sessions instead of claiming a successful stop", async (count) => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    selectDue.mockResolvedValue(Array.from({ length: count }, (_, index) => ({ ...candidate(), documentId: `doc-${index}` })));
    if (count > 1) acquire.mockImplementationOnce(async (_id, _file, _fn, signal) => {
      await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
      return { acquired: false };
    });
    acquire.mockImplementationOnce(async (_id, _file, _fn, signal) => {
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("Fixture cleanup payload must not appear in logs");
    });
    startGistAutoUpdateWorker();
    await vi.advanceTimersByTimeAsync(250);
    expectedStopFailure = true;
    await expect(stopGistAutoUpdateWorker()).rejects.toThrow("did not stop cleanly");
    expect(errors).toHaveBeenCalledExactlyOnceWith("[gist-auto-update] shutdown-failed");
  });

  it("bounds stop while a scanner ignores cancellation, flushes collaboration independently, and fences late rows", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const query = deferred<Job[]>();
    selectDue.mockReturnValueOnce(query.promise);
    startGistAutoUpdateWorker();
    await vi.advanceTimersByTimeAsync(250);
    const flush = vi.fn(async () => {});
    expectedStopFailure = true;
    const stopped = shutdownServices(stopGistAutoUpdateWorker, flush);
    const failed = expect(stopped).rejects.toThrow("Service shutdown failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(flush).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(GIST_WORKER_SHUTDOWN_MS);
    await failed;
    expect(() => startGistAutoUpdateWorker()).toThrow("still stopping");
    query.resolve([candidate()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(acquire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not replace a canceled worker while acquisition still has a pending completion", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = deferred<void>();
    selectDue.mockResolvedValue([candidate()]);
    acquire.mockImplementationOnce(async (_id, _file, _fn, signal) => {
      await gate.promise;
      signal!.throwIfAborted();
      return { acquired: false };
    });
    startGistAutoUpdateWorker();
    await vi.advanceTimersByTimeAsync(250);
    expectedStopFailure = true;
    const failed = expect(stopGistAutoUpdateWorker()).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(GIST_WORKER_SHUTDOWN_MS);
    await failed;
    expect(() => startGistAutoUpdateWorker()).toThrow("still stopping");
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(acquire).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
