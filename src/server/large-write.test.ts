import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const {
  LARGE_WRITE_MAX_PER_CALLER,
  LARGE_WRITE_MAX_RUNNING,
  LARGE_WRITE_MAX_WAITING,
  LARGE_WRITE_QUEUE_WAIT_MS,
  LARGE_WRITE_RETRY_AFTER_SECONDS,
  LARGE_WRITE_SIZE,
  LargeWriteBusyError,
  LargeWriteCancelledError,
  LargeWrites,
  WriteTurn,
  declaredSize,
} = await import("./large-write");
const { HttpError, handler, json } = await import("./http");

/** Let promise callbacks run; no timer is involved. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const rejection = async (p: Promise<unknown>) => p.then(() => null, (err: unknown) => err);
/** Let every write have its turn and end, in whatever order the queue hands the turn out. */
const finishAll = (turns: (Promise<{ release: () => Promise<void> }> | { release: () => Promise<void> })[]) => Promise.all(turns.map(async (turn) => (await turn).release()));

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
});

/** A queue whose step aside is counted and takes no time. */
function writes(options: ConstructorParameters<typeof LargeWrites>[0] = {}) {
  const asides: number[] = [];
  const w = new LargeWrites({ stepAside: async () => void asides.push(asides.length), ...options });
  return { w, asides };
}

describe("large writes: the numbers (#2341)", () => {
  it("are what the documentation says", () => {
    expect(LARGE_WRITE_SIZE).toBe(200_000);
    expect(LARGE_WRITE_MAX_RUNNING).toBe(1);
    expect(LARGE_WRITE_MAX_WAITING).toBe(8);
    expect(LARGE_WRITE_MAX_PER_CALLER).toBe(2);
    expect(LARGE_WRITE_QUEUE_WAIT_MS).toBe(30_000);
    expect(LARGE_WRITE_RETRY_AFTER_SECONDS).toBe(5);
  });
});

describe("large writes: one at a time", () => {
  it("the second waits until the first is released, and the server steps aside in between", async () => {
    const { w, asides } = writes();
    const order: string[] = [];
    const first = await w.enter("ana");
    const second = w.enter("ben").then((turn) => {
      order.push("ben runs");
      return turn;
    });
    await settle();
    expect(order).toEqual([]);
    expect(w.runningCount).toBe(1);
    expect(w.waitingCount).toBe(1);
    order.push("ana done");
    await first.release();
    await settle();
    expect(order).toEqual(["ana done", "ben runs"]);
    // The step aside came before the turn was handed on.
    expect(asides).toEqual([0]);
    await (await second).release();
    expect(asides).toEqual([0, 1]);
    expect(w.runningCount).toBe(0);
  });

  it("the turn is not handed on before the step aside has ended", async () => {
    let endAside!: () => void;
    const w = new LargeWrites({ stepAside: () => new Promise<void>((resolve) => (endAside = resolve)) });
    const first = await w.enter("ana");
    let benRuns = false;
    const second = w.enter("ben").then((turn) => {
      benRuns = true;
      return turn;
    });
    const releasing = first.release();
    await settle();
    expect(benRuns).toBe(false);
    endAside();
    await releasing;
    await settle();
    expect(benRuns).toBe(true);
    void second;
  });

  it("release twice hands the turn on once", async () => {
    const { w, asides } = writes();
    const first = await w.enter("ana");
    const second = w.enter("ben");
    const third = w.enter("cy");
    await first.release();
    await first.release();
    await settle();
    expect(asides.length).toBe(1);
    expect(w.runningCount).toBe(1);
    expect(w.waitingCount).toBe(1);
    await (await second).release();
    await (await third).release();
  });
});

describe("large writes: a bound per caller", () => {
  it("one caller holds two places, running and waiting together; the third is refused at once with 503 and Retry-After", async () => {
    const { w } = writes();
    const running = await w.enter("ana");
    const waiting = w.enter("ana");
    await settle();
    expect(w.placesOf("ana")).toBe(2);
    const err = await rejection(w.enter("ana"));
    expect(err).toBeInstanceOf(LargeWriteBusyError);
    const busy = err as InstanceType<typeof LargeWriteBusyError>;
    expect(busy.reason).toBe("caller-full");
    expect(busy.status).toBe(503);
    expect(busy.headers).toEqual({ "Retry-After": "5" });
    expect(busy.details).toEqual({ retryAfter: 5 });
    expect(busy.message).toBe("You already have 2 document writes in progress. Wait for one to finish, then try again");
    // The refusal took no place and nobody else's turn.
    expect(w.placesOf("ana")).toBe(2);
    expect(w.waitingCount).toBe(1);
    await running.release();
    await (await waiting).release();
    expect(w.placesOf("ana")).toBe(0);
  });

  it("a place is free again as soon as a write ends: the same caller may then send another", async () => {
    const { w } = writes();
    const a = await w.enter("ana");
    const b = w.enter("ana");
    await a.release();
    const c = w.enter("ana");
    await settle();
    expect(w.placesOf("ana")).toBe(2);
    await (await b).release();
    await (await c).release();
  });

  it("20 at once from one caller: 2 are done, 18 are refused, and another caller is not kept out", async () => {
    const { w } = writes();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        w.enter("ana").then(
          async (turn) => {
            await turn.release();
            return "done";
          },
          (err: unknown) => (err instanceof LargeWriteBusyError ? err.reason : "other"),
        ),
      ).concat([
        w.enter("ben").then(async (turn) => {
          await turn.release();
          return "ben done";
        }),
      ]),
    );
    expect(results.filter((r) => r === "done").length).toBe(2);
    expect(results.filter((r) => r === "caller-full").length).toBe(18);
    expect(results[20]).toBe("ben done");
    expect(w.runningCount).toBe(0);
    expect(w.waitingCount).toBe(0);
  });

  it("the bound is per user: other users are not counted with this one", async () => {
    const { w } = writes();
    const turns = [await w.enter("ana"), w.enter("ana"), w.enter("ben"), w.enter("ben"), w.enter("cy")];
    await settle();
    expect(w.waitingCount).toBe(4);
    expect(await rejection(w.enter("ben"))).toBeInstanceOf(LargeWriteBusyError);
    await finishAll(turns);
  });
});

