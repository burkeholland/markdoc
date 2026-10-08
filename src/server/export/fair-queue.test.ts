import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FairQueue, QueueCancelled, QueueRefusal, type Turn } from "./fair-queue";

/**
 * Who waits for the PDF renderer and who goes next (#2290), without any renderer: requests enter under a
 * caller's name, hold a turn for some time and release it. Time is the fake clock, so "used the renderer
 * for 12 s" is exact.
 */

const MAX_WAITING = 8;
const MAX_WAIT_MS = 30_000;
const HALF_LIFE_MS = 60_000;

interface Request {
  caller: string;
  /** "waiting" until it has an answer: "turn", a refusal's reason, or "cancelled". */
  state: string;
  turn?: Turn;
  abort: AbortController;
}

/** Let promise reactions run without moving the clock. */
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

const newQueue = (options: { maxAccounts?: number } = {}) => new FairQueue({ maxRunning: 1, maxWaiting: MAX_WAITING, maxWaitMs: MAX_WAIT_MS, halfLifeMs: HALF_LIFE_MS, now: () => Date.now(), ...options });

describe("sharing the PDF renderer between callers (#2290)", () => {
  let queue: FairQueue;

  const ask = (caller: string): Request => {
    const request: Request = { caller, state: "waiting", abort: new AbortController() };
    queue.enter(caller, request.abort.signal).then(
      (turn) => {
        request.state = "turn";
        request.turn = turn;
      },
      (error: unknown) => {
        request.state = error instanceof QueueRefusal ? error.reason : error instanceof QueueCancelled ? "cancelled" : `other: ${String(error)}`;
      },
    );
    return request;
  };
  const states = (requests: Request[]) => requests.map((request) => request.state);

  /** `caller` asks, gets the free renderer, holds it for `ms` and hands it back. */
  const use = async (caller: string, ms: number) => {
    const request = ask(caller);
    await flush();
    expect(request.state).toBe("turn");
    await vi.advanceTimersByTimeAsync(ms);
    request.turn!.release();
    await flush();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    queue = newQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("places", () => {
    it("lets one caller alone fill the queue and refuses its next request at once", async () => {
      const running = ask("a");
      const waiting = Array.from({ length: MAX_WAITING }, () => ask("a"));
      const extra = ask("a");
      await flush();

      expect(running.state).toBe("turn");
      expect(states(waiting)).toEqual(Array(MAX_WAITING).fill("waiting"));
      expect(extra.state, "a caller never takes a place from itself").toBe("queue-full");
      expect(queue.waitingCount).toBe(MAX_WAITING);
    });

    it("gives a newcomer the newest place of the caller that holds the most, until both hold the same", async () => {
      ask("a");
      const a = Array.from({ length: MAX_WAITING }, () => ask("a"));
      await flush();

      const b = [ask("b"), ask("b"), ask("b"), ask("b")];
      await flush();

      expect(states(b)).toEqual(["waiting", "waiting", "waiting", "waiting"]);
      // The newest four of a's requests made room, newest first; the oldest four still wait.
      expect(states(a)).toEqual(["waiting", "waiting", "waiting", "waiting", "place-given", "place-given", "place-given", "place-given"]);
      expect(queue.waitingCount).toBe(MAX_WAITING);

      const fifth = ask("b");
      const again = ask("a");
      await flush();
      expect(fifth.state, "four against four: nobody holds two more than the asker").toBe("queue-full");
      expect(again.state).toBe("queue-full");
      expect(states(a.slice(0, 4))).toEqual(["waiting", "waiting", "waiting", "waiting"]);
    });

    it("takes a place only from a caller that holds at least two more than the asker", async () => {
      ask("a");
      const a = Array.from({ length: 5 }, () => ask("a"));
      const b = Array.from({ length: 3 }, () => ask("b"));
      await flush();
      // a 5, b 3: b's next request leaves both at four.
      const fourth = ask("b");
      await flush();
      expect(fourth.state).toBe("waiting");
      expect(a.at(-1)!.state).toBe("place-given");

      // a 4, b 4: neither gets another place from the other.
      const more = [ask("a"), ask("b")];
      await flush();
      expect(states(more)).toEqual(["queue-full", "queue-full"]);

      // A third caller with none takes one, from the caller among the biggest whose newest request is newest.
      const c = ask("c");
      await flush();
      expect(c.state).toBe("waiting");
      expect(fourth.state).toBe("place-given");
      expect(states([...a.slice(0, 4), ...b])).toEqual(Array(7).fill("waiting"));
    });

    it("never makes a caller give up its only place", async () => {
      ask("running");
      const eight = Array.from({ length: MAX_WAITING }, (_, n) => ask(`caller-${n}`));
      await flush();

      const newcomers = [ask("new-1"), ask("new-2"), ask("caller-0")];
      await flush();

      expect(states(newcomers)).toEqual(["queue-full", "queue-full", "queue-full"]);
      expect(states(eight), "each of the eight still has its one place").toEqual(Array(MAX_WAITING).fill("waiting"));

      // Two places: one may go, the last one stays.
      queue = newQueue();
      ask("running");
      const pair = [ask("a"), ask("a")];
      const six = Array.from({ length: 6 }, (_, n) => ask(`caller-${n}`));
      await flush();
      const takers = [ask("new-1"), ask("new-2")];
      await flush();
      expect(states(takers)).toEqual(["waiting", "queue-full"]);
      expect(states(pair)).toEqual(["waiting", "place-given"]);
      expect(states(six)).toEqual(Array(6).fill("waiting"));
    });

    it("never takes away a turn that is held", async () => {
      // One caller holds the renderer and every place.
      const running = ask("a");
      const waiting = Array.from({ length: MAX_WAITING }, () => ask("a"));
      await flush();

      const others = Array.from({ length: 12 }, (_, n) => ask(`caller-${n}`));
      await flush();

      expect(running.state, "the request that renders is not among those that make room").toBe("turn");
      expect(queue.runningCount).toBe(1);
      // Seven of a's eight waiting requests made room; the eighth is a's only place and stays.
      expect(states(waiting).filter((state) => state === "place-given")).toHaveLength(7);
      expect(waiting[0].state).toBe("waiting");
      expect(states(others).filter((state) => state === "waiting")).toHaveLength(7);
      expect(states(others).filter((state) => state === "queue-full")).toHaveLength(5);

      // The turn is still the running request's to hand back, and it goes on to a waiting caller.
      running.turn!.release();
      await flush();
      expect(queue.runningCount).toBe(1);
      expect(queue.waitingCount).toBe(MAX_WAITING - 1);
    });

    it("counts everybody without a session as one caller", async () => {
      ask("user:u");
      // Eight requests by eight different people without a session.
      const visitors = Array.from({ length: MAX_WAITING }, () => ask("anonymous"));
      await flush();

      const mine = [ask("user:u"), ask("user:u"), ask("user:u"), ask("user:u"), ask("user:u")];
      await flush();

      expect(states(mine), "a signed-in user gets half of a full queue").toEqual(["waiting", "waiting", "waiting", "waiting", "queue-full"]);
      expect(states(visitors)).toEqual(["waiting", "waiting", "waiting", "waiting", "place-given", "place-given", "place-given", "place-given"]);
    });
  });

  describe("turns", () => {
    it("serves one caller's requests in the order they came", async () => {
      const requests = [ask("a"), ask("a"), ask("a"), ask("a")];
      await flush();
      const served: number[] = [];
      for (let i = 0; i < requests.length; i++) {
        const at = requests.findIndex((request, n) => request.state === "turn" && !served.includes(n));
        served.push(at);
        requests[at].turn!.release();
        await flush();
      }
      expect(served).toEqual([0, 1, 2, 3]);
    });

    it("gives the free renderer to the caller that has used it least, not to the one that asked first", async () => {
      await use("heavy", 12_000);
      const running = ask("heavy");
      const heavy = [ask("heavy"), ask("heavy")];
      const small = [ask("small"), ask("small")];
      await flush();
      await vi.advanceTimersByTimeAsync(12_000);

      running.turn!.release();
      await flush();
      expect([states(heavy), states(small)]).toEqual([["waiting", "waiting"], ["turn", "waiting"]]);

      await vi.advanceTimersByTimeAsync(200);
      small[0].turn!.release();
      await flush();
      expect(small[1].state, "still far behind the heavy caller: its second request goes next too").toBe("turn");

      small[1].turn!.release();
      await flush();
      expect(states(heavy)).toEqual(["turn", "waiting"]);
    });

    it("goes by the oldest waiting request between callers that have used the renderer equally", async () => {
      const running = ask("x");
      const b = ask("b");
      const a = ask("a");
      const b2 = ask("b");
      await flush();

      running.turn!.release();
      await flush();
      expect(states([b, a, b2])).toEqual(["turn", "waiting", "waiting"]);
      // b held the renderer for no time at all: still equal, so a's request, older than b's second, is next.
      b.turn!.release();
      await flush();
      expect(states([a, b2])).toEqual(["turn", "waiting"]);
    });

    it("lets a caller be passed over only until the other has used the renderer as much as it has, plus one render", async () => {
      await use("ahead", 5_000);
      let current = ask("flood");
      const waiting = ask("ahead");
      await flush();

      // The flood always has a request waiting; each of its renders takes one second.
      let passedOver = 0;
      for (let i = 0; i < 20 && waiting.state === "waiting"; i++) {
        const more = ask("flood");
        await flush();
        await vi.advanceTimersByTimeAsync(1_000);
        current.turn!.release();
        await flush();
        if (waiting.state === "waiting") {
          passedOver++;
          current = more;
        }
      }

      expect(waiting.state).toBe("turn");
      // 5 s ahead, renders of 1 s: after the render that was running the flood gets four more turns. By then
      // it has used 5 s, more than what is left of the other's 5 s, and the wait is over.
      expect(passedOver).toBe(4);
    });

    it("forgets half of a caller's use every half-life", async () => {
      await use("early", 10_000);
      await vi.advanceTimersByTimeAsync(HALF_LIFE_MS - 10_000);
      await use("late", 6_000);
      // Two half-lives after early's render ended, its 10 s count for 2.5 s; late's 6 s are fresh.
      await vi.advanceTimersByTimeAsync(2 * HALF_LIFE_MS - (HALF_LIFE_MS - 10_000) - 6_000);
      expect(queue.usage("early")).toBeCloseTo(2_500, 3);
      expect(queue.usage("late")).toBeCloseTo(6_000 * 2 ** (-(2 * HALF_LIFE_MS - (HALF_LIFE_MS - 10_000) - 6_000) / HALF_LIFE_MS), 3);

      const running = ask("x");
      const late = ask("late");
      const early = ask("early");
      await flush();
      running.turn!.release();
      await flush();
      expect(states([late, early]), "early used more, longer ago").toEqual(["waiting", "turn"]);
    });

    it("charges the time a turn was held to its caller and to nobody else", async () => {
      await use("user:a", 4_000);
      await use("anonymous", 3_000);

      expect(queue.usage("user:a")).toBeCloseTo(4_000 * 2 ** (-3_000 / HALF_LIFE_MS), 3);
      expect(queue.usage("anonymous")).toBe(3_000);
      expect(queue.usage("user:b")).toBe(0);
    });

    it("puts a signed-in user ahead of the callers without a session once those have used the renderer more", async () => {
      await use("anonymous", 12_000);
      await use("user:u", 1_000);
      const running = ask("anonymous");
      // Six more people without a session, then the user.
      const visitors = Array.from({ length: 6 }, () => ask("anonymous"));
      const mine = ask("user:u");
      await flush();

      running.turn!.release();
      await flush();

      expect(mine.state).toBe("turn");
      expect(states(visitors)).toEqual(Array(6).fill("waiting"));
    });
  });

  describe("leaving", () => {
    it("refuses a request that has waited the limit, and frees its place", async () => {
      ask("a");
      const waiting = ask("b");
      await vi.advanceTimersByTimeAsync(MAX_WAIT_MS - 1);
      expect(waiting.state).toBe("waiting");
      await vi.advanceTimersByTimeAsync(1);
      expect(waiting.state).toBe("queue-wait");
      expect(queue.waitingCount).toBe(0);
    });

    it("takes no place for a caller that is already gone, and frees the place of one that goes", async () => {
      ask("a");
      const gone = new AbortController();
      gone.abort();
      await expect(queue.enter("b", gone.signal)).rejects.toBeInstanceOf(QueueCancelled);
      expect(queue.waitingCount).toBe(0);

      const waiting = ask("b");
      await flush();
      expect(queue.waitingCount).toBe(1);
      waiting.abort.abort();
      await flush();
      expect(waiting.state).toBe("cancelled");
      expect(queue.waitingCount).toBe(0);
      expect(vi.getTimerCount(), "its wait timer is gone").toBe(0);
    });

    it("leaves no timer behind for a request that got its turn or gave its place", async () => {
      const running = ask("a");
      const waiting = Array.from({ length: MAX_WAITING }, () => ask("a"));
      const taker = ask("b");
      await flush();
      expect(waiting.at(-1)!.state).toBe("place-given");
      expect(vi.getTimerCount(), "one wait timer per waiting request").toBe(MAX_WAITING);

      const everyone = [running, taker, ...waiting.slice(0, -1)];
      for (let n = 0; n < everyone.length; n++) {
        everyone.find((request) => request.state === "turn")!.turn!.release();
        everyone.find((request) => request.state === "turn")!.state = "released";
        await flush();
      }
      expect(states(everyone)).toEqual(Array(everyone.length).fill("released"));
      expect(queue.runningCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("hands a turn back once, however often release is called", async () => {
      const first = ask("a");
      const second = ask("b");
      const third = ask("c");
      await flush();
      first.turn!.release();
      first.turn!.release();
      first.turn!.release();
      await flush();
      expect(states([second, third]), "one turn handed on, not three").toEqual(["turn", "waiting"]);
      expect(queue.runningCount).toBe(1);
    });

    it("frees the renderer when nobody waits", async () => {
      await use("a", 1_000);
      expect(queue.runningCount).toBe(0);
      const next = ask("b");
      await flush();
      expect(next.state).toBe("turn");
    });
  });

  describe("what is remembered", () => {
    it("drops a caller once its use has decayed to nothing", async () => {
      await use("a", 60_000);
      await use("b", 1_000);
      expect(queue.accountCount).toBe(2);

      // 1 s is under a millisecond after ten half-lives, 60 s after sixteen. The check runs when a turn ends.
      await vi.advanceTimersByTimeAsync(10 * HALF_LIFE_MS);
      await use("c", 500);
      expect(queue.accountCount, "b is gone").toBe(2);
      expect(queue.usage("b")).toBe(0);
      expect(queue.usage("a")).toBeGreaterThan(1);

      await vi.advanceTimersByTimeAsync(10 * HALF_LIFE_MS);
      await use("d", 500);
      expect(queue.accountCount, "a and c are gone too").toBe(1);
    });

    it("keeps nothing for a turn that took no time", async () => {
      await use("a", 0);
      expect(queue.accountCount).toBe(0);
    });

    it("never remembers more callers than its limit, and forgets the one charged longest ago", async () => {
      queue = newQueue({ maxAccounts: 3 });
      for (const name of ["a", "b", "c", "a", "d"]) await use(name, 1_000);

      expect(queue.accountCount).toBe(3);
      expect(queue.usage("b"), "b was charged longest ago: a was charged again after it").toBe(0);
      expect(queue.usage("a")).toBeGreaterThan(1_900);
      expect(queue.usage("d")).toBe(1_000);

      for (let n = 0; n < 500; n++) await use(`made-up-${n}`, 10);
      expect(queue.accountCount).toBe(3);
    });

    it("keeps to 1,024 callers when no limit is given, as the renderer gives none", async () => {
      queue = newQueue();
      // 110 s in all: nobody's use has decayed to nothing yet, so only the limit can make the queue forget.
      for (let n = 0; n < 1_100; n++) await use(`user:${n}`, 100);

      expect(queue.accountCount).toBe(1_024);
      expect(queue.usage("user:75"), "the 76 charged longest ago are forgotten").toBe(0);
      expect(queue.usage("user:76")).toBeGreaterThan(1);
    });
  });

  describe("random interleavings", () => {
    function mulberry32(seed: number) {
      let a = seed | 0;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    /** A request as the interleaving follows it: its number in order of arrival, how long it holds a turn, and since when. */
    type Tracked = Request & { n: number; hold: number; since?: number };

    const CALLERS = ["user:a", "user:b", "user:c", "user:d", "anonymous"];
    /**
     * How far the queue's count of a caller's use may be from the sum of its turns: the queue drops use that has
     * decayed below a millisecond, and what it dropped goes on decaying in the sum.
     */
    const DROPPED_MS = 2;
    /** More callers than that never have use on record at once: the five above, each within the reach of the half-life. */
    const MAX_ACCOUNTS_SEEN = CALLERS.length;

    /**
     * The test's own account of who used the renderer how much: a list of the turns that ended, folded with
     * the half-life when read. Not the queue's bookkeeping, so that an error there shows.
     */
    class Ledger {
      private readonly entries: Array<{ caller: string; ms: number; at: number }> = [];
      charge(caller: string, ms: number, at: number) {
        this.entries.push({ caller, ms, at });
      }
      used(caller: string, now: number) {
        let used = 0;
        for (const entry of this.entries) if (entry.caller === caller) used += entry.ms * 2 ** (-(now - entry.at) / HALF_LIFE_MS);
        return used;
      }
    }

    async function interleaving(seed: number) {
      const random = mulberry32(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(random() * xs.length)];
      const ledger = new Ledger();
      const problems: string[] = [];
      const all: Tracked[] = [];
      const waitingNow = () => all.filter((r) => r.state === "waiting");
      const holders = () => all.filter((r) => r.state === "turn");
      const placesOf = (requests: Tracked[], caller: string) => requests.filter((r) => r.caller === caller).length;
      let passes = 0;
      let mostAccounts = 0;

      /** The bound: `winner` got the turn while `others` kept waiting. */
      const checkTurn = (winner: Tracked, others: Tracked[], now: number) => {
        for (const other of others) {
          if (other.caller === winner.caller) {
            if (other.n < winner.n) problems.push(`request ${winner.n} went before the older request ${other.n} of the same caller`);
            continue;
          }
          if (other.n < winner.n) passes++;
          const [mine, theirs] = [ledger.used(winner.caller, now), ledger.used(other.caller, now)];
          // A waiting caller is passed over only by one that has used the renderer no more than it has ...
          if (mine > theirs + DROPPED_MS) problems.push(`request ${winner.n} (${winner.caller}, used ${mine.toFixed(1)}) went before request ${other.n} (${other.caller}, used ${theirs.toFixed(1)})`);
          // ... and between equals only by the caller whose oldest request is older.
          const oldest = (caller: string) => Math.min(...[winner, ...others].filter((r) => r.caller === caller).map((r) => r.n));
          if (Math.abs(mine - theirs) <= 1e-6 && oldest(other.caller) < oldest(winner.caller)) problems.push(`equal use: request ${winner.n} went before the caller of the older request ${other.n}`);
        }
      };

      const enter = async (n: number, now: number) => {
        const caller = pick(CALLERS);
        const before = waitingNow();
        const held = holders();
        const request: Tracked = Object.assign(ask(caller), { n, hold: pick([0, 200, 200, 4_000, 12_000, 12_000, 59_000]) });
        all.push(request);
        await flush();
        const gave = before.filter((r) => r.state === "place-given");
        if (held.some((r) => r.state !== "turn")) problems.push(`request ${n}: a turn that was held was taken away`);
        if (held.length === 0 && request.state !== "turn") problems.push(`request ${n} found the renderer free and got ${request.state}`);
        if (held.length === 0) {
          request.since = now;
          return;
        }
        if (before.length < MAX_WAITING) {
          if (gave.length > 0 || request.state !== "waiting") problems.push(`request ${n}: the queue had room, ${gave.length} gave a place and it is ${request.state}`);
          return;
        }
        // The queue was full. Whether a place had to move, worked out here from the counts alone.
        const mine = placesOf(before, caller);
        const most = Math.max(...CALLERS.map((c) => placesOf(before, c)));
        const mustMove = most >= mine + 2;
        if (gave.length !== (mustMove ? 1 : 0)) problems.push(`request ${n} (${caller}): places ${JSON.stringify(Object.fromEntries(CALLERS.map((c) => [c, placesOf(before, c)])))}, ${gave.length} given`);
        if (request.state !== (mustMove ? "waiting" : "queue-full")) problems.push(`request ${n}: the queue was full, ${gave.length} place(s) moved and it is ${request.state}`);
        for (const giver of gave) {
          const held = placesOf(before, giver.caller);
          if (held !== most) problems.push(`request ${n}: the place came from ${giver.caller}, which held ${held}, not the most (${most})`);
          if (held < 2) problems.push(`request ${n}: ${giver.caller} gave up its only place`);
          if (giver.n !== Math.max(...before.filter((r) => r.caller === giver.caller).map((r) => r.n))) problems.push(`request ${n}: request ${giver.n} gave its place, which is not its caller's newest`);
        }
      };

      const requests = 6 + Math.floor(random() * 40);
      const plan: Array<{ at: number; n: number; abortAfter?: number }> = [];
      let at = 0;
      for (let n = 0; n < requests; n++) {
        at += pick([0, 0, 0, 1, 50, 300, 1_000, 3_000, 3_000, 13_000, 31_000]);
        plan.push({ at, n, abortAfter: random() < 0.2 ? pick([0, 1, 500, 5_000, 29_999, 30_000, 30_001]) : undefined });
      }

      // The clock moves from one thing that can happen to the next: arrivals, callers that go away, the end of the render that runs.
      let next = 0;
      const aborts: Array<{ at: number; request: Tracked }> = [];
      for (let now = 0; ; ) {
        while (next < plan.length && plan[next].at <= now) {
          const { n, abortAfter } = plan[next++];
          await enter(n, now);
          if (abortAfter !== undefined) aborts.push({ at: now + abortAfter, request: all.at(-1)! });
        }
        for (const abort of aborts.filter((a) => a.at <= now && !a.request.abort.signal.aborted)) {
          // A caller that leaves while it waits is out of the queue; one that holds the renderer hands it back below, as the renderer does.
          abort.request.abort.abort();
          await flush();
        }
        if (holders().length > 1) problems.push(`${holders().length} turns held at once`);
        const holder = holders()[0];
        if (holder && (now - holder.since! >= holder.hold || holder.abort.signal.aborted)) {
          const waitingBefore = waitingNow();
          ledger.charge(holder.caller, now - holder.since!, now);
          holder.state = "released";
          holder.turn!.release();
          await flush();
          const winners = waitingBefore.filter((r) => r.state === "turn");
          if (winners.length !== Math.min(1, waitingBefore.length)) problems.push(`${waitingBefore.length} waited and ${winners.length} got the turn that was handed back`);
          if (winners.length === 1) {
            winners[0].since = now;
            checkTurn(winners[0], waitingBefore.filter((r) => r !== winners[0]), now);
          }
          mostAccounts = Math.max(mostAccounts, queue.accountCount);
          for (const caller of CALLERS) if (Math.abs(queue.usage(caller) - ledger.used(caller, now)) > DROPPED_MS) problems.push(`${caller}: the queue says ${queue.usage(caller)} used, the turns that ended add up to ${ledger.used(caller, now)}`);
          continue;
        }
        if (waitingNow().length > MAX_WAITING) problems.push(`${waitingNow().length} requests wait`);
        if (queue.waitingCount !== waitingNow().length) problems.push(`the queue counts ${queue.waitingCount} waiting, the test ${waitingNow().length}`);
        if (queue.runningCount !== holders().length) problems.push(`the queue counts ${queue.runningCount} running, the test ${holders().length}`);
        const dues = [plan[next]?.at, ...aborts.filter((a) => !a.request.abort.signal.aborted).map((a) => a.at), holder ? holder.since! + holder.hold : undefined, waitingNow().length ? now + 1_000 : undefined].filter((t): t is number => t !== undefined && t > now);
        if (dues.length === 0) break;
        const to = Math.min(...dues);
        await vi.advanceTimersByTimeAsync(to - now);
        now = to;
      }

      const unanswered = all.filter((r) => r.state === "waiting" || r.state === "turn").length;
      if (unanswered) problems.push(`${unanswered} request(s) without an end`);
      if (queue.runningCount !== 0) problems.push(`${queue.runningCount} turn(s) still held`);
      if (queue.waitingCount !== 0) problems.push(`${queue.waitingCount} still waiting`);
      if (vi.getTimerCount() !== 0) problems.push(`${vi.getTimerCount()} timer(s) left`);
      if (mostAccounts > MAX_ACCOUNTS_SEEN) problems.push(`${mostAccounts} callers remembered at once`);
      const odd = all.filter((r) => r.state.startsWith("other"));
      if (odd.length) problems.push(`unexpected answers: ${odd.map((r) => r.state).join(", ")}`);
      const tally: Record<string, number> = {};
      for (const r of all) tally[r.state] = (tally[r.state] ?? 0) + 1;
      return { problems, tally, requests: all.length, passes, mostAccounts };
    }

    it("500 interleavings: nobody is passed over by a caller that has used the renderer more, places move only as the rule says, and nothing is left behind", async () => {
      const failures: string[] = [];
      const tally: Record<string, number> = {};
      let requests = 0;
      let passes = 0;
      let mostAccounts = 0;
      for (let seed = 1; seed <= 500; seed++) {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        queue = newQueue();
        const result = await interleaving(seed);
        vi.useRealTimers();
        requests += result.requests;
        passes += result.passes;
        mostAccounts = Math.max(mostAccounts, result.mostAccounts);
        for (const [state, count] of Object.entries(result.tally)) tally[state] = (tally[state] ?? 0) + count;
        if (result.problems.length) failures.push(`seed ${seed}: ${result.problems.slice(0, 3).join("; ")}`);
      }
      // FAIR_QUEUE_REPORT=<file> writes what the run covered, for a pull request's description.
      if (process.env.FAIR_QUEUE_REPORT) appendFileSync(process.env.FAIR_QUEUE_REPORT, `[fair-queue] 500 interleavings, ${requests} requests, ${JSON.stringify(tally)}, ${passes} times a request went before an older one of another caller, at most ${mostAccounts} callers remembered at once, ${failures.length} failing seeds\n`);
      // Each kind of answer was reached, so the checks above had something to check.
      expect(Object.keys(tally).sort()).toEqual(["cancelled", "place-given", "queue-full", "queue-wait", "released"]);
      expect(passes, "requests did go before older ones").toBeGreaterThan(100);
      expect(requests).toBeGreaterThan(5_000);
      expect(mostAccounts).toBeGreaterThan(1);
      expect(failures.slice(0, 10)).toEqual([]);
    }, 120_000);
  });
});
