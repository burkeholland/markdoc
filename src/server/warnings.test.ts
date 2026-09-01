import { describe, expect, it, vi } from "vitest";
import { warnTail, type WarningCode } from "./warnings";

/** Runs `fn` with console.error silenced; returns its result and every line logged. */
const quietly = async <T>(fn: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await fn();
    return { result, logged: errors.mock.calls };
  } finally {
    errors.mockRestore();
  }
};

const boom = (message: string) => async () => {
  throw new Error(message);
};

describe("warnTail", () => {
  it("answers the body untouched — no `warnings` key at all — when every tail succeeded", async () => {
    const { tail, failed, answer } = warnTail("assets");
    const { logged } = await quietly(async () => {
      expect(await tail("activity-not-recorded", async () => 42)).toBe(true);
      expect(await tail("notification-not-sent", async () => undefined)).toBe(true);
    });
    expect(logged).toEqual([]);
    expect(failed.size).toBe(0);
    const body = { ok: true, id: "a1" };
    const answered = answer(body);
    expect(answered).toBe(body);
    expect("warnings" in answered).toBe(false);
    expect(JSON.stringify(answered)).toBe('{"ok":true,"id":"a1"}');
  });

  it("logs exactly `[scope] code` with the error, records the code and answers false; the throw never propagates", async () => {
    const { tail, failed, answer } = warnTail("comments");
    const { result, logged } = await quietly(() => tail("mentions-not-recorded", boom("mentions table is away")));
    expect(result).toBe(false);
    expect(logged).toEqual([["[comments] mentions-not-recorded", expect.any(Error)]]);
    expect((logged[0][1] as Error).message).toBe("mentions table is away");
    expect([...failed]).toEqual(["mentions-not-recorded"]);
    expect(answer({ id: "t1" })).toEqual({ id: "t1", warnings: ["mentions-not-recorded"] });
  });

  it("catches a synchronous throw inside `fn` too", async () => {
    const { tail, failed } = warnTail("suggest");
    const { result } = await quietly(() =>
      tail("request-not-attached", () => {
        throw new Error("sync");
      }),
    );
    expect(result).toBe(false);
    expect([...failed]).toEqual(["request-not-attached"]);
  });

  it("keeps the codes in first-failure order, each once, however many times a code fails", async () => {
    const { tail, failed, answer } = warnTail("suggestions");
    const { logged } = await quietly(async () => {
      await tail("activity-not-recorded", boom("a"));
      // A per-author loop: three authors fail, the code is reported once but every failure is logged.
      for (const who of ["fay", "gus", "ida"]) await tail("notification-not-sent", boom(who));
      await tail("version-not-saved", async () => "fine");
      await tail("activity-not-recorded", boom("again"));
    });
    expect(logged).toEqual([
      ["[suggestions] activity-not-recorded", expect.any(Error)],
      ["[suggestions] notification-not-sent", expect.any(Error)],
      ["[suggestions] notification-not-sent", expect.any(Error)],
      ["[suggestions] notification-not-sent", expect.any(Error)],
      ["[suggestions] activity-not-recorded", expect.any(Error)],
    ]);
    expect([...failed]).toEqual(["activity-not-recorded", "notification-not-sent"]);
    expect(answer({ ok: true, decided: 3 })).toEqual({ ok: true, decided: 3, warnings: ["activity-not-recorded", "notification-not-sent"] });
  });

  it("`failed` is a live view and `answer` a fresh copy each time, so a later failure shows up in the next answer only", async () => {
    const { tail, failed, answer } = warnTail("versions");
    const first = answer({ ok: true });
    await quietly(() => tail("activity-not-recorded", boom("x")));
    expect(first).toEqual({ ok: true });
    expect(failed.has("activity-not-recorded")).toBe(true);
    const second = answer({ ok: true });
    expect(second.warnings).toEqual(["activity-not-recorded"]);
    await quietly(() => tail("version-not-saved", boom("y")));
    // The array handed out earlier is not mutated behind the caller's back.
    expect(second.warnings).toEqual(["activity-not-recorded"]);
    expect(answer({}).warnings).toEqual(["activity-not-recorded", "version-not-saved"]);
  });

  it("carries codes an earlier step reported on the same write, in front of its own", async () => {
    const carried: WarningCode[] = ["version-not-saved"];
    const { tail, answer } = warnTail("publish", carried);
    expect(answer({ result: 1 })).toEqual({ result: 1, warnings: ["version-not-saved"] });
    const { logged } = await quietly(() => tail("activity-not-recorded", boom("feed is away")));
    expect(logged).toEqual([["[publish] activity-not-recorded", expect.any(Error)]]);
    expect(answer({ result: 1 })).toEqual({ result: 1, warnings: ["version-not-saved", "activity-not-recorded"] });
    // A carried code failing again stays one entry; an empty carry adds nothing.
    await quietly(() => tail("version-not-saved", boom("again")));
    expect(answer({}).warnings).toEqual(["version-not-saved", "activity-not-recorded"]);
    expect(warnTail("pull", []).answer({ changed: false })).toEqual({ changed: false });
  });

  it("does not run the tail's result through anything: a resolved value is discarded, only success matters", async () => {
    const { tail, failed } = warnTail("link");
    const fn = vi.fn(async () => ({ id: "v1" }));
    expect(await tail("version-not-saved", fn)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(failed.size).toBe(0);
  });
});
