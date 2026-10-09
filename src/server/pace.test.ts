import { describe, expect, it } from "vitest";
import { MAX_UNBROKEN_WORK_MS, Pace, STEP_ASIDE_MS, stepAside, type PaceClock } from "./pace";

/**
 * Nothing here depends on how fast the machine is: the clock is a number the steps move (a step "takes
 * 60 ms" by adding 60 to it), and a wait is recorded and ends in the next turn of the event loop.
 */
function clock() {
  const state = { now: 0, waits: [] as number[] };
  const pace: PaceClock = {
    now: () => state.now,
    wait: (ms) => {
      state.waits.push(ms);
      return new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
  return { state, pace };
}
/** A step that keeps this thread for `ms`, as the embedded database does: the clock moves, the event loop does not turn. */
const blocks = (state: { now: number }, ms: number) => async () => {
  state.now += ms;
};
/** A step that is answered in a later turn of the event loop, as a database on a socket answers. */
const overSocket = (state: { now: number }, ms: number) => async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  state.now += ms;
};

describe("Pace: other requests get a turn between the steps of long work (#2341)", () => {
  it("the numbers: 50 ms of unbroken work, then a wait of 25 ms", () => {
    expect(MAX_UNBROKEN_WORK_MS).toBe(50);
    expect(STEP_ASIDE_MS).toBe(25);
  });

  it("a step that blocked for the limit is followed by one wait of 25 ms", async () => {
    const { state, pace } = clock();
    const p = new Pace(pace);
    await p.step(blocks(state, 50));
    expect(state.waits).toEqual([25]);
    expect(p.waits).toBe(1);
  });

  it("one millisecond less is not", async () => {
    const { state, pace } = clock();
    const p = new Pace(pace);
    await p.step(blocks(state, 49));
    expect(state.waits).toEqual([]);
  });

  it("short blocking steps add up, and share one wait", async () => {
    const { state, pace } = clock();
    const p = new Pace(pace);
    for (let i = 0; i < 4; i++) await p.step(blocks(state, 12));
    expect(state.waits).toEqual([]);
    await p.step(blocks(state, 2));
    expect(state.waits).toEqual([25]);
    // The count starts again after a wait.
    await p.step(blocks(state, 49));
    expect(state.waits).toEqual([25]);
    await p.step(blocks(state, 1));
    expect(state.waits).toEqual([25, 25]);
  });

  it("three steps that each block for long get a wait after each: a request that came in is answered between them", async () => {
    const { state, pace } = clock();
    const p = new Pace(pace);
    const order: string[] = [];
    // A request needs a turn of the event loop to be answered.
    const request = (name: string) => setImmediate(() => order.push(`${name} answered`));
    for (const name of ["load", "store", "version"]) {
      await p.step(async () => {
        state.now += 900;
        order.push(name);
        request(`request during ${name}`);
      });
    }
    expect(order).toEqual(["load", "request during load answered", "store", "request during store answered", "version", "request during version answered"]);
    expect(state.waits).toEqual([25, 25, 25]);
  });

  it("without the pace the same three steps run back to back and the requests wait for all of them", async () => {
    const order: string[] = [];
    const request = (name: string) => setImmediate(() => order.push(`${name} answered`));
    for (const name of ["load", "store", "version"]) {
      await (async () => {
        order.push(name);
        request(`request during ${name}`);
      })();
    }
    expect(order).toEqual(["load", "store", "version"]);
  });

  it("a step that let the event loop turn by itself is never followed by a wait, however long it took", async () => {
    const { state, pace } = clock();
    const p = new Pace(pace);
    for (let i = 0; i < 5; i++) await p.step(overSocket(state, 700));
    expect(state.waits).toEqual([]);
    expect(p.waits).toBe(0);
  });

  it("returns what the step returned, and a step that fails still fails, after its wait", async () => {
    const { state, pace } = clock();
    const p = new Pace(pace);
    expect(await p.step(async () => 42)).toBe(42);
    expect(await p.step(() => "not a promise")).toBe("not a promise");
    await expect(
      p.step(async () => {
        state.now += 80;
        throw new Error("the database said no");
      }),
    ).rejects.toThrow("the database said no");
    expect(state.waits).toEqual([25]);
  });

  it("stepAside waits 25 ms on the real clock", async () => {
    const started = performance.now();
    await stepAside();
    expect(performance.now() - started).toBeGreaterThanOrEqual(20);
  });
});