describe("large writes: the queue is bounded for everybody together", () => {
  it("1 runs and 8 wait; the caller that asks then and already holds a place is refused: the server is busy", async () => {
    const { w } = writes();
    const turns: Promise<{ release: () => Promise<void> }>[] = [];
    // 9 callers: the first runs, 8 wait.
    for (const name of ["u0", "u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8"]) turns.push(w.enter(name));
    await settle();
    expect(w.runningCount).toBe(1);
    expect(w.waitingCount).toBe(8);
    // u1 holds one place, as everybody does: nobody holds two more than u1, so nobody gives one up.
    const err = (await rejection(w.enter("u1"))) as InstanceType<typeof LargeWriteBusyError>;
    expect(err).toBeInstanceOf(LargeWriteBusyError);
    expect(err.reason).toBe("queue-full");
    expect(err.status).toBe(503);
    expect(err.message).toBe("The server is busy with document writes. Try again in a few seconds");
    expect(err.headers).toEqual({ "Retry-After": "5" });
    expect(w.placesOf("u1")).toBe(1);
    await finishAll(turns);
  });

  it("a caller with no place takes the newest place of a caller that holds two; that write gets the busy answer", async () => {
    const { w } = writes();
    const turns: Promise<{ release: () => Promise<void> }>[] = [w.enter("u0")];
    // 8 waiting places: ana holds two of them, six others one each.
    const anaFirst = w.enter("ana");
    for (const name of ["u1", "u2", "u3", "u4", "u5", "u6"]) turns.push(w.enter(name));
    const anaSecond = w.enter("ana");
    await settle();
    expect(w.waitingCount).toBe(8);
    const newcomer = w.enter("zoe");
    const lost = (await rejection(anaSecond)) as InstanceType<typeof LargeWriteBusyError>;
    expect(lost).toBeInstanceOf(LargeWriteBusyError);
    expect(lost.reason).toBe("place-given");
    expect(lost.status).toBe(503);
    expect(w.placesOf("ana")).toBe(1);
    expect(w.placesOf("zoe")).toBe(1);
    expect(w.waitingCount).toBe(8);
    await finishAll([...turns, anaFirst, newcomer]);
  });

  it("a write that has waited 30 s is refused; the ones behind it stay", async () => {
    vi.useFakeTimers();
    const { w } = writes();
    const first = await w.enter("ana");
    const second = w.enter("ben");
    const outcome = rejection(second);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(w.waitingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const err = (await outcome) as InstanceType<typeof LargeWriteBusyError>;
    expect(err).toBeInstanceOf(LargeWriteBusyError);
    expect(err.reason).toBe("queue-wait");
    expect(w.placesOf("ben")).toBe(0);
    await first.release();
  });

  it("says why a write was refused in one line, and nothing about the caller", async () => {
    const { w } = writes();
    const a = await w.enter("user-id-12345");
    const b = w.enter("user-id-12345");
    await rejection(w.enter("user-id-12345"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("[large-write] refused: caller-full, 1 waiting");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("user-id-12345");
    await a.release();
    await (await b).release();
  });
});

describe("large writes: a caller that goes away", () => {
  it("while it waits: it leaves the queue, holds no place and is never given the turn", async () => {
    const { w } = writes();
    const first = await w.enter("ana");
    const gone = new AbortController();
    const second = w.enter("ben", gone.signal);
    const third = w.enter("cy");
    await settle();
    gone.abort();
    expect(await rejection(second)).toBeInstanceOf(LargeWriteCancelledError);
    expect(w.placesOf("ben")).toBe(0);
    expect(w.waitingCount).toBe(1);
    await first.release();
    // The turn went to the next one, not to the caller that left.
    await (await third).release();
    expect(w.runningCount).toBe(0);
  });

  it("before it asked: refused with 499, no place taken", async () => {
    const { w } = writes();
    const gone = new AbortController();
    gone.abort();
    const err = (await rejection(w.enter("ana", gone.signal))) as InstanceType<typeof LargeWriteCancelledError>;
    expect(err).toBeInstanceOf(LargeWriteCancelledError);
    expect(err.status).toBe(499);
    expect(w.placesOf("ana")).toBe(0);
    expect(w.runningCount).toBe(0);
  });
});

describe("WriteTurn: one request's place", () => {
  const request = (headers: Record<string, string> = {}, signal?: AbortSignal) => new Request("http://markdoc.test/api/documents/d/content", { method: "PUT", headers, signal });

  it("declaredSize reads Content-Length, and is 0 when the request does not say", () => {
    expect(declaredSize(request({ "Content-Length": "6000014" }))).toBe(6_000_014);
    expect(declaredSize(request())).toBe(0);
    expect(declaredSize(request({ "Content-Length": "many" }))).toBe(0);
    expect(declaredSize(request({ "Content-Length": "-5" }))).toBe(0);
  });

  it("a body of 200,000 bytes is large and takes the turn before it is read; one byte less does not", async () => {
    const { w } = writes();
    const small = await WriteTurn.begin(request({ "Content-Length": "199999" }), "ana", w);
    expect(small.large).toBe(false);
    expect(w.runningCount).toBe(0);
    const large = await WriteTurn.begin(request({ "Content-Length": "200000" }), "ana", w);
    expect(large.large).toBe(true);
    expect(w.runningCount).toBe(1);
    await large.end();
    await small.end();
    expect(w.runningCount).toBe(0);
  });

  it("a small write is never counted, queued or refused, however many run", async () => {
    const { w, asides } = writes();
    const held = [await w.enter("ana"), w.enter("ana")];
    const small = await Promise.all(Array.from({ length: 50 }, () => WriteTurn.begin(request({ "Content-Length": "5000" }), "ana", w)));
    for (const turn of small) {
      await turn.sized(199_999);
      turn.assertWanted();
      expect(turn.large).toBe(false);
      await turn.end();
    }
    expect(asides).toEqual([]);
    expect(w.placesOf("ana")).toBe(2);
    await finishAll(held);
  });

  it("a text that turns out large takes the turn when its size is known, once", async () => {
    const { w } = writes();
    const turn = await WriteTurn.begin(request(), "ana", w);
    expect(turn.large).toBe(false);
    await turn.sized(200_000);
    expect(turn.large).toBe(true);
    await turn.sized(2_000_000);
    expect(w.placesOf("ana")).toBe(1);
    await turn.end();
    await turn.end();
    expect(w.placesOf("ana")).toBe(0);
    expect(w.runningCount).toBe(0);
  });

  it("force takes one turn regardless of size and is idempotent", async () => {
    const { w } = writes();
    const turn = await WriteTurn.begin(request({ "Content-Length": "100" }), "ana", w);
    expect(turn.large).toBe(false);
    await turn.force();
    await turn.force();
    expect(turn.large).toBe(true);
    expect(w.placesOf("ana")).toBe(1);
    await turn.end();
    expect(w.placesOf("ana")).toBe(0);
  });

  it("the third large request of one user is refused before its body is read", async () => {
    const { w } = writes();
    const a = await WriteTurn.begin(request({ "Content-Length": "6000014" }), "ana", w);
    const b = WriteTurn.begin(request({ "Content-Length": "6000014" }), "ana", w);
    await settle();
    expect(await rejection(WriteTurn.begin(request({ "Content-Length": "6000014" }), "ana", w))).toBeInstanceOf(LargeWriteBusyError);
    await a.end();
    await (await b).end();
  });

  it("a large write whose caller left is stopped before the document is changed; a small one is not asked", async () => {
    const { w } = writes();
    const gone = new AbortController();
    const large = await WriteTurn.begin(request({ "Content-Length": "300000" }, gone.signal), "ana", w);
    const small = await WriteTurn.begin(request({ "Content-Length": "300" }, gone.signal), "ana", w);
    large.assertWanted();
    gone.abort();
    expect(() => large.assertWanted()).toThrow(LargeWriteCancelledError);
    expect(() => small.assertWanted()).not.toThrow();
    await large.end();
    expect(w.runningCount).toBe(0);
  });

  it("through handler(): the refusal is 503 JSON { error, retryAfter } with a Retry-After header", async () => {
    const { w } = writes();
    const a = await w.enter("ana");
    const b = w.enter("ana");
    const route = handler(async (req: Request) => {
      const turn = await WriteTurn.begin(req, "ana", w);
      await turn.end();
      return json({ ok: true });
    });
    const res = await route(request({ "Content-Length": "250000", Authorization: "Bearer mdk_test" }));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(await res.json()).toEqual({ error: "You already have 2 document writes in progress. Wait for one to finish, then try again", retryAfter: 5 });
    await a.release();
    await (await b).release();
    expect(new LargeWriteBusyError("queue-full")).toBeInstanceOf(HttpError);
  });
});
