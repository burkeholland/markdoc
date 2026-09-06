import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { coordinationPostgresFixtureUrl } from "./postgres-test-fixture";

const postgresFixture = coordinationPostgresFixtureUrl();

type LockQueryResult = { rows: { locked: boolean }[] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeTransport {
  destroyed = false;
  readonly destroy = vi.fn((): FakeTransport => {
    this.destroyed = true;
    this.close();
    return this;
  });

  constructor(private readonly close: () => void) {}
}

class FakeClient extends EventEmitter {
  static instances: FakeClient[] = [];
  static configure: (client: FakeClient) => void = () => {};
  sessionOpen = false;
  readonly connection = { stream: new FakeTransport(() => { this.sessionOpen = false; }) };
  readonly connect = vi.fn(async () => { this.sessionOpen = true; });
  readonly query = vi.fn<(text: string, values: string[]) => Promise<LockQueryResult>>()
    .mockResolvedValue({ rows: [{ locked: true }] });
  readonly end = vi.fn(async () => {
    this.sessionOpen = false;
    this.emit("end");
  });

  constructor(readonly options: Record<string, unknown>) {
    super();
    FakeClient.instances.push(this);
    FakeClient.configure(this);
  }
}

class FakePool extends EventEmitter {
  static instances: FakePool[] = [];
  readonly end = vi.fn(async () => {});

  constructor(readonly options: Record<string, unknown>) {
    super();
    FakePool.instances.push(this);
  }
}

const migrate = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock("pg", async () => process.env.MARKDOC_PG_COORDINATION_TESTS === "1"
  ? vi.importActual("pg") : ({ Pool: FakePool, Client: FakeClient }));
vi.mock("drizzle-orm/node-postgres", async () => process.env.MARKDOC_PG_COORDINATION_TESTS === "1"
  ? vi.importActual("drizzle-orm/node-postgres") : ({ drizzle: () => ({}) }));
vi.mock("drizzle-orm/node-postgres/migrator", async () => process.env.MARKDOC_PG_COORDINATION_TESTS === "1"
  ? vi.importActual("drizzle-orm/node-postgres/migrator") : ({ migrate }));
vi.mock("@electric-sql/pglite", () => ({
  PGlite: class {
    waitReady = Promise.resolve();
    async close() {}
  },
}));
vi.mock("drizzle-orm/pglite", () => ({ drizzle: () => ({}) }));
vi.mock("drizzle-orm/pglite/migrator", () => ({ migrate }));

const {
  closeDb, getDb, withGistPublicationLock, withGistSettingsLock,
  GIST_LOCK_CONNECT_TIMEOUT_MS, GIST_LOCK_QUERY_TIMEOUT_MS, GIST_LOCK_CLOSE_TIMEOUT_MS,
} = await import("./index");

const CONNECTION_FAILED = "Gist publication coordination connection failed";
const ACQUISITION_FAILED = "Gist publication coordination acquisition failed";
const CLEANUP_FAILED = "Gist publication coordination cleanup failed";
const CANCELED = "Gist publication coordination was canceled";
const INTERRUPTED = "Gist publication coordination was interrupted";
const PRIVATE_DETAIL = "Fixture private transport or query detail";

beforeEach(() => {
  if (postgresFixture) {
    vi.stubEnv("DATABASE_URL", postgresFixture);
    return;
  }
  FakeClient.instances = [];
  FakeClient.configure = () => {};
  FakePool.instances = [];
  migrate.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("DATABASE_URL", "postgres://unused.invalid/gist-lock-test");
  vi.stubEnv("PGLITE_DATA_DIR", "memory://");
  vi.useFakeTimers();
});

afterEach(async () => {
  await closeDb();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe.skipIf(!postgresFixture)("real PostgreSQL gist coordination", () => {
  it("owns one session lock, rejects contention, and releases after success or failure", async () => {
    const db = await getDb();
    const result = await db.execute(sql`
      SELECT current_setting('server_version_num')::integer AS version,
        inet_server_port() AS port,
        (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS ssl
    `);
    expect(result.rows[0].version).toBeGreaterThanOrEqual(160000);
    expect(result.rows[0].version).toBeLessThan(170000);
    expect(result.rows[0].port).toBe(Number(new URL(postgresFixture!).port));
    expect(result.rows[0].ssl).toBe(true);
    const entered = deferred<void>();
    const finish = deferred<void>();
    const first = withGistPublicationLock("real-pg-fixture", "notes.md", async () => {
      entered.resolve();
      await finish.promise;
      return "first";
    });
    try {
      await entered.promise;
      expect(await withGistPublicationLock("real-pg-fixture", "notes.md", async () => "blocked")).toEqual({ acquired: false });
      expect(await withGistPublicationLock("real-pg-fixture", "other.md", async () => "independent")).toEqual({ acquired: true, value: "independent" });
    } finally {
      finish.resolve();
      await first;
    }
    expect(await withGistPublicationLock("real-pg-fixture", "notes.md", async () => "next")).toEqual({ acquired: true, value: "next" });
    await expect(withGistPublicationLock("real-pg-fixture", "notes.md", async () => {
      throw new Error("Synthetic callback failure");
    })).rejects.toThrow("Synthetic callback failure");
    expect(await withGistPublicationLock("real-pg-fixture", "notes.md", async () => "recovered")).toEqual({ acquired: true, value: "recovered" });
  });

  it("cancels an owned settings session and lets the next owner acquire it", async () => {
    await getDb();
    const controller = new AbortController();
    const entered = deferred<void>();
    const stopped = withGistSettingsLock("real-pg-settings", async signal => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }, controller.signal);
    const rejected = expect(stopped).rejects.toMatchObject({ name: "AbortError" });
    try {
      await entered.promise;
      expect(await withGistSettingsLock("real-pg-settings", async () => undefined)).toEqual({ acquired: false });
    } finally {
      controller.abort();
      await rejected;
    }
    expect(await withGistSettingsLock("real-pg-settings", async () => "released")).toEqual({ acquired: true, value: "released" });
  });
});

function stallAcquisition(stage: "connect" | "query") {
  const started = deferred<FakeClient>();
  const connect = deferred<void>();
  const query = deferred<LockQueryResult>();
  FakeClient.configure = (client) => {
    if (stage === "connect") {
      client.connect.mockImplementation(() => {
        client.sessionOpen = true;
        started.resolve(client);
        return connect.promise;
      });
    } else {
      client.query.mockImplementation(() => {
        started.resolve(client);
        return query.promise;
      });
    }
  };
  return {
    started: started.promise,
    complete: () => {
      connect.resolve();
      query.resolve({ rows: [{ locked: true }] });
    },
    fail: () => {
      if (stage === "connect") connect.reject(new Error(PRIVATE_DETAIL));
      else query.reject(new Error(PRIVATE_DETAIL));
    },
  };
}

describe("PostgreSQL gist publication lock", () => {
  it("bounds only the dedicated session, without changing the shared pool", async () => {
    expect(await withGistPublicationLock("gist", "file.md", async () => "sent"))
      .toEqual({ acquired: true, value: "sent" });
    expect(FakeClient.instances[0].options).toMatchObject({
      connectionTimeoutMillis: GIST_LOCK_CONNECT_TIMEOUT_MS,
      query_timeout: GIST_LOCK_QUERY_TIMEOUT_MS,
    });
    expect(FakePool.instances[0].options).not.toHaveProperty("connectionTimeoutMillis");
    expect(FakePool.instances[0].options).not.toHaveProperty("query_timeout");
    expect(FakePool.instances[0].end).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not publish when another database session owns the advisory lock", async () => {
    FakeClient.configure = (client) => client.query.mockResolvedValue({ rows: [{ locked: false }] });
    const send = vi.fn(async () => "sent");
    expect(await withGistPublicationLock("gist", "file.md", send)).toEqual({ acquired: false });
    expect(send).not.toHaveBeenCalled();
    const [client] = FakeClient.instances;
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.end).toHaveBeenCalledOnce();
    expect(client.sessionOpen).toBe(false);
    expect(client.connection.stream.destroy).not.toHaveBeenCalled();
  });

  it("holds a dedicated session until the entire publication has settled", async () => {
    const complete = deferred<void>();
    const entered = deferred<AbortSignal>();
    const sending = withGistPublicationLock("gist", "file.md", async (signal) => {
      entered.resolve(signal);
      await complete.promise;
      return "published";
    });
    const signal = await entered.promise;
    const [client] = FakeClient.instances;
    expect(signal.aborted).toBe(false);
    expect(client.sessionOpen).toBe(true);
    expect(client.end).not.toHaveBeenCalled();
    complete.resolve();
    expect(await sending).toEqual({ acquired: true, value: "published" });
    expect(client.sessionOpen).toBe(false);
    expect(client.end).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(false);
  });

  it("preserves callback failures and releases their session", async () => {
    const failure = new Error("Fixture callback failure");
    await expect(withGistPublicationLock("gist", "file.md", async () => {
      throw failure;
    })).rejects.toBe(failure);
    expect(FakeClient.instances[0].sessionOpen).toBe(false);
    expect(FakeClient.instances[0].end).toHaveBeenCalledOnce();
  });

  it.each(["connect", "query"] as const)("sanitizes %s failures and destroys the owned transport", async (stage) => {
    FakeClient.configure = (client) => {
      if (stage === "connect") client.connect.mockRejectedValue(new Error(PRIVATE_DETAIL));
      else client.query.mockRejectedValue(new Error(PRIVATE_DETAIL));
    };
    const send = vi.fn(async () => "sent");
    await expect(withGistPublicationLock("gist", "file.md", send))
      .rejects.toThrow(stage === "connect" ? CONNECTION_FAILED : ACQUISITION_FAILED);
    const [client] = FakeClient.instances;
    expect(client.sessionOpen).toBe(false);
    expect(client.connection.stream.destroy).toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["connect", "query"] as const)("bounds a stalled %s and rejects late success", async (stage) => {
    const gate = stallAcquisition(stage);
    const send = vi.fn(async () => "sent");
    const sending = withGistPublicationLock("gist", "file.md", send);
    const failed = expect(sending).rejects.toThrow(stage === "connect" ? CONNECTION_FAILED : ACQUISITION_FAILED);
    const client = await gate.started;
    const deadline = stage === "connect" ? GIST_LOCK_CONNECT_TIMEOUT_MS : GIST_LOCK_QUERY_TIMEOUT_MS;
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(client.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(client.end).toHaveBeenCalledOnce();
    expect(client.connection.stream.destroy).toHaveBeenCalled();
    expect(client.sessionOpen).toBe(false);
    gate.complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    if (stage === "connect") expect(client.query).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["connect", "query"] as const)("observes late %s rejection after timeout", async (stage) => {
    const gate = stallAcquisition(stage);
    const sending = withGistPublicationLock("gist", "file.md", async () => "sent");
    const failed = expect(sending).rejects.toThrow(stage === "connect" ? CONNECTION_FAILED : ACQUISITION_FAILED);
    await gate.started;
    await vi.advanceTimersByTimeAsync(stage === "connect" ? GIST_LOCK_CONNECT_TIMEOUT_MS : GIST_LOCK_QUERY_TIMEOUT_MS);
    await failed;
    gate.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not initialize a database for a pre-aborted call", async () => {
    const controller = new AbortController();
    controller.abort(new Error(PRIVATE_DETAIL));
    const send = vi.fn(async () => "sent");
    await expect(withGistPublicationLock("gist", "file.md", send, controller.signal))
      .rejects.toMatchObject({ name: "AbortError", message: CANCELED });
    expect(migrate).not.toHaveBeenCalled();
    expect(FakePool.instances).toHaveLength(0);
    expect(FakeClient.instances).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("cancels while shared initialization is pending without creating a late session", async () => {
    const entered = deferred<void>();
    const initialized = deferred<void>();
    migrate.mockImplementation(() => {
      entered.resolve();
      return initialized.promise;
    });
    const controller = new AbortController();
    const send = vi.fn(async () => "sent");
    const sending = withGistPublicationLock("gist", "file.md", send, controller.signal);
    const failed = expect(sending).rejects.toThrow(CANCELED);
    await entered.promise;
    controller.abort(new Error(PRIVATE_DETAIL));
    await failed;
    expect(FakeClient.instances).toHaveLength(0);
    initialized.resolve();
    await getDb();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeClient.instances).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(FakePool.instances[0].end).not.toHaveBeenCalled();
  });

  it.each(["connect", "query"] as const)("aborts during %s without waiting for its deadline", async (stage) => {
    const gate = stallAcquisition(stage);
    const controller = new AbortController();
    const send = vi.fn(async () => "sent");
    const sending = withGistPublicationLock("gist", "file.md", send, controller.signal);
    const failed = expect(sending).rejects.toMatchObject({ name: "AbortError", message: CANCELED });
    const client = await gate.started;
    controller.abort(new Error(PRIVATE_DETAIL));
    await failed;
    expect(client.connection.stream.destroy).toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledOnce();
    expect(client.sessionOpen).toBe(false);
    gate.complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    if (stage === "connect") expect(client.query).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { stage: "connect", close: "reject" },
    { stage: "connect", close: "stall" },
    { stage: "query", close: "reject" },
    { stage: "query", close: "stall" },
  ] as const)("reports cleanup failure within 1s after $stage abort when end() will $close", async ({ stage, close }) => {
    const gate = stallAcquisition(stage);
    const configureAcquisition = FakeClient.configure;
    const closed = deferred<void>();
    FakeClient.configure = (client) => {
      configureAcquisition(client);
      if (close === "reject") client.end.mockRejectedValue(new Error(PRIVATE_DETAIL));
      else client.end.mockReturnValue(closed.promise);
    };
    const controller = new AbortController();
    const send = vi.fn(async () => "sent");
    const sending = withGistPublicationLock("gist", "file.md", send, controller.signal);
    const failed = expect(sending).rejects.toMatchObject({ name: "Error", message: CLEANUP_FAILED });
    const client = await gate.started;
    controller.abort();
    await vi.advanceTimersByTimeAsync(GIST_LOCK_CLOSE_TIMEOUT_MS);
    await failed;
    await expect(sending).rejects.toBeInstanceOf(Error);
    await expect(sending).rejects.not.toBe(controller.signal.reason);
    expect(client.connection.stream.destroy).toHaveBeenCalled();
    expect(client.sessionOpen).toBe(false);
    gate.complete();
    closed.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not enter the callback when cancellation accompanies acquisition success", async () => {
    const controller = new AbortController();
    FakeClient.configure = (client) => client.query.mockImplementation(async () => {
      controller.abort(new Error(PRIVATE_DETAIL));
      return { rows: [{ locked: true }] };
    });
    const send = vi.fn(async () => "sent");
    await expect(withGistPublicationLock("gist", "file.md", send, controller.signal)).rejects.toThrow(CANCELED);
    expect(send).not.toHaveBeenCalled();
    expect(FakeClient.instances[0].sessionOpen).toBe(false);
  });

  it.each([false, true])("closes an in-flight session promptly but tracks its ignored callback (stalled close: %s)", async (stallClose) => {
    const entered = deferred<AbortSignal>();
    const response = deferred<void>();
    const closed = deferred<void>();
    if (stallClose) FakeClient.configure = (client) => client.end.mockReturnValue(closed.promise);
    const requestAborted = vi.fn();
    const afterAwait = vi.fn();
    const controller = new AbortController();
    const sending = withGistPublicationLock("gist", "file.md", async (signal) => {
      signal.addEventListener("abort", requestAborted, { once: true });
      entered.resolve(signal);
      await response.promise;
      signal.throwIfAborted();
      afterAwait();
      return "sent";
    }, controller.signal);
    let settled = false;
    void sending.then(() => { settled = true; }, () => { settled = true; });
    const failed = expect(sending).rejects.toMatchObject({
      name: stallClose ? "Error" : "AbortError",
      message: stallClose ? CLEANUP_FAILED : CANCELED,
    });
    const signal = await entered.promise;
    controller.abort(new Error(PRIVATE_DETAIL));
    expect(signal.aborted).toBe(true);
    expect(signal.reason.message).toBe(CANCELED);
    expect(signal.reason.name).toBe("AbortError");
    expect(requestAborted).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(GIST_LOCK_CLOSE_TIMEOUT_MS);
    expect(FakeClient.instances[0].sessionOpen).toBe(false);
    expect(FakeClient.instances[0].connection.stream.destroy).toHaveBeenCalled();
    expect(settled).toBe(false);
    closed.resolve();
    response.resolve();
    await failed;
    await vi.advanceTimersByTimeAsync(0);
    expect(afterAwait).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["error", "end"] as const)("aborts callbacks on unexpected session %s, without leaking details", async (event) => {
    const entered = deferred<AbortSignal>();
    const complete = deferred<void>();
    const sending = withGistPublicationLock("gist", "file.md", async (signal) => {
      entered.resolve(signal);
      await complete.promise;
      return "late success";
    });
    const failed = expect(sending).rejects.toThrow(INTERRUPTED);
    const signal = await entered.promise;
    const [client] = FakeClient.instances;
    client.emit(event, new Error(PRIVATE_DETAIL));
    expect(signal.aborted).toBe(true);
    expect(signal.reason.message).toBe(INTERRUPTED);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.sessionOpen).toBe(false);
    complete.resolve();
    await failed;
    await vi.advanceTimersByTimeAsync(0);
    expect(() => client.emit("error", new Error(PRIVATE_DETAIL))).not.toThrow();
  });

  it("destroys the current transport after a TLS-style stream replacement", async () => {
    const entered = deferred<void>();
    const complete = deferred<void>();
    const controller = new AbortController();
    const sending = withGistPublicationLock("gist", "file.md", async () => {
      entered.resolve();
      await complete.promise;
    }, controller.signal);
    const failed = expect(sending).rejects.toThrow(CANCELED);
    await entered.promise;
    const [client] = FakeClient.instances;
    const initial = client.connection.stream;
    const upgraded = new FakeTransport(() => { client.sessionOpen = false; });
    client.connection.stream = upgraded;
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(upgraded.destroy).toHaveBeenCalled();
    expect(initial.destroy).not.toHaveBeenCalled();
    complete.resolve();
    await failed;
    await vi.advanceTimersByTimeAsync(0);
  });

  it.each(["reject", "throw"] as const)("forces owned cleanup when end() fails by %s", async (failure) => {
    FakeClient.configure = (client) => {
      if (failure === "reject") client.end.mockRejectedValue(new Error(PRIVATE_DETAIL));
      else client.end.mockImplementation(() => { throw new Error(PRIVATE_DETAIL); });
    };
    await expect(withGistPublicationLock("gist", "file.md", async () => "sent")).rejects.toThrow(CLEANUP_FAILED);
    const [client] = FakeClient.instances;
    expect(client.connection.stream.destroy).toHaveBeenCalled();
    expect(client.sessionOpen).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds stalled cleanup, destroys the transport, and does not accept late end success", async () => {
    const ending = deferred<void>();
    const closed = deferred<void>();
    FakeClient.configure = (client) => client.end.mockImplementation(() => {
      ending.resolve();
      return closed.promise;
    });
    const sending = withGistPublicationLock("gist", "file.md", async () => "sent");
    const failed = expect(sending).rejects.toThrow(CLEANUP_FAILED);
    await ending.promise;
    const [client] = FakeClient.instances;
    await vi.advanceTimersByTimeAsync(GIST_LOCK_CLOSE_TIMEOUT_MS - 1);
    expect(client.connection.stream.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(client.connection.stream.destroy).toHaveBeenCalled();
    expect(client.sessionOpen).toBe(false);
    closed.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps acquisition timeout cleanup bounded even when end never returns", async () => {
    const gate = stallAcquisition("connect");
    const configureAcquisition = FakeClient.configure;
    const closed = deferred<void>();
    FakeClient.configure = (client) => {
      configureAcquisition(client);
      client.end.mockReturnValue(closed.promise);
    };
    const sending = withGistPublicationLock("gist", "file.md", async () => "sent");
    const failed = expect(sending).rejects.toMatchObject({ name: "Error", message: CLEANUP_FAILED });
    const client = await gate.started;
    await vi.advanceTimersByTimeAsync(GIST_LOCK_CONNECT_TIMEOUT_MS);
    expect(client.connection.stream.destroy).toHaveBeenCalled();
    expect(client.sessionOpen).toBe(false);
    await vi.advanceTimersByTimeAsync(GIST_LOCK_CLOSE_TIMEOUT_MS);
    await failed;
    gate.complete();
    closed.reject(new Error(PRIVATE_DETAIL));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.query).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forces cleanup immediately on abort during close and never returns success", async () => {
    const ending = deferred<void>();
    const closed = deferred<void>();
    FakeClient.configure = (client) => client.end.mockImplementation(() => {
      ending.resolve();
      return closed.promise;
    });
    const controller = new AbortController();
    const sending = withGistPublicationLock("gist", "file.md", async () => "sent", controller.signal);
    const failed = expect(sending).rejects.toMatchObject({ name: "Error", message: CLEANUP_FAILED });
    await ending.promise;
    controller.abort(new Error(PRIVATE_DETAIL));
    expect(FakeClient.instances[0].connection.stream.destroy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(GIST_LOCK_CLOSE_TIMEOUT_MS);
    await failed;
    closed.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("never destroys another owned session or the shared pool while cleaning up a failure", async () => {
    const entered = deferred<void>();
    const complete = deferred<void>();
    const first = withGistPublicationLock("first-gist", "file.md", async () => {
      entered.resolve();
      await complete.promise;
      return "first";
    });
    await entered.promise;
    FakeClient.configure = (client) => client.end.mockRejectedValue(new Error(PRIVATE_DETAIL));
    await expect(withGistPublicationLock("second-gist", "file.md", async () => "second")).rejects.toThrow(CLEANUP_FAILED);
    const [owner, failed] = FakeClient.instances;
    expect(owner.sessionOpen).toBe(true);
    expect(owner.end).not.toHaveBeenCalled();
    expect(owner.connection.stream.destroy).not.toHaveBeenCalled();
    expect(failed.connection.stream.destroy).toHaveBeenCalled();
    expect(FakePool.instances[0].end).not.toHaveBeenCalled();
    complete.resolve();
    expect(await first).toEqual({ acquired: true, value: "first" });
  });

  it("propagates cancellation through the settings-lock registry interface", async () => {
    const gate = stallAcquisition("query");
    const controller = new AbortController();
    const send = vi.fn(async () => "sent");
    const sending = withGistSettingsLock("doc", send, controller.signal);
    const failed = expect(sending).rejects.toThrow(CANCELED);
    const client = await gate.started;
    expect(client.query.mock.calls[0][1]).toEqual([JSON.stringify(["gist-settings", "doc"])]);
    controller.abort();
    await failed;
    gate.complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    expect(client.sessionOpen).toBe(false);
  });

  it("waits for nested coordination cleanup and preserves its failure after outer cancellation", async () => {
    const entered = deferred<void>();
    const complete = deferred<void>();
    FakeClient.configure = (client) => {
      if (FakeClient.instances.length === 2) client.end.mockRejectedValue(new Error(PRIVATE_DETAIL));
    };
    const controller = new AbortController();
    const sending = withGistPublicationLock("gist", "file.md", (signal) =>
      withGistSettingsLock("doc", async (settingsSignal) => {
        entered.resolve();
        await complete.promise;
        settingsSignal.throwIfAborted();
      }, signal), controller.signal);
    const failed = expect(sending).rejects.toMatchObject({ name: "Error", message: CLEANUP_FAILED });
    await entered.promise;
    controller.abort();
    await vi.advanceTimersByTimeAsync(GIST_LOCK_CLOSE_TIMEOUT_MS);
    expect(FakeClient.instances).toHaveLength(2);
    for (const client of FakeClient.instances) {
      expect(client.sessionOpen).toBe(false);
      expect(client.end).toHaveBeenCalledOnce();
      expect(client.connection.stream.destroy).toHaveBeenCalled();
    }
    complete.resolve();
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("PGlite process-local gist locks", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", undefined);
  });

  it("holds a busy key through callback completion, then releases it", async () => {
    const entered = deferred<void>();
    const complete = deferred<void>();
    const first = withGistPublicationLock("gist", "file.md", async (signal) => {
      expect(signal.aborted).toBe(false);
      entered.resolve();
      await complete.promise;
      return "first";
    });
    await entered.promise;
    const send = vi.fn(async () => "second");
    expect(await withGistPublicationLock("gist", "file.md", send)).toEqual({ acquired: false });
    expect(send).not.toHaveBeenCalled();
    complete.resolve();
    expect(await first).toEqual({ acquired: true, value: "first" });
    expect(await withGistPublicationLock("gist", "file.md", send)).toEqual({ acquired: true, value: "second" });
    expect(FakeClient.instances).toHaveLength(0);
  });

  it("releases the key after callback failure without changing the original error", async () => {
    const failure = new Error("Fixture callback failure");
    await expect(withGistSettingsLock("doc", async () => { throw failure; })).rejects.toBe(failure);
    expect(await withGistSettingsLock("doc", async () => "next")).toEqual({ acquired: true, value: "next" });
  });

  it("does not enter a callback when already canceled", async () => {
    const controller = new AbortController();
    controller.abort(new Error(PRIVATE_DETAIL));
    const send = vi.fn(async () => "sent");
    await expect(withGistSettingsLock("doc", send, controller.signal)).rejects.toThrow(CANCELED);
    expect(send).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });

  it("keeps a canceled key and call pending until an uncooperative callback settles", async () => {
    const entered = deferred<AbortSignal>();
    const complete = deferred<void>();
    const controller = new AbortController();
    let settled = false;
    const first = withGistSettingsLock("doc", async (signal) => {
      entered.resolve(signal);
      await complete.promise;
      return "late success";
    }, controller.signal);
    void first.then(() => { settled = true; }, () => { settled = true; });
    const failed = expect(first).rejects.toThrow(CANCELED);
    const signal = await entered.promise;
    controller.abort(new Error(PRIVATE_DETAIL));
    expect(signal.aborted).toBe(true);
    expect(signal.reason.message).toBe(CANCELED);
    await vi.advanceTimersByTimeAsync(GIST_LOCK_CLOSE_TIMEOUT_MS);
    expect(settled).toBe(false);
    const replacement = vi.fn(async () => "next");
    expect(await withGistSettingsLock("doc", replacement)).toEqual({ acquired: false });
    expect(replacement).not.toHaveBeenCalled();
    complete.resolve();
    await failed;
    expect(settled).toBe(true);
    expect(await withGistSettingsLock("doc", replacement)).toEqual({ acquired: true, value: "next" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a callback failure after cancellation instead of masking failed cleanup", async () => {
    const entered = deferred<void>();
    const complete = deferred<void>();
    const controller = new AbortController();
    const first = withGistPublicationLock("gist", "file.md", async () => {
      entered.resolve();
      await complete.promise;
    }, controller.signal);
    const failure = new Error("Fixture callback cleanup failure");
    const failed = expect(first).rejects.toBe(failure);
    await entered.promise;
    controller.abort(new Error(PRIVATE_DETAIL));
    complete.reject(failure);
    await failed;
    expect(await withGistPublicationLock("gist", "file.md", async () => "next"))
      .toEqual({ acquired: true, value: "next" });
  });
});
